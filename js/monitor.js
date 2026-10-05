// Cache tripwire: every module carries the stage it shipped with, and boot.js
// refuses to run a mix.
export const MODULE_STAGE = 'stage12.196';

// uDuke - the camera monitors' picture: xyzmirror(), premap.c 342.
//
// Duke draws a camera's view INTO the monitor's tile: setviewtotile() points
// the frame buffer at the tile, drawrooms() renders from the camera sprite
// (its x, y, z, angle, sector, horiz 100 + its shade), animatesprites() with
// display_mirror = 1 (the player's own sprite shows), drawmasks(), and
// squarerotatetile() turns the row-major picture into the tile's columns. The
// tile then shows on the VIEWSCREEN sprite like any texture, through its own
// shading. loadtile() puts the tile's own picture back when the monitor is let
// go (actors.c 2142).
//
// uDuke's renderer writes packed RGBA, not palette indices, so the picture is
// turned back into indices here: every colour the renderer can produce comes
// from the palette through a shade table, so an exact match is the rule; a
// blend (translucency) is the exception, and gets the nearest colour.

/** Packed RGBA (as the renderer writes it) to palette index, from the 768-byte palette. */
export function paletteReverse(rgb, littleEndian = true) {
  const exact = new Map();
  const cols = [];
  for (let i = 0; i < 255; i++) {                     // 255 is the transparent index
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    const packed = (littleEndian ? ((255 << 24) | (b << 16) | (g << 8) | r) : ((r << 24) | (g << 16) | (b << 8) | 255)) >>> 0;
    if (!exact.has(packed)) exact.set(packed, i);
    cols.push([r, g, b]);
  }
  const near = new Map();
  return (packed) => {
    const p = packed >>> 0;
    const e = exact.get(p);
    if (e !== undefined) return e;
    const n = near.get(p);
    if (n !== undefined) return n;
    const r = littleEndian ? p & 255 : (p >>> 24) & 255;
    const g = littleEndian ? (p >>> 8) & 255 : (p >>> 16) & 255;
    const b = littleEndian ? (p >>> 16) & 255 : (p >>> 8) & 255;
    let best = 0, bd = Infinity;
    for (let i = 0; i < cols.length; i++) {
      const dr = cols[i][0] - r, dg = cols[i][1] - g, db = cols[i][2] - b;
      const d = dr * dr + dg * dg + db * db;
      if (d < bd) { bd = d; best = i; }
    }
    near.set(p, best);
    return best;
  };
}

/**
 * The rendered view (row-major packed RGBA, w x h) into a tile's pixels
 * (column-major indices, Build's layout) — what drawrooms into the tile plus
 * squarerotatetile leave behind: the picture upright on the screen sprite.
 */
export function viewToTile(pixels, w, h, toIndex) {
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    const col = x * h;
    for (let y = 0; y < h; y++) out[col + y] = toIndex(pixels[y * w + x]);
  }
  return out;
}

/**
 * setviewtotile + setaspect(65536, 65536): the tile's view is 90 degrees
 * across like the screen's, but its rows are not the screen's. xdimenscale =
 * scale(xdimen, yxaspect, 320) = 65536*w/320 makes the vertical focal 0.4*w
 * where the screen's is 0.64*ydim — so as a Renderer, refHeight is w*200/320
 * (focalY = 0.64*refHeight) and the horiz unit follows it, as globalhoriz =
 * (horiz-100)*xdimenscale/65536 + h/2 does.
 */
export function tileViewOptions(w) {
  return { refHeight: w * 200 / 320, tall: true };
}

/**
 * xyzmirror(i, tile) itself: the camera sprite's view rendered at the tile's
 * size and written into the tile. `env` carries what the page has: the level
 * (map, vm, res, radarang), the art, the palette, the Renderer class and
 * animateSprites; `state` keeps the tile renderer, the reverse palette and
 * every tile's own pixels (for loadtile) between calls. Returns true when the
 * tile was redrawn.
 */
export function drawMonitor(env, state, camIdx, tileNum) {
  const { map, vm, res, radarang, art, rgb, Renderer, animateSprites, clock = 0 } = env;
  const s = map.sprites[camIdx], t = art.get(tileNum);
  if (!s || s.removed || s.sectNum < 0 || !t || !(t.width > 0) || !(t.height > 0)) return false;
  if (!state.renderer || state.renderer.width !== t.width || state.renderer.height !== t.height) {
    state.renderer = new Renderer(t.width, t.height, 90, tileViewOptions(t.width));
  }
  if (!state.reverse) state.reverse = paletteReverse(rgb);
  if (!state.originals) state.originals = new Map();
  const eye = { x: s.x, y: s.y, z: s.z, ang: s.ang, horiz: 100 + s.shade, sectNum: s.sectNum };
  // animatesprites with display_mirror = 1: the actors' frames as seen from
  // the camera, and the player's own sprite shown (showPlayer).
  const animateFor = vm && animateSprites ? (c) => animateSprites(map, vm, c, radarang, art) : null;
  if (animateFor) animateFor(eye);
  state.renderer.render(eye, { ...res, textures: true, clock,
    playerSprite: vm?.playerSprite ?? -1, holoduke: vm?.holoduke ?? -1, showPlayer: true, animateFor });
  if (!state.originals.has(tileNum)) state.originals.set(tileNum, t.pixels);
  t.pixels = viewToTile(state.renderer.pixels, t.width, t.height, state.reverse);
  return true;
}

/** loadtile(): a tile's own picture back; with no tile, every one. */
export function restoreMonitor(art, state, tileNum) {
  if (!state.originals) return;
  for (const [n, px] of [...state.originals]) {
    if (tileNum !== undefined && n !== tileNum) continue;
    const t = art.get(n);
    if (t) t.pixels = px;
    state.originals.delete(n);
  }
}
