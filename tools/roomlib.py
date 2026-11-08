#!/usr/bin/env python3
"""Společný základ pro extrakci světa: nechá **originál sám** nakreslit místnost.

Není to reimplementace – místnost kreslí kód hry v simulátoru. Postup:

1. `boot()` spustí hru z kazetového snapshotu, projde menu a dojde do rozehrané
   hry (viz `mkruntime.py`; hra si po nahrání přesune blok o bajt dolů, takže
   runtime adresy jsou o 1 nižší než v `build/underwurlde.bin`).
2. `render(sim, col, row)` zapíše souřadnice místnosti do záznamu Sabremana
   (`$8F1C` sloupec, `$8F1E` řádek) a nechá proběhnout rutinu vstupu do
   místnosti `$9906` až po její konec `$996C`. Ta smaže hrací plochu a vykreslí
   kulisu; co zůstane ve videopaměti, jsou skutečné bajty originálu.

Nálezy o formátu (viz `sources/docs/disasm_notes.md` §9):

* tabulka místností je na **`$7000`**, adresa = `$7000 + 32*řádek + 2*sloupec`
  (rutina `$98B2`), mřížka **16 × 52**, `0000` = místnost neexistuje;
* místnost je popsaná **jedním bajtem** (druhý bajt je v celé tabulce nulový);
* bity 0/2/4/6 toho bajtu jsou **uzavřené strany** místnosti
  (0 = strop, 2 = pravá stěna, 4 = podlaha, 6 = levá stěna), bity 1/3/5/7 jsou
  vždy 1; z bajtu se skládá kulisa čtyřmi trojbitovými poli (rutina `$9DA0`);
* řádky 0–15 (hrad a stromy) kreslí jen kulisu, řádky 16–51 (jeskyně) k ní
  přidávají osm dalších rutin `$99F5`–`$9BB8`, které vybírají grafiku podle
  `sloupec + řádek`.
"""
import io, os, sys
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

COLS, ROWS = 16, 52             # mřížka světa
ROOM_TABLE = 0x7000             # tabulka místností (2 B na místnost)
ROOM_STRIDE = 32                # bajtů na řádek mřížky
CASTLE_ROWS = 16                # řádky < 16 kreslí jen kulisu

PLAYER = 0x8F1A                 # záznam Sabremana, IX při kreslení místnosti
PLAYER_COL, PLAYER_ROW = PLAYER+2, PLAYER+4
ROOM_SETUP, SETUP_END = 0x9906, 0x996C   # rutina vstupu do místnosti a její konec

PANEL_ROWS = 2                  # znakové řádky panelu
PLAY_ROWS = 24-PANEL_ROWS       # 22 znakových řádků hrací plochy
PLAY_LINES = PLAY_ROWS*8        # 176 px
BITMAP_LEN, ATTRS_LEN = PLAY_LINES*32, PLAY_ROWS*32

# jméno strany podle bitu v popisném bajtu
SIDES = ((0, 'top'), (2, 'right'), (4, 'bottom'), (6, 'left'))


def screen_offset(y):
    """Offset pixelového řádku y (0–191) v 6912B obrazu."""
    third, char_row, pix = y >> 6, (y >> 3) & 7, y & 7
    return (third << 11) | (pix << 8) | (char_row << 5)


def play_area(scr):
    """Hrací plocha jako (bitmapa 5632 B po řádcích, atributy 704 B)."""
    bitmap = bytearray()
    for y in range(PANEL_ROWS*8, 192):
        base = screen_offset(y)
        bitmap += scr[base:base+32]
    return bytes(bitmap), bytes(scr[6144+PANEL_ROWS*32:6144+24*32])


def to_scr(bitmap, attrs):
    """Zpátky do 6912B obrazu (panel černý) – kvůli náhledům."""
    scr = bytearray(6912)
    for row, y in enumerate(range(PANEL_ROWS*8, 192)):
        scr[screen_offset(y):screen_offset(y)+32] = bitmap[row*32:row*32+32]
    scr[6144+PANEL_ROWS*32:6144+24*32] = attrs
    return bytes(scr)


class Game:
    """Rozehraná hra v simulátoru, ze které se dají tahat místnosti."""

    def __init__(self, snapshot_path=SNAPSHOT, frames=200):
        snapshot = Snapshot.get(snapshot_path)
        if snapshot is None:
            raise SystemExit('nelze nacist snapshot %s' % snapshot_path)
        cls = CSimulator or Simulator
        self.sim = from_snapshot(cls, snapshot, {}, {'ay': [None]*16},
                                 {'fast_djnz': False, 'fast_ldir': False}, None)
        tracer = Tracer(self.sim, snapshot.border, snapshot.out7ffd, snapshot.outfffd,
                        list(snapshot.ay), snapshot.outfe, True)
        self.sim.set_tracer(tracer)

        def draw(scr, frame, border, keyboard):
            for i in range(8):
                keyboard[i] = 0
            if 60 <= frame < 70:
                keyboard[3] |= 1        # '1' – klávesnice
            if 100 <= frame < 110:
                keyboard[4] |= 1        # '0' – START GAME
            return frame < frames

        with redirect_stdout(io.StringIO()):        # Tracer si tiskne, kde skončil
            tracer.run(snapshot.pc, -1, 0, 0, True, draw, None, None, None,
                       '$', '04X', '04X')
        # výchozí stav rozehrané hry, ze kterého se kreslí každá místnost
        self.state = (list(self.sim.memory), self.sim.registers[:])
        self.ram = bytes(self.sim.memory[0x4000:])

    def peek(self, addr, count=1):
        return bytes(self.ram[addr-0x4000:addr-0x4000+count])

    def descriptor(self, col, row):
        """Popisné dvoubajtové slovo místnosti z tabulky na $7000."""
        addr = ROOM_TABLE + ROOM_STRIDE*row + 2*col
        lo, hi = self.peek(addr, 2)
        return lo | hi << 8

    def rooms(self):
        """Seznam (sloupec, řádek, popisný bajt) existujících místností."""
        out = []
        for row in range(ROWS):
            for col in range(COLS):
                desc = self.descriptor(col, row)
                if desc:
                    out.append((col, row, desc & 0xFF))
        return out

    def render(self, col, row, prepare=None):
        """Nechá originál nakreslit místnost; vrátí (bitmapa, atributy).

        `prepare(memory)` se zavolá po obnovení výchozího stavu a před spuštěním
        rutiny – tím se dají nastavit počítadla a stavové tabulky, na kterých
        rozmístění entit závisí (`tools/traceentities.py`).
        """
        memory, registers = self.state
        self.sim.memory[:] = memory                 # deterministický výchozí stav
        self.sim.registers[:] = registers
        self.sim.memory[PLAYER_COL] = col
        self.sim.memory[PLAYER_ROW] = row
        if prepare:
            prepare(self.sim.memory)
        reg = self.sim.registers
        reg[8], reg[9] = PLAYER >> 8, PLAYER & 0xFF     # IX = záznam Sabremana
        reg[12] = 0x6000                                # SP jako v hře
        reg[26] = 0                                     # bez přerušení
        self.sim.run(ROOM_SETUP, SETUP_END, False)
        return play_area(self.sim.memory[0x4000:0x5B00])


def exits(desc):
    """Otevřené strany místnosti podle popisného bajtu."""
    return [name for bit, name in SIDES if not desc >> bit & 1]


def closed(desc):
    return [name for bit, name in SIDES if desc >> bit & 1]
