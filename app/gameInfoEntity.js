const { ZXVideoRAMEntity } = await import('./svision/js/platform/canvas2D/zx/zxVideoRAMEntity.js?ver='+window.srcVersion);
const { ScreenLayout } = await import('./screenLayout.js?ver='+window.srcVersion);
// begin code

/**
 * The panel: character rows 0-1, SCORE / GEMS / DEPTH, the Sabreman icon in
 * column 28 and the lives in columns 30-31 — the layout measured character by
 * character on the running original (sources/docs/screen_layout.md chap. 2).
 * M5 adds the weapons he carries: the original draws them here, side by side
 * at x = $88, $A0, $B8 ($E910), so the panel doubles as the inventory.
 *
 * It is set in the game's own character set ($ED24, data/font.json), not in an
 * svision font, so the panel is the original's own picture down to the pixel.
 * Whether the original repaints both rows every frame or only the changed
 * fields is still open (screen_layout.md chap. 3); here the cache is rebuilt
 * only when a value changes.
 */
export class GameInfoEntity extends ZXVideoRAMEntity {

  /**
   * @param {AbstractEntity} parentEntity - The parent entity.
   * @param {number} x - X position relative to the parent.
   * @param {number} y - Y position relative to the parent.
   * @param {ScreenComposer} render - The shared renderer.
   */
  constructor(parentEntity, x, y, render) {
    super(parentEntity, x, y, {row: 0, rows: ScreenLayout.PANEL_ROWS});
    this.id = 'GameInfoEntity';

    this.render = render;
    this.panel = {score: 0, gems: 0, depth: 0, lives: 0, carrying: ''};
  } // constructor

  /**
   * Updates the panel values, repainting only when something changed.
   * @param {Object} panel - {score, gems, depth, lives}.
   */
  setPanel(panel) {
    var changed = false;
    Object.keys(this.panel).forEach((key) => {
      // the weapons he carries are an array, so they are compared as a string
      var value = (key === 'carrying') ? (panel.carrying || []).join(',') : panel[key];
      if (key in panel && value !== this.panel[key]) {
        this.panel[key] = value;
        changed = true;
      }
    });
    if (changed) {
      this.invalidate();
    }
  } // setPanel

  /**
   * Composes the panel into the video memory; ZXVideoRAMEntity calls it only
   * when the cache is dirty.
   */
  compose() {
    this.render.composePanelInto(this.videoRAM, Object.assign({}, this.panel, {
      carrying: this.panel.carrying
        ? this.panel.carrying.split(',').map(Number) : []
    }));
  } // compose

} // GameInfoEntity
