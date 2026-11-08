#!/usr/bin/env python3
"""Vytáhne z originálu **celý svět**: všech 598 místností a jejich propojení.

    PYTHONPATH=tools/vendor ./tools/dumprooms.py [--scr] [--quiet]

Nekreslí se nic vlastního: každou místnost nakreslí kód hry v simulátoru
(`roomlib.Game.render`, rutina `$9906`) a uloží se skutečné bajty videopaměti.

Výstup:

| soubor | co je uvnitř |
|---|---|
| `data/world.json` | mřížka 16 × 52, popisný bajt každé místnosti, otevřené strany, číslo varianty obrazu; celé jen několik kB |
| `data/rooms.json` | **100 unikátních obrazů** hrací plochy (5632 B bitmapy + 704 B atributů, base64) – všech 598 místností se z nich složí |
| `data/room000.json` | startovní místnost ve formátu z M1, aby aplikace M1 běžela dál (teď už z přesného vykreslení originálu, ne většinovým hlasem) |
| `build/rooms/*.scr` | s `--scr`: každá místnost jako 6912B obraz obrazovky (podklad pro `matchscreen.py`) |

Proč 100 obrazů na 598 místností: kulisu skládá hra ze čtyř kvadrantů podle
jednoho bajtu (16 kombinací, 15 se v tabulce vyskytuje) a v jeskyních k tomu
přidává grafiku vybranou podle `sloupec + řádek`. Různých pozadí je tedy
opravdu jen 100 – 15 v hradu a 85 v jeskyních.
"""
import argparse, base64, hashlib, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.join(HERE, '..')

from roomlib import (Game, COLS, ROWS, CASTLE_ROWS, PLAY_LINES, exits,      # noqa: E402
                     closed, to_scr)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--world', default=os.path.join(ROOT, 'data/world.json'))
    ap.add_argument('--rooms', default=os.path.join(ROOT, 'data/rooms.json'))
    ap.add_argument('--room000', default=os.path.join(ROOT, 'data/room000.json'))
    ap.add_argument('--scr', action='store_true',
                    help='uložit i každou místnost jako .scr do build/rooms/')
    ap.add_argument('--scr-dir', default=os.path.join(ROOT, 'build/rooms'))
    ap.add_argument('--quiet', action='store_true')
    args = ap.parse_args()

    game = Game()
    rooms = game.rooms()

    variants = []                       # unikátní obrazy v pořadí prvního výskytu
    variant_of = {}                     # hash -> index
    grid_desc = [['00']*COLS for _ in range(ROWS)]
    grid_var = [['FF']*COLS for _ in range(ROWS)]
    room_list = []

    if args.scr:
        os.makedirs(args.scr_dir, exist_ok=True)

    for col, row, desc in rooms:
        bitmap, attrs = game.render(col, row)
        key = hashlib.sha1(bitmap+attrs).digest()
        if key not in variant_of:
            variant_of[key] = len(variants)
            variants.append((bitmap, attrs))
        var = variant_of[key]
        grid_desc[row][col] = '%02X' % desc
        grid_var[row][col] = '%02X' % var
        room_list.append({'col': col, 'row': row, 'depth': row+1,
                          'descriptor': desc, 'variant': var,
                          'open': exits(desc), 'closed': closed(desc)})
        if args.scr:
            with open(os.path.join(args.scr_dir, 'r%02dc%02d.scr' % (row, col)), 'wb') as f:
                f.write(to_scr(bitmap, attrs))

    # ---- data/world.json: mřížka a propojení -------------------------------
    exists = {(r['col'], r['row']) for r in room_list}
    neighbours = 0
    for r in room_list:
        near = {}
        for name, dc, dr in (('left', -1, 0), ('right', 1, 0),
                             ('top', 0, -1), ('bottom', 0, 1)):
            pos = (r['col']+dc, r['row']+dr)
            if name in r['open'] and pos in exists:
                near[name] = list(pos)
        r['neighbours'] = near
        neighbours += len(near)

    world = {
        'note': 'M2: svet vytazeny z originalu (tools/dumprooms.py). Tabulka '
                'mistnosti je v hre na $7000, adresa = $7000 + 32*radek + '
                '2*sloupec; misto je popsane jednim bajtem, jehoz bity 0/2/4/6 '
                'jsou uzavrene strany (strop / prava / podlaha / leva).',
        'grid': {'cols': COLS, 'rows': ROWS, 'castleRows': CASTLE_ROWS},
        'roomSize': {'width': 256, 'height': PLAY_LINES},
        'roomCount': len(room_list),
        'variantCount': len(variants),
        'start': {'col': 9, 'row': 14, 'depth': 15},
        # po řádcích mřížky, 2 hexa znaky na místnost; "00" = místnost neexistuje
        'descriptors': [''.join(r) for r in grid_desc],
        # sousedi se dopocitaji: soused je vedlejsi misto v mrizce, ktere
        # existuje a strana k nemu je otevrena (bit v popisnem bajtu = 0)
        'neighbourCount': neighbours,
        # číslo varianty obrazu (index do data/rooms.json), "FF" = místnost neexistuje
        'variants': [''.join(r) for r in grid_var],
    }
    write_json(args.world, world)

    # ---- data/rooms.json: unikátní obrazy ---------------------------------
    packed = {
        'note': 'M2: unikatni obrazy hraci plochy, skutecne bajty videopameti '
                'originalu (tools/dumprooms.py). Bitmapa je ulozena linearne po '
                'pixelovych radcich (nelinearni adresovani Spectra se rozplete '
                'uz v nastroji). Ktera mistnost ma kterou variantu, je v '
                'data/world.json. Nacita se na vyzadani, ne v appData.',
        'width': 256, 'height': PLAY_LINES,
        'bitmapBytes': PLAY_LINES*32, 'attributeBytes': (PLAY_LINES//8)*32,
        'variants': [{'bitmap': b64(b), 'attributes': b64(a)} for b, a in variants],
    }
    write_json(args.rooms, packed)

    # ---- data/room000.json: startovní místnost ve formátu M1 --------------
    start = next(r for r in room_list if (r['col'], r['row']) == (9, 14))
    bitmap, attrs = game.render(start['col'], start['row'])
    old = {}
    if os.path.isfile(args.room000):
        old = json.load(open(args.room000))
    room000 = {
        'note': 'M2: startovni mistnost presne tak, jak ji kresli original '
                '(tools/dumprooms.py). Format je porad ten z M1, aby aplikace '
                'bezela bez zmeny; cely svet je v data/world.json + '
                'data/rooms.json.',
        'name': old.get('name', 'CASTLE HALL'),
        'column': start['col'], 'row': start['row'], 'depth': start['depth'],
        'descriptor': start['descriptor'], 'variant': start['variant'],
        'open': start['open'],
        'width': 256, 'height': PLAY_LINES,
        'floorY': floor_y(bitmap),
        'sabreman': old.get('sabreman', {'x': 64, 'y': 120}),
        'bitmap': b64(bitmap), 'attributes': b64(attrs),
    }
    write_json(args.room000, room000)

    if not args.quiet:
        print('mistnosti: %d (mrizka %d x %d = %d mist)'
              % (len(room_list), COLS, ROWS, COLS*ROWS))
        print('unikatnich obrazu: %d (hrad %d, jeskyne %d)'
              % (len(variants),
                 len({r['variant'] for r in room_list if r['row'] < CASTLE_ROWS}),
                 len({r['variant'] for r in room_list if r['row'] >= CASTLE_ROWS})))
        print('popisnych bajtu: %d unikatnich' % len({r['descriptor'] for r in room_list}))
        print('prechodu mezi mistnostmi: %d' % neighbours)
        for path in (args.world, args.rooms, args.room000):
            print('%s: %d B' % (rel(path), os.path.getsize(path)))
        if args.scr:
            print('%s: %d obrazu .scr' % (rel(args.scr_dir), len(room_list)))


def floor_y(bitmap):
    """Horní pixelová řádka podlahy: nejspodnější souvislý blok plných řádek.

    (M1 hledal *první* plnou řádku odshora a našel strop – proto tam byla
    `floorY: 0` a Sabreman ve stubu fyziky stál nad obrazovkou.)
    """
    full = [y for y in range(PLAY_LINES)
            if all(bitmap[y*32+col] for col in range(32))]
    if not full:
        return PLAY_LINES
    y = full[-1]
    while y-1 in full:
        y -= 1
    return y


def b64(data):
    return base64.b64encode(data).decode('ascii')


def rel(path):
    return os.path.relpath(os.path.abspath(path), os.path.abspath(ROOT))


def write_json(path, data):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, 'w') as f:
        json.dump(data, f, indent=1)
        f.write('\n')


if __name__ == '__main__':
    main()
