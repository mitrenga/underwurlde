#!/usr/bin/env python3
"""Projde **celou mapu světa** a zkontroluje přechody a průchodnost (M4).

    PYTHONPATH=tools/vendor ./tools/checkworld.py [--from 9,14] [--quiet]

Co se kontroluje na datech z `data/world.json` (a proti tabulce `$7000`
v obrazu hry, aby se nekontrolovala kopie sama proti sobě):

1. **Počet přechodů.** Otevřená strana místnosti = jeden přechod. M2 jich
   napočítal 1222.
2. **Vzájemnost.** Když má místnost otevřenou pravou stěnu, musí mít soused
   vpravo otevřenou levou – jinak by se dalo projít jen jedním směrem.
3. **Slepé strany.** Otevřená strana, za kterou žádná místnost není. V celém
   světě jsou **tři** a všechny jsou otevřený strop v řádku 0 – jsou to
   **tři východy ze hry**. Rutina vstupu do místnosti (`$9913`) na řádek `$FF`
   reaguje skokem na vítěznou obrazovku `$9EA0` a podle **sloupce** vypíše,
   do kterého pokračování se hráč dostal: `3` = KNIGHT LORE, `9` = PENTAGRAM
   (písmena „A" tam kreslí sprite pentagramu, typ `$90`), jinak MIRE MARE.
4. **Průchodnost.** Zaplavení grafu od startovní místnosti (`$AA3C`).
   Do místnosti se dá vstoupit jen tehdy, když má **soused** otevřenou tu
   stranu, kterou se přechází – cílová místnost do toho nemá co mluvit, takže
   graf je orientovaný a jsou v něm jednosměrné přechody.
5. **Cíle.** Že se od startu dá dojít do místností strážců
   (`data/entities.json`) a do všech šestnácti míst s extra životem.

Známé vlastnosti originálu, které tenhle nástroj drží jako **očekávané hodnoty**
(změna některé z nich znamená, že se rozbila data, ne že se něco našlo):
otevřených stran je **1225**, z toho **1222** vede do existující místnosti
(to je číslo z M2) a **3** jsou východy; jednosměrné přechody jsou **4** a kvůli
nim je **4 místností nedosažitelných** (kapsa `(1,13)`–`(1,15)`, ze které se dá
jen vyjít, a `(7,10)`). Dosažitelných je tedy **594** z 598. Ze čtyř záznamů
v tabulce strážců je platný jen **3** – čtvrtý míří na `(0,32)`, kde místnost
vůbec není, takže se nikdy neobjeví. Tři strážci, tři východy.

Tohle je kontrola grafu. Že se přes hranici skutečně **projde fyzikou**
(a na které souřadnici se vstoupí), kontroluje `tools/matchtransitions.js`.
"""
import argparse, json, os, sys
from collections import deque

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from roomlib import Game, COLS, ROWS                             # noqa: E402

WORLD = os.path.join(HERE, '..', 'data/world.json')
ENTITIES = os.path.join(HERE, '..', 'data/entities.json')
PHYSICS = os.path.join(HERE, '..', 'data/physics.json')

# bit v popisném bajtu -> (jméno, Δsloupec, Δřádek, protější bit)
# která obrazovka vítězství se vypíše podle sloupce východu (rutina $9ECB)
ENDINGS = {3: 'KNIGHT LORE', 9: 'PENTAGRAM', None: 'MIRE MARE'}

SIDES = {0: ('strop',  0, -1, 4),
         2: ('vpravo', 1,  0, 6),
         4: ('podlaha', 0, 1, 0),
         6: ('vlevo', -1,  0, 2)}


def descriptors_from_data(path):
    """Popisné bajty z `data/world.json` jako {(sloupec, řádek): bajt}."""
    world = json.load(open(path))
    out = {}
    for row, line in enumerate(world['descriptors']):
        for col in range(COLS):
            value = int(line[col*2:col*2+2], 16)
            if value:
                out[(col, row)] = value
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--world', default=WORLD)
    ap.add_argument('--entities', default=ENTITIES)
    ap.add_argument('--physics', default=PHYSICS)
    ap.add_argument('--start', help='vychozi mistnost "sloupec,radek" (vychozi z $AA3C)')
    ap.add_argument('--quiet', action='store_true')
    args = ap.parse_args()

    game = Game()
    original = {(col, row): desc for col, row, desc in game.rooms()}
    data = descriptors_from_data(args.world)

    problems = []
    if original != data:
        only_game = set(original) - set(data)
        only_data = set(data) - set(original)
        changed = [k for k in set(original) & set(data) if original[k] != data[k]]
        problems.append('data/world.json se rozchazi s tabulkou $7000: '
                        '%d jen v obrazu, %d jen v datech, %d jinych bajtu'
                        % (len(only_game), len(only_data), len(changed)))

    # --- 1 a 3: přechody a slepé strany -----------------------------------
    transitions, dangling = [], []
    for (col, row), desc in sorted(original.items()):
        for bit, (name, dcol, drow, opposite) in SIDES.items():
            if desc >> bit & 1:
                continue                                # strana je uzavřená
            neighbour = (col+dcol, row+drow)
            transitions.append(((col, row), name, neighbour))
            if not (0 <= neighbour[0] < COLS and 0 <= neighbour[1] < ROWS) \
                    or neighbour not in original:
                dangling.append(((col, row), name, neighbour))

    # --- 2: vzájemnost -----------------------------------------------------
    oneway = []
    for (col, row), desc in sorted(original.items()):
        for bit, (name, dcol, drow, opposite) in SIDES.items():
            if desc >> bit & 1:
                continue
            neighbour = (col+dcol, row+drow)
            if neighbour in original and original[neighbour] >> opposite & 1:
                oneway.append(((col, row), name, neighbour))

    # --- 4: průchodnost ----------------------------------------------------
    physics = json.load(open(args.physics))
    spawn = physics['values']['spawnRecord']
    start = (spawn[2], spawn[4])
    if args.start:
        start = tuple(int(x) for x in args.start.split(','))

    seen, queue = {start}, deque([start])
    while queue:
        col, row = queue.popleft()
        desc = original.get((col, row))
        if desc is None:
            continue
        for bit, (name, dcol, drow, opposite) in SIDES.items():
            if desc >> bit & 1:
                continue
            neighbour = (col+dcol, row+drow)
            if neighbour in original and neighbour not in seen:
                seen.add(neighbour)
                queue.append(neighbour)
    unreachable = sorted(set(original) - seen)

    # --- 5: cíle -----------------------------------------------------------
    entities = json.load(open(args.entities))
    goals = []
    for guard in entities['guardians']['places']:
        if guard.get('valid'):
            goals.append(('strazce $%02X' % guard['type'],
                          (guard['col'], guard['row'])))
    for place in entities['extraLives']['places']:
        goals.append(('extra zivot %d' % place['index'],
                      (place['col'], place['row'])))
    missing = [(name, where) for name, where in goals
               if where not in original or where not in seen]

    if not args.quiet:
        print('mistnosti v tabulce: %d' % len(original))
        print('prechodu (otevrenych stran): %d' % len(transitions))
        print('slepych stran: %d' % len(dangling))
        for room, name, neighbour in dangling[:10]:
            print('  %s otevrena %s -> %s tam neni' % (room, name, neighbour))
        print('jednosmernych prechodu: %d' % len(oneway))
        for room, name, neighbour in oneway[:10]:
            print('  %s otevrena %s, ale %s ma tu stranu zavrenou'
                  % (room, name, neighbour))
        print('od startu %s dosazitelnych: %d, nedosazitelnych: %d'
              % (start, len(seen), len(unreachable)))
        for room in unreachable[:10]:
            print('  nedosazitelna %s, popisny bajt $%02X'
                  % (room, original[room]))
        print('cilu (strazci + extra zivoty): %d, nedosazitelnych: %d'
              % (len(goals), len(missing)))
        for name, where in missing:
            print('  %s v %s' % (name, where))
        for problem in problems:
            print('PROBLEM: %s' % problem)

    # očekávané hodnoty: co je vlastnost originálu, není závada
    for label, got, want in (('otevrenych stran', len(transitions), 1225),
                             ('prechodu do existujici mistnosti',
                              len(transitions)-len(dangling), 1222),
                             ('vychodu (slepych stropu v radku 0)', len(dangling), 3),
                             ('jednosmernych prechodu', len(oneway), 4),
                             ('nedosazitelnych mistnosti', len(unreachable), 4),
                             ('dosazitelnych mistnosti', len(seen), 594)):
        if got != want:
            problems.append('%s: %d, cekano %d' % (label, got, want))
    for room, name, neighbour in dangling:
        if not (name == 'strop' and room[1] == 0):
            problems.append('slepa strana %s %s neni vychod v radku 0' % (room, name))
    if not args.quiet:
        print('vychody (sloupec -> pokracovani): %s'
              % ', '.join('%d -> %s' % (col, ENDINGS.get(col, ENDINGS[None]))
                          for col, row in sorted(r for r, n, _ in dangling)))

    problems += ['nedosazitelny cil %s v %s' % (name, where)
                 for name, where in missing]
    print('zavady: %d' % len(problems))
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
