# OpenWorkBuddy

**腾讯 WorkBuddy 的开源复刻版。** 一句话下任务，AI 自己规划、拆解、动手，交付能打开验收的成果文件——PPT、Word、Excel、网页、调研报告、公众号推文。

不绑定任何一家大模型。DeepSeek / 通义 Qwen / 智谱 GLM / Kimi / OpenRouter / Ollama 本地模型，界面里点一下就切。

> 作者：开发者猫叔 · 个人与非商业用途免费，商业使用需要单独授权（见 [LICENSE](LICENSE) 与 [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md)）

---

## 30 秒跑起来

```bash
bash install.sh          # 查环境 → 装依赖 → 生成配置 → 起服务
```

或者手动：

```bash
npm install
npm run app              # 桌面版（Electron 窗口，推荐）
npm start                # 纯服务端，浏览器开 http://localhost:3800
npm run cli -- "帮我写一份本周周报"   # 命令行
```

**API Key 不用手动填进配置文件。** 第一次打开会弹引导页，选服务商、粘 Key，
它会当场发一条真实请求验活，通过了才保存——不会让你等到发第一条消息才发现 Key 是错的。

国内装 Electron 慢的话：`export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`

---

## 它能干什么

| | |
|---|---|
| 🤖 **Agent 自主执行** | 自然语言 → 规划 → 工具循环 → 交付文件，每一步在工作台实时可见 |
| 🎚️ **Ask / Plan / Craft** | 只问答 / 只出计划 / 完整执行，输入框旁一键切换 |
| 🧩 **专家 · 技能 · 连接器** | 三合一广场：召唤专家、装技能、接 MCP 连接器 |
| 👥 **专家 与 专家团** | 12 位内置专家 + 4 个专家团；也可以自己建：头像、职称、说明、绑技能、默认提示词 |
| 📦 **技能系统** | 一个 Markdown 文件就是一个技能，**改完下一条任务就生效**，不用重启 |
| 🔌 **MCP 连接器** | 标准 Model Context Protocol（stdio / Streamable HTTP），接进来的工具自动注入 agent |
| 🧷 **Agent Plugins** | 支持 [Agent Plugins 1.0.0](https://agent-plugins.org) 开放插件标准，一个包同时带技能和 MCP，粘个 GitHub 地址就装 |
| 📱 **IM 远程指挥** | 飞书、QQ、企业微信（自建应用 / 群机器人）、微信（iLink 扫码 / 公众号）、钉钉、通用 Webhook |
| ⏰ **自动化定时任务** | cron 定时跑（每天 9 点出晨报这种），结果推到 IM |
| 🔐 **安全中心** | 命令审批闸门、命令黑白名单、删文件保护、URL 白名单、运行时开关、审计日志 |
| 👤 **账号与积分** | 多用户、管理员开号、按任务扣积分、用量统计 |
| 📚 **参考模板库** | 提示词范例，不知道怎么开口的时候抄一份改 |
| 🌐 **本地部署预览** | 做完网页一键起本机服务，相对路径 / fetch / localStorage 才是真的能用；可放开给手机看 |

### 内置技能

`deep-research` 深度调研 · `html-page` 网页生成 · `ppt-design` PPT · `docx` Word ·
`excel-report` Excel 报表 · `data-viz` 数据可视化 · `weekly-report` 周报 ·
`wechat-article` 公众号推文（排版 + 推草稿箱）· `feishu-doc` 飞书文档 ·
`lark-cli` 飞书全家桶命令行（消息/文档/多维表格/日历/任务/审批/邮件）· `skill-creator` 让它自己写技能

### 内置工具

`run_node` `run_shell` `write_file` `read_file` `list_files` `fetch_url` `web_search`
`save_skill` `library_list` `library_read` `generate_image` `generate_video`

---

## 模型配置

界面里 **设置 → 模型** 直接改，保存即热生效。手动改 `config.json` 也行：

```jsonc
{
  "models": [
    {
      "name": "DeepSeek",                          // 界面上显示的名字
      "provider": "openai",                        // openai 兼容 / anthropic
      "base_url": "https://api.deepseek.com/v1",
      "api_key": "sk-...",
      "model": "deepseek-chat"
    }
  ],
  "active_model": "DeepSeek"
}
```

| 服务商 | base_url | model 示例 |
|---|---|---|
| OpenRouter（一个 Key 通吃） | `https://openrouter.ai/api/v1` | `deepseek/deepseek-chat` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| 通义 Qwen | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-max` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-plus` |
| Kimi | `https://api.moonshot.cn/v1` | `moonshot-v1-32k` |
| Ollama 本地 | `http://localhost:11434/v1` | `qwen3:14b` |

模型条目还能带 `extra_body`，透传厂商私有参数（比如 OpenRouter 的 `reasoning`）。

---

## 技能：一个 Markdown 文件

`skills/<名称>/skill.md`：

```markdown
---
name: my-skill
description: 一句话说清什么时候该用它（agent 靠这句判断）
---

## 操作步骤
1. ……
```

启动时只把 `description` 注入系统提示；agent 觉得用得上，才用 `use_skill` 加载正文——
所以技能可以写得很长，不占上下文。同目录下放 `scripts/`、`templates/` 都行，agent 能用到。

**技能是热的**：每次任务重读磁盘，改完存盘，下一条任务就是新的。

不想自己写？让它写：`skill-creator` 技能就是干这个的。

---

## MCP 连接器

`config.json` 的 `mcp_servers`，本地进程和远程服务两种都能接：

```json
"mcp_servers": [
  { "name": "filesystem", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/data"] },
  { "name": "notion", "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer 你的令牌" } }
]
```

- 填 `command` 就是本地 stdio；填 `url` 就是远程 Streamable HTTP，界面上也有对应的两个选项。
- 请求头里多半是令牌，所以 `GET /api/mcp` 只回**头的名字**不回值；在界面上改别的字段存回去时，原来的令牌会自动沿用。
- 带请求头又走明文 `http://` 的远程地址会被拒（本机 `localhost` 除外）——令牌不该在路上裸奔。

服务器暴露的工具会以 `mcp__服务器名__工具名` 的形式自动注入。界面里 **专家 · 技能 · 连接器 → 连接器** 页也能管。

---

## Agent Plugins（开放插件标准）

OpenWorkBuddy 支持 [**Agent Plugins 1.0.0**](https://agent-plugins.org)——由 Vercel 等厂商共同制定的、
不绑定任何客户端的插件格式。**一个包同时带技能和 MCP 连接器，装一次两样都进来**，
在别的支持这个标准的客户端里也能用同一个包。

### 插件长什么样

一个目录，根上放一份 `plugin.json`：

```
my-plugin/
├── plugin.json           必需，插件清单
├── skills/               Agent Skills，每个子目录一份 SKILL.md
│   └── my-skill/SKILL.md
├── mcp.json              MCP 服务器声明
└── com.example.client/   别家客户端的私有扩展（反向域名命名，我们原样忽略）
```

`plugin.json` 最小可用形态：

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "一句话说清它是干什么的",
  "license": "MIT"
}
```

`mcp.json` 和 MCP 官方配置一个样，多了两个可以在 `args` / `env` 值 / `cwd` 里展开的变量：

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "notes": {
      "type": "stdio",
      "command": "node",
      "args": ["${PLUGIN_ROOT}/bin/server.js", "--data", "${PLUGIN_DATA}"]
    }
  }
}
```

`${PLUGIN_ROOT}` 是插件装在哪，`${PLUGIN_DATA}` 是给它的可写数据目录——
落在 `data/plugin-data/<插件名>`，**卸载插件不会删它**，重装数据还在（规范要求跨升级保留）。

### 怎么装

界面 **专家 · 技能 · 连接器 → 插件** 页，粘一个 GitHub 地址点安装：

```
https://github.com/owner/repo                          仓库根就是插件
https://github.com/owner/repo/tree/main/plugins/xxx    仓库里的某个子目录
```

走稀疏浅克隆（`--depth 1 --filter=blob:none --sparse`），只拉那一个子目录。
**先在临时目录验一遍清单，不合规就不落盘**，免得 `plugins/` 里堆一堆装不上的垃圾。
也可以直接把目录拷进 `plugins/`，重启即生效。

技能和 MCP 服务器都是**装完立刻生效、卸载立刻停**，不用重启应用——
卸载是先停进程再删目录（顺序反了就查不出它带过哪些服务器，子进程会一直挂着）。

### 更新

从地址装的插件，卡片上会多一个「更新」按钮，按当初那个地址重新拉一遍。
安装来源记在 `data/plugin-sources.json`（记在插件目录**外面**，不然重装时正好被自己删掉）。
版本号没变也照拉——上游经常只改内容不动版本。手动拷进 `plugins/` 的没有来源，也就没有这个按钮。

### 一致性范围（本客户端实现到哪）

| | |
|---|---|
| 规范版本 | 1.0.0（`$schema` 按本地已知常量校验，**加载时不联网取 schema**，规范明令禁止） |
| 组件类型 | `skills` + `mcp.json` 两类都实现 |
| MCP 传输 | `stdio`、`streamable-http`。`sse`（遗留 HTTP+SSE）规范里是可选项，**没实现**，遇到会跳过那一条并报出来 |
| 客户端扩展 | `extensions` 字段和 `com.*/` 目录一律不解读、不校验——那是别家客户端的地盘 |
| 技能发现 | 只认 `skills/` 的直接子目录里名字**正好是 `SKILL.md`** 的文件，不递归（macOS 文件系统不分大小写，这里是逐个比目录项名，不是 `stat` 一下就算） |
| HTTP 安全 | `redirect: "manual"`——配置里的 `headers` 绝不会跟着跳转发到别的域 |

### 坏零件不连坐

规范定了五级失败边界，这里照着实现：

1. **清单不合规** → 整个插件不加载（只有两种例外是非致命的：顶层多了不认识的字段、`extensions` 不是对象，这两种报一声继续装）
2. **`mcp.json` 顶层坏了** → 只关掉这个插件的 MCP，技能照常用
3. **某个技能目录坏了** → 只跳过那一个技能
4. **某条 MCP 条目坏了** → 只跳过那一条服务器
5. **路径想往插件目录外跑** → 直接拒绝

被跳过的零件不会闷声吞掉，插件卡片上会列出来（「⚠️ 有零件被跳过」）。

插件带来的技能和连接器在界面上是**只读**的——技能页没有改 / 删按钮，连接器页也不会把它们存回你的 `config.json`，
要去掉就去插件页卸载整个插件。

---

## 专家与专家团

`experts.json` 定义专家——每个专家就是一份独立系统提示的子智能体，和主 Agent 共享工作目录。
主 Agent 拿到复杂任务会自己拆（调研 → 分析 → 写作 → 做 PPT），用 `delegate_to_expert` 逐段委派。

**专家团**是打包好的多人协作阵型（调研出报告、汇报三件套、网页交付组、内容发布组），
`delegate_to_team` 一次派整团。

界面上可以自己建专家：头像、职称、一句话说明、绑哪些技能、默认提示词。

---

## IM 远程指挥

在手机上给它下任务，干完推回来。

| 渠道 | 要不要公网 | 说明 |
|---|---|---|
| 飞书 | 不要 | 长连接，填 `app_id` / `app_secret` 就行；另可**扫码**授权你本人的身份（见下） |
| QQ | 不要 | 官方机器人 WebSocket 长连接 |
| 微信 iLink | 不要 | 扫码登录 + 长轮询 |
| 企业微信自建应用 | 要 | 回调地址得能被访问到 |
| 微信公众号 | 要 | 同上 |
| 企业微信群机器人 / 钉钉 | 不要 | 只推结果，不收指令 |
| 通用 Webhook | 看你怎么接 | 桥接任何东西 |

通用 Webhook 长这样：

```bash
curl -X POST http://localhost:3800/im/task \
  -H "Content-Type: application/json" \
  -d '{"message": "帮我生成本周周报", "secret": "你配的密钥"}'
```

同步返回 `{ reply, files }`。iOS 快捷指令、自动化平台、你自己的脚本，都能接。

### 飞书扫码授权

**设置 → 助理设置 → 飞书 → 扫码授权**，用飞书 App 扫一下，AI 就能以**你本人**的身份读日历、翻云文档、
查邮件、写多维表格（走飞书官方设备码流程，密码不经过 OpenWorkBuddy）。依赖本机的
[lark-cli](https://github.com/larksuite/cli)（MIT）：`npx @larksuite/cli@latest install`。

> 说清楚免得误会：机器人**收消息**必须有应用的 `app_id` + `app_secret`，这是飞书的设计，扫码替代不了。
> 扫码解决的是另一半——用户身份的 API 调用。两者互不冲突，可以只配一个。

---

## 定时任务

界面 **自动化 → 定时任务** 里加，或者调 API：

```bash
curl -X POST http://localhost:3800/api/schedules \
  -H "Content-Type: application/json" \
  -d '{"name": "每日晨报", "cron": "0 9 * * 1-5", "task": "抓今天的 AI 行业新闻，生成晨报 markdown"}'
```

cron 5 字段（分 时 日 月 周），支持 `*` `,` `-` `*/n`。

---

## 部署

```bash
docker compose up -d
```

细节、反代配置、PM2 跑法、以及**安全须知**都在 [deploy/README.md](deploy/README.md)。

> ⚠️ 这个 agent 手里有 `run_shell`。**把它挂到公网 = 把这台机器的 shell 挂到公网。**
> 默认只监听 `127.0.0.1`；要放出去，先看部署文档那节安全须知，别裸奔。

---

## 项目结构

```
server.js        Web API + SSE + 各种端点
agent.js         Agent 运行时（协调者/专家循环、工具路由、系统提示）
llm.js           LLM 适配层（OpenAI 兼容 + Anthropic）
tools.js         内置工具
skills.js        技能加载器            skills/       技能包
plugins.js       Agent Plugins 1.0.0   plugins/      已装插件
mcp.js           MCP 客户端（stdio / Streamable HTTP）
account.js       账号 / 积分 / 鉴权
security.js      安全中心（审批闸门、黑白名单、审计）
experts.json     专家与专家团定义
im.js            IM 总线            im-qq.js / im-wechat.js / im-ilink.js
scheduler.js     定时任务
electron-main.js 桌面壳             cli.js        命令行
public/          前端（单文件，没有构建步骤）
workspace/       成果文件输出        data/         账号与会话
```

前端是一个手写的 `public/index.html`，没有框架、没有打包器。改完刷新就行。

---

## 测试

```bash
npm test          # 端到端，用模拟 LLM，不需要 API Key
```

覆盖：cron 解析、workspace 路径越界拦截、成果核验闸门（缺文件 / 0 字节空壳）、
`run_node` 语法预检、上下文预算截断、Word/PPT/Excel 生成、
Agent Plugins（清单校验 / 坏零件隔离 / `${PLUGIN_ROOT}` 展开 / 技能并流与重名让位）、
MCP Streamable HTTP（JSON 与 SSE 两种响应、会话 ID）、
Agent 全管线（技能加载 → 代码执行 → 专家委派 → 事件流）。

---

## 协议

[PolyForm Noncommercial 1.0.0](LICENSE)：个人、学习、学术、非营利、政府用途**免费**。
公司内部使用、对外提供服务、二次销售等商业场景，需要单独授权 —— 见 [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md)。

Copyright (c) 2026 开发者猫叔

---

## 免责

本项目是对腾讯 WorkBuddy 产品形态的独立开源实现，与腾讯没有任何关系，不含其任何代码或资源。
「WorkBuddy」是其权利人的商标。
