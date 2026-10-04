// Cache tripwire: every module carries the stage it shipped with, and boot.js
// refuses to run a mix. A browser that re-fetched one file and kept another
// from its cache showed up as 'HEALTH undefined' — a field the stale
// player.js did not have. That is the third stale-cache report; this makes
// the fourth say which file.
export const MODULE_STAGE = 'stage12.194';

// uDuke - PALETTE.DAT / LOOKUP.DAT decoding.
// See FORMATS.md section 2.

const TRANSLUC_SIZE = 65536;

/**
 * Parse PALETTE.DAT.
 * @param {Uint8Array} bytes
 * @returns {{rgb: Uint8Array, numShades: number, shades: Uint8Array, transluc: Uint8Array|null}}
 *   rgb      - 768 bytes, expanded from 6-bit VGA to full 8-bit range
 *   shades   - numShades * 256 bytes, shade table s at offset s * 256
 *   transluc - 256*256 blend table, or null if the file is truncated
 */
export function parsePalette(bytes) {
  if (bytes.length < 770) throw new Error('PALETTE.DAT: too short');

  // 6-bit VGA -> 8-bit. Scale, do not shift: v << 2 caps white at 252.
  const rgb = new Uint8Array(768);
  for (let i = 0; i < 768; i++) {
    rgb[i] = Math.round((bytes[i] & 63) * 255 / 63);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const numShades = view.getInt16(768, true);
  if (numShades < 1 || numShades > 256) {
    throw new Error(`PALETTE.DAT: implausible shade count ${numShades}`);
  }

  const shadeEnd = 770 + numShades * 256;
  if (shadeEnd > bytes.length) throw new Error('PALETTE.DAT: shade tables truncated');
  const shades = bytes.slice(770, shadeEnd);

  const transluc = bytes.length >= shadeEnd + TRANSLUC_SIZE
    ? bytes.slice(shadeEnd, shadeEnd + TRANSLUC_SIZE)
    : null;

  // The raw 6-bit values as well: the brightness ramp in TABLES.DAT is indexed
  // by them, so expanding to 8 bits first and inverting later would lose the
  // low bits and land on the wrong table entry.
  const raw6 = new Uint8Array(768);
  for (let i = 0; i < 768; i++) raw6[i] = bytes[i] & 63;

  return { rgb, raw6, numShades, shades, transluc };
}

/**
 * Parse LOOKUP.DAT — the alternate palettes selected by the `pal` field on
 * walls, sectors and sprites.
 * @param {Uint8Array} bytes
 * @returns {{lookups: Map<number, Uint8Array>, basePalettes: Uint8Array[]}}
 */
export function parseLookup(bytes) {
  if (bytes.length < 1) throw new Error('LOOKUP.DAT: empty');
  const numLookups = bytes[0];
  const lookups = new Map();

  let off = 1;
  for (let i = 0; i < numLookups; i++) {
    if (off + 257 > bytes.length) throw new Error('LOOKUP.DAT: lookup table truncated');
    lookups.set(bytes[off], bytes.slice(off + 1, off + 257));
    off += 257;
  }

  // Trailing full-screen tints. Derive the count from what is actually there
  // rather than assuming five — this part of the format is poorly documented.
  const basePalettes = [];
  while (off + 768 <= bytes.length) {
    const pal = new Uint8Array(768);
    for (let i = 0; i < 768; i++) pal[i] = Math.round((bytes[off + i] & 63) * 255 / 63);
    basePalettes.push(pal);
    off += 768;
  }

  return { lookups, basePalettes };
}

/**
 * Build a 256-entry lookup of packed pixels for direct writes into an
 * ImageData Uint32Array view. Index 255 is transparent in every Build tile.
 *
 * @param {Uint8Array} rgb        768-byte expanded palette
 * @param {Uint8Array} [shades]   optional numShades*256 shade tables
 * @param {number} [shade=0]      shade level to bake in
 * @returns {Uint32Array}
 */
export function buildLut(rgb, shades, shade = 0) {
  const lut = new Uint32Array(256);
  const le = isLittleEndian();

  for (let i = 0; i < 256; i++) {
    if (i === 255) { lut[i] = 0; continue; }
    const c = shades ? shades[shade * 256 + i] : i;
    const r = rgb[c * 3], g = rgb[c * 3 + 1], b = rgb[c * 3 + 2];
    lut[i] = le
      ? (255 << 24) | (b << 16) | (g << 8) | r
      : (r << 24) | (g << 16) | (b << 8) | 255;
  }
  return lut;
}

/**
 * Precompute packed pixels for every (shade, colour) pair, so the renderer can
 * look up a shaded colour with one indexed read instead of a palette walk.
 *
 * @returns {Uint32Array} numShades * 256 entries, indexed shade * 256 + colour
 */
export function buildShadeLuts(rgb, shades, numShades) {
  const luts = new Uint32Array(numShades * 256);
  for (let s = 0; s < numShades; s++) {
    luts.set(buildLut(rgb, shades, s), s * 256);
  }
  return luts;
}

/**
 * Nearest palette index to an RGB triple, by squared distance.
 * Index 255 is excluded because it is reserved for transparency.
 */
export function nearestIndex(rgb, r, g, b) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < 255; i++) {
    const dr = rgb[i * 3] - r, dg = rgb[i * 3 + 1] - g, db = rgb[i * 3 + 2] - b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

let _le = null;
function isLittleEndian() {
  if (_le === null) {
    const probe = new Uint32Array([1]);
    _le = new Uint8Array(probe.buffer)[0] === 1;
  }
  return _le;
}

/**
 * Build the shade tables for one alternate palette.
 *
 * Duke's genspriteremaps (premap.c 1286) reads LOOKUP.DAT and calls
 * `makepalookup(pal, remap, 0,0,0, 1)` for every entry — always with r,g,b of
 * zero, so only the untinted branch of makepalookup is ever reached:
 *
 *     palookup[pal][j*256 + i] = palookup[0][j*256 + remap[i]]
 *
 * A remap of colour indices, applied inside the base shade table. No colour
 * arithmetic, no nearest-colour search: the tinted branch exists in engine.c
 * and Duke never uses it, so it is not reproduced here either.
 *
 * The five 768-byte blocks after the remaps are waterpal, slimepal, titlepal,
 * drealms and endingpal — whole-screen tints for being underwater or in a
 * menu, not per-surface palettes, and a different feature.
 */
export function buildPalShadeLuts(rgb, shades, numShades, remap) {
  const luts = new Uint32Array(numShades * 256);
  const le = isLittleEndian();
  for (let s = 0; s < numShades; s++) {
    for (let i = 0; i < 256; i++) {
      if (i === 255) { luts[s * 256 + i] = 0; continue; }
      const c = shades[s * 256 + remap[i]];
      const r = rgb[c * 3], g = rgb[c * 3 + 1], b = rgb[c * 3 + 2];
      luts[s * 256 + i] = le
        ? (255 << 24) | (b << 16) | (g << 8) | r
        : (r << 24) | (g << 16) | (b << 8) | 255;
    }
  }
  return luts;
}

/**
 * TABLES.DAT, for the one thing in it uDuke needs: `britable`.
 *
 * engine.c 3505 reads the file in a fixed order — 2048 sintable entries, 640
 * radarang, 1024 bytes of textfont, 1024 of smalltextfont, then
 * `britable[16][64]`. Everything before it is computed here rather than read
 * (the sine table is generated, the fonts are not used), so only the offset
 * matters, and the offset is the sum of what comes first: 8448 bytes total and
 * the ramp in the last 1024.
 *
 * The ramp is Duke's brightness slider: 16 levels, each a 6-bit to 6-bit
 * mapping applied to the WHOLE palette by `setbrightness(ud.brightness>>2,
 * &palette[0])`. Level 0 is the identity. It is not a shading term and not a
 * per-surface thing — the hardware palette itself changes.
 */
export const BRITABLE_OFFSET = 2048 * 2 + 640 * 2 + 1024 + 1024;
export const BRIGHTNESS_LEVELS = 16;

export function parseTables(bytes) {
  if (bytes.length < BRITABLE_OFFSET + 1024) {
    throw new Error(`TABLES.DAT: too short (${bytes.length}, need ${BRITABLE_OFFSET + 1024})`);
  }
  // radarang: 640 int16 after the 2048-entry sine table. engine.c's getangle()
  // is a lookup into it, and reproducing the lookup rather than atan2 is what
  // makes an actor's rotation frame come out as Duke's and not as a rounding
  // away from it.
  const radarang = new Int16Array(640);
  const view = new DataView(bytes.buffer, bytes.byteOffset + 2048 * 2, 640 * 2);
  for (let i = 0; i < 640; i++) radarang[i] = view.getInt16(i * 2, true);
  return { britable: bytes.slice(BRITABLE_OFFSET, BRITABLE_OFFSET + 1024), radarang };
}

/**
 * Apply a brightness level to a raw 6-bit palette, giving 8-bit RGB.
 *
 * Without this uDuke draws at level 0 and every colour comparison against a
 * running Duke is off by however far its slider has been moved — which is
 * exactly how "uDuke looks a bit dark" turned out to be a missing setting
 * rather than a shading fault. A stripe yellow read (247,227,33) on screen and
 * (243,219,20) here; back in 6 bits that is (61,56,8) against (60,54,5), and
 * the ramp turns the second into the first at level 2.
 */
export function applyBrightness(raw6, britable, level = 0) {
  const rgb = new Uint8Array(768);
  const b = Math.max(0, Math.min(BRIGHTNESS_LEVELS - 1, level | 0));
  for (let i = 0; i < 768; i++) {
    const v = britable ? britable[b * 64 + (raw6[i] & 63)] : raw6[i];
    rgb[i] = Math.round((v & 63) * 255 / 63);
  }
  return rgb;
}
