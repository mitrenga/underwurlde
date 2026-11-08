#!/usr/bin/env python3
"""Vyřízne jednu místnost ze screenshotové mapy světa.

    ./tools/mapcut.py <sloupec 0-15> <řádek 0-51> [out.png] [--scale N]

Mapa `sources/media/maps/speccycz_screenshot_map.png` je 4096 × 9200 px,
tj. mřížka **16 × 52** buněk po **256 × 176** px, začínající v levém horním rohu
bez odsazení (posledních 48 px obrázku je přebytek). Buňka je přesně hrací
plocha místnosti, panel v mapě není.

Zjištěno v M2: mřížka světa má **52 řádků** (tabulka místností na `$7000` má
52 řádků po 16 místnostech) a `tools/mapworld.py --check` ukazuje shodu
inkoustu 96 % právě při buňce 176 px a nulovém odsazení. M0 tvrdil 16 × 50
po 184 px – bylo to špatně.
Bez zavislosti (jen zlib) – vstup je 4bitové paletové PNG bez filtrů, výstup 8bitové RGB.
"""
import os, sys, zlib, struct

SRC = os.path.join(os.path.dirname(__file__), '..',
                   'sources/media/maps/speccycz_screenshot_map.png')
COLS, ROWS, CW, CH = 16, 52, 256, 176
PANEL = 0       # buňka mapy je přesně hrací plocha, nic se neodřezává


def load(path):
    d = open(path, 'rb').read()
    i, idat, plte = 8, b'', None
    while i < len(d):
        ln = struct.unpack('>I', d[i:i + 4])[0]
        tag, pay = d[i + 4:i + 8], d[i + 8:i + 8 + ln]
        i += 12 + ln
        if tag == b'IHDR':
            w, h, bd, ct = struct.unpack('>IIBB', pay[:10])
            if (bd, ct) != (4, 3):
                raise SystemExit('cekam 4bitove paletove PNG, mam bd=%d ct=%d' % (bd, ct))
        elif tag == b'PLTE':
            plte = pay
        elif tag == b'IDAT':
            idat += pay
        elif tag == b'IEND':
            break
    raw = zlib.decompress(idat)
    stride = (w * 4 + 7) // 8
    rows = []
    for y in range(h):
        if raw[y * (stride + 1)]:
            raise SystemExit('necekany PNG filtr na radku %d' % y)
        rows.append(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
    return w, h, rows, plte


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
    args = [a for a in argv[1:] if not a.startswith('--')]
    scale = 1
    full = '--full' in argv[1:]
    for a in argv[1:]:
        if a.startswith('--scale='):
            scale = int(a.split('=')[1])
    if len(args) < 2:
        raise SystemExit(__doc__)
    col, row = int(args[0]), int(args[1])
    if not (0 <= col < COLS and 0 <= row < ROWS):
        raise SystemExit('sloupec 0-%d, radek 0-%d' % (COLS - 1, ROWS - 1))
    out = args[2] if len(args) > 2 else 'room_c%02d_r%02d.png' % (col, row)
    _, _, rows, plte = load(SRC)
    x0, y0 = col * CW, row * CH + (0 if full else PANEL)
    height = CH if full else CH - PANEL
    lines = []
    for y in range(y0, y0 + height):
        src = rows[y]
        line = bytearray()
        for x in range(x0, x0 + CW):
            b = src[x >> 1]
            idx = (b >> 4) if not (x & 1) else (b & 15)
            line += plte[idx * 3:idx * 3 + 3] * scale
        for _ in range(scale):
            lines.append(bytes(line))
    write_png(out, lines, CW * scale)
    print('%s  (sloupec %d, radek %d, %dx%d)' % (out, col, row, CW * scale, len(lines)))


if __name__ == '__main__':
    main(sys.argv)
