#!/usr/bin/env bash
# Renders a release's version and checksums into every packaging template.
#
#   packaging/scripts/render-templates.sh v1.1.0
#
# Reads the asset digests from the GitHub API (no download), then rewrites
# the pacman PKGBUILD, the Gentoo ebuild filename, the Flatpak
# manifest/metainfo, and the Homebrew cask in place. Gentoo's Manifest wants BLAKE2B and SHA512 as
# well, which the API does not carry, so the two .deb files ARE downloaded
# for that step only.
#
# Run by .github/workflows/packaging.yml — never by hand. Its output is a
# working-tree diff for whichever job invoked it to build from; nothing here
# commits or pushes anything.
set -euo pipefail
tag="${1:?usage: render-templates.sh vX.Y.Z}"
version="${tag#v}"
repo="hew3d/hew"
here="$(cd "$(dirname "$0")/.." && pwd)"

digest() { gh release view "$tag" --repo "$repo" --json assets -q ".assets[] | select(.name == \"$1\") | .digest" | sed 's/^sha256://'; }
amd64_deb="Hew_${version}_amd64.deb"; arm64_deb="Hew_${version}_arm64.deb"
sha_amd64="$(digest "$amd64_deb")"; sha_arm64="$(digest "$arm64_deb")"
[ -n "$sha_amd64" ] && [ -n "$sha_arm64" ] || { echo "release $tag has no .deb digests yet" >&2; exit 1; }
# Only the cask needs the .dmg, so a release without one still renders the
# Linux targets; validate-homebrew-cask.sh refuses the stale cask instead.
mac_dmg="Hew_${version}_universal.dmg"; sha_mac="$(digest "$mac_dmg")"
[ -n "$sha_mac" ] || echo "::warning::release $tag has no $mac_dmg digest; the Homebrew cask is left unrendered"

# pacman (PKGBUILD) — x86_64 only, see the comment in the PKGBUILD itself
sed -i.bak -E \
  -e "s/^pkgver=.*/pkgver=${version}/" \
  -e "s/^sha256sums=.*/sha256sums=('${sha_amd64}')/" \
  "$here/pacman/hew-bin/PKGBUILD"

# Gentoo: rename the ebuild, regenerate the Manifest from the real files.
pkgdir="$here/gentoo/media-gfx/hew-bin"
old="$(ls "$pkgdir"/hew-bin-*.ebuild | head -1)"
new="$pkgdir/hew-bin-${version}.ebuild"
[ "$old" = "$new" ] || git mv "$old" "$new" 2>/dev/null || mv "$old" "$new"
tmp="$(mktemp -d)"
gh release download "$tag" --repo "$repo" --pattern "$amd64_deb" --pattern "$arm64_deb" --dir "$tmp"
{
  for f in "$amd64_deb" "$arm64_deb"; do
    arch="${f##*_}"; arch="${arch%.deb}"
    printf 'DIST hew-bin-%s_%s.deb %s BLAKE2B %s SHA512 %s\n' "$version" "$arch" \
      "$(stat -f%z "$tmp/$f" 2>/dev/null || stat -c%s "$tmp/$f")" \
      "$(python3 -c "import hashlib,sys;print(hashlib.blake2b(open(sys.argv[1],'rb').read()).hexdigest())" "$tmp/$f")" \
      "$(python3 -c "import hashlib,sys;print(hashlib.sha512(open(sys.argv[1],'rb').read()).hexdigest())" "$tmp/$f")"
  done
} > "$pkgdir/Manifest"
# The two .deb files render-templates.sh just downloaded for hashing are
# exactly what the pacman build step needs too — leave them for it instead
# of re-fetching.
mkdir -p "$here/render-cache"
mv "$tmp/$amd64_deb" "$tmp/$arm64_deb" "$here/render-cache/"
rmdir "$tmp"

# Flatpak
sed -i.bak -E \
  -e "s#(releases/download/)v[0-9.]+/Hew_[0-9.]+_amd64\.deb#\1${tag}/${amd64_deb}#" \
  -e "s#(releases/download/)v[0-9.]+/Hew_[0-9.]+_arm64\.deb#\1${tag}/${arm64_deb}#" \
  "$here/flatpak/com.hew3d.Hew.yml"
python3 - "$here/flatpak/com.hew3d.Hew.yml" "$sha_amd64" "$sha_arm64" <<'PY'
import re,sys
p,a,b=sys.argv[1:4]
s=open(p).read()
shas=iter([a,b])
s=re.sub(r'sha256: [0-9a-f]{64}', lambda m: 'sha256: '+next(shas), s)
open(p,'w').write(s)
PY
sed -i.bak -E "s/<release version=\"[0-9.]+\" date=\"[0-9-]+\"/<release version=\"${version}\" date=\"$(date +%F)\"/" "$here/flatpak/com.hew3d.Hew.metainfo.xml"

# Homebrew cask — the universal .dmg covers both Apple Silicon and Intel
if [ -n "$sha_mac" ]; then
  sed -i.bak -E \
    -e "s/^  version \"[^\"]*\"$/  version \"${version}\"/" \
    -e "s/^  sha256 \"[0-9a-f]*\"$/  sha256 \"${sha_mac}\"/" \
    "$here/homebrew/Casks/hew.rb"
fi
find "$here" -maxdepth 3 -name '*.bak' -delete
echo "rendered $tag"
