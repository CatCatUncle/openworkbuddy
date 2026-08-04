# WorkBuddy 复刻版 — AI Agent 办公工作台

开源复刻腾讯 WorkBuddy 的核心能力：**一句话下任务，AI 自主规划、拆解、执行，交付可验证的成果文件**（PPT / Word / Excel / 报告等）。

不绑定任何一家大模型：默认走 OpenAI 兼容接口（DeepSeek / 通义 Qwen / 智谱 GLM / Kimi / Ollama 本地模型），Claude 仅为可选适配器。

## 功能总览

| 功能 | 说明 |
|---|---|
| 🤖 Agent 自主执行 | 自然语言任务 → 规划 → 工具调用循环 → 交付成果，工作台实时展示每一步 |
| 🎚️ Ask / Plan / Craft 模式 | 问答（只读）/ 规划（只出计划）/ 执行（完整交付），输入框旁一键切换 |
| ⚙️ 设置中心 | 仿官方设置中心：模型管理（预设+自定义模型切换）、智能体参数、个性化、长期记忆、工作空间（原生文件夹选择）、IM 配置——全部界面可改、保存即热生效 |
| 🛠️ 代码执行 | 内置 Node.js 沙箱执行，pptxgenjs / docx / exceljs 生成办公文件 |
| 📦 技能系统 | `skills/` 目录放技能包（markdown），agent 按需加载；内置 PPT 设计、Excel 报表、周报三个技能 |
| 🔌 MCP 连接器 | 标准 Model Context Protocol 客户端（stdio），接入任意 MCP 服务器，工具自动注入 |
| 👥 专家与专家团 | 多智能体：主协调者把子任务委派给调研专员/数据分析师/文案写手/PPT设计师等专家子代理 |
| 📱 IM 远程指挥 | 飞书机器人（发消息下任务）、企业微信群机器人（结果推送）、通用 Webhook（任意 IM 桥接） |
| ⏰ 自动化定时任务 | cron 定时自动执行任务（如每天 9 点生成晨报），结果推送企业微信 |
| 🔄 多模型可插拔 | DeepSeek / Qwen / GLM / Kimi / Ollama / OpenAI / Claude，改配置即切换 |

## 快速开始

```bash
npm install
# 首次启动会自动从 config.example.json 生成 config.json，填入你的模型 API Key（推荐 DeepSeek）

npm start        # 方式一：Web 版，浏览器打开 http://localhost:3800
npm run app      # 方式二：桌面版（Electron 独立窗口）
npm test         # 端到端测试（模拟 LLM，不需要 API Key）
```

> 国内下载 Electron 建议先设置镜像：`set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`

### 模型配置（config.json）

默认使用 OpenAI 兼容接口。常用配置：

```jsonc
{
  "provider": "openai",
  "openai": {
    // DeepSeek（推荐，便宜且 agent 能力强）
    "base_url": "https://api.deepseek.com/v1",
    "api_key": "sk-...",
    "model": "deepseek-chat"
  }
}
```

其它选择（改 base_url / model 即可）：

| 提供商 | base_url | model 示例 |
|---|---|---|
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| 通义 Qwen | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-max` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-plus` |
| Kimi | `https://api.moonshot.cn/v1` | `moonshot-v1-32k` |
| Ollama 本地 | `http://localhost:11434/v1` | `qwen3:14b` |

API Key 也可用环境变量提供：`OPENAI_API_KEY`（或 Claude 的 `ANTHROPIC_API_KEY`）。

> 使用 Claude 时需额外安装可选依赖：`npm install @anthropic-ai/sdk`，并把 `provider` 改为 `anthropic`。

## 技能系统

在 `skills/<名称>/skill.md` 添加技能包：

```markdown
---
name: my-skill
description: 一句话描述（agent 据此判断何时使用）
---
详细操作指南 / 代码模板……
```

启动时技能描述会注入系统提示；agent 执行相关任务时通过 `use_skill` 工具加载完整内容。

## MCP 连接器

在 `config.json` 的 `mcp_servers` 配置：

```json
"mcp_servers": [
  { "name": "filesystem", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:/data"] }
]
```

服务器暴露的工具自动注入 agent（命名 `mcp__服务器__工具`）。

## 专家与专家团

`experts.json` 定义专家（独立系统提示的子智能体）。主 Agent 收到复杂任务会拆解并用 `delegate_to_expert` 逐阶段委派（调研 → 分析 → 写作 → 做 PPT），专家与主 Agent 共享工作目录。可自行增删专家。

## IM 远程指挥

### 飞书机器人
1. [飞书开放平台](https://open.feishu.cn) 创建自建应用，开通机器人能力与 `im.message.receive_v1` 事件
2. 事件回调地址填 `http(s)://你的公网地址/im/feishu/events`（加密方式选"不加密"）
3. `config.json` 填 `im.feishu.app_id / app_secret`
4. 在飞书私聊或 @机器人 发任务，执行完自动回复

### 企业微信
群里添加"群机器人"，把 webhook 地址填到 `im.wecom_bot_webhook` —— 任务完成、定时任务结果会推送到群。

### 通用 Webhook（桥接任意 IM / 自动化工具）
```bash
curl -X POST http://localhost:3800/im/task \
  -H "Content-Type: application/json" \
  -d '{"message": "帮我生成本周周报", "secret": "配置的密钥"}'
```
同步返回 `{ reply, files }`。微信个人号框架、钉钉、iOS 快捷指令等都可以通过它接入。

## 自动化定时任务

Web 界面右侧面板直接添加，或调 API：

```bash
curl -X POST http://localhost:3800/api/schedules \
  -H "Content-Type: application/json" \
  -d '{"name": "每日晨报", "cron": "0 9 * * 1-5", "task": "抓取今天的AI行业新闻，生成晨报 markdown"}'
```

cron 5 字段（分 时 日 月 周），支持 `*` `,` `-` `*/n`。结果自动推送企业微信（如已配置）。

## 项目结构

```
server.js      服务器入口（Web API + SSE + 定时任务 API）
agent.js       Agent 核心运行时（协调者/专家循环、工具路由）
llm.js         LLM 适配层（OpenAI 兼容 + 可选 Anthropic）
tools.js       内置工具（run_node/文件读写/网页抓取）
skills.js      技能加载器          skills/     技能包
mcp.js         MCP 客户端（stdio）
experts.json   专家团定义
im.js          飞书/企业微信/通用 Webhook
scheduler.js   定时任务调度器
public/        Web 工作台前端      workspace/  成果文件输出目录
```

## 安全提示

- `run_node` 会真实执行模型生成的代码，请只在个人/受信环境使用；对外暴露服务时务必设置 `im.webhook_secret` 并加反向代理鉴权。
- 成果文件目录 `workspace/` 对 Web 界面可下载，不要放敏感文件。
