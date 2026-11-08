#!/usr/bin/env python3
"""Vytáhne originální znakovou sadu hry do `data/font.json` pro remake.

    ./tools/mkfont.py [build/underwurlde-run.bin] [data/font.json]

Totéž místo v paměti jako `dumpfont.py` (glyfy od **$ED24**, index = ASCII kód,
8 bajtů na glyf, mezera mapovaná na `$3D` rutinou na `$98DF` – viz
`sources/docs/disasm_notes.md` §3), jen výstupem není PNG sheet, ale JSON
`{znak: "8 bajtů hex"}`, kterým `app/screenComposer.js` kreslí panel hry.
Font má jen číslice a velká písmena – to, co má originál.
"""
import json, os, sys

BASE = 0xED24
SPACE = 0x3D
CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'


def main(argv):
    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
    src = argv[1] if len(argv) > 1 else os.path.join(root, 'build/underwurlde-run.bin')
    dst = argv[2] if len(argv) > 2 else os.path.join(root, 'data/font.json')
    ram = open(src, 'rb').read()
    if len(ram) != 49152:
        raise SystemExit('cekam 49152 B RAM ($4000-$FFFF), mam %d' % len(ram))

    glyphs = {}
    for c in ' ' + CHARS:
        addr = BASE + (SPACE if c == ' ' else ord(c))*8
        glyphs[c] = ram[addr-0x4000:addr-0x4000+8].hex().upper()

    font = {
        'note': 'originální znaková sada hry z $ED24 (tools/mkfont.py); '
                'jen mezera, číslice a velká písmena – víc originál nemá',
        'base': '$%04X' % BASE,
        'height': 8, 'width': 8,
        'glyphs': glyphs
    }
    os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
    with open(dst, 'w') as f:
        json.dump(font, f, indent=2, sort_keys=True)
        f.write('\n')
    print('%s (%d glyfu)' % (dst, len(glyphs)))


if __name__ == '__main__':
    main(sys.argv)
