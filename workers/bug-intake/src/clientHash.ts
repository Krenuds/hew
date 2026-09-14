/**
 * The per-client key rate limiting is counted against: SHA-256 of
 * `IP_HASH_SECRET + UTC date + client IP`, never the raw IP
 * (docs/design/report-bug.md §4 "Abuse", §8's `IP_HASH_SECRET`). Salting
 * with the secret makes the hash unreversible without it; including the
 * UTC date makes a client's hash change every day, which is also what lets
 * `indexStore.ts` treat "one row per client per day" as the natural key for
 * the daily counter instead of tracking a separate date column.
 */

function utcDateString(now: number): string {
  return new Date(now).toISOString().slice(0, 10) // "YYYY-MM-DD"
}

/** `ip` is whatever `CF-Connecting-IP` carried — never logged or stored by
 *  the caller, only ever passed straight in here. Returns a hex digest. */
export async function hashClient(secret: string, ip: string, now: number): Promise<string> {
  const data = new TextEncoder().encode(`${secret}|${utcDateString(now)}|${ip}`)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
