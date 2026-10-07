// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
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
 * 用户自己在设置里配的 MCP 连接器、插件带来的连接器一并塞进去：切到本机引擎之后，
 * 那些连接器不该跟着消失——它们本来就是 MCP，转手给 CLI 是最直接的做法。
 * 连接器页上关掉的（config.mcp_disabled）不塞：内置引擎那边不连，换了引擎也不该连。
 *
 * 两个 CLI 上 MCP 都是主路：MCP 服务器由 CLI 直接拉起，不在 codex 给命令套的沙箱里，
 * 命令不能联网、不能写数据目录时，借过去的工具照样能生图、能记东西。
 * （2026-09-08 记过 codex 0.146 接非 OpenAI 模型时工具挂不上；OpenWorkBuddy 里 codex 只走
 * 默认供应商——换供应商的参数在开跑前就被拒了，见 gate.js——这条旧结论不再决定主路。）
 * 再铺一条后备：把环境变量烘进一个叫 owb 的可执行脚本，提示词里把命令给模型。
 * 它跑在 CLI 的命令沙箱里——codex 关网、只写工作区时，要联网或写数据目录的工具从这条路调不成。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
// 名单是纯数据，require 它不会碰 console、不读配置（tool-bridge.js 会，所以这里不 require 它）。
// 下面一律 renderer:false：桥由 nodeLauncher 以纯 node 拉起，那头永远没有浏览器
const { lentFor, toEnv, SANDBOX_BLOCKED } = require("./lendable");

const BRIDGE_ENTRY = path.join(__dirname, "tool-bridge.js");
const CWD_ENTRY = path.join(__dirname, "mcp-cwd.js");
const SERVER_NAME = "openworkbuddy";
/** 本项目借出去的那台 MCP 的工具时限：生图、出视频动辄几分钟。两个 CLI 各写各的，数是同一个 */
const TOOL_TIMEOUT_MS = 900000;

/** 起 bridge 用哪个 node：Electron 打包版里 process.execPath 是应用本体，得让它以 node 模式跑 */
function nodeLauncher() {
  if (process.versions.electron) {
    // 服务端在独立服务进程里时 execPath 是 Helper，nodeExec 换回应用本体
    return { command: require("../platform/electron-bridge").nodeExec(), env: { ELECTRON_RUN_AS_NODE: "1" } };
  }
  return { command: process.execPath, env: {} };
}

/**
 * 拼出这次要给 CLI 的 MCP 服务器表。
 * @param {object} o
 * @param {string} o.home      数据根目录（bridge 靠它找 config.json）
 * @param {string} [o.root]    这趟任务的工作区根（agent.js 给的是 getWorkspaceDir()：租户、项目各有各的根）。
 *                             桥是单独的子进程，主进程 ALS 里的根跟不过去，得明着传。不传 = 桥自己认默认根
 * @param {string} [o.baseDir] 本次对话的成果子目录（相对 root）
 * @param {{base?:string, mount?:string}} [o.library] 这个人的资料库根、当前项目挂载的子目录。不传 = 数据目录下那份整库
 * @param {string} [o.user]    当前用户名（记忆按人隔离）
 * @param {string} [o.run]     这一趟的编号：桥记视频收单台账时写上，收尾时主进程按它认领（engines/harvest.js）
 * @param {string[]} [o.tools] 借出去的工具名；不传就是 lendable.js 整张表，空数组就是一个不借
 * @param {Array} [o.extraServers] 用户自己配的、插件带来的 MCP 连接器（config.mcp_servers 的形状，插件的多一个 cwd）
 * @param {string[]} [o.disabled] 连接器页上关掉的名字（config.mcp_disabled）
 * @param {boolean} [o.readOnly] 问答 / 计划那一趟：只借读的工具，桥那头再拦一道，用户的连接器一个不挂
 *                               （连接器能干什么这边判断不了，只读这一趟就不冒这个险）
 */
function buildServers({ home, root = "", baseDir = "", user = "", run = "", tools, library = null, extraServers = [], disabled = [], readOnly = false }) {
  const lib = library || {};
  const { command, env: nodeEnv } = nodeLauncher();
  const servers = {
    [SERVER_NAME]: {
      command,
      args: [BRIDGE_ENTRY],
      env: {
        ...nodeEnv,
        OPENWORKBUDDY_HOME: home,
        // 空着就不写：桥那头「没拿到」是老调用方，照老规矩认默认根、整个默认资料库；
        // 根写成空串反倒成了「给了个用不了的根」，桥会拒绝启动
        ...(root ? { OPENWORKBUDDY_BRIDGE_ROOT: root } : {}),
        ...(lib.base ? { OPENWORKBUDDY_BRIDGE_LIB_ROOT: lib.base } : {}),
        ...(lib.mount ? { OPENWORKBUDDY_BRIDGE_LIB_MOUNT: lib.mount } : {}),
        OPENWORKBUDDY_BRIDGE_BASEDIR: baseDir,
        OPENWORKBUDDY_BRIDGE_USER: user,
        ...(run ? { OPENWORKBUDDY_BRIDGE_RUN: run } : {}),
        // 每次都写，一个不借也写：桥那头没拿到这个变量就不启动，不会按整张表借
        OPENWORKBUDDY_BRIDGE_TOOLS: toEnv(lentFor({ tools, renderer: false, readOnly })),
        ...(readOnly ? { OPENWORKBUDDY_BRIDGE_READONLY: "1" } : {}),
      },
    },
  };
  const taken = new Set([SERVER_NAME]);
  for (const s of readOnly ? [] : forwardable(extraServers, disabled).keep) {
    servers[cliName(s.name, taken)] = { command: s.command, args: s.args || [], ...(s.env ? { env: s.env } : {}), ...(s.cwd ? { cwd: s.cwd } : {}) };
  }
  return servers;
}

/**
 * 转给 CLI 的服务器名只留字母、数字、_、-，连着的下划线并成一个。插件带来的叫「插件名__id」，
 * 插件名里还可能有点：claude 认放行规则 mcp__<名> 时按 __ 切，名字里带 __ 的那台工具放不行（2.1.291 实测：
 *   plug__srv、acme.tools__srv 每次调用都被拦下要权限，plug_srv 放行）；
 * codex 的 -c 键按点切，带点的名字会被拆成好几层。改完撞了名就在后面补 -2、-3
 */
function cliName(name, taken) {
  const base = String(name).replace(/[^A-Za-z0-9_-]+/g, "_").replace(/_{2,}/g, "_").replace(/^_+|_+$/g, "") || "mcp";
  let n = base;
  for (let i = 2; taken.has(n); i++) n = `${base}-${i}`;
  taken.add(n);
  return n;
}

/**
 * 连接器里哪些转给 CLI。keep：照转；skipped：开着、但走网址的那几台，名字留着给运行页说一句。
 * 关掉的、没名字的、跟本项目这台重名的、配置不全的，不转也不提（连接器页上自己会显示）。
 */
function forwardable(extraServers = [], disabled = []) {
  const off = new Set((disabled || []).map(String));
  // 重名的后面那条算数，跟内置那边 startAll 一个规矩（自配的在前、插件的在后）
  const plan = new Map();
  for (const s of extraServers || []) if (s && s.name) { plan.delete(s.name); plan.set(s.name, s); }
  const keep = [], skipped = [];
  for (const s of plan.values()) {
    if (s.enabled === false || off.has(String(s.name))) continue;
    if (s.name === SERVER_NAME) continue; // 不许顶掉自己这台
    // 只转发 stdio 那种：HTTP 端点两个 CLI 的写法各不相同，认错了还不如不挂。
    // 判法跟 mcp.js 起连接器的一致：写了别的 transport，或者只有 url 没有 command
    if ((s.transport && s.transport !== "stdio") || (!s.command && s.url)) { skipped.push(String(s.name)); continue; }
    if (!s.command) continue;
    keep.push(s);
  }
  return { keep, skipped };
}

/**
 * 这两种临时目录里是 MCP 配置，会带上用户 mcp_servers 里的 env（常常是 key）。
 * 平时由调用方收尾时 cleanup；但第二次 Ctrl+C、关终端窗口、被 kill 时进程下一刻就没了，
 * 走不到那一步。所以每个都记一笔，进程退出前统一删掉——exit 钩子只挂一次
 */
const TEMP_DIRS = new Set();
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  if (!tempDir.hooked) {
    tempDir.hooked = true;
    process.on("exit", () => { for (const d of TEMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
  }
  TEMP_DIRS.add(dir);
  return { dir, rm: () => { TEMP_DIRS.delete(dir); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

/**
 * claude 的 mcp.json 不认 cwd（实测 2.1.291：写了也照样在它自己的工作目录里起）。
 * 要在别处起的那几台（插件的，默认在插件根里）套一层 mcp-cwd.js：先切目录再起
 */
function claudeEntry(s) {
  if (!s.cwd) return s;
  const { command, env: nodeEnv } = nodeLauncher();
  return { command, args: [CWD_ENTRY, s.cwd, s.command, ...(s.args || [])], env: { ...(s.env || {}), ...nodeEnv } };
}

/**
 * 落一份 mcp-config 临时文件给 claude 用。
 * 里面有连接器 env 里的 key：目录是 mkdtemp 建的 0700，文件自己也只给本人读写
 * @returns {{path:string, cleanup:function, names:string[]}}
 */
function writeMcpConfig(servers) {
  const { dir, rm } = tempDir("owb-mcp-");
  const p = path.join(dir, "mcp.json");
  // 本项目这台给足 15 分钟，跟 codex 那边的 tool_timeout_sec=900 对齐。claude 对 MCP 工具有个「多久没动静就判超时」，
  // 生视频轮询那几分钟一声不出，没写 timeout（毫秒）就被它半路掐掉——实测 2.1.291 的报错原话就是让按服务器写这一项
  const mcpServers = Object.fromEntries(Object.entries(servers).map(([name, s]) => {
    const e = claudeEntry(s);
    return [name, name === SERVER_NAME ? { ...e, timeout: TOOL_TIMEOUT_MS } : e];
  }));
  fs.writeFileSync(p, JSON.stringify({ mcpServers }, null, 2), { mode: 0o600 });
  return {
    path: p,
    names: Object.keys(servers),
    cleanup: rm,
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
    // codex 认 cwd（实测 0.154），插件的连接器直接在插件根里起，用不着 claude 那边那一层
    if (s.cwd) out.push("-c", `mcp_servers.${name}.cwd=${JSON.stringify(s.cwd)}`);
    // codex exec 的审批策略是 never：要审批的 MCP 工具不会问人，直接判拒绝，
    // 模型看得见工具却一次也调不成。跟 Claude Code 那边 --allowed-tools mcp__<name> 对齐，整台放行。
    out.push("-c", `mcp_servers.${name}.default_tools_approval_mode="approve"`);
    // 生图、出视频动辄几分钟，codex 默认的工具超时一到就判失败——钱已经花了，图却没交到手里
    if (name === SERVER_NAME) out.push("-c", `mcp_servers.${name}.tool_timeout_sec=900`);
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
  const { dir, rm } = tempDir("owb-shim-");
  const p = path.join(dir, "owb");
  const q = (v) => "'" + String(v).replace(/'/g, "'\\''") + "'";
  const env = Object.entries(server.env || {}).map(([k, v]) => `${k}=${q(v)}`).join(" ");
  const argv = [server.command, ...(server.args || [])].map(q).join(" ");
  fs.writeFileSync(p, `#!/bin/sh\n# OpenWorkBuddy 借给本机引擎的工具入口（本次任务专用，跑完即删）\n${env} exec ${argv} "$@"\n`);
  fs.chmodSync(p, 0o755);
  return { path: p, dir, bin: "owb", cleanup: rm };
}

/**
 * 一次性把桥接接到某个引擎上：拼服务器表 → 落文件 / 拼参数 → 给出要传给 run() 的那几项。
 * 调用方只要 `...attached.runOpts` 展开，收尾时调一次 cleanup 就行。
 *
 * skipped：开着、但这次没转过去的连接器名（走网址的），调用方在运行页上说一句
 * @returns {{runOpts:object, names:string[], toolCount:number, skipped:string[], cleanup:function}}
 */
function attach(engineId, { home, root = "", baseDir = "", user = "", run = "", tools, library = null, extraServers = [], disabled = [], readOnly = false, noShim = false } = {}) {
  const servers = buildServers({ home, root, baseDir, user, run, tools, library, extraServers, disabled, readOnly });
  const names = Object.keys(servers);
  // 只读那一趟本来就一个不挂，不算「没转过去」
  const skipped = readOnly ? [] : forwardable(extraServers, disabled).skipped;
  // 跟 buildServers 写进环境变量的是同一份：提示词里列的、owb list 打出来的、MCP 挂上的，三处一致
  const lent = lentFor({ tools, renderer: false, readOnly });
  // 只读那一趟不给命令行入口：只读档的 CLI 本来就不该跑命令，借出去的读工具走 MCP 就够了。
  // 安全档「只看不动」也不给（noShim，见 security.engineGuard 的 allowShim），两个引擎一样
  const shim = readOnly || noShim ? { path: "", dir: "", bin: "", cleanup() {} } : writeShim(servers[SERVER_NAME]);
  // 两边都以 MCP 为主（见文件头）；命令行脚本只是后备
  const shimIsPrimary = false;
  // 脚本目录挂到子进程 PATH 最前面，模型敲裸 `owb` 就能调到——带绝对路径的写法会被两个
  // CLI 的权限层拦下（见 writeShim 上面那段），裸命令加一条放行规则才通得了。
  // 只给这一个目录：补全过的完整搜索路径由起进程那层接在后面（jsonl.js 的 enginePath）。
  // 以前这里拼的是本进程原样的 PATH，到了那一层反倒把补全的那份整个盖掉了
  const shimEnv = shim.dir ? { PATH: shim.dir } : {};
  // codex 的命令跑在它自己的沙箱里（只写工作区、默认不联网），owb 脚本也在里面；MCP 服务器不在
  const shimSandboxed = engineId === "codex";
  // 在那个沙箱里 owb 不跑的（tool-bridge.js 的 sandboxBlock）：提示词照这份点名，别让它先撞一次
  const shimBlocked = shimSandboxed && shim.bin ? lent.filter((n) => SANDBOX_BLOCKED[n]) : [];
  // engine：提示词按它教看图（claude 用 Read、codex 用 view_image）
  const common = { engine: engineId, readOnly, names, skipped, lent, toolCount: lent.length, shim: shim.path, shimDir: shim.dir, shimBin: shim.bin, shimIsPrimary, shimSandboxed, shimBlocked };
  if (engineId === "codex") {
    return {
      // 不再把数据根加进可写目录：那等于让引擎里的任何命令都能改配置和账号。
      // remember / save_skill 走 MCP，MCP 服务器在沙箱外，用不着这个口子
      runOpts: { mcpArgs: codexArgs(servers), env: shimEnv, shimBin: shim.bin },
      ...common,
      cleanup: shim.cleanup,
    };
  }
  const w = writeMcpConfig(servers);
  // owb 走的是 claude 的 Bash：默认两分钟、模型自己最多只能要到十分钟，出一条视频不够。上限放到 15 分钟，
  // 模型要多久它自己定；属主自己设过的不动
  const bashEnv = shim.bin && !process.env.BASH_MAX_TIMEOUT_MS ? { BASH_MAX_TIMEOUT_MS: String(TOOL_TIMEOUT_MS) } : {};
  return {
    runOpts: { mcpConfigPath: w.path, mcpServerNames: names, env: { ...shimEnv, ...bashEnv }, shimBin: shim.bin },
    ...common,
    cleanup: () => { w.cleanup(); shim.cleanup(); },
  };
}

module.exports = { SERVER_NAME, BRIDGE_ENTRY, CWD_ENTRY, TOOL_TIMEOUT_MS, buildServers, forwardable, cliName, writeMcpConfig, writeShim, codexArgs, nodeLauncher, attach };
