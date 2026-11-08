#!/usr/bin/env python3
"""Zaznamená stav záznamu Sabremana snímek po snímku – základ měření fyziky (M3).

    PYTHONPATH=tools/vendor ./tools/physlog.py --keys 300:400:W --frames 500

Hra běží v C simulátoru (rychlý), menu se odklikne samo. Po každém snímku se
opíše 16 bajtů záznamu Sabremana (`$8F1A`) a případně další sledované adresy
(`--watch ADR[:N]`). Výstup je tabulka „snímek: bajty" a na konci seznam
bajtů, které se v okně vůbec měnily – z toho se pozná, který offset je x, y,
faze animace atd.
"""
import argparse, io, os, sys
from contextlib import redirect_stdout

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

SNAPSHOT = os.path.join(HERE, '..', 'build/underwurlde.z80')
PLAYER = 0x8F1A
RECLEN = 16
MENU = [(60, 70, '1'), (100, 110, '0')]

KEYS = {
    'CAPS': (0, 0), 'Z': (0, 1), 'X': (0, 2), 'C': (0, 3), 'V': (0, 4),
    'A': (1, 0), 'S': (1, 1), 'D': (1, 2), 'F': (1, 3), 'G': (1, 4),
    'Q': (2, 0), 'W': (2, 1), 'E': (2, 2), 'R': (2, 3), 'T': (2, 4),
    '1': (3, 0), '2': (3, 1), '3': (3, 2), '4': (3, 3), '5': (3, 4),
    '0': (4, 0), '9': (4, 1), '8': (4, 2), '7': (4, 3), '6': (4, 4),
    'P': (5, 0), 'O': (5, 1), 'I': (5, 2), 'U': (5, 3), 'Y': (5, 4),
    'ENTER': (6, 0), 'L': (6, 1), 'K': (6, 2), 'J': (6, 3), 'H': (6, 4),
    'SPACE': (7, 0), 'SYMSHIFT': (7, 1), 'M': (7, 2), 'N': (7, 3), 'B': (7, 4),
}


def parse_keys(specs):
    out = []
    for spec in specs or []:
        start, end, keys = spec.split(':')
        out.append((int(start), int(end), keys.upper().split('+')))
    return out


def run(frames, keyscript, watch=(), record=PLAYER, reclen=RECLEN, snapshot_path=SNAPSHOT,
        on_frame=None):
    """Odsimuluje `frames` snímků; vrátí seznam (snímek, bajty záznamu, bajty watch)."""
    snapshot = Snapshot.get(snapshot_path)
    if snapshot is None:
        raise SystemExit('nelze nacist snapshot %s' % snapshot_path)
    cls = CSimulator or Simulator
    sim = from_snapshot(cls, snapshot, {}, {'ay': [None] * 16},
                        {'fast_djnz': False, 'fast_ldir': False}, None)
    tracer = Tracer(sim, snapshot.border, snapshot.out7ffd, snapshot.outfffd,
                    list(snapshot.ay), snapshot.outfe, True)
    sim.set_tracer(tracer)
    mem = sim.memory
    log = []

    def draw(scr, frame, border, keyboard):
        for i in range(8):
            keyboard[i] = 0
        for start, end, key in MENU:
            if start <= frame < end:
                r, b = KEYS[key]
                keyboard[r] |= 1 << b
        for start, end, keys in keyscript:
            if start <= frame < end:
                for key in keys:
                    r, b = KEYS[key]
                    keyboard[r] |= 1 << b
        rec = bytes(mem[record:record + reclen])
        extra = tuple(bytes(mem[a:a + n]) for a, n in watch)
        log.append((frame, rec, extra, bytes(scr) if on_frame else None))
        if on_frame:
            on_frame(frame, scr, mem)
        return frame < frames

    tracer.run(snapshot.pc, -1, 0, 0, True, draw, None, None, None, '$', '04X', '04X')
    return log


class StepTracer(Tracer):
    """Tracer, kteremu behy nemazou stav klavesnice.

    `Tracer.run()` si pri kazdem volani zaklada nove pole klaves, coz u kratkych
    behu (zastavka na kazdem kroku Sabremana) znamena, ze hra vzdy vidi vsechno
    pustene. Tady je pole jedno pro cely beh.
    """

    def __init__(self, *args, **kwargs):
        self._keys = [0] * 8
        super().__init__(*args, **kwargs)

    @property
    def keyboard(self):
        return self._keys

    @keyboard.setter
    def keyboard(self, value):
        pass                    # drzi se vlastni pole


PLAYER_HANDLER = 0x989F      # rutina, kterou zacina kazdy krok Sabremana
PLAYER_DRAW = 0x96CB         # rutinou kresleni krok Sabremana konci


def run_steps(frames, keyscript, watch=(), record=PLAYER, reclen=RECLEN,
              snapshot_path=SNAPSHOT, setup=None, setup_frame=200, sample=None,
              trace_frame=None, trace_out=None):
    """Vzorkuje stav **na kazdy herni krok Sabremana**, ne na snimek.

    Simulator se zastavuje na `$989F` – rutine, kterou zacina obsluha kazdeho
    typu Sabremana (chuze, pokrceni, skok, pad, lano, smrt); filtruje se podle
    `IX`, protoze `$989F` volaji i jine entity. Tim se obejde to, ze hlavni
    smycka hry nestiha kazdy snimek (u kresleneho lana bere dva az tri) –
    porovnavat se ma krok proti kroku, ne snimek proti snimku.

    Vzorkuje se dvakrat: na **zacatku** kroku (`$989F`, tedy vstup, ze ktereho
    se pocita) a na jeho **konci** (`$96CB`, rutina kresleni, kterou obsluha
    konci). Diky tomu se da porovnavat presne jeden krok Sabremana – do zaznamu
    mezitim zapisuji i jine entity (bublina nebo neprital umi Sabremanovi
    prepsat dx, viz `$E3CB`, `$B15E`, `$ED28`), a to uz je vec M4/M5.

    Klavesnice se drzi sama (ne pres `draw`, ktere se pri kratkych behech
    nemusi vubec zavolat) a snimek se pocita z T-stavu jako v `run()`.
    """
    snapshot = Snapshot.get(snapshot_path)
    if snapshot is None:
        raise SystemExit('nelze nacist snapshot %s' % snapshot_path)
    cls = CSimulator or Simulator
    sim = from_snapshot(cls, snapshot, {}, {'ay': [None] * 16},
                        {'fast_djnz': False, 'fast_ldir': False}, None)
    tracer = StepTracer(sim, snapshot.border, snapshot.out7ffd, snapshot.outfffd,
                        list(snapshot.ay), snapshot.outfe, True)
    sim.set_tracer(tracer)
    mem, reg = sim.memory, sim.registers
    keyboard = tracer.keyboard
    log = []
    done_setup = False
    pc = snapshot.pc

    def frame_now():
        return reg[25] // sim.frame_duration

    def keys_per_frame(scr, frame, border, kb):
        """Drzi klavesy i mezi zastavkami – behy jsou kratsi nez snimek."""
        set_keys(frame)
        return frame < frames + 2

    def set_keys(frame):
        for i in range(8):
            keyboard[i] = 0
        for start, end, key in MENU:
            if start <= frame < end:
                r, b = KEYS[key]
                keyboard[r] |= 1 << b
        for start, end, group in keyscript:
            if start <= frame < end:
                for key in group:
                    r, b = KEYS[key]
                    keyboard[r] |= 1 << b

    with redirect_stdout(io.StringIO()):
        while True:
            frame = frame_now()
            if frame >= frames:
                break
            set_keys(frame)
            if setup and not done_setup and frame >= setup_frame:
                setup(mem)
                done_setup = True
            tracer.run(pc, PLAYER_HANDLER, 0, 0, True, keys_per_frame, None, None,
                       None, '$', '04X', '04X')
            pc = reg[24]
            if pc != PLAYER_HANDLER:
                break
            if (reg[8] << 8 | reg[9]) != record:        # IX = zaznam Sabremana
                sim.run(pc, pc + 3, False)  # $989F je LD A,(IX+$01), 3 bajty
                pc = reg[24]
                continue
            frame = frame_now()
            entry = bytes(mem[record:record + reclen])
            entry_watch = tuple(bytes(mem[a:a + n]) for a, n in watch)
            entry_sample = sample(mem) if sample else None
            sim.run(pc, pc + 3, False)
            pc = reg[24]
            if trace_frame is not None and frame == trace_frame and trace_out is not None:
                # ladici rezim: krok se projde po instrukcich, aby se videlo,
                # kterou cestou rutinami originalu jde (tim se hledaji rozdily
                # proti prepisu v app/sabremanPhysics.js)
                for _ in range(20000):
                    sim.run()
                    trace_out.append(reg[24])
                    if reg[24] == PLAYER_DRAW:
                        break
                pc = reg[24]
            else:
                # dobehnout krok do konce ($96CB) a opsat vysledek
                tracer.run(pc, PLAYER_DRAW, 20000, 0, True, keys_per_frame, None,
                           None, None, '$', '04X', '04X')
                pc = reg[24]
            if pc == PLAYER_DRAW and (reg[8] << 8 | reg[9]) == record:
                out = bytes(mem[record:record + reclen])
                out_watch = tuple(bytes(mem[a:a + n]) for a, n in watch)
            else:
                out, out_watch = None, None     # obsluha skoncila jinudy
            log.append((frame, entry, entry_watch, entry_sample, out, out_watch))
    return log


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--frames', type=int, default=400)
    ap.add_argument('--from-frame', type=int, default=0, help='od kterého snímku tisknout')
    ap.add_argument('--keys', action='append', help='od:do:KLAVESA[+KLAVESA]')
    ap.add_argument('--record', default='%X' % PLAYER, help='adresa záznamu (hex)')
    ap.add_argument('--len', type=int, default=RECLEN)
    ap.add_argument('--watch', action='append', default=[], help='ADR[:N] další sledovaná adresa')
    ap.add_argument('--changed-only', action='store_true', help='tisknout jen snímky, kde se něco změnilo')
    args = ap.parse_args()

    watch = []
    for w in args.watch:
        parts = w.split(':')
        watch.append((int(parts[0], 16), int(parts[1]) if len(parts) > 1 else 1))

    log = run(args.frames, parse_keys(args.keys), watch,
              record=int(args.record, 16), reclen=args.len)

    prev = None
    for frame, rec, extra, _ in log:
        if frame < args.from_frame:
            continue
        line = ' '.join('%02X' % b for b in rec)
        if extra:
            line += '  |  ' + '  '.join(' '.join('%02X' % b for b in e) for e in extra)
        if args.changed_only and (rec, extra) == prev:
            continue
        prev = (rec, extra)
        print('%5d  %s' % (frame, line))

    window = [r for f, r, e, s in log if f >= args.from_frame]
    if window:
        varying = [i for i in range(len(window[0]))
                   if len({r[i] for r in window}) > 1]
        print('\nmenici se offsety zaznamu: ' + ', '.join('+%d' % i for i in varying))
        for i in varying:
            vals = sorted({r[i] for r in window})
            print('  +%-2d  %d hodnot: %s' % (i, len(vals),
                  ' '.join('%02X' % v for v in vals[:24]) + (' ...' if len(vals) > 24 else '')))


if __name__ == '__main__':
    main()
