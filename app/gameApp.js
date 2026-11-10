const { Version } = await import('./version.js?ver='+window.srcVersion);
const { AbstractApp } = await import('./svision/js/abstractApp.js?ver='+window.srcVersion);
const { AudioManager } = await import('./audioManager.js?ver='+window.srcVersion);
const { ZXFonts8x8 } = await import('./svision/js/platform/canvas2D/zx/zxFonts8x8.js?ver='+window.srcVersion);
const { Fonts5x5 } = await import('./svision/js/platform/canvas2D/fonts5x5.js?ver='+window.srcVersion);
const { Fonts3x3 } = await import('./svision/js/platform/canvas2D/fonts3x3.js?ver='+window.srcVersion);
const { ZXResetModel } = await import('./svision/js/platform/canvas2D/zx/zxResetModel.js?ver='+window.srcVersion);
const { MenuModel } = await import('./menuModel.js?ver='+window.srcVersion);
const { MainModel } = await import('./mainModel.js?ver='+window.srcVersion);
const { RoomModel } = await import('./roomModel.js?ver='+window.srcVersion);
const { RoomsMapModel } = await import('./roomsMapModel.js?ver='+window.srcVersion);
const { GameOverModel } = await import('./gameOverModel.js?ver='+window.srcVersion);
const { TapeLoadingModel } = await import('./tapeLoadingModel.js?ver='+window.srcVersion);
const { ZXErrorEntity } = await import('./svision/js/platform/canvas2D/zx/zxErrorEntity.js?ver='+window.srcVersion);
const { Tool } = await import('./svision/js/tool.js?ver='+window.srcVersion);
const { ZXColor } = await import('./svision/js/platform/canvas2D/zx/zxColor.js?ver='+window.srcVersion);
// begin code

/**
 * Underwurlde application shell (M1 skeleton, built on the Jet Set Willy one —
 * the closest sibling: a ZX game with rooms on ZXPlatform).
 * LoadingModel -> MenuModel -> MainModel (title) -> RoomModel (the game) ->
 * GameOverModel, plus TapeLoadingModel and RoomsMapModel off the menu.
 *
 * The game state kept here is the measured one: six lives and a starting
 * DEPTH of 15, both read off the running original (disasm_notes.md chap. 5
 * and 6). The scoring table, the weapons and the world come later.
 */
export class GameApp extends AbstractApp {

  constructor(platform, importPath, wsURL, devModeName, appIconSprite) {
    super(platform, 'bodyApp', importPath, wsURL);

    this.worker = new Worker(this.importPath+'/gameWorker.js?ver='+window.srcVersion);
    this.worker.onmessage = (event) => {
      if (this.model) {
        this.model.handleWorkerMessage(event);
      }
    };

    this.version = Version;
    this.copyright = '©␣2026␣Libor␣Mitrenga, CC␣BY⋅NC⋅SA';
    this.devModeName = devModeName;
    this.appIconSprite = appIconSprite;

    this.audioManager = new AudioManager(this);
    this.muted = {sounds: false};

    this.fonts = {
      zxFonts8x8Mono: new ZXFonts8x8(this, false),
      zxFonts8x8: new ZXFonts8x8(this, true),
      fonts5x5: new Fonts5x5(this),
      fonts3x3: new Fonts3x3(this)
    };
    // Hard/short spaces live in the game (svision core fonts have the normal space only).
    this.fonts.fonts5x5.addSpace('␣', {width: 2, breaking: false, stretch: true});

    this.fonts.zxFonts8x8.addSpace('␣', {width: 3, breaking: false, stretch: false});

    // The original is played on Q W R E T (left, right, up/jump, down, fire),
    // CAPS/Z/X/C/V let go of a rope and B/N/M/SYMBOL SHIFT/SPACE pick a weapon
    // up or put it down (ZADANI chap. 1). Those letters are the defaults here;
    // the arrow keys always work as well and everything can be remapped.
    this.controlsOptions = {
      keyboard: {
        device: 'keyboard',
        keys: [
          {action: 'left', label: 'WALKING LEFT'},
          {action: 'right', label: 'WALKING RIGHT'},
          {action: 'up', label: 'UP / JUMP'},
          {action: 'down', label: 'DOWN'},
          {action: 'fire', label: 'FIRE'},
          {action: 'drop', label: 'LET GO OF ROPE'},
          {action: 'take', label: 'TAKE / DROP WEAPON'},
          {action: 'sounds', label: 'MUTE SOUNDS'}
        ]
      },
      mouse: {
        device: 'mouse',
        keys: [
          {action: 'left', label: 'WALKING LEFT'},
          {action: 'right', label: 'WALKING RIGHT'},
          {action: 'up', label: 'UP / JUMP'}
        ]
      },
      gamepads: {
        device: 'gamepads',
        keys: [
          {action: 'left', label: 'WALKING LEFT', eventKey: 'GamepadLeft'},
          {action: 'right', label: 'WALKING RIGHT', eventKey: 'GamepadRight'},
          {action: 'up', label: 'UP / JUMP', eventKey: 'GamepadJump'},
          {action: 'down', label: 'DOWN', eventKey: 'GamepadDown'},
          {action: 'fire', label: 'FIRE', eventKey: 'GamepadFire'},
          {action: 'drop', label: 'LET GO OF ROPE', eventKey: 'GamepadOK'},
          {action: 'take', label: 'TAKE / DROP WEAPON', eventKey: 'GamepadTake'},
          {action: 'exit', label: 'EXIT', eventKey: 'GamepadExit'}
        ]
      },
      touchscreen: {
        device: 'touchscreen',
        types: {
          keys: [
            'leftJump',
            'rightJump'
          ],
          leftJump: {
            left: {
              type: 'button',
              control: false,
              action: 'up',
              actions: false,
              sprite: 'jump'
            },
            right: {
              type: 'joystick',
              control: 'horizontal',
              action: false,
              actions: ['left', 'right'],
              sprite: 'left-right'
            }
          },
          rightJump: {
            left: {
              type: 'joystick',
              control: 'horizontal',
              action: false,
              actions: ['left', 'right'],
              sprite: 'left-right'
            },
            right: {
              type: 'button',
              control: false,
              action: 'up',
              actions: false,
              sprite: 'jump'
            }
          }
        },
        icons: {
          jump: {
            compressedSpriteData: 'lP101300N0A970111030Z0510122382012345617171859'
          },
          'left-right': {
            compressedSpriteData: 'lP101300N08B701050P020N06910121213421245641465421243121217'
          }
        }
      }
    };

    this.controls = {
      keyboard: this.getControls('keyboard'),
      mouse: this.getControls('mouse'),
      touchscreen: this.getControls('touchscreen'),
      gamepads: this.getControls('gamepads')
    };

    // measured on the running original (disasm_notes.md chap. 5 and 6)
    this.lives = 6;
    this.depth = 15;
    this.score = 0;
    this.gems = 0;
    this.hiScore = false;
    this.roomName = 'room000';
    this.sandbox = false;
    this.trainingRoom = null;      // M5: room picked on the map
    this.mapPick = false;
    this.roomPosition = {column: 0, row: 0};
    this.playerName = Tool.readCookie('playerName', '');
    this.globalData = false;
    this.id = 'GameApp';
    this.fetchDataId = '';
    this.setModel('LoadingModel');
    this.loadAppData();
  } // constructor

  getControls(device) {
    var result = {};

    switch (device) {
      case 'keyboard':
        // B/N/M/SYMBOL SHIFT/SPACE take or drop a weapon on the original
        // (half-row $7F, read at $94E2) — SPACE is the one of them a browser
        // reports plainly, so it is the default here
        result = {left: 'Q', right: 'W', up: 'R', down: 'E', fire: 'T', drop: 'X',
                  take: ' ', sounds: 'S'};
        break;
      case 'mouse':
        result = {enable: false, left: 'Mouse1', right: 'Mouse2', up: 'Mouse4'};
        break;
      case 'touchscreen':
        result = {supported: false, type: 'leftJump'};
        break;
      case 'gamepads':
        result = {supported: false, devices: {}};
        break;
    }

    switch (device) {
      case 'keyboard':
      case 'mouse':
      case 'touchscreen':
        var cfgString = Tool.readCookie(device, false);
        if (cfgString !== false) {
          try {
            var cfg = JSON.parse(cfgString);
            Object.keys(cfg).forEach((item) => {
              result[item] = cfg[item];
              if (device == 'touchscreen' && !(result[item] in this.controlsOptions.touchscreen.types)) {
                result[item] = this.controlsOptions.touchscreen.types.keys[0];
              }
            });
          } catch (error) {
            console.error(error.message);
          }
        }
        break;
      case 'gamepads':
        var devicesString = Tool.readCookie('gamepads', false);
        if (devicesString !== false) {
          try {
            var devices = JSON.parse(devicesString);
          } catch (error) {
            console.error(error.message);
          } finally {
            if (Array.isArray(devices)) {
              devices.forEach((id) => {
                var deviceString = Tool.readCookie(id, false);
                if (deviceString !== false) {
                  try {
                    var device = JSON.parse(deviceString);
                  } catch (error) {
                    console.error(error.message);
                  } finally {
                    result.devices[id] = device;
                  }
                }
              });
            }
          }
        }
        break;
    }
    return result;
  } // getControls

  setModel(model) {
    if (model == 'MenuModel' && this.globalData === false) {
      // the fetch may still be pending or has failed: as a last resort try the
      // data cached in localStorage before bothering the user
      if (!this.loadGlobalDataFromStorage()) {
        this.showErrorMessage('Game data could not be loaded.', 'retry');
        return;
      }
    }
    var needResizeApp = false;
    var selectionItem = 0;
    if (this.model) {
      if (this.model.id == 'TapeLoadingModel') {
        selectionItem = 7;
      }
      if (this.model.id == 'RoomsMapModel') {
        selectionItem = 6;
      }
      this.model.shutdown();
      needResizeApp = true;
    }
    switch (model) {
      case 'LoadingModel':
        this.model = new ZXResetModel(this);
        break;
      case 'MenuModel':
        this.model = new MenuModel(this, selectionItem);
        break;
      case 'MainModel':
        this.model = new MainModel(this);
        break;
      case 'RoomModel':
        this.model = new RoomModel(this);
        break;
      case 'RoomsMapModel':
        this.model = new RoomsMapModel(this);
        break;
      case 'GameOverModel':
        this.model = new GameOverModel(this, 'MenuModel');
        break;
      case 'TapeLoadingModel':
        this.model = new TapeLoadingModel(this);
        break;
    } // switch
    this.model.init();
    if (needResizeApp) {
      this.resizeApp();
    }
  } // setModel

  /**
   * Starts a new game in the initial room.
   * @param {boolean} [sandbox] - True opens the M3 physics sandbox instead:
   *        the same screen and the same worker, but a cave room with a rope, a
   *        platform and a pit (roomModel.buildScene).
   * @param {Object} [trainingRoom] - {column, row} picked on the map (M5):
   *        start in that room instead of the game's own start room. A
   *        convenience of the remake, not of the original.
   */
  startRoom(sandbox, trainingRoom) {
    this.score = 0;
    this.gems = 0;
    this.lives = (this.globalData && this.globalData.lives) || 6;
    this.depth = (this.globalData && this.globalData.startDepth) || 15;
    this.roomName = (this.globalData && this.globalData.initRoom) || 'room000';
    this.sandbox = !!sandbox;
    this.trainingRoom = trainingRoom || null;
    this.setModel('RoomModel');
  } // startRoom

  applyGlobalData(global) {
    this.globalData = global;
    this.lives = global.lives || this.lives;
    this.depth = global.startDepth || this.depth;
    this.roomName = global.initRoom || this.roomName;
  } // applyGlobalData

  setGlobalData(data) {
    this.applyGlobalData(data.data.global);

    var files = {};
    Object.keys(data.data).forEach((key) => {
      if (key == 'hiScore') {
        this.hiScore = data.data[key];
      } else if (key != 'global') {
        files[key] = data.data[key];
      }
    });
    // global goes last; a full localStorage is cleared and tried once more
    // (R-062)
    this.saveAppDataToStorage(files, data.data.global);
    if (data.data.room000 && data.data.room000.column !== undefined) {
      this.roomPosition = {column: data.data.room000.column, row: data.data.room000.row};
    }
  } // setGlobalData

  // Load the application data: from the server when online (which also refreshes
  // localStorage), or rehydrate the global data from localStorage when offline.
  loadAppData() {
    if (navigator.onLine) {
      this.fetchDataId = this.fetchData('appData.db', false, {}, this, 2000);
    } else {
      this.loadGlobalDataFromStorage();
    }
  } // loadAppData

  loadGlobalDataFromStorage() {
    var stored = localStorage.getItem(window.appPrefix+'.global');
    if (stored !== null) {
      try {
        this.applyGlobalData(JSON.parse(stored));
        return true;
      } catch (error) {
        console.error(error.message);
      }
    }
    return false;
  } // loadGlobalDataFromStorage

  setData(data) {
    this.setGlobalData(data);
  } // setData

  errorData(error) {
    // The network request failed (offline, unreachable server, or the fetch
    // timeout). Fall back to the data cached in localStorage; if none exists,
    // log it and let the MenuModel guard surface the error to the user.
    if (!this.loadGlobalDataFromStorage()) {
      console.error(error.message ? error.message : error);
      return;
    }
    if (this.model && this.model.id == 'ZXResetModel'
        && !this.model.events.some((queued) => queued.id == 'setMenuModel')
        && !this.model.desktopEntity.modalEntity) {
      this.setModel('MenuModel');
    }
  } // errorData

  showErrorMessage(message, action) {
    var topModalEntity = this.model.desktopEntity.topModalEntity();
    topModalEntity.addModalEntity(
      new ZXErrorEntity(
        topModalEntity,
        -topModalEntity.absoluteX(),
        -topModalEntity.absoluteY(),
        this.fonts.zxFonts8x8,
        message,
        action,
        ZXColor.white,
        ZXColor.red
      )
    );
  } // showErrorMessage

} // GameApp
