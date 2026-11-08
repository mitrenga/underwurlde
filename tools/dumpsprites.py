#!/usr/bin/env python3
"""Vytáhne z obrazu hry **všechny sprity** (Sabreman, nepřátelé, zbraně, strážci).

    PYTHONPATH=tools/vendor ./tools/dumpsprites.py [--png] [--ascii 09]

Hra má tabulku spritů na **`$9332`**: dvoubajtový ukazatel pro každý typ entity
(index je `(IX+0)`, rutina `$9652`), 145 typů `$00–$90` (tabulka končí na
`$9453`, dál začíná kód). Sprite sám je:

```
 bajt 0   šířka v bajtech (rutina $9689 ji zvětší o 1, když sprite přesahuje buňku)
 bajt 1   výška v pixelových řádcích
 dál      bitmapa, řádky **odspodu nahoru** (hra kreslí zdola, viz $9689/$97E7)
```

Atribut ve spritu není – barvu bere blitter ze záznamu entity, takže se
attribute clash reprodukuje až při kreslení (viz `mksprite.py` a M6).

**Až na hradní nábytek.** Typy `$79–$7E` se kreslí jinou cestou (`$EB39` →
`$E675`) a ta si barvy **nebere ze záznamu**, ale kopíruje je z bloku, na který
ukazuje tabulka na `$EB72`: `šířka × (výška/8)` bajtů, **řádky odspodu nahoru**
jako u bitmapy. Proto je knihovna ve startovní místnosti dvoubarevná – to je ta
otevřená otázka „barva nábytku" ze ZADANI, uzavřená v M6. Bloky jsou ve výstupu
pod `attributeBlocks`.

Ověření: typ `$09` (stojící Sabreman) se po převrácení řádek musí shodovat
s pózou vyříznutou z běhu originálu v M1 (`data/sprites.json`, `stand`).

Výstup: `data/spriteframes.json` (všechny rámy, base64 bajtů zdola nahoru
převrácených na normální pořadí) a s `--png` náhledový list `build/gfx/sprites.png`.
"""
import argparse, base64, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.join(HERE, '..')

from roomlib import Game                                        # noqa: E402
from scr2png import write_png                                    # noqa: E402

SPRITE_TABLE = 0x9332
SPRITE_TYPES = 0x91             # $00-$90 (tabulka končí na $9453)

DECOR_TABLE = 0xEB72            # ukazatele na bloky atributů nábytku ($EB68)
DECOR_FIRST = 0x79              # tabulka je indexovaná od tohohle typu ($EB61)
DECOR_LAST = 0x7E               # poslední typ, který má blok (šest položek)
# instrukce, kterými se to ověřuje: SUB $79 / SLA A / LD HL,$EB72 v $EB5E
DECOR_CHECK = (0xEB5E, [0xDD, 0x7E, 0x00, 0xD6, DECOR_FIRST, 0xCB, 0x27,
                        0x5F, 0x16, 0x00, 0x21, DECOR_TABLE & 0xFF,
                        DECOR_TABLE >> 8])


def decor_blocks(game, frames, types):
    """Bloky atributů hradního nábytku ($EB72 → $DCxx), řádky odspodu nahoru."""
    addr, pattern = DECOR_CHECK
    got = list(game.peek(addr, len(pattern)))
    if got != pattern:
        raise SystemExit('$%04X neni ta tabulka nabytku: %s'
                         % (addr, ' '.join('%02X' % b for b in got)))
    out = {}
    for kind in range(DECOR_FIRST, DECOR_LAST+1):
        at = DECOR_TABLE + 2*(kind-DECOR_FIRST)
        block = game.peek(at, 1)[0] | game.peek(at+1, 1)[0] << 8
        entry = types[kind]
        if entry['frame'] is None:
            raise SystemExit('typ $%02X ma blok atributu, ale nema sprite' % kind)
        frame_data = frames[entry['address']]
        cols, rows = frame_data['cols'], frame_data['lines']//8
        data = game.peek(block, cols*rows)
        # stejně jako bitmapa: v paměti odspodu nahoru, tady shora dolů
        lines = [data[i*cols:(i+1)*cols] for i in range(rows)]
        out['$%02X' % kind] = {
            'address': '$%04X' % block, 'cols': cols, 'rows': rows,
            'attributes': base64.b64encode(b''.join(reversed(lines))).decode(),
        }
    return out


def frame(game, addr):
    """(šířka v bajtech, výška, bitmapa shora dolů) nebo None, když sprite není."""
    cols, lines = game.peek(addr, 2)
    if not cols or not lines:
        return None
    data = game.peek(addr+2, cols*lines)
    rows = [data[i*cols:(i+1)*cols] for i in range(lines)]
    return cols, lines, b''.join(reversed(rows))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--out', default=os.path.join(ROOT, 'data/spriteframes.json'))
    ap.add_argument('--png', action='store_true')
    ap.add_argument('--png-dir', default=os.path.join(ROOT, 'build/gfx'))
    ap.add_argument('--ascii', help='vypsat sprite daneho typu jako ASCII (hex)')
    ap.add_argument('--quiet', action='store_true')
    args = ap.parse_args()

    game = Game()
    types, frames, index = [], {}, {}
    for kind in range(SPRITE_TYPES):
        addr = game.peek(SPRITE_TABLE+2*kind, 1)[0] | game.peek(SPRITE_TABLE+2*kind+1, 1)[0] << 8
        got = frame(game, addr)
        if got is None:
            types.append({'type': kind, 'address': '$%04X' % addr, 'frame': None})
            continue
        cols, lines, bitmap = got
        key = '$%04X' % addr
        if key not in frames:
            frames[key] = {'address': key, 'cols': cols, 'lines': lines,
                           'width': cols*8, 'height': lines,
                           'bitmap': base64.b64encode(bitmap).decode()}
            index[key] = len(index)
        types.append({'type': kind, 'address': key, 'frame': index[key]})

    if args.ascii is not None:
        kind = int(args.ascii, 16)
        key = types[kind]['address']
        f = frames.get(key)
        if not f:
            raise SystemExit('typ $%02X sprite nema' % kind)
        print('typ $%02X: %s, %d x %d px' % (kind, key, f['width'], f['height']))
        bitmap = base64.b64decode(f['bitmap'])
        for line in range(f['lines']):
            print('  '+''.join('#' if bitmap[line*f['cols']+col] >> bit & 1 else '.'
                               for col in range(f['cols']) for bit in range(7, -1, -1)))

    check = verify(frames, types)

    out = {
        'note': 'M2: sprity z tabulky $9332 obrazu hry (tools/dumpsprites.py). '
                'Bitmapa je uz prevracena do poradi shora dolu; v hre je ulozena '
                'odspodu nahoru. Atribut (barva) ve spritu neni – bere se ze '
                'zaznamu entity, viz M6.',
        'table': '$%04X' % SPRITE_TABLE, 'types': SPRITE_TYPES,
        'verified': check,
        'frames': [frames[k] for k in sorted(frames, key=lambda k: index[k])],
        'byType': types,
        'attributeBlocks': {
            'note': 'M6: hradni nabytek ($79-$7E) si barvy nebere ze zaznamu '
                    'entity, ale z bloku, na ktery ukazuje tabulka $EB72 '
                    '($EB39 -> $E675). Radky jsou tu shora dolu, jako bitmapa.',
            'table': '$%04X' % DECOR_TABLE,
            'blocks': decor_blocks(game, frames, types),
        },
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, 'w') as f:
        json.dump(out, f, indent=1)
        f.write('\n')

    if args.png:
        os.makedirs(args.png_dir, exist_ok=True)
        sheet(os.path.join(args.png_dir, 'sprites.png'),
              [frames[k] for k in sorted(frames, key=lambda k: index[k])])

    if not args.quiet:
        print('typu entit: %d, z toho bez spritu: %d'
              % (len(types), sum(1 for t in types if t['frame'] is None)))
        print('unikatnich ramu: %d, %d B dat'
              % (len(frames), sum(f['cols']*f['lines'] for f in frames.values())))
        print('nejvetsi ram: %s' % max(('%d x %d px (%s)' % (f['width'], f['height'], f['address'])
                                        for f in frames.values()),
                                       key=lambda s: int(s.split(' x ')[1].split(' ')[0])))
        print('kontrola proti M1 (typ $09 = stojici Sabreman): %s' % check)
        print('%s: %d B' % (os.path.relpath(args.out, ROOT), os.path.getsize(args.out)))


def verify(frames, types):
    """Porovná typ $09 s pózou vyříznutou z běhu originálu v M1."""
    path = os.path.join(ROOT, 'data/sprites.json')
    if not os.path.isfile(path):
        return 'data/sprites.json chybi, nekontrolovano'
    stand = json.load(open(path)).get('sabreman', {}).get('frames', {}).get('stand')
    if not stand:
        return 'data/sprites.json nema pozu stand, nekontrolovano'
    f = frames[types[9]['address']]
    mine = base64.b64decode(f['bitmap'])
    theirs = base64.b64decode(stand['bitmap'])
    if f['cols'] != stand['cols']:
        return 'sirka nesouhlasi (%d vs %d bajtu)' % (f['cols'], stand['cols'])
    # M1 pózu vyřízl v mřížce buněk, takže má navíc prázdné řádky – najdi posun
    for shift in range(stand['height']-f['lines']+1):
        chunk = theirs[shift*f['cols']:(shift+f['lines'])*f['cols']]
        if chunk == mine:
            return ('shoda bajt po bajtu s M1 pozou (posun %d radek v mrizce bunek)'
                    % shift)
    return 'NESOUHLASI s M1 pozou'


def sheet(path, frames, gap=2, per_row=16):
    cell_w = max(f['cols']*8 for f in frames)+gap
    cell_h = max(f['lines'] for f in frames)+gap
    rows_count = (len(frames)+per_row-1)//per_row
    rows = [bytearray(b'\x00'*(cell_w*per_row*3)) for _ in range(cell_h*rows_count)]
    for n, f in enumerate(frames):
        bitmap = base64.b64decode(f['bitmap'])
        ox, oy = (n % per_row)*cell_w, (n//per_row)*cell_h
        for line in range(f['lines']):
            for col in range(f['cols']):
                byte = bitmap[line*f['cols']+col]
                for bit in range(8):
                    if byte >> (7-bit) & 1:
                        x = ox+col*8+bit
                        rows[oy+line][x*3:x*3+3] = b'\xff\xff\xff'
    write_png(path, [bytes(r) for r in rows], cell_w*per_row)
    print('nahled: %s (%d ramu)' % (path, len(frames)))


if __name__ == '__main__':
    main()
