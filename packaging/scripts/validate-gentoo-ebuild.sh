#!/usr/bin/env bash
# Validates the rendered Gentoo ebuild for real: syncs a snapshot of the
# main tree (needed for the unpacker/xdg eclasses it inherits), registers
# packaging/gentoo as a repo, and runs it through unpack+install so a
# corrupt Manifest digest or a broken src_install fails loudly here instead
# of on a user's machine. Runs inside a `gentoo/stage3` container.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
overlay="$here/gentoo"
pkgdir="$overlay/media-gfx/hew-bin"
ebuild_file="$(ls "$pkgdir"/hew-bin-*.ebuild | head -1)"

emerge-webrsync

mkdir -p /etc/portage/repos.conf
cat > /etc/portage/repos.conf/hew3d.conf <<EOF
[hew3d]
location = ${overlay}
masters = gentoo
auto-sync = no
EOF

echo 'media-gfx/hew-bin ~amd64 ~arm64' > /etc/portage/package.accept_keywords/hew-bin

emerge --getbinpkg --usepkg-exclude='media-gfx/hew-bin' app-portage/pkgcheck || true
if command -v pkgcheck >/dev/null; then
  pkgcheck scan --repo hew3d
fi

ebuild "$ebuild_file" clean unpack install
echo "gentoo ebuild validated: $ebuild_file"
