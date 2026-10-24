// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 桌面主进程在 Windows 上的三处外观：默认菜单、托盘图标、窗口底色跟主题。
 *
 *   【1】默认菜单：Windows 上拿掉（按 Alt 不再冒出英文 File/Edit/View），mac / Linux 原样（★反向对照★）；
 *        拿掉以后缩放、开发态的开发者工具由主进程自己接，剪贴板那几个键不碰（网页内核自己认）、
 *        AltGr（= Ctrl+Alt）打出来的字不会被当成缩放吃掉
 *   【2】托盘：Windows 用 public/tray.ico，里面 100%–300% 缩放要的每一档都有现成的一帧；
 *        mac / Linux 照旧 favicon.png（★反向对照★）；.ico 读不出来退回 PNG 并留一句日志；打包白名单带得上它
 *   【3】窗口底色跟主题：深色时不再是写死的白（改大小时闪白），颜色跟 ui.css 的 --background 一致；
 *        主题以设置页（owb-theme）为准，跟随系统时看 nativeTheme；点完设置、切回窗口、系统换深浅都会对一次；
 *        nativeTheme.themeSource 一律不改（一改隐藏的出图窗口也跟着翻深浅，生成的图会随应用主题变）；
 *        mac 上原样白底、不碰 nativeTheme（★反向对照★）
 *   【4】不许被顺手改掉的两行：AppUserModelId、Windows 网页缓存挪到 LOCALAPPDATA
 *
 * 本机是 macOS：被测函数都带 platform 参数，这里传 "win32" 跑 Windows 那条路、传 darwin / linux 做对照。
 * 不开窗口、不起服务、不出网，只切 electron-main.js 里的函数用假对象跑。
 *   node test/win-main.js
 */
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8").replace(/\r\n/g, "\n");
const EM = read("electron-main.js");

let pass = 0, fail = 0, finished = false;
process.on("exit", (code) => {
  if (finished || code !== 0) return;
  console.log(`\n✗ 这套测试没跑完就退了（跑到第 ${pass + fail} 条）`);
  process.exitCode = 1;
});
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? "  ← " + JSON.stringify(extra).slice(0, 400) : ""}`); }
}
function eq(got, want, name) { ok(Object.is(got, want), name, Object.is(got, want) ? undefined : { got, want }); }
/** 一段炸了记一条失败接着往下跑，要的是完整的红灯清单 */
async function section(title, fn) {
  console.log("\n" + title);
  try { await fn(); } catch (e) { fail++; console.log(`  ✗ 这一段直接炸了：${(e && e.stack || e).toString().split("\n").slice(0, 3).join(" | ")}`); }
}
/** 从 electron-main.js 切出一个顶层函数（到第一个顶格的 }）；切不出来直接抛——改了名就该红，不能切到空串悄悄变绿 */
function cut(name) {
  let a = EM.indexOf("\nfunction " + name + "(");
  if (a < 0) a = EM.indexOf("\nasync function " + name + "(");
  const b = a < 0 ? -1 : EM.indexOf("\n}\n", a);
  if (a < 0 || b < 0) throw new Error(`electron-main.js 里切不出 ${name}（改名了？）`);
  return EM.slice(a + 1, b + 2);
}
const NAMES = ["dropDefaultMenu", "shellKeyAction", "attachShellKeys", "themeBg", "applyShellTheme", "uiTheme", "watchShellTheme", "trayIconFile"];
const LOGS = [];
const M = new Function("path", "bootLog", NAMES.map(cut).join("\n") + `\nreturn { ${NAMES.join(", ")} };`)(path, (...a) => LOGS.push(a.join(" ")));
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await section("【窗口】任务链接复用工作台，成果预览独立打开", async () => {
    const { workbenchLink } = require("../src/desktop/window-links");
    const origin = "http://127.0.0.1:3800";
    for (const pathname of ["/", "/index.html", "/%69ndex.html", "/%2f", "//"]) {
      eq(workbenchLink(origin + pathname + "?s=abc_1", origin)?.sessionId, "abc_1", "工作台路径复用主窗口：" + pathname);
    }
    for (const url of [origin + "/api/files/view/report.html", origin + "/shared.html", "https://example.com/?s=abc_1", "http://127.0.0.1:3801/?s=abc_1", "file:///index.html", "bad url"]) {
      eq(workbenchLink(url, origin), null, "文件、不同来源和无效地址不冒充工作台：" + url);
    }
    eq(workbenchLink(origin + "/?s=%3Cscript%3E", origin)?.sessionId, "", "无效任务号不进入页面脚本");
    const a = EM.indexOf("  const sameOrigin = (u) => {");
    const b = EM.indexOf("  win.webContents.setWindowOpenHandler(openHandler);", a);
    ok(a >= 0 && b > a, "使用真实的窗口打开逻辑");
    const calls = { focus: 0, show: 0, restore: 0, scripts: [], children: [], external: [] };
    const win = { isDestroyed: () => false, isMinimized: () => true, restore: () => calls.restore++, show: () => calls.show++, focus: () => calls.focus++, webContents: { executeJavaScript: (code) => { calls.scripts.push(code); return Promise.resolve(); } } };
    class Child extends EventEmitter {
      constructor() { super(); this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = (fn) => { this.openHandler = fn; }; this.loadURL = (url) => { this.url = url; }; calls.children.push(this); }
    }
    const open = new Function("workbenchLink", "PORT", "win", "BrowserWindow", "themeBg", "SHELL_THEME", "nativeTheme", "process", "throttleWhenAway", "attachContextMenu", "attachShellKeys", "shell", "bootLog", EM.slice(a, b) + "\nreturn openHandler;")(
      workbenchLink, 3800, win, Child, () => "white", {}, {}, { platform: "darwin" }, () => {}, () => {}, () => {}, { openExternal: (url) => calls.external.push(url) }, () => {});
    eq(open({ url: origin + "/?s=abc_1" }).action, "deny", "任务链接阻止创建窗口");
    eq(calls.children.length, 0, "任务链接没有创建工作台副本");
    ok(calls.focus === 1 && calls.restore === 1 && calls.show === 1, "恢复并聚焦主窗口");
    ok(calls.scripts[0].includes('"owb-open-session"') && calls.scripts[0].includes('"abc_1"') && !calls.scripts[0].includes("loadURL"), "任务号交给页面切换，主窗口不重载");
    open({ url: origin + "/" });
    eq(calls.scripts.length, 1, "主页链接只聚焦，不切换任务");
    open({ url: origin + "/api/files/view/report.html" });
    eq(calls.children.length, 1, "成果文件仍能创建独立预览");
    const child = calls.children[0];
    eq(child.url, origin + "/api/files/view/report.html", "预览打开准确的文件地址");
    for (const event of ["will-navigate", "will-redirect"]) {
      let prevented = false;
      child.webContents.emit(event, { preventDefault: () => { prevented = true; } }, origin + "/?s=xyz");
      ok(prevented, "预览不能通过 " + event + " 变成第二个工作台");
    }
    let prevented = false;
    child.webContents.emit("will-navigate", { preventDefault: () => { prevented = true; } }, origin + "/api/files/view/other.html");
    ok(!prevented, "预览里的文件链接保持可用");
    child.openHandler({ url: origin + "/?s=xyz" });
    eq(calls.children.length, 1, "预览弹出的任务链接仍复用主窗口");
    open({ url: "https://example.com/" });
    eq(calls.external[0], "https://example.com/", "外部网站交给系统浏览器");
    open({ url: "file:///private.txt" });
    eq(calls.external.length, 1, "文件协议没有交给外部程序");
  });

  await section("【1】默认菜单：Windows 上拿掉，按键由主进程接", () => {
    const fakeMenu = () => { const calls = []; return { calls, setApplicationMenu: (m) => calls.push(m) }; };
    const w = fakeMenu();
    ok(M.dropDefaultMenu(w, "win32") === true && w.calls.length === 1 && w.calls[0] === null, "Windows：setApplicationMenu(null)，按 Alt 不再冒出英文菜单", w.calls);
    const d = fakeMenu(), l = fakeMenu();
    ok(M.dropDefaultMenu(d, "darwin") === false && d.calls.length === 0, "★反向对照★ mac：菜单原样（⌘C / ⌘V 就挂在 Edit 菜单上）", d.calls);
    ok(M.dropDefaultMenu(l, "linux") === false && l.calls.length === 0, "★反向对照★ Linux：也原样", l.calls);
    const iDrop = EM.indexOf("dropDefaultMenu(Menu, process.platform)");
    const iReady = EM.indexOf("app.whenReady().then(async () => {");
    const iWin = EM.indexOf("win = new BrowserWindow({");
    ok(iReady > 0 && iDrop > iReady && iDrop < iWin, "启动时真调了它，而且在建主窗口之前", { iReady, iDrop, iWin });

    const K = (o) => ({ type: "keyDown", key: "", code: "", control: false, shift: false, alt: false, meta: false, ...o });
    const act = (o, platform = "win32", packaged = false) => M.shellKeyAction(K(o), platform, packaged);
    eq(act({ key: "F12", code: "F12" }), "devtools", "开发态 F12：开关开发者工具");
    eq(act({ key: "I", code: "KeyI", control: true, shift: true }), "devtools", "开发态 Ctrl+Shift+I：同上");
    eq(act({ key: "F12", code: "F12" }, "win32", true), null, "★反向对照★ 装机包里 F12 不开开发者工具");
    eq(act({ key: "I", code: "KeyI", control: true, shift: true }, "win32", true), null, "★反向对照★ 装机包里 Ctrl+Shift+I 也不开");
    eq(act({ key: "=", code: "Equal", control: true }), "zoomIn", "Ctrl+=：放大");
    eq(act({ key: "+", code: "Equal", control: true, shift: true }), "zoomIn", "Ctrl+Shift+=（也就是 Ctrl++）：放大");
    eq(act({ key: "+", code: "NumpadAdd", control: true }), "zoomIn", "小键盘 Ctrl++：放大");
    eq(act({ key: "-", code: "Minus", control: true }), "zoomOut", "Ctrl+-：缩小");
    eq(act({ key: "-", code: "NumpadSubtract", control: true }), "zoomOut", "小键盘 Ctrl+-：缩小");
    eq(act({ key: "0", code: "Digit0", control: true }), "zoomReset", "Ctrl+0：回原样");
    eq(act({ key: "0", code: "Numpad0", control: true }), "zoomReset", "小键盘 Ctrl+0：回原样");
    eq(act({ key: "0", code: "Digit0", control: true, shift: true }), null, "Ctrl+Shift+0 不算回原样（留给页面）");
    eq(act({ key: "}", code: "Digit0", control: true, alt: true }), null, "AltGr+0（报出来是 Ctrl+Alt）打的是 }，不能被当成回原样吃掉");
    eq(act({ key: "=", code: "Equal", control: true, alt: true }), null, "AltGr 组合一律不碰");
    eq(act({ key: "=", code: "Equal", meta: true }), null, "Win 键组合不碰");
    eq(act({ key: "=", code: "Equal" }), null, "不按 Ctrl 的 = 是打字，不碰");
    eq(act({ key: "=", code: "Equal", control: true, type: "keyUp" }), null, "抬键不算（一按只放大一次）");
    const clip = ["c", "v", "x", "a", "z", "y"].map((k) => act({ key: k, code: "Key" + k.toUpperCase(), control: true }));
    ok(clip.every((x) => x === null), "Ctrl+C/V/X/A/Z/Y 一个都不接：网页内核自己认，不靠菜单", clip);
    const off = ["darwin", "linux"].flatMap((p) => [act({ key: "F12", code: "F12" }, p), act({ key: "=", code: "Equal", control: true }, p), act({ key: "0", code: "Digit0", control: true }, p)]);
    ok(off.every((x) => x === null), "★反向对照★ mac / Linux：一个都不接（菜单还在，按键照旧归它）", off);

    const fakeWc = () => {
      const wc = new EventEmitter();
      Object.assign(wc, { zoom: 0, dev: 0, toggleDevTools() { wc.dev++; }, getZoomLevel: () => wc.zoom, setZoomLevel(z) { wc.zoom = z; } });
      return wc;
    };
    const press = (wc, o) => { let prevented = 0; wc.emit("before-input-event", { preventDefault: () => prevented++ }, K(o)); return prevented; };
    const wc = fakeWc();
    ok(M.attachShellKeys(wc, "win32", false) === true && wc.listenerCount("before-input-event") === 1, "Windows：挂上了 before-input-event");
    const p1 = press(wc, { key: "=", code: "Equal", control: true });
    press(wc, { key: "=", code: "Equal", control: true });
    ok(p1 === 1 && wc.zoom === 1, "按两下 Ctrl+=：放大两个半档，按键不再往页面里送", { p1, zoom: wc.zoom });
    press(wc, { key: "-", code: "Minus", control: true });
    eq(wc.zoom, 0.5, "Ctrl+-：缩回半档");
    press(wc, { key: "0", code: "Digit0", control: true });
    eq(wc.zoom, 0, "Ctrl+0：回原样");
    press(wc, { key: "F12", code: "F12" });
    eq(wc.dev, 1, "F12：开关一次开发者工具");
    eq(press(wc, { key: "c", code: "KeyC", control: true }), 0, "Ctrl+C 照常送进页面（没被拦）");
    const shipped = fakeWc();
    M.attachShellKeys(shipped, "win32", true);
    press(shipped, { key: "F12", code: "F12" });
    eq(shipped.dev, 0, "★反向对照★ 装机包：F12 按了也不开");
    const mac = fakeWc();
    ok(M.attachShellKeys(mac, "darwin", false) === false && mac.listenerCount("before-input-event") === 0, "★反向对照★ mac：根本不挂");
    ok(/attachShellKeys\(win\.webContents, process\.platform, app\.isPackaged\)/.test(EM) && /attachShellKeys\(child\.webContents, process\.platform, app\.isPackaged\)/.test(EM),
      "主窗口、站内子窗口都挂上了，开发态按 app.isPackaged 判");
    // 应用自己的快捷键是页面里的 keydown（SHORTCUT_DEFS），不是菜单加速键：菜单拿掉它们不受影响
    const APP02 = read("public", "js", "app-02.js");
    ok(/const SHORTCUT_DEFS = \[/.test(APP02) && /"F11"|\|F11"/.test(APP02) && !/accelerator:/.test(EM.replace(/\/\/.*$/gm, "")),
      "应用快捷键（含 Windows 的 F11 全屏）在页面里，主进程没有挂在菜单上的加速键");
  });

  await section("【2】托盘：Windows 用多尺寸 .ico", () => {
    const icoPath = path.join(ROOT, "public", "tray.ico");
    ok(fs.existsSync(icoPath), "public/tray.ico 在");
    const b = fs.readFileSync(icoPath);
    const n = b.readUInt16LE(4);
    ok(b.readUInt16LE(0) === 0 && b.readUInt16LE(2) === 1 && n > 0, "是 ICO 文件（文件头 0 / 1）", { type: b.readUInt16LE(2), n });
    const frames = [];
    for (let i = 0; i < n; i++) {
      const o = 6 + i * 16;
      const w = b[o] || 256, h = b[o + 1] || 256, bpp = b.readUInt16LE(o + 6), size = b.readUInt32LE(o + 8), off = b.readUInt32LE(o + 12);
      const inside = off + size <= b.length && size > 0;
      const png = inside && b.subarray(off, off + 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      // BMP 帧：BITMAPINFOHEADER 里的高是两倍（图 + 透明遮罩），宽要跟目录项对得上
      const bmpOk = inside && !png && b.readUInt32LE(off) === 40 && b.readInt32LE(off + 4) === w && b.readInt32LE(off + 8) === h * 2;
      frames.push({ w, h, bpp, inside, ok: png || bmpOk });
    }
    const sizes = frames.map((f) => f.w);
    // Windows 托盘按 SM_CXSMICON 取图：100% 16、125% 20、150% 24、200% 32、250% 40、300% 48
    const need = [16, 20, 24, 32, 40, 48];
    ok(need.every((s) => sizes.includes(s)), "100%–300% 缩放要的 16/20/24/32/40/48 每档都有一帧（125%、150% 不再拿 32 现缩）", sizes);
    ok(frames.every((f) => f.w === f.h && f.bpp === 32 && f.inside && f.ok), "每一帧都是方的、32 位带透明、数据在文件里、帧头对得上", frames);
    ok(b.length < 200 * 1024, "文件不大（装机包里多它一个不显眼）", b.length);

    ok(M.trayIconFile("/app", "win32") === path.join("/app", "public", "tray.ico"), "Windows：托盘用 public/tray.ico");
    ok(M.trayIconFile("/app", "darwin") === path.join("/app", "public", "favicon.png") && M.trayIconFile("/app", "linux") === path.join("/app", "public", "favicon.png"),
      "★反向对照★ mac / Linux：照旧 favicon.png");
    const tray = EM.slice(EM.indexOf("function createTray()"), EM.indexOf("\n}\n", EM.indexOf("function createTray()")));
    ok(/process\.platform === "win32"[\s\S]{0,200}createFromPath\(trayIconFile\(__dirname, process\.platform\)\)/.test(tray), "createTray 在 Windows 上真用了它");
    ok(/isEmpty\(\)[\s\S]{0,200}bootLog\("▲ 托盘的 \.ico 读不出来，先用 PNG/.test(tray) && /scaleFactor: 2/.test(tray), "读不出来：退回原来那两份 PNG，日志里留一句");

    // 打包：public/** 整个进包，排除规则里没有能把它刷掉的；完整性闸门只查「少了什么」，多一个文件不会红
    const cfg = read("electron-builder.config.js");
    const files = cfg.slice(cfg.indexOf("files: ["), cfg.indexOf("],", cfg.indexOf("files: [")));
    const excl = [...files.matchAll(/"(![^"]+)"/g)].map((m) => m[1]).concat(require(path.join(ROOT, "scripts", "slim-deps")).excludePatterns());
    ok(/"public\/\*\*\/\*"/.test(files) && !excl.some((p) => /public|\.ico|tray/.test(p)), "打包白名单里有 public/**/*，没有哪条排除规则碰得到 tray.ico", excl.filter((p) => !/^!node_modules\//.test(p)));
    const gate = read("scripts", "check-package-files.js");
    ok(/function assertPackComplete\(appDir\) \{\s*const missing = missingFrom\(appDir\);/.test(gate), "完整性闸门只拿「缺了哪些」判红（多出来的文件不算错）");
  });

  await section("【3】窗口底色跟主题（Windows）", async () => {
    const css = read("public", "css", "ui.css");
    const rootBlock = css.slice(css.indexOf(":root {"), css.indexOf("\n}", css.indexOf(":root {")));
    const darkAt = css.indexOf('html[data-theme="dark"] {\n  --background');
    const darkBlock = css.slice(darkAt, css.indexOf("\n}", darkAt));
    const cssLight = (/--background:\s*(#[0-9a-f]{6})/i.exec(rootBlock) || [])[1];
    const cssDark = (/--background:\s*(#[0-9a-f]{6})/i.exec(darkBlock) || [])[1];
    ok(cssLight && cssDark, "ui.css 里切得到浅色、深色两份 --background", { cssLight, cssDark });
    eq(M.themeBg("dark", false, "win32"), cssDark, "选了深色：底色就是深色那份 --background（系统是浅的也一样）");
    eq(M.themeBg("light", true, "win32"), cssLight, "选了浅色：白底（系统是深的也一样）");
    eq(M.themeBg("system", true, "win32"), cssDark, "跟随系统 + 系统深色：深底");
    eq(M.themeBg("system", false, "win32"), cssLight, "跟随系统 + 系统浅色：白底");
    eq(M.themeBg("", true, "win32"), cssDark, "还没问到设置（刚启动）：先按系统");
    eq(M.themeBg("乱写的", true, "win32"), cssDark, "读到不认识的值：当跟随系统");
    ok(["darwin", "linux"].every((p) => M.themeBg("dark", true, p) === "#ffffff"), "★反向对照★ mac / Linux：还是原来的白底，一点不动");
    // themeSource 一改，所有渲染进程的 prefers-color-scheme 跟着翻，网页截图、网页转视频这些隐藏窗口出的图也会变
    const emCode = EM.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const srcSet = emCode.match(/\.themeSource\s*=(?!=)|\[\s*["'`]themeSource["'`]\s*\]\s*=(?!=)|\bthemeSource\s*:/g) || [];
    ok(srcSet.length === 0, "electron-main.js 从不改 nativeTheme.themeSource（出图窗口不跟着应用主题翻深浅）", srcSet);

    /** 假 nativeTheme：themeSource 定了深浅就照它，system 时看「系统」；sets 记被改过几次（应该一直是 0） */
    const fakeNT = (osDark) => {
      const nt = new EventEmitter();
      nt.os = osDark; nt.sets = 0;
      let src = "system";
      Object.defineProperty(nt, "themeSource", { get: () => src, set: (v) => { src = v; nt.sets++; nt.emit("updated"); } });
      Object.defineProperty(nt, "shouldUseDarkColors", { get: () => (src === "system" ? nt.os : src === "dark") });
      return nt;
    };
    const fakeWin = () => {
      const w = new EventEmitter();
      w.bg = null; w.dead = false;
      w.setBackgroundColor = (c) => { w.bg = c; };
      w.isDestroyed = () => w.dead;
      w.webContents = new EventEmitter();
      w.webContents.store = "";
      w.webContents.js = 0;
      w.webContents.fail = false;
      w.webContents.isDestroyed = () => false;
      w.webContents.executeJavaScript = async (code, gesture) => {
        w.webContents.js++;
        w.webContents.gesture = gesture;
        if (w.webContents.fail) throw new Error("页面没了");
        if (!/localStorage\.getItem\("owb-theme"\)/.test(code)) return "（问错了键）";
        return w.webContents.store;
      };
      return w;
    };

    const nt = fakeNT(false);
    const a = fakeWin(), c = fakeWin(), gone = fakeWin();
    gone.dead = true;
    const bg = M.applyShellTheme("dark", nt, new Set([a, c, gone]), "win32");
    ok(bg === cssDark && a.bg === cssDark && c.bg === cssDark && gone.bg === null,
      "落主题：设置是深色、系统是浅的 → 开着的窗口底色全换深，关掉的不碰", { bg, a: a.bg, c: c.bg });
    ok(nt.sets === 0 && nt.themeSource === "system", "落主题时 themeSource 原样没动（还是 system）", { sets: nt.sets, src: nt.themeSource });
    const nt2 = fakeNT(true), m = fakeWin();
    ok(M.applyShellTheme("dark", nt2, new Set([m]), "darwin") === null && m.bg === null && nt2.sets === 0, "★反向对照★ mac：不碰窗口、不碰 nativeTheme");

    // 盯着变化：页面加载完、点完 / 按完（停手再问）、切回窗口、系统换深浅
    const ntW = fakeNT(false);
    const state = { theme: "", wins: new Set() };
    const w = fakeWin(), child = fakeWin();
    state.wins.add(w); state.wins.add(child);
    const sync = M.watchShellTheme(w, ntW, state, "win32", 20);
    ok(typeof sync === "function", "Windows：挂上了");
    w.webContents.store = "dark";
    w.webContents.emit("did-finish-load");
    await tick(5);
    ok(state.theme === "dark" && w.bg === cssDark && child.bg === cssDark, "页面加载完问一次：设置是深色 → 主窗口和子窗口都换深底", { theme: state.theme, w: w.bg, child: child.bg });
    w.webContents.store = "light";
    const js0 = w.webContents.js;
    for (const t of ["mouseMove", "mouseWheel", "mouseDown", "keyDown", "char"]) w.webContents.emit("input-event", {}, { type: t });
    await tick(40);
    eq(w.webContents.js, js0, "挪鼠标、滚轮、按下没抬起：不问（一秒几十次的事件不跟着问）");
    for (const t of ["mouseUp", "mouseUp", "keyUp"]) w.webContents.emit("input-event", {}, { type: t });
    await tick(5);
    eq(w.webContents.js, js0, "点完先等一会儿再问（连点三下不问三遍）");
    await tick(40);
    ok(w.webContents.js === js0 + 1 && state.theme === "light" && w.bg === cssLight, "停手以后问一次：在设置里点了浅色 → 白底", { js: w.webContents.js - js0, theme: state.theme, bg: w.bg });
    w.webContents.store = "system";
    ntW.os = true;
    w.emit("focus");
    await tick(5);
    ok(state.theme === "system" && w.bg === cssDark, "切回窗口问一次：改成跟随系统、系统是深的 → 深底", { theme: state.theme, bg: w.bg });
    const js1 = w.webContents.js;
    ntW.os = false;
    ntW.emit("updated");
    ok(w.bg === cssLight && child.bg === cssLight && w.webContents.js === js1, "系统自己换成浅色（nativeTheme updated）：底色跟着换，不用再去问页面", { w: w.bg, js: w.webContents.js - js1 });
    w.webContents.fail = true;
    w.emit("focus");
    await tick(5);
    eq(state.theme, "system", "页面答不上来（卡住、没了）：沿用上次问到的，不乱改");
    w.webContents.fail = false;
    w.webContents.store = "（乱写的）";
    await sync();
    eq(state.theme, "", "存的值不认识：当没选（跟随系统）");
    state.wins.delete(child);
    w.webContents.store = "dark";
    child.bg = "没再碰";
    await sync();
    eq(child.bg, "没再碰", "关掉的子窗口从名单里拿掉后不再碰它");
    eq(ntW.sets, 0, "盯了一整圈（加载、点击、切回、系统换深浅）：themeSource 一次都没改");
    eq(w.webContents.gesture, false, "问主题只读 localStorage，不冒充用户手势（executeJavaScript 第二个参数是 false）");

    const ntM = fakeNT(false), wm = fakeWin();
    ok(M.watchShellTheme(wm, ntM, { theme: "", wins: new Set([wm]) }, "darwin") === null && wm.listenerCount("focus") === 0
      && wm.webContents.listenerCount("did-finish-load") === 0 && ntM.listenerCount("updated") === 0, "★反向对照★ mac：一个监听都不挂");

    // 前端那边主题确实存在 owb-theme 里（键改了名这里就该红，不然主进程永远问不到）
    const APP02 = read("public", "js", "app-02.js");
    ok(/lookRead\("owb-theme"\)/.test(APP02) && /lookWrite\("owb-theme", t\)/.test(APP02), "设置页的主题就存在 localStorage 的 owb-theme 里");
    // 接线
    ok(!/backgroundColor:\s*"#ffffff"/.test(EM), "electron-main.js 里不再有写死白底的窗口", (EM.match(/backgroundColor:\s*"#ffffff"/g) || []).length);
    ok((EM.match(/backgroundColor: themeBg\(SHELL_THEME\.theme, nativeTheme\.shouldUseDarkColors, process\.platform\)/g) || []).length === 2, "主窗口和站内子窗口的底色都按 themeBg 给");
    ok(/watchShellTheme\(win, nativeTheme, SHELL_THEME, process\.platform\)/.test(EM) && /SHELL_THEME\.wins\.add\(child\)/.test(EM) && /SHELL_THEME\.wins\.delete\(child\)/.test(EM),
      "主窗口盯着主题变化，子窗口开的时候进名单、关了出名单");
  });

  await section("【4】不许被顺手改掉的两行", () => {
    ok(/setAppUserModelId\(app\.isPackaged \? "([^"]+)"/.test(EM), "Windows 的 AppUserModelId 还在（任务栏分组、通知署名靠它）");
    ok(/appendSwitch\("disk-cache-dir", path\.join\(process\.env\.LOCALAPPDATA/.test(EM), "Windows 网页缓存挪到 LOCALAPPDATA 的那行还在");
  });

  await section("Windows 安装版更新：支持范围、显式下载、并发与失败状态", async () => {
    const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "owb-update-test-"));
    const { createAutoUpdate } = require("../src/desktop/auto-update");
    try {
      fs.writeFileSync(path.join(dir, "app-update.yml"), "provider: github\n");
      let checks = 0, downloads = 0, installed = 0, loaded = 0, release;
      const u = new EventEmitter();
      u.checkForUpdates = async () => { checks++; u.emit("checking-for-update"); await new Promise(r => { release = r; }); u.emit("update-available", { version: "0.16.4" }); };
      u.downloadUpdate = async () => { downloads++; };
      u.quitAndInstall = () => { installed++; };
      const base = { app: { isPackaged: true }, platform: "win32", env: {}, resourcesPath: dir, loadUpdater: () => { loaded++; return u; } };
      for (const [change, why] of [[{ platform: "darwin" }, "not-win"], [{ platform: "linux" }, "not-win"], [{ app: { isPackaged: false } }, "source"], [{ env: { PORTABLE_EXECUTABLE_FILE: "fixture.exe" } }, "portable"], [{ resourcesPath: "" }, "no-feed"]]) {
        const a = createAutoUpdate({ ...base, ...change });
        eq((await a.download()).why, why, `${why} 不下载更新`);
        eq(a.install().ok, false, `${why} 不能安装`);
      }
      eq(loaded, 0, "不支持的平台不会加载更新器");
      const a = createAutoUpdate(base);
      eq(a.install().ok, false, "未下载不能安装");
      const checking = a.check(), again = a.check();
      eq(checks, 1, "同时检查只发起一次请求");
      eq(downloads, 0, "检查更新不会偷偷下载");
      release(); await Promise.all([checking, again]);
      eq(a.state().phase, "available", "查到更新再提供下载");
      eq(u.autoDownload, false, "自动下载明确关闭");
      eq(u.allowDowngrade, false, "不自动降级");
      await Promise.all([a.download(), a.download()]);
      eq(downloads, 1, "连点下载只启动一份");
      u.emit("download-progress", { percent: 52.4, transferred: 52, total: 100 });
      eq(a.state().percent, 52, "下载进度来自更新器");
      u.emit("error", new Error("network unavailable\nprivate detail"));
      eq(a.state().error, "network unavailable", "失败如实显示首行错误");
      eq(a.install().ok, false, "失败不进入安装");
      u.emit("update-downloaded", { version: "0.16.4" });
      eq(a.state().percent, 100, "下载完成显示百分之百");
      eq(a.install().ok, true, "下载完成后可显式重启安装");
      await new Promise(r => setTimeout(r, 350));
      eq(installed, 1, "只调用一次安装器");
      const cfg = require("../electron-builder.config");
      eq(cfg.win.publish[0].provider, "github", "Windows 安装包包含更新源");
      const workflow = read(".github", "workflows", "release.yml");
      ok(workflow.includes("dist/latest*.yml") && workflow.includes("dist/*.blockmap"), "发布同时带上更新元数据和增量索引");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await section("Windows CLI：真实命令解释器与内置运行时", async () => {
    const smoke = read("scripts", "win-smoke.js");
    ok(smoke.includes("windowsVerbatimArguments: true"), "cmd.exe 的批处理引号不被再次转义");
    if (process.platform !== "win32") return;
    const os = require("os"), cp = require("child_process"), assert = require("assert/strict");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-cli live 中文 "));
    try {
      const appDir = path.join(dir, "App space 中文"), cwd = path.join(dir, "project space");
      fs.mkdirSync(appDir); fs.mkdirSync(cwd);
      fs.writeFileSync(path.join(appDir, "cli.js"), "console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));");
      const { installCli } = require("../src/desktop/cli-install");
      const opts = { appDir, executable: require("electron"), home: dir,
        env: { ...process.env, OPENWORKBUDDY_INSTALL_CLI: "1", LOCALAPPDATA: dir }, runCommand: async () => {} };
      const registered = await installCli(opts);
      assert.equal(registered.ok, true);
      const call = args => cp.spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `call "${registered.file}" ${args}`], {
        cwd, env: { ...process.env, OPENWORKBUDDY_HOME: dir }, windowsHide: true, windowsVerbatimArguments: true, encoding: "utf8", timeout: 30000,
      });
      const probe = call('"hello world" "中文"');
      assert.equal(probe.status, 0, probe.stderr);
      const result = JSON.parse(probe.stdout);
      assert.equal(fs.realpathSync(result.cwd), fs.realpathSync(cwd));
      assert.deepEqual(result.args, ["hello world", "中文"]);
      ok(true, "中文和空格路径、参数、启动目录都经过真实 cmd.exe 验证");
      await installCli({ ...opts, appDir: ROOT });
      const version = call("--version");
      assert.equal(version.status, 0, version.stderr);
      assert.equal(version.stdout.trim(), "OpenWorkBuddy " + require("../package.json").version);
      ok(true, "Windows 内置 Electron 真正运行 CLI，无需系统 Node.js");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  finished = true;
  console.log(`\n${fail ? "✗" : "✓"} Windows 主进程：${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})();
