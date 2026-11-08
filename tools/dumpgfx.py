#!/usr/bin/env python3
"""Vytáhne z obrazu hry **grafiku místností**: kulisové bloky a pravidla skládání.

    PYTHONPATH=tools/vendor ./tools/dumpgfx.py [--png] [--quiet]

Kulisu skládá hra ze čtyř kvadrantů podle jediného popisného bajtu místnosti
(rutina `$9DA0`, čtyři trojbitová pole, čtyři tabulky skoků na `$9DD6`,
`$9DE6`, `$9DF6`, `$9E06`). Každý kvadrant nakreslí jeden rohový blok a podle
bitů k němu přidá pruh stropu / podlahy nebo boční stěnu:

```
 bit 0 = strop uzavřen   bit 2 = pravá stěna   bit 4 = podlaha   bit 6 = levá stěna
```

Bloky mají tři geometrie (rutiny `$9C70`, `$9CB1`, `$9CF2`):

| druh | pozice (x, y) | pixely | atributy |
|---|---|---|---|
| pruh stropu | 24, 16 | 26 × 32 B | 4 × 26 buněk, konstanta `$42` |
| pruh podlahy | 24, 160 | 26 × 32 B | 4 × 26 buněk, konstanta `$4B` |
| levá / pravá stěna | 0 / 232, 48 | 3 × 112 B | 14 × 3 buněk, konstanta `$4D` |
| roh (4 pozice) | 0 / 232, 16 / 160 | 3 × 32 B | 4 × 3 buněk **uložené v bloku** |

Rohový blok je tedy 12 B atributů + 96 B pixelů = 108 B. Čtyři rohy, dva pruhy
a dvě stěny přesně vyplní hrací plochu 256 × 176 – nic se nepřekrývá.

Jeskyně (řádky 16–51) kreslí **osm vlastních rutin** `$99F5`–`$9BB8`, jedna na
každý bit popisného bajtu. Každá rutina má pevné místo na obrazovce, pevnou
geometrii a vlastní tabulku ukazatelů, ze které si kus grafiky vybírá podle
`sloupec + řádek` – proto vypadají jeskyně různě, i když mají stejný popisný
bajt (M4 to rozebral, viz `sources/docs/disasm_notes.md` §14.1):

| bit | rutina | pozice (x, y) | kusů | tabulka | index | atributy |
|---|---|---|---|---|---|---|
| 0 | `$99F5` | 24, 16 | 13 vedle sebe | `$9A33` | `rlc(s) & $1E`, pak `+2` | 26 × 4 buňky |
| 1 | `$9A53` | 232, 16 | 1 | `$9A96` | `+2·bit0 +4·bit2`, `(s<<3) & $18` | 3 × 4 |
| 2 | `$9AB6` | 232, 48 | 2 pod sebou | `$9BB0` | `rlc(s) & $06`, pak `+2` | 3 × 14 |
| 3 | `$9AF8` | 232, 160 | 1 | `$9B18` | `+2·bit4 +4·bit2` | 3 × 4 |
| 4 | `$9B38` | 24, 160 | 13 vedle sebe | `$9B44` | `rlc(s) & $1E` | 26 × 4 |
| 5 | `$9B64` | 0, 160 | 1 | `$9B84` | `+2·bit4 +4·bit6` | 3 × 4 |
| 6 | `$9BA4` | 0, 48 | 2 pod sebou | `$9AF0` | `rlc(s) & $06` | 3 × 14 |
| 7 | `$9BB8` | 0, 16 | 1 | `$9BD8` | `+2·bit0 +4·bit6` | 3 × 4 |

`s = (sloupec + řádek) & $FF`, `rlc` je rotace vlevo (instrukce `RLCA`).
Atribut je v jeskyních **konstanta `$46`** (u hradu má každé primitivum svou).
Pruhy a stěny si nesou dvoubajtovou hlavičku `(řádků, šířka v bajtech)`
(rutina `$9BF8`), rohy jsou vždy 3 × 32 B bez hlavičky (`BC = $0320`).
Kusy se **překrývají**: rohová grafika je okno do grafiky stěny (od jejího
2. a 74. bajtu) – originál tak šetří místo a remake to jen kopíruje.

Pozor: **`$6800–$6FFF` s jeskyněmi nemá nic společného** – jak zjistil M4, je to
tabulka nábytku 256 hradních místností (`tools/dumpentities.py`). Jeskynní
grafika leží v `$B81B–$CC88`.

Výstup: `data/scenery.json`, s `--png` navíc náhledy do `build/gfx/`.
Sestavení jeskynních místností z bloků se kontroluje proti originálu
(všech 351, cíl nula rozdílů) – stejně jako hradních v `tools/matchscreen.py`.
"""
import argparse, base64, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.join(HERE, '..')

from roomlib import Game, PLAY_LINES, PLAY_ROWS, PANEL_ROWS     # noqa: E402
from scr2png import scr_to_rgb, write_png                        # noqa: E402

# geometrie primitiv (rutiny $9C70 / $9CA7 / $9CB1 / $9CE8 / $9CF2 / $9D19 / $9D1E / $9D23)
PRIMITIVES = {
    'ceiling':    {'x': 24,  'y': 16,  'cols': 26, 'lines': 32,  'attr': 0x42, 'routine': '$9C70'},
    'floor':      {'x': 24,  'y': 160, 'cols': 26, 'lines': 32,  'attr': 0x4B, 'routine': '$9CA7'},
    'wallLeft':   {'x': 0,   'y': 48,  'cols': 3,  'lines': 112, 'attr': 0x4D, 'routine': '$9CB1'},
    'wallRight':  {'x': 232, 'y': 48,  'cols': 3,  'lines': 112, 'attr': 0x4D, 'routine': '$9CE8'},
    'cornerTL':   {'x': 0,   'y': 16,  'cols': 3,  'lines': 32,  'attr': None, 'routine': '$9CF2'},
    'cornerTR':   {'x': 232, 'y': 16,  'cols': 3,  'lines': 32,  'attr': None, 'routine': '$9D19'},
    'cornerBL':   {'x': 0,   'y': 160, 'cols': 3,  'lines': 32,  'attr': None, 'routine': '$9D1E'},
    'cornerBR':   {'x': 232, 'y': 160, 'cols': 3,  'lines': 32,  'attr': None, 'routine': '$9D23'},
}

# pravidla skládání: pro každé ze čtyř polí popisného bajtu (bity 0-2, 2-4, 4-6,
# 6-0) a pro každou hodnotu pole, kterou tabulka místností používá (2, 3, 6, 7),
# seznam (primitivum, adresa grafiky). Přepsané z rutin $9D88..$9D9A.
RULES = [
    {'field': 'bity 0-2 (strop, pravá stěna)', 'handlers': {
        2: ('$9D88', [('cornerTR', 0x858F)]),
        3: ('$9D28', [('ceiling', 0x7D27), ('cornerTR', 0x81AB)]),
        6: ('$9D30', [('cornerTR', 0x80D3), ('wallRight', 0x8217)]),
        7: ('$9D39', [('ceiling', 0x7D27), ('cornerTR', 0x7CBB), ('wallRight', 0x8217)])}},
    {'field': 'bity 2-4 (pravá stěna, podlaha)', 'handlers': {
        2: ('$9D8E', [('cornerBR', 0x84B7)]),
        3: ('$9D45', [('cornerBR', 0x77CB)]),
        6: ('$9D4A', [('cornerBR', 0x76F3), ('floor', 0x78A3)]),
        7: ('$9D53', [('cornerBR', 0x7BE3), ('floor', 0x78A3)])}},
    {'field': 'bity 4-6 (podlaha, levá stěna)', 'handlers': {
        2: ('$9D94', [('cornerBL', 0x8523)]),
        3: ('$9D5C', [('floor', 0x78A3), ('cornerBL', 0x7687)]),
        6: ('$9D64', [('cornerBL', 0x775F), ('wallLeft', 0x8367)]),
        7: ('$9D6D', [('cornerBL', 0x7837), ('wallLeft', 0x8367)])}},
    {'field': 'bity 6-0 (levá stěna, strop)', 'handlers': {
        2: ('$9D9A', [('cornerTL', 0x85FB)]),
        3: ('$9D76', [('cornerTL', 0x8067)]),
        6: ('$9D7C', [('cornerTL', 0x813F)]),
        7: ('$9D82', [('cornerTL', 0x7C4F)])}},
]

CASTLE_GFX = (0x7687, 0x8667)       # rozsah kulisové grafiky (zjištěno trasováním)
CAVE_ATTR = 0x46                    # jeskyně mají atribut konstantou (rutina $9C10)
CAVE_ROWS = 16                      # řádky >= 16 jsou jeskyně

# Osm jeskynních oblastí, jedna na každý bit popisného bajtu. `kind` je
# geometrie: 'strip' = 13 kusů vedle sebe, 'wall' = 2 kusy pod sebou,
# 'corner' = jeden kus 3 x 32 B bez hlavičky. `extra` jsou dva bity, které
# posouvají základ tabulky o +2 a +4 (rohy tím reagují na sousední stěny).
CAVE_REGIONS = (
    {'bit': 0, 'routine': '$99F5', 'x': 24,  'y': 16,  'kind': 'strip',
     'table': 0x9A33, 'pieces': 13, 'cells': (26, 4),  'extra': None},
    {'bit': 1, 'routine': '$9A53', 'x': 232, 'y': 16,  'kind': 'corner',
     'table': 0x9A96, 'pieces': 1,  'cells': (3, 4),   'extra': (0, 2)},
    {'bit': 2, 'routine': '$9AB6', 'x': 232, 'y': 48,  'kind': 'wall',
     'table': 0x9BB0, 'pieces': 2,  'cells': (3, 14),  'extra': None},
    {'bit': 3, 'routine': '$9AF8', 'x': 232, 'y': 160, 'kind': 'corner',
     'table': 0x9B18, 'pieces': 1,  'cells': (3, 4),   'extra': (4, 2)},
    {'bit': 4, 'routine': '$9B38', 'x': 24,  'y': 160, 'kind': 'strip',
     'table': 0x9B44, 'pieces': 13, 'cells': (26, 4),  'extra': None},
    {'bit': 5, 'routine': '$9B64', 'x': 0,   'y': 160, 'kind': 'corner',
     'table': 0x9B84, 'pieces': 1,  'cells': (3, 4),   'extra': (4, 6)},
    {'bit': 6, 'routine': '$9BA4', 'x': 0,   'y': 48,  'kind': 'wall',
     'table': 0x9AF0, 'pieces': 2,  'cells': (3, 14),  'extra': None},
    {'bit': 7, 'routine': '$9BB8', 'x': 0,   'y': 16,  'kind': 'corner',
     'table': 0x9BD8, 'pieces': 1,  'cells': (3, 4),   'extra': (0, 6)},
)
CORNER_GEOMETRY = (3, 0x20)         # roh: 3 bajty na řádek, 32 řádek (BC = $0320)
CLEAR_ATTR = 0x47                   # $99AB smaže plochu na papír černý, inkoust bílý, BRIGHT


def block_bytes(game, name, addr):
    """Bajty jednoho bloku: (atributy, pixely). Rohy mají atributy v sobě."""
    prim = PRIMITIVES[name]
    pixels = prim['cols']*prim['lines']
    if prim['attr'] is None:
        cells = prim['cols']*(prim['lines']//8)
        data = game.peek(addr, cells+pixels)
        return data[:cells], data[cells:]
    return None, game.peek(addr, pixels)


def word(game, addr):
    """Dvoubajtové slovo z obrazu hry."""
    lo, hi = game.peek(addr, 2)
    return lo | hi << 8


def rlc(value):
    """RLCA – rotace vlevo o jeden bit."""
    return (value << 1 | value >> 7) & 0xFF


def cave_pieces(game, region, desc, col, row):
    """Adresy kusů, které daná oblast v této místnosti nakreslí."""
    base = region['table']
    if region['extra']:
        first, second = region['extra']
        if desc >> first & 1:
            base += 2
        if desc >> second & 1:
            base += 4
    total = (col+row) & 0xFF
    if region['kind'] == 'corner':
        return [word(game, base + ((total << 3) & 0x18))]
    mask = 0x1E if region['kind'] == 'strip' else 0x06
    index, out = rlc(total) & mask, []
    for _ in range(region['pieces']):
        out.append(word(game, base + index))
        index = (index + 2) & mask
    return out


def cave_block(game, kind, addr):
    """Bajty jednoho jeskynního kusu: (šířka, řádků, pixely)."""
    if kind == 'corner':
        width, lines = CORNER_GEOMETRY
        return width, lines, game.peek(addr, width*lines)
    lines, width = game.peek(addr, 2)
    return width, lines, game.peek(addr+2, width*lines)


def compose_cave(game, col, row, desc):
    """Složí jeskynní místnost z bloků a pravidel – obdoba $9906 pro řádky >= 16."""
    bitmap = bytearray(PLAY_LINES*32)
    attrs = bytearray([CLEAR_ATTR]*(PLAY_ROWS*32))
    for region in CAVE_REGIONS:
        if not desc >> region['bit'] & 1:
            continue                            # otevřená strana se jen smaže
        for index, addr in enumerate(cave_pieces(game, region, desc, col, row)):
            width, lines, pixels = cave_block(game, region['kind'], addr)
            x = (region['x'] >> 3) + (2*index if region['kind'] == 'strip' else 0)
            y = region['y'] + (lines*index if region['kind'] == 'wall' else 0)
            for line in range(lines):
                at = (y+line-PANEL_ROWS*8)*32 + x
                bitmap[at:at+width] = pixels[line*width:(line+1)*width]
        cols, rows = region['cells']
        for line in range(rows):
            at = ((region['y'] >> 3)-PANEL_ROWS+line)*32 + (region['x'] >> 3)
            attrs[at:at+cols] = bytes([CAVE_ATTR])*cols
    return bytes(bitmap), bytes(attrs)


def cave_blocks(game):
    """Všechny jeskynní kusy, na které tabulky ukazují: adresa -> popis."""
    blocks = {}
    for region in CAVE_REGIONS:
        count = 16 if region['kind'] != 'wall' else 4
        for i in range(count):
            addr = word(game, region['table'] + 2*i)
            width, lines, pixels = cave_block(game, region['kind'], addr)
            key = '%s@%04X' % (region['kind'], addr)
            blocks[key] = {
                'kind': region['kind'], 'address': '$%04X' % addr,
                'cols': width, 'lines': lines,
                'header': 0 if region['kind'] == 'corner' else 2,
                'attribute': CAVE_ATTR,
                'bitmap': base64.b64encode(pixels).decode(),
            }
    return blocks


def check_caves(game, quiet=False):
    """Složí každou jeskynní místnost z bloků a porovná s originálem."""
    rooms = [(c, r, d) for c, r, d in game.rooms() if r >= CAVE_ROWS]
    bad = []
    for col, row, desc in rooms:
        if compose_cave(game, col, row, desc) != game.render(col, row):
            bad.append((col, row, desc))
    if not quiet:
        print('jeskynni mistnosti slozene z bloku: %d, rozdilnych %d'
              % (len(rooms), len(bad)))
        for col, row, desc in bad[:10]:
            print('  ROZDIL (%d,%d) desc=$%02X' % (col, row, desc))
    return len(rooms), bad


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--out', default=os.path.join(ROOT, 'data/scenery.json'))
    ap.add_argument('--png', action='store_true', help='náhledy do build/gfx/')
    ap.add_argument('--png-dir', default=os.path.join(ROOT, 'build/gfx'))
    ap.add_argument('--quiet', action='store_true')
    args = ap.parse_args()

    game = Game()

    blocks, used = {}, []
    for field in RULES:
        for value, (routine, elements) in sorted(field['handlers'].items()):
            for name, addr in elements:
                key = '%s@%04X' % (name, addr)
                if key in blocks:
                    continue
                attrs, pixels = block_bytes(game, name, addr)
                prim = PRIMITIVES[name]
                blocks[key] = {
                    'primitive': name, 'address': '$%04X' % addr,
                    'x': prim['x'], 'y': prim['y'],
                    'cols': prim['cols'], 'lines': prim['lines'],
                    'attribute': prim['attr'],
                    'attributes': base64.b64encode(attrs).decode() if attrs else None,
                    'bitmap': base64.b64encode(pixels).decode(),
                }
                used.append((addr, len(pixels)+(len(attrs) if attrs else 0), key))

    caves = cave_blocks(game)

    scenery = {
        'note': 'M2: kulisove bloky a pravidla skladani mistnosti, vytazene z '
                'obrazu hry (tools/dumpgfx.py). Bajty jsou skutecna data '
                'originalu; bitmapa bloku je po pixelovych radcich, atributy '
                'rohovych bloku jsou v datech bloku, u pruhu a sten je atribut '
                'konstanta z rutiny.',
        'clearAttribute': CLEAR_ATTR,
        'roomSize': {'width': 256, 'height': 176},
        'primitives': PRIMITIVES,
        'rules': [{'field': f['field'],
                   'handlers': {str(v): {'routine': r,
                                         'elements': [{'primitive': n,
                                                       'block': '%s@%04X' % (n, a)}
                                                      for n, a in e]}
                                for v, (r, e) in sorted(f['handlers'].items())}}
                  for f in RULES],
        'blocks': blocks,
        'castleGraphics': {'from': '$%04X' % CASTLE_GFX[0], 'to': '$%04X' % (CASTLE_GFX[1]-1),
                           'bytes': CASTLE_GFX[1]-CASTLE_GFX[0]},
        'caves': {
            'note': 'M4: osm jeskynnich oblasti, jedna na kazdy bit popisneho '
                    'bajtu; kus grafiky vybira tabulka podle (sloupec+radek). '
                    'Atribut je konstanta $46. Slozeni overeno proti originalu '
                    'na vsech 351 jeskynnich mistnostech, nula rozdilu.',
            'fromRow': CAVE_ROWS,
            'attribute': CAVE_ATTR,
            'cornerGeometry': {'cols': CORNER_GEOMETRY[0],
                               'lines': CORNER_GEOMETRY[1]},
            'regions': [{'bit': r['bit'], 'routine': r['routine'],
                         'x': r['x'], 'y': r['y'], 'kind': r['kind'],
                         'pieces': r['pieces'],
                         'attributeCols': r['cells'][0],
                         'attributeRows': r['cells'][1],
                         'table': '$%04X' % r['table'],
                         'extraBits': list(r['extra']) if r['extra'] else None,
                         'pointers': ['$%04X' % word(game, r['table']+2*i)
                                      for i in range(16 if r['kind'] != 'wall' else 4)]}
                        for r in CAVE_REGIONS],
            'blocks': caves,
        },
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, 'w') as f:
        json.dump(scenery, f, indent=1)
        f.write('\n')

    if args.png:
        os.makedirs(args.png_dir, exist_ok=True)
        sheet(os.path.join(args.png_dir, 'scenery_blocks.png'), blocks)
        raw_sheet(os.path.join(args.png_dir, 'cave_graphics.png'),
                  game.peek(*[CAVE_GFX[0], CAVE_GFX[1]-CAVE_GFX[0]]))

    if not args.quiet:
        print('bloku: %d (%d B dat)' % (len(blocks), sum(u[1] for u in used)))
        for addr, size, key in sorted(used):
            print('  $%04X  %-16s %4d B' % (addr, key.split('@')[0], size))
        gap = sorted((a, a+s) for a, s, _ in used)
        print('kulisova grafika: $%04X-$%04X, bloky pokryvaji %d z %d B'
              % (CASTLE_GFX[0], CASTLE_GFX[1]-1, sum(u[1] for u in used),
                 CASTLE_GFX[1]-CASTLE_GFX[0]))
        holes = [(gap[i][1], gap[i+1][0]) for i in range(len(gap)-1)
                 if gap[i][1] != gap[i+1][0]]
        print('nepokryte diry mezi bloky: %s'
              % (', '.join('$%04X-$%04X' % (a, b-1) for a, b in holes) or 'zadne'))
        print('jeskynnich bloku: %d (%d B dat, rozsah $%04X-$%04X)'
              % (len(caves), sum(len(base64.b64decode(b['bitmap'])) for b in caves.values()),
                 min(int(b['address'][1:], 16) for b in caves.values()),
                 max(int(b['address'][1:], 16)
                     + len(base64.b64decode(b['bitmap'])) for b in caves.values())-1))
        check_caves(game)
        print('%s: %d B' % (os.path.relpath(args.out, ROOT), os.path.getsize(args.out)))


def sheet(path, blocks, gap=8):
    """Náhled: každý blok vykreslený s vlastními atributy pod sebou."""
    rows = []
    for key in sorted(blocks, key=lambda k: blocks[k]['address']):
        b = blocks[key]
        cols, lines = b['cols'], b['lines']
        pixels = base64.b64decode(b['bitmap'])
        attrs = base64.b64decode(b['attributes']) if b['attributes'] else None
        scr = bytearray(6912)
        for line in range(lines):
            y = line
            third, char_row, pix = y >> 6, (y >> 3) & 7, y & 7
            base = (third << 11) | (pix << 8) | (char_row << 5)
            scr[base:base+cols] = pixels[line*cols:line*cols+cols]
        for cell in range(cols*(lines//8)):
            attr = attrs[cell] if attrs else b['attribute']
            scr[6144+(cell//cols)*32+cell % cols] = attr
        for line in scr_to_rgb(bytes(scr))[:lines]:
            rows.append(line[:cols*8*3])
        rows += [b'\x00'*(cols*8*3)]*gap
    width = max(len(r) for r in rows)//3
    rows = [r+b'\x00'*(width*3-len(r)) for r in rows]
    write_png(path, rows, width)
    print('nahled: %s (%d x %d)' % (path, width, len(rows)))


def raw_sheet(path, data, cols=8):
    """Monochromní výpis bajtů (na eyeball, ne na porovnávání)."""
    rows = []
    for line in range(0, len(data), cols):
        row = bytearray()
        for byte in data[line:line+cols]:
            for bit in range(7, -1, -1):
                row += b'\xff\xff\xff' if byte >> bit & 1 else b'\x00\x00\x00'
        rows.append(bytes(row)+b'\x00'*(cols*24-len(row)))
    write_png(path, rows, cols*8)
    print('nahled: %s (%d x %d)' % (path, cols*8, len(rows)))


if __name__ == '__main__':
    main()
