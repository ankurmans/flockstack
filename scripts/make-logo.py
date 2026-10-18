"""FlockStack's mark: three gulls in a stack, each smaller and fainter than the one below, climbing away.
Prints the three paths (for components/LogoFlockstack.jsx) and writes the icon files from them.

    python3 scripts/make-logo.py            # print the shapes
    python3 scripts/make-logo.py --write    # also write the icon files (needs rsvg-convert and Pillow)
"""
import math, subprocess, sys, os

VIEWBOX = "0 0 48 48"
# (center x, y of the wing tips, wingspan, thickness at the body, opacity)
GULLS = [(24, 40, 40, 6.0, 1.0), (24, 27.5, 29, 4.5, 0.6), (24, 16.5, 18, 3.2, 0.32)]

def bez(p0, p1, p2, p3, s):
    u = 1 - s
    return tuple(u**3*a + 3*u*u*s*b + 3*u*s*s*c + s**3*d for a, b, c, d in zip(p0, p1, p2, p3))

def smooth(s):
    return s * s * (3 - 2 * s)

def gull(cx, y, w, t):
    # left half of the wing's centreline, tip to body; the right half mirrors it
    p0, p1, p2, p3 = (cx - w/2, y + 0.04*w), (cx - w/2 + 0.12*w, y - 0.30*w), (cx - 0.20*w, y - 0.40*w), (cx, y - 0.02*w)
    n = 28
    pts = [bez(p0, p1, p2, p3, i / n) for i in range(n + 1)]
    upper, lower = [], []
    for i, (x, yy) in enumerate(pts):
        a = pts[max(i - 1, 0)]; b = pts[min(i + 1, n)]
        dx, dy = b[0] - a[0], b[1] - a[1]
        length = math.hypot(dx, dy) or 1
        nx, ny = -dy / length, dx / length   # points down-left of travel direction (towards the lower edge)
        half = t * (0.10 + 0.90 * math.sin(math.pi * i / n) ** 0.75) / 2
        upper.append((x - nx * half, yy - ny * half))
        lower.append((x + nx * half, yy + ny * half))
    mirror = lambda ps: [(2 * cx - x, yy) for x, yy in ps]
    outline = upper + mirror(upper)[::-1][1:] + mirror(lower)[1:] + lower[::-1]
    return outline

def path(points):
    return "M" + "L".join(f"{x:.1f} {y:.1f}" for x, y in points) + "Z"

SHAPES = [(path(gull(cx, y, w, t)), op) for cx, y, w, t, op in GULLS]

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
