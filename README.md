<p align="center">
  <img src="build/icon.png" width="120" alt="OpenWorkBuddy">
</p>

<h1 align="center">OpenWorkBuddy</h1>

<p align="center">
  <b>让 AI 真正替你交付工作的本机 Agent。</b><br>
  把需求和材料交给它：自己规划、动手、验收，把 PPT / Word / Excel / 网页落到你的电脑；<b>交付的是可打开的文件，不是一段聊天记录。</b>
</p>

<p align="center">
  <sub>A local-first AI office agent that hands you files, not chat logs. → <a href="README.en.md"><b>English README</b></a></sub>
</p>

<p align="center">
  <sub>适合本地部署办公、把 Agent 用进真实交付、或想从模型、工具、记忆、Trace 一路读懂 Agent 的人。项目持续迭代，欢迎你一起维护。</sub>
</p>

> **openworkbuddy 是什么？** OpenWorkBuddy（`openworkbuddy`）是一个本地优先的 AI 办公 Agent 开源项目：它把请求变成你电脑上可打开、可核对的文件，而不是停在聊天记录里。本仓库 `CatCatUncle/openworkbuddy` 是项目源码，由 开发者猫叔 独立开发，与任何名称相近的第三方产品或公司均无关联（详见[免责与边界](#免责与边界)）。

<p align="center">
  <a href="#跑起来"><b>⚡ 三分钟跑起来</b></a> ·
  <a href="https://github.com/CatCatUncle/openworkbuddy/releases">下载安装包</a> ·
  <a href="#第一次上手">第一次上手</a> ·
  <a href="#技术架构">技术架构</a> ·
  <a href="#roadmap">Roadmap</a> ·
  <a href="#一起把它做下去">贡献一个能力</a> ·
  <a href="CHANGELOG.md">变更记录</a> ·
  <a href="#交流群">飞书交流群</a> ·
  <a href="docs/功能清单.md">功能清单</a>
</p>

<p align="center">
  <a href="https://catcatuncle.github.io/openworkbuddy/"><b>🌐 项目主页</b></a> ·
  <a href="https://github.com/CatCatUncle/openworkbuddy">GitHub 源码</a> ·
  <a href="https://github.com/CatCatUncle/openworkbuddy/releases">Releases</a>
</p>

<p align="center">
  <a href="https://github.com/CatCatUncle/openworkbuddy/stargazers"><img src="https://img.shields.io/github/stars/CatCatUncle/openworkbuddy?style=flat-square&logo=github&label=Star&color=5b5ff7" alt="Star"></a>
  <a href="https://github.com/CatCatUncle/openworkbuddy/forks"><img src="https://img.shields.io/github/forks/CatCatUncle/openworkbuddy?style=flat-square&logo=github&color=5b5ff7" alt="Fork"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-PolyForm%20NC-5b5ff7?style=flat-square" alt="License"></a>
</p>

<p align="center">
  <a href="docs/功能清单.md"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FCatCatUncle%2Fopenworkbuddy%2Fmain%2Fdocs%2Fstats.json&query=%24.skills&label=Skills&color=5b5ff7&style=flat-square" alt="Skills"></a>
  <a href="docs/功能清单.md"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FCatCatUncle%2Fopenworkbuddy%2Fmain%2Fdocs%2Fstats.json&query=%24.tools&label=Tools&color=5b5ff7&style=flat-square" alt="Tools"></a>
  <a href="#生态和它一起用的项目"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FCatCatUncle%2Fopenworkbuddy%2Fmain%2Fdocs%2Fstats.json&query=%24.connectors&label=Connectors&color=5b5ff7&style=flat-square" alt="Connectors"></a>
  <a href="docs/功能清单.md"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FCatCatUncle%2Fopenworkbuddy%2Fmain%2Fdocs%2Fstats.json&query=%24.experts&label=Experts&color=5b5ff7&style=flat-square" alt="Experts"></a>
</p>

<p align="center">
  <sub>个人、学习、非营利用途<b>免费</b>；公司里用需要授权，<a href="#协议">一句话讲清 ↓</a></sub>
</p>

<p align="center">
  <img src="docs/images/demo.gif" width="960" alt="OpenWorkBuddy 演示：说一句话，助理自己干活，交付能打开的文件">
</p>

---

## 第一次上手

**最快的验证方式：下载 → 选一个模型 → 把下面这句话贴进输入框。**

> 把我拖进来的材料整理成一页清晰的要点，并交付为一个可打开的 Markdown 文件。

它会在右侧留下真实文件；点击即可预览、下载或继续让它修改。没有材料？直接说「帮我做一份本周工作周报」，也能先跑通完整闭环。

**想持续关注 OpenWorkBuddy？点个 Star 把它收藏起来；再点仓库右上角 `Watch → All Activity`，GitHub 会把项目动态及时通知给你。** 每一个 Star 都会帮更多正在找本地 AI 助理的人发现这个项目，也告诉我们哪些能力值得继续打磨。

## 为什么是它

**交付的是文件，不是聊天记录。** PPT / Word / Excel / 网页都是真生成的，成果面板里点开就能验收。声称写了文件却不在磁盘上，会被当场拦下重做。

**不绑任何一家模型，东西都在你手里。** DeepSeek / 通义 / 智谱 / Kimi / OpenRouter / Ollama 本地模型界面点一下就切；本机装了 **Claude Code / Codex** 的，一键拿它当发动机，不再另买 token。自托管，会话、文件、Key 全在本机，默认只监听 `127.0.0.1`。

**加一个能力 = 丢一个 Markdown 文件。** 存成 `skills/<名字>/skill.md`，存盘后下一条任务就生效——不改代码、不重启、不打包。往外接 MCP 连接器和 [Agent Plugins](https://agent-plugins.org) 开放标准，别人的插件粘个 GitHub 地址就装。

**既能拿来干活，也适合拿来学 Agent。** 模型路由、工具调用、文件验收、技能、连接器、记忆、权限和本地 Trace 都在同一个开源仓库里；你能从一条真实任务一路看到 Agent 为什么这样做、用了什么模型、每步花了多久、最后交付了什么。

**内容创作也有完整工作流。** `content-studio` 把素材、网页、音视频、笔记、引用和成稿放进同一个项目：先理解和标注来源，再写母稿，最后派生公众号、知乎、小红书、口播、图片、音频或视频。输出保留 Markdown/HTML 等可编辑源文件，适合持续迭代，不是生成一次就结束。

## 如何确认你找的是这个项目

- 仓库：[`github.com/CatCatUncle/openworkbuddy`](https://github.com/CatCatUncle/openworkbuddy)
- 项目名与包名：**OpenWorkBuddy / `openworkbuddy`**
- 识别句：**A local-first AI office agent that hands you files, not chat logs.**
- 代码特征：`agent.js` 手写 Agent 循环、`engines/` 本机 Codex / Claude Code 接入、`skills/` Markdown 技能、`docs/` 中文文档与 `eval/` 可重复评测
- 许可证：个人、学习、非营利用途免费；公司内部或其他商业用途需取得授权（[PolyForm Noncommercial 1.0.0](LICENSE)）

这里不评价任何同名或相近产品；请以仓库作者、地址、许可证和上述目录特征来确认来源。

## 技术架构

一台机器就能跑完整闭环：入口、Agent、模型、工具、工作区和可观测性彼此解耦；需要时再接入飞书、微信或 Langfuse，默认不把本机文件和会话送到公网。

**飞书现在不只是收消息**：机器人可以在群聊中被 @ 后执行任务、回传文字和文件；在飞书云文档评论区被 @ 后，会识别当前文档、读取文档上下文，并在原评论线程中回复结果。消息去重跨重启保留，避免同一条事件重复执行。

```mermaid
flowchart TB
  subgraph Entry["你的设备"]
    Desktop["桌面端 / Web"]
    CLI["wb CLI"]
    IM["飞书 / 微信等远程入口"]
  end

  Entry --> Runtime["OpenWorkBuddy 本地运行时\n会话 · 权限 · 项目 · API"]
  Runtime --> Agent["Agent 编排\n规划 · 工具调用 · 文件验收"]
  Agent <--> Models["模型路由\n云端 LLM / Ollama / Claude Code / Codex"]
  Agent <--> Capabilities["能力层\nMarkdown Skills · 专家 · MCP · Plugins"]
  Agent <--> Workspace["本机工作区\n文件 · 素材 · 项目上下文 · 记忆"]
  Agent --> Canvas["可执行无限画布\n剧本 · 角色 · 镜头 · 素材 · 时间线"]
  Agent --> Trace["本地 Trace\n模型 · 工具 · 耗时 · Token · 输入输出"]
  Trace -. 可选 .-> Langfuse["Langfuse"]
```

这张图也是读代码的路线：从 `server.js` 的本地运行时进入，再看 `agent.js` 如何编排模型和工具；画布、CLI、IM 与 Trace 都是同一条交付链上的不同入口或观察点。

## 和其他 Agent 的位置

OpenWorkBuddy 不试图替代所有工具：Codex / Pi 更偏终端与代码，Claude Cowork / Manus 更偏托管式通用工作，OpenClaw / Hermes 更偏个人自动化与多渠道 Agent，各家大厂的企业级 Agent 工作台更偏协作与治理。它的取舍是：把“本机文件交付 + 可安装能力 + IM 远程指挥 + AI 短剧无限画布”放进一个可自托管的工作台。

| 维度 | OpenWorkBuddy | Codex / Pi | Claude Cowork / Manus | OpenClaw / Hermes | 企业级 Agent 工作台（品类） |
|---|---|---|---|---|---|
| 核心定位 | 本地文件交付 + Agent 工作台 | 终端 / 编程 Agent | 通用知识工作 / 云端浏览器 | 个人自动化与 Agent 平台 | 企业协作与治理 |
| 本地优先 | 会话、文件、模型 Key 默认在本机 | 终端工作流为主 | Cowork 可访问授权文件；Manus 主要在云端执行 | 依部署方式而定 | 云端能力与企业部署并存 |
| AI 短剧创作 | 原生无限画布：角色、场景、镜头、首帧、视频、音频、时间线 | 需自行搭建工作流 | 没有本项目的短剧画布闭环 | 需自行编排 | 通用内容生产，不以短剧画布为核心 |
| 可视化关系 | DAG 连线、紧凑排版、框选、撤销/重做、右侧预览 | 以终端 / 对话为主 | 过程可跟随，但不是同一张创作图 | 视前端与插件而定 | 任务与专家协作视图为主 |
| 能力扩展 | Markdown Skill、专家、专家团、MCP、Plugin，热安装 | CLI / 插件生态 | Skills、Connectors、Plugins | Skills / Channels / Tools | 企业技能、专家、连接器市场 |
| 远程指挥 | 飞书、微信 iLink、企微等，支持文件、图片、语音等 | 主要在终端 | Web / Desktop / Mobile / Connectors | 多渠道自动化是强项 | 企业 IM 与团队协作是强项 |
| 可观测性 | 内置本地 Trace：模型、工具、耗时、Token、输入输出；可选 Langfuse | 依工具链配置 | 平台内过程可查看 | 依部署与插件 | 企业审计、用量和治理更完整 |
| 许可证与数据控制 | 开源、自托管、非商用免费；可接自己的模型 | 开源项目 / 各自模型策略 | 商业产品 | 开源项目 / 依组件 | 商业企业产品 |

表中出现的产品名称与商标归各自权利人所有，此处仅用于识别和做事实对比，不代表任何形式的关联、背书或赞助。最后一列描述的是「企业级 Agent 工作台」这一**产品品类**的普遍形态，不指向任何特定厂商的产品。

上表只比较公开定位和本项目当前能力，不代表任何项目在所有场景都更好。对比对象包括 Codex、Pi、OpenClaw、Hermes Agent、Claude Cowork、Manus，以及「企业级 Agent 工作台」这一类商业产品的公开定位；请以各项目自己的最新文档和许可为准。

如果你觉得某一格不准确，欢迎直接提 Issue 或提交 PR：能复现、能验证、能落到代码里的反馈，我们会优先处理。

内容创作可以从 [content-studio Skill](skills/content-studio/skill.md) 开始：把素材当输入、把笔记和引用当处理中间层、把文章和媒体当可编辑输出；再叠加 `wechat-article`、`xhs-cards`、`video-compose` 等专用 Skill。

## 它替你做完的事

| 你说一句 | 它交给你 |
|---|---|
| 帮我出一份 Q3 复盘 PPT，数据用这个 Excel | 读表 → 算 → 一个能直接放的 `.pptx` |
| 调研国内 AI 陪伴产品，出一份报告 | 联网搜 → 逐个打开读 → Markdown / Word |
| 把这份材料做成手机上能看的网页 | 写 HTML → 起本机服务 → 扫码就能看（[成品长这样](https://hunan-travel.pages.dev/)） |
| 每天 9 点抓行业新闻，做成晨报发我飞书 | 定时任务 + IM 推送，错过了会补跑 |

> 还有多任务并行、Goal 目标验收、👍👎 反馈进自进化、双层记忆、权限档位、IM 远程指挥、桌面宠物……全部能力见 **[功能清单](docs/功能清单.md)**。

## AI 短剧无限画布

把一句话概念、剧本、角色、场景、分镜、参考图、视频、声音和剪辑时间线放在同一张**可执行的创作图**里。连线不是装饰：它表示下一步生成真正会读取的角色、场景、首尾帧或声音输入；人和 Agent 都可以继续补节点、改关系、重跑结果。

<p align="center">
  <img src="docs/images/demo-canvas.gif" width="960" alt="OpenWorkBuddy 脱敏实录：从侧栏进入无限画布、创建短剧节点、保留连线并直接和画布 Agent 对话">
</p>

<p align="center">
  <img src="docs/images/short-drama-canvas-overview.png" width="960" alt="OpenWorkBuddy 短剧无限画布：角色、场景、参考图和镜头结果通过 DAG 连线协作">
</p>

- **自由创作**：笔记、剧本、角色设定和分镜可以随时编辑、连接；一张画布就是一个独立短剧工程。
- **素材真正可用**：工作区图片、视频、音频可选择、拖入或上传，保留原比例预览；双击图片放大，素材可接到角色、场景或镜头。
- **生成能追溯**：分镜表、场次、镜头、首帧、视频、配音和时间线组成 DAG，自动排版仍保留原有生成关系。
- **和 Agent 同屏共创**：底部对话支持附件、`@` 引用节点或素材、模型和执行模式选择；Agent 的处理过程和结果留在当前画布任务里。

进入左侧「无限画布」即可开始。空画布只有剧本和分镜两个有实际意义的起点；空白处拖拽平移、`Shift`+拖拽框选，框选后拖任一节点可整体移动，属性只在点节点齿轮时打开。

## Roadmap

下面是明确的后续方向，不是已经发布的功能承诺；已完成内容以[功能清单](docs/功能清单.md)和[变更记录](CHANGELOG.md)为准。

| 方向 | 下一步 | 为什么值得做 |
|---|---|---|
| 短剧创作闭环 | 节点级下游重算与缓存、分镜到时间线交付、更多可复用短剧工作流 | 改一个镜头只影响必要的下游，降低重跑成本 |
| 素材与渠道 | 更顺畅的素材归档、引用与跨节点复用；继续打磨飞书、微信等附件交付 | 让参考图、音频、视频真正可找、可用、可交付 |
| 可观测与协作 | Trace 对比/回放、Langfuse 连接体验、跨机器任务查看与安全边界 | 让人和团队都能解释“Agent 做了什么、花了多久、为何失败” |
| 开源生态 | 更多经验证的 Skills、专家工作流、MCP 预设与贡献模板 | 让贡献者用更小的改动带来可复用能力 |

想参与其中，优先欢迎能复现的问题、真实任务样本（请脱敏）、小而完整的 Skill，以及能把一个卡点变成可测试改动的 PR。更详细的取舍和验收标准见[路线图](docs/路线图.md)。

## 长这样

**「同一个人，换四个场景，手里举一块写着字的牌子——要像随手拍的，别像 AI 图」**

<p align="center">
  <img src="docs/images/case-photoreal.jpg" width="640" alt="同一位人物在咖啡馆窗边、雨夜街头、工位、清晨卧室四个场景，举着写有「关注 OpenWorkBuddy 项目」的木牌，写实照片风格">
</p>

难的不是画个人，是**四张里得是同一个人**、木牌上的中文不能糊。它先出一张，再用看图工具真去读自己刚生的那张（不是凭记忆吹），确认光线和皮肤质感对了，才照这个方向铺开其余场景。图上不带任何 AI 生成水印。

**「做一个湖南旅游攻略网站，14 个市州一个都不能少」**

<p align="center">
  <a href="https://hunan-travel.pages.dev/"><img src="docs/images/case-hunan-site.jpg" width="820" alt="湖南怎么玩 · 14 市州完全攻略——OpenWorkBuddy 生成的单页站点"></a>
</p>

站在这儿，点开就能逛：**<https://hunan-travel.pages.dev/>**。14 个市州逐一拆开写，外加 3/5/7 天三条线路，单页 HTML、不挂任何外部 CDN，扔到静态托管上就是一个站。这不是截图拼的示意图，是它交出来的那个文件本身。

这两件事它是怎么做到的、本机 Claude Code 当发动机又长什么样 → **[三个案例，拆开讲](docs/案例.md)**

## 跑起来

先挑一条路，三条都是完整功能，没有哪条是「阉割版」：

| 🖥️ 装在自己电脑上 | 🐳 放服务器给团队用 | 🏢 公司要落地 |
|---|---|---|
| 下个安装包双击，五步向导三分钟说出第一句话。数据全在本机。 | 一台 VPS + Docker，一条命令起来，自带 HTTPS 和企业管理后台。 | 自托管之外还要 SSO、审计外送、内网部署、SLA —— 这些走商业授权。 |
| [下载安装包 ↓](https://github.com/CatCatUncle/openworkbuddy/releases) | [部署文档 →](docs/部署.md) | [商业授权 →](COMMERCIAL-LICENSE.md) |

**装包**：去 [Releases](https://github.com/CatCatUncle/openworkbuddy/releases) 下对应的包，打开后**五步向导**带你注册账号、粘 Key（当场验活）、选引擎——三分钟内说出第一句话。

| 系统 | 下哪个 |
|---|---|
| macOS · Apple 芯片 | `OpenWorkBuddy-*-mac-arm64.dmg` |
| macOS · Intel | `OpenWorkBuddy-*-mac-x64.dmg` |
| Windows 10/11（x64 与 ARM 同一个包，装时自动选） | `OpenWorkBuddy-*-win-setup.exe` |
| Windows 免安装版（**只在装不了软件时才用**） | `OpenWorkBuddy-*-win-x64-portable.exe` / `-win-arm64-portable.exe`（原理是自解压：每次启动要把整包解压到 `%TEMP%`，第一次可能要等好几分钟，期间只有进程没有窗口）|

> 第一次打开会被系统拦一下，因为这个包没有代码签名证书（苹果一年 99 美元、Windows 一年几千块，这是个免费开源项目），不是有毒。
> **Windows**：弹窗里点灰色小字「更多信息」→「仍要运行」。**macOS**：拖进「应用程序」后终端跑 `xattr -dr com.apple.quarantine /Applications/OpenWorkBuddy.app`，或 系统设置 → 隐私与安全性 → 「仍要打开」（右键图标 → 打开只在 macOS 14 及更早有效）。
> 你的数据在 `~/OpenWorkBuddy`，卸载不会删。换电脑整个搬过去 → [数据同步与搬家](docs/数据同步与搬家.md)。
>
> **双击了没反应？** 启动日志在 `~/OpenWorkBuddy/logs/boot.log`，对照 [安装与启动 · 双击了没反应？](docs/安装与启动.md#双击了没反应) 逐条排查。

**从源码**（Node.js 18+，零构建零框架，改完刷新即生效）：

```bash
git clone https://github.com/CatCatUncle/openworkbuddy.git
cd openworkbuddy && npm install
npm run app     # 桌面版；或 npm start 走浏览器 http://localhost:3800
```

然后在输入框里说人话，比如「帮我做一份介绍 OpenWorkBuddy 的 PPT」。看着不顺眼就改：头像菜单 → **外观**，语言（中文 / English）/ 主题 / 六套皮肤 / 字号四档 / 字体 / 紧凑密度，点一下立刻生效。切成 English 后 AI 的回答和它写给你的文件也跟着用英文；首次开箱向导右上角就能切。（v1 只翻界面：服务端推过来的步骤标题、飞书/微信里的回复暂时还是中文。）

镜像、一键脚本、端口占用、启动卡住 → [安装与启动](docs/安装与启动.md)

## 放服务器给团队用

一台干净的 VPS，装好 Docker 之后一条命令：

```bash
git clone https://github.com/CatCatUncle/openworkbuddy.git && cd openworkbuddy
bash deploy.sh                              # 起在 127.0.0.1:3800
bash deploy.sh --domain buddy.example.com   # 或者：带自动 HTTPS，直接对外能用
```

脚本会构建镜像、起容器、**等健康检查真的通过**才说成功；起不来就把日志打给你，不假装。
数据全在 `./wb-data` 一个目录里（配置 / 账号 / 成果文件 / 技能 / 备份），容器随便删，那个目录别删。

起来之后**第一件事是注册管理员**——第一个注册的就是管理员，注册完默认不再允许别人自建账号；
空实例挂在公网上等于谁先访问谁是管理员。

**多租户 + 企业管理后台**：一个进程同时给多家公司用。成果文件、会话、账号、席位、用量账本、
审计各租户互相看不见；引擎和 API Key 归平台管理员。管理员登录后头像菜单 → **企业管理后台**，
建组织、分席位、看用量、配组织级安全策略——组织级那四个开关（`allow_shell` / `net_allow` /
`net_deny` / `session_days`）是真的会拦人的，不是摆着看的复选框。

反代配置、升级迁移、四个开关各自拦在哪一层、安全清单 → [部署](deploy/README.md)

## 配模型

**设置 → 模型**，选渠道预设（OpenAI / Anthropic / OpenRouter / 火山方舟 / 百炼 / DeepSeek / 智谱 / Kimi / Ollama），地址和协议自动填好，只差粘 Key，保存即热生效。对照表见 [配置模型](docs/配置模型.md)。带 reasoning 的模型能在界面里**关掉思考或调档**。

> `config.json` 是唯一存着 API Key 的文件，已在 `.gitignore` 里，**别手滑提交**。

## 命令行也能用

`wb` 跟桌面版共用同一份配置、技能、记忆和连接器，答案落到 stdout，能塞进任何管道、脚本和 cron：

```bash
npm link                                   # 一次性：把 wb 装成全局命令
wb "帮我写一份本周周报"                     # 单发：跑完就退，退出码 0/1 说实话
cat error.log | wb "这是什么问题"           # 管道：内容当附加材料一起送进去
wb --json "整理会议纪要" | jq -j 'select(.type=="text") | .delta'   # NDJSON 事件流给脚本用
wb engines && wb engines use claude-code   # 本机装了 Claude Code / Codex？一键拿它当底层
```

`-q` 只要答案、`-c` 续上一轮、`-C <目录>` 指定工作目录、`wb sessions` 列会话。全部参数 → [命令行用法](docs/命令行用法.md)。

## 最新动态

- **09-17** 换电脑不用从头再配一遍了：旧机器点「立即备份」把包下载走，新机器「导入备份文件」再点恢复，会话、记忆、账号、个人偏好和自己写的技能一起搬过去（外来的包会先整个拆开验一遍，绝对路径、`..`、软链接、形状不对的一律当场拒掉）
- **09-17** 任务跑着的时候再说一句话，现在由你挑：「插队」立刻打断当前这步就地纠偏，「排队」不打断、等它做完再按顺序开始；排错了的那条还能从队列上撤下来
- **09-17** 搜索、生图、生视频、配音、转写这类按次计费的接口有额度闸门了：调之前先问还有没有份额，调完记一笔是谁、哪个组织、走的哪家，后台按天/按月/按人看得出账（默认全部不限，一个人用自己的 Key 不受影响）
- **09-17** 企业后台的用量查得动了：按时间区间筛、按成员/模型/入口搜、翻页看全部流水——以前只有最近 25 条，「上个月谁花得最多」这个后台答不上来
- **09-17** 把哪些开源、哪些要商业授权写成了一份文档，数据存在哪、什么跟着账号走、什么每台设备各管各的也单独写了一份
- **09-14** 增加 AI 短剧无限画布模式：剧本、角色、场景、分镜、素材、生成结果和本项目 Agent 在同一张可执行画布内协作，支持多张短剧工程、素材拖入、框选批量操作、自动排版和画布内对话
- **09-14** 优化无限画布短剧创作 UI：参考图/视频/音频可预览，图片支持放大查看，画布对话支持附件、`@` 引用节点与素材、执行模式和模型选择
- **09-13** 讲故事的片子能拍了：先把分镜表摆出来给你点头，再角色定妆照 → 每镜首帧 → 生视频 → 配音 → 拼成带字幕的竖版片；改哪一镜就只有那一镜再花钱
- **09-13** 配一条 SMTP，AI 就能把写好的报告、做好的文件直接发到对方邮箱；收件人白名单是硬闸，每封信出门前还要你看全文点头
- **09-13** AI 能自己排定时任务了：「每周一早九点把上周数据整理成表」说一句就定下，到点自己跑
- **09-13** 录音、会议视频、语音留言直接转文字，转完接着往下写纪要，不用自己再听一遍
- **09-13** 甲方发来的 Word / Excel / PPT / PDF 直接读，资料库里的素材随手取，做完的东西一句话推到群里
- **09-13** 终端里也看得到产出的图了：`/open` 交给系统程序打开，认得出的终端直接画在对话里
- **09-13** 做网页不再千篇一律：动笔前先挑视觉方向，同一个需求两次做出来不一样
- **09-13** 每一步花了多久直接写在卡上，收尾再记一笔账：工具占了多久、剩下多少是模型在想
- **09-13** 接 Langfuse 就能翻每次模型调用的原始输入输出，一层层点开看
- **09-11** 侧栏分「办公 / 工程」两条线；终端里 `wb` 起的活儿，手机上看得见、插得上话
- **09-11** 生图 / 生视频 / 配音 / 视觉都能配多个模型，同一家的 Key 只填一次
- **09-11** 「下载了打不开」修了六种，每种都有窗口说清原因，另附一份启动日志
- **09-10** 一条命令部署到服务器：`bash deploy.sh`，加 `--domain` 直接带 HTTPS
- **09-10** 多租户 + 企业管理后台：16 个面板，管理员、审计员、成员各看各的
- **09-08** 本机 Claude Code / Codex 当引擎，记忆、技能、读文件、生图配音全接上

更早的看 **[变更记录](CHANGELOG.md)**；每条对应的代码改动在 [commit 历史](https://github.com/CatCatUncle/openworkbuddy/commits/main)，提交信息写的是「为什么」。

## ⚠️ 这个 agent 手里有 shell

它能执行命令、读写文件、访问网络——所以闸门是真拦的：命令审批、文件黑名单、URL 白名单、审计日志、四档权限。**放到公网前务必先读 [安全](docs/安全.md)**，默认配置只为本机使用而调。

## 交流群

用崩了、有想法、想一起改，进飞书群直接说。飞书扫码：

<p align="center">
  <img src="docs/images/feishu-group.png" width="240" alt="OpenWorkBuddy 飞书交流群">
</p>

## 一起把它做下去

**觉得有用？点个 Star，让更多人找到它；想第一时间跟进进展，就在右上角点 `Watch → All Activity`。** 新能力、修复和版本动态都会持续在 GitHub 公开更新。

**用崩了、卡住了，开个 [issue](https://github.com/CatCatUncle/openworkbuddy/issues/new) —— 哪怕只贴一句报错。** 你以为「只有我遇到」的坑，多半所有人都在踩。贴之前扫一眼，别把 API Key 带上。

**想动手，按投入从小到大三条路：**

- **10 分钟** —— 写个技能。一个 Markdown 存成 `skills/<名字>/skill.md`，存盘即生效，[三分钟模板在这](CONTRIBUTING.md#提交一个技能3-分钟)
- **1 小时** —— 补一个模型渠道预设、修一处文档、给某个文件格式加上预览
- **一晚上** —— 挑个 issue 改。`npm install && npm start` 就跑起来，`npm test` 不需要 API Key 就能全绿

项目结构、测试、PR 规范都在 [参与贡献](CONTRIBUTING.md)。不用先开 issue 问，直接发 PR。

## 生态：和它一起用的项目

这个项目不打算什么都自己写。有人已经把某件事做得更好，就接过来用——下面这些是我们真的在用、也推荐你装的。

**[OpenConnector](https://github.com/oomol-lab/open-connector)（Apache-2.0）—— 一条连接器顶一片。**
它是个开源的连接器网关，把 Gmail、Slack、Notion、GitHub、BigQuery、Airtable 等 1000+ 服务的现成动作
统一成一套可检视的 Action 契约，自带 MCP 端点。对本项目的意义很直接：内置的连接器预设是一条服务一条，
接十家就得填十次 Key；接上 OpenConnector 之后，**一条连接器后面挂着一千多家**，而且凭据留在网关那一侧，
智能体只拿得到动作的 schema 和执行结果——这和本项目「危险动作先过审批闸门」是同一个路子：
把权力关在边界里，不交给模型进程。

用法：在它的仓库里 `docker compose up` 把网关跑起来（默认 3000 端口），
回到 **设置 → 连接器 → 推荐连接器 → OpenConnector 网关**，点「接入」即可。

> 这类外部项目的名称与商标归各自权利人所有；此处仅为说明互操作性，不代表任何关联或背书。
> 我们借鉴过、但没有复制代码的项目，逐条记在 [NOTICE.md](NOTICE.md) 第四节。

## 文档

| | |
|---|---|
| [功能清单](docs/功能清单.md) | 全部能力、内置技能与工具 |
| [案例](docs/案例.md) | README 上那几张图是怎么做出来的 |
| [安装与启动](docs/安装与启动.md) | 安装包、源码、Windows、常见卡壳 |
| [配置模型](docs/配置模型.md) | 各服务商 base_url / 模型名对照 |
| [命令行用法](docs/命令行用法.md) | CLI 参数、管道、`--json`、脚本和 cron |
| [扩展](docs/扩展.md) | 写技能、接 MCP、装插件、建专家 |
| [IM 与定时任务](docs/IM与定时任务.md) | 飞书 / QQ / 企微 / 微信 / 钉钉，cron |
| [多人协作](docs/多人协作.md) | 多租户、账号、权限、积分额度 |
| [安全](docs/安全.md) | 审批闸门、黑白名单、审计 |
| [数据同步与搬家](docs/数据同步与搬家.md) | 数据存在哪、什么跟着账号走、换电脑怎么整个搬过去 |
| [部署](docs/部署.md) | 服务器 / Docker / 反代 |
| [实现细节](docs/实现细节.md) | agent 主循环怎么转的 |
| [路线图](docs/路线图.md) | 接下来做什么：无限画布、把企业方案里的工具搬回来 |
| [变更记录](CHANGELOG.md) | 一句话一条，最新在上面 |
| [参与贡献](CONTRIBUTING.md) | 项目结构、测试、提 PR |
| [开源与商业版边界](docs/开源与商业版边界.md) | 哪些开源、哪些收费，以及这条线是怎么划的 |

## 协议

一句话：**自己用、学习用、非营利机构用——免费；拿去赚钱（公司内部提效也算）——找作者买商业授权。**
协议是 [PolyForm Noncommercial 1.0.0](LICENSE)，哪些算商用、怎么谈见 [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md)。

**开源版有没有被砍过？没有。** 你在这个仓库里看到的就是全部能力：Agent 主循环、40+ 工具、
短剧画布、IM 远程指挥、执行追踪、自进化与记忆，连多租户和企业管理后台都在里面，
没有一处功能开关、试用倒计时或者「此功能需商业版」的灰按钮。
商业授权卖的是另一类东西——SSO、审计外送、内网离线部署、白标、SLA。
这条线是怎么划的、每个模块归哪边，写在 [开源与商业版边界](docs/开源与商业版边界.md)。

**协议管到哪儿为止。** 除另有说明外，本仓库自行编写的源码、脚本、测试、内置技能与文档按上述协议授权。
这份协议**不授予**任何第三方产品、服务、API、商标、服务标记、商号、logo、图标、品牌素材、文档或截图的权利——
那些归各自权利人。文档与连接器目录中出现的第三方名称、链接、权限范围仅用于识别服务、说明如何互通；
被收录**不代表**对方的背书、赞助、合作、认证或审核。
向本仓库贡献素材时，只提交你有权提交的东西；能链官方公开资源就别把品牌文件拷进仓库。

Copyright (c) 2026 开发者猫叔

## 免责与边界

**这是什么。** OpenWorkBuddy 是 开发者猫叔 从零写起的独立开源项目，全部源码在本仓库公开可查。
架构、数据结构、工具协议、权限模型、记忆与自进化机制均为自行设计与实现；
所借鉴的外部项目及其边界，已在 [NOTICE.md](NOTICE.md) 第四节逐条列明（看过、学过、没抄）。

**名字怎么来的。** `Work` + `Buddy` 是两个通用英文词（办公 + 搭档），`Open-` 前缀沿用开源项目的通行做法，
合起来直白描述这个项目做的事：一个开源的办公搭档。它不指向、不影射、也不试图借用任何特定公司的产品。

**与第三方的关系：没有。** 本项目与腾讯公司及其 WorkBuddy 产品无任何关联、授权、赞助或背书关系，
不含其任何代码、素材、界面资源或非公开信息。「WorkBuddy」若为他人注册商标，其权利归各自权利人所有；
本项目在文档中提及第三方名称时，仅为说明兼容性或做事实区分（指示性使用），不主张任何权利。

**互操作性说明。** 本项目支持导入 Claude Code、Codex、Claude Cowork 等工具的记忆文件，
以及对接飞书、企业微信、QQ 等平台的**公开开放接口**。这些均通过各自公开发布的文档与 API 实现，
不涉及逆向工程，也不使用任何未公开的协议。

**发现问题请直接联系。** 如果你是某商标或著作权的权利人，认为本项目的某处表述或实现有不妥，
请通过 [Issues](https://github.com/CatCatUncle/openworkbuddy/issues) 或 [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md)
里的方式联系作者，我会在核实后尽快修改——这比走别的路都快。

## 支持这个项目

这个项目没有公司、没有推广预算，能被看见基本只靠一件事：**你点的那颗 ⭐**。

<p align="center">
  <a href="https://github.com/CatCatUncle/openworkbuddy"><img src="https://img.shields.io/github/stars/CatCatUncle/openworkbuddy?style=for-the-badge&logo=github&label=Star%20this%20repo&color=5b5ff7" alt="Star this repo"></a>
</p>

- **点 Star** —— 仓库右上角那颗星。它直接决定了还在到处找「能落文件的本地 AI 助理」的人能不能刷到这个项目。
- **点 `Watch → All Activity`** —— 新版本、新技能、新模型渠道，GitHub 会替我通知你，不用我发广告。
- **把它转给一个人** —— 一个天天手搓 PPT、周报、会议纪要的同事，比一百次曝光管用。

真用出问题了，[开个 issue](https://github.com/CatCatUncle/openworkbuddy/issues/new) 比点 Star 更值钱——
每一条都会看。贴之前扫一眼，别把 API Key 带上。

## 贡献者

感谢每一个动手改过这个项目的人。想加入他们：[参与贡献](CONTRIBUTING.md)。

<p align="center">
<a href="https://github.com/CatCatUncle/openworkbuddy/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=CatCatUncle/openworkbuddy" alt="OpenWorkBuddy contributors">
</a>
</p>

## Star 历史

<p align="center">
<a href="https://star-history.com/#CatCatUncle/openworkbuddy&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=CatCatUncle/openworkbuddy&type=Date&theme=dark">
    <img src="https://api.star-history.com/svg?repos=CatCatUncle/openworkbuddy&type=Date" alt="Star History Chart" width="600">
  </picture>
</a>
</p>
