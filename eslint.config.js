"use strict";
/**
 * ESLint 配置：只开「报了就一定是 bug」的那十二条。
 *
 *   npm run lint         （= node test/lint.js，只对新增的违规报红）
 *   npx eslint server.js （看某个文件的原始结果）
 *
 * 为什么只开这么几条：
 *   - 这道闸门的价值全靠「红了就得修」。开一条会误报的规则，头一个星期就会被人加进忽略名单，
 *     再过一个月就没人看了。下面每一条都满足：代码能跑、但写出来的意思和实际跑的不一样
 *     （同一个键写两遍后一个悄悄盖掉前一个、typeof 拼错成永远为假、return 后面的代码永远不跑……）。
 *   - 不开 no-undef：public/js 下是经典 <script>，十来个文件共享一个全局作用域，
 *     A 文件定义的函数 B 文件直接调，ESLint 一个文件一个文件看，会报成片的「未定义」。
 *     这件事交给 tsc 的 TS2304（test/typecheck.js），它是把整页的脚本放在一起看的。
 *   - 不开格式类规则：实测对全仓跑一次 Prettier，58 个套件里有 15 个变红——
 *     很多测试按正则读源码，换行、引号一动，正则就切空了。格式统一不值这个险。
 *
 * 忽略的目录：用户数据（workspace/ projects/ data/）、构建产物、依赖、任务_* 临时目录，
 * 以及 .gitignore 里挡掉的那些目录（本机私货：别人 clone 下来没有，本机红了 CI 却是绿的，
 * 这种「只在我这儿红」的闸门没人会信）。
 */
const fs = require("fs");
const path = require("path");

/**
 * .gitignore 里「以 / 结尾」的目录行，翻成 ESLint 的 ignores 写法。
 * 名单从 .gitignore 现读，不在这儿抄一份——抄了就会和真源分叉。
 * 只认目录行：*.log、config.json 这些跟 .js 无关，认了也白认。
 */
function gitignoredDirs() {
  let text = "";
  try { text = fs.readFileSync(path.join(__dirname, ".gitignore"), "utf8"); } catch { return []; }
  const out = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!") || !line.endsWith("/")) continue;
    const dir = line.replace(/^\/+/, "").replace(/\/+$/, "");
    if (!dir) continue;
    // 中间带斜杠的（skills/ppt-master/）只认仓库根下那一处；不带的（node_modules/）哪一层都算
    out.push(dir.includes("/") ? dir + "/**" : "**/" + dir + "/**");
  }
  return out;
}

// 这十二条的共同点：命中即 bug，没有「风格不同」一说。
const RULES = {
  "no-dupe-keys": "error", // 对象字面量里同一个键写两遍，后一个悄悄盖掉前一个
  "no-unreachable": "error", // return / throw 后面的代码永远不会跑
  "no-unsafe-finally": "error", // finally 里 return 会吞掉 try 里抛的错
  "no-func-assign": "error", // 给函数声明重新赋值
  "no-redeclare": "error", // 同一作用域 var / function 声明两次
  "no-self-assign": "error", // a = a
  "no-dupe-else-if": "error", // else if 的条件和前面某一支一模一样，这一支永远进不来
  "no-const-assign": "error", // 给 const 赋值，运行到那一行直接抛
  "valid-typeof": "error", // typeof x === "strnig" 永远为假
  "use-isnan": "error", // x === NaN 永远为假
  "getter-return": "error", // getter 忘了 return
  "no-dupe-class-members": "error", // class 里同名方法写两遍
};

module.exports = [
  {
    ignores: [
      "workspace/**",
      "projects/**",
      "dist/**",
      "build/**",
      "**/node_modules/**",
      "任务_*/**",
      "public/vendor/**",
      // 技能包是装给 agent 在用户工作区里用的素材，不少是第三方的，不归这道闸门管
      "skills/**",
      // VS Code 本地历史插件存的旧副本：一份文件的几十个老版本，查它们只会报过去的错
      ".history/**",
      ...gitignoredDirs(),
    ],
  },
  {
    files: ["**/*.js", "**/*.cjs"],
    languageOptions: { ecmaVersion: "latest", sourceType: "commonjs" },
    // 我们只开了十二条，代码里给别的规则留的 disable 注释是正当的说明，不算「多余」
    linterOptions: { reportUnusedDisableDirectives: "off" },
    rules: RULES,
  },
  {
    files: ["**/*.mjs"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    linterOptions: { reportUnusedDisableDirectives: "off" },
    rules: RULES,
  },
  {
    // 前端是经典 <script>，不是 CommonJS 也不是 ES module：顶层声明就是全局
    files: ["public/**/*.js"],
    languageOptions: { sourceType: "script" },
  },
];
