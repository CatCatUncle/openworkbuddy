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
  }

  async open() {
    this.proc = spawn(this.command, this.args, {
      env: { ...process.env, ...this.env },
      cwd: this.cwd || undefined,
      shell: process.platform === "win32", // npx 等命令在 Windows 上需要 shell
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout.on("data", (d) => this._onData(d));
    this.proc.stderr.on("data", () => {}); // MCP 服务器常向 stderr 打日志，忽略
    this.proc.on("error", (e) => this._failAll(e));
    this.proc.on("close", () => this._failAll(new Error(`MCP 服务器 ${this.name} 已退出`)));
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
  }

  /**
   * 启动所有配置的 MCP 服务器。一台起不来只记一笔继续下一台——
   * Agent Plugins 规范也是这么要求的：单个服务器失败不许影响其他组件。
   */
  async startAll(serverConfigs = []) {
    for (const cfg of serverConfigs) {
      // 同名的先停掉再起，否则旧的子进程没人管，成了孤儿还占着端口/句柄
      this.stop([cfg.name]);
      const client = new McpClient(cfg.name, cfg);
      try {
        const tools = await client.start();
        client.plugin = cfg.plugin || "";
        this.clients.set(cfg.name, client);
        const from = cfg.plugin ? `插件 ${cfg.plugin} · ` : "";
        console.log(`[MCP] ${from}${cfg.name}(${client.kind}) 已连接，提供 ${tools.length} 个工具: ${tools.map((t) => t.name).join(", ")}`);
      } catch (e) {
        console.warn(`[MCP] ${cfg.name} 连接失败: ${e.message}`);
        this.failures.push({ name: cfg.name, plugin: cfg.plugin || "", error: e.message });
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

module.exports = { McpManager, McpClient, StdioTransport, HttpTransport, PROTOCOL_VERSION };
