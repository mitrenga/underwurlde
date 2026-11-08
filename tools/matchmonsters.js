#!/usr/bin/env node
/**
 * Porovná **chování nepřátel, zbraní a strážců** remaku s originálem (M5).
 *
 *   ./tools/matchmonsters.js [--verbose] [--scenario jmeno] [--limit N]
 *
 * Vstup: `build/monster-traces.json` (nahrané kroky entit z originálu, viz
 * `tools/tracemonsters.py`), `data/entities.json` a `data/monsters.json`.
 * Nahrávka je posloupnost zastávek na rozcestníku typů `$9211`; krok jedné
 * entity je rozdíl mezi dvěma sousedními zastávkami. Pro každou dvojici se
 * tabulka entit nastaví na stav z první zastávky, pustí se `app/monsters.js`
 * (tedy **kód, který jde do prohlížeče**) a **šestnáct bajtů obsluhovaného
 * záznamu** se porovná se stavem z druhé zastávky.
 *
 * Cíl je nula rozdílů: obdoba `tools/matchphysics.js` pro entity.
 *
 * Vynechává se:
 * - záznam Sabremana (`$8F1A`) a lana (`$8F2A`) – ty hlídá `matchphysics.js`,
 * - prázdné sloty (obsluha `$9454` je návrat) a typy, které patřily M4
 *   (bubliny, krápníky, rostliny, drahokamy, nábytek) – ty hlídá
 *   `matchentities.js`; tady se kontroluje jenom to, co přidal M5,
 * - dvojice, mezi kterými se hlavní smyčka otočila **a** obsluha slot
 *   uvolnila: do prázdného slotu totiž mohl v té mezeře skočit generátor.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const loadClassicScript = require(path.join(__dirname, '../app/svision/tools/classicScript.cjs'));

const ROOT = path.join(__dirname, '..');
const WorldEntities = loadClassicScript(path.join(ROOT, 'app/worldEntities.js'));
loadClassicScript(path.join(ROOT, 'app/monsters.js'))(WorldEntities);

const TRACES = path.join(ROOT, 'build/monster-traces.json');
const ENTITIES = path.join(ROOT, 'data/entities.json');
const MONSTERS = path.join(ROOT, 'data/monsters.json');
const WORLD = path.join(ROOT, 'data/world.json');

const PLAYER = 0x8F1A, ROPE = 0x8F2A;

/** typy, jejichž chování přidal M5 – jen ty se tady kontrolují */
function isM5(type) {
  return (type >= 0x30 && type <= 0x4F)
      || (type >= 0x5C && type <= 0x63)
      || (type >= 0x6C && type <= 0x71)
      || (type >= 0x80 && type <= 0x88);
}

function hexBytes(hex) {
  const out = new Uint8Array(hex.length/2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i*2, 2), 16);
  }
  return out;
}

/** liší se jen tenhle jediný bajt? */
function onlyByte(got, want, index) {
  for (let i = 0; i < want.length; i++) {
    if (i !== index && got[i] !== want[i]) { return false; }
  }
  return got[index] !== want[index];
}

/** otočila se mezi zastávkami hlavní smyčka? pak do toho mluvily i generátory */
function boundaryOf(next, ix, width) { return next.ix !== ix+width; }

function bytesHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).toUpperCase()
    .padStart(2, '0')).join(' ');
}

/** naplní placer stavem jedné zastávky */
function load(placer, stop, recording) {
  const table = hexBytes(stop.table);
  const stride = recording.stride;
  for (let slot = 0; slot < placer.list.length; slot++) {
    placer.list[slot].set(table.subarray(slot*stride, (slot+1)*stride));
  }
  const weapons = hexBytes(stop.weapons);
  for (let i = 0; i < placer.weapons.length; i++) {
    placer.weapons[i].set(weapons.subarray(i*recording.weaponStride,
                                           (i+1)*recording.weaponStride));
  }
  const g = stop.globals;
  placer.score = g.score.slice();
  placer.carried = g.carried.slice();
  placer.takeHeld = g.takeHeld[0];
  placer.takePulse = g.takePulse[0];
  placer.carryLatchNext = g.carryNext[0];
  placer.carryLatch = g.carryLatch[0];
  placer.eagles = g.eagles[0];
  placer.fireCounter = g.fireCounter[0];
} // load

let world = null;
/** popisný bajt místnosti z data/world.json (M2) */
function descriptor(col, row) {
  if (!world || row < 0 || row >= 52 || col < 0 || col >= 16) { return 0; }
  const line = world.descriptors[row];
  return line ? parseInt(line.substr(col*2, 2), 16) : 0;
}

function makeWorld(placer, stop) {
  const keys = new Set(stop.keys);
  return {
    player: placer.records[PLAYER],
    counters: {step: stop.globals.slow[0], frame: stop.globals.frames[0]},
    input: {
      left: keys.has('Q'), right: keys.has('W'), up: keys.has('R'),
      down: keys.has('E'), fire: keys.has('T'),
    },
    roomWord(col, row) {
      const known = stop.rooms[col+','+row];
      if (known) { return known; }
      // mimo okno, které nahrávka opsala: popisný bajt je v datech světa
      return [descriptor(col, row), 0];
    },
    setRoomState() {},
    sound() {},
    unported() { this.unportedCount++; },
    unportedCount: 0,
    addLife() {},
    invincible: false,
    enterRoomFor(record) {
      placer.enterRoom(record[2], record[4],
                       this.roomWord(record[2], record[4]),
                       this.counters);
    },
  };
} // makeWorld

function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose');
  const only = args.indexOf('--scenario') < 0
    ? null : args[args.indexOf('--scenario')+1];
  const limit = args.indexOf('--limit') < 0
    ? Infinity : parseInt(args[args.indexOf('--limit')+1], 10);

  if (!fs.existsSync(TRACES)) {
    console.error('chybi ' + path.relative(ROOT, TRACES)
                  + ' – spust tools/tracemonsters.py');
    process.exit(2);
  }
  const recording = JSON.parse(fs.readFileSync(TRACES, 'utf8'));
  const data = JSON.parse(fs.readFileSync(ENTITIES, 'utf8'));
  data.monsters = JSON.parse(fs.readFileSync(MONSTERS, 'utf8'));
  world = JSON.parse(fs.readFileSync(WORLD, 'utf8'));
  const base = parseInt(recording.recordsBase.slice(1), 16);
  const weaponsBase = parseInt(recording.weaponsBase.slice(1), 16);
  const stride = recording.stride;

  let checked = 0, skipped = 0, refresh = 0;
  const diffs = [];
  const seen = {};
  for (const name of Object.keys(recording.scenarios)) {
    if (only && name !== only) { continue; }
    const stops = recording.scenarios[name].stops;
    for (let i = 0; i+1 < stops.length && checked < limit; i++) {
      const stop = stops[i], next = stops[i+1];
      const ix = stop.ix;
      if (ix === ROPE) { continue; }
      const weapon = ix >= weaponsBase;
      const slot = weapon ? (ix-weaponsBase)/recording.weaponStride
                          : (ix-base)/stride;
      const width = weapon ? recording.weaponStride : stride;
      if (!Number.isInteger(slot) || slot < 0) { continue; }
      const source = weapon ? stop.weapons : stop.table;
      const before = Array.from(
        hexBytes(source).subarray(slot*width, (slot+1)*width));
      const type = before[0];
      if (!isM5(type) && !(weapon && type >= 0x68 && type <= 0x6B)) { continue; }
      // Sabreman ma vlastni nastroj (matchphysics.js) – az na to, kdyz ho nese orel
      if (ix === PLAYER && !(type >= 0x60 && type <= 0x63)) { continue; }

      const placer = new WorldEntities(data);
      load(placer, stop, recording);
      const world = makeWorld(placer, stop);
      const record = weapon ? placer.weapons[slot] : placer.list[slot];
      if (weapon) { placer.weapon(world, record); }
      else if (!placer.stepMonster(world, record, ix)) { continue; }
      checked++;
      seen[type] = (seen[type] || 0)+1;

      const want = hexBytes(weapon ? next.weapons : next.table)
        .subarray(slot*width, (slot+1)*width);
      let same = true;
      for (let b = 0; b < width; b++) {
        if (record[b] !== want[b]) { same = false; break; }
      }
      // a globály, do kterých obsluha sahá: skóre, nesené zbraně, spouštěč orlů
      const globals = [
        ['skore', placer.score, next.globals.score],
        ['nesene zbrane', placer.carried, next.globals.carried],
        ['spoustec orlu', [placer.eagles], next.globals.eagles],
      ];
      for (const [what, got, wantG] of globals) {
        if (got.join() === wantG.join()) { continue; }
        if (boundaryOf(next, ix, width)) { continue; }
        diffs.push({name, stop, ix, type, what,
                    before: [], got: got.slice(), want: wantG.slice()});
      }
      if (same) { continue; }
      // uvolněný slot na hranici průchodu: mezitím tam mohl skočit generátor
      const boundary = boundaryOf(next, ix, width);
      if (boundary && record[0] === 0 && want[0] !== 0) { skipped++; continue; }
      // $B749 je `LD A,R` – obnovovací registr Z80, ktery mimo Z80 neexistuje.
      // Vybira vysku, do ktere orel hrace odnese, a nic jineho ho necte.
      if (type >= 0x5C && type <= 0x5F && onlyByte(record, want, 14)) {
        refresh++;
        continue;
      }
      diffs.push({name, stop, ix, type, before: Array.from(before),
                  got: Array.from(record), want: Array.from(want)});
    }
  }

  const types = Object.keys(seen).map(Number).sort((a, b) => a-b);
  console.log('kroku %d, typu %d (%s), preskoceno %d, LD A,R %d, rozdilu %d',
              checked, types.length,
              types.map((t) => '$'+t.toString(16).toUpperCase()).join(' '),
              skipped, refresh, diffs.length);
  const shown = verbose ? diffs : diffs.slice(0, 12);
  for (const diff of shown) {
    console.log('  ' + diff.name + ' snimek ' + diff.stop.frame + '  $'
                + diff.ix.toString(16).toUpperCase() + ' typ $'
                + diff.type.toString(16).toUpperCase()
                + (diff.what ? '  ' + diff.what : ''));
    console.log('     pred     ' + bytesHex(diff.before));
    console.log('     remake   ' + bytesHex(diff.got));
    console.log('     original ' + bytesHex(diff.want));
  }
  if (diffs.length > shown.length) {
    console.log('  ... a dalsich %d (--verbose vypise vse)',
                diffs.length-shown.length);
  }
  process.exit(diffs.length ? 1 : 0);
} // main

main();
