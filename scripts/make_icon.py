from PIL import Image, ImageDraw
from pathlib import Path

src = Path(r"D:\TOOLS\romm-translator\generated-1789150714360.png")
assets = Path(r"D:\TOOLS\romm-translator\assets")
assets.mkdir(exist_ok=True)

im = Image.open(src).convert("RGBA")
w, h = im.size

# Cover bottom-right AI watermark with sampled dark background
wm_w, wm_h = int(w * 0.22), int(h * 0.08)
x0, y0 = w - wm_w - 8, h - wm_h - 8
sample = im.getpixel((w - 40, h - 120))
fill = (sample[0], sample[1], sample[2], 255)
draw = ImageDraw.Draw(im)
draw.rectangle([x0, y0, w, h], fill=fill)

png_path = assets / "icon-1024.png"
im.save(png_path, "PNG")

sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
ico_path = assets / "icon.ico"
im.save(ico_path, format="ICO", sizes=sizes)

preview = im.resize((512, 512), Image.LANCZOS)
preview.save(assets / "icon-512.png", "PNG")

print("saved", png_path)
print("saved", ico_path)
print("saved", assets / "icon-512.png")
