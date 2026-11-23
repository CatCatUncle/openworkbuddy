> 2026-11-15 Google 最新状态：正式域名 HTML 文件所有权验证已完成；sitemap 实际提交成功、发现 19 页；首页显示已收录，更新请求已进入优先抓取队列。此前“未访问控制台 / 浏览器不可用”的条目为历史记录。完整回执见工作区 `05_营销获客/Google索引提交回执-20261115.json`。

# OpenWorkBuddy SEO / GEO 实施记录

**最新更新（2026-11-15）：** 已上线 19 页，增加深圳、广东企业智能体与私有化方案。备案已按用户确认展示；Bing 全站 HTTP 200，百度已成功推送 10 页，9 页按配额每日自动续提。下文早期 16 页内容作为历史记录保留。

部署日期：2026-11-15（Asia/Shanghai）。正式入口：https://openworkbuddy.work/

## 已上线

原有 8 个可索引页面扩展至 16 个。首页明确可编辑办公成果、企业私有化部署、自选模型和智能体二次开发四个重点。

| 搜索需求 | 页面 |
| --- | --- |
| WorkBuddy 源码可查看替代方案 | https://openworkbuddy.work/alternatives/workbuddy/ |
| 豆包工作源码可查看替代方案 | https://openworkbuddy.work/alternatives/doubao/ |
| 千问办公源码可查看替代方案 | https://openworkbuddy.work/alternatives/qwen/ |
| Claude Cowork 源码可查看替代方案 / 自托管替代方案 | https://openworkbuddy.work/alternatives/claude-cowork/ |
| Codex 源码可查看替代方案 / 办公工作台 | https://openworkbuddy.work/alternatives/codex/ |
| AI 办公 Agent 功能 | https://openworkbuddy.work/features/ |
| 智能体二次开发 / Skills / MCP | https://openworkbuddy.work/developers/ |
| 企业 AI 私有化部署 / Docker / 内网 | https://openworkbuddy.work/guides/private-deployment/ |

五个平替专题分别说明相关任务、选择标准、评估提示词、验收方法、产品边界和资料来源。首页、导航、平替索引、企业页、英文页和页脚互相链接。

“源码可查看替代方案”作为选型用语，许可准确标为 PolyForm Noncommercial。个人非商用等许可用途免费，企业实际业务、客户交付和商业集成需商业授权。Codex CLI 本身开放源码，页面明确区分它与办公工作台。私有化工作台和离线模型分别说明，避免把云模型调用描述成完全离线。

## 抓取与内容理解

- 主要内容直接写入静态 HTML，不依赖 JavaScript 渲染。
- 每页独立 title、description、canonical、H1、社交分享元数据。
- WebSite、WebPage、SoftwareApplication、SoftwareSourceCode 统一产品身份；文章和面包屑对应具体页面。
- FAQPage 与页面实际可见的问答一致；不把 FAQ 标记解释为必然展示富结果。
- 中英文主页保留互相对应的 hreflang。
- sitemap.xml 收录 16 个正式域名页面，404 设为 noindex。
- robots.txt 允许公开内容抓取，显式允许 OAI-SearchBot；原有通用抓取策略保留。
- llms.txt 汇总身份、产品事实、全部入口、许可和边界；llms-full.txt 提供完整正文及来源地址。这些文件便于读取，不代表排名或 AI 引用保证。
- HTTP、www 入口跳转到 HTTPS 正式域名；直接 index.html 地址跳转到目录地址并保留查询参数。
- 保留原有 Google/Bing 验证文件，正式站不添加尚未获用户确认的备案号。

## 验证与提交

`python3 scripts/verify.py` 校验 16 个页面、694 处内部链接及资源引用、JSON-LD、可见 FAQ、canonical、robots、sitemap、AI 文本与 IndexNow Key。

`python3 scripts/verify.py --live https://openworkbuddy.work` 确认全部线上 HTML 与本地构建逐字节一致。额外验证 HTTP / www / index.html 跳转、查询参数、真正 404、公开抓取文件及六种爬虫 User-Agent 的 HTTP 200 响应。模拟 User-Agent 成功不等于真实搜索引擎已经访问。

IndexNow 已提交 16 个 URL，响应 **HTTP 202**，即 URL 已收到、Key 验证待完成；实际收录尚未确认。公开 Key 文件内容与构建一致。详细响应保存在被 Git 忽略的 `deployment-results.json`。

Google 和 Bing 验证文件返回 200，但文件可访问不等于已经确认搜索控制台里的账户验证状态。本次没有访问 Google Search Console 或百度搜索资源平台，没有声称在这些账户中提交 sitemap。

浏览器预览工具报告 `The browser access host is unavailable`，因此没有完成本轮桌面/移动端截图验收。沿用原站样式并增加响应式链接与正文样式，已完成源码及 HTTP 验证。

仓库全量 `npm test` 的执行结果另记于 DEPLOYMENT.md；官网构建与验证独立于应用测试。

## 后续发布

在 `website/` 目录运行：

```sh
python3 scripts/build.py
python3 scripts/verify.py
# 发布到原部署环境后：
python3 scripts/verify.py --live https://openworkbuddy.work
python3 scripts/submit-indexnow.py
```

提交脚本先校验线上 sitemap 和公开 Key，再通知 IndexNow。更新正文时同步更新页面修改日期；已有文章保留首次发布日期。

Google Search Console 与百度搜索资源平台若已具备管理员账户，可在那里提交 `https://openworkbuddy.work/sitemap.xml`，并检查抓取、规范网址和收录报告。不要使用已废弃的 Google sitemap ping，也不要把普通办公产品页面提交给限定内容类型的 Google Indexing API。

建议随后用脱敏的真实成果替换部分评估示例，公开源资料范围、使用版本、模型配置与验收结果；只有实际测量后才发布成功率、耗时与竞品对比数字。通过搜索控制台记录品牌词、五个平替词、私有化与二次开发词的展示/点击，再定期抽样记录 AI 回答是否提及项目及引用了哪个 URL。不同日期、地区和模型的结果需分开记录。

参考：[Google AI features and your website](https://developers.google.com/search/docs/appearance/ai-features)、[OpenAI 爬虫说明](https://developers.openai.com/api/docs/bots)、[IndexNow 协议](https://www.indexnow.org/documentation)。

全量应用测试已完成：`npm test` 共 184 个套件，182 个通过，2 个失败；端到端套件（含前端与管理后台）通过。失败项：

- `layers`：已有的 `website/assets/site.js` 被应用七层源码检查识别为未分层文件；本次未修改该 JavaScript 文件，也未改变应用分层规则。
- `conn-pool`：8 个并发任务挂载断言失败，记录为 `got6=6, up=false, held=1`；本次未修改连接池或应用运行时源码。

官网独立构建、16 页验证与线上一致性验证全部通过。全量日志保存在本机 `/tmp/owb-npm-test.log`；未把测试日志或临时数据上传到官网。


## SEO / GEO 更新（2026-11-23）

已围绕通用 SEO 基础完善 21 个可索引页面：静态 HTML 正文、独立 title / description / canonical、准确的 JSON-LD、可见 FAQ、内部链接、sitemap、robots 与可选的 llms.txt。新增内容明确 PolyForm Noncommercial 1.0.0 授权边界，避免把源码可查看描述为可无条件商用。

GEO 文案改为可验证的内容与抓取说明，不承诺固定排名或 AI 引用。Google 的 AI 搜索功能沿用常规搜索可访问性和内容政策，不要求专用 GEO 标记或 llms.txt；llms.txt 作为可选阅读索引保留。OAI-SearchBot 与 GPTBot 在 robots 策略中区分。

按最新要求，企业案例只发布在艾景特官网，不放在本产品官网或仓库 README。项目站链接至艾景特科技企业服务页，不复制客户案例。

本地构建验证：21 页、1043 处内部链接和资源引用通过 `python3 scripts/verify.py`。本轮线上发布后将补充线上一致性结果。

参考：[Google AI features and your website](https://developers.google.com/search/docs/appearance/ai-features)、[Google AI search optimization guide](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide)、[OpenAI crawler documentation](https://developers.openai.com/api/docs/bots)。
