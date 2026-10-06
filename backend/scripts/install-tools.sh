#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOLS="$ROOT/.tools"
mkdir -p "$TOOLS"

if [ ! -x "$TOOLS/java/bin/java" ]; then
  echo "Installing Temurin JRE 21..."
  rm -rf "$TOOLS/java" "$TOOLS/jre"
  mkdir -p "$TOOLS/jre"
  curl -L --fail --retry 3 "https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jre/hotspot/normal/eclipse" -o "$TOOLS/jre.tar.gz"
  tar -xzf "$TOOLS/jre.tar.gz" -C "$TOOLS/jre" --strip-components=1
  mv "$TOOLS/jre" "$TOOLS/java"
  rm -f "$TOOLS/jre.tar.gz"
fi

if [ ! -f "$TOOLS/jadx/lib/jadx-1.5.6-all.jar" ]; then
  echo "Installing JADX 1.5.6..."
  rm -rf "$TOOLS/jadx"
  mkdir -p "$TOOLS/jadx"
  curl -L --fail --retry 3 "https://github.com/skylot/jadx/releases/download/v1.5.6/jadx-1.5.6.zip" -o "$TOOLS/jadx.zip"
  unzip -q "$TOOLS/jadx.zip" -d "$TOOLS/jadx"
  rm -f "$TOOLS/jadx.zip"
fi

if [ ! -f "$TOOLS/apktool/apktool.jar" ]; then
  echo "Installing Apktool 3.0.3..."
  mkdir -p "$TOOLS/apktool"
  curl -L --fail --retry 3 "https://github.com/iBotPeaches/Apktool/releases/download/v3.0.3/apktool_3.0.3.jar" -o "$TOOLS/apktool/apktool.jar"
fi

echo "Tools ready."
