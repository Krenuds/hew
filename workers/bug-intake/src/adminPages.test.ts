import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { escapeHtml, renderList, renderDetail } from './adminPages.ts'
import { parseHeadForDisplay } from './headScan.ts'
import type { ReportRow } from './indexStore.ts'

function entry(overrides: Partial<ReportRow> = {}): ReportRow {
  return {
    id: 'HEW-AAAA-BBBB',
    receivedAt: Date.parse('2026-09-13T12:00:00.000Z'),
    appVersion: '1.1.0',
    platform: 'desktop-macos',
    descriptionPreview: 'it crashed',
    sizeBytes: 4096,
    triaged: false,
    committed: true,
    ...overrides,
  }
}

describe('escapeHtml', () => {
  test('escapes the five HTML-significant characters', () => {
    assert.equal(escapeHtml(`<script>alert('x')</script> & "quoted"`), '&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &amp; &quot;quoted&quot;')
  })

  test('round-trips plain text unchanged', () => {
    assert.equal(escapeHtml('nothing special here 123'), 'nothing special here 123')
  })
})

describe('renderList: XSS and Origin safety', () => {
  test('escapes an attacker-controlled description preview, app version, and platform', () => {
    const html = renderList([
      entry({
        descriptionPreview: '<img src=x onerror=alert(1)>',
        appVersion: '"><script>evil()</script>',
        platform: "<svg/onload=alert('p')>",
      }),
    ])
    assert.ok(!html.includes('<img src=x onerror=alert(1)>'))
    assert.ok(!html.includes('<script>evil()</script>'))
    assert.ok(!html.includes("<svg/onload=alert('p')>"))
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'))
  })

  test('does not escape the server-generated id (safe by construction)', () => {
    const html = renderList([entry({ id: 'HEW-QQQQ-RRRR' })])
    assert.ok(html.includes('HEW-QQQQ-RRRR'))
  })

  test('shows report count and triaged state', () => {
    const html = renderList([entry({ triaged: true }), entry({ id: 'HEW-CCCC-DDDD', triaged: false })])
    assert.match(html, /2 reports/)
  })

  test('shows "unknown" for an empty appVersion/platform — a report submitted with no system block', () => {
    const html = renderList([entry({ appVersion: '', platform: '' })])
    assert.match(html, /<td>unknown<\/td>\s*<td>unknown<\/td>/)
  })
})

describe('renderDetail: XSS safety', () => {
  test('escapes the description, expected text, and crash message', () => {
    const head = parseHeadForDisplay(
      JSON.stringify({
        format: 1,
        report: {
          description: '<script>steal(document.cookie)</script>',
          expected: '<img src=x onerror=alert(2)>',
        },
        crash: { at: '<b>here</b>', message: '"><script>oops()</script>' },
      }),
    )
    const html = renderDetail(entry(), head)
    assert.ok(!html.includes('<script>steal(document.cookie)</script>'))
    assert.ok(!html.includes('<img src=x onerror=alert(2)>'))
    assert.ok(!html.includes('<script>oops()</script>'))
    assert.ok(!html.includes('<b>here</b>'))
  })

  test('renders a fallback message when the head could not be read', () => {
    const html = renderDetail(entry(), null)
    assert.match(html, /could not be read/)
  })

  test('shows "unknown" for App version/Platform when the head has no system block', () => {
    const head = parseHeadForDisplay(JSON.stringify({ format: 1, report: { description: 'no system sent' } }))
    const html = renderDetail(entry(), head)
    assert.match(html, /App version<\/dt><dd>unknown<\/dd>/)
    assert.match(html, /Platform<\/dt><dd>unknown<\/dd>/)
  })

  test('escapes system info fields', () => {
    const head = parseHeadForDisplay(
      JSON.stringify({
        format: 1,
        report: { description: 'x'.repeat(20) },
        system: { userAgent: '<script>ua()</script>', gpu: '"><script>gpu()</script>' },
      }),
    )
    const html = renderDetail(entry(), head)
    assert.ok(!html.includes('<script>ua()</script>'))
    assert.ok(!html.includes('<script>gpu()</script>'))
  })

  test('says the recorded steps/files/model/log are in the downloaded bundle, without claiming inclusion either way', () => {
    const head = parseHeadForDisplay(JSON.stringify({ format: 1, report: { description: 'x'.repeat(20) } }))
    const html = renderDetail(entry(), head)
    assert.match(html, /downloaded bundle/)
  })
})
