"use strict";
/**
 * 任务历史检索：搜得到，而且说得清是怎么搜到的。
 *
 * 侧栏那个放大镜当时只筛标题，
 * 而标题是任务跑完自动起的，用户从没读过一眼。他记得的是两样别的东西：
 *   自己当时打的那句话 —— 「把这个 csv 里重复的行挑出来」
 *   最后拿到的那个文件 —— 「清洗结果.xlsx」
 * 按标题筛，这两种记法一条都找不着。于是只能一条条点开看，点到第五条就放弃了。
 *
 * 这一套要挡的是四类静默失败，每一类在健康机器上都不报错：
 *   1. 搜不到 —— 正文和文件名根本没进搜索范围，用户以为「这个功能没做」
 *   2. 搜出来看不懂 —— 语义命中的那几条标题跟输入的词一个字都不沾，用户以为搜索坏了
 *   3. 悄悄降级 —— 没配嵌入渠道，「意思相近」这一路没走，界面一声不吭
 *   4. 变成后门 —— 侧栏看不见的会话（别人的）被搜出来了
 *
 * 所以断言几乎都成对：一条「找得到」，紧跟一条反向对照「不该找到的没找到」。
 * 只有「找得到」的话，一个把所有会话都返回的实现也能全绿。
 *
 * 跑法：node test/session-search.js
 */

const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const srcLib = require("./lib/src"); // server / tools / canvas 三组源码的唯一读法，见 test/lib/src.js
const S = require(path.join(ROOT, "session-search"));

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? "  ← " + JSON.stringify(extra) : ""}`); }
}
function eq(got, want, name) { ok(Object.is(got, want), name, Object.is(got, want) ? undefined : { got, want }); }

/** 造一条会话。turns 是 [人说的, 助手说的] 的数组 */
function sess(title, turns, files) {
  const t = [];
  for (const [u, a] of turns) {
    t.push({ type: "user", text: u, at: 1 });
    const evs = [{ type: "text", delta: a }];
    if (files) evs.push({ type: "files", changed: true, files: files.map((n) => ({ name: n })) });
    t.push({ type: "assistant", events: evs, at: 2 });
  }
  return { title, transcript: t };
}

const 周报 = sess("本周工作小结", [["帮我把这周的进展写成周报，发给主管", "好的，周报已经生成，共三段。"]], ["周报-0918.docx"]);
const 清洗 = sess("表格清洗", [["这个 csv 里有很多重复的行，帮我挑出来去掉", "已去重，共删除 128 行。"]], ["清洗结果.xlsx"]);
const 调研 = sess("竞品调研", [["调研一下同类产品的定价策略", "整理了五家的定价区间。"]], ["定价对比.md"]);

const ROWS = [周报, 清洗, 调研].map((s, i) => ({
  id: "s" + i, title: s.title, at: 100 - i, digest: S.digestOf(s), files: S.filesOf(s),
}));
const one = (q, o) => S.rank(ROWS, q, o);
const titles = (hs) => hs.map((h) => h.row.title);

// ─────────────────────────────────────────────────────────────
console.log("\n① 摘要：人说的话在前，一句不删；助手的话只取个头");
{
  const d = S.digestOf(周报);
  ok(d.includes("帮我把这周的进展写成周报"), "★用户自己打的那句话原样收进摘要★ 这是他唯一可能记得住的东西");
  ok(d.indexOf("周报-0918.docx") < d.indexOf("帮我把这周"), "产出文件名排在最前面：文件名比正文还好记");
  ok(d.indexOf("帮我把这周") < d.indexOf("好的，周报已经生成"), "人说的排在助手说的前面");

  // 助手那种长篇大论不许把人自己的话挤出去
  const 长 = sess("长回复", [["就一句话", "废".repeat(5000)]]);
  const dl = S.digestOf(长);
  ok(dl.includes("就一句话"), "★助手回了五千字，人那一句照样在摘要里★ 挤掉了就等于这条会话搜不着了");
  ok(dl.length < 1000, "助手那段被截在 160 字，没把摘要撑爆", dl.length);
  ok(S.digestOf(周报, 20).length <= 20, "上限说多少就是多少");
  eq(S.digestOf(null), "", "（反向对照）喂 null 不炸，给空串");
  eq(S.digestOf({ transcript: "不是数组" }), "", "（反向对照）形状不对也不炸");
}

console.log("\n② 助手回复的两种形状都认得");
{
  eq(S.assistantText({ type: "assistant", events: [{ type: "text", delta: "甲" }, { type: "text", delta: "乙" }] }), "甲乙", "事件流拼起来");
  eq(S.assistantText({ type: "assistant", text: "老形状" }), "老形状", "老会话那种 {text} 也认——不认的话老对话全都搜不到");
  eq(S.assistantText({ type: "assistant", events: [{ type: "tool_use", name: "bash" }] }), "", "（反向对照）工具调用不是正文，不收");
  eq(S.assistantText(null), "", "（反向对照）null 不炸");
}

console.log("\n③ 产出文件名：搜得到，而且去重");
{
  const dup = sess("重复产出", [["做一次", "好"], ["再做一次", "好"]], ["同一个.xlsx"]);
  eq(S.filesOf(dup).length, 1, "同一个文件出现两轮，只算一个");
  eq(S.filesOf(周报)[0], "周报-0918.docx", "文件名取得出来");
  eq(S.filesOf({}).length, 0, "（反向对照）没产出就是空数组，不是 undefined");
}

console.log("\n④ 三种命中各自找得到，而且标清楚是哪一种");
{
  const h1 = one("小结");
  eq(h1.length, 1, "标题命中：只出一条");
  eq(h1[0].why, S.WHY.title, "标成「标题」");

  const h2 = one("重复的行");
  eq(titles(h2).join(","), "表格清洗", "★正文命中：用户当时说的那句话找得回来★ 标题「表格清洗」里一个字都不沾");
  eq(h2[0].why, S.WHY.body, "标成「对话里」");
  ok(h2[0].snippet && h2[0].snippet.text.includes("重复的行"), "片段里带着命中的那几个字", h2[0].snippet);

  const h3 = one("xlsx");
  eq(titles(h3).join(","), "表格清洗", "★文件名命中：只记得后缀也找得着★");
  eq(h3[0].why, S.WHY.file, "标成「产出文件」");

  ok(one("今天天气怎么样").length === 0, "★（反向对照）不相干的词一条都不给★ 硬凑出来的每一条都是让人多点一次");
  ok(one("").length === 0, "（反向对照）空词不返回全部——那等于没筛");
}

console.log("\n⑤ 字面命中压得住语义命中");
{
  // 给「竞品调研」一个跟查询很像的向量，但查询的字面写在「表格清洗」里
  const rows = ROWS.map((r) => ({ ...r, vec: r.title === "竞品调研" ? [1, 0, 0] : [0, 1, 0] }));
  const hs = S.rank(rows, "重复的行", { qVec: [1, 0, 0] });
  eq(hs[0].row.title, "表格清洗", "★真写着这个词的那条排第一★ 排第二的话，人会觉得搜索在跟他较劲");
  ok(hs.length === 2 && hs[1].row.title === "竞品调研", "语义那条垫底但没丢——「一个字没对上但确实是那件事」靠它捞", titles(hs));
  eq(hs[1].why, S.WHY.vec, "语义命中标成「意思相近」：不标的话它看起来就是凭空冒出来的");

  const noVec = S.rank(ROWS, "重复的行", {});
  eq(noVec.length, 1, "（反向对照）没有向量就只剩字面那条，不会凭空多出来一条");
}

console.log("\n⑥ 分数一样时，新的排前面");
{
  const a = { id: "a", title: "周报", digest: "", files: [], at: 1 };
  const b = { id: "b", title: "周报", digest: "", files: [], at: 999 };
  eq(S.rank([a, b], "周报")[0].id, "b", "同样贴题的两条，给刚干过的那条——人要的几乎总是它");
}

console.log("\n⑦ 命中片段：给的是下标不是 HTML，而且不跨行");
{
  const sn = S.snippet("第一行说的是甲\n第二行说的是乙", "乙");
  ok(!sn.text.includes("第一行"), "★片段不跨行★ 跨过去就把两轮不相干的话粘成一句，读的人会以为当时真这么说的");
  eq(sn.text.slice(sn.at, sn.at + sn.len), "乙", "下标对得上原文——UI 照这个下标去套高亮");
  ok(sn.len === 1 && sn.at >= 0, "长度和位置都给了", sn);

  const sn2 = S.snippet("这里没有那个词", "找不着");
  eq(sn2.at, -1, "找不到字面命中时 at = -1");
  eq(sn2.head, true, "并且标成 head：UI 得知道这截是开头不是命中");
  ok(sn2.text.length > 0, "还是给一截开头——总比一行标题孤零零摆着强");

  ok(S.snippet("", "甲") === null, "（反向对照）空正文给 null，不给一个假片段");

  const 长行 = S.snippet("前".repeat(200) + "钥匙" + "后".repeat(200), "钥匙");
  ok(长行.text.length < 120, "长行两头都截掉，不把两百字灌进侧栏", 长行.text.length);
  ok(长行.text.startsWith("…") && 长行.text.endsWith("…"), "截了就标省略号");
  eq(长行.text.slice(长行.at, 长行.at + 长行.len), "钥匙", "★截过之后下标还对得上★ 对不上的话高亮会套在旁边的字上");
}

console.log("\n⑧ 词面接近：打错一个字还捞得回来");
{
  const qg = S.bigrams("重复的行");
  ok(S.keywordScore(qg, "把重复的行去掉") > S.keywordScore(qg, "今天天气不错"), "沾边的比不沾边的分高");
  eq(S.keywordScore(new Set(), "随便什么"), 0, "（反向对照）空查询给 0，不给一个假分数");
  eq(S.keywordScore(qg, ""), 0, "（反向对照）空正文给 0");
  // 长会话不该只因为长就被压下去
  const 短 = S.keywordScore(qg, "重复的行");
  const 长 = S.keywordScore(qg, "重复的行" + "别的话".repeat(50));
  ok(短 > 长 && 长 > 0, "长的分低但没归零：归一化在起作用，长会话不吃亏到搜不出来", { 短, 长 });
}

console.log("\n⑨ 余弦：形状不对就当没有，不炸");
{
  ok(Math.abs(S.cosine([1, 0], [1, 0]) - 1) < 1e-9, "同向 = 1");
  ok(Math.abs(S.cosine([1, 0], [0, 1])) < 1e-9, "正交 = 0");
  eq(S.cosine([1, 0], [1, 0, 0]), 0, "（反向对照）长度不一样给 0，不给一个瞎算的数");
  eq(S.cosine(null, [1]), 0, "（反向对照）null 给 0");
  eq(S.cosine([0, 0], [0, 0]), 0, "（反向对照）零向量给 0，不给 NaN——NaN 一进排序，整张表的顺序就废了");
}

console.log("\n⑩ 搜完跟人交代一句实话");
{
  const 走了 = S.searchNote({ total: 12, semantic: true });
  ok(/12 条/.test(走了) && /意思相近/.test(走了), "走了语义就说走了");
  const 没走 = S.searchNote({ total: 12, semantic: false });
  ok(/没走/.test(没走), "★没走就明说没走★ 悄悄降级的话，用户搜不到只会觉得「这个搜索不准」");
  ok(/没有可用的嵌入渠道/.test(没走), "并且说清楚为什么没走——他才知道该去配一条渠道");
  ok(/算不出来/.test(S.searchNote({ total: 1, semantic: false, why: "算不出来" })), "调用方能换一句更具体的原因");
  ok(!/意思相近的都算/.test(没走), "（反向对照）没走的时候不许把「意思相近」也吹进去");
}

console.log("\n⑪ 拿去算向量的那一小段");
{
  const t = S.embedTextOf({ title: "本周工作小结", digest: S.digestOf(周报) });
  ok(t.startsWith("本周工作小结"), "标题打头");
  ok(t.length <= S.MAX_EMBED, "截在上限内——每条向量都是一次真花钱的调用", t.length);
  eq(S.embedTextOf({}), "", "（反向对照）什么都没有就给空串");
}

// ─────────────────────────────────────────────────────────────
// 下面几节验的是「这一层真的被接上了」。纯函数写得再对，没人调也等于没做。
console.log("\n⑫ 服务端：接口在、走归属过滤、摘要变了就作废旧向量");
{
  const src = srcLib.src("server");
  ok(/app\.get\("\/api\/sessions\/search"/.test(src), "★检索接口真的挂上去了★");
  const body = src.slice(src.indexOf('app.get("/api/sessions/search"'), src.indexOf('app.get("/api/sessions/search"') + 1800);
  ok(/ownSession\(req\.user/.test(body), "★搜索也过归属过滤★ 不过的话，搜索就成了绕过归属的后门");
  ok(/ensureSessVectors\(\)\.then/.test(body) && !/await ensureSessVectors/.test(body),
    "★补算向量不 await★ await 的话第一次搜索要干等一轮网络请求，而字面那一路本来立刻就能出结果");
  ok(/searchNote/.test(body), "结果里带上那句实话");
  ok(/hit\.digest !== digest/.test(src) && /vec: changed \? null/.test(src),
    "★正文变了就把旧向量作废★ 留着的话，搜出来的「意思相近」说的是这条会话上一版的意思");
  // 启动时就接线，而声明得在接线之前——这条曾经让整个服务起不来（TDZ）
  const declAt = src.indexOf("let sessEmbedder = null;");
  const useAt = src.indexOf("setSessEmbedder(createEmbedder(config));");
  ok(declAt > 0 && useAt > 0 && declAt < useAt, "★向量渠道那两个变量声明在第一次接线之前★ 反过来是暂时性死区，服务直接起不来", { declAt, useAt });
}

console.log("\n⑬ 侧栏：打字立刻筛、慢一拍去问服务端、失败退回本地");
{
  const src = fs.readFileSync(path.join(ROOT, "public", "js", "app-02.js"), "utf8");
  ok(/\/api\/sessions\/search/.test(src), "★侧栏真的去问了服务端★");
  ok(/setTimeout\(async \(\) => \{[\s\S]{0,400}?sessions\/search/.test(src), "去问之前防抖，不是每敲一个键就发一次");
  ok(/renderHistory\(\); histSearchSoon\(\)/.test(src), "★本地筛标题先出，不等网络★ 等网络的话，打字时列表是空的，空列表看起来跟「没搜到」一模一样");
  ok(/seq !== histSeq/.test(src), "★回来的结果对序号★ 打字快的时候后发的先到，不对的话列表会跳回上一个词的结果");
  ok(/histHits = null;\s*\/\/ 兜回本地/.test(src), "★搜挂了退回本地筛标题★ 而不是摆一张空列表");
  ok(/histErr/.test(src) && /正文检索没连上/.test(src), "★挂了就说挂了★ 拿「没搜到」糊过去的话，那是两件事说成一件");
  ok(/hwhy/.test(src) && /hsnip/.test(src), "每条命中都带「为什么是它」和命中片段");
  ok(/<mark>/.test(src), "命中那几个字高亮出来");
}

console.log("\n⑭ 命令行的 /resume 也搜正文");
{
  const R = require(path.join(ROOT, "repl-commands"));
  const rows = R.sessionRows([
    { id: "cli_1", title: "表格清洗", turns: 2, from: "命令行", mtime: 2, body: "这个 csv 里有很多重复的行" },
    { id: "cli_2", title: "竞品调研", turns: 1, from: "命令行", mtime: 1, body: "调研一下同类产品的定价" },
  ], { now: 3 });
  eq(rows[0].body, "这个 csv 里有很多重复的行", "正文传得进来");

  const r1 = R.pickSessionRow(rows, "重复的行");
  eq(r1.kind + ":" + (r1.row && r1.row.id), "ok:cli_1", "★/resume 重复的行 —— 标题里没有的词，正文里有也接得上★");
  eq(R.pickSessionRow(rows, "竞品").row.id, "cli_2", "标题照样优先");
  eq(R.pickSessionRow(rows, "八竿子打不着").kind, "none", "（反向对照）不相干的词还是认不出来，不瞎接一条");

  const picker = R.sessionPickerRows(rows);
  ok(picker[0].deep.includes("重复的行"), "选择器行带上了「搜得着但不显示」的那一份");
  const v = R.pickerView(picker, { q: "重复的行", title: "接哪条" });
  eq(v.hits.length, 1, "选择器里打「重复的行」筛得出来");
  ok(/对话里/.test(v.lines[0].text), "★只靠正文对上的行标一句「对话里」★ 不标的话，屏幕上冒出一个看着不相干的标题，人只会以为搜坏了");
  const v2 = R.pickerView(picker, { q: "表格", title: "接哪条" });
  ok(!/对话里/.test(v2.lines[0].text), "（反向对照）标题就对上的行不标——标了等于每行都在解释，解释就没了意义");
  eq(R.pickerView(picker, { q: "八竿子", title: "x" }).hits.length, 0, "（反向对照）不相干的词筛出零条");
}

console.log("\n⑮ 这一层是纯的：不碰 fs、不碰网络、不打印");
{
  const src = fs.readFileSync(path.join(ROOT, "session-search.js"), "utf8");
  for (const [re, why] of [
    [/\brequire\(/, "require"],
    [/\bconsole\./, "console"],
    [/\bprocess\./, "process"],
    [/\bfetch\(/, "fetch"],
    [/\bDate\.now\(/, "Date.now"],
  ]) ok(!re.test(src), `不出现 ${why}——喂什么算什么，所以测得动`);
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
process.exit(fail === 0 ? 0 : 1);
