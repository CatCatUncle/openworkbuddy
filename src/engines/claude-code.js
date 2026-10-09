// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 底层引擎：本机已装的 Claude Code CLI。
 *
 * 为什么要有它：用户电脑里那个 `claude` 是按订阅算的，跑一次任务不额外掏 API 钱。
 * 把它当底层，OpenWorkBuddy 就从「你得先去买 token」变成「你已经有的东西，接上就能用」。
 *
 * 接法是整层替换，不是换个模型：`claude -p` 本身就是一个完整的 agent（自带工具、自带循环），
 * 没有"给我一步"这种调用方式。所以这里做的是把它的 stream-json 事件流翻译成
 * OpenWorkBuddy 自己那套 emit 事件，前端、CLI、IM 三处的渲染一行都不用改。
 *
 * 翻译表（左边是 claude 的，右边是本项目的）：
 *   system/init                    → status（顺带记下 session_id，给续跑用）
 *   assistant.content[].text       → text
 *   assistant.content[].tool_use   → tool_use
 *   user.content[].tool_result     → tool_result
 *   result(subtype=success)        → finalText + usage
 *   result(subtype=error_max_turns)→ stopped="已达最大步数"，交给 task-verdict 判红
 *   result(is_error=true)          → 抛异常，报错原文交给 explain（这种时候 stderr 多半是空的）
 *
 * 提示词走 stdin 不走 argv：任务描述可能上万字，argv 有长度上限，
 * 而且里面带引号和换行时，拼命令行迟早出事。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("../platform/win"); // 不直接用 child_process 的：Windows 上 .cmd 垫片起不来、还闪黑窗
const { runJsonl, probeVersion, probeOption, probeHelp, enginePath } = require("./jsonl");
const thinking = require("../core/model/thinking");
const { resolveNewest, cliVersion, cmpCliVersion } = require("../platform/which");
const { buildChildEnv } = require("../platform/child-env");
const gate = require("./gate");

const ID = "claude-code";

/** 把工具入参压成一句人能看懂的目的说明，长度对齐内置引擎的 purpose */
function purposeOf(name, input) {
  if (!input || typeof input !== "object") return "";
  const pick = input.file_path || input.path || input.command || input.pattern || input.url || input.query || input.prompt || input.description;
  return pick ? String(pick).replace(/\s+/g, " ").slice(0, 80) : "";
}

function textOfToolResult(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c === "object" ? c.text || "" : String(c || ""))).join("\n");
  }
  return content == null ? "" : String(content);
}

/**
 * stderr 翻译：进程非零退出时，用户唯一能看到的解释就是这里返回的话。
 * 不认识的原文照抄——瞎猜一个原因比直说"不知道"更耽误人。
 */
function explain(stderr, code) {
  const s = String(stderr || "");
  if (/not logged in|please run .*login|Invalid API key|authentication_error|OAuth token/i.test(s))
    return "本机 Claude Code 还没登录。先在终端里跑一次 `claude` 完成登录，再回来重试。";
  if (/rate.?limit|429|usage limit reached/i.test(s))
    return "本机 Claude Code 撞到订阅限流了，等窗口重置后再跑。";
  if (/credit balance|insufficient/i.test(s))
    return "本机 Claude Code 账号额度不够了。";
  if (/ENOENT|command not found/i.test(s))
    return "找不到 claude 命令。装一个（npm i -g @anthropic-ai/claude-code）或在设置里填绝对路径。";
  // 「删文件等操作先问我」靠的是 claude 没写进 --help 的参数：它不认、或者说找不到那个工具，当场就退出。
  // 只点名是哪个开关、去哪关，原话照附
  if (/permission-prompt-tool/.test(s) && /not found|unknown option/i.test(s))
    return `本机 Claude Code 没接住「删文件等操作先问我」这一项，先到 ${gate.WHERE} 里把这一勾去掉再跑。它的原话：${s.slice(-600)}`;
  return s ? s.slice(-600) : `claude 异常退出（退出码 ${code}）且没有任何输出`;
}

/**
 * 这版 claude 认不认 --thinking？
 *
 * 非探不可：claude 对不认识的选项是**静默忽略**的，老版本上发了等于没发，
 * 用户在设置里点了「关闭思考」却毫无动静，还看不出哪儿不对。探到不支持就在
 * 界面上直说（见 thinking.planForEngine 的 note），不假装生效。
 *
 * 一个进程一次，按 bin 缓存：这是个 spawn，设置页每刷一次就探一次太浪费。
 */
const thinkingCaps = new Map();
async function probeThinking(bin) {
  if (thinkingCaps.has(bin)) return thinkingCaps.get(bin);
  const p = probeOption(bin, "--thinking");
  thinkingCaps.set(bin, p);
  return p;
}

const versionOf = (b) => probeVersion(b, ["--version"]);

/**
 * claude 用的配置目录：子进程环境里有 CLAUDE_CONFIG_DIR（引擎设置的 env 里写了，或属主放进了透传清单）就是它，
 * 否则 ~/.claude。跟子进程自己找的是同一处，读到的型号表、settings.json 才是它真正在用的那个账号的。
 */
function claudeDir(env) {
  const d = String(buildChildEnv(env && typeof env === "object" ? env : {}).CLAUDE_CONFIG_DIR || "").trim();
  return d ? path.resolve(d) : path.join(os.homedir(), ".claude");
}

/**
 * Claude Code 自己的型号表。它启动时从官方拉一份存在配置目录 cache/model-catalog/ 下（surface 为 "cc" 的那份），
 * 交互界面里 /model 列的就是它：这个账号能用哪些具体型号、每个要 CLI 哪一版起，都写在里面。
 * 比从 --help 抠别名准，出新型号也不用改这里。几份里挑拉取时间最新的；读不到、格式对不上就返回 null，
 * 退回别名 + settings.json 那套。
 * @returns {null | {id:string, name:string, section:"main"|"other", min:string}[]}
 */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@\-\[\]]{0,80}$/;
function catalogModels(dir) {
  const root = path.join(dir, "cache", "model-catalog");
  let names = [];
  try { names = fs.readdirSync(root).filter((n) => n.endsWith(".json")); } catch { return null; }
  let best = null;
  let bestAt = -1;
  for (const n of names) {
    let j;
    try {
      const f = path.join(root, n);
      if (fs.statSync(f).size > 2 * 1024 * 1024) continue;
      j = JSON.parse(fs.readFileSync(f, "utf8"));
    } catch { continue; }
    const cat = j && j.catalog;
    if (!cat || cat.surface !== "cc" || !cat.config || !Array.isArray(cat.config.models)) continue;
    const at = Number(j.fetchedAt) || Date.parse(j.fetchedAt) || 0;
    if (at > bestAt) { best = cat.config.models; bestAt = at; }
  }
  if (!best) return null;
  const out = [];
  const seen = new Set();
  for (const m of best) {
    const id = m && typeof m.id === "string" ? m.id.trim() : "";
    if (!MODEL_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    const min = typeof m.min_claude_code_version === "string" && cliVersion(m.min_claude_code_version) ? m.min_claude_code_version.trim().slice(0, 40) : "";
    out.push({ id, name: typeof m.name === "string" ? m.name.trim().slice(0, 40) : "", section: m.section === "main" ? "main" : "other", min });
  }
  return out.length ? out : null;
}

/**
 * 别名（opus / sonnet / fable…）：从 `claude --help` 里 --model 那段的示例抠，抠不到就用三个长期存在的兜底。
 * 要起一次进程，按 bin + 版本缓存（升级之后版本号变了，自然重探）
 */
const ALIAS_FALLBACK = ["opus", "sonnet", "haiku"];
const helpAliases = new Map();
function aliasesOf(bin, version) {
  const key = bin + "\n" + version;
  if (helpAliases.has(key)) return helpAliases.get(key);
  const p = new Promise((resolve) => {
    // PATH 补全跟正式跑同一份：npm 装的 claude 开头是 `#!/usr/bin/env node`，双击启动时那份 PATH 里找不到 node
    execFile(bin, ["--help"], { env: buildChildEnv({ PATH: enginePath() }), timeout: 10000 }, (_err, stdout) => {
      const seg = (/--model <model>([\s\S]*?)(?:\n\s*-{1,2}[a-z]|$)/.exec(String(stdout || "")) || [])[1] || "";
      const found = [...seg.matchAll(/'([a-z][a-z0-9.\-\[\]]*)'/g)].map((m) => m[1]).filter((a) => !/^claude-/.test(a));
      resolve([...new Set([...found, ...ALIAS_FALLBACK])]);
    });
  });
  helpAliases.set(key, p);
  return p;
}

/** 用户 settings.json 里真写过的 model 和 modelSettings 的键。每次现读：用户改了文件，设置页刷新就该看见 */
function settingsModels(dir) {
  const out = [];
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
    if (typeof cfg.model === "string") out.push(cfg.model);
    if (cfg.modelSettings && typeof cfg.modelSettings === "object") out.push(...Object.keys(cfg.modelSettings));
  } catch {}
  return [...new Set(out.map((m) => String(m).trim()).filter(Boolean))];
}

/**
 * 设置页「模型」下拉的候选，分四组，前端照组画：
 *   main  型号表里的主力型号（具体型号全名，选了就固定是它）
 *   alias 别名（跟着 Claude Code 的版本走，升级后自动换新）
 *   other 型号表里收在「更多」里的
 *   mine  settings.json 里写过、上面都没有的
 * 型号表说要更新版 CLI 的，这份 claude 跑不了：不进下拉（选了一跑就报错），单列在 needsUpgrade 里让设置页提示升级。
 * 版本号读不出来时不拦——判断不了就不替人下结论。
 * @param {{aliases?:string[], mine?:string[]}} local
 * @param {ReturnType<typeof catalogModels>} catalog
 * @param {string} version  `claude --version` 的原文
 */
function modelList(local, catalog, version) {
  const seen = new Set();
  const info = [];
  const needsUpgrade = [];
  const usable = [];
  const known = !!cliVersion(version);
  for (const m of catalog || []) {
    if (known && m.min && cmpCliVersion(version, m.min) < 0) { needsUpgrade.push({ id: m.id, name: m.name, min: m.min }); seen.add(m.id); }
    else usable.push(m);
  }
  const add = (id, name, group) => {
    const k = String(id || "").trim();
    if (!k || seen.has(k)) return;
    seen.add(k);
    info.push({ id: k, name: name || "", group });
  };
  for (const m of usable) if (m.section === "main") add(m.id, m.name, "main");
  for (const a of (local && local.aliases) || []) add(a, "", "alias");
  for (const m of usable) if (m.section !== "main") add(m.id, m.name, "other");
  for (const a of (local && local.mine) || []) add(a, "", "mine");
  return { models: info.map((m) => m.id), info, needsUpgrade, source: catalog ? "claude_catalog" : info.length ? "claude_local" : "manual" };
}

/**
 * 这份 claude 怎么升级，按它实际装在哪儿判断，给一条能直接粘进终端的命令：
 * npm 全局装的（mac 上软链进 node_modules，Windows 上 .cmd 垫片旁边就是 node_modules）走 npm，
 * Homebrew cask 走 brew，其余（官方安装脚本装的）用它自带的 `claude update`。
 */
function upgradeCommand(bin) {
  const b = String(bin || "claude");
  let real = b;
  try { real = fs.realpathSync(b); } catch {}
  let npmShim = false;
  try { npmShim = fs.statSync(path.join(path.dirname(b), "node_modules", "@anthropic-ai", "claude-code")).isDirectory(); } catch {}
  if (npmShim || /[\\/]node_modules[\\/]@anthropic-ai[\\/]claude-code[\\/]/.test(real)) return "npm i -g @anthropic-ai/claude-code@latest";
  if (/[\\/]Caskroom[\\/]claude-code[^\\/]*[\\/]/.test(real)) return "brew upgrade --cask claude-code";
  return (/\s/.test(b) ? `"${b}"` : b) + " update";
}

/**
 * 这版 claude 认不认 --add-dir？（老版没有；不认的选项它静默吞掉，发了等于没发）
 * 用 --help 探：--add-dir 给个不存在的目录也 exit 0，probeOption 那套假值法判不出来。
 */
const addDirCaps = new Map();
async function probeAddDir(bin) {
  if (addDirCaps.has(bin)) return addDirCaps.get(bin);
  const p = probeHelp(bin, "--add-dir");
  addDirCaps.set(bin, p);
  return p;
}

/**
 * 这版 claude 认不认 --settings？「先问」规则靠它挂（见 run() 里 guard.ask 那段）。
 * 跟 --add-dir 一样用 --help 探：给它一份合法的 JSON 也是 exit 0，假值法判不出来
 */
const settingsCaps = new Map();
async function probeSettings(bin) {
  if (settingsCaps.has(bin)) return settingsCaps.get(bin);
  const p = probeHelp(bin, "--settings");
  settingsCaps.set(bin, p);
  return p;
}

/**
 * 工作目录之外还要让它读哪些地方：真实存在、不是 cwd 本身、去重。
 * 导出是为了让测试不起进程也能验这段逻辑。
 */
function pickAddDirs(addDirs, cwd) {
  const out = [];
  for (const d of addDirs || []) {
    if (!d || typeof d !== "string") continue;
    let real;
    try { real = fs.realpathSync(d); } catch { continue; } // 不存在的目录发过去 claude 会直接报错退出
    if (!fs.statSync(real).isDirectory()) continue;
    let c = cwd; try { c = fs.realpathSync(cwd); } catch {}
    if (real === c || out.includes(real)) continue;
    out.push(real);
  }
  return out;
}

/**
 * 收的是这个引擎的整份设置（{ bin, model, ... }），不是一个字符串——
 * 注册表那边传下来的本来就是整个 engine_options[id]，当字符串使会 spawn 一个对象，
 * 结果是「用户填了绝对路径反而永远显示没装」。
 */
async function detect(opts) {
  const o = typeof opts === "string" ? { bin: opts } : opts || {};
  const explicit = o.bin || "";
  // 本机装了不止一份时挑版本最新的那份（见 which.resolveNewest）。fresh：设置页这一下要看见刚升级完的样子
  const found = await resolveNewest("claude", explicit, versionOf, { fresh: true });
  if (!found.bin) return { id: ID, installed: false, path: explicit || "claude", version: "", how: "", error: found.why };
  const r = found.probe || (await versionOf(found.bin));
  // 装上了才去探选项：没装的话探了也只是白花一个 spawn
  const thinkingFlag = r.installed ? await probeThinking(found.bin) : false;
  const dir = claudeDir(o.env);
  const list = r.installed
    ? modelList({ aliases: await aliasesOf(found.bin, r.version), mine: settingsModels(dir) }, catalogModels(dir), r.version)
    : { models: [], info: [], needsUpgrade: [], source: "manual" };
  return {
    id: ID, installed: r.installed, path: found.bin, version: r.version, how: found.how,
    others: found.others || [],
    models: list.models, modelInfo: list.info, modelSource: list.source,
    needsUpgrade: list.needsUpgrade, upgrade: list.needsUpgrade.length ? upgradeCommand(found.bin) : "",
    caps: { thinkingFlag },
    error: r.installed ? "" : "找到了 " + found.bin + "，但 --version 跑不通",
  };
}

const CC_FIELDS = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"];
/**
 * Anthropic 的用量换成本项目的口径。input_tokens 不含缓存读写那两块，要加回来才是「这次真的喂进去多少」（跟 llm.js 同口径）。
 * 以前没加：缓存读 3 万、非缓存 1 千，界面就算出「缓存命中 3209%」
 */
function ccUsage(u) {
  return {
    prompt: Number(u.input_tokens || 0) + Number(u.cache_creation_input_tokens || 0) + Number(u.cache_read_input_tokens || 0),
    completion: Number(u.output_tokens || 0),
    cached: Number(u.cache_read_input_tokens || 0),
  };
}

/**
 * @returns {Promise<{finalText:string, usage:object, stopped:string|null, sessionId:string|null, model:string}>}
 *   model：这趟真跑的型号全名（填的是别名时，这里是它落到的那个），没报上来是空串
 */
async function run({
  prompt, cwd, emit = () => {}, deadline, stopSignal,
  model, systemPrompt, resumeId, maxTurns, mcpConfigPath, mcpServerNames = [], shimBin = "", bin, permissionMode, guard = {}, env, extraArgs = [],
  globalMcp = false,
  permissionPromptTool = "",
  thinking: thinkingLevel, addDirs = [],
  onWrite = null,
}) {
  // 闸在上游已经核过；这里再挡一次，护的是绕过 agent 直接调 run() 的那些入口（测试连接、目标拆解）。
  // 不传 --model 时 claude 会落到它自己设置里的默认型号，那不是属主选的，所以没钉就不跑
  const bad = gate.modelArg(extraArgs, ID);
  if (bad) throw new Error(`本机 Claude Code 的附加参数里有换型号的「${bad}」，到 ${gate.argsWhere(ID)} 里删掉它。`);
  const pinned = String(model || "").trim();
  if (!pinned) throw new Error(`先在 ${gate.WHERE} 里给本机 Claude Code 指定型号，再开跑。`);
  // 起进程也走同一套解析：detect 认出来的是绝对路径，run 却还 spawn 裸名字的话，
  // 双击启动的桌面版会「设置页显示已装、一跑就 ENOENT」
  const found = await resolveNewest("claude", bin, versionOf);
  if (!found.bin) throw new Error(found.why + "。装一个（npm i -g @anthropic-ai/claude-code），或在设置里填 claude 的绝对路径。");
  const exe = found.bin;
  // claude 自己的启动就是慢的：本机实测（2026-09-10，各跑 3 次）从 spawn 到它吐出第一条
  // system/init 要 3.8~4.5 秒，挂上 MCP 桥之后 5.7~7.2 秒——时间花在 CLI 冷启动和逐个连
  // MCP 服务器上，不在我们这边（我们这台桥 initialize 回包 76ms，两个探测并发起来 0.09 秒）。
  // 这几秒缩不掉，但「界面一片空白」是可以不发生的：以前那枚小牌子只在 init 到了才挂出来，
  // 用户按下发送之后好几秒什么都没有，看着像没点上。所以 bin 一确认存在就先挂一枚「正在启动」
  // 的同款牌子占住位置，init 一到原地换成带模型名和工具数的正式版——前端认的是同一个
  // .run-eng 节点，不会闪成两枚。放在探测之前，是因为探测本身还要 0.09 秒，牌子没必要跟着等。
  emit({ type: "status", starting: true, text: `本机 Claude Code 正在启动（连接工具中，一般 3~8 秒），不消耗 API 额度`, depth: 0 });
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  // 档位跟着设置页那颗开关走（security.engineGuard 翻的）。
  // 以前这里硬写死 acceptEdits：claude 自带的工具**不经过**本项目的安全中心
  // （只有从 MCP 桥回流的那批才走那道闸），于是用户选了「只看不动」，切到本机引擎
  // 照样随便改文件——界面上那颗开关等于摆设。engine_options 里手填的仍然最大。
  args.push("--permission-mode", permissionMode || guard.claudeMode || "acceptEdits");
  args.push("--model", pinned);
  if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
  if (resumeId) args.push("--resume", resumeId);
  if (maxTurns > 0) args.push("--max-turns", String(maxTurns));
  // 工作目录之外的东西——别的对话的产出、资料库、技能正文——-p 模式下默认不许碰：
  // 读一下都是「需要审批」，而这里没人能点同意，对外就是一句「不能读取文件」。
  // --add-dir 把这几处明着放进来（一个目录一个 --add-dir：这个选项是变长参数，
  // 一口气跟一串会把后面的东西也当目录吞掉）。老版 claude 不认这个选项时不发。
  // 几个探测互相不依赖，串行等于白等一趟往返。都带模块级缓存，同一个 bin 只有第一次真去 spawn
  // 「先问」规则（guard.ask，见 security.askingGuard）只有挂上了审批工具才有人答
  const asks = Array.isArray(guard.ask) ? guard.ask : [];
  const canAsk = asks.length > 0 && !!mcpConfigPath && !!permissionPromptTool;
  const [addDirOk, thinkingFlag, settingsOk] = await Promise.all([probeAddDir(exe), probeThinking(exe), canAsk ? probeSettings(exe) : false]);
  const dirs = pickAddDirs(addDirs, cwd);
  if (dirs.length && addDirOk) for (const d of dirs) args.push("--add-dir", d);
  if (mcpConfigPath) {
    args.push("--mcp-config", mcpConfigPath);
    // 只挂本项目递过去的这几台，不再顺带连用户全局的 MCP / 插件 / claude.ai 连接器。
    // 实测（2026-09-26）：带着全局那一串，每轮光启动就 7~8 秒（要等 Notion、Drive 这些远端握手），
    // 加上这一条是 2~3 秒；而且那些工具这条路上本来就用不上（没登录的直接挂 needs-auth）。
    // 和 codex 那条的隔离运行窝同一个取舍。确实要用全局那几台的，engine_options 里设 globalMcp: true
    if (!globalMcp) args.push("--strict-mcp-config");
    // -p 是非交互的：MCP 工具默认要人点一下"允许"，而这里没有人。
    // 不放行的话工具挂上了也调不动，模型看见一堆用不了的名字反而更糟。
    // 真正危险的动作由本项目自己的安全中心把关（工具是从这台桥回流的）。
    for (const n of mcpServerNames) args.push("--allowed-tools", "mcp__" + n);
    // 要审批时先问桥上那个 approve（属主勾了才有，见 engines/approve.js）。只跟着 --mcp-config 走：
    // 指到一台没挂上的服务器，claude 当场退出
    if (permissionPromptTool) args.push("--permission-prompt-tool", permissionPromptTool);
  }
  // 命令行那条路也得放行，否则模型敲了也白敲。实测（2026-09-08）：acceptEdits 下
  // `echo` 这种它自己判得出安全的命令能直接跑，但调一个它没见过的可执行文件会返回
  // 「This command requires approval」——-p 是非交互的，没人能点同意，于是工具形同虚设。
  // 只放行 owb 这一个前缀，不是整个 Bash：本项目的工具都从这台桥回流，安全中心照样把关。
  // 「只看不动」那一档连这条也不放：本项目的工具是能写文件的，从这道后门绕开档位，
  // 跟没设过没区别。别的档位放行——这批工具从桥回流时照样过本项目的安全中心
  if (shimBin && guard.allowShim !== false) args.push("--allowed-tools", `Bash(${shimBin}:*)`);
  // 名单里说「这类命令要问我一下」的：挂了审批（guard.ask，见 security.askingGuard）就写成 claude 的「先问」规则，
  // 它碰到就来问上面那个审批工具，主进程弹卡等人点。2.1.295 实测：rm、/bin/rm、复合命令里夹的 rm 都会来问，
  // 用户自己 settings 里写了「允许 rm」也压得住（先问比放行优先）。
  // 没挂审批、或这版 claude 不认 --settings 时问不着（-p 非交互），并回直接不给用，一条也不漏
  const asking = canAsk && settingsOk;
  if (asking) args.push("--settings", JSON.stringify({ permissions: { ask: asks } }));
  const deny = asks.length && !asking ? [...(guard.disallow || []), ...asks] : guard.disallow || [];
  for (const t of deny) args.push("--disallowed-tools", t);
  // 思考模式：跟 app 设置页那个下拉框同一个档位。auto 什么也不发（今天的行为一个字节不变），
  // 这版 claude 不认 --thinking 时也什么都不发 —— 发了会被静默吞掉，不如明着在界面上说不支持
  const think = thinking.planForEngine(ID, thinkingLevel, { thinkingFlag });
  for (const a of think.args) args.push(a);
  for (const a of extraArgs) args.push(a);

  let finalText = "";
  let sessionId = null;
  let stopped = null;
  let resultSeen = false;
  // 真跑的是哪个型号。assistant 消息里带的是 API 回报的，以它为准；init 里那个是 CLI 自己解析的，兜底用。
  // 「<synthetic>」这种尖括号的是 CLI 自己补的假消息，不算
  let ranModel = "";
  let initModel = "";
  // result 里报的错。未登录、限流、API 报错，claude 是写在这里的：stderr 空着、退出码 1。
  // 不捞的话 explain 只看得见空 stderr，用户拿到的是「退出码 1 且没有任何输出」
  let errText = "";
  let step = 0;
  // tool_result 块只带 tool_use_id 不带名字；名字在前面那条 tool_use 里。这里存一张 id→名字 的表——
  // 以前一律填空串，复盘挖掘器看到的就是「（空名）报错 49 次」：最大的一类信号却说不出是哪个工具
  const toolNames = new Map();
  const usage = { prompt: 0, completion: 0, cached: 0, calls: 0, elapsed_ms: 0 };
  // 每次模型调用（message.id）的用量。一次调用拆成好几条 assistant 吐（一段字一条、一个工具一条），
  // 带的是同一份 usage：同一个 id 只记一份，各格取最大的。result 那条是整趟的权威值，来了以它为准；
  // 按了停止、跑超时等不到 result，就拿这份加起来兜底（以前 void 掉，记 0）
  const perCall = new Map();
  let resultUsage = false;
  const startedAt = Date.now();

  const onLine = (m) => {
    if (!m || typeof m !== "object") return;
    if (m.session_id && !sessionId) sessionId = m.session_id;

    if (m.type === "system" && m.subtype === "init") {
      if (typeof m.model === "string") initModel = m.model.trim();
      emit({ type: "status", text: `本机 Claude Code 已启动（模型 ${m.model || "默认"}，${(m.tools || []).length} 个工具），不消耗 API 额度`, model: m.model || "", depth: 0 });
      return;
    }
    if (m.type === "assistant" && m.message) {
      const said = typeof m.message.model === "string" ? m.message.model.trim() : "";
      if (said && !said.startsWith("<")) ranModel = said;
      step += 1;
      emit({ type: "step_start", step, depth: 0 });
      const u = m.message.usage || {};
      const key = String(m.message.id || "step-" + step);
      const was = perCall.get(key) || {};
      const cur = {};
      for (const k of CC_FIELDS) cur[k] = Math.max(Number(was[k]) || 0, Number(u[k]) || 0);
      perCall.set(key, cur);
      for (const b of m.message.content || []) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "text" && b.text) emit({ type: "text", delta: b.text, depth: 0 });
        else if (b.type === "tool_use") {
          toolNames.set(b.id, b.name);
          emit({ type: "tool_use", id: b.id, name: b.name, purpose: purposeOf(b.name, b.input), depth: 0 });
          // 点名写的文件报上去：几条对话共用一趟扫描时，产出卡靠这个认主，不靠谁先比对
          const target = /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(b.name) && b.input ? b.input.file_path || b.input.notebook_path : "";
          if (onWrite && typeof target === "string" && target) { try { onWrite(path.resolve(cwd, target)); } catch {} }
        }
      }
      return;
    }
    if (m.type === "user" && m.message) {
      for (const b of m.message.content || []) {
        if (!b || typeof b !== "object" || b.type !== "tool_result") continue;
        const text = textOfToolResult(b.content);
        // 截在哪、原文一共几行都报上去：终端那头照这个说「还有 N 行」，不然 Bash 的输出只剩头一行、也不知道后面还有
        emit({
          type: "tool_result", id: b.tool_use_id, name: toolNames.get(b.tool_use_id) || "",
          isError: !!b.is_error, preview: text.slice(0, 800), cut: text.length > 800, lines: text.replace(/\n+$/, "").split("\n").length, depth: 0,
        });
      }
      return;
    }
    if (m.type === "result") {
      resultSeen = true;
      if (m.usage && typeof m.usage === "object") {
        Object.assign(usage, ccUsage(m.usage));
        resultUsage = true;
      }
      if (m.num_turns > 0) usage.calls = m.num_turns;
      const said = typeof m.result === "string" ? m.result.trim() : "";
      if (m.subtype === "error_max_turns") stopped = `已达最大步数（${maxTurns || m.num_turns} 步）`;
      else if (m.is_error) {
        // 真错误走抛异常那条路，不假装"跑满了"，也不把报错当成回答交出去
        stopped = null;
        errText = [said, ...(Array.isArray(m.errors) ? m.errors.map(String) : [])].filter(Boolean).join("\n");
        return;
      }
      if (said) finalText = said;
    }
  };

  const r = await runJsonl({ bin: exe, args, cwd, env, stdin: prompt, onLine, deadline, stopSignal });
  usage.elapsed_ms = Date.now() - startedAt;
  if (!resultUsage) {
    const sum = {};
    for (const k of CC_FIELDS) sum[k] = [...perCall.values()].reduce((t, c) => t + c[k], 0);
    Object.assign(usage, ccUsage(sum));
  }
  if (!(usage.calls > 0)) usage.calls = perCall.size;

  const ran = ranModel || (initModel.startsWith("<") ? "" : initModel);
  if (r.killed === "stopped") return { finalText, usage, stopped: "已手动停止", sessionId, model: ran };
  if (r.killed === "deadline") return { finalText, usage, stopped: "已达最大运行时间", sessionId, model: ran };
  if (!resultSeen || r.code !== 0 || errText) {
    if (finalText && r.code === 0 && !errText) return { finalText, usage, stopped, sessionId, model: ran }; // 有正文、干净退出，只是没吐 result
    throw new Error(explain([r.stderr, errText].filter(Boolean).join("\n"), r.code));
  }
  return { finalText, usage, stopped, sessionId, model: ran };
}

module.exports = {
  id: ID,
  label: "本机 Claude Code",
  bin: "claude",
  launchHeader: "claude -p --output-format stream-json",
  note: "用你电脑上已登录的 Claude Code 订阅跑，不消耗本项目配置的 API 额度",
  install: "npm i -g @anthropic-ai/claude-code，然后终端里跑一次 claude 登录",
  // 连不上时前端要给一句「接下来敲什么」。写在引擎自己身上，注册表那边就不用按 id 打补丁了
  login: "在终端里跑一次 claude 完成登录，再回来点一次",
  supportsResume: true,
  // 真正的候选由 detect() 从本机 claude 的型号表、--help 和 settings.json 读；这里只留永远有效的别名兜底
  models: ALIAS_FALLBACK,
  thinkingLabel: "扩展思考（claude 只有开/关，低中高都算开）",
  detect, run, explain, pickAddDirs,
  _internals: { catalogModels, modelList, upgradeCommand, settingsModels, claudeDir },
};
