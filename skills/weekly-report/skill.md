---
name: weekly-report
description: 撰写团队/个人周报（Word 或 Markdown）的结构规范
---

# 周报撰写技能

## 结构

1. **本周概览**：2-3 句话总结整体进展与亮点
2. **已完成事项**：按项目分组，每条写清「做了什么 + 结果/数据」
3. **进行中事项**：当前进度百分比 + 预计完成时间
4. **风险与问题**：阻塞项、需要协调的资源，没有就写"无"
5. **下周计划**：3-5 条，可衡量

## 生成 Word 版本（docx 库）

```js
const { Document, Packer, Paragraph, HeadingLevel, TextRun } = require("docx");
const fs = require("fs");

const doc = new Document({
  sections: [{
    children: [
      new Paragraph({ text: "团队周报（2026-08-03）", heading: HeadingLevel.TITLE }),
      new Paragraph({ text: "一、本周概览", heading: HeadingLevel.HEADING_1 }),
      new Paragraph({ children: [new TextRun("……")] }),
    ],
  }],
});
Packer.toBuffer(doc).then((buf) => fs.writeFileSync("周报.docx", buf));
```

## 文风

- 用数据说话（完成率、条数、耗时），避免"推进了""对齐了"这类空话
- 每条不超过两行
