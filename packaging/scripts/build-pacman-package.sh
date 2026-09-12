#!/usr/bin/env bash
# Builds and signs the hew-bin pacman package (x86_64 only — mainline Arch
# has no aarch64 port; see the PKGBUILD comment), inside an `archlinux`
# container.
#
#   build-pacman-package.sh <out-dir>
#
# Expects the rendered amd64 .deb source in packaging/render-cache/ (left
# there by render-templates.sh) and PACKAGING_GPG_PRIVATE_KEY in the
# environment. The version is whatever render-templates.sh already baked
# into the PKGBUILD's pkgver. Writes
# <out-dir>/<pkgname>-<pkgver>-1-x86_64.pkg.tar.zst and its detached .sig.
set -euo pipefail
out_dir="${1:?usage: build-pacman-package.sh <out-dir>}"
here="$(cd "$(dirname "$0")/.." && pwd)"

pacman -Syu --noconfirm --needed base-devel pacman-contrib gnupg

# makepkg refuses to run as root — makepkg.conf's PKGDEST/SRCDEST default to
# the build directory, which the throwaway build user needs to own.
useradd -m builder
cp -r "$here/pacman/hew-bin" /home/builder/hew-bin
# The amd64 .deb source render-templates.sh already fetched for hashing;
# makepkg's own download would otherwise hit network egress the build
# container may not have, and re-fetches something we already verified.
cp "$here/render-cache/"Hew_*_amd64.deb /home/builder/hew-bin/
chown -R builder:builder /home/builder/hew-bin

su builder -c "cd /home/builder/hew-bin && SRCDEST=. makepkg --nodeps"
pkg="$(su builder -c 'ls /home/builder/hew-bin/*.pkg.tar.zst' | head -1)"

gpg --batch --import <<<"$PACKAGING_GPG_PRIVATE_KEY"
keyid="$(gpg --batch --with-colons --list-secret-keys | awk -F: '$1=="sec"{print $5; exit}')"
gpg --batch --yes --detach-sign --local-user "$keyid" "$pkg"

mkdir -p "$out_dir"
cp "$pkg" "$pkg.sig" "$out_dir/"
echo "built $(basename "$pkg")"
