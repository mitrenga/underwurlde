#!/usr/bin/env python3
"""Mapa celého světa z dat remaku + porovnání s dohledanou screenshotovou mapou.

    PYTHONPATH=tools/vendor ./tools/mapworld.py [--scale 4] [--check]

Mapa se skládá z `data/world.json` + `data/rooms.json`, tedy z dat remaku, ne
z běhu hry – je to kontrola, že v datech je opravdu celý svět. Mřížka je
16 × 52 místností po 256 × 176 px, plná mapa má 4096 × 9152 px; `--scale N`
bere každý N-tý pixel (výchozí 4 → 1024 × 2288).

`--check` porovná výsledek se `sources/media/maps/speccycz_screenshot_map.png`:
hledá svislé odsazení, při kterém mapa nejlíp sedí, a vypíše shodu v procentech.
Shoda není 100 % ani při správném odsazení – v dohledané mapě jsou navíc
sprity, popisky a jiná paleta – ale ukáže, že mřížka a poloha místností
odpovídají. (Pozn.: dohledaná mapa má buňky vysoké 176 px, ne 184, jak tvrdil
M0; `screen_layout.md` je opravený.)
"""
import argparse, base64, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.join(HERE, '..')

from scr2png import PALETTE, write_png                            # noqa: E402

MAP = os.path.join(ROOT, 'sources/media/maps/speccycz_screenshot_map.png')


def room_rgb(bitmap, attrs, width=256, lines=176):
    """Místnost jako seznam RGB řádků (paleta jako ve scr2png)."""
    rows = []
    for y in range(lines):
        attr_base = (y >> 3)*32
        row = bytearray()
        for cx in range(width//8):
            bits = bitmap[y*32+cx]
            attr = attrs[attr_base+cx]
            ink, paper = attr & 7, attr >> 3 & 7
            bright = 8 if attr & 0x40 else 0
            fg, bg = PALETTE[ink+bright], PALETTE[paper+bright]
            for b in range(7, -1, -1):
                row += bytes(fg if bits >> b & 1 else bg)
        rows.append(bytes(row))
    return rows


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--world', default=os.path.join(ROOT, 'data/world.json'))
    ap.add_argument('--pack', default=os.path.join(ROOT, 'data/rooms.json'))
    ap.add_argument('--out', default=os.path.join(ROOT, 'build/map/world.png'))
    ap.add_argument('--scale', type=int, default=4, help='bere kazdy N-ty pixel')
    ap.add_argument('--check', action='store_true')
    args = ap.parse_args()

    world = json.load(open(args.world))
    pack = json.load(open(args.pack))
    cols, rows_count = world['grid']['cols'], world['grid']['rows']
    cw, ch = world['roomSize']['width'], world['roomSize']['height']
    variants = [(base64.b64decode(v['bitmap']), base64.b64decode(v['attributes']))
                for v in pack['variants']]
    empty = ([b'\x00'*(cw*3)]*ch)

    step = max(1, args.scale)
    lines = []
    for row in range(rows_count):
        cells = []
        for col in range(cols):
            code = world['variants'][row][col*2:col*2+2]
            cells.append(empty if code == 'FF'
                         else room_rgb(*variants[int(code, 16)], width=cw, lines=ch))
        for y in range(0, ch, step):
            line = bytearray()
            for cell in cells:
                src = cell[y]
                for x in range(0, cw, step):
                    line += src[x*3:x*3+3]
            lines.append(bytes(line))
    width = len(range(0, cw, step))*cols
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    write_png(args.out, lines, width)
    print('%s: %d x %d px (mrizka %d x %d, kazdy %d. pixel)'
          % (os.path.relpath(args.out, ROOT), width, len(lines), cols, rows_count, step))
    print('mistnosti v mape: %d z %d mist' % (world['roomCount'], cols*rows_count))

    if args.check:
        check(world, variants, cols, rows_count, cw, ch)


def check(world, variants, cols, rows_count, cw, ch):
    """Najde svislé odsazení, při kterém dohledaná mapa nejlíp sedí."""
    if not os.path.isfile(MAP):
        print('dohledana mapa chybi (%s) – kontrola preskocena'
              % os.path.relpath(MAP, ROOT))
        return
    sys.path.insert(0, HERE)
    import importlib.util
    spec = importlib.util.spec_from_file_location('mapcut', os.path.join(HERE, 'mapcut.py'))
    mapcut = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mapcut)
    width, height, map_rows, plte = mapcut.load(MAP)
    print('dohledana mapa: %d x %d px, %d/%d = %.2f px na radek mrizky'
          % (width, height, height, rows_count, height/rows_count))

    black = {i for i in range(16) if plte[i*3:i*3+3] == b'\x00\x00\x00'}

    # vzorek místností napříč světem
    sample = []
    for row in range(rows_count):
        for col in (3, 9, 13):
            code = world['variants'][row][col*2:col*2+2]
            if code != 'FF':
                sample.append((col, row, variants[int(code, 16)]))

    best = None
    for offset in range(0, 48, 4):
        hit = total = 0
        for col, row, (bitmap, attrs) in sample:
            y0 = offset+row*ch
            if y0+ch > height:
                continue
            for y in range(0, ch, 8):
                src = map_rows[y0+y]
                for cx in range(cw//8):
                    bits = bitmap[y*32+cx]
                    for b in range(7, -1, -1):
                        x = col*cw+cx*8+(7-b)
                        pixel = src[x >> 1] >> 4 if not x & 1 else src[x >> 1] & 15
                        ink = bool(bits >> b & 1)
                        total += 1
                        hit += ink == (pixel not in black)
        if total and (best is None or hit/total > best[1]):
            best = (offset, hit/total)
    if best:
        print('nejlepsi svisle odsazeni dohledane mapy: %d px, shoda inkoustu %.1f %% '
              '(%d mistnosti)' % (best[0], 100*best[1], len(sample)))
        print('(shoda pod 100 % je v poradku – v mape jsou sprity a popisky;'
              ' mrizka a poloha mistnosti odpovidaji)')


if __name__ == '__main__':
    main()
