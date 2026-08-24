---
name: ppt-design
description: 用 pptxgenjs 生成高质量 PPT 的完整规范：16:9 母版、原生可编辑图表、gen_diagram 配图、表格、KPI 页、内容纪律与交付自检。做 PPT 默认用这个；只有用户点名 ppt-master 才走那套模板工作流
---

# PPT 设计技能（pptxgenjs 完整版）

用 run_node + pptxgenjs 生成 .pptx。**先定内容大纲（每页一个论点），再写代码**——上来就写代码的 PPT 必然结构散。

## 内容纪律（比代码更重要）

1. **一页一论点**，页标题直接写结论（写「Q3 获客成本下降 32%」，不写「Q3 数据分析」）。
2. 每页正文 ≤6 条 bullet，每条 ≤20 字。塞不下就拆页，绝不缩字号硬塞。
3. 结构套路：封面 → 目录 → 章节分隔页 → 内容页（每章 2-4 页）→ 数据页（图表）→ 总结/行动页。10-15 页最常用。
4. 数字必须来自工具真拿到的数据，图表里编数字是红线。
5. 有流程/架构/时序要展示时，**先用 gen_diagram 生成 PNG，再 addImage 放进页里**（见下）。

## 基本骨架 + 母版（页码/页脚全局一致）

```js
const pptxgen = require("pptxgenjs");
const pptx = new pptxgen();
pptx.defineLayout({ name: "WIDE", width: 13.33, height: 7.5 });
pptx.layout = "WIDE"; // 16:9

// 母版：统一背景/页脚/页码，内容页全部 addSlide({ masterName: "MAIN" })
pptx.defineSlideMaster({
  title: "MAIN",
  background: { color: "FFFFFF" },
  objects: [
    { rect: { x: 0, y: 7.28, w: "100%", h: 0.22, fill: { color: "1F4E79" } } },
    { text: { text: "公司/项目名", options: { x: 0.6, y: 6.95, w: 4, h: 0.3, fontSize: 9, color: "94A3B8" } } },
  ],
  slideNumber: { x: 12.5, y: 6.95, fontSize: 10, color: "94A3B8" },
});
```

## 配色（选一套全篇统一，pptxgenjs 的色值**不带 #**）

- 商务蓝：主 `1F4E79` 强调 `2E75B6` 正文 `333333` 浅底 `EEF3F9` 背景 `FFFFFF`
- 科技深色：背景 `0F172A` 主 `38BDF8` 正文 `E2E8F0` 浅底 `1E293B`
- 活力橙：主 `C0504D` 强调 `F79646` 正文 `404040` 浅底 `FDF3EC`

一套 PPT 主色+强调色+灰阶，**不超过 4 色**；间距对齐用 0.1 英寸的整数倍。

## 常用版式代码

封面（全幅色块更有气场）：
```js
const cover = pptx.addSlide();
cover.background = { color: "1F4E79" };
cover.addText("主标题一句话", { x: 0.9, y: 2.6, w: 11.5, h: 1.2, fontSize: 40, bold: true, color: "FFFFFF" });
cover.addText("副标题 · 汇报人 · 2026-08", { x: 0.9, y: 3.9, w: 11.5, h: 0.6, fontSize: 16, color: "B8CCE4" });
```

内容页（标题 + 分隔线 + 要点）：
```js
const s = pptx.addSlide({ masterName: "MAIN" });
s.addText("页标题写结论", { x: 0.6, y: 0.35, w: 12, h: 0.8, fontSize: 26, bold: true, color: "1F4E79" });
s.addShape(pptx.ShapeType.line, { x: 0.6, y: 1.15, w: 12.1, h: 0, line: { color: "2E75B6", width: 2 } });
s.addText([
  { text: "要点一（≤20 字）", options: { bullet: true, breakLine: true } },
  { text: "要点二", options: { bullet: true, breakLine: true } },
], { x: 0.8, y: 1.5, w: 11.7, h: 5, fontSize: 15, color: "333333", lineSpacing: 28 });
```

KPI 大数字页（3-4 个横排）：
```js
[["32%", "获客成本降幅"], ["1.8x", "转化提升"], ["¥42万", "季度节省"]].forEach(([num, label], i) => {
  const x = 0.8 + i * 4.1;
  s.addShape(pptx.ShapeType.roundRect, { x, y: 2.2, w: 3.7, h: 2.4, fill: { color: "EEF3F9" }, rectRadius: 0.08 });
  s.addText(num, { x, y: 2.5, w: 3.7, h: 1.1, fontSize: 40, bold: true, color: "1F4E79", align: "center" });
  s.addText(label, { x, y: 3.7, w: 3.7, h: 0.5, fontSize: 13, color: "666666", align: "center" });
});
```

## 数据图表：用原生 addChart（在 PPT 里可编辑，别截图别画表格凑数）

```js
s.addChart(pptx.ChartType.bar, [
  { name: "营收", labels: ["Q1", "Q2", "Q3", "Q4"], values: [120, 180, 240, 310] },
], { x: 0.8, y: 1.6, w: 7.6, h: 4.8, barDir: "col",
     chartColors: ["2E75B6"], showValue: true, dataLabelFontSize: 10,
     catAxisLabelFontSize: 11, valAxisLabelFontSize: 11, showLegend: false });
```
- 柱状 `bar`（barDir:"col" 竖 / "bar" 横）、折线 `line`、饼 `pie`、环 `doughnut`、面积 `area`。
- 多系列对比就给多个 `{ name, labels, values }`，加 `showLegend: true, legendPos: "b"`。
- 图表页右侧留 1/3 放「这张图说明什么」的结论文字，别让图裸奔。

## 流程图 / 架构图 / 时序图：gen_diagram 出 PNG 再贴

```js
// 第一步：先调 gen_diagram 工具（kind: dot/mermaid/echarts…, filename: "arch"）拿到 arch.png
// 第二步：贴进页面。gen_diagram 是 2x 高清导出，w/h 按图的宽高比给，宽度占 8-11 英寸为宜
s.addImage({ path: "arch.png", x: 1.2, y: 1.5, w: 10.9, h: 5.2, sizing: { type: "contain", w: 10.9, h: 5.2 } });
```
**不要**用 pptxgenjs 的 shape 一格格拼流程图——费步数还难看，gen_diagram 一步到位。

## 表格（对比 / 明细）

```js
const rows = [
  [{ text: "维度", options: { bold: true, color: "FFFFFF", fill: { color: "1F4E79" } } },
   { text: "方案 A", options: { bold: true, color: "FFFFFF", fill: { color: "1F4E79" } } },
   { text: "方案 B", options: { bold: true, color: "FFFFFF", fill: { color: "1F4E79" } } }],
  ["成本", "低", "高"],
  ["上线周期", "2 周", "6 周"],
];
s.addTable(rows, { x: 0.8, y: 1.6, w: 11.7, fontSize: 13, color: "333333",
  border: { pt: 0.5, color: "D6E0EB" }, rowH: 0.5, valign: "middle",
  fill: { color: "FFFFFF" }, autoPage: true });
```
行数多时隔行上浅底色 `fill: { color: "F5F8FB" }`；超过 12 行拆页或只放 Top 数据。

## 收尾与自检（必须做）

```js
await pptx.writeFile({ fileName: "汇报.pptx" });
console.log("slides:", pptx.slides.length);
```
- 中文字体统一 `fontFace: "Microsoft YaHei"`（标题正文都要设，不设中文会退成衬线体）。
- `writeFile` 要在 async 函数里 await，脚本末尾打印页数。
- 写完用 list_files 确认 .pptx 真实存在、大小合理（有图的 PPT 通常 >100KB；只有几 KB 说明图没进去）。
- 交付时报：文件名、页数、用了哪套配色、图表数据来源。

## 什么时候不用这套

用户明确点名「ppt-master」「用模板生成」「填充现有 PPT」时，改走 ppt-master 技能（它是带确认门的模板工作流）；其余一律本技能直接交付。
