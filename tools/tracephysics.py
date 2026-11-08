#!/usr/bin/env python3
"""Nahraje **referenční běhy originálu** pro kontrolu fyziky remaku (M3).

    PYTHONPATH=tools/vendor ./tools/tracephysics.py [--out build/physics-traces.json]
                                                    [--scenario jmeno] [--print]

Každý scénář je krátký skript kláves (a u některých i vložení Sabremana do
konkrétní místnosti – to je totéž, co dělá `roomlib.py`, jen za běhu). Snímek
po snímku se zapisuje:

* 16 B záznamu Sabremana (`$8F1A`) – typ, x, sloupec, y, řádek, dx, rychlost…
* záznamy ostatních entit `$8F2A–$8FB9` (lano, nepřítel, plošiny, nábytek)
* globály lana `$AA93–$AAAD` (konec lana, výchylka, rychlost kyvu, délka)
* dvoubajtové slovo místnosti z tabulky na `$7000` (druhý bajt je **stav**,
  ne data – hra do něj zapisuje, že v místnosti visí lano)
* počítadla `$8ED6` (kroky hry) a `$5C78` (snímky ULA), životy, nezranitelnost
* které klávesy jsou v tom snímku stisknuté

`tools/matchphysics.js` pak proti tomu pustí `app/sabremanPhysics.js` a hlásí
každý rozdíl – obdoba `matchscreen.py` pro fyziku. Trasy se do gitu nedávají
(jsou v `build/`), vyrobí se z kazety kdykoli znovu.
"""
import argparse, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'vendor'))
sys.path.insert(0, HERE)

import physlog                                                   # noqa: E402

OUT = os.path.join(HERE, '..', 'build/physics-traces.json')

PLAYER = 0x8F1A
ENTS = (0x8F2A, 0x90)          # devět záznamů entit za Sabremanem
ROPE = (0xAA93, 0x1B)          # globály lana
COUNTERS = (0x8ED6, 2)
FRAMES = (0x5C78, 2)
LIVES = (0x8EDA, 1)
INVINCIBLE = (0x8EEE, 1)
ENTERED = (0x8EF0, 1)      # bit 0: prave se vstoupilo do mistnosti (viz $A4DD)
ROOM_TABLE = 0x7000

WATCH = [ENTS, ROPE, COUNTERS, FRAMES, LIVES, INVINCIBLE, ENTERED]


def place(mem, col, row, x, y, type_=0x09):
    """Vloží Sabremana do místnosti (sloupec, řádek) – jako `roomlib.render`."""
    mem[PLAYER+0] = type_
    mem[PLAYER+1] = x
    mem[PLAYER+2] = col
    mem[PLAYER+3] = y
    mem[PLAYER+4] = row


def rope_in_room(mem, col, row):
    """Zapíše do místnosti, že v ní visí lano (druhý bajt záznamu, bit 3),
    a vyrobí entitu lana – přesně to, co dělá rutina `$AE81`."""
    mem[ROOM_TABLE + 32*row + 2*col + 1] = 0x08
    mem[0x8F2A] = 0x17
    mem[0x8F30] = 0x03


def platform_in_room(mem, col, row, x, y):
    """Entita typu $58 v prvním slotu ($8F5A) – to jediné (kromě podlahy), na
    čem se dá v originálu stát (senzor $E1B4). Sprite toho typu je **vulkanická
    bublina**, tedy právě to, co podle instrukcí nese hráče jeskyněmi vzhůru."""
    base = 0x8F5A
    for i in range(16):
        mem[base+i] = 0
    mem[base+0] = 0x58
    mem[base+1] = x
    mem[base+2] = col
    mem[base+3] = y
    mem[base+4] = row
    mem[base+5] = 0x45


# scénáře: jméno, poznámka, kolik snímků, skript kláves, příprava (poke)
SCENARIOS = [
    ('stand', 'stání ve startovní místnosti – nic se nemá hýbat', 260, [], None),
    ('walkRight', 'chůze vpravo přes celou startovní místnost až na stolek se zbraněmi',
     280, ['200:280:W'], None),
    ('walkLeft', 'chůze vlevo až na levou stěnu (zaražení na x=$18)',
     300, ['200:300:Q'], None),
    ('jumpStanding', 'skok z místa: pokrčení, stoupání, odraz o kulisu, kotoul, přechod vlevo',
     330, ['200:203:R'], None),
    ('jumpRunning', 'skok v běhu vpravo – vodorovná rychlost se drží celý let',
     300, ['195:260:W', '200:203:R'], None),
    ('jumpIntoWall', 'skok vlevo do stěny: odraz (dx se obrátí) a pád',
     330, ['195:300:Q', '250:253:R'], None),
    ('autoHop', 'místnost bez podlahy (jeskyně $AB): Sabreman sám odskočí a chytá strop',
     300, [], lambda mem: place(mem, 5, 18, 0x40, 0x9F)),
    ('fallDeath', 'dlouhý pád jeskyněmi až za hranici $74 – jediná smrtelná mechanika',
     420, [], lambda mem: place(mem, 1, 10, 0x30, 0x30, 0x18)),
    ('platform', 'dosednutí na bublinu (entita typu $58) v místnosti bez podlahy',
     300, [], lambda mem: (place(mem, 5, 18, 0x40, 0x50, 0x18),
                           platform_in_room(mem, 5, 18, 0x40, 0x90))),
    ('ropeGrab', 'chycení lana ve středu jeskynní místnosti a rozkyv',
     330, [], lambda mem: (place(mem, 5, 18, 0x60, 0x9F), rope_in_room(mem, 5, 18))),
    ('ropePump', 'rozhoupání lana klávesami do strany',
     420, ['240:300:Q', '300:360:W'],
     lambda mem: (place(mem, 5, 18, 0x60, 0x9F), rope_in_room(mem, 5, 18))),
    ('ropeRelease', 'rozkyv a puštění lana klávesou CAPS – rychlost se vezme z pohybu lana',
     360, ['240:280:Q', '300:305:CAPS'],
     lambda mem: (place(mem, 5, 18, 0x60, 0x9F), rope_in_room(mem, 5, 18))),
    ('ropeClimb', 'prodloužení a zkrácení lana klávesami dolů a nahoru',
     420, ['240:300:E', '320:380:R'],
     lambda mem: (place(mem, 5, 18, 0x60, 0x9F), rope_in_room(mem, 5, 18))),
]

POKE_FRAME = 200        # ve kterém snímku se scénář nastaví (hra je rozehraná)


def hexs(data):
    return ''.join('%02X' % b for b in data)


def room_word(mem):
    """Slovo mistnosti, ve ktere Sabreman prave je (tabulka na $7000)."""
    col, row = mem[PLAYER+2], mem[PLAYER+4]
    addr = ROOM_TABLE + 32*row + 2*col
    return (col, row, mem[addr], mem[addr+1])


def run_scenario(name, note, frames, keys, setup):
    keyscript = physlog.parse_keys(keys)
    log = physlog.run_steps(frames, keyscript, WATCH, setup=setup,
                            setup_frame=POKE_FRAME, sample=room_word)
    out = []
    seen_setup = setup is None
    for frame, rec, extra, room, out_rec, out_extra in log:
        if frame < POKE_FRAME:
            continue
        ents, rope, counters, ulaframes, lives, invincible, entered = extra
        col, row, desc_lo, desc_hi = room
        if not seen_setup:
            # vzorek z okamziku tesne pred vlozenim Sabremana do mistnosti
            seen_setup = True
            continue
        pressed = []
        for start, end, group in keyscript:
            if start <= frame < end:
                pressed += group
        out.append({
            'frame': frame,
            'keys': pressed,
            'rec': hexs(rec),
            'recOut': hexs(out_rec) if out_rec else None,
            'ents': hexs(ents),
            'rope': hexs(rope),
            'ropeOut': hexs(out_extra[1]) if out_extra else None,
            'room': [desc_lo, desc_hi],
            'step': counters[0] | counters[1] << 8,
            'ula': ulaframes[0] | ulaframes[1] << 8,
            'lives': lives[0],
            'invincible': invincible[0],
            'entered': entered[0],
        })
    return {'name': name, 'note': note, 'firstFrame': POKE_FRAME,
            'keys': keys, 'frames': out}


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--out', default=OUT)
    ap.add_argument('--scenario', action='append', help='jen tyhle scénáře')
    ap.add_argument('--print', action='store_true', dest='show',
                    help='vypsat záznamy na terminál')
    args = ap.parse_args()

    wanted = set(args.scenario or [])
    scenarios = []
    for name, note, frames, keys, setup in SCENARIOS:
        if wanted and name not in wanted:
            continue
        scenario = run_scenario(name, note, frames, keys, setup)
        scenarios.append(scenario)
        rows = scenario['frames']
        changed = sum(1 for i, r in enumerate(rows) if i and r['rec'] != rows[i-1]['rec'])
        print('%-14s %4d kroku, %3d zmen zaznamu  (%s)' % (name, len(rows), changed, note))
        if args.show:
            for r in rows:
                print('   %4d %s %s' % (r['frame'], r['rec'], ','.join(r['keys'])))

    if scenarios:
        frames = sum(s['frames'][-1]['frame']-s['frames'][0]['frame'] for s in scenarios)
        ticks = sum(s['frames'][-1]['step']-s['frames'][0]['step'] for s in scenarios)
        steps = sum(len(s['frames']) for s in scenarios)
        print('kadence pomaleho pocitadla $8ED6: %.2f snimku na tik, '
              '%.2f kroku Sabremana na tik' % (frames/max(ticks, 1), steps/max(ticks, 1)))

    if wanted:
        return
    out = {
        'note': ('M3: referencni behy originalu pro kontrolu fyziky remaku '
                 '(tools/tracephysics.py). Porovnava se tools/matchphysics.js.'),
        'player': '$8F1A', 'entities': '$8F2A', 'ropeGlobals': '$AA93',
        'scenarios': scenarios,
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, 'w') as f:
        json.dump(out, f)
        f.write('\n')
    print('ulozeno %s (%d kB)' % (os.path.relpath(args.out),
                                  os.path.getsize(args.out)//1024))


if __name__ == '__main__':
    main()
