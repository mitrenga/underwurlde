#!/usr/bin/env python3
"""Nahraje **obraz originálu i s entitami** → `build/screen-traces.json` (M6).

    PYTHONPATH=tools/vendor ./tools/tracescreen.py [--scenario jmeno] [--scr]

`matchscreen.py` (M2) porovnává kulisu místností, tedy to, co se nakreslí při
vstupu do místnosti. Tenhle nástroj vzorkuje o krok dál: nechá hru běžet, na
**konci celého průchodu hlavní smyčkou** (`$955C`, tam je nakreslené všechno)
opíše videopaměť a k ní celý stav, ze kterého ten obraz vznikl – tabulku entit,
zbraně, záznam Sabremana, globály lana a souřadnice místnosti.

`tools/matchsprites.js` proti tomu pustí `app/screenComposer.js`, tedy kód, který
kreslí v prohlížeči, a porovná hrací plochu **bajt po bajtu** – bitmapu i
atributy. Tím se kontroluje to, co je vlastní práce M6: že se sprity kreslí
přesně tam a v těch barvách, ve kterých je kreslí originál, včetně attribute
clashe (barva spritu není v jeho datech, blitter ji bere ze záznamu entity).
"""
import argparse, base64, io, json, os, sys
from contextlib import redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'vendor'))
sys.path.insert(0, HERE)

from skoolkit.snapshot import Snapshot                          # noqa: E402
from skoolkit.simulator import Simulator                        # noqa: E402
from skoolkit.simutils import from_snapshot                     # noqa: E402
from physlog import StepTracer, KEYS, MENU, parse_keys, SNAPSHOT  # noqa: E402
import tracemonsters as tm                                       # noqa: E402
import roomlib                                                   # noqa: E402

OUT = os.path.join(HERE, '..', 'build/screen-traces.json')
SCR_DIR = os.path.join(HERE, '..', 'build/screens')

PASS_END = 0x955C               # konec celého průchodu hlavní smyčkou
RECORDS, RECORDS_END = 0x8EFA, 0x902A
WEAPONS, WEAPONS_END = 0x902A, 0x9052
PLAYER = 0x8F1A
ROPE, ROPE_LEN = 0xAA93, 0x1B
SETUP_FRAME = 300


# Scénář je dvojice: kam se Sabreman postaví (pak se místnost nechá **rutinou
# originálu** `$9906` překreslit a znovu naplnit entitami – přesně to, co dělá
# `roomlib.render`) a co se do ní vloží navíc.

def place_start(mem):
    """Startovní hradní místnost – nábytek a nepřátelé, jak je hra rozestaví."""
    tm.player_at(mem, 9, 14, 0x60, 0x9F)


def place_rope(mem):
    """Jeskyně, ve které visí lano – kreslí se čára ke konci lana ($AD02)."""
    mem[0x7000 + 32*18 + 2*5 + 1] = 0x08
    tm.player_at(mem, 5, 18, 0x60, 0x9F)


def place_guardian(mem):
    """Místnost strážce – největší sprity ve hře a k nim východ ze hry."""
    tm.player_at(mem, 8, 17, 0x60, 0x9F)


def place_cave(mem):
    """Jeskyně: bubliny, krápníky a rostliny."""
    tm.player_at(mem, 7, 16, 0x80, 0x9F)


def extras_shots(mem):
    """Projektily za letu a dvě nesené zbraně v panelu."""
    mem[0x8EEB] = 0x68
    mem[0x8EEC] = 0x69
    tm.place(mem, 0x8EFA, type=0x38, x=0x50, col=9, y=0x90, row=14,
             attr=0x47, vx=0x50, vy=0xC0, flags=1)
    tm.place(mem, 0x8F0A, type=0x6E, x=0xA0, col=9, y=0x80, row=14,
             attr=0x47, vx=0xB0, vy=0xD0, flags=1)


def extras_rope(mem):
    tm.place(mem, 0x8F2A, type=0x17, dx=0x03)


SCENARIOS = {
    'start': (place_start, None, [], [320, 340, 360]),
    'walk': (place_start, None, ['310:380:W'], [330, 350, 370]),
    'rope': (place_rope, extras_rope, ['310:340:R'], [330, 350, 380]),
    'guardian': (place_guardian, None, [], [320, 340, 360]),
    'shots': (place_start, extras_shots, [], [320, 335, 350]),
    'cave': (place_cave, None, [], [320, 340, 360]),
}


def capture(setup, extras, keyscript, samples, snapshot_path=SNAPSHOT):
    """Odsimuluje hru a na daných snímcích opíše obrazovku i stav."""
    snapshot = Snapshot.get(snapshot_path)
    if snapshot is None:
        raise SystemExit('nelze nacist snapshot %s' % snapshot_path)
    try:
        from skoolkit.csimulator import CSimulator as cls
    except ImportError:                                         # pragma: no cover
        cls = Simulator
    sim = from_snapshot(cls, snapshot, {}, {'ay': [None]*16},
                        {'fast_djnz': False, 'fast_ldir': False}, None)
    tracer = StepTracer(sim, snapshot.border, snapshot.out7ffd, snapshot.outfffd,
                        list(snapshot.ay), snapshot.outfe, True)
    sim.set_tracer(tracer)
    mem, reg = sim.memory, sim.registers
    keyboard = tracer.keyboard
    out, done_setup, pc = [], False, snapshot.pc
    backdrop = {}
    todo = sorted(samples)
    last = max(samples)+4

    def frame_now():
        return reg[25] // sim.frame_duration

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

    def keys_per_frame(scr, frame, border, kb):
        set_keys(frame)
        return frame < last+2

    def state(frame):
        scr = bytes(mem[0x4000:0x5B00])
        bitmap, attrs = roomlib.play_area(scr)
        return {
            'frame': frame,
            'col': mem[PLAYER+2], 'row': mem[PLAYER+4],
            'player': bytes(mem[PLAYER:PLAYER+16]).hex().upper(),
            'table': bytes(mem[RECORDS:RECORDS_END]).hex().upper(),
            'weapons': bytes(mem[WEAPONS:WEAPONS_END]).hex().upper(),
            'carried': list(mem[0x8EEB:0x8EEE]),
            'rope': bytes(mem[ROPE:ROPE+ROPE_LEN]).hex().upper(),
            'counters': {'slow': mem[0x8ED6] | mem[0x8ED7] << 8,
                         'frame': mem[0x5C78]},
            'bitmap': base64.b64encode(bitmap).decode(),
            'attributes': base64.b64encode(attrs).decode(),
            'screen': base64.b64encode(scr).decode(),
        }

    with redirect_stdout(io.StringIO()):
        while True:
            frame = frame_now()
            if frame > last:
                break
            set_keys(frame)
            if setup and not done_setup and frame >= SETUP_FRAME:
                setup(mem)
                # místnost překreslí a naplní **rutina originálu** ($9906),
                # jinak by se Sabreman jen přenesl a na obrazovce by zůstala
                # kulisa té staré místnosti
                saved = reg[:]
                reg[8], reg[9] = PLAYER >> 8, PLAYER & 0xFF
                reg[12] = 0x6000
                sim.run(roomlib.ROOM_SETUP, roomlib.SETUP_END, False)
                reg[:] = saved
                # kulisa místnosti hned po vstupu, ještě než se do ní nakreslí
                # jediná entita: proti tomuhle se pak porovnává kreslení. (Do
                # `data/rooms.json` mířit nejde: jeskyně si stav místnosti
                # generují za běhu, viz §14.3, takže obraz běžící jeskyně nemusí
                # být ta varianta, kterou má balík.)
                area, colours = roomlib.play_area(bytes(mem[0x4000:0x5B00]))
                backdrop['bitmap'] = base64.b64encode(area).decode()
                backdrop['attributes'] = base64.b64encode(colours).decode()
                backdrop['col'] = mem[PLAYER+2]
                backdrop['row'] = mem[PLAYER+4]
                if extras:
                    extras(mem)
                done_setup = True
            tracer.run(pc, PASS_END, 0, 0, True, keys_per_frame, None, None,
                       None, '$', '04X', '04X')
            pc = reg[24]
            if pc != PASS_END:
                break
            frame = frame_now()
            # průchod smyčkou je delší než snímek, takže se bere první konec
            # průchodu **na nebo za** požadovaným snímkem
            if todo and frame >= todo[0]:
                todo.pop(0)
                out.append(state(frame))
            sim.run(pc, pc+1, False)        # $955C je XOR A, jeden bajt
            pc = reg[24]
    return out, backdrop


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--out', default=OUT)
    ap.add_argument('--scenario', action='append')
    ap.add_argument('--scr', action='store_true',
                    help='ulozit i .scr do build/screens/ (kontrola ocima)')
    args = ap.parse_args()

    names = args.scenario or list(SCENARIOS)
    out = {
        'note': 'M6: obraz originalu i s entitami, vzorkovany na konci pruchodu '
                'hlavni smyckou ($955C). tools/tracescreen.py; porovnava '
                'tools/matchsprites.js.',
        'passEnd': '$%04X' % PASS_END,
        'recordsBase': '$%04X' % RECORDS,
        'weaponsBase': '$%04X' % WEAPONS,
        'scenarios': {},
    }
    total = 0
    for name in names:
        if name not in SCENARIOS:
            raise SystemExit('neznamy scenar %s (mam %s)'
                             % (name, ', '.join(SCENARIOS)))
        setup, extras, keys, samples = SCENARIOS[name]
        shots, backdrop = capture(setup, extras, parse_keys(keys), samples)
        out['scenarios'][name] = {'keys': keys, 'backdrop': backdrop,
                                  'frames': shots}
        total += len(shots)
        print('%-9s %d snimku (%s), mistnost %d,%d'
              % (name, len(shots), ', '.join(str(s['frame']) for s in shots),
                 shots[0]['col'], shots[0]['row']) if shots
              else '%-9s nic' % name)
        if args.scr:
            os.makedirs(SCR_DIR, exist_ok=True)
            for shot in shots:
                path = os.path.join(SCR_DIR, '%s-%04d.scr' % (name, shot['frame']))
                with open(path, 'wb') as f:
                    f.write(base64.b64decode(shot['screen']))

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, 'w') as f:
        json.dump(out, f, indent=1, sort_keys=False)
        f.write('\n')
    print('%s: %d snimku' % (os.path.relpath(args.out, os.path.join(HERE, '..')),
                             total))


if __name__ == '__main__':
    main()
