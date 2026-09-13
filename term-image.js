"use strict";
/**
 * 终端里怎么把产出的图给人看见。
 *
 * 用户原话：「cli模式下我没办法看到svg啊」。之前一轮跑完只打一行灰字
 * 「▪ 工作目录 /xxx：架构图.svg、封面.png」——名字有了，人却看不到东西长什么样，
 * 得自己开一个访达翻过去双击。网页端右边有预览面板，终端这边是零。
 *
 * 补两条路，可靠的那条在前：
 *
 *   1. **`/open`**：交给系统默认程序打开（macOS `open` / Linux `xdg-open` / Windows
 *      `cmd /c start`）。任何终端、任何格式都成立，SVG 会在浏览器或预览里正常显示。
 *      这是「看不到」这件事的正经答案，不依赖终端有什么本事。
 *   2. **直接画在终端里**：终端支持图形协议时，跑完顺手把图贴出来，不用再敲命令。
 *      这条是锦上添花，**必须宁可不画也不能画错**——协议不支持时那串转义序列会变成
 *      满屏 base64 乱码，比没有还糟。所以只认白名单里确认支持的终端，其余一律不发。
 *
 * 两种协议：
 *   - **kitty 图形协议**（kitty / Ghostty）：`ESC _ G <k=v,…> ; <base64> ESC \`，
 *     载荷要切成 4096 字节一块，除最后一块外都带 m=1。
 *   - **iTerm2 内联图协议**（iTerm2 / WezTerm / mintty / 开了开关的 VS Code）：
 *     `ESC ] 1337 ; File=<k=v;…> : <base64> BEL`，一整条发完，不用切块。
 *
 * VS Code 单独说一句：它用的是 iTerm2 那套，但要用户自己在设置里打开
 * `terminal.integrated.enableImages`。开没开这边探不到，所以默认不发，只给一行提示告诉
 * 他开哪个开关——发了而没开，得到的是一屏乱码。想强行开/关用环境变量
 * `OPENWORKBUDDY_TERM_IMAGES=1|0`。
 *
 * tmux / screen 里一律不画：转义序列要额外套一层 passthrough，还得用户在 tmux 配置里
 * 打开 `allow-passthrough`，条件不满足就是乱码。
 *
 * 这个文件不碰 process、不打印、不读盘（除了显式传进来的 fs）。要不要画、画几张、
 * 说什么话，由 cli.js 决定。
 */

/** 能画出来的：位图直接画；SVG 要先栅格化（diagram.svgToPngAnyhow），拿不到就只能 /open */
const DRAWABLE_EXT = /\.(png|jpe?g|webp|gif|bmp|svg)$/i;
/** kitty 协议规定单块 base64 载荷不超过 4096 字节 */
const KITTY_CHUNK = 4096;

/**
 * 这个终端能不能直接出图。
 * @param {Record<string,string|undefined>} env 一般就是 process.env
 * @param {boolean} isTTY 输出是不是终端（重定向到文件时一定不画）
 * @returns {{proto: "kitty"|"iterm"|null, term: string, hint: string|null}}
 *   proto 为 null 就别画；hint 是给用户看的一句人话，说清楚为什么没画、怎么才能画。
 */
function detect(env = {}, isTTY = true) {
  const force = String(env.OPENWORKBUDDY_TERM_IMAGES || "").toLowerCase();
  if (force === "0" || force === "off" || force === "false" || force === "no") {
    return { proto: null, term: "", hint: null }; // 明说不要，就别再啰嗦
  }
  if (!isTTY) return { proto: null, term: "", hint: null }; // 管道/重定向，画了就是往文件里灌乱码

  const prog = String(env.TERM_PROGRAM || "");
  const term = String(env.TERM || "");
  const named = prog || (term ? term : "终端");

  if (force === "kitty") return { proto: "kitty", term: named, hint: null };
  const on = force === "iterm" || force === "1" || force === "on" || force === "true" || force === "yes";

  // 先按终端认协议，再决定发不发。分开写是因为「强行打开」时也得用对协议——
  // 在 kitty 里硬发 iTerm2 那套，照样是一屏乱码
  let proto = null, name = named, hint = null;
  if (term === "xterm-kitty" || env.KITTY_WINDOW_ID) { proto = "kitty"; name = "kitty"; }
  else if (prog === "ghostty") { proto = "kitty"; name = "Ghostty"; }
  else if (prog === "iTerm.app") { proto = "iterm"; name = "iTerm2"; }
  else if (prog === "WezTerm") { proto = "iterm"; name = "WezTerm"; }
  else if (prog === "mintty") { proto = "iterm"; name = "mintty"; }
  else if (prog === "vscode") {
    // VS Code 走的是 iTerm2 那套，但要用户自己在设置里打开，开关状态这边探不到。
    // 没开就发 = 一屏 base64 乱码，所以默认不发，只说清楚开哪个开关
    name = "VS Code";
    hint = "VS Code 要在设置里打开 terminal.integrated.enableImages 才能直接出图（开完再设 OPENWORKBUDDY_TERM_IMAGES=1）";
    if (on) proto = "iterm";
  } else if (on) {
    proto = "iterm"; // 认不出来但用户坚持要：iTerm2 那套铺得最广
  }

  // tmux / screen：转义序列要额外套一层 passthrough，还得用户自己在 tmux 配置里
  // 打开 allow-passthrough。探不到配没配，所以不赌——除非用户明说要
  if (!on && (env.TMUX || /^screen|^tmux/.test(term))) {
    return { proto: null, term: name, hint: "tmux 里画不了图（转义序列过不去）；/open 一样能看" };
  }

  return { proto, term: name, hint: proto ? null : hint };
}

/**
 * 把 PNG 字节码成终端能显示的转义序列。
 * @param {"kitty"|"iterm"} proto
 * @param {Buffer} png
 * @param {{name?: string, cols?: number}} [opts] cols = 占几个字符宽，高度按原比例自己算
 */
function encode(proto, png, opts = {}) {
  const b64 = Buffer.from(png).toString("base64");
  const cols = Math.max(1, Math.round(opts.cols || 40));
  if (proto === "kitty") {
    // f=100 载荷是 PNG，a=T 传完就显示，c=列数（只给一边，另一边按原比例推）
    let out = "";
    for (let i = 0; i < b64.length; i += KITTY_CHUNK) {
      const chunk = b64.slice(i, i + KITTY_CHUNK);
      const more = i + KITTY_CHUNK < b64.length ? 1 : 0;
      const head = i === 0 ? `f=100,a=T,c=${cols},m=${more}` : `m=${more}`;
      out += `\x1b_G${head};${chunk}\x1b\\`;
    }
    return out + "\n";
  }
  // iTerm2：一整条，name 是 base64 的文件名，inline=1 才是「画出来」而不是「当附件」
  const name = Buffer.from(String(opts.name || "image.png")).toString("base64");
  const args = `name=${name};size=${png.length};inline=1;width=${cols};preserveAspectRatio=1`;
  return `\x1b]1337;File=${args}:${b64}\x07\n`;
}

/**
 * 从一轮产出里挑出「值得贴出来看一眼」的图。
 * @param {Array<{name: string}|string>} files
 * @param {number} [max] 最多几张——一次跑出二十张卡片，全贴出来等于把对话冲掉
 */
function pickDrawable(files, max = 3) {
  const names = (files || []).map((f) => (typeof f === "string" ? f : (f && f.name) || "")).filter(Boolean);
  const hit = names.filter((n) => DRAWABLE_EXT.test(n));
  // 取最后几张：一轮里先画草图后画成品，人要看的是成品
  return hit.slice(-Math.max(0, max));
}

/**
 * 用系统默认程序打开一个文件/目录时该执行什么命令。
 * @param {string} platform process.platform
 * @param {string} target 绝对路径
 * @returns {{cmd: string, args: string[]}}
 */
function openerFor(platform, target) {
  if (platform === "darwin") return { cmd: "open", args: [target] };
  if (platform === "win32") {
    // start 是 cmd 的内建命令，不能直接 spawn；第一个引号参数是窗口标题，必须留着占位，
    // 否则路径带空格时会被 start 当成标题、什么都不打开
    return { cmd: "cmd", args: ["/c", "start", "", target] };
  }
  return { cmd: "xdg-open", args: [target] };
}

/**
 * `/open 后面那半句` 到底指哪个文件。
 *
 * 人会用四种方式指：屏幕上那行清单的序号、完整文件名、大小写打岔的文件名、只打半截。
 * 猜错比不猜更烦（用系统程序打开一个不相干的文件，人还得回去关窗口），所以半截名只在
 * **唯一命中**时才算数，对上两个就把候选摆出来让人自己说全。
 *
 * @param {string} arg /open 后面那段，空 = 打开工作目录本身
 * @param {string[]} names 工作目录里现有的文件名
 * @param {string[]} recent 刚才那行产出清单——序号数的是它，不是目录列表：
 *   屏幕上写着什么，序号就得对上什么，另读一遍目录顺序对不上
 * @returns {{kind:"dir"}|{kind:"file",name:string}|{kind:"ambiguous",candidates:string[]}
 *   |{kind:"outofrange",count:number}|{kind:"missing"}}
 */
function resolveTarget(arg, names, recent) {
  const q = String(arg == null ? "" : arg).trim();
  if (!q) return { kind: "dir" };
  const list = names || [], seen = recent || [];
  const lower = q.toLowerCase();
  const numeric = /^\d+$/.test(q);
  if (numeric) {
    const i = Number(q);
    if (i >= 1 && i <= seen.length) return { kind: "file", name: seen[i - 1] };
  }
  const exact = list.find((f) => f === q) || list.find((f) => String(f).toLowerCase() === lower);
  if (exact) return { kind: "file", name: exact };
  const like = list.filter((f) => String(f).toLowerCase().includes(lower));
  if (like.length === 1) return { kind: "file", name: like[0] };
  if (like.length > 1) return { kind: "ambiguous", candidates: like };
  // 打的是个数字又对不上清单：说「没有这个文件」会让人以为打错了名字，
  // 其实是清单没那么长
  if (numeric) return { kind: "outofrange", count: seen.length };
  return { kind: "missing" };
}

module.exports = { detect, encode, pickDrawable, openerFor, resolveTarget, DRAWABLE_EXT, KITTY_CHUNK };
