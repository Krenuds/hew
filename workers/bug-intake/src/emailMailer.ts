/**
 * The real `RawMailSender` (`email.ts`), backed by the `cloudflare:email`
 * runtime module. Kept in its own file, imported only by `index.ts`
 * (never by `handlers.ts` or any test) — the same reason share-relay keeps
 * `ShareDrop` (needs `cloudflare:workers`) separate from the unit-tested
 * `DropStore`: a static `import ... from 'cloudflare:email'` fails to
 * resolve under bare `node --test`, so nothing reachable from a test file
 * may contain one.
 */

import { EmailMessage } from 'cloudflare:email'

import type { RawMailSender } from './email.ts'
import type { BugIntakeEnv } from './types.ts'

export function createMailer(env: BugIntakeEnv): RawMailSender {
  return {
    async send(from: string, to: string, rawMime: string): Promise<void> {
      await env.NOTIFY.send(new EmailMessage(from, to, rawMime))
    },
  }
}
