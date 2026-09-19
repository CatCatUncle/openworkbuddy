#!/usr/bin/env node
/**
 * 给闪卡网页拍效果图：真浏览器打开 127.0.0.1:4173，等 three 渲染完，
 * 拖到指定角度再截。要几张角度就传几个角度。
 */
const path = require("path");
const fs = require("fs");
const { app, BrowserWindow } = require("electron");

if (process.platform === "darwin" && app.dock && app.dock.hide) app.dock.hide();

const CWD = process.argv[2] || process.cwd();
const OUT = path.join(CWD, "card-shots");
const URL_BASE = "http://127.0.0.1:4173/";

// 直接改 root.rotation 会被渲染循环每帧覆写（实测 set=ok 但值不变）。
// 唯一真能改角度的是键盘事件——它改的是内部状态变量。所以用 keydown 连发。
const SHOTS = [
  { name: "01-正面",      keys: [], wait: 2600 },
  { name: "02-左转到底",  keys: Array(14).fill("ArrowLeft"),  wait: 1500 },
  { name: "03-右转到底",  keys: Array(20).fill("ArrowRight"), wait: 1500 },
  { name: "04-俯视",      keys: ["f", ...Array(10).fill("ArrowDown")], wait: 1800 },
  { name: "05-翻面",      keys: ["f"], wait: 2000 },
];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const keyScript = (key) => `(() => {
  const t = document.querySelector('#stage') || document.body;
  const o = { key: '${key}', code: '${key}', which: 0, bubbles: true, cancelable: true };
  t.dispatchEvent(new KeyboardEvent('keydown', o));
  t.dispatchEvent(new KeyboardEvent('keyup', o));
  return true;
})()`;

const stateScript = `(() => {
  const h = window.__holo;
  if (!h || !h.ready) return { ready: false };
  const r = h.root.rotation;
  return { rotY: +r.y.toFixed(4), rotX: +r.x.toFixed(4),
           label: (document.getElementById('view-label')||{}).textContent };
})()`;

async function shoot() {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({
    show: false, width: 1280, height: 900, backgroundColor: "#ffffff",
    webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: false },
  });

  await win.loadURL(URL_BASE);
  await sleep(3600);

  const init = await win.webContents.executeJavaScript(`(() => {
    const l = document.getElementById('loading');
    return { loadingGone: !l || !document.body.contains(l),
             holoReady: !!(window.__holo && window.__holo.ready),
             hasRoot: !!(window.__holo && window.__holo.root) };
  })()`).catch((e) => ({ error: String(e) }));
  console.log("初始化:", JSON.stringify(init));

  for (const s of SHOTS) {
    await win.webContents.executeJavaScript(keyScript("r"));
    await sleep(700);
    // 逐个派发、留出时间给内部状态累积
    for (const k of s.keys) {
      await win.webContents.executeJavaScript(keyScript(k));
      await sleep(55);
    }
    await sleep(s.wait);

    const st = await win.webContents.executeJavaScript(stateScript).catch(() => ({}));
    const img = await win.webContents.capturePage();
    const png = img.toPNG();
    fs.writeFileSync(path.join(OUT, s.name + ".png"), png);
    console.log(`✅ ${s.name}.png  rotY=${st.rotY} rotX=${st.rotX}  label=${st.label}  ${(png.length/1024).toFixed(0)}KB`);
  }
  win.destroy();
}

app.whenReady().then(async () => {
  try { await shoot(); app.exit(0); }
  catch (e) { console.error("❌", e && e.message ? e.message : e); app.exit(1); }
});
