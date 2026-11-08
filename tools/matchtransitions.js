#!/usr/bin/env node
/**
 * Projde **všech 1222 přechodů** mezi místnostmi skutečnou fyzikou remaku (M4).
 *
 *   ./tools/matchtransitions.js [--verbose] [--side left|right|top|bottom]
 *
 * `tools/checkworld.py` kontroluje graf: že otevřená strana vede do existující
 * místnosti a že jsou strany vzájemné. Tenhle nástroj kontroluje to druhé –
 * že se přes tu hranici **opravdu projde** rutinami, které jsou zportované
 * v `app/sabremanPhysics.js`, a že se na druhé straně vstoupí na souřadnici,
 * kterou používá originál (`data/physics.json`: `enterRightX`, `enterLeftX`,
 * `enterBottomY`, `enterTopYFall`).
 *
 * Aby to bylo jedno měřítko pro všechny čtyři strany, jede se každý přechod
 * v **kotoulu** (typ `$18`): jen v něm se pohybuje vodorovně i svisle bez
 * ohledu na to, jestli má místnost podlahu – v místnosti s otevřenou podlahou
 * se totiž nedá stát (`$A5C3`) a chůzí by se bokem projít nedalo. Vodorovné
 * přechody se tedy hlídají v rutinách `$A995` a `$A8EF`, svislé v `$A9F5`
 * a `$A7E4`. Tabulka entit je při tom prázdná: kontrolují se přechody
 * a data světa, ne průchod plnou místností (na to je `matchentities.js`).
 *
 * Cíl je, aby prošly všechny. Přechod, který se nepovede, se vypíše se
 * souřadnicemi a s tím, kde Sabreman skončil.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const loadClassicScript = require(path.join(__dirname, '../app/svision/tools/classicScript.cjs'));

const ROOT = path.join(__dirname, '..');
const SabremanPhysics = loadClassicScript(path.join(ROOT, 'app/sabremanPhysics.js'));

const F = SabremanPhysics.FIELDS;
const GRID_COLS = 16, GRID_ROWS = 52;
const TUMBLE = 0x18;
const MAX_STEPS = 200;

// bit v popisném bajtu -> jak se tou stranou vyjede
const SIDES = [
  {name: 'left',   bit: 6, dcol: -1, drow: 0, x: 0x30, y: 0x60, vy: 0x00, dx: -2},
  {name: 'right',  bit: 2, dcol: 1,  drow: 0, x: 0xD0, y: 0x60, vy: 0x00, dx: 2},
  {name: 'top',    bit: 0, dcol: 0,  drow: -1, x: 0x80, y: 0x50, vy: 0xC0, dx: 0},
  {name: 'bottom', bit: 4, dcol: 0,  drow: 1,  x: 0x80, y: 0x80, vy: 0x40, dx: 0},
];

function loadWorld() {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/world.json'), 'utf8'));
  return {
    descriptor(col, row) {
      if (row < 0 || row >= GRID_ROWS || col < 0 || col >= GRID_COLS) { return 0; }
      return parseInt(data.descriptors[row].substr(col*2, 2), 16);
    },
  };
} // loadWorld

/** okolí jednoho pokusu: prázdná tabulka entit, skutečné popisné bajty */
function makeWorld(player, world) {
  const records = {};
  const roomState = {};
  for (let i = 0; i < 19; i++) { records[0x8EFA+16*i] = new Uint8Array(16); }
  records[0x8F1A] = player;
  const state = {
    player,
    rope: {tipX: 0, tipY: 0, prevTipX: 0, prevTipY: 0, swingVel: 0, accLow: 0,
           offset: 0, length: 0, lengthHigh: 0, anchorX: 0x80, anchorY: 0x24},
    input: {left: false, right: false, up: false, down: false, fire: false,
            release: false},
    counters: {step: 0, frame: 0},
    invincible: false,
    justEntered: 0,
    lives: 6,
    rooms: 0,
    record(addr) { return records[addr]; },
    roomWord(col, row) {
      const key = col + ',' + row;
      return [world.descriptor(col, row),
              roomState[key] === undefined ? 0 : roomState[key]];
    },
    setRoomState(col, row, value) { roomState[col + ',' + row] = value; },
    enterRoom() { state.rooms++; },
    sound() {},
    unported() {},
    respawn() { state.died = true; },
    gameOver() { state.died = true; },
    addLife() {},
    died: false,
    over: false,
  };
  return state;
} // makeWorld

function tryTransition(physics, world, col, row, side) {
  const player = new Uint8Array(16);
  player[F.TYPE] = TUMBLE;
  player[F.X] = side.x;
  player[F.COL] = col;
  player[F.Y] = side.y;
  player[F.ROW] = row;
  player[F.ATTR] = 0x47;
  player[F.DX] = side.dx & 0xFF;
  player[F.VY] = side.vy;
  const state = makeWorld(player, world);
  for (let step = 1; step <= MAX_STEPS; step++) {
    state.counters.frame = step;
    state.counters.step = step >> 1;
    physics.step(state);
    player[F.TYPE] = TUMBLE;                    // zůstat v kotoulu
    player[F.VY] = side.vy;                     // a držet svislou složku
    if (state.died) { return {ok: false, why: 'umrel', player}; }
    if (player[F.COL] !== col || player[F.ROW] !== row) {
      const wantCol = (col+side.dcol) & 0xFF, wantRow = (row+side.drow) & 0xFF;
      if (player[F.COL] !== wantCol || player[F.ROW] !== wantRow) {
        return {ok: false, why: 'skoncil v jine mistnosti', player, step};
      }
      return {ok: true, player, step};
    }
  }
  return {ok: false, why: 'za ' + MAX_STEPS + ' kroku neprosel', player};
} // tryTransition

function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose');
  const sideFlag = args.indexOf('--side');
  const only = sideFlag < 0 ? null : args[sideFlag+1];

  const physicsData = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'data/physics.json'), 'utf8'));
  const physics = new SabremanPhysics(physicsData);
  const k = physicsData.values;
  const world = loadWorld();

  // kde se na druhé straně vstupuje – hodnoty z obrazu hry
  const ENTRY = {
    left: {field: F.X, value: k.enterLeftXFall},
    right: {field: F.X, value: k.enterLeftX},
    top: {field: F.Y, value: k.enterBottomY},
    bottom: {field: F.Y, value: k.enterTopYFall},
  };

  let total = 0;
  const counts = {}, failures = [];
  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      const desc = world.descriptor(col, row);
      if (!desc) { continue; }
      for (const side of SIDES) {
        if (desc >> side.bit & 1) { continue; }
        const neighbour = world.descriptor(col+side.dcol, row+side.drow);
        if (!neighbour) { continue; }           // tři východy ze hry
        if (only && side.name !== only) { continue; }
        total++;
        const result = tryTransition(physics, world, col, row, side);
        counts[side.name] = (counts[side.name] || 0) + (result.ok ? 1 : 0);
        const entry = ENTRY[side.name];
        if (result.ok && result.player[entry.field] !== entry.value) {
          result.ok = false;
          result.why = 'vstoupil na ' + result.player[entry.field]
            + ', ceka se ' + entry.value;
        }
        if (!result.ok) { failures.push({col, row, desc, side, result}); }
      }
    }
  }

  console.log('prechodu %d, proslo %d, neproslo %d',
              total, total-failures.length, failures.length);
  for (const side of SIDES) {
    if (only && side.name !== only) { continue; }
    console.log('  ' + side.name.padEnd(7) + ' ' + (counts[side.name] || 0));
  }
  const shown = verbose ? failures : failures.slice(0, 15);
  for (const bad of shown) {
    const p = bad.result.player;
    console.log('  (%d,%d) desc=$%s %s: %s (skoncil col=%d row=%d x=%d y=%d)',
                bad.col, bad.row, bad.desc.toString(16).toUpperCase(),
                bad.side.name, bad.result.why,
                p[F.COL], p[F.ROW], p[F.X], p[F.Y]);
  }
  if (failures.length > shown.length) {
    console.log('  ... a dalsich %d (--verbose vypise vse)',
                failures.length-shown.length);
  }
  process.exit(failures.length ? 1 : 0);
} // main

main();
