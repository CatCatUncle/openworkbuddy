## SEO / GEO 发布（2026-11-23）

本轮构建更新了 21 个产品页的 SEO 元数据、结构化数据、授权文案和 AI 搜索可访问性说明。项目站不放客户案例；案例仅在艾景特公司官网展示。所有商用授权和版权声明保留。

本地命令：`python3 scripts/build.py`、`python3 scripts/verify.py`。部署目录及线上一致性检查记录将在正式发布后追加。

> 2026-11-15 Google 最新状态：正式域名 HTML 文件所有权验证已完成；sitemap 实际提交成功、发现 19 页；首页显示已收录，更新请求已进入优先抓取队列。此前“未访问控制台 / 浏览器不可用”的条目为历史记录。完整回执见工作区 `05_营销获客/Google索引提交回执-20261115.json`。

# OpenWorkBuddy 官网

**当前状态（2026-11-15）：** 用户已确认正式域名备案通过，网站备案记录为 `粤ICP备2026086918号-2`。依广东展示要求，全站页脚展示主体号 `粤ICP备2026086918号`，链接至工信部。正式站 19 个可索引页面，发布目录 `/var/www/openworkbuddy/releases/20261115-regional-services`。下文早期的待备案记录保留为历史。

静态产品官网，源文件在 `scripts/build.py`、`assets/`。没有复制应用数据库或用户资料。

## 正式域名与临时子域名

- 正式域名：`https://openworkbuddy.work/`，2026-11-05 用户已提交备案，等待审核。保留该域名原有解析和部署。
- 临时入口：`https://openworkbuddy.zhantaiyingxiao.cn/`，使用站台营销域名下的独立虚拟主机。

用户再次明确：`openworkbuddy.work` 未获批前不得展示任何 ICP 备案号，也不能借用站台营销的备案号。正式站全站 HTML 已核对没有备案号和工信部链接。站台营销名下的临时子域名按其所属网站显示已核验的 `粤ICP备2026086918号`。

构建正式官网：

```sh
python3 scripts/build.py
```

构建临时入口：

```sh
OWB_SITE_URL=https://openworkbuddy.zhantaiyingxiao.cn \
OWB_BUILD_DIR=dist-zhantai python3 scripts/build.py
```

`OWB_SITE_URL` 同步控制 canonical、Open Graph、JSON-LD、hreflang、sitemap、robots、llms 与 IndexNow 的 host。不要只替换导航链接，否则搜索引擎仍会识别为旧地址。

## 临时站点运维

- ECS：`i-bp174crzje4mamu7nxzx`，`cn-hangzhou`。
- 站点目录：`/var/www/openworkbuddy-zhantai/current`，指向一个版本目录。
- Nginx：`/etc/nginx/conf.d/openworkbuddy-zhantai.conf`。
- HTTP 配置：`deploy/nginx-zhantai-temp-http.conf`。
- HTTPS 配置：`deploy/nginx-zhantai-temp.conf`。
- 证书续期使用服务器已有的 certbot 定时任务。
- DNS：`openworkbuddy` A → `121.199.165.131`，默认线路，TTL 600 秒。

发布后检查首页、企业部署页、商业授权页、sitemap.xml、robots.txt、llms.txt、Google 验证文件和自定义 404。使用服务器内网自测无法发现阿里云入口的备案拦截，需要同时从外网验证。

## 备案完成后

1. 用户确认备案通过并提供公开备案号。
2. 给正式域名重建、部署，添加备案号和工信部查询链接。
3. 外网验证正式域名 HTTPS 和移动端页面。
4. 将临时子域名按原路径 301 跳转至正式域名，不能统一跳到首页。
5. 更新站台营销等相关网站链接，提交正式域名的 sitemap 与 IndexNow。
6. 保留临时域名的有效证书与跳转，方便用户和搜索引擎迁移。

搜索引擎收到提交不等于已收录。报告应分别注明提交响应、站点验证和实际收录状态。

## Open Source Alternatives 徽章（2026-11-06）

按用户提交目录后的要求，中英文 README 与官网公共页脚加入官方徽章，图片为 `https://www.opensourcealternatives.to/badge-osa.svg`，链接为 `https://www.opensourcealternatives.to`。目录仍在审核，添加徽章不代表已经上架。正式域名继续不展示备案信息。

本次正式站发布目录：`/var/www/openworkbuddy/releases/20261106-024517-osa-badge`；上一个版本保留用于回退。服务器 HTTPS 自测返回 200 并包含徽章。当前执行环境的外网 HTTPS 连接报 `SSL_ERROR_SYSCALL`，浏览器自动化超时，未确认目录审核端的可达性。

校验：正式站 9 个页面均包含一次徽章且没有备案号/工信部链接。`npm test` 已运行，发现 `layers` 将既有未跟踪的 `website/assets/site.js` 识别为未分层代码，后续全量测试已停止；没有为本次徽章改动修改应用层级规则。中英文 README 已提交并推送，提交为 `ed9c30c8`。

## SEO / GEO 更新（2026-11-15）

正式站已发布到 `/var/www/openworkbuddy/releases/20261115-geo-seo-final`，前一版本 `20261115-geo-seo-v2` 与原线上版本 `20261106-024517-osa-badge` 均保留。Nginx 配置备份为 `/etc/nginx/conf.d/openworkbuddy.conf.before-20261115-geo-seo`。

新增五个平替专题，以及功能总览、智能体二次开发、私有化部署指南；可索引页面由 8 增至 16。更新首页、企业页、英文页、导航内链、结构化数据、sitemap、robots 和 AI 阅读文件。直接访问 `index.html` 时 301 跳转到对应目录，保留查询参数。

本地验证 16 页、694 处内链及资源引用通过，线上全部 HTML 与构建逐字节一致。HTTP / www / index 跳转、自定义 404、验证文件、公开抓取入口和六种爬虫 User-Agent 的 HTTP 检查通过。浏览器预览工具不可用，未完成本轮截图验收。

IndexNow 已提交全部 16 个 URL，返回 HTTP 202：已接收，Key 验证待完成；实际收录未确认。没有访问 Google / 百度搜索控制台。实施范围、关键词映射、验证与后续发布命令见 [SEO-GEO.md](SEO-GEO.md)。

部署预检先遇到服务器 Python 3.6 不支持 XML 命名空间通配写法的问题；调整预检兼容性后完成发布。首次失败的暂存目录 `20261115-geo-seo` 未切换为线上入口。正式发布包未携带 macOS 扩展属性。

第三方读取验证：Jina Reader 成功读取正式站 `/developers/` 的文章正文、表格、发布日期与 Skill 示例。该检查说明公开内容可提取，不代表任何 AI 搜索产品已引用本站。

全量应用测试已完成：`npm test` 共 184 个套件，182 个通过，2 个失败；端到端套件（含前端与管理后台）通过。失败项：

- `layers`：已有的 `website/assets/site.js` 被应用七层源码检查识别为未分层文件；本次未修改该 JavaScript 文件，也未改变应用分层规则。
- `conn-pool`：8 个并发任务挂载断言失败，记录为 `got6=6, up=false, held=1`；本次未修改连接池或应用运行时源码。

官网独立构建、16 页验证与线上一致性验证全部通过。全量日志保存在本机 `/tmp/owb-npm-test.log`；未把测试日志或临时数据上传到官网。


## 企业评估与任务试跑入口（2026-11-16）

正式版本：`/var/www/openworkbuddy/releases/20261116-enterprise-evaluation`；前一版本保留 `20261115-regional-services`。首页下载按钮旁加入“申请企业评估”，保留下载、GitHub 与样例 PPT；新增 `/enterprise-evaluation/` 和 `/guides/project-trial/`，页脚与企业咨询区也可进入。

评估页区分团队内部使用、给客户交付 / 产品集成，首轮仅问任务、使用对象、规模与时间。浏览器生成带场景的需求摘要和邮件链接，用户自行发邮件或复制到微信；没有自动发送、后端留资或附件上传。视频入口可用 `?from=video`，会在访客发送的正文中标注来源。首轮沟通文本见 `企业评估首轮沟通.md`。

已验证两种用途、必填与空白校验、邮件正文与表单一致、文本安全、复制及编辑后旧摘要失效。Chrome 实际填写表单成功，截图检查通过。21 个可索引页面、1043 处内链和资源引用验证通过，全部线上 HTML 与构建一致。

全量应用回归额外运行约 14 分钟后停止：已完成 144 个套件，143 个通过、1 个失败（既有 `layers` 将官网脚本识别为应用未分层文件）。其余套件及正在运行的画布套件未完成，不宣称全量通过；官网专项构建、21 页线上一致性和表单检查均已完成。日志 `/tmp/owb-evaluation-npm-test.log`。
