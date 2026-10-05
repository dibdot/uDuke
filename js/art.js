// Cache tripwire: every module carries the stage it shipped with, and boot.js
// refuses to run a mix. A browser that re-fetched one file and kept another
// from its cache showed up as 'HEALTH undefined' — a field the stale
// player.js did not have. That is the third stale-cache report; this makes
// the fourth say which file.
export const MODULE_STAGE = 'stage12.196';

// uDuke - TILESnnn.ART decoding.
// See FORMATS.md section 3.

/**
 * Index one ART file. Pixel data is not copied; tiles are decoded on demand,
 * which matters because Duke3D ships roughly 9000 of them.
 *
 * @param {Uint8Array} bytes
 * @returns {{start:number, end:number, count:number, tiles:Array}}
 */
export function readArt(bytes) {
  if (bytes.length < 16) throw new Error('ART: file too short');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const version = view.getInt32(0, true);
  if (version !== 1) throw new Error(`ART: unsupported version ${version}`);

  // Field at offset 4 is a tile count that the original engine ignores.
  // Trust localTileStart/End instead.
  const start = view.getInt32(8, true);
  const end = view.getInt32(12, true);
  const count = end - start + 1;
  if (count < 0 || count > 0x10000) {
    throw new Error(`ART: implausible tile range ${start}..${end}`);
  }

  const sizeXOff = 16;
  const sizeYOff = sizeXOff + count * 2;
  const picanmOff = sizeYOff + count * 2;
  let dataOff = picanmOff + count * 4;
  if (dataOff > bytes.length) throw new Error('ART: header truncated');

  const tiles = new Array(count);
  for (let i = 0; i < count; i++) {
    const width = view.getInt16(sizeXOff + i * 2, true);
    const height = view.getInt16(sizeYOff + i * 2, true);
    const picanm = view.getInt32(picanmOff + i * 4, true);
    const size = width > 0 && height > 0 ? width * height : 0;

    if (dataOff + size > bytes.length) {
      throw new Error(`ART: pixel data for tile ${start + i} overruns file`);
    }

    tiles[i] = {
      index: start + i,
      width,
      height,
      anim: decodePicanm(picanm),
      // Column-major: pixel (x,y) is at y + x * height.
      pixels: size ? bytes.subarray(dataOff, dataOff + size) : null,
    };
    dataOff += size;
  }

  return { start, end, count, tiles };
}

/** Decode the packed picanm word. */
export function decodePicanm(picanm) {
  const xOffset = (picanm >> 8) & 0xff;
  const yOffset = (picanm >> 16) & 0xff;
  return {
    frames: picanm & 0x3f,
    type: (picanm >> 6) & 0x03, // 0 none, 1 oscillate, 2 forward, 3 backward
    xOffset: xOffset > 127 ? xOffset - 256 : xOffset,
    yOffset: yOffset > 127 ? yOffset - 256 : yOffset,
    speed: (picanm >> 24) & 0x0f,
  };
}

/**
 * Which frame of an animated tile is showing.
 *
 * Build divides the global clock by 2^speed and then walks the frame list
 * according to the type. Oscillating runs up and back down over a period of
 * twice the frame count; forward and backward wrap over frames + 1.
 *
 * @param {object} anim   decoded picanm
 * @param {number} clock  ticks at Build's rate of 120 Hz
 * @returns {number} offset to add to the tile number
 */
export function animOffset(anim, clock) {
  const frames = anim?.frames ?? 0;
  if (!frames || !anim.type) return 0;

  const i = Math.floor(clock) >> anim.speed;
  switch (anim.type) {
    case 1: {                       // oscillating
      const period = frames << 1;
      const k = ((i % period) + period) % period;
      return k < frames ? k : period - k;
    }
    case 2:                         // forward
      return ((i % (frames + 1)) + frames + 1) % (frames + 1);
    case 3:                         // backward
      return -((((i % (frames + 1)) + frames + 1)) % (frames + 1));
    default:
      return 0;
  }
}

/**
 * Combine several ART files into one tile lookup keyed by global tile number.
 * @param {Uint8Array[]} files
 */
export class ArtSet {
  constructor(files) {
    this.tiles = new Map();
    for (const bytes of files) {
      const art = readArt(bytes);
      for (const tile of art.tiles) this.tiles.set(tile.index, tile);
    }
  }

  get(index) {
    return this.tiles.get(index) ?? null;
  }

  /** Tile numbers that actually carry pixels, ascending. */
  populated() {
    return [...this.tiles.values()]
      .filter((t) => t.pixels)
      .map((t) => t.index)
      .sort((a, b) => a - b);
  }
}

/**
 * Transpose a column-major tile into a row-major RGBA buffer.
 * Palette index 255 is transparent.
 *
 * @param {object} tile     entry from readArt/ArtSet
 * @param {Uint32Array} lut from palette.buildLut()
 * @returns {{width:number, height:number, data:Uint8ClampedArray}|null}
 */
export function tileToRgba(tile, lut) {
  if (!tile || !tile.pixels) return null;
  const { width, height, pixels } = tile;

  const data = new Uint8ClampedArray(width * height * 4);
  const out = new Uint32Array(data.buffer);

  for (let x = 0; x < width; x++) {
    const col = x * height;
    for (let y = 0; y < height; y++) {
      const idx = pixels[col + y];
      if (idx === 255) continue; // leave fully transparent
      out[y * width + x] = lut[idx];
    }
  }

  return { width, height, data };
}
