"use strict";
/**
 * 「名单之外的那条命令，跑之前先判一句」——命令闸上唯一一道不靠名单的闸。
 *
 * 今天 checkCommand 拦下一条命令，靠的是四张名单：文件黑名单、六条高危正则、
 * 询问名单、删除保护（rm 那一类）。四张都没命中，在「自动」档就是**一声不吭直接跑**。
 * 于是下面这些全是从旁边过去的：
 *
 *   git reset --hard / git clean -fdx / git checkout -- .   把没提交的改动冲干净
 *   truncate -s 0 x   : > x   cat a > 重要文件                把文件清空或者覆盖掉
 *   mv 重要目录 /tmp/x                                        没删，但也找不着了
 *   docker volume rm / pm2 delete / kubectl delete            连数据卷一起没
 *   npm publish / gh release delete / aws s3 rm --recursive   发出去了或者线上没了
 *
 * 这不是名单漏了几条，是**名单这个办法本身到头了**：每加一条都得先有人被坑过。
 * 高危表那六条能这么写，是因为它们必须精确——命中就弹审批，宁可漏也不能烦人。
 *
 * 所以这一层换了个分工：
 *   · 粗筛（这个文件里，免费）：这条命令有没有可能动东西。宁滥勿缺，判错了顶多多花一道题。
 *   · 判准（判断模型，两万分之一美金）：动的这下，撤不撤得回来。
 *
 * 三条边界，一条都不能松：
 *   1. **只往更谨慎那边动**：allow → ask。它不会替人放行，更不会替人拒绝——
 *      多问一句最坏是烦，少问一句最坏是一晚上的活儿没了。
 *   2. 说不准（确定度不够）、答不上、问不成、没配判断模型 —— 一律照今天的样子跑。
 *   3. 最后拍板的永远是人：它只负责把审批卡弹出来，卡上写清楚它为什么觉得悬。
 *
 * 这一层是纯的：不联网、不读配置、不打日志。发请求在 jev.js，接线在 tools.js。
 */

const so = require("./systemone");
const security = require("./security");

/** 是非题：这一条决定弹不弹审批卡 */
const RISK_KEY = "撤不撤得回来";
/** 单选题：只为了卡片上那句「为什么问你」有话可说——Jev 不会写字，理由只能是选项 */
const KIND_KEY = "最像哪一类";

/**
 * 确定度门槛。
 *
 * noul 的确定度是我们按概率离一半多远算的（sureOfNoul），所以 0.7 这个数
 * 等价于「它给的概率得到 0.85」。写在这儿是免得以后有人把它当成上游报的 confidence 调。
 */
const RISK_MIN = 0.7;

const KIND_CHOICES = {
  "删掉或者覆盖了拿不回来的东西": "文件、数据库、数据卷、没提交的改动——跑完就找不回来了",
  "改写了已经发出去的东西": "远端历史、线上配置、已经发布的版本，别人手上那份也跟着变",
  "把东西发到了外面": "发布、上传、推送、发消息、花钱——收不回来了",
  "只动了能重新生成的产物": "编译产物、缓存、日志、临时文件——大不了重跑一遍",
  "基本没有副作用": "读一读、看一看，什么也没改",
};

/** 只读的命令：整条命令每一段都在这里头，而且没往文件里写，才敢不花这道题的钱 */
const READ_ONLY = new Set([
  "ls", "ll", "cat", "bat", "head", "tail", "less", "more", "wc", "file", "stat", "du", "df",
  "pwd", "cd", "echo", "printf", "which", "whereis", "type", "whoami", "hostname", "id", "groups",
  "uname", "date", "uptime", "printenv", "locale", "man", "help", "true", "false",
  "grep", "egrep", "fgrep", "rg", "ag", "ack", "jq", "yq", "sort", "uniq", "cut", "tr", "column",
  "diff", "cmp", "md5", "md5sum", "shasum", "sha1sum", "sha256sum", "cksum",
  "basename", "dirname", "realpath", "readlink", "tree", "ps", "top", "nl", "rev", "fold",
  "expand", "xxd", "od", "strings", "seq", "tty", "arch", "sw_vers", "sysctl",
]);

/**
 * 带子命令的工具：整个工具没法一刀切，只认「这几个子命令确定不动东西」。
 * 宁可列少——列少了是多问一道题，列多了是真放过去了。
 */
const READ_ONLY_SUB = {
  git: new Set(["status", "log", "diff", "show", "blame", "describe", "rev-parse", "ls-files", "ls-remote", "shortlog", "grep", "cat-file", "whatchanged"]),
  npm: new Set(["ls", "list", "view", "info", "outdated", "why", "root", "bin", "ping", "whoami"]),
  pnpm: new Set(["ls", "list", "why", "outdated", "root", "bin"]),
  yarn: new Set(["list", "why", "info"]),
  pip: new Set(["list", "show", "freeze", "search"]),
  pip3: new Set(["list", "show", "freeze", "search"]),
  docker: new Set(["ps", "images", "logs", "inspect", "version", "info", "stats", "port", "top"]),
  kubectl: new Set(["get", "describe", "logs", "explain", "version", "top", "api-resources"]),
  brew: new Set(["list", "info", "search", "config", "--version"]),
  cargo: new Set(["tree", "metadata", "search"]),
  go: new Set(["version", "env", "list"]),
  systemctl: new Set(["status", "list-units", "show", "is-active", "is-enabled"]),
  pm2: new Set(["list", "ls", "status", "logs", "show", "describe", "info"]),
};

/** 只是包在真命令外面的壳，判断「这段到底在跑什么」之前得剥掉（跟 security.js 那份同源） */
const WRAPPERS = new Set(["nohup", "command", "builtin", "exec", "env", "time", "nice", "ionice", "xargs", "then", "else", "do", "{", "(", "sudo"]);

/**
 * 往文件里写。
 *
 * `2>&1`、`>/dev/null` 这些不算——它们不落盘。剩下的 `>` `>>` 一律算动了东西：
 * `cat 模板 > 配置文件` 这条的头是 cat，只看头的话是只读的，实际把人家配置盖了。
 */
const REDIRECT_RE = /(?:^|[^0-9&<>])>>?\s*(?!&)(?!\/dev\/(?:null|stdout|stderr|tty)\b)\S/;

const MEMO_MAX = 200;
/** 判过的命令原文 → null（判过、没事）或者那条升级后的裁定。只省钱，不省安全：判危险的照样每次弹卡 */
const memo = new Map();

function txt(x) { return String(x == null ? "" : x).trim(); }

/** 一段命令真正在跑的那个词：削掉前面的 VAR=值 和壳 */
function headOf(seg) {
  const parts = txt(seg).split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < parts.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[i]) || WRAPPERS.has(parts[i]))) i++;
  return parts[i] || "";
}

/** 这个词后面第一个不是选项的东西（git 的 status、npm 的 ls） */
function subOf(seg, head) {
  const parts = txt(seg).split(/\s+/).filter(Boolean);
  const at = parts.indexOf(head);
  for (let i = at + 1; i < parts.length; i++) {
    if (!parts[i].startsWith("-")) return parts[i];
  }
  return "";
}

/**
 * 这一段确定不动任何东西吗。
 * 只有「确定」才返回 true——认不出来的命令一律当成会动东西，去花那道题的钱。
 */
function readOnlySeg(seg) {
  const s = txt(seg);
  if (!s) return true;
  if (REDIRECT_RE.test(s)) return false;
  const head = headOf(s).replace(/^.*\//, ""); // /usr/bin/ls → ls
  if (!head) return true;
  // 拆段是按 & 拆的，`2>&1` 会在后面留下孤零零一个 "1"。它不是命令，
  // 认不出来就当成会动东西的话，每条带 2>&1 的命令都要白花一道题。
  if (!/[A-Za-z]/.test(head)) return true;
  const sub = READ_ONLY_SUB[head];
  if (sub) return sub.has(subOf(s, headOf(s)));
  // 剩下的：在只读表里才算数。find / sed / perl / tee 这些故意没进表——
  // 它们带上一个开关就开始写（-delete、-i、-exec），认起来不比认整条命令省事
  return READ_ONLY.has(head);
}

/** 整条命令里第一段「可能动东西」的。全都只读就返回空字符串——这趟不花钱 */
function firstMutating(command) {
  for (const seg of security.splitSegments(command)) {
    if (!readOnlySeg(seg)) return seg;
  }
  return "";
}

/**
 * run_node 那扇门的粗筛。
 *
 * 只守 shell 一扇门是守不住的——同一个 agent 写一句 fs.rmSync 就从旁边过去了，
 * checkCode 今天只拦两样：碰文件黑名单、开子进程。剩下的在「自动」档一样是直接跑。
 * 这儿认的是**会动东西的那几个调用**，认不出来就不花钱，跟命令那边一个道理。
 */
const CODE_MUTATE_RE = new RegExp(
  "\\b(?:fs|fsp|fse)\\s*\\.\\s*(?:promises\\s*\\.\\s*)?" +
  // mkdir / appendFile / open 故意不在里头：建个目录、往后接一段、打开个句柄，
  // 本身都不毁东西，列进来等于每个存结果的脚本都白花一道题
  "(rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|truncate|truncateSync|writeFile|writeFileSync|" +
  "rename|renameSync|copyFile|copyFileSync|cp|cpSync|chmod|chmodSync|chown|chownSync|" +
  "createWriteStream)\\b" +
  "|\\brimraf\\b|\\bshelljs\\b" +
  "|\\bmethod\\s*:\\s*[\"'`](?:POST|PUT|PATCH|DELETE)[\"'`]"
);

function firstMutatingCode(code) {
  const m = CODE_MUTATE_RE.exec(String(code || ""));
  return m ? m[0] : "";
}

/**
 * 这一趟该不该花这道题的钱。返回那段可疑的命令（真值）或者空字符串。
 *
 * 四道免费的闸挡在前面，顺序是有讲究的：
 *   · 裁定不是 allow —— 已经要问或者要拦了，再判一遍改不了结论，纯浪费；
 *   · 安全网关关着 —— 用户明说了「别拦我」，这时候弹卡是不听人话；
 *   · 开关没打开 —— 默认就是关的；
 *   · 整条命令每一段都只读 —— 结构上就确定没事，答案是白买的。
 */
function needsJudge({ verdict, sec, text, kind } = {}) {
  if (!verdict || verdict.action !== "allow") return "";
  const s = sec || {};
  if (!s.gateway) return "";
  if (s.cmd_risk_gate !== true) return "";
  return kind === "代码" ? firstMutatingCode(text) : firstMutating(text);
}

function riskQuestions(kind) {
  const it = kind === "代码" ? "这段代码" : "这条命令";
  return {
    [RISK_KEY]: so.noul(
      it + "跑下去，会不会造成撤不回来的损失：删掉或者覆盖了没法再生成的东西、" +
      "把没保存的改动冲掉、改写了已经发出去的历史、对外发布、花钱。" +
      "能重新跑一遍就拿回来的不算（编译产物、缓存、日志、临时文件、装依赖）。"
    ),
    [KIND_KEY]: so.choice("要是真出事了，最像下面哪一类", KIND_CHOICES),
  };
}

const CMD_CHARS = 1500;

/**
 * 摆给它看的现场。
 *
 * 只给这三样，一样都不多：这段要发到外面去，工作目录的绝对路径里带着用户名和家目录，
 * 判断这条命令危不危险用不着知道它跑在谁的电脑上。
 */
function riskState({ text, seg, where, mode, kind } = {}) {
  const code = kind === "代码";
  const cmd = txt(text);
  const one = txt(seg);
  return [
    (code ? "【它要跑的代码】\n" : "【它要跑的命令】\n") + (cmd.slice(0, CMD_CHARS) || "（空的）"),
    (code ? "【这几个调用会动东西】\n" : "【其中这一段是名单外的】\n") + (one.slice(0, CMD_CHARS) || "（没挑出来）"),
    "【跑在哪儿】\n工作目录：" + (txt(where) || "工作空间根目录") + "；当前权限档位：" + (txt(mode) || "自动"),
  ].join("\n\n");
}

/**
 * 回答读成「要不要弹卡」。
 *
 * 只有两头都够硬才拦：它说会出事（概率过半），而且自己也拿得准（确定度到门槛）。
 * 说不准就照旧跑——那正是今天的行为，不算退步；硬拦才是拿它的犹豫去烦人。
 */
function readRisk(out, min) {
  const bar = Number.isFinite(Number(min)) ? Number(min) : RISK_MIN;
  const answers = (out && out.answers) || [];
  const a = answers.find((x) => x && x.key === RISK_KEY);
  // 「没答上来」要判得死一点：上游哪天把这道是非题当成单选答了，value 会是一句话，
  // 拿它去跟 0.5 比谁大谁小，比出来的东西没有意义，卡照样弹得出来
  if (!a || !Number.isFinite(Number(a.value))) return null; // 没答上来
  // 倒向「撤得回来」也是有主意的：0.02 算出来的确定度是 96%，只看确定度那道闸正好拦反
  if (Number(a.value) < 0.5) return null;   // 它说撤得回来
  if (!so.gate(a, bar).act) return null;    // 它说撤不回来，但自己也拿不准
  const k = answers.find((x) => x && x.key === KIND_KEY);
  return { sure: Number(a.sure) || 0, p: Number(a.value), bar, label: (k && k.value) || "" };
}

/** 审批卡上那句「为什么问你」。卡片上只有这一行的位置，所以理由和确定度得挤在一句里 */
function riskRule(d) {
  const why = d && d.label ? "：" + d.label : "";
  return `判断模型觉得这条撤不回来${why}（确定度 ${so.pct(d && d.sure)}）`;
}

/**
 * 升级后的裁定。ruleKey 用的是 security.ruleFor（命令 + 子命令这一级）：
 * 审批卡上那个「以后别再问这类」按下去，本次运行期间同类不再烦人，
 * 又不会因为批过 `git reset --soft` 就把 `git push -f` 一起放过去。
 */
function upgrade(seg, d, kind) {
  // 代码那扇门不给 ruleKey：命令的「以后别再问」是按「命令 + 子命令」记的，
  // 代码这边同一个 key 底下什么都能写，按一下等于把整扇门敞开
  const ruleKey = kind === "代码" ? "" : security.ruleFor(seg);
  return { action: "ask", rule: riskRule(d), seg: txt(seg), ruleKey };
}

function memoKey(command) { return txt(command).replace(/\s+/g, " "); }

/** 判过没有。命中返回 { hit: true, verdict }，verdict 为 null 表示「判过，没事」 */
function recall(command) {
  const k = memoKey(command);
  return memo.has(k) ? { hit: true, verdict: memo.get(k) } : { hit: false, verdict: null };
}

/** 记下这一条判过了。同一条命令在一次运行里问第二遍，是拿钱买一个已经知道的答案 */
function remember(command, verdict) {
  const k = memoKey(command);
  if (!k) return;
  if (!memo.has(k) && memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value);
  memo.set(k, verdict || null);
}

function forget() { memo.clear(); }

module.exports = {
  RISK_KEY, KIND_KEY, RISK_MIN, KIND_CHOICES, CMD_CHARS, MEMO_MAX,
  headOf, subOf, readOnlySeg, firstMutating, firstMutatingCode, CODE_MUTATE_RE, needsJudge,
  riskQuestions, riskState, readRisk, riskRule, upgrade,
  recall, remember, forget,
};
