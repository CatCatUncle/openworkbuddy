// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 多人服务器上「成员能用哪些对话模型」（member-models.js + server.js 那几处接线）。
 *
 * 跑法：node test/member-models.js
 * 纯函数 + 读源码，不起服务、不连外网。
 *
 * 起因是一条 issue：「超管可以选是否共享模型给员工，不共享就由员工自己配置」。
 * 盯的线：
 *   1. 渠道标了不共享，成员看不见、选不中、跑不了；没标的照旧共享（老配置一个字不用改）
 *   2. 成员自己填的 Key 只有他自己看得见；读接口只回八颗星；原样存回八颗星 = 没改
 *   3. 平台管理员关掉「成员自带 Key」，成员填过的那几条立刻用不了（留着不删）
 *   4. 平台管理员和个人桌面版看到的永远是全表——这次改动对他们一个字节不差
 * 每条后面跟一个反向对照。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { mod } = require("./lib/mod");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "owb-member-"));
process.env.OPENWORKBUDDY_DATA_DIR = path.join(TMP, "data");
fs.mkdirSync(process.env.OPENWORKBUDDY_DATA_DIR, { recursive: true });
const { entry } = require("./lib/entry");
const mm = require(mod("member-models"));

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ " + msg + (extra !== undefined ? "  ← " + JSON.stringify(extra) : "")); }
};
const eq = (got, want, msg) => ok(got === want, msg, { got, want });
const why = (fn) => { try { fn(); return ""; } catch (e) { return e.message; } };
const names = (list) => list.map((m) => m.name).join(",");

const config = {
  active_model: "贵的",
  providers: [{ id: "opus", share_members: false }, { id: "cheap" }],
  models: [
    { name: "贵的", channel: "opus", provider: "anthropic", model: "claude-opus", api_key: "k1" },
    { name: "便宜的", channel: "cheap", provider: "openai", model: "deepseek-chat", api_key: "k2" },
    { name: "老配置", provider: "openai", model: "gpt-4o", api_key: "k3" },
  ],
};
const prefsA = { my_models: [{ label: "我的GPT", provider: "openai", base_url: "https://api.example.com/v1", api_key: "sk-mine", model: "gpt-5" }] };
const member = { owner: false, prefs: prefsA };
const owner = { owner: true };

console.log("\n【1】共享开关：按渠道");
eq(names(mm.listFor(config, owner)), "贵的,便宜的,老配置", "平台管理员看到全表，自己的 Key 不混进来");
const seen = names(mm.listFor(config, member));
ok(!seen.includes("贵的"), "★标了不共享的渠道：成员看不见★", seen);
ok(seen.includes("便宜的") && seen.includes("老配置"), "反向对照：没标的渠道、没挂渠道的老条目照旧共享", seen);
eq(mm.find(config, member, "贵的"), null, "★点名不共享的那条：找不到（会话、助理页都靠它核）★");
ok(mm.find(config, owner, "贵的"), "反向对照：平台管理员点得到");
eq(mm.defaultFor(config, member).name, "便宜的", "全局默认他用不着：换成他能用的第一个，不报错也不偷用");
eq(mm.defaultFor({ ...config, active_model: "便宜的" }, member).name, "便宜的", "全局默认他用得着：就用它");
eq(mm.defaultFor(config, owner).name, "贵的", "平台管理员的默认就是全局默认");

console.log("\n【2】自己的 Key");
const own = mm.find(config, member, "my:我的GPT");
ok(own && own.own && own.api_key === "sk-mine" && own.model === "gpt-5", "成员找得到自己那条，运行期带着真 Key", own && { own: own.own, model: own.model });
eq(mm.find(config, { owner: false, prefs: {} }, "my:我的GPT"), null, "★别人的偏好里没有这条：别人用不了★");
eq(mm.find(config, owner, "my:我的GPT"), null, "平台管理员的列表里也没有成员的私人 Key");
ok(mm.isOwnName("my:x") && !mm.isOwnName("x"), "my: 前缀认得出");
const pub = mm.publicOwn(prefsA)[0];
ok(pub.api_key === "********" && pub.has_key && !JSON.stringify(mm.publicOwn(prefsA)).includes("sk-mine"), "★读接口只回八颗星★");
ok(mm.listFor({ ...config, models: [{ name: "my:我的GPT", model: "x" }] }, owner).length === 1, "管理员那张表里就算有人起名 my: 也不跟成员的混（各在各的来源）");

console.log("\n【3】存回来");
let out = mm.mergeIncoming(prefsA, [{ ...pub, prev_label: "我的GPT" }]);
eq(out[0].api_key, "sk-mine", "★原样存回八颗星 = 没改，真 Key 留着★");
out = mm.mergeIncoming(prefsA, [{ ...pub, label: "改个名", prev_label: "我的GPT" }]);
eq(out[0].api_key, "sk-mine", "改了名字也认得出是哪条（按 prev_label）");
out = mm.mergeIncoming(prefsA, [{ ...pub, api_key: "sk-new" }]);
eq(out[0].api_key, "sk-new", "反向对照：填了新 Key 就换");
ok(/没填 API Key/.test(why(() => mm.mergeIncoming({}, [{ label: "新", model: "m", base_url: "https://a.com" }]))), "新条目没填 Key：报错，不悄悄存一条用不了的");
eq(why(() => mm.mergeIncoming({}, [{ label: "本机", provider: "ollama", model: "qwen" }])), "", "反向对照：ollama 不要 Key");
ok(/重复/.test(why(() => mm.mergeIncoming({}, [{ label: "a", model: "m", api_key: "k" }, { label: "a", model: "n", api_key: "k" }]))), "名字重复：报错");
ok(/名字和模型名/.test(why(() => mm.mergeIncoming({}, [{ label: "", model: "m", api_key: "k" }]))), "缺名字：报错，不悄悄丢掉一行");
ok(/最多/.test(why(() => mm.mergeIncoming({}, Array.from({ length: mm.MAX_OWN + 1 }, (_, i) => ({ label: "m" + i, model: "m", api_key: "k" }))))), "超过上限：报错");
eq(mm.mergeIncoming({}, [{ label: "my:前缀", model: "m", api_key: "k" }])[0].label, "前缀", "名字里自己写了 my: 的去掉，运行期不会变成 my:my:");

console.log("\n【4】平台管理员关掉「成员自带 Key」");
const off = { ...config, member_byok: false };
eq(mm.find(off, member, "my:我的GPT"), null, "★关掉之后：自己那条立刻用不了★");
ok(names(mm.listFor(off, member)).includes("便宜的"), "反向对照：共享的照旧能用");
ok(mm.byokAllowed(config) && !mm.byokAllowed(off), "没写 = 开着（老配置照旧）");
eq(prefsA.my_models.length, 1, "填过的不删，再打开就回来");

console.log("\n【5】server.js 接线");
const S = fs.readFileSync(entry("server"), "utf8");
const fnBody = (name) => { const i = S.indexOf(`function ${name}(`); return i < 0 ? "" : S.slice(i, S.indexOf("\n}\n", i)); };
const lfs = fnBody("llmForSession");
ok(/const who = modelWho\(/.test(lfs) && /memberModels\.find\(config, who, name\)/.test(lfs) && /memberModels\.defaultFor\(config, who\)/.test(lfs),
  "★会话跑哪个模型：成员只在他能用的里挑★");
ok(/不在你能用的模型里/.test(lfs) && /Promise\.reject/.test(lfs), "选过的那条被收回：明确报错，不悄悄换一个跑");
const who = fnBody("modelWho");
ok(/isSoloDesktop\(\)\) return \{ owner: true \}/.test(who) && /ownsGlobalWorkspace\(u\)\) return \{ owner: true \}/.test(who), "个人桌面版、平台管理员走全表");
ok(/llmForSession\(sess, user\)|llmForSession\([^)]*,\s*user\)/.test(S), "/api/chat 开跑前把当前登录的人带进去（会话里没记人也认得出）");
const modelRouteAt = S.indexOf('app.post("/api/session/:id/model"');
const modelRoute = S.slice(modelRouteAt, S.indexOf("\n});", modelRouteAt));
ok(modelRouteAt >= 0 && /memberModels\.find\(config, modelWho\(req\.user\)/.test(modelRoute), "★给会话换模型：核他能不能用★");
const assistRouteAt = S.indexOf('app.post("/api/assist/model"');
const assistRoute = S.slice(assistRouteAt, S.indexOf("\n});", assistRouteAt));
ok(assistRouteAt >= 0 && /memberModels\.find\(config, modelWho\(req\.user\)/.test(assistRoute), "★助理页换模型：同一道核★");
ok(/models: memberModels\.listFor\(config, isPlatformOwner\(req\) \? \{ owner: true \} : modelWho\(req\.user\)\)/.test(S), "设置页的模型列表按人给");
const my = S.slice(S.indexOf('app.post("/api/my-models"'), S.indexOf('app.post("/api/models/share"'));
ok(/byokAllowed\(config\)\) return res\.status\(403\)/.test(my), "★关掉之后存不进去★");
ok(/netGuard\.checkUrl\(/.test(my), "★接口地址过联网那道闸（本机、内网不让填）★");
ok(/isDecisionModel\(/.test(my), "Jev 不能当对话模型");
ok(/prefs\.write\(req\.user, \{ my_models: items \}\)/.test(my), "存在他自己的偏好里，不进 config");
const share = S.slice(S.indexOf('app.post("/api/models/share"'), S.indexOf('app.post("/api/assist/model"'));
eq((share.match(/if \(!isPlatformOwner\(req\)\) return res\.status\(403\)/g) || []).length, 2, "★共享开关两条接口：处理器里再核一遍平台管理员★");
ok(/share_members: false/.test(S.slice(S.indexOf("「给不给成员用」只走"), S.indexOf("「给不给成员用」只走") + 400)), "设置页整表回存：抄旧的不共享标记，漏带不会悄悄共享出去");

console.log("\n【6】记账、闸");
const A = fs.readFileSync(mod("account"), "utf8");
ok(/const ownKey = String\(info\.provider \|\| ""\)\.startsWith\("my:"\)/.test(A) && /const local = !!info\.local \|\| ownKey/.test(A), "自己的 Key 跑的：不扣组织积分、0 元");
ok(/!p\.local && !String\(p\.provider \|\| ""\)\.startsWith\("my:"\)/.test(A), "一趟里混着跑：整趟的积分记在组织渠道那段上");
const ADM = require(mod("admin"));
ok(ADM.PLATFORM_WRITE.includes("/api/models/"), "/api/models/ 归平台管理员");
ok(!ADM.PLATFORM_WRITE.some((x) => "/api/my-models".startsWith(x)) && !ADM.PLATFORM_READ.some((x) => "/api/my-models".startsWith(x)), "反向对照：/api/my-models 不在两张表里，成员进得来");

console.log("\n【7】前端");
const F5 = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-05.js"), "utf8");
const F2 = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-02.js"), "utf8");
ok(/function paintMyModels\(/.test(F5) && /\/api\/my-models/.test(F5), "成员的设置页有「我自己的模型」");
ok(/ch-share-cb/.test(F5) && /\/api\/models\/share/.test(F5), "渠道卡上有「成员能用」的勾");
ok(/mf-byok/.test(F5) && /\/api\/models\/member-byok/.test(F5), "平台管理员有总开关");
ok(/function modelShown\(/.test(F2), "界面上显示名字时去掉 my: 前缀");

console.log("\n【8】每个人自己的助理（名字、头像、偏好）");
const prefs = require(mod("prefs"));
const gcfg = { assistant: { name: "公司助理", avatar: "@cat" }, persona: "统一用简体中文" };
let a = prefs.assistantFor("xiaoli", gcfg);
ok(a.name === "公司助理" && a.avatar === "@cat" && a.persona === "" && !a.own, "没填过：跟全局那份走", a);
prefs.write("xiaoli", { assistant: { name: "小秘", avatar: "🐼", persona: "结论放最前面" } });
a = prefs.assistantFor("xiaoli", gcfg);
ok(a.name === "小秘" && a.avatar === "🐼" && a.persona === "结论放最前面" && a.own, "★填了：用他自己的★", a);
eq(prefs.assistantFor("xiaowang", gcfg).name, "公司助理", "★别人不受影响★");
eq(prefs.assistantFor("", gcfg).name, "公司助理", "认不出是谁（命令行、老 IM 入站）：全局那份");
prefs.write("xiaoli", { assistant: { name: "  " } });
eq(prefs.assistantFor("xiaoli", gcfg).name, "公司助理", "名字清空：退回全局的，不会变成没名字");
eq(prefs.assistantFor("xiaoli", {}).name, "OpenWorkBuddy", "全局也没名字：默认名");
const AG = fs.readFileSync(mod("agent"), "utf8");
ok(/const mine = prefs\.assistantFor\(user, config\);\s*const myName = mine\.name;/.test(AG), "★系统提示词里的名字按发起这趟的人取★");
ok(/if \(config\.persona\)[\s\S]{0,120}if \(mine\.persona\) p \+= /.test(AG), "★他自己的偏好排在组织偏好后面，不替换★");
eq((AG.match(/这位用户自己的偏好/g) || []).length, 2, "内置引擎、本机引擎两条路都带上");
const SV = fs.readFileSync(entry("server"), "utf8");
const ma = SV.slice(SV.indexOf('app.get("/api/my-assistant"'), SV.indexOf('app.post("/api/my-assistant"') + 1200);
ok(/if \(!ownPrefs\(req\)\) return res\.status\(400\)/.test(ma) && /prefs\.write\(req\.user, \{ assistant: next \}\)/.test(ma), "存在他自己的偏好里；平台管理员不走这条（他改的就是全局）");
ok(/normalizeAvatar\(/.test(ma) && /slice\(0, 4000\)/.test(ma) && /slice\(0, 24\)/.test(ma), "头像过同一道检查，名字、偏好有长度上限");
ok(!require(mod("admin")).PLATFORM_WRITE.some((x) => "/api/my-assistant".startsWith(x)), "成员进得来这条接口");
ok(/app\.get\("\/api\/assistant"[\s\S]{0,200}prefs\.assistantFor\(/.test(SV), "界面上画头像那条接口也按人给");
ok(/function paintMyAssistant\(/.test(F5) && /paintMyAssistant\(pane\.querySelector\("#my-assistant"\)\)/.test(F5), "成员的个性化页有「我的助理」");

console.log("\n【9】专家：成员自己建 + 平台管理员逐个共享");
const efBody = SV.slice(SV.indexOf("function expertsFor("), SV.indexOf('app.get("/api/experts"'));
// 把 server.js 里那段原样拿出来跑：modelWho / ownExperts 换成桩
const makeFor = new Function("experts", "modelWho", "ownExperts", efBody + "; return expertsFor;");
const pool = [{ name: "写手" }, { name: "律师", share_members: false }, { name: "分析师" }];
const ef = makeFor(pool, (u) => (u === "boss" ? { owner: true } : { owner: false, prefs: { my_experts: u === "xiaoli" ? [{ name: "分析师" }, { name: "私教" }] : [] } }), (p) => (p.my_experts || []).map((e) => ({ ...e })));
eq(ef("boss").map((e) => e.name).join(","), "写手,律师,分析师", "平台管理员：全表");
eq(ef("xiaowang").map((e) => e.name).join(","), "写手,分析师", "★成员看不到「不给成员用」的那位★");
const li = ef("xiaoli");
eq(li.map((e) => e.name).join(","), "分析师,私教,写手", "★自己建的 + 共享的；重名以自己的为准★");
ok(li.filter((e) => e.own).length === 2, "自己建的带 own 标记", li);
ok(!ef("xiaowang").some((e) => e.name === "私教"), "★别人建的专家在他那儿不存在★");
const myE = SV.slice(SV.indexOf('app.post("/api/my-experts"'), SV.indexOf('app.post("/api/experts", '));
ok(/if \(!ownPrefs\(req\)\) return res\.status\(400\)/.test(myE) && /prefs\.write\(req\.user, \{ my_experts:/.test(myE), "存在他自己的偏好里");
ok(/跟共享的专家撞了/.test(myE) && /MAX_OWN_EXPERTS/.test(myE), "不许跟共享的重名，有数量上限");
const shareE = SV.slice(SV.indexOf('app.post("/api/experts/share"'), SV.indexOf('app.post("/api/my-experts"'));
ok(/if \(!isPlatformOwner\(req\)\) return res\.status\(403\)/.test(shareE), "★共享开关只有平台管理员能拨★");
ok(ADM.PLATFORM_WRITE.some((x) => "/api/experts/share".startsWith(x)), "闸表也挡着（双保险）");
ok(!ADM.PLATFORM_WRITE.some((x) => "/api/my-experts".startsWith(x)), "成员进得来 /api/my-experts");
ok(/if \(experts\[idx\]\.share_members === false\) entry\.share_members = false/.test(SV), "管理员改专家内容不会把「不给成员用」冲掉");
ok(/createAgentRuntime\(\{[^}]*expertsFor[^}]*\}\)/.test(SV), "运行时拿到 expertsFor");
ok(/function expertsOf\(user\)/.test(AG) && /toolList\(depth, mode, user\)/.test(AG) && /toolList\(depth, "craft", user\)/.test(AG), "★委派工具表按发起这趟的人取★");
ok(/pool\.find\(\(e\) => e\.name === n && !e\.own\)/.test(AG), "团里的成员不会被他自己的同名专家顶替");
const F4 = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-04.js"), "utf8");
ok(/\/api\/my-experts/.test(F4) && /\/api\/experts\/share/.test(F4), "前端：成员存到自己那份，管理员有共享开关");
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
process.exit(fail === 0 ? 0 : 1);
