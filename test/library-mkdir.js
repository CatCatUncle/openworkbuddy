"use strict";
/**
 * 资料库「新建文件夹」——按钮点下去必须真有反应。
 *
 * 跑法：npx electron test/library-mkdir.js
 *
 * 用户报的原话：「资料库里面的目录的新建，好像还是不能用哦」。
 * 查出来的根因不在服务端，也不在网络：那颗按钮的处理函数第一行是 window.prompt，
 * 而桌面版跑在 Electron 里，那儿的 prompt **存在、但一调用就抛**
 * （"prompt() is not supported."）。typeof window.prompt 依然是 "function"，
 * 所以任何「先判断有没有」的写法都挡不住；异常当场把 onclick 打断，
 * 后面的 fetch 一行都没跑到。从用户那一侧看，就是点了毫无动静、连个错都没有。
 *
 * 所以这套断言分两头钉：
 *   正面 —— 点一下有对话框、填完真发得出去、取消真的什么都不做；
 *   反面 —— prompt 在这个环境里确实一调用就抛（证明老代码是死的，不是我瞎猜），
 *           confirm 却好好的（证明不该顺手把全站确认框也改了），
 *           而且 public/js 里再不许出现第二个 prompt( 调用。
 *
 * 跟 test/preview-layout.js 一样开真 Chromium、喂真 public/ ——
 * 这个毛病只在真 Electron 里犯，拿假 DOM 测等于没测。
 */

// 被 node 直接拉起来时（npm test 就是这么拉的）自己换成 electron 再跑一遍；
// 没装 electron 就跳过不算失败——纯服务端部署本来就没有界面这一层。
if (!process.versions.electron) {
  const fs0 = require("fs");
  let bin = null;
  try { bin = require("electron"); } catch {}
  if (typeof bin !== "string" || !fs0.existsSync(bin)) {
    console.log("跳过：没装 electron，这个毛病只在真 Electron 里犯（纯服务端部署没有界面）");
    process.exit(0);
  }
  const r = require("child_process").spawnSync(bin, [__filename], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
    timeout: 300000, killSignal: "SIGKILL",
  });
  process.exit(r.status == null ? 1 : r.status);
}

const fs = require("fs");
const path = require("path");
const http = require("http");
const { app, BrowserWindow } = require("electron");

// 离屏窗口人眼看不见，但 macOS 照样往程序坞塞一个跳动的图标，跑一次测试抢一次注意力
if (process.platform === "darwin" && app.dock && app.dock.hide) app.dock.hide();

const ROOT = path.join(__dirname, "..");
const PUB = path.join(ROOT, "public");

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; console.log("  ❌ " + msg + (detail === undefined ? "" : "：" + JSON.stringify(detail))); }
};

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".json": "application/json; charset=utf-8",
};
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const rel = decodeURIComponent(String(req.url || "/").split("?")[0]);
      const file = path.join(PUB, path.normalize(rel).replace(/^([/\\.]+)/, ""));
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end("nope"); }
      const buf = fs.readFileSync(file);
      res.setHeader("Content-Type", MIME[path.extname(file).toLowerCase()] || "application/octet-stream");
      res.setHeader("Content-Length", buf.length);
      res.end(buf);
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

// 资料库那一页要四趟接口才画得出来。这里判的是「按钮点下去有没有反应」，
// 不是列表画得对不对，所以给最省的一份替身：一个空资料库 + 一个平台管理员。
// 建文件夹那一趟照真实形状回话，包括「同名已存在」这条错路。
const STUB = `
(() => {
  window.__posts = [];
  settingsCache = { platform_owner: true, workspace_dir: "/tmp/ws" };
  const J = (d, okk) => Promise.resolve({ ok: okk !== false, status: okk === false ? 400 : 200, json: async () => d });
  const real = window.fetch;
  window.fetch = function (u, o) {
    const s = String(u), m = ((o && o.method) || "GET").toUpperCase();
    if (s.includes("/api/library/folder") && m === "POST") {
      const b = JSON.parse(o.body);
      window.__posts.push(b);
      if (b.name === "老地方") return J({ error: "同名文件夹已存在" }, false);
      return J({ ok: true, dir: b.name });
    }
    if (s.includes("/api/library/outputs")) return J({ tasks: [] });
    if (s.includes("/api/library/search")) return J({ items: [] });
    if (s.includes("/api/library")) return J({ dir: window.__dir || "", files: [], folders: [], notes: [] });
    if (s.includes("/api/settings")) return J(settingsCache);
    if (s.includes("/api/files")) return J([]);
    return real.apply(this, arguments);
  };
})()
`;

/** 把资料库那一页画出来，停在「文件夹」这一栏的根目录 */
const OPENPAGE = (dir) => `
(async () => {
  window.__dir = ${JSON.stringify(dir || "")};
  window.__posts = [];
  chatCol.innerHTML = '<div class="assist-page" id="assist-page"></div>';
  libState.view = "dir"; libState.q = ""; libState.dir = ${JSON.stringify(dir || "")}; libState.pick = null;
  await renderLibPage();
  const b = document.getElementById("lb-mkdir");
  return { found: !!b, label: b ? b.textContent.trim() : "" };
})()
`;

/** 点「新建」，回报对话框有没有出来、摆在哪、焦点在谁身上 */
const CLICK = `
(async () => {
  const btn = document.getElementById("lb-mkdir");
  // 真鼠标按下去会先把焦点给到这个链接本身，脚本 .click() 不会 —— 这儿补上，
  // 否则测的是一种现实里不存在的点法（焦点停在 body 上），
  // 「关掉之后焦点还回原处」那条断言也就成了空的
  btn.focus();
  btn.click();
  await new Promise((r) => setTimeout(r, 80));
  const m = document.querySelector(".ask-mask");
  if (!m) return { up: false, masks: document.querySelectorAll(".ask-mask").length };
  const box = m.querySelector(".ask-box").getBoundingClientRect();
  const mm = document.querySelector(".modal-mask");
  const zi = (el) => Number(getComputedStyle(el).zIndex) || 0;
  return {
    up: true,
    masks: document.querySelectorAll(".ask-mask").length,
    focusIn: document.activeElement === m.querySelector(".ask-in"),
    title: m.querySelector(".ask-t").textContent,
    hint: (m.querySelector(".ask-h") || {}).textContent || "",
    okLabel: m.querySelector(".ask-ok").textContent,
    okOff: m.querySelector(".ask-ok").disabled,
    z: zi(m), zModal: mm ? zi(mm) : -1,
    gapTop: Math.round(box.top), gapBot: Math.round(innerHeight - box.bottom),
    gapLeft: Math.round(box.left), gapRight: Math.round(innerWidth - box.right),
  };
})()
`;

/** 在对话框里打字，回报「确定」能不能点、有没有话说 */
const TYPE = (text) => `
(() => {
  const m = document.querySelector(".ask-mask");
  // 对话框没出来时别抛。抛了的话整套断言在这一步断掉，看到的只有一句「测试自己崩了」——
  // 后面三十来条到底还成不成立全看不见，反向验证也就没了证据。给个说得清的哨兵，各红各的
  if (!m) return { missing: true, okOff: null, err: "对话框根本没出来" };
  const i = m.querySelector(".ask-in");
  i.value = ${JSON.stringify(text)};
  i.dispatchEvent(new Event("input", { bubbles: true }));
  const e = m.querySelector(".ask-err");
  return { okOff: m.querySelector(".ask-ok").disabled, err: e.hidden ? "" : e.textContent };
})()
`;

/** 按一个键（capture 挂在 document 上，所以往 document 上发） */
const KEY = (key, extra) => `
(async () => {
  document.dispatchEvent(new KeyboardEvent("keydown", Object.assign(
    { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }, ${JSON.stringify(extra || {})})));
  await new Promise((r) => setTimeout(r, 120));
  return {
    up: !!document.querySelector(".ask-mask"),
    posts: window.__posts.slice(),
    focus: document.activeElement ? (document.activeElement.id || document.activeElement.className || document.activeElement.tagName) : "",
  };
})()
`;

/** 动手之前先钉住现状。下面「取消」那一组全是「没发生什么」形状的断言，
 *  最容易假绿——对话框根本没打开时，「关掉了」「没发出去」「焦点回来了」统统自动成立。
 *  所以每条都先要这份现状垫底：它刚才确实开着、里头确实有字、焦点确实在输入框里。 */
const STATE = `
(() => {
  const m = document.querySelector(".ask-mask");
  if (!m) return { up: false, focusIn: false, typed: "" };
  const i = m.querySelector(".ask-in");
  return { up: true, focusIn: document.activeElement === i, typed: i.value };
})()
`;

const AFTER = `
(async () => {
  await new Promise((r) => setTimeout(r, 120));
  const t = document.getElementById("owb-toast");
  return {
    up: !!document.querySelector(".ask-mask"),
    posts: window.__posts.slice(),
    toast: t && t.classList.contains("show") ? t.textContent.trim() : "",
    focus: document.activeElement ? (document.activeElement.id || document.activeElement.className || document.activeElement.tagName) : "",
  };
})()
`;

app.whenReady().then(async () => {
  const srv = await serve();
  const win = new BrowserWindow({
    show: false, width: 1440, height: 900, backgroundColor: "#ffffff",
    webPreferences: { contextIsolation: false, nodeIntegration: false },
  });
  await win.loadURL(`http://127.0.0.1:${srv.address().port}/index.html`);
  await new Promise((r) => setTimeout(r, 900));
  await win.webContents.executeJavaScript(STUB);
  const run = (code) => win.webContents.executeJavaScript(code);

  console.log("\n— 为什么非得自己画一个对话框 —");
  {
    const r = await run(`
      (() => {
        const out = { type: typeof window.prompt };
        try { window.prompt("x"); out.threw = false; }
        catch (e) { out.threw = true; out.msg = String((e && e.message) || e); }
        try { out.confirmOk = typeof window.confirm === "function"; } catch { out.confirmOk = false; }
        return out;
      })()
    `);
    ok(r.type === "function", "先验料：window.prompt 在这儿是个函数（所以「判断有没有」的写法挡不住）", r.type);
    ok(r.threw === true, "★它一调用就抛，整个 onclick 当场断掉——老代码就是死在这儿★", r.msg);
    ok(r.confirmOk, "反向对照：confirm 好好的，全站那些确认框不用跟着改", r.confirmOk);
  }
  {
    const files = fs.readdirSync(path.join(PUB, "js")).filter((f) => f.endsWith(".js"));
    const left = [];
    for (const f of files) {
      const src = fs.readFileSync(path.join(PUB, "js", f), "utf8");
      // 只看真正的调用：askText、注释里提它的名字、以及 window.prompt 这个属性名都不算
      for (const line of src.split("\n")) {
        const t = line.trim();
        if (t.startsWith("*") || t.startsWith("//")) continue;
        if (/(^|[^.\w])prompt\s*\(/.test(line)) left.push(f + "：" + t.slice(0, 60));
      }
    }
    ok(left.length === 0, "public/js 里再没有第二处 prompt( 调用（防的是哪天顺手又写回去）", left);
  }

  console.log("\n— 点一下「新建」，要真有反应 —");
  {
    const p = await run(OPENPAGE(""));
    ok(p.found, "先验料：平台管理员身份下，「新建」这颗按钮确实在页面上", p);
    const r = await run(CLICK);
    ok(r.up === true, "★点一下，对话框出来了（用户报的就是这里点了没动静）★", r);
    ok(r.focusIn, "焦点直接落在输入框里，不用再点一下才能打字", r.focusIn);
    ok(r.okOff === true, "名字还没填，「确定」是灰的——点了也不会发生事的按钮不该看着能点", r.okOff);
    ok(r.z > r.zModal, "对话框浮在资料库弹窗之上（资料库本身就开在弹窗里）", `${r.z} > ${r.zModal}`);
    ok(Math.abs(r.gapTop - r.gapBot) <= 12 && Math.abs(r.gapLeft - r.gapRight) <= 12,
      "摆在屏幕正中，不是甩在角上", `上${r.gapTop}下${r.gapBot} 左${r.gapLeft}右${r.gapRight}`);
    ok(/最外面这一层/.test(r.hint), "说清楚建在哪儿（根目录）", r.hint);
  }

  console.log("\n— 名字不合规，当场就说，别让用户白等一个来回 —");
  {
    ok((await run(TYPE("   "))).okOff === true, "只敲了几个空格 → 「确定」还是灰的", null);
    const slash = await run(TYPE("合同/模板"));
    ok(slash.okOff && /斜杠/.test(slash.err), "带斜杠 → 说清楚为什么，并且不让提交", slash);
    const dot = await run(TYPE(".隐藏"));
    ok(dot.okOff && /隐藏/.test(dot.err), "点开头 → 说清楚建出来会看不见", dot);
    const lt = await run(TYPE("方案<v2>"));
    ok(lt.okOff && /Windows/.test(lt.err), "带 < > 这类字符 → 说清楚 Windows 那边打不开", lt);
    const stay = await run(KEY("Enter"));
    ok(stay.up === true && stay.posts.length === 0, "名字不合规时按回车：不提交，对话框也不关", stay);
    const good = await run(TYPE("v1.2 方案（终）"));
    ok(!good.okOff && !good.err, "反向对照：改好之后「确定」又能点了——校验不是一锤子买卖", good);
    const cn = await run(TYPE("合同模板"));
    ok(!cn.okOff && !cn.err, "反向对照：正常的中文名一路放行（不然这些断言全是靠误杀换来的）", cn);
  }

  console.log("\n— 取消就是什么都不做 —");
  {
    const before = await run(STATE);
    const esc = await run(KEY("Escape"));
    ok(before.up && before.focusIn && before.typed === "合同模板",
      "先验料：这会儿对话框开着、里头打了字、焦点在输入框里", before);
    ok(before.up && esc.up === false, "Esc 关掉对话框", { 之前: before.up, 之后: esc.up });
    ok(before.typed && esc.posts.length === 0, "★里头明明打了字，Esc 之后一个字都没发出去★", { 打的字: before.typed, posts: esc.posts });
    ok(before.focusIn && esc.focus === "lb-mkdir", "焦点从输入框还回刚才那颗按钮（不还的话键盘用户得从头 Tab 一遍）", { 之前: before.focusIn, 之后: esc.focus });
  }
  {
    await run(CLICK);
    await run(TYPE("本来想建的"));
    const was = await run(STATE);
    const r = await run(`
      (async () => {
        const m = document.querySelector(".ask-mask");
        if (!m) return { up: false, posts: window.__posts.slice(), missing: true };
        m.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 80));
        return { up: !!document.querySelector(".ask-mask"), posts: window.__posts.slice() };
      })()
    `);
    ok(was.up && was.typed === "本来想建的" && r.up === false && r.posts.length === 0,
      "点对话框外面的空白处 = 取消，也不发", { 之前: was, 之后: r });
  }
  {
    await run(CLICK);
    await run(TYPE("本来想建的"));
    const was = await run(STATE);
    const r = await run(`
      (async () => {
        const no = document.querySelector(".ask-no");
        if (!no) return { up: false, posts: window.__posts.slice(), missing: true };
        no.click();
        await new Promise((r) => setTimeout(r, 80));
        return { up: !!document.querySelector(".ask-mask"), posts: window.__posts.slice() };
      })()
    `);
    ok(was.up && was.typed === "本来想建的" && r.up === false && r.posts.length === 0,
      "「取消」按钮也一样", { 之前: was, 之后: r });
  }

  console.log("\n— 填完了，要真发得出去 —");
  {
    await run(OPENPAGE(""));
    await run(CLICK);
    await run(TYPE("  合同模板  "));
    const was = await run(STATE);
    const r = await run(KEY("Enter"));
    ok(r.posts.length === 1, "★回车 → 真的发出去了一次★", r.posts);
    ok(r.posts[0] && r.posts[0].name === "合同模板", "名字两头的空格剃掉了（不剃的话会建出一个名字带空格的目录）", r.posts[0]);
    ok(r.posts[0] && r.posts[0].dir === "", "根目录下建，dir 是空串", r.posts[0]);
    ok(was.up && r.up === false, "发完对话框自己收掉", { 之前: was.up, 之后: r.up });
  }
  {
    await run(OPENPAGE("客户资料"));
    await run(CLICK);
    const hint = await run(`(() => { const h = document.querySelector(".ask-h"); return h ? h.textContent : "（对话框根本没出来）"; })()`);
    ok(/客户资料/.test(hint), "在子目录里点新建，先说清楚建在哪一层", hint);
    await run(TYPE("2026年"));
    const r = await run(`
      (async () => {
        const b = document.querySelector(".ask-ok");
        if (!b) return { posts: window.__posts.slice(), up: false, missing: true };
        b.click();
        await new Promise((r) => setTimeout(r, 200));
        return { posts: window.__posts.slice(), up: !!document.querySelector(".ask-mask") };
      })()
    `);
    ok(r.posts.length === 1 && r.posts[0].dir === "客户资料" && r.posts[0].name === "2026年",
      "点「建好」按钮也走同一条路，并且带上了当前这一层", r.posts);
  }
  {
    await run(OPENPAGE(""));
    await run(CLICK);
    await run(TYPE("老地方"));
    await run(`(() => { const b = document.querySelector(".ask-ok"); if (b) b.click(); })()`);
    const r = await run(AFTER);
    ok(/同名文件夹已存在/.test(r.toast), "服务端说重名时界面上说出来，不是默默无事", r.toast);
  }

  console.log("\n— 同一时刻只留一个 —");
  {
    const r = await run(`
      (async () => {
        if (typeof askText !== "function") return { n: -1, title: "askText 根本不存在", first: "askText 根本不存在" };
        let first = "还没回来";
        askText({ title: "第一个" }).then((v) => { first = v; });
        askText({ title: "第二个" });
        await new Promise((r) => setTimeout(r, 80));
        const masks = document.querySelectorAll(".ask-mask");
        const out = { n: masks.length, title: masks.length ? masks[masks.length - 1].querySelector(".ask-t").textContent : "", first };
        if (askText._close) askText._close(null);
        return out;
      })()
    `);
    ok(r.n === 1, "开第二个的时候第一个自己收掉，页面上只剩一层", r.n);
    ok(r.title === "第二个", "留下的是后开的那个", r.title);
    ok(r.first === null, "★前一个的 Promise 按「取消」结掉了——不结的话调用方永远 await 在那儿★", r.first);
  }
  {
    const r = await run(`
      (async () => {
        if (typeof askText !== "function") return { sel: false, still: false, v: "askText 根本不存在" };
        const p = askText({ title: "选词中", value: "初稿" });
        await new Promise((r) => setTimeout(r, 40));
        const i = document.querySelector(".ask-in");
        const sel = i.selectionStart === 0 && i.selectionEnd === i.value.length;
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 60));
        const still = !!document.querySelector(".ask-mask");
        if (askText._close) askText._close(null);
        return { sel, still, v: i.value };
      })()
    `);
    ok(r.sel, "带默认值打开时整段选中，直接打字就能覆盖（手填工作空间路径那处要的就是这个）", r);
    ok(r.still, "★输入法选词时的那个回车不算提交——中文名几乎每次都要选一次词★", r.still);
  }

  srv.close();
  console.log(fail ? `\n有失败：${pass} 过 / ${fail} 挂` : `\n全部通过：${pass} 过 / 0 挂`);
  app.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error("测试自己崩了：", (e && e.stack) || e);
  app.exit(1);
});
