"use strict";
/**
 * 连接器预设目录：常用 MCP 服务器一键接入。
 * 每条只写「怎么启动、要哪些 Key、去哪拿」，不写值——Key 由用户在界面上填，存进 config.json 的 env/headers。
 * env 里的键值为 "" 表示必填；带默认值的（比如 API 地址）可以不改。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { isIntranet } = require("./intranet");

const CATEGORIES = ["文件与开发", "搜索与网页", "数据库", "协作与文档", "地图与出行", "中国常用", "效率与实验"];

const std = (name, label, icon, desc, category, args, extra = {}) => ({
  name, label, icon, desc, category, kind: "stdio", command: "npx", args: ["-y", ...args], env: {}, ...extra,
});
const uvx = (name, label, icon, desc, category, args, extra = {}) => ({
  name, label, icon, desc, category, kind: "stdio", command: "uvx", args, env: {}, ...extra,
});
const http = (name, label, icon, desc, category, url, extra = {}) => ({
  name, label, icon, desc, category, kind: "http", url, headers: {}, ...extra,
});

const ITEMS = [
  // ---- 文件与开发 ----
  std("filesystem", "本地文件", "folder", "读写指定目录里的文件（默认只开放「文稿」目录，参数里可以再加目录）", "文件与开发",
    ["@modelcontextprotocol/server-filesystem", "{HOME}/Documents"], { reach: "local", docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem" }),
  uvx("git", "Git 仓库", "git-branch", "看提交记录、diff、分支，做提交（要装 uv）", "文件与开发",
    ["mcp-server-git"], { reach: "local", docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/git" }),
  http("github", "GitHub", "github", "查 issue / PR / 仓库代码，官方托管版，填个人令牌即可", "文件与开发",
    "https://api.githubcopilot.com/mcp/", { reach: "intl", headers: { Authorization: "Bearer " }, docs: "https://github.com/settings/tokens" }),
  std("gitlab", "GitLab", "git-merge", "GitLab 的项目、issue、合并请求", "文件与开发",
    ["@modelcontextprotocol/server-gitlab"], { reach: "intl", selfHost: "把 GITLAB_API_URL 改成内网 GitLab 的地址就能用", env: { GITLAB_PERSONAL_ACCESS_TOKEN: "", GITLAB_API_URL: "https://gitlab.com/api/v4" }, docs: "https://gitlab.com/-/user_settings/personal_access_tokens" }),
  std("playwright", "浏览器自动化", "drama", "开一个真浏览器：打开网页、点按钮、填表单、截图", "文件与开发",
    ["@playwright/mcp@latest"], { reach: "local", docs: "https://github.com/microsoft/playwright-mcp" }),
  std("chrome-devtools", "Chrome 调试", "wrench", "接管 Chrome 做性能分析、看控制台和网络请求", "文件与开发",
    ["chrome-devtools-mcp@latest"], { reach: "local", docs: "https://github.com/ChromeDevTools/chrome-devtools-mcp" }),
  std("context7", "Context7 文档", "book-open-text", "按库名拉最新官方文档和示例，写代码不靠过时记忆", "文件与开发",
    ["@upstash/context7-mcp"], { reach: "intl", docs: "https://context7.com" }),
  std("e2b", "E2B 沙箱", "package", "云端沙箱里跑代码，不污染本机", "文件与开发",
    ["@e2b/mcp-server"], { reach: "intl", env: { E2B_API_KEY: "" }, docs: "https://e2b.dev/dashboard" }),
  std("supabase", "Supabase", "zap", "查表、跑 SQL、看项目配置（默认只读）", "文件与开发",
    ["@supabase/mcp-server-supabase@latest", "--read-only"], { reach: "intl", selfHost: "官方云要翻墙；自托管 Supabase 可以，但它本身是国外组件，私有化项目慎选", env: { SUPABASE_ACCESS_TOKEN: "" }, docs: "https://supabase.com/dashboard/account/tokens" }),
  std("stripe", "Stripe", "credit-card", "查客户、订单、发票，建支付链接", "文件与开发",
    ["@stripe/mcp", "--tools=all"], { reach: "intl", env: { STRIPE_SECRET_KEY: "" }, docs: "https://dashboard.stripe.com/apikeys" }),
  // 下面几条用 mcp-remote 转一手：它们只认 OAuth，不收静态 Token，而 http 直连这边只会照搬 headers。
  // 第一次连会弹浏览器让你点同意，之后 Token 存在本机，不用填 Key。
  std("linear", "Linear", "list-checks", "看 issue、建任务、改状态和负责人；首次连接弹浏览器授权，不用填 Key", "文件与开发",
    ["mcp-remote", "https://mcp.linear.app/mcp"], { reach: "intl", docs: "https://linear.app/docs/mcp" }),
  std("sentry", "Sentry", "bug", "查线上报错、看堆栈和影响面、翻某个 issue 的来龙去脉；首次连接弹浏览器授权", "文件与开发",
    ["mcp-remote", "https://mcp.sentry.dev/mcp"], { reach: "intl", docs: "https://docs.sentry.io/product/sentry-mcp/" }),
  std("vercel", "Vercel", "rocket", "查项目和部署、翻构建日志、看域名绑定；首次连接弹浏览器授权", "文件与开发",
    ["mcp-remote", "https://mcp.vercel.com"], { reach: "intl", docs: "https://vercel.com/docs/mcp/vercel-mcp" }),
  // ---- 搜索与网页 ----
  uvx("fetch", "抓网页", "globe", "把任意网址抓下来转成 Markdown（要装 uv）", "搜索与网页",
    ["mcp-server-fetch"], { reach: "local", docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch" }),
  uvx("duckduckgo", "DuckDuckGo 搜索", "search", "免 Key 的网页搜索，量大会被限速", "搜索与网页",
    ["duckduckgo-mcp-server"], { reach: "intl", docs: "https://github.com/nickclyde/duckduckgo-mcp-server" }),
  std("brave-search", "Brave 搜索", "shield", "网页 / 新闻 / 图片搜索，每月有免费额度", "搜索与网页",
    ["@brave/brave-search-mcp-server"], { reach: "intl", env: { BRAVE_API_KEY: "" }, docs: "https://brave.com/search/api/" }),
  std("tavily", "Tavily 搜索", "file-search", "给 AI 用的搜索与抓取，结果自带摘要", "搜索与网页",
    ["tavily-mcp@latest"], { reach: "intl", env: { TAVILY_API_KEY: "" }, docs: "https://app.tavily.com/home" }),
  std("exa", "Exa 搜索", "brain", "语义搜索，找相似网页、论文、公司", "搜索与网页",
    ["exa-mcp-server"], { reach: "intl", env: { EXA_API_KEY: "" }, docs: "https://dashboard.exa.ai/api-keys" }),
  std("firecrawl", "Firecrawl 抓站", "flame", "整站爬取、结构化提取，抓动态页面也行", "搜索与网页",
    ["firecrawl-mcp"], { reach: "intl", env: { FIRECRAWL_API_KEY: "" }, docs: "https://www.firecrawl.dev/app/api-keys" }),
  http("deepwiki", "DeepWiki", "book", "问任何开源仓库的架构和用法，免 Key", "搜索与网页",
    "https://mcp.deepwiki.com/mcp", { reach: "intl", docs: "https://docs.devin.ai/work-with-devin/deepwiki-mcp" }),
  http("microsoft-learn", "Microsoft Learn", "graduation-cap", "微软官方文档检索（Azure / .NET / Office），免 Key", "搜索与网页",
    "https://learn.microsoft.com/api/mcp", { reach: "intl", docs: "https://github.com/MicrosoftDocs/mcp" }),
  http("apify", "Apify 抓取平台", "blocks", "几千个现成爬虫：电商、地图、社媒、招聘，按次计费", "搜索与网页",
    "https://mcp.apify.com", { reach: "intl", headers: { Authorization: "Bearer " }, docs: "https://console.apify.com/settings/integrations" }),
  std("youtube", "YouTube 数据", "play", "搜视频、读标题简介和字幕、看频道数据，做选题和竞品内容分析用", "搜索与网页",
    ["youtube-data-mcp-server"], { reach: "intl", env: { YOUTUBE_API_KEY: "" }, docs: "https://console.cloud.google.com/apis/credentials" }),
  http("cloudflare-docs", "Cloudflare 文档", "cloud", "Cloudflare 官方文档检索，免 Key", "搜索与网页",
    "https://docs.mcp.cloudflare.com/mcp", { reach: "intl", docs: "https://github.com/cloudflare/mcp-server-cloudflare" }),
  // ---- 数据库 ----
  // --with 'mcp<2'：这两个上游包都还在用 mcp.server.fastmcp，Python SDK 2.x 把 FastMCP 改名成了
  // MCPServer，装最新 SDK 就 ModuleNotFoundError 起不来。钉住 1.x 是它们修好之前唯一能跑的装法。
  uvx("postgres", "PostgreSQL", "database", "查表结构、跑 SQL、看慢查询（默认受限模式，不会误删）", "数据库",
    ["--with", "mcp<2", "postgres-mcp", "--access-mode=restricted"], { reach: "local", env: { DATABASE_URI: "postgresql://user:password@localhost:5432/dbname" }, docs: "https://github.com/crystaldba/postgres-mcp" }),
  std("mysql", "MySQL", "database", "查表和跑 SQL（默认只读）", "数据库",
    ["@benborla29/mcp-server-mysql"], { reach: "local", env: { MYSQL_HOST: "127.0.0.1", MYSQL_PORT: "3306", MYSQL_USER: "", MYSQL_PASS: "", MYSQL_DB: "" }, docs: "https://github.com/benborla/mcp-server-mysql" }),
  std("mongodb", "MongoDB", "leaf", "查集合、聚合、看索引", "数据库",
    ["mongodb-mcp-server"], { reach: "local", env: { MDB_MCP_CONNECTION_STRING: "mongodb://localhost:27017/dbname" }, docs: "https://github.com/mongodb-js/mongodb-mcp-server" }),
  uvx("redis", "Redis", "server", "读写键值、看队列和集合", "数据库",
    ["--from", "redis-mcp-server@latest", "redis-mcp-server", "--url", "redis://localhost:6379/0"], { reach: "local", docs: "https://github.com/redis/mcp-redis" }),
  uvx("sqlite", "SQLite", "hard-drive", "本地单文件数据库，参数里改成你的 .db 路径", "数据库",
    ["--with", "mcp<2", "mcp-server-sqlite", "--db-path", "{HOME}/Documents/data.db"], { reach: "local", docs: "https://github.com/modelcontextprotocol/servers-archived/tree/main/src/sqlite" }),
  // ---- 协作与文档 ----
  std("notion", "Notion", "notebook-pen", "读写 Notion 页面和数据库", "协作与文档",
    ["@notionhq/notion-mcp-server"], { reach: "intl", env: { NOTION_TOKEN: "" }, docs: "https://www.notion.so/profile/integrations" }),
  std("slack", "Slack", "message-square", "读频道、发消息、搜历史", "协作与文档",
    ["@modelcontextprotocol/server-slack"], { reach: "intl", env: { SLACK_BOT_TOKEN: "", SLACK_TEAM_ID: "" }, docs: "https://api.slack.com/apps" }),
  std("lark", "飞书开放平台", "bird", "官方 MCP：消息、日历、云文档、多维表格（内置飞书桥接之外的补充）", "协作与文档",
    ["@larksuiteoapi/lark-mcp", "mcp"], { reach: "cn", env: { APP_ID: "", APP_SECRET: "" }, docs: "https://open.feishu.cn/app" }),
  std("excel", "Excel 表格", "file-spreadsheet", "读写本地 .xlsx：读单元格、写数据、建工作表", "协作与文档",
    ["@negokaz/excel-mcp-server"], { reach: "local", docs: "https://github.com/negokaz/excel-mcp-server" }),
  std("figma", "Figma", "palette", "读设计稿的图层、间距、颜色和切图，照着做页面不用来回问设计", "协作与文档",
    ["figma-developer-mcp", "--stdio"], { reach: "intl", env: { FIGMA_API_KEY: "" }, docs: "https://www.figma.com/developers/api#access-tokens" }),
  std("atlassian", "Jira / Confluence", "clipboard-list", "查需求和缺陷、建 issue、读写 Confluence 页面；首次连接弹浏览器授权", "协作与文档",
    ["mcp-remote", "https://mcp.atlassian.com/v1/sse"], { reach: "intl", docs: "https://support.atlassian.com/rovo/docs/getting-started-with-the-atlassian-remote-mcp-server/" }),
  std("airtable", "Airtable", "table", "读写多维表格：查记录、建字段、批量更新", "协作与文档",
    ["airtable-mcp-server"], { reach: "intl", env: { AIRTABLE_API_KEY: "" }, docs: "https://airtable.com/create/tokens" }),
  std("asana", "Asana", "circle-check", "查项目和任务、建任务、改负责人和截止日；首次连接弹浏览器授权", "协作与文档",
    ["mcp-remote", "https://mcp.asana.com/sse"], { reach: "intl", docs: "https://developers.asana.com/docs/using-asanas-mcp-server" }),
  std("canva", "Canva", "image", "翻自己的设计稿、按模板出图、导出成品；首次连接弹浏览器授权", "协作与文档",
    ["mcp-remote", "https://mcp.canva.com/mcp"], { reach: "intl", docs: "https://www.canva.dev/docs/apps/mcp-server/" }),
  // ---- 地图与出行 ----
  std("amap", "高德地图", "map", "地理编码、周边搜索、路线规划、天气", "地图与出行",
    ["@amap/amap-maps-mcp-server"], { reach: "cn", env: { AMAP_MAPS_API_KEY: "" }, docs: "https://lbs.amap.com/api/mcp-server/summary" }),
  std("baidu-map", "百度地图", "compass", "地点检索、路线、天气、IP 定位", "地图与出行",
    ["@baidumap/mcp-server-baidu-map"], { reach: "cn", env: { BAIDU_MAP_API_KEY: "" }, docs: "https://lbsyun.baidu.com/faq/api?title=mcpserver/base" }),
  std("google-maps", "Google 地图", "map-pin", "海外地址、路线、周边", "地图与出行",
    ["@modelcontextprotocol/server-google-maps"], { reach: "intl", env: { GOOGLE_MAPS_API_KEY: "" }, docs: "https://console.cloud.google.com/google/maps-apis/credentials" }),
  std("12306", "12306 火车票", "train-front", "查车次余票、中转方案，免 Key", "地图与出行",
    ["12306-mcp"], { reach: "cn", docs: "https://github.com/Joooook/12306-mcp" }),
  // ---- 中国常用 ----
  std("hotnews", "热榜聚合", "trending-up", "微博 / 知乎 / B站 / 抖音等热搜榜单，免 Key", "中国常用",
    ["@wopal/mcp-server-hotnews"], { reach: "cn", docs: "https://github.com/wopal-cn/mcp-server-hotnews" }),
  std("bing-cn", "必应中文搜索", "search", "免 Key 的中文网页搜索", "中国常用",
    ["bing-cn-mcp"], { reach: "cn", docs: "https://github.com/yan5236/bing-cn-mcp-server" }),
  std("howtocook", "程序员做饭指南", "chef-hat", "按食材/人数推荐菜谱，给出做法步骤", "中国常用",
    ["howtocook-mcp"], { reach: "cn", docs: "https://github.com/worryzyy/HowToCook-mcp" }),
  std("antv-chart", "AntV 统计图表", "chart-column", "数据变成折线、柱状、饼图等二十多种图。注意数据要发到官方渲染服务，涉密的别走这条", "中国常用",
    ["@antv/mcp-server-chart"], { reach: "cn", docs: "https://github.com/antvis/mcp-server-chart" }),
  std("edgeone-pages", "EdgeOne 一键部署", "cloud", "把做好的网页发上公网拿个链接，做完直接发给别人看", "中国常用",
    ["edgeone-pages-mcp"], { reach: "cn", docs: "https://github.com/TencentEdgeOne/edgeone-pages-mcp" }),
  std("bilibili", "B 站", "video", "搜视频、看播放和弹幕数据，做内容选题时用，免 Key", "中国常用",
    ["bilibili-mcp-js"], { reach: "cn", docs: "https://github.com/34892002/bilibili-mcp-js" }),
  // ---- 效率与实验 ----
  std("memory", "知识图谱记忆", "puzzle", "跨任务的实体/关系记忆（和内置记忆并存，偏结构化）", "效率与实验",
    ["@modelcontextprotocol/server-memory"], { reach: "local", docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory" }),
  std("sequential-thinking", "分步思考", "list-ordered", "把复杂问题拆成可回溯的思考步骤", "效率与实验",
    ["@modelcontextprotocol/server-sequential-thinking"], { reach: "local", docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/sequential-thinking" }),
  uvx("time", "时间与时区", "clock", "当前时间、时区换算（要装 uv）", "效率与实验",
    ["mcp-server-time"], { reach: "local", docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/time" }),
  std("everything", "MCP 演示服务器", "flask-conical", "官方的全功能样例，用来验证连接器链路通不通", "效率与实验",
    ["@modelcontextprotocol/server-everything"], { reach: "local", docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/everything" }),
];

// GUI 方式启动的 App，PATH 往往只有 /usr/bin:/bin，homebrew 装的 npx/uvx 找不到——
// 这几个常见目录也扫一遍，找到了就把绝对路径写进 command，别让用户对着「命令启动失败」发呆。
const EXTRA_DIRS = [
  "/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".local", "bin"), path.join(os.homedir(), ".cargo", "bin"),
  path.join(os.homedir(), ".nvm", "current", "bin"), path.join(os.homedir(), ".volta", "bin"),
];
function findCmd(name, env = process.env) {
  const exts = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  const dirs = String(env.PATH || env.Path || "").split(path.delimiter).filter(Boolean).concat(EXTRA_DIRS);
  for (const d of dirs) for (const x of exts) {
    const p = path.join(d, name + x);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* 没有就下一个 */ }
  }
  return "";
}
function onPath(name, env = process.env) {
  const exts = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  for (const d of String(env.PATH || env.Path || "").split(path.delimiter).filter(Boolean)) for (const x of exts) {
    try { if (fs.statSync(path.join(d, name + x)).isFile()) return true; } catch { /* 继续 */ }
  }
  return false;
}

/** 把预设变成可以直接 POST 给 /api/mcp 的形状：{HOME} 换成真实家目录，命令不在 PATH 上就换成绝对路径 */
function resolve(item, { home = os.homedir(), env = process.env } = {}) {
  const sub = (s) => String(s).split("{HOME}").join(home);
  if (item.kind === "http") return { name: item.name, url: sub(item.url), headers: { ...(item.headers || {}) } };
  const command = onPath(item.command, env) ? item.command : (findCmd(item.command, env) || item.command);
  return { name: item.name, command, args: (item.args || []).map(sub), env: { ...(item.env || {}) } };
}

/**
 * 给前端的目录：预设 + 本机有没有 npx / uvx（"" = 没找到）。
 *
 * 内网模式下不删条目，只把"要连境外"的标出来、排到最后：
 * 删掉的话，有代理的用户就再也找不到它了；不标的话，用户填完 Key 要等到超时才知道白费。
 * 排序在每个分类里是稳定的，同一档的先后跟原来一样。
 */
function catalog(opts) {
  const env = (opts && opts.env) || process.env;
  const intranet = opts && opts.intranet !== undefined ? !!opts.intranet : isIntranet({ env, cfg: opts && opts.cfg });
  const items = ITEMS.map((it) => {
    const row = { ...it, ...resolve(it, opts), kind: it.kind, reach: it.reach, needs: it.kind === "http" ? "" : it.command };
    if (intranet && it.reach === "intl") {
      row.blocked = true;
      row.blockedWhy = it.selfHost
        ? "服务在境外，内网连不上——" + it.selfHost
        : "服务在境外，内网连不上；填了 Key 也只会等到超时，不会报错";
    }
    return row;
  });
  if (intranet) items.sort((a, b) => (a.blocked ? 1 : 0) - (b.blocked ? 1 : 0));
  const tools = { npx: findCmd("npx", env), uvx: findCmd("uvx", env) };
  const notes = [];
  if (intranet) {
    // 这条比单个连接器重要得多：npx -y / uvx 每次启动都要去 registry 拉包。
    // 内网里没配镜像的话，上面那些标了"本机"的也一个都装不上——错怪到连接器头上就白查半天
    if (tools.npx) notes.push("内网里 `npx -y` 要能访问 npm registry：没配内部镜像（Nexus / 淘宝源）的话，标着「本机」的连接器也装不上。配法：npm config set registry <内网地址>");
    if (tools.uvx) notes.push("`uvx` 同理，要能访问 PyPI：uv 用 UV_INDEX_URL 指到内网镜像");
  }
  return { categories: CATEGORIES, intranet, items, tools, notes };
}

module.exports = { CATEGORIES, ITEMS, resolve, catalog, findCmd, onPath };
