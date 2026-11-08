#!/usr/bin/env python3
"""Vytáhne z originálu **zvuky** → `data/sounds.json` (M6).

    PYTHONPATH=tools/vendor ./tools/dumpsound.py [--print] [--wav build/sound]

Stroj má jediný bit zvuku (bit 4 portu `$FE`), takže zvuk **je** posloupnost
délek pulzů – nic víc se z hardwaru dostat nedá. Tenhle nástroj proto nedělá
model „podobného" zvuku: nechá **rutiny originálu v simulátoru skutečně hrát**
a zapíše, jak dlouho byl bit nahoře a jak dlouho dole (v T-stavech Z80).
Je to zvuková obdoba `roomlib.py`/`dumprooms.py`, kde místnost kreslí kód hry
a do dat se ukládá to, co po něm zůstane ve videopaměti.

Co se našlo (viz `sources/docs/disasm_notes.md` §16):

* **jádro je `$A06A`** – `B` je délka půlperiody (DJNZ), `C` počet period;
  `$A068` je totéž s `C = 1`. Perioda vyjde `26*B + 81` T, takže `B = $40`
  je 2005 Hz. Nic jiného zvuk nedělá – v celém programu jsou **čtyři**
  instrukce `OUT ($FE),A` a všechny píšou jen `$10` nebo `$00`.
* **sedm zvuků, které hra skutečně používá** a osm rutin, které v programu
  zůstaly, ale nikdo je nevolá (včetně tří „zvukových entit" `$89–$8B`
  v tabulce typů – slot `$904A` jim nikdo nenaplní):

  | rutina | zvuk | kde se volá |
  |---|---|---|
  | `$A07D` | krátký tón 2005 Hz, 32 ms | dopad `$A8B2`, náraz ve vzduchu `$A71E`, obrat úletu `$A991` |
  | `$A087` | krok: každý čtvrtý snímek chůze, dva tóny podle bitu 2 počítadla `$8EF6` | chůze `$A590` |
  | `$A0E4` | šestnáct period se klesající výškou | odskok `$A672`, sebrání předmětu `$E77B` |
  | `$A0F5` | osm period, výška podle `y` toho, co se dotklo | senzor kontaktu `$E2C6` |
  | `$A107` | dlouhý klesající sjezd, délka podle `$5C78` | něco umřelo `$DF42` |
  | `$A131` | 48 bajtů **ROM od `$0000`** vyklepaných po bitech = šum | projektil do stěny `$DEE2` |
  | `$A173` | čtyři periody 568 Hz | projektil na podlahu `$DED7` |

  `$A173` je zvláštní případ: vypadá jako sjezd o 64 krocích, ale smyčka končí
  `JP $A06A` místo `CALL`, takže se **zahraje jediná perioda té výšky** a rutina
  se vrátí volajícímu. Hraje se, co v obrazu je, ne co bylo zamýšleno.

* **hudba v originálu není žádná** a **border se jako efekt nepoužívá**
  (jediné zápisy do portu jsou `$10` a `$00`, tedy černý border).

`--wav` uloží každou variantu jako `.wav` (44,1 kHz), aby šlo poslechem
zkontrolovat, že to hraje to, co originál.
"""
import argparse, io, json, os, struct, sys
from contextlib import redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'vendor'))
sys.path.insert(0, HERE)

import roomlib                                                   # noqa: E402

IMAGE = os.path.join(HERE, '..', 'build/underwurlde-run.bin')
OUT = os.path.join(HERE, '..', 'data/sounds.json')

T, PC, SP, IXh, IXl = 25, 24, 12, 8, 9
SENTINEL = 0x5B00                # návratová adresa, na které se běh zastaví
STACK = 0x6000                   # SP jako ve hře (roomlib)
FRAMES = 0x5C78                  # počítadlo snímků ULA
STEP_COUNTER = 0x8EF6            # počítadlo kroků chůze ($A087)
SCRATCH = 0x5B20                 # atrapa záznamu entity pro senzor kontaktu

CLOCK = 3500000                  # T-stavů za sekundu (48K ZX)

# ---------------------------------------------------------------------------
# Konstanty: (jméno, adresa, bajty instrukce s None na místě operandu, komentář)
# Stejná disciplína jako dumpphysics.py / dumpmonsters.py: co se neshoduje,
# to nástroj neodhadne – spadne.
# ---------------------------------------------------------------------------
CONSTANTS = [
    # --- jádro $A068 / $A06A ------------------------------------------------
    ('singleCycle',     0xA068, [0x0E, None],
     'LD C,n — $A068 je $A06A s jedinou periodou'),
    ('speakerOn',       0xA06A, [0x3E, None, 0xD3, 0xFE],
     'LD A,n / OUT ($FE),A — bit 4 nahoru (a border 0, tedy černý)'),
    ('speakerOff',      0xA073, [0xAF, 0xD3, 0xFE],
     'XOR A / OUT ($FE),A — bit 4 dolů; jiná hodnota se na port nepíše'),
    # --- $A07D krátký tón ---------------------------------------------------
    ('blipPulse',       0xA07D, [0x01, 0x40, None],
     'LD BC,nn — B: délka půlperiody krátkého tónu'),
    ('blipCycles',      0xA07D, [0x01, None, 0x40],
     'LD BC,nn — C: kolik period krátký tón má'),
    # --- $A087 krok ---------------------------------------------------------
    ('stepCounter',     0xA087, [0x21, None, None],
     'LD HL,nn — počítadlo kroků chůze, které rutina sama zvyšuje'),
    ('stepMask',        0xA08C, [0xE6, None],
     'AND n — hraje se jen na každém n+1. snímku chůze'),
    ('stepBit',         0xA08F, [0xCB, 0x56],
     'BIT 2,(HL) — bit 2 počítadla přepíná mezi dvěma výškami'),
    ('stepPulseHigh',   0xA093, [0x01, 0x04, None],
     'LD BC,nn — B: půlperioda, když je bit 2 počítadla nastavený'),
    ('stepPulseLow',    0xA098, [0x01, 0x04, None],
     'LD BC,nn — B: půlperioda, když je bit 2 počítadla nulový'),
    ('stepCycles',      0xA093, [0x01, None, 0x40],
     'LD BC,nn — C: kolik period má jeden krok'),
    # --- $A0E4 odskok a sebrání --------------------------------------------
    ('chirpSteps',      0xA0E4, [0x16, None],
     'LD D,n — kolik period (každá jiné výšky) má sjezd odskoku'),
    ('chirpXor',        0xA0E9, [0xEE, None],
     'XOR n — z počítadla D se výška počítá RLCA,RLCA,XOR n,RLCA,RLCA'),
    # --- $A0F5 kontakt ------------------------------------------------------
    ('touchSteps',      0xA0F5, [0x16, None],
     'LD D,n — kolik period má zvuk doteku'),
    ('touchMask',       0xA0FB, [0xE6, None],
     'AND n — výška se počítá z (D + y entity) & n, takže záleží na dolním půlbajtu y'),
    # --- $A107 něco umřelo --------------------------------------------------
    ('deathFrames',     0xA107, [0x3A, None, None],
     'LD A,(nn) — počítadlo snímků ULA, ze kterého se bere délka sjezdu'),
    ('deathOr',         0xA10F, [0xF6, None],
     'OR n — po prohození půlbajtů se doplní dolní bity'),
    ('deathAnd',        0xA111, [0xE6, None],
     'AND n — a odřízne se bit 7, takže variant je osm'),
    ('deathXor',        0xA115, [0xEE, None],
     'XOR n — výška periody je (D XOR n) << 1'),
    # --- $A131 šum ----------------------------------------------------------
    ('noiseBits',       0xA131, [0x01, 0x30, None],
     'LD BC,nn — B: kolik bitů se vyklepe z jednoho bajtu'),
    ('noiseBytes',      0xA131, [0x01, None, 0x08],
     'LD BC,nn — C: kolik bajtů šum přečte'),
    ('noiseSource',     0xA134, [0x21, None, None],
     'LD HL,nn — odkud: $0000, tedy začátek ROM. Data pro šum jsou cizí kód.'),
    ('noiseBit',        0xA13C, [0x7B, 0xE6, None],
     'LD A,E / AND n — na port jde jediný bit rotovaného bajtu'),
    # --- $A173 projektil na podlahu ----------------------------------------
    ('splashStart',     0xA173, [0x16, None],
     'LD D,n — počáteční hodnota sjezdu; zahraje se jen první perioda'),
    ('splashCycles',    0xA17C, [0x0E, None],
     'LD C,n — kolik period se zahraje'),
    ('splashTail',      0xA17E, [0xC3, 0x6A, 0xA0],
     'JP $A06A — tady mel byt CALL: smycka se JP nevrati, takze sjezd nikdy '
     'nedojde na druhou periodu'),
]

# volání zvukových rutin: (adresa, instrukce, rutina, událost, návratové adresy)
# Návratové adresy jsou to, po čem `tracesound.py` v zásobníku pozná, kdo zvuk
# hraje. U CALL je to adresa+3; `$DED7` je ale JP, takže se zvuk pozná až po
# návratových adresách rutiny `$DEB8`, ve které ten JP je (a ta se volá ze dvou
# míst – ověřeno níž, jinak nástroj spadne).
CALL_SITES = [
    (0xA71E, [0xCD, 0x7D, 0xA0], 0xA07D, 'naraz ve vzduchu ($A70D)'),
    (0xA8B2, [0xCD, 0x7D, 0xA0], 0xA07D, 'dopad na zem ($A8A0)'),
    (0xA991, [0xC4, 0x7D, 0xA0], 0xA07D, 'obrat uletu pri padu ($A95E)'),
    (0xA590, [0xCD, 0x87, 0xA0], 0xA087, 'chuze ($A54A/$A56E)'),
    (0xA672, [0xCD, 0xE4, 0xA0], 0xA0E4, 'odskok ($A645)'),
    (0xE77B, [0xCD, 0xE4, 0xA0], 0xA0E4, 'sebrani predmetu ($E775)'),
    (0xE2C6, [0xCD, 0xF5, 0xA0], 0xA0F5, 'senzor kontaktu ($E285/$E28D)'),
    (0xDF42, [0xCD, 0x07, 0xA1], 0xA107, 'neco umrelo ($DF42)'),
    (0xDEE2, [0xCD, 0x31, 0xA1], 0xA131, 'projektil do steny ($DEDA)'),
    (0xDED7, [0xC3, 0x73, 0xA1], 0xA173, 'projektil na podlahu ($DEB8)',
     [0xB5C2, 0xB650]),
]

# $DEB8 (rutina s tím JP) se volá jedině z těchto dvou míst
SPLASH_CALLERS = [(0xB5BF, [0xCD, 0xB8, 0xDE]), (0xB64D, [0xCD, 0xB8, 0xDE])]

# rutiny, které v programu jsou a nikdo je nevolá; deadness se **nehádá**,
# ověřuje ji průchod celým obrazem (check_unused) i tabulka typů
UNUSED = [
    (0xA082, 'LD BC,$2080 — tón, který nikdo nehraje'),
    (0xA09D, 'LD BC,$8060 — totéž'),
    (0xA0A2, 'nastavovač zvukové entity typu $89 do slotu $904A'),
    (0xA0AC, 'obsluha zvukové entity $89 (v tabulce typů je, nikdo ji nezaloží)'),
    (0xA0C0, 'nastavovač zvukové entity typu $8A'),
    (0xA0C5, 'obsluha zvukové entity $8A'),
    (0xA0D8, 'stoupající sjezd o dvanácti periodách'),
    (0xA122, 'perioda podle (IX+$06)'),
    (0xA148, 'nastavovač entity typu $A0 – ten je i mimo tabulku typů ($00–$8B)'),
    (0xA14E, 'obsluha té entity, výška z tabulky $A163'),
]

# co ze zvukové části programu smí být vidět zvenčí: sedm zvuků a bodování
EXPECTED_ENTRIES = {
    0xA045: 'bodovani (neni zvuk, jen sousedi)',
    0xA07D: 'blip', 0xA087: 'step', 0xA0E4: 'chirp', 0xA0F5: 'touch',
    0xA107: 'death', 0xA131: 'noise', 0xA173: 'splash',
    0xA0AC: 'obsluha zvukove entity $89 (jen tabulka typu, nikdo ji nezalozi)',
    0xA0C5: 'obsluha zvukove entity $8A (totez)',
}
SOUND_RANGE = (0xA045, 0xA181)
SOUND_SLOT = 0x904A              # slot zvukové entity (pátý záznam zbraně)
SOUND_SLOT_WRITER = 0xA0A6       # operand LD HL,$904A v mrtvém nastavovači
TYPE_TABLE = 0x921A
TYPE_COUNT = 0x8C                # tabulka typů má 140 položek, $00–$8B

# zvuky: jméno, rutina, jak se vybírá varianta, seznam variant a jejich příprava
SOUND_ORDER = ['blip', 'step', 'chirp', 'touch', 'death', 'noise', 'splash']


# hodnoty, které nejsou operandem, ale plynou z ověřené instrukce
FIXED = {
    'stepBit': 4,             # BIT 2,(HL) -> maska $04
    'speakerOff': 0,          # XOR A -> na port jde nula
    'splashTail': 'JP',       # $A17E je JP, ne CALL – proto jediná perioda
}


def peek(ram, addr, count=1):
    return ram[addr-0x4000:addr-0x4000+count]


def extract(ram, name, addr, pattern, note):
    """Ověří instrukci na `addr` a vrátí přečtené operandy (dumpphysics.py)."""
    got = peek(ram, addr, len(pattern))
    operands = []
    for i, expected in enumerate(pattern):
        if expected is None:
            operands.append(got[i])
        elif got[i] != expected:
            raise SystemExit('%s: $%04X+%d ceka %02X, v obrazu je %02X (%s)'
                             % (name, addr, i, expected, got[i], note))
    if not operands:
        return None                     # jen kontrola vzoru, hodnota je v FIXED
    if len(operands) == 2:
        return operands[0] | operands[1] << 8
    if len(operands) == 1:
        return operands[0]
    return list(operands)


def check_calls(ram):
    """Ověří, že volání zvuků sedí bajt po bajtu, a vrátí tabulku události."""
    out = []
    for site in CALL_SITES:
        addr, pattern, routine, event = site[:4]
        returns = site[4] if len(site) > 4 else [addr+len(pattern)]
        got = list(peek(ram, addr, len(pattern)))
        if got != pattern:
            raise SystemExit('volani $%04X: ceka %s, v obrazu je %s'
                             % (addr, ' '.join('%02X' % b for b in pattern),
                                ' '.join('%02X' % b for b in got)))
        out.append({'call': '$%04X' % addr, 'routine': '$%04X' % routine,
                    'event': event,
                    'returns': ['$%04X' % r for r in returns]})
    for caller, pattern in SPLASH_CALLERS:
        got = list(peek(ram, caller, len(pattern)))
        if got != pattern:
            raise SystemExit('$%04X ma byt CALL $DEB8, je tam %s'
                             % (caller, ' '.join('%02X' % b for b in got)))
    found = []
    for i in range(len(ram)-2):
        if (ram[i+1] | ram[i+2] << 8) == 0xDEB8 and ram[i] in (0xCD, 0xC3):
            found.append(0x4000+i)
    if found != [addr for addr, _ in SPLASH_CALLERS]:
        raise SystemExit('$DEB8 se vola i z $%s'
                         % ', $'.join('%04X' % a for a in found))
    return out


def entry_points(ram):
    """Kdo do zvukové části programu skáče **zvenčí** – průchod celým obrazem.

    Sbírá absolutní volání a skoky, relativní JR/DJNZ i tabulku typů entit,
    a vrací {adresa: [odkud]} pro cíle uvnitř zvukové části, na které ukazuje
    něco mimo ni. Deadness se tím neodhaduje, ale měří.
    """
    lo, hi = SOUND_RANGE
    abs_ops = {0xCD: 'CALL', 0xC3: 'JP', 0xC4: 'CALL NZ', 0xCC: 'CALL Z',
               0xD4: 'CALL NC', 0xDC: 'CALL C', 0xE4: 'CALL PO',
               0xEC: 'CALL PE', 0xF4: 'CALL P', 0xFC: 'CALL M',
               0xC2: 'JP NZ', 0xCA: 'JP Z', 0xD2: 'JP NC', 0xDA: 'JP C',
               0xE2: 'JP PO', 0xEA: 'JP PE', 0xF2: 'JP P', 0xFA: 'JP M'}
    rel_ops = {0x18: 'JR', 0x20: 'JR NZ', 0x28: 'JR Z', 0x30: 'JR NC',
               0x38: 'JR C', 0x10: 'DJNZ'}
    found = {}
    for i in range(len(ram)-2):
        addr = 0x4000+i
        if lo <= addr < hi:
            continue                       # skoky uvnitř zvukové části
        word = ram[i+1] | ram[i+2] << 8
        if ram[i] in abs_ops and lo <= word < hi:
            found.setdefault(word, []).append('%s $%04X' % (abs_ops[ram[i]], addr))
        if ram[i] in rel_ops:
            delta = ram[i+1]-256 if ram[i+1] > 127 else ram[i+1]
            target = addr+2+delta
            if lo <= target < hi:
                found.setdefault(target, []).append('%s $%04X'
                                                    % (rel_ops[ram[i]], addr))
    for type_ in range(TYPE_COUNT):
        at = TYPE_TABLE+2*type_
        word = peek(ram, at, 2)
        handler = word[0] | word[1] << 8
        if lo <= handler < hi:
            found.setdefault(handler, []).append('typ $%02X' % type_)
    return found


def check_unused(ram):
    """Ověří, že mrtvé rutiny jsou mrtvé a že zvenčí není vidět nic dalšího."""
    found = entry_points(ram)
    unexpected = sorted(set(found) - set(EXPECTED_ENTRIES))
    if unexpected:
        raise SystemExit('do zvuku skace i $%s – tabulka zvuku je neuplna'
                         % ', $'.join('%04X (%s)' % (a, ', '.join(found[a]))
                                      for a in unexpected))
    missing = sorted(set(EXPECTED_ENTRIES) - set(found))
    if missing:
        raise SystemExit('cekana zvukova rutina $%s neni odnikud volana'
                         % ', $'.join('%04X' % a for a in missing))
    out = []
    for addr, note in UNUSED:
        refs = [r for r in found.get(addr, []) if not r.startswith('typ ')]
        if refs:
            raise SystemExit('$%04X mela byt mrtva, vola ji %s'
                             % (addr, ', '.join(refs)))
        out.append({'routine': '$%04X' % addr, 'note': note,
                    'references': found.get(addr, []) or None})
    # a k tomu: typy zvukových entit nikdo do žádného slotu nezapíše
    written = set()
    for i in range(len(ram)-3):
        if ram[i] == 0xDD and ram[i+1] == 0x36 and ram[i+2] == 0x00:
            written.add(ram[i+3])
    for type_ in (0x89, 0x8A, 0x8B):
        if type_ in written:
            raise SystemExit('typ $%02X se prece jen zaklada' % type_)
    # slot $904A (pátý záznam zbraně) plní jedině mrtvý nastavovač $A0A5
    slot_writers = []
    for i in range(len(ram)-2):
        if (ram[i+1] | ram[i+2] << 8) == SOUND_SLOT:
            slot_writers.append(0x4000+i+1)
    if slot_writers != [SOUND_SLOT_WRITER]:
        raise SystemExit('do slotu $%04X pise i %s'
                         % (SOUND_SLOT, ', '.join('$%04X' % a for a in slot_writers)))
    return out


def port_writes(ram):
    """Všechny instrukce OUT ($FE),A v obraze a hodnota, kterou píšou."""
    out = []
    for i in range(len(ram)-1):
        if ram[i] == 0xD3 and ram[i+1] == 0xFE:
            addr = 0x4000+i
            before = ram[i-2:i]
            value = None
            if len(before) == 2 and before[0] == 0x3E:
                value = before[1]                  # LD A,n
            elif len(before) == 2 and before[1] == 0xAF:
                value = 0                          # XOR A
            elif len(before) == 2 and before[0] == 0xE6:
                value = 'A AND $%02X' % before[1]  # AND n (šum)
            out.append({'address': '$%04X' % addr,
                        'value': value if isinstance(value, str)
                        else ('$%02X' % value if value is not None else '?')})
    return out


class Player:
    """Rozehraná hra, ve které se dají zvukové rutiny nechat zahrát."""

    def __init__(self, frames=200):
        self.game = roomlib.Game(frames=frames)
        self.sim = self.game.sim
        self.tracer = self.sim.tracer
        self.log = []
        # tracer si vede audio_log jen jako „změnilo se", tady je potřeba
        # i úroveň, takže se zápisy na port sbírají vlastním háčkem
        original = self.tracer._write_port

        def hook(registers, port, value, offset):
            if port % 2 == 0:
                self.log.append((registers[T], 1 if value & 0x10 else 0))
            return original(registers, port, value, offset)

        self.tracer.write_port = hook
        self.sim.set_tracer(self.tracer)

    def play(self, entry, ix=None, poke=None):
        """Zahraje jednu rutinu a vrátí (počáteční úroveň, délky pulzů v T)."""
        memory, registers = self.game.state
        mem, reg = self.sim.memory, self.sim.registers
        mem[:] = memory
        reg[:] = registers
        if poke:
            for addr, value in poke.items():
                mem[addr] = value
        if ix is not None:
            reg[IXh], reg[IXl] = ix >> 8, ix & 0xFF
        mem[STACK-2] = SENTINEL & 0xFF
        mem[STACK-1] = SENTINEL >> 8
        reg[SP] = STACK-2
        reg[26] = 0                                  # bez přerušení
        reg[T] = 0
        self.log = []
        with redirect_stdout(io.StringIO()):
            self.sim.run(entry, SENTINEL, False)
        if self.sim.registers[PC] != SENTINEL:
            raise SystemExit('$%04X se nevratila (PC = $%04X)'
                             % (entry, self.sim.registers[PC]))
        return self.transitions()

    def transitions(self):
        """Ze zápisů na port udělá přechody: (úroveň prvního pulzu, délky)."""
        edges = []
        level = 0                                    # před zvukem je bit dole
        for t, value in self.log:
            if value != level:
                edges.append(t)
                level = value
        if not edges:
            return 0, []
        first = 1 if self.log[0][1] else 0
        # délka pulzu je vzdálenost mezi přechody; poslední pulz zvuk ukončuje
        return first, [b-a for a, b in zip(edges, edges[1:])]


def sounds(player, values):
    """Nechá originál zahrát každý zvuk v každé variantě, kterou umí."""
    out = {}

    level, pulses = player.play(0xA07D)
    out['blip'] = {
        'routine': '$A07D',
        'note': 'B = $%02X, C = $%02X: %d period jedne vysky'
                % (values['blipPulse'], values['blipCycles'],
                   values['blipCycles']),
        'select': None,
        'variants': {'0': {'startLevel': level, 'pulses': pulses}},
    }

    # krok: rutina si počítadlo zvyšuje sama, takže se nastaví tak, aby po
    # INC (HL) vyšlo na hraní – jednou s bitem 2, jednou bez
    variants = {}
    for key, counter in (('1', 0x03), ('0', 0x07)):
        level, pulses = player.play(0xA087, poke={STEP_COUNTER: counter})
        if not pulses:
            raise SystemExit('krok: pri $8EF6 = %02X nic nehraje' % counter)
        variants[key] = {'startLevel': level, 'pulses': pulses}
    out['step'] = {
        'routine': '$A087',
        'note': 'hraje na kazdem %d. snimku chuze ($8EF6 & $%02X == 0); '
                'varianta je bit 2 pocitadla'
                % (values['stepMask']+1, values['stepMask']),
        'select': 'stepCounter & 4',
        'variants': variants,
    }
    # a ověřit, že na ostatních snímcích je ticho
    for counter in (0x00, 0x01, 0x04, 0x05):
        level, pulses = player.play(0xA087, poke={STEP_COUNTER: counter})
        if pulses:
            raise SystemExit('krok: pri $8EF6 = %02X ma byt ticho' % counter)

    level, pulses = player.play(0xA0E4)
    out['chirp'] = {
        'routine': '$A0E4',
        'note': '%d period, vyska z pocitadla D (RLCA,RLCA,XOR $%02X,RLCA,RLCA)'
                % (values['chirpSteps'], values['chirpXor']),
        'select': None,
        'variants': {'0': {'startLevel': level, 'pulses': pulses}},
    }

    # dotek: výška závisí na dolním půlbajtu y toho, co se dotklo
    variants = {}
    for low in range(values['touchMask']+1):
        poke = {SCRATCH+3: low}
        level, pulses = player.play(0xA0F5, ix=SCRATCH, poke=poke)
        variants[str(low)] = {'startLevel': level, 'pulses': pulses}
    out['touch'] = {
        'routine': '$A0F5',
        'note': '%d period, vyska z (D + y) & $%02X — varianta je y & $%02X'
                % (values['touchSteps'], values['touchMask'],
                   values['touchMask']),
        'select': 'y & 15',
        'variants': variants,
    }

    # něco umřelo: délka sjezdu se bere z počítadla snímků ULA
    variants = {}
    for phase in range(8):
        # D = ((prohozene pulbajty (frames+1)) | $0F) & $7F -> osm variant
        level, pulses = player.play(0xA107, poke={FRAMES: (phase-1) % 256})
        variants[str(phase)] = {'startLevel': level, 'pulses': pulses}
    out['death'] = {
        'routine': '$A107',
        'note': 'klesajici sjezd; delka z $5C78: D = (swap($5C78+1) | $%02X) '
                '& $%02X, period je (D+1)/2'
                % (values['deathOr'], values['deathAnd']),
        'select': '(frames + 1) & 7',
        'variants': variants,
    }

    level, pulses = player.play(0xA173)
    out['splash'] = {
        'routine': '$A173',
        'note': '%d period vysky z (D-1) rotovane o tri bity vpravo; smycka '
                'konci JP misto CALL, takze druha perioda uz neprijde'
                % values['splashCycles'],
        'select': None,
        'variants': {'0': {'startLevel': level, 'pulses': pulses}},
    }

    level, pulses = player.play(0xA131)
    out['noise'] = {
        'routine': '$A131',
        'note': '%d bajtu od $%04X (zacatek ROM) po %d bitech na port — sum'
                % (values['noiseBytes'], values['noiseSource'],
                   values['noiseBits']),
        'select': None,
        'variants': {'0': {'startLevel': level, 'pulses': pulses}},
    }
    return out


EVENTS = [
    ('step', 'step', 'chuze — $A590'),
    ('land', 'blip', 'dopad na zem — $A8B2'),
    ('bump', 'blip', 'naraz ve vzduchu a obrat uletu — $A71E, $A991'),
    ('jump', 'chirp', 'odskok — $A672'),
    ('gem', 'chirp', 'sebrani predmetu — $E77B'),
    ('life', None, 'extra zivot je tentyz predmet, zvuk uz zahralo "gem"'),
    ('touch', 'touch', 'cokoli se dotklo Sabremana — $E2C6'),
    ('kill', 'death', 'neco umrelo — $DF42'),
    ('hit', 'noise', 'projektil do steny — $DEE2'),
    ('touchFurniture', 'touch', 'tentyz senzor plati i pro nabytek a rostliny'),
    ('guardian', None, 'strazce umira jako kazdy jiny, zvuk zahralo "kill"'),
    ('shoot', None, 'vystrel v originalu zvuk nema ($B4D1 nic nevola)'),
    ('splash', 'splash', 'projektil na podlahu — $DED7'),
    ('death', None, 'smrt Sabremana zvuk nema ($E7D0 nic nevola)'),
]


def wav(path, level, pulses, rate=44100, volume=0.35):
    """Uloží pulzy jako .wav – jen pro kontrolu poslechem."""
    samples = []
    value = level
    for length in pulses:
        count = max(1, round(length*rate/CLOCK))
        samples += [volume if value else -volume]*count
        value = 1-value
    data = b''.join(struct.pack('<h', int(max(-1.0, min(1.0, s))*32767))
                    for s in samples)
    with open(path, 'wb') as f:
        f.write(b'RIFF'+struct.pack('<I', 36+len(data))+b'WAVEfmt ')
        f.write(struct.pack('<IHHIIHH', 16, 1, 1, rate, rate*2, 2, 16))
        f.write(b'data'+struct.pack('<I', len(data))+data)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--image', default=IMAGE)
    ap.add_argument('--out', default=OUT)
    ap.add_argument('--wav', metavar='DIR', help='ulozit varianty jako .wav')
    ap.add_argument('--print', action='store_true', dest='show')
    args = ap.parse_args()

    ram = open(args.image, 'rb').read()
    if len(ram) != 49152:
        raise SystemExit('cekam 49152 B RAM ($4000-$FFFF), mam %d' % len(ram))

    values, source = {}, {}
    for name, addr, pattern, note in CONSTANTS:
        value = extract(ram, name, addr, pattern, note)
        if value is None:                    # vzor bez operandu, jen kontrola
            value = FIXED[name]
        values[name] = value
        source[name] = {'address': '$%04X' % addr, 'note': note}

    calls = check_calls(ram)
    unused = check_unused(ram)
    writes = port_writes(ram)
    if len(writes) != 4:
        raise SystemExit('cekam ctyri OUT ($FE),A v programu, nasel jsem %d'
                         % len(writes))

    player = Player()
    data = sounds(player, values)

    out = {
        'note': 'M6: zvuky originalu. Jadro je $A06A (B = pulperioda, '
                'C = pocet period); pulzy nize nechala zahrat rutina '
                'originalu v simulatoru (tools/dumpsound.py), delky jsou '
                'v T-stavech Z80 pri 3.5 MHz. Hudbu hra zadnou nema a border '
                'jako efekt nepouziva.',
        'clock': CLOCK,
        'values': values,
        'source': source,
        'engine': {
            'core': '$A06A',
            'single': '$A068',
            'period': '26*B + 81 T (B = 0 znamena 256)',
            'note': 'perioda odmerena na behu, ne spocitana z tabulky casovani',
        },
        'portWrites': writes,
        'calls': calls,
        'unused': unused,
        'sounds': {name: data[name] for name in SOUND_ORDER},
        'events': [{'name': n, 'sound': s, 'note': note} for n, s, note in EVENTS],
    }

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, 'w') as f:
        json.dump(out, f, indent=1, sort_keys=False)
        f.write('\n')

    total = sum(len(v['variants']) for v in data.values())
    print('data/sounds.json: %d zvuku, %d variant, %d konstant, '
          '%d volani, %d mrtvych rutin'
          % (len(data), total, len(values), len(calls), len(unused)))
    for name in SOUND_ORDER:
        entry = data[name]
        first = entry['variants'][sorted(entry['variants'])[0]]
        span = sum(first['pulses'])
        print('  %-6s %s  %2d variant, %3d pulzu, %5.1f ms'
              % (name, entry['routine'], len(entry['variants']),
                 len(first['pulses']), 1000.0*span/CLOCK))
    if args.show:
        for name in SOUND_ORDER:
            for key in sorted(data[name]['variants'], key=lambda s: int(s)):
                v = data[name]['variants'][key]
                print('%s[%s] level %d: %s' % (name, key, v['startLevel'],
                                               v['pulses']))
    if args.wav:
        os.makedirs(args.wav, exist_ok=True)
        for name in SOUND_ORDER:
            for key, v in data[name]['variants'].items():
                path = os.path.join(args.wav, '%s-%s.wav' % (name, key))
                wav(path, v['startLevel'], v['pulses'])
        print('wav: %s' % args.wav)


if __name__ == '__main__':
    main()
