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
 *   7. 「发到手机」的二维码只编卡片自己生成的那几种导航链接——不然它就是一台替任何人把任意网址做成二维码的机器。
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
const { createGeoRouter, navLink } = require(mod("routes/geo"));
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
  // 真实翻车：一站里的 kind 漏了引号，整段解不开，卡片退成一坨原文
  '{"title":"北京三天游","city":"北京","days":[{"stops":[{"time":"上午","name":"天安门广场","kind":"广场"},{"time":"晚上","name":"王府井",kind:"商业街","note":"吃烤鸭"}]}]}',
  // 字符串里长得像「键名:」「收尾逗号」的东西不许动
  '{days:[{stops:[{name:"后海","note":"别动 {kind:1, ] 和 a,}"},{ name : "什刹海\\\\",},],},],}',
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
    const bare = itinerary.parse(SAMPLES[SAMPLES.length - 2]);
    eq(bare && bare.days[0].stops[1], { name: "王府井", time: "晚上", note: "吃烤鸭", kind: "商业街", city: "", addr: "" }, "键名漏了引号（kind:\"商业街\"）照样解得开，值一字不差");
    const tricky = itinerary.parse(SAMPLES[SAMPLES.length - 1]);
    ok(tricky && tricky.days[0].stops[0].note === "别动 {kind:1, ] 和 a,}" && tricky.days[0].stops[1].name === "什刹海\\",
      "补引号、去逗号只动字符串外面：字符串里像键名、像收尾逗号的字原样留着", tricky && tricky.days[0].stops);

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
    eq(itinerary.fencesToMarkdown(bad), "看这个\n行程卡没画成：第 1 行格式不对，下面是原文：\n\n```itinerary\n{坏的\n```\n完",
      "解不开的那段：先说一句哪行不对，原文整段跟在后面——不吞内容");
    eq(itinerary.fencesToMarkdown(itinerary.fencesToMarkdown(bad)), itinerary.fencesToMarkdown(bad), "同一段再换一遍（IM 先换一遍、切段时又换一遍）：「行程卡没画成」不说两遍");
    const twoBad = "```itinerary\n{坏1\n```\n中间\n```itinerary\n{坏2\n```";
    const tb = itinerary.fencesToMarkdown(twoBad);
    ok(tb.split("行程卡没画成").length === 3 && itinerary.fencesToMarkdown(tb) === tb, "两段都解不开：各说一句，再换一遍也不多", tb);
    const plain = "没有围栏的正文 ```js\nx\n```";
    ok(itinerary.fencesToMarkdown(plain) === plain, "没有行程卡的正文原样返回");
    const unclosed = itinerary.fencesToMarkdown("前面\n```itinerary\n" + PROMPT_EXAMPLE);
    ok(!/```/.test(unclosed) && unclosed.startsWith("前面\n") && unclosed.includes("**第1天 · 老昆明慢逛**"), "回答停在围栏中间（没收尾）：写完的 JSON 照样换成文字", unclosed);

    // 哪行不对：模型最常见的是字符串里的双引号没转义
    const multi = '{\n  "title": "北京一日",\n  "days": [{"stops": [{"name": "天安门", "note": "他说"好"的"}]}]\n}';
    eq([multi, "\n\n{\"days\":[", "", "  \n ", '{"a":1}', "[1,2]", PROMPT_EXAMPLE, '{"days":[{"stops":["A",]},]}'].map(itinerary.whyBad),
      ["第 3 行格式不对", "第 3 行格式不对", "里面是空的", "里面是空的", "里面没有能画的地点", "里面没有能画的地点", "", ""],
      "解不开的原因：第几行格式不对（前面的空行也算）、里面是空的、是 JSON 但没有能画的地点；解得开的回空串");

    // 封顶截掉的：卡片、文字版都要说一声，不悄悄少几站（big、L 是上面「封顶」那条的）
    ok(big.more === 20 - L.days && big.days[0].more === 20 - L.stops && big.days.every((d) => d.more === 20 - L.stops), `截掉的记下来：后面 ${20 - L.days} 天、每天后面 ${20 - L.stops} 站`, { more: big.more, d0: big.days[0].more });
    eq(itinerary.normalize(JSON.parse(JSON.stringify(big)), true), big, "截过的再收一遍（data-tc 存的就是它）：截掉几站的数不丢、不重复算");
    eq(TC.normalize(JSON.parse(JSON.stringify(big)), true), big, "  前端那份再收一遍也一样");
    // 模型在围栏里自己写个 more：不当真，不然没截过的卡片也说「后面还有几站没列出」
    const fakeMore = '{"more":5,"days":[{"more":3,"stops":[{"name":"翠湖公园"},{"name":"南强街"}]}]}';
    const fm = itinerary.parse(fakeMore);
    ok(fm.more === undefined && fm.days[0].more === undefined && !/没列出/.test(itinerary.toMarkdown(fm)) && !/没列出/.test(itinerary.fencesToMarkdown("```itinerary\n" + fakeMore + "\n```")),
      "模型自己写的 more 不认：文字版不多出「后面 N 站没列出」", fm);
    eq([TC.parse(fakeMore), TC.normalize(JSON.parse(fakeMore))], [fm, itinerary.normalize(JSON.parse(fakeMore))], "  前端那份也不认");
    const bigMd = itinerary.toMarkdown(big);
    ok(bigMd.includes(`（这天只显示前 ${L.stops} 站，后面 ${20 - L.stops} 站没列出）`) && bigMd.endsWith(`（只显示前 ${L.days} 天，后面 ${20 - L.days} 天没列出）`),
      "文字版：截掉的天、站各说一句", bigMd.slice(-80));
    ok(itinerary.parse(PROMPT_EXAMPLE).more === undefined && itinerary.parse(PROMPT_EXAMPLE).days[0].more === undefined, "没截的不带 more（文字版不多一句）");
    ok(!/核对|以实际为准/.test(itinerary.toMarkdown(itinerary.parse(PROMPT_EXAMPLE))), "文字版末尾不加「请核对」之类的话");
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
    const badOnes = [...SAMPLES, '{\n  "days": [{"stops": [{"name": "天安门", "note": "他说"好"的"}]}]\n}', "\n\n\n{\"days\":[", "  \n "];
    eq(badOnes.map((s) => TC.whyBad(s)), badOnes.map(itinerary.whyBad), "whyBad（哪行不对）两边一样");
    eq([["天", 3], ["站", 2]].map(([u, n]) => TC.moreText(u, n)), [["天", 3], ["站", 2]].map(([u, n]) => itinerary.moreText(u, n)), "moreText（截掉几天几站）两边一样");
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
    // 段间菜单的四种走法：高德 mode 只认 car / bus / walk / ride，Google travelmode 只认 driving / walking / bicycling / transit
    eq(TC.NAV_MODES.map(([m, t]) => m + t), ["walking步行", "transit公交", "bicycling骑行", "driving驾车"], "段间菜单：步行、公交、骑行、驾车四种");
    eq(TC.NAV_MODES.map(([m]) => /&mode=(\w+)&/.exec(TC.legNavUrl(A, B, m))[1]), ["walk", "bus", "ride", "car"], "国内：四种走法对上高德的 mode");
    eq(TC.NAV_MODES.map(([m]) => /travelmode=(\w+)$/.exec(TC.legNavUrl(P1, P2, m))[1]), ["walking", "transit", "bicycling", "driving"], "国外：四种走法对上 Google 的 travelmode");
    // 每站「导航到这」：只给终点，不给起点，导航应用从手机当前位置出发
    const sa = TC.stopNavUrl(A);
    eq(sa, "https://uri.amap.com/navigation?to=102.703,25.048," + encodeURIComponent("翠湖公园") + "&coordinate=gaode&callnative=1", "国内一站：高德，只有 to，坐标原样（GCJ-02）");
    const saW = TC.stopNavUrl({ ...A, datum: "wgs84" });
    ok(saW.startsWith("https://uri.amap.com/navigation?to=") && !saW.includes("to=102.703,25.048,") && !/from=|mode=/.test(saW), "给的是 WGS-84 的点：换成 GCJ-02 再交给高德，不带 from、不带走法", saW);
    eq(TC.stopNavUrl(P1), "https://www.google.com/maps/dir/?api=1&destination=48.8584,2.2945", "国外一站：Google，只有 destination，没有 origin、没有走法");
    // 只有直线（国外、没填 Key）时按直线距离定：两公里内步行，再远开车
    const P3 = { lng: 2.2950, lat: 48.8738, datum: "wgs84", name: "凯旋门" };
    ok(TC.legNavUrl(P1, P3, "line").includes("travelmode=walking"), "国外只有直线、两站 1.7 公里：步行", TC.legNavUrl(P1, P3, "line"));
    ok(TC.legNavUrl(P1, P2, "line").includes("travelmode=driving"), "国外只有直线、两站 3 公里多：开车（反向对照）", TC.legNavUrl(P1, P2, "line"));
    ok(TC.legNavUrl(A, B, "line").includes("&mode=walk") && TC.legNavUrl(A, D, "line").includes("&mode=car"), "国内没 Key 只有直线：一样按两公里分步行和开车");
    ok(TC.dayNavUrl([A]) === "", "一天只有一站：不给整天路线");
    ok(/^https:\/\/uri\.amap\.com\/navigation\?/.test(TC.dayNavUrl([A, B])) && !TC.dayNavUrl([A, B]).includes("via="), "国内两站：高德，没有途经点");
    ok(TC.dayNavUrl([A, B, C]).includes("&via=102.71,25.04," + encodeURIComponent("南强街")), "国内三站：中间那站当途经点");
    ok(TC.dayNavUrl([A, B]).includes("&mode=walk") && TC.dayNavUrl([A, B, C, D]).includes("travelmode=walking"), "一天里每两站都在两公里内：整天按步行");
    ok(TC.dayNavUrl([A, D]).includes("&mode=car"), "有一段超过两公里：整天按开车（反向对照）", TC.dayNavUrl([A, D]));
    const cn4 = TC.dayNavUrl([A, B, C, D]);
    ok(cn4 === "https://www.google.com/maps/dir/?api=1&origin=25.048,102.703&destination=25.02,102.73&waypoints=" + encodeURIComponent("25.04,102.71|25.03,102.72") + "&travelmode=walking",
      "国内四站：高德网页导航只认一个途经点，改交 Google，坐标用 GCJ-02（Google 国内底图也是这套）", cn4);
    const gd = TC.dayNavUrl([P1, P2, P1, P2]);
    ok(gd.startsWith("https://www.google.com/maps/dir/") && gd.includes("&waypoints=" + encodeURIComponent("48.8606,2.3376|48.8584,2.2945")), "国外四站：Google，带途经点", gd);
    const mix = TC.dayNavUrl([A, P1]);
    ok(mix.startsWith("https://www.google.com/maps/dir/?api=1&origin=25.048,102.703&destination=48.8584,2.2945") && mix.includes("travelmode=driving"), "国内外混着：Google，国内那站 GCJ-02、国外那站原样", mix);
    const mixLeg = TC.legNavUrl({ ...A, datum: "wgs84" }, P1, "driving");
    ok(mixLeg.startsWith("https://www.google.com/maps/dir/") && !mixLeg.includes("origin=25.048,102.703&"), "两站一国内一国外：Google，国内那站 WGS-84 先换成 GCJ-02", mixLeg);
    ok(TC.dayNavUrl(Array.from({ length: 10 }, () => P1)) !== "" && TC.dayNavUrl(Array.from({ length: 11 }, () => P1)) === "", "十站给，超过 10 站不给（Google 途经点有上限）");
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
    ok(/^<div class="tc tc-bad">/.test(TC.cardHtml(esc(evil) + "\n" + tick.repeat(2), {})), "围栏已收尾时不去反引号：正文里真带反引号的照原样当坏数据");
    const bads = [TC.cardHtml(half, { open: true }), TC.cardHtml(half, { live: true }), TC.cardHtml(esc("{坏的}"), { open: false, live: true })];
    ok(bads.every((h) => /^<div class="tc tc-bad"><div class="tc-badh">行程卡没画成：第 1 行格式不对<\/div>/.test(h)),
      "停笔了、回放历史、围栏已收尾还解不开：说一句「行程卡没画成：第 N 行格式不对」", bads);
    ok(bads[2].includes('<details class="tc-raw"><summary>看原文</summary><pre><code>{坏的}</code></pre></details>') && !/<details[^>]*open/.test(bads[2]),
      "原文收在「看原文」里（默认收起），照样转义", bads[2]);
    const evilBad = TC.cardHtml(esc('{"name":"<img src=x onerror=alert(1)>"'), {});
    ok(!/<img/i.test(evilBad) && evilBad.includes("&lt;img src=x"), "坏数据的原文里带 HTML：转义，不会被当标签", evilBad);
    ok(!bads.some((h) => h.includes("tc-redo")), "没有输入框的地方（这里的沙箱、别的页面）不给「让 AI 重写这段」按钮");
    const multiBad = TC.cardHtml(esc('{\n"days": [\n{"stops": [{"name": "天安门" "note": "x"}]}]}'), {});
    ok(multiBad.includes("行程卡没画成：第 3 行格式不对"), "第几行按原文的换行数", multiBad.slice(0, 120));
    const host = { dataset: { tc: attr ? TC.unescHtml(attr[1]) : "" }, textContent: "" };
    ok(TC.staticOf(host) === TC.staticHtml(itinerary.parse(evil)), "复制出去用的文字版：从 data-tc 重新排");
    ok(TC.staticOf({ dataset: { tc: "{坏" }, textContent: "<原文>" }) === "&lt;原文&gt;", "data-tc 坏了：退回元素里的文字，照样转义");
    const badHost = { classList: { contains: (c) => c === "tc-bad" }, dataset: {}, textContent: "行程卡没画成：第 1 行格式不对看原文{坏<的}",
      querySelector: (q) => (q === "pre code" ? { textContent: "{坏<的}" } : null) };
    eq(TC.staticOf(badHost), "<pre><code>{坏&lt;的}</code></pre>", "没画成的那块复制出去：只贴原文（代码块），不带按钮、提示");

    // 封顶截掉的，卡片上也说
    const bigCard = TC.staticHtml(TC.parse(SAMPLES[4]));
    const L = TC.LIMIT;
    ok(bigCard.includes(`<div class="tc-smore">这天只显示前 ${L.stops} 站，后面 ${20 - L.stops} 站没列出</div>`) && bigCard.includes(`只显示前 ${L.days} 天，后面 ${20 - L.days} 天没列出`),
      "静态卡片（也是复制出去的那份）：截掉的天、站各说一句");
    ok(!TC.staticHtml(TC.parse(PROMPT_EXAMPLE)).includes("tc-smore"), "没截的不多这一句");
    ok(TC.staticOf({ dataset: { tc: JSON.stringify(TC.parse(SAMPLES[4])) }, textContent: "" }) === bigCard, "截过的存进 data-tc、复制时再排一遍：截掉几站照样说，数不变");
    const fakeCard = TC.cardHtml(esc('{"more":5,"days":[{"more":3,"stops":[{"name":"翠湖公园"}]}]}'), {});
    const fakeAttr = /data-tc="([^"]*)"/.exec(fakeCard);
    ok(!fakeCard.includes("tc-smore") && !/没列出/.test(TC.staticOf({ dataset: { tc: fakeAttr ? TC.unescHtml(fakeAttr[1]) : "" }, textContent: "" })),
      "模型在围栏里自己写了 more：卡片、复制出去的文字版都不说「没列出」", fakeCard);
  }

  // ================= 五、查地点、查路：假的地图服务 =================
  const hits = [];
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120, 7)]);
  const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 3)]);
  const POIS = {
    "翠湖公园": [{ name: "翠湖公园", location: "102.703,25.048", cityname: "昆明市", pname: "云南省", adname: "五华区", address: "翠湖南路67号",
      type: "风景名胜;公园广场;公园", business: { rating: "4.7", opentime_today: "06:30-22:00", opentime_week: "周一至周日 06:30-22:00", tel: "0871-65318406", cost: [], tag: [] },
      photos: [{ url: "https://aos-comment.amap.com/a.jpg" }] }],
    // 不限定城市的话高德会给杭州那座仿建的
    "埃菲尔铁塔": [{ name: "埃菲尔铁塔", location: "120.30,30.40", cityname: "杭州市", pname: "浙江省", adname: "余杭区", address: "天都城", type: "风景名胜", business: {}, photos: [] }],
    "天安门": [{ name: "天安门", location: "116.397469,39.908821", cityname: "北京市", pname: "北京市", adname: "东城区", address: "长安街", type: "风景名胜;风景名胜;国家级景点", business: { rating: [] }, photos: [] }],
    "南强街": [{ name: "南强街巷", location: "102.711,25.036", cityname: "昆明市", pname: "云南省", adname: "五华区", address: "南强街", type: "购物服务;特色商业街;步行街",
      business: { rating: "4.5", opentime_today: "10:00-22:00", cost: "35.00", tag: "过桥米线;鲜花饼" }, photos: [] }],
    "金马碧鸡坊": [{ name: "金马碧鸡坊", location: "102.709,25.034", cityname: "昆明市", pname: "云南省", adname: "五华区", address: "三市街", type: "风景名胜", business: {}, photos: [] }],
  };
  const OSM = {
    "埃菲尔铁塔, 巴黎": [{ lat: "48.8584", lon: "2.2945", name: "埃菲尔铁塔", display_name: "埃菲尔铁塔, 战神广场, 第七区, 巴黎, 法国", type: "attraction", category: "tourism", extratags: { wikidata: "Q243" } }],
    "天安门, 北京": [{ lat: "39.9075", lon: "116.39723", name: "天安门", display_name: "天安门, 东长安街, 东城区, 北京市, 中国", type: "monument", category: "historic", extratags: { image: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Tiananmen.jpg" } }],
    // 没标 wikidata 的：照片要按名字去 Wikidata 搜
    "岳麓山, 长沙": [{ lat: "28.1830", lon: "112.9330", name: "岳麓山", display_name: "岳麓山, 岳麓区, 长沙市, 湖南省, 中国", type: "peak", category: "natural", extratags: {} }],
    "昙华林, 武汉": [{ lat: "30.5550", lon: "114.3000", name: "昙华林", display_name: "昙华林, 武昌区, 武汉市, 湖北省, 中国", type: "pedestrian", category: "highway", extratags: {} }],
    "炸图, 长沙": [{ lat: "28.2000", lon: "112.9700", name: "炸图", display_name: "炸图, 长沙市, 中国", type: "attraction", category: "tourism", extratags: {} }],
    // 标了 Wikidata 条目，但拿条目头图时 Wikidata 回 500
    "坏条目, 长沙": [{ lat: "28.2100", lon: "112.9800", name: "坏条目", display_name: "坏条目, 长沙市, 中国", type: "attraction", category: "tourism", extratags: { wikidata: "Q999" } }],
  };
  /** Wikidata 条目：P625 坐标（WGS-84）、P18 头图 */
  const wd = (lng, lat, file) => ({ ...(lng == null ? {} : { P625: [{ mainsnak: { datavalue: { value: { latitude: lat, longitude: lng } } } }] }), ...(file ? { P18: [{ mainsnak: { datavalue: { value: file } } }] } : {}) });
  // 岳麓山：头一个没坐标、第二个在杭州，第三个才是；第四个也近但排在后面。昙华林：第一个近的没图，第二个是旁边的地铁站
  const WIKI_SEARCH = { "岳麓山": ["Q899", "Q900", "Q901", "Q902"], "昙华林": ["Q910", "Q911"], "金马碧鸡坊": ["Q920"] };
  const WIKI_ENT = { Q899: wd(null, null, "No Coords.jpg"), Q900: wd(120.1, 30.2, "Far Away.jpg"), Q901: wd(112.935, 28.185, "Yuelu Mountain.jpg"), Q902: wd(112.93, 28.18, "Other.jpg"),
    Q910: wd(114.302, 30.556), Q911: wd(114.303, 30.557, "Metro Station.jpg"), Q920: wd(102.704, 25.037, "Jinma Biji.jpg") };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const q = Object.fromEntries(u.searchParams);
    hits.push({ path: u.pathname, q, ua: req.headers["user-agent"] || "" });
    const json = (o, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (u.pathname.startsWith("/v5/") && /bad/.test(q.key)) return json({ status: "0", info: "INVALID_USER_KEY", infocode: "10001" });
    if (u.pathname.startsWith("/v5/") && /over/.test(q.key)) return json({ status: "0", info: "USER_DAILY_QUERY_OVER_LIMIT", infocode: "10044" });
    if (u.pathname === "/v5/place/text") {
      if (q.keywords === "炸了") return json({ oops: true }, 500);
      if (q.keywords === "参数错") return json({ status: "0", info: "INVALID_PARAMS", infocode: "20000" });
      return json({ status: "1", info: "OK", infocode: "10000", pois: POIS[q.keywords] || [] });
    }
    if (u.pathname === "/v5/direction/walking" || u.pathname === "/v5/direction/driving") {
      if (q.destination === "102.733000,25.053000") return json({ oops: true }, 500);
      const walk = u.pathname.endsWith("walking");
      return json({ status: "1", route: { paths: [{ distance: walk ? "1180" : "5230", cost: { duration: walk ? "900" : "780" },
        steps: [{ polyline: `${q.origin};102.705,25.045` }, { polyline: `102.706,25.043;${q.destination}` }] }] } });
    }
    if (u.pathname === "/search") return json(OSM[q.q] || []);
    if (u.pathname === "/w/api.php") {
      if (q.action === "wbsearchentities") return q.search === "炸图" ? json({ oops: true }, 500) : json({ search: (WIKI_SEARCH[q.search] || []).map((id) => ({ id })) });
      if (q.action === "wbgetentities") return json({ entities: Object.fromEntries(String(q.ids).split("|").map((id) => [id, { claims: WIKI_ENT[id] || {} }])) });
      if (q.entity === "Q999") return json({ oops: true }, 500);
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
    const yes = ["https://aos-comment.amap.com/a.jpg", "https://store.is.autonavi.com/x.jpg", "https://upload.wikimedia.org/a.jpg", "https://commons.wikimedia.org/wiki/Special:FilePath/a.jpg",
      "https://thumb.wikimedia.org/wikipedia/commons/thumb/5/5d/a.jpg/330px-a.jpg"];
    const no = ["https://evil.com/a.jpg", "https://upload.wikimedia.org.evil.com/a.jpg", "https://wikimedia.org.evil.com/a.jpg", "https://notwikimedia.org/a.jpg", "https://fakeamap.com/a.jpg", "https://upload.wikimedia.org:8443/a.jpg",
      "https://u:p@upload.wikimedia.org/a.jpg", "file:///etc/passwd", "javascript:alert(1)", "ftp://upload.wikimedia.org/a.jpg", "not a url", "http://127.0.0.1/a.jpg"];
    ok(yes.every(tiles.allowed), "高德、Wikimedia 的图床放行（缩略图会从 commons 跳到 thumb.wikimedia.org）", yes.filter((u) => !tiles.allowed(u)));
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
    const DEF = { search: places.SEARCH_CAP, route: places.ROUTE_CAP };
    ok(DEF.search === 4500 && DEF.route === 140000, "每月默认上限：搜索 4500、路线 14 万（比高德给个人认证开发者的 5000 / 15 万各留一点）", DEF);
    eq(places.settingsOf({}), { provider: "auto", key: "", from: "", caps: DEF }, "什么都没配：auto，没 Key，按月的默认上限");
    eq(places.settingsOf({ map: { amap_key: " sk-test-amap ", amap_search_cap: 50, amap_route_cap: "300" } }), { provider: "auto", key: "sk-test-amap", from: "settings", caps: { search: 50, route: 300 } },
      "设置里填的 Key（去掉两边空白）、搜索和路线各自的上限");
    eq(places.settingsOf({ mcp_servers: [{ env: {} }, { env: { AMAP_MAPS_API_KEY: "sk-test-conn" } }] }), { provider: "auto", key: "sk-test-conn", from: "connector", caps: DEF }, "设置里没填：用高德连接器里那把");
    eq(places.settingsOf({ map: { amap_key: "sk-test-set" }, mcp_servers: [{ env: { AMAP_MAPS_API_KEY: "sk-test-conn" } }] }).from, "settings", "两处都有：设置里的优先");
    eq(places.settingsOf({ map: { provider: "osm", amap_key: "sk-test-amap" }, mcp_servers: [{ env: { AMAP_MAPS_API_KEY: "sk-test-conn" } }] }).key, "", "选了 OpenStreetMap：哪儿的 Key 都不用");
    eq([0, "-1", "abc", 12.7].map((c) => places.settingsOf({ map: { amap_search_cap: c, amap_route_cap: c } }).caps),
      [{ search: 0, route: 0 }, DEF, DEF, { search: 12, route: 12 }], "上限：0 是不用高德，负数和乱填的按默认，小数取整");
    eq([0, "-1", "abc", 12.7, 50, 1999, 2001].map((c) => places.settingsOf({ map: { amap_daily_cap: c } }).caps),
      [{ search: 0, route: 0 }, DEF, DEF, { search: 372, route: 372 }, { search: 1550, route: 1550 }, { search: 4500, route: 61969 }, { search: 4500, route: 62031 }],
      "老配置只有「每天上限」：按 31 天折成每月，不超过新默认值（不会比原来允许的多打）；填过 0 的还是不用高德");
    eq(places.settingsOf({ map: { amap_daily_cap: 2000 } }).caps, DEF, "老设置页每次保存都写上默认的每天 2000：当没填，按新的默认（不把路线压到 6.2 万）");
    eq(places.settingsOf({ map: { amap_daily_cap: 0, amap_search_cap: 100 } }).caps, { search: 100, route: 0 }, "新的两项填了哪项就用哪项，没填的那项才看老的");
    eq(places.settingsOf({ map: { provider: "baidu" } }).provider, "auto", "不认识的 provider 按 auto");
  }

  const KEY = "amap-test-key-0123456789";
  const withKey = { map: { amap_key: KEY } };
  console.log("\n七、查地点");
  {
    const r = await places.lookup(withKey, [{ name: "翠湖公园", city: "昆明" }]);
    const p = r.items[0];
    eq(p, { ok: true, name: "翠湖公园", lng: 102.703, lat: 25.048, datum: "gcj02", addr: "五华区 翠湖南路67号", kind: "公园", rating: 4.7, photo: "https://aos-comment.amap.com/a.jpg", photoSrc: "amap", src: "amap",
      hours: "周一至周日 06:30-22:00", tel: "0871-65318406" },
      "有 Key：高德 POI 给坐标（GCJ-02）、地址、类别、评分、照片；地点和照片各标来自哪；营业时间、电话原样带上，高德给的空数组（人均、特色）不带");
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
    const sb = south.items[0];
    eq([sb.hours, sb.tel, sb.cost, sb.tag], ["10:00-22:00", undefined, "35", "过桥米线;鲜花饼"], "没有一周的营业时间就用今天的；人均「35.00」写成 35；特色原样；没给电话就不带");

    const nSearch = count("/search");
    const paris = await places.lookup(withKey, [{ name: "埃菲尔铁塔", city: "巴黎" }]);
    const pp = paris.items[0];
    ok(pp.ok && pp.src === "osm" && pp.datum === "wgs84" && pp.lng === 2.2945 && pp.lat === 48.8584, "高德只搜到杭州那座仿建的：城市对不上不要，改去 OpenStreetMap 查到巴黎那座", pp);
    ok(pp.kind === "景点" && pp.rating === null && pp.addr === "战神广场，第七区，巴黎", "OSM 的类别翻成中文；没有评分；地址取中间几段", pp);
    const s = last("/search");
    ok(count("/search") === nSearch + 1 && s.q.q === "埃菲尔铁塔, 巴黎" && s.q.format === "jsonv2" && s.q.limit === "1" && s.q.extratags === "1" && /OpenWorkBuddy/.test(s.ua),
      "Nominatim 请求：名字带城市、jsonv2、只要一条、要 extratags、带 User-Agent（它的使用条款要求）", s && s.q);
    // 照片不在这一趟里等：钉子先钉上，照片前端再来 photos 要
    ok(pp.photo === "" && pp.photoPending === true && pp.qid === "Q243", "OSM 没给照片：先不等 Wikidata，标「照片待补」，带上条目号", pp);
    const nwp = count("/w/api.php");
    const ph = await places.photos([{ name: "埃菲尔铁塔", city: "巴黎", lng: pp.lng, lat: pp.lat, datum: pp.datum, qid: pp.qid }]);
    eq(ph.items[0], { photo: "https://commons.wikimedia.org/wiki/Special:FilePath/Tour_Eiffel_Wikimedia_Commons.jpg?width=320", src: "wikidata" },
      "photos：拿条目号去 Wikidata 要头图（空格换下划线、要 320 宽的），标来自 Wikidata");
    ok(count("/w/api.php") === nwp + 1 && last("/w/api.php").q.entity === "Q243" && last("/w/api.php").q.property === "P18", "Wikidata 要的是 P18（图像），一次就够");
    const pp2 = (await places.lookup(withKey, [{ name: "埃菲尔铁塔", city: "巴黎" }])).items[0];
    ok(pp2.photo === ph.items[0].photo && pp2.photoSrc === "wikidata" && !pp2.photoPending, "补过的照片下次查地点时直接带上，不再标待补", pp2);

    const mixed = await places.lookup(withKey, [{ name: "翠湖公园", city: "昆明" }, { name: "埃菲尔铁塔", city: "巴黎" }]);
    ok(mixed.provider === "mixed" && mixed.items.map((x) => x.src).join() === "amap,osm", "一批里有高德的、有 OpenStreetMap 的：provider 报 mixed，每一站各标各的", mixed.provider);

    // 高德报的是 Key 本身的毛病：当天停掉高德，说一次
    const badKey = "amap-test-badkey-987654321";
    const nb = count("/v5/place/text");
    const bad = await places.lookup({ map: { amap_key: badKey } }, [{ name: "滇池", city: "昆明" }]);
    ok(bad.amapOff === "高德：INVALID_USER_KEY（10001）", "Key 不对：高德的原话原样往上递（amapOff），不替人猜原因", bad);
    ok(!JSON.stringify(bad).includes(badKey), "报错里不带 Key");
    eq(bad.items[0], { ok: false, tried: ["osm"] }, "高德停了不算问过：只问了 OpenStreetMap，它也没有 → 没找到（不是没查成，再查一次也一样）");
    eq(places.usage({}).stop, "高德：INVALID_USER_KEY（10001）", "今天停了高德：设置页看得到原话");
    const again2 = await places.lookup({ map: { amap_key: badKey } }, [{ name: "滇池", city: "昆明" }, { name: "西山", city: "昆明" }, { name: "海埂", city: "昆明" }]);
    ok(count("/v5/place/text") === nb + 1 && again2.amapOff === "高德：INVALID_USER_KEY（10001）", "当天后面的站一次也不再打高德（每站再试只是白记用量）", count("/v5/place/text") - nb);
    places.resetStop();
    ok(places.usage({}).stop === "", "resetStop（存地图设置时调）：今天的停用作废");
    // 一批一起来、Key 又是坏的：头一站先去问，后面的等它回话——高德只挨一下，用量也只记一次
    const nbb = count("/v5/place/text"), ub = places.usage({}).used.search;
    const batch = await places.lookup({ map: { amap_key: "amap-test-badkey-batch" } }, ["石屏", "建水", "元阳", "弥勒"].map((name) => ({ name, city: "红河" })));
    ok(count("/v5/place/text") === nbb + 1 && places.usage({}).used.search === ub + 1 && batch.amapOff === "高德：INVALID_USER_KEY（10001）"
      && batch.items.every((x) => x.ok === false && !x.failed), "一批四站、Key 不对：高德只打了一次，用量只记一次，四站都去问了 OpenStreetMap",
      { hits: count("/v5/place/text") - nbb, used: places.usage({}).used.search - ub, items: batch.items });
    places.resetStop();
    const nok = count("/v5/place/text");
    await places.lookup(withKey, ["个旧", "开远", "蒙自"].map((name) => ({ name, city: "红河" })));
    ok(count("/v5/place/text") === nok + 3, "Key 是好的：一批照常每站都问（只有头一回要等）", count("/v5/place/text") - nok);
    for (const [k, code] of [["amap-test-over-1", "10044"]]) {
      await places.lookup({ map: { amap_key: k } }, [{ name: "大观楼", city: "昆明" }]);
      ok(places.usage({}).stop.endsWith(`（${code}）`), `高德说当天总量用完（${code}）：也停`, places.usage({}).stop);
      places.resetStop();
    }
    const pe = await places.lookup(withKey, [{ name: "参数错", city: "昆明" }]);
    ok(!pe.amapOff && places.usage({}).stop === "" && pe.notes.includes("高德：INVALID_PARAMS（20000）"), "别的错（这一站的参数不对）只算这一次没成，不停高德", pe);
    eq(pe.items[0], { ok: false, failed: true, error: "高德：INVALID_PARAMS（20000）" }, "高德报错 + OSM 也没查到：标没查成，带原话（前端不记住它，能再查一次）");
    const np = count("/v5/place/text");
    await places.lookup(withKey, [{ name: "参数错", city: "昆明" }]);
    ok(count("/v5/place/text") === np + 1, "报错的结果不进缓存：下次照样再查");

    const boom = await places.lookup(withKey, [{ name: "炸了", city: "昆明" }]);
    ok(boom.notes.some((n) => /^高德 回了 HTTP 500/.test(n)) && !JSON.stringify(boom).includes(KEY), "对方回 500：说是哪一家（人认得的名字）、什么状态码，不带请求地址（里面有 Key）", boom.notes);
    ok(boom.items[0].failed === true && /^高德 回了 HTTP 500/.test(boom.items[0].error) && !boom.amapOff, "  这一站标没查成；不停高德", boom.items[0]);

    const nc = count("/v5/place/text");
    const capped = await places.lookup({ map: { amap_key: KEY, amap_search_cap: 0 } }, [{ name: "石林", city: "昆明" }]);
    ok(count("/v5/place/text") === nc && capped.notes.includes("这个月的高德搜索次数到上限了，先改用 OpenStreetMap"), "这个月的搜索上限到了：一次也不打高德，说一声改用 OpenStreetMap", capped.notes);
    ok(last("/search").q.q === "石林, 昆明", "到上限的那一站照样去 OpenStreetMap 查");
    eq(capped.items[0], { ok: false, tried: ["osm"] }, "到上限不算问过高德，也不算没查成");

    const no = count("/v5/place/text");
    const osm = await places.lookup({ map: { provider: "osm", amap_key: KEY } }, [{ name: "天安门", city: "北京" }]);
    ok(count("/v5/place/text") === no && osm.provider === "osm" && osm.items[0].src === "osm", "选了 OpenStreetMap：填着 Key 也一次不打高德");
    ok(osm.items[0].photo === "https://upload.wikimedia.org/wikipedia/commons/a/ab/Tiananmen.jpg" && osm.items[0].photoSrc === "wikimedia" && osm.items[0].kind === "纪念碑" && !osm.items[0].photoPending,
      "OSM 自带 Wikimedia 照片就直接用，标来自 Wikimedia", osm.items[0]);

    await places.lookup({ mcp_servers: [{ env: { AMAP_MAPS_API_KEY: "sk-test-conn-1" } }] }, [{ name: "翠湖公园", city: "大理" }]);
    ok(last("/v5/place/text").q.key === "sk-test-conn-1", "设置里没填：用连接器那把 Key 去查");

    const both = await places.lookup(withKey, [{ name: "没这地方", city: "昆明" }]);
    eq(both.items[0], { ok: false, tried: ["amap", "osm"] }, "高德、OpenStreetMap 都正常回了「没有」：没找到，带上问过谁");
    eq((await places.lookup({}, [{ name: "没这地方", city: "大理" }])).items[0], { ok: false, tried: ["osm"] }, "没 Key：只问了 OpenStreetMap");

    const many = await places.lookup(withKey, Array.from({ length: 25 }, () => ({ name: "" })));
    ok(many.items.length === places.MAX_ITEMS && many.items.every((x) => x.ok === false && !x.failed), `一次最多 ${places.MAX_ITEMS} 个，没名字的直接算没找到（不打接口）`);
    eq(await places.lookup(withKey, "乱给的"), { provider: "", items: [], notes: [] }, "items 不是数组：回空的，不抛错");

    // 照片：按名字去 Wikidata 搜（photos），跟查地点分开
    const yl = await places.lookup({}, [{ name: "岳麓山", city: "长沙" }, { name: "昙华林", city: "武汉" }]);
    ok(yl.items.every((x) => x.ok && x.photo === "" && x.photoPending === true), "OSM 没标 Wikidata 也没给图：标待补", yl.items);
    const at = (x) => ({ name: x.name, lng: x.lng, lat: x.lat, datum: x.datum, qid: x.qid });
    const ylp = await places.photos([{ ...at(yl.items[0]), name: "岳麓山", city: "长沙" }, { ...at(yl.items[1]), name: "昙华林", city: "武汉" }]);
    ok(ylp.items[0].photo === "https://commons.wikimedia.org/wiki/Special:FilePath/Yuelu_Mountain.jpg?width=320" && ylp.items[0].src === "wikidata",
      "拿名字去搜，按排名取第一个 3 公里内的条目的头图（没坐标的、离太远的跳过）", ylp.items[0]);
    eq(ylp.items[1], { photo: "", src: "" }, "第一个离得近的条目没头图：就不配图，不往下拿旁边地铁站那张");
    const ws = hits.filter((h) => h.path === "/w/api.php" && h.q.action === "wbsearchentities").slice(-2);
    ok(ws.length === 2 && ws.map((h) => h.q.search).sort().join() === "岳麓山,昙华林" && ws.every((h) => h.q.language === "zh" && /OpenWorkBuddy/.test(h.ua)),
      "Wikidata 按中文名搜，带 User-Agent", ws.map((h) => h.q));
    const nw = count("/w/api.php");
    const yl2 = await places.lookup({}, [{ name: "岳麓山", city: "长沙" }, { name: "昙华林", city: "武汉" }]);
    ok(count("/w/api.php") === nw && yl2.items[0].photoSrc === "wikidata" && !yl2.items[0].photoPending && !yl2.items[1].photoPending && yl2.items[1].photo === "",
      "补过的照片记住了（找到的、没找到的都算）：再查地点直接带上，不再标待补、不再搜", yl2.items);
    eq(await places.photos([{ name: "岳麓山", city: "长沙", lng: yl.items[0].lng, lat: yl.items[0].lat }, { name: "", lng: 1, lat: 1 }, { name: "无坐标" }, null]),
      { items: [{ photo: "https://commons.wikimedia.org/wiki/Special:FilePath/Yuelu_Mountain.jpg?width=320", src: "wikidata" }, { photo: "", src: "" }, { photo: "", src: "" }, { photo: "", src: "" }] },
      "photos：补过的从缓存拿；没名字、没坐标的给空，不抛错");
    ok(count("/w/api.php") === nw, "  这些一次都没打 Wikidata");
    const jm = await places.lookup(withKey, [{ name: "金马碧鸡坊", city: "昆明" }]);
    ok(jm.items[0].src === "amap" && jm.items[0].photo === "" && jm.items[0].photoPending, "高德没给照片：同样标待补", jm.items[0]);
    const jmp = await places.photos([{ ...at(jm.items[0]), city: "昆明" }]);
    ok(jmp.items[0].photo === "https://commons.wikimedia.org/wiki/Special:FilePath/Jinma_Biji.jpg?width=320", "高德的点（GCJ-02）照样去 Wikidata 补，按换算后的坐标比远近", jmp.items[0]);
    const zt = await places.lookup({}, [{ name: "炸图", city: "长沙" }]);
    ok(zt.items[0].ok && zt.items[0].photoPending && zt.notes.length === 0, "地点照样给", zt);
    const ztp = await places.photos([{ ...at(zt.items[0]), city: "长沙" }]);
    eq(ztp.items[0], { photo: "", src: "" }, "Wikidata 回 500：没照片，不往卡片上报错");
    const nz = count("/w/api.php");
    await places.photos([{ ...at(zt.items[0]), city: "长沙" }]);
    const zt2 = await places.lookup({}, [{ name: "炸图", city: "长沙" }]);
    ok(count("/w/api.php") === nz && !zt2.items[0].photoPending, "补照片出错记一小会儿：十分钟里不再挨个去撞（Wikidata 连不上时每站都要等超时）", count("/w/api.php") - nz);
    // 按条目号拿头图出错：跟「这个条目没图」分开记——没图的会接着按名字搜，出错的十分钟里谁都不再去撞
    const bq = await places.lookup({}, [{ name: "坏条目", city: "长沙" }]);
    ok(bq.items[0].ok && bq.items[0].qid === "Q999" && bq.items[0].photoPending, "（标了条目号，照片待补）", bq.items[0]);
    const nq = count("/w/api.php");
    const bqp = [];
    for (let i = 0; i < 3; i++) bqp.push((await places.photos([{ ...at(bq.items[0]), city: "长沙" }])).items[0]);
    eq(bqp, [0, 1, 2].map(() => ({ photo: "", src: "" })), "条目号那一下 Wikidata 回 500：没照片，不往卡片上报错");
    ok(count("/w/api.php") === nq + 1 && hits.filter((h) => h.path === "/w/api.php").slice(-1)[0].q.entity === "Q999",
      "连要三回：只第一回去问了 Wikidata（条目号那一下），后两回不再去撞、也不改按名字搜", count("/w/api.php") - nq);
    const bq2 = await places.lookup({}, [{ name: "坏条目", city: "长沙" }]);
    ok(!bq2.items[0].photoPending && bq2.items[0].photo === "" && count("/w/api.php") === nq + 1, "再查地点：不再标照片待补（前端不会过来白等一次）", bq2.items[0]);

    const ctl = places._testing({});
    await ctl.flush();
    const disk = fs.readFileSync(ctl.cacheFile, "utf8");
    ok(disk.includes("a|昆明|翠湖公园") && disk.includes("o|巴黎|埃菲尔铁塔") && disk.includes("w|长沙|岳麓山") && disk.includes("q|Q243"), "查过的记了盘（补的照片单记一条）", ctl.cacheFile);
    ok(!disk.includes("sk-test") && !disk.includes(KEY), "盘上的缓存里没有 Key");
    places._testing({ reset: true });
    const nd = count("/v5/place/text");
    const again = await places.lookup(withKey, [{ name: "翠湖公园", city: "昆明" }]);
    ok(count("/v5/place/text") === nd && again.items[0].rating === 4.7, "重启后（内存清空）从盘上读回来，不再打高德");
    const dj = JSON.parse(disk);
    ok(dj.month === new Date().toLocaleDateString("sv").slice(0, 7) && dj.used.search >= 5 && dj.used.route === 0, `这个月打了几次高德记在盘上，搜索、路线分开（搜索 ${dj.used.search}）`, dj.used);
    eq(places.usage(withKey).used, dj.used, "设置页看到的次数就是盘上那个");

    // 上个月的次数、昨天的停用：读盘时作废；老格式（{ day, used: 数字 }）的 items 照用，次数从这个月重新数
    const items = dj.items;
    for (const [what, raw] of [["上个月的", { month: "1999-01", used: { search: 9, route: 9 }, stop: { day: "1999-01-31", msg: "高德：X（10001）" }, items }],
      ["老格式", { day: "1999-01-31", used: 1234, items }]]) {
      fs.writeFileSync(ctl.cacheFile, JSON.stringify(raw));
      places._testing({ reset: true });
      const u = places.usage(withKey);
      ok(u.used.search === 0 && u.used.route === 0 && u.stop === "", `${what}缓存：次数从这个月重新数、不带昨天的停用`, u);
      const n1 = count("/v5/place/text");
      await places.lookup(withKey, [{ name: "翠湖公园", city: "昆明" }]);
      ok(count("/v5/place/text") === n1, `  ${what}缓存里查过的地点照用`);
    }
    // 加营业时间、电话这几项之前记的缓存：照用，没有就不显示，不为补这几项回头再打高德
    const oldItems = JSON.parse(JSON.stringify(items));
    for (const f of ["hours", "tel", "cost", "tag"]) delete oldItems["a|昆明|翠湖公园"].r[f];
    fs.writeFileSync(ctl.cacheFile, JSON.stringify({ month: dj.month, used: dj.used, items: oldItems }));
    places._testing({ reset: true });
    const n3 = count("/v5/place/text");
    const oldP = (await places.lookup(withKey, [{ name: "翠湖公园", city: "昆明" }])).items[0];
    ok(count("/v5/place/text") === n3 && oldP.ok && oldP.rating === 4.7 && !("hours" in oldP) && !("tel" in oldP),
      "老缓存里没有营业时间、电话：地点照用，这几项就不带，一次高德也不多打", oldP);
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

    // 高德这一次查路报错（不是 Key 坏了、不是到数）：先画直线，标没查成、带原话
    const BOOM = { lng: 102.733, lat: 25.053, datum: "gcj02" };
    const nf = count("/v5/direction/walking") + count("/v5/direction/driving");
    const fl = await places.legs(withKey, [{ a: A, b: BOOM }, { a: A, b: B }]);
    ok(fl.items[0].mode === "line" && fl.items[0].failed === true && /^高德 回了 HTTP 500/.test(fl.items[0].error) && !fl.amapOff && !JSON.stringify(fl).includes(KEY),
      "这一段高德报错：先画直线，标没查成、带原话（前端「再查一次」只重查这段）；不停高德，不带 Key", fl.items[0]);
    ok(fl.items[1].mode === "walking" && !fl.items[1].failed, "同一批里别的段照常", fl.items[1]);
    await places.legs(withKey, [{ a: A, b: BOOM }]);
    ok(count("/v5/direction/walking") + count("/v5/direction/driving") === nf + 2, "报错画的直线不进缓存：再查一次真去问", count("/v5/direction/walking") + count("/v5/direction/driving") - nf);
    ok(!l0.failed, "没 Key 画的直线不算没查成");

    const n2 = count("/v5/direction/walking") + count("/v5/direction/driving");
    const skip = await places.legs(withKey, [{ a: A, b: DALI }, { a: P1, b: P2 }, { a: A, b: { ...A, lng: A.lng + 0.0001 } },
      { a: A, b: { lng: 999, lat: 0 } }, { a: null, b: B }, { a: A, b: { lng: "", lat: "" } }, { a: A, b: { lng: null, lat: null } }, null, { a: A, b: "x" }]);
    eq(skip.items.map((x) => x && x.mode), ["line", "line", "line", null, null, null, null, null, null], "跨城（>150 公里）、国外、近得不到 30 米：画直线；坐标缺了、坏了给 null（不当成经纬度 0,0）");
    ok(count("/v5/direction/walking") + count("/v5/direction/driving") === n2, "这些一次都没打高德");
    ok((await places.legs({}, Array.from({ length: 25 }, () => ({ a: A, b: B })))).items.length === places.MAX_LEGS, `一次最多 ${places.MAX_LEGS} 段`);

    const badLeg = await places.legs({ map: { amap_key: "amap-test-badkey-2" } }, [{ a: A, b: { lng: 102.72, lat: 25.04, datum: "gcj02" } }]);
    ok(badLeg.items[0].mode === "line" && badLeg.amapOff === "高德：INVALID_USER_KEY（10001）", "Key 不对：退回直线，高德原话带上（amapOff），今天停用", badLeg);
    const nr = count("/v5/direction/walking") + count("/v5/direction/driving");
    const stopped = await places.legs(withKey, [{ a: A, b: { lng: 102.721, lat: 25.041, datum: "gcj02" } }]);
    ok(count("/v5/direction/walking") + count("/v5/direction/driving") === nr && stopped.items[0].mode === "line" && stopped.amapOff, "停用的这一天：查路也不打高德，画直线");
    places.resetStop();

    const ur = places.usage(withKey).used.route;
    ok(ur >= 3, `路线次数单独记（${ur}）`);
    const rc = await places.legs({ map: { amap_key: KEY, amap_route_cap: ur } }, [{ a: A, b: { lng: 102.722, lat: 25.042, datum: "gcj02" } }]);
    ok(rc.items[0].mode === "line" && rc.notes.includes("这个月的高德路线次数到上限了，两站之间先画直线") && count("/v5/direction/walking") + count("/v5/direction/driving") === nr,
      "这个月的路线上限到了：不打高德，画直线，说一声", rc);
    const sc = await places.lookup({ map: { amap_key: KEY, amap_route_cap: 0 } }, [{ name: "南强街", city: "大理" }]);
    ok(sc.items[0].ok === false && !sc.notes.length && last("/v5/place/text").q.region === "大理", "路线到数了不挡搜索：两样各算各的", sc);
    ok([badLeg, stopped, rc].every((x) => x.items[0].mode === "line" && !x.items[0].failed), "停用、到上限画的直线不标没查成（再查也一样，不白花次数）");
    // 查地点、查路同时来，Key 又是坏的：也只撞一次
    const allHits = () => count("/v5/place/text") + count("/v5/direction/walking") + count("/v5/direction/driving");
    const nm = allHits();
    const mixKey = { map: { amap_key: "amap-test-badkey-mix" } };
    const [ml, mg] = await Promise.all([places.lookup(mixKey, [{ name: "抚仙湖", city: "玉溪" }, { name: "澄江", city: "玉溪" }]),
      places.legs(mixKey, [{ a: A, b: { lng: 102.75, lat: 25.06, datum: "gcj02" } }, { a: A, b: { lng: 102.76, lat: 25.07, datum: "gcj02" } }])]);
    ok(allHits() === nm + 1 && ml.amapOff && mg.items.every((x) => x.mode === "line" && !x.failed), "查地点、查路一起来、Key 不对：高德一共只挨一下", allHits() - nm);
    places.resetStop();

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
    const u0 = places.usage({}).used.search;
    const tc = await places.test({ map: { amap_key: KEY, amap_search_cap: 0 } }).catch((e) => ({ error: e.message }));
    ok(tc.ok && tc.provider === "amap", "上限填了 0 也能测：人点的这一下不被每月的上限挡住", tc);
    ok(places.usage({}).used.search === u0 + 1, "  测的这一下照算进这个月的搜索次数", { before: u0, after: places.usage({}).used });
    await rejects(places.test({}, "amap-test-badkey-3"), /^高德：INVALID_USER_KEY（10001）$/, "Key 不对：原话报出来");
    ok(places.usage({}).stop === "", "测一把不对的 Key 不停卡片用的高德（测的未必是存着的那把）");

    await places.lookup({ map: { amap_key: "amap-test-badkey-4" } }, [{ name: "圆通山", city: "昆明" }]);
    ok(places.usage({}).stop !== "", "（卡片撞上 Key 不对，今天停了）");
    const ts = await places.test({ map: { amap_key: "amap-test-badkey-4" } }, KEY).catch((e) => ({ error: e.message }));
    ok(ts.ok && places.usage({}).stop !== "", "停用时也能测；测的不是存着的那把：不解除停用", ts);
    const tt = await places.test({ map: { amap_key: KEY } }).catch((e) => ({ error: e.message }));
    ok(tt.ok && places.usage({}).stop === "", "测存着的那把、而且通了：今天的停用作废，卡片接着用高德", tt);

    places._testing({ bases: { amap: "http://127.0.0.1:1" } });
    const e = await rejects(places.test({}, KEY), /^高德 连不上：/, "连不上：说连不上哪一家（人认得的名字，不是地址）");
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
    ok(!JSON.stringify(c).includes("sk-test") && !JSON.stringify(c).includes(KEY), "config 里不给 Key 本身");
    ok(c.usage && c.usage.caps.search === 4500 && c.usage.caps.route === 140000 && typeof c.usage.used.search === "number" && c.usage.stop === "", "config 带上这个月用了几次、上限、今天停没停（设置页显示）", c.usage);
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
    const phr = await (await post("/api/geo/photos", { items: [{ name: "岳麓山", city: "长沙", lng: 112.933, lat: 28.183, datum: "wgs84" }] })).json();
    ok(phr.items && phr.items[0].photo.includes("Yuelu_Mountain.jpg") && phr.items[0].src === "wikidata", "photos：补得到", phr);
    const phe = await post("/api/geo/photos", {});
    ok(phe.status === 200 && (await phe.json()).items.length === 0, "photos 没给 items：回空的");

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

    // 「发到手机」的二维码：只编卡片自己生成的导航链接
    const QR_OPTS = { type: "svg", margin: 2, errorCorrectionLevel: "M" };
    const A = { lng: 102.703, lat: 25.048, datum: "gcj02", name: "翠湖公园" }, B = { lng: 102.71, lat: 25.04, datum: "gcj02", name: "南强街" };
    const C = { lng: 102.72, lat: 25.03, datum: "gcj02", name: "金马碧鸡坊" };
    const P1 = { lng: 2.2945, lat: 48.8584, datum: "wgs84", name: "埃菲尔铁塔" }, P2 = { lng: 2.3376, lat: 48.8606, datum: "wgs84", name: "卢浮宫" };
    const links = [...TC.NAV_MODES.flatMap(([m]) => [TC.legNavUrl(A, B, m), TC.legNavUrl(P1, P2, m)]), TC.legNavUrl(A, B, "line"),
      TC.dayNavUrl([A, B]), TC.dayNavUrl([A, B, C]), TC.dayNavUrl([P1, P2, P1, P2]), TC.stopNavUrl(A), TC.stopNavUrl({ ...A, datum: "wgs84" }), TC.stopNavUrl(P1)];
    const nh = hits.length;
    const qrBad = [];
    for (const u of links) {
      const r = await fetch(API + "/api/geo/qr?u=" + encodeURIComponent(u));
      const body = await r.text();
      const want = await require("qrcode").toString(u, QR_OPTS);
      if (r.status !== 200 || r.headers.get("content-type") !== "image/svg+xml; charset=utf-8" || body !== want || /<script/i.test(body) || navLink(u) !== u) qrBad.push([u, r.status, body.slice(0, 80)]);
    }
    ok(links.length === 15 && qrBad.length === 0, `卡片生成的 ${links.length} 种导航链接（段间四种走法、整天路线、导航到这；国内高德、国外 Google）都编得出二维码，编进去的就是那条链接本身`, qrBad);
    const q1 = await fetch(API + "/api/geo/qr?u=" + encodeURIComponent(links[0]));
    ok(/private/.test(q1.headers.get("cache-control") || "") && q1.headers.get("x-content-type-options") === "nosniff", "二维码：private 缓存，nosniff");
    const nope = [
      ["没给", ""],
      ["http 的", "http://uri.amap.com/navigation?to=102.7,25.04,x"],
      ["别的网站", "https://evil.example/navigation?to=1,2"],
      ["长得像的域名", "https://uri.amap.com.evil.example/navigation?to=1,2"],
      ["带端口", "https://uri.amap.com:8443/navigation?to=1,2"],
      ["带用户名", "https://someone@uri.amap.com/navigation?to=1,2"],
      ["高德别的页面", "https://uri.amap.com/marker?position=1,2"],
      ["Google 别的页面", "https://www.google.com/search?q=x"],
      ["Google 别的子域名", "https://maps.google.com/maps/dir/?api=1&destination=1,2"],
      ["javascript:", "javascript:alert(1)"],
      ["不是链接", "随便写的字"],
      ["太长", "https://uri.amap.com/navigation?to=1,2," + "x".repeat(2100)],
    ];
    const nopeBad = [];
    for (const [why, u] of nope) {
      const r = await fetch(API + "/api/geo/qr" + (u ? "?u=" + encodeURIComponent(u) : ""));
      const t = await r.text();
      if (r.status !== 400 || /svg/.test(r.headers.get("content-type") || "") || !t) nopeBad.push([why, r.status, t]);
    }
    ok(nopeBad.length === 0, `不是卡片那几种导航链接的一律 400，回一句原因（${nope.map((x) => x[0]).join("、")}）`, nopeBad);
    const twice = await fetch(API + "/api/geo/qr?u=" + encodeURIComponent(links[0]) + "&u=" + encodeURIComponent(links[1]));
    ok(twice.status === 400, "u 给了两个：400", twice.status);
    const why = await (await fetch(API + "/api/geo/qr?u=" + encodeURIComponent("https://evil.example/x"))).text();
    ok(why === "只给行程卡里的导航链接生成二维码", "原因照实写", why);
    ok(hits.length === nh, "编二维码一次都没往外发请求（不碰高德）", hits.slice(nh));
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
    eq(imReply.chunks(badReply).join("\n\n"), "看：\n行程卡没画成：第 1 行格式不对，下面是原文：\n\n```itinerary\n{坏的\n```", "IM：解不开的先说一句哪行不对，原文照发，不吞内容");
    const badPrep = imReply.chunks((await imReply.prepareFigures(badReply, { canSend: false })).text).join("\n\n");
    ok(badPrep.split("行程卡没画成").length === 2, "IM 真走的那条路（先 prepareFigures 再切段）：「行程卡没画成」只说一次", badPrep);
    const bigReply = "```itinerary\n" + SAMPLES[4] + "\n```";
    ok(imReply.chunks(bigReply).join("\n\n").includes("只显示前 14 天，后面 6 天没列出"), "IM：截掉的天数也说");

    const plain = (md) => { const r = mdTty.createRenderer({ color: false }); return r.write(md) + r.end(); };
    const streamed = (md, n) => { const r = mdTty.createRenderer({ color: false }); let o = ""; for (let i = 0; i < md.length; i += n) o += r.write(md.slice(i, i + n)); return o + r.end(); };
    const out = plain(reply);
    ok(out.includes("第1天 · 老昆明慢逛") && out.includes("• 上午 · 翠湖公园：湖边散步、喝咖啡") && !out.includes('"stops"') && !out.includes("itinerary"), "命令行：渲染成按天排的文字，不打 JSON", out);
    ok(streamed(reply, 7) === out, "命令行一段段流式喂进来，结果跟一次给全一样");
    const bo = plain(badReply);
    ok(bo.includes("行程卡没画成：第 1 行格式不对，下面是原文：\n│ itinerary") && bo.includes("│ {坏的"), "命令行：解不开的先说哪行不对，再照代码块打出来", bo);
    ok(streamed(badReply, 3) === bo, "  流式喂进来也一样");
    const bigOut = plain("```itinerary\n" + SAMPLES[4] + "\n```");
    ok(bigOut.includes("只显示前 14 天，后面 6 天没列出") && bigOut.includes("这天只显示前 15 站，后面 5 站没列出"), "命令行：截掉的天、站也说");
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
    const app05 = read("public/js/app-05.js");
    ok(/\["map", "地图", "map"\]/.test(app05) && /active === "map"\) renderMapPane\(pane, s\)/.test(app05) && /^function renderMapPane\(pane, s\)/m.test(app05),
      "设置里地图单独一页（左栏「地图」），不再埋在联网搜索页最底下");
    ok(/PLATFORM_ONLY_CATS = new Set\(\[[^\]]*"map"/.test(app05), "地图那页只给平台管理员（Key 是整台服务器的）");
    ok(!/renderMapCard|renderMapPane\(pane, s\);\n\}\n/.test(app05.slice(app05.indexOf("function renderSearchPane"), app05.indexOf("function renderMapPane"))), "联网搜索页底下不再挂一份");
    ok(/id="i-map"/.test(read("public/index.html")), "左栏「地图」用的图标 sprite 里有");
    const admin = require(mod("admin"));
    ok(admin.PLATFORM_WRITE.includes("/api/geo/test"), "「测一下」归平台管理员（花的是整台服务器那把 Key 的额度）");
    eq(admin.redactSecrets({ map: { provider: "amap", amap_key: KEY, amap_daily_cap: 9 } }), { map: { provider: "amap", amap_key: "", amap_daily_cap: 9 } }, "普通成员拉设置时 amap_key 被抹掉");
    eq(admin.redactSecrets({ map: { provider: "amap", amap_key: KEY, amap_search_cap: 4500, amap_route_cap: 140000 } }),
      { map: { provider: "amap", amap_key: "", amap_search_cap: 4500, amap_route_cap: 140000 } }, "  新的两项上限照常带回去，只抹 Key");
    ok(!app05.includes("每天免费") && app05.includes("每月最多搜几次地点") && app05.includes("每月最多查几次路线"), "设置页按月说上限，搜索、路线分开填（不再写「每天免费」）");
    ok(app05.includes("以高德控制台显示的为准") && app05.includes('id="map-usage"'), "  额度以高德控制台为准；这个月用了几次也摆出来");
    ok(/return v === "" \? def :/.test(app05), "  框清空了按默认算，不当成 0（0 是不用高德）");
    ok(app01.includes('".tc[data-tc], .tc-bad"'), "复制回答时没画成的那块贴原文");
    const tcSrc = read("public/tripcard.js");
    ok(/class="tc-ai"[^>]*>AI 排的</.test(tcSrc), "卡头标「AI 排的」");
    ok(tcSrc.includes('class="tc-retry"') && tcSrc.includes("st.loading[d] = null"), "没查成的有「再查一次」，查完放手，下回能再查");
    ok(tcSrc.includes('post("/api/geo/photos"'), "照片单独后补，不挡钉子");
    ok(tcSrc.includes("!el.isConnected || !st.visible"), "提前查只查还在页面上、在视野里的卡");
    ok(/root\.insertAtCursor\(input, redoText/.test(tcSrc) && !/tc-redo[\s\S]{0,400}(send|submit)\(/.test(tcSrc.slice(tcSrc.indexOf("让 AI 重写这段：只把话填进输入框"))),
      "「让 AI 重写这段」只填进输入框，不自动发");
    const css = read("public/css/tripcard.css");
    const tabsRule = (css.match(/^\.tc-tabs \{[^}]*\}/m) || [""])[0];
    ok(tabsRule.includes("overflow-x: auto") && !tabsRule.includes("scrollbar-width: none") && !/\.tc-tabs::-webkit-scrollbar \{ display: none/.test(css),
      "天数标签放不下时露出滚动条（不再藏起来）");
    const newRules = css.split("\n").filter((l) => /^(\.tc-w |\.tc-bad |\.tc-panel |\.a-text )?\.(tc-alert|tc-bad|tc-badh|tc-raw|tc-redo|tc-ai|tc-src|tc-retry|tc-more|tc-smore|tc-tlmsg)\b/.test(l));
    ok(newRules.length >= 10 && newRules.every((l) => !/#[0-9a-f]{3,8}\b|rgba?\(/i.test(l)), "新加的样式只用现成的颜色变量", newRules.filter((l) => /#[0-9a-f]{3,8}\b|rgba?\(/i.test(l)));
    // 地图上的小卡、导航菜单、二维码
    const popRules = css.split("\n").filter((l) => /^(\.tc-w |\.tc-pop |\.tc-leg |\.tc-ptop )?\.(tc-pop|tc-px|tc-ptop|tc-prow|tc-pk|tc-pv|tc-by|tc-pact|tc-go|tc-pnav|tc-pgo|tc-pleg|tc-navb|tc-navm|tc-acts|tc-qrbox|tc-qrms|tc-qrm|tc-qrt|tc-qract|tc-qrx|tc-qrerr|tc-tlr\.go)\b/.test(l));
    ok(popRules.length >= 20 && popRules.every((l) => !/#[0-9a-f]{3,8}\b|rgba?\(/i.test(l)), "小卡、导航菜单、二维码的样式只用现成的颜色变量", popRules.filter((l) => /#[0-9a-f]{3,8}\b|rgba?\(/i.test(l)));
    ok(/^\.tc-qrimg \{[^}]*background: #fff;/m.test(css), "  二维码图本身白底（深色模式也是，不然有的手机扫不出来）");
    ok(/function draw\(\)[\s\S]*?placePop\(W, H, z, ox, oy\);\n {4}\}/.test(tcSrc), "小卡的位置在 draw() 里跟着地图一起摆（拖、缩放时不掉队）");
    ok(/const ptrs = new Map\(\);/.test(tcSrc) && tcSrc.includes("ptrs.set(e.pointerId,") && tcSrc.includes("ptrs.get(e.pointerId)") && tcSrc.includes("ptrs.delete(e.pointerId)"),
      "地图手势按 pointerId 记每根手指（两指捏合、不乱跳）");
    ok(/if \(rs\) \{ if \(e\.pointerId === rs\.id\) rsMove\(e\); return; \}/.test(tcSrc), "拖分隔条也只认按下去的那根手指");
    ok(/e\.key === "Escape" && !e\.isComposing\) \{\n\s+if \(escClose\(e\.target\)\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); \}/.test(tcSrc),
      "Esc 收起小卡 / 菜单 / 二维码时不往上传（全局 Esc 是叫停任务）；输入法选字时的 Esc 不算");
    ok(tcSrc.includes('document.removeEventListener("click", onDocClick)') && tcSrc.includes('window.removeEventListener("pointerdown", onDownAny, true)'), "挂在 document / window 上的监听，dispose() 里都摘掉");
    const narrowCss = css.slice(css.indexOf("@container tcw (max-width: 620px)"), css.indexOf("\n}\n", css.indexOf("@container tcw (max-width: 620px)")));
    ok(/\.tc-map \{ height: min\(var\(--tc-h, 300px\), 55vh\); \}/.test(narrowCss) && /\.tc-panel \{[^}]*overscroll-behavior: auto;/.test(narrowCss),
      "手机上：地图最高占屏幕 55%（总留一截能滑页面），列表滚到头带动页面");
    ok(/^\.tc-map \{[^}]*touch-action: none;/m.test(css) && /^\.tc-pop \{[^}]*touch-action: pan-y;/m.test(css), "  地图上单指拖地图、两指捏合；小卡上竖着滑是滚动");
    ok(!/fetch\(|post\(/.test(tcSrc.slice(tcSrc.indexOf("// ---- 地图上的小卡"), tcSrc.indexOf("// ---- 交互 ----")).replace(/fetch\(img\.src\)/g, "")),
      "小卡、导航菜单、二维码一个地点 / 路线请求都不发（二维码图只问本机）");
    ok(require(mod("config-lint")).KNOWN_EXTRA[""].includes("map"), "配置体检认得 map 这一节");
    const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
    ok(/app\.use\(createGeoRouter\(\{ getConfig: \(\) => config \}\)\)/.test(server), "server.js 挂上了 /api/geo/*");
    ok(/b\.map\.provider[\s\S]{0,200}\["auto", "amap", "osm"\]/.test(server), "保存设置时 provider 只认 auto / amap / osm");
    ok(/\["amap_search_cap", "每月高德搜索的上限"\], \["amap_route_cap", "每月高德路线的上限"\]/.test(server), "保存设置时两项上限分别检查（0 或正整数）");
    ok(/geoPlaces\.resetStop\(\)/.test(server), "  存一次地图设置就解开今天的熔断（换了 Key 能马上用）");
  }

  srv.close();
  console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
