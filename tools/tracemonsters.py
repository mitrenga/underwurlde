#!/usr/bin/env python3
"""Nahraje z originálu **kroky nepřátel, zbraní a strážců** (M5).

    PYTHONPATH=tools/vendor ./tools/tracemonsters.py [--scenario jmeno] [--print]

Obdoba `tools/tracephysics.py`, jenže vzorkuje jinde. Fyzika se dala odchytit na
rutině Sabremana; u entit se hra zastavuje rovnou na **rozcestníku typů**
(`$9211`, tam kde `JP (HL)` skáče do obsluhy podle `(IX+0)`). Při každé
zastávce se opíše:

* `IX` – čí záznam se právě bude obsluhovat,
* **celá tabulka entit** `$8EFA–$9029` (19 záznamů po 16 B) a **tabulka zbraní**
  `$902A–$9051` (5 záznamů po 8 B),
* globály M5: skóre `$8EF3–$8EF5`, nesené zbraně `$8EEB–$8EED`, klávesa
  vzít/položit `$8EE9`/`$8EEA`, orel `$8EF1`/`$8EF2`, spouštěč orlů `$8EF9`,
  počítadlo střelby `$AAAB`, popisný bajt místnosti `$AAAC`,
* počítadla `$8ED6` a `$5C78` a stisknuté klávesy.

Krok jedné entity je pak **rozdíl mezi dvěma sousedními zastávkami**:
`tools/matchmonsters.js` vezme stav z první, pustí proti němu `app/monsters.js`
a porovná s druhou. Když se mezi zastávkami hlavní smyčka otočila (za poslední
zbraní se běží znovu od `$8EFA` a cestou se pustí generátory `$DF58`, `$AFDA`
a `$E05F`), je ta dvojice označená a porovnává se jen záznam, který byl na řadě.

Scénáře plní tabulku entit **přímo** (`setup`), stejně jako `tracephysics.py`
vkládá Sabremana do místnosti: nečeká se, až generátor vyrobí orla, ale rovnou
se do slotu zapíše orel a nechá se běžet **rutina originálu**. Autoritou pořád
zůstává originál, jen se k zajímavému stavu dojde rychleji než hraním.
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

OUT = os.path.join(HERE, '..', 'build/monster-traces.json')

DISPATCH = 0x9211               # rozcestník typů: sem se skáče s IX na entitě
RECORDS, RECORDS_END, STRIDE = 0x8EFA, 0x902A, 16
WEAPONS, WEAPONS_END, WEAPON_STRIDE = 0x902A, 0x9052, 8
PLAYER = 0x8F1A
ROOM_TABLE = 0x7000

GLOBALS = [
    ('score', 0x8EF3, 3), ('carried', 0x8EEB, 3),
    ('takeHeld', 0x8EE9, 1), ('takePulse', 0x8EEA, 1),
    ('carryNext', 0x8EF1, 1), ('carryLatch', 0x8EF2, 1),
    ('eagles', 0x8EF9, 1), ('fireCounter', 0xAAAB, 1),
    ('descriptor', 0xAAAC, 1), ('gems', 0x8EEE, 1),
    ('slow', 0x8ED6, 1), ('frames', 0x5C78, 1),
]


def place(mem, address, **fields):
    """Zapíše entitu do slotu – jména bajtů jsou ta z `data/README.md`."""
    order = ['type', 'x', 'col', 'y', 'row', 'attr', 'dx', 'spare7',
             'vx', 'vy', 'lowx', 'mask', 'height', 'lowy', 'phase', 'flags']
    for index, name in enumerate(order):
        if name in fields:
            mem[address+index] = fields[name] & 0xFF


def player_at(mem, col, row, x, y, type_=0x09):
    place(mem, PLAYER, type=type_, x=x, col=col, y=y, row=row)


# ---------------------------------------------------------------------------
# Scénáře: co se do hry vloží a co se pak mačká
# ---------------------------------------------------------------------------

def scenario_flyers(mem):
    """Všechny čtyři chody létajícího nepřítele naráz, ve startovní místnosti."""
    player_at(mem, 9, 14, 0x60, 0x9F)
    mem[0x8EF9] = 1                              # orli už létají
    place(mem, 0x8FDA, type=0x30, x=0x30, col=9, y=0x50, row=14,
          attr=0x42, vx=0x10, vy=0x08, flags=1)
    place(mem, 0x8FEA, type=0x34, x=0xB0, col=9, y=0x60, row=14,
          attr=0x43, vx=0xF0, vy=0xF8, flags=1)
    place(mem, 0x8FFA, type=0x40, x=0x80, col=9, y=0x44, row=14,
          attr=0x44, vx=0x20, vy=0x20, flags=1)
    place(mem, 0x900A, type=0x44, x=0x40, col=9, y=0x48, row=14,
          attr=0x45, vx=0x30, vy=0x00, flags=1)


def scenario_approach(mem):
    """Nepřátelé v sousedních místnostech – cesta po mřížce k hráči."""
    player_at(mem, 9, 14, 0x80, 0x9F)
    mem[0x8EF9] = 1
    place(mem, 0x8FDA, type=0x30, x=0x60, col=8, y=0x60, row=14,
          attr=0x42, vx=0x00, vy=0x00, flags=1)
    place(mem, 0x8FEA, type=0x40, x=0x60, col=10, y=0x60, row=14,
          attr=0x43, vx=0x00, vy=0x00, flags=1)
    place(mem, 0x8FFA, type=0x34, x=0x60, col=9, y=0x60, row=13,
          attr=0x44, vx=0x00, vy=0x00, flags=1)
    place(mem, 0x900A, type=0x44, x=0x60, col=9, y=0x60, row=15,
          attr=0x45, vx=0x00, vy=0x00, flags=1)


def scenario_shots(mem):
    """Projektily za letu: kámen z katapultu a šíp, plus zásah nepřítele."""
    player_at(mem, 9, 14, 0x40, 0x9F)
    place(mem, 0x8EFA, type=0x38, x=0x50, col=9, y=0x90, row=14,
          attr=0x47, vx=0x50, vy=0xC0, flags=1)
    place(mem, 0x8F0A, type=0x6E, x=0xA0, col=9, y=0x80, row=14,
          attr=0x47, vx=0xB0, vy=0xD0, flags=1)
    mem[0x8EF9] = 1
    place(mem, 0x8FDA, type=0x40, x=0xA4, col=9, y=0x82, row=14,
          attr=0x44, vx=0x00, vy=0x00, flags=1)


def scenario_fire(mem):
    """Katapult v ruce a drží se výstřel – rutina `$B4D1` v běhu."""
    player_at(mem, 9, 14, 0x60, 0x9F)
    mem[0x8EEB] = 0x68
    place(mem, 0x902A, type=0x68, x=0x88, col=9, y=0x0F, row=14,
          attr=0x47, spare7=0x02)


def scenario_weapons(mem):
    """Sebrání, přendávání a puštění zbraně – všechny tři stavy bajtu +7."""
    player_at(mem, 9, 14, 0x60, 0x9F)
    place(mem, 0x902A, type=0x68, x=0x44, col=9, y=0x9F, row=14, attr=0x47)
    place(mem, 0x9032, type=0x69, x=0x48, col=9, y=0x9F, row=14, attr=0x47)
    place(mem, 0x903A, type=0x6B, x=0x40, col=9, y=0x9F, row=14, attr=0x47)


def scenario_guardian(mem):
    """Strážce (8,17) a do něj šíp z luku – ten jediný ho zabije."""
    player_at(mem, 8, 17, 0x60, 0x9F)
    place(mem, 0x8FBA, type=0x84, x=0x80, col=8, y=0x9F, row=17,
          attr=0x03, dx=6, flags=1)
    place(mem, 0x8EFA, type=0x6E, x=0x60, col=8, y=0x98, row=17,
          attr=0x47, vx=0x60, vy=0x00, flags=1)


def scenario_guardian_wrong(mem):
    """A totéž kamenem z katapultu – ten se do párování vůbec nedostane."""
    player_at(mem, 8, 17, 0x60, 0x9F)
    place(mem, 0x8FBA, type=0x84, x=0x80, col=8, y=0x9F, row=17,
          attr=0x03, dx=6, flags=1)
    place(mem, 0x8EFA, type=0x38, x=0x60, col=8, y=0x98, row=17,
          attr=0x47, vx=0x60, vy=0x00, flags=1)


def scenario_eagle(mem):
    """Orel přímo na Sabremanovi – zvedne ho a odnese."""
    player_at(mem, 9, 14, 0x80, 0x9F)
    mem[0x8EF9] = 1
    place(mem, 0x8FDA, type=0x30, x=0x80, col=9, y=0x98, row=14,
          attr=0x42, vx=0x00, vy=0x00, flags=0)


def scenario_cave(mem):
    """Nepřátelé v jeskyni – jiný popisný bajt, jiné strany, bubliny"""
    player_at(mem, 7, 16, 0x80, 0x9F)
    mem[0x8EF9] = 1
    place(mem, 0x8FDA, type=0x40, x=0x50, col=7, y=0x60, row=16,
          attr=0x42, vx=0x18, vy=0x28, flags=1)
    place(mem, 0x8FEA, type=0x44, x=0xB0, col=7, y=0x50, row=16,
          attr=0x43, vx=0xE8, vy=0x00, flags=1)


def scenario_projectiles(mem):
    """Dýka a ohnivá koule za letu – zbylé dva projektily."""
    player_at(mem, 9, 14, 0x40, 0x9F)
    place(mem, 0x8EFA, type=0x6C, x=0x50, col=9, y=0x90, row=14,
          attr=0x47, vx=0x60, vy=0xC0, flags=1)
    place(mem, 0x8F0A, type=0x70, x=0xA0, col=9, y=0x70, row=14,
          attr=0x42, vx=0xA0, vy=0xE0, flags=1)


def scenario_guardian_devil(mem):
    """Ďábel (1,16) a ohnivá koule z pochodně."""
    player_at(mem, 1, 16, 0x60, 0x9F)
    place(mem, 0x8FBA, type=0x86, x=0x80, col=1, y=0x9F, row=16,
          attr=0x03, dx=7, flags=1)
    place(mem, 0x8F9A, type=0x88, x=0x78, col=1, y=0x30, row=16,
          attr=0x46, flags=1)
    place(mem, 0x8EFA, type=0x70, x=0x60, col=1, y=0x98, row=16,
          attr=0x42, vx=0x60, vy=0x00, flags=1)


def scenario_guardian_beetle(mem):
    """Brouk (14,20) a dýka z meče."""
    player_at(mem, 14, 20, 0x60, 0x9F)
    place(mem, 0x8FBA, type=0x82, x=0x80, col=14, y=0x9F, row=20,
          attr=0x03, dx=5, flags=1)
    place(mem, 0x8F9A, type=0x88, x=0x78, col=14, y=0x30, row=20,
          attr=0x46, flags=1)
    place(mem, 0x8EFA, type=0x6C, x=0x60, col=14, y=0x98, row=20,
          attr=0x47, vx=0x60, vy=0x00, flags=1)


SCENARIOS = {
    'projectiles': (scenario_projectiles, [], 400),
    'guardian-devil': (scenario_guardian_devil, [], 420),
    'guardian-beetle': (scenario_guardian_beetle, [], 420),
    'flyers': (scenario_flyers, ['300:520:W'], 520),
    'approach': (scenario_approach, [], 480),
    'shots': (scenario_shots, [], 420),
    'fire': (scenario_fire, ['300:520:T'], 520),
    'weapons': (scenario_weapons, ['310:316:SPACE', '340:346:SPACE',
                                   '370:376:SPACE', '400:406:SPACE',
                                   '430:436:SPACE', '460:466:SPACE',
                                   '490:496:SPACE'], 560),
    'guardian': (scenario_guardian, [], 420),
    'guardian-wrong': (scenario_guardian_wrong, [], 420),
    'eagle': (scenario_eagle, ['300:500:W'], 500),
    'cave': (scenario_cave, [], 460),
}

SETUP_FRAME = 300


def record(scenario, keyscript, frames, snapshot_path=SNAPSHOT, limit=4000):
    """Pustí hru a zastaví se na každém rozcestníku typů."""
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
    stops, done_setup, pc = [], False, snapshot.pc

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
        return frame < frames + 2

    def snapshot_state(frame):
        table = bytes(mem[RECORDS:RECORDS_END])
        weapons = bytes(mem[WEAPONS:WEAPONS_END])
        globals_ = {name: list(mem[addr:addr+count])
                    for name, addr, count in GLOBALS}
        col, row = mem[PLAYER+2], mem[PLAYER+4]
        rooms = {}
        for c in range(max(0, col-1), min(16, col+2)):
            for r in range(max(0, row-2), min(52, row+3)):
                at = ROOM_TABLE + 32*r + 2*c
                rooms['%d,%d' % (c, r)] = [mem[at], mem[at+1]]
        return {
            'frame': frame,
            'ix': (reg[8] << 8) | reg[9],
            'table': table.hex().upper(),
            'weapons': weapons.hex().upper(),
            'globals': globals_,
            'rooms': rooms,
            'keys': [k for k, (r, b) in KEYS.items() if keyboard[r] >> b & 1],
        }

    with redirect_stdout(io.StringIO()):
        while len(stops) < limit:
            frame = frame_now()
            if frame >= frames:
                break
            set_keys(frame)
            if scenario and not done_setup and frame >= SETUP_FRAME:
                scenario(mem)
                done_setup = True
            tracer.run(pc, DISPATCH, 0, 0, True, keys_per_frame, None, None,
                       None, '$', '04X', '04X')
            pc = reg[24]
            if pc != DISPATCH:
                break
            if done_setup:
                stops.append(snapshot_state(frame_now()))
            sim.run(pc, pc+2, False)      # $9211 je LD H,$00, dva bajty
            pc = reg[24]
    return stops


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--out', default=OUT)
    ap.add_argument('--scenario', action='append',
                    help='jen tyhle scenare (jinak vsechny)')
    ap.add_argument('--limit', type=int, default=2400,
                    help='kolik zastavek na scenar')
    ap.add_argument('--print', action='store_true')
    args = ap.parse_args()

    names = args.scenario or list(SCENARIOS)
    out = {
        'note': 'M5: kroky entit v originalu, vzorkovane na rozcestniku typu '
                '$9211. tools/tracemonsters.py; porovnava tools/matchmonsters.js.',
        'recordsBase': '$%04X' % RECORDS,
        'weaponsBase': '$%04X' % WEAPONS,
        'stride': STRIDE,
        'weaponStride': WEAPON_STRIDE,
        'globals': [[name, '$%04X' % addr, count] for name, addr, count in GLOBALS],
        'scenarios': {},
    }
    total = 0
    for name in names:
        if name not in SCENARIOS:
            raise SystemExit('neznamy scenar %s (mam %s)'
                             % (name, ', '.join(SCENARIOS)))
        setup, keys, frames = SCENARIOS[name]
        stops = record(setup, parse_keys(keys), frames, limit=args.limit)
        out['scenarios'][name] = {'stops': stops, 'keys': keys}
        total += len(stops)
        print('%-16s %4d zastavek' % (name, len(stops)))
        if args.print:
            for stop in stops[:20]:
                print('  %5d IX=$%04X' % (stop['frame'], stop['ix']))

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, 'w') as f:
        json.dump(out, f)
        f.write('\n')
    print('celkem %d zastavek, %s: %d B'
          % (total, os.path.relpath(args.out, os.path.join(HERE, '..')),
             os.path.getsize(args.out)))


if __name__ == '__main__':
    main()
