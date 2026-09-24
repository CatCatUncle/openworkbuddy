/**
 * 前端（public/ 下的经典 <script>）跨文件用到、tsc 自己看不出来的全局。
 *
 * 只给 test/typecheck.js 的前端那两趟用（主界面 index.html、后台 admin.html），后端不读它：
 * 后端是 CommonJS，谁用谁 require，没有「凭空出现的全局」。
 *
 * 为什么要这份：public/js 下十来个文件共享一个全局作用域，但有几样东西不是 `function x()`
 * 这种 tsc 看得见的顶层声明，而是挂到 window 上的（`root.I18N = api`），或者是运行时才
 * 按需加载的第三方 UMD 包（joint、dagre）。不在这儿声明，每处用到都会报 TS2304「找不到这个名字」，
 * 真正的 TS2304（拼错名字、删了函数还有人在调）就淹在里面了。
 *
 * 往这儿加东西之前先想清楚：加一个名字 = 告诉 tsc「这个名字一定存在」，
 * 以后它真没了（文件删了、改名了），这道闸门也不会再喊。所以只收「确实是挂在全局上」的，
 * 每一条都写明是谁挂的。
 */

/** public/js/i18n.js 顶上 `root.I18N = api`：界面语言切换、按整句翻译文本节点 */
declare var I18N: any;

/** public/svgfig.js 末尾 `root.SvgFig = {...}`：回复里的 SVG 图修补、消毒、转 PNG */
declare var SvgFig: any;

/**
 * 画布用的 JointJS。app-03.js 的 loadScriptOnce("/vendor/joint/joint.min.js") 按需加载，
 * server.js 把 /vendor/joint/ 指到 node_modules/@joint/core/dist——同一个包的 UMD 版，
 * 所以类型直接借它自带的声明。
 */
declare var joint: typeof import("@joint/core");

/** 画布自动排版用的 dagre，加载方式同上（/vendor/dagre/ → node_modules/@dagrejs/dagre/dist） */
declare var dagre: typeof import("@dagrejs/dagre");

/*
 * 下面几条是有意放宽的 DOM 类型。不是为了让哪条报错消失，而是这份前端的写法本来如此：
 * 到处是 `$("#x").value`、`e.target.closest(...)`，querySelector 拿回来的 Element
 * 上没有 value / dataset / focus。不放宽，前端每个文件都是几百条 TS2339，
 * 以后谁想给某个前端文件加 @ts-check，第一眼就被这几百条劝退（审计实测：820 条降到 97 条）。
 */
interface ParentNode {
  querySelector(selectors: string): any;
  querySelectorAll(selectors: string): NodeListOf<any>;
}
interface Document {
  getElementById(elementId: string): any;
  querySelector(selectors: string): any;
}
interface Element {
  querySelector(selectors: string): any;
  closest(selectors: string): any;
}
interface EventTarget {
  [key: string]: any;
}
interface Window {
  [key: string]: any;
}
