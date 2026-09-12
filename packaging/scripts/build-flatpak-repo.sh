#!/usr/bin/env bash
# Builds the Flatpak into a fresh ostree repo and produces a single-file
# .flatpak bundle for the release assets.
#
#   build-flatpak-repo.sh <repo-dir> <bundle-out-path> <pages-base-url>
#
# <repo-dir> is built from scratch every run and republished wholesale —
# this repo is rebuilt per release rather than incrementally appended to,
# so there's no persistent ostree object store to grow unbounded in
# hew3d/hew-packages, and no history for a client to lose by resuming a
# fresh pull. That means no static-delta generation either (deltas need
# continuous history to be worth anything); a client just does a full pull
# on update, which is a fine trade at Hew's current scale. Expects
# flatpak/flatpak-builder and the org.gnome.Platform//47 + org.gnome.Sdk//47
# runtimes already installed, and PACKAGING_GPG_PRIVATE_KEY in the
# environment. Writes <repo-dir>/../com.hew3d.Hew.flatpakrepo alongside the
# repo.
set -euo pipefail
repo_dir="${1:?usage: build-flatpak-repo.sh <repo-dir> <bundle-out-path> <pages-base-url>}"
bundle_out="${2:?usage: build-flatpak-repo.sh <repo-dir> <bundle-out-path> <pages-base-url>}"
base_url="${3:?usage: build-flatpak-repo.sh <repo-dir> <bundle-out-path> <pages-base-url>}"
here="$(cd "$(dirname "$0")/.." && pwd)"

gpg_home="$(mktemp -d)"
trap 'rm -rf "$gpg_home"' EXIT
gpg --batch --homedir "$gpg_home" --import <<<"$PACKAGING_GPG_PRIVATE_KEY"
keyid="$(gpg --batch --homedir "$gpg_home" --with-colons --list-secret-keys | awk -F: '$1=="sec"{print $5; exit}')"

build_dir="$(mktemp -d)"
rm -rf "$repo_dir"
mkdir -p "$repo_dir"
flatpak-builder --force-clean --repo="$repo_dir" "$build_dir" "$here/flatpak/com.hew3d.Hew.yml"
flatpak build-update-repo --gpg-sign="$keyid" --gpg-homedir="$gpg_home" "$repo_dir"

flatpak_repo_url="${base_url%/}/flatpak/com.hew3d.Hew.flatpakrepo"
mkdir -p "$(dirname "$bundle_out")"
flatpak build-bundle --gpg-sign="$keyid" --gpg-homedir="$gpg_home" \
  --runtime-repo="$flatpak_repo_url" \
  "$repo_dir" "$bundle_out" com.hew3d.Hew

pubkey_b64="$(gpg --batch --homedir "$gpg_home" --export "$keyid" | base64 -w0)"

cat > "$(dirname "$repo_dir")/com.hew3d.Hew.flatpakrepo" <<EOF
[Flatpak Repo]
Title=Hew
Comment=Hew — a 3D modeler built on watertight solids
Url=${base_url%/}/flatpak/repo
Homepage=https://hew3d.com
GPGKey=${pubkey_b64}
EOF

echo "flatpak repo updated at $repo_dir"
echo "bundle written to $bundle_out"
