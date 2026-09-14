/**
 * `verifyAccessJwt` against real RS256 signatures — generated in-process
 * with WebCrypto (Node's global `crypto.subtle`) rather than any fixture,
 * so these tests prove the actual signature-verification code path, not a
 * mocked one. A fake `fetch` stands in for the JWKS endpoint; no network.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { createJwksCache, verifyAccessJwt } from './adminAuth.ts'

const TEAM_DOMAIN = 'hew-test.cloudflareaccess.com'
const AUD = 'test-audience-tag'
const KID = 'test-key-1'

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlJson(obj: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(obj)))
}

async function generateKeyPair() {
  return crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )
}

async function signToken(privateKey: CryptoKey, header: Record<string, unknown>, payload: Record<string, unknown>) {
  const headerPart = base64UrlJson(header)
  const payloadPart = base64UrlJson(payload)
  const signingInput = new TextEncoder().encode(`${headerPart}.${payloadPart}`)
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, signingInput)
  return `${headerPart}.${payloadPart}.${base64Url(new Uint8Array(signature))}`
}

async function makeJwks(publicKey: CryptoKey, kid: string) {
  const jwk = await crypto.subtle.exportKey('jwk', publicKey)
  return { keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] }
}

/** A `GetJwks` backed by a fixed in-memory JWKS document — bypasses
 *  `createJwksCache`'s fetch entirely for tests that don't care about
 *  caching behavior. */
function fixedJwks(jwks: { keys: unknown[] }) {
  return async () => jwks as never
}

const NOW = Date.parse('2026-09-13T12:00:00.000Z')
const NOW_S = Math.floor(NOW / 1000)

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    iss: `https://${TEAM_DOMAIN}`,
    aud: AUD,
    exp: NOW_S + 3600,
    iat: NOW_S,
    email: 'maintainer@example.com',
    ...overrides,
  }
}

describe('verifyAccessJwt', () => {
  test('accepts a validly signed, unexpired token with matching iss/aud', async () => {
    const { publicKey, privateKey } = await generateKeyPair()
    const jwks = await makeJwks(publicKey, KID)
    const token = await signToken(privateKey, { alg: 'RS256', kid: KID }, validPayload())

    const result = await verifyAccessJwt(token, TEAM_DOMAIN, AUD, { getJwks: fixedJwks(jwks), now: NOW })
    assert.ok(result !== null)
    assert.equal(result.iss, `https://${TEAM_DOMAIN}`)
  })

  test('rejects a token with the wrong audience', async () => {
    const { publicKey, privateKey } = await generateKeyPair()
    const jwks = await makeJwks(publicKey, KID)
    const token = await signToken(privateKey, { alg: 'RS256', kid: KID }, validPayload({ aud: 'some-other-app' }))

    const result = await verifyAccessJwt(token, TEAM_DOMAIN, AUD, { getJwks: fixedJwks(jwks), now: NOW })
    assert.equal(result, null)
  })

  test('accepts when aud is an array containing the configured audience', async () => {
    const { publicKey, privateKey } = await generateKeyPair()
    const jwks = await makeJwks(publicKey, KID)
    const token = await signToken(privateKey, { alg: 'RS256', kid: KID }, validPayload({ aud: ['other', AUD] }))

    const result = await verifyAccessJwt(token, TEAM_DOMAIN, AUD, { getJwks: fixedJwks(jwks), now: NOW })
    assert.ok(result !== null)
  })

  test('rejects a token with the wrong issuer', async () => {
    const { publicKey, privateKey } = await generateKeyPair()
    const jwks = await makeJwks(publicKey, KID)
    const token = await signToken(
      privateKey,
      { alg: 'RS256', kid: KID },
      validPayload({ iss: 'https://attacker.cloudflareaccess.com' }),
    )

    const result = await verifyAccessJwt(token, TEAM_DOMAIN, AUD, { getJwks: fixedJwks(jwks), now: NOW })
    assert.equal(result, null)
  })

  test('rejects an expired token', async () => {
    const { publicKey, privateKey } = await generateKeyPair()
    const jwks = await makeJwks(publicKey, KID)
    const token = await signToken(privateKey, { alg: 'RS256', kid: KID }, validPayload({ exp: NOW_S - 10 }))

    const result = await verifyAccessJwt(token, TEAM_DOMAIN, AUD, { getJwks: fixedJwks(jwks), now: NOW })
    assert.equal(result, null)
  })

  test('rejects a missing token', async () => {
    const result = await verifyAccessJwt('', TEAM_DOMAIN, AUD, { getJwks: fixedJwks({ keys: [] }), now: NOW })
    assert.equal(result, null)
  })

  test('rejects when ACCESS_TEAM_DOMAIN is unset', async () => {
    const { publicKey, privateKey } = await generateKeyPair()
    const jwks = await makeJwks(publicKey, KID)
    const token = await signToken(privateKey, { alg: 'RS256', kid: KID }, validPayload())

    const result = await verifyAccessJwt(token, undefined, AUD, { getJwks: fixedJwks(jwks), now: NOW })
    assert.equal(result, null)
  })

  test('rejects when ACCESS_AUD is unset', async () => {
    const { publicKey, privateKey } = await generateKeyPair()
    const jwks = await makeJwks(publicKey, KID)
    const token = await signToken(privateKey, { alg: 'RS256', kid: KID }, validPayload())

    const result = await verifyAccessJwt(token, TEAM_DOMAIN, undefined, { getJwks: fixedJwks(jwks), now: NOW })
    assert.equal(result, null)
  })

  test('rejects a token signed by a key not present in the JWKS (unknown kid)', async () => {
    const { publicKey: rightPublic } = await generateKeyPair()
    const { privateKey: wrongPrivate } = await generateKeyPair()
    const jwks = await makeJwks(rightPublic, KID)
    const token = await signToken(wrongPrivate, { alg: 'RS256', kid: 'a-different-kid' }, validPayload())

    const result = await verifyAccessJwt(token, TEAM_DOMAIN, AUD, { getJwks: fixedJwks(jwks), now: NOW })
    assert.equal(result, null)
  })

  test('rejects a token whose signature does not match the claimed kid (forged/tampered)', async () => {
    const { publicKey: rightPublic } = await generateKeyPair()
    const { privateKey: wrongPrivate } = await generateKeyPair()
    const jwks = await makeJwks(rightPublic, KID)
    // Signed by an attacker's key but claims the real kid — signature
    // verification against the real public key must fail.
    const token = await signToken(wrongPrivate, { alg: 'RS256', kid: KID }, validPayload())

    const result = await verifyAccessJwt(token, TEAM_DOMAIN, AUD, { getJwks: fixedJwks(jwks), now: NOW })
    assert.equal(result, null)
  })

  test('rejects a token with a tampered payload (signature no longer matches)', async () => {
    const { publicKey, privateKey } = await generateKeyPair()
    const jwks = await makeJwks(publicKey, KID)
    const token = await signToken(privateKey, { alg: 'RS256', kid: KID }, validPayload())
    const [h, , s] = token.split('.')
    const tamperedPayload = base64UrlJson(validPayload({ aud: 'escalated-audience' }))
    const tampered = `${h}.${tamperedPayload}.${s}`

    const result = await verifyAccessJwt(tampered, TEAM_DOMAIN, AUD, { getJwks: fixedJwks(jwks), now: NOW })
    assert.equal(result, null)
  })

  test('rejects a non-RS256 alg header', async () => {
    const { publicKey, privateKey } = await generateKeyPair()
    const jwks = await makeJwks(publicKey, KID)
    const token = await signToken(privateKey, { alg: 'none', kid: KID }, validPayload())

    const result = await verifyAccessJwt(token, TEAM_DOMAIN, AUD, { getJwks: fixedJwks(jwks), now: NOW })
    assert.equal(result, null)
  })

  test('rejects malformed tokens without throwing', async () => {
    for (const bad of ['not-a-jwt', 'a.b', 'a.b.c.d', '...']) {
      const result = await verifyAccessJwt(bad, TEAM_DOMAIN, AUD, { getJwks: fixedJwks({ keys: [] }), now: NOW })
      assert.equal(result, null)
    }
  })
})

describe('createJwksCache', () => {
  test('serves from cache within JWKS_CACHE_MS without a second fetch', async () => {
    let fetchCount = 0
    const fakeFetch = (async () => {
      fetchCount++
      return new Response(JSON.stringify({ keys: [] }), { status: 200 })
    }) as unknown as typeof fetch
    const getJwks = createJwksCache(fakeFetch)

    await getJwks(TEAM_DOMAIN, NOW)
    await getJwks(TEAM_DOMAIN, NOW + 1000)
    assert.equal(fetchCount, 1)
  })

  test('re-fetches once the cache entry is stale', async () => {
    let fetchCount = 0
    const fakeFetch = (async () => {
      fetchCount++
      return new Response(JSON.stringify({ keys: [] }), { status: 200 })
    }) as unknown as typeof fetch
    const getJwks = createJwksCache(fakeFetch)

    await getJwks(TEAM_DOMAIN, NOW)
    await getJwks(TEAM_DOMAIN, NOW + 10 * 60 * 1000) // well past JWKS_CACHE_MS (5 min)
    assert.equal(fetchCount, 2)
  })

  test('throws (verifyAccessJwt swallows it as a rejection) when the JWKS fetch fails', async () => {
    const fakeFetch = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    const getJwks = createJwksCache(fakeFetch)
    const result = await verifyAccessJwt('a.b.c', TEAM_DOMAIN, AUD, { getJwks, now: NOW })
    assert.equal(result, null)
  })
})
