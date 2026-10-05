// Cache tripwire: every module carries the stage it shipped with, and boot.js
// refuses to run a mix. A browser that re-fetched one file and kept another
// from its cache showed up as 'HEALTH undefined' — a field the stale
// player.js did not have. That is the third stale-cache report; this makes
// the fourth say which file.
export const MODULE_STAGE = 'stage12.196';

// uDuke - collision, from Build's engine.c.
//
// Everything here is INTEGER arithmetic, because Build's is. That is not
// pedantry: `keepaway()` walks a point one unit at a time until it is on the
// correct side of a line, `raytrace()` decrements an exact numerator until an
// intersection lands inside a segment, and both are statements about a lattice.
// Written in floats they either loop forever or stop half a unit short, and the
// half-unit is what decides whether a player slides along a wall or sticks to
// it. World coordinates are integers in the MAP file to begin with.
//
// JavaScript numbers make one thing better than the original rather than worse:
// every product here stays well inside 2^53, where Build is working in 32 bits
// and a long wall against a distant point can overflow. Nothing is done to
// reproduce that.
//
// The shape of the algorithm is worth stating because it is not the obvious
// one. Build does NOT test a circle against each wall. It inflates every
// blocking wall into a set of directed line segments offset by `walldist` — a
// Minkowski sum, built only on the sides the motion could reach — and then
// treats the player as a POINT traced against those lines. One-sidedness falls
// out for free, and so does sliding along a corner.

import { inside } from './geometry.js';
import { getZsOfSlope } from './map.js';

/** Build's own, engine.c: the largest clipdist a sprite may claim. */
export const MAXCLIPDIST = 1024;

/**
 * cliptype for anything that walks. Build: `CLIPMASK0 = ((1<<16)+1)`, so the
 * wall mask is cstat bit 0 (blocking) and the sprite mask is the same bit.
 * The high half is the sprite mask, the low half the wall mask.
 */
export const CLIPMASK0 = (1 << 16) + 1;
/** `CLIPMASK1 = ((256<<16)+64)` — what hitscan and bullets use. */
export const CLIPMASK1 = (256 << 16) + 64;

/** How many times clipmove re-traces after sliding. Build's default is 3. */
export const CLIP_BOX_TRACE_NUM = 3;

// Build's fixed-point helpers. C's >> on a negative value is an arithmetic
// shift, which is a floor and not a truncation — `Math.floor` and not `| 0`.
const mulscale = (a, b, n) => Math.floor((a * b) / 2 ** n);
const dmulscale = (a, b, c, d, n) => Math.floor((a * b + c * d) / 2 ** n);
const divscale = (a, b, n) => Math.trunc((a * 2 ** n) / b);
/** scale(a,b,c) = a*b/c, truncated toward zero as C's integer divide is. */
const scale = (a, b, c) => Math.trunc((a * b) / c);
const sgn = (a) => (a > 0 ? 1 : a < 0 ? -1 : 0);
/** nsqrtasm: an integer square root, so floor. */
const isqrt = (a) => Math.floor(Math.sqrt(a));

/**
 * Where a ray from (x1,y1) along (vx,vy) meets the segment (x3,y3)-(x4,y4).
 *
 * Build's rintersect(), reduced to two dimensions since z is unused here.
 * Returns null when they do not meet, matching the original's 0 return, and
 * the caller then falls back to the start point.
 */
function rintersect(x1, y1, vx, vy, x3, y3, x4, y4) {
  const x34 = x3 - x4, y34 = y3 - y4;
  const bot = vx * y34 - vy * x34;
  if (bot === 0) return null;
  let topt, topu;
  // engine.c 6200: "p1 towards p2 is a RAY" — t is bounded below (topt
  // against 0) and NOT above: a wall beyond the goal still meets the ray.
  // A first version also rejected topt >= bot, a segment test, and a
  // short step toward a sloped sector's portal never met the wall: the
  // step was then judged under the player, where the slope extrapolates
  // upward, and a shrunk Duke stood blocked at the mouth of a descending
  // ramp (E1L4's crawlway into 492).
  if (bot >= 0) {
    const x31 = x3 - x1, y31 = y3 - y1;
    topt = x31 * y34 - y31 * x34;
    if (topt < 0) return null;
    topu = vx * y31 - vy * x31;
    if (topu < 0 || topu >= bot) return null;
  } else {
    const x31 = x3 - x1, y31 = y3 - y1;
    topt = x31 * y34 - y31 * x34;
    if (topt > 0) return null;
    topu = vx * y31 - vy * x31;
    if (topu > 0 || topu <= bot) return null;
  }
  const t = divscale(topt, bot, 16);
  return { x: x1 + mulscale(vx, t, 16), y: y1 + mulscale(vy, t, 16) };
}

/**
 * The set of offset line segments a move is traced against.
 *
 * Kept as a class rather than the module-level `clipit[]`/`clipnum` Build uses,
 * so two calls cannot interfere and a test can inspect what was built. The
 * lines are DIRECTED: raytrace only sees a line from the side its winding
 * faces, which is what makes a wall block from the front and not from behind
 * without a separate test.
 */
export class ClipLines {
  constructor() { this.x1 = []; this.y1 = []; this.x2 = []; this.y2 = []; this.obj = []; }
  get length() { return this.x1.length; }
  add(x1, y1, x2, y2, obj) {
    this.x1.push(x1); this.y1.push(y1); this.x2.push(x2); this.y2.push(y2); this.obj.push(obj);
  }
}

/**
 * Nudge (x,y) until it is strictly on the outer side of clip line `w`.
 *
 * A single unit at a time, alternating axes, starting with whichever axis the
 * line runs less steeply along — Build's `first = (|dx| <= |dy|)`. The result
 * is the nearest lattice point outside the line, and it has to be a lattice
 * walk: landing exactly ON the line leaves the next trace unable to decide
 * which side the point is on, and the player sticks.
 */
export function keepAway(p, lines, w) {
  const x1 = lines.x1[w], y1 = lines.y1[w];
  const dx = lines.x2[w] - x1, dy = lines.y2[w] - y1;
  const ox = sgn(-dy), oy = sgn(dx);
  let first = Math.abs(dx) <= Math.abs(dy);
  // Bounded: Build's loop is unbounded and relies on the geometry. A cap costs
  // nothing and turns a malformed line into a stuck frame rather than a hang.
  for (let guard = 0; guard < 4096; guard++) {
    if (dx * (p.y - y1) > (p.x - x1) * dy) return;
    if (!first) p.x += ox; else p.y += oy;
    first = !first;
  }
}

/**
 * Trace (x3,y3)->(x4,y4) against every clip line, returning the nearest hit.
 *
 * Build's raytrace(). The four early rejects are all sign tests on cross
 * products: the start must be on the outer side, the goal on the inner side,
 * and the segment endpoints must straddle the ray. The `topu--` loop is not a
 * refinement step — it walks the numerator down until the computed point is
 * genuinely inside the segment, because integer division can otherwise place
 * it a unit past the end.
 *
 * `goal` is updated in place to the hit point, as in the original.
 */
export function rayTrace(x3, y3, goal, lines) {
  let hit = -1;
  for (let z = lines.length - 1; z >= 0; z--) {
    const x1 = lines.x1[z], x2 = lines.x2[z];
    const y1 = lines.y1[z], y2 = lines.y2[z];
    const x21 = x2 - x1, y21 = y2 - y1;

    let topu = x21 * (y3 - y1) - (x3 - x1) * y21;
    if (topu <= 0) continue;                                   // behind the line
    if (x21 * (goal.y - y1) > (goal.x - x1) * y21) continue;    // goal not past it
    const x43 = goal.x - x3, y43 = goal.y - y3;
    if (x43 * (y1 - y3) > (x1 - x3) * y43) continue;
    if (x43 * (y2 - y3) <= (x2 - x3) * y43) continue;
    const bot = x43 * y21 - x21 * y43;
    if (bot === 0) continue;

    let nintx = 0, ninty = 0, cnt = 256;
    for (;;) {
      cnt--;
      if (cnt < 0) { goal.x = x3; goal.y = y3; return z; }
      nintx = x3 + scale(x43, topu, bot);
      ninty = y3 + scale(y43, topu, bot);
      topu--;
      if (x21 * (ninty - y1) > (nintx - x1) * y21) break;
    }

    if (Math.abs(x3 - nintx) + Math.abs(y3 - ninty)
        < Math.abs(x3 - goal.x) + Math.abs(y3 - goal.y)) {
      goal.x = nintx; goal.y = ninty;
      hit = z;
    }
  }
  return hit;
}

/**
 * Move (x,y) by (xvect,yvect), sliding along whatever blocks it.
 *
 * Build's clipmove(). `xvect`/`yvect` are 18.14 fixed point — the goal is
 * `x + (xvect>>14)` — because Build's player velocity lives at that scale.
 *
 * `pos` is `{x, y, z, sectNum}` and is updated in place. z is read, never
 * written: clipmove decides what blocks you at your current height, it does not
 * lift or drop you. Returns the object value of whatever was hit last, 0 for a
 * clean move — Build packs a wall as `wallnum+32768` and a sprite as
 * `spritenum+49152`, and the game reads the top bits to tell them apart.
 *
 * `walldist` is the player's radius, `ceildist` and `flordist` the headroom and
 * the step height: a floor that rises by less than flordist is walked over
 * rather than blocked, which is the whole of Build's stair handling.
 */
/** Build's sintable, amplitude 16384. */
const bsin = (a) => Math.round(Math.sin(((a & 2047) * Math.PI) / 1024) * 16384);

/**
 * clipinsideboxline(), engine.c: does the segment (x1,y1)-(x2,y2) come
 * within `walldist` of the box around (x, y)? A quick reject on the box,
 * then the front/back test with the products the engine uses.
 */
export function clipInsideBoxLine(x, y, x1, y1, x2, y2, walldist) {
  const r = walldist << 1;
  x1 += walldist - x; x2 += walldist - x;
  if (x1 < 0 && x2 < 0) return false;
  if (x1 >= r && x2 >= r) return false;
  y1 += walldist - y; y2 += walldist - y;
  if (y1 < 0 && y2 < 0) return false;
  if (y1 >= r && y2 >= r) return false;
  x2 -= x1; y2 -= y1;
  if (x2 * (walldist - y1) >= y2 * (walldist - x1)) {
    x2 *= x2 > 0 ? (0 - y1) : (r - y1);
    y2 *= y2 > 0 ? (r - x1) : (0 - x1);
    return x2 < y2;
  }
  x2 *= x2 > 0 ? (r - y1) : (0 - y1);
  y2 *= y2 > 0 ? (0 - x1) : (r - x1);
  return x2 >= y2;
}

export function clipMove(map, pos, xvect, yvect, walldist, ceildist, flordist,
                         cliptype = CLIPMASK0, opts = {}) {
  if ((xvect | yvect) === 0 || pos.sectNum < 0) return 0;
  const traceNum = opts.traceNum ?? CLIP_BOX_TRACE_NUM;
  let retval = 0;

  const oxvect = xvect, oyvect = yvect;
  let goalx = pos.x + (xvect >> 14);
  let goaly = pos.y + (yvect >> 14);

  const lines = new ClipLines();

  const cx = (pos.x + goalx) >> 1;
  const cy = (pos.y + goaly) >> 1;
  const gx = goalx - pos.x, gy = goaly - pos.y;
  // The whole move plus the radius plus room for a sprite sitting on a sector
  // line — Build's own comment. Everything outside this box is skipped before
  // any real work.
  const rad = isqrt(gx * gx + gy * gy) + MAXCLIPDIST + walldist + 8;
  const xmin = cx - rad, ymin = cy - rad, xmax = cx + rad, ymax = cy + rad;

  const wallClipMask = cliptype & 0xffff;
  const sprClipMask = cliptype >>> 16;

  const sectorList = [pos.sectNum];
  let cnt2 = 0;
  do {
    const dasect = sectorList[cnt2++];
    const sec = map.sectors[dasect];
    const end = sec.wallPtr + sec.wallNum;
    for (let j = sec.wallPtr; j < end; j++) {
      const wal = map.walls[j];
      const wal2 = map.walls[wal.point2];
      if (!wal2) continue;
      if (wal.x < xmin && wal2.x < xmin) continue;
      if (wal.x > xmax && wal2.x > xmax) continue;
      if (wal.y < ymin && wal2.y < ymin) continue;
      if (wal.y > ymax && wal2.y > ymax) continue;

      const x1 = wal.x, y1 = wal.y, x2 = wal2.x, y2 = wal2.y;
      const dx = x2 - x1, dy = y2 - y1;
      if (dx * (pos.y - y1) < (pos.x - x1) * dy) continue;   // facing away

      // A second, tighter reject against the same box, in the wall's own
      // frame: the box corner nearest the wall on each axis.
      const dax = dx > 0 ? dx * (ymin - y1) : dx * (ymax - y1);
      const day = dy > 0 ? dy * (xmax - x1) : dy * (xmin - x1);
      if (dax >= day) continue;

      let clipyou = 0;
      if (wal.nextSector < 0 || (wal.cstat & wallClipMask)) {
        clipyou = 1;
      } else {
        // A portal you cannot fit through blocks like a wall. The step is
        // measured where the move actually crosses the wall, not under the
        // player, so a stair is judged at its own edge.
        const hitp = rintersect(pos.x, pos.y, gx, gy, x1, y1, x2, y2);
        const px = hitp ? hitp.x : pos.x, py = hitp ? hitp.y : pos.y;
        const sec2 = map.sectors[wal.nextSector];
        let daz = getFloorZOfSlope(map, dasect, px, py);
        let daz2 = getFloorZOfSlope(map, wal.nextSector, px, py);
        if (daz2 < daz - (1 << 8) && (sec2.floorStat & 1) === 0
            && pos.z >= daz2 - (flordist - 1)) clipyou = 1;
        if (!clipyou) {
          daz = getCeilZOfSlope(map, dasect, px, py);
          daz2 = getCeilZOfSlope(map, wal.nextSector, px, py);
          if (daz2 > daz + (1 << 8) && (sec2.ceilingStat & 1) === 0
              && pos.z <= daz2 + (ceildist - 1)) clipyou = 1;
        }
      }

      if (clipyou) {
        // The Minkowski box, and only the sides the motion can reach: the sign
        // of each offset follows gx and gy. Five lines — two at each endpoint
        // to round the corners off squarely, and one copy of the wall itself
        // pushed out along its own normal.
        let bsz = gx < 0 ? -walldist : walldist;
        lines.add(x1 - bsz, y1 - bsz, x1 - bsz, y1 + bsz, j + 32768);
        lines.add(x2 - bsz, y2 - bsz, x2 - bsz, y2 + bsz, j + 32768);
        bsz = gy < 0 ? -walldist : walldist;
        lines.add(x1 + bsz, y1 - bsz, x1 - bsz, y1 - bsz, j + 32768);
        lines.add(x2 + bsz, y2 - bsz, x2 - bsz, y2 - bsz, j + 32768);

        const ax = dy > 0 ? -walldist : walldist;
        const ay = dx < 0 ? -walldist : walldist;
        lines.add(x1 + ax, y1 + ay, x2 + ax, y2 + ay, j + 32768);
      } else if (!sectorList.includes(wal.nextSector)) {
        sectorList.push(wal.nextSector);
      }
    }

    // The sprites of the sector with the mask's bit (1 for CLIPMASK0: the
    // blocking ones), engine.c 7010. A face sprite in the box is a square of
    // clipdist<<2 plus walldist, two sides towards the motion; a wall sprite
    // is its rotated segment (from the tile's width, xrepeat, the picanm x
    // offset, the flip) pushed out by walldist on the side facing the mover
    // — the back only when the sprite is not one-sided (cstat 64). Both need
    // the mover's z inside the sprite's height (with ceildist and flordist),
    // the top from the tile's picanm y offset. A floor sprite (cstat 32) is
    // its rectangle at its own z. This is what stops a player at a fan, a
    // barrel, a crate, a platform — anything spawn() gave cstat 1.
    if (sprClipMask && opts.sprites !== false) {
      const art = opts.art;
      for (const j of spritesInSector(map, dasect)) {
        const spr = map.sprites[j];
        if (spr.removed || spr.sectNum !== dasect) continue;
        const cstat = spr.cstat;
        if ((cstat & sprClipMask) === 0) continue;
        const tile = art?.get(spr.picNum);
        const th = tile?.height ?? 0, tw = tile?.width ?? 0;
        const yoff = tile?.anim?.yOffset ?? 0, xoffA = tile?.anim?.xOffset ?? 0;
        const x1 = spr.x, y1 = spr.y;
        switch (cstat & 48) {
          case 0: {
            if (x1 < xmin || x1 > xmax || y1 < ymin || y1 > ymax) break;
            const k = (th * spr.yRepeat) << 2;
            let daz = (cstat & 128) ? spr.z + (k >> 1) : spr.z;
            if (yoff) daz -= (yoff * spr.yRepeat) << 2;
            if (pos.z < daz + ceildist && pos.z > daz - k - flordist) {
              let bsz = (spr.clipDist << 2) + walldist;
              if (gx < 0) bsz = -bsz;
              lines.add(x1 - bsz, y1 - bsz, x1 - bsz, y1 + bsz, j + 49152);
              bsz = (spr.clipDist << 2) + walldist;
              if (gy < 0) bsz = -bsz;
              lines.add(x1 + bsz, y1 - bsz, x1 - bsz, y1 - bsz, j + 49152);
            }
            break;
          }
          case 16: {
            const k = (th * spr.yRepeat) << 2;
            let daz = (cstat & 128) ? spr.z + (k >> 1) : spr.z;
            if (yoff) daz -= (yoff * spr.yRepeat) << 2;
            const daz2 = daz - k - flordist;
            daz += ceildist;
            if (!(pos.z < daz && pos.z > daz2)) break;
            let xoff = xoffA + (spr.xOffset ?? 0);
            if (cstat & 4) xoff = -xoff;
            const l = spr.xRepeat;
            const dax = bsin(spr.ang) * l, day = bsin(spr.ang + 1536) * l;
            const kk = (tw >> 1) + xoff;
            const sx1 = x1 - Math.floor((dax * kk) / 65536), sy1 = y1 - Math.floor((day * kk) / 65536);
            const sx2 = sx1 + Math.floor((dax * tw) / 65536), sy2 = sy1 + Math.floor((day * tw) / 65536);
            if (!clipInsideBoxLine(cx, cy, sx1, sy1, sx2, sy2, rad)) break;
            const ox = Math.floor((bsin(spr.ang + 256 + 512) * walldist) / 16384);
            const oy = Math.floor((bsin(spr.ang + 256) * walldist) / 16384);
            if ((sx1 - pos.x) * (sy2 - pos.y) >= (sx2 - pos.x) * (sy1 - pos.y)) {
              lines.add(sx1 + ox, sy1 + oy, sx2 + oy, sy2 - ox, j + 49152);
            } else {
              if (cstat & 64) break;
              lines.add(sx2 - ox, sy2 - oy, sx1 - oy, sy1 + ox, j + 49152);
            }
            // engine.c 7062, the side blocker: past either end of the
            // segment, a short line across that end — without it the
            // mover slid round the end of a solid wall sprite.
            if ((sx2 - sx1) * (pos.x - sx1) + (sy2 - sy1) * (pos.y - sy1) < 0) {
              lines.add(sx1 - oy, sy1 + ox, sx1 + ox, sy1 + oy, j + 49152);
            } else if ((sx1 - sx2) * (pos.x - sx2) + (sy1 - sy2) * (pos.y - sy2) < 0) {
              lines.add(sx2 + oy, sy2 - ox, sx2 - ox, sy2 - oy, j + 49152);
            }
            break;
          }
          case 32: {
            // engine.c 7072: a FLOOR sprite — a platform, a lid. It blocks
            // only while the mover's z is within ceildist above and
            // flordist below its plane; one-sided (64), only from the side
            // it faces (cstat 8 turns that). Its rotated rectangle (tile
            // size by repeats, picanm and sprite offsets, flips) gives at
            // most two edges facing the mover — of the opposite pairs
            // (0-1 / 2-3, 1-2 / 3-0) the one the mover is outside of —
            // each pushed out by walldist along the diagonal.
            if (!(pos.z < spr.z + ceildist && pos.z > spr.z - flordist)) break;
            if ((cstat & 64) && ((pos.z > spr.z) === ((cstat & 8) === 0))) break;
            let xoff = xoffA + (spr.xOffset ?? 0), yoffF = yoff + (spr.yOffset ?? 0);
            if (cstat & 4) xoff = -xoff;
            if (cstat & 8) yoffF = -yoffF;
            const cosang = bsin(spr.ang + 512), sinang = bsin(spr.ang);
            const ddx = ((tw >> 1) + xoff) * spr.xRepeat, ddy = ((th >> 1) + yoffF) * spr.yRepeat;
            const rx0 = x1 + Math.floor((sinang * ddx + cosang * ddy) / 65536);
            const ry0 = y1 + Math.floor((sinang * ddy - cosang * ddx) / 65536);
            let l = tw * spr.xRepeat;
            const rx1 = rx0 - Math.floor((sinang * l) / 65536), ry1 = ry0 + Math.floor((cosang * l) / 65536);
            l = th * spr.yRepeat;
            let k = -Math.floor((cosang * l) / 65536);
            const rx2 = rx1 + k, rx3 = rx0 + k;
            k = -Math.floor((sinang * l) / 65536);
            const ry2 = ry1 + k, ry3 = ry0 + k;
            const ox = Math.floor((bsin(spr.ang - 256 + 512) * walldist) / 16384);
            const oy = Math.floor((bsin(spr.ang - 256) * walldist) / 16384);
            const px = pos.x, py = pos.y;
            if ((rx0 - px) * (ry1 - py) < (rx1 - px) * (ry0 - py)) {
              if (clipInsideBoxLine(cx, cy, rx1, ry1, rx0, ry0, rad)) lines.add(rx1 - oy, ry1 + ox, rx0 + ox, ry0 + oy, j + 49152);
            } else if ((rx2 - px) * (ry3 - py) < (rx3 - px) * (ry2 - py)) {
              if (clipInsideBoxLine(cx, cy, rx3, ry3, rx2, ry2, rad)) lines.add(rx3 + oy, ry3 - ox, rx2 - ox, ry2 - oy, j + 49152);
            }
            if ((rx1 - px) * (ry2 - py) < (rx2 - px) * (ry1 - py)) {
              if (clipInsideBoxLine(cx, cy, rx2, ry2, rx1, ry1, rad)) lines.add(rx2 - ox, ry2 - oy, rx1 - oy, ry1 + ox, j + 49152);
            } else if ((rx3 - px) * (ry0 - py) < (rx0 - px) * (ry3 - py)) {
              if (clipInsideBoxLine(cx, cy, rx0, ry0, rx3, ry3, rad)) lines.add(rx0 + ox, ry0 + oy, rx3 + oy, ry3 - ox, j + 49152);
            }
            break;
          }
          default:
            break;
        }
      }
    }
  } while (cnt2 < sectorList.length);

  let hitwall = 0;
  let cnt = traceNum;
  const hitwalls = [];
  const goal = { x: goalx, y: goaly };
  do {
    goal.x = goalx; goal.y = goaly;
    hitwall = rayTrace(pos.x, pos.y, goal, lines);
    if (hitwall >= 0) {
      const lx = lines.x2[hitwall] - lines.x1[hitwall];
      const ly = lines.y2[hitwall] - lines.y1[hitwall];
      const len2 = lx * lx + ly * ly;
      if (len2 > 0) {
        // Slide: project what is left of the move onto the line that stopped
        // it. The guard on the shift is Build's overflow check, kept because
        // it changes the result — past it the slide is dropped, not clamped.
        const dot = (goalx - goal.x) * lx + (goaly - goal.y) * ly;
        const i = (Math.abs(dot) >> 11) < len2 ? divscale(dot, len2, 20) : 0;
        goalx = mulscale(lx, i, 20) + goal.x;
        goaly = mulscale(ly, i, 20) + goal.y;
      }

      // Two lines that disagree about the direction of the original move mean
      // a corner the player cannot pass: stop rather than slide into it and
      // squeeze through. Compared against the ORIGINAL vector, not what is
      // left, so an inside corner does not turn the player around.
      const d1 = dmulscale(lx, oxvect, ly, oyvect, 6);
      let wedged = false;
      for (let i = cnt + 1; i <= traceNum; i++) {
        const j = hitwalls[i];
        const d2 = dmulscale(lines.x2[j] - lines.x1[j], oxvect,
          lines.y2[j] - lines.y1[j], oyvect, 6);
        if ((d1 < 0) !== (d2 < 0)) { wedged = true; break; }
      }
      if (wedged) {
        pos.x = goal.x; pos.y = goal.y;
        pos.sectNum = updateSectorFrom(map, pos.x, pos.y, pos.sectNum);
        return retval;
      }

      keepAway(goal, lines, hitwall);
      xvect = (goalx - goal.x) << 14;
      yvect = (goaly - goal.y) << 14;

      if (cnt === traceNum) retval = lines.obj[hitwall];
      hitwalls[cnt] = hitwall;
    }
    cnt--;
    pos.x = goal.x;
    pos.y = goal.y;
  } while ((xvect | yvect) !== 0 && hitwall >= 0 && cnt > 0);

  // Where did we end up? The sectors already collected first, since the answer
  // is nearly always among them.
  for (const j of sectorList) {
    if (inside(map, j, pos.x, pos.y)) { pos.sectNum = j; return retval; }
  }

  // Otherwise the whole map, and z decides between sectors that overlap in
  // plan — Build allows that as long as they sit at different heights.
  pos.sectNum = -1;
  let best = 0x7fffffff;
  for (let j = map.sectors.length - 1; j >= 0; j--) {
    if (!inside(map, j, pos.x, pos.y)) continue;
    const sec = map.sectors[j];
    let d = (sec.ceilingStat & 2 ? getCeilZOfSlope(map, j, pos.x, pos.y) : sec.ceilingZ) - pos.z;
    if (d > 0) {
      if (d < best) { pos.sectNum = j; best = d; }
    } else {
      d = pos.z - (sec.floorStat & 2 ? getFloorZOfSlope(map, j, pos.x, pos.y) : sec.floorZ);
      if (d <= 0) { pos.sectNum = j; return retval; }
      if (d < best) { pos.sectNum = j; best = d; }
    }
  }
  return retval;
}

/**
 * The ceiling and floor heights actually available at a point.
 *
 * Build's getzrange(), sectors only for now — sprite clipping is a separate
 * slice and needs the tile dimensions, which this module deliberately does not
 * know about yet.
 *
 * The point of it over `getZsOfSlope` is that a player has WIDTH: standing next
 * to a step, the floor under your feet is not the floor you are standing on.
 * getzrange takes the highest floor and the lowest ceiling of every sector
 * within `walldist`, which is what stops a player from sinking into a pit their
 * centre is not yet over.
 *
 * Returns `{ceilZ, ceilHit, florZ, florHit}`; the hit values carry Build's
 * `sectnum+16384` tagging so a caller can tell a sector from a sprite later.
 */
/** The art the clip passes read tile sizes from when a caller passes none. */
let clipArt = null;
export function setClipArt(art) { clipArt = art; }

// --- the sprites of a sector (Build's headspritesect lists) -------------------
//
// clipmove and getzrange ask for the sprites of each sector they pass. Build
// keeps a list per sector; here a scan of EVERY sprite per sector cost O(sectors
// x sprites) a call, and with every shard of glass calling both each tic it went
// O(n^2): E2L6's reactor room, ~670 GLASSPIECES among 1300 sprites, spent over a
// second a frame in moveexplosions.
//
// The index: sector -> the indices of the sprites that can clip at all (a
// clip bit set: 1 for CLIPMASK0, 256 for CLIPMASK1 — a shard of glass, a
// spark, a piece of scrap has neither and is never looked at), ascending
// (the scan's order). Built on demand, rebuilt when `map._spriteStamp` moved
// (bumpSprites: once a tic, when a sprite is made, when movesprite changes a
// sector) or the array grew. Readers still test removed, sectNum and the
// mask, so a stale entry is never wrong; a sprite moved into a sector — or
// given a clip bit — by a path that does not bump is missed until the next
// rebuild, at the latest the next tic.
const NO_SPRITES = [];
export function bumpSprites(map) { map._spriteStamp = (map._spriteStamp ?? 0) + 1; }
/** The sprites of `sect` with a clip bit (see above). */
export function spritesInSector(map, sect) {
  const stamp = map._spriteStamp ?? 0;
  let ix = map._sectIdx;
  if (!ix || ix.stamp !== stamp || ix.n !== map.sprites.length) {
    const lists = new Map();
    for (let j = 0; j < map.sprites.length; j++) {
      const sp = map.sprites[j];
      if (sp.removed || (sp.cstat & 257) === 0) continue;
      let l = lists.get(sp.sectNum);
      if (!l) lists.set(sp.sectNum, (l = []));
      l.push(j);
    }
    ix = map._sectIdx = { stamp, n: map.sprites.length, lists };
  }
  return ix.lists.get(sect) ?? NO_SPRITES;
}

export function getZRange(map, x, y, z, sectNum, walldist, cliptype = CLIPMASK0, opts = {}) {
  if (sectNum < 0) {
    return { ceilZ: -0x80000000, ceilHit: -1, florZ: 0x7fffffff, florHit: -1 };
  }
  const i = walldist + MAXCLIPDIST + 1;
  const xmin = x - i, ymin = y - i, xmax = x + i, ymax = y + i;

  const z0 = getZsOfSlope(map, sectNum, x, y);
  let ceilZ = z0.ceilZ, florZ = z0.floorZ;
  let ceilHit = sectNum + 16384, florHit = sectNum + 16384;

  const wallClipMask = cliptype & 0xffff;
  const sprClipMask = cliptype >>> 16;
  const sectorList = [sectNum];
  let cnt = 0;
  do {
    const sec = map.sectors[sectorList[cnt]];
    const end = sec.wallPtr + sec.wallNum;
    for (let j = sec.wallPtr; j < end; j++) {
      const wal = map.walls[j];
      const k = wal.nextSector;
      if (k < 0) continue;
      const wal2 = map.walls[wal.point2];
      if (!wal2) continue;
      const x1 = wal.x, x2 = wal2.x, y1 = wal.y, y2 = wal2.y;
      if (x1 < xmin && x2 < xmin) continue;
      if (x1 > xmax && x2 > xmax) continue;
      if (y1 < ymin && y2 < ymin) continue;
      if (y1 > ymax && y2 > ymax) continue;

      const dx = x2 - x1, dy = y2 - y1;
      if (dx * (y - y1) < (x - x1) * dy) continue;             // facing away
      let dax = dx > 0 ? dx * (ymin - y1) : dx * (ymax - y1);
      let day = dy > 0 ? dy * (xmax - x1) : dy * (xmin - x1);
      if (dax >= day) continue;
      if (wal.cstat & wallClipMask) continue;

      // A neighbour whose floor or ceiling you are already inside is not a
      // room you are standing in — it is the step you are standing ON.
      const nsec = map.sectors[k];
      if ((nsec.ceilingStat & 1) === 0 && z <= nsec.ceilingZ + (3 << 8)) continue;
      if ((nsec.floorStat & 1) === 0 && z >= nsec.floorZ - (3 << 8)) continue;

      if (!sectorList.includes(k)) sectorList.push(k);

      // The neighbour joins the search either way, but only counts toward the
      // heights if it comes within MAXCLIPDIST — the same box again, pulled in.
      if (x1 < xmin + MAXCLIPDIST && x2 < xmin + MAXCLIPDIST) continue;
      if (x1 > xmax - MAXCLIPDIST && x2 > xmax - MAXCLIPDIST) continue;
      if (y1 < ymin + MAXCLIPDIST && y2 < ymin + MAXCLIPDIST) continue;
      if (y1 > ymax - MAXCLIPDIST && y2 > ymax - MAXCLIPDIST) continue;
      dax += dx > 0 ? dx * MAXCLIPDIST : -dx * MAXCLIPDIST;
      day -= dy > 0 ? dy * MAXCLIPDIST : -dy * MAXCLIPDIST;
      if (dax >= day) continue;

      const zk = getZsOfSlope(map, k, x, y);
      if (zk.ceilZ > ceilZ) { ceilZ = zk.ceilZ; ceilHit = k + 16384; }
      if (zk.floorZ < florZ) { florZ = zk.floorZ; florHit = k + 16384; }
    }
    cnt++;
  } while (cnt < sectorList.length);

  // engine.c getzrange, the sprite pass: a sprite with the mask's bit under
  // or over the point is a floor or a ceiling. A face sprite counts within
  // its box (walldist + clipdist<<2 + 1), a wall sprite along its segment,
  // a FLOOR sprite when the point lies in its rotated quad grown by
  // walldist+4 — E1L1's catwalk over the street is two such sprites; a
  // one-sided one carries only from the side it faces. The span is the
  // sprite's z (its bottom) up to its height; a floor sprite is flat.
  const art = opts.art ?? clipArt;
  if (sprClipMask) {
    for (const dasect of sectorList) {
      for (const j of spritesInSector(map, dasect)) {
        const spr = map.sprites[j];
        if (spr.removed || spr.sectNum !== dasect) continue;
        const cstat = spr.cstat;
        if ((cstat & sprClipMask) === 0) continue;
        const tile = art?.get(spr.picNum);
        const th = tile?.height ?? 0, tw = tile?.width ?? 0;
        const yoff0 = tile?.anim?.yOffset ?? 0, xoff0 = tile?.anim?.xOffset ?? 0;
        let x1 = spr.x, y1 = spr.y, daz = 0, daz2 = 0, clipyou = 0;
        switch (cstat & 48) {
          case 0: {
            const k = walldist + (spr.clipDist << 2) + 1;
            if (Math.abs(x1 - x) <= k && Math.abs(y1 - y) <= k) {
              daz = spr.z;
              const kk = (th * spr.yRepeat) << 1;
              if (cstat & 128) daz += kk;
              if (yoff0) daz -= (yoff0 * spr.yRepeat) << 2;
              daz2 = daz - (kk << 1);
              clipyou = 1;
            }
            break;
          }
          case 16: {
            let xoff = xoff0 + (spr.xOffset ?? 0);
            if (cstat & 4) xoff = -xoff;
            const l = spr.xRepeat;
            const dax = bsin(spr.ang) * l, day = bsin(spr.ang + 1536) * l;
            const kk = (tw >> 1) + xoff;
            x1 -= Math.floor((dax * kk) / 65536);
            const x2 = x1 + Math.floor((dax * tw) / 65536);
            y1 -= Math.floor((day * kk) / 65536);
            const y2 = y1 + Math.floor((day * tw) / 65536);
            if (clipInsideBoxLine(x, y, x1, y1, x2, y2, walldist + 1)) {
              daz = spr.z;
              const k2 = (th * spr.yRepeat) << 1;
              if (cstat & 128) daz += k2;
              if (yoff0) daz -= (yoff0 * spr.yRepeat) << 2;
              daz2 = daz - (k2 << 1);
              clipyou = 1;
            }
            break;
          }
          case 32: {
            daz = spr.z; daz2 = daz;
            if ((cstat & 64) && ((z > daz) === ((cstat & 8) === 0))) continue;
            let xoff = xoff0 + (spr.xOffset ?? 0), yoff = yoff0 + (spr.yOffset ?? 0);
            if (cstat & 4) xoff = -xoff;
            if (cstat & 8) yoff = -yoff;
            const cosang = bsin(spr.ang + 512), sinang = bsin(spr.ang);
            const dax = ((tw >> 1) + xoff) * spr.xRepeat, day = ((th >> 1) + yoff) * spr.yRepeat;
            x1 += Math.floor((sinang * dax + cosang * day) / 65536) - x;
            y1 += Math.floor((sinang * day - cosang * dax) / 65536) - y;
            let l = tw * spr.xRepeat;
            let x2 = x1 - Math.floor((sinang * l) / 65536), y2 = y1 + Math.floor((cosang * l) / 65536);
            l = th * spr.yRepeat;
            let k = -Math.floor((cosang * l) / 65536);
            let x3 = x2 + k, x4 = x1 + k;
            k = -Math.floor((sinang * l) / 65536);
            let y3 = y2 + k, y4 = y1 + k;
            const ex = Math.floor((bsin(spr.ang - 256 + 512) * (walldist + 4)) / 16384);
            const ey = Math.floor((bsin(spr.ang - 256) * (walldist + 4)) / 16384);
            x1 += ex; x2 -= ey; x3 -= ex; x4 += ey;
            y1 += ey; y2 += ex; y3 -= ey; y4 -= ex;
            const edge = (xa, ya, xb, yb) => {
              if ((ya ^ yb) < 0) {
                if ((xa ^ xb) < 0) clipyou ^= ((xa * yb < xb * ya) ? 1 : 0) ^ ((ya < yb) ? 1 : 0);
                else if (xa >= 0) clipyou ^= 1;
              }
            };
            edge(x1, y1, x2, y2); edge(x2, y2, x3, y3); edge(x3, y3, x4, y4); edge(x4, y4, x1, y1);
            break;
          }
          default: break;
        }
        if (clipyou) {
          if (z > daz && daz > ceilZ) { ceilZ = daz; ceilHit = j + 49152; }
          if (z < daz2 && daz2 < florZ) { florZ = daz2; florHit = j + 49152; }
        }
      }
    }
  }

  return { ceilZ, ceilHit, florZ, florHit };
}

// --- small wrappers over map.js, kept local so callers read like engine.c ----

/**
 * clipinsidebox(), engine.c 4382: is wall `wallnum` within `walldist` of
 * the box around (x, y)? 0 no, 1 from the front, 2 from the back.
 */
export function clipInsideBox(map, x, y, wallnum, walldist) {
  const r = walldist << 1;
  const wal = map.walls[wallnum], w2 = map.walls[wal.point2];
  let x1 = wal.x + walldist - x, y1 = wal.y + walldist - y;
  let x2 = w2.x + walldist - x, y2 = w2.y + walldist - y;
  if (x1 < 0 && x2 < 0) return 0;
  if (y1 < 0 && y2 < 0) return 0;
  if (x1 >= r && x2 >= r) return 0;
  if (y1 >= r && y2 >= r) return 0;
  x2 -= x1; y2 -= y1;
  if (x2 * (walldist - y1) >= y2 * (walldist - x1)) {
    x2 *= x2 > 0 ? (0 - y1) : (r - y1);
    y2 *= y2 > 0 ? (r - x1) : (0 - x1);
    return x2 < y2 ? 1 : 0;
  }
  x2 *= x2 > 0 ? (r - y1) : (0 - y1);
  y2 *= y2 > 0 ? (0 - x1) : (r - x1);
  return x2 >= y2 ? 2 : 0;
}

/**
 * pushmove(), engine.c 7237: a point that has ended up inside a wall's
 * clip box (walldist-4) is pushed out along the wall's normal, 8 units a
 * step, up to 16 steps per wall and 32 walls in all, alternating the walk
 * direction each round. A wall blocks as in clipmove: no neighbour, the
 * clip bit, or a step you could not take (measured at the nearest point of
 * the wall). Returns 0 when free, -1 when it gave up — which is what Duke
 * reads as "crushed" (player.c 3382, with furthestangle under 512).
 */
export function pushMove(map, pos, walldist, ceildist, flordist, cliptype = CLIPMASK0) {
  if (pos.sectNum < 0) return -1;
  const wallClipMask = cliptype & 0xffff;
  let k = 32, dir = 1, bad;
  do {
    bad = 0;
    const list = [pos.sectNum];
    let cnt = 0;
    do {
      const dasect = list[cnt];
      const sec = map.sectors[dasect];
      if (!sec) break;
      let start, end;
      if (dir > 0) { start = sec.wallPtr; end = start + sec.wallNum; }
      else { end = sec.wallPtr; start = end + sec.wallNum; }
      for (let i = start; i !== end; i += dir) {
        const wi = dir > 0 ? i : i - 1;
        const wal = map.walls[wi];
        if (!wal || clipInsideBox(map, pos.x, pos.y, wi, walldist - 4) !== 1) continue;
        let j = 0;
        if (wal.nextSector < 0) j = 1;
        if (wal.cstat & wallClipMask) j = 1;
        if (j === 0) {
          const sec2 = map.sectors[wal.nextSector];
          const w2 = map.walls[wal.point2];
          let dax = w2.x - wal.x, day = w2.y - wal.y;
          const daz0 = dax * (pos.x - wal.x) + day * (pos.y - wal.y);
          let t;
          if (daz0 <= 0) t = 0;
          else { const daz2 = dax * dax + day * day; t = daz0 >= daz2 ? 1 : daz0 / daz2; }
          dax = wal.x + Math.trunc(dax * t);
          day = wal.y + Math.trunc(day * t);
          let daz = getFloorZOfSlope(map, dasect, dax, day);
          let daz2 = getFloorZOfSlope(map, wal.nextSector, dax, day);
          if (daz2 < daz - (1 << 8) && (sec2.floorStat & 1) === 0 && pos.z >= daz2 - (flordist - 1)) j = 1;
          daz = getCeilZOfSlope(map, dasect, dax, day);
          daz2 = getCeilZOfSlope(map, wal.nextSector, dax, day);
          if (daz2 > daz + (1 << 8) && (sec2.ceilingStat & 1) === 0 && pos.z <= daz2 + (ceildist - 1)) j = 1;
        }
        if (j !== 0) {
          // sintable[(j+1024)&2047]>>11, sintable[(j+512)&2047]>>11 for the
          // wall's angle: eight units along the wall's left normal.
          const w2 = map.walls[wal.point2];
          const vx = w2.x - wal.x, vy = w2.y - wal.y;
          const len = Math.hypot(vx, vy) || 1;
          const dx = Math.trunc((-vy / len) * 8), dy = Math.trunc((vx / len) * 8);
          let bad2 = 16;
          do {
            pos.x += dx; pos.y += dy;
            bad2--;
            if (bad2 === 0) break;
          } while (clipInsideBox(map, pos.x, pos.y, wi, walldist - 4) !== 0);
          bad = -1;
          k--;
          if (k <= 0) return bad;
          pos.sectNum = updateSectorFrom(map, pos.x, pos.y, pos.sectNum);
          if (pos.sectNum < 0) return -1;
        } else if (!list.includes(wal.nextSector)) list.push(wal.nextSector);
      }
      cnt++;
    } while (cnt < list.length);
    dir = -dir;
  } while (bad !== 0);
  return bad;
}

function getFloorZOfSlope(map, sectNum, x, y) {
  return getZsOfSlope(map, sectNum, x, y).floorZ;
}
function getCeilZOfSlope(map, sectNum, x, y) {
  return getZsOfSlope(map, sectNum, x, y).ceilZ;
}

/**
 * updatesector, with the previous sector tried first.
 *
 * geometry.js already has this; it is wrapped rather than duplicated so the
 * -1 convention is in one place.
 */
function updateSectorFrom(map, x, y, from) {
  if (from >= 0 && inside(map, from, x, y)) return from;
  for (let j = 0; j < map.sectors.length; j++) {
    if (inside(map, j, x, y)) return j;
  }
  return -1;
}
