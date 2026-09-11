from PIL import Image
from pathlib import Path

src = Path(r"D:\TOOLS\romm-translator\generated-1789150994526.png")
assets = Path(r"D:\TOOLS\romm-translator\assets")
assets.mkdir(exist_ok=True)

im = Image.open(src).convert("RGBA")
w, h = im.size

# Watermark occupies bottom-right corner (outside/on edge of squircle)
wm_x0 = int(w * 0.76)
wm_y0 = int(h * 0.88)

for y in range(wm_y0, h):
    for x in range(wm_x0, w):
        r, g, b, a = im.getpixel((x, y))
        # near-white / watermark gray on paper → pure white
        if r > 200 and g > 200 and b > 200:
            im.putpixel((x, y), (255, 255, 255, 255))
        elif r > 120 and g > 120 and b > 120:
            # light gray watermark strokes → white
            im.putpixel((x, y), (255, 255, 255, 255))
        # teal body: leave alone (or snap slight noise)

im.save(assets / "icon-1024.png", "PNG")
sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
im.save(assets / "icon.ico", format="ICO", sizes=sizes)
im.resize((512, 512), Image.LANCZOS).save(assets / "icon-512.png", "PNG")
print("done")
