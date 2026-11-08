#!/usr/bin/env python3
"""Vytáhne z běžícího originálu **titulní obrazovku** → `data/title.json` (M6).

    PYTHONPATH=tools/vendor ./tools/dumptitle.py [--frames 900] [--scr build/title.scr]

Po nahrání se hra zastaví na obrazovce s volbou ovládání (`1 KEYBOARD` …
`0 START GAME`) – to je celá titulní obrazovka Underwurlde. Nástroj hru nechá
doběhnout do menu, opíše videopaměť a **ověří, že se obrazovka nehýbe**: porovná
ji ještě jednou o stovky snímků později.

Tím se zároveň odpovídá na položku M6 „attract mode (demo + hi-score)":
**žádný tam není**. Šedesát sekund běhu na titulní obrazovce dá pořád tentýž
obraz bajt po bajtu, hra na nic nepřepíná a hi-score originál nemá (v remaku ho
supluje hall of fame).

Formát je stejný jako u `mkscreen.py` (loading screen): bitmapa po pixelových
řádcích a atributy, obojí base64.
"""
import argparse, base64, hashlib, io, json, os, sys
from contextlib import redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'vendor'))
sys.path.insert(0, HERE)

import physlog                                                   # noqa: E402
from mkscreen import screen_offset                               # noqa: E402

OUT = os.path.join(HERE, '..', 'data/title.json')


def capture(frames, checks):
    """Spustí hru bez jediné klávesy a opíše obrazovku na daných snímcích."""
    shots = {}

    def on_frame(frame, scr, mem):
        if frame in checks:
            shots[frame] = bytes(scr)

    menu = physlog.MENU
    physlog.MENU = []                    # do menu se nemačká nic: titulní obraz
    try:
        with redirect_stdout(io.StringIO()):
            physlog.run(frames, [], on_frame=on_frame)
    finally:
        physlog.MENU = menu
    return shots


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--out', default=OUT)
    ap.add_argument('--frames', type=int, default=1500,
                    help='jak dlouho se ceka, jestli se obrazovka zmeni')
    ap.add_argument('--scr', help='ulozit i .scr (kontrola ocima)')
    args = ap.parse_args()

    first, last = 200, args.frames
    shots = capture(args.frames+2, {first, last})
    if first not in shots or last not in shots:
        raise SystemExit('hra se na titulni obrazovku nedostala')
    if shots[first] != shots[last]:
        raise SystemExit('obrazovka se mezi snimky %d a %d zmenila – originál '
                         'nejakou attract smycku prece jen ma' % (first, last))
    scr = shots[first]

    bitmap = bytearray()
    for y in range(192):
        base = screen_offset(y)
        bitmap += scr[base:base+32]

    data = {
        'note': 'M6: titulni obrazovka originalu, opsana z videopameti behu '
                '(tools/dumptitle.py). Obraz se za %d snimku nezmenil o jediny '
                'bajt, takze attract mode ani demo hra nema.' % (last-first),
        'name': 'TITLE SCREEN',
        'source': 'underwurlde.tap',
        'staticFrames': last-first,
        'width': 256, 'height': 192,
        'bitmap': base64.b64encode(bytes(bitmap)).decode('ascii'),
        'attributes': base64.b64encode(scr[6144:6912]).decode('ascii'),
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, 'w') as f:
        json.dump(data, f, indent=2)
        f.write('\n')
    if args.scr:
        with open(args.scr, 'wb') as f:
            f.write(scr)
    print('%s: obraz stejny na snimcich %d i %d (sha1 %s), attract mode zadny'
          % (os.path.relpath(args.out, os.path.join(HERE, '..')), first, last,
             hashlib.sha1(scr).hexdigest()[:12]))


if __name__ == '__main__':
    main()
