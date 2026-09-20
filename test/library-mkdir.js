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
 * 后来这一页又补了「删」：用户原话「资料库这里能创建目录也要能删除目录或者文件啊」。
 * 删是撤不回来的，所以它没走 native confirm——那玩意儿挂的是原生模态框，
 * 离屏测试一个字都验不了，框里也说不出「这个文件夹里还有 3 样东西」。
 * 最后那一段钉的就是这件事：点得到、说得清、取消真不发、而且点「删」不会变成「进这个文件夹」。
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
  window.__dels = [];
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
    if (s.includes("/api/library/folder") && m === "DELETE") {
      window.__dels.push(s);
      return J({ ok: true });
    }
    if (s.includes("/api/library/file/") && m === "DELETE") {
      window.__dels.push(s);
      return J({ ok: true });
    }
    if (s.includes("/api/library/outputs")) return J({ tasks: [] });
    if (s.includes("/api/library/search")) return J({ items: [] });
    if (s.includes("/api/library")) return J({
      dir: window.__dir || "",
      // 一个空的、一个里头还有东西的：这两条走的是完全不同的两句话，也是不同的结局
      dirs: window.__bare ? [] : [{ path: "空文件夹", name: "空文件夹", count: 0 },
                                   { path: "客户A", name: "客户A", count: 3 }],
      files: window.__bare ? [] : [{ path: "报价单.md", name: "报价单.md", size: 2048, mtime: Date.now() }],
      folders: [], notes: [],
    });
    if (s.includes("/api/settings")) return J(settingsCache);
    // 本地产物那一段的料。它是反向对照：这几行上面**不许**有垃圾桶
    if (s.includes("/api/files")) return J(window.__bare ? [] : [{ name: "周报.md", size: 900, mtime: Date.now() }]);
    return real.apply(this, arguments);
  };
})()
`;

/** 把资料库那一页画出来，停在「文件夹」这一栏的根目录 */
const OPENPAGE = (dir, bare) => `
(async () => {
  window.__dir = ${JSON.stringify(dir || "")};
  window.__bare = ${bare === false ? "false" : "true"};
  window.__posts = [];
  window.__dels = [];
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
  // 语言先钉成中文。Electron 的 navigator.language 随系统走——本机是 zh，CI 那台是 en，
  // 而下面整套断言都是照中文文案写的。不钉的话它在 CI 上比的是英文界面，
  // 「文案对不对」这一整类断言在那边等于没跑（这套测试就是这么在 CI 上红的）。
  // 英文界面另有一节专门验，在最后面。
  await run('I18N.setLang("zh")');

  console.log("\n— 为什么非得自己画一个对话框 —");
  {
    const r = await run(`
      (() => {
        const out = { type: typeof window.prompt };
        try { window.prompt("x"); out.threw = false; }
        catch (e) { out.threw = true; out.msg = String((e && e.message) || e); }
        return out;
      })()
    `);
    ok(r.type === "function", "先验料：window.prompt 在这儿是个函数（所以「判断有没有」的写法挡不住）", r.type);
    ok(r.threw === true, "★它一调用就抛，整个 onclick 当场断掉——老代码就是死在这儿★", r.msg);
  }
  {
    // 这条反向对照原来写的是 `typeof window.confirm === "function"`——而这份文件开头刚说过
    // typeof 对一个「一调用就抛」的 API 什么都证明不了（prompt 的 typeof 也是 "function"）。
    // 拿被自己否掉的写法当证据，等于这条断言从来没成立过。真去调一次：
    // 它要是好使，会挂在一个原生模态框上等人点——既不返回也不抛。
    // 所以另开一扇一次性的窗让它去挂，量完直接销毁；挂在主窗上的话后面整套断言全废。
    // 判据是「抛没抛」，不是「挂没挂」：窗是隐藏的，那个框有时会被 Electron 直接收掉，
    // 于是同一份代码一会儿挂住一会儿返回——那是这扇窗的事，跟 confirm 好不好使无关。
    // 两个 API 在同一扇窗里各调一次，prompt 抛、confirm 不抛，这条对比才是真的。
    const probe = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false } });
    await probe.loadURL("data:text/html,<!doctype html><meta charset=utf-8><title>probe</title>");
    const 调一次 = (api) => Promise.race([
      probe.webContents
        .executeJavaScript(`(() => { try { window.${api}("x"); return "没抛"; } catch (e) { return "抛了：" + e.message; } })()`)
        .then((v) => v, (e) => "抛了：" + String((e && e.message) || e)),
      new Promise((r) => setTimeout(() => r("没抛（挂在框上了）"), 2500)),
    ]);
    const prompt判 = await 调一次("prompt");
    const confirm判 = await 调一次("confirm");
    probe.destroy();
    ok(prompt判.startsWith("抛了") && !confirm判.startsWith("抛了"),
       "★反向对照：同一扇窗里各调一次——prompt 抛，confirm 不抛★ "
       + "所以全站那些确认框对用户是好使的，不该顺手一起改；但离屏测试点不动那个框，"
       + "新写的删除才自己画（askConfirm）", { prompt: prompt判, confirm: confirm判 });
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

  console.log("\n— 两段分开摆：哪一段是「你放进去的」，哪一段是「任务写出来的」 —");
  // 用户连问三遍「这儿建目录有啥用啊」，还猜「资料库指的是产出成果吧」。猜得有道理：
  // 这一页底下就摆着「本地产物」，而「新建/上传」原来悬在整页的工具条上——
  // 从那个位置看，它就像是在给产出建目录。所以钉两件事：两段各有标题，
  // 而且那两颗按钮长在「参考资料」这一段的标题行里，不在整页的工具条上。
  {
    const r = await run(OPENPAGE("", false) + `.then(async () => {
      const secs = [...document.querySelectorAll(".lib-list .sec")].map((s) => s.textContent.replace(/\\s+/g, " ").trim());
      const mk = document.getElementById("lb-mkdir");
      return {
        secs,
        在标题行里: !!(mk && mk.closest(".lib-sec")),
        在整页工具条上: !!(mk && mk.closest(".lib-bar-acts")),
        第一段说了啥: (document.querySelector(".lib-list .lib-sec .lib-sec-l em") || {}).textContent || "",
      };
    })`);
    ok(r.secs.some((t) => t.startsWith("参考资料")) && r.secs.some((t) => t.startsWith("本地产物")),
       "★「参考资料」和「本地产物」各有各的标题★ 摞在一起的后果不是「乱」，是人把两件事当成一件", r.secs);
    ok(r.在标题行里 && !r.在整页工具条上,
       "★「新建文件夹/上传」长在「参考资料」那一段的标题行里，不在整页的工具条上★ "
       + "就近：一颗按钮摆在哪儿，人就以为它管哪儿", r);
    ok(/AI/.test(r.第一段说了啥),
       "标题旁边一句人话把这段是干嘛的说了（不然「有啥用」还得有人在旁边解释）", r.第一段说了啥);
    const e = await run(OPENPAGE("", true) + `.then(() => (document.querySelector(".lib-none") || {}).innerHTML || "")`);
    ok(/library_list/.test(e) && /只看得见那一块/.test(e),
       "★空的时候说得出「往这儿放什么、放了会怎样」★ 原来只有一句「还没有参考资料」——正确的废话",
       e.slice(0, 120));
  }

  console.log("\n— 删得掉，而且删之前说得清 —");
  {
    const p = await run(OPENPAGE("", false) + `.then(() => ({
      文件夹上的垃圾桶: document.querySelectorAll(".lib-dir [data-del-dir]").length,
      资料上的垃圾桶: document.querySelectorAll('.lib-it[data-src="lib"] [data-del-file]').length,
      本地产物上的垃圾桶: document.querySelectorAll('.lib-it[data-src="ws"] [data-del-file]').length,
      产物行数: document.querySelectorAll('.lib-it[data-src="ws"]').length,
    }))`);
    ok(p.文件夹上的垃圾桶 === 2, "★两个文件夹，两颗垃圾桶——「开关存在但找不到＝没有」，所以它长在行上★", p);
    ok(p.资料上的垃圾桶 === 1, "★资料那一行也删得掉，不用先点开右边的预览栏才找得到「删除」★", p);
    ok(p.产物行数 > 0 && p.本地产物上的垃圾桶 === 0,
       "★反向对照：本地产物不给垃圾桶★ 那是任务在工作目录里写出来的，从这一页删等于伸手改任务的现场", p);

    // 点「删」不能变成「进这个文件夹」：垃圾桶就长在 .lib-dir 里面，
    // 不 stopPropagation 的话这一下会先被外层那个「进去」的处理函数接走
    const r1 = await run(`(async () => {
      const b1 = document.querySelector('[data-del-dir="空文件夹"]');
      if (!b1) return { 框开着: false, 没找到垃圾桶: true, 现在在哪一层: libState.dir, 发了几条: window.__dels.length };
      b1.click();
      await new Promise((r) => setTimeout(r, 120));
      const m = document.querySelector(".ask-mask");
      return {
        框开着: !!m,
        标题: m ? m.querySelector(".ask-t").textContent : "",
        说明: m ? (m.querySelector(".ask-h") || {}).textContent || "" : "",
        钮上写的: m ? m.querySelector(".ask-ok").textContent : "",
        红的: m ? m.querySelector(".ask-ok").classList.contains("is-danger") : false,
        焦点在: m ? (document.activeElement === m.querySelector(".ask-no") ? "算了" : "别处") : "",
        现在在哪一层: libState.dir,
        发了几条: window.__dels.length,
      };
    })()`);
    ok(r1.框开着 && /空文件夹/.test(r1.标题), "点垃圾桶 → 先问一句，标题里带着要删的是哪个", r1);
    ok(r1.现在在哪一层 === "", "★点「删」没有变成「进这个文件夹」★ 不拦住事件的话，人点的是删、结果是进去了", r1);
    ok(r1.发了几条 === 0, "★问都还没问完，一个 DELETE 都还没发出去★", r1.发了几条);
    ok(r1.焦点在 === "算了",
       "★焦点落在「算了」上，不在「删掉」上★ 回车是这一步最容易被手快敲下去的键，它该落在撤得回来的那一边", r1);
    ok(r1.红的 === true && r1.钮上写的 === "删掉",
       "那颗钮不跟「保存」「建好」长一个样：人是照着位置按的，不是照着字按的", r1);

    const r2 = await run(`(async () => {
      const ok2 = document.querySelector(".ask-mask .ask-ok");
      if (!ok2) return { 发了: ["(框没开)"], 框还在: false };
      ok2.click();
      await new Promise((r) => setTimeout(r, 200));
      return { 发了: window.__dels.slice(), 框还在: !!document.querySelector(".ask-mask") };
    })()`);
    ok(r2.发了.length === 1 && /\/api\/library\/folder\?dir=/.test(r2.发了[0]),
       "★按「删掉」→ 真发了一条 DELETE，而且带着删的是哪一个★", r2.发了);
    ok(decodeURIComponent(r2.发了[0]).includes("空文件夹"), "带过去的就是刚才点的那个", r2.发了);
    ok(!r2.框还在, "发完框自己收掉", r2);

    // 非空的那个：服务端本来就不给删（共享的一份，一条 rm -rf 下去别人的素材也没了）。
    // 与其让人点完确认再吃一句 400，不如在框里先把「还剩几样」说出来
    const r3 = await run(OPENPAGE("", false) + `.then(async () => {
      const b3 = document.querySelector('[data-del-dir="客户A"]');
      if (!b3) return { 说明: "(没找到垃圾桶)", 钮: "", 发了几条: window.__dels.length };
      b3.click();
      await new Promise((r) => setTimeout(r, 120));
      const m = document.querySelector(".ask-mask");
      if (!m) return { 说明: "(框根本没开)", 钮: "", 发了几条: window.__dels.length };
      const 说明 = (m.querySelector(".ask-h") || {}).textContent || "";
      const 钮 = m.querySelector(".ask-ok").textContent;
      m.querySelector(".ask-ok").click();
      await new Promise((r) => setTimeout(r, 200));
      return { 说明, 钮, 发了几条: window.__dels.length };
    })`);
    ok(/还有 3 样东西/.test(r3.说明),
       "★里头还有几样，框里直接说出来★ 不说的话人只会点完确认再吃一句 400，还以为是坏了", r3.说明);
    ok(r3.钮 === "知道了" && r3.发了几条 === 0,
       "★删不了的时候那颗钮就不叫「删掉」，按下去也确实一条请求都不发★ "
       + "摆一颗按下去必定失败的「删掉」，比没有还气人", r3);

    // 删资料：取消一次、确认一次，两头都要钉
    const r4 = await run(OPENPAGE("", false) + `.then(async () => {
      const b4 = document.querySelector("[data-del-file]");
      if (!b4) return { 标题: "(没找到垃圾桶)", 取消后发了: window.__dels.length, 框还在: false };
      b4.click();
      await new Promise((r) => setTimeout(r, 120));
      const m = document.querySelector(".ask-mask");
      if (!m) return { 标题: "(框根本没开)", 取消后发了: window.__dels.length, 框还在: false };
      const 标题 = m.querySelector(".ask-t").textContent;
      m.querySelector(".ask-no").click();
      await new Promise((r) => setTimeout(r, 150));
      return { 标题, 取消后发了: window.__dels.length, 框还在: !!document.querySelector(".ask-mask") };
    })`);
    ok(/报价单\.md/.test(r4.标题), "删资料也先问一句，标题里带着文件名", r4.标题);
    ok(r4.取消后发了 === 0 && !r4.框还在, "★按「算了」→ 一条都不发★ 这条最容易假绿，所以上面先钉了框确实开过", r4);

    const r5 = await run(`(async () => {
      const b5 = document.querySelector("[data-del-file]");
      if (!b5) return { 发了: ["(没找到垃圾桶)"], toast: "" };
      b5.click();
      await new Promise((r) => setTimeout(r, 120));
      const ok5 = document.querySelector(".ask-mask .ask-ok");
      if (!ok5) return { 发了: ["(框没开)"], toast: "" };
      ok5.click();
      await new Promise((r) => setTimeout(r, 200));
      const t = document.getElementById("owb-toast");
      return { 发了: window.__dels.slice(), toast: t && t.classList.contains("show") ? t.textContent.trim() : "" };
    })()`);
    ok(r5.发了.length === 1 && /\/api\/library\/file\//.test(r5.发了[0]) && /报价单/.test(decodeURIComponent(r5.发了[0])),
       "★按「删掉」→ 真发了 DELETE /api/library/file/…★", r5.发了);
    ok(/删/.test(r5.toast), "删完有回话，不是静悄悄地少了一行", r5.toast);
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n— 切成英文：这一页不许剩中文 —");
  {
    // 全站已经有一道英文覆盖率闸门（test/e2e.js 的 testI18n），它按百分比算：
    // 短文案 ≥90%、长文案 ≥80%。百分比看不见「某一页整页没翻」——这一页 20 多句中文
    // 摊进全站七百多句里，照样在线以上。所以这儿换个量法：把页面真渲染出来，
    // 切成英文，数屏幕上还剩几个汉字。人名、文件名、文件夹名是用户自己的数据，不该翻，
    // 单独列出来排除掉——排除名单写死，免得哪天把漏翻也一起放过去。
    const OWN = ["空文件夹", "客户A", "报价单.md", "周报.md"];   // 替身数据里的名字
    const SCAN = (bare) => `
      (async () => {
        I18N.setLang("en");
        window.__bare = ${bare ? "true" : "false"};
        chatCol.innerHTML = '<div class="assist-page" id="assist-page"></div>';
        libState.view = "dir"; libState.q = ""; libState.dir = ""; libState.pick = null;
        await renderLibPage();
        I18N.apply(document.body, "en");
        await new Promise((r) => setTimeout(r, 120));
        return window.__cjk(document.getElementById("assist-page"));
      })()`;
    // 数汉字的家伙什：正文和 title/placeholder/aria-label 都算——这三个属性人也看得见
    await run(`
      window.__cjk = (scope) => {
        const own = ${JSON.stringify(OWN)};
        // 用户自己的名字先抠掉再数汉字：「Delete 「报价单.md」?」这种是翻好了的——
        // 句子是英文，中间那截是他自己起的文件名，本来就不该动
        const bare = (t) => own.reduce((acc, n) => acc.split(n).join(""), t);
        const left = (t) => /[\u4e00-\u9fa5]/.test(bare(t));
        const out = [];
        const w = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = w.nextNode())) {
          const t = (n.nodeValue || "").trim();
          if (t && left(t)) out.push(t);
        }
        for (const el of scope.querySelectorAll("[title],[placeholder],[aria-label]")) {
          for (const a of ["title", "placeholder", "aria-label"]) {
            const v = el.getAttribute(a);
            if (v && left(v)) out.push(a + "=" + v);
          }
        }
        return [...new Set(out)];
      };
      true;   // executeJavaScript 会把最后一个表达式的值送回 node —— 送一个函数过去是克隆不了的
    `);

    const full = await run(SCAN(false));
    ok(full.length === 0,
       "★英文界面上这一页不剩中文★ 原来剩 22 段正文 + 15 处属性：页签、筛选、分组、摆法、"
       + "两段标题、侧栏那句、时间列，整页几乎没进词典——英文用户看到的是一页中文",
       full.slice(0, 8));
    const empty = await run(SCAN(true));
    ok(empty.length === 0,
       "★空状态那几句也翻得出来★ 这几句正是「新建文件夹到底有什么用」的答案，"
       + "漏翻的话英文用户连问都没处问", empty.slice(0, 8));

    // 反向对照：把一条词条临时抠掉，上面那个量法必须当场看得见。
    // 不做这一步的话，「剩 0 个汉字」也可能是因为扫描器根本没扫到东西
    const blind = await run(`
      (async () => {
        const save = I18N.DICT.en["参考资料"];
        delete I18N.DICT.en["参考资料"];
        chatCol.innerHTML = '<div class="assist-page" id="assist-page"></div>';
        await renderLibPage();
        I18N.apply(document.body, "en");
        await new Promise((r) => setTimeout(r, 120));
        const left = window.__cjk(document.getElementById("assist-page"));
        I18N.DICT.en["参考资料"] = save;
        return left;
      })()`);
    ok(blind.includes("参考资料"),
       "★反向对照：抠掉一条词条，它当场就被数出来★ 不验这一下的话，「剩 0 个」也可能是扫描器自己瞎了",
       blind);

    // 对话框是点开才生成的，翻译靠 MutationObserver 补——单独验一遍
    const dlg = await run(`
      (async () => {
        chatCol.innerHTML = '<div class="assist-page" id="assist-page"></div>';
        window.__bare = false;
        await renderLibPage();
        I18N.apply(document.body, "en");
        const out = {};
        document.getElementById("lb-mkdir").click();
        await new Promise((r) => setTimeout(r, 150));
        out.新建 = window.__cjk(document.querySelector(".ask-mask"));
        out.新建标题 = document.querySelector(".ask-mask .ask-t").textContent;
        // 名字不合规那句也是现画出来的
        const i = document.querySelector(".ask-mask .ask-in");
        i.value = "a/b"; i.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 80));
        out.报错 = window.__cjk(document.querySelector(".ask-mask"));
        document.querySelector(".ask-mask .ask-no").click();
        await new Promise((r) => setTimeout(r, 120));
        // 非空文件夹那句：数目夹在句子中间，走的是模式匹配那条路
        document.querySelector('[data-del-dir="客户A"]').click();
        await new Promise((r) => setTimeout(r, 150));
        out.删文件夹 = window.__cjk(document.querySelector(".ask-mask"));
        out.删文件夹说了 = document.querySelector(".ask-mask .ask-h").textContent;
        document.querySelector(".ask-mask .ask-no").click();
        await new Promise((r) => setTimeout(r, 120));
        document.querySelector("[data-del-file]").click();
        await new Promise((r) => setTimeout(r, 150));
        out.删资料 = window.__cjk(document.querySelector(".ask-mask"));
        document.querySelector(".ask-mask .ask-no").click();
        I18N.setLang("zh");
        return out;
      })()`);
    ok(dlg.新建.length === 0, "★「新建文件夹」那个框整个翻得过来★ 它是点开才画出来的，靠观察者补翻", dlg.新建);
    ok(/New folder/i.test(dlg.新建标题), "框的标题确实换成了英文（不是靠扫描器漏看换来的绿）", dlg.新建标题);
    ok(dlg.报错.length === 0, "★名字不合规那句也翻得过来★ 这句是打字当场画出来的", dlg.报错);
    ok(dlg.删文件夹.length === 0 && /3/.test(dlg.删文件夹说了),
       "★「里面还有 3 样东西」翻得过来，数目原样带过去★ 数目夹在句子中间，整句走模式匹配",
       { 剩下的中文: dlg.删文件夹, 框里那句: dlg.删文件夹说了 });
    ok(dlg.删资料.length === 0, "★删资料那个框也翻得过来★", dlg.删资料);
  }

  srv.close();
  console.log(fail ? `\n有失败：${pass} 过 / ${fail} 挂` : `\n全部通过：${pass} 过 / 0 挂`);
  app.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error("测试自己崩了：", (e && e.stack) || e);
  app.exit(1);
});
