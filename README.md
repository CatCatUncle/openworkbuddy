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
| 🔐 **安全中心** | 命令审批闸门（`$()`／反引号／换行／子 shell 都拆得开）、黑白名单、删文件保护、URL 白名单、审计日志 |
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

## 干不完的时候，它得把话说清楚

长任务撞上「最大步数」或「最长运行时间」是常态。这时候最后一句话往往是半句过程叙述
（"我先看一下这个文件"），直接甩给用户等于没交代。所以强制收尾时会**额外发一次不带工具的请求**，
只让它回答三件事：做完了什么、产出了哪些**真实存在**的文件、下次从哪一步接着做。

- 用户自己按「停止」的不做这次收尾——喊停就是不想再花钱了。
- 声称生成了文件却不在磁盘上、或者只有 0 字节，会被成果核验闸门打回去重做（最多 2 次）。
- 上下文超预算时会截短较早的工具原文，界面上明写截了多少字，不假装模型一直看得见全文。

### 对话不会因为一次崩溃就没了

会话、账本、定时任务表这些"丢了就真丢了"的文件统一走 `store.js`：

- **写**：先写临时文件再改名（同一分区上改名是原子的），改名前把上一版留成 `.bak`。
  写到一半断电，盘上要么是旧的要么是新的，不会是半个 JSON。
- **读**：分得清"没有这个文件"和"文件坏了"。坏了先拿 `.bak` 顶上；连 `.bak` 都没有，
  就把坏文件改名隔离成 `.corrupt-时间戳` 留着人工捞，**绝不静默当成空的**——
  那样下一次保存就把用户的对话/账号/积分/定时任务永久覆盖掉了，全程一句提示都没有。
- 账本（`users.json`）走 strict：坏了直接报错停下来，也不自动回退 `.bak`——
  回退一版可能正好吞掉一笔充值，这种事得让人自己拍板。
- 任务跑一半也存盘（最多每 5 秒一次）：跑了半小时的任务不该因为一次崩溃从头再来。
- IM（飞书/QQ/企微/公众号/微信）的会话单独落盘，重启不失忆。
- `config.json` 是唯一存着所有 API Key 的文件，写入口只留一个（`saveConfig()`），同样原子写 +
  `.bak`；读坏了先回退 `.bak`（Key 原样还在），实在顶不住才隔离并退回模板，原文捞得回来。

### 网页读不到，不等于做不到

联网这一环最容易假失败，这里堵了三个洞：

- **模型「说」出来的工具调用会被救回来。** DeepSeek 一类模型的工具调用在权重里是特殊
  token（`<｜tool▁sep｜>`），经过某些中转层时不会被解析进 `tool_calls` 字段，而是原样解码进正文。
  于是模型以为自己抓了网页，实际什么都没发生，接着开始**编造抓取结果**——这不是提示词能治的。
  `llm.js` 会认出这些标记、还原成真正的工具调用去执行；流式输出上也设了闸门，
  特殊 token 不会漏到界面上。参数只吐了一半就整个丢掉，宁可重来也不拿半截参数去跑。
- **请求头得像个浏览器。** 原来自报家门的 `Mozilla/5.0 (OpenWorkBuddy)` 会被 B 站、微博一类站点
  直接判成爬虫回 412 风控页。现在带完整的浏览器头和同源 Referer；JSON 接口原样返回，
  不再被当 HTML 洗掉标签（`{"a":"<b>"}` 洗完就废了）。
- **动态页面真渲染。** 应用本体跑在 Electron 主进程里，等于随身带了个 Chrome。
  `fetch_url` 抓回来是空壳时自动用内置浏览器渲染一遍再取正文，也可以直接用 `render_page`。
  单页应用（B 站空间页这种）从"什么也读不到"变成能读到完整列表。

渲染兜底也失败时，工具返回的不是一句"抓取失败"，而是**说清为什么 + 列出还能换哪几条路**
（找页面背后的数据接口、用 `run_shell` 调本机现成 CLI、搜转载页）。配套的规范写进了系统提示词：
同一个目标至少真试满三种路子才允许说做不到，且**不许把「1/2/3 请选择」的选择题丢回给用户**——
有工具就自己挑一个最可能成的动手。

抓回来的东西还要**干净**，不然 20000 字的上下文预算全喂了噪声：

- **只留正文。** 导航、页头、页脚、侧栏、表单先剔掉，有 `<article>` / `<main>` 就只取那一块。
  否则抓十个页面等于把同一堆导航链接抄十遍，正文反而被挤出预算。
- **按真实字符集解码。** `fetch()` 的 `.text()` 一律当 UTF-8 读，国内那些还在用 GBK 的老站点整页乱码，
  模型看到一屏问号就判定"这站抓不到"。现在按响应头和 `<meta charset>` 解。
- **二进制不当正文读。** 地址是 PDF / 图片 / 压缩包时，自动下载到工作目录并告诉它文件名和下一步
  （PDF 提示走 `pdftotext`），重名不覆盖。以前是把一坨乱码塞进上下文，又贵又误导。

### 只读的活并发跑

一轮里模型同时要了 5 个 `web_search` / `fetch_url` / `read_file`，就**并发执行**（上限 3 路），
只花最慢那一次的时间，而不是把 5 次网络等待叠起来——深度研究最费的就是这段。
只要这一批里混进了写文件、跑命令、委派专家的调用，**整批退回串行**：那些工具的先后顺序本身就是语义。
界面上的过程卡按**调用 id** 配对，谁先回来都不会把 A 的结果贴到 B 的卡上。

### 回复里能直接画图，边输出边画

结构化的结论（人物画像、方案对比、流程、时间线）让模型**直接在正文里写 `​```svg` 围栏**，
界面当图渲染，不是贴一屏尖括号。SVG 是流式吐出来的，每来一段就把半截内容补全重画一次，
所以图是**一笔一笔长出来**的，右下角标「绘制中」。画完可以看源码、存成 `.svg`、或者导出 `.png`
（导出时会把 `var(--color-*)` 解析成当前主题的实际色值、把字体内联进去，不然中文会变豆腐块）。

安全上，SVG 走一遍清洗才上屏：`<script>` / `<foreignObject>` / `on*` 事件 / 外链图片字体 /
`javascript:` 链接全部剔掉，只留指向图内部的 `url(#id)`。SVG 里的 `<style>` 默认是**对整个页面生效**的，
模型又爱用 `.t` `.ts` 这种通名，所以每张图会分配一个唯一 id，样式规则被改写成 `#svgfigN .t {…}` 锁死在图内。
这些都由 Electron 里的真 Chromium 跑测试（`test/frontend.js`，27 项）。

配套还有两块：

- **来源**：回复底下列出这一回合**真正打开过的网页**（工具层记的实际访问，不是模型嘴上说参考了什么），
  点开直达。抓失败的页面不会混进来——那等于给用户一张假凭证。
- **查看所有变更 (N)**：本回合产出的文件带数量、可折叠，点卡片直接预览。

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

cron 5 字段（分 时 日 月 周），支持 `*` `,` `-` `*/n` `1-30/5` `5/10`；周里 `0` 和 `7` 都是周日。
日和周同时写了具体值时按标准 cron 取**或**（`0 9 1 * 1` = 每月 1 号或每周一）。
越界（`70 * * * *`）、写反（`5-1`）、步长 0 一律当场报错——收下不报的后果是任务永不触发，界面上却一切正常。

**错过了会补跑**（每个任务可关）。这是台式应用，合上盖子睡一夜、或者应用压根没开着，
到点那次就没人执行。下次醒来发现中间断了，会把该跑没跑的补一次：

- 一段时间里错过好几次也**只补一次**，补的是最近该跑的那次——补的是「这件事还没做」，不是把闹钟按次数重放
- 最多往回补 24 小时，更早的按过期丢掉（关机一个月，不该开机就把一个月的晨报全补一遍）
- 装好后第一次启动不补跑，否则一上来就会把历史全部重放
- 同一个任务不叠着跑：上一次还没跑完，这次就跳过

---

## 安全中心（这个 agent 手里有 shell）

设置 → 安全中心。每一项都是真闸门，不是摆着看的开关：文件黑名单、命令审批、网络白名单、
运行时开关、审计日志（`data/audit.json`，环形 1000 条）。

命令闸拆命令的时候，下面这些都算**同一条命令里的一段**，会逐段核对：

```bash
rm -rf ~/x                 # 直接写
echo hi; rm -rf ~/x        # ; && || | & 串起来
echo hi
rm -rf ~/x                 # 换行——agent 写的多行脚本
echo $(rm -rf ~/x)         # 命令替换
echo `rm -rf ~/x`          # 反引号
( rm -rf ~/x )             # 子 shell
FOO=1 rm -rf ~/x           # 前面挂环境变量
/bin/rm -rf ~/x            # 写全路径
nohup rm -rf ~/x           # 套个壳
find . -name "*.log" -delete
```

引号里的分隔符不当分隔符（`grep "a|b"` 不会被拆开），`echo "记得 rm 掉旧文件"` 也不会误弹审批。

两条跟直觉不太一样、但是故意这么定的：

- **文件黑名单排在命令放行名单前面。** 黑名单是「永远拦」——不能因为你放行了 `cat `，
  `cat ~/.ssh/id_rsa` 就跟着过去。命令里出现黑名单路径（`~/.ssh`、`$HOME/.ssh`、绝对路径都认）一律要审批。
  拦得住的是「顺手」，不是「刻意绕」——真要绕总有办法，别把这当沙箱。
- **run_node 的代码也过闸。** 只守 `run_shell` 那扇门是守不住的，
  一句 `require("child_process").execSync("rm -rf ~")` 就从旁边过去了。
  代码里要开子进程、或者伸手碰文件黑名单，同样弹审批。

审批弹在输入框上方，批准 / 拒绝都行；超时（默认 120 秒）或者点停止都按拒绝算。

---

## 账号与积分

第一个注册的账号是**管理员**（10000 积分，可以给别人充值），后面注册的是成员（1000 积分）。
网页 / CLI / IM / 定时任务共用同一本账：每 1000 tokens 扣 1 积分，每次任务至少 1 积分。

几条和安全有关的、默认就这么定的规矩：

- **有了第一个账号之后，默认不许别人自己注册。** 想开放的话，管理员到「账号」面板里勾上——
  这东西挂到公网上又开着注册，等于谁进来都能领 1000 积分花你的 key。关着的时候登录页连注册入口都不给。
- **登录有闸**：同一个账号连错 8 次、或同一个 IP 连错 30 次，就停 15 分钟。
  闸在算密码之前——密码是 scrypt 算的，一次几十毫秒，而 server 就跑在 Electron 主进程里，
  让人连打的话界面会先卡死。只记在内存里，重启就清空，这是防连打不是封号。
- **改完密码，别处的会话立刻下线**，只留你当前这一个。密码泄露了才改的密码，旧 cookie 还能用就等于没改。
- 走 https（自己或者前面的 nginx）进来时，会话 cookie 会带上 `Secure`。

### 名字和头像都能改

头像菜单 →「个人资料」改**自己**的昵称和头像；设置 →「个性化」改**助理**的名字和头像。
两边都支持 emoji（点一下预设就行）或者上传一张图——图会自动居中裁成方的、压到 128px 再存，
太大的直接退成 JPEG，不会让一张原图把 JSON 账本撑爆（硬上限 256KB，外链和 `<img>` 一律不收）。

助理改名不只是换个界面标题：名字会同时进系统提示词，所以你喊它「小秘」它自己也认。
登录名是唯一不给改的东西——积分和历史用量都挂在它名下，改了就对不上人了。

账本 `data/users.json` 写盘是先写临时文件再改名，旁边留一份 `.bak`。
万一它坏了（手改错、写到一半断电），程序会**直接报错停在那儿，不会当成「没有用户」**——
后者的下场是下一次写盘把所有账号和积分覆盖成空的，而且下一个注册的人自动变成管理员。

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
store.js         JSON 落盘（原子写 + .bak 兜底）  im-store.js   IM 会话仓库
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

覆盖：cron 解析（越界 / 步长 0 / 日周取或）、定时任务运行时（补跑一次 / 不叠跑 / 结果落盘）、
命令闸（换行 / `$()` / 反引号 / 子 shell / 包装词 全拆得开、黑名单压得住放行名单、代码闸）、
账本（坏文件不被空账本覆盖 / 写盘原子 / 登录限流 / https 认得出）、
头像规则（emoji 按字素簇算长度，一个 👨‍👩‍👧 不算超长 / 只收 `data:image` / 挡外链与标签 / 限 256KB）、
JSON 落盘（空文件自愈 / 坏文件回退 `.bak` / 无 `.bak` 则隔离 / 账本 strict 抛错）、
IM 会话（重启后上下文还在 / 砍历史只从整轮开头下刀）、
workspace 路径越界拦截、成果核验闸门（缺文件 / 0 字节空壳）、
`run_node` 语法预检、上下文预算截断、Word/PPT/Excel 生成、
Agent Plugins（清单校验 / 坏零件隔离 / `${PLUGIN_ROOT}` 展开 / 技能并流与重名让位）、
MCP Streamable HTTP（JSON 与 SSE 两种响应、会话 ID）、MCP 连接器生命周期（按插件停、同名重启不留孤儿）、
Agent 全管线（技能加载 → 代码执行 → 专家委派 → 事件流）、
强制收尾（撞上限补一次交代 / 手动停止不多花一次调用）、
工具调用泄漏救援（特殊 token 还原成真调用 / 半截参数丢弃 / 不漏进界面）、
抓取（JSON 原样返回 / 导航页脚清掉 / GBK 按真实字符集解码 / PDF 存成文件不塞乱码且重名不覆盖 / 空壳与反爬如实报告并给出下一步）、
只读工具并发（真并发跑起来 / 结果顺序与调用 ID 不串 / 混入写操作整批退回串行）、
来源收录（只记真访问到的页面，抓失败/本地文件/非联网工具一律不计）、
前端内联 SVG 信息图（在 Electron 的真 Chromium 里跑：流式逐帧渲染 / 脚本与外链清洗 / `<style>` 作用域隔离 / PNG 导出，27 项）。

---

## 协议

[PolyForm Noncommercial 1.0.0](LICENSE)：个人、学习、学术、非营利、政府用途**免费**。
公司内部使用、对外提供服务、二次销售等商业场景，需要单独授权 —— 见 [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md)。

Copyright (c) 2026 开发者猫叔

---

## 免责

本项目是对腾讯 WorkBuddy 产品形态的独立开源实现，与腾讯没有任何关系，不含其任何代码或资源。
「WorkBuddy」是其权利人的商标。
