#!/usr/bin/env node
/**
 * Porovná **nakreslený obraz remaku s obrazem originálu** bajt po bajtu (M6).
 *
 *   ./tools/matchsprites.js [--verbose] [--scenario jmeno] [--png build/gfx]
 *
 * Vstup: `build/screen-traces.json` – videopaměť hrajícího originálu na konci
 * průchodu hlavní smyčkou a k ní stav, ze kterého ten obraz vznikl
 * (`tools/tracescreen.py`). Proti každému snímku se pustí `app/screenComposer.js`
 * s obrazem místnosti z `data/rooms.json` a s póz(ami) z
 * `data/spriteframes.json` – tedy kód a data, která jdou do prohlížeče – a
 * porovná se **hrací plocha 256 × 176**: 5632 bajtů bitmapy a 704 bajtů
 * atributů.
 *
 * `matchscreen.py` (M2) kontroluje kulisu místností, tohle kontroluje kreslení
 * spritů: že entita je na správném pixelu, že se sprite **XORuje** do kulisy
 * ($97A5) a že barvy sedí – tedy že attribute clash vzniká na týchž buňkách
 * jako v originálu.
 *
 * Rozhoduje se podle **pixelů**, ne podle bajtů, a je pro to důvod: originál
 * po sobě barvy neuklízí. Když sprite odletí, jeho bitmapa se XORem smaže, ale
 * atribut buňky zůstane – v prázdné buňce je to barva inkoustu, kterou není
 * čím nakreslit, takže není vidět. Remake kreslí každý snímek z čisté kulisy,
 * takže takové stopy nemá. Nástroj proto počítá **buňky, které vypadají jinak**,
 * a rozdíly v bajtech (tvar/barva) hlásí zvlášť jako diagnostiku.
 *
 * Panel se tady neporovnává, ten má vlastní nástroj (`tools/matchpanel.py`).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const loadClassicScript = require(path.join(__dirname, '../app/svision/tools/classicScript.cjs'));
const url = require('url');

const ROOT = path.join(__dirname, '..');
const WorldEntities = loadClassicScript(path.join(ROOT, 'app/worldEntities.js'));
loadClassicScript(path.join(ROOT, 'app/monsters.js'))(WorldEntities);
const TRACES = path.join(ROOT, 'build/screen-traces.json');
const COLS = 32, LINES = 176, ROWS = LINES/8;

const load = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', name+'.json'), 'utf8'));

function bytesOf(hex) {
  const out = new Uint8Array(hex.length/2);
  for (let i = 0; i < out.length; i++) { out[i] = parseInt(hex.substr(i*2, 2), 16); }
  return out;
}

function parseArgs(argv) {
  const args = {verbose: false, scenarios: null, bare: false, dump: 0};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--verbose') { args.verbose = true; }
    else if (argv[i] === '--bare') { args.bare = true; }
    else if (argv[i] === '--dump') { args.dump = +argv[++i]; }
    else if (argv[i] === '--scenario') { (args.scenarios = args.scenarios || []).push(argv[++i]); }
    else { throw new Error('neznamy prepinac '+argv[i]); }
  }
  return args;
}

/**
 * Co je v místnosti vidět. Nepočítá se to tady znovu: tabulka entit z originálu
 * se nasype do `app/worldEntities.js` a zavolá se jeho `visible()`, tedy ten
 * výběr, který v prohlížeči rozhoduje, co se kreslí – i s výjimkami, které
 * originál má (východ ze hry je klín spritů a jeho záznam si místnost nepamatuje,
 * `$ED2E`; totéž jeskynní průduch a porost).
 */
function visible(placer, table, weapons, col, row) {
  for (let at = 0; at+16 <= table.length; at += 16) {
    const record = placer.records[WorldEntities.RECORDS_BASE+at];
    if (!record) { continue; }
    record.set(table.subarray(at, at+16));
  }
  for (let i = 0; i*8+8 <= weapons.length; i++) {
    placer.weapons[i].set(weapons.subarray(i*8, i*8+8));
  }
  return placer.visible(col, row);
}

async function main() {
  const args = parseArgs(process.argv);
  const traces = JSON.parse(fs.readFileSync(TRACES, 'utf8'));
  global.atob = (data) => Buffer.from(data, 'base64').toString('binary');
  // screenComposer.js importuje ZXVideoRAM ze svision, takže hlavička potřebuje
  // window.srcVersion – shim se musí načíst jako první (R-001)
  await import(url.pathToFileURL(path.join(ROOT, 'app/svision/tools/nodeEnv.mjs')).href);
  const { ScreenComposer } = await import(url.pathToFileURL(path.join(ROOT, 'app/screenComposer.js')).href);
  const { ZXVideoRAM } = await import(url.pathToFileURL(path.join(ROOT, 'app/svision/js/platform/canvas2D/zx/zxVideoRAM.js')).href);

  const rooms = load('rooms');
  const world = load('world');
  const placer = new WorldEntities(load('entities'), {monsters: true});
  placer.initMonsters(load('monsters'));
  const spriteframes = load('spriteframes');
  const render = new ScreenComposer(
    {width: rooms.width, height: rooms.height,
     bitmap: rooms.variants[0].bitmap, attributes: rooms.variants[0].attributes},
    load('font'), load('sprites'), spriteframes);

  let shots = 0, cells = 0, bad = 0, badShots = 0, left = 0;
  let badBitmap = 0, badAttrs = 0, invisible = 0;
  const minePixels = new Uint8ClampedArray(256*LINES*4);
  const memory = new ZXVideoRAM();
  const hisPixels = new Uint8ClampedArray(256*LINES*4);
  const names = args.scenarios || Object.keys(traces.scenarios);

  for (const scenario of names) {
    if (!(scenario in traces.scenarios)) { throw new Error('neznamy scenar '+scenario); }
    const backdrop = traces.scenarios[scenario].backdrop;
    for (const shot of traces.scenarios[scenario].frames) {
      // snímek z jiné místnosti, než ve které se kulisa vzala, porovnat nejde
      if (shot.col !== backdrop.col || shot.row !== backdrop.row) {
        left++;
        continue;
      }
      const table = bytesOf(shot.table);
      const weapons = bytesOf(shot.weapons);
      const player = bytesOf(shot.player);
      // globály lana ($AA93): konec lana je na +2/+3 (tools/matchphysics.js),
      // kotva je střed stropu místnosti
      const ropeBytes = bytesOf(shot.rope);
      // kulisa je ta, kterou v tom běhu nakreslila **rutina originálu** při
      // vstupu do místnosti (tracescreen.py), ne varianta z data/rooms.json:
      // jeskyně si stav místnosti generují za běhu (§14.3), a co se tady
      // kontroluje, je kreslení spritů, ne skládání kulisy — to hlídá
      // matchscreen.py na všech 598 místnostech
      render.setRoom({width: 256, height: LINES,
                      bitmap: backdrop.bitmap, attributes: backdrop.attributes});
      // lano: konec je v globálech ($AA93), kotva je strop místnosti
      const hanging = player[0] >= 0x01 && player[0] <= 0x08;
      const ropeEntity = table[(0x8F2A-0x8EFA)] === 0x17;
      const state = {
        sabreman: {type: player[0], x: player[1], y: player[3], attr: player[5]},
        entities: visible(placer, table, weapons, shot.col, shot.row)
          .filter((entity) => !(entity.x === player[1] && entity.y === player[3]
                                && entity.type === player[0])),
        rope: {visible: hanging || ropeEntity,
               anchorX: 0x80, anchorY: 0x24,
               tipX: ropeBytes[2], tipY: ropeBytes[3]}
      };
      // porovnává se **videopaměť**, ne obrázek: bitmapa i atributy tak, jak je
      // drží stroj, protože přesně to originál v paměti má
      render.composeInto(memory, args.bare ? {} : state);
      const mine = memory.toLinear(render.playArea);
      const hisBitmap = ZXVideoRAM.decode(shot.bitmap);
      const hisAttrs = ZXVideoRAM.decode(shot.attributes);
      ZXVideoRAM.paintLinear(minePixels, mine.bitmap, mine.attributes, COLS, ROWS, false);
      ZXVideoRAM.paintLinear(hisPixels, hisBitmap, hisAttrs, COLS, ROWS, false);
      shots++;
      const diff = [];
      for (let row = 0; row < ROWS; row++) {
        for (let col = 0; col < COLS; col++) {
          cells++;
          let sameBitmap = true;
          for (let line = 0; line < 8; line++) {
            const at = (row*8+line)*COLS+col;
            if (mine.bitmap[at] !== hisBitmap[at]) { sameBitmap = false; break; }
          }
          const sameAttr = mine.attributes[row*COLS+col] === hisAttrs[row*COLS+col];
          if (!sameBitmap) { badBitmap++; }
          if (!sameAttr) { badAttrs++; }
          if (sameBitmap && sameAttr) { continue; }
          let samePixels = true;
          for (let line = 0; line < 8 && samePixels; line++) {
            const base = ((row*8+line)*256+col*8)*4;
            for (let pixel = 0; pixel < 32; pixel++) {
              if (minePixels[base+pixel] !== hisPixels[base+pixel]) {
                samePixels = false;
                break;
              }
            }
          }
          if (samePixels) { invisible++; continue; }
          bad++;
          diff.push(col+','+row+(sameBitmap ? '(barva)' : (sameAttr ? '(tvar)' : '')));
        }
      }
      if (diff.length && args.dump) {
        diff.slice(0, args.dump).forEach((cell) => {
          const col = +cell.split(',')[0], row = parseInt(cell.split(',')[1], 10);
          const line = (what, bm, at) => {
            const bits = [];
            for (let l = 0; l < 8; l++) {
              bits.push(bm[(row*8+l)*COLS+col].toString(2).padStart(8, '0'));
            }
            console.log('   %s bunka %d,%d attr $%s %s', what, col, row,
                        at[row*COLS+col].toString(16), bits.join('|'));
          };
          line('original', hisBitmap, hisAttrs);
          line('remake  ', mine.bitmap, mine.attributes);
        });
      }
      if (diff.length) {
        badShots++;
        console.log('%s %d (mistnost %d,%d): %d bunek jinak%s',
                    scenario, shot.frame, shot.col, shot.row, diff.length,
                    args.verbose ? ' — '+diff.slice(0, 40).join(' ') : '');
      } else if (args.verbose) {
        console.log('%s %d (mistnost %d,%d): shoda, %d entit',
                    scenario, shot.frame, shot.col, shot.row, state.entities.length);
      }
    }
  }
  console.log('snimku %d, bunek %d, jinak vypada %d (v %d snimcich); '
              + 'v bajtech %d tvarem a %d barvou, z toho %d neviditelnych '
              + '(barva inkoustu v prazdne bunce)%s',
              shots, cells, bad, badShots, badBitmap, badAttrs, invisible,
              left ? ', '+left+' snimku z jine mistnosti vynechano' : '');
  process.exit(bad === 0 ? 0 : 1);
}

main().catch((error) => { console.error(error); process.exit(2); });
