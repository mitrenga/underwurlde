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
      zxFonts8x8Keys: new ZXFonts8x8(this, false),
      fonts5x5: new Fonts5x5(this),
      fonts3x3: new Fonts3x3(this)
    };
    // ZX key-cap glyphs for the key-remap screen (ZXRemapKeysEntity)
    this.fonts.zxFonts8x8Keys.setFontsData('00000000000000000010101010001000002424000000000014147E28FC505000107C507C14547C1042A44810244A8400001028102A443A00000810000000000000182020202018000030080808083000000014083E081400000008083E0808000000000000080810000000003E00000000000000001818000204081020408000007C4C5454647C000018280808083E00007C440438407C00007C441804447C00001828487E081C00007C407C04447C00007C407C44447C00007C440810101000007C443844447C00007C44447C047C000000001000001000000010000010102000000408100804000000003E003E00000000100804081000007C441C100010003C42BD85BDA5BE78003C42427E42E70000FC427C4242FC00007E424040427E0000FE42424242FE0000FE42784042FE0000FE42784040E000007E42404E427E0000E7427E4242E700007C101010107C00007E08080848780000E648705844E60000E040404242FE0000C3665A4242E70000C762524A46E700007E424242427E0000FE42427E40E000007E424242527E0800FE42427E44E700007E407E02427E0000FE92101010380000CE444444447E0000E742424224180000D7929292926C0000EE44382844EE0000EE442810103800007E440810227E001C10101010101C0000004020100804003808080808083800001038541010100000000000000000FF003C247020207C0000007C047C447E00C0407C4444447C0000007C4440407C000C047C4444447E0000007C447C407C003C2470202020700000007C44447C047CC0407C444444E6001000701010107C000800380808084878C0404C506058CC007010101010107C000000FC545454D6000000FC444444E60000007C4444447C0000007E22223E207000007C44447C040600007C242020700000007C407C04FC0000207820202038000000CC4444447E000000CE44442838000000D65454547E000000C6281028C6000000CC44447C047C00007E4418227E00000E083008080E0000080808080808000070100C1010700000142800000000003C4299A1A199423C');
    // Extra glyphs + hard/short spaces live in the game (svision core fonts are ASCII + normal space).
    this.fonts.fonts5x5.addGlyphs({
      'Ⓥ': {width: 3, data: [[0,2,1,1], [0,3,1,1], [1,4,1,1], [2,3,1,1], [2,2,1,1]]},
      '←': {width: 6, data: [[0,2,6,1], [1,1,1,3], [2,0,1,5]]},
      '↓': {width: 5, data: [[2,0,1,5], [1,3,3,1], [0,2,5,1]]},
      '↑': {width: 5, data: [[2,0,1,5], [1,1,3,1], [0,2,5,1]]},
      '→': {width: 6, data: [[0,2,6,1], [4,1,1,3], [3,0,1,5]]},
      // blinking cursor for the key-remap screen
      '█': {width: 4, data: [[0,0,4,5]]},
      // devModeName banner decoration
      '◢': {width: 4, data: [[4,0,1,1], [3,1,2,1], [2,2,3,1], [1,3,4,1], [0,4,5,1]]},
      '◤': {width: 4, data: [[0,0,5,1], [0,1,4,1], [0,2,3,1], [0,3,2,1], [0,4,1,1]]}
    });
    this.fonts.fonts5x5.addSpace('␣', {width: 2, breaking: false, stretch: true});

    this.fonts.zxFonts8x8.addGlyphs('‗⋅', '000000000000F8F80000000030000000');
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
