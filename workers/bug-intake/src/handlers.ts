/**
 * bug-intake — the private Report Bug intake service (docs/design/report-bug.md
 * §4, §8, the only sections this Worker implements exactly). Written as
 * plain functions over the `BugIntakeEnv` binding interface (`types.ts`),
 * mirroring share-relay's `handlers.ts` split: `handlers.test.ts` runs this
 * against a fake DO namespace (`testSupport/fakeDurableObject.ts`) wrapping
 * the real `ReportStore`/`IndexStore` logic, with no `cloudflare:workers` or
 * `cloudflare:email` import anywhere in this file's dependency graph — see
 * `reportDrop.ts`, `reportIndex.ts`, and `emailMailer.ts` for the thin
 * wrappers that touch those runtime modules, wired in only by `index.ts`.
 *
 * Every response carries `Cache-Control: no-store` (§8) and no CORS headers
 * — the web build posts same-origin under `app.hew3d.com`, and the desktop
 * client isn't a browser, so there is nothing here for CORS to gate.
 *
 * The upload is chunked (§4 "Chunked upload"): the Workers Free plan caps
 * CPU time at 10 ms per request, and copying a 60–90 MiB upload through one
 * request doesn't fit — so the client splits it into pieces of at most
 * `PIECE_BYTES` (1.9 MB) and sends START (this handles the first piece and
 * opens the upload), then PIECE for each following piece, then COMMIT. Each
 * of those three is its own exported handler below.
 */

import { MAX_UPLOAD_BYTES, PIECE_BYTES, CONTRACT_FORMAT, INDEX_DO_NAME } from './constants.ts'
import { readBodyCapped, TOO_LARGE } from './bytes.ts'
import { decompressAndValidateHead, HeadDecompressor, parseHeadForDisplay } from './headScan.ts'
import { generateReportId, isValidReportId, normalizeReportId } from './id.ts'
import { hashClient } from './clientHash.ts'
import { generateUploadToken, hashToken } from './uploadToken.ts'
import { sendNotification, type RawMailSender } from './email.ts'
import { verifyAccessJwt, type VerifyOptions } from './adminAuth.ts'
import { renderList, renderDetail, escapeHtml } from './adminPages.ts'
import type { BugIntakeEnv } from './types.ts'

/** The only origin admin mutation forms are ever legitimately submitted
 *  from — the admin pages themselves are served under this same origin. */
const ADMIN_ORIGIN = 'https://app.hew3d.com'

function jsonResponse(status: number, body: unknown, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extraHeaders },
  })
}

function htmlResponse(status: number, html: string, extraHeaders?: Record<string, string>): Response {
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders },
  })
}

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } })
}

function parseContentLength(header: string | null): number | null {
  if (header === null) return null
  const n = Number(header)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function indexStub(env: BugIntakeEnv) {
  return env.REPORT_INDEX.get(env.REPORT_INDEX.idFromName(INDEX_DO_NAME))
}

function dropStub(env: BugIntakeEnv, id: string) {
  return env.REPORT_DROP.get(env.REPORT_DROP.idFromName(id))
}

/** Unconditionally deletes a report's (possibly partial) `ReportDrop` and
 *  releases its `ReportIndex` reservation — the cleanup abandonment needs,
 *  at any point in the upload (docs/design/report-bug.md §4: "A 400 on a
 *  piece or commit abandons the upload at once"). Best-effort and swallows
 *  its own failures: if THIS throws, `ReportIndex`'s idle-upload backstop
 *  (`IDLE_PRUNE_TIMEOUT_MS`) is what eventually frees the reservation
 *  anyway, and surfacing a cleanup error instead of the original failure
 *  would only be more confusing.
 *
 *  UNCONDITIONAL is the important word: this destroys `id`'s `ReportDrop`
 *  no matter whose request triggered the call, with no token check of its
 *  own. Every call site below only reaches this AFTER a token has already
 *  been verified for `id` by the `ReportStore` call whose result triggered
 *  it (`putPiece`'s `'too-large'`/`'bytes-past-total'`, `commit`'s
 *  `'incomplete'`) — or, in `handleStart`, against an id this same request
 *  just generated and failed to ever store anything under, so there is
 *  nothing yet for a token to protect. An oversized `PIECE` body is
 *  DIFFERENT: it fails before any `ReportStore` call ever sees a token, so
 *  it goes through `ReportStore.abandon`/`ReportDrop.abandon` instead,
 *  which checks the token itself — see `handlePutPiece`. */
async function abandonUpload(env: BugIntakeEnv, id: string): Promise<void> {
  try {
    await dropStub(env, id).destroy()
  } catch (err) {
    console.error(`bug-intake: failed to delete abandoned drop ${id}:`, err)
  }
  try {
    await indexStub(env).deleteReport(id)
  } catch (err) {
    console.error(`bug-intake: failed to release reservation ${id}:`, err)
  }
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** `GET /report/` (also `/report`). */
export function handleIdentity(): Response {
  return jsonResponse(200, {
    service: 'hew-bug-intake',
    format: CONTRACT_FORMAT,
    maxBytes: MAX_UPLOAD_BYTES,
    pieceBytes: PIECE_BYTES,
  })
}

// ---------------------------------------------------------------------------
// START — POST /report/
// ---------------------------------------------------------------------------

/** `POST /report/` (also `/report`) — begins an upload with its first
 *  piece. Order, cheapest first: declared `Content-Length` for THIS piece
 *  (`411`/`413`); `Content-Type` (`400`); `Hew-Upload-Length` for the WHOLE
 *  report present, parseable, and within `MAX_UPLOAD_BYTES` (`400`/`413`);
 *  `IP_HASH_SECRET` configured (`503`); the piece body itself, read and
 *  bounded to `PIECE_BYTES` (`413`) and checked against the declared total
 *  (`400`); its decompressed head validated (`400` — `headScan.ts`, only
 *  this piece is ever decompressed). Only once ALL of that passes does the
 *  fused `ReportIndex.reserveReport` call happen (`429`/`507`), and only
 *  once THAT passes does the piece actually get written to a fresh
 *  `ReportDrop`. This order matches docs/design/report-bug.md §4 exactly:
 *  head validation before reservation, because by the time reservation
 *  happens this handler already knows the report's real
 *  `appVersion`/`platform`/description excerpt, so there's no placeholder
 *  metadata to fill in later the way single-request streaming needed. */
export async function handleStart(request: Request, env: BugIntakeEnv): Promise<Response> {
  const declaredPiece = parseContentLength(request.headers.get('content-length'))
  if (declaredPiece === null) {
    return jsonResponse(411, { error: 'length-required' })
  }
  if (declaredPiece > PIECE_BYTES) {
    return jsonResponse(413, { error: 'too-large', maxBytes: MAX_UPLOAD_BYTES })
  }

  const contentType = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (contentType !== 'application/gzip') {
    return jsonResponse(400, { error: 'invalid', message: 'Content-Type must be application/gzip' })
  }

  const declaredTotal = parseContentLength(request.headers.get('hew-upload-length'))
  if (declaredTotal === null || declaredTotal < 1) {
    return jsonResponse(400, { error: 'invalid', message: 'Hew-Upload-Length is missing or malformed' })
  }
  if (declaredTotal > MAX_UPLOAD_BYTES) {
    return jsonResponse(413, { error: 'too-large', maxBytes: MAX_UPLOAD_BYTES })
  }

  if (!env.IP_HASH_SECRET) {
    return jsonResponse(503, { error: 'unavailable' })
  }

  const piece = await readBodyCapped(request, PIECE_BYTES)
  if (piece === TOO_LARGE) {
    return jsonResponse(413, { error: 'too-large', maxBytes: MAX_UPLOAD_BYTES })
  }
  if (piece.byteLength === 0) {
    return jsonResponse(400, { error: 'invalid', message: 'body is empty' })
  }
  if (piece.byteLength > declaredTotal) {
    return jsonResponse(400, { error: 'invalid', message: 'the first piece is longer than the declared total' })
  }

  const validated = await decompressAndValidateHead(piece, piece.byteLength === declaredTotal)
  if (!validated.ok) {
    return jsonResponse(400, { error: 'invalid', message: validated.message })
  }
  const { description, appVersion, platform } = validated.fields

  const now = Date.now()
  const clientIp = request.headers.get('cf-connecting-ip') ?? ''
  const clientHash = await hashClient(env.IP_HASH_SECRET, clientIp, now)
  const index = indexStub(env)
  const id = generateReportId()

  let reservation: Awaited<ReturnType<typeof index.reserveReport>>
  try {
    reservation = await index.reserveReport(clientHash, now, {
      id,
      receivedAt: now,
      sizeBytes: declaredTotal,
      appVersion,
      platform,
      descriptionPreview: description.slice(0, 200),
    })
  } catch (err) {
    console.error('bug-intake: reserveReport failed:', err)
    return jsonResponse(503, { error: 'unavailable' })
  }

  if (!reservation.ok) {
    if (reservation.reason === 'rate-limited') {
      return jsonResponse(429, { error: 'rate-limited' }, { 'retry-after': String(Math.ceil(reservation.retryAfterMs / 1000)) })
    }
    return jsonResponse(507, { error: 'full' })
  }

  const token = generateUploadToken()
  const tokenHash = await hashToken(token)
  try {
    await dropStub(env, id).startUpload(id, declaredTotal, tokenHash, piece, { description, appVersion, platform })
  } catch (err) {
    console.error(`bug-intake: startUpload failed for ${id}:`, err)
    await abandonUpload(env, id)
    return jsonResponse(503, { error: 'unavailable' })
  }

  return jsonResponse(201, { id, token, pieceBytes: PIECE_BYTES })
}

// ---------------------------------------------------------------------------
// PIECE — PUT /report/<id>/<index>
// ---------------------------------------------------------------------------

/** `PUT /report/<id>/<index>` (index ≥ 1, enforced by the router before
 *  this is called). A piece over `PIECE_BYTES` is read (and thus known to
 *  be oversized) BEFORE `ReportStore.putPiece` ever gets to check the
 *  token, so this handler cannot lean on that call's own token check —
 *  unlike the `'too-large'`/`'bytes-past-total'` outcomes `putPiece` itself
 *  can return below, which it only reaches once ITS token check already
 *  passed. So an oversized body abandons the upload only through
 *  `ReportDrop.abandon`, which checks the presented token ITSELF before
 *  destroying anything: a report id is PUBLIC (a user pastes it into a
 *  GitHub issue), so it must never by itself be enough to delete someone
 *  else's report, committed or not — a tokenless or wrong-token oversized
 *  PUT leaves the target completely untouched (`403`), same as any other
 *  wrong-token request. Only a MATCHING token on a still-uncommitted
 *  upload actually abandons it (`400`); a matching token against a
 *  committed report, or an unknown one, answers `404`/`403` exactly like a
 *  normal-sized piece would. Missing/wrong token on a normal-sized piece —
 *  `ReportDrop.putPiece` compares its hash in constant time — never
 *  abandons anything either, for the same reason. */
export async function handlePutPiece(request: Request, env: BugIntakeEnv, id: string, index: number): Promise<Response> {
  const token = request.headers.get('hew-upload-token') ?? ''

  const piece = await readBodyCapped(request, PIECE_BYTES)
  if (piece === TOO_LARGE) {
    if (token === '') {
      return jsonResponse(403, { error: 'forbidden' })
    }
    const tokenHash = await hashToken(token)
    let abandonResult: Awaited<ReturnType<ReturnType<typeof dropStub>['abandon']>>
    try {
      abandonResult = await dropStub(env, id).abandon(tokenHash)
    } catch (err) {
      console.error(`bug-intake: abandon failed for oversized piece ${id}/${index}:`, err)
      return jsonResponse(503, { error: 'unavailable' })
    }
    if (!abandonResult.ok) {
      if (abandonResult.reason === 'not-found') return jsonResponse(404, { error: 'not-found' })
      return jsonResponse(403, { error: 'forbidden' })
    }
    try {
      await indexStub(env).deleteReport(id)
    } catch (err) {
      console.error(`bug-intake: failed to release reservation ${id}:`, err)
    }
    return jsonResponse(400, { error: 'invalid', message: `piece is over ${PIECE_BYTES} bytes` })
  }

  if (token === '') {
    return jsonResponse(403, { error: 'forbidden' })
  }
  const tokenHash = await hashToken(token)

  let result: Awaited<ReturnType<ReturnType<typeof dropStub>['putPiece']>>
  try {
    result = await dropStub(env, id).putPiece(index, tokenHash, piece)
  } catch (err) {
    console.error(`bug-intake: putPiece failed for ${id}/${index}:`, err)
    return jsonResponse(503, { error: 'unavailable' })
  }

  if (!result.ok) {
    switch (result.reason) {
      case 'not-found':
        return jsonResponse(404, { error: 'not-found' })
      case 'forbidden':
        return jsonResponse(403, { error: 'forbidden' })
      case 'too-large':
        // The token was already verified by `putPiece` itself above (it
        // checks `forbidden` before `too-large`) — unconditional cleanup is
        // safe here, unlike the pre-body-read case above.
        await abandonUpload(env, id)
        return jsonResponse(400, { error: 'invalid', message: `piece is over ${PIECE_BYTES} bytes` })
      case 'bytes-past-total':
        await abandonUpload(env, id)
        return jsonResponse(400, { error: 'invalid', message: 'bytes past the declared total' })
      case 'out-of-order':
        return jsonResponse(409, { error: 'out-of-order', expected: result.expected })
    }
  }

  if (result.stored) {
    try {
      await indexStub(env).touchActivity(id, Date.now())
    } catch (err) {
      // The piece is already safely stored; a failure to record activity
      // only risks the idle-prune backstop cleaning this up early — logged,
      // not surfaced, since the piece itself succeeded.
      console.error(`bug-intake: touchActivity failed for ${id}:`, err)
    }
  }
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
}

// ---------------------------------------------------------------------------
// COMMIT — POST /report/<id>/commit
// ---------------------------------------------------------------------------

/** `POST /report/<id>/commit`. Idempotent for the token holder:
 *  `ReportDrop.commit` itself answers `ok` again (with the same fields,
 *  never re-arming anything) for a drop that's already committed, as long
 *  as the token still matches — so a client that lost its `201` response
 *  (a dropped connection, a timeout) and retries lands on the same success
 *  rather than a `404` that would make it think the report never landed.
 *  What must NOT repeat on a retry is the maintainer notification email:
 *  `ReportIndex.commitReport` reports whether IT actually flipped the row
 *  from uncommitted to committed, and the email only goes out when it did
 *  — so a retry after `commitReport` itself failed the first time still
 *  sends exactly one email (this attempt flips it), and a retry after a
 *  fully successful first commit sends none (the row was already
 *  committed). */
export async function handleCommit(request: Request, env: BugIntakeEnv, id: string, mailer: RawMailSender): Promise<Response> {
  const token = request.headers.get('hew-upload-token') ?? ''
  if (token === '') {
    return jsonResponse(403, { error: 'forbidden' })
  }
  const tokenHash = await hashToken(token)

  let result: Awaited<ReturnType<ReturnType<typeof dropStub>['commit']>>
  try {
    result = await dropStub(env, id).commit(tokenHash)
  } catch (err) {
    console.error(`bug-intake: commit failed for ${id}:`, err)
    return jsonResponse(503, { error: 'unavailable' })
  }

  if (!result.ok) {
    if (result.reason === 'not-found') return jsonResponse(404, { error: 'not-found' })
    if (result.reason === 'forbidden') return jsonResponse(403, { error: 'forbidden' })
    // incomplete
    await abandonUpload(env, id)
    return jsonResponse(400, { error: 'invalid', message: 'fewer bytes arrived than declared' })
  }

  let outcome: Awaited<ReturnType<ReturnType<typeof indexStub>['commitReport']>>
  try {
    outcome = await indexStub(env).commitReport(id)
  } catch (err) {
    // The drop is already committed and its bytes are safe — this only
    // means the admin index doesn't know it yet. See handlers.ts's design
    // note (README "Chunked upload"): there is no two-phase commit across
    // the two DOs here, and this narrow, rare inconsistency window is an
    // accepted tradeoff rather than a full protocol for closing it. A
    // client retry lands here again and (this time, if `commitReport`
    // succeeds) both flips the row and sends the notification email.
    console.error(`bug-intake: ReportIndex.commitReport failed for ${id} after a successful drop commit:`, err)
    return jsonResponse(503, { error: 'unavailable' })
  }

  if (outcome === 'not-found') {
    // Genuinely abnormal: the drop just committed successfully, but
    // `ReportIndex` has no row for it (an admin delete racing this
    // request, say). Never silently answer 201 for a report the index no
    // longer knows about.
    console.error(`bug-intake: ReportIndex has no row for ${id} after a successful drop commit`)
    return jsonResponse(503, { error: 'unavailable' })
  }

  if (outcome === 'flipped') {
    // Best-effort and genuinely never throws (see `sendNotification`'s
    // doc) — the report is already committed and durably stored by this
    // point (§8). Sent only on the call that actually flipped the index
    // row, so a retry never sends a second email.
    await sendNotification(
      env,
      { id, appVersion: result.appVersion, platform: result.platform, description: result.description, sizeBytes: result.sizeBytes },
      mailer,
    )
  }

  return jsonResponse(201, { id })
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

/** Verifies the Access JWT on the request, or `null` on any failure — see
 *  `adminAuth.ts` for why every failure mode collapses to the same
 *  outcome. `authOptions` is threaded through from `handleRequest` purely so
 *  tests can inject a fake JWKS fetch and a fixed clock; production
 *  (`index.ts`) never passes it, so `verifyAccessJwt` falls back to its
 *  real default cache and `Date.now()`. */
async function requireAdmin(request: Request, env: BugIntakeEnv, authOptions: VerifyOptions): Promise<boolean> {
  const token = request.headers.get('cf-access-jwt-assertion') ?? ''
  const payload = await verifyAccessJwt(token, env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD, authOptions)
  return payload !== null
}

function forbidden(): Response {
  return new Response('Forbidden', { status: 403, headers: { 'cache-control': 'no-store' } })
}

function methodNotAllowed(): Response {
  return new Response(null, { status: 405, headers: { 'cache-control': 'no-store' } })
}

/** A post-mutation redirect (`Response.redirect` sets no headers of its
 *  own beyond `Location`) — every response from this Worker carries
 *  `Cache-Control: no-store`, redirects included. */
function redirectNoStore(location: string, status: 303): Response {
  return new Response(null, { status, headers: { location, 'cache-control': 'no-store' } })
}

const ADMIN_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'"

function adminHtml(status: number, html: string): Response {
  return htmlResponse(status, html, { 'content-security-policy': ADMIN_CSP })
}

/** Rejects a mutating admin request whose `Origin` isn't the admin page's
 *  own origin — defense in depth alongside Cloudflare Access, same posture
 *  as `adminAuth.ts`'s fail-closed JWT check. Missing `Origin` is also
 *  rejected: every browser that can submit these forms sends one. */
function originAllowed(request: Request): boolean {
  return request.headers.get('origin') === ADMIN_ORIGIN
}

async function handleAdminList(env: BugIntakeEnv): Promise<Response> {
  const reports = await indexStub(env).listReports()
  return adminHtml(200, renderList(reports))
}

/** Reads and decompresses just piece 0 of a report's HEAD, for the detail
 *  page — never the whole bundle: unlike the old `readFullBundle`/`gunzip`
 *  path (up to ~2x the report's memory, and a full decompression that
 *  could run well past a report's compressed size — the design's worked
 *  example, 210.9 MB from 59.9 MB), this reads one stored row and
 *  decompresses at most `HeadDecompressor`'s bounded budget, the same one
 *  `handleStart`'s own head scan uses. `isFinalPiece` mirrors
 *  `decompressAndValidateHead`'s call in `handleStart`: `true` only when
 *  the whole report is a single piece, so a genuinely truncated (more
 *  pieces exist) piece 0 is never handed to the decompressor as if it were
 *  gzip's true end (see `HeadDecompressor.finish`'s doc for why that
 *  distinction matters). Returns `null` for a report with no piece 0 at
 *  all, or if decompression errors; never throws. */
async function readHeadForDisplay(env: BugIntakeEnv, id: string): Promise<string | null> {
  const stub = dropStub(env, id)
  const head = await stub.head()
  if (head === null) return null
  const pieces = await stub.read(0, 1)
  if (pieces.length === 0) return null
  const decompressor = new HeadDecompressor()
  await decompressor.write(pieces[0])
  const { text, errored } = await decompressor.finish(head.pieceCount === 1)
  return errored ? null : text
}

async function handleAdminDetail(env: BugIntakeEnv, id: string): Promise<Response> {
  const entry = await indexStub(env).getReport(id)
  // A reservation still uploading (or one abandoned and not yet pruned) is
  // treated exactly like an unknown id — it isn't a real report yet.
  if (entry === null || !entry.committed) return adminHtml(404, `<p>No report ${escapeHtml(id)}.</p>`)
  let head = null
  try {
    const text = await readHeadForDisplay(env, id)
    if (text !== null) head = parseHeadForDisplay(text)
  } catch (err) {
    console.error(`bug-intake: failed to read/decompress report ${id}'s head for detail view:`, err)
  }
  return adminHtml(200, renderDetail(entry, head))
}

async function handleAdminDownload(env: BugIntakeEnv, id: string): Promise<Response> {
  const entry = await indexStub(env).getReport(id)
  if (entry === null || !entry.committed) return notFound()
  const stub = dropStub(env, id)
  const dropHead = await stub.head()
  if (dropHead === null) return notFound()
  // Streamed straight out of the `ReportDrop`, one piece row at a time
  // (`ReportStore.readStream`) — never read into memory whole. Served
  // exactly as stored — still gzip-compressed (docs/design/report-bug.md
  // §4 "Admin page"); the maintainer's tooling decompresses it, same as the
  // client did before upload.
  const stream = await stub.readStream()
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'application/gzip',
      'content-disposition': `attachment; filename="${id}.json.gz"`,
      'content-length': String(dropHead.totalBytes),
      'cache-control': 'no-store',
    },
  })
}

async function handleAdminDelete(request: Request, env: BugIntakeEnv, id: string): Promise<Response> {
  if (!originAllowed(request)) return forbidden()
  await dropStub(env, id).destroy()
  await indexStub(env).deleteReport(id)
  return redirectNoStore(`${ADMIN_ORIGIN}/report/admin/`, 303)
}

async function handleAdminTriage(request: Request, env: BugIntakeEnv, id: string): Promise<Response> {
  if (!originAllowed(request)) return forbidden()
  const index = indexStub(env)
  const entry = await index.getReport(id)
  if (entry === null || !entry.committed) return notFound()
  await index.setTriaged(id, !entry.triaged)
  return redirectNoStore(`${ADMIN_ORIGIN}/report/admin/${id}`, 303)
}

async function routeAdmin(
  request: Request,
  env: BugIntakeEnv,
  rest: string,
  authOptions: VerifyOptions,
): Promise<Response> {
  if (!(await requireAdmin(request, env, authOptions))) return forbidden()

  if (rest === '' || rest === '/') {
    if (request.method !== 'GET') return methodNotAllowed()
    return handleAdminList(env)
  }

  const segments = rest.replace(/^\//, '').split('/')
  const rawId = segments[0]
  if (!isValidReportId(rawId)) return notFound()
  const id = normalizeReportId(rawId)

  if (segments.length === 1) {
    if (request.method !== 'GET') return methodNotAllowed()
    return handleAdminDetail(env, id)
  }
  if (segments.length === 2) {
    const action = segments[1]
    if (action === 'download' && request.method === 'GET') return handleAdminDownload(env, id)
    if (action === 'delete' && request.method === 'POST') return handleAdminDelete(request, env, id)
    if (action === 'triage' && request.method === 'POST') return handleAdminTriage(request, env, id)
  }
  return notFound()
}

// ---------------------------------------------------------------------------
// Top-level dispatch
// ---------------------------------------------------------------------------

const ADMIN_PREFIX = '/report/admin'
const REPORT_PREFIX = '/report/'

async function handleRequestInner(
  request: Request,
  env: BugIntakeEnv,
  mailer: RawMailSender,
  authOptions: VerifyOptions,
  pathname: string,
): Promise<Response> {
  if (pathname === '/report' || pathname === '/report/') {
    if (request.method === 'GET') return handleIdentity()
    if (request.method === 'POST') return handleStart(request, env)
    return methodNotAllowed()
  }

  if (pathname === ADMIN_PREFIX || pathname.startsWith(`${ADMIN_PREFIX}/`)) {
    const rest = pathname.slice(ADMIN_PREFIX.length)
    return routeAdmin(request, env, rest, authOptions)
  }

  if (pathname.startsWith(REPORT_PREFIX)) {
    const rest = pathname.slice(REPORT_PREFIX.length) // "<id>/<index-or-commit>"
    const segments = rest.split('/')
    if (segments.length === 2) {
      const [rawId, action] = segments
      if (isValidReportId(rawId)) {
        const id = normalizeReportId(rawId)
        if (action === 'commit') {
          if (request.method === 'POST') return handleCommit(request, env, id, mailer)
          return methodNotAllowed()
        }
        if (/^[1-9][0-9]*$/.test(action)) {
          if (request.method === 'PUT') return handlePutPiece(request, env, id, Number(action))
          return methodNotAllowed()
        }
      }
    }
  }

  return notFound()
}

/** The single entry point `index.ts`'s `fetch` calls. Every route handler
 *  above already catches the Durable Object errors it can anticipate; this
 *  wrapper is the backstop for anything that slips past those — a bug in
 *  code that didn't anticipate a particular failure, not a substitute for
 *  handling errors closer to where they happen. §8 requires every failure
 *  to end in `{"error":"unavailable"}` with `Cache-Control: no-store`, not
 *  a raw, uncaught-exception response with neither; an admin-path request
 *  gets a plain-text 503 instead of that JSON shape (nothing on
 *  `/report/admin/*` speaks the §8 JSON contract), but the same status and
 *  no-store header. */
export async function handleRequest(
  request: Request,
  env: BugIntakeEnv,
  mailer: RawMailSender,
  authOptions: VerifyOptions = {},
): Promise<Response> {
  const pathname = new URL(request.url).pathname
  try {
    return await handleRequestInner(request, env, mailer, authOptions, pathname)
  } catch (err) {
    console.error('bug-intake: unhandled error', err)
    if (pathname === ADMIN_PREFIX || pathname.startsWith(`${ADMIN_PREFIX}/`)) {
      return new Response('Service unavailable', { status: 503, headers: { 'cache-control': 'no-store' } })
    }
    return jsonResponse(503, { error: 'unavailable' })
  }
}
