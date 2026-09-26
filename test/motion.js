"use strict";
/**
 * HTML 动画出片的纯逻辑 —— motion-clock.js
 *
 * 逐帧截图比实时慢得多，页面要是按真实时间跑，同一个 HTML 每次渲出来都不一样。所以页面里的
 * 时间、定时器、rAF、随机数全换成虚拟的，驱动方每帧调一次 __owb_step(t)。这里钉住的是：
 *   ① 定时器按（到期时间, 登记顺序）放，回调里 performance.now() 就是它自己的到期时刻；
 *   ② 3 秒才冒出来的动画从 3 秒起算，不会一出生就跳到结尾；放完的动画 finish() 恰好一次；
 *   ③ 片段只在自己的时间窗里显示，窗口里的 CSS 动画从片段起点算；
 *   ④ await sleep() 之后那几行跑在定时器的虚拟时刻，不是下一帧；
 *   ⑤ 帧时间用乘法算，两分钟 60fps 末尾也不漂；画幅/帧率/时长的边界；
 *   ⑥ ffmpeg 参数表编出来的片子是 h264 + yuv420p + bt709，颜色通道没反，2 倍图被缩回来。
 * 虚拟时钟在 vm 沙盒里用假 document 跑（沙盒里没有本模块的变量，漏引用当场报错）；
 * 几条关键断言各配一个「把那行改坏」的反向检查，证明断言真能抓到问题。
 * 真 ffmpeg 那段只在本机找得到 ffmpeg 时跑，没有就明说跳过（OWB_REQUIRE_FFMPEG=1 时算失败）。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const zlib = require("zlib");
const assert = require("assert");
const { spawnSync } = require("child_process");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "owb-motion-test-"));
process.env.OPENWORKBUDDY_HOME = path.join(TMP, "home");
const M = require("../motion-clock");
const MP = require("../lib/media-probe");

let pass = 0, fail = 0;
const ok = (v, m, extra) => { if (v) pass++; else { fail++; console.error("  ×", m, extra === undefined ? "" : "\n     " + extra); } };
const eq = (a, b, m) => { try { assert.deepStrictEqual(a, b, m); pass++; } catch { fail++; console.error("  ×", m, "\n     实际:", JSON.stringify(a), "期望:", JSON.stringify(b)); } };
const near = (a, b, m, tol = 1e-6) => ok(typeof a === "number" && Math.abs(a - b) <= tol, m, `实际 ${a}，期望 ${b}`);
const errOf = async (p) => { try { await p; return null; } catch (e) { return e; } };
// 沙盒里造的数组/对象原型和这边不是同一个，deepStrictEqual 会判不等：比之前先过一遍 JSON
const j = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const EPOCH = M.DEFAULT_EPOCH;
const FT = (i, fps = 30) => (i * 1000) / fps;
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 把运行时源码里的一段改掉，拿来做反向检查。count 必须是 1：改到的就是想改的那一行。
 */
function mutate(from, to, cfg = { seed: 7, epoch: EPOCH }) {
  const src = M.runtimeSource(cfg);
  const count = src.split(from).length - 1;
  return { src: src.split(from).join(to), count };
}

/**
 * 一张假页面：vm 沙盒当 window，只放虚拟时钟用得到的那几样。
 * opts.cfg 传给 runtimeSource；opts.source 直接给改过的源码；opts.globals 覆盖沙盒里的全局。
 */
function makePage(opts = {}) {
  const log = [];
  const realLog = [];
  const winListeners = {};
  const docListeners = {};
  class El {
    constructor(tag, attrs = {}) {
      this.tagName = String(tag).toUpperCase();
      this.attrs = {};
      for (const [k, v] of Object.entries(attrs)) this.attrs[k] = String(v);
      this.children = []; this.parent = null; this.listeners = {}; this.style = {};
      this.scrollWidth = 0; this.scrollHeight = 0; this.textContent = "";
    }
    get isConnected() { for (let n = this; n; n = n.parent) if (n === html) return true; return false; }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    removeAttribute(k) { delete this.attrs[k]; }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
    appendChild(c) { c.parent = this; this.children.push(c); return c; }
    remove() { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; } }
    contains(o) { for (let n = o; n; n = n.parent) if (n === this) return true; return false; }
    // 只认运行时用到的两种选择器：标签名、[a][b] 属性存在
    matches(sel) {
      const need = [...String(sel).matchAll(/\[([^\]=]+)\]/g)].map((m) => m[1]);
      const tag = String(sel).replace(/\[[^\]]*\]/g, "").trim();
      if (tag && tag.toUpperCase() !== this.tagName) return false;
      return need.every((a) => this.hasAttribute(a));
    }
    closest(sel) { for (let n = this; n; n = n.parent) if (n.matches(sel)) return n; return null; }
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
    removeEventListener(t, f) { const l = this.listeners[t]; if (l) { const i = l.indexOf(f); if (i >= 0) l.splice(i, 1); } }
    dispatchEvent(e) { for (const f of (this.listeners[e.type] || []).slice()) f(e); return true; }
  }
  const html = new El("html");
  const head = html.appendChild(new El("head"));
  const body = html.appendChild(new El("body"));
  const all = () => { const out = []; const walk = (n) => { out.push(n); n.children.forEach(walk); }; walk(html); return out; };
  const rendered = (e) => { if (!e.isConnected) return false; for (let n = e; n; n = n.parent) if (n.hasAttribute("data-owb-off")) return false; return true; };

  const live = [];
  class Anim {
    constructor(target, { end = 1000, name } = {}) {
      this._ct = 0; this._end = end; this.playState = "running"; this.playbackRate = 1;
      this.pauses = 0; this.finishes = 0; this.plays = 0;
      this.effect = { target, getComputedTiming: () => ({ endTime: this._end }) };
      if (name) this.animationName = name;
      live.push(this);
    }
    pause() { this.pauses++; this.playState = "paused"; }
    play() { this.plays++; this.playState = "running"; }
    finish() { this.finishes++; this._ct = this._end; this.playState = "finished"; }
    cancel() { const i = live.indexOf(this); if (i >= 0) live.splice(i, 1); this.playState = "idle"; }
    get currentTime() { return this._ct; }
    set currentTime(v) { this._ct = v; if (this.playState === "finished" && v < this._end) this.playState = "paused"; }
  }
  // CSS 动画：元素被 display:none（自己或祖先带 data-owb-off）时浏览器会取消它，重新露面时生成一个新的
  const cssRules = [];
  function syncCss() {
    for (const r of cssRules) {
      const on = rendered(r.el);
      if (on && !r.anim) r.anim = new Anim(r.el, { end: r.end, name: r.name });
      else if (!on && r.anim) { r.anim.cancel(); r.anim = null; }
    }
  }
  const doc = {
    readyState: "complete",
    documentElement: html, head, body,
    fonts: { ready: Promise.resolve() },
    getAnimations() { syncCss(); return live.slice(); },
    querySelectorAll(sel) { return all().filter((n) => n.matches(sel)); },
    createElement(tag) { return new El(tag); },
    addEventListener(t, f) { (docListeners[t] = docListeners[t] || []).push(f); },
  };
  const page = {
    el: (tag, attrs, parent) => (parent || body).appendChild(new El(tag, attrs)),
    anim: (target, o) => new Anim(target, o),
    css: (el, name, end) => { const r = { el, name, end, anim: null }; cssRules.push(r); return r; },
  };
  class FakeAudio { constructor(src) { this.src = src; } }
  class FakeEvent { constructor(type) { this.type = type; } }
  const sandbox = {
    document: doc, log, page, console,
    setTimeout, clearTimeout,
    requestAnimationFrame: (fn) => setImmediate(() => fn(0)),
    MessageChannel,
    performance: { now: () => -1 },
    addEventListener: (t, f) => { (winListeners[t] = winListeners[t] || []).push(f); },
    getComputedStyle: (el) => ({ animationName: el.style.animationName || "none", animationPlayState: el.style.animationPlayState || "running" }),
    Animation: Anim,
    Audio: FakeAudio, AudioContext: class {},
    Event: FakeEvent,
    speechSynthesis: { speak: () => realLog.push("speak") },
    ...(opts.globals || {}),
  };
  if (opts.noMC) delete sandbox.MessageChannel;
  const ctx = vm.createContext(sandbox);
  const src = opts.source || M.runtimeSource(opts.cfg || { seed: 7, epoch: EPOCH });
  vm.runInContext(src, ctx);
  return {
    ctx, doc, html, head, body, log, live, realLog, cssRules, src, ...page,
    run: (code) => vm.runInContext(code, ctx),
    step: (t) => ctx.__owb_step(t),
    async steps(ts) { let last; for (const t of ts) last = await ctx.__owb_step(t); return last; },
    fire: (t, e) => (winListeners[t] || []).forEach((f) => f(e)),
    docFire: (t) => (docListeners[t] || []).forEach((f) => f({ type: t })),
  };
}

/** 假 video：currentTime 一改就（异步）发 seeked；stuck 的永远不发 */
function fakeVideo(p, attrs = {}, o = {}) {
  const v = p.el("video", attrs, o.parent);
  v.paused = false; v.readyState = o.readyState == null ? 4 : o.readyState; v.duration = o.duration == null ? 10 : o.duration;
  v.loop = !!o.loop; v.muted = !!o.muted; v.src = o.src || "clip.mp4"; v.currentSrc = v.src; v.preload = o.preload || "auto";
  v.error = null; v.seeks = 0; v.loads = 0; v.seekedDone = false;
  v.pause = () => { v.paused = true; };
  v.load = () => { v.loads++; };
  let ct = 0;
  Object.defineProperty(v, "currentTime", {
    get: () => ct,
    set: (x) => {
      ct = x; v.seeks++;
      if (!o.stuck) setTimeout(() => { v.seekedDone = true; v.dispatchEvent({ type: "seeked" }); }, o.seekDelay || 0);
    },
  });
  return v;
}

/** 手写 CRC32（PNG 块校验） */
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}
/** 一张纯色 RGB PNG */
function solidPng(w, h, [r, g, b]) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (w * 3 + 1);
    for (let x = 0; x < w; x++) { raw[o + 1 + x * 3] = r; raw[o + 2 + x * 3] = g; raw[o + 3 + x * 3] = b; }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

(async () => {
  console.log("【1】定时器：按到期时间、登记顺序放，回调里的时刻就是自己的到期时刻");
  {
    const p = makePage();
    eq(p.run("performance.now()"), 0, "装好时虚拟时钟停在 0");
    p.run(`
      setTimeout(() => log.push(["A", performance.now()]), 100);
      setTimeout(() => { log.push(["B", performance.now()]); setTimeout(() => log.push(["D", performance.now()]), 10); }, 50);
      setTimeout(() => log.push(["C", performance.now()]), 50);
      setTimeout(() => log.push(["E", performance.now()]), 201);
    `);
    await p.step(200);
    eq(j(p.log), [["B", 50], ["C", 50], ["D", 60], ["A", 100]], "同时到期按登记顺序；回调里新登记、这一帧内到期的也放；超过 t 的留着");
    eq(p.run("performance.now()"), 200, "放完这一帧，时钟停在 t");
    await p.step(201);
    eq(j(p.log).pop(), ["E", 201], "恰好在下一帧到期的那个在下一帧放");

    const q = makePage();
    q.run(`
      var iv = setInterval(() => { log.push(performance.now()); if (log.length === 3) clearInterval(iv); }, 30);
      var k = setTimeout(() => log.push("killed"), 40); clearTimeout(k);
    `);
    await q.step(200);
    eq(j(q.log), [30, 60, 90], "setInterval 按间隔重复，回调里 clearInterval 就停；clearTimeout 掉的不放");

    // 1000/30 的间隔累加几次后会比帧时间多 1 个 ulp，没有容差就晚一帧
    const iv = `var hits = []; setInterval(() => hits.push(performance.now()), 1000 / 30);`;
    const r = makePage();
    r.run(iv);
    await r.steps(Array.from({ length: 30 }, (_, i) => FT(i)));
    const hits = j(r.ctx.hits);
    eq(hits.length, 29, "30fps 下 1000/30 的 setInterval，30 帧里放 29 次");
    ok(hits.every((h, i) => Math.abs(h - FT(i + 1)) < 1e-6), "每次都在自己那一帧放，没有晚一帧", JSON.stringify(hits));
    const noEps = mutate("const EPS = 1e-4;", "const EPS = 0;");
    eq(noEps.count, 1, "反向检查：容差那行找得到");
    const r2 = makePage({ source: noEps.src });
    r2.run(iv);
    await r2.steps(Array.from({ length: 30 }, (_, i) => FT(i)));
    const hits2 = j(r2.ctx.hits);
    ok(!(hits2.length === 29 && hits2.every((h, i) => Math.abs(h - FT(i + 1)) < 1e-6)), "反向检查：去掉容差，上一条断言就该失败", JSON.stringify(hits2));

    // setTimeout(f,0) 自己调自己：前 6 次在 0ms，之后按规范夹到 4ms 一次，时间才往前走
    const chain = `var c = 0; function f() { c++; setTimeout(f, 0); } f();`;
    const n = makePage();
    n.run(chain);
    await n.step(40);
    eq(n.ctx.c, 17, "嵌套超过 5 层的 0ms 定时器按 4ms 算：到 40ms 一共跑 17 次");
    const noClamp = mutate("(level > 5 && d < 4 ? 4 : d)", "(d)");
    eq(noClamp.count, 1, "反向检查：嵌套钳制那行找得到");
    const n2 = makePage({ source: noClamp.src });
    n2.run(chain);
    const e2 = await errOf(n2.step(40));
    ok(e2 && e2.message === M.FLOOD_MESSAGE, "反向检查：不夹 4ms，自己调自己的页面就原地打转，被一万个定时器的护栏拦下", e2 && e2.message);

    const fl = makePage();
    fl.run(`for (let i = 0; i < 10001; i++) setTimeout(() => {}, 5);`);
    const ef = await errOf(fl.step(10));
    ok(ef && ef.message === M.FLOOD_MESSAGE, "一帧里排了 10001 个定时器：报死循环，不卡死", ef && ef.message);
    const fl2 = makePage();
    fl2.run(`var done = 0; for (let i = 0; i < 10000; i++) setTimeout(() => { done++; }, 5);`);
    ok(!(await errOf(fl2.step(10))), "正好一万个还放得下");
    eq(fl2.ctx.done, 10000, "一万个全放了");

    const ic = makePage();
    ic.run(`requestIdleCallback((d) => log.push([performance.now(), d.timeRemaining(), d.didTimeout]));`);
    await ic.step(10);
    eq(j(ic.log), [[1, 50, false]], "requestIdleCallback 在 1ms 后当定时器放，给足 50ms 空闲");

    const nm = makePage({ noMC: true });
    nm.run(`setTimeout(() => log.push(performance.now()), 20);`);
    await nm.step(30);
    eq(j(nm.log), [20], "页面里没有 MessageChannel 也照样走");
  }

  console.log("【2】rAF、Date、performance、Math.random");
  {
    const p = makePage();
    p.run(`function loop(ts) { log.push(ts); if (log.length < 3) requestAnimationFrame(loop); } requestAnimationFrame(loop);`);
    await p.step(FT(0));
    eq(j(p.log), [0], "rAF 回调拿到这一帧的 t；回调里新登记的不在同一帧跑");
    await p.steps([FT(1), FT(2), FT(3)]);
    eq(j(p.log), [FT(0), FT(1), FT(2)], "之后每帧一次，时间戳就是帧时间");
    const c = makePage();
    c.run(`var ids = {}; ids.a = requestAnimationFrame(() => { log.push("a"); cancelAnimationFrame(ids.b); }); ids.b = requestAnimationFrame(() => log.push("b"));`);
    await c.step(0);
    eq(j(c.log), ["a"], "同一批里被前一个 cancel 掉的 rAF 不跑");

    const d = makePage({ cfg: { seed: 7, epoch: EPOCH } });
    await d.step(1234);
    eq(d.run("Date.now()"), EPOCH + 1234, "Date.now() = 起点 + t");
    eq(d.run("new Date().getTime()"), EPOCH + 1234, "new Date() 也是");
    eq(d.run("new Date(2020, 0, 1).getFullYear()"), 2020, "带参数的 new Date 照常");
    eq(d.run("typeof Date()"), "string", "不带 new 的 Date() 返回字符串");
    ok(/2026/.test(d.run("Date()")), "而且是虚拟时刻的字符串", d.run("Date()"));
    eq(d.run("new Date() instanceof Date"), true, "instanceof Date 照常");
    eq(d.run("Date.UTC(2020, 0, 1)"), Date.UTC(2020, 0, 1), "Date.UTC 照常");
    eq(d.run("performance.now()"), 1234, "performance.now() = t");
    eq(d.run("document.hidden"), false, "页面永远当自己在前台");
    eq(d.run("document.visibilityState"), "visible", "visibilityState 也是");

    const want = (seed) => { const r = M.mulberry32(seed); return Array.from({ length: 5 }, () => r()); };
    const rnd = (cfg) => j(makePage({ cfg }).run("Array.from({ length: 5 }, () => Math.random())"));
    eq(rnd({ seed: 7 }), want(7), "Math.random 是 seed 7 的 mulberry32");
    eq(rnd({ seed: 7 }), rnd({ seed: 7 }), "同一个 seed 两张页面同一串数");
    ok(JSON.stringify(rnd({ seed: 8 })) !== JSON.stringify(rnd({ seed: 7 })), "反向检查：换个 seed 就是另一串");
    eq(rnd({}), want(1), "没给 seed 就是 1");
  }

  console.log("【3】动画：出生时刻、放完 finish 一次、页面自己暂停/续播/拨进度");
  {
    const born = `
      var el1 = page.el("div"), el2 = page.el("div");
      var A1 = page.anim(el1, { end: 5000 }), A2 = null;
      setTimeout(() => { A2 = page.anim(el2, { end: 5000 }); }, 500);
    `;
    const ts = [0, 100, 200, 300, 400, 500, 600, 700];
    const p = makePage();
    p.run(born);
    await p.steps(ts);
    eq(p.ctx.A1.currentTime, 700, "一开始就有的动画在 700ms 时走到 700");
    eq(p.ctx.A2 && p.ctx.A2.currentTime, 200, "500ms 才冒出来的动画在 700ms 时走到 200，不是 700");
    ok(p.ctx.A1.playState === "paused", "动画被按住，由时钟摆位置");
    const bad = mutate("if (!born.has(a)) born.set(a, at);", "if (!born.has(a)) born.set(a, 0);");
    eq(bad.count, 1, "反向检查：记出生时刻那行找得到");
    const pb = makePage({ source: bad.src });
    pb.run(born);
    await pb.steps(ts);
    ok(pb.ctx.A2 && pb.ctx.A2.currentTime !== 200, "反向检查：出生时刻都记成 0，上一条断言就该失败", pb.ctx.A2 && pb.ctx.A2.currentTime);

    const f = makePage();
    f.run(`var F = page.anim(page.el("div"), { end: 300 });`);
    await f.steps([0, 100, 200]);
    eq(f.ctx.F.currentTime, 200, "没放完之前按时间摆");
    await f.steps([300, 400, 500, 600]);
    eq(f.ctx.F.finishes, 1, "放到结尾 finish() 恰好一次（.finished/animationend 才会触发）");
    eq(f.ctx.F.playState, "finished", "之后不再去动它");

    const q = makePage();
    q.run(`
      var P = page.anim(page.el("div"), { end: 5000 });
      setTimeout(() => P.pause(), 200);
      setTimeout(() => P.play(), 400);
      setTimeout(() => { P.currentTime = 1000; }, 600);
    `);
    await q.steps([0, 100, 200, 300]);
    eq(q.ctx.P.currentTime, 200, "页面在 200ms 自己 pause()：停在 200");
    await q.steps([400, 500]);
    eq(q.ctx.P.currentTime, 300, "400ms 时 play()：从 200 接着走，500ms 时是 300");
    await q.steps([600, 700]);
    eq(q.ctx.P.currentTime, 1100, "600ms 时页面把进度拨到 1000：700ms 时是 1100");
  }

  console.log("【4】CSS 暂停态、片段显隐");
  {
    const setup = `
      var el = page.el("div"); el.style.animationName = "fade"; el.style.animationPlayState = "paused";
      page.css(el, "fade", 3000);
      setTimeout(() => { el.style.animationPlayState = "running"; }, 2010);
    `;
    const p = makePage();
    p.run(setup);
    await p.steps([0, 500, 1000, 1500, 2000]);
    const a = p.cssRules[0].anim;
    eq(a && a.currentTime, 0, "animation-play-state: paused 的动画一直停在 0");
    await p.step(2500);
    eq(a && a.currentTime, 490, "2010ms 解除暂停：2500ms 时走到 490，不是一解除就跳到 2500");
    const bad = mutate("return i >= 0 && states.length > 0 && states[i % states.length] === \"paused\";", "return false;");
    eq(bad.count, 1, "反向检查：判断 CSS 暂停那行找得到");
    const pb = makePage({ source: bad.src });
    pb.run(setup);
    await pb.steps([0, 500, 1000, 1500, 2000, 2500]);
    const b = pb.cssRules[0].anim;
    ok(b && b.currentTime !== 490, "反向检查：不认 CSS 暂停，上一条断言就该失败", b && b.currentTime);

    const clip = `
      var clip = page.el("div", { "data-start": "1.01", "data-duration": "0.5" });
      var inner = page.el("span", {}, clip);
      page.css(inner, "pop", 400);
      var outer = page.el("div", { "data-start": "1.02", "data-duration": "2" });
      var late = page.el("div", { "data-start": "1.01", "data-duration": "1" }, outer);
      var deep = page.el("i", {}, late);
      page.css(deep, "rise", 400);
    `;
    const c = makePage();
    c.run(clip);
    await c.step(FT(0));
    ok(c.ctx.clip.hasAttribute("data-owb-off"), "片段没到时间：带上 data-owb-off（display:none）");
    await c.steps(Array.from({ length: 30 }, (_, i) => FT(i + 1)));
    ok(c.ctx.clip.hasAttribute("data-owb-off"), "1000ms 还没到 1.01 秒：仍然藏着");
    await c.step(FT(31));
    ok(!c.ctx.clip.hasAttribute("data-owb-off"), "1033ms 进了时间窗：露出来");
    near(c.cssRules[0].anim && c.cssRules[0].anim.currentTime, FT(31) - 1010, "片段里的 CSS 动画从片段起点 1010ms 算，不是从露面那一帧算");
    near(c.cssRules[1].anim && c.cssRules[1].anim.currentTime, FT(31) - 1020, "套在两层片段里的，从较晚露面的那层（1020ms）算");
    await c.steps(Array.from({ length: 14 }, (_, i) => FT(i + 32)));
    ok(!c.ctx.clip.hasAttribute("data-owb-off"), "1500ms 仍在窗口里");
    await c.step(FT(46));
    ok(c.ctx.clip.hasAttribute("data-owb-off"), "1533ms 过了 1.51 秒：又藏起来");
    const bad2 = mutate("if (at != null) born.set(a, at);", "if (at != null) void 0;");
    eq(bad2.count, 1, "反向检查：片段起点记出生时刻那行找得到");
    const cb = makePage({ source: bad2.src });
    cb.run(clip);
    await cb.steps(Array.from({ length: 32 }, (_, i) => FT(i)));
    const x = cb.cssRules[0].anim && cb.cssRules[0].anim.currentTime;
    ok(!(Math.abs(x - (FT(31) - 1010)) < 1e-6), "反向检查：不按片段起点记，上一条断言就该失败", x);
  }

  console.log("【5】Promise 后续、报错与提醒、护栏");
  {
    const mt = `
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      (async () => {
        await sleep(510); log.push(performance.now());
        await (async () => { await null; await Promise.resolve(); })();
        await sleep(500); log.push(performance.now());
      })();
    `;
    const frames = Array.from({ length: 34 }, (_, i) => FT(i));
    const p = makePage();
    p.run(mt);
    await p.steps(frames);
    eq(j(p.log), [510, 1010], "await sleep() 之后那几行跑在定时器的虚拟时刻，不是下一帧");
    const bad = mutate("        await drain();\n        nest = 0;", "        nest = 0;");
    eq(bad.count, 1, "反向检查：放完回调后清微任务那行找得到");
    const pb = makePage({ source: bad.src });
    pb.run(mt);
    await pb.steps(frames);
    ok(JSON.stringify(j(pb.log)) !== JSON.stringify([510, 1010]), "反向检查：不清微任务，上一条断言就该失败", JSON.stringify(j(pb.log)));

    const e = makePage();
    e.run(`
      setTimeout(() => { throw new Error("boom"); }, 10);
      setTimeout(() => { throw new Error("boom"); }, 20);
      setTimeout("log.push('str')", 30);
    `);
    const r1 = await e.step(50);
    eq(j(r1), { errors: ["boom"], warnings: ["setTimeout/setInterval 传的是字符串代码，没执行：改成传函数"] }, "回调抛错记下、同样的只记一次；字符串代码不执行，提醒改成函数");
    eq(j(e.log), [], "字符串代码确实没跑");
    eq(j(await e.step(60)), { errors: [], warnings: [] }, "报过的不重复报");
    const img = e.el("img"); img.src = "https://x.test/a.png?v=1";
    e.fire("error", { target: img });
    e.fire("error", { error: new Error("kaboom") });
    e.fire("unhandledrejection", { reason: new Error("nope") });
    eq(j(await e.step(70)), { errors: ["kaboom", "nope"], warnings: ["img 没加载出来：a.png"] }, "图片加载失败算提醒，脚本报错和没接住的 Promise 算错");

    const g = makePage();
    await g.step(100);
    const back = await errOf(g.step(50));
    ok(back && /时间只能往前走/.test(back.message), "时间往回拨：拒绝", back && back.message);
    const bad1 = await errOf(g.step(-1));
    ok(bad1 && /帧时间不对/.test(bad1.message), "负数时间：拒绝", bad1 && bad1.message);
    const bad3 = await errOf(g.step(NaN));
    ok(bad3 && /帧时间不对/.test(bad3.message), "NaN：拒绝", bad3 && bad3.message);
    const first = g.step(200);
    const busy = await errOf(g.step(300));
    await first;
    ok(busy && /上一帧还没画完/.test(busy.message), "上一帧没画完就要下一帧：拒绝", busy && busy.message);
    ok(!(await errOf(g.step(300))), "画完了再要就行");

    const s = makePage();
    s.run(`var seen = []; globalThis.__owb_seek = (sec) => { seen.push(sec); };`);
    await s.step(500);
    eq(j(s.ctx.seen), [0.5], "页面自带的 __owb_seek 每帧收到秒数");
    s.run(`globalThis.__owb_seek = () => { throw new Error("bad seek"); };`);
    eq(j((await s.step(600)).errors), ["__owb_seek 出错：bad seek"], "__owb_seek 出错记下来，不拖垮这一帧");

    const top = makePage({ globals: { top: {} } });
    eq(typeof top.ctx.__owb_step, "undefined", "iframe 里不装虚拟时钟");
    ok(top.ctx.setTimeout === setTimeout, "iframe 里的定时器保持原样");

    const twice = makePage();
    const st = twice.ctx.setTimeout;
    twice.run(twice.src);
    ok(twice.ctx.setTimeout === st, "同一页面注入两次：第二次什么都不做");
    await twice.step(5);
    eq(twice.run("Date.now()"), EPOCH + 5, "注入两次后时间照样对");
  }

  console.log("【6】视频、等加载、页面信息、声音");
  {
    const p = makePage();
    const clip = p.el("div", { "data-start": "1", "data-duration": "5" });
    const vc = fakeVideo(p, {}, { parent: clip, seekDelay: 30 });
    const vp = fakeVideo(p, {}, {});
    const vl = fakeVideo(p, {}, { loop: true, duration: 1 });
    const vs = fakeVideo(p, {}, { duration: 1 });
    const offClip = p.el("div", { "data-start": "5", "data-duration": "1" });
    const voff = fakeVideo(p, {}, { parent: offClip });
    const vlate = fakeVideo(p, {}, { readyState: 0, src: "https://x.test/late.mp4" });
    const r = await p.step(1500);
    near(vc.currentTime, 0.5, "片段里的视频按片段起点算：1.5 秒时跳到 0.5");
    ok(vc.seekedDone, "等 seeked 回来才算这一帧画完");
    near(vp.currentTime, 1.5, "普通视频跳到 1.5");
    ok(vp.paused, "视频被按住，由时钟摆位置");
    near(vl.currentTime, 0.5, "循环视频按时长取模");
    near(vs.currentTime, 1, "不循环的停在最后");
    eq(voff.seeks, 0, "藏着的片段里的视频不去动");
    ok(j(r.warnings).includes("视频还没加载出来：late.mp4"), "没加载出来的视频说一声", JSON.stringify(j(r.warnings)));
    eq(vlate.seeks, 0, "没加载出来的不去跳");

    const k = makePage({ cfg: { seed: 7, epoch: EPOCH, seekCapMs: 50 } });
    fakeVideo(k, {}, { stuck: true, src: "https://x.test/stuck.mp4" });
    const t0 = Date.now();
    const rk = await k.step(1000);
    ok(Date.now() - t0 < 2000, "跳不到位的视频最多等上限就放行");
    ok(j(rk.warnings).some((w) => w.includes("没跳到位：stuck.mp4")), "而且说一声", JSON.stringify(j(rk.warnings)));

    const w = makePage();
    const im = w.el("img"); im.complete = false; im.loading = "lazy";
    const vv = fakeVideo(w, {}, { readyState: 0, preload: "none", src: "v.mp4" });
    w.doc.readyState = "loading";
    setTimeout(() => { w.doc.readyState = "complete"; }, 20);
    setTimeout(() => { im.complete = true; }, 40);
    setTimeout(() => { vv.readyState = 4; }, 60);
    eq(j(await w.ctx.__owb_ready(3000)), { ok: true, pending: 0 }, "__owb_ready 等文档、图片、视频都加载完");
    eq(im.loading, "eager", "懒加载的图改成立刻加载，不然视口外的永远不来");
    ok(vv.preload === "auto" && vv.loads === 1, "preload=none 的视频改成 auto 并 load()");
    const w2 = makePage();
    const im2 = w2.el("img"); im2.complete = false;
    const t1 = Date.now();
    eq(j(await w2.ctx.__owb_ready(80)), { ok: false, pending: 1 }, "等到上限还没来：放行，报还差几个");
    ok(Date.now() - t1 < 1500, "不会一直等下去");
    ok(j((await w2.step(0)).warnings).some((x) => x.startsWith("1 个图片/视频")), "缺的图记成提醒");

    const m = makePage();
    m.body.setAttribute("data-duration", "6"); m.body.setAttribute("data-poster", "1.5");
    m.html.scrollWidth = 1080; m.html.scrollHeight = 1920; m.body.scrollWidth = 1100; m.body.scrollHeight = 1900;
    m.el("div", { "data-start": "1", "data-duration": "2" });
    m.el("section", { "data-start": "0.5", "data-duration": "3" });
    m.el("div", { "data-start": "x", "data-duration": "2" });
    m.el("div", { "data-start": "1", "data-duration": "0" });
    eq(j(m.ctx.__owb_meta()), { bodyDuration: 6, clips: [{ start: 1, duration: 2 }, { start: 0.5, duration: 3 }], poster: 1.5, scrollW: 1100, scrollH: 1920, hasAudio: false },
      "__owb_meta：body 时长、合法片段、封面秒数、html/body 里较大的滚动尺寸");
    m.run(`var au = new Audio("a.mp3");`);
    eq(m.ctx.__owb_meta().hasAudio, true, "页面 new Audio 过：记成用了声音");
    eq(m.run("au instanceof Audio && au.src"), "a.mp3", "包过的 Audio 照常能用");

    const m2 = makePage();
    m2.html.setAttribute("data-duration", "4");
    m2.el("audio");
    const meta2 = m2.ctx.__owb_meta();
    eq([meta2.bodyDuration, meta2.poster, meta2.hasAudio], [4, null, true], "body 没写时长就看 html；页面里有 <audio> 也算用了声音");
    const m3 = makePage();
    m3.body.setAttribute("data-poster", "-1");
    fakeVideo(m3, { muted: "" }, { muted: true });
    const meta3 = m3.ctx.__owb_meta();
    eq([meta3.bodyDuration, meta3.poster, meta3.hasAudio], [null, null, false], "静音视频不算声音；负的封面秒数不算");
    const m4 = makePage();
    fakeVideo(m4, {}, {});
    eq(m4.ctx.__owb_meta().hasAudio, true, "没静音的视频算用了声音");

    const sp = makePage();
    sp.run(`var u = { fired: 0, dispatchEvent(e) { if (e.type === "end") this.fired++; } }; speechSynthesis.speak(u);`);
    await sp.step(0);
    eq(sp.realLog, [], "页面调系统朗读：拦下来，不从音箱念出来");
    eq(sp.ctx.u.fired, 1, "假装念完了，发 end 事件，等 onend 的页面不会卡住");
    eq(sp.ctx.__owb_meta().hasAudio, true, "记成用了声音");

    const y = makePage();
    const styles = () => y.head.children.filter((c) => c.hasAttribute("data-owb-clock"));
    await y.steps([0, 10, 20]);
    y.docFire("DOMContentLoaded");
    eq(styles().length, 1, "藏片段/滚动条的样式只插一份");
    ok(styles()[0].textContent.includes("[data-owb-off]{display:none!important}"), "藏片段靠 display:none");
    styles()[0].remove();
    await y.step(30);
    eq(styles().length, 1, "页面把 <head> 换掉了：下一帧补回来");
  }

  console.log("【7】帧时间表、画幅、帧率、时长");
  {
    const t = M.frameTimes({ fps: 30, duration: 1 });
    eq([t.length, t[0], t[29]], [30, 0, (29 * 1000) / 30], "30fps 一秒 30 帧，第 29 帧恰好是 29*1000/30");
    const long = M.frameTimes({ fps: 60, duration: 120 });
    eq(long.length, 7200, "60fps 两分钟 7200 帧");
    ok(long.every((x, i) => x === (i * 1000) / 60), "每一帧都是乘出来的，两分钟后也不漂");
    let acc = 0, drift = 0;
    for (let i = 0; i < 7200; i++) { if (acc !== (i * 1000) / 60) drift++; acc += 1000 / 60; }
    ok(drift > 1000, "反向检查：累加的话会有上千帧对不上（所以才用乘法）", drift);
    eq(M.frameTimes({ fps: 30, duration: 0 }), [], "时长 0 没有帧");
    eq(M.framesFor(2.5, 30), 75, "2.5 秒 30fps 是 75 帧");

    eq(M.resolveSize({}), { width: 1080, height: 1920 }, "默认竖屏 9:16");
    eq(M.resolveSize({ aspect: "3:4" }), { width: 1080, height: 1440 }, "3:4 是 1080×1440");
    eq(M.resolveSize({ aspect: "16x9" }), { width: 1920, height: 1080 }, "16x9 也认");
    eq(M.resolveSize({ aspect: "1：1" }), { width: 1080, height: 1080 }, "全角冒号也认");
    eq(M.resolveSize({ aspect: "16/9" }), { width: 1920, height: 1080 }, "斜杠也认");
    eq(M.resolveSize({ width: 1081, height: 1921 }), { width: 1080, height: 1920 }, "奇数宽高向下取偶（yuv420p 要偶数）");
    eq(M.resolveSize({ width: 100, height: 5000 }), { width: 160, height: 3840 }, "超范围的夹到 160..3840");
    eq(M.resolveSize({ aspect: "9:16", width: 720 }), { width: 720, height: 1280 }, "只给宽：按画幅推高");
    eq(M.resolveSize({ aspect: "16:9", height: 721 }), { width: 1280, height: 720 }, "只给高：按画幅推宽，都取偶");
    eq(M.resolveSize({ aspect: "bogus", width: "1080", height: "1350" }), { width: 1080, height: 1350 }, "宽高都给了就不看画幅");
    let err = null;
    try { M.resolveSize({ aspect: "4:3" }); } catch (e) { err = e; }
    ok(err && ["9:16", "16:9", "1:1", "3:4"].every((a) => err.message.includes(a)), "不认识的画幅报错，并列出能用的四种", err && err.message);
    eq(Object.isFrozen(M.ASPECTS) && Object.isFrozen(M.ASPECTS["9:16"]), true, "画幅表冻住，别人改不动");

    eq([M.clampFps(), M.clampFps(0), M.clampFps("24"), M.clampFps(5), M.clampFps(120), M.clampFps(29.97), M.clampFps(NaN), M.clampFps(-5)],
      [30, 30, 24, 12, 60, 30, 30, 30], "帧率取整夹到 12..60，没给/乱给是 30");

    eq(M.durationFrom({ explicit: 3, meta: { bodyDuration: 5 } }), 3, "显式给的时长优先");
    eq(M.durationFrom({ explicit: null, meta: { bodyDuration: 5, clips: [{ start: 1, duration: 10 }] } }), 5, "其次 body 的 data-duration");
    eq(M.durationFrom({ meta: { bodyDuration: null, clips: [{ start: 1, duration: 2 }, { start: 0.5, duration: 1 }] } }), 3, "再次各片段结束时刻的最大值");
    eq([M.durationFrom({ meta: { clips: [] } }), M.durationFrom({}), M.durationFrom({ explicit: 0, meta: null })], [null, null, null], "都没有就是 null");
    eq(M.durationFrom({ explicit: "2.5" }), 2.5, "字符串数字也认");

    const thr = (fn) => { try { fn(); return ""; } catch (e) { return e.message; } };
    ok(/不知道要渲多长/.test(thr(() => M.checkDuration(null))), "没有时长：告诉怎么补");
    ok(thr(() => M.checkDuration(null, "a.html")).startsWith("a.html "), "报错带上是哪个文件");
    ok(/超出范围/.test(thr(() => M.checkDuration(0.4))) && /超出范围/.test(thr(() => M.checkDuration(121))), "0.5–120 秒之外报超出范围");
    eq([M.checkDuration(0.5), M.checkDuration(120)], [0.5, 120], "边界值放行");

    eq(j(M.planShots([2, 1.5], 30)), {
      segments: [
        { index: 0, start: 0, duration: 2, frames: 60, firstFrame: 0 },
        { index: 1, start: 2, duration: 1.5, frames: 45, firstFrame: 60 },
      ],
      totalFrames: 105, duration: 3.5,
    }, "多段：每段帧数、在成片里的起点和首帧号");
    eq(M.planShots([120], 60).totalFrames, 7200, "正好 7200 帧放行");
    ok(/7260 帧/.test(thr(() => M.planShots([120, 1], 60))), "超过 7200 帧：报一共多少帧，让拆开渲");
  }

  console.log("【8】ffmpeg 参数、编码器、缺 ffmpeg 的话");
  {
    const at = (args, flag) => args[args.indexOf(flag) + 1];
    const a = M.ffmpegArgs({ width: 1080, height: 1920, fps: 30, out: "/o/x.mp4" });
    eq(a.slice(0, 4), ["-y", "-hide_banner", "-loglevel", "error"], "开头：覆盖、少说话");
    eq([at(a, "-f"), at(a, "-pixel_format"), at(a, "-video_size"), at(a, "-framerate"), at(a, "-i")], ["rawvideo", "bgra", "1080x1920", "30", "pipe:0"], "默认吃 BGRA 原始像素，尺寸写明");
    eq([at(a, "-c:v"), at(a, "-pix_fmt"), at(a, "-crf"), at(a, "-movflags")], ["libx264", "yuv420p", "18", "+faststart"], "libx264 + yuv420p + crf 18 + faststart");
    eq([at(a, "-colorspace"), at(a, "-color_primaries"), at(a, "-color_trc")], ["bt709", "bt709", "bt709"], "bt709 标签都打上");
    ok(at(a, "-vf").startsWith("scale=1080:1920:") && at(a, "-vf").includes("out_color_matrix=bt709"), "先缩到目标尺寸、按 bt709 转色", at(a, "-vf"));
    ok(/setparams=.*color_primaries=bt709.*color_trc=bt709/.test(at(a, "-vf")), "滤镜链里也打上 bt709 标签（ffmpeg 8 只认帧上的）", at(a, "-vf"));
    ok(a.includes("-an") && a[a.length - 1] === "/o/x.mp4", "无声，输出放最后");
    const pn = M.ffmpegArgs({ input: "png", width: 64, height: 48, fps: 24, out: "o.mp4", crf: 23 });
    eq([at(pn, "-f"), at(pn, "-c:v"), at(pn, "-framerate"), at(pn, "-crf")], ["image2pipe", "png", "24", "23"], "png 模式走 image2pipe；crf 可以改");
    ok(!pn.includes("-video_size") && pn.indexOf("-c:v") < pn.indexOf("-i"), "png 模式不写死输入尺寸，解码器写在 -i 前面");
    eq(M.encoderProbeArgs(), ["-hide_banner", "-encoders"], "列编码器的参数");

    const text = [
      "Encoders:",
      " V..... = Video",
      " A..... = Audio",
      " S..... = Subtitle",
      " ------",
      " V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)",
      " V....D h264_videotoolbox    VideoToolbox H.264 Encoder (codec h264)",
      " A....D aac                  AAC (Advanced Audio Coding)",
    ].join("\n");
    const enc = M.parseEncoders(text);
    eq([...enc].sort(), ["aac", "h264_videotoolbox", "libx264"], "从 -encoders 输出里挑出编码器名，表头不算");
    eq(M.parseEncoders(text.replace(/.*libx264.*\n/, "")).has("libx264"), false, "反向检查：没有 libx264 那行就认不出来");
    eq(M.parseEncoders("").size, 0, "空输出就是空集");

    const nf = M.noFfmpegMessage("sudo apt install ffmpeg");
    ok(nf.includes("sudo apt install ffmpeg") && nf.includes("HTML 不用改"), "缺 ffmpeg：说装什么、装好后 HTML 不用改", nf);
    ok(M.noFfmpegMessage().includes("brew install ffmpeg"), "没给安装命令就说 brew");
    ok(M.noX264Message("brew install ffmpeg").includes("libx264"), "缺 libx264 如实说");
  }

  console.log("【9】帧指纹、自查提醒、进度");
  {
    const s = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    eq(M.frameHash(s), M.frameHash(Buffer.from(s)), "同样的字节同样的指纹");
    ok(M.frameHash(s) !== M.frameHash(Buffer.from([1, 2, 3, 4, 5, 6, 7, 9])), "差一个字节就不同");
    ok(M.frameHash(Buffer.alloc(16)) !== M.frameHash(Buffer.alloc(20)), "尺寸不同的帧不会撞");
    ok(M.frameHash(new Uint8Array(s)) === M.frameHash(s), "Uint8Array 和 Buffer 一样算");

    const W = 1080, H = 1920;
    const big = Buffer.alloc(W * H * 4, 7);
    const stats = M.createFrameStats();
    eq(stats.add(big).isNew, true, "第一帧是新的");
    const patched = Buffer.from(big);
    for (let y = 900; y < 916; y++) for (let x = 500; x < 516; x++) patched.fill(255, (y * W + x) * 4, (y * W + x) * 4 + 4);
    eq(stats.add(patched).isNew, true, "8MB 的大图抽样算：中间 16×16 的小块变了也认得出");
    eq(stats.add(Buffer.from(big)).isNew, false, "和第一帧一样的不算新");
    const tail = Buffer.from(big); tail.fill(255, tail.length - 32);
    eq(stats.add(tail).isNew, true, "最后 8 个像素变了也认得出（按比例抽，末尾抽得到）");
    eq([stats.count(), stats.frames()], [3, 4], "一共 4 帧、3 种");

    const one = { name: "a.html", meta: { scrollW: 1080, scrollH: 1920, hasAudio: false } };
    eq(M.motionWarnings({ frames: 30, distinct: 1, width: 1080, height: 1920, shots: [one] }), ["所有帧一模一样：页面没动起来"], "所有帧一样：页面没动");
    eq(M.motionWarnings({ frames: 1, distinct: 1, width: 1080, height: 1920, shots: [one] }), [], "只有一帧不算没动");
    eq(M.motionWarnings({ frames: 30, distinct: 5, width: 1080, height: 1920, shots: [{ meta: { scrollW: 1081, scrollH: 1920 } }] }), [], "多 1px 是亚像素排版，不算溢出");
    eq(M.motionWarnings({ frames: 30, distinct: 5, width: 1080, height: 1920, shots: [{ meta: { scrollW: 1082, scrollH: 1920 } }] }),
      ["页面比画幅大会被裁：body 改成 100vw×100vh 才能换画幅重渲"], "页面比画幅大：提醒改成 100vw×100vh");
    const multi = M.motionWarnings({
      frames: 60, distinct: 1, width: 1080, height: 1920,
      shots: [
        { name: "a.html", meta: { scrollW: 1200, scrollH: 1920, hasAudio: true }, errors: ["e1", "e2"], warnings: ["w1"] },
        { name: "b.html", meta: { scrollW: 1080, scrollH: 2000 }, errors: ["e3", "e4"], warnings: ["w1", "w2"] },
      ],
    });
    eq(multi, [
      "所有帧一模一样：页面没动起来",
      "页面比画幅大会被裁：body 改成 100vw×100vh 才能换画幅重渲（a.html、b.html）",
      "成片没有声音，配乐/配音在合成那步加",
      "页面报错：e1（a.html）", "页面报错：e2（a.html）", "页面报错：e3（b.html）",
      "w1", "w2",
    ], "多段：带上是哪几段；页面报错只报前 3 条；同样的提醒只报一次");

    eq(M.progressLabel({ stage: "load", shot: 2, shots: 3 }), "载入第 2/3 段", "载入：多段说第几段");
    eq(M.progressLabel({ stage: "load", shot: 1, shots: 1 }), "载入页面", "载入：一段就说载入页面");
    eq(M.progressLabel({ stage: "render", done: 432, total: 900 }), "渲染帧 432/900", "渲染：第几帧");
    eq(M.progressLabel({ stage: "render", done: 432, total: 900, shot: 2, shots: 3, speed: 20 }), "渲染帧 432/900 · 第 2/3 段 · 约剩 24 秒", "渲染：多段 + 剩余时间");
    eq(M.progressLabel({ stage: "render", done: 432, total: 900, speed: 1 }), "渲染帧 432/900 · 约剩 8 分钟", "剩得久就说分钟");
    eq([M.progressLabel({ stage: "encode", pct: 42.4 }), M.progressLabel({ stage: "encode" })], ["编码 42%", "编码收尾"], "编码：百分比，没有就说收尾");
    const labels = [
      M.progressLabel({ stage: "render", done: 7200, total: 7200, shot: 30, shots: 30, speed: 0.01 }),
      M.progressLabel({ stage: "load", shot: 30, shots: 30 }),
    ];
    ok(labels.every((l) => M.displayWidth(l) <= 48), "进度标签不超过 24 个汉字宽", JSON.stringify(labels));
    const longS = "渲染".repeat(40);
    const fitted = M.fitLabel(longS);
    ok(M.displayWidth(fitted) <= 48 && fitted.endsWith("…"), "太长的截断加省略号", fitted);
    eq(M.fitLabel("短"), "短", "短的原样");
    eq(M.displayWidth("中a"), 3, "汉字算 2 格");

    eq(M.progressEvent({ stage: "render", done: 5, total: 10, shot: 1, shots: 1 }), { stage: "render", label: "渲染帧 5/10", done: 5, total: 10, pct: 50 }, "进度事件是 contracts A 的形状，不多带字段");
    eq(M.progressEvent({ stage: "render", done: 15, total: 10 }).done, 10, "done 不超过 total");
    eq(M.progressEvent({ stage: "encode", pct: 42.4 }), { stage: "encode", label: "编码 42%", pct: 42 }, "只有百分比的事件");

    let now = 0;
    const got = [];
    const emit = M.progressThrottle((p) => got.push(p.done), { now: () => now });
    const ev = (d) => M.progressEvent({ stage: "render", done: d, total: 10 });
    const sent = [];
    sent.push(emit(ev(1)));
    now = 100; sent.push(emit(ev(2)));
    now = 399; sent.push(emit(ev(3)));
    now = 450; sent.push(emit(ev(4)));
    now = 500; sent.push(emit(ev(10)));
    now = 510; sent.push(emit(ev(5), { final: true }));
    eq([got, sent], [[1, 4, 10, 5], [true, false, false, true, true, true]], "400ms 内最多一条；做完的那条、标了 final 的一定发");
    let threw = false;
    const boom = M.progressThrottle(() => { throw new Error("ui 坏了"); });
    try { ok(boom(ev(1)) === true, "回调抛错也算发了"); } catch { threw = true; }
    ok(!threw, "进度回调抛错被吞掉，不拖垮出片");
    eq(M.progressThrottle(null)(ev(1)), false, "没有回调就什么都不做");
    const encGot = [];
    let n2 = 0;
    const encEmit = M.progressThrottle((p) => encGot.push(p.pct), { now: () => n2 });
    encEmit(M.progressEvent({ stage: "encode", pct: 10 }));
    n2 = 10; encEmit(M.progressEvent({ stage: "encode", pct: 100 }));
    eq(encGot, [10, 100], "编码到 100% 那条一定发");
  }

  console.log("【10】小工具：临时文件、预算、静帧、封面、表达式、看门狗、Chrome 参数、脚本本身");
  {
    eq([M.partPath("/a/b/out.mp4"), M.partPath("/a/b.dir/out"), M.partPath("x.tar.mp4")], ["/a/b/out.part.mp4", "/a/b.dir/out.part", "x.tar.part.mp4"], "临时文件名：扩展名前插 .part");
    const now = 1_000_000;
    eq([M.budgetMs(null, now), M.budgetMs(0, now), M.budgetMs(now + 60000, now), M.budgetMs(now + 1000, now)],
      [20 * 60 * 1000, 20 * 60 * 1000, 50000, 5000], "预算：留 10 秒收尾、最少 5 秒；没有截止时间给 20 分钟");

    eq(M.stillFrames({ stills: 1, totalFrames: 100 }), [40], "一张静帧取 40% 处");
    eq(M.stillFrames({ stills: 3, totalFrames: 100 }), [40, 79, 15], "三张：40%、80%、15%");
    eq(M.stillFrames({ stills: 3, totalFrames: 100, poster: 10 }), [10, 79, 15], "有封面帧就先放封面");
    eq(M.stillFrames({ stills: 9, totalFrames: 100 }).length, 3, "最多 3 张");
    eq([M.stillFrames({ stills: 0, totalFrames: 100 }), M.stillFrames({ stills: 3, totalFrames: 1 }), M.stillFrames({ stills: 3, totalFrames: 2 })], [[], [0], [0, 1]], "不要静帧、帧太少时去重");
    eq(M.stillFrames({ stills: 1, totalFrames: 10, poster: 99 }), [9], "封面帧超出就夹到最后一帧");

    const plan = M.planShots([2, 1.5], 30);
    eq(M.posterFrame({ segments: plan.segments, metas: [{ poster: null }, { poster: 0.5 }], fps: 30 }), 75, "第二段写了封面 0.5 秒：成片第 75 帧");
    eq(M.posterFrame({ segments: plan.segments, metas: [{ poster: 1 }, { poster: 0.5 }], fps: 30 }), 30, "取第一个写了封面的段");
    eq(M.posterFrame({ segments: plan.segments, metas: [{ poster: 99 }], fps: 30 }), 59, "封面秒数超出这段就夹到段尾");
    eq(M.posterFrame({ segments: plan.segments, metas: [{ poster: -1 }, null], fps: 30 }), null, "都没写就是 null");

    const expr = M.stepExpr(1000 / 30);
    eq(expr, "__owb_step(33.333333333333336)", "每帧执行的表达式");
    eq(vm.runInNewContext(expr, { __owb_step: (x) => x }), 1000 / 30, "表达式里的数字原样还原，一个 ulp 都不差");
    eq(M.stallMessage(0), "第 1 帧卡了 10 秒没画完：页面脚本可能在死循环", "看门狗的话：第几帧从 1 数");
    ok(M.CHROME_EXTRA_ARGS.includes("--force-device-scale-factor=1") && Object.isFrozen(M.CHROME_EXTRA_ARGS), "无头 Chrome 钉 1 倍像素，参数表冻住");
    ok(M.CHROME_EXTRA_ARGS.includes("--disable-background-timer-throttling"), "后台节流关掉");

    const modSrc = fs.readFileSync(path.join(__dirname, "..", "motion-clock.js"), "utf8");
    ok(!/require\(\s*["']electron["']\s*\)/.test(modSrc), "motion-clock.js 不碰 Electron");
    ok(!Object.keys(require.cache).some((k) => /[\\/]node_modules[\\/]electron[\\/]/.test(k)), "加载它不会顺带加载 Electron");
    const src = M.runtimeSource();
    let compiled = true;
    try { new vm.Script(src); } catch { compiled = false; }
    ok(compiled, "注入脚本能编译");
    ok(src.includes('"seed":1') && src.includes(`"epoch":${EPOCH}`), "默认 seed 1、起点 2026-01-01");
    ok(M.runtimeSource({ seed: 7.9 }).includes('"seed":7') && M.runtimeSource({ seed: -1 }).includes('"seed":4294967295'), "seed 取整成无符号 32 位");
    ok(src.includes(`"flood":${M.TIMER_FLOOD}`) && src.includes(M.FLOOD_MESSAGE), "护栏数值和报错是同一份");
  }

  console.log("【11】真 ffmpeg：编出来是 h264/yuv420p/bt709，颜色通道没反，2 倍图被缩回来");
  {
    if (typeof MP.reset === "function") MP.reset();
    const bins = await MP.resolveMediaBins();
    const ff = bins.ffmpeg && bins.ffmpeg.bin, fp = bins.ffprobe && bins.ffprobe.bin;
    const must = process.env.OWB_REQUIRE_FFMPEG === "1";
    const encoders = ff ? M.parseEncoders(spawnSync(ff, M.encoderProbeArgs(), { encoding: "utf8", timeout: 30000 }).stdout) : new Set();
    if (!ff || !fp) {
      if (must) ok(false, "OWB_REQUIRE_FFMPEG=1 却找不到 ffmpeg/ffprobe", JSON.stringify(bins));
      else console.log("    跳过：本机没有 ffmpeg");
    } else if (!encoders.has("libx264")) {
      if (must) ok(false, "OWB_REQUIRE_FFMPEG=1 但这台 ffmpeg 没带 libx264");
      else console.log("    跳过：这台 ffmpeg 没带 libx264");
    } else {
      const W = 64, H = 48;
      const bgra = ([r, g, b]) => { const buf = Buffer.alloc(W * H * 4); for (let i = 0; i < W * H; i++) { buf[i * 4] = b; buf[i * 4 + 1] = g; buf[i * 4 + 2] = r; buf[i * 4 + 3] = 255; } return buf; };
      const encode = (input, frames, out, size = { width: W, height: H }) =>
        spawnSync(ff, M.ffmpegArgs({ input, ...size, fps: 30, out }), { input: Buffer.concat(frames), timeout: 60000, maxBuffer: 16 << 20 });
      const probe = (file) => {
        const r = spawnSync(fp, ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries",
          "stream=codec_name,pix_fmt,width,height,avg_frame_rate,nb_read_frames,color_range,color_space,color_transfer,color_primaries", "-of", "json", file], { encoding: "utf8", timeout: 30000 });
        try { return JSON.parse(r.stdout).streams[0]; } catch { return { err: r.stderr }; }
      };
      const center = (file) => {
        const r = spawnSync(ff, ["-v", "error", "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { timeout: 30000, maxBuffer: 16 << 20 });
        const o = ((H / 2) * W + W / 2) * 3;
        return { len: r.stdout.length, rgb: [r.stdout[o], r.stdout[o + 1], r.stdout[o + 2]] };
      };
      const isRed = ([r, g, b]) => r > 200 && g < 60 && b < 60;

      const red = path.join(TMP, "red.mp4");
      const e1 = encode("bgra", [bgra([255, 0, 0]), bgra([255, 0, 0]), bgra([255, 0, 0])], red);
      ok(e1.status === 0, "BGRA 三帧编成 mp4", String(e1.stderr || e1.error || ""));
      const st = probe(red);
      eq({ codec: st.codec_name, pix: st.pix_fmt, w: st.width, h: st.height, fps: st.avg_frame_rate, n: st.nb_read_frames, range: st.color_range, space: st.color_space, trc: st.color_transfer, prim: st.color_primaries },
        { codec: "h264", pix: "yuv420p", w: W, h: H, fps: "30/1", n: "3", range: "tv", space: "bt709", trc: "bt709", prim: "bt709" }, "h264 + yuv420p + 30fps + 3 帧 + tv 范围 + bt709 三件套");
      const c1 = center(red);
      eq(c1.len, W * H * 3, "解出来尺寸对");
      ok(isRed(c1.rgb), "红进红出", JSON.stringify(c1.rgb));

      // 反向检查：按 RGBA 顺序喂进去（通道弄反的典型错误），解出来就不是红的
      const swap = path.join(TMP, "swap.mp4");
      const rgba = Buffer.alloc(W * H * 4);
      for (let i = 0; i < W * H; i++) { rgba[i * 4] = 255; rgba[i * 4 + 3] = 255; }
      const e2 = encode("bgra", [rgba], swap);
      ok(e2.status === 0, "RGBA 顺序的帧也编得出来", String(e2.stderr || ""));
      const c2 = center(swap);
      ok(!isRed(c2.rgb) && c2.rgb[2] > 200, "反向检查：通道弄反会变成蓝的，所以上面的红进红出是有效断言", JSON.stringify(c2.rgb));

      const png = path.join(TMP, "png.mp4");
      const p2x = solidPng(W * 2, H * 2, [255, 0, 0]);
      const e3 = encode("png", [p2x, p2x], png);
      ok(e3.status === 0, "PNG 两帧编成 mp4", String(e3.stderr || ""));
      const st3 = probe(png);
      eq([st3.width, st3.height, st3.nb_read_frames], [W, H, "2"], "2 倍图（Retina 截图）被缩回目标尺寸");
      ok(isRed(center(png).rgb), "PNG 那条颜色也对");

      const left = fs.readdirSync(TMP).filter((n) => !["red.mp4", "swap.mp4", "png.mp4", "home"].includes(n));
      eq(left, [], "临时目录里没有多出别的文件");
    }
  }

  // 【12】起是执行层和工具层（htmlvideo.js、src/tools/motion.js），函数写在文件末尾
  await executorTests();
  // 【16】起是接线：从 tools.executeTool / 智能体的工具清单进去，也在文件末尾
  await wiringTests();

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? "√" : "×"} motion：${pass} 条通过，${fail} 条失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error("套件自己挂了：", e);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(1);
});

/* ───────────── 执行层与工具层：htmlvideo.js、src/tools/motion.js ─────────────
 * 上面十一段钉的是纯逻辑，下面四段钉的是把它接到浏览器和 ffmpeg 上的那一层：
 * 【12】render_motion 工具：开浏览器之前查得出的错当场回、一帧都不渲；回执、静帧、改名照约定走；
 * 【13】html_to_image 批量：文件名跟 HTML 走、撞名接 _2、一张坏了不拖累别的、最后一条进度是收尾；
 * 【14】无头 Chrome 那条路对着假 DevTools + 假 ffmpeg：命令顺序、每帧先推时钟再截图、
 *      停止 / ffmpeg 半路死掉 / 页面脚本抛错都不留半截文件，浏览器一定收走；
 * 【15】真无头 Chrome + 真 ffmpeg：同一页渲两次逐帧一致，解出来的像素对得上时间轴（本机没有就跳过）。
 * 桌面版那条路（离屏窗口）在 test/motion-render.js，要在 Electron 里才跑得起来。
 */
async function executorTests() {
  const http = require("http");
  const crypto = require("crypto");
  const { pathToFileURL, fileURLToPath } = require("url");
  const media = require("../src/tools/media");
  const security = require("../security");
  const TM = require("../src/tools/motion");
  const HV = require("../htmlvideo");
  const ORIG = { ...HV._internals };
  const envBackend = process.env.OWB_MOTION_BACKEND;
  const restoreEnv = () => { if (envBackend === undefined) delete process.env.OWB_MOTION_BACKEND; else process.env.OWB_MOTION_BACKEND = envBackend; };

  const WS = path.join(TMP, "ws");
  const OUT = path.join(WS, "out");
  fs.mkdirSync(OUT, { recursive: true });
  media.bindWorkspace(() => WS, () => fs.mkdirSync(WS, { recursive: true }));
  // 和 tools.js 的 resolveFile 一个口径：越出工作空间就抛
  const resolveFile = (rel) => {
    const abs = path.resolve(WS, String(rel));
    if (!abs.startsWith(WS + path.sep)) throw new Error(`路径越出工作空间：${rel}`);
    return abs;
  };
  const put = (rel, text = '<!doctype html><body data-duration="1"></body>') => {
    const f = path.join(WS, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
    return f;
  };
  const slash = (p) => p.split(path.sep).join("/");
  put("a.html"); put("b.html"); put("notes.txt", "不是网页");

  console.log("【12】render_motion：开浏览器之前查得出的错当场回、一帧都不渲；回执、静帧、改名");
  {
    const calls = { ff: 0, render: /** @type {any[]} */ ([]) };
    let avail, ffRes, renderImpl;
    const reset = () => {
      calls.ff = 0; calls.render = [];
      avail = { ok: true, backend: "chrome", why: "" };
      ffRes = { ok: true, bin: "ffmpeg", why: "" };
      renderImpl = null;
    };
    // 假执行层：每段 1 秒 30 帧，要几张静帧给几张
    const fakeResult = (files, o) => ({
      file: o.out, frames: 30 * files.length, duration: files.length, width: o.width, height: o.height, fps: o.fps, backend: "chrome",
      segments: files.map((_, i) => ({ index: i, start: i, firstFrame: i * 30, frames: 30 })),
      warnings: [], distinctFrames: 30, metas: [],
      stills: [{ frame: 11, png: solidPng(2, 2, [255, 0, 0]) }, { frame: 23, png: solidPng(2, 2, [0, 255, 0]) }].slice(0, o.stills),
    });
    const deps = {
      available: () => avail,
      prepareFfmpeg: async () => { calls.ff++; return ffRes; },
      render: async (files, o) => { calls.render.push({ files, o }); return renderImpl ? renderImpl(files, o) : fakeResult(files, o); },
    };
    const run = (input, saveDir = OUT, ctx = {}) => TM.renderMotionTool(input, resolveFile, saveDir, { deps, ...ctx });

    const early = [
      [{}, /^缺少 html_file/, "没给 HTML"],
      [{ html_file: "../outside.html" }, /^路径越出工作空间/, "工作空间外的路径"],
      [{ html_file: "notes.txt" }, /^只能渲 \.html 文件：notes\.txt$/, "不是 .html"],
      [{ html_file: "nope.html" }, /^文件不存在：nope\.html/, "文件不存在"],
      [{ html_files: Array.from({ length: 31 }, () => "a.html") }, /一次最多 30 个 HTML，这次给了 31 个/, "超过 30 个"],
      [{ html_files: ["a.html", " "] }, /空路径/, "有空路径"],
      [{ html_files: ["a.html", "b.html"], durations: [2] }, /^durations 给了 1 个，HTML 有 2 个/, "durations 和文件数对不上"],
      [{ html_file: "a.html", duration: 500 }, /超出范围/, "时长超范围"],
      [{ html_files: ["a.html", "b.html"], durations: [120, 120], fps: 60 }, /超过单次上限/, "总帧数超上限"],
      [{ html_file: "a.html", aspect: "7:3" }, /^画幅只能是/, "画幅不认识"],
    ];
    for (const [input, re, what] of early) {
      reset();
      const r = await run(input);
      ok(r.isError === true && re.test(r.content), `${what}：当场报错`, r.content);
      ok(calls.ff === 0 && calls.render.length === 0, `${what}：没去找 ffmpeg，更没开渲`);
    }

    reset();
    avail = { ok: false, backend: "", why: HV.NO_BROWSER };
    let r = await run({ html_file: "a.html" });
    ok(r.isError && r.content === HV.NO_BROWSER, "没有浏览器：原话回给模型（用桌面版或装 Chrome）", r.content);
    ok(calls.ff === 0 && calls.render.length === 0, "没有浏览器：不找 ffmpeg、不开渲");

    reset();
    ffRes = { ok: false, bin: "", why: M.noFfmpegMessage("brew install ffmpeg") };
    r = await run({ html_file: "a.html" });
    ok(r.isError && r.content === M.noFfmpegMessage("brew install ffmpeg"), "没有 ffmpeg：说清楚装什么", r.content);
    eq(calls.render.length, 0, "没有 ffmpeg：一帧都不渲");
    reset();
    ffRes = { ok: false, bin: "/x/ffmpeg", why: M.noX264Message("") };
    r = await run({ html_file: "a.html" });
    ok(r.isError && r.content === M.noX264Message("") && calls.render.length === 0, "ffmpeg 没带 libx264：如实说、不渲", r.content);

    reset();
    const onProgress = () => {};
    r = await run({ html_file: "a.html", filename: "clip.webm", duration: 1 }, OUT, { onProgress, deadline: 123456 });
    const c0 = calls.render[0] || { files: [], o: {} };
    ok(!r.isError, "单个 HTML 出片成功", r.content);
    eq(c0.files, [{ path: path.join(WS, "a.html"), duration: 1, name: "a.html" }], "交给执行层的是绝对路径 + 时长 + 相对名");
    eq([c0.o.out, c0.o.width, c0.o.height, c0.o.fps, c0.o.stills, c0.o.seed], [path.join(OUT, "clip.mp4"), 1080, 1920, 30, 1, undefined],
      "默认竖屏 1080x1920、30 帧、落一张封面、seed 交给执行层定");
    ok(c0.o.onProgress === onProgress && c0.o.deadline === 123456, "进度回调和截止时间原样递下去");
    eq([r.file, r.files], ["clip.mp4", ["clip.mp4", "clip_poster.png"]], ".webm 改成 .mp4，封面跟着成片名走");
    let lines = String(r.content).split("\n");
    eq(lines[0], "已把 1 个 HTML 渲成视频：out/clip.mp4（1080x1920，30 帧/秒，1 秒，30 帧）", "回执第一行：落在哪个子目录、多大、多长");
    ok(lines.includes("封面：out/clip_poster.png（第 12 帧）。交付前用 look_at_image 看一眼"), "回执里有封面和自查提醒", r.content);
    ok(lines.includes("注意：文件名改成了 clip.mp4：这里只出 H.264 的 mp4"), "改了名要说", r.content);
    ok(!/各段起点/.test(r.content), "单段不报各段起点");
    ok(fs.readFileSync(path.join(OUT, "clip_poster.png")).equals(solidPng(2, 2, [255, 0, 0])), "封面 PNG 原样落盘");
    eq(r.meta && r.meta.stills, [{ file: "clip_poster.png", frame: 11 }], "meta 里记着封面是第几帧");
    const au = security.auditList(5).find((a) => a.type === "HTML动画");
    ok(!!au && au.text === "a.html → clip.mp4", "审计记一条：哪些 HTML 渲成了哪个文件", JSON.stringify(au));

    reset();
    r = await run({ html_files: ["a.html", "b.html"], durations: [1, ""], stills: 2, filename: "片头.mov", seed: 7, fps: 24, aspect: "16:9" });
    const c1 = calls.render[0] || { files: [], o: {} };
    eq(c1.files.map((f) => f.duration), [1, undefined], "durations 里空着的那段交给页面自己说（data-duration）");
    eq([c1.o.seed, c1.o.fps, c1.o.width, c1.o.height, c1.o.stills], [7, 24, 1920, 1080, 2], "seed、帧率、画幅、静帧张数原样递下去");
    eq(r.files, ["片头.mov", "片头_poster.png", "片头_still2.png"], ".mov 保留；第二张静帧叫 _still2");
    lines = String(r.content).split("\n");
    eq(lines[0], "已把 2 个 HTML 渲成视频：out/片头.mov（1920x1080，24 帧/秒，2 秒，60 帧）", "多段的回执第一行");
    ok(lines.includes("各段起点：a.html 0s，b.html 1s"), "多段要报各段起点（配字幕、配音对时间用）", r.content);
    ok(r.content.includes("另有 out/片头_still2.png") && !/文件名改成了/.test(r.content), "另一张静帧也报；.mov 不算改名", r.content);

    reset();
    renderImpl = (files, o) => ({ ...fakeResult(files, o), warnings: ["所有帧一模一样：页面没动起来"] });
    r = await run({ html_file: "a.html", stills: 0, filename: "w.mp4" });
    ok(!r.isError && String(r.content).split("\n").includes("注意：所有帧一模一样：页面没动起来"), "执行层的提醒原样带给模型", r.content);
    eq(r.files, ["w.mp4"], "stills=0：不落静帧");
    ok(!/封面/.test(r.content), "stills=0：回执不提封面");

    reset();
    renderImpl = () => { throw Object.assign(new Error("用户已停止任务：视频没渲完，半截文件已删"), { stopped: true }); };
    r = await run({ html_file: "a.html" });
    ok(r.isError && r.stopped === true && /^用户已停止任务/.test(r.content), "停止：回「已停止」，带 stopped 标记", JSON.stringify(r));
    reset();
    const ac = new AbortController();
    ac.abort();
    renderImpl = () => { throw new Error("连接已关闭"); };
    r = await run({ html_file: "a.html" }, OUT, { signal: ac.signal });
    ok(r.stopped === true, "已经点了停止时，底下冒出来的别的错也按停止算", JSON.stringify(r));
    reset();
    renderImpl = () => { throw new Error("ffmpeg 中途退出：No space left on device"); };
    r = await run({ html_file: "a.html" });
    ok(r.isError && !r.stopped && r.content === "HTML 动画出片失败：ffmpeg 中途退出：No space left on device", "别的错：前面说清是出片这一步失败", r.content);

    reset();
    r = await run({ html_file: "a.html", stills: 0 }, "");
    eq(calls.render[0] && path.dirname(calls.render[0].o.out), WS, "没给落盘目录：放在 HTML 旁边");
    ok(/^motion_.+\.mp4$/.test(String(r.file)), "没给文件名：motion_时间戳.mp4", r.file);
  }

  console.log("【13】html_to_image 批量：名字跟 HTML 走、撞名接 _2、一张坏了不拖累别的、最后一条进度是收尾");
  {
    // 真截图要开 Electron 窗口，这里拿替身顶掉：media.js 是用到时才 require("../../htmlshot")，先占住缓存就换得掉
    const shotPath = require.resolve("../htmlshot");
    const prevShot = require.cache[shotPath];
    /** @type {Array<{ p: string, o: any }>} */
    const shots = [];
    const BLUE = solidPng(2, 2, [0, 0, 255]);
    require.cache[shotPath] = /** @type {any} */ ({
      id: shotPath, filename: shotPath, loaded: true, children: [], paths: [],
      exports: {
        renderHtmlToPng: async (p, o) => {
          shots.push({ p, o });
          if (/bad/.test(path.basename(p))) throw new Error("页面坏了");
          return BLUE;
        },
      },
    });
    try {
      put("cards/01.html"); put("cards/02.html"); put("other/01.html"); put("cards/bad.html");
      const B = path.join(OUT, "batch");
      fs.mkdirSync(B, { recursive: true });
      const shot = (input, ctx) => TM.htmlToImageBatch(input, resolveFile, B, ctx);
      const events = [];
      let r = await shot({ html_files: ["cards/01.html", "cards/02.html", "other/01.html"], width: 1080, height: 1440 }, { onProgress: (p) => events.push(p) });
      eq([r.isError, r.files, r.file], [false, ["01.png", "02.png", "01_2.png"], "01.png"], "文件名跟 HTML 走，撞名的接 _2");
      ok(["01.png", "02.png", "01_2.png"].every((n) => fs.readFileSync(path.join(B, n)).equals(BLUE)), "三张都落盘了");
      eq(shots.map((s) => [slash(path.relative(WS, s.p)), s.o.width, s.o.height]),
        [["cards/01.html", 1080, 1440], ["cards/02.html", 1080, 1440], ["other/01.html", 1080, 1440]], "按顺序一张张截，宽高每张都带上");
      eq(r.content, `3 张出好了（1080x1440）：${["01.png", "02.png", "01_2.png"].map((n) => media.savedAt(B, n)).join("、")}`, "回执：几张、多大、落在哪");
      const last = events[events.length - 1] || {};
      eq([last.stage, last.done, last.total, last.pct, last.label], ["shot", 3, 3, 100, "截图 3/3 张"], "最后一条进度是 3/3（节流不许吞掉收尾那条）");
      ok(events.length >= 2 && events[0].done === 0, "第一条进度是 0/3：开截就报", JSON.stringify(events));

      // 下一批换了一套卡片、名字撞上前一批：01.png 是 cards/01.html 截的，other/01.html 不能悄悄盖掉它
      const RED = solidPng(2, 2, [255, 0, 0]);
      fs.writeFileSync(path.join(B, "01.png"), RED); // 标一下前一批那张，看它还在不在
      r = await shot({ html_files: ["other/01.html"] });
      eq([r.isError, r.files], [false, ["01_2.png"]], "别的文件夹里同名的 HTML：接 _2，不盖前一批的 01.png");
      ok(fs.readFileSync(path.join(B, "01.png")).equals(RED) && !/覆盖/.test(r.content), "前一批的 01.png 一个字节没动", r.content);
      r = await shot({ html_files: ["cards/01.html"] });
      eq([r.files, /覆盖/.test(r.content), fs.readFileSync(path.join(B, "01.png")).equals(BLUE)], [["01.png"], false, true],
        "反向对照：同一个 HTML 重截照旧覆盖原名（改完卡片重出一张），不另起名");
      const B2 = path.join(OUT, "batch-old");
      fs.mkdirSync(B2, { recursive: true });
      fs.writeFileSync(path.join(B2, "02.png"), RED); // 不知道哪来的旧图（重启前截的、用户自己放的）
      r = await TM.htmlToImageBatch({ html_files: ["cards/01.html", "cards/02.html"] }, resolveFile, B2);
      ok(r.files.join() === "01.png,02.png" && r.content.split("\n")[1] === "覆盖了已有的：02.png（要留旧图就给 filename 当前缀）",
        "来历不明的同名旧图：照名字写，但回执里说盖了哪张、怎么留旧图", r.content);

      r = await shot({ html_files: ["cards/01.html", "cards/02.html"], filename: "xhs.png" });
      eq(r.files, ["xhs_01.png", "xhs_02.png"], "给了 filename 就当前缀：xhs_01、xhs_02");

      r = await shot({ html_files: ["cards/01.html", "cards/bad.html", "cards/missing.html"] });
      eq([r.isError, r.files, (r.failed || []).length], [false, ["01.png"], 2], "一张坏了、一张不存在：另外那张照出，这次调用不算失败");
      ok(/^1 张出好了/.test(r.content) && r.content.includes("2 张没成：cards/bad.html（HTML 截图失败：页面坏了）；cards/missing.html（文件不存在：cards/missing.html"),
        "回执里说清哪张为什么没成", r.content);
      r = await shot({ html_files: ["cards/bad.html"] });
      ok(r.isError === true && r.files.length === 0, "全部失败才算这次调用出错");

      const ac = new AbortController();
      ac.abort();
      const before = shots.length;
      r = await shot({ html_files: ["cards/01.html", "cards/02.html"] }, { signal: ac.signal });
      ok(r.isError && r.stopped === true && /还有 2 张没截/.test(r.content) && shots.length === before, "点了停止：一张都不再截，说还剩几张", r.content);

      r = await shot({ html_files: Array.from({ length: 31 }, () => "cards/01.html") });
      ok(r.isError && /一次最多 30 个/.test(r.content), "超过 30 张当场拒", r.content);
      r = await shot({ html_files: ["cards/01.html", ""] });
      ok(r.isError && /空路径/.test(r.content), "有空路径当场拒", r.content);

      r = await shot({ html_file: "cards/02.html", filename: "cover" });
      eq([r.isError, r.file, r.files], [false, "cover.png", ["cover.png"]], "单张模式：照旧出图，补上 file / files");
      ok(fs.existsSync(path.join(B, "cover.png")), "单张落盘");
      r = await shot({ html_file: "../x.html" });
      ok(r.isError && r.file === undefined, "单张出错：原样返回，不带 file", JSON.stringify(r));
    } finally {
      if (prevShot) require.cache[shotPath] = prevShot; else delete require.cache[shotPath];
    }
  }

  console.log("【14】无头 Chrome（假 DevTools + 假 ffmpeg）：先装时钟再开页、每帧先推时钟再截图、出错停止都不留半截");
  if (process.platform === "win32") console.log("    跳过：假 ffmpeg 是 sh 脚本，Windows 上跑不了");
  else {
    const FF = path.join(TMP, "fakeff");
    fs.mkdirSync(FF, { recursive: true });
    const script = (name, body) => { const f = path.join(FF, name); fs.writeFileSync(f, `#!/bin/sh\n${body}\n`); fs.chmodSync(f, 0o755); return f; };
    // 问编码器时报一个；真编码时把喂进来的字节原样存进最后一个参数（.part），事后逐字节核对
    const probe = (enc) => `for a in "$@"; do last="$a"; if [ "$a" = "-encoders" ]; then echo " V....D ${enc}   假编码器"; exit 0; fi; done`;
    const FF_OK = script("ffmpeg-ok", `${probe("libx264")}\ncat > "$last"`);
    const FF_DIE = script("ffmpeg-die", `${probe("libx264")}\necho "假 ffmpeg：磁盘满了" >&2\nexit 1`);
    const FF_NO264 = script("ffmpeg-nox264", probe("libx265"));

    // 宽高故意不等（也都不低于最小边 160）：驱动把宽高写反了就抓得到
    const W = 192, H = 160;
    /** @type {any[][]} */
    const log = [];
    /** @type {Buffer[]} */
    const pngs = [];
    /** @type {Array<string|null>} */
    const navHtml = [];
    const fake = { stepThrow: "", metaDuration: 0.5 };
    let tabSeq = 0, shotNo = 0, kills = 0;
    const wsFrame = (s) => {
      const b = Buffer.from(s), h = [0x81];
      if (b.length < 126) h.push(b.length); else if (b.length < 65536) h.push(126, b.length >> 8, b.length & 255);
      else h.push(127, 0, 0, 0, 0, (b.length >>> 24) & 255, (b.length >>> 16) & 255, (b.length >>> 8) & 255, b.length & 255);
      return Buffer.concat([Buffer.from(h), b]);
    };
    const sockets = new Set();
    const srv = http.createServer((req, res) => {
      const port = srv.address().port;
      if (req.url.startsWith("/json/new")) {
        if (req.method !== "PUT") { res.writeHead(405); return res.end(`Using unsafe HTTP verb ${req.method} to invoke /json/new.`); }
        const id = "TAB" + ++tabSeq;
        return res.end(JSON.stringify({ id, type: "page", url: "about:blank", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${id}` }));
      }
      if (req.url.startsWith("/json/close/")) { log.push(["close", decodeURIComponent(req.url.slice(12))]); return res.end("Target is closing"); }
      res.writeHead(404); res.end("[]");
    });
    srv.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
    srv.on("upgrade", (req, socket) => {
      sockets.add(socket);
      const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      socket.write(`HTTP/1.1 101 WebSocket Protocol Handshake\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      let buf = Buffer.alloc(0);
      let marked = false;
      socket.on("error", () => {});
      socket.on("data", (d) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 2) {
          let len = buf[1] & 127, off = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          const masked = !!(buf[1] & 128), key = masked ? buf.slice(off, off + 4) : null; if (masked) off += 4;
          if (buf.length < off + len) return;
          const body = Buffer.from(buf.slice(off, off + len)); buf = buf.slice(off + len);
          if (key) for (let i = 0; i < body.length; i++) body[i] ^= key[i % 4];
          let msg; try { msg = JSON.parse(body.toString()); } catch { continue; }
          const p = msg.params || {};
          const reply = (result) => socket.write(wsFrame(JSON.stringify({ id: msg.id, result })));
          const val = (value) => reply({ result: { type: typeof value, value } });
          if (msg.method === "Runtime.evaluate") {
            const x = String(p.expression);
            if (x === "window.__owb_prev = 1") { log.push(["mark"]); marked = true; val(1); }
            // 刚 navigate 完第一次问，还是旧文档（新页面没提交完）；再问一次才翻过去：逼驱动真的轮询
            else if (x.startsWith("window.__owb_prev ?")) { val(marked ? "old" : "complete"); marked = false; }
            else if (x.startsWith("__owb_ready(")) { log.push(["ready"]); val({ ok: true, pending: 0 }); }
            else if (x === "__owb_meta()") { log.push(["meta"]); val({ bodyDuration: fake.metaDuration, clips: [], poster: null, scrollW: W, scrollH: H, hasAudio: false }); }
            else if (x.startsWith("__owb_step(")) {
              log.push(["step", JSON.parse(x.slice("__owb_step(".length, -1)), p.awaitPromise === true && p.returnByValue === true]);
              if (fake.stepThrow) reply({ result: { type: "object", subtype: "error" }, exceptionDetails: { text: "Uncaught", exception: { description: `Error: ${fake.stepThrow}\n    at __owb_step (<anonymous>:1:1)` } } });
              else val({ errors: [], warnings: [] });
            } else { log.push(["eval?", x]); val(null); }
          } else if (msg.method === "Page.navigate") {
            log.push(["navigate", p.url]);
            try { navHtml.push(fs.readFileSync(fileURLToPath(p.url), "utf8")); } catch { navHtml.push(null); }
            reply({ frameId: "F1", loaderId: "L" + log.length });
          } else if (msg.method === "Page.captureScreenshot") {
            log.push(["shot", p.format]);
            // 每帧换一个红度：成片字节核对得出「每帧恰好喂了一次、按顺序」，也让每帧的指纹各不相同
            const png = solidPng(W, H, [shotNo++ % 256, 0, 0]);
            pngs.push(png);
            reply({ data: png.toString("base64") });
          } else { log.push([msg.method, p]); reply({}); }
        }
      });
    });
    await new Promise((res) => srv.listen(0, "127.0.0.1", () => res(undefined)));
    /** @type {any[]} */
    let spawned = [];
    const useFake = () => {
      HV._internals.electronAvailable = () => false;
      HV._internals.findChrome = () => "/fake/chrome";
      HV._internals.spawnIsolated = async (o) => {
        spawned.push(o); log.push(["spawn"]);
        return { port: srv.address().port, pid: 0, dir: "", kill: async () => { kills++; log.push(["kill"]); } };
      };
    };
    const clear = () => { log.length = 0; pngs.length = 0; navHtml.length = 0; spawned = []; kills = 0; shotNo = 0; };
    const steps = () => log.filter((x) => x[0] === "step");
    const count = (name) => log.filter((x) => x[0] === name).length;
    const leftover = (out) => fs.existsSync(out) || fs.existsSync(M.partPath(out));
    delete process.env.OWB_MOTION_BACKEND;
    useFake();
    try {
      const m1 = put("m1.html", '<!doctype html><body data-duration="0.5"></body>');
      const outA = path.join(OUT, "fake.mp4");
      /** @type {any[]} */
      const progress = [];
      /** @type {any[]} */
      const frames = [];
      const resA = await HV.renderMotion([{ path: m1, duration: 0.5 }], {
        width: W, height: H, fps: 30, out: outA, ffmpegBin: FF_OK, stills: 1,
        onProgress: (p) => progress.push(p),
        onFrame: (f) => { frames.push({ index: f.index, time: f.time, format: f.format }); },
      }).catch((e) => e);
      ok(!(resA instanceof Error), "假 Chrome + 假 ffmpeg 跑通", resA && resA.stack);
      const methods = log.map((x) => x[0]);
      const at = (name) => methods.indexOf(name);
      eq(spawned.map((o) => [o.prefix, o.windowSize]), [["owb-motion-", { w: W, h: H }]], "拉起一个独立 Chrome：专用前缀、窗口和画幅一样大");
      ok(M.CHROME_EXTRA_ARGS.every((a) => (spawned[0] || { extraArgs: [] }).extraArgs.includes(a)), "像素比、后台节流那几个参数带上了");
      ok(at("Page.enable") >= 0 && at("Page.enable") < at("Page.addScriptToEvaluateOnNewDocument")
        && at("Page.addScriptToEvaluateOnNewDocument") < at("Emulation.setDeviceMetricsOverride")
        && at("Emulation.setDeviceMetricsOverride") < at("navigate"), "先装虚拟时钟、定视口，再开页：页面里任何脚本都跑在假时间上", methods.join(","));
      const inject = log.find((x) => x[0] === "Page.addScriptToEvaluateOnNewDocument");
      ok(!!inject && inject[1].source === M.runtimeSource({}), "注入的就是 motion-clock 的运行时（默认 seed、默认起点）");
      const metrics = log.find((x) => x[0] === "Emulation.setDeviceMetricsOverride");
      eq(metrics && metrics[1], { width: W, height: H, deviceScaleFactor: 1, mobile: false }, "视口钉成画幅大小、像素比 1（Retina 上也不出 2 倍图）");
      ok(!methods.some((x) => /setVirtualTimePolicy/.test(x)), "从不发 Emulation.setVirtualTimePolicy");
      eq(log.filter((x) => x[0] === "navigate").map((x) => x[1]), [pathToFileURL(m1).href], "单段只开一次页面，地址是那个文件");
      ok(at("mark") < at("navigate") && at("navigate") < at("ready") && at("ready") < at("step"), "开页前打记号，字体图片落定之后才推第一帧", methods.join(","));
      const seq = log.filter((x) => x[0] === "step" || x[0] === "shot");
      eq(seq.map((x) => x[0]).join(","), Array.from({ length: 15 }, () => "step,shot").join(","), "每帧先推时钟、再截图，一共 15 帧");
      eq(steps().map((x) => x[1]), Array.from({ length: 15 }, (_, k) => (k * 1000) / 30), "推到的时刻就是 k×1000/30 毫秒");
      ok(steps().every((x) => x[2] === true), "推时钟要等页面里的 Promise 落定、按值取回");
      ok(seq.filter((x) => x[0] === "shot").every((x) => x[1] === "png"), "截的是 PNG");
      eq(log.filter((x) => x[0] === "close").map((x) => x[1]), ["TAB1"], "标签页关了");
      eq(kills, 1, "Chrome 收走了");
      ok(at("kill") > methods.lastIndexOf("shot"), "最后一帧截完才收 Chrome");
      ok(fs.existsSync(outA) && fs.readFileSync(outA).equals(Buffer.concat(pngs)), "喂给 ffmpeg 的 = 15 张截图按顺序拼起来：每帧恰好一次");
      ok(!fs.existsSync(M.partPath(outA)), "没留 .part");
      if (!(resA instanceof Error)) {
        eq([resA.frames, resA.distinctFrames, resA.backend, resA.width, resA.height, resA.fps, resA.file], [15, 15, "chrome", W, H, 30, outA], "结果：15 帧各不相同、走的 Chrome");
        eq(resA.stills.map((s) => s.frame), [6], "封面默认取 40% 处（第 7 帧）");
        ok(!!resA.stills[0] && resA.stills[0].png.equals(pngs[6]), "封面就是那一帧的截图");
        eq(resA.warnings, [], "没溢出、画面在动：没有提醒");
      }
      eq(frames.map((f) => [f.index, f.time, f.format]), Array.from({ length: 15 }, (_, k) => [k, (k * 1000) / 30, "png"]), "onFrame 逐帧报：帧号、时刻、格式");
      const lastP = progress[progress.length - 1] || {};
      eq([lastP.stage, lastP.pct], ["encode", 100], "最后一条进度：编码 100%");
      ok(!!progress[0] && progress[0].stage === "load", "第一条进度：开页面");
      const renders = progress.filter((p) => p.stage === "render");
      ok(renders.length >= 1 && renders.length < 15 && renders[renders.length - 1].done === 15, "渲染进度节流了（不是每帧一条），但 15/15 那条一定发", JSON.stringify(renders));

      // 两段：时长都由页面说，先把两段各过一遍量时长，再逐段真渲；第二段是内联 HTML
      clear();
      const cardDir = path.join(WS, "cards");
      const outB = path.join(OUT, "two.mp4");
      const resB = await HV.renderMotion([
        { path: m1 },
        { path: path.join(cardDir, "card.html"), html: "<html><head><title>x</title></head><body>内联</body></html>", name: "内联那段" },
      ], { width: W, height: H, fps: 30, out: outB, ffmpegBin: FF_OK, stills: 0 }).catch((e) => e);
      ok(!(resB instanceof Error), "两段（一段文件、一段内联）跑通", resB && resB.stack);
      const navs = log.filter((x) => x[0] === "navigate").map((x) => x[1]);
      const inlineUrl = navs[1] || "";
      ok(navs.length === 4 && navs[0] === pathToFileURL(m1).href && navs[2] === navs[0] && navs[3] === inlineUrl && /owb-motion-html-[^/]+\/index\.html$/.test(inlineUrl),
        "先各过一遍量时长，再逐段真渲：a、b、a、b", JSON.stringify(navs));
      ok(String(navHtml[1]).startsWith(`<html><head><base href="${pathToFileURL(cardDir).href}/"><title>`), "内联 HTML 补了 <base>：相对路径的图片字体照样指回原目录", String(navHtml[1]));
      ok(!!inlineUrl && !fs.existsSync(path.dirname(fileURLToPath(inlineUrl))), "内联 HTML 的临时目录渲完就删");
      eq(count("ready"), 2, "量时长那一遍不等字体，真渲时每段等一次");
      const half = Array.from({ length: 15 }, (_, k) => (k * 1000) / 30);
      eq(steps().map((x) => x[1]), [...half, ...half], "每段的时钟各自从 0 开始");
      if (!(resB instanceof Error)) {
        eq(resB.segments.map((s) => [s.firstFrame, s.frames]), [[0, 15], [15, 15]], "第二段从第 16 帧接上");
        eq([resB.frames, resB.stills.length], [30, 0], "一共 30 帧；stills=0 不留静帧");
      }

      clear();
      const ctl = new AbortController();
      const outC = path.join(OUT, "stop.mp4");
      const errC = await errOf(HV.renderMotion([{ path: m1, duration: 0.5 }], {
        width: W, height: H, fps: 30, out: outC, ffmpegBin: FF_OK, signal: ctl.signal,
        onFrame: (f) => { if (f.index === 3) ctl.abort(); },
      }));
      ok(!!errC && errC.stopped === true && errC.message === "用户已停止任务：视频没渲完，半截文件已删", "中途停止：抛带 stopped 的错", errC && errC.message);
      eq(steps().length, 4, "点了停止，下一帧就不推了");
      ok(!leftover(outC), "停止后成片和 .part 都没有");
      eq([count("close"), kills], [1, 1], "停止后标签页、Chrome 都收走了");

      clear();
      const outD = path.join(OUT, "die.mp4");
      // 第 1 帧喂完歇一会儿，让假 ffmpeg 先死透：下一帧再写就撞上它已经退出
      const errD = await errOf(HV.renderMotion([{ path: m1, duration: 0.5 }], {
        width: W, height: H, fps: 30, out: outD, ffmpegBin: FF_DIE,
        onFrame: async (f) => { if (f.index === 0) await realSleep(600); },
      }));
      ok(!!errD && /^ffmpeg 中途退出：假 ffmpeg：磁盘满了/.test(errD.message) && !errD.stopped, "ffmpeg 半路死了：报它最后说的话，不算停止", errD && errD.message);
      ok(steps().length <= 2, "ffmpeg 死了就不再往下渲", String(steps().length));
      ok(!leftover(outD), "ffmpeg 死了：成片和 .part 都没有");
      eq([count("close"), kills], [1, 1], "ffmpeg 死了：Chrome 照样收走");

      clear();
      const outE = path.join(OUT, "throw.mp4");
      fake.stepThrow = M.FLOOD_MESSAGE;
      const errE = await errOf(HV.renderMotion([{ path: m1, duration: 0.5 }], { width: W, height: H, fps: 30, out: outE, ffmpegBin: FF_OK }));
      fake.stepThrow = "";
      eq(errE && errE.message, M.FLOOD_MESSAGE, "页面里抛的错原话带出来（去掉 Error: 前缀和堆栈）");
      ok(!leftover(outE) && count("close") === 1 && kills === 1, "页面抛错：不留半截、Chrome 收走");

      clear();
      const nf = path.join(OUT, "nf.mp4");
      const errF = await errOf(HV.renderMotion([{ path: m1, duration: 0.5 }], { width: W, height: H, out: nf, ffmpegBin: path.join(FF, "没有这个") }));
      ok(!!errF && /ffmpeg 跑不起来/.test(errF.message), "指定的 ffmpeg 不存在：当场报", errF && errF.message);
      const errG = await errOf(HV.renderMotion([{ path: m1, duration: 0.5 }], { width: W, height: H, out: nf, ffmpegBin: FF_NO264 }));
      eq(errG && errG.message, M.noX264Message(""), "ffmpeg 没带 libx264：如实说，不偷偷换编码器");
      const errH = await errOf(HV.renderMotion([{ path: m1, duration: 500 }], { width: W, height: H, out: nf, ffmpegBin: FF_OK }));
      ok(!!errH && /超出范围/.test(errH.message), "时长超范围：当场报", errH && errH.message);
      const errI = await errOf(HV.renderMotion([{ path: m1, duration: 0.5 }], { width: W, height: H, ffmpegBin: FF_OK }));
      ok(!!errI && /要给 out/.test(errI.message), "没给 out：当场报", errI && errI.message);
      eq(spawned.length, 0, "以上几种一个浏览器都没开");
      ok(!leftover(nf), "也没留任何文件");

      // 同时来两条：排队一条条渲，前一条收完 Chrome 后一条才开；排在前面的失败了不卡后面的
      clear();
      const q = await Promise.allSettled([
        HV.renderMotion([{ path: m1, duration: 0.5 }], { width: W, height: H, out: path.join(OUT, "q1.mp4"), ffmpegBin: FF_OK }),
        HV.renderMotion([{ path: m1, duration: 500 }], { width: W, height: H, out: path.join(OUT, "q2.mp4"), ffmpegBin: FF_OK }),
        HV.renderMotion([{ path: m1, duration: 0.5 }], { width: W, height: H, out: path.join(OUT, "q3.mp4"), ffmpegBin: FF_OK }),
      ]);
      eq(q.map((x) => x.status), ["fulfilled", "rejected", "fulfilled"], "三条排队：中间那条失败不连累后面");
      eq(log.filter((x) => x[0] === "spawn" || x[0] === "kill").map((x) => x[0]).join(","), "spawn,kill,spawn,kill", "一次只开一个 Chrome：前一条收完后一条才开");

      // 用哪个后端
      HV._internals.electronAvailable = () => true;
      eq(HV.available(), { ok: true, backend: "electron", why: "" }, "桌面版里优先用内置浏览器");
      process.env.OWB_MOTION_BACKEND = "chrome";
      eq(HV.available(), { ok: true, backend: "chrome", why: "" }, "OWB_MOTION_BACKEND=chrome：强制走无头 Chrome");
      HV._internals.electronAvailable = () => false;
      HV._internals.findChrome = () => "";
      eq(HV.available(), { ok: false, backend: "", why: HV.NO_BROWSER }, "两样都没有：ok=false，原因说清楚");
      process.env.OWB_MOTION_BACKEND = "electron";
      HV._internals.findChrome = () => "/fake/chrome";
      ok(HV.available().ok === false, "OWB_MOTION_BACKEND=electron 但不在桌面版：不偷偷换成 Chrome");
      delete process.env.OWB_MOTION_BACKEND;
      HV._internals.electronAvailable = () => { throw new Error("electron 模块坏了"); };
      eq(HV.available().backend, "chrome", "查内置浏览器时抛了：当它没有，退到 Chrome");
    } finally {
      Object.assign(HV._internals, ORIG);
      restoreEnv();
      for (const s of sockets) s.destroy();
      srv.close();
    }
  }

  console.log("【15】真无头 Chrome + 真 ffmpeg：同一页渲两次逐帧一致，解出来的像素对得上时间轴");
  {
    if (typeof MP.reset === "function") MP.reset();
    const bins = await MP.resolveMediaBins();
    const ff = bins.ffmpeg && bins.ffmpeg.bin, fp = bins.ffprobe && bins.ffprobe.bin;
    const must = process.env.OWB_REQUIRE_FFMPEG === "1";
    const prep = ff ? await HV.prepareFfmpeg(ff) : { ok: false, why: "" };
    let chrome = "";
    try { chrome = ORIG.findChrome(); } catch { chrome = ""; }
    let br = null;
    if (!ff || !fp || !prep.ok) {
      if (must) ok(false, "OWB_REQUIRE_FFMPEG=1 却找不到能出 H.264 的 ffmpeg/ffprobe", prep.why || JSON.stringify(bins));
      else console.log("    跳过：本机没有 ffmpeg");
    } else if (!chrome) console.log("    跳过：本机没有 Chrome");
    else if (!(br = await ORIG.spawnIsolated({ prefix: "owb-motion-probe-", timeoutMs: 20000 }).catch((e) => {
      console.log("    跳过：Chrome 没起来（" + String((e && e.message) || e).split("\n")[0].slice(0, 120) + "）");
      return null;
    }))) { /* 上面已经说了跳过 */ }
    else {
      await br.kill();
      const W = 320, H = 240;
      // 320x240、1.2 秒、30 帧 = 36 帧。每样东西各验一件事：
      // 红块 = CSS 动画按虚拟时间走；绿块 = 600ms 的 setTimeout 恰好在第 19 帧生效；灰条 = rAF 拿到的是虚拟时刻；
      // 黄块贴着 100vw 的右边 = 视口真是 320 宽（不是 2 倍图）；蓝块 = data-start/data-duration 片段只在自己的窗口里；
      // 白块横坐标由 Math.random 决定 = 两次渲出来一样才说明随机数带了种子
      const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:100vw;height:100vh;overflow:hidden;background:#000}
#box{position:absolute;left:0;top:0;width:40px;height:40px;background:#f00;animation:mv 1.2s linear forwards}
@keyframes mv{from{transform:translateX(0)}to{transform:translateX(280px)}}
#late{position:absolute;left:0;top:100px;width:20px;height:20px;background:#0f0;opacity:0}
#edge{position:absolute;left:calc(100vw - 10px);top:60px;width:10px;height:10px;background:#ff0}
#clip{position:absolute;left:60px;top:130px;width:30px;height:30px;background:#00f}
#rnd{position:absolute;left:0;top:60px;width:12px;height:12px;background:#fff}
</style></head><body data-duration="1.2">
<div id="box"></div><div id="late"></div><div id="edge"></div><div id="rnd"></div>
<div id="clip" data-start="0.8" data-duration="0.4"></div>
<canvas id="c" width="320" height="60" style="position:absolute;left:0;top:180px"></canvas>
<script>
setTimeout(function () { document.getElementById("late").style.opacity = "1"; }, 600);
var c = document.getElementById("c").getContext("2d");
function f(t) { var g = Math.min(255, Math.round(t / 1200 * 255)); c.fillStyle = "rgb(" + g + "," + g + "," + g + ")"; c.fillRect(0, 0, 320, 60); requestAnimationFrame(f); }
requestAnimationFrame(f);
document.getElementById("rnd").style.left = Math.floor(100 + Math.random() * 150) + "px";
</script></body></html>`;
      const fx = put("real/fx.html", FIXTURE);
      process.env.OWB_MOTION_BACKEND = "chrome";
      try {
        const once = async (name) => {
          const hashes = [];
          const out = path.join(OUT, name);
          const r = await HV.renderMotion([{ path: fx }], { width: W, height: H, fps: 30, out, stills: 1, onFrame: (f) => { hashes.push(f.hash); } });
          return { r, hashes, out };
        };
        const a = await once("real1.mp4").catch((e) => e);
        const b = await once("real2.mp4").catch((e) => e);
        ok(!(a instanceof Error) && !(b instanceof Error), "真 Chrome 渲两次都成功", (a && a.stack) || (b && b.stack));
        if (!(a instanceof Error) && !(b instanceof Error)) {
          eq([a.r.frames, a.r.backend, a.r.width, a.r.height], [36, "chrome", W, H], "36 帧、走的无头 Chrome、画幅 320x240");
          ok(a.hashes.length === 36 && JSON.stringify(a.hashes) === JSON.stringify(b.hashes), "同一页渲两次：36 帧的指纹逐帧一模一样");
          ok(a.r.distinctFrames >= 30, "画面真在动：不同的帧 ≥ 30", String(a.r.distinctFrames));
          eq(a.r.warnings, [], "没溢出、没报错：没有提醒");
          eq(a.r.stills.map((s) => s.frame), [14], "封面默认取 40% 处（第 15 帧）");
          ok(!!a.r.stills[0] && a.r.stills[0].png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "封面是 PNG");
          const pr = spawnSync(fp, ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=codec_name,pix_fmt,width,height,nb_read_frames", "-of", "json", a.out], { encoding: "utf8", timeout: 30000 });
          let st = {};
          try { st = JSON.parse(pr.stdout).streams[0]; } catch { st = { err: pr.stderr }; }
          eq([st.codec_name, st.pix_fmt, st.width, st.height, st.nb_read_frames], ["h264", "yuv420p", W, H, "36"], "成片：h264 / yuv420p / 320x240 / 36 帧");
          const raw = spawnSync(ff, ["-v", "error", "-i", a.out, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { timeout: 60000, maxBuffer: 64 << 20 }).stdout || Buffer.alloc(0);
          eq(raw.length, 36 * W * H * 3, "解码出 36 帧完整画面");
          const px = (n, x, y) => { const o = (n * W * H + y * W + x) * 3; return [raw[o], raw[o + 1], raw[o + 2]]; };
          const is = {
            red: ([r, g, b]) => r > 180 && g < 80 && b < 80,
            green: ([r, g, b]) => g > 180 && r < 80 && b < 80,
            blue: ([r, g, b]) => b > 180 && r < 80 && g < 80,
            yellow: ([r, g, b]) => r > 180 && g > 180 && b < 80,
            black: ([r, g, b]) => r < 40 && g < 40 && b < 40,
          };
          const probeAt = (n, x, y, kind, what) => ok(is[kind](px(n, x, y)), what, JSON.stringify(px(n, x, y)));
          probeAt(0, 20, 20, "red", "第 1 帧：红块在最左边");
          probeAt(0, 160, 20, "black", "第 1 帧：中间还没有红块");
          probeAt(18, 160, 20, "red", "第 19 帧（600ms）：红块走到正中（CSS 动画按虚拟时间走）");
          probeAt(18, 20, 20, "black", "第 19 帧：左边已经空了");
          probeAt(17, 10, 110, "black", "第 18 帧（567ms）：600ms 的定时器还没到");
          probeAt(18, 10, 110, "green", "第 19 帧（600ms）：定时器恰好生效");
          const gray = px(18, 100, 210);
          ok(Math.abs(gray[0] - 128) <= 8 && Math.abs(gray[1] - 128) <= 8, "第 19 帧：rAF 拿到的是 600ms，画出 50% 灰", JSON.stringify(gray));
          probeAt(18, 315, 65, "yellow", "贴着 100vw 右边的黄块在画面最右 10px 里：视口就是 320 宽");
          probeAt(22, 75, 145, "black", "第 23 帧（733ms）：0.8 秒起的片段还没露面");
          probeAt(27, 75, 145, "blue", "第 28 帧（900ms）：片段在自己的窗口里");
        }
        for (const n of ["real1.mp4", "real2.mp4"]) fs.rmSync(path.join(OUT, n), { force: true });
      } finally {
        restoreEnv();
      }
    }
  }
}

/* ───────────── 接线：tools.js 的分派、智能体的工具清单、界面那一行 ─────────────
 * 上面都是直接调 TM.*，绕过了 tools.js 那个 switch。case 名写错、onProgress / 停止 / 截止时间 /
 * 成果子目录哪一样没递下去、工具清单的开关条件写反，上面照样全绿，模型手上却用不了。
 * 这里从 executeTool 和 toolList 进去，执行层（浏览器、ffmpeg、截图窗口）全换成替身：不开窗口、不花钱。
 */
async function wiringTests() {
  const tools = require("../tools");
  const ag = require("../agent");
  const HV = require("../htmlvideo");
  // 建在 TMP 里面、跟着 TMP 一起收（TMP 本身就是 owb- 开头的 mkdtemp）
  const WS2 = path.join(TMP, "wire");
  fs.mkdirSync(WS2, { recursive: true });
  const put2 = (rel, text) => fs.writeFileSync(path.join(WS2, rel), text);
  const exec = (name, input, opts) => tools.withWorkspace(WS2, () => tools.executeTool(name, input, opts));

  console.log("【16】从 tools.executeTool 进去：进度、停止、截止时间、成果子目录一路递到执行层");
  {
    const def = (n) => tools.TOOL_DEFS.find((t) => t.name === n) || { input_schema: { properties: {} } };
    const rm = def("render_motion").input_schema, hi = def("html_to_image").input_schema;
    ok(!!tools.TOOL_DEFS.find((t) => t.name === "render_motion") && Array.isArray(rm.required) && rm.required.length === 0,
      "render_motion 在工具定义里，必填为空（html_file / html_files 二选一，由工具自己查）", JSON.stringify(rm.required));
    ok(hi.properties.html_files && hi.properties.html_files.type === "array" && Array.isArray(hi.required) && !hi.required.includes("html_file"),
      "html_to_image 多了 html_files，html_file 不再是必填（只给 html_files 时不能被必填校验挡掉）", JSON.stringify(hi.required));

    put2("a.html", '<!doctype html><body data-duration="1"></body>');
    const saved = { available: HV.available, prepareFfmpeg: HV.prepareFfmpeg, renderMotion: HV.renderMotion };
    /** @type {Array<{ files: any[], o: any }>} */
    const seen = [];
    /** @type {null | ((o: any) => Promise<void>)} */
    let during = null;
    // 替身挂在 htmlvideo 的 exports 上：工具层是用到时才按属性去取，挂得上就说明没被提前解构死
    HV.available = () => ({ ok: true, backend: "chrome", why: "" });
    HV.prepareFfmpeg = async () => ({ ok: true, bin: "ffmpeg", why: "" });
    HV.renderMotion = async (files, o) => {
      seen.push({ files, o });
      for (let k = 1; k <= 3; k++) if (o.onProgress) o.onProgress({ stage: "render", done: k, total: 3, pct: Math.round((k / 3) * 100), label: `渲染 ${k}/3 帧` });
      if (during) await during(o);
      fs.writeFileSync(o.out, "fake mp4");
      return {
        file: o.out, frames: 30, duration: 1, width: o.width, height: o.height, fps: o.fps, backend: "chrome",
        segments: [{ index: 0, start: 0, firstFrame: 0, frames: 30 }], warnings: [], distinctFrames: 30, metas: [],
        stills: [{ frame: 11, png: solidPng(2, 2, [255, 0, 0]) }].slice(0, o.stills),
      };
    };
    try {
      /** @type {any[]} */
      const events = [];
      const DL = Date.now() + 60000;
      const r = await exec("render_motion", { html_file: "a.html", duration: 1 }, { baseDir: "对话1", deadline: DL, onProgress: (p) => events.push(p) });
      const c = seen[0] || { files: [], o: {} };
      ok(!r.isError && seen.length === 1, "executeTool 分到了 render_motion，出片成功", r.content);
      eq(events.map((e) => [e.stage, e.done, e.total]), [["render", 1, 3], ["render", 2, 3], ["render", 3, 3]], "执行层报的三条进度原样到了 executeTool 的 onProgress");
      ok(c.o.deadline === DL, "截止时间递下去了", String(c.o.deadline));
      ok(c.o.signal instanceof AbortSignal && c.o.signal.aborted === false, "停止信号递下去了（withStop 合成的那个，没点停就没断）");
      eq(c.files.map((f) => f.path), [path.join(WS2, "a.html")], "对话子目录里没有的 HTML，用工作空间根下那个");
      eq(path.dirname(String(c.o.out)), path.join(WS2, "对话1"), "成片落在这个对话的成果子目录里");
      ok(/^motion_.+\.mp4$/.test(String(r.file)) && fs.existsSync(path.join(WS2, "对话1", String(r.file))), "没给文件名：motion_时间戳.mp4，盘上真有", r.file);
      eq(String(r.content).split("\n")[0], `已把 1 个 HTML 渲成视频：对话1/${r.file}（1080x1920，30 帧/秒，1 秒，30 帧）`,
        "回执里的路径按这次的工作空间算（media 绑的是 tools 的工作目录）");

      // 点停是 stopSignal，不是 signal：只把 signal 递下去的话，用户点了停执行层照渲不误
      const ac = new AbortController();
      let abortedInside = null;
      during = async (o) => {
        ac.abort();
        abortedInside = o.signal && o.signal.aborted;
        throw Object.assign(new Error("用户已停止任务：视频没渲完，半截文件已删"), { stopped: true });
      };
      const r2 = await exec("render_motion", { html_file: "a.html", duration: 1 }, { stopSignal: ac.signal });
      ok(abortedInside === true, "点了停止：执行层手上那个信号跟着断了");
      ok(r2.isError === true && r2.stopped === true, "回的是「已停止」，带 stopped 标记", JSON.stringify(r2));

      // 反向对照：没浏览器时分派照样到得了，是工具层自己把原话回出来——证明上面那条「成功」不是 switch 外面兜的
      during = null;
      HV.available = () => ({ ok: false, backend: "", why: HV.NO_BROWSER });
      const n0 = seen.length;
      const r3 = await exec("render_motion", { html_file: "a.html", duration: 1 }, {});
      ok(r3.isError === true && r3.content === HV.NO_BROWSER && seen.length === n0, "反向对照：没浏览器时原话回给模型，一帧都不渲", r3.content);
    } finally {
      Object.assign(HV, saved);
    }

    // html_to_image 批量：截图窗口换替身（media.js 用到时才 require htmlshot，先占住缓存就换得掉）
    const shotPath = require.resolve("../htmlshot");
    const prevShot = require.cache[shotPath];
    /** @type {string[]} */
    const shots = [];
    require.cache[shotPath] = /** @type {any} */ ({
      id: shotPath, filename: shotPath, loaded: true, children: [], paths: [],
      exports: { renderHtmlToPng: async (p) => { shots.push(p); return solidPng(2, 2, [0, 0, 255]); } },
    });
    try {
      put2("c1.html", "<p>1</p>");
      put2("c2.html", "<p>2</p>");
      /** @type {any[]} */
      const ev = [];
      const r = await exec("html_to_image", { html_files: ["c1.html", "c2.html"] }, { onProgress: (p) => ev.push(p) });
      eq([r.isError, r.files], [false, ["c1.png", "c2.png"]], "executeTool 分到了批量截图：两张都出了，名字跟 HTML 走", r.content);
      eq(shots, [path.join(WS2, "c1.html"), path.join(WS2, "c2.html")], "按顺序一张张截");
      ok(["c1.png", "c2.png"].every((n) => fs.existsSync(path.join(WS2, n))), "落在这次的工作空间里");
      const last = ev[ev.length - 1] || {};
      ok(ev.length >= 2 && last.stage === "shot" && last.done === 2 && last.total === 2, "进度到了 executeTool 的 onProgress，最后一条是 2/2", JSON.stringify(ev));
      const r1 = await exec("html_to_image", { html_file: "c1.html", filename: "cover" }, {});
      eq([r1.isError, r1.file], [false, "cover.png"], "只给 html_file 的老用法照旧能截", r1.content);
    } finally {
      if (prevShot) require.cache[shotPath] = prevShot; else delete require.cache[shotPath];
    }
  }

  console.log("【17】工具清单：有浏览器（内置或本机 Chrome）才给 render_motion，只读档位永远不给");
  {
    const mk = () => ag.createAgentRuntime({
      config: { agent: {}, im: {}, security: {} },
      llm: {}, mcpManager: { toolDefs: () => [] }, experts: [], expertTeams: [],
    });
    const names = (mode) => mk().toolList(0, mode).map((t) => t.name);
    const I = HV._internals;
    const keep = { electronAvailable: I.electronAvailable, findChrome: I.findChrome };
    const envB = process.env.OWB_MOTION_BACKEND;
    delete process.env.OWB_MOTION_BACKEND;
    try {
      I.electronAvailable = () => false;
      I.findChrome = () => "";
      ok(!names("craft").includes("render_motion"), "两样都没有：不给（给了也是张口就报没浏览器，模型会一遍遍重试）");
      I.findChrome = () => "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
      const chromeOnly = names("craft");
      ok(chromeOnly.includes("render_motion"), "反向对照：只有本机 Chrome 也给（它不算桌面专属）", chromeOnly);
      ok(!chromeOnly.includes("html_to_image"), "同一个环境里 html_to_image 仍然摘着：它只认内置浏览器", chromeOnly);
      I.findChrome = () => "";
      I.electronAvailable = () => true;
      ok(names("craft").includes("render_motion"), "只有内置浏览器也给");
      ok(!names("ask").includes("render_motion") && !names("plan").includes("render_motion"), "只看不动（ask / plan）不给：它要写文件");
    } finally {
      Object.assign(I, keep);
      if (envB === undefined) delete process.env.OWB_MOTION_BACKEND; else process.env.OWB_MOTION_BACKEND = envB;
    }
  }

  console.log("【18】界面那一行：动词、对象、短标、图标");
  {
    eq(ag.toolHeadline("render_motion", { html_files: ["s1.html", "s2.html", "s3.html"] }), "出片 s1.html (+2)", "批量出片：第一个 HTML + 还有几个（数字不用翻译）");
    eq(ag.toolHeadline("html_to_image", { html_file: "card.html" }), "截图 card.html", "截图那一行说截的是哪个 HTML（参数叫 html_file，不叫 path）");
    const app01 = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-01.js"), "utf8");
    const indexHtml = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
    ok(/^const TOOL_SHORT = \{.*\brender_motion: "出片"/m.test(app01), "轨迹条短标有 render_motion");
    const icon = (app01.match(/^const TOOL_ICON = \{.*\brender_motion: "([\w-]+)"/m) || [])[1];
    ok(!!icon && indexHtml.includes(`<symbol id="i-${icon}"`), "图标是雪碧图里现成的那个", icon);
  }
}
