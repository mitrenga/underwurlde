#!/usr/bin/env python3
"""Nahraje **zvuk originálu za hraní** → `build/sound-traces.json` (M6).

    PYTHONPATH=tools/vendor ./tools/tracesound.py [--scenario jmeno] [--print]

`dumpsound.py` nechá zvukovou rutinu zahrát samotnou a uloží její pulzy do
`data/sounds.json`. Tenhle nástroj vzorkuje **jinde**, stejně jako
`tracephysics.py` a `tracemonsters.py`: hra se **hraje** a zapisuje se každý
zápis na port `$FE`, tedy skutečný pohyb membrány, s T-stavem a s tím, **odkud
se to hraje** – v okamžiku prvního pulzu se přečte návratová adresa ze zásobníku
a porovná se s tabulkou volání (`data/sounds.json`, `calls`).

Výstupem je seznam „shluků": událost, kterou zvuk provázel, počáteční úroveň
a délky pulzů v T-stavech. `tools/matchsound.js` proti tomu pustí `app/beeper.js`
– tedy kód, který jde do prohlížeče – a hlásí každý rozdílný pulz.

Scénáře jsou dva druhy: chůze, skok a dopad se odehrají na klávesnici, na
dotek, zabití a zásah stěny se do hry vloží entita (`tracemonsters.py` má na to
funkce, používají se tady znovu).
"""
import argparse, io, json, os, sys
from contextlib import redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'vendor'))
sys.path.insert(0, HERE)

from skoolkit.snapshot import Snapshot                          # noqa: E402
from skoolkit.simulator import Simulator                        # noqa: E402
from skoolkit.simutils import from_snapshot                     # noqa: E402
from physlog import StepTracer, KEYS, MENU, parse_keys, SNAPSHOT  # noqa: E402
import tracemonsters as tm                                       # noqa: E402

OUT = os.path.join(HERE, '..', 'build/sound-traces.json')
SOUNDS = os.path.join(HERE, '..', 'data/sounds.json')

T, SP, IXh, IXl = 25, 12, 8, 9
FRAMES = 0x5C78             # počítadlo snímků ULA (délka zvuku „něco umřelo")
STEP_COUNTER = 0x8EF6       # počítadlo kroků chůze (výška zvuku kroku)
PLAYER = 0x8F1A
GAP = 8000                  # T-stavů ticha, které dělí dva shluky
STACK_WORDS = 8             # kolik slov zásobníku se prohlédne kvůli volajícímu


class SoundTracer(StepTracer):
    """Tracer, který si k zápisům na port pamatuje i zásobník."""

    def __init__(self, *args, **kwargs):
        self.writes = []
        super().__init__(*args, **kwargs)

    def _write_port(self, registers, port, value, offset):
        if port % 2 == 0:
            stack = []
            sp = registers[SP]
            memory = self.simulator.memory
            for i in range(STACK_WORDS):
                at = (sp + 2*i) % 65536
                stack.append(memory[at] | memory[(at+1) % 65536] << 8)
            memory = self.simulator.memory
            ix = (registers[IXh] << 8) | registers[IXl]
            self.writes.append((registers[T], 1 if value & 0x10 else 0, stack,
                                {'ix': ix, 'y': memory[(ix+3) % 65536],
                                 'frames': memory[FRAMES],
                                 'stepCounter': memory[STEP_COUNTER]}))
        return super()._write_port(registers, port, value, offset)


def callers(sounds):
    """Z `data/sounds.json` udělá {návratová adresa: (událost, rutina)}."""
    out = {}
    for entry in sounds['calls']:
        for ret in entry['returns']:
            out[int(ret.lstrip('$'), 16)] = (entry['event'], entry['routine'],
                                             entry['call'])
    return out


def attribute(stack, table):
    """Kdo zvuk zahrál – první návratová adresa ze zásobníku, kterou známe."""
    for word in stack:
        if word in table:
            return table[word]
    return None


def bursts(writes, table):
    """Rozdělí zápisy na shluky a každému přiřadí událost.

    Nový shluk začíná, když je před ním ticho delší než `GAP`, **nebo** když se
    změní volající – dva zvuky za sebou (dotek a hned sebrání předmětu) jinak
    splynou v jeden a přiřazení by lhalo.
    """
    out = []
    current = None
    for t, level, stack, params in writes:
        who = attribute(stack, table)
        call = who[2] if who else None
        if current is None or t-current['last'] > GAP or call != current['call']:
            current = {'event': who[0] if who else None,
                       'routine': who[1] if who else None,
                       'call': call, 'params': params,
                       'start': t, 'last': t, 'levels': [(t, level)]}
            out.append(current)
        else:
            current['levels'].append((t, level))
            current['last'] = t
    # ze zápisů na port udělat přechody (zápis stejné úrovně membránou nehýbe)
    trains = []
    for burst in out:
        edges, level = [], 0
        for t, value in burst['levels']:
            if value != level:
                edges.append(t)
                level = value
        if len(edges) < 2:
            continue
        trains.append({
            'event': burst['event'],
            'routine': burst['routine'],
            'call': burst['call'],
            'params': burst['params'],
            'start': edges[0],
            'startLevel': 1 if burst['levels'][0][1] else 0,
            'pulses': [b-a for a, b in zip(edges, edges[1:])],
        })
    return trains


# ---------------------------------------------------------------------------
# Scénáře: příprava (může být None) a skript kláves
# ---------------------------------------------------------------------------

def scenario_walk(mem):
    tm.player_at(mem, 9, 14, 0x60, 0x9F)


def scenario_touch(mem):
    """Nepřítel přímo na Sabremanovi – senzor kontaktu $E285 hraje sám."""
    tm.player_at(mem, 9, 14, 0x80, 0x9F)
    tm.place(mem, 0x8FDA, type=0x44, x=0x84, col=9, y=0x98, row=14,
             attr=0x45, vx=0x00, vy=0x00, flags=1)


def scenario_kill(mem):
    """Šíp přímo v létajícím nepříteli – zvuk „něco umřelo"."""
    tm.player_at(mem, 9, 14, 0x40, 0x9F)
    tm.place(mem, 0x8EFA, type=0x6E, x=0xA0, col=9, y=0x82, row=14,
             attr=0x47, vx=0x10, vy=0x00, flags=1)
    mem[0x8EF9] = 1
    tm.place(mem, 0x8FDA, type=0x40, x=0xA4, col=9, y=0x82, row=14,
             attr=0x44, vx=0x00, vy=0x00, flags=1)


def scenario_pit(mem):
    """Jeskynní místnost bez podlahy – dlouhý pád a dopad."""
    tm.player_at(mem, 5, 18, 0x40, 0x50, 0x18)


def scenario_wall(mem):
    """Kámen z katapultu do stěny – šum ze ROM."""
    tm.player_at(mem, 9, 14, 0x40, 0x9F)
    tm.place(mem, 0x8EFA, type=0x38, x=0xC0, col=9, y=0x90, row=14,
             attr=0x47, vx=0x40, vy=0x00, flags=1)


def scenario_pickup(mem):
    """Drahokam a extra život pod nohama – sebrání hraje týž zvuk jako odskok."""
    tm.player_at(mem, 9, 14, 0x40, 0x9F)
    tm.place(mem, 0x8FBA, type=0x64, x=0x60, col=9, y=0x9F, row=14, attr=0x45)


def scenario_floor(mem):
    """Kámen padající na podlahu – zvuk `$A173` (jediná perioda sjezdu)."""
    tm.player_at(mem, 9, 14, 0x30, 0x9F)
    tm.place(mem, 0x8EFA, type=0x38, x=0x80, col=9, y=0x90, row=14,
             attr=0x47, vx=0x10, vy=0x40, flags=1)


SCENARIOS = {
    # jméno: (příprava, klávesy, snímků)
    'walk': (scenario_walk, ['310:370:W'], 390),
    'jump': (scenario_walk, ['312:315:R'], 400),
    'fall': (scenario_pit, [], 400),
    'touch': (scenario_touch, [], 380),
    'kill': (scenario_kill, [], 380),
    'wall': (scenario_wall, [], 380),
    'pickup': (scenario_pickup, ['310:340:W'], 390),
    'floor': (scenario_floor, [], 380),
}

SETUP_FRAME = 300


def record(setup, keyscript, frames, table, snapshot_path=SNAPSHOT):
    snapshot = Snapshot.get(snapshot_path)
    if snapshot is None:
        raise SystemExit('nelze nacist snapshot %s' % snapshot_path)
    try:
        from skoolkit.csimulator import CSimulator as cls
    except ImportError:                                         # pragma: no cover
        cls = Simulator
    sim = from_snapshot(cls, snapshot, {}, {'ay': [None]*16},
                        {'fast_djnz': False, 'fast_ldir': False}, None)
    tracer = SoundTracer(sim, snapshot.border, snapshot.out7ffd,
                         snapshot.outfffd, list(snapshot.ay), snapshot.outfe, True)
    sim.set_tracer(tracer)
    mem, reg = sim.memory, sim.registers
    keyboard = tracer.keyboard
    done_setup = [False]

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

    def draw(scr, frame, border, kb):
        set_keys(frame)
        if setup and not done_setup[0] and frame >= SETUP_FRAME:
            setup(mem)
            done_setup[0] = True
            tracer.writes = []          # co znělo cestou z menu, nás nezajímá
        return frame < frames

    with redirect_stdout(io.StringIO()):
        tracer.run(snapshot.pc, -1, 0, 0, True, draw, None, None, None,
                   '$', '04X', '04X')
    if not setup:
        # bez přípravy se maže na SETUP_FRAME ručně (menu klape klávesami)
        tracer.writes = [w for w in tracer.writes
                         if w[0] >= SETUP_FRAME*sim.frame_duration]
    return bursts(tracer.writes, table), sim.frame_duration


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--out', default=OUT)
    ap.add_argument('--sounds', default=SOUNDS)
    ap.add_argument('--scenario', action='append')
    ap.add_argument('--print', action='store_true', dest='show')
    args = ap.parse_args()

    with open(args.sounds) as f:
        sounds = json.load(f)
    table = callers(sounds)

    names = args.scenario or list(SCENARIOS)
    out = {
        'note': 'M6: zvuk originalu za hraní, vzorkovany na portu $FE. '
                'tools/tracesound.py; porovnava tools/matchsound.js.',
        'clock': sounds['clock'],
        'scenarios': {},
    }
    total, unknown = 0, 0
    for name in names:
        if name not in SCENARIOS:
            raise SystemExit('neznamy scenar %s (mam %s)'
                             % (name, ', '.join(SCENARIOS)))
        setup, keys, frames = SCENARIOS[name]
        trains, frame_duration = record(setup, parse_keys(keys), frames, table)
        out['frameDuration'] = frame_duration
        out['scenarios'][name] = {'keys': keys, 'bursts': trains}
        total += len(trains)
        unknown += sum(1 for t in trains if t['event'] is None)
        events = {}
        for t in trains:
            events[t['event'] or '?'] = events.get(t['event'] or '?', 0)+1
        print('%-8s %3d shluku  %s' % (name, len(trains),
                                       ', '.join('%s x%d' % (k, v)
                                                 for k, v in sorted(events.items()))))
        if args.show:
            for t in trains[:6]:
                print('   %s %s pulzy %s' % (t['call'], t['event'], t['pulses'][:8]))

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, 'w') as f:
        json.dump(out, f, indent=1, sort_keys=False)
        f.write('\n')
    print('%s: %d shluku, z toho %d bez znameho volajiciho'
          % (os.path.relpath(args.out, os.path.join(HERE, '..')), total, unknown))


if __name__ == '__main__':
    main()
