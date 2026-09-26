// @ts-check
"use strict";
/**
 * record_web_demo 的录制器：开一个用完就扔的 Chrome，按步骤脚本操作页面、收帧，最后交给 ffmpeg 合成。
 *
 * 几条硬规矩（test/web-demo.js【11】【12】钉着）：
 *   - 浏览器只从 cdp.spawnIsolated 来：全新临时 profile，没有登录态，用完连目录一起删。
 *     成片是要发给别人看的，账号一露脸就收不回来，所以不提供「借你平时的浏览器录」这条路。
 *   - 马赛克是闸门不是装饰：每换一次页自检一次（没装上、没遮住就拒绝录），每步做完扫一遍整页
 *     （有原文就拒绝出片）。闸门全过之前工作区里一个文件都不写；步骤出错时最多留一张扫过是干净的现场截图。
 *   - ffmpeg 只认 resolveMediaBins 找到的那个；缺滤镜就直说缺什么，不偷偷降级成不放大、不带字幕。
 * 能算的（步骤校验、光标轨迹、放大关键帧、滤镜串、注入脚本）都在 web-demo-plan.js，这里只管 I/O。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { pathToFileURL, fileURLToPath } = require("url");
const P = require("./web-demo-plan");
const { maskScript } = require("./demo-mask");
const { fitDurations } = require("./demo-timing");
const media = require("./media-probe");
const cdp = require("../cdp");

const CALL_MS = 15000; // 单条 CDP 调用最多等多久
const LOCATE_MS = 8000; // 找元素最多等多久
const LOAD_MS = 20000; // 打开页面最多等多久
const FIRST_FRAME_MS = 3000;
const SETTLE_MS = 250; // 每步做完停一下，让动画、重排落地再扫、再截
const STALE_MS = 24 * 3600 * 1000;
const VERB = /** @type {Record<string, string>} */ ({ goto: "打开", click: "点击", type: "打字", press: "按键", scroll: "滚动", hover: "悬停", wait: "等待", zoom: "放大", caption: "字幕" });
const NO_LOGIN = "录屏只用全新的隔离 Chrome，不借你浏览器里的登录态：成片要发给别人，账号露出去就收不回来。要录登录后的页面，先起一个演示账号的本地环境再录。";
const ACTIVE_RECT = "(() => { const el = document.activeElement; if (!el || el === document.body || el === document.documentElement) return null; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null; })()";
const CAP_RECT = "(() => { const el = document.getElementById(\"cap\"); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()";

const TOOL_DEF = {
  name: "record_web_demo",
  description:
    "录一段自己网页产品的演示视频：在全新的隔离 Chrome 里（没有登录态，用完即删）按 steps 一步步操作，出 demo.mp4（假光标、点哪儿镜头推近哪儿、字幕）+ 每步一张截图 + steps.json（每步在成片里的起止秒数，配音照它对齐）。\n" +
    "本机路径、用户名、主机名自动打码，换页自检、每步扫一遍，没遮住就拒绝出片；账号名、邮箱这些再列进 mask。画布、图片、视频里的字遮不到。\n" +
    "要录网页演示就用它，别自己起 Chrome、Puppeteer 或 Playwright。录不了真实登录态：先起一个演示账号的本地环境。第一次先用 max_sec:30 录一条短的，把选择器跑通再录整条。",
  input_schema: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        items: { type: "object" },
        description:
          "一步一个对象，第一步必须是 goto。动作：goto（http(s) 网址，或 {path:\"工作区里的.html\"}）/ click（CSS 选择器，或 {text:\"看得见的字\", nth}）/ " +
          "type（{selector, text, enter}）/ press（Enter、Tab、Escape、方向键…）/ scroll（{by:像素} 或 {to:\"bottom\"}）/ hover / " +
          "wait（毫秒，或 {selector|text, timeout_ms}）/ zoom（{selector|rect, scale, ms}）/ caption（{text, ms, hold}）。" +
          "每步可加 label（截图文件名里用）、shot:false（这步不截图）。" +
          "例：[{\"goto\":\"http://127.0.0.1:3000/\"},{\"caption\":\"三步生成报表\"},{\"click\":{\"text\":\"开始\"}},{\"type\":{\"selector\":\"#q\",\"text\":\"本月销售\",\"enter\":true}}]",
      },
      aspect: { type: "string", enum: Object.keys(P.ASPECTS), description: "画幅，默认 16:9（1920×1080）；9:16 按手机录（1080×1920，触屏 + 页面自己的手机版）" },
      out_dir: { type: "string", description: "工作区里的相对目录，默认 web-demo-月日-时分秒" },
      fps: { type: "number", description: "帧率 24~60，默认 30" },
      auto_zoom: { type: "boolean", description: "点击、打字时镜头自动推近，默认 true" },
      max_zoom: { type: "number", description: "自动推近最多几倍，1~2.5，默认 1.8" },
      speed: { type: "number", description: "成片倍速 0.5~3，默认 1" },
      mask: { type: "array", items: { type: "string" }, description: "页面上还要遮的字（账号名、邮箱、公司名），每项至少 2 个字；本机路径、用户名、主机名不用列" },
      headless: { type: "boolean", description: "默认 true（不弹窗口）；false 会弹出录制用的 Chrome 窗口" },
      max_sec: { type: "number", description: "最多录多少秒，默认 120，上限 300；超了就停下报错" },
    },
    required: ["steps"],
  },
};

/** @typedef {import("./web-demo-plan").Step} Step */
/**
 * @typedef {{ port: number, pageWs: string, pageId?: string, dir?: string, pid?: number, cleanup: () => Promise<void> }} Browser
 * @typedef {{ stdout: string, stderr: string }} BinOut
 * @typedef {{
 *   outRel?: string, outAbs?: string,
 *   resolveFile?: (p: string) => string,
 *   checkNav?: (url: string) => { ok: boolean, why?: string },
 *   stop?: AbortSignal, deadline?: number,
 *   onProgress?: (p: { stage: string, done?: number, total?: number, pct?: number, label: string }) => void,
 *   browser?: (preset: ReturnType<typeof P.aspectPreset>, o: { headless: boolean }) => Promise<Browser>,
 *   bins?: () => Promise<any>,
 *   runBin?: (bin: string, args: string[], o: { timeout: number, signal?: AbortSignal, what: string }) => Promise<BinOut>,
 *   runFfmpeg?: (args: string[], o: { bin: string, cwd: string, signal?: AbortSignal, timeoutMs: number, onTime: (sec: number) => void }) => Promise<void>,
 *   maskScriptOverride?: string,
 * }} Ctx
 */

/** 工作区里的输出目录（tools.js 先拿它过写权限闸门，再调 runTool） */
/** @param {any} input */
function outDirRel(input) {
  return P.outDirRel(input && typeof input === "object" ? input.out_dir : undefined);
}

function abortError() {
  const e = new Error("已停止");
  e.name = "AbortError";
  return e;
}
/** @param {any} e @param {AbortSignal} [stop] */
const isAbort = (e, stop) => !!(e && e.name === "AbortError") || !!(stop && stop.aborted);
/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** @param {string} msg 这类错不留现场截图：马赛克、越权跳转、Chrome 没了，截下来的东西本身就不该落盘 */
const hard = (msg) => Object.assign(new Error(msg), { noShot: true });

/**
 * @param {any} v @param {string} name @param {number} dflt @param {number} lo @param {number} hi
 */
function numParam(v, name, dflt, lo, hi) {
  if (v == null || v === "") return dflt;
  const n = typeof v === "string" ? Number(v.trim()) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < lo || n > hi) throw new Error(`${name} 要在 ${lo}~${hi} 之间`);
  return n;
}

/** 录屏崩了、被 kill 了留下的临时目录：/tmp 被这类东西撑到上百 G 过，开录前顺手扫一遍 */
function sweepStale() {
  const root = os.tmpdir();
  let names = [];
  try { names = fs.readdirSync(root); } catch { return; }
  const now = Date.now();
  for (const n of names) {
    if (!/^owb-webdemo-(work|prof)-/.test(n)) continue;
    const p = path.join(root, n);
    try { if (now - fs.statSync(p).mtimeMs > STALE_MS) fs.rmSync(p, { recursive: true, force: true }); } catch { /* 别人正在删，或者没权限：不影响这次录 */ }
  }
}

/** @param {string} url */
function loopbackOnly(url) {
  let h = "";
  try { h = new URL(url).hostname.replace(/^\[|\]$/g, ""); } catch { /* 下面按「不是本机」处理 */ }
  if (h === "localhost" || h === "::1" || /^127\./.test(h)) return { ok: true };
  return { ok: false, why: `没接网络放行规则时只录本机地址，${h || "这个地址"}不行` };
}

/** 探一次 ffmpeg 有哪些滤镜、编码器；真 runBin 的结果按路径记住，一个进程只探一次 */
/** @type {Map<string, Promise<Set<string>>>} */
const CAPS = new Map();
/**
 * @param {string} bin
 * @param {(bin: string, args: string[], o: { timeout: number, signal?: AbortSignal, what: string }) => Promise<BinOut>} run
 * @param {AbortSignal} [signal]
 */
function ffmpegCaps(bin, run, signal) {
  const go = async () => {
    const f = await run(bin, ["-hide_banner", "-filters"], { timeout: 20000, signal, what: "ffmpeg" });
    const e = await run(bin, ["-hide_banner", "-encoders"], { timeout: 20000, signal, what: "ffmpeg" });
    /** @type {Set<string>} */
    const have = new Set();
    for (const m of String(f.stdout || "").matchAll(/^\s*[TSC.]+\s+(\S+)\s/gm)) have.add(m[1]);
    for (const m of String(e.stdout || "").matchAll(/^\s*[VAS][A-Z.]{5}\s+(\S+)/gm)) have.add(m[1]);
    return have;
  };
  if (run !== media.runBin) return go();
  let p = CAPS.get(bin);
  if (!p) {
    p = go();
    CAPS.set(bin, p);
    p.catch(() => CAPS.delete(bin));
  }
  return p;
}

/**
 * 自己 spawn 而不走 runBin：要从 -progress 里读进度，也要停止时当场杀掉。
 * @param {string[]} args
 * @param {{ bin: string, cwd: string, signal?: AbortSignal, timeoutMs: number, onTime: (sec: number) => void }} o
 * @returns {Promise<void>}
 */
function spawnFfmpeg(args, o) {
  return new Promise((resolve, reject) => {
    if (o.signal && o.signal.aborted) return reject(abortError());
    let PATH = process.env.PATH || "";
    try { PATH = require("../engines/which").augmentedPath(); } catch { /* 用原 PATH */ }
    const child = spawn(o.bin, args, { cwd: o.cwd, env: { ...process.env, PATH }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "", buf = "", why = "", settled = false;
    const kill = (/** @type {string} */ w) => { if (!why) why = w; try { child.kill("SIGKILL"); } catch { /* 已经退了 */ } };
    const timer = setTimeout(() => kill("timeout"), o.timeoutMs);
    const onAbort = () => kill("abort");
    if (o.signal) o.signal.addEventListener("abort", onAbort, { once: true });
    /** @param {Error | null} err */
    const done = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (o.signal) o.signal.removeEventListener("abort", onAbort);
      if (err) reject(err); else resolve();
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const ln of lines) {
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(ln.trim());
        if (m) { try { o.onTime(Number(m[1]) / 1e6); } catch { /* 进度只是锦上添花 */ } }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => { tail = (tail + d).slice(-4000); });
    child.on("error", (e) => done(new Error(`ffmpeg 跑不起来：${e.message}`)));
    child.on("close", (code) => {
      if (why === "abort") return done(abortError());
      if (why === "timeout") return done(new Error(`ffmpeg 合成了 ${Math.round(o.timeoutMs / 1000)} 秒还没完，已经停掉`));
      if (code !== 0) return done(new Error(`ffmpeg 合成出错了（退出码 ${code}）：${media.tailBytes(tail, 300)}`));
      done(null);
    });
  });
}

/**
 * 默认的浏览器：一个用完就扔的 Chrome + 一个新标签页。
 * @param {ReturnType<typeof P.aspectPreset>} preset
 * @param {{ headless: boolean }} o
 * @returns {Promise<Browser>}
 */
async function isolatedBrowser(preset, o) {
  // 收帧只按窗口本身的缩放出图：只靠 setDeviceMetricsOverride 模拟的 3 倍，无头 Chrome 大多数帧还是 360×640，
  // 偶尔夹一张 1080×1920——成片糊，尺寸一变 ffmpeg 还会重建滤镜、把时间轴搅乱（【15】真录钉着）。启动时就定死缩放
  const br = await cdp.spawnIsolated({ headless: o.headless, windowSize: preset.css, prefix: "owb-webdemo-prof-", timeoutMs: 20000, extraArgs: [`--force-device-scale-factor=${preset.dsf}`] });
  try {
    const t = await cdp.newPage(br.port);
    return { port: br.port, pageWs: t.webSocketDebuggerUrl, pageId: t.id, dir: br.dir, pid: br.pid, cleanup: () => br.kill() };
  } catch (e) {
    await br.kill();
    throw e;
  }
}

/**
 * 录一条。成功返回交付物的位置；任何一道闸门没过都抛错，工作区里不留半成品。
 * @param {any} input
 * @param {Ctx} [ctx]
 * @param {{ pairs?: [string, string][], note?: string }} [hold] runTool 用来拿打码清单（报错也要过一遍）和收尾时的异常
 */
async function record(input, ctx = {}, hold = {}) {
  const inp = input && typeof input === "object" ? input : {};
  if (inp.use_login) throw new Error(NO_LOGIN);
  const steps = P.parseSteps(inp.steps);
  const preset = P.aspectPreset(inp.aspect);
  const fps = Math.round(numParam(inp.fps, "fps", 30, 24, 60));
  const speed = numParam(inp.speed, "speed", 1, 0.5, 3);
  const maxZoom = numParam(inp.max_zoom, "max_zoom", 1.8, 1, P.LIMITS.maxScale);
  const maxSec = numParam(inp.max_sec, "max_sec", 120, 5, 300);
  const autoZoom = inp.auto_zoom !== false;
  const headless = inp.headless !== false;
  if (inp.mask != null && !Array.isArray(inp.mask)) throw new Error("mask 要是字符串数组，比如 [\"张三\", \"demo@example.com\"]");
  const pre = P.maskPairs({ extra: inp.mask || [] });
  hold.pairs = pre.pairs;
  // 不回显是哪几项：报错会进对话和日志，原样念出来等于没遮
  if (pre.rejected.length) throw new Error(`mask 里有 ${pre.rejected.length} 项太短（至少 2 个字），写全了再录：只遮一个字会把页面上所有这个字都换成圆点`);
  for (const s of steps) {
    if (s.op !== "type" || !s.text || P.fixString(s.text, pre.pairs) === s.text) continue;
    const labs = pre.pairs.map((p, k) => (String(s.text).includes(p[0]) ? pre.labels[k] : "")).filter(Boolean);
    throw new Error(`第 ${s.i} 步（type）：要打的字里有要遮的内容（${[...new Set(labs)].join("、")}），打出来就露了，换一段演示用的字`);
  }
  const { css, out, mobile } = preset;
  const stop = ctx.stop;
  const deadline = Number(ctx.deadline) || 0;
  const outRel = ctx.outRel || outDirRel(inp);
  const outAbs = ctx.outAbs || (ctx.resolveFile ? ctx.resolveFile(outRel) : "");
  if (!outAbs) throw new Error("没有工作区，录好的视频没地方放");

  /** @type {Map<string, { ok: boolean, why?: string }>} */
  const navSeen = new Map();
  /** @type {Set<string>} */
  const allowedFiles = new Set();
  /**
   * 页面（含 iframe）要去的地址放不放行。http(s) 走安全中心（没接就只放本机），
   * file: 只放 goto 点名的那几个、或者过得了工作区策略的，别的协议一律不行。
   * @param {string} url @param {boolean} main
   * @returns {{ ok: boolean, why?: string, error?: boolean }}
   */
  const navVerdict = (url, main) => {
    const u = String(url || "");
    const scheme = (/^([a-z][a-z0-9+.-]*):/i.exec(u) || [])[1] || "";
    const sch = scheme.toLowerCase();
    if (sch === "about") return main && u !== "about:blank" ? { ok: false, why: `页面跳到了 ${u.slice(0, 40)}` } : { ok: true };
    if (sch === "chrome-error") return main ? { ok: false, error: true, why: "页面没打开（网络出错，或者地址不对）" } : { ok: true };
    if (!main && (sch === "data" || sch === "blob")) return { ok: true };
    if (sch === "http" || sch === "https") {
      const hit = navSeen.get(u);
      if (hit) return hit;
      const v = ctx.checkNav ? ctx.checkNav(u) : loopbackOnly(u);
      const r = v && v.ok ? { ok: true } : { ok: false, why: String((v && v.why) || "这个地址不让打开") };
      navSeen.set(u, r);
      return r;
    }
    if (sch === "file") {
      let abs = "";
      try { abs = path.resolve(fileURLToPath(u)); } catch { return { ok: false, why: "本机文件地址看不懂" }; }
      if (allowedFiles.has(abs)) return { ok: true };
      if (ctx.resolveFile) {
        try { ctx.resolveFile(abs); allowedFiles.add(abs); return { ok: true }; } catch (e) { return { ok: false, why: String(e && e.message || e) }; }
      }
      return { ok: false, why: "页面跳到了工作区外面的本机文件" };
    }
    return { ok: false, why: `页面跳到了「${sch || "?"}:」这种地址` };
  };

  // 开浏览器之前把能查的都查完：地址不让开、文件不在、ffmpeg 不全，都不值得拉起一个 Chrome
  for (const s of steps) {
    if (s.op !== "goto") continue;
    if (s.url) {
      const v = navVerdict(s.url, true);
      if (!v.ok) throw new Error(`第 ${s.i} 步（goto）：${v.why}`);
    } else if (s.path) {
      if (!ctx.resolveFile) throw new Error(`第 ${s.i} 步（goto）：没有工作区，打不开本机文件`);
      const abs = path.resolve(ctx.resolveFile(s.path));
      let isFile = false;
      try { isFile = fs.statSync(abs).isFile(); } catch { /* 下面报 */ }
      if (!isFile) throw new Error(`第 ${s.i} 步（goto）：工作区里没有这个文件：${s.path}`);
      allowedFiles.add(abs);
    }
  }

  const bins = await (ctx.bins ? ctx.bins() : media.resolveMediaBins());
  const hint = bins && bins.install ? `装法：${bins.install}` : "装好 ffmpeg（自带 ffprobe）再试";
  if (!bins || !bins.ffmpeg || !bins.ffmpeg.bin) throw new Error(`没装 ffmpeg，合不了视频。${hint}`);
  if (!bins.ffprobe || !bins.ffprobe.bin) throw new Error(`没找到 ffprobe，合成完没法验片。${hint}`);
  const runBin = ctx.runBin || media.runBin;
  const needZoom = steps.some((s) => s.op === "zoom" || (autoZoom && s.zoom !== false && (s.op === "click" || s.op === "type" || s.op === "hover")));
  const needCap = steps.some((s) => s.op === "caption");
  const have = await ffmpegCaps(bins.ffmpeg.bin, runBin, stop);
  const miss = ["fps", "scale", ...(needZoom ? ["zoompan"] : []), ...(needCap ? ["overlay"] : []), "libx264"].filter((x) => !have.has(x));
  if (miss.length) {
    throw new Error(`这个 ffmpeg 少了 ${miss.join("、")}，合不了${needZoom ? "带放大的" : ""}视频。换一个完整版的 ffmpeg 再录${bins.install ? "（装法：" + bins.install + "）" : ""}${needZoom && miss.includes("zoompan") ? "；或者 auto_zoom:false、去掉 zoom 步骤" : ""}`);
  }
  if (stop && stop.aborted) throw abortError();

  sweepStale();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-webdemo-work-"));
  for (const d of ["frames", "shots", "caps"]) fs.mkdirSync(path.join(workDir, d));

  const S = {
    /** @type {{ file: string, at: number, until: number }[]} */
    frames: [],
    acks: 0,
    capturing: false,
    capStart: 0,
    lastData: "",
    /** 一旦有值，所有等待都立刻抛出：越权跳转、Chrome 断了、页面没打开 */
    halt: /** @type {{ msg: string, noShot: boolean, nav?: boolean } | null} */ (null),
    mainNavs: 0,
    seenNavs: 0,
    probes: 0,
    scans: 0,
    /** @type {{ at: number, rect: { x: number, y: number, w: number, h: number }, untilAt?: number, scale?: number }[]} */
    zooms: [],
    /** @type {{ text: string, at: number, untilAt: number }[]} */
    captions: [],
    /** @type {{ i: number, op: string, label: string, startWall: number, endWall: number, shot: string | null, target: any }[]} */
    recs: [],
    /** @type {string[]} */
    warnings: [],
    cursor: { x: Math.round(css.w / 2), y: Math.round(css.h / 2) },
    dialogWarned: false,
    scrollWarned: false,
  };
  const interval = 1000 / fps;
  let pairs = pre.pairs, labels = pre.labels;
  /** @type {Browser | null} */
  let browser = null;
  /** @type {any} */
  let client = null;
  /** @type {any} */
  let capClient = null;
  /** @type {{ id: string } | null} */
  let capPage = null;

  let lastProg = 0, lastStage = "";
  /** @param {{ stage: string, done?: number, total?: number, pct?: number, label: string }} p @param {boolean} [force] */
  const progress = (p, force) => {
    if (!ctx.onProgress) return;
    const now = Date.now();
    if (!force && p.stage === lastStage && now - lastProg < 400) return;
    lastProg = now; lastStage = p.stage;
    try { ctx.onProgress({ ...p, label: P.fixString(p.label, pairs) }); } catch { /* 进度只是锦上添花 */ }
  };

  const guard = () => {
    if (stop && stop.aborted) throw abortError();
    if (S.halt) throw Object.assign(new Error(S.halt.msg), { noShot: S.halt.noShot });
    if (deadline && Date.now() > deadline) throw hard("这一轮的时间用完了，录制停在半路，没出片");
    if (S.capStart && Date.now() - S.capStart > maxSec * 1000) throw hard(`录满 ${maxSec} 秒还没做完（max_sec），拆成几段录，或者调大 max_sec`);
  };
  /** 会被停止、越权跳转打断的等待 @param {number} ms */
  const nap = async (ms) => {
    const end = Date.now() + ms;
    for (;;) {
      guard();
      const left = end - Date.now();
      if (left <= 0) return;
      await sleep(Math.min(100, left));
    }
  };
  /**
   * 调用一条 CDP；用户点停止时不干等 15 秒，当场抛。
   * @param {string} method @param {object} [params] @param {number} [ms]
   * @returns {Promise<any>}
   */
  const call = (method, params = {}, ms = CALL_MS) => {
    const pr = client.call(method, params, ms);
    if (!stop) return pr;
    if (stop.aborted) { pr.catch(() => {}); return Promise.reject(abortError()); }
    return new Promise((res, rej) => {
      const on = () => rej(abortError());
      stop.addEventListener("abort", on, { once: true });
      pr.then((v) => { stop.removeEventListener("abort", on); res(v); }, (e) => { stop.removeEventListener("abort", on); rej(e); });
    });
  };
  /** @param {string} expression @param {number} [ms] */
  const evalJs = async (expression, ms = CALL_MS) => {
    const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, ms);
    if (r && r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error("页面脚本出错：" + String((d.exception && d.exception.description) || d.text || "").split("\n")[0].slice(0, 160));
    }
    return r && r.result ? r.result.value : undefined;
  };
  /** @param {{ x: number, y: number }} p */
  const cursorTo = async (p) => {
    try { await evalJs(`window.__demoCursor ? window.__demoCursor.moveTo(${p.x}, ${p.y}) : false`, 5000); } catch (e) { if (isAbort(e, stop)) throw e; }
  };

  /** @param {Step} st */
  const tgtDesc = (st) => {
    const t = st.target;
    if (!t) return "";
    const s = t.selector || t.text || "";
    return s ? `「${Array.from(s).slice(0, 40).join("")}」` : "";
  };
  /** @param {Step} st @param {string} msg */
  const stepFail = (st, msg) => new Error(`第 ${st.i} 步 ${st.op}${tgtDesc(st)}：${msg}`);
  /** @param {Step} st */
  const stepName = (st) => `第 ${st.i} 步${st.label ? " " + st.label : ""}`;

  /** 马赛克自检：新文档里装上没有、真遮了没有。两样有一样不成立就不录 @param {string} what */
  const probe = async (what) => {
    let r = null;
    try { r = await evalJs(P.probeScript(pairs), 10000); } catch (e) { if (isAbort(e, stop)) throw e; }
    S.probes++;
    if (!r || r.installed !== true || r.masked !== true) throw hard(`马赛克没生效，拒绝录制（${what}）`);
  };
  /**
   * 泄漏扫描。故意不先调 __demoMask.rescan()：rescan 只能把此刻的 DOM 改干净，
   * 可在它之前收进来的帧里原文已经上过屏了——先补再扫，扫出来是干净的，片子却是脏的。
   * 观察者漏掉的（脚本直接赋 .value、后挂的 shadow root）就该在这里被逮住，拒绝出片。
   * @param {string} what
   */
  const scan = async (what) => {
    const tree = await call("DOM.getDocument", { depth: -1, pierce: true }, 20000);
    const live = await evalJs(P.liveValuesScript());
    S.scans++;
    const leaks = P.findLeaks(tree && tree.root, Array.isArray(live) ? live : [], pairs, labels);
    if (leaks.length) throw hard(`马赛克没兜住：${leaks.join("、")}，拒绝出片（${what}）`);
  };

  /** 换页之后：等新文档起来，自检马赛克，把光标放回原处 @param {Step} st */
  const afterNav = async (st) => {
    const t0 = Date.now();
    while (Date.now() - t0 < 10000) {
      guard();
      let rs = "";
      try { rs = await evalJs("document.readyState", 5000); } catch (e) { if (isAbort(e, stop)) throw e; }
      if (rs && rs !== "loading") break;
      await sleep(100);
    }
    S.seenNavs = S.mainNavs;
    await probe(stepName(st));
    await cursorTo(S.cursor);
  };

  /**
   * 找元素：没出来就等，被盖住也等（弹窗在淡出），到点还不行就说清是哪种。
   * @param {Step} st @param {{ ms?: number, allowCovered?: boolean }} [o]
   * @returns {Promise<{ x: number, y: number, w: number, h: number }>}
   */
  const locate = async (st, o = {}) => {
    const ms = o.ms || LOCATE_MS;
    const t0 = Date.now();
    /** @type {any} */
    let last = null;
    for (;;) {
      guard();
      const r = await evalJs(P.resolveTargetScript(/** @type {import("./web-demo-plan").Target} */ (st.target)));
      if (r && r.error) throw stepFail(st, r.error);
      if (r && (o.allowCovered || !r.covered)) return { x: r.x, y: r.y, w: r.w, h: r.h };
      last = r;
      if (Date.now() - t0 >= ms) break;
      await sleep(200);
    }
    if (last && last.covered) throw stepFail(st, `被别的东西盖住了（弹窗或遮罩），等了 ${Math.round(ms / 1000)} 秒还是点不到`);
    throw stepFail(st, `等了 ${Math.round(ms / 1000)} 秒没找到这个元素`);
  };
  /** @param {{ x: number, y: number, w: number, h: number }} r */
  const center = (r) => ({ x: Math.round((r.x + r.w / 2) * 100) / 100, y: Math.round((r.y + r.h / 2) * 100) / 100 });

  /** 假光标沿缓动轨迹滑过去（真鼠标事件，页面的 hover 效果也跟着走） @param {{ x: number, y: number }} to */
  const moveMouse = async (to) => {
    for (const p of P.mousePath(S.cursor, to)) {
      guard();
      await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y });
      if (p.dt) await sleep(p.dt);
    }
    S.cursor = { x: to.x, y: to.y };
  };
  /** @param {{ x: number, y: number }} c */
  const clickAt = async (c) => {
    if (mobile) {
      // 手机上没有「滑过去」：手指直接落下，触点圆按下才出现
      await cursorTo(c);
      S.cursor = { x: c.x, y: c.y };
      await call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: c.x, y: c.y }] });
      await sleep(90);
      await call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      return;
    }
    await moveMouse(c);
    await nap(120);
    await call("Input.dispatchMouseEvent", { type: "mousePressed", x: c.x, y: c.y, button: "left", clickCount: 1 });
    await sleep(60);
    await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: c.x, y: c.y, button: "left", clickCount: 1 });
  };
  /** @param {string} name */
  const pressKey = async (name) => {
    const k = P.KEYS[name];
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode };
    await call("Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", ...base, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) });
    await sleep(40);
    await call("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  };
  /** @param {Step} st @param {{ x: number, y: number, w: number, h: number } | null} rect @param {number} at @param {number} [untilAt] */
  const zoomOn = (st, rect, at, untilAt) => {
    if (!rect || !autoZoom || st.zoom === false) return;
    S.zooms.push({ at, rect, ...(untilAt ? { untilAt } : {}), ...(st.scale ? { scale: st.scale } : {}) });
  };

  /**
   * @param {Step} st
   * @returns {Promise<{ x: number, y: number, w: number, h: number } | null>} 这步操作的元素（写进 steps.json）
   */
  const runStep = async (st) => {
    switch (st.op) {
      case "goto": {
        /** @type {string} */
        let url;
        if (st.path) url = pathToFileURL(path.resolve(/** @type {any} */ (ctx.resolveFile)(st.path))).href;
        else {
          url = String(st.url);
          const v = navVerdict(url, true);
          if (!v.ok) throw hard(`第 ${st.i} 步 goto：${v.why}`);
        }
        let loaded = false;
        const off = client.on("Page.loadEventFired", () => { loaded = true; });
        try {
          const r = await call("Page.navigate", { url }, LOAD_MS);
          if (r && r.errorText) throw hard(`第 ${st.i} 步 goto：页面没打开（${r.errorText}）`);
          if (r && r.loaderId) {
            const t0 = Date.now();
            while (!loaded && Date.now() - t0 < LOAD_MS) { guard(); await sleep(50); }
            if (!loaded) {
              let rs = "";
              try { rs = await evalJs("document.readyState", 5000); } catch (e) { if (isAbort(e, stop)) throw e; }
              if (rs === "loading" || !rs) throw stepFail(st, `页面 ${LOAD_MS / 1000} 秒还没加载出来`);
              S.warnings.push(`第 ${st.i} 步的页面 ${LOAD_MS / 1000} 秒没加载完（还有图片之类在下），接着录了`);
            }
          }
        } finally { off(); }
        await nap(300);
        await afterNav(st);
        return null;
      }
      case "click": {
        const r = await locate(st);
        const at = Date.now();
        await clickAt(center(r));
        zoomOn(st, r, at);
        return r;
      }
      case "type": {
        const at = Date.now();
        /** @type {{ x: number, y: number, w: number, h: number } | null} */
        let r = null;
        if (st.target) { r = await locate(st); await clickAt(center(r)); await nap(150); }
        else {
          try { r = await evalJs(ACTIVE_RECT, 5000); } catch (e) { if (isAbort(e, stop)) throw e; }
          if (r) await cursorTo(center(r));
        }
        const chars = Array.from(String(st.text || ""));
        const delays = P.typingPlan(String(st.text || ""), { seed: st.i });
        for (let k = 0; k < chars.length; k++) {
          guard();
          // 一个字一次 insertText：中文、emoji 都不走键码，输入法那一套也不会插进来
          await call("Input.insertText", { text: chars[k] });
          await sleep(delays[k]);
        }
        if (st.enter) { await nap(200); await pressKey("Enter"); }
        zoomOn(st, r, at, Date.now());
        return r;
      }
      case "press": {
        await pressKey(String(st.key));
        return null;
      }
      case "scroll": {
        const ms = st.ms || 700;
        let dy = Number(st.by) || 0;
        if (st.to != null) {
          const pos = await evalJs("(() => ({ y: scrollY, max: Math.max(0, document.documentElement.scrollHeight - innerHeight) }))()");
          const y = Number(pos && pos.y) || 0, max = Number(pos && pos.max) || 0;
          dy = st.to === "top" ? -y : st.to === "bottom" ? max - y : Math.min(max, Number(st.to)) - y;
        }
        if (Math.abs(dy) < 1) { await nap(ms); return null; }
        try {
          await call("Input.synthesizeScrollGesture", {
            x: Math.round(css.w / 2), y: Math.round(css.h / 2), yDistance: -dy,
            speed: Math.max(300, Math.round(Math.abs(dy) / (ms / 1000))),
            gestureSourceType: mobile ? "touch" : "mouse", repeatCount: 1,
          }, CALL_MS + ms * 2);
        } catch (e) {
          if (isAbort(e, stop) || S.halt) throw e;
          // 模拟手势是 CDP 的实验接口，个别 Chrome 不认：退成页面自己平滑滚，照实说一声
          if (!S.scrollWarned) { S.scrollWarned = true; S.warnings.push("这个 Chrome 不支持模拟滚动手势，改成了页面平滑滚动"); }
          await evalJs(`window.scrollBy({ top: ${dy}, behavior: "smooth" }); true`);
          await nap(ms);
        }
        return null;
      }
      case "hover": {
        const r = await locate(st, { allowCovered: true });
        const at = Date.now();
        if (mobile) { S.cursor = center(r); await cursorTo(S.cursor); } else await moveMouse(center(r));
        await nap(st.ms || 800);
        zoomOn(st, r, at, Date.now());
        return r;
      }
      case "wait": {
        if (!st.target) { await nap(st.ms || 0); return null; }
        const ms = st.timeout_ms || 10000;
        const t0 = Date.now();
        for (;;) {
          guard();
          const r = await evalJs(P.resolveTargetScript(st.target));
          if (r && r.error) throw stepFail(st, r.error);
          if (r) return { x: r.x, y: r.y, w: r.w, h: r.h };
          if (Date.now() - t0 >= ms) throw stepFail(st, `等了 ${Math.round(ms / 1000)} 秒，这个元素还没出现`);
          await sleep(200);
        }
      }
      case "zoom": {
        const r = st.rect ? { x: st.rect[0], y: st.rect[1], w: st.rect[2], h: st.rect[3] } : await locate(st, { allowCovered: true });
        const at = Date.now(), ms = st.ms || 1500;
        // 点名要放大的不受 auto_zoom 管
        S.zooms.push({ at, rect: r, untilAt: at + ms, ...(st.scale ? { scale: st.scale } : {}) });
        await nap(ms);
        return r;
      }
      case "caption": {
        const at = Date.now(), ms = st.ms || 2500;
        S.captions.push({ text: P.fixString(String(st.text || ""), pairs), at, untilAt: at + ms });
        if (st.hold !== false) await nap(ms);
        return null;
      }
      default:
        throw stepFail(st, "不认识这个动作");
    }
  };

  /** @param {Step} st */
  const shoot = async (st) => {
    const r = await call("Page.captureScreenshot", { format: "png" }, 20000);
    const name = P.shotName(st, pairs);
    fs.writeFileSync(path.join(workDir, "shots", name), Buffer.from(String(r && r.data || ""), "base64"));
    return name;
  };

  /** 步骤出错：先扫一遍现场，干净才留一张截图（这是出错时工作区里唯一会写的文件） @param {Step} st @param {any} e */
  const failStep = async (st, e) => {
    if (isAbort(e, stop)) return e;
    // Chrome 断了、页面跳走了：半路那条调用报的是「连接已关闭」之类，不如 halt 里那句说得清
    if (S.halt) return hard(S.halt.msg);
    if (e && e.noShot) return e;
    let note = "";
    try {
      await scan(`第 ${st.i} 步出错时`);
      const r = await call("Page.captureScreenshot", { format: "png" }, CALL_MS);
      const name = `fail-${String(st.i).padStart(2, "0")}.png`;
      fs.mkdirSync(path.join(outAbs, "steps"), { recursive: true });
      fs.writeFileSync(path.join(outAbs, "steps", name), Buffer.from(String(r && r.data || ""), "base64"));
      note = `。现场截图：${outRel}/steps/${name}`;
    } catch (e2) {
      // 现场有原文：这比步骤本身出错更要紧，报它
      if (e2 && /** @type {any} */ (e2).noShot) return e2;
      if (isAbort(e2, stop)) return e2;
    }
    return new Error(String(e && e.message || e) + note);
  };

  try {
    browser = await (ctx.browser ? ctx.browser(preset, { headless }) : isolatedBrowser(preset, { headless }));
    let tmpReal = os.tmpdir();
    try { tmpReal = fs.realpathSync(os.tmpdir()); } catch { /* 用原样 */ }
    const mp = P.maskPairs({ extra: inp.mask || [], tmpDirs: [workDir, browser.dir || "", tmpReal, os.tmpdir()].filter(Boolean) });
    pairs = mp.pairs; labels = mp.labels; hold.pairs = pairs;
    const mScript = ctx.maskScriptOverride || maskScript(pairs);
    const overlay = P.overlayScript({ mode: mobile ? "touch" : "arrow" });

    client = await cdp.connect(browser.pageWs, { idleMs: 0 });
    client.on("close", () => { if (!S.halt) S.halt = { msg: "录制用的 Chrome 中途断开了（崩了或被关了），没出片", noShot: true }; });
    client.on("Page.screencastFrame", (/** @type {any} */ p) => {
      // 先回执再干别的：不回执 Chrome 就不发下一帧
      client.call("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
      S.acks++;
      if (!S.capturing || typeof p.data !== "string") return;
      const now = Date.now();
      const last = S.frames[S.frames.length - 1];
      if (last && p.data === S.lastData) { last.until = now; return; }
      S.lastData = p.data;
      const buf = Buffer.from(p.data, "base64");
      // 比成片帧率还密的帧：覆盖上一张，不另起一帧。每帧时长至少一个帧间隔，
      // 密帧一张张排下去会把整条片子拉长（60 帧的屏录按 30 帧算就慢了一倍）
      if (last && now - last.at < interval) {
        fs.writeFileSync(path.join(workDir, last.file), buf);
        last.until = now;
        return;
      }
      const file = `frames/f${String(S.frames.length + 1).padStart(5, "0")}.jpg`;
      fs.writeFileSync(path.join(workDir, file), buf);
      S.frames.push({ file, at: now, until: now });
    });
    client.on("Page.frameNavigated", (/** @type {any} */ p) => {
      const f = (p && p.frame) || {};
      const main = !f.parentId;
      if (main) S.mainNavs++;
      const v = navVerdict(String(f.url || ""), main);
      if (!v.ok && !S.halt) S.halt = { msg: v.error ? String(v.why) : `页面跳到了不让打开的地址：${v.why}。已停止，没出片`, noShot: true, nav: true };
    });
    client.on("Page.javascriptDialogOpening", () => {
      // 弹窗会把页面卡住、后面的步骤全超时：直接点确定，照实记一笔
      client.call("Page.handleJavaScriptDialog", { accept: true }, 5000).catch(() => {});
      if (!S.dialogWarned) { S.dialogWarned = true; S.warnings.push("页面弹了对话框，自动点了确定（成片里看不到那个框）"); }
    });

    // 顺序有讲究（测试钉着）：先定视口和手机模拟，再挂马赛克和光标，最后才开始导航
    await call("Page.enable");
    try { await call("Page.bringToFront", {}, 5000); } catch (e) { if (isAbort(e, stop)) throw e; }
    await call("Emulation.setDeviceMetricsOverride", { width: css.w, height: css.h, deviceScaleFactor: preset.dsf, mobile, screenWidth: css.w, screenHeight: css.h });
    if (mobile) {
      await call("Emulation.setUserAgentOverride", { userAgent: preset.ua, platform: "iPhone" });
      await call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    }
    await call("Page.addScriptToEvaluateOnNewDocument", { source: mScript });
    await call("Page.addScriptToEvaluateOnNewDocument", { source: overlay });
    await evalJs(mScript);
    await evalJs(overlay);

    const n = steps.length;
    for (const st of steps) {
      guard();
      progress({ stage: "step", done: st.i - 1, total: n, pct: Math.round(((st.i - 1) / n) * 100), label: `第 ${st.i}/${n} 步：${VERB[st.op] || st.op}${st.label ? " " + st.label : ""}` }, st.i === 1);
      const rec = { i: st.i, op: st.op, label: st.label || "", startWall: Date.now(), endWall: 0, shot: /** @type {string | null} */ (null), target: /** @type {any} */ (null) };
      S.recs.push(rec);
      try {
        rec.target = await runStep(st);
        if (!S.capturing) {
          // 第一步 goto 过了自检才开始收帧：打开页面之前那段白屏不进片子
          S.capturing = true;
          S.capStart = Date.now();
          await call("Page.startScreencast", { format: "jpeg", quality: 85, maxWidth: out.w, maxHeight: out.h, everyNthFrame: 1 });
          await cursorTo(S.cursor);
          const t0 = Date.now();
          while (!S.frames.length) {
            guard();
            if (Date.now() - t0 > FIRST_FRAME_MS) throw hard("3 秒没收到一帧画面：Chrome 没在画这个页面（有界面的窗口被挡住、最小化会这样），用 headless 录再试");
            await sleep(50);
          }
        }
        await nap(SETTLE_MS);
        if (S.mainNavs !== S.seenNavs) await afterNav(st);
        await scan(stepName(st));
        if (st.shot) rec.shot = await shoot(st);
      } catch (e) {
        throw await failStep(st, e);
      }
      rec.endWall = Date.now();
    }
    progress({ stage: "step", done: n, total: n, pct: 100, label: "步骤都做完了" }, true);

    await scan("录完");
    const stopAt = Date.now();
    S.capturing = false;
    try { await call("Page.stopScreencast", {}, 5000); } catch (e) { if (isAbort(e, stop)) throw e; }
    // 最后一步之后就没人再叫 guard 了：收尾那几百毫秒里页面跳走、Chrome 断开，也得在这儿拦下，不能照样交片。
    // 不直接调 guard：它还管时长上限，录完了再按超时判就冤了
    if (S.halt) throw hard(S.halt.msg);
    const lastF = S.frames[S.frames.length - 1];
    if (lastF) lastF.until = Math.max(lastF.until, stopAt);

    // ---------------------------------------------------------------- 合成
    const frames = S.frames;
    const { durations } = fitDurations(frames, { interval, speed });
    fs.writeFileSync(path.join(workDir, "list.txt"), P.concatList(frames, durations));
    const total = durations.reduce((a, b) => a + b, 0);
    /** @param {number} ms */
    const T = (ms) => P.mapTime(frames, durations, ms);
    const poses = P.zoomPoses(
      S.zooms.map((z) => ({ t: T(z.at), rect: z.rect, ...(z.untilAt ? { until: T(z.untilAt) } : {}), ...(z.scale ? { scale: z.scale } : {}) })),
      { cssW: css.w, cssH: css.h, maxZoom },
    );
    const vf = P.zoomFilter(poses, { w: out.w, h: out.h, fps, cssW: css.w, cssH: css.h });
    const caps = S.captions
      .map((c) => ({ text: c.text, start: T(c.at), end: Math.min(total, T(c.untilAt)) }))
      .filter((c) => c.end - c.start >= 0.05);

    // 字幕：同一个 Chrome 开第二个页签，透明底截成 PNG，放大之后再叠上去（画在页面里会跟着镜头被放大、裁掉）
    /** @type {string[]} */
    const capFiles = [];
    if (caps.length) {
      capPage = await cdp.newPage(browser.port);
      capClient = await cdp.connect(/** @type {any} */ (capPage).webSocketDebuggerUrl, { idleMs: 0 });
      /** @param {string} m @param {object} [p] */
      const cc = (m, p = {}) => capClient.call(m, p, CALL_MS);
      await cc("Page.enable");
      await cc("Emulation.setDeviceMetricsOverride", { width: out.w, height: out.h, deviceScaleFactor: 1, mobile: false });
      await cc("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
      const ft = await cc("Page.getFrameTree");
      const frameId = ft && ft.frameTree && ft.frameTree.frame && ft.frameTree.frame.id;
      for (let k = 0; k < caps.length; k++) {
        guard();
        progress({ stage: "shot", done: k, total: caps.length, label: `字幕 ${k + 1}/${caps.length}` }, k === 0);
        await cc("Page.setDocumentContent", { frameId, html: P.captionHtml(caps[k].text, { w: out.w, h: out.h, pairs }) });
        await sleep(60);
        const ev = await cc("Runtime.evaluate", { expression: CAP_RECT, returnByValue: true });
        const rc = ev && ev.result && ev.result.value;
        if (!rc || !(rc.w > 0) || !(rc.h > 0)) throw new Error(`第 ${k + 1} 条字幕没排出来，没出片`);
        const x = Math.max(0, Math.floor(rc.x)), y = Math.max(0, Math.floor(rc.y));
        const shot = await cc("Page.captureScreenshot", { format: "png", clip: { x, y, width: Math.ceil(rc.x + rc.w) - x, height: Math.ceil(rc.y + rc.h) - y, scale: 1 } });
        const file = `caps/cap${k + 1}.png`;
        fs.writeFileSync(path.join(workDir, file), Buffer.from(String(shot && shot.data || ""), "base64"));
        capFiles.push(file);
      }
      progress({ stage: "shot", done: caps.length, total: caps.length, label: "字幕排好了" }, true);
    }

    // 竖屏底下 20% 是平台自己的按钮和文案，字幕抬高点，别被挡
    const M = Math.round(out.h * (preset.aspect === "9:16" ? 0.2 : 0.08));
    // -reinit_filter 0：万一还是混进一张尺寸不同的帧，只让 scale 自己适应，别整串滤镜重建（fps、zoompan 的计数会归零、片子变短）
    const args = ["-hide_banner", "-y", "-reinit_filter", "0", "-f", "concat", "-safe", "0", "-i", "list.txt"];
    for (const f of capFiles) args.push("-loop", "1", "-framerate", String(fps), "-t", (total + 1).toFixed(3), "-i", f);
    let graph = `[0:v]${vf}[v0]`;
    caps.forEach((c, k) => {
      graph += `;[v${k}][${k + 1}:v]overlay=(W-w)/2:H-h-${M}:enable='between(t,${c.start.toFixed(3)},${c.end.toFixed(3)})':shortest=1[v${k + 1}]`;
    });
    // 截来的 JPEG 是全范围（pc）色彩；新版 ffmpeg 只写 format=yuv420p 会原样留着全范围，出来是 yuvj420p，
    // 有的播放器、平台转码会发灰或过曝。显式转成标准的有限范围（tv）
    graph += `;[v${caps.length}]scale=out_range=tv,format=yuv420p[out]`;
    // -t 定死总长：list.txt 最后一帧没有时长，ffmpeg 会拿前一段间隔去猜（最后一步停得久就多出一秒多）
    args.push("-filter_complex", graph, "-map", "[out]", "-c:v", "libx264", "-crf", "20", "-preset", "medium",
      "-movflags", "+faststart", "-r", String(fps), "-t", total.toFixed(3), "-an", "-progress", "pipe:1", "-nostats", "out.part.mp4");
    let timeoutMs = Math.max(120000, total * 6000);
    if (deadline) timeoutMs = Math.min(timeoutMs, Math.max(5000, deadline - Date.now()));
    progress({ stage: "encode", pct: 0, label: "合成视频" }, true);
    const encOpts = {
      bin: bins.ffmpeg.bin, cwd: workDir, signal: stop, timeoutMs,
      onTime: (/** @type {number} */ sec) => progress({ stage: "encode", pct: Math.min(99, Math.round((sec / Math.max(0.1, total)) * 100)), label: "合成视频" }),
    };
    await (ctx.runFfmpeg ? ctx.runFfmpeg(args, encOpts) : spawnFfmpeg(args, encOpts));
    progress({ stage: "encode", pct: 100, label: "合成好了" }, true);

    // 验片：尺寸、时长对不上就不交，宁可报错也不交一条歪的
    const video = path.join(workDir, "out.part.mp4");
    const pr = await runBin(bins.ffprobe.bin, ["-v", "error", "-show_entries", "stream=width,height:format=duration", "-of", "json", video], { timeout: 30000, signal: stop, what: "ffprobe" });
    /** @type {any} */
    let info = null;
    try { info = JSON.parse(pr.stdout); } catch { /* 下面报 */ }
    const vs = info && Array.isArray(info.streams) ? info.streams.find((/** @type {any} */ s) => s && s.width) : null;
    const dur = Number(info && info.format && info.format.duration);
    const tol = Math.max(0.5, 2 / fps);
    if (!vs || vs.width !== out.w || vs.height !== out.h || !Number.isFinite(dur) || Math.abs(dur - total) > tol) {
      throw new Error(`合成出来的视频不对（应为 ${out.w}×${out.h}、${total.toFixed(1)} 秒，实际 ${vs ? vs.width + "×" + vs.height : "没有画面"}、${Number.isFinite(dur) ? dur.toFixed(1) : "?"} 秒），没交付`);
    }

    const stepsJson = P.buildStepsJson({
      video: "demo.mp4", aspect: preset.aspect, size: [out.w, out.h], fps, durationSec: dur, speed,
      steps: S.recs.map((r) => ({ i: r.i, op: r.op, label: r.label, start: T(r.startWall), end: T(r.endWall), shot: r.shot ? `steps/${r.shot}` : null, target: r.target })),
      zooms: poses.length > 1 ? poses : [], captions: caps, pairs, labels, probes: S.probes, scans: S.scans,
    });

    // ---------------------------------------------------------------- 交付：到这儿才第一次往工作区写
    // 排字幕、合成那段时间页面还开着：它自己跳去不让打开的地址，照样不交
    if (S.halt && S.halt.nav) throw hard(S.halt.msg);
    const stepsDir = path.join(outAbs, "steps");
    fs.mkdirSync(stepsDir, { recursive: true });
    // 同一个目录录第二遍：上一遍的截图不清掉，新旧会混在一起交出去
    const OURS = new RegExp(`^(\\d{2}-(${P.OPS.join("|")})(-.*)?|fail-\\d{2})\\.png$`);
    for (const f of fs.readdirSync(stepsDir)) if (OURS.test(f)) { try { fs.rmSync(path.join(stepsDir, f), { force: true }); } catch { /* 被占着就算了，新图照样写 */ } }
    const mp4 = path.join(outAbs, "demo.mp4");
    fs.copyFileSync(video, mp4 + ".part");
    fs.renameSync(mp4 + ".part", mp4);
    /** @type {string[]} */
    const shots = [];
    for (const r of S.recs) {
      if (!r.shot) continue;
      fs.copyFileSync(path.join(workDir, "shots", r.shot), path.join(stepsDir, r.shot));
      shots.push(`${outRel}/steps/${r.shot}`);
    }
    const sj = path.join(outAbs, "steps.json");
    fs.writeFileSync(sj + ".part", JSON.stringify(stepsJson, null, 2) + "\n");
    fs.renameSync(sj + ".part", sj);

    return {
      video: `${outRel}/demo.mp4`,
      shots,
      stepsJson: `${outRel}/steps.json`,
      durationSec: Math.round(dur * 10) / 10,
      size: [out.w, out.h],
      mask: stepsJson.mask,
      warnings: S.warnings,
      frames: frames.length,
      acks: S.acks,
    };
  } finally {
    S.capturing = false;
    if (capClient) { try { capClient.close(); } catch { /* 已经断了 */ } }
    if (capPage && browser) { try { await cdp.closePage(browser.port, capPage.id); } catch { /* 浏览器马上整个收掉 */ } }
    if (client) {
      try { await client.call("Page.stopScreencast", {}, 2000); } catch { /* 已经停了或断了 */ }
      try { client.close(); } catch { /* 已经断了 */ }
    }
    // 收尾出的错不能吞：临时 Chrome 没杀掉会一直占着内存，至少让人知道
    /** @type {string[]} */
    const notes = [];
    if (browser) { try { await browser.cleanup(); } catch (e) { notes.push(`录制用的临时 Chrome 没关干净（${e && /** @type {any} */ (e).message || e}）`); } }
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) { notes.push(`临时目录没删掉（${e && /** @type {any} */ (e).message || e}）`); }
    if (notes.length) { S.warnings.push(...notes); hold.note = notes.join("；"); }
  }
}

/**
 * tools.js 调的入口：成功给几行人话，失败给 isError（报错也过一遍打码）。用户点了停止就原样抛 AbortError，
 * 由 tools.js 统一说「用户已停止任务」。
 * @param {any} input
 * @param {Ctx} [ctx]
 * @returns {Promise<{ content: string, isError: boolean }>}
 */
async function runTool(input, ctx = {}) {
  /** @type {{ pairs?: [string, string][], note?: string }} */
  const hold = {};
  try {
    const r = await record(input, ctx, hold);
    const lines = [
      `录好了：${r.video}（${r.durationSec} 秒，${r.size[0]}×${r.size[1]}）`,
      r.shots.length ? `每步截图在 ${r.video.replace(/demo\.mp4$/, "")}steps/，每步起止时间在 ${r.stepsJson}` : `每步起止时间在 ${r.stepsJson}`,
      `打码自检通过；画布、图片、视频里的字遮不到，发出去前看一眼`,
    ];
    if (r.warnings.length) lines.push(`注意：${r.warnings.join("；")}`);
    const pairs = hold.pairs || [];
    return { content: lines.map((l) => P.fixString(l, pairs)).join("\n"), isError: false };
  } catch (e) {
    if (isAbort(e, ctx.stop)) throw e;
    const pairs = hold.pairs && hold.pairs.length ? hold.pairs : P.maskPairs({}).pairs;
    const msg = String(e && /** @type {any} */ (e).message || e) + (hold.note ? `（另外：${hold.note}）` : "");
    return { content: P.fixString(msg, pairs), isError: true };
  }
}

module.exports = { TOOL_DEF, runTool, record, outDirRel };
