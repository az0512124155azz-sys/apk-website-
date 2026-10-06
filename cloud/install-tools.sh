#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
TOOLS="$ROOT/.tools"
mkdir -p "$TOOLS/jadx" "$TOOLS/apktool"

if [ ! -x "$TOOLS/java/bin/java" ] || [ ! -x "$TOOLS/java/bin/jarsigner" ]; then
  echo "Installing Temurin JDK 21 for APK signing..."
  rm -rf "$TOOLS/java" "$TOOLS/jdk"
  mkdir -p "$TOOLS/jdk"
  curl -L --fail --retry 3 "https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse" -o "$TOOLS/jdk.tar.gz"
  tar -xzf "$TOOLS/jdk.tar.gz" -C "$TOOLS/jdk" --strip-components=1
  mv "$TOOLS/jdk" "$TOOLS/java"
  rm -f "$TOOLS/jdk.tar.gz"
fi

if [ ! -f "$TOOLS/jadx/lib/jadx-1.5.6-all.jar" ]; then
  echo "Installing JADX 1.5.6..."
  curl -L --fail --retry 3 "https://github.com/skylot/jadx/releases/download/v1.5.6/jadx-1.5.6.zip" -o "$TOOLS/jadx.zip"
  unzip -q "$TOOLS/jadx.zip" -d "$TOOLS/jadx"
  rm -f "$TOOLS/jadx.zip"
fi

if [ ! -f "$TOOLS/apktool/apktool.jar" ]; then
  echo "Installing Apktool 3.0.3..."
  curl -L --fail --retry 3 "https://github.com/iBotPeaches/Apktool/releases/download/v3.0.3/apktool_3.0.3.jar" -o "$TOOLS/apktool/apktool.jar"
fi

"$TOOLS/java/bin/java" -version
echo "APK tools installed."
