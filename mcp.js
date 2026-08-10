"use strict";
/**
 * MCP 连接器 — Model Context Protocol 客户端（stdio 传输）。
 * 在 config.json 的 mcp_servers 里配置：
 *   [{ "name": "filesystem", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:/data"] }]
 * 服务器暴露的工具会自动注入 agent 工具列表，命名为 mcp__<服务器名>__<工具名>。
 */

const { spawn } = require("child_process");

class McpClient {
  constructor(name, { command, args = [], env = {} }) {
    this.name = name;
    this.command = command;
    this.args = args;
    this.env = env;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject}
    this.tools = [];
    this.proc = null;
    this.buf = "";
  }

  async start(timeoutMs = 20000) {
    this.proc = spawn(this.command, this.args, {
      env: { ...process.env, ...this.env },
      shell: process.platform === "win32", // npx 等命令在 Windows 上需要 shell
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout.on("data", (d) => this._onData(d));
    this.proc.stderr.on("data", () => {}); // MCP 服务器常向 stderr 打日志，忽略
    this.proc.on("error", (e) => this._failAll(e));
    this.proc.on("close", () => this._failAll(new Error(`MCP 服务器 ${this.name} 已退出`)));

    await this._request(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "openbuddy", version: "0.1.0" },
      },
      timeoutMs
    );
    this._notify("notifications/initialized", {});
    const res = await this._request("tools/list", {}, timeoutMs);
    this.tools = res.tools || [];
    return this.tools;
  }

  async callTool(toolName, args, timeoutMs = 60000) {
    const res = await this._request("tools/call", { name: toolName, arguments: args }, timeoutMs);
    const parts = (res.content || []).map((c) => {
      if (c.type === "text") return c.text;
      return `[${c.type}]`;
    });
    return { content: parts.join("\n") || "(空结果)", isError: !!res.isError };
  }

  stop() {
    try {
      this.proc && this.proc.kill();
    } catch {}
  }

  _onData(d) {
    this.buf += d.toString();
    let idx;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    }
  }

  _request(method, params, timeoutMs) {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${this.name}.${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.proc.stdin.write(payload + "\n");
    });
  }

  _notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  _failAll(err) {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }
}

class McpManager {
  constructor() {
    this.clients = new Map(); // serverName -> McpClient
  }

  /** 启动所有配置的 MCP 服务器，失败的单独告警不影响整体。 */
  async startAll(serverConfigs = []) {
    for (const cfg of serverConfigs) {
      const client = new McpClient(cfg.name, cfg);
      try {
        const tools = await client.start();
        this.clients.set(cfg.name, client);
        console.log(`[MCP] ${cfg.name} 已连接，提供 ${tools.length} 个工具: ${tools.map((t) => t.name).join(", ")}`);
      } catch (e) {
        console.warn(`[MCP] ${cfg.name} 连接失败: ${e.message}`);
        client.stop();
      }
    }
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
    for (const c of this.clients.values()) c.stop();
  }
}

module.exports = { McpManager };
