# Data remaku

Stav M6. Všechno tady je **vytažené z originálu** – nic dokresleného.

| soubor | co je uvnitř | čím vzniklo |
|---|---|---|
| `global.json` | konstanty změřené na běhu originálu: 50,08 Hz, 6 životů, start `DEPTH 15`, mřížka světa, rozvržení panelu | ručně z `sources/docs/` |
| `font.json` | znaková sada hry z `$ED24`, 37 glyfů (mezera, číslice, velká písmena) | `tools/mkfont.py` |
| `loading.json` | loading screen z originální kazety, celá obrazovka 256 × 192 | `tools/mkscreen.py` |
| `title.json` | **titulní obrazovka** (`UNDERWURLDE GAME SELECTION`), opsaná z videopaměti běžícího originálu; ověřeno, že se 1300 snímků nezmění – attract mode hra nemá | `tools/dumptitle.py` |
| `world.json` | **celý svět**: mřížka 16 × 52, popisný bajt každé z 598 místností, otevřené strany, číslo varianty obrazu | `tools/dumprooms.py` |
| `rooms.json` | **100 unikátních obrazů** hrací plochy (5632 B bitmapy + 704 B atributů) – z nich se složí všech 598 místností | `tools/dumprooms.py` |
| `scenery.json` | 20 kulisových bloků hradu + 56 jeskynních kusů a pravidla, jak z popisného bajtu složit **kteroukoli** místnost | `tools/dumpgfx.py` |
| `entities.json` | **rozmístění entit po celém světě**: tabulka nábytku 256 hradních místností, pravidla a předlohy jeskyní, 16 extra životů, 3 strážci, 4 sady zbraní, generátory bublin a krápníků, hitboxy, 145 typů entit | `tools/dumpentities.py` |
| `physics.json` | konstanty fyziky Sabremana, každá jako operand skutečné instrukce | `tools/dumpphysics.py` |
| `monsters.json` | **chování** nepřátel, zbraní, projektilů a strážců a **bodování**: generátor a pohybové vzory, nesení až tří zbraní v panelu, tabulka projektilů `$B753`, párování strážce↔zbraň, východ a skóre (`$A045`). Každá konstanta je operand skutečné instrukce | `tools/dumpmonsters.py` |
| `spriteframes.json` | 116 unikátních spritů z tabulky `$9332` (Sabreman, nepřátelé, zbraně, strážci, nábytek) a k tomu **mapy barev hradního nábytku** (`attributeBlocks`, typy `$79–$7E`, tabulka `$EB72`) | `tools/dumpsprites.py` |
| `sounds.json` | **všech sedm zvuků hry** jako délky pulzů v T-stavech: rutiny originálu je zahrály v simulátoru a zapsalo se, jak dlouho byl bit 4 portu `$FE` nahoře a dole. K tomu konstanty jádra `$A06A`, tabulka volání (kdo co hraje), seznam mrtvých rutin a mapa událost → zvuk | `tools/dumpsound.py` |
| `room000.json` | startovní místnost ve formátu z M1 (aby aplikace M1 běžela bez zásahu) | `tools/dumprooms.py` |
| `sprites.json` | Sabreman: póza `stand` a `panelIcon`, vyříznuté z běhu originálu v M1 | `tools/mksprite.py` |
| `menu.json` | zatím prázdné (rezerva) | – |

Bitmapy i atributy jsou base64 skutečných bajtů videopaměti; bitmapa je uložená
**lineárně po pixelových řádcích** (nelineární adresování Spectra se rozplétá už
v nástroji, ne v prohlížeči).

`physics.json` má u každé hodnoty v `source` **adresu instrukce**, ze které je
přečtená, a její rozpis – takže se dá kdykoli zpětně zkontrolovat proti
`tools/uwdis.py`. Jediná hodnota, která není operand instrukce, je
`measured.slowCounterFrames`; ta je odměřená na běhu a je u ní napsané, jak.

## Formát světa – proč takhle

Otázka M2 zněla: jak uložit 597 místností, když per-room JSON jako v Jet Set Willy
(61 souborů) nedává smysl. Odpověď z originálu je překvapivě malá:

- **Místnost je v hře popsaná jediným bajtem.** Tabulka na `$7000`, adresa
  `$7000 + 32*řádek + 2*sloupec`, mřížka 16 × 52. Bity 0/2/4/6 toho bajtu jsou
  uzavřené strany (strop / pravá / podlaha / levá), zbytek jsou vždy jedničky.
  Různých bajtů je v celé tabulce **patnáct**. Podrobně
  `sources/docs/disasm_notes.md` §10.
- **Kulisu z něj hra složí ze čtyř kvadrantů** – rohový blok plus podle bitů pruh
  stropu, pruh podlahy a boční stěny. Dvacet bloků, 4064 B, `data/scenery.json`.
- Jeskyně (řádky 16–51) mají místo těch čtyř kvadrantů **osm oblastí, jednu na
  každý bit** popisného bajtu, a kus grafiky si vybírají podle `sloupec + řádek`
  (M4, `disasm_notes.md` §14.1). Různých pozadí je proto dohromady jen **100**.

Data remaku tedy jsou:

1. `world.json` (4,5 kB, gzip 1,6 kB) – mřížka, popisné bajty, čísla variant.
   Načítá se při startu v `appData`.
2. `rooms.json` (850 kB, gzip 108 kB) – 100 obrazů hrací plochy, bajt po bajtu
   z originálu. **Nenačítá se v `appData`, ale na vyžádání** (`db/appData.php`
   ho proto v seznamu nemá): 100 obrazů je celý svět, jedna žádost, a přes gzip
   je to sto kilobajtů. Kdyby to na mobilu vadilo, jde ho rozdělit po variantách
   – `world.json` je na to připravený, čísla variant zná dopředu.
3. `scenery.json` (34 kB, gzip 9 kB) – bloky a pravidla skládání. Tohle je ta „pravá"
   kompaktní podoba světa a od M4 je **úplná**: z bloků a pravidel se složí
   všech 598 místností bajt po bajtu, hradních i jeskynních. `rooms.json` už
   tedy není nutný – zůstává, protože je to jedna žádost a nulová práce
   v prohlížeči, ale kdyby bylo potřeba ušetřit, dá se zahodit.
4. `monsters.json` (29 kB, gzip 6 kB) – **co ty entity dělají**: pohybové vzory,
   zbraně, projektily, strážci a bodování (M5). Načítá se v `appData` vedle
   `entities.json`, protože nepřáteli se to začne hemžit hned ve startovní
   místnosti. Skoro celé je to konstanty a k nim adresa instrukce, ze které
   pocházejí, takže se dá každá hodnota dohledat v `tools/uwdis.py`.
5. `entities.json` (41 kB, gzip 10 kB) – to, co v místnostech stojí. Načítá se
   v `appData`, protože je potřeba od první místnosti. Objemově je to skoro celé
   tabulka nábytku hradu, uložená **surově** (16 řádků po 128 B v hexa), přesně
   jak leží v `$6800–$6FFF`; remake ji rozbaluje tím samým vzorcem jako rutina
   `$EAA2`. Rozepsaný seznam entit by byl o dva řády větší a nebyl by věrnější.

## Ověření – nula rozdílů

`tools/matchscreen.py` porovnává **data remaku** s tím, co nakreslí kód originálu
v simulátoru:

```
$ ./tools/matchscreen.py
zkontrolovano mistnosti: 598
  balik obrazu (data/world.json + data/rooms.json): 0 rozdilnych
  skladani kulisy z bloku a pravidel: 0 z 598 rozdilnych
  nula rozdilu, nula nevysvetlenych pixelu
```

První kontrola ověřuje celý datový řetěz (base64, deduplikaci, indexy), druhá
navíc **dekódování grafiky, atributů a rozvržení** – místnost se skládá z bloků
a pravidel, ne z hotového obrazu. Od M4 to platí i pro jeskyně.

Entity mají svou vlastní kontrolu a stejné měřítko: `tools/traceentities.py`
nechá **originál v simulátoru** projít svou rutinu vstupu do místnosti a uloží
celou tabulku entit, `tools/matchentities.js` proti tomu pustí
`app/worldEntities.js` – tedy kód, který jde do prohlížeče:

```
$ ./tools/matchentities.js
mistnosti 598, kontrol 1651, rozdilu 0
```

1651 kontrol, protože jeskyně se zkoušejí s několika hodnotami herních
počítadel: podle nich si hra při první návštěvě vygeneruje stav místnosti
(§14.3), takže kdyby přepis reprodukoval jen jednu, prošel by omylem.

A od M5 má vlastní kontrolu i **chování** entit, ve stejné disciplíně:
`tools/tracemonsters.py` zastaví hru na **rozcestníku typů `$9211`** a opíše
tabulku entit při každém skoku do obsluhy, `tools/matchmonsters.js` proti tomu
pustí `app/monsters.js`:

```
$ ./tools/matchmonsters.js
kroku 6960, typu 49 ($30 $31 ... $86 $87 $88), preskoceno 0, LD A,R 1, rozdilu 0
```

„LD A,R 1" není chyba, ale poctivost: `$B749` losuje výšku, do které orel
Sabremana odnese, z **obnovovacího registru Z80**, který mimo Z80 neexistuje.
Ten jediný bajt se hlásí zvlášť místo toho, aby se schoval (§15.7).

A přechody: `tools/checkworld.py` zkontroluje graf světa a `tools/matchtransitions.js`
projede **všech 1222 přechodů** skutečnou fyzikou remaku a ověří, že hráč
skončí ve správné místnosti na vstupní souřadnici originálu:

```
$ ./tools/matchtransitions.js
prechodu 1222, proslo 1222, neproslo 0
  left    299
  right   300
  top     312
  bottom  311
```

Nezávisle: `tools/mapworld.py --check` složí mapu světa z dat a porovná ji
s dohledanou screenshotovou mapou (`sources/media/maps/speccycz_screenshot_map.png`);
shoda inkoustu je **96 %** na 125 místnostech napříč světem (do 100 % chybí sprity
a popisky, které v mapě jsou a v datech ne).

## Dvě čísla, která nesouhlasí s obalem

Inlay slibuje **597 obrazovek**, v tabulce je ale **598** neprázdných míst.
★ **M4 to dopočítal** (`tools/checkworld.py`): otevřených stran je 1225, z toho
**1222 vede do existující místnosti** a **3 jsou východy ze hry** (otevřený
strop v řádku 0, sloupce 3, 9 a 13 – každý vede do jiného pokračování).
Jednosměrné přechody jsou 4 a kvůli nim se do místností `(1,13)`, `(1,14)`,
`(1,15)` a `(7,10)` **nedá vejít**, jen z nich vyjít: nevede do nich žádná
otevřená strana souseda. **Dosažitelných je 594 z 598.**

Obal tedy nesouhlasí ani s jedním z těch čísel (598 v tabulce, 594 projitelných)
– 597 je marketingové číslo. Tady stojí, co v datech je, ne co je na obalu.

Druhé číslo: mřížka má **52 řádků**, ne 50, jak tvrdil M0 z rozměru screenshotové
mapy. Buňka mapy je 176 px (ne 184 s panelovým pruhem) a 52 × 176 = 9152, zbylých
48 px obrázku je přebytek. `tools/mapcut.py` i `sources/docs/screen_layout.md` jsou
opravené.

## Co dělá M5

`entities.json` už obsahuje i to, co M5 potřebuje a M4 nepoužívá: rozmístění
čtyř zbraní ve čtyřech sadách, souřadnice a typy strážců včetně toho, na jaký
projektil kdo padne, parametry generátoru nepřátel a spouštěč orlů. Bodová
tabulka (rutina `$A045`) přibyla v `monsters.json`.

## Zvuk (M6): proč jsou v datech pulzy, a ne noty

`sounds.json` nedrží popis zvuku, ale **zvuk sám** – posloupnost délek pulzů,
protože přesně to je všechno, co jednobitový beeper umí vydat. Vzniklo to
stejně jako `rooms.json`: místnost kreslí rutina originálu a do dat jde, co po
ní zůstane ve videopaměti; zvuk hraje rutina originálu a do dat jde, co po ní
zůstane na portu.

Varianty jsou tam proto, že tři zvuky nemají pevnou výšku: krok se přepíná
podle bitu 2 svého počítadla (`$8EF6`), dotek bere výšku z `y` toho, co se
dotklo (16 variant), a zvuk „něco umřelo" bere délku z počítadla snímků ULA
(8 variant). Který zvuk a která varianta se má hrát, rozhoduje `app/beeper.js`
podle téhož výpočtu, jaký má originál; `tools/matchsound.js` to kontroluje
proti nahrávce ze hry (77 shluků, 4450 pulzů, nula rozdílů).

Délky jsou v **T-stavech Z80 při 3,5 MHz**, ne v sekundách ani vzorcích – na
vzorky se přepočítají až v prohlížeči podle skutečné `sampleRate`, a to průběžným
součtem, aby se zaokrouhlení stovky pulzů nesčítalo.
