<p align="center">
  <img src="build/icon.png" width="120" alt="OpenWorkBuddy">
</p>

<h1 align="center">OpenWorkBuddy</h1>

<p align="center">
  <b>A local-first AI office agent that hands you files, not chat logs.</b><br>
  Say what you need in plain language. It plans, does the work, checks the result — and delivers a real PPT / Word / Excel / web page you can open.
</p>

<p align="center">
  <sub><a href="README.md"><b>中文</b></a> · English</sub>
</p>

<p align="center">
  <a href="#run-it-in-three-minutes"><b>⚡ Run it in three minutes</b></a> ·
  <a href="https://github.com/CatCatUncle/openworkbuddy/releases">Download</a> ·
  <a href="CHANGELOG.en.md">Changelog</a> ·
  <a href="docs/功能清单.md">Feature list (zh)</a> ·
  <a href="README.md#交流群">Feishu group</a>
</p>

<p align="center">
  <a href="https://github.com/CatCatUncle/openworkbuddy/stargazers"><img src="https://img.shields.io/github/stars/CatCatUncle/openworkbuddy?style=flat-square&logo=github&label=Star&color=5b5ff7" alt="Star"></a>
  <a href="https://github.com/CatCatUncle/openworkbuddy/forks"><img src="https://img.shields.io/github/forks/CatCatUncle/openworkbuddy?style=flat-square&logo=github&color=5b5ff7" alt="Fork"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-PolyForm%20NC-5b5ff7?style=flat-square" alt="License"></a>
</p>

<p align="center">
  <sub>Free for personal, learning and non-profit use. Commercial use needs a license — <a href="#license">one sentence below ↓</a></sub>
</p>

<p align="center">
  <img src="docs/images/demo.gif" width="960" alt="OpenWorkBuddy demo: say what you need, the agent does the work and hands you real files">
</p>

---

## Why this one

**Files, not chat logs.** PPT / Word / Excel / HTML are really generated and show up in an output panel you can open. If the model *claims* it wrote a file that isn't on disk, the run is stopped and redone.

**Any model. Your machine.** Switch between DeepSeek / Qwen / GLM / Kimi / OpenRouter / local Ollama with one click. Have **Claude Code or Codex** installed? Use it as the engine and stop buying extra tokens. Self-hosted: sessions, files and API keys stay local; the server binds to `127.0.0.1` by default.

**Adding a capability = dropping one Markdown file.** Save it as `skills/<name>/skill.md` and it's live on the next task — no code, no restart, no build. Beyond that: MCP connectors and the open [Agent Plugins](https://agent-plugins.org) standard — paste a GitHub URL to install someone else's plugin.

## What it does for you

| You say | You get |
|---|---|
| "Build a Q3 review deck from this spreadsheet" | reads → computes → a `.pptx` you can present |
| "Research AI companion apps in China, write a report" | searches → reads each page → Markdown / Word |
| "Turn this material into a page I can read on my phone" | writes HTML → serves it locally → scan the QR |
| "Every day at 9, collect industry news and send it to me on Feishu" | cron + IM push; missed runs catch up |

> Also: parallel tasks, goal-based acceptance, 👍👎 feedback that feeds self-evolution proposals, two-layer memory, permission tiers, remote control over Feishu / QQ / WeChat, a desktop pet… Full list (Chinese): **[功能清单](docs/功能清单.md)**.

## What it looks like

**"Same person, four different scenes, holding a hand-written sign — make it look like a snapshot, not an AI render."**

<p align="center">
  <img src="docs/images/case-photoreal.jpg" width="640" alt="The same person at a cafe window, on a rainy night street, at an office desk and in a morning bedroom, each holding a wooden sign reading 关注 OpenWorkBuddy 项目">
</p>

The hard part isn't drawing a person — it's keeping **the same** person across all four and the Chinese on the sign legible. So it generates one, then actually looks at what it just made (a real vision call on its own output, not a claim from memory), confirms the light and the skin came out right, and fans the rest out from there. No AI watermark on any of them.

**"Build me a Hunan travel guide site — all 14 prefectures, no skipping."**

<p align="center">
  <a href="https://hunan-travel.pages.dev/"><img src="docs/images/case-hunan-site.jpg" width="820" alt="Hunan travel guide — a single-page site built by OpenWorkBuddy"></a>
</p>

It's live, go click around: **<https://hunan-travel.pages.dev/>**. All 14 prefectures written up one by one, plus 3/5/7-day routes. Single-page HTML, no external CDN — drop it on any static host and it's a site. This isn't a mockup screenshot; it's the file it handed over.

How it pulled those off, and what a run on a local Claude Code engine looks like → **[三个案例，拆开讲](docs/案例.md)** (Chinese, but the screenshots speak for themselves)

## Run it in three minutes

**Installer**: grab the package for your OS from [Releases](https://github.com/CatCatUncle/openworkbuddy/releases). A **five-step wizard** on first launch walks you through creating the admin account, pasting an API key (validated with a real request on the spot) and picking an engine.

| OS | File |
|---|---|
| macOS · Apple Silicon | `OpenWorkBuddy-*-mac-arm64.dmg` |
| macOS · Intel | `OpenWorkBuddy-*-mac-x64.dmg` |
| Windows 10/11 (one installer for x64 and ARM64, picks the right one) | `OpenWorkBuddy-*-win-setup.exe` |
| Windows portable (**only if you cannot install software**) | `OpenWorkBuddy-*-win-x64-portable.exe` / `-win-arm64-portable.exe` (it is a self-extractor: every launch unpacks the whole app into `%TEMP%`, so the first start can take several minutes with a process but no window) |

> Your OS will block the first launch: the build has no code-signing certificate (Apple charges $99/year, Windows a few thousand — this is a free open-source project). It is not malware.
> **Windows**: in the SmartScreen dialog click the small grey "More info" → "Run anyway". **macOS**: move the app to `/Applications`, then run `xattr -dr com.apple.quarantine /Applications/OpenWorkBuddy.app`, or go to System Settings → Privacy & Security → "Open Anyway". (Right-click → Open only works on macOS 14 and earlier — Sequoia removed that bypass.)
> Your data lives in `~/OpenWorkBuddy` and survives uninstall.
>
> **Double-clicked and nothing happened?** The boot log is at `~/OpenWorkBuddy/logs/boot.log`; walk through [安装与启动 · 双击了没反应？](docs/安装与启动.md#双击了没反应) (Chinese).

**From source** (Node.js 18+, no build step, no framework — edit, refresh, done):

```bash
git clone https://github.com/CatCatUncle/openworkbuddy.git
cd openworkbuddy && npm install
npm run app     # desktop app; or `npm start` and open http://localhost:3800
```

Then type something like "make a slide deck introducing OpenWorkBuddy". Appearance is yours: avatar menu → **Appearance** for language (中文 / English), theme, six color skins, four font sizes, font family and compact density. Switch to English and the assistant answers in English and writes its files for you in English too; the first-run wizard has the same toggle in its top-right corner. (v1 translates the UI only: step titles pushed from the server and replies inside Feishu / WeChat are still Chinese for now.)

Mirrors, one-line install script, port conflicts, startup hangs → [安装与启动](docs/安装与启动.md) (Chinese).

## Models

**Settings → Models**: pick a provider preset (OpenAI / Anthropic / OpenRouter / Volcano Ark / Bailian / DeepSeek / GLM / Kimi / Ollama), the base URL and protocol are filled in, paste a key, save — hot reload, no restart. Reasoning models can have **thinking turned off or dialed down** from the UI. Base URLs and model names per provider: [配置模型](docs/配置模型.md) (Chinese).

> `config.json` is the only file holding API keys and is already in `.gitignore`. Don't commit it.

## Put it on a server for your team

One command on a clean VPS that already has Docker:

```bash
git clone https://github.com/CatCatUncle/openworkbuddy.git && cd openworkbuddy
bash deploy.sh                              # binds 127.0.0.1:3800
bash deploy.sh --domain buddy.example.com   # or: automatic HTTPS, reachable from outside
```

It builds the image, starts the container and **waits for the health check to actually pass** before
claiming success; if it won't start you get the logs, not a happy message. All data sits in `./wb-data`
(config, accounts, output files, skills, backups) — delete the container freely, keep that directory.

**Register the admin account first thing.** The first account to register becomes the admin, and
self-registration is closed right after. An empty instance on a public IP means whoever gets there
first is your admin.

**Multi-tenant + admin console**: one process serves several companies. Output files, sessions,
accounts, seats, usage ledgers and audit logs are invisible across tenants; engines and API keys
belong to the platform admin. The four org-level switches (`allow_shell` / `net_allow` / `net_deny` /
`session_days`) really do block — they are not decorative checkboxes.

Reverse proxy, upgrades, migration, security checklist → [deploy/README.md](deploy/README.md) (Chinese)

## Command line

`wb` shares the desktop app's config, skills, memory and connectors. Answers go to stdout, so it fits into any pipe, script or cron job:

```bash
npm link                                   # once: install `wb` globally
wb "write my weekly report"                # one-shot: exit code 0/1 tells the truth
cat error.log | wb "what is this error"    # pipe: stdin becomes attached material
wb --json "summarize this meeting" | jq -j 'select(.type=="text") | .delta'   # NDJSON events for scripts
wb engines && wb engines use claude-code   # use a local Claude Code / Codex as the engine
```

`-q` answer only, `-c` continue the last session, `-C <dir>` working directory, `wb sessions` lists sessions. Everything → [命令行用法](docs/命令行用法.md) (Chinese).

## What's new

- **Sep 13** It can shoot a story now: the shot list goes to you for a yes first, then character portraits, an opening frame per shot, video, voice, and one captioned vertical cut; change a shot and only that shot costs again
- **Sep 13** Point it at an SMTP server and the agent emails the report it just wrote; a recipient allowlist is a hard gate, and every message shows you the full text before it leaves
- **Sep 13** The agent schedules its own recurring work: say "every Monday 9am, turn last week's numbers into a table" once and it runs on time
- **Sep 13** Recordings, meeting videos and voice notes turn into text, and it writes the minutes straight from there
- **Sep 13** Read the Word / Excel / PPT / PDF a client sent you, pull material straight from the shared library, and push a finished file to your group chat in one line
- **Sep 13** Every step now shows how long it took, and a closing tally: tool time vs. model-thinking time
- **Sep 13** Plug in Langfuse and you can read the raw input/output of every model call
- **Sep 11** Sidebar splits work into **Office / Engineering**; a `wb` run in your terminal shows up on your phone and takes interjections
- **Sep 11** Image / video / voice / vision each take several models, and one provider key covers all of them
- **Sep 11** Six ways the app could fail to open on launch, each now explained in a real window, plus a boot log
- **Sep 10** One command to deploy: `bash deploy.sh`, and `--domain` gets you HTTPS
- **Sep 10** Multi-tenant + admin console: 16 panels; admins, auditors and members each see their own slice
- **Sep 8** Local Claude Code / Codex as the engine, with memory, skills, files and media wired in

Older entries: **[CHANGELOG.en.md](CHANGELOG.en.md)**. The matching code is in the [commit log](https://github.com/CatCatUncle/openworkbuddy/commits/main) — every message says *why*.

## ⚠️ This agent has a shell

It runs commands, reads and writes files, reaches the network — so the gates are real: command approval, file blocklist, URL allowlist, audit log, four permission tiers. **Read [安全](docs/安全.md) before exposing it beyond localhost.** Defaults are tuned for a single machine.

## Contributing

**Made it this far and it looks useful? Star it.** There is no marketing budget; discoverability is that number.

**Broke it? Stuck? Open an [issue](https://github.com/CatCatUncle/openworkbuddy/issues/new) — even one line of error text helps.** Strip your API keys first.

Three ways in, smallest first:

- **10 minutes** — write a skill: one Markdown file at `skills/<name>/skill.md`, live on save. Template in [CONTRIBUTING.md](CONTRIBUTING.md)
- **1 hour** — add a provider preset, fix a doc, add a preview for a file type
- **One evening** — pick an issue. `npm install && npm start` runs it; `npm test` is green without any API key

Structure, tests and PR conventions: [CONTRIBUTING.md](CONTRIBUTING.md) (Chinese; PRs in English are welcome). No need to ask first — just send the PR.

Community chat is on Feishu (Lark): the QR code is in the [Chinese README](README.md#交流群).

## License

One sentence: **personal, learning and non-profit use is free; making money with it (including internal use at a company) requires a commercial license from the author.**
The license is [PolyForm Noncommercial 1.0.0](LICENSE); what counts as commercial and how to get in touch: [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md).

Copyright (c) 2026 开发者猫叔 (CatCatUncle)

## Disclaimer

This is an independent open-source implementation of the product shape of Tencent's WorkBuddy. It is not affiliated with Tencent and contains none of its code or assets. "WorkBuddy" is a trademark of its owner.
