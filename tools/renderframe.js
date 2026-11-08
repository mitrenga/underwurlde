#!/usr/bin/env node
/**
 * Vykreslí snímky hry do PNG – kontrola očima, že fyzika, pózy, lano
 * i entity sedí na obrazovce.
 *
 *   ./tools/renderframe.js [--scene sandbox|world|cave] [--out build/gfx]
 *                          [--room 9,14] [--frames 1,20,40]
 *
 * `sandbox` je scéna M3 (jeskyně s lanem a dvěma bublinami, prázdná tabulka
 * entit), `world` startovní hradní místnost a `cave` jeskyni s otevřenou
 * podlahou – ty dvě už se plní samy z `data/entities.json` (M4), takže na
 * snímcích je vidět nábytek, katapult, jeskynní rostliny a bubliny.
 *
 * Běží celý řetěz remaku bez prohlížeče: `app/gameWorker.js` (fyzika z
 * `app/sabremanPhysics.js` a `data/physics.json`) a `app/screenComposer.js`
 * (obraz místnosti z `data/rooms.json`, pózy z `data/spriteframes.json`,
 * panel z `data/font.json`). Výstup je hrací plocha 256 × 176 s panelem
 * nahoře, tedy přesně to, co uvidí hráč.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const url = require('url');
const vm = require('vm');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const load = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', name+'.json'), 'utf8'));

function writePNG(file, rgba, width, height) {
  const raw = Buffer.alloc((width*3+1)*height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    raw[pos++] = 0;
    for (let x = 0; x < width; x++) {
      const source = (y*width+x)*4;
      raw[pos++] = rgba[source];
      raw[pos++] = rgba[source+1];
      raw[pos++] = rgba[source+2];
    }
  }
  const chunk = (tag, payload) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(payload.length);
    const body = Buffer.concat([Buffer.from(tag), payload]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) : crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, {level: 9})),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

let table = null;
function crc32(buffer) {
  if (!table) {
    table = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) { c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); }
      table[i] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buffer.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buffer[i]) & 0xFF];
  }
  return (crc ^ -1) >>> 0;
}

function startWorker(onMessage) {
  const sandbox = {
    console, performance: {now: () => Date.now()},
    setTimeout: () => 0, clearTimeout: () => {},
    postMessage: onMessage,
    importScripts(name) {
      vm.runInContext(fs.readFileSync(path.join(ROOT, 'app', name.split('?')[0]), 'utf8'),
                      context, {filename: name});
    },
  };
  sandbox.self = sandbox;
  sandbox.location = {search: ''};
  const context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'app/gameWorker.js'), 'utf8'), context,
                  {filename: 'gameWorker.js'});
  return {send: (message) => sandbox.onmessage({data: message})};
}

async function main() {
  const args = process.argv.slice(2);
  const outArg = args.indexOf('--out');
  const out = outArg >= 0 ? args[outArg+1] : path.join(ROOT, 'build/gfx');
  const framesArg = args.indexOf('--frames');
  const sceneArg = args.indexOf('--scene');
  const sceneName = sceneArg >= 0 ? args[sceneArg+1] : 'sandbox';
  const roomArg = args.indexOf('--room');
  const defaults = {sandbox: '1,20,30,45,60,75', world: '1,20,60,120',
                    cave: '1,40,80,160,240',
                    // M5: nesená zbraň a výstřel, a místnost strážce s východem
                    weapon: '1,60,120,200', guardian: '1,40,100'};
  const wanted = (framesArg >= 0 ? args[framesArg+1]
                  : (defaults[sceneName] || defaults.sandbox))
                 .split(',').map((value) => parseInt(value, 10));

  global.atob = (data) => Buffer.from(data, 'base64').toString('binary');
  // screenComposer.js importuje ZXVideoRAM ze svision, takže hlavička potřebuje
  // window.srcVersion – shim se musí načíst jako první (R-001)
  await import(url.pathToFileURL(path.join(ROOT, 'app/svision/tools/nodeEnv.mjs')).href);
  const { ScreenComposer } = await import(url.pathToFileURL(path.join(ROOT, 'app/screenComposer.js')).href);
  const { ZXVideoRAM } = await import(url.pathToFileURL(path.join(ROOT, 'app/svision/js/platform/canvas2D/zx/zxVideoRAM.js')).href);

  const physics = load('physics');
  const world = {descriptors: load('world').descriptors};
  const rooms = load('rooms');
  const worldData = load('world');
  const ROOMS = {sandbox: [7, 16], world: null, cave: [7, 18],
                 weapon: null, guardian: [8, 17]};
  const spawn = physics.values.spawnRecord;
  const place = roomArg >= 0
    ? args[roomArg+1].split(',').map((n) => parseInt(n, 10))
    : (ROOMS[sceneName] || [spawn[2], spawn[4]]);
  const col = place[0], row = place[1];
  const variant = parseInt(worldData.variants[row].substr(col*2, 2), 16);
  const image = rooms.variants[variant];

  const render = new ScreenComposer({width: rooms.width, height: rooms.height,
                                   bitmap: image.bitmap, attributes: image.attributes},
                                  load('font'), load('sprites'), load('spriteframes'));

  let last = null;
  const worker = startWorker((message) => { if (message.id === 'frame') { last = message; } });
  const scene = (sceneName === 'sandbox')
    ? {col: col, row: row, x: 0x60, y: 0x9F, roomState: {'7,16': 0x08},
       entities: [{address: 0x8F5A, record: [0x58, 0x40, col, 0x90, row, 0x45]},
                  {address: 0x8F6A, record: [0x58, 0x98, col, 0xA0, row, 0x45]}]}
    : (sceneName === 'weapon')
      // katapult rovnou v ruce a kámen za letu ($E9FD, $B753)
      ? {col: col, row: row, x: spawn[1], y: spawn[3], carrying: [0x68, 0x69, 0x6B],
         entities: [{address: 0x8EFA,
                     record: [0x38, 0x90, col, 0x80, row, 0x47, 0, 0,
                              0x50, 0xC0, 0, 0, 0, 0, 0, 1]}]}
      : {col: col, row: row, x: spawn[1], y: spawn[3]};
  worker.send({id: 'init', initData: {headless: true, lives: 6, physics, world,
    entities: (sceneName === 'sandbox') ? null : load('entities'),
    monsters: (sceneName === 'sandbox') ? null : load('monsters'), scene}});

  fs.mkdirSync(out, {recursive: true});
  // the panel and the room composed into one memory, the way the machine holds them
  const memory = new ZXVideoRAM();
  const screen = new Uint8ClampedArray(256*192*4);
  for (let frame = 0; frame <= Math.max.apply(null, wanted); frame++) {
    worker.send({id: 'tick'});
    if (wanted.indexOf(frame) < 0) { continue; }
    // the room replaces the whole memory, so the panel goes in after it
    render.composeInto(memory, {sabreman: last.sabreman, rope: last.rope,
                                entities: last.entities});
    render.composePanelInto(memory, {score: last.score, gems: last.gems,
                                     depth: last.depth, lives: last.lives,
                                     carrying: last.carrying});
    memory.paint(screen, false);
    const file = path.join(out, sceneName+String(frame).padStart(3, '0')+'.png');
    writePNG(file, screen, 256, 192);
    console.log('%s  %s x=%d y=%d %s', path.relative(ROOT, file),
                String(frame).padStart(3), last.sabreman.x, last.sabreman.y,
                last.sabreman.state);
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
