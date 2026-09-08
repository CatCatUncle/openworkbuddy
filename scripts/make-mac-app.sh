#!/bin/bash
# 生成 macOS 桌面应用：~/Applications/OpenWorkBuddy.app
# 双击即启动 OpenWorkBuddy（跑的永远是本仓库的最新代码，改完代码重开 App 就生效，无需重新生成）。
# 重复运行本脚本 = 重新生成（比如仓库挪了位置、升级了 Electron 之后）。
#
# 做法：把 node_modules 里的 Electron.app 整个克隆一份，改名、换图标、改 Info.plist，
# 再把「加载本仓库」的一小段入口放进 Contents/Resources/app/，最后 ad-hoc 重签。
# 以前的做法是一个 shell 壳脚本 exec Electron.app 的二进制——macOS 认的是真正在跑的那个包，
# 所以菜单栏叫「Electron」、Dock 和 Cmd+Tab 显示 Electron 的图标、通知也署名 Electron。克隆才治本。
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${OWB_ELECTRON_APP:-$REPO/node_modules/electron/dist/Electron.app}"   # 测试用：指向一个假的 Electron.app 骨架
[ -x "$SRC/Contents/MacOS/Electron" ] || { echo "❌ 找不到 Electron，请先在仓库目录跑 npm install"; exit 1; }
[ -f "$REPO/build/icon.icns" ] || { echo "❌ 缺 build/icon.icns"; exit 1; }

NAME="OpenWorkBuddy"
APP="${OWB_APP_OUT:-$HOME/Applications/$NAME.app}"
VERSION="$(node -p "require('$REPO/package.json').version")"
NODE_DIR="$(dirname "$(command -v node || echo /usr/local/bin/node)")"
# 烤进 JS 的字符串用 JSON 转义（macOS 自带 bash 3.2 没有 ${var@Q}）
REPO_JS="$(node -p 'JSON.stringify(process.argv[1])' "$REPO")"
NODE_DIR_JS="$(node -p 'JSON.stringify(process.argv[1])' "$NODE_DIR")"

mkdir -p "$(dirname "$APP")"
rm -rf "$APP"
ditto "$SRC" "$APP"

# 1) 可执行文件与 Info.plist：菜单栏左上角、Cmd+Tab、「关于」里显示的名字都从这里来
mv "$APP/Contents/MacOS/Electron" "$APP/Contents/MacOS/$NAME"
PB=/usr/libexec/PlistBuddy
P="$APP/Contents/Info.plist"
$PB -c "Set :CFBundleExecutable $NAME" "$P"
$PB -c "Set :CFBundleName $NAME" "$P"
$PB -c "Set :CFBundleDisplayName $NAME" "$P"
$PB -c "Set :CFBundleIdentifier com.openworkbuddy.app" "$P"
$PB -c "Set :CFBundleIconFile icon.icns" "$P"
$PB -c "Set :CFBundleShortVersionString $VERSION" "$P"
$PB -c "Set :CFBundleVersion $VERSION" "$P"
# 中文系统下 Finder/Dock 也认 CFBundleDisplayName；InfoPlist.strings 在 Electron 包里本来就是空目录，无需改

# 2) 图标：换成我们自己的，Electron 的删掉
rm -f "$APP/Contents/Resources/electron.icns"
cp "$REPO/build/icon.icns" "$APP/Contents/Resources/icon.icns"

# 3) 入口：Electron 优先加载 Resources/app/，有它就不会掉进 default_app 的「欢迎使用 Electron」
#    name 必须是 openworkbuddy —— userData 目录（登录态/localStorage）跟着它走，换名字用户就被登出
mkdir -p "$APP/Contents/Resources/app"
cat > "$APP/Contents/Resources/app/package.json" <<JSON
{ "name": "openworkbuddy", "version": "$VERSION", "main": "main.js", "private": true }
JSON
cat > "$APP/Contents/Resources/app/main.js" <<JS
// 由 scripts/make-mac-app.sh 生成：把桌面壳指向本机仓库，仓库代码改完重开 App 就生效
"use strict";
const fs = require("fs");
const path = require("path");
const REPO = $REPO_JS;
// 从 Finder 启动时 PATH 只有系统目录，agent 要用的 node/npx/brew 工具全都找不到——把生成时的 node 位置烤进去
process.env.PATH = [$NODE_DIR_JS, "/opt/homebrew/bin", "/usr/local/bin", process.env.PATH || ""].filter(Boolean).join(":");
// 日志落盘：Finder 启动没有终端，出了事到 ~/Library/Logs/OpenWorkBuddy.log 看
try {
  const log = fs.createWriteStream(path.join(process.env.HOME || "", "Library/Logs/OpenWorkBuddy.log"), { flags: "a" });
  const w = (chunk) => { try { log.write(chunk); } catch {} return true; };
  process.stdout.write = w;
  process.stderr.write = w;
} catch {}
if (!fs.existsSync(path.join(REPO, "electron-main.js"))) {
  const { app, dialog } = require("electron");
  app.whenReady().then(() => {
    dialog.showErrorBox("OpenWorkBuddy", "找不到仓库：" + REPO + "\\n仓库挪了位置的话，在新位置重跑 scripts/make-mac-app.sh 即可。");
    app.exit(1);
  });
} else {
  process.chdir(REPO);
  require(path.join(REPO, "electron-main.js"));
}
JS

# 4) 改过包内容签名就失效了，Apple 芯片上签名失效的 App 会被直接杀掉——ad-hoc 重签一遍
if [ -z "${OWB_SKIP_CODESIGN:-}" ]; then codesign --force --deep --sign - "$APP" 2>/dev/null; fi

# Finder/Dock 缓存过旧版本的话 touch 一下让它重读
touch "$APP"

# ---- 自检：不靠目测，生成完立刻验 ----
fail=0
chk() { if [ "$2" = "$3" ]; then echo "  ✓ $1"; else echo "  ✗ $1：期望「$3」实得「$2」"; fail=1; fi; }
chk "菜单栏名字 CFBundleName"      "$($PB -c 'Print :CFBundleName' "$P")"        "$NAME"
chk "显示名 CFBundleDisplayName"   "$($PB -c 'Print :CFBundleDisplayName' "$P")" "$NAME"
chk "可执行文件 CFBundleExecutable" "$($PB -c 'Print :CFBundleExecutable' "$P")"  "$NAME"
chk "图标 CFBundleIconFile"        "$($PB -c 'Print :CFBundleIconFile' "$P")"    "icon.icns"
chk "图标文件存在"                 "$([ -f "$APP/Contents/Resources/icon.icns" ] && echo yes || echo no)" "yes"
chk "Electron 旧图标已删"          "$([ -f "$APP/Contents/Resources/electron.icns" ] && echo still || echo gone)" "gone"
chk "入口 main.js 存在"            "$([ -f "$APP/Contents/Resources/app/main.js" ] && echo yes || echo no)" "yes"
chk "入口语法"                     "$(node --check "$APP/Contents/Resources/app/main.js" 2>&1 && echo ok)" "ok"
[ -n "${OWB_SKIP_CODESIGN:-}" ] || chk "签名有效"                     "$(codesign --verify --deep --strict "$APP" 2>&1 && echo ok)" "ok"
chk "包内不再有 Electron 二进制"   "$([ -e "$APP/Contents/MacOS/Electron" ] && echo still || echo gone)" "gone"
[ $fail = 0 ] || { echo "❌ 自检没过，见上"; exit 1; }

echo "✅ 已生成 ${APP}（$(du -sh "${APP}" | cut -f1)）"
echo "   双击即启动；日志在 ~/Library/Logs/OpenWorkBuddy.log；仓库挪位置或升级 Electron 后重跑本脚本"
echo "   Dock 上如果还是旧图标：把它从 Dock 拖掉再拖回来一次（macOS 缓存）"
