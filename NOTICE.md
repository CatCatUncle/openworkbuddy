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
| @larksuiteoapi/node-sdk | 1.72.0 | MIT | https://github.com/larksuite/node-sdk |
| @viz-js/viz | 3.29.0 | MIT | https://github.com/mdaines/viz-js |
| docx | 9.7.1 | MIT | https://github.com/dolanmiu/docx |
| echarts | 6.1.0 | Apache-2.0 | https://github.com/apache/echarts |
| exceljs | 4.4.0 | MIT | https://github.com/exceljs/exceljs |
| express | 4.22.2 | MIT | https://github.com/expressjs/express |
| mermaid | 11.17.0 | MIT | https://github.com/mermaid-js/mermaid |
| pptxgenjs | 3.12.0 | MIT | https://github.com/gitbrent/PptxGenJS |
| qrcode | 1.5.4 | MIT | https://github.com/soldair/node-qrcode |
| Electron | 43.x | MIT | https://github.com/electron/electron |

Apache-2.0 的那条（echarts）要求保留它自己的 NOTICE 和许可头——我们没有改它的源码，
安装出来的包里原样带着，这一条就算尽到了。

## 三、外部服务（不随包发布，用户自己配）

PlantUML 渲染在本机没装 `plantuml` 命令时，会把图源发给用户配置的 PlantUML 服务器或 kroki。
这是一次网络请求，不是分发别人的代码，因此不涉及许可，但涉及隐私——
**图里有敏感内容就别用远端渲染**，装个本机 `plantuml` 更稳妥。

## 四、计划引入（尚未进仓库）

| 组件 | 许可 | 用途 | 约束 |
|---|---|---|---|
| @joint/core | MPL-2.0 | 短剧无限画布的底座，见 [docs/短剧画布选型.md](docs/短剧画布选型.md) | MPL 是**逐文件** copyleft：原样放进 `public/vendor/joint/`、一个字节不改，我们自己的代码就不受影响；真要改它，改动的文件得以 MPL 发出来。所以约定「只在外面包，不动里面」 |

## 五、我们借鉴但没有复制代码的项目

写下来是为了讲清楚边界——**看过、学过、没抄**：

- [Toonflow-app](https://github.com/HBAI-Ltd/Toonflow-app)（Apache-2.0）：短剧技能包与分镜提示词的组织方式；
- [LocalMiniDrama](https://github.com/xuanyustudio/LocalMiniDrama)（MIT）：分镜数据表结构与切分流程。

将来如果真的搬了它们的文件进来，会在上面第一节里按条登记，并保留原始许可头。
