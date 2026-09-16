/**
 * reportBundle — builds the Help ▸ Report Bug wire bundle (docs/design/
 * report-bug.md §3, format 1) that `ReportBugDialog` sends via
 * `io/reportClient.ts` or writes to a file. This module only assembles the
 * bundle and per-row preview data; the dialog and its callers own where the
 * result goes.
 *
 * Six checklist rows, matching §2's table: `system`, `recording` (the
 * peeked/panic-captured session recording), `imports` (the user files the
 * recording's steps embed), `model` (the .hew bytes), `log` (the
 * diagnostic-log tail), and `input` (raw low-level events, listed only in
 * Debug Mode). Unticked or unavailable rows are OMITTED from the bundle
 * object, never nulled. Keys are written `format`, `report`, `system`, then
 * `crash` first: the intake service validates that head, and its admin page
 * shows it, without decompressing the rest.
 *
 * `recording` is an opaque string, never `JSON.parse`d: its `golden_hash`
 * and handles are u64s that lose precision through a JS `number`
 * round-trip (see `recording/sessionRecording.ts`). The step preview and the
 * import scan (`reportImports.ts`) read it with a scanner instead.
 *
 * A report is built in two stages. `gatherReport` reads everything once:
 * the recording (one wasm call), the model, the log, and a single scan of
 * the recording. The dialog calls it once per opening, since after a large
 * import it blocks the page in stretches of a second or two. Everything
 * after that works from the gathered `ReportContent`:
 * - `describeReport`: the checklist rows, instantly, for any ticked set.
 * - `measureUpload`: the compressed size of what Send would upload, counted
 *   without keeping the bytes.
 * - `encodeReportFile`: every ticked row as UTF-8 JSON, what Save to file
 *   writes.
 * - `compressReportUpload`: the gzip Send uploads, which drops the model and
 *   then imported files when the compressed size passes the cap.
 * `buildReportBundle`, `buildReportFile`, and `buildReportUpload` gather and
 * build in one call.
 *
 * A session that imported a large file records it byte by byte, so the
 * bundle can run to hundreds of megabytes. It is never assembled as one
 * string: `bundleStrings` yields it in pieces of at most `SEGMENT_CHARS`,
 * which are compressed or encoded as they come, and an `AbortSignal` stops a
 * compression between pieces.
 *
 * Scrubbing runs on the log tail before any preview is computed, so the
 * preview is provably what gets sent (§3's stated invariant): on desktop,
 * every occurrence of the resolved home directory becomes `~`; the web
 * build has no filesystem home to scrub, so `homeDir` is null there.
 */

import * as diagnosticLog from './diagnosticLog'
import type { InputEvent } from '../recording/inputRecorder'
import { analyzeRecording, canCompress, gzipChunks, yieldTask, type ImportedFile } from './reportImports'

/** The minimal Scene surface this module needs — see crates/wasm-api/src/lib.rs. */
export interface ReportableScene {
  save(): Uint8Array
  peek_recording(): string
  /** Visible object handles — only `.length` is used here (an object count). */
  object_ids(): { length: number }
}

export interface ReportFields {
  description: string
  expected: string
  contact: string
}

export interface ReportFlags {
  system: boolean
  recording: boolean
  imports: boolean
  model: boolean
  log: boolean
  input: boolean
}

/** The wasm panic hook's capture (`panicCapture.ts`), reused here as the
 *  crash-mode `recording` source and the `crash` block's `{ at, message }`. */
export interface ReportCrashInfo {
  at: string
  message: string
  recording: string | null
}

/** What gathering needs: everything that stays fixed while the dialog is open. */
export interface GatherReportOptions {
  /** Null in crash mode (the app tree is gone) or while the kernel is still loading. */
  scene: ReportableScene | null
  /** For the model row's preview only — never sent as its own field. */
  documentName: string
  /** `desktop-macos` / `web-windows` / … — see `detectPlatform`. Passed in
   *  rather than detected here so this module stays free of the app's
   *  `platform.ts` runtime-detection import graph. */
  platform: string
  /** Gates the input row exactly like `ReportBugDialog` gates showing it:
   *  off Debug Mode, raw input events are never gathered. */
  debugMode: boolean
  /** Non-null puts the whole bundle in crash mode: `hew` is never included
   *  (no live scene to save), `recording` prefers this capture, and a `crash`
   *  block is added. */
  crash: ReportCrashInfo | null
  /** The desktop home directory to scrub from the log tail (`homeDir()` from
   *  `@tauri-apps/api/path`), or null when there is none to scrub (web) or
   *  it could not be resolved. */
  homeDir: string | null
  /** Aborting stops gathering between its steps with `ReportBuildCancelled`:
   *  closing the dialog mid-gather shouldn't keep the page busy. */
  signal?: AbortSignal
}

/** What each build needs on top of the gathered content. */
export interface ReportBuildOptions {
  fields: ReportFields
  flags: ReportFlags
  /** The compressed-size cap Send enforces; defaults to `MAX_SEND_BYTES`. */
  maxSendBytes?: number
  /** Largest string piece the bundle is written in; defaults to
   *  `SEGMENT_CHARS`. Tests shrink it to cross piece boundaries. */
  segmentChars?: number
  /** Aborting stops a build between pieces with `ReportBuildCancelled`. */
  signal?: AbortSignal
}

export interface BuildReportBundleOptions extends Omit<GatherReportOptions, 'signal'>, Omit<ReportBuildOptions, 'signal'> {}

export type ReportRowKey = 'system' | 'recording' | 'imports' | 'model' | 'log' | 'input'

export interface ReportRowInfo {
  /** Whether this row's data is in the saved file. False for an unticked
   *  row or an unavailable one. */
  included: boolean
  /** Uncompressed size in bytes. For `imports`, the size of the embedded
   *  files themselves, not their JSON byte-array text. */
  bytes: number
  /** Set only when the row is shown as disabled/unavailable, e.g.
   *  "unavailable after a crash". */
  disabledReason: string | null
  /** True when the row is ticked and saved but left out of the sent bundle
   *  because the compressed report passed the cap (§3). */
  droppedFromSend: boolean
  /** Read-only preview text for the row's Show link. */
  preview: string
}

export interface ReportSendPreview {
  /** Compressed size of the bundle Send would upload, or null when this
   *  runtime can't compress. */
  compressedBytes: number | null
  /** Why Send can't go ahead, or null when it can. */
  unavailableReason: string | null
}

export interface ReportSendMeasure extends ReportSendPreview {
  /** Ticked rows Send leaves out to fit the cap, in the order dropped. */
  dropped: ReportRowKey[]
}

export interface ReportUpload extends ReportSendPreview {
  /** The gzip bytes Send uploads, or null when this report can't be sent. */
  gzip: Uint8Array | null
}

export interface ReportDescription {
  /** The files embedded in the recording's steps (empty when none). */
  importedFiles: ImportedFile[]
  rows: Record<ReportRowKey, ReportRowInfo>
}

export interface BuildReportBundleResult extends ReportDescription {
  send: ReportSendPreview
}

/** Thrown by a gather or build whose `signal` aborted. */
export class ReportBuildCancelled extends Error {
  constructor() {
    super('report build cancelled')
    this.name = 'ReportBuildCancelled'
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ReportBuildCancelled()
}

/** §3's cap on the compressed upload: under the Cloudflare free plan's
 *  100 MB request body limit. Past it, the model and then imported files
 *  are dropped from the sent bundle. */
export const MAX_SEND_BYTES = 90 * 1024 * 1024

/** The largest piece the bundle is written in. Each piece is escaped,
 *  encoded, and compressed in one stretch before the page gets a turn, so a
 *  mebibyte keeps each stretch to tens of milliseconds. */
export const SEGMENT_CHARS = 1 << 20

/** §2's log preview/inclusion size: the tail, not the whole ring buffer. */
const LOG_TAIL_LINES = 200

/** §2's recording preview: the last N step names, not the whole call list. */
const RECORDING_PREVIEW_STEPS = 20


export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}


function detectOs(): string {
  if (typeof navigator === 'undefined') return ''
  const uad = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
  return uad?.platform ?? navigator.platform ?? ''
}

/** Best-effort GPU renderer string via a throwaway WebGL context — headless
 *  test environments and extension-blocking browsers both return ''. */
function detectGpu(): string {
  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl')
    if (gl === null) return ''
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    if (ext === null) return ''
    const renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
    return typeof renderer === 'string' ? renderer : ''
  } catch {
    return ''
  }
}

/** `desktop-macos` / `web-windows` / … — not sent as its own field, only as
 *  part of `system.platform`; §3's example shows `"desktop-macos"`. */
export function detectPlatform(isTauri: boolean, isMac: boolean, isWindows: boolean, isLinux: boolean): string {
  const host = isTauri ? 'desktop' : 'web'
  const os = isMac ? 'macos' : isWindows ? 'windows' : isLinux ? 'linux' : 'other'
  return `${host}-${os}`
}

export interface ReportSystemInfo {
  appVersion: string
  platform: string
  os: string
  gpu: string
  userAgent: string
}

export function gatherSystemInfo(appVersion: string, platform: string): ReportSystemInfo {
  let userAgent = ''
  try {
    userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  } catch {
    userAgent = ''
  }
  let os = ''
  try {
    os = detectOs()
  } catch {
    os = ''
  }
  let gpu = ''
  try {
    gpu = detectGpu()
  } catch {
    gpu = ''
  }
  return { appVersion, platform, os, gpu, userAgent }
}

function base64FromBytes(bytes: Uint8Array): string {
  // Chunked to avoid blowing the call stack on a large document — mirrors
  // reproducerDump.ts's base64FromBytes.
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const chunk = bytes.subarray(i, i + CHUNK)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

/**
 * Home-directory-SHAPED path prefixes, for the pass after the literal one:
 * the file-I/O error strings the desktop shell echoes into the log carry the
 * exact path they failed on, and that path is not always under the current
 * user's own home — another account's folder on a shared machine, the same
 * folder spelled with different letter-case on Windows, an extended-length
 * `\\?\` form. Each pattern captures the per-user segment of the three
 * layouts (`/Users/<name>`, `/home/<name>`, `<drive>:\Users\<name>`) in the
 * raw, forward-slash, and JSON-escaped (doubled backslash) spellings, and
 * stops at the next separator, quote, or whitespace. Case-insensitive, since
 * Windows and macOS volumes are.
 */
const HOME_SHAPED_PREFIXES: RegExp[] = [
  // Windows first: `D:/Users/erin` must go as a whole, not leave `D:` behind
  // once the POSIX pattern below has eaten its `/Users/erin` tail.
  /(?:\\\\\?\\|\\\?\\)?[A-Za-z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/)[^\/\\\s"'<>|]+/gi,
  /(?:^|(?<=[\s"'(=:,]))\/(?:Users|home)\/[^\/\\\s"'<>|]+/gi,
]

/**
 * Replace every occurrence of `homeDir` in `text` with `~`, in every form it
 * can actually appear in sent text — not just the raw path. The log tail is
 * NDJSON built by `JSON.stringify`ing each record, so a Windows path like
 * `C:\Users\kurt` shows up there as `C:\\Users\\kurt` (JSON's backslash
 * escaping): a plain literal replace of the raw path never matches that, and
 * the username would ship in every Windows report. Also covers a
 * forward-slash form, since some sources (Rust's own path normalization, a
 * message a library formatted) render a Windows path that way. Then, because
 * the desktop shell's file-I/O errors name whatever path they failed on —
 * not necessarily one under THIS user's home (see `HOME_SHAPED_PREFIXES`) —
 * every remaining home-directory-shaped prefix is redacted to `~` too. No-op
 * when `homeDir` is null or empty: the web build has no filesystem paths to
 * scrub, and the literal form is what tells us we are on a desktop.
 */
export function scrubHomeDir(text: string, homeDir: string | null): string {
  if (homeDir === null || homeDir === '') return text
  const variants = new Set<string>([
    homeDir,
    // The JSON-string-literal encoding of homeDir, unquoted — matches the
    // doubled backslashes a Windows path gets once it's inside a
    // JSON.stringify'd record (or any other JSON string field).
    JSON.stringify(homeDir).slice(1, -1),
    homeDir.replace(/\\/g, '/'),
  ])
  // Longest first: the JSON-escaped variant is a superstring of the raw one
  // on Windows (doubled backslashes), so replacing the raw form first would
  // leave stray backslashes the escaped-form pass could no longer match.
  let result = text
  for (const variant of Array.from(variants).sort((a, b) => b.length - a.length)) {
    if (variant.length === 0) continue
    result = result.split(variant).join('~')
  }
  for (const pattern of HOME_SHAPED_PREFIXES) {
    result = result.replace(pattern, '~')
  }
  return result
}

/**
 * Extract a step count and the last N step names from a recording JSON
 * string WITHOUT `JSON.parse`ing it (module doc comment). Each element of
 * the top-level `calls` array is one `RecordedCall`, which serde writes
 * internally tagged (`crates/wasm-api/src/recording.rs`:
 * `#[serde(tag = "method", rename_all = "snake_case")]`), so every element
 * is an object whose `method` value is the step name:
 * `{"method":"extrude_region","sketch":…}`. Field values, including any u64
 * handles, are never touched. Best-effort: a differently-shaped or
 * malformed string yields `{ stepCount: 0, lastStepNames: [] }` rather than
 * throwing. `gatherReport` gets the same summary from `analyzeRecording`'s
 * single pass and uses this only for a recording that pass can't scan.
 */
export function extractRecordingSummary(recordingJson: string): { stepCount: number; lastStepNames: string[] } {
  try {
    const marker = '"calls":['
    const markerIndex = recordingJson.indexOf(marker)
    if (markerIndex === -1) return { stepCount: 0, lastStepNames: [] }
    const arrayOpen = markerIndex + marker.length - 1 // index of the '['

    const elements: string[] = []
    let depth = 1 // already inside the array opened at arrayOpen
    let inString = false
    let escape = false
    let elemStart = arrayOpen + 1
    let i = elemStart
    for (; i < recordingJson.length; i++) {
      const c = recordingJson[i]
      if (inString) {
        if (escape) escape = false
        else if (c === '\\') escape = true
        else if (c === '"') inString = false
        continue
      }
      if (c === '"') {
        inString = true
        continue
      }
      if (c === '[' || c === '{') {
        depth++
        continue
      }
      if (c === ']' || c === '}') {
        depth--
        if (depth === 0) {
          const tail = recordingJson.slice(elemStart, i).trim()
          if (tail.length > 0) elements.push(tail)
          break
        }
        continue
      }
      if (c === ',' && depth === 1) {
        elements.push(recordingJson.slice(elemStart, i).trim())
        elemStart = i + 1
      }
    }

    const names = elements.map(tagNameOf)
    return { stepCount: names.length, lastStepNames: names.slice(Math.max(0, names.length - RECORDING_PREVIEW_STEPS)) }
  } catch {
    return { stepCount: 0, lastStepNames: [] }
  }
}

/** The step name of one `calls[]` element: the value of its `method` tag.
 *  serde writes the tag before the variant's fields, so the first `method`
 *  key in the element is the call's own, never one nested inside a field. */
function tagNameOf(element: string): string {
  const m = /^\{\s*"method"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(element)
  return m ? m[1] : 'unknown'
}

/** Everything a report can contain, gathered once. The large values stay in
 *  their source form (the recording string, the model bytes) and are
 *  serialized piece by piece by `bundleStrings`. */
export interface ReportContent {
  system: ReportSystemInfo
  recording: string | null
  recordingSummary: { stepCount: number; lastStepNames: string[] }
  /** The recording with file payloads emptied; the recording itself when
   *  it has no files; null when it couldn't be scanned. */
  strippedRecording: string | null
  importScanFailed: boolean
  importedFiles: ImportedFile[]
  modelAvailable: boolean
  modelDisabledReason: string | null
  model: Uint8Array | null
  objectCount: number
  logTail: string
  debugMode: boolean
  input: InputEvent[]
  /** The crash block, message scrubbed; null outside crash mode. */
  crash: { at: string; message: string } | null
  scrubbedDocumentName: string
}

/** Gather every row's data. Throws only `ReportBuildCancelled`, when
 *  `signal` aborts: every scene call and every best-effort gather is
 *  wrapped — a throwing scene or an unresolvable home directory still
 *  produces a report, just a smaller one. Yields to the event loop between
 *  its heavy steps, each of which can block for a second or two after a
 *  large import, and checks `signal` after each yield. */
export async function gatherReport(opts: GatherReportOptions): Promise<ReportContent> {
  const { scene, documentName, platform, debugMode, crash, homeDir, signal } = opts
  throwIfAborted(signal)

  // ---- system (always gatherable; never depends on the scene) ----------
  const system = gatherSystemInfo(
    typeof __HEW_VERSION__ !== 'undefined' ? __HEW_VERSION__ : '0.0.0',
    platform,
  )

  // ---- recording ---------------------------------------------------------
  let recording: string | null = null
  if (crash !== null) {
    recording = crash.recording
  } else if (scene !== null) {
    try {
      recording = scene.peek_recording()
    } catch {
      recording = null
    }
  }

  // ---- imported files and the step summary, in one scan -----------------
  // A recording that can't be scanned can't be stripped either, so it is
  // withheld entirely rather than risk sending a file the user unticked.
  let importedFiles: ImportedFile[] = []
  let strippedRecording: string | null = recording
  let importScanFailed = false
  let recordingSummary = { stepCount: 0, lastStepNames: [] as string[] }
  if (recording !== null) {
    await yieldTask()
    throwIfAborted(signal)
    try {
      const analysis = analyzeRecording(recording, RECORDING_PREVIEW_STEPS)
      importedFiles = analysis.files
      strippedRecording = analysis.stripped
      recordingSummary = { stepCount: analysis.stepCount, lastStepNames: analysis.lastStepNames }
    } catch {
      importScanFailed = true
      importedFiles = []
      strippedRecording = null
      recordingSummary = extractRecordingSummary(recording)
    }
    await yieldTask()
    throwIfAborted(signal)
  }

  // ---- model (.hew) — unavailable in crash mode or with no scene --------
  const modelAvailable = crash === null && scene !== null
  let model: Uint8Array | null = null
  let objectCount = 0
  if (modelAvailable && scene !== null) {
    try {
      model = scene.save()
    } catch {
      model = null
    }
    try {
      objectCount = scene.object_ids().length
    } catch {
      objectCount = 0
    }
  }

  // ---- diagnostic log — scrubbed BEFORE the preview is computed --------
  let logTail = ''
  try {
    const records = diagnosticLog.getRecords()
    const tail = records.slice(Math.max(0, records.length - LOG_TAIL_LINES))
    logTail = scrubHomeDir(diagnosticLog.toNDJSON(tail), homeDir)
  } catch {
    logTail = ''
  }

  // ---- raw input events — only ever gathered in Debug Mode -------------
  let input: InputEvent[] = []
  if (debugMode) {
    try {
      const { peek } = await import('../recording/inputRecorder')
      input = peek()
    } catch {
      input = []
    }
  }

  return {
    system,
    recording,
    recordingSummary,
    strippedRecording,
    importScanFailed,
    importedFiles,
    modelAvailable,
    modelDisabledReason:
      crash !== null ? 'unavailable after a crash' : scene === null ? 'unavailable — no document loaded' : null,
    model,
    objectCount,
    logTail,
    debugMode,
    input,
    // Every other sent (or shown) string that can carry a path gets the same
    // treatment as the log. A Rust panic message can embed a path from
    // whatever it was operating on, and the model preview shows the document
    // name/path back to the user even though it's never itself sent.
    crash: crash !== null ? { at: crash.at, message: scrubHomeDir(crash.message, homeDir) } : null,
    scrubbedDocumentName: scrubHomeDir(documentName, homeDir),
  }
}

/** Which rows a report carries for this checklist: ticked and available. */
interface Inclusion {
  system: boolean
  recording: boolean
  imports: boolean
  model: boolean
  log: boolean
  input: boolean
}

function inclusionOf(c: ReportContent, flags: ReportFlags): Inclusion {
  const recording = flags.recording && c.recording !== null && !c.importScanFailed
  return {
    system: flags.system,
    recording,
    imports: recording && c.importedFiles.length > 0 && flags.imports,
    model: flags.model && c.modelAvailable && c.model !== null,
    log: flags.log,
    input: c.debugMode && flags.input && c.input.length > 0,
  }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

/** `JSON.stringify(s)`, in pieces of about `size` characters. A piece never
 *  ends between the halves of a surrogate pair, where `JSON.stringify` would
 *  escape each half on its own. */
function* jsonStringPieces(s: string, size: number): Generator<string> {
  if (s.length <= size) {
    yield JSON.stringify(s)
    return
  }
  yield '"'
  for (let start = 0; start < s.length; ) {
    let end = Math.min(s.length, start + size)
    if (end < s.length && isHighSurrogate(s.charCodeAt(end - 1))) end++
    yield JSON.stringify(s.slice(start, end)).slice(1, -1)
    start = end
  }
  yield '"'
}

/** Base64 of `bytes`, in pieces of at most `size` characters. Each piece
 *  covers a whole number of 3-byte groups, so no piece carries padding
 *  except the last. */
function* base64Pieces(bytes: Uint8Array, size: number): Generator<string> {
  const step = 3 * Math.max(1, Math.floor(size / 4))
  for (let i = 0; i < bytes.length; i += step) yield base64FromBytes(bytes.subarray(i, i + step))
}

/**
 * The bundle's JSON text in pieces, identical when joined to
 * `JSON.stringify` of the bundle object. Insertion order is the wire order:
 * format, report, system, crash first (§3), the small fields the intake
 * service reads from the front of the first piece.
 */
function* bundleStrings(
  c: ReportContent,
  inc: Inclusion,
  opts: ReportBuildOptions,
  includeModel: boolean,
  includeImports: boolean,
): Generator<string> {
  const { fields } = opts
  const size = Math.max(1, opts.segmentChars ?? SEGMENT_CHARS)
  const report = {
    description: fields.description,
    ...(fields.expected.trim() !== '' ? { expected: fields.expected } : {}),
    ...(fields.contact.trim() !== '' ? { contact: fields.contact } : {}),
  }
  yield `{"format":1,"report":${JSON.stringify(report)}`
  if (inc.system) yield `,"system":${JSON.stringify(c.system)}`
  if (c.crash !== null) yield `,"crash":${JSON.stringify(c.crash)}`
  if (inc.recording) {
    yield ',"recording":'
    yield* jsonStringPieces((includeImports ? c.recording : c.strippedRecording) as string, size)
    if (c.importedFiles.length > 0 && !includeImports) yield ',"importsStripped":true'
  }
  if (includeModel && c.model !== null) {
    yield ',"hew":"'
    yield* base64Pieces(c.model, size)
    yield '"'
  }
  if (inc.log) {
    yield ',"log":'
    yield* jsonStringPieces(c.logTail, size)
  }
  if (inc.input) yield `,"input":${JSON.stringify(c.input)}`
  yield '}'
}

function* utf8Pieces(strings: Iterable<string>, signal: AbortSignal | undefined): Generator<Uint8Array> {
  const encoder = new TextEncoder()
  for (const s of strings) {
    if (signal?.aborted) throw new ReportBuildCancelled()
    yield encoder.encode(s)
  }
}

/** The UTF-8 length of `s` as `TextEncoder` writes it: a lone surrogate
 *  becomes U+FFFD, three bytes. */
function utf8Length(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code < 0x80) n += 1
    else if (code < 0x800) n += 2
    else if (isHighSurrogate(code) && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

interface SendPlan {
  upload: ReportUpload
  dropped: ReportRowKey[]
}

/** Compress the bundle Send would upload, dropping the model and then the
 *  imported files while it passes the cap. The cap is on the compressed
 *  upload, so each drop is measured by compressing again; a report that fits
 *  keeps every ticked row. `keep` holds the bytes of a report that fits. */
async function planSend(c: ReportContent, opts: ReportBuildOptions, keep: boolean): Promise<SendPlan> {
  const maxSendBytes = opts.maxSendBytes ?? MAX_SEND_BYTES
  const dropped: ReportRowKey[] = []
  if (!canCompress()) {
    return {
      upload: {
        gzip: null,
        compressedBytes: null,
        unavailableReason: 'This system can’t compress reports, so it can’t send them. Save the report to a file instead.',
      },
      dropped,
    }
  }
  const inc = inclusionOf(c, opts.flags)
  try {
    let sendModel = inc.model
    let sendImports = inc.imports
    const compress = () =>
      gzipChunks(utf8Pieces(bundleStrings(c, inc, opts, sendModel, sendImports), opts.signal), keep ? maxSendBytes : 0)
    let result = await compress()
    if (result.length > maxSendBytes && sendModel) {
      sendModel = false
      dropped.push('model')
      result = await compress()
    }
    if (result.length > maxSendBytes && sendImports) {
      sendImports = false
      dropped.push('imports')
      result = await compress()
    }
    if (result.length > maxSendBytes) {
      return {
        upload: {
          gzip: null,
          compressedBytes: result.length,
          unavailableReason: `This report is ${formatBytes(result.length)} compressed, over the ${formatBytes(maxSendBytes)} limit. Save it to a file instead.`,
        },
        dropped,
      }
    }
    return { upload: { gzip: result.bytes, compressedBytes: result.length, unavailableReason: null }, dropped }
  } catch (err) {
    if (err instanceof ReportBuildCancelled || opts.signal?.aborted) throw new ReportBuildCancelled()
    return {
      upload: { gzip: null, compressedBytes: null, unavailableReason: 'Couldn’t compress this report. Save it to a file instead.' },
      dropped,
    }
  }
}

/** The checklist rows for `flags`. Cheap: works from the gathered content,
 *  so the dialog recomputes it on every tick. `dropped` marks the rows a
 *  measurement found Send has to leave out. */
export function describeReport(
  c: ReportContent,
  flags: ReportFlags,
  dropped: readonly ReportRowKey[] = [],
): ReportDescription {
  const inc = inclusionOf(c, flags)
  const { system, recording, recordingSummary, importedFiles, input, debugMode } = c
  const hasImports = importedFiles.length > 0

  // The recording is ASCII apart from rare non-ASCII names, and encoding a
  // few hundred megabytes just to count it isn't worth it; its length is
  // close enough for a size label.
  const importsChars = importedFiles.reduce((n, f) => n + f.recordingChars, 0)
  const hewBytes = c.model !== null ? 4 * Math.ceil(c.model.byteLength / 3) : 0
  const inputBytes = debugMode && input.length > 0 ? utf8Length(JSON.stringify(input)) : 0

  const rows: Record<ReportRowKey, ReportRowInfo> = {
    system: {
      included: inc.system,
      bytes: utf8Length(JSON.stringify(system)),
      disabledReason: null,
      droppedFromSend: false,
      preview: `${system.appVersion} · ${system.platform} · ${system.os || 'unknown OS'} · ${system.gpu || 'unknown GPU'} · ${system.userAgent}`,
    },
    recording: {
      included: inc.recording,
      bytes: recording !== null ? recording.length - importsChars : 0,
      disabledReason:
        recording === null
          ? 'no recording available'
          : c.importScanFailed
            ? 'couldn’t separate imported files from the steps'
            : null,
      droppedFromSend: false,
      preview:
        recording === null
          ? 'No recorded steps available.'
          : `${recordingSummary.stepCount} step${recordingSummary.stepCount === 1 ? '' : 's'} recorded\nLast steps:\n${recordingSummary.lastStepNames.join('\n')}`,
    },
    imports: {
      included: inc.imports,
      bytes: importedFiles.reduce((n, f) => n + f.fileBytes, 0),
      disabledReason: !hasImports ? 'no imported files' : !inc.recording ? 'sent only with recorded steps' : null,
      droppedFromSend: dropped.includes('imports'),
      preview: hasImports
        ? importedFiles.map((f) => `${f.label}, ${formatBytes(f.fileBytes)}`).join('\n')
        : 'No imported files.',
    },
    model: {
      included: inc.model,
      bytes: c.modelAvailable ? hewBytes : 0,
      disabledReason: c.modelDisabledReason,
      droppedFromSend: dropped.includes('model'),
      preview: c.modelAvailable
        ? `${c.scrubbedDocumentName} · ${c.objectCount} object${c.objectCount === 1 ? '' : 's'} · ${formatBytes(hewBytes)}`
        : `The model is ${c.modelDisabledReason ?? 'unavailable'}.`,
    },
    log: {
      included: inc.log,
      bytes: utf8Length(c.logTail),
      disabledReason: null,
      droppedFromSend: false,
      preview: c.logTail,
    },
    input: {
      included: inc.input,
      bytes: inputBytes,
      disabledReason: debugMode ? null : 'only recorded in Debug Mode',
      droppedFromSend: false,
      preview: `${input.length} event${input.length === 1 ? '' : 's'} recorded`,
    },
  }

  return { importedFiles, rows }
}

/** The compressed size of what Send would upload for `opts.flags`, counted
 *  without keeping the bytes, and which rows Send would drop to fit. */
export async function measureUpload(c: ReportContent, opts: ReportBuildOptions): Promise<ReportSendMeasure> {
  const { upload, dropped } = await planSend(c, opts, false)
  return { compressedBytes: upload.compressedBytes, unavailableReason: upload.unavailableReason, dropped }
}

/** Every ticked row as UTF-8 JSON: what Save to file writes. Measures the
 *  pieces first and encodes them straight into one buffer, so the text
 *  never exists as a single string beside its bytes. Lets the page run
 *  after every piece. */
export async function encodeReportFile(c: ReportContent, opts: ReportBuildOptions): Promise<Uint8Array> {
  const inc = inclusionOf(c, opts.flags)
  const pieces = () => bundleStrings(c, inc, opts, inc.model, inc.imports)
  let total = 0
  for (const s of pieces()) {
    total += utf8Length(s)
    await yieldTask()
    throwIfAborted(opts.signal)
  }
  const out = new Uint8Array(total)
  const encoder = new TextEncoder()
  let offset = 0
  for (const s of pieces()) {
    offset += encoder.encodeInto(s, out.subarray(offset)).written
    await yieldTask()
    throwIfAborted(opts.signal)
  }
  if (offset !== total) throw new Error(`report file encoded ${offset} of ${total} bytes`)
  return out
}

/** The gzip Send uploads, with the model and then imported files dropped
 *  past the cap, or the reason it can't be sent. */
export async function compressReportUpload(c: ReportContent, opts: ReportBuildOptions): Promise<ReportUpload> {
  return (await planSend(c, opts, true)).upload
}

/** Gather, then the rows and the compressed size, in one call. */
export async function buildReportBundle(opts: BuildReportBundleOptions): Promise<BuildReportBundleResult> {
  const c = await gatherReport(opts)
  const measure = await measureUpload(c, opts)
  return {
    send: { compressedBytes: measure.compressedBytes, unavailableReason: measure.unavailableReason },
    ...describeReport(c, opts.flags, measure.dropped),
  }
}

/** Gather, then `encodeReportFile`, in one call. */
export async function buildReportFile(opts: BuildReportBundleOptions): Promise<Uint8Array> {
  return encodeReportFile(await gatherReport(opts), opts)
}

/** Gather, then `compressReportUpload`, in one call. */
export async function buildReportUpload(opts: BuildReportBundleOptions): Promise<ReportUpload> {
  return compressReportUpload(await gatherReport(opts), opts)
}

// Optional build-time version string — absent under a bare tsc/vitest run
// with no Vite define step.
declare const __HEW_VERSION__: string | undefined
