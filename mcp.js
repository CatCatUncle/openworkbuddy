"use strict";
/**
 * MCP 连接器 — Model Context Protocol 客户端。
 * 两种传输：
 *   stdio           本机起一个子进程，按行收发 JSON-RPC
 *   streamable-http 远程 HTTP 端点，POST JSON-RPC，响应可能是 JSON 也可能是 SSE 流
 *
 * 在 config.json 的 mcp_servers 里配置：
 *   [{ "name": "filesystem", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:/data"] },
 *    { "name": "remote", "transport": "streamable-http", "url": "https://tools.example.com/mcp" }]
 * 也接受 Agent Plugins 插件 mcp.json 里声明的服务器（见 plugins.js）。
 * 服务器暴露的工具会自动注入 agent 工具列表，命名为 mcp__<服务器名>__<工具名>。
 *
 * 工作区 .openworkbuddy/ 底下两样东西归这里管：
 *   mcp-tools-cache.json  上次连上时记下的工具表。开机读它，配置没变的等第一次调用再连（见 startAll）
 *   mcp-media/            工具结果里的图片/音频解码落盘，结果文字里给路径和 mimeType（见 renderContent）
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const PROTOCOL_VERSION = "2025-06-18";

/** tools/list 最多翻几页。正常的服务器一两页就翻完了；到这儿还有下一页，多半是游标在原地打转 */
const MAX_TOOL_PAGES = 20;
/** 上次连上时记下的工具表（相对工作区根） */
const TOOLS_CACHE_REL = ".openworkbuddy/mcp-tools-cache.json";
/** 工具结果里的图片/音频落在这儿（相对工作区根）。模型拿这个相对路径去 look_at_image */
const MEDIA_REL = ".openworkbuddy/mcp-media";

/**
 * 工作区根。tools.js 很重，只在真要读写盘时才懒加载——也免得模块加载时绕成一个环（anySignal 那儿同一个顾虑）。
 * which="default"：默认工作区。工具表缓存是整台机器一份的（连接器配置就是整台机器一份），不跟着某个租户/项目的任务走。
 * 否则：当前这条异步链的工作区。图片跟着这一单任务落，租户之间看不见彼此的图。
 */
function workspaceRoot(which) {
  try {
    const t = require("./tools");
    return which === "default" ? t.getDefaultWorkspaceDir() : t.getWorkspaceDir();
  } catch {
    return "";
  }
}

/**
 * 一条连接器配置的指纹：只取决定「连到哪、怎么连」的那几样。指纹变了，缓存里那份工具表就不作数了。
 * env / headers 里是 Key：只进哈希，缓存文件里不落明文。
 */
function cfgFingerprint(cfg = {}) {
  const sorted = (o) => Object.keys(o || {}).sort().map((k) => [k, String(o[k])]);
  const pick = {
    transport: cfg.transport || "",
    command: cfg.command || "",
    args: (cfg.args || []).map(String),
    env: sorted(cfg.env),
    cwd: cfg.cwd || "",
    url: cfg.url || "",
    headers: sorted(cfg.headers),
    plugin: cfg.plugin || "",
  };
  return crypto.createHash("sha256").update(JSON.stringify(pick)).digest("hex");
}

const MEDIA_EXT = {
  "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/webp": "webp",
  "image/svg+xml": "svg", "image/bmp": "bmp", "audio/wav": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3",
  "audio/mp3": "mp3", "audio/ogg": "ogg", "audio/webm": "webm", "audio/mp4": "m4a", "audio/aac": "aac", "audio/flac": "flac",
};

/**
 * 一个图片/音频内容块解码落盘。返回 { path, file, mimeType, bytes }；没存成就是 { mimeType, error }。
 * root 可以是目录或返回目录的函数；不给就落当前任务的工作区。
 */
function saveMedia(c, { server, root } = {}) {
  // mimeType 是对方说的，拼进文字和文件名之前先规整：不像 MIME 的一律当二进制
  const rawType = String(c.mimeType || "").trim().toLowerCase();
  const mimeType = rawType.length <= 100 && /^[a-z0-9][\w.+-]*\/[\w.+-]+$/.test(rawType) ? rawType : "application/octet-stream";
  // 有的服务器不守规矩，塞的是整条 data: URL，把头剥掉
  const b64 = String(typeof c.data === "string" ? c.data : "").replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  if (!b64) return { mimeType, error: "服务器没给数据" };
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(b64)) return { mimeType, error: "数据不是 base64" };
  const buf = Buffer.from(b64, "base64");
  if (!buf.length) return { mimeType, error: "数据是空的" };
  try {
    const base = (typeof root === "function" ? root() : root) || workspaceRoot();
    if (!base) return { mimeType, error: "找不到工作区" };
    const dir = path.join(base, ...MEDIA_REL.split("/"));
    fs.mkdirSync(dir, { recursive: true });
    // 工作区常常就是用户自己的 git 仓库：工具吐出来的图别被顺手提交（跟 tool-results 同一个做法）
    try { fs.writeFileSync(path.join(dir, ".gitignore"), "*\n", { flag: "wx" }); } catch {}
    const sub = mimeType.split("/")[1];
    const ext = MEDIA_EXT[mimeType] || (/^[a-z0-9]{1,5}$/.test(sub) ? sub : "bin");
    const who = String(server || "mcp").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40) || "mcp";
    // 按内容起名：同一张图调十次只落一份
    const name = `${who}-${crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16)}.${ext}`;
    const file = path.join(dir, name);
    try { fs.writeFileSync(file, buf, { flag: "wx" }); } catch (e) { if (!e || e.code !== "EEXIST") throw e; }
    return { path: `${MEDIA_REL}/${name}`, file, mimeType, bytes: buf.length };
  } catch (e) {
    return { mimeType, error: (e && e.message) || String(e) };
  }
}

/** look_at_image 收得下的图（跟 src/tools/media.js 的 IMAGE_EXT 一个口径） */
const LOOKABLE = /\.(png|jpe?g|webp|gif|bmp)$/i;

/**
 * 工具结果的内容块 → 给模型看的一段文字 + 落了盘的媒体清单。
 *
 * 文字原样拼。图片（和同形状的音频）以前只剩一个 `[image]`，截图类的服务器等于白调。
 * 现在解码落到工作区 .openworkbuddy/mcp-media/，文字里给相对路径和 mimeType——
 * 图本身不进对话历史（每步重发一遍又贵，纯文本模型还会直接报错），要看内容走 look_at_image。
 */
function renderContent(blocks, { server, root } = {}) {
  const parts = [];
  const media = [];
  for (const c of Array.isArray(blocks) ? blocks : []) {
    if (!c || typeof c !== "object") continue;
    if (c.type === "text") parts.push(String(c.text == null ? "" : c.text));
    else if (c.type === "image" || c.type === "audio") {
      const what = c.type === "image" ? "图片" : "音频";
      const m = saveMedia(c, { server, root });
      if (m.path) {
        media.push(m);
        // 只对 look_at_image 认得的格式（src/tools/media.js IMAGE_EXT）提它，svg 这类提了也是白调一轮
        const canLook = c.type === "image" && LOOKABLE.test(m.path);
        parts.push(`[${what} ${m.mimeType}，已存到 ${m.path}${canLook ? "，要看内容用 look_at_image" : ""}]`);
      } else parts.push(`[${what} ${m.mimeType}，没存下来：${m.error}]`);
    } else parts.push(`[${c.type}]`);
  }
  return { text: parts.join("\n"), media };
}

/**
 * 用户点了停止：这一单不等了。抛的是这个，McpManager.call 认 stopped 标记回一句「已停止」，
 * 不说成「调用失败」——后者会让模型当故障去换参数重试，正是停止要拦的。
 */
function stoppedErr(name, method) {
  return Object.assign(new Error(`MCP ${name}.${method} 已停止`), { stopped: true });
}

/** 几路信号合成一路（Node 18 没有 AbortSignal.any）。跟 src/tools/media.js 那份同理，这里不 require 它免得绕一圈依赖 */
function anySignal(...signals) {
  const list = [...new Set(signals.filter(Boolean))];
  const ctl = new AbortController();
  const offs = [];
  const release = () => { while (offs.length) offs.pop()(); };
  const hit = list.find((s) => s.aborted);
  if (hit) ctl.abort(hit.reason);
  else {
    for (const s of list) {
      const on = () => { release(); ctl.abort(s.reason); };
      s.addEventListener("abort", on, { once: true });
      offs.push(() => s.removeEventListener("abort", on));
    }
  }
  ctl.signal.release = release;
  return ctl.signal;
}

/** 按协议告诉服务器「这一单不要了」。它可以就此停手；不理也没关系，我们已经不等了 */
const CANCELLED = "notifications/cancelled";
const cancelParams = (id) => ({ requestId: id, reason: "用户已停止" });

/**
 * 把连接失败翻译成「下一步该干什么」。
 *
 * 起因：Node 的 fetch 把所有网络层错误都压成一句 `fetch failed`，真凶埋在 e.cause.code 里。
 * 界面直接显示 e.message，用户看到的就是干巴巴一句 fetch failed——分不清是端口没开、
 * 域名写错、还是 Key 填错。飞书/QQ 那边早就改成「缺哪一半就写哪一半」了（见 app-05.js 里
 * 那段注释），MCP 连接器这条路一直没跟上，这里补上。
 *
 * 只认有把握的几种；认不出来就老老实实回原文，不硬编故事。
 */
function whyFailed(err, cfg = {}) {
  const raw = String((err && err.message) || err || "");
  const cause = (err && err.cause) || {};
  // fetch 失败时 cause 可能是 AggregateError（IPv4/IPv6 各试一次都挂了）。多数 Node 会把
  // 第一个错的 code 抬到外层，但不保证——所以再往 errors[] 里翻一层兜底。
  const code = cause.code || (Array.isArray(cause.errors) && cause.errors.length && cause.errors[0].code) || err.code || "";
  const url = cfg.url || "";
  const host = (() => { try { return new URL(url).host; } catch { return url; } })();
  const cmd = cfg.command || "";

  // —— HTTP：真凶在 cause 里 ——
  if (code === "ECONNREFUSED") {
    const local = /^(localhost|127\.0\.0\.1|\[::1\])/.test(host);
    return local
      ? `${host} 没有东西在听。这台服务要你先在本机把它跑起来，跑起来了再连`
      : `连不上 ${host}（对方拒绝连接）。确认地址端口没写错、服务确实开着`;
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `域名 ${host} 解析不了。检查地址拼写和本机 DNS／代理`;
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return `连 ${host} 超时，一直没握上手。多半是被墙、被防火墙挡了，或者要挂代理`;
  if (code === "CERT_HAS_EXPIRED") return `${host} 的证书过期了`;
  if (code === "DEPTH_ZERO_SELF_SIGNED_CERT" || code === "SELF_SIGNED_CERT_IN_CHAIN") return `${host} 用的是自签证书，Node 不认`;
  if (code === "ECONNRESET" || /socket hang up/i.test(raw)) return `跟 ${host} 的连接被中途掐断了，重试一次看看`;

  // —— HTTP 状态码：地址对了，是身份或路径的问题 ——
  const st = raw.match(/HTTP\s+(\d{3})/);
  if (st) {
    const n = +st[1];
    if (n === 401 || n === 403) return `${host} 拒绝了这次请求（${n}）。多半是 Key／令牌没填、填错或过期了`;
    if (n === 404) return `${host} 上没有这个地址（404）。对一下 MCP 端点路径，常见是少了结尾的 /mcp`;
    if (n >= 500) return `${host} 自己出错了（${n}），不是这边的问题，过会儿再试`;
  }

  // —— stdio：命令没装，是目前最常见的一种 ——
  if (code === "ENOENT" || /spawn .* ENOENT/.test(raw)) {
    const base = cmd.split("/").pop();
    const tip = base === "npx" ? "先装 Node.js" : base === "uvx" ? "先装 uv（curl -LsSf https://astral.sh/uv/install.sh | sh）" : `先把 ${base} 装上`;
    return `找不到命令 ${base || cmd}。${tip}`;
  }
  // filesystem 那类服务器把要开放的目录当参数收，路径写错时它只会甩一串 Warning + 一句
  // 英文总结。把路径捞出来单独说，比让人在 stderr 里找那行 Warning 快得多。
  if (/None of the specified directories are accessible/i.test(raw)) {
    const dirs = [...raw.matchAll(/Cannot access directory ([^,]+), skipping/gi)].map((m) => m[1].trim());
    return dirs.length
      ? `这些目录不存在或没权限读：${dirs.join("、")}。换成本机真实存在的路径再连`
      : "配给它的目录一个都打不开。检查路径拼写，中文名和空格要留意";
  }
  if (/退出码 127/.test(raw)) return `${cmd || "启动命令"} 跑起来了，但它要调的东西不在 PATH 上`;
  if (/超时/.test(raw) && /\.(initialize|tools\/list)/.test(raw)) return `连上了但迟迟没握手完。${cmd ? "第一次跑要下载依赖，可能就是慢；再试一次通常就好" : "对方没按 MCP 协议回话"}`;

  return raw || "连接失败，没拿到原因";
}

const CLIENT_INFO = { name: "openworkbuddy", version: "0.1.0" };

/** 子进程 + 按行 JSON-RPC。响应是异步回来的，所以要自己维护 id → pending 表。 */
class StdioTransport {
  constructor(name, { command, args = [], env = {}, cwd }) {
    this.name = name;
    this.command = command;
    this.args = args;
    this.env = env;
    this.cwd = cwd;
    this.nextId = 1;
    this.pending = new Map();
    this.proc = null;
    this.buf = "";
    this.errLines = []; // 最后几行 stderr —— 进程死了，这往往是唯一写着死因的地方
  }

  async open() {
    this.proc = spawn(this.command, this.args, {
      env: { ...process.env, ...this.env },
      cwd: this.cwd || undefined,
      shell: process.platform === "win32", // npx 等命令在 Windows 上需要 shell
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout.on("data", (d) => this._onData(d));
    this.proc.stderr.on("data", (d) => this._onStderr(d));
    this.proc.on("error", (e) => this._failAll(e));
    this.proc.on("close", (code, signal) => this._failAll(new Error(`MCP 服务器 ${this.name} 已退出` + this._why(code, signal))));
  }

  request(method, params, timeoutMs, signal) {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(stoppedErr(this.name, method));
      let onAbort = null;
      const settle = () => { clearTimeout(timer); if (onAbort) signal.removeEventListener("abort", onAbort); };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        settle();
        reject(new Error(`MCP ${this.name}.${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { settle(); resolve(v); },
        reject: (e) => { settle(); reject(e); },
      });
      if (signal) {
        // 停了就从 pending 里摘掉：之后它再回结果，_onData 找不到这个 id，直接丢
        onAbort = () => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          settle();
          try { this.notify(CANCELLED, cancelParams(id)); } catch {}
          reject(stoppedErr(this.name, method));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.proc.stdin.write(payload + "\n");
    });
  }

  notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  close() {
    try { this.proc && this.proc.kill(); } catch {}
  }

  _onData(d) {
    this.buf += d.toString();
    let idx;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    }
  }

  /**
   * MCP 服务器正常跑着的时候也往 stderr 打日志，所以平时不用吵。
   * 但它一旦死了，stderr 的最后几行常常是唯一写着死因的地方——比如 filesystem 那台，
   * 配的目录被删了，它打的是「Cannot access directory ... / None of the specified
   * directories are accessible」，然后退出。全丢掉的话用户只看到一句「已退出」，
   * 等于没说，只能自己去命令行手动复现一遍才知道是目录没了。
   * 只留最后 8 行、每行截断：这是死因，不是日志转发。
   */
  _onStderr(d) {
    for (const line of String(d).split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      this.errLines.push(t.slice(0, 300));
      if (this.errLines.length > 8) this.errLines.shift();
    }
  }

  /** 拼一句人能看懂的死因：怎么死的 + 它自己最后喊了什么 */
  _why(code, signal) {
    const how = signal ? `（被 ${signal} 结束）` : code ? `（退出码 ${code}）` : "";
    const tail = this.errLines.slice(-3).join(" / ");
    return how + (tail ? "：" + tail : "");
  }

  _failAll(err) {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }
}

/**
 * Streamable HTTP：一次 POST 一次请求，响应体要么是 application/json，
 * 要么是 text/event-stream（服务器爱推几条推几条，我们只取 id 对得上的那条）。
 * initialize 返回的 Mcp-Session-Id 之后每次都要带回去。
 */
class HttpTransport {
  constructor(name, { url, headers = {} }) {
    this.name = name;
    this.url = url;
    this.origin = new URL(url).origin;
    this.headers = headers;
    this.nextId = 1;
    this.sessionId = "";
  }

  async open() {}

  _headers() {
    const h = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...this.headers,
    };
    if (this.sessionId) h["Mcp-Session-Id"] = this.sessionId;
    if (this.negotiatedVersion) h["MCP-Protocol-Version"] = this.negotiatedVersion;
    return h;
  }

  async _post(body, timeoutMs, signal) {
    const resp = await fetch(this.url, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify(body),
      redirect: "manual", // 配置的 header 绝不能跟着跳转发到别的源去
      signal: signal || AbortSignal.timeout(timeoutMs),
    });
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get("location") || "";
      throw new Error(`服务器要求跳转到 ${loc}；带凭据的请求不会自动跟随跳转，请直接把 url 配成最终地址`);
    }
    return resp;
  }

  async request(method, params, timeoutMs, signal) {
    const id = this.nextId++;
    if (signal && signal.aborted) throw stoppedErr(this.name, method);
    // 时限和停止合成一路，一直挂到读完响应体为止：SSE 流可能推很久，停止得能掐断正在读的流
    const sig = anySignal(signal, AbortSignal.timeout(timeoutMs));
    try {
      const resp = await this._post({ jsonrpc: "2.0", id, method, params }, timeoutMs, sig);
      const sid = resp.headers.get("mcp-session-id");
      if (sid) this.sessionId = sid;
      if (!resp.ok) {
        const t = await resp.text().catch(() => "");
        throw new Error(`MCP ${this.name}.${method} HTTP ${resp.status}${t ? `：${t.slice(0, 200)}` : ""}`);
      }
      const ctype = (resp.headers.get("content-type") || "").toLowerCase();
      const msg = ctype.includes("text/event-stream")
        ? await this._readSse(resp, id)
        : await resp.json();
      if (!msg) throw new Error(`MCP ${this.name}.${method} 没有返回对应 id=${id} 的响应`);
      if (msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error));
      return msg.result;
    } catch (e) {
      if (!(signal && signal.aborted)) throw e;
      this.notify(CANCELLED, cancelParams(id)); // 不等它：notify 自己吞错，停止不该被一个通知拖住
      throw stoppedErr(this.name, method);
    } finally {
      sig.release();
    }
  }

  /** 读 SSE 流，直到拿到 id 匹配的那条 JSON-RPC 响应（中间的通知/日志一律丢掉） */
  async _readSse(resp, wantId) {
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return null;
        buf += dec.decode(value, { stream: true });
        let sep;
        while ((sep = buf.search(/\r?\n\r?\n/)) >= 0) {
          const block = buf.slice(0, sep);
          buf = buf.slice(sep + (buf[sep] === "\r" ? 4 : 2));
          const data = block
            .split(/\r?\n/)
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim())
            .join("\n");
          if (!data) continue;
          let m;
          try { m = JSON.parse(data); } catch { continue; }
          if (m && m.id === wantId) return m;
        }
      }
    } finally {
      try { await reader.cancel(); } catch {}
    }
  }

  async notify(method, params) {
    // 通知没有 id，服务器通常回 202 空body；失败了也不该拖垮连接
    try { await this._post({ jsonrpc: "2.0", method, params }, 15000); } catch {}
  }

  close() {}
}

class McpClient {
  constructor(name, cfg) {
    this.name = name;
    this.cfg = cfg;
    this.tools = [];
    // true = 工具表是从缓存里拿的，还没真连过。第一次调用它的工具时 McpManager 才去连（见 _wake）
    this.lazy = false;
    const isHttp = cfg.transport === "streamable-http" || (!cfg.command && cfg.url);
    this.transport = isHttp ? new HttpTransport(name, cfg) : new StdioTransport(name, cfg);
    this.kind = isHttp ? "streamable-http" : "stdio";
  }

  async start(timeoutMs = 20000) {
    await this.transport.open();
    const init = await this.transport.request(
      "initialize",
      { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
      timeoutMs
    );
    // 服务器可能协商到另一个版本，之后的 HTTP 请求要按它回的版本带头
    this.transport.negotiatedVersion = (init && init.protocolVersion) || PROTOCOL_VERSION;
    await this.transport.notify("notifications/initialized", {});
    this.tools = await this.listTools(timeoutMs);
    return this.tools;
  }

  /**
   * tools/list 按游标翻页拉全。
   *
   * 协议里工具表是分页的：回包带 nextCursor 就还有下一页。以前只取第一页，
   * 工具多的服务器第二页起全丢了，模型压根不知道还有这些工具。
   * 最多翻 MAX_TOOL_PAGES 页；到头了还有下一页、或者游标给回了同一个，记一笔日志，拿到多少用多少。
   * 同名工具只留第一个：重名进了工具表，有的模型接口整轮 400。
   */
  async listTools(timeoutMs = 20000) {
    const tools = [];
    const names = new Set();
    let cursor;
    for (let page = 1; ; page++) {
      const res = (await this.transport.request("tools/list", cursor ? { cursor } : {}, timeoutMs)) || {};
      for (const t of Array.isArray(res.tools) ? res.tools : []) {
        if (!t || !t.name || names.has(t.name)) continue;
        names.add(t.name);
        tools.push(t);
      }
      const next = typeof res.nextCursor === "string" ? res.nextCursor : "";
      if (!next) break;
      if (next === cursor) {
        console.warn(`[MCP] ${this.name} 的工具列表第 ${page} 页给回了同一个游标，不再往下翻（已拿到 ${tools.length} 个工具）`);
        break;
      }
      if (page >= MAX_TOOL_PAGES) {
        console.warn(`[MCP] ${this.name} 的工具列表翻了 ${MAX_TOOL_PAGES} 页还没完，后面的不要了（已拿到 ${tools.length} 个工具）`);
        break;
      }
      cursor = next;
    }
    return tools;
  }

  /**
   * signal 断了就发 notifications/cancelled 并立刻抛 stopped，不再等服务器的结果。
   * root：图片/音频落在哪个工作区（目录或返回目录的函数），不给就落当前任务的工作区。
   */
  async callTool(toolName, args, timeoutMs = 60000, { signal, root } = {}) {
    const res = (await this.transport.request("tools/call", { name: toolName, arguments: args }, timeoutMs, signal)) || {};
    const { text, media } = renderContent(res.content, { server: this.name, root });
    return { content: text || "(空结果)", isError: !!res.isError, ...(media.length ? { media } : {}) };
  }

  stop() {
    this.transport.close();
  }
}

/** 用户点了停止时 McpManager.call 回的那一条（调用中途停、第一次调用还在连的时候停，都是它） */
const STOPPED_RESULT = () => ({ content: "用户已停止任务，没等这个 MCP 工具的结果。", isError: true, stopped: true });
const STOPPED = Symbol("stopped");
/** _wake 连的这会儿，这台被停掉或被同名的顶掉了：不算「连不上」，call 按表里现在那台重来 */
const GONE = Symbol("gone");

class McpManager {
  /**
   * root：工具表缓存和图片落在哪个目录的 .openworkbuddy/ 底下（目录或返回目录的函数）。
   * 不给就跟着工作区走（见 workspaceRoot）。测试给一个临时目录，别往用户真的工作区里写。
   */
  constructor({ root } = {}) {
    this.root = root || null;
    this.clients = new Map(); // serverName -> McpClient（lazy 的那几台也在里头：工具表是缓存的，还没真连）
    this.failures = []; // [{ name, plugin, error }] 起不来的服务器，界面要能看见为什么
    /**
     * 被用户手动关掉的服务器名。
     *
     * 为什么不是每条配置上的一个 enabled 字段：插件带来的连接器根本不在 config.mcp_servers 里，
     * 那条路上没有地方挂字段；而「今天先别连这台」对插件连接器和自配连接器是同一件事。
     * 所以只存一张名字表（server.js 落到 config.mcp_disabled），两种来源共用。
     *
     * 关掉 ≠ 删掉：配置、密钥、参数全都留着，只是这一轮不去连它，工具表里也不出现——
     * 出现了模型就会去调，调到一半才发现连不上，白烧一轮。
     */
    this.disabled = new Set();
  }

  /** 哪些服务器现在是关着的（server.js 从 config.mcp_disabled 灌进来） */
  setDisabled(names = []) {
    this.disabled = new Set((names || []).map(String));
    return this.disabled;
  }

  /**
   * 启动配置的 MCP 服务器。一台起不来只记一笔继续下一台——
   * Agent Plugins 规范也是这么要求的：单个服务器失败不许影响其他组件。
   *
   * 不再一开机就把每台都连一遍：以前开机并发拉起全部服务器，npx 那几台一台一个 node 进程，
   * 用户这一趟可能一个连接器工具都不用。现在读上次连上时记下的工具表（.openworkbuddy/mcp-tools-cache.json），
   * 配置没变的直接挂进工具表，等模型第一次调它的工具时再连（见 _wake）。
   * 缓存里没有、或配置改过（指纹对不上）的当场连：新加的、改过的连接器要立刻知道通不通。
   * 界面上保存、开关、更新插件之前都会先 stop()，stop 连缓存那条一起清，所以这几条路（测试连接）照旧当场连。
   */
  async startAll(serverConfigs = []) {
    const cache = this._readCache();
    // 同一批里重名的，后面那条算数（跟以前「后起的顶掉先起的」一个结果）
    const plan = new Map();
    for (const cfg of serverConfigs) { plan.delete(cfg.name); plan.set(cfg.name, cfg); }
    const now = [];
    for (const cfg of plan.values()) {
      // 同名的先停掉再起，否则旧的子进程没人管，成了孤儿还占着端口/句柄。
      // 走 _drop 不走 stop：stop 会把缓存那条一起清，开机这一路就永远用不上缓存了
      this._drop([cfg.name]);
      // 用户在 ＋ 菜单里把这台关了。停在 _drop 之后、new McpClient 之前：
      // 先停是为了「开着的时候被关掉」这一路真的能把进程收掉，再 continue 才是不去连它。
      if (this.disabled.has(cfg.name)) continue;
      const client = new McpClient(cfg.name, cfg);
      client.plugin = cfg.plugin || "";
      const hit = cache[cfg.name];
      if (hit && hit.fp === cfgFingerprint(cfg) && Array.isArray(hit.tools)) {
        // 缓存文件谁都能改：混进一条 null，toolDefs 取 t.name 就抛，每一单任务开头都挂
        client.tools = hit.tools.filter((t) => t && typeof t === "object" && t.name);
        client.lazy = true;
        this.clients.set(cfg.name, client);
        console.log(`[MCP] ${cfg.plugin ? `插件 ${cfg.plugin} · ` : ""}${cfg.name}(${client.kind}) 先用上次记下的 ${hit.tools.length} 个工具，第一次调用时再连`);
      } else now.push(client);
    }
    for (const client of now) {
      const cfg = client.cfg;
      try {
        const tools = await client.start();
        this.clients.set(cfg.name, client);
        this._remember(client);
        const from = cfg.plugin ? `插件 ${cfg.plugin} · ` : "";
        console.log(`[MCP] ${from}${cfg.name}(${client.kind}) 已连接，提供 ${tools.length} 个工具: ${tools.map((t) => t.name).join(", ")}`);
      } catch (e) {
        this._failed(cfg, e);
        client.stop();
      }
    }
  }

  /**
   * 连不上：记一笔失败（界面要看得见为什么），缓存里那条也删掉——
   * 下次开机就当场连、当场报错，不再拿一份旧工具表哄模型去调一台连不上的服务器。返回翻译过的那句。
   */
  _failed(cfg, e) {
    // 存翻译过的那句：界面上显示的就是这条，e.message 原文对用户没有信息量
    const why = whyFailed(e, cfg);
    console.warn(`[MCP] ${cfg.name} 连接失败: ${why}${why === e.message ? "" : `（原文 ${e.message}）`}`);
    this.failures.push({ name: cfg.name, plugin: cfg.plugin || "", error: why, raw: e.message });
    this._forget([cfg.name]);
    return why;
  }

  /**
   * 缓存来的那台，第一次调用时才真去连。同一台同时来几次调用只连一次。
   * 返回 ""=连上了；STOPPED=用户在等的时候点了停止（连接照样在后台连完，下次直接用）；
   * GONE=连的这会儿它被停掉或被同名的顶掉了（工具表里的已经不是它）；
   * 别的字符串=没连上的原因——这时它已经从工具表里摘掉、记进了失败清单。
   */
  _wake(client, signal) {
    if (!client._waking) {
      client._waking = (async () => {
        try {
          const tools = await client.start();
          client.lazy = false;
          // 连的这会儿被停掉或被同名的顶掉了：这一个就别留了，免得成孤儿
          if (this.clients.get(client.name) !== client) {
            client.stop();
            return GONE;
          }
          this._remember(client); // 服务器那边工具可能增减过，按刚拿到的这份重记
          console.log(`[MCP] ${client.name}(${client.kind}) 第一次调用，已连上，提供 ${tools.length} 个工具`);
          return "";
        } catch (e) {
          client.stop();
          // 多半就是被停掉时进程被收了才连不上的：不记失败、不删缓存，那是停掉/顶掉它的那一路的事
          if (this.clients.get(client.name) !== client) return GONE;
          this.clients.delete(client.name);
          return this._failed(client.cfg, e);
        } finally {
          client._waking = null;
        }
      })();
    }
    const waking = client._waking;
    if (!signal) return waking;
    if (signal.aborted) return Promise.resolve(STOPPED);
    return new Promise((resolve) => {
      const onAbort = () => resolve(STOPPED);
      signal.addEventListener("abort", onAbort, { once: true });
      waking.then((v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      });
    });
  }

  /** 工具表缓存文件。拿不到工作区就是 ""——那就不用缓存，每次照旧当场连 */
  _cacheFile() {
    const r = typeof this.root === "function" ? this.root() : this.root;
    const base = r || workspaceRoot("default");
    return base ? path.join(base, ...TOOLS_CACHE_REL.split("/")) : "";
  }

  /** { 服务器名: { fp, transport, tools, at } }。没有、坏了都当空的：代价只是这次开机老老实实连一遍 */
  _readCache() {
    const f = this._cacheFile();
    if (!f) return {};
    try {
      const j = JSON.parse(fs.readFileSync(f, "utf8"));
      return j && j.version === 1 && j.servers && typeof j.servers === "object" ? j.servers : {};
    } catch {
      return {};
    }
  }

  /** 读-改-写一遍缓存。mutate 返回 false 表示没改，不写盘。写不成只告警：缓存丢了不影响使用 */
  _writeCache(mutate) {
    const f = this._cacheFile();
    if (!f) return;
    try {
      const servers = this._readCache();
      if (mutate(servers) === false) return;
      fs.mkdirSync(path.dirname(f), { recursive: true });
      // 先写临时文件再改名：开机那一下读到的要么是旧的要么是新的，不会是半个
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, servers }));
      fs.renameSync(tmp, f);
    } catch (e) {
      console.warn(`[MCP] 工具表缓存没写成（不影响使用，下次开机照常连）: ${e.message}`);
    }
  }

  _remember(client) {
    this._writeCache((s) => {
      s[client.name] = { fp: cfgFingerprint(client.cfg), transport: client.kind, tools: client.tools, at: new Date().toISOString() };
    });
  }

  _forget(names = []) {
    if (!names.length) return;
    this._writeCache((s) => {
      const hit = names.filter((n) => Object.prototype.hasOwnProperty.call(s, n));
      for (const n of hit) delete s[n];
      return hit.length > 0;
    });
  }

  /**
   * 停掉指定的几台服务器，并把它们上一次的失败记录和缓存的工具表一并清掉。
   * 不清失败记录的话，重试成功了连接器页面还挂着那条旧的红字。
   * 清缓存是因为走到这儿的都是用户动手（保存、关掉、更新/卸载插件）：接下来再起就该当场连一次，
   * 而不是拿旧工具表糊过去。关应用走 stopAll，那条不清缓存，下次开机才用得上。
   */
  stop(names = []) {
    const stopped = this._drop(names);
    this._forget([...new Set(names)]);
    return stopped;
  }

  /** 只停进程、清失败记录，不碰缓存 */
  _drop(names = []) {
    const want = new Set(names);
    const stopped = [];
    for (const n of want) {
      const c = this.clients.get(n);
      if (!c) continue;
      try {
        c.stop();
      } catch (e) {
        console.warn(`[MCP] ${n} 停止时报错（忽略）: ${e.message}`);
      }
      this.clients.delete(n);
      stopped.push(n);
    }
    this.failures = this.failures.filter((f) => !want.has(f.name));
    return stopped;
  }

  /** 停掉某个插件带来的全部服务器（卸载插件时用） */
  stopPlugin(pluginName) {
    const names = [...this.clients.values()].filter((c) => c.plugin === pluginName).map((c) => c.name);
    const stopped = this.stop(names);
    this.failures = this.failures.filter((f) => f.plugin !== pluginName);
    return stopped;
  }

  /**
   * 已连接的服务器概况（名字 / 传输 / 工具数 / 来源插件）。
   * lazy=true：工具表是缓存的，还没真连过，第一次调用时才连。
   */
  status() {
    return {
      connected: [...this.clients.values()].map((c) => ({ name: c.name, transport: c.kind, tools: c.tools.length, plugin: c.plugin || "", lazy: !!c.lazy })),
      failures: this.failures,
    };
  }

  /** 转换为 agent 统一工具定义（命名 mcp__server__tool） */
  toolDefs() {
    const defs = [];
    for (const [server, client] of this.clients) {
      for (const t of client.tools) {
        defs.push({
          name: `mcp__${server}__${t.name}`,
          description: `[MCP:${server}] ${t.description || t.name}`,
          input_schema: t.inputSchema || { type: "object", properties: {} },
        });
      }
    }
    return defs;
  }

  isMcpTool(name) {
    return name.startsWith("mcp__");
  }

  async call(fullName, input, { signal } = {}) {
    const m = fullName.match(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/);
    if (!m) return { content: `无效的 MCP 工具名: ${fullName}`, isError: true };
    const client = this.clients.get(m[1]);
    if (!client) return { content: `MCP 服务器未连接: ${m[1]}`, isError: true };
    if (client.lazy) {
      // 已经点了停止就别再去拉起它：npx 那种一拉就是一个进程，这一单又用不上
      if (signal && signal.aborted) return STOPPED_RESULT();
      const why = await this._wake(client, signal);
      if (why === STOPPED) return STOPPED_RESULT();
      if (why === GONE) {
        // 被同名的顶掉了（比如刚保存过连接器）：交给表里现在那台；被停掉了就是没连。
        // 别说成「连不上、别再调」——那台好好的，模型会就此绕开一个能用的连接器
        const now = this.clients.get(m[1]);
        return now && now !== client ? this.call(fullName, input, { signal }) : { content: `MCP 服务器未连接: ${m[1]}`, isError: true };
      }
      // 连不上的那台已经从工具表里摘掉了：明说别再调，不然模型会换着参数重试一台根本连不上的服务器
      if (why) return { content: `MCP 服务器 ${m[1]} 第一次调用时去连，没连上：${why}。它的工具已从工具表里摘掉，别再调了`, isError: true };
    }
    try {
      return await client.callTool(m[2], input, undefined, { signal, root: this.root || undefined });
    } catch (e) {
      if (e.stopped) return STOPPED_RESULT();
      return { content: `MCP 调用失败: ${e.message}`, isError: true };
    }
  }

  /** 关应用时收摊：只停进程，缓存留着，下次开机才用得上 */
  stopAll() {
    return this._drop([...this.clients.keys()]);
  }
}

module.exports = {
  McpManager, McpClient, StdioTransport, HttpTransport, PROTOCOL_VERSION, whyFailed,
  renderContent, cfgFingerprint, MAX_TOOL_PAGES, TOOLS_CACHE_REL, MEDIA_REL,
};
