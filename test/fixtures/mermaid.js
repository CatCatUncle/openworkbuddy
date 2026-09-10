"use strict";
/**
 * mermaid 语法纠错用的样本库。
 *
 * `bad` 里这七张图，形状是从真实失败里扒出来的——本机 176 段会话里 gen_diagram 调了 37 次挂了
 * 7 次（18.9%），七次全是 mermaid 语法报错，且全落在四类纯机械的写法错误上：标签开 `["` 收 `")`、
 * subgraph 标题带括号/冒号没加引号、timeline 拿全角「：」当分隔符、gitGraph 中文分支名没加引号。
 * 图里的文字全部换成了跟任何真实任务无关的占位内容，**只保留写错的那个构造本身**——
 * 要测的是语法，不是内容。
 *
 * `ok` 是负向对照：本来就合法、真实渲染成功过的写法。纠错器碰它们一个字节都算 bug
 * （这条真抓到过一次误伤：timeline 正文里的「：」被当成分隔符换掉，九行全被改写）。
 *
 * 两处在用：test/e2e.js 验纠错器改出来的字符串对不对（纯 node，秒级）；
 * test/frontend.js 在真 Chromium 里拿真 mermaid.parse 验「改完到底能不能过」——
 * 只验字符串等于自己跟自己对答案，改坏了照样绿。
 */

/** 七类真实写法错误（内容已全部替换成占位文字） */
const bad = [
  ["标签开[\"收\")_flowchart", [
    'flowchart TD',
    '    A["入口 (总览)"] --> B["分支一<br/>两行说明"]',
    '    A --> C["分支二"]',
    '    B -->|"下一步"| F["汇合点<br/>(待定)")',
    '    C -.->|"旁路"| F',
  ].join("\n")],
  ["subgraph别名里带括号", [
    'flowchart LR',
    '    subgraph 采集[前端]',
    '      A[输入] --> C[整理]',
    '    end',
    '    subgraph 处理[后端 (关键)]',
    '      C --> F[计算]',
    '    end',
  ].join("\n")],
  ["标签开[\"收\")_graph", [
    'graph TD',
    '  A["总盘子"] --> B["甲类(偏高端)")',
    '  A --> C["乙类(偏性价比)")',
    '  B --> B1["厂商甲<br/>占比最高"]',
  ].join("\n")],
  ["timeline用全角冒号当分隔符", [
    'timeline',
    '    title 一条时间线',
    '    2015-04： 立项',
    '    2024： 第一版上线',
    '    2025-07-08 05:45： 触发过一次故障',
  ].join("\n")],
  ["收尾括号写进了引号里", [
    'graph LR',
    '    N["结论<br/>三条同时成立"] --> R["① 会重启<br/>(评估加固之后)]"',
    '    N --> S["② 会分流"]',
    '    R --> O["合并"]',
    '    S --> O',
  ].join("\n")],
  ["gitGraph中文分支名没加引号", [
    'gitGraph',
    '    commit id: "起点"',
    '    branch 冷启动',
    '    checkout 冷启动',
    '    commit id: "第一步"',
    '    checkout main',
  ].join("\n")],
  ["subgraph标题带冒号和括号", [
    'graph TD',
    '  subgraph 上游: 输入侧',
    '    A1[数据源甲]',
    '  end',
    '  subgraph 下游: 输出侧',
    '    B1[看板]',
    '  end',
    '  subgraph 同类玩家(都在做,已有投入)',
    '    C1[玩家甲]',
    '  end',
    '  A1 --> B1',
    '  C1 --> B1',
  ].join("\n")],
];

/** 负向对照：合法写法，纠错器必须一个字节都不动 */
const ok = [
  ["对照_各种括号形状", [
    'flowchart TD',
    '    A["开始 (入口)"] --> B{"判断?"}',
    '    B -->|"是"| C[["子流程"]]',
    '    B -->|"否"| D[("数据库")]',
    '    C --> E((("终点")))',
    '    D --> E',
  ].join("\n")],
  ["对照_init指令块和方括号正文", [
    '%%{init: {"theme": "base"}}%%',
    'flowchart TD',
    '    A["数组 arr[0] 取值"] --> B["映射 map{k}"]',
  ].join("\n")],
  ["对照_subgraph无特殊字符", [
    'flowchart LR',
    '    subgraph 采集端[手机端]',
    '      A[测距] --> C[深度图]',
    '    end',
    '    subgraph 输出',
    '      C --> H[模型]',
    '    end',
  ].join("\n")],
  ["对照_timeline已用半角冒号", [
    'timeline',
    '    title 一条行程',
    '    第一天',
    '        : 上午：出发',
    '        : 下午：抵达',
    '    第二天',
    '        : 全天：休整',
  ].join("\n")],
  ["对照_gitGraph英文分支名", [
    'gitGraph',
    '    commit id: "起点"',
    '    branch feature/x',
    '    checkout feature/x',
    '    commit id: "改动"',
    '    checkout main',
  ].join("\n")],
];

module.exports = { bad, ok };
