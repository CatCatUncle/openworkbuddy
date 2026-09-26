/**
 * demo 录屏的时长整形：打字和最后停在结果上的那几秒保持原速，只把「等模型干活」那段压进目标时长。
 * 纯函数放这里，record-demo.js 顶部 require("electron")，node 直接测不了。
 * 真身已搬到 lib/demo-timing.js：scripts/ 不进安装包，record_web_demo 在装好的应用里也要用它。
 * 这里只转发，record-demo.js 和 e2e 的 require 路径都不用动。
 */
"use strict";

module.exports = require("../lib/demo-timing");
