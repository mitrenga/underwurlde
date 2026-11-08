# Nástroje

Nic z toho se neinstaluje do systému – všechno běží z tohoto adresáře.

| skript | co dělá |
|---|---|
| `mksnapshot.sh` | z kazety v `sources/tape/` udělá `build/underwurlde.z80`, surový obraz RAM `build/underwurlde.bin` ($4000–$FFFF, 49152 B) a hned i runtime obraz (`mkruntime.py`); ověří, že loading screen v paměti souhlasí s `sources/media/screens/loading_screen.scr` |
| `mkruntime.py` | **runtime** obraz RAM `build/underwurlde-run.bin`: hra si po nahrání přesune celý blok o jeden bajt dolů, takže kazetový obraz je proti běžícímu kódu posunutý. Tenhle obraz je jediný správný pro disassembly a extrakci dat (viz `sources/docs/disasm_notes.md` §9) |
| `scr2png.py` | ZX `.scr` (6912 B) → PNG; implementuje nelineární adresování obrazovky |
| `uwdis.py` | disassembluje rozsah **runtime** obrazu (`./tools/uwdis.py 9DA0 9E20`), `--words N` vypíše tabulku dvoubajtových slov (tabulky skoků) |
| `memtrace.py` | trasuje hru **s pořadím instrukcí a s přístupy do paměti**: volací strom, které instrukce kam zapisují, ze kterých spojitých úseků se čtou data, registry na sledovaných adresách. Tímhle se v M2 našel formát dat místností – nejdřív se hra nechá běžet a zapíše se, co dělá, a teprve podle toho se disassembluje |
| `playtrace.py` | spustí hru v simulátoru, odsimuluje stisky kláves (po půlřádcích jako na skutečném Spectru) a uloží snímky obrazovky (PNG + `.scr`) a mapu pokrytí kódu |
| `mapcut.py` | vyřízne místnost `(sloupec 0–15, řádek 0–51)` ze screenshotové mapy světa (mřížka je 16 × 52 po 256 × 176 px – M0 tvrdil 16 × 50 po 184 px, viz `mapworld.py --check`) |
| `dumpfont.py` | vytáhne z `build/underwurlde-run.bin` originální znakovou sadu (`$ED24`) do `sources/media/font_charset.png` |
| `roomlib.py` | společný základ M2: spustí hru a nechá **rutinu originálu** (`$9906`) nakreslit libovolnou místnost podle souřadnic v záznamu Sabremana; k tomu tabulka místností na `$7000` a čtení otevřených stran z popisného bajtu |
| `dumprooms.py` | celý svět z originálu: `data/world.json` (mřížka 16 × 52, popisné bajty, varianty), `data/rooms.json` (100 unikátních obrazů hrací plochy) a `data/room000.json`; `--scr` uloží každou místnost i jako `.scr` do `build/rooms/` |
| `dumpgfx.py` | kulisové bloky místností a pravidla jejich skládání → `data/scenery.json`, s `--png` náhledy do `build/gfx/`; vypíše, že 20 hradních bloků beze zbytku vyplní `$7687–$8666`. Od M4 obsahuje i **osm jeskynních oblastí** a jejich 56 kusů (`$B81B–$CC88`) a rovnou zkontroluje, že se z nich složí všech 351 jeskynních místností bajt po bajtu |
| `dumpsprites.py` | všechny sprity z tabulky `$9332` → `data/spriteframes.json` (145 typů, 116 unikátních rámů); ověří typ `$09` proti póze vyříznuté z běhu v M1; `--png` udělá náhledový list |
| `matchscreen.py` | **pixelově přesné porovnání** dat remaku s originálem: všech 598 místností z balíku obrazů a od M4 i **všech 598 složených z bloků a pravidel** (hrad i jeskyně) – cíl nula rozdílů |
| `mapworld.py` | mapa celého světa z `data/` (4096 × 9152 px, `--scale` zmenší) a `--check` porovnání s dohledanou screenshotovou mapou |
| `mkroom.py` | (M1, nahrazeno `dumprooms.py`) statická místnost většinovým hlasem přes desítky snímků videopaměti → `build/room000-majority.json`; `--diff-frame N,M` uloží vybrané snímky do `build/diffNNNNN.scr` a vypíše, ve kterých buňkách se liší |
| `mksprite.py` | vyřízne sprite ze zachyceného snímku proti statické místnosti (`frame & ~room`) → `data/sprites.json`; `--raw` bere obrazovku bez odečítání (panel) |
| `mkfont.py` | originální znaková sada z `$ED24` → `data/font.json` (kreslí jí panel) |
| `mkscreen.py` | ZX `.scr` → datový soubor remaku (loading screen → `data/loading.json`) |
| `matchpanel.py` | porovná panel remaku se snímkem originálu **bajt po bajtu** (cíl: 0 rozdílů); panelová obdoba `matchscreen.py` |
| `mkimages.py` | obrázky webu a favicon z originálního loading screenu → `images/`, `favicon.ico` |

## M3 – fyzika Sabremana

| skript | co dělá |
|---|---|
| `dumpphysics.py` | **konstanty fyziky z obrazu hry** → `data/physics.json`: každá hodnota je operand skutečné instrukce (okolní bajty se kontrolují, jinak nástroj spadne), k tomu tabulka póz podle typu entity; `--png` uloží náhled póz do `build/gfx/sabreman-poses.png` |
| `physlog.py` | zaznamená stav Sabremana v běžícím originálu – buď **po snímcích** (`run`), nebo **po herních krocích** (`run_steps`: simulátor se zastaví na `$989F`, kde krok začíná, a na `$96CB`, kde končí). Tímhle se fyzika naměřila; samostatně spuštěný vypíše, které bajty záznamu se v okně mění. `trace_frame=N` navíc projde ten jeden krok **po instrukcích** a vrátí, kterými rutinami šel – tím se hledá, kde se přepis rozchází s originálem (viz `disasm_notes.md` §13.9) |
| `tracephysics.py` | nahraje **13 referenčních běhů originálu** (chůze, skok, odraz od stěny, odskok nad prázdnem, smrtelný pád, dosednutí na bublinu, lano – chycení, rozhoupání, puštění, lezení) → `build/physics-traces.json`; vypíše i změřenou kadenci pomalého počítadla `$8ED6` |
| `matchphysics.js` | **porovná přepis fyziky remaku s originálem krok po kroku** (obdoba `matchscreen.py` pro fyziku): pustí `app/sabremanPhysics.js` proti nahrávkám a hlásí každý rozdíl v záznamu Sabremana i v globálech lana. Stav M3: **1355 kroků, nula rozdílů** |
| `runworker.js` | projde celou smyčku `app/gameWorker.js` bez prohlížeče (atrapa workeru v `vm`): chůze a skok, chycení lana a rozhoupání, smrt pádem a game over, a od M4 i tři scény ve skutečném světě – nábytek startovní místnosti, stoupající bubliny v jeskyni a sebrání drahokamu s odpočtem `GEMS` |
| `renderframe.js` | vykreslí snímky hry do PNG celým řetězem remaku – worker + `screenComposer.js` + data; kontrola očima, že pózy, lano, entity a panel sedí. `--scene sandbox` je scéna M3, `--scene world` startovní hradní místnost a `--scene cave` jeskyně s otevřenou podlahou (ty dvě se plní samy z `data/entities.json`) |

## M4 – svět: kompozice jeskyní a rozmístění entit

| skript | co dělá |
|---|---|
| `dumpentities.py` | **rozmístění entit po celém světě** → `data/entities.json`: tabulka nábytku 256 hradních místností (`$6800`, 8 B na místnost), pravidla a předlohy jeskyní, 16 extra životů, 3 strážci, 4 sady zbraní, generátory bublin a krápníků, hitboxy a 145 typů entit. Každá konstanta je operand skutečné instrukce (jinak nástroj spadne), stejně jako u `dumpphysics.py`; `--png` uloží náhledový list typů do `build/gfx/entity-types.png` |
| `traceentities.py` | nahraje z originálu **celou tabulku entit po vstupu do místnosti** pro všech 598 místností → `build/entity-placement.json`. Jeskyně se nahrávají s několika hodnotami herních počítadel (`--seeds`), protože podle nich si hra při první návštěvě vygeneruje stav místnosti |
| `matchentities.js` | **porovná rozmístění entit remaku s originálem, místnost po místnosti**: proti nahrávce pustí `app/worldEntities.js`, tedy kód, který jde do prohlížeče. Stav M4: **598 místností, 1651 kontrol, nula rozdílů** |
| `matchtransitions.js` | projede **všech 1222 přechodů** mezi místnostmi skutečnou fyzikou (`app/sabremanPhysics.js`) a ověří, že hráč skončí ve správné místnosti **na vstupní souřadnici originálu**. Stav M4: 1222 z 1222 |
| `checkworld.py` | kontrola grafu světa: počet přechodů, vzájemnost stran, slepé strany (jsou **tři** a jsou to východy ze hry), průchodnost zaplavením od startu a dosažitelnost strážců a extra životů. Drží známé hodnoty originálu jako očekávané, takže hlásí až to, co se v datech rozbilo |

## M5 – nepřátelé, zbraně, strážci a bodování

| skript | co dělá |
|---|---|
| `dumpmonsters.py` | **chování nepřátel, zbraní, projektilů a strážců plus bodování** → `data/monsters.json`: generátor a pohybové vzory (`$AFDA`, `$B079`, `$B3D8`, `$EE66`), zbraně (`$E8D7`) i s tím, že se nesou **až tři naráz** v panelu, výstřel (`$B4D1`) a tabulka projektilů `$B753`, strážci (`$ECCA`) a jejich párování se zbraní, východ (`$ED2E`) a skóre (`$A045`). Každá konstanta je operand skutečné instrukce (jinak nástroj spadne); vypíše i tabulku zbraň → projektil → strážce. `--png` uloží náhledový list typů M5 do `build/gfx/m5-types.png` |
| `tracemonsters.py` | nahraje z originálu **kroky entit**: hra se zastaví na **rozcestníku typů `$9211`** (tam, kde `JP (HL)` skáče do obsluhy podle `(IX+0)`) a opíše `IX`, celou tabulku entit i zbraní a globály M5 → `build/monster-traces.json`. Krok jedné entity je rozdíl mezi dvěma zastávkami. Dvanáct scénářů, které tabulku plní přímo (jako `tracephysics.py` vkládá Sabremana do místnosti), aby se k orlům, strážcům a projektilům došlo rychleji než hraním |
| `matchmonsters.js` | **porovná chování remaku s originálem, krok po kroku**: proti nahrávce pustí `app/monsters.js`, tedy kód, který jde do prohlížeče, a hlásí každý rozdílný bajt záznamu plus skóre, nesené zbraně a spouštěč orlů. Stav M5: **6960 kroků, 49 typů entit, nula rozdílů**. Jediná hodnota, kterou reprodukovat nejde, je `LD A,R` v `$B749` – tu hlásí zvlášť, neschovává |

## M6 – grafika a zvuk

| skript | co dělá |
|---|---|
| `dumpsound.py` | **zvuky originálu** → `data/sounds.json`. Konstanty se čtou jako operandy skutečných instrukcí (jinak nástroj spadne, jako u `dumpphysics.py`), ale pulzy se **nemodelují**: rutiny originálu je zahrají v simulátoru a zapíše se, jak dlouho byl bit 4 portu `$FE` nahoře a dole (v T-stavech). Sedm zvuků, 30 variant; k tomu tabulka volání (kdo který zvuk hraje) a seznam mrtvých rutin, jejichž deadness se **měří** průchodem celého obrazu, ne hádá. `--wav` uloží každou variantu k poslechu |
| `tracesound.py` | nahraje **zvuk za hraní** → `build/sound-traces.json`: každý zápis na port `$FE` s T-stavem, rozdělený na shluky. V okamžiku prvního pulzu se ze zásobníku přečte návratová adresa, takže každý shluk ví, které místo v programu ho zahrálo. Osm scénářů (chůze, skok, pád, dotek, zabití, zásah stěny, sebrání drahokamu, dopad na podlahu) |
| `matchsound.js` | **porovná zvuk remaku s originálem pulz po pulzu**: proti nahrávce pustí `app/beeper.js` a `data/sounds.json`, tedy kód a data, která jdou do prohlížeče. Stav M6: **77 shluků, 4450 pulzů, nula rozdílů**. Pulzy natažené přerušením ULA (originál hraje zvuk uvnitř herního kroku) hlásí zvlášť, neschovává |
| `tracescreen.py` | opíše **videopaměť hrajícího originálu i s entitami** → `build/screen-traces.json`, vzorkovanou na konci průchodu hlavní smyčkou (`$955C`, tam je nakreslené všechno). K obrazu se ukládá i stav, ze kterého vznikl (tabulka entit, zbraně, záznam Sabremana, globály lana) a kulisa místnosti hned po vstupu – proti té se pak kreslí, protože jeskyně si stav místnosti generují za běhu |
| `matchsprites.js` | **porovná nakreslený obraz remaku s originálem**: proti nahrávce pustí `app/screenComposer.js` s daty z `data/`. Rozhoduje podle **pixelů**, protože originál po odletělém spritu barvu neuklidí a v prázdné buňce ta barva není vidět; rozdíly v bajtech (tvar/barva) hlásí zvlášť jako diagnostiku. Tímhle se v M6 našlo, že blitter kreslí XORem, jak se plní obdélník atributů, že nábytek má vlastní mapu barev a že východ ze hry byl o 16 px vlevo |
| `dumptitle.py` | **titulní obrazovka** originálu → `data/title.json` (formát jako `mkscreen.py`). Zároveň odpovídá na položku „attract mode": hru nechá běžet 1300 snímků bez klávesy a ověří, že se obrazovka **nezměnila o jediný bajt** – demo ani hi-score originál nemá |

## `vendor/` – SkoolKit 10.1

Na tomhle stroji není `pip` ani `python3-venv`, takže je SkoolKit **rozbalený z wheelu**
do `tools/vendor/` a spouští se přes `PYTHONPATH`:

```sh
PYTHONPATH=tools/vendor python3 tools/vendor/skoolkit-10.1.data/scripts/tap2sna.py --help
```

Wheel: `skoolkit-10.1-cp312-...-manylinux...whl` z PyPI (obsahuje i C simulátor,
takže trasování je rychlé). Do gitu nepatří – viz `.gitignore`.

Užitečné skripty SkoolKitu pro tenhle projekt:
`tap2sna.py` (kazeta → snapshot, umí Speedlock), `trace.py` (běh se záznamem instrukcí
a pokrytím), `sna2skool.py` / `sna2ctl.py` (disassembly), `snapinfo.py --find` (hledání
v paměti), `sna2img.py` (obrazovka → PNG), `tapinfo.py`, `rzxplay.py`.
