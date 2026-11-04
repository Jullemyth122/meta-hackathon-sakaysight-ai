"""
Builds the loading screen: python scripts/splash/build.py

Bakes the scenery in art.py into public/splash/*.webp (render.mjs) and fills
page.html with what stays a vector, into index.html. Scenery is a tile that
repeats as it scrolls, so as an image it costs nothing to keep moving. The
jeepney never leaves the screen, and stays sharp as a vector.
"""
import json
import os
import re
import runpy
import subprocess
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
art = runpy.run_path(os.path.join(HERE, 'art.py'), run_name='lib')

FONTS = re.search(
    r'href="(https://fonts\.googleapis\.com/css2[^"]+)"',
    open(os.path.join(REPO, 'index.html'), encoding='utf8').read(),
).group(1)

mid = art['mid']()
cloud_base, cloud_lit = art['clouds']()
clouds = f'''
<g fill="#3f3f7c" opacity=".62" filter="url(#sp-haze)">{cloud_base}</g>
<g fill="#f19a6c" opacity=".5" filter="url(#sp-haze)">{cloud_lit}</g>'''

DEFS = '''
<filter id="sp-haze" x="-5%" y="-100%" width="110%" height="300%"><feGaussianBlur stdDeviation="5 2.4"/></filter>
<linearGradient id="sk-far-fill" gradientUnits="userSpaceOnUse" x1="0" y1="70" x2="0" y2="320"><stop offset="0" stop-color="#4c4a88"/><stop offset="1" stop-color="#9a6a84"/></linearGradient>
<linearGradient id="sk-face" gradientUnits="userSpaceOnUse" x1="0" y1="40" x2="0" y2="320"><stop offset="0" stop-color="#232c5c"/><stop offset="1" stop-color="#141a42"/></linearGradient>
<linearGradient id="sk-side" gradientUnits="userSpaceOnUse" x1="0" y1="40" x2="0" y2="320"><stop offset="0" stop-color="#6a4c74"/><stop offset="1" stop-color="#3a2c58"/></linearGradient>
<linearGradient id="sp-pier" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#141938"/><stop offset="1" stop-color="#262a54"/></linearGradient>
<linearGradient id="sp-shop" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff0c6"/><stop offset="1" stop-color="#ffb868"/></linearGradient>
<linearGradient id="sp-board" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2f55e0"/><stop offset="1" stop-color="#16256e"/></linearGradient>
<filter id="sp-soft" x="-30%" y="-10%" width="160%" height="120%"><feGaussianBlur stdDeviation="9"/></filter>
<linearGradient id="sp-cone" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe7ac" stop-opacity=".26"/><stop offset="1" stop-color="#ffd488" stop-opacity=".03"/></linearGradient>
<radialGradient id="sp-pool"><stop offset="0" stop-color="#ffe2a0" stop-opacity=".34"/><stop offset="1" stop-color="#ffcf80" stop-opacity="0"/></radialGradient>
<radialGradient id="sp-bulb"><stop offset="0" stop-color="#fff6d8" stop-opacity=".85"/><stop offset=".35" stop-color="#ffe2a0" stop-opacity=".3"/><stop offset="1" stop-color="#ffd488" stop-opacity="0"/></radialGradient>
<linearGradient id="sp-walk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3f415f"/><stop offset="1" stop-color="#2a2c45"/></linearGradient>
<linearGradient id="sp-concrete" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#20233e"/><stop offset="1" stop-color="#3f4064"/></linearGradient>
<linearGradient id="sp-can" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#2d3350"/><stop offset=".6" stop-color="#555d7e"/><stop offset="1" stop-color="#7a7e9c"/></linearGradient>
'''

# Clouds drift past a tile's edge: once each side of it too, so the tile joins up.
LAYERS = [
    (
        'clouds',
        1800,
        300,
        f'<g id="sk-cl">{clouds}</g><use href="#sk-cl" x="-1800"/><use href="#sk-cl" x="1800"/>',
    ),
    ('far', 2400, 320, f'<path d="{art["far"]()}" fill="url(#sk-far-fill)"/>'),
    (
        'mid',
        2400,
        320,
        f'<path d="{mid["sides"]}" fill="url(#sk-side)"/>'
        f'<path d="{mid["faces"]}" fill="url(#sk-face)"/>{mid["trim"]}'
        f'<path d="{mid["dim"]}" fill="#c98b58" opacity=".62"/>'
        f'<path d="{mid["warm"]}" fill="#ffd382"/>'
        f'<path d="{mid["cool"]}" fill="#c5dcff" opacity=".85"/>',
    ),
    ('viaduct', 840, 200, art['viaduct']()),
    ('street', 2400, 170, art['street']()),
    ('poles', 900, 460, art['poles']()),
]

sheet = ''.join(
    f'<svg width="{w}" height="{h}" style="display:block;overflow:hidden">{body}</svg>'
    for _, w, h, body in LAYERS
)
with tempfile.TemporaryDirectory() as tmp:
    page = os.path.join(tmp, 'layers.html')
    listing = os.path.join(tmp, 'layers.json')
    open(page, 'w', encoding='utf8').write(
        f'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="{FONTS}">'
        '<style>html,body{margin:0;background:transparent;font-family:Inter,sans-serif}</style>'
        f'<svg width="0" height="0" style="position:absolute"><defs>{DEFS}</defs></svg>{sheet}'
    )
    json.dump(
        [{'name': name, 'width': w, 'height': h} for name, w, h, _ in LAYERS],
        open(listing, 'w', encoding='utf8'),
    )
    subprocess.run(['node', os.path.join(HERE, 'render.mjs'), page, listing], check=True)

fills = {
    'FONTS': FONTS,
    'TRAIN': art['train'](),
    'JEEP': art['jeepney'](),
    'WHEEL': art['wheel'](),
    'MINI': art['mini'](),
}
src = open(os.path.join(HERE, 'page.html'), encoding='utf8').read()
for key, value in fills.items():
    src = src.replace(f'@@{key}@@', value)
assert '@@' not in src, re.findall(r'@@\w+@@', src)

index = os.path.join(REPO, 'index.html')
tmp = index + '.new'
open(tmp, 'w', encoding='utf8', newline='\n').write(src)
os.replace(tmp, index)
print('index.html', len(src), 'bytes')
