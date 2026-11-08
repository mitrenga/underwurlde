#!/usr/bin/env python3
"""Pixelově přesné porovnání dat remaku proti originálu, místnost po místnosti.

    PYTHONPATH=tools/vendor ./tools/matchscreen.py [--rooms 9,14] [--verbose]

Dvě nezávislé kontroly, obě proti tomu, co nakreslí **kód originálu** v
simulátoru (`roomlib.Game.render`):

1. **balík obrazů** – místnost složená z `data/world.json` (číslo varianty)
   a `data/rooms.json` (obraz varianty) se musí shodovat bajt po bajtu
   u všech 598 místností. Tím je ověřený celý datový řetěz včetně base64,
   deduplikace a indexu.
2. **skládání kulisy** – místnost se navíc složí z bloků a pravidel
   v `data/scenery.json` (tj. tak, jak je bude skládat remake) a musí vyjít
   stejné bajty. Tím je ověřené dekódování grafiky, atributů i rozvržení,
   ne jen zabalení hotových obrazů. Hrad (řádky 0–15) se skládá ze čtyř
   trojbitových polí popisného bajtu (`$9DA0`), jeskyně (řádky 16–51) z osmi
   oblastí, jedné na každý bit toho bajtu (`$99F5`–`$9BB8`) – ty rozebral M4,
   takže **kontrolu 2 mají od M4 všechny místnosti**.

Cíl je **nula rozdílů a nula nevysvětlených pixelů**; jinak končí kódem 1.
"""
import argparse, base64, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.join(HERE, '..')

from roomlib import Game, CASTLE_ROWS, PLAY_LINES, PANEL_ROWS   # noqa: E402
from dumpgfx import compose_cave                                # noqa: E402

PLAY_TOP = PANEL_ROWS*8         # hrací plocha začíná na pixelovém řádku 16


def field_values(desc):
    """Čtyři trojbitová pole popisného bajtu, jak je bere rutina $9DA0."""
    return (desc & 7, desc >> 2 & 7, desc >> 4 & 7, (desc << 2 | desc >> 6) & 7)


def compose(scenery, desc):
    """Složí kulisu z bloků – tohle bude dělat remake."""
    bitmap = bytearray(PLAY_LINES*32)
    attrs = bytearray([scenery['clearAttribute']]*(PLAY_LINES//8*32))
    for index, value in enumerate(field_values(desc)):
        handler = scenery['rules'][index]['handlers'].get(str(value))
        if handler is None:
            raise SystemExit('popisny bajt $%02X: pole %d ma hodnotu %d, '
                             'pro kterou nemam pravidlo' % (desc, index, value))
        for element in handler['elements']:
            block = scenery['blocks'][element['block']]
            draw(bitmap, attrs, block)
    return bytes(bitmap), bytes(attrs)


def draw(bitmap, attrs, block):
    cols, lines = block['cols'], block['lines']
    x, y = block['x']//8, block['y']-PLAY_TOP
    pixels = base64.b64decode(block['bitmap'])
    for line in range(lines):
        row = y+line
        bitmap[row*32+x:row*32+x+cols] = pixels[line*cols:line*cols+cols]
    own = base64.b64decode(block['attributes']) if block['attributes'] else None
    for cell_row in range(lines//8):
        for cell_col in range(cols):
            value = (own[cell_row*cols+cell_col] if own is not None
                     else block['attribute'])
            attrs[(y//8+cell_row)*32+x+cell_col] = value


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--world', default=os.path.join(ROOT, 'data/world.json'))
    ap.add_argument('--pack', default=os.path.join(ROOT, 'data/rooms.json'))
    ap.add_argument('--scenery', default=os.path.join(ROOT, 'data/scenery.json'))
    ap.add_argument('--rooms', help='jen vybrane mistnosti: "sloupec,radek;..."')
    ap.add_argument('--verbose', action='store_true')
    args = ap.parse_args()

    for path in (args.world, args.pack, args.scenery):
        if not os.path.isfile(path):
            raise SystemExit('chybi %s – spust tools/dumprooms.py a tools/dumpgfx.py'
                             % os.path.relpath(path, ROOT))
    world = json.load(open(args.world))
    pack = json.load(open(args.pack))
    scenery = json.load(open(args.scenery))

    game = Game()
    wanted = None
    if args.rooms:
        wanted = {tuple(int(n) for n in part.split(','))
                  for part in args.rooms.replace(';', ' ').split()}

    checked = pack_bad = compose_bad = composed = 0
    first = []
    for col, row, desc in game.rooms():
        if wanted and (col, row) not in wanted:
            continue
        original = game.render(col, row)
        checked += 1

        variant = int(world['variants'][row][col*2:col*2+2], 16)
        stored = pack['variants'][variant]
        packed = (base64.b64decode(stored['bitmap']),
                  base64.b64decode(stored['attributes']))
        if packed != original:
            pack_bad += 1
            if len(first) < 8:
                first.append(('balik', col, row, diff(packed, original)))
        if int(world['descriptors'][row][col*2:col*2+2], 16) != desc:
            raise SystemExit('data/world.json: popisny bajt mistnosti (%d,%d) '
                             'nesouhlasi s originalem' % (col, row))

        composed += 1
        built = (compose(scenery, desc) if row < CASTLE_ROWS
                 else compose_cave(game, col, row, desc))
        if built != original:
            compose_bad += 1
            if len(first) < 8:
                first.append(('skladani', col, row, diff(built, original)))
        if args.verbose:
            print('(%2d,%2d) $%02X varianta %2d: %s' % (col, row, desc, variant,
                  'ok' if packed == original else 'NESOUHLASI'))

    print('zkontrolovano mistnosti: %d' % checked)
    print('  balik obrazu (data/world.json + data/rooms.json): %d rozdilnych'
          % pack_bad)
    print('  skladani kulisy z bloku a pravidel: %d z %d rozdilnych'
          % (compose_bad, composed))
    for kind, col, row, (bits, cells) in first:
        print('    %s (%d,%d): %d bajtu bitmapy, %d atributu' % (kind, col, row, bits, cells))
    if pack_bad or compose_bad:
        sys.exit(1)
    print('  nula rozdilu, nula nevysvetlenych pixelu')


def diff(a, b):
    return (sum(1 for i in range(len(a[0])) if a[0][i] != b[0][i]),
            sum(1 for i in range(len(a[1])) if a[1][i] != b[1][i]))


if __name__ == '__main__':
    main()
