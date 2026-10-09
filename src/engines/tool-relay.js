// @ts-check
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 借出去的工具交回主进程跑（属主在 设置 → 智能体 → 底层引擎 那张卡上勾「借给它的工具在这边执行」，存成
 * engine_options[引擎].relay: true；默认关，桥照老样子自己跑）。
 *
 * 桥（tool-bridge.js）是 CLI 拉起的子进程，自己读设置、自己跑 executeTool。有几样它够不着：
 * 审批卡摆在它自己进程里，网页、终端、手机都看不见，只能当场拒；这一趟是谁在跑（记账记在谁名下）、
 * 组织策略、工具卡上的进度，都在主进程里。打开后桥只管收发：每次调用经本机套接字交回主进程，
 * 在这一趟开跑时的上下文里执行，结果原路带回。
 *
 * 凭据：一趟一张。随机串写进只有本人能读的文件（目录 0700、文件 0600），环境变量里只放文件路径——
 * codex 把 MCP 的环境变量摊在命令行参数上，ps 看得见。一趟跑完就吊销，迟到的调用一律拒。
 *
 * 协议：一个连接一次调用。客户端发一行 JSON {t, op:"call", name, args}，
 * 服务端回一行 {text, isError} 或 {error}，然后断开。客户端先断开 = 叫停这一单。
 *
 * 审批也走这条（属主勾了「删文件等操作先问我」，见 engines/approve.js）：claude 要审批时桥发
 * {t, op:"approve", req}，主进程照安全中心裁决，要人点头的摆进网页、终端、手机都看得见的那份审批卡，
 * 回 {text: 判词 JSON}。没勾「交回主进程跑」的那一趟也开这个口子，只是一个工具都不借（allow([])）。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const crypto = require("crypto");
const { AsyncResource } = require("async_hooks");
const { READ_ONLY } = require("./lendable");

const ENV = "OPENWORKBUDDY_RELAY_TICKET_FILE";
/** 审批交回主进程时桥认的那个变量（值也是凭据文件的路径）。跟上面分开：只开审批的那一趟，借出去的工具照旧由桥自己跑 */
const APPROVE_ENV = "OPENWORKBUDDY_APPROVE_TICKET_FILE";
/** 一次调用的请求最多这么大：参数是文字和路径，图片走文件 */
const MAX_REQ = 4 * 1024 * 1024;
/** 连上了却迟迟不发请求的，这么久就断 */
const HELLO_MS = 10000;
/** 收工时等手上那几单回完，最多这么久 */
const SETTLE_MS = 3000;

/** 还开着的，进程退出时把目录收掉 */
const opened = new Set();
let exitHooked = false;
function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", () => { for (const d of opened) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
}

/** unix 套接字路径的长度上限（sun_path），超了 listen 直接报错 */
const sunMax = () => (process.platform === "darwin" ? 103 : 107);

function makeDir() {
  let dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-r-"));
  if (process.platform !== "win32" && Buffer.byteLength(path.join(dir, "s")) > sunMax()) {
    fs.rmSync(dir, { recursive: true, force: true });
    dir = fs.mkdtempSync("/tmp/owb-r-");
  }
  try { fs.chmodSync(dir, 0o700); } catch {}
  return dir;
}

/** 等长比对，比不出差在第几个字 @param {string} a @param {string} b */
function same(a, b) {
  const h = (s) => crypto.createHash("sha256").update(String(s)).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

/** 工具的返回值统一成 {text, isError}，跟桥回给 CLI 的那份一样 */
function toReply(r) {
  const text = typeof r === "string" ? r : String((r && r.content) != null ? r.content : JSON.stringify(r));
  return { text, isError: !!(r && r.isError) };
}

/**
 * 开一个口子。exec 在这里绑定当前的异步上下文：之后每次调用都在开跑时的那份里跑（谁在跑、工作区、资料库、组织策略）。
 * allow() 之前来的调用一律拒。approve 同理绑定；不给就不收审批
 * @param {{ exec: (name: string, args: any, o: {signal: AbortSignal}) => Promise<any>,
 *   approve?: ((req: any, o: {signal: AbortSignal}) => Promise<any>)|null,
 *   stopSignal?: AbortSignal|null, deadline?: number|(() => number), readOnly?: boolean }} o
 */
async function open({ exec, approve = null, stopSignal = null, deadline = 0, readOnly = false }) {
  if (typeof exec !== "function") throw new Error("缺执行函数");
  const run = AsyncResource.bind(exec);
  const judge = typeof approve === "function" ? AsyncResource.bind(approve) : null;
  const ticket = crypto.randomBytes(32).toString("hex");
  const dir = makeDir();
  opened.add(dir);
  hookExit();
  const sock = process.platform === "win32" ? `\\\\.\\pipe\\owb-r-${crypto.randomBytes(12).toString("hex")}` : path.join(dir, "s");
  const ticketFile = path.join(dir, "ticket");
  /** @type {Set<string>|null} */
  let lent = null;
  let closed = false;
  /** @type {Set<{ac: AbortController, done: Promise<void>}>} */
  const inflight = new Set();
  /** @type {Set<net.Socket>} */
  const conns = new Set();
  const due = () => (typeof deadline === "function" ? deadline() : deadline) || 0;

  /** @param {any} req @returns {string} 空串 = 照跑 */
  function refuse(req) {
    if (!req || typeof req.t !== "string" || !same(req.t, ticket)) return "交回主进程的凭据对不上，没有执行";
    if (closed) return "这一趟已经收工，没有执行";
    if (stopSignal && stopSignal.aborted) return "这一趟已经叫停，没有执行";
    const d = due();
    if (d && Date.now() > d) return "这一趟已经超时，没有执行";
    // 审批不看借出去的名单：问的是 claude 自带的那几样（Bash、Write……），本来就不在名单上
    if (req.op === "approve") return judge ? "" : "这一趟没开审批，没有执行";
    if (req.op !== "call") return `不认 ${String(req.op)} 这种请求，没有执行`;
    const name = typeof req.name === "string" ? req.name : "";
    if (!lent) return "主进程这边还没准备好，没有执行";
    if (!name || !lent.has(name)) return `工具 ${name || "（没写名字）"} 没有借给本机引擎`;
    if (readOnly && !READ_ONLY.includes(name)) return `这一趟是问答 / 计划模式，按只读跑，只借读的那几个工具；${name} 不在其中，没有执行`;
    return "";
  }

  /** @param {net.Socket} c */
  function onConn(c) {
    conns.add(c);
    const ac = new AbortController();
    let buf = Buffer.alloc(0);
    let got = false;
    const reply = (obj) => { try { c.end(JSON.stringify(obj) + "\n"); } catch {} };
    const hello = setTimeout(() => { if (!got) c.destroy(); }, HELLO_MS);
    hello.unref();
    c.on("data", (d) => {
      if (got) return;
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf(10);
      if (i < 0 ? buf.length > MAX_REQ : i > MAX_REQ) { got = true; clearTimeout(hello); reply({ error: "请求太大，没有执行" }); return; }
      if (i < 0) return;
      got = true;
      clearTimeout(hello);
      let req;
      try { req = JSON.parse(buf.subarray(0, i).toString("utf8")); } catch { reply({ error: "请求不是 JSON，没有执行" }); return; }
      const why = refuse(req);
      if (why) { reply({ error: why }); return; }
      const onStop = () => ac.abort();
      if (stopSignal) stopSignal.addEventListener("abort", onStop, { once: true });
      const args = req.args && typeof req.args === "object" && !Array.isArray(req.args) ? req.args : {};
      /** @type {{ac: AbortController, done: Promise<void>}} */
      const job = { ac, done: Promise.resolve() };
      // 判词原样塞进 text（桥再原样交给 claude）；判的时候抛了错由那头按拒处理
      const work = req.op === "approve"
        ? () => /** @type {NonNullable<typeof judge>} */ (judge)(req.req, { signal: ac.signal }).then((d) => ({ text: JSON.stringify(d), isError: false }))
        : () => run(req.name, args, { signal: ac.signal }).then(toReply);
      job.done = Promise.resolve()
        .then(work)
        .then((out) => out, (e) => ({ text: String((e && e.message) || e), isError: true }))
        .then((out) => reply(out))
        .finally(() => {
          inflight.delete(job);
          if (stopSignal) stopSignal.removeEventListener("abort", onStop);
        });
      inflight.add(job);
    });
    // 那头先断了（桥被叫停、CLI 收工）：这一单跟着停，别在后台接着跑完却没人收
    c.on("close", () => { clearTimeout(hello); conns.delete(c); ac.abort(); });
    c.on("error", () => {});
  }

  const server = net.createServer(onConn);
  const drop = () => { opened.delete(dir); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(sock, () => { server.off("error", reject); resolve(undefined); });
  }).catch((e) => { drop(); throw e; });
  try {
    if (process.platform !== "win32") fs.chmodSync(sock, 0o600);
    fs.writeFileSync(ticketFile, JSON.stringify({ sock, ticket }), { mode: 0o600, flag: "wx" });
  } catch (e) {
    await new Promise((r) => server.close(() => r(undefined)));
    drop();
    throw e;
  }

  return {
    ticketFile,
    sock,
    dir,
    env: { [ENV]: ticketFile },
    /** 这一趟借出去的工具名：名单外的一律拒 @param {string[]} names */
    allow(names) { lent = new Set(names); },
    inflight: () => inflight.size,
    /** 收工：先吊销，手上的叫停、等它们回完（最多 SETTLE_MS），再关门、删目录 */
    async close() {
      if (closed) return;
      closed = true;
      try { fs.rmSync(ticketFile, { force: true }); } catch {}
      for (const j of inflight) j.ac.abort();
      const pending = [...inflight].map((j) => j.done);
      if (pending.length) {
        let t;
        await Promise.race([Promise.allSettled(pending), new Promise((r) => { t = setTimeout(r, SETTLE_MS); })]);
        clearTimeout(t);
      }
      for (const c of conns) c.destroy();
      await new Promise((r) => server.close(() => r(undefined)));
      drop();
    },
  };
}

/**
 * 桥那头用：照凭据文件连回主进程，交一次调用，等回话。
 * 凭据读不出来、连不上：抛错并带 connect: true（这一单没发出去）；别的照原话抛，不猜原因。
 * @param {string} ticketFile @param {string} name @param {any} args
 * @param {{signal?: AbortSignal}} [o]
 * @returns {Promise<{text: string, isError: boolean}>}
 */
function call(ticketFile, name, args, { signal } = {}) {
  return send(ticketFile, (t) => ({ t, op: "call", name, args: args || {} }), signal);
}

/**
 * 连一次、发一行、等一行回话
 * @param {string} ticketFile @param {(ticket: string) => any} body @param {AbortSignal|undefined} signal
 * @returns {Promise<{text: string, isError: boolean}>}
 */
function send(ticketFile, body, signal) {
  return new Promise((resolve, reject) => {
    let info;
    try { info = JSON.parse(fs.readFileSync(ticketFile, "utf8")); }
    catch (e) { reject(Object.assign(new Error(`凭据文件读不出来（${(e && e.message) || e}）`), { connect: true })); return; }
    if (signal && signal.aborted) { reject(new Error("已叫停，没有发出去")); return; }
    let done = false;
    let buf = "";
    const c = net.createConnection(String(info && info.sock));
    const finish = (fn, v) => { if (done) return; done = true; if (signal) signal.removeEventListener("abort", onAbort); fn(v); };
    const onAbort = () => { c.destroy(); finish(reject, new Error("已叫停")); };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    c.setEncoding("utf8");
    c.on("connect", () => c.write(JSON.stringify(body(info.ticket)) + "\n"));
    c.on("data", (d) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i < 0) return;
      let m;
      try { m = JSON.parse(buf.slice(0, i)); } catch { finish(reject, new Error("主进程回的不是 JSON")); c.destroy(); return; }
      if (m && typeof m.error === "string") finish(reject, new Error(m.error));
      else finish(resolve, { text: String((m && m.text) || ""), isError: !!(m && m.isError) });
      c.end();
    });
    c.on("error", (e) => finish(reject, Object.assign(new Error(`连不上（${e.message}）`), { connect: true })));
    c.on("close", () => finish(reject, new Error("主进程没回话就断开了")));
  });
}

/**
 * 桥那头用：claude 要审批，交回主进程判。回的是判词（{behavior, …}）；连不上带 connect: true，跟 call 一样
 * @param {string} ticketFile @param {any} req claude 递过来的 {tool_name, input, tool_use_id}
 * @param {{signal?: AbortSignal}} [o]
 * @returns {Promise<any>}
 */
function approval(ticketFile, req, { signal } = {}) {
  return send(ticketFile, (t) => ({ t, op: "approve", req: req || {} }), signal).then((m) => {
    if (m.isError) throw new Error(m.text || "主进程判的时候出了错");
    return JSON.parse(m.text);
  });
}

/**
 * 对上 CLI 那边的工具卡：引擎播出 tool_use（归回原名之后）记一笔，交回来的那一单按名字取最早那张；
 * 结果先到的在 tool_result 那儿划掉。对不上就不报进度，不影响执行
 */
function cards() {
  /** @type {Map<string, string[]>} */
  const q = new Map();
  return {
    /** @param {string} name @param {string} id */
    open(name, id) { if (!id) return; const a = q.get(name) || []; a.push(id); q.set(name, a); },
    /** @param {string} name @returns {string|undefined} */
    take(name) { const a = q.get(name); return a && a.length ? a.shift() : undefined; },
    /** @param {string} name @param {string} id */
    close(name, id) { const a = q.get(name); const i = a ? a.indexOf(id) : -1; if (a && i >= 0) a.splice(i, 1); },
  };
}

module.exports = { ENV, APPROVE_ENV, open, call, approval, cards, _internals: { sunMax, makeDir, MAX_REQ, HELLO_MS, SETTLE_MS } };
