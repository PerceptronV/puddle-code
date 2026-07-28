#!/bin/sh
# Renders build/icon.svg → build/icon.png (1024²) + build/icon.icns using
# macOS-native tooling only (qlmanage / sips / iconutil). The outputs are
# COMMITTED — CI packages with them and needs no rasteriser; re-run this
# after editing icon.svg. electron-builder picks both up by default from
# the build/ resources dir (icns for mac, png for linux).
set -e
cd "$(dirname "$0")/../build"

qlmanage -t -s 1024 -o . icon.svg >/dev/null
mv icon.svg.png icon.png

rm -rf icon.iconset && mkdir icon.iconset
for s in 16 32 128 256 512; do
  sips -z "$s" "$s" icon.png --out "icon.iconset/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  sips -z "$d" "$d" icon.png --out "icon.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns icon.iconset -o icon.icns
rm -rf icon.iconset
echo "rendered build/icon.png + build/icon.icns from icon.svg"
