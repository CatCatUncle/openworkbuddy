#!/bin/bash
# 从 build/icon.svg 生成三样东西：
#   build/icon.icns  macOS 应用图标（iconutil 打包的 iconset）
#   build/icon.ico   Windows 应用图标（多分辨率，含 16/24/32/48/64/128/256）
#   build/icon.png   1024 的通用图，README 和网页 favicon 用
# 用 qlmanage 渲染 SVG 而不是 ImageMagick：magick 只有自带的 MSVG 渲染器，渐变和圆角常出岔子；
# qlmanage 走的是系统 WebKit，跟浏览器里看到的一模一样。
# 只在 macOS 上跑（iconutil/qlmanage 是 macOS 自带）。图标产物已提交进仓库，
# 所以 Windows/Linux 上打包不需要重跑这个脚本。
set -euo pipefail
cd "$(dirname "$0")/.."
command -v magick >/dev/null || { echo "缺 ImageMagick：brew install imagemagick"; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cp build/icon.svg "$TMP/icon.svg"
qlmanage -t -s 1024 -o "$TMP" "$TMP/icon.svg" >/dev/null 2>&1
SRC="$TMP/icon.svg.png"
[ -f "$SRC" ] || { echo "SVG 渲染失败"; exit 1; }

cp "$SRC" build/icon.png
cp "$SRC" public/icon.png   # 网页 favicon 和「关于」页用同一张

SET="$TMP/icon.iconset"
mkdir -p "$SET"
for s in 16 32 128 256 512; do
  magick "$SRC" -resize ${s}x${s}      "$SET/icon_${s}x${s}.png"
  magick "$SRC" -resize $((s*2))x$((s*2)) "$SET/icon_${s}x${s}@2x.png"
done
iconutil -c icns "$SET" -o build/icon.icns

magick "$SRC" -define icon:auto-resize=256,128,64,48,32,24,16 build/icon.ico

echo "生成完毕："
ls -la build/icon.icns build/icon.ico build/icon.png public/icon.png
