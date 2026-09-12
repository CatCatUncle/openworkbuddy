"use strict";
/**
 * 命令行参数：一张声明表，解析和帮助都从它长出来。
 *
 * 之前是一串 else if 手写出来的，帮助文本另写一份。两处各改各的，迟早对不上；
 * 但真正让人吃亏的是另外三件事，全都**不吭声**：
 *
 *   1. 认不出来的词一律当成任务文本。`wb --qiet "写周报"` 里那个拼错的 --qiet 被原样
 *      塞给模型，进度照打、钱照花，人还以为自己关掉了。
 *   2. 要跟值的选项会把后面那个词囫囵吞掉。`wb --session --json "x"` 里 session 变成
 *      "--json"，而 --json 就此消失。
 *   3. `--mode crat` 照收不误。模式名写错了不会有人告诉你。
 *
 * 所以这里的规矩是：**认不出来就停下来问，绝不猜着往下走。** 停下来的那一句还要给出
 * 最接近的那个选项名——「没有 --qiet，你是不是想说 --quiet？」比一句「参数错误」有用得多。
 *
 * 唯一的例外是「看着就不像选项」的词：带空格、带中文的，一律当任务文本。
 * `wb "-- 这句话什么意思"` 得照常能用，人不该为了问一句以横杠开头的话去查文档。
 *
 * 这个文件是纯的：不读文件、不碰 process、不退出。它只把 argv 变成
 * { opts, words, problems }，要不要退出、退出码多少，由 cli.js 决定——
 * 这样每一句报错都能在测试里拿字符串对，而不是靠起一个进程去撞。
 */

/**
 * 选项表。type 决定怎么吃参数：
 *   bool   —— 不跟值；value 字段是它置进 opts 的值（--no-mcp 置 false）
 *   str    —— 必须跟一个值
 *   enum   —— 必须跟一个值，且值要在 choices 里
 *   optnum —— 可以跟一个正整数，不跟就用 fallback
 */
const FLAGS = [
  { long: "mode", type: "enum", key: "mode", arg: "craft|plan|ask", choices: ["craft", "plan", "ask"], desc: "执行模式（默认 craft）" },
  { long: "workspace", short: "C", type: "str", key: "workspace", arg: "<目录>", desc: "这次在哪个目录干活（只影响本次，不改配置）" },
  { long: "continue", short: "c", type: "bool", key: "cont", value: true, desc: "续接最近一次 CLI 会话" },
  { long: "session", type: "str", key: "session", arg: "<id>", desc: "续接指定会话" },
  { long: "list", type: "optnum", key: "list", arg: "[n]", fallback: 10, desc: "列出最近 n 个 CLI 会话（默认 10）" },
  { long: "json", type: "bool", key: "json", value: true, desc: "事件按 NDJSON 输出到 stdout，给脚本用" },
  { long: "quiet", short: "q", type: "bool", key: "quiet", value: true, desc: "只输出最终答案，不打进度" },
  { long: "raw", type: "bool", key: "raw", value: true, desc: "答案原样输出 Markdown，不在终端里渲染" },
  { long: "no-mcp", type: "bool", key: "mcp", value: false, desc: "跳过 MCP 连接器，启动更快" },
  { long: "version", short: "V", type: "bool", key: "version", value: true, desc: "打印版本号" },
  { long: "help", short: "h", type: "bool", key: "help", value: true, desc: "看这份帮助" },
];

/** 子命令表。帮助里那一段也是从这儿长出来的 */
const SUBS = [
  { name: "sessions", usage: "wb sessions [n]", desc: "列最近 n 个会话（桌面端开的也在里面）" },
  { name: "resume", usage: 'wb resume [id] ["接着做…"]', desc: "续接会话；不给 id 就接最近动过的那个" },
  { name: "engines", usage: "wb engines [use <id>]", desc: "看本机能拿什么当底层，或一键换过去" },
  { name: "doctor", usage: "wb doctor", desc: "跑不起来时先跑它：Node / 依赖 / 端口 / 配置 / 引擎 一次查清" },
];

const DEFAULTS = { mode: "craft", session: null, mcp: true, workspace: null, cont: false, json: false, quiet: false, raw: false, list: 0, help: false, version: false };

/** 编辑距离。只用来猜「你是不是想说 X」，不求快 */
function editDistance(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/** 最接近的那个选项名；差太远就不瞎猜（猜错了比不猜更让人迷糊） */
function nearestFlag(name, flags) {
  const bare = String(name).replace(/^--?/, "");
  let best = null, bestD = Infinity;
  for (const f of flags || FLAGS) {
    const d = editDistance(bare, f.long);
    if (d < bestD) { bestD = d; best = f; }
  }
  const limit = bare.length <= 4 ? 1 : 2;
  return best && bestD <= limit ? "--" + best.long : "";
}

function nearestSub(name, subs) {
  let best = null, bestD = Infinity;
  for (const s of subs || SUBS) {
    const d = editDistance(String(name), s.name);
    if (d < bestD) { bestD = d; best = s; }
  }
  return best && bestD > 0 && bestD <= 2 ? best.name : "";
}

/**
 * 这个以横杠开头的词，其实是句话吧？
 *
 * 带空格或者带中日韩字符的，当任务文本。`wb "-- 这句什么意思"`、`wb "-5 度穿什么"`
 * 都得照常能用；而 `--qiet`、`-x` 这种既没空格也没汉字的短词，就是拼错的选项，
 * 必须拦下来。
 */
function looksLikeProse(tok) {
  return /\s/.test(tok) || /[　-鿿＀-￯]/.test(tok);
}

function problem(code, message, hint) {
  return { code, message, hint: hint || "" };
}

/** 下一个词能不能当值用：它自己是个选项的话就不能，不然会把人的 --json 吃掉 */
function usableValue(tok) {
  if (tok === undefined) return false;
  if (tok === "-" || tok === "--") return false;
  if (!/^-/.test(tok)) return true;
  return looksLikeProse(tok);
}

/**
 * 解析 argv。纯函数：只返回结果，不打印、不退出。
 * 返回 { opts, words, problems }。problems 非空时，opts 里的东西一律不要用——
 * 参数都没读对，照着跑只会跑出个四不像。
 */
function parse(argv, spec) {
  const flags = (spec && spec.flags) || FLAGS;
  const subs = (spec && spec.subs) || SUBS;
  const opts = Object.assign({}, DEFAULTS, (spec && spec.defaults) || {});
  const words = [];
  const problems = [];
  const byLong = new Map(flags.map((f) => [f.long, f]));
  const byShort = new Map(flags.filter((f) => f.short).map((f) => [f.short, f]));

  const list = Array.isArray(argv) ? argv.slice() : [];
  let i = 0;
  let literal = false;

  // 把一个已经认出来的选项和它的值落进 opts
  const take = (f, inlineValue, source) => {
    if (f.type === "bool") {
      if (inlineValue !== null) {
        problems.push(problem("bool-has-value", `${source} 不需要跟值，写 ${source} 就行。`,
          `你写的是 ${source}=${inlineValue}。`));
        return;
      }
      opts[f.key] = f.value;
      return;
    }
    let v = inlineValue;
    if (v === null) {
      const next = list[i + 1];
      if (f.type === "optnum") {
        // [n] 是可选的：后面跟的是正整数才算它的值，别的一概不碰
        if (next !== undefined && /^\d+$/.test(next) && Number(next) > 0) { v = next; i++; }
        else { opts[f.key] = f.fallback; return; }
      } else if (!usableValue(next)) {
        problems.push(problem("missing-value", `${source} 后面要跟一个 ${f.arg}，但${next === undefined ? "它是最后一个词" : `后面跟的是 ${next}`}。`,
          `值本身以横杠开头的话，写成 ${source}=值。`));
        return;
      } else { v = next; i++; }
    }
    if (f.type === "enum" && !f.choices.includes(v)) {
      const near = f.choices.reduce((b, c) => (editDistance(v, c) < editDistance(v, b) ? c : b), f.choices[0]);
      problems.push(problem("bad-choice", `${source} 只能是 ${f.choices.join(" / ")}，你写的是 ${v}。`,
        editDistance(v, near) <= 2 ? `是不是想说 ${near}？` : ""));
      return;
    }
    if (f.type === "optnum") {
      const n = Number(v);
      if (!/^\d+$/.test(String(v)) || n <= 0) {
        problems.push(problem("bad-number", `${source} 要跟一个正整数，你写的是 ${v}。`, ""));
        return;
      }
      opts[f.key] = n;
      return;
    }
    opts[f.key] = v;
  };

  for (; i < list.length; i++) {
    const a = list[i];
    if (literal) { words.push(a); continue; }
    // -- 之后全是任务文本。想让任务以横杠开头，这是正路
    if (a === "--") { literal = true; continue; }
    // `--workspace=/tmp/工作区` 这种写法值里带中文，会被「看着像句话」的判据误伤，
    // 所以先认 `--名字=` 这个形状：长成这样的就是选项，不再问它像不像话
    const assign = /^--[A-Za-z][A-Za-z0-9-]*=/.test(a);
    if (a === "-" || !/^-/.test(a) || (looksLikeProse(a) && !assign)) { words.push(a); continue; }

    if (/^--/.test(a)) {
      const eq = a.indexOf("=");
      const name = (eq > 0 ? a.slice(2, eq) : a.slice(2));
      const inline = eq > 0 ? a.slice(eq + 1) : null;
      const f = byLong.get(name);
      if (!f) {
        const near = nearestFlag(name, flags);
        problems.push(problem("unknown-flag", `没有 --${name} 这个选项。`,
          near ? `是不是想说 ${near}？` : "wb --help 能看到全部选项；要把它当任务文本的话，前面加一个 --。"));
        continue;
      }
      take(f, inline, "--" + name);
      continue;
    }

    // 短选项，允许挤在一起写：-qc 等于 -q -c。要跟值的那个必须排在最后
    const chars = a.slice(1).split("");
    for (let k = 0; k < chars.length; k++) {
      const ch = chars[k];
      const f = byShort.get(ch);
      if (!f) {
        problems.push(problem("unknown-flag", `没有 -${ch} 这个选项。`,
          `wb --help 能看到全部选项；要把它当任务文本的话，前面加一个 --。`));
        continue;
      }
      if (f.type !== "bool" && k !== chars.length - 1) {
        problems.push(problem("short-value-not-last", `-${ch} 要跟一个 ${f.arg}，挤在 ${a} 中间读不出来。`,
          `拆开写：-${ch} 值。`));
        continue;
      }
      take(f, null, "-" + ch);
    }
  }

  // --list 只是列会话，它不跑任务。后面多出来的词从前是被默默扔掉的：
  // `wb --list abc` 列 10 条然后什么也不说，abc 去哪了没人知道
  if (!problems.length && opts.list && words.length && !subs.some((x) => x.name === words[0])) {
    problems.push(problem("list-has-words", `--list 只列会话，不跑任务，「${words.join(" ")}」用不上。`,
      `想列几条就写 --list 5；想跑任务就把 --list 去掉。`));
  }

  // 子命令拼错了最亏：认不出来就当任务发给模型，进度照走、钱照花。
  // 只在「整条命令就这一个词」时才拦——`wb "engine 是什么意思"` 不该被打扰
  if (!problems.length && words.length === 1 && !looksLikeProse(words[0]) && !subs.some((s) => s.name === words[0])) {
    const near = nearestSub(words[0], subs);
    if (near) {
      problems.push(problem("unknown-sub", `没有 wb ${words[0]} 这条命令。`,
        `是不是想说 wb ${near}？真要把「${words[0]}」当任务发出去的话，写成 wb -- ${words[0]}。`));
    }
  }

  return { opts, words, problems };
}

/** 帮助文本。选项那两段是从表里长出来的，改表就改了帮助，对不上是不可能的 */
function helpText(spec) {
  const flags = (spec && spec.flags) || FLAGS;
  const subs = (spec && spec.subs) || SUBS;
  // 对齐按显示宽度算：`wb resume [id] ["接着做…"]` 里有中文，按码位补空格会歪
  const { cols, padCols } = require("./text-width");
  const nameOf = (f) => (f.short ? `-${f.short}, --${f.long}` : `    --${f.long}`) + (f.type === "bool" ? "" : ` ${f.arg}`);
  const w = Math.max(...flags.map((f) => cols(nameOf(f))), ...subs.map((s) => cols(s.usage))) + 2;
  const pad = padCols;
  return `OpenWorkBuddy CLI
用法：
  wb "任务描述"                 单发任务（每次都是干净上下文）
  wb                            交互式对话（/help 看内置命令）
  cat 文件 | wb "问题"          管道内容作为附加材料
  wb -- "-以横杠开头的任务"     -- 之后一律当任务文本
子命令：
${subs.map((s) => `  ${pad(s.usage, w)}${s.desc}`).join("\n")}
选项：
${flags.map((f) => `  ${pad(nameOf(f), w)}${f.desc}`).join("\n")}
说明：
  答案走 stdout，进度走 stderr；退出码 0=成功 1=出错 2=参数写错了 130=Ctrl+C 打断。`;
}

/** 报错怎么写给人看。cli.js 只管把它打到 stderr 再退出 */
function problemText(problems) {
  return problems.map((p) => `${p.message}${p.hint ? "\n  " + p.hint : ""}`).join("\n") + "\n";
}

module.exports = { FLAGS, SUBS, DEFAULTS, parse, helpText, problemText, nearestFlag, nearestSub, looksLikeProse, editDistance };
