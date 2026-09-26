"use strict";
/**
 * 飞书发附件（im-feishu-media.js）：视频能在聊天里直接播，超限的先发预览，发送超时绝不重发。
 *
 * 钉这几件事：
 *   1. mp4 ≤28MB：先传封面（images），再按 file_type=mp4 传、msg_type=media 发，带 image_key 和时长
 *   2. mp4 >28MB：本机压一份短边 720 的预览发过去，发成了再补一句「原片在工作台：相对路径」
 *   3. 发送超时/断网：只发过一次，不补发、不改按文件再发——飞书可能已经收到了
 *   4. 发送被飞书明确拒（code≠0）：只改按文件再发一次；不在群里、频控、token 失效这类跟类型无关的不兜
 *   5. 本机没 ffmpeg：≤28MB 的按普通文件发并说一句为什么；超限的直接说压不了，一个请求都不发
 *   6. 临时文件放系统 tmp、用完就删；发进聊天的话里没有绝对路径
 *   7. 手机竖拍（存成横的 + 转 90°）按转过之后的宽高抽封面、压预览，不压扁
 *   8. 卡头「已花 ¥…」：只数这一趟、整趟那条 usage 到了才出；有项没价写「单价未知」不写 ¥0；CLI 引擎跑的不出
 *   9. 企业微信 / 公众号 / iLink / 飞书的附件和报错进聊天前都走 im-media 的同一个抹路径
 * 假飞书是 global.fetch 上的路由，没见过的地址直接抛；ffmpeg/ffprobe 走注入的假 bins。
 * 最后一段用本机真 ffmpeg（没有就跳过，OWB_REQUIRE_FFMPEG=1 时没有算红）。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "owb-feishu-media-"));
process.env.OPENWORKBUDDY_HOME = path.join(TMP, "home");
const M = require(path.join(ROOT, "im-feishu-media"));

let n = 0;
const bad = [];
const ok = (name, cond, extra) => {
  if (cond) n++;
  else { bad.push(name); console.log(`  ✗ ${name}${extra !== undefined ? "\n      " + String(extra).slice(0, 400) : ""}`); }
};

const API = "https://open.feishu.cn/open-apis";
const MB = 2 ** 20;
const WS = path.join(TMP, "ws");
const TMPROOT = path.join(TMP, "tmproot"); // 发送器自己的临时目录都建在这下面，好数有没有删干净
fs.mkdirSync(path.join(WS, "out"), { recursive: true });
fs.mkdirSync(TMPROOT, { recursive: true });

/** 造一个指定大小的文件（稀疏，不真占盘） */
function sized(rel, bytes) {
  const abs = path.join(WS, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, "");
  fs.truncateSync(abs, bytes);
  return rel;
}
const leftovers = () => fs.readdirSync(TMPROOT).filter((d) => d.startsWith("owb-feishu-"));

// ───────── 假飞书：global.fetch 路由 ─────────
function fakeFeishu(script = {}) {
  const calls = [];
  const real = global.fetch;
  let fileN = 0, imgN = 0, msgN = 0;
  const json = (o) => ({ ok: true, status: 200, json: async () => o });
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    let fields = null;
    if (init.body instanceof FormData) {
      fields = {};
      for (const [k, v] of init.body.entries()) {
        if (typeof v === "string") fields[k] = v;
        else fields[k] = { name: v.name, size: v.size, head: Buffer.from(await v.slice(0, 3).arrayBuffer()).toString("hex") };
      }
    }
    if (u === `${API}/im/v1/files`) {
      fileN++;
      calls.push({ kind: "file", fields });
      return json({ code: 0, data: { file_key: `file_v2_t${fileN}` } });
    }
    if (u === `${API}/im/v1/images`) {
      imgN++;
      calls.push({ kind: "image", fields });
      if (script.imageCode === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      if (script.imageCode) return json({ code: script.imageCode, msg: "bad image" });
      return json({ code: 0, data: { image_key: `img_v2_t${imgN}` } });
    }
    if (u === `${API}/im/v1/messages?receive_id_type=chat_id`) {
      msgN++;
      const b = JSON.parse(init.body);
      calls.push({ kind: "msg", receive_id: b.receive_id, msg_type: b.msg_type, content: JSON.parse(b.content), rawContent: b.content });
      const act = (script.msg || [])[msgN - 1];
      if (act === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      if (typeof act === "number") return json({ code: act, msg: "rejected" });
      return json({ code: 0, data: { message_id: `om_${msgN}` } });
    }
    throw new Error(`假飞书：没见过的地址 ${u}`);
  };
  return {
    calls,
    files: () => calls.filter((c) => c.kind === "file"),
    images: () => calls.filter((c) => c.kind === "image"),
    msgs: () => calls.filter((c) => c.kind === "msg"),
    restore() { global.fetch = real; },
  };
}

// 照 im.js 的 feishuSend 写：真路径上它就是 postMessage
async function feishuSend(token, chatId, msgType, content) {
  const resp = await fetch(`${API}/im/v1/messages?receive_id_type=chat_id`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ receive_id: chatId, msg_type: msgType, content: JSON.stringify(content) }),
    signal: AbortSignal.timeout(15000),
  });
  return resp.json();
}

const PROBE_1080 = (dur, audio = true) => JSON.stringify({
  streams: [{ codec_type: "video", codec_name: "h264", width: 1920, height: 1080 }, ...(audio ? [{ codec_type: "audio", codec_name: "aac" }] : [])],
  format: { duration: String(dur) },
});

// ───────── 假 ffmpeg / ffprobe ─────────
function fakeBins({ ff = true, fp = true, probe = PROBE_1080(30), previewSizes = [15 * MB], coverFail = false, encodeFail = null, delayMs = 0 } = {}) {
  const runs = [];
  const sizes = [...previewSizes];
  let active = 0, maxActive = 0;
  return {
    runs,
    maxActive: () => maxActive,
    covers: () => runs.filter((r) => r.argv.includes("-frames:v")),
    encodes: () => runs.filter((r) => r.argv.includes("libx264")),
    resolve: async (name) => (name === "ffmpeg" ? (ff ? "/fake/bin/ffmpeg" : "") : (fp ? "/fake/bin/ffprobe" : "")),
    install: async () => "brew install ffmpeg",
    run: async (bin, argv, o) => {
      runs.push({ bin, argv, timeoutMs: o.timeoutMs, signal: o.signal });
      if (bin.endsWith("ffprobe")) return { stdout: probe };
      const out = argv[argv.length - 1];
      if (argv.includes("-frames:v")) {
        if (coverFail) throw new Error("ffmpeg 出错了（退出码 1）");
        fs.writeFileSync(out, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
        return { stdout: "" };
      }
      active++; maxActive = Math.max(maxActive, active);
      try {
        // 跟 runBin 一样：拿到 signal 的，叫停就把「ffmpeg」杀掉
        if (delayMs) await new Promise((r, j) => {
          const t = setTimeout(r, delayMs);
          if (o.signal) o.signal.addEventListener("abort", () => { clearTimeout(t); j(Object.assign(new Error("已停止"), { name: "AbortError" })); }, { once: true });
        });
        if (encodeFail) throw new Error(encodeFail);
        fs.writeFileSync(out, "");
        fs.truncateSync(out, sizes.length > 1 ? sizes.shift() : sizes[0]);
        return { stdout: "" };
      } finally { active--; }
    },
  };
}

function sender(bins, extra = {}) {
  const notes = [];
  const logs = [];
  const s = M.createFeishuMediaSender({
    getToken: async () => "t-fake",
    postMessage: feishuSend,
    notify: async (chatId, text) => { notes.push({ chatId, text }); },
    log: (lvl, msg) => logs.push({ lvl, msg }),
    workspaceDir: () => WS,
    tmpRoot: TMPROOT,
    bins,
    ...extra,
  });
  return { s, notes, logs };
}

async function rejects(p) {
  try { await p; return null; } catch (e) { return e; }
}

(async () => {
  // ════ 纯函数 ════
  {
    const P = (name, size, probe) => M.planSend({ name, size, probe });
    ok("mp4 ≤28MB → media（file_type mp4 / msg media）", JSON.stringify(P("a.mp4", 12 * MB)) === JSON.stringify({ route: "media", fileType: "mp4", msgType: "media" }));
    ok("mp4 >28MB → media-preview", P("a.MP4", 40 * MB).route === "media-preview");
    ok("opus → audio（file_type opus / msg audio）", P("v.opus", 1000).msgType === "audio" && P("v.opus", 1000).fileType === "opus");
    ok("2MB png → image", P("x.png", 2 * MB).route === "image");
    ok("12MB png → 普通文件 stream（images 接口上限 10MB）", P("x.png", 12 * MB).route === "file" && P("x.png", 12 * MB).fileType === "stream");
    ok("docx → doc / xlsx → xls / pptx → ppt / pdf → pdf",
      P("a.docx", 9).fileType === "doc" && P("a.xlsx", 9).fileType === "xls" && P("a.pptx", 9).fileType === "ppt" && P("a.pdf", 9).fileType === "pdf");
    ok("mov / webm / mp3 → stream 普通文件", ["a.mov", "a.webm", "a.mp3"].every((f) => P(f, 9).route === "file" && P(f, 9).fileType === "stream"));
    let e = null; try { P("big.pdf", 29 * MB); } catch (x) { e = x; }
    ok("非 mp4 超 28MB 直接抛中文", e && /30MB/.test(e.message));
    e = null; try { P("big.png", 29 * MB); } catch (x) { e = x; }
    ok("超 28MB 的图片也抛（不是 file 能发的）", e && /30MB/.test(e.message));
    e = null; try { P("big.mp4", 40 * MB, { dur: 30, w: 0, h: 0, vcodec: "", hasAudio: true }); } catch (x) { e = x; }
    ok("超限 mp4 里没画面：说压不了预览", e && /没有画面/.test(e.message));

    const d = (w, h) => JSON.stringify(M.previewDims(w, h));
    ok("横屏 1920×1080 → 1280×720", d(1920, 1080) === JSON.stringify({ w: 1280, h: 720 }));
    ok("竖屏 1080×1920 → 720×1280", d(1080, 1920) === JSON.stringify({ w: 720, h: 1280 }));
    ok("640×360 不放大", d(640, 360) === JSON.stringify({ w: 640, h: 360 }));
    const odd = M.previewDims(1921, 1081), odd2 = M.previewDims(641, 361);
    ok("奇数边压完是偶数", odd.w % 2 === 0 && odd.h % 2 === 0 && odd.h === 720, JSON.stringify(odd));
    ok("奇数边不压也修成偶数（且不超原尺寸）", odd2.w === 640 && odd2.h === 360, JSON.stringify(odd2));
    const sq = M.previewDims(2000, 2000);
    ok("方形 2000×2000 → 720×720", sq.w === 720 && sq.h === 720);

    const b120 = M.previewBitrate(120);
    ok("120 秒：码率够（≥350k）", b120.ok && b120.vKbps >= 350 && b120.vKbps < 1400, JSON.stringify(b120));
    ok("码率按 19.5MB 预算算、留 7% 开销：120 秒 ≈ 1171k", Math.abs(b120.vKbps - 1171) <= 2, b120.vKbps);
    ok("3 小时：码率不够 → 不发预览", !M.previewBitrate(3 * 3600).ok);
    ok("时长 0 / NaN：不 ok", !M.previewBitrate(0).ok && !M.previewBitrate(NaN).ok);

    const cv = M.coverArgv({ src: "/s.mp4", out: "/c.jpg", dur: 30, w: 1920, h: 1080 });
    ok("封面：只取 1 帧、第 3 秒、长边 1280、输出在最后", cv.includes("-frames:v") && cv[cv.indexOf("-frames:v") + 1] === "1"
      && cv[cv.indexOf("-ss") + 1] === "3" && cv.includes("scale=1280:720") && cv[cv.length - 1] === "/c.jpg", cv.join(" "));
    ok("封面：-ss 在 -i 前（快速定位）", cv.indexOf("-ss") < cv.indexOf("-i"));
    const cv2 = M.coverArgv({ src: "/s.mp4", out: "/c.jpg", dur: 5, w: 0, h: 0 });
    ok("封面：短视频取 10% 处，尺寸不明不缩放", cv2[cv2.indexOf("-ss") + 1] === "0.5" && !cv2.includes("-vf"), cv2.join(" "));

    const pv = M.previewArgv({ src: "/s.mp4", out: "/p.mp4", dims: { w: 1280, h: 720 }, vKbps: 1000, hasAudio: true });
    const j = pv.join(" ");
    ok("预览：scale=1280:720 + libx264 veryfast yuv420p", j.includes("scale=1280:720") && j.includes("-c:v libx264 -preset veryfast -pix_fmt yuv420p"), j);
    ok("预览：-b:v 1000k -maxrate 1200k -bufsize 2000k（不用 crf，体积有界）", j.includes("-b:v 1000k -maxrate 1200k -bufsize 2000k") && !j.includes("-crf"), j);
    ok("预览：aac 96k 双声道 + faststart", j.includes("-c:a aac -b:a 96k -ac 2") && j.includes("-movflags +faststart") && pv[pv.length - 1] === "/p.mp4", j);

    const pr = M.parseProbe(PROBE_1080(30, false));
    ok("parseProbe：没音轨 → hasAudio=false", pr && pr.hasAudio === false && pr.w === 1920 && pr.h === 1080 && pr.dur === 30 && pr.vcodec === "h264");
    const pv2 = M.previewArgv({ src: "/s", out: "/p.mp4", dims: { w: 1280, h: 720 }, vKbps: 900, hasAudio: pr.hasAudio }).join(" ");
    ok("没音轨 → 预览参数带 -an、不 map 音轨", pv2.includes("-an") && !pv2.includes("0:a") && !pv2.includes("aac"), pv2);
    ok("parseProbe：有音轨 → true", M.parseProbe(PROBE_1080(30)).hasAudio === true);
    ok("parseProbe：乱码 → null", M.parseProbe("not json") === null && M.parseProbe("{}") === null);
    const cover = M.parseProbe(JSON.stringify({ streams: [{ codec_type: "video", codec_name: "mjpeg", width: 300, height: 300 }, { codec_type: "video", codec_name: "hevc", width: 3840, height: 2160 }], format: { duration: "9" } }));
    ok("parseProbe：夹带的封面附图不算画面", cover.vcodec === "hevc" && cover.w === 3840);
    ok("probeArgv：问流序号/codec_type/宽高/朝向/时长，json 输出，文件在最后", M.probeArgv("/x.mp4").join(" ") === "-v error -show_entries stream=index,codec_type,codec_name,width,height:stream_side_data=rotation:stream_tags=rotate:format=duration -of json /x.mp4", M.probeArgv("/x.mp4").join(" "));

    // 手机竖拍：存成 1920×1080 + 转 90°。ffmpeg 解码先转正，量出来要报 1080×1920，不然封面、预览都压扁
    const rotP = (extra) => M.parseProbe(JSON.stringify({ streams: [{ index: 0, codec_type: "video", codec_name: "h264", width: 1920, height: 1080, ...extra }], format: { duration: "10" } }));
    const r90 = rotP({ side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }] });
    ok("parseProbe：显示矩阵转 -90° → 报转过之后的 1080×1920", r90 && r90.w === 1080 && r90.h === 1920, JSON.stringify(r90));
    const r270 = rotP({ tags: { rotate: "270" } });
    ok("parseProbe：老版 tags.rotate=270 也认", r270 && r270.w === 1080 && r270.h === 1920, JSON.stringify(r270));
    const r180 = rotP({ side_data_list: [{ rotation: 180 }] });
    ok("parseProbe：转 180° 横竖不变", r180 && r180.w === 1920 && r180.h === 1080, JSON.stringify(r180));
    ok("转过之后：预览 720×1280、封面 720×1280", JSON.stringify(M.previewDims(r90.w, r90.h)) === JSON.stringify({ w: 720, h: 1280 })
      && M.coverArgv({ src: "/s.mp4", out: "/c.jpg", dur: 10, w: r90.w, h: r90.h }).includes("scale=720:1280"));

    // 附图封面排在真画面前面：预览要取 parseProbe 挑中的那一路，不能 0:v:0
    const withIdx = M.parseProbe(JSON.stringify({ streams: [
      { index: 0, codec_type: "video", codec_name: "mjpeg", width: 600, height: 600 },
      { index: 1, codec_type: "video", codec_name: "h264", width: 1280, height: 720 },
      { index: 2, codec_type: "audio", codec_name: "aac" },
    ], format: { duration: "4" } }));
    ok("parseProbe：记下挑中那一路的流序号（跳过封面 → 1）", withIdx && withIdx.vindex === 1 && withIdx.w === 1280, JSON.stringify(withIdx));
    const pvIdx = M.previewArgv({ src: "/s", out: "/p.mp4", dims: { w: 1280, h: 720 }, vKbps: 900, hasAudio: true, vindex: 1 });
    ok("预览：按流序号取画面（-map 0:1）", pvIdx[pvIdx.indexOf("-map") + 1] === "0:1", pvIdx.join(" "));
    const pvNo = M.previewArgv({ src: "/s", out: "/p.mp4", dims: { w: 1280, h: 720 }, vKbps: 900, hasAudio: true });
    ok("预览：没流序号时取 0:V:0（大写 V 跳过附图），不用 0:v:0", pvNo[pvNo.indexOf("-map") + 1] === "0:V:0" && !pvNo.includes("0:v:0"), pvNo.join(" "));
    ok("parseProbe：没 index 字段就不编一个", !("vindex" in M.parseProbe(PROBE_1080(30))));

    const REL = "out/big.mp4";
    for (const [nm, t] of [["notePreview", M.notePreview(REL, 40)], ["noteTooLong", M.noteTooLong(REL)]]) {
      ok(`${nm}：带相对路径、不含路径时 ≤70 字`, t.includes(REL) && t.replace(REL, "").length <= 70, t);
    }
    ok("noteNoFfmpeg：带装法", M.noteNoFfmpeg("brew install ffmpeg").includes("brew install ffmpeg"));
    ok("noteNoFfmpegFile：≤70 字（不含装法）", M.noteNoFfmpegFile("").length <= 70, M.noteNoFfmpegFile(""));
    ok("LIMITS：28MB / 10,000,000 字节 / 19.5MB / 720", M.LIMITS.FILE_MAX === 28 * MB && M.LIMITS.IMAGE_MAX === 10_000_000 && M.LIMITS.PREVIEW_TARGET === 19.5 * MB && M.LIMITS.SHORT_SIDE === 720);
    ok("10,200,000 字节的 png：按文件发（飞书的 10MB 可能是十进制）", P("x.png", 10_200_000).route === "file" && P("x.png", 10_000_000).route === "image");
  }

  // ════ 1. 12MB mp4：封面 + media ════
  {
    const f = fakeFeishu();
    const bins = fakeBins({ probe: PROBE_1080(30) });
    const { s, notes } = sender(bins);
    try {
      const rel = sized("out/clip.mp4", 12 * MB);
      const r = await s.sendFile("oc_chat", rel);
      const [img] = f.images(), [file] = f.files(), msgs = f.msgs();
      ok("① 先传封面：images 接口 image_type=message", f.calls[0].kind === "image" && img.fields.image_type === "message" && img.fields.image.head === "ffd8ff");
      ok("① 再传视频：file_type=mp4、duration=30000、原文件名、整份大小", file && file.fields.file_type === "mp4" && file.fields.duration === "30000"
        && file.fields.file_name === "clip.mp4" && file.fields.file.size === 12 * MB, JSON.stringify(file && file.fields));
      ok("① 发 msg_type=media，content 带 file_key 和 image_key", msgs.length === 1 && msgs[0].msg_type === "media"
        && msgs[0].content.file_key === "file_v2_t1" && msgs[0].content.image_key === "img_v2_t1" && msgs[0].receive_id === "oc_chat", JSON.stringify(msgs));
      ok("① content 是 JSON 字符串（飞书要求）", typeof msgs[0].rawContent === "string");
      ok("① 封面参数：-frames:v 1、源是原片", bins.covers().length === 1 && bins.covers()[0].argv.includes(path.join(WS, rel)));
      ok("① 没转码、没多嘴", bins.encodes().length === 0 && notes.length === 0);
      ok("① 返回 route=media", r.route === "media" && r.sent === true && r.fellBack === false);
      ok("① 临时目录删干净了", leftovers().length === 0, leftovers());
      ok("① 顺序：images → files → messages", f.calls.map((c) => c.kind).join(",") === "image,file,msg");
    } finally { f.restore(); }
  }

  // ════ 2. 本机没 ffmpeg，12MB mp4：按普通文件发 + 说一句 ════
  {
    const f = fakeFeishu();
    const bins = fakeBins({ ff: false, fp: false });
    const { s, notes } = sender(bins);
    try {
      const rel = sized("out/noff.mp4", 12 * MB);
      const r = await s.sendFile("oc_a", rel);
      const files = f.files(), msgs = f.msgs();
      ok("② 没 ffmpeg：按 stream 传、msg_type=file（不撞 230055）", files.length === 1 && files[0].fields.file_type === "stream" && msgs.length === 1 && msgs[0].msg_type === "file");
      ok("② 没 ffmpeg：不传封面、不带时长", f.images().length === 0 && files[0].fields.duration === undefined);
      ok("② 发成了再说一句为什么 + 装法", notes.length === 1 && /ffmpeg/.test(notes[0].text) && notes[0].text.includes("brew install ffmpeg") && notes[0].chatId === "oc_a");
      ok("② 返回 route=file", r.route === "file" && r.sent === true);
      await s.sendFile("oc_a", rel);
      ok("② 同一会话十分钟内不重复提醒", notes.length === 1 && f.msgs().length === 2);
      await s.sendFile("oc_b", rel);
      ok("② 换个会话照常提醒一次", notes.length === 2 && notes[1].chatId === "oc_b");
      ok("② 一次 ffmpeg 都没跑", bins.runs.length === 0);
      ok("② 没建临时目录", leftovers().length === 0);
    } finally { f.restore(); }
  }

  // ════ 3. 40MB mp4、120 秒：720p 预览 + 原片在哪 ════
  {
    const f = fakeFeishu();
    const bins = fakeBins({ probe: PROBE_1080(120), previewSizes: [15 * MB] });
    const order = [];
    const { s, notes } = sender(bins, {
      notify: async (chatId, text) => { order.push("note:" + f.msgs().length); notes.push({ chatId, text }); },
    });
    try {
      const rel = sized("out/big.mp4", 40 * MB);
      const r = await s.sendFile("oc_chat", rel);
      const enc = bins.encodes();
      const j = enc[0] && enc[0].argv.join(" ");
      ok("③ 压了一次预览：scale=1280:720 + faststart + libx264 + -b:v", enc.length === 1 && j.includes("scale=1280:720") && j.includes("-movflags +faststart") && j.includes("libx264") && j.includes("-b:v"), j);
      ok("③ 预览码率按 120 秒算（≈1171k）", j && j.includes("-b:v 1171k"), j);
      ok("③ 转码超时按时长放宽（≥ 时长×3 秒）", enc[0].timeoutMs >= 360000, enc[0].timeoutMs);
      ok("③ 预览写在系统临时目录、不在工作区", !enc[0].argv[enc[0].argv.length - 1].startsWith(WS) && enc[0].argv[enc[0].argv.length - 1].startsWith(TMPROOT));
      const [file] = f.files();
      ok("③ 传的是预览（15MB）、文件名还是原片名、file_type=mp4、带时长", file && file.fields.file.size === 15 * MB && file.fields.file_name === "big.mp4"
        && file.fields.file_type === "mp4" && file.fields.duration === "120000", JSON.stringify(file && file.fields));
      ok("③ 封面从预览上抽", bins.covers().length === 1 && bins.covers()[0].argv.some((a) => a.startsWith(TMPROOT) && a.endsWith("preview.mp4")));
      ok("③ 按 media 发、带封面", f.msgs().length === 1 && f.msgs()[0].msg_type === "media" && !!f.msgs()[0].content.image_key);
      ok("③ 发成功之后才补一句说明（只一句）", notes.length === 1 && order[0] === "note:1");
      const t = notes[0] && notes[0].text;
      ok("③ 说明里有原片的相对路径和大小", t && t.includes("out/big.mp4") && t.includes("40MB") && t.includes("720p"), t);
      ok("③ 说明里没有绝对路径", t && !t.includes("/Users/") && !t.includes(WS) && !t.includes(TMPROOT) && !t.includes(os.homedir()), t);
      ok("③ 返回 route=media-preview + note", r.route === "media-preview" && r.sent === true && r.note === t);
      ok("③ 临时目录删干净了", leftovers().length === 0, leftovers());
    } finally { f.restore(); }
  }

  // ════ 4. 40MB mp4、没 ffmpeg：说压不了，一个请求都不发 ════
  {
    const f = fakeFeishu();
    const { s, notes } = sender(fakeBins({ ff: false, fp: false }));
    try {
      const rel = sized("out/big2.mp4", 40 * MB);
      const e = await rejects(s.sendFile("oc_chat", rel));
      ok("④ 抛 noteNoFfmpeg（含装法）", e && e.message === M.noteNoFfmpeg("brew install ffmpeg"), e && e.message);
      ok("④ 没上传、没发消息、没另发说明", f.calls.length === 0 && notes.length === 0);
    } finally { f.restore(); }
  }

  // ════ 5. 40MB、3 小时：不转码，只说原片在哪 ════
  {
    const f = fakeFeishu();
    const bins = fakeBins({ probe: PROBE_1080(3 * 3600) });
    const { s, notes } = sender(bins);
    try {
      const r = await s.sendFile("oc_chat", sized("out/long.mp4", 40 * MB));
      ok("⑤ 一次都没转码", bins.encodes().length === 0);
      ok("⑤ 说一句 noteTooLong", notes.length === 1 && notes[0].text === M.noteTooLong("out/long.mp4"));
      ok("⑤ 没往飞书传任何东西", f.calls.length === 0);
      ok("⑤ 返回 sent=false", r.sent === false && r.route === "media-preview");
      ok("⑤ 临时目录删干净了", leftovers().length === 0);
    } finally { f.restore(); }
  }

  // ════ 5b. 太长没发、连那句说明也没发出去：往上抛「为什么没发」，不是网络报错原文 ════
  {
    const f = fakeFeishu();
    const { s, logs } = sender(fakeBins({ probe: PROBE_1080(3 * 3600) }), {
      notify: async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); },
    });
    try {
      const e = await rejects(s.sendFile("oc_chat", sized("out/long2.mp4", 40 * MB)));
      ok("⑤b 说明没发出去：照样抛（文件确实没发），抛的是 noteTooLong 那句", e && e.message === M.noteTooLong("out/long2.mp4"), e && e.message);
      ok("⑤b 说明没发出去记了日志（带原因）", logs.some((l) => l.lvl === "error" && /太长没发/.test(l.msg) && /timeout/i.test(l.msg)), JSON.stringify(logs));
      ok("⑤b 没往飞书传任何东西、临时目录删了", f.calls.length === 0 && leftovers().length === 0);
    } finally { f.restore(); }
  }

  // ════ 6. 第一遍压出 29MB：降码率再压恰好一次 ════
  {
    const f = fakeFeishu();
    const bins = fakeBins({ probe: PROBE_1080(120), previewSizes: [29 * MB, 18 * MB] });
    const { s, notes } = sender(bins);
    try {
      const r = await s.sendFile("oc_chat", sized("out/big3.mp4", 40 * MB));
      const enc = bins.encodes().map((x) => x.argv[x.argv.indexOf("-b:v") + 1]);
      ok("⑥ 恰好压了两遍，第二遍是 0.75 倍码率", enc.length === 2 && enc[0] === "1171k" && enc[1] === `${Math.floor(1171 * 0.75)}k`, enc);
      ok("⑥ 传的是第二遍那份（18MB）", f.files().length === 1 && f.files()[0].fields.file.size === 18 * MB);
      ok("⑥ 发成了 + 一句说明", r.sent && notes.length === 1);
    } finally { f.restore(); }
    const f2 = fakeFeishu();
    const bins2 = fakeBins({ probe: PROBE_1080(120), previewSizes: [29 * MB, 29 * MB, 29 * MB] });
    const x = sender(bins2);
    try {
      const r = await x.s.sendFile("oc_chat", sized("out/big4.mp4", 40 * MB));
      ok("⑥ 两遍都超：不再压第三遍", bins2.encodes().length === 2);
      ok("⑥ 两遍都超：不上传，改说原片在哪", f2.calls.length === 0 && r.sent === false && x.notes.length === 1 && x.notes[0].text.includes("out/big4.mp4"));
      ok("⑥ 临时目录删干净了", leftovers().length === 0);
    } finally { f2.restore(); }
  }

  // ════ 7. 发送超时：只发一次，不改按文件补发 ════
  {
    const f = fakeFeishu({ msg: ["timeout"] });
    const { s, notes } = sender(fakeBins({ probe: PROBE_1080(30) }));
    try {
      const e = await rejects(s.sendFile("oc_chat", sized("out/t.mp4", 12 * MB)));
      ok("⑦ 超时原样往上抛", e && e.name === "TimeoutError", e && e.name);
      ok("⑦ messages 只调了一次", f.msgs().length === 1);
      ok("⑦ 没有 stream 重传、没有 file 兜底", f.files().length === 1 && f.files()[0].fields.file_type === "mp4");
      ok("⑦ 没另发说明", notes.length === 0);
      ok("⑦ 失败也删了临时目录", leftovers().length === 0, leftovers());
    } finally { f.restore(); }
    // 预览路线上超时：同样不补发，也不补「先发了预览」那句（可能根本没发出去）
    const f2 = fakeFeishu({ msg: ["timeout"] });
    const x = sender(fakeBins({ probe: PROBE_1080(120) }));
    try {
      const e = await rejects(x.s.sendFile("oc_chat", sized("out/t2.mp4", 40 * MB)));
      ok("⑦ 预览超时：抛出、只发一次、不补说明", e && f2.msgs().length === 1 && x.notes.length === 0);
      ok("⑦ 预览超时：临时目录也删了", leftovers().length === 0);
    } finally { f2.restore(); }
  }

  // ════ 8. 飞书明确拒（230055）：改按文件发恰好一次 ════
  {
    const f = fakeFeishu({ msg: [230055] });
    const { s, logs } = sender(fakeBins({ probe: PROBE_1080(30) }));
    try {
      const r = await s.sendFile("oc_chat", sized("out/r.mp4", 12 * MB));
      const files = f.files(), msgs = f.msgs();
      ok("⑧ 重传一次 file_type=stream", files.length === 2 && files[0].fields.file_type === "mp4" && files[1].fields.file_type === "stream");
      ok("⑧ 再发一次 msg_type=file，用新的 file_key", msgs.length === 2 && msgs[0].msg_type === "media" && msgs[1].msg_type === "file" && msgs[1].content.file_key === "file_v2_t2");
      ok("⑧ fellBack=true，日志记了被拒的 code", r.fellBack === true && logs.some((l) => /230055/.test(l.msg)));
    } finally { f.restore(); }
    const f2 = fakeFeishu({ msg: [230055, 230002] });
    const x = sender(fakeBins({ probe: PROBE_1080(30) }));
    try {
      const e = await rejects(x.s.sendFile("oc_chat", sized("out/r2.mp4", 12 * MB)));
      ok("⑧ 兜底也被拒：抛出，总共只发两次", e && /230002/.test(e.message) && f2.msgs().length === 2);
    } finally { f2.restore(); }
    const f3 = fakeFeishu({ msg: [230055, "timeout"] });
    const y = sender(fakeBins({ probe: PROBE_1080(30) }));
    try {
      const e = await rejects(y.s.sendFile("oc_chat", sized("out/r3.mp4", 12 * MB)));
      ok("⑧ 兜底那次超时：不再发第三次", e && e.name === "TimeoutError" && f3.msgs().length === 2);
    } finally { f3.restore(); }
  }

  // ════ 8b. 跟类型无关的拒绝（不在群里 / 频控）：换 stream 也一样被拒，不白传一遍 ════
  for (const code of [230002, 99991400]) {
    const f = fakeFeishu({ msg: [code] });
    const { s } = sender(fakeBins({ probe: PROBE_1080(30) }));
    try {
      const e = await rejects(s.sendFile("oc_chat", sized(`out/nt${code}.mp4`, 12 * MB)));
      ok(`⑧b ${code}：原样抛、视频只传一次、只发一次`, e && e.message.includes(String(code)) && f.files().length === 1 && f.msgs().length === 1,
        JSON.stringify(f.calls.map((c) => c.kind)));
    } finally { f.restore(); }
  }
  {
    // 不认识的明确拒绝照旧兜一次：可能是飞书不认这个编码
    const f = fakeFeishu({ msg: [230099] });
    const { s } = sender(fakeBins({ probe: PROBE_1080(30) }));
    try {
      const r = await s.sendFile("oc_chat", sized("out/unk.mp4", 12 * MB));
      ok("⑧b 不认识的 code：照旧改按文件发一次", r.fellBack === true && f.msgs().map((m) => m.msg_type).join(",") === "media,file");
    } finally { f.restore(); }
  }
  // 发送回的不是正数 code（响应体 null、没带 code、负数）：飞书没说「没发」，原样抛，不按文件再传再发
  for (const [i, [label, body]] of /** @type {Array<[string, any]>} */ ([["null", null], ["没带 code", { msg: "?" }], ["code -1", { code: -1, msg: "?" }]]).entries()) {
    const f = fakeFeishu();
    let sends = 0;
    const { s } = sender(fakeBins({ probe: PROBE_1080(30) }), { postMessage: async () => { sends++; return body; } });
    try {
      const e = await rejects(s.sendFile("oc_chat", sized(`out/np${i}.mp4`, 12 * MB)));
      ok(`⑧b 发送回 ${label}：原样抛、视频只传一次（mp4）、只发一次`, !!e && f.files().length === 1 && f.files()[0].fields.file_type === "mp4" && sends === 1,
        JSON.stringify({ e: e && e.message, calls: f.calls.map((c) => c.kind), sends }));
    } finally { f.restore(); }
  }

  // ════ 9. opus → audio ════
  {
    const f = fakeFeishu();
    const probe = JSON.stringify({ streams: [{ codec_type: "audio", codec_name: "opus" }], format: { duration: "5.2" } });
    const { s } = sender(fakeBins({ probe }));
    try {
      const r = await s.sendFile("oc_chat", sized("out/v.opus", 50000));
      ok("⑨ opus：file_type=opus、带时长、msg_type=audio", f.files()[0].fields.file_type === "opus" && f.files()[0].fields.duration === "5200"
        && f.msgs()[0].msg_type === "audio" && JSON.stringify(f.msgs()[0].content) === JSON.stringify({ file_key: "file_v2_t1" }) && r.route === "audio");
      ok("⑨ opus 不抽封面", f.images().length === 0);
    } finally { f.restore(); }
    const f2 = fakeFeishu({ msg: [230055] });
    const x = sender(fakeBins({ probe }));
    try {
      const r = await x.s.sendFile("oc_chat", sized("out/v2.opus", 50000));
      ok("⑨ audio 被明确拒：改按文件发一次", r.fellBack === true && f2.msgs().map((m) => m.msg_type).join(",") === "audio,file");
    } finally { f2.restore(); }
  }

  // ════ 10. 图片：≤10MB 走 images，超 10MB 按文件 ════
  {
    const f = fakeFeishu();
    const { s } = sender(fakeBins());
    try {
      await s.sendFile("oc_chat", sized("out/small.png", 2 * MB));
      ok("⑩ 2MB png：images 接口 image_type=message，msg_type=image", f.images().length === 1 && f.images()[0].fields.image_type === "message"
        && f.msgs()[0].msg_type === "image" && f.msgs()[0].content.image_key === "img_v2_t1");
      await s.sendFile("oc_chat", sized("out/huge.png", 12 * MB));
      ok("⑩ 12MB png：按 stream 普通文件发", f.images().length === 1 && f.files().length === 1 && f.files()[0].fields.file_type === "stream" && f.msgs()[1].msg_type === "file");
      await s.sendFile("oc_chat", sized("out/r.docx", 3000));
      ok("⑩ docx：file_type=doc、msg_type=file", f.files()[1].fields.file_type === "doc" && f.msgs()[2].msg_type === "file");
    } finally { f.restore(); }
  }

  // ════ 10b. 传图被明确拒（超 10MB、分辨率超限 234039）：什么都没发出去，按文件发恰好一次 ════
  {
    const f = fakeFeishu({ imageCode: 234039 });
    const { s, logs } = sender(fakeBins());
    try {
      const r = await s.sendFile("oc_chat", sized("out/tall.png", 1 * MB)).catch((e) => ({ err: e.message }));
      ok("⑩b 传图被拒 234039：改按 stream 普通文件发一次", f.images().length === 1 && f.files().length === 1 && f.files()[0].fields.file_type === "stream"
        && f.msgs().length === 1 && f.msgs()[0].msg_type === "file" && f.msgs()[0].content.file_key === "file_v2_t1", JSON.stringify(f.calls.map((c) => c.kind)));
      ok("⑩b 返回 route=file、fellBack=true，日志记了 code", r.route === "file" && r.sent === true && r.fellBack === true && logs.some((l) => /234039/.test(l.msg)), JSON.stringify(r));
    } finally { f.restore(); }
    const f2 = fakeFeishu({ imageCode: "timeout" });
    const x = sender(fakeBins());
    try {
      const e = await rejects(x.s.sendFile("oc_chat", sized("out/slow.png", 1 * MB)));
      ok("⑩b 传图超时：原样抛、不改按文件发", e && e.name === "TimeoutError" && f2.files().length === 0 && f2.msgs().length === 0, e && e.message);
    } finally { f2.restore(); }
    const f3 = fakeFeishu({ imageCode: 99991663 });
    const y = sender(fakeBins());
    try {
      const e = await rejects(y.s.sendFile("oc_chat", sized("out/tok.png", 1 * MB)));
      ok("⑩b 传图时 token 失效：抛出、不白传一遍文件", e && /99991663/.test(e.message) && f3.files().length === 0 && f3.msgs().length === 0, e && e.message);
    } finally { f3.restore(); }
  }

  // ════ 11. 空文件 / 路径越界：一个请求都不发 ════
  {
    const f = fakeFeishu();
    const bins = fakeBins();
    const { s } = sender(bins);
    try {
      const e = await rejects(s.sendFile("oc_chat", sized("out/empty.mp4", 0)));
      ok("⑪ 0 字节：抛「空文件」、没发任何请求、没跑 ffmpeg", e && /空文件/.test(e.message) && f.calls.length === 0 && bins.runs.length === 0);
      fs.writeFileSync(path.join(TMP, "outside.pdf"), "x");
      const e2 = await rejects(s.sendFile("oc_chat", "../outside.pdf"));
      ok("⑪ 工作目录外的文件不发", e2 && /不在工作目录/.test(e2.message) && f.calls.length === 0);
      const e3 = await rejects(s.sendFile("oc_chat", "out/huge.pdf"));
      ok("⑪ 不存在的文件：抛、没请求", e3 && f.calls.length === 0);
    } finally { f.restore(); }
  }

  // ════ 11b. 读文件出错：报错会原样进聊天，里面不能有绝对路径 ════
  {
    const f = fakeFeishu();
    const bins = fakeBins();
    const { s } = sender(bins);
    const leaky = (/** @type {string} */ m) => m.includes(WS) || m.includes(TMP) || m.includes(os.homedir());
    try {
      const e = await rejects(s.sendFile("oc_chat", "out/gone.mp4"));
      ok("⑪b 文件不见了：说「找不到」、不带绝对路径、没请求、没跑 ffmpeg", e && e.message === "工作目录里找不到这个文件" && !leaky(e.message) && f.calls.length === 0 && bins.runs.length === 0, e && e.message);
      const rel = sized("out/locked.png", 1000);
      fs.chmodSync(path.join(WS, rel), 0o000);
      try {
        const e2 = await rejects(s.sendFile("oc_chat", rel));
        const isRoot = !!(process.getuid && process.getuid() === 0); // root 读得动 000 的文件，这条就不成立
        ok("⑪b 没权限读：说「没权限」、不带绝对路径、没请求", isRoot || (e2 && e2.message === "没权限读这个文件" && !leaky(e2.message) && f.calls.length === 0), e2 && e2.message);
      } finally { fs.chmodSync(path.join(WS, rel), 0o644); }
    } finally { f.restore(); }
  }

  // ════ 12. 封面失败 / 转码失败 ════
  {
    const f = fakeFeishu();
    const { s, logs } = sender(fakeBins({ probe: PROBE_1080(30), coverFail: true }));
    try {
      const r = await s.sendFile("oc_chat", sized("out/nocover.mp4", 12 * MB));
      ok("⑫ 封面没做成：照样按 media 发，只是没有 image_key", r.route === "media" && f.msgs()[0].msg_type === "media" && !("image_key" in f.msgs()[0].content) && f.images().length === 0);
      ok("⑫ 封面失败记了日志", logs.some((l) => l.lvl === "error" && /封面/.test(l.msg)));
      ok("⑫ 临时目录删干净了", leftovers().length === 0);
    } finally { f.restore(); }
    const f2 = fakeFeishu();
    const leak = `ffmpeg 出错了（退出码 1）：${path.join(WS, "out/boom.mp4")}: Invalid data; ${os.homedir()}/x`;
    const x = sender(fakeBins({ probe: PROBE_1080(120), encodeFail: leak }));
    try {
      const e = await rejects(x.s.sendFile("oc_chat", sized("out/boom.mp4", 40 * MB)));
      ok("⑫ 转码失败：抛出、没上传", e && /预览失败/.test(e.message) && f2.calls.length === 0);
      ok("⑫ 转码报错里的绝对路径抹掉了（要进聊天）", e && !e.message.includes(WS) && !e.message.includes(os.homedir()), e && e.message);
      ok("⑫ 转码失败也删了临时目录", leftovers().length === 0);
    } finally { f2.restore(); }
  }

  // ════ 12b. 临时目录删不掉（Windows 上被杀软 / 没退干净的 ffmpeg 占着）：视频已经发出去了，照样算发成 ════
  {
    const realRm = fs.rmSync;
    /** @type {any[]} */
    const tried = [];
    fs.rmSync = /** @type {any} */ (function (/** @type {any} */ p, /** @type {any} */ o) {
      if (String(p).startsWith(path.join(TMPROOT, "owb-feishu-"))) {
        tried.push(o);
        throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${p}'`), { code: "EBUSY", syscall: "rmdir", path: String(p) });
      }
      return realRm.call(fs, p, o);
    });
    const f = fakeFeishu();
    const { s, notes, logs } = sender(fakeBins({ probe: PROBE_1080(120) }));
    try {
      const r1 = await s.sendFile("oc_chat", sized("out/busy1.mp4", 12 * MB)).catch((e) => ({ err: e.message }));
      ok("⑫b 删不掉临时目录：12MB 视频照样算发成（只发一次）", r1.sent === true && r1.route === "media" && f.msgs().length === 1, JSON.stringify(r1));
      const r2 = await s.sendFile("oc_chat", sized("out/busy2.mp4", 40 * MB)).catch((e) => ({ err: e.message }));
      ok("⑫b 删不掉临时目录：预览也照样算发成、说明照发", r2.sent === true && r2.route === "media-preview" && f.msgs().length === 2 && notes.length === 1, JSON.stringify(r2));
      const L = logs.filter((l) => /临时目录没删掉/.test(l.msg));
      ok("⑫b 各记一条日志、不带临时目录的绝对路径", L.length === 2 && L.every((l) => l.lvl === "error" && !l.msg.includes(TMPROOT) && !l.msg.includes(os.homedir())), JSON.stringify(L));
      ok("⑫b 删的时候带了重试（占用多半一会儿就松）", tried.length === 2 && tried.every((o) => o && o.maxRetries >= 1), JSON.stringify(tried));
    } finally {
      fs.rmSync = realRm;
      f.restore();
      for (const d of leftovers()) fs.rmSync(path.join(TMPROOT, d), { recursive: true, force: true });
    }
  }

  // ════ 13. 两个会话同时收尾：一次只压一个 ════
  {
    const f = fakeFeishu();
    const bins = fakeBins({ probe: PROBE_1080(60), previewSizes: [10 * MB], delayMs: 40 });
    const a = sender(bins), b = sender(bins);
    try {
      const [r1, r2] = await Promise.all([
        a.s.sendFile("oc_1", sized("out/p1.mp4", 40 * MB)),
        b.s.sendFile("oc_2", sized("out/p2.mp4", 40 * MB)),
      ]);
      ok("⑬ 两段都发了", r1.sent && r2.sent && f.msgs().length === 2);
      ok("⑬ 同一时刻只有一个 ffmpeg 在压", bins.encodes().length === 2 && bins.maxActive() === 1, bins.maxActive());
    } finally { f.restore(); }
  }

  // ════ 13b. 手机竖拍（存成横的 + 转 90°）、附图封面排在前面 ════
  {
    const PROBE_ROT = (dur) => JSON.stringify({ streams: [
      { index: 0, codec_type: "video", codec_name: "h264", width: 1920, height: 1080, side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }] },
      { index: 1, codec_type: "audio", codec_name: "aac" },
    ], format: { duration: String(dur) } });
    const f = fakeFeishu();
    const bins = fakeBins({ probe: PROBE_ROT(30) });
    const { s } = sender(bins);
    try {
      await s.sendFile("oc_chat", sized("out/phone.mp4", 12 * MB));
      const cv = bins.covers()[0] && bins.covers()[0].argv.join(" ");
      ok("⑬b 竖拍 ≤28MB：封面按竖的缩（scale=720:1280）", !!cv && cv.includes("scale=720:1280"), cv);
    } finally { f.restore(); }
    const f2 = fakeFeishu();
    const bins2 = fakeBins({ probe: PROBE_ROT(120) });
    const x = sender(bins2);
    try {
      await x.s.sendFile("oc_chat", sized("out/phone2.mp4", 40 * MB));
      const enc = bins2.encodes()[0] && bins2.encodes()[0].argv.join(" ");
      ok("⑬b 竖拍 >28MB：预览压成 720×1280，不压扁成横的", !!enc && enc.includes("scale=720:1280") && !enc.includes("scale=1280:720"), enc);
      const pc = bins2.covers()[0] && bins2.covers()[0].argv.join(" ");
      ok("⑬b 竖拍预览的封面也是竖的", !!pc && pc.includes("scale=720:1280"), pc);
    } finally { f2.restore(); }
    const PROBE_COVER_FIRST = JSON.stringify({ streams: [
      { index: 0, codec_type: "video", codec_name: "mjpeg", width: 600, height: 600 },
      { index: 1, codec_type: "video", codec_name: "h264", width: 1920, height: 1080 },
      { index: 2, codec_type: "audio", codec_name: "aac" },
    ], format: { duration: "120" } });
    const f3 = fakeFeishu();
    const bins3 = fakeBins({ probe: PROBE_COVER_FIRST });
    const y = sender(bins3);
    try {
      await y.s.sendFile("oc_chat", sized("out/covr.mp4", 40 * MB));
      const a = bins3.encodes()[0] && bins3.encodes()[0].argv;
      ok("⑬b 附图封面排第 0 路：预览取真画面那一路（-map 0:1）", !!a && a[a.indexOf("-map") + 1] === "0:1" && a.join(" ").includes("scale=1280:720"), a && a.join(" "));
    } finally { f3.restore(); }
    ok("⑬b 临时目录删干净了", leftovers().length === 0, leftovers());
  }

  // ════ 13c. 用户回了「停」：还没发的不发、在压的 ffmpeg 掐掉；已经在路上的消息不拦 ════
  {
    const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
    // 轮到它之前就叫停了：一个请求都不发，ffmpeg 一次不跑
    const f = fakeFeishu();
    const bins = fakeBins({ probe: PROBE_1080(30) });
    const { s } = sender(bins);
    try {
      const ac = new AbortController();
      ac.abort();
      const e = await rejects(s.sendFile("oc_chat", sized("out/st0.mp4", 12 * MB), { signal: ac.signal }));
      ok("⑬c 已叫停：抛 AbortError、没请求、没跑 ffmpeg", e && e.name === "AbortError" && f.calls.length === 0 && bins.runs.length === 0, e && e.message);
    } finally { f.restore(); }

    // 压预览压到一半叫停：ffmpeg 拿到了这个 signal、被掐掉；不传、不发、不补说明
    const f2 = fakeFeishu();
    const bins2 = fakeBins({ probe: PROBE_1080(120), delayMs: 5000 });
    const x = sender(bins2);
    try {
      const ac = new AbortController();
      const p = x.s.sendFile("oc_chat", sized("out/st1.mp4", 40 * MB), { signal: ac.signal });
      const until = Date.now() + 3000;
      while (!bins2.encodes().length && Date.now() < until) await sleep(5);
      ac.abort();
      const t0 = Date.now();
      const e = await rejects(p);
      const enc = bins2.encodes()[0];
      ok("⑬c 压到一半叫停：ffmpeg 拿到的是「停」那个 signal", !!enc && enc.signal === ac.signal);
      ok("⑬c 压到一半叫停：马上抛 AbortError（不等压完）", e && e.name === "AbortError" && Date.now() - t0 < 2000, e && `${e.name} ${e.message}`);
      ok("⑬c 压到一半叫停：没传、没发、没补说明", f2.calls.length === 0 && x.notes.length === 0, JSON.stringify(f2.calls.map((c) => c.kind)));
      ok("⑬c 压到一半叫停：临时目录删了", leftovers().length === 0, leftovers());
    } finally { f2.restore(); }

    // 排在别的会话后面等着压的时候叫停：轮到了也不开压
    const f3 = fakeFeishu();
    const bins3 = fakeBins({ probe: PROBE_1080(60), previewSizes: [10 * MB], delayMs: 300 });
    const a = sender(bins3), b = sender(bins3);
    try {
      const ac = new AbortController();
      const p1 = a.s.sendFile("oc_1", sized("out/q1.mp4", 40 * MB));
      const until = Date.now() + 3000;
      while (!bins3.encodes().length && Date.now() < until) await sleep(5);
      const p2 = b.s.sendFile("oc_2", sized("out/q2.mp4", 40 * MB), { signal: ac.signal });
      while (!bins3.runs.some((r) => r.bin.endsWith("ffprobe") && r.argv.some((v) => v.endsWith("q2.mp4"))) && Date.now() < until) await sleep(5);
      await sleep(30); // 量完就进了压视频的队，排在 q1 后面
      ac.abort();
      const [r1, e2] = await Promise.all([p1, rejects(p2)]);
      ok("⑬c 排队时叫停：前一个照发，这个抛 AbortError", r1.sent === true && e2 && e2.name === "AbortError", e2 && e2.message);
      ok("⑬c 排队时叫停：轮到了也没开压、没发", bins3.encodes().length === 1 && f3.msgs().length === 1 && f3.msgs()[0].receive_id === "oc_1", bins3.encodes().length);
      ok("⑬c 排队时叫停：临时目录删了", leftovers().length === 0, leftovers());
    } finally { f3.restore(); }

    // 消息已经在路上时才叫停：不拦（超时不等于飞书没收到），照实报发成了
    const f4 = fakeFeishu();
    const ac4 = new AbortController();
    const y = sender(fakeBins({ probe: PROBE_1080(30) }), {
      postMessage: async (/** @type {any[]} */ ...args) => { ac4.abort(); return feishuSend(...args); },
    });
    try {
      const r = await y.s.sendFile("oc_chat", sized("out/st4.mp4", 12 * MB), { signal: ac4.signal }).catch((e) => ({ err: `${e.name} ${e.message}` }));
      ok("⑬c 发送途中叫停：消息照发出去、照实报 sent=true、只发一次", r.sent === true && r.route === "media" && f4.msgs().length === 1, JSON.stringify(r));
    } finally { f4.restore(); }

    // Node 18.17 以前没有 AbortSignal.any：带「停」的上传照常发；传到一半叫停，在途的上传马上掐掉
    const anyDesc = Object.getOwnPropertyDescriptor(AbortSignal, "any");
    Reflect.deleteProperty(AbortSignal, "any");
    const f5 = fakeFeishu();
    try {
      /** @type {AbortSignal[]} */
      const upSigs = [];
      const ac5 = new AbortController();
      const z = sender(fakeBins({ probe: PROBE_1080(30) }), {
        fetchImpl: (/** @type {string} */ u, /** @type {any} */ i) => { upSigs.push(i.signal); return fetch(u, i); },
      });
      const r = await z.s.sendFile("oc_chat", sized("out/n18.mp4", 12 * MB), { signal: ac5.signal }).catch((e) => ({ err: `${e.name} ${e.message}` }));
      ac5.abort();
      ok("⑬c 没有 AbortSignal.any：带「停」的封面和视频照常传、照常发", r.sent === true && r.route === "media" && f5.images().length === 1 && f5.files().length === 1 && f5.msgs().length === 1, JSON.stringify(r));
      ok("⑬c 没有 AbortSignal.any：传完摘了监听，之后再停不牵连", upSigs.length === 2 && upSigs.every((sg) => !!sg && sg !== ac5.signal && !sg.aborted));

      const ac6 = new AbortController();
      let upStarted = false;
      const w = sender(fakeBins({ probe: PROBE_1080(30) }), {
        fetchImpl: (/** @type {string} */ u, /** @type {any} */ i) => (u.endsWith("/im/v1/files")
          ? new Promise((_res, rej) => {
            upStarted = true;
            const t = setTimeout(() => rej(new Error("假上传：3 秒没被掐")), 3000);
            i.signal.addEventListener("abort", () => { clearTimeout(t); rej(i.signal.reason); }, { once: true });
          })
          : fetch(u, i)),
      });
      const p6 = rejects(w.s.sendFile("oc_chat", sized("out/n18b.mp4", 12 * MB), { signal: ac6.signal }));
      const until = Date.now() + 3000;
      while (!upStarted && Date.now() < until) await sleep(5);
      ac6.abort();
      const e6 = await p6;
      ok("⑬c 没有 AbortSignal.any：传到一半叫停，在途的上传掐掉、没发", upStarted && !!e6 && e6.name === "AbortError" && f5.msgs().length === 1, e6 && `${e6.name} ${e6.message}`);
      ok("⑬c 没有 AbortSignal.any：临时目录删了", leftovers().length === 0, leftovers());
    } finally {
      f5.restore();
      if (anyDesc) Object.defineProperty(AbortSignal, "any", anyDesc);
    }
  }

  // ════ 14. im.js 接线：飞书附件全走这个模块 ════
  {
    const src = fs.readFileSync(path.join(ROOT, "im.js"), "utf8");
    ok("⑭ im.js 引了 im-feishu-media 并建了发送器", /require\("\.\/im-feishu-media"\)/.test(src) && /createFeishuMediaSender\(\{/.test(src));
    ok("⑭ feishuSendFileMsg 只剩一行转发（「停」的 signal 一并带过去）", /async function feishuSendFileMsg\(chatId, relName, o\) \{ return feishuMedia\.sendFile\(chatId, relName, o\); \}/.test(src) && /sendFile: \(rel, o\) => feishuSendFileMsg\(chatId, rel, o\)/.test(src));
    ok("⑭ 老的「一律 msg_type=file」那套删掉了", !/FEISHU_FILE_TYPE/.test(src) && !/open-apis\/im\/v1\/files/.test(src));
  }

  // ════ 14b. 真接线：一条飞书事件从 im.js 路由进来，附件一路走到这个模块 ════
  // ⑭ 只看源码长什么样，接错参数（比如 workspaceDir 取成别人的目录）照样绿。这里把真的 im.js 路由挂起来
  // 跑一趟：假飞书 + 假 runtime + 假 ffmpeg（换掉 media-probe 的两个出口，不看本机装没装），
  // 文件只放在 withWorkspace 给的目录里——发得出 media，才算 runInbound → sendFile → 本模块这条线真通
  {
    const express = require("express");
    const http = require("http");
    const tools = require(path.join(ROOT, "tools"));
    const MP = require(path.join(ROOT, "lib", "media-probe"));
    const { createImRouter } = require(path.join(ROOT, "im"));
    const WS2 = path.join(TMP, "wired-ws");
    const SRC2 = path.join(WS2, "out", "wired.mp4");
    fs.mkdirSync(path.dirname(SRC2), { recursive: true });
    fs.writeFileSync(SRC2, "");
    fs.truncateSync(SRC2, 12 * MB);

    const savedMP = { resolveMediaBins: MP.resolveMediaBins, runBin: MP.runBin };
    const runs = [];
    MP.resolveMediaBins = async () => ({
      ffmpeg: { bin: "/fake/bin/ffmpeg", how: "", why: "" }, ffprobe: { bin: "/fake/bin/ffprobe", how: "", why: "" }, install: "brew install ffmpeg",
    });
    MP.runBin = async (bin, argv) => {
      runs.push({ bin, argv });
      if (bin.endsWith("ffprobe")) return { stdout: PROBE_1080(30), stderr: "" };
      fs.writeFileSync(argv[argv.length - 1], Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
      return { stdout: "", stderr: "" };
    };

    const calls = [];
    const realFetch = global.fetch;
    const json = (o) => ({ ok: true, status: 200, json: async () => o });
    global.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u === `${API}/auth/v3/tenant_access_token/internal`) return json({ code: 0, tenant_access_token: "t-wired", expire: 7200 });
      if (/\/im\/v1\/messages\/[^/]+\/reactions/.test(u)) return json({ code: 0, data: { reaction_id: "r_wired" } });
      // 执行过程卡片让飞书明确拒掉：im.js 退回普通回复，这一节只盯附件
      if (u.startsWith(`${API}/cardkit/`)) return json({ code: 99991672, msg: "no permission" });
      if (u === `${API}/im/v1/files` || u === `${API}/im/v1/images`) {
        const fields = {};
        for (const [k, v] of init.body.entries()) fields[k] = typeof v === "string" ? v : { name: v.name, size: v.size };
        const isImg = u.endsWith("/images");
        calls.push({ kind: isImg ? "image" : "file", fields });
        return json({ code: 0, data: isImg ? { image_key: "img_wired" } : { file_key: "file_wired" } });
      }
      if (u === `${API}/im/v1/messages?receive_id_type=chat_id`) {
        const b = JSON.parse(init.body);
        calls.push({ kind: "msg", receive_id: b.receive_id, msg_type: b.msg_type, content: JSON.parse(b.content) });
        return json({ code: 0, data: { message_id: `om_w${calls.length}` } });
      }
      calls.push({ kind: "unknown", url: u });
      throw new Error(`假飞书：没见过的地址 ${u}`);
    };

    const runtime = {
      runTask: async ({ emit }) => {
        emit({ type: "files", changed: ["out/wired.mp4"] });
        return { finalText: "视频剪好了：wired.mp4" };
      },
    };
    const app = express();
    app.use(express.json());
    // 真服务里工作目录按用户切；这里用 withWorkspace 包住整条请求链，别的目录里没有这个文件
    app.use((_req, _res, next) => tools.withWorkspace(WS2, next));
    app.use(createImRouter({
      config: { im: { feishu: { app_id: "cli_wired", app_secret: "s_wired" } } },
      runtime, sessions: new Map(), outputFiles: () => [{ name: "out/wired.mp4" }],
    }).router);
    const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const post = (p, body) => new Promise((resolve, reject) => {
      const data = Buffer.from(JSON.stringify(body));
      const req = http.request({
        host: "127.0.0.1", port: server.address().port, path: p, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": data.length },
      }, (res) => { let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => resolve({ status: res.statusCode, body: t })); });
      req.on("error", reject);
      req.end(data);
    });
    try {
      const r = await post("/im/feishu/events", {
        schema: "2.0",
        header: { event_id: "ev_wired_1", event_type: "im.message.receive_v1" },
        event: { message: { message_id: "om_in_1", chat_id: "oc_wired", chat_type: "p2p", message_type: "text", content: JSON.stringify({ text: "把剪好的视频发我" }) } },
      });
      // 路由先应答再干活：等到附件那条出来（或者等到「没发出去」），最多 15 秒
      const msgs = () => calls.filter((c) => c.kind === "msg");
      const settled = () => msgs().some((m) => m.msg_type === "media" || JSON.stringify(m.content).includes("没发出去"));
      const until = Date.now() + 15000;
      while (Date.now() < until && !settled()) await new Promise((res) => setTimeout(res, 50));
      const all = msgs();
      const media = all.find((m) => m.msg_type === "media");
      const file = calls.find((c) => c.kind === "file");
      const img = calls.find((c) => c.kind === "image");
      ok("⑭b 飞书事件路由应答 200", r.status === 200, r.body);
      ok("⑭b im.js 把 mp4 交给了本模块：按 media 发进原会话、带封面", !!media && media.receive_id === "oc_wired" && media.content.file_key === "file_wired" && media.content.image_key === "img_wired", JSON.stringify(all));
      ok("⑭b 传文件 file_type=mp4、带时长、原片名、整份大小", !!file && file.fields.file_type === "mp4" && file.fields.duration === "30000" && file.fields.file_name === "wired.mp4" && file.fields.file.size === 12 * MB, JSON.stringify(file));
      ok("⑭b 封面走 images（image_type=message），抽帧读的是 withWorkspace 那份原片", !!img && img.fields.image_type === "message" && runs.some((x) => x.argv.includes("-frames:v") && x.argv.includes(SRC2)), JSON.stringify(runs.map((x) => x.argv.slice(-3))));
      ok("⑭b 先回答、后附件", all.findIndex((m) => m.msg_type === "interactive") >= 0 && all.findIndex((m) => m.msg_type === "interactive") < all.indexOf(media), all.map((m) => m.msg_type).join(","));
      ok("⑭b 没有「没发出去」，也没碰没见过的飞书地址", !all.some((m) => JSON.stringify(m.content).includes("没发出去")) && !calls.some((c) => c.kind === "unknown"), JSON.stringify(calls.filter((c) => c.kind === "unknown")));
    } finally {
      global.fetch = realFetch;
      MP.resolveMediaBins = savedMP.resolveMediaBins;
      MP.runBin = savedMP.runBin;
      await new Promise((res) => server.close(() => res()));
    }
  }

  // ════ 14c. 真接线：卡片迟到 / 发附件时回「停」/ 超长视频只发了说明 ════
  // 四个会话同时跑（各自一条队），总共等一次 5 秒的「等卡片」
  {
    const express = require("express");
    const http = require("http");
    const tools = require(path.join(ROOT, "tools"));
    const MP = require(path.join(ROOT, "lib", "media-probe"));
    const { dataPath } = require(path.join(ROOT, "paths"));
    const { createImRouter } = require(path.join(ROOT, "im"));
    const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
    const WS3 = path.join(TMP, "wired-ws3");
    const OUTS = [["out/stop1.mp4", 40 * MB], ["out/stop2.mp4", 12 * MB], ["out/stop3.mp4", 40 * MB], ["out/long.mp4", 40 * MB]];
    for (const [rel, bytes] of OUTS) {
      const abs = path.join(WS3, /** @type {string} */ (rel));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, "");
      fs.truncateSync(abs, /** @type {number} */ (bytes));
    }
    fs.mkdirSync(dataPath("data"), { recursive: true }); // IM 日志落这儿（OPENWORKBUDDY_HOME 在本测试的临时目录里）

    const savedMP = { resolveMediaBins: MP.resolveMediaBins, runBin: MP.runBin };
    /** @type {Array<{ src: string, signal?: AbortSignal }>} */
    const encodes = [];
    MP.resolveMediaBins = async () => ({
      ffmpeg: { bin: "/fake/bin/ffmpeg", how: "", why: "" }, ffprobe: { bin: "/fake/bin/ffprobe", how: "", why: "" }, install: "brew install ffmpeg",
    });
    MP.runBin = async (/** @type {string} */ bin, /** @type {string[]} */ argv, /** @type {any} */ o = {}) => {
      const out = argv[argv.length - 1];
      if (bin.endsWith("ffprobe")) return { stdout: PROBE_1080(out.endsWith("long.mp4") ? 3 * 3600 : 30), stderr: "" };
      if (argv.includes("-frames:v")) { fs.writeFileSync(out, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])); return { stdout: "", stderr: "" }; }
      // 压预览：跟 runBin 一样，拿到 signal 的叫停就掐掉；没拿到的 2.5 秒后压完
      encodes.push({ src: argv[argv.indexOf("-i") + 1], signal: o.signal });
      await new Promise((res, rej) => {
        const t = setTimeout(res, 2500);
        if (o.signal) o.signal.addEventListener("abort", () => { clearTimeout(t); rej(Object.assign(new Error("已停止"), { name: "AbortError" })); }, { once: true });
      });
      fs.writeFileSync(out, "");
      fs.truncateSync(out, 10 * MB);
      return { stdout: "", stderr: "" };
    };

    /** @type {any[]} */
    const calls = [];
    const realFetch = global.fetch;
    const json = (/** @type {any} */ o) => ({ ok: true, status: 200, json: async () => o });
    global.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ init = {}) => {
      const u = String(url), m = init.method || "GET";
      let mm;
      if (u === `${API}/auth/v3/tenant_access_token/internal`) return json({ code: 0, tenant_access_token: "t-late", expire: 7200 });
      if ((mm = /\/im\/v1\/messages\/([^/]+)\/reactions(?:\/[^/]+)?$/.exec(u))) {
        calls.push({ kind: m === "DELETE" ? "unreact" : "react", on: mm[1], emoji: m === "POST" ? JSON.parse(init.body).reaction_type.emoji_type : "" });
        return json({ code: 0, data: { reaction_id: `r_${mm[1]}` } });
      }
      if (u === `${API}/cardkit/v1/cards` && m === "POST") {
        // 卡头就是用户那句话：「迟到卡片A」6 秒才建好（等卡片只等 5 秒），「迟到卡片B」1.5 秒；别的会话建卡被拒（退回普通回复）
        const data = JSON.parse(init.body).data;
        const id = data.includes("迟到卡片A") ? "card_A" : data.includes("迟到卡片B") ? "card_B" : "";
        if (!id) return json({ code: 99991672, msg: "no permission" });
        await sleep(id === "card_A" ? 6000 : 1500);
        calls.push({ kind: "card", id });
        return json({ code: 0, data: { card_id: id } });
      }
      if ((mm = /\/cardkit\/v1\/cards\/([^/]+)$/.exec(u)) && m === "PUT") {
        const d = JSON.parse(JSON.parse(init.body).card.data);
        const body = (d.body.elements || []).find((/** @type {any} */ e) => e.element_id === "owb_body");
        calls.push({ kind: "put", id: mm[1], tag: d.header.text_tag_list[0].text.content, body: body ? String(body.content) : "" });
        return json({ code: 0, data: {} });
      }
      if ((mm = /\/im\/v1\/messages\/([^/]+)\/reply$/.exec(u))) {
        calls.push({ kind: "cardmsg", to: mm[1] });
        return json({ code: 0, data: { message_id: `om_card_${mm[1]}` } });
      }
      if (u === `${API}/im/v1/files` || u === `${API}/im/v1/images`) {
        calls.push({ kind: u.endsWith("/images") ? "image" : "file", name: init.body.get("file_name") });
        return json({ code: 0, data: { image_key: "img_late", file_key: "file_late" } });
      }
      if (u === `${API}/im/v1/messages?receive_id_type=chat_id`) {
        const b = JSON.parse(init.body);
        calls.push({ kind: "msg", chat: b.receive_id, msg_type: b.msg_type, text: String(b.content) });
        return json({ code: 0, data: { message_id: `om_l${calls.length}` } });
      }
      calls.push({ kind: "unknown", url: u });
      throw new Error(`假飞书：没见过的地址 ${u}`);
    });

    const runtime = {
      runTask: async (/** @type {any} */ { history, emit, stopSignal }) => {
        const q = String(history[history.length - 1].content);
        if (q.includes("迟到卡片B")) throw new Error("模型接口 401");
        if (q.includes("发两段视频")) { emit({ type: "files", changed: ["out/stop1.mp4", "out/stop2.mp4"] }); return { finalText: "两段视频剪好了" }; }
        if (q.includes("停了再停")) {
          // 任务中途被叫停：已经产出的文件照发，发的时候再回「停」得接得住
          emit({ type: "files", changed: ["out/stop3.mp4"] });
          await new Promise((r) => stopSignal.addEventListener("abort", r, { once: true }));
          return { finalText: "已停下，做到一半" };
        }
        if (q.includes("停一次就好")) {
          // 任务中途叫停、没有要发的文件：发附件那段另起的把手一次没按过，收尾也得摘掉
          await new Promise((r) => stopSignal.addEventListener("abort", r, { once: true }));
          return { finalText: "已停下，没产出文件" };
        }
        if (q.includes("发长视频")) { emit({ type: "files", changed: ["out/long.mp4"] }); return { finalText: "长视频剪好了" }; }
        return { finalText: "这是 A 的回答" };
      },
    };
    const app = express();
    app.use(express.json());
    app.use((_req, _res, next) => tools.withWorkspace(WS3, next));
    app.use(createImRouter({
      config: { im: { feishu: { app_id: "cli_late", app_secret: "s_late" } } },
      runtime, sessions: new Map(), outputFiles: () => OUTS.map(([name]) => ({ name })),
    }).router);
    const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const say = (/** @type {string} */ chat, /** @type {string} */ id, /** @type {string} */ text) => new Promise((resolve, reject) => {
      const data = Buffer.from(JSON.stringify({
        schema: "2.0",
        header: { event_id: `ev_${id}`, event_type: "im.message.receive_v1" },
        event: { message: { message_id: id, chat_id: chat, chat_type: "p2p", message_type: "text", content: JSON.stringify({ text }) } },
      }));
      const req = http.request({
        host: "127.0.0.1", port: server.address().port, path: "/im/feishu/events", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": data.length },
      }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
      req.on("error", reject);
      req.end(data);
    });
    const waitFor = async (/** @type {() => boolean} */ cond, ms = 15000) => {
      const until = Date.now() + ms;
      while (Date.now() < until && !cond()) await sleep(25);
      return cond();
    };
    const has = (/** @type {any} */ pat) => calls.some((c) => Object.keys(pat).every((k) => c[k] === pat[k]));
    const logFile = dataPath("data", "im-log.json");
    const imLog = () => { try { return JSON.parse(fs.readFileSync(logFile, "utf8")); } catch { return []; } };
    const encOf = (/** @type {string} */ name) => encodes.find((e) => e.src.endsWith(name));
    try {
      await Promise.all([
        say("oc_lateA", "om_lateA", "迟到卡片A"),
        say("oc_lateB", "om_lateB", "迟到卡片B"),
        say("oc_stop", "om_stop_in", "发两段视频"),
        say("oc_long", "om_long_in", "发长视频"),
        say("oc_stop2", "om_stop2_in", "停了再停"),
        say("oc_stop4", "om_stop4_in", "停一次就好"),
      ]);
      // 发附件时回「停」：第一段开压了再说
      const s1 = await waitFor(() => !!encOf("stop1.mp4"), 8000);
      if (s1) await say("oc_stop", "om_stop_cmd", "停");
      // 任务中途先停一次；已产出的照发，开压之后再停一次
      await waitFor(() => has({ kind: "react", on: "om_stop2_in" }), 3000);
      await sleep(100);
      await say("oc_stop2", "om_stop2_cmd1", "停");
      const s3 = await waitFor(() => !!encOf("stop3.mp4"), 8000);
      if (s3) await say("oc_stop2", "om_stop2_cmd2", "停");
      // 任务中途停过、没东西要发：收尾之后再回「停」，没有在跑的任务，就是一句普通的话
      await waitFor(() => has({ kind: "react", on: "om_stop4_in" }), 3000);
      await sleep(100);
      await say("oc_stop4", "om_stop4_cmd1", "停");
      const s4 = await waitFor(() => has({ kind: "unreact", on: "om_stop4_in" }), 8000);
      if (s4) await say("oc_stop4", "om_stop4_cmd2", "停");
      // 每个任务收尾都会把「收到」表情摘掉：等齐了再看
      await waitFor(() => ["om_lateA", "om_lateB", "om_stop_in", "om_long_in", "om_stop2_in", "om_stop4_in"].every((id) => has({ kind: "unreact", on: id })));
      await waitFor(() => has({ kind: "unreact", on: "om_stop4_cmd2" }), 5000);
      await waitFor(() => has({ kind: "put", id: "card_A" }) && has({ kind: "put", id: "card_B" }), 3000);
      await sleep(700); // IM 日志攒 500ms 落一次盘
      const L = imLog();
      const logOf = (/** @type {string} */ chat) => L.filter((/** @type {any} */ e) => e.chat === chat).map((/** @type {any} */ e) => `${e.dir}|${e.text}`);
      const msgsTo = (/** @type {string} */ chat) => calls.filter((c) => c.kind === "msg" && c.chat === chat);

      // feishu#2：卡片过了 5 秒才建好，回答已经另发了——迟到的卡片就地收尾，别一直挂着「进行中」、每 15 秒推一次心跳
      const putsA = calls.filter((c) => c.kind === "put" && c.id === "card_A");
      const answerA = msgsTo("oc_lateA").filter((c) => c.text.includes("这是 A 的回答"));
      ok("⑭c 卡片迟到：回答另发了一条（只一条），在卡片之前", answerA.length === 1 && calls.indexOf(answerA[0]) < calls.findIndex((c) => c.kind === "cardmsg" && c.to === "om_lateA"), JSON.stringify(calls.filter((c) => c.chat === "oc_lateA" || c.to === "om_lateA" || c.id === "card_A")));
      ok("⑭c 卡片迟到：到了就定格成「完成」，说回答另发了、不再贴一遍全文", putsA.length === 1 && putsA[0].tag === "完成" && /另发/.test(putsA[0].body) && !putsA[0].body.includes("这是 A 的回答"), JSON.stringify(putsA));
      const putsB = calls.filter((c) => c.kind === "put" && c.id === "card_B");
      const errB = msgsTo("oc_lateB").filter((c) => c.text.includes("模型接口 401"));
      ok("⑭c 任务一上来就出错、卡片后到：报错另发一条，卡片到了标成「没做成」", errB.length === 1 && putsB.length === 1 && putsB[0].tag === "没做成" && putsB[0].body.includes("模型接口 401"), JSON.stringify({ putsB, errB }));

      // feishu#3：发附件时回「停」——在压的掐掉，后面的不发，不再补「没发出去」
      ok("⑭c 发附件时回「停」：在「停」上贴了 OK（按到了）", has({ kind: "react", on: "om_stop_cmd", emoji: "OK" }), JSON.stringify(calls.filter((c) => c.kind === "react")));
      const e1 = encOf("stop1.mp4");
      ok("⑭c 发附件时回「停」：在压的预览拿到了 signal、被掐掉", !!e1 && !!e1.signal && e1.signal.aborted === true);
      ok("⑭c 发附件时回「停」：两段都没传、没发", !msgsTo("oc_stop").some((c) => c.msg_type === "media" || c.msg_type === "file") && !calls.some((c) => c.kind === "file" && /stop[12]\.mp4/.test(c.name)), JSON.stringify(msgsTo("oc_stop").map((c) => c.msg_type)));
      ok("⑭c 发附件时回「停」：没跟用户说「没发出去」", !msgsTo("oc_stop").some((c) => c.text.includes("没发出去")));
      ok("⑭c 发附件时回「停」：日志记「已叫停，没发」两条", logOf("oc_stop").includes("sys|已叫停，没发：out/stop1.mp4") && logOf("oc_stop").includes("sys|已叫停，没发：out/stop2.mp4"), JSON.stringify(logOf("oc_stop")));
      ok("⑭c 发附件时回「停」：「停」没当成新任务", !logOf("oc_stop").some((t) => t === "in|停"), JSON.stringify(logOf("oc_stop")));

      // 任务中途停过一次：已产出的照发；发的时候再回「停」，接得住
      ok("⑭c 任务中途叫停过：已产出的文件照样开压", !!s3);
      const e3 = encOf("stop3.mp4");
      ok("⑭c 任务中途叫停过、发附件时再回「停」：两次都贴了 OK、在压的被掐掉", has({ kind: "react", on: "om_stop2_cmd1", emoji: "OK" }) && has({ kind: "react", on: "om_stop2_cmd2", emoji: "OK" }) && !!e3 && !!e3.signal && e3.signal.aborted === true, JSON.stringify(calls.filter((c) => c.kind === "react")));
      ok("⑭c 再回「停」之后：没发、日志记「已叫停，没发」、「停」没当成新任务", !msgsTo("oc_stop2").some((c) => c.msg_type === "media") && logOf("oc_stop2").includes("sys|已叫停，没发：out/stop3.mp4") && !logOf("oc_stop2").some((t) => t === "in|停"), JSON.stringify(logOf("oc_stop2")));
      // 任务中途叫停过、收尾了：发附件那段另起的把手也摘掉了，之后的「停」不再被当成叫停吞掉
      ok("⑭c 叫停过的任务收尾后再回「停」：没贴 OK、当成普通消息收下", !!s4 && has({ kind: "react", on: "om_stop4_cmd1", emoji: "OK" }) && !has({ kind: "react", on: "om_stop4_cmd2", emoji: "OK" }) && logOf("oc_stop4").filter((t) => t === "in|停").length === 1, JSON.stringify({ log: logOf("oc_stop4"), reacts: calls.filter((c) => /om_stop4/.test(c.on || "")) }));

      // feishu#6 / cross#3：超长视频只发了一句「原片在工作台」，日志别记成「已发送文件」
      ok("⑭c 超长视频：只发了说明（视频太长…）、没传视频", msgsTo("oc_long").some((c) => c.text.includes("视频太长")) && !calls.some((c) => c.kind === "file" && /long\.mp4/.test(c.name)));
      ok("⑭c 超长视频：日志记「没发文件，只发了说明」，不是「已发送文件」", logOf("oc_long").some((t) => t.startsWith("sys|没发文件，只发了说明：out/long.mp4")) && !logOf("oc_long").some((t) => t.includes("已发送文件")), JSON.stringify(logOf("oc_long")));
      ok("⑭c 没碰没见过的飞书地址", !calls.some((c) => c.kind === "unknown"), JSON.stringify(calls.filter((c) => c.kind === "unknown")));
    } finally {
      global.fetch = realFetch;
      MP.resolveMediaBins = savedMP.resolveMediaBins;
      MP.runBin = savedMP.runBin;
      await new Promise((res) => server.close(() => res()));
    }
  }

  // ════ 14d. 真接线：卡头「已花 ¥…」只数这一趟、数全了才出、引擎跑的整趟不说 ════
  // 十四个会话同时跑（各一条队）。假 runtime 里真调 quota.record（工具里记账就是这一句），
  // 整趟那条 depth 0 的 usage 到了这一格才出现。价钱全来自 pricing.js 的内置表：
  // tavily 一次 ¥0.0568；deepseek-chat 10 万进 2 万出 ¥0.36；ollama/* 是本机，¥0 且知道是 ¥0
  {
    const express = require("express");
    const http = require("http");
    const tools = require(path.join(ROOT, "tools"));
    const quota = require(path.join(ROOT, "quota"));
    const { dataPath } = require(path.join(ROOT, "paths"));
    const { createImRouter } = require(path.join(ROOT, "im"));
    const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
    const WS4 = path.join(TMP, "spend-ws");
    fs.mkdirSync(WS4, { recursive: true });
    fs.mkdirSync(dataPath("data"), { recursive: true });

    /** @type {any[]} */
    const calls = [];
    const titles = new Map();
    let cardN = 0;
    const realFetch = global.fetch;
    const json = (/** @type {any} */ o) => ({ ok: true, status: 200, json: async () => o });
    global.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ init = {}) => {
      const u = String(url), m = init.method || "GET";
      let mm;
      if (u === `${API}/auth/v3/tenant_access_token/internal`) return json({ code: 0, tenant_access_token: "t-spend", expire: 7200 });
      if (/\/im\/v1\/messages\/[^/]+\/reactions/.test(u)) return json({ code: 0, data: { reaction_id: "r_spend" } });
      if (u === `${API}/cardkit/v1/cards` && m === "POST") {
        const d = JSON.parse(JSON.parse(init.body).data);
        const title = String(d.header.title.content);
        if (title.startsWith("壬")) await sleep(400); // 建卡慢：钱在卡建好之前就算完了，先攒着
        const id = `card_s${++cardN}`;
        titles.set(id, title);
        return json({ code: 0, data: { card_id: id } });
      }
      if ((mm = /\/cardkit\/v1\/cards\/([^/]+)$/.exec(u)) && m === "PUT") {
        const d = JSON.parse(JSON.parse(init.body).card.data);
        calls.push({ kind: "put", title: titles.get(mm[1]) || "", sub: String(d.header.subtitle.content), tag: d.header.text_tag_list[0].text.content });
        return json({ code: 0, data: {} });
      }
      if ((mm = /\/im\/v1\/messages\/([^/]+)\/reply$/.exec(u))) return json({ code: 0, data: { message_id: `om_card_${mm[1]}` } });
      if (u === `${API}/im/v1/messages?receive_id_type=chat_id`) {
        const b = JSON.parse(init.body);
        calls.push({ kind: "msg", chat: b.receive_id, text: String(b.content) });
        return json({ code: 0, data: { message_id: `om_s${calls.length}` } });
      }
      calls.push({ kind: "unknown", url: u });
      throw new Error(`假飞书：没见过的地址 ${u}`);
    });

    const search = (/** @type {string} */ provider) => quota.record("search", { provider, meta: "测试" });
    const chat = (/** @type {any} */ emit, /** @type {string} */ model, p = 100000, c = 20000) => emit({ type: "usage", model, prompt: p, completion: c, calls: 3 });
    const runtime = {
      runTask: async (/** @type {any} */ { history, emit }) => {
        const q = String(history[history.length - 1].content);
        emit({ type: "step_start", step: 1 });
        emit({ type: "tool_use", id: "t1", name: "web_search", title: "搜 竞品" });
        if (q.startsWith("甲")) {
          search("tavily");
          await sleep(1500); // 跨过一次 1.2 秒的推送：这时工具那笔已经记上了，卡上不许出半截的数
          emit({ type: "tool_result", id: "t1", outcome: "8 条" });
          emit({ type: "usage", depth: 1, model: "deepseek-chat", prompt: 9e6, completion: 9e6 }); // 子智能体的：整趟那条已经含它
          chat(emit, "deepseek-chat");
          return { finalText: "甲做完了" };
        }
        if (q.startsWith("乙")) {
          await sleep(200);
          search("tavily");
          await sleep(200);
          search("tavily");
          chat(emit, "deepseek-chat", 10000, 2000);
          return { finalText: "乙做完了" };
        }
        if (q.startsWith("丙")) { search("mystery-search"); search("mystery-search"); chat(emit, "deepseek-chat"); return { finalText: "丙做完了" }; }
        if (q.startsWith("丁")) { chat(emit, "mystery-llm-9"); return { finalText: "丁做完了" }; }
        if (q.startsWith("戊")) { search("tavily"); emit({ type: "usage", local: true, model: "claude-sonnet-4-5", prompt: 5000, completion: 800 }); return { finalText: "戊做完了" }; }
        if (q.startsWith("己")) { emit({ type: "usage", local: true, model: "gpt-5.4", prompt: 5000, completion: 800 }); return { finalText: "己做完了" }; }
        if (q.startsWith("庚")) { chat(emit, "ollama/qwen2.5", 1000, 100); return { finalText: "庚做完了" }; }
        if (q.startsWith("辛")) { search("tavily"); await sleep(50); throw new Error("模型接口 500"); }
        if (q.startsWith("壬")) { search("tavily"); chat(emit, "deepseek-chat"); return { finalText: "壬做完了" }; }
        // 付费但 pricing 表里没这一路的（判断模型）：记成一项单价未知，不能悄悄当 0
        if (q.startsWith("癸")) { quota.record("decide", { n: 3, provider: "systemone", model: "jev-0" }); chat(emit, "deepseek-chat"); return { finalText: "癸做完了" }; }
        // 本来就不花钱的那路（抓网页，CAPS 里 paid:false）：不算「单价未知」
        if (q.startsWith("子")) { quota.record("fetch", { provider: "http" }); chat(emit, "deepseek-chat"); return { finalText: "子做完了" }; }
        // 看图直连视觉模型，不记账也不进 usage：看了两张（同一项），整趟的数要标出有一项不知道
        if (q.startsWith("丑")) {
          for (const id of ["v1", "v2"]) {
            emit({ type: "tool_use", id, name: "look_at_image", depth: 0, title: "看图" });
            emit({ type: "tool_result", id, name: "look_at_image", depth: 0, isError: false, outcome: "看完了" });
          }
          chat(emit, "deepseek-chat");
          return { finalText: "丑做完了" };
        }
        // 子智能体里看的图（depth 1，事件经父任务转发上来）也算
        if (q.startsWith("寅")) {
          emit({ type: "tool_result", id: "d1/v1", name: "look_at_image", depth: 1, expert: "探索1", isError: false, outcome: "看完了" });
          chat(emit, "deepseek-chat");
          return { finalText: "寅做完了" };
        }
        // 中途换了备用渠道：整趟那条 usage 里两个模型的 token 混在一起，按哪个价算都不对
        if (q.startsWith("卯")) {
          search("tavily");
          emit({ type: "failover", note: "主模型连着报错，已切换到备用渠道「备用」继续本任务", channel: "备用", depth: 0 });
          chat(emit, "deepseek-chat");
          return { finalText: "卯做完了" };
        }
        return { finalText: "?" };
      },
    };
    const app = express();
    app.use(express.json());
    app.use((_req, _res, next) => tools.withWorkspace(WS4, next));
    app.use(createImRouter({
      config: { im: { feishu: { app_id: "cli_spend", app_secret: "s_spend" } } },
      runtime, sessions: new Map(), outputFiles: () => [],
    }).router);
    const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const say = (/** @type {string} */ chatId, /** @type {string} */ id, /** @type {string} */ text) => new Promise((resolve, reject) => {
      const data = Buffer.from(JSON.stringify({
        schema: "2.0",
        header: { event_id: `ev_${id}`, event_type: "im.message.receive_v1" },
        event: { message: { message_id: id, chat_id: chatId, chat_type: "p2p", message_type: "text", content: JSON.stringify({ text }) } },
      }));
      const req = http.request({
        host: "127.0.0.1", port: server.address().port, path: "/im/feishu/events", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": data.length },
      }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
      req.on("error", reject);
      req.end(data);
    });
    const NAMES = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸", "子", "丑", "寅", "卯"];
    const putsOf = (/** @type {string} */ k) => calls.filter((c) => c.kind === "put" && c.title.startsWith(k));
    const finalOf = (/** @type {string} */ k) => putsOf(k).filter((p) => p.tag === "完成" || p.tag === "没做成").pop();
    try {
      await Promise.all(NAMES.map((k, i) => say(`oc_spend${i}`, `om_spend${i}`, `${k}：查三家竞品`)));
      const until = Date.now() + 15000;
      while (Date.now() < until && !NAMES.every((k) => finalOf(k))) await sleep(25);
      const fin = Object.fromEntries(NAMES.map((k) => [k, finalOf(k)]));
      const sub = (/** @type {string} */ k) => (fin[k] ? fin[k].sub : "(没收尾)");
      const noLine = (/** @type {string} */ k) => !!fin[k] && putsOf(k).every((p) => !/已花|单价未知|¥/.test(p.sub));
      ok("⑭d 十四张卡都收尾了", NAMES.every((k) => fin[k]), NAMES.filter((k) => !fin[k]).join(""));
      ok("⑭d 工具 + 聊天都有价：收尾卡「已花 ¥0.42」，排在 tokens 前面", /· 已花 ¥0\.42 · .*tokens$/.test(sub("甲")) && fin["甲"].tag === "完成", sub("甲"));
      const midA = putsOf("甲").filter((p) => p.tag === "进行中");
      ok("⑭d 跑着的时候推过卡，但工具那笔（¥0.06）没单独上卡：半截的数不出", midA.length >= 1 && midA.every((p) => !/已花|¥/.test(p.sub)), JSON.stringify(putsOf("甲")));
      ok("⑭d 卡上出现过的钱只有最终那一个数", putsOf("甲").filter((p) => /¥/.test(p.sub)).every((p) => p.sub.includes("已花 ¥0.42")), JSON.stringify(putsOf("甲").map((p) => p.sub)));
      ok("⑭d 同时跑的另一趟只数自己的（2 次搜索 + 小聊天 = ¥0.15）", sub("乙").includes("已花 ¥0.15") && !sub("乙").includes("0.42"), sub("乙"));
      ok("⑭d 有一项没价：「已花 ¥0.36 · 1 项单价未知」（同一个搜索源搜两次算 1 项）", sub("丙").includes("已花 ¥0.36 · 1 项单价未知"), sub("丙"));
      ok("⑭d 一项价都没有：「单价未知」，不写 ¥0", sub("丁").includes("单价未知") && !sub("丁").includes("¥"), sub("丁"));
      ok("⑭d CLI 引擎跑的（usage 带 local）：本进程记到了一笔也整趟不说", noLine("戊"), JSON.stringify(putsOf("戊").map((p) => p.sub)));
      ok("⑭d CLI 引擎跑的、本进程一笔没记到：也不说（工具在子进程里，看不见不等于没花）", noLine("己"), JSON.stringify(putsOf("己").map((p) => p.sub)));
      ok("⑭d 本机模型、没调付费接口：一分钱没花，这一格不出", noLine("庚"), JSON.stringify(putsOf("庚").map((p) => p.sub)));
      ok("⑭d 花了一笔之后出错：没做成的卡上不出半截的数", noLine("辛") && fin["辛"].tag === "没做成", JSON.stringify(putsOf("辛")));
      ok("⑭d 出错那趟照常说了为什么", calls.some((c) => c.kind === "msg" && c.chat === "oc_spend7" && c.text.includes("模型接口 500")));
      ok("⑭d 建卡慢、钱先算完：攒着的那笔到卡上了", sub("壬").includes("已花 ¥0.42"), JSON.stringify(putsOf("壬")));
      ok("⑭d 判断模型（付费、表里没价）：「已花 ¥0.36 · 1 项单价未知」，不当成数全了", sub("癸").includes("已花 ¥0.36 · 1 项单价未知"), sub("癸"));
      ok("⑭d 抓网页本来不花钱：不算单价未知，照写「已花 ¥0.36」", sub("子").includes("已花 ¥0.36") && !sub("子").includes("单价未知"), sub("子"));
      ok("⑭d 看了两张图（直连视觉模型、没记账）：「已花 ¥0.36 · 1 项单价未知」", sub("丑").includes("已花 ¥0.36 · 1 项单价未知"), sub("丑"));
      ok("⑭d 子智能体里看的图也算那一项", sub("寅").includes("已花 ¥0.36 · 1 项单价未知"), sub("寅"));
      ok("⑭d 中途换了备用渠道：聊天那部分记单价未知，只写工具那笔「已花 ¥0.06 · 1 项单价未知」", sub("卯").includes("已花 ¥0.06 · 1 项单价未知") && !sub("卯").includes("0.42"), sub("卯"));
      ok("⑭d 没碰没见过的飞书地址", !calls.some((c) => c.kind === "unknown"), JSON.stringify(calls.filter((c) => c.kind === "unknown")));
    } finally {
      global.fetch = realFetch;
      await new Promise((res) => server.close(() => res()));
    }
  }

  // ════ 14e. 进聊天的报错里没有本机绝对路径（飞书 / 企业微信 / 公众号 / 微信 iLink 同一个抹法） ════
  // 每条路都喂一个带绝对路径的假 fs 错：人看得懂的留下（相对名、错误码），家目录、工作目录的全路径不出
  {
    const IM = require(path.join(ROOT, "im-media"));
    const { createWecomApp, createWechatMp, encryptMsg, msgSignature } = require(path.join(ROOT, "im-wechat"));
    const { createIlinkConnection } = require(path.join(ROOT, "im-ilink"));
    const express = require("express");
    const http = require("http");
    const tools = require(path.join(ROOT, "tools"));
    const { dataPath } = require(path.join(ROOT, "paths"));
    const { createImRouter } = require(path.join(ROOT, "im"));
    const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (/** @type {() => boolean} */ cond, ms = 10000) => {
      const until = Date.now() + ms;
      while (Date.now() < until && !cond()) await sleep(25);
      return cond();
    };
    const HOME = os.homedir();
    const WS5 = path.join(TMP, "scrub-ws");
    const PDF = path.join(WS5, "out", "报告.pdf");
    fs.mkdirSync(path.dirname(PDF), { recursive: true });
    fs.writeFileSync(PDF, "%PDF-1.4 test");
    fs.mkdirSync(dataPath("data"), { recursive: true });
    const leaks = (/** @type {any} */ s) => {
      const t = String(s);
      return t.includes(WS5) || t.includes(TMP) || t.includes(`${HOME}/`) || /(^|[\s'"(（])\/(private|var|Users|home|tmp)\//.test(t);
    };
    const fsErr = (/** @type {string} */ code, /** @type {string} */ abs) => Object.assign(
      new Error(`${code}: ${code === "EACCES" ? "permission denied" : "no such file or directory"}, open '${abs}'`),
      { code, syscall: "open", path: abs, errno: code === "EACCES" ? -13 : -2 });
    /** 读 abs 这一个文件时报 EACCES（root 跑测试时 chmod 拦不住，所以不靠 chmod） */
    const withReadFail = async (/** @type {string} */ abs, /** @type {() => Promise<any>} */ fn) => {
      const real = fs.readFileSync;
      fs.readFileSync = /** @type {any} */ (function (/** @type {any} */ p, /** @type {any[]} */ ...rest) {
        if (p === abs) throw fsErr("EACCES", abs);
        return real.call(fs, p, ...rest);
      });
      try { return await fn(); } finally { fs.readFileSync = real; }
    };
    const MISS = path.join(WS5, "out", "不存在.pdf");

    // ---- 抹法本身 ----
    const S = IM.scrubPaths;
    ok("⑭e 抹路径：工作目录下的剩相对名", S(`open '${PDF}'`, [WS5]) === "open '…/out/报告.pdf'", S(`open '${PDF}'`, [WS5]));
    ok("⑭e 抹路径：认不出的目录，像文件的只留文件名", S("写 /var/folders/ab/T/owb-x/cover.jpg 失败") === "写 …/cover.jpg 失败");
    ok("⑭e 抹路径：不像文件的整段换成 …（/home/<名字> 最后一节就是用户名）", S("cd /home/alice 失败") === "cd … 失败");
    ok("⑭e 抹路径：Windows 路径也抹", S("open 'C:\\Users\\bob\\Desktop\\x.docx'") === "open '…/x.docx'");
    const keep = "https://open.feishu.cn/open-apis/im/v1/files 超时，1/2 完成，…/out/a.pdf";
    ok("⑭e 抹路径：网址、比例、已抹过的相对名不动", S(keep) === keep, S(keep));
    ok("⑭e 抹路径：家目录底下的工作目录按工作目录抹（长的先）", S(`${HOME}/proj/ws/out/a.pdf`, [`${HOME}/proj/ws`]) === "…/out/a.pdf");
    ok("⑭e 抹路径：不截断（截断归调用方，先抹后截）、空值不炸", S(null) === "" && S("长".repeat(500)).length === 500);
    // 目录名里带空格（My Drive、Alice Smith）：以前在空格处断开，前半截（/Volumes/My、C:\Data\Alice）抹了、后半截目录原样漏出去
    const sp = [
      ["open '/Volumes/My Drive/客户合同/王五-工资.pdf'", "open '…/王五-工资.pdf'"],
      ["EACCES: /srv/data/secret dir/file.pdf", "EACCES: …/file.pdf"],
      ["open C:\\Data\\Alice Smith\\secret\\x.docx", "open …/x.docx"],
      ["load C:\\Program Files (x86)\\Acme\\a.dll 失败", "load …/a.dll 失败"],
      ['rename "/srv/x/my file.pdf"', 'rename "…/my file.pdf"'],
    ];
    for (const [i, o] of sp) ok(`⑭e 抹路径：目录带空格也整段抹（${o}）`, S(i) === o, S(i));
    const prose = "写 /tmp/x/a.txt 失败，换 b/c 目录再试；从 /tmp/a 复制到 /tmp/b/c.txt";
    ok("⑭e 抹路径：路径后面跟着的话不吞", S(prose) === "写 …/a.txt 失败，换 b/c 目录再试；从 … 复制到 …/c.txt", S(prose));

    // ---- 读要发的文件：三种 fs 错各一句人话 ----
    const eMiss = await rejects((async () => IM.readForSend(MISS))());
    ok("⑭e readForSend 找不到：「工作目录里找不到这个文件」", !!eMiss && eMiss.message === "工作目录里找不到这个文件", eMiss && eMiss.message);
    const eAcc = await rejects(withReadFail(PDF, async () => IM.readForSend(PDF)));
    ok("⑭e readForSend 没权限：「没权限读这个文件」", !!eAcc && eAcc.message === "没权限读这个文件", eAcc && eAcc.message);
    const eDir = await rejects((async () => IM.readForSend(path.dirname(PDF)))());
    ok("⑭e readForSend 读到目录（EISDIR 不带 path）：说是读这个文件出错，不说成临时文件", !!eDir && eDir.message === "读这个文件出错（EISDIR）", eDir && eDir.message);

    const realFetch = global.fetch;
    /** @type {string[]} */
    const hits = [];
    /** @type {any[]} */
    const fcalls = [];
    let ilinkPolls = 0, ilink2Polls = 0;
    const json = (/** @type {any} */ o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
    global.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ init = {}) => {
      const u = String(url), m = init.method || "GET";
      let mm;
      hits.push(u);
      if (u.startsWith("https://qyapi.weixin.qq.com/cgi-bin/gettoken?") || u.startsWith("https://api.weixin.qq.com/cgi-bin/token?")) return json({ access_token: "tok", expires_in: 7200 });
      if (u === "https://ilink.test/ilink/bot/getupdates") {
        if (++ilinkPolls > 1) return new Promise(() => {}); // 第二轮长轮询挂着，stop 之后没人等它
        return json({ ret: 0, msgs: [{ from_user_id: "u1", message_id: "m1", context_token: "ct1", item_list: [
          { type: 1, text_item: { text: "看看这份合同" } },
          { type: 4, file_item: { file_name: "合同.pdf", media: { encrypt_query_param: "q", aes_key: "k" } } },
        ] }] });
      }
      // 走 im.js 接线的那条 iLink（第二个连接，自己一份轮询计数）
      if (u === "https://ilink2.test/ilink/bot/getupdates") {
        if (++ilink2Polls > 1) return new Promise(() => {});
        return json({ ret: 0, msgs: [{ from_user_id: "u2", message_id: "m2", context_token: "ct2", item_list: [
          { type: 1, text_item: { text: "收一下这份合同" } },
          { type: 4, file_item: { file_name: "合同.pdf", media: { encrypt_query_param: "q2", aes_key: "k2" } } },
        ] }] });
      }
      if (u === "https://ilink2.test/ilink/bot/sendmessage") { fcalls.push({ kind: "ilink2" }); return json({ ret: 0 }); }
      // QQ：换 token、取网关、回消息
      if (u === "https://bots.qq.com/app/getAppAccessToken") return json({ access_token: "qqtok", expires_in: 7200 });
      if (u === "https://api.sgroup.qq.com/gateway/bot") return json({ url: "wss://qq.test/ws" });
      if (u.startsWith("https://api.sgroup.qq.com/v2/users/")) { fcalls.push({ kind: "qq", text: String(JSON.parse(init.body).content) }); return json({ id: "qq_r1" }); }
      // 企业微信 / 公众号：回消息
      if (u.startsWith("https://qyapi.weixin.qq.com/cgi-bin/message/send?")) { fcalls.push({ kind: "wecom" }); return json({ errcode: 0 }); }
      if (u.startsWith("https://api.weixin.qq.com/cgi-bin/message/custom/send?")) { fcalls.push({ kind: "mp" }); return json({ errcode: 0 }); }
      // 以下是飞书
      if (u === `${API}/auth/v3/tenant_access_token/internal`) return json({ code: 0, tenant_access_token: "t-scrub", expire: 7200 });
      if (/\/im\/v1\/messages\/[^/]+\/reactions/.test(u)) return json({ code: 0, data: { reaction_id: "r_scrub" } });
      if (u === `${API}/cardkit/v1/cards` && m === "POST") return json({ code: 0, data: { card_id: `card_x${hits.length}` } });
      if (/\/cardkit\/v1\/cards\/[^/]+$/.test(u) && m === "PUT") {
        const d = JSON.parse(JSON.parse(init.body).card.data);
        fcalls.push({ kind: "put", tag: d.header.text_tag_list[0].text.content, card: JSON.stringify(d) });
        return json({ code: 0, data: {} });
      }
      if ((mm = /\/im\/v1\/messages\/([^/]+)\/reply$/.exec(u))) return json({ code: 0, data: { message_id: `om_card_${mm[1]}` } });
      if (u === `${API}/im/v1/files`) throw Object.assign(new Error(`EIO: i/o error, read '${PDF}'`), { code: "EIO" }); // 没有 syscall：发送器不认得，原样往上抛
      if (u === `${API}/im/v1/messages?receive_id_type=chat_id`) {
        const b = JSON.parse(init.body);
        fcalls.push({ kind: "msg", chat: b.receive_id, text: String(b.content) });
        return json({ code: 0, data: { message_id: `om_x${fcalls.length}` } });
      }
      fcalls.push({ kind: "unknown", url: u });
      throw new Error(`假接口：没见过的地址 ${u}`);
    });
    const savedIM = { fetchBuffer: IM.fetchBuffer, saveInbound: IM.saveInbound, downloadWechatCdn: IM.downloadWechatCdn };
    // QQ 走长连接：换一个假 WebSocket，消息由测试直接喂给它的 onmessage
    const realWS = /** @type {any} */ (globalThis).WebSocket;
    /** @type {any[]} */
    const qqSocks = [];
    /** @type {any} */ (globalThis).WebSocket = class FakeQQSocket {
      constructor(/** @type {string} */ url) { this.url = url; qqSocks.push(this); }
      send() {}
      close() {}
    };
    /** @type {any} */
    let server = null;
    try {
      // ---- 企业微信 / 公众号：发附件读不到文件 ----
      for (const [nm, app, to] of /** @type {const} */ ([
        ["企业微信", createWecomApp({ getConfig: () => ({ corp_id: "c1", secret: "s1", agent_id: "1" }) }), "zhangsan"],
        ["公众号", createWechatMp({ getConfig: () => ({ app_id: "a1", app_secret: "s1" }) }), "openid1"],
      ])) {
        const n0 = hits.length;
        const e1 = await rejects(app.sendFile(to, MISS, "不存在.pdf"));
        ok(`⑭e ${nm}发附件、文件不在：「工作目录里找不到这个文件」，不带路径`, !!e1 && e1.message === "工作目录里找不到这个文件" && !leaks(e1.message), e1 && e1.message);
        const e2 = await rejects(withReadFail(PDF, () => app.sendFile(to, PDF, "报告.pdf")));
        ok(`⑭e ${nm}发附件、没权限：「没权限读这个文件」，不带路径`, !!e2 && e2.message === "没权限读这个文件" && !leaks(e2.message), e2 && e2.message);
        ok(`⑭e ${nm}读不到就停：只要过 token，没往上传`, hits.slice(n0).every((u) => /cgi-bin\/(gettoken|token)\?/.test(u)), hits.slice(n0).join("\n"));
      }

      // ---- 微信 iLink：收附件落盘失败 + 发附件读不到 ----
      /** @type {any[]} */
      const got = [];
      const ilink = createIlinkConnection({
        getConfig: () => ({ bot_token: "b", ilink_bot_id: "bot1", base_url: "https://ilink.test" }),
        onMessage: async (/** @type {any} */ msg) => { got.push(msg); },
        downloadMedia: async () => { throw fsErr("EACCES", path.join(WS5, "微信收到", "合同.pdf")); },
        log: /** @type {any} */ ({ log() {}, warn() {}, error() {} }),
      });
      try {
        await ilink.start();
        await waitFor(() => got.length > 0, 5000);
        const why = got[0] && got[0].failed[0] ? String(got[0].failed[0].why) : "";
        ok("⑭e iLink 收附件没存下：告诉用户的那句有错误码和文件名、没有绝对路径", why.includes("EACCES") && why.includes("…/合同.pdf") && !leaks(why), why || JSON.stringify(got));
        const e1 = await rejects(ilink.sendFile("u1", MISS, "不存在.pdf"));
        ok("⑭e iLink 发附件、文件不在：「工作目录里找不到这个文件」", !!e1 && e1.message === "工作目录里找不到这个文件" && !leaks(e1.message), e1 && e1.message);
        const e2 = await rejects(withReadFail(PDF, () => ilink.sendFile("u1", PDF, "报告.pdf")));
        ok("⑭e iLink 发附件、没权限：「没权限读这个文件」", !!e2 && e2.message === "没权限读这个文件" && !leaks(e2.message), e2 && e2.message);
      } finally { await ilink.stop(); }

      // ---- im.js 接线：发附件失败的那句、任务报错、收附件的说明 ----
      IM.fetchBuffer = /** @type {any} */ (async () => ({ buf: Buffer.from("%PDF-1.4 inbound"), fileName: "合同.pdf" }));
      // 落盘报的路径带一层子目录：im.js 认得工作目录才抹得出「…/收到的附件/合同.pdf」，
      // 光靠渠道自己那道（不认得工作目录）只剩「…/合同.pdf」——这样才分得出 im.js 那一道在不在
      IM.saveInbound = /** @type {any} */ ((/** @type {string} */ dir, /** @type {string} */ name) => { throw fsErr("EACCES", path.join(dir, "收到的附件", name || "x")); });
      IM.downloadWechatCdn = /** @type {any} */ (async () => Buffer.from("%PDF-1.4 ilink"));
      /** @type {Record<string, string>} */
      const asked = {};
      const runtime = {
        runTask: async (/** @type {any} */ { history, emit }) => {
          const q = String(history[history.length - 1].content);
          if (q.includes("发报告")) { emit({ type: "files", changed: ["out/报告.pdf"] }); return { finalText: "报告好了：报告.pdf" }; }
          if (q.includes("炸一下")) throw fsErr("ENOENT", path.join(WS5, "out", "缺的.docx"));
          const ch = q.includes("我在QQ") ? "qq" : q.includes("我在企业微信") ? "wecom" : q.includes("我在公众号") ? "mp" : q.includes("我在微信") ? "ilink" : "inbound";
          asked[ch] = q;
          return { finalText: "收到" };
        },
      };
      const AES = require("crypto").randomBytes(32).toString("base64").slice(0, 43);
      const app = express();
      app.use(express.json());
      app.use((_req, _res, next) => tools.withWorkspace(WS5, next));
      const im = createImRouter({
        config: { im: {
          feishu: { app_id: "cli_scrub", app_secret: "s_scrub" },
          qq: { app_id: "qq_scrub", app_secret: "qs_scrub" },
          wecom_app: { corp_id: "c1", secret: "s1", agent_id: "1", token: "wtok", aes_key: AES },
          wechat_mp: { app_id: "a1", app_secret: "s1", token: "mtok" },
          wechat_ilink: { bot_token: "b2", ilink_bot_id: "bot2", base_url: "https://ilink2.test" },
        } },
        runtime, sessions: new Map(), outputFiles: () => [{ name: "out/报告.pdf" }], saveConfig: () => {},
      });
      app.use(im.router);
      server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
      const post = (/** @type {any} */ message) => new Promise((resolve, reject) => {
        const data = Buffer.from(JSON.stringify({ schema: "2.0", header: { event_id: `ev_${message.message_id}`, event_type: "im.message.receive_v1" }, event: { message } }));
        const req = http.request({
          host: "127.0.0.1", port: server.address().port, path: "/im/feishu/events", method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": data.length },
        }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
        req.on("error", reject);
        req.end(data);
      });
      const textMsg = (/** @type {string} */ chat, /** @type {string} */ id, /** @type {string} */ text) => ({ message_id: id, chat_id: chat, chat_type: "p2p", message_type: "text", content: JSON.stringify({ text }) });
      await Promise.all([
        post(textMsg("oc_x_send", "om_x_send", "发报告给我")),
        post(textMsg("oc_x_boom", "om_x_boom", "炸一下")),
        post({ message_id: "om_x_in", chat_id: "oc_x_in", chat_type: "p2p", message_type: "file", content: JSON.stringify({ file_key: "fk1", file_name: "合同.pdf" }) }),
      ]);
      const msgsTo = (/** @type {string} */ c) => fcalls.filter((x) => x.kind === "msg" && x.chat === c);
      await waitFor(() => msgsTo("oc_x_send").some((x) => x.text.includes("没发出去")) && msgsTo("oc_x_boom").length > 0 && !!asked.inbound
        && fcalls.some((x) => x.kind === "put" && x.tag === "没做成"));
      await sleep(700); // IM 日志攒 500ms 落一次盘
      const sendMsg = msgsTo("oc_x_send").find((x) => x.text.includes("没发出去"));
      ok("⑭e 飞书发附件失败：那句话里有相对名和错误码、没有绝对路径", !!sendMsg && sendMsg.text.includes("…/out/报告.pdf") && sendMsg.text.includes("EIO") && !leaks(sendMsg.text), sendMsg ? sendMsg.text : JSON.stringify(msgsTo("oc_x_send")));
      const boom = msgsTo("oc_x_boom").map((x) => x.text).join("\n");
      ok("⑭e 任务报错：回复里有错误码和相对名、没有绝对路径", boom.includes("任务执行出错") && boom.includes("ENOENT") && boom.includes("…/out/缺的.docx") && !leaks(boom), boom);
      const failCard = fcalls.find((x) => x.kind === "put" && x.tag === "没做成");
      ok("⑭e 任务报错：「没做成」卡片上也抹了", !!failCard && failCard.card.includes("…/out/缺的.docx") && !leaks(failCard.card), failCard && failCard.card.slice(0, 400));
      ok("⑭e 收附件没存下：交给 agent 转告的那段有文件名和错误码、没有绝对路径", (asked.inbound || "").includes("合同.pdf") && (asked.inbound || "").includes("EACCES") && !leaks(asked.inbound), asked.inbound);
      let log = [];
      try { log = JSON.parse(fs.readFileSync(dataPath("data", "im-log.json"), "utf8")); } catch {}
      ok("⑭e 本机日志照旧记原文（排查要用）", log.some((/** @type {any} */ e) => e.chat === "oc_x_boom" && e.dir === "error" && String(e.text).includes(WS5)), JSON.stringify(log.filter((/** @type {any} */ e) => e.chat === "oc_x_boom")));

      // ---- 其余三路收附件：QQ、企业微信/公众号、微信 iLink，落盘失败的原话都要先过 im.js 那道 ----
      const postRaw = (/** @type {string} */ p, /** @type {string} */ body) => new Promise((resolve, reject) => {
        const data = Buffer.from(body);
        const req = http.request({
          host: "127.0.0.1", port: server.address().port, path: p, method: "POST",
          headers: { "Content-Type": "text/xml", "Content-Length": data.length },
        }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
        req.on("error", reject);
        req.end(data);
      });
      await im.startQQ(true);
      ok("⑭e QQ 连上了假网关", qqSocks.length === 1 && qqSocks[0].url === "wss://qq.test/ws", JSON.stringify(qqSocks.map((s) => s.url)));
      await tools.withWorkspace(WS5, () => qqSocks[0].onmessage({ data: JSON.stringify({ op: 0, t: "C2C_MESSAGE_CREATE", s: 1, d: {
        id: "qqm1", content: "看看这份合同", author: { user_openid: "qqu1", username: "张三" },
        attachments: [{ url: "https://qq.test/f/1", filename: "合同.pdf", content_type: "application/pdf", size: 10 }],
      } }) }));
      const wxFile = (/** @type {string} */ from, /** @type {string} */ type, /** @type {string} */ mid, /** @type {string} */ id) =>
        `<xml><ToUserName><![CDATA[c1]]></ToUserName><FromUserName><![CDATA[${from}]]></FromUserName><CreateTime>1</CreateTime><MsgType><![CDATA[${type}]]></MsgType><MediaId><![CDATA[${mid}]]></MediaId><FileName><![CDATA[合同.pdf]]></FileName><MsgId>${id}</MsgId></xml>`;
      const enc = encryptMsg(AES, wxFile("zhangsan", "file", "mid1", "w1"), "c1");
      const wcCode = await postRaw(`/im/wecom/events?msg_signature=${msgSignature("wtok", "1", "n1", enc)}&timestamp=1&nonce=n1`, `<xml><Encrypt><![CDATA[${enc}]]></Encrypt></xml>`);
      const mpCode = await postRaw("/im/mp/events", wxFile("openid1", "file", "mid2", "p1"));
      ok("⑭e 企业微信/公众号回调收下了", wcCode === 200 && mpCode === 200, `${wcCode} ${mpCode}`);
      await tools.withWorkspace(WS5, () => im.startIlink(true));
      await waitFor(() => !!(asked.qq && asked.wecom && asked.mp && asked.ilink), 5000);
      for (const [ch, nm] of /** @type {const} */ ([["qq", "QQ"], ["wecom", "企业微信"], ["mp", "公众号"], ["ilink", "微信 iLink"]])) {
        const q = asked[ch] || "";
        ok(`⑭e ${nm}收附件没存下：转告那段是工作目录下的相对名、有错误码、没有绝对路径`, q.includes("合同.pdf") && q.includes("EACCES") && q.includes("…/收到的附件/合同.pdf") && !leaks(q), q || JSON.stringify(Object.keys(asked)));
      }
      await new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port: server.address().port, path: "/im/wechat/disconnect", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": 2 } },
          (res) => { res.resume(); res.on("end", resolve); });
        req.on("error", reject);
        req.end("{}");
      });
      ok("⑭e 没碰没见过的地址", !fcalls.some((x) => x.kind === "unknown"), JSON.stringify(fcalls.filter((x) => x.kind === "unknown")));
    } finally {
      global.fetch = realFetch;
      IM.fetchBuffer = savedIM.fetchBuffer;
      IM.saveInbound = savedIM.saveInbound;
      IM.downloadWechatCdn = savedIM.downloadWechatCdn;
      /** @type {any} */ (globalThis).WebSocket = realWS;
      if (server) await new Promise((res) => server.close(() => res()));
    }
  }

  // ════ 15. 本机真 ffmpeg（没有就跳过） ════
  {
    const MP = require(path.join(ROOT, "lib", "media-probe"));
    const mb = await MP.resolveMediaBins();
    const hasFf = !!(mb.ffmpeg.bin && mb.ffprobe.bin);
    if (!hasFf) {
      if (process.env.OWB_REQUIRE_FFMPEG === "1") ok("OWB_REQUIRE_FFMPEG=1：这台机器必须有 ffmpeg / ffprobe", false, mb.ffmpeg.why || mb.ffprobe.why);
      else console.log("  跳过：本机没有 ffmpeg");
    } else {
      const RD = path.join(TMP, "real");
      fs.mkdirSync(RD);
      const run = (bin, args) => MP.runBin(bin, args, { timeout: 120000, what: path.basename(bin) });
      const src = path.join(WS, "out", "real.mp4");
      await run(mb.ffmpeg.bin, ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=1920x1080:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
        "-t", "4", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", src]);
      const probe = async (f) => M.parseProbe((await run(mb.ffprobe.bin, M.probeArgv(f))).stdout);
      const p0 = await probe(src);
      ok("真跑：原片量出来 1920×1080、约 4 秒、有音轨", p0 && p0.w === 1920 && p0.h === 1080 && Math.abs(p0.dur - 4) < 0.2 && p0.hasAudio, JSON.stringify(p0));

      const jpg = path.join(RD, "c.jpg");
      await run(mb.ffmpeg.bin, M.coverArgv({ src, out: jpg, dur: p0.dur, w: p0.w, h: p0.h }));
      const head = fs.existsSync(jpg) ? fs.readFileSync(jpg).subarray(0, 3).toString("hex") : "";
      ok("真跑：封面是 JPEG", head === "ffd8ff", head);

      const target = 1 * MB;
      const dims = M.previewDims(p0.w, p0.h);
      const br = M.previewBitrate(p0.dur, target, 96);
      const prev = path.join(RD, "p.mp4");
      await run(mb.ffmpeg.bin, M.previewArgv({ src, out: prev, dims, vKbps: br.vKbps, hasAudio: true }));
      const p1 = await probe(prev);
      const sz = fs.statSync(prev).size;
      ok("真跑：预览 1280×720、带音轨", p1 && p1.w === 1280 && p1.h === 720 && p1.hasAudio, JSON.stringify(p1));
      ok("真跑：预览体积 ≤ 目标×1.1", sz <= target * 1.1, sz);
      const mv = fs.readFileSync(prev);
      ok("真跑：faststart（moov 在 mdat 前）", mv.indexOf("moov") > 0 && mv.indexOf("moov") < mv.indexOf("mdat"));

      // 手机式竖拍：画面存成横的 1600×900 + 转 90°。-display_rotation 是输入端选项（ffmpeg 7+），
      // 老版本没有就退到 rotate 标签——两种 ffprobe 都会报，parseProbe 两种都认
      const flat = path.join(RD, "flat.mp4"), rot = path.join(RD, "rot.mp4");
      await run(mb.ffmpeg.bin, ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=1600x900:rate=25", "-t", "2",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", flat]);
      await run(mb.ffmpeg.bin, ["-nostdin", "-v", "error", "-y", "-display_rotation", "90", "-i", flat, "-c", "copy", rot])
        .catch(() => run(mb.ffmpeg.bin, ["-nostdin", "-v", "error", "-y", "-i", flat, "-c", "copy", "-metadata:s:v:0", "rotate=90", rot]));
      const pr = await probe(rot);
      ok("真跑：转 90° 的竖拍量出来 900×1600（转过之后）", pr && pr.w === 900 && pr.h === 1600, JSON.stringify(pr));
      const sar = async (f) => {
        const j = JSON.parse((await run(mb.ffprobe.bin, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,sample_aspect_ratio", "-of", "json", f])).stdout);
        const st = (j.streams || [])[0] || {};
        return { w: st.width, h: st.height, sar: st.sample_aspect_ratio || "" };
      };
      const square = (x) => !x.sar || x.sar === "1:1" || x.sar === "0:1" || x.sar === "N/A";
      const rjpg = path.join(RD, "rc.jpg");
      await run(mb.ffmpeg.bin, M.coverArgv({ src: rot, out: rjpg, dur: pr.dur, w: pr.w, h: pr.h }));
      const rc = await sar(rjpg);
      ok("真跑：竖拍的封面是竖的 720×1280、没被压扁", rc.w === 720 && rc.h === 1280 && square(rc), JSON.stringify(rc));
      const rprev = path.join(RD, "rp.mp4");
      await run(mb.ffmpeg.bin, M.previewArgv({ src: rot, out: rprev, dims: M.previewDims(pr.w, pr.h), vKbps: 400, hasAudio: pr.hasAudio, vindex: pr.vindex }));
      const rp = await sar(rprev);
      ok("真跑：竖拍的预览是 720×1280、像素是方的", rp.w === 720 && rp.h === 1280 && square(rp), JSON.stringify(rp));

      // 整条链路：真 ffprobe / ffmpeg + 假飞书
      const f = fakeFeishu();
      try {
        const x = sender(M.defaultFeishuBins());
        const r = await x.s.sendFile("oc_real", "out/real.mp4");
        const [img] = f.images(), [file] = f.files();
        ok("真跑整链：封面真是 JPEG、按 media 发", r.route === "media" && img && img.fields.image.head === "ffd8ff" && f.msgs()[0].msg_type === "media" && !!f.msgs()[0].content.image_key);
        ok("真跑整链：时长约 4000ms", file && Math.abs(Number(file.fields.duration) - 4000) < 200, file && file.fields.duration);
        const srcSize = fs.statSync(src).size;
        // 把「上限」压到原片以下，逼它走预览；预览目标给原片一半，码率下限放开（只为这 4 秒测试片）
        const y = sender(M.defaultFeishuBins(), { limits: { FILE_MAX: srcSize - 1, PREVIEW_TARGET: Math.floor(srcSize / 2), MIN_VKBPS: 50 } });
        const r2 = await y.s.sendFile("oc_real", "out/real.mp4");
        const pf = f.files()[1];
        ok("真跑整链：超限走预览、传上去的比上限小、文件名是原片名", r2.route === "media-preview" && r2.sent && pf && pf.fields.file.size < srcSize && pf.fields.file_name === "real.mp4", JSON.stringify(r2));
        ok("真跑整链：说明里是相对路径", y.notes.length === 1 && y.notes[0].text.includes("out/real.mp4") && !y.notes[0].text.includes(WS));
        ok("真跑整链：临时目录删干净了", leftovers().length === 0, leftovers());
      } finally { f.restore(); }
    }
  }
})().catch((e) => {
  bad.push("意外异常");
  console.log("  ✗ 意外异常：" + (e && e.stack || e));
}).finally(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  // 断言条数钉死下限：中途哪段悄悄没跑，条数就对不上（没 ffmpeg 跳过真跑那段时正好 235 条，有就是 248）
  const MIN = 235;
  if (!bad.length && n < MIN) bad.push(`断言只跑了 ${n} 条（应 ≥ ${MIN}）`);
  if (bad.length) {
    console.log(`❌ 飞书发附件：${bad.length} 条没过（过了 ${n} 条）`);
    for (const b of bad) console.log("  - " + b);
    process.exit(1);
  }
  console.log(`✅ 飞书发附件：${n} 条断言全过（mp4 带封面按 media 发、超 30MB 先发 720p 预览并说原片在哪、发送超时不重发、没 ffmpeg 按文件发）`);
  process.exit(0);
});
