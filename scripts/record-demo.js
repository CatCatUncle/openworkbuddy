#!/usr/bin/env electron
/**
 * 首屏 demo 录屏：用 Electron 离屏渲染把「输入任务 → 助理干活 → 出结果」录成 GIF（+ mp4）。
 *
 *   npm run demo:record -- --dry                 # 只录打字、不发送，零成本，验证管线
 *   npm run demo:record -- --prompt "帮我把 workspace 里的 销售明细.csv 按月汇总成一张表，给三条结论"
 *
 * 参数：
 *   --prompt <文字>   要录的任务（默认见 DEFAULT_PROMPT；示例数据会自动放进演示工作区）
 *   --out <路径>      GIF 输出（默认 docs/images/demo.gif；mp4 同名同目录）
 *   --dry            打完字就停，不点发送（不花模型钱）
 *   --speed <倍速>    全片倍速（默认 1 = 不指定，由 --target-sec 自动整形）
 *   --target-sec <秒>  成片目标时长（默认 40）：打字和结果段原速，只把等模型那段压进去；0 关掉
 *   --width <像素>    GIF 宽度（默认 960；窗口按 1280×800 渲染再缩）
 *   --fps <帧率>      采样帧率（默认 6）
 *   --max-sec <秒>    任务最长等待（默认 300）
 *   --port <端口>     演示服务端口（默认 3897，不碰你正在用的 3800）
 *   --keep           录完保留演示数据目录（默认删）
 *
 * 马赛克：页面里出现的临时目录 / home 目录 / 用户名 / 主机名全部替换掉再截帧（scripts/demo-mask.js），
 *   每次录制先自检遮罩生效，没生效直接报错不出片——录出去的 GIF 是要放公开仓库的。
 * 隔离：整份数据放临时目录（OPENWORKBUDDY_HOME），只把你 config.json 里的模型配置拷过去用，
 * IM / MCP / 工作区路径一律不带——绝不让演示实例连上你的飞书机器人或往真工作区写东西。
 * 登录：演示目录没账号，脚本自己注册一个随机密码的 demo 账号，录完随目录一起删。
 */
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const { defaultPairs, maskScript } = require("./demo-mask");
const { wireReadmes } = require("./demo-readme");
const { fitDurations } = require("./demo-timing");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_PROMPT = "帮我把 workspace 里的 销售明细.csv 按月汇总成一张表，再给我三条结论";
const SAMPLE_CSV = [
  "日期,城市,品类,销售额",
  "2026-01-05,上海,咖啡机,12800", "2026-01-18,北京,咖啡机,9600", "2026-01-26,深圳,磨豆机,4200",
  "2026-02-03,上海,磨豆机,5100", "2026-02-14,广州,咖啡机,15200", "2026-02-27,北京,滤纸,860",
  "2026-03-02,深圳,咖啡机,18800", "2026-03-11,上海,滤纸,1240", "2026-03-19,广州,磨豆机,6300",
  "2026-03-28,北京,咖啡机,21000",
].join("\n") + "\n";

function parseArgs(argv) {
  const a = { prompt: DEFAULT_PROMPT, out: path.join(ROOT, "docs", "images", "demo.gif"), dry: false, speed: 1, width: 960, fps: 6, maxSec: 300, port: 3897, keep: false, targetSec: 40 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === "--dry") a.dry = true;
    else if (k === "--keep") a.keep = true;
    else if (k === "--prompt") { a.prompt = v; i++; }
    else if (k === "--out") { a.out = path.resolve(v); i++; }
    else if (k === "--speed") { a.speed = Math.max(0.25, +v || 1); i++; }
    else if (k === "--width") { a.width = Math.max(320, +v || 960); i++; }
    else if (k === "--fps") { a.fps = Math.min(15, Math.max(2, +v || 6)); i++; }
    else if (k === "--max-sec") { a.maxSec = Math.max(10, +v || 300); i++; }
    else if (k === "--port") { a.port = +v || 3897; i++; }
    else if (k === "--target-sec") { a.targetSec = Math.max(0, +v || 0); i++; }
  }
  return a;
}
// electron <脚本> [--] 参数：npm run 会把 "--" 后面的原样带过来，Electron 自己不吃
const ARGS = parseArgs(process.argv.slice(2).filter((x) => x !== "--"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log("[demo]", ...m);

/** 只带模型相关配置进演示目录；含 Key 的字段只拷不打印 */
function seedHome(home) {
  fs.mkdirSync(path.join(home, "workspace"), { recursive: true });
  const src = path.join(process.env.OPENWORKBUDDY_HOME_SRC || ROOT, "config.json");
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(src, "utf8")); } catch { log("没找到可用的 config.json，演示实例会以模板启动（首次向导可能弹出）"); }
  // persona 是用户写的自我介绍，常带真名/公司，不进演示；im 里的 app_id/bot id 不拷，但值记下来进遮罩清单，万一哪里带出来也遮住
  const keep = ["provider", "openai", "anthropic", "models", "active_model", "assist_model", "last_picked_model", "model_follow_last", "search", "agent", "assistant", "onboarding", "media"];
  const out = {};
  for (const k of keep) if (cfg[k] !== undefined) out[k] = cfg[k];
  const secretish = [];
  (function walk(v) { if (!v) return; if (typeof v === "string") { if (v.length >= 6 && !/请修改|你的|example/.test(v)) secretish.push(v); } else if (typeof v === "object") Object.values(v).forEach(walk); })(cfg.im);
  if (typeof cfg.persona === "string" && cfg.persona.trim()) secretish.push(cfg.persona.trim());
  seedHome.extraMask = secretish;
  out.server = { host: "127.0.0.1", port: ARGS.port };
  out.im = {}; // 绝不连用户的飞书/企微/微信
  out.mcp_servers = []; // 服务端按数组遍历
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(out, null, 2));
  fs.writeFileSync(path.join(home, "workspace", "销售明细.csv"), SAMPLE_CSV);
  return Object.keys(out);
}

async function waitHttp(url, tries = 200) {
  for (let i = 0; i < tries; i++) {
    try { await fetch(url); return true; } catch {}
    await sleep(150);
  }
  return false;
}

/** 演示账号：随机密码、只活在临时目录里；在页面里注册好让 Cookie 直接落到窗口会话 */
async function ensureLoggedIn(win) {
  const masked = await win.webContents.executeJavaScript(`(() => { const m = document.getElementById("auth-mask"); return !!(m && m.classList.contains("show")); })()`);
  if (!masked) return false;
  const pass = crypto.randomBytes(12).toString("base64url");
  const r = await win.webContents.executeJavaScript(`fetch("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "demo", password: ${JSON.stringify(pass)} }) }).then(r => r.status)`);
  if (r !== 200) throw new Error("演示账号注册失败 HTTP " + r);
  win.webContents.reload();
  await new Promise((res) => win.webContents.once("did-finish-load", res));
  await sleep(600);
  return true;
}

class Recorder {
  constructor(win, dir, fps) {
    this.win = win; this.dir = dir; this.interval = Math.round(1000 / fps);
    this.frames = []; this.last = null; this.running = false; this.shots = 0; this.marks = {};
  }
  mark(name) { this.marks[name] = Date.now(); }
  async grab() {
    const img = await this.win.webContents.capturePage();
    const png = img.toPNG();
    const t = Date.now();
    this.shots++;
    // 画面没变就不落新帧，只把上一帧的时长拉长：等模型的几十秒不会堆出几百张一样的图
    if (this.last && this.last.png.equals(png)) { this.last.until = t; return; }
    const file = path.join(this.dir, String(this.frames.length).padStart(5, "0") + ".png");
    fs.writeFileSync(file, png);
    this.last = { file, png, at: t, until: t };
    this.frames.push(this.last);
  }
  start() {
    this.running = true;
    (async () => { while (this.running) { const t0 = Date.now(); try { await this.grab(); } catch (e) { log("截帧失败:", e.message); } await sleep(Math.max(20, this.interval - (Date.now() - t0))); } })();
  }
  async stop() { this.running = false; await sleep(this.interval + 50); if (this.last) this.last.until = Date.now(); }
  /** ffmpeg concat 列表：打字/结果段原速，等模型那段按 --target-sec 压（或 --speed 全片倍速） */
  writeList(speed, targetSec) {
    const fit = fitDurations(this.frames, { interval: this.interval, speed, targetSec, sent: this.marks.sent, done: this.marks.done });
    this.fit = fit;
    const lines = [];
    for (let i = 0; i < this.frames.length; i++) {
      lines.push(`file '${this.frames[i].file}'`, `duration ${fit.durations[i].toFixed(3)}`);
    }
    if (this.frames.length) lines.push(`file '${this.frames[this.frames.length - 1].file}'`); // concat 规矩：末帧要再列一次
    const list = path.join(this.dir, "list.txt");
    fs.writeFileSync(list, lines.join("\n") + "\n");
    return list;
  }
}

function ffmpeg(args) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf8" });
  if (r.error) throw new Error("没找到 ffmpeg：brew install ffmpeg（或 apt/choco 装一个）");
  if (r.status !== 0) throw new Error("ffmpeg 失败：" + (r.stderr || "").trim().split("\n").slice(-3).join(" | "));
}

/** 装马赛克层并自检：塞一段带真实路径的文字进页面，读回来必须已经被遮掉 */
async function installMask(win, pairs) {
  const got = await win.webContents.executeJavaScript(maskScript(pairs));
  const probe = pairs[0][0] + "/workspace/x.csv";
  const seen = await win.webContents.executeJavaScript(`(async () => {
    const d = document.createElement("div"); d.id = "__mask_probe"; d.style.display = "none";
    d.textContent = ${JSON.stringify(probe)}; document.body.appendChild(d);
    await new Promise((r) => setTimeout(r, 30));
    const v = d.textContent; d.remove(); return v; })()`);
  if (seen.includes(pairs[0][0])) throw new Error("马赛克没生效，拒绝录制：" + seen);
  return got;
}

async function typeInto(win, text) {
  await win.webContents.executeJavaScript(`inputEl.focus(); inputEl.value = ""; inputEl.dispatchEvent(new Event("input"));`);
  for (let i = 1; i <= text.length; i++) {
    await win.webContents.executeJavaScript(`inputEl.value = ${JSON.stringify(text.slice(0, i))}; inputEl.dispatchEvent(new Event("input"));`);
    await sleep(/[，。,.]/.test(text[i - 1]) ? 220 : 55);
  }
}

app.whenReady().then(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-demo-"));
  const framesDir = path.join(home, "_frames");
  fs.mkdirSync(framesDir);
  const t0 = Date.now();
  let exitCode = 0;
  try {
    const cfgKeys = seedHome(home);
    log(`演示目录 ${home}（config 带了 ${cfgKeys.length} 个块，IM/MCP 已清空）`);
    process.env.OPENWORKBUDDY_HOME = home;
    process.env.PORT = String(ARGS.port);
    process.env.HOST = "127.0.0.1";
    require(path.join(ROOT, "server.js"));
    const base = `http://127.0.0.1:${ARGS.port}`;
    if (!(await waitHttp(base + "/api/auth/state"))) throw new Error("演示服务 30 秒内没起来");
    log(`服务就绪 +${Date.now() - t0}ms`);

    const win = new BrowserWindow({ show: false, width: 1280, height: 800, backgroundColor: "#ffffff", webPreferences: { offscreen: true, backgroundThrottling: false } });
    win.webContents.on("console-message", (ev, level, msg) => { const m = typeof ev === "object" && ev.message !== undefined ? ev.message : msg; const l = typeof ev === "object" && ev.level !== undefined ? ev.level : level; if (l === "error" || l === 3) log("页面报错:", String(m).slice(0, 200), ev && ev.sourceId ? `@ ${path.basename(String(ev.sourceId))}:${ev.lineNumber}` : ""); });
    // 页面里的未捕获 Promise 错误只在 console 里留一句没有栈，这里补上栈方便排查
    win.webContents.on("dom-ready", () => { win.webContents.executeJavaScript(`window.addEventListener("unhandledrejection", (e) => console.error("[unhandled] " + (e.reason && e.reason.stack || e.reason)))`).catch(() => {}); });
    await win.loadURL(base + "/");
    await sleep(800);
    if (await ensureLoggedIn(win)) log("已用临时 demo 账号进入界面");
    const ready = await win.webContents.executeJavaScript(`typeof curBusy === "function" && !!document.getElementById("input")`);
    if (!ready) throw new Error("页面没加载出输入框");
    const pairs = defaultPairs(home, seedHome.extraMask || []);
    log(`马赛克层已装：遮 ${await installMask(win, pairs)} 项（临时目录 / home / 用户名 / 主机名）`);
    await sleep(1200); // 让首屏动画/历史加载完再开录

    const rec = new Recorder(win, framesDir, ARGS.fps);
    rec.start();
    await sleep(1000);
    await typeInto(win, ARGS.prompt);
    await sleep(900);
    if (ARGS.dry) {
      log("--dry：不发送，只录打字");
      await sleep(1500);
    } else {
      await win.webContents.executeJavaScript(`send()`);
      rec.mark("sent");
      log("已发送，等助理跑完…");
      const deadline = Date.now() + ARGS.maxSec * 1000;
      await sleep(1500);
      while (Date.now() < deadline) {
        const busy = await win.webContents.executeJavaScript(`curBusy()`);
        if (!busy) break;
        await sleep(300);
      }
      if (Date.now() >= deadline) log(`超过 ${ARGS.maxSec} 秒仍在跑，按现状收尾（可加 --max-sec）`);
      else log(`助理完成 +${Date.now() - t0}ms`);
      rec.mark("done");
      await sleep(1500); // 先停在结论和产出 chip 上
      // 产出不再自动弹预览（抢版面），演示里替观众点一下第一个能在 app 里预览的 chip，把成果亮出来。
      // 只挑网页/图/md/pdf/csv：老 Office 格式点了会拉起系统程序，录屏里不能出现别的窗口
      const clicked = await win.webContents.executeJavaScript(`(() => {
        const c = [...document.querySelectorAll(".out-block .out-card")].find((x) => /\\.(html?|png|jpe?g|gif|webp|svg|md|pdf|csv)$/i.test(x.dataset.name || ""));
        if (!c) return "";
        c.click();
        return c.dataset.name;
      })()`);
      if (clicked) log(`点开产出 chip 预览：${clicked}`);
      await sleep(clicked ? 3500 : 2500); // 停在结果上让人看清
    }
    await rec.stop();
    log(`采样 ${rec.shots} 次，落盘 ${rec.frames.length} 帧（相邻相同的已合并）`);
    if (!rec.frames.length) throw new Error("一帧都没录到");

    const list = rec.writeList(ARGS.speed, ARGS.targetSec);
    if (rec.fit.factor > 1) log(`等模型那段 ${rec.fit.work.toFixed(1)}s 压到 ${(rec.fit.work / rec.fit.factor).toFixed(1)}s（×${rec.fit.factor.toFixed(1)}），打字和结果段原速`);
    fs.mkdirSync(path.dirname(ARGS.out), { recursive: true });
    const scale = `scale=${ARGS.width}:-2:flags=lanczos`;
    ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-vf", `${scale},split[a][b];[a]palettegen=max_colors=200:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`, "-loop", "0", ARGS.out]);
    const mp4 = ARGS.out.replace(/\.gif$/i, "") + ".mp4";
    try { ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-vf", `${scale},format=yuv420p`, "-fps_mode", "cfr", "-r", "12", "-c:v", "libx264", "-crf", "23", "-movflags", "+faststart", mp4]); } catch (e) { log("mp4 跳过：", e.message); }
    const total = rec.fit.durations.reduce((s, d) => s + d, 0);
    const size = fs.statSync(ARGS.out).size;
    log(`GIF ${ARGS.out}  ${(size / 1024 / 1024).toFixed(2)} MB  时长 ${total.toFixed(1)}s  ${ARGS.width}px 宽`);
    if (fs.existsSync(mp4)) log(`MP4 ${mp4}  ${(fs.statSync(mp4).size / 1024 / 1024).toFixed(2)} MB`);
    if (size > 8 * 1024 * 1024) log("GIF 超过 8MB，README 里会加载得慢：试试 --target-sec 25 或 --width 800");
    // 真录才挂进 README 首屏（--dry 的片子是验管线的，不上门面）；已经挂过就不重复
    if (!ARGS.dry) {
      const wired = wireReadmes(ROOT, ARGS.out);
      const rel = path.relative(ROOT, ARGS.out).split(path.sep).join("/");
      if (wired.length) log(`已把 demo 挂进 ${wired.join(" / ")} 首屏；提交时一起加：git add -- ${rel} ${wired.join(" ")}`);
      else log(`README 没改（已经挂着，或 GIF 不在仓库里）：git add -- ${rel}`);
    }
    win.destroy();
  } catch (e) {
    console.error("[demo] 失败：", e.message);
    exitCode = 1;
  } finally {
    if (ARGS.keep) log(`保留演示目录 ${home}`);
    else fs.rmSync(home, { recursive: true, force: true });
  }
  app.exit(exitCode);
});
