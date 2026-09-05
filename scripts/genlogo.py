#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 build/icon.svg —— OpenWorkBuddy 的应用图标（猫）。

外框是真·超椭圆（superellipse，n=5），不是 CSS 那种 border-radius 圆角矩形。
macOS 图标那个「连续圆角」就是这个形状，差别在拐角处：圆角矩形是直线段突然接上一段
正圆弧，曲率是跳变的，放大看能看出接缝；超椭圆的曲率连续，所以看着"顺"。
SVG 没有超椭圆图元，这里用自适应折线逼近——只在曲率大的地方加点，
实测最大偏差会打印出来（1024 画布上 ~0.1px，小于一个像素，肉眼和渲染器都看不出）。

跑法：
    python3 scripts/genlogo.py     # 只重写 build/icon.svg
    npm run icons                  # 再把 svg 烤成 icon.png / .icns / .ico

改几何请改下面那几个常量，不要直接手改 build/icon.svg —— 它是产物，下次一跑就没了。
"""
import io
import os
import math

def superellipse(cx, cy, a, b, n, t):
    ct, st = math.cos(t), math.sin(t)
    x = cx + a * math.copysign(abs(ct) ** (2.0 / n), ct)
    y = cy + b * math.copysign(abs(st) ** (2.0 / n), st)
    return x, y

def _pt(cx, cy, a, b, n, t):
    return superellipse(cx, cy, a, b, n, t)

def squircle_path(cx, cy, a, b, n, tol=0.15):
    """自适应折线：只在曲率大的地方加点。返回 path 和实测最大偏差"""
    def rec(t0, t1, out, depth=0):
        p0 = _pt(cx, cy, a, b, n, t0); p1 = _pt(cx, cy, a, b, n, t1)
        tm = (t0 + t1) / 2.0
        pm = _pt(cx, cy, a, b, n, tm)
        # 中点到弦的距离
        vx, vy = p1[0] - p0[0], p1[1] - p0[1]
        L = math.hypot(vx, vy)
        dev = abs(vx * (p0[1] - pm[1]) - (p0[0] - pm[0]) * vy) / L if L > 1e-9 else 0.0
        if dev > tol and depth < 18:
            rec(t0, tm, out, depth + 1); rec(tm, t1, out, depth + 1)
        else:
            out.append(p1)
    # 必须按象限分段递归：从 0 直接递归到 2π 的话首尾是同一个点，
    # 弦长趋零会被误判成「已经够平」，整条曲线塌成两个点
    pts = [_pt(cx, cy, a, b, n, 0.0)]
    for q in range(8):
        rec(2 * math.pi * q / 8.0, 2 * math.pi * (q + 1) / 8.0, pts)
    # 实测：在每条边上密采，量真实曲线到折线的最大距离
    maxdev = 0.0
    for i in range(len(pts) - 1):
        p0, p1 = pts[i], pts[i + 1]
        vx, vy = p1[0] - p0[0], p1[1] - p0[1]
        L = math.hypot(vx, vy)
        if L < 1e-9: continue
    # 用参数扫一遍整条曲线，对每个真点求到折线的最近距离
    import bisect
    for k in range(4000):
        t = 2 * math.pi * k / 4000.0
        q = _pt(cx, cy, a, b, n, t)
        best = 1e9
        for i in range(len(pts) - 1):
            p0, p1 = pts[i], pts[i + 1]
            vx, vy = p1[0] - p0[0], p1[1] - p0[1]
            L2 = vx * vx + vy * vy
            if L2 < 1e-12: continue
            u = max(0.0, min(1.0, ((q[0] - p0[0]) * vx + (q[1] - p0[1]) * vy) / L2))
            dx, dy = p0[0] + vx * u - q[0], p0[1] + vy * u - q[1]
            best = min(best, math.hypot(dx, dy))
        maxdev = max(maxdev, best)
    d = "M%.1f %.1f" % pts[0] + "".join(" L%.1f %.1f" % p for p in pts[1:]) + " Z"
    return d, maxdev, len(pts)

def round_poly(points, r):
    """多边形圆角：每个顶点用二次贝塞尔切掉"""
    m = len(points)
    d = ""
    for i in range(m):
        p0 = points[(i - 1) % m]; p1 = points[i]; p2 = points[(i + 1) % m]
        def toward(a_, b_, dist):
            vx, vy = b_[0] - a_[0], b_[1] - a_[1]
            L = math.hypot(vx, vy)
            k = min(dist, L / 2) / L
            return (a_[0] + vx * k, a_[1] + vy * k)
        s = toward(p1, p0, r); e = toward(p1, p2, r)
        d += ("M%.1f %.1f" % s) if i == 0 else (" L%.1f %.1f" % s)
        d += " Q%.1f %.1f %.1f %.1f" % (p1[0], p1[1], e[0], e[1])
    return d + " Z"

sq, err, npt = squircle_path(512, 512, 416, 416, 5.0)
print("squircle 实测最大偏差 %.3f px，%d 个点（1024 画布）" % (err, npt))

# ---- 猫头几何 ----
# 第一版评审结论（256/128/64/32/16 逐档看）：脸偏小偏上，下巴到边框空一大块；
# 右上那颗星跟右耳抢同一个角，64px 以下退化成一粒白点，像脏东西；嘴太细，比五官先糊。
# 这一版：头放大并下移把下半部填满、星点整颗去掉、耳朵加大加实、嘴加粗。
HEAD = (512, 544, 288, 258, 2.55)          # cx cy a b n：n=2.55 介于椭圆和圆角矩形，出「腮帮子」
head, herr, hnpt = squircle_path(*HEAD)
print("头部实测最大偏差 %.3f px，%d 个点" % (herr, hnpt))

# 耳朵三个角都必须落在头的轮廓里侧，否则会看出一条接缝（第一版右耳就有点）
ear_l = [(292, 206), (240, 440), (458, 296)]
ear_r = [(1024 - 292, 206), (1024 - 240, 440), (1024 - 458, 296)]
def inner(pts, k=0.46):
    cx = sum(p[0] for p in pts) / 3.0; cy = sum(p[1] for p in pts) / 3.0
    return [(cx + (x - cx) * k, cy + (y - cy) * k) for x, y in pts]

EYE_Y, EYE_DX, EYE_R = 512, 112, 60
NOSE = [(512, 630), (474, 584), (550, 584)]

def inside_head(pt):
    """点在头的超椭圆内侧？|dx/a|^n + |dy/b|^n <= 1"""
    cx, cy, a, b, n = HEAD
    return (abs(pt[0] - cx) / a) ** n + (abs(pt[1] - cy) / b) ** n <= 1.0
for e in ear_l + ear_r:
    if e[1] == 206: continue                            # 耳尖本来就该在头外面
    assert inside_head(e), "耳朵这个角戳到头外面了，会看出接缝：%s" % (e,)
print("耳朵下缘两角都在头轮廓内侧 ✓")

parts = []
parts.append('  <path d="%s" fill="url(#g)"/>' % sq)
parts.append('  <path d="%s" fill="url(#sheen)"/>' % sq)
parts.append('  <g>')
parts.append('    <path d="%s" fill="#fff"/>' % round_poly(ear_l, 48))
parts.append('    <path d="%s" fill="#fff"/>' % round_poly(ear_r, 48))
parts.append('    <path d="%s" fill="#ff9ec4"/>' % round_poly(inner(ear_l), 24))
parts.append('    <path d="%s" fill="#ff9ec4"/>' % round_poly(inner(ear_r), 24))
parts.append('    <path d="%s" fill="#fff"/>' % head)
# 眼睛：大圆 + 高光，小尺寸下退化成两个深色点，仍然认得出
for sgn in (-1, 1):
    ex = 512 + sgn * EYE_DX
    parts.append('    <circle cx="%d" cy="%d" r="%d" fill="#2c2c3d"/>' % (ex, EYE_Y, EYE_R))
    parts.append('    <circle cx="%.0f" cy="%.0f" r="22" fill="#fff"/>' % (ex - 20, EYE_Y - 23))
    parts.append('    <circle cx="%.0f" cy="%.0f" r="9" fill="#fff" opacity=".7"/>' % (ex + 19, EYE_Y + 21))
parts.append('    <path d="%s" fill="#ff8fb8"/>' % round_poly(NOSE, 16))
# 嘴：ω 形，一笔画到底。写成「左半 + 右半」两条子路径的话，两段圆头描边在中点叠一块，
# 实测中间鼓成 22px（描边本身才 10px），远看是嘴中间挂了个黑疙瘩。
# 一笔画也只解决一半：中间是个尖角，圆角连接照样要把那个楔形填实（实测 23px vs 两臂 14px）。
# 所以顶点不做成尖的——中间留 8px 的水平小段，竖向厚度就等于描边宽度本身，跟两臂一样粗。
MOUTH = ("M444 648 C458 686 492 686 508 652 L516 652 C532 686 566 686 580 648")
parts.append('    <path d="%s" fill="none" stroke="#2c2c3d" stroke-width="28" '
             'stroke-linecap="round" stroke-linejoin="round"/>' % MOUTH)
parts.append('  </g>')

svg = '''<!-- OpenWorkBuddy 应用图标：猫猫。
     外框是真·超椭圆（superellipse n=5），不是普通圆角矩形——macOS 图标那个「连续圆角」，
     由 scripts/genlogo.py 自适应细分生成，实测最大偏差 %.3f px（1024 画布）。
     只有四组颜色：主色渐变 / 白 / 眼睛深灰 / 鼻子粉。
     两件东西是逐档看过之后去掉的：旧版的笔记本 16px 下糊成一团；
     后来加的那颗「AI」星点跟右耳抢同一个角，64px 以下退化成一粒白点，像脏东西。
     这个文件是产物，别手改：改几何去 scripts/genlogo.py，跑 python3 scripts/genlogo.py
     再跑 npm run icons 重新生成 icon.icns / icon.ico / icon.png。 -->
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#8a8cff"/>
      <stop offset="1" stop-color="#6d28d9"/>
    </linearGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".16"/>
      <stop offset=".55" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
  </defs>
%s
</svg>
''' % (err, "\n".join(parts))
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "build", "icon.svg")
io.open(os.path.normpath(OUT), "w", encoding="utf-8").write(svg)
print("写入 build/icon.svg  %d 字节" % len(svg))

# ---- 界面里的小猫标（聊天头像那颗） ----
# 跟图标同一套几何，只是把外面那块超椭圆底去掉——头像容器自己就是个带渐变的圆，
# 再套一层底会出现「圆里套方」。手改 index.html 会跟图标走散，所以这里直接把
# <symbol id="wb-cat"> 那段重写回 public/index.html 的两行标记之间。
#
# viewBox 收到猫的实际外接框：1024 画布上猫只占中间那点地方，照原样放进 22px 的
# 头像里，脸就剩十来个像素了。四边留 16px 余量再取正方形，保证不同容器里不变形。
mark_x0, mark_x1 = min(p[0] for p in ear_l), max(p[0] for p in ear_r)
mark_y0 = min(p[1] for p in ear_l + ear_r)
mark_y1 = HEAD[1] + HEAD[3]                       # 头的下缘
pad = 16
mcx, mcy = (mark_x0 + mark_x1) / 2.0, (mark_y0 + mark_y1) / 2.0
half = max(mark_x1 - mark_x0, mark_y1 - mark_y0) / 2.0 + pad
mark_vb = "%.0f %.0f %.0f %.0f" % (mcx - half, mcy - half, half * 2, half * 2)
print("小猫标 viewBox = %s" % mark_vb)

# parts 里前两条是超椭圆底和高光，第三条起才是猫；去掉底，缩进也顺手拉平
mark_body = "\n".join(l[2:] for l in parts[2:])
symbol = ('<symbol id="wb-cat" viewBox="%s">\n%s\n</symbol>' % (mark_vb, mark_body))

IDX = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "index.html"))
BEG = "<!-- wb-cat:begin 由 scripts/genlogo.py 生成，别手改 -->"
END = "<!-- wb-cat:end -->"
html = io.open(IDX, encoding="utf-8").read()
if BEG in html and END in html:
    i, j = html.index(BEG), html.index(END)
    html = html[:i] + BEG + "\n" + symbol + "\n" + html[j:]
    io.open(IDX, "w", encoding="utf-8").write(html)
    print("已把 <symbol id=\"wb-cat\"> 写回 public/index.html（%d 字节）" % len(symbol))
else:
    raise SystemExit("public/index.html 里找不到 wb-cat 的标记行，先把这两行加到 #wb-sprite 里：\n  %s\n  %s" % (BEG, END))
