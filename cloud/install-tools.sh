#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
TOOLS="$ROOT/.tools"
mkdir -p "$TOOLS/jadx" "$TOOLS/apktool"
if [ ! -f "$TOOLS/jadx/lib/jadx-1.5.6-all.jar" ]; then
  curl -L --fail --retry 3 "https://github.com/skylot/jadx/releases/download/v1.5.6/jadx-1.5.6.zip" -o "$TOOLS/jadx.zip"
  unzip -q "$TOOLS/jadx.zip" -d "$TOOLS/jadx"
  rm -f "$TOOLS/jadx.zip"
fi
if [ ! -f "$TOOLS/apktool/apktool.jar" ]; then
  curl -L --fail --retry 3 "https://github.com/iBotPeaches/Apktool/releases/download/v3.0.3/apktool_3.0.3.jar" -o "$TOOLS/apktool/apktool.jar"
fi
java -version
echo "APK tools installed."
