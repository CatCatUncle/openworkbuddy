#!/usr/bin/env bash
# OpenWorkBuddy · macOS 一键装应用（不走浏览器下载，绕开 Gatekeeper 那道墙）
#
#   curl -fsSL https://raw.githubusercontent.com/CatCatUncle/openworkbuddy/main/install-mac.sh | bash
#
# 为什么要有这个脚本：这个项目没有 Apple 的付费开发者证书（99 美元/年），
# 包只做了 ad-hoc 签名。浏览器下载的文件会被打上 com.apple.quarantine 标记，
# 于是 macOS 15 起双击只有一个「移到废纸篓 / 完成」的弹窗——没有「打开」这个选项，
# 照着老教程右键打开也没用，绝大多数人到这一步就放弃了，以为「这软件是坏的」。
#
# curl 下下来的文件不带那个标记。所以这条路上一个弹窗都不会有：
# 下载 → 解压 → 放进「应用程序」→ 打开。你的数据仍在 ~/OpenWorkBuddy，覆盖装不动它。
#
# 想装指定版本：OPENWORKBUDDY_VERSION=v0.6.4 bash install-mac.sh
# 想装到别处：  OPENWORKBUDDY_APPDIR=~/Applications bash install-mac.sh

set -euo pipefail

REPO="${OPENWORKBUDDY_REPO_SLUG:-CatCatUncle/openworkbuddy}"
WANT="${OPENWORKBUDDY_VERSION:-}"

say()  { printf "\033[1;34m▸\033[0m %s\n" "$*"; }
ok()   { printf "\033[1;32m✓\033[0m %s\n" "$*"; }
die()  { printf "\033[1;31m✗ %s\033[0m\n" "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "这个脚本只管 macOS。Linux / 服务器用 install.sh，Windows 去 Releases 下 -win-setup.exe。"

case "$(uname -m)" in
  arm64)  ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) die "不认识这个架构：$(uname -m)" ;;
esac
say "芯片：$(uname -m) → 下 mac-$ARCH 的包"

# ---------- 1. 找包 ----------
API="https://api.github.com/repos/$REPO/releases/latest"
[ -n "$WANT" ] && API="https://api.github.com/repos/$REPO/releases/tags/$WANT"
say "查最新版本…"
JSON="$(curl -fsSL -H 'Accept: application/vnd.github+json' "$API")" \
  || die "连不上 GitHub。挂了代理的话先关掉，或者自己去 https://github.com/$REPO/releases 下 zip。"

TAG="$(printf '%s' "$JSON" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
# 只认 zip：dmg 得挂载再卸载，多两个能失败的步骤，装应用这件事上没有任何好处
URL="$(printf '%s' "$JSON" | tr ',' '\n' | sed -n 's/.*"browser_download_url"[[:space:]]*:[[:space:]]*"\([^"]*mac-'"$ARCH"'\.zip\)".*/\1/p' | head -1)"
[ -n "$URL" ] || die "这个版本里没有 mac-$ARCH 的 zip。去 https://github.com/$REPO/releases 看看。"
ok "找到 ${TAG:-最新版}"

# ---------- 2. 下 ----------
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
say "下载中（160 MB 左右，慢的话去倒杯水）…"
curl -fL --retry 3 --progress-bar -o "$TMP/owb.zip" "$URL" || die "下载失败。"
[ -s "$TMP/owb.zip" ] || die "下下来是个空文件，重跑一次试试。"

say "解压…"
/usr/bin/ditto -x -k "$TMP/owb.zip" "$TMP/out" || die "解压失败，八成是没下完。重跑一次。"
SRC="$(/usr/bin/find "$TMP/out" -maxdepth 2 -name '*.app' -print -quit)"
[ -n "$SRC" ] || die "包里没找到 .app，这不该发生——请开个 issue 带上这行输出。"

# ---------- 3. 放进应用程序 ----------
APPDIR="${OPENWORKBUDDY_APPDIR:-/Applications}"
if [ ! -w "$APPDIR" ]; then
  APPDIR="$HOME/Applications"
  mkdir -p "$APPDIR"
  say "/Applications 写不了，改装到 $APPDIR"
fi
DEST="$APPDIR/$(basename "$SRC")"
if [ -e "$DEST" ]; then
  # 反过来也要防一手：scripts/make-mac-app.sh 的开发壳固定写在 ~/Applications，
  # 跟上面这条「/Applications 写不了就退到 ~/Applications」正好撞在同一个名字上。
  # 那是个指向本机仓库的壳，删掉等于把人家的开发入口删了
  if grep -q "make-mac-app.sh" "$DEST/Contents/Resources/app/main.js" 2>/dev/null; then
    die "$DEST 是源码仓库的开发壳（scripts/make-mac-app.sh 生成的），没敢覆盖。换个地方装：OPENWORKBUDDY_APPDIR=\"$HOME/Desktop\" bash install-mac.sh"
  fi
  say "覆盖旧版本（你的配置和成果文件在 ~/OpenWorkBuddy，不会动）"
  rm -rf "$DEST"
fi
/bin/mv "$SRC" "$DEST" || die "移到 $APPDIR 失败。"

# 保险起见再摘一次隔离标记：curl 下的本来就没有，但万一 zip 是从别处拷来的
/usr/bin/xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

# 签名自愈：包里本来就带 ad-hoc 签名，但拷贝、同步盘、解压工具都可能把它弄坏。
# 坏了的话 Apple Silicon 上直接起不来，而且报的错是「已损坏」，看不出真正原因
if ! /usr/bin/codesign --verify --deep --strict "$DEST" >/dev/null 2>&1; then
  say "签名对不上，重新做一次 ad-hoc 签名…"
  /usr/bin/codesign --force --deep --sign - "$DEST" >/dev/null 2>&1 \
    || die "重签失败。装了 Xcode Command Line Tools 吗？xcode-select --install"
fi

ok "装好了：$DEST"
say "第一次打开要填个模型 API Key；你的东西都在 ~/OpenWorkBuddy，卸载不会删。"
# 只装不开：测试和批量部署要的是这个，不然每台机器都弹一个窗
if [ "${OPENWORKBUDDY_NO_OPEN:-}" = "1" ]; then exit 0; fi
/usr/bin/open "$DEST" || say "自动打开失败，去「应用程序」里双击它。"
