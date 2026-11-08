// begin code

/**
 * Underwurlde — the monsters, the weapons, the guardians and the score (M5).
 *
 * M4 found out **where** the world puts its entities (worldEntities.js). This
 * file is **what they do there**, and like everything before it, it is a
 * transcription of the original's own routines, not a design. The numbers come
 * out of data/monsters.json, which tools/dumpmonsters.py reads as the operands
 * of the actual instructions in the game's runtime image; the control flow is
 * the disassembly (runtime addresses, sources/docs/disasm_notes.md chap. 15):
 *
 *   $AFDA  the generator (M4 had it; the monsters it makes now move)
 *   $B079  a flying monster in Sabreman's room   types $30-$33, $40-$43
 *   $EE66  the same, but the direction is drawn  types $34-$37
 *   $B3D8  a gargoyle: falls, fixed sideways     types $44-$47
 *   $B2CF / $B358  a monster in another room, working its way to his
 *   $B4D1  firing, $B57A / $B58C  a shot in flight
 *   $DEE8  a shot that hit a wall, $DF15 the puff a killed monster leaves
 *   $E8D7  a weapon: lying, carried, dropped     types $68-$6B
 *   $B0BB / $E2CB / $E570  an eagle picking Sabreman up and carrying him
 *   $ECCA  a guardian, $ED2E the exit that appears in its room
 *   $A045  the score
 *
 * Three findings worth naming, because they close open questions of ZADANI:
 *
 * - **which weapon kills which guardian** is not a table of pairs but a table
 *   of *projectiles* ($B753, four bytes): a weapon of type $68+i fires
 *   projectile `table[i]`, and $ECFA lets a guardian die only to a projectile
 *   for which `((projectile >> 1) - 1) & 3 == (type >> 1) & 3`. The catapult's
 *   stone is the one projectile below $6C, and $ECF6 throws everything below
 *   $6C away — so **the catapult cannot kill any guardian at all**. The other
 *   three come out as bow → arrow → the horned one, torch → fireball → the
 *   devil, sword → dagger → the beetle, which is exactly what the period tips
 *   said and the opposite of what Wikipedia says (ZADANI chap. 8).
 * - **Sabreman carries up to three weapons, not one.** They are drawn side by
 *   side in the panel at x = $88, $A0, $B8, their types live in the three
 *   bytes $8EEB-$8EED, and every press of the take/drop key shifts them all
 *   $18 to the right; the one that gets past $C8 falls out ($E939). He always
 *   fires with the leftmost one ($B4D7 searches from $8EEB).
 * - **the score has exactly two sources** in the whole program ($A045 is
 *   called from $DF4A and $E78C and nowhere else): a killed monster is worth
 *   `BCD(type) - 1` in the *low* byte, a picked-up item `type >> 1` in the
 *   *middle* one. There is no routine anywhere that scores the percentage of
 *   rooms visited, which is what Crash 12 and Wikipedia claim.
 *
 * The state is the game's own 16-byte entity record, so a step of this code
 * and a step of the original are directly comparable — that is what
 * tools/matchmonsters.js does, against runs recorded by
 * tools/tracemonsters.py.
 */

function installMonsters(WorldEntities) {
  'use strict';

  var TYPE = 0, X = 1, COL = 2, Y = 3, ROW = 4, ATTR = 5, DX = 6, SPARE7 = 7,
      VX = 8, VY = 9, LOWX = 10, MASK = 11, HEIGHT = 12, LOWY = 13,
      PHASE = 14, FLAGS = 15;
  var STRIDE = WorldEntities.STRIDE;
  var SLOT = WorldEntities.SLOT;

  // the descriptor byte of a room: which sides are closed ($9DA0)
  var TOP = 0x01, RIGHT = 0x04, FLOOR = 0x10, LEFT = 0x40;

  var W = WorldEntities.prototype;

  function u8(v) { return v & 0xFF; }
  function s8(v) { v &= 0xFF; return (v & 0x80) ? v-256 : v; }
  /** SRA A four times — the arithmetic shift the original uses on a speed */
  function sra4(v) { return s8(v) >> 4; }
  /** RLA — rotate left through carry; returns [value, carry] */
  function rla(v, carry) { return [u8((v << 1) | (carry & 1)), (v >> 7) & 1]; }

  /** DEC A / DAA with N set — the original's way of taking one off a BCD byte */
  function bcdDec(value) {
    var low = value & 0x0F, high = value >> 4;
    if (low === 0) { low = 9; high = (high === 0) ? 15 : high-1; }
    else if (low > 9) { low -= 7; }
    else { low--; }
    return u8((high << 4) | (low & 0x0F));
  } // bcdDec

  /** ADD A,n / DAA — a BCD add of one byte; returns [sum, carry] */
  function bcdAdd(a, b, carryIn) {
    var low = (a & 0x0F) + (b & 0x0F) + (carryIn ? 1 : 0);
    var high = (a >> 4) + (b >> 4);
    if (low > 9) { low -= 10; high++; }
    var carry = 0;
    if (high > 9) { high -= 10; carry = 1; }
    return [((high & 0x0F) << 4) | (low & 0x0F), carry];
  } // bcdAdd

  // ===========================================================================
  // The state the original keeps outside the entity records
  // ===========================================================================

  /**
   * Everything of M5 that is a global of the game rather than a byte of an
   * entity record. Called from the WorldEntities constructor, so that a world
   * built without data/monsters.json still works (the placement tools do that).
   */
  W.initMonsters = function (data) {
    this.m = (data && data.values) || null;
    this.projectiles = (data && data.projectiles && data.projectiles.raw
                        && data.projectiles.raw.map(function (s) {
                          return parseInt(s.slice(1), 16);
                        })) || [];
    this.carried = [0, 0, 0];        // $8EEB-$8EED — the types he is carrying
    this.takeHeld = 0;               // $8EE9 — the take/drop key is down
    this.takePulse = 0;              // $8EEA — $FF for the one pass after a press
    this.fireCounter = 0;            // $AAAB — the rate limit on firing
    this.eagles = 0;                 // $8EF9 — set by the first dead guardian
    this.score = [0, 0, 0];          // $8EF3-$8EF5, BCD, most significant first
    this.carryLatch = 0;             // $8EF2 — an eagle is holding him
    this.carryLatchNext = 0;         // $8EF1 — and says so every pass
    // The one number of M5 that cannot be transcribed: $B749 is `LD A,R`, the
    // Z80's memory refresh register, which counts instructions and is not
    // reproducible outside a Z80. It picks the height an eagle carries him to,
    // and nothing else reads it — so the remake keeps a counter of its own
    // that turns over the same way (see tools/matchmonsters.js, which reports
    // this one byte separately instead of hiding it).
    this.refresh = 0;
  }; // initMonsters

  /** the panel's six digits */
  W.scoreValue = function () {
    var out = 0;
    for (var i = 0; i < 3; i++) {
      out = out*100 + (this.score[i] >> 4)*10 + (this.score[i] & 0x0F);
    }
    return out;
  }; // scoreValue

  /**
   * $A045 — add B (hundreds) and C (units) to the three BCD bytes of the
   * score. C does not go in as it is: `DEC A / DAA` takes one off it in BCD
   * first, which is why a monster of type $40 is worth 39 and not 64.
   */
  W.addScore = function (b, c) {
    var sum = bcdAdd(bcdDec(c), this.score[2], 0);
    this.score[2] = sum[0];
    sum = bcdAdd(this.score[1], b, sum[1]);
    this.score[1] = sum[0];
    sum = bcdAdd(this.score[0], 0, sum[1]);
    this.score[0] = sum[0];
  }; // addScore

  /**
   * $94E2 — the main loop reads the take/drop half-row itself. A fresh press
   * clears the three carried slots and raises $8EEA for exactly one pass; the
   * weapons then re-register themselves one place further right, and whichever
   * falls off the end drops. Every later pass with the key still down sees a
   * zero and leaves them where they are.
   */
  W.takeKey = function (down) {
    if (!down) { this.takeHeld = 0; this.takePulse = 0; return; }
    if (this.takeHeld === 0) {
      this.carried[0] = this.carried[1] = this.carried[2] = 0;
      this.takeHeld = 0xFF;
      this.takePulse = 0xFF;
      return;
    }
    this.takePulse = 0;
  }; // takeKey

  /** which weapon he fires with: the leftmost one he carries ($B4D7) */
  W.activeWeapon = function () {
    var m = this.m;
    for (var i = 0; i < m.carriedCount; i++) {
      if ((this.carried[i] & m.weaponTypeMask) === m.weaponTypeBase) {
        return this.carried[i];
      }
    }
    return 0;
  }; // activeWeapon

  // ===========================================================================
  // $B4D1 — firing
  // ===========================================================================

  /**
   * $B4D1. Two shots can be in the air at once; while either is, the trigger
   * only takes every eighth pass ($B4F9). The shot starts as a copy of
   * Sabreman's first six bytes, eight pixels to the side he faces and eight
   * above him, with a sideways speed drawn out of the two counters and an
   * upwards one out of FRAMES — so no two shots fly quite the same.
   */
  W.fire = function (world) {
    var m = this.m, player = world.player;
    if (!m) { return; }
    if (player[FLAGS] & 0x01) { return; }
    var weapon = this.activeWeapon();
    if (!weapon) { return; }

    var shot0 = this.records[m.shotSlot0], shot1 = this.records[m.shotSlot1];
    var busy = shot0[TYPE] | shot1[TYPE];
    if (busy !== 0) { this.fireCounter = u8(this.fireCounter+1); }
    else { this.fireCounter = 0; }
    if ((this.fireCounter & m.fireRateMask) !== 0) { return; }

    var shot = shot0;
    if (shot0[TYPE] !== 0) {
      if (shot1[TYPE] !== 0) { return; }
      shot = shot1;
    }
    for (var i = 0; i < m.shotCopyBytes; i++) { shot[i] = player[i]; }

    var speed = u8(((world.counters.frame & 0xFF) + (world.counters.step & 0xFF))
                   & m.shotSpeedMask) | m.shotSpeedOr;
    var type = this.projectiles[weapon & 0x03];

    // the pose says which way he faces; $B533 takes two off the high poses
    var pose = player[TYPE];
    pose = u8(pose >= m.shotPoseLimit ? pose-m.shotPoseHigh : pose-1);

    var x, carry;
    if (pose & m.shotFacingMask) {
      x = shot[X] + m.shotXOffset;
      carry = x > 0xFF ? 1 : 0;
      x = u8(x);
    } else {
      x = shot[X] - m.shotYOffset;
      if (x < 0) { shot[TYPE] = 0; return; }     // $B576 — no room to his left
      carry = 0;
      speed = u8(~speed);
      type = u8(type+1);
    }
    shot[X] = x;
    shot[TYPE] = type;
    shot[Y] = u8(shot[Y]-m.shotYOffset);
    shot[DX] = 0;
    shot[VX] = speed;
    var rotated = rla(world.counters.frame & 0xFF, carry);
    rotated = rla(rotated[0], rotated[1]);
    shot[VY] = u8(-(rotated[0] & m.shotVyMask));
    shot[MASK] = player[MASK];
    shot[FLAGS] = 1;
  }; // fire

  /** $A360 — the trigger let go: the next press fires without waiting */
  W.fireReleased = function () { this.fireCounter = 0xFF; }; // fireReleased

  // ===========================================================================
  // $B6E8 — has one of the two shots hit this entity?
  // ===========================================================================

  /**
   * Returns the projectile's type when it has, and 0 when it has not. The shot
   * is marked spent by its own byte +7, which its handler reads next pass.
   */
  W.shotHit = function (record) {
    var m = this.m;
    var hit = this.shotHitOne(this.records[m.hitSlot0], record);
    if (hit) { return hit; }
    return this.shotHitOne(this.records[m.hitSlot1], record);
  }; // shotHit

  W.shotHitOne = function (shot, record) {
    var m = this.m;
    if (shot[TYPE] === 0) { return 0; }
    var dx = s8(shot[X]-record[X]+m.hitOffset);
    if (Math.abs(dx) >= m.hitWindowX) { return 0; }
    if (shot[COL] !== record[COL]) { return 0; }
    var dy = s8(shot[Y]-record[Y]+m.hitOffsetY);
    if (Math.abs(dy) >= m.hitWindowY) { return 0; }
    if (shot[ROW] !== record[ROW]) { return 0; }
    shot[SPARE7] = 1;
    return shot[TYPE];
  }; // shotHitOne

  // ===========================================================================
  // $DF42 — something died
  // ===========================================================================

  /** score, then the entity turns into the puff of type $4C for nine steps */
  W.killed = function (world, record) {
    var m = this.m;
    world.sound('kill');
    this.addScore(0, record[TYPE]);
    record[TYPE] = m.deathType;
    record[VX] = m.deathSteps;
    this.draw(record);
  }; // killed

  /** $96CB — the draw the original ends a step with; it clears the redraw bit */
  W.draw = function (record) {
    if (record[FLAGS] & 1) { record[FLAGS] &= ~1; }
  }; // draw

  /** $96E1 — the same for a weapon, whose redraw bit lives in byte +7 */
  W.drawWeapon = function (record) {
    if (record[SPARE7] & 1) { record[SPARE7] &= ~1; }
  }; // drawWeapon

  // ===========================================================================
  // $B079 — a flying monster
  // ===========================================================================

  /**
   * The chase itself: both speeds grow by 2/16 px a step towards Sabreman and
   * are capped at $40 (4 px a step) either way, so a monster overshoots and
   * comes back — the drifting, wheeling flight of the original. Everything
   * else here is what happens when it meets the room: the walls, the floor,
   * the ceiling, the four ways out and the furniture.
   */
  W.flyer = function (world, record) {
    var m = this.m, player = world.player;
    var desc = u8(world.roomWord(record[COL], record[ROW])[0] | record[MASK]);
    if (player[COL] !== record[COL]) {
      return this.approachX(world, record, desc, player[COL] < record[COL]);
    }
    if (player[ROW] !== record[ROW]) {
      return this.approachY(world, record, desc, player[ROW] < record[ROW]);
    }

    // $B09F — only an eagle picks him up, and only well inside the room
    if ((record[TYPE] & m.eagleTypeMask) === m.eagleType
        && !(record[FLAGS] & 1)
        && record[X] < m.grabXMax && record[X] >= m.grabXMin
        && record[Y] < m.grabYMax && record[Y] >= m.grabYMin
        && player[TYPE] >= m.grabPlayerMin) {
      var contact = this.contact(world, record);
      if ((contact & m.grabContactMask) === m.grabContactValue) {
        record[TYPE] = m.carryingType;
        player[FLAGS] = m.carriedFlag;
        this.carryLatch = 1;
        return this.carrier(world, record, true);
      }
    }

    // $B0E4 — the wings, and bit 1 of the type is which way it faces
    var phase = (world.counters.step >> 1) & 1;
    var type = u8((record[TYPE] & 0xFE) + phase);
    record[TYPE] = (record[VX] & 0x80) ? (type | 0x02) : (type & 0xFD);

    this.chase(record, VX, player[X]-record[X] < 0, m.chaseAccel,
               m.chaseSpeedCap, m.chaseDecel, m.chaseSpeedFloor);
    this.chase(record, VY, player[Y]-record[Y] < 0, m.chaseAccel,
               m.chaseSpeedCap, m.chaseDecel, m.chaseSpeedFloor);
    return this.flyerMove(world, record, desc);
  }; // flyer

  /**
   * $B10C / $B218 — one axis of the chase. The original stores the new speed
   * only when it is still inside the cap, and the two directions test it
   * differently because the byte is a two's complement one.
   */
  W.chase = function (record, offset, towardsLess, accel, cap, decel, floor) {
    var value;
    if (towardsLess) {
      value = u8(record[offset]-decel);
      if (!(value & 0x80)) { record[offset] = value; return; }
      if (value < floor) { return; }
      record[offset] = value;
      return;
    }
    value = u8(record[offset]+accel);
    if (value & 0x80) { record[offset] = value; return; }
    if (value >= cap) { return; }
    record[offset] = value;
  }; // chase

  /**
   * $B132 — the rest of a flying monster's step: is it being shot at, is it
   * touching Sabreman, is it standing in something, and then the move itself.
   */
  W.flyerMove = function (world, record, desc) {
    var m = this.m, player = world.player;
    if (!(record[FLAGS] & 1)) {
      if (this.shotHit(record)) { return this.killed(world, record); }
      var contact = this.contact(world, record);
      if (contact & 0x04) {                       // $B148 — it shoves him
        var dx = 0x03, flag = 0x08;
        if (contact & 0x80) { dx = 0xFD; flag = 0x18; }
        player[FLAGS] |= flag;
        player[DX] = dx;
      }
    }
    var sensor = this.obstacles(world, record);
    var c = sensor.c;

    // $B16C — and only some of these ways out reach the sideways bounce
    var sideways = false;
    if (c & 0x04) {
      if (c & 0x02) {
        if (c & 0x20) { sideways = true; }
        else {
          var up = u8(record[VY]-2);
          if (!(up & 0x80)) {                     // $B17D JP M — otherwise nothing
            record[VY] = u8(~up);
            record[Y] = u8(record[Y]-2);
          }
        }
      } else if (c & 0x01) { sideways = true; }
      else {
        var down = u8(record[VY]+2);
        if (down & 0x80) { record[VY] = u8(~down); }
        sideways = true;                          // $B19A falls into $B19E
      }
    }
    if (sideways) {
      var side = record[VX];
      if (c & 0x80) {
        side = u8(side+2);
        if (side & 0x80) { record[VX] = u8(~side); }
      } else {
        side = u8(side-2);
        if (!(side & 0x80)) { record[VX] = u8(~side); }
      }
    }

    // $B1B9 — the move, a sixteenth of a pixel at a time
    record[MASK] &= m.sideMaskX;
    var moved = this.step16(record, VX, X, LOWX);
    desc = this.flyerX(world, record, desc, moved);
    if (desc === null) { return; }
    record[MASK] &= m.sideMaskY;
    moved = this.step16(record, VY, Y, LOWY);
    this.flyerY(world, record, desc, moved);
  }; // flyerMove

  /** $EE42 / $EE54 — x (or y) plus speed/16, keeping the fraction in +$0A/+$0D */
  W.step16 = function (record, speed, whole, low) {
    var total = (s8(record[speed]) << 4) + (record[whole] << 8) + record[low];
    record[low] = total & 0xFF;
    return (total >> 8) & 0xFF;
  }; // step16

  /** $B1CF — the horizontal half: walls, and the two ways out sideways */
  W.flyerX = function (world, record, desc, x) {
    var m = this.m;
    if (x >= 0x80) {
      if (x >= m.flyXMax) {
        if (!(desc & RIGHT)) {
          if (x >= m.flyEdgeRight) {              // $B25E — out to the right
            record[COL] = u8(record[COL]+1);
            record[X] = m.flyEnterLeft;
            return null;                        // $B26E — $9636 only redraws
          }
          record[MASK] |= m.sideMaskSetX;
          desc |= m.sideMaskSetX;
        } else {
          record[VX] = u8(~record[VX]);
          x = m.flyXClampRight;
        }
      }
    } else if (x < m.flyXMin) {
      if (desc & LEFT) {
        record[VX] = u8(~record[VX]);
        x = m.flyXClampLeft;
      } else if (x < m.flyEdgeLeft) {             // $B24F — out to the left
        record[COL] = u8(record[COL]-1);
        record[X] = m.flyEnterRight;
        return null;                            // $B25B — $9636 only redraws
      } else {
        record[MASK] |= m.sideMaskSetX;
        desc |= m.sideMaskSetX;
      }
    }
    record[X] = x;
    return desc;
  }; // flyerX

  /** $B1FD — and the vertical one */
  W.flyerY = function (world, record, desc, y) {
    var m = this.m;
    if (y >= 0x80) {
      if (y >= m.flyYMax) {
        if (!(desc & FLOOR)) {
          if (y >= m.flyEdgeBottom) {             // $B2AA — down a room
            record[ROW] = u8(record[ROW]+1);
            record[Y] = m.flyEnterTop;
            return;                             // $B2BA
          }
          record[MASK] |= m.sideMaskSetY;
        } else {
          record[VY] = u8(~record[VY]);
          y = m.flyYClampFloor;
        }
      }
    } else if (y < m.flyYMin) {
      if (desc & TOP) {
        record[VY] = u8(~record[VY]);
        y = m.flyYClampTop;
      } else if (y < m.flyEdgeTop) {              // $B29B — up a room
        record[ROW] = u8(record[ROW]-1);
        record[Y] = m.flyEnterBottom;
        return;                                 // $B2A7
      } else {
        record[MASK] |= m.sideMaskSetY;
      }
    }
    record[Y] = y;
    this.draw(record);
  }; // flyerY

  /**
   * $B2CF — the monster is in another column. It works its way along the grid
   * towards Sabreman's, and while it does that it keeps to the upper half of
   * whatever room it crosses ($B307), which is why they arrive from above.
   */
  W.approachX = function (world, record, desc, leftwards) {
    var m = this.m, player = world.player;
    record[FLAGS] = 1;
    record[MASK] = 0;
    if (leftwards) {
      if (desc & LEFT) { return this.approachBlocked(world, record, desc); }
      this.approachSpeed(record, VX, false, m.approachAccel, m.approachCap);
      var x = u8(sra4(record[VX])+record[X]);
      if (x < m.approachXMin) {
        record[COL] = u8(record[COL]-1);
        x = m.approachEnterRight;
      }
      record[X] = x;
    } else {
      if (desc & RIGHT) { return this.approachBlocked(world, record, desc); }
      this.approachSpeed(record, VX, true, m.approachAccel, m.approachCap);
      var right = u8(sra4(record[VX])+record[X]);
      if (right >= m.approachXMax) {
        record[COL] = u8(record[COL]+1);
        right = m.approachEnterLeft;
      }
      record[X] = right;
    }
    // $B307 — and it climbs towards the top of the room as it goes
    var y = record[Y];
    if (y < m.approachYMinRoom) { record[Y] = m.approachYClampTop; }
    if (y < m.approachYSink) { return; }
    record[Y] = u8(y-m.approachYStep);
  }; // approachX

  /** $B34B — the way sideways is shut; drop into the vertical approach */
  W.approachBlocked = function (world, record, desc) {
    if (world.player[ROW] === record[ROW]) { record[TYPE] = 0; return; }
    return this.approachY(world, record, desc,
                          world.player[ROW] < record[ROW]);
  }; // approachBlocked

  /** $B358 — the monster is in another row */
  W.approachY = function (world, record, desc, upwards) {
    var m = this.m;
    record[FLAGS] = 1;
    record[MASK] = 0;
    if (upwards) {
      if (desc & TOP) { record[TYPE] = 0; return; }
      this.approachSpeed(record, VY, false, m.approachAccel, m.approachCap);
      var y = u8(sra4(record[VY])+record[Y]);
      if (y < m.approachYMinV) {
        record[ROW] = u8(record[ROW]-1);
        y = m.approachEnterBottom;
      }
      record[Y] = y;
    } else {
      if (desc & FLOOR) { record[TYPE] = 0; return; }
      this.approachSpeed(record, VY, true, m.approachAccel, m.approachCap);
      var down = u8(sra4(record[VY])+record[Y]);
      if (down >= m.approachYMax) {
        record[ROW] = u8(record[ROW]+1);
        down = m.approachEnterTop;
      }
      record[Y] = down;
    }
    // $B390 — and it stays inside the room sideways
    var x = record[X];
    if (x < m.approachXClampMin) { record[X] = m.approachXClampLeft; }
    if (x < m.approachXClampMax) { return; }
    record[X] = m.approachXClampRight;
  }; // approachY

  /** $B2DD / $B31F — accelerate one way, with the cap on the stored value */
  W.approachSpeed = function (record, offset, positive, accel, cap) {
    var value;
    if (positive) {
      value = u8(record[offset]+accel);
      if (value & 0x80) { record[offset] = value; return; }
      if (value >= cap) { return; }
    } else {
      value = u8(record[offset]-accel);
      if (!(value & 0x80)) { record[offset] = value; return; }
      if (value >= u8(-cap)) { record[offset] = value; }
      return;
    }
    record[offset] = value;
  }; // approachSpeed

  /**
   * $EE66 — types $34-$37 fly the same way, except that when they are in
   * another room they do not aim: $EE9A draws $20 or -$20 out of bit 6 of
   * FRAMES and they wander in with that.
   */
  W.wanderer = function (world, record) {
    var m = this.m, player = world.player;
    var desc = u8(world.roomWord(record[COL], record[ROW])[0] | record[MASK]);
    var drawn = u8((((world.counters.frame & 0xFF) & m.wanderMask)
                    | m.wanderOr) - m.wanderSub);
    if (player[COL] !== record[COL]) {
      record[VY] = drawn;
      return this.approachX(world, record, desc, player[COL] < record[COL]);
    }
    if (player[ROW] !== record[ROW]) {
      record[VX] = drawn;
      return this.approachY(world, record, desc, player[ROW] < record[ROW]);
    }
    this.animate(record);
    return this.gargoyleSide(world, record, desc);   // $B40B, ne $B3FC
  }; // wanderer

  /**
   * $B3D8 — a gargoyle. Its sideways speed is fixed and it accelerates
   * downwards, so it dives; and it will not follow him **up** a room ($B3F4
   * simply deletes it), which is why they feel like they come out of the
   * ceiling and never go back.
   */
  W.gargoyle = function (world, record) {
    var player = world.player;
    var desc = u8(world.roomWord(record[COL], record[ROW])[0] | record[MASK]);
    if (player[COL] !== record[COL]) {
      return this.approachX(world, record, desc, player[COL] < record[COL]);
    }
    if (player[ROW] !== record[ROW]) {
      if (player[ROW] > record[ROW]) {
        return this.approachY(world, record, desc, false);
      }
      record[TYPE] = 0;
      return;
    }
    this.animate(record);
    var value = u8(record[VY]+1);                    // $B3FC
    if ((value & 0x80) || value < this.m.gargoyleCap) { record[VY] = value; }
    return this.gargoyleSide(world, record, desc);
  }; // gargoyle

  /** $B40B — sideways at a fixed speed, whichever way it was already going */
  W.gargoyleSide = function (world, record, desc) {
    var m = this.m;
    record[VX] = (record[VX] & 0x80) ? m.gargoyleSpeedLeft : m.gargoyleSpeedRight;
    return this.flyerMove(world, record, desc);
  }; // gargoyleSide

  /** $B41F — six phases of wing, two frames each, in the low bits of the type */
  W.animate = function (record) {
    var m = this.m;
    var phase = u8(record[PHASE]+1);
    if (phase >= m.phaseWrap) { phase = 0; }
    record[PHASE] = phase;
    record[TYPE] = u8((record[TYPE] & m.phaseTypeMask) | ((phase >> 1) & m.phaseMask));
  }; // animate

  // ===========================================================================
  // $E2CB / $E570 — an eagle carrying Sabreman
  // ===========================================================================

  /**
   * $E2CB. The eagle picks a point of its own ($B73F) and hauls Sabreman along
   * $10 pixels below itself; every pass it says so in $8EF1, and the main loop
   * copies that to $8EF2 ($9481). The moment it stops saying so — because it
   * was shot, or left the room — $E606 lets him fall. It also lets go of him
   * by itself once every 256 frames ($E2DC), which is the "picks you up and
   * drops you somewhere" of the instructions.
   */
  W.carrier = function (world, record, entering) {
    var m = this.m, player = world.player;
    var desc;
    if (!entering) {
      if (player[TYPE] < 0x1C) { return this.carrierEnd(world, record); }
      this.carrierSteer(world, record);
      desc = u8(world.roomWord(record[COL], record[ROW])[0] | record[MASK]);
      if ((world.counters.frame & 0xFF) === 0 && this.carrierDrop(record, desc)) {
        return this.carrierEnd(world, record);
      }
      if (player[FLAGS] & 0x20) {
        player[FLAGS] &= ~0x20;
        if (this.carrierDrop(record, desc)) {
          return this.carrierEnd(world, record);
        }
      }
    } else {
      desc = u8(world.roomWord(record[COL], record[ROW])[0] | record[MASK]);
    }

    // $E2F0 — this is where $B0E1 jumps in on the pass it grabs him
    this.carryLatchNext = 1;
    var y = u8(record[Y]+m.carryDrop);
    if (y >= m.carriedFloor && (desc & FLOOR)) { y = m.carriedFloor; }
    player[VY] = y;                              // $8F23
    player[VX] = record[X];                      // $8F22

    var phase = (world.counters.step >> 1) & 1;
    var type = u8((record[TYPE] & 0xFE) + phase);
    record[TYPE] = (record[VX] & 0x80) ? (type | 0x02) : (type & 0xFD);

    this.carrySpeed(record, VX, X, HEIGHT, m.carryCapX, m.carryFloorX);
    this.carrySpeed(record, VY, Y, PHASE, m.carryCapY, m.carryFloorY);
    return this.carrierMove(world, record, desc);
  }; // carrier

  /** $E329 / $E341 — accelerate towards the point the eagle picked */
  W.carrySpeed = function (record, speed, whole, target, cap, floor) {
    var value;
    if (record[whole] >= record[target]) {
      value = u8(record[speed]-1);
      if (!(value & 0x80)) { record[speed] = value; return; }
      if (value >= floor) { record[speed] = value; }
      return;
    }
    value = u8(record[speed]+1);
    if (value & 0x80) { record[speed] = value; return; }
    if (value >= cap) { return; }
    record[speed] = value;
  }; // carrySpeed

  /** $B73F — a new point to fly to, picked whenever it bounces off something */
  W.carrierTarget = function (world, record) {
    var m = this.m;
    record[HEIGHT] = u8(((world.counters.frame & 0xFF) & m.carryTargetX)
                        + m.carryTargetXBase);
    record[PHASE] = u8((this.refresh & m.carryTargetYMask)
                       + m.carryTargetYBase);          // $B749 — LD A,R
  }; // carrierTarget

  /**
   * $E420 — the keys still nudge it while it carries him, one pixel a step,
   * and only the first key that is **not** held wins. That reads backwards
   * and it is: $AE17 returns a key mask where a bit is 0 when the key is down.
   */
  W.carrierSteer = function (world, record) {
    var input = world.input || {};
    if (input.right) { record[X] = u8(record[X]+1); return; }
    if (input.left) { record[X] = u8(record[X]-1); return; }
    if (input.up) { record[Y] = u8(record[Y]-1); return; }
    if (input.down) { record[Y] = u8(record[Y]+1); return; }
    record[X] = u8(record[X]+1);          // $E431 falls through into $E433
  }; // carrierSteer

  /**
   * $E51B — will it let go here? Only well inside the room; and if it does, it
   * leaves Sabreman standing where it was and forgets its target point.
   */
  W.carrierDrop = function (record, desc) {
    var player = this.records[SLOT.sabreman];
    var m = this.m;
    if (record[X] < m.carryDropXMin || record[X] >= m.carryDropXMax) { return false; }
    if (record[Y] < m.carryDropYMin || record[Y] >= m.carryDropYMax) { return false; }
    var y = u8(record[Y]+m.carryDrop);
    if ((desc & FLOOR) && y >= m.carriedFloor) { y = m.carriedFloor; }
    player[VY] = y;
    player[VX] = record[X];
    player[MASK] = 0;
    record[HEIGHT] = 0;
    record[PHASE] = 0;
    return true;
  }; // carrierDrop

  /** $E556 — he is out of its claws: it either dies or climbs away */
  W.carrierEnd = function (world, record) {
    var m = this.m, player = world.player;
    var flags = u8(player[FLAGS] | 0x40);
    var shot = flags & 0x80;
    player[FLAGS] = flags & 0x7F;
    if (shot) { return this.killed(world, record); }
    record[TYPE] = m.carryEagleType;
    record[VY] = m.carryEagleVy;
    this.draw(record);
  }; // carrierEnd

  /**
   * $E359 — the rest of the carrier's step. It is $B132 again, except that
   * every bounce picks a new target ($B73F), the sideways speed is handed to
   * Sabreman as his dx ($8F20), and a room change takes him along.
   */
  W.carrierMove = function (world, record, desc) {
    var m = this.m, player = world.player;
    var sensor = this.obstacles(world, record);
    var c = sensor.c;
    if (c & 0x04) {
      if (c & 0x02) {
        if (!(c & 0x20) && !(record[VY] & 0x80)) {
          record[VY] = u8(~record[VY]);
          this.carrierTarget(world, record);
        }
      } else if (!(c & 0x01) && (record[VY] & 0x80)) {
        record[VY] = u8(~record[VY]);
      }
      if (c & 0x80) {
        if (record[VX] & 0x80) {
          record[VX] = u8(~record[VX]);
          this.carrierTarget(world, record);
        }
      } else if (!(record[VX] & 0x80)) {
        record[VX] = u8(~record[VX]);
        this.carrierTarget(world, record);
      }
    }

    record[MASK] &= m.sideMaskX;
    player[DX] = u8(sra4(record[VX]));            // $E3CB — and he swings along
    var x = this.step16(record, VX, X, LOWX);
    if (x >= 0x80) {
      if (x >= m.carryXMax) {
        if (!(desc & RIGHT)) {
          if (x >= m.carryEdgeRight) {            // $E50E — out to the right
            record[COL] = u8(record[COL]+1);
            record[X] = m.carryEnterLeft;
            player[VX] = m.carryEnterLeft;
            player[COL] = record[COL];
            player[MASK] = 0x11;
            return this.carrierRoom(world, record);
          }
          record[MASK] |= 0x11;
          desc |= 0x11;
        } else {
          record[VX] = u8(~record[VX]);
          this.carrierTarget(world, record);
          x = m.carryXClampRight;
        }
      }
    } else if (x < m.carryXMin) {
      if (desc & LEFT) {
        record[VX] = u8(~record[VX]);
        this.carrierTarget(world, record);
        x = m.carryXClampLeft;
      } else if (x < m.carryEdgeLeft) {           // $E4F6 — out to the left
        record[COL] = u8(record[COL]-1);
        record[X] = m.carryEnterRight;
        player[VX] = m.carryEnterRight;
        player[COL] = record[COL];
        player[MASK] = 0x11;
        return this.carrierRoom(world, record);
      } else {
        record[MASK] |= 0x11;
        desc |= 0x11;
      }
    }
    record[X] = x;

    record[MASK] &= m.sideMaskY;
    var y = this.step16(record, VY, Y, LOWY);
    if (y >= 0x80) {
      if (y >= m.carryYMax) {
        if (!(desc & FLOOR)) {
          if (y >= m.carryEdgeBottom) {           // $E4E7 — down a room
            record[ROW] = u8(record[ROW]+1);
            record[Y] = m.carryEnterTop;
            player[VY] = m.carryPlayerTop;
            player[ROW] = record[ROW];
            return this.carrierRoom(world, record);
          }
          record[MASK] |= 0x44;
        } else {
          record[VY] = u8(~record[VY]);
          this.carrierTarget(world, record);
          y = m.carryYClampFloor;
        }
      }
    } else if (y < m.carryYMin) {
      if (desc & TOP) {
        record[VY] = u8(~record[VY]);
        this.carrierTarget(world, record);
        y = m.carryYClampTop;
      } else if (y < m.carryEdgeTop) {            // $E4CA — up a room
        record[ROW] = u8(record[ROW]-1);
        record[Y] = m.carryEnterBottom;
        player[VY] = m.carryPlayerBottom;
        player[ROW] = record[ROW];
        return this.carrierRoom(world, record);
      } else {
        record[MASK] |= 0x44;
      }
    }
    record[Y] = y;
    this.draw(record);
  }; // carrierMove

  /** $E4DD — a carried room change: Sabreman goes with it, and the room fills */
  W.carrierRoom = function (world, record) {
    record[FLAGS] = 1;
    this.draw(record);
    if (world.enterRoomFor) { world.enterRoomFor(record); }
  }; // carrierRoom

  /**
   * $E570 — Sabreman himself while he is carried. He is where the eagle put
   * him, he can still shoot, and when the eagle stops reporting in he falls.
   */
  W.carriedPlayer = function (world, record) {
    var m = this.m;
    if (record[FLAGS] & 0x80) {                   // $E573 — a plant got him
      record[FLAGS] |= 0x20;
      record[LOWX] = m.carriedPlantBit;
    }
    // $E582 — he is drawn where the eagle put him, in +8 and +9
    var facing = (u8(record[VX]-record[X]) >> 6) & 0x02;  // RLCA RLCA / AND 2
    var phase = (world.counters.step >> 1) & 1;
    record[TYPE] = u8((record[TYPE] & 0xFC) + facing + phase);
    record[Y] = record[VY];
    record[X] = record[VX];
    if (this.carryLatch === 0) { return this.carriedFall(record); }

    var sensor = this.furnitureSensor(world, record);
    if (sensor.c & 0x04) {
      if ((sensor.c & 0x02) || !(sensor.c & 0x01)) {
        record[Y] = u8(m.carriedLandOffset-u8(sensor.b-1));      // $E616
        this.draw(record);
        return;
      }
      record[FLAGS] |= 0x20;
    }
    // $E5C3 — the walls, and (only if he is at one of them) the floor
    var desc = u8(world.roomWord(record[COL], record[ROW])[0] | record[MASK]);
    var clamp = true;
    if (record[X] >= m.carriedClampRight) {
      if (desc & RIGHT) { record[X] = m.carriedClampRight; }
    } else if (record[X] >= m.carriedClampLeft) {
      clamp = false;
    } else if (desc & LEFT) {
      record[X] = m.carriedClampLeft;
    }
    if (clamp && !(desc & FLOOR) && record[Y] >= m.carriedFloor) {
      record[Y] = m.carriedFloor;
    }
    if (record[FLAGS] & 0x40) { return this.carriedFall(record); }
    if (world.input && world.input.fire) { this.fire(world); }
    this.draw(record);
  }; // carriedPlayer

  /** $E606 — nobody is holding him any more, so he falls out of the sky */
  W.carriedFall = function (record) {
    var m = this.m;
    record[FLAGS] &= ~0x40;
    record[TYPE] = m.carryReleaseType;
    record[VY] = m.carryReleaseVy;
    this.draw(record);
  }; // carriedFall


  // ===========================================================================
  // $E8D7 — a weapon
  // ===========================================================================

  /**
   * A weapon has three lives of its own, and they are three bits of byte +7:
   * bit 1 carried, bit 2 falling, bit 0 "somewhere else, redraw me". Picking
   * one up needs the take/drop key **and** contact; the same key, pressed
   * again, walks the ones he carries along the panel until one falls off.
   */
  W.weapon = function (world, record) {
    var m = this.m, player = world.player;
    if (record[SPARE7] & 0x02) { return this.weaponCarried(world, record); }
    if (player[COL] !== record[COL] || player[ROW] !== record[ROW]) {
      return this.weaponElsewhere(world, record);
    }
    if (record[SPARE7] & 0x01) { return this.drawWeapon(record); }
    if (record[SPARE7] & 0x04) { return this.weaponFalling(world, record); }
    if (this.takePulse !== 0xFF) { return; }
    if (!(this.contact(world, record) & 0x04)) { return; }
    record[X] = m.carryX;
    record[Y] = m.carryY;
    record[SPARE7] |= 0x02;
    this.takePulse = m.takeConsumed;
    this.carried[0] = record[TYPE];
    this.drawWeapon(record);
  }; // weapon

  /** $E92A — carried: one press moves it along, the fourth throws it away */
  W.weaponCarried = function (world, record) {
    var m = this.m, player = world.player;
    record[SPARE7] &= ~0x01;
    if (this.takePulse === 0) { return; }
    var x = u8(record[X]+m.carryStep);
    if (x >= m.carryLimit) {
      record[X] = player[X];
      record[COL] = player[COL];
      record[Y] = player[Y];
      record[ROW] = player[ROW];
      record[SPARE7] = (record[SPARE7] & ~0x02) | 0x04;
      record[DX] = m.dropFallStep;
      this.drawWeapon(record);
      return;
    }
    record[X] = x;
    var slot = (x >> 4) & m.carrySlotMask;
    if (slot === m.carrySlotMax) { slot--; }
    this.carried[slot] = record[TYPE];
    this.drawWeapon(record);
  }; // weaponCarried

  /** $E980 — a dropped weapon falls until the floor or a piece of furniture */
  W.weaponFalling = function (world, record) {
    var m = this.m;
    var speed = record[DX];
    record[DX] = u8(speed+1);
    record[Y] = u8(((speed >> 4) & m.dropMask) + record[Y]);
    var sensor = this.obstacles(world, record, true);
    if (sensor.c & 0x04) {
      record[Y] = u8(m.dropLandOffset-sensor.b);
      record[SPARE7] &= ~0x04;
      return this.drawWeapon(record);
    }
    if (record[Y] < m.dropFloor) { return this.drawWeapon(record); }
    var desc = world.roomWord(record[COL], record[ROW])[0];
    if (desc & FLOOR) {
      record[Y] = m.dropFloorClamp;
      record[SPARE7] &= ~0x04;
      return this.drawWeapon(record);
    }
    if (record[Y] < m.dropBelow) { return this.drawWeapon(record); }
    this.weaponSettle(world, record);
  }; // weaponFalling

  /** $E9CA / $E9EA — it falls through the rooms below until one has a floor */
  W.weaponSettle = function (world, record) {
    var m = this.m;
    for (var guard = 0; guard < 52; guard++) {
      record[ROW] = u8(record[ROW]+1);
      if (world.roomWord(record[COL], record[ROW])[0] & FLOOR) { break; }
    }
    record[Y] = m.dropSettle;
    record[DX] = 0;
  }; // weaponSettle

  /** $E9DF — in another room it just waits, unless it is still falling */
  W.weaponElsewhere = function (world, record) {
    var m = this.m;
    record[SPARE7] |= 0x01;
    if (!(record[SPARE7] & 0x04)) { return; }
    for (var guard = 0; guard < 52; guard++) {
      if (world.roomWord(record[COL], record[ROW])[0] & FLOOR) { break; }
      record[ROW] = u8(record[ROW]+1);
    }
    record[Y] = m.dropSettle;
    record[DX] = 0;
  }; // weaponElsewhere

  // ===========================================================================
  // $B57A / $B58C — a projectile in flight
  // ===========================================================================

  /** $B57A for the catapult's stone, $EA9C for the dagger and the arrow, */
  /** $EA7D for the fireball: the same body, three different animations. */
  W.shot = function (world, record) {
    var m = this.m;
    var type = record[TYPE] & 0xFC;
    if (type === 0x38) {
      record[TYPE] = u8((record[TYPE] & m.shotPhaseTypeMask)
                        | (world.counters.step & m.shotPhaseMask));
    } else if ((record[TYPE] & 0xFE) === 0x70) {
      var bit = world.counters.step & 1;
      record[TYPE] = u8((record[TYPE] & 0xFE) + bit);
      record[ATTR] = u8(bit + 0x42);
    }
    return this.shotMove(world, record);
  }; // shot

  W.shotMove = function (world, record) {
    var m = this.m, player = world.player;
    if (player[COL] !== record[COL] || player[ROW] !== record[ROW]) {
      record[TYPE] = 0;
      return;
    }
    if (record[SPARE7] & 0x01) {                  // it hit something last pass
      record[TYPE] = 0;
      record[SPARE7] = 0;
      this.draw(record);
      return;
    }
    var sensor = this.obstacles(world, record, true);
    if (sensor.c & 0x04) {
      if (!(sensor.c & 0x02)) { return this.shotWall(world, record); }
      record[VY] = u8(~record[VY]);
      record[Y] = u8(m.shotBounceY-sensor.b);
      this.splash(world, record);
      this.draw(record);
      return;
    }
    var desc = u8(world.roomWord(record[COL], record[ROW])[0] | record[MASK]);
    record[MASK] = 0;
    var speed = u8(record[VY]+m.shotGravity);
    if (!(speed & 0x80) && speed >= m.shotGravityCap) { speed = m.shotGravityCap; }
    record[VY] = speed;

    var total = (s8(record[VX]) << 4) + (record[X] << 8) + record[LOWX];
    var negative = (record[VX] & 0x80) ? 1 : 0;
    var inside = negative ? (total >= 0) : (total <= 0xFFFF);
    if (!inside) { record[TYPE] = 0; return; }
    record[LOWX] = total & 0xFF;
    var x = (total >> 8) & 0xFF;

    if (x >= 0x80) {
      if (x >= m.shotXMax) {
        if (desc & RIGHT) { record[X] = m.shotXClampRight; return this.shotWall(world, record); }
        if (x >= m.shotEdgeRight) { return this.shotGone(world, record); }
        record[MASK] |= 0x11;
        desc |= 0x11;
      }
    } else if (x < m.shotXMin) {
      if (desc & LEFT) { record[X] = m.shotXClampLeft; return this.shotWall(world, record); }
      if (x < m.shotEdgeLeft) { return this.shotGone(world, record); }
      record[MASK] |= 0x11;
      desc |= 0x11;
    }
    record[X] = x;

    var y = this.step16(record, VY, Y, LOWY);
    if (y >= 0x80) {
      if (y >= m.shotYMax) {
        if (!(desc & FLOOR)) {
          if (y >= m.shotEdgeBottom) { return this.shotGone(world, record); }
          record[MASK] |= 0x44;
        } else {
          record[VY] = u8(~record[VY]);
          this.splash(world, record);
          y = m.shotYClampFloor;
        }
      }
    } else if (y < m.shotYMin) {
      if (desc & TOP) {
        record[VY] = u8(~record[VY]);
        y = m.shotYClampTop;
      } else if (y < m.shotEdgeTop) {
        return this.shotGone(world, record);
      } else {
        record[MASK] |= 0x44;
      }
    }
    record[Y] = y;
    this.draw(record);
  }; // shotMove

  /** $DEDA — it hit a wall and turns into the little puff of type $48 */
  W.shotWall = function (world, record) {
    var m = this.m;
    record[TYPE] = m.hitWallType;
    record[VX] = m.hitWallSteps;
    world.sound('hit');
    this.draw(record);
  }; // shotWall

  /** $B6D3 / $B6E3 — it left the room */
  W.shotGone = function (world, record) {
    if (record[FLAGS] & 1) { record[TYPE] = 0; return; }
    record[TYPE] = 0;
    record[SPARE7] = 0;
  }; // shotGone

  /** $DEB8 — a shot that hits the floor splashes, in a slot of its own */
  W.splash = function (world, record) {
    var m = this.m;
    var slot = this.records[m.splashSlot];
    if (slot[TYPE] !== 0) { return; }
    for (var i = 0; i < 15; i++) { slot[i] = record[i]; }
    slot[TYPE] = m.splashType;
    slot[VX] = m.splashPhase;
    slot[FLAGS] = 1;
    world.sound('splash');
  }; // splash

  /** $DEE8 (types $48-$4B) and $DF15 (types $4C-$4F) — the two little puffs */
  W.puff = function (world, record, mask, typeMask) {
    var player = world.player;
    if (player[COL] !== record[COL] || player[ROW] !== record[ROW]) {
      record[TYPE] = 0;
      return;
    }
    record[VX] = u8(record[VX]-1);
    if (record[VX] === 0) {
      record[TYPE] = 0;
      record[SPARE7] = 0;
      this.draw(record);
      return;
    }
    record[TYPE] = u8((record[TYPE] & typeMask) + (record[VX] & mask));
    this.draw(record);
  }; // puff

  // ===========================================================================
  // $ECCA — a guardian
  // ===========================================================================

  /**
   * A guardian stands still, waves, and shoves anything that touches it a long
   * way left. It dies to one projectile and one only, and the pairing goes
   * through the projectile's type, not the weapon's ($ECFA). The stone from
   * the catapult never even reaches the test: $ECF6 throws away everything
   * below $6C, and the stone is $38.
   */
  W.guardian = function (world, record) {
    var m = this.m, player = world.player;
    if (player[COL] !== record[COL] || player[ROW] !== record[ROW]) {
      record[TYPE] = 0;
      return;
    }
    if ((world.counters.step & m.guardianAnimMask) !== 0) {
      record[TYPE] = u8(record[TYPE] ^ m.guardianAnimBit);
    }
    var hit = this.shotHit(record);
    if (hit && hit >= m.guardianProjMin
        && (((hit >> 1)-1) & m.guardianPairMask)
           === ((record[TYPE] >> 1) & m.guardianTypeShift)) {
      this.taken.guardians[record[DX]] = true;
      this.eagles = m.guardianKilledFlag;
      world.sound('guardian');
      return this.killed(world, record);
    }
    if (this.contactRaw(world, record) & 0x04) {
      player[FLAGS] |= m.guardianBounceFlag;
      player[DX] = m.guardianBounceDx;
    }
    this.draw(record);
  }; // guardian

  /**
   * $ED2E — the way out that appears in a guardian's room. It is a drawing
   * routine and nothing else: four rows of 4, 3, 2 and 1 sprites, and where it
   * leaves x and y is where the original leaves them. Whether Sabreman may
   * walk into it is $ED8A, which is in the physics already.
   */
  W.exit = function (world, record) {
    var m = this.m;
    if (!(record[FLAGS] & 1)) { return; }
    record[X] = m.exitX;
    record[Y] = m.exitY;
    record[ATTR] = m.exitAttribute;
    for (var c = m.exitColumns; c > 0; c--) {
      // the inner loop draws c sprites; $ED56 then works out where the next
      // and shorter row starts, so the whole thing is a wedge
      record[X] = u8(m.exitRowBase - 4*c + 2);
      record[Y] = u8(record[Y] + m.exitStepY);
    }
    record[FLAGS] &= ~1;
  }; // exit

  /**
   * Where the exit's sprites go — the renderer needs the same wedge. The row
   * after a row of `c` sprites starts at `exitRowBase + 2 - 4c` ($ED56), which
   * is not the same as `exitX`: measured against the original the ten sprites
   * are x = $78 $80 $88 $90 on y = $30, then $7A $82 $8A on $48, $7E $86 on
   * $60 and $82 on $78 (tools/matchsprites.js, M6).
   */
  W.exitSprites = function () {
    var m = this.m;
    var out = [], x = m.exitX, y = m.exitY;
    for (var c = m.exitColumns; c > 0; c--) {
      for (var i = 0; i < c; i++) { out.push({x: u8(x+m.exitStepX*i), y: y}); }
      x = u8(m.exitRowBase+2-4*c);
      y = u8(y+m.exitStepY);
    }
    return out;
  }; // exitSprites

  // ===========================================================================
  // $AFDA — the generator, now that what it makes can move
  // ===========================================================================

  /**
   * M4 transcribed the placement; what it could not switch on was the making
   * of monsters, because they had nowhere to go. The rule of the type is the
   * one thing worth repeating here: bit 4 is forced while $8EF9 is zero, so
   * before the first guardian falls only $40 and $44 come out, and the eagles
   * $30 and $34 start only afterwards ($AFF9, ZADANI chap. 8).
   */
  W.generateMonster = function (world) {
    var m = this.m, player = world.player;
    if (!m) { return; }
    if ((((world.counters.step & 0xFF) + (world.counters.frame & 0xFF))
         & m.genPeriodMask) !== 0) { return; }
    var slot = this.freeSlot(m.genSlotBase, m.genSlotCount);
    if (slot === null) { return; }
    var record = this.records[slot];
    var desc = world.roomWord(player[COL], player[ROW])[0];
    var counter = world.counters.step & 0xFF;
    if (this.eagles === 0) { counter |= m.genEagleBit; }
    record[TYPE] = u8((counter & m.genTypeMask) + m.genTypeBase);

    var fromRight;
    if (counter & 0x01) {
      if (!(desc & LEFT)) { fromRight = false; }
      else if (desc & RIGHT) { fromRight = null; }
      else { fromRight = true; }
    } else {
      if (!(desc & RIGHT)) { fromRight = true; }
      else if (!(desc & LEFT)) { fromRight = false; }
      else { fromRight = null; }
    }

    var frames = world.counters.frame & 0xFF;
    if (fromRight === null) {                     // $B04F — from above or below
      record[X] = u8((counter & m.genSideXMask) + m.genSideXBase);
      record[COL] = player[COL];
      record[Y] = u8((frames & m.genYMask) + m.genYBase);
      record[ROW] = u8(player[ROW] + ((desc & TOP) ? 1 : -1));
    } else if (fromRight) {                       // $B043
      record[X] = u8((counter & m.genRightXMask) + m.genRightXBase);
      record[COL] = u8(player[COL]+1);
      record[Y] = u8((frames & m.genYMask) + m.genYBase);
      record[ROW] = player[ROW];
    } else {                                      // $B018
      record[X] = u8((counter & m.genSideXMask) + m.genSideXBase);
      record[COL] = u8(player[COL]-1);
      record[Y] = u8((frames & m.genYMask) + m.genYBase);
      record[ROW] = player[ROW];
    }
    record[ATTR] = u8((frames & m.genAttrAnd) + m.genAttrBase);
  }; // generateMonster

  // ===========================================================================
  // Shared sensors — the same routines the physics uses
  // ===========================================================================

  /** $E285 — is this entity touching Sabreman? (0 while he is invulnerable) */
  W.contact = function (world, record) {
    if (world.player[TYPE] >= this.m.contactAliveType) { return 0; }
    return this.contactRaw(world, record);
  }; // contact

  /** $E28D — the same, but a guardian does not care about the gem countdown */
  W.contactRaw = function (world, record) {
    var player = world.player;
    if (player[FLAGS] & 0x40) { return 0; }
    var c = 0;
    var m = this.m;
    var dx = s8(player[X]-record[X]);
    if (dx < 0) { c |= 0x80; dx = -dx; }
    if (dx >= m.contactReachX) { return 0; }
    if (player[COL] !== record[COL]) { return 0; }
    var dy = s8(player[Y]-m.contactOffsetY-record[Y]);
    if (dy < 0) { c |= 0x02; dy = -dy; }
    if (dy >= m.contactReachY) { return 0; }
    if (player[ROW] !== record[ROW]) { return 0; }
    // $E2C5 — the sensor itself plays a sound whenever it confirms a touch,
    // and its pitch is the y of the thing that did the touching (M6, $A0F5)
    world.sound('touch', {y: record[Y]});
    return c | 0x04;
  }; // contactRaw

  /**
   * $B161 — $B43E followed by $E1B4: what this entity has run into. The
   * furniture of the room and the volcanic bubbles, with the moving entity's
   * own position; the original does it by pointing IX somewhere else, and this
   * is the same walk over the same records. `b` is the original's B register,
   * $A0 minus the top of whatever was hit, which the callers turn back into a
   * y ($B5B9, $E999, $E616).
   */
  W.obstacles = function (world, record, furnitureOnly) {
    var out = this.furnitureSensor(world, record);
    if (furnitureOnly) { return out; }
    var platform = this.platformSensor(world, record);
    if (platform.c & 0x04) { return {c: out.c | platform.c, b: platform.b}; }
    return {c: out.c | platform.c, b: out.b};
  }; // obstacles

  /** $B43E / $B46A — the four (in a cave two) furniture slots of the room */
  W.furnitureSensor = function (world, record) {
    var m = this.m;
    var castle = record[ROW] < m.obstacleRows;
    var base = castle ? m.obstacleBaseCastle : m.obstacleBaseCave;
    var count = castle ? m.obstacleSlotsCastle : m.obstacleSlotsCave;
    var slots = [];
    for (var n = 0; n < count; n++) { slots.push(base + STRIDE*n); }
    var b = 0;
    for (var i = 0; i < slots.length; i++) {
      var out = this.furnitureOne(this.records[slots[i]], record);
      if (out.b) { b = out.b; }
      if (out.c & 0x04) { return {c: out.c, b: b}; }
    }
    return {c: 0, b: b};
  }; // furnitureSensor

  /**
   * $B46A — one piece of furniture. Its reach is in its own bytes: +$0E is how
   * far its sprite starts from its x, +$0A how wide it is, +$0B where the edge
   * of it begins, +$0C how tall and +$0D how deep you have to be in it to be
   * standing on it rather than brushing past.
   */
  W.furnitureOne = function (item, record) {
    var none = {c: 0, b: 0};
    if (item[TYPE] === 0) { return none; }
    if (item[FLAGS] & 1) { return none; }
    if (item[TYPE] === this.m.obstacleExitType) {
      return this.exitSensor(item, record);
    }
    var c = 0;
    var dx = s8(u8(u8(item[X]+item[PHASE])-record[X]));
    if (dx < 0) { c |= 0x80; dx = -dx; }
    if (dx >= item[LOWX]) { return none; }
    if (dx >= item[MASK]) { c |= 0x01; }
    var dy = s8(u8(item[Y]-record[Y]));
    if (dy < 0) { return none; }
    var b = u8(-(u8(item[Y]-item[HEIGHT])-0xA0));
    if (dy >= item[HEIGHT]) { return {c: 0, b: b}; }
    c |= 0x04;
    if (dy < item[LOWY]) { return {c: c, b: b}; }
    c |= 0x02;
    return {c: c, b: b};
  }; // furnitureOne

  /** $ED8A — the exit is a wedge, so how wide it is depends on how high */
  W.exitSensor = function (item, record) {
    var m = this.m, none = {c: 0, b: 0};
    if (record[Y] >= m.exitSensorY) { return none; }
    var width = u8((u8(u8(-record[Y])-m.exitSensorSub) >> 2) + m.exitSensorAdd);
    var c = 0;
    var dx = s8(u8(m.exitSensorX-record[X]));
    if (dx < 0) { c |= 0x80; dx = -dx; }
    if (dx >= width) { return none; }
    return {c: c | 0x05, b: 1};
  }; // exitSensor

  /**
   * $E1B4 — the volcanic bubbles, the one thing besides the floor that can be
   * stood on. The branch that carries Sabreman up into the room above is his
   * alone (the original checks the type first, $E22B), so a monster only ever
   * gets the sensor part.
   */
  W.platformSensor = function (world, record) {
    var m = this.m, none = {c: 0, b: 0};
    if (record[LOWX] & m.platformIgnore) { return none; }
    for (var i = 0; i < m.platformSlots; i++) {
      var item = this.records[m.platformBase + STRIDE*i];
      if (!item || (item[TYPE] & 0xFC) !== m.platformType) { continue; }
      var c = 0;
      var dx = s8(u8(item[X]-record[X]));
      if (dx < 0) { c |= 0x80; dx = -dx; }
      if (dx >= m.platformReachX) { continue; }
      if (dx >= m.platformEdgeX) { c |= 0x21; }
      if (item[COL] !== record[COL]) { continue; }
      var dy = u8(item[Y]-record[Y]);
      if (dy >= m.platformReachY) { continue; }
      if (item[ROW] !== record[ROW]) { continue; }
      c |= 0x06;
      if (!(c & 1)) { record[Y] = u8(item[Y]-m.platformStandY); }
      var b = u8(-(record[Y]-m.carriedLandOffset));
      if (!(c & 1)) { record[MASK] |= FLOOR; }
      return {c: c, b: b};
    }
    return none;
  }; // platformSensor

  // ===========================================================================
  // The dispatch — the jump table at $921A, for the types M4 left over
  // ===========================================================================

  W.stepMonster = function (world, record, address) {
    var type = record[TYPE];
    if (!this.m) { return false; }
    this.refresh = u8(this.refresh+0x2B);       // stands in for the Z80's R
    if (type >= 0x30 && type <= 0x33) { this.flyer(world, record); return true; }
    if (type >= 0x34 && type <= 0x37) { this.wanderer(world, record); return true; }
    if (type >= 0x38 && type <= 0x3B) { this.shot(world, record); return true; }
    if (type >= 0x40 && type <= 0x43) { this.flyer(world, record); return true; }
    if (type >= 0x44 && type <= 0x47) { this.gargoyle(world, record); return true; }
    if (type >= 0x48 && type <= 0x4B) {
      this.puff(world, record, this.m.puffPhaseMask, this.m.puffTypeMask);
      return true;
    }
    if (type >= 0x4C && type <= 0x4F) {
      this.puff(world, record, this.m.deathPhaseMask, this.m.deathTypeMask);
      return true;
    }
    if (type >= 0x5C && type <= 0x5F) { this.carrier(world, record); return true; }
    if (type >= this.m.carriedPlayerType && type <= this.m.carriedPlayerType+3) {
      this.carriedPlayer(world, record);
      return true;
    }
    if (type >= 0x6C && type <= 0x71) { this.shot(world, record); return true; }
    if (type >= 0x80 && type <= 0x87) { this.guardian(world, record); return true; }
    if (type === this.m.obstacleExitType) { this.exit(world, record); return true; }
    return false;
  }; // stepMonster

  /** the weapon records ($902A, five of eight bytes) step separately ($950C) */
  W.stepWeapons = function (world) {
    if (!this.m) { return; }
    for (var i = 0; i < this.weapons.length; i++) {
      if (this.weapons[i][TYPE] === 0) { continue; }
      this.weapon(world, this.weapons[i]);
    }
  }; // stepWeapons

  /** $9481 — the eagle's "I still have him" latch, moved on once a pass */
  W.tickCarry = function () {
    this.carryLatch = this.carryLatchNext;
    this.carryLatchNext = 0;
  }; // tickCarry
} // installMonsters

if (typeof self !== 'undefined') {
  self.installMonsters = installMonsters;
  if (self.WorldEntities) { installMonsters(self.WorldEntities); }
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = installMonsters;
}
