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
  <a href="#run-it-in-30-seconds"><b>⚡ Run it in 30 seconds</b></a> ·
  <a href="https://github.com/CatCatUncle/openworkbuddy/releases">Download</a> ·
  <a href="#whats-new">What's new</a> ·
  <a href="docs/功能清单.md">Feature list (zh)</a>
</p>

<p align="center">
  <a href="https://github.com/CatCatUncle/openworkbuddy/stargazers"><img src="https://img.shields.io/github/stars/CatCatUncle/openworkbuddy?style=flat-square&logo=github&label=Star&color=5b5ff7" alt="Star"></a>
  <a href="https://github.com/CatCatUncle/openworkbuddy/forks"><img src="https://img.shields.io/github/forks/CatCatUncle/openworkbuddy?style=flat-square&logo=github&color=5b5ff7" alt="Fork"></a>
  <img src="https://img.shields.io/badge/Node-18%2B-5b5ff7?style=flat-square" alt="Node 18+">
  <img src="https://img.shields.io/badge/macOS%20%7C%20Windows-desktop-5b5ff7?style=flat-square" alt="macOS | Windows">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-PolyForm%20NC-5b5ff7?style=flat-square" alt="License"></a>
</p>

<p align="center">
  <b>⭐ If this is useful, star it</b> — there is no marketing budget; discoverability is that number.<br>
  <sub>Free for personal, learning and non-profit use. Commercial use needs a license — <a href="#license">one sentence below ↓</a></sub>
</p>

<p align="center">
  <img src="docs/images/demo.gif" width="960" alt="OpenWorkBuddy demo: say what you need, the agent does the work and hands you real files">
</p>

---

## Why this one

**Files, not chat logs.** PPT / Word / Excel / HTML are really generated and show up in an output panel you can open. If the model *claims* it wrote a file that isn't on disk, the run is stopped and redone.

**Any model. Your machine.** Switch between DeepSeek / Qwen / GLM / Kimi / OpenRouter / local Ollama with one click. Have **Claude Code or Codex** installed? Use it as the engine and stop buying extra tokens. Self-hosted: sessions, files and API keys stay local; the server binds to `127.0.0.1` by default.

**Adding a capability = dropping one Markdown file.** Put a `SKILL.md` into `skills/` and it's live on the next task — no code, no restart, no build. Beyond that: MCP connectors and the open [Agent Plugins](https://agent-plugins.org) standard — paste a GitHub URL to install someone else's plugin.

## What it does for you

| You say | You get |
|---|---|
| "Build a Q3 review deck from this spreadsheet" | reads → computes → a `.pptx` you can present |
| "Research AI companion apps in China, write a report" | searches → reads each page → Markdown / Word |
| "Turn this material into a page I can read on my phone" | writes HTML → serves it locally → scan the QR |
| "Every day at 9, collect industry news and send it to me on Feishu" | cron + IM push; missed runs catch up |

> Also: parallel tasks, goal-based acceptance, 👍👎 feedback that feeds self-evolution proposals, two-layer memory, permission tiers, remote control over Feishu / QQ / WeChat, a desktop pet… Full list (Chinese): **[功能清单](docs/功能清单.md)**.

## Run it in 30 seconds

**Installer**: grab the package for your OS from [Releases](https://github.com/CatCatUncle/openworkbuddy/releases). A **five-step wizard** on first launch walks you through creating the admin account, pasting an API key (validated with a real request on the spot) and picking an engine.

| OS | File |
|---|---|
| macOS · Apple Silicon | `OpenWorkBuddy-*-mac-arm64.dmg` |
| macOS · Intel | `OpenWorkBuddy-*-mac-x64.dmg` |
| Windows 10/11 (one installer for x64 and ARM64, picks the right one) | `OpenWorkBuddy-*-win-setup.exe` |
| Windows portable (no install; USB stick / locked-down PCs) | `OpenWorkBuddy-*-win-x64-portable.exe` / `-win-arm64-portable.exe` (not sure which CPU? `-win-portable.exe` bundles both, twice the size) |

> macOS will say "cannot verify the developer" — the build isn't signed with a paid Apple certificate, it isn't malware. Right-click → Open, or `xattr -cr /Applications/OpenWorkBuddy.app`. Your data lives in `~/OpenWorkBuddy` and survives uninstall.

**From source** (Node.js 18+, no build step, no framework — edit, refresh, done):

```bash
git clone https://github.com/CatCatUncle/openworkbuddy.git
cd openworkbuddy && npm install
npm run app     # desktop app; or `npm start` and open http://localhost:3800
```

Then type something like "make a slide deck introducing OpenWorkBuddy". Appearance is yours: avatar menu → **Appearance** for language (中文 / English), theme, six color skins, four font sizes, font family and compact density. Switch to English and the assistant answers in English and writes its files for you in English too; the first-run wizard has the same toggle in its top-right corner. (v1 translates the UI only: step titles pushed from the server and replies inside Feishu / WeChat are still Chinese for now.)

Mirrors, one-line install script, port conflicts, startup hangs → [安装与启动](docs/安装与启动.md) (Chinese).

## Models

**Settings → Models**: pick a provider preset (OpenAI / Anthropic / OpenRouter / Volcano Ark / Bailian / DeepSeek / GLM / Kimi / Ollama), the base URL and protocol are filled in, paste a key, save — hot reload, no restart. Reasoning models can have **thinking turned off or dialed down** from the UI.

> `config.json` is the only file holding API keys and is already in `.gitignore`. Don't commit it.

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

- **Sep 10** WeChat / WeCom / Official Accounts / QQ can finally receive **files, images, voice notes and stickers** (only Lark could before; every other channel just said "not downloaded in this build"). Lark itself gained voice, stickers and rich-text posts, which used to be dropped whole
- **Sep 10** Lark **"create an app by QR"**: with lark-cli installed locally it registers a brand-new app for you and fills in the App ID / Secret — you type nothing. Also fixes the real reason Lark kept disconnecting: saving any other channel wiped the stored Lark secret
- **Sep 10** Settings → About → **Check for updates**: tells you how to upgrade based on how you installed (source checkout vs. installer), and says plainly when it cannot reach GitHub instead of pretending you are up to date
- **Sep 9** Finishing a task no longer pops the preview / files panel over your chat: the conclusion stays inline, outputs are a row of compact chips (icon, name, size, preview / reveal / download), the Files button shows a badge; only a preview you already have open on that file refreshes in place
- **Sep 9** Connectors page ships a catalog of **39 one-click presets** (search, databases, Lark, AMap, GitHub…); you only fill in the key, and a missing key blocks the save. **15 more experts and 4 teams**; upgrades add new built-ins without touching your edits
- **Sep 9** Demo recorder masks temp dirs, username, hostname and bot ids on screen, with a self-check before recording
- **Sep 9** English / Chinese toggle: one click in Appearance or the first-run wizard, whole UI flips instantly, AI replies follow
- **Sep 9** Appearance page: theme, six skins, four font sizes, font family, compact density
- **Sep 8** First-run wizard: model, engine and IM set up in five steps, no docs required
- **Sep 8** Local **Claude Code / Codex** as the engine, with memory, skills, file access and image/voice generation wired in; per-engine model and thinking level
- **Sep 8** Thinking can be switched off or dialed down for reasoning models; the CLI follows the app setting
- **Sep 8** Conversation trail bar + 👍👎 feedback loop: mistakes become self-evolution proposals, applied only after a human approves
- **Sep 7** Scheduled tasks get a "false green" verdict: no exception ≠ done
- **Sep 5** `wb` CLI: one-shot, interactive, pipes, `--json`
- **Sep 3** In-app preview for docx / xlsx / pptx / zip / csv
- **Aug 31** Paste or drag files and images into the chat; the agent actually reads the image

Full history in the [commit log](https://github.com/CatCatUncle/openworkbuddy/commits/main) — every message says *why*.

## ⚠️ This agent has a shell

It runs commands, reads and writes files, reaches the network — so the gates are real: command approval, file blocklist, URL allowlist, audit log, four permission tiers. **Read [安全](docs/安全.md) before exposing it beyond localhost.** Defaults are tuned for a single machine.

## Contributing

**Broke it? Stuck? Open an [issue](https://github.com/CatCatUncle/openworkbuddy/issues/new) — even one line of error text helps.** Strip your API keys first.

Three ways in, smallest first:

- **10 minutes** — write a skill: one Markdown file in `skills/`, live on save. Template in [CONTRIBUTING.md](CONTRIBUTING.md)
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
