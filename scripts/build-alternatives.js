#!/usr/bin/env node
/**
 * 「XX 替代 / XX alternative」落地页生成器 —— 给 GitHub Pages（docs/）出静态页。
 *
 *   node scripts/build-alternatives.js
 *
 * 产出：docs/alternatives/<slug>/index.html（英文）、docs/zh/alternatives/<slug>/index.html（中文）、
 *       两边各一个汇总页、docs/sitemap.xml、docs/robots.txt。
 *
 * 写法的规矩：
 * - 只说我们自己的事实（仓库里查得到的），不给别家下判断、不编别家的价格和功能；
 *   每页都有一段「这种情况还是用它」，老实讲它更合适的时候。
 * - 数字（技能/工具/连接器个数）读 docs/stats.json，不手写。
 * - 页面里不放任何本机路径、账号、Key。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DOCS = path.join(ROOT, "docs");
const SITE = "https://catcatuncle.github.io/openworkbuddy/";
const REPO = "https://github.com/CatCatUncle/openworkbuddy";
const stats = JSON.parse(fs.readFileSync(path.join(DOCS, "stats.json"), "utf8"));

// ── 共有的事实（两种语言）─────────────────────────────────────────────
const FACTS = {
  en: [
    ["Real files on your disk", "PPTX, DOCX, XLSX and HTML are written to your own folder. If the agent claims a file it didn't write, the run is stopped and redone."],
    ["Bring your own model", "DeepSeek, Qwen (DashScope), Doubao (Volcengine Ark), GLM, Kimi, OpenAI, Claude, OpenRouter or a local Ollama model — switch in the settings, per task."],
    ["Runs on your machine", "Sessions, files and keys stay local. The server listens on 127.0.0.1 by default; put it on your own server when a team needs it."],
    ["Uses Claude Code or Codex as an engine", "Already have the Claude Code or Codex CLI installed? Pick it as the engine and keep your existing plan."],
    ["Skills are Markdown files", `${stats.skills} built-in skills, ${stats.tools} tools, ${stats.connectors} connectors, MCP. Adding a skill means dropping a skill.md into a folder — no rebuild.`],
    ["Desktop, web and command line", "An Electron app, a browser UI and an `openworkbuddy` CLI share the same sessions. Scheduled tasks and chat bots (Feishu, QQ, WeChat; DingTalk, Telegram and Slack through a webhook) can drive it too."],
  ],
  zh: [
    ["文件是真落盘的", "PPT、Word、Excel、网页直接写进你自己的文件夹。说写了文件却不在盘上，当场拦下重做。"],
    ["模型自己选", "DeepSeek、通义千问（百炼）、豆包（火山方舟）、智谱、Kimi、OpenAI、Claude、OpenRouter、本机 Ollama，设置里点一下就换，每个任务都能单独选。"],
    ["跑在你自己电脑上", "会话、文件、Key 全在本机，默认只听 127.0.0.1；团队要用就放你自己的服务器。"],
    ["能拿 Claude Code / Codex 当发动机", "本机装了 Claude Code 或 Codex 命令行的，一键接管，用你已有的订阅，不用另买 token。"],
    ["技能就是 Markdown 文件", `自带 ${stats.skills} 个技能、${stats.tools} 个工具、${stats.connectors} 个连接器，支持 MCP。加能力 = 丢一个 skill.md，不改代码不重启。`],
    ["桌面、网页、命令行都能用", "Electron 桌面端、浏览器界面、`openworkbuddy` 命令行共用同一批会话；定时任务和飞书、QQ、微信机器人（钉钉、Telegram、Slack 走通用 Webhook）也能指挥它。"],
  ],
};

// ── 每一页 ─────────────────────────────────────────────────────────
// who: 对方是什么（只写公开的、中性的定位）；why: 为什么有人会找替代；stay: 什么时候还是用它；fit: 我们这边对应的做法
const PAGES = [
  {
    slug: "claude-cowork",
    en: {
      name: "Claude Cowork",
      title: "Open-source Claude Cowork alternative — self-hosted, any model",
      desc: "OpenWorkBuddy is an open-source, local-first alternative to Claude Cowork: a desktop AI agent that turns a request into real PPTX, DOCX, XLSX and HTML files, with DeepSeek, Qwen, Claude or a local model.",
      who: "Claude Cowork is Anthropic's agent for knowledge work inside the Claude desktop app.",
      why: "People look for an alternative when they want to choose the model themselves, keep everything on their own machine or server, read the source, or pay per token instead of per seat.",
      fit: "OpenWorkBuddy covers the same loop — plan, act on files, check the result — and can even run Claude Code as its engine if you already use Claude.",
      stay: "You want Anthropic's hosted product, their integrations and support, and you're happy with Claude as the only model.",
    },
    zh: {
      name: "Claude Cowork",
      title: "Claude Cowork 开源替代：本机运行、模型随便换",
      desc: "OpenWorkBuddy 是 Claude Cowork 的开源替代：本机优先的 AI 办公助理，一句话交出能打开的 PPT、Word、Excel、网页，DeepSeek、通义、Claude、本地模型都能用。",
      who: "Claude Cowork 是 Anthropic 在 Claude 桌面端里做的办公 agent。",
      why: "想自己挑模型、东西都留在自己电脑或服务器上、能看源码、按 token 付费而不是按席位付费的人，会来找替代。",
      fit: "OpenWorkBuddy 走的是同一套流程：规划、动手改文件、自己验收；本来就用 Claude 的，还能直接拿 Claude Code 当发动机。",
      stay: "你要的是 Anthropic 官方托管的产品、官方的集成和支持，而且只用 Claude 一个模型就够了。",
    },
  },
  {
    slug: "codex",
    en: {
      name: "Codex",
      title: "Codex alternative for office work — open-source AI agent that makes files",
      desc: "Like Codex, but for documents: OpenWorkBuddy is an open-source agent that plans and verifies real PPTX, DOCX, XLSX and HTML files on your machine — and can drive the Codex CLI as its engine.",
      who: "Codex is OpenAI's coding agent, available as a CLI, an IDE extension and a cloud service.",
      why: "Codex is built for code. People who want the same agent loop for reports, slides, spreadsheets and research — with any model — look for something shaped like Codex but for office work.",
      fit: "OpenWorkBuddy brings the agent loop (plan, tools, approvals, resume, AGENTS.md) to office files, and can hand the heavy lifting to your installed Codex CLI.",
      stay: "Your work is mainly writing and reviewing code in a repository — Codex is made for that.",
    },
    zh: {
      name: "Codex",
      title: "Codex 办公版替代：开源 AI agent，交付的是文件",
      desc: "像 Codex，但干的是办公的活：OpenWorkBuddy 是开源 AI 助理，在你电脑上规划、生成并验收 PPT、Word、Excel、网页，还能直接拿本机的 Codex 命令行当发动机。",
      who: "Codex 是 OpenAI 的写代码 agent，有命令行、IDE 插件和云端三种用法。",
      why: "Codex 是为写代码做的。想把同一套 agent 流程用在报告、PPT、表格、调研上，而且模型自己挑的人，会找一个「办公版 Codex」。",
      fit: "OpenWorkBuddy 把规划、工具、审批、续接、AGENTS.md 这套搬到了办公文件上，重活还能交给你本机装好的 Codex 命令行。",
      stay: "你主要是在仓库里写代码、审代码——那正是 Codex 的本行。",
    },
  },
  {
    slug: "workbuddy",
    en: {
      name: "WorkBuddy",
      title: "Open-source WorkBuddy alternative — local AI office agent",
      desc: "OpenWorkBuddy is an independent open-source take on the WorkBuddy idea: a local-first AI office agent that delivers real files, with your own model keys and your own data.",
      who: "WorkBuddy is Tencent's AI office agent for the desktop.",
      why: "People look for an open alternative when they want to self-host, read and change the code, use their own model keys, or run it on a server for a team.",
      fit: "OpenWorkBuddy is an independent implementation of the same idea — not affiliated with Tencent — with the code, the prompts and the traces all in one repository.",
      stay: "You want a product that is hosted, maintained and supported by Tencent.",
    },
    zh: {
      name: "WorkBuddy",
      title: "WorkBuddy 开源替代：本机运行的 AI 办公助理",
      desc: "OpenWorkBuddy 是 WorkBuddy 思路的独立开源实现：本机优先的 AI 办公助理，交付真文件，用你自己的模型 Key，数据留在你自己手里。",
      who: "WorkBuddy 是腾讯出的桌面端 AI 办公助理。",
      why: "想自己部署、看得见也改得了代码、用自己的模型 Key、或者放服务器给团队用的人，会找开源的替代。",
      fit: "OpenWorkBuddy 是同一思路的独立实现（跟腾讯没有关系），代码、提示词、执行轨迹全在一个仓库里。",
      stay: "你要的是腾讯官方托管、维护和提供支持的产品。",
    },
  },
  {
    slug: "doubao",
    en: {
      name: "Doubao",
      title: "Doubao office alternative — open-source, runs Doubao models locally",
      desc: "OpenWorkBuddy is an open-source alternative to Doubao's AI office features: a local agent that writes real PPT, Word and Excel files — and can use Doubao models through Volcengine Ark.",
      who: "Doubao is ByteDance's AI assistant, with writing, slides and document features in its apps.",
      why: "People look for an alternative when they want files written straight into their own folders, one tool that works with several models, or something they can run on their own server.",
      fit: "OpenWorkBuddy can still use Doubao models: add your Volcengine Ark key and pick Doubao, or switch to DeepSeek or Qwen for a given task.",
      stay: "You mainly chat and write inside the Doubao app and don't need an agent working on local files.",
    },
    zh: {
      name: "豆包",
      title: "豆包办公开源替代：本机 AI 办公助理，也能用豆包模型",
      desc: "OpenWorkBuddy 是豆包 AI 办公的开源替代：本机运行的办公 agent，直接生成 PPT、Word、Excel 文件，通过火山方舟照样能用豆包模型。",
      who: "豆包是字节跳动的 AI 助手，App 里有写作、PPT、文档这些办公功能。",
      why: "想让文件直接落进自己的文件夹、一个工具里换着用几家模型、或者放到自己服务器上跑的人，会找替代。",
      fit: "在 OpenWorkBuddy 里照样能用豆包：填上火山方舟的 Key 选豆包模型就行；某个任务想换 DeepSeek、通义也是点一下。",
      stay: "你主要是在豆包 App 里聊天、写东西，用不着一个在本机动文件的 agent。",
    },
  },
  {
    slug: "qwen",
    en: {
      name: "Qwen",
      title: "Qwen office alternative — open-source agent that runs Qwen models",
      desc: "OpenWorkBuddy is an open-source alternative to the Qwen app's office features: a local-first agent that writes real files and can run Qwen models through DashScope or Ollama.",
      who: "Qwen (Tongyi Qianwen) is Alibaba's model family and AI assistant app, which includes office features such as slides and documents.",
      why: "People look for an alternative when they want an agent that works on their own files, mixes Qwen with other models, or runs fully offline.",
      fit: "OpenWorkBuddy runs Qwen through Alibaba Cloud DashScope (Bailian), or a local Qwen model through Ollama, next to DeepSeek, Doubao and the rest.",
      stay: "You want Alibaba's hosted app experience and don't need local files or other models.",
    },
    zh: {
      name: "千问",
      title: "千问办公开源替代：本机 AI 办公助理，通义模型照样用",
      desc: "OpenWorkBuddy 是千问 AI 办公的开源替代：本机优先的办公 agent，直接生成文件，通义千问可以走百炼接口，也可以用 Ollama 在本机跑。",
      who: "千问是阿里的通义大模型和 AI 助手 App，里面有 PPT、文档这些办公功能。",
      why: "想要一个直接动自己文件的 agent、把通义和别家模型混着用、或者完全断网跑的人，会找替代。",
      fit: "OpenWorkBuddy 里通义千问走阿里云百炼接口，或者用 Ollama 在本机跑 Qwen，跟 DeepSeek、豆包这些并排可选。",
      stay: "你要的是阿里官方的 App 体验，用不着本机文件，也不需要别家模型。",
    },
  },
  {
    slug: "deepseek-agent",
    en: {
      name: "DeepSeek",
      title: "DeepSeek agent harness — open-source AI agent that runs on DeepSeek",
      desc: "Looking for a harness to run DeepSeek as an agent? OpenWorkBuddy is an open-source, local-first agent with tools, skills, approvals and file checks — paste a DeepSeek API key and it works.",
      who: "DeepSeek makes the DeepSeek models and offers them through an OpenAI-compatible API.",
      why: "A model alone doesn't open files, run commands or check its own work. People look for a harness — the agent loop, tools and safety around the model — that works well with DeepSeek.",
      fit: "OpenWorkBuddy is that harness: DeepSeek is a one-click preset, prompts are laid out so DeepSeek's context cache hits, and every tool call goes through the same approvals and file checks.",
      stay: "You only need chat, or you're building your own agent from scratch on the raw API.",
    },
    zh: {
      name: "DeepSeek",
      title: "DeepSeek agent 外壳（harness）：开源 AI 助理，用 DeepSeek 就能干活",
      desc: "想让 DeepSeek 当 agent 干活？OpenWorkBuddy 是开源、本机优先的 agent 外壳：工具、技能、审批、文件验收都有，填上 DeepSeek 的 Key 就能用。",
      who: "DeepSeek 做的是 DeepSeek 系列模型，通过 OpenAI 兼容接口对外提供。",
      why: "光有模型不会自己开文件、跑命令、检查自己干得对不对。大家要找的是一套 harness：模型外面那层 agent 循环、工具和安全。",
      fit: "OpenWorkBuddy 就是这层：DeepSeek 是一键预设，提示词的排法让 DeepSeek 的上下文缓存能命中，每一次工具调用都走同一套审批和文件验收。",
      stay: "你只需要聊天，或者打算直接对着接口从头搭自己的 agent。",
    },
  },
];

// ── 模板 ─────────────────────────────────────────────────────────
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const code = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");
const urlOf = (lang, slug) => SITE + (lang === "zh" ? "zh/" : "") + "alternatives/" + (slug ? slug + "/" : "");

const UI = {
  en: {
    kicker: "Open-source alternative", facts: "What you get with OpenWorkBuddy", who: "The short version", stay: "When to stay with",
    start: "Try it in three minutes", startText: "Download the installer, or clone the repo and run `npm install && npm start`. Add one model key in the setup wizard and ask for your first file.",
    download: "Download", star: "View on GitHub", others: "Other comparisons", hub: "OpenWorkBuddy alternatives",
    hubTitle: "OpenWorkBuddy vs Claude Cowork, Codex, WorkBuddy, Doubao, Qwen and DeepSeek",
    hubDesc: "How OpenWorkBuddy, an open-source local-first AI office agent, compares with Claude Cowork, Codex, WorkBuddy, Doubao, Qwen and DeepSeek — and when each one is the better fit.",
    hubLead: "Honest comparisons: what OpenWorkBuddy does, and when the other product is the better choice.",
    note: "OpenWorkBuddy is an independent open-source project. It is not affiliated with or endorsed by Anthropic, OpenAI, Tencent, ByteDance, Alibaba or DeepSeek; product names belong to their owners.",
    other: "中文", home: "Home",
  },
  zh: {
    kicker: "开源替代", facts: "用 OpenWorkBuddy 能拿到什么", who: "一句话说清", stay: "这种情况还是用",
    start: "三分钟跑起来", startText: "下载安装包，或者克隆仓库跑 `npm install && npm start`。在首页向导里填一个模型 Key，就能要第一份文件了。",
    download: "下载安装包", star: "去 GitHub", others: "其他对比", hub: "OpenWorkBuddy 替代对比",
    hubTitle: "OpenWorkBuddy 对比 Claude Cowork、Codex、WorkBuddy、豆包、千问、DeepSeek",
    hubDesc: "开源、本机优先的 AI 办公助理 OpenWorkBuddy，跟 Claude Cowork、Codex、WorkBuddy、豆包、千问、DeepSeek 比有什么不同，各自什么时候更合适。",
    hubLead: "老实的对比：OpenWorkBuddy 做什么，以及什么时候别家更合适。",
    note: "OpenWorkBuddy 是独立的开源项目，跟 Anthropic、OpenAI、腾讯、字节跳动、阿里、DeepSeek 都没有关联，也没有得到它们的认可；各产品名称归各自所有者。",
    other: "English", home: "首页",
  },
};

const STYLE = `:root{color-scheme:dark;--bg:#0b0e13;--panel:#11161e;--text:#f4f0e7;--muted:#9ba5b5;--line:rgba(216,226,239,.14);--lime:#d8f36a;--cyan:#8de4dc;--orange:#ffad68;--body:"Avenir Next","PingFang SC","Microsoft YaHei",ui-sans-serif,system-ui,sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.7 var(--body)}a{color:var(--lime)}.shell{width:min(920px,calc(100% - 32px));margin:auto}
header{display:flex;justify-content:space-between;align-items:center;height:64px;border-bottom:1px solid var(--line);font-size:14px}header a{color:var(--muted);text-decoration:none;margin-left:20px}header .brand{color:var(--text);font-weight:800;margin:0}
.kicker{color:var(--orange);font-size:12px;letter-spacing:.14em;font-weight:800;text-transform:uppercase;margin-top:56px}h1{font-size:clamp(1.9rem,4.4vw,2.8rem);line-height:1.15;margin:12px 0 16px}.lead{color:var(--muted);font-size:18px}
h2{font-size:1.35rem;margin:48px 0 16px}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}.card{padding:20px;border:1px solid var(--line);background:var(--panel)}.card h3{margin:0 0 6px;font-size:16px}.card p{margin:0;color:var(--muted);font-size:15px}
.who p{margin:0 0 12px}.stay{border-left:3px solid var(--cyan);padding:4px 0 4px 16px;color:var(--muted)}.cta{display:flex;gap:12px;flex-wrap:wrap;margin-top:16px}.btn{padding:10px 18px;border:1px solid var(--lime);text-decoration:none;font-weight:700}.btn.primary{background:var(--lime);color:#11140a}
code{background:rgba(255,255,255,.08);padding:1px 6px;border-radius:4px}ul.links{padding-left:18px}footer{margin:64px auto 40px;padding-top:20px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}
@media(max-width:640px){.grid{grid-template-columns:1fr}header a:not(.brand){margin-left:12px}header nav a:first-child{display:none}}`;

function head(lang, { title, desc, url, alt, ld }) {
  return `<!doctype html>
<html lang="${lang === "zh" ? "zh-CN" : "en"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta name="robots" content="index,follow">
<link rel="canonical" href="${url}">
<link rel="alternate" hreflang="${lang === "zh" ? "zh-CN" : "en"}" href="${url}">
<link rel="alternate" hreflang="${lang === "zh" ? "en" : "zh-CN"}" href="${alt}">
<link rel="alternate" hreflang="x-default" href="${lang === "zh" ? alt : url}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="OpenWorkBuddy">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${SITE}images/short-drama-canvas-overview.png">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<style>${STYLE}</style>
</head>
<body>
<header class="shell"><a class="brand" href="${SITE}">OpenWorkBuddy</a><nav><a href="${urlOf(lang)}">${UI[lang].hub}</a><a href="${alt}">${UI[lang].other}</a><a href="${REPO}">GitHub</a></nav></header>
<main class="shell">`;
}

const foot = (lang) => `</main>
<footer class="shell">${esc(UI[lang].note)}</footer>
</body>
</html>
`;

function page(lang, p) {
  const t = p[lang], ui = UI[lang], url = urlOf(lang, p.slug), alt = urlOf(lang === "zh" ? "en" : "zh", p.slug);
  const ld = {
    "@context": "https://schema.org", "@type": "SoftwareApplication", name: "OpenWorkBuddy", alternateName: "openworkbuddy",
    applicationCategory: "BusinessApplication", operatingSystem: "macOS, Windows, Linux", description: t.desc, url,
    downloadUrl: REPO + "/releases", codeRepository: REPO, softwareVersion: stats.version,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  };
  const others = PAGES.filter((o) => o.slug !== p.slug).map((o) => `<li><a href="${urlOf(lang, o.slug)}">${esc(o[lang].title)}</a></li>`).join("");
  return head(lang, { title: t.title, desc: t.desc, url, alt, ld }) + `
<div class="kicker">${ui.kicker} · ${esc(t.name)}</div>
<h1>${esc(t.title)}</h1>
<p class="lead">${esc(t.desc)}</p>
<div class="cta"><a class="btn primary" href="${REPO}/releases">${ui.download}</a><a class="btn" href="${REPO}">${ui.star}</a></div>
<h2>${ui.who}</h2>
<div class="who"><p>${esc(t.who)}</p><p>${esc(t.why)}</p><p>${esc(t.fit)}</p></div>
<h2>${ui.facts}</h2>
<div class="grid">${FACTS[lang].map(([h, b]) => `<div class="card"><h3>${esc(h)}</h3><p>${code(b)}</p></div>`).join("")}</div>
<h2>${ui.stay}${lang === "zh" ? "" : " "}${esc(t.name)}</h2>
<p class="stay">${esc(t.stay)}</p>
<h2>${ui.start}</h2>
<p>${code(ui.startText)}</p>
<div class="cta"><a class="btn primary" href="${REPO}/releases">${ui.download}</a><a class="btn" href="${REPO}">${ui.star}</a></div>
<h2>${ui.others}</h2>
<ul class="links">${others}</ul>
` + foot(lang);
}

function hub(lang) {
  const ui = UI[lang], url = urlOf(lang), alt = urlOf(lang === "zh" ? "en" : "zh");
  const ld = {
    "@context": "https://schema.org", "@type": "ItemList", name: ui.hubTitle,
    itemListElement: PAGES.map((p, i) => ({ "@type": "ListItem", position: i + 1, url: urlOf(lang, p.slug), name: p[lang].title })),
  };
  const cards = PAGES.map((p) => `<div class="card"><h3><a href="${urlOf(lang, p.slug)}">${esc(p[lang].title)}</a></h3><p>${esc(p[lang].who)}</p></div>`).join("");
  return head(lang, { title: ui.hubTitle, desc: ui.hubDesc, url, alt, ld }) + `
<div class="kicker">${ui.kicker}</div>
<h1>${esc(ui.hubTitle)}</h1>
<p class="lead">${esc(ui.hubLead)}</p>
<div class="grid">${cards}</div>
<h2>${ui.start}</h2>
<p>${code(ui.startText)}</p>
<div class="cta"><a class="btn primary" href="${REPO}/releases">${ui.download}</a><a class="btn" href="${REPO}">${ui.star}</a></div>
` + foot(lang);
}

function write(rel, body) {
  const f = path.join(DOCS, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
  return rel;
}

const out = [];
for (const lang of ["en", "zh"]) {
  const base = lang === "zh" ? "zh/alternatives/" : "alternatives/";
  out.push(write(base + "index.html", hub(lang)));
  for (const p of PAGES) out.push(write(base + p.slug + "/index.html", page(lang, p)));
}

const urls = [SITE, ...["en", "zh"].flatMap((l) => [urlOf(l), ...PAGES.map((p) => urlOf(l, p.slug))])];
out.push(write("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u}</loc><lastmod>${stats.updated}</lastmod></url>`).join("\n")}
</urlset>
`));
out.push(write("robots.txt", `User-agent: *\nAllow: /\n\nSitemap: ${SITE}sitemap.xml\n`));

module.exports = { PAGES, urls };
if (require.main === module) console.log(`写了 ${out.length} 个文件，sitemap ${urls.length} 条`);
