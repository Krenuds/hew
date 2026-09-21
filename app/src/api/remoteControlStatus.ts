/**
 * What the user is told about their remote-control session
 * (docs/agents/HEW_API.md §11.5) — one observable per tab, because a tab has
 * at most one bridge session.
 *
 * It lives here rather than inside `wsTransport.ts` so the two sides face
 * opposite directions and neither has to know the other: the transport is
 * the only thing that reports status, and the Settings panes are the only
 * things that read it. A module that both owned a global and built
 * transports would make the panes depend on the socket code to observe a
 * string.
 */

export type RemoteControlStatus =
  | { kind: 'off' }
  | { kind: 'connecting' }
  | { kind: 'connected' }
  /** The bridge refused this socket, or handed the session to another tab
   * (§11.5 "Ownership"). Terminal: the transport stops retrying, because
   * retrying would fight the tab that now owns the document. */
  | { kind: 'refused'; message: string }
  /** No bridge answered, or it answered with something other than a token —
   * typically no `hew-bridge` behind this origin, or the edge refused. */
  | { kind: 'unavailable'; message: string }

let status: RemoteControlStatus = { kind: 'off' }
const subscribers = new Set<(s: RemoteControlStatus) => void>()

export function getRemoteControlStatus(): RemoteControlStatus {
  return status
}

/** Subscribe to session status. Returns an unsubscribe fn. */
export function subscribeRemoteControlStatus(cb: (s: RemoteControlStatus) => void): () => void {
  subscribers.add(cb)
  return () => subscribers.delete(cb)
}

/** Report a new status. `wsTransport.ts` is the only production caller. */
export function setRemoteControlStatus(next: RemoteControlStatus): void {
  status = next
  for (const cb of subscribers) cb(next)
}
