const { AbstractAudioManager } = await import('./svision/js/audio/abstractAudioManager.js?ver='+window.srcVersion);
const { AudioWorkletHandler } = await import('./svision/js/audio/audioWorkletHandler.js?ver='+window.srcVersion);
const { AudioScriptProcessorHandler } = await import('./svision/js/audio/audioScriptProcessorHandler.js?ver='+window.srcVersion);
const { AudioSilentHandler } = await import('./svision/js/audio/audioSilentHandler.js?ver='+window.srcVersion);
const { Tool } = await import('./svision/js/tool.js?ver='+window.srcVersion);
const { ZXMachineSounds } = await import('./svision/js/platform/canvas2D/zx/zxMachineSounds.js?ver='+window.srcVersion);
const { Beeper } = await import('./beeper.js?ver='+window.srcVersion);
// begin code

/**
 * Audio manager. The original has a one-bit beeper and no sound chip, so every
 * sound is a stream of pulse lengths played by the svision
 * pulse handlers — the same way the machine makes sound, not sampled.
 *
 * M6 filled it with the game's own sounds. There are seven of them, they come
 * out of data/sounds.json (the routines of the original played them in the
 * simulator, tools/dumpsound.py) and app/beeper.js turns them into pulses.
 * There is **no music**: the whole program has four OUT ($FE),A instructions
 * and all of them belong to the seven effects, so the remake has no music bus
 * either — an empty volume slider would be a lie.
 */
export class AudioManager extends AbstractAudioManager {

  constructor(app) {
    super(app);
    this.id = 'AudioManager';
    this.volume = {};
    this.volume.sounds = Math.min(10, Math.max(0, Math.round(Number(Tool.readCookie('audioBusSoundsLevel', 5)))));
    // the beeper starts empty and fills itself from data/sounds.json as soon as
    // appData has it in store; until then the game is simply silent
    this.beeper = new Beeper(null);
    this.loadSounds();
  } // constructor

  /**
   * Reads data/sounds.json out of the appData store (the same way
   * TapeLoadingModel reads the loading screen) and hands it to the beeper.
   * @returns {boolean} True when the beeper has its data.
   */
  loadSounds() {
    if (this.beeper.data) {
      return true;
    }
    try {
      // through the model: a file its loadDataFiles() had to get from the
      // server is there, not in localStorage (R-062)
      var model = this.app.model;
      var data = model && model.loadDataFile ? model.loadDataFile('sounds') : JSON.parse(localStorage.getItem(window.appPrefix+'.sounds'));
      if (data) {
        this.beeper = new Beeper(data);
        return true;
      }
    } catch (error) {
      console.error(error.message);
    }
    return false;
  } // loadSounds

  createAudioHandler(bus, options) {
    var audioHandler = false;

    var volume = 0.0;
    switch (bus) {
      case 'sounds':
      case 'extra':
        volume = this.volumeLevel(this.volume.sounds);
        break;
    }

    if (options.audioSilentHandler != 'disable' && volume == 0.0) {
      return new AudioSilentHandler(this.app);
    }

    if (this.unsupportedAudioBus == false) {
      this.unsupportedAudioBus = Tool.readCookie('unsupportedAudioBus', false);
    }

    switch (this.unsupportedAudioBus) {
      case false:
        audioHandler = new AudioWorkletHandler(this.app);
        break;
      case 'AudioWorkletHandler':
        Tool.writeCookie('unsupportedAudioBus', 'AudioWorkletHandler');
        audioHandler = new AudioScriptProcessorHandler(this.app);
        break;
      case 'AudioScriptProcessorHandler':
        Tool.writeCookie('unsupportedAudioBus', 'AudioScriptProcessorHandler');
        audioHandler = new AudioSilentHandler(this.app);
        break;
    }

    if (bus in this.restartSounds) {
      this.app.model.sendEvent(1, {id: 'playSound', bus: bus, sound: this.restartSounds[bus].sound, options: this.restartSounds[bus].options});
    }

    return audioHandler;
  } // createAudioHandler

  audioData(bus, sound, options) {
    var data = super.audioData(bus, sound, options);
    if (data !== false) {
      return data;
    }

    var sampleRate = this.getSampleRate();
    var sounds = this.volumeLevel(this.volume.sounds);
    this.loadSounds();
    switch (sound) {
      case 'tapePilotToneSound': return ZXMachineSounds.tapePilotTone(sampleRate, sounds);
      case 'tapeRndDataSound': return ZXMachineSounds.tapeRndData(sampleRate, sounds);
      case 'basicBeepsSound': return ZXMachineSounds.basicBeeps(sampleRate, sounds);
      case 'keyboardSound': return ZXMachineSounds.keyClick(sampleRate, sounds);
      // one of the seven sounds of the game: which one and which variant is in
      // the options, the pulses come out of data/sounds.json
      case 'gameSound':
        return Beeper.toPulses(this.beeper.variantTrain(options.sound, options.variant),
                               sampleRate, sounds);
      // the sample the SOUNDS volume dialog plays — a real sound of the game
      // (the chirp of a jump), not an invented one
      case 'chirpSound':
        return Beeper.toPulses(this.beeper.variantTrain('chirp', '0'),
                               sampleRate, sounds);
    }
    return false;
  } // audioData

  volumeLevel(volume) {
    var levels = [0, 0.005, 0.01, 0.02, 0.04, 0.07, 0.1, 0.14, 0.18, 0.23, 0.29];
    return levels[volume];
  } // volumeLevel

  /**
   * One worker frame: what the game did in it, as sound.
   *
   * Every event goes through the beeper even when it will not be heard,
   * because the step sound keeps a counter of its own ($8EF6) and it has to
   * move on every frame of walking, not only on the audible fourth one.
   *
   * Of what is left only the **first** sound is played. That is not a
   * shortcut: the original plays a sound inside the game step, with the
   * processor stopped in a DJNZ loop, so it can never play two at once
   * either — a sound simply delays the next frame there.
   * @param {Object} frame - The 'frame' message from the worker.
   */
  playFrame(frame) {
    if (!frame || !frame.sounds || !frame.sounds.length) {
      return;
    }
    if (!this.loadSounds()) {
      return;
    }
    var chosen = false;
    frame.sounds.forEach((item) => {
      var train = this.beeper.train(item.name, item);
      if (train && chosen === false) {
        chosen = train;
      }
    });
    if (chosen !== false) {
      this.playSound('sounds', 'gameSound',
                     {sound: chosen.sound, variant: chosen.variant});
    }
  } // playFrame

  /** A new game starts the walking counter of the step sound over. */
  resetBeeper() {
    this.beeper.reset();
  } // resetBeeper

} // AudioManager
