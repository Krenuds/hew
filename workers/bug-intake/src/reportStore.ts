/**
 * ReportStore — the SQLite read/write logic for one report's chunked
 * upload, factored out of the `ReportDrop` Durable Object (`reportDrop.ts`)
 * so it unit-tests under bare `node --test` without importing
 * `cloudflare:workers` — the same split share-relay's `dropStore.ts` makes.
 *
 * Storage shape: a single `meta` row (pinned `id = 0`, the whole upload's
 * state machine) plus `piece(idx, data, length)` rows — ONE row per piece,
 * written exactly once each as it arrives (docs/design/report-bug.md §4
 * "Chunked upload"): no rechunking, no batching, unlike share-relay's
 * `DropStore` or this Worker's own earlier single-request-streaming design.
 * A piece is at most `PIECE_BYTES` (1.9 MB), comfortably under the 2 MB
 * SQLite row/BLOB cap, so it's simply written as one bound parameter.
 *
 * The state machine `startUpload`/`putPiece`/`commit` implement matches
 * §8's wire contract almost one-to-one:
 *
 *   - `startUpload` (from `POST /report/`) writes `meta` with `nextIndex =
 *     1`, stores piece 0, and arms the abandonment alarm.
 *   - `putPiece` (from `PUT /report/<id>/<index>`) accepts the next
 *     expected index (stores it, advances, re-arms the alarm), silently
 *     accepts an identical retry of the last stored index (no double
 *     write), and refuses anything else as out-of-order.
 *   - `commit` (from `POST /report/<id>/commit`) checks every declared byte
 *     arrived, flips `committed`, and re-arms the alarm for RETENTION
 *     instead of abandonment.
 *
 * Every method checks the presented token's hash against the stored one in
 * constant time (`uploadToken.ts`) — this class never sees a raw token,
 * only its SHA-256 hex digest, computed by the caller (`handlers.ts`).
 */

import type { DurableObjectStorage } from './types.ts'
import { RETENTION_MS, ABANDON_TIMEOUT_MS, PIECE_BYTES } from './constants.ts'
import { constantTimeEqual } from './uploadToken.ts'

interface MetaRow {
  reportId: string
  receivedAt: number
  declaredTotal: number
  tokenHash: string
  nextIndex: number
  receivedBytes: number
  lastActivity: number
  committed: number
  description: string
  appVersion: string
  platform: string
}

interface PieceRow {
  idx: number
  data: ArrayBuffer
}

/** What `startUpload` needs beyond the raw bytes/lengths — the streamed
 *  head's validated fields (`headScan.ts`), carried here so `commit` can
 *  hand them back for the notification email without re-reading anything. */
export interface StartFields {
  description: string
  appVersion: string
  platform: string
}

export type PutPieceResult =
  | { ok: true; stored: boolean } // stored=false means an accepted idempotent retry
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'forbidden' }
  | { ok: false; reason: 'too-large' }
  | { ok: false; reason: 'bytes-past-total' }
  | { ok: false; reason: 'out-of-order'; expected: number }

export type CommitResult =
  | { ok: true; description: string; appVersion: string; platform: string; sizeBytes: number }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'forbidden' }
  | { ok: false; reason: 'incomplete' }

/** Result of `abandon` — see its doc comment for why a report id alone must
 *  never be enough to trigger this. */
export type AbandonResult = { ok: true } | { ok: false; reason: 'not-found' } | { ok: false; reason: 'forbidden' }

export interface ReportHead {
  reportId: string
  totalBytes: number
  pieceCount: number
  receivedAt: number
}

export class ReportStore {
  private readonly storage: DurableObjectStorage

  constructor(storage: DurableObjectStorage) {
    this.storage = storage
    this.migrate()
  }

  /** `CREATE TABLE IF NOT EXISTS` — idempotent, re-run at the top of every
   *  public method. Required because `destroy()`'s `deleteAll()` wipes the
   *  SQLite schema, not just rows (see share-relay's `dropStore.ts` for the
   *  full argument), so a DO instance reused after a delete has no tables
   *  until this runs again. */
  private migrate(): void {
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS meta (
         id INTEGER PRIMARY KEY CHECK (id = 0),
         reportId TEXT NOT NULL,
         receivedAt INTEGER NOT NULL,
         declaredTotal INTEGER NOT NULL,
         tokenHash TEXT NOT NULL,
         nextIndex INTEGER NOT NULL,
         receivedBytes INTEGER NOT NULL,
         lastActivity INTEGER NOT NULL,
         committed INTEGER NOT NULL DEFAULT 0,
         description TEXT NOT NULL,
         appVersion TEXT NOT NULL,
         platform TEXT NOT NULL
       )`,
    )
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS piece (
         idx INTEGER PRIMARY KEY,
         data BLOB NOT NULL,
         length INTEGER NOT NULL
       )`,
    )
  }

  private readMeta(): MetaRow | null {
    const rows = this.storage.sql
      .exec<MetaRow>(
        `SELECT reportId, receivedAt, declaredTotal, tokenHash, nextIndex, receivedBytes, lastActivity, committed,
                description, appVersion, platform
         FROM meta`,
      )
      .toArray()
    return rows.length === 0 ? null : rows[0]
  }

  private insertPiece(idx: number, data: Uint8Array): void {
    const buffer = data.slice().buffer
    this.storage.sql.exec('INSERT INTO piece (idx, data, length) VALUES (?, ?, ?)', idx, buffer, data.byteLength)
  }

  /** Begins an upload: writes `meta` (declaring the total up front, the
   *  hashed token, and the head-validated fields `commit` will need later),
   *  stores piece 0, and arms the abandonment alarm. Throws if this DO is
   *  already populated — each report gets a freshly generated id, so this
   *  only fires on a genuine caller bug, never a normal-path race. */
  async startUpload(
    reportId: string,
    declaredTotal: number,
    tokenHash: string,
    firstPiece: Uint8Array,
    fields: StartFields,
  ): Promise<void> {
    this.migrate()
    if (this.readMeta() !== null) {
      throw new Error('ReportStore already populated')
    }
    const receivedAt = Date.now()
    this.storage.sql.exec(
      `INSERT INTO meta (id, reportId, receivedAt, declaredTotal, tokenHash, nextIndex, receivedBytes, lastActivity,
                          committed, description, appVersion, platform)
       VALUES (0, ?, ?, ?, ?, 1, ?, ?, 0, ?, ?, ?)`,
      reportId,
      receivedAt,
      declaredTotal,
      tokenHash,
      firstPiece.byteLength,
      receivedAt,
      fields.description,
      fields.appVersion,
      fields.platform,
    )
    this.insertPiece(0, firstPiece)
    await this.storage.setAlarm(receivedAt + ABANDON_TIMEOUT_MS)
  }

  /** Accepts the next piece of an in-progress upload. See `PutPieceResult`
   *  for every outcome; `not-found` covers "never started", "already
   *  committed", and "abandoned" (an abandoned upload's `meta` row is gone
   *  entirely) alike — the caller can't (and doesn't need to) tell those
   *  apart. */
  async putPiece(index: number, tokenHash: string, data: Uint8Array): Promise<PutPieceResult> {
    this.migrate()
    const meta = this.readMeta()
    if (meta === null || meta.committed !== 0) {
      return { ok: false, reason: 'not-found' }
    }
    if (!constantTimeEqual(tokenHash, meta.tokenHash)) {
      return { ok: false, reason: 'forbidden' }
    }
    if (data.byteLength > PIECE_BYTES) {
      return { ok: false, reason: 'too-large' }
    }

    if (index === meta.nextIndex) {
      if (meta.receivedBytes + data.byteLength > meta.declaredTotal) {
        return { ok: false, reason: 'bytes-past-total' }
      }
      this.insertPiece(index, data)
      const now = Date.now()
      this.storage.sql.exec(
        'UPDATE meta SET nextIndex = ?, receivedBytes = ?, lastActivity = ? WHERE id = 0',
        meta.nextIndex + 1,
        meta.receivedBytes + data.byteLength,
        now,
      )
      await this.storage.setAlarm(now + ABANDON_TIMEOUT_MS)
      return { ok: true, stored: true }
    }

    if (index === meta.nextIndex - 1) {
      // A retry of the last stored index — accepted without storing twice
      // ONLY if the length matches exactly (`length`, not the BLOB itself:
      // cheap to check, and a mismatched length already proves it isn't a
      // faithful retry).
      const row = this.storage.sql.exec<{ length: number }>('SELECT length FROM piece WHERE idx = ?', index).toArray()[0]
      if (row !== undefined && row.length === data.byteLength) {
        return { ok: true, stored: false }
      }
    }

    return { ok: false, reason: 'out-of-order', expected: meta.nextIndex }
  }

  /** Finishes an upload once every declared byte has arrived. Re-arms the
   *  alarm for RETENTION (from the upload's original `receivedAt`) rather
   *  than cancelling it outright — a committed report still needs its
   *  eventual retention wipe, just on a much longer clock.
   *
   *  Idempotent for the token holder: a `commit` against a drop that is
   *  ALREADY committed returns the same `ok: true` fields again (without
   *  re-arming the alarm a second time) as long as `tokenHash` still
   *  matches, rather than `not-found` — a client that lost its `201`
   *  response (a dropped connection, a timeout) and retries the same
   *  COMMIT must land on a definite answer, not the same ambiguous
   *  "not-found" an unrelated stranger's guess at the id would get. The
   *  token check runs BEFORE the idempotency check specifically so a wrong
   *  token on an already-committed report still gets `forbidden`, never a
   *  free read of its fields. */
  async commit(tokenHash: string): Promise<CommitResult> {
    this.migrate()
    const meta = this.readMeta()
    if (meta === null) {
      return { ok: false, reason: 'not-found' }
    }
    if (!constantTimeEqual(tokenHash, meta.tokenHash)) {
      return { ok: false, reason: 'forbidden' }
    }
    if (meta.committed !== 0) {
      return {
        ok: true,
        description: meta.description,
        appVersion: meta.appVersion,
        platform: meta.platform,
        sizeBytes: meta.declaredTotal,
      }
    }
    if (meta.receivedBytes !== meta.declaredTotal) {
      return { ok: false, reason: 'incomplete' }
    }
    this.storage.sql.exec('UPDATE meta SET committed = 1 WHERE id = 0')
    await this.storage.setAlarm(meta.receivedAt + RETENTION_MS)
    return {
      ok: true,
      description: meta.description,
      appVersion: meta.appVersion,
      platform: meta.platform,
      sizeBytes: meta.declaredTotal,
    }
  }

  /** Abandons an in-progress (uncommitted) upload, authorized ONLY by
   *  `tokenHash` matching the upload's own stored token — a report id is
   *  PUBLIC (a user pastes it into a GitHub issue), so the id alone must
   *  never be enough to destroy someone's report. `not-found` covers both
   *  "never started" and "already committed" (same collapse `putPiece`/
   *  `commit` make); `forbidden` is a token mismatch; otherwise this
   *  destroys the upload's storage and reports `ok: true` so the caller
   *  knows to release its `ReportIndex` reservation too. */
  async abandon(tokenHash: string): Promise<AbandonResult> {
    this.migrate()
    const meta = this.readMeta()
    if (meta === null || meta.committed !== 0) {
      return { ok: false, reason: 'not-found' }
    }
    if (!constantTimeEqual(tokenHash, meta.tokenHash)) {
      return { ok: false, reason: 'forbidden' }
    }
    await this.destroy()
    return { ok: true }
  }

  /** The report's shape for admin readback — however many pieces have
   *  actually arrived so far (`nextIndex`), regardless of `committed`;
   *  callers that care whether an upload is finished check that
   *  separately. `null` if nothing was ever started (or it's been
   *  destroyed). */
  async head(): Promise<ReportHead | null> {
    this.migrate()
    const meta = this.readMeta()
    if (meta === null) return null
    return {
      reportId: meta.reportId,
      totalBytes: meta.receivedBytes,
      pieceCount: meta.nextIndex,
      receivedAt: meta.receivedAt,
    }
  }

  /** Reads piece rows `[from, from + count)` in index order, WITHOUT
   *  deleting them — a report is read as many times as the admin page
   *  wants. Returns an empty array past the end or against a never-stored
   *  report. */
  async read(from: number, count: number): Promise<Uint8Array[]> {
    this.migrate()
    const rows = this.storage.sql
      .exec<PieceRow>('SELECT idx, data FROM piece WHERE idx >= ? AND idx < ? ORDER BY idx ASC', from, from + count)
      .toArray()
    return rows.map((row) => new Uint8Array(row.data))
  }

  /** A byte `ReadableStream` over every stored piece, in index order,
   *  reading ONE piece row at a time — never all of them at once. Used by
   *  the admin download route (`handlers.ts`) so serving a report never
   *  costs the Worker isolate the ~2x-the-report memory (up to ~180 MiB)
   *  that reading every piece into an array and concatenating them would.
   *  Non-destructive, same as `read()`; the returned stream is a `type:
   *  "bytes"` `ReadableStream`, the shape Workers RPC forwards across the
   *  Durable Object boundary without buffering it whole (see
   *  https://developers.cloudflare.com/workers/runtime-apis/rpc/). */
  async readStream(): Promise<ReadableStream<Uint8Array>> {
    this.migrate()
    const storage = this.storage
    let nextIndex = 0
    return new ReadableStream<Uint8Array>({
      type: 'bytes',
      pull(controller) {
        const rows = storage.sql.exec<PieceRow>('SELECT idx, data FROM piece WHERE idx = ?', nextIndex).toArray()
        if (rows.length === 0) {
          controller.close()
          return
        }
        controller.enqueue(new Uint8Array(rows[0].data))
        nextIndex++
      },
    })
  }

  /** Wipes all storage and cancels the alarm — idempotent. Used by admin
   *  delete, by abandonment (immediate, on a 400, or via the alarm), and by
   *  retention expiry. */
  async destroy(): Promise<void> {
    await this.storage.deleteAll()
    await this.storage.deleteAlarm()
  }
}
