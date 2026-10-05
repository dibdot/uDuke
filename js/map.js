// Cache tripwire: every module carries the stage it shipped with, and boot.js
// refuses to run a mix. A browser that re-fetched one file and kept another
// from its cache showed up as 'HEALTH undefined' — a field the stale
// player.js did not have. That is the third stale-cache report; this makes
// the fourth say which file.
export const MODULE_STAGE = 'stage12.196';

// uDuke - Build MAP version 7 parsing.
// See FORMATS.md section 4.

export const SECTOR_SIZE = 40;
export const WALL_SIZE = 32;
export const SPRITE_SIZE = 44;

export const SECTOR_STAT = {
  PARALLAX: 0x0001,
  SLOPED: 0x0002,
  SWAP_XY: 0x0004,
  SMOOSH: 0x0008,
  XFLIP: 0x0010,
  YFLIP: 0x0020,
  ALIGN_FIRST_WALL: 0x0040,
  MASKED: 0x0100,
};

export const WALL_STAT = {
  BLOCKING: 0x0001,
  BOTTOM_SWAP: 0x0002,
  BOTTOM_ALIGN: 0x0004,
  XFLIP: 0x0008,
  MASKED: 0x0010,
  ONE_WAY: 0x0020,
  HITSCAN: 0x0040,
  TRANSLUCENT: 0x0080,
  YFLIP: 0x0100,
  TRANSLUCENT_REV: 0x0200,
};

export const SPRITE_ALIGN = { FACE: 0, WALL: 1, FLOOR: 2 };

/**
 * Parse a Build v7 map.
 * @param {Uint8Array} bytes
 */
export function readMap(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 22) throw new Error('MAP: file too short');

  const version = view.getInt32(0, true);
  if (version !== 7) throw new Error(`MAP: unsupported version ${version} (expected 7)`);

  const start = {
    x: view.getInt32(4, true),
    y: view.getInt32(8, true),
    z: view.getInt32(12, true),
    ang: view.getInt16(16, true),
    sectNum: view.getInt16(18, true),
  };

  let off = 20;
  const numSectors = view.getInt16(off, true); off += 2;
  const sectors = new Array(numSectors);
  for (let i = 0; i < numSectors; i++) {
    sectors[i] = readSector(view, off);
    off += SECTOR_SIZE;
  }

  const numWalls = view.getInt16(off, true); off += 2;
  const walls = new Array(numWalls);
  for (let i = 0; i < numWalls; i++) {
    walls[i] = readWall(view, off);
    off += WALL_SIZE;
  }

  const numSprites = view.getInt16(off, true); off += 2;
  const sprites = new Array(numSprites);
  for (let i = 0; i < numSprites; i++) {
    sprites[i] = readSprite(view, off);
    off += SPRITE_SIZE;
  }

  if (off > bytes.length) throw new Error('MAP: truncated');

  return { version, start, sectors, walls, sprites, trailing: bytes.length - off };
}

function readSector(view, o) {
  return {
    wallPtr: view.getInt16(o + 0, true),
    wallNum: view.getInt16(o + 2, true),
    ceilingZ: view.getInt32(o + 4, true),
    floorZ: view.getInt32(o + 8, true),
    ceilingStat: view.getInt16(o + 12, true),
    floorStat: view.getInt16(o + 14, true),
    ceilingPicNum: view.getInt16(o + 16, true),
    ceilingHeinum: view.getInt16(o + 18, true),
    ceilingShade: view.getInt8(o + 20),
    ceilingPal: view.getUint8(o + 21),
    ceilingXPanning: view.getUint8(o + 22),
    ceilingYPanning: view.getUint8(o + 23),
    floorPicNum: view.getInt16(o + 24, true),
    floorHeinum: view.getInt16(o + 26, true),
    floorShade: view.getInt8(o + 28),
    floorPal: view.getUint8(o + 29),
    floorXPanning: view.getUint8(o + 30),
    floorYPanning: view.getUint8(o + 31),
    visibility: view.getUint8(o + 32),
    lotag: view.getInt16(o + 34, true),
    hitag: view.getInt16(o + 36, true),
    extra: view.getInt16(o + 38, true),
  };
}

function readWall(view, o) {
  return {
    x: view.getInt32(o + 0, true),
    y: view.getInt32(o + 4, true),
    point2: view.getInt16(o + 8, true),
    nextWall: view.getInt16(o + 10, true),
    nextSector: view.getInt16(o + 12, true),
    cstat: view.getInt16(o + 14, true),
    picNum: view.getInt16(o + 16, true),
    overPicNum: view.getInt16(o + 18, true),
    shade: view.getInt8(o + 20),
    pal: view.getUint8(o + 21),
    xRepeat: view.getUint8(o + 22),
    yRepeat: view.getUint8(o + 23),
    xPanning: view.getUint8(o + 24),
    yPanning: view.getUint8(o + 25),
    lotag: view.getInt16(o + 26, true),
    hitag: view.getInt16(o + 28, true),
    extra: view.getInt16(o + 30, true),
  };
}

function readSprite(view, o) {
  const cstat = view.getInt16(o + 12, true);
  return {
    x: view.getInt32(o + 0, true),
    y: view.getInt32(o + 4, true),
    z: view.getInt32(o + 8, true),
    cstat,
    align: (cstat >> 4) & 0x03,
    picNum: view.getInt16(o + 14, true),
    shade: view.getInt8(o + 16),
    pal: view.getUint8(o + 17),
    clipDist: view.getUint8(o + 18),
    xRepeat: view.getUint8(o + 20),
    yRepeat: view.getUint8(o + 21),
    xOffset: view.getInt8(o + 22),
    yOffset: view.getInt8(o + 23),
    sectNum: view.getInt16(o + 24, true),
    statNum: view.getInt16(o + 26, true),
    ang: view.getInt16(o + 28, true),
    owner: view.getInt16(o + 30, true),
    xVel: view.getInt16(o + 32, true),
    yVel: view.getInt16(o + 34, true),
    zVel: view.getInt16(o + 36, true),
    lotag: view.getInt16(o + 38, true),
    hitag: view.getInt16(o + 40, true),
    extra: view.getInt16(o + 42, true),
  };
}

/**
 * Structural check. This is the empirical answer to the nextWall/nextSector
 * field-order question in FORMATS.md: on a genuine map, portal links are
 * reciprocal. If the two fields were swapped, `reciprocity` failures would be
 * in the thousands rather than zero.
 *
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateMap(map) {
  const errors = [];
  const { sectors, walls, sprites } = map;

  let wallsCovered = 0;
  sectors.forEach((s, i) => {
    if (s.wallPtr < 0 || s.wallNum < 1 || s.wallPtr + s.wallNum > walls.length) {
      errors.push(`sector ${i}: wall range ${s.wallPtr}+${s.wallNum} out of bounds`);
    } else {
      wallsCovered += s.wallNum;
    }
    if (s.ceilingZ > s.floorZ) {
      errors.push(`sector ${i}: ceiling below floor (${s.ceilingZ} > ${s.floorZ})`);
    }
  });
  if (wallsCovered !== walls.length) {
    errors.push(`sector wall ranges cover ${wallsCovered} of ${walls.length} walls`);
  }

  walls.forEach((w, i) => {
    if (w.point2 < 0 || w.point2 >= walls.length) {
      errors.push(`wall ${i}: point2 ${w.point2} out of bounds`);
    }
    if (w.nextSector < -1 || w.nextSector >= sectors.length) {
      errors.push(`wall ${i}: nextSector ${w.nextSector} out of bounds`);
    }
    if (w.nextWall < -1 || w.nextWall >= walls.length) {
      errors.push(`wall ${i}: nextWall ${w.nextWall} out of bounds`);
    }
    // Reciprocity: the neighbour must point back at us.
    if (w.nextWall >= 0 && w.nextWall < walls.length) {
      if (walls[w.nextWall].nextWall !== i) {
        errors.push(`wall ${i}: nextWall ${w.nextWall} does not link back`);
      }
    }
    // A portal has both fields set, a solid wall has neither.
    if ((w.nextWall >= 0) !== (w.nextSector >= 0)) {
      errors.push(`wall ${i}: half-linked portal (nextWall=${w.nextWall}, nextSector=${w.nextSector})`);
    }
  });

  sprites.forEach((s, i) => {
    if (s.sectNum < 0 || s.sectNum >= sectors.length) {
      errors.push(`sprite ${i}: sectNum ${s.sectNum} out of bounds`);
    }
  });

  return { ok: errors.length === 0, errors };
}

/**
 * Split a sector's walls into closed loops. The first loop is the outer
 * boundary; the rest are holes.
 * @returns {number[][]} arrays of wall indices
 */
export function sectorLoops(map, sectorIndex) {
  const s = map.sectors[sectorIndex];
  const loops = [];
  let loopStart = s.wallPtr;

  for (let i = s.wallPtr; i < s.wallPtr + s.wallNum; i++) {
    if (map.walls[i].point2 <= loopStart) {
      const loop = [];
      for (let j = loopStart; j <= i; j++) loop.push(j);
      loops.push(loop);
      loopStart = i + 1;
    }
  }
  return loops;
}

/**
 * Floor and ceiling height at a point, honouring slopes.
 * Returns z units — divide by 16 for Build units.
 */
export function getZsOfSlope(map, sectorIndex, px, py) {
  const s = map.sectors[sectorIndex];
  let ceilZ = s.ceilingZ;
  let floorZ = s.floorZ;

  const sloped = (s.ceilingStat & SECTOR_STAT.SLOPED) || (s.floorStat & SECTOR_STAT.SLOPED);
  if (!sloped) return { ceilZ, floorZ };

  const w1 = map.walls[s.wallPtr];
  const w2 = map.walls[w1.point2];
  const dx = w2.x - w1.x;
  const dy = w2.y - w1.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return { ceilZ, floorZ };

  // Signed perpendicular distance from the sector's first wall.
  const d = (dx * (py - w1.y) - dy * (px - w1.x)) / len;

  if (s.ceilingStat & SECTOR_STAT.SLOPED) ceilZ += Math.round(s.ceilingHeinum * d / 256);
  if (s.floorStat & SECTOR_STAT.SLOPED) floorZ += Math.round(s.floorHeinum * d / 256);

  return { ceilZ, floorZ };
}

/** Axis-aligned bounds over all walls, for fitting a 2D view. */
export function mapBounds(map) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const w of map.walls) {
    if (w.x < minX) minX = w.x;
    if (w.y < minY) minY = w.y;
    if (w.x > maxX) maxX = w.x;
    if (w.y > maxY) maxY = w.y;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}
