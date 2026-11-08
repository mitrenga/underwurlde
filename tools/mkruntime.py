#!/usr/bin/env python3
"""Udělá obraz RAM **v podobě, v jaké hra skutečně běží**.

    PYTHONPATH=tools/vendor ./tools/mkruntime.py [--out build/underwurlde-run.bin]

Proč to je potřeba: `tap2sna.py` uloží snapshot v okamžiku dokončení nahrávání,
ale hra si po nahrání **celý svůj blok přesune o jeden bajt dolů**. Adresy
v `build/underwurlde.bin` (a tím i v cizí disassembly, která vzniká z téhož
snapshotu) jsou proto o **jeden bajt vyšší** než adresy, na kterých kód
skutečně běží – všechny konstanty v instrukcích tomu neodpovídají a
disassembly je o bajt rozsypaná.

Skript spustí hru v simulátoru, projde menu, počká na běžící hru a uloží RAM
`$4000–$FFFF` v runtime podobě. Ta je jediná správná pro disassembly i pro
extrakci dat (`dumprooms.py`, `dumpgfx.py`).

Ověření: vypíše, kolik bajtů hlavního bloku odpovídá kazetovému obrazu
posunutému o -1 (očekává se ~všechno; rozdíl jsou proměnné, které už hra stihla
přepsat).
"""
import argparse, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'vendor'))
sys.path.insert(0, HERE)

from skoolkit.snapshot import Snapshot                          # noqa: E402
from skoolkit.simulator import Simulator                        # noqa: E402
from skoolkit.simutils import from_snapshot                     # noqa: E402
from skoolkit.trace import Tracer                               # noqa: E402
try:
    from skoolkit.csimulator import CSimulator
except ImportError:                                             # pragma: no cover
    CSimulator = None

BLOCK = (0x67F1, 0xEFF6)        # hlavní blok v runtime adresách


def boot(snapshot_path, frames=200):
    """Spustí hru a nechá ji dojít do rozehrané hry; vrátí simulátor."""
    snapshot = Snapshot.get(snapshot_path)
    if snapshot is None:
        raise SystemExit('nelze nacist snapshot %s' % snapshot_path)
    cls = CSimulator or Simulator
    simulator = from_snapshot(cls, snapshot, {}, {'ay': [None]*16},
                              {'fast_djnz': False, 'fast_ldir': False}, None)
    tracer = Tracer(simulator, snapshot.border, snapshot.out7ffd, snapshot.outfffd,
                    list(snapshot.ay), snapshot.outfe, True)
    simulator.set_tracer(tracer)

    def draw(scr, frame, border, keyboard):
        for i in range(8):
            keyboard[i] = 0
        if 60 <= frame < 70:
            keyboard[3] |= 1        # '1' – ovládání klávesnicí
        if 100 <= frame < 110:
            keyboard[4] |= 1        # '0' – START GAME
        return frame < frames

    tracer.run(snapshot.pc, -1, 0, 0, True, draw, None, None, None, '$', '04X', '04X')
    return simulator


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('snapshot', nargs='?',
                    default=os.path.join(HERE, '..', 'build/underwurlde.z80'))
    ap.add_argument('--out', default=os.path.join(HERE, '..', 'build/underwurlde-run.bin'))
    ap.add_argument('--tape-image', default=os.path.join(HERE, '..', 'build/underwurlde.bin'))
    args = ap.parse_args()

    simulator = boot(args.snapshot)
    ram = bytes(simulator.memory[0x4000:])
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, 'wb') as f:
        f.write(ram)
    print('%s: %d B (RAM $4000-$FFFF za behu hry)' % (args.out, len(ram)))

    if os.path.isfile(args.tape_image):
        tape = open(args.tape_image, 'rb').read()
        same = shifted = 0
        for a in range(*BLOCK):
            same += ram[a-0x4000] == tape[a-0x4000]
            shifted += ram[a-0x4000] == tape[a+1-0x4000]
        total = BLOCK[1]-BLOCK[0]
        print('hlavni blok $%04X-$%04X (%d B) proti kazetovemu obrazu:'
              % (BLOCK[0], BLOCK[1], total))
        print('  bez posunu: %d B (%.1f %%)' % (same, 100.0*same/total))
        print('  posun -1:   %d B (%.1f %%)  <- takhle hra skutecne bezi'
              % (shifted, 100.0*shifted/total))


if __name__ == '__main__':
    main()
