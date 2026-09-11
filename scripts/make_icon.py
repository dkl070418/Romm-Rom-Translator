from PIL import Image
from pathlib import Path

src = Path(r"D:\TOOLS\romm-translator\generated-1789151157919.png")
assets = Path(r"D:\TOOLS\romm-translator\assets")
assets.mkdir(exist_ok=True)

im = Image.open(src).convert("RGBA")
w, h = im.size

# Broader watermark coverage
wm_x0 = int(w * 0.72)
wm_y0 = int(h * 0.84)

bg = im.getpixel((80, h // 2))
if bg[0] > 80:
    bg = (7, 13, 27, 255)

for y in range(wm_y0, h):
    for x in range(wm_x0, w):
        r, g, b, a = im.getpixel((x, y))
        # cream arrows — none should be in this corner
        if r > 200 and g > 180 and b > 140:
            continue
        # pure paper white (outside) keep
        if r > 240 and g > 240 and b > 240:
            continue
        im.putpixel((x, y), (bg[0], bg[1], bg[2], 255))

# Soften hard edge: crop bottom+right strip, restore 1024 square
im = im.crop((0, 0, int(w * 0.97), int(h * 0.97))).resize((1024, 1024), Image.LANCZOS)

im.save(assets / "icon-1024.png", "PNG")
sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
im.save(assets / "icon.ico", format="ICO", sizes=sizes)
im.resize((512, 512), Image.LANCZOS).save(assets / "icon-512.png", "PNG")
print("done")
