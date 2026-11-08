#!/usr/bin/env python3
"""Vytáhne z originálu **rozmístění entit po světě** → `data/entities.json` (M4).

    PYTHONPATH=tools/vendor ./tools/dumpentities.py [--png] [--quiet]

M2 zjistil, že v datech místnosti plošiny, lana ani výzdoba nejsou – jsou to
entity. M4 dohledal, **kdo je do místností rozdává**, a odpověď je čtyřdílná
(runtime adresy, `sources/docs/disasm_notes.md` §14):

1. **Hrad (řádky 0–15) má skutečnou tabulku**: `$6800–$6FFF`, `8 B na místnost`
   (`$6800 + 128*řádek + 8*sloupec`), tedy **4 entity po 2 bajtech** – typ a
   zabalená poloha (`x = (b & $F0) + 8`, `y = $3F + 8*(b & $0F)`). Rutina
   `$EAA2`. Tím se opravuje M2: `$6800–$6FFF` **není grafika jeskyní**
   (ta je v `$B81B–$CC88`, viz `tools/dumpgfx.py`).
2. **Jeskyně (řádky 16–51) tabulku nemají** – rutina `$AF56` je poskládá podle
   popisného bajtu a podle `sloupec + řádek`, a u místností s otevřenou podlahou
   si stav místnosti **vygeneruje při první návštěvě** (`$E6EE`, `$E714`) do
   druhé tabulky na `$6000` (2 B na místnost, stejná adresace jako `$7000`).
   Ten stav pak drží typ, x a y dvou entit – proto jsou jeskyně při každé hře
   trochu jiné, ale v rámci jedné hry se pamatují.
3. **Šestnáct extra životů a čtyři strážci mají tabulku souřadnic**
   (`$EDC4` po 3 B `sloupec, řádek, sebráno`, resp. `$EDF4`), rutina `$EC3A`.
4. **Zbraně** se vybírají z **čtyř hotových sad** po 32 B na `$E9FD`
   (rutina `$E8BE`, sada = `(FRAMES >> 1) & 3`) – katapult je ve všech čtyřech
   na témž místě, ostatní tři se stěhují. Tím je uzavřená otázka ZADANI §7.

K tomu procedurální generátory, které do tabulky entit přidávají za běhu:
**vulkanické bubliny** (`$E05F` z otevřené podlahy, `$E0A9` z jeskynní
rostliny typu `$54`), **padající krápníky** (`$DF58`) a **nepřátelé**
(`$AFDA`; ti jsou M5, tady se z nich bere jen rozmístění a spouštěč orlů).

Nic z toho není odhad: každá konstanta se čte jako **operand skutečné
instrukce** a okolní bajty se kontrolují, jinak nástroj spadne – stejná
disciplína jako `tools/dumpphysics.py`. Rozmístění se navíc porovnává
s originálem v simulátoru (`tools/traceentities.py` nahraje, co udělá
originál, `tools/matchentities.js` proti tomu pustí `app/worldEntities.js`).

`--png` uloží náhledový list typů entit (`build/gfx/entity-types.png`).
"""
import argparse, base64, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

IMAGE = os.path.join(HERE, '..', 'build/underwurlde-run.bin')
OUT = os.path.join(HERE, '..', 'data/entities.json')
SPRITES = os.path.join(HERE, '..', 'data/spriteframes.json')

from scr2png import write_png                                    # noqa: E402

GRID_COLS, CASTLE_ROWS, GRID_ROWS = 16, 16, 52

# ---------------------------------------------------------------------------
# Konstanty: (jméno, adresa, bajty instrukce s None na místě operandu, komentář)
# ---------------------------------------------------------------------------
CONSTANTS = [
    # --- tabulka entit a hlavní smyčka ($9207, $9459, $950C, $954C) --------
    ('recordsBase',      0x951D, [0xDD, 0x21, None, None],
     'LD IX,nn — první šestnáctibajtový záznam entity'),
    ('recordsStride',    0x9459, [0x11, None, None],
     'LD DE,nn — délka šestnáctibajtového záznamu'),
    ('recordsEnd',       0x9471, [0x11, None, None],
     'LD DE,nn — za tímhle záznamem šestnáctibajtová tabulka končí'),
    ('weaponRecordsBase', 0x950C, [0xDD, 0x21, None, None],
     'LD IX,nn — první osmibajtový záznam (zbraně)'),
    ('weaponRecordsStride', 0x954C, [0x11, None, None],
     'LD DE,nn — délka osmibajtového záznamu'),
    ('weaponRecordsEnd', 0x9554, [0x11, None, None],
     'LD DE,nn — za tímhle osmibajtová tabulka končí'),
    ('typeJumpTable',    0x920B, [0x01, None, None],
     'LD BC,nn — tabulka skoků podle typu entity'),
    ('redrawAllBase',    0x998F, [0x21, None, None],
     'LD HL,nn — vstup do místnosti nastaví všem záznamům příznak překreslení'),
    ('redrawAllCount',   0x9995, [0x01, None, None],
     'LD BC,nn — B = kolik záznamů, C = zapisovaná hodnota'),
    ('redrawWeaponsBase', 0x999D, [0x21, None, None],
     'LD HL,nn — a totéž pro čtyři zbraně (bit 0 bajtu +7)'),
    # --- nábytek hradu ($EAA2) --------------------------------------------
    ('castleTable',      0xEAB4, [0x11, None, None],
     'LD DE,nn — tabulka nábytku hradních místností, 8 B na místnost'),
    ('castleSlots',      0xEABB, [0xFD, 0x21, None, None],
     'LD IY,nn — kam se nábytek zapisuje (první ze čtyř záznamů)'),
    ('castleCount',      0xEAC2, [0x06, None],
     'LD B,n — kolik entit má hradní místnost'),
    ('castleXMask',      0xEACA, [0xE6, None],
     'AND n — vodorovná složka zabaleného bajtu'),
    ('castleXOffset',    0xEACC, [0xC6, None],
     'ADD A,n — a její posun (x = (b & maska) + n)'),
    ('castleYMask',      0xEAD5, [0xE6, None],
     'AND n — svislá složka (bajt se nejdřív třikrát rotuje vlevo)'),
    ('castleYOffset',    0xEAD7, [0xC6, None],
     'ADD A,n — a její posun (y = ((b<<3) & maska) + n)'),
    ('castleAttribute',  0xEAEC, [0xFD, 0x36, 0x05, None],
     'LD (IY+$05),n — barva nábytku'),
    # --- jeskyně: stav místnosti ($E6A5) a rozmístění ($AF56, $E6EE) ------
    ('caveStateTable',   0xE6B8, [0x01, None, None],
     'LD BC,nn — druhá tabulka po místnostech (stav, 2 B, adresace jako $7000)'),
    ('caveClosedMask',   0xAF7B, [0xE6, None],
     'AND n — bity stropu a podlahy, které se testují'),
    ('caveClosedValue',  0xAF7D, [0xFE, None],
     'CP n — když jsou oba uzavřené, jde se na tabulku výzdoby'),
    ('caveDecorXTable',  0xAF8E, [0x11, None, None],
     'LD DE,nn — 16 vodorovných poloh, index (sloupec+řádek) & $0F'),
    ('caveDecorType',    0xAFA1, [0x36, None],
     'LD (HL),n — typ výzdoby na podlaze uzavřené jeskyně'),
    ('caveDecorY',       0xAF9C, [0x36, None],
     'LD (HL),n — a její svislá poloha (podlaha)'),
    ('caveGrowthTable',  0xAFA9, [0x11, None, None],
     'LD DE,nn — čtyři předlohy porostu, index (sloupec<<4) & $30'),
    ('caveVentTable',    0xAFCE, [0x21, None, None],
     'LD HL,nn — dvě předlohy pro jeskyni s uzavřenou podlahou (typ $54)'),
    ('caveVentBytes',    0xAFD4, [0x01, None, None],
     'LD BC,nn — kolik bajtů se z ní kopíruje'),
    ('cavePlantTableA',  0xE6FA, [0x21, None, None],
     'LD HL,nn — ukazatele předloh podle prvního bajtu stavu místnosti'),
    ('cavePlantTableB',  0xE70B, [0x21, None, None],
     'LD HL,nn — a podle druhého bajtu'),
    ('cavePlantXA',      0xE6F8, [0x0E, None],
     'LD C,n — vodorovný základ entity z prvního bajtu'),
    ('cavePlantXB',      0xE709, [0x0E, None],
     'LD C,n — a z druhého'),
    ('cavePlantIndexMask', 0xE6F6, [0xE6, None],
     'AND n — bity stavu, které vybírají předlohu'),
    ('cavePlantXMask',   0xE6D1, [0xE6, None],
     'AND n — bity stavu, které dávají vodorovný posun'),
    ('cavePlantYMask',   0xE6DE, [0xE6, None],
     'AND n — a (po dvou rotacích vpravo) svislý posun'),
    ('cavePlantYOffset', 0xE6E0, [0xC6, None],
     'ADD A,n — svislý základ jeskynní rostliny'),
    ('cavePlantAttribute', 0xE6E9, [0x36, None],
     'LD (HL),n — barva jeskynní rostliny'),
    ('caveStateSeed',    0xE717, [0xF6, None],
     'OR n — první bajt stavu se odvozuje z pomalého počítadla'),
    ('caveStateBitA',    0xE71E, [0xE6, None],
     'AND n — a zahodí se, když v počítadle chybí bit 2'),
    ('caveStateOrA',     0xE724, [0xF6, None],
     'OR n — u otevřené levé stěny se přidají tyhle bity'),
    ('caveStateSeedB',   0xE72A, [0xE6, None],
     'AND n — druhý bajt vychází z FRAMES'),
    ('caveStateOrB1',    0xE732, [0xF6, None],
     'OR n — bity druhého bajtu, když v FRAMES chybí bit 2'),
    ('caveStateOrB2',    0xE738, [0xF6, None],
     'OR n — a bity pro otevřenou pravou stěnu'),
    ('caveStateAndB',    0xE73A, [0xE6, None],
     'AND n — které se zas zamaskují'),
    ('caveStateDefault', 0x9942, [0x36, None],
     'LD (HL),n — do prázdného stavu místnosti se při vstupu zapíše tohle'),
    # --- extra životy a strážci ($EC3A) -----------------------------------
    ('placeTableLives',  0xEC3A, [0x21, None, None],
     'LD HL,nn — tabulka souřadnic extra životů (3 B: sloupec, řádek, sebráno)'),
    ('placeCountLives',  0xEC45, [0x06, None],
     'LD B,n — kolik jich je'),
    ('placeTableGuardians', 0xEC54, [0x21, None, None],
     'LD HL,nn — totéž pro strážce'),
    ('placeCountGuardians', 0xEC57, [0x06, None],
     'LD B,n — kolik záznamů se prochází'),
    ('placeTemplate',    0xEC6E, [0x21, None, None],
     'LD HL,nn — předloha záznamu, který se do místnosti vloží'),
    ('placeSlot',        0xEC71, [0x11, None, None],
     'LD DE,nn — a slot, do kterého se vloží'),
    ('heightTable',      0xEC9E, [0x21, None, None],
     'LD HL,nn — výšky nábytku (extra život leží na jeho horní hraně)'),
    ('lifeXOffset',      0xEC92, [0xC6, None],
     'ADD A,n — extra život stojí o tolik px vpravo od entity, na které leží'),
    ('guardianTypeMask', 0xEC00, [0xE6, None],
     'AND n — bity indexu, které vybírají strážce'),
    ('guardianTypeBase', 0xEC02, [0xC6, None],
     'ADD A,n — první typ strážce'),
    ('guardianX',        0xEC0D, [0xFD, 0x36, 0x01, None],
     'LD (IY+$01),n — strážce stojí uprostřed místnosti'),
    ('guardianY',        0xEC11, [0xFD, 0x36, 0x03, None],
     'LD (IY+$03),n — na podlaze'),
    ('guardianAttribute', 0xEC15, [0xFD, 0x36, 0x05, None],
     'LD (IY+$05),n — barva strážce'),
    ('guardianRoomType', 0xEC2F, [0x3E, None],
     'LD A,n — typ, který se v místnosti strážce objeví navíc (východ)'),
    ('guardianRoomSlot', 0xEC31, [0x32, None, None],
     'LD (nn),A — a slot, do kterého se zapíše'),
    ('guardianKilledFlag', 0xED10, [0x32, None, None],
     'LD (nn),A — po zabití strážce se sem zapíše 1 (od té chvíle létají orli)'),
    # --- zbraně ($E8BE) ---------------------------------------------------
    ('weaponSets',       0xE8C1, [0x21, None, None],
     'LD HL,nn — čtyři hotové sady poloh zbraní'),
    ('weaponSetMask',    0xE8CB, [0xE6, None],
     'AND n — sada = FRAMES posunuté o 4 bity a maskované (tedy (FRAMES>>1)&3)'),
    ('weaponSetBytes',   0xE8D1, [0x01, None, None],
     'LD BC,nn — kolik bajtů se z ní kopíruje'),
    ('weaponSetTarget',  0xE8BE, [0x11, None, None],
     'LD DE,nn — kam (osmibajtové záznamy)'),
    # --- vulkanické bubliny ($E05F, $E0A9, $E0E8) -------------------------
    ('bubbleAliveType',  0xE062, [0xFE, None],
     'CP n — bubliny se generují, jen dokud je hráč naživu'),
    ('bubbleRow',        0xE068, [0xFE, None],
     'CP n — a jen v jeskyních od tohohle řádku mřížky'),
    ('bubbleSlots',      0xE06B, [0x21, None, None],
     'LD HL,nn — první ze slotů na bubliny'),
    ('bubbleSlotCount',  0xE071, [0x06, None],
     'LD B,n — kolik jich je'),
    ('bubbleChance',     0xE083, [0xE6, None],
     'AND n — bublina vznikne, jen když (FRAMES + $1A) & n == 0'),
    ('bubbleType',       0xE08D, [0x3E, None],
     'LD A,n — typ bubliny'),
    ('bubbleXMask',      0xE090, [0x3A, 0xD6, 0x8E, 0xE6, None],
     'AND n — bublina z podlahy vzniká na jedné ze dvou x podle počítadla'),
    ('bubbleXOffset',    0xE095, [0xC6, None],
     'ADD A,n — a jejich základ'),
    ('bubbleStartY',     0xE09B, [0x36, None],
     'LD (HL),n — startuje pod podlahou'),
    ('bubbleAttribute',  0xE09F, [0x36, None],
     'LD (HL),n — barva bubliny'),
    ('bubbleVentXOffset', 0xE0D1, [0xC6, None],
     'ADD A,n — bublina z rostliny typu $54 vzniká o tolik px vpravo'),
    ('bubbleRise',       0xE0F5, [0xD6, None],
     'SUB n — o kolik px bublina za krok stoupá'),
    ('bubblePopY',       0xE100, [0xFE, None],
     'CP n — pod uzavřeným stropem tady praskne'),
    ('bubbleCarryY',     0xE106, [0xFE, None],
     'CP n — jinak tady přejde do místnosti nad'),
    ('bubbleWrapY',      0xE109, [0xDD, 0x36, 0x03, None],
     'LD (IX+$03),n — a objeví se tady'),
    # --- padající krápník ($DF58) -----------------------------------------
    ('dripRow',          0xDF5B, [0xFE, None],
     'CP n — krápníky padají jen v jeskyních'),
    ('dripCeilingMask',  0xDF61, [0xE6, None],
     'AND n — a jen pod uzavřeným stropem'),
    ('dripChance',       0xDF71, [0xE6, None],
     'AND n — kadence (FRAMES | pomalé počítadlo) & n == 0'),
    ('dripSlot',         0xDF77, [0x11, None, None],
     'LD DE,nn — slot, do kterého se krápník vloží'),
    ('dripType',         0xDF81, [0x36, None],
     'LD (HL),n — typ krápníku'),
    ('dripStartY',       0xDF86, [0x36, None],
     'LD (HL),n — vzniká u stropu'),
    ('dripAttribute',    0xDF8A, [0x36, None],
     'LD (HL),n — jeho barva'),
    ('dripVelocity',     0xDF90, [0x36, None],
     'LD (HL),n — a svislá rychlost v 1/16 px za krok'),
    # --- nepřátelé ($AFDA) – rozmístění je M4, chování M5 -----------------
    ('monsterChance',    0xAFE2, [0xE6, None],
     'AND n — kadence generátoru nepřátel'),
    ('monsterSlots',     0xAFE5, [0x21, None, None],
     'LD HL,nn — první ze slotů na nepřátele'),
    ('monsterSlotCount', 0xAFEB, [0x06, None],
     'LD B,n — kolik jich je'),
    ('monsterEaglesBit', 0xB002, [0xF6, None],
     'OR n — dokud nepadl strážce, tenhle bit typu je vynucený (orli nelétají)'),
    ('monsterTypeMask',  0xB005, [0xE6, None],
     'AND n — bity počítadla, které vybírají druh nepřítele'),
    ('monsterTypeBase',  0xB007, [0xC6, None],
     'ADD A,n — a první typ'),
    ('monsterAttrMask',  0xB035, [0xE6, None],
     'AND n — barva nepřítele z FRAMES'),
    ('monsterAttrBase',  0xB037, [0xC6, None],
     'ADD A,n — a její základ'),
    # --- drahokam a nezranitelnost ($E751, $948B) -------------------------
    ('gemCountdown',     0xE794, [0x3E, None],
     'LD A,n — sebraný drahokam nastaví odpočet nezranitelnosti (BCD)'),
    ('gemPanelAddress',  0xE796, [0x32, None, None],
     'LD (nn),A — bajt, který panel ukazuje jako GEMS – je to týž odpočet'),
    ('gemPlayerAttribute', 0xE78F, [0x3E, None],
     'LD A,n — po dobu nezranitelnosti má Sabreman tuhle barvu'),
    ('gemPlayerAttrRestore', 0x94A4, [0x3E, None],
     'LD A,n — a po vypršení se vrátí tahle'),
    ('gemTick',          0x948E, [0xE6, None],
     'AND n — odpočet ubývá každý n+1-tý tik pomalého počítadla'),
    ('gemRoomBit',       0xE7A6, [0xCB, None],
     'RES b,(HL) — sebraný drahokam se odškrtne v bajtu stavu místnosti'),
    ('extraLifeType',    0xE781, [0xFE, None],
     'CP n — tenhle typ je extra život, ne drahokam'),
    ('plantGemMask',     0xE649, [0xE6, None],
     'AND n — z jeskynní rostliny vypadne jeden ze čtyř typů drahokamu'),
    ('plantGemBase',     0xE64B, [0xC6, None],
     'ADD A,n — a jeho první typ'),
    ('plantGemAttribute', 0xE658, [0x36, None],
     'LD (HL),n — barva drahokamu'),
    ('plantGemSlotOffset', 0xE634, [0x21, None, None],
     'LD HL,nn — drahokam se založí o tolik bajtů dál v tabulce entit'),
    # --- životy -----------------------------------------------------------
    ('livesStart',       0x9074, [None],
     'zásoba životů při startu hry (panel ukazuje 6, pokusů je 7)'),
    ('livesAddress',     0xE7EC, [0x3A, None, None],
     'LD A,(nn) — bajt se zásobou životů (BCD)'),
    # --- pauza ($94A9) ----------------------------------------------------
    ('pauseHalfRow',     0x94A9, [0x3E, None],
     'LD A,n — půlřádek klávesnice, na kterém hra hledá ENTER (pauza)'),
    ('pauseKeyMask',     0x94AF, [0xE6, None],
     'AND n — a bit té klávesy; pauza je smyčka s DI, dokud se nezmáčkne znovu'),
]

# ---------------------------------------------------------------------------
# Typy entit: skupiny podle tabulky skoků $921A. `name` je to, co se o skupině
# ví z rutin a ze spritu; kde to jistota není, je v `note` otazník.
# ---------------------------------------------------------------------------
TYPE_GROUPS = [
    (0x00, 0x00, 'free',            'prázdný slot ($9454 jen vrátí)'),
    (0x01, 0x08, 'playerRope',      'Sabreman na lanu (M3)'),
    (0x09, 0x10, 'playerWalk',      'Sabreman stojí a chodí (M3)'),
    (0x11, 0x14, 'playerCrouch',    'Sabreman pokrčený před odskokem (M3)'),
    (0x15, 0x16, 'playerJump',      'Sabreman ve skoku (M3)'),
    (0x17, 0x17, 'rope',            'lano bez hráče, vlastní entita (M3)'),
    (0x18, 0x1B, 'playerTumble',    'Sabreman v kotoulu – pád a odmrštění (M3)'),
    (0x1C, 0x2B, 'caveDecor',       'jeskynní porost na podlaze; při doteku hodí '
                                    'hráče do kotoulu (bit 7 příznaků, $AEF0) – '
                                    'to jsou ty „jedovaté rostliny", a nezabíjejí'),
    (0x2C, 0x2F, 'caveGrowth',      'porost uprostřed uzavřené jeskyně (jen se kreslí, '
                                    'překážkou je přes hitbox v záznamu)'),
    (0x30, 0x33, 'eagle',           'orel – létá až po prvním zabitém strážci ($8EF9); M5'),
    (0x34, 0x37, 'eagleCarry',      'orel s hráčem? ($EE66) – M5'),
    (0x38, 0x3B, 'projectile',      'projektil ($B57A) – M5'),
    (0x3C, 0x3D, 'cavePlantLow',    'jeskynní rostlina, ze které vypadne drahokam ($E622)'),
    (0x3E, 0x3F, 'playerDeath',     'animace smrti (M3)'),
    (0x40, 0x43, 'harpy',           'nepřítel z generátoru $AFDA; M5'),
    (0x44, 0x47, 'gargoyle',        'nepřítel z generátoru $AFDA ($B3D8); M5'),
    (0x48, 0x4B, 'spark',           '($DEE8) – M5'),
    (0x4C, 0x4F, 'burst',           '($DF15) – M5'),
    (0x50, 0x50, 'drip',            'padající krápník ($DF98), generátor $DF58'),
    (0x51, 0x53, 'dripSplash',      'krápník po dopadu ($E027)'),
    (0x54, 0x54, 'vent',            'jeskynní rostlina, která vypouští bubliny ($E0A9)'),
    (0x55, 0x57, 'cavePlantHigh',   'jeskynní rostlina, ze které vypadne drahokam ($E622)'),
    (0x58, 0x5B, 'bubble',          'vulkanická bublina – jediné, na čem se dá kromě '
                                    'podlahy stát ($E117, senzor $E1B4)'),
    (0x5C, 0x5F, 'bubblePop',       'bublina po prasknutí ($E2CB)'),
    (0x60, 0x63, 'carried',         'to, co hráče nese ($E570) – M5'),
    (0x64, 0x67, 'gem',             'drahokam: spustí odpočet nezranitelnosti ($E751)'),
    (0x68, 0x6B, 'weapon',          'zbraň ležící ve světě ($E8D7)'),
    (0x6C, 0x6F, 'weaponHeld1',     'nesená zbraň ($EA9C) – M5'),
    (0x70, 0x71, 'weaponHeld2',     'nesená zbraň ($EA7D) – M5'),
    (0x72, 0x73, 'weaponHeld3',     'nesená zbraň ($E18C) – M5'),
    (0x74, 0x78, 'furnitureA',      'nábytek hradu z tabulky $6800 ($EAF9)'),
    (0x79, 0x7E, 'furnitureB',      'nábytek hradu z tabulky $6800 ($EB39)'),
    (0x7F, 0x7F, 'extraLife',       'extra život z tabulky $EDC4 ($E751)'),
    (0x80, 0x87, 'guardian',        'strážce východu z tabulky $EDF4 ($ECCA)'),
    (0x88, 0x88, 'exit',            'entita, která se objeví v místnosti strážce ($ED2E)'),
    (0x89, 0x89, 'system89',        '($A0AC) bez spritu'),
    (0x8A, 0x8A, 'system8A',        '($A0C5) bez spritu'),
    (0x8B, 0x8B, 'system8B',        '($A107) bez spritu'),
    (0x8C, 0x8C, 'weaponIcon1',     'velký obrázek zbraně (kreslí ho $95A3)'),
    (0x8D, 0x8D, 'weaponIcon2',     'velký obrázek zbraně'),
    (0x8E, 0x8E, 'weaponIcon3',     'velký obrázek zbraně'),
    (0x8F, 0x8F, 'weaponIcon4',     'velký obrázek zbraně'),
    (0x90, 0x90, 'system90',        '($C529, stejná obsluha jako $8E)'),
]

# hitboxy nábytku: 5 B na typ od $74 (rutina $EB18) a výška pro $ECB0
HITBOX_TABLE, HITBOX_FIRST, HITBOX_COUNT = 0xEB7E, 0x74, 11
HEIGHT_TABLE = 0xEBB5

# ostatní tabulky, které se vypisují celé
CAVE_TEMPLATES = {'growth': (0xB76B, 4, 16), 'vent': (0xB7AB, 2, 16),
                  'plantA': (0xE741, 4, 2), 'plantB': (0xE749, 4, 2)}


def load(path=IMAGE):
    ram = open(path, 'rb').read()
    if len(ram) != 49152:
        raise SystemExit('cekam 49152 B RAM ($4000-$FFFF), mam %d' % len(ram))
    return ram


def peek(ram, addr, count=1):
    return ram[addr-0x4000:addr-0x4000+count]


def word(ram, addr):
    lo, hi = peek(ram, addr, 2)
    return lo | hi << 8


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
    return operands


def constants(ram):
    """Hodnoty a jejich zdroj – stejné rozdělení jako v `data/physics.json`."""
    values, source = {}, {}
    for name, addr, pattern, note in CONSTANTS:
        operands = extract(ram, name, addr, pattern, note)
        value = operands[0] if len(operands) == 1 else operands[0] | operands[1] << 8
        if len(operands) > 2:
            value = list(operands)
        values[name] = value
        source[name] = {'address': '$%04X' % addr, 'note': note}
    return values, source


def castle_rooms(ram, table):
    """Nábytek všech 256 hradních místností z tabulky $6800.

    Vrací (řádky tabulky jako hexa řetězce, kolik místností má nábytek,
    kolik je entit celkem). Tabulka se ukládá **surová** – 8 B na místnost,
    4 entity po 2 bajtech – a remake ji dekóduje stejným vzorcem jako
    rutina `$EAA2`; je to o dva řády menší než rozepsaný seznam.
    """
    rows, rooms, count = [], 0, 0
    for row in range(CASTLE_ROWS):
        line = peek(ram, table + 128*row, 128)
        rows.append(''.join('%02X' % b for b in line))
        for col in range(GRID_COLS):
            entities = sum(1 for i in range(4) if line[8*col + 2*i])
            count += entities
            rooms += 1 if entities else 0
    return rows, rooms, count


def places(ram, table, count, stride=3):
    return [{'col': peek(ram, table+stride*i, 1)[0],
             'row': peek(ram, table+stride*i+1, 1)[0],
             'index': count-i}
            for i in range(count)]


def weapon_sets(ram, base, count=4, size=0x20):
    sets = []
    for variant in range(count):
        records = []
        for i in range(size//8):
            r = peek(ram, base + size*variant + 8*i, 8)
            records.append({'type': r[0], 'x': r[1], 'col': r[2],
                            'y': r[3], 'row': r[4], 'attr': r[5],
                            'record': list(r)})
        sets.append(records)
    return sets


def type_table(ram, jump_table):
    """Pro každý typ entity obsluha, skupina a rám spritu."""
    sprites = {}
    if os.path.exists(SPRITES):
        data = json.load(open(SPRITES))
        sprites = {e['type']: e['frame'] for e in data['byType']}
    groups = []
    for first, last, name, note in TYPE_GROUPS:
        groups.append({'from': first, 'to': last, 'name': name, 'note': note,
                       'handler': '$%04X' % word(ram, jump_table + 2*first),
                       'frames': [sprites.get(t) for t in range(first, last+1)]})
    # kontrola, že skupiny odpovídají skutečným hranicím tabulky skoků
    for group in groups:
        handlers = {word(ram, jump_table + 2*t)
                    for t in range(group['from'], group['to']+1)}
        if len(handlers) != 1:
            raise SystemExit('typy $%02X-$%02X nemaji jednu obsluhu: %s'
                             % (group['from'], group['to'],
                                ' '.join('$%04X' % h for h in sorted(handlers))))
    return groups


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--image', default=IMAGE)
    ap.add_argument('--out', default=OUT)
    ap.add_argument('--png', action='store_true', help='náhled typů do build/gfx/')
    ap.add_argument('--png-dir', default=os.path.join(HERE, '..', 'build/gfx'))
    ap.add_argument('--quiet', action='store_true')
    args = ap.parse_args()

    ram = load(args.image)
    values, source = constants(ram)
    k = values

    castle_table, castle_rooms_count, castle_count = castle_rooms(ram, k['castleTable'])
    lives = places(ram, k['placeTableLives'], k['placeCountLives'])
    guardians = places(ram, k['placeTableGuardians'], k['placeCountGuardians'])
    # ze strážců jsou platné jen ty, které leží v mřížce – zbytek tabulky
    # zasahuje do kódu a nikdy se neshodne (žádná místnost takové souřadnice nemá)
    for guard in guardians:
        guard['valid'] = (guard['col'] < GRID_COLS and guard['row'] < GRID_ROWS
                          and word(ram, 0x7000 + 32*guard['row']
                                   + 2*guard['col']) != 0)
        if guard['valid']:
            index = guard['index']
            guard['type'] = ((index << 1) & k['guardianTypeMask']) + k['guardianTypeBase']
            guard['weapon'] = (guard['type'] >> 1) & 0x03

    entities = {
        'note': 'M4: rozmisteni entit po svete, vytazene z obrazu hry '
                '(tools/dumpentities.py). Kazda konstanta je operand skutecne '
                'instrukce; nabytek hradu je skutecna tabulka $6800, jeskyne '
                'se skladaji proceduralne a stav si pamatuji v tabulce $6000.',
        'grid': {'cols': GRID_COLS, 'castleRows': CASTLE_ROWS, 'rows': GRID_ROWS},
        'values': values,
        'source': source,
        'recordLayout': {
            '0': 'typ (a zaroven index do tabulky spritu $9332)',
            '1': 'x – levy okraj spritu',
            '2': 'sloupec mistnosti',
            '3': 'y – spodni pixelova radka spritu',
            '4': 'radek mistnosti',
            '5': 'atribut (barva)',
            '6': 'dx / poradove cislo / faze, podle typu',
            '8': 'pocitadlo fazi',
            '9': 'svisla rychlost v 1/16 px za krok',
            '10': 'pocitadlo (a u nabytku prvni bajt hitboxu)',
            '11': 'maska uzavrenych stran mistnosti',
            '14': 'vysledek senzoru',
            '15': 'priznaky: bit 0 prekreslit, bit 7 dotek jeskynniho porostu',
        },
        'types': type_table(ram, k['typeJumpTable']),
        'castle': {
            'note': 'skutecna tabulka: 8 B na hradni mistnost, 4 entity po 2 B '
                    '(typ, zabalena poloha). Rutina $EAA2.',
            'table': '$%04X' % k['castleTable'],
            'stride': 128, 'perRoom': k['castleCount'],
            'x': '(b & $%02X) + $%02X' % (k['castleXMask'], k['castleXOffset']),
            'y': '((b << 3) & $%02X) + $%02X' % (k['castleYMask'], k['castleYOffset']),
            'attribute': k['castleAttribute'],
            'slots': '$%04X' % k['castleSlots'],
            'entityCount': castle_count,
            'roomsWithFurniture': castle_rooms_count,
            'table_note': 'radky tabulky $6800 v hexa, 16 radku po 128 B '
                          '(16 mistnosti x 8 B); entita i = (typ, zabalena '
                          'poloha) na bajtech 8*sloupec+2*i',
            'packed': castle_table,
        },
        'caves': {
            'note': 'jeskyne tabulku nemaji: $AF56 poskládá místnost z popisného '
                    'bajtu a z (sloupec+radek), a u otevrene podlahy si stav '
                    'mistnosti vygeneruje pri prvni navsteve ($E714) do tabulky '
                    'na $6000. Proto jsou jeskyne kazdou hru jine.',
            'stateTable': '$%04X' % k['caveStateTable'],
            'decorXTable': ['$%02X' % b for b in
                            peek(ram, k['caveDecorXTable'], 17)],
            'templates': {name: [{'address': '$%04X' % (base + stride*i),
                                  'record': list(peek(ram, base + stride*i, 16))
                                  if stride == 16 else None,
                                  'pointer': None if stride == 16
                                  else '$%04X' % word(ram, base + stride*i)}
                                 for i in range(count)]
                          for name, (base, count, stride) in CAVE_TEMPLATES.items()},
            'pointedTemplates': {'$%04X' % addr: list(peek(ram, addr, 16))
                                 for addr in sorted({word(ram, base + 2*i)
                                                     for base, count, stride
                                                     in (CAVE_TEMPLATES['plantA'],
                                                         CAVE_TEMPLATES['plantB'])
                                                     for i in range(count)})},
        },
        'extraLives': {
            'note': 'sestnact extra zivotu; lezi na entite, ktera v te mistnosti '
                    'uz je (x + %d, y - vyska). Sebrani prida zivot a odskrtne '
                    'se v tabulce.' % k['lifeXOffset'],
            'table': '$%04X' % k['placeTableLives'],
            'template': list(peek(ram, k['placeTemplate'], 16)),
            'places': lives,
        },
        'guardians': {
            'note': 'ctyri zaznamy, ale platne jsou tri: ctvrty miri na (0,32), '
                    'kde zadna mistnost neni, takze se strazce $80 nikdy '
                    'neobjevi - tri strazci, tri vychody. Kazdy padne na jednu '
                    'zbran (parovani je '
                    '(typ>>1)&3 proti nesene zbrani v $ECFA). Po prvnim zabitem '
                    'strazci se do $%04X zapise 1 a zacnou letat orli.'
                    % k['guardianKilledFlag'],
            'table': '$%04X' % k['placeTableGuardians'],
            'places': guardians,
            'roomEntity': k['guardianRoomType'],
        },
        'weapons': {
            'note': 'ctyri hotove sady po 32 B; sada = (FRAMES >> 1) & 3. '
                    'Katapult ($68) je ve vsech ctyrech na temz miste, ostatni '
                    'tri se stehuji – presne jak psaly dobove tipy.',
            'sets': '$%04X' % k['weaponSets'],
            'target': '$%04X' % k['weaponSetTarget'],
            'select': '(FRAMES >> 1) & 3',
            'variants': weapon_sets(ram, k['weaponSets']),
        },
        'hitboxes': {'$%02X' % (HITBOX_FIRST+i):
                     list(peek(ram, HITBOX_TABLE + 5*i, 5))
                     for i in range(HITBOX_COUNT)},
        'heights': {'$%02X' % (HITBOX_FIRST+i):
                    peek(ram, HEIGHT_TABLE + i, 1)[0]
                    for i in range(HITBOX_COUNT)},
    }

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, 'w') as f:
        json.dump(entities, f, indent=1)
        f.write('\n')

    if args.png:
        os.makedirs(args.png_dir, exist_ok=True)
        type_sheet(os.path.join(args.png_dir, 'entity-types.png'),
                   entities['types'])

    if not args.quiet:
        print('typu entit: %d ve %d skupinach'
              % (sum(g['to']-g['from']+1 for g in entities['types']),
                 len(entities['types'])))
        print('hrad: %d mistnosti s nabytkem, %d entit (tabulka $%04X, 8 B na mistnost)'
              % (castle_rooms_count, castle_count, k['castleTable']))
        print('extra zivotu: %d, strazcu: %d z %d zaznamu tabulky'
              % (len(lives), sum(1 for g in guardians if g['valid']), len(guardians)))
        for guard in guardians:
            if guard['valid']:
                print('  strazce typ $%02X na (%d,%d), zbran %d'
                      % (guard['type'], guard['col'], guard['row'], guard['weapon']))
        moved = [i for i in range(4)
                 if len({tuple(v[i]['record'][1:5])
                         for v in entities['weapons']['variants']}) > 1]
        print('zbrane: 4 sady; stehuji se typy %s, na miste zustava %s'
              % (', '.join('$%02X' % (0x68+i) for i in moved) or 'zadne',
                 ', '.join('$%02X' % (0x68+i) for i in range(4) if i not in moved)))
        print('%s: %d B' % (os.path.relpath(args.out, os.path.join(HERE, '..')),
                            os.path.getsize(args.out)))


def type_sheet(path, groups, cell=48, scale=2, cols=8):
    """Náhled: první sprite každé skupiny typů, aby šlo očima ověřit pojmenování."""
    if not os.path.exists(SPRITES):
        return
    frames = json.load(open(SPRITES))['frames']
    rows = (len(groups)+cols-1)//cols
    image = [bytearray(b'\x00'*(cols*cell*3)) for _ in range(rows*cell)]
    for i, group in enumerate(groups):
        index = group['frames'][0]
        if index is None:
            continue
        frame = frames[index]
        pixels = base64.b64decode(frame['bitmap'])
        gx, gy = (i % cols)*cell, (i//cols)*cell
        for line in range(min(frame['lines'], cell-2)):
            for byte in range(min(frame['cols'], (cell-2)//8)):
                value = pixels[line*frame['cols']+byte]
                for bit in range(8):
                    if value >> (7-bit) & 1:
                        at = (gx+byte*8+bit)*3
                        image[gy+line][at:at+3] = b'\xff\xff\xff'
    zoomed = []
    for row in image:
        wide = bytearray()
        for x in range(cols*cell):
            wide += row[x*3:x*3+3]*scale
        zoomed += [bytes(wide)]*scale
    write_png(path, zoomed, cols*cell*scale)
    print('nahled: %s (%d x %d)' % (path, cols*cell*scale, len(zoomed)))


if __name__ == '__main__':
    main()
