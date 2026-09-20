---
name: adding-a-setting
description: >-
  The end-to-end recipe for adding, changing, or removing a user preference in
  the Hew app — the persisted singleton, every UI surface that must show it,
  the tests, and the docs. Use this skill whenever work touches a user-facing
  setting, preference, option, toggle, slider, or knob: "add a setting for X",
  "make X configurable", "let the user change X", "add a checkbox/slider to
  Settings", "why doesn't my setting stick", "this setting doesn't update the
  other window", or any request to put a hardcoded constant in `app/src` under
  user control. Reach for it even when the user never says the word "setting"
  — "the cursor dot is too big, can we make it adjustable" is this skill.
  Hew's Settings UI is written TWICE (macOS/Linux/web vs Windows Fluent) and
  its cross-window sync has a step that is easy to miss, so guessing from one
  example file reliably produces a half-wired setting.
---

# Adding a setting to Hew

Hew has no central settings store and no settings framework. Each preference
is a small self-contained module in `app/src/settings/` that owns its own
persistence and its own cross-window sync, and each one is surfaced by hand in
every UI that shows it. That design is deliberate — it keeps settings free of
a framework everyone has to learn — but it means a new knob is a handful of
small edits in predictable places rather than one registration call.

The two things that go wrong most often: forgetting that **the Settings UI is
written twice**, and forgetting the **Tauri broadcast** (so the setting works
in the browser and silently fails to propagate on the desktop).

## Step 1 — Decide the storage shape

Every setting persists to `localStorage` under the `hew.settings.*` namespace.
Pick one of two shapes:

- **A scalar key** for a standalone preference. Copy `settings/theme.ts`.
  Examples: `hew.settings.theme`, `.lengthUnit`, `.debugMode`,
  `.sceneTransitions`, `.showWelcome`.
- **An object key** when the preference belongs to a cluster that will grow.
  Copy `settings/trayLayout.ts` (or `settings/viewport.ts`). Examples:
  `hew.settings.trayLayout` (per-panel flags), `hew.settings.viewport`
  (viewport display knobs).

Prefer the object shape when you can name the second and third knob that will
join it — one module, one `subscribe`, one broadcast key beats five
near-identical files. Prefer the scalar shape otherwise; a one-field object
that never gains a second field is just indirection.

If the new knob fits an existing cluster, **add a field to that module** rather
than creating a new one. Adding `snapDotScale` to `viewport.ts` costs a field
and a parser line.

When you add a field to an existing object-key module, four places need it and
only two of them are obvious: the interface and the defaults, yes — but also
the **parser** (or the field is silently dropped on load) and the module's
**`sameSettings()` dedup helper**. That last one is the quiet one:
`applyExternal` early-returns when the incoming value compares equal, so a
`sameSettings` that still only compares the old fields will make cross-window
changes to your new field vanish with no error anywhere. Extend it.

## Step 2 — Write the singleton

Copy the nearest canonical file wholesale and rename — do not write this from
memory, and do not invent a new structure. The canonical copies are
`settings/theme.ts` (scalar) and `settings/trayLayout.ts` (object). They are
kept deliberately identical to each other so the pattern stays scannable.

The parts that matter, and why:

- **Every storage access is wrapped in `try/catch`.** Privacy mode and
  unavailable storage throw rather than returning null, and this is also what
  lets the module run at all under the `node` test environment, which has no
  `localStorage` until the test harness installs one.
- **The parser validates and falls back, never throws.** For an object key,
  fall back *per field* so a value written by a newer build (an extra knob, a
  wider range) degrades to something sane instead of resetting the whole
  object. Clamp out-of-range numbers rather than rejecting them.
- **`setX()` does four things in order**: mutate the module-level `current`,
  persist, `notify()` local subscribers, then `broadcastTauri()`.
- **Cross-window sync runs on two channels**, and both are required:
  - the browser `storage` event, which covers same-origin web tabs;
  - a Tauri global event named `'settings-changed'`, because on macOS/Linux
    the Settings window is a *separate webview* and separate webviews do not
    share `storage` events at all.

    Every setting shares that one event channel and distinguishes itself by
    **payload key** (`{ theme: … }`, `{ trayLayout: … }`, `{ viewport: … }`).
    Use a fresh payload key so the existing listeners don't collide with
    yours. `@tauri-apps/api/event` is imported lazily and every failure is
    swallowed — the web build has no Tauri and must not throw.

Quantize and clamp on write if the value comes from a slider: a `0.1`-step
range input hands back `0.7000000000000001`, which then defeats equality
checks everywhere downstream.

## Step 3 — Consume it

The component or module that the setting affects should **subscribe to the
singleton itself** rather than receiving a prop:

```ts
const [value, setValue] = useState(() => getX())
useEffect(() => subscribe(setValue), [])
```

Hew renders several surfaces from the same components — the editor (`App.tsx`)
and Shop Mode (`shop/ShopApp.tsx`) both mount the viewport, the tool rail and
the inference overlays. Self-subscribing means a new setting reaches all of
them at once and they cannot drift; prop-threading means two call sites to
keep in sync, and they have drifted before.

Two traps:

- **Hooks run unconditionally.** Many of these components early-return
  (`if (info === null) return null`). The `useState`/`useEffect` pair goes
  *above* that return.
- **A non-React consumer has to ask for a repaint.** If the subscriber writes
  into three.js (a uniform, a material, a scene object) rather than React
  state, nothing schedules a frame — the change lands but does not appear
  until some unrelated repaint (a camera move, a resize). Call the viewport's
  render scheduler in the subscription, and remember to unsubscribe in the
  effect's cleanup alongside the existing `unsubscribeTheme`-style calls, or
  every mount leaks a subscriber.
- **CSS animations own the properties they animate.** If a class in
  `index.css` animates `transform`, do not express your setting as a
  `transform` — the keyframes will clobber it, and it will appear to work only
  under `prefers-reduced-motion`. Drive the underlying box instead
  (`width`/`height`/`border`), which also keeps the animation proportional for
  free. `viewport/SnapDot.tsx` documents this case.

## Step 4 — Surface it in the UI (this is where settings get half-finished)

Hew has **four** places a preference can appear. Work out which ones apply
before writing any JSX.

| Surface | File | Who sees it |
|---|---|---|
| macOS/Linux desktop | `settings/SettingsWindow.tsx` → a `*Pane.tsx` | a standalone OS webview window (`#settings` hash, minted by Rust `open_settings_window`) |
| Web | the same `<SettingsWindow />` | embedded in an in-app modal in `App.tsx` |
| Windows desktop | `settings/FluentSettingsPage.tsx` | a full-window in-app page, Win11 app-settings idiom |
| Shop Mode | `shop/SettingsMenu.tsx` | the ⋯ menu; carries only Units + Theme today |

`App.tsx`'s `openSettings` picks between them (`isTauri && isWindows` →
Fluent; `isTauri` → the separate window; otherwise the modal).

**A knob shown in Settings must be written twice** — once as a pane on the
macOS-HIG form grid, once as a card in the Fluent page. They bind to the same
singleton, so they can't disagree about behavior, but they are separate
renderings and the Windows one is easy to forget. Styling-only duplication is
the accepted cost here; the one thing worth extracting is a shared state
machine when there is real behavior (see `settings/serverForm.ts`, shared
between `AdvancedPane` and the Fluent page — but that exists because the
server pane has draft/commit/validate/probe logic, not because it renders two
inputs).

**Not every setting needs a pane.** `sceneTransitions.ts` is surfaced as a
View menu checkmark because Settings has no pane it belongs in. A setting with
no natural home is a signal to reconsider, not to invent a pane.

For a macOS pane:

- Build it out of `settings/SettingsForm.tsx`'s primitives — `SettingsForm`
  (the two-column grid), `SettingsRow`, `SettingsSeparator`, `SettingsNote`,
  `SettingsSlider`, and the exported `settingsSelectStyle` /
  `settingsOptionStyle`. Copy `settings/ThemePane.tsx`, the simplest pane.
- If your control type has no primitive yet, **add one to `SettingsForm.tsx`**
  and a styled twin in `FluentSettingsPage.tsx` rather than inlining it. The
  next knob of that type will want it.
- Adding a whole new *tab* means: a member of the `Category` union, an inline
  monochrome stroke SVG icon matching the file's shared `iconProps` (24×24,
  `currentColor`, `strokeWidth` 1.5), a `TABS` entry, and a tabpanel branch.
- All colors come from theme tokens (`theme/tokens.css`), never hardcoded —
  there is a test asserting the tab strip uses tokens.
- Changes apply instantly. There is no OK/Cancel anywhere in Hew's settings.

Accessibility: the row label should be a real `<label htmlFor>` pointing at
the control's `id`. For a numeric control, also set `aria-valuetext` to the
formatted value — a screen reader otherwise announces `aria-valuenow` of `0.8`
as "zero point eight".

## Step 5 — Tests

`app/vitest.config.ts` splits the suite by extension, and this catches people
out:

- `*.test.ts` runs under **node** — no DOM, no real `localStorage`.
- `*.test.tsx` runs under **jsdom**.
- `src/test/setup.ts` installs an in-memory `localStorage` for both, and the
  pure-logic settings suites additionally install and restore their own
  `FakeStorage` stub. Copy that block from `settings/trayLayout.test.ts`.

Write:

1. **A singleton test** (`.test.ts`) — defaults, set/get round-trip,
   subscribe/unsubscribe, the persisted JSON shape, clamping and quantizing,
   and a `describe` block for restore-on-load. `loadInitial()` runs at
   module-evaluation time, so restore cases need a fresh module instance via
   `vi.resetModules()` + dynamic `import()`. Cover malformed JSON, a
   non-object value, a mistyped field, and — for an object key — an unknown
   field written by a newer build.
2. **A pane test** (`.test.tsx`) — the control renders with an accessible
   name, moving it writes the singleton, and the pane starts from the
   persisted value rather than the default.
3. **A consumer test** if the setting changes something rendered. Assert the
   default case *exactly*; that is the regression guard proving the shipped
   look didn't shift when the knob landed.

Note that a singleton notification arriving from outside React needs
`act(() => setX(…))` in a component test, or the re-render won't flush.

**`settings/SettingsWindow.test.tsx` asserts the exact tab list with
`toEqual`.** Any new tab fails it until that array is updated. This is a
deliberate tripwire, not a nuisance — update it and add a tab-switch case.

**`FluentSettingsPage.tsx` has no test file, and no E2E coverage either.**
Don't go looking for one. That is a real gap, not a hiding place: the Windows
settings surface is verified by reading it against its macOS twin and by
running the app. If you want a regression guard for a Windows-only control,
you are writing the first `FluentSettingsPage.test.tsx`, which is worth doing
but is its own piece of work — say so rather than quietly leaving the mirror
untested.

## Step 6 — Docs

`docs/agents/ROADMAP.md` is the exhaustive inventory and code comments cite it
by section; add the setting to the section that already describes the feature
it modifies. If the underlying feature turns out to be missing from the
inventory too, add it — that gap is worth closing while you're there.

Do **not** touch `docs/dev/HEW_FILE_FORMAT.md`. Preferences live in
`localStorage` on one machine and are not document state; neither `theme` nor
`trayLayout` appears there.

## Checklist

- [ ] Storage shape chosen; new key under `hew.settings.*`, or a field added
      to an existing cluster
- [ ] Singleton copied from `theme.ts` / `trayLayout.ts`, with try/catch,
      a falling-back parser, `notify()`, and **both** sync channels
- [ ] Fresh `'settings-changed'` payload key, colliding with no existing one
- [ ] Consumer self-subscribes; hooks above any early return
- [ ] macOS pane **and** the Fluent mirror (plus Shop Mode, if it applies)
- [ ] New control type → a shared primitive, not an inline one-off
- [ ] Singleton test, pane test, consumer test
- [ ] `SettingsWindow.test.tsx`'s tab list updated if a tab was added
- [ ] `docs/agents/ROADMAP.md` updated
- [ ] `pnpm --dir app typecheck && pnpm --dir app typecheck:test && pnpm --dir app test`
- [ ] `scripts/verify.sh` before committing

## What the tests cannot reach

Two things need a human on the desktop build, so say so rather than implying
full coverage:

- **The cross-window broadcast.** Open the Settings window beside the model,
  change the setting, and confirm the main window reacts without a reload.
  Nothing in the unit suite exercises the Tauri event path.
- **Visual judgment at the extremes** of any range you picked. The bounds are
  usually one constant each — cheap to revisit once someone has looked.
