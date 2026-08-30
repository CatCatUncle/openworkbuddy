"use strict";
/**
 * 技能（Skills）系统 — 对标腾讯 WorkBuddy 的技能包机制。
 * skills/<技能名>/skill.md，带 frontmatter：
 *   ---
 *   name: ppt-design
 *   description: 一句话描述（用于 agent 判断何时使用）
 *   ---
 *   正文（详细操作指南，agent 通过 use_skill 工具按需加载）
 */

const fs = require("fs");
const path = require("path");
const { dataPath } = require("./paths");

const SKILLS_DIR = dataPath("skills");

function loadSkills() {
  const skills = [];
  if (fs.existsSync(SKILLS_DIR)) {
    for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(SKILLS_DIR, entry.name);
      const names = fs.readdirSync(dir);
      const file = names.find((f) => /^skill\.md$/i.test(f));
      if (!file) continue;
      const fm = parseFrontmatter(fs.readFileSync(path.join(dir, file), "utf8"));
      // hasAssets：技能除 skill.md 外还自带 scripts/templates 等资源（agent 需要知道目录在哪）
      const hasAssets = names.some((f) => !/^skill\.md$/i.test(f) && !f.startsWith("."));
      skills.push({ name: fm.name || entry.name, description: fm.description, content: fm.content, dir, hasAssets });
    }
  }
  // Agent Plugins 插件带来的技能一并进来。重名时本地 skills/ 优先——
  // 用户自己写的和自己装的，不该被后装的插件悄悄顶掉。
  const own = new Set(skills.map((s) => s.name));
  for (const s of safePluginSkills()) if (!own.has(s.name)) skills.push(s);
  return skills;
}

/** 插件系统坏了不该让整个技能表加载不出来 */
function safePluginSkills() {
  try {
    return require("./plugins").pluginSkills();
  } catch (e) {
    console.warn("[插件] 技能加载失败:", e.message);
    return [];
  }
}

// ---------- 技能管理（新建/编辑/删除/从 GitHub 安装），getSkills 每次现读磁盘，改完即热生效 ----------

function safeName(name) {
  const n = String(name || "").trim().replace(/[\/\\:*?"<>|\s]+/g, "-").slice(0, 60);
  if (!n || n === "." || n === "..") throw new Error("技能名不合法");
  return n;
}

function parseFrontmatter(raw) {
  const m = String(raw).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const out = { name: "", description: "", content: String(raw).trim() };
  if (m) {
    out.content = m[2].trim();
    const lines = m[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const kv = lines[i].match(/^(\w+):\s*(.*)$/); // 只认顶层键，metadata 下的缩进行不会误匹配
      if (!kv || (kv[1] !== "name" && kv[1] !== "description")) continue;
      let val = kv[2].trim();
      // YAML 折行块（Claude 系 SKILL.md 常见 description: >）：吸收后续缩进行拼成一行
      if (/^[>|][+-]?$/.test(val)) {
        const parts = [];
        while (i + 1 < lines.length && (!lines[i + 1].trim() || /^\s+\S/.test(lines[i + 1]))) {
          parts.push(lines[++i].trim());
        }
        val = parts.filter(Boolean).join(" ");
      }
      out[kv[1]] = val.replace(/^["']|["']$/g, "");
    }
  }
  return out;
}

/** 按名字找技能目录（优先 frontmatter name 匹配，回退目录名匹配） */
function findSkillDir(name) {
  if (!fs.existsSync(SKILLS_DIR)) return null;
  for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(SKILLS_DIR, entry.name, "skill.md");
    if (!fs.existsSync(file)) continue;
    const fm = parseFrontmatter(fs.readFileSync(file, "utf8"));
    if ((fm.name || entry.name) === name || entry.name === name) return path.join(SKILLS_DIR, entry.name);
  }
  return null;
}

function getSkillFull(name) {
  const dir = findSkillDir(name);
  if (dir) {
    const fm = parseFrontmatter(fs.readFileSync(path.join(dir, "skill.md"), "utf8"));
    return { name: fm.name || path.basename(dir), description: fm.description, content: fm.content, dir: path.basename(dir) };
  }
  // 插件带来的技能也能查看，但归插件所有：只读
  const ps = safePluginSkills().find((s) => s.name === name);
  if (!ps) return null;
  return { name: ps.name, description: ps.description, content: ps.content, dir: path.basename(ps.dir), plugin: ps.plugin, readonly: true };
}

/** 插件技能属于插件，不许从技能编辑器改或删——要动就去插件页卸载整个插件 */
function assertNotPluginSkill(name, verb) {
  if (findSkillDir(name)) return;
  const ps = safePluginSkills().find((s) => s.name === name);
  if (ps) throw new Error(`「${name}」来自插件 ${ps.plugin}，不能在这里${verb}。如需移除，去「插件」页卸载该插件`);
}

function saveSkill({ name, description, content, original_name }) {
  assertNotPluginSkill(original_name || name, "编辑");
  const n = safeName(name);
  const body = `---\nname: ${n}\ndescription: ${String(description || "").replace(/\r?\n/g, " ").trim()}\n---\n\n${String(content || "").trim()}\n`;
  // 改名：先写新目录再删旧目录
  const oldDir = original_name ? findSkillDir(original_name) : findSkillDir(n);
  const dir = oldDir && path.basename(oldDir) !== n && !original_name ? oldDir : path.join(SKILLS_DIR, n);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "skill.md"), body, "utf8");
  if (original_name && oldDir && path.resolve(oldDir) !== path.resolve(dir)) fs.rmSync(oldDir, { recursive: true, force: true });
  return getSkillFull(n);
}

function deleteSkill(name) {
  assertNotPluginSkill(name, "删除");
  const dir = findSkillDir(name);
  if (!dir) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

// ---------- 从 GitHub 安装 ----------

const MAX_FILE = 5 * 1024 * 1024; // 单文件 5MB 上限，跳过超大资产

/**
 * 拷进 skills/<名字>/。返回 { dest, skipped, bytes }。
 * skipped 是被 MAX_FILE 拦下的文件清单——必须往上报：以前是静默丢，
 * 技能装完少了个字体/模板，agent 跑到一半报"文件不存在"，谁也想不到是安装时吞了。
 */
function copySkillFolder(src, destName) {
  const dest = path.join(SKILLS_DIR, safeName(destName));
  fs.rmSync(dest, { recursive: true, force: true });
  const skipped = [];
  let bytes = 0;
  const walk = (from, to, rel) => {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const f = path.join(from, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(f, path.join(to, e.name), r);
      else if (e.isFile()) {
        const size = fs.statSync(f).size;
        if (size > MAX_FILE) {
          skipped.push({ path: r, size });
          continue;
        }
        // 统一成小写 skill.md（Claude 系技能仓库惯用大写 SKILL.md）
        const outName = /^skill\.md$/i.test(e.name) ? "skill.md" : e.name;
        fs.copyFileSync(f, path.join(to, outName));
        bytes += size;
      }
    }
  };
  walk(src, dest, "");
  return { dest, skipped, bytes };
}

/** 目录占用字节数（给界面标体积用） */
function dirSize(dir) {
  let n = 0;
  const walk = (d) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) { try { n += fs.statSync(f).size; } catch {} }
    }
  };
  walk(dir);
  return n;
}

/** 目录里找 skill.md/SKILL.md；没有则扫一层子目录（含 skills/ 子目录），返回全部技能目录 */
function discoverSkillDirs(root) {
  const hasSkill = (d) => fs.readdirSync(d).some((f) => /^skill\.md$/i.test(f));
  if (hasSkill(root)) return [root];
  const found = [];
  const scan = (base) => {
    for (const e of fs.readdirSync(base, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === ".git" || e.name === "node_modules") continue;
      const d = path.join(base, e.name);
      if (hasSkill(d)) found.push(d);
      else if (["skills", "document-skills"].includes(e.name)) scan(d); // 常见技能集合目录再往下看一层
    }
  };
  scan(root);
  return found;
}

function installedFromDir(srcDir) {
  const fmFile = fs.readdirSync(srcDir).find((f) => /^skill\.md$/i.test(f));
  const fm = parseFrontmatter(fs.readFileSync(path.join(srcDir, fmFile), "utf8"));
  const name = safeName(fm.name || path.basename(srcDir));
  const { skipped, bytes } = copySkillFolder(srcDir, name);
  return { name, description: fm.description, bytes, skipped };
}

/**
 * 支持的链接形式：
 * 1. 单文件：raw.githubusercontent.com/.../xxx.md 或 github.com/owner/repo/blob/branch/path/xxx.md
 * 2. 子目录：github.com/owner/repo/tree/branch/path（该目录本身是技能，或其下多个技能全装）
 * 3. 整仓库：github.com/owner/repo（根目录是技能，或扫其子目录批量安装）
 */
async function installFromGitHub(url) {
  const u = String(url || "").trim().replace(/\/+$/, "");
  if (!u) throw new Error("请填写 GitHub 链接");

  // ---- 单个 markdown 文件 ----
  let rawUrl = null;
  if (/^https:\/\/raw\.githubusercontent\.com\/.+\.md$/i.test(u)) rawUrl = u;
  const blob = u.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+\.md)$/i);
  if (blob) rawUrl = `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}/${blob[4]}`;
  if (rawUrl) {
    const resp = await fetch(rawUrl, { signal: AbortSignal.timeout(30000) });
    if (!resp.ok) throw new Error(`下载失败 HTTP ${resp.status}（确认链接可公开访问）`);
    const raw = await resp.text();
    const fm = parseFrontmatter(raw);
    const base = decodeURIComponent(rawUrl.split("/").pop()).replace(/\.md$/i, "");
    const dirHint = decodeURIComponent(rawUrl.split("/").slice(-2, -1)[0] || "");
    const name = safeName(fm.name || (/^skill$/i.test(base) ? dirHint : base));
    saveSkill({ name, description: fm.description, content: fm.content });
    return [{ name, description: fm.description }];
  }

  // ---- 仓库 / 子目录：克隆一次拿全部 ----
  const m = u.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+)(?:\/(.*))?)?$/i);
  if (!m) throw new Error("暂不支持该链接格式；支持 github.com 仓库 / tree 子目录 / blob 单文件 / raw 直链");
  const [, owner, repo, branch, subpath] = m;
  const { tmp, cleanup } = cloneRepo({ owner, repo, branch, subpath });
  try {
    const root = subpath ? path.join(tmp, ...subpath.split("/")) : tmp;
    if (!fs.existsSync(root)) throw new Error(`仓库里没有 ${subpath} 这个目录（分支 ${branch || "默认"}）`);
    const dirs = discoverSkillDirs(root);
    if (!dirs.length) throw new Error("该链接下没找到 skill.md / SKILL.md（技能=含 skill.md 的目录）");
    return dirs.map(installedFromDir);
  } finally {
    cleanup();
  }
}

/**
 * 浅克隆到临时目录。指定了子路径就走稀疏克隆（--filter=blob:none --sparse + sparse-checkout），
 * 只下载要的那棵子树——像 ppt-master 那种 700MB+ 的仓库，装一个子技能不该把整仓拖下来。
 * 老版本 git 不支持 --sparse，退回普通浅克隆，不因此装不上。
 */
function cloneRepo({ owner, repo, branch, subpath }) {
  const os = require("os");
  const { spawnSync } = require("child_process");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-skill-"));
  const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
  const url = `https://github.com/${owner}/${repo}.git`;
  const br = branch ? ["--branch", branch] : [];
  const run = (args) => spawnSync("git", args, { timeout: 180000, encoding: "utf8" });

  if (subpath) {
    const r = run(["clone", "--depth", "1", "--filter=blob:none", "--sparse", ...br, url, tmp]);
    if (r.status === 0) {
      const s = run(["-C", tmp, "sparse-checkout", "set", subpath]);
      if (s.status === 0) return { tmp, cleanup };
      // 稀疏范围设置失败：退成全量检出，别让用户卡在这
      run(["-C", tmp, "sparse-checkout", "disable"]);
      return { tmp, cleanup };
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
  }
  const r = run(["clone", "--depth", "1", ...br, url, tmp]);
  if (r.status !== 0) {
    cleanup();
    throw new Error(`git clone 失败：${(r.stderr || r.error?.message || "").trim().slice(0, 300)}`);
  }
  return { tmp, cleanup };
}

// ---------- 默认技能清单 ----------

/**
 * 推荐技能目录：不随仓库一起打包（体积、协议都不归我们），点一下从上游装。
 * 每条都标清上游地址 / 子路径 / 协议 / 作者 —— 装别人的东西，先让用户看见是谁的、什么协议。
 * ⚠️ anthropics/skills 里的 docx / pdf / pptx / xlsx 是「源码可见但非开源」（All rights reserved），
 * 故意不收进来；本项目自带 docx / excel-report / ppt-design 已覆盖同类需求。
 */
const DEFAULT_SKILLS = [
  {
    name: "frontend-design",
    title: "前端设计品味",
    repo: "anthropics/skills", branch: "main", subpath: "skills/frontend-design",
    license: "Apache-2.0", author: "Anthropic",
    bytes: 18 * 1024,
    why: "生成的网页不再是「能跑但难看」，补 html-page 的审美短板",
  },
  {
    name: "canvas-design",
    title: "海报 / 图形设计",
    repo: "anthropics/skills", branch: "main", subpath: "skills/canvas-design",
    license: "Apache-2.0", author: "Anthropic",
    bytes: 5424 * 1024,
    why: "画封面、海报、社交图；自带字体资源，所以体积偏大",
  },
  {
    name: "theme-factory",
    title: "配色主题工厂",
    repo: "anthropics/skills", branch: "main", subpath: "skills/theme-factory",
    license: "Apache-2.0", author: "Anthropic",
    bytes: 141 * 1024,
    why: "一套配色贯穿 PPT / 网页 / 报告，成果看起来是一家出品",
  },
  {
    name: "brand-guidelines",
    title: "品牌规范落地",
    repo: "anthropics/skills", branch: "main", subpath: "skills/brand-guidelines",
    license: "Apache-2.0", author: "Anthropic",
    bytes: 13 * 1024,
    why: "把公司 VI 喂给它，之后所有交付物自动守规范",
  },
  {
    name: "webapp-testing",
    title: "网页自测",
    repo: "anthropics/skills", branch: "main", subpath: "skills/webapp-testing",
    license: "Apache-2.0", author: "Anthropic",
    bytes: 22 * 1024,
    why: "做完网页自己点一遍再交付，配合「本地部署预览」用",
  },
  {
    name: "mcp-builder",
    title: "MCP 连接器生成",
    repo: "anthropics/skills", branch: "main", subpath: "skills/mcp-builder",
    license: "Apache-2.0", author: "Anthropic",
    bytes: 119 * 1024,
    why: "让它自己写 MCP 服务器，接进本项目的连接器体系",
  },
  {
    name: "ppt-master",
    title: "PPT 大师",
    repo: "hugohe3/ppt-master", branch: "main", subpath: "",
    license: "MIT", author: "Hugo He",
    bytes: 171 * 1024 * 1024,
    why: "做正经 PPT 的一整套模板与工作流。⚠️ 自带大量模板素材，装完约 171MB、克隆要几分钟，磁盘紧张就别装",
  },
  {
    name: "follow-builders",
    title: "独立开发者信息源",
    repo: "zarazhangrui/follow-builders", branch: "main", subpath: "",
    license: "MIT", author: "zarazhangrui",
    bytes: 4 * 1024 * 1024,
    why: "一份独立开发者/AI 圈的博客、播客、X 账号订阅源，配合 web_search 追前沿（MIT 是作者在 README 里声明的，仓库没放 LICENSE 文件）",
  },
];

function defaultSkillUrl(s) {
  // 整仓就是一个技能时 subpath 是空的，别拼出个带尾斜杠的 .../tree/main/
  return `https://github.com/${s.repo}/tree/${s.branch}` + (s.subpath ? "/" + s.subpath : "");
}

/** 默认技能清单 + 每条是否已装、装完实际占多大 */
function listDefaultSkills() {
  return DEFAULT_SKILLS.map((s) => {
    const dir = findSkillDir(s.name);
    return {
      ...s,
      url: defaultSkillUrl(s),
      installed: !!dir,
      installed_bytes: dir ? dirSize(dir) : 0,
    };
  });
}

/** 装一条默认技能（已装就原样返回，幂等） */
async function installDefaultSkill(name, { force = false } = {}) {
  const s = DEFAULT_SKILLS.find((x) => x.name === name);
  if (!s) throw new Error(`默认技能清单里没有「${name}」`);
  if (!force && findSkillDir(s.name)) return { name: s.name, skipped_existing: true };
  const installed = await installFromGitHub(defaultSkillUrl(s));
  return { name: s.name, installed };
}

/**
 * 缺哪个装哪个，幂等：已装的跳过，装失败的记下来继续装下一个，
 * 不让一条网络抖动把整批拖垮。返回逐条结果，界面照实显示。
 */
async function ensureDefaultSkills({ only = null, force = false } = {}) {
  const targets = only ? DEFAULT_SKILLS.filter((s) => only.includes(s.name)) : DEFAULT_SKILLS;
  const results = [];
  for (const s of targets) {
    if (!force && findSkillDir(s.name)) {
      results.push({ name: s.name, status: "existing" });
      continue;
    }
    try {
      const installed = await installFromGitHub(defaultSkillUrl(s));
      const skipped = installed.flatMap((i) => i.skipped || []);
      results.push({
        name: s.name,
        status: "installed",
        count: installed.length,
        bytes: installed.reduce((n, i) => n + (i.bytes || 0), 0),
        skipped, // 超过 5MB 被跳过的文件，如实报出来
      });
    } catch (e) {
      results.push({ name: s.name, status: "failed", error: e.message });
    }
  }
  return results;
}

module.exports = {
  loadSkills, SKILLS_DIR, getSkillFull, saveSkill, deleteSkill, installFromGitHub,
  DEFAULT_SKILLS, listDefaultSkills, installDefaultSkill, ensureDefaultSkills,
  parseFrontmatter, dirSize, safeName,
};
