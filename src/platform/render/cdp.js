// @ts-check
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 极小的 Chrome DevTools Protocol 客户端。
 * 不引入 puppeteer/playwright：本机 Chrome 已经有 CDP，Agent 只需要一条受限的
 * localhost WebSocket。所有调用都必须显式给 tab_id，避免误操作当前窗口。
 *
 * 端口没人应答时会自己拉起一个**专用** Chrome：单独的 user-data-dir，跟你日常那个
 * 浏览器两套 cookie、两套登录态，互不打扰，也不用你记住那串启动命令。
 */
const http = require("http");
const https = require("https");
const net = require("net");
const tls = require("tls");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFile } = require("child_process");

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
// URL 解析 IPv6 时 hostname 是带方括号的 "[::1]"，直接拿去比对集合永远不相等——
// 于是 ::1 明明写在白名单里却一直被拒。统一剥掉方括号再比。
const isLocal = (h) => LOCAL_HOSTS.has(String(h || "").replace(/^\[|\]$/g, ""));

function endpointHost(raw) {
  const u = new URL(raw || "http://127.0.0.1:9222");
  if (!/^https?:$/.test(u.protocol) || !isLocal(u.hostname)) {
    throw new Error("Chrome CDP 只允许连接本机地址（127.0.0.1 / localhost / ::1）");
  }
  return u;
}
function getJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = endpointHost(url), lib = u.protocol === "https:" ? https : http;
    const req = lib.request(u, { method: opts.method || "GET", timeout: opts.timeout || 4000, headers: { Accept: "application/json" } }, (res) => {
      let body = "";
      res.setEncoding("utf8"); res.on("data", (x) => { body += x; });
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch { reject(new Error(`CDP 返回的不是 JSON（HTTP ${res.statusCode}）`)); } });
    });
    req.on("timeout", () => req.destroy(new Error("连接 Chrome CDP 超时")));
    req.on("error", reject);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 本进程自己拉起来的那个 Chrome。拉起一次就一直复用，不会每调一次开一个窗口。 */
const OWN = { port: 0, pid: 0, dir: "", headless: false };

// 拉起来的 Chrome 不会自己消失：detached + unref 之后它和本进程就断了关系，没人收就一直挂着。
// 这台机器上真挂出过一个：跑了十个半小时，GPU 进程常年 160% CPU，load average 上了三位数。
// 所以三条线一起兜——闲置到点自己关、本进程退出时带走、也能显式关。
/** 闲多久自己关。0 = 不自动关。每次读环境变量，测试里改了就立刻生效。 */
function idleMs() {
  const raw = process.env.OWB_CDP_IDLE_MS;
  const n = raw === undefined || raw === "" ? 10 * 60 * 1000 : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
let idleTimer = null;
function clearIdle() { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } }
/** 每用一次就把倒计时往后推。定时器要 unref，不然它自己会把进程吊住不退出。 */
function touchIdle() {
  clearIdle();
  const ms = idleMs();
  if (!ms || !OWN.pid) return;
  idleTimer = setTimeout(() => close("闲置超时"), ms);
  if (typeof idleTimer.unref === "function") idleTimer.unref();
}
/** detached 起的是一整个进程组，要连组一起收：只杀主进程的话，GPU 和渲染器那几个还在转。 */
function killTree(pid, sig) {
  try { process.kill(-pid, sig); } catch {}
  try { process.kill(pid, sig); } catch {}
}
/** 关掉本进程拉起来的那个 Chrome。用户自己开着的窗口一律不碰。 */
function close(why = "") {
  clearIdle();
  const pid = OWN.pid, port = OWN.port;
  OWN.port = 0; OWN.pid = 0; OWN.dir = ""; OWN.headless = false;
  if (!pid) return { closed: false, why: "当前这个 Chrome 不是本工具拉起来的，不动它" };
  // 浏览器都要没了，挂在它身上的「过会儿冻住 / 闲久了关掉」也一起撤：留着的话到点去连一个死端口
  forgetPort(port);
  killTree(pid, "SIGTERM");
  const t = setTimeout(() => killTree(pid, "SIGKILL"), 2000);
  if (typeof t.unref === "function") t.unref();
  return { closed: true, pid, why: why || "显式关闭" };
}
/**
 * spawnIsolated() 拉起的一次性 Chrome：pid → profile 目录。跟 OWN 是两本账——
 * 它们不复用、不闲置计时、谁拉的谁在 finally 里 kill()；这里只是给「进程要退了」兜底。
 * @type {Map<number, string>}
 */
const ISO = new Map();
/** 进程要退了：自己拉起的浏览器全部带走，一次性的那些连 profile 目录一起删。 */
function reapAll() {
  if (OWN.pid) killTree(OWN.pid, "SIGKILL");
  for (const [pid, dir] of ISO) {
    killTree(pid, "SIGKILL");
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch {}
  }
  ISO.clear();
}
let hooked = false;
/**
 * 第一次真的 spawn 出东西之后才挂钩子，没用过这条线的进程不受影响。
 * 专用的和一次性的共用这一个钩子：各挂各的话，同一个信号上就有两个监听，
 * 下面「只有自己在听才替 Node 退出」的判断两边都不成立，Ctrl-C 就按不动了。
 */
function hookExit() {
  if (hooked) return;
  hooked = true;
  process.on("exit", reapAll);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
      reapAll();
      // 只是搭个便车。原来没人管这个信号的话，得替 Node 把默认的「收到就退」补回来——
      // 一旦加了监听，默认行为就被顶掉了，不补的话 Ctrl-C 会变成按了没反应。
      if (process.listenerCount(sig) <= 1) process.exit(sig === "SIGINT" ? 130 : 143);
    });
  }
}

const CHROMES = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
  linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"],
};
function findChrome() {
  const envPath = String(process.env.OWB_CHROME_PATH || "").trim();
  if (envPath) return fs.existsSync(envPath) ? envPath : "";
  for (const c of CHROMES[process.platform] || CHROMES.linux) { try { if (fs.existsSync(c)) return c; } catch {} }
  return "";
}

/** 端口上有没有一个真的 DevTools。有就返回版本信息，没有就 null——不抛异常，探测本来就允许失败。 */
async function probe(port, timeout = 1500) {
  try {
    const v = await getJson(`http://127.0.0.1:${port}/json/version`, { timeout });
    return v && (v.webSocketDebuggerUrl || v.Browser) ? v : null;
  } catch { return null; }
}

function readPortFile(portFile) {
  try { return Number(String(fs.readFileSync(portFile, "utf8")).split("\n")[0].trim()) || 0; } catch { return 0; }
}
function profileDir(raw) {
  const dir = String(raw || "").trim() || path.join(os.homedir(), "OpenWorkBuddy", "chrome-cdp");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 这几个 profile 文件存在 = 有 Chrome 正开着这个 profile（macOS/Linux 是前两个，Windows 是 lockfile） */
const PROFILE_LOCKS = ["SingletonLock", "SingletonSocket", "lockfile"];
const profileLocked = (dir) => PROFILE_LOCKS.some((f) => { try { fs.lstatSync(path.join(dir, f)); return true; } catch { return false; } });
/**
 * 这个 profile 现在被哪个进程开着。Chrome 在 profile 里放一个 SingletonLock 符号链接，指向「主机名-pid」。
 * 光有 pid 不够：pid 会被复用，崩掉的 Chrome 留下的锁可能正指着一个不相干的进程——
 * 所以再用 ps 核一遍它的命令行里确实带着这个 user-data-dir，核不上就当不知道（不认领、不去杀）。
 * @param {string} dir
 * @returns {Promise<{ pid: number, headless: boolean }>}
 */
async function profileOwner(dir) {
  const none = { pid: 0, headless: false };
  if (process.platform === "win32") return none;
  let pid = 0;
  try { pid = Number((/-(\d+)$/.exec(fs.readlinkSync(path.join(dir, "SingletonLock"))) || [])[1]) || 0; } catch {}
  if (!pid) return none;
  /** @type {string} */
  // 不加 windowsHide：Windows 上开头就 return 了
  const cmd = await new Promise((res) => execFile("ps", ["-p", String(pid), "-o", "command="], { timeout: 3000 }, (e, out) => res(e ? "" : String(out || ""))));
  if (!cmd.includes(`--user-data-dir=${dir}`)) return none;
  return { pid, headless: /--headless\b/.test(cmd) };
}
const TRIM_DIRS = ["optimization_guide_model_store", "component_crx_cache", "BrowserMetrics"];
/**
 * 拉起前顺手清掉 Chrome 自己下载、自己能重建的几样：优化模型、组件包、指标。启动参数已经不让它再下了，
 * 这里只收以前攒下的。登录态那几样（Cookies、Local Storage、Login Data、IndexedDB）一概不碰——
 * 用户在这个浏览器里登过的站全靠它们。
 * profile 正被某个 Chrome 开着（可能是用户自己手动开的）就一个字节都不动：在人家脚底下删文件，崩的是人家。
 * @param {string} dir
 * @returns {Promise<string[]>} 真删掉了哪几个
 */
async function trimProfile(dir) {
  if (profileLocked(dir)) return [];
  const gone = [];
  for (const d of TRIM_DIRS) {
    const p = path.join(dir, d);
    try { await fs.promises.access(p); await fs.promises.rm(p, { recursive: true, force: true }); gone.push(d); } catch {}
  }
  return gone;
}

/**
 * 拉起专用 Chrome。端口写死 0：由 Chrome 自己挑一个空的，再从 DevToolsActivePort 读回来。
 * 这样就绕开了「9222 被别的东西占着、但它根本不是 DevTools」——本机就是这个情况：
 * Chrome 主进程在 9222 上 listen，/json/version 却是空的，于是所有人都以为调试口开着。
 */
function wantHeadless(input) {
  if (input.headless !== undefined) return !!input.headless;
  if (String(process.env.OWB_CDP_HEADLESS || "") === "1") return true;
  // Linux 上没有 DISPLAY/WAYLAND_DISPLAY 就是台服务器，有头根本起不来。
  return process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
}
async function launch(input = {}) {
  const bin = findChrome();
  if (!bin) {
    throw new Error("这台机器上没找到 Chrome（也没有 Chromium / Edge / Brave）。装一个，或者把浏览器可执行文件的完整路径写进环境变量 OWB_CHROME_PATH。");
  }
  const dir = profileDir(input.user_data_dir);
  const portFile = path.join(dir, "DevToolsActivePort");
  // 先认领：这个 profile 上可能已经有一个我们之前拉起的 Chrome 还活着。
  // 顺序反过来（先删端口文件再拉）会踩坑——同一个 profile 再 spawn 一次，Chrome 只是把
  // 网址交给已在跑的那个实例然后自己退出，端口文件又被我们删了，于是干等 20 秒然后报错。
  const had = readPortFile(portFile);
  if (had && (await probe(had, 1200))) {
    OWN.port = had; OWN.dir = dir;
    // 认领来的也要记下 pid：以前只记端口，于是闲置到点不关（touchIdle 看 pid）、退出时也不带走（reapAll 看 pid）——
    // 应用崩过一次、下次启动认领回来的那个 Chrome 就成了没人管的常驻进程
    const who = await profileOwner(dir);
    if (who.pid) { OWN.pid = who.pid; OWN.headless = who.headless; hookExit(); touchIdle(); }
    return { port: had, launched: false, adopted: true, ...(who.pid ? { pid: who.pid } : {}), user_data_dir: dir, bin };
  }
  try { fs.rmSync(portFile, { force: true }); } catch {}
  await trimProfile(dir);
  const args = [
    "--remote-debugging-port=0", `--user-data-dir=${dir}`,
    "--no-first-run", "--no-default-browser-check", "--no-service-autorun", "--disable-background-networking",
    // 2026-09-28 实测这个 profile 攒到 317M：HTTP 缓存 139M、优化模型 40M、组件包 30M——自动化一样都用不上。
    // 缓存封顶 64MB；组件更新关掉（代价：这个浏览器里放不了带 DRM 的视频，自动化不需要）
    "--disk-cache-size=67108864", "--disable-component-update",
    "--disable-features=Translate,AcceptCHFrame,OptimizationGuideModelDownloading,OptimizationHints,OptimizationHintsFetching,MediaRouter",
    "--hide-crash-restore-bubble", "--password-store=basic",
  ];
  // 无头也要能跑 WebGL：闪卡、Three.js、地图这类页面没有 GL 上下文就只剩一句报错。
  // 千万别顺手加 --disable-gpu——那正好把 WebGL 关掉，截出来的图上写着
  // 「Error creating WebGL context」，而页面本身一点毛病没有。
  if (wantHeadless(input)) args.push("--headless=new", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-dev-shm-usage");
  args.push("about:blank");
  // 不加 windowsHide：有头模式这就是给人看、给人点的那扇 Chrome 窗口，加了第一次显示会被藏掉；无头本来就没窗口
  const child = spawn(bin, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await sleep(150);
    const port = readPortFile(portFile);
    if (port && (await probe(port, 1200))) {
      OWN.port = port; OWN.pid = child.pid || 0; OWN.dir = dir; OWN.headless = wantHeadless(input);
      hookExit(); touchIdle();
      return { port, launched: true, pid: OWN.pid, user_data_dir: dir, bin };
    }
  }
  throw new Error(`拉起了 ${path.basename(bin)}，但 20 秒内没等到它的调试端口。多半是这个 user-data-dir（${dir}）已经被另一个正在跑的 Chrome 占着——把那个窗口关掉，或者换个目录（user_data_dir 参数）再试。`);
}

/**
 * @typedef {{ port: number, pid: number, dir: string, bin: string, args: string[], browserWs: string, kill: () => Promise<void> }} IsolatedChrome
 */
/**
 * 拉一个用完就扔的 Chrome：全新的临时 profile，没有 cookie、没有登录态、没有扩展。
 *
 * 为什么不复用 launch()：那个是给 chrome_cdp 用的**常驻**浏览器——它记在 OWN 上、闲置到点才关、
 * profile 在 ~/OpenWorkBuddy/chrome-cdp 里存着你的登录态。录演示、渲动画要的正好相反：
 * 干净（录出来的画面里不能冒出你的账号）、独占（不跟 chrome_cdp 抢同一个标签页）、
 * 用完连目录一起删。所以这里一概不碰 OWN，也不碰那个 profile。
 *
 * 调用方必须在 finally 里 await kill()；进程被 Ctrl-C 或正常退出时 hookExit 也会兜底收走。
 * @param {{ headless?: boolean, extraArgs?: string[], windowSize?: { w: number, h: number }, tmpRoot?: string, prefix?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<IsolatedChrome>}
 */
async function spawnIsolated(opts = {}) {
  const bin = findChrome();
  if (!bin) {
    throw new Error("这台机器上没找到 Chrome（也没有 Chromium / Edge / Brave）。装一个，或者把浏览器可执行文件的完整路径写进环境变量 OWB_CHROME_PATH。");
  }
  // 前缀只收 owb- 开头的：测试收尾那把扫帚（e2e reapStaleTempHomes）只认这一族，别的前缀崩了没人收
  const prefix = /^owb-[a-z0-9-]{1,40}$/i.test(String(opts.prefix || "")) ? String(opts.prefix) : "owb-webdemo-prof-";
  const dir = fs.mkdtempSync(path.join(opts.tmpRoot || os.tmpdir(), prefix));
  const portFile = path.join(dir, "DevToolsActivePort");
  // --disable-features 只认最后一个：调用方再传一个就会把这里的整串顶掉，所以合成一个
  const feats = new Set(["Translate", "AcceptCHFrame", "IsolateOrigins", "site-per-process"]);
  const extra = [];
  for (const a of opts.extraArgs || []) {
    const m = /^--disable-features=(.*)$/.exec(String(a));
    if (m) m[1].split(",").map((s) => s.trim()).filter(Boolean).forEach((f) => feats.add(f));
    else extra.push(String(a));
  }
  const args = [
    "--remote-debugging-port=0", `--user-data-dir=${dir}`,
    "--no-first-run", "--no-default-browser-check", "--no-service-autorun", "--disable-background-networking",
    "--hide-crash-restore-bubble", "--password-store=basic", "--mute-audio", "--hide-scrollbars",
    // iframe 留在同一个进程里：遮罩脚本和泄漏扫描才够得着跨域 iframe 里的字
    "--disable-site-isolation-trials", `--disable-features=${[...feats].join(",")}`,
  ];
  // 全新 profile 第一次碰钥匙串，macOS 会弹「要使用你的机密信息」——无头模式下没人点得了，就卡住了
  if (process.platform === "darwin") args.push("--use-mock-keychain");
  const ws = opts.windowSize;
  if (ws && ws.w > 0 && ws.h > 0) args.push(`--window-size=${Math.round(ws.w)},${Math.round(ws.h)}`);
  // 同 launch()：无头也要能跑 WebGL，别加 --disable-gpu。--no-sandbox 也不加：Linux 上起不来就如实报错。
  if (opts.headless !== false) args.push("--headless=new", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-dev-shm-usage");
  args.push(...extra, "about:blank");

  // stderr 落到 profile 目录里的一个文件：起不来时拿它的尾巴当报错；接管道的话没人读，
  // 缓冲一满 Chrome 就卡在写日志上。文件随目录一起删。
  const logFile = path.join(dir, "owb-chrome-stderr.log");
  let errFd = -1;
  try { errFd = fs.openSync(logFile, "w"); } catch {}
  // 不加 windowsHide：opts.headless:false 时要的就是一扇看得见的窗口；无头本来就没窗口
  const child = spawn(bin, args, { detached: true, stdio: ["ignore", "ignore", errFd >= 0 ? errFd : "ignore"] });
  if (errFd >= 0) { try { fs.closeSync(errFd); } catch {} }
  // 压根没起来（没执行权限、路径是个目录）时只有 error、没有 exit，不记下来就会干等满超时
  /** @type {Error | null} */
  let spawnErr = null;
  child.on("error", (e) => { spawnErr = e; });
  child.unref();
  const pid = child.pid || 0;
  /** @type {{ code: number | null, sig: string | null } | null} */
  let exited = null;
  /** @type {Array<() => void>} */
  const onExit = [];
  child.on("exit", (code, sig) => { exited = { code, sig }; for (const f of onExit.splice(0)) f(); });
  const waitExit = (ms) => new Promise((res) => {
    if (exited || !pid) return res(true);
    const t = setTimeout(() => res(false), ms);
    onExit.push(() => { clearTimeout(t); res(true); });
  });
  if (pid) { ISO.set(pid, dir); hookExit(); }
  let killed = false;
  const kill = async () => {
    if (killed) return;
    killed = true;
    if (pid) {
      killTree(pid, "SIGTERM");
      if (!(await waitExit(3000))) { killTree(pid, "SIGKILL"); await waitExit(1000); }
      // 主进程退了不代表 GPU / 渲染器那几个也退了：连组再补一刀，组里没人了这一下什么也不做
      killTree(pid, "SIGKILL");
      ISO.delete(pid);
    }
    // Chrome 刚死的那一下还可能在往 profile 里写，删目录要带重试
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  };
  const tail = () => { try { return fs.readFileSync(logFile, "utf8").trim().split("\n").slice(-6).join("\n").slice(-600); } catch { return ""; } };

  const limit = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 20000;
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) {
    await sleep(120);
    if (spawnErr && !exited) {
      const msg = /** @type {Error} */ (spawnErr).message;
      await kill();
      throw new Error(`${path.basename(bin)} 没能启动：${msg}`);
    }
    if (exited) {
      const log = tail();
      await kill();
      const how = exited.sig ? `被信号 ${exited.sig} 结束` : `退出码 ${exited.code}`;
      throw new Error(`${path.basename(bin)} 一启动就退出了（${how}）。${log ? "它最后说的是：\n" + log : "它什么也没说。"}`);
    }
    const port = readPortFile(portFile);
    const v = port ? await probe(port, 1200) : null;
    if (v) return { port, pid, dir, bin, args, browserWs: String(v.webSocketDebuggerUrl || ""), kill };
  }
  const log = tail();
  await kill();
  throw new Error(`拉起了 ${path.basename(bin)}，但 ${Math.round(limit / 1000)} 秒内没等到它的调试端口。${log ? "它最后说的是：\n" + log : ""}`);
}

/**
 * 发一个 HTTP 请求，原样拿回状态码和正文。/json/close 回的是一句纯文本（"Target is closing"），
 * 走 getJson 会被当成「不是 JSON」报错，所以单开一个不解析的。
 * @param {string} url
 * @param {{ method?: string, timeout?: number }} [opts]
 * @returns {Promise<{ status: number, body: string }>}
 */
function httpText(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = endpointHost(url), lib = u.protocol === "https:" ? https : http;
    const req = lib.request(u, { method: opts.method || "GET", timeout: opts.timeout || 4000 }, (res) => {
      let body = "";
      res.setEncoding("utf8"); res.on("data", (x) => { body += x; });
      res.on("end", () => resolve({ status: res.statusCode || 0, body }));
    });
    req.on("timeout", () => req.destroy(new Error("连接 Chrome CDP 超时")));
    req.on("error", reject);
    req.end();
  });
}

/**
 * 在指定端口的 Chrome 里新开一个标签页。Chrome 111 起 /json/new 只收 PUT，老版本只认 GET，两个都试。
 * @param {number} port
 * @param {string} [url]
 * @returns {Promise<{ id: string, webSocketDebuggerUrl: string, [k: string]: any }>}
 */
async function newPage(port, url = "about:blank") {
  const at = `http://127.0.0.1:${Number(port)}/json/new?${encodeURIComponent(String(url || "about:blank"))}`;
  /** @type {any} */
  let t = null;
  try { t = await getJson(at, { method: "PUT" }); } catch {}
  if (!t || !t.webSocketDebuggerUrl) { try { t = await getJson(at); } catch {} }
  if (!t || !t.id || !t.webSocketDebuggerUrl) throw new Error(`Chrome（端口 ${port}）没开出新标签页`);
  return t;
}

/**
 * 关掉一个标签页。已经不在了（404）也算关好了：清理代码里要的是「它不在了」，不是「这一下是我关的」。
 * 连不上端口才抛——那说明浏览器本身没了，调用方自己决定要不要管。
 * @param {number} port
 * @param {string} id
 * @returns {Promise<void>}
 */
async function closePage(port, id) {
  if (!id) return;
  const r = await httpText(`http://127.0.0.1:${Number(port)}/json/close/${encodeURIComponent(String(id))}`);
  if (r.status !== 200 && r.status !== 404) throw new Error(`Chrome 没关掉标签页 ${id}（HTTP ${r.status}）：${r.body.slice(0, 120)}`);
}

/**
 * 找一个能用的 CDP 端口：显式指定的 → 本进程之前拉起的 → 默认 9222 → 自己拉一个。
 */
async function ensure(input = {}) {
  const want = Number(input.port) || 0;
  if (want) { if (await probe(want)) return { port: want, launched: false }; }
  if (OWN.port && (await probe(OWN.port))) return { port: OWN.port, launched: false, reused: true, pid: OWN.pid, user_data_dir: OWN.dir };
  if (!want && (await probe(9222))) return { port: 9222, launched: false };
  if (input.launch === false || process.env.OWB_CDP_NO_LAUNCH === "1") {
    throw new Error(`${want || 9222} 端口上没有 Chrome DevTools（端口通不通都一样：有东西 listen 不代表它是调试口）。自己启一个：\n  "${findChrome() || "chrome"}" --remote-debugging-port=9222 --user-data-dir=/tmp/openworkbuddy-chrome\n或者把 OWB_CDP_NO_LAUNCH 取消掉，让它自己拉起一个专用窗口。`);
  }
  return await launch(input);
}
/**
 * 编一个 WebSocket 帧。客户端发出去的必须 mask（RFC 6455 §5.3）。
 * @param {string | Buffer} data
 * @param {boolean} [mask]
 * @param {number} [opcode] 1 = 文本，10 = pong
 */
function frame(data, mask = true, opcode = 1) {
  const body = Buffer.from(data), head = [0x80 | opcode];
  const n = body.length, key = mask ? crypto.randomBytes(4) : null;
  if (n < 126) head.push((mask ? 0x80 : 0) | n);
  else if (n < 65536) head.push((mask ? 0x80 : 0) | 126, n >> 8, n & 255);
  // 64 KiB 以上：127 后面**恰好 8 个字节**的长度（大端）。以前这里多塞了一个 0，写成 9 个字节，
  // Chrome 按 8 字节读长度，把真长度的最高位当成了载荷——70000 字节的帧被读成 273 字节，
  // 后面整条流全错位。平时的 CDP 消息都很短所以一直没露馅，一发大脚本（遮罩、字幕 HTML）就炸。
  else head.push((mask ? 0x80 : 0) | 127, 0, 0, 0, Math.floor(n / 2 ** 32) & 255, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
  if (!key) return Buffer.concat([Buffer.from(head), body]);
  const out = Buffer.alloc(body.length); for (let i = 0; i < body.length; i++) out[i] = body[i] ^ key[i % 4];
  return Buffer.concat([Buffer.from(head), key, out]);
}
/**
 * @typedef {(params: any, msg: any) => void} CdpListener
 * @typedef {{
 *   call: (method: string, params?: object, timeoutMs?: number) => Promise<any>,
 *   send: (method: string, params?: object, timeoutMs?: number) => Promise<any>,
 *   on: (event: string, fn: CdpListener) => () => void,
 *   off: (event: string, fn: CdpListener) => void,
 *   close: () => void,
 * }} CdpClient
 */
/**
 * 连一条 CDP WebSocket。
 * - 带 id 的回包交给对应的 call；不带 id 的是事件（Page.screencastFrame 之类），按 method 分给 on() 挂的回调。
 *   另有一个伪事件 "close"：连接断了（Chrome 崩了、被关了）会通知一次，录屏这种只等事件、手里没有
 *   未决调用的场景，靠它才知道别再干等。真 CDP 事件一定是「域.事件」的形状，不会和它撞名。
 * - idleMs：多久一个字节都没有就断开，默认 10 秒（chrome_cdp 一直是这个值）。0 = 不因为安静而断：
 *   录一个静止页面时 Chrome 一帧都不推，10 秒一到连接就被自己掐了。握手本身另有 10 秒上限，不受它影响。
 * @param {string} wsUrl
 * @param {{ idleMs?: number }} [opts]
 * @returns {Promise<CdpClient>}
 */
function connect(wsUrl, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl), secure = u.protocol === "wss:", port = Number(u.port) || (secure ? 443 : 80);
    if (!/^(ws|wss):$/.test(u.protocol) || !isLocal(u.hostname)) {
      throw new Error("Chrome CDP WebSocket 只允许连接本机地址");
    }
    // 分开建连而不是 (secure ? tls : net).connect：运行时没区别，但 TypeScript 能精确
    // 推断这两个重载，后续给 socket 的事件和 write 增加类型检查时不退化成 any。
    const socket = secure
      ? tls.connect({ host: u.hostname, port, servername: u.hostname })
      : net.connect({ host: u.hostname, port });
    const key = crypto.randomBytes(16).toString("base64");
    let opened = false, dead = false;
    const pending = new Map(); let seq = 0;
    /** @type {Map<string, Set<CdpListener>>} */
    const listeners = new Map();
    const emit = (method, params, msg) => {
      for (const cb of [...(listeners.get(method) || [])]) { try { cb(params, msg); } catch {} }
    };
    const fail = (e) => {
      for (const p of pending.values()) { if (p.timer) clearTimeout(p.timer); p.reject(e); }
      pending.clear();
      if (!opened) { clearTimeout(shakeTimer); reject(e); }
      if (!dead) { dead = true; if (opened) emit("close", { reason: e && e.message || "" }, null); }
    };
    // 握手单独限时：idleMs=0 时 socket 本身不再超时，对面收了 TCP 却不回 101 的话会一直挂着
    const shakeTimer = setTimeout(() => { if (!opened) socket.destroy(new Error("Chrome CDP 握手超时")); }, 10000);
    if (typeof shakeTimer.unref === "function") shakeTimer.unref();
    const idle = opts.idleMs === undefined || opts.idleMs === null ? 10000 : Math.max(0, Number(opts.idleMs) || 0);
    if (idle > 0) socket.setTimeout(idle, () => socket.destroy(new Error("Chrome CDP 操作超时")));
    socket.on("error", fail); socket.on("close", () => fail(new Error("Chrome CDP 连接已关闭")));
        // 握手里**不许**带 Origin。Chrome 111 起，带 Origin 的 CDP WebSocket 一律 403，
    // 除非启动时把它写进 --remote-allow-origins。以前这里固定发 `Origin: http://localhost`，
    // 于是 /json/list 能列出标签页、真要操作就 403，报出来的却是「请确认用 --remote-debugging-port 启动」——
    // 一句指着错误方向的话，人照着去查启动参数，查一晚上也查不出问题。
    socket.on("connect", () => socket.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    // 收到的块先排队，攒够一整帧才拼一次。以前每来一块就 Buffer.concat 一次：一帧 300KB 的截图
    // 分成几十块到，就是几十次越拼越长的拷贝（O(n²)），录屏每秒几十帧时全耗在这上面。
    let buf = Buffer.alloc(0);
    /** @type {Buffer[]} */
    const queue = []; let queued = 0;
    const need = (n) => {
      if (buf.length >= n) return true;
      if (buf.length + queued < n) return false;
      buf = Buffer.concat([buf, ...queue], buf.length + queued); queue.length = 0; queued = 0;
      return true;
    };
    const consume = () => {
      if (!opened) { need(buf.length + queued); const i = buf.indexOf("\r\n\r\n"); if (i < 0) return; const h = buf.subarray(0, i).toString(); const line = (h.split("\r\n")[0] || "").trim();
        // 只认状态码 101。**不要**回去比对 "Switching Protocols" 那句原因短语：
        // 新版 Chrome 回的是「101 WebSocket Protocol Handshake」，字面比对会把一次
        // 成功的握手判成失败，于是除了 list_tabs 什么都做不了。
        if (!/^HTTP\/1\.[01] 101\b/i.test(line)) return fail(new Error(`Chrome 拒绝了这条 CDP WebSocket：${line || "没给状态行"}。403 多半是握手里带了 Origin（Chrome 111 起不再接受），或者这个 Chrome 是拿 --remote-allow-origins 限制过的。`)); buf = buf.subarray(i + 4); opened = true; clearTimeout(shakeTimer); resolve(client); }
      while (need(2)) {
        const b1 = buf[0], b2 = buf[1]; let len = b2 & 127, off = 2;
        if (len === 126) { if (!need(4)) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (!need(10)) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (b2 & 128) { if (!need(off + 4)) return; off += 4; }
        if (!need(off + len)) return; const payload = buf.subarray(off, off + len); buf = buf.subarray(off + len);
        if ((b1 & 15) === 8) { socket.end(); return; }
        // Chrome 可以在长任务里发 ping；不回 pong 连接会被它主动清掉，表现成偶发的
        // 「Chrome CDP 连接已关闭」。客户端发出的帧必须 mask，沿用同一个编码器即可。
        if ((b1 & 15) === 9) { socket.write(frame(payload, true, 10)); continue; }
        if ((b1 & 15) !== 1) continue;
        /** @type {any} */
        let msg = null;
        try { msg = JSON.parse(payload.toString()); } catch { continue; }
        if (!msg) continue;
        if (msg.id && pending.has(msg.id)) {
          const p = pending.get(msg.id); pending.delete(msg.id); if (p.timer) clearTimeout(p.timer);
          msg.error ? p.reject(new Error(msg.error.message || "CDP 调用失败")) : p.resolve(msg.result || {});
        } else if (!msg.id && typeof msg.method === "string") emit(msg.method, msg.params || {}, msg);
      }
    };
    socket.on("data", (d) => { queue.push(d); queued += d.length; consume(); });
    const close = () => { if (!socket.destroyed) socket.end(); };
    /**
     * @param {string} method
     * @param {object} [params]
     * @param {number} [timeoutMs] 这一条最多等多久，0 = 不单独限时（仍受 idleMs 管）
     * @returns {Promise<any>}
     */
    function call(method, params = {}, timeoutMs = 0) {
      return new Promise((res, rej) => {
        // 连接已经断了还往里写，这条调用就永远等不到回包——当场拒掉，别让调用方干等
        if (dead || socket.destroyed) return rej(new Error("Chrome CDP 连接已关闭"));
        const id = ++seq;
        /** @type {{resolve: Function, reject: Function, timer: any}} */
        const p = { resolve: res, reject: rej, timer: null };
        if (timeoutMs > 0) {
          p.timer = setTimeout(() => { if (pending.delete(id)) rej(new Error(`Chrome 没在 ${Math.round(timeoutMs / 100) / 10} 秒内回 ${method}`)); }, timeoutMs);
        }
        pending.set(id, p);
        socket.write(frame(JSON.stringify({ id, method, params })));
      });
    }
    /** @type {(event: string, fn: CdpListener) => void} */
    const off = (event, fn) => { const s = listeners.get(event); if (s) { s.delete(fn); if (!s.size) listeners.delete(event); } };
    /** @type {(event: string, fn: CdpListener) => () => void} */
    const on = (event, fn) => {
      let s = listeners.get(event); if (!s) { s = new Set(); listeners.set(event, s); }
      s.add(fn);
      return () => off(event, fn);
    };
    /** @type {CdpClient} */
    const client = { call, send: call, on, off, close };
  });
}
/**
 * 哪个任务开的哪个标签页：owner（会话 id）→ { port, id }。
 *
 * 几个对话同时用浏览器，不给 tab_id 时以前一律拿「第一个页面标签页」——这边导航到博物馆官网，
 * 那边截的「游戏画面」就成了博物馆首页，模型还当真去分析。现在每个任务头一回用就给它单开一个，
 * 往后不点名都落在自己那个上；别人的标签页不列给它看，点名去动也拦下。
 * 没带 owner 的调用（命令行、直调、测试）用一个没人占着的页面标签页——绝不落到别的任务的标签页上。
 * @typedef {{ port: number, id: string, opened: boolean, last: number, idle: any }} OwnedTab
 * @type {Map<string, OwnedTab>}
 */
const OWNED = new Map();
const ownerOf = (port, id) => { for (const [o, t] of OWNED) if (t.port === port && t.id === id) return o; return ""; };
const takenByOther = (port, id, owner) => { const o = ownerOf(port, id); return !!o && o !== owner; };

/** 每次读环境变量，测试里改了立刻生效。给 0 = 关掉这一条 */
function envMs(name, dflt) {
  const raw = process.env[name];
  const n = raw === undefined || raw === "" ? dflt : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
/**
 * 动完多久把页面冻住（只在无头模式，见 parkWrap）。
 * 以前是 8 秒。模型两次动作之间光想就常常 5-60 秒，「打开 → 等一会 → 截图/取值」中间那段页面早冻了，
 * 拿回来的是冻住那一刻的样子，模型照着旧状态下结论。2026-09-29 复审实测（真无头 Chrome，冻结点调到 1 秒）：
 * 打开后隔 6 秒取值，页面里每 100ms 走一下的计时器只走了 15 下，不冻是 65 下。
 * 当初要治的是一闲就是几分钟的游戏页，一分钟冻住照样治得住。
 */
const parkMs = () => envMs("OWB_CDP_PARK_MS", 60000);
/** 解冻之后结果里带的话：冻着那段页面里什么都没发生，模型得知道眼前这一屏可能是冻住前的样子 */
const THAW_NOTE = "这一页之前闲着被冻住了（页面里的定时器、动画、网络回调都停着），这一下才解冻；要看它自己跑出来的新状态，先等几秒再看";
/** 一个任务的标签页闲多久就关掉。整个浏览器那个闲置计时，只要还有别的任务在用就永远到不了点，所以按标签页单算 */
const tabIdleMs = () => envMs("OWB_CDP_TAB_IDLE_MS", 10 * 60 * 1000);
/** 同一个浏览器里最多给几个任务各开一个标签页。到顶了收掉闲得最久的那个 */
const maxTabs = () => Math.max(1, Math.floor(envMs("OWB_CDP_MAX_TABS", 6)) || 6);

/**
 * 这个任务此刻是不是还在跑。server.js 开机时接上（网页对话的 activeRuns + IM/定时任务的 holdRun）；
 * 没接的（命令行、测试）一律当「不在跑」，行为跟以前一样。
 *
 * 2026-09-29 复审：任务收尾时 releaseOwner 已经把它的标签页收了，所以还记在 OWNED 里的，多半是还没跑完的。
 * 以前闲置关页、到顶腾位只看「这一刻有没有动作在执行」：等用户回话 / 等审批超过 10 分钟的任务，
 * 回来发现填了一半的表单、登好的账号连页一起没了；第 7 个同时开浏览器的对话，会把另一个正在跑的对话的页收掉。
 */
let isActive = (/** @type {string} */ _owner) => false;
/** @param {((owner: string) => boolean) | null} fn */
function setActivePredicate(fn) { isActive = typeof fn === "function" ? fn : () => false; }
const stillRunning = (/** @type {string} */ owner) => { try { return !!isActive(owner); } catch { return false; } };

/**
 * 标签页被收掉的任务 → 下回来时要告诉它的话。不说的话模型拿到一张新开的白页，会当成原来那个网页去分析。
 * @type {Map<string, string>}
 */
const GONE = new Map();
function markGone(owner, why) {
  GONE.set(owner, why);
  if (GONE.size > 200) GONE.delete(GONE.keys().next().value);
}

/**
 * 无头模式下动完的标签页，过 parkMs() 冻住；下次再动之前先解冻、拉到前台。
 *
 * 2026-09-28 实测：无头 Chrome 用 SwiftShader 在 CPU 上画 WebGL，一个跑着 requestAnimationFrame 的游戏页
 * 整棵进程树吃 134-189% CPU，而那几分钟根本没有工具在用它（一趟任务动它一下，然后一闲就是几分钟）；
 * 冻住之后 7-18%。几个任务各开一个，就是几个核常年满载，整台 Mac 跟着卡。
 *
 * 解冻用 Page.bringToFront，不用「active + 焦点模拟」：这里每个动作单开一条 WebSocket、用完就关，
 * 焦点模拟跟着连接走，连接一关就失效，页面又变回 hidden——下一次截图拍到的是一个停住的画面。
 * bringToFront 改的是页面本身，换一条连接照样在。
 * 只在无头模式做：有头的浏览器里 bringToFront 会把 Chrome 窗口整个提到最前、抢走焦点，
 * 人正在别的应用里打字会被一下拽走；而有头模式下后台标签页 Chrome 自己就会降频。
 * @typedef {{ port: number, id: string, timer: any, parked: boolean, busy: number, parking: Promise<void> | null }} ParkSlot
 * @type {Map<string, ParkSlot>}
 */
const PARK = new Map();
const parkKey = (port, id) => `${port}:${id}`;
function parkSlot(port, id) {
  let s = PARK.get(parkKey(port, id));
  if (!s) { s = { port, id, timer: null, parked: false, busy: 0, parking: null }; PARK.set(parkKey(port, id), s); }
  return s;
}
function dropPark(port, id) {
  const s = PARK.get(parkKey(port, id));
  if (!s) return;
  if (s.timer) clearTimeout(s.timer);
  PARK.delete(parkKey(port, id));
}
/** 一个端口上的浏览器没了：停放和闲置计时一起撤 */
function forgetPort(port) {
  for (const s of [...PARK.values()]) if (s.port === port) dropPark(s.port, s.id);
  for (const [o, t] of [...OWNED]) if (t.port === port) { if (t.idle) clearTimeout(t.idle); OWNED.delete(o); }
  HEADLESS.delete(port);
}
/** 单开一条连接改页面的生命周期状态。标签页已经不在了返回 false */
async function lifecycle(port, id, state) {
  const tabs = await getJson(`http://127.0.0.1:${port}/json/list`);
  const t = (tabs || []).find((x) => x.id === id);
  if (!t || !t.webSocketDebuggerUrl) return false;
  const c = await connect(t.webSocketDebuggerUrl, { idleMs: 5000 });
  try { await c.call("Page.setWebLifecycleState", { state }, 3000); return true; } finally { c.close(); }
}
/** 按标签页各计各的：A 任务一直在动，不能把 B 任务那个标签页的冻结往后推 */
function armPark(port, id) {
  const slot = parkSlot(port, id);
  if (slot.timer) clearTimeout(slot.timer);
  slot.timer = null;
  const ms = parkMs();
  if (!ms) return;
  slot.timer = setTimeout(() => {
    slot.timer = null;
    if (PARK.get(parkKey(port, id)) !== slot || slot.busy || slot.parked) return;
    slot.parking = lifecycle(port, id, "frozen")
      .then((done) => { if (done) slot.parked = true; else dropPark(port, id); })
      .catch(() => {})
      .finally(() => { slot.parking = null; });
  }, ms);
  if (typeof slot.timer.unref === "function") slot.timer.unref();
}
/**
 * 这个端口上是不是无头浏览器。自己拉起的看启动参数；别的看 /json/version 里的 HeadlessChrome，一分钟问一次。
 * @type {Map<number, { v: boolean, at: number }>}
 */
const HEADLESS = new Map();
async function headlessAt(port) {
  if (port === OWN.port && OWN.pid) return OWN.headless;
  const hit = HEADLESS.get(port);
  if (hit && Date.now() - hit.at < 60000) return hit.v;
  const v = await probe(port);
  const h = !!v && (/headless/i.test(String(v.Browser || "")) || /HeadlessChrome/.test(String(v["User-Agent"] || "")));
  HEADLESS.set(port, { v: h, at: Date.now() });
  return h;
}
/**
 * 包住一个动作：动之前解冻 + 拉到前台，动完重新计时。解冻两步每次都发——
 * 同一个无头窗口里别的标签页被拉到前台时，这一页会被挤成 hidden，光看「冻没冻」判断不了。
 * 页面是从冻住状态解开的，结果里带上 note（给了才带；navigate 换了新页面，不用说）。
 * @param {number} port
 * @param {boolean} headless
 * @param {(call: CdpClient["call"], tab: any) => Promise<any>} fn
 * @param {string} [note]
 */
function parkWrap(port, headless, fn, note = "") {
  if (!headless) return fn;
  return async (call, tab) => {
    const slot = parkSlot(port, tab.id);
    slot.busy++;
    if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
    try {
      // 冻到一半：等它冻完再解，不然「冻住」那一下可能落在解冻之后，整个动作对着一个停住的页面做
      if (slot.parking) await slot.parking;
      const thawed = slot.parked;
      try { await call("Page.setWebLifecycleState", { state: "active" }, 5000); } catch {}
      try { await call("Page.bringToFront", {}, 5000); } catch {}
      slot.parked = false;
      const out = await fn(call, tab);
      return thawed && note && out && typeof out === "object" && !out.note ? { ...out, note } : out;
    } finally {
      slot.busy--;
      if (!slot.busy) armPark(port, tab.id);
    }
  };
}

/**
 * 这个任务的标签页闲太久：关掉，下回再来时新开一个并告诉它。
 * 任务还没跑完就不关，接着计时：它可能正等着用户回话，回来还要接着填那张表。无头的页早就冻住了，留着只占内存不占 CPU。
 */
function armTabIdle(owner, t) {
  if (t.idle) clearTimeout(t.idle);
  t.idle = null;
  const ms = tabIdleMs();
  if (!ms) return;
  t.idle = setTimeout(() => {
    t.idle = null;
    if (OWNED.get(owner) !== t) return;
    if ((PARK.get(parkKey(t.port, t.id)) || { busy: 0 }).busy || stillRunning(owner)) return armTabIdle(owner, t);
    markGone(owner, "你之前的标签页闲置太久已经关掉了，这是新开的空白页；要接着用就重新打开网址");
    dropOwner(owner).catch(() => {});
  }, ms);
  if (typeof t.idle.unref === "function") t.idle.unref();
}
/** 只撤账，不碰浏览器 */
function forgetOwner(owner) {
  const t = OWNED.get(owner);
  if (!t) return null;
  OWNED.delete(owner);
  if (t.idle) clearTimeout(t.idle);
  dropPark(t.port, t.id);
  return t;
}
/**
 * 撤账并把标签页收掉：自己开的关掉；关不掉（浏览器回了错），或者本来就是借来的那一页，就冻住——
 * 借来的那页可能是用户自己的，不能替他关，但也不能让它在后台接着转。有头的浏览器里借来的页一概不动。
 */
async function dropOwner(owner) {
  const slot = (() => { const t = OWNED.get(owner); return t ? PARK.get(parkKey(t.port, t.id)) : null; })();
  const t = forgetOwner(owner);
  if (!t) return false;
  if (slot && slot.parking) await slot.parking;
  if (t.opened) { try { await closePage(t.port, t.id); return true; } catch {} }
  const headless = await headlessAt(t.port).catch(() => false);
  if (t.opened || headless) { try { await lifecycle(t.port, t.id, "frozen"); } catch {} }
  return true;
}
/**
 * 到顶了：收掉闲得最久、此刻没在干活、任务也已经不在跑的。
 * 都还在跑就先超出上限——把另一个对话跑到一半的页收掉，比多开一页更糟。
 */
async function makeRoom(port, owner) {
  const others = [...OWNED].filter(([o, t]) => o !== owner && t.port === port);
  const idle = others.filter(([o, t]) => !(PARK.get(parkKey(port, t.id)) || { busy: 0 }).busy && !stillRunning(o)).sort((a, b) => a[1].last - b[1].last);
  for (let n = others.length; n >= maxTabs() && idle.length; n--) {
    const [victim] = /** @type {[string, OwnedTab]} */ (idle.shift());
    markGone(victim, "同时开着的标签页太多，你之前那个闲得最久，已经收掉了；这是新开的空白页，要接着用就重新打开网址");
    await dropOwner(victim);
  }
}

/** 这个任务自己的标签页：还在就用，不在了（被关、浏览器重启）就新开一个记下 */
async function ownTab(port, owner) {
  const had = OWNED.get(owner);
  if (had && had.port === port) {
    const tabs = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    if ((tabs || []).some((x) => x.id === had.id)) { had.last = Date.now(); armTabIdle(owner, had); return had.id; }
  }
  if (had) forgetOwner(owner);
  await makeRoom(port, owner);
  let id = "", opened = true;
  try { id = (await newPage(port)).id; } catch (e) {
    // 开不出新标签页（老浏览器、策略禁了）：退一步用一个没人占着的；全被占了就直说，不去跟别的任务抢同一个页面
    const pages = ((await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => [])) || []).filter((x) => x.type === "page");
    const free = pages.find((x) => !ownerOf(port, x.id));
    if (!free) throw new Error(`没能给这个任务单开一个标签页（${e.message}），其它标签页都有别的任务在用`);
    id = free.id; opened = false;
  }
  /** @type {OwnedTab} */
  const t = { port, id, opened, last: Date.now(), idle: null };
  OWNED.set(owner, t);
  armTabIdle(owner, t);
  return id;
}

/**
 * 任务收尾时把它开的标签页关掉。开着不关的话，一天跑几十个任务，
 * 后台 Chrome 里就挂着几十个页面（每个几十上百 MB），电脑越用越卡。关不掉（浏览器已经没了）也算关好了。
 */
async function releaseOwner(owner) {
  if (!owner) return false;
  GONE.delete(owner);
  return dropOwner(owner);
}

async function withTab(tabId, fn, port = 9222) {
  let tabs = await getJson(`http://127.0.0.1:${port}/json/list`);
  // 不点名时只挑没人占着的页面：别的任务的标签页正停在它自己的网页上，拿来一导航就把人家的活冲掉了
  const free = (list) => (list || []).filter((x) => x.type === "page" && !ownerOf(port, x.id));
  // 一个空闲页面都没有（窗口全关了、刚拉起来还没落地、或者全被别的任务占着）就自己开一个空白页，
  // 而不是甩一句「没有可操作的标签页」让人去手动点。
  if (!tabId && !free(tabs).length) {
    try { await getJson(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" }); } catch { try { await getJson(`http://127.0.0.1:${port}/json/new?about:blank`); } catch {} }
    tabs = await getJson(`http://127.0.0.1:${port}/json/list`);
  }
  const tab = (tabs || []).find((x) => x.id === tabId) || (tabId ? null : free(tabs)[0]);
  if (!tab || !tab.webSocketDebuggerUrl) throw new Error(tabId ? `找不到 Chrome 标签页：${tabId}` : "这个 Chrome 里没有可操作的页面标签页");
  const c = await connect(tab.webSocketDebuggerUrl); try { return await fn(c.call, tab); } finally { c.close(); }
}
/** 等页面自己说加载完了。截图前不等一下，十有八九拍到一张白板。 */
async function waitReady(call, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await sleep(200);
    try {
      const r = await call("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
      if (r.result?.value === "complete") { await sleep(300); return true; }
    } catch { return false; }
  }
  return false;
}
async function run(input = {}) {
  const action = String(input.action || "list_tabs");
  if (action === "status") {
    // status 只看不碰：它就是用来回答「现在到底连没连上」的，自己顺手拉起一个反而把答案改了。
    const want = Number(input.port) || 0;
    const cands = want ? [want] : [OWN.port, 9222].filter(Boolean);
    let port = 0, v = null;
    for (const c of cands) { const r = await probe(c); if (r) { port = c; v = r; break; } }
    const chrome = findChrome();
    return {
      alive: !!port, port: port || 0, launched_by_us: !!port && port === OWN.port,
      chrome: chrome || "（这台机器上没找到 Chrome，装一个，或把路径写进 OWB_CHROME_PATH）",
      browser: v?.Browser || "", user_data_dir: OWN.dir || "（不是本工具拉起来的）",
      tabs: port ? (((await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => [])) || []).filter((x) => x.type === "page").length) : 0,
      idle_close_ms: idleMs(),
      hint: port ? "" : `${want || 9222} 上没有 DevTools。直接发一条 navigate 或 screenshot 就行，会自己拉起一个专用 Chrome。`,
    };
  }
  if (action === "close") {
    // 浏览器是几个任务共用的：一个任务说「关掉」，只收它自己那个标签页，别把别人正用着的整个浏览器掐了
    const owner = String(input.owner || "");
    if (owner && [...OWNED.keys()].some((o) => o !== owner)) {
      await releaseOwner(owner);
      return { closed: false, why: "别的任务还在用这个浏览器，只关了你自己的标签页" };
    }
    if (owner) { forgetOwner(owner); GONE.delete(owner); }
    return close();
  }
  const ready = await ensure(input);
  const port = ready.port;
  touchIdle();
  const owner = String(input.owner || "");
  if (action === "list_tabs") {
    const mine = owner && OWNED.get(owner);
    const pages = (await getJson(`http://127.0.0.1:${port}/json/list`)).filter((x) => x.type === "page" && !takenByOther(port, x.id, owner));
    return { port, ...ready, tabs: pages.map((x) => ({ id: x.id, title: x.title, url: x.url, type: x.type, ...(mine && mine.port === port && mine.id === x.id ? { mine: true } : {}) })) };
  }
  const named = String(input.tab_id || "");
  if (named && owner && takenByOther(port, named, owner)) throw new Error(`标签页 ${named} 是别的任务在用，不能动。不给 tab_id 就会用你自己的标签页`);
  if (action === "close_tab") {
    if (!named) throw new Error("close_tab 要给 tab_id");
    try { await getJson(`http://127.0.0.1:${port}/json/close/${encodeURIComponent(named)}`); } catch {}
    const mine = owner && OWNED.get(owner);
    if (mine && mine.port === port && mine.id === named) forgetOwner(owner);
    dropPark(port, named);
    return { port, closed: named };
  }
  // 标签页被收掉过（闲太久 / 同时开太多）：这次用的是新开的空白页，结果里说一声
  const gone = owner && !named ? GONE.get(owner) || "" : "";
  if (gone) GONE.delete(owner);
  const tabId = named || (owner ? await ownTab(port, owner) : "");
  const headless = await headlessAt(port);
  const out = await withTab(tabId, parkWrap(port, headless, async (call, tab) => {
    if (action === "navigate") {
      const result = await call("Page.navigate", { url: String(input.url || "") });
      const wait = input.wait_ms === undefined ? 4000 : Math.min(60000, Math.max(0, Number(input.wait_ms) || 0));
      const loaded = wait ? await waitReady(call, wait) : null;
      return { tab_id: tab.id, port, loaded, result };
    }
    if (action === "evaluate") {
      // 注意层级：call() 已经把 msg.result 拆出来了，这里再 .result 就是 Runtime.evaluate
      // 自己那层 RemoteObject，取 .value 即可。多绕一层 .result 会让**每一次** evaluate
      // 都返回 undefined，而且不报错——页面里的脚本明明跑了，拿回来的却永远是空。
      const r = await call("Runtime.evaluate", { expression: String(input.expression || ""), returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) return { tab_id: tab.id, port, error: r.exceptionDetails.exception?.description || r.exceptionDetails.text || "页面脚本抛异常了" };
      return { tab_id: tab.id, port, result: r.result?.value };
    }
    if (action === "inspect") {
      const selector = String(input.selector || "body");
      const maxChars = Math.min(100000, Math.max(1000, Number(input.max_chars) || 20000));
      const expr = `(() => { const root=document.querySelector(${JSON.stringify(selector)}); return {found:!!root,title:document.title,url:location.href,text:root?(root.innerText||root.textContent||"").slice(0,${maxChars}):""}; })()`;
      return { tab_id: tab.id, ...(await call("Runtime.evaluate", { expression: expr, returnByValue: true })).result?.value };
    }
    if (action === "click") { const s = JSON.stringify(String(input.selector || "")); const r = await call("Runtime.evaluate", { expression: `(() => { const e=document.querySelector(${s}); if(!e) return {ok:false}; e.click(); return {ok:true,tag:e.tagName,text:(e.innerText||"").slice(0,120)}; })()`, returnByValue: true }); return { tab_id: tab.id, ...(r.result?.value || {}) }; }
    if (action === "type") { const s = JSON.stringify(String(input.selector || "")), v = JSON.stringify(String(input.text || "")); const r = await call("Runtime.evaluate", { expression: `(() => { const e=document.querySelector(${s}); if(!e) return {ok:false}; e.focus(); e.value=${v}; e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:${v}})); e.dispatchEvent(new Event('change',{bubbles:true})); return {ok:true}; })()`, returnByValue: true }); return { tab_id: tab.id, ...(r.result?.value || {}) }; }
    if (action === "screenshot") {
      const w = Number(input.width) || 0, h = Number(input.height) || 0;
      if (w && h) await call("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: Number(input.scale) || 0, mobile: false });
      if (input.wait_ms) await waitReady(call, Math.min(60000, Number(input.wait_ms)));
      const params = { format: "png", fromSurface: true };
      if (input.full_page) {
        try {
          const m = await call("Page.getLayoutMetrics", {});
          const cs = m.cssContentSize || m.contentSize;
          // 上限压到 16000：再高 Chrome 自己就返回空数据了，与其拿到一张废图不如截到这儿。
          if (cs && cs.width && cs.height) { params.clip = { x: 0, y: 0, width: Math.ceil(cs.width), height: Math.min(16000, Math.ceil(cs.height)), scale: 1 }; params.captureBeyondViewport = true; }
        } catch {}
      }
      const data = (await call("Page.captureScreenshot", params)).data;
      if (w && h) { try { await call("Emulation.clearDeviceMetricsOverride", {}); } catch {} }
      return { tab_id: tab.id, port, mime: "image/png", data };
    }
    throw new Error(`不支持的 Chrome CDP 操作：${action}`);
  }, action === "navigate" ? "" : THAW_NOTE), port);
  return gone && out && typeof out === "object" ? { ...out, note: gone } : out;
}
module.exports = { run, ensure, probe, findChrome, launch, close, endpointHost, connect, getJson, spawnIsolated, newPage, closePage, touchIdle, releaseOwner, setActivePredicate,
  _internals: { trimProfile, profileOwner, TRIM_DIRS, PARK, OWNED, parkMs, THAW_NOTE } };
