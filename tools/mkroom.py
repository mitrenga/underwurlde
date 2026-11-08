#!/usr/bin/env python3
"""Vytáhne z běžícího originálu **statickou** podobu jedné místnosti.

    PYTHONPATH=tools/vendor ./tools/mkroom.py [--out build/room000-majority.json]

**Nahrazeno v M2**: `tools/dumprooms.py` nechá místnost nakreslit rutinou
originálu, takže dostane čisté pozadí bez entit. Většinový hlas tady nechá
v obraze všechno, co se nehýbe (stolek se zbraněmi, pochodně) – proti
`dumprooms.py` se liší o 207 bajtů bitmapy a 134 atributů. Skript zůstává jako
nezávislá druhá metoda a jako historie M1; `data/room000.json` už píše
`dumprooms.py`, tenhle ukládá do `build/`.

Princip: hra se spustí v simulátoru (stejně jako `playtrace.py`), Sabreman se
skriptem kláves projde místností a v pravidelných rozestupech se ukládá celý
obraz videopaměti. Pohyblivé věci (Sabreman, harpyje, chrliče) jsou na každém
místě jen zlomek snímků, takže **většinový hlas přes bajty** vrátí to, co se
nehýbe – čistou místnost. Nic se nedokresluje, výstup jsou skutečné bajty
videopaměti originálu.

Ukládá se **jen hrací plocha** (znakové řádky 2–23, tj. 256 × 176 px):
5632 B bitmapy + 704 B atributů, base64. Panel si remake kreslí sám
originálním fontem (viz `mkfont.py` a `sources/docs/screen_layout.md`).

Skutečný formát dat místností dodal M2 – viz `sources/docs/disasm_notes.md` §10
a `data/world.json`.
"""
import argparse, base64, json, os, sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'vendor'))
sys.path.insert(0, HERE)

from scr2png import scr_to_rgb, write_png                      # noqa: E402
from skoolkit.snapshot import Snapshot                          # noqa: E402
from skoolkit.simulator import Simulator                        # noqa: E402
from skoolkit.simutils import from_snapshot                     # noqa: E402
from skoolkit.trace import Tracer                               # noqa: E402
try:
    from skoolkit.csimulator import CSimulator
except ImportError:                                             # pragma: no cover
    CSimulator = None

ROWS = {'$FEFE': 0, '$FDFE': 1, '$FBFE': 2, '$F7FE': 3,
        '$EFFE': 4, '$DFFE': 5, '$BFFE': 6, '$7FFE': 7}
KEYS = {
    'CAPS': ('$FEFE', 0), 'Z': ('$FEFE', 1), 'X': ('$FEFE', 2), 'C': ('$FEFE', 3), 'V': ('$FEFE', 4),
    'Q': ('$FBFE', 0), 'W': ('$FBFE', 1), 'E': ('$FBFE', 2), 'R': ('$FBFE', 3), 'T': ('$FBFE', 4),
    '1': ('$F7FE', 0), '2': ('$F7FE', 1), '3': ('$F7FE', 2), '4': ('$F7FE', 3), '5': ('$F7FE', 4),
    '0': ('$EFFE', 0), '9': ('$EFFE', 1), '8': ('$EFFE', 2), '7': ('$EFFE', 3), '6': ('$EFFE', 4),
    'ENTER': ('$BFFE', 0),
    'SPACE': ('$7FFE', 0), 'SYMSHIFT': ('$7FFE', 1), 'M': ('$7FFE', 2), 'N': ('$7FFE', 3), 'B': ('$7FFE', 4),
}

# (od snímku, do snímku, klávesa) – projít menu volby ovládání a pak chodit
SCRIPT = [
    (60, 70, '1'),      # volba ovládání: klávesnice
    (100, 110, '0'),    # START GAME
    (300, 420, 'W'),    # doprava
    (500, 620, 'Q'),    # doleva
]
SAMPLE_FROM, SAMPLE_TO, SAMPLE_STEP = 260, 700, 8

# Sabreman změřený ve snímku 280 (build/diff00280.scr): stojí na sloupci 8,
# znakový řádek 17, sprite je 16 × 24 px – viz `mksprite.py`.
SABREMAN_COL, SABREMAN_ROW = 8, 17

PANEL_ROWS = 2                      # znakové řádky panelu (0–1)
PLAY_ROWS = 24-PANEL_ROWS           # 22 znakových řádků hrací plochy
PLAY_LINES = PLAY_ROWS*8            # 176 px


def screen_offset(y):
    """Offset pixelového řádku y (0–191) v 6912B obrazu."""
    third, char_row, pix = y >> 6, (y >> 3) & 7, y & 7
    return (third << 11) | (pix << 8) | (char_row << 5)


def play_area(scr):
    """Hrací plocha jako (bitmapa 5632 B po řádcích shora dolů, atributy 704 B)."""
    bitmap = bytearray()
    for y in range(PANEL_ROWS*8, 192):
        base = screen_offset(y)
        bitmap += scr[base:base+32]
    attrs = bytes(scr[6144+PANEL_ROWS*32:6144+24*32])
    return bytes(bitmap), attrs


def majority(samples):
    """Po bajtech nejčastější hodnota – co se nehýbe, to vyhraje."""
    out = bytearray(len(samples[0]))
    for i in range(len(out)):
        out[i] = Counter(s[i] for s in samples).most_common(1)[0][0]
    return bytes(out)


def to_scr(bitmap, attrs):
    """Zpátky do 6912B obrazu (panel černý) – kvůli náhledu přes scr2png."""
    scr = bytearray(6912)
    for row, y in enumerate(range(PANEL_ROWS*8, 192)):
        scr[screen_offset(y):screen_offset(y)+32] = bitmap[row*32:row*32+32]
    scr[6144+PANEL_ROWS*32:6144+24*32] = attrs
    return bytes(scr)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('snapshot', nargs='?', default=os.path.join(HERE, '..', 'build/underwurlde.z80'))
    ap.add_argument('--out', default=os.path.join(HERE, '..', 'build/room000-majority.json'))
    ap.add_argument('--png', default=os.path.join(HERE, '..', 'build/room000-majority.png'))
    ap.add_argument('--frames', type=int, default=SAMPLE_TO+10)
    ap.add_argument('--diff-frame', help='čísla snímků (oddělená čárkou): uloží je '
                    'do build/diffNNNNN.scr a vypíše mapu buněk, ve kterých se liší '
                    'od statické místnosti')
    args = ap.parse_args()

    snapshot = Snapshot.get(args.snapshot)
    if snapshot is None:
        raise SystemExit('nelze nacist snapshot %s' % args.snapshot)
    cls = CSimulator or Simulator
    simulator = from_snapshot(cls, snapshot, {}, {'ay': [None]*16},
                              {'fast_djnz': False, 'fast_ldir': False}, None)
    tracer = Tracer(simulator, snapshot.border, snapshot.out7ffd, snapshot.outfffd,
                    list(snapshot.ay), snapshot.outfe, True)
    simulator.set_tracer(tracer)

    samples = []
    diff_frames = [int(n) for n in args.diff_frame.split(',')] if args.diff_frame else []
    diff_scr = {}

    def draw(scr, frame, border, keyboard):
        for i in range(8):
            keyboard[i] = 0
        for start, end, key in SCRIPT:
            if start <= frame < end:
                row, bit = KEYS[key]
                keyboard[ROWS[row]] |= 1 << bit
        if SAMPLE_FROM <= frame <= SAMPLE_TO and (frame-SAMPLE_FROM) % SAMPLE_STEP == 0:
            samples.append(bytes(scr))
        if frame in diff_frames:
            diff_scr[frame] = bytes(scr)
        return frame < args.frames

    tracer.run(snapshot.pc, -1, 0, 0, True, draw, None, None, None, '$', '04X', '04X')
    if len(samples) < 5:
        raise SystemExit('malo vzorku (%d) – zkontroluj SCRIPT' % len(samples))

    bitmaps, attributes = zip(*(play_area(s) for s in samples))
    bitmap, attrs = majority(bitmaps), majority(attributes)

    room = {
        'note': 'M1: statická místnost vytažená z běhu originálu (tools/mkroom.py). '
                'Skutečný formát dat místností dodá M2.',
        'name': 'CASTLE HALL',
        'column': 0, 'row': 0, 'depth': 15,
        'width': 256, 'height': PLAY_LINES,
        'samples': len(samples),
        # podlaha: první plná pixelová řádka hrací plochy (změřeno v bitmapě),
        # a startovní pozice Sabremana ve stejných souřadnicích (levý horní roh)
        'floorY': next(y for y in range(PLAY_LINES)
                       if all(bitmap[y*32+c] for c in range(32))),
        'sabreman': {'x': SABREMAN_COL*8, 'y': (SABREMAN_ROW-PANEL_ROWS)*8},
        'bitmap': base64.b64encode(bitmap).decode('ascii'),
        'attributes': base64.b64encode(attrs).decode('ascii')
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, 'w') as f:
        json.dump(room, f, indent=2)
        f.write('\n')
    print('%s (%d vzorku, %d B bitmapy + %d B atributu)'
          % (args.out, len(samples), len(bitmap), len(attrs)))
    for dframe in sorted(diff_scr):
        fb, fa = play_area(diff_scr[dframe])
        path = os.path.join(os.path.dirname(os.path.abspath(args.png)), 'diff%05d.scr' % dframe)
        with open(path, 'wb') as f:
            f.write(diff_scr[dframe])
        print('%s' % path)
        print('zmeny proti staticke mistnosti, snimek %d (cislice = inkoust menici se '
              'bunky, sloupce 0-31, znakove radky 2-23):' % dframe)
        for row in range(PLAY_ROWS):
            line = ''
            for col in range(32):
                changed = any(fb[(row*8+p)*32+col] != bitmap[(row*8+p)*32+col]
                              for p in range(8))
                if fa[row*32+col] != attrs[row*32+col]:
                    changed = True
                line += ('%X' % (fa[row*32+col] & 7)) if changed else '.'
            print('%2d %s' % (row+PANEL_ROWS, line))

    if args.png:
        write_png(args.png, scr_to_rgb(to_scr(bitmap, attrs)), 256)
        print('nahled: %s' % args.png)


if __name__ == '__main__':
    main()
