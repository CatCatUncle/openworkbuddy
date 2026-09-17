# Changelog

One line per change, newest first. The README keeps only the last few; everything is here.

The matching code is in the [commit log](https://github.com/CatCatUncle/openworkbuddy/commits/main) —
each message says *why*, not *which file*, so it reads better than this list.

中文：[CHANGELOG.md](CHANGELOG.md)

## 2026

- **Sep 17** Moving to a new machine is now a closed loop: Settings → Data offers Back up now, Download, Import backup and Restore. A backup carries accounts, organizations, sessions, IM sessions, memory, personal preferences, usage ledgers, audit logs, `config.json`, schedules, experts and the skills you wrote yourself. An imported archive is unpacked and checked before anything touches disk — absolute paths, `..`, symlinks and hard links, non-gzip data and unexpected top-level entries are all refused — and the current state is backed up as `before-restore` first.
- **Sep 17** Send a message while a task is running and you choose what happens: Cut in interrupts the current step for an on-the-spot correction, Queue waits for the run to finish and then starts yours in order. A queued line can be taken back, and the choice is stored per device rather than per account.
- **Sep 17** Per-call paid APIs (search, image, video, voice, transcription) now sit behind a quota gate: ask before going over, record who spent it and through which provider, and read it back by day, month or person in the admin console. Everything is unlimited by default, so a solo user with their own key is unaffected.
- **Sep 17** Admin-console usage can be filtered by date range, member and model, and paged through — no longer just the last 25 rows.
- **Sep 16** Feishu now closes the loop for both group chats and document comments: @ the bot in a group to run a task and receive text/files; @ it in a cloud-document comment to identify the target document, read its context, and reply in the original thread. Fixed the comment-reply request shape that caused `field validation failed`; user instructions and document context are now separated so long documents are not echoed back; de-duplication survives restarts.
- **Sep 15** README now leads with a real deliverable and a copyable first task: the first screen explains local file delivery, then shows a fast path to an initial win plus clear Star and contribution actions. English readers now get explicit local-office, self-hosting and agent-learning positioning; `llms.txt` helps search and AI summaries understand the project correctly. The MIT notice for the DAG layout dependency is complete, and the full suite is green again.
- **Sep 15** Infinite-canvas interaction pass: drag blank space to pan, `Shift`+drag to select, then drag any selected node to move the group. A node body selects without opening properties; only its gear opens settings, so panels no longer interrupt work. The page header is tighter to return more height to the canvas.
- **Sep 15** The README now leads with a sanitized real task demo (input → execution → file preview). The AI short-drama canvas follows the feature overview with its own recording and a sanitized DAG screenshot; the recorder no longer lets a canvas recording replace the README hero demo.

- **Sep 14** AI short-drama infinite canvas reached a usable release: Canvas Agent, DAG links and compact layout, marquee selection / undo / context actions, node properties and asset previews, image enlargement, video and audio playback, workspace switching, @ references, model selection and local Trace now live inside one short-drama project; README adds a real, fully sanitized canvas GIF so contributors can understand it fast.
- **Sep 14** Added AI short-drama infinite canvas mode: scripts, characters, locations, storyboards, media, generated results and this project's Agent collaborate on one executable canvas, with multiple drama projects, asset drops, batch selection, auto layout and in-canvas chat.
- **Sep 14** Refined the short-drama canvas UI: reference images, video and audio preview in place; images enlarge; the canvas composer supports attachments, `@` node and asset references, execution mode and model choice.
- **Sep 14** Feishu message de-duplication now survives restarts: processed message IDs persist locally, so old tasks do not run again after a restart; the file stores IDs only, never message content or contact details.

- **Sep 13** It can shoot a story now: the shot list goes to you for a yes first, then character portraits, an opening frame per shot, video, voice, and one captioned vertical cut; change a shot and only that shot costs again
- **Sep 13** Re-running the same shot no longer costs twice: when an image / video / voice call carries byte-for-byte the same parameters as last time, the previous output is reused and the model is never called (pass `no_cache: true` when you do want a different take); there is also a new `POST /api/tool/run` that skips the model entirely, so replaying an identical call no longer burns a round of tokens reading your prompt back to it, and leaves it no chance to reword what you asked for — only image, video, voice and page-screenshot can be called that way
- **Sep 13** The channel table in the admin console can now be added to, edited and deleted from: a self-hosted gateway, a company proxy, a private deployment that moved domain — anything the built-in catalogue doesn't cover — goes in through "New channel"; two channels sharing one address get flagged instead of merged (separate accounts, separate keys, separate bills), and deleting one says up front what goes with it: how many chat models, how many media models, and whether your default model is in there
- **Sep 13** A command that isn't installed no longer comes back as a bare `command not found`: for tools it recognises, the reply says which one is missing, what it's for, and the exact line to install it on this machine (mac / Windows / Linux each get their own); aliases like `ffprobe` and `libreoffice` fold back to the package they ship with, instead of sending you after something that doesn't exist — and for a command it doesn't recognise it adds nothing at all
- **Sep 13** The default "max runtime for a task" disagreed in four places — the config template said 10 minutes, the code ran 30, the settings page said "default 10" — now it's 30 everywhere, with "auto-continue rounds" added to the config template (still 0 by default, since every extra round costs real money); the video skill also warns up front that past six shots you should raise the step and time limits, so a run doesn't die right before the final stitch, with the image and voice spend already gone
- **Sep 13** Image, video and voice generation can now run together in one round — 2 at a time by default, 1-4 in settings — so a twelve-shot short film no longer queues up one by one, kept deliberately below the read-only limit because each of these costs real money; this also fixes unnamed outputs landing on the same filename within a single millisecond, where the second one silently overwrote the first and both reported success
- **Sep 13** Image generation takes reference images (up to 4) and video generation takes a first and last frame, so the same person or product stays the same across shots; a text-to-video model handed an image (or the reverse) is caught before the request goes out, and a channel that really can't take the image says so instead of quietly falling back to text-only
- **Sep 13** Seven specialists — minutes, contract review, email, project plans, PRDs, recruiting and support scripts — now each carry a written spec, so what they hand back has a fixed shape and hard rules instead of a new format every time
- **Sep 13** Point it at an SMTP server and the agent emails the report it just wrote; a recipient allowlist is a hard gate, and every message shows you the full text before it leaves
- **Sep 13** The agent schedules its own recurring work: say "every Monday 9am, turn last week's numbers into a table" once and it runs on time
- **Sep 13** Recordings, meeting videos and voice notes turn into text, and it writes the minutes straight from there
- **Sep 13** Read the Word / Excel / PPT / PDF a client sent you, pull material straight from the shared library, and push a finished file to your group chat in one line
- **Sep 13** Your terminal can finally see what the agent drew: `/open` hands it to the system viewer, and capable terminals render it inline
- **Sep 13** Release pipeline closed up: PRs get a red/green light, a version mismatch fails loudly, one platform failing no longer sinks the whole release
- **Sep 13** Generated sites stop looking alike: pick a visual direction before writing a line
- **Sep 13** Every step now shows how long it took, and a closing tally: tool time vs. model-thinking time
- **Sep 13** Plug in Langfuse and you can read the raw input/output of every model call
- **Sep 13** Five API-key traps fixed at once: key not recognized, wizard every launch, duplicate channels, nowhere to paste, missing models
- **Sep 13** The admin console gets a "Models & Keys" page — admins configure there, not on the home page
- **Sep 11** Sidebar splits work into **Office / Engineering**; a `wb` run in your terminal shows up on your phone and takes interjections
- **Sep 11** Image / video / voice / vision each take several models, and one provider key covers all of them
- **Sep 11** Six ways the app could fail to open on launch, each now explained in a real window, plus a boot log
- **Sep 11** Installer is 139 MB smaller: source maps and type declarations are never read at runtime
- **Sep 11** "Check for updates" no longer tells people who installed a package to run `git pull`
- **Sep 11** Three high-severity fixes: a one-letter auth bypass, a filename that could run commands, a preview site open to the internet
- **Sep 11** On a shared server, plain members no longer see a row of buttons that can only 403
- **Sep 11** UI polish: three surface levels, one shadow scale, and scrollbars you can actually see
- **Sep 10** Your task history was never lost — an invented project name was filtering it out. Fixed
- **Sep 10** One command to deploy: `bash deploy.sh`, and `--domain` gets you HTTPS
- **Sep 10** Multi-tenant + admin console: 16 panels; admins, auditors and members each see their own slice
- **Sep 10** No more stopping half-done: the progress file is checked before a task may end
- **Sep 10** One line per step in the process pane; raw arguments and full return values are one click away
- **Sep 10** Long replies stopped stuttering: on a 100k-char stream, DOM rebuild drops 19.7s → 0.7s
- **Sep 10** Goal cards derive and grade criteria through your local CLI, with no silent API spend
- **Sep 10** WeChat / WeCom / Official Accounts / QQ can receive files, images, voice notes and stickers
- **Sep 10** Create a Lark app by QR; the App ID fills itself back in
- **Sep 9** Finishing a task no longer pops a panel over your chat — outputs become a row of chips
- **Sep 9** 39 one-click connector presets; experts up to 15, plus 4 teams
- **Sep 9** English / Chinese in one click; Appearance adds theme, six skins, font size and density
- **Sep 8** Five-step first-run wizard sets up model, engine and IM
- **Sep 8** Local Claude Code / Codex as the engine, with memory, skills, files and media wired in
- **Sep 8** Reasoning models can have thinking turned off or dialed down
- **Sep 7** Scheduled tasks get a "false green" verdict: no exception is not the same as done
- **Sep 5** `wb` CLI: one-shot, interactive, pipes, `--json`, honest exit codes
- **Sep 3** In-app preview for docx / xlsx / pptx / zip / csv
- **Aug 31** Paste or drag files and images into the chat; the agent actually reads the image

---

[← README](README.en.md)
