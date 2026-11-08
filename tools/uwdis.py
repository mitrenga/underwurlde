#!/usr/bin/env python3
"""Disassembluje rozsah runtime obrazu hry.

    PYTHONPATH=tools/vendor ./tools/uwdis.py 9DA0 9E20 [--image build/underwurlde-run.bin]

Vždycky nad **runtime** obrazem (`tools/mkruntime.py`) – kazetový obraz z
`mksnapshot.sh` je proti běžícímu kódu posunutý o jeden bajt a disassembly z něj
je rozsypaná (viz `sources/docs/disasm_notes.md` §9). Adresy se zadávají v hexa
bez `$`.

Je to jen tenká obálka nad disassemblerem SkoolKitu, aby šlo v jedné řádce
kouknout na rutinu, když trasování ukáže, že něco dělá zajímavou věc.
"""
import argparse, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'vendor'))

from skoolkit.disassembler import Disassembler                   # noqa: E402

IMAGE = os.path.join(HERE, '..', 'build/underwurlde-run.bin')


class Instruction:
    def __init__(self, address, operation, data):
        self.address, self.operation, self.bytes = address, operation, data


class Config:
    asm_hex, asm_lower = True, False
    defb_size, defm_size, defw_size = 8, 66, 1
    handle_rst, opcodes, wrap = False, '', False
    imaker = Instruction


def load(path=IMAGE):
    ram = open(path, 'rb').read()
    if len(ram) != 49152:
        raise SystemExit('cekam 49152 B RAM ($4000-$FFFF), mam %d' % len(ram))
    return [0]*16384 + list(ram)


def disassemble(start, end, memory=None):
    memory = memory or load()
    out = []
    for ins in Disassembler(memory, Config()).disassemble(start, end, 'n'):
        out.append('$%04X  %-20s ; %s' % (ins.address, ins.operation,
                                          ' '.join('%02X' % b for b in ins.bytes)))
    return out


def words(addr, count, memory=None):
    """Tabulka `count` dvoubajtových slov od `addr` – tabulky skoků a ukazatelů."""
    memory = memory or load()
    return [memory[addr+2*i] | memory[addr+2*i+1] << 8 for i in range(count)]


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('start')
    ap.add_argument('end', nargs='?')
    ap.add_argument('--image', default=IMAGE)
    ap.add_argument('--words', type=int, metavar='N',
                    help='misto instrukci vypsat N dvoubajtovych slov (tabulka skoku)')
    args = ap.parse_args()

    start = int(args.start, 16)
    memory = load(args.image)
    if args.words:
        for i, value in enumerate(words(start, args.words, memory)):
            print('%2d  $%04X -> $%04X' % (i, start+2*i, value))
        return
    end = int(args.end, 16) if args.end else start+0x40
    print('\n'.join(disassemble(start, end, memory)))


if __name__ == '__main__':
    main()
