"use strict";
/**
 * 一行一测：设置 → 模型 里每一行后面那颗「测」。
 *
 *   node test/model-probe.js
 *
 * 不联网、不花钱：global.fetch 换成一个记事本，喂进去的是各种真实会遇到的响应。
 *
 * 为什么非得有这一层。渠道那颗「测一下」答的是「这条线通不通」，可一条渠道下面能挂五个
 * 模型——线是通的，模型名却可能错了三个。以前这三个要等某个任务跑到一半才炸，
 * 而且炸出来的是一句「型号不存在」，屏幕前的人根本不知道该改哪一行。
 *
 * 这套盯三种在界面上长得一样、原因完全不同的坏法：
 *
 *   A. **绿勾说谎**。生图/生视频这一路是「不真生成」的测活——拿模型清单验 Key 和模型名。
 *      验不到余额。这时候给一个干净的 ✓，人会拿它当「已经能用」，然后在真任务里踩空。
 *      所以下面钉死：成功那句话里**必须**写着「没真生成」，而且不能是绿的。
 *
 *   B. **替人下结论**。渠道不提供 /models（专做生图的接口很多都没有）不等于坏了。
 *      这时候只能说「只验到地址通了」，不许编一个通过，也不许报一个失败。
 *
 *   C. **绿勾跑到隔壁行头上**。测活结果按名字存，不按下标——下标一删行就全串位，
 *      而「隔壁那行碰巧也通」是最难看出错的一种错。
 *
 * 每条正向断言后面都跟反向对照：把那一条的依据抽掉，它必须变红。
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const app05 = fs.readFileSync(path.join(ROOT, "public", "js", "app-05.js"), "utf8");

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  ← " + String(typeof extra === "string" ? extra : JSON.stringify(extra)).slice(0, 300) : "")); }
}

/**
 * 把 server.js 里那个函数原样抠出来跑。
 *
 * 不 require server.js：它一被 require 就会 main()，把整台服务连端口一起起来——
 * 一个不花钱的单元测试不该顺手占掉 3000 端口、读用户的 config.json。
 * 抠源码的坏处是「抠错了就测了个寂寞」，所以抠完先断言花括号真配平了。
 */
function cutFn(src, name) {
  const head = src.indexOf("async function " + name + "(");
  if (head < 0) throw new Error("server.js 里找不到 " + name + "，它是不是被改名了？");
  // 参数表得先跳过去：这个函数的参数是解构 ({ base_url, … })，
  // 直接找第一个 { 会把参数表当函数体，配对在参数表末尾就收工，抠回来半句话
  let i = src.indexOf("(", head), pd = 0;
  for (; i < src.length; i++) {
    if (src[i] === "(") pd++;
    else if (src[i] === ")") { pd--; if (pd === 0) { i++; break; } }
  }
  i = src.indexOf("{", i);
  let depth = 0, end = -1;
  for (; i < src.length; i++) {
    const c = src[i], nx = src[i + 1];
    // 字符串、正则、注释里的花括号会把计数带偏
    if (c === "/" && nx === "/") { i = src.indexOf("\n", i); if (i < 0) break; continue; }
    if (c === "/" && nx === "*") { i = src.indexOf("*/", i) + 1; continue; }
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      for (i++; i < src.length && src[i] !== q; i++) if (src[i] === "\\") i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) throw new Error(name + " 的花括号没配平，抠出来的不是完整函数");
  const cut = src.slice(head, end);
  // 抠错了就等于测了个寂寞：先让它自己过一遍语法
  new Function(cut);
  return cut;
}

const probeSrc = cutFn(server, "probeMediaModel");
const probeMediaModel = new Function("fetch", "AbortSignal", probeSrc + "\nreturn probeMediaModel;");

// ---------- 假 fetch：记下发出去的请求，回一个指定的响应 ----------
let sent = [];
function makeFetch(status, body, { raw = false, throws = null } = {}) {
  return async (url, init) => {
    sent.push({ url: String(url), init: init || {} });
    if (throws) throw throws;
    const text = raw ? String(body) : JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(text), text: async () => text };
  };
}
const fakeAbort = { timeout: (ms) => ({ __ms: ms }) };
function probe(args, status, body, opts) {
  sent = [];
  return probeMediaModel(makeFetch(status, body, opts), fakeAbort)(args);
}
const lastReq = () => {
  const r = sent[sent.length - 1] || { url: "", init: {} };
  const h = {};
  for (const [k, v] of Object.entries((r.init || {}).headers || {})) h[k.toLowerCase()] = v;
  return { url: r.url, headers: h, init: r.init };
};

const ARGS = { base_url: "https://ark.example.com/api/v3/", api_key: "TESTKEY-0000", model: "doubao-seedream-4", capCn: "图像模型" };
const LIST = { data: [{ id: "doubao-seedream-4" }, { id: "doubao-seedance-1" }, { id: "wan2.2-t2v" }] };

(async () => {
  console.log("\n【一】发出去的那个请求长什么样");
  {
    const r = await probe(ARGS, 200, LIST);
    const q = lastReq();
    ok(q.url === "https://ark.example.com/api/v3/models", "打的是 {地址}/models，而且把末尾多余的斜杠削掉了", q.url);
    ok(q.headers.authorization === "Bearer TESTKEY-0000", "Key 按 Bearer 放在 Authorization 头里", q.headers);
    ok(!r.error, "清单里有这个模型 → 不报错", r);
  }
  {
    // 本机 ollama 这类不需要 Key。带一个空 Authorization 出去，有的网关会当成「拿了把空 Key」直接 401
    sent = [];
    await probeMediaModel(makeFetch(200, LIST), fakeAbort)({ ...ARGS, api_key: "" });
    ok(!("authorization" in lastReq().headers), "没 Key 的时候干脆不发 Authorization 头（反向对照：发一个空的会被网关当成 Key 错）", lastReq().headers);
  }
  {
    const r = await probe({ ...ARGS, base_url: "ark.example.com" }, 200, LIST);
    ok(/http/.test(r.error || ""), "地址不是 http(s) 开头 → 当场说清楚，不发请求", r);
    ok(sent.length === 0, "反向对照：这种情况一个请求都没发出去（发了就是白等一次超时）", sent.length);
  }

  console.log("\n【二】这把 Key 到底认不认");
  for (const code of [401, 403]) {
    const r = await probe(ARGS, code, { error: "invalid api key" });
    ok(/上游不认/.test(r.error || "") && r.error.includes(String(code)),
      `HTTP ${code} → 直说「这个 Key 上游不认」，并带上状态码`, r);
    ok(/复制全|这家/.test(r.error || ""), `HTTP ${code} 那句话说了下一步该查什么，不是只甩一个码`, r);
  }
  {
    const r = await probe(ARGS, 429, {});
    ok(/限流/.test(r.error || "") && !/Key/.test(r.error || ""),
      "429 是限流不是 Key 坏了 —— 两件事别混成一句（反向对照：这句里不许出现 Key）", r);
  }

  console.log("\n【三】渠道不给清单：不许编结论");
  {
    const r = await probe(ARGS, 404, {});
    ok(!r.error, "404（这条接口根本没有 /models）不当成失败 —— 专做生图的接口很多都没这条路", r);
    ok(r.partial === true, "但它得标成「只验到一半」，不是一次成功", r);
    ok(/只验到/.test(r.note || "") && /真生成/.test(r.note || ""),
      "那句话说明白了：验到哪儿、剩下的怎么才能知道", r);
    ok((r.note || "").includes("图像模型") && (r.note || "").includes("doubao-seedream-4"),
      "话里点名了是哪一路的哪个模型（一页上有六张卡，不点名等于没说）", r);
  }
  {
    const r = await probe(ARGS, 200, { data: [] });
    ok(!r.error && r.partial === true, "清单是空的 → 同样只算半通", r);
    ok(/没法核对/.test(r.note || ""), "并且说清楚是「没法核对模型名」，不是「模型不存在」", r);
  }

  console.log("\n【四】模型名对不对");
  {
    const r = await probe({ ...ARGS, model: "doubao-seedream-3" }, 200, LIST);
    ok(/没有「doubao-seedream-3」/.test(r.error || ""), "清单里没这个名字 → 把那个名字原样打出来", r);
    ok(/3 个模型/.test(r.error || ""), "顺便说了对方一共列了几个（判断是不是拉到了别家的清单）", r);
    ok(/设置|下拉/.test(r.error || ""), "并且指了下一步去哪儿改", r);
    ok(!/Key/.test(r.error || "") || /Key 是好的/.test(r.error || ""),
      "反向对照：这时候不许暗示 Key 有问题 —— Key 明明是好的，甩锅给 Key 会让人去白换一把", r);
  }
  {
    // 有些网关的清单是 {models:[...]}，还有的直接给一串字符串
    const r1 = await probe(ARGS, 200, { models: [{ id: "doubao-seedream-4" }] });
    const r2 = await probe(ARGS, 200, { data: ["doubao-seedream-4"] });
    ok(!r1.error, "清单换成 {models:[…]} 这种形状也认得出来", r1);
    ok(!r2.error, "清单里直接是字符串也认得出来", r2);
    const r3 = await probe(ARGS, 200, { data: [{ name: "doubao-seedream-4" }] });
    ok(!r3.error, "只有 name 没有 id 的条目也认（不少国产网关这么给）", r3);
  }

  console.log("\n【五】成功那句话不许含糊");
  {
    const r = await probe(ARGS, 200, LIST);
    ok(/没真生成|不花钱/.test(r.note || ""),
      "通过时明说了「这一步没真生成」—— 一个干净的 ✓ 会被当成「已经能用」", r);
    ok(/余额/.test(r.note || ""), "并且点名了验不到的正是余额", r);
    ok(r.partial !== true, "反向对照：这一条是真通过，不该被标成半通", r);
    ok(/3 个|一共/.test(r.note || ""), "把清单条数带上：数字对不上就说明连到别家去了", r);
  }

  console.log("\n【六】连不上的时候说人话");
  {
    const e = new Error("The operation was aborted due to timeout");
    e.name = "TimeoutError";
    const r = await probe(ARGS, 200, LIST, { throws: e });
    ok(/超时/.test(r.error || ""), "超时 → 说「超时」，不是把英文异常原样甩出来", r);
    ok(/代理|国产/.test(r.error || ""), "并且给了最常见的那条出路（国外服务商国内直连打不通）", r);
  }
  {
    const r = await probe(ARGS, 200, LIST, { throws: new Error("getaddrinfo ENOTFOUND ark.example.com") });
    ok(/连不上/.test(r.error || "") && /ENOTFOUND/.test(r.error || ""),
      "别的连接错误 → 归到「连不上」，但把对方原话留着（域名打错了就靠这句看出来）", r);
    ok(!/超时/.test(r.error || ""), "反向对照：DNS 错不许说成超时 —— 归错类就等错方向", r);
  }

  console.log("\n【七】超时真的设了");
  {
    await probe(ARGS, 200, LIST);
    const sig = (lastReq().init || {}).signal;
    ok(sig && sig.__ms >= 5000 && sig.__ms <= 30000,
      "请求带了超时（否则一条不通的渠道能让这颗按钮转到天荒地老）", sig);
  }

  console.log("\n【八】源码闸门：接口这一头");
  {
    const i = server.indexOf('app.post("/api/model-test"');
    ok(i > 0, "有 /api/model-test 这条路");
    const blk = server.slice(i, server.indexOf("\napp.", i + 10));
    ok(/isPlatformOwner\(req\)/.test(blk),
      "它带 Key 出网，跟渠道测活同一道门：只有平台管理员能发起");
    const iResolve = blk.indexOf("mediaModels.resolve(config)");
    const iProbe = blk.indexOf("probeMediaModel(");
    ok(iResolve > 0 && iResolve < iProbe,
      "媒体那一路先过 mediaModels.resolve 再测：生图的地址跟对话不一定同前缀，这儿抄一遍迟早跟真跑时对不上",
      { iResolve, iProbe });
    ok(/config\.media_models/.test(blk) && /config\.models/.test(blk),
      "两张表都能测（对话模型一张、生图生视频那五路一张）");
    ok(/这一行已经不在了|刷新一下/.test(blk),
      "下标扑空时说的是「这行没了，刷新再试」，不是一句 500");
  }
  {
    // 专门挂生图/生视频的渠道底下一个对话模型都没有。以前这儿直接甩「还没有对话模型」，
    // 等于告诉人「你这条渠道没法测」——可它明明配好了、也在用
    const i = server.indexOf('app.post("/api/provider-test"');
    const blk = server.slice(i, server.indexOf("\n/**", i + 10));
    // 注释得先撕掉再断言：这一段的注释里就复述了那句旧文案（「以前这儿甩的是…」），
    // 连注释一起匹配的话，这条反向对照永远红，红的还是一句根本没在跑的字
    const code = blk.replace(/\/\/[^\n]*/g, "");
    ok(/config\.media_models \|\| \[\]\)\.filter/.test(code) && /probeMediaModel\(/.test(code),
      "渠道测活：底下没有对话模型时改走不花钱的清单测活，而不是甩一句「测不了」");
    ok(!/还没有对话模型/.test(code), "反向对照：那句把人堵死的话已经不在真跑的代码里了", code.match(/还没.{0,12}模型/g));
  }

  console.log("\n【九】源码闸门：界面这一头");
  {
    ok(/class="mrow-test"/.test(app05), "每一行模型后面都有自己的那颗「测」");
    const btn = app05.slice(app05.indexOf("function modelTestBtn"), app05.indexOf("function modelTestBtn") + 900);
    ok(/ic\(.*\)\}\$\{run \? "测中" : "测"\}/.test(btn) || /"测中" : "测"/.test(btn),
      "那颗按钮带字不带纯图标：摆出来却认不出，等于没摆");
    ok(/\/api\/model-test/.test(app05), "它打的是一行一测那条接口");
    // 下标会串位：删掉第 2 行以后，第 3 行的结果就顶着第 2 行的名字显示。
    // 所以结果必须按名字/id 存，按名字找回下标
    ok(/const mtKey = /.test(app05) && /findIndex\(\(m\) => mtKey\(/.test(app05),
      "测活结果按名字存、临发请求前才现算下标（按下标存的话，删一行绿勾就跑到隔壁头上）");
    ok(/data-mtkey=/.test(app05) && !/class="mrow-test"[^>]*data-i=/.test(app05),
      "反向对照：按钮上挂的是名字，不是下标");
    const ib = app05.indexOf("function bindModelTests");
    // 一样得先撕注释：把这句注释掉，文字还在源码里，只测「有没有这串字」是测不出来的
    const bindCode = app05.slice(ib, ib + 900).replace(/\/\/[^\n]*/g, "");
    ok(ib > 0 && /e\.stopPropagation\(\)/.test(bindCode),
      "点「测」不许把折叠卡收起来 —— 收起来就看不见刚测出来的那句话了");
    const nMedia = (app05.match(/bindModelTests\(box, s/g) || []).length;
    const nChat = (app05.match(/bindModelTests\(pane, s/g) || []).length;
    ok(nMedia === 1 && nChat === 1, "对话卡和那五张能力卡都接上了（少接一处 = 那半屏的按钮点了没反应）", { nMedia, nChat });
    // 「只验到一半」既不是绿也不是红。给它绿色，人就会拿它当「已经能用」
    ok(/is-half/.test(app05), "半通的结论有它自己的样式，不蹭成功那个绿");
    const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
    ok(/\.ch-res\.is-half/.test(html) && /\.mrow-test\s*\{/.test(html),
      "这两个新样式在 index.html 里真定义了（只写 class 不写样式 = 一颗没边框的裸字）");
    ok(/\.mrow-test:disabled/.test(html), "测活途中那颗按钮是灰的，点不了第二次");
  }

  console.log("\n【十】结果挂在哪一行");
  {
    // mtKey 的规矩：对话按 name，媒体按 id。这两张表里这两个字段才是稳定的
    const src = app05.slice(app05.indexOf("const mtKey = "), app05.indexOf("const mtKey = ") + 200);
    ok(/scope === "media" \? m\.id \|\| m\.name : m\.name/.test(src),
      "媒体行按 id、对话行按名字 —— 这两个字段跨一次重画还是同一个值", src);
  }

  console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})();
