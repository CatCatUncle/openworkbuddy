---
name: data-viz
description: 数据可视化——生成交互式图表 HTML 页面或纯 SVG 图表文件
---

# 数据可视化技能

## 适用场景
把数据做成柱状图/折线图/饼图等可视化图表交付。

## 方案选择

1. **交互式图表（首选）**：生成单文件 HTML，内嵌 ECharts CDN：
   ```html
   <script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>
   ```
   写 `图表名.html` 到工作目录，用户双击浏览器打开。断网环境改用方案 2。
2. **纯 SVG（离线可用）**：用 run_node 直接拼 SVG 字符串写 `.svg` 文件，适合嵌入文档。

## ECharts 模板要点

```js
const option = {
  title: { text: "标题", left: "center" },
  tooltip: { trigger: "axis" },
  xAxis: { type: "category", data: [...] },
  yAxis: { type: "value" },
  series: [{ type: "bar", data: [...], itemStyle: { color: "#5b5ff7" } }],
};
```

- 配色统一用：#5b5ff7 #8b5cf6 #22c55e #f59e0b #ef4444
- 数字要格式化（千分位）；坐标轴带单位；图表下方附数据表格

## 质量标准
- 打开即能看，无需装任何东西
- 一图一结论：标题直接写洞察（"Q3 华东区销量领先"而非"销量图"）
