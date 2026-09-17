"use strict";
/**
 * toolward —— 技能 / 连接器安全检查的第二双眼睛。
 *
 * 为什么要接第二把尺子：skill-guard 是我们自己写的，规则照着**我们见过的**攻击写。
 * 见过的写法它认得，没见过的一条都不会响——而且我们并不知道自己没见过什么。
 * toolward（github.com/CatCatUncle/toolward）是另一拨人照着另一批案例写的 37 条规则，
 * 分六族：提示词注入与工具投毒（TW1xx）、供应链（TW2xx）、密钥（TW3xx）、
 * 执行与权限（TW4xx）、网络与外传（TW5xx）、治理（TW6xx）。
 * 两把尺子量同一段字：重合的互相印证，不重合的那部分才是真多出来的覆盖面。
 *
 * 三条边界写死在这儿，别在别处放宽：
 *
 * 1. **不进 package.json 的依赖。** toolward 是 PolyForm Noncommercial 1.0.0 授权：
 *    个人、教学、学术、公益、政府免费；公司里用要单独授权（条款见 toolward 仓库的
 *    LICENSE）。把它写进 dependencies，等于替每一个把 OpenWorkBuddy 用在
 *    商业场景里的人做了决定，还是个会让他们违约的决定。所以它是**外挂的第二意见**：
 *    装了就用，没装照跑，界面上给一行安装命令和这句授权说明，装不装是用户自己的事。
 *
 * 2. **不 npx。** `npx -y toolward` 每跑一次都现拉一个没人审过的版本——这正是 toolward
 *    自己 TW2xx 那族要拦的事。为了做一次安全检查先干一件不安全的事，说不过去。
 *    只认磁盘上已经装好的那个可执行文件（PATH 上找，或设置里指死一个路径）。
 *
 * 3. **它崩了不算拦。** 超时、退出码不对、输出不是 JSON、新版本换了字段——一律当它没跑过，
 *    装还是照装（skill-guard 那道闸一个字不放松）。一个可选的第二意见要是能因为自己挂了
 *    而挡住安装，它就不再是可选的了，而是一个没写进 package.json 的必需依赖。
 *
 * 输出刻意做成跟 skill-guard.scanDir 一模一样的形状，于是 gate()、explain()、
 * .install.json 三处一行都不用改，merge() 拼一下就完事。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const log = require("./log");
const security = require("./security");
const { dataPath } = require("./paths");

/** 扫一个技能目录给多久。再久用户就该以为界面卡死了 */
const SCAN_TIMEOUT_MS = 20000;
/** 扫一份连接器配置给多久。就一个几 KB 的 json，不该要这么久 */
const QUICK_TIMEOUT_MS = 10000;
const PROBE_TIMEOUT_MS = 8000;
const MAX_OUTPUT = 16 * 1024 * 1024;
/** 探到的位置缓存多久。Electron 里每装一个技能重探一遍 PATH 是白花钱 */
const PROBE_TTL_MS = 60 * 1000;
/** 它自己崩过一次之后，多久之内不再叫它。不设这个的话每次安装都要白等一趟超时 */
const COOLOFF_MS = 5 * 60 * 1000;
/** 跟 skill-guard 对齐：合并之后一份报告最多列这么多条 */
const MAX_FINDINGS = 60;
/** 同一条规则在同一个文件里最多列几处。够定位就行 */
const PER_RULE_HITS = 3;

const INSTALL_HINT = "npm i -g toolward";
const LICENCE_NOTE =
  "toolward 是 PolyForm Noncommercial 1.0.0 授权：个人、教学、学术、公益、政府免费用；" +
  "公司里用要单独授权（条款见 toolward 仓库的 LICENSE）。" +
  "所以它不在 OpenWorkBuddy 的依赖里，装不装由你决定。";

/**
 * toolward 的 severity → 我们这边的 level。
 *
 * critical 才拦：那一族是「这段字会让 agent 去读你的凭据并发出去」这种程度的命中，
 * 不拦的话这道闸就只是个通知栏。high / medium 摊开给人看——它们里头有相当一部分是
 * 「你得自己判断」（比如一个技能确实需要联网），机器替人判断只会让人学会闭眼点确认。
 * low / info 连列都不列，只计个数：一份报告列到第三十条，人就不看了。
 */
const LEVEL_OF = { critical: "block", high: "warn", medium: "warn", low: "", info: "" };
const SEV_ZH = { critical: "严重", high: "高", medium: "中", low: "低", info: "提示" };

/** 探测结果的缓存。bin 为空 = 这一刻用不上它 */
let probe = { at: 0, bin: "", version: "", err: "", coolUntil: 0 };

// ── 找到它 ──────────────────────────────────────────────────────────────

/**
 * 从哪些目录里找。
 *
 * 不能只看 process.env.PATH：Electron 从 Dock / Finder 启动时拿到的是一份残缺的 PATH
 * （macOS 上常常只有 /usr/bin:/bin:/usr/sbin:/sbin），用户明明 `npm i -g` 装过，
 * 界面上却一直说没装——这个坑踩过一次就该写下来。所以把几个全局 bin 目录也补上。
 */
function candidateDirs() {
  const home = os.homedir();
  const fromPath = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const extra = [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".local", "bin"),
    path.join(home, "node_modules", ".bin"),
    // 有人真把它装成本项目的 devDependency 了也认（我们自己不写进 package.json，
    // 但不拦着别人装——个人用户装 devDependency 完全在 PolyForm 的免费范围里）
    path.join(__dirname, "node_modules", ".bin"),
  ];
  return [...new Set([...fromPath, ...extra])];
}

function canRun(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

function expandHome(p) {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

/**
 * 找到可执行文件的绝对路径，找不到返回 ""。
 *
 * 设置里填了 toolward_bin 就**只**认那一个：显式指定的东西偷偷回退到 PATH 上另一个同名
 * 程序，是安全工具最不该干的事——用户以为在用自己审过的那份。
 */
function findBin(cfg) {
  const want = String(process.env.OPENWORKBUDDY_TOOLWARD_BIN || setting(cfg, "toolward_bin") || "").trim();
  if (want) {
    const p = path.isAbsolute(want) || want.includes(path.sep) ? expandHome(want) : "";
    if (p) return canRun(p) ? p : "";
    // 填的是个裸名字（比如 toolward-dev）：当成要在下面那些目录里找的文件名
    for (const dir of candidateDirs()) if (canRun(path.join(dir, want))) return path.join(dir, want);
    return "";
  }
  const names = process.platform === "win32"
    ? ["toolward.cmd", "toolward.exe", "toolward"]
    : ["toolward"];
  for (const dir of candidateDirs()) {
    for (const n of names) {
      const p = path.join(dir, n);
      if (canRun(p)) return p;
    }
  }
  return "";
}

function run(bin, args, timeout) {
  try {
    return spawnSync(bin, args, {
      encoding: "utf8",
      timeout,
      maxBuffer: MAX_OUTPUT,
      // NO_COLOR：不关掉的话转义码会混进输出，报错行里全是乱码。
      // PATH 照传：toolward 自己是 Node 写的，剥掉 PATH 它连 node 都找不着。
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      windowsHide: true,
    });
  } catch (e) {
    return { status: -1, stdout: "", stderr: String((e && e.message) || e) };
  }
}

/**
 * 这一刻按哪个挡位走。
 *
 * 环境变量压过配置文件，跟内网开关一个路子（见 intranet.js）：排障和 CI 里要把它按掉，
 * 不该逼人去改一台机器上的 config.json——那种改法最后总会有人忘了改回来。
 */
function modeOf(cfg) {
  const raw = String(process.env.OPENWORKBUDDY_TOOLWARD || "").trim().toLowerCase();
  if (raw) {
    if (["0", "off", "false", "no"].includes(raw)) return "off";
    if (["advisory", "warn"].includes(raw)) return "advisory";
    if (["1", "on", "true", "yes", "auto"].includes(raw)) return "auto";
  }
  const v = String(setting(cfg, "toolward") || "auto").toLowerCase();
  return v === "off" || v === "advisory" ? v : "auto";
}

/**
 * 读一条设置。
 *
 * 调用方手里有已经读好的 config（server.js 那边就有）就传进来，别重复读盘；
 * 没有就自己读一次 config.json —— skills.js 是个叶子模块，为了一个开关让它去依赖
 * server 那份内存配置，等于把调用链倒过来。缓存几秒，因为一次批量安装会连着问十几遍。
 * 配置读不出来不是关掉检查的理由：读不出来就按默认值走。
 */
const CFG_TTL_MS = 5000;
let cfgCache = { at: 0, v: null };

function setting(cfg, key) {
  try {
    let c = cfg;
    if (!c) {
      const now = Date.now();
      if (!cfgCache.at || now - cfgCache.at > CFG_TTL_MS) {
        let v = {};
        try { v = JSON.parse(fs.readFileSync(dataPath("config.json"), "utf8")); } catch { v = {}; }
        cfgCache = { at: now, v };
      }
      c = cfgCache.v;
    }
    if (c && c.security && c.security[key] !== undefined) return c.security[key];
  } catch { /* 配置坏了不该让安全检查整个不能用 */ }
  return security.DEFAULTS[key];
}

function probeBin(cfg) {
  const now = Date.now();
  if (probe.at && now - probe.at < PROBE_TTL_MS) return probe;
  const bin = findBin(cfg);
  let version = "", err = "";
  if (!bin) {
    err = "本机没找到 toolward 命令";
  } else {
    const r = run(bin, ["--version"], PROBE_TIMEOUT_MS);
    if (r.status === 0) version = String(r.stdout || "").trim().split(/\s+/).pop() || "?";
    else err = `${bin} 跑不起来：${short(r.stderr || r.stdout || `退出码 ${r.status}`)}`;
  }
  probe = { at: now, bin: version ? bin : "", version, err, coolUntil: probe.coolUntil };
  return probe;
}

/**
 * 这一刻用不用得上它，以及用不上的原因。界面、doctor、日志都读这一份，省得三处说法不一样。
 */
function status(cfg) {
  const mode = modeOf(cfg);
  const p = probeBin(cfg);
  // installed 和 on 是两件事，界面上分得清才画得对：设置成 off 的时候它还是装着的，
  // 那张卡片要照样把三个挡位画出来，不然用户关掉之后就再也找不到打开的地方了。
  const installed = !!p.bin;
  let why = "";
  if (!installed) why = p.err;
  else if (mode === "off") why = "设置里把它关了";
  else if (probe.coolUntil && Date.now() < probe.coolUntil) {
    why = `上一趟它自己出错了，${Math.ceil((probe.coolUntil - Date.now()) / 1000)} 秒内先不叫它（安装照常，只是少一双眼睛）`;
  }
  return {
    mode, installed, on: installed && !why,
    bin: p.bin, version: p.version,
    bin_pref: String(process.env.OPENWORKBUDDY_TOOLWARD_BIN || setting(cfg, "toolward_bin") || ""), // 填的那个值，不是解析之后的路径
    why, install: INSTALL_HINT, licence: LICENCE_NOTE,
  };
}

/** doctor / 日志里的一行话 */
function line(cfg) {
  const st = status(cfg);
  if (st.on) return `toolward ${st.version}（${st.bin}），技能安装时会多扫一遍`;
  return `toolward 没在用：${st.why}。想装：${INSTALL_HINT}（可选，不装不影响任何功能）`;
}

// ── 跑它 ────────────────────────────────────────────────────────────────

/**
 * 扫一组路径，给出 skill-guard 形状的报告；用不上它就返回 null（注意：**不是**空报告——
 * 空报告会被 explain 说成「没扫出问题」，那是撒谎）。
 */
function scanTargets(targets, opts = {}) {
  const { cfg, root = "", subject = "", advisory = false, timeout = SCAN_TIMEOUT_MS } = opts;
  if (modeOf(cfg) === "off") return null;   // 关了就别去探测，省一次子进程
  const st = status(cfg);
  if (!st.on) return null;

  // --fail-on none：有命中也退 0。不这么写的话「扫出问题」和「工具挂了」两件事共用一个退出码，
  // 我们就没法把后者当成没跑过。
  // 千万别加 --quiet：那个开关会把 stdout 整个吞掉（src/cli.ts 的 emit()），JSON 就没了。
  const args = ["scan", ...targets, "--format", "json", "--fail-on", "none", "--no-color"];
  const r = run(st.bin, args, timeout);
  const raw = String(r.stdout || "");
  let data = null;
  try { data = JSON.parse(raw); } catch { /* 下面统一按「没跑过」处理 */ }

  if (!data || !Array.isArray(data.findings)) {
    probe = { ...probe, coolUntil: Date.now() + COOLOFF_MS };
    log.warn("toolward", "这一趟没拿到结果，按没装处理（安装不受影响）", {
      subject, status: r.status, err: short(r.stderr || raw || "没有输出"),
    });
    return null;
  }
  return toReport(data, { root, version: st.version, advisory: advisory || st.mode === "advisory" });
}

/** 扫一个技能目录 */
function scanDir(dir, cfg, opts = {}) {
  return scanTargets([dir], { ...opts, cfg, root: dir, subject: opts.subject || dir });
}

/**
 * 扫一段内存里的技能正文（单文件安装、界面上手写技能这两条路没有目录）。
 * 落成一个临时目录里的 skill.md 再交给它——toolward 认的是文件。
 */
function scanText(rel, text, cfg, opts = {}) {
  if (modeOf(cfg) === "off") return null;
  const st = status(cfg);
  if (!st.on) return null;
  const dir = mkTemp();
  try {
    const name = path.basename(String(rel || "skill.md")) || "skill.md";
    fs.writeFileSync(path.join(dir, name), String(text == null ? "" : text), { mode: 0o600 });
    return scanTargets([dir], { ...opts, cfg, root: dir, subject: opts.subject || name });
  } catch (e) {
    log.warn("toolward", "临时文件写不出来，这一趟按没装处理", { err: e });
    return null;
  } finally { rmrf(dir); }
}

/**
 * 扫一份连接器配置（MCP servers）。
 *
 * 连接器以前一次安全检查都不过：技能装进来要过两道闸，而一条 `command: npx` + 一串参数
 * 的连接器点个保存就跑起来了，权限比技能大得多。toolward 本来就认 .mcp.json，
 * 把配置摆成它认的形状递过去就行。
 *
 * **只提醒，不拦**（advisory）：连接器是用户自己填的地址和命令，不是从 GitHub 下来的
 * 陌生代码；在「保存设置」这一步硬拦，用户能做的只有把它改回去或者关掉整个检查。
 */
function scanConnectors(servers, cfg, opts = {}) {
  if (modeOf(cfg) === "off") return null;
  const st = status(cfg);
  if (!st.on) return null;
  const list = Array.isArray(servers) ? servers : [];
  if (!list.length) return null;
  const dir = mkTemp();
  try {
    fs.writeFileSync(
      path.join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: redactServers(list) }, null, 2),
      { mode: 0o600 }
    );
    const rep = scanTargets([dir], {
      ...opts, cfg, root: dir, subject: "连接器", advisory: true, timeout: QUICK_TIMEOUT_MS,
    });
    if (!rep) return null;
    // 文件名换成人话：用户没写过 .mcp.json 这个文件，报「.mcp.json:12」他不知道是哪儿
    for (const f of rep.findings) if (/^\.mcp\.json$/.test(f.file)) f.file = "连接器配置";
    return rep;
  } catch (e) {
    log.warn("toolward", "连接器这趟没扫成（不影响保存）", { err: e });
    return null;
  } finally { rmrf(dir); }
}

/**
 * 交给 toolward 之前，把值洗掉，只留键名。
 *
 * env 和 headers 里装的就是 API Key 和令牌。为了做一次安全检查，先把用户的密钥写进
 * /tmp 再喂给另一个进程——那是为了查漏先漏一次。键名留着就够用：TW3xx 那族认的是
 * 「这儿有个 token 字段」这件事；而真值放进去只会让每一个**配置正确**的连接器
 * 都被报成「明文密钥」，误报满屏，真命中反而看不见。
 *
 * url 也只留 origin + 路径，query 和 fragment 砍掉——那两处最常夹着 ?key=、#token=。
 * command / args 一个字不动：npx 拉了个没锁版本的包、参数里串了个 sh -c，
 * 全靠这两项才看得出来，而它们本来就不含密钥。
 */
function redactServers(list) {
  const out = {};
  for (const s of list) {
    if (!s) continue;
    const e = {};
    if (s.command) {
      e.command = String(s.command);
      e.args = Array.isArray(s.args) ? s.args.map(String) : [];
    }
    if (s.url) e.url = safeUrl(String(s.url));
    if (s.transport) e.transport = String(s.transport);
    for (const k of Object.keys(s.env || {})) (e.env = e.env || {})[k] = "***";
    for (const k of Object.keys(s.headers || {})) (e.headers = e.headers || {})[k] = "***";
    out[String(s.name || "?")] = e;
  }
  return out;
}

function safeUrl(u) {
  try {
    const x = new URL(u);
    const tail = x.search || x.hash ? "?***" : "";
    return `${x.origin}${x.pathname}${tail}`;
  } catch { return u.split(/[?#]/)[0]; }
}

// ── 它的话 → 我们的形状 ──────────────────────────────────────────────────

function toReport(data, { root = "", version = "", advisory = false } = {}) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const seen = new Map();
  const findings = [];
  let quiet = 0, dropped = 0;

  for (const f of data.findings) {
    const sev = String((f && f.severity) || "info").toLowerCase();
    if (sev in counts) counts[sev]++;
    let level = LEVEL_OF[sev] || "";
    if (!level) { quiet++; continue; }
    // advisory：用它的眼睛，但不给它拦人的权力
    if (advisory && level === "block") level = "warn";

    const file = relTo(f.file, root) || String(f.subject || "") || "(整个目录)";
    const key = `${f.ruleId}|${file}`;
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    if (n > PER_RULE_HITS) { dropped++; continue; }

    findings.push({
      level,
      rule: String(f.ruleId || "TW?"),
      cat: "toolward",
      file,
      line: Number(f.line) || 0,
      excerpt: clip(f.snippet, 160),
      why: whyOf(f, sev),
    });
  }

  findings.sort((a, b) => (a.level === b.level ? 0 : a.level === "block" ? -1 : 1));
  return {
    level: findings.some((x) => x.level === "block") ? "block" : findings.length ? "warn" : "ok",
    findings: findings.slice(0, MAX_FINDINGS),
    truncated_findings: dropped + Math.max(0, findings.length - MAX_FINDINGS),
    hosts: [],
    files: Number((data.stats || {}).files) || 0,
    bytes: 0,
    truncated_files: 0,
    exec: [],
    // toolward 自己那套说法留着：界面上「B 级 / 82 分」比「3 条告警」更像一句人话
    toolward: {
      version: version || String(data.version || ""),
      score: Number(data.score),
      grade: String(data.grade || ""),
      counts,
      quiet,                                  // low/info：没列出来，但确实看见了
      suppressed: Number(data.suppressed) || 0,
      duration_ms: Number(data.durationMs) || 0,
    },
  };
}

/**
 * 一条命中 → 一句人话。中文字段优先（toolward 的 JSON 里中英都带着，所以不用加 --lang）。
 * 前面那个标记不能省：报告里混着两把尺子的结论，用户有权知道哪一条是谁说的。
 */
function whyOf(f, sev) {
  const title = String(f.titleZh || f.title || "").trim();
  const msg = String(f.messageZh || f.message || "").trim();
  const fix = String(f.remediationZh || f.remediation || "").trim();
  const head = `〔toolward ${f.ruleId || "?"}·${SEV_ZH[sev] || sev}〕`;
  const body = [title, msg].filter(Boolean).join("：");
  return head + (body || "命中了一条规则，但它没给说明") + (fix ? ` 建议：${fix}` : "");
}

/**
 * 两份报告拼成一份。skill-guard 那份当底，toolward 那份叠上去。
 * 任何一边说 block，合起来就是 block —— 第二意见要是只能降级不能升级，接它做什么。
 */
function merge(base, extra) {
  if (!extra) return base;
  if (!base) return extra;
  const findings = base.findings.concat(extra.findings);
  // 稳定排序：同为 block 时，skill-guard 自己那几条排在前面（那是我们说得清理由的）
  findings.sort((a, b) => (a.level === b.level ? 0 : a.level === "block" ? -1 : 1));
  const over = Math.max(0, findings.length - MAX_FINDINGS);
  return {
    level: findings.some((f) => f.level === "block") ? "block" : findings.length ? "warn" : "ok",
    findings: findings.slice(0, MAX_FINDINGS),
    truncated_findings: (base.truncated_findings || 0) + (extra.truncated_findings || 0) + over,
    hosts: [...new Set([...(base.hosts || []), ...(extra.hosts || [])])].sort(),
    // 「扫了 N 个文件」取两边的大数：谁看得多算谁的，说少了等于替用户低估了这次检查
    files: Math.max(base.files || 0, extra.files || 0),
    bytes: base.bytes || 0,
    truncated_files: base.truncated_files || 0,
    exec: base.exec || [],
    toolward: extra.toolward || base.toolward || null,
  };
}

// ── 杂物 ────────────────────────────────────────────────────────────────

function mkTemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "owb-tw-"));
}

function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录删不掉不值得报错 */ }
}

function relTo(file, root) {
  const f = String(file || "");
  if (!f) return "";
  if (!root) return f;
  const r = path.resolve(root);
  const a = path.isAbsolute(f) ? f : path.resolve(r, f);
  const rel = path.relative(r, a);
  return rel && !rel.startsWith("..") ? rel.split(path.sep).join("/") : f;
}

function clip(s, n) {
  const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

function short(s) {
  return clip(s, 300);
}

/** 测试要能把探测缓存清掉，否则第一个用例探到的结果会粘住后面所有用例 */
function _reset() {
  probe = { at: 0, bin: "", version: "", err: "", coolUntil: 0 };
  cfgCache = { at: 0, v: null };
}

module.exports = {
  status, line, findBin, scanDir, scanText, scanConnectors, merge,
  INSTALL_HINT, LICENCE_NOTE,
  _internals: { toReport, redactServers, safeUrl, relTo, whyOf, LEVEL_OF, MAX_FINDINGS, PER_RULE_HITS, COOLOFF_MS, _reset },
};
