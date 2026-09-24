"use strict";
/**
 * 远程访问那条链：设备配对授权 + 静态资源压缩。
 *
 * 跑法：node test/remote.js
 * 用临时 OPENWORKBUDDY_DATA_DIR，绝不碰真账号。
 *
 * 这两件事是一起做的，因为它们修的是同一个场景的两半：
 *   「我人在外面，想用家里那台电脑上的 agent」
 *   —— 配对解决「怎么进来而不用把密码敲进手机」，压缩解决「进来之后别等十几秒」。
 *
 * 重点不是「接口返回 200」，是那几条一破就出事的线：
 *   1. 配对码一次性、会过期、撞错要限速（它是一把能直接开门的钥匙）
 *   2. 设备列表发出去的是 id，不是令牌（列表是给人看的，不该是一串能用的钥匙）
 *   3. 踢掉一台之后，那条令牌当场就不好使
 *   4. 压缩不能压坏：解回来必须跟原文一个字节不差，不认压缩的客户端要拿到原文
 * 每条后面都跟一个反向对照：把该拒的换成该放的，必须放行。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const http = require("http");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "owb-remote-"));
process.env.OPENWORKBUDDY_DATA_DIR = path.join(TMP, "data");
fs.mkdirSync(process.env.OPENWORKBUDDY_DATA_DIR, { recursive: true });

const express = require("express");
const ROOT = path.join(__dirname, "..");
const srcLib = require("./lib/src"); // server / tools / canvas 三组源码的唯一读法，见 test/lib/src.js
const account = require(path.join(ROOT, "account"));
const { createStaticCompress, _internals: sc } = require(path.join(ROOT, "static-compress"));
const { createJsonCompress } = require(path.join(ROOT, "json-compress"));
const A = account._internals;

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ " + msg + (extra !== undefined ? "  ← " + JSON.stringify(extra) : "")); }
};
const eq = (got, want, msg) => ok(got === want, msg, { got, want });

// ---------- 一个跟 server.js 中间件顺序一样的最小应用 ----------
const app = express();
app.use(express.json());
const ASSETS = path.join(TMP, "assets");
fs.mkdirSync(ASSETS, { recursive: true });
app.use(createStaticCompress([{ prefix: "/", dir: ASSETS }, { prefix: "/v/", dir: path.join(TMP, "vendor") }]));
app.use(express.static(ASSETS));
app.use(createJsonCompress());
app.use(account.createRouter({}));
app.use(account.authGuard);
app.get("/api/whoami", (req, res) => res.json({ user: req.user.username }));
// 给「动态 JSON 也要压」那一节用的靶子。挂在 authGuard 后面是故意的：
// 真正大的那几个响应（/api/session/:id 936 KB）也都在登录之后
const BIG_JSON = { transcript: Array.from({ length: 400 }, (_, i) => ({ type: "assistant", at: 1789111685972 + i, events: [{ type: "text", text: "第 " + i + " 段正文，中文占三个字节，压缩比才有意义。".repeat(6) }] })) };
app.get("/api/big-json", (_req, res) => res.json(BIG_JSON));
app.get("/api/tiny-json", (_req, res) => res.json({ ok: true }));
app.get("/api/fake-sse", (_req, res) => { res.setHeader("Content-Type", "text/event-stream; charset=utf-8"); res.write("data: hi\n\n"); res.end(); });

const server = http.createServer(app);

/** 带 cookie 的极简请求器：配对这件事整条链都是靠 cookie 串起来的，得原样验 */
function req(method, url, { body, cookie, headers } = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({
      host: "127.0.0.1", port: server.address().port, method, path: url,
      headers: {
        ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(headers || {}),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(raw.toString("utf8")); } catch {}
        const setCookie = (res.headers["set-cookie"] || [])[0] || "";
        resolve({ status: res.statusCode, headers: res.headers, raw, json,
                  cookie: (/openworkbuddy_token=([^;]*)/.exec(setCookie) || [])[1] });
      });
    });
    r.on("error", () => resolve({ status: 0 }));
    if (data) r.write(data);
    r.end();
  });
}
const ck = (t) => "openworkbuddy_token=" + t;

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  // ================= 一、配对码本身 =================
  console.log("\n一、配对码：它是一把能直接开门的钥匙");
  A.register("boss", "hunter2hunter2");
  A.register("mate", "hunter2hunter2");

  const p1 = A.newPairCode("boss");
  eq(p1.code.length, A.PAIR_LEN, "配对码 8 位");
  ok([...p1.code].every((c) => A.PAIR_ALPHABET.includes(c)), "只用不会看错的字符（抠掉了 I L O 0 1）", p1.code);
  ok(!/[ILO01]/.test(p1.code), "★码里绝不出现 I L O 0 1★ 这串是要人照着念、照着敲的", p1.code);

  const p2 = A.newPairCode("boss");
  ok(p2.code !== p1.code, "每次生成都是新的");
  ok(!A.claimPair(p1.code), "★生成新码，旧码当场作废★ 手里攥着两个有效码，自己都说不清该念哪个");
  ok(!!A.claimPair(p2.code), "  ← 反向对照：新的那个能用");
  ok(!A.claimPair(p2.code), "★用完即焚★ 同一个码不给第二台机器用");

  // 大小写、横杠、空格：人念出来的码长什么样都有
  const p3 = A.newPairCode("boss");
  const messy = p3.code.slice(0, 4).toLowerCase() + " - " + p3.code.slice(4).toLowerCase();
  ok(!!A.claimPair(messy), "小写、空格、横杠都认（人念出来的码就长这样）", messy);

  // 过期。把那条记录的时间戳往回拨，比干等三分钟靠谱
  eq(A.PAIR_TTL_MS, 3 * 60 * 1000, "有效期 3 分钟");
  const p4 = A.newPairCode("boss");
  A.pairs.get(p4.code).at = Date.now() - A.PAIR_TTL_MS + 5000;
  ok(!!A.claimPair(p4.code), "  ← 反向对照：还差 5 秒到期，能用");
  const p5 = A.newPairCode("boss");
  A.pairs.get(p5.code).at = Date.now() - A.PAIR_TTL_MS - 1;
  ok(!A.claimPair(p5.code), "★过了三分钟就作废★ 一张贴在屏幕上忘了关的码，不该第二天还能开门");
  eq(A.pairs.size, 0, "过期的从内存里清掉，不越攒越多");

  // ================= 一·B、后台那个开关：默认是关的 =================
  // 「装上就能从外面连进来」这种默认不该由我们替用户做决定——他不一定知道自己
  // 刚把什么暴露到了局域网上。所以整条远程线默认关着，要用的人自己去后台打开。
  console.log("\n一·B、远程设备接入默认关着，开了才有这条线");
  const orgMod = require(path.join(ROOT, "org"));
  eq(orgMod.settingsOf(orgMod.getOrg(orgMod.DEFAULT_ORG)).remote_devices, false, "★默认关★");

  const boss = await req("POST", "/api/auth/login", { body: { username: "boss", password: "hunter2hunter2" } });
  eq(boss.status, 200, "先在「电脑上」登录");
  const bossCk = ck(boss.cookie);

  const offGen = await req("POST", "/api/devices/pair", { cookie: bossCk });
  eq(offGen.status, 403, "关着的时候，登录了也要不到配对码");
  eq(offGen.json.remote_off, true, "而且说清楚是被开关关掉的，不是「你没权限」——不然人会一直刷新重试");
  const offSt = await req("GET", "/api/devices/pair/status", { cookie: bossCk });
  eq(offSt.json.remote_off, true, "轮询那条也如实说，界面才画得出「这条线是关的」");
  // 直接在内存里摆一个码，绕过上面那道闸，验 claim 自己也拦得住
  const pairedCount = () => A.listDevices("boss").filter((d) => d.kind === "paired").length;
  const before = pairedCount(); // 前面几节用内部函数直接换过几条，这里只看这一次有没有多出来
  const sneak = A.newPairCode("boss");
  const offClaim = await req("POST", "/api/devices/claim", { body: { code: sneak.code, name: "偷偷连的" } });
  eq(offClaim.status, 403, "★就算手里有一个有效的码，关着的时候也换不出令牌★");
  eq(pairedCount(), before, "★换不出来就不许在设备表里留痕★ 留下的话，开关一开它就活了");
  A.dropPairCode("boss");

  orgMod.updateOrg(orgMod.DEFAULT_ORG, { settings: { remote_devices: true } }, "boss");
  eq(orgMod.settingsOf(orgMod.getOrg(orgMod.DEFAULT_ORG)).remote_devices, true, "后台打开它");

  // ================= 二、拿码换令牌 =================
  console.log("\n二、拿码换令牌（这条接口不需要登录——它就是用来代替登录的）");

  const gen = await req("POST", "/api/devices/pair", { cookie: bossCk });
  eq(gen.status, 200, "已登录的机器能要到配对码");
  ok(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(gen.json.pretty), "界面上显示成 XXXX-XXXX", gen.json.pretty);

  const nope = await req("POST", "/api/devices/pair");
  eq(nope.status, 401, "★没登录的机器要不到配对码★ 能白拿码的话这道门等于没有");

  const phone = await req("POST", "/api/devices/claim", {
    body: { code: gen.json.pretty, name: "我的 iPhone" },
    headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" },
  });
  eq(phone.status, 200, "手机拿码换到了令牌");
  ok(!!phone.cookie, "换回来的是一条 cookie");
  const me = await req("GET", "/api/whoami", { cookie: ck(phone.cookie) });
  eq(me.json && me.json.user, "boss", "★这条令牌真能当登录用★ 而密码一次都没离开过电脑");

  const again = await req("POST", "/api/devices/claim", { body: { code: gen.json.pretty } });
  eq(again.status, 401, "★同一个码第二次换不出来★");

  // ================= 三、撞码要有闸 =================
  console.log("\n三、撞码：8 位码没有闸就是纸糊的");
  let last = null;
  for (let i = 0; i < 8; i++) last = await req("POST", "/api/devices/claim", { body: { code: "ZZZZZZZZ" } });
  eq(last.status, 429, "★连撞几次就被限速★ 不拦的话一台机器慢慢撞总能撞上");
  ok(/秒后再试/.test(last.json.error || ""), "还告诉他要等多久", last.json);

  // ================= 四、设备列表 =================
  console.log("\n四、已授权设备列表");
  const list = await req("GET", "/api/devices", { cookie: bossCk });
  eq(list.status, 200, "列得出来");
  const devs = list.json.devices;
  ok(devs.length >= 2, "电脑那条会话 + 手机那台，都在", devs.length);
  const ip = devs.find((d) => d.name === "我的 iPhone");
  ok(!!ip, "手机按配对时填的名字显示");
  eq(ip.kind, "paired", "标成「配对设备」，跟浏览器会话分得开");
  ok(devs.some((d) => d.current), "标出了「就是你现在用的这台」");

  const tokens = Object.keys(A.loadUsers().tokens);
  ok(devs.every((d) => !tokens.includes(d.id)), "★列表里的 id 不是令牌★ 否则「看一眼我的设备」会顺手把每台设备的钥匙抄一份到这个页面上");
  ok(devs.every((d) => d.id === A.deviceId(tokens.find((t) => A.deviceId(t) === d.id))), "  ← 反向对照：id 确实是那条令牌算出来的");

  // UA 认设备
  eq(A.deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile Safari/604.1"), "iPhone · Safari", "认得出 iPhone + Safari");
  eq(A.deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"), "Mac · Chrome", "★Chrome 的 UA 里有 Safari★ 判反了就全成 Safari");
  eq(A.deviceLabel("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120 Safari/537.36 Edg/120"), "Windows · Edge", "★Edge 的 UA 里有 Chrome★ 同上");
  eq(A.deviceLabel(""), "未知设备", "猜不出就说猜不出，不编");

  // ================= 五、踢设备 =================
  console.log("\n五、手机丢了要能当场断干净");
  const phoneId = ip.id;
  const kick = await req("DELETE", "/api/devices/" + phoneId, { cookie: bossCk });
  eq(kick.status, 200, "踢掉手机");
  const after = await req("GET", "/api/whoami", { cookie: ck(phone.cookie) });
  eq(after.status, 401, "★那条令牌当场作废★ 等它 90 天自己过期等于没踢");

  const gone = await req("DELETE", "/api/devices/" + phoneId, { cookie: bossCk });
  eq(gone.status, 404, "再踢一次说找不到，不装作成功了");

  // 越权：拿别人的设备 id 来踢
  const mate = await req("POST", "/api/auth/login", { body: { username: "mate", password: "hunter2hunter2" } });
  const mateCk = ck(mate.cookie);
  const bossDevs = (await req("GET", "/api/devices", { cookie: bossCk })).json.devices;
  const cross = await req("DELETE", "/api/devices/" + bossDevs[0].id, { cookie: mateCk });
  eq(cross.status, 404, "★拿别人的设备 id 过来踢不动★ 只在自己名下找");
  const stillThere = (await req("GET", "/api/devices", { cookie: bossCk })).json.devices;
  ok(stillThere.some((d) => d.id === bossDevs[0].id), "  ← 反向对照：boss 那台还好好的");

  const mateList = (await req("GET", "/api/devices", { cookie: mateCk })).json.devices;
  ok(mateList.every((d) => d.name !== "我的 iPhone"), "★列表只列自己的★ 看不到别人有几台设备");

  // ================= 五·B、把开关关掉 = 一键断干净 =================
  // 这一节是「这个开关是不是真的」的全部。只拦新配对的话它就是个摆设：
  // 管理员在后台把它关了，以为丢在公司的那台手机已经进不来了，其实它手上那条令牌
  // 还能一直用到 90 天后过期。所以关掉的那一刻，**已经连上的也得断**。
  console.log("\n五·B、后台把开关关掉，已经连上的设备一起断");
  const pc2 = A.newPairCode("boss");
  const tab = A.claimPair(pc2.code, { name: "会议室那台 iPad" });
  eq((await req("GET", "/api/whoami", { cookie: ck(tab.token) })).status, 200, "先确认它现在进得来");

  orgMod.updateOrg(orgMod.DEFAULT_ORG, { settings: { remote_devices: false } }, "boss");
  const kicked = await req("GET", "/api/whoami", { cookie: ck(tab.token) });
  eq(kicked.status, 401, "★开关一关，扫码连上来的那台下一次请求就被踢下线★");
  eq(kicked.json.remote_off, true, "并且说清楚为什么，不然用户以为是自己被停用了");
  eq((await req("GET", "/api/whoami", { cookie: bossCk })).status, 200,
    "★反向对照：在电脑上正常登录的那条不受影响★ 这个开关管的是远程设备，不是所有人");
  orgMod.updateOrg(orgMod.DEFAULT_ORG, { settings: { remote_devices: true } }, "boss");
  eq((await req("GET", "/api/whoami", { cookie: ck(tab.token) })).status, 200,
    "开关拨回来，那台又进得来了（令牌本身没被撤，只是被闸挡着）");

  // ================= 六、账号状态 =================
  console.log("\n六、码发出去之后人被停用了");
  const dis = A.newPairCode("mate");
  const stt = A.loadUsers();
  stt.users.find((u) => u.username === "mate").status = "disabled";
  A.saveUsers(stt);
  ok(!A.claimPair(dis.code), "★码还在手里，人已经不该进来了★ 停用必须在换令牌那一刻再判一次");

  // ================= 七、浏览器会话别把手机顶掉 =================
  console.log("\n七、在电脑上多开浏览器，不该把配对好的手机顶下去");
  const pc = A.newPairCode("boss");
  const paired = A.claimPair(pc.code, { name: "客厅 iPad" });
  ok(!!paired, "先配一台 iPad");
  for (let i = 0; i < A.MAX_DEVICES + 4; i++) A.issueToken("boss"); // 电脑上反复登录
  const tok = A.loadUsers().tokens;
  ok(!!tok[paired.token], "★开了十几次浏览器，iPad 还在★ 两类各算各的配额");
  const sessions = Object.values(tok).filter((i) => i.user === "boss" && i.kind !== "paired").length;
  ok(sessions <= A.MAX_DEVICES, "浏览器会话自己那头照样封顶，账本不会无限长", sessions);

  // ================= 八、静态资源压缩 =================
  console.log("\n八、静态资源压缩：别让人在手机上等十几秒");
  const big = "// " + "x".repeat(200) + "\n".repeat(1) + 'const a = "压缩测试";\n'.repeat(4000);
  fs.writeFileSync(path.join(ASSETS, "big.js"), big);
  fs.writeFileSync(path.join(ASSETS, "tiny.js"), "let a=1;\n");
  fs.mkdirSync(path.join(TMP, "vendor"), { recursive: true });
  fs.writeFileSync(path.join(TMP, "vendor", "lib.js"), big);
  fs.writeFileSync(path.join(ASSETS, "pic.png"), Buffer.alloc(40000, 7));

  const br = await req("GET", "/big.js", { headers: { "Accept-Encoding": "br, gzip" } });
  eq(br.headers["content-encoding"], "br", "认 brotli 的就发 brotli");
  ok(br.raw.length < Buffer.byteLength(big) / 4, "体积掉到四分之一以下", { 原文: Buffer.byteLength(big), 压后: br.raw.length });
  eq(zlib.brotliDecompressSync(br.raw).toString("utf8"), big, "★解回来跟原文一个字节不差★ 压坏了比慢更糟");
  eq(br.headers["vary"], "Accept-Encoding", "★带 Vary★ 少了它，中间任何一层缓存都可能把压过的发给不认压缩的客户端");

  const gz = await req("GET", "/big.js", { headers: { "Accept-Encoding": "gzip" } });
  eq(gz.headers["content-encoding"], "gzip", "只认 gzip 的就发 gzip");
  eq(zlib.gunzipSync(gz.raw).toString("utf8"), big, "gzip 也解得回来");

  const q0 = await req("GET", "/big.js", { headers: { "Accept-Encoding": "br;q=0, gzip" } });
  eq(q0.headers["content-encoding"], "gzip", "★br;q=0 是「明确不要」★ 只按子串判会给他发 brotli，那边直接看到乱码");

  const plain = await req("GET", "/big.js", { headers: { "Accept-Encoding": "identity" } });
  ok(!plain.headers["content-encoding"], "不认压缩的客户端拿到原文");
  eq(plain.raw.toString("utf8"), big, "  ← 而且是完整的原文");

  const vend = await req("GET", "/v/lib.js", { headers: { "Accept-Encoding": "br" } });
  eq(vend.headers["content-encoding"], "br", "★vendor 那几个也压到了★ 首屏最大的一块就在那儿（JointJS 463 KB），漏了等于白做");

  const tiny = await req("GET", "/tiny.js", { headers: { "Accept-Encoding": "br" } });
  ok(!tiny.headers["content-encoding"], "太小的不压：省下的还不够那几行响应头");
  const png = await req("GET", "/pic.png", { headers: { "Accept-Encoding": "br" } });
  ok(!png.headers["content-encoding"], "图片不碰：本来就压过了，再压一遍是纯烧 CPU");

  // 改文件 → ETag 必须跟着变
  const e1 = (await req("GET", "/big.js", { headers: { "Accept-Encoding": "br" } })).headers.etag;
  const c304 = await req("GET", "/big.js", { headers: { "Accept-Encoding": "br", "If-None-Match": e1 } });
  eq(c304.status, 304, "没变就回 304，不重发");
  await new Promise((r) => setTimeout(r, 12));
  fs.writeFileSync(path.join(ASSETS, "big.js"), big + "// 又改了一行\n");
  const e2 = await req("GET", "/big.js", { headers: { "Accept-Encoding": "br", "If-None-Match": e1 } });
  eq(e2.status, 200, "★改了文件就得重发★ 拿着缓存不放会把人调试到怀疑人生");
  ok(zlib.brotliDecompressSync(e2.raw).toString("utf8").endsWith("// 又改了一行\n"), "  ← 而且发的是改完那份");

  // 目录穿越
  fs.writeFileSync(path.join(TMP, "secret.js"), "秘密\n".repeat(400));
  const esc = await req("GET", "/../secret.js", { headers: { "Accept-Encoding": "br" } });
  ok(esc.status !== 200 || !/秘密/.test(esc.raw.toString("utf8")), "★往上穿目录拿不到挂载目录外的文件★", esc.status);
  const esc2 = await req("GET", "/%2e%2e/secret.js", { headers: { "Accept-Encoding": "br" } });
  ok(esc2.status !== 200 || !/秘密/.test(esc2.raw.toString("utf8")), "编码过的 .. 也一样", esc2.status);

  // 这一层绝不能碰动态响应（SSE 会被它攒成块）
  const src = srcLib.src("server");
  ok(/app\.use\(staticCompress\(\[/.test(src), "server.js 真的挂上了这层");
  ok(src.indexOf("app.use(staticCompress([") < src.indexOf('app.use(express.static(appPath("public")))'),
     "★摆在 express.static 前面★ 摆后面就永远轮不到它");
  ok(!/require\("compression"\)/.test(src), "★没有引入通用压缩中间件★ 那种会把 SSE 攒成块——对话从「一个字一个字出」变成「卡住然后哗一下全出来」");

  // ================= 八·B、动态 JSON 压缩 =================
  // 上面那层只碰磁盘文件。可这台服务器上最大的一个响应偏偏是动态的：
  // GET /api/session/:id 实测 936 KB（本机真实会话，18 个回合 1184 个事件），
  // 用户**每切一次任务就整下一遍**。手机上、隧道里，这就是每切一次任务等一次。
  console.log("\n八·B、动态 JSON 也得压：切一次任务别再裸奔 936 KB");

  // 前面几节把 boss 那条会话踢过了，这里重新登一次拿把干净的钥匙
  const jboss = await req("POST", "/api/auth/login", { body: { username: "boss", password: "hunter2hunter2" } });
  const jck = ck(jboss.cookie);

  const jbr = await req("GET", "/api/big-json", { cookie: jck, headers: { "Accept-Encoding": "br, gzip" } });
  eq(jbr.status, 200, "拿得到");
  eq(jbr.headers["content-encoding"], "br", "★大 JSON 也压★ 这条是这次优化的正主");
  eq(jbr.headers["vary"], "Accept-Encoding", "  ← 同样要 Vary，理由跟静态那层一模一样");
  const plainJson = JSON.stringify(BIG_JSON);
  eq(zlib.brotliDecompressSync(jbr.raw).toString("utf8"), plainJson, "★解回来一个字节不差★");
  ok(jbr.raw.length < Buffer.byteLength(plainJson) / 3, "体积掉到三分之一以下",
     { 原文: Buffer.byteLength(plainJson), 压后: jbr.raw.length });

  const jgz = await req("GET", "/api/big-json", { cookie: jck, headers: { "Accept-Encoding": "gzip" } });
  eq(jgz.headers["content-encoding"], "gzip", "只认 gzip 的发 gzip");
  eq(zlib.gunzipSync(jgz.raw).toString("utf8"), plainJson, "  ← gzip 也解得回来");

  const jplain = await req("GET", "/api/big-json", { cookie: jck, headers: { "Accept-Encoding": "identity" } });
  ok(!jplain.headers["content-encoding"], "★不认压缩的客户端拿到原文★ 反向对照：压缩不许变成「只有新浏览器能用」");
  eq(jplain.raw.toString("utf8"), plainJson, "  ← 而且是完整的原文");

  const jtiny = await req("GET", "/api/tiny-json", { cookie: jck, headers: { "Accept-Encoding": "br" } });
  ok(!jtiny.headers["content-encoding"], "小响应不压：接口大多数是几百字节，压了纯亏");
  ok(/^\{"ok":true\}$/.test(jtiny.raw.toString("utf8").trim()), "  ← 小响应原样发得出去");

  // 这一条是整层的安全绳：碰了 SSE，「一个字一个字出」就会变成「卡住然后哗一下全出来」
  const jsse = await req("GET", "/api/fake-sse", { cookie: jck, headers: { "Accept-Encoding": "br, gzip" } });
  ok(!jsse.headers["content-encoding"], "★SSE 一个字节都不碰★ 压它等于把「正在打字」变成「卡住再哗一下」");
  eq(jsse.raw.toString("utf8"), "data: hi\n\n", "  ← 流原样出去");

  // 压缩必须异步。同步版压那 936 KB 实测卡住事件循环 33 ms——
  // 而这 33 ms 里多半正有一条 SSE 在吐字，等于「谁切了下任务，所有人卡一下」
  const jsrc = fs.readFileSync(path.join(ROOT, "json-compress.js"), "utf8");
  ok(!/zlib\s*\.\s*(brotliCompressSync|gzipSync|deflateSync)\s*\(/.test(jsrc),
     "★压缩走异步，不许 Sync★ 同步压 936 KB 要堵住事件循环 33ms，正在推的 SSE 会当场卡一下");
  ok(/zlib\s*\.\s*brotliCompress\s*\(/.test(jsrc) && /zlib\s*\.\s*gzip\s*\(/.test(jsrc),
     "  ← 反向对照：异步那两个得真在（别把断言改绿成「两个都没有」）");
  const ssrc = srcLib.src("server");
  ok(/app\.use\(jsonCompress\(\)\)/.test(ssrc), "server.js 真的挂上了这层");
  ok(ssrc.indexOf("app.use(jsonCompress())") < ssrc.indexOf('app.get("/api/ping"'),
     "★摆在所有 /api 路由前面★ 摆后面就永远轮不到它");

  // /api/ping 只许注册一次，而且不能被登录闸挡住。
  // 这个文件里曾经有一模一样的两处（一处在闸前、一处在闸后）。Express 只派给先注册的，
  // 所以行为上看不出毛病——直到有人清理重复时留了后面那份。
  // 免登录靠两把各自独立的锁：注册在 authGuard 之前，以及 account.js 的 PUBLIC_API 里列着它。
  // 只剩一把也还能应答，所以下面判的是「至少还剩一把」；两把一起没了，`openworkbuddy doctor`
  // 会把「自己已经开着」误报成「端口被别的程序占了」，Electron 壳也认不出哪个端口是自己的——
  // 两件事都不报错，只会变得莫名其妙。
  const pings = (ssrc.match(/app\.get\("\/api\/ping"/g) || []).length;
  eq(pings, 1, "server.js 里 /api/ping 注册了不止一次：后注册的那份永远走不到，清理时留错一份就会挪到登录闸后面");
  const pingBeforeGuard = ssrc.indexOf('app.get("/api/ping"') < ssrc.indexOf("app.use(account.authGuard)");
  const pingInPublicSet = /PUBLIC_API\s*=\s*new Set\(\[[^\]]*"\/api\/ping"/.test(
    fs.readFileSync(path.join(ROOT, "account.js"), "utf8"));
  ok(pingBeforeGuard || pingInPublicSet,
     "★/api/ping 得免登录★ 既没抢在 authGuard 前注册，account.js 的 PUBLIC_API 里也没列它：doctor 会把「已经开着」误报成「端口被占」，壳也找不回自己的窗口");
  ok(pingBeforeGuard && pingInPublicSet,
     "  ← 反向对照：今天两把锁都在（哪天只剩一把，上面那条就成了单点撑着，在这儿先看见）");

  // ================= 九、扫码 + 「连上没有」 =================
  console.log("\n九、二维码和「到底连上没有」");

  // 扫码要的是一个能落地的地址。localhost 编进二维码等于编了个死链——
  // 手机扫出来只会去找它自己
  const o1 = A.pairOrigin({ headers: { host: "buddy.example.com" } });
  eq(o1, "http://buddy.example.com", "有正经域名就用它");
  const o2 = A.pairOrigin({ headers: { host: "buddy.example.com", "x-forwarded-proto": "https" } });
  eq(o2, "https://buddy.example.com", "反代说这是 https，就得编 https——编成 http 手机点进去是空白页");
  const o3 = A.pairOrigin({ headers: { host: "localhost:3800" } });
  ok(!/localhost|127\.0\.0\.1/.test(o3), "★localhost 不能编进二维码★ 手机扫了只会去找它自己", o3);
  ok(o3 === "" || /^http:\/\/(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(o3),
     "  ← 换成本机的内网地址，或者干脆不给（宁可让他手敲，也别给个扫了打不开的码）", o3);

  // pairStatus：等待中 / 连上了 / 陈旧记录
  A.claimed.delete("boss");
  A.dropPairCode("boss");
  eq(A.pairStatus("boss").pairing, false, "没在配的时候 pairing=false");
  const pz = A.newPairCode("boss");
  const s1 = A.pairStatus("boss");
  eq(s1.pairing, true, "出了码就是等待中");
  eq(s1.claimed, null, "还没人连上");
  eq(s1.expires_at, pz.expires_at, "倒计时的终点跟码本身对得上");

  A.claimPair(pz.code, { ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1" });
  const s2 = A.pairStatus("boss");
  ok(s2.claimed && s2.claimed.name === "iPhone · Safari", "连上的瞬间报得出是哪台", s2.claimed && s2.claimed.name);
  eq(s2.pairing, false, "码已经烧掉了");

  // 这条是真踩过的坑：上一轮连上的记录留在内存里，两分钟内再出一张新码，
  // 生成的那一刻就显示「✓ 已连接」——连的是上一台，人却以为这张码已经被扫了
  const pz2 = A.newPairCode("boss");
  eq(A.pairStatus("boss").claimed, null, "★出新码就把上一轮的「已连接」清掉★ 不清的话新码一出现就自称配好了");
  eq(A.pairStatus("boss").pairing, true, "  ← 而且状态是「等着呢」");
  A.dropPairCode("boss");

  // 别人的连接记录不该串台
  A.claimed.delete("mate");
  eq(A.pairStatus("mate").claimed, null, "看不到别人的配对状态");

  // 走 HTTP：出码这条要带上二维码
  const bossTok2 = A.issueToken("boss", { kind: "session" });
  const qr = await req("POST", "/api/devices/pair", { headers: { Cookie: ck(bossTok2) } });
  eq(qr.status, 200, "出码接口通");
  ok(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(qr.json.pretty), "码是给人念的：中间断一道", qr.json.pretty);
  ok(qr.json.qr === "" || /^data:image\/png;base64,/.test(qr.json.qr), "二维码是内嵌的 data URL（不额外发一次请求，也不落盘）");
  ok(!qr.json.qr || qr.json.qr.length > 500, "  ← 而且真有内容");
  if (qr.json.url) ok(qr.json.url.includes(qr.json.code), "扫码地址里带着码，手机扫完不用敲");

  const st = await req("GET", "/api/devices/pair/status", { headers: { Cookie: ck(bossTok2) } });
  eq(st.status, 200, "状态接口通");
  eq(st.json.pairing, true, "  ← 报「等着呢」");
  const stAnon = await req("GET", "/api/devices/pair/status");
  eq(stAnon.status, 401, "★没登录问不出别人配到哪一步★");

  // ================= 十、响应头 =================
  console.log("\n十、几条响应头（放公网上就不只是本机自己玩了）");
  const srcS = srcLib.src("server");
  ok(/Referrer-Policy["\s:,]+.*no-referrer/.test(srcS),
     "★no-referrer★ 配对码从 ?pair= 进来，带 Referer 的话这页上任何外链都会把码捎出去");
  ok(/X-Content-Type-Options["\s:,]+.*nosniff/.test(srcS),
     "★nosniff★ 存成 .txt 的 html 被当页面执行就是同源 XSS");
  ok(/X-Frame-Options["\s:,]+.*SAMEORIGIN/.test(srcS), "★SAMEORIGIN★ 别让人套个 iframe 骗点击");
  ok(/frame-ancestors 'self'/.test(srcS) && /object-src 'none'/.test(srcS), "CSP 里那几条零风险的也带上了");
  // 完整 CSP 是故意没上的：blob: 预览页会继承它，加上 script-src 就等于禁掉
  // AI 生成网页里的图表库。这条断言是把「故意不做」钉住，免得以后有人顺手加上
  const cspLine = (/setHeader\("Content-Security-Policy", "([^"]*)"\)/.exec(srcS) || [])[1] || "";
  ok(cspLine, "  ← CSP 那一行找得到", cspLine);
  ok(!/script-src|connect-src/.test(cspLine),
     "★CSP 里不含 script-src / connect-src★ blob: 预览会继承这条，加上它 AI 生成的网页引个图表库就白屏", cspLine);

  // ================= 十一、首屏别背着用不上的东西 =================
  console.log("\n十一、首屏重量");
  const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  const tags = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  // 画布本体切成了几片：入口 app-07-canvas.js + 各片 app-07-canvas-*.js。名单从磁盘上读、不手抄——
  // 以后再切一片，这里自动跟上，不会有一片悄悄挂回首屏、或者没人拉
  const canvasParts = fs.readdirSync(path.join(ROOT, "public", "js")).filter((f) => /^app-07-canvas(-[\w-]+)?\.js$/.test(f)).sort();
  ok(canvasParts.includes("app-07-canvas.js") && canvasParts.length > 1, "画布那几片都读到了（入口 + 拆出来的）", canvasParts.join());
  for (const heavy of ["joint.min.js", "dagre.min.js", ...canvasParts]) {
    ok(!tags.some((t) => t.includes(heavy)),
       `★${heavy} 不在首屏★ 画布是个标签页，来聊天的人不该为它多等`, tags.filter((t) => t.includes(heavy)).join());
  }
  // 摘出去了就得有人负责把它拉回来，否则画布直接打不开
  const a3 = fs.readFileSync(path.join(ROOT, "public", "js", "app-03.js"), "utf8");
  ok(/renderCanvasLazy/.test(a3), "画布入口换成了按需加载那条");
  for (const dep of ["/vendor/joint/joint.min.js", "/vendor/dagre/dagre.min.js", ...canvasParts.map((f) => "js/" + f)]) {
    ok(a3.includes(`"${dep}"`), `  ← 按需加载里带上了 ${dep}`);
  }
  const canvasOrder = [...a3.matchAll(/loadScriptOnce\("js\/(app-07-canvas[\w-]*\.js)"\)/g)].map((m) => m[1]);
  ok(canvasOrder[canvasOrder.length - 1] === "app-07-canvas.js",
     "入口 app-07-canvas.js 排在最后拉（测试按加载顺序把几片拼回原来的样子，入口原本就在文件末尾）", canvasOrder.join(" → "));
  // 几片是同时下载的，动态插进去的脚本默认谁先下完谁先跑。关掉 async 才按插进去的先后执行——
  // 前面那片的常量、画布状态得先声明好，后面那片才用得上。这行被删了现在照样能跑，哪天有一片在顶层用了前一片的东西才炸
  const lsoAt = a3.indexOf("function loadScriptOnce("), lsoEnd = a3.indexOf("\n}\n", lsoAt);
  ok(lsoAt >= 0 && lsoEnd > lsoAt && /\n\s*el\.async = false;/.test(a3.slice(lsoAt, lsoEnd)),
     "★画布几片按数组顺序执行★ loadScriptOnce 里关掉了 async（不关就是谁先下完谁先跑）");
  // 路径写错了的话，画布点进去永远是「正在载入」——这三条是服务端真的认的路
  ok(/app\.get\("\/vendor\/joint\/joint\.min\.js"/.test(srcS), "joint 那条路由还在（按需加载要靠它）");
  ok(/app\.get\("\/vendor\/dagre\/dagre\.min\.js"/.test(srcS), "dagre 那条路由还在");
  ok(fs.existsSync(path.join(ROOT, "public", "js", "app-07-canvas.js")), "画布本体在 public/js 下，express.static 够得着");
  // 加载失败要能重试：把 Promise 留在缓存里，第一次没网之后就永远好不了
  ok(/scriptCache\.delete\(src\)/.test(a3), "★加载失败要把缓存清掉★ 不清的话第一次没网，后面有网了也永远重试不了");

  console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
});
