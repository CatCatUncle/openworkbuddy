# 生态层附加许可（MIT） / Ecosystem Exception (MIT)

OpenWorkBuddy 整体按 [PolyForm Noncommercial License 1.0.0](./LICENSE) 发布，商用需要
[单独授权](./COMMERCIAL-LICENSE.md)。

**但有一部分不受这条限制。** 下面列出的路径，著作权人 **开发者猫叔** 在 PolyForm 之外
**额外**按 MIT 许可授予所有人——包括商业使用。两份许可是**并行**的：这些文件你可以任选
其一遵守，选 MIT 就不受非商业限制。

---

## 一、按 MIT 授权的路径

| 路径 | 是什么 | 为什么可以随便拿 |
|---|---|---|
| `deploy/` | Caddyfile、环境变量样例、部署说明 | 部署配置本来就是给人抄进自己环境的 |
| `Dockerfile` `docker-compose.yml` `.dockerignore` | 容器化定义 | 同上 |
| `.github/workflows/` | CI 与发版流水线 | 同上 |
| `scripts/` | 出图、打包、录 demo、跑统计的脚手架 | 跟产品能力无关的工具脚本 |
| `eval/tasks.js` `eval/baseline.json` | 评测任务集与基线分 | 分数要能被任何人复跑才算数，拦着商业公司验证毫无意义 |
| `skills/skill-creator/` | 写技能包的模板与规范 | 模板必须能被自由复制，否则没人给这个项目写技能 |
| 文档中的示例代码 | `README*.md`、`CONTRIBUTING.md`、`docs/**.md` 里 ` ``` ` 代码块内的片段，以及技能 / 插件 / 连接器的**格式规范**本身 | 规范就是让人照着实现的 |

> 规范（格式、字段名、目录结构、接口形状）本来也不是著作权保护的对象。
> 写在这里是为了让人不必纠结这件事：**照着写你自己的实现，不用问。**

## 二、不在 MIT 范围内的

除上表之外的一切，照旧按 PolyForm Noncommercial 1.0.0——主要是**主程序**：
`server.js` `agent.js` `tools.js` `llm.js` `im*.js` `org.js` `admin.js` `account.js`
`security.js` `evolve.js` `memory.js` `cli*.js` `engines/` `public/`，以及
`skills/` 下除 `skill-creator/` 外的技能包。

名称 **OpenWorkBuddy**、项目图标与品牌标志**不在任何一份许可的范围内**，见
[COMMERCIAL-LICENSE.md](./COMMERCIAL-LICENSE.md) 的商标一节。MIT 授的是代码的版权许可，
不是商标许可。

## 三、你自己写的东西归你（澄清，不是让渡）

这条是说给准备给这个项目写东西的人听的：

> **你写的技能包、插件、连接器配置、工作流、提示词、模板，是你自己的作品，
> 不是 OpenWorkBuddy 的衍生作品。**

你想怎么授权就怎么授权，想拿去卖也可以，跟本项目的协议没关系——
就像用 Word 写的文档不归微软一样。

会变成衍生作品的只有一种情况：**你把本项目的代码复制进你的东西里**（第二节那些文件）。
调用接口、遵守格式、装进来跑，都不算。

## 四、这份文件怎么改

只能由著作权人放宽，不会收紧：**已经按 MIT 发出去的版本，收不回来**，
新版本也不会把上表里的路径拿走。要加路径，改这份文件并在 CHANGELOG 里记一笔。

为什么开这个口子、还考虑过开哪些没开，见
[docs/开源与商业版边界.md](./docs/开源与商业版边界.md) 第 3 节。

---

## MIT License

Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

## In English

OpenWorkBuddy as a whole is licensed under the
[PolyForm Noncommercial License 1.0.0](./LICENSE); commercial use requires a
[separate license](./COMMERCIAL-LICENSE.md).

**The paths listed in section 1 above are an exception.** The copyright holder
additionally licenses them under the MIT License (full text above), in parallel
with PolyForm — commercial use included. Pick either license for those files.

In short: deployment configs (`deploy/`, `Dockerfile`, `docker-compose.yml`),
CI workflows (`.github/workflows/`), helper scripts (`scripts/`), the evaluation
task set and baseline (`eval/tasks.js`, `eval/baseline.json`), the skill-writing
template (`skills/skill-creator/`), and code samples plus format specifications
in the documentation are MIT. Everything else — the application itself — stays
PolyForm Noncommercial.

**Anything you write yourself** — skills, plugins, connector configs, workflows,
prompts — **is your own work, not a derivative of this project.** License it
however you like, sell it if you want. Only copying this project's code into
your own work makes it a derivative.

The name **OpenWorkBuddy** and the project's logo are outside every license
here; MIT grants copyright permission, not trademark permission.
