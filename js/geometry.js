// Cache tripwire: every module carries the stage it shipped with, and boot.js
// refuses to run a mix. A browser that re-fetched one file and kept another
// from its cache showed up as 'HEALTH undefined' — a field the stale
// player.js did not have. That is the third stale-cache report; this makes
// the fourth say which file.
export const MODULE_STAGE = 'stage12.194';

// uDuke - sector geometry primitives.
//
// These sit underneath everything in stage 3: the renderer needs to know which
// sector the camera is in, and clipmove will need the same test per step.

/**
 * Does the ray from (x, y) along +x cross this wall segment?
 * Shared by inside() and insideLoop(); small enough for the engine to inline.
 *
 * Vertices use the half-open rule `(y1 > y) !== (y2 > y)`, so a point level
 * with a vertex is counted once rather than zero or twice.
 *
 * Build's original `inside()` does this with an XOR bit trick on 32-bit longs.
 * That is reproduced here as explicit integer arithmetic instead: coordinate
 * differences reach 2^21 and their products 2^42, which is exact in a double
 * but overflows the 32-bit intermediate the bit trick relies on.
 */
function crosses(w, p2, x, y) {
  const y1 = w.y, y2 = p2.y;
  if ((y1 > y) === (y2 > y)) return false; // segment does not span the ray

  // Sign of t decides which side the intersection falls on; comparing it
  // against the segment's y-direction is equivalent to xIntersect > x,
  // without the division.
  //
  // t === 0 means the intersection is exactly at the ray origin, i.e. the
  // point sits on this wall. Excluding it keeps the boundary half-open and
  // is what makes a point on a portal belong to exactly one of the two
  // sectors rather than both or neither.
  const t = (p2.x - w.x) * (y - y1) - (x - w.x) * (y2 - y1);
  return t !== 0 && (t > 0) === (y2 > y1);
}

/**
 * Point-in-sector test.
 *
 * Crossing-number against every wall of the sector, which covers all loops at
 * once — a point inside a hole crosses both the outer boundary and the hole
 * boundary, so parity reports it as outside with no special-casing.
 *
 * @returns {boolean}
 */
export function inside(map, sectorIndex, x, y) {
  const s = map.sectors[sectorIndex];
  if (!s) return false;

  const walls = map.walls;
  const end = s.wallPtr + s.wallNum;
  let crossings = 0;

  for (let i = s.wallPtr; i < end; i++) {
    const w = walls[i];
    const p2 = walls[w.point2];
    if (p2 && crosses(w, p2, x, y)) crossings++;
  }

  return (crossings & 1) === 1;
}

/**
 * Point-in-loop test against a single wall loop.
 *
 * Needed to decide which loop of a sector is the outer boundary and which are
 * holes. Winding is not a dependable signal for that — see loopSignedArea().
 *
 * @param {number[]} loop wall indices from map.sectorLoops()
 */
export function insideLoop(map, loop, x, y) {
  let crossings = 0;
  for (const i of loop) {
    const w = map.walls[i];
    const p2 = map.walls[w.point2];
    if (p2 && crosses(w, p2, x, y)) crossings++;
  }
  return (crossings & 1) === 1;
}

/**
 * Is the point exactly on one of the sector's walls?
 * Exact integer test — no epsilon, because Build coordinates are integers.
 *
 * @returns {number} wall index, or -1
 */
export function onWall(map, sectorIndex, x, y) {
  const s = map.sectors[sectorIndex];
  if (!s) return -1;

  const end = s.wallPtr + s.wallNum;
  for (let i = s.wallPtr; i < end; i++) {
    const w = map.walls[i];
    const p2 = map.walls[w.point2];
    if (!p2) continue;

    const dx = p2.x - w.x, dy = p2.y - w.y;
    if (dx * (y - w.y) - (x - w.x) * dy !== 0) continue; // not collinear

    const dot = (x - w.x) * dx + (y - w.y) * dy;
    if (dot >= 0 && dot <= dx * dx + dy * dy) return i;
  }
  return -1;
}

/**
 * Find the sector containing a point.
 *
 * Ordered cheapest-first, which is what keeps this off the frame budget: the
 * camera almost always stays put or steps into a neighbour, so the linear scan
 * over every sector is the rare case rather than the common one.
 *
 * @param {number} lastSector previous result, or -1 if unknown
 * @returns {number} sector index, or -1 if the point is outside the map
 */
export function updateSector(map, x, y, lastSector) {
  if (lastSector >= 0 && lastSector < map.sectors.length) {
    if (inside(map, lastSector, x, y)) return lastSector;

    const s = map.sectors[lastSector];
    const end = s.wallPtr + s.wallNum;
    for (let i = s.wallPtr; i < end; i++) {
      const n = map.walls[i].nextSector;
      if (n >= 0 && inside(map, n, x, y)) return n;
    }
  }

  for (let i = map.sectors.length - 1; i >= 0; i--) {
    if (inside(map, i, x, y)) return i;
  }
  return -1;
}

/**
 * Split a sector's loops into the outer boundary and its holes, by geometric
 * containment rather than winding.
 *
 * @returns {{outer: number[], holes: number[][], ambiguous: boolean}}
 */
export function classifyLoops(map, loops) {
  if (loops.length < 2) return { outer: loops[0] ?? [], holes: [], ambiguous: false };

  const contains = loops.map((a) =>
    loops.reduce((n, b) => {
      if (a === b) return n;
      const v = map.walls[b[0]];
      return n + (insideLoop(map, a, v.x, v.y) ? 1 : 0);
    }, 0));

  const best = contains.indexOf(Math.max(...contains));
  return {
    outer: loops[best],
    holes: loops.filter((_, i) => i !== best),
    // The outer loop should contain a vertex of every other loop. If it does
    // not, the sector has disjoint loops and needs a closer look.
    ambiguous: contains[best] !== loops.length - 1,
  };
}

/**
 * Signed area of a wall loop, doubled (the shoelace sum without the halving).
 *
 * Useful as a size measure, but do NOT use its sign to tell an outer boundary
 * from a hole. Build's classic renderer draws floors and ceilings as spans
 * discovered by portal traversal and never tessellates a sector, so it never
 * needed loop nesting and never enforced a winding convention. Polymost, the
 * later OpenGL renderer, had to work the nesting out geometrically for exactly
 * that reason. Use insideLoop() to test containment instead.
 *
 * @param {number[]} loop wall indices from map.sectorLoops()
 */
export function loopSignedArea(map, loop) {
  let sum = 0;
  for (const i of loop) {
    const w = map.walls[i];
    const p2 = map.walls[w.point2];
    if (!p2) continue;
    sum += w.x * p2.y - p2.x * w.y;
  }
  return sum;
}

/**
 * Signed distance from a point to the plane of a wall, in Build units.
 *
 * The question a screen shot cannot answer: a sprite that looks as if it sits
 * on a wall may be behind it, and comparing two crosshair depths does not
 * settle it because a wall seen at an angle changes depth across its width.
 * The wall's own plane does settle it.
 *
 * The sign follows the normal (dy, -dx) and is therefore only as meaningful
 * as the loop's winding, which varies. What the caller actually wants to know
 * is two separate things, so both are reported: how far off the plane the
 * point is, and which room it is in — the latter answered by inside() rather
 * than by a sign convention.
 */
export function distanceToWallPlane(map, wallIndex, px, py) {
  const w = map.walls[wallIndex];
  const w2 = w && map.walls[w.point2];
  if (!w || !w2) return null;
  const dx = w2.x - w.x, dy = w2.y - w.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return null;
  const nx = dy / len, ny = -dx / len;
  // Distance along the wall too, so it is clear whether the point is even
  // beside this wall rather than off past its end.
  const t = ((px - w.x) * dx + (py - w.y) * dy) / (len * len);
  return { signed: (px - w.x) * nx + (py - w.y) * ny, along: t, length: len };
}

/** Distance from a point to a wall segment, clamped to its ends. */
function distanceToSegment(px, py, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - a.x) * dx + (py - a.y) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

/**
 * How wide a sprite is in the world, which is not what clipDist says.
 *
 * Build draws a sprite `xrepeat * tilesizx / 4` units wide, so its half-width
 * is `/8`. clipDist is the collision radius and has nothing to do with it: in
 * E1L5 sector 105 the crate carries clipDist 32 and, at xrepeat 88 over a
 * 64-wide tile, is 1408 units across — wider than the whole sector. Measuring
 * the first and believing it was the second is why "clearance 148" still meant
 * a screen full of crate.
 *
 * `tileWidth` is optional because geometry.js has no business owning the art;
 * callers that have it pass a lookup, and without one this falls back to
 * clipDist and says so by being conservative.
 */
function spriteRadius(spr, tileWidth) {
  const w = tileWidth ? tileWidth(spr.picNum) : null;
  if (w) return (spr.xRepeat * w) / 8;
  return spr.clipDist || 0;
}

/**
 * How much open space there is at a point: the distance to the nearest wall of
 * the sector, and to the nearest sprite that is actually in the way.
 *
 * Only sprites with a footprint are considered: an effector, a marker or
 * anything invisible is not something you can stand in.
 */
function clearanceAt(map, sectorIndex, x, y, tileWidth) {
  const s = map.sectors[sectorIndex];
  let best = Infinity;
  for (let i = s.wallPtr; i < s.wallPtr + s.wallNum; i++) {
    const w = map.walls[i], p2 = map.walls[w.point2];
    if (p2) best = Math.min(best, distanceToSegment(x, y, w, p2));
  }
  for (const spr of map.sprites) {
    if (spr.removed || spr.sectNum !== sectorIndex) continue;
    if ((spr.cstat & 0x8000) !== 0) continue;          // invisible
    if (spr.xRepeat === 0 || spr.yRepeat === 0) continue;
    best = Math.min(best, Math.max(0,
      Math.hypot(spr.x - x, spr.y - y) - spriteRadius(spr, tileWidth)));
  }
  return best;
}

/**
 * A point that is actually inside a sector, and as far from everything as the
 * sector allows — for going to it.
 *
 * Two mistakes are folded in here, both paid for. The first is the obvious
 * candidate, the average of the wall vertices: it is outside every L, U and
 * ring, which is 48 of E1L5's 479 sectors, and landing there means standing in
 * the neighbouring room while `cam.sectNum` names this one — the containment
 * error gameprobe checks for.
 *
 * The second is subtler and is why this does not simply return the first point
 * it finds inside. "Inside" includes 11 units from a wall, which is where the
 * average landed in E1L5 sector 104: the eye is technically in the right sector
 * and the screen is a wall. A go-to that arrives somewhere useless is a go-to
 * nobody uses, so the interior is swept and the point with the most room wins.
 *
 * Returns {x, y, clearance} with integer coordinates, or null for a degenerate
 * sector.
 */
export function pointInSector(map, sectorIndex, { tileWidth = null } = {}) {
  const s = map.sectors[sectorIndex];
  if (!s || s.wallNum < 3) return null;
  const end = s.wallPtr + s.wallNum;

  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = s.wallPtr; i < end; i++) {
    const w = map.walls[i];
    if (!w) return null;
    if (w.x < x0) x0 = w.x;
    if (w.x > x1) x1 = w.x;
    if (w.y < y0) y0 = w.y;
    if (w.y > y1) y1 = w.y;
  }

  // Coarse sweep for the best of a grid, then three refinements around it.
  // Not an exact pole of inaccessibility and does not need to be: the question
  // is "somewhere with room", and a few units either way is not the difference
  // between a useful viewpoint and a wall.
  let best = null;
  let step = Math.max(16, Math.round(Math.max(x1 - x0, y1 - y0) / 24));
  let cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, span = Math.max(x1 - x0, y1 - y0);
  for (let pass = 0; pass < 4; pass++) {
    const ax = Math.max(x0, cx - span / 2), bx = Math.min(x1, cx + span / 2);
    const ay = Math.max(y0, cy - span / 2), by = Math.min(y1, cy + span / 2);
    for (let x = Math.round(ax); x <= bx; x += step) {
      for (let y = Math.round(ay); y <= by; y += step) {
        if (!inside(map, sectorIndex, x, y)) continue;
        const c = clearanceAt(map, sectorIndex, x, y, tileWidth);
        if (!best || c > best.clearance) best = { x, y, clearance: c };
      }
    }
    if (!best) {
      // Nothing on this grid landed inside — a sector thinner than the step.
      // Halve and sweep the whole box again rather than around a guess.
      if (step === 1) return null;
      step = step >> 1;
      cx = (x0 + x1) / 2; cy = (y0 + y1) / 2; span = Math.max(x1 - x0, y1 - y0);
      pass--;
      continue;
    }
    cx = best.x; cy = best.y;
    span = step * 4;
    if (step === 1) break;
    step = Math.max(1, step >> 2);
  }
  return best;
}

/**
 * Where to stand and which way to face, for going to a sector.
 *
 * The angle is chosen by looking, not by geometry on the sector's own vertices.
 * The first version faced the farthest vertex, which is the longest line to a
 * CORNER and not the longest thing you can see: it ignores that the view
 * carries on through a portal, and it ignores sprites entirely, so in E1L5
 * sector 105 it pointed happily at a crate.
 *
 * So: march a ray in each of 64 directions, following portals into the next
 * sector the way sight does, stopping at a solid wall or at a sprite that is in
 * the way, and keep the direction that got furthest. Ties go to the earlier
 * angle, which keeps the result stable.
 */
export function viewpointInSector(map, sectorIndex, { tileWidth = null } = {}) {
  const p = pointInSector(map, sectorIndex, { tileWidth });
  if (!p) return null;

  const blockers = map.sprites.filter((spr) => !spr.removed
    && (spr.cstat & 0x8000) === 0 && spr.xRepeat !== 0 && spr.yRepeat !== 0);

  const STEP = 64, LIMIT = 16384;
  const sight = (ang) => {
    const dx = Math.cos(ang / 1024 * Math.PI), dy = Math.sin(ang / 1024 * Math.PI);
    let sect = sectorIndex;
    for (let d = STEP; d <= LIMIT; d += STEP) {
      const x = Math.round(p.x + dx * d), y = Math.round(p.y + dy * d);
      if (!inside(map, sect, x, y)) {
        const next = updateSector(map, x, y, sect);
        if (next < 0) return d - STEP;      // solid wall
        sect = next;                        // through a portal, sight carries on
      }
      for (const spr of blockers) {
        if (spr.sectNum !== sect) continue;
        if (Math.hypot(spr.x - x, spr.y - y) < spriteRadius(spr, tileWidth)) return d - STEP;
      }
    }
    return LIMIT;
  };

  let ang = 0, best = -1;
  for (let a = 0; a < 2048; a += 32) {
    const d = sight(a);
    if (d > best) { best = d; ang = a; }
  }
  return { x: p.x, y: p.y, ang, clearance: p.clearance, sight: best };
}
