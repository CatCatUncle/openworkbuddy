"use strict";
/**
 * 演示录屏的「马赛克层」：把临时目录、home 目录、用户名、主机名这些本机信息在页面里替换掉。
 * 纯函数，只产出一段要注入页面的 JS 字符串；录屏脚本和测试都从这里拿，保证录出去的和测过的是同一份。
 * 真身已搬到 lib/demo-mask.js：scripts/ 不进安装包，record_web_demo 在装好的应用里也要用它。
 * 这里只转发，record-demo.js 和各处测试的 require 路径都不用动。
 */
module.exports = require("../lib/demo-mask");
