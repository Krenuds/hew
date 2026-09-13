# Rendered by packaging/scripts/render-templates.sh — edit that script, not
# the version or hash here. Validated and published by
# .github/workflows/packaging.yml into the hew3d/homebrew-tap repository (see
# packaging/README.md).
cask "hew" do
  version "1.0.0"
  sha256 "88f965a97103c8e7dd0ee59a66cfe7d1074ced538d92b8498ebe25763ad2466c"

  url "https://github.com/hew3d/hew/releases/download/v#{version}/Hew_#{version}_universal.dmg"
  name "Hew"
  desc "3D modeler with SketchUp's interaction model on a solids-first kernel"
  homepage "https://hew3d.com/"

  livecheck do
    url :url
    strategy :github_latest
  end

  # This is the same notarized disk image the download page serves, built
  # with the in-app updater, which replaces the app in place. `brew upgrade`
  # therefore leaves Hew to that updater unless run with --greedy.
  auto_updates true
  depends_on :macos

  app "Hew.app"
  # The CLI ships inside the bundle as a Tauri sidecar; link it onto PATH.
  binary "#{appdir}/Hew.app/Contents/MacOS/hew-cli"

  uninstall quit: "com.hew3d.Hew"

  # App state only. The Library folder (~/Hew Library by default, or wherever
  # library.json points) is the user's own work and is never listed here.
  zap trash: [
    "~/Library/Application Support/com.hew3d.Hew",
    "~/Library/Application Support/Hew",
    "~/Library/Caches/com.hew3d.Hew",
    "~/Library/Caches/hew",
    "~/Library/Logs/com.hew3d.Hew",
    "~/Library/Preferences/com.hew3d.Hew.plist",
    "~/Library/WebKit/com.hew3d.Hew",
    "~/Library/WebKit/hew",
  ]
end
