/**
 * Report IDs: `HEW-` plus 8 Crockford base32 characters from a CSPRNG,
 * grouped for display as `HEW-XXXX-XXXX` (docs/design/report-bug.md §8). An
 * ID identifies a report; it authorizes nothing (no public route reads by
 * ID), so it needs no cryptographic unguessability property beyond "not
 * trivially enumerable" — 8 Crockford characters is 40 bits.
 *
 * The grouped form is the canonical one everywhere in this Worker: it's
 * what `POST /report/` returns, what `ReportIndex` keys its rows on, what
 * names a report's `ReportDrop` (`idFromName`), and what appears in the
 * admin URL and the notification email's admin link. There is no
 * ungrouped form to keep in sync with it.
 */

/** Crockford base32: excludes I, L, O, U to avoid transcription mistakes
 *  (a user reading an ID aloud, or quoting one to request deletion). */
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Generates a fresh report ID: `HEW-XXXX-XXXX`. */
export function generateReportId(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  let chars = ''
  for (const b of bytes) chars += CROCKFORD_ALPHABET[b % CROCKFORD_ALPHABET.length]
  return `HEW-${chars.slice(0, 4)}-${chars.slice(4, 8)}`
}

/** Validates the canonical grouped form. Checked before ever touching a
 *  Durable Object — not a security boundary (a DO id derived from an
 *  arbitrary string is safe), just a cheap way to turn an obviously
 *  malformed admin URL or deletion request into a clean rejection instead
 *  of a pointless DO round trip. Case-insensitive on input; callers should
 *  normalize with `normalizeReportId` before comparing or storing. */
const REPORT_ID_RE = /^HEW-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/i

export function isValidReportId(id: string): boolean {
  return REPORT_ID_RE.test(id)
}

/** Upper-cases an ID for storage/lookup — a user quoting an ID (the
 *  deletion-request path in docs/design/report-bug.md §4) may well type it
 *  lowercase. */
export function normalizeReportId(id: string): string {
  return id.toUpperCase()
}
