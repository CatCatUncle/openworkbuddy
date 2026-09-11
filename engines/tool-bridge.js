"use strict";
/**
 * 把 OpenWorkBuddy 自己的工具，借给本机 CLI 引擎用。
 *
 * 这是「用本地 Claude Code 接管之后，生图/视频/技能全没了」的解法。
 * 用户的原话是：「本会话依旧没有任何生图工具，所以还是生不出来。」——他没说错。
 * `claude -p` / `codex exec` 是完整的 agent，自带 Read/Write/Bash/WebSearch，
 * 但它们手上**没有**本项目配的那套：生图接口、视频接口、TTS、图表渲染、
 * 网页截图、看图、技能库、长期记忆。切到本机引擎等于把这些全丢了，
 * 于是模型只能一遍遍在交付里写「图生不出来，请你自己放进去」。
 *
 * 两个 CLI 都只认一种扩展方式：MCP。所以这个文件是一台**stdio MCP 服务器**，
 * 由 CLI 作为子进程拉起，把工具调用原路转回 tools.js 的 executeTool。
 * 好处是本项目的安全中心、成果子目录、水印剥除、重试，全都照常生效——
 * 不是复制一份实现，是同一份实现换了个调用入口。
 *
 * 只借 CLI 确实没有的那些。run_shell / write_file / read_file 这类一概不借：
 * CLI 自带的版本更好用，重复挂上去只会占它的上下文，还让模型在两套同名工具间犹豫。
 *
 * 环境变量（由 engines/bridge.js 拼好后传进来）：
 *   OPENWORKBUDDY_HOME  数据根目录（config.json / workspace 都在这儿找）
 *   WB_BRIDGE_BASEDIR   本次对话的成果子目录（相对 workspace），产物落这里
 *   WB_BRIDGE_TOOLS     借出去的工具名，逗号分隔
 *   WB_BRIDGE_USER      当前用户名（记忆按人隔离用）
 *
 * 协议：换行分隔的 JSON-RPC，跟 mcp.js 那台客户端用的是同一种框法。
 *
 * 还有第二条路：命令行。MCP 不是每次都靠得住——codex 接到非 OpenAI 模型上时
 * （用户的 config.toml 里 model_provider 指向别家），它连一个 MCP 工具都不往
 * 模型手里挂；我们这台服务器的 initialize / tools/list 全答了也没用。
 * 但两个 CLI 都有 shell。所以同一份实现再开一个命令行入口：
 *     node tool-bridge.js list
 *     node tool-bridge.js call <工具名> '<json>'      # 也收 @文件 和 -（stdin）
 * engines/bridge.js 会把环境变量烘进一个叫 owb 的小脚本，
 * 提示词里直接给模型这条命令。MCP 挂不上时它照样能生图。
 *
 * ⚠️ stdout 是协议通道，一个字节的杂音都会让 CLI 认为服务器坏了。
 *    tools.js 里到处都有 console.log/warn，所以启动第一件事就是把它们全改道 stderr。
 */

const path = require("path");
const fs = require("fs");

// —— 先改道，再 require 任何会打日志的模块 ——
const toErr = (...a) => { try { process.stderr.write(a.map(String).join(" ") + "\n"); } catch {} };
console.log = toErr;
console.info = toErr;
console.warn = toErr;
console.debug = toErr;

const { dataPath } = require("../paths");
const tools = require("../tools");
const mediaModels = require("../media-models");

const PROTOCOL_VERSION = "2025-06-18";

/** 借给 CLI 的工具白名单。改这里就是改「本机引擎能用到本项目的什么」。 */
const LENDABLE = [
  "generate_image",   // 生图：CLI 没有，用户最常撞的就是这条
  "generate_video",   // 生视频
  "text_to_speech",   // 配音
  "html_to_image",    // 网页转长图/封面
  "gen_diagram",      // mermaid / echarts / graphviz 出图
  "look_at_image",    // 看图（CLI 在无头管道里读不了本地图片）
  "render_page",      // 带 JS 渲染后取正文
  "check_page",       // 打开做好的网页，看控制台报错和实际效果
  "web_search",       // 走本项目配的搜索渠道
  "library_list",     // 技能库：有哪些
  "library_read",     // 技能库：把某个技能的正文读出来
  "save_skill",       // 这次趟出来的做法存成技能
  "remember",         // 长期记忆：记
  "forget",           // 长期记忆：忘
];

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(dataPath("config.json"), "utf8")); }
  catch { return {}; }
}

const config = loadConfig();
const BASE_DIR = process.env.WB_BRIDGE_BASEDIR || "";
const USER = process.env.WB_BRIDGE_USER || "";
const ALLOW = new Set(
  String(process.env.WB_BRIDGE_TOOLS || LENDABLE.join(","))
    .split(",").map((s) => s.trim()).filter(Boolean)
);

/** 白名单 ∩ 本项目真有的工具。名字对不上就不挂——挂一个调不通的比没有更糟。 */
function lentDefs() {
  return tools.TOOL_DEFS.filter((d) => ALLOW.has(d.name) && LENDABLE.includes(d.name));
}

/**
 * MCP 的 tools/list 要的是 inputSchema（小驼峰），本项目内部用的是 input_schema。
 * 名字前面不加前缀：CLI 自己会挂成 mcp__openworkbuddy__<name>，再加一层只会更长。
 */
function listTools() {
  return lentDefs().map((d) => ({
    name: d.name,
    description: d.description,
    inputSchema: d.input_schema || { type: "object", properties: {} },
  }));
}

async function callTool(name, args) {
  if (!ALLOW.has(name)) throw new Error(`工具 ${name} 没有借给本机引擎`);
  const r = await tools.executeTool(name, args || {}, {
    knownTools: [...ALLOW],
    timeoutMs: ((config.agent || {}).tool_timeout_ms) || 120000,
    search: config.search,
    media: mediaModels.resolve(config),
    security: config.security,
    baseDir: BASE_DIR,
    memory: { user: USER },
  });
  const text = typeof r === "string" ? r : String((r && r.content) != null ? r.content : JSON.stringify(r));
  return { content: [{ type: "text", text }], isError: !!(r && r.isError) };
}

// ---- JSON-RPC over stdio ----

function send(msg) {
  log(">>", msg);
  process.stdout.write(JSON.stringify(msg) + "\n");
}

let inFlight = 0;   // 还没回复的请求数
let stdinEnded = false;

/** stdin 关了不等于可以走人：生图/视频动辄几十秒，这时候退出等于把结果吞了 */
function exitIfIdle() {
  if (stdinEnded && inFlight === 0) process.exit(0);
}


/** 排障用：WB_BRIDGE_LOG=/path/x.log 时把每一条收发都记下来。
 *  「工具挂上了但模型看不见」这种问题，不看真实的 JSON-RPC 往返就只能靠猜。 */
const LOG = process.env.WB_BRIDGE_LOG || "";
function log(dir, obj) {
  if (!LOG) return;
  try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${dir} ${JSON.stringify(obj).slice(0, 4000)}\n`); } catch {}
}

async function handle(msg) {
  log("<<", msg);
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  if (isRequest) inFlight += 1;
  try {
    let result;
    switch (method) {
      case "initialize":
        result = {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "openworkbuddy", version: "0.1.0" },
        };
        break;
      case "notifications/initialized":
      case "notifications/cancelled":
        return; // 通知没有 id，不回（finally 会把计数还回去）
      case "ping":
        result = {};
        break;
      case "tools/list":
        result = { tools: listTools() };
        break;
      case "tools/call":
        result = await callTool((params || {}).name, (params || {}).arguments);
        break;
      default:
        if (!isRequest) return;
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `不支持的方法：${method}` } });
        return;
    }
    if (isRequest) send({ jsonrpc: "2.0", id, result });
  } catch (e) {
    const message = String((e && e.message) || e).slice(0, 800);
    // 工具跑挂了不是协议错误：按 MCP 的约定回一条 isError 的结果，
    // 让模型看到人话（「图像模型未配置」这种），它才知道下一步该干什么。
    if (isRequest && method === "tools/call") {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: message }], isError: true } });
    } else if (isRequest) {
      send({ jsonrpc: "2.0", id, error: { code: -32603, message } });
    }
  } finally {
    if (isRequest) inFlight -= 1;
    exitIfIdle();
  }
}

function main() {
  // 工作区必须先对齐，否则 executeTool 会把产物写到默认 workspace 根目录去
  tools.setWorkspaceDir(dataPath("workspace"));
  if (BASE_DIR) {
    try { fs.mkdirSync(path.join(dataPath("workspace"), BASE_DIR), { recursive: true }); } catch {}
  }
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      handle(msg);
    }
  });
  process.stdin.on("end", () => { stdinEnded = true; exitIfIdle(); });
}

// ---- 第二条路：命令行入口 ----

/** 参数可以是内联 JSON、@文件、或者 -（从 stdin 读）。长提示词走后两种，省得跟 shell 引号打架。 */
function readArgs(raw) {
  if (raw == null || raw === "") return {};
  let text = raw;
  if (raw === "-") text = fs.readFileSync(0, "utf8");
  else if (raw.startsWith("@")) text = fs.readFileSync(raw.slice(1), "utf8");
  text = String(text).trim();
  if (!text) return {};
  try { return JSON.parse(text); } catch (e) { throw new Error(`参数不是合法 JSON：${e.message}`); }
}

/** `owb list` 打给模型看的清单：名字 + 一句话 + 必填参数，够它照着拼调用了 */
function cliList() {
  const lines = lentDefs().map((d) => {
    const req = ((d.input_schema || {}).required || []).join(", ");
    const one = String(d.description || "").split("\n")[0].slice(0, 90);
    return `${d.name}${req ? `  [必填：${req}]` : ""}\n    ${one}`;
  });
  return lines.length ? lines.join("\n") : "（这次没借出任何工具）";
}

async function cli(argv) {
  tools.setWorkspaceDir(dataPath("workspace"));
  if (BASE_DIR) { try { fs.mkdirSync(path.join(dataPath("workspace"), BASE_DIR), { recursive: true }); } catch {} }
  let [cmd, ...rest] = argv;
  if (cmd === "call") [cmd, ...rest] = rest; // `call x` 和直接 `x` 都收
  if (!cmd || cmd === "list" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(cliList() + "\n");
    return 0;
  }
  const r = await callTool(cmd, readArgs(rest[0]));
  process.stdout.write((r.content[0].text || "") + "\n");
  return r.isError ? 1 : 0;
}

if (require.main === module) {
  if (process.argv.length > 2) {
    // 命令行模式下 stdout 不再是协议通道，但 tools.js 的日志仍然只该去 stderr，
    // 免得混进给模型看的结果里。所以上面那几个 console 改道保持不变。
    cli(process.argv.slice(2))
      .then((code) => process.exit(code))
      .catch((e) => { process.stderr.write(String((e && e.message) || e) + "\n"); process.exit(1); });
  } else {
    main();
  }
}

module.exports = { LENDABLE, listTools, callTool, handle, cli, cliList, readArgs, _internals: { lentDefs } };
