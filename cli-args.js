// @ts-check
"use strict";
/**
 * 命令行参数：一张声明表，解析和帮助都从它长出来。
 *
 * 之前是一串 else if 手写出来的，帮助文本另写一份。两处各改各的，迟早对不上；
 * 但真正让人吃亏的是另外三件事，全都**不吭声**：
 *
 *   1. 认不出来的词一律当成任务文本。`openworkbuddy --qiet "写周报"` 里那个拼错的 --qiet 被原样
 *      塞给模型，进度照打、钱照花，人还以为自己关掉了。
 *   2. 要跟值的选项会把后面那个词囫囵吞掉。`openworkbuddy --session --json "x"` 里 session 变成
 *      "--json"，而 --json 就此消失。
 *   3. `--mode crat` 照收不误。模式名写错了不会有人告诉你。
 *
 * 所以这里的规矩是：**认不出来就停下来问，绝不猜着往下走。** 停下来的那一句还要给出
 * 最接近的那个选项名——「没有 --qiet，你是不是想说 --quiet？」比一句「参数错误」有用得多。
 *
 * 唯一的例外是「看着就不像选项」的词：带空格、带中文的，一律当任务文本。
 * `openworkbuddy "-- 这句话什么意思"` 得照常能用，人不该为了问一句以横杠开头的话去查文档。
 *
 * 模式那一列不在这儿写死：从 modes.js 取。以前它是手抄的 `["craft","plan","ask"]`，
 * 界面上那个 goal 抄漏了，于是 `openworkbuddy --mode goal` 被这张表当成「不认识的模式」挡在门外——
 * 用户在网页上天天用的模式，到了终端里说没有。modes.js 是纯数据文件，引它不违反上面那条「纯」。
 *
 * 这个文件是纯的：不读文件、不碰 process、不退出。它只把 argv 变成
 * { opts, words, problems }，要不要退出、退出码多少，由 cli.js 决定——
 * 这样每一句报错都能在测试里拿字符串对，而不是靠起一个进程去撞。
 */

const { MODE_IDS, MODE_ARG } = require("./modes"); // 执行模式的唯一真源
const { PERMISSION_MODES } = require("./security"); // 权限档的唯一真源，跟网页那四档是同一份
const PERM_IDS = Object.keys(PERMISSION_MODES);
const PERM_ARG = PERM_IDS.join("|"); // 跟 MODE_ARG 一个写法：不带尖括号，帮助里直接印取值

/**
 * 选项表。type 决定怎么吃参数：
 *   bool   —— 不跟值；value 字段是它置进 opts 的值（--no-mcp 置 false）
 *   str    —— 必须跟一个值
 *   enum   —— 必须跟一个值，且值要在 choices 里
 *   optnum —— 可以跟一个正整数，不跟就用 fallback
 *   num    —— 必须跟一个正整数，不超过 max
 *   strs   —— 必须跟一个值，可以重复写几次，攒成一个数组
 */
const FLAGS = [
  { long: "mode", type: "enum", key: "mode", arg: MODE_ARG, choices: MODE_IDS, desc: "执行模式（默认 craft）" },
  { long: "perm", type: "enum", key: "perm", arg: PERM_ARG, choices: PERM_IDS, desc: "这一次放多少权（默认按配置，改不了配置文件）" },
  { long: "workspace", short: "C", type: "str", key: "workspace", arg: "<目录>", desc: "这次在哪个目录干活（只影响本次，不改配置）" },
  { long: "file", short: "f", type: "strs", key: "files", arg: "<路径>", desc: "带一个文件/图片一起问，可以重复写几次" },
  { long: "continue", short: "c", type: "bool", key: "cont", value: true, desc: "续接最近一次 CLI 会话" },
  { long: "session", type: "str", key: "session", arg: "<id>", desc: "续接指定会话" },
  { long: "list", type: "optnum", key: "list", arg: "[n]", fallback: 10, desc: "列出最近 n 个 CLI 会话（默认 10）" },
  { long: "model", type: "str", key: "model", arg: "<名字>", desc: "这一次用哪个模型（配置里 models 的名字或 id；不改配置）" },
  { long: "max-steps", type: "num", key: "maxSteps", arg: "<n>", max: 500, desc: "这一次最多走几步（默认按配置，上限 500）" },
  { long: "append-system", type: "str", key: "appendSystem", arg: "<文字>", desc: "给这一次追加一段规矩，比如「只用 TypeScript」" },
  { long: "json", type: "bool", key: "json", value: true, desc: "事件按 NDJSON 输出到 stdout，给脚本用" },
  { long: "quiet", short: "q", type: "bool", key: "quiet", value: true, desc: "只输出最终答案，不打进度" },
  { long: "raw", type: "bool", key: "raw", value: true, desc: "答案原样输出 Markdown，不在终端里渲染" },
  { long: "no-mcp", type: "bool", key: "mcp", value: false, desc: "跳过 MCP 连接器，启动更快" },
  { long: "ask-remote", type: "bool", key: "askRemote", value: true, desc: "没人坐在终端前也允许 agent 提问，答案从手机上给" },
  { long: "off", type: "bool", key: "off", value: true, desc: "配合 openworkbuddy 2fa：真的把那个账号的二次验证关掉（不写就只看状态）" },
  { long: "score", type: "bool", key: "score", value: true, desc: "配合 openworkbuddy jev：把后面那几个选项当成从低到高的档位，问一道打分题" },
  { long: "version", short: "V", type: "bool", key: "version", value: true, desc: "打印版本号" },
  { long: "help", short: "h", type: "bool", key: "help", value: true, desc: "看这份帮助" },
];

/** 子命令表。帮助里那一段也是从这儿长出来的 */
const SUBS = [
  { name: "sessions", usage: "openworkbuddy sessions [n]", desc: "列最近 n 个会话（桌面端开的也在里面）" },
  { name: "resume", usage: 'openworkbuddy resume [id] ["接着做…"]', desc: "续接会话；不给 id 就接最近动过的那个" },
  { name: "engines", usage: "openworkbuddy engines [use <id>]", desc: "看本机能拿什么当底层，或一键换过去" },
  { name: "doctor", usage: "openworkbuddy doctor", desc: "跑不起来时先跑它：Node / 依赖 / 端口 / 配置 / 引擎 一次查清" },
  { name: "pair", usage: "openworkbuddy pair", desc: "把手机/另一台电脑连上来：出一个二维码，扫了就能用，密码不用敲过去" },
  { name: "passwd", usage: 'openworkbuddy passwd <用户名> ["新密码"]', desc: "忘了密码：在服务器上改回来（不给新密码就随机生成一串）" },
  { name: "2fa", usage: "openworkbuddy 2fa <用户名> [--off]", desc: "看某个账号的二次验证状态；手机丢了用 --off 关掉" },
  { name: "owner", usage: "openworkbuddy owner [用户名]", desc: "看谁是超级管理员；给用户名就把这个位子指给他（唯一的超管进不去时的救场口）" },
  { name: "jev", usage: 'openworkbuddy jev ["材料" "问题" [选项…]]', desc: "问一下判断模型：它不写字，只回选项/分数/概率，外加一个「有多确定」。不给参数就测活" },
  { name: "workflow", usage: "openworkbuddy workflow <流程.json>", desc: "按文件里写好的几步依次跑，{{名字}} 把前面某一步的结论贴进来；一步没成后面就停" },
  { name: "review", usage: "openworkbuddy review [基准分支]", desc: "把改动当别人的代码挑一遍毛病，只审不改；不给基准就审还没提交的" },
  { name: "worktree", usage: "openworkbuddy worktree [清理]", desc: "看有哪些「分身」：两条任务同时改一个仓库时，后来那条会去自己的 git worktree 里改" },
  { name: "completion", usage: "openworkbuddy completion <shell>", desc: "生成 Tab 补全脚本（bash / zsh / fish）" },
];

const DEFAULTS = { mode: "craft", session: null, mcp: true, workspace: null, files: [], cont: false, json: false, quiet: false, raw: false, list: 0, help: false, version: false, askRemote: false, off: false, score: false, perm: null, model: null, maxSteps: null, appendSystem: null };

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
 * 带空格或者带中日韩字符的，当任务文本。`openworkbuddy "-- 这句什么意思"`、`openworkbuddy "-5 度穿什么"`
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
  // 数组类的默认值要复制一份：Object.assign 抄的是同一个引用，不复制的话这次解析
  // 攒进去的 -f 会留在 DEFAULTS 上，下一次解析凭空多出上一次的文件
  for (const k of Object.keys(opts)) if (Array.isArray(opts[k])) opts[k] = opts[k].slice();
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
    if (f.type === "strs") { opts[f.key] = (opts[f.key] || []).concat(v); return; }
    if (f.type === "num") {
      const n = Number(v);
      if (!/^\d+$/.test(String(v)) || n <= 0 || n > f.max) {
        problems.push(problem("bad-number", `${source} 要跟 1 到 ${f.max} 之间的整数，你写的是 ${v}。`, ""));
        return;
      }
      opts[f.key] = n;
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
          near ? `是不是想说 ${near}？` : "openworkbuddy --help 能看到全部选项；要把它当任务文本的话，前面加一个 --。"));
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
          `openworkbuddy --help 能看到全部选项；要把它当任务文本的话，前面加一个 --。`));
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
  // `openworkbuddy --list abc` 列 10 条然后什么也不说，abc 去哪了没人知道
  if (!problems.length && opts.list && words.length && !subs.some((x) => x.name === words[0])) {
    problems.push(problem("list-has-words", `--list 只列会话，不跑任务，「${words.join(" ")}」用不上。`,
      `想列几条就写 --list 5；想跑任务就把 --list 去掉。`));
  }

  // 子命令拼错了最亏：认不出来就当任务发给模型，进度照走、钱照花。
  // 只在「整条命令就这一个词」时才拦——`openworkbuddy "engine 是什么意思"` 不该被打扰
  if (!problems.length && words.length === 1 && !looksLikeProse(words[0]) && !subs.some((s) => s.name === words[0])) {
    const near = nearestSub(words[0], subs);
    if (near) {
      problems.push(problem("unknown-sub", `没有 openworkbuddy ${words[0]} 这条命令。`,
        `是不是想说 openworkbuddy ${near}？真要把「${words[0]}」当任务发出去的话，写成 openworkbuddy -- ${words[0]}。`));
    }
  }

  return { opts, words, problems };
}

/** 帮助文本。选项那两段是从表里长出来的，改表就改了帮助，对不上是不可能的 */
function helpText(spec) {
  const flags = (spec && spec.flags) || FLAGS;
  const subs = (spec && spec.subs) || SUBS;
  // 对齐按显示宽度算：`openworkbuddy resume [id] ["接着做…"]` 里有中文，按码位补空格会歪
  const { cols, padCols } = require("./text-width");
  const nameOf = (f) => (f.short ? `-${f.short}, --${f.long}` : `    --${f.long}`) + (f.type === "bool" ? "" : ` ${f.arg}`);
  const w = Math.max(...flags.map((f) => cols(nameOf(f))), ...subs.map((s) => cols(s.usage))) + 2;
  const pad = padCols;
  return `OpenWorkBuddy CLI
用法：
  openworkbuddy "任务描述"                 单发任务（每次都是干净上下文）
  openworkbuddy                            交互式对话（/help 看内置命令）
  cat 文件 | openworkbuddy "问题"          管道内容作为附加材料
  openworkbuddy -- "-以横杠开头的任务"     -- 之后一律当任务文本
子命令：
${subs.map((s) => `  ${pad(s.usage, w)}${s.desc}`).join("\n")}
选项：
${flags.map((f) => `  ${pad(nameOf(f), w)}${f.desc}`).join("\n")}
说明：
  答案走 stdout，进度走 stderr；退出码 0=成功 1=出错 2=参数写错了 130=Ctrl+C 打断。`;
}

/**
 * Tab 补全脚本。三种 shell 各生成一份，全都从上面那张 FLAGS / SUBS 表长出来。
 *
 * 为什么非得从同一张表生成：补全脚本是最容易烂掉的那种东西——加一个选项，帮助里有了、
 * 解析认了，补全还停在半年前。人按 Tab 补不出来，只会以为这个选项不存在。
 * 从表里长出来就没有「忘了同步」这回事，加一行 FLAGS 三种 shell 同时就有了。
 *
 * 会话 id 的补全把目录路径**烤进脚本**，而不是每次按 Tab 去起一个 node 进程问一遍：
 * `openworkbuddy` 启动要过 boot-check、要 require 一堆东西，按一下 Tab 等半秒是不能接受的。
 * 代价是数据目录搬了家得重新生成一次——所以生成出来的脚本头上写了这句话。
 *
 * @param {"bash"|"zsh"|"fish"} shell
 * @param {{sessionsDir?: string, engines?: string[]}} [ctx] 烤进脚本的本机信息
 * @returns {string}
 */
function completionScript(shell, ctx) {
  const c = ctx || {};
  const dir = String(c.sessionsDir || "");
  const engines = (c.engines || []).join(" ");
  const subs = SUBS.map((x) => x.name).join(" ");
  const longs = FLAGS.map((f) => "--" + f.long);
  const shorts = FLAGS.filter((f) => f.short).map((f) => "-" + f.short);
  const all = longs.concat(shorts).join(" ");
  const modes = (FLAGS.find((f) => f.long === "mode") || {}).choices || [];
  const head = `# OpenWorkBuddy CLI 的 Tab 补全（openworkbuddy completion ${shell} 生成）
# 会话 id 那一项认的是生成时的数据目录；换过 OPENWORKBUDDY_HOME 就重新生成一次。`;

  if (shell === "fish") {
    const lines = [head, "", "complete -c openworkbuddy -f"];
    for (const x of SUBS) lines.push(`complete -c openworkbuddy -n __fish_use_subcommand -a ${x.name} -d ${q(x.desc)}`);
    for (const f of FLAGS) {
      const bits = [`complete -c openworkbuddy -l ${f.long}`];
      if (f.short) bits.push(`-s ${f.short}`);
      if (f.type !== "bool") bits.push("-r");
      if (f.choices) bits.push(`-a ${q(f.choices.join(" "))}`);
      if (f.long === "workspace") bits.push("-F");
      if (f.long === "file") bits.push("-F");
      bits.push(`-d ${q(f.desc)}`);
      lines.push(bits.join(" "));
    }
    lines.push(`complete -c openworkbuddy -n '__fish_seen_subcommand_from engines' -a 'use ${engines}'`);
    if (dir) lines.push(`complete -c openworkbuddy -n '__fish_seen_subcommand_from resume' -a "(command ls ${sh(dir)} 2>/dev/null | string replace -r '\\.json$' '')"`);
    return lines.join("\n") + "\n";
  }

  if (shell === "zsh") {
    // _arguments 带描述：zsh 是 macOS 的默认 shell，`openworkbuddy -<TAB>` 直接把中文说明列出来，
    // 这是三种 shell 里唯一能把 desc 用起来的
    const spec = FLAGS.map((f) => {
      const names = f.short ? `{-${f.short},--${f.long}}` : `--${f.long}`;
      const act = f.choices ? `:模式:(${f.choices.join(" ")})`
        : f.long === "workspace" ? ":目录:_files -/"
        : f.long === "file" ? ":文件:_files"
        : f.type === "bool" ? "" : ":值:";
      // 可重复的那个前面要加 *，而且这个 * 必须**自己带引号**：
      // 写成 `*{-f,--file}'[说明]'` 的话，花括号展开出来是 `*-f'[说明]'`——一个 * 没引号、
      // 后面跟着方括号，zsh 会拿它当通配符去匹配文件名，当场 "no matches found"，
      // 整个补全函数就废了。'*' 单独引起来就没有裸的通配符了。
      const rep = f.type === "strs" ? "'*'" : "";
      return `    ${rep}${names}'[${z(f.desc)}]${act}'`;
    }).join(" \\\n");
    return `#compdef openworkbuddy
${head}
_openworkbuddy() {
  local -a subs
  subs=(
${SUBS.map((x) => `    '${x.name}:${z(x.desc)}'`).join("\n")}
  )
  if (( CURRENT == 2 )) && [[ "$words[2]" != -* ]]; then
    _describe -t commands '子命令' subs && return
  fi
  case "$words[2]" in
    engines) _values '引擎' use ${engines}; return;;
    resume)  ${dir ? `_values '会话' \${(f)"$(command ls ${sh(dir)} 2>/dev/null | sed 's/\\.json$//')"}; return;;` : "return;;"}
  esac
  _arguments -s \\
${spec} \\
    '*:任务描述:_files'
}
_openworkbuddy "$@"
`;
  }

  // bash：没有描述这一说，给词就行
  return `${head}
_openworkbuddy_complete() {
  local cur prev
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  case "$prev" in
    --mode) COMPREPLY=( $(compgen -W ${q(modes.join(" "))} -- "$cur") ); return;;
    -C|--workspace) COMPREPLY=( $(compgen -d -- "$cur") ); return;;
    -f|--file) COMPREPLY=( $(compgen -f -- "$cur") ); return;;
    --session) COMPREPLY=( $(compgen -W "$(command ls ${dir ? sh(dir) : '""'} 2>/dev/null | sed 's/\\.json$//')" -- "$cur") ); return;;
    engines) COMPREPLY=( $(compgen -W "use ${engines}" -- "$cur") ); return;;
    resume) COMPREPLY=( $(compgen -W "$(command ls ${dir ? sh(dir) : '""'} 2>/dev/null | sed 's/\\.json$//')" -- "$cur") ); return;;
  esac
  if [[ "$cur" == -* ]]; then COMPREPLY=( $(compgen -W ${q(all)} -- "$cur") ); return; fi
  if (( COMP_CWORD == 1 )); then COMPREPLY=( $(compgen -W ${q(subs)} -- "$cur") ); return; fi
  COMPREPLY=( $(compgen -f -- "$cur") )
}
complete -F _openworkbuddy_complete openworkbuddy
`;
}

/** 塞进单引号里。shell 的单引号内没有转义，收尾再开一个是唯一的写法 */
const sh = (s) => "'" + String(s).replace(/'/g, `'\\''`) + "'";
const q = sh;
/** zsh 的描述在方括号里，方括号和冒号得躲开，不然 _arguments 会把说明读成语法 */
const z = (s) => String(s).replace(/[\[\]:'"]/g, " ");

/** 报错怎么写给人看。cli.js 只管把它打到 stderr 再退出 */
function problemText(problems) {
  return problems.map((p) => `${p.message}${p.hint ? "\n  " + p.hint : ""}`).join("\n") + "\n";
}

module.exports = { FLAGS, SUBS, DEFAULTS, parse, helpText, problemText, completionScript, nearestFlag, nearestSub, looksLikeProse, editDistance };
