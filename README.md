<p align="center">
  <img src="build/icon.png" width="132" alt="OpenWorkBuddy">
</p>

<h1 align="center">OpenWorkBuddy</h1>

<p align="center">
  <b>腾讯 WorkBuddy 的开源复刻版</b><br>
  一句话下任务，AI 自己规划、拆解、动手——交给你的是<b>能打开验收的成果文件</b>，不是一段聊天记录。
</p>

<p align="center">
  <a href="https://github.com/CatCatUncle/openworkbuddy/releases"><b>⬇ 下载安装包</b></a> ·
  <a href="docs/安装与启动.md">从源码启动</a> ·
  <a href="docs/功能清单.md">功能清单</a> ·
  <a href="#文档">全部文档</a>
</p>

<p align="center">
  <a href="https://github.com/CatCatUncle/openworkbuddy/stargazers"><img src="https://img.shields.io/github/stars/CatCatUncle/openworkbuddy?style=flat-square&logo=github&label=Star&color=5b5ff7" alt="Star"></a>
  <a href="https://github.com/CatCatUncle/openworkbuddy/forks"><img src="https://img.shields.io/github/forks/CatCatUncle/openworkbuddy?style=flat-square&logo=github&color=5b5ff7" alt="Fork"></a>
  <img src="https://img.shields.io/badge/Node-18%2B-5b5ff7?style=flat-square" alt="Node 18+">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-PolyForm%20NC-5b5ff7?style=flat-square" alt="License"></a>
</p>

<p align="center">
  <sub>个人与非商业用途免费 · 商业使用需单独授权 · 作者 开发者猫叔</sub>
</p>

---

## 它替你做完的事

| 你说一句 | 它交给你 |
|---|---|
| 帮我出一份 Q3 复盘 PPT，数据用这个 Excel | 读表 → 算 → 一个能直接放的 `.pptx` |
| 调研国内 AI 陪伴产品，出一份报告 | 联网搜 → 逐个打开读 → Markdown / Word |
| 把这份材料做成手机上能看的网页 | 写 HTML → 起本机服务 → 扫码就能看 |
| 每天 9 点抓行业新闻，做成晨报发我飞书 | 定时任务 + IM 推送，错过了会补跑 |

## 三个真正不一样的地方

**东西都在你自己手里。** 自托管，会话、成果文件、API Key 全在本机，默认只监听 `127.0.0.1`。不绑定任何一家模型：DeepSeek / 通义 / 智谱 / Kimi / OpenRouter / Ollama 本地模型，界面点一下就切。

**交付的是文件，不是聊天记录。** PPT / Word / Excel / 网页都是真生成的。声称写了文件却不在磁盘上，会被当场拦下来重做。

**加一个能力 = 写一个 Markdown 文件。** 丢进 `skills/`，存盘后下一条任务就生效——不改代码、不重启、不打包。再往外，MCP 连接器和 [Agent Plugins 1.0.0](https://agent-plugins.org) 开放标准都支持，别人做的插件包粘个 GitHub 地址就装。

> 还有：多任务并行、Goal 目标验收、智能体评测、双层记忆、权限档位、IM 远程指挥、桌面宠物……全部 27 项见 **[功能清单](docs/功能清单.md)**。

## 跑起来

**不想碰命令行**：去 [Releases](https://github.com/CatCatUncle/openworkbuddy/releases) 下对应的包，装完打开，填个 API Key 就能用。

| 系统 | 下哪个 |
|---|---|
| macOS · Apple 芯片 | `OpenWorkBuddy-*-mac-arm64.dmg` |
| macOS · Intel | `OpenWorkBuddy-*-mac-x64.dmg` |
| Windows 10/11 · 64 位 | `OpenWorkBuddy-*-win-x64.exe` |

> macOS 第一次打开会提示「无法验证开发者」——包没花 99 美元买苹果证书签名，不是有毒。右键 → 打开，或 `xattr -cr /Applications/OpenWorkBuddy.app`。你的数据在 `~/OpenWorkBuddy`，卸载不会删。

**从源码**（需要 Node.js 18+）：

```bash
git clone https://github.com/CatCatUncle/openworkbuddy.git
cd openworkbuddy && npm install
npm run app     # 桌面版；或 npm start 走浏览器 http://localhost:3800
```

第一次打开只有两步：**注册第一个账号**（自动是管理员）→ **粘一个模型 API Key**（当场发真实请求验活，不会等你发第一条消息才发现 Key 是错的）。然后在输入框里说人话，比如「帮我做一份介绍 OpenWorkBuddy 的 PPT」。

镜像、一键脚本、Windows、端口占用、启动卡住怎么办 → [安装与启动](docs/安装与启动.md)

## 配模型

界面 **设置 → 模型**，选渠道预设（OpenAI / Anthropic / OpenRouter / 火山方舟 / 百炼 / DeepSeek / 智谱 / Kimi / Ollama），地址和协议自动填好，只差粘 Key，保存即热生效。各家 `base_url` 和模型名对照表见 [配置模型](docs/配置模型.md)。

> `config.json` 是唯一存着所有 API Key 的文件，已经在 `.gitignore` 里，**别手滑提交**。

## ⚠️ 这个 agent 手里有 shell

它能执行命令、读写文件、访问网络——所以闸门是真拦的：命令审批、文件黑名单、URL 白名单、审计日志、四档权限。**放到公网前务必先读 [安全](docs/安全.md)**，默认配置只为本机使用而调。

## 文档

| | |
|---|---|
| [功能清单](docs/功能清单.md) | 27 项能力、内置技能与工具的全表 |
| [安装与启动](docs/安装与启动.md) | 安装包、源码、Windows、常见卡壳 |
| [配置模型](docs/配置模型.md) | 各服务商 base_url / 模型名对照 |
| [扩展](docs/扩展.md) | 写技能、接 MCP、装插件、建专家 |
| [IM 与定时任务](docs/IM与定时任务.md) | 飞书 / QQ / 企微 / 微信 / 钉钉，cron |
| [多人协作](docs/多人协作.md) | 多租户、账号、权限、积分额度 |
| [安全](docs/安全.md) | 审批闸门、黑白名单、审计 |
| [部署](docs/部署.md) | 服务器 / Docker / 反代 |
| [实现细节](docs/实现细节.md) | agent 主循环怎么转的 |
| [参与贡献](CONTRIBUTING.md) | 项目结构、测试、提 PR |

## 一起把它做下去

**觉得有用就点个 ⭐ [Star](https://github.com/CatCatUncle/openworkbuddy)。** 这个项目没有任何推广渠道，别人搜不搜得到它，基本就取决于这个数字。

**用崩了、卡住了，开个 [issue](https://github.com/CatCatUncle/openworkbuddy/issues/new) —— 哪怕只贴一句报错。** 你觉得「应该只有我一个人遇到」的那个坑，多半所有人都在踩，说出来才会被修掉。贴之前扫一眼，别把 API Key 带上。

**想动手，按投入从小到大三条路：**

- **10 分钟** —— 写个技能。一个 Markdown 文件丢进 `skills/`，存盘即生效，一行代码都不用改，见 [扩展](docs/扩展.md)
- **1 小时** —— 补一个模型渠道预设、修一处文档、给某个文件格式加上预览
- **一晚上** —— 挑个 issue 改。零构建零框架，`npm install && npm start` 就跑起来，前端改完刷新页面即可

项目结构、怎么跑测试、PR 规范都在 [参与贡献](CONTRIBUTING.md) 里。不用先开 issue 问，直接发 PR。

## 协议

[PolyForm Noncommercial 1.0.0](LICENSE)：个人、学习、学术、非营利、政府用途**免费**。
公司内部使用、对外提供服务、二次销售等商业场景，需要单独授权 —— 见 [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md)。

Copyright (c) 2026 开发者猫叔

## 免责

本项目是对腾讯 WorkBuddy 产品形态的独立开源实现，与腾讯没有任何关系，不含其任何代码或资源。「WorkBuddy」是其权利人的商标。
