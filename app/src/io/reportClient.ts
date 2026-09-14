/**
 * reportClient — submits a Help ▸ Report Bug report to the intake service
 * (docs/design/report-bug.md §8, the wire contract this must match exactly;
 * `workers/bug-intake` is the other side, built separately).
 *
 * A report is the gzip of the bundle `reportBundle.ts` builds, uploaded in
 * pieces of `PIECE_BYTES`: a start request carrying the first piece and the
 * total length, each following piece in order, then a commit. Each request
 * stays small because the intake service runs where a request gets 10 ms of
 * CPU (§4). A request that fails with a network error or a 5xx is retried
 * once.
 *
 * Desktop runs that whole upload in the Rust `report_submit` command
 * (report_client.rs) — the same "no arbitrary-URL capability in the
 * webview" posture as `relayClient.ts` — and always can, in every server
 * mode (design §5: a bug report is for Hew's developer, not a self-hosted
 * homelab). Web uploads same-origin under `/report/`, which only makes
 * sense — and is only attempted — when the page's own origin actually
 * serves that route: the production `app.hew3d.com` deployment, or a local
 * `vite dev` with `HEW_REPORT_PROXY` forwarding it to `wrangler dev` (see
 * `vite.config.ts`). Every other web build (self-hosted, a plain dev
 * server) has nowhere to send to, so `canSend()` is false there and
 * `ReportBugDialog` hides Send report entirely rather than let a submit
 * attempt fail.
 */

import { isTauri } from './fileHost'

/** Mirrors `ReportErrorKind` in report_client.rs (serde camelCase), plus
 *  `offline` for a web `fetch` that never reached the network at all —
 *  the desktop command's transport failures already collapse to
 *  `unreachable`/`tls`, but a browser `fetch` throwing a bare `TypeError`
 *  carries no such distinction from Rust to preserve. */
export type ReportErrorKind =
  | 'invalid'
  | 'tooLarge'
  | 'rateLimited'
  | 'full'
  | 'unreachable'
  | 'tls'
  | 'status'
  | 'offline'

export class ReportError extends Error {
  readonly kind: ReportErrorKind
  readonly status: number | undefined

  constructor(kind: ReportErrorKind, message: string, status?: number) {
    super(message)
    this.name = 'ReportError'
    this.kind = kind
    this.status = status
  }
}

const KINDS: ReadonlySet<string> = new Set<ReportErrorKind>([
  'invalid',
  'tooLarge',
  'rateLimited',
  'full',
  'unreachable',
  'tls',
  'status',
  'offline',
])

/** Turns whatever the Tauri `report_submit` invoke rejected with into a
 *  `ReportError`. Mirrors `relayClient.ts`'s `toRelayError`. */
function toReportError(err: unknown): ReportError {
  if (err instanceof ReportError) return err
  if (typeof err === 'object' && err !== null && 'kind' in err) {
    const kind = (err as { kind: unknown }).kind
    const message = (err as { message?: unknown }).message
    const status = (err as { status?: unknown }).status
    if (typeof kind === 'string' && KINDS.has(kind)) {
      return new ReportError(
        kind as ReportErrorKind,
        typeof message === 'string' ? message : kind,
        typeof status === 'number' ? status : undefined,
      )
    }
  }
  return new ReportError('unreachable', err instanceof Error ? err.message : String(err))
}

/** The production intake host — the one web origin `/report/` uploads are
 *  ever attempted from outside a proxied dev server. */
const CLOUD_APP_ORIGIN = 'https://app.hew3d.com'

/** Set by `vite.config.ts`'s `define` when `HEW_REPORT_PROXY` was configured
 *  for this dev server — see that file for why this needs to be a
 *  build-time flag rather than a runtime env read (the browser has no
 *  `process.env`). Undefined (falsy) outside a Vite build (e.g. plain
 *  `tsc`/vitest), matching the `__HEW_VERSION__` fallback convention. */
declare const __HEW_REPORT_DEV_PROXY__: boolean | undefined

/**
 * Whether this build/runtime can actually send a report anywhere. Desktop:
 * always (every server mode posts to the cloud intake service). Web: only
 * the production app origin, or a dev server with the proxy configured.
 * Everything else (a self-hosted web build, `vite dev` with no proxy) has
 * no route to the intake service, so the dialog must not offer Send report.
 */
export function canSend(): boolean {
  if (isTauri) return true
  if (typeof location !== 'undefined' && location.origin === CLOUD_APP_ORIGIN) return true
  return typeof __HEW_REPORT_DEV_PROXY__ !== 'undefined' && __HEW_REPORT_DEV_PROXY__
}

export interface ReportSubmitResult {
  id: string
}

/** How much of the compressed report has been uploaded. */
export interface ReportProgress {
  sentBytes: number
  totalBytes: number
}

/** The upload piece size, one storage row on the intake service (§8). */
export const PIECE_BYTES = 1_900_000

/** One request carries at most one piece; two minutes covers that on a slow
 *  uplink and still ends a stalled connection. */
const REQUEST_TIMEOUT_MS = 120_000

/** Maps one of §8's JSON error bodies + HTTP status onto a typed kind —
 *  the web-`fetch` twin of report_client.rs's `ReportError::from_status`.
 *  Falls back to `status` for anything that doesn't match the documented
 *  shape, which includes a piece's 403/404/409. */
function reportErrorFromResponse(status: number, body: unknown): ReportError {
  const error = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined
  switch (`${status} ${typeof error === 'string' ? error : ''}`) {
    case '400 invalid':
      return new ReportError('invalid', 'the report was rejected as invalid', status)
    case '413 too-large':
      return new ReportError('tooLarge', 'the report is too large to send', status)
    case '429 rate-limited':
      return new ReportError('rateLimited', 'too many reports sent recently', status)
    case '507 full':
      return new ReportError('full', 'the report service is temporarily full', status)
    default:
      if (status >= 500) return new ReportError('unreachable', 'the report service is unavailable', status)
      return new ReportError('status', `unexpected status ${status}`, status)
  }
}

/** Desktop path: the gzip bytes ride the invoke as a RAW body (the same
 *  convention `relayClient.ts`'s `relayPut` uses), never a JSON array — a
 *  90 MiB upload must not be serialized as tens of millions of numbers.
 *  Rust runs the piece-by-piece upload and reports progress as
 *  `report-progress` events. */
async function submitDesktop(
  gzipBytes: Uint8Array,
  onProgress?: (progress: ReportProgress) => void,
): Promise<ReportSubmitResult> {
  const { invoke } = await import('@tauri-apps/api/core')
  let unlisten: (() => void) | undefined
  if (onProgress !== undefined) {
    try {
      const { listen } = await import('@tauri-apps/api/event')
      unlisten = await listen<ReportProgress>('report-progress', (event) => onProgress(event.payload))
    } catch {
      // Progress is cosmetic; the upload doesn't depend on it.
    }
  }
  try {
    return await invoke<ReportSubmitResult>('report_submit', gzipBytes as never)
  } catch (err) {
    throw toReportError(err)
  } finally {
    unlisten?.()
  }
}

/** One `fetch` with the per-request timeout. A thrown error (offline, DNS,
 *  aborted by the timeout) comes back as `null` instead of a response. */
async function fetchOnce(url: string, init: RequestInit): Promise<Response | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** §8's retry rule: a network error or a 5xx is retried once. Every step
 *  tolerates a repeat: the service accepts a retry of the last piece, and a
 *  commit repeated with the upload's token answers 201 again. */
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  const first = await fetchOnce(url, init)
  if (first !== null && first.status < 500) return first
  const second = await fetchOnce(url, init)
  if (second === null) throw new ReportError('offline', 'could not reach the report service')
  return second
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

/** One piece of the upload as a request body. `gzip()` allocates a plain
 *  ArrayBuffer, so the view is safe to hand to `fetch` as-is. */
function pieceBody(bytes: Uint8Array, start: number, end: number): Uint8Array<ArrayBuffer> {
  return bytes.subarray(start, end) as Uint8Array<ArrayBuffer>
}

/** Web path: start, pieces, commit, all same-origin under `/report/`. Only
 *  ever attempted when `canSend()` is true (the caller's responsibility —
 *  this function does not re-check). */
async function submitWeb(
  gzipBytes: Uint8Array,
  onProgress?: (progress: ReportProgress) => void,
): Promise<ReportSubmitResult> {
  const total = gzipBytes.byteLength
  const firstEnd = Math.min(PIECE_BYTES, total)

  const start = await fetchWithRetry('/report/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/gzip', 'Hew-Upload-Length': String(total) },
    body: pieceBody(gzipBytes, 0, firstEnd),
  })
  const startJson = await readJson(start)
  if (start.status !== 201) throw reportErrorFromResponse(start.status, startJson)
  const id = typeof startJson === 'object' && startJson !== null ? (startJson as { id?: unknown }).id : undefined
  const token = typeof startJson === 'object' && startJson !== null ? (startJson as { token?: unknown }).token : undefined
  if (typeof id !== 'string' || typeof token !== 'string') {
    throw new ReportError('status', 'malformed response from the report service')
  }
  onProgress?.({ sentBytes: firstEnd, totalBytes: total })

  const base = `/report/${encodeURIComponent(id)}`
  let offset = firstEnd
  for (let index = 1; offset < total; index++) {
    const end = Math.min(offset + PIECE_BYTES, total)
    const response = await fetchWithRetry(`${base}/${index}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/gzip', 'Hew-Upload-Token': token },
      body: pieceBody(gzipBytes, offset, end),
    })
    if (response.status !== 204) throw reportErrorFromResponse(response.status, await readJson(response))
    offset = end
    onProgress?.({ sentBytes: offset, totalBytes: total })
  }

  const commit = await fetchWithRetry(`${base}/commit`, {
    method: 'POST',
    headers: { 'Hew-Upload-Token': token },
  })
  if (commit.status === 201) return { id }
  throw reportErrorFromResponse(commit.status, await readJson(commit))
}

/** Submit a report — the gzip of the bundle `reportBundle.ts` builds
 *  (`send.gzip`) — to the intake service, reporting upload progress as it
 *  goes. Rejects with a `ReportError` naming the specific problem; callers
 *  should check `canSend()` first, since a build with nowhere to send has no
 *  reason to attempt this at all. */
export function submitReport(
  gzipBytes: Uint8Array,
  onProgress?: (progress: ReportProgress) => void,
): Promise<ReportSubmitResult> {
  return isTauri ? submitDesktop(gzipBytes, onProgress) : submitWeb(gzipBytes, onProgress)
}
