---
name: ppt-design
description: 用 pptxgenjs 生成高质量 PPT 的设计规范与代码模板（16:9、配色、版式）
---

# PPT 设计技能

用 pptxgenjs 生成 .pptx 时遵循以下规范。

## 基本设置

```js
const pptxgen = require("pptxgenjs");
const pptx = new pptxgen();
pptx.defineLayout({ name: "WIDE", width: 13.33, height: 7.5 });
pptx.layout = "WIDE"; // 16:9
```

## 配色方案（选一套，全篇统一）

- 商务蓝：主色 1F4E79，强调 2E75B6，正文 333333，背景 FFFFFF
- 科技深色：背景 0F172A，主色 38BDF8，正文 E2E8F0
- 活力橙：主色 C0504D，强调 F79646，正文 404040

## 版式规范

1. **封面页**：大标题（40pt bold）+ 副标题（18pt）+ 日期，标题垂直居中偏上
2. **目录页**：列出 3-6 个章节
3. **内容页**：页标题（24-28pt bold，顶部）+ 正文要点（14-16pt，bullet，每页不超过 6 条）
4. **结尾页**：致谢/总结一句话居中

## 内容页代码模板

```js
const slide = pptx.addSlide();
slide.addText("页标题", { x: 0.6, y: 0.35, w: 12, h: 0.8, fontSize: 26, bold: true, color: "1F4E79" });
slide.addShape(pptx.ShapeType.line, { x: 0.6, y: 1.15, w: 12.1, h: 0, line: { color: "2E75B6", width: 2 } });
slide.addText([
  { text: "要点一", options: { bullet: true, breakLine: true } },
  { text: "要点二", options: { bullet: true, breakLine: true } },
], { x: 0.8, y: 1.5, w: 11.7, h: 5, fontSize: 15, color: "333333", lineSpacing: 28 });
```

## 注意

- 中文字体设 `fontFace: "Microsoft YaHei"`
- 每页信息量适中，宁可多分几页
- 最后 `await pptx.writeFile({ fileName: "xxx.pptx" });`（在 async 函数里）
