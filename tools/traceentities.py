#!/usr/bin/env python3
"""Nahraje z originálu **rozmístění entit** ve všech místnostech (M4).

    PYTHONPATH=tools/vendor ./tools/traceentities.py [--seeds 4] [--out FILE]

Obdoba `tools/tracephysics.py` pro entity: pro každou existující místnost se
nechá **originál v simulátoru** projít svou rutinu vstupu do místnosti
(`$9906`, ta uvnitř volá `$EAA2` pro hrad, `$AF56` pro jeskyně a `$EC3A` pro
extra životy a strážce) a **celá tabulka entit `$8EFA–$9029`** se uloží tak,
jak ji rutina nechala. `tools/matchentities.js` pak proti té nahrávce pustí
`app/worldEntities.js` a hlásí každý rozdílný bajt.

Rozmístění v jeskyních závisí na dvou počítadlech hry (pomalé `$8ED6` a
`FRAMES` `$5C78`) v okamžiku **první návštěvy** místnosti – hra si podle nich
vygeneruje stav místnosti do tabulky na `$6000` a od té chvíle si ho pamatuje.
Proto se každá jeskynní místnost nahrává s několika hodnotami těch počítadel
(`--seeds`): kdyby přepis reprodukoval jen jednu, prošel by omylem.

Výchozí stav tabulky je pro všechny místnosti stejný (rozehraná hra, ze které
`roomlib` kreslí), takže se ukládá jednou jako `before`.
"""
import argparse, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from roomlib import Game, CASTLE_ROWS, ROOM_STRIDE                # noqa: E402

OUT = os.path.join(HERE, '..', 'build/entity-placement.json')

RECORDS_BASE, RECORDS_END, STRIDE = 0x8EFA, 0x902A, 16
SLOW_COUNTER, FRAMES = 0x8ED6, 0x5C78
CAVE_STATE = 0x6000
CAVE_STATE_END = CAVE_STATE + ROOM_STRIDE*52

# hodnoty počítadel, na kterých se jeskyně zkoušejí
SEEDS = [(0x00, 0x00), (0x04, 0x04), (0x14, 0xA6), (0xFF, 0xFF),
         (0x08, 0x1C), (0x2C, 0x77)]


def table_hex(memory):
    return ''.join('%02X' % memory[addr]
                   for addr in range(RECORDS_BASE, RECORDS_END))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--out', default=OUT)
    ap.add_argument('--seeds', type=int, default=4)
    ap.add_argument('--rooms', type=int, help='jen prvnich N mistnosti')
    args = ap.parse_args()

    game = Game()
    seeds = SEEDS[:max(1, min(args.seeds, len(SEEDS)))]
    rooms = game.rooms()
    if args.rooms:
        rooms = rooms[:args.rooms]

    records = []
    for col, row, desc in rooms:
        word = game.descriptor(col, row)
        for index, (slow, frames) in enumerate(seeds if row >= CASTLE_ROWS
                                               else seeds[:1]):
            def prepare(memory, slow=slow, frames=frames):
                memory[SLOW_COUNTER], memory[SLOW_COUNTER+1] = slow, 0
                memory[FRAMES], memory[FRAMES+1] = frames, 0
                for addr in range(CAVE_STATE, CAVE_STATE_END):
                    memory[addr] = 0

            game.render(col, row, prepare)
            at = CAVE_STATE + ROOM_STRIDE*row + 2*col
            records.append({
                'col': col, 'row': row,
                'word': [word & 0xFF, word >> 8],
                'slow': slow, 'frames': frames,
                'after': table_hex(game.sim.memory),
                'state': [game.sim.memory[at], game.sim.memory[at+1]],
            })

    out = {
        'note': 'M4: tabulka entit $8EFA-$9029 po rutine vstupu do mistnosti '
                '($9906) v originalu, pro kazdou mistnost. tools/traceentities.py.',
        'recordsBase': '$%04X' % RECORDS_BASE,
        'stride': STRIDE,
        'slots': (RECORDS_END-RECORDS_BASE)//STRIDE,
        'before': table_hex(game.state[0]),
        'seeds': [list(s) for s in seeds],
        'rooms': records,
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, 'w') as f:
        json.dump(out, f)
        f.write('\n')
    print('mistnosti %d, zaznamu %d, %s: %d B'
          % (len(rooms), len(records),
             os.path.relpath(args.out, os.path.join(HERE, '..')),
             os.path.getsize(args.out)))


if __name__ == '__main__':
    main()
