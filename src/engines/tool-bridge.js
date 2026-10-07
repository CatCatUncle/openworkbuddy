// @ts-check
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 把 OpenWorkBuddy 自己的工具，借给本机 CLI 引擎用。
 *
 * 这是「用本地 Claude Code 接管之后，生图/视频/技能全没了」的解法。
 * 症状是模型自己交代的：本会话没有任何生图工具，所以生不出来——它没说错。
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
 * 环境变量（由 src/engines/bridge.js 拼好后传进来）：
 *   OPENWORKBUDDY_HOME  数据根目录（config.json 在这儿找）
 *   OPENWORKBUDDY_BRIDGE_ROOT      这趟任务的工作区根（租户、项目各有各的根）。给了却用不了就不启动，
 *                                  不退回默认根；没给是老调用方，认设置里的 workspace_dir，再不行用数据目录下的 workspace
 *   OPENWORKBUDDY_BRIDGE_BASEDIR   本次对话的成果子目录（相对上面那个根），产物落这里
 *   OPENWORKBUDDY_BRIDGE_LIB_ROOT  这个人的资料库根（多账号时一人一份）；没给 = 数据目录下那份
 *   OPENWORKBUDDY_BRIDGE_LIB_MOUNT 当前项目只挂了资料库的哪一块；没给 = 整个库
 *   OPENWORKBUDDY_BRIDGE_TOOLS     借出去的工具名，逗号分隔；一个不借时是「-」。缺了这个变量不启动
 *   OPENWORKBUDDY_BRIDGE_USER      当前用户名（记忆按人隔离用）
 *
 * 协议：换行分隔的 JSON-RPC，跟 mcp.js 那台客户端用的是同一种框法。
 *
 * 还有第二条路：命令行。MCP 不是每次都靠得住——codex 接到非 OpenAI 模型上时
 * （用户的 config.toml 里 model_provider 指向别家），它连一个 MCP 工具都不往
 * 模型手里挂；我们这台服务器的 initialize / tools/list 全答了也没用。
 * 但两个 CLI 都有 shell。所以同一份实现再开一个命令行入口：
 *     node tool-bridge.js list
 *     node tool-bridge.js call <工具名> '<json>'      # 也收 @文件 和 -（stdin）
 * src/engines/bridge.js 会把环境变量烘进一个叫 owb 的小脚本，
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

const { dataPath } = require("../platform/paths");
const tools = require("../agent/tools");
const security = require("../core/safety/security");
const mediaModels = require("../core/model/media-models");

const PROTOCOL_VERSION = "2025-06-18";

// 名单只此一份，在 lendable.js；这里再导出一次只是给老测试用
const { LENDABLE, NEEDS_RENDERER, lentFor, parseList } = require("./lendable");

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(dataPath("config.json"), "utf8")); }
  catch { return {}; }
}

const config = loadConfig();
const ROOT = process.env.OPENWORKBUDDY_BRIDGE_ROOT;
const BASE_DIR = process.env.OPENWORKBUDDY_BRIDGE_BASEDIR || "";
const USER = process.env.OPENWORKBUDDY_BRIDGE_USER || "";
const LIB_ROOT = process.env.OPENWORKBUDDY_BRIDGE_LIB_ROOT;
const LIB_MOUNT = process.env.OPENWORKBUDDY_BRIDGE_LIB_MOUNT || "";
// 借哪些由主进程定：bridge.js 每次都写这个变量，一个不借时也写（值是 lendable.NONE）。
// 被拉起时没拿到它，就不是 bridge.js 拉的，按整张表兜底等于把关掉的工具又借出去，所以报错退出（见文件末尾）。
// 被测试 require 进来时没有它，按整张表算。不在 LENDABLE 里的名字一律不认。
const TOOLS_ENV = process.env.OPENWORKBUDDY_BRIDGE_TOOLS;
const ALLOW = new Set(TOOLS_ENV === undefined ? LENDABLE : lentFor({ tools: parseList(TOOLS_ENV) }));

// 只借给外部引擎、本项目自己的模型看不到的工具定义。
//
// render_page 从 TOOL_DEFS 里删掉了，因为对本项目的模型来说它是道纯粹的选择题：同一件事
// fetch_url 带 render:"force" 就做了，多一个名字只会让它每次抓网页都先挑一遍。
// 但外部 CLI 引擎（Claude Code / Codex）手上没有本项目的 fetch_url——它们自带的抓网页工具
// 不跑 JS，动态站点一律空壳。对它们来说这儿根本没有选择题，少借一个就是真少一样能力。
// 执行走的还是 executeTool 里那条 fetch_url/render_page 合并的 case，不是第二套实现。
const BRIDGE_ONLY = [
  {
    name: "render_page",
    description: "用内置浏览器真实打开一个页面、等 JavaScript 渲染完再取正文。正文全靠 JS 的站点（B 站、微博、各类单页应用）用它，普通抓取工具在这些站点上只能拿到空壳。",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string" },
        wait_ms: { type: "number", description: "等待渲染的毫秒数，默认 2500，范围 500~8000" },
      },
      required: ["url"],
    },
  },
];

/** 白名单 ∩ 本项目真有的工具 ∩ 这个进程里真跑得通的。名字对不上就不挂。 */
function lentDefs() {
  let gui = false;
  try { gui = !!require("../platform/render/browser-render").available(); } catch {}
  return [...tools.TOOL_DEFS, ...BRIDGE_ONLY].filter(
    (d) => ALLOW.has(d.name) && (gui || !NEEDS_RENDERER.includes(d.name))
  );
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

/**
 * 工作区根对齐到这趟任务的。不对齐的话 executeTool 写进数据目录下的默认 workspace：
 * 用户改过工作区、开着项目时，产物落在成果面板看不见的地方；多账号时租户的产物落进共用的那份。
 * 主进程给了根却用不了（不是绝对路径、建不出来）就抛错，不退回默认根——那是别人的地盘。资料库根同理。
 */
function setupRoots() {
  if (ROOT !== undefined) tools.setWorkspaceDir(ROOT);
  else {
    // 老调用方没给根：照服务端开机那样先认设置里的 workspace_dir
    let set = false;
    if (config.workspace_dir) {
      try { tools.setWorkspaceDir(config.workspace_dir); set = true; }
      catch (e) { toErr(`设置里的工作区 ${config.workspace_dir} 用不了（${e.message}），这次用数据目录下的 workspace`); }
    }
    if (!set) tools.setWorkspaceDir(dataPath("workspace"));
  }
  if (LIB_ROOT !== undefined && !path.isAbsolute(LIB_ROOT)) throw new Error(`资料库目录不是绝对路径：${LIB_ROOT}`);
  if (BASE_DIR) {
    try { fs.mkdirSync(path.join(tools.getWorkspaceDir(), BASE_DIR), { recursive: true }); } catch {}
  }
  // 引擎的当前目录就是这趟任务的根/baseDir：回执里的路径照它说，再附完整路径。
  // 照相对工作空间根说的话，前面多一截「任务_X/」，引擎照着找不着
  tools.setReplyBase(path.join(tools.getWorkspaceDir(), BASE_DIR));
}

async function callTool(name, args) {
  if (!ALLOW.has(name)) throw new Error(`工具 ${name} 没有借给本机引擎`);
  const run = () => tools.executeTool(name, args || {}, {
    knownTools: [...ALLOW],
    timeoutMs: ((config.agent || {}).tool_timeout_ms) || 120000,
    search: config.search,
    media: mediaModels.resolve(config),
    security: config.security,
    baseDir: BASE_DIR,
    memory: { user: USER },
  });
  // 资料库也照这趟任务的来：一人一份根，项目还可能只挂了其中一块。
  // 不套这一层，library_list 念出来的是数据目录下那份——多账号时就是别人的合同
  const r = await tools.withLibraryBase(LIB_ROOT || "", () => tools.withLibraryDir(LIB_MOUNT, run));
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


/** 排障用：OPENWORKBUDDY_BRIDGE_LOG=/path/x.log 时把每一条收发都记下来。
 *  「工具挂上了但模型看不见」这种问题，不看真实的 JSON-RPC 往返就只能靠猜。 */
const LOG = process.env.OPENWORKBUDDY_BRIDGE_LOG || "";
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
  if (TOOLS_ENV === undefined) {
    process.stderr.write("没拿到 OPENWORKBUDDY_BRIDGE_TOOLS，不知道这次借哪些工具，没有启动。这台服务器由 OpenWorkBuddy 在用本机引擎时拉起\n");
    process.exit(2);
  }
  // 根要在接第一条请求之前定下来：MCP 和命令行两条路都要
  try { setupRoots(); }
  catch (e) {
    process.stderr.write(`这趟任务的目录用不了，没有启动：${(e && e.message) || e}\n`);
    process.exit(2);
  }
  // 这个进程是 CLI 拉起的子进程：在这儿摆出的审批卡，网页、终端、手机都看不见（它们看的是自己进程里那份）。
  // 不当场拒的话，要干等满超时（默认 120 秒）才按「没批」收场，CLI 那头只当工具卡死了
  security.watchApprovals((ev) => { const id = ev.type === "open" && ev.entry && ev.entry.id; if (id) setImmediate(() => security.resolveApproval(id, false)); });
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
