---
name: wechat-article
description: 微信公众号推文——写稿、排版成公众号兼容 HTML、上传封面并推进草稿箱
---

# 微信公众号推文技能

## 适用场景
写公众号文章、把已有 Markdown 排版成公众号样式、把成稿推进草稿箱等人工确认后群发。

## 这个技能解决的核心问题
微信编辑器有三条硬约束，直接贴 Markdown 或普通 HTML 一定会散架：

1. **不认 `<style>` 标签和 class**，样式必须写成 `style="..."` 内联在每个标签上
2. **段落间距要显式给 margin**，否则粘进去挤成一坨
3. **不支持 CSS 变量、伪元素、复杂 flex/grid**，老写法最稳

`scripts/format.py` 就是干这件事的，不要自己手写内联样式 HTML。

## 三步流程

### 第 1 步：写稿（Markdown）

先把内容写成 `.md` 文件放进工作目录，带 frontmatter：

```markdown
---
title: 标题党一点但别骗人
author: 开发者猫叔
---

## 小标题

正文……
```

写稿要点（公众号和普通文章不一样的地方）：
- **前 3 行决定生死**：手机上只露出标题 + 前两行，必须在这里把「这篇讲什么、跟你有什么关系」说完
- **一段不超过 3 行**，手机屏窄，长段落直接劝退；多用空行
- **小标题每 300-500 字来一个**，让人能扫读
- 结论前置，别学论文先铺垫五百字
- 少用形容词，多写具体的事、具体的数字、具体的截图
- 涉及事实、数据、人名、时间的，`web_search` 查证过再写，**不许编**

### 第 2 步：排版

```bash
python3 skills/wechat-article/scripts/format.py \
  --input 文章.md --theme newspaper --out 文章.html
```

选主题（`--list-themes` 看全部）：

| 主题 | 长相 | 用在哪 |
|---|---|---|
| `newspaper` | 报刊衬线、暗红标题线 | 长文、深度稿、观点文 |
| `minimal` | 极简黑白 | 拿不准就用这个，不会出错 |
| `tech` | 科技深蓝、深色代码块 | 产品/技术/AI |
| `warm` | 暖调琥珀 | 生活、随笔、带货 |

排完 `read_file` 读回来自查：标签闭合、没有截断、`style="` 里没有多余的双引号。
想让用户看长相就用**预览**打开这个 HTML（`html-page` 技能里的「本地部署预览」也能用）。

**手动发的话到这步就够了**：浏览器打开 HTML → 全选复制 → 粘进公众号编辑器，样式会带过去。

### 第 3 步：推草稿箱（可选，需要凭据）

```bash
# 先验一下凭据和出口 IP，别直接推
python3 skills/wechat-article/scripts/publish.py --check

python3 skills/wechat-article/scripts/publish.py \
  --html 文章.html --title "标题" --cover 封面.jpg --author "开发者猫叔"
```

- 凭据：环境变量 `WECHAT_APPID` / `WECHAT_SECRET`，或 `~/.openworkbuddy/wechat.json`
  （`{"appid": "...", "secret": "..."}`，**别提交进仓库**）
- **脚本只推草稿，永远不群发**。发布是用户在后台自己点的，我们不替他按下不可逆的按钮。
- 正文里的图片必须先传成公众号自己的域名，外链图会被吞掉：
  `python3 scripts/publish.py --upload-image 图.png` 拿到 URL 再写进 Markdown。
- 封面建议 900x383（大图）或 1:1，jpg/png，小于 10MB。

## 已知的坑（踩过，写在这儿省得再踩一遍）

### errcode 40164 = IP 白名单（最常见，也最容易误判成"密钥错了"）
公众号后台给 access_token 接口配了 IP 白名单。**家庭宽带是动态 IP，隔几天就变**，
所以昨天还能跑的脚本今天全线 40164。两条出路：

- **A（推荐）走固定 IP 的服务器出网**：
  ```bash
  ssh -fN -D 1080 root@你的固定IP服务器
  export HTTPS_PROXY=socks5h://127.0.0.1:1080 ALL_PROXY=socks5h://127.0.0.1:1080
  ALL_PROXY=socks5h://127.0.0.1:1080 curl -s https://api.ipify.org   # 确认出口 IP 变了
  ```
  注意 `ALL_PROXY` 只有装了 `requests`（`pip install requests[socks]`）才生效，
  脚本没有 requests 时会退回标准库直连，SOCKS 就不走了。
- **B 去后台改白名单**：改完**必须让管理员扫码确认、看到「保存成功」**，
  只点保存不扫码是静默不生效的——这一点后台不会提示你。

### 其他
- `access_token` 有效期 7200 秒且日调用次数有限，脚本已经缓存到 `~/.openworkbuddy/wechat_token.json`，
  **别反复重取**，会撞 45009 超频。
- 标题限 64 字，摘要不填公众号会自动截前 54 字。
- 代码块在手机上会横向滚动，长代码尽量截图或精简到 60 字符以内一行。

## 红线
- **不群发**，只推草稿箱，发布权永远在用户手里。
- **不编事实**：数据、时间、人名、引用必须是真查到的；查不到就写「未查到公开信息」。
- **凭据不外泄**：不要把 AppSecret 打印在聊天里、写进成果文件、或提交进仓库。

## 质量标准
- 手机宽度下段落不挤、标题层级清楚、没有横向滚动
- 前 3 行就说清这篇讲什么
- 所有事实性内容都有出处
- 生成的 HTML 粘进公众号编辑器后长相不变形
