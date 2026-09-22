"use strict";
/**
 * 记忆超预算时，规矩先进门。
 *
 * 记忆超预算时条目按跟本次任务的相关度挑。对事实这是对的（写推文用不着「报销走飞书」），
 * 对规矩是错的：「交付时别用 open 替我打开文件」跟「写公众号推文」一个关键词都不重合，
 * 相关度算出来是零，于是被挤掉——而它恰恰是任何任务都得守的那种。真踩过：
 * 用户被弹了一桌面窗口，agent 自己翻记忆才发现「我明明记着这条规矩」。
 *
 * 这套测三件事：哪些话算规矩；超预算时零相关的规矩留下、零相关的事实挤掉；命中只记给真进门的那几条。
 */
const path = require("path");
const fs = require("fs");
const os = require("os");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "owb-memrules-"));
process.env.OPENWORKBUDDY_HOME = HOME;
process.env.OPENWORKBUDDY_DATA_DIR = path.join(HOME, "data");

const ROOT = path.join(__dirname, "..");
const memory = require(path.join(ROOT, "memory"));
const { isRule, save, load, MAX_PROMPT_CHARS, pendingHits } = memory._internals;

let pass = 0, fail = 0, finished = false;
process.on("exit", (code) => {
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
  if (finished || code !== 0) return;
  console.log(`\n✗ 这套测试没跑完就退了（跑到第 ${pass + fail} 条）`);
  process.exitCode = 1;
});
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? "  ← " + JSON.stringify(extra) : ""}`); }
}
function eq(got, want, name) { ok(Object.is(got, want), name, Object.is(got, want) ? undefined : { got, want }); }
/** 一段互不相似的假中文：条目之间二元组不重合，免得被「提示词里去重」当成同一条压掉 */
const blab = (seed, n) => {
  let x = (seed * 2654435761) >>> 0;
  const out = [];
  for (let j = 0; j < n; j++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out.push(String.fromCharCode(0x4e00 + (x >>> 8) % 6000));
  }
  // 别让随机字里冒出「不/勿/别/每/任」——那几个字会让一条事实被当成规矩
  return out.join("").replace(/[不勿别每任必禁绝永从]/g, "口");
};

(async () => {
  // ─────────────────────────────────────────────────────────────
  console.log("\n① 哪些话算规矩（宁多认不少认）");
  // ─────────────────────────────────────────────────────────────
  {
    for (const t of [
      "交付时不要用 open 替我打开文件，只报路径",
      "写完必须跑一次 check_page",
      "任何时候都别替我挑标题，岔路要问我",
      "Never open files on my desktop after delivery",
      "Don't run npm install without asking",
      "每次都先看 README 再动手",
    ]) ok(isRule(t), `规矩：${t}`);
    for (const t of [
      "公司报销走飞书审批",
      "用户的公众号叫「晚风说」",
      "上次那篇推文的封面用的是蓝色",
      "The project uses pnpm",
    ]) ok(!isRule(t), `事实：${t}`);
    ok(!isRule("") && !isRule(null), "空的不算");
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n② 超预算：零相关的规矩留下，零相关的事实挤掉");
  // ─────────────────────────────────────────────────────────────
  {
    const user = "u1";
    const now = Date.now();
    const at = (i) => new Date(now - (1000 - i) * 60000).toISOString();
    const items = [];
    // 一条跟「写公众号推文」一个字都不沾的规矩（这就是真踩过的那条）
    items.push({ id: "rule_open", text: "交付时不要用 open 替我打开文件，只报路径就行", scope: user, source: "agent", created_at: at(0) });
    // 一堆同样零相关、但比那条规矩新的事实：老逻辑按相关度排，零分之间按新旧，规矩最老所以最先被挤掉
    for (let i = 0; i < 120; i++) {
      items.push({ id: "zero_" + i, text: `办公室杂事${i}：${blab(9000 + i, 30)}`, scope: user, source: "agent", created_at: at(1 + i) });
    }
    // 一堆跟任务高度相关的事实，多到把预算撑爆
    for (let i = 0; i < 80; i++) {
      items.push({ id: "fact_" + i, text: `公众号推文第 ${i} 条经验：标题里带数字、导语点题，${blab(i + 1, 90)}`, scope: user, source: "agent", created_at: at(200 + i) });
    }
    save(items);
    const total = items.reduce((n, x) => n + x.text.length + 3, 0);
    ok(total > MAX_PROMPT_CHARS, `（前置）这堆条目确实超预算：${total} > ${MAX_PROMPT_CHARS}`);

    const block = await memory.promptBlock(user, "帮我写一篇公众号推文，主题是降温，标题要带数字");
    ok(/交付时不要用 open 替我打开文件/.test(block), "★★零相关的规矩进了提示词★★ 这条跟「写推文」一个关键词都不沾，以前就是它被挤掉的");
    const zeroIn = items.filter((x) => x.id.startsWith("zero_") && block.includes(x.text)).length;
    ok(zeroIn < 120, `★零相关的事实照旧挤掉★ 规矩优先不是把预算让给所有零相关的条目（120 条零相关事实进了 ${zeroIn} 条）`);
    ok(/公众号推文第 \d+ 条经验/.test(block), "  └ 相关的事实还在");
    ok(/记忆条目共 201 条装不下/.test(block) && /规矩类的 1 条全放进来了/.test(block), "  └ 那句说明写清了：几条规矩全进来了，其余按相关度挑", (block.match(/（记忆条目[^）]*）/) || [""])[0]);

    // 命中只记给真进门的那几条
    const hits = pendingHits();
    ok(hits.has("rule_open"), "★命中记给了进门的规矩★");
    const outside = items.filter((x) => !block.includes(x.text));
    ok(outside.length > 0 && outside.every((x) => !hits.has(x.id)), `★没进门的没记命中★ 记了就等于「用过 N 次」凭空涨，下次挑选更挤掉别人（门外 ${outside.length} 条）`);
    const inBlock = [...hits.keys()].every((id) => { const x = items.find((y) => y.id === id); return x && block.includes(x.text); });
    ok(inBlock, "  └ 每一条记了命中的，都真的在提示词里");
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n③ 规矩太多也装不下：明说，别悄悄丢");
  // ─────────────────────────────────────────────────────────────
  {
    const user = "u2";
    const items = [];
    for (let i = 0; i < 80; i++) {
      items.push({ id: "r" + i, text: `第 ${i} 条规矩：任何时候都不要${blab(500 + i, 100)}`, scope: user, source: "agent", created_at: new Date(Date.now() - (100 - i) * 60000).toISOString() });
    }
    save(items);
    const block = await memory.promptBlock(user, "随便干点什么");
    ok(/还有 \d+ 条规矩也装不下/.test(block), "★装不下的规矩数出来了★ 静悄悄丢的规矩跟没记过一样", (block.match(/（记忆条目[^）]*）/) || [""])[0]);
    ok(/第 0 条规矩/.test(block), "  └ 先进门的是最早记的那几条（按记入时间，稳定，不随任务变）");
  }

  console.log(`\n记忆规矩优先：${pass} 通过，${fail} 失败`);
  finished = true;
  if (fail) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; finished = true; });
