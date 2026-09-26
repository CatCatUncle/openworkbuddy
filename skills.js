"use strict";
/**
 * 技能（Skills）系统 —— 把「怎么做一类活」写成文件，让 agent 按需加载，而不是塞进系统提示词常驻。
 *
 * 为什么不常驻：提示词里每多一段，每一条任务都要为它付一遍 token，而一份「做 PPT 的规矩」
 * 在写周报的任务里一个字都用不上。技能是按需加载的：agent 看 description 判断这次用不用得上，
 * 用得上才 use_skill 把正文读进来。
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
const { isIntranet } = require("./intranet");
const guard = require("./skill-guard");
// 外挂的第二把尺子。没装就是一串 null，merge 会原样把自带那份还回来。见 toolward.js
const toolward = require("./toolward");
const log = require("./log");

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

/** 同一个目录的两条路径（大小写不敏感的盘上 skills/Foo 和 skills/foo 是同一个东西） */
function samePlace(a, b) {
  if (!a || !b) return false;
  if (path.resolve(a) === path.resolve(b)) return true;
  try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return false; }
}

function saveSkill({ name, description, content, original_name, _scanned, confirm, force, actor }) {
  assertNotPluginSkill(original_name || name, "编辑");
  const n = safeName(name);
  const body = `---\nname: ${n}\ndescription: ${String(description || "").replace(/\r?\n/g, " ").trim()}\n---\n\n${String(content || "").trim()}\n`;
  /**
   * 手写/粘贴进来的技能也要过同一道闸。
   *
   * 不然这道检查就是个摆设：装的时候拦住了，把同一段字复制粘贴到「新建技能」框里就进来了，
   * 而那个框才是最顺手的一条路。写给自己看的技能被拦下会有点烦，所以拦下来的话
   * 界面上是「我知道了，还是保存」再来一次，不是不让存。
   * （_scanned 是给上面单文件安装那条路用的：那儿刚扫过一遍原文，别扫第二遍。）
   */
  const scan = _scanned ? null : gate(
    toolward.merge(guard.scanOne("skill.md", body), toolward.scanText("skill.md", body, null, { subject: n })),
    n, { confirm, force, actor });
  const oldDir = original_name ? findSkillDir(original_name) : findSkillDir(n);
  const dir = oldDir && path.basename(oldDir) !== n && !original_name ? oldDir : path.join(SKILLS_DIR, n);
  /**
   * 改名 = 把整个目录搬过去，不是「写一份新的再把旧的删了」。
   *
   * 以前是后者：新目录里只写了 skill.md，然后 rmSync 掉旧目录——技能自带的
   * references/ scripts/ templates/ 和各种模板文件当场全没，而且没有任何提示。
   * 从 GitHub 装来的技能几乎都带这些子目录（copySkillFolder 就是整棵树拷进来的），
   * 所以「装个技能，觉得名字不好听改一下」这条最自然的路径，正好是把它废掉的路径：
   * 界面上技能还在，跑起来 agent 报「文件不存在」，谁也想不到是改名那一下删的。
   */
  if (oldDir && !samePlace(oldDir, dir)) {
    if (fs.existsSync(dir)) throw new Error(`已经有一个叫「${n}」的技能了。换个名字，或者先把那个删掉再改`);
    try {
      fs.renameSync(oldDir, dir); // 同一个 skills/ 下，一次原子改名，资源文件一个都不动
    } catch {
      // 跨设备（数据目录被挂到别的盘）改不动名，退回「整棵树拷过去再删」，仍然一个文件都不丢
      fs.cpSync(oldDir, dir, { recursive: true });
      fs.rmSync(oldDir, { recursive: true, force: true });
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "skill.md"), body, "utf8");
  if (scan && scan.level !== "ok") writeProvenance(n, { source: "手写", actor, forced: !!force, scan });
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

/**
 * 装之前那道闸。
 *
 * 位置很关键：必须卡在 copySkillFolder **之前**。装完再扫等于没扫——
 * 文件已经在 SKILLS_DIR 里了，而 loadSkills 只看目录、不看有没有人放过行，
 * 下一条任务的提示词里它就已经在了。
 *
 * 三档：
 *   ok    直接装
 *   warn  要 opts.confirm —— 界面上把清单摆出来，人点了「知道了，装」才带这个标志再来一次
 *   block 要 opts.force  —— 而且只有平台管理员能给（路由那层管），并且一定落日志
 *
 * 为什么 block 也留了口子：静态规则一定会有拦错的时候，而且拦错的往往是**正当的**技能。
 * 拿本地 34 个正常技能实测，两个被拦的都是真命中：一个是 Windows 首次运行文档里写着
 * `irm https://astral.sh/uv/install.ps1 | iex`（它确实叫你执行远程脚本），
 * 另一个更绝——一个资讯聚合技能缓存下来的博客正文里，有一句在**讲解**这种攻击：
 * 「它不动声色地让 Claude 去读 ~/.aws/credentials，编码后 POST 出去」。
 * 同一句话，写在技能的指令里是攻击，出现在它抓回来的新闻里是新闻，正则分不出来。
 * 一道人绕不过去的闸，人就会绕过整个工具（直接把目录拷进 skills/ 就行了，谁也拦不住）。
 * 所以留口子，但留得响：要管理员、要显式 force、要留档。
 */
function gate(scan, name, opts = {}) {
  const who = (opts.actor && opts.actor.user) || "";
  if (scan.level === "block" && !opts.force) {
    const e = new Error(guard.explain(scan, name) + "\n\n确实要装的话，让平台管理员在技能页点「仍然安装」——那一下会记进日志和技能目录里的 .install.json。");
    e.skillScan = scan; e.needs = "force";
    log.warn("skill", "安装被拦下", { name, verdict: scan.level, rules: scan.findings.filter((f) => f.level === "block").map((f) => f.rule), by: who });
    throw e;
  }
  if (scan.level === "warn" && !opts.confirm && !opts.force) {
    const e = new Error(guard.explain(scan, name) + "\n\n看完还是要装，就再点一次「确认安装」。");
    e.skillScan = scan; e.needs = "confirm";
    throw e;
  }
  if (scan.level !== "ok") {
    log.warn("skill", scan.level === "block" ? "管理员强行安装了被拦下的技能" : "带告警安装", {
      name, verdict: scan.level, forced: !!opts.force,
      rules: [...new Set(scan.findings.map((f) => f.rule))], hosts: scan.hosts.slice(0, 10), by: who,
    });
  }
  return scan;
}

/**
 * 装完在技能目录里留一张回执 .install.json：从哪儿装的、上游哪个 commit、扫出什么、谁放的行。
 * 出事之后能回答「这东西什么时候、谁、从哪儿装进来的」——没有这张纸，装完就查不出来了。
 * （名字以点开头：loadSkills 的 hasAssets 判断跳过点开头的文件，不会因此把技能误判成带资源。）
 */
function writeProvenance(name, info) {
  // 干净的手写技能不留：来源是「手写」、没有 commit、扫描没话说——
  // 一张三行都是空的回执只会让人以后懒得看这个文件。从 GitHub 装的不一样，
  // 「哪个仓库、哪个 commit」本身就是出事之后唯一答得上话的东西，干净也要记。
  if (!info.source || info.source === "手写") {
    if (!info.scan || info.scan.level === "ok") return;
  }
  try {
    const dir = path.join(SKILLS_DIR, safeName(name));
    if (!fs.existsSync(dir)) return;
    fs.writeFileSync(path.join(dir, ".install.json"), JSON.stringify({
      installed_at: new Date().toISOString(),
      source: info.source || "", commit: info.commit || "",
      by: (info.actor && info.actor.user) || "", forced: !!info.forced,
      scan: info.scan ? {
        level: info.scan.level, files: info.scan.files, hosts: info.scan.hosts,
        findings: info.scan.findings.map((f) => ({ level: f.level, rule: f.rule, file: f.file, line: f.line })),
      } : null,
    }, null, 2) + "\n");
  } catch (e) {
    log.warn("skill", "安装回执没写上（不影响安装本身）", { name, err: e });
  }
}

/** 一个源目录 → 它的名字、描述、体检结果。只看不动，不碰磁盘。 */
function inspectSkillDir(srcDir) {
  const fmFile = fs.readdirSync(srcDir).find((f) => /^skill\.md$/i.test(f));
  const fm = parseFrontmatter(fs.readFileSync(path.join(srcDir, fmFile), "utf8"));
  const name = safeName(fm.name || path.basename(srcDir));
  /**
   * 两把尺子量同一个目录：自带的 skill-guard 一定跑，外挂的 toolward 装了才跑。
   * 它没装、崩了、超时了、换了输出格式，scanDir 一律还 null，merge 就把自带那份原样交出去——
   * 安装流程一个字不变。第二意见只该多看见几条，绝不能因为自己缺席就把事情卡住。
   */
  const mine = guard.scanDir(srcDir);
  return { srcDir, name, description: fm.description,
    scan: toolward.merge(mine, toolward.scanDir(srcDir, null, { subject: name })) };
}

function installedFromDir(srcDir, opts = {}) {
  const { name, description: fmDesc, scan: fresh } = inspectSkillDir(srcDir);
  const fm = { description: fmDesc };
  const scan = gate(opts.scan || fresh, name, opts);   // ← 拷贝之前
  const { skipped, bytes } = copySkillFolder(srcDir, name);
  writeProvenance(name, { source: opts.source, commit: opts.commit, actor: opts.actor, forced: !!opts.force, scan });
  return { name, description: fm.description, bytes, skipped, scan: { level: scan.level, findings: scan.findings.length, hosts: scan.hosts } };
}

/**
 * 支持的链接形式：
 * 1. 单文件：raw.githubusercontent.com/.../xxx.md 或 github.com/owner/repo/blob/branch/path/xxx.md
 * 2. 子目录：github.com/owner/repo/tree/branch/path（该目录本身是技能，或其下多个技能全装）
 * 3. 整仓库：github.com/owner/repo（根目录是技能，或扫其子目录批量安装）
 */
async function installFromGitHub(url, opts = {}) {
  const u = String(url || "").trim().replace(/\/+$/, "");
  if (!u) throw new Error("请填写 GitHub 链接");

  // 内网里 github.com 是通不了的，而且国央企防火墙多半是「把包默默丢掉」——不回 RST。
  // 于是下面那句 fetch 要白等满 30 秒（走 clone 那条路是 180 秒）才报一句看不出原因的
  // 网络错，人只会以为是链接填错了，再试一遍、再等半分钟。当场说清楚，并给出真走得通的路子：
  // loadSkills() 就是扫 SKILLS_DIR，把含 skill.md 的目录拷进去，重启就认。
  if (isIntranet()) {
    throw new Error(
      "内网模式装不了 GitHub 上的技能：github.com 连不上，硬等只会拿到一句超时。\n" +
      "改成本地装：把技能目录（里面要有 skill.md）拷到 " + SKILLS_DIR + " 下面，一个目录一个技能。\n" +
      "确实能出网的话，把内网模式关掉（config.json 里 intranet 改 false，或设 OPENWORKBUDDY_INTRANET=0）。"
    );
  }

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
    // 单文件这条路也得过闸。以前它直接 saveSkill 落盘，等于开了个后门：
    // 同一份内容放进目录里要过检查，摘出来单独给一个 .md 链接反而不用。
    const scan = gate(
      toolward.merge(guard.scanOne("skill.md", raw), toolward.scanText("skill.md", raw, null, { subject: name })),
      name, opts);
    saveSkill({ name, description: fm.description, content: fm.content, _scanned: true });
    writeProvenance(name, { source: rawUrl, actor: opts.actor, forced: !!opts.force, scan });
    return [{ name, description: fm.description, scan: { level: scan.level, findings: scan.findings.length, hosts: scan.hosts } }];
  }

  // ---- 仓库 / 子目录：克隆一次拿全部 ----
  const m = u.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+)(?:\/(.*))?)?$/i);
  if (!m) throw new Error("暂不支持该链接格式；支持 github.com 仓库 / tree 子目录 / blob 单文件 / raw 直链");
  const [, owner, repo, branch, subpath] = m;
  const { tmp, cleanup } = cloneRepo({ owner, repo, branch, subpath });
  try {
    const root = subpath ? path.join(tmp, ...subpath.split("/")) : tmp;
    if (!fs.existsSync(root)) throw new Error(`仓库里没有 ${subpath} 这个目录（分支 ${branch || "默认"}）`);
    adaptLibraryAsSkill(root, opts);
    const dirs = discoverSkillDirs(root);
    if (!dirs.length) throw new Error("该链接下没找到 skill.md / SKILL.md（技能=含 skill.md 的目录）");
    // 记下上游这一刻是哪个 commit。「我装的时候不是这样的」这句话，只有这个数能证明。
    let commit = "";
    try {
      const { spawnSync } = require("child_process");
      const r = spawnSync("git", ["-C", tmp, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 10000 });
      if (r.status === 0) commit = String(r.stdout || "").trim().slice(0, 40);
    } catch {}
    // 先把这个仓库里的技能全扫一遍，再决定动不动手。
    // 一个链接下面可能有好几个技能（ppt-master 那种库就是），扫一个装一个的话，
    // 第三个被拦下时前两个已经落在 skills/ 里了 —— 用户看到的是「安装失败」，
    // 实际装进去两个，而且不会有人再去翻一遍。要拦就整单拦。
    const found = dirs.map(inspectSkillDir);
    for (const it of found) gate(it.scan, it.name, opts);
    return found.map((it) => installedFromDir(it.srcDir, { ...opts, source: u, commit, scan: it.scan }));
  } finally {
    cleanup();
  }
}

/**
 * 把一个「代码库」当技能装：上游本来就不是技能仓库（没有 skill.md），
 * 我们自己写一份 skill.md 塞进去，告诉 agent 这个库是干什么的、怎么用。
 * 顺手只留白名单文件（README / LICENSE 之类）——库的测试语料、字体、demo 不该进技能目录。
 * 上游要是哪天自己加了 skill.md，以上游为准，不覆盖。
 */
function adaptLibraryAsSkill(root, { skillMd = "", files = null } = {}) {
  if (!skillMd) return false;
  const hasSkill = fs.readdirSync(root).some((f) => /^skill\.md$/i.test(f));
  if (hasSkill) return false;
  if (Array.isArray(files)) {
    const keep = new Set(files.map((f) => f.toLowerCase()));
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      if (!keep.has(e.name.toLowerCase())) fs.rmSync(path.join(root, e.name), { recursive: true, force: true });
    }
  }
  fs.writeFileSync(path.join(root, "skill.md"), String(skillMd).trim() + "\n");
  return true;
}

/**
 * 浅克隆到临时目录。指定了子路径就走稀疏克隆（--filter=blob:none --sparse + sparse-checkout），
 * 只下载要的那棵子树——像 ppt-master 那种 700MB+ 的仓库，装一个子技能不该把整仓拖下来。
 * 老版本 git 不支持 --sparse，退回普通浅克隆，不因此装不上。
 */
function cloneRepo({ owner, repo, branch, subpath }) {
  const os = require("os");
  const { spawnSync } = require("child_process");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owb-skill-"));
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
    name: "archify",
    title: "交互式架构图 Archify",
    repo: "tt-a1i/archify", branch: "main", subpath: "archify",
    license: "MIT", author: "tt-a1i",
    bytes: 43 * 1024 * 1024,
    why: "把系统架构、工作流、时序、数据流和生命周期做成可验证、可交互、可独立打开的 HTML；很适合交付 Agent 方案、Trace 和自动化流程图",
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
    // 这个包里写死的是 Anthropic 自家的配色字体，装了不会变成「你的」品牌；自己的产品走内置的品牌档案
    why: "Anthropic 自家的品牌规范示例，配色字体都是 Anthropic 的；给自己的产品建档用内置的「品牌档案」",
  },
  {
    name: "web-artifacts-builder",
    title: "交互网页 / 小应用",
    repo: "anthropics/skills", branch: "main", subpath: "skills/web-artifacts-builder",
    license: "Apache-2.0", author: "Anthropic",
    bytes: 45 * 1024,
    why: "要的不是一张静态页，而是有多屏、带状态、点得动的小应用时用它；做完配合「网页自测」再点一遍",
  },
  {
    name: "algorithmic-art",
    title: "算法生成艺术",
    repo: "anthropics/skills", branch: "main", subpath: "skills/algorithmic-art",
    license: "Apache-2.0", author: "Anthropic",
    bytes: 58 * 1024,
    why: "用代码画封面底图、纹理、数据艺术——那种规则感和想放多大放多大的分辨率，生图模型给不了",
  },
  {
    name: "internal-comms",
    title: "对内沟通文案",
    repo: "anthropics/skills", branch: "main", subpath: "skills/internal-comms",
    license: "Apache-2.0", author: "Anthropic",
    bytes: 22 * 1024,
    why: "全员公告、变更通知、事故复盘，最容易写崩的是语气和分寸，它给的正是这个",
  },
  {
    name: "claude-api",
    title: "Claude API 接入",
    repo: "anthropics/skills", branch: "main", subpath: "skills/claude-api",
    license: "Apache-2.0", author: "Anthropic",
    bytes: 1147 * 1024,
    why: "写调用 Claude 的代码时照官方最新用法来：流式、工具调用、提示词缓存、批量，不吃模型记忆里那些过时写法",
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
    why: "做正经 PPT 的一整套模板与工作流。注意：自带大量模板素材，装完约 171MB、克隆要几分钟，磁盘紧张就别装",
  },
  {
    name: "pretext",
    title: "文字排版测量 Pretext",
    repo: "chenglou/pretext", branch: "main", subpath: "",
    license: "MIT", author: "Cheng Lou",
    bytes: 24 * 1024,
    why: "生成网页/海报/图表时，文字会不会换行、会占几行、容器该多宽，用纯算术算准，不再靠猜。上游是个 JS 库，我们附一份用法说明装成技能，只取 README 和 LICENSE",
    // 上游是库不是技能仓库，没有 skill.md——装的时候把这份说明写进去
    files: ["README.md", "LICENSE"],
    /* emoji-数据区 起：pretext 这份技能文档的正文本身就在演示 emoji + 阿拉伯语混排的分词量宽，例子里的表情是被测量的数据 */
    skill_md: `---
name: pretext
description: 文字排版测量库 @chenglou/pretext 的用法。做网页、海报、SVG/Canvas 图、信息图时，用它算一段文字在给定字体和宽度下占几行、多高、最窄能收到多宽，避免标题溢出、卡片高度对不齐、文字撞图。
---

# Pretext：不碰 DOM 的多行文字测量与排版

上游：https://github.com/chenglou/pretext（MIT，作者 Cheng Lou）。纯 JS/TS，支持中英文、阿拉伯文、emoji 等混排，
以浏览器自己的字体引擎为准做测量，但排版是纯算术，不触发 reflow。

## 什么时候用
- 生成 html-page / 海报 / 信息图时，要保证按钮、标题、卡片里的文字**不溢出、不多换一行**。
- 卡片/气泡要「刚好包住文字」（shrink-wrap）、多列瀑布流要提前知道每块多高。
- 在 Canvas / SVG 上自己一行行画文字（fillText / <text>），需要自己断行。
- 长列表虚拟滚动，需要不渲染就知道每条多高。

## 安装 / 引入
- Node / 打包工程：\`npm install @chenglou/pretext\`
- 写进生成的 HTML：**把 layout.js 下载下来内联进 \`<script type="module">\`，别从 CDN import**。
  交付物是单文件 HTML，用户可能断网双击、发给同事、在国央企内网里打开；
  ESM 的 import 一旦解析不到，整个 \`<script type="module">\` 直接不执行，**不报错、不回退**——
  页面就是文字堆在一起，比白屏还难查。取文件：
  \`curl -O https://cdn.jsdelivr.net/npm/@chenglou/pretext@0.0.9/dist/layout.js\`（这一步在你这台机器上跑，产出物里不许留这个地址）
- 它需要浏览器环境（用 canvas 量字宽）；纯 Node 端暂不可用。

## 用法一：只要高度 / 行数
\`\`\`js
import { prepare, layout } from "@chenglou/pretext";
const prepared = prepare("AGI 春天到了. بدأت الرحلة 🚀", "16px Inter"); // 一次性：分词 + 量宽
const { height, lineCount } = layout(prepared, 320, 20);              // 纯算术：最大宽 320，行高 20
\`\`\`
- \`font\` 写法同 \`ctx.font\`（如 \`"600 18px 'PingFang SC'"\`），必须和 CSS 里实际用的字体、字号一致，否则量出来不准。
- 同一段文字换宽度只重跑 \`layout()\`，别重跑 \`prepare()\`。
- 选项：\`{ whiteSpace: "pre-wrap" }\` 保留空格/换行；\`{ wordBreak: "keep-all" }\`；\`{ letterSpacing: n }\`（px）。

## 用法二：自己一行行排（Canvas / SVG）
\`\`\`js
import { prepareWithSegments, layoutWithLines, measureLineStats, walkLineRanges } from "@chenglou/pretext";
const p = prepareWithSegments(text, "18px 'Helvetica Neue'");
const { lines } = layoutWithLines(p, 320, 26);            // 每行的 text / width
lines.forEach((l, i) => ctx.fillText(l.text, 0, i * 26));
const { lineCount, maxLineWidth } = measureLineStats(p, 320); // 只要行数和最宽行，不分配字符串
\`\`\`
- 「最窄能收到多宽」：\`walkLineRanges(p, w, line => ...)\` 取最宽行；或对宽度做二分找行数刚好的值（气泡/卡片 shrink-wrap）。
- 每行宽度不同（绕图排版）：\`layoutNextLineRange(p, cursor, width)\` 一行一行推进，\`materializeLineRange\` 拿到该行文本。
- 富文本行内（@提及、代码片、chip）：\`@chenglou/pretext/rich-inline\` 的 \`prepareRichInline / walkRichInlineLineRanges\`。
- 连字符：在文本里预先插软连字符（U+00AD），它会当可选断点。

## 交付时的检查清单
1. 生成的页面里每个定宽容器内的标题/按钮文案，用 \`layout()\` 算一次 \`lineCount\`，超过设计预期就缩字号或加宽。
2. 多卡片同排时，用最大 \`height\` 统一卡片高度，而不是让浏览器各排各的。
3. 字体没加载完就测会偏差：\`await document.fonts.ready\` 之后再 \`prepare()\`。
`,
    /* emoji-数据区 止 */
  },
  {
    name: "follow-builders",
    title: "独立开发者信息源",
    repo: "zarazhangrui/follow-builders", branch: "main", subpath: "",
    license: "MIT", author: "zarazhangrui",
    bytes: 4 * 1024 * 1024,
    why: "一份独立开发者/AI 圈的博客、播客、X 账号订阅源，配合 web_search 追前沿（MIT 是作者在 README 里声明的，仓库没放 LICENSE 文件）",
    // 这条会被我们自己的安装检查拦下，看过了，放行：
    // feed-blogs.json 是它缓存下来的博客正文，第 13 行那篇文章正在**讲解**提示词注入——
    // 原文大意是「它不动声色地让 Claude 去读 ~/.aws/credentials，编码后 POST 出去」。
    // 同一句话写在技能的指令里是攻击，出现在它抓回来的资讯里是新闻，正则分不出这两者。
    // 这也正是为什么 block 要能被人显式放行：静态规则的上限就在这儿。
    reviewed: "feed-blogs.json 里缓存的一篇讲提示词注入的文章，命中 read-private-key",
  },
  {
    name: "holo-card-studio",
    title: "全息闪卡 Holo Card Studio",
    repo: "EverettFish/holo-card-studio", branch: "main", subpath: "",
    license: "MIT", author: "EverettFish",
    bytes: 2 * 1024 * 1024,
    why: "一句话做出一张会随视角流光溢彩的 3D 全息闪卡：AI 画好主体/背景/线稿/文字四层图，Blender 搭场景做视差与镭射，再组装成能拖着转、翻面、拉滑块的网页，附赠可编辑的 card.blend。也支持光栅卡、双形态卡、一念神魔。本机没装 Blender 的话，它第一次跑会自己去下一份便携版",
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
    const { skill_md, ...pub } = s; // 说明全文留在服务端，前端只需要「有没有」
    return {
      ...pub,
      bundled_doc: !!skill_md,
      url: defaultSkillUrl(s),
      installed: !!dir,
      installed_bytes: dir ? dirSize(dir) : 0,
    };
  });
}

/** 清单条目 → installFromGitHub 的选项（库型条目要注入 skill.md、只留白名单文件） */
/**
 * 清单条目 → installFromGitHub 的选项（库型条目要注入 skill.md、只留白名单文件）。
 *
 * confirm 恒为 true：这张清单上的仓库是我们自己一条条挑的，每条都钉死了 repo + branch，
 * 都读过、都在上面写了 license 和「为什么装它」。让一条 warn 把首次启动卡住，
 * 换来的不是安全，是用户学会了对所有告警点「继续」。
 *
 * force 只有写了 reviewed 的条目才给——也就是说，**默认技能里哪一条会被自己的检查拦下、
 * 拦在哪一行、我们看过之后为什么还是放行**，全在清单里写着，不是一个笼统的「默认的都信」。
 * 上游哪天真被投毒，拦下来的会是**别的**行，那时它照样装不上。
 */
function defaultInstallOpts(s) {
  return {
    skillMd: s.skill_md || "",
    files: Array.isArray(s.files) ? s.files : null,
    confirm: true,
    force: !!s.reviewed,
    actor: { user: "系统（默认技能清单）" },
  };
}

/** 装一条默认技能（已装就原样返回，幂等） */
async function installDefaultSkill(name, { force = false } = {}) {
  const s = DEFAULT_SKILLS.find((x) => x.name === name);
  if (!s) throw new Error(`默认技能清单里没有「${name}」`);
  if (!force && findSkillDir(s.name)) return { name: s.name, skipped_existing: true };
  const installed = await installFromGitHub(defaultSkillUrl(s), defaultInstallOpts(s));
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
      const installed = await installFromGitHub(defaultSkillUrl(s), defaultInstallOpts(s));
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
  parseFrontmatter, dirSize, safeName, adaptLibraryAsSkill, defaultInstallOpts,
  // 安装那道闸的内部件：测试要能直接按住「拷贝之前」这一刻验，
  // 走 installFromGitHub 得先有个 GitHub 仓库，那验的就不是闸而是网络了。
  _internals: { gate, installedFromDir, writeProvenance, copySkillFolder, discoverSkillDirs },
};
