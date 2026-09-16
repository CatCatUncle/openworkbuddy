#!/bin/bash
set -euo pipefail

# macOS 直接运行 node_modules/Electron.app 时，Dock 和菜单栏会把应用叫作 Electron。
# 开发态也使用项目自己的 OpenWorkBuddy.app 外壳，代码仍然从当前仓库加载，但系统看到的
# Bundle 名称、Dock 提示和 Cmd+Tab 名称都会保持为 OpenWorkBuddy。
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ "$(uname -s)" = "Darwin" ] && [ "${OPENWORKBUDDY_DEV_ELECTRON:-}" != "1" ]; then
  bash "$ROOT/scripts/make-mac-app.sh"
  open "$HOME/Applications/OpenWorkBuddy.app"
else
  exec "$ROOT/node_modules/.bin/electron" "$ROOT"
fi
