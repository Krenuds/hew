#!/usr/bin/env bash
# Builds and signs one arch's hew-bin pacman package, inside an `archlinux`
# container. Run once per architecture, natively (amd64 on an amd64 runner,
# aarch64 on an aarch64 runner) — pacman has no supported cross-build path,
# so this deliberately never tries to emulate one.
#
#   build-pacman-package.sh <out-dir>
#
# Expects the two rendered .deb sources in packaging/render-cache/ (left
# there by render-templates.sh) and PACKAGING_GPG_PRIVATE_KEY in the
# environment. The version is whatever render-templates.sh already baked
# into the PKGBUILD's pkgver. Writes
# <out-dir>/<pkgname>-<pkgver>-1-<carch>.pkg.tar.zst and its detached .sig.
set -euo pipefail
out_dir="${1:?usage: build-pacman-package.sh <out-dir>}"
here="$(cd "$(dirname "$0")/.." && pwd)"
carch="$(uname -m)"

pacman -Syu --noconfirm --needed base-devel pacman-contrib gnupg

# makepkg refuses to run as root — makepkg.conf's PKGDEST/SRCDEST default to
# the build directory, which the throwaway build user needs to own.
useradd -m builder
cp -r "$here/pacman/hew-bin" /home/builder/hew-bin
# The two .deb sources render-templates.sh already fetched for hashing;
# makepkg's own download would otherwise hit network egress the build
# container may not have, and re-fetches something we already verified.
cp "$here/render-cache/"Hew_*.deb /home/builder/hew-bin/
chown -R builder:builder /home/builder/hew-bin

su builder -c "cd /home/builder/hew-bin && SRCDEST=. makepkg --nodeps"
pkg="$(su builder -c 'ls /home/builder/hew-bin/*.pkg.tar.zst' | head -1)"

gpg --batch --import <<<"$PACKAGING_GPG_PRIVATE_KEY"
keyid="$(gpg --batch --with-colons --list-secret-keys | awk -F: '$1=="sec"{print $5; exit}')"
gpg --batch --yes --detach-sign --local-user "$keyid" "$pkg"

mkdir -p "$out_dir"
cp "$pkg" "$pkg.sig" "$out_dir/"
echo "built $(basename "$pkg") for $carch"
