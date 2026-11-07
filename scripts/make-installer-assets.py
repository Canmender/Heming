#!/usr/bin/env python3
"""生成 Windows 安装器品牌素材（可选开发工具，需要 Pillow）。

产物直接提交到 `packages/desktop/build/`（electron-builder 的 buildResources 目录）：
- icon.ico                   应用 / 安装器 / 卸载器图标（多尺寸）
- installerSidebar.bmp       安装向导左侧 164×314
- uninstallerSidebar.bmp     卸载向导左侧 164×314
- installerHeader.bmp        向导页右上 150×57

设计口径与产品一致：单色墨黑底 + 白字「和鸣」，不用渐变/高光，
避免和系统向导控件的观感打架。改素材时重跑本脚本（改完记得重新出包）。
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "packages" / "desktop" / "build"

INK = "#17181a"
WHITE = "#ffffff"
MUTE = "#9a9b9f"
HAIRLINE = "#3a3b40"

FONT_BOLD = "C:/Windows/Fonts/msyhbd.ttc"
FONT_UI = "C:/Windows/Fonts/msyh.ttc"

SS = 4  # 超采样倍数：先画大图再缩小，圆角/文字边缘更干净


def font(path: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(path, size)


def text_w(draw: ImageDraw.ImageDraw, text: str, f: ImageFont.FreeTypeFont) -> int:
    box = draw.textbbox((0, 0), text, font=f)
    return box[2] - box[0]


def make_icon(size: int = 1024) -> Image.Image:
    big = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    radius = int(size * 0.22)
    d.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=INK)
    # 「和」占画布约 62%，视觉重心略上移（汉字字形下缘更重）
    f = font(FONT_BOLD, int(size * 0.62))
    box = d.textbbox((0, 0), "和", font=f)
    w, h = box[2] - box[0], box[3] - box[1]
    d.text(((size - w) / 2 - box[0], (size - h) / 2 - box[1] - size * 0.015), "和", font=f, fill=WHITE)
    return big


def make_sidebar(uninstall: bool) -> Image.Image:
    w, h = 164 * SS, 314 * SS
    img = Image.new("RGB", (w, h), INK)
    d = ImageDraw.Draw(img)
    pad = 20 * SS

    f_brand = font(FONT_BOLD, 30 * SS)
    d.text((pad, 26 * SS), "和鸣", font=f_brand, fill=WHITE)

    f_small = font(FONT_UI, 8 * SS)
    d.text((pad + SS, 66 * SS), "H E M I N G", font=f_small, fill=MUTE)

    if uninstall:
        lines = [("卸载后，你的本机数据", WHITE), ("与设置仍会保留。", WHITE)]
        y = 228 * SS
        for text, color in lines:
            d.text((pad, y), text, font=font(FONT_UI, 10 * SS), fill=color)
            y += 16 * SS
    else:
        d.text((pad, 236 * SS), "本机 AI 工作站", font=font(FONT_UI, 11 * SS), fill=WHITE)
        d.text((pad, 256 * SS), "数据留在设备上", font=font(FONT_UI, 9 * SS), fill=MUTE)

    # 底部细线收口
    d.line((pad, 292 * SS, (164 - 20) * SS, 292 * SS), fill=HAIRLINE, width=max(1, SS))
    return img.resize((164, 314), Image.LANCZOS)


def make_header() -> Image.Image:
    # MUI 页头图固定 150×57，显示在右上；底色必须和向导页头的白色一致
    w, h = 150 * SS, 57 * SS
    img = Image.new("RGB", (w, h), "#ffffff")
    d = ImageDraw.Draw(img)
    f_brand = font(FONT_BOLD, 21 * SS)
    f_small = font(FONT_UI, 6 * SS)
    right = (150 - 8) * SS

    brand = "和鸣"
    bw = text_w(d, brand, f_brand)
    d.text((right - bw, 10 * SS), brand, font=f_brand, fill=INK)

    small = "H E M I N G"
    sw = text_w(d, small, f_small)
    d.text((right - sw, 37 * SS), small, font=f_small, fill=MUTE)

    return img.resize((150, 57), Image.LANCZOS)


def main() -> None:
    BUILD.mkdir(parents=True, exist_ok=True)
    icon = make_icon()
    icon.save(
        BUILD / "icon.ico",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    make_sidebar(uninstall=False).save(BUILD / "installerSidebar.bmp")
    make_sidebar(uninstall=True).save(BUILD / "uninstallerSidebar.bmp")
    make_header().save(BUILD / "installerHeader.bmp")
    print("已生成：")
    for name in ("icon.ico", "installerSidebar.bmp", "uninstallerSidebar.bmp", "installerHeader.bmp"):
        p = BUILD / name
        print(f"  {p}  {p.stat().st_size} bytes")


if __name__ == "__main__":
    main()
