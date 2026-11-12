#!/usr/bin/env python3
"""生成自绘安装器的品牌素材（可选开发工具，需要 Pillow）。

产物提交到 `packages/setup/build/`（electron-builder 的 buildResources 目录）：

- splash.bmp   900×620，portable 外壳在自解压期间显示的静态图
               （NSIS BgImage 只认 BMP/JPG，不能用 PNG，也不支持动画；
               真正的动画在 Electron 窗口里，见 renderer/）
- icon.ico     安装程序自身的图标（多尺寸）

口径与产品一致：纸白、墨黑、发丝线，不用渐变/高光/投影，
避免和系统窗口、任务栏的观感打架。改素材后重跑本脚本并重新出包。
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "packages" / "setup" / "build"

PAPER = "#f5f2ea"
INK = "#161616"
MUTE = "#6e695e"
FAINT = "#8a8578"
LINE = "#d9d3c4"
SEAL = "#a63d2e"

FONT_BOLD = "C:/Windows/Fonts/msyhbd.ttc"
FONT_UI = "C:/Windows/Fonts/msyh.ttc"
FONT_SERIF = "C:/Windows/Fonts/simsun.ttc"

SS = 4  # 超采样倍数：先画大图再缩小，细线和文字边缘更干净

W, H = 900, 620


def font(path: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(path, size)


def text_w(draw: ImageDraw.ImageDraw, text: str, f: ImageFont.FreeTypeFont) -> int:
    box = draw.textbbox((0, 0), text, font=f)
    return box[2] - box[0]


def make_splash() -> Image.Image:
    img = Image.new("RGB", (W * SS, H * SS), PAPER)
    d = ImageDraw.Draw(img)

    # 内嵌一圈发丝线：印刷品式的「纸边」，比纯色背景多一层收口
    inset = 26 * SS
    d.rectangle((inset, inset, W * SS - inset - 1, H * SS - inset - 1), outline=LINE, width=max(1, SS // 2))

    # 左上角：墨色印章方块 + 品牌名 + 角色说明
    seal_x, seal_y, seal = 58 * SS, 54 * SS, 34 * SS
    d.rectangle((seal_x, seal_y, seal_x + seal, seal_y + seal), fill=INK)
    f_seal = font(FONT_BOLD, int(seal * 0.62))
    box = d.textbbox((0, 0), "和", font=f_seal)
    d.text(
        (
            seal_x + (seal - (box[2] - box[0])) / 2 - box[0],
            seal_y + (seal - (box[3] - box[1])) / 2 - box[1],
        ),
        "和",
        font=f_seal,
        fill=PAPER,
    )

    f_brand = font(FONT_BOLD, 22 * SS)
    d.text((seal_x + seal + 14 * SS, seal_y + 1 * SS), "和鸣", font=f_brand, fill=INK)
    f_role = font(FONT_UI, 9 * SS)
    d.text((seal_x + seal + 15 * SS, seal_y + 26 * SS), "安装程序", font=f_role, fill=MUTE)

    # 中央：一句状态文案（自解压只要一两秒，不装作在算进度）
    f_center = font(FONT_SERIF, 26 * SS)
    text = "正在准备安装"
    tw = text_w(d, text, f_center)
    cx, cy = (W * SS - tw) / 2, H * SS / 2 - 26 * SS
    d.text((cx, cy), text, font=f_center, fill=INK)

    # 中心文案下面一条短线，右端一点朱砂
    line_y = int(H * SS / 2 + 18 * SS)
    line_x0, line_x1 = int(W * SS / 2 - 60 * SS), int(W * SS / 2 + 60 * SS)
    d.line((line_x0, line_y, line_x1, line_y), fill=LINE, width=max(1, SS))
    d.rectangle((line_x1 - 3 * SS, line_y - 3 * SS, line_x1, line_y), fill=SEAL)

    # 底部：一行定位语 + 右侧字标
    f_small = font(FONT_UI, 10 * SS)
    d.text((inset + 32 * SS, H * SS - inset - 40 * SS), "本机 AI 工作站 · 数据留在设备上", font=f_small, fill=MUTE)

    f_word = font(FONT_UI, 8 * SS)
    word = "H E M I N G"
    ww = text_w(d, word, f_word)
    d.text((W * SS - inset - 32 * SS - ww, H * SS - inset - 38 * SS), word, font=f_word, fill=FAINT)

    return img.resize((W, H), Image.LANCZOS)


def make_icon(size: int = 1024) -> Image.Image:
    big = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    radius = int(size * 0.22)
    d.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=INK)
    f = font(FONT_BOLD, int(size * 0.62))
    box = d.textbbox((0, 0), "和", font=f)
    w, h = box[2] - box[0], box[3] - box[1]
    d.text(((size - w) / 2 - box[0], (size - h) / 2 - box[1] - size * 0.015), "和", font=f, fill="#ffffff")
    return big


def main() -> None:
    BUILD.mkdir(parents=True, exist_ok=True)
    splash = make_splash()
    splash.save(BUILD / "splash.bmp")
    make_icon().save(
        BUILD / "icon.ico",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print("已生成：")
    for name in ("splash.bmp", "icon.ico"):
        p = BUILD / name
        print(f"  {p}  {p.stat().st_size} bytes")


if __name__ == "__main__":
    main()
