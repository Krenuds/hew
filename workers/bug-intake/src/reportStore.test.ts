import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { ReportStore, type StartFields } from './reportStore.ts'
import { RETENTION_MS, ABANDON_TIMEOUT_MS, PIECE_BYTES } from './constants.ts'
import { concatChunks } from './bytes.ts'
import { hashToken } from './uploadToken.ts'
import { FakeDurableObjectStorage } from './testSupport/fakeDurableObject.ts'

function makeStore(): ReportStore {
  return new ReportStore(new FakeDurableObjectStorage())
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = i % 256
  return out
}

const FIELDS: StartFields = { description: 'it crashed after undo', appVersion: '1.1.0', platform: 'desktop-macos' }

/** Splits `bytes` into `PIECE_BYTES` pieces and drives the real
 *  start/putPiece protocol against `store`, exactly as `handlers.ts` does
 *  one request at a time — so these tests exercise the real write path. */
async function uploadAll(
  store: ReportStore,
  reportId: string,
  tokenHash: string,
  bytes: Uint8Array,
  fields: StartFields = FIELDS,
): Promise<void> {
  const pieces: Uint8Array[] = []
  for (let offset = 0; offset < bytes.byteLength; offset += PIECE_BYTES) {
    pieces.push(bytes.slice(offset, Math.min(offset + PIECE_BYTES, bytes.byteLength)))
  }
  if (pieces.length === 0) pieces.push(new Uint8Array(0))
  await store.startUpload(reportId, bytes.byteLength, tokenHash, pieces[0], fields)
  for (let i = 1; i < pieces.length; i++) {
    const result = await store.putPiece(i, tokenHash, pieces[i])
    assert.deepEqual(result, { ok: true, stored: true })
  }
}

async function readAll(store: ReportStore): Promise<Uint8Array | null> {
  const head = await store.head()
  if (head === null) return null
  const batches: Uint8Array[] = []
  const BATCH = 8
  for (let from = 0; from < head.pieceCount; from += BATCH) {
    batches.push(...(await store.read(from, BATCH)))
  }
  return concatChunks(batches, head.totalBytes)
}

describe('ReportStore: upload round trip', () => {
  test('a small single-piece upload round-trips exactly', async () => {
    const store = makeStore()
    const tokenHash = await hashToken('t')
    const bytes = new TextEncoder().encode(JSON.stringify({ format: 1, report: { description: 'x'.repeat(20) } }))
    await uploadAll(store, 'HEW-AAAA-BBBB', tokenHash, bytes)
    const out = await readAll(store)
    assert.deepEqual(out, bytes)
    const head = await store.head()
    assert.equal(head?.reportId, 'HEW-AAAA-BBBB')
  })

  test('a multi-piece upload at the 90 MiB boundary round-trips exactly (one piece per row, no rechunking)', async () => {
    const store = makeStore()
    const tokenHash = await hashToken('t')
    const bytes = randomBytes(90 * 1024 * 1024)
    await uploadAll(store, 'HEW-CCCC-DDDD', tokenHash, bytes)
    const head = await store.head()
    assert.ok(head !== null)
    assert.equal(head.totalBytes, bytes.byteLength)
    assert.equal(head.pieceCount, Math.ceil(bytes.byteLength / PIECE_BYTES))
    const out = await readAll(store)
    assert.deepEqual(out, bytes)
  })

  test('read is non-destructive: the same report can be read any number of times', async () => {
    const store = makeStore()
    const tokenHash = await hashToken('t')
    const bytes = randomBytes(5_000_000)
    await uploadAll(store, 'HEW-EEEE-FFFF', tokenHash, bytes)
    const first = await readAll(store)
    const second = await readAll(store)
    const third = await readAll(store)
    assert.deepEqual(first, bytes)
    assert.deepEqual(second, bytes)
    assert.deepEqual(third, bytes)
  })

  test('head() is null before any upload and after destroy()', async () => {
    const store = makeStore()
    assert.equal(await store.head(), null)
    await uploadAll(store, 'HEW-GGGG-HHHH', await hashToken('t'), randomBytes(100))
    assert.ok((await store.head()) !== null)
    await store.destroy()
    assert.equal(await store.head(), null)
  })

  test('head() reports partial progress mid-upload (not "incomplete" the way declared chunk counts used to gate it)', async () => {
    const store = makeStore()
    const tokenHash = await hashToken('t')
    await store.startUpload('HEW-IIII-JJJJ', PIECE_BYTES * 3, tokenHash, randomBytes(PIECE_BYTES), FIELDS)
    const head = await store.head()
    assert.ok(head !== null)
    assert.equal(head.pieceCount, 1)
    assert.equal(head.totalBytes, PIECE_BYTES)
  })

  test('startUpload throws on a second call against the same instance', async () => {
    const store = makeStore()
    const tokenHash = await hashToken('t')
    await store.startUpload('HEW-KKKK-LLLL', 10, tokenHash, randomBytes(10), FIELDS)
    await assert.rejects(() => store.startUpload('HEW-KKKK-LLLL', 10, tokenHash, randomBytes(10), FIELDS))
  })
})

describe('ReportStore: putPiece', () => {
  test('stores the next expected index, advances, and reports stored:true', async () => {
    const store = makeStore()
    const tokenHash = await hashToken('t')
    await store.startUpload('HEW-AAAA-0001', 20, tokenHash, randomBytes(10), FIELDS)
    const result = await store.putPiece(1, tokenHash, randomBytes(10))
    assert.deepEqual(result, { ok: true, stored: true })
  })

  test('an identical retry of the last stored index is accepted without storing twice', async () => {
    const store = makeStore()
    const tokenHash = await hashToken('t')
    const piece1 = randomBytes(10)
    await store.startUpload('HEW-AAAA-0002', 20, tokenHash, piece1, FIELDS)
    const first = await store.putPiece(1, tokenHash, randomBytes(10))
    assert.deepEqual(first, { ok: true, stored: true })
    const retry = await store.putPiece(1, tokenHash, randomBytes(10)) // same length, different bytes — still a valid retry
    assert.deepEqual(retry, { ok: true, stored: false })
    const head = await store.head()
    assert.equal(head?.pieceCount, 2) // not 3 — the retry did not add a new row
  })

  test('a retry with a different length is rejected as out-of-order', async () => {
    const store = makeStore()
    const tokenHash = await hashToken('t')
    await store.startUpload('HEW-AAAA-0003', 25, tokenHash, randomBytes(10), FIELDS)
    await store.putPiece(1, tokenHash, randomBytes(10))
    const result = await store.putPiece(1, tokenHash, randomBytes(11)) // wrong length for a retry
    assert.deepEqual(result, { ok: false, reason: 'out-of-order', expected: 2 })
  })

  test('skipping ahead is rejected as out-of-order with the expected index', async () => {
    const store = makeStore()
    const tokenHash = await hashToken('t')
    await store.startUpload('HEW-AAAA-0004', 30, tokenHash, randomBytes(10), FIELDS)
    const result = await store.putPiece(3, tokenHash, randomBytes(10))
    assert.deepEqual(result, { ok: false, reason: 'out-of-order', expected: 1 })
  })

  test('an index far behind (not the immediate prior one) is rejected as out-of-order', async () => {
    const store = makeStore()
    const tokenHash = await hashToken('t')
    await store.startUpload('HEW-AAAA-0005', 40, tokenHash, randomBytes(10), FIELDS)
    await store.putPiece(1, tokenHash, randomBytes(10))
    await store.putPiece(2, tokenHash, randomBytes(10))
    const result = await store.putPiece(1, tokenHash, randomBytes(10)) // two behind nextIndex (3)
    assert.deepEqual(result, { ok: false, reason: 'out-of-order', expected: 3 })
  })

  test('wrong token hash is forbidden', async () => {
    const store = makeStore()
    const tokenHash = await hashToken('right')
    await store.startUpload('HEW-AAAA-0006', 20, tokenHash, randomBytes(10), FIELDS)
    const result = await store.putPiece(1, await hashToken('wrong'), randomBytes(10))
    assert.deepEqual(result, { ok: false, reason: 'forbidden' })
  })

  test('a piece over PIECE_BYTES is rejected as too-large', async () => {
    const store = makeStore()
    const tokenHash = await hashToken('t')
    await store.startUpload('HEW-AAAA-0007', PIECE_BYTES * 3, tokenHash, randomBytes(10), FIELDS)
    const result = await store.putPiece(1, tokenHash, randomBytes(PIECE_BYTES + 1))
    assert.deepEqual(result, { ok: false, reason: 'too-large' })
  })

  test('bytes past the declared total are rejected', async () => {
    const store = makeStore()
    const tokenHash = await hashToken('t')
    await store.startUpload('HEW-AAAA-0008', 15, tokenHash, randomBytes(10), FIELDS)
    const result = await store.putPiece(1, tokenHash, randomBytes(10)) // 10 + 10 = 20 > 15
    assert.deepEqual(result, { ok: false, reason: 'bytes-past-total' })
  })

  test('not-found for an upload that was never started', async () => {
    const store = makeStore()
    const result = await store.putPiece(1, await hashToken('t'), randomBytes(10))
    assert.deepEqual(result, { ok: false, reason: 'not-found' })
  })

  test('not-found once the upload is committed', async () => {
    const store = makeStore()
    const tokenHash = await hashToken('t')
    await store.startUpload('HEW-AAAA-0009', 10, tokenHash, randomBytes(10), FIELDS)
    const committed = await store.commit(tokenHash)
    assert.ok(committed.ok)
    const result = await store.putPiece(1, tokenHash, randomBytes(10))
    assert.deepEqual(result, { ok: false, reason: 'not-found' })
  })

  test('re-arms the alarm on every newly stored piece', async () => {
    const storage = new FakeDurableObjectStorage()
    const store = new ReportStore(storage)
    const tokenHash = await hashToken('t')
    await store.startUpload('HEW-AAAA-0010', 20, tokenHash, randomBytes(10), FIELDS)
    const firstAlarm = await storage.getAlarm()
    const before = Date.now()
    await store.putPiece(1, tokenHash, randomBytes(10))
    const secondAlarm = await storage.getAlarm()
    assert.ok(secondAlarm !== null && firstAlarm !== null)
    assert.ok(secondAlarm >= before + ABANDON_TIMEOUT_MS)
  })
})

describe('ReportStore: commit', () => {
  test('succeeds once every declared byte has arrived, returning the head-validated fields', async () => {
    const store = makeStore()
    const tokenHash = await hashToken('t')
    await store.startUpload('HEW-BBBB-0001', 20, tokenHash, randomBytes(10), FIELDS)
    await store.putPiece(1, tokenHash, randomBytes(10))
    const result = await store.commit(tokenHash)
    assert.deepEqual(result, { ok: true, ...FIELDS, sizeBytes: 20 })
  })

  test('incomplete when fewer bytes arrived than declared', async () => {
    const store = makeStore()
    const tokenHash = await hashToken('t')
    await store.startUpload('HEW-BBBB-0002', 30, tokenHash, randomBytes(10), FIELDS)
    const result = await store.commit(tokenHash)
    assert.deepEqual(result, { ok: false, reason: 'incomplete' })
  })

  test('forbidden with the wrong token', async () => {
    const store = makeStore()
    const tokenHash = await hashToken('right')
    await store.startUpload('HEW-BBBB-0003', 10, tokenHash, randomBytes(10), FIELDS)
    const result = await store.commit(await hashToken('wrong'))
    assert.deepEqual(result, { ok: false, reason: 'forbidden' })
  })

  test('not-found for an upload that was never started', async () => {
    const store = makeStore()
    const result = await store.commit(await hashToken('t'))
    assert.deepEqual(result, { ok: false, reason: 'not-found' })
  })

  test('a second commit with the right token is idempotent, returning the same fields again', async () => {
    const store = makeStore()
    const tokenHash = await hashToken('t')
    await store.startUpload('HEW-BBBB-0004', 10, tokenHash, randomBytes(10), FIELDS)
    const first = await store.commit(tokenHash)
    assert.ok(first.ok)
    const second = await store.commit(tokenHash)
    assert.deepEqual(second, first)
  })

  test('a second commit with the wrong token is forbidden, not idempotent', async () => {
    const store = makeStore()
    const tokenHash = await hashToken('right')
    await store.startUpload('HEW-BBBB-0006', 10, tokenHash, randomBytes(10), FIELDS)
    const first = await store.commit(tokenHash)
    assert.ok(first.ok)
    const second = await store.commit(await hashToken('wrong'))
    assert.deepEqual(second, { ok: false, reason: 'forbidden' })
  })

  test('an idempotent second commit does not re-arm the alarm again', async () => {
    const storage = new FakeDurableObjectStorage()
    const store = new ReportStore(storage)
    const tokenHash = await hashToken('t')
    await store.startUpload('HEW-BBBB-0007', 10, tokenHash, randomBytes(10), FIELDS)
    await store.commit(tokenHash)
    const alarmAfterFirst = await storage.getAlarm()
    await store.commit(tokenHash)
    const alarmAfterSecond = await storage.getAlarm()
    assert.equal(alarmAfterSecond, alarmAfterFirst)
  })

  test('re-arms the alarm for RETENTION_MS from the original receivedAt, not from commit time', async () => {
    const storage = new FakeDurableObjectStorage()
    const store = new ReportStore(storage)
    const tokenHash = await hashToken('t')
    const before = Date.now()
    await store.startUpload('HEW-BBBB-0005', 10, tokenHash, randomBytes(10), FIELDS)
    const result = await store.commit(tokenHash)
    assert.ok(result.ok)
    const alarm = await storage.getAlarm()
    assert.ok(alarm !== null)
    assert.ok(alarm >= before + RETENTION_MS)
    assert.ok(alarm <= Date.now() + RETENTION_MS)
  })
})

describe('ReportStore: alarm arming at start', () => {
  test('startUpload arms an alarm at receivedAt + ABANDON_TIMEOUT_MS', async () => {
    const storage = new FakeDurableObjectStorage()
    const store = new ReportStore(storage)
    const before = Date.now()
    await store.startUpload('HEW-MMMM-NNNN', 10, await hashToken('t'), randomBytes(10), FIELDS)
    const alarm = await storage.getAlarm()
    assert.ok(alarm !== null)
    assert.ok(alarm >= before + ABANDON_TIMEOUT_MS)
    assert.ok(alarm <= Date.now() + ABANDON_TIMEOUT_MS)
  })

  test('destroy() (what the alarm handler calls) wipes the report and cancels the alarm', async () => {
    const storage = new FakeDurableObjectStorage()
    const store = new ReportStore(storage)
    await store.startUpload('HEW-OOOO-PPPP', 10, await hashToken('t'), randomBytes(10), FIELDS)
    assert.ok((await storage.getAlarm()) !== null)
    await store.destroy()
    assert.equal(await storage.getAlarm(), null)
    assert.equal(await store.head(), null)
  })
})

describe('ReportStore: abandon', () => {
  test('destroys the upload when the token matches', async () => {
    const store = makeStore()
    const tokenHash = await hashToken('t')
    await store.startUpload('HEW-ABND-0001', 20, tokenHash, randomBytes(10), FIELDS)
    const result = await store.abandon(tokenHash)
    assert.deepEqual(result, { ok: true })
    assert.equal(await store.head(), null)
  })

  test('forbidden with the wrong token, and the upload survives untouched', async () => {
    const store = makeStore()
    const tokenHash = await hashToken('right')
    await store.startUpload('HEW-ABND-0002', 20, tokenHash, randomBytes(10), FIELDS)
    const result = await store.abandon(await hashToken('wrong'))
    assert.deepEqual(result, { ok: false, reason: 'forbidden' })
    assert.ok((await store.head()) !== null)
  })

  test('not-found for an upload that was never started', async () => {
    const store = makeStore()
    const result = await store.abandon(await hashToken('t'))
    assert.deepEqual(result, { ok: false, reason: 'not-found' })
  })

  test('not-found once the upload is committed, even with the right token — a committed report must survive', async () => {
    const store = makeStore()
    const tokenHash = await hashToken('t')
    await store.startUpload('HEW-ABND-0003', 10, tokenHash, randomBytes(10), FIELDS)
    const committed = await store.commit(tokenHash)
    assert.ok(committed.ok)
    const result = await store.abandon(tokenHash)
    assert.deepEqual(result, { ok: false, reason: 'not-found' })
    assert.ok((await store.head()) !== null, 'a committed report must never be destroyed by abandon')
  })
})

describe('ReportStore: readStream', () => {
  test('streams every stored piece, in order, byte-for-byte identical to the uploaded bytes', async () => {
    const store = makeStore()
    const tokenHash = await hashToken('t')
    const bytes = randomBytes(5_000_000) // several pieces at PIECE_BYTES
    await uploadAll(store, 'HEW-STRM-0001', tokenHash, bytes)
    const stream = await store.readStream()
    const collected = new Uint8Array(await new Response(stream).arrayBuffer())
    assert.deepEqual(collected, bytes)
  })

  test('a small single-piece report streams correctly too', async () => {
    const store = makeStore()
    const tokenHash = await hashToken('t')
    const bytes = new TextEncoder().encode(JSON.stringify({ format: 1, report: { description: 'x'.repeat(20) } }))
    await uploadAll(store, 'HEW-STRM-0002', tokenHash, bytes)
    const stream = await store.readStream()
    const collected = new Uint8Array(await new Response(stream).arrayBuffer())
    assert.deepEqual(collected, bytes)
  })

  test('a never-started report streams zero bytes', async () => {
    const store = makeStore()
    const stream = await store.readStream()
    const collected = new Uint8Array(await new Response(stream).arrayBuffer())
    assert.equal(collected.byteLength, 0)
  })

  test('is non-destructive: the report can still be read afterward', async () => {
    const store = makeStore()
    const tokenHash = await hashToken('t')
    const bytes = randomBytes(100)
    await uploadAll(store, 'HEW-STRM-0003', tokenHash, bytes)
    await new Response(await store.readStream()).arrayBuffer()
    const head = await store.head()
    assert.ok(head !== null)
    assert.equal(head.pieceCount, 1)
  })
})
