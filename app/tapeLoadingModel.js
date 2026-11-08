const { AbstractModel } = await import('./svision/js/abstractModel.js?ver='+window.srcVersion);
const { BorderEntity } = await import('./borderEntity.js?ver='+window.srcVersion);
const { ScreenEntity } = await import('./screenEntity.js?ver='+window.srcVersion);
const { TextEntity } = await import('./svision/js/platform/canvas2D/textEntity.js?ver='+window.srcVersion);
const { ScreenLayout } = await import('./screenLayout.js?ver='+window.srcVersion);
const { ZXColor } = await import('./svision/js/platform/canvas2D/zx/zxColor.js?ver='+window.srcVersion);
// begin code

/**
 * Loading from tape, the way the original does it: LOAD "" typed on the ZX
 * keyboard, the pilot tone and data stripes in the border, the header name and
 * then the loading screen appearing character row by character row — the real
 * one off the original tape (data/loading.json, block #22 of the TZX, verified
 * byte for byte against the memory of the running game, disasm_notes.md).
 *
 * M6 added what the original does next: the tape stops and the game puts up its
 * **title screen**, the GAME SELECTION picture with the four control choices
 * (data/title.json, copied out of the video memory of the running original).
 * It stays there and nothing else happens — the original has no attract mode
 * and no demo, which tools/dumptitle.py checks by watching the screen for
 * twenty-six seconds and finding not one byte changed.
 *
 * The tape is Speedlock ("hyperload"), so the timing here is the plain ZX one
 * rather than Underwurlde's own; that is a show, not a claim.
 */
export class TapeLoadingModel extends AbstractModel {

  constructor(app) {
    super(app);
    this.id = 'TapeLoadingModel';

    this.inputLineEntity = null;
    this.commandPhase = 0;
    this.command = ['K', 'LOAD L', 'LOAD "L', 'LOAD ""L', ''];
    this.programNameEntity = null;
    this.screenEntity = null;
    this.app.stack.flashState = false;
    this.tapeBreak = false;
    this.tapePhase = false;
    this.loadingStart = false;
    this.loadingDuration = 0;
    this.tape = [
      {id: 'pause', duration: 1000},

      {id: 'pilot', duration: 3000},
      {id: 'data', duration: 100},
      {id: 'pause', duration: 800, event: {id: 'setProgramName'}},
      {id: 'pilot', duration: 1500},
      {id: 'data', duration: 1400},

      {id: 'pause', duration: 1000, event: {id: 'showLoadingScreen'}},

      {id: 'pilot', duration: 2500},
      {id: 'data', duration: 5000},

      // the tape stops and the game shows its title screen
      {id: 'pause', duration: 3000, event: {id: 'showTitleScreen'}}
    ];
  } // constructor

  init() {
    super.init();

    this.borderEntity.bkColor = ZXColor.white;
    this.desktopEntity.bkColor = ZXColor.white;

    this.inputLineEntity = new TextEntity(this.desktopEntity, this.app.fonts.zxFonts8x8Mono, 0, 23*8, 32*8, 8, '© 1982 Sinclair Research Ltd', ZXColor.black, false, {align: 'left'});
    this.desktopEntity.addEntity(this.inputLineEntity);

    this.programNameEntity = new TextEntity(this.desktopEntity, this.app.fonts.zxFonts8x8, 0, 1*8, 32*8, 8, 'Program: Underwurlde', ZXColor.black, false, {leftMargin: 1});
    this.programNameEntity.hide = true;
    this.desktopEntity.addEntity(this.programNameEntity);

    // the loading and the title screen the tape shows later: at once from
    // localStorage, or from the server when they are missing there (R-062)
    this.loadDataFiles(['loading', 'title'], (files, error) => this.initData(files, error));
  } // init

  /**
   * The part of init() that starts the tape: the screens it shows come with
   * the data files. Runs inside init() when they are in localStorage, later
   * when they had to come from the server.
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
    this.sendEvent(0, {id: 'openAudioBus', bus: 'sounds', options: {}});
    this.sendEvent(1000, {id: 'updateCommand'});

    this.app.stack.flashState = false;
    this.sendEvent(330, {id: 'changeFlashState'});
  } // initData

  newBorderEntity() {
    return new BorderEntity(true, false);
  } // newBorderEntity

  shutdown() {
    super.shutdown();
    this.sendEvent(0, {id: 'closeAllAudioBuses'});
  } // shutdown


  handleEvent(event) {
    if (super.handleEvent(event)) {
      return true;
    }

    switch (event.id) {

      case 'changeFlashState':
        this.app.stack.flashState = !this.app.stack.flashState;
        this.sendEvent(330, {id: 'changeFlashState'});
        return true;

      case 'updateCommand':
        this.inputLineEntity.options.align = 'left';
        this.inputLineEntity.fonts = this.app.fonts.zxFonts8x8Mono;
        this.inputLineEntity.options.animationMode = 'flashReverseColors';
        this.inputLineEntity.setText(this.command[this.commandPhase]);
        this.inputLineEntity.options.flashMask = '';
        if (this.command[this.commandPhase].length > 0) {
          this.inputLineEntity.options.flashMask = this.inputLineEntity.options.flashMask.padStart(this.command[this.commandPhase].length-1, ' ')+'#';
        }
        this.commandPhase++;
        this.sendEvent(0, {id: 'playSound', bus: 'sounds', sound: 'keyboardSound', options: false});
        if (this.commandPhase < this.command.length) {
          this.sendEvent(800, {id: 'updateCommand'});
        } else {
          this.inputLineEntity.hide = true;
          this.tapePhase = 0;
          this.sendEvent(1, {id: 'updateTape'});
        }
        return true;

      case 'updateTape':
        switch (this.tape[this.tapePhase].id) {
          case 'pilot':
            this.sendEvent(0, {id: 'playSound', bus: 'sounds', sound: 'tapePilotToneSound', options: {repeat: true}});
            this.sendEvent(0, {id: 'setBorderAnimation', value: 'pilotTone'});
            break;
          case 'data':
            this.sendEvent(0, {id: 'playSound', bus: 'sounds', sound: 'tapeRndDataSound', options: false});
            this.sendEvent(0, {id: 'setBorderAnimation', value: 'dataTone'});
            break;
          case 'pause':
            this.sendEvent(0, {id: 'stopAudioBus', bus: 'sounds'});
            this.sendEvent(0, {id: 'setBorderAnimation', value: false});
            break;
        }
        if ('event' in this.tape[this.tapePhase]) {
          this.sendEvent(0, this.tape[this.tapePhase].event);
        }
        this.tapePhase++;
        if (this.tapePhase < this.tape.length) {
          this.sendEvent(this.tape[this.tapePhase-1].duration, {id: 'updateTape'});
        } else {
          this.sendEvent(this.tape[this.tapePhase-1].duration, {id: 'setMenuModel'});
        }
        return true;

      case 'setProgramName':
        this.programNameEntity.hide = false;
        return true;

      case 'showLoadingScreen':
        var loading = this.loadDataFile('loading');
        if (loading) {
          this.programNameEntity.destroy();
          this.programNameEntity = null;
          this.screenEntity = new ScreenEntity(this.desktopEntity, 0, 0, loading);
          this.screenEntity.setRevealed(0);
          this.desktopEntity.addEntity(this.screenEntity);
          this.desktopEntity.bkColor = ZXColor.black;
          this.borderEntity.bkColor = ZXColor.black;
          // the picture appears over the two blocks that still follow
          this.loadingDuration = this.tape[this.tape.length-2].duration+this.tape[this.tape.length-1].duration;
          this.loadingStart = this.app.now;
        }
        this.sendEvent(0, {id: 'playSound', bus: 'sounds', sound: 'basicBeepsSound', options: false});
        return true;

      case 'showTitleScreen':
        var title = this.loadDataFile('title');
        if (title && this.screenEntity) {
          this.screenEntity.setScreen(title);
        }
        return true;

      case 'setMenuModel':
        this.app.setModel('MenuModel');
        return true;

      case 'keyPress':
        switch (event.key) {
          case 'Escape':
          case 'GamepadExit':
            this.app.setModel('MenuModel');
            return true;
          case ' ':
          case 'Enter':
          case 'GamepadOK':
            if (this.break()) {
              return true;
            }
            break;
          case 'Mouse1':
          case 'Mouse2':
          case 'Mouse4':
            this.app.inputEventsManager.keysMap[event.key] = this.borderEntity;
            return true;
          case 'Touch':
            this.app.inputEventsManager.touchesMap[event.identifier] = this.borderEntity;
            return true;
        }
        break;

      case 'keyRelease':
        switch (event.key) {
          case 'Mouse1':
          case 'Mouse2':
          case 'Mouse4':
            if (this.app.inputEventsManager.keysMap[event.key] === this.borderEntity && this.break()) {
              return true;
            }
            return true;
          case 'Touch':
            if (this.app.inputEventsManager.touchesMap[event.identifier] === this.borderEntity && this.break()) {
              return true;
            }
            return true;
        }
        break;

      case 'errorAudioBus':
        this.app.showErrorMessage(event.error, 'reopen');
        return true;
    }

    return false;
  } // handleEvent

  /**
   * Stops the load the way BREAK does on the real machine, or leaves when the
   * tape is already past the point of no return.
   * @returns {boolean} True when the event was consumed.
   */
  break() {
    if (this.tapeBreak) {
      this.app.setModel('MenuModel');
      return true;
    }

    if (this.tapePhase !== false) {
      if (this.tapePhase > 6) {
        this.app.setModel('MenuModel');
        return true;
      }
      this.cancelEvent('updateTape');
      this.cancelEvent('setMenuModel');
      this.sendEvent(0, {id: 'stopAudioBus', bus: 'sounds'});
      this.tapeBreak = true;
      this.inputLineEntity.setText('D BREAK - CONT repeats, 0:1');
      this.inputLineEntity.hide = false;
      this.sendEvent(0, {id: 'setBorderAnimation', value: false});
      this.sendEvent(5000, {id: 'setMenuModel'});
      return true;
    }
    return false;
  } // break

  loopModel(timestamp) {
    super.loopModel(timestamp);

    if (this.screenEntity && this.loadingStart !== false && !this.tapeBreak) {
      var progress = (timestamp-this.loadingStart)/this.loadingDuration;
      this.screenEntity.setRevealed(progress*ScreenLayout.ROWS);
    }

    this.drawModel();
  } // loopModel

} // TapeLoadingModel
