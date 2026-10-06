// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 行程卡：模型写的 ```itinerary → 网页上的地图卡片 / 飞书微信命令行里的文字行程。
 *
 *   node test/trip-card.js
 *
 * 不联网：高德、Nominatim、Wikidata、瓦片、图床全换成 127.0.0.1 上的一个假服务，
 * 喂的是各家文档上那个形状。测的是我们这边有没有按人家的规矩发、按人家的形状收。
 *
 * 盯的几件事：
 *   1. 数据口径有两份（src/util/itinerary.js、public/tripcard.js；坐标换算 src/util/geo-coords.js 也是），
 *      同一批样例两边各跑一遍，答案必须一字不差。改一边忘了另一边，这里当场红。
 *   2. 高德 Key 不出现在任何返回给前端的东西里：报错、缓存文件、/api/geo/config。
 *   3. 「埃菲尔铁塔」在高德能搜出杭州那座仿建的——城市对不上的结果不要，改去 OpenStreetMap 查。
 *   4. 每天打高德的上限到了就不再打；查过的地方第二次不打外部接口。
 *   5. 图片代理只认名单里的图床，每一跳跳转都重新对名单——不然它就是一个替任何人请求任意地址的代理。
 *   6. 飞书 / 微信 / 命令行看不了卡片：围栏换成按天排好的文字；解不开的原样留着，不吞内容。
 */

const HOME = require("./lib/own-home")("trip-card");
const fs = require("fs");
const path = require("path");
const http = require("http");
const vm = require("vm");
const { mod } = require("./lib/mod");

const DATA = path.join(HOME, "data");
process.env.OPENWORKBUDDY_DATA_DIR = DATA;

const itinerary = require(mod("itinerary"));
const coords = require(mod("geo-coords"));
const places = require(mod("places"));
const tiles = require(mod("tiles"));
const { createGeoRouter } = require(mod("routes/geo"));
const imReply = require(mod("im-reply"));
const mdTty = require(mod("md-tty"));
const ROOT = path.join(__dirname, "..");

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? "  ← " + JSON.stringify(extra) : ""}`); }
}
function eq(got, want, name) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  ok(a === b, name, a === b ? undefined : { got, want });
}
async function rejects(p, re, name) {
  try { await p; ok(false, name, "没抛错"); }
  catch (e) { ok(re.test(String(e && e.message)), name, { msg: e && e.message, status: e && e.status }); return e; }
}

// ---------------- 前端那份：public/tripcard.js 在没有 document 的沙箱里跑 ----------------
const FRONT_SRC = fs.readFileSync(path.join(ROOT, "public", "tripcard.js"), "utf8");
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(FRONT_SRC, sandbox, { filename: "tripcard.js" });
const TC = sandbox.window.TripCard;

const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);

// 提示词里那段示例就是模型照着抄的样子，拿它当头一个样例
const PROMPT_EXAMPLE = (() => {
  const lines = itinerary.PROMPT_BLOCK.split("\n");
  const i = lines.indexOf("```itinerary");
  return lines.slice(i + 1, lines.indexOf("```", i + 1)).join("\n");
})();

const LONG = "长".repeat(60);
const SAMPLES = [
  PROMPT_EXAMPLE,
  '{"days":[{"stops":["翠湖公园","南强街",]},]}',
  '{"name":"大理两日","destination":"大理","itinerary":[{"theme":"古城","desc":"慢逛","places":[{"place":"大理古城","when":"上午","desc":"走走","type":"古城","address":"大理市"}]}]}',
  '[[{"poi":"A"}],{"day":"周六","schedule":[{"title":"B","slot":"9:30","tips":"早去"}]}]',
  JSON.stringify({ title: LONG, days: Array.from({ length: 20 }, (_, d) => ({ title: LONG, summary: LONG.repeat(4), stops: Array.from({ length: 20 }, (_, i) => ({ name: `${LONG}${d}-${i}`, note: LONG.repeat(5), time: "上午上午上午上午上午上午上午上午上午", kind: LONG, city: LONG, addr: LONG.repeat(2) })) })) }),
  '{"days":[{"stops":[{"name":123,"time":9},{"name":"  翠湖\\n公园  "}]}]}',
  '{"days":[{"stops":[{"name":""},null,5,{"name":"有名"}]},{"stops":[]},"x"]}',
  "", "not json", "{'days':[]}", '{"days":[]}', '{"days":[{"stops":[]}]}', "[1,2]", "null", '"字符串"', '{"days":"x"}',
  '{"plan":[{"items":[{"name":"<img src=x onerror=alert(1)>","note":"\\"引号\\" & <b>"}]}]}',
];
const TIMES = ["上午", "9:30", "10：30", "12:00", "14点", "18:30", "20:00", "3:00", "早餐", "lunch", "Sunset", "夜宵", "", "全天", "下午茶", "傍晚"];
const PTS = [[102.7, 25.04], [116.4074, 39.9042], [121.4737, 31.2304], [121.5, 25.03], [114.17, 22.3], [126.98, 37.57],
  [2.2945, 48.8584], [-74.006, 40.7128], [105.85, 21.03], [87.6, 43.8], [131.9, 43.1], [91.1, 29.65], [0, 0]];

(async () => {
  // ================= 一、数据口径 =================
  console.log("\n一、数据口径（src/util/itinerary.js）");
  {
    const it = itinerary.parse(PROMPT_EXAMPLE);
    ok(it && it.days.length === 1 && it.days[0].stops.length === 2, "提示词里给模型抄的那段示例本身解得开（1 天 2 站）", it);
    eq(it && it.days[0].stops[0], { name: "翠湖公园", time: "上午", note: "湖边散步、喝咖啡", kind: "公园", city: "", addr: "" }, "一站的字段收齐，没写的给空串");
    ok(it && it.city === "昆明" && it.title === "昆明三日游", "行程名、城市读到");

    const trail = itinerary.parse('{"days":[{"stops":["翠湖公园","南强街",]},]}');
    ok(trail && trail.days[0].stops.length === 2, "多一个收尾逗号照样解得开（模型最常犯的错）");
    ok(itinerary.parse("{'days':[]}") === null, "单引号不修：猜着修出一份错行程，比显示原文更糟");

    const alias = itinerary.parse(SAMPLES[2]);
    eq(alias && { t: alias.title, c: alias.city, d: alias.days[0].title, s: alias.days[0].summary, p: alias.days[0].stops[0] },
      { t: "大理两日", c: "大理", d: "古城", s: "慢逛", p: { name: "大理古城", time: "上午", note: "走走", kind: "古城", city: "", addr: "大理市" } },
      "字段别名都认：name/destination/itinerary/theme/desc/places/place/when/type/address");
    const arr = itinerary.parse(SAMPLES[3]);
    ok(arr && arr.days.length === 2 && arr.days[1].label === "周六" && arr.days[1].stops[0].time === "9:30" && arr.days[1].stops[0].note === "早去",
      "顶层是数组、一天直接是数组、day 写成字符串当标签、schedule/title/slot/tips 都认", arr);

    const big = itinerary.parse(SAMPLES[4]);
    const L = itinerary.LIMIT;
    ok(big.days.length === L.days && big.days.every((d) => d.stops.length === L.stops), `封顶：最多 ${L.days} 天、每天 ${L.stops} 站`);
    const s0 = big.days[0].stops[0];
    ok(s0.name.length === L.name && s0.name.endsWith("…") && s0.note.length === L.note && s0.time.length === L.time
      && s0.kind.length === L.kind && s0.city.length === L.city && s0.addr.length === L.addr, "每个字段按上限截断，末尾带「…」");
    ok(big.title.length === L.title && big.days[0].summary.length === L.summary, "标题、每天的概述也截");

    const num = itinerary.parse(SAMPLES[5]);
    ok(num.days[0].stops[0].name === "123" && num.days[0].stops[0].time === "9" && num.days[0].stops[1].name === "翠湖 公园", "数字收成字符串；换行和多余空白收成一个空格");
    const junk = itinerary.parse(SAMPLES[6]);
    ok(junk && junk.days.length === 1 && junk.days[0].stops.length === 1 && junk.days[0].stops[0].name === "有名", "没名字的站、空的天、乱七八糟的元素都丢掉，剩下的照用");
    const nulls = ["", "not json", '{"days":[]}', '{"days":[{"stops":[]}]}', "[1,2]", "null", '"字符串"', '{"days":"x"}'].filter((s) => itinerary.parse(s) !== null);
    ok(nulls.length === 0, "认不出来的一律回 null（调用方照普通代码块显示）", nulls);

    eq(TIMES.map(itinerary.segmentOf), ["上午", "上午", "上午", "中午", "下午", "傍晚", "晚上", "晚上", "上午", "中午", "傍晚", "晚上", "", "", "下午", "傍晚"],
      "时间 → 上午 / 中午 / 下午 / 傍晚 / 晚上；认不出来回空串");

    const md = itinerary.toMarkdown(itinerary.parse('{"title":"T","days":[{"title":"老城","summary":"慢逛","stops":[{"time":"上午","name":"A","note":"喝咖啡"},{"name":"B"}]},{"label":"周日","stops":["C"]}]}'));
    eq(md, "**T**\n\n**第1天 · 老城**\n慢逛\n- 上午 · A：喝咖啡\n- B\n\n**周日**\n- C", "文字版：标题、第几天 · 主题、概述、每站一行");

    const two = "前面\n\n```itinerary\n" + PROMPT_EXAMPLE + "\n```\n\n中间\n\n```ITINERARY  \n{\"days\":[[\"X\"]]}\n```\n后面";
    const conv = itinerary.fencesToMarkdown(two);
    ok(!/```/.test(conv) && conv.includes("**第1天 · 老昆明慢逛**") && conv.includes("- 第") === false && conv.includes("- X") && conv.startsWith("前面") && conv.endsWith("后面"),
      "正文里几段围栏都换成文字（大写语言名、语言名后面带空格也认），前后文一字不动", conv);
    const bad = "看这个\n```itinerary\n{坏的\n```\n完";
    ok(itinerary.fencesToMarkdown(bad) === bad, "解不开的那段原样留着：宁可贴原文，不吞内容");
    const plain = "没有围栏的正文 ```js\nx\n```";
    ok(itinerary.fencesToMarkdown(plain) === plain, "没有行程卡的正文原样返回");
  }

  // ================= 二、前端那份跟服务端那份对答案 =================
  console.log("\n二、public/tripcard.js 跟 src/util/ 对答案");
  {
    const diff = SAMPLES.filter((s) => JSON.stringify(itinerary.parse(s)) !== JSON.stringify(TC.parse(s)));
    ok(diff.length === 0, `parse：${SAMPLES.length} 个样例两边一字不差`, diff.map((s) => s.slice(0, 60)));
    eq(JSON.parse(JSON.stringify(TC.LIMIT)), itinerary.LIMIT, "长度上限 LIMIT 两边一样");
    eq(TIMES.map((t) => TC.segmentOf(t)), TIMES.map(itinerary.segmentOf), "segmentOf 两边一样");
    eq([TC.dayLabel({ label: "" }, 0), TC.dayLabel({ label: "周六" }, 2)], [itinerary.dayLabel({ label: "" }, 0), itinerary.dayLabel({ label: "周六" }, 2)], "dayLabel 两边一样");
    const cd = [];
    for (const [x, y] of PTS) {
      const pairs = [
        ["wgsToGcj", TC.wgsToGcj(x, y), coords.wgsToGcj(x, y)],
        ["gcjToWgs", TC.gcjToWgs(x, y), coords.gcjToWgs(x, y)],
        ["inChina", TC.inChina(x, y), coords.inChina(x, y)],
        ["distance", TC.distance(x, y, 102.7, 25.04), coords.distance(x, y, 102.7, 25.04)],
        ["convert", TC.convert(x, y, "gcj02", "wgs84"), coords.convert(x, y, "gcj02", "wgs84")],
      ];
      for (const [n, a, b] of pairs) if (JSON.stringify(a) !== JSON.stringify(b)) cd.push(`${n}(${x},${y})`);
    }
    ok(cd.length === 0, `坐标换算 ${PTS.length} 个点 × 5 个函数两边一样`, cd);
  }

  // ================= 三、坐标换算 =================
  console.log("\n三、坐标换算（src/util/geo-coords.js）");
  {
    const [gx, gy] = coords.wgsToGcj(102.7, 25.04);
    const shift = coords.distance(102.7, 25.04, gx, gy);
    ok(shift > 100 && shift < 800, `国内的点换到 GCJ-02 挪了几百米（昆明 ${Math.round(shift)} 米）`);
    const worst = PTS.filter(([x, y]) => coords.inChina(x, y)).map(([x, y]) => {
      const [a, b] = coords.wgsToGcj(x, y);
      const [c, d] = coords.gcjToWgs(a, b);
      return Math.max(Math.abs(c - x), Math.abs(d - y));
    });
    ok(worst.length >= 4 && Math.max(...worst) < 1e-6, "WGS → GCJ → WGS 绕一圈回到原地（误差 < 1e-6 度）", worst);
    const outside = [[2.2945, 48.8584], [126.98, 37.57], [121.5, 25.03], [105.85, 21.03], [131.9, 43.1], [139.7, 35.7]];
    ok(outside.every(([x, y]) => { const [a, b] = coords.wgsToGcj(x, y); return a === x && b === y; }), "国外的点原样返回（巴黎、首尔、台北、河内、海参崴、东京）");
    const yes = [[102.7, 25.04], [116.4074, 39.9042], [87.6, 43.8], [126.6, 45.75], [110.3, 20.04], [91.1, 29.65], [114.17, 22.3]];
    ok(yes.every(([x, y]) => coords.inChina(x, y)), "昆明、北京、乌鲁木齐、哈尔滨、海口、拉萨、香港算在国内");
    ok(outside.every(([x, y]) => !coords.inChina(x, y)), "一个大方框会框进来的首尔、东京、海参崴这些不算");
    const bs = coords.distance(116.4074, 39.9042, 121.4737, 31.2304) / 1000;
    ok(bs > 1060 && bs < 1075, `北京到上海直线 ${bs.toFixed(0)} 公里`);
    eq([coords.convert(1, 2, "wgs84", "wgs84"), coords.convert(102.7, 25.04, "bd09", "wgs84")], [[1, 2], [102.7, 25.04]], "同一套、不认识的坐标系都原样返回");
  }

  // ================= 四、前端的小件：导航链接、距离、卡片占位 =================
  console.log("\n四、前端小件（导航链接 / 距离 / 卡片占位）");
  {
    const A = { lng: 102.703, lat: 25.048, datum: "gcj02", name: "翠湖公园" };
    const B = { lng: 102.71, lat: 25.04, datum: "gcj02", name: "南强街" };
    const C = { lng: 102.72, lat: 25.03, datum: "gcj02", name: "金马碧鸡坊" };
    const D = { lng: 102.73, lat: 25.02, datum: "gcj02", name: "滇池" };
    const P1 = { lng: 2.2945, lat: 48.8584, datum: "wgs84", name: "埃菲尔铁塔" };
    const P2 = { lng: 2.3376, lat: 48.8606, datum: "wgs84", name: "卢浮宫" };
    const leg = TC.legNavUrl(A, B, "walking");
    ok(leg.startsWith("https://uri.amap.com/navigation?from=102.703,25.048," + encodeURIComponent("翠湖公园")) && leg.includes("&mode=walk") && leg.includes("coordinate=gaode"),
      "国内两站：高德导航，坐标原样（本来就是 GCJ-02），步行", leg);
    const legW = TC.legNavUrl({ ...A, datum: "wgs84" }, B, "driving");
    ok(!legW.includes("from=102.703,25.048,") && legW.includes("&mode=car"), "给的是 WGS-84 的点：先换成 GCJ-02 再交给高德", legW);
    const g = TC.legNavUrl(P1, P2, "walking");
    ok(g.startsWith("https://www.google.com/maps/dir/?api=1&origin=48.8584,2.2945&destination=48.8606,2.3376") && g.includes("travelmode=walking"),
      "国外：Google 地图，纬度在前", g);
    ok(TC.dayNavUrl([A]) === "", "一天只有一站：不给整天路线");
    ok(/^https:\/\/uri\.amap\.com\/navigation\?/.test(TC.dayNavUrl([A, B])) && !TC.dayNavUrl([A, B]).includes("via="), "国内两站：高德，没有途经点");
    ok(TC.dayNavUrl([A, B, C]).includes("&via=102.71,25.04," + encodeURIComponent("南强街")), "国内三站：中间那站当途经点");
    ok(TC.dayNavUrl([A, B, C, D]) === "", "国内四站以上不给（高德网页导航只认一个途经点），每两站之间的「导航」还在");
    const gd = TC.dayNavUrl([P1, P2, P1, P2]);
    ok(gd.startsWith("https://www.google.com/maps/dir/") && gd.includes("&waypoints=" + encodeURIComponent("48.8606,2.3376|48.8584,2.2945")), "国外四站：Google，带途经点", gd);
    ok(TC.dayNavUrl([A, P1]) === "", "国内外混着的不给");
    ok(TC.dayNavUrl(Array.from({ length: 11 }, () => P1)) === "", "国外超过 10 站不给");
    eq([5, 834, 1234, 12345, NaN].map(TC.fmtDist), ["10 米", "830 米", "1.2 公里", "12 公里", ""], "距离：米取整十、公里一位小数、十公里以上取整");
    eq([0, 30, 600, 3600, 5400, NaN].map(TC.fmtDur), ["", "约 1 分钟", "约 10 分钟", "约 1 小时", "约 1 小时 30 分", ""], "用时：分钟 / 小时几分");

    // renderMd 交过来的是 HTML 转义过的围栏正文
    const evil = '{"plan":[{"items":[{"name":"<img src=x onerror=alert(1)>","note":"\\"引号\\" & <b>"}]}]}';
    const card = TC.cardHtml(esc(evil), {});
    ok(card.startsWith('<div class="tc" data-tc-key="') && card.includes("tc-static"), "解得开：给一张带完整数据的静态卡片");
    ok(!/<img/i.test(card) && card.includes("：&quot;引号&quot; &amp; &lt;b&gt;</li>"), "地点名、备注里的 HTML 全转义，不会被当标签", card);
    const attr = /data-tc="([^"]*)"/.exec(card);
    eq(attr && TC.normalize(JSON.parse(TC.unescHtml(attr[1]))), itinerary.parse(evil), "data-tc 里存的数据解回来跟原文一样（点活、复制都靠它）");
    ok(TC.cardHtml(esc(evil), {}) === card && TC.cardHtml(esc(PROMPT_EXAMPLE), {}).match(/data-tc-key="(\w+)"/)[1] !== card.match(/data-tc-key="(\w+)"/)[1],
      "同一份数据 key 一样（流式重画时靠它认出是同一张），不同的不一样");
    const half = esc('{"days":[{"stops":[{"name":"翠湖公园"},{"name":"南强');
    ok(/tc-pending/.test(TC.cardHtml(half, { open: true, live: true })) && TC.cardHtml(half, { open: true, live: true }).includes("已写 2 站"),
      "还在往外吐字、围栏没收尾：「正在排行程…已写 2 站」");
    const tick = "`";
    ok([1, 2].every((n) => TC.cardHtml(esc(evil) + "\n" + tick.repeat(n), { open: true, live: true }) === card),
      "JSON 写完、收尾的反引号只到一两个：已经是那张卡片（key 不变），不退回「正在排行程」");
    ok(TC.cardHtml(esc(evil) + "\n" + tick.repeat(2), {}) === "", "围栏已收尾时不去反引号：正文里真带反引号的照原样当坏数据");
    ok(TC.cardHtml(half, { open: true }) === "" && TC.cardHtml(half, { live: true }) === "" && TC.cardHtml(esc("{坏的}"), { open: false, live: true }) === "",
      "停笔了、回放历史、围栏已收尾还解不开：回空串，调用方照普通代码块显示");
    const host = { dataset: { tc: attr ? TC.unescHtml(attr[1]) : "" }, textContent: "" };
    ok(TC.staticOf(host) === TC.staticHtml(itinerary.parse(evil)), "复制出去用的文字版：从 data-tc 重新排");
    ok(TC.staticOf({ dataset: { tc: "{坏" }, textContent: "<原文>" }) === "&lt;原文&gt;", "data-tc 坏了：退回元素里的文字，照样转义");
  }

  // ================= 五、查地点、查路：假的地图服务 =================
  const hits = [];
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120, 7)]);
  const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 3)]);
  const POIS = {
    "翠湖公园": [{ name: "翠湖公园", location: "102.703,25.048", cityname: "昆明市", pname: "云南省", adname: "五华区", address: "翠湖南路67号",
      type: "风景名胜;公园广场;公园", business: { rating: "4.7" }, photos: [{ url: "https://aos-comment.amap.com/a.jpg" }] }],
    // 不限定城市的话高德会给杭州那座仿建的
    "埃菲尔铁塔": [{ name: "埃菲尔铁塔", location: "120.30,30.40", cityname: "杭州市", pname: "浙江省", adname: "余杭区", address: "天都城", type: "风景名胜", business: {}, photos: [] }],
    "天安门": [{ name: "天安门", location: "116.397469,39.908821", cityname: "北京市", pname: "北京市", adname: "东城区", address: "长安街", type: "风景名胜;风景名胜;国家级景点", business: { rating: [] }, photos: [] }],
    "南强街": [{ name: "南强街巷", location: "102.711,25.036", cityname: "昆明市", pname: "云南省", adname: "五华区", address: "南强街", type: "购物服务;特色商业街;步行街", business: { rating: "4.5" }, photos: [] }],
  };
  const OSM = {
    "埃菲尔铁塔, 巴黎": [{ lat: "48.8584", lon: "2.2945", name: "埃菲尔铁塔", display_name: "埃菲尔铁塔, 战神广场, 第七区, 巴黎, 法国", type: "attraction", category: "tourism", extratags: { wikidata: "Q243" } }],
    "天安门, 北京": [{ lat: "39.9075", lon: "116.39723", name: "天安门", display_name: "天安门, 东长安街, 东城区, 北京市, 中国", type: "monument", category: "historic", extratags: { image: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Tiananmen.jpg" } }],
  };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const q = Object.fromEntries(u.searchParams);
    hits.push({ path: u.pathname, q, ua: req.headers["user-agent"] || "" });
    const json = (o, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (u.pathname.startsWith("/v5/") && /bad/.test(q.key)) return json({ status: "0", info: "INVALID_USER_KEY", infocode: "10001" });
    if (u.pathname === "/v5/place/text") {
      if (q.keywords === "炸了") return json({ oops: true }, 500);
      return json({ status: "1", info: "OK", infocode: "10000", pois: POIS[q.keywords] || [] });
    }
    if (u.pathname === "/v5/direction/walking" || u.pathname === "/v5/direction/driving") {
      const walk = u.pathname.endsWith("walking");
      return json({ status: "1", route: { paths: [{ distance: walk ? "1180" : "5230", cost: { duration: walk ? "900" : "780" },
        steps: [{ polyline: `${q.origin};102.705,25.045` }, { polyline: `102.706,25.043;${q.destination}` }] }] } });
    }
    if (u.pathname === "/search") return json(OSM[q.q] || []);
    if (u.pathname === "/w/api.php") {
      return json(q.entity === "Q243" ? { claims: { P18: [{ mainsnak: { datavalue: { value: "Tour Eiffel Wikimedia Commons.jpg" } } }] } } : { claims: {} });
    }
    const t = /^\/tiles\/(\w+)\/(\d+)\/(\d+)\/(\d+)$/.exec(u.pathname);
    if (t) {
      if (t[4] === "3") { res.writeHead(200, { "Content-Type": "image/png" }); return res.end("<html>不是图</html>"); }
      if (t[4] === "4") { res.writeHead(404); return res.end("nope"); }
      res.writeHead(200, { "Content-Type": "text/plain" }); // 故意给错的 Content-Type：只认字节
      return res.end(PNG);
    }
    if (u.pathname === "/img/ok.jpg") { res.writeHead(200, { "Content-Type": "image/jpeg" }); return res.end(JPG); }
    if (u.pathname === "/img/redir") { res.writeHead(302, { Location: "/img/ok.jpg" }); return res.end(); }
    if (u.pathname === "/img/away") { res.writeHead(302, { Location: "http://evil.example/x.jpg" }); return res.end(); }
    if (u.pathname === "/img/loop") { res.writeHead(302, { Location: "/img/loop" }); return res.end(); }
    if (u.pathname === "/img/html") { res.writeHead(200, { "Content-Type": "image/jpeg" }); return res.end("<html>"); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const BASE = `http://127.0.0.1:${srv.address().port}`;
  const count = (p) => hits.filter((h) => h.path === p).length;
  const last = (p) => hits.filter((h) => h.path === p).slice(-1)[0];

  // 照片代理默认那份名单：换成测试名单之前先查
  console.log("\n五、图片代理名单（默认那份）");
  {
    const yes = ["https://aos-comment.amap.com/a.jpg", "https://store.is.autonavi.com/x.jpg", "https://upload.wikimedia.org/a.jpg", "https://commons.wikimedia.org/wiki/Special:FilePath/a.jpg"];
    const no = ["https://evil.com/a.jpg", "https://upload.wikimedia.org.evil.com/a.jpg", "https://fakeamap.com/a.jpg", "https://upload.wikimedia.org:8443/a.jpg",
      "https://u:p@upload.wikimedia.org/a.jpg", "file:///etc/passwd", "javascript:alert(1)", "ftp://upload.wikimedia.org/a.jpg", "not a url", "http://127.0.0.1/a.jpg"];
    ok(yes.every(tiles.allowed), "高德、Wikimedia 的图床放行", yes.filter((u) => !tiles.allowed(u)));
    ok(no.every((u) => !tiles.allowed(u)), "名单外的域名、带端口、带账号密码、file:/javascript:/ftp:、本机地址一律不代理", no.filter(tiles.allowed));
    eq([PNG, JPG, Buffer.from("RIFF0000WEBPVP8 "), Buffer.from("GIF89a1234"), Buffer.from("<html>")].map(tiles.sniff),
      ["image/png", "image/jpeg", "image/webp", "image/gif", ""], "只认图片头几个字节");
    const src = tiles.sources();
    ok(src.osm.datum === "wgs84" && src.amap.datum === "gcj02" && src.amap.maxZoom === 18 && src.osm.attr && src.amap.attr, "底图：OSM 是 WGS-84、高德是 GCJ-02，各带署名");
    ok(/^https:\/\/webrd0[1-4]\.is\.autonavi\.com\//.test(tiles.SOURCES.amap.url(10, 1, 2)) && tiles.SOURCES.osm.url(3, 1, 2) === "https://tile.openstreetmap.org/3/1/2.png", "瓦片地址形状对");
  }

  places._testing({ bases: { amap: BASE, nominatim: BASE, wikidata: BASE }, gaps: { amap: 0, nominatim: 0, wikidata: 0 }, reset: true });
  tiles._testing({ tileBase: BASE + "/tiles", imgHosts: [/^127\.0\.0\.1$/], reset: true });

  console.log("\n六、设置：用哪家、Key 从哪来");
  {
    eq(places.settingsOf({}), { provider: "auto", key: "", from: "", cap: 2000 }, "什么都没配：auto，没 Key，每天上限 2000");
    eq(places.settingsOf({ map: { amap_key: " sk-test-amap ", amap_daily_cap: 50 } }), { provider: "auto", key: "sk-test-amap", from: "settings", cap: 50 }, "设置里填的 Key（去掉两边空白）");
    eq(places.settingsOf({ mcp_servers: [{ env: {} }, { env: { AMAP_MAPS_API_KEY: "sk-test-conn" } }] }), { provider: "auto", key: "sk-test-conn", from: "connector", cap: 2000 }, "设置里没填：用高德连接器里那把");
    eq(places.settingsOf({ map: { amap_key: "sk-test-set" }, mcp_servers: [{ env: { AMAP_MAPS_API_KEY: "sk-test-conn" } }] }).from, "settings", "两处都有：设置里的优先");
    eq(places.settingsOf({ map: { provider: "osm", amap_key: "sk-test-amap" }, mcp_servers: [{ env: { AMAP_MAPS_API_KEY: "sk-test-conn" } }] }).key, "", "选了 OpenStreetMap：哪儿的 Key 都不用");
    eq([0, "-1", "abc", 12.7].map((c) => places.settingsOf({ map: { amap_daily_cap: c } }).cap), [0, 2000, 2000, 12], "上限：0 是不用高德，负数和乱填的按默认，小数取整");
    eq(places.settingsOf({ map: { provider: "baidu" } }).provider, "auto", "不认识的 provider 按 auto");
  }

  const KEY = "amap-test-key-0123456789";
  const withKey = { map: { amap_key: KEY } };
  console.log("\n七、查地点");
  {
    const r = await places.lookup(withKey, [{ name: "翠湖公园", city: "昆明" }]);
    const p = r.items[0];
    eq(p, { ok: true, name: "翠湖公园", lng: 102.703, lat: 25.048, datum: "gcj02", addr: "五华区 翠湖南路67号", kind: "公园", rating: 4.7, photo: "https://aos-comment.amap.com/a.jpg", src: "amap" },
      "有 Key：高德 POI 给坐标（GCJ-02）、地址、类别、评分、照片");
    const h = last("/v5/place/text");
    ok(h && h.q.key === KEY && h.q.keywords === "翠湖公园" && h.q.region === "昆明" && h.q.city_limit === "true" && h.q.show_fields === "business,photos",
      "请求带 Key、限定城市（region + city_limit）、要了评分和照片", h && h.q);
    ok(h && /OpenWorkBuddy/.test(h.ua), "带能认出是谁的 User-Agent");
    ok(r.provider === "amap" && r.notes.length === 0, "provider 报 amap，没有报错");

    const n0 = count("/v5/place/text");
    await places.lookup(withKey, [{ name: "翠湖公园", city: "昆明" }]);
    ok(count("/v5/place/text") === n0, "同一个地方第二次：不再打高德");

    const south = await places.lookup(withKey, [{ name: "南强街", city: "昆明市" }]);
    ok(south.items[0].name === "南强街巷" && south.items[0].rating === 4.5 && south.items[0].kind === "步行街", "名字对不上整名就拿同城第一个；城市写「昆明市」也认", south.items[0]);

    const nSearch = count("/search");
    const paris = await places.lookup(withKey, [{ name: "埃菲尔铁塔", city: "巴黎" }]);
    const pp = paris.items[0];
    ok(pp.ok && pp.src === "osm" && pp.datum === "wgs84" && pp.lng === 2.2945 && pp.lat === 48.8584, "高德只搜到杭州那座仿建的：城市对不上不要，改去 OpenStreetMap 查到巴黎那座", pp);
    ok(pp.photo === "https://commons.wikimedia.org/wiki/Special:FilePath/Tour_Eiffel_Wikimedia_Commons.jpg?width=320", "OSM 没给照片：去 Wikidata 拿头图（空格换下划线、要 320 宽的）", pp.photo);
    ok(pp.kind === "景点" && pp.rating === null && pp.addr === "战神广场，第七区，巴黎", "OSM 的类别翻成中文；没有评分；地址取中间几段", pp);
    const s = last("/search");
    ok(count("/search") === nSearch + 1 && s.q.q === "埃菲尔铁塔, 巴黎" && s.q.format === "jsonv2" && s.q.limit === "1" && s.q.extratags === "1" && /OpenWorkBuddy/.test(s.ua),
      "Nominatim 请求：名字带城市、jsonv2、只要一条、要 extratags、带 User-Agent（它的使用条款要求）", s && s.q);
    ok(last("/w/api.php").q.entity === "Q243" && last("/w/api.php").q.property === "P18", "Wikidata 要的是 P18（图像）");

    const badKey = "amap-test-badkey-987654321";
    const nb = count("/v5/place/text");
    const bad = await places.lookup({ map: { amap_key: badKey } }, [{ name: "滇池", city: "昆明" }]);
    ok(bad.notes.includes("高德：INVALID_USER_KEY（10001）"), "Key 不对：高德的原话原样往上递，不替人猜原因", bad.notes);
    ok(!JSON.stringify(bad).includes(badKey), "报错里不带 Key");
    eq(bad.items[0], { ok: false, failed: true }, "高德报错 + OSM 也没查到：标 failed（前端不记住它，下次再试）");
    await places.lookup({ map: { amap_key: badKey } }, [{ name: "滇池", city: "昆明" }]);
    ok(count("/v5/place/text") === nb + 2, "报错的结果不进缓存：下次照样再查");

    const boom = await places.lookup(withKey, [{ name: "炸了", city: "昆明" }]);
    ok(boom.notes.some((n) => /127\.0\.0\.1:\d+ 回了 HTTP 500/.test(n)) && !JSON.stringify(boom).includes(KEY), "对方回 500：说是哪台机器、什么状态码，不带请求地址（里面有 Key）", boom.notes);

    const nc = count("/v5/place/text");
    const capped = await places.lookup({ map: { amap_key: KEY, amap_daily_cap: 0 } }, [{ name: "石林", city: "昆明" }]);
    ok(count("/v5/place/text") === nc && capped.notes.includes("今天的高德查询次数到上限了，先改用 OpenStreetMap"), "每天上限到了：一次也不打高德，说一声改用 OpenStreetMap", capped.notes);
    ok(last("/search").q.q === "石林, 昆明", "到上限的那一站照样去 OpenStreetMap 查");

    const no = count("/v5/place/text");
    const osm = await places.lookup({ map: { provider: "osm", amap_key: KEY } }, [{ name: "天安门", city: "北京" }]);
    ok(count("/v5/place/text") === no && osm.provider === "osm" && osm.items[0].src === "osm", "选了 OpenStreetMap：填着 Key 也一次不打高德");
    ok(osm.items[0].photo === "https://upload.wikimedia.org/wikipedia/commons/a/ab/Tiananmen.jpg" && osm.items[0].kind === "纪念碑", "OSM 自带 Wikimedia 照片就直接用", osm.items[0]);

    await places.lookup({ mcp_servers: [{ env: { AMAP_MAPS_API_KEY: "sk-test-conn-1" } }] }, [{ name: "翠湖公园", city: "大理" }]);
    ok(last("/v5/place/text").q.key === "sk-test-conn-1", "设置里没填：用连接器那把 Key 去查");

    const many = await places.lookup(withKey, Array.from({ length: 25 }, () => ({ name: "" })));
    ok(many.items.length === places.MAX_ITEMS && many.items.every((x) => x.ok === false), `一次最多 ${places.MAX_ITEMS} 个，没名字的直接算没找到（不打接口）`);
    eq(await places.lookup(withKey, "乱给的"), { provider: "amap", items: [], notes: [] }, "items 不是数组：回空的，不抛错");

    const ctl = places._testing({});
    await ctl.flush();
    const disk = fs.readFileSync(ctl.cacheFile, "utf8");
    ok(disk.includes("a|昆明|翠湖公园") && disk.includes("o|巴黎|埃菲尔铁塔"), "查过的记了盘", ctl.cacheFile);
    ok(!disk.includes("sk-test"), "盘上的缓存里没有 Key");
    places._testing({ reset: true });
    const nd = count("/v5/place/text");
    const again = await places.lookup(withKey, [{ name: "翠湖公园", city: "昆明" }]);
    ok(count("/v5/place/text") === nd && again.items[0].rating === 4.7, "重启后（内存清空）从盘上读回来，不再打高德");
    const used = JSON.parse(disk).used;
    ok(used >= 5, `今天打了几次高德记在盘上（${used}）`);
  }

  console.log("\n八、两站之间的路");
  {
    const A = { lng: 102.703, lat: 25.048, datum: "gcj02" };
    const B = { lng: 102.711, lat: 25.036, datum: "gcj02" };      // 一公里多：步行
    const C = { lng: 102.74, lat: 25.02, datum: "gcj02" };        // 四五公里：驾车
    const DALI = { lng: 100.16, lat: 25.69, datum: "gcj02" };     // 两百多公里：不查
    const P1 = { lng: 2.2945, lat: 48.8584, datum: "wgs84" }, P2 = { lng: 2.3376, lat: 48.8606, datum: "wgs84" };
    const nw = count("/v5/direction/walking"), nd = count("/v5/direction/driving");

    const free = await places.legs({}, [{ a: A, b: B }]);
    const l0 = free.items[0];
    ok(l0.mode === "line" && l0.src === "line" && l0.datum === "wgs84" && l0.line.length === 2 && l0.duration === null, "没 Key：画直线，标直线距离", l0);
    const pa = coords.gcjToWgs(A.lng, A.lat), pb = coords.gcjToWgs(B.lng, B.lat);
    ok(l0.distance === Math.round(coords.distance(pa[0], pa[1], pb[0], pb[1])) && l0.distance > 1000 && l0.distance < 2000, `直线距离按 WGS-84 算（${l0.distance} 米）`);
    ok(count("/v5/direction/walking") === nw, "没 Key 一次也不打高德");

    const walk = (await places.legs(withKey, [{ a: A, b: B }])).items[0];
    const hw = last("/v5/direction/walking");
    ok(walk.mode === "walking" && walk.distance === 1180 && walk.duration === 900 && walk.datum === "gcj02", "两公里内：高德步行路线，距离、用时照高德给的", walk);
    ok(hw && hw.q.origin === "102.703000,25.048000" && hw.q.destination === "102.711000,25.036000" && hw.q.key === KEY, "起终点按 GCJ-02 发，六位小数", hw && hw.q);
    eq(walk.line, [[102.703, 25.048], [102.705, 25.045], [102.706, 25.043], [102.711, 25.036]], "折线从每一步的 polyline 拼起来");

    const drive = (await places.legs(withKey, [{ a: A, b: C }])).items[0];
    ok(drive.mode === "driving" && count("/v5/direction/driving") === nd + 1, "再远：驾车");

    const before = count("/v5/direction/walking");
    await places.legs(withKey, [{ a: A, b: B }]);
    ok(count("/v5/direction/walking") === before, "同一段路第二次：不再查");

    const w84 = { lng: 102.7, lat: 25.05, datum: "wgs84" };
    await places.legs(withKey, [{ a: w84, b: B }]);
    const gw = coords.wgsToGcj(102.7, 25.05);
    ok(last("/v5/direction/walking").q.origin === `${gw[0].toFixed(6)},${gw[1].toFixed(6)}`, "WGS-84 的点先换成 GCJ-02 再问高德");

    const n2 = count("/v5/direction/walking") + count("/v5/direction/driving");
    const skip = await places.legs(withKey, [{ a: A, b: DALI }, { a: P1, b: P2 }, { a: A, b: { ...A, lng: A.lng + 0.0001 } },
      { a: A, b: { lng: 999, lat: 0 } }, { a: null, b: B }, { a: A, b: { lng: "", lat: "" } }, { a: A, b: { lng: null, lat: null } }, null, { a: A, b: "x" }]);
    eq(skip.items.map((x) => x && x.mode), ["line", "line", "line", null, null, null, null, null, null], "跨城（>150 公里）、国外、近得不到 30 米：画直线；坐标缺了、坏了给 null（不当成经纬度 0,0）");
    ok(count("/v5/direction/walking") + count("/v5/direction/driving") === n2, "这些一次都没打高德");
    ok((await places.legs({}, Array.from({ length: 25 }, () => ({ a: A, b: B })))).items.length === places.MAX_LEGS, `一次最多 ${places.MAX_LEGS} 段`);

    const badLeg = await places.legs({ map: { amap_key: "sk-test-badkey-2" } }, [{ a: A, b: { lng: 102.72, lat: 25.04, datum: "gcj02" } }]);
    ok(badLeg.items[0].mode === "line" && badLeg.notes.includes("高德：INVALID_USER_KEY（10001）"), "高德报错：退回直线，报错原样带上", badLeg);

    const thin = places.thin(Array.from({ length: 1000 }, (_, i) => [i, i]));
    ok(thin.length <= 241 && thin[0][0] === 0 && thin[thin.length - 1][0] === 999, `折线太密抽稀，留头留尾（1000 → ${thin.length}）`);
  }

  console.log("\n九、设置页「测一下」");
  {
    const t0 = await places.test({});
    ok(t0.ok && t0.provider === "osm" && /OpenStreetMap/.test(t0.msg), "没 Key：测 OpenStreetMap 连不连得上", t0);
    places._testing({ reset: true });
    const t1 = await places.test({}, KEY);
    ok(t1.ok && t1.provider === "amap" && t1.msg === "高德 Key 能用：查到「天安门」", "给了 Key：真查一次「天安门」", t1);
    places._testing({ reset: true });
    const tc = await places.test({ map: { amap_key: KEY, amap_daily_cap: 0 } }).catch((e) => ({ error: e.message }));
    ok(tc.ok && tc.provider === "amap", "上限填了 0 也能测：人点的这一下不被每天的上限挡住", tc);
    await rejects(places.test({}, "sk-test-badkey-3"), /^高德：INVALID_USER_KEY（10001）$/, "Key 不对：原话报出来");
    places._testing({ bases: { amap: "http://127.0.0.1:1" } });
    const e = await rejects(places.test({}, KEY), /^127\.0\.0\.1:1 连不上：/, "连不上：说连不上哪台机器");
    ok(e && !String(e.message).includes(KEY), "连不上的报错里也不带 Key");
    places._testing({ bases: { amap: BASE } });
  }

  console.log("\n十、底图瓦片、地点照片");
  {
    const n0 = hits.length;
    const t = await tiles.tile("osm", 3, 1, 2);
    ok(t.type === "image/png" && t.buf.equals(PNG), "取到瓦片；类型看字节，不信对方的 Content-Type");
    ok(fs.existsSync(path.join(DATA, "runtime", "geo", "tiles", "osm", "3", "1", "2.png")), "记了盘");
    await tiles.tile("osm", 3, 1, 2);
    ok(hits.length === n0 + 1, "第二次从盘上拿，不再拉");
    const n1 = hits.length;
    const [x1, x2] = await Promise.all([tiles.tile("amap", 5, 2, 2), tiles.tile("amap", 5, 2, 2)]);
    ok(hits.length === n1 + 1 && x1.buf.equals(x2.buf), "同一张同时要两次：只拉一次");
    await rejects(tiles.tile("baidu", 1, 0, 0), /^没有这种底图$/, "不认识的底图：400");
    for (const [z, x, y, why] of [[3, 8, 0, "x 出界"], [3, 0, -1, "负数"], [20, 0, 0, "缩放太大"], [NaN, 0, 0, "不是数"], [2.5, 0, 0, "小数"]]) {
      const e = await rejects(tiles.tile("osm", z, x, y), /^瓦片编号不对$/, `瓦片编号不对（${why}）：400`);
      ok(e && e.status === 400, `  状态码 400（${why}）`);
    }
    const nh = await rejects(tiles.tile("osm", 3, 1, 3), /^底图服务回的不是图片$/, "回的不是图片：502");
    ok(nh && nh.status === 502 && !fs.existsSync(path.join(DATA, "runtime", "geo", "tiles", "osm", "3", "1", "3.png")), "  不是图片的不记盘");
    await rejects(tiles.tile("osm", 3, 1, 4), /^底图服务回了 HTTP 404$/, "对方 404：原样说");

    const img = await tiles.image(BASE + "/img/ok.jpg");
    ok(img.type === "image/jpeg" && img.buf.equals(JPG), "照片取到");
    const ni = hits.length;
    await tiles.image(BASE + "/img/ok.jpg");
    ok(hits.length === ni, "照片也记盘");
    const rd = await tiles.image(BASE + "/img/redir");
    ok(rd.buf.equals(JPG), "跳到名单里的地址：跟着跳");
    const off = await rejects(tiles.image(BASE + "/img/away"), /^图片跳到了名单外的地址$/, "跳到名单外：不跟（每一跳都对名单）");
    ok(off && off.status === 502 && !hits.some((h) => h.path === "/x.jpg"), "  也没真去请求那个地址");
    await rejects(tiles.image(BASE + "/img/loop"), /^图片跳转太多次$/, "绕圈跳：几次就停");
    await rejects(tiles.image(BASE + "/img/html"), /^图床回的不是图片$/, "回的不是图片：不代理");
    const notOk = await rejects(tiles.image("https://evil.example/a.jpg"), /^这个图片地址不在可代理的名单里$/, "名单外的地址：一次也不请求");
    ok(notOk && notOk.status === 400, "  状态码 400");

    // 盘上总量：超了从最久没用的删到八成
    tiles._testing({ capBytes: PNG.length * 4, reset: true });
    for (let x = 0; x < 8; x++) await tiles.tile("osm", 4, x, 5);
    const geoDir = path.join(DATA, "runtime", "geo");
    const sizes = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (!f.endsWith(".json")) sizes.push(fs.statSync(f).size); } };
    walk(geoDir);
    const total = sizes.reduce((a, b) => a + b, 0);
    ok(total <= PNG.length * 4, `盘上超了上限就删旧的（剩 ${total} 字节，上限 ${PNG.length * 4}）`);
    ok(fs.existsSync(path.join(geoDir, "places.json")), "  地点缓存那份 JSON 不删");
    tiles._testing({ capBytes: 200 * 1024 * 1024, reset: true });
  }

  console.log("\n十一、接口（/api/geo/*）");
  {
    const express = require("express");
    let cfg = { map: { amap_key: KEY } };
    const app = express();
    app.use(express.json());
    app.use(createGeoRouter({ getConfig: () => cfg }));
    const s2 = await new Promise((r) => { const x = app.listen(0, "127.0.0.1", () => r(x)); });
    const API = `http://127.0.0.1:${s2.address().port}`;
    const post = (p, body) => fetch(API + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

    const c = await (await fetch(API + "/api/geo/config")).json();
    ok(c.provider === "auto" && c.amap === true && c.keyFrom === "settings" && c.sources.amap.datum === "gcj02", "config：用哪家、有没有 Key、Key 从哪来、底图信息", c);
    ok(!JSON.stringify(c).includes("sk-test"), "config 里不给 Key 本身");
    cfg = { mcp_servers: [{ env: { AMAP_MAPS_API_KEY: "sk-test-conn-9" } }] };
    const c2 = await (await fetch(API + "/api/geo/config")).json();
    ok(c2.keyFrom === "connector" && c2.amap === true, "配置热生效：每次现取（换成连接器那把）");
    cfg = { map: { amap_key: KEY } };

    const pr = await (await post("/api/geo/places", { items: [{ name: "翠湖公园", city: "昆明" }] })).json();
    ok(pr.provider === "amap" && pr.items[0].ok && pr.items[0].rating === 4.7, "places：查得到");
    const empty = await post("/api/geo/places", {});
    ok(empty.status === 200 && (await empty.json()).items.length === 0, "places 没给 items：回空的");
    const lg = await (await post("/api/geo/legs", { pairs: [{ a: { lng: 102.703, lat: 25.048, datum: "gcj02" }, b: { lng: 102.711, lat: 25.036, datum: "gcj02" } }] })).json();
    ok(lg.items[0].mode === "walking", "legs：查得到");

    const tr = await fetch(API + "/api/geo/tile/osm/3/1/2.png");
    ok(tr.status === 200 && tr.headers.get("content-type") === "image/png" && /private/.test(tr.headers.get("cache-control") || ""), "tile：带 .png 后缀也认，private 缓存");
    for (const [p, why] of [["/api/geo/tile/osm/3/x/2", "编号不是数"], ["/api/geo/tile/osm/99999999/1/2", "数太长"], ["/api/geo/tile/xx/1/0/0", "底图不认识"]]) {
      const r = await fetch(API + p);
      ok(r.status === 400, `tile ${why}：400`, r.status);
    }
    const ir = await fetch(API + "/api/geo/img?u=" + encodeURIComponent("https://evil.example/a.jpg"));
    ok(ir.status === 400 && (await ir.text()) === "这个图片地址不在可代理的名单里", "img 名单外：400，原因写明");
    const okImg = await fetch(API + "/api/geo/img?u=" + encodeURIComponent(BASE + "/img/ok.jpg"));
    ok(okImg.status === 200 && okImg.headers.get("content-type") === "image/jpeg", "img：取得到");
    const te = await post("/api/geo/test", { key: "sk-test-badkey-4" });
    const tej = await te.json();
    ok(te.status === 502 && tej.error === "高德：INVALID_USER_KEY（10001）", "test Key 不对：502 + 高德原话", tej);
    s2.close();
  }

  console.log("\n十二、飞书 / 微信 / 命令行：换成文字行程");
  {
    const reply = "给你排好了：\n\n```itinerary\n" + PROMPT_EXAMPLE + "\n```\n\n第一天走路就行。";
    const ch = imReply.chunks(reply).join("\n\n");
    ok(!ch.includes("```") && ch.includes("**第1天 · 老昆明慢逛**") && ch.includes("- 上午 · 翠湖公园：湖边散步、喝咖啡") && ch.includes("第一天走路就行。"),
      "IM 分条：围栏换成按天排的文字，前后文都在", ch);
    ok(imReply.dropFigures(reply).includes("- 晚上 · 南强街：小锅米线、烧饵块"), "群机器人摘要（dropFigures）也换");
    const prep = await imReply.prepareFigures(reply, { canSend: false });
    ok(prep.text.includes("**第1天 · 老昆明慢逛**") && !prep.text.includes("```itinerary"), "带图的那条路（prepareFigures）也换");
    const badReply = "看：\n```itinerary\n{坏的\n```";
    ok(imReply.chunks(badReply)[0] === badReply, "IM：解不开的原样发，不吞内容");

    const plain = (md) => { const r = mdTty.createRenderer({ color: false }); return r.write(md) + r.end(); };
    const streamed = (md, n) => { const r = mdTty.createRenderer({ color: false }); let o = ""; for (let i = 0; i < md.length; i += n) o += r.write(md.slice(i, i + n)); return o + r.end(); };
    const out = plain(reply);
    ok(out.includes("第1天 · 老昆明慢逛") && out.includes("• 上午 · 翠湖公园：湖边散步、喝咖啡") && !out.includes('"stops"') && !out.includes("itinerary"), "命令行：渲染成按天排的文字，不打 JSON", out);
    ok(streamed(reply, 7) === out, "命令行一段段流式喂进来，结果跟一次给全一样");
    const bo = plain(badReply);
    ok(bo.includes("│ itinerary") && bo.includes("│ {坏的"), "命令行：解不开的照代码块打出来", bo);
    const open = plain("```itinerary\n" + PROMPT_EXAMPLE);
    ok(open.includes("第1天 · 老昆明慢逛"), "围栏没收尾就结束了：攒着的照样交代出去", open);
    ok(plain("```js\nconst a = 1;\n```") === "│ js\n│ const a = 1;\n", "别的代码块照旧");
  }

  console.log("\n十三、接线（都接上了没有）");
  {
    const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
    const app01 = read("public/js/app-01.js");
    ok(/\/\^itinerary\$\/i\.test\(lang\) && window\.TripCard \? TripCard\.cardHtml\(code, \{ open, live \}\)/.test(app01), "renderMd 遇到 ```itinerary 交给 TripCard.cardHtml（带 open、live）");
    ok(/function renderedCopy[\s\S]{0,400}TripCard\.staticOf/.test(app01), "复制回答时卡片换成文字版");
    const html = read("public/index.html");
    const iSvg = html.indexOf('<script src="svgfig.js">'), iTc = html.indexOf('<script src="tripcard.js">'), iApp = html.indexOf('<script src="js/i18n.js">');
    ok(iSvg > 0 && iTc > iSvg && iApp > iTc, "index.html 载入 tripcard.js（在应用脚本之前）");
    ok(html.includes('<link rel="stylesheet" href="/css/tripcard.css">'), "index.html 载入 tripcard.css");
    ok(fs.existsSync(path.join(ROOT, "public", "css", "tripcard.css")), "tripcard.css 在");
    ok((read("src/agent/agent.js").match(/itinerary\.PROMPT_BLOCK/g) || []).length === 2, "提示词两条路都带上行程卡那一节（内置引擎、本机 Codex / Claude Code）");
    ok(/"amap": \{ url: "https:\/\/console\.amap\.com\//.test(read("public/js/app-03.js")), "设置页「去哪拿 Key」有高德");
    ok(/function renderMapCard/.test(read("public/js/app-05.js")) && /renderMapCard\(pane, s\)/.test(read("public/js/app-05.js")), "设置页有地图那一节");
    const admin = require(mod("admin"));
    ok(admin.PLATFORM_WRITE.includes("/api/geo/test"), "「测一下」归平台管理员（花的是整台服务器那把 Key 的额度）");
    eq(admin.redactSecrets({ map: { provider: "amap", amap_key: KEY, amap_daily_cap: 9 } }), { map: { provider: "amap", amap_key: "", amap_daily_cap: 9 } }, "普通成员拉设置时 amap_key 被抹掉");
    ok(require(mod("config-lint")).KNOWN_EXTRA[""].includes("map"), "配置体检认得 map 这一节");
    const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
    ok(/app\.use\(createGeoRouter\(\{ getConfig: \(\) => config \}\)\)/.test(server), "server.js 挂上了 /api/geo/*");
    ok(/b\.map\.provider[\s\S]{0,200}\["auto", "amap", "osm"\]/.test(server), "保存设置时 provider 只认 auto / amap / osm");
  }

  srv.close();
  console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
