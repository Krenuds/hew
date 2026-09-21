# hew-bridge

Remote control for a hosted Hew web build: the daemon that lets
`hew-cli --live` drive the document in somebody's **browser tab**, the same
way it drives a running desktop app.

`hew-cli --live` normally finds a desktop instance through a discovery file
and speaks newline-delimited JSON-RPC to it over a unix socket
(`docs/agents/HEW_API.md` §11.2). A browser tab has no socket, so nothing
could reach it. This bridge closes that gap by **impersonating a desktop
instance on its local side** — it publishes the same discovery file and
serves the same socket — while on its browser side it serves an
authenticated WebSocket on the web app's own origin under `/bridge/`. The
client needs no changes and cannot tell the difference. §11.5 is the spec.

```
 browser tab                     this machine
+-------------------+           +--------------------------------+
| Hew web build     |           |  nginx  --  /bridge/  -->      |
|  liveBridge.ts    | <--wss--> |     hew-bridge (127.0.0.1:8788)|
+-------------------+  /bridge  |          |                     |
         ^                      |          | unix socket +       |
         |  authenticating edge |          | instance-<pid>.json |
         +-- Cloudflare Access  |          v                     |
                                |     hew-cli --live / mcp --live|
                                +--------------------------------+
```

## Running

```
hew-bridge [--listen 127.0.0.1:8788]
           (--access-team-domain TEAM.cloudflareaccess.com --access-aud TAG
            | --insecure-no-edge-auth)
           [--reply-timeout-secs 60]
```

Every flag has an environment twin — `HEW_BRIDGE_LISTEN`,
`HEW_BRIDGE_ACCESS_TEAM_DOMAIN`, `HEW_BRIDGE_ACCESS_AUD`,
`HEW_BRIDGE_INSECURE_NO_EDGE_AUTH`, `HEW_BRIDGE_REPLY_TIMEOUT_SECS` — which
is how the shipped `hew-bridge.service` unit configures it (through
`~/.config/hew/bridge.env`). There is no config file. Full setup is in
`docs/SELF_HOSTING.md`.

It runs as a **user** service, not a system one: the discovery file and
socket have to land in the `$XDG_RUNTIME_DIR` of the account that will run
`hew-cli`, which is the only reason they are findable at all.

## Why it is safe to point at the internet

§11.2 goes out of its way to say the desktop socket is never a TCP
listener. This is the transport that departs from that, so three things
replace owner-only filesystem permissions, and all three are required:

1. **An authenticated identity at the edge.** The browser-facing routes sit
   behind Cloudflare Access (or an equivalent), and this daemon verifies the
   `Cf-Access-Jwt-Assertion` itself — signature against the team JWKS,
   issuer, audience, expiry — rather than trusting that it was fronted. It
   fails closed and uniformly: every way it can fail is one indistinguishable
   403. `--insecure-no-edge-auth` removes this lock and must be asked for by
   name; there is no way to reach it by leaving configuration unset.
2. **The per-launch token.** 256 random bits, minted at startup, handed to
   an authenticated browser by `GET /bridge/session` and carried by the
   mandatory first `hello`. Stripped from every frame before the document
   sees it.
3. **A loopback-only listener.** The proxy is the only route in.

On top of those, the person in the tab has to consent: **Settings ▸
Advanced ▸ Allow remote control**, off by default. The discovery file is
published only while a tab has it on, so "nobody consented" looks to a
client exactly like "no app is running".

One tab owns a session at a time. The most recent to enable the toggle takes
it; the one it displaces is refused with a reason rather than silently
multiplexed, because two tabs are two documents.

Logs one line per request and per session lifecycle event — never a token,
a frame, or a user identity. `RUST_LOG` filters as usual.
