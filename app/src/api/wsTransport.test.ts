// @vitest-environment jsdom
//
// `wsTransport.ts` builds its socket URL from `window.location`, so this
// `.test.ts` opts into jsdom explicitly — the same pragma liveBridge.test.ts
// carries, and for the same reason (vitest.config.ts only routes `.test.tsx`
// to jsdom by default).

/**
 * The hosted web build's live transport (docs/agents/HEW_API.md §11.5).
 *
 * A real bridge is out of reach here; what is covered is the transport's own
 * logic against a fake `fetch` and a fake socket — the session-token
 * handshake, the four message shapes, reply framing, reconnect-versus-give-up,
 * and the one thing that is easy to get wrong: a dropped socket has to tell
 * `liveBridge.ts` that every connection on it is gone, or each drop leaks a
 * wasm connection.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest'
import { createWebSocketTransport, type WebSocketLike } from './wsTransport'
import { getRemoteControlStatus, setRemoteControlStatus } from './remoteControlStatus'

class FakeSocket implements WebSocketLike {
  sent: string[] = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
  }

  /** Drives the bridge's side of the wire. */
  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
}

let sockets: FakeSocket[] = []

function tokenFetch(token: string | null, status = 200): typeof fetch {
  return vi.fn(() =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(token === null ? {} : { token }),
    } as Response),
  ) as unknown as typeof fetch
}

function build(fetchImpl: typeof fetch, reconnectDelayMs = 10) {
  return createWebSocketTransport({
    fetchImpl,
    socketFactory: (url) => {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket
    },
    reconnectDelayMs,
  })
}

/** The transport's connect is async (a fetch, then a socket); poll rather
 * than count microtask turns. */
async function socketCount(n: number): Promise<FakeSocket> {
  await vi.waitFor(() => {
    if (sockets.length < n) throw new Error(`only ${sockets.length} sockets so far`)
  })
  return sockets[n - 1]
}

beforeEach(() => {
  sockets = []
  // The status observable is module state shared by every test here.
  setRemoteControlStatus({ kind: 'off' })
})

describe('createWebSocketTransport', () => {
  it('fetches the session token and sends it as the first message', async () => {
    const fetchImpl = tokenFetch('s3cret')
    const transport = build(fetchImpl)
    const socket = await socketCount(1)

    expect(fetchImpl).toHaveBeenCalledWith('/bridge/session', { credentials: 'same-origin' })
    expect(socket.url).toMatch(/^ws:\/\/[^/]+\/bridge\/ws$/)
    expect(socket.sent).toEqual([])

    socket.onopen?.()
    expect(JSON.parse(socket.sent[0])).toEqual({ type: 'hello', token: 's3cret' })
    expect(getRemoteControlStatus()).toEqual({ kind: 'connected' })

    transport.close()
    expect(socket.closed).toBe(true)
    expect(getRemoteControlStatus()).toEqual({ kind: 'off' })
  })

  it('routes the bridge\'s three message shapes to the bridge handlers', async () => {
    const transport = build(tokenFetch('t'))
    const opened: number[] = []
    const closed: number[] = []
    const frames: Array<[number, string]> = []
    transport.onConnectionOpen((id) => opened.push(id))
    transport.onConnectionClose((id) => closed.push(id))
    transport.onFrame((id, frame) => frames.push([id, frame]))

    const socket = await socketCount(1)
    socket.onopen?.()
    socket.receive({ type: 'open', connId: 4 })
    socket.receive({ type: 'frame', connId: 4, frame: '{"id":1,"method":"hew.query.scene"}' })
    socket.receive({ type: 'close', connId: 4 })

    expect(opened).toEqual([4])
    expect(frames).toEqual([[4, '{"id":1,"method":"hew.query.scene"}']])
    expect(closed).toEqual([4])

    transport.sendReply(4, '{"id":1,"result":{}}')
    expect(JSON.parse(socket.sent[1])).toEqual({
      type: 'reply',
      connId: 4,
      frame: '{"id":1,"result":{}}',
    })

    transport.close()
  })

  it('a dropped socket closes every connection it was carrying', async () => {
    const transport = build(tokenFetch('t'))
    const closed: number[] = []
    transport.onConnectionClose((id) => closed.push(id))

    const socket = await socketCount(1)
    socket.onopen?.()
    socket.receive({ type: 'open', connId: 1 })
    socket.receive({ type: 'open', connId: 2 })
    socket.onclose?.()

    // Without this, liveBridge.ts keeps a wasm connection open per dropped
    // socket for the life of the tab.
    expect(closed.sort()).toEqual([1, 2])
    transport.close()
  })

  it('reconnects after a drop', async () => {
    const transport = build(tokenFetch('t'))
    const first = await socketCount(1)
    first.onopen?.()
    first.onclose?.()
    const second = await socketCount(2)
    expect(second).not.toBe(first)
    transport.close()
  })

  it('stops retrying once the bridge refuses — another tab owns the document now', async () => {
    const transport = build(tokenFetch('t'))
    const socket = await socketCount(1)
    socket.onopen?.()
    socket.receive({
      type: 'refused',
      code: 'session_taken',
      message: 'another tab took remote control of this bridge',
    })
    expect(getRemoteControlStatus()).toEqual({
      kind: 'refused',
      message: 'another tab took remote control of this bridge',
    })

    socket.onclose?.()
    // A retry here would be two tabs taking the session from each other
    // forever.
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(sockets).toHaveLength(1)
    transport.close()
  })

  it('reports an unreachable or unauthorized bridge rather than opening a socket', async () => {
    const transport = build(tokenFetch(null, 403), 10_000)
    await vi.waitFor(() => {
      if (getRemoteControlStatus().kind !== 'unavailable') throw new Error('not yet')
    })
    expect(sockets).toHaveLength(0)
    expect(getRemoteControlStatus()).toMatchObject({ kind: 'unavailable' })
    transport.close()
  })

  it('ignores a message it cannot read instead of throwing into the socket handler', async () => {
    const transport = build(tokenFetch('t'))
    const frames: string[] = []
    transport.onFrame((_, frame) => frames.push(frame))
    const socket = await socketCount(1)
    socket.onopen?.()

    socket.onmessage?.({ data: 'not json' })
    socket.onmessage?.({ data: new ArrayBuffer(4) })
    socket.receive({ type: 'frame' })
    socket.receive({ type: 'frame', connId: 'four', frame: 'x' })
    socket.receive({ type: 'something-else', connId: 1 })

    expect(frames).toEqual([])
    transport.close()
  })
})
