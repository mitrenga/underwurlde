// begin code

/**
 * Geometry of the Underwurlde screen, measured on the running original —
 * sources/docs/screen_layout.md (the panel down to the last character cell,
 * read out of the video RAM of a captured frame, not off a photograph).
 *
 * The screen is the plain ZX Spectrum one: 256x192 pixels, attributes in 8x8
 * cells. The top two character rows are the panel, the remaining 22 rows
 * (256x176) are the room.
 */
export const ScreenLayout = {

  WIDTH: 256,
  HEIGHT: 192,

  CELL: 8,
  COLS: 32,
  ROWS: 24,

  // panel: character rows 0-1, pixels y = 0..15
  PANEL_ROWS: 2,
  PANEL_HEIGHT: 16,

  // room: character rows 2-23, pixels y = 16..191
  PLAY_Y: 16,
  PLAY_ROWS: 22,
  PLAY_WIDTH: 256,
  PLAY_HEIGHT: 176,

  // The world grid, measured in M2 on the room table of the original ($7000,
  // a room is $7000 + 32*row + 2*column): 16 columns by 52 rows, 598 of the
  // 832 places taken. DEPTH in the panel is the row number + 1.
  // (M0 read 16 x 50 off the screenshot map — that was wrong, see
  // sources/docs/disasm_notes.md chap. 10.)
  WORLD_COLS: 16,
  WORLD_ROWS: 52,

  // Attribute bytes of the panel, read from the frame (disasm_notes.md chap. 4).
  // Paper is black everywhere and BRIGHT is on all over the screen.
  ATTR_SCORE: 0x46,        // bright yellow on black
  ATTR_LABEL: 0x45,        // bright cyan on black
  ATTR_VALUE: 0x47,        // bright white on black

  // 50.08 Hz — 69888 T states per frame on a 3.5 MHz Z80 (hw_notes.md).
  // The game logic hangs off the ULA interrupt, so this is the simulation step.
  FRAME_RATE: 3500000/69888

}; // ScreenLayout
