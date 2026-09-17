# 第三方组件与署名（NOTICE）

OpenWorkBuddy 自身按 [PolyForm Noncommercial 1.0.0](LICENSE) 发布，商业授权见 [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md)。
但打包出去的桌面版里还住着一批别人的代码和资源，它们各自的许可照旧有效。这份文件就是把它们一条条写清楚——
谁、哪个版本、什么许可、去哪拿源码。**发版前如果动了依赖，记得回来改这里。**

## 一、前端（直接放进 `public/`，跟着页面一起发出去）

| 组件 | 版本 | 许可 | 出处 | 我们怎么用的 |
|---|---|---|---|---|
| Lucide 图标 | sprite 子集 | ISC | https://lucide.dev | 挑用到的图标做成 `<symbol>` sprite，内联进 `public/index.html`。内联是为了断网也能开，且图标跟着 `currentColor` 变色 |

> 内联 sprite 只取了用到的那些图标，路径数据原样保留，没有改形。

## 二、运行时依赖（`node_modules`，Electron 包里 `asar: false` 一并带出）

| 包 | 版本 | 许可 | 出处 |
|---|---|---|---|
| @anthropic-ai/sdk | 0.125.0 | MIT | https://github.com/anthropics/anthropic-sdk-typescript |
| @dagrejs/dagre | 1.1.8 | MIT | https://github.com/dagrejs/dagre |
| @larksuiteoapi/node-sdk | 1.72.0 | MIT | https://github.com/larksuite/node-sdk |
| @viz-js/viz | 3.29.0 | MIT | https://github.com/mdaines/viz-js |
| @joint/core | 4.3.3 | MPL-2.0 | https://github.com/clientIO/joint |
| docx | 9.7.1 | MIT | https://github.com/dolanmiu/docx |
| echarts | 6.1.0 | Apache-2.0 | https://github.com/apache/echarts |
| exceljs | 4.4.0 | MIT | https://github.com/exceljs/exceljs |
| express | 4.22.2 | MIT | https://github.com/expressjs/express |
| mermaid | 11.17.0 | MIT | https://github.com/mermaid-js/mermaid |
| nodemailer | 9.1.1 | MIT-0 | https://github.com/nodemailer/nodemailer |
| pptxgenjs | 3.12.0 | MIT | https://github.com/gitbrent/PptxGenJS |
| qrcode | 1.5.4 | MIT | https://github.com/soldair/node-qrcode |
| Electron | 43.x | MIT | https://github.com/electron/electron |

Apache-2.0 的那条（echarts）要求保留它自己的 NOTICE 和许可头——我们没有改它的源码，
安装出来的包里原样带着，这一条就算尽到了。
短剧画布通过 `/vendor/joint/joint.min.js` 使用 `@joint/core` 的原文件，不改源码。
短剧画布使用 `@dagrejs/dagre` 计算节点的有向无环图（DAG）布局，不改源码。

## 三、外部服务（不随包发布，用户自己配）

PlantUML 渲染在本机没装 `plantuml` 命令时，会把图源发给用户配置的 PlantUML 服务器或 kroki。
这是一次网络请求，不是分发别人的代码，因此不涉及许可，但涉及隐私——
**图里有敏感内容就别用远端渲染**，装个本机 `plantuml` 更稳妥。

[toolward](https://github.com/CatCatUncle/toolward) 是**可选**的外部命令行工具：不随包发布、不在 `package.json` 里、
运行时也不会自动下载（不走 `npx`）。只有用户自己 `npm i -g toolward` 装到本机，装技能和存 MCP 连接器时
才会作为子进程调用一次；没装、崩了、超时一律当它没跑过，功能一个字不变。
它是 PolyForm Noncommercial 1.0.0 授权——个人、教学、学术、公益、政府免费，**公司里用要单独授权**，
所以装不装、要不要买授权由用户自己决定，本项目不替用户承担、也不替用户附加这项义务。
调用时递过去的连接器配置已经脱敏：`env` / `headers` 的值全换成 `***`、URL 剪到路径为止，密钥不出本机。

## 四、我们借鉴但没有复制代码的项目

写下来是为了讲清楚边界——**看过、学过、没抄**：

- [Toonflow-app](https://github.com/HBAI-Ltd/Toonflow-app)（Apache-2.0）：短剧技能包与分镜提示词的组织方式；
- [LocalMiniDrama](https://github.com/xuanyustudio/LocalMiniDrama)（MIT）：分镜数据表结构与切分流程；
- [OpenConnector](https://github.com/oomol-lab/open-connector)（Apache-2.0）：README 的组织方式（活数字徽章、
  「协议管到哪儿为止」那段第三方权利声明、求 Star 与贡献者墙的收尾），以及「凭据留在网关一侧、
  只把动作 schema 交给智能体」的边界划法。代码一行没拿；它作为连接器被收进了预设目录，走 MCP 接入。

将来如果真的搬了它们的文件进来，会在上面第一节里按条登记，并保留原始许可头。
