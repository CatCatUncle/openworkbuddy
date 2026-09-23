"use strict";
/**
 * 写代码那几样本事：按文件名找文件、后台跑长命令、进度清单、改之前确认文件没被别人动过。
 *
 * 为什么单拆一个文件：tools.js 已经四千多行，而这几样都能写成纯函数或自带状态的小登记表，
 * 拆出来才能不起 agent、不连模型地一条条测。tools.js 只管把它们接到工具调用上。
 *
 * 四样东西各自治一个真踩过的坑：
 *   1. **找文件只能按内容搜**。「测试文件在哪」「有没有 tsconfig」这种问题，模型只能
 *      list_files 一层层点，或者 run_shell find——前者烧步数，后者在 Windows 上没有。
 *   2. **长命令只能干等**。起一个开发服务器、跑一次十分钟的构建，run_shell 要么等到超时，
 *      要么被杀；起服务器再去验页面这条路根本走不通。
 *   3. **多步的活儿没有进度**。模型做到第六步忘了第二步答应过什么，人在终端前也看不出它做到哪了。
 *   4. **读完到改之间文件被别人改了**。另一个会话、另一个进程、人自己在编辑器里改——
 *      模型拿着旧内容做替换，old_text 碰巧还对得上，就把别人的改动整段冲掉。
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ─────────────────────────────────────────────────────────────
// 1. 按文件名找文件（glob）
// ─────────────────────────────────────────────────────────────

/** 这些目录里永远不是用户要找的东西，逛进去只会把结果刷满 */
const SKIP_DIRS = new Set(["node_modules", ".git", ".hg", ".svn", "dist", "build", ".next", ".nuxt", "__pycache__", ".venv", "venv", ".tmp", ".cache", "coverage", "target", ".idea", ".vscode"]);
const FIND_MAX = 200;
/** 逛多少个条目就收手：一个 monorepo 能有几十万个文件，逛完它模型也等不起 */
const WALK_BUDGET = 60000;

/**
 * glob → 正则。认 `**`（跨目录）、`*`（不跨目录）、`?`、`{a,b}`、`[abc]`。
 * 模式里不带斜杠的（`*.test.js`）按文件名匹配，在哪一层都算——这是人对 glob 的直觉。
 */
function globToRegex(glob) {
  let g = String(glob || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!g) return null;
  let re = "";
  let i = 0, brace = 0;
  while (i < g.length) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        // `**/` = 零层或多层目录；结尾的 `**` = 剩下的一切
        if (g[i + 2] === "/") { re += "(?:.*/)?"; i += 3; continue; }
        re += ".*"; i += 2; continue;
      }
      re += "[^/]*"; i++; continue;
    }
    if (c === "?") { re += "[^/]"; i++; continue; }
    if (c === "{") { brace++; re += "(?:"; i++; continue; }
    if (c === "}" && brace > 0) { brace--; re += ")"; i++; continue; }
    if (c === "," && brace > 0) { re += "|"; i++; continue; }
    if (c === "[") {
      const j = g.indexOf("]", i + 1);
      if (j > i) { re += "[" + g.slice(i + 1, j).replace(/^!/, "^").replace(/\\/g, "\\\\") + "]"; i = j + 1; continue; }
    }
    re += c.replace(/[.+^$()|\\\]]/g, "\\$&");
    i++;
  }
  while (brace-- > 0) re += ")";
  const nameOnly = !g.includes("/");
  return { re: new RegExp("^" + re + "$", process.platform === "win32" || process.platform === "darwin" ? "i" : ""), nameOnly };
}

/**
 * 在 root 下按 glob 找文件，最近改过的排前面（刚改过的文件最可能是正在干的活）。
 * @returns {{ files: Array<{rel:string,size:number,mtimeMs:number}>, truncated:boolean, walked:number, capped:boolean }}
 */
function findFiles(root, pattern, { max = FIND_MAX, base: baseAbs = "" } = {}) {
  const m = globToRegex(pattern);
  if (!m) throw new Error("pattern 不能为空，比如 **/*.test.js 或 src/**/*.ts");
  // base 由调用方先过一遍路径安全检查再递进来；这里不自己拼 dir，免得 ../../ 逛出工作区
  const base = baseAbs || root;
  const hits = [];
  let walked = 0, capped = false;
  const stack = [base];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (++walked > WALK_BUDGET) { capped = true; break; }
      const abs = path.join(d, e.name);
      if (e.isDirectory()) {
        // 模式点名要进的隐藏/构建目录照进：用户写了 dist/**/*.js 就是要看 dist
        if (SKIP_DIRS.has(e.name) && !String(pattern).includes(e.name)) continue;
        stack.push(abs);
        continue;
      }
      if (!e.isFile()) continue;
      const rel = path.relative(root, abs).split(path.sep).join("/");
      const relFromBase = path.relative(base, abs).split(path.sep).join("/");
      const subject = m.nameOnly ? e.name : relFromBase;
      if (!m.re.test(subject)) continue;
      let st;
      try { st = fs.statSync(abs); } catch { continue; }
      hits.push({ rel, size: st.size, mtimeMs: st.mtimeMs });
    }
    if (capped) break;
  }
  hits.sort((a, b) => b.mtimeMs - a.mtimeMs || a.rel.localeCompare(b.rel));
  const lim = Math.max(1, Math.min(Number(max) || FIND_MAX, 1000));
  return { files: hits.slice(0, lim), truncated: hits.length > lim, total: hits.length, walked, capped };
}

function findFilesText(root, input) {
  const r = findFiles(root, input.pattern, { max: input.max, base: input.base });
  if (!r.files.length) {
    return `没有匹配「${input.pattern}」的文件` + (r.capped ? `（目录太大，只逛了前 ${WALK_BUDGET} 个条目；缩小 dir 再找）` : "") +
      "。不带斜杠的模式按文件名匹配（*.ts）；要限定目录写成 src/**/*.ts。";
  }
  const lines = r.files.map((f) => f.rel);
  let head = `找到 ${r.total} 个，按最近修改排序`;
  if (r.truncated) head += `，只列前 ${r.files.length} 个（要更多就缩小范围或加 max）`;
  if (r.capped) head += `；目录太大，只逛了前 ${WALK_BUDGET} 个条目`;
  return head + "：\n" + lines.join("\n");
}

// ─────────────────────────────────────────────────────────────
// 2. 后台命令
// ─────────────────────────────────────────────────────────────

const BG_MAX = 8;            // 同时挂着的后台命令上限：开发服务器 + 监听构建 + 测试，够了
const BG_KEEP = 256 * 1024;  // 每条留最近这么多字符在内存里；全文在日志文件
const BG_READ = 12000;       // 一次读回给模型的上限
const bg = new Map();        // id → job
let bgSeq = 0;

/**
 * 起一条后台命令。spawnFn 由 tools.js 递进来（它知道挑哪个 shell、PATH 怎么补、进程组怎么开），
 * 这儿只管登记、收输出、按游标读。
 */
function bgStart({ command, cwd, spawnFn, logDir, owner = "" }) {
  const alive = [...bg.values()].filter((j) => j.exit === undefined);
  if (alive.length >= BG_MAX) {
    return { error: `后台已经挂着 ${alive.length} 条命令了（上限 ${BG_MAX}）。先用 shell_kill 收掉不用的：${alive.map((j) => j.id).join("、")}` };
  }
  const id = "bg" + (++bgSeq);
  let logFile = "";
  try {
    fs.mkdirSync(logDir, { recursive: true });
    logFile = path.join(logDir, `bg-${Date.now().toString(36)}-${id}.log`);
  } catch {}
  const job = { id, command, cwd, owner, startedAt: Date.now(), buf: "", dropped: 0, total: 0, cursor: 0, exit: undefined, signal: null, child: null, logFile };
  let child;
  try { child = spawnFn(); } catch (e) { return { error: `起不来：${e.message}` }; }
  job.child = child;
  const take = (d) => {
    const s = d.toString("utf8");
    job.total += s.length;
    job.buf += s;
    if (job.buf.length > BG_KEEP) { const cut = job.buf.length - BG_KEEP; job.buf = job.buf.slice(cut); job.dropped += cut; }
    if (logFile) { try { fs.appendFileSync(logFile, s); } catch {} }
  };
  if (child.stdout) child.stdout.on("data", take);
  if (child.stderr) child.stderr.on("data", take);
  child.on("close", (code, signal) => { job.exit = code; job.signal = signal; job.endedAt = Date.now(); });
  child.on("error", (e) => { take(Buffer.from(`\n[启动失败] ${e.message}\n`)); job.exit = -1; job.endedAt = Date.now(); });
  bg.set(id, job);
  return { id, job };
}

function bgState(job) {
  if (job.exit === undefined) return `还在跑（${Math.round((Date.now() - job.startedAt) / 1000)} 秒）`;
  if (job.signal) return `已被 ${job.signal} 终止`;
  return `已结束，exit code ${job.exit}`;
}

/** 读从上次读到现在的新输出。游标按「总共收到过多少字符」记，内存里丢掉的那段会明说 */
function bgRead(id, { all = false } = {}) {
  const job = bg.get(String(id || ""));
  if (!job) return { error: `没有这条后台命令：${id}。现有的：${[...bg.keys()].join("、") || "（一条都没有）"}` };
  const from = all ? job.dropped : Math.max(job.cursor, job.dropped);
  const lost = all ? 0 : Math.max(0, job.dropped - job.cursor);
  let text = job.buf.slice(from - job.dropped);
  job.cursor = job.total;
  let cut = "";
  if (text.length > BG_READ) {
    cut = `…〔这段新输出共 ${text.length} 字符，只给最后 ${BG_READ}；全文在 ${job.logFile ? path.basename(job.logFile) : "（没落盘）"}〕\n`;
    text = text.slice(-BG_READ);
  }
  return { job, text, lost, cut, state: bgState(job) };
}

function bgKill(id, killFn) {
  const job = bg.get(String(id || ""));
  if (!job) return { error: `没有这条后台命令：${id}` };
  if (job.exit !== undefined) return { job, already: true };
  try { killFn(job.child); } catch {}
  return { job };
}

function bgList() { return [...bg.values()]; }

/** 进程要退了：后台那几条一起收，别留一个开发服务器占着端口 */
function bgKillAll(killFn) {
  for (const j of bg.values()) if (j.exit === undefined) { try { killFn(j.child); } catch {} }
}

// ─────────────────────────────────────────────────────────────
// 3. 进度清单（todo）
// ─────────────────────────────────────────────────────────────

const TODO_STATUS = ["pending", "in_progress", "done"];
const TODO_MAX = 30;
const STATUS_ALIAS = { todo: "pending", doing: "in_progress", active: "in_progress", completed: "done", complete: "done", finished: "done", 待办: "pending", 进行中: "in_progress", 完成: "done", 已完成: "done" };

/**
 * 校验并规整模型给的清单。整张表每次重发（不做增量）：模型最不容易弄错，
 * 界面也只要画最新那一张。
 * @returns {{ items?: Array<{content:string,status:string}>, error?: string }}
 */
function normalizeTodos(raw) {
  if (!Array.isArray(raw)) return { error: "todos 要是一个数组：[{content, status}]，status 取 pending / in_progress / done" };
  if (raw.length > TODO_MAX) return { error: `清单最多 ${TODO_MAX} 条，你给了 ${raw.length} 条。拆粗一点，一条是一个能验收的结果，不是一个动作` };
  const items = [];
  for (const [i, x] of raw.entries()) {
    const content = String((x && (x.content || x.text || x.title)) || "").trim().slice(0, 200);
    if (!content) return { error: `第 ${i + 1} 条没有 content` };
    let st = String((x && x.status) || "pending").trim().toLowerCase();
    st = STATUS_ALIAS[st] || st;
    if (!TODO_STATUS.includes(st)) return { error: `第 ${i + 1} 条的 status「${x.status}」不认识，只能是 pending / in_progress / done` };
    items.push({ content, status: st });
  }
  const doing = items.filter((x) => x.status === "in_progress").length;
  // 同时进行两件以上 = 清单没在反映现实：人看不出它到底在干哪件
  if (doing > 1) return { error: `同一时间只能有一条 in_progress，你标了 ${doing} 条。先把手上那条做完标 done，再把下一条标成 in_progress` };
  return { items };
}

const TODO_MARK = { pending: "☐", in_progress: "▶", done: "☑" };
function todoText(items) {
  return items.map((x) => `${TODO_MARK[x.status]} ${x.content}`).join("\n");
}

function todoReceipt(items) {
  const done = items.filter((x) => x.status === "done").length;
  const cur = items.find((x) => x.status === "in_progress");
  let s = `清单已更新（${done}/${items.length} 完成）`;
  if (cur) s += `，正在做：${cur.content}`;
  else if (done < items.length) s += "。没有标 in_progress 的条目——开工前先把下一条标上";
  else s += "。全部完成：收尾前核一遍每条是不是真的做到了（跑过测试、文件真的在）";
  return s + "\n" + todoText(items);
}

// ─────────────────────────────────────────────────────────────
// 4. 读过之后文件被别人动过没有
// ─────────────────────────────────────────────────────────────

/** 会话 → (绝对路径 → 读到时的指纹)。只记这一个进程里读过的；没记过的文件不拦，老行为不变 */
const seen = new Map();
const SEEN_MAX = 2000;

function fingerprint(abs) {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return null;
    const h = crypto.createHash("sha1").update(fs.readFileSync(abs)).digest("hex");
    return { size: st.size, mtimeMs: st.mtimeMs, hash: h };
  } catch { return null; }
}

/** 记下「这个会话此刻看到的是这一版」。读、写、改完都要记：自己改的不算别人改 */
function stampSeen(session, abs) {
  if (!session || !abs) return;
  const fp = fingerprint(abs);
  if (!fp) return;
  let m = seen.get(session);
  if (!m) { m = new Map(); seen.set(session, m); }
  m.delete(abs);
  m.set(abs, fp);
  if (m.size > SEEN_MAX) m.delete(m.keys().next().value);
}

/**
 * 这个会话上次看到它之后，文件被别人改过没有。先比 mtime/size（便宜），对不上再比内容哈希——
 * 光 touch 一下不算改（编辑器保存未改动的文件、git checkout 同一版都会动 mtime）。
 * @returns {string} 非空 = 被改过，给模型看的说明
 */
function staleNote(session, abs, rel) {
  const m = session && seen.get(session);
  const was = m && m.get(abs);
  if (!was) return "";
  let st;
  try { st = fs.statSync(abs); } catch { return `${rel} 在你读过之后被删掉或挪走了。先 list_files / find_files 确认它现在在哪，再决定怎么改。`; }
  if (st.size === was.size && st.mtimeMs === was.mtimeMs) return "";
  const now = fingerprint(abs);
  if (now && now.hash === was.hash) { m.set(abs, now); return ""; }
  return `已拦截，一个字节都没改：${rel} 在你上次读它之后内容变了（${was.size} → ${now ? now.size : st.size} 字节）。` +
    `照你手上那一版去改，可能会把这次变化冲掉。先 read_file 重读一遍现在的内容，再基于它来改。`;
}

function forgetSession(session) { seen.delete(session); }

module.exports = {
  globToRegex, findFiles, findFilesText, SKIP_DIRS, FIND_MAX, WALK_BUDGET,
  bgStart, bgRead, bgKill, bgList, bgKillAll, bgState, BG_MAX, BG_READ,
  normalizeTodos, todoText, todoReceipt, TODO_MAX,
  stampSeen, staleNote, forgetSession,
  _internals: { bg, seen },
};
