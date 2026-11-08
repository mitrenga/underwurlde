#!/usr/bin/env node
/**
 * Porovná fyziku remaku s originálem **krok po kroku** (M3).
 *
 *   ./tools/matchphysics.js [--scenario jmeno] [--verbose] [--limit N]
 *
 * Vstup: `build/physics-traces.json` (nahrané běhy originálu, viz
 * `tools/tracephysics.py`) a `data/physics.json` (konstanty vytažené z obrazu
 * hry, `tools/dumpphysics.py`). Přes každý běh se pustí `app/sabremanPhysics.js`
 * se stejnými klávesami a stejným okolím a hlásí se každý rozdíl v záznamu
 * Sabremana a v globálech lana. Cíl je **nula rozdílů** – fyzikální obdoba
 * `tools/matchscreen.py`, který stejným způsobem hlídá grafiku.
 *
 * Okolí (nepřátelé, nábytek, plošiny, počítadla hry) se do každého kroku bere
 * z nahrávky, protože ho hýbe kód, který je na M4/M5 – kontroluje se Sabreman
 * a lano, tedy to, co M3 slibuje. Porovnává se stav **na konci kroku**
 * (originál se vzorkuje na `$989F` i na `$96CB`), protože do záznamu Sabremana
 * mezi kroky zapisují i jiné entity – bublina nebo nepřítel mu umí přepsat dx
 * (`$E3CB`, `$B15E`, `$ED28`), a to je na M4/M5.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const loadClassicScript = require(path.join(__dirname, '../app/svision/tools/classicScript.cjs'));

const ROOT = path.join(__dirname, '..');
const SabremanPhysics = loadClassicScript(path.join(ROOT, 'app/sabremanPhysics.js'));

const F = SabremanPhysics.FIELDS;
const RECORD_FIELDS = [
  ['type', F.TYPE], ['x', F.X], ['col', F.COL], ['y', F.Y], ['row', F.ROW],
  ['dx', F.DX], ['walk', F.WALK], ['vy', F.VY], ['counter', F.COUNTER],
  ['mask', F.MASK], ['contact', F.CONTACT],
];
// Priznakovy bajt (IX+$0F) do porovnani nepatri: bit 0 si nastavuje kresleni a
// bity 3-7 systemy z M5 (orel, straznik, zasah). Do kroku se bere z nahravky.
const ROPE_FIELDS = [
  ['tipX', 2], ['tipY', 3],
  ['swingVel', 15], ['accLow', 16], ['offset', 17],
  ['length', 18], ['lengthHigh', 19],
];
// Konec lana z predchoziho kroku ($AA97) si originál prepisuje az v $AB54, tedy
// **za** kreslenim, na kterem se vzorkuje – porovnava se proto se vstupem
// nasledujiciho kroku.
const ROPE_PREV_FIELDS = [['prevTipX', 4], ['prevTipY', 5]];
const ENTITY_BASE = 0x8F2A;
const KEY_MAP = {
  W: 'right', Q: 'left', E: 'down', R: 'up', T: 'fire',
  CAPS: 'release', Z: 'release', X: 'release', C: 'release', V: 'release',
};

function hexBytes(hex) {
  const out = new Uint8Array(hex.length/2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i*2, 2), 16);
  }
  return out;
}

function hex2(value) {
  return '$' + value.toString(16).toUpperCase().padStart(2, '0');
}

/** okolí Sabremana pro jeden krok – záznamy entit, lano, místnosti, počítadla */
function makeWorld(physics, world, player) {
  const records = {};
  const roomState = {};
  const state = {
    player,
    rope: {tipX: 0, tipY: 0, prevTipX: 0, prevTipY: 0, swingVel: 0, accLow: 0,
           offset: 0, length: 0, lengthHigh: 0, anchorX: 0x80, anchorY: 0x24},
    input: {left: false, right: false, up: false, down: false, fire: false, release: false},
    counters: {step: 0, frame: 0},
    invincible: false,
    justEntered: 0,
    lives: 6,
    sounds: [],
    unportedHits: [],
    rooms: 0,
    record(addr) { return records[addr]; },
    setRecords(bytes) {
      for (let i = 0; i*16 < bytes.length; i++) {
        const addr = ENTITY_BASE + 16*i;
        records[addr] = bytes.subarray(i*16, i*16+16);
      }
    },
    roomWord(col, row) {
      const key = col + ',' + row;
      const lo = world.descriptor(col, row);
      return [lo, roomState[key] === undefined ? 0 : roomState[key]];
    },
    setRoomState(col, row, value) { roomState[col + ',' + row] = value; },
    seedRoomState(col, row, value) { roomState[col + ',' + row] = value; },
    enterRoom() { state.rooms++; },
    sound(name) { state.sounds.push(name); },
    unported(addr) { state.unportedHits.push(addr); },
    respawn() {},
    gameOver() { state.over = true; },
    over: false,
  };
  return state;
} // makeWorld

function loadWorldData() {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/world.json'), 'utf8'));
  return {
    descriptor(col, row) {
      if (row < 0 || row >= data.grid.rows || col < 0 || col >= data.grid.cols) { return 0; }
      return parseInt(data.descriptors[row].substr(col*2, 2), 16);
    },
  };
} // loadWorldData

function applyRope(state, bytes) {
  for (const [name, index] of ROPE_FIELDS.concat(ROPE_PREV_FIELDS)) {
    state.rope[name] = bytes[index];
  }
} // applyRope

function checkScenario(physics, worldData, scenario, options) {
  const steps = scenario.frames;
  const player = new Uint8Array(16);
  player.set(hexBytes(steps[0].rec));
  const state = makeWorld(physics, worldData, player);
  applyRope(state, hexBytes(steps[0].rope));
  const diffs = [];

  let skipped = 0;
  for (let i = 0; i < steps.length; i++) {
    const now = steps[i];
    if (!now.recOut) { skipped++; continue; }   // obsluha skoncila jinudy
    player.set(hexBytes(now.rec));
    applyRope(state, hexBytes(now.rope));
    // okolí kroku: entity, počítadla a stav místnosti z nahrávky
    state.setRecords(hexBytes(now.ents));
    state.counters.step = now.step;
    state.counters.frame = now.ula;
    state.invincible = now.invincible !== 0;
    state.justEntered = now.entered;
    state.lives = now.lives;
    state.seedRoomState(player[F.COL], player[F.ROW], now.room[1]);
    player[F.FLAGS] = hexBytes(now.rec)[F.FLAGS];
    for (const key of Object.keys(state.input)) { state.input[key] = false; }
    for (const key of now.keys) {
      const name = KEY_MAP[key];
      if (name) { state.input[name] = true; }
    }
    state.sounds.length = 0;

    physics.step(state);

    // porovnání s koncem téhož kroku v originálu
    const expected = hexBytes(now.recOut);
    const expectedRope = hexBytes(now.ropeOut);
    const wrong = [];
    for (const [name, index] of RECORD_FIELDS) {
      if (player[index] !== expected[index]) {
        wrong.push(name + ' ' + hex2(player[index]) + ' != ' + hex2(expected[index]));
      }
    }
    for (const [name, index] of ROPE_FIELDS) {
      if (state.rope[name] !== expectedRope[index]) {
        wrong.push('rope.' + name + ' ' + hex2(state.rope[name]) + ' != ' + hex2(expectedRope[index]));
      }
    }
    // Za krokem Sabremana bezi jeste entita lana ($AA4C) a teprve pak zacina
    // dalsi krok. Jak casto na ni hlavni smycka dojde, je vec casovani Z80
    // (jednou za tik pocitadla $8ED6, viz sources/docs/disasm_notes.md 13), a
    // to je na M4 – tady se kontroluje jeji **aritmetika**: vstup dalsiho kroku
    // musi odpovidat bud stavu bez jejiho kroku, nebo s jednim jejim krokem.
    const ropeEntity = state.record(ENTITY_BASE);
    const after = steps[i+1] ? hexBytes(steps[i+1].rope) : null;
    if (after && ropeEntity && ropeEntity[F.TYPE] === physics.k.ropeEntityType) {
      const before = Object.assign({}, state.rope);
      physics.stepRope(state, ropeEntity);
      const fields = ROPE_FIELDS.concat(ROPE_PREV_FIELDS);
      const matches = (rope) => fields.every(([name, index]) => rope[name] === after[index]);
      if (!matches(state.rope) && !matches(before)) {
        fields.forEach(([name, index]) => {
          if (state.rope[name] !== after[index]) {
            wrong.push('lano ' + name + ' ' + hex2(state.rope[name]) + ' != ' + hex2(after[index]));
          }
        });
      }
    }
    if (state.unportedHits.length) {
      wrong.push('nezportovany stav ' + state.unportedHits.join(','));
      state.unportedHits.length = 0;
    }
    if (wrong.length) {
      diffs.push({step: i, frame: now.frame, keys: now.keys.join(','),
                  before: now.rec, wrong});
    }
    if (options.verbose) {
      console.log('   %s %s -> %s %s', String(now.frame).padStart(5),
                  now.rec, now.recOut, wrong.length ? 'ROZDIL' : '');
    }
  }
  diffs.skipped = skipped;
  return diffs;
} // checkScenario

function main() {
  const args = process.argv.slice(2);
  const options = {verbose: args.includes('--verbose'), limit: 6, scenario: null};
  const scenarioArg = args.indexOf('--scenario');
  if (scenarioArg >= 0) { options.scenario = args[scenarioArg+1]; }
  const limitArg = args.indexOf('--limit');
  if (limitArg >= 0) { options.limit = parseInt(args[limitArg+1], 10); }

  const physicsData = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/physics.json'), 'utf8'));
  const tracesPath = path.join(ROOT, 'build/physics-traces.json');
  if (!fs.existsSync(tracesPath)) {
    console.error('chybi %s – spust PYTHONPATH=tools/vendor ./tools/tracephysics.py',
                  path.relative(ROOT, tracesPath));
    process.exit(2);
  }
  const traces = JSON.parse(fs.readFileSync(tracesPath, 'utf8'));
  const worldData = loadWorldData();
  const physics = new SabremanPhysics(physicsData);

  let steps = 0, bad = 0;
  for (const scenario of traces.scenarios) {
    if (options.scenario && scenario.name !== options.scenario) { continue; }
    const diffs = checkScenario(physics, worldData, scenario, options);
    const checked = scenario.frames.length-diffs.skipped;
    steps += checked;
    bad += diffs.length;
    console.log('%s %s %s kroku, %s rozdilnych%s  (%s)',
                diffs.length ? '!!' : '  ', scenario.name.padEnd(14),
                String(checked).padStart(4),
                String(diffs.length).padStart(3),
                diffs.skipped ? ', ' + diffs.skipped + ' mimo' : '',
                scenario.note);
    diffs.slice(0, options.limit).forEach((d) => {
      console.log('     krok %s (snimek %d, klavesy %s) zaznam %s',
                  String(d.step).padStart(3), d.frame, d.keys || '-', d.before);
      d.wrong.forEach((w) => console.log('        %s', w));
    });
    if (diffs.length > options.limit) {
      console.log('     ... a dalsich %d rozdilu', diffs.length-options.limit);
    }
  }
  console.log('\nzkontrolovano kroku: %d, rozdilnych: %d', steps, bad);
  process.exit(bad ? 1 : 0);
} // main

main();
