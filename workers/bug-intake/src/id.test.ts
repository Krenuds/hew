import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { generateReportId, isValidReportId, normalizeReportId } from './id.ts'

describe('generateReportId', () => {
  test('matches HEW-XXXX-XXXX, Crockford base32, uppercase', () => {
    for (let i = 0; i < 200; i++) {
      const id = generateReportId()
      assert.match(id, /^HEW-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
      assert.equal(id, id.toUpperCase())
    }
  })

  test('excludes ambiguous Crockford letters I, L, O, U', () => {
    for (let i = 0; i < 500; i++) {
      const id = generateReportId()
      assert.doesNotMatch(id.slice(4), /[ILOU]/)
    }
  })

  test('is not trivially repeating', () => {
    const ids = new Set(Array.from({ length: 200 }, () => generateReportId()))
    assert.equal(ids.size, 200)
  })
})

describe('isValidReportId', () => {
  test('accepts a generated id and its lowercase form', () => {
    const id = generateReportId()
    assert.ok(isValidReportId(id))
    assert.ok(isValidReportId(id.toLowerCase()))
  })

  test('rejects malformed ids', () => {
    assert.equal(isValidReportId(''), false)
    assert.equal(isValidReportId('HEW-1234-567'), false)
    assert.equal(isValidReportId('HEW12345678'), false)
    assert.equal(isValidReportId('XXX-1234-5678'), false)
    assert.equal(isValidReportId('HEW-1234-56789'), false)
    assert.equal(isValidReportId('HEW-ILOU-1234'), false) // ambiguous letters never valid
    assert.equal(isValidReportId("HEW-1234-5678'; DROP TABLE reports;--"), false)
  })
})

describe('normalizeReportId', () => {
  test('upper-cases', () => {
    assert.equal(normalizeReportId('hew-ab12-cd34'), 'HEW-AB12-CD34')
  })
})
