// begin code

/**
 * Underwurlde — what the world puts in each room, and what it does there (M4).
 *
 * This is a transcription of the original's own placement code, driven by the
 * data tools/dumpentities.py read out of the game image (data/entities.json).
 * Nothing here is invented: tools/traceentities.py records what the original's
 * own room-entry routine leaves in the entity table, in a simulator, for **all
 * 598 rooms**, and tools/matchentities.js replays this file against it byte for
 * byte — 1651 checks, zero differences (sources/docs/disasm_notes.md chap. 14).
 *
 * The four ways the world gets filled, and they are all different:
 *
 * - **the castle (rows 0-15) has a real table**: $6800-$6FFF, 8 bytes per
 *   room, four entities of two bytes each — a type and a packed position
 *   ($EAA2). 683 pieces of furniture across 242 rooms.
 * - **the caves (rows 16-51) have none**: $AF56 composes the room out of its
 *   descriptor byte and out of (column + row), and for a room with an open
 *   floor it *generates* the room's state on the first visit ($E714) into a
 *   second per-room table at $6000 — and remembers it from then on. That is
 *   why the caves differ from game to game but stay put within one game.
 * - **sixteen extra lives and three guardians have a coordinate table**
 *   ($EDC4 and $EDF4, three bytes each: column, row, taken). The extra life
 *   is placed *on top of* whatever entity the room already has.
 * - **the four weapons come from four ready-made sets** of 32 bytes at $E9FD,
 *   picked by (FRAMES >> 1) & 3 — the catapult sits in the same place in all
 *   four, the other three move. That is the "weapons are arranged in different
 *   places most games" of the period tips, and it is not a random scatter.
 *
 * On top of that the game keeps adding entities as it runs: **volcanic
 * bubbles** rise out of an open floor ($E05F) and out of a cave plant of type
 * $54 ($E0A9), and **stalactites** drop from a closed cave ceiling ($DF58).
 *
 * Coordinates are the machine's: x is the left edge of the sprite, y its
 * bottom pixel row (the floor of a room is $9F). Types are the original's, so
 * a type is also the index into the sprite table — see WORKER-PROTOCOL.md.
 *
 * What is deliberately not here: the monsters, the weapons' behaviour, the
 * guardians' fight and the scoring. Those are M5. The generator that fills the
 * four monster slots is transcribed but switched off (`monsters: false`), so
 * the slots stay empty instead of filling up with things that cannot move.
 */

function WorldEntities(data, options) {
  var opts = options || {};
  this.data = data;
  this.k = data.values;
  this.monsters = !!opts.monsters;         // M5
  this.records = {};
  this.list = [];
  var addr;
  for (addr = WorldEntities.RECORDS_BASE; addr < WorldEntities.RECORDS_END;
       addr += WorldEntities.STRIDE) {
    this.records[addr] = new Uint8Array(WorldEntities.STRIDE);
    this.list.push(this.records[addr]);
  }
  this.weapons = [];
  for (addr = WorldEntities.WEAPONS_BASE; addr < WorldEntities.WEAPONS_END;
       addr += WorldEntities.WEAPON_STRIDE) {
    this.weapons.push(new Uint8Array(WorldEntities.WEAPON_STRIDE));
  }
  this.caveState = {};                    // 'col,row' -> [byte0, byte1]
  this.taken = {lives: {}, guardians: {}};
  this.gems = 0;                          // the GEMS countdown ($8EEE)
  this.castleTable = data.castle.packed || [];
  this.lives = {};
  (data.extraLives.places || []).forEach(function (place) {
    this.lives[place.col+','+place.row] = place;
  }, this);
  this.guardians = {};
  (data.guardians.places || []).forEach(function (place) {
    if (place.valid) { this.guardians[place.col+','+place.row] = place; }
  }, this);
  // M5 (app/monsters.js) hangs its own state off the same object; without it
  // the world still places everything, it just cannot make anything move
  if (this.initMonsters) { this.initMonsters(data.monsters); }
} // WorldEntities

WorldEntities.RECORDS_BASE = 0x8EFA;
WorldEntities.RECORDS_END = 0x902A;
WorldEntities.STRIDE = 16;
WorldEntities.WEAPONS_BASE = 0x902A;
WorldEntities.WEAPONS_END = 0x9052;
WorldEntities.WEAPON_STRIDE = 8;

// which slot is what — the names tools/matchentities.js prints in a difference
WorldEntities.SLOT = {
  shot0: 0x8EFA, shot1: 0x8F0A, sabreman: 0x8F1A, rope: 0x8F2A, drip: 0x8F3A,
  bubble0: 0x8F5A, furniture0: 0x8F7A, furniture1: 0x8F8A,
  furniture2: 0x8F9A, furniture3: 0x8FAA, pickup: 0x8FBA,
  monster0: 0x8FDA
};

(function () {
  var TYPE = 0, X = 1, COL = 2, Y = 3, ROW = 4, ATTR = 5, DX = 6;
  var PHASE = 8, VY = 9, COUNTER = 10, MASK = 11, LOW = 13, HEIGHT = 12;
  var SENSOR = 14, FLAGS = 15;
  var STRIDE = WorldEntities.STRIDE;
  var SLOT = WorldEntities.SLOT;
  var CASTLE_ROWS = 16;

  function u8(v) { return v & 0xFF; }

  var W = WorldEntities.prototype;

  W.record = function (address) { return this.records[address] || null; };

  function clear(record) {
    for (var i = 0; i < STRIDE; i++) { record[i] = 0; }
  }

  function copy(record, bytes) {
    for (var i = 0; i < STRIDE; i++) { record[i] = bytes[i] || 0; }
  }

  W.state = function (col, row) {
    var key = col+','+row;
    if (!this.caveState[key]) { this.caveState[key] = [0, 0]; }
    return this.caveState[key];
  }; // state

  // -------------------------------------------------------------------------
  // $E8BE — the four weapons. Called once, when the game starts.
  // -------------------------------------------------------------------------
  W.placeWeapons = function (frames) {
    var variant = this.data.weapons.variants[(frames >> 1) & 0x03];
    for (var i = 0; i < variant.length && i < this.weapons.length; i++) {
      var record = variant[i].record;
      for (var b = 0; b < WorldEntities.WEAPON_STRIDE; b++) {
        this.weapons[i][b] = record[b];
      }
    }
  }; // placeWeapons

  // -------------------------------------------------------------------------
  // $9906 — entering a room. The order matters: the room's own entities first,
  // then the redraw flags, then whatever the coordinate tables put here.
  // -------------------------------------------------------------------------
  W.enterRoom = function (col, row, word, counters) {
    var desc = word[0] & 0xFF;
    if (row < CASTLE_ROWS) {
      clear(this.records[SLOT.furniture2]);
      clear(this.records[SLOT.furniture3]);
      clear(this.records[SLOT.pickup]);
      clear(this.records[0x8FCA]);
      this.enterCastle(col, row);
    } else {
      this.enterCave(col, row, desc, counters);
    }
    var state = this.state(col, row);
    if (state[0] === 0) { state[0] = this.k.caveStateDefault; }   // $993B
    for (var i = 0; i < this.list.length; i++) {                  // $998F
      this.list[i][FLAGS] = 1;
    }
    for (i = 0; i < this.weapons.length; i++) { this.weapons[i][7] |= 1; }
    this.enterPlaced(col, row);
    this.records[SLOT.drip][FLAGS] |= 1;
  }; // enterRoom

  /**
   * $EAA2 — four pieces of furniture out of the castle table at $6800. The
   * table is 8 bytes a room, two bytes an entity: a type and a packed
   * position, which unpacks into x and y with the game's own two masks.
   */
  W.enterCastle = function (col, row) {
    var k = this.k;
    var line = this.castleTable[row] || '';
    for (var i = 0; i < k.castleCount; i++) {
      var at = 2*(8*col + 2*i);
      var type = parseInt(line.substr(at, 2), 16) || 0;
      var packed = parseInt(line.substr(at+2, 2), 16) || 0;
      var record = this.records[k.castleSlots + STRIDE*i];
      record[TYPE] = type;
      record[X] = u8((packed & k.castleXMask) + k.castleXOffset);
      record[COL] = col;
      record[Y] = u8(((packed << 3) & k.castleYMask) + k.castleYOffset);
      record[ROW] = row;
      record[ATTR] = k.castleAttribute;
      record[FLAGS] = 1;
    }
  }; // enterCastle

  /** $AF56 — the caves compose themselves out of the descriptor byte */
  W.enterCave = function (col, row, desc, counters) {
    var k = this.k;
    this.records[SLOT.furniture2][TYPE] = 0;
    this.records[SLOT.furniture3][TYPE] = 0;
    [SLOT.furniture0, SLOT.furniture1].forEach(function (slot) {
      // a bubble already in the room stays there
      if ((this.records[slot][TYPE] & 0xFC) !== 0x58) {
        this.records[slot][TYPE] = 0;
      }
    }, this);
    if ((desc & k.caveClosedMask) === k.caveClosedValue) {
      // ceiling and floor both closed: one decoration on the floor and one
      // growth in the middle, both picked by the room's coordinates
      var index = (col+row) & 0x0F;
      var xs = this.data.caves.decorXTable;
      var decor = this.records[SLOT.furniture0];
      decor[X] = parseInt(xs[index].substr(1), 16);
      decor[Y] = k.caveDecorY;
      decor[TYPE] = k.caveDecorType;
      decor[FLAGS] = 1;
      var growth = this.data.caves.templates.growth[(col & 0x03)];
      var record = this.records[SLOT.furniture2];
      copy(record, growth.record);
      record[X] = parseInt(xs[index+1].substr(1), 16);
    } else if (desc & 0x10) {
      // floor closed, ceiling open: two plants of type $54 — the bubble vents
      copy(this.records[SLOT.furniture2], this.data.caves.templates.vent[0].record);
      copy(this.records[SLOT.furniture3], this.data.caves.templates.vent[1].record);
    } else {
      this.enterCavePlants(col, row, desc, counters);
    }
  }; // enterCave

  /**
   * $E6EE — a cave with an open floor. Its two entities come out of the room's
   * own state word, and if there is none yet the game makes one up ($E714) out
   * of its two counters and keeps it. In register B at that point is the high
   * byte of the state table's address, left there by `LD BC,$6000` in $E6A5 —
   * the original builds on that, so the remake has to as well.
   */
  W.enterCavePlants = function (col, row, desc, counters) {
    var k = this.k;
    var state = this.state(col, row);
    if (state[0] === 0) {
      var leftover = k.caveStateTable >> 8;
      var first = (counters.step & 0xFF) | k.caveStateSeed;
      if (!(first & 0x04)) { first = leftover & k.caveStateBitA; }
      if (!(desc & 0x40)) { first |= k.caveStateOrA; }
      var second = (counters.frame & 0xFF) & k.caveStateSeedB;
      if (!(second & 0x04)) { second = leftover | k.caveStateOrB1; }
      if (!(desc & 0x04)) {
        second = (second | k.caveStateOrB2) & k.caveStateAndB;
      }
      state[0] = u8(first);
      state[1] = u8(second);
    }
    var plans = [{table: this.data.caves.templates.plantA, x: k.cavePlantXA,
                  slot: SLOT.furniture2},
                 {table: this.data.caves.templates.plantB, x: k.cavePlantXB,
                  slot: SLOT.furniture3}];
    for (var i = 0; i < 2; i++) {
      var value = state[i];
      var pointer = plans[i].table[(value & k.cavePlantIndexMask) >> 1].pointer;
      var record = this.records[plans[i].slot];
      copy(record, this.data.caves.pointedTemplates[pointer]);
      record[X] = u8((value & k.cavePlantXMask) + plans[i].x);
      record[COL] = col;
      record[Y] = u8(((value >> 2) & k.cavePlantYMask) + k.cavePlantYOffset);
      record[ROW] = row;
      record[ATTR] = k.cavePlantAttribute;
      record[DX] = value;
    }
  }; // enterCavePlants

  /**
   * $EC3A — the coordinate tables: an extra life sits on top of an entity the
   * room already has, a guardian stands in the middle of the floor. Which of
   * the two host slots the extra life uses is decided by the **row** of the
   * room ($EC84 reads it back off the stack), not by its number in the table.
   */
  W.enterPlaced = function (col, row) {
    var k = this.k;
    var key = col+','+row;
    var place = this.lives[key];
    if (place) {
      if (this.taken.lives[place.index]) { return; }
      var pickup = this.records[SLOT.pickup];
      copy(pickup, this.data.extraLives.template);
      pickup[DX] = place.index;
      var host = this.records[(row & 1) ? SLOT.furniture2 : SLOT.furniture3];
      pickup[X] = u8(host[X]+k.lifeXOffset);
      pickup[COL] = col;
      if (row < CASTLE_ROWS) {
        var height = this.data.heights['$'+host[TYPE].toString(16).toUpperCase()];
        host[HEIGHT] = (height === undefined) ? host[HEIGHT] : height;
      }
      pickup[Y] = u8(host[Y]-host[HEIGHT]);
      pickup[ROW] = row;
      return;
    }
    var guard = this.guardians[key];
    if (!guard) { return; }
    if (row >= CASTLE_ROWS) {
      // $EC1C: the guardian's room throws its furniture out and gets the exit
      [SLOT.furniture0, SLOT.furniture1, SLOT.furniture2,
       SLOT.furniture3].forEach(function (slot) {
        this.records[slot][TYPE] = 0;
      }, this);
      this.records[SLOT.furniture2][TYPE] = k.guardianRoomType;
      this.records[SLOT.furniture2][FLAGS] = 1;
    }
    if (this.taken.guardians[guard.index]) { return; }
    var record = this.records[SLOT.pickup];
    copy(record, this.data.extraLives.template);
    record[DX] = guard.index;
    record[TYPE] = u8(((guard.index << 1) & k.guardianTypeMask)
                      + k.guardianTypeBase);
    record[X] = k.guardianX;
    record[COL] = col;
    record[Y] = k.guardianY;
    record[ROW] = row;
    record[ATTR] = k.guardianAttribute;
  }; // enterPlaced

  // -------------------------------------------------------------------------
  // The generators, which the main loop runs before the entities themselves.
  // -------------------------------------------------------------------------

  /**
   * $E05F — a volcanic bubble rises out of an open floor, in the caves only,
   * about once in 64 passes, on one of two columns. This is where the bubbles
   * that carry Sabreman up through the caves come from (ZADANI chap. 9); the
   * carrying itself is in the physics ($E1B4).
   */
  W.generateBubble = function (world) {
    var k = this.k, player = world.player;
    if (player[TYPE] >= k.bubbleAliveType) { return; }
    if (player[ROW] < k.bubbleRow) { return; }
    var slot = this.freeSlot(k.bubbleSlots, k.bubbleSlotCount);
    if (slot === null) { return; }
    if (((world.counters.frame + (SLOT.sabreman & 0xFF))
         & k.bubbleChance) !== 0) { return; }
    var record = this.records[slot];
    for (var i = 0; i < 15; i++) { record[i] = player[i]; }
    record[TYPE] = k.bubbleType;
    record[X] = u8(((world.counters.step & k.bubbleXMask) + k.bubbleXOffset));
    record[Y] = k.bubbleStartY;
    record[ATTR] = k.bubbleAttribute;
    record[FLAGS] = 1;
  }; // generateBubble

  /**
   * $E0A9 — and a bubble out of a cave plant of type $54. The rate limit is
   * FRAMES plus the low byte of the **vent's own record** ($E0BA leaves it in
   * L with `PUSH IX / EX DE,HL / POP HL`), not of the bubble slot it found:
   * $8F9A and $8FAA are $10 apart, so the two vents of a room breathe at
   * different moments. Off the vent's address they would both wait for the
   * same pass, the left one — stepped first — would take the free slot and
   * the right one would be left with another slot, another low byte and a
   * gate that never opens, so it would never breathe at all.
   */
  W.ventBubble = function (world, vent, address) {
    var k = this.k;
    var slot = this.freeSlot(k.bubbleSlots, k.bubbleSlotCount);
    if (slot === null) { return; }
    if (((world.counters.frame + (address & 0xFF)) & k.bubbleChance) !== 0) {
      return;
    }
    var record = this.records[slot];
    for (var i = 0; i < 15; i++) { record[i] = vent[i]; }
    record[TYPE] = k.bubbleType;
    record[X] = u8(vent[X]+k.bubbleVentXOffset);
    record[COL] = world.player[COL];
    record[ROW] = world.player[ROW];
    record[FLAGS] = 1;
  }; // ventBubble

  /**
   * $DF58 — a stalactite lets go of a closed cave ceiling. The original only
   * gets here while Sabreman is **on a rope or tumbling**: for the states in
   * between, the main loop hands this routine the rope's record instead of his
   * ($91EA), and the rope's record has row 0, which fails the cave test. That
   * is a quirk of the original, reproduced rather than corrected.
   */
  W.generateDrip = function (world, descriptor) {
    var k = this.k, player = world.player;
    var type = player[TYPE];
    var record = (type >= 0x1C || type < 0x09) ? player : this.records[SLOT.rope];
    if (record[ROW] < k.dripRow) { return; }
    if (!(descriptor & k.dripCeilingMask)) { return; }
    if (this.records[SLOT.drip][TYPE] !== 0) { return; }
    if (((world.counters.frame | world.counters.step)
         & k.dripChance) !== 0) { return; }
    var drip = this.records[SLOT.drip];
    for (var i = 0; i < STRIDE; i++) { drip[i] = player[i]; }
    drip[TYPE] = k.dripType;
    drip[Y] = k.dripStartY;
    drip[ATTR] = k.dripAttribute;
    drip[VY] = k.dripVelocity;
  }; // generateDrip

  W.freeSlot = function (base, count) {
    for (var i = 0; i < count; i++) {
      if (this.records[base + STRIDE*i][TYPE] === 0) { return base + STRIDE*i; }
    }
    return null;
  }; // freeSlot

  // -------------------------------------------------------------------------
  // One pass of the entity part of the main loop ($950C back to $9459). The
  // original reaches the entities only on a pass that gets all the way round,
  // so the worker runs this on the slow counter, not every frame.
  // -------------------------------------------------------------------------
  W.step = function (world) {
    var player = world.player;
    var descriptor = world.roomWord(player[COL], player[ROW])[0];
    this.generateDrip(world, descriptor);                        // $91F9
    if (this.generateMonster) { this.generateMonster(world); }   // $91FC
    if (!(descriptor & 0x10)) { this.generateBubble(world); }    // $9204
    for (var i = 0; i < this.list.length; i++) {
      var record = this.list[i];
      var address = WorldEntities.RECORDS_BASE + STRIDE*i;
      if (address === SLOT.sabreman || address === SLOT.rope) { continue; }
      if (record[TYPE] === 0) { continue; }
      this.stepEntity(world, record, address, descriptor);
    }
    // $950C — and the five eight-byte weapon records come after them
    if (this.stepWeapons) { this.stepWeapons(world); }
    if (this.tickCarry) { this.tickCarry(); }
  }; // step

  W.stepEntity = function (world, record, address, descriptor) {
    var type = record[TYPE];
    if (type >= 0x58 && type <= 0x5B) { return this.bubble(world, record); }
    if (type === 0x50) { return this.drip(world, record); }
    if (type >= 0x51 && type <= 0x53) { return this.dripSplash(world, record); }
    if (type >= 0x1C && type <= 0x2B) { return this.caveDecor(world, record); }
    if (type === 0x54) { return this.vent(world, record, address); }
    if ((type >= 0x3C && type <= 0x3D) || (type >= 0x55 && type <= 0x57)) {
      return this.cavePlant(world, record, address);
    }
    if (type >= 0x64 && type <= 0x67) { return this.pickup(world, record, false); }
    if (type === 0x7F) { return this.pickup(world, record, true); }
    if (type >= 0x74 && type <= 0x7E) { return this.furniture(world, record); }
    // the monsters, the weapons, the guardians and the shots are M5
    if (this.stepMonster && this.stepMonster(world, record, address)) { return; }
    world.unported();
  }; // stepEntity

  /**
   * $E117 and $E0E8 — the bubble rises two pixels a step. Under a closed
   * ceiling it pops; otherwise it moves into the room above, which is how a
   * bubble can carry Sabreman up through several rooms.
   */
  W.bubble = function (world, record) {
    var k = this.k, player = world.player;
    if (record[COL] !== player[COL] || record[ROW] !== player[ROW]) {
      return this.bubbleOffscreen(world, record);
    }
    record[Y] = u8(record[Y]-2);
    record[COUNTER] = 0x50;
    var word = world.roomWord(record[COL], record[ROW]);
    record[MASK] = word[0];
    var y = record[Y];
    if (word[0] & 0x01) {                       // closed ceiling
      if (y < k.bubblePopY) { return this.pop(record); }
      if (y >= 0xAF && (word[0] & 0x10) && (record[FLAGS] & 1)) {
        record[TYPE] = 0;                       // $E156 – born in a closed room
        return;
      }
    } else if (y < k.bubbleCarryY) {
      record[ROW] = u8(record[ROW]-1);          // into the room above
      return;
    }
    record[DX] = u8(record[DX]+1);
    record[TYPE] = u8((record[DX] & 0x03) + k.bubbleType);
  }; // bubble

  /** $E0E8 — a bubble in another room keeps rising until it runs out of room */
  W.bubbleOffscreen = function (world, record) {
    var k = this.k;
    if (--record[COUNTER] === 0) { record[TYPE] = 0; return; }
    record[FLAGS] |= 1;
    record[Y] = u8(record[Y]-k.bubbleRise);
    if (record[MASK] & 0x01) {
      if (record[Y] < k.bubblePopY) { record[TYPE] = 0; }
      return;
    }
    if (record[Y] >= k.bubbleCarryY) { return; }
    record[Y] = k.bubbleWrapY;
    record[ROW] = u8(record[ROW]-1);
    record[MASK] = world.roomWord(record[COL], record[ROW])[0];
  }; // bubbleOffscreen

  /** $E17A — the bubble bursts into the sparks of type $72 */
  W.pop = function (record) {
    record[TYPE] = 0x72;
    record[PHASE] = 0x03;
  }; // pop

  /**
   * $DF98 — the stalactite falls: the speed grows by 2/16 px a step up to $6E,
   * and y is kept to a sixteenth of a pixel in byte +$0D. On the floor (or on
   * a piece of furniture) it turns into the splash of type $51.
   */
  W.drip = function (world, record) {
    var speed = record[VY]+2;
    if (speed < 0x6E) { record[VY] = speed; }
    var sub = record[LOW] + (record[VY] << 4);
    record[LOW] = sub & 0xFF;
    record[Y] = u8(record[Y] + (sub >> 8));
    var descriptor = world.roomWord(record[COL], record[ROW])[0];
    if (descriptor & 0x10) {
      if (record[Y] >= 0x9F) {
        record[Y] = u8((record[Y] & 0xF8)-1);
        record[TYPE] = 0x51;
        record[DX] = 0;
        return;
      }
    } else if (record[Y] >= 0xBF) {
      record[TYPE] = 0;                          // out of the room ($E00D, M5)
      return;
    }
    record[FLAGS] |= 1;
  }; // drip

  /** $E027 — the splash runs through its three types and is gone */
  W.dripSplash = function (world, record) {
    var player = world.player;
    if (record[COL] !== player[COL] || record[ROW] !== player[ROW]) {
      record[TYPE] = 0;
      return;
    }
    record[DX] = u8(record[DX]+1);
    if (record[DX] & 1) { return; }
    var type = record[TYPE]+1;
    if (type < 0x54) { record[TYPE] = type; return; }
    record[X] = u8(record[X]-4);
    record[TYPE] = 0;
  }; // dripSplash

  /**
   * $AEB9 — the growth on a cave floor. Touching it sets bit 7 of Sabreman's
   * flags, and the physics turns that into a tumble ($A406) — so these are the
   * "poisonous plants" of the inlay, and they do **not** kill: they throw you,
   * and it is the fall afterwards that can.
   */
  W.caveDecor = function (world, record) {
    var player = world.player;
    if (record[FLAGS] & 1) { return this.growDecor(world, record); }
    if (record[COL] !== player[COL] || record[ROW] !== player[ROW]) {
      record[TYPE] = 0;
      return;
    }
    var dy = u8(player[Y]-record[Y]);
    if (dy < 0x14) {
      var dx = u8(u8(player[X]-record[X])-4);
      if (dx & 0x80) { dx = u8(-dx); }
      if (dx < 0x14) { player[FLAGS] |= 0x80; }
    }
    record[DX] = u8(record[DX]+1);
    record[TYPE] = (record[TYPE] & 0xFE) | ((record[DX] >> 3) & 1);
  }; // caveDecor

  /** $AF12 — a freshly placed growth works out its own type and colour */
  W.growDecor = function (world, record) {
    var player = world.player;
    record[COL] = player[COL];
    record[ROW] = player[ROW];
    var type = u8((((record[X] >> 2) + record[COL]) & 0x0E) + 0x1C);
    record[TYPE] = type;
    record[DX] = type;
    record[ATTR] = u8(((type >> 1) & 0x03) + 0x42);
    record[FLAGS] &= ~1;
  }; // growDecor

  /** $AF3F with type $54 — the plant that breathes bubbles */
  W.vent = function (world, record, address) {
    if (record[FLAGS] & 1) { record[FLAGS] &= ~1; return; }
    this.ventBubble(world, record, address);
  }; // vent

  /**
   * $E622 — a cave plant. Once something knocks it (bit 3 of +6) it clones
   * itself two slots on and turns the clone into a gem of one of four types.
   */
  W.cavePlant = function (world, record, address) {
    if (!(record[FLAGS] & 1)) { return; }
    record[FLAGS] &= ~1;
    if (!(record[DX] & 0x08)) { return; }
    var gem = this.records[address + 2*STRIDE];
    if (!gem) { return; }
    for (var i = 0; i < STRIDE; i++) { gem[i] = record[i]; }
    gem[TYPE] = u8(((record[COL]+record[ROW]+record[DX]) & this.k.plantGemMask)
                   + this.k.plantGemBase);
    gem[Y] = u8(gem[Y]-record[HEIGHT]);
    gem[ATTR] = this.k.plantGemAttribute;
    record[DX] = 0;
  }; // cavePlant

  /**
   * $E751 — a gem or an extra life. A gem starts the invincibility countdown
   * ($8EEE), which is the number the panel shows as GEMS: it is not a tally of
   * gems collected but the time left, and while it runs Sabreman is a
   * different colour and the contact sensor is off. An extra life adds one to
   * the reserve and is ticked off in the table so it does not come back.
   */
  W.pickup = function (world, record, isLife) {
    var k = this.k, player = world.player;
    if (record[COL] !== player[COL] || record[ROW] !== player[ROW]) {
      record[TYPE] = 0;
      return;
    }
    if (record[FLAGS] & 1) { record[FLAGS] &= ~1; return; }
    if (!this.touching(world, record)) { return; }
    if (isLife) {
      world.addLife();
      this.taken.lives[record[DX]] = true;
      record[TYPE] = 0;
      return;
    }
    player[ATTR] = k.gemPlayerAttribute;
    this.gems = k.gemCountdown;
    world.invincible = true;
    var state = this.state(record[COL], record[ROW]);
    var half = (record[DX] & 1) ? 0 : 1;
    state[half] = state[half] & ~0x08;              // $E7A6 – gem taken
    world.sound('gem');
    record[TYPE] = 0;
  }; // pickup

  /** $E285 — is Sabreman on this thing? */
  W.touching = function (world, record) {
    var player = world.player;
    if (player[TYPE] >= 0x1D) { return false; }
    if (player[FLAGS] & 0x40) { return false; }
    var dx = u8(player[X]-record[X]);
    if (dx & 0x80) { dx = u8(-dx); }
    if (dx >= 0x10) { return false; }
    if (player[COL] !== record[COL]) { return false; }
    var dy = u8(u8(player[Y]-4)-record[Y]);
    if (dy & 0x80) { dy = u8(-dy); }
    if (dy >= 0x0A) { return false; }
    if (player[ROW] !== record[ROW]) { return false; }
    // $E2C5 — a confirmed touch is also a sound, pitched by the y of the thing
    // touched (M6); the same tail as in monsters.js contactRaw
    world.sound('touch', {y: record[Y]});
    return true;
  }; // touching

  /**
   * $EAF9 / $EB39 with $EB18 — the castle furniture. All it does is take its
   * hit box out of the table for its type; the obstacle sensor in the physics
   * then reads it out of the record, so the hit boxes are the game's data.
   */
  W.furniture = function (world, record) {
    var player = world.player;
    if (record[COL] !== player[COL] || record[ROW] !== player[ROW]) {
      record[TYPE] = 0;
      return;
    }
    if (!(record[FLAGS] & 1)) { return; }
    record[FLAGS] &= ~1;
    var box = this.data.hitboxes['$'+record[TYPE].toString(16).toUpperCase()];
    if (!box) { return; }
    for (var i = 0; i < box.length; i++) { record[COUNTER+i] = box[i]; }
  }; // furniture

  // -------------------------------------------------------------------------
  // The GEMS countdown ($948B): every fourth tick of the slow counter, in BCD,
  // and when it runs out Sabreman gets his own colour back ($94A4).
  // -------------------------------------------------------------------------
  W.tickGems = function (world) {
    if ((world.counters.step & this.k.gemTick) !== 0) { return; }
    if (this.gems === 0) { return; }
    this.gems = bcdDec(this.gems);
    if (this.gems === 0) {
      world.player[ATTR] = this.k.gemPlayerAttrRestore;
      world.invincible = false;
    }
  }; // tickGems

  function bcdDec(value) {
    var low = value & 0x0F, high = value >> 4;
    if (low === 0) { low = 9; high = (high === 0) ? 0 : high-1; } else { low--; }
    return (high << 4) | low;
  }

  /** the two entities of $AF3F, whose records carry no room of their own */
  function roomless(record) {
    return (record[TYPE] >= 0x2C && record[TYPE] <= 0x2F)
      || record[TYPE] === 0x54;
  }

  /** what the renderer needs: everything of this room, in drawing order */
  W.visible = function (col, row) {
    var out = [];
    var self = this;
    this.list.forEach(function (record, index) {
      var address = WorldEntities.RECORDS_BASE + STRIDE*index;
      if (address === SLOT.sabreman || address === SLOT.rope) { return; }
      if (record[TYPE] === 0) { return; }
      // $ED2E draws the way out wherever its record says it is, because its
      // handler never looks at the room; and it is a wedge of sprites, not one
      if (self.m && record[TYPE] === self.m.obstacleExitType && self.exitSprites) {
        self.exitSprites().forEach(function (at) {
          out.push({type: record[TYPE], x: at.x, y: at.y, attr: record[ATTR]});
        });
        return;
      }
      // $AF3F — the growth in the middle of a closed cave ($2C-$2F) and the
      // bubble vent ($54) are copied out of the tables at $B76B / $B7AB,
      // which have no room in them: their records keep col 0, row 0 (that is
      // what the original holds too, tools/matchentities.js measures it) and
      // their handler never looks at the room either, it just draws them.
      // $AF56 rewrites those slots on every room entry, so whatever is in
      // them belongs to the room Sabreman is in — and without this the vent
      // is an invisible platform, because the sensor $B43E does not compare
      // rooms and lets him stand on it.
      if (!roomless(record) && (record[COL] !== col || record[ROW] !== row)) {
        return;
      }
      out.push({type: record[TYPE], x: record[X], y: record[Y],
                attr: record[ATTR]});
    });
    this.weapons.forEach(function (record) {
      if (record[TYPE] === 0) { return; }
      // A carried weapon ($E92A, bit 1 of byte +7) sits at x = $88/$A0/$B8,
      // y = $0F — screen coordinates of the panel, which in the original is
      // the same video memory. Here the panel is drawn on its own
      // (screenComposer.composePanelInto), so the room must not draw it a second
      // time, or the weapon looks as if it stayed hanging in the air.
      if (record[7] & 0x02) { return; }
      if (record[COL] !== col || record[ROW] !== row) { return; }
      out.push({type: record[TYPE], x: record[X], y: record[Y],
                attr: record[ATTR]});
    });
    return out;
  }; // visible
}());

if (typeof self !== 'undefined') { self.WorldEntities = WorldEntities; }
if (typeof module !== 'undefined' && module.exports) { module.exports = WorldEntities; }
