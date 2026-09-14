import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { validateHead, HeadDecompressor, decompressAndValidateHead, parseHeadForDisplay } from './headScan.ts'
import { DESCRIPTION_MIN_CHARS, DESCRIPTION_MAX_CHARS, HEAD_MAX_DECOMPRESSED_BYTES } from './constants.ts'

async function gzipBytes(input: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('gzip')
  const writer = cs.writable.getWriter()
  const outputPromise = new Response(cs.readable).arrayBuffer()
  await writer.write(input)
  await writer.close()
  return new Uint8Array(await outputPromise)
}

/** Builds head text with `system` included, in §3's key order. Tests that
 *  care about `system` being ABSENT build their own text directly instead
 *  of using this helper — see `headTextNoSystem` below. */
function headText(overrides: Record<string, unknown> = {}, extra = ''): string {
  const doc = {
    format: 1,
    report: { description: 'the model disappeared after undo, ten times reproducible' },
    system: { appVersion: '1.1.0', platform: 'desktop-macos' },
    ...overrides,
  }
  // Mirrors §3's key order exactly, the way `JSON.stringify` on an object
  // literal built in this order would — this helper never uses
  // `JSON.stringify(doc)` directly so tests can still splice in `extra`
  // (trailing bytes, as a real bundle's `recording`/`hew`/`log` would be)
  // after the head this function validates.
  return (
    `{"format":${JSON.stringify(doc.format)},"report":${JSON.stringify(doc.report)},"system":${JSON.stringify(doc.system)}` +
    (extra ? `,${extra}}` : '}')
  )
}

/** Head text with NO `system` key at all — the dialog lets a user untick
 *  "App version and system" entirely (docs/design/report-bug.md §2), so
 *  this is a legitimate, common shape, not an edge case. */
function headTextNoSystem(report: Record<string, unknown> = { description: 'x'.repeat(30) }, extra = ''): string {
  return `{"format":1,"report":${JSON.stringify(report)}` + (extra ? `,${extra}}` : '}')
}

describe('validateHead: accepts', () => {
  test('a well-formed head with system', () => {
    const result = validateHead(headText())
    assert.ok(result.ok)
    if (result.ok) {
      assert.equal(result.fields.appVersion, '1.1.0')
      assert.equal(result.fields.platform, 'desktop-macos')
      assert.match(result.fields.description, /model disappeared/)
    }
  })

  test('a well-formed head with system entirely absent', () => {
    const result = validateHead(headTextNoSystem())
    assert.ok(result.ok)
    if (result.ok) {
      assert.equal(result.fields.appVersion, '')
      assert.equal(result.fields.platform, '')
    }
  })

  test('a head with no system, but another key immediately after report', () => {
    // `system` is optional, but if present it must be the key right after
    // `report` — some OTHER key there just means system was never included.
    const result = validateHead(headTextNoSystem(undefined, '"crash":{"message":"boom"}'))
    assert.ok(result.ok)
    if (result.ok) {
      assert.equal(result.fields.appVersion, '')
      assert.equal(result.fields.platform, '')
    }
  })

  test('a head with trailing fields after system (recording, importsStripped, hew, log, …)', () => {
    const result = validateHead(
      headText({}, '"recording":"{\\"version\\":2}","importsStripped":true,"log":"line1\\nline2"'),
    )
    assert.ok(result.ok)
  })

  test('description at exactly the minimum and maximum length', () => {
    const atMin = validateHead(headText({ report: { description: 'x'.repeat(DESCRIPTION_MIN_CHARS) } }))
    assert.ok(atMin.ok)
    const atMax = validateHead(headText({ report: { description: 'x'.repeat(DESCRIPTION_MAX_CHARS) } }))
    assert.ok(atMax.ok)
  })

  test('a description containing brace/quote/comma characters (string-aware scanning)', () => {
    const tricky = 'it broke when I typed {"nested": "json", "looking": true}, then crashed'
    const result = validateHead(headText({ report: { description: tricky } }))
    assert.ok(result.ok)
    if (result.ok) assert.equal(result.fields.description, tricky)
  })

  test('a description containing escaped quotes and backslashes', () => {
    const tricky = 'the path was "C:\\\\Users\\\\me" and it said "no"'
    const result = validateHead(headText({ report: { description: tricky } }))
    assert.ok(result.ok)
    if (result.ok) assert.equal(result.fields.description, tricky)
  })

  test('appVersion/platform are empty strings when absent from a PRESENT system object', () => {
    const result = validateHead(headText({ system: {} }))
    assert.ok(result.ok)
    if (result.ok) {
      assert.equal(result.fields.appVersion, '')
      assert.equal(result.fields.platform, '')
    }
  })
})

describe('validateHead: rejects', () => {
  test('wrong key order (system before report)', () => {
    const text = `{"format":1,"system":{"appVersion":"1.1.0"},"report":{"description":"${'x'.repeat(20)}"}}`
    const result = validateHead(text)
    assert.equal(result.ok, false)
  })

  test('missing format key entirely', () => {
    const result = validateHead(`{"report":{"description":"${'x'.repeat(20)}"},"system":{}}`)
    assert.equal(result.ok, false)
  })

  test('format is not 1', () => {
    const result = validateHead(headText({ format: 2 }))
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.message, /format/)
  })

  test('description shorter than the minimum', () => {
    const result = validateHead(headText({ report: { description: 'short' } }))
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.message, /description/)
  })

  test('description longer than the maximum', () => {
    const result = validateHead(headText({ report: { description: 'x'.repeat(DESCRIPTION_MAX_CHARS + 1) } }))
    assert.equal(result.ok, false)
  })

  test('description missing entirely from report', () => {
    const result = validateHead(headText({ report: { expected: 'nothing' } }))
    assert.equal(result.ok, false)
  })

  test('report is not an object', () => {
    const result = validateHead('{"format":1,"report":"nope","system":{}}')
    assert.equal(result.ok, false)
  })

  test('system present but not an object', () => {
    const result = validateHead(
      headText().replace('"system":{"appVersion":"1.1.0","platform":"desktop-macos"}', '"system":"nope"'),
    )
    assert.equal(result.ok, false)
  })

  test('empty string', () => {
    assert.equal(validateHead('').ok, false)
  })

  test('plain non-JSON garbage', () => {
    assert.equal(validateHead('not even close to json').ok, false)
  })

  test('a head truncated mid-report-object (simulating the 256 KiB cutoff)', () => {
    const full = headText({ report: { description: 'x'.repeat(1000) } })
    const truncated = full.slice(0, 40) // cuts off inside the description string
    const result = validateHead(truncated)
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.message, /incomplete|too large/)
  })

  test('report object never closes (unbalanced braces)', () => {
    const result = validateHead('{"format":1,"report":{"description":"' + 'x'.repeat(20))
    assert.equal(result.ok, false)
  })

  test('a present system object that never closes (unbalanced braces)', () => {
    const partial = headText().split(',"system":{')[0]
    const result = validateHead(`${partial},"system":{"appVersion":"1.1.0`)
    assert.equal(result.ok, false)
  })

  test('does not throw on adversarial input containing only braces and quotes', () => {
    assert.doesNotThrow(() => validateHead('{"format":{{{{"""""'))
  })
})

describe('validateHead: a head cut off right at the report/system boundary', () => {
  test('is accepted, with appVersion/platform empty — indistinguishable from system genuinely being absent', () => {
    // `system` is optional now, so a head window that happens to end right
    // after `report`'s closing brace (whether because the client omitted
    // system, or because 256 KiB truncation landed exactly there) can't be
    // told apart from "no system" — and isn't a validation failure either
    // way, just a report the admin page shows less system info for.
    const full = headText()
    const boundary = full.indexOf('"system"')
    const truncated = full.slice(0, boundary - 1) // drops the comma before "system"
    const result = validateHead(truncated)
    assert.ok(result.ok)
    if (result.ok) {
      assert.equal(result.fields.appVersion, '')
      assert.equal(result.fields.platform, '')
    }
  })
})

describe('parseHeadForDisplay', () => {
  test('parses description/expected/contact and the system block', () => {
    const text = JSON.stringify({
      format: 1,
      report: { description: 'it broke', expected: 'it should not', contact: 'me@example.com' },
      system: { appVersion: '1.1.0', platform: 'desktop-macos', os: 'macOS 15', gpu: 'Apple M2', userAgent: 'ua' },
    })
    const view = parseHeadForDisplay(text)
    assert.ok(view !== null)
    assert.equal(view.description, 'it broke')
    assert.equal(view.expected, 'it should not')
    assert.equal(view.contact, 'me@example.com')
    assert.equal(view.appVersion, '1.1.0')
    assert.equal(view.platform, 'desktop-macos')
    assert.equal(view.os, 'macOS 15')
    assert.equal(view.gpu, 'Apple M2')
    assert.equal(view.userAgent, 'ua')
  })

  test('parses a crash block that immediately follows system', () => {
    const text = `{"format":1,"report":{"description":"${'x'.repeat(20)}"},"system":{"appVersion":"1.1.0"},"crash":{"at":"push_pull","message":"index out of bounds"}}`
    const view = parseHeadForDisplay(text)
    assert.ok(view !== null)
    assert.deepEqual(view.crash, { at: 'push_pull', message: 'index out of bounds' })
  })

  test('parses a crash block that immediately follows report when system is absent', () => {
    const text = `{"format":1,"report":{"description":"${'x'.repeat(20)}"},"crash":{"at":"boom"}}`
    const view = parseHeadForDisplay(text)
    assert.ok(view !== null)
    assert.equal(view.appVersion, undefined)
    assert.deepEqual(view.crash, { at: 'boom', message: undefined })
  })

  test('tolerates a head missing every optional field', () => {
    const view = parseHeadForDisplay(JSON.stringify({ format: 1, report: {} }))
    assert.ok(view !== null)
    assert.equal(view.description, undefined)
    assert.equal(view.appVersion, undefined)
    assert.equal(view.crash, undefined)
  })

  test('returns null when the format/report key order is not even present', () => {
    assert.equal(parseHeadForDisplay('not json at all'), null)
    assert.equal(parseHeadForDisplay('{"report":{}}'), null)
    assert.equal(parseHeadForDisplay(''), null)
  })

  test('never throws on adversarial input containing only braces and quotes', () => {
    assert.doesNotThrow(() => parseHeadForDisplay('{"format":{{{{"""""'))
    assert.doesNotThrow(() => parseHeadForDisplay('{"format":1,"report":'))
  })

  test('tolerates a report object that never closes (truncated head) by returning null rather than throwing', () => {
    assert.equal(parseHeadForDisplay('{"format":1,"report":{"description":"' + 'x'.repeat(20)), null)
  })

  test('tolerates a system value that is not an object', () => {
    const text = `{"format":1,"report":{"description":"${'x'.repeat(20)}"},"system":"nope"}`
    assert.doesNotThrow(() => parseHeadForDisplay(text))
    const view = parseHeadForDisplay(text)
    assert.ok(view !== null)
    assert.equal(view.appVersion, undefined)
  })
})

// ---------------------------------------------------------------------------
// HeadDecompressor
// ---------------------------------------------------------------------------

function bundleBytes(overrides: Record<string, unknown> = {}): Uint8Array {
  const doc = {
    format: 1,
    report: { description: 'it crashed after undo, reproducible ten times in a row' },
    system: { appVersion: '1.1.0', platform: 'desktop-macos' },
    ...overrides,
  }
  return new TextEncoder().encode(JSON.stringify(doc))
}

describe('HeadDecompressor', () => {
  test('decompresses a small gzip piece fed in one write() call — the normal case: one whole first piece', async () => {
    const plain = bundleBytes()
    const compressed = await gzipBytes(plain)
    const head = new HeadDecompressor()
    await head.write(compressed)
    const result = await head.finish(true)
    assert.equal(result.errored, false)
    assert.equal(result.text, new TextDecoder().decode(plain))
  })

  test('decompresses a gzip piece fed in many small write() calls too', async () => {
    const plain = bundleBytes({ report: { description: 'x'.repeat(500) } })
    const compressed = await gzipBytes(plain)
    const head = new HeadDecompressor()
    for (let i = 0; i < compressed.byteLength; i += 7) {
      await head.write(compressed.subarray(i, Math.min(i + 7, compressed.byteLength)))
    }
    const result = await head.finish(true)
    assert.equal(result.errored, false)
    assert.equal(result.text, new TextDecoder().decode(plain))
  })

  test('flags non-gzip input as errored, without throwing', async () => {
    const head = new HeadDecompressor()
    await head.write(new TextEncoder().encode('this is definitely not gzip'))
    const result = await head.finish(true)
    assert.equal(result.errored, true)
  })

  test('stops after maxBytes of decompressed output and marks done', async () => {
    // `write()` resolving only means the bytes were ACCEPTED into the
    // transform's queue, not that the concurrent internal pump has already
    // drained and counted the corresponding output — so `done` isn't
    // asserted until after `finish()`, which genuinely waits for it to
    // settle (see `write()`'s own doc comment for the race this avoids).
    const plain = new TextEncoder().encode('y'.repeat(10_000))
    const compressed = await gzipBytes(plain)
    const head = new HeadDecompressor(1000) // small cap for a fast test
    await head.write(compressed)
    const result = await head.finish(true)
    assert.equal(result.errored, false)
    assert.equal(result.text.length, 1000)
    assert.equal(head.done, true)
  })

  test('further write() calls after done/errored are no-ops', async () => {
    const head = new HeadDecompressor(10)
    await head.write(await gzipBytes(new TextEncoder().encode('z'.repeat(1000))))
    await head.finish(true)
    assert.equal(head.done, true)
    await head.write(new TextEncoder().encode('more bytes that must be ignored'))
    const result = await head.finish(true)
    assert.equal(result.text.length, 10)
  })

  test('default cap matches HEAD_MAX_DECOMPRESSED_BYTES', async () => {
    const plain = new TextEncoder().encode('a'.repeat(HEAD_MAX_DECOMPRESSED_BYTES + 5000))
    const compressed = await gzipBytes(plain)
    const head = new HeadDecompressor()
    await head.write(compressed)
    const result = await head.finish(true)
    assert.equal(result.text.length, HEAD_MAX_DECOMPRESSED_BYTES)
  })

  test('a large (~1.9 MB) first piece that decompresses to well past the cap still resolves correctly', async () => {
    // Regression coverage for the write/cancel race `write()`'s doc
    // describes: reaching the cap mid-piece used to be misreported as a
    // gzip error when the whole piece was fed in one call.
    const plain = new TextEncoder().encode('q'.repeat(2_000_000))
    const compressed = await gzipBytes(plain)
    const head = new HeadDecompressor()
    await head.write(compressed)
    const result = await head.finish(true)
    assert.equal(result.errored, false)
    assert.equal(result.text.length, HEAD_MAX_DECOMPRESSED_BYTES)
  })

  describe('finish(isFinalPiece: false) — a deliberately truncated, non-final piece', () => {
    // Regression coverage for a real bug found via a live `wrangler dev`
    // smoke test against actual `workerd`, NOT by this unit suite: calling
    // `writer.close()` on a genuinely truncated gzip stream (piece 0 of a
    // multi-piece upload, which is NOT the true end of the compressed
    // data) throws `"Called close() on a decompression stream with
    // incomplete data"` in real `workerd` — Node's `DecompressionStream`
    // doesn't reproduce this, which is exactly why it slipped past
    // `node --test` originally. `isFinalPiece: false` must never call
    // `close()` at all; these tests exercise that path directly.

    test('reaches the cap by draining alone, without ever calling close() — no error even though the input is a truncated gzip stream', async () => {
      const plain = new TextEncoder().encode('r'.repeat(2_000_000))
      const compressed = await gzipBytes(plain)
      // A genuine prefix — NOT a complete gzip stream (no trailer, and the
      // deflate stream itself is cut off mid-block) — exactly what piece 0
      // of a multi-piece upload actually is.
      const truncated = compressed.slice(0, Math.floor(compressed.byteLength / 2))
      const head = new HeadDecompressor(1000) // small cap for a fast test
      await head.write(truncated)
      const result = await head.finish(false)
      assert.equal(result.errored, false)
      assert.equal(result.text.length, 1000)
      assert.equal(result.text, 'r'.repeat(1000))
    })

    test('a truncated piece that runs out of decodable data before the cap resolves gracefully (bounded drain, not a hang or an error)', async () => {
      const plain = new TextEncoder().encode('short report text that never gets anywhere near the cap')
      const compressed = await gzipBytes(plain)
      // Drop the trailing bytes (the gzip CRC32/ISIZE footer, and possibly
      // part of the final deflate block) — genuinely incomplete input that
      // will never produce more than `plain`'s worth of output, however
      // long anything waits.
      const truncated = compressed.slice(0, compressed.byteLength - 8)
      const head = new HeadDecompressor() // default cap, far bigger than this input could ever produce
      await head.write(truncated)
      const result = await head.finish(false)
      assert.equal(result.errored, false)
      // Whatever was decodable before the input ran out — could be the
      // full plaintext (if only the trailer was dropped) or a prefix of it
      // (if the cut lands inside the final deflate block); either way this
      // must resolve, not hang, and must not be reported as invalid gzip.
      assert.ok(plain.length >= result.text.length)
      assert.ok(new TextDecoder().decode(plain).startsWith(result.text))
    })

    test('further finish() calls after the timeout-driven done are still safe and idempotent', async () => {
      const compressed = await gzipBytes(new TextEncoder().encode('abc'))
      const head = new HeadDecompressor()
      await head.write(compressed.slice(0, compressed.byteLength - 4))
      const first = await head.finish(false)
      assert.equal(first.errored, false)
      const second = await head.finish(false)
      assert.deepEqual(second, first)
    })
  })
})

describe('decompressAndValidateHead', () => {
  test('decompresses and validates a real gzip piece in one call', async () => {
    const compressed = await gzipBytes(bundleBytes())
    const result = await decompressAndValidateHead(compressed, true)
    assert.ok(result.ok)
    if (result.ok) assert.equal(result.fields.appVersion, '1.1.0')
  })

  test('reports invalid gzip as a validation failure, not a thrown error', async () => {
    const result = await decompressAndValidateHead(new TextEncoder().encode('not gzip'), true)
    assert.equal(result.ok, false)
  })

  test('reports a valid-gzip-but-invalid-head piece as a validation failure', async () => {
    const compressed = await gzipBytes(new TextEncoder().encode('{"nope": true}'))
    const result = await decompressAndValidateHead(compressed, true)
    assert.equal(result.ok, false)
  })

  test('isFinalPiece: false — validates the head from a genuinely truncated first piece of a multi-piece upload', async () => {
    // This is the exact real-world shape a `handleStart` call passes for a
    // multi-piece upload: piece 0 is only part of the whole compressed
    // report, so `piece.byteLength !== declaredTotal` and `isFinalPiece`
    // must be `false` — see `handlers.ts`'s call site. Regression coverage
    // for the `close()`-on-incomplete-data bug (see the `HeadDecompressor`
    // suite above): this must succeed even though the piece handed in is
    // not, on its own, a complete gzip stream.
    const fillerBytes = new Uint8Array(3_000_000)
    crypto.getRandomValues(fillerBytes.subarray(0, 65536))
    for (let o = 65536; o < fillerBytes.byteLength; o += 65536) {
      crypto.getRandomValues(fillerBytes.subarray(o, Math.min(o + 65536, fillerBytes.byteLength)))
    }
    const filler = Buffer.from(fillerBytes).toString('base64')
    const compressed = await gzipBytes(bundleBytes({ filler }))
    const piece = compressed.slice(0, 1_900_000) // a PIECE_BYTES-sized prefix, genuinely truncated
    assert.ok(piece.byteLength < compressed.byteLength, 'the fixture must actually need a second piece')
    const result = await decompressAndValidateHead(piece, false)
    assert.ok(result.ok, () => `expected ok, got ${JSON.stringify(result)}`)
    if (result.ok) {
      assert.equal(result.fields.appVersion, '1.1.0')
      assert.equal(result.fields.platform, 'desktop-macos')
    }
  })

  test('isFinalPiece: false — a truncated piece too short to contain a full head fails validation cleanly, not by throwing or hanging', async () => {
    const compressed = await gzipBytes(bundleBytes({ report: { description: 'x'.repeat(5000) } }))
    const piece = compressed.slice(0, 20) // nowhere near enough to decode a usable head
    const result = await decompressAndValidateHead(piece, false)
    assert.equal(result.ok, false)
  })
})
