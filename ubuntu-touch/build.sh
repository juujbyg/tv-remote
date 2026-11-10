#!/usr/bin/env bash
# Build the Ubuntu Touch app on the connected phone and install it.
# Needs: adb (phone connected, developer mode on), and node-linux-arm64 at $NODE_ARM64 (bin/node).
set -euo pipefail
export MSYS_NO_PATHCONV=1  # Git Bash on Windows: keep /home/phablet paths as-is
cd "$(dirname "$0")/.."
ADB=${ADB:-adb}
NODE_ARM64=${NODE_ARM64:?set NODE_ARM64 to the extracted node-vXX-linux-arm64 folder}
STAGE=$(mktemp -d)
command -v cygpath >/dev/null && STAGE=$(cygpath -m "$STAGE")  # Windows adb needs a native path
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/pkg/app" "$STAGE/pkg/bin"
cp ubuntu-touch/manifest.json ubuntu-touch/tvremote.apparmor ubuntu-touch/tvremote.desktop "$STAGE/pkg/"
cp ubuntu-touch/launcher.mjs "$STAGE/pkg/app/launcher.mjs"
cp public/icon.svg "$STAGE/pkg/icon.svg"
cp LICENSE "$STAGE/pkg/LICENSE"
cp -r server.js package.json drivers lib public node_modules "$STAGE/pkg/app/"
cp "$NODE_ARM64/bin/node" "$STAGE/pkg/bin/node"
cp "$NODE_ARM64/LICENSE" "$STAGE/pkg/bin/NODE-LICENSE"
rm -rf "$STAGE/pkg/app/node_modules/.cache" "$STAGE/pkg/app/node_modules/androidtv-remote/.idea"
chmod +x "$STAGE/pkg/bin/node"

(cd "$STAGE" && tar -czf pkg.tgz pkg)
"$ADB" shell 'rm -rf /home/phablet/tvremote-build && mkdir -p /home/phablet/tvremote-build'
"$ADB" push "$STAGE/pkg.tgz" /home/phablet/tvremote-build/pkg.tgz
"$ADB" push ubuntu-touch/install-click.py /home/phablet/tvremote-build/install-click.py
"$ADB" shell 'cd /home/phablet/tvremote-build && tar -xzf pkg.tgz && chmod +x pkg/bin/node \
  && click build pkg && python3 install-click.py "$(ls -1t /home/phablet/tvremote-build/*.click | head -1)"'

# Keep a copy of the package (the file to upload to the OpenStore).
CLICK=$("$ADB" shell 'ls -1t /home/phablet/tvremote-build/*.click | head -1' | tr -d '\r')
mkdir -p dist
"$ADB" pull "$CLICK" "dist/$(basename "$CLICK")"
echo "Package: dist/$(basename "$CLICK")"
