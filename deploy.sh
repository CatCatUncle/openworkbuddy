#!/usr/bin/env bash
# OpenWorkBuddy 服务器一键部署（Docker）
#
#   bash deploy.sh                              # 起在 127.0.0.1:3800，自己用 / 先试试
#   bash deploy.sh --domain buddy.example.com   # 带自动 HTTPS，直接对外能用
#   bash deploy.sh --update                     # 拉最新代码，重建，重启
#   bash deploy.sh --logs                       # 跟日志
#   bash deploy.sh --down                       # 停掉（数据留着）
#
# 数据全在 ./wb-data 一个目录里。容器随便删，那个目录别删。
#
# 这个脚本不装 Docker、不改防火墙、不动系统配置——那些得你自己点头。
# 缺什么它会告诉你怎么装。

set -euo pipefail

REPO_URL="${OPENWORKBUDDY_REPO:-https://github.com/CatCatUncle/openworkbuddy.git}"
DIR="${OPENWORKBUDDY_DIR:-$HOME/openworkbuddy}"

DOMAIN=""
ACTION="up"
BIND=""
PORT=""

say()  { printf "\033[1;34m▸\033[0m %s\n" "$*"; }
ok()   { printf "\033[1;32m✓\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m!\033[0m %s\n" "$*"; }
die()  { printf "\033[1;31m✗ %s\033[0m\n" "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; [ -n "$DOMAIN" ] || die "--domain 后面得跟域名"; shift 2 ;;
    --domain=*) DOMAIN="${1#*=}"; shift ;;
    --bind)   BIND="${2:-}";   shift 2 ;;
    --bind=*) BIND="${1#*=}";  shift ;;
    --port)   PORT="${2:-}";   shift 2 ;;
    --port=*) PORT="${1#*=}";  shift ;;
    --update) ACTION="update"; shift ;;
    --logs)   ACTION="logs";   shift ;;
    --down)   ACTION="down";   shift ;;
    -h|--help) sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "不认识的参数：$1（-h 看用法）" ;;
  esac
done

# ---------- 1. 环境 ----------
command -v docker >/dev/null 2>&1 || die "没装 Docker。
  Linux：curl -fsSL https://get.docker.com | sh
  macOS：https://www.docker.com/products/docker-desktop/
  装完记得 sudo usermod -aG docker \$USER 然后重新登录，不然每条命令都得 sudo。"

docker compose version >/dev/null 2>&1 || die "Docker 装了，但没有 compose 插件（docker compose）。
  Debian/Ubuntu：sudo apt-get install -y docker-compose-plugin
  或者升级到新版 Docker Desktop。"

docker info >/dev/null 2>&1 || die "Docker 守护进程没跑起来，或者当前用户没权限。
  systemctl start docker  ／  sudo usermod -aG docker \$USER 后重新登录"

ok "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '')"

# ---------- 2. 取代码 ----------
if [ -f "package.json" ] && grep -q '"name": "openworkbuddy"' package.json 2>/dev/null; then
  DIR="$(pwd)"
  say "就在当前目录部署：$DIR"
elif [ -d "$DIR/.git" ]; then
  say "已存在 $DIR"
else
  command -v git >/dev/null 2>&1 || die "没装 git"
  say "克隆到 $DIR"
  git clone --depth 1 "$REPO_URL" "$DIR"
fi
cd "$DIR"
[ -f docker-compose.yml ] || die "$DIR 里没有 docker-compose.yml，这不像是 OpenWorkBuddy 的目录"

# ---------- 3. .env ----------
if [ ! -f .env ]; then
  cp deploy/env.example .env
  ok "已生成 .env（照抄 deploy/env.example，没有任何密钥在里面）"
fi

# 把命令行参数写回 .env，这样下次不带参数跑也是同一套配置
setenv() {  # setenv KEY VALUE
  local k="$1" v="$2"
  if grep -qE "^${k}=" .env; then
    # BSD sed（macOS）和 GNU sed 的 -i 语法不一样，用临时文件绕开
    awk -v k="$k" -v v="$v" 'BEGIN{FS=OFS="="} $1==k{print k "=" v; next} {print}' .env > .env.tmp && mv .env.tmp .env
  else
    printf '%s=%s\n' "$k" "$v" >> .env
  fi
}
[ -n "$DOMAIN" ] && setenv WB_DOMAIN "$DOMAIN"
[ -n "$BIND" ]   && setenv WB_BIND   "$BIND"
[ -n "$PORT" ]   && setenv WB_PORT   "$PORT"

# 读回最终值（.env 是纯 KEY=VALUE，可以直接 source）
set -a; . ./.env; set +a
WB_HOME="${WB_HOME:-./wb-data}"
WB_BIND="${WB_BIND:-127.0.0.1}"
WB_PORT="${WB_PORT:-3800}"
WB_DOMAIN="${WB_DOMAIN:-}"

mkdir -p "$WB_HOME"

# 空数组在 macOS 自带的 bash 3.2 + set -u 下直接展开会报 unbound variable，
# 所以下面一律写成 ${PROFILE[@]+"${PROFILE[@]}"}
PROFILE=()
[ -n "$WB_DOMAIN" ] && PROFILE=(--profile https)

# ---------- 4. 干活 ----------
case "$ACTION" in
  logs) exec docker compose ${PROFILE[@]+"${PROFILE[@]}"} logs -f ;;
  down) docker compose ${PROFILE[@]+"${PROFILE[@]}"} down; ok "停了。数据还在 $WB_HOME，下次 bash deploy.sh 接着用"; exit 0 ;;
  update)
    if [ -d .git ]; then say "拉最新代码"; git pull --ff-only || warn "拉取失败（本地有改动？），用现有代码继续"; fi
    ;;
esac

say "构建镜像（第一次要几分钟，之后有缓存就快了）"
docker compose ${PROFILE[@]+"${PROFILE[@]}"} build

say "启动"
docker compose ${PROFILE[@]+"${PROFILE[@]}"} up -d

# ---------- 5. 等它真的活过来 ----------
say "等健康检查通过…"
HEALTHY=0
for _ in $(seq 1 60); do
  st="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' openworkbuddy 2>/dev/null || echo missing)"
  case "$st" in
    healthy) HEALTHY=1; break ;;
    unhealthy) break ;;
  esac
  # 容器可能直接挂了，别傻等满 5 分钟
  [ "$(docker inspect --format '{{.State.Running}}' openworkbuddy 2>/dev/null || echo false)" = "true" ] || break
  sleep 5
done

if [ "$HEALTHY" != "1" ]; then
  warn "没等到健康。最后 40 行日志："
  docker compose logs --tail=40 app || true
  die "起不来。常见原因：端口被占（换 --port）、config.json 写坏了（删掉 $WB_HOME/config.json 让它重建）。"
fi

if [ -n "$WB_DOMAIN" ]; then URL="https://$WB_DOMAIN"; else URL="http://$WB_BIND:$WB_PORT"; fi

cat <<EOF

$(ok "起来了：$URL")

  下一步（这两条别拖，尤其第一条）：

  1. 现在就打开 $URL 注册第一个账号。
     第一个注册的就是管理员，注册完之后默认不再允许别人自建账号。
     空着的实例挂在那儿，等于谁先访问谁是管理员。

  2. 填模型 API Key（界面会引导），填完当场发一条真请求验活，通过才存。
     Key 存在 $WB_HOME/config.json，不进镜像也不进 git。

  管理员登录后，头像菜单 → 企业管理后台，可以建组织、分席位、看用量、
  配组织级的安全策略（能不能跑命令行、能访问哪些域名、登录多久过期）。

  常用命令：
      bash deploy.sh --logs      跟日志
      bash deploy.sh --update    拉代码 + 重建 + 重启
      bash deploy.sh --down      停掉（数据留着）

EOF

if [ -z "$WB_DOMAIN" ] && [ "$WB_BIND" = "127.0.0.1" ]; then
  cat <<'EOF'
  现在只有这台机器自己连得上。要让别人也能用，二选一：
      bash deploy.sh --domain buddy.example.com     # 自带 HTTPS，推荐
      自己配 nginx 反代                              # 抄 deploy/README.md 里的配置

EOF
fi

if [ "$WB_BIND" = "0.0.0.0" ] && [ -z "$WB_DOMAIN" ]; then
  warn "你把它直接挂在 0.0.0.0 上，而且没有 HTTPS。这个 agent 手里有 run_shell，"
  warn "等于把这台机器的 shell 用明文 HTTP 挂到了公网。至少去设置 → 安全中心把命令审批打开。"
fi
