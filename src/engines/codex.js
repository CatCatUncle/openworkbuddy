// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 底层引擎：本机已装的 Codex CLI（`codex exec --json`）。
 *
 * 和 claude-code 那条同一个道理：用户已经在为 ChatGPT 订阅付钱，
 * 这里就不该再让他为同一件事买第二份 API 额度。
 *
 * 事件流长得跟 Claude 完全不一样，得单独翻一遍：
 *   thread.started              → 记 thread_id（续跑要用）
 *   item.completed/agent_message→ text（Codex 是整段给，不是流式 token）
 *   item.*  /command_execution  → tool_use + tool_result
 *   item.*  /mcp_tool_call      → tool_use + tool_result
 *   turn.completed              → usage
 *   turn.failed                 → 抛异常（错误就是错误，不许当成"跑完了"）
 *
 * 沙箱的默认值：
 *   · sandbox = workspace-write —— 它得往工作目录写 PPT、报告、图片，read-only 等于废了。
 *     可写的只有工作目录：OpenWorkBuddy 的数据根（配置、账号、Key 都在那）不开放，护的是
 *     「引擎里跑的命令改不动应用自己的设置」。
 *   · 命令联网默认关 —— 查资料走 codex 自带的联网搜索，不靠沙箱里的命令出网；
 *     借过去的 OpenWorkBuddy 工具走 MCP，在沙箱外执行，不受这条影响。
 *     属主在 设置 → 智能体 → 底层引擎 里可以打开（engine_options.codex.network）。
 *
 * 型号必须由调用方给（开跑前那道闸已经按属主的设置核过，见 gate.js）：
 * 不再拿 ~/.codex/config.toml 里的默认型号顶上，没给就报错。
 */

const { runJsonl, probeVersion, enginePath } = require("./jsonl");
const thinking = require("../core/model/thinking");
const { resolveBin } = require("../platform/which");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("../platform/win"); // 不直接用 child_process 的：Windows 上 .cmd 垫片起不来、还闪黑窗
const { dataPath } = require("../platform/paths");
const { buildChildEnv } = require("../platform/child-env");
const gate = require("./gate");

const ID = "codex";

function shorten(s, n = 80) {
  return String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n);
}

const SKILL_CONTEXT_WARNING = /Skill descriptions were shortened to fit the skills context budget/i;
// 续跑时模型和会话录下的不一样，Codex 发一条 error item 提醒，随后照常把这一轮跑完——不是失败
const RESUME_MODEL_WARNING = /This session was recorded with model .* but is resuming with/i;

/**
 * 这条会话上一轮实际用的模型（从 CODEX_HOME/sessions 下的 rollout 文件里读最后一个 model 字段）。
 *
 * 为什么续跑要钉住它：用户任务做到一半在设置里换了模型，下一轮带着新 -m 去 resume，
 * Codex 会报「recorded with model X but is resuming with Y」，而且提示缓存是跟模型走的——
 * 实测换模型那一轮 4.3 万输入只命中 1.8 万缓存，又慢又贵。不传 -m 也不行：它会落到
 * 自己的默认型号，而不是会话原来那个。所以新模型只对新任务生效，进行中的任务沿用原来的。
 */
function recordedModel(home, threadId) {
  if (!home || !threadId || !/^[\w-]+$/.test(threadId)) return "";
  const root = path.join(home, "sessions");
  const find = (dir, depth) => {
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return ""; }
    // 目录是 年/月/日，新的排在后面；倒着找，续跑的多半是最近的会话
    for (const d of names.sort((a, b) => (a.name < b.name ? 1 : -1))) {
      const full = path.join(dir, d.name);
      if (depth < 3 && d.isDirectory()) { const hit = find(full, depth + 1); if (hit) return hit; }
      else if (d.isFile() && d.name.endsWith(threadId + ".jsonl")) return full;
    }
    return "";
  };
  const file = find(root, 0);
  if (!file) return "";
  try {
    // 只读尾部：长会话的 rollout 能有几十 MB，最后一个 model 字段一定在最近那几轮里
    const fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const all = [...buf.toString("utf8").matchAll(/"model":"([^"]+)"/g)];
    return all.length ? all[all.length - 1][1] : "";
  } catch { return ""; }
}

/**
 * Codex 把登录态、插件开关、用户技能和会话全放在 CODEX_HOME。直接让桌面助理继承整份
 * ~/.codex 很容易发生一件很反直觉的事：技能太多时 CLI 会往 JSONL 里塞一条 error item，
 * 即使随后已经给出了回答，调用方也会把整轮当失败。
 *
 * OpenWorkBuddy 因此有自己的轻量运行窝：只链接用户已有的 auth.json，绝不复制 token，
 * 不加载全局插件/技能；线程仍保留在应用数据目录，resume 不会失效。用户原来的 Codex
 * 终端和插件配置一字不动。
 */
function sourceCodexHome(env = process.env) {
  return path.resolve(env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

function configuredModels(env = process.env) {
  const cfg = path.join(sourceCodexHome(env), "config.toml");
  let text = "";
  try { text = fs.readFileSync(cfg, "utf8"); } catch { return []; }
  // 只读 model 字段，不碰 auth，也不把整份个人 config 返回给前端。
  const values = [...text.matchAll(/^\s*model\s*=\s*["']([^"']+)["']\s*$/gm)].map((m) => m[1].trim()).filter(Boolean);
  return [...new Set(values)];
}

/**
 * 这个账号此刻真能用的模型：`codex debug models` 吐的是服务端下发的目录（隐藏的内部槽位不算）。
 *
 * 为什么要有它：~/.codex/config.toml 里的 model 是用户在别处（Codex 应用、手改）写下的，
 * 写的可能是 API 账号才有、订阅账号没有的名字。原样 -m 传过去，每个任务都 400，
 * 而且错在用户的全局配置里，本项目的界面上根本看不出来。
 * 拿不到目录（旧版 CLI 没这个子命令、没登录）就返回 null——此时不做任何判断，照旧行事。
 */
const ACCOUNT_MODELS_TTL = 10 * 60 * 1000;
const accountModelsCache = new Map();
function accountModels(bin, env) {
  const key = bin + "\0" + (env.CODEX_HOME || "");
  const hit = accountModelsCache.get(key);
  if (hit && Date.now() - hit.at < ACCOUNT_MODELS_TTL) return Promise.resolve(hit.list);
  return new Promise((resolve) => {
    // 只带 CODEX_HOME 过去：env 是整份环境（找登录目录要用），原样给子进程就把里面的 Key 一起送出去了。
    // PATH 照样补全：npm 装的 codex 开头是 `#!/usr/bin/env node`，双击启动时那份 PATH 里找不到 node
    execFile(bin, ["debug", "models"], { env: buildChildEnv({ PATH: enginePath(), CODEX_HOME: env.CODEX_HOME }), timeout: 10000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      let list = null;
      if (!err) {
        try {
          const ms = JSON.parse(stdout).models;
          if (Array.isArray(ms)) list = ms.filter((m) => m && m.slug && m.visibility !== "hide").map((m) => String(m.slug));
        } catch {}
      }
      if (list && !list.length) list = null;
      // 失败不缓存：刚登录完 / 刚升级完 CLI，下一次就该拿得到
      if (list) accountModelsCache.set(key, { at: Date.now(), list });
      resolve(list);
    });
  });
}

const MODEL_UNSUPPORTED = /model is not supported|model_not_found|does not exist or you do not have access|unsupported model/i;

/** 模型名不被账号认可时的那句人话：点名是哪个、账号能用哪些、去哪改 */
function explainModel(model, available) {
  const which = model ? `「${model}」` : "当前设置的模型";
  const can = available && available.length ? `这个账号能用的是：${available.join(" / ")}。` : "";
  return `本机 Codex 不认${which}这个模型（ChatGPT 订阅账号只能用订阅里有的型号）。${can}` +
    `去 ${gate.WHERE} 的「模型」栏改成其中一个。`;
}

function openWorkBuddyCodexHome(env = process.env) {
  const sourceHome = sourceCodexHome(env);
  const auth = path.join(sourceHome, "auth.json");
  const home = dataPath("data", "runtime", "codex");
  fs.mkdirSync(home, { recursive: true });
  const linkedAuth = path.join(home, "auth.json");
  try {
    const current = fs.readlinkSync(linkedAuth);
    if (path.resolve(path.dirname(linkedAuth), current) !== auth) fs.unlinkSync(linkedAuth);
  } catch {
    try { fs.unlinkSync(linkedAuth); } catch {}
  }
  // 没有 auth 时也让 Codex 在隔离目录里启动：它会给出正常的「请登录」错误，不会偷偷
  // 回落去加载一大堆全局插件。符号链接让 token 刷新仍写回用户自己的登录态。
  if (!fs.existsSync(linkedAuth) && fs.existsSync(auth)) fs.symlinkSync(auth, linkedAuth);
  return { env: { ...env, CODEX_HOME: home } };
}

/**
 * 宿主机上的技能，OWB 拉起的 codex 一个都不加载，只留 imagegen（自带生图的说明）：
 *   · ~/.agents/skills 下用户给别的工具装的——描述全塞进上下文，挤掉本项目的说明和借出去的工具，
 *     装得多了 codex 还会吐那条「技能描述被压缩」的 error item；
 *   · codex 自带的系统技能（建技能、装技能、查文档……）——在这里用不上，装技能还会写到隔离运行窝里去。
 * 用户在终端里直接用 codex 不受影响；工作目录里项目自带的技能照常加载。
 *
 * 0.154 的写法：skills.config 是一张表，每项 { name = "...", enabled = false }，name 认 SKILL.md 头上那个。
 * 隔离运行窝头一次起来时 skills/.system 还没铺开，系统那几样按名字先写上。
 * 名字太多时 Windows 的命令行有长度上限，超出 SKILLS_ARG_MAX 的不再往上加：系统的排前面，用户的按名字排序（结果稳定）
 */
const KEEP_SKILLS = new Set(["imagegen"]);
const SYSTEM_SKILLS = ["openai-docs", "plugin-creator", "review-agent", "skill-creator", "skill-installer"];
const SKILLS_ARG_MAX = 16 * 1024;

function skillName(dir) {
  let head = "";
  try {
    const fd = fs.openSync(path.join(dir, "SKILL.md"), "r");
    try {
      const buf = Buffer.alloc(4096);
      head = buf.toString("utf8", 0, fs.readSync(fd, buf, 0, buf.length, 0));
    } finally { fs.closeSync(fd); }
  } catch { return ""; } // 没有 SKILL.md 就不是技能
  const fm = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(head);
  const m = fm && /^name:[ \t]*(.+?)[ \t]*$/m.exec(fm[1]);
  return (m ? m[1].replace(/^(["'])(.*)\1$/, "$2").trim() : "") || path.basename(dir);
}

function skillNamesIn(root) {
  let names = [];
  try { names = fs.readdirSync(root); } catch { return []; }
  return names.filter((n) => !n.startsWith(".")).map((n) => skillName(path.join(root, n))).filter(Boolean);
}

/** @param {{ codexHome: string, userHome?: string }} where */
function skillsOffArgs({ codexHome, userHome }) {
  const system = [...SYSTEM_SKILLS, ...skillNamesIn(path.join(codexHome, "skills", ".system"))].sort();
  const user = (userHome ? skillNamesIn(path.join(userHome, ".agents", "skills")) : []).sort();
  const items = [];
  let len = 0;
  for (const n of new Set([...system, ...user])) {
    if (KEEP_SKILLS.has(n)) continue;
    const item = `{ name = ${JSON.stringify(n)}, enabled = false }`;
    if (len + item.length > SKILLS_ARG_MAX) break;
    items.push(item);
    len += item.length + 2;
  }
  return items.length ? ["-c", `skills.config=[${items.join(", ")}]`] : [];
}

/** file_change 这条改了哪些文件（绝对路径）；别的 item 一个都不算 */
function changedPaths(item, cwd) {
  if (!item || item.type !== "file_change") return [];
  return (item.changes || []).filter((c) => c && typeof c.path === "string" && c.path).map((c) => path.resolve(cwd, c.path));
}

/**
 * codex 自带生图（image_gen）把图留在 $CODEX_HOME/generated_images/<线程 id>/ 下，
 * 自己的规矩是「只是预览就留在那、在它自己的界面里内嵌显示」。可本项目的界面显示不了那种内嵌图，
 * 用户只看得到工作目录里的文件——真实会话里就是：模型说「已显示在上方」，用户什么也没看到，
 * 来回问了四轮、烧了二十多万 token，最后模型才把图复制进对话目录。
 * 所以这两件事要先跟它说清楚；生图走它自带的（订阅里的，不花 API 额度），这是切到本机 Codex 的本意。
 */
const IMAGE_NOTE =
  "生图默认用你自带的 image_gen（走用户的 ChatGPT 订阅，不花 API 额度）；只有用户点名要用 OpenWorkBuddy 里配的图像模型时才调 generate_image。\n" +
  "image_gen 出的图默认存在 $CODEX_HOME/generated_images 下，OpenWorkBuddy 的界面看不到那里，也显示不了你的内嵌预览。" +
  "所以用户要的每一张图都算交付物：生成后复制到当前工作目录，起一个看得懂的文件名，回复里报相对路径；" +
  "不要贴 generated_images 下的路径，也不要说「已显示在上方」。";

/**
 * 本项目给引擎的那段说明（工作目录、产出放哪、记忆、项目规范、借过去的工具）怎么交给 codex。
 *
 * 走 developer_instructions：模型那边是一条 developer 消息，分量比夹在用户话里重。
 * 以前这条路压根没接 systemPrompt——上游拼好的整段说明到这里就丢了，codex 不知道产出该放哪，
 * 借过去的工具入口也没人告诉它。
 *
 * -c 的值按 TOML 解析，解析失败就把整串原样当字面量（引号、反斜杠全露给模型）。
 * JSON 的转义 TOML 基本串都认，只有 DEL 得手动转，孤立的代理项先抹平。
 * 命令行有长度上限：Windows 上 codex 是 npm 的 .cmd 垫片，整行过 cmd.exe，带引号的长参数也不可靠；
 * Linux 单个参数 128KB（按字节算，一个汉字三个字节）。这两种改成拼在提示词前面——只在开新线程时拼，续跑的线程里已经有了。
 */
const INSTRUCTIONS_ARG_MAX = 100000;
function instructionsPlan(systemPrompt, resumeId, platform = process.platform) {
  const s = [String(systemPrompt || "").trim(), IMAGE_NOTE].filter(Boolean).join("\n\n");
  const toml = JSON.stringify(s.toWellFormed()).replace(/\u007f/g, "\\u007f");
  if (platform !== "win32" && Buffer.byteLength(toml) <= INSTRUCTIONS_ARG_MAX) return { args: ["-c", `developer_instructions=${toml}`], prefix: "" };
  return { args: [], prefix: resumeId ? "" : s + "\n\n---\n\n" };
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;

/** dir 下（最多三层，跳过点开头的目录和 node_modules）这一趟写过、大小对得上的文件 */
function recentFilesBySize(dir, sizes, since, depth = 3, out = [], budget = { left: 3000 }) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (--budget.left < 0) break;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth > 1 && !e.name.startsWith(".") && e.name !== "node_modules") recentFilesBySize(p, sizes, since, depth - 1, out, budget);
    } else if (e.isFile()) {
      try { const st = fs.statSync(p); if (sizes.has(st.size) && st.mtimeMs >= since) out.push(p); } catch {}
    }
  }
  return out;
}

/**
 * 兜底：这一趟 codex 自带生图出了图、模型却一张都没放进工作目录时，替它放进去，按写文件报上去，
 * 产出栏和预览就跟别的产物一样。
 *
 * 只看本线程自己的目录、只认这一趟开跑之后出的：几条对话同时用 codex 时不会互相捡图，
 * 续跑的线程里上一轮的旧图也不会再捡一遍。
 * 模型已经自己复制过任意一张（工作目录里有这一趟写的、内容一模一样的文件），就当它挑过了，
 * 剩下的是弃稿，不动。克隆复制（APFS 上不占额外空间），不覆盖已有文件。
 */
function pickupImages({ codexHome, threadId, cwd, since }) {
  if (!codexHome || !threadId || !cwd) return [];
  const dir = path.join(codexHome, "generated_images", path.basename(String(threadId)));
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const fresh = [];
  for (const n of names.filter((x) => IMAGE_EXT.test(x)).sort()) {
    const src = path.join(dir, n);
    try { const st = fs.statSync(src); if (st.isFile() && st.size > 0 && st.mtimeMs >= since) fresh.push({ src, n, size: st.size, mtime: st.mtimeMs }); } catch {}
  }
  if (!fresh.length) return [];
  // 文件系统的时间精度有粗有细，留一秒余量，别把模型刚复制过去的那张漏掉
  const placed = recentFilesBySize(cwd, new Set(fresh.map((f) => f.size)), since - 1000);
  for (const f of fresh) {
    let buf = null;
    try { buf = fs.readFileSync(f.src); } catch { continue; }
    for (const p of placed) {
      try { if (fs.statSync(p).size === f.size && fs.readFileSync(p).equals(buf)) return []; } catch {}
    }
  }
  const out = [];
  for (const f of fresh) {
    const ext = path.extname(f.n).toLowerCase();
    const t = new Date(f.mtime), two = (n) => String(n).padStart(2, "0");
    const stem = `codex-image-${two(t.getMonth() + 1)}${two(t.getDate())}-${two(t.getHours())}${two(t.getMinutes())}${two(t.getSeconds())}`;
    for (let i = 1; i < 100; i++) {
      const dest = path.join(cwd, i === 1 ? stem + ext : `${stem}_${i}${ext}`);
      try {
        fs.copyFileSync(f.src, dest, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
        out.push(dest);
        break;
      } catch (e) {
        if (e && e.code === "EEXIST") continue;
        break; // 复制不了（磁盘满、没权限）就算了：图还在 codex 那边，不能因为兜底把整个任务弄挂
      }
    }
  }
  return out;
}

/** 把 Codex 的 item 归成 (工具名, 目的说明)；认不出的原样带过去，不假装认识 */
function toolOf(item) {
  switch (item.type) {
    case "command_execution": return { name: "run_shell", purpose: shorten(item.command) };
    case "mcp_tool_call": return { name: `${item.server || "mcp"}.${item.tool || ""}`, purpose: shorten(item.arguments || "") };
    case "web_search": return { name: "web_search", purpose: shorten(item.query) };
    case "file_change": return { name: "edit_file", purpose: shorten((item.changes || []).map((c) => c.path).join(", ")) };
    default: return null;
  }
}

/**
 * codex 自己说某项设置「不再支持」时（比如 `wire_api = "chat"`），那一行连同它给的
 * How to fix / More info 原样交出去：怎么改它说得比我们准，转述一遍反而走样
 */
function noLongerSupported(s) {
  const lines = String(s || "").split(/\r?\n/);
  const i = lines.findIndex((l) => /is no longer supported/i.test(l));
  if (i < 0) return "";
  const out = [lines[i].trim()];
  for (let j = i + 1; j < lines.length && out.length < 3; j++) {
    const l = lines[j].trim();
    if (!/^(How to fix|More info)\b/i.test(l)) break;
    out.push(l);
  }
  return out.join("\n");
}

/**
 * 退出时的 stderr、turn.failed 带的那句共用的几条认法；认不出返回空串。
 * 只有 codex 明说没登录（或让人重跑 codex login）才说「没登录」：光一个 401，
 * 也可能是自配的网关 Key 不对、账号被停——原话带上，不替人下结论
 */
function explainKnown(s, model, available) {
  if (MODEL_UNSUPPORTED.test(s)) return explainModel(model, available);
  const gone = noLongerSupported(s);
  if (gone) return `本机 Codex 不再支持当前的一项设置，它的原话：\n${gone}`;
  if (/not logged in|not signed in|codex login/i.test(s))
    return "本机 Codex 还没登录。先在终端里跑一次 `codex login`，再回来重试。";
  if (/\b401\b|Unauthorized/i.test(s))
    return `本机 Codex 的请求被上游拒了（401）。原话：${s.trim().slice(-400)}`;
  return "";
}

function explain(stderr, code, model, available) {
  const s = String(stderr || "");
  const known = explainKnown(s, model, available);
  if (known) return known;
  if (/rate.?limit|429|quota/i.test(s))
    return "本机 Codex 撞到限流或额度上限了，等窗口重置后再跑。";
  if (/ENOENT|command not found/i.test(s))
    return "找不到 codex 命令。装一个（npm i -g @openai/codex）或在设置里填绝对路径。";
  return s ? s.slice(-600) : `codex 异常退出（退出码 ${code}）且没有任何输出`;
}

/** 收整份设置，理由同 claude-code.js 里那条注释 */
async function detect(opts) {
  const explicit = typeof opts === "string" ? opts : (opts && opts.bin) || "";
  const found = await resolveBin("codex", explicit);
  if (!found.bin) return { id: ID, installed: false, path: explicit || "codex", version: "", how: "", error: found.why };
  const r = await probeVersion(found.bin, ["--version"]);
  const fromAccount = r.installed ? await accountModels(found.bin, openWorkBuddyCodexHome(process.env).env) : null;
  const models = fromAccount || configuredModels(process.env);
  return {
    id: ID, installed: r.installed, path: found.bin, version: r.version, how: found.how,
    error: r.installed ? "" : "找到了 " + found.bin + "，但 --version 跑不通（装坏了？）",
    // 不塞会过期的硬编码 GPT 名称表：优先用 `codex debug models` 拿账号真实目录，
    // 拿不到（旧版 CLI / 没登录）才退回用户 Codex 配置里出现过的 model 字段。
    models,
    modelSource: fromAccount ? "codex_account" : models.length ? "codex_config" : "manual",
  };
}

/**
 * codex 的 turn.completed 报的是整条线程的累计用量：续跑一次，前面几轮又全报一遍
 * （10-06 一条会话每轮从 49 万涨到 70 万）。以前照单全加，账本虚高好几倍。
 * 这里按线程记下上一趟的累计值，这一趟只记差值。记在应用自己的数据目录里，不碰 codex 的文件。
 * 新线程从 0 算；续跑却找不到上一趟的数（这个版本以前的线程），或者累计值不增反减，
 * 这一趟就记 0。0 在账本里是「没记上」，界面写「未记录」，不拿猜的数充数。
 */
const USAGE_FIELDS = ["input_tokens", "cached_input_tokens", "output_tokens"];
const USAGE_ZERO = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
function usageBaseFile(threadId) {
  return /^[\w-]+$/.test(String(threadId || "")) ? dataPath("data", "runtime", "codex-usage", threadId + ".json") : "";
}
function readUsageBase(threadId) {
  const f = usageBaseFile(threadId);
  if (!f) return null;
  try { const o = JSON.parse(fs.readFileSync(f, "utf8")); return o && typeof o === "object" ? o : null; } catch { return null; }
}
function writeUsageBase(threadId, cum) {
  const f = usageBaseFile(threadId);
  if (!f) return;
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(cum)); } catch {}
}
/** 这次的累计 − 上一趟的累计。base 为 null（不知道从哪儿起算）或有一格变小了，回 null */
function usageDelta(cum, base) {
  if (!base) return null;
  const d = {};
  for (const k of USAGE_FIELDS) {
    const v = cum[k] - (Number(base[k]) || 0);
    if (!(v >= 0)) return null;
    d[k] = v;
  }
  return d;
}

async function run({
  prompt, cwd, emit = () => {}, deadline, stopSignal,
  model, allowedModels = [], resumeId, bin, sandbox, network = false, guard = {}, mcpArgs = [], writableRoots = [], env, extraArgs = [],
  thinking: thinkingLevel,
  systemPrompt = "",
  onWrite = null,
}) {
  // 闸在上游已经核过；这里再挡一次，护的是绕过 agent 直接调 run() 的那些入口（测试连接、目标拆解）
  const bad = gate.modelArg(extraArgs, ID);
  if (bad) throw new Error(`本机 Codex 的附加参数里有换型号的「${bad}」，到 ${gate.argsWhere(ID)} 里删掉它。`);
  const pinned = String(model || "").trim();
  if (!pinned) throw new Error(`先在 ${gate.WHERE} 里给本机 Codex 指定型号，再开跑。`);
  const found = await resolveBin("codex", bin);
  if (!found.bin) throw new Error(found.why + "。装一个（npm i -g @openai/codex），或在设置里填 codex 的绝对路径。");
  const exe = found.bin;
  const isolated = openWorkBuddyCodexHome({ ...process.env, ...(env || {}) });
  let effectiveModel = pinned;
  const available = await accountModels(exe, isolated.env);
  if (resumeId) {
    // 续跑沿用会话原来的型号（理由见 recordedModel），但只在它仍是属主放行的型号时：
    // 属主收紧了列表，进行中的任务也得换到放行的那个上，不能靠续跑留在旧型号
    const rec = recordedModel(isolated.env.CODEX_HOME, resumeId);
    const ok = new Set([pinned, ...(Array.isArray(allowedModels) ? allowedModels : [])]);
    if (rec && ok.has(rec) && (!available || available.includes(rec))) effectiveModel = rec;
  }
  // 同 claude 那边：本机 CLI 冷启动那几秒界面本来全空，看着像发送没点上。
  // bin 一确认存在就先挂一枚「正在启动」的牌子占位，thread.started 一到原地换成带模型名的
  // 正式版（前端认的是同一个 .run-eng 节点）。
  emit({ type: "status", starting: true, text: `本机 Codex 正在启动（连接工具中，一般 3~8 秒），不消耗 API 额度`, depth: 0 });
  const args = ["exec"];
  if (resumeId) args.push("resume", resumeId);
  args.push("--json", "--skip-git-repo-check");
  // 沙箱与网络一律走 -c 配置覆盖，不用 -s / -C：
  // `codex exec resume` 这个子命令根本不收 -s 和 -C（会直接报 unexpected argument 退出），
  // 而 -c 两条路都收。工作目录由子进程自己的 cwd 决定，本来也不需要 -C。
  // 沙箱档位跟着设置页那颗开关走：「只看不动 / 每步都问」→ read-only。
  // codex 自带的工具不经过本项目的安全中心，硬写死 workspace-write 的话，
  // 用户选的档位到这条路上就丢了。engine_options 里手填的 sandbox 仍然最大
  args.push("-c", `sandbox_mode="${sandbox || guard.codexSandbox || "workspace-write"}"`);
  if (network === true) args.push("-c", "sandbox_workspace_write.network_access=true");
  // workspace-write 默认只让写 cwd。额外的可写目录只收工作区里的：数据根、包着数据根的目录、
  // 数据根下的 data/ 一律剔掉（remember / save_skill 走 MCP，在沙箱外执行，用不着这个口子）
  const roots = gate.safeRoots(writableRoots, dataPath());
  if (roots.length) args.push("-c", `sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`);
  args.push("-m", effectiveModel);
  // 本项目自己的工具（生图/视频/技能/记忆）当成 MCP 服务器挂上去，
  // 否则切到本机 Codex 就等于把这些全丢了
  for (const a of mcpArgs) args.push(a);
  // 思考模式：跟 app 设置页那个下拉框同一个档位（codex 这边是 model_reasoning_effort，
  // 关掉就是 none）。auto 不发，配置文件里怎么写就怎么来
  for (const a of thinking.planForEngine(ID, thinkingLevel).args) args.push(a);
  // 宿主机上的技能只留 imagegen（理由见 skillsOffArgs）。家目录跟子进程看到的那个走：调用方给了 HOME 就认它。
  // 排在 extraArgs 前面：属主手填了 skills.config 的，以他的为准
  for (const a of skillsOffArgs({ codexHome: isolated.env.CODEX_HOME, userHome: (env && env.HOME) || os.homedir() })) args.push(a);
  // 排在 extraArgs 前面：用户在设置里自己填了 developer_instructions 的，以他的为准
  const instr = instructionsPlan(systemPrompt, resumeId);
  for (const a of instr.args) args.push(a);
  for (const a of extraArgs) args.push(a);
  args.push("-"); // 提示词从 stdin 读，和 claude 那条保持一致

  let finalText = "";
  let sessionId = resumeId || null;
  let step = 0;
  let failure = null;
  let turnDone = false;
  const usage = { prompt: 0, completion: 0, cached: 0, calls: 0, elapsed_ms: 0 };
  let usageBase; // 上一趟结束时这条线程的累计值（见 usageDelta），头一次 turn.completed 时才读
  const startedAt = Date.now();
  const announced = new Set(); // item.started 报过的工具，completed 时别重复报一遍卡片

  const onLine = (m) => {
    if (!m || typeof m !== "object") return;
    if (m.type === "thread.started") {
      sessionId = m.thread_id || sessionId;
      // 把实际用的模型带上：设置页那个「测试连接」要显示它，用户下一个任务看到的得是同一个名字
      emit({ type: "status", text: `本机 Codex 已启动（模型 ${effectiveModel || "默认"}），不消耗 API 额度`, model: effectiveModel || "", depth: 0 });
      return;
    }
    if (m.type === "turn.started") {
      step += 1;
      usage.calls += 1;
      emit({ type: "step_start", step, depth: 0 });
      return;
    }
    if (m.type === "turn.completed") {
      turnDone = true;
      const u = m.usage || {};
      // 线程累计值，取差值记（见 usageDelta）。reasoning_output_tokens 本来就算在 output_tokens 里，不再另加
      const cum = {};
      for (const k of USAGE_FIELDS) cum[k] = Math.max(0, Number(u[k]) || 0);
      if (usageBase === undefined) usageBase = resumeId ? readUsageBase(resumeId) : USAGE_ZERO;
      const d = usageDelta(cum, usageBase);
      if (d) {
        usage.prompt += d.input_tokens;
        usage.cached += d.cached_input_tokens;
        usage.completion += d.output_tokens;
      }
      usageBase = cum;
      writeUsageBase(sessionId, cum);
      return;
    }
    if (m.type === "turn.failed") {
      failure = (m.error && m.error.message) || "Codex 这一轮失败了，但没给出原因";
      return;
    }
    const item = m.item;
    if (!item || typeof item !== "object") return;

    if (item.type === "agent_message") {
      if (m.type === "item.completed" && item.text) {
        finalText = String(item.text).trim(); // 最后一条 agent_message 就是交付正文
        emit({ type: "text", delta: item.text, depth: 0 });
      }
      return;
    }
    if (item.type === "error") {
      if (m.type === "item.completed") {
        const message = item.message || "Codex 报了一个没有说明的错误";
        // 新版 Codex 会在技能描述被压缩时发一个 error item，但仍继续完成 turn 并给出答案。
        // 这不是任务失败；真正的修复是上面的隔离运行窝，这里只是保证旧会话/特殊环境不会
        // 因为一条可恢复告警把已经成功的任务误判为失败。
        if (!SKILL_CONTEXT_WARNING.test(message) && !RESUME_MODEL_WARNING.test(message)) failure = message;
      }
      return;
    }
    const t = toolOf(item);
    if (!t) return;
    if (m.type === "item.started" && !announced.has(item.id)) {
      announced.add(item.id);
      emit({ type: "tool_use", id: item.id, name: t.name, purpose: t.purpose, depth: 0 });
      return;
    }
    if (m.type === "item.completed") {
      if (!announced.has(item.id)) {
        announced.add(item.id);
        emit({ type: "tool_use", id: item.id, name: t.name, purpose: t.purpose, depth: 0 });
      }
      const bad = item.status === "failed" || (item.exit_code != null && item.exit_code !== 0);
      // 改过的文件报上去：几条对话共用一趟扫描时，产出卡靠这个认主，不靠谁先比对
      if (onWrite && !bad) for (const p of changedPaths(item, cwd)) { try { onWrite(p); } catch {} }
      const out = item.aggregated_output || item.output || item.result || "";
      // 命令输出留着换行（shorten 会把它压成一行，终端就只剩头一句），截没截、一共几行一并报上去
      let text = "";
      try { text = typeof out === "string" ? out : JSON.stringify(out) || ""; } catch { text = String(out); } // MCP 的 result 是个对象，String() 只剩 [object Object]
      emit({ type: "tool_result", id: item.id, name: t.name, isError: !!bad, preview: text.slice(0, 800), cut: text.length > 800, lines: text.replace(/\n+$/, "").split("\n").length, depth: 0 });
    }
  };

  // isolated.env 是整份环境（openWorkBuddyCodexHome 要从里面找原来的登录目录），只把调用方给的和 CODEX_HOME 交下去；
  // 其余的由 runJsonl 按白名单挑，环境里的 Key 不跟着进 codex 和它起的 shell
  const r = await runJsonl({ bin: exe, args, cwd, env: { ...(env || {}), CODEX_HOME: isolated.env.CODEX_HOME }, stdin: instr.prefix + prompt, onLine, deadline, stopSignal });
  usage.elapsed_ms = Date.now() - startedAt;
  // 停了、超时了、报错了也捡：出了的图是真出了，订阅额度已经用掉了。onWrite 报上去，收尾那次扫描就认得是这条对话的
  const picked = pickupImages({ codexHome: isolated.env.CODEX_HOME, threadId: sessionId, cwd, since: startedAt });
  if (picked.length) {
    if (onWrite) for (const p of picked) { try { onWrite(p); } catch {} }
    emit({ type: "status", notice: true, text: `Codex 生成的图已放进对话目录：${picked.map((p) => path.basename(p)).join("、")}`, depth: 0 });
  }

  if (r.killed === "stopped") return { finalText, usage, stopped: "已手动停止", sessionId };
  if (r.killed === "deadline") return { finalText, usage, stopped: "已达最大运行时间", sessionId };
  if (failure) throw new Error(explainKnown(failure, effectiveModel, available) || failure);
  if (!turnDone || r.code !== 0) {
    if (finalText && r.code === 0) return { finalText, usage, stopped: null, sessionId };
    throw new Error(explain(r.stderr, r.code, effectiveModel, available));
  }
  return { finalText, usage, stopped: null, sessionId };
}

module.exports = {
  changedPaths, instructionsPlan, pickupImages, skillsOffArgs,
  id: ID,
  label: "本机 Codex",
  bin: "codex",
  launchHeader: "codex exec --json",
  note: "用你电脑上已登录的 Codex（ChatGPT 订阅）跑，不消耗本项目配置的 API 额度",
  install: "npm i -g @openai/codex，然后终端里跑一次 codex login",
  login: "在终端里跑一次 codex login 完成登录，再回来点一次",
  supportsResume: true,
  models: [], // 真正的候选由 detect() 从当前 Codex 配置读取，不能拿过期硬编码冒充真实数据
  thinkingLabel: "推理强度 effort（关闭=none，低/中/高=low/medium/high）",
  detect, run, explain,
};
