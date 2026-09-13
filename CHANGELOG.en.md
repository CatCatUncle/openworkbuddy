# Changelog

One line per change, newest first. The README keeps only the last few; everything is here.

The matching code is in the [commit log](https://github.com/CatCatUncle/openworkbuddy/commits/main) —
each message says *why*, not *which file*, so it reads better than this list.

中文：[CHANGELOG.md](CHANGELOG.md)

## 2026

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
