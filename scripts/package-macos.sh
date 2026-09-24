#!/bin/bash
# Builds "Flyto2 Runtime.app" and its disk image for the Mac this runs on.
#
# The app carries its own Node, production dependencies built for that Node,
# and cloudflared, so a user needs nothing installed first. Native modules are
# compiled for the host, which is why each architecture builds on its own Mac.
#
# Signing and notarization run only when their credentials are set:
#   APPLE_SIGNING_IDENTITY                  Developer ID Application identity
#   APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID  notarytool credentials
# Without them the app is ad-hoc signed, which runs on the Mac that built it.
#
# Usage: scripts/package-macos.sh [output directory]   (run after `pnpm build`)
set -euo pipefail

NODE_VERSION=24.21.0
# Pinned so a commit always packages the same cloudflared. Two digests per
# architecture: GitHub's digest of the release archive, and the digest of the
# binary inside it that Cloudflare publishes in its release notes.
CLOUDFLARED_VERSION=2026.9.1
CLOUDFLARED_TGZ_SHA256_arm64=c27ab8fd0aa489449e3d201eb02f957ef460a13b613662928b1b23394bf1bcfe
CLOUDFLARED_BIN_SHA256_arm64=9a0b19f67dc7a3011bc6b972c7ce06a5fcea8784ac6bd599ffa382ea4aeb5a6e
CLOUDFLARED_TGZ_SHA256_amd64=ff0d3b51d5ff70eceef89d6b32145fee985018a2174596a5dbe405e2766e2ac4
CLOUDFLARED_BIN_SHA256_amd64=1ea07ae775b03236bd6be18ca1848d6bdc4af2f4f3bce398823b5a36e5761b75

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mkdir -p "${1:-$ROOT/.release}" && cd "${1:-$ROOT/.release}" && pwd)"
case "$(uname -m)" in
  arm64) ARCH=arm64; CLOUDFLARED_ARCH=arm64 ;;
  x86_64) ARCH=x64; CLOUDFLARED_ARCH=amd64 ;;
  *) echo "Unsupported Mac architecture: $(uname -m)" >&2; exit 1 ;;
esac
VERSION="$(node -p 'require(process.argv[1]).version' "$ROOT/package.json")"
PNPM_VERSION="$(node -p 'require(process.argv[1]).packageManager.split("@")[1].split("+")[0]' "$ROOT/package.json")"
CLOUDFLARE_TEAM_ID=68WVV388M8

if [[ ! -f "$ROOT/dist/cli.js" ]]; then
  echo "dist/cli.js is missing; run pnpm build first." >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
APP="$WORK/Flyto2 Runtime.app"
RUNTIME="$APP/Contents/Resources/runtime"
mkdir -p "$APP/Contents/MacOS" "$RUNTIME"

echo "==> Node $NODE_VERSION ($ARCH)"
node_archive="node-v$NODE_VERSION-darwin-$ARCH.tar.gz"
curl -fsSL -o "$WORK/$node_archive" "https://nodejs.org/dist/v$NODE_VERSION/$node_archive"
curl -fsSL -o "$WORK/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
(cd "$WORK" && grep "  $node_archive\$" SHASUMS256.txt | shasum -a 256 -c -)
tar -xzf "$WORK/$node_archive" -C "$WORK"
mkdir -p "$RUNTIME/node/bin"
cp "$WORK/node-v$NODE_VERSION-darwin-$ARCH/bin/node" "$RUNTIME/node/bin/node"
cp "$WORK/node-v$NODE_VERSION-darwin-$ARCH/LICENSE" "$RUNTIME/node/LICENSE"
BUNDLED_PATH="$RUNTIME/node/bin:$PATH"

echo "==> Runtime $VERSION files"
# npm pack applies the package's own file list, so the app ships exactly what
# the npm package does.
(cd "$ROOT" && npm pack --silent --pack-destination "$WORK" >/dev/null)
tar -xzf "$WORK/flyto2-runtime-$VERSION.tgz" -C "$WORK"
cp -R "$WORK/package/." "$RUNTIME/"
cp "$ROOT/pnpm-lock.yaml" "$ROOT/pnpm-workspace.yaml" "$RUNTIME/"

echo "==> Production dependencies for Node $NODE_VERSION"
# Hoisted layout: plain directories inside the bundle, no symlink farm, and the
# lockfile's exact versions.
(cd "$RUNTIME" && PATH="$BUNDLED_PATH" npx --yes "pnpm@$PNPM_VERSION" install \
  --prod --frozen-lockfile --config.node-linker=hoisted --config.confirmModulesPurge=false)
rm -f "$RUNTIME/pnpm-workspace.yaml" "$RUNTIME/node_modules/.modules.yaml"

echo "==> Trimming what this Mac never loads"
# Other platforms' prebuilt binaries, source maps, type declarations, and the
# Claude Agent SDK's bundled Claude Code: a packaged Runtime runs the user's own
# `claude` instead (src/flyto2/distribution.ts).
rm -rf "$RUNTIME"/node_modules/@anthropic-ai/claude-agent-sdk-*
find "$RUNTIME/node_modules/node-pty/prebuilds" -mindepth 1 -maxdepth 1 ! -name "darwin-$ARCH" -exec rm -rf {} +
find "$RUNTIME/node_modules" -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \) -delete
(cd "$RUNTIME" && "$RUNTIME/node/bin/node" -e '
  require("better-sqlite3")(":memory:").close();
  require("node-pty");
  require("koffi");
  console.log("native modules load under", process.version);
')
"$RUNTIME/node/bin/node" "$RUNTIME/dist/cli.js" version

echo "==> cloudflared $CLOUDFLARED_VERSION"
mkdir -p "$RUNTIME/vendor"
curl -fsSL -o "$WORK/cloudflared.tgz" \
  "https://github.com/cloudflare/cloudflared/releases/download/$CLOUDFLARED_VERSION/cloudflared-darwin-$CLOUDFLARED_ARCH.tgz"
tgz_sha256_var="CLOUDFLARED_TGZ_SHA256_$CLOUDFLARED_ARCH"
bin_sha256_var="CLOUDFLARED_BIN_SHA256_$CLOUDFLARED_ARCH"
echo "${!tgz_sha256_var}  $WORK/cloudflared.tgz" | shasum -a 256 -c -
tar -xzf "$WORK/cloudflared.tgz" -C "$RUNTIME/vendor"
echo "${!bin_sha256_var}  $RUNTIME/vendor/cloudflared" | shasum -a 256 -c -
codesign --verify --strict \
  -R="anchor apple generic and certificate leaf[subject.OU] = \"$CLOUDFLARE_TEAM_ID\"" \
  "$RUNTIME/vendor/cloudflared"
"$RUNTIME/vendor/cloudflared" --version

printf '{\n  "kind": "macos-app",\n  "version": "%s",\n  "arch": "%s"\n}\n' "$VERSION" "$ARCH" > "$RUNTIME/distribution.json"

echo "==> App bundle"
clang -Wall -Wextra -Werror -O2 -mmacosx-version-min=13.5 \
  -o "$APP/Contents/MacOS/Flyto2 Runtime" "$ROOT/packaging/macos/launcher.c"
cp "$ROOT/packaging/macos/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>Flyto2 Runtime</string>
  <key>CFBundleExecutable</key><string>Flyto2 Runtime</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleIdentifier</key><string>com.flyto2.runtime</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Flyto2 Runtime</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>13.5</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

echo "==> Signing"
IDENTITY="${APPLE_SIGNING_IDENTITY:--}"
sign_flags=(--force --sign "$IDENTITY")
if [[ "$IDENTITY" != "-" ]]; then
  sign_flags+=(--options runtime --timestamp)
fi
# Inside out: every Mach-O file first, node with its entitlements, the bundle
# last. cloudflared is re-signed too; its Cloudflare signature was checked above.
while IFS= read -r -d '' file; do
  if file -b "$file" | grep -q "Mach-O"; then
    if [[ "$file" == "$RUNTIME/node/bin/node" ]]; then
      codesign "${sign_flags[@]}" --entitlements "$ROOT/packaging/macos/node.entitlements" "$file"
    else
      codesign "${sign_flags[@]}" "$file"
    fi
  fi
done < <(find "$RUNTIME" -type f -print0)
codesign "${sign_flags[@]}" "$APP"
codesign --verify --deep --strict "$APP"

notarize() {
  xcrun notarytool submit "$1" --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
}
NOTARIZE=0
if [[ "$IDENTITY" != "-" && -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
  NOTARIZE=1
  echo "==> Notarizing the app"
  ditto -c -k --keepParent "$APP" "$WORK/app.zip"
  notarize "$WORK/app.zip"
  xcrun stapler staple "$APP"
fi

echo "==> Disk image"
DMG="$OUT/Flyto2-Runtime-$VERSION-macos-$ARCH.dmg"
mkdir -p "$WORK/dmg"
mv "$APP" "$WORK/dmg/"
ln -s /Applications "$WORK/dmg/Applications"
rm -f "$DMG"
# An explicit format: hdiutil's default compression differs between macOS
# releases (the same app was 208 MB on the CI runner and 163 MB locally).
# LZMA is the smallest and opens on every macOS the app supports.
hdiutil create -quiet -volname "Flyto2 Runtime" -srcfolder "$WORK/dmg" -ov -format ULMO "$DMG"
if [[ "$IDENTITY" != "-" ]]; then
  codesign --force --sign "$IDENTITY" --timestamp "$DMG"
fi
if [[ "$NOTARIZE" == 1 ]]; then
  echo "==> Notarizing the disk image"
  notarize "$DMG"
  xcrun stapler staple "$DMG"
fi
(cd "$OUT" && shasum -a 256 "$(basename "$DMG")" > "$(basename "$DMG").sha256")
echo "$DMG"
