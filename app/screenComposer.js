const { ZXVideoRAM } = await import('./svision/js/platform/canvas2D/zx/zxVideoRAM.js?ver='+window.srcVersion);
// begin code

/**
 * Composes the Underwurlde screen in the video memory of the machine.
 *
 * Everything it draws comes out of the original: the room is the video memory
 * of a running original (data/rooms.json, tools/dumprooms.py), Sabreman is a
 * pose cut out of the same run (data/spriteframes.json, tools/dumpsprites.py)
 * and the panel is set in the game's own character set from $ED24
 * (data/font.json, tools/mkfont.py). Nothing here is drawn by hand.
 *
 * It writes into a {@link ZXVideoRAM} — the 6912 bytes in the ULA's own
 * interleaved order — so the attribute clash is reproduced rather than removed
 * (ZADANI chap. 1). A sprite is **XOR-ed** into the bitmap ($97A5: `LD A,(BC) /
 * XOR (HL) / LD (HL),A`) and hands its colour to a whole rectangle of cells,
 * which is exactly what the original's blitter does. XOR is not a detail: that
 * is how the original rubs a sprite out again, and it is why a sprite punches
 * holes in the scenery it walks past instead of covering it (measured in M6,
 * tools/matchsprites.js).
 *
 * The entities of the game are {@link ZXVideoRAMEntity}s: GameAreaEntity calls
 * {@link ScreenComposer#composeInto} and GameInfoEntity
 * {@link ScreenComposer#composePanelInto}, each into its own memory, and the
 * library turns the bytes into pixels (R-003). What is here is only what the
 * original does and this remake measured: the order of drawing, the colour
 * rules, the layout of the panel. The byte work — shifted XOR blit, cells,
 * clearing — is the library's ({@link ZXVideoRAM}).
 *
 * Free of DOM dependencies, so an offline tool loads it under Node behind the
 * `nodeEnv.mjs` shim (R-001): tools/matchsprites.js composes into a memory of
 * its own and compares the play area as the machine holds it, byte for byte.
 */
export class ScreenComposer {

  static get WIDTH() { return 256; }
  static get COLS() { return 32; }
  static get CELL() { return 8; }
  /** the panel takes the first two character rows, so the play area starts here */
  static get PANEL_LINES() { return 16; }
  /** the panel's rows of the screen, in character cells */
  static get PANEL_AREA() { return {col: 0, row: 0, cols: 32, rows: 2}; }
  // where the weapons he carries sit in the panel ($E910, $E937, $E914)
  static get CARRY_X() { return 0x88; }
  static get CARRY_STEP() { return 0x18; }
  static get CARRY_Y() { return 0x0F; }
  /** an empty cell, for a character the font does not have */
  static get BLANK() { return new Uint8Array(8); }

  /**
   * @param {Object} room - The room data (bitmap + attributes of the play
   *        area, base64 or bytes, as in data/rooms.json).
   * @param {Object} [font] - The parsed data/font.json; without it the panel
   *        stays empty.
   * @param {Object} [sprites] - The parsed data/sprites.json; without it
   *        Sabreman is simply not drawn.
   * @param {Object} [poses] - The parsed data/spriteframes.json (M2): the
   *        sprite of every entity type, so M3 can draw the measured poses of
   *        walking, jumping, falling, hanging and dying instead of the one
   *        pose M1 had.
   */
  constructor(room, font, sprites, poses) {
    if (!room || !room.bitmap || !room.attributes) {
      throw new Error('room data missing or incomplete');
    }
    this.setRoom(room);
    this.font = {};
    if (font && font.glyphs) {
      Object.keys(font.glyphs).forEach((char) => {
        this.font[char] = ZXVideoRAM.hexToBytes(font.glyphs[char]);
      });
    }
    this.sprites = {};
    if (sprites && sprites.sabreman && sprites.sabreman.frames) {
      var frames = sprites.sabreman.frames;
      Object.keys(frames).forEach((name) => {
        this.sprites[name] = {
          cols: frames[name].cols,
          rows: frames[name].rows,
          width: frames[name].width,
          height: frames[name].height,
          bitmap: ZXVideoRAM.decode(frames[name].bitmap),
          attributes: ZXVideoRAM.decode(frames[name].attributes)
        };
      });
    }
    this.poses = {};
    if (poses && poses.frames && poses.byType) {
      poses.byType.forEach((entry) => {
        if (entry.frame === null || entry.frame === undefined) {
          return;
        }
        var frame = poses.frames[entry.frame];
        this.poses[entry.type] = {
          cols: frame.cols,
          width: frame.width,
          height: frame.height,
          bitmap: ZXVideoRAM.decode(frame.bitmap)
        };
      });
      // the castle furniture ($79-$7E) is drawn by a path of its own ($EB39 ->
      // $E675) which does not take the colour from the entity record at all:
      // it copies a block of attributes, one byte per cell. That is why the
      // library in the start room is two-coloured — the old open question of
      // ZADANI, answered in M6.
      var blocks = poses.attributeBlocks && poses.attributeBlocks.blocks;
      if (blocks) {
        Object.keys(blocks).forEach((key) => {
          var type = parseInt(key.replace('$', ''), 16);
          if (!this.poses[type]) { return; }
          this.poses[type].attributeBlock = {
            cols: blocks[key].cols,
            rows: blocks[key].rows,
            attributes: ZXVideoRAM.decode(blocks[key].attributes)
          };
        });
      }
    }
  } // constructor

  /**
   * Swaps the room image (M4: the flick-screen transitions). The room is put
   * into a memory of its own once, below the panel, and every frame starts
   * from a copy of it.
   * @param {Object} room - {width, height, bitmap, attributes} as in
   *        data/rooms.json (base64) or composed at run time (bytes).
   */
  setRoom(room) {
    this.room = {
      width: room.width || 256,
      height: room.height || 176
    };
    /** the play area in character cells: rows 2-23 of the screen */
    this.playArea = {col: 0, row: ScreenComposer.PANEL_LINES/8,
                     cols: ScreenComposer.COLS, rows: this.room.height/8};
    this.roomMemory = new ZXVideoRAM()
      .setLinear(this.playArea, room.bitmap, room.attributes);
  } // setRoom

  // ------------------------------------------------------------ the room

  /**
   * Composes the play area into a video memory: the room with everything
   * drawn into it, the way the machine holds it. The whole memory is replaced
   * by the room, so the panel rows come out empty — the panel is another entity
   * with a memory of its own.
   * @param {ZXVideoRAM} videoRAM - The memory to write.
   * @param {Object} [state] - {sabreman, entities, rope} from the worker;
   *        the coordinates are the machine's own: x is the left edge, y the
   *        bottom line of the sprite in screen lines.
   */
  composeInto(videoRAM, state) {
    videoRAM.restore(this.roomMemory);
    var area = this.playArea;
    if (state && state.rope && state.rope.visible) {
      // the rope is a line from its anchor to its end, the way the original
      // draws it ($AD02); the coordinates come out of the rope globals
      this.blitLine(videoRAM, area, state.rope.anchorX, state.rope.anchorY,
                    state.rope.tipX, state.rope.tipY);
    }
    // the entities of the room (platforms, furniture) — their sprite is in the
    // same table as Sabreman's and their colour in their own record, so they
    // are drawn exactly like he is (M4 places them, M6 does the sprite work)
    if (state && state.entities) {
      state.entities.forEach((entity) => {
        var pose = this.poses[entity.type];
        if (pose) {
          this.blitPose(videoRAM, area, pose, entity.x, entity.y-(pose.height-1),
                        entity.attr || 0x45);
        }
      });
    }
    var man = state && state.sabreman;
    if (man && this.poses[man.type]) {
      var pose = this.poses[man.type];
      this.blitPose(videoRAM, area, pose, man.x, man.y-(pose.height-1), man.attr || 0x47);
    } else if (man && this.sprites[man.frame]) {
      this.blitSprite(videoRAM, area, this.sprites[man.frame], man.x, man.y);
    }
  } // composeInto

  /**
   * XORs one of the measured poses into the bitmap at a pixel position
   * ({@link ZXVideoRAM#blitShifted}: the original shifts the sprite byte by
   * byte and widens it by a byte when it crosses a cell, disasm_notes.md
   * chap. 11) and gives its cells the entity's colour. The colour is not in
   * the sprite at all — it comes from the entity record, which is why the
   * attribute clash happens at all.
   *
   * The colour is **not** painted cell by cell where the sprite has ink: the
   * original fills a whole rectangle ($9867), and M6 measured how big it is —
   * see fillAttributes(). That is why a wide sprite paints cells it does not
   * touch, and why the library in the start room comes out two-coloured.
   * @param {ZXVideoRAM} videoRAM - Target memory.
   * @param {Object} area - {row, rows} the character rows the sprite may touch.
   * @param {Object} pose - The decoded pose.
   * @param {number} x - Left edge in pixels.
   * @param {number} y - Top edge in screen lines.
   * @param {number} attr - The attribute byte of the entity.
   */
  blitPose(videoRAM, area, pose, x, y, attr) {
    var span = videoRAM.blitShifted(pose.bitmap, pose.cols, pose.height, x, y, area, 'xor');
    if (pose.attributeBlock) {
      this.blitAttributeBlock(videoRAM, area, x, y, pose);
    } else {
      this.fillAttributes(videoRAM, area, x, y, span, pose.height, attr);
    }
  } // blitPose

  /**
   * The attribute block of a piece of castle furniture ($E675): one byte per
   * cell, `cols` wide and `height/8` tall, laid on the cells the sprite covers
   * from its bottom row up. The entity's own colour byte is not used at all.
   * @param {ZXVideoRAM} videoRAM - Target memory.
   * @param {Object} area - {row, rows} the character rows it may touch.
   * @param {number} x - Left edge in pixels.
   * @param {number} y - Top edge of the sprite in screen lines.
   * @param {Object} pose - The pose, with its attributeBlock.
   */
  blitAttributeBlock(videoRAM, area, x, y, pose) {
    var block = pose.attributeBlock;
    var bottom = (y+pose.height-1) >> 3;
    var col0 = Math.floor(x/8);
    for (var row = 0; row < block.rows; row++) {
      var target = bottom-(block.rows-1-row);
      if (target < area.row || target >= area.row+area.rows) {
        continue;
      }
      for (var col = 0; col < block.cols; col++) {
        videoRAM.pokeAttribute(target, col0+col, block.attributes[row*block.cols+col]);
      }
    }
  } // blitAttributeBlock

  /**
   * The colour rectangle of a sprite, the way the original fills it ($9867).
   *
   * Measured in M6 (tools/tracescreen.py logs the fill): it starts on the
   * character row of the sprite's **bottom** line and goes **up**
   *
   *   rows = (height + 8 + ((~y) & 7)) >> 3
   *
   * character rows, each `span` cells wide — the sprite's width in bytes plus
   * one when it does not start on a cell boundary. So the rectangle is one row
   * taller than the sprite needs unless the bottom line sits exactly on a cell
   * boundary, and the sprite colours cells its pixels never reach. Painting
   * only the cells with ink in them would look tidier and would be wrong.
   * @param {ZXVideoRAM} videoRAM - Target memory.
   * @param {Object} area - {row, rows} the character rows it may touch.
   * @param {number} x - Left edge in pixels.
   * @param {number} y - Top edge of the sprite in screen lines.
   * @param {number} span - Width of the rectangle in cells.
   * @param {number} height - Height of the sprite in pixel lines.
   * @param {number} attr - The attribute byte of the entity.
   */
  fillAttributes(videoRAM, area, x, y, span, height, attr) {
    var bottom = y+height-1;
    var count = (height+8+((~bottom) & 7)) >> 3;
    var col0 = Math.floor(x/8);
    for (var i = 0; i < count; i++) {
      var row = (bottom >> 3)-i;
      if (row < area.row || row >= area.row+area.rows) {
        continue;
      }
      for (var col = col0; col < col0+span; col++) {
        videoRAM.pokeAttribute(row, col, attr);
      }
    }
  } // fillAttributes

  /**
   * Draws a one pixel line into the bitmap — the rope. The original plots it
   * with XOR ($AC9A) so it can rub it out again, and so does this.
   * @param {ZXVideoRAM} videoRAM - Target memory.
   * @param {Object} area - {row, rows} the character rows it may touch.
   * @param {number} x1 - Start x in pixels.
   * @param {number} y1 - Start y in screen lines.
   * @param {number} x2 - End x in pixels.
   * @param {number} y2 - End y in screen lines.
   */
  blitLine(videoRAM, area, x1, y1, x2, y2) {
    var top = area.row*8, bottom = (area.row+area.rows)*8;
    var dx = Math.abs(x2-x1), dy = Math.abs(y2-y1);
    var stepX = (x1 < x2) ? 1 : -1, stepY = (y1 < y2) ? 1 : -1;
    var error = dx-dy;
    var x = x1, y = y1;
    for (var guard = 0; guard < 512; guard++) {
      if (x >= 0 && x < ScreenComposer.WIDTH && y >= top && y < bottom) {
        videoRAM.pokeOffset(ZXVideoRAM.lineOffset(y)+(x >> 3), 0x80 >> (x % 8), 'xor');
      }
      if (x === x2 && y === y2) {
        break;
      }
      var double = 2*error;
      if (double > -dy) {
        error -= dy;
        x += stepX;
      }
      if (double < dx) {
        error += dx;
        y += stepY;
      }
    }
  } // blitLine

  /**
   * XORs a sprite cut out of a frame (data/sprites.json, M1) into the bitmap
   * and hands its attributes to the cells it covers. The sprite is placed on a
   * character cell boundary of the play area.
   * @param {ZXVideoRAM} videoRAM - Target memory.
   * @param {Object} area - {row, rows} the character rows it may touch.
   * @param {Object} sprite - The decoded sprite.
   * @param {number} x - Left edge in play area pixels (rounded down to a cell).
   * @param {number} y - Top edge in play area pixels (rounded down to a cell).
   */
  blitSprite(videoRAM, area, sprite, x, y) {
    var col0 = Math.floor(x/8);
    var row0 = area.row+Math.floor(y/8);
    videoRAM.blitShifted(sprite.bitmap, sprite.cols, sprite.rows*8, col0*8, row0*8, area, 'xor');
    for (var row = 0; row < sprite.rows; row++) {
      if (row0+row < area.row || row0+row >= area.row+area.rows) {
        continue;
      }
      for (var c = 0; c < sprite.cols; c++) {
        videoRAM.pokeAttribute(row0+row, col0+c, sprite.attributes[row*sprite.cols+c]);
      }
    }
  } // blitSprite

  // ----------------------------------------------------------- the panel

  /**
   * Composes the panel (character rows 0-1) into a video memory, in the game's
   * own character set. Only the two rows are written; the rest of the memory
   * is left alone.
   *
   * The layout is the measured one (screen_layout.md chap. 2): SCORE on row 0
   * in bright yellow, GEMS and DEPTH on row 1 with cyan labels and white
   * numbers, the Sabreman icon in column 28 and the lives in columns 30-31.
   * @param {ZXVideoRAM} videoRAM - The memory to write.
   * @param {Object} panel - {score, gems, depth, lives, carrying} from the
   *        game state.
   */
  composePanelInto(videoRAM, panel) {
    var area = ScreenComposer.PANEL_AREA;
    // BRIGHT is on over the whole screen and paper is black, so an empty cell
    // is $47 rather than 0 — that is what the original's panel holds
    videoRAM.clearArea(area, 0x47);
    this.writeText(videoRAM, 0, 0,
                   'SCORE '+String(panel.score || 0).padStart(6, '0'), 0x46);
    this.writeText(videoRAM, 1, 0, 'GEMS', 0x45);
    // GEMS and the lives are **BCD** in the original and the panel prints the
    // two nibbles ($9E32: RRCA x4 / AND $0F / ADD A,'0'). GEMS is not a tally
    // of gems collected but the invincibility countdown a gem starts ($8EEE).
    this.writeText(videoRAM, 1, 4, ' '+ScreenComposer.bcd2(panel.gems || 0)+' ', 0x47);
    this.writeText(videoRAM, 1, 8, 'DEPTH', 0x45);
    this.writeText(videoRAM, 1, 13, String(panel.depth || 0).padStart(3, ' '), 0x47);
    this.writeText(videoRAM, 1, 30, ScreenComposer.bcd2(Math.max(0, panel.lives || 0)), 0x47);
    // the icon in column 28: the little Sabreman of the original panel, cut
    // out of a captured frame (data/sprites.json, tools/mksprite.py --raw)
    var icon = this.sprites.panelIcon;
    if (icon) {
      for (var row = 0; row < Math.min(area.rows, icon.rows); row++) {
        var cell = new Uint8Array(8);
        for (var pixel = 0; pixel < 8; pixel++) {
          cell[pixel] = icon.bitmap[(row*8+pixel)*icon.cols];
        }
        videoRAM.pokeCell(row, 28, cell);
        videoRAM.pokeAttribute(row, 28, icon.attributes[row*icon.cols]);
      }
    }
    // the weapons he carries are drawn **in the panel**, side by side at
    // x = $88, $A0, $B8 with their bottom line on $0F ($E910, $E937): the
    // original has no inventory screen, the panel is the inventory (M5)
    (panel.carrying || []).forEach((type, index) => {
      if (!type) { return; }
      var pose = this.poses[type];
      if (!pose) { return; }
      var x = ScreenComposer.CARRY_X+ScreenComposer.CARRY_STEP*index;
      this.blitPose(videoRAM, area, pose, x, ScreenComposer.CARRY_Y-(pose.height-1), 0x47);
    });
  } // composePanelInto

  /**
   * A BCD byte as the two digits the original's panel routine prints.
   * @param {number} value - The BCD byte.
   * @returns {string} Two characters.
   */
  static bcd2(value) {
    return String((value >> 4) & 0x0F)+String(value & 0x0F);
  } // bcd2

  /**
   * Writes a string with the game's character set into the memory.
   * @param {ZXVideoRAM} videoRAM - Target memory.
   * @param {number} row - Character row of the screen.
   * @param {number} col - First character column.
   * @param {string} text - The text; the font has digits and capitals only.
   * @param {number} attr - The attribute byte given to every cell written.
   */
  writeText(videoRAM, row, col, text, attr) {
    for (var i = 0; i < text.length; i++) {
      var target = col+i;
      if (target < 0 || target >= ScreenComposer.COLS) {
        continue;
      }
      videoRAM.pokeCell(row, target, this.font[text.charAt(i)] || ScreenComposer.BLANK);
      videoRAM.pokeAttribute(row, target, attr);
    }
  } // writeText

} // ScreenComposer
