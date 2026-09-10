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
   Key 落在 `wb-data/config.json`，既不进镜像也不进 git。

管理员登录后，头像菜单 → **企业管理后台**：建组织、分席位、看用量、配组织级安全策略
（能不能跑命令行、能访问哪些域名、登录多久过期）。多租户的规则见下面「多租户」一节。

---

## 数据在哪

**全在 `./wb-data` 一个目录里**：

```
wb-data/
├── config.json      模型 Key、IM 配置
├── data/            账号、组织、席位、会话历史、用量账本
├── workspace/       成果文件（各租户按组织分子目录）
├── skills/          技能（首次启动从镜像里铺过来，之后你改你的）
├── plugins/         装的插件
└── backups/         备份
```

容器随便删随便重建，删了 `wb-data` 才是真丢数据。备份就是把这个目录打包带走。

> **从旧版 compose 升级过来**：老版本按文件挂了五个 bind mount（`./config.json`、`./data`、
> `./workspace`、`./skills`、`./experts.json`）。新版只有一个卷。搬过去：
> ```bash
> mkdir -p wb-data && mv config.json experts.json wb-data/ && mv data workspace skills wb-data/
> docker compose up -d --build
> ```

---

## 不用 Docker：PM2 直接跑

```bash
npm install -g pm2
HOST=127.0.0.1 PORT=3800 OPENWORKBUDDY_HOME=$HOME/wb-data pm2 start server.js --name openworkbuddy
pm2 save && pm2 startup
```

`OPENWORKBUDDY_HOME` 不设也行，那样数据就散在代码目录里（开发态的行为），`git pull` 的时候容易碍事。

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

        # 任务是 SSE 一行一行推的，这两行不加会一直转圈
        proxy_buffering    off;
        proxy_read_timeout 3600s;
    }

    client_max_body_size 64m;               # 上传附件用
}
```

Caddy：

```
buddy.example.com {
    reverse_proxy 127.0.0.1:3800 {
        flush_interval -1
    }
}
```

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
2. **别把 `WB_BIND` 改成 `0.0.0.0` 然后就不管了**。默认只绑回环，外面必须走反代 + HTTPS。
   `deploy.sh --domain` 会把这套配好。
3. **打开安全中心的闸门**：设置 → 安全中心，把 `gateway`（命令审批）打开，配好
   `cmd_allow` / `cmd_ask`，删文件保护也开着。
4. **组织级把命令行关掉**：企业后台 → 企业设置 → 网络设置，不需要跑命令的租户直接关 `allow_shell`。
5. **API Key 只在 `wb-data/config.json`**。这个文件在 `.gitignore` 和 `.dockerignore` 里都有——
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
