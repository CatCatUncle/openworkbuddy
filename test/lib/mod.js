// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 测试找源码模块的唯一读法：名字 → 路径。
 *
 *   const { mod } = require("./lib/mod");
 *   const agent = require(mod("agent"));                    // 原来是 require("../agent")
 *   const SRC = fs.readFileSync(mod("tools"), "utf8");      // 原来是 path.join(ROOT, "tools.js")
 *   delete require.cache[require.resolve(mod("paths"))];    // 原来是 require.resolve("../paths")
 *
 * 为什么要有它：目录重整要把根目录和 lib/ engines/ routes/ 下的一百六十个模块搬进 src/ 分层。
 * 一百多个测试各自写死 "../agent"、path.join(ROOT, "lib", "x.js")，搬一批就得回头改几百处，
 * 漏一处的话有的当场红（好），有的「读不到就跳过」静悄悄变绿（坏）。所以先把所有引用收到这张表，
 * 之后每批搬家只改下面 TABLE 里的路径，测试文件本身不再动。
 *
 *   mod(名)            → 绝对路径（带扩展名）。require / require.resolve / require.cache 的键 /
 *                        readFileSync / spawn 都能直接用，跟原来的相对写法解析到同一个文件、同一个缓存键
 *   mod.rel(名)        → 仓库相对路径（posix），给断言文案、清单比对用
 *   mod.at(根, 名)     → 拼在别的根上（测试自己拷出来的假仓库、打好的包）
 *   mod.spec(从, 到)   → 「从」那个文件里 require「到」该写的相对路径（"./paths"、"../platform/paths"），
 *                        给断言源码里 require 文本的测试用；从/到 都可以是 mod 名或 entry 名
 *   mod.names()        → 所有名字
 * 名字写错当场抛，不返回一个不存在的路径让断言空跑。
 *
 * 名字规则：文件名去掉扩展名（agent.js → agent，lib/compose-jobs.js → compose-jobs）；
 * 例外两类——engines/index.js 叫 engines（大家都是 require("../engines")），
 * routes/ 下的带 routes/ 前缀（routes/canvas），免得跟 src/tools/canvas.js 这种不搬的同名文件混。
 * 入口（server.js cli.js electron-main.js server-host.js eval/*）不在这里，走 test/lib/entry.js。
 * src/tools/ 一期不动，也不在这里。
 */

const fs = require("fs");
const path = require("path");
const { entry } = require("./entry");

const ROOT = path.join(__dirname, "..", "..");

// 名字 → 仓库相对路径。目录重整每搬一批，只改这里对应的右边。
const TABLE = Object.freeze({
  // root
  account: "account.js",
  admin: "admin.js",
  agent: "agent.js",
  "ask-gate": "ask-gate.js",
  awake: "awake.js",
  "backup-auto": "backup-auto.js",
  "boot-check": "boot-check.js",
  "brand-kit": "brand-kit.js",
  "bridge-main": "bridge-main.js",
  "browser-render": "src/platform/render/browser-render.js",
  budget: "budget.js",
  callout: "src/util/callout.js",
  cdp: "src/platform/render/cdp.js",
  "chat-models": "chat-models.js",
  checkpoints: "checkpoints.js",
  "cli-approve": "cli-approve.js",
  "cli-args": "cli-args.js",
  "cli-ask": "cli-ask.js",
  "cli-attach": "cli-attach.js",
  "cli-live": "cli-live.js",
  "cli-toolview": "cli-toolview.js",
  "cmd-risk": "cmd-risk.js",
  "code-tools": "code-tools.js",
  "config-lint": "config-lint.js",
  "config-merge": "config-merge.js",
  "continue-gate": "continue-gate.js",
  "custom-commands": "custom-commands.js",
  "delivery-page": "delivery-page.js",
  diagram: "diagram.js",
  doctor: "doctor.js",
  "drama-compose": "drama-compose.js",
  "drama-pipeline": "drama-pipeline.js",
  "electron-bridge": "electron-bridge.js",
  evolve: "evolve.js",
  "experts-lib": "experts-lib.js",
  "feishu-doc": "feishu-doc.js",
  "gen-cache": "gen-cache.js",
  goal: "goal.js",
  hooks: "hooks.js",
  htmlshot: "src/platform/render/htmlshot.js",
  htmlvideo: "src/platform/render/htmlvideo.js",
  icons: "icons.js",
  "im-card": "im-card.js",
  "im-feishu-media": "im-feishu-media.js",
  "im-ilink": "im-ilink.js",
  "im-media": "im-media.js",
  "im-qq": "im-qq.js",
  "im-store": "im-store.js",
  "im-wechat": "im-wechat.js",
  im: "im.js",
  intranet: "intranet.js",
  jev: "jev.js",
  "json-compress": "json-compress.js",
  lanes: "lanes.js",
  "lark-cli": "src/util/lark-cli.js",
  "lib-cover": "lib-cover.js",
  "lib-favs": "lib-favs.js",
  license: "license.js",
  lifecycle: "lifecycle.js",
  llm: "llm.js",
  log: "log.js",
  mailer: "mailer.js",
  "mcp-catalog": "mcp-catalog.js",
  mcp: "mcp.js",
  "md-tty": "md-tty.js",
  "media-health": "media-health.js",
  "media-models": "media-models.js",
  "memory-gate": "memory-gate.js",
  memory: "memory.js",
  metrics: "metrics.js",
  migrate: "migrate.js",
  modes: "modes.js",
  "motion-clock": "src/util/motion-clock.js",
  notify: "notify.js",
  org: "org.js",
  paths: "paths.js",
  "pet-preload": "pet-preload.js",
  "pet-sprites": "pet-sprites.js",
  pet: "pet.js",
  plugins: "plugins.js",
  "portable-temp": "portable-temp.js",
  prefs: "prefs.js",
  preview: "preview.js",
  pricing: "pricing.js",
  "project-memo": "project-memo.js",
  "push-gate": "push-gate.js",
  "ql-thumb": "src/platform/render/ql-thumb.js",
  quota: "quota.js",
  rbac: "rbac.js",
  recipes: "recipes.js",
  "relay-files": "relay-files.js",
  relay: "relay.js",
  "repl-commands": "repl-commands.js",
  retention: "retention.js",
  review: "review.js",
  "run-spend": "run-spend.js",
  scheduler: "scheduler.js",
  security: "security.js",
  "server-supervisor": "server-supervisor.js",
  "session-search": "session-search.js",
  "shot-history": "shot-history.js",
  "skill-gate": "skill-gate.js",
  "skill-guard": "skill-guard.js",
  skills: "skills.js",
  "static-compress": "static-compress.js",
  store: "store.js",
  sweep: "sweep.js",
  systemone: "systemone.js",
  "task-verdict": "task-verdict.js",
  "term-image": "term-image.js",
  "text-width": "src/util/text-width.js",
  thinking: "thinking.js",
  "thumb-png": "src/util/thumb-png.js",
  "thumb-sips": "src/platform/render/thumb-sips.js",
  "thumb-worker": "src/platform/render/thumb-worker.js",
  thumb: "src/platform/render/thumb.js",
  tools: "tools.js",
  toolward: "toolward.js",
  totp: "src/util/totp.js",
  trace: "trace.js",
  updater: "updater.js",
  "usage-store": "usage-store.js",
  "video-frame": "src/platform/render/video-frame.js",
  vkeys: "vkeys.js",
  "web-window": "src/platform/render/web-window.js",
  "win-away": "win-away.js",
  "workflow-panel": "workflow-panel.js",
  workflow: "workflow.js",
  worktree: "worktree.js",
  // lib
  "builtin-skill-hashes": "lib/builtin-skill-hashes.json",
  "compose-jobs": "lib/compose-jobs.js",
  "demo-mask": "src/util/demo-mask.js",
  "demo-timing": "src/util/demo-timing.js",
  "deps-guard": "lib/deps-guard.js",
  "font-family": "src/util/font-family.js",
  "im-reply": "src/util/im-reply.js",
  "media-probe": "lib/media-probe.js",
  "out-decode": "src/util/out-decode.js",
  "pptx-layout": "src/util/pptx-layout.js",
  "task-dirs": "src/util/task-dirs.js",
  "timeline-cards": "src/util/timeline-cards.js",
  "timeline-compose": "lib/timeline-compose.js",
  "timeline-subs": "src/util/timeline-subs.js",
  "web-demo-plan": "src/util/web-demo-plan.js",
  "web-demo-recorder": "lib/web-demo-recorder.js",
  winname: "src/util/winname.js",
  "ws-browse": "lib/ws-browse.js",
  // engines
  bridge: "engines/bridge.js",
  "claude-code": "engines/claude-code.js",
  codex: "engines/codex.js",
  engines: "engines/index.js",
  jsonl: "engines/jsonl.js",
  "tool-bridge": "engines/tool-bridge.js",
  which: "engines/which.js",
  win: "engines/win.js",
  // routes
  "routes/canvas": "routes/canvas.js",
  "routes/compose": "routes/compose.js",
  "routes/drama": "routes/drama.js",
  "routes/library": "routes/library.js",
  "routes/prompt-tpls": "routes/prompt-tpls.js",
});

const has = (name) => Object.prototype.hasOwnProperty.call(TABLE, name);

function relOf(name) {
  if (!has(name)) throw new Error(`mod() 不认识「${name}」：名字是文件名去掉扩展名（engines/index.js 叫 engines，routes/ 下带 routes/ 前缀）；入口走 test/lib/entry.js`);
  return TABLE[name];
}

function mod(name) { return path.join(ROOT, relOf(name)); }

/** mod 名或 entry 名 → 仓库相对路径 */
function anyRel(name) {
  if (has(name)) return TABLE[name];
  if (entry.has(name)) return entry.rel(name);
  throw new Error(`mod.spec() 不认识「${name}」：既不在 mod 表也不在 entry 表`);
}

/**
 * 「从」文件里 require「到」文件该写的路径：同目录 "./x"，跨目录 "../platform/x"；
 * .js 不写，.json 照写；目标是 index.js 的写目录名（"./engines"）。
 */
function spec(from, to) {
  const fromRel = anyRel(from);
  let toRel = anyRel(to);
  // 去掉 .js 会跟同目录里只差大小写的别的文件撞名时（license.js 旁边的 LICENSE），源码里写的是带 .js 的，这里照样带。
  // 同名目录不算（skills.js 旁边的 skills/：require("./skills") 照样先认 skills.js）
  const bare = path.posix.basename(toRel).replace(/\.js$/, "");
  let sibs = [];
  try { sibs = fs.readdirSync(path.join(ROOT, path.posix.dirname(toRel)), { withFileTypes: true }); } catch {}
  if (!sibs.some((e) => e.isFile() && e.name.toLowerCase() === bare.toLowerCase())) toRel = toRel.replace(/\.js$/, "");
  if (path.posix.basename(toRel) === "index") toRel = path.posix.dirname(toRel);
  let r = path.posix.relative(path.posix.dirname(fromRel), toRel);
  if (!r.startsWith(".")) r = "./" + r;
  return r;
}

mod.rel = relOf;
mod.at = (root, name) => path.join(root, relOf(name));
mod.spec = spec;
mod.names = () => Object.keys(TABLE);
mod.has = has;
mod.ROOT = ROOT;
mod.TABLE = TABLE;

module.exports = { mod, ROOT };
