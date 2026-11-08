#!/usr/bin/env node
/**
 * Porovná **rozmístění entit** remaku s originálem, místnost po místnosti (M4).
 *
 *   ./tools/matchentities.js [--verbose] [--limit N]
 *
 * Vstup: `build/entity-placement.json` (nahrané rozmístění z originálu, viz
 * `tools/traceentities.py`) a `data/entities.json` (tabulky a konstanty
 * vytažené z obrazu hry, `tools/dumpentities.py`). Pro každou nahranou
 * místnost se pustí `app/worldEntities.js` – tedy **kód, který jde do
 * prohlížeče** – a porovná se **celá tabulka entit `$8EFA–$9029` bajt po
 * bajtu** plus dvoubajtový stav místnosti z tabulky na `$6000`.
 *
 * Cíl je nula rozdílů: entitová obdoba `tools/matchphysics.js` a
 * `tools/matchscreen.py`.
 *
 * Záznam Sabremana (`$8F1A`) se vynechává – ten hlídá `matchphysics.js`.
 * Jeskyně se zkoušejí s několika hodnotami herních počítadel, protože podle
 * nich si hra při první návštěvě vygeneruje stav místnosti.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const loadClassicScript = require(path.join(__dirname, '../app/svision/tools/classicScript.cjs'));

const ROOT = path.join(__dirname, '..');
const WorldEntities = loadClassicScript(path.join(ROOT, 'app/worldEntities.js'));

const PLACEMENT = path.join(ROOT, 'build/entity-placement.json');
const ENTITIES = path.join(ROOT, 'data/entities.json');
const PLAYER = 0x8F1A;
const SLOT_NAMES = {
  0x8EFA: 'shot0', 0x8F0A: 'shot1', 0x8F1A: 'sabreman', 0x8F2A: 'rope',
  0x8F3A: 'drip', 0x8F4A: 'spare4', 0x8F5A: 'bubble0', 0x8F6A: 'bubble1',
  0x8F7A: 'furniture0', 0x8F8A: 'furniture1', 0x8F9A: 'furniture2',
  0x8FAA: 'furniture3', 0x8FBA: 'pickup', 0x8FCA: 'spare12',
  0x8FDA: 'monster0', 0x8FEA: 'monster1', 0x8FFA: 'monster2',
  0x900A: 'monster3', 0x901A: 'spare18',
};

function hexBytes(hex) {
  const out = new Uint8Array(hex.length/2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i*2, 2), 16);
  }
  return out;
}

function bytesHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).toUpperCase()
    .padStart(2, '0')).join(' ');
}

/**
 * Sabreman a lano do rozmístění nemluví, ale `enterRoom` si o místnosti čte
 * popisné slovo a o hráči sloupec a řádek – tolik okolí to potřebuje.
 */
function makeWorld(placer, col, row, word, slow, frames) {
  const player = placer.records[PLAYER];
  player[2] = col;
  player[4] = row;
  return {
    player,
    counters: {step: slow, frame: frames},
    roomWord(c, r) { return (c === col && r === row) ? word : [0, 0]; },
    setRoomState() {},
    sound() {},
    unported() {},
    addLife() {},
    invincible: false,
  };
} // makeWorld

function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose');
  const limitFlag = args.indexOf('--limit');
  const limit = limitFlag < 0 ? Infinity : parseInt(args[limitFlag+1], 10);

  if (!fs.existsSync(PLACEMENT)) {
    console.error('chybi ' + path.relative(ROOT, PLACEMENT)
                  + ' – spust tools/traceentities.py');
    process.exit(2);
  }
  const recording = JSON.parse(fs.readFileSync(PLACEMENT, 'utf8'));
  const data = JSON.parse(fs.readFileSync(ENTITIES, 'utf8'));
  const base = parseInt(recording.recordsBase.slice(1), 16);
  const stride = recording.stride;
  const before = hexBytes(recording.before);

  let checked = 0;
  const diffs = [];
  for (const room of recording.rooms) {
    if (checked >= limit) { break; }
    const placer = new WorldEntities(data);
    // vychozi stav tabulky je u vsech mistnosti stejny (rozehrana hra)
    for (let slot = 0; slot < recording.slots; slot++) {
      placer.list[slot].set(before.subarray(slot*stride, (slot+1)*stride));
    }
    const world = makeWorld(placer, room.col, room.row, room.word,
                            room.slow, room.frames);
    placer.enterRoom(room.col, room.row, room.word, world.counters);
    checked++;

    const want = hexBytes(room.after);
    for (let slot = 0; slot < recording.slots; slot++) {
      const address = base + stride*slot;
      if (address === PLAYER) { continue; }
      const got = placer.list[slot];
      const expected = want.subarray(slot*stride, (slot+1)*stride);
      for (let i = 0; i < stride; i++) {
        if (got[i] !== expected[i]) {
          diffs.push({room, address, got: Array.from(got),
                      want: Array.from(expected)});
          break;
        }
      }
    }
    const state = placer.state(room.col, room.row);
    if (room.row >= 16 && (state[0] !== room.state[0]
                           || state[1] !== room.state[1])) {
      diffs.push({room, address: null, got: state, want: room.state});
    }
  }

  console.log('mistnosti %d, kontrol %d, rozdilu %d',
              new Set(recording.rooms.map((r) => r.col + ',' + r.row)).size,
              checked, diffs.length);
  const shown = verbose ? diffs : diffs.slice(0, 12);
  for (const diff of shown) {
    const where = diff.address === null
      ? 'stav mistnosti ($6000)'
      : (SLOT_NAMES[diff.address] || '?') + ' $'
        + diff.address.toString(16).toUpperCase();
    console.log('  (%d,%d) desc=$%s slow=$%s frames=$%s  %s',
                diff.room.col, diff.room.row,
                diff.room.word[0].toString(16).toUpperCase(),
                diff.room.slow.toString(16).toUpperCase(),
                diff.room.frames.toString(16).toUpperCase(), where);
    console.log('     remake   %s', bytesHex(diff.got));
    console.log('     original %s', bytesHex(diff.want));
  }
  if (diffs.length > shown.length) {
    console.log('  ... a dalsich %d (--verbose vypise vse)',
                diffs.length-shown.length);
  }
  process.exit(diffs.length ? 1 : 0);
} // main

main();
