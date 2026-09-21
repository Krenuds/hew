/**
 * The hosted web build's live transport (docs/agents/HEW_API.md §11.5): a
 * WebSocket to `crates/hew-bridge`, on this app's own origin under
 * `/bridge`, implementing the same `LiveTransport` interface the desktop's
 * Tauri events do. Everything above it — connection bookkeeping, dispatch,
 * the refresh-after-mutation contract — is `liveBridge.ts` and is unchanged.
 *
 * Two messages open a session:
 *
 *   GET  /bridge/session   ->  { token }   (Access-authenticated)
 *   ws   /bridge/ws        <-  { type: 'hello', token }
 *
 * and after that the bridge pushes `open` / `frame` / `close`, this sends
 * `reply`, and `refused` ends the session with a reason. Same origin, so
 * `shells/web/inject-csp.mjs`'s `connect-src 'self'` already admits the
 * `wss://` with no CSP change.
 *
 * Creating a transport is the invasive act, so nothing here runs on its own:
 * `App.tsx` builds one only when the user turns on Remote Control
 * (settings/remoteControl.ts), and `close()` is what revoking consent calls.
 */

import type { LiveTransport } from './liveBridge'
import {
  getRemoteControlStatus,
  setRemoteControlStatus as setStatus,
  type RemoteControlStatus,
} from './remoteControlStatus'

/** The bit of `WebSocket` this module uses — named so a test can hand in a
 * fake without a real socket, exactly as `liveBridge.test.ts` hands
 * `installLiveBridge` a fake transport. */
export interface WebSocketLike {
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
}

export interface WebSocketTransportOptions {
  /** The bridge's prefix on this origin. Only a test or an unusual deploy
   * changes it; the shipped nginx and vite proxies both use `/bridge`. */
  base?: string
  fetchImpl?: typeof fetch
  socketFactory?: (url: string) => WebSocketLike
  /** First reconnect delay; each further attempt doubles it up to
   * `MAX_RECONNECT_MS`. */
  reconnectDelayMs?: number
}

const DEFAULT_BASE = '/bridge'
const DEFAULT_RECONNECT_MS = 1000
const MAX_RECONNECT_MS = 30_000

/** A session token is a secret; a failed fetch must not put the response
 * body (which could be an HTML login page) anywhere a user reads it. */
function unavailable(message: string): RemoteControlStatus {
  return { kind: 'unavailable', message }
}

function socketUrl(base: string): string {
  const url = new URL(`${base}/ws`, window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

/**
 * Opens a live session against the bridge and returns the transport
 * `installLiveBridge` drives. The connect happens in the background: the
 * returned transport is usable immediately and simply carries nothing until
 * the socket is up, which is the same shape the Tauri transport has.
 *
 * Reconnects with backoff while the wire merely drops (a tunnel blip, a
 * bridge restart), and stops permanently once the bridge REFUSES — a
 * refusal means another tab owns the document now, and a retry loop would
 * be two tabs taking the session from each other forever.
 */
export function createWebSocketTransport(options: WebSocketTransportOptions = {}): LiveTransport {
  const base = options.base ?? DEFAULT_BASE
  const doFetch = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
  const makeSocket = options.socketFactory ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike)
  const firstDelay = options.reconnectDelayMs ?? DEFAULT_RECONNECT_MS

  let openCb: (connId: number) => void = () => {}
  let closeCb: (connId: number) => void = () => {}
  let frameCb: (connId: number, frame: string) => void = () => {}

  let socket: WebSocketLike | null = null
  let closed = false
  let retryDelay = firstDelay
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  /** Which connections the bridge told us about and we have not been told
   * closed. A socket that drops takes every one of them with it, and
   * `liveBridge.ts` must hear about that or it leaks a wasm connection per
   * dropped socket. */
  const liveConns = new Set<number>()

  const dropAllConnections = (): void => {
    for (const connId of liveConns) closeCb(connId)
    liveConns.clear()
  }

  const scheduleRetry = (): void => {
    if (closed) return
    retryTimer = setTimeout(() => {
      void connect()
    }, retryDelay)
    retryDelay = Math.min(retryDelay * 2, MAX_RECONNECT_MS)
  }

  const handleMessage = (raw: unknown): void => {
    if (typeof raw !== 'string') return // binary is not part of this transport (§11.5)
    let message: { type?: unknown; connId?: unknown; frame?: unknown; message?: unknown }
    try {
      message = JSON.parse(raw) as typeof message
    } catch {
      return
    }
    const connId = typeof message.connId === 'number' ? message.connId : null
    switch (message.type) {
      case 'open':
        if (connId === null) return
        liveConns.add(connId)
        openCb(connId)
        return
      case 'frame':
        if (connId === null || typeof message.frame !== 'string') return
        frameCb(connId, message.frame)
        return
      case 'close':
        if (connId === null) return
        liveConns.delete(connId)
        closeCb(connId)
        return
      case 'refused': {
        const text =
          typeof message.message === 'string'
            ? message.message
            : 'the bridge refused this session'
        closed = true
        setStatus({ kind: 'refused', message: text })
        return
      }
      default:
        return
    }
  }

  const connect = async (): Promise<void> => {
    if (closed) return
    setStatus({ kind: 'connecting' })

    let token: string
    try {
      const response = await doFetch(`${base}/session`, { credentials: 'same-origin' })
      if (!response.ok) {
        setStatus(unavailable(`the bridge refused the session request (HTTP ${response.status})`))
        scheduleRetry()
        return
      }
      const body = (await response.json()) as { token?: unknown }
      if (typeof body.token !== 'string' || body.token === '') {
        setStatus(unavailable('the bridge answered without a session token'))
        scheduleRetry()
        return
      }
      token = body.token
    } catch {
      setStatus(unavailable('no bridge answered on this origin'))
      scheduleRetry()
      return
    }
    if (closed) return

    let ws: WebSocketLike
    try {
      ws = makeSocket(socketUrl(base))
    } catch {
      setStatus(unavailable('the bridge socket could not be opened'))
      scheduleRetry()
      return
    }
    socket = ws

    ws.onopen = () => {
      retryDelay = firstDelay
      ws.send(JSON.stringify({ type: 'hello', token }))
      setStatus({ kind: 'connected' })
    }
    ws.onmessage = (event) => handleMessage(event.data)
    ws.onerror = () => {
      /* `onclose` always follows; the reconnect decision lives there. */
    }
    ws.onclose = () => {
      if (socket === ws) socket = null
      dropAllConnections()
      if (closed) return
      if (getRemoteControlStatus().kind !== 'refused') setStatus({ kind: 'connecting' })
      scheduleRetry()
    }
  }

  void connect()

  return {
    onConnectionOpen(cb) {
      openCb = cb
    },
    onConnectionClose(cb) {
      closeCb = cb
    },
    onFrame(cb) {
      frameCb = cb
    },
    sendReply(connId, frame) {
      socket?.send(JSON.stringify({ type: 'reply', connId, frame }))
    },
    close() {
      closed = true
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      dropAllConnections()
      socket?.close()
      socket = null
      setStatus({ kind: 'off' })
    },
  }
}
