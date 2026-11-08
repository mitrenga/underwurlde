#!/usr/bin/env python3
"""Vytáhne z paměti hry originální znakovou sadu Underwurlde do PNG sheetu.

    ./tools/dumpfont.py [build/underwurlde-run.bin] [sources/media/font_charset.png]

Znaková sada leží na **$ED24** – přesně tam, kde ji hledá rutina na `$98DF`
(`HL = A * 8`, `DE = $ED24`, `ADD HL,DE`). Index je **přímo ASCII kód znaku**,
8 bajtů na glyf, mezera je mapovaná na `$3D`. Obsazené jsou číslice a velká písmena:
'0' na `$EEA4`, 'Z' končí na `$EFFB`, tj. na posledním bajtu, který hra v paměti zabírá.

Vstupem je **runtime** obraz RAM `$4000-$FFFF` (49152 B) z `tools/mkruntime.py` –
kazetový obraz z `mksnapshot.sh` je proti běžící hře posunutý o jeden bajt
(viz `sources/docs/disasm_notes.md` §9).
"""
import os, sys, zlib, struct

BASE = 0xED24          # adresa glyfu pro znak s kódem 0
SPACE = 0x3D           # rutina na $98DF mapuje mezeru ($20) na tento index
CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'


def write_png(path, lines, width):
    raw = b''.join(b'\x00' + l for l in lines)

    def chunk(tag, p):
        return (struct.pack('>I', len(p)) + tag + p
                + struct.pack('>I', zlib.crc32(tag + p) & 0xFFFFFFFF))

    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n')
        f.write(chunk(b'IHDR', struct.pack('>IIBBBBB', width, len(lines), 8, 2, 0, 0, 0)))
        f.write(chunk(b'IDAT', zlib.compress(raw, 9)))
        f.write(chunk(b'IEND', b''))


def main(argv):
    root = os.path.join(os.path.dirname(__file__), '..')
    src = argv[1] if len(argv) > 1 else os.path.join(root, 'build/underwurlde-run.bin')
    dst = argv[2] if len(argv) > 2 else os.path.join(root, 'sources/media/font_charset.png')
    ram = open(src, 'rb').read()
    if len(ram) != 49152:
        raise SystemExit('cekam 49152 B RAM ($4000-$FFFF), mam %d' % len(ram))
    byte = lambda a: ram[a - 0x4000]

    chars = ' ' + CHARS
    lines = []
    for y in range(8):
        row = bytearray()
        for c in chars:
            b = byte(BASE + (SPACE if c == ' ' else ord(c)) * 8 + y)
            for bit in range(7, -1, -1):
                row += b'\xff\xff\xff' if (b >> bit) & 1 else b'\x00\x00\x00'
        lines.append(bytes(row))
    write_png(dst, lines, len(chars) * 8)
    print('%s  (%d znaku, %dx8 px, sheet 8x8 na znak)' % (dst, len(chars), len(chars) * 8))


if __name__ == '__main__':
    main(sys.argv)
