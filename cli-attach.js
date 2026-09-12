"use strict";
/**
 * 终端里怎么把文件和图片带进来。
 *
 * 用户原话：「还有我的wb cli也要支持复制文件 图片这些啊」。网页端三条路都通——点回形针、
 * 拖进窗口、Cmd+V 粘图；终端里一条都没有，只能先自己 cp 到工作目录，再把文件名一个字
 * 一个字打对。终端本来就有现成的两条路：拖一个文件进窗口，它会把路径贴进来（空格是
 * 转义的）；从 Finder 拷个路径，它贴进来的空格**没有**转义。这一层就是把这几种形状
 * 都认出来。
 *
 * 一条口径跟网页端完全一致：**带进来的东西不进对话历史。** 文件落到工作目录，消息尾巴上
 * 挂一句「（已上传文件：×××）」，agent.js 的工作规范 3.1 见了这句就知道先 look_at_image /
 * read_file 看一眼再动手。图是 token 大户，塞进历史等于每走一步重发一遍；更要命的是纯文本
 * 模型收到图直接 400，而会话是落盘的，那个会话就此永久废掉。
 *
 * 三条边界：
 *   1. **认不出来就当普通文字。** 一句话里提到 ./a.png 而盘上没有这个文件，那多半是在
 *      谈论它，不是要带它——原样发出去，不许自作主张。
 *   2. **@ 是明说「带这个」。** 所以 @ 找不到得吭一声（cli.js 打一行灰字），不能默默咽掉。
 *   3. **不碰 process、不打印。** 要不要提示、说什么话，由 cli.js 决定；fs 和执行外部命令
 *      都能从外面塞进来，所以每种形状都能在测试里逐个对，不用真往盘上摆文件。
 */

const fs = require("fs");
const path = require("path");

/** 往工作目录里搬的上限。再大的东西 agent 也读不动，与其搬完再说不行，不如当场说清楚 */
const MAX_BYTES = 100 * 1048576;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i;
/** 跟网页端同一个判据：这么长的一段就不该躺在输入框里，落成文件让模型按需去读 */
const BIG_TEXT_CHARS = 2000;

/**
 * 一行输入切成词。认两种转义：`\ ` 和引号。
 * 每个词都带着它在原文里的位置——认出来是文件之后，要把这一截从正文里原样抠掉。
 */
function tokenize(line) {
  const s = String(line == null ? "" : line);
  const out = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    const at = i;
    let text = "";
    let quote = "";
    while (i < s.length) {
      const c = s[i];
      if (!quote && /\s/.test(c)) break;
      // 单引号里反斜杠是普通字符（跟 shell 一个规矩），别的地方它转义下一个字
      if (c === "\\" && quote !== "'" && i + 1 < s.length) { text += s[i + 1]; i += 2; continue; }
      if (!quote && (c === "'" || c === '"')) { quote = c; i++; continue; }
      if (quote && c === quote) { quote = ""; i++; continue; }
      text += c; i++;
    }
    out.push({ raw: s.slice(at, i), text, at, end: i });
  }
  return out;
}

/** file:// 链接 → 本地路径。有些终端和应用拖出来的是这个形状 */
function fromFileUrl(s) {
  const t = String(s || "");
  if (!/^file:\/\//i.test(t)) return "";
  let p = t.replace(/^file:\/\/[^/]*/i, "");
  try { p = decodeURIComponent(p); } catch {}
  return p;
}

/** 看着像不像一条路径（还没查盘上有没有） */
function pathLike(text) {
  const t = String(text || "");
  return /^(~$|~\/|\/|\.\.?\/)/.test(t) || /^[A-Za-z]:[\\/]/.test(t);
}

function expandHome(p, home) {
  const t = String(p || "");
  if (t === "~") return String(home || "");
  if (/^~\//.test(t)) return path.join(String(home || ""), t.slice(2));
  return t;
}

/** 把路径写回输入行时要转义，不然带空格的名字一发出去就断成两半 */
function escPath(p) {
  return String(p == null ? "" : p).replace(/([\s"'\\`$()[\]{}|&;<>*?])/g, "\\$1");
}

/**
 * 这一行里哪些词是「带进来的文件」，剩下的才是要问的话。
 *
 * o.exists(绝对路径) 和 o.roots（相对路径按哪几个目录找）都从外面塞进来：
 * 这样二十几种形状能在测试里逐个对，不用真往盘上摆文件。
 */
function parseLine(line, o) {
  const opt = o || {};
  const home = opt.home || "";
  const roots = (opt.roots || []).filter(Boolean);
  const exists = typeof opt.exists === "function" ? opt.exists : () => false;
  const s = String(line == null ? "" : line);

  /** 相对路径挨个根目录试：工作目录在前（@ 补全列的就是它），人的 shell 目录在后 */
  const resolve = (p) => {
    if (!p) return "";
    if (path.isAbsolute(p)) return exists(p) ? p : "";
    for (const r of roots) {
      const full = path.resolve(r, p);
      if (exists(full)) return full;
    }
    return "";
  };

  // 先把整行当一条路径试一次。Finder 的「拷贝路径」粘出来的空格是没转义的，
  // 按词切会切成好几截，只有整行当一条看才认得出来
  const whole = String(s).trim();
  if (whole && !/^@/.test(whole)) {
    const one = expandHome(fromFileUrl(whole) || whole, home);
    if (pathLike(one) || fromFileUrl(whole)) {
      const hit = resolve(one);
      if (hit) return { text: "", files: [{ ref: whole, path: hit }], missing: [] };
    }
  }

  const files = [];
  const missing = [];
  const drop = [];
  const seen = new Set();
  for (const t of tokenize(s)) {
    const isAt = t.text.startsWith("@") && t.text.length > 1;
    const body = isAt ? t.text.slice(1) : t.text;
    const url = fromFileUrl(body);
    const cand = expandHome(url || body, home);
    // @ 是明说「带这个文件」，什么形状都试一下；不带 @ 的词必须自己长得像路径，
    // 否则「周报」这种普通词也会被拿去撞一遍文件名，撞上了就成了莫名其妙的附件
    if (!isAt && !url && !pathLike(cand)) continue;
    const hit = resolve(cand);
    if (hit) {
      if (!seen.has(hit)) { seen.add(hit); files.push({ ref: t.text, path: hit }); }
      drop.push(t);
      continue;
    }
    if (isAt) missing.push(t.text); // 找不到：正文里原样留着，另外吭一声
  }

  let text = s;
  for (const t of drop.slice().sort((a, b) => b.at - a.at)) text = text.slice(0, t.at) + text.slice(t.end);
  text = text.replace(/[ \t]{2,}/g, " ").trim();
  return { text, files, missing };
}

/** 光标停在行尾时，正在打的那个 `@词`。给 @ 补全用 */
function atToken(line) {
  const s = String(line == null ? "" : line);
  const toks = tokenize(s);
  const last = toks[toks.length - 1];
  if (!last || last.end !== s.length) return null; // 后面还跟着空格：这个词打完了
  if (!last.text.startsWith("@")) return null;
  return { at: last.at, prefix: last.text.slice(1) };
}

function isInside(dir, p) {
  const rel = path.relative(dir, p);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

const mb = (n) => `${(n / 1048576).toFixed(n >= 10 * 1048576 ? 0 : 1)}MB`;

/** 落到工作目录里的名字：控制字符和路径分隔符在文件名里没有正当用途，先洗掉 */
function cleanName(name) {
  const base = path.basename(String(name || "")).replace(/[\u0000-\u001f\u007f]/g, "").replace(/[/\\]/g, "_").trim();
  return base && base !== "." && base !== ".." ? base : "文件";
}

/** 重名不覆盖：a.png 已经有了就叫 a-2.png。覆盖掉的那份可能正是上一轮的产出 */
function freeName(dir, name, taken, fsx) {
  const clean = cleanName(name);
  const ext = path.extname(clean);
  const stem = clean.slice(0, clean.length - ext.length) || "文件";
  let out = clean;
  for (let i = 2; taken.has(out) || fsx.existsSync(path.join(dir, out)); i++) out = `${stem}-${i}${ext}`;
  return out;
}

/** 时间戳名字，跟网页端一个格式（粘贴图_0913_142530.png） */
function stampName(prefix, ext, now) {
  const d = now instanceof Date ? now : new Date();
  const p2 = (x) => String(x).padStart(2, "0");
  return `${prefix}_${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.${ext}`;
}

/**
 * 把认出来的文件放进工作目录，返回给模型用的名字。
 * 本来就在工作目录里的不动：再复制一份出来，人在文件面板里会看到同一个文件出现两遍。
 */
function collect(files, o) {
  const opt = o || {};
  const dir = opt.workspaceDir || ".";
  const fsx = opt.fs || fs;
  const taken = new Set(opt.taken || []);
  const out = { names: [], copied: [], skipped: [] };
  // 同一个源文件给两遍只搬一次：剪贴板里、-f 写重复了都可能来两条一模一样的，
  // 不挡的话工作目录里会冒出 a.png 和 a-2.png 两份一样的东西
  const done = new Map();
  for (const f of files || []) {
    if (done.has(f.path)) {
      const had = done.get(f.path);
      if (!out.names.includes(had)) out.names.push(had);
      continue;
    }
    let st = null;
    try { st = fsx.statSync(f.path); } catch { out.skipped.push({ ref: f.ref, why: "找不到了（刚才还在）" }); continue; }
    if (st.isDirectory()) { out.skipped.push({ ref: f.ref, why: "是个目录不是文件，先打包成 zip 再带进来" }); continue; }
    if (st.size > MAX_BYTES) { out.skipped.push({ ref: f.ref, why: `${mb(st.size)}，超过 ${mb(MAX_BYTES)} 就不往工作目录里搬了` }); continue; }
    if (isInside(dir, f.path)) {
      const rel = path.relative(dir, f.path);
      if (!out.names.includes(rel)) out.names.push(rel);
      taken.add(rel);
      done.set(f.path, rel);
      continue;
    }
    const name = freeName(dir, path.basename(f.path), taken, fsx);
    try { fsx.copyFileSync(f.path, path.join(dir, name)); }
    catch (e) { out.skipped.push({ ref: f.ref, why: `搬不进工作目录：${e.message}` }); continue; }
    taken.add(name);
    done.set(f.path, name);
    out.names.push(name);
    out.copied.push(name);
  }
  return out;
}

/** 挂给模型看的那句标记。格式跟网页端一模一样，agent.js 的规范 3.1 认的就是它 */
function note(names) {
  const list = (names || []).filter(Boolean);
  return list.length ? `（已上传文件：${list.join("、")}）` : "";
}
function withNote(text, names) {
  const t = String(text || "").trim();
  const n = note(names);
  return t && n ? `${t}\n${n}` : t || n;
}
const anyImage = (names) => (names || []).some((n) => IMAGE_EXT.test(String(n)));

/**
 * 剪贴板里可能躺着三样东西，按这个顺序试：**复制的文件 > 截图位图 > 大段文字**。
 *
 * 顺序是有讲究的：在 Finder 里 Cmd+C 一个图片文件，剪贴板里同时有「文件引用」和
 * 「这张图的位图」。先认文件的话带进来的是原图（原分辨率、原格式、原文件名）；
 * 先认位图就变成一张重新编码的 PNG，名字还是个时间戳——同一个动作，结果差很远。
 *
 * 返回的是一张命令表，不是执行结果：这样「哪个系统用什么命令、按什么顺序试」
 * 能在测试里直接对，不用真去动一台机器的剪贴板。
 */
function clipboardPlan(platform, dest) {
  const to = String(dest || "");
  if (platform === "darwin") {
    return [
      // 两处都不能省：
      //   1) 先问剪贴板里到底有没有「文件」这个口味。不问的话，剪贴板里是**文字**时
      //      `as «class furl»` 会把那段文字硬掰成一个文件路径（实测掰出过 "Macintosh HD:or"）。
      //   2) 只复制了一个文件时拿回来的是**单个**文件引用，不是列表；直接 repeat 会去问它 count，
      //      当场 -1708 报错——而「在访达里 Cmd+C 一张截图」正是最常走的那条路。
      { kind: "files", cmd: "osascript", args: ["-e", "set out to \"\"\nif (count of (clipboard info for «class furl»)) > 0 then\n  set cb to (the clipboard as «class furl»)\n  if class of cb is not list then set cb to {cb}\n  repeat with f in cb\n    set out to out & POSIX path of f & linefeed\n  end repeat\nend if\nreturn out"] },
      // 位图这条自己写文件：AppleScript 里 write 的是二进制，从 stdout 捞回来会被当文本糟蹋掉
      { kind: "image", writesFile: true, cmd: "osascript", args: ["-e", `set f to open for access POSIX file ${JSON.stringify(to)} with write permission\nwrite (the clipboard as «class PNGf») to f\nclose access f`] },
      { kind: "text", cmd: "pbpaste", args: [] },
    ];
  }
  if (platform === "win32") {
    const ps = (script) => ({ cmd: "powershell", args: ["-NoProfile", "-Command", script] });
    return [
      Object.assign({ kind: "files" }, ps("Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }")),
      Object.assign({ kind: "image", writesFile: true }, ps(`$i = Get-Clipboard -Format Image; if ($i) { $i.Save(${JSON.stringify(to)}) } else { exit 1 }`)),
      Object.assign({ kind: "text" }, ps("Get-Clipboard -Raw")),
    ];
  }
  if (platform === "linux") {
    // Wayland 一套、X11 一套，装了哪个用哪个——两个都试，谁先成算谁的
    return [
      { kind: "files", cmd: "wl-paste", args: ["--type", "text/uri-list"] },
      { kind: "files", cmd: "xclip", args: ["-selection", "clipboard", "-t", "text/uri-list", "-o"] },
      { kind: "image", cmd: "wl-paste", args: ["--type", "image/png"] },
      { kind: "image", cmd: "xclip", args: ["-selection", "clipboard", "-t", "image/png", "-o"] },
      { kind: "text", cmd: "wl-paste", args: ["--no-newline"] },
      { kind: "text", cmd: "xclip", args: ["-selection", "clipboard", "-o"] },
    ];
  }
  return [];
}

/**
 * 真去读一次剪贴板。run / fs 都能从外面塞进来，所以「三样东西按顺序试、谁先中算谁的」
 * 这套时序在测试里能逐帧推，不用真去动机器的剪贴板。
 *
 * 返回 { kind: "files"|"image"|"text"|"empty"|"unsupported", ... }
 */
function readClipboard(o) {
  const opt = o || {};
  const platform = opt.platform || process.platform;
  const dest = opt.dest || "";
  const fsx = opt.fs || fs;
  const run = opt.run || ((cmd, args) => require("child_process").spawnSync(cmd, args, { maxBuffer: 256 * 1048576 }));
  const plan = clipboardPlan(platform, dest);
  if (!plan.length) return { kind: "unsupported", why: `${platform} 上没有能读剪贴板的现成命令` };

  const tried = [];
  for (const step of plan) {
    let r = null;
    try { r = run(step.cmd, step.args, step); } catch (e) { tried.push(`${step.cmd}: ${e.message}`); continue; }
    if (!r || r.error) { tried.push(`${step.cmd}: ${(r && r.error && r.error.message) || "起不来"}`); continue; }
    if (r.status !== 0) {
      // 这一步没中很正常（剪贴板里就没这样东西），清掉它可能已经建出来的空文件
      if (step.writesFile && dest) { try { fsx.unlinkSync(dest); } catch {} }
      continue;
    }
    if (step.kind === "files") {
      const list = String(r.stdout || "").split(/\r?\n/)
        .map((x) => (fromFileUrl(x.trim()) || x.trim()))
        .filter((x) => x && fsx.existsSync(x));
      if (list.length) return { kind: "files", paths: list };
      continue;
    }
    if (step.kind === "image") {
      if (step.writesFile) {
        let st = null;
        try { st = fsx.statSync(dest); } catch {}
        if (st && st.size > 0) return { kind: "image", file: dest };
        if (dest) { try { fsx.unlinkSync(dest); } catch {} }
        continue;
      }
      const buf = r.stdout;
      if (buf && buf.length) {
        try { fsx.writeFileSync(dest, buf); return { kind: "image", file: dest }; }
        catch (e) { tried.push(`写不进 ${dest}：${e.message}`); }
      }
      continue;
    }
    const text = String(r.stdout || "");
    if (text.trim()) return { kind: "text", text };
  }
  return { kind: "empty", tried };
}

module.exports = {
  MAX_BYTES, BIG_TEXT_CHARS, IMAGE_EXT,
  tokenize, fromFileUrl, pathLike, expandHome, escPath,
  parseLine, atToken, collect, note, withNote, anyImage,
  cleanName, freeName, stampName, isInside,
  clipboardPlan, readClipboard,
};
