const { AbstractModel } = await import('./svision/js/abstractModel.js?ver='+window.srcVersion);
const { BorderEntity } = await import('./borderEntity.js?ver='+window.srcVersion);
const { TextEntity } = await import('./svision/js/platform/canvas2D/textEntity.js?ver='+window.srcVersion);
const { PauseGameEntity } = await import('./pauseGameEntity.js?ver='+window.srcVersion);
const { ZXColor } = await import('./svision/js/platform/canvas2D/zx/zxColor.js?ver='+window.srcVersion);
const { ScreenLayout } = await import('./screenLayout.js?ver='+window.srcVersion);
const { ScreenComposer } = await import('./screenComposer.js?ver='+window.srcVersion);
const { GameAreaEntity } = await import('./gameAreaEntity.js?ver='+window.srcVersion);
const { GameInfoEntity } = await import('./gameInfoEntity.js?ver='+window.srcVersion);
// begin code

/**
 * The game screen: the panel on character rows 0-1 and one room below it, the
 * flick-screen layout of the original (sources/docs/screen_layout.md).
 *
 * M1 shows a single static room — the real video memory of a running original
 * (data/room000.json, tools/mkroom.py) with Sabreman in the one pose measured
 * so far — and the panel set in the game's own character set. The worker
 * (gameWorker.js, WORKER-PROTOCOL.md) ticks at the original's 50.08 Hz and
 * this model routes the controls to it and draws what comes back. The room
 * data format, the world and the measured physics arrive in M2 and M3.
 */
export class RoomModel extends AbstractModel {

  constructor(app) {
    super(app);
    this.id = 'RoomModel';

    this.gameOver = false;
    this.controlsState = {left: false, right: false, up: false, down: false,
                          fire: false, drop: false, take: false};
    this.worker = null;
    this.render = null;
    this.roomData = null;
    this.scene = null;
    this.rooms = null;
    this.shownRoom = false;
    this.gameAreaEntity = null;
    this.gameInfoEntity = null;
    this.fpsEntity = null;
    this.fps = {frames: 0, workerFrames: 0, ticks: 0, since: false, lastFrame: false};
  } // constructor

  newBorderEntity() {
    return new BorderEntity(true, this.app.controls.touchscreen.supported);
  } // newBorderEntity

  init() {
    super.init();

    // Border colour of the original is still an open question (ZADANI chap. 7);
    // the captured frames show black, so black it is until it is measured.
    this.borderEntity.bkColor = ZXColor.black;
    this.desktopEntity.bkColor = ZXColor.black;

    // the data files: at once from localStorage, or from the server when
    // they are missing there (R-062)
    this.loadDataFiles([this.app.roomName, 'font', 'sprites', 'spriteframes', 'physics', 'world', 'entities', 'monsters', 'sounds'], (files, error) => this.initData(files, error));
  } // init

  /**
   * The part of init() that needs the data files: the scene, the screen and
   * the start of the worker. Runs inside init() when they are in
   * localStorage, later when they had to come from the server.
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
    this.scene = this.buildScene();
    if (!this.initScreen()) {
      this.desktopEntity.addEntity(new TextEntity(this.desktopEntity, this.app.fonts.zxFonts8x8, 0, 8*8, this.desktopWidth, 8, 'UNDERWURLDE', ZXColor.brightWhite, false, {align: 'center'}));
      this.desktopEntity.addEntity(new TextEntity(this.desktopEntity, this.app.fonts.fonts5x5, 8, 8*8+16, this.desktopWidth-16, 40,
        'ROOM DATA MISSING (data/room000.json). RUN tools/mkroom.py.', ZXColor.brightGreen, false, {align: 'center', textWrap: true}));
      return;
    }

    if (this.app.devModeName !== false) {
      this.fpsEntity = new TextEntity(this.desktopEntity, this.app.fonts.fonts3x3, 16*8, 2, 10*8, 4, '', ZXColor.brightGreen, false, {align: 'right'});
      this.desktopEntity.addEntity(this.fpsEntity);
    }

    // the menu keeps the audio closed; the game opens its bus here. There is
    // only the one: the original has no music (M6, data/sounds.json).
    this.sendEvent(0, {id: 'openAudioBus', bus: 'sounds', options: {muted: this.app.muted.sounds}});
    if (this.app.audioManager) {
      // the step sound counts its own frames of walking ($8EF6); a new game
      // starts that counter over
      this.app.audioManager.resetBeeper();
    }

    this.worker = this.app.worker;
    this.app.inputEventsManager.sendEventsActiveKeys('Press');
    this.sendWorkerMessage({
      id: 'init',
      initData: {
        headless: false,
        lives: this.app.lives,
        depth: this.app.depth,
        physics: this.loadDataFile('physics'),
        world: {descriptors: (this.loadDataFile('world') || {}).descriptors},
        entities: this.loadDataFile('entities'),
        monsters: this.loadDataFile('monsters'),
        scene: this.scene
      }
    });

    if (this.scene && this.scene.variant !== undefined) {
      this.loadRoomImage(this.scene.variant);
    }

    this.app.stack.flashState = false;
    this.sendEvent(330, {id: 'changeFlashState'});
  } // initData

  shutdown() {
    super.shutdown();
    this.sendWorkerMessage({id: 'reset'});
    this.sendEvent(0, {id: 'stopAllAudioBuses'});
  } // shutdown


  /**
   * Builds the renderer and adds the panel and the room.
   * @returns {boolean} True when the screen was created.
   */
  initScreen() {
    this.roomData = this.loadDataFile(this.app.roomName);
    if (!this.roomData) {
      return false;
    }
    try {
      this.render = new ScreenComposer(this.roomData, this.loadDataFile('font'),
                                    this.loadDataFile('sprites'),
                                    this.loadDataFile('spriteframes'));
    } catch (error) {
      console.error(error.message);
      return false;
    }
    this.gameInfoEntity = new GameInfoEntity(this.desktopEntity, 0, 0, this.render);
    this.desktopEntity.addEntity(this.gameInfoEntity);
    this.gameAreaEntity = new GameAreaEntity(this.desktopEntity, 0, ScreenLayout.PLAY_Y, this.render);
    this.desktopEntity.addEntity(this.gameAreaEntity);
    this.gameInfoEntity.setPanel({score: this.app.score, gems: this.app.gems, depth: this.app.depth, lives: this.app.lives});
    return true;
  } // initScreen

  /**
   * Which room Sabreman is in and what is in it. Everything here is the
   * original's own data: the room is addressed in the 16 x 52 grid of the room
   * table at $7000 (data/world.json), the spawn is the game's own template
   * from $AA3C (data/physics.json) and the entities are records in the format
   * the sensors of the original read ($E1B4 platforms, $AE81 ropes).
   *
   * The M3 sandbox is a cave room of the original with a closed ceiling, a
   * closed right wall and an open floor (descriptor $AF, column 7 row 16): the
   * ceiling is what a rope hangs from, the wall is something to bounce off —
   * and that matters, because a jump caps the falling speed below the deadly
   * one, so only a tumble (after a bounce) can build up enough of it — and the
   * open floor is the pit to build it up in. The two things to stand on are
   * entities of type $58 — in the original those are the volcanic bubbles, the
   * only thing besides the floor its physics lets Sabreman stand on ($E1B4).
   * They are off to the sides, because the rope hangs in the middle of the
   * room and catches anything that falls past it.
   *
   * A fall out of the open floor really does leave the room: one room is only
   * 176 pixels high and a fall that short can never reach the deadly speed
   * (measured: it takes some 53 steps to fall a room and 58 to become fatal),
   * so dying needs more than one room. The rooms below come from the world
   * data; their images are fetched as Sabreman arrives (loadRoomImage). The
   * The transitions themselves came with the physics in M3, and M4 added what
   * the world puts in each room (worldEntities.js, data/entities.json) — so
   * outside the sandbox nothing here places anything: the room fills itself
   * the way the original fills it. The sandbox keeps its two hand-placed
   * bubbles because it is a place to try the physics in, not a room of the
   * game; the bubble slots are the ones room entry does not touch, so they
   * survive it.
   * @returns {Object} The scene block of the init message.
   */
  buildScene() {
    var physics = this.loadDataFile('physics');
    var spawn = (physics && physics.values && physics.values.spawnRecord) || [9, 0x40, 9, 0x9F, 14];
    if (!this.app.sandbox) {
      // TRAINING ROOM picked on the map (M5): the same start position, another
      // room. The room fills itself the way the original fills it.
      var pick = this.app.trainingRoom;
      var col0 = pick ? pick.column : spawn[2];
      var row0 = pick ? pick.row : spawn[4];
      return {col: col0, row: row0, x: spawn[1], y: spawn[3],
              variant: this.roomVariant(col0, row0)};
    }
    var col = 7, row = 16;
    return {
      col: col, row: row, x: 0x60, y: 0x9F,
      variant: this.roomVariant(col, row),
      // the second byte of a room record is state, not data: bit 3 says a rope
      // hangs in the room (disasm_notes.md chap. 13, $AE81)
      roomState: {'7,16': 0x08},
      entities: [
        {address: 0x8F5A, record: [0x58, 0x40, col, 0x90, row, 0x45]},
        {address: 0x8F6A, record: [0x58, 0x98, col, 0xA0, row, 0x45]}
      ]
    };
  } // buildScene

  /**
   * The image number of a room (data/world.json variants).
   * @param {number} col - Column in the world grid.
   * @param {number} row - Row in the world grid.
   * @returns {number|undefined} The variant, or undefined when there is none.
   */
  roomVariant(col, row) {
    var world = this.loadDataFile('world');
    if (!world || !world.variants || !world.variants[row]) {
      return undefined;
    }
    return parseInt(world.variants[row].substr(col*2, 2), 16);
  } // roomVariant

  /**
   * Puts the room Sabreman is in on screen when he has changed rooms.
   * @param {number} col - Column in the world grid.
   * @param {number} row - Row in the world grid.
   */
  showRoom(col, row) {
    if (this.shownRoom === col+','+row) {
      return;
    }
    this.shownRoom = col+','+row;
    var variant = this.roomVariant(col, row);
    if (variant !== undefined) {
      this.loadRoomImage(variant);
    }
  } // showRoom

  /**
   * Fetches data/rooms.json and puts the image of a room on screen.
   * The 100 room images are deliberately not in appData (data/README.md):
   * they are fetched once and then indexed as Sabreman walks the world.
   * @param {number} variant - The image number from data/world.json.
   */
  loadRoomImage(variant) {
    if (this.rooms) {
      this.setRoomImage(this.rooms, variant);
      return;
    }
    fetch('data/rooms.json').then((response) => response.json()).then((rooms) => {
      this.rooms = rooms;
      this.setRoomImage(rooms, variant);
    }).catch((error) => console.error(error.message));
  } // loadRoomImage

  /**
   * Hands one room image from data/rooms.json to the renderer.
   * @param {Object} rooms - The parsed data/rooms.json.
   * @param {number} variant - The image number.
   */
  setRoomImage(rooms, variant) {
    {
      var image = rooms.variants && rooms.variants[variant];
      if (!image || !this.render) {
        return;
      }
      this.render.setRoom({width: rooms.width, height: rooms.height,
                           bitmap: image.bitmap, attributes: image.attributes});
      if (this.gameAreaEntity) {
        this.gameAreaEntity.cleanCache();
      }
    }
  } // setRoomImage

  sendWorkerMessage(event) {
    if (this.worker) {
      this.worker.postMessage(event);
    }
  } // sendWorkerMessage

  /**
   * Sets one control and sends the whole state to the worker when it changed.
   * @param {string} action - The control action.
   * @param {boolean} value - Pressed or released.
   */
  setControl(action, value) {
    if (!(action in this.controlsState) || this.controlsState[action] === value) {
      return;
    }
    this.controlsState[action] = value;
    this.sendWorkerMessage(Object.assign({id: 'controls'}, this.controlsState));
  } // setControl

  handleWorkerMessage(event) {
    var data = event.data;
    switch (data.id) {
      case 'frame':
        this.fps.workerFrames++;
        // ★ R-045: a tiky světa zvlášť, odečtené z čítače ve zprávě
        if (this.fps.lastFrame !== false) { this.fps.ticks += data.frame-this.fps.lastFrame; }
        this.fps.lastFrame = data.frame;
        this.app.score = data.score;
        this.app.gems = data.gems;
        this.app.depth = data.depth;
        this.app.lives = data.lives;
        this.showRoom(data.sabreman.col, data.sabreman.row);
        if (this.gameAreaEntity) {
          this.gameAreaEntity.setFrame({sabreman: data.sabreman, rope: data.rope,
                                        entities: data.entities,
                                        carrying: data.carrying});
        }
        if (this.gameInfoEntity) {
          this.gameInfoEntity.setPanel({score: data.score, gems: data.gems,
                                        depth: data.depth, lives: data.lives,
                                        carrying: data.carrying});
        }
        if (data.sounds && data.sounds.length && this.app.audioManager) {
          this.app.audioManager.playFrame(data);
        }
        break;
      case 'gameOver':
        if (!this.gameOver) {
          this.gameOver = true;
          this.app.score = data.score;
          this.app.setModel('GameOverModel');
        }
        break;
    }
  } // handleWorkerMessage

  /**
   * Maps a key, gamepad or mouse event onto a control action.
   *
   * The original is played on Q W R E T (left, right, up, down, fire) with
   * CAPS/Z/X/C/V letting go of a rope and B/N/M/SYMBOL SHIFT/SPACE taking or
   * dropping a weapon (ZADANI chap. 1). Those are the
   * defaults; the arrow keys are always accepted as well, and everything can
   * be remapped from SETTINGS.
   * @param {string} key - The event key.
   * @returns {string|false} The action, or false.
   */
  controlAction(key) {
    var kb = this.app.controls.keyboard, mouse = this.app.controls.mouse;
    var mouseOk = (k) => mouse.enable && this.app.inputEventsManager.keysMap[k] === false;
    switch (key) {
      case kb.left: case 'ArrowLeft': case 'GamepadLeft': return 'left';
      case kb.right: case 'ArrowRight': case 'GamepadRight': return 'right';
      case kb.up: case 'ArrowUp': case 'GamepadJump': return 'up';
      case kb.down: case 'ArrowDown': case 'GamepadDown': return 'down';
      case kb.fire: case 'GamepadFire': return 'fire';
      case kb.drop: case 'GamepadOK': return 'drop';
      // B/N/M/SYMBOL SHIFT/SPACE on the original ($94E2): take or drop a weapon
      case kb.take: case 'GamepadTake': return 'take';
      case mouse.left: return mouseOk(mouse.left) ? 'left' : false;
      case mouse.right: return mouseOk(mouse.right) ? 'right' : false;
      case mouse.up: return mouseOk(mouse.up) ? 'up' : false;
    }
    return false;
  } // controlAction

  handleEvent(event) {
    if (super.handleEvent(event)) {
      return true;
    }

    switch (event.id) {

      case 'changeFlashState':
        this.app.stack.flashState = !this.app.stack.flashState;
        this.sendEvent(330, {id: 'changeFlashState'});
        return true;

      case 'exitGame':
        this.app.setModel('MenuModel');
        return true;

      case 'blurWindow':
        this.pauseGame();
        return true;

      case 'continueGame':
        this.sendWorkerMessage({id: 'continue'});
        this.sendEvent(0, {id: 'continueAllAudioBuses'});
        return true;

      case 'keyPress':
        var key = event.key;
        if (key.length == 1) {
          key = key.toUpperCase();
        }
        switch (key) {
          // The original pauses on ENTER (ZADANI chap. 1), but the remake's
          // pause panel is bound to Escape only, so ENTER stays free
          case 'Escape':
          case 'GamepadExit':
            this.pauseGame();
            return true;
          case 'Touch':
            if (this.borderEntity.leftControlEntity && this.borderEntity.leftControlEntity.pointOnEntity(event)) {
              this.app.inputEventsManager.touchesMap[event.identifier] = this.borderEntity.leftControlEntity;
              this.touchStart(event, 'left');
              return true;
            }
            if (this.borderEntity.rightControlEntity && this.borderEntity.rightControlEntity.pointOnEntity(event)) {
              this.app.inputEventsManager.touchesMap[event.identifier] = this.borderEntity.rightControlEntity;
              this.touchStart(event, 'right');
              return true;
            }
            break;
          case 'RetryTouch':
            this.setControl(event.action, true);
            return true;
          case this.app.controls.keyboard.sounds:
            this.app.muted.sounds = !this.app.muted.sounds;
            this.sendEvent(0, {id: 'muteAudioBus', bus: 'sounds', muted: this.app.muted.sounds});
            return true;
        }
        var action = this.controlAction(key);
        if (action !== false) {
          this.setControl(action, true);
          return true;
        }
        break;

      case 'keyRelease':
        var releasedKey = event.key;
        if (releasedKey.length == 1) {
          releasedKey = releasedKey.toUpperCase();
        }
        if (releasedKey == 'Touch') {
          this.touchEnd(event);
          return true;
        }
        var releasedAction = this.controlAction(releasedKey);
        if (releasedAction !== false) {
          this.setControl(releasedAction, false);
          return true;
        }
        break;

      case 'keyMove':
        if (event.key == 'Touch') {
          this.touchMove(event);
          return true;
        }
        break;

      case 'errorAudioBus':
        this.app.showErrorMessage(event.error, 'reopen');
        return true;
    }

    return false;
  } // handleEvent

  /** pauses the worker and opens the pause menu */
  pauseGame() {
    if (this.desktopEntity.modalEntity || this.gameOver) {
      return;
    }
    this.sendWorkerMessage({id: 'pause'});
    this.sendEvent(0, {id: 'pauseAllAudioBuses'});
    this.desktopEntity.addModalEntity(new PauseGameEntity(this.desktopEntity, 52, 40, 153, 85, 'PAUSE GAME', 'MenuModel'));
  } // pauseGame

  // touch controls: the border's left/right halves carry a button or a
  // horizontal joystick according to controlsOptions.touchscreen.types
  touchStart(event, side) {
    var ts = this.app.controlsOptions.touchscreen.types[this.app.controls.touchscreen.type][side];
    if (ts.type == 'button') {
      this.setControl(ts.action, true);
    }
    this.app.inputEventsManager.touchesGameControls[event.identifier] = {center: {x: event.x, y: event.y}, type: ts.type, control: ts.control, action: ts.action, actions: ts.actions};
  } // touchStart

  touchEnd(event) {
    var controls = this.app.inputEventsManager.touchesGameControls;
    if (event.identifier in controls) {
      if (controls[event.identifier].action !== false) {
        this.setControl(controls[event.identifier].action, false);
      }
      delete controls[event.identifier];
    }
  } // touchEnd

  touchMove(event) {
    var controls = this.app.inputEventsManager.touchesGameControls;
    if (!(event.identifier in controls)) {
      return;
    }
    var control = controls[event.identifier];
    var action = control.action;
    if (control.type == 'joystick' && control.control == 'horizontal') {
      if (event.x-control.center.x < -10) {
        action = control.actions[0];
        control.center.x = event.x;
      }
      if (event.x-control.center.x > 10) {
        action = control.actions[1];
        control.center.x = event.x;
      }
      if (control.action !== action) {
        if (control.action !== false) {
          this.setControl(control.action, false);
        }
        control.action = action;
        this.setControl(control.action, true);
      }
    }
  } // touchMove

  updateFps(timestamp) {
    if (!this.fpsEntity) {
      return;
    }
    this.fps.frames++;
    if (this.fps.since === false) {
      this.fps.since = timestamp;
      return;
    }
    var elapsed = timestamp-this.fps.since;
    if (elapsed >= 1000) {
      this.fpsEntity.setText(Math.round(this.fps.frames*1000/elapsed)+'/'+Math.round(this.fps.workerFrames*1000/elapsed)+'/'+Math.round(this.fps.ticks*1000/elapsed)+' FPS');
      this.fps.frames = 0;
      this.fps.workerFrames = 0;
      this.fps.ticks = 0;
      this.fps.since = timestamp;
    }
  } // updateFps

  loopModel(timestamp) {
    super.loopModel(timestamp);

    if (this.desktopEntity.modalEntity) {
      this.desktopEntity.modalEntity.loopEntity(timestamp);
    }

    this.updateFps(timestamp);
    this.drawModel();
  } // loopModel

} // RoomModel
