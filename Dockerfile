# OpenWorkBuddy 服务端镜像
#
#   构建 + 启动，一条命令：bash deploy.sh
#   手动：docker build -t openworkbuddy . && docker compose up -d
#
# ⚠️ 容器里的 agent 能执行 shell、能读写文件。容器本身是一层隔离，但请务必：
#    1. 端口只暴露给反向代理，别 -p 0.0.0.0:3800:3800 直接挂公网
#    2. 前面套 HTTPS（deploy.sh --domain 会自动配好 caddy）
#    3. 起来之后第一件事就是注册管理员账号——第一个注册的就是管理员，
#       空库对外挂着等于谁先访问谁是管理员

FROM node:20-bookworm-slim

# agent 常用的外部程序：python 跑技能脚本、git/curl 取东西、
# fonts-noto-cjk 是为了生成的 Word/PPT 里中文不变方块。
# 不需要就删这段，镜像能小一截。
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip ca-certificates git curl fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先只拷 package*.json：只要依赖没变，下面这层 npm install 就走缓存，
# 改一行业务代码重建只要几秒，不用重装几百个包。
COPY package*.json ./
# electron 是桌面壳，服务端用不上，跳过它那个上百 MB 的二进制下载
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN npm install --omit=dev

# 真正拷代码。哪些不拷见 .dockerignore——config.json、data/、workspace/
# 这些一律挡在外面，镜像层是只读快照，进去了就删不掉了。
COPY . .

# 所有会被写的东西都落在 /data：config.json、账号、会话、成果文件、技能、备份。
# compose 把宿主机的 ./wb-data 挂到这儿。
# 这里故意不写 VOLUME：写了的话每次重建容器都会多出一个匿名卷，
# 攒着占磁盘，还容易让人以为数据存在里面（其实挂载点被 compose 覆盖了）。
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3800 \
    OPENWORKBUDDY_HOME=/data
RUN mkdir -p /data
EXPOSE 3800

# 健康检查打的是不需要登录的 /api/auth/state。deploy.sh 靠它判断「真起来了」，
# compose 里的 caddy 也靠它决定什么时候开始转发。
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3800)+'/api/auth/state').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
