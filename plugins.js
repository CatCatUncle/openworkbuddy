"use strict";
/**
 * Agent Plugins 1.0.0 客户端 — https://agent-plugins.org
 *
 * 一个插件就是一个目录：
 *   my-plugin/
 *   ├── plugin.json          清单（$schema + name 必填，closed schema）
 *   ├── skills/<技能>/SKILL.md   Agent Skills
 *   ├── mcp.json             MCP 服务器配置（stdio / streamable-http / sse）
 *   └── com.example.client/  别家客户端的私有扩展目录，我们原样忽略
 *
 * 规范的核心态度是「失败要隔离在最小范围」：一个技能坏了不影响兄弟技能，
 * 一条 MCP 条目坏了不影响其他条目和技能。这份实现严格照着做，
 * 每一层跳过都记进 warnings 往上报，不静默吞。
 *
 * 一致性范围：实现 skills + MCP 两类组件；MCP 传输支持 stdio 与 streamable-http，
 * 遗留 HTTP+SSE 按规范属可选项，本客户端不实现（遇到时只跳过该条目）。
 */

const fs = require("fs");
const path = require("path");
const { dataPath } = require("./paths");

const SPEC_VERSION = "1.0.0";
const PLUGIN_SCHEMA = `https://agent-plugins.org/schemas/${SPEC_VERSION}/plugin.schema.json`;
const MCP_SCHEMA = `https://agent-plugins.org/schemas/${SPEC_VERSION}/mcp.schema.json`;

const PLUGINS_DIR = dataPath("plugins");
// PLUGIN_DATA 要跨插件升级保留，所以放 data/ 下而不是插件目录里（插件目录重装会被整个删掉）
const PLUGIN_DATA_ROOT = dataPath("data", "plugin-data");
// 装到哪来的记在插件目录外面：记在里面会被当成插件自己的文件，重装时又正好被删掉
const SOURCES_PATH = dataPath("data", "plugin-sources.json");

const NAME_RE = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const MANIFEST_FIELDS = ["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "extensions"];
const AUTHOR_FIELDS = ["name", "email", "url"];
// 本客户端实现的传输。sse（遗留 HTTP+SSE）规范里是可选项，这里不实现。
const SUPPORTED_TRANSPORTS = ["stdio", "streamable-http"];
const TRANSPORT_FIELDS = {
  stdio: { required: ["type", "command"], allowed: ["type", "command", "args", "env", "cwd"] },
  "streamable-http": { required: ["type", "url"], allowed: ["type", "url", "headers"] },
  sse: { required: ["type", "url"], allowed: ["type", "url", "headers"] },
};

class PluginError extends Error {}

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/** 解析符号链接后判断 child 是否还在 root 里面 —— 规范的「包边界」，插件不许把手伸到目录外 */
function containedIn(root, child) {
  let r, c;
  try { r = fs.realpathSync(root); } catch { return false; }
  try {
    c = fs.realpathSync(child);
  } catch {
    // 目标还不存在（比如待创建的 cwd）：拿存在的最近祖先来判，防止用 ../ 逃出去
    let p = path.resolve(child);
    for (;;) {
      const up = path.dirname(p);
      if (up === p) return false;
      p = up;
      try { c = path.join(fs.realpathSync(p), path.relative(p, path.resolve(child))); break; } catch {}
    }
  }
  const rel = path.relative(r, c);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// ---------------- plugin.json ----------------

/**
 * 校验清单。两种违规是「非致命」（报出来但继续加载）：未知顶层字段、extensions 不是对象。
 * 其余任何 schema 违规直接否掉整个插件。
 */
function validateManifest(raw, warnings) {
  if (!isPlainObject(raw)) throw new PluginError("plugin.json 顶层必须是一个 JSON 对象");

  // $schema 决定用哪套校验规则，且必须本地就认识它 —— 规范明令加载时不许去网上取 schema
  const schema = raw.$schema;
  if (typeof schema !== "string" || !schema) throw new PluginError("plugin.json 缺少必填字段 $schema");
  if (schema !== PLUGIN_SCHEMA) throw new PluginError(`不支持的 $schema：${schema}（本客户端实现的是 Agent Plugins ${SPEC_VERSION}）`);

  const name = raw.name;
  if (typeof name !== "string") throw new PluginError("plugin.json 缺少必填字段 name");
  if (name.length < 1 || name.length > 64) throw new PluginError(`name 长度必须在 1~64 之间（当前 ${name.length}）`);
  if (!NAME_RE.test(name)) throw new PluginError(`name「${name}」不合规范：只允许小写字母、数字、. 和 -，首尾必须是字母或数字，且不能出现 -- 或 ..`);

  for (const k of Object.keys(raw)) {
    // 未知顶层字段：报一声、忽略、继续（规范点名的非致命项）
    if (!MANIFEST_FIELDS.includes(k)) warnings.push(`plugin.json 有未知字段「${k}」，已忽略`);
  }
  for (const k of ["version", "description", "homepage", "repository", "license"]) {
    if (k in raw && typeof raw[k] !== "string") throw new PluginError(`plugin.json 的 ${k} 必须是字符串`);
  }
  if ("keywords" in raw) {
    if (!Array.isArray(raw.keywords) || raw.keywords.some((x) => typeof x !== "string")) throw new PluginError("plugin.json 的 keywords 必须是字符串数组");
  }
  if ("author" in raw) {
    if (!isPlainObject(raw.author)) throw new PluginError("plugin.json 的 author 必须是对象");
    for (const k of Object.keys(raw.author)) {
      if (!AUTHOR_FIELDS.includes(k)) throw new PluginError(`plugin.json 的 author 有未知字段「${k}」`);
      if (typeof raw.author[k] !== "string") throw new PluginError(`plugin.json 的 author.${k} 必须是字符串`);
    }
  }
  let extensions = {};
  if ("extensions" in raw) {
    // extensions 不是对象：同样是非致命，报一声当没有
    if (!isPlainObject(raw.extensions)) warnings.push("plugin.json 的 extensions 不是对象，已忽略");
    else extensions = raw.extensions; // 命名空间归各家客户端所有，不认识的一律不校验、不解读
  }
  return { schema, name, version: raw.version || "", description: raw.description || "", author: raw.author || null, homepage: raw.homepage || "", repository: raw.repository || "", license: raw.license || "", keywords: raw.keywords || [], extensions };
}

// ---------------- skills/ ----------------

/** skills/ 的直接子目录里有名字正好是 SKILL.md 的普通文件，才算一个技能；不往更深处递归找 */
function discoverSkills(root, warnings) {
  const dir = path.join(root, "skills");
  if (!fs.existsSync(dir)) return []; // 没有 skills/ 不是错误
  let st;
  try { st = fs.statSync(dir); } catch { return []; }
  if (!st.isDirectory()) {
    warnings.push("skills 存在但不是目录，技能组件整体失效（不影响 MCP）");
    return [];
  }
  if (!containedIn(root, dir)) {
    warnings.push("skills 解析后跑到了插件目录外，技能组件整体失效");
    return [];
  }

  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const sdir = path.join(dir, e.name);
    try { if (!fs.statSync(sdir).isDirectory()) continue; } catch { continue; }
    // 必须按目录项逐个比名字，不能直接 stat("SKILL.md")：macOS/Windows 的文件系统不分大小写，
    // 一个 skill.md 也能 stat 成功，规范要求的「文件名正好是 SKILL.md」就形同虚设了。
    let names;
    try { names = fs.readdirSync(sdir); } catch { continue; }
    if (!names.includes("SKILL.md")) {
      const loose = names.find((f) => /^skill\.md$/i.test(f));
      if (loose) warnings.push(`技能「${e.name}」里是 ${loose}，Agent Plugins 要求文件名正好是 SKILL.md，已跳过`);
      continue;
    }
    const md = path.join(sdir, "SKILL.md");
    let mst;
    try { mst = fs.statSync(md); } catch { continue; }
    if (!mst.isFile()) { warnings.push(`技能「${e.name}」的 SKILL.md 不是普通文件，已跳过`); continue; }
    if (!containedIn(root, md)) { warnings.push(`技能「${e.name}」的 SKILL.md 跑到了插件目录外，已跳过`); continue; }

    const { parseFrontmatter } = require("./skills");
    let fm;
    try { fm = parseFrontmatter(fs.readFileSync(md, "utf8")); } catch (err) { warnings.push(`技能「${e.name}」读取失败：${err.message}，已跳过`); continue; }
    if (!fm.name && !fm.description) {
      // Agent Skills 规范要求 frontmatter 至少有 name/description，缺了 agent 无从判断何时该用它
      warnings.push(`技能「${e.name}」的 SKILL.md 没有 name/description frontmatter，不符合 Agent Skills 规范，已跳过`);
      continue;
    }
    out.push({ name: fm.name || e.name, description: fm.description, content: fm.content, dir: sdir });
  }
  return out;
}

// ---------------- mcp.json ----------------

/** 只在 args / env 值 / cwd 里展开这两个占位符，别处一律当普通字符串 */
function expandVars(s, vars) {
  return String(s).replace(/\$\{(PLUGIN_ROOT|PLUGIN_DATA)\}/g, (_, k) => vars[k]);
}

/**
 * 两段式校验：先看 mcp.json 顶层（坏了整个插件的 MCP 组件失效），
 * 再逐条看 server 条目（坏了只废这一条，兄弟条目和技能都不受影响）。
 */
function discoverMcpServers(root, pluginName, warnings) {
  const file = path.join(root, "mcp.json");
  if (!fs.existsSync(file)) return [];
  try { if (!fs.statSync(file).isFile()) { warnings.push("mcp.json 不是普通文件，MCP 组件整体失效"); return []; } } catch { return []; }
  if (!containedIn(root, file)) { warnings.push("mcp.json 解析后跑到了插件目录外，MCP 组件整体失效"); return []; }

  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { warnings.push(`mcp.json 不是合法 JSON（${e.message}），MCP 组件整体失效`); return []; }

  // ---- 第一段：顶层 ----
  if (!isPlainObject(doc)) { warnings.push("mcp.json 顶层必须是对象，MCP 组件整体失效"); return []; }
  if (doc.$schema !== MCP_SCHEMA) {
    warnings.push(`mcp.json 的 $schema 是「${doc.$schema || "(缺失)"}」，要求与 plugin.json 同版本的 ${MCP_SCHEMA}，MCP 组件整体失效`);
    return [];
  }
  if (!isPlainObject(doc.mcpServers)) { warnings.push("mcp.json 缺少必填的 mcpServers 对象，MCP 组件整体失效"); return []; }
  const unknown = Object.keys(doc).filter((k) => k !== "$schema" && k !== "mcpServers");
  if (unknown.length) { warnings.push(`mcp.json 有未知顶层字段 ${unknown.join("/")}，MCP 组件整体失效`); return []; }

  const dataDir = path.join(PLUGIN_DATA_ROOT, pluginName);
  const vars = { PLUGIN_ROOT: root, PLUGIN_DATA: dataDir };

  // ---- 第二段：逐条 ----
  const out = [];
  for (const [id, entry] of Object.entries(doc.mcpServers)) {
    const skip = (why) => warnings.push(`MCP 条目「${id}」${why}，已跳过（不影响其他条目）`);
    if (!isPlainObject(entry)) { skip("不是对象"); continue; }
    const type = entry.type;
    if (!TRANSPORT_FIELDS[type]) { skip(`传输类型「${type || "(缺失)"}」无法识别`); continue; }
    const { required, allowed } = TRANSPORT_FIELDS[type];
    const bad = Object.keys(entry).find((k) => !allowed.includes(k));
    if (bad) { skip(`有 ${type} 传输不允许的字段「${bad}」`); continue; }
    const miss = required.find((k) => !(k in entry));
    if (miss) { skip(`缺少必填字段「${miss}」`); continue; }
    if (!SUPPORTED_TRANSPORTS.includes(type)) { skip(`用的是 ${type} 传输，本客户端只实现了 ${SUPPORTED_TRANSPORTS.join(" / ")}`); continue; }

    if (type === "stdio") {
      if (typeof entry.command !== "string" || !entry.command) { skip("command 必须是非空字符串"); continue; }
      if ("args" in entry && (!Array.isArray(entry.args) || entry.args.some((a) => typeof a !== "string"))) { skip("args 必须是字符串数组"); continue; }
      if ("env" in entry && (!isPlainObject(entry.env) || Object.values(entry.env).some((v) => typeof v !== "string"))) { skip("env 必须是字符串到字符串的对象"); continue; }
      if (entry.env && ("PLUGIN_ROOT" in entry.env || "PLUGIN_DATA" in entry.env)) { skip("env 里不许自己定义 PLUGIN_ROOT / PLUGIN_DATA（由客户端注入）"); continue; }

      // command 是「一个可执行文件 token」，不是 shell 命令行；./ 开头的按插件根解析并做包含检查
      let command = entry.command;
      if (command.startsWith("./")) {
        const abs = path.resolve(root, command);
        if (!containedIn(root, abs)) { skip("command 指向插件目录外"); continue; }
        command = abs;
      }

      let cwd = root; // 默认工作目录 = 插件根
      if ("cwd" in entry) {
        if (typeof entry.cwd !== "string" || !/^(?:\.\/|\$\{PLUGIN_ROOT\}(?:\/|$)|\$\{PLUGIN_DATA\}(?:\/|$))/.test(entry.cwd)) {
          skip("cwd 只能以 ./ 或 ${PLUGIN_ROOT} 或 ${PLUGIN_DATA} 开头"); continue;
        }
        cwd = path.resolve(root, expandVars(entry.cwd, vars));
        if (!containedIn(root, cwd) && !containedIn(dataDir, cwd)) { skip("cwd 跑出了插件根和 PLUGIN_DATA 的范围"); continue; }
      }

      out.push({
        name: `${pluginName}__${id}`,
        transport: "stdio",
        command,
        args: (entry.args || []).map((a) => expandVars(a, vars)),
        // env 先叠在客户端基础环境上，PLUGIN_ROOT / PLUGIN_DATA 最后写，谁也覆盖不了
        env: { ...Object.fromEntries(Object.entries(entry.env || {}).map(([k, v]) => [k, expandVars(v, vars)])), PLUGIN_ROOT: root, PLUGIN_DATA: dataDir },
        cwd,
        pluginDataDir: dataDir,
      });
    } else {
      if (typeof entry.url !== "string" || !entry.url) { skip("url 必须是非空字符串"); continue; }
      let parsed;
      try { parsed = new URL(entry.url); } catch { skip("url 不是合法 URL"); continue; }
      if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") { skip("远程 MCP 必须走 https（本机 localhost 除外）"); continue; }
      if ("headers" in entry && (!isPlainObject(entry.headers) || Object.values(entry.headers).some((v) => typeof v !== "string"))) { skip("headers 必须是字符串到字符串的对象"); continue; }
      out.push({ name: `${pluginName}__${id}`, transport: "streamable-http", url: entry.url, headers: entry.headers || {}, origin: parsed.origin });
    }
  }
  return out;
}

// ---------------- 加载 ----------------

/**
 * 加载一个插件目录。返回 { ok, name, manifest, skills, mcpServers, warnings, error }。
 * ok=false 时 error 说明为什么整个插件被否掉；ok=true 时 warnings 里是被跳过的零件。
 */
function loadPlugin(dir) {
  const warnings = [];
  let root;
  try { root = fs.realpathSync(dir); } catch { return { ok: false, dir, name: path.basename(dir), warnings, error: "插件目录不存在" }; }

  const manifestPath = path.join(root, "plugin.json");
  if (!fs.existsSync(manifestPath)) return { ok: false, dir: root, name: path.basename(root), warnings, error: "没有 plugin.json（Agent Plugins 要求清单在插件根目录）" };
  if (!containedIn(root, manifestPath)) return { ok: false, dir: root, name: path.basename(root), warnings, error: "plugin.json 解析后跑到了插件目录外" };

  let manifest;
  try {
    manifest = validateManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8")), warnings);
  } catch (e) {
    return { ok: false, dir: root, name: path.basename(root), warnings, error: e instanceof SyntaxError ? `plugin.json 不是合法 JSON：${e.message}` : e.message };
  }

  // 清单过了才谈组件；下面每一类失败都只影响自己
  const skills = discoverSkills(root, warnings);
  const mcpServers = discoverMcpServers(root, manifest.name, warnings);
  return { ok: true, dir: root, name: manifest.name, manifest, skills, mcpServers, warnings, error: "" };
}

/** 扫 plugins/ 下所有插件。装不上的也返回（带 error），界面要能告诉用户哪个坏了、为什么 */
function loadPlugins() {
  if (!fs.existsSync(PLUGINS_DIR)) return [];
  const out = [];
  for (const e of fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    out.push(loadPlugin(path.join(PLUGINS_DIR, e.name)));
  }
  return out;
}

/** 所有插件贡献的技能，打上来源标记，供 loadSkills 合并 */
function pluginSkills() {
  const out = [];
  for (const p of loadPlugins()) {
    if (!p.ok) continue;
    for (const s of p.skills) {
      const names = fs.readdirSync(s.dir);
      out.push({
        name: s.name,
        description: s.description,
        content: s.content,
        dir: s.dir,
        hasAssets: names.some((f) => !/^skill\.md$/i.test(f) && !f.startsWith(".")),
        plugin: p.name, // 有这个字段就是插件带来的：只读，不许在技能编辑器里改删
      });
    }
  }
  return out;
}

/** 所有插件贡献的 MCP 服务器配置，交给 McpManager 启动 */
function pluginMcpServers() {
  const out = [];
  for (const p of loadPlugins()) {
    if (!p.ok) continue;
    for (const s of p.mcpServers) {
      if (s.transport === "stdio") fs.mkdirSync(s.pluginDataDir, { recursive: true }); // PLUGIN_DATA 必须在启动前就存在且可写
      out.push({ ...s, plugin: p.name });
    }
  }
  return out;
}

// ---------------- 安装 / 卸载 ----------------

function safePluginDirName(name) {
  const n = String(name || "").trim();
  if (!NAME_RE.test(n) || n.length > 64) throw new PluginError(`插件名「${n}」不合 Agent Plugins 规范`);
  return n;
}

/** 安装来源登记簿：{ 插件名: { url, at } }，坏了就当空的，不许拖累加载 */
function readSources() {
  try {
    const j = JSON.parse(fs.readFileSync(SOURCES_PATH, "utf8"));
    return isPlainObject(j) ? j : {};
  } catch {
    return {};
  }
}
function writeSources(map) {
  fs.mkdirSync(path.dirname(SOURCES_PATH), { recursive: true });
  fs.writeFileSync(SOURCES_PATH, JSON.stringify(map, null, 2), "utf8");
}
function pluginSource(name) {
  const e = readSources()[name];
  return e && e.url ? e.url : "";
}

/** 从 GitHub 装一个插件（仓库根是插件，或 tree 子目录是插件）。装之前先校验，坏的不落盘。 */
async function installPluginFromGitHub(url) {
  const u = String(url || "").trim().replace(/\/+$/, "");
  const m = u.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+)(?:\/(.*))?)?$/i);
  if (!m) throw new PluginError("请填 github.com/owner/repo 或 github.com/owner/repo/tree/分支/子目录");
  const [, owner, repo, branch, subpath] = m;

  const os = require("os");
  const { spawnSync } = require("child_process");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-plugin-"));
  try {
    const br = branch ? ["--branch", branch] : [];
    const gitUrl = `https://github.com/${owner}/${repo}.git`;
    let r = spawnSync("git", ["clone", "--depth", "1", "--filter=blob:none", "--sparse", ...br, gitUrl, tmp], { timeout: 180000, encoding: "utf8" });
    if (r.status === 0 && subpath) spawnSync("git", ["-C", tmp, "sparse-checkout", "set", subpath], { timeout: 60000, encoding: "utf8" });
    else if (r.status === 0 && !subpath) spawnSync("git", ["-C", tmp, "sparse-checkout", "disable"], { timeout: 60000, encoding: "utf8" });
    if (r.status !== 0) {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.mkdirSync(tmp, { recursive: true });
      r = spawnSync("git", ["clone", "--depth", "1", ...br, gitUrl, tmp], { timeout: 180000, encoding: "utf8" });
      if (r.status !== 0) throw new PluginError(`git clone 失败：${(r.stderr || r.error?.message || "").trim().slice(0, 300)}`);
    }

    const src = subpath ? path.join(tmp, ...subpath.split("/")) : tmp;
    if (!fs.existsSync(path.join(src, "plugin.json"))) {
      throw new PluginError(`这个链接下没有 plugin.json —— 它不是 Agent Plugins 插件。如果只是一批技能，用「从 GitHub 安装技能」`);
    }
    // 先在临时目录里验一遍：清单不合规就不往 plugins/ 里落，免得留一堆装不上的垃圾
    const probe = loadPlugin(src);
    if (!probe.ok) throw new PluginError(`插件校验不通过：${probe.error}`);

    const destName = safePluginDirName(probe.name);
    const dest = path.join(PLUGINS_DIR, destName);
    fs.mkdirSync(PLUGINS_DIR, { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    copyTree(src, dest);
    const loaded = loadPlugin(dest);
    // 记下来源，之后「更新」才有地方去拉；写失败不影响这次安装
    try {
      writeSources({ ...readSources(), [loaded.name]: { url: u, at: new Date().toISOString() } });
    } catch (e) {
      console.warn(`[插件] 来源没记上（不影响使用）：${e.message}`);
    }
    return {
      name: loaded.name,
      version: loaded.manifest?.version || "",
      description: loaded.manifest?.description || "",
      license: loaded.manifest?.license || "",
      author: loaded.manifest?.author?.name || "",
      skills: loaded.skills.map((s) => s.name),
      mcp_servers: loaded.mcpServers.map((s) => s.name),
      warnings: loaded.warnings,
      source: u,
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const MAX_PLUGIN_FILE = 20 * 1024 * 1024;
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const f = path.join(from, e.name);
    if (e.isDirectory()) copyTree(f, path.join(to, e.name));
    else if (e.isFile() && fs.statSync(f).size <= MAX_PLUGIN_FILE) fs.copyFileSync(f, path.join(to, e.name));
  }
}

function removePlugin(name) {
  const dir = path.join(PLUGINS_DIR, safePluginDirName(name));
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  try {
    const map = readSources();
    if (map[name]) { delete map[name]; writeSources(map); }
  } catch { /* 登记簿写不动不该让卸载失败 */ }
  return true; // PLUGIN_DATA 故意留着：规范要求跨升级保留，用户重装插件数据还在
}

/** 按记下来的来源重新拉一遍（版本没变也照拉，上游可能只改了内容没改版本号） */
async function updatePlugin(name) {
  const url = pluginSource(name);
  if (!url) throw new PluginError("这个插件没有记录安装来源（多半是手动拷进 plugins/ 的），请用「装插件」重新填地址");
  const before = loadPlugin(path.join(PLUGINS_DIR, safePluginDirName(name)));
  const info = await installPluginFromGitHub(url);
  if (info.name !== name) throw new PluginError(`来源里的插件现在叫「${info.name}」，和「${name}」对不上，已按新名字装好，旧的请手动卸载`);
  return { ...info, from_version: before.ok ? before.manifest?.version || "" : "" };
}

module.exports = {
  SPEC_VERSION, PLUGIN_SCHEMA, MCP_SCHEMA, PLUGINS_DIR, PLUGIN_DATA_ROOT, SOURCES_PATH,
  loadPlugin, loadPlugins, pluginSkills, pluginMcpServers,
  installPluginFromGitHub, removePlugin, updatePlugin, pluginSource, containedIn, expandVars,
};
