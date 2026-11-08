#!/usr/bin/env node
/**
 * Projde celou smyčku workeru bez prohlížeče (M3).
 *
 *   ./tools/runworker.js [--frames N] [--verbose]
 *
 * `app/gameWorker.js` se spustí v atrapě prostředí workeru (importScripts,
 * postMessage, setTimeout) v režimu `headless`, kde tiká na vyžádání, a projde
 * se v něm scéna sandboxu M3: chůze, skok, chycení lana, puštění lana a pád
 * propastí až do smrti a přes všechny životy do game over.
 *
 * Kontroluje se to, co má M3 slíbeno: že se dá chodit, skákat, chytit lano,
 * zabít pádem a že po šesti životech přijde game over. Konstanty se přitom
 * berou z `data/physics.json`, takže když se změní obraz hry nebo extrakce,
 * spadne to tady, ne až v prohlížeči.
 *
 * M4 k tomu přidal scény ve **skutečném světě** (`data/entities.json`):
 * startovní hradní místnost, ve které stojí nábytek i katapult, jeskyni
 * s otevřenou podlahou, ze které stoupají bubliny, a sebrání drahokamu
 * s odpočtem nezranitelnosti, který panel ukazuje jako `GEMS`.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

function loadDataFile(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', name+'.json'), 'utf8'));
}

/** spustí gameWorker.js v atrapě workeru a vrátí jeho rozhraní */
function startWorker(onMessage) {
  const sandbox = {
    console,
    performance: {now: () => Date.now()},
    setTimeout: () => 0,
    clearTimeout: () => {},
    postMessage: onMessage,
    importScripts(name) {
      const file = name.split('?')[0];
      vm.runInContext(fs.readFileSync(path.join(ROOT, 'app', file), 'utf8'), context, {filename: file});
    },
  };
  sandbox.self = sandbox;
  sandbox.location = {search: ''};
  const context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'app/gameWorker.js'), 'utf8'), context,
                  {filename: 'gameWorker.js'});
  return {
    send(message) { sandbox.onmessage({data: message}); },
    context: sandbox,
  };
}

/** scéna sandboxu — táž jako v roomModel.buildScene() */
function sandboxScene(physics, withRope) {
  const col = 7, row = 16;
  return {
    col: col, row: row, x: 0x60, y: 0x9F,
    // bit 3 druhého bajtu záznamu místnosti = v místnosti visí lano ($AE81);
    // bez něj Sabremana při pádu nic nezachytí
    roomState: withRope === false ? {} : {'7,16': 0x08},
    entities: [
      {address: 0x8F5A, record: [0x58, 0x40, col, 0x90, row, 0x45]},
      {address: 0x8F6A, record: [0x58, 0x98, col, 0xA0, row, 0x45]},
    ],
  };
}

/**
 * Scénáře. Klávesy se drží podle stavu, ve kterém Sabreman právě je, takže
 * scénář nezáleží na tom, kolik snímků co trvá.
 */
/** startovní místnost světa – ta, ve které hra začíná ($AA3C) */
function worldScene(physics, extra) {
  const spawn = physics.values.spawnRecord;
  const scene = {col: spawn[2], row: spawn[4], x: spawn[1], y: spawn[3]};
  if (extra) { scene.entities = extra(scene); }
  return scene;
}

const SCENARIOS = [
  {
    name: 'chuze a skok',
    rope: false,
    note: 'chůze vpravo, skok z místa a doskok',
    lives: 6, frames: 60, x: 0x30,
    keys: (frame, man, press) => {
      press('right', frame < 30);
      press('up', frame >= 30 && frame < 33);
    },
    expect: {states: ['walkRight', 'crouch', 'jump'], deaths: 0, gameOver: false},
  },
  {
    name: 'lano',
    note: 'v místnosti bez podlahy Sabreman sám odskočí, chytí lano, '
        + 'rozhoupá se a pustí se',
    lives: 6, frames: 400, x: 0x60,
    keys: (frame, man, press, seen) => {
      var hanging = man.state === 'rope';
      press('right', hanging && seen.hanging < 40);
      press('drop', hanging && seen.hanging >= 40);
    },
    expect: {states: ['rope', 'jump'], deaths: 0, gameOver: false},
  },
  {
    name: 'smrt padem',
    rope: false,
    note: 'skok do kulisy hodí Sabremana do kotoulu a v kotoulu ho pád přes '
        + 'dvě místnosti zabije (v jedné místnosti se smrtelná rychlost nasbírat nedá)',
    lives: 6, frames: 200, x: 0x60,
    keys: (frame, man, press) => {
      press('right', frame < 40);
      press('up', frame >= 40 && frame < 43);
    },
    expect: {states: ['fall', 'death'], deaths: 1, gameOver: false},
  },
  {
    name: 'game over',
    rope: false,
    note: 'po posledním životě přijde game over – panel ukazuje šest životů, '
        + 'ale hra skončí až na pokusu, kdy je počítadlo na nule ($E7EC: DEC, '
        + 'a teprve když jde pod nulu, je konec), tedy až po sedmé smrti',
    lives: 0, frames: 400, x: 0x60,
    keys: (frame, man, press) => {
      press('right', frame < 40);
      press('up', frame >= 40 && frame < 43);
    },
    expect: {states: ['death'], deaths: 0, gameOver: true},
  },
  {
    name: 'svet a nabytek',
    world: true,
    note: 'startovní hradní místnost se plní sama z tabulky $6800: stojí v ní '
        + 'nábytek a katapult, do kterých se nedá projít',
    lives: 6, frames: 200,
    keys: (frame, man, press) => { press('right', true); },
    expect: {states: ['walkRight'], deaths: 0, gameOver: false,
             entityTypes: [0x68], minEntities: 2},
  },
  {
    name: 'bubliny',
    world: true,
    room: [7, 16],
    note: 'v jeskyni s otevřenou podlahou stoupají vulkanické bubliny '
        + '($E05F) – na těch se dá jako na jediném kromě podlahy stát',
    lives: 6, frames: 900,
    keys: () => {},
    expect: {states: [], deaths: 0, gameOver: false,
             entityTypes: [0x58]},
  },
  {
    name: 'drahokam',
    world: true,
    gem: true,
    room: [7, 16],
    note: 'sebraný drahokam nastaví odpočet nezranitelnosti na $50 a panel ho '
        + 'ukazuje jako GEMS; odpočet pak ubývá každý čtvrtý tik',
    lives: 6, frames: 200,
    keys: (frame, man, press) => { press('right', frame > 4 && frame < 40); },
    expect: {states: ['walkRight'], deaths: 0, gameOver: false,
             gems: 0x50},
  },
  {
    name: 'zbran a strelba',
    world: true,
    take: true,
    note: 'katapult ve startovní místnosti se dá sebrat klávesou vzít/položit '
        + '(nese se v panelu) a pak se z něj střílí – projektil je kámen $38 '
        + '(tabulka $B753), a co zasáhne, to přijde o život a přidá body',
    lives: 6, frames: 900,
    keys: (frame, man, press) => {
      // katapult leží ve startovní místnosti nalevo od Sabremana ($E9FD)
      press('left', frame > 4 && man.x > 0x24);
      press('take', frame >= 40 && frame < 44);
      press('fire', frame >= 60);
    },
    expect: {states: ['walkLeft'], deaths: 0, gameOver: false,
             carrying: 0x68, entityTypes: [0x38]},
  },
  {
    name: 'oba kratery',
    world: true,
    room: [2, 16],
    note: 'jeskyně s uzavřenou podlahou má dva krátery typu $54 (tabulka '
        + '$B7AB) a bubliny musí stoupat z obou – rychlost dýchání se počítá '
        + 'z adresy záznamu kráteru ($E0BA), ne z bublinového slotu, který si '
        + 'kráter našel',
    lives: 6, frames: 2000,
    keys: () => {},
    expect: {states: [], deaths: 0, gameOver: false,
             bubbleX: [0x40+0x0C, 0xA0+0x0C]},
  },
  {
    name: 'kratky stisk vzit',
    world: true,
    take: true,
    note: 'vzít/položit je krátký stisk, ne držení: i když klávesa jde dolů '
        + 'a hned nahoru mezi dvěma průchody, na kterých se krokují entity '
        + '($94E2), pulz se nesmí ztratit – proto ho worker zapamatuje',
    lives: 6, frames: 140,
    keys: (frame, man, press) => {
      press('left', frame > 4 && man.x > 0x28);
      // stisk a puštění v jednom snímku – v prohlížeči se to takhle stane,
      // když obě zprávy dojdou mezi dvěma tiky
      if (frame === 61) { press('take', true); press('take', false); }
    },
    expect: {states: ['walkLeft'], deaths: 0, gameOver: false,
             carrying: 0x68},
  },
  {
    name: 'strazce a vychod',
    world: true,
    room: [8, 17],
    note: 'v místnosti strážce je místo nábytku východ ze hry (typ $88) a sám '
        + 'strážce ($84); katapult ho nezabije, protože jeho kámen se do '
        + 'párování $ECFA vůbec nedostane (je pod $6C)',
    lives: 6, frames: 200,
    keys: () => {},
    expect: {states: [], deaths: 0, gameOver: false,
             entityTypes: [0x84, 0x88]},
  },
];

function runScenario(scenario, physics, world, entities, verbose) {
  let last = null;
  let gameOver = false;
  const worker = startWorker((message) => {
    if (message.id === 'frame') { last = message; }
    if (message.id === 'gameOver') { gameOver = true; }
    if (message.id === 'error') { throw new Error(message.message); }
  });
  let scene;
  if (scenario.world) {
    scene = worldScene(physics);
    if (scenario.room) {
      scene.col = scenario.room[0];
      scene.row = scenario.room[1];
      scene.x = 0x60;
      scene.y = 0x9F;
    }
    if (scenario.gem) {
      // drahokam přímo pod Sabremanem – rutina $E751 ho sebere při doteku
      scene.entities = [{address: 0x8FBA,
                         record: [0x64, scene.x+4, scene.col, scene.y,
                                  scene.row, 0x45]}];
    }
  } else {
    scene = sandboxScene(physics, scenario.rope);
    scene.x = scenario.x;
  }
  // Scény sandboxu jedou **bez** dat entit: ověřují smyčku fyziky (M3) v prázdné
  // místnosti. Kdyby se do nich svět naplnil, Sabreman by dosedl na bublinu
  // a smrtelný pád by se nekonal – proto entity dostávají jen scény M4.
  worker.send({id: 'init', initData: {
    headless: true, lives: scenario.lives, physics, world, scene,
    entities: scenario.world ? entities : null,
    monsters: scenario.world ? loadDataFile('monsters') : null}});
  if (!last) { throw new Error('worker neposlal prvni snimek'); }

  const controls = {left: false, right: false, up: false, down: false,
                    fire: false, drop: false, take: false};
  const press = (key, value) => {
    value = !!value;
    if (controls[key] === value) { return; }
    controls[key] = value;
    worker.send(Object.assign({id: 'controls'}, controls));
  };
  const seen = {states: {}, deaths: 0, maxVy: 0, hanging: 0, rooms: {},
                entityTypes: {}, maxEntities: 0, maxGems: 0, bubbleX: {},
                sounds: {}};
  let lives = last.lives;

  for (let frame = 0; frame < scenario.frames; frame++) {
    scenario.keys(frame, last.sabreman, press, seen);
    worker.send({id: 'tick'});
    const man = last.sabreman;
    seen.states[man.state] = (seen.states[man.state] || 0)+1;
    seen.hanging = (man.state === 'rope') ? seen.hanging+1 : 0;
    seen.rooms[man.col+','+man.row] = true;
    (last.entities || []).forEach((entity) => {
      seen.entityTypes[entity.type] = (seen.entityTypes[entity.type] || 0)+1;
      // bublina stoupá svisle, takže x říká, ze kterého kráteru vyšla
      if (entity.type >= 0x58 && entity.type <= 0x5B) {
        seen.bubbleX[entity.x] = (seen.bubbleX[entity.x] || 0)+1;
      }
    });
    // M6: co worker za tu scénu pískl (data/sounds.json rozhodne, čím)
    (last.sounds || []).forEach((item) => {
      seen.sounds[item.name] = (seen.sounds[item.name] || 0)+1;
    });
    seen.maxEntities = Math.max(seen.maxEntities, (last.entities || []).length);
    seen.maxGems = Math.max(seen.maxGems, last.gems || 0);
    seen.maxScore = Math.max(seen.maxScore || 0, last.score || 0);
    (last.carrying || []).forEach((type) => {
      if (type) { seen.carrying = (seen.carrying || {}); seen.carrying[type] = true; }
    });
    if (man.vy < 0x80 && man.vy > seen.maxVy) { seen.maxVy = man.vy; }
    if (last.lives < lives) {
      seen.deaths++;
      lives = last.lives;
    }
    if (verbose) {
      console.log('   %s x=%s y=%s vy=%s %s mistnost %d,%d zivotu %d',
                  String(frame).padStart(4), String(man.x).padStart(3),
                  String(man.y).padStart(3), String(man.vy).padStart(3),
                  man.state.padEnd(9), man.col, man.row, last.lives);
    }
    if (gameOver) { break; }
  }
  return {seen, gameOver, lives, rooms: Object.keys(seen.rooms).length};
}

function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose');
  const only = args.indexOf('--scenario') >= 0 ? args[args.indexOf('--scenario')+1] : null;
  const physics = loadDataFile('physics');
  const world = {descriptors: loadDataFile('world').descriptors};
  const entities = loadDataFile('entities');

  let bad = 0;
  for (const scenario of SCENARIOS) {
    if (only && scenario.name !== only) { continue; }
    const result = runScenario(scenario, physics, world, entities, verbose);
    const problems = [];
    scenario.expect.states.forEach((state) => {
      if (!result.seen.states[state]) { problems.push('chybi stav '+state); }
    });
    (scenario.expect.entityTypes || []).forEach((type) => {
      const seen = Object.keys(result.seen.entityTypes)
        .some((t) => (t & 0xFC) === (type & 0xFC));
      if (!seen) {
        problems.push('chybi entita typu $'+type.toString(16).toUpperCase());
      }
    });
    if (scenario.expect.minEntities
        && result.seen.maxEntities < scenario.expect.minEntities) {
      problems.push('entit nejvic '+result.seen.maxEntities+', ceka se '
                    +scenario.expect.minEntities);
    }
    if (scenario.expect.gems && result.seen.maxGems !== scenario.expect.gems) {
      problems.push('GEMS nejvic $'+result.seen.maxGems.toString(16).toUpperCase()
                    +', ceka se $'+scenario.expect.gems.toString(16).toUpperCase());
    }
    (scenario.expect.bubbleX || []).forEach((x) => {
      if (!result.seen.bubbleX[x]) {
        problems.push('z krateru na x=$'+x.toString(16).toUpperCase()
                      +' nestoupla ani jedna bublina');
      }
    });
    if (scenario.expect.carrying
        && !(result.seen.carrying || {})[scenario.expect.carrying]) {
      problems.push('nenese zbran $'
                    +scenario.expect.carrying.toString(16).toUpperCase());
    }
    if (result.seen.deaths < scenario.expect.deaths) {
      problems.push('smrti '+result.seen.deaths+', ceka se '+scenario.expect.deaths);
    }
    if (result.gameOver !== scenario.expect.gameOver) {
      problems.push('game over '+result.gameOver+', ceka se '+scenario.expect.gameOver);
    }
    bad += problems.length;
    console.log('%s %s  stavy: %s', problems.length ? '!!' : '  ',
                scenario.name.padEnd(12),
                Object.keys(result.seen.states).map((k) => k+':'+result.seen.states[k]).join(' '));
    console.log('     mistnosti %d, nejvyssi rychlost padu $%s (smrtelna od $%s), smrti %d, game over %s',
                result.rooms, result.seen.maxVy.toString(16).toUpperCase(),
                physics.values.deathVelocity.toString(16).toUpperCase(),
                result.seen.deaths, result.gameOver ? 'ano' : 'ne');
    const heard = Object.keys(result.seen.sounds)
      .map((name) => name+' x'+result.seen.sounds[name]).join(', ');
    console.log('     zvuky: %s', heard || 'zadne');
    const types = Object.keys(result.seen.entityTypes)
      .map((t) => '$'+Number(t).toString(16).toUpperCase()).join(' ');
    console.log('     entity v mistnosti: %s (nejvic %d naraz), GEMS nejvic $%s, skore %d, nese %s',
                types || 'zadne', result.seen.maxEntities,
                result.seen.maxGems.toString(16).toUpperCase(),
                result.seen.maxScore || 0,
                Object.keys(result.seen.carrying || {})
                  .map((t) => '$'+Number(t).toString(16).toUpperCase())
                  .join(' ') || 'nic');
    console.log('     %s', scenario.note);
    problems.forEach((problem) => console.log('     CHYBA: %s', problem));
  }
  console.log(bad ? '\nsmycka workeru NEPROSLA' : '\nsmycka workeru: v poradku');
  process.exit(bad ? 1 : 0);
}

main();
