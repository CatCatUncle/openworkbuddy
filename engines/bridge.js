"use strict";
/**
 * 把 tool-bridge 这台 MCP 服务器接到两个 CLI 上。
 *
 * claude：认 `--mcp-config <文件>`，文件里是 { mcpServers: { ... } }。
 *         另外 `-p` 非交互模式下，MCP 工具默认是要人点同意的——没人点就等于没有。
 *         所以还得 `--allowed-tools mcp__openworkbuddy`（整台服务器放行）。
 *         真正危险的动作由本项目自己的安全中心把关，不靠 CLI 那道弹窗。
 * codex： 认 `-c mcp_servers.<名>.command=...` 这种点号覆盖，值按 TOML 解析。
 *
 * 用户自己在设置里配的 MCP 连接器一并塞进去：切到本机引擎之后，
 * 那些连接器不该跟着消失——它们本来就是 MCP，转手给 CLI 是最直接的做法。
 *
 * 但 MCP 这条路不是每次都通。实测（2026-09-08）：codex 0.146 接到非 OpenAI 模型上时，
 * 它照常拉起我们这台服务器、照常收下 tools/list，然后一个工具都不往模型手里挂——
 * 问模型「你能调什么」，答案里只有 list_mcp_resources 这类内置项。
 * 这不是我们能修的，但用户不该因此失去生图能力。
 * 所以再铺一条不依赖 MCP 的路：把环境变量烘进一个叫 owb 的可执行脚本，
 * 提示词里把命令给模型。两个 CLI 都有 shell，这条路谁也拦不住。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const BRIDGE_ENTRY = path.join(__dirname, "tool-bridge.js");
const SERVER_NAME = "openworkbuddy";

/** 起 bridge 用哪个 node：Electron 打包版里 process.execPath 是应用本体，得让它以 node 模式跑 */
function nodeLauncher() {
  if (process.versions.electron) {
    return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } };
  }
  return { command: process.execPath, env: {} };
}

/**
 * 拼出这次要给 CLI 的 MCP 服务器表。
 * @param {object} o
 * @param {string} o.home      数据根目录（bridge 靠它找 config.json / workspace）
 * @param {string} [o.baseDir] 本次对话的成果子目录（相对 workspace）
 * @param {string} [o.user]    当前用户名（记忆按人隔离）
 * @param {string[]} [o.tools] 借出去的工具名；不传就用 tool-bridge 的默认白名单
 * @param {Array} [o.extraServers] 用户自己配的 MCP 连接器（config.mcp_servers 的形状）
 */
function buildServers({ home, baseDir = "", user = "", tools, extraServers = [] }) {
  const { command, env: nodeEnv } = nodeLauncher();
  const servers = {
    [SERVER_NAME]: {
      command,
      args: [BRIDGE_ENTRY],
      env: {
        ...nodeEnv,
        OPENWORKBUDDY_HOME: home,
        WB_BRIDGE_BASEDIR: baseDir,
        WB_BRIDGE_USER: user,
        ...(tools && tools.length ? { WB_BRIDGE_TOOLS: tools.join(",") } : {}),
      },
    },
  };
  for (const s of extraServers || []) {
    if (!s || !s.name || s.enabled === false) continue;
    if (s.name === SERVER_NAME) continue; // 不许顶掉自己这台
    // 只转发 stdio 那种：HTTP 端点两个 CLI 的写法各不相同，认错了还不如不挂
    if (s.transport && s.transport !== "stdio") continue;
    if (!s.command) continue;
    servers[s.name] = { command: s.command, args: s.args || [], ...(s.env ? { env: s.env } : {}) };
  }
  return servers;
}

/**
 * 落一份 mcp-config 临时文件给 claude 用。
 * @returns {{path:string, cleanup:function, names:string[]}}
 */
function writeMcpConfig(servers) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-mcp-"));
  const p = path.join(dir, "mcp.json");
  fs.writeFileSync(p, JSON.stringify({ mcpServers: servers }, null, 2));
  return {
    path: p,
    names: Object.keys(servers),
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

/** codex 那边不吃配置文件，只吃一串 `-c` 覆盖 */
function codexArgs(servers) {
  const out = [];
  for (const [name, s] of Object.entries(servers)) {
    out.push("-c", `mcp_servers.${name}.command=${JSON.stringify(s.command)}`);
    out.push("-c", `mcp_servers.${name}.args=${JSON.stringify(s.args || [])}`);
    if (s.env && Object.keys(s.env).length) {
      // TOML 内联表：{ K = "V" }。JSON 的 {"K":"V"} 它不认。
      const body = Object.entries(s.env).map(([k, v]) => `${k} = ${JSON.stringify(String(v))}`).join(", ");
      out.push("-c", `mcp_servers.${name}.env={ ${body} }`);
    }
  }
  return out;
}

/**
 * 把环境变量烘进一个 owb 脚本：模型只要 `owb generate_image '{...}'` 就能用上本项目的工具。
 * 之所以不直接把命令写进提示词，是因为那样得让模型自己带一串 OPENWORKBUDDY_HOME=... 前缀，
 * 它十次有三次会漏，漏了就落到错误的数据目录里去。
 *
 * 脚本单独放一个目录、名字就叫 owb，是为了能挂进 PATH 里当裸命令用。实测（2026-09-08）：
 * `claude -p` 下模型敲带绝对路径的命令会被判成「This command requires approval」，
 * 非交互模式下没人能点同意，于是工具挂了等于没挂。挂进 PATH 之后配一条
 * `--allowed-tools "Bash(owb:*)"` 就通了，而且只放行这一个命令，比整个 Bash 放开安全。
 * @returns {{path:string, dir:string, bin:string, cleanup:function}}
 */
function writeShim(server) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-shim-"));
  const p = path.join(dir, "owb");
  const q = (v) => "'" + String(v).replace(/'/g, "'\\''") + "'";
  const env = Object.entries(server.env || {}).map(([k, v]) => `${k}=${q(v)}`).join(" ");
  const argv = [server.command, ...(server.args || [])].map(q).join(" ");
  fs.writeFileSync(p, `#!/bin/sh\n# OpenWorkBuddy 借给本机引擎的工具入口（本次任务专用，跑完即删）\n${env} exec ${argv} "$@"\n`);
  fs.chmodSync(p, 0o755);
  return { path: p, dir, bin: "owb", cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

/**
 * 一次性把桥接接到某个引擎上：拼服务器表 → 落文件 / 拼参数 → 给出要传给 run() 的那几项。
 * 调用方只要 `...attached.runOpts` 展开，收尾时调一次 cleanup 就行。
 *
 * @returns {{runOpts:object, names:string[], toolCount:number, cleanup:function}}
 */
function attach(engineId, { home, baseDir = "", user = "", tools, extraServers = [] } = {}) {
  const servers = buildServers({ home, baseDir, user, tools, extraServers });
  const names = Object.keys(servers);
  const lent = (tools && tools.length ? tools : require("./tool-bridge").LENDABLE)
    .filter((n) => require("./tool-bridge").LENDABLE.includes(n));
  const shim = writeShim(servers[SERVER_NAME]);
  // codex 那边 MCP 挂不上（见文件头），命令行是它唯一能用到这些工具的路，所以标成主路。
  const shimIsPrimary = engineId === "codex";
  // 脚本目录挂到子进程 PATH 最前面，模型敲裸 `owb` 就能调到——带绝对路径的写法会被两个
  // CLI 的权限层拦下（见 writeShim 上面那段），裸命令加一条放行规则才通得了。
  const shimEnv = { PATH: shim.dir + path.delimiter + (process.env.PATH || "") };
  const common = { names, lent, toolCount: lent.length, shim: shim.path, shimDir: shim.dir, shimBin: shim.bin, shimIsPrimary };
  if (engineId === "codex") {
    return {
      // writableRoots：codex 的 workspace-write 沙箱只让写 cwd，而 remember / save_skill
      // 要写到数据目录里去。不开这个口子，模型调得动工具但存不下东西，报错还特别难懂。
      runOpts: { mcpArgs: codexArgs(servers), env: shimEnv, shimBin: shim.bin, writableRoots: [home] },
      ...common,
      cleanup: shim.cleanup,
    };
  }
  const w = writeMcpConfig(servers);
  return {
    runOpts: { mcpConfigPath: w.path, mcpServerNames: names, env: shimEnv, shimBin: shim.bin },
    ...common,
    cleanup: () => { w.cleanup(); shim.cleanup(); },
  };
}

module.exports = { SERVER_NAME, BRIDGE_ENTRY, buildServers, writeMcpConfig, writeShim, codexArgs, nodeLauncher, attach };
