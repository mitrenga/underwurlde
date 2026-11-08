# Protokol mezi `roomModel.js` a `gameWorker.js`

Worker drží herní stav a tiká na **50,08 Hz** – snímkové frekvenci originálu
(3,5 MHz / 69 888 T-stavů na snímek, herní logika visí na přerušení z ULA,
viz `sources/docs/hw_notes.md` a ZADANI §1). Model do něj jen posílá vstupy
a kreslí to, co dostane zpátky.

Stav M5: worker už **není atrapa**. Fyzika je přepis rutin originálu
v `app/sabremanPhysics.js` s konstantami z `data/physics.json`
(`tools/dumpphysics.py` je čte jako operandy skutečných instrukcí) a
`tools/matchphysics.js` ji krok po kroku porovnává s nahranými běhy originálu –
1355 kroků, nula rozdílů (viz `sources/docs/disasm_notes.md` §13). Worker sám drží
jen stav **kolem** fyziky: tabulku místností, záznamy entit, globály lana,
životy a panel.

Co v místnostech stojí, drží `app/worldEntities.js` (M4) – přepis
rozmisťovacích rutin originálu podle `data/entities.json`
(`tools/dumpentities.py`). `tools/matchentities.js` ho porovnává s originálem
pro **všech 598 místností** (1651 kontrol, nula rozdílů) a
`tools/matchtransitions.js` projede **všech 1222 přechodů** – oba nula rozdílů
(`disasm_notes.md` §14).

**Co to tam dělá**, drží `app/monsters.js` (M5): pohybové vzory nepřátel,
zbraně a jejich projektily, strážci, východ a bodování, s konstantami
z `data/monsters.json` (`tools/dumpmonsters.py`). Visí na témž objektu jako
`worldEntities.js` – v prohlížeči se přidá `importScripts`, v node
`require('app/monsters.js')(WorldEntities)`. `tools/matchmonsters.js` ho
porovnává s nahranými kroky originálu: **6960 kroků, 49 typů entit, nula
rozdílů** (`disasm_notes.md` §15).

**Souřadnice jsou souřadnice stroje.** `x` je levý okraj spritu (0–255),
`y` je jeho **spodní** pixelová řádka v souřadnicích obrazovky (podlaha
místnosti je `$9F` = 159, panel zabírá prvních 16 řádek). Renderer si z toho
levý horní roh dopočítá podle výšky pózy – tím se nic nezaokrouhluje a stav se
dá porovnávat se záznamem entity v originálu bajt po bajtu.

## Model → worker

| zpráva | pole | význam |
|---|---|---|
| `init` | `initData: {headless, lives, physics, world, entities, scene}` | start nové hry. `headless: true` tiká jen na vyžádání zprávou `tick` (pro testy). |
| `controls` | `left`, `right`, `up`, `down`, `fire`, `drop`, `take` (boolean) | úplný stav ovládání; posílá se při každé změně. `drop` = pustit lano (v originálu CAPS/Z/X/C/V), `take` = vzít/položit zbraň (B/N/M/SYMBOL SHIFT/SPACE, půlřádek `$7F`, čte se na `$94E2`). Nový stisk `take` si worker **zapamatuje** (`input.takeLatched`) a pustí ho dál na tom průchodu, na kterém se krokují entity, i když klávesa už je zpátky nahoře – jinak by se krátký stisk mezi dvěma průchody ztratil (originál si půlřádek čte sám, remake se o něm dozví jen ze zprávy). |
| `pause` | – | zastaví tikání. |
| `continue` | – | pokračuje. |
| `tick` | – | jeden krok v režimu `headless`. |
| `reset` | – | zahodí stav (volá se při opuštění herní obrazovky). |

### `initData`

| klíč | obsah |
|---|---|
| `lives` | zásoba životů. Pozor: hra končí, až když počítadlo jde **pod nulu**, takže při šesti je pokusů sedm (`disasm_notes.md` §13.5). |
| `physics` | celý `data/physics.json` – konstanty a tabulka póz. Bez něj worker odpoví `error`. |
| `world` | `{descriptors}` z `data/world.json`: popisné bajty všech 598 místností (bity 0/2/4/6 = uzavřené strany). Z nich fyzika ví, kde jsou stěny, strop a podlaha. |
| `monsters` | celý `data/monsters.json`: pohybové vzory, zbraně, projektily, strážci a bodování (M5). Bez něj se entity rozmístí, ale nehýbou se a `score` zůstává na nule – tak jedou scény sandboxu. |
| `entities` | celý `data/entities.json`: tabulka nábytku hradu, pravidla a předlohy jeskyní, extra životy, strážci, sady zbraní a parametry generátorů. Bez něj worker běží dál, ale svět je prázdný – tak jedou scény sandboxu v `tools/runworker.js`, které mají zkoušet fyziku, ne obsah místností. |
| `scene` | kde hra začíná a co v místnosti je: `{col, row, x, y, variant, roomState, entities}`. `roomState` je druhý bajt záznamu místnosti (**stav**, ne data – bit 3 znamená „visí tu lano"), `entities` jsou záznamy entit ve formátu originálu (`{address, record: [...]}`). |

## Worker → model

| zpráva | pole | význam |
|---|---|---|
| `frame` | `frame`, `score`, `gems`, `depth`, `lives`, `carrying`, `dying`, `sabreman`, `entities`, `rope`, `sounds`, `state` | jeden odtikaný krok. |
| `gameOver` | `score` | došly životy; model přepne na `GameOverModel`. |
| `error` | `message` | chybí data (např. `data/physics.json`). |

### `sabreman`

`{x, y, type, state, dir, col, row, vy, dx}` – `type` je **typ entity
originálu**, tedy zároveň index do tabulky spritů (`data/spriteframes.json`),
`state` je jeho pojmenování (`walkLeft`, `walkRight`, `crouch`, `jump`, `fall`,
`rope`, `death`) a `col`/`row` je místnost v mřížce 16 × 52. `vy` je svislá
rychlost v 1/16 px za krok – renderer ji nepotřebuje, testy a ladění ano.

### `entities` a `rope`

`entities` je seznam `{type, x, y, attr}` entit **v téže místnosti** – od M4
všechno, co v ní podle originálu je: nábytek hradu, jeskynní rostliny,
vulkanické bubliny, padající krápníky, drahokamy, extra životy, zbraně
a strážci. Kreslí se stejným blitterem jako Sabreman, protože sprite berou
z téže tabulky a barvu ze svého záznamu. Lano v seznamu **není** (entita typu
`$17` sprite nemá) – kreslí se z pole `rope`.

`rope` je `{visible, anchorX, anchorY, tipX, tipY}` – lano se kreslí jako
úsečka od kotvy ke konci, jak to dělá originál (`$AD02`).

Od M5 v `entities` přibyl i **východ** (typ `$88`): originál ho kreslí jako
klín 4 + 3 + 2 + 1 spritů (`$ED2E`) a jeho obsluha se vůbec nedívá, ve které
místnosti je, takže se posílá rozepsaný na jednotlivé sprity a bez kontroly
místnosti (`worldEntities.visible()`).

### `carrying`

Tři typy zbraní, které Sabreman zrovna nese (`$8EEB–$8EED`, nula = prázdno).
Kreslí se **do panelu** na `x = $88`, `$A0`, `$B8` a `y = $0F`, protože přesně
tam je kreslí originál (`$E910`, `$E937`) – panel je zároveň inventář, a to je
i odpověď na starou otázku, co je ta ikona vedle `DEPTH` na dobovém snímku.

`sounds` je seznam jmen efektů, které v tom kroku vznikly (`step`, `jump`,
`land`, `bump`, `fall`, `shoot`, `death`, a od M4 `gem` a `life`) – **kdy** se
hraje, ví M3 z rutin `$A07D`/`$A087`/`$A0E4`/`$EBC0`, a M5 přidal `kill`,
`hit`, `splash` a `guardian`; **jak to zní** je M6.

### `gems` a `lives` jsou BCD

Obojí je v originálu **BCD** a panel z toho kreslí dvě číslice
(`$9E32`, `ScreenComposer.bcd2`). A pozor na `gems`: **není to počet nasbíraných
drahokamů, ale odpočet nezranitelnosti**, který drahokam nastaví na `$50`
(`$8EEE`, `disasm_notes.md` §14.7). Dokud běží, je vypnutý senzor kontaktu
s nepřítelem a Sabreman má atribut `$45`.

## Co v M5 ještě chybí

Nic z herních pravidel: nepřátelé, zbraně, projektily, strážci, východ i
bodování jsou zportované a ověřené, a `$B72C` (uchopení orlem) s ním. Zbývá
vrstva, která je celá M6 a M7:

- **Zvuk** (M6): `sounds` je pořád jen seznam jmen. **Kdy** se co hraje, ví M3
  a M5; **jak to zní** je přepis rutin `$A068`/`$A107`/`$A131`/`$A173` do
  Web Audio.
- **Barva** (M6): entity dostávají atribut ze svého záznamu, jak to dělá
  originál, ale nábytek je na snímku z běhu vícebarevný – to je věc blitteru,
  ne rozmístění (`disasm_notes.md` §11).
- **Vítězná obrazovka** (M6/M7): `$9EA0` a tři konce podle sloupce východu jsou
  z M4 popsané, ale model pro ně ještě není.
- Jediná hodnota z M5, kterou reprodukovat **nejde**, je `LD A,R` v `$B749` –
  výška, do které orel Sabremana odnese. Remake místo obnovovacího registru Z80
  otáčí vlastní počítadlo a `tools/matchmonsters.js` ten jeden bajt hlásí
  zvlášť, aby bylo vidět, že je to jediné místo, kde se přepis od originálu
  liší (`disasm_notes.md` §15.7).
