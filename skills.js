"use strict";
/**
 * 技能（Skills）系统 — 仿 WorkBuddy 技能包。
 * skills/<技能名>/skill.md，带 frontmatter：
 *   ---
 *   name: ppt-design
 *   description: 一句话描述（用于 agent 判断何时使用）
 *   ---
 *   正文（详细操作指南，agent 通过 use_skill 工具按需加载）
 */

const fs = require("fs");
const path = require("path");

const SKILLS_DIR = path.join(__dirname, "skills");

function loadSkills() {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  const skills = [];
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
  return skills;
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
  if (!dir) return null;
  const fm = parseFrontmatter(fs.readFileSync(path.join(dir, "skill.md"), "utf8"));
  return { name: fm.name || path.basename(dir), description: fm.description, content: fm.content, dir: path.basename(dir) };
}

function saveSkill({ name, description, content, original_name }) {
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
  const dir = findSkillDir(name);
  if (!dir) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

// ---------- 从 GitHub 安装 ----------

const MAX_FILE = 5 * 1024 * 1024; // 单文件 5MB 上限，跳过超大资产
function copySkillFolder(src, destName) {
  const dest = path.join(SKILLS_DIR, safeName(destName));
  fs.rmSync(dest, { recursive: true, force: true });
  const walk = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const f = path.join(from, e.name);
      if (e.isDirectory()) walk(f, path.join(to, e.name));
      else if (e.isFile() && fs.statSync(f).size <= MAX_FILE) {
        // 统一成小写 skill.md（Claude 系技能仓库惯用大写 SKILL.md）
        const outName = /^skill\.md$/i.test(e.name) ? "skill.md" : e.name;
        fs.copyFileSync(f, path.join(to, outName));
      }
    }
  };
  walk(src, dest);
  return dest;
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
  copySkillFolder(srcDir, name);
  return { name, description: fm.description };
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

  // ---- 仓库 / 子目录：浅克隆一次拿全部 ----
  const m = u.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+)(?:\/(.*))?)?$/i);
  if (!m) throw new Error("暂不支持该链接格式；支持 github.com 仓库 / tree 子目录 / blob 单文件 / raw 直链");
  const [, owner, repo, branch, subpath] = m;
  const os = require("os");
  const { spawnSync } = require("child_process");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-skill-"));
  try {
    const args = ["clone", "--depth", "1", ...(branch ? ["--branch", branch] : []), `https://github.com/${owner}/${repo}.git`, tmp];
    const r = spawnSync("git", args, { timeout: 120000, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git clone 失败：${(r.stderr || r.error?.message || "").trim().slice(0, 300)}`);
    const root = subpath ? path.join(tmp, ...subpath.split("/")) : tmp;
    if (!fs.existsSync(root)) throw new Error(`仓库里没有 ${subpath} 这个目录（分支 ${branch || "默认"}）`);
    const dirs = discoverSkillDirs(root);
    if (!dirs.length) throw new Error("该链接下没找到 skill.md / SKILL.md（技能=含 skill.md 的目录）");
    return dirs.map(installedFromDir);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { loadSkills, SKILLS_DIR, getSkillFull, saveSkill, deleteSkill, installFromGitHub };
