import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { hashClient } from './clientHash.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const day1 = Date.parse('2026-09-13T12:00:00.000Z')
const day2 = day1 + DAY_MS

describe('hashClient', () => {
  test('is deterministic for the same secret/ip/day', async () => {
    const a = await hashClient('secret', '203.0.113.7', day1)
    const b = await hashClient('secret', '203.0.113.7', day1 + 1000) // same UTC day
    assert.equal(a, b)
  })

  test('changes across a UTC day boundary', async () => {
    const a = await hashClient('secret', '203.0.113.7', day1)
    const b = await hashClient('secret', '203.0.113.7', day2)
    assert.notEqual(a, b)
  })

  test('changes with the secret', async () => {
    const a = await hashClient('secret-a', '203.0.113.7', day1)
    const b = await hashClient('secret-b', '203.0.113.7', day1)
    assert.notEqual(a, b)
  })

  test('changes with the IP', async () => {
    const a = await hashClient('secret', '203.0.113.7', day1)
    const b = await hashClient('secret', '203.0.113.8', day1)
    assert.notEqual(a, b)
  })

  test('never contains the raw IP as a substring', async () => {
    const ip = '203.0.113.7'
    const hash = await hashClient('secret', ip, day1)
    assert.ok(!hash.includes(ip))
    assert.match(hash, /^[0-9a-f]{64}$/) // hex SHA-256 digest, nothing else
  })
})
