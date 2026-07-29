#!/bin/sh
# Renders build/icon.svg → build/icon.png (1024², Linux — self-rounded with
# transparent margins, since Linux applies no mask) and build/icon-mac.svg →
# build/icon.icns (macOS — full-bleed, because macOS 26+ masks icons itself
# and plates self-rounded artwork on white). Uses macOS-native tooling only
# (qlmanage / sips / iconutil). The outputs are COMMITTED — CI packages with
# them and needs no rasteriser; re-run this after editing either svg.
# electron-builder picks both up by default from the build/ resources dir
# (icns for mac, png for linux).
set -e
cd "$(dirname "$0")/../build"

qlmanage -t -s 1024 -o . icon.svg >/dev/null
mv icon.svg.png icon.png

qlmanage -t -s 1024 -o . icon-mac.svg >/dev/null
rm -rf icon.iconset && mkdir icon.iconset
for s in 16 32 128 256 512; do
  sips -z "$s" "$s" icon-mac.svg.png --out "icon.iconset/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  sips -z "$d" "$d" icon-mac.svg.png --out "icon.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns icon.iconset -o icon.icns
rm -rf icon.iconset icon-mac.svg.png
echo "rendered build/icon.png (linux) + build/icon.icns (mac full-bleed)"
