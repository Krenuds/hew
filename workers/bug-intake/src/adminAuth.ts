/**
 * Verifies the `Cf-Access-Jwt-Assertion` header Cloudflare Access attaches
 * to every request that reaches `/report/admin/*` (docs/design/report-bug.md
 * §8 "Admin authorization"). Cloudflare Access itself already fronts the
 * route — this is defense in depth against a misconfigured or bypassed
 * Access application, so it fails closed: ANY problem (missing header, bad
 * signature, wrong issuer/audience, expired, unset `ACCESS_*` secrets)
 * collapses to the same "not authorized" at the call site (`handlers.ts`),
 * which turns it into a bare 403. There is deliberately no way to tell
 * those cases apart from the response — the failure mode this guards
 * against is exactly an attacker probing for which check to attack next.
 *
 * RS256 verified via WebCrypto against the team's JWKS
 * (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`), fetched
 * fresh and cached briefly per team domain (`JWKS_CACHE_MS`) so a normal
 * admin session doesn't re-fetch it on every click, while a key rotation on
 * Cloudflare's side still takes effect within minutes. The cache is a
 * factory (`createJwksCache`), not a bare module-level `Map`, so tests can
 * hand it a fake `fetch` without depending on real network access or
 * leaking state between cases.
 */

import { JWKS_CACHE_MS } from './constants.ts'

interface Jwk {
  kid: string
  kty: string
  n: string
  e: string
}

interface Jwks {
  keys: Jwk[]
}

export interface JwtPayload {
  iss?: unknown
  aud?: unknown
  exp?: unknown
  [key: string]: unknown
}

export type GetJwks = (teamDomain: string, now: number) => Promise<Jwks>

/** A fresh, independent JWKS cache — `now` is the caller's clock (real
 *  `Date.now()` in production, a fixed value in tests) rather than this
 *  function reading it itself, so cache-expiry tests don't need real time
 *  to pass. */
export function createJwksCache(fetchImpl: typeof fetch = fetch): GetJwks {
  const cache = new Map<string, { jwks: Jwks; fetchedAt: number }>()
  return async function getJwks(teamDomain: string, now: number): Promise<Jwks> {
    const cached = cache.get(teamDomain)
    if (cached && now - cached.fetchedAt < JWKS_CACHE_MS) return cached.jwks
    const res = await fetchImpl(`https://${teamDomain}/cdn-cgi/access/certs`)
    if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`)
    const jwks = (await res.json()) as Jwks
    cache.set(teamDomain, { jwks, fetchedAt: now })
    return jwks
  }
}

const defaultJwksCache = createJwksCache()

function base64UrlToBytes(s: string): Uint8Array {
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4)
  const bin = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function decodeJsonPart<T>(part: string): T {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(part))) as T
}

async function importVerifyKey(jwk: Jwk): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  )
}

export interface VerifyOptions {
  getJwks?: GetJwks
  now?: number
}

/** Verifies `token` against the configured team domain and audience.
 *  Returns the decoded payload on success, `null` on any failure. Either
 *  `teamDomain` or `aud` being unset (the `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD`
 *  secrets) is itself a failure — there is no "auth disabled" mode. */
export async function verifyAccessJwt(
  token: string,
  teamDomain: string | undefined,
  aud: string | undefined,
  options: VerifyOptions = {},
): Promise<JwtPayload | null> {
  if (!teamDomain || !aud || !token) return null
  const now = options.now ?? Date.now()
  const getJwks = options.getJwks ?? defaultJwksCache

  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [headerPart, payloadPart, sigPart] = parts

  let header: { alg?: unknown; kid?: unknown }
  let payload: JwtPayload
  try {
    header = decodeJsonPart(headerPart)
    payload = decodeJsonPart(payloadPart)
  } catch {
    return null
  }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null

  let jwks: Jwks
  try {
    jwks = await getJwks(teamDomain, now)
  } catch {
    return null
  }
  const jwk = jwks.keys.find((k) => k.kid === header.kid)
  if (!jwk) return null

  let key: CryptoKey
  try {
    key = await importVerifyKey(jwk)
  } catch {
    return null
  }

  const signingInput = new TextEncoder().encode(`${headerPart}.${payloadPart}`)
  let signatureValid: boolean
  try {
    signatureValid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64UrlToBytes(sigPart), signingInput)
  } catch {
    return null
  }
  if (!signatureValid) return null

  if (payload.iss !== `https://${teamDomain}`) return null
  const audList = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
  if (!audList.includes(aud)) return null
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now) return null

  return payload
}
