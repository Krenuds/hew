/**
 * The maintainer notification email — one per stored report, sent through
 * the `send_email` binding (`wrangler.toml`'s `NOTIFY`, no destination
 * address: the recipient comes from the `NOTIFY_TO` secret at send time —
 * docs/design/report-bug.md §8). Builds the legacy `EmailMessage`/raw-MIME
 * payload (`cloudflare:email`) rather than using the newer
 * `env.NOTIFY.send({...})` convenience API: that surface belongs to the
 * separate "Email Sending" product, which onboards a domain independently
 * and isn't what this design's `send_email` binding + Email Routing
 * verified-destination setup (README.md's deploy checklist) targets. One
 * plain-text part, no HTML, no attachments — hand-building the handful of
 * MIME header lines is simpler than a dependency (`mimetext`) for a
 * single-part UTF-8 text message.
 *
 * This module is framework-free on purpose: constructing the real
 * `EmailMessage` requires `import ... from 'cloudflare:email'`, a module
 * bare `node --test` cannot resolve — the same constraint that splits
 * share-relay's `ShareDrop` (needs `cloudflare:workers`) from its
 * unit-tested `DropStore`. `sendNotification` below takes a `RawMailSender`
 * instead of importing `cloudflare:email` itself; `emailMailer.ts` is the
 * one file that does that import, and it's wired in only by `index.ts` —
 * never by a test file.
 *
 * A failed or skipped send never fails the request that triggered it:
 * `sendNotification`'s caller (`handlers.ts`) always awaits this AFTER the
 * report is already durably stored, and only logs the outcome.
 */

import { INDEX_DO_NAME } from './constants.ts'
import type { BugIntakeEnv } from './types.ts'

export interface NotifyReport {
  id: string
  appVersion: string
  platform: string
  description: string
  sizeBytes: number
}

/** The seam between this module and the real `cloudflare:email` API —
 *  `emailMailer.ts` implements this over `EmailMessage`/`env.NOTIFY`; tests
 *  implement it as a plain recording/throwing fake. */
export interface RawMailSender {
  send(from: string, to: string, rawMime: string): Promise<void>
}

/** Strips CR/LF from a value before it lands in a header — the only
 *  header-injection surface here, since `appVersion`/`platform` are
 *  attacker-controlled JSON fields and ride the Subject line. The body
 *  (which carries the raw description verbatim) needs no such treatment: a
 *  MIME parser never resumes reading headers after the blank line that ends
 *  them, so nothing in the body can inject a header no matter what it
 *  contains. */
export function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** `system` is optional (a user can untick "App version and system"
 *  entirely — docs/design/report-bug.md §2), so `report.appVersion`/
 *  `.platform` arrive as empty strings from `headScan.ts` when it was
 *  omitted; this is where that becomes "unknown" for a human reader. */
function orUnknown(value: string): string {
  return value.length > 0 ? value : 'unknown'
}

export function buildNotificationMime(report: NotifyReport, from: string, to: string): string {
  const appVersion = orUnknown(report.appVersion)
  const platform = orUnknown(report.platform)
  const subject = `[Hew bug report] ${report.id} — ${sanitizeHeaderValue(appVersion)} / ${sanitizeHeaderValue(platform)}`
  const adminLink = `https://app.hew3d.com/report/admin/${report.id}`
  const body = [
    `Report ${report.id}`,
    ``,
    `App version: ${appVersion}`,
    `Platform: ${platform}`,
    `Compressed size: ${formatBytes(report.sizeBytes)}`,
    ``,
    `Description:`,
    report.description,
    ``,
    `Admin: ${adminLink}`,
    ``,
  ].join('\r\n')

  const headers = [
    `From: Hew Bug Intake <${from}>`,
    `To: <${to}>`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset="utf-8"`,
    `Content-Transfer-Encoding: 8bit`,
    `Date: ${new Date().toUTCString()}`,
  ].join('\r\n')

  return `${headers}\r\n\r\n${body}`
}

/** Sends the notification, or skips it — GENUINELY never throws: the whole
 *  body runs inside one try/catch, not just the `mailer.send` call, because
 *  `index.reserveEmail` below is a Durable Object RPC exactly like any
 *  other and can fail the same ways (a transient fault, a free-tier limit).
 *  This function's caller (`handlers.ts`) runs it AFTER the report is
 *  already committed and durably stored — an exception escaping from here
 *  would turn an already-successful submission into a failed response,
 *  which is exactly the bug this guards against (§8: "A failed notification
 *  email doesn't fail the request"). Returns whether an email actually went
 *  out, purely for the caller's own logging/tests. Order: missing
 *  `NOTIFY_TO`/`NOTIFY_FROM` skips before ever touching `ReportIndex`'s
 *  email counter; a reached daily cap skips after (the report itself is
 *  unaffected either way — it's already stored by the time this runs). */
export async function sendNotification(env: BugIntakeEnv, report: NotifyReport, mailer: RawMailSender): Promise<boolean> {
  try {
    const to = env.NOTIFY_TO
    const from = env.NOTIFY_FROM
    if (!to || !from) {
      console.log(`bug-intake: skipping notification for ${report.id}: NOTIFY_TO/NOTIFY_FROM not configured`)
      return false
    }

    const index = env.REPORT_INDEX.get(env.REPORT_INDEX.idFromName(INDEX_DO_NAME))
    const reserved = await index.reserveEmail(Date.now())
    if (!reserved) {
      console.log(`bug-intake: skipping notification for ${report.id}: daily email cap reached`)
      return false
    }

    const raw = buildNotificationMime(report, from, to)
    await mailer.send(from, to, raw)
    return true
  } catch (err) {
    console.error(`bug-intake: notification email failed for ${report.id}:`, err)
    return false
  }
}
