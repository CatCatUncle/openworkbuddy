#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Markdown → 微信公众号兼容 HTML（全内联样式）。

微信编辑器的三条硬约束，本脚本就是为绕开它们而存在：
  1) 不认 <style> 标签和 class，一律要写成 style="..." 内联
  2) 会吃掉 margin 折叠之外的很多布局，段落间距要靠 margin 显式给
  3) 不支持 CSS 变量、伪元素、flex/grid 的复杂用法（用 table/div 老写法最稳）

用法：
  python3 format.py --input 文章.md --theme newspaper --out 文章.html
  python3 format.py --input 文章.md --theme minimal --title "标题" --author "开发者猫叔"
  python3 format.py --list-themes

零第三方依赖（只用标准库），刻意手写了 Markdown 子集解析，避免装包失败。
"""

import argparse
import html
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
THEME_DIR = os.path.join(os.path.dirname(HERE), "themes")


# ---------- 主题 ----------
def load_theme(name):
    path = os.path.join(THEME_DIR, name + ".json")
    if not os.path.exists(path):
        avail = ", ".join(list_themes())
        raise SystemExit("没有这个主题：%s\n可用主题：%s" % (name, avail))
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def list_themes():
    if not os.path.isdir(THEME_DIR):
        return []
    return sorted(f[:-5] for f in os.listdir(THEME_DIR) if f.endswith(".json"))


def st(d):
    """dict → style 字符串。值里的双引号要换成单引号，否则会把 style="..." 属性提前截断
    （字体栈 "PingFang SC" 这种最容易踩）。"""
    return "; ".join("%s: %s" % (k, str(v).replace('"', "'")) for k, v in d.items() if v)


# ---------- 行内标记 ----------
def inline(text, t):
    """行内 Markdown → HTML。顺序有讲究：先抠出代码，免得代码里的 * _ 被当成强调。"""
    holes = []

    def stash(m):
        holes.append(m.group(1))
        return "\x00%d\x00" % (len(holes) - 1)

    text = re.sub(r"`([^`]+)`", stash, text)
    text = html.escape(text, quote=False)

    # 图片要在链接前面处理，否则 ![]() 会被链接规则吃掉
    text = re.sub(
        r"!\[([^\]]*)\]\(([^)\s]+)[^)]*\)",
        lambda m: '<img src="%s" alt="%s" style="%s">'
        % (m.group(2), m.group(1), st(t["image"])),
        text,
    )
    text = re.sub(
        r"\[([^\]]+)\]\(([^)\s]+)[^)]*\)",
        lambda m: '<a href="%s" style="%s">%s</a>' % (m.group(2), st(t["link"]), m.group(1)),
        text,
    )
    text = re.sub(r"\*\*([^*]+)\*\*", lambda m: '<strong style="%s">%s</strong>' % (st(t["strong"]), m.group(1)), text)
    text = re.sub(r"(?<!\*)\*([^*\n]+)\*(?!\*)", lambda m: '<em style="%s">%s</em>' % (st(t["em"]), m.group(1)), text)
    text = re.sub(r"~~([^~]+)~~", r'<span style="text-decoration: line-through; opacity: .6">\1</span>', text)

    def pop(m):
        code = html.escape(holes[int(m.group(1))], quote=False)
        return '<code style="%s">%s</code>' % (st(t["code_inline"]), code)

    return re.sub(r"\x00(\d+)\x00", pop, text)


# ---------- 块级解析 ----------
def convert(md, t):
    lines = md.replace("\r\n", "\n").split("\n")
    out, i, n = [], 0, len(lines)

    while i < n:
        line = lines[i]

        # 代码块
        if line.startswith("```"):
            i += 1
            buf = []
            while i < n and not lines[i].startswith("```"):
                buf.append(lines[i])
                i += 1
            i += 1
            code = html.escape("\n".join(buf), quote=False)
            out.append(
                '<section style="%s"><pre style="%s"><code>%s</code></pre></section>'
                % (st(t["pre_wrap"]), st(t["pre"]), code)
            )
            continue

        # 分割线
        if re.match(r"^\s*([-*_])\s*\1\s*\1[\s\-*_]*$", line):
            out.append('<hr style="%s">' % st(t["hr"]))
            i += 1
            continue

        # 标题
        m = re.match(r"^(#{1,4})\s+(.*)$", line)
        if m:
            lvl = len(m.group(1))
            key = "h%d" % min(lvl, 4)
            out.append("<h%d style=\"%s\">%s</h%d>" % (lvl, st(t[key]), inline(m.group(2).strip(), t), lvl))
            i += 1
            continue

        # 引用（连续行合并成一段）
        if line.startswith(">"):
            buf = []
            while i < n and lines[i].startswith(">"):
                buf.append(lines[i].lstrip(">").strip())
                i += 1
            body = inline(" ".join(x for x in buf if x), t)
            out.append('<blockquote style="%s">%s</blockquote>' % (st(t["quote"]), body))
            continue

        # 表格（| a | b | + 分隔行）
        if line.strip().startswith("|") and i + 1 < n and re.match(r"^\s*\|[\s:\-|]+\|\s*$", lines[i + 1]):
            head = [c.strip() for c in line.strip().strip("|").split("|")]
            i += 2
            rows = []
            while i < n and lines[i].strip().startswith("|"):
                rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")])
                i += 1
            th = "".join('<th style="%s">%s</th>' % (st(t["th"]), inline(c, t)) for c in head)
            trs = "".join(
                "<tr>" + "".join('<td style="%s">%s</td>' % (st(t["td"]), inline(c, t)) for c in r) + "</tr>"
                for r in rows
            )
            out.append(
                '<section style="overflow-x: auto"><table style="%s"><thead><tr>%s</tr></thead><tbody>%s</tbody></table></section>'
                % (st(t["table"]), th, trs)
            )
            continue

        # 列表（有序/无序，不做嵌套——公众号里嵌套列表本来就丑）
        m = re.match(r"^\s*([-*+]|\d+\.)\s+(.*)$", line)
        if m:
            ordered = bool(re.match(r"^\d+\.$", m.group(1)))
            items = []
            while i < n:
                mm = re.match(r"^\s*([-*+]|\d+\.)\s+(.*)$", lines[i])
                if not mm:
                    break
                items.append(mm.group(2).strip())
                i += 1
            tag = "ol" if ordered else "ul"
            lis = "".join('<li style="%s">%s</li>' % (st(t["li"]), inline(x, t)) for x in items)
            out.append('<%s style="%s">%s</%s>' % (tag, st(t["list"]), lis, tag))
            continue

        # 空行
        if not line.strip():
            i += 1
            continue

        # 独占一行的图片：不套 <p>，居中单独成块
        m = re.match(r"^\s*!\[([^\]]*)\]\(([^)\s]+)[^)]*\)\s*$", line)
        if m:
            cap = m.group(1).strip()
            fig = '<section style="%s"><img src="%s" alt="%s" style="%s">' % (
                st(t["figure"]),
                m.group(2),
                cap,
                st(t["image"]),
            )
            if cap:
                fig += '<p style="%s">%s</p>' % (st(t["caption"]), html.escape(cap, quote=False))
            out.append(fig + "</section>")
            i += 1
            continue

        # 普通段落：吃到空行为止
        buf = []
        while i < n and lines[i].strip() and not re.match(r"^(#{1,4}\s|>|```|\s*([-*+]|\d+\.)\s|\s*\|)", lines[i]):
            buf.append(lines[i].strip())
            i += 1
        if buf:
            out.append('<p style="%s">%s</p>' % (st(t["p"]), inline(" ".join(buf), t)))

    return "\n".join(out)


def wrap(body, t, title=None, author=None):
    parts = []
    if title:
        parts.append('<h1 style="%s">%s</h1>' % (st(t["h1"]), html.escape(title, quote=False)))
    if author:
        parts.append('<p style="%s">%s</p>' % (st(t["byline"]), html.escape(author, quote=False)))
    parts.append(body)
    if t.get("footer_note"):
        parts.append('<p style="%s">%s</p>' % (st(t["caption"]), t["footer_note"]))
    # 最外层用 section 而不是 div：微信编辑器对 section 的兼容最好
    return '<section style="%s">%s</section>' % (st(t["page"]), "\n".join(parts))


def main():
    ap = argparse.ArgumentParser(description="Markdown → 微信公众号内联样式 HTML")
    ap.add_argument("--input", "-i", help="Markdown 文件路径")
    ap.add_argument("--out", "-o", help="输出 HTML 路径（默认与输入同名 .html）")
    ap.add_argument("--theme", default="newspaper", help="主题名，--list-themes 看全部")
    ap.add_argument("--title", help="文章标题（会作为 H1 排在正文最前）")
    ap.add_argument("--author", help="署名")
    ap.add_argument("--list-themes", action="store_true")
    a = ap.parse_args()

    if a.list_themes:
        for name in list_themes():
            t = load_theme(name)
            print("%-14s %s" % (name, t.get("_desc", "")))
        return
    if not a.input:
        ap.error("要么 --list-themes，要么给 --input")

    t = load_theme(a.theme)
    with open(a.input, "r", encoding="utf-8") as f:
        md = f.read()
    # frontmatter 不进正文，但里面的 title/author 可以拿来用
    fm = re.match(r"^---\n([\s\S]*?)\n---\n", md)
    if fm:
        meta = dict(re.findall(r"^(\w+):\s*(.*)$", fm.group(1), re.M))
        a.title = a.title or meta.get("title")
        a.author = a.author or meta.get("author")
        md = md[fm.end():]

    body = convert(md, t)
    doc = wrap(body, t, a.title, a.author)
    out = a.out or (os.path.splitext(a.input)[0] + ".html")
    with open(out, "w", encoding="utf-8") as f:
        f.write(doc)
    print("已生成：%s（主题 %s，%d 字符）" % (out, a.theme, len(doc)))
    print("用法：浏览器打开 → 全选复制 → 粘进公众号编辑器；或用 publish.py 直接推草稿箱。")


if __name__ == "__main__":
    main()
