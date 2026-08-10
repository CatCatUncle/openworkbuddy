# OpenBuddy 服务端镜像
#
# ⚠️ 这个容器里的 agent 能执行 shell、读写文件。容器给了一层隔离，但请务必：
#    1. 只把端口暴露给反向代理，不要直接 -p 0.0.0.0:3800:3800 挂公网
#    2. 前面套 HTTPS
#    3. 第一次打开先注册管理员账号（第一个注册的就是管理员），别留着空库对外
#
# 构建：docker build -t openbuddy .
# 运行：见 docker-compose.yml

FROM node:20-bookworm-slim

# agent 常用的外部程序：python 跑技能脚本、pandoc/libreoffice 转文档、
# chromium 给需要浏览器的技能用。不想要就把这段删掉，镜像能小一大半。
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip ca-certificates git curl fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
# electron 是桌面壳，服务端用不上，跳过它的二进制下载
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN npm install --omit=dev

COPY . .

# 工作目录和账号数据都挂卷出来，容器可以随便重建
RUN mkdir -p /app/workspace /app/data
VOLUME ["/app/workspace", "/app/data"]

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3800
EXPOSE 3800

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3800)+'/api/auth/state').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
