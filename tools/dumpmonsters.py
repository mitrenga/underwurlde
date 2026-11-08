#!/usr/bin/env python3
"""Vytáhne z originálu **chování nepřátel, zbraní a strážců** → `data/monsters.json` (M5).

    PYTHONPATH=tools/vendor ./tools/dumpmonsters.py [--png] [--quiet]

M4 dohledal, **kde** entity ve světě jsou (`tools/dumpentities.py`). M5 dohledává,
**co tam dělají** – a je to pět samostatných mechanismů (runtime adresy,
`sources/docs/disasm_notes.md` §15):

1. **Létající nepřátelé** (`$B079`, typy `$30–$33` orli a `$40–$43` harpyje):
   zrychlují za Sabremanem po obou osách o `+2/16 px` za krok až do `$40`,
   odrážejí se od stěn a přecházejí mezi místnostmi. Když nejsou v jeho
   místnosti, letí k ní po mřížce (`$B2CF` vodorovně, `$B358` svisle).
   Varianta `$EE66` (typy `$34–$37`) místo míření k hráči **losuje** směr
   (`$EE9A`: `±$20` podle bitu 6 `FRAMES`).
2. **Chrliči** (`$B3D8`, typy `$44–$47`) jsou totéž, ale padají: svislá
   rychlost roste o 1 za krok do `$21`, vodorovná je pevných `$30`/`$D0`,
   a **do místnosti nad sebou nejdou** (typ se vynuluje).
3. **Zbraně** (`$E8D7`, typy `$68–$6B`): leží, dají se sebrat dotykem se
   stisknutou klávesou vzít/položit, nesou se **až tři** vedle sebe v panelu
   (`x = $88`, každá další `+$18`), a která se čtvrtým stiskem dostane za
   `$C8`, ta se pustí a spadne na zem. Typy nesených zbraní drží tři bajty
   `$8EEB–$8EED`, a `$B4D1` z nich střílí **tou první**.
4. **Projektily** (`$B4D1` je vyrobí, `$B57A`/`$B58C` je posouvá): tabulka
   `$B753` páruje zbraň s projektilem – `projektil = ($B753)[typ & 3]`.
5. **Strážci** (`$ECCA`, typy `$82`, `$84`, `$86`) padnou jen na projektil
   `≥ $6C` (`$ECF6`), a jen na ten svůj: `((projektil >> 1) − 1) & 3` se musí
   rovnat `(typ >> 1) & 3`. Po prvním zabitém se do `$8EF9` zapíše 1 a od té
   chvíle generátor pouští i orly.

A k tomu **bodování** (`$A045`): skóre je **tři bajty BCD** na `$8EF3–$8EF5`
(panel je kreslí rutinou `$9E32`) a přičítá se do něj z **jediných dvou míst**
v celém programu – `$DF4A` (zabitý nepřítel, `C = typ`, tedy `BCD(typ) − 1` do
spodního bajtu) a `$E78C` (sebraný předmět, `B = typ >> 1`, tedy do
prostředního bajtu). Žádná rutina, která by přičítala za procento navštívených
místností, v programu **není** – viz `--quiet` výpis a `disasm_notes.md` §15.6.

Nic z toho není odhad: každá konstanta se čte jako **operand skutečné
instrukce** a okolní bajty se kontrolují, jinak nástroj spadne – stejná
disciplína jako `tools/dumpphysics.py` a `tools/dumpentities.py`. Chování se
navíc porovnává s originálem v simulátoru (`tools/tracemonsters.py` nahraje,
co udělá originál, `tools/matchmonsters.js` proti tomu pustí `app/monsters.js`).

`--png` uloží náhledový list zbraní, projektilů a strážců
(`build/gfx/m5-types.png`).
"""
import argparse, base64, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

IMAGE = os.path.join(HERE, '..', 'build/underwurlde-run.bin')
OUT = os.path.join(HERE, '..', 'data/monsters.json')
SPRITES = os.path.join(HERE, '..', 'data/spriteframes.json')

from scr2png import write_png                                    # noqa: E402
from dumpentities import load, peek, word, extract               # noqa: E402

# ---------------------------------------------------------------------------
# Konstanty: (jméno, adresa, bajty instrukce s None na místě operandu, komentář)
# ---------------------------------------------------------------------------
CONSTANTS = [
    # --- generátor nepřátel ($AFDA) ---------------------------------------
    ('genPeriodMask',    0xAFE2, [0xE6, None],
     'AND n — generátor běží jednou za (n+1) průchodů hlavní smyčky'),
    ('genSlotBase',      0xAFE5, [0x21, None, None],
     'LD HL,nn — první ze čtyř slotů, do kterých nepřátelé přicházejí'),
    ('genSlotCount',     0xAFEB, [0x06, None],
     'LD B,n — kolik slotů generátor prohledává'),
    ('genEaglesFlag',    0xAFF9, [0x3A, None, None],
     'LD A,(nn) — dokud je nula, orli nelétají (nastaví ji první zabitý strážce)'),
    ('genEagleBit',      0xB002, [0xF6, None],
     'OR n — bit typu, který se vynutí, dokud orli nelétají'),
    ('genTypeMask',      0xB005, [0xE6, None],
     'AND n — z pomalého počítadla zbudou dva bity typu'),
    ('genTypeBase',      0xB007, [0xC6, None],
     'ADD A,n — a k nim se přičte základ typu létajícího nepřítele'),
    ('genSideXMask',     0xB018, [0xE6, None],
     'AND n — x nepřítele, který přichází ze sousední místnosti do strany'),
    ('genSideXBase',     0xB01A, [0xC6, None],
     'ADD A,n — a jeho posun'),
    ('genYMask',         0xB027, [0xE6, None],
     'AND n — y nepřítele z FRAMES'),
    ('genYBase',         0xB029, [0xC6, None],
     'ADD A,n — a jeho posun'),
    ('genAttrMask',      0xB032, [0x3A, None, None],
     'LD A,(nn) — atribut se losuje z FRAMES'),
    ('genAttrAnd',       0xB035, [0xE6, None],
     'AND n — dva bity atributu'),
    ('genAttrBase',      0xB037, [0xC6, None],
     'ADD A,n — a jeho základ'),
    ('genRightXMask',    0xB043, [0xE6, None],
     'AND n — x nepřítele, který přichází zprava'),
    ('genRightXBase',    0xB045, [0xC6, None],
     'ADD A,n — a jeho posun'),

    # --- létající nepřítel v místnosti hráče ($B079) -----------------------
    ('eagleTypeMask',    0xB099, [0xE6, None],
     'AND n — typ bez dvou bitů fáze'),
    ('eagleType',        0xB09B, [0xFE, None],
     'CP n — jen orel hráče zvedne'),
    ('grabXMax',         0xB0A8, [0xFE, None],
     'CP n — zvednout se dá jen uvnitř místnosti, ne u kraje'),
    ('grabXMin',         0xB0AC, [0xFE, None],
     'CP n — a totéž zleva'),
    ('grabYMax',         0xB0B3, [0xFE, None],
     'CP n — ani u podlahy'),
    ('grabYMin',         0xB0B7, [0xFE, None],
     'CP n — ani u stropu'),
    ('grabPlayerMin',    0xB0BE, [0xFE, None],
     'CP n — a Sabreman nesmí být na laně (typ pod tímhle)'),
    ('grabContactMask',  0xB0C6, [0xE6, None],
     'AND n — ze senzoru $E285 se berou tyhle bity'),
    ('grabContactValue', 0xB0C8, [0xFE, None],
     'CP n — a musí vyjít tohle'),
    ('carryingType',     0xB0CD, [0xDD, 0x36, 0x00, None],
     'LD (IX+0),n — orel, který nese hráče'),
    ('carriedFlag',      0xB0D1, [0x3E, None],
     'LD A,n — příznak, kterým se Sabremanovi řekne, že ho někdo nese'),
    ('phaseCounter',     0xB0E4, [0x3A, None, None],
     'LD A,(nn) — pomalé počítadlo, ze kterého jde animace křídel'),
    ('chaseAccel',       0xB10C, [0xC6, None],
     'ADD A,n — zrychlení směrem k hráči, 1/16 px za krok'),
    ('chaseSpeedCap',    0xB112, [0xFE, None],
     'CP n — a jeho strop'),
    ('chaseDecel',       0xB218, [0xD6, None],
     'SUB n — a totéž na druhou stranu'),
    ('chaseSpeedFloor',  0xB21F, [0xFE, None],
     'CP n — strop záporné rychlosti (dvojkový doplněk)'),
    ('flyXMax',          0xB1D2, [0xFE, None],
     'CP n — u pravé stěny se odrazí'),
    ('flyXClampRight',   0xB1E2, [0x3E, None],
     'LD A,n — a zůstane tady'),
    ('flyXMin',          0xB236, [0xFE, None],
     'CP n — u levé stěny se odrazí'),
    ('flyXClampLeft',    0xB246, [0x3E, None],
     'LD A,n — a zůstane tady'),
    ('flyEdgeLeft',      0xB24B, [0xFE, None],
     'CP n — pod tímhle přejde do místnosti vlevo'),
    ('flyEnterRight',    0xB252, [0xDD, 0x36, 0x01, None],
     'LD (IX+1),n — a objeví se u jejího pravého okraje'),
    ('flyEdgeRight',     0xB25E, [0xFE, None],
     'CP n — nad tímhle přejde do místnosti vpravo'),
    ('flyEnterLeft',     0xB265, [0xDD, 0x36, 0x01, None],
     'LD (IX+1),n — a objeví se u jejího levého okraje'),
    ('flyYMax',          0xB200, [0xFE, None],
     'CP n — podlaha místnosti'),
    ('flyYClampFloor',   0xB210, [0x3E, None],
     'LD A,n — a odraz od ní'),
    ('flyYMin',          0xB282, [0xFE, None],
     'CP n — strop místnosti'),
    ('flyYClampTop',     0xB292, [0x3E, None],
     'LD A,n — a odraz od něj'),
    ('flyEdgeTop',       0xB297, [0xFE, None],
     'CP n — pod tímhle přejde do místnosti nad'),
    ('flyEnterBottom',   0xB29E, [0xDD, 0x36, 0x03, None],
     'LD (IX+3),n — a objeví se u její podlahy'),
    ('flyEdgeBottom',    0xB2AA, [0xFE, None],
     'CP n — nad tímhle přejde do místnosti pod'),
    ('flyEnterTop',      0xB2B1, [0xDD, 0x36, 0x03, None],
     'LD (IX+3),n — a objeví se u jejího stropu'),
    ('sideMaskX',        0xB1BC, [0xE6, None],
     'AND n — před vodorovným krokem se maska stran ořízne'),
    ('sideMaskY',        0xB1EA, [0xE6, None],
     'AND n — a před svislým taky'),
    ('sideMaskSetX',     0xB275, [0xF6, None],
     'OR n — nepřítel u zavřené strany si ji poznamená'),
    ('sideMaskSetY',     0xB2C1, [0xF6, None],
     'OR n — a totéž svisle'),

    # --- nepřítel mimo místnost hráče ($B2CF vodorovně, $B358 svisle) ------
    ('approachAccel',    0xB2DD+3, [0xC6, None],
     'ADD A,n — zrychlení, když nepřítel míří k místnosti hráče'),
    ('approachCap',      0xB2E6, [0xFE, None],
     'CP n — a jeho strop'),
    ('approachXMax',     0xB2FB, [0xFE, None],
     'CP n — za tímhle přejde do místnosti vpravo'),
    ('approachEnterLeft', 0xB302, [0x3E, None],
     'LD A,n — a objeví se tady'),
    ('approachXMin',     0xB33D, [0xFE, None],
     'CP n — pod tímhle přejde do místnosti vlevo'),
    ('approachEnterRight', 0xB344, [0x3E, None],
     'LD A,n — a objeví se tady'),
    ('approachYMinRoom', 0xB30A, [0xFE, None],
     'CP n — v cizí místnosti se drží pod stropem'),
    ('approachYClampTop', 0xB30E, [0xDD, 0x36, 0x03, None],
     'LD (IX+3),n — a to je ten strop'),
    ('approachYSink',    0xB312, [0xFE, None],
     'CP n — a nad tímhle stoupá'),
    ('approachYStep',    0xB315, [0xD6, None],
     'SUB n — o tolik za krok'),
    ('approachYMax',     0xB384, [0xFE, None],
     'CP n — za tímhle přejde do místnosti pod'),
    ('approachEnterTop', 0xB38B, [0x3E, None],
     'LD A,n — a objeví se tady'),
    ('approachYMinV',    0xB3C6, [0xFE, None],
     'CP n — pod tímhle přejde do místnosti nad'),
    ('approachEnterBottom', 0xB3CD, [0x3E, None],
     'LD A,n — a objeví se tady'),
    ('approachXClampMin', 0xB393, [0xFE, None],
     'CP n — a vodorovně se drží v místnosti'),
    ('approachXClampLeft', 0xB397, [0xDD, 0x36, 0x01, None],
     'LD (IX+1),n — levý kraj'),
    ('approachXClampMax', 0xB39B, [0xFE, None],
     'CP n — a pravý'),
    ('approachXClampRight', 0xB39E, [0xDD, 0x36, 0x01, None],
     'LD (IX+1),n — pravý kraj'),
    ('wanderMask',       0xEE9D, [0xE6, None],
     'AND n — u typů $34-$37 se směr nelosuje k hráči, ale z FRAMES'),
    ('wanderOr',         0xEE9F, [0xF6, None],
     'OR n'),
    ('wanderSub',        0xEEA1, [0xD6, None],
     'SUB n — výsledek je ±$20'),

    # --- chrliči ($B3D8) ---------------------------------------------------
    ('gargoyleCap',      0xB404, [0xFE, None],
     'CP n — a jeho strop'),
    ('gargoyleSpeedRight', 0xB411, [0xDD, 0x36, 0x08, None],
     'LD (IX+8),n — vodorovná rychlost doprava je pevná'),
    ('gargoyleSpeedLeft', 0xB418, [0xDD, 0x36, 0x08, None],
     'LD (IX+8),n — a doleva taky'),
    ('phaseWrap',        0xB428, [0xFE, None],
     'CP n — animace má tolik kroků, pak se vynuluje'),
    ('phaseMask',        0xB431, [0xE6, None],
     'AND n — a z nich se udělají dva bity typu'),
    ('phaseTypeMask',    0xB437, [0xE6, None],
     'AND n — které se do typu vloží'),

    # --- výstřel ($B4D1) ---------------------------------------------------
    ('carriedSlots',     0xB4D7, [0x21, None, None],
     'LD HL,nn — tři bajty s typy nesených zbraní'),
    ('carriedCount',     0xB4DA, [0x06, None],
     'LD B,n — kolik se jich nese'),
    ('weaponTypeMask',   0xB4DD, [0xE6, None],
     'AND n — typ bez dvou bitů fáze'),
    ('weaponTypeBase',   0xB4DF, [0xFE, None],
     'CP n — a základ typu zbraně'),
    ('shotSlot0',        0xB4E8, [0x3A, None, None],
     'LD A,(nn) — první ze dvou slotů pro projektil'),
    ('shotSlot1',        0xB4EC, [0x3A, None, None],
     'LD A,(nn) — a druhý'),
    ('fireRateMask',     0xB4F9, [0xE6, None],
     'AND n — dokud nějaký projektil letí, střílí se jen jednou za (n+1)'),
    ('shotCopyBytes',    0xB50D, [0x01, None, None],
     'LD BC,nn — kolik bajtů se do projektilu opíše ze Sabremana'),
    ('shotSpeedMask',    0xB51D, [0xE6, None],
     'AND n — vodorovná rychlost projektilu se losuje'),
    ('shotSpeedOr',      0xB51F, [0xF6, None],
     'OR n — a má tohle za spodní hranici'),
    ('projectileTable',  0xB525, [0x11, None, None],
     'LD DE,nn — tabulka projektilů, index = typ zbraně & 3'),
    ('shotPoseLimit',    0xB533, [0xFE, None],
     'CP n — nad touhle pózou se od ní odečítá 2, jinak 1'),
    ('shotPoseHigh',     0xB4CD, [0xD6, None],
     'SUB n'),
    ('shotFacingMask',   0xB53C, [0xE6, None],
     'AND n — bit pózy, který drží směr'),
    ('shotXOffset',      0xB541, [0xC6, None],
     'ADD A,n — projektil vyletí o tolik vedle Sabremana'),
    ('shotYOffset',      0xB556, [0xD6, None],
     'SUB n — a o tolik výš'),
    ('shotVyMask',       0xB565, [0xE6, None],
     'AND n — svislá rychlost projektilu, z FRAMES posunutých o dva bity'),

    # --- projektil za letu ($B57A, $B58C) ----------------------------------
    ('shotPhaseMask',    0xB580, [0xE6, None],
     'AND n — animace projektilu z pomalého počítadla'),
    ('shotPhaseTypeMask', 0xB586, [0xE6, None],
     'AND n — a kam se v typu uloží'),
    ('shotBounceY',      0xB5B9, [0x3E, None],
     'LD A,n — po dopadu na nábytek se od něj odrazí (A - výška)'),
    ('shotGravity',      0xB5D4, [0xC6, None],
     'ADD A,n — projektil padá'),
    ('shotGravityCap',   0xB5DA, [0xFE, None],
     'CP n — a rychleji už ne'),
    ('shotXMax',         0xB60B, [0xFE, None],
     'CP n — u pravé stěny'),
    ('shotXClampRight',  0xB614, [0xDD, 0x36, 0x01, None],
     'LD (IX+1),n'),
    ('shotXMin',         0xB658, [0xFE, None],
     'CP n — u levé stěny'),
    ('shotXClampLeft',   0xB661, [0xDD, 0x36, 0x01, None],
     'LD (IX+1),n'),
    ('shotEdgeLeft',     0xB668, [0xFE, None],
     'CP n — pod tímhle projektil z místnosti vyletí a zmizí'),
    ('shotEdgeRight',    0xB676, [0xFE, None],
     'CP n — a totéž vpravo'),
    ('shotYMax',         0xB63D, [0xFE, None],
     'CP n — podlaha'),
    ('shotYClampFloor',  0xB650, [0x3E, None],
     'LD A,n'),
    ('shotYMin',         0xB695, [0xFE, None],
     'CP n — strop'),
    ('shotYClampTop',    0xB6A5, [0x3E, None],
     'LD A,n'),
    ('shotEdgeTop',      0xB6AA, [0xFE, None],
     'CP n — pod tímhle projektil zmizí nahoře'),
    ('shotEdgeBottom',   0xB6B8, [0xFE, None],
     'CP n — a tímhle dole'),
    ('splashSlot',       0xDEB8, [0x3A, None, None],
     'LD A,(nn) — slot, do kterého se ukládá cáknutí projektilu'),
    ('splashType',       0xDEC8, [0x3E, None],
     'LD A,n — a jeho typ'),
    ('splashPhase',      0xDECD, [0x3E, None],
     'LD A,n'),
    ('hitWallType',      0xDEDA, [0xDD, 0x36, 0x00, None],
     'LD (IX+0),n — projektil, který narazil do stěny'),
    ('hitWallSteps',     0xDEDE, [0xDD, 0x36, 0x08, None],
     'LD (IX+8),n — a jak dlouho je vidět'),
    ('puffPhaseMask',    0xDF06, [0xE6, None],
     'AND n — animace nárazu'),
    ('puffTypeMask',     0xDF0C, [0xE6, None],
     'AND n'),
    ('deathPhaseMask',   0xDF33, [0xE6, None],
     'AND n — animace zabitého nepřítele'),
    ('deathTypeMask',    0xDF39, [0xE6, None],
     'AND n'),
    ('deathType',        0xDF4D, [0xDD, 0x36, 0x00, None],
     'LD (IX+0),n — zabitý nepřítel se překlopí do výbuchu'),
    ('deathSteps',       0xDF51, [0xDD, 0x36, 0x08, None],
     'LD (IX+8),n — a ten trvá tolik kroků'),

    # --- zásah ($B6E8) ------------------------------------------------------
    ('hitSlot0',         0xB6E8, [0x21, None, None],
     'LD HL,nn — senzor zásahu prochází oba sloty projektilů'),
    ('hitSlot1',         0xB6F1, [0x21, None, None],
     'LD HL,nn'),
    ('hitOffset',        0xB6FF, [0xC6, None],
     'ADD A,n — vodorovný posun okna zásahu'),
    ('hitWindowX',       0xB706, [0xFE, None],
     'CP n — a jeho šířka'),
    ('hitOffsetY',       0xB714, [0xC6, None],
     'ADD A,n — svislý posun'),
    ('hitWindowY',       0xB71B, [0xFE, None],
     'CP n — a výška'),

    # --- zvednutí hráče ($B72C) a orel, který ho nese ($E2CB) --------------
    ('carriedPlayerType', 0xB738, [0xDD, 0x36, 0x00, None],
     'LD (IX+0),n — Sabreman v pařátech'),
    ('carryLatch',       0xE2F2, [0x32, None, None],
     'LD (nn),A — orel to hlásí každý průchod; když přestane, hráč spadne'),
    ('carryDrop',        0xE2F8, [0xC6, None],
     'ADD A,n — hráč visí o tolik pod orlem'),
    ('carryReleaseType', 0xE60B, [0xDD, 0x36, 0x00, None],
     'LD (IX+0),n — a když ho pustí, padá'),
    ('carryReleaseVy',   0xE60F, [0xDD, 0x36, 0x09, None],
     'LD (IX+9),n — s touhle rychlostí'),
    ('carryCap',         0xE33A, [0xFE, None],
     'CP n — a jeho strop'),
    ('carryTargetX',     0xB742, [0xE6, None],
     'AND n — po odrazu si orel vylosuje nový cíl'),
    ('carryTargetXBase', 0xB744, [0xC6, None],
     'ADD A,n'),
    ('carryTargetYMask', 0xB74B, [0xE6, None],
     'AND n'),
    ('carryTargetYBase', 0xB74D, [0xC6, None],
     'ADD A,n'),
    ('carryCapX',        0xE33A, [0xFE, None],
     'CP n — strop vodorovné rychlosti orla, který nese hráče'),
    ('carryFloorX',      0xE449, [0xFE, None],
     'CP n — a strop na druhou stranu (dvojkový doplněk)'),
    ('carryCapY',        0xE352, [0xFE, None],
     'CP n — a totéž svisle'),
    ('carryFloorY',      0xE457, [0xFE, None],
     'CP n'),
    ('carryXMax',        0xE3D4, [0xFE, None],
     'CP n — u pravé stěny se odrazí'),
    ('carryXClampRight', 0xE3E7, [0x3E, None],
     'LD A,n'),
    ('carryXMin',        0xE45F, [0xFE, None],
     'CP n — a u levé'),
    ('carryXClampLeft',  0xE472, [0x3E, None],
     'LD A,n'),
    ('carryEdgeLeft',    0xE477, [0xFE, None],
     'CP n — pod tímhle odnese hráče do místnosti vlevo'),
    ('carryEnterRight',  0xE4F9, [0x3E, None],
     'LD A,n — a objeví se u jejího pravého okraje'),
    ('carryEdgeRight',   0xE47E, [0xFE, None],
     'CP n — a nad tímhle doprava'),
    ('carryEnterLeft',   0xE511, [0x3E, None],
     'LD A,n'),
    ('carryYMax',        0xE405, [0xFE, None],
     'CP n — podlaha'),
    ('carryYClampFloor', 0xE418, [0x3E, None],
     'LD A,n'),
    ('carryYMin',        0xE496, [0xFE, None],
     'CP n — strop'),
    ('carryYClampTop',   0xE4AA, [0x3E, None],
     'LD A,n'),
    ('carryEdgeTop',     0xE4AF, [0xFE, None],
     'CP n — pod tímhle odnese hráče do místnosti nad'),
    ('carryEnterBottom', 0xE4CD, [0x3E, None],
     'LD A,n — orel se objeví tady'),
    ('carryPlayerBottom', 0xE4D2, [0x3E, None],
     'LD A,n — a hráč tady'),
    ('carryEdgeBottom',  0xE4B6, [0xFE, None],
     'CP n — a tímhle do místnosti pod'),
    ('carryEnterTop',    0xE4EA, [0x3E, None],
     'LD A,n'),
    ('carryPlayerTop',   0xE4EF, [0x3E, None],
     'LD A,n'),
    ('carryDropXMin',    0xE51F, [0xFE, None],
     'CP n — pustit hráče se dá jen uvnitř místnosti'),
    ('carryDropXMax',    0xE522, [0xFE, None],
     'CP n'),
    ('carryDropYMin',    0xE528, [0xFE, None],
     'CP n'),
    ('carryDropYMax',    0xE52B, [0xFE, None],
     'CP n'),
    ('carryEagleType',   0xE565, [0xDD, 0x36, 0x00, None],
     'LD (IX+0),n — orel, který hráče pustil, odlétá'),
    ('carryEagleVy',     0xE569, [0xDD, 0x36, 0x09, None],
     'LD (IX+9),n — vzhůru'),

    # --- zbraň ($E8D7) ------------------------------------------------------
    ('takeKeyState',     0xE900, [0x3A, None, None],
     'LD A,(nn) — stav klávesy vzít/položit ($FF stisk, $FE spotřebováno)'),
    ('carryX',           0xE910, [0xDD, 0x36, 0x01, None],
     'LD (IX+1),n — nesená zbraň se kreslí do panelu sem'),
    ('carryY',           0xE914, [0xDD, 0x36, 0x03, None],
     'LD (IX+3),n — a sem'),
    ('takeConsumed',     0xE91C, [0x3E, None],
     'LD A,n — a stisk se spotřebuje, aby ji nesebraly všechny najednou'),
    ('carryStep',        0xE937, [0xC6, None],
     'ADD A,n — každý další stisk zbraň posune o tohle doprava'),
    ('carryLimit',       0xE939, [0xFE, None],
     'CP n — a za tímhle spadne'),
    ('carrySlotMask',    0xE965, [0xE6, None],
     'AND n — pořadí nesené zbraně z jejího x'),
    ('carrySlotMax',     0xE967, [0xFE, None],
     'CP n — a víc než tři sloty nejsou'),
    ('dropFallStep',     0xE957, [0xDD, 0x36, 0x06, None],
     'LD (IX+6),n — puštěná zbraň začíná padat s tímhle'),
    ('dropMask',         0xE98A, [0xE6, None],
     'AND n — a zrychluje o (počítadlo >> 4)'),
    ('dropFloor',        0xE9AB, [0xFE, None],
     'CP n — podlaha místnosti'),
    ('dropFloorClamp',   0xE9B7, [0xDD, 0x36, 0x03, None],
     'LD (IX+3),n'),
    ('dropBelow',        0xE9C5, [0xFE, None],
     'CP n — pod otevřenou podlahou spadne do místnosti pod'),
    ('dropSettle',       0xE9D4, [0xDD, 0x36, 0x03, None],
     'LD (IX+3),n — a tam si sedne'),
    ('dropLandOffset',   0xE99C, [0xC6, None],
     'ADD A,n — a na nábytku takhle'),

    # --- strážci ($ECCA) ----------------------------------------------------
    ('guardianAnimMask', 0xECE2, [0xE6, None],
     'AND n — strážce se hýbe každý druhý tik pomalého počítadla'),
    ('guardianAnimBit',  0xECE9, [0xEE, None],
     'XOR n — a je to jediný bit typu'),
    ('guardianProjMin',  0xECF6, [0xFE, None],
     'CP n — kámen z katapultu strážci neublíží, jen projektil od tohohle typu'),
    ('guardianPairMask', 0xECFC, [0xE6, None],
     'AND n — párování: ((projektil >> 1) - 1) & n'),
    ('guardianTypeShift', 0xED03, [0xE6, None],
     'AND n — proti (typ >> 1) & n'),
    ('guardianTable',    0xED08, [0x21, None, None],
     'LD HL,nn — a zabitý strážce se odškrtne v tabulce ($EDF4 + 2)'),
    ('guardianKilledFlag', 0xED0E, [0x3E, None],
     'LD A,n — po prvním zabitém strážci'),
    ('guardianKilledAt', 0xED10, [0x32, None, None],
     'LD (nn),A — se tohle nastaví a od té chvíle létají orli'),
    ('guardianBounceFlag', 0xED21, [0xF6, None],
     'OR n — dotek se strážcem hráče odmrští'),
    ('guardianBounceDx',  0xED26, [0x3E, None],
     'LD A,n — a to hodně doleva'),

    # --- východ ($ED2E) -----------------------------------------------------
    ('exitX',            0xED34, [0xDD, 0x36, 0x01, None],
     'LD (IX+1),n — východ ze hry v místnosti strážce'),
    ('exitY',            0xED38, [0xDD, 0x36, 0x03, None],
     'LD (IX+3),n'),
    ('exitAttribute',    0xED3E, [0xDD, 0x36, 0x05, None],
     'LD (IX+5),n'),
    ('exitColumns',      0xED3C, [0x0E, None],
     'LD C,n — kreslí se ze čtyř sloupců'),
    ('exitStepX',        0xED4E, [0xC6, None],
     'ADD A,n — po tolika pixelech'),
    ('exitStepY',        0xED66, [0xC6, None],
     'ADD A,n — a řádky po tolika'),
    ('exitRowBase',      0xED5E, [0xC6, None],
     'ADD A,n — každá další řada výklenku začíná o kus dál doprava'),
    ('exitSensorY',      0xED91, [0xFE, None],
     'CP n — nad tímhle je východ průchozí'),

    # --- senzory, které M5 sdílí s fyzikou ($E285, $E1B4, $B43E) -----------
    ('contactAliveType', 0xE28A, [0xFE, None],
     'CP n — nad tímhle typem už Sabreman není naživu a senzor mlčí'),
    ('contactReachX',    0xE2A3, [0xFE, None],
     'CP n — jak blízko musí entita být vodorovně'),
    ('contactOffsetY',   0xE2AE, [0xD6, None],
     'SUB n — svisle se měří od tohohle posunu'),
    ('contactReachY',    0xE2BA, [0xFE, None],
     'CP n — a takhle blízko svisle'),
    ('platformIgnore',   0xE1B9, [0xE6, None],
     'AND n — kdo má tyhle bity v +$0A, na bublině nestojí'),
    ('platformBase',     0xE1BD, [0x21, None, None],
     'LD HL,nn — první ze čtyř slotů bublin'),
    ('platformSlots',    0xE1C3, [0x06, None],
     'LD B,n — kolik jich je'),
    ('platformType',     0xE1C8, [0xFE, None],
     'CP n — typ bubliny (po ořezu dvou bitů fáze)'),
    ('platformReachX',   0xE1E5, [0xFE, None],
     'CP n — dosah bubliny vodorovně'),
    ('platformEdgeX',    0xE1E9, [0xFE, None],
     'CP n — a od téhle vzdálenosti je to už jen okraj'),
    ('platformReachY',   0xE1FD, [0xFE, None],
     'CP n — a svisle'),
    ('platformStandY',   0xE212, [0xD6, None],
     'SUB n — kdo na ní stojí, stojí o tolik nad ní'),
    ('obstacleRows',     0xB444, [0xFE, None],
     'CP n — od tohohle řádku dolů jsou jeskyně a nábytek jsou jen dva sloty'),
    ('obstacleBaseCastle', 0xB448, [0xFD, 0x21, None, None],
     'LD IY,nn — první ze čtyř slotů nábytku hradu'),
    ('obstacleSlotsCastle', 0xB44C, [0x06, None],
     'LD B,n'),
    ('obstacleBaseCave', 0xB450, [0xFD, 0x21, None, None],
     'LD IY,nn — a jeskyně mají jen dva'),
    ('obstacleSlotsCave', 0xB454, [0x06, None],
     'LD B,n'),
    ('obstacleExitType', 0xB476, [0xFE, None],
     'CP n — východ má vlastní senzor ($ED8A), je to klín'),
    ('exitSensorSub',    0xED96, [0xD6, None],
     'SUB n — šířka klínu se počítá z výšky'),
    ('exitSensorAdd',    0xED9C, [0xC6, None],
     'ADD A,n'),
    ('exitSensorX',      0xED9F, [0x3E, None],
     'LD A,n — a měří se od středu místnosti'),
    ('carriedClampRight', 0xE5C9, [0xFE, None],
     'CP n — nesený Sabreman u pravé stěny'),
    ('carriedClampLeft', 0xE5CD, [0xFE, None],
     'CP n — a u levé'),
    ('carriedFloor',     0xE5EA, [0xFE, None],
     'CP n — a u podlahy'),
    ('carriedLandOffset', 0xE61A, [0xC6, None],
     'ADD A,n — a když ho něco zachytí, sedne si sem'),
    ('carriedPlantBit',  0xE57E, [0xDD, 0x36, 0x0A, None],
     'LD (IX+$0A),n — dotek jeskynního porostu za letu'),
    # --- skóre ($A045) ------------------------------------------------------
    ('scoreLow',         0xA045, [0x21, None, None],
     'LD HL,nn — spodní ze tří BCD bajtů skóre'),
    ('scoreDigits',      0xA060, [0x06, None],
     'LD B,n — kolik bajtů panel kreslí'),
    ('scorePanelAt',     0xA05A, [0x21, None, None],
     'LD HL,nn — a kam'),
    ('scoreBase',        0xA05D, [0x11, None, None],
     'LD DE,nn — nejvyšší bajt skóre'),
]

# instrukce, které se jen ověřují (nemají operand, ale kdyby se změnily,
# rozsypal by se přepis stejně jako u konstant)
VERIFY = [
    ('gargoyleAccel', 0xB3FF, [0x3C], 'INC A — chrlič zrychluje dolů po jedné'),
    ('carryAccel', 0xE335, [0x3C], 'INC A — orel s hráčem zrychluje po jedné'),
    ('scoreAddLow', 0xA04C, [0x86, 0x27], 'ADD A,(HL) / DAA — skóre je BCD'),
    ('scoreAddMid', 0xA051, [0x88, 0x27], 'ADC A,B / DAA — a přenos jde výš'),
    ('scoreAddHigh', 0xA056, [0xCE, 0x00, 0x27], 'ADC A,0 / DAA'),
    ('scoreBcdDec', 0xA04A, [0x3D, 0x27], 'DEC A / DAA — a hodnota za nepřítele'),
]

# tabulky, které se čtou celé
PROJECTILE_TABLE = 0xB753           # 4 B: projektil podle (typ zbraně & 3)

# adresy volání $A045 – jediná dvě místa v programu, kde skóre roste
SCORE_CALLS = [
    (0xDF4A, 'zabity nepritel: C = typ entity, B = 0'),
    (0xE78C, 'sebrany predmet: B = typ >> 1, C = 0'),
]

WEAPON_NAMES = {
    0x68: ('catapult', 'katapult'),
    0x69: ('bow', 'luk'),
    0x6A: ('torch', 'pochoden'),
    0x6B: ('sword', 'mec'),
}

PROJECTILE_NAMES = {
    0x38: ('stone', 'kamen'),
    0x6C: ('dagger', 'dyka'),
    0x6E: ('arrow', 'sip'),
    0x70: ('fireball', 'ohniva koule'),
}

GUARDIAN_NAMES = {
    0x82: ('beetle', 'brouk'),
    0x84: ('minotaur', 'rohaty strazce'),
    0x86: ('devil', 'dabel'),
    0x80: ('unreachable', 'nedosazitelny'),
}


def constants(ram):
    values, source = {}, {}
    for name, addr, pattern, note in CONSTANTS:
        operands = extract(ram, name, addr, pattern, note)
        if not operands:
            raise SystemExit('%s: instrukce na $%04X nema operand' % (name, addr))
        value = operands[0] if len(operands) == 1 else operands[0] | operands[1] << 8
        values[name] = value
        source[name] = {'address': '$%04X' % addr, 'note': note}
    for name, addr, pattern, note in VERIFY:
        extract(ram, name, addr, pattern, note)
        source[name] = {'address': '$%04X' % addr, 'note': note}
    return values, source


def projectiles(ram, table):
    """Tabulka `$B753`: který projektil která zbraň vystřelí.

    Index je `typ zbraně & 3`, takže zbraň `$68 + i` střílí `tabulka[i]`.
    Pár strážce↔zbraň z toho vyjde sám: strážce padne na projektil, pro který
    `((projektil >> 1) − 1) & 3 == (typ strážce >> 1) & 3` (`$ECFA`).
    """
    raw = list(peek(ram, table, 4))
    out = []
    for index, projectile in enumerate(raw):
        weapon = 0x68 + index
        out.append({
            'weapon': weapon,
            'weaponName': WEAPON_NAMES[weapon][0],
            'projectile': projectile,
            'projectileName': PROJECTILE_NAMES[projectile][0],
            'pair': ((projectile >> 1) - 1) & 3,
        })
    return raw, out


def guardian_pairs(ram, projectile_rows, guardian_min):
    """Ke každému strážci ta jediná zbraň, na kterou padne."""
    out = []
    for gtype in (0x80, 0x82, 0x84, 0x86):
        match = None
        for row in projectile_rows:
            if row['projectile'] < guardian_min:
                continue            # kámen z katapultu se do $ECF6 nedostane
            if row['pair'] == (gtype >> 1) & 3:
                match = row
        out.append({
            'guardian': gtype,
            'guardianName': GUARDIAN_NAMES[gtype][0],
            'weapon': match['weapon'] if match else None,
            'weaponName': match['weaponName'] if match else None,
            'projectile': match['projectile'] if match else None,
        })
    return out


def bcd_dec(value):
    """`DEC A / DAA` s nastaveným příznakem N – BCD odečtení jedničky."""
    low, high = value & 0x0F, value >> 4
    adjust = 0
    if low > 9:
        adjust += 0x06
    if high > 9:
        adjust += 0x60
    value = (value - 1 - adjust) & 0xFF
    if (value & 0x0F) > 9:
        value = (value - 6) & 0xFF
    return value


def score_table(ram, projectile_rows):
    """Co se za co dostane – dopočítané z `$A045` a jeho dvou volajících.

    `$DF4A` posílá `C = typ`, `$A045` z něj udělá `BCD(typ) − 1` a přičte to do
    **spodního** bajtu; `$E78C` posílá `B = typ >> 1` do **prostředního**, tedy
    stokrát víc. Žádná třetí cesta ke skóre v programu není.
    """
    kills, pickups = [], []
    for base, name in ((0x30, 'orel'), (0x34, 'orel (losujici)'),
                       (0x40, 'harpyje'), (0x44, 'chrlic'),
                       (0x5C, 'orel s hracem'),
                       (0x82, 'strazce (brouk)'), (0x84, 'strazce (rohaty)'),
                       (0x86, 'strazce (dabel)')):
        kills.append({'type': base, 'what': name, 'points': bcd_dec(base)})
    for base, name in ((0x64, 'drahokam'), (0x66, 'drahokam')):
        pickups.append({'type': base, 'what': name, 'points': (base >> 1)*100})
    return {
        'note': 'skore jsou tri BCD bajty; zabity nepritel prictе BCD(typ)-1 do '
                'spodniho, sebrany predmet (typ >> 1) do prostredniho',
        'kills': kills,
        'pickups': pickups,
    }


def type_sheet(path, groups, sprite_data, cell=56, scale=2):
    """Náhledový list typů M5 – zbraně, projektily, strážci, nepřátelé."""
    frames, by_type = sprite_data['frames'], sprite_data['byType']
    rows = len(groups)
    cols = max(len(types) for _, types in groups)
    width, height = cols*cell, rows*cell
    pixels = [[0]*width for _ in range(height)]
    for r, (_, types) in enumerate(groups):
        for c, t in enumerate(types):
            entry = by_type[t]
            if entry['frame'] is None:
                continue
            frame = frames[entry['frame']]
            bitmap = base64.b64decode(frame['bitmap'])
            x0 = c*cell + (cell - frame['width'])//2
            y0 = r*cell + (cell - min(frame['height'], cell))//2
            for y in range(min(frame['height'], cell)):
                for col in range(frame['cols']):
                    byte = bitmap[y*frame['cols'] + col]
                    for bit in range(8):
                        if byte >> (7-bit) & 1:
                            px, py = x0 + col*8 + bit, y0 + y
                            if 0 <= px < width and 0 <= py < height:
                                pixels[py][px] = 1
    rows = []
    for row in pixels:
        line = bytearray()
        for value in row:
            v = 255 if value else 24
            line += bytes((v, v, v))
        rows.append(bytes(line))
    write_png(path, rows, width, scale)
    return width*scale, height*scale


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

    raw_table, projectile_rows = projectiles(ram, k['projectileTable'])
    pairs = guardian_pairs(ram, projectile_rows, k['guardianProjMin'])

    out = {
        'note': 'M5: chovani nepratel, zbrani, projektilu a strazcu plus '
                'bodovani, vytazene z obrazu hry (tools/dumpmonsters.py). '
                'Kazda konstanta je operand skutecne instrukce.',
        'values': values,
        'source': source,
        'handlers': {
            '$B079': 'letajici nepritel v mistnosti hrace (typy $30-$33, $40-$43, $64-$67)',
            '$EE66': 'totez, ale smer se losuje (typy $34-$37)',
            '$B3D8': 'chrlic - pada a vodorovne ma pevnou rychlost (typy $44-$47)',
            '$B2CF': 'nepritel mimo mistnost hrace: vodorovne k ni',
            '$B358': 'a svisle',
            '$B57A': 'projektil za letu (typy $38-$3B), telo sdileji vsechny',
            '$EA9C': 'dyka a sip (typy $6C-$6F) - jen jina animace',
            '$EA7D': 'ohniva koule (typy $70-$71)',
            '$DEE8': 'naraz projektilu do steny (typy $48-$4B)',
            '$DF15': 'vybuch zabiteho nepritele (typy $4C-$4F)',
            '$E8D7': 'zbran: lezi, nese se, pada (typy $68-$6B)',
            '$E2CB': 'orel, ktery nese hrace (typy $5C-$5F)',
            '$E570': 'Sabreman v parátech (typy $60-$63)',
            '$ECCA': 'strazce (typy $80-$87)',
            '$ED2E': 'vychod ze hry, ktery se v mistnosti strazce objevi (typ $88)',
            '$A045': 'bodovani',
        },
        'weapons': {
            'note': 'ctyri zbrane, typ = $68 + i. Katapult je startovni a je '
                    've vsech ctyrech sadach na temz miste (M4, $E9FD).',
            'names': {('$%02X' % t): {'id': n[0], 'cs': n[1]}
                      for t, n in sorted(WEAPON_NAMES.items())},
            'carriedSlots': '$%04X' % k['carriedSlots'],
            'carriedMax': k['carriedCount'],
            'carryX': [k['carryX'] + k['carryStep']*i for i in range(k['carriedCount'])],
            'carryY': k['carryY'],
        },
        'projectiles': {
            'note': 'tabulka $B753: projektil = tabulka[typ zbrane & 3]. '
                    'Kamen z katapultu je jediny pod $6C, a proto jediny, '
                    'ktery zadneho strazce nezabije ($ECF6).',
            'table': '$%04X' % k['projectileTable'],
            'raw': ['$%02X' % b for b in raw_table],
            'rows': projectile_rows,
            'names': {('$%02X' % t): {'id': n[0], 'cs': n[1]}
                      for t, n in sorted(PROJECTILE_NAMES.items())},
        },
        'guardians': {
            'note': 'strazce padne jen na svuj projektil: '
                    '((projektil >> 1) - 1) & 3 == (typ >> 1) & 3 ($ECFA). '
                    'Prvni zabity nastavi $8EF9 a od te chvile letaji orli.',
            'pairs': pairs,
            'names': {('$%02X' % t): {'id': n[0], 'cs': n[1]}
                      for t, n in sorted(GUARDIAN_NAMES.items())},
        },
        'score': score_table(ram, projectile_rows),
        'scoreCalls': [{'address': '$%04X' % a, 'note': n} for a, n in SCORE_CALLS],
    }

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, 'w') as f:
        json.dump(out, f, indent=1, sort_keys=False)
        f.write('\n')

    if args.png:
        sprite_data = json.load(open(SPRITES))
        os.makedirs(args.png_dir, exist_ok=True)
        path = os.path.join(args.png_dir, 'm5-types.png')
        groups = [
            ('zbrane', [0x68, 0x69, 0x6A, 0x6B]),
            ('projektily', [0x38, 0x6C, 0x6E, 0x70]),
            ('strazci a vychod', [0x82, 0x84, 0x86, 0x88]),
            ('nepratele', [0x30, 0x34, 0x40, 0x44]),
        ]
        w, h = type_sheet(path, groups, sprite_data)
        if not args.quiet:
            print('%s: %d x %d' % (os.path.relpath(path, os.path.join(HERE, '..')), w, h))

    if args.quiet:
        return
    print('%s: %d B, %d konstant'
          % (os.path.relpath(args.out, os.path.join(HERE, '..')),
             os.path.getsize(args.out), len(values)))
    print('zbran -> projektil -> strazce:')
    for row in projectile_rows:
        pair = next((p for p in pairs if p['projectile'] == row['projectile']
                     and p['weapon'] is not None), None)
        print('  $%02X %-8s -> $%02X %-8s -> %s'
              % (row['weapon'], row['weaponName'], row['projectile'],
                 row['projectileName'],
                 ('$%02X %s' % (pair['guardian'], pair['guardianName']))
                 if pair else 'zadny strazce (pod $%02X)' % k['guardianProjMin']))
    print('skore: tri BCD bajty na $%04X, roste jen z $DF4A a $E78C'
          % k['scoreBase'])


if __name__ == '__main__':
    main()
