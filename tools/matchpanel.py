#!/usr/bin/env python3
"""Porovná panel remaku se snímkem z běžícího originálu, bajt po bajtu.

    ./tools/matchpanel.py [build/diff00280.scr] [--score 0 --gems 0 --depth 15 --lives 6]

Sestaví znakové řádky 0–1 přesně tak, jak je staví `app/screenComposer.js`
(rozvržení z `sources/docs/screen_layout.md`, glyfy z `data/font.json`, ikona
z `data/sprites.json`) a porovná je s videopamětí zachyceného snímku.
Cíl je **nula rozdílů** – tím je ověřené, že font, rozvržení i atributy sedí.
Je to panelová obdoba `matchscreen.py`, který v M2 porovná celou místnost.
"""
import argparse, base64, json, os, sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
PANEL_ROWS = 2


def screen_offset(y):
    third, char_row, pix = y >> 6, (y >> 3) & 7, y & 7
    return (third << 11) | (pix << 8) | (char_row << 5)


def build_panel(score, gems, depth, lives):
    font = json.load(open(os.path.join(ROOT, 'data/font.json')))['glyphs']
    sprites = json.load(open(os.path.join(ROOT, 'data/sprites.json')))
    icon = sprites['sabreman']['frames']['panelIcon']
    icon_bits = base64.b64decode(icon['bitmap'])
    icon_attr = base64.b64decode(icon['attributes'])

    bitmap = bytearray(32*8*PANEL_ROWS)
    # papír je černý a BRIGHT je zapnutý na celé obrazovce, takže prázdná
    # buňka není 0, ale $47
    attrs = bytearray([0x47]*(32*PANEL_ROWS))

    def write(row, col, text, attr):
        for i, char in enumerate(text):
            glyph = bytes.fromhex(font[char])
            for pixel in range(8):
                bitmap[(row*8+pixel)*32+col+i] = glyph[pixel]
            attrs[row*32+col+i] = attr

    write(0, 0, 'SCORE '+str(score).rjust(6, '0'), 0x46)
    write(1, 0, 'GEMS', 0x45)
    write(1, 4, ' '+str(gems).rjust(2, '0')+' ', 0x47)
    write(1, 8, 'DEPTH', 0x45)
    write(1, 13, str(depth).rjust(3), 0x47)
    write(1, 30, str(lives).rjust(2, '0'), 0x47)
    for row in range(PANEL_ROWS):
        for pixel in range(8):
            bitmap[(row*8+pixel)*32+28] = icon_bits[(row*8+pixel)*icon['cols']]
        attrs[row*32+28] = icon_attr[row*icon['cols']]
    return bitmap, attrs


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('frame', nargs='?', default=os.path.join(ROOT, 'build/diff00280.scr'))
    ap.add_argument('--score', type=int, default=0)
    ap.add_argument('--gems', type=int, default=0)
    ap.add_argument('--depth', type=int, default=15)
    ap.add_argument('--lives', type=int, default=6)
    args = ap.parse_args()

    bitmap, attrs = build_panel(args.score, args.gems, args.depth, args.lives)
    scr = open(args.frame, 'rb').read()
    if len(scr) != 6912:
        raise SystemExit('cekam 6912 B .scr, mam %d' % len(scr))
    original = bytearray()
    for y in range(PANEL_ROWS*8):
        original += scr[screen_offset(y):screen_offset(y)+32]
    original_attrs = scr[6144:6144+32*PANEL_ROWS]

    bad_bits = [i for i in range(len(bitmap)) if bitmap[i] != original[i]]
    bad_attrs = [i for i in range(len(attrs)) if attrs[i] != original_attrs[i]]
    print('%s:' % os.path.basename(args.frame))
    print('  bitmapa:  %d / %d bajtu se lisi' % (len(bad_bits), len(bitmap)))
    print('  atributy: %d / %d bajtu se lisi' % (len(bad_attrs), len(attrs)))
    for i in bad_bits[:16]:
        print('    bitmapa sloupec %d, radek %d: %02X != %02X'
              % (i % 32, i//32//8, bitmap[i], original[i]))
    for i in bad_attrs[:16]:
        print('    atribut sloupec %d, radek %d: %02X != %02X'
              % (i % 32, i//32, attrs[i], original_attrs[i]))
    if bad_bits or bad_attrs:
        sys.exit(1)
    print('  panel souhlasi s originalem bajt po bajtu')


if __name__ == '__main__':
    main()
