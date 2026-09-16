/**
 * Validates a bundle's decompressed HEAD — at most
 * `HEAD_MAX_DECOMPRESSED_BYTES` (256 KiB) of the front of the document,
 * never the whole thing (docs/design/report-bug.md §4 "Chunked upload") —
 * without ever `JSON.parse`-ing the full multi-hundred-megabyte bundle.
 * Only the upload's FIRST piece (at most `PIECE_BYTES`, 1.9 MB compressed)
 * is ever decompressed, at `POST /report/` (the start of the upload) — the
 * bundle's keys are written in a fixed order (§3): `format`, `report`,
 * optionally `system`, then whatever else, and a `description` at its
 * 10,000-character maximum still lands comfortably inside the first piece,
 * so nothing later in a multi-piece upload is ever touched here. `system`
 * is the one key in that prefix that may simply be absent — the dialog
 * lets a user untick "App version and system" entirely, so a submitter who
 * doesn't want to identify their OS/GPU/user agent still gets to send a
 * report. This module checks the mandatory `format`/`report` order holds
 * character by character, finds each value's exact text with a
 * string/bracket-aware scanner (so a `}` or `,` inside a quoted string — a
 * description that happens to contain JSON-looking text — never confuses
 * it), and only THEN hands each small, already-bounded substring to
 * `JSON.parse`. This is deliberately not a general JSON parser: it only
 * ever needs to find where `report`'s (and, if present, `system`'s) object
 * values end, nothing about their contents.
 *
 * `HeadDecompressor` (below `validateHead`) is what produces the
 * decompressed text in the first place, bounded the same way.
 */

import {
  BUNDLE_FORMAT,
  DESCRIPTION_MIN_CHARS,
  DESCRIPTION_MAX_CHARS,
  HEAD_MAX_DECOMPRESSED_BYTES,
  SYSTEM_FIELD_MAX_CHARS,
} from './constants.ts'

export interface HeadFields {
  description: string
  appVersion: string
  platform: string
}

export type HeadValidation = { ok: true; fields: HeadFields } | { ok: false; message: string }

/** Scans a balanced JSON object or array value starting at `text[start]`
 *  (which must be `{` or `[`), respecting quoted strings and their escape
 *  sequences, and returns the index of the matching closing bracket — or
 *  `null` if the value never closes within `text` (truncated: either a
 *  genuinely malformed document, or one whose head is larger than the
 *  caller read). */
function findBalancedEnd(text: string, start: number): number | null {
  const open = text[start]
  const close = open === '{' ? '}' : open === '[' ? ']' : null
  if (close === null) return null

  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') {
        i++ // skip the escaped character entirely — `\"` never ends the string
        continue
      }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return i
    }
  }
  return null
}

/** Requires `text` to contain `literal` starting exactly at `at`. */
function expectLiteralAt(text: string, at: number, literal: string): boolean {
  return text.startsWith(literal, at)
}

/** Validates the decompressed head text against §3's key order and §8's
 *  content rules, returning the fields the index row and email need.
 *  `text` may be truncated (the caller stopped decompressing at
 *  `HEAD_MAX_DECOMPRESSED_BYTES`, or the upload itself was too short) —
 *  every failure mode here, including running off the end of `text` mid-
 *  scan, is reported as `{ok: false}`, never a thrown exception. */
export function validateHead(text: string): HeadValidation {
  const FORMAT_PREFIX = '{"format":'
  if (!expectLiteralAt(text, 0, FORMAT_PREFIX)) {
    return { ok: false, message: 'body does not start with the expected format/report key order' }
  }

  const formatValueStart = FORMAT_PREFIX.length
  const formatValueEnd = text.indexOf(',', formatValueStart)
  if (formatValueEnd === -1) {
    return { ok: false, message: 'head is incomplete or too large' }
  }
  const formatText = text.slice(formatValueStart, formatValueEnd).trim()
  const format = Number(formatText)
  if (!Number.isFinite(format) || format !== BUNDLE_FORMAT) {
    return { ok: false, message: `format must be ${BUNDLE_FORMAT}` }
  }

  const REPORT_KEY = '"report":'
  if (!expectLiteralAt(text, formatValueEnd + 1, REPORT_KEY)) {
    return { ok: false, message: 'body does not start with the expected format/report key order' }
  }
  const reportValueStart = formatValueEnd + 1 + REPORT_KEY.length
  if (text[reportValueStart] !== '{') {
    return { ok: false, message: '"report" must be an object' }
  }
  const reportValueEnd = findBalancedEnd(text, reportValueStart)
  if (reportValueEnd === null) {
    return { ok: false, message: 'head is incomplete or too large' }
  }

  let report: unknown
  try {
    report = JSON.parse(text.slice(reportValueStart, reportValueEnd + 1))
  } catch {
    return { ok: false, message: 'body is not valid JSON' }
  }
  if (typeof report !== 'object' || report === null || Array.isArray(report)) {
    return { ok: false, message: '"report" must be an object' }
  }

  const reportObj = report as Record<string, unknown>
  const description = typeof reportObj.description === 'string' ? reportObj.description : ''
  if (description.length < DESCRIPTION_MIN_CHARS || description.length > DESCRIPTION_MAX_CHARS) {
    return {
      ok: false,
      message: `description must be ${DESCRIPTION_MIN_CHARS} to ${DESCRIPTION_MAX_CHARS} characters`,
    }
  }

  // `system` is optional — the dialog lets a user untick "App version and
  // system" entirely (docs/design/report-bug.md §2). If the very next key
  // after `report` isn't literally `"system":`, there's no system block to
  // read (whether the client omitted it, or the head window happened to
  // end right here) — `appVersion`/`platform` are just empty strings; the
  // admin page and the notification email are what turn that into
  // "unknown" for display, not this scan.
  let appVersion = ''
  let platform = ''
  const SYSTEM_KEY = ',"system":'
  if (expectLiteralAt(text, reportValueEnd + 1, SYSTEM_KEY)) {
    const systemValueStart = reportValueEnd + 1 + SYSTEM_KEY.length
    if (text[systemValueStart] !== '{') {
      return { ok: false, message: '"system" must be an object' }
    }
    const systemValueEnd = findBalancedEnd(text, systemValueStart)
    if (systemValueEnd === null) {
      return { ok: false, message: 'head is incomplete or too large' }
    }
    let system: unknown
    try {
      system = JSON.parse(text.slice(systemValueStart, systemValueEnd + 1))
    } catch {
      return { ok: false, message: 'body is not valid JSON' }
    }
    if (typeof system !== 'object' || system === null || Array.isArray(system)) {
      return { ok: false, message: '"system" must be an object' }
    }
    const systemObj = system as Record<string, unknown>
    appVersion = typeof systemObj.appVersion === 'string' ? systemObj.appVersion : ''
    platform = typeof systemObj.platform === 'string' ? systemObj.platform : ''
    // Both land verbatim in the index row and the email subject, and the
    // storage ceiling never counts them — see `SYSTEM_FIELD_MAX_CHARS`.
    if (appVersion.length > SYSTEM_FIELD_MAX_CHARS || platform.length > SYSTEM_FIELD_MAX_CHARS) {
      return {
        ok: false,
        message: `system.appVersion and system.platform must be at most ${SYSTEM_FIELD_MAX_CHARS} characters`,
      }
    }
  }

  return { ok: true, fields: { description, appVersion, platform } }
}

// ---------------------------------------------------------------------------
// parseHeadForDisplay
// ---------------------------------------------------------------------------

/** What the admin detail page (`adminPages.ts`'s `renderDetail`) shows —
 *  everything `parseHeadForDisplay` can find in a report's HEAD, all
 *  optional since a malformed or truncated head may yield only some of
 *  them (or none). */
export interface HeadDisplayFields {
  description?: string
  expected?: string
  contact?: string
  appVersion?: string
  platform?: string
  os?: string
  gpu?: string
  userAgent?: string
  crash?: { at?: string; message?: string }
}

/** Best-effort, DISPLAY-only parse of a report's decompressed HEAD — used
 *  by the admin detail route (`handlers.ts`'s `handleAdminDetail`), which
 *  reads only piece 0 (`ReportStore.read(0, 1)`) and never reassembles or
 *  fully decompresses a report the way the old `readFullBundle`/`gunzip`
 *  path did. Reuses the same bracket-aware scanner (`findBalancedEnd`) and
 *  §3 key order `validateHead` enforces strictly — `format`, `report`,
 *  optionally `system`, optionally `crash` (the client writes `crash`
 *  immediately after `system`, or after `report` when `system` is absent),
 *  then whatever else — but where `validateHead` REJECTS anything that
 *  doesn't match, this TOLERATES it: a bundle from an older client, one
 *  whose head got truncated at the 256 KiB (or smaller, single-piece)
 *  budget mid-object, or genuinely malformed input all still render
 *  whatever prefix parses, rather than the detail page 500ing or showing
 *  nothing at all. Never throws — the caller can pass truncated or
 *  arbitrary text with no try/catch of its own. */
export function parseHeadForDisplay(text: string): HeadDisplayFields | null {
  try {
    const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
    const parseObject = (raw: string): Record<string, unknown> => {
      try {
        const parsed: unknown = JSON.parse(raw)
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
      } catch {
        return {}
      }
    }

    const FORMAT_PREFIX = '{"format":'
    if (!expectLiteralAt(text, 0, FORMAT_PREFIX)) return null
    const formatValueEnd = text.indexOf(',', FORMAT_PREFIX.length)
    if (formatValueEnd === -1) return null

    const REPORT_KEY = '"report":'
    if (!expectLiteralAt(text, formatValueEnd + 1, REPORT_KEY)) return null
    const reportValueStart = formatValueEnd + 1 + REPORT_KEY.length
    if (text[reportValueStart] !== '{') return null
    const reportValueEnd = findBalancedEnd(text, reportValueStart)
    if (reportValueEnd === null) return null
    const report = parseObject(text.slice(reportValueStart, reportValueEnd + 1))

    let cursor = reportValueEnd + 1
    let system: Record<string, unknown> = {}
    const SYSTEM_KEY = ',"system":'
    if (expectLiteralAt(text, cursor, SYSTEM_KEY)) {
      const systemValueStart = cursor + SYSTEM_KEY.length
      if (text[systemValueStart] === '{') {
        const systemValueEnd = findBalancedEnd(text, systemValueStart)
        if (systemValueEnd !== null) {
          system = parseObject(text.slice(systemValueStart, systemValueEnd + 1))
          cursor = systemValueEnd + 1
        }
      }
    }

    let crash: { at?: string; message?: string } | undefined
    const CRASH_KEY = ',"crash":'
    if (expectLiteralAt(text, cursor, CRASH_KEY)) {
      const crashValueStart = cursor + CRASH_KEY.length
      if (text[crashValueStart] === '{') {
        const crashValueEnd = findBalancedEnd(text, crashValueStart)
        if (crashValueEnd !== null) {
          const c = parseObject(text.slice(crashValueStart, crashValueEnd + 1))
          crash = { at: str(c.at), message: str(c.message) }
        }
      }
    }

    return {
      description: str(report.description),
      expected: str(report.expected),
      contact: str(report.contact),
      appVersion: str(system.appVersion),
      platform: str(system.platform),
      os: str(system.os),
      gpu: str(system.gpu),
      userAgent: str(system.userAgent),
      crash,
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// HeadDecompressor
// ---------------------------------------------------------------------------

/** How long `finish()` waits for the drain to reach `maxBytes` on its own,
 *  for a NON-final piece, before giving up and treating whatever was
 *  decompressed so far as the whole answer — see `finish()`'s doc for why
 *  this exists at all. Any realistically-compressible report reaches
 *  `maxBytes` from a full `PIECE_BYTES` piece in a handful of `read()`
 *  calls, effectively instantly; this is purely a defensive bound against
 *  adversarial, barely-compressible input, not a normal-path wait. */
const NON_FINAL_DRAIN_TIMEOUT_MS = 300

/** Accumulates up to `maxBytes` of DECOMPRESSED output from a gzip piece
 *  fed to it (usually in one `write()` call — the whole first piece, at
 *  most 1.9 MB compressed — since there is no more input coming after it
 *  within a single request), then stops: further `write()` calls become
 *  no-ops. `errored` is set if the fed bytes are not valid gzip. Bounding
 *  the read matters even for a single bounded-size piece: a small,
 *  highly-compressible piece could otherwise decompress to something huge
 *  (a "gzip bomb"), and this is what keeps that bounded regardless of the
 *  compressed input's own (already-capped) size. */
export class HeadDecompressor {
  private readonly maxBytes: number
  private readonly ds = new DecompressionStream('gzip')
  private readonly writer = this.ds.writable.getWriter()
  private readonly reader = this.ds.readable.getReader()
  private readonly chunks: Uint8Array[] = []
  private total = 0
  private pumpDone: Promise<void>
  done = false
  errored = false

  constructor(maxBytes: number = HEAD_MAX_DECOMPRESSED_BYTES) {
    this.maxBytes = maxBytes
    this.pumpDone = this.pump()
  }

  private async pump(): Promise<void> {
    try {
      while (this.total < this.maxBytes) {
        const { value, done } = await this.reader.read()
        if (done) break
        this.chunks.push(value)
        this.total += value.byteLength
      }
      if (this.total >= this.maxBytes) {
        this.done = true
        await this.reader.cancel().catch(() => {})
      }
    } catch {
      this.errored = true
    }
  }

  /** Feeds the next slice of COMPRESSED input, in stream order. A no-op
   *  once `done` or `errored`.
   *
   *  `pump()` runs concurrently, so `done` can flip to `true` (the cap was
   *  reached, `pump()` calls `reader.cancel()`) WHILE a `write()` call here
   *  is still in flight — and cancelling the readable side can itself make
   *  that pending `writer.write()` reject. That rejection means "we
   *  stopped wanting more input", not "this isn't valid gzip", so the catch
   *  below only sets `errored` if `pump()` hadn't already set `done` first;
   *  a genuine decode error is still caught (by `pump()`'s own catch,
   *  reflected in `this.errored`) regardless of what this method observes. */
  async write(compressedChunk: Uint8Array): Promise<void> {
    if (this.done || this.errored) return
    try {
      await this.writer.write(compressedChunk)
    } catch {
      if (!this.done) this.errored = true
    }
  }

  /** Signals no more input is coming (`isFinalPiece: true` — this piece
   *  really is the WHOLE compressed report, the common case for a small,
   *  single-piece upload) or that no more input is coming FROM THIS CALL
   *  even though the real gzip stream is NOT actually finished
   *  (`isFinalPiece: false` — this is piece 0 of a multi-piece upload, a
   *  deliberately truncated prefix of a larger stream; more compressed
   *  bytes exist, just in a future request this function never sees).
   *  Returns the decompressed head (possibly short of `maxBytes`, if the
   *  input was shorter, or empty if `errored`). Idempotent-safe to call
   *  more than once.
   *
   *  This distinction is load-bearing, not cosmetic — found via a real
   *  `wrangler dev` smoke test against actual `workerd`, not by the unit
   *  suite (Node's `DecompressionStream` doesn't reproduce it): calling
   *  `writer.close()` on a genuinely truncated gzip stream is telling the
   *  decompressor "this is the true end", and a real gzip decoder
   *  legitimately rejects that as corrupt/incomplete input (`workerd`
   *  throws `"Called close() on a decompression stream with incomplete
   *  data"`) — even though nothing is actually wrong; the rest of the
   *  stream just hasn't arrived yet, on purpose. So for `isFinalPiece:
   *  false`, `close()` is never called at all: `pump()` keeps draining
   *  whatever this one piece's compressed bytes can still decompress to,
   *  until it either reaches `maxBytes` (the overwhelmingly common case —
   *  any realistically-compressible report's `format`/`report`/`system`
   *  head sits enormously below `maxBytes` of decompressed output long
   *  before a full `PIECE_BYTES` piece's worth of compressed input is
   *  exhausted) or genuinely stalls waiting for input that will never
   *  come from this call, which `NON_FINAL_DRAIN_TIMEOUT_MS` bounds rather
   *  than hanging until the platform's own request timeout would.
   *
   *  For `isFinalPiece: true`, the original race applies: `pump()` can
   *  reach the cap and cancel the reader WHILE this is deciding to (or
   *  already awaiting) `writer.close()` — `!this.done` was true when
   *  checked, but flips true a moment later, and the cancellation can make
   *  `close()` reject. `pump()` itself never actually rejects its own
   *  returned promise (it catches internally and only ever sets
   *  `this.errored`), so the only real ambiguity is `close()`'s rejection,
   *  guarded the same way: it only counts as a genuine error if `pump()`
   *  hadn't already reached `done` first. */
  async finish(isFinalPiece: boolean): Promise<{ text: string; errored: boolean }> {
    if (isFinalPiece) {
      if (!this.done && !this.errored) {
        try {
          await this.writer.close()
        } catch {
          if (!this.done) this.errored = true
        }
      }
      await this.pumpDone
    } else if (!this.done && !this.errored) {
      let timedOut = false
      const timer = new Promise<void>((resolve) => {
        setTimeout(() => {
          timedOut = true
          resolve()
        }, NON_FINAL_DRAIN_TIMEOUT_MS)
      })
      await Promise.race([this.pumpDone, timer])
      if (timedOut && !this.done && !this.errored) {
        this.done = true
        await this.reader.cancel().catch(() => {})
        await this.pumpDone
      }
    }
    if (this.errored) return { text: '', errored: true }
    const total = this.chunks.reduce((n, c) => n + c.byteLength, 0)
    const merged = new Uint8Array(Math.min(total, this.maxBytes))
    let offset = 0
    for (const chunk of this.chunks) {
      if (offset >= merged.byteLength) break
      const take = Math.min(chunk.byteLength, merged.byteLength - offset)
      merged.set(chunk.subarray(0, take), offset)
      offset += take
    }
    return { text: new TextDecoder('utf-8', { fatal: false }).decode(merged), errored: false }
  }
}

/** Convenience for the common case: decompress one piece (already fully in
 *  memory — no more input is coming from THIS call, though more of the
 *  overall upload may still be on its way if `isFinalPiece` is false) and
 *  validate its head in one call. `isFinalPiece` must be `piece.byteLength
 *  === declaredTotal` — whether this piece is the WHOLE compressed report
 *  or just the first of several — see `HeadDecompressor.finish()`'s doc
 *  for why that distinction changes how this needs to signal end-of-input
 *  to the decompressor. */
export async function decompressAndValidateHead(
  piece: Uint8Array,
  isFinalPiece: boolean,
  maxBytes: number = HEAD_MAX_DECOMPRESSED_BYTES,
): Promise<HeadValidation> {
  const head = new HeadDecompressor(maxBytes)
  await head.write(piece)
  const result = await head.finish(isFinalPiece)
  if (result.errored) return { ok: false, message: 'body is not valid gzip' }
  return validateHead(result.text)
}
