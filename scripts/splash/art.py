"""The loading screen's scene, as SVG. Seeded, so the same every run."""
import math
import random


def n(x):
    return ('%.1f' % x).rstrip('0').rstrip('.')


def rect(x, y, w, h, fill, extra=''):
    return f'<rect x="{n(x)}" y="{n(y)}" width="{n(w)}" height="{n(h)}" fill="{fill}"{(" " + extra) if extra else ""}/>'


# ---------------------------------------------------------------- the skyline

FAR_TILE = 2400
MID_TILE = 2400
H = 320


def far():
    r = random.Random(11)
    d = []
    x = 0
    while x < FAR_TILE - 40:
        w = min(r.randint(36, 96), FAR_TILE - x)
        h = r.choice([72, 90, 104, 118, 132, 150, 168, 188, 214, 244])
        top = H - h
        k = r.random()
        if k < 0.2:
            d.append(f'M{x} {H}V{top + 20}L{x + w // 2} {top}L{x + w} {top + 20}V{H}z')
        elif k < 0.4:
            i = max(6, w // 5)
            d.append(f'M{x} {H}V{top + 30}h{i}V{top}h{w - 2 * i}v30h{i}V{H}z')
        elif k < 0.55:
            d.append(f'M{x} {H}V{top + 16}L{x + w} {top}V{H}z')
        else:
            d.append(f'M{x} {H}V{top}h{w}V{H}z')
            if h > 180 and r.random() < 0.6:
                d.append(f'M{x + w // 2 - 1} {top}v-26h2v26z')
        x += w + r.choice([-10, 0, 0, 4, 10, 24])
    return ''.join(d)


def mid():
    r = random.Random(29)
    faces, sides, trim = [], [], []
    warm, dim, cool, band = [], [], [], []
    x = 4
    while x < MID_TILE - 70:
        w = min(r.randint(60, 128), MID_TILE - x - 6)
        h = r.choice([96, 116, 134, 150, 168, 190, 214, 240, 272])
        top = H - h
        f = round(w * 0.8)
        s = w - f
        crown = r.choice(['flat', 'flat', 'set', 'slant', 'lit', 'spire', 'plant'])
        kind = r.choice(['condo', 'condo', 'office', 'office', 'slab'])
        lit = r.uniform(0.14, 0.34)
        y0 = top
        if crown == 'set':
            i = max(8, f // 6)
            faces.append(f'M{x} {H}V{top + 36}h{i}V{top}h{f - 2 * i}v36h{i}V{H}z')
            sides.append(f'M{x + f} {H}V{top + 36}l{s} -4V{H}z')
            y0 = top + 36
        elif crown == 'slant':
            cut = r.randint(16, 30)
            faces.append(f'M{x} {H}V{top + cut}L{x + f} {top}V{H}z')
            sides.append(f'M{x + f} {H}V{top}l{s} 8V{H}z')
            y0 = top + cut
        else:
            faces.append(f'M{x} {H}V{top}h{f}V{H}z')
            sides.append(f'M{x + f} {H}V{top}l{s} 5V{H}z')
            if crown == 'lit':
                trim.append(rect(x + 3, top + 4, f - 6, 3, '#ffbf73'))
            if crown == 'spire':
                faces.append(f'M{x + f // 2 - 1} {top}v-34h2v34z')
                faces.append(f'M{x + f // 2 - 5} {top}v-8h10v8z')
            if crown == 'plant':
                faces.append(f'M{x + 8} {top}v-9h{f // 3}v9z')
                faces.append(f'M{x + f - 20} {top}v-14h12v14z')
                faces.append(f'M{x + f - 24} {top - 14}h20v-2h-20z')
        # Windows that belong to the building: floors and bays, not a wallpaper.
        cw, ch, ww, wh = {
            'condo': (9, 11, 5, 6),
            'office': (7, 9, 5, 4),
            'slab': (12, 10, 8, 5),
        }[kind]
        cols = max(2, (f - 12) // cw)
        pad = (f - cols * cw + (cw - ww)) // 2
        rows = max(2, (H - y0 - 22) // ch)
        for row in range(rows):
            y = y0 + 12 + row * ch
            floor_on = r.random() < 0.82
            for col in range(cols):
                if not floor_on or r.random() > lit:
                    continue
                wx = x + pad + col * cw
                cell = f'M{wx} {y}h{ww}v{wh}h-{ww}z'
                roll = r.random()
                (warm if roll < 0.62 else dim if roll < 0.86 else cool).append(cell)
            if kind == 'office' and row % 3 == 0:
                band.append(rect(x + 2, y - 2, f - 4, 1, '#3a4780', 'opacity=".5"'))
        for row in range(rows // 2):
            if r.random() < 0.28:
                y = y0 + 14 + row * 2 * ch
                dim.append(f'M{x + f + 2} {y}h{max(2, s - 4)}v5h-{max(2, s - 4)}z')
        x += w + r.choice([0, 0, 4, 10, 18, 30])
    return dict(
        faces=''.join(faces),
        sides=''.join(sides),
        trim=''.join(trim) + ''.join(band),
        warm=''.join(warm),
        dim=''.join(dim),
        cool=''.join(cool),
    )


def viaduct():
    """The MRT, up on its piers: three bays to the tile."""
    out = []
    for px in (60, 340, 620):
        out.append(f'<path d="M{px - 34} 118h68l-26 22h-16z" fill="#161b3a"/>')
        out.append(rect(px - 8, 138, 16, 62, 'url(#sp-pier)'))
        out.append(rect(px + 4, 140, 4, 60, '#2e2f5e', 'opacity=".7"'))
    out.append(rect(0, 96, 840, 22, '#1c2146'))
    out.append(rect(0, 96, 840, 3, '#3b3f72'))
    out.append(rect(0, 114, 840, 4, '#0f1330'))
    # Parapet and the masts of the overhead line.
    out.append(rect(0, 90, 840, 6, '#232853'))
    for mx in (200, 480, 760):
        out.append(rect(mx, 56, 2.4, 40, '#141938'))
        out.append(rect(mx - 12, 58, 26, 2, '#141938'))
    out.append('<path d="M0 62H840" stroke="#0d1128" stroke-width="1"/>')
    for lx in range(70, 840, 140):
        out.append(f'<circle cx="{lx}" cy="118" r="1.6" fill="#ffd591"/>')
    return ''.join(out)


# ---------------------------------------------------------------- the street

B = 170
STREET_TILE = 2400


def lit_front(x, w, h, sachets=False):
    y = B - h
    s = [rect(x, y, w, h, 'url(#sp-shop)')]
    # Shelves and goods.
    r = random.Random(x)
    for row in (y + 8, y + 18):
        s.append(rect(x + 3, row, w - 6, 1.4, '#9a5a2a'))
        cx = x + 5
        while cx < x + w - 8:
            c = r.choice(['#d8483b', '#2f6fd0', '#f4f1e4', '#36a269', '#e8a92e'])
            bw = r.choice([2, 3, 3, 4])
            s.append(rect(cx, row - r.choice([4, 5, 6]), bw, 6, c, 'opacity=".85"'))
            cx += bw + r.choice([1, 1, 2])
    if sachets:
        for sx in range(int(x) + 5, int(x + w) - 4, 6):
            c = r.choice(['#e3574a', '#f2c84b', '#4d9de0', '#f4f1e4'])
            s.append(rect(sx, y, 3, r.randint(6, 12), c))
    s.append(rect(x, B - 11, w, 11, '#3a2b3a'))
    return ''.join(s)


def awning(x, w, y, a, b):
    s = [f'<path d="M{n(x)} {n(y)}h{n(w)}l6 11H{n(x - 6)}z" fill="{a}"/>']
    step = 12
    i = 0
    sx = x
    while sx < x + w - 1:
        if i % 2:
            sw = min(step, x + w - sx)
            s.append(
                f'<path d="M{n(sx)} {n(y)}h{n(sw)}l{n(sw / w * 12 + 6 - 6 * 2 * (sx + sw - x) / w)} 11h{n(-sw - sw / w * 12)}z" fill="{b}"/>'
            )
        sx += step
        i += 1
    s.append(rect(x - 6, y + 11, w + 12, 2, '#0d1024', 'opacity=".6"'))
    return ''.join(s)


def sign(x, y, w, h, text, bg, fg, size=8):
    return (
        rect(x, y, w, h, bg, 'rx="1.5"')
        + f'<text x="{n(x + w / 2)}" y="{n(y + h / 2 + size * 0.36)}" text-anchor="middle" '
        f'fill="{fg}" font-size="{size}" font-weight="800" letter-spacing=".4">{text}</text>'
    )


def upper(x, w, y, cols, r):
    s = []
    gap = w / cols
    for i in range(cols):
        wx = x + gap * i + gap / 2 - 7
        on = r.random() < 0.6
        s.append(rect(wx, y, 14, 15, '#ffcc82' if on else '#141a38'))
        s.append(rect(wx - 1, y - 1, 16, 1, '#0d1024'))
        for g in range(1, 4):
            s.append(rect(wx + g * 3.5, y, 0.8, 15, '#0d1024', 'opacity=".8"'))
        s.append(rect(wx, y + 7, 14, 0.8, '#0d1024', 'opacity=".8"'))
    return ''.join(s)


def shop(x, w, h, wall, label, bg, fg, a, b, sachets=False, seed=1):
    r = random.Random(seed)
    s = [rect(x, B - h, w, h, wall)]
    s.append(rect(x - 2, B - h - 3, w + 4, 3, '#0f1330'))
    s.append(rect(x + w - 6, B - h, 6, h, '#000', 'opacity=".22"'))
    s.append(upper(x + 4, w - 8, B - h + 7, max(1, int(w // 34)), r))
    if h > 92:
        s.append(upper(x + 4, w - 8, B - h + 29, max(1, int(w // 34)), r))
    s.append(lit_front(x + 5, w - 10, 40, sachets))
    s.append(awning(x + 5, w - 10, B - 52, a, b))
    s.append(sign(x + 8, B - 66, w - 16, 13, label, bg, fg, min(9, (w - 18) / (len(label) * 0.66))))
    return ''.join(s)


def apartment(x, w, h, wall, seed):
    r = random.Random(seed)
    s = [rect(x, B - h, w, h, wall), rect(x - 2, B - h - 3, w + 4, 3, '#0f1330')]
    s.append(rect(x + w - 6, B - h, 6, h, '#000', 'opacity=".22"'))
    floors = (h - 34) // 28
    for f in range(floors):
        y = B - h + 8 + f * 28
        s.append(upper(x + 4, w - 8, y, max(1, int(w // 30)), r))
        s.append(rect(x + 4, y + 16, w - 8, 1.6, '#3f4674'))
        for bx in range(int(x) + 6, int(x + w) - 4, 5):
            s.append(rect(bx, y + 17, 0.8, 6, '#3f4674'))
        s.append(rect(x + 4, y + 23, w - 8, 1, '#0f1330'))
        # Washing on the balcony.
        if r.random() < 0.6:
            lx = x + r.randint(8, int(w) - 30)
            for k, c in enumerate(r.sample(['#e6e1d4', '#d9534a', '#4d9de0', '#e9c14b'], 3)):
                s.append(rect(lx + k * 7, y + 16.6, 5, r.randint(6, 9), c, 'opacity=".8"'))
    # A shutter down at street level, and a gate.
    s.append(rect(x + 5, B - 26, w * 0.6, 26, '#2a2f55'))
    for sy in range(B - 26, B, 3):
        s.append(rect(x + 5, sy, w * 0.6, 1, '#1a1e3e'))
    s.append(rect(x + 9 + w * 0.6, B - 26, w * 0.4 - 18, 26, '#141a38'))
    return ''.join(s)


def tree(x, size, seed):
    r = random.Random(seed)
    s = [f'<path d="M{x - 3} {B}L{x - 1.6} {B - size}h3.2L{x + 3} {B}z" fill="#0d1124"/>']
    # Boughs off the trunk, then the crown as many small overlapping clumps.
    s.append(f'<path d="M{x} {B - size * 0.8}Q{n(x - size * 0.2)} {n(B - size)} {n(x - size * 0.4)} {n(B - size * 1.1)}M{x} {B - size * 0.72}Q{n(x + size * 0.24)} {n(B - size * 0.98)} {n(x + size * 0.44)} {n(B - size * 1.08)}" fill="none" stroke="#0d1124" stroke-width="2"/>')
    dark, light = [], []
    for _ in range(46):
        a = r.uniform(0, 6.283)
        d = r.uniform(0, 1) ** 0.6
        bx = x + math.cos(a) * d * size * 0.72
        by = B - size * 1.18 + math.sin(a) * d * size * 0.36
        br = r.uniform(size * 0.07, size * 0.13)
        dark.append(f'<circle cx="{n(bx)}" cy="{n(by)}" r="{n(br)}"/>')
        # The sun is low and behind: only the top edge of the crown catches it.
        if by < B - size * 1.26 and r.random() < 0.6:
            light.append(f'<circle cx="{n(bx + 1)}" cy="{n(by - br * 0.5)}" r="{n(br * 0.5)}"/>')
    s.append(f'<g fill="#101d36">{"".join(dark)}</g><g fill="#1c2f4f">{"".join(light)}</g>')
    return ''.join(s)


def palm(x, height, seed):
    r = random.Random(seed)
    top = B - height
    s = [f'<path d="M{x - 2.4} {B}Q{x + 3} {B - height * 0.5} {x + 1} {top}l2 0Q{x + 6} {B - height * 0.5} {x + 2.6} {B}z" fill="#0f1328"/>']
    for a in (-1, -0.62, -0.25, 0.25, 0.62, 1):
        lx = 34 * a
        ly = 22 * abs(a)
        s.append(
            f'<path d="M{x + 2} {top}Q{n(x + 2 + lx * 0.6)} {n(top - 14 + ly * 0.2)} {n(x + 2 + lx)} {n(top + ly - 2 + r.uniform(0, 4))}Q{n(x + 2 + lx * 0.5)} {n(top - 7 + ly * 0.2)} {x + 2} {top + 3}z" fill="#12233a"/>'
        )
    return ''.join(s)


def person(x, y, c, h=13, hair='#100c18', skin='#6e4a3d'):
    return (
        f'<rect x="{n(x - 1.8)}" y="{n(y + h * 0.62)}" width="3.6" height="{n(h * 0.38)}" rx="1" fill="#14182e"/>'
        f'<rect x="{n(x - 2.3)}" y="{n(y + h * 0.26)}" width="4.6" height="{n(h * 0.42)}" rx="1.4" fill="{c}"/>'
        f'<circle cx="{n(x)}" cy="{n(y + h * 0.14)}" r="{n(h * 0.14)}" fill="{skin}"/>'
        f'<path d="M{n(x - h * 0.15)} {n(y + h * 0.13)}a{n(h * 0.15)} {n(h * 0.15)} 0 0 1 {n(h * 0.3)} 0z" fill="{hair}"/>'
    )


def shed(x):
    s = [f'<path d="M{x - 6} {B - 46}L{x + 96} {B - 52}l4 6L{x - 2} {B - 40}z" fill="#2a3a78"/>']
    s.append(f'<path d="M{x - 6} {B - 46}L{x + 96} {B - 52}v-2L{x - 6} {B - 48}z" fill="#5570c8"/>')
    for px in (x + 4, x + 88):
        s.append(rect(px, B - 44, 3, 44, '#202548'))
    s.append(rect(x + 2, B - 15, 90, 3, '#39406e'))
    s.append(rect(x + 8, B - 12, 2, 12, '#191d3a'))
    s.append(rect(x + 82, B - 12, 2, 12, '#191d3a'))
    s.append(rect(x + 2, B - 39, 90, 18, '#141a3a', 'opacity=".55"'))
    s.append(sign(x + 16, B - 40, 62, 11, 'SAKAY DITO', '#ffc83d', '#1a1f3e', 7))
    s.append(person(x + 22, B - 21, '#d9534a', 21))
    s.append(person(x + 38, B - 22, '#3f83c9', 22))
    s.append(person(x + 50, B - 18, '#efe6d2', 18))
    s.append(person(x + 72, B - 21, '#e9c14b', 21))
    return ''.join(s)


def hoop(x):
    return (
        rect(x, B - 56, 3, 56, '#20264a')
        + f'<path d="M{x + 3} {B - 54}h12" stroke="#20264a" stroke-width="2"/>'
        + rect(x + 14, B - 64, 3, 20, '#d9dcea')
        + f'<path d="M{x + 17} {B - 50}h9" stroke="#e9663c" stroke-width="1.6"/>'
        + f'<path d="M{x + 18} {B - 49}l1.6 7h4l1.6-7" fill="none" stroke="#c9cede" stroke-width=".6"/>'
    )


def fence(x, w):
    s = [rect(x, B - 26, w, 26, '#242a50')]
    s.append(rect(x, B - 28, w, 2, '#3a4072'))
    for px in range(int(x), int(x + w), 54):
        s.append(rect(px, B - 30, 7, 30, '#2e3560'))
    return ''.join(s)


def tricycle(x):
    return (
        f'<path d="M{x} {B - 5}v-13q0-5 5-5h17q4 0 4 4v14z" fill="#1e7a78"/>'
        + rect(x + 4, B - 21, 15, 8, '#ffd694')
        + rect(x + 3, B - 24, 22, 2.4, '#e5e8f0')
        + f'<path d="M{x + 26} {B - 8}h14l7-9h-3l-6 6h-12z" fill="#b8352f"/>'
        + f'<circle cx="{x + 10}" cy="{B - 4}" r="4" fill="#0b0d15"/>'
        + f'<circle cx="{x + 44}" cy="{B - 4}" r="4" fill="#0b0d15"/>'
        + f'<circle cx="{x + 10}" cy="{B - 4}" r="1.6" fill="#99a2b3"/>'
        + f'<circle cx="{x + 44}" cy="{B - 4}" r="1.6" fill="#99a2b3"/>'
    )


def billboard(x):
    s = [rect(x + 22, B - 74, 5, 74, '#1b2042'), rect(x + 95, B - 74, 5, 74, '#1b2042')]
    s.append(rect(x, B - 138, 124, 66, '#10142c'))
    s.append(rect(x + 3, B - 135, 118, 60, 'url(#sp-board)'))
    # The brand's three bars.
    s.append(rect(x + 13, B - 122, 26, 6, '#9db2ff', 'rx="3"'))
    s.append(rect(x + 13, B - 112, 18, 6, '#f06a62', 'rx="3"'))
    s.append(rect(x + 13, B - 102, 22, 6, '#ffc83d', 'rx="3"'))
    s.append(
        f'<text x="{x + 46}" y="{B - 106}" fill="#fff" font-size="15" font-weight="800" letter-spacing="-.3">Sakay na!</text>'
    )
    s.append(
        f'<text x="{x + 46}" y="{B - 94}" fill="#c7d2f5" font-size="6.8" font-weight="600">Live on the map</text>'
    )
    for lx in (x + 20, x + 62, x + 104):
        s.append(f'<circle cx="{lx}" cy="{B - 139}" r="1.6" fill="#fff0c8"/>')
    return ''.join(s)


def street():
    s = []
    s.append(tree(70, 74, 1))
    s.append(shop(120, 118, 96, '#2b3160', 'SARI-SARI STORE', '#d7372f', '#fff', '#2f55e0', '#f0f2fa', True, 2))
    s.append(shop(238, 96, 118, '#30305c', 'CARINDERIA', '#f4c542', '#3a2410', '#d7372f', '#f6e7c8', False, 3))
    s.append(fence(334, 108))
    s.append(sign(342, B - 21, 74, 12, 'BAWAL TUMAWID', '#c23a30', '#fff', 7))
    s.append(hoop(420))
    s.append(shed(470))
    s.append(palm(596, 108, 4))
    s.append(tree(650, 66, 5))
    s.append(billboard(700))
    s.append(shop(840, 104, 86, '#26335f', 'VULCANIZING', '#1f2937', '#ffc83d', '#3f8a5f', '#e7efe2', False, 6))
    # Tyres stacked outside the vulcanizing shop.
    for ty in (B - 6, B - 14, B - 22):
        s.append(f'<ellipse cx="950" cy="{ty}" rx="9" ry="4.4" fill="#0c0e18" stroke="#2a2e44" stroke-width="1"/>')
    s.append(tricycle(966))
    s.append(shop(1030, 122, 104, '#2e2f5c', 'TAPSILOGAN', '#ef7f2f', '#fff', '#b92f2b', '#f7e5c3', False, 7))
    s.append(tree(1190, 80, 8))
    s.append(shop(1236, 92, 92, '#2a3462', 'BIGASAN', '#2f7d4f', '#fff', '#2f55e0', '#eef1fa', False, 9))
    s.append(apartment(1330, 118, 112, '#2d3360', 18))
    s.append(tree(1400, 58, 10))
    s.append(shop(1470, 120, 112, '#32305e', 'MANG TOMAS PANSITERIA', '#22408f', '#ffd778', '#d7372f', '#f6e7c8', False, 11))
    s.append(palm(1612, 96, 12))
    s.append(shop(1650, 100, 84, '#2b3362', 'SARI-SARI', '#2f7d4f', '#fff', '#e0a321', '#f7efd8', True, 13))
    s.append(shed(1780))
    s.append(tree(1920, 72, 14))
    s.append(apartment(1950, 112, 96, '#2c3160', 19))
    s.append(tricycle(2000))
    s.append(shop(2076, 112, 100, '#2c2f60', 'BARBERSHOP', '#f0f2fa', '#22345f', '#2f55e0', '#d7372f', False, 15))
    s.append(palm(2216, 112, 16))
    s.append(tree(2284, 70, 17))
    return ''.join(s)


# ----------------------------------------------------------------- the poles

POLE_TILE = 900
P = 300


def wires():
    pole = 140
    nxt = pole + POLE_TILE
    prv = pole - POLE_TILE
    out = []
    # (height, sag, offset along the crossarm, width): power high up, the telco bundle below it.
    for y, sag, off, w in [
        (P - 232, 30, -24, 1),
        (P - 233, 28, 0, 1),
        (P - 232, 31, 24, 1),
        (P - 214, 40, -16, 0.9),
        (P - 214, 38, 16, 0.9),
        (P - 176, 46, -4, 2.2),
        (P - 172, 52, -4, 1.1),
        (P - 168, 56, -4, 0.8),
    ]:
        for a, b in ((prv, pole), (pole, nxt)):
            mid_x = (a + b) / 2
            out.append(f'M{a + off} {y}Q{mid_x + off} {y + 2 * sag} {b + off} {y}')
    return ''.join(out)


def poles():
    x = 140
    top = P - 236
    s = [
        # The pavement and the kerb it stands on.
        rect(0, P - 15, POLE_TILE, 11, 'url(#sp-walk)'),
        rect(0, P - 15, POLE_TILE, 1.5, '#4a4d74'),
    ]
    for kx in range(0, POLE_TILE, 60):
        s.append(rect(kx, P - 4, 30, 4, '#e1b53c', 'opacity=".75"'))
        s.append(rect(kx + 30, P - 4, 30, 4, '#23263c'))
    for jx in range(30, POLE_TILE, 60):
        s.append(rect(jx, P - 15, 1, 11, '#1a1d33'))
    # Light falling from the lamp, then where it lands.
    s.append(f'<path d="M198 {P - 204}h22L322 {P - 8}H96z" fill="url(#sp-cone)" filter="url(#sp-soft)"/>')
    s.append(f'<ellipse cx="209" cy="{P - 9}" rx="120" ry="7" fill="url(#sp-pool)"/>')
    s.append(f'<ellipse cx="209" cy="{P + 7}" rx="150" ry="7" fill="url(#sp-pool)" opacity=".5"/>')
    # The wires, behind the pole.
    s.append(f'<path d="{wires()}" fill="none" stroke="#070a16"/>')
    # Concrete pole, tapered, lit down one side.
    s.append(f'<path d="M{x - 6} {P - 13}L{x - 3} {top}h6L{x + 6} {P - 13}z" fill="url(#sp-concrete)"/>')
    s.append(f'<path d="M{x + 1.4} {top}h1.6L{x + 6} {P - 13}h-2.6z" fill="#6a6a8c" opacity=".55"/>')
    s.append(rect(x - 8, P - 19, 16, 6, '#2f3252'))
    for by in range(P - 150, top, -14):
        s.append(rect(x - 0.8, by, 1.6, 1.6, '#0b0e1e'))
    # Crossarms and insulators.
    for arm_y, half in ((P - 226, 32), (P - 208, 22)):
        s.append(rect(x - half, arm_y, 2 * half, 4, '#23264a'))
        s.append(rect(x - half, arm_y, 2 * half, 1, '#5a5a82'))
    for ix, iy in ((-24, P - 233), (0, P - 234), (24, P - 233), (-16, P - 215), (16, P - 215)):
        s.append(rect(x + ix - 1.8, iy, 3.6, 7, '#b8c0d4', 'rx="1"'))
        s.append(rect(x + ix - 2.6, iy + 2.4, 5.2, 1, '#8c94aa'))
    # Transformer on its bracket.
    s.append(rect(x - 26, P - 196, 22, 3, '#23264a'))
    s.append(rect(x - 30, P - 200, 18, 34, 'url(#sp-can)', 'rx="2"'))
    s.append(rect(x - 31, P - 201, 20, 3, '#59607e', 'rx="1"'))
    s.append(rect(x - 27, P - 206, 2.4, 6, '#b8c0d4'))
    s.append(rect(x - 18, P - 206, 2.4, 6, '#b8c0d4'))
    s.append(f'<path d="M{x - 26} {P - 206}Q{x - 22} {P - 216} {x - 16} {P - 214}M{x - 17} {P - 206}Q{x - 12} {P - 212} {x + 16} {P - 213}" fill="none" stroke="#070a16" stroke-width=".8"/>')
    # Telco box and the coil of spare cable everyone has seen.
    s.append(rect(x + 5, P - 170, 11, 15, '#1b1f3e', 'rx="1"'))
    s.append(rect(x + 5, P - 170, 11, 2, '#454a72'))
    s.append(f'<g fill="none" stroke="#070a16" stroke-width=".9"><ellipse cx="{x - 9}" cy="{P - 161}" rx="5" ry="8"/><ellipse cx="{x - 8}" cy="{P - 160}" rx="4.4" ry="7"/><ellipse cx="{x - 10}" cy="{P - 159}" rx="5" ry="7.4"/></g>')
    s.append(rect(x - 3, P - 169, 7, 2, '#070a16'))
    # Street lamp on its arm.
    s.append(f'<path d="M{x + 2} {P - 188}C{x + 16} {P - 206} {x + 40} {P - 208} {x + 62} {P - 206}" fill="none" stroke="#23264a" stroke-width="3"/>')
    s.append(f'<path d="M{x + 2} {P - 187}C{x + 16} {P - 205} {x + 40} {P - 207} {x + 62} {P - 205}" fill="none" stroke="#5a5a82" stroke-width=".7"/>')
    s.append(f'<path d="M{x + 56} {P - 209}h24q5 0 6 4H{x + 58}z" fill="#2a2e50"/>')
    s.append(rect(x + 60, P - 205, 22, 2.4, '#fff6d8', 'rx="1"'))
    s.append(f'<circle cx="{x + 71}" cy="{P - 203}" r="16" fill="url(#sp-bulb)"/>')
    return ''.join(s)


# ---------------------------------------------------------------- the jeepney


def rider(x, shirt, hair, style):
    s = [f'<path d="M{x - 8.6} 101q.4-12 8.6-12t8.6 12z" fill="{shirt}"/>']
    s.append(f'<rect x="{x - 2}" y="85" width="4" height="5" fill="#8a5a43"/>')
    s.append(f'<circle cx="{x}" cy="80.6" r="5" fill="{hair}"/>')
    if style == 'long':
        s.append(f'<path d="M{x - 5} 81q-.6 8-1.4 11h12.8q-.8-3-1.4-11z" fill="{hair}"/>')
    elif style == 'bun':
        s.append(f'<circle cx="{x + 1}" cy="74.6" r="2.6" fill="{hair}"/>')
    elif style == 'cap':
        s.append(f'<path d="M{x - 5.4} 79.6a5.4 5.4 0 0 1 10.8 0z" fill="#2f55e0"/>')
        s.append(rect(x + 3.6, 78.6, 5, 1.4, '#2f55e0', 'rx=".7"'))
    return ''.join(s)


def jeepney():
    bays = [27 + i * 36 for i in range(8)]
    clip = ''.join(rect(b, 72, 32, 26, '#000', 'rx="1.6"') for b in bays)
    interiors = ''.join(rect(b, 72, 32, 26, 'url(#jp-warm)', 'rx="1.6"') for b in bays)
    # The far side, seen through the near windows: its sky, its pillars, its bench.
    far_side = ''.join(
        rect(b + 3, 75, 26, 10, 'url(#jp-through)', 'rx="1"') + rect(b, 90, 32, 8, '#a8622f')
        for b in bays
    )
    curtains = ''.join(rect(b, 72, 32, 3.6, '#7a2f2c') + rect(b, 75, 32, 0.8, '#3e1818', 'opacity=".5"') for b in bays)
    people = ''.join(
        rider(x, shirt, hair, style)
        for x, shirt, hair, style in [
            (44, '#3e7fb8', '#1a1218', 'long'),
            (84, '#d8b13e', '#231519', 'short'),
            (113, '#c8493f', '#17101a', 'cap'),
            (152, '#3f9a7c', '#1b1116', 'bun'),
            (190, '#7a6bc2', '#20141a', 'short'),
            (222, '#e38d3c', '#1a1016', 'long'),
            (262, '#3a6fb0', '#191016', 'cap'),
            (296, '#b84d6e', '#20141a', 'short'),
        ]
    )
    roof_lamps = ''.join(
        f'<circle cx="{x}" cy="51" r="2.2" fill="#ff9d2e" opacity=".35"/><circle cx="{x}" cy="51" r="1.1" fill="#ffb648"/>'
        for x in range(30, 340, 22)
    )
    ribs = ''.join(rect(x, 106, 0.8, 22, '#fff', 'opacity=".07"') for x in range(30, 322, 14))
    slats = ''.join(
        rect(392 + i * 7, 100.6 + i * 0.1, 3.4, 8, 'url(#jp-chrome)', 'rx=".8"') for i in range(6)
    )
    grille = ''.join(rect(452.6, 106 + i * 4, 6.4, 1.6, '#39404f') for i in range(5))
    horse = (
        'M0 19L3.6 12.6 2.6 8.8 7.4 6.6 11.6 6.4 14.6 2.6 17.6 0 18.4 1.6 21.4 3.8 19.6 5.2 '
        '17.4 4.6 16.6 8 14.4 11.4 16 19H13.2L10.8 13.6H7.4L3.4 19z'
    )
    return f'''
<defs>
  <linearGradient id="jp-paint" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e8352d"/><stop offset=".55" stop-color="#c4211f"/><stop offset="1" stop-color="#7c1216"/></linearGradient>
  <linearGradient id="jp-hood" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff6a52"/><stop offset=".2" stop-color="#e5332b"/><stop offset="1" stop-color="#8a1418"/></linearGradient>
  <linearGradient id="jp-fender" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffd867"/><stop offset=".5" stop-color="#f3ae22"/><stop offset="1" stop-color="#a86a10"/></linearGradient>
  <linearGradient id="jp-chrome" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fbfcff"/><stop offset=".42" stop-color="#aab4c7"/><stop offset=".55" stop-color="#5f6a80"/><stop offset=".72" stop-color="#d5dde9"/><stop offset="1" stop-color="#f0a56c"/></linearGradient>
  <linearGradient id="jp-roof" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff4e4"/><stop offset=".6" stop-color="#e5e4e6"/><stop offset="1" stop-color="#a9adbd"/></linearGradient>
  <linearGradient id="jp-warm" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff0c2"/><stop offset=".6" stop-color="#ffc877"/><stop offset="1" stop-color="#e9913f"/></linearGradient>
  <linearGradient id="jp-through" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6a5a92"/><stop offset="1" stop-color="#e58c5a"/></linearGradient>
  <linearGradient id="jp-glass" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8fb0dd"/><stop offset="1" stop-color="#27365f"/></linearGradient>
  <linearGradient id="jp-beam" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff0c4" stop-opacity=".55"/><stop offset=".5" stop-color="#fff0c4" stop-opacity=".12"/><stop offset="1" stop-color="#fff0c4" stop-opacity="0"/></linearGradient>
  <radialGradient id="jp-throw"><stop offset="0" stop-color="#fff0c4" stop-opacity=".3"/><stop offset=".6" stop-color="#ffe7b0" stop-opacity=".1"/><stop offset="1" stop-color="#ffe7b0" stop-opacity="0"/></radialGradient>
  <radialGradient id="jp-lens"><stop offset="0" stop-color="#fff"/><stop offset=".5" stop-color="#fff3c8"/><stop offset="1" stop-color="#ffd27a"/></radialGradient>
  <radialGradient id="jp-bloom"><stop offset="0" stop-color="#fff0c2" stop-opacity=".75"/><stop offset=".3" stop-color="#ffd98f" stop-opacity=".28"/><stop offset="1" stop-color="#ffd98f" stop-opacity="0"/></radialGradient>
  <radialGradient id="jp-red"><stop offset="0" stop-color="#ff5247" stop-opacity=".6"/><stop offset="1" stop-color="#ff3b30" stop-opacity="0"/></radialGradient>
  <filter id="jp-soft" x="-20%" y="-60%" width="140%" height="220%"><feGaussianBlur stdDeviation="5"/></filter>
  <clipPath id="jp-bays">{clip}</clipPath>
</defs>
<path d="M456 110L610 128V156L456 120Z" fill="url(#jp-beam)" filter="url(#jp-soft)" opacity=".5"/>
<ellipse cx="540" cy="162" rx="104" ry="12" fill="url(#jp-throw)"/>
<g stroke="#c9d1de" fill="none"><path d="M352 44L360 6" stroke-width="1.1"/><path d="M332 40L337 16" stroke-width="1"/></g>
<path d="M360 8l-13 2.4 12 2.4z" fill="#ffc83d"/><path d="M359 13l-11 2.2 10 2.2z" fill="#2f55e0"/><path d="M337 17l-10 2 9 2z" fill="#e8352d"/>
<g fill="url(#jp-chrome)"><path d="M294 40l3-6h30v2l-22 1-5 3z"/><path d="M304 40l3-4h24v2l-18 1-3 1z"/></g>
<rect x="140" y="34" width="72" height="7" rx="2" fill="#d3d6df"/><rect x="146" y="35.5" width="60" height="1.2" fill="#fff"/>
<rect x="52" y="128" width="372" height="13" fill="#090b12"/>
<path d="M22 138h56v3.4H22z" fill="#2c303c"/><path d="M22 138h6v3.4h-6z" fill="#596072"/>
<path d="M92 141q34 8 68 0v2q-34 8-68 0z" fill="#1a1d27"/>
<path d="M16 56H322V132H16Z" fill="url(#jp-paint)"/>
<path d="M322 56H342L360 97V132H322Z" fill="url(#jp-paint)"/>
<path d="M356 95L441 98Q451 99 454 108L457 132H356Z" fill="url(#jp-hood)"/>
<path d="M356 95L441 98Q449 99 452 104L356 100.6Z" fill="#ff8a70"/>
<path d="M356 97.4L449 100.8" stroke="#fbfcff" stroke-width=".9" opacity=".85"/>
{slats}
<path d="M12 57Q9 45 24 42.6L332 40Q354 40 364 52L366 57Z" fill="url(#jp-roof)"/>
<path d="M24 42.6L332 40Q346 40 356 45L22 47Z" fill="#fff" opacity=".55"/>
<rect x="11" y="54.6" width="355" height="3" fill="url(#jp-chrome)"/>
{roof_lamps}
<circle cx="348" cy="49" r="1.7" fill="#ff6a5a"/><circle cx="354" cy="50" r="1.7" fill="#ffe2a0"/>
<rect x="24" y="58.6" width="292" height="10" rx="1.6" fill="#0d1330"/>
<text x="170" y="66.2" text-anchor="middle" fill="#ffd778" font-size="7.4" font-weight="700" letter-spacing="1.5">TUNGKO · SM CITY FAIRVIEW</text>
<rect x="24" y="69" width="294" height="32" rx="3" fill="url(#jp-chrome)"/>
{interiors}
{far_side}
<g clip-path="url(#jp-bays)">{people}{curtains}<path d="M24 79H320" stroke="#7a4a22" stroke-width=".9"/></g>
<rect x="24" y="100.4" width="298" height="3.4" fill="url(#jp-chrome)"/>
<path d="M16 110C80 100 140 128 214 122C262 118 296 108 322 106V113C292 116 262 127 212 129.4C138 133 80 110 16 118Z" fill="#ffc83d"/>
<path d="M16 118C80 110 138 133 212 129.4C262 127 292 116 322 113V118C296 120 266 128.6 224 131H164C112 128 70 118 16 123Z" fill="#2f55e0"/>
<path d="M16 110C80 100 140 128 214 122C262 118 296 108 322 106" fill="none" stroke="#fff" stroke-width=".9" opacity=".85"/>
{ribs}
<g transform="translate(250 121) skewX(-10)"><text font-size="15" font-weight="800" letter-spacing=".6" text-anchor="middle" fill="#6d0f12" x=".8" y=".9">SAKAY NA!</text><text font-size="15" font-weight="800" letter-spacing=".6" text-anchor="middle" fill="#fff">SAKAY NA!</text></g>
<path d="M327 66H341L354 97V118H327Z" fill="#2a1b24"/>
<path d="M327 66H341L346 78H327Z" fill="#5a3d44"/>
<path d="M327 106H354V118H327Z" fill="#3f2a2f"/>
<circle cx="338" cy="82" r="5" fill="#170f16"/><rect x="336" y="86" width="4.6" height="5" fill="#8a5a43"/>
<path d="M329 110q0-20 9-20t10 12l-3 8z" fill="#efe6d2"/>
<path d="M346 96l10 4" stroke="#8a5a43" stroke-width="3" stroke-linecap="round"/>
<ellipse cx="357" cy="102" rx="1.8" ry="7" fill="none" stroke="#10131e" stroke-width="1.6"/>
<rect x="322" y="57" width="5" height="75" fill="url(#jp-chrome)"/>
<path d="M341 57h6l19 40h-6z" fill="#b42a26"/>
<path d="M347 57h4l19 40h-4z" fill="url(#jp-glass)" opacity=".92"/>
<path d="M348 70L374 58" stroke="#c9d1de" stroke-width="1.5"/>
<ellipse cx="377" cy="56" rx="4.2" ry="8.4" fill="url(#jp-chrome)"/>
<path d="M338 134C344 134 346 109 378 107C408 105 428 115 444 117.6Q453 119 455 134Z" fill="url(#jp-fender)"/>
<path d="M346 118C352 110 364 108 378 107C408 105 428 115 444 117.6L444 119C428 116.6 408 107 378 108.6C364 109 354 112 346 118Z" fill="#fff" opacity=".55"/>
<path d="M352 141a26 26 0 0 1 52 0z" fill="#07090f"/>
<path d="M100 141a26 26 0 0 1 52 0z" fill="#07090f"/>
<path d="M97 141a29 29 0 0 1 58 0" fill="none" stroke="url(#jp-chrome)" stroke-width="3"/>
<path d="M349 141a29 29 0 0 1 58 0" fill="none" stroke="#fbfcff" stroke-width="1.2" opacity=".6"/>
<rect x="156" y="130.4" width="188" height="7" rx="1.4" fill="url(#jp-chrome)"/>
<rect x="24" y="130.4" width="72" height="4" fill="url(#jp-chrome)"/>
<path d="M2 130h28v5H2z" fill="url(#jp-chrome)"/><path d="M12 57V130" stroke="#e4e9f2" stroke-width="2.6"/><path d="M6 78v52" stroke="#c7cfdc" stroke-width="1.6"/><path d="M6 78h6" stroke="#c7cfdc" stroke-width="1.6"/>
<rect x="15.6" y="106" width="4.4" height="17" rx="1.4" fill="#ff3b30"/><circle cx="17.8" cy="114" r="15" fill="url(#jp-red)"/>
<path d="M88 138h9v19h-9z" fill="#10121b"/><rect x="89" y="150" width="7" height="3" fill="#ffc83d"/>
<path d="M408 138h7v19h-7z" fill="#10121b"/>
<path d="M451 103.4L459 105L460 131H455Z" fill="url(#jp-chrome)"/>
{grille}
<circle cx="450" cy="114" r="22" fill="url(#jp-bloom)"/>
<circle cx="450" cy="114" r="7.4" fill="url(#jp-chrome)"/>
<circle cx="450" cy="114" r="5.6" fill="url(#jp-lens)"/>
<rect x="440" y="124" width="7" height="3" rx="1" fill="#ffae35"/>
<rect x="434" y="129" width="44" height="8.6" rx="3" fill="url(#jp-chrome)"/>
<path d="M467 129V109h3V129z" fill="url(#jp-chrome)"/><path d="M458 106h16v3.4h-16z" fill="url(#jp-chrome)"/>
<circle cx="470" cy="122" r="3.4" fill="#fff3c8"/><circle cx="470" cy="122" r="10" fill="url(#jp-bloom)"/>
<g fill="url(#jp-chrome)"><path d="{horse}" transform="translate(412 79.6)"/><path d="{horse}" transform="translate(424 80.4) scale(.86)"/></g>
'''


def wheel():
    ticks = ''.join(
        f'<rect x="-1" y="-24" width="2" height="3" fill="#232735" transform="rotate({a})"/>'
        for a in range(0, 360, 15)
    )
    lugs = ''.join(
        f'<circle cy="-7.4" r="1.2" fill="#3a4152" transform="rotate({a})"/>'
        for a in range(0, 360, 45)
    )
    spokes = ''.join(
        f'<path d="M-2.6 -13L2.6 -13L1.4 -6L-1.4 -6z" fill="#454d60" transform="rotate({a})"/>'
        for a in range(0, 360, 60)
    )
    return (
        '<circle r="24" fill="#090b11"/>'
        + ticks
        + '<circle r="21" fill="#13161f"/><circle r="15.4" fill="#0b0d14"/>'
        + '<circle r="14" fill="url(#jp-chrome)"/><circle r="11.8" fill="#c8d0dc"/>'
        + spokes
        + lugs
        + '<circle r="4.4" fill="url(#jp-chrome)"/><circle r="1.6" fill="#596072"/>'
    )


def mini():
    """The little jeepney that rides the progress rail."""
    return (
        '<rect x="1" y="3" width="30" height="9" rx="1.6" fill="#ffc83d"/>'
        '<path d="M31 6h7l3 3v3H31z" fill="#ffc83d"/>'
        '<rect y="1.6" width="33" height="2.4" rx="1.2" fill="#fff"/>'
        '<g fill="#3a2a10"><rect x="4" y="5" width="5" height="3.4"/><rect x="11" y="5" width="5" height="3.4"/>'
        '<rect x="18" y="5" width="5" height="3.4"/><rect x="25" y="5" width="4" height="3.4"/></g>'
        '<g fill="#10142c"><circle cx="9" cy="12.6" r="2.6"/><circle cx="33" cy="12.6" r="2.6"/></g>'
    )


def clouds():
    r = random.Random(5)
    base, lit = [], []
    for _ in range(11):
        x = r.randint(40, 1660)
        y = r.randint(40, 250)
        w = r.randint(130, 320)
        h = r.randint(5, 11)
        base.append(f'<ellipse cx="{x}" cy="{y}" rx="{w}" ry="{h}"/>')
        base.append(f'<ellipse cx="{x + w // 3}" cy="{y - h}" rx="{w // 2}" ry="{h - 1}"/>')
        lit.append(f'<ellipse cx="{x - w // 6}" cy="{y + h - 1}" rx="{w * 2 // 3}" ry="{max(2, h // 2)}"/>')
    return ''.join(base), ''.join(lit)


def train():
    out = []
    for i in range(3):
        x = i * 110
        out.append(rect(x, 5, 106, 23, '#dfe4f0', 'rx="4"'))
        out.append(rect(x, 5, 106, 4, '#aeb7cc', 'rx="3"'))
        out.append(rect(x, 21, 106, 4, '#2f55e0'))
        for w in range(5):
            wx = x + 8 + w * 19
            if w in (1, 3):
                out.append(rect(wx, 9, 11, 16, '#ffdc9a'))
                out.append(rect(wx + 5, 9, 0.8, 16, '#7d6a4a'))
            else:
                out.append(rect(wx, 10, 13, 8, '#ffdc9a'))
    out.append('<path d="M46 5l10-5h6" fill="none" stroke="#0d1128" stroke-width="1"/>')
    out.append('<path d="M266 5l10-5h6" fill="none" stroke="#0d1128" stroke-width="1"/>')
    return ''.join(out)
