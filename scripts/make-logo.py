"""FlockStack's mark, Rising flock: two stacked chevrons, the upper one fainter. A V of birds and an arrow up.
Prints the three paths (for components/LogoFlockstack.jsx) and writes the icon files from them.

    python3 scripts/make-logo.py            # print the shapes
    python3 scripts/make-logo.py --write    # also write the icon files (needs rsvg-convert and Pillow)
"""
import math, subprocess, sys, os

VIEWBOX = "0 0 48 48"
# Two chevrons, the upper one fainter: (left x, y of the arms' ends, apex x, apex y, right x, thickness, opacity)
CHEVRONS = [(7, 38, 24, 23, 41, 7.0, 1.0), (7, 25, 24, 10, 41, 7.0, 0.5)]

def chevron(ax, ay, bx, by, cx, t):
    # A stroke from A to the apex B to C with round ends and a round top, outlined as one filled shape.
    h = t / 2
    def unit(x, y):
        length = math.hypot(x, y)
        return x / length, y / length
    u1 = unit(bx - ax, by - ay); u2 = unit(cx - bx, ay - by)
    n1 = (u1[1], -u1[0]); n2 = (u2[1], -u2[0])   # the upper side of each arm
    up = lambda px, py, n, k=1: (px + k * h * n[0], py + k * h * n[1])
    sx, sy = n1[0] + n2[0], n1[1] + n2[1]
    s2 = sx * sx + sy * sy
    inner = (bx - 2 * h * sx / s2, by - 2 * h * sy / s2)   # where the lower edges meet under the apex
    a_top, b1, b2, c_top = up(ax, ay, n1), up(bx, by, n1), up(bx, by, n2), up(cx, ay, n2)
    c_bot, a_bot = up(cx, ay, n2, -1), up(ax, ay, n1, -1)
    p = lambda pt: f"{pt[0]:.2f} {pt[1]:.2f}"
    arc = lambda pt: f"A{h:.2f} {h:.2f} 0 0 1 {p(pt)}"
    return f"M{p(a_top)}L{p(b1)}{arc(b2)}L{p(c_top)}{arc(c_bot)}L{p(inner)}L{p(a_bot)}{arc(a_top)}Z"

SHAPES = [(chevron(ax, ay, bx, by, cx, t), op) for ax, ay, bx, by, cx, t, op in CHEVRONS]

def svg(fg="#0a0a0a", bg=None, size=None, pad=0, rx=0, mono=False):
    box = "0 0 48 48"
    dims = f' width="{size}" height="{size}"' if size else ""
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{box}"{dims}>']
    if bg: out.append(f'<rect width="48" height="48" rx="{rx}" fill="{bg}"/>')
    scale = 1 - 2 * pad / 48
    out.append(f'<g transform="translate({pad} {pad}) scale({scale:.4f})">' if pad else "<g>")
    for d, op in SHAPES:
        out.append(f'<path d="{d}" fill="{fg}"' + (f' fill-opacity="{op}"' if op < 1 else "") + "/>")
    out.append("</g></svg>")
    return "".join(out)

if __name__ == "__main__":
    print('export const LOGO_VIEWBOX = "%s";' % VIEWBOX)
    print("export const LOGO_SHAPES = [")
    for d, op in SHAPES:
        print(f'\t{{ d: "{d}", opacity: {op} }},')
    print("];")
    if "--write" in sys.argv:
        root = os.path.join(os.path.dirname(__file__), "..")
        def write(rel, text):
            with open(os.path.join(root, rel), "w") as f: f.write(text)
        def png(svg_text, rel, size):
            tmp = os.path.join(root, ".logo-tmp.svg"); write(".logo-tmp.svg", svg_text)
            subprocess.run(["rsvg-convert", "-w", str(size), "-h", str(size), tmp, "-o", os.path.join(root, rel)], check=True)
            os.remove(tmp)
        # app/icon.svg adapts to the browser's theme; the docs' logos are one file per theme
        write("app/icon.svg", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><style>path{fill:#0a0a0a}@media (prefers-color-scheme:dark){path{fill:#fafafa}}</style>' + "".join(f'<path d="{d}"' + (f' fill-opacity="{op}"' if op < 1 else "") + "/>" for d, op in SHAPES) + "</svg>")
        write("docs/logo.svg", svg("#0a0a0a", size=96)); write("docs/logo-dark.svg", svg("#fafafa", size=96))
        png(svg("#0a0a0a", bg="#ffffff", pad=8), "app/apple-icon.png", 180)
        png(svg("#0a0a0a", bg="#ffffff", pad=9), "public/icon-192.png", 192)
        png(svg("#0a0a0a", bg="#ffffff", pad=9), "public/icon-512.png", 512)
        from PIL import Image
        png(svg("#0a0a0a", bg="#ffffff", pad=4), "public/favicon-256.png", 256)
        im = Image.open(os.path.join(root, "public/favicon-256.png")).convert("RGBA")
        im.save(os.path.join(root, "public/favicon.ico"), sizes=[(16, 16), (32, 32), (48, 48)])
        os.remove(os.path.join(root, "public/favicon-256.png"))
        print("icons written")
