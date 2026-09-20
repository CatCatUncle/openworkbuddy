#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 dmg 窗口的背景图（build/background.png + @2x）。

为什么值得画一张图：证书还在申请，现在发出去的包是 ad-hoc 签名的，用户双击必然撞上
「未打开“OpenWorkBuddy”· Apple 无法验证…」那个框，而那个框上只有「完成 / 移到废纸篓」。
README 和 release 正文里都写了怎么放行，但人是在**打开 dmg 的那一秒**决定下一步怎么走的，
不是在网页上。所以把「拖过去」和「被拦了怎么办」直接画在他正看着的这扇窗户上。

electron-builder 的约定：build/ 下有 background.png 就自动用它（dmgUtil.computeBackground），
存在同名 @2x 时用 tiffutil 合成一张双分辨率 tiff（transformBackgroundFileIfNeed），
窗口尺寸再由这张图的 1x 尺寸决定（getImageSizeUsingSips）——所以图多高，窗户就多高。

跑法：python3 scripts/gen-dmg-bg.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

W, H = 540, 420          # 窗口尺寸就是这张图的尺寸
ICON_Y = 178             # 和 electron-builder.config.js 里 contents 的 y 对齐
ICON_X1, ICON_X2 = 140, 400
BAND_Y = 288             # 分隔线：上面讲「装」，下面讲「打开」

# 四色封顶（设计四原则）：底、主文字、次文字、品牌色
BG = (250, 250, 251)
INK = (22, 22, 29)
DIM = (112, 112, 126)
BRAND = (91, 95, 247)

FONT = "/System/Library/Fonts/Hiragino Sans GB.ttc"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def font(size, bold=False):
    # W6 是中黑，W3 是常规；PingFang.ttc PIL 读不了（cannot open resource）
    return ImageFont.truetype(FONT, size, index=2 if bold else 0)


def center(d, y, text, f, fill):
    w = d.textbbox((0, 0), text, font=f)[2]
    d.text(((W - w) / 2, y), text, font=f, fill=fill)


def draw(scale):
    s = lambda v: int(v * scale)
    img = Image.new("RGB", (s(W), s(H)), BG)
    d = ImageDraw.Draw(img)

    class P:  # 画的时候按 1x 的坐标写，统一乘 scale
        pass

    def text_c(y, t, size, fill, bold=False):
        f = ImageFont.truetype(FONT, s(size), index=2 if bold else 0)
        # 按**实际着墨**的左右边居中，不是按排版宽度。textbbox 给的是排版框，
        # 行尾那个「」的字身里自带一段空白也算进去，整行因此往左偏 7px（量出来的）；
        # getmask().getbbox() 给的才是真正落了墨的范围。
        m = f.getmask(t)
        bb = m.getbbox() or (0, 0, 0, 0)
        d.text(((s(W) - (bb[2] - bb[0])) / 2 - bb[0], s(y)), t, font=f, fill=fill)

    # —— 上半：这一步该干什么 ——
    text_c(36, "把左边的图标拖到右边，就装好了", 19, INK, bold=True)
    text_c(66, "Drag OpenWorkBuddy into Applications", 12, DIM)

    # 两个图标之间的箭头：不写字也看得懂往哪拖
    ay = s(ICON_Y)
    x1, x2 = s(ICON_X1 + 78), s(ICON_X2 - 78)
    d.line([(x1, ay), (x2, ay)], fill=DIM, width=max(1, s(2)))
    head = s(9)
    d.polygon([(x2, ay), (x2 - head, ay - head * 0.62), (x2 - head, ay + head * 0.62)], fill=DIM)

    # —— 分隔线：上面讲装，下面讲打开 ——
    d.line([(s(40), s(BAND_Y)), (s(W - 40), s(BAND_Y))], fill=(230, 230, 236), width=max(1, s(1)))

    # —— 下半：第一次打开一定会被拦，以及怎么放行 ——
    # 行距按「就近」分组：问题 + 中文解法 + 同一句的英文，三行贴在一起当一块读（着墨间隔 8px）；
    # 最后那句脚注是另一回事，隔开一倍（16px）。三行等距会读成四件事，十六px 全用则散成四块。
    text_c(BAND_Y + 20, "第一次打开会弹「Apple 无法验证」——这是正常的", 13, INK, bold=True)
    text_c(BAND_Y + 44, "点「完成」→ 系统设置 → 隐私与安全性 → 滚到底 → 点「仍要打开」", 13, BRAND, bold=True)
    text_c(BAND_Y + 64, "Blocked on first launch? System Settings → Privacy & Security → Open Anyway", 10, DIM)
    text_c(BAND_Y + 91, "应用的苹果签名还在申请，批下来之后就没有这一步了", 10, DIM)
    return img


def main():
    out = os.path.join(ROOT, "build")
    for name, scale in (("background.png", 1), ("background@2x.png", 2)):
        p = os.path.join(out, name)
        draw(scale).save(p)
        print("写好", p, Image.open(p).size)


if __name__ == "__main__":
    main()
