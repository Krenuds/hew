/**
 * reportImports — the Imported files row of a bug report and the bundle's
 * compression (docs/design/report-bug.md §3).
 *
 * Every recorded step that takes a user's file embeds the whole file as a
 * JSON byte array (`"bytes":[255,254,…]`, about 3.4 characters per byte):
 * the four model imports (`import_dae` also embeds its texture images), a
 * texture added from disk, a library item inserted, and a `.hew` opened
 * mid-session (`FILE_CALLS`). A 59 MiB SketchUp import turns into a 211 MB
 * recording that holds the user's original file byte for byte. This module
 * lists those payloads and strips them, both by scanning the recording
 * string: the recording is never `JSON.parse`d, because its u64 handles and
 * hash lose precision as JS numbers (recording/sessionRecording.ts).
 *
 * The scan walks the calls array key by key and jumps over every value it
 * doesn't need. A `Vec<u8>` array holds only digits and commas, so its end
 * is the next `]` and its length is its comma count plus one; that keeps one
 * pass over a few hundred megabytes cheap.
 */

export interface ImportedFile {
  /** The recorded method, e.g. `import_skp`. */
  method: string
  /** Human label, e.g. "SketchUp model (.skp)". */
  label: string
  /** Size of the embedded source file (and, for COLLADA, its images) in bytes. */
  fileBytes: number
  /** Characters the embedded payload occupies in the recording string. */
  recordingChars: number
}

/** The recorded calls that embed a user's file (`RecordedCall` in
 *  crates/wasm-api/src/recording.rs, snake_case method tags), the key that
 *  holds its bytes, and the label the dialog lists it under. */
const FILE_CALLS: Record<string, { key: string; label: string }> = {
  import_skp: { key: 'bytes', label: 'SketchUp model (.skp)' },
  import_gltf: { key: 'bytes', label: 'glTF model (.glb/.gltf)' },
  import_stl: { key: 'bytes', label: 'STL model (.stl)' },
  import_dae: { key: 'bytes', label: 'COLLADA model (.dae)' },
  add_texture_material: { key: 'image', label: 'Texture image' },
  insert_item: { key: 'bytes', label: 'Library item' },
  insert_item_palette: { key: 'bytes', label: 'Library material' },
  load: { key: 'bytes', label: 'Opened model (.hew)' },
}

/** One embedded payload: `[start, end)` spans the array value, brackets
 *  included, of a file call's byte key or `import_dae`'s `images`. */
interface PayloadSpan {
  start: number
  end: number
  key: string
  method: string
  byteCount: number
}

function skipWs(s: string, i: number): number {
  while (i < s.length) {
    const c = s.charCodeAt(i)
    if (c !== 32 && c !== 9 && c !== 10 && c !== 13) break
    i++
  }
  return i
}

/** `s[i]` is `"`; returns the index just past the closing quote. */
function skipString(s: string, i: number): number {
  let j = i + 1
  while (j < s.length) {
    const c = s.charCodeAt(j)
    if (c === 92) {
      j += 2
      continue
    }
    if (c === 34) return j + 1
    j++
  }
  throw new Error('unterminated string')
}

/** Returns the index just past the JSON value that starts at `s[i]`. */
function skipValue(s: string, i: number): number {
  const c = s[i]
  if (c === '"') return skipString(s, i)
  if (c === '{' || c === '[') {
    let depth = 0
    let j = i
    while (j < s.length) {
      const ch = s[j]
      if (ch === '"') {
        j = skipString(s, j)
        continue
      }
      if (ch === '{' || ch === '[') depth++
      else if (ch === '}' || ch === ']') {
        depth--
        if (depth === 0) return j + 1
      }
      j++
    }
    throw new Error('unterminated container')
  }
  let j = i
  while (j < s.length && !',}] \t\r\n'.includes(s[j])) j++
  if (j === i) throw new Error('expected a value')
  return j
}

/** `s[i]` is `{`. Calls `visit` with each key and the index its value starts
 *  at; `visit` returns the index just past that value. Returns the index just
 *  past the closing `}`. */
function walkObject(s: string, i: number, visit: (key: string, valueStart: number) => number): number {
  let j = skipWs(s, i + 1)
  if (s[j] === '}') return j + 1
  for (;;) {
    if (s[j] !== '"') throw new Error('expected a key')
    const keyEnd = skipString(s, j)
    const key = s.slice(j + 1, keyEnd - 1)
    j = skipWs(s, keyEnd)
    if (s[j] !== ':') throw new Error('expected a colon')
    j = visit(key, skipWs(s, j + 1))
    j = skipWs(s, j)
    if (s[j] === ',') {
      j = skipWs(s, j + 1)
      continue
    }
    if (s[j] !== '}') throw new Error('expected , or }')
    return j + 1
  }
}

/** Walks the array at `s[i]` (`[`), calling `visit` on each element's start;
 *  `visit` returns the index just past that element. */
function walkArray(s: string, i: number, visit: (elementStart: number) => number): number {
  let j = skipWs(s, i + 1)
  if (s[j] === ']') return j + 1
  for (;;) {
    j = skipWs(s, visit(j))
    if (s[j] === ',') {
      j = skipWs(s, j + 1)
      continue
    }
    if (s[j] !== ']') throw new Error('expected , or ]')
    return j + 1
  }
}

/** `s[i]` is `[` opening a `Vec<u8>`: only digits and commas until `]`. */
function scanByteArray(s: string, i: number): { end: number; count: number } {
  const close = s.indexOf(']', i)
  if (close === -1) throw new Error('unterminated byte array')
  let commas = 0
  let digits = false
  for (let j = i + 1; j < close; j++) {
    const c = s.charCodeAt(j)
    if (c === 44) commas++
    else if (c >= 48 && c <= 57) digits = true
    else if (c !== 32 && c !== 10 && c !== 13 && c !== 9) throw new Error('not a byte array')
  }
  return { end: close + 1, count: digits ? commas + 1 : 0 }
}

/** `import_dae`'s `images`: an array of `RecordedImage` objects, each with
 *  its own byte array. Returns the total image bytes. */
function scanImages(s: string, i: number): { end: number; count: number } {
  let count = 0
  const end = walkArray(s, i, (el) => {
    if (s[el] !== '{') return skipValue(s, el)
    return walkObject(s, el, (key, v) => {
      if (key === 'bytes' && s[v] === '[') {
        const r = scanByteArray(s, v)
        count += r.count
        return r.end
      }
      return skipValue(s, v)
    })
  })
  return { end, count }
}

/** One pass over the recording: every embedded file payload in order, and
 *  every step's method name (the tag serde writes first in each call object;
 *  "unknown" for an element without one). Only the last `keepNames` names are
 *  kept. Throws when the recording can't be scanned, so a caller never
 *  mistakes "couldn't read it" for "has no files". */
function scanRecording(recordingJson: string, keepNames: number): { spans: PayloadSpan[]; stepCount: number; lastStepNames: string[] } {
  const s = recordingJson
  const spans: PayloadSpan[] = []
  const lastStepNames: string[] = []
  let stepCount = 0
  const pushName = (name: string) => {
    stepCount++
    lastStepNames.push(name)
    if (lastStepNames.length > keepNames) lastStepNames.shift()
  }
  const top = skipWs(s, 0)
  if (s[top] !== '{') throw new Error('recording is not an object')
  walkObject(s, top, (key, v) => {
    if (key !== 'calls' || s[v] !== '[') return skipValue(s, v)
    return walkArray(s, v, (el) => {
      if (s[el] !== '{') {
        pushName('unknown')
        return skipValue(s, el)
      }
      let method = ''
      const end = walkObject(s, el, (callKey, cv) => {
        if (callKey === 'method' && s[cv] === '"') {
          const valueEnd = skipString(s, cv)
          method = s.slice(cv + 1, valueEnd - 1)
          return valueEnd
        }
        if (callKey === FILE_CALLS[method]?.key && s[cv] === '[') {
          const r = scanByteArray(s, cv)
          spans.push({ start: cv, end: r.end, key: callKey, method, byteCount: r.count })
          return r.end
        }
        if (method === 'import_dae' && callKey === 'images' && s[cv] === '[') {
          const r = scanImages(s, cv)
          spans.push({ start: cv, end: r.end, key: 'images', method, byteCount: r.count })
          return r.end
        }
        return skipValue(s, cv)
      })
      pushName(method === '' ? 'unknown' : method)
      return end
    })
  })
  return { spans, stepCount, lastStepNames }
}

function filesFromSpans(spans: PayloadSpan[]): ImportedFile[] {
  const files: ImportedFile[] = []
  for (const span of spans) {
    const chars = span.end - span.start
    const last = files[files.length - 1]
    // `images` always follows its own call's `bytes`, so it belongs to the
    // entry that span just opened.
    if (span.key === 'images' && last !== undefined && last.method === 'import_dae') {
      last.fileBytes += span.byteCount
      last.recordingChars += chars
      continue
    }
    files.push({
      method: span.method,
      label: FILE_CALLS[span.method]?.label ?? span.method,
      fileBytes: span.byteCount,
      recordingChars: chars,
    })
  }
  return files
}

function stripSpans(recordingJson: string, spans: PayloadSpan[]): string {
  if (spans.length === 0) return recordingJson
  const parts: string[] = []
  let pos = 0
  for (const span of spans) {
    parts.push(recordingJson.slice(pos, span.start), '[]')
    pos = span.end
  }
  parts.push(recordingJson.slice(pos))
  return parts.join('')
}

/** The files embedded in the recording's steps, one entry per call that
 *  embeds one. Throws when the recording can't be scanned. */
export function listImportedFiles(recordingJson: string): ImportedFile[] {
  return filesFromSpans(scanRecording(recordingJson, 0).spans)
}

/** The recording with every file payload emptied: each embedded byte array
 *  and `import_dae` `images` array becomes `[]`. Everything else, u64 values
 *  included, is copied through untouched. Returns the input unchanged when
 *  there is nothing to strip; throws when the recording can't be scanned, so
 *  a caller can drop the recording rather than send a file the user unticked. */
export function stripImportedFiles(recordingJson: string): string {
  return stripSpans(recordingJson, scanRecording(recordingJson, 0).spans)
}

export interface RecordingAnalysis {
  files: ImportedFile[]
  /** `stripImportedFiles` of the recording. */
  stripped: string
  stepCount: number
  /** The last `previewSteps` step names, oldest first. */
  lastStepNames: string[]
}

/** Everything a report needs from the recording in one pass: a large import
 *  makes the recording a few hundred megabytes, and each pass over it blocks
 *  the page for most of a second. Throws when the recording can't be
 *  scanned. */
export function analyzeRecording(recordingJson: string, previewSteps: number): RecordingAnalysis {
  const scan = scanRecording(recordingJson, previewSteps)
  return {
    files: filesFromSpans(scan.spans),
    stripped: stripSpans(recordingJson, scan.spans),
    stepCount: scan.stepCount,
    lastStepNames: scan.lastStepNames,
  }
}

/** Resolves on a new task, not a microtask, so the page can paint, handle
 *  input, and run its other queued tasks in between. A MessageChannel
 *  message: unlike a repeated `setTimeout(0)` it isn't clamped to 4 ms, and
 *  unlike `scheduler.yield()` it doesn't jump ahead of the page's other
 *  tasks, which would hold them all back until a long measurement ends. */
export function yieldTask(): Promise<void> {
  if (typeof MessageChannel === 'undefined') return new Promise((resolve) => setTimeout(resolve, 0))
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      resolve()
    }
    channel.port2.postMessage(null)
  })
}

/** Whether this runtime can gzip a report before sending it. */
export function canCompress(): boolean {
  return typeof CompressionStream !== 'undefined'
}

/**
 * Gzip a sequence of chunks as one stream with the platform's
 * `CompressionStream`. Each chunk is pulled only when the compressor is ready
 * for it, so a report of a few hundred megabytes never exists as one buffer.
 * The compressed bytes are kept only while their total stays at or under
 * `keepUpTo`; past it (or with 0) they are counted and discarded, and `bytes`
 * is null. The dialog sizes a report that way without holding it.
 */
export async function gzipChunks(
  chunks: Iterable<Uint8Array>,
  keepUpTo: number,
): Promise<{ bytes: Uint8Array | null; length: number }> {
  const stream = new CompressionStream('gzip')
  const writer = stream.writable.getWriter()
  const reader = stream.readable.getReader()
  let kept: Uint8Array[] | null = []
  let length = 0
  const drain = (async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      length += value.byteLength
      if (kept !== null && length <= keepUpTo) kept.push(value)
      else kept = null
    }
  })()
  try {
    for (const chunk of chunks) {
      await writer.ready
      // The streams lib types chunks as `Uint8Array<ArrayBuffer>`; every
      // caller passes bytes backed by a plain ArrayBuffer.
      await writer.write(chunk as Uint8Array<ArrayBuffer>)
      // Browsers compress inside write() and resolve it as a microtask, so
      // without a task boundary here a whole report compresses as one long
      // task and the page freezes until it's done.
      await yieldTask()
    }
    await writer.close()
  } catch (err) {
    await writer.abort(err).catch(() => undefined)
    await drain.catch(() => undefined)
    throw err
  }
  await drain
  if (kept === null) return { bytes: null, length }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of kept) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { bytes, length }
}
