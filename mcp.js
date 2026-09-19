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
 */

const { spawn } = require("child_process");

const PROTOCOL_VERSION = "2025-06-18";

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

  request(method, params, timeoutMs) {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${this.name}.${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
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

  async _post(body, timeoutMs) {
    const resp = await fetch(this.url, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify(body),
      redirect: "manual", // 配置的 header 绝不能跟着跳转发到别的源去
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get("location") || "";
      throw new Error(`服务器要求跳转到 ${loc}；带凭据的请求不会自动跟随跳转，请直接把 url 配成最终地址`);
    }
    return resp;
  }

  async request(method, params, timeoutMs) {
    const id = this.nextId++;
    const resp = await this._post({ jsonrpc: "2.0", id, method, params }, timeoutMs);
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
    const res = await this.transport.request("tools/list", {}, timeoutMs);
    this.tools = res.tools || [];
    return this.tools;
  }

  async callTool(toolName, args, timeoutMs = 60000) {
    const res = await this.transport.request("tools/call", { name: toolName, arguments: args }, timeoutMs);
    const parts = (res.content || []).map((c) => (c.type === "text" ? c.text : `[${c.type}]`));
    return { content: parts.join("\n") || "(空结果)", isError: !!res.isError };
  }

  stop() {
    this.transport.close();
  }
}

class McpManager {
  constructor() {
    this.clients = new Map(); // serverName -> McpClient
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
   * 启动所有配置的 MCP 服务器。一台起不来只记一笔继续下一台——
   * Agent Plugins 规范也是这么要求的：单个服务器失败不许影响其他组件。
   */
  async startAll(serverConfigs = []) {
    for (const cfg of serverConfigs) {
      // 同名的先停掉再起，否则旧的子进程没人管，成了孤儿还占着端口/句柄
      this.stop([cfg.name]);
      // 用户在 ＋ 菜单里把这台关了。停在 stop 之后、new McpClient 之前：
      // 先停是为了「开着的时候被关掉」这一路真的能把进程收掉，再 continue 才是不去连它。
      if (this.disabled.has(cfg.name)) continue;
      const client = new McpClient(cfg.name, cfg);
      try {
        const tools = await client.start();
        client.plugin = cfg.plugin || "";
        this.clients.set(cfg.name, client);
        const from = cfg.plugin ? `插件 ${cfg.plugin} · ` : "";
        console.log(`[MCP] ${from}${cfg.name}(${client.kind}) 已连接，提供 ${tools.length} 个工具: ${tools.map((t) => t.name).join(", ")}`);
      } catch (e) {
        // 存翻译过的那句：界面上显示的就是这条，e.message 原文对用户没有信息量
        const why = whyFailed(e, cfg);
        console.warn(`[MCP] ${cfg.name} 连接失败: ${why}${why === e.message ? "" : `（原文 ${e.message}）`}`);
        this.failures.push({ name: cfg.name, plugin: cfg.plugin || "", error: why, raw: e.message });
        client.stop();
      }
    }
  }

  /**
   * 停掉指定的几台服务器，并把它们上一次的失败记录一并清掉。
   * 不清失败记录的话，重试成功了连接器页面还挂着那条旧的红字。
   */
  stop(names = []) {
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

  /** 已连接的服务器概况（名字 / 传输 / 工具数 / 来源插件） */
  status() {
    return {
      connected: [...this.clients.values()].map((c) => ({ name: c.name, transport: c.kind, tools: c.tools.length, plugin: c.plugin || "" })),
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

  async call(fullName, input) {
    const m = fullName.match(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/);
    if (!m) return { content: `无效的 MCP 工具名: ${fullName}`, isError: true };
    const client = this.clients.get(m[1]);
    if (!client) return { content: `MCP 服务器未连接: ${m[1]}`, isError: true };
    try {
      return await client.callTool(m[2], input);
    } catch (e) {
      return { content: `MCP 调用失败: ${e.message}`, isError: true };
    }
  }

  stopAll() {
    return this.stop([...this.clients.keys()]);
  }
}

module.exports = { McpManager, McpClient, StdioTransport, HttpTransport, PROTOCOL_VERSION, whyFailed };
