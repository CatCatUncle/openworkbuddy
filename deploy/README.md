# 部署

三种跑法，按你要干什么挑。

| 场景 | 怎么跑 | 说明 |
|---|---|---|
| 自己电脑上用 | `npm run app` | 桌面窗口 + 全局快捷键，**推荐** |
| 自己电脑，想用浏览器 | `npm start` → http://localhost:3800 | 只听本机 |
| 放服务器，团队共用 | `docker compose up -d` + 反代 | 看下面，别跳过安全那节 |

---

## 一键装（macOS / Linux）

```bash
bash install.sh
```

查 Node 版本 → 装依赖 → 生成 `config.json` → 起服务。
**API Key 不在脚本里填**，第一次打开界面会有引导页，填完当场发一条真实请求验活，通过才保存。

---

## Docker 部署到服务器

```bash
git clone <你的仓库> openworkbuddy && cd openworkbuddy
cp config.example.json config.json          # 必须先有这个文件，compose 是按文件挂的
mkdir -p data workspace
docker compose up -d
docker compose logs -f openworkbuddy            # 看它起来没
```

默认只把端口绑在 `127.0.0.1:3800`，外面用 nginx / Caddy 反代：

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

        # 任务是 SSE 流式推的，这两行不加会一直转圈
        proxy_buffering    off;
        proxy_read_timeout 3600s;
    }

    client_max_body_size 64m;               # 上传附件用
}
```

Caddy 更省事：

```
buddy.example.com {
    reverse_proxy 127.0.0.1:3800 {
        flush_interval -1
    }
}
```

---

## 不用 Docker，直接跑在服务器上（PM2）

```bash
npm install -g pm2
cp config.example.json config.json
HOST=127.0.0.1 PORT=3800 pm2 start server.js --name openworkbuddy
pm2 save && pm2 startup
```

---

## ⚠️ 安全（这节别跳过）

这个 agent 手里有 `run_shell`、能读写文件系统、能装 MCP 连接器。
**把它挂到公网 = 把这台机器的 shell 挂到公网。** 部署前至少做到：

1. **第一时间注册管理员账号**。第一个注册的账号就是管理员，注册完之后默认就不许别人自己注册了
   （管理员想开的话，去「账号」面板勾「允许别人自己注册账号」）。
   空库对外挂着，等于谁先访问谁是管理员。
2. **别绑 `0.0.0.0` 直接暴露**。默认 `HOST=127.0.0.1`，Docker 里为了让宿主机能连才设成 `0.0.0.0`，
   但 compose 里的端口映射仍然只绑回环。真要对外，前面必须有反代 + HTTPS。
3. **打开安全中心的闸门**：设置 → 安全中心，把 `gateway`（命令审批）打开，
   配好 `cmd_allow` / `cmd_ask`，删文件保护也开着。
4. **用独立的低权限账号跑**，别用 root；容器里也别 `--privileged`、别挂 `/`。
5. **API Key 只存在 `config.json`**，这个文件已经在 `.gitignore` 里，别手滑提交。
6. 需要更强隔离就每个用户一个容器，别指望应用层隔离。

---

## 常见问题

**起来了但界面一直转圈** — 反代没关缓冲。SSE 流被 nginx 攒着不发，加 `proxy_buffering off`。

**Docker 里生成 Word/PPT 中文变方块** — 缺中文字体，镜像里已经装了 `fonts-noto-cjk`；
自己精简过镜像的话补回来。

**端口被占** — `EADDRINUSE` 时进程不会重复起服务（桌面版会直接连已运行的实例），
换端口用 `PORT=3801 npm start`。

**改了技能要不要重启** — 不用。`skills/` 每次任务都重读磁盘，改完下一条任务就生效。
改 `config.json` 要重启（或者在界面设置里改，那是热生效的）。
