// begin code

/**
 * Sabreman's physics — a transcription of the original's routines (M3).
 *
 * Nothing here is tuned by feel. Every number comes out of data/physics.json,
 * which tools/dumpphysics.py reads as the operands of the actual instructions
 * in the game's runtime image, and the control flow below is the disassembly
 * of these routines (runtime addresses, sources/docs/disasm_notes.md chap. 13):
 *
 *   $A433  standing and walking      types $09-$10
 *   $A5F1  the crouch before a jump  types $11-$14
 *   $A6A6  the jump                  types $15-$16
 *   $A925  falling and being bounced types $18-$1B
 *   $A316  hanging on a rope         types $01-$08
 *   $AA4C  a rope with nobody on it  type  $17
 *   $E7D0  dying, $E7E3 the respawn  types $3E-$3F
 *   $E1B4  the platform sensor, $B43E obstacles, $E833 an enemy
 *   $AAB0 / $ABE5 / $AB78  the rope pendulum
 *
 * The labels below are named after those addresses on purpose: the code is
 * meant to be read side by side with `tools/uwdis.py <addr>`, and
 * tools/matchphysics.js checks it step by step against runs of the original
 * (tools/tracephysics.py). The state is the game's own 16-byte entity record,
 * so a step of this code and a step of the original are directly comparable.
 *
 * The whole state machine works in the machine's own terms: unsigned bytes,
 * y counted downwards with the floor at $9F, the vertical speed in 1/16 px per
 * step, and one step per frame of the original (50.08 Hz).
 *
 * The one thing that is NOT a transcription is how often a step happens: the
 * original's main loop manages one step per frame while walking, but only one
 * per two or three while it is drawing a rope. That is Z80 timing, not a rule
 * of the game; the remake steps once per tick and every `ropeStepFrames` ticks
 * for the pendulum (data/physics.json), and M7 compares the two side by side.
 */

var SabremanPhysics = (function () {
  'use strict';

  // offsets in the entity record; the original addresses them as (IX+n)
  var TYPE = 0, X = 1, COL = 2, Y = 3, ROW = 4, ATTR = 5, DX = 6, SPARE7 = 7,
      WALK = 8, VY = 9, COUNTER = 10, MASK = 11, CONTACT = 14, FLAGS = 15;

  // the descriptor byte of a room: which sides are closed (M2, $9DA0)
  var TOP = 0x01, RIGHT = 0x04, FLOOR = 0x10, LEFT = 0x40;

  function u8(v) { return v & 0xFF; }
  function s8(v) { v &= 0xFF; return (v & 0x80) ? v-256 : v; }
  /** SRA A four times — the arithmetic shift the original uses on the speed */
  function sra4(v) { return s8(v) >> 4; }

  /**
   * @param {object} data — data/physics.json (tools/dumpphysics.py)
   * Note: the platform sensor can end the whole step (it shoves him off a
   * platform stuck under the ceiling), so it hands a label back to its caller.
   */
  function SabremanPhysics(data) {
    this.data = data;
    this.k = data.values;
  } // SabremanPhysics

  var P = SabremanPhysics.prototype;

  /** a fresh Sabreman: the original's own template from $AA3C */
  P.spawn = function () {
    var rec = new Uint8Array(16);
    var template = this.k.spawnRecord;
    for (var i = 0; i < 16; i++) {
      rec[i] = template[i];
    }
    return rec;
  }; // spawn

  /**
   * Sets the room up the way the original does when it is entered ($9906 ->
   * $AE81): the rope of the room, its length and the swing at rest.
   * @param {object} world — the world Sabreman is in.
   * @returns {number} what the original leaves in A.
   */
  P.setupRoom = function (world) {
    return this.AE81({w: world, p: world.player});
  }; // setupRoom

  /**
   * $A35B — the trigger. The shot itself is app/monsters.js (M5, $B4D1); what
   * belongs to the physics is only *when* it is pulled, and that letting go of
   * it puts $FF in the rate counter ($A360) so the next press fires at once.
   */
  P.B4D1 = function (world, pressed) {
    if (!pressed) {
      if (world.fireReleased) { world.fireReleased(); }
      return;
    }
    world.sound('shoot');
    if (world.fire) { world.fire(); }
  }; // B4D1

  /** which of the eight states a type belongs to — for the renderer and tests */
  P.stateOf = function (type) {
    if (type >= 0x01 && type <= 0x08) { return 'rope'; }
    if (type >= 0x09 && type <= 0x0C) { return 'walkLeft'; }
    if (type >= 0x0D && type <= 0x10) { return 'walkRight'; }
    if (type >= 0x11 && type <= 0x14) { return 'crouch'; }
    if (type >= 0x15 && type <= 0x16) { return 'jump'; }
    if (type === 0x17) { return 'ropeIdle'; }
    if (type >= 0x18 && type <= 0x1B) { return 'fall'; }
    if (type >= 0x3E && type <= 0x3F) { return 'death'; }
    if (type >= 0x60 && type <= 0x63) { return 'carried'; }   // M5, $E570
    return 'unknown';
  }; // stateOf

  P.facing = function (type) {
    var state = this.stateOf(type);
    if (state === 'walkRight' || type === 0x13 || type === 0x14 || type === 0x16) { return 1; }
    if (state === 'carried') { return (type & 0x02) ? 1 : -1; }
    if (state === 'rope') { return (type >= 0x05) ? 1 : -1; }
    return -1;
  }; // facing

  // -------------------------------------------------------------------------
  // one step of Sabreman: dispatch by type as the original's jump table $921A
  // -------------------------------------------------------------------------

  /**
   * @param {object} world — see WORKER-PROTOCOL.md; carries the record, the
   *        rope globals, the other entity records, the room table and the
   *        input of this step.
   */
  P.step = function (world) {
    var ctx = {w: world, p: world.player, e: 0, d: 0, c: 0, b: 0, a: 0};
    var type = ctx.p[TYPE];
    var label;
    if (type >= 0x01 && type <= 0x08) { label = this.A316; }
    else if (type >= 0x09 && type <= 0x10) { label = this.A433; }
    else if (type >= 0x11 && type <= 0x14) { label = this.A5F1; }
    else if (type >= 0x15 && type <= 0x16) { label = this.A6A6; }
    else if (type >= 0x18 && type <= 0x1B) { label = this.A925; }
    else if (type >= 0x3E && type <= 0x3F) { label = this.E7E3; }
    else if (type >= 0x60 && type <= 0x63) {      // $E570 — an eagle has him
      if (world.carriedPlayer) { world.carriedPlayer(); }
      return;
    }
    else { return; }                    // types the original hands elsewhere
    var guard = 0;
    while (label) {
      label = label.call(this, ctx);
      if (++guard > 64) { throw new Error('sabremanPhysics: smycka navesti'); }
    }
    // $96CB — every handler of the original ends with the draw, and the draw
    // clears the redraw bit. It matters beyond drawing: $B4D1 refuses to fire
    // while it is set, so a shot never goes off on the step he enters a room.
    ctx.p[FLAGS] &= ~0x01;
  }; // step

  /** one step of a rope that nobody hangs on — entity type $17 ($AA4C) */
  P.stepRope = function (world, rec) {
    var ctx = {w: world, p: rec, e: 0, d: 0, c: 0, b: 0, a: 0};
    var label = this.AA4C;
    while (label) { label = label.call(this, ctx); }
  }; // stepRope

  // --- helpers the handlers share ------------------------------------------

  /** the room descriptor of the room Sabreman is in ($98CC) */
  P.roomWord = function (ctx) {
    var word = ctx.w.roomWord(ctx.p[COL], ctx.p[ROW]);
    ctx.e = word[0];
    ctx.d = word[1];
  }; // roomWord

  /**
   * Entering a room ($9906). Two things about it matter to the physics: the
   * room sets up its rope ($AE81) and it leaves the *type* of the room in A,
   * which one path of the jump ($A86F) then reads as if it were a coordinate.
   * That is a quirk of the original, not a rule of the game, and it is
   * reproduced here because it decides where a jump out of the bottom of a
   * room puts Sabreman.
   * @param {object} ctx — the step being run.
   * @returns {number} what the original leaves in A.
   */
  P.enterRoom = function (ctx) {
    var a = this.AE81(ctx);
    ctx.w.enterRoom(ctx.p[COL], ctx.p[ROW]);
    return a;
  }; // enterRoom

  /**
   * $AE81 — the rope of the room being entered. Bit 3 of the second byte of
   * the room record says a rope hangs here, bit 2 and bits 0-1 say how long it
   * is (it can span more than one room); with no rope the entity is cleared.
   * The swing always starts from rest.
   * @param {object} ctx — the step being run.
   * @returns {number} what the original leaves in A.
   */
  P.AE81 = function (ctx) {
    var w = ctx.w, p = ctx.p;
    var word = w.roomWord(p[COL], p[ROW]);
    var d = word[1];
    w.rope.offset = 0;
    w.rope.accLow = 0;
    var rope = w.record(0x8F2A);
    if (!(d & 0x08)) {
      if (rope) { rope[TYPE] = 0; }
      return 0;
    }
    if (rope) { rope[TYPE] = this.k.ropeEntityType; }
    w.rope.prevTipX = 0;
    w.rope.prevTipY = 0;
    var low = (d & 0x04) ? 0xFF : 0xA0;
    var high = d & 0x03;
    low = ((high & 1) << 7) | (low >> 1);       // SRA H / RR L
    high = high >> 1;
    w.rope.length = low;
    w.rope.lengthHigh = high;
    return d & 0x03;
  }; // AE81

  // -------------------------------------------------------------------------
  // $E1B4 — the one thing besides the floor Sabreman can stand on: an entity
  // of type $58-$5B. Its sprite in the game's own table is a **volcanic
  // bubble** (ZADANI chap. 9: the bubbles carry you up through the caves), and
  // this sensor is where that carrying comes from — when he walks up out of the
  // room while standing on one, the bubble is copied into the room above.
  // -------------------------------------------------------------------------
  P.E1B4 = function (ctx) {
    var k = this.k, p = ctx.p, w = ctx.w;
    ctx.c = 0;
    if (p[COUNTER] & k.platformIgnore) { return; }   // no control → fall through
    for (var i = 0; i < k.platformSlots; i++) {
      var rec = w.record(k.platformBase + 16*i);
      if (!rec || (rec[TYPE] & 0xFC) !== k.platformType) { continue; }
      ctx.c = 0;
      var d = u8(rec[X]-p[X]);
      if (d & 0x80) { d = u8(-d); ctx.c |= 0x80; }
      if (d >= k.platformReachX) { continue; }
      if (d >= k.platformEdgeX) { ctx.c |= 0x21; }
      if (rec[COL] !== p[COL]) { continue; }
      var dy = u8(rec[Y]-p[Y]);
      if (dy >= k.platformReachY) { continue; }
      if (rec[ROW] !== p[ROW]) { continue; }
      ctx.c |= 0x06;
      if (!(ctx.c & 1)) { p[Y] = u8(rec[Y]-k.platformStandY); }
      ctx.b = u8(-(p[Y]-0xA0));
      if (!(ctx.c & 1)) {
        ctx.e |= FLOOR;
        p[MASK] |= FLOOR;
      }
      // $E22B: walking up into the room above while standing on a platform —
      // the platform is copied into the room above so he keeps standing on it.
      // Under a closed ceiling there is nowhere to go, so the platform shoves
      // him off instead ($E23A falls straight through into $E272).
      if (p[TYPE] >= 0x1C || p[TYPE] < 0x09) { return; }
      if (p[Y] >= k.ceilingY) { return; }
      if (ctx.e & TOP) { return this.E272; }
      if (p[Y] >= 0x2C) { return; }
      p[ROW] = u8(p[ROW]-1);
      p[Y] = 0xAF;
      ctx.b = 0xF1;
      var above = w.record(k.platformBase);
      for (var j = 0; j < 15; j++) { above[j] = p[j]; }
      above[TYPE] = k.platformType;
      above[Y] = 0xB8;
      above[ATTR] = 0x46;
      above[FLAGS] = 0x01;
      this.enterRoom(ctx);
      return;
    }
    ctx.c = 0;
  }; // E1B4

  // -------------------------------------------------------------------------
  // $B43E — the obstacle sensor: furniture, weapons, guardians. Each record
  // carries its own reach (+$0A..+$0E), so the hit boxes come from the game.
  // -------------------------------------------------------------------------
  P.B43E = function (ctx) {
    var k = this.k, p = ctx.p, w = ctx.w;
    var base = (p[ROW] < 0x10) ? k.obstacleBaseCastle : k.obstacleBaseCave;
    var count = (p[ROW] < 0x10) ? k.obstacleSlotsCastle : k.obstacleSlotsCave;
    ctx.c = 0;
    for (var i = 0; i < count; i++) {
      var rec = w.record(base + 16*i);
      ctx.c = 0;
      if (!rec || rec[TYPE] === 0) { continue; }
      if (rec[FLAGS] & 1) { continue; }        // $B475 RET s C=0 – dalsi zaznam
      if (rec[TYPE] === 0x88) { continue; }     // $ED8A — M5 (a guardian)
      var d = u8(rec[X]+rec[14]-p[X]);
      if (d & 0x80) { d = u8(-d); ctx.c |= 0x80; }
      if (d >= rec[10]) { ctx.c = 0; continue; }
      if (d >= rec[11]) { ctx.c |= 0x01; }
      var dy = u8(rec[Y]-p[Y]);
      if (dy & 0x80) { ctx.c = 0; continue; }
      ctx.b = u8(-(u8(rec[Y]-rec[12])-0xA0));
      if (dy >= rec[12]) { ctx.c = 0; continue; }
      ctx.c |= 0x04;
      if (dy < rec[13]) { return; }             // $B4B7 RET C – jen dotek, ne prekryv
      ctx.c |= 0x02;
      if ((p[TYPE] & 0xFC) === 0x68) { return; }
      if (ctx.c & 1) { return; }
      p[MASK] |= FLOOR;
      return;
    }
  }; // B43E

  // -------------------------------------------------------------------------
  // $E833 — the one contact in the game that can kill. M5 pinned down what it
  // reads: **only slot $8F3A**, which is where $DF58 drops a stalactite and
  // nothing else ever goes. So the monsters, the guardians and the plants all
  // shove ($B148, $ED1E, $AEF0), and the single thing that kills on touch is a
  // falling stalactite square on the head ($A3E9 with bit 0 of C clear).
  // A gem ($8EEE) switches even that off.
  // -------------------------------------------------------------------------
  P.E833 = function (ctx) {
    var k = this.k, p = ctx.p, w = ctx.w;
    ctx.c = 0x80;
    ctx.b = 0;
    var rec = w.record(0x8F3A);
    if (!rec || rec[TYPE] === 0) { return; }
    if (w.invincible) { return; }
    if (rec[COL] !== p[COL] || rec[ROW] !== p[ROW]) { return; }
    var d = u8(rec[X]-p[X]);
    if (d & 0x80) { d = u8(-d); ctx.c &= ~0x80; }
    if (d >= k.enemyReachX) { return; }
    if (d >= k.enemyGraze) { ctx.c |= 0x01; }
    var dy = u8(rec[Y]-p[Y]);
    if (dy & 0x80) { dy = u8(-dy); ctx.c |= 0x02; }
    if (dy >= k.enemyReachY) { return; }
    ctx.c |= 0x04;
    ctx.b = rec[VY];
  }; // E833

  // -------------------------------------------------------------------------
  // $A433 — standing and walking (types $09-$10)
  // -------------------------------------------------------------------------
  P.A433 = function (ctx) {
    var k = this.k, p = ctx.p;
    if (p[FLAGS] & 0x40) { return this.B72C; }
    p[COUNTER] = 0;
    p[MASK] = 0;
    if (p[Y] < k.topWallsY) { p[MASK] = k.sideMaskHigh; }
    if (p[FLAGS] & 0x80) { return this.A406; }
    if (p[FLAGS] & 0x08) { return this.E8A2; }
    this.roomWord(ctx);
    var thrown = this.E1B4(ctx);
    if (thrown) { return thrown; }
    p[CONTACT] = ctx.c;
    this.E833(ctx);
    if (ctx.c & 0x04) {
      if (p[CONTACT] & 0x04) { return this.E894; }
      return this.A3E9;
    }
    if (!(p[CONTACT] & 0x04)) {
      this.B43E(ctx);
      if ((ctx.c & 0x7F) === 0x04) { return this.E272; }
      p[CONTACT] = ctx.c;
    }
    ctx.input = ctx.w.input;
    this.B4D1(ctx.w, ctx.input.fire);      // $A35B / $A360
    if (ctx.input.up) { return this.A596; }
    if (ctx.input.right) { return this.A54A; }
    if (ctx.input.left) { return this.A56E; }
    p[DX] = 0;
    return this.A4B3;
  }; // A433

  /** $A54A — walking right */
  P.A54A = function (ctx) {
    var p = ctx.p, k = this.k;
    if ((p[CONTACT] & 0x86) === 0x04) {         // an obstacle right at his edge
      p[DX] = 0;
      return this.A4B3;
    }
    p[DX] = k.walkStep;
    p[WALK] = u8(p[WALK]+1);
    p[TYPE] = u8(((p[WALK] >> 1) & k.poseHold) + k.walkPoseRight);
    ctx.w.sound('step');
    return this.A4B3;
  }; // A54A

  /** $A56E — walking left */
  P.A56E = function (ctx) {
    var p = ctx.p, k = this.k;
    if ((p[CONTACT] & 0x86) === 0x84) {
      p[DX] = 0;
      return this.A4B3;
    }
    p[DX] = k.walkStepLeft;
    p[WALK] = u8(p[WALK]+1);
    p[TYPE] = u8(((p[WALK] >> 1) & k.poseHold) + k.walkPoseLeft);
    ctx.w.sound('step');
    return this.A4B3;
  }; // A56E

  /** $A596 — the jump key: crouch first, `crouchFrames` steps of it */
  P.A596 = function (ctx) {
    var p = ctx.p, k = this.k;
    p[VY] = k.jumpVelocity;
    return this.A59A(ctx);
  }; // A596

  /** $A59A — enter the crouch, facing from the direction he is moving in */
  P.A59A = function (ctx) {
    var p = ctx.p, k = this.k;
    p[COUNTER] = k.crouchFrames;
    p[TYPE] = u8((((p[TYPE]-1) & 0x04) >> 1) + k.crouchPoseLeft);
    if (p[DX] === 0) { return; }
    p[TYPE] = (s8(p[DX]) < 0) ? k.crouchPoseLeft : u8(k.crouchPoseLeft+2);
  }; // A59A

  /** $A4B3 — the horizontal move and the room borders */
  P.A4B3 = function (ctx) {
    var p = ctx.p, k = this.k;
    if ((p[CONTACT] & 0x07) === 0x07) {         // on the very edge of a platform
      p[VY] = 0;
      return this.A59A(ctx);
    }
    p[X] = u8(p[X]+s8(p[DX]));
    this.roomWord(ctx);
    ctx.e |= p[MASK];
    if (p[X] >= 0x10 && p[X] < 0xE8 && !(ctx.w.justEntered & 1) && !(ctx.e & FLOOR)) {
      return this.A5C3;                         // nothing under him: he hops up
    }
    p[VY] = 0;
    if (((p[TYPE]-1) & 0x04) !== 0) { return this.A520; }
    // walking left
    if (p[X] & 0x80) { return; }
    if (p[X] >= k.wallLeftWalk) { return; }
    if (ctx.e & LEFT) { p[X] = k.wallLeftWalk; return; }
    if (p[X] >= k.exitLeftX) { return; }
    p[X] = k.enterRightX;
    p[COL] = u8(p[COL]-1);
    this.enterRoom(ctx);
  }; // A4B3

  /** $A520 — walking right into the right border */
  P.A520 = function (ctx) {
    var p = ctx.p, k = this.k;
    if (!(p[X] & 0x80)) { return; }
    if (p[X] < k.wallRightWalk) { return; }
    if (ctx.e & RIGHT) { p[X] = k.wallRightWalk; return; }
    if (p[X] < k.exitRightX) { return; }
    p[X] = k.enterLeftX;
    p[COL] = u8(p[COL]+1);
    this.enterRoom(ctx);
  }; // A520

  /** $A5C3 — standing over nothing: an automatic hop, upwards and sideways */
  P.A5C3 = function (ctx) {
    var p = ctx.p, k = this.k;
    p[VY] = k.stepOffVelocity;
    if (p[X] & 0x80) {
      p[DX] = k.walkStepLeft;
      p[COUNTER] = k.crouchFrames;
      p[TYPE] = k.crouchPoseLeft;
    } else {
      p[DX] = k.walkStep;
      p[COUNTER] = k.crouchFrames;
      p[TYPE] = u8(k.crouchPoseLeft+2);
    }
  }; // A5C3

  // -------------------------------------------------------------------------
  // $A5F1 — the crouch (types $11-$14). Holding a direction during it is what
  // makes a running jump: the speed set here is kept for the whole flight.
  // -------------------------------------------------------------------------
  P.A5F1 = function (ctx) {
    var p = ctx.p, k = this.k;
    if (p[FLAGS] & 0x40) { return this.B72C; }
    if (p[FLAGS] & 0x80) { return this.A406; }
    this.roomWord(ctx);
    var thrownCrouch = this.E1B4(ctx);
    if (thrownCrouch) { return thrownCrouch; }
    p[COUNTER] = u8(p[COUNTER]-1);
    if (p[COUNTER] !== 0) {
      if (p[COUNTER] === k.crouchPoseStep) { p[TYPE] = u8(p[TYPE]+1); }
      var input = ctx.w.input;
      if (input.right) {
        p[DX] = k.walkStep;
        p[TYPE] = u8((((p[TYPE]-1) | 0x02) & 0xFF)+1);
      } else if (input.left) {
        p[DX] = k.walkStepLeft;
        p[TYPE] = u8((((p[TYPE]-1) & ~0x02) & 0xFF)+1);
      }
      return;
    }
    // $A645 — the take-off
    p[TYPE] = u8((((p[TYPE]-1) >> 1) & 0x01) + k.jumpPose);
    this.roomWord(ctx);
    ctx.e |= p[MASK];
    var a = u8(p[Y]-k.jumpLiftoff);
    if (a < 0x49) {
      p[MASK] = k.sideMaskHigh;
      if (ctx.e & TOP) { return this.A928; }
    }
    p[Y] = a;
    p[COUNTER] = k.jumpFrames;
    ctx.w.sound('jump');
  }; // A5F1

  // -------------------------------------------------------------------------
  // $A6A6 — the jump (types $15-$16)
  // -------------------------------------------------------------------------
  P.A6A6 = function (ctx) {
    var p = ctx.p;
    this.E833(ctx);
    if (ctx.c & 0x04) { return this.E898; }
    if (p[FLAGS] & 0x40) { return this.B72C; }
    if (p[FLAGS] & 0x80) { return this.A406; }
    if (p[FLAGS] & 0x08) { return this.E8A2; }
    var input = ctx.w.input;
    if (p[DX] === 0) {                          // in the air he can only turn
      if (input.right) { p[TYPE] = 0x16; }
      if (input.left) { p[TYPE] = 0x15; }
    }
    this.B4D1(ctx.w, input.fire);          // $A494 / $A499
    this.roomWord(ctx);
    var thrownJump = this.E1B4(ctx);
    if (thrownJump) { return thrownJump; }
    if (!(ctx.c & 0x04)) {
      var e = ctx.e, d = ctx.d;
      this.B43E(ctx);
      ctx.e = e;
      ctx.d = d;
      if (!(ctx.c & 0x04)) { return this.A733; }
    }
    if (!(ctx.c & 0x01)) {
      if (!(ctx.c & 0x02)) { return this.A70D; }
      p[Y] = u8(0xA1-ctx.b);
      return this.A8A0;                         // he came down on something
    }
    if (ctx.c & 0x02) { return this.A733; }
    return this.A70D;
  }; // A6A6

  /** $A70D — a glancing hit in the air: pushed aside and dropped */
  P.A70D = function (ctx) {
    var p = ctx.p, k = this.k;
    this.EBC0(ctx);
    p[DX] = (ctx.c & 0x80) ? k.walkStep : k.walkStepLeft;
    ctx.w.sound('land');
    return this.A928;
  }; // A70D

  /**
   * $EBC0 — a jump that has run out of room: it turns into a tumble and x is
   * kept inside the room. **It hands x back in A**, and one of its callers
   * ($A789, the jump at its falling cap) then goes on using that as if it were
   * the speed — a slip of the original's own that decides where a jump out of
   * the bottom of a room ends up. Reproduced, not corrected.
   * @param {object} ctx — the step being run.
   * @returns {number} x before the clamp, which is what the original returns.
   */
  P.EBC0 = function (ctx) {
    var p = ctx.p;
    p[TYPE] = this.k.bouncePose;
    var descriptor = ctx.w.roomWord(p[COL], p[ROW])[0];
    var a = p[X];
    if (descriptor & RIGHT) {
      if (a >= 0xC0) { p[X] = 0xC0; }
    } else if (a >= 0xE8) {
      p[X] = 0xE8;
    }
    return a;
  }; // EBC0

  /** $A733 — the horizontal move in the air and the side borders */
  P.A733 = function (ctx) {
    var p = ctx.p, k = this.k;
    ctx.e |= p[MASK];
    p[MASK] = 0;
    p[X] = u8(p[X]+s8(p[DX]));
    if (p[X] & 0x80) { return this.A678; }
    if (p[X] >= k.wallLeftWalk) { return this.A77E; }
    if (ctx.e & LEFT) {
      p[X] = k.wallLeftWalk;
      p[DX] = u8(-s8(p[DX]));
      return this.A928;
    }
    p[MASK] |= 0x11;
    ctx.e |= FLOOR;
    if (p[X] >= k.exitLeftX) { return this.A77E; }
    p[COL] = u8(p[COL]-1);
    p[X] = k.enterRightX;
    this.enterRoom(ctx);
  }; // A733

  /** $A678 — the right border in the air; the bounce is 8 px earlier than on foot */
  P.A678 = function (ctx) {
    var p = ctx.p, k = this.k;
    if (p[X] < k.wallRightWalk) { return this.A77E; }
    if (ctx.e & RIGHT) {
      p[X] = k.wallRightJump;
      p[DX] = u8(-s8(p[DX]));
      return this.A928;
    }
    p[MASK] |= 0x11;
    ctx.e |= FLOOR;
    if (p[X] < 0xF0) { return this.A77E; }
    p[COL] = u8(p[COL]+1);
    p[X] = k.enterLeftX;
    this.enterRoom(ctx);
  }; // A678

  /**
   * $A77E — gravity while jumping. The speed is in 1/16 px per step, gravity
   * adds `gravityPerStep` and the jump caps it lower than a free fall does,
   * which is why a jump never kills and a long fall does.
   */
  P.A77E = function (ctx) {
    var p = ctx.p, k = this.k;
    var v = p[VY];
    if (!(v & 0x80) && v >= k.gravityJump) {
      // at the cap the jump becomes a tumble — and the original then moves y by
      // what $EBC0 left in A, which is **x**, not the speed. See P.EBC0.
      v = this.EBC0(ctx);
    } else {
      p[VY] = u8(v+k.gravityPerStep);
    }
    ctx.a = u8(sra4(v)+p[Y]);
    if (ctx.a >= k.floorY) {
      p[MASK] |= k.sideMaskHigh;
      if (!(ctx.e & FLOOR)) { return this.A86F; }
      return this.A89C;
    }
    return this.A7B5;
  }; // A77E

  /** $A86F — out through the open floor into the room below */
  P.A86F = function (ctx) {
    var p = ctx.p, k = this.k;
    if (ctx.a < k.exitBottomY) { return this.A7B5; }
    p[ROW] = u8(p[ROW]+1);
    p[Y] = k.enterTopYJump;
    // the room routine leaves its own value in A and $A7B5 keeps working with
    // it as if it were the new y — see enterRoom()
    ctx.a = this.enterRoom(ctx);
    return this.A7B5;
  }; // A86F

  /** $A7B5 — the ceiling: closed means a bounce, open means the room above */
  P.A7B5 = function (ctx) {
    var p = ctx.p, k = this.k;
    if (ctx.a >= k.ceilingY) { return this.A7CE; }
    if (!(ctx.e & TOP)) { return this.A7E4; }
    this.EBC0(ctx);                             // strop: taky kotoul ($A7BD)
    if (s8(p[VY]) < 0) { p[VY] = u8(-s8(p[VY])); }
    ctx.a = k.ceilingClampY;
    return this.A7CE;
  }; // A7B5

  /** $A7E4 — up through the open ceiling into the room above */
  P.A7E4 = function (ctx) {
    var p = ctx.p, k = this.k;
    p[MASK] |= k.sideMaskHigh;
    if (ctx.a >= k.exitTopY) { return this.A7CE; }
    p[ROW] = u8(p[ROW]-1);
    p[Y] = k.enterBottomY;
    this.enterRoom(ctx);
  }; // A7E4

  /** $A7CE — store y; then, once the jump counter is out, look for a rope */
  P.A7CE = function (ctx) {
    var p = ctx.p, k = this.k;
    p[Y] = ctx.a;
    var a = ctx.a-k.ropeLengthOffset;
    ctx.c = (a < 0) ? 0x02 : a;
    if (p[COUNTER] !== 0) {
      p[COUNTER] = u8(p[COUNTER]-1);
      return;
    }
    return this.A7FF;
  }; // A7CE

  /**
   * $A7FF — catching the ceiling. This is the rule the instructions describe
   * as “he catches the ceiling when he leaves a platform”: in the caves, at the
   * middle of the room, if a rope hangs there and is long enough, he grabs it.
   */
  P.A7FF = function (ctx) {
    var p = ctx.p, k = this.k, w = ctx.w;
    if (p[ROW] < k.ropeGrabRow) { return; }
    if ((w.rope.length & 0x7F) < ctx.c) { return; }
    p[FLAGS] &= 0xA7;
    var d = u8(p[X]-k.ropeGrabX);
    if (d & 0x80) { d = u8(-d); }
    if (d >= k.ropeGrabReach) { return; }
    var rope = w.record(0x8F2A);
    if (!rope || rope[TYPE] === 0) {
      // no rope entity here: he makes one out of the ceiling ($A881)
      if (!(ctx.e & TOP)) { return; }
      if (ctx.e & FLOOR) { return; }
      w.setRoomState(p[COL], p[ROW], 0x08);
      w.rope.prevTipX = 0;
      w.rope.prevTipY = 0;
      w.rope.length = 0;
      w.rope.lengthHigh = 0;
    } else if (w.rope.offset !== 0) {
      return;
    }
    return this.A835;
  }; // A7FF

  /** $A835 — he is on the rope now; the swing starts from his own speed */
  P.A835 = function (ctx) {
    var p = ctx.p, k = this.k, w = ctx.w;
    var b = ctx.c;
    if (b & 0x80) { return; }
    w.rope.length = (w.rope.length & 0x80) | b;
    p[TYPE] = k.ropePoseBase;
    w.rope.swingVel = u8(s8(p[DX]) << 3);
    var rope = w.record(0x8F2A);
    if (rope) { rope[TYPE] = 0; }
    // ropes below are cleared out while the floor is open ($A858)
    var col = p[COL], row = p[ROW];
    while (row < 52 && !(w.roomWord(col, row)[0] & FLOOR)) {
      row++;
      w.setRoomState(col, row, 0);
    }
    this.AAB0(ctx);
    return this.A365;
  }; // A835

  // -------------------------------------------------------------------------
  // $A925 — falling, and the bounce off an enemy (types $18-$1B)
  // -------------------------------------------------------------------------
  P.A925 = function (ctx) {
    return this.A928(ctx);
  }; // A925

  P.A928 = function (ctx) {
    var p = ctx.p, k = this.k;
    if (p[FLAGS] & 0x40) { return this.B72C; }
    if (p[FLAGS] & 0x80) { return this.A406; }
    this.roomWord(ctx);
    if (p[COUNTER] !== 0) { p[COUNTER] = u8(p[COUNTER]-1); }
    var thrownFall = this.E1B4(ctx);
    if (thrownFall) { return thrownFall; }
    if (!(ctx.c & 0x04)) {
      var e = ctx.e, d = ctx.d;
      this.B43E(ctx);
      ctx.e = e;
      ctx.d = d;
      if (!(ctx.c & 0x04)) { return this.A995; }
    } else if ((ctx.c & 0x03) === 0x02) {
      p[VY] = 0;
      return this.A96A;
    }
    if (!(ctx.c & 0x01)) { return this.A96A; }
    if (ctx.c & 0x02) { return this.A995; }
    return this.A95E;
  }; // A928

  /** $A95E — a glancing hit while falling: the drift flips, no landing */
  P.A95E = function (ctx) {
    var p = ctx.p, k = this.k;
    var b = (ctx.c & 0x80) ? k.walkStep : k.walkStepLeft;
    if ((b ^ p[DX]) & 0x80) { ctx.w.sound('bump'); }
    p[DX] = b;
    return this.A995;
  }; // A95E

  /** $A96A — landing on a platform or on furniture */
  P.A96A = function (ctx) {
    var p = ctx.p;
    if (!(ctx.c & 0x02)) { return this.A95E; }
    p[Y] = u8(0xA0-u8(ctx.b-1));
    return this.A8A0;
  }; // A96A

  /** $A995 — the tumble animation and the horizontal drift */
  P.A995 = function (ctx) {
    var p = ctx.p, k = this.k;
    ctx.e |= p[MASK];
    p[MASK] = 0;
    p[TYPE] = u8(((ctx.w.counters.step >> 1) & k.fallPoseMask) + k.fallPoseBase);
    if (p[DX] !== 0 || (p[X] & 0x80)) {
      p[X] = u8(p[X]+s8(p[DX]));
      if (p[X] & 0x80) { return this.A8EF; }
    }
    if (p[X] >= k.wallLeftWalk) { return this.A9F5; }
    if (ctx.e & LEFT) {
      p[DX] = u8(-s8(p[DX]));
      p[X] = k.wallLeftWalk;
      return this.A9F5;
    }
    p[MASK] |= 0x11;
    ctx.e |= FLOOR;
    if (p[X] >= k.exitLeftX) { return this.A9F5; }
    p[COL] = u8(p[COL]-1);
    p[X] = k.enterLeftXFall;
    this.enterRoom(ctx);
  }; // A995

  /** $A8EF — the right border while falling */
  P.A8EF = function (ctx) {
    var p = ctx.p, k = this.k;
    if (p[X] < k.wallRightFall) { return this.A9F5; }
    if (ctx.e & RIGHT) {
      p[DX] = u8(-s8(p[DX]));
      p[X] = k.wallRightFall;
      return this.A9F5;
    }
    p[MASK] |= 0x11;
    ctx.e |= FLOOR;
    if (p[X] < 0xE8) { return this.A9F5; }
    p[COL] = u8(p[COL]+1);
    p[X] = k.enterLeftX;
    this.enterRoom(ctx);
  }; // A8EF

  /** $A9F5 — gravity in a free fall; the cap here is higher than in a jump */
  P.A9F5 = function (ctx) {
    var p = ctx.p, k = this.k;
    var v = p[VY];
    if ((v & 0x80) || v < k.gravity) { p[VY] = u8(v+k.gravityPerStep); }
    p[Y] = u8(sra4(v)+p[Y]);
    ctx.a = p[Y];
    if (p[Y] < k.floorY) { return this.A7B5; }
    p[MASK] |= k.sideMaskHigh;
    if (ctx.e & FLOOR) { return this.A89C; }
    if (p[Y] < k.exitBottomY) { return; }
    p[ROW] = u8(p[ROW]+1);
    p[Y] = k.enterTopYFall;
    this.enterRoom(ctx);
  }; // A9F5

  P.A89C = function (ctx) {
    ctx.p[Y] = this.k.floorY;
    return this.A8A0;
  }; // A89C

  /**
   * $A8A0 — the landing, and with it the only mechanic in the game that kills:
   * coming down faster than `deathVelocity` (1/16 px per step). A gem makes him
   * invincible to it ($8EEE).
   */
  P.A8A0 = function (ctx) {
    var p = ctx.p, k = this.k;
    if (!ctx.w.invincible && !(p[VY] & 0x80) && p[VY] >= k.deathVelocity) {
      return this.E7D0;
    }
    ctx.w.sound('land');
    p[TYPE] = u8((((p[TYPE]-1) << 2) & 0x04) + k.landPose);
    p[FLAGS] &= ~0x80;
  }; // A8A0

  /** $A8C9 — he reaches the ground while hanging: stand up, leave the rope */
  P.A8C9 = function (ctx) {
    var p = ctx.p, k = this.k;
    p[Y] = k.floorY;
    p[TYPE] = u8(k.ropeLandPose + ((p[DX] & 0x80) ? 0 : 4));
    return this.A8DA(ctx);
  }; // A8C9

  /** $A8DA — the rope is left behind as an entity of its own */
  P.A8DA = function (ctx) {
    var rope = ctx.w.record(0x8F2A);
    if (rope) {
      rope[TYPE] = this.k.ropeEntityType;
      rope[DX] = 0x03;
    }
    if (ctx.p[FLAGS] & 0x40) { return this.B72C; }
  }; // A8DA

  // -------------------------------------------------------------------------
  // dying and the respawn ($E7D0, $E7E3) — the respawn is on the same spot
  // -------------------------------------------------------------------------
  P.E7D0 = function (ctx) {
    var p = ctx.p, k = this.k;
    p[TYPE] = u8(((p[TYPE] >> 2) & 0x01) + k.deathPose);
    p[COUNTER] = k.deathFrames;
    ctx.w.sound('death');
  }; // E7D0

  P.E7E3 = function (ctx) {
    var p = ctx.p, w = ctx.w;
    p[COUNTER] = u8(p[COUNTER]-1);
    if (p[COUNTER] !== 0) { return; }
    if (w.lives === 0) {
      w.gameOver();
      return;
    }
    w.lives--;                          // v originalu BCD na $8EDA
    var x = p[X], col = p[COL], y = p[Y], row = p[ROW];
    var spawn = this.spawn();
    for (var i = 0; i < 16; i++) { p[i] = spawn[i]; }
    p[X] = x;
    p[COL] = col;
    p[Y] = y;
    p[ROW] = row;
    p[MASK] = 0x10;
    w.respawn();
    this.enterRoom(ctx);
  }; // E7E3

  // -------------------------------------------------------------------------
  // hanging on a rope ($A316, types $01-$08)
  // -------------------------------------------------------------------------
  P.A316 = function (ctx) {
    var p = ctx.p, k = this.k, w = ctx.w;
    if (p[FLAGS] & 0x48) { return this.A3A5; }
    var thrownRope = this.E1B4(ctx);
    if (thrownRope) { return thrownRope; }
    if (!(ctx.c & 0x04)) { this.B43E(ctx); }
    ctx.b = k.ropeKnockVel;                     // $A32D: LD B,$10 pro oba senzory
    if (ctx.c & 0x04) { return this.E87B; }
    this.E833(ctx);                             // nepritel si nese vlastni impuls
    if (ctx.c & 0x04) { return this.E87B; }
    var col = p[COL], row = p[ROW];
    this.AAB0(ctx);
    if (p[COL] !== col || p[ROW] !== row) { return this.A365; }
    var input = w.input;
    if (input.release) { return this.A3A5; }
    this.B4D1(w, input.fire);              // $A6E4 / $A6E9
    return this.A365;
  }; // A316

  /** $A365 — his position is the end of the rope, offset by the hands */
  P.A365 = function (ctx) {
    var p = ctx.p, k = this.k, w = ctx.w;
    var hand = k.ropeHandX;                         // $F80C: x -$0C, y +8
    var x = u8(w.rope.tipX-(hand & 0xFF));
    var carry = (w.rope.tipX-(hand & 0xFF)) < 0 ? 1 : 0;
    var y = u8(w.rope.tipY-(hand >> 8)-carry);
    this.roomWord(ctx);
    p[X] = x;
    p[Y] = y;
    p[DX] = w.rope.swingVel;
    if (y >= k.floorY && (ctx.e & FLOOR)) {
      return this.A8C9;
    }
    p[TYPE] = u8(((x >> 3) & 0x03) + k.ropePoseBase + ((p[DX] & 0x80) ? 0 : 4));
    this.AB54(ctx);
  }; // A365

  /** $A3A5 — letting go: he keeps the speed the end of the rope had */
  P.A3A5 = function (ctx) {
    var p = ctx.p, k = this.k, w = ctx.w;
    p[VY] = u8(u8(w.rope.tipY-w.rope.prevTipY) << 3);
    p[DX] = u8(w.rope.tipX-w.rope.prevTipX);
    p[TYPE] = u8(k.ropeReleasePose + ((p[DX] & 0x80) ? 0 : 1));
    p[COUNTER] = k.ropeReleaseFrames;
    if (p[DX] === 0 && p[VY] === 0) { p[VY] = k.ropeReleaseVel; }
    return this.A8DA;
  }; // A3A5

  /** $E87B — knocked off the rope: no control for `bounceFrames` steps */
  P.E87B = function (ctx) {
    var p = ctx.p, k = this.k, w = ctx.w;
    p[DX] = u8(w.rope.tipX-w.rope.prevTipX);
    p[VY] = ctx.b;
    p[TYPE] = k.bouncePose;
    p[COUNTER] = k.bounceFrames;
    return this.A8DA;
  }; // E87B

  /** $E894, $E898 — the bounce off an enemy; the impulse is the enemy's own */
  P.E894 = function (ctx) {
    ctx.p[COUNTER] = this.k.bounceFrames;
    return this.E898(ctx);
  }; // E894

  P.E898 = function (ctx) {
    ctx.p[VY] = ctx.b;
    ctx.p[TYPE] = this.k.bouncePose;
  }; // E898

  /** $A3E9 — contact while standing: a full-on hit kills, a graze bounces */
  P.A3E9 = function (ctx) {
    var p = ctx.p, k = this.k;
    p[DX] = (ctx.c & 0x80) ? k.walkStepLeft : k.walkStep;
    if (!(ctx.c & 0x01)) { return this.E7D0; }
    p[TYPE] = k.bouncePose;
    p[VY] = k.standBounceVel;
  }; // A3E9

  /** $A406 — dropped by something that carried him (M5: the eagles) */
  P.A406 = function (ctx) {
    var p = ctx.p, k = this.k;
    p[TYPE] = k.bouncePose;
    p[VY] = k.standBounceVel;
    p[FLAGS] &= ~0x80;
    if (p[DX] !== 0) {
      p[DX] = u8(-s8(p[DX]));
      return;
    }
    p[DX] = (ctx.w.counters.frame & 0x80) ? k.walkStepLeft : k.walkStep;
  }; // A406

  /** $E8A2 — something shoved him (flag bit 3): a tumble with no control */
  P.E8A2 = function (ctx) {
    var p = ctx.p, k = this.k;
    p[TYPE] = u8((ctx.w.counters.frame & 0x03) + k.fallPoseBase);
    p[FLAGS] &= 0xE7;
    p[Y] = u8(p[Y]-1);
    p[COUNTER] = k.bounceFrames;
    return this.A928;
  }; // E8A2

  /**
   * $E272 — walking into something he is already inside of throws him off it:
   * a tumble, a push downwards, and `throwFrames` steps with no control.
   */
  P.E272 = function (ctx) {
    var p = ctx.p, k = this.k;
    p[TYPE] = k.bouncePose;
    p[COUNTER] = k.throwFrames;
    p[VY] = k.throwVelocity;
    p[MASK] = 0;
  }; // E272

  /**
   * $B72C — an eagle has him. The eagle ($B0CD) sets bit 6 of his flags, every
   * handler above checks it first, and this turns him into the carried pose
   * $60 and hands the step over to $E582, which is in app/monsters.js (M5)
   * because it is the eagle's routine that decides where he ends up.
   */
  P.B72C = function (ctx) {
    var p = ctx.p;
    p[FLAGS] &= ~0x40;
    p[FLAGS] &= ~0x20;
    p[MASK] = 0;
    p[TYPE] = 0x60;
    if (ctx.w.carriedPlayer) { ctx.w.carriedPlayer(); }
    else { ctx.w.unported('$B72C'); }
  }; // B72C

  // -------------------------------------------------------------------------
  // the rope pendulum: $AAB0 (a step), $ABE5 (the swing), $AB78 (the position)
  // -------------------------------------------------------------------------

  /** $AAB0 — one step of the rope: pumping, climbing, the swing, the position */
  P.AAB0 = function (ctx) {
    var k = this.k, w = ctx.w, rope = w.rope;
    var input = w.input;
    var reach = Math.abs(s8(rope.offset));
    var limit = ((rope.lengthHigh << 8 | rope.length) >> 3) & 0x3F;
    if (limit > k.ropePumpLimit) { limit = k.ropePumpLimit; }
    if (limit >= reach) {
      if (input.right) { rope.swingVel = u8(rope.swingVel+k.ropePumpStep); }
      if (input.left) { rope.swingVel = u8(rope.swingVel-k.ropePumpStep); }
    }
    if (input.down) { this.AAF4(ctx); }
    if (input.up) { this.AB30(ctx); }
    this.ABE5(ctx);
    this.AB78(ctx);
  }; // AAB0

  /** $AAF4 — the down key pays out rope; past the room border it grows into the next */
  P.AAF4 = function (ctx) {
    var k = this.k, w = ctx.w, p = ctx.p, rope = w.rope;
    var len = (rope.lengthHigh << 8 | rope.length)+k.ropeClimbStep;
    if ((len & 0x7E) !== 0) { return this.setRopeLength(w, len); }
    this.roomWord(ctx);
    if (ctx.e & FLOOR) { return this.setRopeLength(w, len-1); }
    len += k.ropeClimbStep;
    this.setRopeLength(w, len);
    var rooms = (len << 1) >> 8;
    w.setRoomState(p[COL], p[ROW], (rooms-1) | 0x0C);
    p[ROW] = u8(p[ROW]+1);
    w.setRoomState(p[COL], p[ROW], rooms & 0xFB);
    this.enterRoom(ctx);
  }; // AAF4

  /** $AB30 — the up key pulls him up the rope */
  P.AB30 = function (ctx) {
    var k = this.k, w = ctx.w, p = ctx.p, rope = w.rope;
    var len = rope.lengthHigh << 8 | rope.length;
    if (rope.lengthHigh === 0 && rope.length < k.ropeMinLength) { return; }
    len -= k.ropeClimbStep;
    if ((len & 0x7E) !== 0) { return this.setRopeLength(w, len); }
    this.setRopeLength(w, len);
    w.setRoomState(p[COL], p[ROW], 0);
    p[ROW] = u8(p[ROW]-1);
    this.enterRoom(ctx);
  }; // AB30

  P.setRopeLength = function (w, len) {
    w.rope.length = len & 0xFF;
    w.rope.lengthHigh = (len >> 8) & 0xFF;
  }; // setRopeLength

  /**
   * $ABE5 — the swing itself. The sideways offset is a 16-bit accumulator
   * (low byte $AAA3, high byte = the offset in px), the speed is in 1/32 px per
   * step, and gravity pulls it back to the middle by `ropeSwingAccel`. Every
   * eighth step that pull is skipped, which is where the swing loses energy.
   */
  P.ABE5 = function (ctx) {
    var k = this.k, w = ctx.w, rope = w.rope;
    var offset = rope.offset;
    if (offset === 0 && rope.swingVel === 0) { return; }
    if (offset & 0x80) {
      if ((rope.swingVel & 0x80) || (w.counters.step & k.ropeSwingDamp) !== 0) {
        rope.swingVel = u8(rope.swingVel+k.ropeSwingAccel);
      }
    } else {
      if (!(rope.swingVel & 0x80) || (w.counters.frame & k.ropeSwingDamp) !== 0) {
        rope.swingVel = u8(rope.swingVel-k.ropeSwingAccel);
      }
    }
    var acc = (rope.offset << 8 | rope.accLow) | 0;
    if (acc & 0x8000) { acc -= 0x10000; }
    acc += s8(rope.swingVel)*k.ropeSwingScale;
    acc = acc << 16 >> 16;                      // back to a signed 16 bit value
    var len = rope.lengthHigh << 8 | rope.length;
    if ((((len >> 1) & 0xFF) & 0xC0) !== 0) {   // $AC38: dlouhe lano se neomezuje
      return this.storeSwing(rope, acc);
    }
    var limit = (rope.length*k.ropeAmplitude) >> 8;      // $AC3F: delka * $B0 / 256
    var high = (acc >> 8) & 0xFF;
    if (high & 0x80) {                          // $AC52: NEG A; CP H
      if (u8(-limit) <= high) { return this.storeSwing(rope, acc); }
      rope.offset = u8(-limit);
    } else {                                    // $AC4B: CP H
      if (limit >= high) { return this.storeSwing(rope, acc); }
      rope.offset = u8(limit);
    }
    rope.accLow = 0;                            // $AC5D: na mezi se kyv zastavi
    rope.swingVel = 0;
  }; // ABE5

  P.storeSwing = function (rope, acc) {
    rope.accLow = acc & 0xFF;
    rope.offset = (acc >> 8) & 0xFF;
  }; // storeSwing

  /**
   * $AB78 — where the end of the rope is: the offset is the horizontal leg and
   * the length the hypotenuse, so the drop is sqrt(len^2 - offset^2) — the
   * original really does compute a square root ($AE56) for it.
   */
  P.AB78 = function (ctx) {
    var k = this.k, w = ctx.w, rope = w.rope;
    var offset = Math.abs(s8(rope.offset));
    var square = u16(offset*offset);
    var len = rope.lengthHigh << 8 | rope.length;
    var drop;
    if (rope.lengthHigh !== 0) {
      var half = (len >> 1) & 0xFF;
      drop = isqrt(u16(u16(half*half)-(square >> 1)));
    } else {
      drop = isqrt(u16(u16(rope.length*rope.length)-square));
    }
    var twice = (len << 1) & 0xFFFF;
    var high = twice >> 8;
    var y;
    if (high === 0) {
      y = u8(drop+k.ropeTipOffsetY);
      rope.anchorX = 0x80;
      rope.anchorY = 0x24;
    } else {
      var c = (high & 1) ? 0x58 : 0xD7;
      var a = (high & 2) ? u8(drop << 1) : drop;
      y = u8(a-c);
      rope.anchorX = 0x80;
      rope.anchorY = 0x10;
    }
    rope.tipY = u8(y+k.ropeTipOffsetY2);
    rope.tipX = u8(rope.offset+k.ropeAnchorX);
  }; // AB78

  /** $AB54 — the end of the rope of the previous step, for the redraw */
  P.AB54 = function (ctx) {
    var rope = ctx.w.rope;
    rope.prevTipX = rope.tipX;
    rope.prevTipY = rope.tipY;
  }; // AB54

  /**
   * $AA4C — a rope with nobody on it: it grows to `ropeMaxLength` and its
   * swing dies down by `ropeFreeDecay` px per step.
   */
  P.AA4C = function (ctx) {
    var k = this.k, w = ctx.w, rec = ctx.p, rope = w.rope;
    var len = rope.lengthHigh << 8 | rope.length;
    if ((rope.length & 0x7F) < k.ropeMaxLength) {
      this.setRopeLength(w, len+1);
      rec[FLAGS] |= 0x01;
    }
    var offset = s8(rope.offset);
    if (offset !== 0) {
      rec[DX] = 0x03;
      offset += (offset < 0) ? k.ropeFreeDecay : -k.ropeFreeDecay;
      if ((offset < 0) !== (s8(rope.offset) < 0)) { offset = 0; }
      rope.offset = u8(offset);
    }
    if (rec[DX] !== 0) {
      rec[DX] = u8(rec[DX]-1);
      rec[FLAGS] |= 0x01;
    }
    this.AB78(ctx);
    this.AB54(ctx);
  }; // AA4C

  function u16(v) { return v & 0xFFFF; }

  /** $AE56 — the integer square root the rope geometry runs on */
  function isqrt(value) {
    var root = 0;
    for (var bit = 1 << 14; bit > 0; bit >>= 2) {
      if (root+bit <= value) {
        value -= root+bit;
        root = (root >> 1)+bit;
      } else {
        root >>= 1;
      }
    }
    return root & 0xFF;
  } // isqrt

  SabremanPhysics.isqrt = isqrt;
  SabremanPhysics.FIELDS = {TYPE: TYPE, X: X, COL: COL, Y: Y, ROW: ROW, ATTR: ATTR,
                            DX: DX, WALK: WALK, VY: VY, COUNTER: COUNTER,
                            MASK: MASK, CONTACT: CONTACT, FLAGS: FLAGS};
  SabremanPhysics.SIDES = {TOP: TOP, RIGHT: RIGHT, FLOOR: FLOOR, LEFT: LEFT};
  return SabremanPhysics;
})();

if (typeof self !== 'undefined') { self.SabremanPhysics = SabremanPhysics; }
if (typeof module !== 'undefined' && module.exports) { module.exports = SabremanPhysics; }
