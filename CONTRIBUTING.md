# 参与贡献

欢迎提 issue 和 PR。这个项目没有构建步骤、没有前端框架，上手成本很低。

## 开发环境

```bash
git clone https://github.com/CatCatUncle/openworkbuddy.git
cd openworkbuddy
npm install
npm test        # 全套测试，用模拟 LLM，不需要 API Key
npm start       # 改前端就直接刷新浏览器；改后端重启这条命令
```

前端就是一个手写的 `public/index.html`，改完刷新即可，没有热更新也不需要打包。

## 提 issue 说清这几件事

用的哪个模型服务商和模型名、复现步骤、期望什么实际什么、终端里的报错原文。**贴日志前先自己扫一眼有没有 API Key、令牌、内网地址**，别把这些贴上来。

## 代码约定

- **CommonJS**（`require`，不是 `import`），Node 18+ 能直接跑，不引入编译步骤。
- **不加构建工具、不引前端框架。** 这是这个项目的产品决定，不是还没来得及做——它让任何人 clone 下来就能改。
- **注释写「为什么」，不写「是什么」。** 代码本身说得清做了什么，值钱的是当初为什么这么选、绕开了什么坑。中文注释。
- **新功能要带测试。** 后端加到 `test/e2e.js`（模拟 LLM，不需要 Key）；纯前端的行为加到 `test/frontend.js`（在真 Chromium 里跑）。
- **动到落盘的数据就走 `store.js`**，别自己 `fs.writeFileSync` 一个 JSON——原子写和 `.bak` 兜底都在那儿。
- 提交信息用中文，一句话说清这次改了什么、解决了什么问题。

## 千万别提交这些

`config.json`（存着所有 API Key）、`data/`（账号、会话、用量）、`workspace/`（成果文件）、`node_modules/`、任何 `.log`。这些 `.gitignore` 已经挡了，但**提交前自己再 `git diff --cached` 扫一眼有没有 Key 和令牌**。真提交上去了，光删一次提交没用，历史里还在。

## 流程

1. Fork → 建分支（`feat/xxx` 或 `fix/xxx`）
2. 改代码 + 补测试 → `npm test` 全绿
3. 开 PR，说清**改了什么、为什么这么改**；改了界面的话附张截图

## 好上手的方向

| 方向 | 难度 |
|---|---|
| **写一个技能** —— 一个 Markdown 文件放进 `skills/`，不用碰任何代码 | ⭐ |
| **补一个模型服务商预设** —— `config.example.json` 和 README 的表里加一行 | ⭐ |
| **改文档 / 纠错别字** | ⭐ |
| **加一个内置专家** —— `experts.json` 里加一份系统提示 | ⭐⭐ |
| **接一个新的 IM 渠道** —— 照着 `im-qq.js` / `im-wechat.js` 的样子写 | ⭐⭐⭐ |
| **加一个内置工具** —— `tools.js` 里加，记得过安全闸 | ⭐⭐⭐ |

> 贡献的代码同样按 [PolyForm Noncommercial 1.0.0](LICENSE) 发布。

## 项目结构

```
server.js        Web API + SSE + 各种端点
agent.js         Agent 运行时（协调者/专家循环、工具路由、系统提示）
llm.js           LLM 适配层（OpenAI 兼容 + Anthropic）
tools.js         内置工具
skills.js        技能加载器            skills/       技能包
plugins.js       Agent Plugins 1.0.0   plugins/      已装插件
mcp.js           MCP 客户端（stdio / Streamable HTTP）
account.js       账号 / 鉴权 / 用量 / 积分
security.js      安全中心（审批闸门、黑白名单、审计）
store.js         JSON 落盘（原子写 + .bak 兜底）  im-store.js   IM 会话仓库
experts.json     专家与专家团定义
im.js            IM 总线            im-qq.js / im-wechat.js / im-ilink.js
scheduler.js     定时任务
electron-main.js 桌面壳             cli.js        命令行
pet.js           桌面宠物窗口（透明置顶挂件）  pet-preload.js / public/pet.html
public/          前端（单文件，没有构建步骤）
workspace/       成果文件输出        data/         账号与会话
```

## 测试

```bash
npm test          # 端到端，用模拟 LLM，不需要 API Key
```

<details>
<summary><b>覆盖了哪些（展开）</b></summary>

cron 解析（越界 / 步长 0 / 日周取或）、定时任务运行时（补跑一次 / 不叠跑 / 结果落盘）、
命令闸（换行 / `$()` / 反引号 / 子 shell / 包装词 全拆得开、黑名单压得住放行名单、代码闸）、
账本（坏文件不被空账本覆盖 / 写盘原子 / 登录限流 / https 认得出）、
积分限额（默认关着：余额 0 也照跑、不扣分但流水照记 / 开了才扣才拦 / 开关即时生效，全程在临时目录里跑不碰真账号）、
改登录名（撞名与不合法挡得住 / 账本、登录令牌、用量流水连同充值记录的「谁充的」一起搬走）、
头像规则（emoji 按字素簇算长度 / 只收 `data:image` / 挡外链与标签 / 限 256KB）、
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

</details>

---

[← 回 README](README.md)
