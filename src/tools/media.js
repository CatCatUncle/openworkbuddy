"use strict";
/**
 * 媒体那几样：生图 / 生视频 / 配音 / 转写 / 看图 / HTML 截图，外加花钱那三样的生成结果缓存和计量。
 *
 * 从 tools.js 整段搬过来的，函数体一个字没动，只改了几处懒加载 require 的相对路径。
 * tools.js 还是门面：module.exports 和 _internals 的键跟拆之前一个不差，调用方照旧 require("./tools")。
 *
 * 工作目录那套 AsyncLocalStorage 还留在 tools.js（租户隔离就靠它，二十来处在读）。
 * 这里要用的 ws() / ensureDirs() 由 tools.js 加载时经 bindWorkspace 递过来，
 * 不反过来 require("../../tools")：两边互相 require 时先加载的那个拿到的是半截 exports，
 * 而 tools.js 末尾是整个换掉 module.exports，半截那份永远是个空对象。
 */

const fs = require("fs");
const path = require("path");
const security = require("../../security");
const mediaModels = require("../../media-models"); // 图/视频/语音/视觉的多模型选择（同一把 Key 配多个型号）
const genCache = require("../../gen-cache"); // 生图/生视频/配音的内容寻址缓存：同一格重跑不再烧第二次钱
const quota = require("../../quota"); // 按次计费的第三方 API：调之前问一句额度，调完记一笔

// 工作目录根和「目录建好没」，都是 tools.js 那边的；没接上就直接报错，不猜一个默认目录往里写
let wsRoot = null;
let ensureRoot = null;
function bindWorkspace(root, ensure) {
  wsRoot = root;
  ensureRoot = ensure;
}
function ws() {
  if (!wsRoot) throw new Error("src/tools/media.js 还没接上工作目录，要经 tools.js 加载");
  return wsRoot();
}
function ensureDirs() {
  if (!ensureRoot) throw new Error("src/tools/media.js 还没接上工作目录，要经 tools.js 加载");
  ensureRoot();
}

// ---------- 图像 / 视频 生成（渠道协议：OpenAI 兼容 images API、DashScope 原生、火山方舟异步任务） ----------

/**
 * 同一类产出里「也认」的后缀。
 *
 * 以前只认默认那一个：模型要 fig_a.jpg，落盘成了 fig_a.jpg.png——
 * 接着它按自己要的名字写 <img src="fig_a.jpg">，一整页图全是裂的。
 * 七张图里它自己手工补救了一张，剩下六张就那么裂着。
 *
 * 所以同类后缀一律照模型要的来。PNG 的字节叫 .jpg 没关系——<img> 是嗅探内容解码的，
 * 照样渲染得出来；**名字对不上**才是真的打不开。跨类的（要 .jpg 却给 .txt）还是照旧补后缀。
 */
const OUT_EXT_ALIAS = {
  ".png": [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"],
  ".mp4": [".mp4", ".mov", ".webm", ".m4v"],
  ".mp3": [".mp3", ".m4a", ".aac", ".ogg", ".opus", ".flac", ".wav"],
  ".wav": [".wav", ".mp3", ".m4a", ".aac", ".ogg", ".opus", ".flac"],
};
/**
 * 兜底文件名用的时间戳，同一毫秒里绝不发第二次同样的数。
 *
 * 生图 / 生视频 / 配音的 filename 都是可选的，不给就按 `image_时间戳.png` 兜底。
 * 以前这三个工具是一条条串行跑的，Date.now() 天然错不开；现在同一批里能并发两条，
 * 两张图在同一毫秒返回就会写同一个文件名——后写的把先写的盖掉，而界面上两张卡都报成功，
 * 这种错不留任何痕迹。所以撞上同一毫秒就往后缀上接 _2、_3。
 *
 * 注意这只管「模型没起名」那一路。模型点名要某个文件名时照旧覆盖：那是它自己要的，
 * 「重新生成刚才那张」正是靠覆盖实现的，替它改名反而会让正文里的引用全指空。
 */
let lastStamp = 0, stampDup = 0;
function stampOnce() {
  const t = Date.now();
  if (t === lastStamp) stampDup++;
  else {
    lastStamp = t;
    stampDup = 0;
  }
  return stampDup ? `${t}_${stampDup + 1}` : String(t);
}

function safeOutName(name, ext, stem) {
  let n = String(name || "").trim().replace(/[\/\\:*?"<>|]/g, "_").slice(0, 80);
  if (!n) n = `${stem}_${stampOnce()}${ext}`;
  const ok = OUT_EXT_ALIAS[ext] || [ext];
  const low = n.toLowerCase();
  if (!ok.some((e) => low.endsWith(e))) n += ext;
  return n;
}

/**
 * 只重试「重来一次可能就好」的失败：5xx、429、以及网络层的连接错误。
 * 4xx 是参数错、没余额、内容被拒——重试多少次都是同一个答案，立刻返回。
 * 超时（AbortError）也不重试：那是上面设的总时限已经到了，再发一次只会立刻再失败。
 */
const retryableStatus = (s) => s === 429 || (s >= 500 && s < 600);

/**
 * 几路信号合成一路，任何一路断了它就断，reason 照搬断掉的那一路。
 * engines 写的是 node >=18，AbortSignal.any 要 20.3 才有，只能手写。
 *
 * 用完要 release()：挂在「停止」信号上的监听不摘，一个任务里生成几十次就挂几十个，
 * Node 过 10 个就刷 MaxListenersExceededWarning，任务结束前也一直攥着这些闭包。
 * 断过一次之后自己就摘干净了，release 再调也无妨。
 */
function anySignal(...signals) {
  const list = [...new Set(signals.flat().filter(Boolean))];
  const ctl = new AbortController();
  const offs = [];
  const release = () => { while (offs.length) offs.pop()(); };
  const hit = list.find((s) => s.aborted);
  if (hit) ctl.abort(hit.reason);
  else {
    for (const s of list) {
      const on = () => { release(); ctl.abort(s.reason); };
      s.addEventListener("abort", on, { once: true });
      offs.push(() => s.removeEventListener("abort", on));
    }
  }
  ctl.signal.release = release;
  return ctl.signal;
}

/** 在「停止」和一个时限之间取先到的那个跑 fn(signal)，跑完摘监听 */
async function within(stop, ms, fn) {
  const signal = anySignal(stop, AbortSignal.timeout(ms));
  try { return await fn(signal); } finally { signal.release(); }
}

/** 能被停止打断的 sleep：停了立刻醒，由调用方接着判 aborted */
function sleepFor(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); if (signal) signal.removeEventListener("abort", done); resolve(); }
    if (signal) signal.addEventListener("abort", done, { once: true });
  });
}

/** 用户点了停止时抛的错。措辞里不带「超时 / 错误 NNN」：媒体健康表按这些字眼记故障，停止不算渠道的错 */
function stoppedError(what) {
  const e = new Error(`用户已停止任务${what ? `：${what}` : ""}`);
  e.stopped = true;
  return e;
}

async function fetchRetry(url, init, { tries = 3, baseMs = 1500, label = "接口" } = {}) {
  let lastErr = null;
  const signal = init && init.signal;
  for (let i = 0; i < tries; i++) {
    if (i) await sleepFor(baseMs * 2 ** (i - 1), signal);
    // 退避等待期间点了停止：不再发下一次
    if (signal && signal.aborted) throw signal.reason instanceof Error ? signal.reason : Object.assign(new Error("已停止"), { name: "AbortError" });
    try {
      const r = await fetch(url, init);
      if (r.ok || !retryableStatus(r.status) || i === tries - 1) return r; // 最后一次把真实响应还回去，错误信息照旧完整
      console.warn(`[tools] ${label} 返回 ${r.status}，${baseMs * 2 ** i}ms 后重试（第 ${i + 2}/${tries} 次）`);
      lastErr = new Error(`HTTP ${r.status}`);
    } catch (e) {
      if (e.name === "AbortError" || i === tries - 1) throw e;
      console.warn(`[tools] ${label} ${e.message}，重试（第 ${i + 2}/${tries} 次）`);
      lastErr = e;
    }
  }
  throw lastErr;
}

// 图/声/视这四路和对话模型共用同一张渠道表（见 docs/模型与Key管理_调研与改法.md），
// 所以同一个 Key 会被两边拿去用。以前对话那边过 cleanKey，这边只 trim()：
// 从网页上复制 Key 时多框进一个中文字或全角引号，对话会明说「第几个字符不对、去哪儿重贴」，
// 生图却在 undici 里炸成一句 "Cannot convert argument to a ByteString"，同一个毛病两副面孔。
// 这里改成共用一份判断，措辞也就一致了。
function mediaKey(cfg) {
  return require("../../llm").cleanKey((cfg || {}).api_key, cfg);
}

async function downloadToWorkspace(url, fname, dir, stop) {
  // 图/视频已经生成完、钱也花掉了，栽在最后一步下载上最不值——这一步尤其该重试
  // 但用户点了停止就不下了：停止的意思是「这一步的产物我不要了」，落半截文件还会被当成成品复用
  const buf = await within(stop, 180000, async (signal) => {
    const r = await fetchRetry(url, { signal }, { label: "下载生成结果" });
    if (!r.ok) throw new Error(`下载生成结果失败 HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  });
  if (stop && stop.aborted) throw stoppedError("生成结果没有落盘。");
  ensureDirs();
  fs.writeFileSync(path.join(dir || ws(), fname), buf);
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i;

const IMAGE_MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", bmp: "image/bmp" };

/**
 * 大图先缩到长边 1568（视觉模型再大也看不出更多东西，只是更贵更慢，还容易撞上游的体积上限）。
 * 用 Electron 自带的 nativeImage，不引任何图像库；跑在纯 node 里（测试、CLI）时缩不动就原样发。
 */
function shrinkForVision(abs) {
  const raw = fs.readFileSync(abs);
  const ext = (abs.split(".").pop() || "png").toLowerCase();
  const mime = IMAGE_MIME[ext] || "image/png";
  const asis = { b64: raw.toString("base64"), mime, note: "" };
  if (raw.length <= 900 * 1024) return asis;
  try {
    const { nativeImage } = require("electron");
    let img = nativeImage.createFromPath(abs);
    if (img.isEmpty()) return asis;
    const sz = img.getSize();
    if (Math.max(sz.width, sz.height) > 1568) {
      img = img.resize(sz.width >= sz.height ? { width: 1568, quality: "good" } : { height: 1568, quality: "good" });
    }
    const jpg = img.toJPEG(82);
    if (!jpg || !jpg.length || jpg.length >= raw.length) return asis;
    return { b64: jpg.toString("base64"), mime: "image/jpeg", note: `（原图 ${sz.width}×${sz.height}、${Math.round(raw.length / 1024)}KB，压缩后再看的）` };
  } catch {
    return asis;
  }
}

/**
 * 把工作空间里的一张图读成能直接塞进请求体的 base64。
 *
 * 三条路要用它：看图（look_at_image）、生图喂参考图、生视频定首尾帧。为什么非得是同一份——
 * 这三条路能失败的地方一模一样：路径打错、指到了目录、指到了 .txt、图大到上游收不下。
 * 各写各的话，同一个错在三个地方会有三种说法，模型学不会，只能挨个试过去。
 *
 * 返回 { err }（一整句可以原样发给模型的话）或 { b64, mime, note, abs }。
 */
function readImageInput(rel, resolveFile, what) {
  const s = String(rel == null ? "" : rel).trim();
  if (!s) return { err: `缺少${what}的路径（工作空间里的相对路径，先 list_files 看看真实文件名）` };
  let p;
  try { p = resolveFile(s); } catch (e) { return { err: e.message }; }
  if (!fs.existsSync(p)) return { err: `找不到${what} ${s}。用户上传的图在工作空间里，先 list_files 看看真实文件名。` };
  if (fs.statSync(p).isDirectory()) return { err: `${s} 是个目录，不是图片。` };
  if (!IMAGE_EXT.test(p)) return { err: `${s} 不是图片（支持 png / jpg / webp / gif / bmp）。文本文件用 read_file。` };
  const { b64, mime, note } = shrinkForVision(p);
  if (b64.length > 12 * 1048576) {
    return { err: `${path.basename(p)} 太大了（编码后约 ${Math.round(b64.length / 1048576)}MB），上游收不下。先缩小再用。` };
  }
  return { b64, mime, note, abs: p };
}

/** 图当输入时统一的 data: URI 写法，三条路共用一份，省得有的带前缀有的不带 */
function imageDataUri(got) {
  return `data:${got.mime};base64,${got.b64}`;
}

/** 一条渠道算不算配齐了：地址和型号都有才算，缺一个都发不出请求 */
const eyeReady = (c) => !!(c && String(c.base_url || "").trim() && String(c.model || "").trim());

/**
 * 主模型自己会不会看图。
 *
 * 先听配置里那张 caps 表——那是设置页上「能看图」那个勾，用户自己说的，比任何猜法都准；
 * 老配置没有 caps 才退回按型号名猜（口径跟设置页下拉分组共用 capOfModel 那一份）。
 */
function mainCanSee(main) {
  const caps = Array.isArray(main && main.caps) ? main.caps : null;
  if (caps) return caps.includes("vision");
  return mediaModels.capOfModel(String((main || {}).model || "")).cap === "vision";
}

/**
 * 这张图交给谁看：主模型，还是「看图」那一路单配的模型。
 *
 * 规矩就是设置页上一直写着的那句话：**单配的看图模型，是给「主模型看不了图」的人预备的。**
 * 代码以前不是这么走的——那个槽里只要填了东西，就一律绕开主模型。于是真实配置里出现了这一幕：
 * 主模型和看图槽填的是同一个型号，同一个模型被硬拆成两条渠道走，多一把 key、多一份限流额度；
 * 那条一路 429 和超时，主模型这边一次就过。用户的原话是
 * 「文本模型我用多模态模型就没有必要用什么看图模型」。
 *
 * 也没把谁的配置吃掉：主模型当场回一句「我看不了图」时，backup 那条会自动接上（见下面 400 那段）。
 *
 * @returns {{cfg:object, backup:object|null, tell:string}}
 *   cfg 这次用谁；backup 主模型当场说看不了图时改投的那条；tell 要不要在答案末尾交代一句
 */
function pickEye(v, main, named) {
  const has = eyeReady(v), hasMain = eyeReady(main);
  // look_at_image(model: "…") 点了名的一律照办：点名要哪个就是哪个
  if (named && has) return { cfg: v, backup: null, tell: "", fromMain: false };
  if (!hasMain) return { cfg: has ? v : {}, backup: null, tell: "", fromMain: false };
  if (!has) return { cfg: main, backup: null, tell: "", fromMain: true };
  // 同一个型号还分两条渠道走，白白多一把 key、多一份限流额度
  if (String(v.model).trim().toLowerCase() === String(main.model).trim().toLowerCase()) {
    return { cfg: main, backup: null, tell: "", fromMain: true };
  }
  if (mainCanSee(main)) {
    // 绕过了用户单配的那条，就得说一声——不说的话，他在设置里配的模型等于凭空没了
    return { cfg: main, backup: v, tell: `\n（主模型 ${main.model} 自己会看图，就没绕到单配的 ${v.model}）`, fromMain: true };
  }
  return { cfg: v, backup: null, tell: "", fromMain: false };
}

/**
 * 带着一个问题去看一张图，返回文字答案。
 *
 * 为什么是「工具」而不是把图塞进对话历史：历史是每一步都要整份重发的，图又是 token 大户，
 * 一张截图能把刚做完的上下文成本优化整个推翻；而且多数纯文本模型收到图直接 400，
 * 会话是落盘的，于是那个会话就永久废了。走工具这条路，进历史的只有一段纯文本答案——
 * 便宜、能命中缓存、上下文紧张时还能被裁掉。
 */
async function lookAtImage(opts, input, timeoutMs, resolveFile, stop) {
  const rel = String(input.path || "").trim();
  const q = String(input.question || "").trim();
  if (!rel) return { content: "缺少 path（要看哪张图，工作空间里的相对路径）", isError: true };
  if (!q) return { content: "缺少 question：看图必须带着具体问题去问（「报错写的什么」「这页分几块」），空看一眼拿不回有用的东西。", isError: true };

  let v;
  try { v = mediaModels.pick(opts.media, "vision", input.model); } catch (e) { return { content: e.message, isError: true }; }
  const main = opts.visionFallback || {};
  const eye = pickEye(v, main, !!String(input.model || "").trim());
  if (!eyeReady(eye.cfg)) {
    return { content: "没有能看图的模型：请用户去 设置 → 模型 → 视觉模型 填接口地址 / API Key / 模型名。这一步不用重试。", isError: true };
  }

  const got = readImageInput(rel, resolveFile, "图片");
  if (got.err) return { content: got.err, isError: true };
  const { b64, mime, note, abs: p } = got;
  const signal = anySignal(stop, AbortSignal.timeout(Math.max(timeoutMs || 0, 120000)));

  /** 拿某一条渠道去看一遍。两条渠道共用这一份，措辞和重试口径不会漂开 */
  async function look(cfg, tell, backup, fromMain) {
    const base = String(cfg.base_url).trim().replace(/\/+$/, "");
    const anthropic = cfg.provider === "anthropic";
    // 地址算法跟主模型共用一份（llm.js 的 anthropicBase）。自己拼 `${base}/v1/messages` 的话，
    // 用户照着设置页里其它渠道的样子把 base_url 填成 .../v1，就会拼出 /v1/v1/messages 吃 404
    const url = anthropic ? require("../../llm").anthropicBase(base).messagesUrl : `${base}/chat/completions`;
    const key = mediaKey(cfg);
    const headers = anthropic
      ? { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }
      : { "Content-Type": "application/json", Authorization: `Bearer ${key}` };
    const mkBody = (maxTokens, extra) => (anthropic
      ? { model: cfg.model, max_tokens: maxTokens, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: mime, data: b64 } }, { type: "text", text: q }] }], ...extra }
      : { model: cfg.model, max_tokens: maxTokens, messages: [{ role: "user", content: [{ type: "text", text: q }, { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } }] }], ...extra });

    const ask = async (bodyObj) => {
      let r;
      try {
        r = await fetchRetry(url, { method: "POST", headers, signal, body: JSON.stringify(bodyObj) }, { label: "视觉模型" });
      } catch (e) {
        // 用户点的停止不是渠道故障：抛出去，别落成「请求失败」记进健康表
        if (stop && stop.aborted) throw stoppedError();
        return { fail: `视觉模型请求失败：${e.message}` };
      }
      const j = await r.json().catch(() => ({}));
      if (stop && stop.aborted) throw stoppedError();
      if (!r.ok) return { r, j, http: r.status };
      const ch = ((j.choices || [])[0] || {});
      const msg = ch.message || {};
      let text = anthropic
        ? (j.content || []).map((c) => (c && c.type === "text" ? c.text : "")).join("")
        : msg.content;
      if (Array.isArray(text)) text = text.map((c) => (typeof c === "string" ? c : (c || {}).text || "")).join("");
      // 「想了一堆但一个字没说」跟「被内容策略拦了」是两回事，得分得开
      const reasoned = anthropic
        ? (j.content || []).some((c) => c && (c.type === "thinking" || c.type === "redacted_thinking"))
        : !!String(msg.reasoning_content || msg.reasoning || "").trim();
      const capped = anthropic ? j.stop_reason === "max_tokens" : ch.finish_reason === "length";
      return { r, j, text: String(text || "").trim(), reasoned, capped };
    };

    let out = await ask(mkBody(2000));
    if (out.fail) return { content: out.fail, isError: true };
    if (out.http) {
      const msg = JSON.stringify(out.j).slice(0, 300);
      // 上游直说「不支持图片」：换个问法重试多少次都是同一个 400，只会白烧几轮。
      // 后面还有一条能看图的渠道就改投它，一条都没有才把「去配一个」这句话讲清楚。
      if (/image|vision|multimodal|不支持/i.test(msg)) {
        if (eyeReady(backup)) return { refused: true, msg };
        // 单配的看图渠道自己报这句，那是这条渠道配错了（型号填成出图的、地址串了家），
        // 不是「还没配」。再劝他去配一遍等于让人对着已经填好的表单发呆，所以只对主模型说这句
        if (fromMain) return {
          content: `当前主模型（${cfg.model}）看不了图：${msg}\n请用户去 设置 → 模型 → 视觉模型 配一个能看图的模型，配好后再调一次。不要重试，也别改用别的工具去猜图里是什么。`,
          isError: true,
        };
      }
      if (out.http === 402 || /insufficient|credit|余额|欠费/i.test(msg)) {
        return { content: `视觉模型这条渠道没余额了（HTTP ${out.http}）：${msg}\n这不是问法的问题，重试多少次都一样。请用户去充值，或在 设置 → 模型 → 视觉模型 换一条渠道。别再调 look_at_image 了，也不许把没看到的内容当看过写进结论。`, isError: true };
      }
      return { content: `视觉模型错误 ${out.http}: ${msg}`, isError: true };
    }

    // 空正文最常见的真因不是内容策略，而是**思考把额度吃光了**：
    // GLM / OpenRouter 这类默认开思考的渠道，2000 的上限先被 reasoning 花完，
    // content 就是个空字符串，finish_reason=length。真实会话里这一种出现了 40 次，
    // 模型看到「换个问法再试一次」就一轮轮换措辞重试，最后干脆编一句「已核对」——
    // 明明一眼没看见。所以这里自己关掉思考重来一次，再空才算真空。
    if (!out.text && (out.capped || out.reasoned)) {
      const off = require("../../thinking").planFor(cfg, "off");
      const retry = await ask(mkBody(4000, { ...off.params, ...(cfg.extra_body || {}) }));
      if (!retry.fail && !retry.http && retry.text) {
        return { content: `【看图】${path.basename(p)}${note}\n问：${q}\n答：${retry.text}\n（第一次它把 ${2000} token 全花在思考上没留下正文，已自动关思考重看一次）${tell}`, isError: false };
      }
      if (!retry.fail && !retry.http) out = retry;
    }

    if (!out.text) {
      const why = out.capped || out.reasoned
        ? `${cfg.model} 把额度全花在思考上、一个字正文都没吐（关掉思考重试过一次，还是这样）`
        : `${cfg.model} 返回了空正文（多半被内容策略拦了）`;
      return {
        content: `没看成这张图：${why}。\n别再换问法重试了——换措辞改不了这件事。如实说这张图没看成，`
          + `或者换一条视觉渠道（设置 → 模型 → 视觉模型）。\n注意：绝对不许把没看到的内容当作看过写进结论或说明文档里。`,
        isError: true,
      };
    }
    return { content: `【看图】${path.basename(p)}${note}\n问：${q}\n答：${out.text}${tell}`, isError: false };
  }

  try {
    const first = await look(eye.cfg, eye.tell, eye.backup, eye.fromMain);
    if (!first.refused) return first;
    // 主模型当场说它看不了图（多半是 caps 那个勾勾错了）：单配的那条顶上，别让这张图白丢
    return await look(eye.backup, `\n（主模型 ${eye.cfg.model} 回了一句看不了图，已改用单配的 ${eye.backup.model}；想省这一次空跑，去 设置 → 模型 把它的「能看图」取消勾选）`, null, false);
  } finally { signal.release(); }
}

/**
 * 产物落点的真实相对路径。回执只报个光秃秃的文件名等于骗模型：成果其实在本对话的
 * 成果子目录里，模型照回执去工作空间根目录找，找不到就 `cp` 一份过去"修好"这个不一致——
 * 于是同一张图在文件面板里出现两遍。真实会话 s_1787740619097 里就这么复制了 6 个文件，
 * 每个还白烧一轮 ls + 一轮 find。提示词里写"别 cp 到根目录"拦不住，因为模型不是想复制，
 * 是真找不到；把落点说准，它就没有复制的理由了。
 */
function savedAt(saveDir, fname) {
  const rel = path.relative(ws(), saveDir || ws());
  return rel && !rel.startsWith("..") ? `${rel}/${fname}` : fname;
}

/**
 * 发一个「要干净图」的请求：默认带上 watermark: false。
 *
 * 国内几家默认往右下角烙一枚「AI 生成」——火山方舟 doubao-seedream 系的 watermark
 * 默认就是 true。用户拿到的是要直接拿去用的成品，不是 demo，带水印等于白生成一次。
 *
 * 麻烦在这个字段不通用：OpenAI 官方 /images/generations 见到不认识的字段直接 400
 * （Unrecognized request argument supplied），而聚合网关（new-api 之类）主机名千奇百怪，
 * 靠 base_url 猜是哪一家一定会猜漏，漏掉的恰好就是用户真在用的那个。
 * 所以策略是反过来的：先按「要干净图」发，只有对面明确说「我不认识这个字段」才去掉重发一次。
 *
 * 关键是退让必须留痕。静默退回去，用户下次又拿到带水印的图，还是查不出原因——
 * 这个默认值被漏掉过一次，代价就是用户手里所有生成图都白做了。
 */
async function postWantClean(url, headers, signal, buildBody, label, tries) {
  const send = (wm) => fetchRetry(url, { method: "POST", headers, signal, body: JSON.stringify(buildBody(wm)) }, { label, ...(tries ? { tries } : {}) });
  const r = await send(true);
  if (r.ok) return { r, j: await r.json().catch(() => ({})), stripped: false };
  const raw = await r.text().catch(() => "");
  // 只在「这个字段我不认识」时退让。余额不足、鉴权失败、内容被拦这些照原样报错，
  // 别一律当成参数问题吞掉——那会把真正的错因藏起来
  const unknownField = r.status === 400 && /watermark|unrecognized|unknown|unsupported|not\s+support|invalid[^"]{0,20}(param|argument|field)/i.test(raw);
  if (!unknownField) {
    let j = {}; try { j = JSON.parse(raw); } catch { j = { error: raw.slice(0, 300) }; }
    return { r, j, stripped: false };
  }
  const r2 = await send(false);
  return { r: r2, j: await r2.json().catch(() => ({})), stripped: true };
}

/** 一次最多喂几张参考图。再多上游多半也只看前几张，白掏 token 还把请求体撑爆 */
const MAX_REF_IMAGES = 4;

/**
 * 把 reference_images 一路读成 data: URI。
 * 允许传一个字符串（模型真会这么写），统一当成一张图处理，不为这个多报一条格式错。
 * 返回 { err } 或 { uris }。
 */
function refImageUris(v, resolveFile) {
  const list = v == null || v === "" ? [] : Array.isArray(v) ? v : [v];
  if (!list.length) return { uris: [] };
  if (typeof resolveFile !== "function") return { err: "这个环境下生图喂不了参考图（当前调用没有文件解析器）。去掉 reference_images 就是纯文生图。" };
  if (list.length > MAX_REF_IMAGES) return { err: `参考图最多 ${MAX_REF_IMAGES} 张，这次给了 ${list.length} 张。挑最能说明问题的几张。` };
  const uris = [];
  for (const rel of list) {
    const got = readImageInput(rel, resolveFile, "参考图");
    if (got.err) return { err: got.err };
    uris.push(imageDataUri(got));
  }
  return { uris };
}

/**
 * 型号是「图生视频」还是「文生视频」，只能按名字认——各家 /models 返回的就只有个 id。
 * 钉在分隔符上，别让随便哪个型号名里蹭上三个字母就被误判（跟 media-models.js 里 asr 那条同一个教训）。
 */
const I2V_RE = /(^|[-_/.])(i2v|kf2v|s2v|image-?to-?video|img-?2-?video)([-_/.\d]|$)/i;
const T2V_RE = /(^|[-_/.])(t2v|text-?to-?video)([-_/.\d]|$)/i;

async function generateImage(media, input, timeoutMs, saveDir, resolveFile, stop) {
  let cfg;
  try { cfg = mediaModels.pick(media, "image", input.model); } catch (e) { return { content: e.message, isError: true }; }
  if (!cfg.base_url || !cfg.model) {
    return { content: "图像模型未配置：请在 设置 → 模型 → 图像模型 填写接口地址 / API Key / 模型名后再用。", isError: true };
  }
  const prompt = String(input.prompt || "").trim();
  if (!prompt) return { content: "缺少 prompt（画面描述）", isError: true };
  const ref = refImageUris(input.reference_images, resolveFile);
  if (ref.err) return { content: ref.err, isError: true };
  const refs = ref.uris;
  // 渠道不认参考图时，宁可把这一趟报废掉，也不能偷偷退回纯文生：
  // 那样出来的图跟参考图毫无关系，模型却会当成「已经保持一致了」交上去，错得不留痕迹。
  const refFailHint = refs.length
    ? `\n（这次带了 ${refs.length} 张参考图。报错要是指向 image 字段或「不认识的参数」，就是这条渠道的生图接口不收参考图——`
      + "换一个支持图生图的模型或渠道（设置 → 模型 → 图像模型）。这里不会自动退回纯文生图。）"
    : "";
  const base = String(cfg.base_url).trim().replace(/\/+$/, "");
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${mediaKey(cfg)}` };
  // stop 是调用方按这一次调用合出来的（executeToolCore 的 withStop），调用结束它整个作废，
  // 这里挂上去的监听不用另摘
  const signal = anySignal(stop, AbortSignal.timeout(Math.max(timeoutMs || 0, 300000)));
  const fname = safeOutName(input.filename, ".png", "image");
  let imgUrl = null, b64 = null, watermarked = false;
  if (/dashscope/i.test(base)) {
    // DashScope 原生（qwen-image 系）：multimodal-generation，同步返回图片 URL
    // 生图慢又贵，上游一抖整轮就白跑：真实数据里 15 次调用失败 9 次，其中 8 次是
    // 上游 500 InternalServiceError，纯属临时故障。模型拿到失败通常不会重来，而是
    // 改用别的方案交差，用户就永远拿不到那张图。所以重试这件事得工具自己扛。
    const { r, j, stripped } = await postWantClean(`${base}/services/aigc/multimodal-generation/generation`, headers, signal,
      // 参考图排在文字前面：多模态这边约定俗成是「先看图，再读要求」，顺序反了有些模型会只当描述看
      (wm) => ({ model: cfg.model, input: { messages: [{ role: "user", content: [...refs.map((u) => ({ image: u })), { text: prompt }] }] }, parameters: wm ? { watermark: false } : {} }), "图像接口");
    watermarked = stripped;
    if (!r.ok) return { content: `图像接口错误 ${r.status}: ${JSON.stringify(j).slice(0, 300)}${refFailHint}`, isError: true };
    const parts = ((((j.output || {}).choices || [])[0] || {}).message || {}).content || [];
    imgUrl = (parts.find((c) => c.image) || {}).image;
    if (!imgUrl) return { content: "图像接口没有返回图片：" + JSON.stringify(j).slice(0, 300), isError: true };
  } else {
    // OpenAI 兼容 /images/generations（OpenAI、new-api 等聚合网关通用）
    const { r, j, stripped } = await postWantClean(`${base}/images/generations`, headers, signal,
      // 参考图走 image 字段（一张给字符串、多张给数组），仍然是这个 JSON 接口——
      // 不改走 multipart 的 /images/edits：那条路绕开了 postWantClean，水印退让就没人留痕了
      (wm) => ({ model: cfg.model, prompt, n: 1, ...(input.size ? { size: String(input.size) } : {}), ...(refs.length ? { image: refs.length === 1 ? refs[0] : refs } : {}), ...(wm ? { watermark: false } : {}) }), "图像接口");
    watermarked = stripped;
    if (!r.ok) return { content: `图像接口错误 ${r.status}: ${JSON.stringify(j).slice(0, 300)}${refFailHint}`, isError: true };
    const d = (j.data || [])[0] || {};
    imgUrl = d.url;
    b64 = d.b64_json;
    if (!imgUrl && !b64) return { content: "图像接口没有返回图片：" + JSON.stringify(j).slice(0, 300), isError: true };
  }
  if (b64) {
    if (stop && stop.aborted) throw stoppedError("图片没有落盘。");
    ensureDirs();
    fs.writeFileSync(path.join(saveDir || ws(), fname), Buffer.from(b64, "base64"));
  } else await downloadToWorkspace(imgUrl, fname, saveDir, stop);
  security.audit("图像生成", `${cfg.model}: ${prompt.slice(0, 120)}${refs.length ? `（参考图 ${refs.length} 张）` : ""} → ${fname}`, "放行");
  // 顺利那条也必须把水印状态说出来。只在出问题时报警、顺利时沉默，模型就无从判断，
  // 只能自己再花一轮 look_at_image 去找水印；真实会话里它找完还会另造一版「干净图」，
  // 白烧两轮加一个多余产物。把结论直接写进回执，它就不用查了。
  const wmNote = watermarked
    ? "\n注意：这个渠道不接受 watermark 参数，图上可能带平台的「AI 生成」水印。要干净的图就换个渠道或换个模型，别用截图裁掉——分辨率会掉。"
    : "\n已按无水印出图（渠道接受了 watermark=false），不用再开图找水印。";
  // 参考图到底有没有被这条渠道吃进去，回执里必须说一声。说了模型才知道
  // 「像不像」该拿谁去比；不说的话它只能再开一轮 look_at_image 自己对照。
  const refNote = refs.length ? `\n已带 ${refs.length} 张参考图出图；出来的东西像不像，以参考图为准。` : "";
  return { content: `图片已生成：${savedAt(saveDir, fname)}（工作空间内的相对路径，模型 ${cfg.model}）${refNote}${wmNote}`, isError: false, file: fname };
}

async function generateVideo(media, input, opts = {}) {
  let cfg;
  try { cfg = mediaModels.pick(media, "video", input.model); } catch (e) { return { content: e.message, isError: true }; }
  if (!cfg.base_url || !cfg.model) {
    return { content: "视频模型未配置：请在 设置 → 模型 → 视频模型 填写接口地址 / API Key / 模型名后再用。", isError: true };
  }
  const prompt = String(input.prompt || "").trim();
  if (!prompt) return { content: "缺少 prompt（视频内容描述）", isError: true };

  // 首尾帧。两道检查都放在发请求之前——视频是按条计费的异步任务，
  // 「型号只收图却只给了文字」这种错到上游才发现，钱已经掏了、还要等几分钟才看到失败。
  if (input.last_frame && !input.first_frame) {
    return { content: "只给了 last_frame：尾帧得跟首帧配着用，先有起点才谈得上「变到哪」。补上 first_frame，或者两个都别给。", isError: true };
  }
  let firstUri = null, lastUri = null;
  if (input.first_frame) {
    const fr = readImageInput(input.first_frame, opts.resolveFile, "首帧图");
    if (fr.err) return { content: typeof opts.resolveFile === "function" ? fr.err : "这个环境下生视频喂不了首尾帧（当前调用没有文件解析器）。去掉 first_frame 就是纯文生视频。", isError: true };
    firstUri = imageDataUri(fr);
    if (input.last_frame) {
      const lf = readImageInput(input.last_frame, opts.resolveFile, "尾帧图");
      if (lf.err) return { content: lf.err, isError: true };
      lastUri = imageDataUri(lf);
    }
  }
  // 型号和入参对不上，是眼下就能踩到的坑：媒体模型目录按名字认能力，i2v 型号一样被归到「视频模型」，
  // 用户在设置里选了它，今天不给图就调，必然在上游失败一次。这两句把那一趟省下来。
  if (!firstUri && I2V_RE.test(cfg.model)) {
    return { content: `${cfg.model} 是图生视频型号，必须给 first_frame（工作空间里的一张图）当首帧，只给文字它到上游就会失败，而那一趟是计费的。`
      + "要纯文字生视频，就在 设置 → 模型 → 视频模型 里换一个 t2v 型号。", isError: true };
  }
  if (firstUri && T2V_RE.test(cfg.model)) {
    return { content: `${cfg.model} 是文生视频型号，收不了首帧图。要用首尾帧就在 设置 → 模型 → 视频模型 里换一个 i2v 型号；`
      + "或者去掉 first_frame / last_frame，只用文字描述。", isError: true };
  }
  const kfHint = firstUri
    ? "\n（这次带了" + (lastUri ? "首尾帧" : "首帧") + "图。报错要是指向 img_url / image_url / 「不认识的参数」，就是这条渠道的视频接口不收图，换一个 i2v 型号或渠道。这里不会自动退回纯文生视频。）"
    : "";
  const base = String(cfg.base_url).trim().replace(/\/+$/, "");
  const auth = { Authorization: `Bearer ${mediaKey(cfg)}` };
  const headers = { "Content-Type": "application/json", ...auth };
  const proto = mediaModels.videoProtoOf(cfg);
  const protoCn = mediaModels.VIDEO_PROTO_CN[proto] || "这条渠道";
  // 尾帧只有万相 kf2v 和方舟收，另外三家的接口里根本没有这个字段。硬发过去是两种下场：
  // 被忽略——片子照出、钱照扣，人对着成片纳闷尾帧怎么没生效；或者整单报「不认识的参数」。
  // 都得等上几分钟才看得到，不如现在就说清。
  if (lastUri && proto !== "dashscope" && proto !== "ark") {
    return { content: `${protoCn} 的视频接口只收首帧，没有尾帧这一项。要首尾帧出片，到 设置 → 模型 → 视频模型 换成 通义万相 kf2v 或 火山方舟 Seedance；或者去掉 last_frame，只定首帧。`, isError: true };
  }
  // 时长 / 画幅 / 分辨率：按型号表夹紧之后的那一份（media-models.js 的 videoPlan）。
  // 预扣额度、记账用的也是它（unitsFor），三处口径一致。参数写坏了在这里就退回，不发请求、不花钱
  const plan = mediaModels.videoPlan(cfg, input, { firstFrame: !!firstUri });
  if (plan.err) return { content: plan.err, isError: true };
  const vs = plan.send;
  const fname = safeOutName(input.filename, ".mp4", "video");
  // 停止信号：executeToolCore 把 ctx.signal 和任务的 stopSignal 合成了一路传进来
  const stop = opts.signal || opts.stopSignal || null;
  // 轮询异步任务：5 秒一查，上限 10 分钟。每一轮先看停没停，等待也能被停止当场叫醒——
  // 以前 5 秒的 setTimeout 睡死，查询的 fetch 也只挂了 30 秒时限，点了停止还要再跑一轮
  const poll = async (check) => {
    const t0 = Date.now();
    while (Date.now() - t0 < 600000) {
      if (stop && stop.aborted) throw stoppedError();
      const got = await check();
      if (got) return got;
      await sleepFor(5000, stop);
    }
    throw new Error("视频生成超时（10 分钟未完成，可稍后到渠道控制台查看任务）");
  };
  const ask = (url, init, ms) => within(stop, ms, (signal) => fetch(url, { ...init, signal }));
  const askJson = (url, init, ms) => within(stop, ms, (signal) => fetch(url, { ...init, signal }).then((x) => x.json()));
  // 万相的字段名按「几张图」分：只有首帧走 img_url，首尾都有走 first/last_frame_url
  const kfBody = lastUri ? { first_frame_url: firstUri, last_frame_url: lastUri } : firstUri ? { img_url: firstUri } : {};
  let videoUrl;
  // 水印这件事只有三种真话：问了对面收下（clean）、问了对面不认所以降级发的（stripped）、
  // 这家协议根本没有这个开关（unasked）。以前是个布尔量，新接的三家只能硬套一个「已按无水印出片」，
  // 那是句假话——人会信了它不去看片尾。
  let vWm = "clean";
  // 已经下了单的上游任务号。停止时拿它去撤单（只有排队中的撤得掉，见 cancelVideoTask）
  let upstream = null;
  // 上游已经收下的任务号（五家都记，不只能撤单的那两家）。收下之后再出错——等结果超时、查询断网、
  // 下载失败——这一单多半还在渲染、照样扣费。带着它回去，画布就不自动补枪：补一枪等于再下一单
  let submitted = "";
  const billedNote = () => `\n上游已经收下这一单（任务号 ${submitted}），多半照样出片、照样扣费。先到渠道控制台按任务号查，别直接重跑——重跑是再下一单。`;
  // 上游自己回了「这单失败」：一般不收钱，照常可以重试，所以这种不带 submitted
  const taskFailed = (detail) => Object.assign(new Error("视频任务失败：" + detail), { taskFailed: true });
  try {
    if (proto === "dashscope") {
      // DashScope 万相（wan 系）：异步提交 + /tasks 轮询
      // 水印走跟生图同一套策略：先按「要干净的」发，只有对面明说不认识这个字段才去掉重发。
      // 以前这里是硬发 parameters.watermark=false，渠道一旦不认，整条视频任务当场就废——
      // 视频要跑好几分钟还按条收钱，为一个可降级的字段把它废掉不划算。
      // tries=1：这是付费异步任务的提交口，退避重发会重复下单，不能跟生图一个策略。
      // 文生走 size（「宽*高」），图生走 resolution（「720P」），时长是 duration。
      // 这三个没传时 wanParams 是空的，parameters 跟以前逐字节一样
      const wanParams = {
        ...(vs.size ? { size: vs.size } : vs.resolution ? { resolution: `${vs.resolution}P` } : {}),
        ...(vs.duration ? { duration: vs.duration } : {}),
      };
      const { r, j, stripped } = await within(stop, 60000, (signal) => postWantClean(
        `${base}/services/aigc/video-generation/video-synthesis`,
        { ...headers, "X-DashScope-Async": "enable" }, signal,
        // 万相这边一张图和两张图是两套字段：只定首帧是 img_url（i2v），首尾都定是 first/last_frame_url（kf2v）。
        // 不传就一个字段都不出现，请求体跟纯文生那条逐字节一样
        (wm) => ({ model: cfg.model, input: { prompt, ...kfBody }, parameters: { ...wanParams, ...(wm ? { watermark: false } : {}) } }), "视频接口", 1));
      vWm = stripped ? "stripped" : "clean";
      const taskId = ((j || {}).output || {}).task_id;
      if (!r.ok || !taskId) return { content: `视频接口错误 ${r.status}: ${JSON.stringify(j).slice(0, 300)}${kfHint}`, isError: true };
      upstream = taskId; submitted = String(taskId);
      videoUrl = await poll(async () => {
        const s = await askJson(`${base}/tasks/${taskId}`, { headers: auth }, 30000);
        const st = ((s || {}).output || {}).task_status;
        if (st === "SUCCEEDED") return s.output.video_url;
        if (st === "FAILED" || st === "CANCELED") throw taskFailed(JSON.stringify(s.output).slice(0, 200));
        return null;
      });
    } else if (proto === "ark") {
      // 火山方舟（Seedance 系）：contents/generations/tasks 异步 + 轮询
      // 时长 / 画幅 / 分辨率同样是文本指令，接在 --watermark 后面；提示词里自己写了的 videoPlan 已经让掉了
      const arkFlags = (vs.duration ? ` --duration ${vs.duration}` : "")
        + (vs.aspect ? ` --ratio ${vs.aspect}` : "")
        + (vs.resolution ? ` --resolution ${vs.resolution}p` : "");
      const r = await ask(`${base}/contents/generations/tasks`, {
        method: "POST", headers,
        // Seedance 的参数走提示词里的文本指令，不是 JSON 字段。用户自己写了就不覆盖他的
        // 方舟这边首尾帧是同一个 content 数组里的两个 image_url 项，靠 role 区分。
        // 文字那一项原样不动：`--watermark false` 是写在提示词里的指令，挪个位置就失效了
        body: JSON.stringify({ model: cfg.model, content: [
          { type: "text", text: (/--watermark\b/.test(prompt) ? prompt : `${prompt} --watermark false`) + arkFlags },
          ...(firstUri ? [{ type: "image_url", image_url: { url: firstUri }, role: "first_frame" }] : []),
          ...(lastUri ? [{ type: "image_url", image_url: { url: lastUri }, role: "last_frame" }] : []),
        ] }),
      }, 60000);
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.id) return { content: `视频接口错误 ${r.status}: ${JSON.stringify(j).slice(0, 300)}${kfHint}`, isError: true };
      upstream = j.id; submitted = String(j.id);
      videoUrl = await poll(async () => {
        const s = await askJson(`${base}/contents/generations/tasks/${j.id}`, { headers: auth }, 30000);
        if (s.status === "succeeded") return ((s.content || {}).video_url) || null;
        if (s.status === "failed" || s.status === "cancelled") throw taskFailed(JSON.stringify(s.error || s).slice(0, 200));
        return null;
      });
    } else if (proto === "zhipu") {
      // 智谱 CogVideoX：/videos/generations 提交，/async-result/{id} 轮询。
      // 提交回执里的字段名是 id，老一点的型号回 request_id，两个都认一下。
      const r = await ask(`${base}/videos/generations`, {
        method: "POST", headers,
        body: JSON.stringify({ model: cfg.model, prompt, with_audio: true, ...(firstUri ? { image_url: firstUri } : {}),
          ...(vs.size ? { size: vs.size } : {}), ...(vs.duration ? { duration: vs.duration } : {}) }),
      }, 60000);
      const j = await r.json().catch(() => ({}));
      const id = j.id || j.request_id;
      if (!r.ok || !id) return { content: `视频接口错误 ${r.status}: ${JSON.stringify(j).slice(0, 300)}${kfHint}`, isError: true };
      submitted = String(id);
      videoUrl = await poll(async () => {
        const s = await askJson(`${base}/async-result/${id}`, { headers: auth }, 30000);
        const st = String((s || {}).task_status || "").toUpperCase();
        if (st === "SUCCESS") return (((s.video_result || [])[0]) || {}).url || null;
        if (st === "FAIL") throw taskFailed(JSON.stringify(s).slice(0, 200));
        return null;
      });
      vWm = "unasked";
    } else if (proto === "minimax") {
      // MiniMax 海螺：提交 → 轮询 → 再拿 file_id 换下载地址，三段，比另外四家多一手。
      // 这家最容易踩的是「HTTP 200 不等于成功」：成败写在 base_resp.status_code 里，
      // 只看 r.ok 的话，一句「余额不足」会被当成提交成功，然后在轮询里空转满 10 分钟才报超时。
      const r = await ask(`${base}/video_generation`, {
        method: "POST", headers,
        // 海螺的分辨率写成「768P」，没有画幅参数（videoPlan 已经在回执里说了）
        body: JSON.stringify({ model: cfg.model, prompt, ...(firstUri ? { first_frame_image: firstUri } : {}),
          ...(vs.duration ? { duration: vs.duration } : {}), ...(vs.resolution ? { resolution: `${vs.resolution}P` } : {}) }),
      }, 60000);
      const j = await r.json().catch(() => ({}));
      const code = ((j || {}).base_resp || {}).status_code;
      if (!r.ok || !j.task_id || (code != null && code !== 0)) {
        return { content: `视频接口错误 ${r.status}${code ? `（base_resp ${code}）` : ""}: ${JSON.stringify(j).slice(0, 300)}${kfHint}`, isError: true };
      }
      submitted = String(j.task_id);
      const fileId = await poll(async () => {
        const s = await askJson(`${base}/query/video_generation?task_id=${encodeURIComponent(j.task_id)}`,
          { headers: auth }, 30000);
        const st = String((s || {}).status || "");
        if (st === "Success") return s.file_id || null;
        if (/^fail/i.test(st)) throw taskFailed(JSON.stringify(s).slice(0, 200));
        return null;
      });
      // 轮询给的是 file_id 不是地址，还得再换一手。换来的地址有时效，换完立刻下载
      const f = await askJson(`${base}/files/retrieve?file_id=${encodeURIComponent(fileId)}`,
        { headers: auth }, 30000).catch(() => ({}));
      if (stop && stop.aborted) throw stoppedError();
      videoUrl = (((f || {}).file || {}).download_url) || "";
      if (!videoUrl) return { content: `片子出好了，但取不到下载地址（file_id ${fileId}）：${JSON.stringify(f).slice(0, 200)}。到 MiniMax 控制台按这个 file_id 能手动下。`, isError: true, submitted };
      vWm = "unasked";
    } else if (proto === "siliconflow") {
      // 硅基流动：submit 拿 requestId，查状态是 POST 带 body——这点跟另外四家都不一样，
      // 照 GET 发过去会得到一个 405，看起来像地址写错了，其实是方法不对。
      const r = await ask(`${base}/video/submit`, {
        method: "POST", headers,
        // 这家接口里没有时长字段；尺寸走 image_size（「1280x720」）
        body: JSON.stringify({ model: cfg.model, prompt, ...(firstUri ? { image: firstUri } : {}), ...(vs.size ? { image_size: vs.size } : {}) }),
      }, 60000);
      const j = await r.json().catch(() => ({}));
      const rid = j.requestId || j.request_id;
      if (!r.ok || !rid) return { content: `视频接口错误 ${r.status}: ${JSON.stringify(j).slice(0, 300)}${kfHint}`, isError: true };
      submitted = String(rid);
      videoUrl = await poll(async () => {
        const s = await askJson(`${base}/video/status`, {
          method: "POST", headers, body: JSON.stringify({ requestId: rid }),
        }, 30000);
        const st = String((s || {}).status || "");
        if (st === "Succeed") return ((((s.results || {}).videos || [])[0]) || {}).url || null;
        if (/^fail/i.test(st)) throw taskFailed(JSON.stringify(s.reason || s).slice(0, 200));
        return null;
      });
      vWm = "unasked";
    } else {
      // 认不出是哪家。把「按什么认的、这次认到了什么」摊开说——中转和自建网关地址里看不出上游，
      // 只说一句「不支持」的话，人会去改地址，而实际该改的是渠道类型那一栏。
      const names = mediaModels.VIDEO_PROTOS.map((p) => mediaModels.VIDEO_PROTO_CN[p]).join("、");
      return {
        content: `认不出这条视频渠道说的是哪门话，所以没敢发——视频按条计费，发错一趟要等好几分钟才看得到错。\n`
          + `现在支持这五家：${names}。\n`
          + `认的顺序是：先看渠道卡上选的「渠道类型」，再看接口地址里的域名（dashscope / volces·ark / bigmodel / minimax / siliconflow）。`
          + `这次地址是 ${base || "(空)"}，渠道类型是「${cfg.kind || "没选"}」，两头都没认出来。\n`
          + `走中转或自建网关的话，地址里本来就看不出上游是谁。到 设置 → 模型 里把这条渠道的「渠道类型」选成它实际接的那一家就行。`,
        isError: true,
      };
    }
    if (!videoUrl) return { content: "视频任务完成但没有返回视频地址" + billedNote(), isError: true, submitted };
    upstream = null; // 片子已经出完了，没有单可撤；下载时停下只是不落盘
    await downloadToWorkspace(videoUrl, fname, opts.saveDir, stop);
  } catch (e) {
    // 停止不是渠道的错：不往外抛（外面会当成失败记进健康表），也不写产物，回一句实话
    if (!(stop && stop.aborted)) {
      if (submitted && !e.taskFailed) { e.message = String(e.message || e) + billedNote(); e.submitted = submitted; }
      throw e;
    }
    if (upstream) cancelVideoTask(proto, base, auth, upstream);
    return { content: "用户已停止任务：视频没生成完，没有落盘。", isError: true, stopped: true };
  }
  security.audit("视频生成", `${cfg.model}: ${prompt.slice(0, 120)}${firstUri ? (lastUri ? "（首尾帧）" : "（首帧图）") : ""} → ${fname}`, "放行");
  const vwNote = vWm === "stripped"
    ? "\n注意：这个渠道不接受 watermark 参数，片尾/角标可能带平台的「AI 生成」水印。要干净的成片就换个渠道或换个模型。"
    : vWm === "unasked"
      ? `\n注意：${protoCn} 的视频接口没有水印开关，带不带平台角标由渠道自己定，这里说了不算。片尾要干净的话先自己看一眼成片。`
      : "\n已按无水印出片，不用再开片找水印。";
  const kfNote = firstUri ? (lastUri ? "\n已按给定的首帧和尾帧出片。" : "\n已按给定的首帧出片。") : "";
  // 夹过、没发的参数逐条说：要 10 秒出了 5 秒不说，下游剪辑按 10 秒排就全错位了
  const planNote = plan.notes.length ? "\n" + plan.notes.join("\n") : "";
  return { content: `视频已生成：${savedAt(opts.saveDir, fname)}（工作空间内的相对路径，模型 ${cfg.model}）${kfNote}${vwNote}${planNote}`, isError: false, file: fname };
}

/**
 * 用户点了停止，顺手去上游撤单。只有两家有撤单接口：
 *   万相 POST /tasks/{id}/cancel、方舟 DELETE /contents/generations/tasks/{id}，
 *   而且都只撤得掉还在排队的——已经开始渲染的照样出片、照样扣费，这边管不了。
 * 智谱 / 海螺 / 硅基流动没有撤单接口，停了只是不再等。
 * 不等它回来：停止要的是「马上停」，撤单成不成都不该拖住回执。
 */
function cancelVideoTask(proto, base, auth, id) {
  const url = proto === "dashscope" ? `${base}/tasks/${encodeURIComponent(id)}/cancel`
    : proto === "ark" ? `${base}/contents/generations/tasks/${encodeURIComponent(id)}` : "";
  if (!url) return;
  fetch(url, { method: proto === "ark" ? "DELETE" : "POST", headers: auth, signal: AbortSignal.timeout(5000) })
    .then((r) => { if (!r.ok) console.warn(`[tools] 撤销视频任务 ${id} 没成（${r.status}），上游可能照样出片计费`); })
    .catch((e) => console.warn(`[tools] 撤销视频任务 ${id} 没发出去：${e.message}`));
}

/** HTML → PNG：真浏览器离屏渲染（htmlshot.js，只有桌面版才有渲染器） */
async function htmlToImage(input, resolveFile, saveDir) {
  const rel = String(input.html_file || "").trim();
  if (!rel) return { content: "缺少 html_file（工作空间里的 HTML 文件路径）", isError: true };
  let p;
  try { p = resolveFile(rel); } catch (e) { return { content: e.message, isError: true }; }
  if (!fs.existsSync(p)) return { content: `文件不存在：${rel}（先用 write_file 把排版 HTML 写进工作空间）`, isError: true };
  const fname = safeOutName(input.filename, ".png", "card");
  let buf;
  try {
    const { renderHtmlToPng } = require("../../htmlshot");
    buf = await renderHtmlToPng(p, {
      width: input.width || 1242,
      height: input.height || 1656,
      fullPage: !!input.full_page,
      waitMs: input.wait_ms || 500,
    });
  } catch (e) {
    return { content: `HTML 截图失败：${e.message}`, isError: true };
  }
  ensureDirs();
  fs.writeFileSync(path.join(saveDir || ws(), fname), buf);
  security.audit("HTML截图", `${rel} → ${fname}`, "放行");
  return { content: `已把 ${rel} 渲染成图片：${fname}（${input.width || 1242}x${input.full_page ? "整页" : input.height || 1656}）`, isError: false };
}

/** 没配语音合成时的那句话。按句配音（tts-batch.js）要一字不差地说同一句，所以提出来共用 */
const TTS_UNSET = "语音合成未配置：请在 设置 → 模型 → 语音合成 填写接口地址 / API Key / 模型名后再用。";

/** 这条渠道落盘的音频后缀：DashScope 回的是 wav 的下载地址，OpenAI 兼容那一路直接回 mp3 字节 */
function ttsExtOf(cfg) {
  return /dashscope/i.test(String((cfg || {}).base_url || "")) ? ".wav" : ".mp3";
}

/** 文字 → 语音（渠道协议：OpenAI 兼容 /audio/speech、DashScope 原生 qwen-tts） */
async function textToSpeech(media, input, timeoutMs, saveDir, stop) {
  let cfg;
  try { cfg = mediaModels.pick(media, "tts", input.model); } catch (e) { return { content: e.message, isError: true }; }
  if (!cfg.base_url || !cfg.model) {
    return { content: TTS_UNSET, isError: true };
  }
  const text = String(input.text || "").trim();
  if (!text) return { content: "缺少 text（要念的文字）", isError: true };
  if (text.length > 5000) return { content: `文字太长（${text.length} 字，上限 5000），请分段多次合成再拼接`, isError: true };
  const base = String(cfg.base_url).trim().replace(/\/+$/, "");
  const voice = String(input.voice || cfg.voice || "").trim();
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${mediaKey(cfg)}` };
  const signal = anySignal(stop, AbortSignal.timeout(Math.max(timeoutMs || 0, 300000)));
  let fname;
  if (/dashscope/i.test(base)) {
    // DashScope 原生（qwen-tts / qwen3-tts-flash 系）：multimodal-generation，返回音频 URL（wav）
    fname = safeOutName(input.filename, ttsExtOf(cfg), "speech");
    const r = await fetch(`${base}/services/aigc/multimodal-generation/generation`, {
      method: "POST", headers, signal,
      body: JSON.stringify({ model: cfg.model, input: { text, ...(voice ? { voice } : {}) } }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { content: `语音接口错误 ${r.status}: ${JSON.stringify(j).slice(0, 300)}`, isError: true };
    const url = (((j.output || {}).audio || {}).url) || "";
    if (!url) return { content: "语音接口没有返回音频：" + JSON.stringify(j).slice(0, 300), isError: true };
    await downloadToWorkspace(url, fname, saveDir, stop);
  } else {
    // OpenAI 兼容 /audio/speech（OpenAI、new-api 等聚合网关通用）：直接返回音频二进制
    fname = safeOutName(input.filename, ttsExtOf(cfg), "speech");
    const r = await fetch(`${base}/audio/speech`, {
      method: "POST", headers, signal,
      body: JSON.stringify({
        model: cfg.model, input: text,
        ...(voice ? { voice } : {}),
        ...(input.speed ? { speed: Math.min(Math.max(Number(input.speed) || 1, 0.5), 2) } : {}),
      }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return { content: `语音接口错误 ${r.status}: ${t.slice(0, 300)}`, isError: true };
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 200) return { content: "语音接口返回的音频为空", isError: true };
    if (stop && stop.aborted) throw stoppedError("音频没有落盘。");
    ensureDirs();
    fs.writeFileSync(path.join(saveDir || ws(), fname), buf);
  }
  security.audit("语音合成", `${cfg.model}: ${text.slice(0, 80)} → ${fname}`, "放行");
  return { content: `语音已合成：${savedAt(saveDir, fname)}（工作空间内的相对路径，模型 ${cfg.model}${voice ? "，音色 " + voice : ""}，约 ${text.length} 字）`, isError: false, file: fname };
}

/** 能送去转写的后缀。上游收的就是这几样，多写只会在那边被拒，不如在本机就说清楚 */
const AUDIO_EXT = /\.(mp3|mp4|m4a|wav|webm|mpga|mpeg|ogg|oga|flac|aac|amr)$/i;
/** /audio/transcriptions 的硬上限。先量本地字节，别让用户传了两分钟才吃一个 413 */
const ASR_MAX_BYTES = 25 * 1048576;
/** 超过这个字数就不整篇塞回对话里——一小时的会议稿两万字，塞回去等于把上下文吃光 */
const ASR_INLINE_CAP = 2000;

/** 秒 → SRT 的 00:01:02,500。Math.floor 不用 toFixed：58.999 秒 toFixed 会进位成 59.000 却还留在上一分钟 */
function srtTime(sec) {
  const ms = Math.max(0, Math.round(Number(sec) * 1000));
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}

/**
 * 把录音转成文字。走 OpenAI 兼容的 /audio/transcriptions（一次 multipart 传完就返回）。
 *
 * 为什么只支持这一种协议：通义百炼的 ASR 是「先把文件传到公网可访问的地址、再提交异步任务、
 * 再轮询」，和这里完全不是一门话。装作支持、让用户在设置里选得到，最后只会在调用时吃 404——
 * 所以精选目录里一个 dashscope 型号都不摆，报错时也直接把这件事说明白。
 */
async function transcribeAudio(media, input, timeoutMs, resolveFile, saveDir, stop) {
  const rel = String(input.path || "").trim();
  if (!rel) return { content: "缺少 path（要转写哪个文件，工作空间里的相对路径）", isError: true };
  let cfg;
  try { cfg = mediaModels.pick(media, "asr", input.model); } catch (e) { return { content: e.message, isError: true }; }
  if (!cfg.base_url || !cfg.model) {
    return { content: "语音转写未配置：请用户去 设置 → 模型 → 转写 配置渠道和模型（如 OpenAI 的 gpt-4o-transcribe、硅基流动的 SenseVoiceSmall）。这一步不用重试。", isError: true };
  }
  let p;
  try { p = resolveFile(rel); } catch (e) { return { content: e.message, isError: true }; }
  if (!fs.existsSync(p)) return { content: `找不到 ${rel}。用户传进来的文件在工作空间里，先 list_files 看看真实文件名。`, isError: true };
  const st = fs.statSync(p);
  if (st.isDirectory()) return { content: `${rel} 是个目录，不是音频文件。`, isError: true };
  if (!AUDIO_EXT.test(p)) return { content: `${rel} 不是音频 / 视频（支持 mp3 / m4a / wav / webm / mp4 / flac / ogg / aac / amr）。文本文件用 read_file。`, isError: true };
  if (st.size < 200) return { content: `${rel} 只有 ${st.size} 字节，不像是一段能转写的音频。`, isError: true };
  if (st.size > ASR_MAX_BYTES) {
    return {
      content: `${path.basename(p)} 有 ${(st.size / 1048576).toFixed(1)}MB，超过接口 25MB 的上限，没有发出去。\n`
        + `先压小再转：run_shell 跑 ffmpeg -i "${rel}" -ac 1 -ar 16000 -b:a 64k "${path.basename(p).replace(/\.[^.]+$/, "")}_16k.mp3"，`
        + "一小时的会议压完大概 3MB；还是超就按 -ss / -t 切成几段分别转，最后把稿子拼起来。",
      isError: true,
    };
  }

  const base = mediaModels.baseForUse(String(cfg.base_url).trim(), "media").replace(/\/+$/, "");
  if (/dashscope\.aliyuncs\.com/i.test(base)) {
    return { content: "通义百炼的转写是异步任务接口，和这里用的 OpenAI 兼容 /audio/transcriptions 不是一套，现在还没接。换 OpenAI（gpt-4o-transcribe / whisper-1）或硅基流动（FunAudioLLM/SenseVoiceSmall）这类渠道。这一步不用重试。", isError: true };
  }
  // Key 在读文件之前先验：25MB 的音频读进内存再栽在 Key 上，白等一轮还白占一把内存
  const auth = { Authorization: `Bearer ${mediaKey(cfg)}` };
  const wantSeg = !!input.with_timestamps;
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(p)]), path.basename(p));
  form.append("model", cfg.model);
  form.append("response_format", wantSeg ? "verbose_json" : "json");
  const lang = String(input.language || "").trim();
  if (lang) form.append("language", lang);
  const hint = String(input.hint || "").trim().slice(0, 500);
  if (hint) form.append("prompt", hint);

  // 上传要时间，转写也要时间：一个 25MB 的文件在慢网上传就得几分钟，超时按文件大小放宽
  const budget = Math.max(timeoutMs || 0, 180000 + Math.round(st.size / 1048576) * 20000);
  let r;
  try {
    r = await fetch(`${base}/audio/transcriptions`, { method: "POST", headers: auth, body: form, signal: anySignal(stop, AbortSignal.timeout(budget)) });
  } catch (e) {
    // 用户点的停止：抛出去由外层说「已停止」，别落成「转写请求失败」记进健康表
    if (stop && stop.aborted) throw stoppedError();
    return { content: `转写请求失败：${e.message}（文件 ${(st.size / 1048576).toFixed(1)}MB，等了 ${Math.round(budget / 1000)} 秒）`, isError: true };
  }
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    return { content: `转写接口错误 ${r.status}: ${t.slice(0, 300)}`, isError: true };
  }
  const j = await r.json().catch(() => null);
  if (!j) return { content: "转写接口返回的不是 JSON，多半是这个地址没有 /audio/transcriptions 这个接口。", isError: true };
  const text = String(j.text || "").trim();
  if (!text) return { content: "转写接口没有返回文字（可能整段是静音，也可能这个模型不吃这种格式）：" + JSON.stringify(j).slice(0, 300), isError: true };
  if (stop && stop.aborted) throw stoppedError("转写稿没有落盘。");

  ensureDirs();
  const stem = path.basename(p).replace(/\.[^.]+$/, "");
  const fname = safeOutName(input.filename, ".txt", stem);
  const dir = saveDir || ws();
  fs.writeFileSync(path.join(dir, fname), text);
  const saved = [savedAt(saveDir, fname)];

  // 分段只有 verbose_json 才有。要了却没给（模型不支持）就照实说一句，别让用户以为字幕已经出好了
  const segs = Array.isArray(j.segments) ? j.segments.filter((x) => x && typeof x.text === "string") : [];
  let srtNote = "";
  if (wantSeg && segs.length) {
    const srtName = fname.replace(/\.txt$/i, "") + ".srt"; // 跟转写稿同名，两个文件在产出列表里挨着
    const srt = segs.map((x, i) => `${i + 1}\n${srtTime(x.start)} --> ${srtTime(x.end)}\n${String(x.text).trim()}\n`).join("\n");
    fs.writeFileSync(path.join(dir, srtName), srt);
    saved.push(savedAt(saveDir, srtName));
    srtNote = `，字幕 ${segs.length} 段`;
  } else if (wantSeg) {
    srtNote = "；这个模型没给分段时间轴，.srt 没生成";
  }

  security.audit("语音转写", `${cfg.model}: ${rel}（${(st.size / 1048576).toFixed(1)}MB）→ ${fname}`, "放行");
  const head = text.length > ASR_INLINE_CAP
    ? `${text.slice(0, ASR_INLINE_CAP)}\n……（全文 ${text.length} 字，只贴了开头；要看后面的用 read_file 读 ${saved[0]}）`
    : text;
  return { content: `转写完成，存到 ${saved.join(" 和 ")}（模型 ${cfg.model}，共 ${text.length} 字${srtNote}）：\n\n${head}`, isError: false };
}

/**
 * 花钱的那三样（生图 / 生视频 / 配音）统一过一道生成结果缓存。
 *
 * 只包这三个，别的一个都不包：html_to_image 在本机渲染、不花钱，而且它的输入是一个
 * HTML 文件——同名文件内容天天在变，按参数算 key 一定会拿旧图冒充新图。
 * transcribe_audio 也不包：它的产物是文字，本来就便宜，而且模型经常改 with_timestamps
 * 再跑一遍，缓存在这儿帮不上忙。
 *
 * 渠道没配好 / 型号点错时故意不算 key：让真正的那一趟去报错——它的话说得比这里清楚得多。
 */
async function withGenCache(kind, cap, opts, input, dir, resolveFile, hold, run) {
  let k = null, model = "";
  try {
    const cfg = mediaModels.pick(opts.media, cap, input.model);
    model = cfg.model;
    k = genCache.key(kind, input, cfg, dir, resolveFile, ws());
  } catch {
    k = null;
  }
  if (k) {
    const hit = genCache.get(k, ws());
    if (hit) {
      // 命中缓存 = 一个子儿没花，所以刚才那笔预扣要当场退回去。
      // 不退的话，一个反复重跑同一张图的任务会把预算“占”到拦人，而账单上什么都没发生。
      quota.undo(hold);
      security.audit(kind === "text_to_speech" ? "语音合成" : kind === "generate_video" ? "视频生成" : "图像生成",
        `复用上次的产物（参数逐字一样，没有再调 ${model}）→ ${hit.file}`, "放行");
      return hit;
    }
  }
  let out;
  try {
    out = await run();
  } catch (e) {
    quota.undo(hold);   // 没发出去就不该占着预算
    throw e;
  }
  // 记账放在这儿而不是调用点：上面命中缓存的那条路径直接 return 了，一个子儿没花。
  // 记在调用点的话，同一张图重跑十次会记十笔，而实际只付了一次钱
  if (!out.isError) {
    quota.record(cap, {
      provider: mediaProviderOf(opts.media, cap), model,
      units: unitsFor(cap, input, resolveFile, opts.media),
      meta: String(input.prompt || input.text || "").slice(0, 80), hold,
    });
  } else {
    quota.undo(hold);   // 渠道挂了 / 参数错了，同样一分没花
  }
  if (k) genCache.put(k, out, dir, ws(), model);
  return out;
}

/**
 * 这一趟按量计费的话，量是多少（张 / 秒 / 千字符 / 分钟）。
 *
 * 三个估值都把依据写在这儿，因为它们会直接变成后台那张表上的钱：
 *
 *   视频：按**实际出片的秒数**记，不按人要的记。要 10 秒、型号只出得了 5 秒，
 *          发出去的就是 5 秒、上游收的也是 5 秒的钱，账上记 10 秒就是凭空多算一倍。
 *          秒数跟发请求用的是同一份 videoPlan（按型号表夹紧 + 型号默认时长），
 *          所以预扣、记账、请求体三处不会各算各的。没传 duration 就是型号默认（海螺 6 秒，其余 5 秒）。
 *          第 4 个参数给渠道配置：可以是整份 media（按 input.model 挑），也可以是挑好的那一路 cfg。
 *          不给就认不出型号，只能按人要的秒数（没写按 5 秒）估——3.1 的预估接口记得把 media 传进来。
 *   语音：字符数是准的，按字符算就行——各家计费用的也是字符数。
 *   转写：发出去之前唯一能知道的只有文件大小，所以按 128kbps（≈16 KB/秒）折成分钟。
 *          压过的 16k 单声道文件会被算少，没压过的会被算多，误差在一倍以内。
 *          要精确到秒得先拆音频头，而那要为每一次转写多读一遍文件——不值。
 */
function unitsFor(cap, input = {}, resolveFile, media) {
  if (cap === "image") return Math.max(1, Math.floor(+input.n || 1));
  if (cap === "video") {
    let cfg = null;
    if (media && typeof media.model === "string") cfg = media;
    else { try { cfg = mediaModels.pick(media, "video", input.model); } catch { cfg = null; } }
    return Math.max(1, mediaModels.videoPlan(cfg, input).seconds);
  }
  if (cap === "tts") {
    // 按句配音：一批里每句的字数加起来。预估接口（server.js）和额度闸都走这里，不这么算就只估了个 0
    if (Array.isArray(input.segments)) {
      const chars = input.segments.reduce((n, s) => n + String((s && typeof s === "object" ? s.text : s) || "").trim().length, 0);
      return Math.max(0.001, chars / 1000);
    }
    return Math.max(0.001, String(input.text || "").length / 1000);
  }
  if (cap === "asr") {
    try {
      const st = fs.statSync(resolveFile(String(input.path || input.file || "").trim()));
      return Math.max(0.1, st.size / 16000 / 60);
    } catch { return 1; }
  }
  return 1;
}

/** 这一路当前走的是哪家服务商——只为流水好看，取不到就空着，绝不因此中断调用 */
function mediaProviderOf(media, cap) {
  try { return String(mediaModels.pick(media, cap).provider || "").slice(0, 40); } catch { return ""; }
}
/** 转写这一路真正用的型号。计价要拿它去查价，而调用方常常不写 model（走默认那个） */
function asrModelOf(media, want) {
  try { return String(mediaModels.pick(media, "asr", want).model || "").slice(0, 60); } catch { return String(want || ""); }
}

module.exports = {
  bindWorkspace,
  OUT_EXT_ALIAS, safeOutName, anySignal, within, sleepFor, stoppedError, fetchRetry, mediaKey, downloadToWorkspace,
  IMAGE_EXT, shrinkForVision, readImageInput, imageDataUri, mainCanSee, pickEye, lookAtImage, savedAt, postWantClean,
  refImageUris, I2V_RE, T2V_RE, generateImage, generateVideo, htmlToImage, textToSpeech, AUDIO_EXT, ASR_MAX_BYTES,
  srtTime, transcribeAudio, withGenCache, unitsFor, mediaProviderOf, asrModelOf,
  TTS_UNSET, ttsExtOf
};
