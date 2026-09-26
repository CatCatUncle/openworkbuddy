"use strict";
/**
 * 套件自己的临时数据家：单独跑（node test/xxx.js）也不碰用户真实的 data/ 和 workspace/。
 *
 *   // 套件最前面，赶在 require 任何生产模块之前
 *   const HOME = require("./lib/own-home")("agent-loop");
 *
 * 为什么非得在最前面：paths.js 被 require 的那一刻就把 DATA_DIR 定死了，开发态没设
 * OPENWORKBUDDY_HOME 时它就是仓库根。之后 agent 跑一趟，trace.js 就往用户真在用的
 * workspace/.openworkbuddy/traces.jsonl 里记一整条任务——agent-loop 单独跑一次 256 行，
 * 写不进去的错还被 trace.js 吞掉，套件照样绿。
 *
 * 不管外面给没给 OPENWORKBUDDY_HOME，都另起一个：test/all.js 故意不给用这个的套件发临时家
 * （all.js 的 SELF_ISOLATED），就是照单独跑的样子查它们。trace 账本外面给了 OPENWORKBUDDY_TRACE_FILE
 * 就照用，没给就跟着 DATA_DIR 落进这个家里。
 *
 * 收尾挂在 exit 上并且排到最后：审计是 500ms 防抖写盘，在 finally 里删早了会被它再建出来；
 * 套件自己的「没跑完就算红」也挂在 exit 上，得等它把退出码定了再决定删不删。绿了删，红了留着并打出来。
 *
 * @param {string} tag 目录名里认人用：owb-<tag>-home-XXXXXX
 * @returns {string} 这个家的绝对路径
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

module.exports = function ownHome(tag) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `owb-${String(tag || "suite").replace(/[^\w-]/g, "")}-home-`));
  process.env.OPENWORKBUDDY_HOME = home;
  let armed = false;
  const finish = (code) => {
    // exit 回调拿到的 code 是开始退出那一刻的；后面的回调改了 process.exitCode 才是最终的
    if ((code || Number(process.exitCode) || 0) === 0) { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} }
    else console.log("留着现场（数据目录）：" + home);
  };
  // 顶层同步代码里就退出了（还没轮到 setImmediate）：只能靠这一个
  process.on("exit", (code) => { if (!armed) finish(code); });
  // 套件的 exit 回调都是顶层代码里挂的：这一个挂在它们后面，最后一个跑
  setImmediate(() => { armed = true; process.on("exit", finish); });
  return home;
};
