# Distribution packaging

Everything here repackages the release artifacts GitHub Actions already
produces (`.github/workflows/release.yml`) — the Linux `.deb` for x86_64
and aarch64 — for distributions whose users asked for a native package.
Nothing is built from source here: the desktop build needs pnpm, wasm-pack
and a pinned wasm-opt at build time, and none of these ecosystems can
express that offline dependency chain cleanly, so every package below is a
`-bin` package by design.

| Directory | What it is | Where it gets published |
|---|---|---|
| `aur/hew-bin/` | Arch Linux `PKGBUILD` (+ `.SRCINFO`) for the AUR | the `hew-bin` AUR package (a maintainer account pushes to `aur.archlinux.org`) |
| `gentoo/` | a Gentoo overlay: `media-gfx/hew-bin` ebuild, `metadata.xml`, `Manifest`, and the overlay's own `profiles/` and `metadata/` | a `hew3d/gentoo-overlay` repository users add with `eselect repository add hew3d git https://github.com/hew3d/gentoo-overlay` |
| `flatpak/` | a Flatpak manifest (`com.hew3d.Hew.yml`) and AppStream metainfo | a self-hosted repo or a Flathub submission — see the note in the manifest |

## Cutting a release

After a release is published, run `packaging/render.sh vX.Y.Z` once. It
reads the release's asset digests from the GitHub API and rewrites the
version and checksums in every file above (the AUR `.SRCINFO`, the ebuild
filename and the Gentoo `Manifest`, the Flatpak manifest). Commit the
result, then push the AUR package and the overlay from a machine with the
right credentials.

## Why not a source package

Arch's `makepkg` allows network access during `prepare()`, so a source
`PKGBUILD` is possible there; Gentoo's `cargo.eclass` wants every crate
listed up front and has no story for a pnpm workspace or for wasm-pack
fetching `wasm-bindgen`/`wasm-opt`; Flathub prefers source builds for
open-source apps and would need generated `cargo-sources.json` and
node-sources manifests plus vendored wasm tooling. The `-bin` route ships
today; a source route is a separate effort.
