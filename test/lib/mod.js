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
  account: "src/domains/account/account.js",
  admin: "src/domains/account/admin.js",
  agent: "src/agent/agent.js",
  "ask-gate": "src/agent/gates/ask-gate.js",
  awake: "src/platform/awake.js",
  "backup-auto": "backup-auto.js",
  "boot-check": "src/platform/boot-check.js",
  "brand-kit": "src/domains/content/brand-kit.js",
  "bridge-main": "bridge-main.js",
  "browser-render": "src/platform/render/browser-render.js",
  budget: "src/core/billing/budget.js",
  callout: "src/util/callout.js",
  cdp: "src/platform/render/cdp.js",
  "chat-models": "src/core/model/chat-models.js",
  checkpoints: "src/agent/checkpoints.js",
  "cli-approve": "cli-approve.js",
  "cli-args": "cli-args.js",
  "cli-ask": "cli-ask.js",
  "cli-attach": "cli-attach.js",
  "cli-live": "src/core/obs/cli-live.js",
  "cli-toolview": "cli-toolview.js",
  "cmd-risk": "src/core/safety/cmd-risk.js",
  "code-tools": "src/agent/code-tools.js",
  "config-lint": "src/core/config/config-lint.js",
  "config-merge": "src/core/config/config-merge.js",
  "continue-gate": "src/agent/gates/continue-gate.js",
  "custom-commands": "custom-commands.js",
  "delivery-page": "src/domains/content/delivery-page.js",
  diagram: "src/domains/media/diagram.js",
  doctor: "doctor.js",
  "drama-compose": "src/domains/media/drama-compose.js",
  "drama-pipeline": "src/domains/media/drama-pipeline.js",
  "electron-bridge": "src/platform/electron-bridge.js",
  evolve: "src/agent/evolve.js",
  "experts-lib": "src/agent/experts-lib.js",
  "feishu-doc": "src/domains/content/feishu-doc.js",
  "gen-cache": "src/domains/media/gen-cache.js",
  goal: "src/core/automation/goal.js",
  hooks: "src/agent/hooks.js",
  htmlshot: "src/platform/render/htmlshot.js",
  htmlvideo: "src/platform/render/htmlvideo.js",
  icons: "src/platform/icons.js",
  "im-card": "im-card.js",
  "im-feishu-media": "im-feishu-media.js",
  "im-ilink": "im-ilink.js",
  "im-media": "im-media.js",
  "im-qq": "im-qq.js",
  "im-store": "im-store.js",
  "im-wechat": "im-wechat.js",
  im: "im.js",
  intranet: "src/core/config/intranet.js",
  jev: "src/core/judge/jev.js",
  "json-compress": "json-compress.js",
  lanes: "src/core/config/lanes.js",
  "lark-cli": "src/util/lark-cli.js",
  "lib-cover": "src/domains/library/lib-cover.js",
  "lib-favs": "src/domains/library/lib-favs.js",
  license: "src/domains/account/license.js",
  lifecycle: "src/domains/account/lifecycle.js",
  llm: "src/core/model/llm.js",
  log: "src/platform/log.js",
  mailer: "src/core/obs/mailer.js",
  "mcp-catalog": "src/core/ext/mcp-catalog.js",
  mcp: "src/agent/mcp.js",
  "md-tty": "md-tty.js",
  "media-health": "src/core/model/media-health.js",
  "media-models": "src/core/model/media-models.js",
  "memory-gate": "src/agent/gates/memory-gate.js",
  memory: "src/core/memory/memory.js",
  metrics: "src/core/obs/metrics.js",
  migrate: "migrate.js",
  modes: "src/core/config/modes.js",
  "motion-clock": "src/util/motion-clock.js",
  notify: "src/core/obs/notify.js",
  org: "src/domains/account/org.js",
  paths: "src/platform/paths.js",
  "pet-preload": "pet-preload.js",
  "pet-sprites": "pet-sprites.js",
  pet: "pet.js",
  plugins: "src/core/ext/plugins.js",
  "portable-temp": "portable-temp.js",
  prefs: "src/core/config/prefs.js",
  preview: "src/domains/library/preview.js",
  pricing: "src/core/billing/pricing.js",
  "project-memo": "src/core/memory/project-memo.js",
  "push-gate": "src/core/automation/push-gate.js",
  "ql-thumb": "src/platform/render/ql-thumb.js",
  quota: "src/core/billing/quota.js",
  rbac: "src/domains/account/rbac.js",
  recipes: "src/domains/content/recipes.js",
  "relay-files": "relay-files.js",
  relay: "relay.js",
  "repl-commands": "repl-commands.js",
  retention: "retention.js",
  review: "review.js",
  "run-spend": "src/core/billing/run-spend.js",
  scheduler: "src/core/automation/scheduler.js",
  security: "src/core/safety/security.js",
  "server-supervisor": "server-supervisor.js",
  "session-search": "src/core/memory/session-search.js",
  "shot-history": "src/domains/media/shot-history.js",
  "skill-gate": "src/agent/gates/skill-gate.js",
  "skill-guard": "src/core/safety/skill-guard.js",
  skills: "src/core/ext/skills.js",
  "static-compress": "static-compress.js",
  store: "src/platform/store.js",
  sweep: "src/agent/sweep.js",
  systemone: "src/core/judge/systemone.js",
  "task-verdict": "src/core/automation/task-verdict.js",
  "term-image": "term-image.js",
  "text-width": "src/util/text-width.js",
  thinking: "src/core/model/thinking.js",
  "thumb-png": "src/util/thumb-png.js",
  "thumb-sips": "src/platform/render/thumb-sips.js",
  "thumb-worker": "src/platform/render/thumb-worker.js",
  thumb: "src/platform/render/thumb.js",
  tools: "src/agent/tools.js",
  toolward: "src/core/safety/toolward.js",
  totp: "src/util/totp.js",
  trace: "src/core/obs/trace.js",
  updater: "updater.js",
  "usage-store": "src/core/billing/usage-store.js",
  "video-frame": "src/platform/render/video-frame.js",
  vkeys: "src/domains/account/vkeys.js",
  "web-window": "src/platform/render/web-window.js",
  "win-away": "win-away.js",
  "workflow-panel": "workflow-panel.js",
  workflow: "workflow.js",
  worktree: "src/agent/worktree.js",
  // lib
  "builtin-skill-hashes": "src/platform/builtin-skill-hashes.json",
  "compose-jobs": "src/domains/media/compose-jobs.js",
  "demo-mask": "src/util/demo-mask.js",
  "demo-timing": "src/util/demo-timing.js",
  "deps-guard": "src/platform/deps-guard.js",
  "font-family": "src/util/font-family.js",
  "im-reply": "src/util/im-reply.js",
  "media-probe": "src/platform/media-probe.js",
  "out-decode": "src/util/out-decode.js",
  "pptx-layout": "src/util/pptx-layout.js",
  "task-dirs": "src/util/task-dirs.js",
  "timeline-cards": "src/util/timeline-cards.js",
  "timeline-compose": "src/domains/media/timeline-compose.js",
  "timeline-subs": "src/util/timeline-subs.js",
  "web-demo-plan": "src/util/web-demo-plan.js",
  "web-demo-recorder": "src/domains/media/web-demo-recorder.js",
  winname: "src/util/winname.js",
  "ws-browse": "src/domains/library/ws-browse.js",
  // engines
  bridge: "src/engines/bridge.js",
  "claude-code": "src/engines/claude-code.js",
  codex: "src/engines/codex.js",
  engines: "src/engines/index.js",
  jsonl: "src/engines/jsonl.js",
  "tool-bridge": "src/engines/tool-bridge.js",
  which: "src/platform/which.js",
  win: "src/platform/win.js",
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
