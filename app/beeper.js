// begin code

/**
 * The beeper of the original — M6.
 *
 * The machine has one bit of sound (bit 4 of port $FE) and nothing else, so a
 * sound *is* a list of pulse lengths. `data/sounds.json` holds those lists in
 * Z80 T states, and they are not modelled or tuned by hand: the routines of the
 * original played them in the simulator and `tools/dumpsound.py` wrote down
 * what came out of the port (the same discipline as `data/rooms.json`, where
 * the original's own routine drew the room).
 *
 * There are seven of them and no music at all:
 *
 *   blip   $A07D  2005 Hz for 32 ms          landing, a hit in the air
 *   step   $A087  two pitches, every 4th frame of walking
 *   chirp  $A0E4  sixteen periods sliding down   jumping off, picking a thing up
 *   touch  $A0F5  eight periods, pitch from the toucher's y
 *   death  $A107  a long slide down, length from the frame counter
 *   noise  $A131  48 bytes of the ROM clocked out bit by bit
 *   splash $A173  four periods of 568 Hz      a shot hitting the floor
 *
 * This class turns a train into what the svision pulse handlers take
 * ({fragments, pulses}): lengths in samples instead of T states. The handler
 * starts its output bit low and every sound of the original starts with the bit
 * high, so the whole train comes out inverted — a phase, which no ear hears.
 *
 * Deliberately free of DOM and Node dependencies, so `tools/matchsound.js`
 * can check the shipped code against the recording of the original.
 */
export class Beeper {

  /** T states of a ZX Spectrum second — the clock the pulse lengths are in */
  static get CLOCK() { return 3500000; }

  /**
   * @param {Object} sounds - The parsed data/sounds.json.
   */
  constructor(sounds) {
    this.data = sounds || null;
    this.events = {};
    if (sounds && sounds.events) {
      sounds.events.forEach((entry) => {
        this.events[entry.name] = entry.sound;      // null = silent in the original
      });
    }
    // the original's own walking counter ($8EF6): the step sound is played on
    // every fourth frame of walking and bit 2 of it picks the pitch
    this.stepCounter = 0;
  } // constructor

  /** Back to the state a fresh game starts in. */
  reset() {
    this.stepCounter = 0;
  } // reset

  /**
   * Which of the seven sounds an event of the worker plays.
   * @param {string} event - The name the worker emitted ('step', 'land', ...).
   * @returns {string|null} The sound name, or null when the original is silent.
   */
  soundOf(event) {
    return (event in this.events) ? this.events[event] : null;
  } // soundOf

  /**
   * The pulse train of one event, with the variant the original would pick.
   * @param {string} event - The event name from the worker.
   * @param {Object} [params] - {y: the toucher's y, frames: the frame counter}.
   * @returns {Object|null} {sound, variant, startLevel, pulses} or null for
   *          silence — either because the original has no sound for the event
   *          or because this frame of walking is one of the silent three.
   */
  train(event, params) {
    if (!this.data) { return null; }
    var name = this.soundOf(event);
    if (!name) { return null; }
    var sound = this.data.sounds[name];
    if (!sound) { return null; }
    var key = this.variant(name, params || {});
    if (key === null) { return null; }
    var variant = sound.variants[key];
    if (!variant) { return null; }
    return {sound: name, variant: key, startLevel: variant.startLevel,
            pulses: variant.pulses};
  } // train

  /**
   * Which variant of a sound the original would play — the selection is the
   * `select` field of data/sounds.json, done here in the same arithmetic.
   * @param {string} name - The sound name.
   * @param {Object} params - {y, frames}.
   * @returns {string|null} The variant key, or null when nothing plays.
   */
  variant(name, params) {
    var k = this.data.values;
    if (name === 'step') {
      // $A087: INC (HL); AND 3; RET NZ — three frames out of four are silent
      this.stepCounter = (this.stepCounter+1) & 0xFF;
      if (this.stepCounter & k.stepMask) { return null; }
      return (this.stepCounter & k.stepBit) ? '1' : '0';
    }
    if (name === 'touch') {
      // $A0F5: the pitch comes from (D + y) & $0F, so only the low nibble of
      // the y of whatever touched him matters
      return String((params.y || 0) & k.touchMask);
    }
    if (name === 'death') {
      // $A107: D = (swap nibbles of ($5C78+1) | $0F) & $7F — eight lengths
      return String(((params.frames || 0)+1) & 7);
    }
    return '0';
  } // variant

  /**
   * One named variant of a sound, without asking the events which one it is —
   * the audio manager needs this when it plays what playFrame() picked.
   * @param {string} name - The sound name ('blip', 'step', ...).
   * @param {string} key - The variant key.
   * @returns {Object|null} {sound, variant, startLevel, pulses} or null.
   */
  variantTrain(name, key) {
    if (!this.data || !this.data.sounds[name]) { return null; }
    var variant = this.data.sounds[name].variants[key];
    if (!variant) { return null; }
    return {sound: name, variant: key, startLevel: variant.startLevel,
            pulses: variant.pulses};
  } // variantTrain

  /**
   * A train as the svision pulse handlers want it.
   *
   * The lengths are rounded on a running sum rather than one by one, so a
   * sound is never longer or shorter than the original by the accumulated
   * rounding of a hundred pulses.
   * @param {Object} train - What train() returned.
   * @param {number} sampleRate - The audio context sample rate.
   * @param {number} volume - Bus volume level.
   * @returns {Object|boolean} {fragments, pulses, volume} or false.
   */
  static toPulses(train, sampleRate, volume) {
    if (!train || !train.pulses.length) { return false; }
    var fragments = [];
    var pulses = [];
    var elapsed = 0;
    var written = 0;
    for (var i = 0; i < train.pulses.length; i++) {
      elapsed += train.pulses[i];
      var target = Math.round(elapsed*sampleRate/Beeper.CLOCK);
      var length = target-written;
      if (length < 1) { length = 1; }
      written += length;
      fragments.push(length);
      pulses.push(i);
    }
    return {fragments: fragments, pulses: pulses, volume: volume};
  } // toPulses

  /**
   * How long a train lasts, in milliseconds — the original blocks the game for
   * exactly this long, because it plays the sound inside the game step.
   * @param {Object} train - What train() returned.
   * @returns {number} Milliseconds.
   */
  static duration(train) {
    if (!train) { return 0; }
    var total = 0;
    for (var i = 0; i < train.pulses.length; i++) { total += train.pulses[i]; }
    return 1000*total/Beeper.CLOCK;
  } // duration

} // Beeper
