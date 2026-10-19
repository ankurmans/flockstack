"""FlockStack's mark, Stack F: three stacked bars shrinking like a list, the top one lime, reading as an F.
Prints the shapes and the app icon's colors (for components/LogoFlockstack.jsx) and writes the icon files from them.

    python3 scripts/make-logo.py            # print the shapes
    python3 scripts/make-logo.py --write    # also write the icon files (needs rsvg-convert and Pillow)
"""
import subprocess, sys, os

VIEWBOX = "0 0 48 48"
# Stack F: three rounded bars shrinking like a list, the top one lime, so together they read as an F.
# (left x, top y, width, height, tone)
BARS = [(6, 7, 36, 9, "lime"), (6, 20, 26, 9, "ink"), (6, 33, 9, 9, "ink")]
# Night lime. On a light page the lime is #b6d600, which holds up on white; on a dark one, #d4ff3a. The app icon is an
# ink tile in every theme, so it reads on light and dark browser chrome alike.
LIGHT = {"ink": "#0b0b0b", "lime": "#b6d600"}
DARK = {"ink": "#fafafa", "lime": "#d4ff3a"}
TILE = {"background": "#0b0b0b", "ink": "#f2f2f2", "lime": "#d4ff3a"}

def bar(x, y, w, h):
    # A rectangle with fully round ends, as a path so every consumer draws it the same way.
    r = h / 2
    return f"M{x + r:.2f} {y:.2f}H{x + w - r:.2f}A{r:.2f} {r:.2f} 0 0 1 {x + w - r:.2f} {y + h:.2f}H{x + r:.2f}A{r:.2f} {r:.2f} 0 0 1 {x + r:.2f} {y:.2f}Z"

SHAPES = [(bar(x, y, w, h), tone) for x, y, w, h, tone in BARS]

def svg(colors, bg=None, size=None, pad=0, rx=0):
    dims = f' width="{size}" height="{size}"' if size else ""
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{VIEWBOX}"{dims}>']
    if bg: out.append(f'<rect width="48" height="48" rx="{rx}" fill="{bg}"/>')
    scale = 1 - 2 * pad / 48
    out.append(f'<g transform="translate({pad} {pad}) scale({scale:.4f})">' if pad else "<g>")
    for d, tone in SHAPES:
        out.append(f'<path d="{d}" fill="{colors[tone]}"/>')
    out.append("</g></svg>")
    return "".join(out)

def tile(pad, rx):
    return svg(TILE, bg=TILE["background"], pad=pad, rx=rx)

# The browser tab's icon: the ink square on a light tab bar, a light square with ink bars on a dark one. Browsers that
# ignore media queries in SVG icons keep the ink square, as favicon.ico does.
LIGHT_TILE = {"background": "#f2f2f2", "ink": "#0b0b0b", "lime": "#b6d600"}

def adaptive_tile(pad):
    scale = 1 - 2 * pad / 48
    tones = "".join(f".{tone}{{fill:{TILE[tone]}}}" for tone in ("ink", "lime"))
    dark = "".join(f".{tone}{{fill:{LIGHT_TILE[tone]}}}" for tone in ("ink", "lime"))
    style = f".bg{{fill:{TILE['background']}}}{tones}@media (prefers-color-scheme:dark){{.bg{{fill:{LIGHT_TILE['background']}}}{dark}}}"
    paths = "".join(f'<path class="{tone}" d="{d}"/>' for d, tone in SHAPES)
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{VIEWBOX}"><style>{style}</style><rect class="bg" width="48" height="48"/><g transform="translate({pad} {pad}) scale({scale:.4f})">{paths}</g></svg>'

if __name__ == "__main__":
    print('export const LOGO_VIEWBOX = "%s";' % VIEWBOX)
    print("export const LOGO_SHAPES = [")
    for d, tone in SHAPES:
        print(f'\t{{ d: "{d}", tone: "{tone}" }},')
    print("];")
    print("export const LOGO_TILE = { %s };" % ", ".join(f'{key}: "{value}"' for key, value in TILE.items()))
    if "--write" in sys.argv:
        root = os.path.join(os.path.dirname(__file__), "..")
        def write(rel, text):
            with open(os.path.join(root, rel), "w") as f: f.write(text)
        def png(svg_text, rel, size):
            tmp = os.path.join(root, ".logo-tmp.svg"); write(".logo-tmp.svg", svg_text)
            subprocess.run(["rsvg-convert", "-w", str(size), "-h", str(size), tmp, "-o", os.path.join(root, rel)], check=True)
            os.remove(tmp)
        # The browser tab's icon follows the browser's theme (adaptive_tile); favicon.ico and the app icons are the ink square.
        # The docs' logos are one file per theme. iOS rounds apple-icon.png's
        # corners itself, so it fills the square.
        write("app/icon.svg", adaptive_tile(pad=7))
        write("docs/logo.svg", svg(LIGHT, size=96)); write("docs/logo-dark.svg", svg(DARK, size=96))
        png(tile(pad=9, rx=0), "app/apple-icon.png", 180)
        png(tile(pad=9, rx=0), "public/icon-192.png", 192)
        png(tile(pad=9, rx=0), "public/icon-512.png", 512)
        from PIL import Image
        png(tile(pad=6, rx=0), "public/favicon-256.png", 256)
        im = Image.open(os.path.join(root, "public/favicon-256.png")).convert("RGBA")
        im.save(os.path.join(root, "public/favicon.ico"), sizes=[(16, 16), (32, 32), (48, 48)])
        os.remove(os.path.join(root, "public/favicon-256.png"))
        print("icons written")
