<p align="center">
 <img src="build/icon.png" width="120" alt="OpenWorkBuddy">
</p>

<h1 align="center">OpenWorkBuddy</h1>

<p align="center">
 <b>An AI office assistant that runs on your own machine.</b><br>
 Ask for something once; it plans, does the work, checks it, and leaves a real<br>
 PPT / Word / Excel / web page on your disk — <b>a file you can open, not a chat log.</b>
</p>

<p align="center">
 <sub><a href="README.md"><b>中文</b></a> · English</sub>
</p>

<p align="center">
 <a href="#run-it-in-three-minutes"><b>▶&nbsp;Run it in three minutes</b></a>
 &nbsp;·&nbsp; <a href="https://github.com/CatCatUncle/openworkbuddy/releases">Download</a>
 &nbsp;·&nbsp; <a href="docs/功能清单.md">Feature list (zh)</a>
 &nbsp;·&nbsp; <a href="#docs">Docs</a>
 &nbsp;·&nbsp; <a href="README.md#交流群">Feishu group</a>
 &nbsp;·&nbsp; <a href="CHANGELOG.en.md">Changelog</a>
</p>

<p align="center">
 <a href="https://github.com/CatCatUncle/openworkbuddy/stargazers"><img src="https://img.shields.io/github/stars/CatCatUncle/openworkbuddy?style=flat-square&logo=github&label=Star&color=5b5ff7" alt="Star"></a>
 <a href="LICENSE"><img src="https://img.shields.io/badge/License-PolyForm%20NC-5b5ff7?style=flat-square" alt="License"></a>
 <a href="docs/功能清单.md"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FCatCatUncle%2Fopenworkbuddy%2Fmain%2Fdocs%2Fstats.json&query=%24.skills&label=Skills&color=5b5ff7&style=flat-square" alt="Skills"></a>
 <a href="docs/功能清单.md"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FCatCatUncle%2Fopenworkbuddy%2Fmain%2Fdocs%2Fstats.json&query=%24.tools&label=Tools&color=5b5ff7&style=flat-square" alt="Tools"></a>
 <a href="docs/功能清单.md"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FCatCatUncle%2Fopenworkbuddy%2Fmain%2Fdocs%2Fstats.json&query=%24.connectors&label=Connectors&color=5b5ff7&style=flat-square" alt="Connectors"></a>
 <a href="docs/功能清单.md"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FCatCatUncle%2Fopenworkbuddy%2Fmain%2Fdocs%2Fstats.json&query=%24.experts&label=Experts&color=5b5ff7&style=flat-square" alt="Experts"></a>
</p>

<p align="center">
 <sub>Free for personal, learning and non-profit use. Commercial use needs a license — <a href="#license">one sentence below ↓</a></sub>
</p>

<p align="center">
 <img src="docs/images/demo.gif" width="960" alt="OpenWorkBuddy demo: say what you need, the agent does the work and hands you real files">
</p>

---

## You say it, it hands you the file

| You say | You get |
|---|---|
| "Build a Q3 review deck from this spreadsheet" | reads → computes → a `.pptx` you can present |
| "Research AI companion apps in China, write a report" | searches → reads each page → Markdown / Word |
| "Turn this material into a page I can read on my phone" | writes HTML → serves it locally → scan the QR |
| "Every day at 9, collect industry news and send it to me on Feishu" | cron + IM push; missed runs catch up |

<p align="center">
 <img src="docs/images/how-it-works.en.svg" width="1190" alt="Ask once; OpenWorkBuddy plans, executes and verifies, and hands back PPTX / DOCX / XLSX / HTML files">
</p>

> [!NOTE]
> Also: parallel tasks, goal-based acceptance, 👍👎 feedback that feeds self-evolution, two-layer memory, permission tiers, remote control over Feishu / WeChat, a desktop pet… Full list (Chinese): **[功能清单](docs/功能清单.md)**.

## Why this one

<table>
<tr>
<td width="50%" valign="top">

<b>📄 The files are real.</b>

Decks, documents, spreadsheets and pages are actually generated — open them from the output panel and check. Claim a file was written when it isn't on disk and the run gets stopped and redone.

</td>
<td width="50%" valign="top">

<b>🔌 Swap models freely; everything stays yours.</b>

DeepSeek / Qwen / GLM / Kimi / OpenRouter / Ollama switch with one click. Already have <b>Claude Code or Codex</b> on this machine? Use it as the engine — no second token bill. Sessions, files and keys never leave your disk; it listens on <code>127.0.0.1</code> by default.

</td>
</tr>
<tr>
<td width="50%" valign="top">

<b>🧩 Adding a capability = dropping one Markdown file.</b>

Save it as <code>skills/&lt;name&gt;/skill.md</code> and it's live on the next task — no code, no restart, no build.

</td>
<td width="50%" valign="top">

<b>🔍 It's also a readable agent.</b>

Model routing, tool calls, file acceptance, memory, permissions and local traces all live in one repo: for any real task you can see why it did what it did, which model it used, and what it finally handed over.

</td>
</tr>
</table>

## Run it in three minutes

All three routes are the full product; none of them is a cut-down edition.

**macOS, one line** (downloads, installs into `/Applications`, strips the quarantine flag, opens it):

```bash
curl -fsSL https://raw.githubusercontent.com/CatCatUncle/openworkbuddy/main/install-mac.sh | bash
```

> ⚠️ **If you download the dmg by hand, the first launch will be blocked**: *"OpenWorkBuddy" Not Opened — Apple could not verify …*, with only **Done** and **Move to Trash** on the dialog.
> That is Apple's blanket block on apps without a paid certificate, not a verdict about this build — the certificate is being applied for, and this step disappears once it comes through.
> **Click Done → System Settings → Privacy & Security → scroll to the bottom → Open Anyway → enter your login password.** Once, and never again.
> The `curl` line above has no dialog at all. Full three-route walkthrough below, under "Your OS blocks the first launch".

**Windows / manual download**: grab `-win-setup.exe` from [Releases](https://github.com/CatCatUncle/openworkbuddy/releases) (one installer for x64 and ARM64) and double-click; on a locked-down work machine take the portable build, `-win-x64-portable.exe` (`arm64` on ARM).

**From source** (Node.js 18+, no build step, no framework — edit, refresh, done):

```bash
git clone https://github.com/CatCatUncle/openworkbuddy.git
cd openworkbuddy && npm install
npm run app # desktop app; or `npm start` and open http://localhost:3800
```

Paste a model API key on first launch, then type something like "make a slide deck introducing OpenWorkBuddy".
Everything you own lives in `~/OpenWorkBuddy` — config, sessions, output files, skills. **Uninstalling doesn't delete it**; moving machines is a folder copy.

Text too small, or want a different skin? Avatar menu, top right → **Appearance**: four text sizes, five themes and UI density all live on that page.

<details open>
<summary><b>Your OS blocks the first launch · double-clicked and nothing happened</b></summary>

<br>

The code-signing certificate is still being applied for (Apple charges $99/year, Windows a few thousand), so today's builds are ad-hoc signed. What the OS blocks is *"I have never seen this developer"* — **not** *"this file is malware"*. The signature inside the build is intact; `codesign --verify --deep --strict` confirms it.

**macOS — pick one of three**

1. **Without touching a terminal (recommended)**: double-click → click **Done** on the dialog (*not* Move to Trash) → open **System Settings → Privacy & Security** → scroll all the way down to the **Security** section, where it says *"OpenWorkBuddy" was blocked to protect your Mac* → click **Open Anyway** → enter your login password → confirm with **Open**. Once, and never again.
2. **One command**: **first drag the .app out of the dmg into Applications** (the dmg is a read-only volume, so running this inside it fails), then
   ```bash
   xattr -dr com.apple.quarantine /Applications/OpenWorkBuddy.app
   ```
3. **No dialog at all**: use the `curl` line at the top. A browser-downloaded file gets tagged `com.apple.quarantine`; a curl-fetched one doesn't, so Gatekeeper never enters the picture.

> **Don't follow the old "right-click → Open" tutorials.** That route only works on macOS 14 and earlier — Apple removed it in macOS 15 (Sequoia), and the right-click dialog no longer has a second **Open** button, which is exactly why it reads as "it just won't open".
>
> If the message says **"is damaged and can't be opened"** rather than *could not be verified*, the signature really was corrupted — cloud drives, sync folders and some unzip tools all do this. Download again, or re-sign in place with `codesign --force --deep --sign - /Applications/OpenWorkBuddy.app`.

**Windows**: in the SmartScreen dialog click the small grey "More info" → "Run anyway".
- **Nothing happened**: the boot log is at `~/OpenWorkBuddy/logs/boot.log` — wherever it stops is the problem. Running from source, try `node cli.js doctor` first. Walk-through → [安装与启动](docs/安装与启动.md#双击了没反应) (Chinese)

</details>

Mirrors, port conflicts, moving the data directory → [安装与启动](docs/安装与启动.md)　|　moving machines → [数据同步与搬家](docs/数据同步与搬家.md) (Chinese)

## What it looks like

**"Same person, four different scenes, holding a hand-written sign — make it look like a snapshot, not an AI render."**

<p align="center">
 <img src="docs/images/case-photoreal.jpg" width="640" alt="The same person at a cafe window, on a rainy night street, at an office desk and in a morning bedroom, each holding a wooden sign reading 关注 OpenWorkBuddy 项目">
</p>

The hard part isn't drawing a person — it's keeping the same person across all four and the Chinese on the sign legible. So it generates one, then actually looks at what it just made (a real vision call on its own output, not a claim from memory), and fans the rest out from there.

**"Build me a Hunan travel guide site — all 14 prefectures, no skipping."**

<p align="center">
 <a href="https://hunan-travel.pages.dev/"><img src="docs/images/case-hunan-site.jpg" width="860" alt="Hunan travel guide: the ink-wash landing screen, and the index of all 14 prefectures grouped by region"></a>
</p>

**<https://hunan-travel.pages.dev/>** — it's live, go click around. One HTML file plus a folder of images, no external CDN. Drop it on any static host and it's a site. Not a mockup — the thing it actually handed over.

**"Every morning at seven, send me today's weather and what I should watch out for, on Feishu."**

<p align="center">
 <img src="docs/images/case-schedule-feishu.jpg" width="820" alt="A scheduled OpenWorkBuddy task pushing a morning briefing to Feishu: today's weather and UV, tomorrow's rain, plus two things worth doing today">
</p>

One sentence set this up. It runs whether or not anyone is at the machine, and every run keeps its full transcript under Automation → Run history. Feishu / WeCom / DingTalk / Telegram all take the same path.

How it pulled those off → **[三个案例，拆开讲](docs/案例.md)** (Chinese, but the screenshots speak for themselves)

## AI short-drama infinite canvas

Script, characters, scenes, shots, reference images, video, voice and the edit timeline all sit on one canvas. The wires aren't decoration — they are what the next generation actually reads for character, first frame and sound. Change one shot and only that shot re-runs.

<p align="center">
 <img src="docs/images/case-canvas.jpg" width="960" alt="OpenWorkBuddy infinite canvas: character sheet, location plate and shot first-frames on one board, with purple wires labelled 「生成」 pointing at what the next generation actually reads">
</p>

Open "Infinite canvas" in the left sidebar. Drag empty space to pan, `Shift`+drag to marquee-select, `Shift`/`⌘`+click to add or drop nodes from the selection, and `@` any node or asset from the chat box at the bottom.

## Put it on a server for your team

One command on a clean VPS that already has Docker:

```bash
git clone https://github.com/CatCatUncle/openworkbuddy.git && cd openworkbuddy
bash deploy.sh --domain buddy.example.com # automatic HTTPS, reachable from outside
```

It **waits for the health check to actually pass** before claiming success; if it won't start you get the logs. All data sits in `./openworkbuddy-data`.

> [!IMPORTANT]
> **Register the admin account first thing.** The first account to register becomes the super admin (one per org, transferable but never issuable), and self-registration closes right after. An empty instance on a public IP means whoever gets there first owns it.

One process serves several companies, invisible to each other. Avatar menu → **Admin console**: orgs, seats, usage, security policy. New hires are created from a department template (role and monthly credits in one go); when someone leaves, one click closes five doors at once — paired devices, **their scheduled jobs** (the scheduler doesn't go through the login gate, so disabling the account alone leaves them running on the company's credits), unused invite codes, 2FA, and tasks still running. **Revoke access, keep the data**, and you get a receipt you can paste into the handover doc.

One metrics snapshot per minute, threshold breaches pushed to WeCom / DingTalk, and `/api/ops/metrics.prom` for your existing monitoring — behind the platform-owner check like every other endpoint.

Reverse proxy, upgrades, migration, security checklist → [部署](docs/部署.md)　|　[deploy/README.md](deploy/README.md)　|　[多人协作](docs/多人协作.md) (Chinese)

## Models

**Settings → Models**: pick a provider preset (OpenAI / Anthropic / OpenRouter / Volcano Ark / Bailian / DeepSeek / GLM / Kimi / Ollama), the base URL and protocol are filled in, paste a key, save — hot reload, no restart. A mispasted key is caught on save and it tells you which character is wrong, instead of handing you an unreadable 401 later. Reasoning models can have thinking turned off or dialed down from the UI.

Image / speech / video models have their own table; video spans five protocols (Tongyi Wanxiang · Volcano Ark Seedance · GLM CogVideoX · MiniMax Hailuo · SiliconFlow), and if it cannot tell which vendor it is, **it does not send the request** — video bills per clip and a wasted call takes minutes to fail.

Per-provider table → [配置模型](docs/配置模型.md) (Chinese)

> [!IMPORTANT]
> `config.json` is the only file holding API keys and is already in `.gitignore`. Don't commit it.

## Command line

`openworkbuddy` shares **one** set of config, skills, memory, connectors and sessions with the desktop app — start something in the terminal and you can watch it and chime in from your phone; stop halfway on the desktop and `openworkbuddy resume` picks it up.

```bash
npm link # once: install the global command (or just run `node cli.js …`)

openworkbuddy "write my weekly report" # one-shot: runs and exits
openworkbuddy # interactive: type / for the command menu
cat error.log | openworkbuddy "what is this" # pipe: stdin becomes material
openworkbuddy -q "write my weekly report" > report.md # just the report, no progress bars
```

One-shot and pipe mode **never** ask you questions, so scripts and cron don't hang. Exit codes mean something: `0` success, `1` task failed, `2` bad arguments, `130` Ctrl+C — so `openworkbuddy doctor && npm start` stops a misconfigured machine before it starts.

`sessions` / `resume` / `engines` / `doctor` / `pair` (QR-pair your phone) / `worktree`, plus `--mode` `--perm` `-C` `-f` `--json` and the rest → **[命令行用法](docs/命令行用法.md)** (Chinese)

## How it's put together

```mermaid
flowchart TB
 subgraph Entry["Your devices"]
 Desktop["Desktop / Web"]
 CLI["openworkbuddy CLI"]
 IM["Feishu / WeChat and other remote entries"]
 end

 Entry --> Runtime["OpenWorkBuddy local runtime\nsessions · permissions · projects · API"]
 Runtime --> Agent["Agent orchestration\nplanning · tool calls · file acceptance"]
 Agent <--> Models["Model routing\ncloud LLM / Ollama / Claude Code / Codex"]
 Agent <--> Capabilities["Capabilities\nMarkdown Skills · experts · MCP · plugins"]
 Agent <--> Workspace["Local workspace\nfiles · assets · project context · memory"]
 Agent --> Canvas["Executable infinite canvas\nscript · characters · shots · assets · timeline"]
 Agent --> Trace["Local trace\nmodel · tools · latency · tokens · I/O"]
 Trace -. optional .-> Langfuse["Langfuse"]
```

The diagram doubles as a reading order: start at `server.js`, then see how `agent.js` orchestrates models and tools. Details → [实现细节](docs/实现细节.md) (Chinese)

## What's new

- **Sep 20** **Three silent data losses on the infinite canvas**: nodes titled 「开始工作」 or 「开始创作」 were dropped on every load and sync, edges with them (3 nodes + 2 edges in, 1 node and 0 edges out, in the local copy and on the server both); a snapshot pulled from the server was written straight back, so two open tabs shove each other every 1.8s and copy a .bak each time; and select 3 nodes, sync once, and only 1 is still selected — the next Delete removes something else. The canvas had no tests at all; the new test/canvas.js goes 6 pass / 9 fail to 16 / 0
- **Sep 20** **In English the library page was a wall of Chinese** — and it's why v0.7.0 shipped no installers: the release stopped at the test job, the CI machine runs in English, and the assertions were written against Chinese copy. The page is in the dictionary now (22 text runs + 15 attributes, including the paragraph explaining what "new folder" is for), behind a new gate: render the page, switch to English, count the Chinese left on screen
- **Sep 20** **You can delete from the library now, and the page says what "new folder" is for**: it used to mix the reference material you upload with the outputs a task writes, with "New folder / Upload" floating above both. The sections are now separate, those buttons live in the reference one, and the empty state says it outright — a project can mount just one folder so its agent sees only that slice and never wanders into another client's material. Folders and files each get a trash icon (the outputs section deliberately has none), the confirmation focuses Cancel, and a non-empty folder gets no Delete button
- **Sep 20** **Three more admin-console responses were still growing with headcount — 678 / 491 / 631 KB per trip, now 11 / 12 / 9 KB**: the usage-detail page shipped a per-person rollup, the relay-key page shipped the per-person API cap table, and the stats page computed every member's role, quota and balance to read one integer. Member usage and per-person caps each got their own endpoint, 50 per page, filtered and sorted and paged on the server
- **Sep 20** **One tenant's ordinary activity could wipe another tenant's audit trail**: every org's entries lived in one shared array, trimmed to 1,000 on save. Measured, tenant B's 21 entries were evicted without a trace by tenant A's 1,200 ordinary operations, and the console read "0 entries" — indistinguishable from an org where nothing ever happened. Each org now has its own `data/audit/<org id>.jsonl` and no one can evict anyone, which also takes `getOrg()` from 45.57ms back to 0.02ms (audit used to sit on the hot path, parsed in full at all 37 call sites). Two lies in the UI went with it: a full book now says "retention limit reached" instead of "every action since this org was created," and export pulls the whole filtered range rather than the 50 rows on screen
- **Sep 20** **Nine silent failures when reading Office documents**: trailing Excel rows and columns dropped (`actualRowCount` counts non-empty rows, it is not the last row's index) while still reporting "not truncated"; formula cells blank; merged titles repeated four times across; PowerPoint slides built with `addChart` reading back completely empty; Word ordered lists indistinguishable from bullets, hyperlink URLs dropped, headers and footers never read. Only http/https/mailto are linked now, so a `javascript:` hyperlink inside an inbound `.docx` is no longer a clickable entry point
- **Sep 20** **You can right-click-copy on the boot-failure page now**: it says "paste this line into an issue", but the context menu was wired after the server `require` — which on a failed boot *is* the throw site, so the one page you most need to copy from was the one page you couldn't, short of copying it off the screen by hand. "File an issue" now opens your own browser instead of a chrome-less window inside the app, and the GPU tip names the real path to `config.json` instead of leaving you to guess where your home directory is
- **Sep 20** **When it won't open, the screen now says how to fix it instead of "file an issue"**: missing dependencies → `npm install`, an installed build missing files → re-download from Releases, Node too old → get the LTS build. The gate already diagnosed all three; the window used to re-guess from English keywords, so every one of them fell through to the paste-this-into-an-issue catch-all
- **Sep 20** **A missing package now says which one, and how many in total**: the dependency list is no longer hand-written (it had stalled at 3 while `package.json` declares 13), and past three names it appends the total — "the whole install failed" and "one package is missing" used to look identical on screen, and they call for different actions
- **Sep 20** In settings, **asking a provider for models and getting none back no longer makes the line of text vanish**: a local Ollama now tells you which `ollama pull` to run and roughly how big it is, and reopening the dropdown after the pull really asks again (that empty answer is no longer cached); a cloud provider returning nothing is a different story and says so; and a request that never went out gets a sentence of its own
- **Sep 20** Fetching a page is **no longer a pointless multiple-choice question**: `render_page` is folded into `fetch_url`'s `render:"force"` — they were always the same code, and two names in the list only made the model choose every time. The old name still works, and external CLI engines are still lent it
- **Sep 20** Connecting a **local Ollama now lets you pick the model**: the wizard asks your machine what it has (`/v1/models`) and lists it. The template's default is pre-selected only if you actually have it; anything missing goes in via "type it in". If Ollama isn't running it tells you to `ollama serve` then `ollama pull`, with an "ask again" link for when you come back. The model you pick is the one probed, and a failed probe leaves your working config untouched. The offline fallback dropped from `qwen3:14b` (~9GB) to `qwen3:8b` (~5GB)
- **Sep 20** macOS users on an installed build **are no longer sent back to a fresh dmg** when they update (which would hit "Apple could not verify" all over again): the first thing offered is the zero-dialog `curl`, drawn as its own monospace line with a copy link, and shown only when there really is a newer version
- **Sep 20** Drag or paste a file into the composer and **the chip is there the instant you let go** (it used to wait for the upload — 124ms of blank on a 4MB clip, long enough that people drop it twice). Chips carry the file size, delete and open are real buttons, and clicking the name opens that file. A failed upload withdraws its text anchor and leaves a retry button; hitting send mid-upload is held. Duplicate files and dropped folders, both silent failures before, now say so.
- **Sep 20** On macOS, **the "Apple could not verify" dead-end dialog now comes with the way out, everywhere**: the dmg window itself shows Done → System Settings → Privacy & Security → scroll to the bottom → Open Anyway, and the README, the install doc and all 7 published releases say the same, with the no-terminal route first. The certificate is still in review; this step disappears once it lands.
- **Sep 20** Card text **stops being covered, and stops being sliced in half**: the reason a connector won't connect used to render as a tag pill, so only a slice from the middle survived — it's a block of red text now, three lines with a one-click expand. Every “show a few lines” box — command text, canvas node bodies — now caps on a whole line instead of cutting the last one through the glyphs, and the corner badge no longer sits on top of the title
- **Sep 20** **35 built-in skills, 52 connectors**: ten new skills — competitor watch, market research, spreadsheet analysis, one-draft-many-platforms, customer feedback, SEO briefs, financial models, podcasts, infographics, sales outreach; connectors now include Linear, Jira / Confluence, Sentry, Vercel, Figma, Airtable, Asana, Canva, Apify, YouTube, AntV charts, EdgeOne one-click deploy and Bilibili
- **Sep 20** The real browser **now leaves when you're done with it**: closed after ten idle minutes, taken down with the process that started it, or closed on demand — and the whole process group goes, not just the parent. One was left running for ten and a half hours with its GPU process at 160% CPU
- **Sep 20** macOS refused to open the downloaded build; one command routes around it: `curl -fsSL .../install-mac.sh | bash` — a curl'd file carries no quarantine flag, so there is no dialog at all
- **Sep 20** The infinite canvas **can select a whole area now**: Shift / ⌘ to add or drop, a visible marquee toggle in the toolbar, ⌘A for all, Delete to remove them together. The box used to draw and highlight fine, and then Delete did nothing — focus never landed on the canvas
- **Sep 20** Diagrams **no longer come out as SVG with no PNG** (Feishu docs and Word only take PNG): the image hits the disk in two seconds, Chrome just hangs around afterwards, and the old code waited out the timeout and threw the good image away with it
- **Sep 20** An expanded storyboard progress bar **no longer covers the canvas**, and the floating toolbar moves with it, so the script and character-sheet cells are visible again
- **Sep 20** "N character sheets are on the canvas but gone from disk" **stops crying wolf**: every path is now checked against the disk one by one, and anything unresolvable keeps quiet
- **Sep 19** Eval runs **no longer touch your real memory, preferences or quota ledger**; the task set gained long-haul, multi-turn and memory-recall shapes that a single-turn task can't test
- **Sep 19** When two tasks change the same repo, **the second one goes off into its own git worktree** — not one byte of the tree in front of you moves
- **Sep 19** Permissions rebuilt as **RBAC** with a super-admin tier: manage only a strictly lower tier, and all four routes to minting an admin go through the same check

Older entries → **[Changelog](CHANGELOG.en.md)**.

## ⚠️ This agent has a shell

> [!WARNING]
> It runs commands, reads and writes files and reaches the network — so the gates are real: command approval, a file blacklist, a URL allowlist, audit logs and four permission tiers.
> **Read [安全](docs/安全.md) (Chinese) before exposing it to the internet**; the defaults are tuned for local use only.

**Skills get screened before they're installed.** A skill is a set of instructions written for an agent, handed to something that can run commands on your machine — unlike `npm install`, where a package only runs when you `require` it; a skill is read and followed on its own. So an install runs 34 static rules first and shows you what it found, in three buckets: install / look first / don't install by default (no score — a score just teaches people that "42 looks fine"). Ten of the rules actually block (reverse shells, `curl | bash`, reading SSH private keys, wiping disks, erasing traces); an admin can force past them, and that goes into `.install.json`.

**It is not antivirus.** On a public labelled set, pure static rules catch about three quarters — one in four gets through. Install [toolward](https://github.com/CatCatUncle/toolward) and it's used as a second ruler automatically, merging in a direction that only ever tightens. And the one that matters more than every rule above: **read the `skill.md` yourself before installing.** It's Markdown, not a binary.

How the call is made, and why the force-install hatch stays → [安全](docs/安全.md)　|　[安全基线](docs/安全基线.md) (Chinese)

## Contributing

- **Something broke? [Open an issue](https://github.com/CatCatUncle/openworkbuddy/issues/new)**, even if it's one line of error text. Scrub your API keys first.
- **10 minutes** — write a skill: one Markdown file at `skills/<name>/skill.md`, live on save. [Template](CONTRIBUTING.md#提交一个技能3-分钟)
- **One evening** — pick an issue: `npm install && npm start` runs it, `npm test` goes green without any API key

Project layout, tests and PR conventions are in [CONTRIBUTING.md](CONTRIBUTING.md). No need to open an issue first — send the PR.

## Docs

Most docs are in Chinese; the code and comments are the source of truth.

| Doc | What's in it | Doc | What's in it |
|---|---|---|---|
| [功能清单](docs/功能清单.md) | Every capability, skill and tool | [部署](docs/部署.md) | Server / Docker / reverse proxy |
| [案例](docs/案例.md) | How the pictures above were made | [多人协作](docs/多人协作.md) | Multi-tenant, accounts, quotas |
| [安装与启动](docs/安装与启动.md) | Installers, source, common snags | [安全](docs/安全.md) | Approval gates, allowlists, audit |
| [配置模型](docs/配置模型.md) | base_url / model names per provider | [数据同步与搬家](docs/数据同步与搬家.md) | Where data lives, moving machines |
| [命令行用法](docs/命令行用法.md) | CLI flags, pipes, `--json`, cron | [开源与商业版边界](docs/开源与商业版边界.md) | What a licence actually buys |
| [扩展](docs/扩展.md) | Skills, MCP, plugins, experts | [路线图](docs/路线图.md) | What's next, what counts as done |
| [IM与定时任务](docs/IM与定时任务.md) | Feishu / QQ / WeCom / WeChat / DingTalk | [实现细节](docs/实现细节.md) | How the agent loop actually runs |
| [安全基线](docs/安全基线.md) | Where data lands, who can read it, what isn't covered | [远程访问](docs/远程访问.md) | Reaching your machine from outside; both switches off by default |

## Also by the same author

- **[toolward](https://github.com/CatCatUncle/toolward)** — a static safety check for agent skills and MCP connectors: 37 rules in six families, zero runtime dependencies, Node 20.10+. Run `npm i -g toolward` and OpenWorkBuddy picks it up as a second ruler automatically; skip it and nothing changes. Like this project it is PolyForm Noncommercial.

## License

In one sentence: **personal, learning and non-profit use is free; making money with it (including internal productivity at a company) needs a commercial license from the author.**
The license is [PolyForm Noncommercial 1.0.0](LICENSE); what counts as commercial and how to talk about it is in [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md).

**A license does not unlock features.** There is one codebase — this repo — and you are looking at all of it: the agent loop, 40+ tools, the drama canvas, IM remote control, execution traces, self-evolution and memory, multi-tenancy and the admin console included. No feature flags, no trial countdown, no greyed-out buttons. A license buys three other things: the right to make money with it, trademark and white-label room, and someone to reach → [开源与商业版边界](docs/开源与商业版边界.md) (Chinese)

**Some of it isn't even non-commercial.** Deployment configs, CI pipelines, scripts, the eval set, skill templates and sample code in the docs are additionally released under MIT → [LICENSE-ECOSYSTEM.md](LICENSE-ECOSYSTEM.md). And **skills, plugins and connector configs you write are your own work**, not derivatives of this project.

This license grants **no** rights to any third-party product, trademark, logo, brand asset or screenshot; those belong to their respective owners.

Copyright (c) 2026 开发者猫叔

## Disclaimer

**What this is.** OpenWorkBuddy (repo `CatCatUncle/openworkbuddy`) is an independent open-source project written from scratch by 开发者猫叔; all source is in this repo. Architecture, tool protocol, permission model, memory and self-evolution are original work; projects studied along the way are listed one by one in section 4 of [NOTICE.md](NOTICE.md). The name is `Work` + `Buddy` — two ordinary English words — with the `Open-` prefix common to open-source projects.

**Relationship with third parties: none.** This project is not affiliated with, authorised, sponsored or endorsed by Tencent or its WorkBuddy product, and contains none of its code, assets, UI resources or non-public information. If "WorkBuddy" is someone's registered trademark, the rights belong to its owner; third-party names appear here only to describe compatibility or draw a factual distinction (nominative use). Feishu, WeCom, QQ and the rest are integrated through their own **publicly published** open APIs; no reverse engineering is involved.

**If a rights holder thinks something here is wrong**, reach me through [Issues](https://github.com/CatCatUncle/openworkbuddy/issues) or the contact in [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md) and it will be fixed once verified.

## Support this project

<p align="center">
 <a href="https://github.com/CatCatUncle/openworkbuddy">
 <img src="docs/images/star-guide.svg" width="640" alt="That Star button in the top-right corner — press it">
 </a>
</p>

<p align="center">
 <a href="https://github.com/CatCatUncle/openworkbuddy"><img src="https://img.shields.io/github/stars/CatCatUncle/openworkbuddy?style=for-the-badge&logo=github&label=Star%20this%20repo&color=5b5ff7" alt="Star this repo"></a>
</p>

<p align="center">
 <sub>Pass it to one colleague who hand-builds decks, weekly reports and meeting notes — worth more than a hundred impressions.</sub>
</p>

## Contributors

Thanks to everyone who has changed something here. Want to join them: [CONTRIBUTING.md](CONTRIBUTING.md).

<p align="center">
<a href="https://github.com/CatCatUncle/openworkbuddy/graphs/contributors">
 <img src="https://contrib.rocks/image?repo=CatCatUncle/openworkbuddy" alt="OpenWorkBuddy contributors">
</a>
</p>

## Star history

<p align="center">
<a href="https://star-history.com/#CatCatUncle/openworkbuddy&Date">
 <picture>
 <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=CatCatUncle/openworkbuddy&type=Date&theme=dark">
 <img src="https://api.star-history.com/svg?repos=CatCatUncle/openworkbuddy&type=Date" alt="Star History Chart" width="600">
 </picture>
</a>
</p>
