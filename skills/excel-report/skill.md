---
name: excel-report
description: 用 exceljs 生成带格式、公式、汇总的 Excel 报表的规范与模板
---

# Excel 报表技能

用 exceljs 生成 .xlsx 时遵循以下规范。

## 基本模板

```js
const ExcelJS = require("exceljs");
const book = new ExcelJS.Workbook();
const ws = book.addWorksheet("数据");

// 表头（加粗、底色、冻结首行）
ws.columns = [
  { header: "日期", key: "date", width: 14 },
  { header: "产品", key: "product", width: 18 },
  { header: "销量", key: "qty", width: 10 },
  { header: "金额", key: "amount", width: 14 },
];
ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E79" } };
ws.views = [{ state: "frozen", ySplit: 1 }];

// 数据行
ws.addRow({ date: "2026-08-01", product: "A", qty: 10, amount: 1234.5 });

// 汇总行用公式，并且把自己算好的结果一起写进 result
const last = ws.rowCount;
const sum = (col) => rows.reduce((a, r) => a + Number(r[col] || 0), 0);
ws.addRow(["合计", "",
  { formula: `SUM(C2:C${last})`, result: sum("qty") },
  { formula: `SUM(D2:D${last})`, result: sum("amount") }]);
ws.getRow(ws.rowCount).font = { bold: true };

// 金额列格式
ws.getColumn("amount").numFmt = "#,##0.00";

await book.xlsx.writeFile("报表.xlsx");
```

## 规范

- 汇总一律用 Excel 公式（SUM/AVERAGE），不要写死数值，用户打开可自动重算
- **公式必须同时给 `result`**：`{ formula: "SUM(B2:B9)", result: 300 }`。exceljs 自己不算公式，
  只给 `formula` 的话文件里那一格没有缓存值——Excel/WPS 打开会自己算出来，但在算之前它是空的：
  网页里的预览、read_document 读回来、发给别人用手机点开看，合计那一列全是空白。
  `result` 只是缓存，公式原样保留，用户改了数据照样重算，一点不冲突
- 数字列右对齐、设置千分位格式；日期列 `numFmt: "yyyy-mm-dd"`
- 多维度数据建多个 worksheet（明细 + 汇总）
- 需要图表时：exceljs 不支持原生图表，改为输出整洁的透视汇总表
