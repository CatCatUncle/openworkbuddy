---
name: html-page
description: 网页生成——制作单文件精美 HTML 页面（落地页/报告页/展示页/小工具）
---

# 网页生成技能

## 适用场景
网站设计、落地页、在线报告、H5 展示页、小型 Web 工具。

## 规范

1. **单文件交付**：所有 CSS/JS 内联，写成一个 `.html` 文件，双击即用。
2. **视觉基线**：
   - 用 CSS 变量定义配色；圆角 12-16px；卡片阴影 `0 6px 24px rgba(0,0,0,.06)`
   - 字体栈：`"PingFang SC", "Microsoft YaHei", system-ui, sans-serif`
   - 避免"AI 味"：不要紫色渐变大标题+居中三卡片的俗套；根据主题定制配色与排版
3. **结构**：语义化标签（header/main/section/footer），移动端响应式（max-width + flex/grid）。
4. **交互**：原生 JS 实现；不引外部框架（图表可用 ECharts CDN）。

## 质量标准
- 浏览器打开无报错、无横向滚动条
- 手机宽度（375px）下排版正常
- 信息层级清晰，重要内容首屏可见
