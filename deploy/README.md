# 部署

| 你想干什么 | 怎么跑 |
|---|---|
| 自己电脑上用 | `npm run app` — 桌面窗口 + 全局快捷键，**推荐** |
| 自己电脑，想用浏览器 | `npm start` → http://localhost:3800 （只听本机） |
| **放服务器，团队共用** | `bash deploy.sh` — 下面这一整节 |

---

## 一条命令部署到服务器

一台干净的 VPS（Ubuntu / Debian / 任何能跑 Docker 的），装好 Docker 之后：

```bash
git clone https://github.com/CatCatUncle/openworkbuddy.git && cd openworkbuddy
bash deploy.sh
```

它会：查 Docker → 生成 `.env` → 构建镜像 → 起容器 → **等健康检查真的通过** → 告诉你地址。
起不来它会把最后 40 行日志打出来，不会假装成功。

有域名的话，一步到位带 HTTPS（证书 Caddy 自己申请自己续）：

```bash
# 先把域名的 A 记录解析到这台服务器的 IP，再跑
bash deploy.sh --domain buddy.example.com
```

其它几条：

```bash
bash deploy.sh --logs      # 跟日志
bash deploy.sh --update    # 拉最新代码 → 重建 → 重启
bash deploy.sh --down      # 停掉（数据留着）
bash deploy.sh --port 3801 # 换端口
```

没装 Docker 的话，脚本会告诉你怎么装（它不会背着你改系统）：

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # 然后重新登录，不然每条命令都得 sudo
```

### 起来之后，这两件事别拖

1. **马上打开地址注册第一个账号。** 第一个注册的就是管理员，注册完之后默认不再允许别人自建账号。
   空实例挂在公网上，等于谁先访问谁是管理员。
2. **填模型 API Key**（界面会引导）。填完当场发一条真请求验活，通过才存。
   Key 落在 `openworkbuddy-data/config.json`，既不进镜像也不进 git。

管理员登录后，头像菜单 → **企业管理后台**：建组织、分席位、看用量、配组织级安全策略
（能不能跑命令行、能访问哪些域名、登录多久过期）。多租户的规则见下面「多租户」一节。

---

## 数据在哪

**全在 `./openworkbuddy-data` 一个目录里**：

```
openworkbuddy-data/
├── config.json      模型 Key、IM 配置
├── data/            账号、组织、席位、会话历史、用量账本
├── workspace/       成果文件（各租户按组织分子目录）
├── skills/          技能（首次启动从镜像里铺过来，之后你改你的）
├── plugins/         装的插件
└── backups/         备份
```

容器随便删随便重建，删了 `openworkbuddy-data` 才是真丢数据。备份就是把这个目录打包带走。

> **从旧版 compose 升级过来**：老版本按文件挂了五个 bind mount（`./config.json`、`./data`、
> `./workspace`、`./skills`、`./experts.json`）。新版只有一个卷。搬过去：
> ```bash
> mkdir -p openworkbuddy-data && mv config.json experts.json openworkbuddy-data/ && mv data workspace skills openworkbuddy-data/
> docker compose up -d --build
> ```

---

## 不用 Docker：systemd 直接跑（小内存机器推荐）

1 GB 内存的 VPS 上，`docker build` 那一步比跑起来还费劲（镜像带中文字体和 python，一个多 G）。
直接跑省心得多：13 个运行时依赖全是纯 JS，没有一个要编译。

```bash
# 1) 代码和 Node
sudo mkdir -p /opt/openworkbuddy && cd /opt/openworkbuddy
git clone https://github.com/CatCatUncle/openworkbuddy.git .
npm ci --omit=dev

# 2) 一个专门的系统用户。别用 root 跑——这个 agent 手里有 run_shell
sudo useradd --system --home-dir /var/lib/openworkbuddy --create-home --shell /usr/sbin/nologin openworkbuddy
sudo chmod -R a+rX /opt/openworkbuddy
```

> **Node 装在哪很要命。** 用 nvm 装在 `/root/.nvm/` 下面的话，服务起不来，报的是
> `status=203/EXEC`——一条完全看不出跟权限有关的错。原因是 `/root` 是 700，系统用户
> 连进都进不去，那个 node 对它来说等于不存在。把运行时整份拷到 `/opt/node`
> （`cp -a /root/.nvm/versions/node/vXX /opt/node && chmod -R a+rX /opt/node`）或者用发行版的包，
> 别让服务去读别人家目录里的东西。

`/etc/systemd/system/openworkbuddy.service`：

```ini
[Unit]
Description=OpenWorkBuddy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=openworkbuddy
WorkingDirectory=/opt/openworkbuddy
# 只听回环，外面那层 nginx/caddy 负责 HTTPS
Environment=HOST=127.0.0.1
Environment=PORT=3800
Environment=OPENWORKBUDDY_HOME=/var/lib/openworkbuddy
Environment=OPENWORKBUDDY_TRUST_PROXY=1
Environment=NODE_ENV=production
Environment=TZ=Asia/Shanghai
ExecStart=/opt/node/bin/node /opt/openworkbuddy/server.js
Restart=always
RestartSec=3
# 1G 内存的机器：到顶先杀自己，三秒后再拉起来，别把整台机器拖进 swap 死地
MemoryMax=600M
OOMPolicy=continue
# 它只该往数据目录里写
ProtectSystem=full
ReadWritePaths=/var/lib/openworkbuddy
PrivateTmp=true
NoNewPrivileges=true
StandardOutput=append:/var/log/openworkbuddy.log
StandardError=append:/var/log/openworkbuddy.log

[Install]
WantedBy=multi-user.target
```

```bash
sudo touch /var/log/openworkbuddy.log && sudo chown openworkbuddy /var/log/openworkbuddy.log
sudo systemctl enable --now openworkbuddy
systemctl status openworkbuddy
```

日志记得 logrotate（`/etc/logrotate.d/openworkbuddy`，`copytruncate` + `su openworkbuddy openworkbuddy`），
不然几个月后它会一个人吃掉半块盘。

更新就是「拉代码 → 装依赖 → 重启」，数据在 `/var/lib/openworkbuddy` 不受影响：

```bash
cd /opt/openworkbuddy && git pull && npm ci --omit=dev && sudo systemctl restart openworkbuddy
```

嫌 systemd 啰嗦也可以 PM2：

```bash
npm install -g pm2
HOST=127.0.0.1 PORT=3800 OPENWORKBUDDY_HOME=$HOME/openworkbuddy-data pm2 start server.js --name openworkbuddy
pm2 save && pm2 startup
```

---

## 自己配反代（不用脚本自带的 Caddy）

nginx：

```nginx
server {
    listen 443 ssl http2;
    server_name buddy.example.com;

    ssl_certificate     /etc/letsencrypt/live/buddy.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/buddy.example.com/privkey.pem;

    location / {
        proxy_pass         http://127.0.0.1:3800;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;

        # 这两行不是可选的，见下面「挂了反代，记得告诉它」：
        # 少了 X-Forwarded-For，全公司共用一个 IP，注册和登录限流会把大家一起锁在门外；
        # 少了 X-Forwarded-Proto，服务端不知道外面是 https，登录 cookie 就发不出 Secure。
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;

        # 任务是 SSE 一行一行推的，这两行不加会一直转圈
        proxy_buffering    off;
        proxy_read_timeout 3600s;
    }

    client_max_body_size 64m;               # 上传附件用
}
```

Caddy（这两个头它自己会带，不用配）：

```
buddy.example.com {
    reverse_proxy 127.0.0.1:3800 {
        flush_interval -1
    }
}
```

### 挂了反代，记得告诉它：`OPENWORKBUDDY_TRUST_PROXY`

自己配反代的话，**这一步必须做**，不然会撞上一个很难往「限流」上想的故障：

> 十个人的团队开号，前五个顺利注册，第六个开始一直提示「注册太频繁了，xxx 秒后再试」。
> 或者：有人连着输错几次密码，结果**全公司**都登不进去了。

原因是服务端两道防连打的闸都按 IP 算——注册 5 次/15 分钟、登录失败 30 次/15 分钟。
挂上反代之后，所有请求在服务端看来都来自反代那**一个** IP，于是「防一个人连打」
变成了「全公司共用一个额度」。

```bash
# .env
OPENWORKBUDDY_TRUST_PROXY=1     # 前面就一层你的 nginx/caddy
OPENWORKBUDDY_TRUST_PROXY=2     # Cloudflare → 你的 nginx → 本应用
```

用 `bash deploy.sh --domain <域名>` 的话不用管，脚本自己会填 1（那层 caddy 是它起的）。

**没有反代就别填。** 这个开关默认是 0，不是忘了打开——直连的情况下打开它，
等于谁往请求里塞一行 `X-Forwarded-For: 随便什么` 就换一个新 IP，限流闸直接废掉。
打开之后服务端也只信两种情况：请求是从私网/环回地址进来的（也就是真有一层反代在本机），
并且只认从右往左数第 N 跳——最左边那一跳恰好是客户端唯一能伪造的，所以永远不取它。

---

## 手机连回家里那台（不把桌面版挂到公网）

常见的需求不是「再开一台服务器」，而是「人在外面，想看家里那台电脑上的 agent 在干什么、
接着指挥它」。**工程线连着的就是那台机器的 `openworkbuddy` 命令行，办公线里的对话、历史、成果文件
也都是那台机器上的**——所以要的是把桌面版那台**接出来**，不是在服务器上再开一份。

别为这件事把桌面版绑到 `0.0.0.0`。桌面版按 `Electron 壳 + 只听回环` 判定为「个人模式」，
这个模式下平台闸和凭证脱敏是关着的（一个人的机器不该被服务器的规矩管）；一旦它开始听公网，
这个前提就不成立了。正确的做法是 SSH 反向隧道 —— 家里那台**主动往外连**，
不需要公网 IP、不需要在路由器上开端口、不需要动防火墙。

家里那台（macOS 为例，Linux 同理，换成 systemd user unit）：

```bash
brew install autossh
autossh -M 0 -N -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
        -o ExitOnForwardFailure=yes \
        -R 13800:127.0.0.1:3800 root@你的服务器
```

> `-R` 后面**必须写 `127.0.0.1`，不能写 `localhost`**。桌面版只绑 IPv4 回环，
> 而 macOS 上 `localhost` 先解析成 `::1`，偏偏 ssh 的端口转发不做 Happy Eyeballs 回退
> （curl / Node / Python 都会，唯独它不会）。写错的表现极具迷惑性：服务器上那个口
> 照常 `LISTEN`，但每个请求都超时。

想开机自起、断线自重连，macOS 上写成 LaunchAgent（`KeepAlive` + `RunAtLoad`），
Linux 上写成 `systemd --user` 服务。

服务器那头（nginx）：

```nginx
# 这个 map 放在 http 块里（conf.d/*.conf 本来就在 http 块里，直接写文件开头就行）。
# 漏了它 nginx 起不来，报 unknown "connection_upgrade" variable。
map $http_upgrade $connection_upgrade { default upgrade; "" close; }

server {
    listen 9444 ssl;
    server_name 你的域名或IP;
    ssl_certificate     /path/fullchain.pem;
    ssl_certificate_key /path/privkey.pem;

    # 第二把锁。应用自己的登录闸照常在，但家里那台手里就是你本人电脑的 shell，
    # 值得在外面再加一道——而且它把扫端口的脚本挡在应用之外，连登录页都碰不到。
    auth_basic           "Remote";
    auth_basic_user_file /etc/nginx/ssl/remote.htpasswd;

    client_max_body_size 64m;
    location / {
        proxy_pass         http://127.0.0.1:13800;   # 隧道那头
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection $connection_upgrade;
        proxy_buffering    off;      # SSE 和终端那条线都是长连接
        proxy_read_timeout 3600s;
    }
}
```

`htpasswd` 文件记得 `chown root:nginx` + `640`。只 `chmod 640 root:root` 的话，
不带密码访问正常返回 401、**带**密码反而 500（worker 读不动那个文件），
错法很容易被当成密码错。

没有域名也能上 HTTPS：Let's Encrypt 现在给 IP 签证书（`--cert-profile shortlived`，
6 天有效期，acme.sh 的 cron 自己续）。手机上直接绿锁，不用装自签 CA。
`--webroot` 别用 standalone 模式——80 口被 nginx 占着，standalone 会一直续不上，
而这种失败是静默的：证书过期那天你才发现它从几个月前就没续过。

**家里那台睡着 = 502。** 这不是故障，是那头不在。真要随时能连，把电脑的自动睡眠关掉。

---

## 多租户

一个进程可以同时给多家公司用。边界划在**工作区**，不是机器：

| 隔离（各租户互相看不见） | 不隔离（归平台管理员） |
|---|---|
| 成果文件、会话、账号、席位 | 模型引擎与 API Key |
| 用量账本、权限、审计 | MCP 连接器、技能、专家、记忆库 |
| 组织级安全策略 | 定时任务、备份、桌面窗口 |

三种角色：

- **平台管理员** = 默认组织的管理员。引擎、密钥、定时任务这些服务器级的东西只有他能改。
- **组织管理员** = 某家公司的管理员。管自己的人、自己的席位、自己的安全策略；碰不到服务器级设置，
  也读不到 API Key。
- **审计员** = 能查账，改不动。企业后台他进得去，页面上所有输入框是禁用的。

组织级安全策略这四个开关是**真的会拦人**的，不是摆设：

| 开关 | 拦在哪 |
|---|---|
| `allow_shell` | 关掉之后，`run_shell` / `run_node` 在**工具定义层**就被摘掉了。模型压根看不见这两个工具，不会先规划一个命令行方案、挨一次拒绝再重来 |
| `net_allow` | 白名单。域名比对带点边界，`example.com` 不会顺带放行 `evilexample.com` |
| `net_deny` | 黑名单，优先级高于白名单 |
| `session_days` | 在**读 token** 时判过期。把 30 天改成 1 天，已经发出去的 cookie 当场作废 |

---

## ⚠️ 安全（这节别跳过）

这个 agent 手里有 `run_shell`、能读写文件系统、能装 MCP 连接器。
**把它裸挂到公网 = 把这台机器的 shell 挂到公网。** 部署前至少做到：

1. **第一时间注册管理员账号**（见上面）。
2. **别把 `OPENWORKBUDDY_BIND` 改成 `0.0.0.0` 然后就不管了**。默认只绑回环，外面必须走反代 + HTTPS。
   `deploy.sh --domain` 会把这套配好。
3. **打开安全中心的闸门**：设置 → 安全中心，把 `gateway`（命令审批）打开，配好
   `cmd_allow` / `cmd_ask`，删文件保护也开着。
4. **组织级把命令行关掉**：企业后台 → 企业设置 → 网络设置，不需要跑命令的租户直接关 `allow_shell`。
5. **API Key 只在 `openworkbuddy-data/config.json`**。这个文件在 `.gitignore` 和 `.dockerignore` 里都有——
   镜像层是只读快照，Key 一旦烤进去，push 到任何 registry 就是公开，还删不掉。
6. **别 `--privileged`、别挂 `/`**、别用 root 跑宿主机上的 docker 命令。
7. 要更强隔离就一个租户一个容器，别指望应用层隔离扛住恶意用户。

---

## 常见问题

**起来了但界面一直转圈** — 反代没关缓冲。SSE 流被 nginx 攒着不发，加 `proxy_buffering off`；
Caddy 是 `flush_interval -1`。

**技能列表是空的** — 数据目录是不是手动指到了一个新地方，而且是老版本？
`server.js` 现在启动时会把镜像里的内置技能铺过去（`seedDataDir()`），老版本只有桌面版会做这件事。

**Docker 里生成 Word/PPT 中文变方块** — 缺中文字体。镜像里装了 `fonts-noto-cjk`，
自己精简过 Dockerfile 的话补回来。

**端口被占** — `bash deploy.sh --port 3801`。

**改了技能要不要重启** — 不用。`skills/` 每次任务都重读磁盘。改 `config.json` 要重启，
或者直接在界面设置里改（那是热生效的）。

**镜像多大** — 带中文字体和 python 大概 1 GB 出头。不需要文档转换的话，把 Dockerfile 里
`apt-get install` 那段删掉能小一大半。
