const { ZXVideoRAMEntity } = await import('./svision/js/platform/canvas2D/zx/zxVideoRAMEntity.js?ver='+window.srcVersion);
const { ScreenLayout } = await import('./screenLayout.js?ver='+window.srcVersion);
// begin code

/**
 * The room: 256x176 pixels below the panel, character rows 2-23
 * (sources/docs/screen_layout.md). ScreenComposer composes the frame into the
 * entity's video memory — the same DOM-free module an offline tool uses — and
 * the library turns the bytes into pixels once per game frame (R-003).
 *
 * Feed it with setFrame() from the worker 'frame' message (WORKER-PROTOCOL.md).
 */
export class GameAreaEntity extends ZXVideoRAMEntity {

  /**
   * @param {AbstractEntity} parentEntity - The parent entity.
   * @param {number} x - X position relative to the parent.
   * @param {number} y - Y position relative to the parent.
   * @param {ScreenComposer} render - The shared renderer.
   */
  constructor(parentEntity, x, y, render) {
    super(parentEntity, x, y, {row: ScreenLayout.PANEL_ROWS, rows: ScreenLayout.PLAY_ROWS});
    this.id = 'GameAreaEntity';

    this.render = render;
    this.frameState = {};
  } // constructor

  /**
   * Stores the state of the newest frame and invalidates the cache.
   * @param {Object} state - {sabreman, entities, rope} as sent by the worker.
   */
  setFrame(state) {
    this.frameState = state;
    this.invalidate();
  } // setFrame

  /**
   * Composes the room with the frame's entities into the video memory;
   * ZXVideoRAMEntity calls it only when the cache is dirty.
   */
  compose() {
    this.render.composeInto(this.videoRAM, this.frameState);
  } // compose

} // GameAreaEntity
