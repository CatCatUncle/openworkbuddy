"use strict";
/**
 * 文件检查点：write_file / edit_file 落盘前留底，整步回退，改前 diff。
 *
 * 钉的是三件以前没有的事：
 *   1. 模型改坏一个文件，人能退回「这一步之前」，而且退错了还能退回来（回退本身也留底）
 *   2. 账本是 .history 里一个纯文本 jsonl，被人手改过、塞了 ../../ 这种路径，回退也不许写出工作目录
 *   3. diff 是给人在批准前看的：hunk 行号得对、太长要截、内容一样就一个字都不印
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const ck = require("../checkpoints");
const repl = require("../repl-commands");
const ap = require("../cli-approve");

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra != null ? "\n      " + String(extra).replace(/\n/g, "\n      ") : "")); }
}
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null);

// ---- ① diff：行号、上下文、截断、空 ----
{
  const d = ck.unifiedDiff("一\n二\n三\n四\n五\n", "一\n二\n叁\n四\n五\n", { name: "x.txt" });
  ok(d.startsWith("--- x.txt\n+++ x.txt\n"), "带文件名时有 ---/+++ 头", d);
  ok(/@@ -1,5 \+1,5 @@/.test(d), "hunk 行号按上下文 2 行算", d);
  ok(d.includes("\n-三\n+叁\n"), "改的那行一减一加", d);
  ok(ck.unifiedDiff("a\nb\n", "a\nb\n") === "", "内容一样 diff 为空串");
  ok(ck.unifiedDiff("", "x\ny\n").includes("@@ -0,0 +1,2 @@"), "新建文件的 hunk 是 -0,0", ck.unifiedDiff("", "x\ny\n"));
  ok(ck.unifiedDiff("x\ny\n", "").includes("@@ -1,2 +0,0 @@"), "整个删光的 hunk 是 +0,0", ck.unifiedDiff("x\ny\n", ""));
  const big = Array.from({ length: 500 }, (_, i) => "行" + i).join("\n");
  const bigD = ck.unifiedDiff(big, big.replace(/行/g, "列"), { maxLines: 50 });
  const shown = bigD.split("\n");
  ok(shown.length <= 52 && /… 还有 \d+ 行没显示$/.test(bigD.trim()), "超过 maxLines 截断并说明还剩多少", shown.length + " 行 / 尾行：" + shown[shown.length - 1]);
  // 前后相同的部分先剥掉再做 LCS：两万行只改中间一行也不能卡死
  const huge = Array.from({ length: 20000 }, (_, i) => "L" + i).join("\n");
  const t0 = Date.now();
  const hd = ck.unifiedDiff(huge, huge.replace("L10000\n", "L10000 改\n"));
  ok(Date.now() - t0 < 2000 && hd.includes("-L10000\n+L10000 改"), "两万行只改一行：一秒内出结果且只报那一行", (Date.now() - t0) + "ms");
  const s = ck.summarize("a\nb\nc\n", "a\nB\nc\nd\n");
  ok(s.add === 2 && s.del === 1 && s.text === "+2 −1 行", "summarize 数加减行", JSON.stringify(s));
}

// ---- ② 留底 / 列表 / 回退 / 撤销 ----
const root = fs.mkdtempSync(path.join(os.tmpdir(), "owb-ck-"));
const A = path.join(root, "a.txt");
const B = path.join(root, "sub", "b.md");
const S = "sess_1";
let n = 0;
const rec = (abs, before, after, tool = "write_file", session = S) => {
  n++;
  return ck.record(root, { session, call: "call_" + n, tool, abs, rel: path.relative(root, abs), before, after });
};
{
  // 新建 a.txt（before 为 null）
  const e1 = rec(A, null, "v1\n");
  fs.writeFileSync(A, "v1\n");
  ok(e1 && e1.before === null && typeof e1.after === "string" && e1.id.startsWith("ck_"), "新建文件：before 为 null，after 是内容哈希", JSON.stringify(e1));
  // 改成 v2
  const e2 = rec(A, "v1\n", "v2\n", "edit_file");
  fs.writeFileSync(A, "v2\n");
  ok(e2 && e2.before === e1.after, "第二次留底的 before 就是上一次的 after（内容寻址，同内容同哈希）");
  // 没变化不留
  ok(rec(A, "v2\n", "v2\n") === null, "内容没变不留检查点");
  // 新建 sub/b.md
  fs.mkdirSync(path.dirname(B), { recursive: true });
  const e3 = rec(B, null, "# b\n");
  fs.writeFileSync(B, "# b\n");
  ok(!!e3, "子目录里的新建文件也留底");
  // 工作目录外 / .history 里 不留
  ok(rec(path.join(root, "..", "evil.txt"), null, "x") === null, "工作目录外的路径不留");
  ok(rec(path.join(root, ".history", "objects", "z"), null, "x") === null, ".history 自己不留（不然回退会套娃）");
  // 别的会话的不混进来
  rec(path.join(root, "other.txt"), null, "o\n", "write_file", "sess_2");
  fs.writeFileSync(path.join(root, "other.txt"), "o\n");

  const rows = ck.list(root, S);
  ok(rows.length === 3 && rows.every((r) => r.session === S), "list 只列本会话的 3 条", JSON.stringify(rows.map((r) => [r.session, r.rel])));
  ok(rows[0].current === "changed" && rows[2].current === "same", "current 标出「之后又被改过」：a.txt 第一步 changed，b.md 最新 same", rows.map((r) => r.current).join(","));

  // 退到第 2 步之前：a.txt 回 v1，b.md（第 3 步新建）删掉
  const r = ck.rewind(root, S, e2.id);
  ok(r.ok === true && typeof r.undo === "string", "回退成功并给出撤销用的检查点 id", JSON.stringify(r));
  ok(read(A) === "v1\n", "a.txt 退回 v1", read(A));
  ok(read(B) === null, "b.md 那一步之前不存在，回退后删掉", read(B));
  ok(read(path.join(root, "other.txt")) === "o\n", "别的会话的文件一根毛没动");
  const acts = Object.fromEntries((r.files || []).map((f) => [f.rel, f.action]));
  ok(acts["a.txt"] === "restored" && acts[path.join("sub", "b.md")] === "deleted", "结果里每个文件说清 restored / deleted", JSON.stringify(acts));
  const after = ck.list(root, S);
  ok(after.length === 5 && after.slice(3).every((x) => x.tool === "rewind"), "回退本身留了 2 条 tool=rewind 的底", after.map((x) => x.tool).join(","));

  // 撤销：退到「回退那一步」之前 = 回到改完的样子
  const u = ck.rewind(root, S, r.undo);
  ok(u.ok && read(A) === "v2\n" && read(B) === "# b\n", "撤销回退：a.txt 回 v2，b.md 回来了", JSON.stringify([read(A), read(B)]));

  // 再退一次同样的目标：文件已经是那样 → unchanged，不报错
  const again = ck.rewind(root, S, ck.list(root, S)[ck.list(root, S).length - 1].id);
  ok(again.ok && again.files.every((f) => f.action === "unchanged" || f.action === "restored" || f.action === "deleted"), "重复回退不炸", JSON.stringify(again));

  // 错会话 / 错 id
  const bad = ck.rewind(root, "sess_2", e2.id);
  ok(bad.ok === false && /会话|找不到|没有/.test(bad.error), "别的会话拿这个 id 回退：拒", JSON.stringify(bad));
  ok(ck.rewind(root, S, "ck_不存在").ok === false, "不存在的 id：拒");

  // 账本被手改：塞一条 ../../ 的路径，回退时必须拒
  const ledger = ck._internals.ledgerPath(root);
  const hash = ck._internals.putObject(root, Buffer.from("evil"));
  fs.appendFileSync(ledger, JSON.stringify({ id: "ck_evil", ts: new Date().toISOString(), session: S, call: "c_evil", tool: "write_file", rel: "../../evil.txt", before: hash, after: null, size: 4 }) + "\n");
  const ev = ck.rewind(root, S, "ck_evil");
  const evilRow = (ev.files || []).find((f) => f.rel === "../../evil.txt");
  ok(ev.ok && evilRow && evilRow.action === "refused", "账本里的 ../../ 路径：拒，绝不写出工作目录", JSON.stringify(ev));
  ok(!fs.existsSync(path.join(root, "..", "..", "evil.txt")), "工作目录外确实没被写");

  // gc：30 天前的清掉，对象跟着删
  const old = new Date(Date.now() - 40 * 86400e3).toISOString();
  const lines = fs.readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  lines.forEach((l) => { if (l.session === "sess_2") l.ts = old; });
  fs.writeFileSync(ledger, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const g = ck.gc(root, { keepDays: 30 });
  ok(g.entries === 1 && ck.list(root, "sess_2").length === 0, "gc 清掉过期条目", JSON.stringify(g));
  ok(ck.list(root, S).length > 0, "gc 不动没过期的");
}

// ---- ③ 终端里的文案 ----
{
  const rows = ck.list(root, S);
  const txt = repl.checkpointListText(rows, Date.now());
  ok(/留了 \d+ 个检查点/.test(txt) && txt.includes("/rewind <序号>"), "列表头尾说清怎么退", txt);
  ok(/\n\s+1\. 新建 a\.txt/.test(txt) && /修改 a\.txt/.test(txt) && /回退 /.test(txt), "每条标出 新建/修改/回退", txt);
  ok(repl.checkpointListText([]).includes("还没留过检查点"), "空列表说人话");
  ok(repl.pickCheckpoint(rows, "2") === rows[1] && repl.pickCheckpoint(rows, "0") === null && repl.pickCheckpoint(rows, "abc") === null && repl.pickCheckpoint(rows, String(rows.length + 1)) === null, "序号 1 起，越界和乱写都 null");
  const rt = repl.rewindResultText({ ok: true, files: [{ rel: "a.txt", action: "restored" }, { rel: "b.md", action: "deleted" }, { rel: "c", action: "refused", why: "路径不在工作目录里" }] });
  ok(rt.includes("动了 2 个文件") && rt.includes("已恢复  a.txt") && rt.includes("已删掉") && rt.includes("没退  c：路径不在工作目录里") && rt.includes("退错了"), "回退结果逐文件说清并提示撤销", rt);
  ok(repl.rewindResultText({ ok: true, files: [] }).startsWith("没有文件需要退"), "没动文件时不说「退回去了」");
  ok(repl.COMMANDS.some((c) => c.name === "rewind"), "/rewind 在命令表里");
}

// ---- ④ 审批卡带 diff ----
{
  const kinds = [];
  const detail = "--- a.txt\n+++ a.txt\n@@ -1 +1 @@\n-旧\n+新";
  const txt = ap.render({ kind: "写文件", text: "写文件 a.txt", detail }, { paint: (s, k) => { kinds.push(k); return s; } });
  ok(txt.includes("  -旧\n  +新"), "diff 印在命令原文和选项之间", txt);
  ok(kinds.includes("add") && kinds.includes("del"), "加减行用 add/del 两种颜色", kinds.join(","));
  const many = Array.from({ length: 60 }, (_, i) => "+行" + i).join("\n");
  ok(ap.render({ kind: "写文件", text: "x", detail: many }).includes("… 还有 20 行"), "超过 40 行截掉并说明");
  ok(ap.render({ kind: "写文件", text: "x" }).split("\n").filter((l) => l.startsWith("  +")).length === 0, "没 detail 就不多印一行");
  ok(ap.card({ id: "a1", kind: "写文件", text: "x", detail }, Date.now() + 1000).detail === detail, "手机卡片也带 detail");
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
