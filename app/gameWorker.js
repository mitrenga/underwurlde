// begin code

/**
 * Underwurlde game worker — Sabreman's measured physics (M3).
 *
 * The tick is the frame rate of the original machine: 3.5 MHz / 69888 T states
 * = 50.08 Hz, because the game logic hangs off the ULA interrupt
 * (sources/docs/hw_notes.md, ZADANI chap. 1). One tick is one step of the
 * original's player routine.
 *
 * The physics itself is not here: it is a transcription of the game's own
 * routines in sabremanPhysics.js, driven by the constants tools/dumpphysics.py
 * read out of the game image (data/physics.json). This file only keeps the
 * state around it — the room table, the entity records, the rope globals, the
 * lives and the panel — and hands the result to the model.
 *
 * What the state machine works in is the machine's own coordinates: x is the
 * left edge of the sprite, y its **bottom** pixel row in screen coordinates
 * (the floor is at $9F = 159), and the room is a column and a row of the
 * 16 x 52 grid. The renderer converts; see WORKER-PROTOCOL.md.
 *
 * Where the world puts its entities, and what they do there, is
 * worldEntities.js (M4): the castle's furniture table at $6800, the caves that
 * compose themselves and remember the result, the sixteen extra lives, the
 * three guardians, the four weapon sets, and the bubbles and stalactites the
 * game keeps making as it runs. tools/matchentities.js checks that placement
 * against the original for all 598 rooms.
 *
 * What those entities do — the monsters flying and diving, the weapons being
 * picked up, carried and fired, the projectiles, the three guardians and the
 * score — is monsters.js (M5), which hangs off the same object.
 * tools/matchmonsters.js checks it step by step against the original.
 */

var query = (typeof self !== 'undefined' && self.location) ? self.location.search : '';
importScripts('sabremanPhysics.js'+query);
importScripts('worldEntities.js'+query);
importScripts('monsters.js'+query);      // M5: what the entities do

var TICK_MS = 1000*69888/3500000;     // 50.08 Hz, the ULA interrupt rate
var ROPE_ENTITY = 0x8F2A;
var PLAYER_RECORD = 0x8F1A;
var GRID_COLS = 16, GRID_ROWS = 52;

var physics = null;
var slowCounterFrames = 2;            // measured, see tick()
var state = null;
var timer = 0;
var lastTime = false;
var accumulator = 0;

/** the world Sabreman walks in: rooms, entities, rope, counters */
function newWorld(initData) {
  var descriptors = (initData.world && initData.world.descriptors) || [];
  var scene = initData.scene || {};
  var roomState = {};
  var entityData = initData.entities || null;
  // M5 hangs off the same object: data/monsters.json comes down beside it
  if (entityData && initData.monsters) { entityData.monsters = initData.monsters; }
  var placer = entityData ? new WorldEntities(entityData) : null;
  var records = {};
  var entities = [];
  if (placer) {
    records = placer.records;
    entities = placer.list;
  } else {
    // no data/entities.json: the world is empty but the physics still runs, so
    // the sandbox and the headless tests keep working
    for (var i = 0; i < 19; i++) {
      records[0x8EFA+16*i] = new Uint8Array(16);
      entities.push(records[0x8EFA+16*i]);
    }
  }
  (scene.entities || []).forEach(function (entity) {
    var slot = records[entity.address];
    if (!slot) { return; }
    (entity.record || []).forEach(function (value, index) { slot[index] = value; });
  });
  if (scene.roomState) {
    Object.keys(scene.roomState).forEach(function (key) {
      roomState[key] = scene.roomState[key];
    });
  }

  var spawn = physics.spawn();
  if (records[PLAYER_RECORD]) {
    for (var b = 0; b < 16; b++) { records[PLAYER_RECORD][b] = spawn[b]; }
    spawn = records[PLAYER_RECORD];
  }

  var world = {
    player: spawn,
    rope: {tipX: 0, tipY: 0, prevTipX: 0, prevTipY: 0, swingVel: 0, accLow: 0,
           offset: 0, length: 0, lengthHigh: 0, anchorX: 0x80, anchorY: 0x24},
    input: {left: false, right: false, up: false, down: false, fire: false,
            release: false, take: false, takeLatched: false},
    counters: {step: 0, frame: 0},
    justEntered: 0,
    lives: (initData.lives === undefined) ? 6 : initData.lives,
    sounds: [],
    unportedCount: 0,
    entered: false,
    over: false,

    placer: placer,
    record: function (address) { return records[address]; },
    entities: entities,
    roomWord: function (col, row) {
      var lo = 0;
      if (row >= 0 && row < GRID_ROWS && col >= 0 && col < GRID_COLS && descriptors[row]) {
        lo = parseInt(descriptors[row].substr(col*2, 2), 16);
      }
      var key = col+','+row;
      return [lo, roomState[key] === undefined ? 0 : roomState[key]];
    },
    setRoomState: function (col, row, value) { roomState[col+','+row] = value; },
    enterRoom: function (col, row) {
      // the physics has already put Sabreman at the entry position on the
      // other side of the border; here the room fills itself with what the
      // original puts in it ($9906 -> $EAA2 / $AF56 / $EC3A)
      if (placer) {
        placer.enterRoom(col, row, world.roomWord(col, row), world.counters);
      }
      world.entered = true;
    },
    addLife: function () {
      world.lives = bcdInc(world.lives);
      world.sound('life');
    },
    /**
     * One sound of the original ($A07D and its six siblings, M6). The name is
     * the event, not the sound: which of the seven routines it is, and which
     * variant of it, is data/sounds.json and app/beeper.js — the same split as
     * everywhere else, the worker only says what happened. `params.y` is the y
     * of whatever touched him, because the contact sound takes its pitch from
     * it ($A0F5), and the frame counter is the length of the death sound
     * ($A107 reads $5C78).
     */
    sound: function (name, params) {
      if (world.sounds.length >= 8) { return; }
      world.sounds.push({name: name, y: params ? params.y : 0,
                         frames: world.counters.frame & 0xFF});
    },
    unported: function () { world.unportedCount++; },
    // M5 — the trigger and the eagle's grip, both of which live in monsters.js
    fire: function () { if (placer && placer.fire) { placer.fire(world); } },
    fireReleased: function () {
      if (placer && placer.fireReleased) { placer.fireReleased(); }
    },
    carriedPlayer: function () {
      if (placer && placer.carriedPlayer) { placer.carriedPlayer(world, world.player); }
    },
    enterRoomFor: function (record) {
      if (placer) {
        placer.enterRoom(record[2], record[4],
                         world.roomWord(record[2], record[4]), world.counters);
      }
      world.entered = true;
    },
    score: function () { return placer && placer.scoreValue ? placer.scoreValue() : 0; },
    carrying: function () {
      return (placer && placer.carried) ? placer.carried.slice() : [0, 0, 0];
    },
    respawn: function () { world.respawned = true; },
    invincible: false,
    gameOver: function () { world.over = true; },
  };
  if (scene.col !== undefined) {
    world.player[2] = scene.col;
    world.player[4] = scene.row;
  }
  if (scene.x !== undefined) { world.player[1] = scene.x; }
  if (scene.y !== undefined) { world.player[3] = scene.y; }
  if (scene.carrying && placer && placer.carried) {
    scene.carrying.forEach(function (type, index) { placer.carried[index] = type; });
  }
  if (scene.rope) {
    Object.keys(scene.rope).forEach(function (key) { world.rope[key] = scene.rope[key]; });
  }
  // the room sets its own rope up and fills itself, exactly as the original
  // does on entering it ($9906)
  if (placer) {
    placer.placeWeapons(world.counters.frame);
    placer.enterRoom(world.player[2], world.player[4],
                     world.roomWord(world.player[2], world.player[4]),
                     world.counters);
  }
  physics.setupRoom(world);
  return world;
} // newWorld

/** the lives counter of the original is BCD ($8EDA, INC A / DAA) */
function bcdInc(value) {
  var low = (value & 0x0F)+1, high = value >> 4;
  if (low > 9) { low = 0; high++; }
  return ((high & 0x0F) << 4) | low;
} // bcdInc

function reset() {
  clearTimeout(timer);
  timer = 0;
  lastTime = false;
  accumulator = 0;
  state = {
    running: false, paused: false, headless: false,
    frame: 0, score: 0, gems: 0, lives: 6, depth: 15,
    world: null, gameOverPosted: false, dying: false
  };
} // reset

/** one step of the original: Sabreman first, then the entities after him */
function tick() {
  var s = state;
  var world = s.world;
  s.frame++;
  // The original has two counters and the game reads both: $5C78 ticks once
  // per frame, $8ED6 once per pass of the main loop that gets all the way
  // round — measured on the running game, that is about every second frame
  // (data/physics.json measured.slowCounterFrames). The tumble animation and
  // the swing damping hang off the slow one.
  world.counters.frame = s.frame;
  world.counters.step = Math.floor(s.frame/slowCounterFrames);
  world.sounds.length = 0;
  world.entered = false;

  physics.step(world);

  // The rope hanging in the room is an entity of its own ($AA4C): it grows and
  // its swing dies down. The main loop of the original only reaches the
  // entities on a full pass, so it runs at the slow counter's rate.
  var rope = world.record(ROPE_ENTITY);
  if (s.frame % slowCounterFrames === 0) {
    if (rope && rope[0] === physics.k.ropeEntityType) {
      physics.stepRope(world, rope);
    }
    // and so do all the other entities of the room, plus the two generators
    // that keep making bubbles and stalactites (M4, worldEntities.js)
    if (world.placer) {
      // $94E2 — the take/drop half-row is read on the same pass of the main
      // loop that reaches the entities, and the pulse it leaves lasts exactly
      // that one pass: that is what makes one press move the weapons one place
      // A press that came and went between two of these passes would be lost
      // altogether — the original reads the half-row itself, the remake only
      // hears about it when the browser sends a message. So a fresh press is
      // latched ('controls' below) and let through here, on the pass that
      // steps the entities, even when the key is already up again.
      if (world.placer.takeKey) {
        world.placer.takeKey(world.input.take || world.input.takeLatched);
        world.input.takeLatched = false;
      }
      world.placer.step(world);
      world.placer.tickGems(world);
    }
  }

  world.justEntered = world.entered ? 1 : 0;
  s.score = world.score();
  s.gems = world.placer ? world.placer.gems : 0;
  s.lives = world.lives;
  s.depth = world.player[4]+1;      // DEPTH 15 in the start room on row 14
  s.dying = physics.stateOf(world.player[0]) === 'death';
  if (world.over && !s.gameOverPosted) {
    s.gameOverPosted = true;
  }
} // tick

function postFrame() {
  var s = state;
  var world = s.world;
  var player = world.player;
  var hanging = physics.stateOf(player[0]) === 'rope';
  postMessage({
    id: 'frame',
    frame: s.frame,
    score: s.score,
    gems: s.gems,
    depth: s.depth,
    lives: Math.max(0, s.lives),
    dying: s.dying,
    sabreman: {
      x: player[1], y: player[3], type: player[0],
      state: physics.stateOf(player[0]), dir: physics.facing(player[0]),
      col: player[2], row: player[4], vy: player[9], dx: player[6]
    },
    carrying: world.carrying(),
    entities: world.placer
      ? world.placer.visible(player[2], player[4])
      : world.entities.filter(function (rec) {
        return rec !== player && rec[0] !== 0
          && rec[2] === player[2] && rec[4] === player[4];
      }).map(function (rec) {
        return {type: rec[0], x: rec[1], y: rec[3], attr: rec[5]};
      }),
    rope: {
      visible: hanging || (world.record(ROPE_ENTITY)[0] === physics.k.ropeEntityType),
      anchorX: world.rope.anchorX, anchorY: world.rope.anchorY,
      tipX: world.rope.tipX, tipY: world.rope.tipY
    },
    sounds: world.sounds.slice(),
    state: s.gameOverPosted ? 'gameOver' : 'game'
  });
  if (s.gameOverPosted && s.running) {
    postMessage({id: 'gameOver', score: s.score});
    s.running = false;
    clearTimeout(timer);
  }
} // postFrame

function loop() {
  var now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
  if (lastTime === false) {
    lastTime = now;
  }
  accumulator = Math.min(250, accumulator+now-lastTime);
  lastTime = now;
  var ticked = false;
  while (accumulator >= TICK_MS) {
    tick();
    accumulator -= TICK_MS;
    ticked = true;
  }
  if (ticked) {
    postFrame();
  }
  if (state.running && !state.paused) {
    timer = setTimeout(loop, Math.max(1, TICK_MS-accumulator));
  }
} // loop

reset();

onmessage = function (event) {
  var msg = event.data;
  switch (msg.id) {
    case 'init':
      var initData = msg.initData || {};
      reset();
      if (!initData.physics) {
        postMessage({id: 'error', message: 'chybi data/physics.json (tools/dumpphysics.py)'});
        return;
      }
      physics = new SabremanPhysics(initData.physics);
      slowCounterFrames = (initData.physics.measured
                           && initData.physics.measured.slowCounterFrames) || 2;
      state.headless = !!initData.headless;
      state.lives = (initData.lives === undefined) ? 6 : initData.lives;
      state.world = newWorld(initData);
      state.depth = state.world.player[4]+1;
      state.running = true;
      if (!state.headless) {
        loop();
      }
      postFrame();
      break;
    case 'controls':
      var input = state.world ? state.world.input : null;
      if (input) {
        input.left = !!msg.left;
        input.right = !!msg.right;
        input.up = !!msg.up;
        input.down = !!msg.down;
        input.fire = !!msg.fire;
        input.release = !!msg.drop;
        // a press is remembered until the entities step; see tick()
        if (msg.take && !input.take) { input.takeLatched = true; }
        input.take = !!msg.take;
      }
      break;
    case 'pause':
      state.paused = true;
      clearTimeout(timer);
      break;
    case 'continue':
      if (state.running) {
        state.paused = false;
        lastTime = false;
        clearTimeout(timer);
        if (!state.headless) {
          loop();
        }
      }
      break;
    case 'tick':
      if (state.running) {
        tick();
        postFrame();
      }
      break;
    case 'reset':
      reset();
      break;
  }
};
