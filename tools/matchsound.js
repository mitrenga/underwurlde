#!/usr/bin/env node
/**
 * Porovná **zvuk remaku se zvukem originálu** pulz po pulzu (M6).
 *
 *   ./tools/matchsound.js [--verbose] [--scenario jmeno]
 *
 * Vstup: `build/sound-traces.json` – skutečné zápisy na port `$FE` z hrajícího
 * originálu (`tools/tracesound.py`), rozdělené na shluky a přiřazené k místu,
 * které je zahrálo. Proti každému shluku se pustí `app/beeper.js` a
 * `data/sounds.json`, tedy **kód a data, která jdou do prohlížeče**, a porovná
 * se délka každého pulzu v T-stavech.
 *
 * Cíl je nula rozdílů – obdoba `matchphysics.js` a `matchmonsters.js` pro zvuk.
 *
 * Jedna věc se reprodukovat nedá a nástroj ji hlásí zvlášť, neschovává:
 * originál hraje zvuk **uvnitř herního kroku a se zapnutým přerušením**, takže
 * když do zvuku spadne přerušení ULA (jednou za 69888 T), ten pulz je o dobu
 * obsluhy delší. Pozná se to spolehlivě: rozdíl smí být jen v tom pulzu, přes
 * který hranice snímku přechází. Remake hraje zvuk zvlášť v audio bufferu, tam
 * se nic takového stát nemůže.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const url = require('url');

const ROOT = path.join(__dirname, '..');
const TRACES = path.join(ROOT, 'build/sound-traces.json');
const SOUNDS = path.join(ROOT, 'data/sounds.json');

function parseArgs(argv) {
  const args = {verbose: false, scenarios: null};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--verbose') { args.verbose = true; }
    else if (argv[i] === '--scenario') { (args.scenarios = args.scenarios || []).push(argv[++i]); }
    else { throw new Error('neznamy prepinac '+argv[i]); }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const traces = JSON.parse(fs.readFileSync(TRACES, 'utf8'));
  const sounds = JSON.parse(fs.readFileSync(SOUNDS, 'utf8'));

  // app/beeper.js je ES modul a importuje se přímo ze zdroje (R-001)
  const { Beeper } = await import(url.pathToFileURL(path.join(ROOT, 'app/beeper.js')).href);
  const beeper = new Beeper(sounds);

  // rutina -> jmeno zvuku, a k nemu jmeno udalosti, kterou remake posila
  const byRoutine = {};
  Object.keys(sounds.sounds).forEach((name) => {
    byRoutine[sounds.sounds[name].routine] = name;
  });
  const eventOf = {};
  sounds.events.forEach((entry) => {
    if (entry.sound && !(entry.sound in eventOf)) { eventOf[entry.sound] = entry.name; }
  });

  const frameDuration = traces.frameDuration;
  let bursts = 0, pulses = 0, diffs = 0, stretched = 0, skipped = 0;
  const names = args.scenarios || Object.keys(traces.scenarios);

  for (const scenario of names) {
    if (!(scenario in traces.scenarios)) { throw new Error('neznamy scenar '+scenario); }
    for (const burst of traces.scenarios[scenario].bursts) {
      const name = byRoutine[burst.routine];
      if (!name) { skipped++; continue; }
      const params = burst.params || {};
      // krok si vybira vysku podle vlastniho pocitadla – nastavi se na to,
      // co v tu chvili mel original, a vyber udela kod remaku
      if (name === 'step') { beeper.stepCounter = (params.stepCounter+255) & 0xFF; }
      const train = beeper.train(eventOf[name], params);
      if (!train) {
        diffs++;
        console.log('%s: %s (%s) — remake mlci, original hral %d pulzu',
                    scenario, name, burst.call, burst.pulses.length);
        continue;
      }
      bursts++;
      if (train.sound !== name) {
        diffs++;
        console.log('%s: %s (%s) — remake hraje %s', scenario, name, burst.call, train.sound);
        continue;
      }
      if (train.startLevel !== burst.startLevel) {
        diffs++;
        console.log('%s: %s — uroven prvniho pulzu %d, original %d',
                    scenario, name, train.startLevel, burst.startLevel);
      }
      if (train.pulses.length !== burst.pulses.length) {
        diffs++;
        console.log('%s: %s (%s) varianta %s — %d pulzu, original %d',
                    scenario, name, burst.call, train.variant,
                    train.pulses.length, burst.pulses.length);
      }
      let at = burst.start;
      const count = Math.min(train.pulses.length, burst.pulses.length);
      for (let i = 0; i < count; i++) {
        pulses++;
        const mine = train.pulses[i], his = burst.pulses[i];
        if (mine !== his) {
          // preruseni ULA: hranice snimku prochazi zrovna timhle pulzem
          const crosses = Math.floor(at/frameDuration)
                       !== Math.floor((at+his)/frameDuration);
          if (crosses && his > mine) {
            stretched++;
          } else {
            diffs++;
            console.log('%s: %s[%s] (%s) pulz %d: remake %d, original %d',
                        scenario, name, train.variant, burst.call, i, mine, his);
          }
        }
        at += his;
      }
      if (args.verbose) {
        console.log('%-8s %-6s[%s] %-8s %3d pulzu, %5.1f ms',
                    scenario, name, train.variant, burst.call,
                    train.pulses.length, Beeper.duration(train));
      }
    }
  }

  console.log('%d shluku, %d pulzu, %d rozdilu (%d pulzu natazenych prerusenim'
              + ' ULA, to je casovani Z80, ne zvuk)%s',
              bursts, pulses, diffs, stretched,
              skipped ? ', '+skipped+' shluku bez znameho zvuku' : '');
  process.exit(diffs === 0 ? 0 : 1);
}

main().catch((error) => { console.error(error); process.exit(2); });
