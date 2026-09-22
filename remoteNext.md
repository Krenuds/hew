# Remote control - what's left

Access is live on `build.travisrashguard.com` (team `toji2`); `hew-bridge`,
`wsTransport.ts`, the `LiveTransport` seam, the consent toggle and the
deploy files all shipped. `--live` surviving a missing or restarted tab
shipped too (`e681d05`). Numbers below are measured against `e681d05`.

Phases are in annoyance order, not dependency order - they're independent.

## 1. A published `hew-bridge` binary

Self-hosters run `cargo build --release -p hew-bridge` today
(`docs/SELF_HOSTING.md:273`); `.github/workflows/release.yml:486-493` says "no
published binary yet" in a comment and that's the whole story. The shape to
copy is the `hew-relay` leg at `release.yml:528-597` - native per-arch musl
builds, `x86_64` and `aarch64`, with the `file | grep static` hard-fail.

**The dependency worry was wrong.** The premise was that `reqwest`'s
`rustls-tls` selects aws-lc-rs and drags in cmake. It does not here:
`cargo tree -p hew-bridge -i ring` shows `rustls 0.23.45` resolving to
**ring**, and `jsonwebtoken 9` pulls ring independently anyway. There is no
`aws-lc-sys` in `Cargo.lock`. So there is no dependency change and no rule-8
ask - this is CI plus docs.

**What doesn't transfer from the relay leg.** The bridge refuses to start
without edge auth (`hew-bridge/src/main.rs:126-140`), so an unattended smoke
needs `--insecure-no-edge-auth`; and it serves identity at `/`, not
`/bridge/` (`http.rs:51`), that prefix being nginx's. So the smoke is
`curl -sf http://127.0.0.1:18788/ | grep -q '"service":"hew-bridge"'`.
Starting it also binds a socket and writes a discovery file, so set
`HEW_RUNTIME_DIR` to a temp dir rather than landing in the `/tmp` fallback.
No Docker image - drop the matrix's `platform:` key. And it is a *user*
unit, so no install text may call it a system service.

Four plumbing spots the `notes` job needs, or it races or omits the asset:
`release.yml:745` (`needs:`), `:785-786` (the `need` hard-fail), `:812` and
`:843-844` (table row, link defs). Stale in the same file: the header
manifest at `:19-22` lists only `Relay`.

**Unknown.** `ring` compiles C, so the musl legs need `musl-gcc` found.
`musl-tools` supplies it and the relay step already installs it, but
`hew-relay` has no C dependency, so this is the first time that path runs.
Build one locally before touching the workflow.

**Done when.** `hew-bridge-vX.Y.Z-linux-x86_64.tar.gz` and its aarch64 twin
are release assets, both passing the static check, and SELF_HOSTING's
build-from-source step is rewritten as a download.

## 2. The first `FluentSettingsPage.test.tsx`

The Windows settings page (677 lines) has no test file and no E2E. The
`adding-a-setting` skill names this as a known gap.

**The rest is easier than it looked.** No `vi.mock` wall is needed: every
availability check resolves false under jsdom, so
`render(<FluentSettingsPage onBack={vi.fn()} />)` works bare, with a
`beforeEach` resetting the singletons through their own setters, per
`ViewportPane.test.tsx`. Note the page has only a named export and no
sub-exports, so a test renders all of it.

**The test to write.** `app/src/settings/FluentSettingsPage.test.tsx`,
rendering the page bare and asserting on accessible names, in the shape of
`ViewportPane.test.tsx`:

- every control is present - units, theme, snap-dot size, debug, and the
  library and server sections - each found by the name a screen reader
  would read;
- flipping a control writes through to the singleton it owns, and a change
  made through the singleton's own setter shows up in the rendered page;
- the sections that depend on host capability render their unavailable
  state rather than throwing, since every availability check resolves false
  under jsdom.

The value is the duplication guard: settings are written once for Windows
and once for everything else, so a setting added only to the shared panes
is silently missing here. This test is what notices.

**E2E is not reachable.** `isWindows` is fakeable from Playwright
(`addInitScript` over `navigator.platform`, read at module eval), but
`isTauri` is not - faking `__TAURI_INTERNALS__` flips every `isTauri` branch
in `App.tsx` and the app doesn't boot - and there is no Tauri lane in
`playwright.config.ts`. It needs a new seam, the shape of `shellMode.ts`'s
`#shop` hash. That is the written answer the phase asked for.

**Done when.** A test file fails if the Windows mirror loses a control, its
accessible name, or its status text.

## 3. Decide `hew.event.*` - spec only

Right now the browser only ever answers; nothing pushes. Section 11.5 calls
the WebSocket the protocol's first bidirectional transport and says section
4.5's reserved notifications "are expected to ride here first once they are
specified." That sentence is the whole design. The moment an agent should
react to a hand edit, this is the missing piece. Write the spec; stop
there. Implementation is a later phase, deliberately.

**Unknowns.** Whether subscription is an explicit `hew.meta.subscribe`
(section 4.5's non-normative sketch) or implicit on any transport that can
carry server-to-client frames. What a coalesced `document_changed` actually
carries - a revision counter, a dirty set, or nothing but "look again". And
what 11.2 and stdio do with a spec only one transport can honor: silently
no-op, or refuse `subscribe` typed.

**Done when.** `docs/agents/HEW_API.md` section 4.5 (`:311`) is normative
instead of Reserved, 11.5's "once they are specified" line (`:1427`) is
retired, the namespace table row (`:675`) changes status, section 16's
future-directions line agrees with whatever 4.5 says, and
`docs/agents/ROADMAP.md` gets a bullet under **Longer-term** (`:818`), not
Near-term - the spec lands, the implementation does not. Spec change is
rule 8 - discuss before it lands.

## Loose end

- `docs/SELF_HOSTING.md:325` tells the self-hoster to verify
  `/bridge/session` returns **403** unauthenticated. The bridge really does
  (`hew-bridge/src/http.rs:83-86`), but through Cloudflare Access the reader
  gets a **302** to the login and never reaches it. Name both and say what
  each means, rather than swapping the number.
