// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 上传同名不覆盖 —— 拖第二张 image.png 进来，第一张不许被盖掉。
 *
 *   node test/upload-name.js
 *
 * 数的是盘上的字节：第一份还是第一份的内容、第二份落在 _2 上。光看返回的名字不够——
 * 名字改了、内容却照样写进原名那份，也是这一个返回值。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { mod } = require("./lib/mod");
const ROOT = path.join(__dirname, "..");

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  ← " + String(typeof extra === "string" ? extra : JSON.stringify(extra)).slice(0, 300) : "")); }
}

const { uploadCandidate, writeUploadFresh, uploadIsCandidate, writeUploadReplace } = require(mod("upload-name"));
const WS = fs.mkdtempSync(path.join(os.tmpdir(), "owb-upload-name-"));
const read = (n) => fs.readFileSync(path.join(WS, n), "utf8");

console.log("\n【1】候选名");
ok(uploadCandidate("image.png", 1) === "image.png", "第一个候选就是原名");
ok(uploadCandidate("image.png", 2) === "image_2.png" && uploadCandidate("image.png", 3) === "image_3.png", "往后是 名字_2.扩展名、名字_3.扩展名");
ok(uploadCandidate("README", 2) === "README_2", "没扩展名的直接接 _2");
ok(uploadCandidate(".env", 2) === ".env_2", "点开头的整个当名字，不拆成空名字 + 扩展名");

console.log("\n【2】同名不覆盖");
const a = writeUploadFresh(WS, "image.png", Buffer.from("第一张"));
const b = writeUploadFresh(WS, "image.png", Buffer.from("第二张"));
const c = writeUploadFresh(WS, "image.png", Buffer.from("第三张"));
ok(a === "image.png" && b === "image_2.png" && c === "image_3.png", "三次同名：image.png、image_2.png、image_3.png", [a, b, c]);
ok(read("image.png") === "第一张" && read("image_2.png") === "第二张" && read("image_3.png") === "第三张",
  "★第一张的内容还是第一张★ 以前第二次上传直接盖掉，挂着它的卡全变成第二张");
const d = writeUploadFresh(WS, "别的.png", Buffer.from("x"));
ok(d === "别的.png", "反向对照：不撞名的照原名存，不平白加 _2", d);
fs.unlinkSync(path.join(WS, "image.png"));
const e = writeUploadFresh(WS, "image.png", Buffer.from("补上的"));
ok(e === "image.png" && read("image_2.png") === "第二张", "原名空出来了就用原名，已有的 _2 不动", e);

console.log("\n【3】子目录不在就建；写不进去照原样报，不吞");
const sub = path.join(WS, "任务_1", "素材");
ok(writeUploadFresh(sub, "a.mp4", Buffer.from("v")) === "a.mp4" && fs.existsSync(path.join(sub, "a.mp4")), "目录不在先建");
let threw = "", tries = 0;
const denied = { mkdirSync() {}, writeFileSync() { tries += 1; throw Object.assign(new Error("permission denied"), { code: "EACCES" }); } };
try { writeUploadFresh(WS, "a.png", Buffer.from("x"), { fs: denied }); } catch (err) { threw = err.code; }
ok(threw === "EACCES" && tries === 1, "没权限：原样报出来，不当成「重名」一路挪号试九百多次", { threw, tries });

console.log("\n【4】同时来两份同名：一份一个名字，谁也不盖谁");
// 独占写的意义：先查后写的话，两份都查到 image.png 空着，后写的照样盖掉先写的。这里用一个
// 「查的时候说不在、写的时候已经在了」的假文件系统把那一瞬间造出来
let raced = false;
const racing = {
  mkdirSync: fs.mkdirSync,
  writeFileSync(p, buf, o) {
    if (!raced && path.basename(p) === "并发.png") { raced = true; fs.writeFileSync(p, "先到的那份"); }
    return fs.writeFileSync(p, buf, o);
  },
};
const got = writeUploadFresh(WS, "并发.png", Buffer.from("后到的那份"), { fs: racing });
ok(got === "并发_2.png" && read("并发.png") === "先到的那份" && read("并发_2.png") === "后到的那份",
  "★写的那一刻已经有人占了原名：挪到 _2，先到的那份不动★", { got });

console.log("\n【5】接线：上传接口用它挑名字，前端跟着改名");
const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const up = (server.match(/app\.post\("\/api\/upload"[\s\S]*?\n\}\);/) || [""])[0];
ok(/uploadName\.writeUploadFresh\(/.test(up) && !/fs\.writeFileSync\(p,/.test(up), "/api/upload 经 writeUploadFresh 落盘，不再拿原名直接写");
ok(/renamedFrom/.test(up) && /name: saved/.test(up), "改了名的回执带新名字和原名");
const chat = fs.readFileSync(path.join(ROOT, "public/js/app-02.js"), "utf8");
ok(/data\.name !== item\.name\) renameAttach\(item/.test(chat), "对话附件：服务端改了名，chip 和输入框里的锚点跟着改");
const inspector = fs.readFileSync(path.join(ROOT, "public/js/app-07-canvas-inspector.js"), "utf8");
ok(/name !== file\.name \? canvasT\("工作区里已有同名文件/.test(inspector), "画布：卡上挂的是新名字，并且说一声存成了什么");

console.log("\n【6】同一枚附件又拖了一遍：认得出是自己那份就原地换，认不出就另起名字");
// 以前一律另起：chip 改叫 名字_2，上一趟那份没人认了还躺在目录里，模型列目录看见两份
ok(uploadIsCandidate("图.png", "图.png") && uploadIsCandidate("图.png", "图_2.png") && uploadIsCandidate("图.png", "图_13.png"), "原名、名字_N 都算这一枚挑得到的名字");
ok(!uploadIsCandidate("图.png", "图_1.png") && !uploadIsCandidate("图.png", "图_x.png") && !uploadIsCandidate("图.png", "别的.png") && !uploadIsCandidate("图.png", "图_2.jpg") && !uploadIsCandidate("图.png", "图_02.png"),
  "名字_1、名字_x、别的名字、换了扩展名的都不算");
ok(uploadIsCandidate(".env", ".env_2") && !uploadIsCandidate(".env", ".env.bak"), "点开头的整个当名字：.env → .env_2");
const R = path.join(WS, "重拖");
fs.mkdirSync(R, { recursive: true });
const first = writeUploadFresh(R, "封面.png", Buffer.from("旧的"));
const yes = () => true, no = () => false;
const asked = [];
const swapped = writeUploadReplace(R, "封面.png", first, Buffer.from("新的"), (n, f) => { asked.push([n, f]); return true; });
ok(swapped === "封面.png" && fs.readFileSync(path.join(R, "封面.png"), "utf8") === "新的", "★认得出是自己那份：原地换成新内容，名字不变★", swapped);
ok(!fs.existsSync(path.join(R, "封面_2.png")), "没再多出一份 封面_2.png");
ok(asked.length === 1 && asked[0][0] === "封面.png" && asked[0][1] === path.join(R, "封面.png"), "问过一声「这份是不是这一枚自己的」，问的是盘上那份的路径", asked);
ok(fs.readdirSync(R).every((n) => !/\.tmp$/.test(n)), "临时文件没留下");
ok(writeUploadReplace(R, "封面.png", "封面.png", Buffer.from("盖错了"), no) === "" && fs.readFileSync(path.join(R, "封面.png"), "utf8") === "新的",
  "★认不出（Agent 改写过、服务重启过）：不换，交给调用方另起名字★");
ok(writeUploadReplace(R, "封面.png", "别人的.png", Buffer.from("x"), yes) === "" && !fs.existsSync(path.join(R, "别人的.png")), "名字不是这一枚挑得到的：不换");
ok(writeUploadReplace(R, "封面.png", "../封面.png", Buffer.from("x"), yes) === "" && writeUploadReplace(R, "封面.png", "子/封面.png", Buffer.from("x"), yes) === "", "带目录的一律不认，只在本目录里换");
ok(writeUploadReplace(R, "封面.png", "", Buffer.from("x"), yes) === "" && writeUploadReplace(R, "封面.png", "封面.png", Buffer.from("x")) === "", "没带上一趟的名字、没给认领判据：不换");
ok(/uploadName\.writeUploadReplace\(/.test(up) && /isUserInput\(/.test(up) && /replaced: true/.test(up) && /swapped \|\| uploadName\.writeUploadFresh\(/.test(up),
  "/api/upload：带 replace 的先试原地换（拿上传那一刻记的 mtime 认领），换不了照常另起名字");
ok(/\.\.\.\(item\.replace \? \{ replace: item\.replace \}/.test(chat) && /if \(dup\.path && !dup\.blob\) dup\.replace = dup\.path/.test(chat), "前端：重拖的那枚带上上一趟落盘的路径");
ok(!/内容更新成最新的了/.test(chat), "不再没传完就说「更新成最新的了」");

try { fs.rmSync(WS, { recursive: true, force: true }); } catch {}
console.log(fail ? `\n有失败：${pass} 过 / ${fail} 挂` : `\n全部通过：${pass} 过 / 0 挂`);
process.exit(fail ? 1 : 0);
