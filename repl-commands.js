"use strict";
/**
 * `wb` 交互模式里的那张命令表 —— 纯的：不碰 process、不碰 fs、不打印、不读 argv。
 *
 * 单独拆一层，是因为 REPL 里每一种「没认出来」都在花钱办错事，而且在健康机器上
 * 一声不吭。改写前实测到的四样：
 *
 *   1. **粘贴多行只进去第一行。** readline 一个换行一个 line 事件，老循环用 rl.question
 *      一次只接一条：贴十行需求进去，模型看见第一行，另外九行没人接、静默丢掉。
 *   2. **打错的斜杠命令整行当任务发走。** `/exi`、`/moe craft` 会被原样喂给模型，
 *      它会一本正经地去执行一条根本不存在的指令。跟命令行选项拼错是同一个病。
 *   3. **startsWith 认命令。** `/moderate` 被认成 `/mode rate`，`/cdrom` 被认成 `/cd rom`。
 *   4. **`/cd` 只认绝对路径。** `/cd ..`、`/cd ~/项目`、`/cd 子目录` 一律报
 *      「工作空间必须是绝对路径」——在一个 REPL 里这说不过去。
 *
 * 所以判断全放这儿，每一句要说给人听的话都能被测试钉住；cli.js 只管怎么显示、
 * 以及真去动工作目录/会话。拼写距离那套判据跟命令行选项共用 cli-args 的一份，
 * 两边给的「你是不是想说」才会一样宽松、一样严格。
 */

const path = require("path");
const { cols, padCols } = require("./text-width"); // 中文占两列，padEnd 数的是码位——对齐一律走它
const { editDistance } = require("./cli-args");

/**
 * 命令表。`arg` 填了就是「吃一个参数」，不填就是「不吃参数」；`choices` 填了就连取值一起管。
 * 帮助文本、Tab 补全、拼错建议全从这张表来——加一条命令只改这里，不会出现「实现了没写进帮助」。
 */
const COMMANDS = [
  { name: "help", aliases: ["?"], desc: "看这些命令都是干什么的" },
  { name: "mode", arg: "craft|plan|ask", choices: ["craft", "plan", "ask"], desc: "换执行模式；不给值就说当前是哪个" },
  { name: "new", desc: "开一个新会话；刚才那段不会丢，还能翻回去" },
  { name: "session", desc: "当前会话的 id 和存盘位置" },
  { name: "status", desc: "模式、底层引擎、工作目录、这个会话跑了几轮" },
  { name: "model", arg: "[序号或名字]", desc: "换这趟活儿谁来干：本机引擎或你配的模型；不给值就把能选的列出来" },
  { name: "cd", arg: "<目录>", desc: "换工作目录；认 .. 和 ~，不给就说当前在哪" },
  { name: "files", aliases: ["ls"], desc: "工作目录里现在有什么" },
  { name: "paste", aliases: ["v"], desc: "把剪贴板里的截图、文件或一大段文字带进来" },
  { name: "drop", desc: "带上了还没发出去的文件，不要了" },
  { name: "clear", aliases: ["cls"], desc: "清屏；会话和上下文都不动" },
  { name: "exit", aliases: ["quit", "q"], desc: "退出" },
];

/** 粘贴判据：紧挨着进来的几行算一次粘贴。人手打两行之间至少几百毫秒，到不了这个数 */
const PASTE_GAP_MS = 80;
/** 历史存多少条。再多也没人往上翻，白占地方 */
const HISTORY_MAX = 300;

function find(word) {
  const w = String(word || "");
  return COMMANDS.find((c) => c.name === w || (c.aliases || []).includes(w)) || null;
}

/**
 * 拼错了给一条建议，差太远就不瞎猜——猜错比不猜更误导。
 * 四个字母以上放到 2：最常见的手误是把两个字母打颠倒（hlep / exti / clera），
 * 在编辑距离里那是 2，卡在 1 就一条都猜不出来。三个字母以内仍然卡死在 1，
 * 短词本来就互相像，放宽了会开始瞎猜。
 */
function nearest(word) {
  const w = String(word || "");
  if (!w) return null;
  const limit = w.length <= 3 ? 1 : 2;
  let best = null, bestD = Infinity;
  for (const c of COMMANDS) {
    for (const n of [c.name, ...(c.aliases || [])]) {
      const d = editDistance(w, n);
      if (d > 0 && d <= limit && d < bestD) { best = c.name; bestD = d; }
    }
  }
  return best ? "/" + best : null;
}

/**
 * 一行输入是什么。返回的都是数据，怎么说话由 cli.js 定。
 *   { kind: "blank" }                                   空行，什么都不做
 *   { kind: "task", text }                              发给 agent 的任务
 *   { kind: "cmd", name, arg }                          内置命令
 *   { kind: "unknown", typed, suggest }                 长得像命令但没这条
 *   { kind: "bad-arg", name, arg, want }                命令对了，参数不对
 */
function parse(line) {
  const raw = String(line == null ? "" : line);
  const body = raw.trim();
  if (!body) return { kind: "blank" };
  // 粘进来的整块永远是任务：内置命令都是一行的，不存在「多行的 /cd」
  if (/\n/.test(body)) return { kind: "task", text: body };
  // 两个逃生口，都是为了「我就是想发一句以 / 开头的话」：行首留个空格，或者写成 //。
  // 第一个判的是 raw 而不是 body——body 已经修过边了，那个空格只在原文里还看得见
  if (/^[ \t]/.test(raw)) return { kind: "task", text: body };
  if (body.startsWith("//")) return { kind: "task", text: body.slice(1).trim() };
  if (!body.startsWith("/")) return { kind: "task", text: body };

  const m = body.match(/^(\/\S*)(?:\s+([\s\S]*))?$/);
  const head = m[1];
  const arg = String(m[2] || "").trim();
  const bare = head.slice(1);
  // 命令长什么样是定死的：/ 后面只有字母、数字、短横，中间不能再有斜杠。
  // 这一条先把路径摘出去——/Users/me/报表.xlsx、/usr/local/bin 都不是命令形状，原样发走。
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(bare)) return { kind: "task", text: body };

  const cmd = find(bare.toLowerCase());
  if (!cmd) {
    // 只有全小写的才按「打错的命令」拦下来。/Users、/Applications、/Volumes 这些是目录名，
    // 人是想跟 agent 说这个目录，拦下来纯属添乱；而 /moe 拦下来是省钱——
    // 它要是被当成任务发出去，模型会一本正经地去执行一条根本不存在的指令。
    if (bare !== bare.toLowerCase()) return { kind: "task", text: body };
    return { kind: "unknown", typed: head, suggest: nearest(bare) };
  }
  if (!cmd.arg && arg) return { kind: "bad-arg", name: cmd.name, arg, want: null };
  if (cmd.choices && arg && !cmd.choices.includes(arg)) return { kind: "bad-arg", name: cmd.name, arg, want: cmd.choices };
  return { kind: "cmd", name: cmd.name, arg };
}

/**
 * 把紧挨着进来的几行合成一条。
 * 入参是 [{ text, at }]（at 是毫秒时间戳），出参是几条已经拼好的输入。
 * 粘贴的那一整块中间的空行要留着——那是原文的格式，不是「敲了个回车」。
 */
function mergePaste(lines, gapMs) {
  const gap = typeof gapMs === "number" ? gapMs : PASTE_GAP_MS;
  const out = [];
  for (const ln of Array.isArray(lines) ? lines : []) {
    const text = String(ln && ln.text != null ? ln.text : "");
    const at = Number(ln && ln.at) || 0;
    const prev = out.length ? out[out.length - 1] : null;
    if (prev && at - prev.at < gap) { prev.text += "\n" + text; prev.at = at; }
    else out.push({ text, at });
  }
  return out.map((x) => x.text.replace(/^\n+/, "").replace(/\n+$/, ""));
}

/**
 * `/cd` 的目标目录。认 `~`、认相对路径、认 `..`——底下的 setWorkspaceDir 只收绝对路径，
 * 这一步就是把人话翻成它要的那种。返回空串表示「没给目录，只是想看看当前在哪」。
 */
function resolveCd(arg, cwd, home) {
  const a = String(arg == null ? "" : arg).trim();
  if (!a) return "";
  if (a === "~") return String(home || "");
  if (/^~[/\\]/.test(a)) return path.join(String(home || ""), a.slice(2));
  if (path.isAbsolute(a)) return path.normalize(a);
  return path.join(String(cwd || ""), a);
}

/** Tab 补全：命令名，以及带取值的命令的那几个取值 */
function complete(line) {
  const s = String(line == null ? "" : line);
  const head = s.match(/^\/([a-z0-9-]*)$/);
  if (head) {
    const pre = head[1];
    const hits = [];
    for (const c of COMMANDS) {
      if ([c.name, ...(c.aliases || [])].some((n) => n.startsWith(pre))) hits.push("/" + c.name);
    }
    return [hits, s];
  }
  const val = s.match(/^\/([a-z][a-z0-9-]*)[ \t]+(\S*)$/);
  if (val) {
    const c = find(val[1]);
    if (c && c.choices) return [c.choices.filter((x) => x.startsWith(val[2])).map((x) => `/${c.name} ${x}`), s];
  }
  return [[], s];
}

/**
 * 打了 `/` 之后该弹什么菜单。纯的：只算出「给谁看」，怎么画是 cli.js 的事。
 *
 * 用户原话：「怎么cli模型，我输入/的时候没有自动补全啊」。Tab 补全一直是有的——
 * 可没人会去按 Tab：一个记不住命令的人，第一反应是打个 `/` 然后等着看有什么。
 * 所以菜单得自己冒出来，Tab 只是「挑中这条」的快捷键之一。
 *
 * 跟 complete() 共用同一张 COMMANDS 表：补全给什么，菜单就列什么，不会出现
 * 「菜单里有、Tab 补不出来」这种两份清单对不上的事。
 *
 * 返回 null 表示「这一行没什么可弹的」，UI 据此把菜单收掉。
 */
function menu(line) {
  const s = String(line == null ? "" : line);
  const head = s.match(/^\/([a-z0-9-]*)$/);
  if (head) {
    const pre = head[1];
    const items = [];
    for (const c of COMMANDS) {
      if (![c.name, ...(c.aliases || [])].some((n) => n.startsWith(pre))) continue;
      items.push({
        text: "/" + c.name,
        // 吃参数的命令，插进去之后光标停在空格后面：接着打值就行，不用再补一个空格
        insert: "/" + c.name + (c.arg ? " " : ""),
        desc: c.arg ? `${c.arg}　${c.desc}` : c.desc,
      });
    }
    return items.length ? { kind: "cmd", prefix: pre, items } : null;
  }
  const val = s.match(/^\/([a-z][a-z0-9-]*)[ \t]+(\S*)$/);
  if (val) {
    const c = find(val[1]);
    if (c && c.choices) {
      const items = c.choices.filter((x) => x.startsWith(val[2]))
        .map((x) => ({ text: x, insert: `/${c.name} ${x}`, desc: "" }));
      return items.length ? { kind: "choice", prefix: val[2], items } : null;
    }
  }
  return null;
}

const GAP = 4;
/**
 * `/model` 的选单：把「本机引擎」和「你配的模型」拼成同一张带序号的表。
 *
 * 为什么合成一张：坐在终端前的人只关心一件事——**这句话待会儿是谁回的**。
 * 可这在配置里是两个字段：agent.engine 决定「整趟任务交给谁跑」，active_model 决定
 * 「内置循环调哪个模型」。拆成两条命令，用户得先知道自己现在在哪条路上才知道该敲哪条，
 * 而 /status 恰恰把这两种情况印成同一行「底层 X」/「模型 Y」，它自己就分不出来。
 *
 * 哪一行是「现在这个」要跟 llm.js 的 createLLM 算得一模一样：它是
 * `models.find(m => m.name === active_model) || models[0]`——active_model 写了个
 * 不存在的名字时真正在跑的是第一条。这里照抄这条规则，不然表上没有任何一行带箭头，
 * 而用户明明正在用其中一条。
 */
function modelRows({ engines = [], models = [], engine = "builtin", activeModel = "" } = {}) {
  const rows = [];
  for (const e of engines || []) {
    if (!e || !e.id || e.id === "builtin") continue; // 内置不是一个选项，它就是「用下面那些模型」
    rows.push({
      kind: "engine", key: String(e.id), label: String(e.label || e.id),
      sub: e.installed ? "已装 · 走你自己的订阅" : "没装",
      tail: "", ready: !!e.installed, install: String(e.install || ""),
      current: String(engine || "builtin") === String(e.id),
    });
  }
  const builtin = !engine || engine === "builtin";
  const list = Array.isArray(models) ? models : [];
  let cur = list.findIndex((m) => m && String(m.name || "") === String(activeModel || ""));
  if (cur < 0 && list.length) cur = 0;
  list.forEach((m, i) => {
    rows.push({
      kind: "model", key: String((m && m.name) || (m && m.model) || `模型${i + 1}`),
      label: String((m && m.name) || (m && m.model) || `模型${i + 1}`),
      sub: String((m && m.model) || ""), tail: String((m && m.channelName) || ""),
      ready: true, install: "", current: builtin && i === cur,
    });
  });
  rows.forEach((r, i) => { r.n = i + 1; });
  return rows;
}

/** 选单长什么样。分两组印，因为这两组花的是完全不同的钱——上面那组走订阅，下面那组走 API 额度 */
function modelListText(rows) {
  const eng = rows.filter((r) => r.kind === "engine");
  const mod = rows.filter((r) => r.kind === "model");
  const w = rows.reduce((n, r) => Math.max(n, cols(r.label)), 0);
  const line = (r) => {
    const bits = [padCols(r.label, w + GAP), r.sub];
    if (r.tail) bits.push("· " + r.tail);
    if (!r.ready && r.install) bits.push("· 装它：" + r.install);
    // 标记只用 ASCII：▸ / » 这类符号在东亚宽度表里是「不确定」，中文终端按两列画，
    // 带箭头那行就会比别的行多缩进一格——一张表里唯一那行歪的，恰好是「你现在用的」
    return `${r.current ? ">" : " "} ${String(r.n).padStart(2)}  ${bits.join(" ").trimEnd()}`;
  };
  const out = ["", "wb> 这趟活儿谁来干："];
  if (eng.length) { out.push("", "  本机引擎（装了就能选，花的是你自己的订阅，不走 API 额度）", ...eng.map(line)); }
  if (mod.length) { out.push("", "  你配的模型（内置循环 + 你的 API Key）", ...mod.map(line)); }
  else { out.push("", "  还没配过模型：设置 → 模型 里加一条，或者直接改 config.json 的 models"); }
  out.push("", "  换一个：/model 2　或　/model 名字的一部分",
    "  只管这一趟，不动配置文件；要长期改去设置里的「模型」。", "");
  return out.join("\n");
}

/**
 * 按用户敲的那半截认出是哪一行。序号、全名、名字的一部分都认；
 * 认出两条以上就说清楚是哪几条，不替他挑——挑错了他要么在花不该花的钱，要么在等一个没装的东西。
 */
function pickModelRow(rows, arg) {
  const w = String(arg == null ? "" : arg).trim();
  if (!w) return { kind: "list" };
  if (/^\d+$/.test(w)) {
    const r = rows.find((x) => x.n === Number(w));
    return r ? { kind: "ok", row: r } : { kind: "none", arg: w, why: "序号只到 " + rows.length };
  }
  const lw = w.toLowerCase();
  const eq = rows.filter((r) => r.key.toLowerCase() === lw || r.label.toLowerCase() === lw);
  if (eq.length === 1) return { kind: "ok", row: eq[0] };
  const hit = rows.filter((r) => `${r.key} ${r.label} ${r.sub}`.toLowerCase().includes(lw));
  if (hit.length === 1) return { kind: "ok", row: hit[0] };
  if (hit.length > 1) return { kind: "many", arg: w, rows: hit };
  return { kind: "none", arg: w, why: "没有这一条" };
}

function helpText() {
  const rows = COMMANDS.map((c) => ({
    left: `/${c.name}${c.arg ? " " + c.arg : ""}`,
    desc: c.desc + ((c.aliases || []).length ? `（也能写 ${c.aliases.map((a) => "/" + a).join(" ")}）` : ""),
  }));
  const w = rows.reduce((n, r) => Math.max(n, cols(r.left)), 0);
  const lines = rows.map((r) => `  ${padCols(r.left, w + GAP)}${r.desc}`);
  return [
    "",
    "wb> 这儿能敲的命令：",
    "",
    ...lines,
    "",
    "  别的都当任务发给 agent。多行需求直接粘进来，会合成一条，不会被拆成好几条。",
    "  想发一句本来就以 / 开头的话：行首加个空格，或者写成 //。",
    "  任务跑着的时候打字回车 = 插话，下一步会带给它；Ctrl+C 停这趟活儿，不退出。",
    "",
  ].join("\n") + "\n";
}

function unknownText(v) {
  let s = `没有 ${v.typed} 这条命令。\n`;
  if (v.suggest) s += `你是不是想说 ${v.suggest}？\n`;
  s += `/help 看全部命令；要把这行当任务发出去，行首加个空格，或者写成 /${v.typed}。\n`;
  return s;
}

function badArgText(v) {
  if (v.want) return `/${v.name} 只认 ${v.want.join(" / ")}，不认「${v.arg}」。\n`;
  return `/${v.name} 不吃参数。「${v.arg}」想当任务发出去的话直接打，别带 /${v.name}。\n`;
}

/**
 * 输入闸门：readline 的 line 事件进来，成型的输入出去。三件事在这儿定死，
 * 都是改写前漏掉的，而且每一样在健康机器上都不报错：
 *   - 紧挨着进来的几行合成一条（粘贴），一行不丢；
 *   - 任务跑着的时候进来的算「插话」，不排进任务队列；
 *   - 关掉（Ctrl+D）时，等在 next() 上的那个 Promise 必须回来 —— 改写前它永远不 resolve，
 *     进程连带 MCP 子进程一起挂在那儿。
 * 定时器和时钟都能从外面传进来，所以这套时序在测试里是可以手动推进、逐帧断言的。
 */
function makeInbox(opt) {
  const o = opt || {};
  const gap = typeof o.gapMs === "number" ? o.gapMs : PASTE_GAP_MS;
  const clock = o.now || (() => Date.now());
  const setT = o.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearT = o.clearTimer || ((t) => clearTimeout(t));
  const onInterject = o.onInterject || (() => {});
  const onMerged = o.onMerged || (() => {}); // 合成之后给调用方一个机会去收拾 readline 的历史
  let burst = [];
  let timer = null;
  let ended = false;
  let busy = false;
  let waiter = null;
  const queue = [];

  const hand = (text) => {
    if (busy) { onInterject(text); return; }
    if (waiter) { const w = waiter; waiter = null; w(text); return; }
    queue.push(text); // 上一条还在跑就排队，绝不丢
  };
  const flush = () => {
    timer = null;
    if (!burst.length) return;
    const n = burst.length;
    const blocks = mergePaste(burst, gap);
    burst = [];
    onMerged(n, blocks);
    for (const t of blocks) hand(t);
  };

  return {
    line(text) {
      burst.push({ text: String(text == null ? "" : text), at: clock() });
      if (timer !== null) clearT(timer);
      timer = setT(flush, gap);
    },
    close() {
      ended = true;
      if (timer !== null) { clearT(timer); flush(); }
      if (waiter) { const w = waiter; waiter = null; w(null); }
    },
    /** 下一条成型的输入；null = 关掉了（Ctrl+D），该收尾退出了 */
    next() {
      return new Promise((ok) => {
        if (queue.length) return ok(queue.shift());
        if (ended) return ok(null);
        waiter = ok;
      });
    },
    setBusy(b) { busy = !!b; },
    get busy() { return busy; },
    get queued() { return queue.length; },
  };
}

/** 存盘前把历史收拾干净：空行不要、跟上一条一样的不要、带换行的只留第一行（文件是一行一条） */
function sanitizeHistory(lines, max) {
  const cap = Number(max) > 0 ? Number(max) : HISTORY_MAX;
  const out = [];
  for (const raw of Array.isArray(lines) ? lines : []) {
    const t = String(raw == null ? "" : raw).replace(/\r/g, "").split("\n")[0].trim();
    if (!t) continue;
    if (out.length && out[out.length - 1] === t) continue;
    out.push(t);
    if (out.length >= cap) break;
  }
  return out;
}

module.exports = {
  COMMANDS, PASTE_GAP_MS, HISTORY_MAX,
  parse, mergePaste, makeInbox, resolveCd, complete, menu, helpText, unknownText, badArgText,
  modelRows, modelListText, pickModelRow,
  sanitizeHistory, nearest, find,
};
