const { AbstractModel } = await import('./svision/js/abstractModel.js?ver='+window.srcVersion);
const { AbstractEntity } = await import('./svision/js/abstractEntity.js?ver='+window.srcVersion);
const { BorderEntity } = await import('./borderEntity.js?ver='+window.srcVersion);
const { TextEntity } = await import('./svision/js/platform/canvas2D/textEntity.js?ver='+window.srcVersion);
const { ButtonEntity } = await import('./svision/js/platform/canvas2D/buttonEntity.js?ver='+window.srcVersion);
const { ScreenLayout } = await import('./screenLayout.js?ver='+window.srcVersion);
const { ZXColor } = await import('./svision/js/platform/canvas2D/zx/zxColor.js?ver='+window.srcVersion);
// begin code

/**
 * The map of the world: the 16 x 52 grid of the original, drawn from the room
 * data M2 pulled out of the game (data/world.json, tools/dumprooms.py).
 *
 * The grid is not a guess any more: the room table sits at $7000 in the game,
 * a room is addressed as $7000 + 32*row + 2*column, and 598 of the 832 places
 * are taken (the inlay says 597 — see data/README.md). Every taken place is
 * drawn here; the start room is highlighted.
 *
 * Which rooms connect to which is in the same one descriptor byte per room
 * (bits 0/2/4/6 are the closed sides), so the transitions M4 needs are already
 * in the data.
 *
 * M5 gives the screen a second job: opened from TRAINING ROOM it lets a room
 * be **picked** and starts the game there. That is a convenience of the remake
 * (the original has no such thing, like the menu and the hall of fame), and it
 * is the room selection ZADANI chap. 5 asks the options for.
 */

/**
 * The grid as one clickable surface: 598 buttons would be 598 entities, so the
 * cell is worked out from where the click landed instead.
 */
class RoomGridEntity extends AbstractEntity {

  constructor(parentEntity, x, y, width, height, bkColor, cell) {
    super(parentEntity, x, y, width, height, false, bkColor);
    this.id = 'RoomGridEntity';
    this.cell = cell;
  } // constructor

  handleEvent(event) {
    if (super.handleEvent(event)) {
      return true;
    }
    if (event.id !== 'keyRelease' || this.hide) {
      return false;
    }
    if (event.key !== 'Mouse1' && event.key !== 'Touch') {
      return false;
    }
    if (!this.pointOnEntity(event)) {
      return false;
    }
    var column = Math.floor((event.x-this.parentX-this.x-1)/this.cell);
    var row = Math.floor((event.y-this.parentY-this.y-1)/this.cell);
    this.sendEvent(0, 0, {id: 'pickRoom', column: column, row: row});
    return true;
  } // handleEvent

} // RoomGridEntity
export class RoomsMapModel extends AbstractModel {

  constructor(app) {
    super(app);
    this.id = 'RoomsMapModel';

    this.cell = 4;
    this.gridEntity = null;
    // opened from TRAINING ROOM: a click on a room starts the game there
    this.pick = !!app.mapPick;
    this.world = null;
  } // constructor

  newBorderEntity() {
    return new BorderEntity(true, false);
  } // newBorderEntity

  init() {
    super.init();

    this.borderEntity.bkColor = ZXColor.black;
    this.desktopEntity.bkColor = ZXColor.black;

    this.desktopEntity.addEntity(new TextEntity(this.desktopEntity, this.app.fonts.zxFonts8x8, 0, 8, this.desktopWidth, 8, 'THE UNDERWURLDE', ZXColor.brightYellow, false, {align: 'center'}));

    // the data files: at once from localStorage, or from the server when
    // they are missing there (R-062)
    this.loadDataFiles(['world'], (files, error) => this.initData(files, error));
  } // init

  /**
   * The part of init() that needs the data files: the rooms on the map.
   * Runs inside init() when they are in localStorage, later when they had
   * to come from the server.
   * @param {Object|null} files - The data files, or null.
   * @param {Error} [error] - Why they are missing.
   */
  initData(files, error) {
    if (this.app.model !== this) {
      return;
    }
    if (!files) {
      this.app.showErrorMessage(error ? error.message : 'Game data could not be loaded.', 'restart');
    }
    var width = ScreenLayout.WORLD_COLS*this.cell;
    var height = ScreenLayout.WORLD_ROWS*this.cell;
    var x = Math.floor((this.desktopWidth-width)/2);
    var y = 32;
    this.gridEntity = new RoomGridEntity(this.desktopEntity, x-1, y-1, width+2, height+2, this.pick ? ZXColor.brightYellow : ZXColor.blue, this.cell);
    this.desktopEntity.addEntity(this.gridEntity);
    this.gridEntity.addEntity(new AbstractEntity(this.gridEntity, 1, 1, width, height, false, ZXColor.black));

    // every room of the world, from the data extracted in M2
    var world = this.loadDataFile('world');
    this.world = world;
    var rooms = 0;
    if (world && world.descriptors) {
      for (var row = 0; row < world.descriptors.length; row++) {
        for (var column = 0; column < ScreenLayout.WORLD_COLS; column++) {
          if (world.descriptors[row].substring(column*2, column*2+2) === '00') {
            continue;
          }
          rooms++;
          this.gridEntity.addEntity(new AbstractEntity(this.gridEntity, 1+column*this.cell, 1+row*this.cell, this.cell, this.cell, false, ZXColor.cyan));
        }
      }
    }

    // the start room on top of that
    var room = this.app.roomPosition;
    this.gridEntity.addEntity(new AbstractEntity(this.gridEntity, 1+room.column*this.cell, 1+room.row*this.cell, this.cell, this.cell, false, ZXColor.brightYellow));

    this.desktopEntity.addEntity(new TextEntity(this.desktopEntity, this.app.fonts.fonts5x5, 8, y+height+8, this.desktopWidth-16, 20,
      rooms ? (this.pick ? 'PICK A ROOM TO START IN. '  : '')
              +ScreenLayout.WORLD_COLS+' x '+ScreenLayout.WORLD_ROWS+' CELLS, '+rooms+' ROOMS, EXTRACTED FROM THE ORIGINAL.'
            : 'WORLD DATA MISSING (data/world.json). RUN tools/dumprooms.py.',
      ZXColor.white, false, {align: 'center', textWrap: true}));

    this.desktopEntity.addEntity(new ButtonEntity(this.desktopEntity, this.app.fonts.fonts5x5, this.desktopWidth/2-20, this.desktopHeight-20, 40, 13, 'BACK', {id: 'closeMap'}, ['Enter', 'Escape', ' ', 'GamepadOK', 'GamepadExit'], ZXColor.brightWhite, ZXColor.blue, {align: 'center', margin: 4}));
  } // initData


  handleEvent(event) {
    if (super.handleEvent(event)) {
      return true;
    }

    switch (event.id) {
      case 'closeMap':
        this.app.mapPick = false;
        this.app.setModel('MenuModel');
        return true;

      case 'pickRoom':
        if (!this.pick || !this.roomExists(event.column, event.row)) {
          return true;
        }
        this.app.mapPick = false;
        this.app.startRoom(false, {column: event.column, row: event.row});
        return true;
    }

    return false;
  } // handleEvent

  /**
   * Is there a room at these grid coordinates? (data/world.json, M2)
   * @param {number} column - Column in the 16 x 52 grid.
   * @param {number} row - Row in the grid.
   * @returns {boolean} True when the room table has a room there.
   */
  roomExists(column, row) {
    if (!this.world || !this.world.descriptors || !this.world.descriptors[row]) {
      return false;
    }
    if (column < 0 || column >= ScreenLayout.WORLD_COLS) {
      return false;
    }
    return this.world.descriptors[row].substring(column*2, column*2+2) !== '00';
  } // roomExists

  loopModel(timestamp) {
    super.loopModel(timestamp);
    this.drawModel();
  } // loopModel

} // RoomsMapModel
