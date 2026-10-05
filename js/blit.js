// Cache tripwire: see con.js.
export const MODULE_STAGE = 'stage12.196';

// uDuke - the 2D layer in software: tiles written straight into the frame's
// pixels, as Build's rotatesprite writes into the frame buffer.
//
// Now a frame is ONE array: the 3D view, the tilt, the tiles, all in it, and
// ONE putImageData. The browser's canvas only adds the colour fills and the
// text.
//
// Pixels are packed RGBA as the renderer writes them (Uint32, little-endian:
// alpha in the top byte); a source pixel with alpha 0 is transparent (ART
// index 255, as tileToRgba leaves it).

/** A tile as packed pixels, row-major, optionally mirrored left-right (rotatesprite's x-flip). */
export function tileSource(rgba, flipX = false) {
  const { width: w, height: h } = rgba;
  const src = new Uint32Array(rgba.data.buffer.slice(0));
  if (flipX) for (let y = 0; y < h; y++) src.subarray(y * w, y * w + w).reverse();
  return { w, h, px: src };
}

const blend66 = (s, d) => {
  // translucency at about two thirds (displaymasks' scuba mask)
  const r = ((s & 255) * 0.66 + (d & 255) * 0.34) | 0;
  const g = (((s >>> 8) & 255) * 0.66 + ((d >>> 8) & 255) * 0.34) | 0;
  const b = (((s >>> 16) & 255) * 0.66 + ((d >>> 16) & 255) * 0.34) | 0;
  return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
};

/**
 * src at (x, y) into dst (dw x dh), clipped to the rows 0..clipH-1.
 * `scale` (rotatesprite's zoom) samples nearest; `alpha` 0.66 blends.
 */
export function blit(dst, dw, dh, src, x, y, { scale = 1, translucent = false, clipH = dh } = {}) {
  if (!src) return;
  const sw = src.w, sh = src.h, sp = src.px;
  if (scale === 1) {
    const x0 = Math.round(x), y0 = Math.round(y);
    const ya = Math.max(0, y0), yb = Math.min(clipH, y0 + sh);
    const xa = Math.max(0, x0), xb = Math.min(dw, x0 + sw);
    for (let yy = ya; yy < yb; yy++) {
      const so = (yy - y0) * sw - x0, dofs = yy * dw;
      for (let xx = xa; xx < xb; xx++) {
        const v = sp[so + xx];
        if (v >>> 24) dst[dofs + xx] = translucent ? blend66(v, dst[dofs + xx]) : v;
      }
    }
    return;
  }
  const W = sw * scale, H = sh * scale;
  const ya = Math.max(0, Math.ceil(y - 0.5)), yb = Math.min(clipH, Math.ceil(y + H - 0.5));
  const xa = Math.max(0, Math.ceil(x - 0.5)), xb = Math.min(dw, Math.ceil(x + W - 0.5));
  for (let yy = ya; yy < yb; yy++) {
    const sy = Math.min(sh - 1, Math.floor((yy + 0.5 - y) / scale));
    for (let xx = xa; xx < xb; xx++) {
      const sx = Math.min(sw - 1, Math.floor((xx + 0.5 - x) / scale));
      const v = sp[sy * sw + sx];
      if (v >>> 24) dst[yy * dw + xx] = translucent ? blend66(v, dst[yy * dw + xx]) : v;
    }
  }
}

/**
 * A tile placed as dorotatesprite places it with a quarter turn and dastat 4
 * (the camcorder corners): `at` from weaponview's rotatedPlacement — the
 * anchor (x, y), the angle (0 or a quarter, in radians), the tile's corner
 * offset (left, top) and the upside-down flag. Each source pixel is moved
 * forward; a quarter turn leaves no holes.
 */
export function blitPlaced(dst, dw, dh, src, at, clipH = dh) {
  if (!src) return;
  const c = Math.round(Math.cos(at.rot)), s = Math.round(Math.sin(at.rot));
  const sw = src.w, sh = src.h, sp = src.px;
  for (let v = 0; v < sh; v++) {
    const r = at.yflip ? sh - 1 - v : v;
    for (let u = 0; u < sw; u++) {
      const p = sp[v * sw + u];
      if (!(p >>> 24)) continue;
      const lx = u + at.left, ly = r + at.top;
      const X = Math.round(at.x + lx * c - ly * s), Y = Math.round(at.y + lx * s + ly * c);
      if (X >= 0 && X < dw && Y >= 0 && Y < clipH) dst[Y * dw + X] = p;
    }
  }
}

/**
 * The tilted view (rotatesprite of the tilt tile, game.c displayrooms):
 * the larger src (sw x sh) turned by `ang` (Build units, clockwise on the
 * screen) about its centre onto the window's centre, rows 0..wh-1 of dst.
 * Inverse mapping, nearest pixel.
 */
export function rotateInto(dst, dw, wh, src, sw, sh, ang) {
  const t = ang * Math.PI / 1024, c = Math.cos(t), s = Math.sin(t);
  const cx = dw / 2, cy = wh / 2, scx = sw / 2, scy = sh / 2;
  for (let y = 0; y < wh; y++) {
    const dy = y + 0.5 - cy;
    // source = R(-t) . (dx, dy) + centre
    let sxf = scx + (0.5 - cx) * c + dy * s, syf = scy - (0.5 - cx) * s + dy * c;
    const o = y * dw;
    for (let x = 0; x < dw; x++, sxf += c, syf -= s) {
      const sx = Math.floor(sxf), sy = Math.floor(syf);
      dst[o + x] = (sx >= 0 && sx < sw && sy >= 0 && sy < sh) ? src[sy * sw + sx] : 0xff000000;
    }
  }
}
