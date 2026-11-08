#!/usr/bin/env python3
"""Vytáhne z originálu **fyziku Sabremana** → `data/physics.json` (M3).

    PYTHONPATH=tools/vendor ./tools/dumpphysics.py [--png]

Nic tady není odhad ani „doladěno": každá konstanta se čte jako **operand
skutečné instrukce** v runtime obrazu hry (`build/underwurlde-run.bin`,
`tools/mkruntime.py`) a okolní bajty té instrukce se kontrolují. Když se
obraz neshoduje, nástroj spadne, místo aby vydal číslo.

Rutiny, ze kterých se čte (runtime adresy, `sources/docs/disasm_notes.md` §13):

* `$A433` chůze a stání (typy `$09–$10`), `$A5F1` příprava skoku (`$11–$14`),
  `$A6A6` skok (`$15–$16`), `$A925` pád a odmrštění (`$18–$1B`),
  `$A316` na lanu (`$01–$08`), `$AA4C` lano bez hráče (`$17`),
  `$E7D0`/`$E7E3` smrt a respawn (`$3E–$3F`)
* senzory: `$E1B4` plošiny, `$B43E` nábytek a překážky, `$E833` nepřítel
* kyvadlo lana: `$AAB0`, `$ABE5`, `$AB78`

`--png` k tomu uloží náhledový list póz (`build/gfx/sabreman-poses.png`),
aby šlo očima zkontrolovat, že typy odpovídají tomu, co se v běhu naměřilo.
"""
import argparse, base64, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

IMAGE = os.path.join(HERE, '..', 'build/underwurlde-run.bin')
OUT = os.path.join(HERE, '..', 'data/physics.json')
SPRITES = os.path.join(HERE, '..', 'data/spriteframes.json')

# ---------------------------------------------------------------------------
# Konstanty: (jméno, adresa, bajty instrukce s None na místě operandu, komentář)
# None se přečte, ostatní bajty se ověří. Víc None = víc bajtů operandu.
# ---------------------------------------------------------------------------
CONSTANTS = [
    # --- chůze ($A433) -----------------------------------------------------
    ('walkStep',        0xA55A, [0xDD, 0x36, 0x06, None],
     'LD (IX+$06),n — krok chůze vpravo v pixelech za herní krok'),
    ('walkStepLeft',    0xA57E, [0xDD, 0x36, 0x06, None],
     'LD (IX+$06),n — krok chůze vlevo (dvojkový doplněk)'),
    ('walkPoseLeft',    0xA58B, [0xC6, None],
     'ADD A,n — první typ ze čtyř póz chůze vlevo'),
    ('walkPoseRight',   0xA567, [0xC6, None],
     'ADD A,n — první typ ze čtyř póz chůze vpravo'),
    ('poseHold',        0xA564, [0x1F, 0xE6, None],
     'RRA/AND n — fáze chůze = (počítadlo>>1)&n, tedy dva snímky na pózu'),
    ('sideMaskHigh',    0xA44D, [0xDD, 0x36, 0x0B, None],
     'LD (IX+$0B),n — nad hranicí `topWallsY` platí boční stěny za uzavřené'),
    ('topWallsY',       0xA449, [0xFE, None],
     'CP n — nad touto řádkou se místnost do stran neopouští'),
    # --- příprava skoku ($A596, $A59A, $A5C3, $A5F1) -----------------------
    ('jumpVelocity',    0xA596, [0xDD, 0x36, 0x09, None],
     'LD (IX+$09),n — svislá rychlost skoku v 1/16 px za krok (znaménkově)'),
    ('crouchFrames',    0xA59A, [0xDD, 0x36, 0x0A, None],
     'LD (IX+$0A),n — kolik kroků trvá pokrčení před odskokem'),
    ('crouchPoseLeft',  0xA5A6, [0xC6, None],
     'ADD A,n — typ pokrčení (vlevo); +2 je vpravo, +1 druhá fáze'),
    ('crouchPoseStep',  0xA610, [0xFE, None],
     'CP n — při této hodnotě počítadla se pokrčení překreslí druhou fází'),
    ('stepOffVelocity', 0xA5C3, [0xDD, 0x36, 0x09, None],
     'LD (IX+$09),n — odskok, když se stojí nad prázdnem (místnost bez podlahy)'),
    ('jumpLiftoff',     0xA65C, [0xD6, None],
     'SUB n — o kolik px se Sabreman posune vzhůru v okamžiku odskoku'),
    ('jumpFrames',      0xA66E, [0xDD, 0x36, 0x0A, None],
     'LD (IX+$0A),n — kolik kroků po odskoku se nekontroluje chycení lana'),
    ('jumpPose',        0xA64C, [0xC6, None],
     'ADD A,n — typ pózy skoku (vlevo); +1 vpravo'),
    # --- gravitace a pád ---------------------------------------------------
    ('gravity',         0xA9F5, [0xDD, 0x7E, 0x09, 0xCB, 0x7F, 0x20, 0x04, 0xFE, None],
     'CP n — strop rychlosti pádu (1/16 px za krok) v rutině pádu'),
    ('gravityJump',     0xA785, [0xFE, None],
     'CP n — strop rychlosti během skoku, nižší než při volném pádu'),
    ('deathVelocity',   0xA8AD, [0xFE, None],
     'CP n — od této svislé rychlosti při dopadu Sabreman umírá'),
    ('fallPoseBase',    0xA9A4, [0xC6, None],
     'ADD A,n — první ze čtyř typů pádu (kotoul)'),
    ('fallPoseMask',    0xA9A1, [0x1F, 0xE6, None],
     'RRA/AND n — fáze kotoulu = (počítadlo hry>>1)&n'),
    ('floorY',          0xA79F, [0xFE, None],
     'CP n — pixelová řádka podlahy (spodní bod spritu)'),
    ('ceilingY',        0xA7B5, [0xFE, None],
     'CP n — pod touto řádkou už strop nebrání; nad ní se odráží'),
    ('ceilingClampY',   0xA7CC, [0x3E, None],
     'LD A,n — na tuhle řádku se hráč zaráží o uzavřený strop'),
    # --- meze místnosti a přechody ----------------------------------------
    ('wallLeftWalk',    0xA507, [0xDD, 0x36, 0x01, None],
     'LD (IX+$01),n — o levou stěnu se chůze zaráží tady'),
    ('wallRightWalk',   0xA531, [0xDD, 0x36, 0x01, None],
     'LD (IX+$01),n — o pravou stěnu se chůze zaráží tady'),
    ('wallRightJump',   0xA681, [0xDD, 0x36, 0x01, None],
     'LD (IX+$01),n — ve skoku je odraz od pravé stěny o 8 px dřív'),
    ('wallRightFall',   0xA900, [0xDD, 0x36, 0x01, None],
     'LD (IX+$01),n — v pádu ještě o 1 px dřív'),
    ('exitLeftX',       0xA50E, [0xFE, None],
     'CP n — pod tímhle x se přechází do místnosti vlevo'),
    ('enterRightX',     0xA513, [0xDD, 0x36, 0x01, None],
     'LD (IX+$01),n — na téhle x se vstupuje z pravé strany'),
    ('exitRightX',      0xA538, [0xFE, None],
     'CP n — nad tímhle x se přechází do místnosti vpravo (chůze)'),
    ('enterLeftX',      0xA53D, [0xDD, 0x36, 0x01, None],
     'LD (IX+$01),n — na téhle x se vstupuje z levé strany'),
    ('enterLeftXFall',  0xA9EB, [0xDD, 0x36, 0x01, None],
     'LD (IX+$01),n — v pádu se z levé strany vstupuje o 9 px dál'),
    ('exitTopY',        0xA7EE, [0xFE, None],
     'CP n — nad touhle řádkou se přechází do místnosti nahoře'),
    ('enterBottomY',    0xA7F5, [0xDD, 0x36, 0x03, None],
     'LD (IX+$03),n — na téhle řádce se vstupuje zespodu'),
    ('exitBottomY',     0xA86F, [0xFE, None],
     'CP n — pod touhle řádkou se přechází do místnosti dole'),
    ('enterTopYJump',   0xA877, [0xDD, 0x36, 0x03, None],
     'LD (IX+$03),n — na téhle řádce se vstupuje shora ve skoku'),
    ('enterTopYFall',   0xAA32, [0xDD, 0x36, 0x03, None],
     'LD (IX+$03),n — a tady v pádu'),
    # --- odmrštění a smrt --------------------------------------------------
    ('bounceFrames',    0xE894, [0xDD, 0x36, 0x0A, None],
     'LD (IX+$0A),n — tolik kroků po kontaktu s nepřítelem nemá hráč kontrolu'),
    ('bouncePose',      0xE89B, [0xDD, 0x36, 0x00, None],
     'LD (IX+$00),n — typ, do kterého odmrštění přepne (kotoul)'),
    ('standBounceVel',  0xA3FF, [0xDD, 0x36, 0x09, None],
     'LD (IX+$09),n — svislý impuls odmrštění, když stál na zemi'),
    ('landPose',        0xA8BD, [0xC6, None],
     'ADD A,n — typ pózy po dopadu (vlevo), +4 vpravo'),
    ('throwFrames',     0xE276, [0xDD, 0x36, 0x0A, None],
     'LD (IX+$0A),n — kolik kroků bez kontroly po odhození od překážky ($E272)'),
    ('throwVelocity',   0xE27A, [0xDD, 0x36, 0x09, None],
     'LD (IX+$09),n — svislý impuls při odhození od překážky'),
    ('deathPose',       0xE7D7, [0xC6, None],
     'ADD A,n — první typ animace smrti (druhý je +1)'),
    ('deathFrames',     0xE7DC, [0xDD, 0x36, 0x0A, None],
     'LD (IX+$0A),n — jak dlouho leží, než se ubere život'),
    ('enemyReachX',     0xE85B, [0xFE, None],
     'CP n — dosah nepřítele vodorovně'),
    ('enemyGraze',      0xE85E, [0xFE, None],
     'CP n — pod touhle vzdáleností je kontakt „naplno" (zabíjí ve stoje)'),
    ('enemyReachY',     0xE871, [0xFE, None],
     'CP n — dosah nepřítele svisle'),
    # --- senzor toho, na čem se dá stát ($E1B4): entity typu $58, což jsou
    #     podle tabulky spritů **vulkanické bubliny** -----------------------
    ('platformType',    0xE1C6, [0xE6, 0xFC, 0xFE, None],
     'AND $FC/CP n — typ entity, na které se dá stát (bublina)'),
    ('platformReachX',  0xE1E5, [0xFE, None],
     'CP n — vodorovný dosah plošiny'),
    ('platformEdgeX',   0xE1E9, [0xFE, None],
     'CP n — od téhle vzdálenosti se stojí na hraně plošiny'),
    ('platformReachY',  0xE1FD, [0xFE, None],
     'CP n — svislý dosah plošiny'),
    ('platformStandY',  0xE212, [0xD6, None],
     'SUB n — o kolik px nad plošinou Sabreman stojí'),
    ('platformSlots',   0xE1C3, [0x06, None],
     'LD B,n — kolik záznamů plošin se prohlíží'),
    ('platformBase',    0xE1BD, [0x21, None, None],
     'LD HL,nn — první záznam plošiny v tabulce entit'),
    ('platformIgnore',  0xE1B9, [0xE6, None],
     'AND n — dokud je počítadlo bez kontroly takhle vysoké, plošiny se ignorují'),
    # --- senzor překážek ($B43E) ------------------------------------------
    ('obstacleBaseCastle', 0xB448, [0xFD, 0x21, None, None],
     'LD IY,nn — první záznam překážky v hradu (řádky < 16)'),
    ('obstacleSlotsCastle', 0xB44C, [0x06, None],
     'LD B,n — kolik záznamů překážek se v hradu prohlíží'),
    ('obstacleBaseCave', 0xB450, [0xFD, 0x21, None, None],
     'LD IY,nn — první záznam překážky v jeskyni'),
    ('obstacleSlotsCave', 0xB454, [0x06, None],
     'LD B,n — kolik záznamů překážek se v jeskyni prohlíží'),
    # --- lano --------------------------------------------------------------
    ('ropeGrabRow',     0xA802, [0xFE, None],
     'CP n — lana jsou jen od tohohle řádku mřížky dolů (jeskyně)'),
    ('ropeGrabX',       0xA81B, [0xD6, None],
     'SUB n — lano visí na téhle x; chytá se do vzdálenosti `ropeGrabReach`'),
    ('ropeGrabReach',   0xA822, [0xFE, None],
     'CP n — jak blízko musí hráč být, aby lano chytil'),
    ('ropeLengthOffset', 0xA7D1, [0xD6, None],
     'SUB n — délka lana při chycení = y - n'),
    ('ropeAnchorX',     0xABDF, [0xC6, None],
     'ADD A,n — x konce lana = výchylka + n (střed místnosti)'),
    ('ropeTipOffsetY',  0xABD1, [0xC6, None],
     'ADD A,n — svislý posun konce lana proti kotvě'),
    ('ropeTipOffsetY2', 0xABD3, [0xC6, None],
     'ADD A,n — a druhá část téhož posunu (společná dlouhým lanům)'),
    ('ropeHandX',       0xA368, [0x11, None, None],
     'LD DE,nn — poloha hráče = konec lana minus tohle (x -$0C, y +8)'),
    ('ropeSwingAccel',  0xAC02, [0x34, 0x34, 0x34, 0x34],
     'INC (HL) 4x — o kolik se mění rychlost kyvu ke středu za krok'),
    ('ropeSwingScale',  0xAC22, [0x29, 0x29, 0x29, 0x29, 0x29],
     'ADD HL,HL 5x — rychlost kyvu se přičítá k výchylce v 1/32 px'),
    ('ropeSwingDamp',   0xABFE, [0xE6, None],
     'AND n — každý n-tý krok se zrychlení ke středu vynechá (tlumení)'),
    ('ropeAmplitude',   0xAC2D, [0x11, None, None],
     'LD DE,nn — mez výchylky = délka * nn / 256'),
    ('ropePumpStep',    0xAB6F, [0x34, 0x34],
     'INC (HL) 2x — o kolik hráč rozhoupá lano klávesou do strany'),
    ('ropePumpLimit',   0xAACD, [0xFE, None],
     'CP n — rozhoupávat se dá jen do výchylky min(délka>>3, n)'),
    ('ropeClimbStep',   0xAAF5, [0x23, 0x23],
     'INC HL 2x — o kolik se lano prodlouží klávesou dolů'),
    ('ropeMaxLength',   0xAA52, [0xFE, None],
     'CP n — na tuhle délku lano samo doroste (typ $17)'),
    ('ropeMinLength',   0xAB36, [0xFE, None],
     'CP n — kratší než tohle lano nejde vytáhnout'),
    ('ropeFreeDecay',   0xAA6B, [0x3C, 0x3C],
     'INC A 2x — výchylka lana bez hráče se každý krok o 2 vrací ke středu'),
    ('ropeReleasePose', 0xA3BC, [0x3E, None],
     'LD A,n — po puštění lana typ skoku (vlevo), +1 vpravo'),
    ('ropeReleaseFrames', 0xA3C9, [0xDD, 0x36, 0x0A, None],
     'LD (IX+$0A),n — tolik kroků po puštění lana se nechytá znovu'),
    ('ropeReleaseVel',  0xA3D6, [0xDD, 0x36, 0x09, None],
     'LD (IX+$09),n — svislá rychlost, když se pustí ze stojícího lana'),
    ('ropeKnockVel',    0xA32D, [0x06, None],
     'LD B,n — svislý impuls, když hráče na lanu něco trefí'),
    ('ropePose',        0xA393, [0x3C],
     'INC A — typ na lanu = ((x>>3)&3)+1, vpravo +4'),
    ('ropeLandPose',    0xA8CD, [0x3E, None],
     'LD A,n — typ po dosednutí z lana (vlevo), +4 vpravo'),
    ('ropeEntityType',  0xA8DA, [0x3E, None],
     'LD A,n — typ entity „lano bez hráče"'),
    # --- start a respawn ---------------------------------------------------
    ('spawnRecord',     0xAA3C, [None]*16,
     'předloha záznamu Sabremana (typ, x, sloupec, y, řádek, atribut, ...)'),
    ('livesAddress',    0xE7EC, [0x3A, None, None],
     'LD A,(nn) — bajt se zásobou životů (BCD)'),
    ('invincibleAddress', 0xE83B, [0x3A, None, None],
     'LD A,(nn) — bajt odpočtu nezranitelnosti po drahokamu'),
    ('invincibleTick',  0x948E, [0xE6, None],
     'AND n — odpočet nezranitelnosti ubývá každý n+1-tý krok ($948B)'),
]

# póz Sabremana: (jméno stavu, první typ, kolik typů, komentář)
POSE_GROUPS = [
    ('rope',      0x01, 8, 'na lanu, čtyři fáze podle x, druhá čtyřka je otočená'),
    ('walkLeft',  0x09, 4, 'chůze vlevo; typ $09 je i stání vlevo'),
    ('walkRight', 0x0D, 4, 'chůze vpravo; typ $0D je i stání vpravo'),
    ('crouch',    0x11, 4, 'pokrčení před odskokem ($11/$12 vlevo, $13/$14 vpravo)'),
    ('jump',      0x15, 2, 'skok ($15 vlevo, $16 vpravo)'),
    ('ropeIdle',  0x17, 1, 'lano bez hráče (entita, ne Sabreman)'),
    ('fall',      0x18, 4, 'pád a odmrštění – kotoul, fáze z počítadla hry'),
    ('death',     0x3E, 2, 'animace smrti'),
]


def load(path=IMAGE):
    ram = open(path, 'rb').read()
    if len(ram) != 49152:
        raise SystemExit('cekam 49152 B RAM ($4000-$FFFF), mam %d' % len(ram))
    return ram


def peek(ram, addr, count=1):
    return ram[addr-0x4000:addr-0x4000+count]


def extract(ram, name, addr, pattern, note):
    """Ověří instrukci na `addr` a vrátí přečtené operandy."""
    got = peek(ram, addr, len(pattern))
    operands = []
    for i, expected in enumerate(pattern):
        if expected is None:
            operands.append(got[i])
        elif got[i] != expected:
            raise SystemExit('%s: $%04X+%d ceka %02X, v obrazu je %02X (%s)'
                             % (name, addr, i, expected, got[i], note))
    if not operands:
        return None                      # jen kontrola vzoru (např. počet INC)
    if len(operands) == 2:
        return operands[0] | operands[1] << 8
    if len(operands) == 1:
        return operands[0]
    return list(operands)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--image', default=IMAGE)
    ap.add_argument('--out', default=OUT)
    ap.add_argument('--png', action='store_true', help='náhledový list póz')
    args = ap.parse_args()

    ram = load(args.image)
    values, notes = {}, {}
    checked = 0
    for name, addr, pattern, note in CONSTANTS:
        value = extract(ram, name, addr, pattern, note)
        checked += 1
        if value is None:
            continue
        values[name] = value
        notes[name] = {'address': '$%04X' % addr, 'note': note}

    # gravitace: dvojice INC (IX+$09) v obou rutinách – zrychlení za krok
    for addr in (0xA78E, 0xAA00):
        if peek(ram, addr, 6) != bytes([0xDD, 0x34, 0x09, 0xDD, 0x34, 0x09]):
            raise SystemExit('gravitace: $%04X neni INC (IX+$09) 2x' % addr)
    values['gravityPerStep'] = 2
    notes['gravityPerStep'] = {'address': '$A78E, $AA00',
                               'note': 'INC (IX+$09) 2x — zrychlení v 1/16 px za krok'}
    # dělení rychlosti na pixely: SRA A 4x
    for addr in (0xA794, 0xAA06):
        if peek(ram, addr, 8) != bytes([0xCB, 0x2F]*4):
            raise SystemExit('posun rychlosti: $%04X neni SRA A 4x' % addr)
    values['velocityShift'] = 4
    notes['velocityShift'] = {'address': '$A794, $AA06',
                              'note': 'SRA A 4x — svislý posun = rychlost>>4 (dolů zaokrouhleno)'}
    values['ropeSwingAccel'] = 4
    values['ropeSwingScale'] = 32
    values['ropePumpStep'] = 2
    values['ropeClimbStep'] = 2
    values['ropeFreeDecay'] = 2
    values['ropePoseBase'] = 1

    # póza -> sprite z tabulky $9332 (data/spriteframes.json z M2)
    sprites = json.load(open(SPRITES))
    by_type = {entry['type']: entry for entry in sprites['byType']}
    poses = []
    for name, first, count, note in POSE_GROUPS:
        frames = []
        for t in range(first, first+count):
            entry = by_type.get(t, {})
            frames.append({'type': t, 'frame': entry.get('frame'),
                           'address': entry.get('address')})
        poses.append({'state': name, 'firstType': first, 'types': count,
                      'note': note, 'frames': frames})

    out = {
        'note': ('M3: fyzika Sabremana vytazena z originalu (tools/dumpphysics.py). '
                 'Kazda hodnota je operand skutecne instrukce v build/underwurlde-run.bin, '
                 'adresa je v "source". Popis rutin: sources/docs/disasm_notes.md 13.'),
        'stepRate': ('jeden herni krok = jeden snimek ULA (50,08 Hz); pomale '
                     'pocitadlo $8ED6 tika jen pri plnem prubehu hlavni smycky'),
        'measured': {
            'slowCounterFrames': 2,
            'note': ('Odmereno na behu originalu (tools/tracephysics.py): pocitadlo '
                     '$8ED6, na kterem visi faze kotoulu, tlumeni kyvu lana a krok '
                     'entity lana, tika jednou za 1,6 az 3,2 snimku podle toho, co '
                     'hra kresli (vazeny prumer 2,2). V remaku je to kazdy druhy tik '
                     '- je to casovani Z80, ne pravidlo hry, a patri k porovnani v M7.'),
        },
        'values': values,
        'source': notes,
        'poses': poses,
    }
    with open(args.out, 'w') as f:
        json.dump(out, f, indent=1, sort_keys=False)
        f.write('\n')
    print('zkontrolovano instrukci: %d' % checked)
    print('konstant do %s: %d' % (os.path.relpath(args.out), len(values)))
    for key in ('walkStep', 'jumpVelocity', 'crouchFrames', 'jumpFrames', 'gravityPerStep',
                'gravityJump', 'gravity', 'deathVelocity', 'bounceFrames', 'floorY',
                'ceilingY', 'ropeMaxLength', 'ropeGrabReach'):
        print('  %-16s %s' % (key, hex(values[key]) if isinstance(values[key], int) else values[key]))

    if args.png:
        write_poses_png(sprites, poses)


def write_poses_png(sprites, poses):
    """Náhledový list póz – kontrola očima, že typy jsou ty pravé."""
    from scr2png import write_png
    frames = sprites['frames']
    cols = max(len(g['frames']) for g in poses)
    cell_w = max(f['width'] for f in frames)+4
    cell_h = max(f['height'] for f in frames)+4
    width, height = cols*cell_w, len(poses)*cell_h
    img = bytearray(width*height*3)
    for row, group in enumerate(poses):
        for col, item in enumerate(group['frames']):
            if item['frame'] is None:
                continue
            frame = frames[item['frame']]
            bitmap = base64.b64decode(frame['bitmap'])
            stride = frame['cols']
            for y in range(frame['height']):
                for x in range(frame['width']):
                    byte = bitmap[y*stride + (x >> 3)]
                    if byte >> (7-(x & 7)) & 1:
                        px = ((row*cell_h+2+y)*width + col*cell_w+2+x)*3
                        img[px:px+3] = b'\xff\xff\xff'
    path = os.path.join(HERE, '..', 'build/gfx/sabreman-poses.png')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    rows = [bytes(img[y*width*3:(y+1)*width*3]) for y in range(height)]
    write_png(path, rows, width)
    print('nahled poz: %s' % os.path.relpath(path))


if __name__ == '__main__':
    main()
