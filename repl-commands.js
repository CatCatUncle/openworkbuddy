"use strict";
/**
 * `openworkbuddy` 交互模式里的那张命令表 —— 纯的：不碰 process、不碰 fs、不打印、不读 argv。
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

const { MODE_IDS, MODE_ARG } = require("./modes"); // 执行模式的唯一真源，别在这儿抄第二份

const path = require("path");
const { cols, padCols } = require("./text-width"); // 中文占两列，padEnd 数的是码位——对齐一律走它
const { editDistance } = require("./cli-args");
const { PERMISSION_MODES } = require("./security"); // 权限档的唯一真源，跟网页那四档、跟 --perm 是同一份
const PERM_IDS = Object.keys(PERMISSION_MODES);
const PERM_ARG = PERM_IDS.join("|"); // 跟 MODE_ARG 一个写法：不带尖括号，帮助里直接印取值

/**
 * 命令表。`arg` 填了就是「吃一个参数」，不填就是「不吃参数」；`choices` 填了就连取值一起管。
 * 帮助文本、Tab 补全、拼错建议全从这张表来——加一条命令只改这里，不会出现「实现了没写进帮助」。
 */
const COMMANDS = [
  { name: "help", aliases: ["?"], desc: "看这些命令都是干什么的" },
  { name: "mode", arg: MODE_ARG, choices: MODE_IDS, desc: "换执行模式；不给值就说当前是哪个" },
  { name: "perm", arg: PERM_ARG, choices: PERM_IDS, desc: "换这一趟放多少权（只看不动/每步都问/自动改文件/全自动）；不给值就把四档摆出来" },
  { name: "new", desc: "开一个新会话；刚才那段不会丢，还能翻回去" },
  { name: "resume", aliases: ["r"], arg: "[序号或会话id]", desc: "接着之前那段往下聊；不给值就弹选择器，↑↓ 挑、打字搜" },
  { name: "session", desc: "当前会话的 id 和存盘位置" },
  { name: "status", desc: "模式、底层引擎、工作目录、这个会话跑了几轮" },
  { name: "init", desc: "让它把这个目录看一遍，写一份 AGENTS.md，以后每趟活儿都照着它来" },
  { name: "compact", desc: "把前面聊过的压成一段摘要腾地方；原文照样归档，不删" },
  { name: "diff", desc: "这个会话动过哪些文件；工作目录要是 git 仓库，顺带把 diff 也出了" },
  { name: "rewind", arg: "[序号]", desc: "把这个会话改过的文件退回某一步之前；不给序号就列出能退的步" },
  { name: "mcp", desc: "外部连接器接上了没有、各自带了几个工具、没接上是卡在哪儿" },
  { name: "model", arg: "[序号或名字]", desc: "换这趟活儿谁来干：本机引擎或你配的模型；不给值同样弹选择器" },
  { name: "cd", arg: "<目录>", desc: "换工作目录；认 .. 和 ~，不给就说当前在哪" },
  { name: "files", aliases: ["ls"], desc: "工作目录里现在有什么" },
  { name: "open", aliases: ["o"], arg: "[名字或序号]", desc: "用系统默认程序打开产出（终端里看不了的 SVG、Excel、视频都能看）；不给就打开工作目录" },
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
  const out = ["", "openworkbuddy> 这趟活儿谁来干："];
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

// ── `/resume`：接着之前那段往下聊 ─────────────────────────────────────────
// 命令行本来就有 `openworkbuddy resume`，但那是**开一个新进程**才用得上的写法。
// 人已经坐在交互模式里了，想翻回半小时前那段，只能先 /exit 再重开——而一 exit，
// 当前这段的上下文、带着没发的文件、临时调过的 /mode /perm 全没了。
// Claude Code 和 Codex 在 REPL 里都有 /resume，缺的就是这一条。

const RESUME_MAX = 12; // 再多就得翻屏了；真要找更早的，按 id 接

/**
 * 多久以前。终端里「12 分钟前」有用，`2026-09-18T00:16:18.402Z` 没用——
 * 人找的是「我刚才在哪一条上」，不是时间戳。
 *
 * 时钟从外面传：这一层不许自己读表（测试要能把时间钉死逐帧断言）。
 * 没给时钟就返回空串，让上面那层少印一列，绝不拿 0 当现在——
 * 那会把每一条都说成「刚刚」，比不显示更糟。
 */
function ago(ms, now) {
  const t = Number(now) || 0, at = Number(ms) || 0;
  if (!t || !at) return "";
  const min = Math.floor(Math.max(0, t - at) / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return min + " 分钟前";
  const h = Math.floor(min / 60);
  if (h < 24) return h + " 小时前";
  const day = Math.floor(h / 24);
  if (day === 1) return "昨天";
  if (day < 30) return day + " 天前";
  const mo = Math.floor(day / 30);
  return mo < 12 ? mo + " 个月前" : Math.floor(day / 365) + " 年前";
}

/**
 * 把 cli.js 读出来的会话列表编上号。
 *
 * 桌面开的那些一起列——两边写的本来就是同一批文件，只列 cli_ 开头那半边，
 * 等于把「早上在桌面开了个头，下午想在终端接着做」这条路堵死（跟 `openworkbuddy resume` 一个口径）。
 * 所以每行都标了来源：接过去之前你得看得见这条是不是桌面那边正开着的。
 */
function sessionRows(list, o = {}) {
  const now = Number(o.now) || 0;
  const cur = String(o.currentId || "");
  return (Array.isArray(list) ? list : []).map((s, i) => ({
    n: i + 1,
    id: String((s && s.id) || ""),
    title: String((s && s.title) || "").replace(/\s+/g, " ").trim(),
    turns: Number((s && s.turns) || 0),
    from: String((s && s.from) || ""),
    when: ago(s && s.mtime, now),
    body: String((s && s.body) || ""),   // 对话正文 + 产出文件名，只用来搜，不上屏
    current: String((s && s.id) || "") === cur,
  }));
}

/** 选单长什么样。标题列对齐按显示宽度算，id 甩在最后一列——它长短不一，放中间会把整张表撑歪 */
function sessionListText(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    return ["", "openworkbuddy> 还没有可以接的会话——先说一句话，或者在桌面端聊一句。", ""].join("\n");
  }
  const title = (r) => r.title || "无标题";
  const w = list.reduce((n, r) => Math.max(n, cols(title(r))), 0);
  const fw = list.reduce((n, r) => Math.max(n, cols(r.from)), 0);
  const tw = list.reduce((n, r) => Math.max(n, cols(r.turns + " 轮")), 0);
  const ww = list.reduce((n, r) => Math.max(n, cols(r.when)), 0);
  const line = (r) => {
    const bits = [padCols(title(r), w + GAP), padCols(r.from, fw), "· " + padCols(r.turns + " 轮", tw)];
    if (ww) bits.push("· " + padCols(r.when, ww));
    // 标记只用 ASCII，理由同 modelListText：> 是一列，▸ 在中文终端按两列画，那一行会歪
    return `${r.current ? ">" : " "} ${String(r.n).padStart(2)}  ${bits.join(" ")}  ${r.id}`.trimEnd();
  };
  const here = list.some((r) => r.current)
    ? "  带 > 的是你现在这条。接过去之后，现在这段不会丢，/resume 回来就是。"
    : "  你现在这条还没说过话，所以不在表里；接过去之后它就自然没了。";
  return ["", "openworkbuddy> 最近这些会话，接哪一条：", "", ...list.map(line), "",
    "  接一条：/resume 2　或　/resume 标题或对话里的几个字　或　/resume <会话id>",
    here, ""].join("\n");
}

/** 认出他说的是哪一条。序号、完整 id、标题或 id 的一部分都认；
 *  对上两条以上就把那几条报出来，不替他挑——挑错了是接进了另一段对话，比没接更难发现 */
function pickSessionRow(rows, arg) {
  const list = Array.isArray(rows) ? rows : [];
  const w = String(arg == null ? "" : arg).trim();
  if (!w) return { kind: "list" };
  if (/^\d+$/.test(w)) {
    const r = list.find((x) => x.n === Number(w));
    return r ? { kind: "ok", row: r }
      : { kind: "none", arg: w, why: list.length ? "序号只到 " + list.length : "一条会话都还没有" };
  }
  const lw = w.toLowerCase();
  const eq = list.filter((r) => r.id.toLowerCase() === lw);
  if (eq.length === 1) return { kind: "ok", row: eq[0] };
  const hit = list.filter((r) => (r.id + " " + r.title).toLowerCase().includes(lw));
  if (hit.length === 1) return { kind: "ok", row: hit[0] };
  if (hit.length > 1) return { kind: "many", arg: w, rows: hit };
  // 标题和 id 都没对上，再翻对话正文和产出文件名。放在最后而不是并进上面那一轮：
  // 标题对上的那条肯定是他要的，正文里提过一嘴的不一定，先给确定的
  const deep = list.filter((r) => String(r.body || "").toLowerCase().includes(lw));
  if (deep.length === 1) return { kind: "ok", row: deep[0] };
  if (deep.length > 1) return { kind: "many", arg: w, rows: deep };
  return { kind: "none", arg: w, why: "最近这些里没有对得上的" };
}

/* ── 通用选择器：↑↓ 挑、打字搜、回车定 ───────────────────────────────────
 * 以前 /resume 和 /model 都是「印一张表，你数着序号敲」。序号得用眼睛数，数错一位
 * 就接错会话、换错模型，而且会话一多就翻屏。Codex / Claude Code 的 /resume 是
 * 上下键挑 + 打字搜，这儿把那套补上，两个命令共用同一个，省得长出两种交互。
 *
 * 这一层只算「给一组行 + 搜索词 + 选中位，该画哪几行」，不碰终端也不上色：
 * 重画、收键、ANSI 都在 cli.js。行的形状统一成 { id, label, meta, hay }——
 * label 是主名字，meta 是右边那串灰字，hay 是拿来搜的（调用方把能搜的都拼进去）。
 */
const PICKER_ROWS = 8; // 一屏最多列这些，多了就滚动：超过一屏人就不看了，只会瞎按

function pickerRowsOf(list, make) {
  return (Array.isArray(list) ? list : []).map(make).filter(Boolean);
}

/** 空格分词，每个词都得命中——「周报 标题」这种想缩范围的写法才有意义。
 *  hay 是屏幕上看得见的那些字（标题、id、来源），deep 是看不见但搜得着的那一份（对话正文、产出文件名）。
 *  分两层是因为：标题是任务跑完自动起的，人从没读过一眼；他记得的是自己当时打的那句话，
 *  或者最后拿到的那个文件名。只靠 deep 对上的行会带个标记——屏幕上冒出一个看着不相干的标题，
 *  不说清为什么，人只会以为搜坏了。 */
function filterPickerRows(rows, q) {
  const list = Array.isArray(rows) ? rows : [];
  const w = String(q == null ? "" : q).trim().toLowerCase();
  if (!w) return list.slice();
  const words = w.split(/\s+/).filter(Boolean);
  const out = [];
  for (const r of list) {
    const hay = String((r && r.hay) || "").toLowerCase();
    if (words.every((x) => hay.includes(x))) { out.push(r); continue; }
    const deep = String((r && r.deep) || "").toLowerCase();
    if (deep && words.every((x) => hay.includes(x) || deep.includes(x))) out.push({ ...r, viaDeep: true });
  }
  return out;
}

/** 让选中项永远留在窗口里。列表比窗口短就整个显示，长了就把选中项摆中间 */
function pickerWindow(n, sel, max) {
  const total = Math.max(0, Number(n) || 0);
  const room = Math.max(1, Number(max) || PICKER_ROWS);
  if (total <= room) return { start: 0, end: total };
  const at = Math.max(0, Math.min(Number(sel) || 0, total - 1));
  let start = at - Math.floor(room / 2);
  start = Math.max(0, Math.min(start, total - room));
  return { start, end: start + room };
}

function pickerView(rows, o = {}) {
  const q = String(o.q == null ? "" : o.q);
  const max = Number(o.max) || PICKER_ROWS;
  const verb = String(o.verb || "选它");
  const hits = filterPickerRows(rows, q);
  const sel = hits.length ? Math.max(0, Math.min(Number(o.sel) || 0, hits.length - 1)) : -1;
  const { start, end } = pickerWindow(hits.length, sel, max);
  const win = hits.slice(start, end);
  const lw = win.reduce((w, r) => Math.max(w, cols(String((r && r.label) || ""))), 0);
  const lines = win.map((r, i) => {
    const at = start + i;
    const meta = r.viaDeep ? (r.meta ? r.meta + " · 对话里" : "对话里") : r.meta;
    const body = ` ${at === sel ? ">" : " "} ${padCols(String(r.label || ""), lw)}${meta ? "  " + meta : ""}`;
    return { text: body.replace(/\s+$/, ""), on: at === sel, row: r };
  });
  const head = String(o.title || "");
  // 搜索框一直摆着，不等人打了字才冒出来。原来是打了字才在标题后面回显一句「搜「周报」」——
  // 于是没打字的人根本不知道这儿能搜，而「打字搜」那三个字夹在脚注一串按键提示中间，没人会去读。
  // 一个空框杵在那儿、光标在里头闪，比一行提示管用：它不用读就看得懂。
  const typing = q.length > 0;
  const search = typing ? ` 搜索 › ${q}▌` : ` 搜索 › ▌  ${String(o.hint || "打字就筛")}`;
  // 有多少条没露出来要说清楚，不然人以为「就这几条」，其实还压着一屏
  const more = hits.length > win.length ? `　第 ${start + 1}-${end} 条 / 共 ${hits.length}` : "";
  const foot = hits.length
    ? `  ↑↓ 选 · 回车${verb} · Esc 算了${more}`
    : "  没有对得上的——退格删两个字，或者 Esc 算了";
  return { head, search, typing, lines, foot, hits, sel, total: hits.length, start, end };
}

/** /resume 的行 → 选择器的行 */
function sessionPickerRows(rows) {
  return pickerRowsOf(rows, (r) => ({
    id: String((r && r.id) || ""),
    label: String((r && r.title) || "") || "无标题",
    meta: [r && r.current ? "现在这条" : "", (r && r.from) || "", (r && r.turns) + " 轮", (r && r.when) || ""]
      .filter(Boolean).join(" · "),
    hay: [(r && r.title) || "", (r && r.id) || "", (r && r.from) || ""].join(" "),
    deep: String((r && r.body) || ""),
    row: r,
  }));
}

/** /model 的行 → 选择器的行。没装的引擎也列出来，但要写明装不了就选不了 */
function modelPickerRows(rows) {
  return pickerRowsOf(rows, (r) => ({
    id: String((r && r.key) || ""),
    label: String((r && r.label) || ""),
    meta: [r && r.current ? "在用" : "", (r && r.sub) || "", (r && r.tail) || "",
      r && !r.ready && r.install ? "装它：" + r.install : ""].filter(Boolean).join(" · "),
    hay: [(r && r.label) || "", (r && r.key) || "", (r && r.sub) || "", (r && r.tail) || ""].join(" "),
    row: r,
  }));
}

/** /init：让它自己把这个目录摸清楚，写成一份以后每趟都读得到的项目规范。
 *  这儿只出「说什么」和「交出去哪句话」——真去看目录、真落盘的是模型走正常那条路，
 *  于是权限档、改文件前的确认、/diff 里的记录一个都不少。绕过去自己写文件是最糟的做法：
 *  人按了个命令，盘上就多了个文件，中间什么都没问过。 */
function initTask(o = {}) {
  const has = String(o.has || "");             // 已经有 AGENTS.md / CLAUDE.md 的话，是哪个
  const note = has
    ? `已经有 ${has} 了——这趟是读完再增补，不整篇盖掉。\n`
    : "这就把目录看一遍，写一份 AGENTS.md 出来。\n";
  const prompt = [
    "把当前工作目录看一遍，写一份 AGENTS.md 放在目录根下，给以后接手这个项目的 AI 看。要求：",
    "1. 这个项目是干什么的；怎么跑起来、怎么跑测试——命令照抄你在 package.json / Makefile / 文档里真看到的那几条，一条都别编；",
    "2. 目录结构里哪几个是主干，新人最容易改错的是哪儿；",
    "3. 这个项目已经定下来的规矩（代码风格、提交信息格式、哪些文件不许动），只写你真找到依据的，找不到就不写这条，别拿通用建议凑数；",
    "4. 写成「接手前必须知道的十几条」，一条一行，不要写成说明书。",
    has ? `目录里已经有 ${has}，先完整读一遍，在它基础上增补和纠错，不要整篇覆盖。` : "",
    "写完告诉我你都依据了哪些文件——没依据的话直说没依据，别猜。",
  ].filter(Boolean).join("\n");
  return { note, prompt };
}

/** 体积说人话。不到 1K 的就报字节——「0.0K」看着像空文件，其实里头有东西 */
function sizeText(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + " K";
  if (n < 1024 * 1024 * 1024) return (n / 1048576).toFixed(1) + " M";
  return (n / 1073741824).toFixed(1) + " G";
}

/** /diff：这个会话动过哪些文件。
 *  「动过」只认 write_file / edit_file 两个工具的落点——模型嘴上说改了不算数，
 *  以工具调用为准。文件后来被人删了也照列，标成「没了」：悄悄不显示，等于替模型圆谎。 */
function changedFilesText(rows, o = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    return "这个会话还没动过文件。（只认 write_file / edit_file 真落到盘上的那些）\n";
  }
  const w = list.reduce((n, r) => Math.max(n, cols(String(r.path || ""))), 0);
  const out = [`这个会话动过 ${list.length} 个文件：`, ""];
  for (const r of list) {
    const tag = r.state === "gone" ? "没了" : (r.size != null ? r.size : "");
    out.push(`  ${padCols(String(r.path || ""), w + GAP)}${tag}${r.when ? "  " + r.when : ""}`.replace(/\s+$/, ""));
  }
  const git = String(o.git || "");
  out.push("");
  if (git) out.push("工作目录是 git 仓库，跟 HEAD 比：", "", git.replace(/\s+$/, ""), "");
  else out.push(o.notRepo ? "工作目录不是 git 仓库，给不了逐行 diff，只能列到文件这一层。" : "", "");
  return out.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n") + "\n";
}

/** /rewind：这个会话留过的检查点，一步一行。序号给人挑，id 不给人看 */
function checkpointListText(rows, now) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return "这个会话还没留过检查点。（write_file / edit_file 落盘前各留一份，改过才有得退）\n";
  const out = [`这个会话留了 ${list.length} 个检查点（序号越大越新）：`, ""];
  const w = String(list.length).length;
  // 时钟由调用方给（cli.js 传当前时间），这层不碰系统时间，测试才能逐帧推
  const t = Number(now) || Date.parse(list[list.length - 1].ts) || 0;
  list.forEach((r, i) => {
    const what = r.tool === "rewind" ? "回退" : r.before == null ? "新建" : r.after == null ? "删除" : "修改";
    const drift = r.current === "changed" ? "  （之后又被改过）" : "";
    out.push(`  ${String(i + 1).padStart(w)}. ${what} ${r.rel}  ${ago(Date.parse(r.ts), t)}${drift}`);
  });
  out.push("", "退回某一步之前：/rewind <序号>（那一步和它之后动过的文件一起退；退错了还能再 /rewind 回来）", "");
  return out.join("\n");
}

function pickCheckpoint(rows, arg) {
  const list = Array.isArray(rows) ? rows : [];
  const n = parseInt(String(arg || "").trim(), 10);
  if (!Number.isInteger(n) || n < 1 || n > list.length) return null;
  return list[n - 1];
}

/** 回退结果：每个文件一行说清是恢复了、删了、还是没动 */
function rewindResultText(r) {
  const files = r && Array.isArray(r.files) ? r.files : [];
  const word = { restored: "已恢复", deleted: "已删掉（那一步之前它还不存在）", unchanged: "没动（本来就是那样）", refused: "没退", missing: "没退", failed: "没退" };
  const n = files.filter((f) => f.action === "restored" || f.action === "deleted").length;
  const out = [n ? `退回去了，动了 ${n} 个文件：` : "没有文件需要退。"];
  for (const f of files) out.push(`  ${word[f.action] || f.action}  ${f.rel}${f.why ? `：${f.why}` : ""}`);
  if (n) out.push("", "退错了？/rewind 不带序号，最新那一步就是这次回退，退它就回来了。");
  out.push("");
  return out.join("\n");
}

/** /mcp：连接器接上了没有。没接上的要说清楚卡在哪儿，不然人只会反复重启 */
function mcpText(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    return "还没配外部连接器。设置 → 连接器 里加，或者写进 config.json 的 mcpServers。\n";
  }
  const w = list.reduce((n, r) => Math.max(n, cols(String(r.name || ""))), 0);
  const ok = list.filter((r) => r.ok).length;
  const out = [`连接器 ${list.length} 个，接上了 ${ok} 个：`, ""];
  for (const r of list) {
    const mark = r.ok ? "◆" : "×";
    const tail = r.ok ? `${r.tools || 0} 个工具` : (r.why || "没接上");
    out.push(`  ${mark} ${padCols(String(r.name || ""), w + GAP)}${tail}`);
  }
  out.push("");
  return out.join("\n") + "\n";
}

/** /compact：压完之后说人话，别只报个数字 */
function compactedText(before, after, removed) {
  const b = Number(before) || 0, a = Number(after) || 0;
  if (!removed) return "没压：最近几轮是要留着的，再往前没有可并的了——上下文一点没动。\n";
  const save = b > a ? Math.round(((b - a) / b) * 100) : 0;
  return `压好了：${removed} 条聊天记录并成 1 条摘要，上下文 ${Math.round(b / 1000)}k → ${Math.round(a / 1000)}k 字符` +
    `${save ? "，省了 " + save + "%" : ""}。原文归档在 data/compact-archive，没删。\n`;
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
    "openworkbuddy> 这儿能敲的命令：",
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
  RESUME_MAX, ago, sessionRows, sessionListText, pickSessionRow,
  PICKER_ROWS, pickerRowsOf, filterPickerRows, pickerWindow, pickerView, sessionPickerRows, modelPickerRows,
  sizeText, changedFilesText, checkpointListText, pickCheckpoint, rewindResultText, mcpText, compactedText, initTask,
  sanitizeHistory, nearest, find,
};
