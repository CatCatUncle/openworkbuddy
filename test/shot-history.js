"use strict";
/**
 * 分镜节点版本快照 + 一键恢复。
 *
 * 这套测试真正要钉住的是一句话：**改台词重跑之后，上一版的首帧还拿得回来**。
 * 它跟「记了个路径」的区别只有在文件被同名盖掉之后才看得出来——所以每个恢复用例
 * 都先把文件原地盖掉，再去对字节，光比路径一律不算数。
 *
 * 另外三条是这类功能最容易出的事故，各压了正反对照：
 *   · 恢复变成「合并」——上一版的视频配这一版的首帧，界面上跟成功长得一模一样
 *   · 留底过期了还照样把老路径写回分镜表，盘上躺的是新字节，下次重跑才发现分了家
 *   · 账本是工作目录里一个纯文本，模型写得到；被塞了 ../../ 也不许往工作目录外面写
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const sh = require("../shot-history");

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra != null ? "\n      " + String(extra).replace(/\n/g, "\n      ") : "")); }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "owb-shot-"));
const BOARD = "短剧/分镜表.json";
const abs = (rel) => path.join(root, rel);
const write = (rel, text) => { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), text); };
const read = (rel) => (fs.existsSync(abs(rel)) ? fs.readFileSync(abs(rel), "utf8") : null);
const board = () => JSON.parse(read(BOARD));
const saveBoard = (data) => write(BOARD, JSON.stringify(data, null, 2) + "\n");
const shotOf = (data, id) => data.scenes.flatMap((s) => s.shots).find((x) => x.id === id);

function freshBoard() {
  fs.rmSync(path.join(root, ".openworkbuddy"), { recursive: true, force: true });
  saveBoard({
    title: "试拍", aspect: "9:16",
    characters: [{ id: "C1", name: "阿岚", look: "短发", ref: "素材/阿岚_定妆.png" }],
    scenes: [{
      id: "S1", place: "天台", time: "黄昏",
      shots: [
        { id: "S1-01", shot_size: "中景", frame_prompt: "她站在天台", motion_prompt: "轻微推进", line: "你来了", first_frame: "素材/S1-01_首帧.png" },
        { id: "S1-02", shot_size: "特写", frame_prompt: "手", motion_prompt: "不动", line: "嗯", first_frame: "素材/S1-02_首帧.png" },
      ],
    }],
  });
  write("素材/S1-01_首帧.png", "第一版首帧的字节");
  write("素材/S1-02_首帧.png", "另一镜的首帧，一个字节都不许动");
  write("素材/阿岚_定妆.png", "第一版定妆照");
}

// ---- ① 主线：改台词重跑之后，上一版首帧还拿得回来 ----
console.log("\n【1】改台词重跑，上一版首帧拿得回来");
{
  freshBoard();
  const v1 = sh.snapshot(root, { board: BOARD, id: "S1-01", data: board(), why: "重跑首帧之前" });
  ok(!!v1 && /^sv_/.test(v1.id), "改之前拍了一版", v1 && v1.id);
  ok(v1.blobs.first_frame && /^[0-9a-f]{64}$/.test(v1.blobs.first_frame.hash), "首帧的字节也留了，不是光记个路径", JSON.stringify(v1.blobs));

  // 重跑：台词改了，首帧被**同名**盖掉——这一步是整套测试的前提
  const d = board(); shotOf(d, "S1-01").line = "我等你很久了"; saveBoard(d);
  write("素材/S1-01_首帧.png", "第二版首帧，把第一版盖掉了");
  ok(read("素材/S1-01_首帧.png") === "第二版首帧，把第一版盖掉了", "盘上确实只剩第二版了");

  const r = sh.restore(root, { board: BOARD, id: "S1-01", version: v1.id });
  ok(r.ok, "一键恢复", r.error);
  ok(read("素材/S1-01_首帧.png") === "第一版首帧的字节", "★核心★ 首帧的字节真换回了第一版（比路径不算数）", read("素材/S1-01_首帧.png"));
  ok(shotOf(board(), "S1-01").line === "你来了", "台词也回到了那一版");
  ok(r.files.find((f) => f.field === "first_frame").action === "restored", "回执里写明首帧是「写回去了」", JSON.stringify(r.files));
  ok(!r.partial, "这一版是完整回来的，不是半截");

  // ★反向对照★ 别的镜头一个字节都不许动
  ok(read("素材/S1-02_首帧.png") === "另一镜的首帧，一个字节都不许动", "★对照★ 只动这一镜，隔壁那镜的文件没被碰");
  ok(shotOf(board(), "S1-02").line === "嗯", "★对照★ 隔壁那镜的字段也没被碰");
}

// ---- ② 退错了还能再退回来 ----
console.log("\n【2】恢复本身也留底，退错了能撤销");
{
  freshBoard();
  const v1 = sh.snapshot(root, { board: BOARD, id: "S1-01", data: board() });
  const d = board(); shotOf(d, "S1-01").line = "第二版台词"; saveBoard(d);
  write("素材/S1-01_首帧.png", "第二版首帧");

  const back = sh.restore(root, { board: BOARD, id: "S1-01", version: v1.id });
  ok(back.ok && back.undo, "恢复的回执里带着「撤销」那一版的 id", JSON.stringify({ ok: back.ok, undo: back.undo }));
  const again = sh.restore(root, { board: BOARD, id: "S1-01", version: back.undo });
  ok(again.ok, "拿它再恢复一次", again.error);
  ok(shotOf(board(), "S1-01").line === "第二版台词", "撤销之后回到第二版的台词");
  ok(read("素材/S1-01_首帧.png") === "第二版首帧", "★核心★ 第二版的首帧字节也回来了——两个方向都退得动", read("素材/S1-01_首帧.png"));
}

// ---- ③ 一模一样不占新版：连点十次保存不该攒出十版 ----
console.log("\n【3】没变就不占版本");
{
  freshBoard();
  const a = sh.snapshot(root, { board: BOARD, id: "S1-01", data: board() });
  const b = sh.snapshot(root, { board: BOARD, id: "S1-01", data: board() });
  ok(!!a && b === null, "字段和字节都没变，第二次不占一版", JSON.stringify({ a: !!a, b }));
  // ★反向对照★ 只是文件内容变了（路径一个字没改）也得算新的一版，不然这一版就白留了
  write("素材/S1-01_首帧.png", "重跑了一张，路径没变");
  const c = sh.snapshot(root, { board: BOARD, id: "S1-01", data: board() });
  ok(!!c, "★对照★ 路径没变但字节变了，照样算新的一版");
  const d = board(); shotOf(d, "S1-01").line = "换句话"; saveBoard(d);
  ok(!!sh.snapshot(root, { board: BOARD, id: "S1-01", data: board() }), "★对照★ 只改台词也算新的一版");
  ok(sh.list(root, { board: BOARD, id: "S1-01" }).length === 3, "一共三版", JSON.stringify(sh.list(root, { board: BOARD, id: "S1-01" }).map((x) => x.id)));
  // ★对照★ 只是把 key 重排一遍：内容一个字没变，不许凭空多占一版
  const d2 = board(); const s2 = shotOf(d2, "S1-01");
  const flip = {}; for (const k of Object.keys(s2).reverse()) flip[k] = s2[k];
  d2.scenes[0].shots[0] = flip; saveBoard(d2);
  ok(sh.snapshot(root, { board: BOARD, id: "S1-01", data: board() }) === null, "★对照★ 字段顺序变了不算变");
}

// ---- ④ 整镜回退，不是合并 ----
console.log("\n【4】整镜回退：那一版没有的字段，回去之后也得没有");
{
  freshBoard();
  const v1 = sh.snapshot(root, { board: BOARD, id: "S1-01", data: board() });
  // 之后这一镜生出了视频、量了时长
  const d = board(); const s = shotOf(d, "S1-01");
  s.video = "素材/S1-01.mp4"; s.duration = 3.5; s.note = "重拍过两次"; saveBoard(d);
  write("素材/S1-01.mp4", "第二版的视频");

  const r = sh.restore(root, { board: BOARD, id: "S1-01", version: v1.id });
  const now = shotOf(board(), "S1-01");
  ok(r.ok && !("video" in now), "★核心★ 那一版没有 video，回去之后分镜表里也不许留着它", JSON.stringify(now));
  ok(!("duration" in now) && !("note" in now), "同理，后来加的时长和备注也一并回退", JSON.stringify(now));
  ok(now.shot_size === "中景" && now.line === "你来了", "该在的字段还在");
  ok(fs.existsSync(abs("素材/S1-01.mp4")), "盘上那个 mp4 不删——只是分镜表不再引用它，删文件不是回退该干的事");
}

// ---- ⑤ 留底过期：宁可说回不来，也不许老路径配新字节 ----
console.log("\n【5】留底没了：如实说回不来，绝不悄悄成功");
{
  freshBoard();
  const v1 = sh.snapshot(root, { board: BOARD, id: "S1-01", data: board() });
  const hash = v1.blobs.first_frame.hash;
  const d = board(); shotOf(d, "S1-01").first_frame = "素材/S1-01_重拍.png"; saveBoard(d);
  write("素材/S1-01_重拍.png", "重拍的那张");
  fs.rmSync(path.join(root, ".openworkbuddy", "shot-history", "objects", hash), { force: true }); // 当它被保留期清掉了

  const rows = sh.list(root, { board: BOARD, id: "S1-01" });
  ok(rows[0].files.first_frame.kept === false, "列版本时就标出这一版的首帧回不来了", JSON.stringify(rows[0].files));
  ok(!rows[0].restorable, "整版标成「回不全」，界面据此把按钮说清楚");

  const r = sh.restore(root, { board: BOARD, id: "S1-01", version: v1.id });
  ok(r.ok && r.partial, "还是让恢复，但明写这是半截的", JSON.stringify({ ok: r.ok, partial: r.partial }));
  ok(r.files.find((f) => f.field === "first_frame").action === "missing", "回执里那一项写的是 missing", JSON.stringify(r.files));
  ok(shotOf(board(), "S1-01").first_frame === "素材/S1-01_重拍.png",
     "★核心★ 首帧字段保持现在这张，不许写回老路径——老路径上躺的已经是别的字节了", shotOf(board(), "S1-01").first_frame);
  ok(shotOf(board(), "S1-01").line === "你来了", "回得来的字段照样回");
}

// ---- ⑥ 账本里的路径一律不信 ----
console.log("\n【6】账本是纯文本，模型写得到：路径一律不信");
{
  freshBoard();
  const v1 = sh.snapshot(root, { board: BOARD, id: "S1-01", data: board() });
  const lp = sh._internals.ledgerPath(root, BOARD);
  const outside = path.join(root, "..", "被写出去了.png");
  fs.rmSync(outside, { force: true });
  const rows = fs.readFileSync(lp, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  rows[0].blobs.first_frame.rel = "../被写出去了.png";      // 手改账本：把落点指到工作目录外面
  fs.writeFileSync(lp, rows.map((e) => JSON.stringify(e)).join("\n") + "\n");

  const r = sh.restore(root, { board: BOARD, id: "S1-01", version: v1.id });
  ok(!fs.existsSync(outside), "★核心★ 一个字节都没往工作目录外面写", outside);
  ok(r.files.find((f) => f.field === "first_frame").action === "missing", "而且如实报成回不来，不是假装写成功了", JSON.stringify(r.files));
  // 账本里的留底编号同理：它是唯一进到留底目录路径里的那一截
  freshBoard();
  const vh = sh.snapshot(root, { board: BOARD, id: "S1-01", data: board() });
  const lp2 = sh._internals.ledgerPath(root, BOARD);
  const rows2 = fs.readFileSync(lp2, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  rows2[0].blobs.first_frame.hash = "../../../../etc/passwd";
  fs.writeFileSync(lp2, rows2.map((e) => JSON.stringify(e)).join("\n") + "\n");
  write("素材/S1-01_首帧.png", "盖掉了");
  const rh = sh.restore(root, { board: BOARD, id: "S1-01", version: vh.id });
  ok(rh.ok && rh.partial && read("素材/S1-01_首帧.png") === "盖掉了",
     "★核心★ 留底编号被手改成一个路径：当它没留下，绝不顺着它去读别人的文件", JSON.stringify(rh.files));
  ok(sh._internals.objPath(root, "../../etc/passwd") === "" && /^\/|^[A-Za-z]:/.test(sh._internals.objPath(root, "0".repeat(64))),
     "编号必须是 64 位十六进制，别的一律不给路径");

  // ★反向对照★ 正常路径必须写得进去，别为了安全把功能锁死
  freshBoard();
  const v2 = sh.snapshot(root, { board: BOARD, id: "S1-01", data: board() });
  write("素材/S1-01_首帧.png", "盖掉");
  ok(sh.restore(root, { board: BOARD, id: "S1-01", version: v2.id }).ok && read("素材/S1-01_首帧.png") === "第一版首帧的字节",
     "★对照★ 工作目录里的正常路径照写不误");
  // 素材字段指到工作目录外面：拍的时候就该记成留不下，而不是去读人家的文件
  const bad = sh._internals.probeFile(root, "../../etc/hosts");
  ok(bad.skip === "outside" && !bad.hash, "素材路径本身指到外面，拍快照时就拒读", JSON.stringify(bad));
}

// ---- ⑦ 查无此镜 / 重号 / 分镜表坏了 ----
console.log("\n【7】真源不对劲的时候，说人话");
{
  freshBoard();
  const v1 = sh.snapshot(root, { board: BOARD, id: "S1-01", data: board() });
  ok(sh.snapshot(root, { board: BOARD, id: "S9-99", data: board() }) === null, "没这一镜就不占版本");
  const gone = sh.restore(root, { board: BOARD, id: "S9-99", version: v1.id });
  ok(!gone.ok && /没有镜头 S9-99/.test(gone.error), "恢复一个不存在的镜头：说清是它不在了", gone.error);
  const nov = sh.restore(root, { board: BOARD, id: "S1-01", version: "sv_不存在" });
  ok(!nov.ok && /没有这一版/.test(nov.error), "版本号不对：说清是这一版不在了", nov.error);

  const d = board(); d.scenes[0].shots.push({ id: "S1-01", shot_size: "远景", frame_prompt: "撞号的", motion_prompt: "无" }); saveBoard(d);
  const dup = sh.restore(root, { board: BOARD, id: "S1-01", version: v1.id });
  ok(!dup.ok && /2 个镜头都叫 S1-01/.test(dup.error), "撞号不替人猜是哪一个", dup.error);
  ok(sh.snapshot(root, { board: BOARD, id: "S1-01", data: board() }) === null, "撞号时也不拍快照——拍了也不知道拍的是哪一个");

  write(BOARD, "{ 这不是 JSON");
  const broke = sh.restore(root, { board: BOARD, id: "S1-01", version: v1.id });
  ok(!broke.ok && /读不出来/.test(broke.error), "分镜表坏了就明说，不当成空表往上盖", broke.error);
  ok(read(BOARD) === "{ 这不是 JSON", "★核心★ 而且一个字都没写回去，坏文件原样留着");
}

// ---- ⑧ 角色的定妆照走同一套 ----
console.log("\n【8】角色定妆照同理");
{
  freshBoard();
  const v1 = sh.snapshot(root, { board: BOARD, kind: "character", id: "C1", data: board() });
  ok(!!v1 && v1.blobs.ref.hash, "定妆照的字节也留了", JSON.stringify(v1 && v1.blobs));
  write("素材/阿岚_定妆.png", "换了一版定妆照");
  const d = board(); d.characters[0].look = "长发"; saveBoard(d);
  const r = sh.restore(root, { board: BOARD, kind: "character", id: "C1", version: v1.id });
  ok(r.ok && read("素材/阿岚_定妆.png") === "第一版定妆照", "定妆照的字节换得回来", read("素材/阿岚_定妆.png"));
  ok(board().characters[0].look === "短发", "外形描述也回去了");
  // ★反向对照★ 镜头和角色各记各的，别互相顶
  ok(sh.list(root, { board: BOARD, kind: "shot", id: "C1" }).length === 0, "★对照★ 同名不同类互不串台");
}

// ---- ⑨ list 标出哪一版是「现在」 ----
console.log("\n【9】哪一版是现在这一版");
{
  freshBoard();
  const v1 = sh.snapshot(root, { board: BOARD, id: "S1-01", data: board() });
  const d = board(); shotOf(d, "S1-01").line = "换了"; saveBoard(d);
  const v2 = sh.snapshot(root, { board: BOARD, id: "S1-01", data: board() });
  const rows = sh.list(root, { board: BOARD, id: "S1-01", data: board() });
  ok(rows.length === 2 && rows[0].id === v2.id, "新的排在前面", rows.map((r) => r.id).join(","));
  ok(rows[0].same === true && rows[1].same === false, "跟盘上一模一样的那一版标成「现在」", JSON.stringify(rows.map((r) => r.same)));
  ok(sh.changed(v1.fields, v2.fields).join(",") === "line", "两版之间只有台词动了", sh.changed(v1.fields, v2.fields).join(","));
  // 列一下不该往留底目录里灌东西
  const before = sh.usage(root).objects;
  write("素材/S1-01_首帧.png", "列版本的时候盘上是这张");
  sh.list(root, { board: BOARD, id: "S1-01", data: board() });
  ok(sh.usage(root).objects === before, "★核心★ 光看版本列表不许顺手存一份，那是拍快照才干的事", `${before} → ${sh.usage(root).objects}`);
}

// ---- ⑩ 清理：最老那一版留死，没人引用的字节才删 ----
console.log("\n【10】清理");
{
  freshBoard();
  const ids = [];
  for (let i = 0; i < 6; i++) {
    write("素材/S1-01_首帧.png", "第 " + i + " 版");
    const e = sh.snapshot(root, { board: BOARD, id: "S1-01", data: board() });
    if (e) ids.push(e.id);
  }
  ok(ids.length === 6, "先攒了 6 版", ids.length);
  const used = sh.usage(root);
  ok(used.objects >= 6, "字节也各存了一份", JSON.stringify(used));

  const g = sh.gc(root, { keepPerShot: 2, keepDays: 0, now: Date.now() + 1000 });
  const left = sh.list(root, { board: BOARD, id: "S1-01" });
  ok(left.length === 3, "留最近 2 版 + 最老那一版，共 3 版", left.map((x) => x.id).join(","));
  ok(left[left.length - 1].id === ids[0], "★核心★ 最老那一版留死——「一开始什么样」恰恰是最想退回去的", left[left.length - 1].id);
  ok(g.objects === 3 && g.bytes > 0, "没人引用的 3 份字节被删掉并记了账", JSON.stringify(g));
  ok(sh.usage(root).objects === 3, "留底目录里就剩这 3 份", JSON.stringify(sh.usage(root)));
  ok(left.every((x) => x.restorable), "留下来的每一版都还真能恢复");

  // ★反向对照★ 两镜共用同一张图时，删另一镜的版本不许把这张图带走
  freshBoard();
  write("素材/共用.png", "两镜都指着它");
  const d = board();
  shotOf(d, "S1-01").first_frame = "素材/共用.png";
  shotOf(d, "S1-02").first_frame = "素材/共用.png";
  saveBoard(d);
  sh.snapshot(root, { board: BOARD, id: "S1-01", data: board() });
  sh.snapshot(root, { board: BOARD, id: "S1-02", data: board() });
  const shared = sh.usage(root).objects;
  ok(shared === 1, "同一份内容只存一次", shared);
  sh.gc(root, { keepPerShot: 99, keepDays: 99999 });
  ok(sh.usage(root).objects === 1 && sh.list(root, { board: BOARD, id: "S1-02" })[0].restorable,
     "★对照★ 清理之后两镜都还恢复得了");
}

// ---- ⑪ 留不下的三种，各说各的 ----
console.log("\n【11】留不下的时候，说清是哪一种留不下");
{
  const b = sh._internals.blobState;
  ok(/超过 96MB/.test(b(root, { rel: "a.mp4", skip: "toobig" }).why), "太大：说是太大", JSON.stringify(b(root, { rel: "a.mp4", skip: "toobig" })));
  ok(/文件就已经不在了/.test(b(root, { rel: "a.png", skip: "gone" }).why), "拍的时候文件就没了：说是那时候就没了");
  ok(/不在工作目录里/.test(b(root, { rel: "../a.png", skip: "outside" }).why), "路径在外面：说是在外面");
  ok(/超过保留期/.test(b(root, { rel: "a.png", hash: "0".repeat(64) }).why), "留底被清了：说是被清了");
  ok(b(root, { rel: "a.png", skip: "toobig" }).kept === false, "四种都得是 kept:false，界面才不会给个点不动的按钮");
  // 素材字段是空的就根本不记：空路径不是「留不下」，是「本来就没有」
  freshBoard();
  const d = board(); shotOf(d, "S1-01").first_frame = ""; saveBoard(d);
  const v = sh.snapshot(root, { board: BOARD, id: "S1-01", data: board() });
  ok(v && !v.blobs.first_frame, "空路径不记成一条留不下的账", JSON.stringify(v && v.blobs));
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
