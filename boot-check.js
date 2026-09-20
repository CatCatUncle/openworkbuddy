"use strict";
/**
 * 开机前的两道闸门：Node 够不够新、依赖装没装。
 *
 * 这两样是 issue 里「下载之后打不开」最常见的两种死法，而它们默认的报错都不像人话：
 *   - Node 16 起得来、界面也能开，一直要到第一次调模型才炸 `fetch is not defined`。
 *     用户会往网络和 Key 上查，查一整晚也查不到「换个 Node」上面去。
 *   - 从 GitHub 下 ZIP 解压完直接 `node server.js`，报 `Cannot find module 'express'`。
 *     对不写 Node 的人来说这句话等于没说。
 *
 * 所以这个文件是 server.js 和 cli.js 的**第一句 require**，排在 express 那一批前面——
 * 排在后面的话，缺依赖那条永远轮不到它说话。electron-main.js 不自己挂：它是 require 了
 * server.js 才把服务端拉起来的，那一句就带着闸门；而且它会先把 global.__wbBootFail 挂好，
 * 于是闸门走 throwInstead 那条路，原因被画进窗口里，而不是 process.exit(1) 让主进程当场消失
 * ——那样用户看到的是「任务管理器里有进程、屏幕上什么都没有」，正是 issue #1 的样子。
 *
 * 它自己用最老的语法写（var + 字符串拼接，不用 ?. 和 ??）：闸门自己解析不了，等于没装闸门。
 * 有条边界得说清楚：Node 老到连 `?.` 都不认（v13 及以下）时，server.js 这个文件本身
 * 在**解析**阶段就 SyntaxError 了，闸门根本没机会执行。那一段靠 package.json 的 engines
 * 字段（npm install 时就会拦）和 install.sh 的版本检查挡，不归这里管。
 */

var fs = require("fs");
var path = require("path");

/** 跟 install.sh 和 package.json 的 engines 是同一个数：全局 fetch 从 18 才有 */
var MIN_NODE = 18;

/**
 * 纯判据：facts 进，一句人话出（没毛病就是 null）。
 *
 * 拎成纯函数是因为这几句是用户卡在门外时手里唯一的线索，而「门外」这个状态在测试里
 * 造不出来——真把 Node 降到 16 才能跑一次测试，等于这几句永远没人验。
 *
 * @param {{nodeVersion?:string, minMajor?:number, missingDeps?:string[], packaged?:boolean}} facts
 * @returns {null | {code:string, title:string, fix:string}}
 */
/**
 * 缺的包名，最多报三个，后面跟上总数。
 *
 * 只印前三个的时候，一次整体装失败（十三个全没有）和真只少一个包，屏幕上长得一模一样——
 * 而这两种情况该做的事不同：前者是重跑一遍 npm install，后者才是去补那一个。
 */
function nameList(missing) {
  var head = "找不到 " + missing.slice(0, 3).join("、");
  return missing.length > 3 ? head + " 等 " + missing.length + " 个" : head;
}

function bootProblem(facts) {
  facts = facts || {};
  var min = facts.minMajor || MIN_NODE;
  var raw = String(facts.nodeVersion || "").replace(/^v/, "");
  var major = parseInt(raw.split(".")[0], 10);
  // 认不出版本号就放行。把一个能跑的装机拦在门外，比漏掉一个老 Node 更糟：
  // 前者是「本来好好的，升级之后打不开了」，后者至少还能跑到真出错的那一步。
  if (major && major < min) {
    return {
      code: "node-too-old",
      title: "Node 版本太老：这台机器上是 v" + raw + "，OpenWorkBuddy 要 " + min + " 以上。",
      fix: "去 nodejs.org 下 LTS 版覆盖装一遍；macOS 有 Homebrew 的话 `brew install node`；"
        + "用 nvm 的话 `nvm install 20 && nvm use 20`。装完 `node -v` 显示 v" + min + " 以上就行了。",
    };
  }
  var missing = facts.missingDeps || [];
  if (missing.length) {
    // 装机版缺文件跟源码版缺依赖是两码事：那边没有 npm install 这一说，只能重下
    if (facts.packaged) {
      return {
        code: "deps-missing-packaged",
        title: "安装包里少了文件（" + nameList(missing) + "）。",
        fix: "到 GitHub Releases 重新下载最新版覆盖安装。最新版还是这样的话，把这行贴到 issue 里。",
      };
    }
    return {
      code: "deps-missing",
      title: "依赖还没装（" + nameList(missing) + "）。",
      fix: "在项目目录里跑一次 `npm install`，跑完再启动。"
        + "国内网络慢的话：`npm install --registry=https://registry.npmmirror.com`。",
    };
  }
  return null;
}

/**
 * 要查的依赖清单，直接问 package.json 要，不再手写。
 *
 * 手写那份是三个名字（express / @anthropic-ai/sdk / exceljs），实测只有 express 真拦得住启动——
 * 另外两个是懒加载，缺了照样起得来，要到第一次调模型、第一次导表格才炸。这是好事：宁可在门口
 * 说清楚，也别让人用到一半撞一句 Cannot find module。可反过来说，剩下那十个同样是 dependencies、
 * 同样缺了就有功能是坏的，凭什么不查？手写清单的真正毛病是会**漂**：加第 14 个依赖的人不会记得
 * 回来改这儿，而这个文件存在的全部意义就是别让用户拿到一句 Cannot find module。
 *
 * package.json 读不出来（打包路径不对、文件坏了）就退回手写那三个——闸门自己不能因为读不到
 * 清单就把人拦在门外，也不能因此一条都不查。
 */
var FALLBACK_DEPS = ["express", "@anthropic-ai/sdk", "exceljs"];

function readDeps(rootDir) {
  try {
    var pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
    var names = Object.keys(pkg.dependencies || {});
    return names.length ? names : FALLBACK_DEPS;
  } catch (e) {
    return FALLBACK_DEPS;
  }
}

var REQUIRED_DEPS = readDeps(__dirname);

function findMissing(rootDir, names) {
  var missing = [];
  for (var i = 0; i < names.length; i++) {
    // 只看目录在不在，不去 require：require 一个坏包会抛，而这儿是负责报错的地方，自己不能炸
    try {
      if (!fs.existsSync(path.join(rootDir, "node_modules", names[i]))) missing.push(names[i]);
    } catch (e) {}
  }
  return missing;
}

/**
 * 真去查，查出毛病就把话说完再退出 1。
 * 有壳的时候（Electron）不自己 exit：壳那边会把原因画在窗口里，这儿 exit 等于让窗口没机会出现。
 */
function enforce(opt) {
  opt = opt || {};
  var rootDir = opt.rootDir || __dirname;
  var packaged = !!opt.packaged;
  var problem = bootProblem({
    nodeVersion: process.versions.node,
    minMajor: MIN_NODE,
    missingDeps: findMissing(rootDir, readDeps(rootDir)),
    packaged: packaged,
  });
  if (!problem) return null;
  var text = "\nOpenWorkBuddy 起不来：" + problem.title + "\n怎么修：" + problem.fix + "\n\n";
  try { process.stderr.write(text); } catch (e) { console.error(text); }
  if (opt.throwInstead) {
    // 判据原样挂在错误上。壳那边接住之后不必再拿正则去猜这句话是什么意思——
    // 猜的结果是：Node 太老、依赖没装这三种我们**已经查出来**的死法，启动失败页上一律写着
    // 「服务端启动时崩了，把这行贴到 issue 里」，而真正该做的（升 Node / npm install / 重下）
    // 只躺在下面那个红框里。最知道该怎么修的时候，反倒让人去提 issue。
    var err = new Error(problem.title + " " + problem.fix);
    err.bootProblem = problem;
    throw err;
  }
  process.exit(1);
}

module.exports = { bootProblem, nameList, findMissing, readDeps, enforce, MIN_NODE, REQUIRED_DEPS, FALLBACK_DEPS };
