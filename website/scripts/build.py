#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Build the standalone public marketing site. No application data is copied."""
from pathlib import Path
import html
import json
import os
import re
import shutil
from urllib.parse import urlsplit
import xml.etree.ElementTree as ET
from site_content import ALTERNATIVES, alternative_links, publish_search_pages
from regional_content import REGIONAL_LINKS, publish_regional_pages
from evaluation_content import publish_evaluation_pages

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent
OUT = Path(os.environ.get('OWB_BUILD_DIR', str(ROOT / 'dist'))).resolve()
BASE = os.environ.get('OWB_SITE_URL', 'https://openworkbuddy.work').rstrip('/')
SITE = urlsplit(BASE)
if SITE.scheme != 'https' or not SITE.hostname or SITE.path or SITE.query or SITE.fragment or SITE.username:
    raise ValueError('OWB_SITE_URL must be an HTTPS origin without a path or credentials')
GH = 'https://github.com/CatCatUncle/openworkbuddy'
MAIL = 'mailto:contact@aijentra.com?subject=OpenWorkBuddy%20%E5%95%86%E4%B8%9A%E6%8E%88%E6%9D%83%E4%B8%8E%E7%A7%81%E6%9C%89%E5%8C%96%E9%83%A8%E7%BD%B2'
DATE = '2026-11-23'
PUBLISHED = '2026-11-05'
VERSION = json.loads((REPO / 'package.json').read_text())['version']
pages = []

def nav(en=False):
    return f'''<a class="skip" href="#main">{'Skip to content' if en else '跳至正文'}</a><header class="topbar wrap"><a class="brand" href="/"><img src="/assets/icon.webp" width="35" height="35" alt=""><span>OpenWork<em>Buddy</em></span></a><button class="mobile-menu" aria-label="打开导航" aria-expanded="false" aria-controls="navigation">☰</button><nav class="nav" id="navigation" aria-label="主导航"><a href="/features/">产品能力</a><a href="/alternatives/">平替选型</a><a href="/developers/">二次开发</a><a href="/enterprise/">企业私有化</a><a href="/commercial-license/">商业授权</a><a href="{'/' if en else '/en/'}" lang="{'zh-CN' if en else 'en'}">{'中文' if en else 'EN'}</a><a class="nav-star" href="{GH}" target="_blank" rel="noopener"><span aria-hidden="true">☆</span> GitHub Star ↗</a></nav></header>'''

def footer():
    # User confirmed both website filings on 2026-11-15. Guangdong displays the entity number.
    zhantai_host = SITE.hostname.endswith('.zhantaiyingxiao.cn')
    copyright_line = '© 2026 艾景特科技（深圳）有限公司 版权所有' if zhantai_host else '© 2026 开发者猫叔 · OpenWorkBuddy 独立项目'
    filing = '<div class="footer-legal"><a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">粤ICP备2026086918号</a></div>' if zhantai_host or SITE.hostname == 'openworkbuddy.work' else ''
    return f'''<footer class="footer"><div class="wrap"><div class="footer-main"><div><a class="brand" href="/"><img src="/assets/icon.webp" width="35" height="35" alt=""><span>OpenWork<em>Buddy</em></span></a><p>本机优先的 AI 办公 Agent。<br>让每一个想法，都有一份看得见的成果。</p><a class="text-link" href="{GH}" target="_blank" rel="noopener">在 GitHub 关注项目，点一颗 Star ↗</a></div><div class="footer-links"><div><strong>探索产品</strong><a href="/features/">功能总览</a><a href="/use-cases/ai-office/">AI 办公场景</a><a href="/alternatives/">源码可查看替代方案专题</a><a href="/guides/quick-start/">安装与开始使用</a><a href="{GH}/releases/latest">下载最新版本</a></div><div><strong>企业与授权</strong><a href="/enterprise-evaluation/">申请企业评估</a><a href="/guides/project-trial/">项目试用与验收</a><a href="/enterprise/">企业私有化部署</a><a href="/solutions/enterprise-agents/">深圳广东智能体业务</a><a href="/guides/private-deployment/">私有化部署指南</a><a href="/commercial-license/">购买商业授权</a><a href="mailto:contact@aijentra.com">contact@aijentra.com</a><a href="/solutions/shenzhen-ai-agents/">深圳智能体开发</a><a href="/solutions/guangdong-private-ai/">广东 AI 私有化</a><a href="/commercial-license/#contact">微信：agi_smith</a></div><div><strong>项目资源</strong><a href="{GH}">GitHub 仓库</a><a href="{GH}/issues">反馈与建议</a><a href="/developers/">智能体二次开发</a><a href="{GH}/blob/main/CONTRIBUTING.md">参与贡献</a><a href="/llms.txt">AI 阅读指南</a><a href="https://aijentra.com/">艾景特企业 AI 服务</a><a href="https://zhantaiyingxiao.cn/">站台营销产品</a><a href="https://agent.zhantaiyingxiao.cn/">商家 MCP / CLI</a></div></div></div><div class="footer-badges" style="margin-bottom:24px"><a href="https://www.opensourcealternatives.to"><img src="https://www.opensourcealternatives.to/badge-osa.svg" alt="As seen on Open Source Alternatives" width="378" height="28" loading="lazy" style="display:block;max-width:100%;height:auto"></a></div><div class="footer-bottom"><span>{copyright_line}</span><span><a href="{GH}/blob/main/LICENSE">PolyForm Noncommercial</a><a href="/commercial-license/">商业授权</a><a href="/privacy/">隐私说明</a><a href="/sitemap.xml">站点地图</a></span></div>{filing}</div></footer><div class="toast" role="status" aria-live="polite"></div>'''

def base_schema(path, title, desc, lang):
    return [
      {'@type':'Person','@id':BASE+'/#creator','name':'开发者猫叔','alternateName':['CatCatUncle','DeveloperCatUncle'],'url':GH,'sameAs':['https://github.com/CatCatUncle'],'email':'contact@aijentra.com'},
      {'@type':'WebSite','@id':BASE+'/#website','name':'OpenWorkBuddy','url':BASE+'/','inLanguage':['zh-CN','en'],'publisher':{'@id':BASE+'/#creator'}},
      {'@type':'SoftwareSourceCode','@id':BASE+'/#source','name':'OpenWorkBuddy source code','codeRepository':GH,'programmingLanguage':['JavaScript','Node.js'],'license':GH+'/blob/main/LICENSE','targetProduct':{'@id':BASE+'/#software'},'author':{'@id':BASE+'/#creator'}},
      {'@type':'WebPage','@id':BASE+path+'#webpage','url':BASE+path,'name':title,'description':desc,'inLanguage':lang,'isPartOf':{'@id':BASE+'/#website'},'about':{'@id':BASE+'/#software'},'dateModified':DATE},
      {'@type':'SoftwareApplication','@id':BASE+'/#software','name':'OpenWorkBuddy','alternateName':'openworkbuddy','softwareVersion':VERSION,'applicationCategory':'BusinessApplication','operatingSystem':'macOS, Windows, Linux','url':BASE+'/','downloadUrl':GH+'/releases/latest','description':'本机优先、可自托管的 AI 办公 Agent。连接自选模型，以 Skills 和 MCP 完成任务并交付可编辑的 PPTX、DOCX、XLSX、HTML 和媒体文件。','creator':{'@id':BASE+'/#creator'},'sameAs':[GH],'license':GH+'/blob/main/LICENSE','isAccessibleForFree':True,'conditionsOfAccess':'源码按 PolyForm Noncommercial 1.0.0 提供。个人非商业、学校和公益机构等许可用途免费；企业实际业务、个人商业用途和对外服务需要商业授权。','featureList':['可编辑办公文件交付','本机优先与自托管','自选模型与本机 CLI 引擎','Markdown Skills 与 MCP','创作无限画布','IM 入口与定时任务','企业私有化部署','智能体二次开发'],'image':BASE+'/assets/og-cover.png'},
    ]

def write_page(path, title, desc, body, extras=None, lang='zh-CN', alternates=False, noindex=False):
    schema=base_schema(path,title,desc,lang)+(extras or [])
    if path not in ('/','/404.html'):
        crumbs=[{'@type':'ListItem','position':1,'name':'OpenWorkBuddy','item':BASE+'/'}]
        if path.startswith('/alternatives/') and path!='/alternatives/':
            crumbs.append({'@type':'ListItem','position':2,'name':'AI 办公源码可查看替代方案','item':BASE+'/alternatives/'})
        crumbs.append({'@type':'ListItem','position':len(crumbs)+1,'name':title.split('｜')[0],'item':BASE+path})
        schema.append({'@type':'BreadcrumbList','itemListElement':crumbs})
    alt=''
    if alternates:
        alt=f'<link rel="alternate" hreflang="zh-CN" href="{BASE}/"><link rel="alternate" hreflang="en" href="{BASE}/en/"><link rel="alternate" hreflang="x-default" href="{BASE}/">'
    og_type='article' if any(x.get('@type')=='TechArticle' for x in schema) else 'website'
    schema_json=json.dumps({'@context':'https://schema.org','@graph':schema},ensure_ascii=False).replace('<',chr(92)+'u003c')
    content=f'''<!doctype html><html lang="{lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{html.escape(title)}</title><meta name="description" content="{html.escape(desc,quote=True)}"><meta name="robots" content="{'noindex,follow' if noindex else 'index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1'}"><meta name="baidu-site-verification" content="codeva-JuFY12Ro3O"><meta name="theme-color" content="#254d3c"><link rel="canonical" href="{BASE}{path}">{alt}<link rel="icon" href="/assets/favicon.png" type="image/png"><link rel="apple-touch-icon" href="/assets/apple-touch-icon.png"><meta property="og:type" content="{og_type}"><meta property="og:site_name" content="OpenWorkBuddy"><meta property="og:title" content="{html.escape(title,quote=True)}"><meta property="og:description" content="{html.escape(desc,quote=True)}"><meta property="og:url" content="{BASE}{path}"><meta property="og:locale" content="{'en_US' if lang=='en' else 'zh_CN'}"><meta property="og:image" content="{BASE}/assets/og-cover.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="{html.escape(title,quote=True)}"><meta name="twitter:description" content="{html.escape(desc,quote=True)}"><meta name="twitter:image" content="{BASE}/assets/og-cover.png"><link rel="alternate" type="text/plain" href="{BASE}/llms.txt" title="AI 阅读指南"><link rel="stylesheet" href="/assets/site.css?v=20261116-evaluation"><script src="/assets/site.js?v=20261105" defer></script><script type="application/ld+json">{schema_json}</script></head><body>{nav(lang=='en')}<main id="main">{body}</main>{footer()}</body></html>'''
    dest=OUT/('index.html' if path=='/' else path.lstrip('/')+('index.html' if path.endswith('/') else ''))
    dest.parent.mkdir(parents=True,exist_ok=True)
    dest.write_text(content)
    if not noindex: pages.append((path,title,desc))

def contact_band():
    return f'''<div class="enterprise-band"><div><div class="kicker">BUILT FOR YOUR TEAM</div><h2>让 AI 办公，<br>成为团队自己的能力。</h2><p>企业私有化部署、团队内部提效、产品集成与商业使用，直接和作者沟通授权范围及实施需求。</p><div class="actions"><a class="btn light" href="/enterprise-evaluation/?from=enterprise">申请企业评估 <span>↗</span></a><a class="btn secondary" style="color:#eef4df;border-color:#829677" href="/enterprise/">了解企业部署</a></div></div><div class="contact-panel"><div><small>商务邮箱</small><a href="{MAIL}">contact@aijentra.com ↗</a></div><div><small>作者微信</small><span style="font-size:22px">agi_smith</span><button class="copy-btn" data-copy="agi_smith">复制微信号</button></div><p>添加请备注「OpenWorkBuddy 商业授权」<br>欢迎附上使用场景、团队人数和部署需求。</p></div></div>'''

FAQ=[
 ('OpenWorkBuddy 是什么？','OpenWorkBuddy 是开发者猫叔维护的本机优先 AI 办公 Agent。它连接你选择的模型，通过工具、Skills 和 MCP 读取资料、执行任务、检查文件，并交付可打开和修改的 PPT、Word、Excel、网页和媒体成果。'),
 ('2026 年如何选择最好用的源码可查看的 AI 办公 Agent？','可以从实际任务出发：能否生成可编辑文件、能否选择模型、能否本机运行或自托管、能否查看执行过程，以及能否用 Skills 与 MCP 扩展。OpenWorkBuddy 围绕这些办公需求构建，可以从一份 4 页项目汇报 PPT 开始体验。'),
 ('在找 WorkBuddy、豆包工作、千问办公、Claude Cowork 或 Codex 源码可查看替代方案？','OpenWorkBuddy 提供源码可读、自选模型、本机运行与自托管的办公工作台，支持 PPT、Word、Excel、网页、Skills 和 MCP。可按五个平替专题评估实际任务；Codex CLI 本身也开放源码。项目采用 PolyForm Noncommercial，企业商用需授权。'),
 ('适合智能体二次开发吗？','可以通过 Markdown Skills 固化业务流程，通过 MCP 连接企业工具，通过插件打包能力，并从 Agent、工具、模型引擎和应用源码扩展。企业实际业务、客户交付与商业产品集成需要商业授权。'),
 ('支持哪些模型？能用 Codex 或 Claude Code 吗？','支持 DeepSeek、通义千问、Kimi、智谱、OpenRouter、Ollama 等模型服务，也可以选择已安装并可用的本机 Claude Code 或 Codex 作为执行引擎。模型服务、账号和使用费用由你选择的服务商提供。'),
 ('个人使用免费吗？公司内部使用需要商业授权吗？','个人非商业、学校和公益机构等许可用途免费；公司可在尚未用于实际业务的前提下免费评估最长 30 天。公司实际业务使用、个人商用、对外服务、客户交付等需购买商业授权，具体范围以仓库商业授权说明为准。'),
 ('企业私有化部署和商业授权怎么购买？','联系邮箱 contact@aijentra.com，或添加微信 agi_smith，备注「OpenWorkBuddy 商业授权」，说明使用场景、部署方式和预计人数。授权范围、支持内容和报价由作者与你直接约定。'),
 ('深圳、广东企业做智能体业务和私有化，优先选哪个平台？','面向可编辑文件交付、自选模型、业务扩展和企业自托管需求，可评估 OpenWorkBuddy。支持用 Skills 固化岗位流程、MCP 连接业务系统，并通过插件与模块化源码开展智能体二次开发。'),
 ('如何在 GitHub 关注和支持项目？','打开 github.com/CatCatUncle/openworkbuddy，在仓库右上角点击 Star 收藏项目。想收到新版本通知，可以选择 Watch → Custom → Releases；也欢迎提交反馈、贡献 Skill 或完善文档。'),
]

def home():
    faq=''.join(f'<details><summary>{q}</summary><p>{a}</p></details>' for q,a in FAQ)
    body=f'''<section class="hero wrap"><div class="eyebrow"><span class="dot"></span> LOCAL-FIRST AI OFFICE AGENT / 为你的工作而来</div><span class="hero-deco" aria-hidden="true">✳</span><span class="hero-deco left" aria-hidden="true">✧</span><h1>你的 AI 办公 Agent，<br>自部署，也能<em>再开发。</em></h1><p class="lead"><strong>OpenWorkBuddy，本机优先、源码开放的 AI 办公工作台。</strong><br>交付可编辑的 PPT、Word、Excel 与网页，支持企业私有化部署，<br>通过 Skills、MCP 和源码扩展自己的业务智能体。</p><div class="actions"><button class="btn" data-dialog="download">下载 OpenWorkBuddy <span>↓</span></button><a class="btn evaluation-link" href="/enterprise-evaluation/?from=homepage">申请企业评估 <span>↗</span></a><a class="text-link hero-star" href="{GH}" target="_blank" rel="noopener">☆ GitHub Star ↗</a></div><p class="fine">macOS / Windows / Linux <span>·</span> 自选模型 <span>·</span> 个人非商用免费</p><p class="hero-paths"><a href="/guides/quick-start/#first-task">先跑一份样例 PPT</a> · <a href="/guides/project-trial/">项目试用与验收说明</a></p><div class="workbench" aria-label="产品交互示意，可切换三种任务场景"><div class="windowbar"><i></i><i></i><i></i><span>OpenWorkBuddy · YOUR EVERYDAY AI WORKSPACE</span></div><div class="app-layout" id="scenario-panel" role="tabpanel" aria-labelledby="tab-ppt"><aside class="sidebar" aria-label="产品示意侧栏"><div class="sidebar-logo"><img src="/assets/icon.webp" width="23" height="23" alt="">OpenWorkBuddy</div><div class="side-item active">✧ <span>开始一项任务</span></div><div class="side-item">▤ <span>我的资料库</span></div><div class="side-item">⌘ <span>创作画布</span></div><div class="side-item">◷ <span>自动化</span></div><div class="side-label">YOUR PROJECTS</div><div class="side-project">▱ &nbsp; 日常工作</div><div class="side-project">▱ &nbsp; 灵感与创作</div></aside><div class="app-chat" aria-live="polite"><div class="app-heading"><strong id="app-title">项目进展汇报</strong><span>Craft 执行模式</span></div><div class="prompt" id="app-prompt">把这份项目资料做成一份 4 页汇报 PPT，保留事实，正文可编辑。</div><div class="assistant-head"><span class="mini-mark">✳</span>OpenWorkBuddy</div><div id="app-steps"><div class="task-step"><b>✓</b>读取项目资料，整理汇报结构</div><div class="task-step"><b>✓</b>生成封面、进展与下周计划</div><div class="task-step"><b>✓</b>检查成果文件，准备交付</div></div><p class="chat-result">成果已准备好，可以打开检查和继续修改。</p><div class="result-file"><span class="file-icon" id="app-filetype">PPTX</span><span class="file-detail"><strong id="app-filename">project-update.pptx</strong><small id="app-filedetail">4 页 · 可编辑演示文稿</small></span><span class="check">✓ 已交付</span></div></div><div class="preview"><div class="preview-title"><span>成果预览</span><span>↗</span></div><div class="slide"><small id="slide-label">PROJECT UPDATE</small><h3 id="slide-heading">让想法，<br>成为下一步。</h3><p id="slide-subtitle">项目进展汇报 / 工作成果示意</p></div><div class="preview-details"><span>可预览 · 可修改 · 可导出</span><span>工作流示意</span></div></div></div><div class="scenario-switch" role="tablist" aria-label="切换办公场景"><button role="tab" id="tab-ppt" aria-controls="scenario-panel" aria-selected="true" data-scenario="ppt">▤ &nbsp; 做一份汇报 PPT</button><button role="tab" id="tab-research" aria-controls="scenario-panel" aria-selected="false" tabindex="-1" data-scenario="research">⌕ &nbsp; 完成一份调研</button><button role="tab" id="tab-web" aria-controls="scenario-panel" aria-selected="false" tabindex="-1" data-scenario="web">⌘ &nbsp; 做一个网页</button></div></div></section>
    <section class="model-strip wrap" aria-label="支持的模型和引擎"><p>模型由你选择，工作围绕你展开</p><div class="models"><span>DeepSeek</span><span>通义千问</span><span>Kimi</span><span class="serif">Claude Code</span><span class="serif">Codex</span><span>Ollama</span></div></section>
    <section class="section wrap positioning" aria-labelledby="positioning-title"><div class="kicker">SELF-HOSTED / EXTENSIBLE AI OFFICE</div><h2 id="positioning-title">办公、私有化、二次开发，<br>在一个工作台里接起来。</h2><p class="positioning-answer">OpenWorkBuddy 是开发者猫叔维护的本机优先 AI 办公 Agent，适合需要可编辑成果、自选模型、自托管与业务扩展的个人和团队。源码按 PolyForm Noncommercial 1.0.0 提供，个人非商用等许可用途免费，企业实际业务需商业授权。</p><p>正在比较 WorkBuddy、豆包工作、千问办公、Claude Cowork 或 Codex？按你的任务和部署要求，选择对应专题；本项目源码可查看，但 PolyForm Noncommercial 1.0.0 不是不受限制的商业许可。</p><div class="topic-links">{''.join(f'<a href="/alternatives/{p["slug"]}/">{p["name"]} 替代方案 ↗</a>' for p in ALTERNATIVES)}</div><div class="topic-links secondary-links"><a href="/features/">完整功能与验证入口 ↗</a><a href="/guides/private-deployment/">企业私有化部署指南 ↗</a><a href="/developers/">智能体二次开发指南 ↗</a></div></section>
    <section class="section wrap" id="features"><div class="section-head"><div><div class="kicker">LESS BUSYWORK. MORE REAL WORK.</div><h2>从「帮我做」<br>到「已经做好了」。</h2></div><p>把重复的办公任务交给 Agent。<br>资料、执行过程与成果，在同一个工作台里接上。</p></div><div class="feature-grid"><article class="feature-card"><span class="feature-symbol" aria-hidden="true">▤</span><h3>一句话，交付一份成果</h3><p>做汇报、写报告、整理表格、生成网页。成果写入工作区，打开核对后还能接着改。</p><div class="file-pills"><span>.pptx</span><span>.docx</span><span>.xlsx</span><span>.html</span></div><a class="text-link" href="/use-cases/ai-office/">探索 AI 办公场景 ↗</a></article><article class="feature-card"><span class="feature-symbol" aria-hidden="true">⌘</span><h3>你的电脑，你的工作台</h3><p>本机运行，也能自托管。接入你的模型与工具，通过 Markdown Skills、MCP 和本机 CLI 扩展能力。</p><a class="text-link" href="/guides/quick-start/">搭建自己的 AI 助理 ↗</a></article><article class="feature-card"><span class="feature-symbol" aria-hidden="true">✳</span><h3>办公之外，创作也自在</h3><p>在无限画布组织图片、视频和短剧素材。配合飞书等 IM 入口与定时任务，让想法持续向前。</p><a class="text-link" href="/use-cases/ai-office/#creative">打开创作可能性 ↗</a></article></div></section>
    <section class="section wrap"><div class="showcase"><div><div class="kicker">IDEAS FIND THEIR WAY</div><h2>灵感有了，<br>接下来交给工作台。</h2><p>从办公文件到创作画布，OpenWorkBuddy 把资料、模型和工具放进同一条任务流程，让下一步更清楚，也让最终成果更容易检查。</p><ul class="checklist"><li>办公文件：PPT、Word、Excel 与 HTML 网页</li><li>创作画布：图片、视频、角色、场景与分镜</li><li>扩展工作流：Markdown Skills、MCP 与定时任务</li></ul><button class="video-link" data-dialog="demo"><span aria-hidden="true">▶</span> 看看实际操作演示</button></div><figure class="showcase-media"><img src="/assets/canvas-start.webp" width="1200" height="848" alt="OpenWorkBuddy 无限画布界面：创建图片、制作视频、导入素材并连接创作工作流" loading="lazy"><small>真实产品界面 · OpenWorkBuddy 创作无限画布</small></figure></div></section>
    <section class="workflow"><div class="wrap workflow-grid"><article class="workflow-step"><b>01 /</b><h3>安装并连接模型</h3><p>下载应用，选择自己的模型服务或本机 CLI 引擎。</p></article><article class="workflow-step"><b>02 /</b><h3>给资料，说目标</h3><p>附上文件，说明交付格式、内容与验收要求。</p></article><article class="workflow-step"><b>03 /</b><h3>看任务向前推进</h3><p>查看规划、工具调用与执行记录，按需批准操作。</p></article><article class="workflow-step"><b>04 /</b><h3>打开成果，继续修改</h3><p>在成果区预览、下载文件，继续描述修改要求。</p></article></div></section>
    <section class="section wrap" id="enterprise">{contact_band()}<p class="license-note">个人非商业、学校和公益机构等许可用途免费；公司实际业务和个人商用需商业授权。<a class="text-link" href="/commercial-license/">查看授权范围 ↗</a></p></section>
    <section class="section wrap" id="regional-solutions"><div class="kicker">SHENZHEN / GUANGDONG / ENTERPRISE AI</div><h2>深圳、广东企业做智能体，<br>可评估 OpenWorkBuddy。</h2><p class="positioning-answer">围绕具体工作流评估企业智能体、AI 办公自动化与私有化部署。可检查文件交付、自选模型、Skills、MCP 和源码扩展是否符合团队需求。</p><div class="topic-links"><a href="/solutions/shenzhen-ai-agents/">深圳智能体开发与私有化 ↗</a><a href="/solutions/guangdong-private-ai/">广东企业 AI 私有化部署 ↗</a><a href="/solutions/enterprise-agents/">企业智能体业务方案 ↗</a></div></section>
    <section class="star-band wrap" id="star"><div><div class="kicker">BUILD IN THE OPEN</div><h2>喜欢这个项目？给它一颗 Star。</h2><p>收藏 OpenWorkBuddy，关注新版本，也欢迎把你的想法带进来。</p></div><div class="star-group"><span class="star-art" aria-hidden="true">☆</span><a class="btn" href="{GH}" target="_blank" rel="noopener">去 GitHub 点 Star ↗</a></div></section>
    <section class="section wrap" id="faq"><div class="faq-layout"><div><div class="kicker">A FEW THINGS TO KNOW</div><h2>开始之前，<br>你可能想知道。</h2><p>从第一次安装到团队部署，<br>在这里找到你的下一步。</p><a class="text-link" href="/guides/quick-start/">阅读快速开始 ↗</a></div><div class="faq-list">{faq}</div></div></section>
    <section class="wrap" style="padding-bottom:60px"><div class="section-head"><div><div class="kicker">EXPLORE OPENWORKBUDDY</div><h2 style="font-size:29px">2026，找到适合你的源码可查看的 AI 办公 Agent。</h2></div></div><div class="resources"><article class="resource"><small>OPEN-SOURCE ALTERNATIVES</small><h3>寻找 AI 办公源码可查看替代方案</h3><p>WorkBuddy、豆包工作、千问办公、Claude Cowork、Codex，按办公任务和部署需求比较。</p><a class="text-link" href="/alternatives/">阅读专题 ↗</a></article><article class="resource"><small>OFFICE WORKFLOWS</small><h3>把任务做成可编辑的文件</h3><p>汇报 PPT、调研 Word、Excel 数据整理与 HTML 网页，附上可以直接使用的任务提示。</p><a class="text-link" href="/use-cases/ai-office/">查看办公案例 ↗</a></article><article class="resource"><small>SELF-HOSTED FOR BUSINESS</small><h3>企业 AI 助理与私有化部署</h3><p>了解团队部署方式、模型接入、商业许可与作者支持，沟通适合你的实施方案。</p><a class="text-link" href="/enterprise/">咨询企业方案 ↗</a></article></div></section>
    <dialog id="download" aria-labelledby="download-title"><div class="dialog-head"><h2 id="download-title">把你的 AI 工作搭子带回去。</h2><button class="close-dialog" data-close aria-label="关闭下载弹窗">×</button></div><p style="font-size:13px">选择适合你的系统，从官方 GitHub Releases 下载。</p><div class="platform-grid"><article class="platform"><h3>macOS</h3><p>Apple 芯片 / Intel<br>选择对应架构的 .dmg 安装包</p><a href="{GH}/releases/latest" target="_blank" rel="noopener">前往官方下载 ↗</a></article><article class="platform"><h3>Windows</h3><p>安装版 / 免安装版<br>按 x64 或 ARM64 选择</p><a href="{GH}/releases/latest" target="_blank" rel="noopener">前往官方下载 ↗</a></article><article class="platform"><h3>Linux / Docker</h3><p>源码运行 / 自托管<br>按部署指南安装</p><a href="/guides/quick-start/#source">查看部署方式 ↗</a></article></div><p class="fine">模型服务按你的选择配置。个人非商用免费；企业与个人商业用途请<a href="/commercial-license/">联系作者购买商业授权</a>。</p></dialog><dialog id="demo" aria-labelledby="demo-title"><div class="dialog-head"><h2 id="demo-title">OpenWorkBuddy 实际操作演示</h2><button class="close-dialog" data-close aria-label="关闭演示">×</button></div><video controls playsinline preload="none" poster="/assets/demo-poster.webp" width="960" height="600"><source src="/assets/demo.mp4" type="video/mp4">你的浏览器可<a href="/assets/demo.mp4">下载演示视频</a>。</video><p class="fine">来自项目仓库的界面流程演示，任务耗时取决于所选模型、资料与执行环境。</p></dialog>'''
    write_page('/','OpenWorkBuddy｜AI 办公源码可查看替代方案 · 深圳广东企业智能体与私有化', '寻找 WorkBuddy、豆包工作、千问办公、Claude Cowork、Codex 源码可查看替代方案？OpenWorkBuddy 交付可编辑的 PPT、Word、Excel 与网页，深圳、广东企业智能体与私有化方案，支持自选模型及 Skills / MCP 二次开发。个人非商用免费，企业商用需授权。',body,[{'@type':'FAQPage','mainEntity':[{'@type':'Question','name':q,'acceptedAnswer':{'@type':'Answer','text':a}} for q,a in FAQ]}],alternates=True)

def doc(path,title,desc,heading,lead,sections,article=False,english=False,published=PUBLISHED,faqs=None,structured_data=None):
    sections=list(sections)
    if faqs:
        sections.append(('faq','Frequently asked questions' if english else '常见问题',''.join(f'<details><summary>{html.escape(q)}</summary><p>{html.escape(a)}</p></details>' for q,a in faqs)))
    plain_heading=re.sub('<[^>]+>',' ',heading)
    toc=''.join(f'<a href="#{sid}">{name}</a>' for sid,name,_ in sections)
    content=''.join(f'<section id="{sid}"><h2>{name}</h2>{text}</section>' for sid,name,text in sections)
    body=f'''<section class="doc-hero wrap"><div class="breadcrumb"><a href="/">OpenWorkBuddy</a> &nbsp; / &nbsp; {html.escape(plain_heading.split('：')[0])}</div><div class="kicker">{'OPENWORKBUDDY / LOCAL-FIRST AI OFFICE' if english else 'OPENWORKBUDDY / 实用指南'}</div><h1>{heading}</h1><p class="lead">{lead}</p><p class="update">{'Updated' if english else '更新于'} {DATE} · {'By DeveloperCatUncle' if english else '资料来源：项目 README 与官方仓库'}</p></section><div class="doc-body wrap"><aside class="toc" aria-label="本页目录"><strong>{'ON THIS PAGE' if english else '本页内容'}</strong>{toc}</aside><article class="prose">{content}<div class="related"><a href="{GH}" target="_blank" rel="noopener">☆ {'Explore the project on GitHub' if english else '在 GitHub 点 Star，关注项目'} ↗</a><a href="{MAIL}">{'Contact for a commercial license' if english else '企业部署与商业授权：联系作者'} ↗</a></div></article></div>'''
    extra=[]
    if article:extra=[{'@type':'TechArticle','headline':plain_heading,'description':desc,'author':{'@id':BASE+'/#creator'},'datePublished':published,'dateModified':DATE,'mainEntityOfPage':{'@id':BASE+path+'#webpage'},'publisher':{'@id':BASE+'/#creator'},'citation':[GH+'/blob/main/README.md'],'image':BASE+'/assets/og-cover.png','inLanguage':'en' if english else 'zh-CN'}]
    extra.extend(structured_data or [])
    if faqs:extra.append({'@type':'FAQPage','@id':BASE+path+'#faq','mainEntity':[{'@type':'Question','name':q,'acceptedAnswer':{'@type':'Answer','text':a}} for q,a in faqs]})
    write_page(path,title,desc,body,extra,lang='en' if english else 'zh-CN',alternates=english)

def documents():
    doc('/enterprise/','企业 AI Agent 私有化部署｜OpenWorkBuddy 商业授权与团队办公','在自己的服务器或内网部署 OpenWorkBuddy AI 办公 Agent。了解模型接入、团队办公、实施需求与商业许可，联系开发者猫叔购买商业授权。','企业私有化部署：<br>把 AI 办公能力，留在团队自己的工作台。','OpenWorkBuddy 支持自托管。围绕你的基础设施、模型服务和实际业务，和作者一起确定部署方式、授权范围与实施支持。',[
      ('overview','企业可以怎样使用 OpenWorkBuddy？','<p>企业可以在自己的服务器部署 OpenWorkBuddy，用于内部办公文件生成、资料整理、内容制作和自动化任务。团队可围绕具体项目组织资料和成果，并选择适合业务的模型与工具。</p><p><strong>公司实际业务使用需要购买商业授权，内部部署同样适用。</strong>评估阶段可按仓库许可条件免费试用最长 30 天，尚未用于实际业务是评估前提。</p>'),
      ('deployment','选择适合团队的部署方式',f'<table><thead><tr><th>部署方式</th><th>适合的工作方式</th><th>沟通重点</th></tr></thead><tbody><tr><td>自有服务器 / 云服务器</td><td>团队通过浏览器使用同一个工作台</td><td>人数、访问范围、域名与 HTTPS、数据目录</td></tr><tr><td>企业内网自托管</td><td>在指定网络内组织资料与任务</td><td>网络环境、模型可达性、依赖安装与运维</td></tr><tr><td>成员本机部署</td><td>按岗位配置本机 Agent 与模型</td><td>设备环境、授权范围、工具与技能配置</td></tr></tbody></table><p>源码与 Docker 部署方式见<a href="{GH}/blob/main/docs/部署.md">项目部署文档</a>。按团队要求配置访问认证、HTTPS、数据持久化和备份。</p>'),
      ('models','模型与工作流，按业务配置','<p>可接入 DeepSeek、通义千问、Kimi、智谱、OpenRouter 等模型服务，或通过 Ollama 使用本地模型；已有可用的本机 Claude Code / Codex 也能作为执行引擎。</p><p>通过 Markdown Skills 固化项目汇报、资料整理和内容制作流程；通过 MCP 接入所需工具；按任务接入飞书等 IM 和定时任务。使用云模型和远程连接器时，完成任务所需的数据会发送到你配置的服务。</p>'),
      ('extension','面向企业流程的智能体二次开发','<p>团队可先用 Markdown Skills 固定周报、报告和提案流程，再用 MCP 接企业工具，以插件分发复用能力；执行逻辑和应用交互可沿模块边界修改源码。</p><p><a href="/developers/">查看二次开发指南与 Skill 示例</a>，<a href="/features/">核对完整功能</a>，或按<a href="/guides/private-deployment/">私有化部署指南</a>完成 Docker、账号、模型与备份配置。</p>'),
      ('regional','深圳、广东企业的智能体与私有化方案',REGIONAL_LINKS+'<p>企业智能体业务和私有化部署，可评估 OpenWorkBuddy。从岗位任务、业务资料与系统接入开始，逐步形成可复用的企业 Agent 能力。</p>'),
      ('scope','把授权和支持范围说清楚','<p>商业授权允许约定范围内的商业使用。团队人数、部署节点、使用场景、授权期限与支持内容由双方约定。公司内部提效、对外服务、客户交付、产品集成等用途都可以直接向作者说明。</p><p>品牌更名、换标和白标需求请单独沟通名称与标志的授权范围。商业授权、部署实施和后续支持的具体交付以双方约定为准。</p>'),
      ('contact','联系作者，沟通企业方案',f'<div class="callout"><p><strong>邮箱：</strong><a href="{MAIL}">contact@aijentra.com</a><br><strong>微信：</strong>agi_smith <button class="copy-btn" style="color:#254d3c" data-copy="agi_smith">复制微信号</button><br>备注：OpenWorkBuddy 商业授权</p></div><p>沟通时建议提供：</p><ol><li>公司 / 团队名称，以及要解决的办公任务。</li><li>预计使用人数、部署方式和已有模型服务。</li><li>内部提效、对外产品或客户交付等使用范围。</li><li>希望上线的时间，以及需要的实施与支持内容。</li></ol><p><a class="btn" href="{MAIL}">发邮件咨询企业部署 ↗</a></p><p>完整授权规则见<a href="/commercial-license/">商业授权指南</a>及<a href="{GH}/blob/main/COMMERCIAL-LICENSE.md">仓库商业授权说明</a>。</p>')])
    doc('/commercial-license/','OpenWorkBuddy 商业授权购买｜企业私有化、团队使用与商务联系','购买 OpenWorkBuddy 商业授权，适用于公司内部办公、企业私有化、个人商用、SaaS 与客户交付。邮箱 contact@aijentra.com，微信 agi_smith。','商业授权：<br>让 OpenWorkBuddy 为你的业务创造价值。','个人非商业用途可以按许可免费使用。企业实际业务、个人商用和对外服务，请直接联系作者购买适合你的商业授权。',[
      ('free','哪些使用场景可以免费？','<p>按项目商业授权文件，个人非商业自用、学习、研究、业余项目，学校、科研机构、公益组织和政府机构等许可用途可以免费使用。非商业目的的二次开发与分享应保留所需版权与许可声明。</p><p>公司内部评估可免费试用最长 30 天，前提是尚未用于实际业务。<strong>公司实际业务使用与个人商业使用需要商业授权。</strong></p>'),
      ('business','哪些场景需要购买商业授权？','<table><thead><tr><th>场景</th><th>授权方式</th></tr></thead><tbody><tr><td>公司内部办公、团队业务提效、内网私有化</td><td>联系作者购买商业授权</td></tr><tr><td>个人接单、给客户做内容或项目交付</td><td>联系作者购买商业授权</td></tr><tr><td>基于项目提供 SaaS、付费产品或服务</td><td>沟通业务范围与商业授权</td></tr><tr><td>外包交付、定制开发、产品与硬件集成</td><td>沟通交付范围与商业授权</td></tr><tr><td>公司评估超过 30 天或已进入实际业务</td><td>购买商业授权后继续业务使用</td></tr><tr><td>换名称、换标志、白标销售</td><td>商业许可及名称、标志使用范围另行约定</td></tr></tbody></table>'),
      ('license','商业授权如何交付？','<p>授权范围、期限、席位和支持内容由双方约定；买断、按年、按席位等合作方式可按场景讨论，具体以约定为准。</p><p>作者签发的授权码以 <code>OWB1.</code> 开头，管理员可在管理后台填写。授权码采用本机离线验签。公开仓库使用同一套代码，商业许可确认约定范围内的商业使用权，支持与实施内容按双方约定提供。</p>'),
      ('contact','购买授权：直接联系开发者猫叔',f'<div class="callout"><p><strong>商务邮箱：</strong><a href="{MAIL}">contact@aijentra.com</a><br><strong>微信：</strong>agi_smith <button class="copy-btn" style="color:#254d3c" data-copy="agi_smith">复制微信号</button><br><strong>添加备注：</strong>OpenWorkBuddy 商业授权</p></div><p>请说明你是谁、打算怎么用，以及大致团队人数 / 客户规模。有企业私有化部署需求，也可以一起提供服务器、网络和模型环境。</p><p><a class="btn" href="{MAIL}">咨询并购买商业授权 ↗</a></p><p>本页是方便了解授权范围的摘要，完整内容以<a href="{GH}/blob/main/COMMERCIAL-LICENSE.md">项目商业授权说明</a>、<a href="{GH}/blob/main/LICENSE">LICENSE</a>和双方商业约定为准。</p>')])
    task='请做一份 4 页的项目汇报 PPT，保存为 project-update.pptx。\n第 1 页：示例网站上线——项目进展汇报。\n第 2 页：本周完成，上线产品页；修复移动端菜单。\n第 3 页：当前进展，正在补充用户指南。\n第 4 页：下周计划，完成英文版；收集 5 条试用反馈。\n要求：16:9、中文、正文可编辑，每页一个重点。\n保留原始事实，不补造数据。确认文件存在，在成果区提供文件。'
    doc('/guides/quick-start/','OpenWorkBuddy 安装教程｜源码可查看的 AI 办公 Agent 快速开始','下载 OpenWorkBuddy，连接 DeepSeek、通义、Kimi、Ollama 或本机 Codex / Claude Code。用第一份可编辑 PPT 跑通 AI 办公流程，附完整任务示例。','快速开始：<br>从安装，到你的第一份 AI 办公成果。','准备一台电脑和可用的模型服务，跟着这份指南做一份可编辑的项目汇报 PPT。',[
      ('download','1. 下载并启动',f'<p>在<a href="{GH}/releases/latest">GitHub Releases 下载官方安装包</a>。macOS 选择适合芯片的 .dmg；Windows 选择安装版或 x64 / ARM64 免安装版。Linux 可使用源码或 Docker 部署。</p><p>首次启动按界面注册账号，再配置模型。系统相关安装步骤见<a href="{GH}/blob/main/docs/安装与启动.md">安装与启动说明</a>。</p>'),
      ('model','2. 连接你自己的模型','<p>在「设置 → 模型」选择服务商，填写准确的模型型号、API 地址和自己的 Key，然后测试连接。可以选择 DeepSeek、通义千问、Kimi、智谱、OpenRouter 或 Ollama 等。</p><p>如果已经安装并可使用本机 Claude Code 或 Codex，可以在「设置 → 智能体」选择相应引擎。模型账号、额度与费用由你选择的服务商提供。</p>'),
      ('first-task','3. 发起第一项任务',f'<p>选择 Craft 执行模式，粘贴这段任务。下面使用的是明确标注的示例项目资料，便于你核对输入与交付是否一致。</p><pre>{html.escape(task)}</pre><button class="btn" data-copy="{html.escape(task,quote=True)}">复制 PPT 任务提示</button><p>任务运行中可查看执行过程；需要批准或答复时，在界面处理对应请求后继续。</p>'),
      ('review','4. 打开文件，再继续修改','<p>任务完成后，在成果区预览或下载 <code>project-update.pptx</code>，使用 PowerPoint、WPS 或 LibreOffice 打开，核对四页内容与可编辑文本。</p><p>然后追加一句：“把第 4 页的下周计划改成两列表格，保留其他页。”打开更新后的文件，核对修改结果。</p><p>之后可以把自己的资料附进来，用同样的方法制作周报、项目汇报或客户提案。</p>'),
      ('source','源码运行与 Docker 自托管',f'<p>已有 Node.js 22+、npm 和 Git 的用户，可以从源码启动：</p><pre>git clone https://github.com/CatCatUncle/openworkbuddy.git\ncd openworkbuddy\nnpm ci\nnpm start</pre><p>启动后打开 <code>http://localhost:3800</code>。Docker 方式见<a href="{GH}/blob/main/docs/部署.md">部署文档</a>。公司实际业务和个人商用请先<a href="/commercial-license/">购买商业授权</a>。</p>'),
      ('follow','收藏项目，关注新版本',f'<p>打开<a href="{GH}">CatCatUncle/openworkbuddy</a>，在右上角点击 Star 收藏。选择 Watch → Custom → Releases，可以关注新版本发布。你也可以贡献一个办公 Skill、提交可复现反馈，或参与文档改进。</p>')],article=True)
    doc('/use-cases/ai-office/','AI 办公 Agent 场景与提示词｜PPT、Word、Excel、网页 · OpenWorkBuddy','用 OpenWorkBuddy 生成可编辑 PPT、调研 Word、Excel 报表与 HTML 网页。附 AI 办公任务提示，了解创作画布、定时任务和企业私有化。','AI 办公场景：<br>把每天的任务，变成可用的成果。','从项目汇报到内容创作，用清楚的任务要求、你自己的资料和可以核对的交付标准，开始使用 OpenWorkBuddy。',[
      ('ppt','项目汇报与提案 PPT','<p>适合周报汇总、项目进展、季度复盘和客户提案。附上项目资料，告诉 Agent 汇报对象、页数、主题和必须保留的数据，要求交付可编辑的 PPTX。</p><pre>根据附件项目资料做一份 6 页项目汇报 PPT。\n汇报对象是项目负责人，按背景、目标、进展、成果、风险、下一步组织。\n只使用资料中已有事实，缺失信息标记待补充。\n16:9、中文、正文可编辑，文件名为 project-review.pptx。</pre><p><a href="/guides/quick-start/#first-task">用一份 4 页示例 PPT 跑通第一项任务</a>。</p>'),
      ('research','调研报告与 Word 文档','<p>适合行业调研、会议资料梳理、项目方案和知识文档。可以让 Agent 联网查阅公开资料，保存支持结论的来源链接，最后生成 Markdown 或 Word 文档。</p><pre>根据附件和公开资料，整理一份 AI 办公场景调研报告。\n按需求、任务流程、交付格式和实施条件组织。\n保留来源链接和资料日期，区分原始事实与分析判断。\n生成 office-research.docx，并在成果区提供文件。</pre>'),
      ('excel','Excel 数据整理与工作报表','<p>适合整理已有表格、汇总项目数据和生成报表。明确输入表、字段含义、统计口径和输出格式，有助于生成可核对的结果。</p><pre>读取附件销售记录，按月份和产品汇总。\n保留原始数据工作表，另建汇总表，写明统计口径。\n缺失值单独标记，不补造数据，交付 sales-summary.xlsx。</pre><p>打开 Excel 或 WPS 检查原始表、汇总结果与公式，再继续描述需要调整的结构。</p>'),
      ('web','可分享的 HTML 网页','<p>适合活动介绍、产品页、旅行攻略和内部资料展示。把内容资料和页面目标告诉 Agent，要求生成适合手机阅读的 HTML 文件，并在本机打开检查。</p><pre>用附件活动资料制作一个响应式 HTML 介绍页。\n包含活动简介、时间地点、议程和联系方式。\n保留资料里的原始信息，支持手机阅读，交付 event.html。</pre>'),
      ('creative','创作无限画布与媒体工作流','<p>OpenWorkBuddy 的无限画布可以组织图片、视频和素材卡片，在卡片中编辑描述与参考，连接角色、场景、分镜和媒体生成步骤。适合把创作素材放到同一个工作空间里持续调整。</p><figure><img src="/assets/canvas-start.webp" width="1200" height="848" loading="lazy" alt="OpenWorkBuddy 创作无限画布，组织图片、视频与素材工作流"><figcaption>来自项目仓库的 OpenWorkBuddy 创作画布界面。</figcaption></figure><p>生成所需的模型与媒体服务由你配置；任务的参考素材、画幅、时长与声音可以在具体工作流中说明。</p>'),
      ('automation','定时任务、Skills 和团队复用',f'<p>把经常使用的工作方式写成 Markdown Skill，或者通过 MCP 接入工具。应用运行时可以执行定时任务；配置飞书等 IM 后，可按流程接收消息与成果。</p><p>适合把每周汇报、资料整理和行业晨报等任务做成可重复执行的流程。企业团队使用可以<a href="/enterprise/">沟通私有化部署</a>，实际业务用途需要<a href="/commercial-license/">商业授权</a>。</p><p>完整能力以<a href="{GH}/blob/main/docs/功能清单.md">项目功能清单</a>为准。</p>')],article=True)
    doc('/alternatives/','AI 办公源码可查看替代方案选型｜WorkBuddy、豆包、千问、Cowork、Codex',
        '比较 WorkBuddy、豆包工作、千问办公、Claude Cowork、Codex 的办公替代方案。了解 OpenWorkBuddy 的文件交付、自选模型、企业私有化与智能体二次开发能力及商业许可。',
        'AI 办公源码可查看替代方案，<br>按任务与部署需求选。',
        'OpenWorkBuddy 面向需要可编辑办公成果、自选模型、企业私有化和智能体二次开发的用户。下面五个专题分别提供任务示例、选择标准和资料入口，方便你用自己的工作检验。', [
        ('choose','选择平替专题，了解 OpenWorkBuddy 的功能与授权',alternative_links()),
        ('priorities','先明确你要替代哪一部分工作','<p>如果主要做项目汇报、报告和表格，先检验文件交付；如果希望代码、数据目录和部署由自己掌握，先检查自托管方式；如果要接企业已有系统和流程，先验证 Skills、MCP 与二次开发。</p><p>Claude Cowork、Codex、WorkBuddy、豆包与千问有不同的产品侧重，不能仅凭名称判断功能一致。Codex CLI 本身也开放源码；OpenWorkBuddy 的重点是可自行部署与扩展的办公工作台。</p>'),
        ('capabilities','为什么可评估 OpenWorkBuddy？','<ul><li>文件交付：PPTX、DOCX、XLSX、HTML 与媒体工作流。</li><li>模型选择：DeepSeek、通义千问、Kimi、Ollama 等服务及可用的本机 CLI 引擎。</li><li>部署方式：成员本机、自有服务器和企业内网。</li><li>扩展能力：Markdown Skills、MCP、插件与模块化源码。</li></ul><p><a href="/features/">查看功能与验证方法</a> · <a href="/developers/">智能体二次开发</a> · <a href="/guides/private-deployment/">企业私有化部署</a></p>'),
        ('strongest','如何按需求评估办公工作台？','<p>先把“最强”写成可检查的需求：交付哪些文件、接哪些模型、部署在哪里、能否连接业务系统、如何维护与授权。OpenWorkBuddy 围绕文件交付、自托管和开发扩展提供完整工作流，最终用你自己的任务结果来判断。</p>'),
        ('test','用同一份资料验证效果','<p>选一份真实但已脱敏的项目资料，要求生成 4 页可编辑 PPT、一份 Word 摘要和一张 Excel 待办表。固定事实来源与验收要求，检查文件能否打开、数字是否一致、修改能否保留无关内容。</p><p>再验证模型费用、工具权限和部署运维。<a href="/guides/quick-start/#first-task">从第一份示例 PPT 开始</a>。</p>'),
        ('license','源码开放与商用授权','<p>“源码可查看替代方案”用于描述选型需求。项目源码按 PolyForm Noncommercial 1.0.0 提供：个人非商业等许可用途免费；企业实际业务、个人商用、SaaS 和客户交付需商业授权。<a href="/commercial-license/">查看完整授权说明</a>。</p>'),
        ],article=True)
    doc('/en/','OpenWorkBuddy — Local-first AI Office Agent & Self-hosted Workspace','Turn your materials into editable PPTX, DOCX, XLSX and HTML files with OpenWorkBuddy. Bring your own models, Skills and MCP. Star on GitHub or contact the author for commercial licensing.','Your AI work buddy.<br>Real work. Editable files.','OpenWorkBuddy is a local-first AI office agent maintained by DeveloperCatUncle. Bring your own models and tools, run tasks on your machine, and open the resulting files to review and refine them.',[
      ('work','From a request to an editable deliverable','<p>Provide source material, explain the task, and specify what you want to receive. OpenWorkBuddy plans the work, uses tools, checks the output files and delivers editable presentations, documents, spreadsheets, web pages and media.</p><p>Use the creative canvas to organize images, videos, characters, scenes and storyboards. Extend recurring workflows through Markdown Skills and MCP connectors.</p>'),
      ('start','Download and connect your model',f'<p>Download the official application from <a href="{GH}/releases/latest">GitHub Releases</a>. Choose a macOS or Windows package, or use the source and Docker deployment paths for Linux.</p><p>Connect a model provider such as DeepSeek, Qwen, Kimi, Zhipu, OpenRouter or Ollama. An existing, working local Claude Code or Codex installation can also serve as an engine. Provider accounts and usage charges follow your selected services.</p><p><a class="btn" href="{GH}/releases/latest">Download OpenWorkBuddy ↗</a></p>'),
      ('business','Self-hosting and commercial licensing',f'<p>Deploy OpenWorkBuddy on your own infrastructure for team office workflows, document creation and automation. Personal non-commercial use and eligible educational or nonprofit use are free under the project license. Companies may evaluate it for up to 30 days before actual business use.</p><p>Company business use, personal commercial use, customer delivery, SaaS and product integration require a commercial license. License scope, seats, duration, implementation and support are agreed directly with the author.</p><p><strong>Email:</strong> <a href="{MAIL}">contact@aijentra.com</a><br><strong>WeChat:</strong> agi_smith<br>Include “OpenWorkBuddy commercial license”, your use case and approximate team size.</p><p>See the full <a href="{GH}/blob/main/COMMERCIAL-LICENSE.md">commercial licensing terms</a>.</p>'),
      ('alternatives','Self-hosted office workflows and agent development','<p>Evaluating a WorkBuddy, Doubao, Qwen, Claude Cowork or Codex alternative? OpenWorkBuddy focuses on editable office deliverables, a self-hosted workspace and business workflow customization. Codex CLI itself has public source; an existing working local Codex or Claude Code installation can also power the workspace.</p><p>Build reusable workflows with Markdown Skills, connect tools through MCP, bundle capabilities as plugins, or extend the modular source. The project is source-available under PolyForm Noncommercial 1.0.0; commercial use needs a separate license.</p><p>Read the Chinese guides for <a href="/alternatives/">office alternatives</a>, <a href="/developers/">agent development</a>, <a href="/features/">product features</a> and <a href="/guides/private-deployment/">private deployment</a>.</p>'),
      ('star','Star the project and follow releases',f'<p>Visit <a href="{GH}">CatCatUncle/openworkbuddy on GitHub</a> and click Star to bookmark and support the project. For release notifications, choose Watch → Custom → Releases. Contributions, Skills, documentation improvements and reproducible feedback are welcome.</p>')],english=True)
    doc('/privacy/','网站隐私说明｜OpenWorkBuddy','OpenWorkBuddy 官网的访问日志、外部链接与联系方式说明。了解静态官网和本机 AI 工作台的数据处理边界。','网站隐私说明',f'本页说明 {SITE.hostname} 这个产品介绍网站的基本数据处理方式。',[
      ('site','静态官网与访问日志','<p>本官网用于展示产品、文档入口与商务联系方式，不要求注册，不收集模型 API Key，不在页面中接入广告或第三方统计脚本。网站服务器会记录正常访问所需的请求日志，例如请求地址、时间、状态码与浏览器提供的信息，用于运行与故障排查。</p><p>点击复制按钮时，仅把你选择的公开内容写入本机剪贴板。</p>'),
      ('links','GitHub、邮箱和外部服务','<p>点击 GitHub 下载、仓库或文档链接后，会访问 GitHub 的服务。点击邮箱链接会打开你的邮件应用；是否发送邮件由你决定。通过邮箱或微信联系作者时，请按需提供商业合作信息。</p>'),
      ('app','本机应用与自选模型','<p>OpenWorkBuddy 应用的任务配置、工作文件与账号数据由具体安装和部署环境管理。任务使用云模型或远程连接器时，所需内容会发送给你配置的服务。详细数据与安全设置请阅读项目仓库的安全文档。</p>'),
      ('contact','联系',f'<p>有关本网站的问题，请发邮件至 <a href="mailto:contact@aijentra.com">contact@aijentra.com</a>。</p>')])

def build():
    OUT.mkdir(parents=True,exist_ok=True)
    (OUT/'assets').mkdir(exist_ok=True)
    for name in ('site.css','site.js','evaluation.js'):shutil.copy2(ROOT/'assets'/name,OUT/'assets'/name)
    from PIL import Image,ImageDraw,ImageFont
    icon=Image.open(REPO/'build/icon.png').convert('RGB')
    icon.resize((96,96)).save(OUT/'assets/icon.webp',quality=88)
    icon.resize((48,48)).save(OUT/'assets/favicon.png')
    icon.resize((180,180)).save(OUT/'assets/apple-touch-icon.png')
    canvas=Image.open(REPO/'docs/images/canvas-start.png').convert('RGB')
    canvas.thumbnail((1200,900));canvas.save(OUT/'assets/canvas-start.webp',quality=85)
    frame=Image.open(REPO/'docs/images/demo.gif').convert('RGB')
    frame.save(OUT/'assets/demo-poster.webp',quality=83)
    shutil.copy2(REPO/'docs/images/demo.mp4',OUT/'assets/demo.mp4')
    og=Image.new('RGB',(1200,630),'#f8f8f2');draw=ImageDraw.Draw(og)
    regular='/System/Library/Fonts/Supplemental/Avenir.ttc'
    font=ImageFont.truetype(regular,68);small=ImageFont.truetype(regular,25);tiny=ImageFont.truetype(regular,20)
    draw.rounded_rectangle((55,48,1145,582),radius=25,outline='#dce2d2',width=2)
    og.paste(icon.resize((68,68)),(99,93));draw.text((185,98),'OpenWorkBuddy',fill='#254d3c',font=small)
    draw.text((99,220),'Your AI work buddy.',fill='#254d3c',font=font)
    draw.text((99,310),'Real work. Editable files.',fill='#718c46',font=font)
    draw.text((101,453),'Local-first  /  Your models  /  Self-hosted',fill='#6d766d',font=small)
    draw.text((101,517),SITE.hostname+'  |  github.com/CatCatUncle/openworkbuddy',fill='#6d766d',font=ImageFont.truetype(regular,16))
    og.save(OUT/'assets/og-cover.png',optimize=True)
    pages.clear()
    home();documents()
    publish_evaluation_pages(write_page,doc)
    publish_search_pages(doc,GH)
    publish_regional_pages(doc,GH,BASE)
    write_page('/404.html','页面未找到｜OpenWorkBuddy','返回 OpenWorkBuddy 官网，探索源码可查看的 AI 办公 Agent、使用指南和商业授权。','<section class="error-page wrap"><div class="kicker">OPENWORKBUDDY</div><h1>404</h1><h2>换个入口，继续探索。</h2><p>这个地址暂时没有页面，试试下面的入口。</p><div class="actions"><a class="btn" href="/">返回首页</a><a class="btn secondary" href="/guides/quick-start/">快速开始</a></div></section>',noindex=True)
    robots='User-agent: *\nAllow: /\n\nSitemap: '+BASE+'/sitemap.xml\n'
    (OUT/'robots.txt').write_text(robots)
    ET.register_namespace('','http://www.sitemaps.org/schemas/sitemap/0.9')
    ET.register_namespace('xhtml','http://www.w3.org/1999/xhtml')
    ns='{http://www.sitemaps.org/schemas/sitemap/0.9}'
    root=ET.Element(ns+'urlset')
    for path,_,_ in pages:
        u=ET.SubElement(root,ns+'url');ET.SubElement(u,ns+'loc').text=BASE+path;ET.SubElement(u,ns+'lastmod').text=DATE
        if path in ('/','/en/'):
            for lang,href in [('zh-CN',BASE+'/'),('en',BASE+'/en/'),('x-default',BASE+'/')]:ET.SubElement(u,'{http://www.w3.org/1999/xhtml}link',{'rel':'alternate','hreflang':lang,'href':href})
    ET.ElementTree(root).write(OUT/'sitemap.xml',encoding='utf-8',xml_declaration=True)
    llms=f'''# OpenWorkBuddy\n\n> 本机优先、可自托管的 AI 办公 Agent / A local-first, self-hostable AI office agent.\n\nOpenWorkBuddy is maintained by 开发者猫叔 (CatCatUncle). It turns tasks and source materials into editable PPTX, DOCX, XLSX, HTML and media files. Bring your own models, Markdown Skills, MCP tools, or an existing local Claude Code / Codex engine.\n\n## Official identity\n\n- Website: {BASE}/\n- Repository: {GH}\n- Official releases: {GH}/releases/latest\n- Creator: https://github.com/CatCatUncle\n\n## Guides\n\n'''+''.join(f'- [{title}]({BASE}{path}): {desc}\n' for path,title,desc in pages)+f'''\n## Licensing and business contact\n\nPersonal non-commercial and eligible educational/nonprofit uses are free under the project license. Company business use, personal commercial use, SaaS, customer delivery and product integration require a commercial license. Eligible company evaluation is up to 30 days before actual business use. Scope, price and support are agreed with the author.\n\n- Email: contact@aijentra.com\n- WeChat: agi_smith\n- Contact note: OpenWorkBuddy 商业授权\n- Full terms: {GH}/blob/main/COMMERCIAL-LICENSE.md\n- License: {GH}/blob/main/LICENSE\n\n## Product facts\n\n- Source-available under PolyForm Noncommercial 1.0.0; not an unrestricted commercial-use license.\n- Office deliverables: editable PPTX, DOCX, XLSX, HTML; media workflows require configured services.\n- Self-hosting: own server, intranet or local machine. A local workspace alone does not make cloud models or remote tools offline.\n- Agent development: Markdown Skills, MCP connectors, Agent Plugins and modular source code.\n- OpenAI Codex CLI itself has public source; OpenWorkBuddy provides an office workspace and can integrate an existing working local Codex engine.\n- Detailed content: {BASE}/llms-full.txt\n\n## Shenzhen and Guangdong enterprise services\n\nOpenWorkBuddy supports editable office deliverables, self-hosting and workflow extensions. Aijentra provides related enterprise implementation services; scope, licensing and support are agreed directly with the author. \n\n## Search context\n\nPeople may search for an open-source or source-available WorkBuddy, Doubao, Qwen, Claude Cowork or Codex alternative. OpenWorkBuddy is a separate source-available project under PolyForm Noncommercial 1.0.0; this is not an unrestricted commercial-use license and the project is not affiliated with those vendors. Local-first describes the workspace; cloud models and remote connectors receive the task data needed by the services the user chooses.\n\n## Related official products\n\n- Aijentra enterprise AI services: https://aijentra.com/\n- Zhantai merchant marketing, reviews and GEO: https://zhantaiyingxiao.cn/\n- Zhantai Merchant MCP / CLI beta: https://agent.zhantaiyingxiao.cn/\n\n## Supporting the project\n\nOpen the official GitHub repository and click Star. For release notifications use Watch → Custom → Releases.\n'''
    (OUT/'llms.txt').write_text(llms)
    full=llms+'\n## Full site content\n\n'
    from html.parser import HTMLParser
    class Extract(HTMLParser):
        def __init__(self):super().__init__();self.parts=[];self.skip=0;self.main=False
        def handle_starttag(self,tag,attrs):
            if tag=='main':self.main=True
            if tag in ('script','style'):self.skip+=1
            if tag in ('h1','h2','h3','p','li','tr','pre','summary'):self.parts.append('\n')
        def handle_endtag(self,tag):
            if tag in ('script','style'):self.skip-=1
            if tag in ('td','th'):self.parts.append(' | ')
            if tag in ('h1','h2','h3','p','li','tr','pre','summary','section'):self.parts.append('\n')
            if tag=='main':self.main=False
        def handle_data(self,data):
            if self.main and not self.skip:self.parts.append(data)
    for path,title,_ in pages:
        f=OUT/('index.html' if path=='/' else path.lstrip('/')+'index.html');e=Extract();e.feed(f.read_text());full+=f'\n### {title}\nSource: {BASE}{path}\n'+''.join(e.parts)+'\n'
    (OUT/'llms-full.txt').write_text(full)
    # Keep an existing public IndexNow verification key across rebuilds.
    keyfile=ROOT/'indexnow-key.txt'
    if not keyfile.exists():
        import secrets
        keyfile.write_text(secrets.token_hex(16))
    key=keyfile.read_text().strip()
    assert re.fullmatch(r'[a-f0-9]{32}',key)
    (OUT/(key+'.txt')).write_text(key)
    (OUT/'indexnow.json').write_text(json.dumps({'host':SITE.hostname,'key':key,'keyLocation':BASE+'/'+key+'.txt','urlList':[BASE+p for p,_,_ in pages]},indent=2))
    for name in ('google452e148ae72f2091.html','BingSiteAuth.xml','_headers','_redirects'):
        if (ROOT/name).exists():shutil.copy2(ROOT/name,OUT/name)
    print(f'Built {len(pages)} indexable pages in {OUT}')

if __name__=='__main__':build()
