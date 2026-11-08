#!/usr/bin/env python3
"""Trasuje hru **s pořadím instrukcí a s přístupy do paměti** – nástroj na disassembly.

    PYTHONPATH=tools/vendor ./tools/memtrace.py --from-frame 100 --to-frame 125 \\
        [--keys 300:420:W] [--reads 6800:9000] [--writes 4000:5B00] [--probe 9DA0]

Tohle je nástroj, kterým se v M2 našel formát dat místností (a při tom i to, že
si hra po nahrání přesune blok o bajt – `sources/docs/disasm_notes.md` §9).
Postup, který funguje: **nejdřív se hra nechá běžet a zapíše se, co dělá**, a
teprve podle toho se disassembluje (`tools/uwdis.py`).

Co se zapisuje v okně mezi `--from-frame` a `--to-frame`:

* **pořadí vykonaných instrukcí** (vlastní `exec_map`, který si na rozdíl od
  SkoolKitu pamatuje i pořadí) → volací strom, tj. které rutiny se vlastně
  volají a odkud;
* **čtení** z rozsahu `--reads` s adresou instrukce, která čte (bez čtení
  samotného kódu) → odkud rutina bere data; vypíše se po spojitých úsecích,
  takže tabulky a bloky grafiky vylezou samy;
* **zápisy** do rozsahu `--writes` s adresou instrukce → která rutina kreslí
  do videopaměti nebo píše do proměnných;
* **registry** v okamžiku, kdy PC dosáhne adresy z `--probe`.

Simulátor je tady **čistě pythonový** (ne C), protože paměť je obalená
logováním – je to řádově pomalejší, takže okno má být krátké (jednotky až
desítky snímků). Klávesy se zadávají jako `od:do:KLÁVESA`, snímky se počítají
od začátku běhu; menu se odklikne samo (`1` = klávesnice, `0` = START GAME).
"""
import argparse, io, os, sys
from collections import Counter, OrderedDict
from contextlib import redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'vendor'))
sys.path.insert(0, HERE)

from skoolkit.snapshot import Snapshot                          # noqa: E402
from skoolkit.simulator import Simulator                        # noqa: E402
from skoolkit.simutils import from_snapshot                     # noqa: E402
from skoolkit.trace import Tracer                               # noqa: E402
from uwdis import Config                                         # noqa: E402
from skoolkit.disassembler import Disassembler                   # noqa: E402

SNAPSHOT = os.path.join(HERE, '..', 'build/underwurlde.z80')

# klávesa -> (index půlřádku v poli keyboard[], bit) – viz sources/docs/hw_notes.md §6
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
MENU = [(60, 70, '1'), (100, 110, '0')]     # volba ovládání a START GAME


class WatchedMemory(list):
    """Paměť simulátoru, která si zapisuje čtení a zápisy ve zvolených rozsazích."""
    __slots__ = ('registers', 'reads', 'writes', 'on', 'rlo', 'rhi', 'wlo', 'whi')

    def setup(self, registers, reads, writes):
        self.registers = registers
        self.reads, self.writes, self.on = [], [], False
        (self.rlo, self.rhi), (self.wlo, self.whi) = reads, writes

    def __getitem__(self, index):
        value = list.__getitem__(self, index)
        if self.on and type(index) is int and self.rlo <= index < self.rhi:
            self.reads.append((self.registers[24], index, value))
        return value

    def __setitem__(self, index, value):
        list.__setitem__(self, index, value)
        if self.on and self.wlo <= index < self.whi:
            self.writes.append((self.registers[24], index, value))


def ranges(addresses):
    """Spojité úseky ze setu adres."""
    addresses = sorted(addresses)
    out, start, prev = [], addresses[0], addresses[0]
    for addr in addresses[1:]:
        if addr == prev+1:
            prev = addr
            continue
        out.append((start, prev))
        start = prev = addr
    out.append((start, prev))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--snapshot', default=SNAPSHOT)
    ap.add_argument('--from-frame', type=int, default=100)
    ap.add_argument('--to-frame', type=int, default=125)
    ap.add_argument('--frames', type=int, help='dokdy vubec simulovat (vychozi: to-frame+5)')
    ap.add_argument('--keys', default='', help='"od:do:KLAVESA,..." nad ramec menu')
    ap.add_argument('--reads', default='5B00:F000', help='rozsah cteni, hexa od:do')
    ap.add_argument('--writes', default='4000:5B00', help='rozsah zapisu, hexa od:do')
    ap.add_argument('--probe', default='', help='adresy (hexa, oddelene carkou): vypsat registry')
    ap.add_argument('--top', type=int, default=15, help='kolik radek v prehledech')
    args = ap.parse_args()

    script = list(MENU)
    for part in filter(None, args.keys.split(',')):
        start, end, key = part.split(':')
        script.append((int(start), int(end), key.upper()))
    reads = tuple(int(x, 16) for x in args.reads.split(':'))
    writes = tuple(int(x, 16) for x in args.writes.split(':'))
    probes = {int(x, 16) for x in filter(None, args.probe.split(','))}
    last_frame = args.frames or args.to_frame+5

    snapshot = Snapshot.get(args.snapshot)
    if snapshot is None:
        raise SystemExit('nelze nacist snapshot %s' % args.snapshot)
    simulator = from_snapshot(Simulator, snapshot, {}, {'ay': [None]*16},
                              {'fast_djnz': False, 'fast_ldir': False}, None)
    memory = WatchedMemory(simulator.memory)
    memory.setup(simulator.registers, reads, writes)
    simulator.memory = memory
    simulator.create_opcodes()
    tracer = Tracer(simulator, snapshot.border, snapshot.out7ffd, snapshot.outfffd,
                    list(snapshot.ay), snapshot.outfe, True)
    simulator.set_tracer(tracer)

    executed, probed = [], []
    registers = simulator.registers

    class OrderedExecMap:
        """SkoolKit chce jen .add(pc); nám jde o pořadí, ne o množinu."""
        def add(self, pc):
            if not memory.on:
                return
            executed.append(pc)
            if pc in probes:
                probed.append((pc, snapshot_registers(registers)))

    def draw(scr, frame, border, keyboard):
        for i in range(8):
            keyboard[i] = 0
        for start, end, key in script:
            if start <= frame < end:
                row, bit = KEYS[key]
                keyboard[row] |= 1 << bit
        memory.on = args.from_frame <= frame < args.to_frame
        return frame < last_frame

    with redirect_stdout(io.StringIO()):
        tracer.run(snapshot.pc, -1, 0, 0, True, draw, OrderedExecMap(), None, None,
                   '$', '04X', '04X')

    report(args, memory, executed, probed, reads, writes)


def snapshot_registers(r):
    return OrderedDict((('A', r[0]), ('F', r[1]), ('BC', r[3]+256*r[2]),
                        ('DE', r[5]+256*r[4]), ('HL', r[7]+256*r[6]),
                        ('IX', r[9]+256*r[8]), ('IY', r[11]+256*r[10]),
                        ('SP', r[12]), ("BC'", r[19]+256*r[18]),
                        ("DE'", r[21]+256*r[20]), ("HL'", r[23]+256*r[22])))


def report(args, memory, executed, probed, reads, writes):
    print('snimky %d-%d: %d instrukci, %d cteni, %d zapisu'
          % (args.from_frame, args.to_frame, len(executed),
             len(memory.reads), len(memory.writes)))
    if not executed:
        print('okno je prazdne – zkontroluj --from-frame/--to-frame')
        return

    disassembler = Disassembler([0]*16384+list(memory[0x4000:]), Config())
    cache = {}

    def instruction(pc):
        if pc not in cache:
            ins = disassembler.disassemble(pc, pc+1, 'n')[0]
            cache[pc] = (ins.operation, len(ins.bytes))
        return cache[pc]

    calls = OrderedDict()
    for i in range(len(executed)-1):
        pc = executed[i]
        operation, length = instruction(pc)
        if operation.startswith(('CALL', 'RST')) and executed[i+1] != pc+length:
            entry = calls.setdefault(executed[i+1], [0, pc])
            entry[0] += 1
    print('\nvolane rutiny (v poradi prvniho volani, %d celkem):' % len(calls))
    for target, (count, first) in list(calls.items())[:args.top*2]:
        print('  $%04X  %5dx  poprve z $%04X' % (target, count, first))

    if memory.writes:
        print('\nzapisy do $%04X-$%04X podle instrukce:' % (writes[0], writes[1]-1))
        by_pc = Counter(pc for pc, addr, value in memory.writes)
        targets = {}
        for pc, addr, value in memory.writes:
            lo, hi = targets.get(pc, (addr, addr))
            targets[pc] = (min(lo, addr), max(hi, addr))
        for pc, count in by_pc.most_common(args.top):
            print('  $%04X  %5dx  do $%04X-$%04X  (%s)'
                  % (pc, count, targets[pc][0], targets[pc][1], instruction(pc)[0]))

    data_reads = [(pc, addr) for pc, addr, value in memory.reads
                  if not pc-2 <= addr <= pc+3]
    if data_reads:
        print('\nctena data v $%04X-$%04X po spojitych usecich:'
              % (reads[0], reads[1]-1))
        counts = Counter(addr for pc, addr in data_reads)
        for lo, hi in ranges(set(counts)):
            total = sum(counts[a] for a in range(lo, hi+1))
            print('  $%04X-$%04X  %5d B  %6d cteni' % (lo, hi, hi-lo+1, total))
        print('\ninstrukce, ktere ta data ctou:')
        by_pc = Counter(pc for pc, addr in data_reads)
        for pc, count in by_pc.most_common(args.top):
            addresses = sorted({addr for p, addr in data_reads if p == pc})
            span = ('$%04X' % addresses[0] if len(addresses) == 1
                    else '$%04X-$%04X' % (addresses[0], addresses[-1]))
            print('  $%04X  %5dx  z %s  (%s)' % (pc, count, span, instruction(pc)[0]))

    if probed:
        print('\nregistry na sledovanych adresach:')
        for pc, values in probed[:args.top]:
            print('  $%04X  %s' % (pc, '  '.join('%s=%04X' % (k, v)
                                                 for k, v in values.items())))


if __name__ == '__main__':
    main()
