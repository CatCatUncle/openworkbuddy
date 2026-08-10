#!/usr/bin/env bash
# OpenWorkBuddy 一键安装（macOS / Linux）
#
#   curl -fsSL https://raw.githubusercontent.com/<你的仓库>/main/install.sh | bash
# 或者克隆下来后：
#   bash install.sh
#
# 这个脚本只干四件事：查环境 → 装依赖 → 备好 config.json → 起服务。
# API Key 不在这里填，第一次打开界面会有引导页，在那儿填并且当场验活。

set -euo pipefail

REPO_URL="${OPENWORKBUDDY_REPO:-https://github.com/CatCatUncle/openworkbuddy.git}"
DIR="${OPENWORKBUDDY_DIR:-$HOME/openworkbuddy}"
PORT="${PORT:-3800}"

say()  { printf "\033[1;34m▸\033[0m %s\n" "$*"; }
ok()   { printf "\033[1;32m✓\033[0m %s\n" "$*"; }
die()  { printf "\033[1;31m✗ %s\033[0m\n" "$*" >&2; exit 1; }

# ---------- 1. 环境 ----------
command -v node >/dev/null 2>&1 || die "没装 Node.js。装一个再来：https://nodejs.org （要 18 以上）
  macOS 有 Homebrew 的话：brew install node"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node 版本太老（当前 v$(node -p 'process.versions.node')），要 18 以上。"
ok "Node v$(node -p 'process.versions.node')"

# ---------- 2. 取代码 ----------
if [ -f "package.json" ] && grep -q '"name": "openworkbuddy"' package.json 2>/dev/null; then
  DIR="$(pwd)"                      # 已经在项目目录里跑，就地安装
  say "就在当前目录安装：$DIR"
elif [ -d "$DIR/.git" ]; then
  say "已存在 $DIR，拉取更新"
  git -C "$DIR" pull --ff-only || say "拉取失败（本地有改动？），继续用现有代码"
else
  command -v git >/dev/null 2>&1 || die "没装 git"
  say "克隆到 $DIR"
  git clone --depth 1 "$REPO_URL" "$DIR"
fi
cd "$DIR"

# ---------- 3. 依赖 ----------
if command -v pnpm >/dev/null 2>&1; then
  say "用 pnpm 装依赖（多项目共享，省磁盘）"
  pnpm install --prod=false
else
  say "用 npm 装依赖"
  npm install
fi
ok "依赖装好了"

# ---------- 4. 配置 ----------
if [ ! -f config.json ]; then
  cp config.example.json config.json
  ok "已生成 config.json（模型 Key 待会儿在界面里填）"
else
  ok "config.json 已存在，不覆盖"
fi

mkdir -p workspace data

# ---------- 5. 起服务 ----------
cat <<EOF

$(ok "装完了")

  桌面版（推荐，带窗口和全局快捷键）：
      cd $DIR && npm run app

  纯服务端（浏览器访问 http://localhost:$PORT）：
      cd $DIR && npm start

  命令行：
      cd $DIR && npm run cli -- "帮我写一份本周周报"

第一次打开会让你填模型 API Key，填完当场验活，通过才保存。
默认只监听 127.0.0.1；要放到局域网/公网请看 deploy/README.md，别裸奔——
这个进程手里有 run_shell。

EOF

if [ "${OPENWORKBUDDY_AUTOSTART:-1}" = "1" ] && [ -t 1 ]; then
  read -r -p "现在就起服务吗？[Y/n] " ans
  case "${ans:-Y}" in
    [Yy]*|"") exec npm start ;;
  esac
fi
