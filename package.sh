#!/bin/sh
# Zip the built plugin the way Decky installs it: one folder holding plugin.json.
set -eu
cd "$(dirname "$0")"
[ -f dist/index.js ] || { echo "build first: npm run build" >&2; exit 1; }
rm -rf out && mkdir -p out/decky-sinden/dist
cp plugin.json package.json main.py README.md LICENSE out/decky-sinden/
cp dist/index.js out/decky-sinden/dist/
(cd out && python3 -m zipfile -c decky-sinden.zip decky-sinden)
ls -la out/decky-sinden.zip
