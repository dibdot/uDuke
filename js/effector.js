// Cache tripwire: every module carries the stage it shipped with, and boot.js
// refuses to run a mix. A browser that re-fetched one file and kept another
// from its cache showed up as 'HEALTH undefined' — a field the stale
// player.js did not have. That is the third stale-cache report; this makes
// the fourth say which file.
export const MODULE_STAGE = 'stage12.195';

// uDuke - sector effectors.
//
// SE sprites are Duke's scripting language before there was one: a tile-1
// sprite dropped in a sector, its lotag choosing an effect and its hitag
// grouping it with others. E1L5 alone has 157 of them.
//
// The architecture question they raise is per-SPRITE state. Doors kept theirs
// in the map (the top bit of a sector's lotag); an effector needs six integers
// per sprite, which Build keeps in a parallel array indexed by sprite number:
//
//   t = &hittype[i].temp_data[0];
//
// with T1..T6 as the macros. uDuke keeps the same thing in an Effectors object
// passed in explicitly, for the same reason the animation list is: a test has
// to be able to build one, run it, and read it back.
//
// Implemented: 15 (sliding door), 31/32 (drop floor and ceiling), and now 0/1/11
// — the ROTATING ones. Those three were not chosen by frequency; E1L5 has three
// SE 0, two SE 1 and no SE 11 at all. They were chosen because the rotation
// branch of ms() had no exercise: with t[2] pinned at zero every rotatePoint
// call in this file was the identity, and replacing the re-placement with a
// plain nudge failed nothing.
//
// Sources: actors.c for moveeffectors() and ms(), game.c for the SE setup,
// sector.c for operatesectors and ldist, global.c for FindDistance2D,
// engine.c for dragpoint/rotatepoint/lastwall.
//
// One trap worth stating once, because it is the whole reason this file indexes
// `t` and not `T`: duke3d.h defines `T1` as `temp_data[0]`, so the macro names
// are one AHEAD of the slots. sector.c and game.c use the macros, moveeffectors
// indexes the array raw, and both appear in the comments below. `T4` and `t[4]`
// are different integers.

import { LOTAG_MASK, LOTAG_STATE_BIT, TILE, nextSectorNeighborZ } from './sector.js';
import { getZRange, CLIPMASK0, clipInsideBox } from './clip.js';
import { updateSector } from './geometry.js';

// Three of con.js's helpers, restated here rather than imported: con.js
// imports this file, and a cycle for three ten-line functions is a worse
// trade than the copy. Same arithmetic, same tables.
/** gamedef.c rnd(): (krand>>8) >= 255-x. */
function rnd(fx, x) { return (krand(fx) >> 8) >= (255 - x); }
/** getincangle(). */
function incAngle(a, na) {
  a &= 2047; na &= 2047;
  if (Math.abs(a - na) < 1024) return na - a;
  if (na > 1024) na -= 2048;
  if (a > 1024) a -= 2048;
  return (na - 2048) - (a - 2048);
}
/** engine.c getangle() over radarang; without the table (tests) the same angle from atan2. */
function getAngle(radarang, xv, yv) {
  if ((xv | yv) === 0) return 0;
  if (xv === 0) return 512 + ((yv < 0) << 10);
  if (yv === 0) return (xv < 0) << 10;
  if (xv === yv) return 256 + ((xv < 0) << 10);
  if (xv === -yv) return 768 + ((xv > 0) << 10);
  if (!radarang) return Math.round(Math.atan2(yv, xv) / Math.PI * 1024) & 2047;
  const r = (i) => (i < 640 ? radarang[i] : -radarang[1279 - i]);
  const scale = (a, b, c) => Math.trunc((a * b) / c);
  if (Math.abs(xv) > Math.abs(yv)) return ((r(640 + scale(160, yv, xv)) >> 6) + ((xv < 0) << 10)) & 2047;
  return ((r(640 - scale(160, xv, yv)) >> 6) + 512 + ((yv < 0) << 10)) & 2047;
}

/** SE lotags. Only the implemented ones are named; the rest stay numbers. */
export const SE = {
  ROTATE_SECTOR: 0,
  PIVOT: 1,
  SWING_DOOR: 11,
  QUAKE: 2,
  FLICKER: 4,
  /** A light that rides its door: 8 brightens as the ceiling opens, 9 dims. */
  DOOR_LIGHT: 8,
  DOOR_LIGHT_INVERTED: 9,
  SLIDING_DOOR: 15,
  /** Transporters. game.c moves these to statnum 9 and moveeffectors never
   *  sees them again — so neither does this file's mover; see moveTransports. */
  TRANSPORT: 7,
  TRANSPORT_END: 23,
  CONVEYOR: 24,
  /** actors.c writes `case 24: case 34:` — one body, two lotags. */
  CONVEYOR_ALT: 34,
  DROP_FLOOR: 31,
  DROP_CEILING: 32,
  /** The explosion effector: a SEENINE of the same hitag blows the sector open. */
  EXPLOSION: 13,
  /** Random lights: flicker between the sprite's shade and the sector's; a shot light stays dark. */
  RANDOM_LIGHT: 3,
  /** The door closer: after hitag tics with the door open, it is activated shut. */
  DOOR_CLOSER: 10,
  /** A light switch: a switch of the same hitag steps it on (fading up) and off. */
  LIGHT_SWITCH: 12,
  /** The extend-o-bridge: its sector (lotag 27) is dragged out along the sprite's angle and back. */
  STRETCH_BRIDGE: 20,
  /** The piston: the ceiling pumps between the sprite's z and the mapped ceiling, forever. */
  PISTON: 25,
  /** The waves: the floor bobs on a sine of the sector's speed. */
  WAVES: 29,
  /** The two-way train (sector lotag 31): to the other locator and back. */
  TWO_WAY_TRAIN: 30,
  /** The subway (6) and its cars (14): round the LOCATORS of the plain sector next door, forever. */
  SUBWAY: 6,
  SUBWAY_CAR: 14,
  /** The warp elevator (sector lotag 15): the sector rides, and at the end warps to its twin of hitag±1. */
  WARP_ELEVATOR: 17,
  /** Earthquake debris: a scrap now and then while the ground shakes. */
  QUAKE_DEBRIS: 33,
  /** The shooter: fires the sector's extra as a projectile when activated. */
  SHOOTER: 36,
  /** The boss rotator (game.c "Boss Creature"): a sector that roams the LOCATORS, shooting FIRELASER at a near player. */
  BOSS_ROTATOR: 5,
  /** The reactor: a rotating blocker that pumps its ceiling while a REACTOR sprite is in the sector. */
  REACTOR: 16,
  /** The step elevator: an activator moves the floor (or ceiling) by the sector's extra for hitag tics. */
  ELEVATOR_STEP: 18,
  /** The shield ("Battlestar galactia shields"): an explosion in the sector drops the BIGFORCE walls and closes it. */
  SHIELD: 19,
  /** The cascade: sector lotag 28 starts every SE 21 of a hitag; each waits the sector's extra, then moves its plane to the sprite's z. */
  CASCADE: 21,
  /** The teeth door's other half: while the lotag-29 door animates, this sector's ceiling moves by extra*9. */
  TEETH_DOOR: 22,
  /** The escalator: steps forward and up (or down) and snaps back every eight tics, carrying what stands on it. */
  ESCALATOR: 26,
  /** The demo camera: only runs while a demo records or plays (ud.recstat); in play it does nothing. */
  DEMO_CAMERA: 27,
  /** Lightning: flashes the world, shows its NATURALLIGHTNING bolts, thunders, and burns a player under one. */
  LIGHTNING: 28,
  /** The mist: the ceiling sinks to the sprite's z and pulls back, puffing smoke and now and then an explosion. */
  MIST: 35,
  /** Not a map effector: made at run time when a GLASS wall is shot, it plays the shatter frames (sector.c 1645). */
  GLASS_BREAK: 128,
  /** Runs of small explosions in the sector: 80 tics (130) or 40 (131). */
  EXPLOSIONS_LONG: 130,
  EXPLOSIONS_SHORT: 131,
};
/** The sector lotag of a two-way train. */
export const TWO_WAY_TRAIN_SECTOR_LOTAG = 31;
/** The sector lotag of a warp elevator (SE 17). */
export const WARP_ELEVATOR_SECTOR_LOTAG = 15;

/**
 * The lotag game.c writes over an SE 1 when its sector is destroyed, and which
 * actors.c case 0 reads as "your pivot is gone, remove yourself". Nothing in
 * uDuke destroys a sector, so this can only be reached by a test — it is here
 * because the mover's first statement is a check for it and a check for a
 * condition that cannot be written is not a check.
 */
const PIVOT_DESTROYED = 65535;

/** Tile numbers of the sprites that trigger effectors. names.h. */
const ACTIVATOR = 2, ACTIVATORLOCKED = 4;
/** names.h: MASTERSWITCH is tile 8. game.c spawns it into statnum 6. */
const MASTERSWITCH = 8;

/**
 * SE lotags an ACTIVATOR toggles rather than operates.
 *
 * sector.c: `case 36: case 31: case 32: case 18:
 * hittype[j].temp_data[0] = 1-hittype[j].temp_data[0];` — a flip, not a set, so
 * hitting the same switch twice stops a drop floor half way down. 18 and 36 are
 * listed because Build lists them; only 31 and 32 do anything here.
 */
const ACTIVATED_LOTAGS = new Set([18, 31, 32, 36]);

/** Build's `sector[SECT].lotag&16384`: an ACTIVATORLOCKED flips this bit. */
export const LOTAG_LOCKED_BIT = 16384;

/**
 * SE lotags whose sector is a MOVING sector — game.c captures each of their
 * walls as an offset from the SE sprite at level load, and ms() re-places the
 * walls from those offsets every frame. Reproduced whole even though only 15
 * moves, because the capture has to happen before anything else touches the
 * walls and adding a lotag later must not mean re-reading the map.
 */
const MOVING_SECTOR_LOTAGS = new Set([0, 2, 5, 6, 11, 14, 15, 16, 26, 30]);
/** wallswitchcheck(), game.c 3553: every switch tile and its lit frame. */
const WALL_SWITCHES = new Set([1155, 1142, 146, 147, 148, 149, 130, 170, 1122, 1111, 132, 134, 138, 136, 140, 712, 860, 862, 864, 162, 164, 166, 168]
  .flatMap((t) => [t, t + 1]));
/** The decals a conveyor wipes (actors.c 1635). */
const CONVEYOR_WIPES = new Set([1226, 4389, 550, 672, 673, 674, 952, 2296, 2297, 2298, 2299]);
const LASERLINE_TILE = 2567, TRIPBOMB_TILE = 2566;
/** Tiles the new effectors look for (names.h). */
const FIRELASER = 1625, REACTOR_TILE = 1088, REACTOR2_TILE = 578, BIGFORCE = 1497,
  EXPLOSION2_TILE = 1890, NATURALLIGHTNING = 4890, SMALLSMOKE_TILE = 2329, APLAYER_TILE = 1405;
const LOCATORS = 6;

/**
 * engine.c's krand(), exactly:
 *
 *   randomseed = (randomseed*27584621)+1;
 *   return ((uint32_t)randomseed)>>16;
 *
 * A 32-bit signed multiply that wraps, so Math.imul rather than `*` — plain
 * multiplication loses the low bits past 2^53 and the sequence diverges within
 * a few draws. The `>>>16` is on the UNSIGNED value, giving 0..65535.
 *
 * Reproduced rather than replaced with Math.random because a flickering light
 * is a sequence, not a mood: the same seed has to give the same flicker, or
 * nothing about it can be tested.
 */
export function krand(fx) {
  fx.randomSeed = (Math.imul(fx.randomSeed, 27584621) + 1) | 0;
  return (fx.randomSeed >>> 0) >>> 16;
}

/** Build's sintable: 2048 steps, amplitude 16384. */
const bsin = (a) => Math.round(Math.sin(((a & 2047) * Math.PI) / 1024) * 16384);

/** engine.c's rotatepoint. dmulscale14 is a floor, as C's >> is on negatives. */
export function rotatePoint(xpivot, ypivot, x, y, daang) {
  const dacos = bsin(daang + 2560), dasin = bsin(daang + 2048);
  const dx = x - xpivot, dy = y - ypivot;
  return {
    x: Math.floor((dx * dacos + -dy * dasin) / 16384) + xpivot,
    y: Math.floor((dy * dacos + dx * dasin) / 16384) + ypivot,
  };
}

/**
 * global.c's FindDistance2D: Build's 2D distance, and NOT a hypotenuse.
 *
 *   t = iy + (iy>>1);
 *   return (ix - (ix>>5) - (ix>>7) + (t>>2) + (t>>6));
 *
 * after taking absolute values and putting the larger in ix. It is the usual
 * octagonal approximation, and swept over the radii a rotating sector uses it
 * runs from 3.9 % LOW on an axis (962 for 1000) to 4.2 % HIGH between the
 * octagon's corners. Both directions, so "close enough to sqrt" is not a
 * defence: the one caller here freezes the result as an orbit radius, and a
 * hypotenuse would put every rotating sector on a circle of the wrong size by
 * up to four per cent — visible, and the sort of thing that gets chased in the
 * renderer for a session.
 */
export function findDistance2D(ix, iy) {
  ix = Math.abs(ix); iy = Math.abs(iy);
  if (ix < iy) { const tmp = ix; ix = iy; iy = tmp; }
  const t = iy + (iy >> 1);
  return ix - (ix >> 5) - (ix >> 7) + (t >> 2) + (t >> 6);
}

/**
 * global.c 475, FindDistance3D: the octagonal distance in three axes — the
 * largest axis less a sixteenth, plus a quarter and an eighth of the other
 * two. It is what the sound model measures with, and it is not a
 * hypotenuse: (1000, 0, 0) is 938.
 */
export function findDistance3D(ix, iy, iz) {
  ix = Math.abs(ix); iy = Math.abs(iy); iz = Math.abs(iz);
  if (ix < iy) { const t = ix; ix = iy; iy = t; }
  if (ix < iz) { const t = ix; ix = iz; iz = t; }
  const t = iy + iz;
  return ix - (ix >> 4) + (t >> 2) + (t >> 3);
}

/** sector.c's ldist: the distance between two sprites, plus one. */
export function ldist(s1, s2) {
  return findDistance2D(s1.x - s2.x, s1.y - s2.y) + 1;
}

/** engine.c's lastwall: the wall whose point2 is this one. */
export function lastWall(map, point) {
  if (point > 0 && map.walls[point - 1]?.point2 === point) return point - 1;
  let i = point, cnt = map.walls.length;
  while (cnt-- > 0) {
    const j = map.walls[i].point2;
    if (j === point) return i;
    i = j;
  }
  return point;
}

/**
 * engine.c's dragpoint: move a wall vertex, and every vertex on top of it.
 *
 * A map vertex is shared by every sector that meets there, stored once per
 * wall. Moving only the wall you asked for tears the map open along that seam,
 * so dragpoint walks the nextwall/point2 chain counter-clockwise and then, if
 * the loop is not closed, clockwise the other way. Both directions are needed:
 * a vertex on the edge of the map has no full ring to walk.
 */
export function dragPoint(map, pointhighlight, dax, day) {
  const walls = map.walls;
  walls[pointhighlight].x = dax;
  walls[pointhighlight].y = day;

  let cnt = walls.length;
  let tempshort = pointhighlight;
  do {
    if (walls[tempshort].nextWall >= 0) {
      tempshort = walls[walls[tempshort].nextWall].point2;
      walls[tempshort].x = dax;
      walls[tempshort].y = day;
    } else {
      // The ring is open. Go back to the start and walk the other way.
      tempshort = pointhighlight;
      let cnt2 = walls.length;
      do {
        const lw = lastWall(map, tempshort);
        if (walls[lw].nextWall >= 0) {
          tempshort = walls[lw].nextWall;
          walls[tempshort].x = dax;
          walls[tempshort].y = day;
        } else break;
        cnt2--;
      } while (tempshort !== pointhighlight && cnt2 > 0);
      break;
    }
    cnt--;
  } while (tempshort !== pointhighlight && cnt > 0);
}

/**
 * Per-sprite effector state, and the wall offsets a moving sector needs.
 *
 * `t` is Build's hittype[i].temp_data[0..5]; the code below indexes it 0-based
 * where the C uses T1..T6, so T5 is t[4]. Keeping the C's own numbering in the
 * comments and the array's in the code is less confusing than pretending
 * either one away.
 */
export class Effectors {
  constructor() {
    this.t = new Map();       // sprite index -> Int32Array(6)
    this.ang = new Map();     // sprite index -> Build's hittype[i].tempang
    this.offsets = new Map(); // sprite index -> [{x,y}] per wall of its sector
    this.list = [];           // sprite indices, Build's statnum-3 list
    this.subwaySound = new Map(); // SE 6/14 -> the running sound's handle (hittype.lastvx), null while quiet
    this.radarang = null;     // TABLES.DAT's getangle table; boot.js sets it
    this.transports = [];     // SE 7/23, which game.c moves to statnum 9
    this.masters = [];        // MASTERSWITCH sprites, Build's statnum 6
    this.plates = [];         // TOUCHPLATE sprites, also statnum 6
    this.earthquakeTime = 0;  // Build's `earthquaketime` global
    this.randomSeed = 0;      // engine.c's `randomseed`
    this.globalRandom = 0;    // game.c's `global_random`, one draw a tic
    this.skipped = new Map(); // lotag -> how many were ignored
    this.warnings = [];       // setup problems Build would have exited on
  }
  temp(i) {
    let a = this.t.get(i);
    if (!a) { a = new Int32Array(6); this.t.set(i, a); }
    return a;
  }
  /**
   * `hittype[i].tempang`. This is a SEPARATE field in Build, sitting beside
   * temp_data rather than in it, and it stays separate here. Widening the
   * Int32Array to seven and calling slot six tempang would have been less code
   * and would have put this file's numbering permanently out of step with the
   * source it is checked against.
   */
  tempAng(i) { return this.ang.get(i) ?? 0; }
  setTempAng(i, v) { this.ang.set(i, v); }
}

/**
 * game.c's SECTOREFFECTOR setup, as far as this needs it.
 *
 *   case SECTOREFFECTOR:
 *       sp->yvel = sector[sect].extra;
 *
 * — which is the join to the door work: `sector.extra` is 256 unless a GPSPEED
 * sprite said otherwise, so an effector's speed comes from the same place a
 * door's does. E1L5's SE-15 sprites carry yvel 0 in the file, so reading the
 * field straight from the MAP would leave every sliding door with a travel of
 * zero and no visible error.
 *
 * Call after setupLevel, which is what fills in `extra`.
 */
export function setupEffectors(map) {
  const fx = new Effectors();
  map.sprites.forEach((spr, i) => {
    // game.c 4631: an ACTIVATORLOCKED locks its sector at load (lotag |=
    // 16384) — the door behind a key-card lock, until the switch's
    // operateactivators flips the bit back. A first version only flipped.
    if (spr.picNum === ACTIVATORLOCKED && !spr.removed && spr.sectNum >= 0) map.sectors[spr.sectNum].lotag |= LOTAG_LOCKED_BIT;
    // MASTERSWITCH lives in statnum 6, not 3, and is the delayed trigger that
    // stands between a switch and half the effectors this file implements —
    // every one of E1L5's eight earthquakes has one in its sector, with a
    // hitag of 0, 24, 32, 60, 64, 96 or 128 tics so the room shakes in waves.
    if (spr.picNum === MASTERSWITCH && !spr.removed) {
      fx.masters.push(i);
      return;
    }
    // TOUCHPLATE, also statnum 6. game.c: `T3 = sector[sect].floorz;` and then
    // the plate sector's floor is dropped to the sprite's own z — which is how
    // a pressure plate is recessed into the ground it sits in. Skipped for
    // water sectors, where the floor means something else.
    if (spr.picNum === TILE.TOUCHPLATE && !spr.removed) {
      const t = fx.temp(i);
      const psec = map.sectors[spr.sectNum];
      t[2] = psec.floorZ;
      const lt = psec.lotag & LOTAG_MASK;
      if (lt !== 1 && lt !== 2) psec.floorZ = spr.z;
      fx.plates.push(i);
      return;
    }
    if (spr.picNum !== TILE.SECTOREFFECTOR || spr.removed) return;
    const sec = map.sectors[spr.sectNum];
    if (!sec) return;

    // game.c, in full:
    //   sp->yvel = sector[sect].extra;
    //   sp->cstat |= 32768;
    //   sp->xrepeat = sp->yrepeat = 0;
    // The last two were missing here. They matter beyond drawing: nearTag's
    // sprite arm measures a sprite by `height*yrepeat`, so an effector left at
    // its map repeat is a solid, invisible obstacle that swallows the "use"
    // key in front of anything behind it.
    spr.yVel = sec.extra;
    spr.cstat |= 32768;
    spr.xRepeat = 0;
    spr.yRepeat = 0;

    // `changespritestat(i,9)` and `return i` — a transporter leaves the
    // effector list at spawn and is never seen by moveeffectors again. Kept as
    // a separate list for the same reason: counting them among the skipped
    // lotags would report ten unimplemented effectors that are implemented,
    // and running them in the mover's switch would be a lie about where Build
    // puts them.
    if (spr.lotag === SE.TRANSPORT || spr.lotag === SE.TRANSPORT_END) {
      const t7 = fx.temp(i);
      // The partner: another 7 or 23 with the same hitag. A 23 owns itself,
      // and movetransports skips those outright — they are the far end of a
      // one-way pair, not a transporter in their own right.
      if (spr.lotag === SE.TRANSPORT_END) {
        spr.owner = i;
      } else {
        spr.owner = map.sprites.findIndex((o, k) => k !== i && !o.removed
          && o.picNum === TILE.SECTOREFFECTOR
          && (o.lotag === SE.TRANSPORT || o.lotag === SE.TRANSPORT_END)
          && o.hitag === spr.hitag);
      }
      if (spr.owner < 0) {
        fx.warnings.push(`lonely SE ${spr.lotag}: sprite ${i} has no partner with hitag ${spr.hitag}`);
      }
      // T5: `sector[sect].floorz == SZ`. This one bit decides which kind of
      // transporter it is — a pad you step onto, or a silent one that shifts
      // you sideways when you pass through it at the right height.
      t7[4] = sec.floorZ === spr.z ? 1 : 0;
      spr.cstat = 0;
      fx.transports.push(i);
      return;
    }

    fx.list.push(i);
    fx.temp(i);

    // Per-lotag setup, game.c's SECTOREFFECTOR switch. Only what the
    // implemented effectors read.
    const t = fx.temp(i);
    if (spr.lotag === SE.DROP_FLOOR) {
      t[1] = sec.floorZ;                    // T2: where it goes home to
      if (spr.ang !== 1536) sec.floorZ = spr.z;
    } else if (spr.lotag === SE.DROP_CEILING) {
      t[1] = sec.ceilingZ;                  // T2
      // T3 = sp->hitag, which shares its slot with the phase flag the mover
      // uses. Reproduced because the source says so; every SE 32 in E1L5 has
      // hitag 0, so nothing has ever exercised the difference.
      t[2] = spr.hitag;
      if (spr.ang !== 1536) sec.ceilingZ = spr.z;
    }
    // game.c 4928, SE 12: T2 and T3 keep the sector's shades as mapped — the
    // "off" state the lights fall back to.
    if (spr.lotag === SE.LIGHT_SWITCH) {
      const t = fx.temp(i);
      t[1] = sec.floorShade;
      t[2] = sec.ceilingShade;
    }
    // game.c 5158, SE 30 (with 6/14/5): the sector's hitag is the SE (extra 1,
    // or 0 for a sector whose hitag was -1), owner -1 (no locator chosen
    // yet), and T1 the neighbouring plain sector (lotag < 3, hitag 0) that
    // holds the LOCATORS the train runs between. The wall offsets (ms) are
    // captured like every moving sector's.
    if (spr.lotag === SE.TWO_WAY_TRAIN || spr.lotag === SE.SUBWAY || spr.lotag === SE.SUBWAY_CAR || spr.lotag === SE.BOSS_ROTATOR) {
      spr.extra = sec.hitag === -1 ? 0 : 1;
      sec.hitag = i;
      spr.owner = -1;
      spr.xVel = 0;
      const t = fx.temp(i);
      t.fill(0);
      let found = -1;
      for (let w = sec.wallPtr; w < sec.wallPtr + sec.wallNum; w++) {
        const ns = map.walls[w].nextSector;
        if (ns >= 0 && map.sectors[ns].hitag === 0 && (map.sectors[ns].lotag & LOTAG_MASK) < 3) { found = ns; break; }
      }
      t[0] = found;
      // game.c 5238: for 6 and 14, T4 = the hitag — the locator the train
      // starts toward; and the sound it runs with, callsound's or SUBWAY.
      if (spr.lotag !== SE.TWO_WAY_TRAIN) { t[3] = spr.hitag; if (spr.lotag !== SE.BOSS_ROTATOR) fx.subwaySound.set(i, null); }
    }
    // game.c 5127, SE 17: T3 the stopping floor (this sector's), T4 the
    // ceiling of the next sector below, T5 the floor of the next above.
    if (spr.lotag === SE.WARP_ELEVATOR) {
      const t = fx.temp(i);
      t[2] = sec.floorZ;
      const below = nextSectorNeighborZ(map, spr.sectNum, sec.floorZ, -1, -1);
      t[3] = below >= 0 ? map.sectors[below].ceilingZ : sec.ceilingZ;
      const above = nextSectorNeighborZ(map, spr.sectNum, sec.ceilingZ, 1, 1);
      t[4] = above >= 0 ? map.sectors[above].floorZ : sec.floorZ;
    }
    // game.c 4888, SE 1: `sp->owner = -1; T1 = 1;` — a pivot is RUNNING from
    // the start, so a plain rotating sector (not a lotag-30 bridge, which
    // ignores the pivot's flag) turns from the first tic: E1L3's lotag-3
    // sectors 60/61. SE 19 only ever stops one (t[0] = 2) or starts one that
    // something else stopped.
    if (spr.lotag === SE.PIVOT) {
      spr.owner = -1;
      fx.temp(i)[0] = 1;
    }
    // game.c 4868, SE 28: T6 = 65, the lightning's first delay.
    if (spr.lotag === SE.LIGHTNING) t[5] = 65;
    // game.c 4892, SE 18: T2 keeps the plane it rides back to (ceiling at ang
    // 512, else floor); with a pal the plane STARTS at the sprite's z. The
    // hitag (how many tics a run lasts) is quadrupled.
    if (spr.lotag === SE.ELEVATOR_STEP) {
      if (spr.ang === 512) { t[1] = sec.ceilingZ; if (spr.pal) sec.ceilingZ = spr.z; }
      else { t[1] = sec.floorZ; if (spr.pal) sec.floorZ = spr.z; }
      spr.hitag <<= 2;
    }
    // game.c 4909, SE 19: owner -1 (no shooter yet).
    if (spr.lotag === SE.SHIELD) spr.owner = -1;
    // game.c 4919, SE 35: the ceiling starts at the sprite's z.
    if (spr.lotag === SE.MIST) sec.ceilingZ = spr.z;
    // game.c 5245, SE 16: T4 = the mapped ceiling.
    if (spr.lotag === SE.REACTOR) t[3] = sec.ceilingZ;
    // game.c 5248, SE 26: T4/T5 the sprite's home x/y; a sprite shaded like
    // the floor runs UP (zvel -256), otherwise down; the shade is then the
    // step counter, from 0.
    if (spr.lotag === SE.ESCALATOR) {
      t[3] = spr.x; t[4] = spr.y;
      spr.zVel = spr.shade === sec.floorShade ? -256 : 256;
      spr.shade = 0;
    }
    // game.c 4912, SE 25: T4 = the mapped ceiling (the top of the stroke),
    // T5 = 1 (running from the start), and the ceiling begins at the
    // sprite's z (the bottom).
    if (spr.lotag === SE.PISTON) {
      const t = fx.temp(i);
      t[3] = sec.ceilingZ;
      t[4] = 1;
      sec.ceilingZ = spr.z;
    }
    // game.c 5012, SE 20: T2 and T3 are the sector's two wall points nearest
    // the sprite — the leading edge of the bridge, the two that get dragged.
    if (spr.lotag === SE.STRETCH_BRIDGE) {
      const t = fx.temp(i);
      let q = 0x7fffffff, closest = -1;
      for (let w = sec.wallPtr; w < sec.wallPtr + sec.wallNum; w++) {
        const d = findDistance2D(spr.x - map.walls[w].x, spr.y - map.walls[w].y);
        if (d < q) { q = d; closest = w; }
      }
      t[1] = closest;
      q = 0x7fffffff;
      for (let w = sec.wallPtr; w < sec.wallPtr + sec.wallNum; w++) {
        const d = findDistance2D(spr.x - map.walls[w].x, spr.y - map.walls[w].y);
        if (d < q && w !== t[1]) { q = d; closest = w; }
      }
      t[2] = closest;
    }
    if (spr.lotag === SE.RANDOM_LIGHT) {
      // game.c: T4 keeps the floor shade the sector had; the sprite's shade
      // becomes the sector's now, and its walls' (except hitag&1) — and the
      // pals of ceiling and floor are packed into owner for later.
      t[3] = sec.floorShade;
      sec.floorShade = spr.shade;
      sec.ceilingShade = spr.shade;
      spr.owner = ((sec.ceilingPal ?? 0) << 8) | (sec.floorPal ?? 0);
      for (let w = sec.wallPtr; w < sec.wallPtr + sec.wallNum; w++) {
        const wl = map.walls[w];
        if (!(wl.hitag & 1)) wl.shade = spr.shade;
        if ((wl.cstat & 2) && wl.nextWall >= 0) map.walls[wl.nextWall].shade = spr.shade;
      }
    }
    if (spr.lotag === SE.EXPLOSION) {
      // game.c 4934: T1/T2 remember the OPEN ceiling and floor; owner says
      // which the sprite sits nearer; then the sector is CLOSED to the
      // sprite's z — the one plane at ang 512, both otherwise. A parallaxed
      // ceiling is switched off for now and remembered in T4, with the floor
      // shade on it. This is the wall that looks solid until the crack blows.
      t[0] = sec.ceilingZ;
      t[1] = sec.floorZ;
      spr.owner = Math.abs(t[0] - spr.z) < Math.abs(t[1] - spr.z) ? 1 : 0;
      if (spr.ang === 512) {
        if (spr.owner) sec.ceilingZ = spr.z; else sec.floorZ = spr.z;
      } else {
        sec.ceilingZ = spr.z; sec.floorZ = spr.z;
      }
      if (sec.ceilingStat & 1) {
        sec.ceilingStat ^= 1;
        t[3] = 1;
        if (!spr.owner && spr.ang === 512) { sec.ceilingStat ^= 1; t[3] = 0; }
        sec.ceilingShade = sec.floorShade;
      }
    }
    if (spr.lotag === SE.DROP_FLOOR || spr.lotag === SE.DROP_CEILING) {
      // game.c marks the sector's untagged walls 9999 so later passes can tell
      // a moving sector's walls from a mapper's own tags.
      const end = sec.wallPtr + sec.wallNum;
      for (let w = sec.wallPtr; w < end; w++) {
        if (map.walls[w].hitag === 0) map.walls[w].hitag = 9999;
      }
    }

    // game.c: `case 11: if(sp->ang>1024) T4 = 2; else T4 = -2;` — T4 is
    // temp_data[3], the swing DIRECTION, and it is the raw map angle that picks
    // the sign, not a masked one. The operator negates it, so the first swing
    // of a door's life goes the other way from the sign set here.
    if (spr.lotag === SE.SWING_DOOR) t[3] = spr.ang > 1024 ? 2 : -2;

    // game.c case 8/9: the three resting shades and a step of one. T4 is set
    // to a literal 1 with the comment `//Take Out;` beside it — a note to
    // itself that never got taken out, and the step the mover uses.
    if (spr.lotag === SE.DOOR_LIGHT || spr.lotag === SE.DOOR_LIGHT_INVERTED) {
      t[0] = sec.floorShade;
      t[1] = sec.ceilingShade;
      for (let w = sec.wallPtr; w < sec.wallPtr + sec.wallNum; w++) {
        if (map.walls[w].shade > t[2]) t[2] = map.walls[w].shade;
      }
      t[3] = 1;
    }

    // game.c case 4: the resting shades and the two pals, kept aside so the
    // flicker has somewhere to fall back to. T4 starts at zero and the loop
    // only RAISES it, so a sector whose walls are all darker than zero keeps
    // zero — Build's, and not the same as "the brightest wall".
    if (spr.lotag === SE.FLICKER) {
      t[2] = sec.floorShade;
      spr.owner = ((sec.ceilingPal & 0xff) << 8) | (sec.floorPal & 0xff);
      for (let w = sec.wallPtr; w < sec.wallPtr + sec.wallNum; w++) {
        if (map.walls[w].shade > t[3]) t[3] = map.walls[w].shade;
      }
    }

    // game.c: `T6 = sector[sp->sectnum].floorheinum; sector[...].floorheinum = 0;`
    // The quake sector is FLATTENED at level load and its authored slope kept
    // aside — the shake is the floor tilting back to what the mapper drew.
    if (spr.lotag === SE.QUAKE) {
      t[5] = sec.floorHeinum;
      sec.floorHeinum = 0;
    }

    if (spr.lotag === SE.ROTATE_SECTOR) {
      // The rise-and-rotate bridge keeps its home floor height in T4 and hands
      // the sector a back-reference to the sprite, which is how operatesectors
      // finds the effector when the player uses the sector. Build writes over
      // `sector.hitag` to do it; so does this.
      if ((sec.lotag & LOTAG_MASK) === ROTATE_RISE_SECTOR_LOTAG) {
        spr.clipDist = spr.pal ? 1 : 0;   // which way round it turns
        t[3] = sec.floorZ;                // T4
        sec.hitag = i;
      }

      // Every SE 0 belongs to an SE 1 pivot sharing its hitag; Build exits the
      // game with "Found lonely Sector Effector" when there is none. Exiting is
      // not available here, so it is recorded — silently leaving the sector
      // still would be the "does nothing because unfinished" ambiguity this
      // module already pays attention to elsewhere.
      const j = map.sprites.findIndex((o) => !o.removed
        && o.picNum === TILE.SECTOREFFECTOR && o.lotag === SE.PIVOT
        && o.hitag === spr.hitag);
      // Note the ORDER: at ang 512 the sprite is moved onto the pivot BEFORE
      // the wall offsets below are captured. Reversed, every offset would be
      // measured from the old spot and the whole sector would jump on frame one.
      if (j >= 0 && spr.ang === 512) { spr.x = map.sprites[j].x; spr.y = map.sprites[j].y; }
      spr.owner = j;
      if (j < 0) {
        fx.warnings.push(`lonely SE 0: sprite ${i} at ${spr.x},${spr.y} has no pivot with hitag ${spr.hitag}`);
      }
    }

    if (MOVING_SECTOR_LOTAGS.has(spr.lotag)) {
      const offs = [];
      const end = sec.wallPtr + sec.wallNum;
      for (let w = sec.wallPtr; w < end; w++) {
        offs.push({ x: map.walls[w].x - spr.x, y: map.walls[w].y - spr.y });
      }
      fx.offsets.set(i, offs);
    }
  });
  // Build's statnum lists are head-inserted (insertspritestat), and prelevel
  // spawns in index order, so moveeffectors walks the effectors from the
  // HIGHEST index down. The order decides who wins a shared vertex: E1L3's
  // turntable 450 and the five ring sectors around it (187..190, 184) each
  // carry an SE 0 on the same pivot, and every one of them re-places its
  // walls from its own offsets each tic (ms). Only 450 turns; walked
  // ascending, its SE (#254) went first and the ring's SEs (#260..#265)
  // dragged the shared points straight back — the turntable never moved.
  // Walked descending, #254 goes last and its rotation stands, as in Duke.
  fx.list.sort((a, b) => b - a);
  return fx;
}

/**
 * actors.c's ms(): move a sector by moving the sprite that owns it.
 *
 *   s->x += (s->xvel*(sintable[(s->ang+512)&2047]))>>14;
 *   ...
 *   rotatepoint(0,0,msx[j],msy[j],k&2047,&tx,&ty);
 *   dragpoint(x,s->x+tx,s->y+ty);
 *
 * The walls are not nudged, they are RE-PLACED from the offsets captured at
 * level load. That is what keeps a moving sector rigid: incremental nudges
 * would accumulate rounding, and here there is nothing to accumulate.
 *
 * While SE 15 was the only effector no test could separate the two: with t[2]
 * fixed at 0 the rotation is the identity, a pure translation by an exact
 * integer step is bit-identical either way, and replacing the re-placement with
 * a nudge failed nothing. The rotating effectors settled it. rotatePoint floors
 * each offset on its own, so a nudged sector accumulates that rounding once per
 * frame and drifts; re-placing lands eight full swings later on the exact
 * original vertices. SE 16 is still not implemented.
 */
export function ms(map, fx, i) {
  const s = map.sprites[i];
  const offs = fx.offsets.get(i);
  if (!offs) return;
  const t = fx.temp(i);

  s.x += (s.xVel * bsin(s.ang + 512)) >> 14;
  s.y += (s.xVel * bsin(s.ang)) >> 14;

  const sec = map.sectors[s.sectNum];
  const end = sec.wallPtr + sec.wallNum;
  for (let w = sec.wallPtr, j = 0; w < end; w++, j++) {
    const r = rotatePoint(0, 0, offs[j].x, offs[j].y, t[2] & 2047);
    dragPoint(map, w, s.x + r.x, s.y + r.y);
  }
}

/**
 * actors.c's moveeffectors(), for one game frame.
 *
 * Returns `{moved, active, skipped}`.
 *
 * `moved` counts effectors that changed geometry this frame; `active` counts
 * those still busy, INCLUDING one sitting out a delay. The two differ, and
 * conflating them is a mistake this made once: SE 31 reloads t[3] from the
 * sprite's hitag at each end and spends those frames doing nothing at all, so
 * a caller that loops "until nothing moved" stops in the middle of the pause
 * and calls it finished. `active` is what a run loop should watch.
 *
 * `moved` counts effectors that changed something this tic; `active` counts
 * those still travelling toward a goal, which is what a caller waits on. A
 * conveyor is counted in the first and never the second: it has no goal, and
 * waiting for one to finish does not terminate.
 *
 * `fricX`/`fricY` are Build's `fricxv`/`fricyv` globals — this tic's conveyor
 * push, for the player's own friction to integrate. Zeroed every call, as
 * actors.c zeroes them.
 *
 * `skipped` counts the unimplemented lotags, because an SE that does nothing
 * because uDuke has not got to it and one that is merely idle look identical
 * otherwise — a lesson the doors already charged for.
 *
 * `cam` and `onGround` are optional and only a rotating sector reads them: it
 * turns whatever is standing in it about the pivot, the eye included, and there
 * is no way to do that from outside without duplicating the angle. Left out,
 * every other effector behaves exactly as before; a rotating floor then turns
 * under the player's feet instead of taking them with it.
 */
export function moveEffectors(map, fx, cam = null, onGround = false, anims = null) {
  let moved = 0, active = 0;
  // actors.c's first statement: `fricxv = fricyv = 0;`. These are globals that
  // moveeffectors fills and player.c reads in the SAME tic — conveyors do not
  // move the player themselves, they contribute a velocity that the player's
  // own friction model integrates. Reset here for the same reason Build does:
  // they are this tic's push, not an accumulator.
  let fricX = 0, fricY = 0;
  // `global_random = TRAND;` — game.c draws it once a frame, before the actor
  // and effector loops. One draw for the whole tic, so every flickering light
  // in the level flashes off the SAME number: they are correlated in Duke, and
  // a per-light draw would look subtly busier than the original.
  fx.globalRandom = krand(fx);
  fx.skipped.clear();

  for (const i of fx.list) {
    const s = map.sprites[i];
    if (!s || s.removed) continue;
    const t = fx.temp(i);

    switch (s.lotag) {
      case SE.SLIDING_DOOR: {
        // t[4] (Build's T5): 0 idle, 1 opening, 2 closing. t[3] (T4) is how
        // far along it is, counted in frames rather than in world units —
        // travel = (yvel>>3) frames of 16 units, so the sector's speed sets
        // the DISTANCE and not the rate. A slower door is a shorter one.
        if (!t[4]) break;
        active++;
        s.xVel = 16;
        if (t[4] === 1) {
          if (t[3] >= (s.yVel >> 3)) { t[4] = 0; break; }
          t[3]++;
        } else if (t[4] === 2) {
          if (t[3] < 1) { t[4] = 0; break; }
          t[3]--;
        }
        ms(map, fx, i);
        moved++;
        break;
      }
      case SE.ROTATE_SECTOR: {
        const sec = map.sectors[s.sectNum];
        const pivot = map.sprites[s.owner];
        if (!pivot || pivot.lotag === PIVOT_DESTROYED) { s.removed = true; break; }

        let q = sec.extra >> 3;
        let l = 0, zchange = 0;

        if ((sec.lotag & LOTAG_MASK) === ROTATE_RISE_SECTOR_LOTAG) {
          // The rise-and-rotate bridge. It runs on sprite.extra (1 out, 3
          // back), which operatesectors toggles, and on tempang as a 0..256
          // progress counter climbing in fours. Note q is quartered here: the
          // bridge turns at a quarter of the plain rotator's rate off the same
          // sector speed.
          q >>= 2;
          let ta = fx.tempAng(i);
          if (s.extra === 1) {
            if (ta < 256) { ta += 4; l = s.clipDist ? 1 : -1; }
            else ta = 256;
            // "z's are touching" in the source. The floor walks to the sprite's
            // own z in fixed 512 steps and clamps, rather than easing.
            if (sec.floorZ > s.z) {
              sec.floorZ -= 512; zchange = -512;
              if (sec.floorZ < s.z) sec.floorZ = s.z;
            } else if (sec.floorZ < s.z) {
              sec.floorZ += 512; zchange = 512;
              if (sec.floorZ > s.z) sec.floorZ = s.z;
            }
          } else if (s.extra === 3) {
            if (ta > 0) { ta -= 4; l = s.clipDist ? -1 : 1; }
            else ta = 0;
            // Going home the target is T4, the floor height captured at setup.
            if (sec.floorZ > t[3]) {
              sec.floorZ -= 512; zchange = -512;
              if (sec.floorZ < t[3]) sec.floorZ = t[3];
            } else if (sec.floorZ < t[3]) {
              sec.floorZ += 512; zchange = 512;
              if (sec.floorZ > t[3]) sec.floorZ = t[3];
            }
          }
          fx.setTempAng(i, ta);
          s.ang += l * q;
          t[2] += l * q;
          if (l !== 0 || zchange !== 0) { active++; moved++; }
        } else {
          // The plain rotator, driven entirely by its pivot's t[0]: 0 idle,
          // 1 turning, 2 stop and remove. spawn() gives every SE 1 t[0] = 1
          // (game.c 4888), so a plain rotator turns from the first tic; only
          // an SE 19 of the same hitag holds it (see case SE.PIVOT) until shot.
          const tp = fx.temp(s.owner);
          if (tp[0] === 0) break;
          if (tp[0] === 2) { s.removed = true; break; }

          l = pivot.ang > 1024 ? -1 : 1;
          // The orbit radius is frozen on the first running frame and never
          // recomputed — which is what keeps the sector on a circle at all,
          // since the next two lines move the sprite onto the pivot and ms()
          // then throws it back out along its own angle.
          if (t[3] === 0) t[3] = ldist(s, pivot);
          s.xVel = t[3];
          s.x = pivot.x;
          s.y = pivot.y;
          s.ang += l * q;
          t[2] += l * q;
          active++; moved++;
        }

        // floorstat bit 64 is Build's "relative alignment" flag, and it is what
        // decides whether the sector's contents come along for the ride. A
        // rotating sector without it turns under whatever is standing on it.
        if (l && (sec.floorStat & 64)) {
          carryRotation(map, sec, s.sectNum, pivot, l * q, zchange, cam, onGround);
        }
        ms(map, fx, i);
        break;
      }

      case SE.CONVEYOR:
      case SE.CONVEYOR_ALT: {
        // A conveyor never has to be switched on: the only things that set
        // t[4] on an effector are a touchplate reaching lotag 3 and a SEENINE
        // reaching lotag 8, so nothing in the reachable source can stop a 24.
        // It is the first effector here that simply runs.
        if (t[4]) break;
        const sec = map.sectors[s.sectNum];
        if (!sec) break;

        // Note the shift: >>18, not the >>14 every other use of the sintable
        // takes. Four bits of that is the conveyor being slow on purpose, and
        // reading it as a normal sine would run the belt sixteen times too fast.
        const x = (s.yVel * bsin(s.ang + 512)) >> 18;
        const l = (s.yVel * bsin(s.ang)) >> 18;

        // Sprites get a QUARTER of it; the player, below, gets eight times it.
        // The two are not the same number and never were. actors.c 1627: only
        // sprites with zvel >= 0 of statnum 5, 6, 1 and 0 — never effectors
        // (3), zombies (2), projectiles (4), players (10). Statnum 5: blood,
        // puke, footprints, bullet holes and splats are wiped (size 0), a
        // LASERLINE stays; 6: a TRIPBOMB stays; 1 and 0: the bolts and every
        // WALL SWITCH stay (wallswitchcheck, game.c 3553), the crane too.
        for (let j = 0; j < map.sprites.length; j++) {
          const spr = map.sprites[j];
          if (spr.removed || spr.sectNum !== s.sectNum) continue;
          if (spr.picNum === TILE.SECTOREFFECTOR) continue;
          if (!((spr.zVel ?? 0) >= 0)) continue;
          const st = fx.statOf ? fx.statOf(j) : 0;
          if (st === 5 && CONVEYOR_WIPES.has(spr.picNum)) { spr.xRepeat = 0; spr.yRepeat = 0; continue; }
          if (st === 5 && spr.picNum === LASERLINE_TILE) continue;
          if (st === 6 && spr.picNum === TRIPBOMB_TILE) continue;
          if (st !== 5 && st !== 6 && st !== 1 && st !== 0) continue;
          if ((spr.picNum >= 634 && spr.picNum <= 637) || (spr.picNum >= 4525 && spr.picNum <= 4528) || WALL_SWITCHES.has(spr.picNum)) continue;
          if (spr.picNum >= 1222 && spr.picNum <= 1225) continue;
          // `if(sprite[j].z > (hittype[j].floorz-(16<<8)))`: only what is
          // lying on the belt rides it. Build keeps floorz per actor from its
          // own movement; there is no such cache here, so it is asked for.
          const fz = getZRange(map, spr.x, spr.y, spr.z, spr.sectNum, 0, CLIPMASK0).florZ;
          if (!(spr.z > fz - (16 << 8))) continue;
          spr.x += x >> 2;
          spr.y += l >> 2;
        }

        if (cam && cam.sectNum === s.sectNum && onGround) {
          fricX += x << 3;
          fricY += l << 3;
        }

        // The belt itself: the floor texture scrolls whether or not anything is
        // standing on it, and it is a uint8 in the MAP, so it wraps.
        sec.floorXPanning = (sec.floorXPanning + (s.yVel >> 7)) & 255;

        // `moved` but deliberately NOT `active`. Every other effector here is
        // travelling toward a goal and `active` means "not there yet", which is
        // what `runUntilStill` and the probes wait on. A conveyor has no goal:
        // counting it as active makes "run until nothing is moving" a loop that
        // never ends, and doorprobe duly spun 20000 times and then reported 25
        // of E1L5's 39 switches refused, because from where it stood the level
        // genuinely never stopped moving.
        moved++;
        break;
      }

      case SE.QUAKE: {
        const sec = map.sectors[s.sectNum];
        if (!sec) break;
        // t[4] is a warm-up counter climbing to the sprite's hitag; t[0] is the
        // quake itself. MASTERSWITCH sets t[0] straight to 1, so the warm-up is
        // only reachable from CON and is reproduced rather than guessed at.
        if (t[4] > 0 && t[0] === 0) {
          if (t[4] < s.hitag) t[4]++;
          else t[0] = 1;
        }
        if (t[0] <= 0) break;

        t[0]++;
        s.xVel = 3;

        if (t[0] > 96) {
          // `KILLIT(i)` — a quake runs 96 tics and then the effector is gone
          // for good. There is no second earthquake from the same sprite.
          t[0] = -1;
          t[4] = -1;
          s.removed = true;
          break;
        }

        // Every 32 tics, on the eighth: the view shake, which is the part you
        // actually see. 48 is Build's, and game.c decrements it once a frame.
        if ((t[0] & 31) === 8) { fx.earthquakeTime = 48; if (fx.playerSound) fx.playerSound('EARTHQUAKE'); }   // actors.c 5549: spritesound(EARTHQUAKE, the player)

        // The floor tilts back toward the slope setup took away, sixteen
        // heinum a tic, snapping when it is within eight.
        if (Math.abs(sec.floorHeinum - t[5]) < 8) sec.floorHeinum = t[5];
        else sec.floorHeinum += Math.sign(t[5] - sec.floorHeinum) << 4;

        // >>14 here, unlike the conveyor's >>18: with xvel 3 the sector and
        // everything in it drift three units a tic along the sprite's angle.
        const m = (s.xVel * bsin(s.ang + 512)) >> 14;
        const x = (s.xVel * bsin(s.ang)) >> 14;

        if (cam && cam.sectNum === s.sectNum && onGround) {
          cam.x += m;
          cam.y += x;
        }
        for (const spr of map.sprites) {
          if (spr.removed || spr.sectNum !== s.sectNum) continue;
          if (spr.picNum === TILE.SECTOREFFECTOR) continue;
          spr.x += m;
          spr.y += x;
        }
        active++; moved++;
        ms(map, fx, i);
        break;
      }

      case SE.FLICKER: {
        const sec = map.sectors[s.sectNum];
        if (!sec) break;
        // `(global_random/(sh+1)&31) < 4`.
        //
        // The hitag sets the DUTY CYCLE, not the rhythm: global_random is drawn
        // afresh every tic, so the light re-rolls every tic no matter what, and
        // the hitag only changes how often the roll comes up bright.
        //
        // And it does that non-monotonically, which is worth knowing before
        // anyone "fixes" it. The quotient runs 0..floor(65535/(h+1)) and the
        // test wants it in 0..3 mod 32, so the answer depends on where that
        // range stops relative to a multiple of 32 — a sawtooth. Measured
        // exactly over all 65536 draws, E1L5's hitags give:
        //
        //     13, 17, 18, 19 -> 12.5 %      2046..2049 -> 12.5 %
        //     600, 800       -> 14.7 %      3000       -> 18.3 %
        //     900            -> 16.5 %      5113       -> 31.2 %
        //     1700           -> 20.8 %
        //
        // So a bigger hitag is not a slower light, and 1700 flashes more than
        // 2048 does. The first version of the comment here said the opposite
        // and the test caught it.
        const bright = ((Math.floor(fx.globalRandom / (s.hitag + 1))) & 31) < 4;
        let lit = 0;
        if (bright) {
          // "Got really bright" — the source says so. shade plus a random
          // 0..15, and the pals swapped for the ones kept at spawn.
          t[1] = s.shade + (fx.globalRandom & 15);
          t[0] = s.shade + (fx.globalRandom & 15);
          sec.ceilingPal = s.owner >> 8;
          sec.floorPal = s.owner & 0xff;
          lit = 1;
        } else {
          t[1] = t[2];
          t[0] = t[3];
          sec.ceilingPal = s.pal;
          sec.floorPal = s.pal;
        }
        sec.floorShade = t[1];
        sec.ceilingShade = t[1];

        for (let w = sec.wallPtr; w < sec.wallPtr + sec.wallNum; w++) {
          const wal = map.walls[w];
          wal.pal = lit ? (s.owner & 0xff) : s.pal;
          // hitag 1 on a wall means "leave my shade alone" — a mapper's opt-out,
          // and the reason a flickering room can keep one wall steady.
          if (wal.hitag === 1) continue;
          wal.shade = t[0];
          if ((wal.cstat & 2) && wal.nextWall >= 0) {
            map.walls[wal.nextWall].shade = wal.shade;
          }
        }

        for (const spr of map.sprites) {
          if (spr.removed || spr.sectNum !== s.sectNum) continue;
          // cstat bit 4: "the sector's light applies to me".
          if (!(spr.cstat & 16)) continue;
          spr.shade = (sec.ceilingStat & 1) ? sec.ceilingShade : sec.floorShade;
        }

        // `if(t[4]) KILLIT(i);` — an exploded light stops for good. Only a
        // SEENINE sets t[4], and there are no explosions here, so this is
        // reachable by a test and by nothing else yet.
        if (t[4]) s.removed = true;
        moved++;
        break;
      }

      case SE.DOOR_CLOSER: {
        // actors.c 914, SE 10: the door closer. Its sector counts as "open"
        // when it is a stretch bridge (27), or floorz > ceilingz and not a
        // swinging door (23), or lotag 32791 (23 with the state bit — an open
        // swinging door). Then, unless a player stands in the sector (and the
        // sector is tagged — 30, 31 and 0 do not count), t[0] climbs a tic at
        // a time to the hitag, and at the hitag the sector is activated: by
        // its ACTIVATORs if it has any, else operatesectors — which, for a
        // door, closes it. A door whose ceiling is still travelling (20, 21,
        // 22, 26 — matched on the FULL lotag, so in practice an open one
        // never matches and falls to default) waits.
        const sec = map.sectors[s.sectNum];
        if (!sec) break;
        const lo = sec.lotag & 0xff;
        const open = lo === 27 || (sec.floorZ > sec.ceilingZ && lo !== 23) || sec.lotag === 32791;
        if (!open) { t[0] = 0; break; }
        let j = 1;
        if (lo !== 27 && cam && sec.lotag !== 30 && sec.lotag !== 31 && sec.lotag !== 0
            && cam.sectNum === s.sectNum) j = 0;
        if (j !== 1) break;
        if (t[0] > s.hitag) {
          switch (sec.lotag) {
            case 20: case 21: case 22: case 26:
              if (anims && anims.find(s.sectNum, 'ceilingZ') >= 0) break;
              // falls through
            default:
              if (fx.activateBySector) fx.activateBySector(s.sectNum, i);
              t[0] = 0;
              break;
          }
        } else t[0]++;
        break;
      }

      case SE.LIGHT_SWITCH: {
        // actors.c 1005, SE 12: a light switch. t[0] is the state: 0 off,
        // 1 flickering on, 2 on, 3 going off (checkhitswitch steps it: 0->1,
        // 1->3, 2->3). t[1]/t[2] are the mapped shades (the "off" look).
        //
        // Going off: pals cleared, walls (hitag 1 left alone), floor and
        // ceiling set back to the mapped shades, t[0] = 0, sprites with cstat
        // 16 follow the sector. Coming on: while the floor is darker than
        // the effector's shade, everything lightens by 2 a tic in the
        // effector's pal; at the effector's shade the state is 2.
        const sec = map.sectors[s.sectNum];
        if (!sec) break;
        const follow = () => {
          for (const spr of map.sprites) {
            if (spr.removed || spr.sectNum !== s.sectNum || !(spr.cstat & 16)) continue;
            spr.shade = (sec.ceilingStat & 1) ? sec.ceilingShade : sec.floorShade;
          }
        };
        if (t[0] === 3 || t[3] === 1) {
          sec.floorPal = 0;
          sec.ceilingPal = 0;
          for (let w = sec.wallPtr; w < sec.wallPtr + sec.wallNum; w++) {
            const wal = map.walls[w];
            if (wal.hitag === 1) continue;
            wal.shade = t[1];
            wal.pal = 0;
          }
          sec.floorShade = t[1];
          sec.ceilingShade = t[2];
          t[0] = 0;
          follow();
          moved++;
          if (t[3] === 1) { s.removed = true; break; }
        }
        if (t[0] === 1) {
          if (sec.floorShade > s.shade) {
            sec.floorPal = s.pal;
            sec.ceilingPal = s.pal;
            sec.floorShade -= 2;
            sec.ceilingShade -= 2;
            for (let w = sec.wallPtr; w < sec.wallPtr + sec.wallNum; w++) {
              const wal = map.walls[w];
              if (wal.hitag === 1) continue;
              wal.pal = s.pal;
              wal.shade -= 2;
            }
          } else t[0] = 2;
          follow();
          moved++;
        }
        break;
      }

      case SE.WAVES: {
        // actors.c 1522, SE 29: hitag is the phase, +64 a tic; the floor is
        // the sprite's z plus yvel * sin(phase) / 4096 (mulscale12).
        const sec = map.sectors[s.sectNum];
        if (!sec) break;
        s.hitag = (s.hitag + 64) & 0xffff;
        sec.floorZ = s.z + Math.trunc((s.yVel * bsin(s.hitag & 2047)) / 4096);
        active++; moved++;
        break;
      }

      case SE.QUAKE_DEBRIS:
        // actors.c 2136, SE 33: while the ground shakes, a random scrap one
        // tic in eight (RANDOMSCRAP is the page's, through fx.randomScrap).
        if (fx.earthquakeTime > 0 && (krand(fx) & 7) === 0 && fx.randomScrap) fx.randomScrap(i);
        break;

      case SE.SHOOTER:
        // actors.c 2140, SE 36: an activator flips t[0] on; at 1 it shoots
        // the sector's extra (a GPSPEED names the projectile) from the
        // sprite; at 26*5 the count is put to 0 — and then, unconditionally,
        // ++: back at 1, it shoots again. A started shooter fires every five
        // seconds for good (E1L4's shrink emitters). `t[0]++` is outside the
        // reset's else in Duke; a guarded increment made it a single shot.
        if (t[0]) {
          const sec = map.sectors[s.sectNum];
          if (t[0] === 1 && fx.shoot && sec) fx.shoot(i, sec.extra);
          else if (t[0] === 26 * 5) t[0] = 0;
          t[0]++;
        }
        break;

      case SE.TWO_WAY_TRAIN: {
        // actors.c 421, SE 30. Between trips owner is -1: the next trip picks
        // the other locator (t[3] flips) in the plain sector T1. Started
        // (t[4] = 1, by operatesectors on the lotag-31 sector): at rest it
        // fires the activators of hitag+!t[3] (the doors at the departure
        // end), then accelerates 16 a tic to 256; within 2048-128 of the
        // locator it decelerates (t[4] = 2); at 128 it stops — the activators
        // of hitag+t[3] fire, the force fields of hitag toggle, the angle
        // turns round, owner -1, t[4] 0. Moving: players and sprites in the
        // sector ride, the walls follow (ms), the sprite too; a player found
        // in the train's sector who was not in it before (or in no sector) is
        // crushed, when the car is under 108<<8 high.
        const sec = map.sectors[s.sectNum];
        if (!sec) break;
        if (s.owner === -1) {
          t[3] = t[3] ? 0 : 1;
          s.owner = locateLocator(map, t[3], t[0]);
        } else {
          if (t[4] === 1) {
            const o = map.sprites[s.owner];
            if (o && ldist(o, s) < 2048 - 128) t[4] = 2;
            else {
              if (s.xVel === 0 && fx.operateActivatorsHook) fx.operateActivatorsHook(s.hitag + (t[3] ? 0 : 1));
              if (s.xVel < 256) s.xVel += 16;
            }
          }
          if (t[4] === 2) {
            const o = map.sprites[s.owner];
            const l = o ? findDistance2D(o.x - s.x, o.y - s.y) : 0;
            if (l <= 128) s.xVel = 0;
            if (s.xVel > 0) s.xVel -= 16;
            else {
              s.xVel = 0;
              if (fx.operateActivatorsHook) fx.operateActivatorsHook(s.hitag + t[3]);
              s.owner = -1;
              s.ang = (s.ang + 1024) & 2047;
              t[4] = 0;
              // `operateforcefields(i, s->hitag)` — i is this SE 30, and
              // sector.c 1144 clears the lotag of every field it OPENS when the
              // caller is an SE 30: the station gate stays open for good, and
              // the next arrival no longer toggles it. Passed on as the flag.
              if (fx.operateForceFields) fx.operateForceFields(s.hitag, true);
            }
          }
        }
        if (s.xVel) {
          const l = (s.xVel * bsin(s.ang + 512)) >> 14;
          const x = (s.xVel * bsin(s.ang)) >> 14;
          const low = (sec.floorZ - sec.ceilingZ) < (108 << 8);
          if (cam) {
            if (low && !cam.noClip) {
              const k = updateSector(map, cam.x, cam.y, cam.sectNum);
              if (k === -1 || (k === s.sectNum && cam.sectNum !== s.sectNum)) {
                cam.x = s.x; cam.y = s.y; cam.sectNum = s.sectNum;
                if (fx.quickKill) fx.quickKill();
              }
            }
            if (cam.sectNum === s.sectNum) { cam.x += l; cam.y += x; }
          }
          for (const spr of map.sprites) {
            if (spr.removed || spr.sectNum !== s.sectNum) continue;
            if (spr.picNum === TILE.SECTOREFFECTOR || spr.picNum === LOCATORS) continue;
            spr.x += l; spr.y += x;
          }
          ms(map, fx, i);
          { const sn = updateSector(map, s.x, s.y, s.sectNum); if (sn >= 0) s.sectNum = sn; }   // setsprite
          if (cam && low && !cam.noClip) {
            const k = updateSector(map, cam.x, cam.y, cam.sectNum);
            if (k === -1 || (k === s.sectNum && cam.sectNum !== s.sectNum)) {
              cam.x = s.x; cam.y = s.y; cam.sectNum = s.sectNum;
              if (fx.quickKill) fx.quickKill();
            }
          }
          active++; moved++;
        }
        break;
      }

      case SE.SUBWAY:
      case SE.SUBWAY_CAR: {
        // actors.c 5126, SE 6 and 14: the subway. The sector's extra is the
        // speed k. SE 6: t[4] is a slowdown (set to k at a locator with an odd
        // hitag): counting down, the first eighth of it brakes k>>5 a tic,
        // the middle stands, the last accelerates back, then xvel = k. Its
        // cars (SE 14, same hitag and T1) take its xvel, nudged by their
        // drift from the distance they had at the start (t[5]), and share
        // its slowdown. Then (both): owner is the next LOCATOR of index t[3]
        // in the plain sector T1 — within 1024 of it, t[3]++ (wrapping to
        // 0). Moving: the angle turns toward it by an eighth of the
        // difference (t[2] keeps the sum), at full speed the sound runs
        // (a sector under the sky is the space shuttle: it fires RPGs at a
        // player within 20480 one tic in eight instead); under 108<<8 high
        // and at 192+, a player found in the car who was not in it before is
        // crushed, and badguys in the locator sector caught inside are
        // gibbed. Everyone in the sector rides: rotated by the turn about the
        // sprite and moved with it, then the walls (ms).
        const sec = map.sectors[s.sectNum];
        if (!sec) break;
        const k = sec.extra ?? 0;
        let q = 0;
        if (s.lotag === SE.SUBWAY) {
          if (t[4] > 0) {
            t[4]--;
            if (t[4] >= (k - (k >> 3))) s.xVel -= (k >> 5);
            if (t[4] > ((k >> 1) - 1) && t[4] < (k - (k >> 3))) s.xVel = 0;
            if (t[4] < (k >> 1)) s.xVel += (k >> 5);
            if (t[4] < ((k >> 1) - (k >> 3))) { t[4] = 0; s.xVel = k; }
          } else s.xVel = k;
          for (const j of fx.list) {
            const c = map.sprites[j];
            if (!c || c.removed || c.lotag !== SE.SUBWAY_CAR || c.hitag !== s.hitag) continue;
            const ct = fx.temp(j);
            if (ct[0] !== t[0]) continue;
            c.xVel = s.xVel;
            if (ct[5] === 0) ct[5] = findDistance3D(c.x - s.x, c.y - s.y, (c.z - s.z) >> 4);
            let x = Math.sign(findDistance3D(c.x - s.x, c.y - s.y, (c.z - s.z) >> 4) - ct[5]);
            if (c.extra) x = -x;
            s.xVel += x;
            ct[4] = t[4];
          }
        }
        if (s.owner === -1) s.owner = locateLocator(map, t[3], t[0]);
        if (s.owner === -1) { fx.warnings.push(`SE ${s.lotag} #${i}: no locators for hitag ${t[3]}`); break; }
        {
          const o = map.sprites[s.owner];
          if (ldist(o, s) < 1024) {
            if (s.lotag === SE.SUBWAY && (o.hitag & 1)) t[4] = sec.extra ?? 0;   // slow it down
            t[3]++;
            s.owner = locateLocator(map, t[3], t[0]);
            if (s.owner === -1) { t[3] = 0; s.owner = locateLocator(map, 0, t[0]); }
            if (s.owner === -1) break;
          }
        }
        if (s.xVel) {
          const o = map.sprites[s.owner];
          const want = getAngle(fx.radarang, o.x - s.x, o.y - s.y);
          q = incAngle(s.ang, want) >> 3;
          t[2] += q;
          s.ang = (s.ang + q) & 2047;
          const sky = (sec.floorStat & 1) || (sec.ceilingStat & 1);
          if (s.xVel === (sec.extra ?? 0)) {
            if (!sky) { if (fx.subwaySoundStart && !fx.subwaySound.get(i)) { fx.subwaySound.set(i, fx.subwaySoundStart(s.sectNum, i)); } }
            else if (sec.floorPal === 0 && (sec.floorStat & 1) && rnd(fx, 8) && cam && fx.shoot) {
              const x = Math.abs(cam.x - s.x) + Math.abs(cam.y - s.y) + (Math.abs(cam.z - s.z + (28 << 8)) >> 4);
              if (x < 20480) { const a = s.ang; s.ang = getAngle(fx.radarang, s.x - cam.x, s.y - cam.y); fx.shoot(i, 2605); s.ang = a; }
            }
          }
          if (s.xVel <= 64 && !sky && fx.subwaySound.get(i)) { fx.subwaySoundStop?.(fx.subwaySound.get(i)); fx.subwaySound.set(i, null); }
          const low = (sec.floorZ - sec.ceilingZ) < (108 << 8);
          const crush = () => {
            if (!cam || !low || cam.noClip || s.xVel < 192) return;
            const kk = updateSector(map, cam.x, cam.y, cam.sectNum);
            if (kk === -1 || (kk === s.sectNum && cam.sectNum !== s.sectNum)) {
              cam.x = s.x; cam.y = s.y; cam.sectNum = s.sectNum;
              if (fx.quickKill) fx.quickKill();
            }
          };
          crush();
          const m = (s.xVel * bsin(s.ang + 512)) >> 14;
          const x = (s.xVel * bsin(s.ang)) >> 14;
          if (cam && cam.sectNum === s.sectNum && (map.sectors[cam.sectNum].lotag & LOTAG_MASK) !== 2) {
            const r = rotatePoint(s.x, s.y, cam.x, cam.y, q);
            cam.x = r.x + m; cam.y = r.y + x;
            cam.ang = (cam.ang + q) & 2047;
          }
          for (const spr of map.sprites) {
            if (spr.removed || spr.sectNum !== s.sectNum) continue;
            if (spr.picNum === TILE.SECTOREFFECTOR || spr.picNum === LOCATORS) continue;
            if ((map.sectors[spr.sectNum].lotag & LOTAG_MASK) === 2) continue;
            const r = rotatePoint(s.x, s.y, spr.x, spr.y, q);
            spr.x = r.x + m; spr.y = r.y + x;
            spr.ang = (spr.ang + q) & 2047;
          }
          ms(map, fx, i);
          { const sn = updateSector(map, s.x, s.y, s.sectNum); if (sn >= 0) s.sectNum = sn; }
          crush();
          if (low && s.xVel >= 192 && fx.squishActor) {
            const ow = map.sprites[s.owner];
            for (let j = 0; j < map.sprites.length; j++) {
              const b = map.sprites[j];
              if (b.removed || b.sectNum !== ow.sectNum || b.picNum === TILE.SECTOREFFECTOR || b.picNum === LOCATORS) continue;
              if (!fx.isBadguy || !fx.isBadguy(j)) continue;
              const kk = updateSector(map, b.x, b.y, b.sectNum);
              if (b.extra >= 0 && kk === s.sectNum) fx.squishActor(j, i);
            }
          }
          active++; moved++;
        }
        break;
      }

      case SE.WARP_ELEVATOR: {
        // actors.c 6129, SE 17: t[0] is the direction (-1 down, 1 up, 0
        // still), q = t[0]*(yvel<<2) a tic on floor and ceiling and on
        // everyone in the sector (the player's z too). Moving: within yvel
        // of T3 (the stopping floor) it stops (activatewarpelevators 0);
        // going down past T4 or up past T5, and once (t[1]), it looks for
        // the SE 17 of the same hitag whose sector's hitag is this sector's
        // hitag - t[0] — the next floor — and warps everything in the
        // sector there: player and sprites keep their offset from the
        // sprite and their height above the floor.
        const sec = map.sectors[s.sectNum];
        if (!sec) break;
        const q = t[0] * (s.yVel << 2);
        if (!q) break;
        sec.ceilingZ += q; sec.floorZ += q;
        if (cam && cam.sectNum === s.sectNum) cam.z += q;
        for (const spr of map.sprites) {
          if (spr.removed || spr.sectNum !== s.sectNum) continue;
          if (spr.picNum !== TILE.SECTOREFFECTOR) spr.z += q;
        }
        active++; moved++;
        if (Math.abs(sec.floorZ - t[2]) <= s.yVel) { activateWarpElevators(map, fx, i, 0); break; }
        if (t[0] === -1) { if (sec.floorZ > t[3]) break; }
        else if (sec.ceilingZ < t[4]) break;
        if (t[1] === 0) break;
        t[1] = 0;
        let j = -1;
        for (const jj of fx.list) {
          const o = map.sprites[jj];
          if (jj !== i && o && !o.removed && o.lotag === SE.WARP_ELEVATOR && o.hitag === s.hitag
              && (sec.hitag - t[0]) === map.sectors[o.sectNum].hitag) { j = jj; break; }
        }
        if (j === -1) break;
        const o = map.sprites[j], osec = map.sectors[o.sectNum];
        if (cam && cam.sectNum === s.sectNum) {
          cam.x += o.x - s.x; cam.y += o.y - s.y;
          cam.z = osec.floorZ - (sec.floorZ - cam.z);
          cam.sectNum = o.sectNum;
        }
        for (const spr of map.sprites) {
          if (spr.removed || spr.sectNum !== s.sectNum || spr.picNum === TILE.SECTOREFFECTOR) continue;
          spr.x += o.x - s.x; spr.y += o.y - s.y;
          spr.z = osec.floorZ - (sec.floorZ - spr.z);
          spr.sectNum = o.sectNum;
        }
        // DEVIATION, named. In the source every car of the hitag moves in
        // lockstep and stops only when one of them is back within yvel of
        // its own stopping floor (T3) — but all of them start there and
        // move AWAY from it, so read literally nothing ever stops: after
        // the warp the player would ride the destination car down for ever.
        // Whatever makes it stop in Duke I could not find in
        // actors.c/sector.c, so here the arrival is the stop: at the warp
        // the destination is snapped back to its stopping floor with its
        // passengers on it, and every car of the hitag halts
        // (activatewarpelevators 0). To be compared with the original at
        // the router.
        {
          const dz = fx.temp(j)[2] - osec.floorZ;
          osec.floorZ += dz; osec.ceilingZ += dz;
          if (cam && cam.sectNum === o.sectNum) cam.z += dz;
          for (const spr of map.sprites) if (!spr.removed && spr.sectNum === o.sectNum && spr.picNum !== TILE.SECTOREFFECTOR) spr.z += dz;
          const sz = t[2] - sec.floorZ;
          sec.floorZ += sz; sec.ceilingZ += sz;
          for (const spr of map.sprites) if (!spr.removed && spr.sectNum === s.sectNum && spr.picNum !== TILE.SECTOREFFECTOR) spr.z += sz;
          activateWarpElevators(map, fx, i, 0);
        }
        break;
      }

      case SE.PISTON: {
        // actors.c 1552, SE 25: while t[4]: the sprite's shade is the
        // direction — at the floor (ceilingz >= floorz) it turns to 0 (up),
        // at the top (ceilingz <= T4) to 1 (down); the ceiling moves yvel<<4
        // a tic, clamped to the floor going down and to T4 going up.
        if (!t[4]) break;
        const sec = map.sectors[s.sectNum];
        if (!sec) break;
        if (sec.floorZ <= sec.ceilingZ) s.shade = 0;
        else if (sec.ceilingZ <= t[3]) s.shade = 1;
        if (s.shade) {
          sec.ceilingZ += s.yVel << 4;
          if (sec.ceilingZ > sec.floorZ) sec.ceilingZ = sec.floorZ;
        } else {
          sec.ceilingZ -= s.yVel << 4;
          if (sec.ceilingZ < t[3]) sec.ceilingZ = t[3];
        }
        active++; moved++;
        break;
      }

      case SE.STRETCH_BRIDGE: {
        // actors.c 1491, SE 20: t[0] 0 idle, 1 out (xvel 8), 2 back (-8).
        // Each tic the sprite steps xvel along its angle and t[3] keeps the
        // distance out; at t[3] <= 0 (home) or t[3]>>6 >= yvel>>6 (the
        // sector's speed is the LENGTH, in 64s) the step is undone and it
        // stops, with the door sound. Otherwise every non-effector sprite at
        // rest in the sector rides along (and falls if the floor is sloped),
        // the two leading points (t[1], t[2]) are dragged, a player on the
        // ground in the sector is carried, and the floor and ceiling panning
        // scroll by a step>>3 so the texture stays put under your feet.
        if (t[0] === 0) break;
        s.xVel = t[0] === 1 ? 8 : -8;
        const x = (s.xVel * bsin(s.ang + 512)) >> 14;
        const l = (s.xVel * bsin(s.ang)) >> 14;
        t[3] += s.xVel;
        s.x += x;
        s.y += l;
        if (t[3] <= 0 || (t[3] >> 6) >= (s.yVel >> 6)) {
          s.x -= x;
          s.y -= l;
          t[0] = 0;
          if (fx.callsound) fx.callsound(s.sectNum, i);
          break;
        }
        for (const spr of map.sprites) {
          if (spr.removed || spr.sectNum !== s.sectNum || spr.picNum === TILE.SECTOREFFECTOR || spr.zVel !== 0) continue;
          spr.x += x;
          spr.y += l;
        }
        dragPoint(map, t[1], map.walls[t[1]].x + x, map.walls[t[1]].y + l);
        dragPoint(map, t[2], map.walls[t[2]].x + x, map.walls[t[2]].y + l);
        if (cam && cam.sectNum === s.sectNum && onGround) {
          cam.x += x;
          cam.y += l;
        }
        const sec = map.sectors[s.sectNum];
        if (sec) {
          sec.floorXPanning = ((sec.floorXPanning ?? 0) - (x >> 3)) & 255;
          sec.floorYPanning = ((sec.floorYPanning ?? 0) - (l >> 3)) & 255;
          sec.ceilingXPanning = ((sec.ceilingXPanning ?? 0) - (x >> 3)) & 255;
          sec.ceilingYPanning = ((sec.ceilingYPanning ?? 0) - (l >> 3)) & 255;
        }
        active++; moved++;
        break;
      }

      case SE.DOOR_LIGHT:
      case SE.DOOR_LIGHT_INVERTED: {
        const sec = map.sectors[s.sectNum];
        if (!sec || !anims) break;
        // "work only if its moving" — the comment is Build's. The light rides
        // the door: it only changes while an animation is running on THIS
        // sector's ceiling, so the room brightens exactly as long as the door
        // takes and then holds.
        let running = false;
        if (t[4]) {
          t[4]++;
          if (t[4] > 8) { s.removed = true; break; }
          running = true;                    // an exploded one runs for 8 tics
        } else {
          running = anims.find(s.sectNum, 'ceilingZ') >= 0;
        }
        if (!running) break;

        // Which way: the sector's state bit says whether the door is opening
        // or closing, and lotag 9 is the same light wired backwards.
        let x = ((sec.lotag & LOTAG_STATE_BIT) || t[4]) ? -t[3] : t[3];
        if (s.lotag === SE.DOOR_LIGHT_INVERTED) x = -x;

        // Every light of the SAME lotag and hitag moves together — one door
        // can light a row of rooms, and each keeps its own caps.
        for (const j of fx.list) {
          const lamp = map.sprites[j];
          if (lamp.lotag !== s.lotag || lamp.hitag !== s.hitag) continue;
          const sn = map.sectors[lamp.sectNum];
          if (!sn) continue;
          const lt = fx.temp(j);
          // The sprite's own shade is the bright end; the shades captured at
          // spawn are the dark end. A light cannot brighten past what the
          // mapper put on the sprite.
          const m = lamp.shade;

          for (let w = sn.wallPtr; w < sn.wallPtr + sn.wallNum; w++) {
            const wal = map.walls[w];
            if (wal.hitag === 1) continue;
            wal.shade += x;
            if (wal.shade < m) wal.shade = m;
            else if (wal.shade > lt[2]) wal.shade = lt[2];
            if (wal.nextWall >= 0 && map.walls[wal.nextWall].hitag !== 1) {
              map.walls[wal.nextWall].shade = wal.shade;
            }
          }

          sn.floorShade += x;
          sn.ceilingShade += x;
          if (sn.floorShade < m) sn.floorShade = m;
          else if (sn.floorShade > lt[0]) sn.floorShade = lt[0];
          if (sn.ceilingShade < m) sn.ceilingShade = m;
          else if (sn.ceilingShade > lt[1]) sn.ceilingShade = lt[1];
        }
        moved++;
        break;
      }

      case SE.PIVOT:
        // actors.c 5108: `case 1: //Nothing for now used as the pivot`. The
        // first tic sets owner = self, then walks the effector list for an
        // SE 19 with the same hitag and, if one exists, sets t[0] = 0 — the
        // spawn gave it 1 (game.c 4888). SE 19 is not implemented and no level
        // so far places one, so that reset is not reproduced; the first level
        // with an SE 19 needs it, or its rotators turn before being shot.
        if (s.owner === -1) s.owner = i;
        break;

      case SE.SWING_DOOR: {
        // t[2] the angle ms() turns the sector by, t[3] the direction (+/-2),
        // t[4] the progress AND the running flag, t[5] a delay.
        //
        // The delay is decremented before the running test, so it ticks on an
        // idle door too.
        if (t[5] > 0) { t[5]--; active++; break; }
        if (!t[4]) break;
        active++;

        // actors.c 5889: before each step every wall of the door is tried
        // against the live badguys (clipinsidebox 256: the door just waits
        // this tic) and the player (144: the step is taken BACK, t[5] = 8 —
        // the door stops against you).
        {
          const sc = map.sectors[s.sectNum];
          let blocked = 0;
          const bad = fx.liveBadguys ? fx.liveBadguys() : [];
          for (let j = sc.wallPtr; j < sc.wallPtr + sc.wallNum && !blocked; j++) {
            for (const b of bad) {
              const q = map.sprites[b];
              if (q && clipInsideBox(map, q.x, q.y, j, 256) === 1) { blocked = 1; break; }
            }
            if (blocked) break;
            if (cam && clipInsideBox(map, Math.round(cam.x), Math.round(cam.y), j, 144) === 1) {
              t[5] = 8;
              const kb = (s.yVel >> 3) * t[3];
              t[2] -= kb;
              t[4] -= kb;
              ms(map, fx, i);
              moved++;
              blocked = 2;
            }
          }
          if (blocked) { fx.swingBlocked = (fx.swingBlocked ?? 0) + 1; break; }
        }

        // SP is s->yvel, i.e. the sector's own speed, exactly as for the doors.
        const k = (s.yVel >> 3) * t[3];
        t[2] += k;
        t[4] += k;
        ms(map, fx, i);
        moved++;

        // -511 and 512 are not a typo and not a tolerance. The operator starts
        // the accumulator at +1 in BOTH directions (sector.c writes T5 = 1, not
        // -1), so an opening door needs to reach 512 and a closing one -511 for
        // the two to take the same number of frames. At the default speed that
        // is eight frames of 64 either way, a clean quarter turn.
        if (t[4] <= -511 || t[4] >= 512) {
          t[4] = 0;
          t[2] &= 0xffffff00;   // snap off the leftover +1, to a multiple of 256
          ms(map, fx, i);
        }
        break;
      }

      case SE.DROP_FLOOR: {
        // t[0] running, t[1] home height, t[2] phase (0 out, 1 back),
        // t[3] a delay reloaded from the sprite's hitag at each end. SP is
        // s->yvel, so the step per frame is the sector's own speed.
        //
        // The two destinations are the sprite's z and the floor's height at
        // level load; `ang == 1536` only chooses which one it heads for first.
        // Setup has already moved the floor to the sprite for the other case,
        // so a level opens with these already extended.
        if (t[0] !== 1) break;
        active++;
        if (t[3] > 0) { t[3]--; break; }
        const sec = map.sectors[s.sectNum];
        const SP = s.yVel;
        const at1536 = (s.ang & 2047) === 1536;
        // Written out branch by branch rather than folded into one goal, which
        // is how it was first done here. Three of the four move toward their
        // destination, and the fourth takes its DIRECTION from `sgn(s->z-t[1])`
        // — the two ends, not the current height. They agree while the floor is
        // where setup left it and the folded version quietly did not say so.
        let goal, dir;
        if (t[2] === 1) {
          goal = s.ang !== 1536 ? s.z : t[1];
          dir = Math.sign(goal - sec.floorZ);
        } else if (at1536) {
          goal = s.z;
          dir = Math.sign(s.z - sec.floorZ);
        } else {
          goal = t[1];
          dir = -Math.sign(s.z - t[1]);
        }
        if (Math.abs(sec.floorZ - goal) < SP) {
          sec.floorZ = goal;
          t[2] = t[2] === 1 ? 0 : 1;
          t[0] = 0;
          t[3] = s.hitag;
        } else {
          const l = dir * SP;
          sec.floorZ += l;
          carrySprites(map, fx, s.sectNum, l);
        }
        moved++;
        break;
      }

      case SE.DROP_CEILING: {
        // The same shape without the delay, and with a threshold of SP<<1
        // rather than SP — Build's, and not obviously deliberate, but a
        // ceiling that overshoots by one step and turns round is worse than
        // one that stops a step early.
        if (t[0] !== 1) break;
        active++;
        const sec = map.sectors[s.sectNum];
        const SP = s.yVel;
        if (t[2] === 1) {
          const goal = s.ang !== 1536 ? s.z : t[1];
          if (Math.abs(sec.ceilingZ - goal) < (SP << 1)) {
            sec.ceilingZ = goal; t[2] = 0; t[0] = 0;
          } else sec.ceilingZ += Math.sign(goal - sec.ceilingZ) * SP;
        } else if ((s.ang & 2047) === 1536) {
          if (Math.abs(sec.ceilingZ - s.z) < (SP << 1)) {
            t[0] = 0; t[2] = t[2] ? 0 : 1; sec.ceilingZ = s.z;
          } else sec.ceilingZ += Math.sign(s.z - sec.ceilingZ) * SP;
        } else {
          // Note: this arm does NOT snap the ceiling to t[1] when it arrives,
          // where its opposite number does snap to s->z. Build's asymmetry, so
          // a ceiling can come to rest up to SP<<1 short of its home height.
          if (Math.abs(sec.ceilingZ - t[1]) < (SP << 1)) {
            t[0] = 0; t[2] = t[2] ? 0 : 1;
          } else sec.ceilingZ -= Math.sign(s.z - t[1]) * SP;
        }
        moved++;
        break;
      }

      case SE.RANDOM_LIGHT: {
        // actors.c 5592: nothing until T5 is set (a shot wall light of this
        // hitag). Then, one tic in eight (global_random / (hitag+1) & 31 < 4)
        // and while T3 is 0, the light comes ON — the sector's own pals and
        // the sprite's shade plus 0..15 — otherwise it is OFF: the sprite's
        // pal and the darkest wall shade the shot found (T4). The walls
        // follow, except those tagged 1, with translucent walls' backs.
        const sec = map.sectors[s.sectNum];
        if (!sec || !t[4]) break;
        const gr = fx.globalRandom;                 // drawn once a tic, above
        if (((Math.trunc(gr / ((s.hitag & 0xffff) + 1))) & 31) < 4 && !t[2]) {
          sec.ceilingPal = s.owner >> 8;
          sec.floorPal = s.owner & 0xff;
          t[0] = s.shade + (gr & 15);
        } else {
          sec.ceilingPal = s.pal;
          sec.floorPal = s.pal;
          t[0] = t[3];
        }
        sec.ceilingShade = t[0];
        sec.floorShade = t[0];
        for (let w = sec.wallPtr; w < sec.wallPtr + sec.wallNum; w++) {
          const wl = map.walls[w];
          if (wl.hitag === 1) continue;
          wl.shade = t[0];
          if ((wl.cstat & 2) && wl.nextWall >= 0) map.walls[wl.nextWall].shade = wl.shade;
        }
        active++;
        break;
      }
      case SE.EXPLOSION: {
        // actors.c 6000: once set off (t[2] > 0), the planes run to their
        // open heights at (xrepeat<<5)|1 a tic — one plane at ang 512 (the
        // one by owner), both otherwise. On the first tic (t[3] == 1) the
        // parallax comes back and, at ang 512, the walls and floor take the
        // sprite's shade. After 256 tics the effector is gone.
        const sec = map.sectors[s.sectNum];
        if (!sec || !t[2]) break;
        // `(SP<<5)|1`: SP is sprite[i].yvel, which spawn() loads with the
        // SECTOR's extra — the speed field every effector reads. (Not the
        // sprite's xrepeat, which spawn() zeroes on every effector.)
        const j = ((sec.extra ?? 0) << 5) | 1;
        const toward = (cur, goal) => (Math.abs(goal - cur) >= j ? cur + Math.sign(goal - cur) * j : goal);
        if (s.ang === 512) {
          if (s.owner) sec.ceilingZ = toward(sec.ceilingZ, t[0]);
          else sec.floorZ = toward(sec.floorZ, t[1]);
        } else {
          sec.floorZ = toward(sec.floorZ, t[1]);
          sec.ceilingZ = t[0];
        }
        if (t[3] === 1) {
          t[3]++;
          sec.ceilingStat ^= 1;
          if (s.ang === 512) {
            for (let w = sec.wallPtr; w < sec.wallPtr + sec.wallNum; w++) map.walls[w].shade = s.shade;
            sec.floorShade = s.shade;
          }
        }
        t[2]++;
        if (t[2] > 256) { s.removed = true; }
        moved++; active++;
        break;
      }
      case SE.BOSS_ROTATOR: {
        // actors.c 763, SE 5. A player within 8192 is shot at (FIRELASER,
        // the sprite turned to face him for the shot only). Without a target
        // (owner -1) it picks the LOCATORS sprite nearest the player (any
        // sector, lotags 0,1,2… until one is missing) and sets zvel toward
        // its height, 16 a tic. Within 1024 of it, owner goes back to -1.
        // Otherwise xvel 256, the angle turns an eighth toward the target,
        // and the wall rotation t[2] either follows (1 in 8, ceiling shade
        // 127) or turns a quarter toward the player (ceiling shade 0). Hit
        // five times, it starts to sink (zvel += 1024, quote 7). The sprite,
        // its ceiling and the locator sector's ceiling all move by zvel.
        const sec = map.sectors[s.sectNum];
        if (!sec) break;
        active++;
        if (cam) {
          const x = findDistance2D(s.x - cam.x, s.y - cam.y);
          if (x < 8192 && fx.shoot) {
            const a = s.ang;
            s.ang = getAngle(fx.radarang, s.x - cam.x, s.y - cam.y);
            fx.shoot(i, FIRELASER);
            s.ang = a;
          }
        }
        if (s.owner === -1) {
          t[4] = 0;
          let l = 0x7fffffff, q = -1;
          for (;;) {
            const o = locateLocator(map, t[4], -1);
            if (o === -1) break;
            const m = cam ? ldist(cam, map.sprites[o]) : 0;
            if (l > m) { q = o; l = m; }
            t[4]++;
          }
          s.owner = q;
          if (q >= 0) s.zVel = Math.sign(map.sprites[q].z - s.z) << 4;
        }
        const tgt = map.sprites[s.owner];
        if (!tgt) break;
        if (ldist(tgt, s) < 1024) { s.owner = -1; break; }
        s.xVel = 256;
        const x = getAngle(fx.radarang, tgt.x - s.x, tgt.y - s.y);
        const q = incAngle(s.ang, x) >> 3;
        s.ang = (s.ang + q) & 2047;
        if (rnd(fx, 32)) { t[2] += q; sec.ceilingShade = 127; }
        else {
          if (cam) t[2] += incAngle(t[2] + 512, getAngle(fx.radarang, cam.x - s.x, cam.y - s.y)) >> 2;
          sec.ceilingShade = 0;
        }
        if (fx.ifHit && fx.ifHit(i) >= 0) {
          t[3]++;
          if (t[3] === 5) { s.zVel += 1024; if (fx.quote) fx.quote(7); }
        }
        s.z += s.zVel;
        sec.ceilingZ += s.zVel;
        if (map.sectors[t[0]]) map.sectors[t[0]].ceilingZ += s.zVel;
        ms(map, fx, i);
        { const sn = updateSector(map, s.x, s.y, s.sectNum); if (sn >= 0) s.sectNum = sn; }   // setsprite
        moved++;
        break;
      }

      case SE.REACTOR: {
        // actors.c 1170, SE 16. The walls turn 32 a tic (t[2], through ms).
        // Ceiling at or below the floor: it rises (shade 0 → -512 a tic).
        // Above its mapped height (t[3]): if no REACTOR/REACTOR2 is left in
        // the sector the effector dies, else it drops (shade 1 → +1024).
        const sec = map.sectors[s.sectNum];
        if (!sec) break;
        t[2] += 32;
        if (sec.floorZ < sec.ceilingZ) s.shade = 0;
        else if (sec.ceilingZ < t[3]) {
          const any = map.sprites.some((o) => !o.removed && o.sectNum === s.sectNum && (o.picNum === REACTOR_TILE || o.picNum === REACTOR2_TILE));
          if (!any) { s.removed = true; break; }
          s.shade = 1;
        }
        if (s.shade) sec.ceilingZ += 1024; else sec.ceilingZ -= 512;
        ms(map, fx, i);
        moved++; active++;
        break;
      }

      case SE.ELEVATOR_STEP: {
        // actors.c 1318, SE 18. Toggled by an activator (t[0]). With a pal the
        // plane goes BACK to T2 (ceiling up / floor down); without, it goes to
        // the sprite's z (ceiling down / floor up). A moving floor carries the
        // player standing on it and the sprites at rest in the sector. Reaching
        // the end kills the effector: a one-way trip. After hitag tics (already
        // x4) of a run, t[0] is cleared — the next activation continues.
        if (!t[0]) break;
        const sec = map.sectors[s.sectNum];
        if (!sec) break;
        active++; moved++;
        const e = sec.extra;
        const carry = (dz) => {
          if (cam && onGround && cam.sectNum === s.sectNum) cam.z += dz;
          for (const o of map.sprites) {
            if (o.removed || o.sectNum !== s.sectNum || o.picNum === TILE.SECTOREFFECTOR || o.picNum === APLAYER_TILE || o.zVel) continue;
            o.z += dz;
          }
        };
        let done = false;
        if (s.pal) {
          if (s.ang === 512) { sec.ceilingZ -= e; if (sec.ceilingZ <= t[1]) { sec.ceilingZ = t[1]; done = true; } }
          else { sec.floorZ += e; carry(e); if (sec.floorZ >= t[1]) { sec.floorZ = t[1]; done = true; } }
        } else {
          if (s.ang === 512) { sec.ceilingZ += e; if (sec.ceilingZ >= s.z) { sec.ceilingZ = s.z; done = true; } }
          else { sec.floorZ -= e; carry(-e); if (sec.floorZ <= s.z) { sec.floorZ = s.z; done = true; } }
        }
        if (done) { s.removed = true; break; }
        t[2]++;
        if (t[2] >= s.hitag) { t[2] = 0; t[0] = 0; }
        break;
      }

      case SE.SHIELD: {
        // actors.c 1399, SE 19. Until hit, an EXPLOSION2 in the sector
        // (ifhitsectors) sets it off: quote 8, the SE 0s of the hitag take
        // their pivot's shade and pal, and every SE 1/12/19 of the hitag is
        // started (t[0] = 1, owner = this). Started: the first tic strips
        // the BIGFORCE walls of the sector (overpic and blocking bits, both
        // sides); then the ceiling drops by yvel a tic to the floor, where
        // the SE 0s take this sector's pivot's floor shade/pal, their pivots
        // are stopped for good (t[0] = 2) and the effector dies.
        const sec = map.sectors[s.sectNum];
        if (!sec) break;
        const sh = s.hitag;
        if (t[0]) {
          active++; moved++;
          if (t[0] === 1) {
            t[0]++;
            for (let w = sec.wallPtr; w < sec.wallPtr + sec.wallNum; w++) {
              const wl = map.walls[w];
              if (wl.overPicNum !== BIGFORCE) continue;
              wl.cstat &= 128 + 32 + 8 + 4 + 2;
              wl.overPicNum = 0;
              if (wl.nextWall >= 0) { map.walls[wl.nextWall].overPicNum = 0; map.walls[wl.nextWall].cstat &= 128 + 32 + 8 + 4 + 2; }
            }
          }
          if (sec.ceilingZ < sec.floorZ) sec.ceilingZ += s.yVel;
          else {
            sec.ceilingZ = sec.floorZ;
            for (const j of fx.list) {
              const o = map.sprites[j];
              if (!o || o.removed || o.lotag !== 0 || o.hitag !== sh) continue;
              const piv = map.sprites[o.owner];
              const osec = map.sectors[o.sectNum];
              if (piv && osec) {
                const q = map.sectors[piv.sectNum];
                osec.floorPal = osec.ceilingPal = q.floorPal;
                osec.floorShade = osec.ceilingShade = q.floorShade;
                fx.temp(o.owner)[0] = 2;
              }
            }
            s.removed = true;
          }
        } else if (map.sprites.some((o) => !o.removed && o.picNum === EXPLOSION2_TILE && o.sectNum === s.sectNum)) {
          if (fx.quote) fx.quote(8);
          for (const l of fx.list) {
            const o = map.sprites[l];
            if (!o || o.removed) continue;
            const x = o.lotag & 0x7fff;
            if (x === 0) {
              if (o.hitag === sh) {
                const osec = map.sectors[o.sectNum], piv = map.sprites[o.owner];
                if (osec && piv) { osec.floorShade = osec.ceilingShade = piv.shade; osec.floorPal = osec.ceilingPal = piv.pal; }
              }
            } else if (x === 1 || x === 12 || x === 19) {
              if (sh === o.hitag && fx.temp(l)[0] === 0) { fx.temp(l)[0] = 1; o.owner = i; }
            }
          }
        }
        break;
      }

      case SE.CASCADE: {
        // actors.c 1557, SE 21. Started by sector lotag 28 (t[0] = 1): the
        // plane (ceiling at ang 1536, else floor) will move toward the
        // sprite's z at yvel<<4 a tic — but only once the sector's extra has
        // counted down to 0: the delay that makes the cascade. Within 1024
        // it lands and the effector dies.
        if (!t[0]) break;
        const sec = map.sectors[s.sectNum];
        if (!sec) break;
        active++;
        const key = s.ang === 1536 ? 'ceilingZ' : 'floorZ';
        if (t[0] === 1) { s.zVel = Math.sign(s.z - sec[key]) * (s.yVel << 4); t[0]++; }
        if (sec.extra === 0) {
          sec[key] += s.zVel; moved++;
          if (Math.abs(sec[key] - s.z) < 1024) { sec[key] = s.z; s.removed = true; }
        } else sec.extra--;
        break;
      }

      case SE.TEETH_DOOR: {
        // actors.c 1585, SE 22. Lotag 29 set t[0] (the door's sector) and
        // t[1]. While that door's ceiling is still animating, this sector's
        // ceiling moves by its extra x9 (the sign flips with each use);
        // when the door stops, t[1] clears.
        if (!t[1]) break;
        const sec = map.sectors[s.sectNum];
        if (!sec) break;
        if (anims && anims.find(t[0], 'ceilingZ') >= 0) { sec.ceilingZ += sec.extra * 9; moved++; active++; }
        else t[1] = 0;
        break;
      }

      case SE.ESCALATOR: {
        // actors.c 1741, SE 26. xvel 32 along the angle; the shade counts the
        // steps: at 8 the sprite snaps back home (T4/T5) and the floor drops
        // back the seven steps it climbed, else the floor moves by zvel.
        // Everything in the sector (not effectors, not players) is carried by
        // the step and its zvel; a player on the floor gets the push through
        // fricX/fricY (<<5) and rides zvel. Then the walls (ms).
        const sec = map.sectors[s.sectNum];
        if (!sec) break;
        s.xVel = 32;
        const l = (s.xVel * bsin(s.ang + 512)) >> 14;
        const x = (s.xVel * bsin(s.ang)) >> 14;
        s.shade++;
        if (s.shade > 7) {
          s.x = t[3]; s.y = t[4];
          sec.floorZ -= (s.zVel * s.shade) - s.zVel;
          s.shade = 0;
        } else sec.floorZ += s.zVel;
        for (const o of map.sprites) {
          if (o.removed || o === s || o.sectNum !== s.sectNum || o.picNum === TILE.SECTOREFFECTOR || o.picNum === APLAYER_TILE) continue;
          o.x += l; o.y += x; o.z += s.zVel;
          const sn = updateSector(map, o.x, o.y, o.sectNum); if (sn >= 0) o.sectNum = sn;
        }
        if (cam && onGround && cam.sectNum === s.sectNum) {
          fricX += l << 5; fricY += x << 5;
          cam.z += s.zVel;
        }
        ms(map, fx, i);
        moved++;
        break;
      }

      case SE.DEMO_CAMERA:
        // actors.c 1793: `if(ud.recstat == 0) break;` — only while a demo
        // records or plays. There are no demos here: in play it does nothing,
        // exactly as in the original. Listed so it is not counted as missing.
        break;

      case SE.LIGHTNING: {
        // actors.c 1846, SE 28. After the delay t[5]: idle until a player
        // comes within 15500, then a strike of T2 = 64..575 tics. At T2/8
        // LIGHTNING_SLAP, at T2/2 THUNDER, at T2/4 the bolts go dark. In
        // between, one tic in two (with rnd 192) the world loses its distance
        // fade (visibility 0) for a player the sprite can see, and each
        // NATURALLIGHTNING of the hitag shows (rnd 32, with a SMALLSMOKE) —
        // burning a player within 768 of it — or is hidden. After T2, the
        // fade comes back.
        if (t[5] > 0) { t[5]--; break; }
        if (t[0] === 0) {
          if (!cam || findDistance2D(s.x - cam.x, s.y - cam.y) > 15500) break;
          t[0] = 1; t[1] = 64 + (krand(fx) & 511); t[2] = 0;
          break;
        }
        active++;
        t[2]++;
        const bolts = () => map.sprites.map((o, j) => j).filter((j) => { const o = map.sprites[j]; return !o.removed && o.picNum === NATURALLIGHTNING && o.hitag === s.hitag; });
        if (t[2] > t[1]) { t[0] = 0; fx.visibility = null; break; }
        else if (t[2] === (t[1] >> 1)) { if (fx.spriteSound) fx.spriteSound('THUNDER', i); }
        else if (t[2] === (t[1] >> 3)) { if (fx.spriteSound) fx.spriteSound('LIGHTNING_SLAP', i); }
        else if (t[2] === (t[1] >> 2)) { for (const j of bolts()) map.sprites[j].cstat |= 32768; }
        else if (t[2] > (t[1] >> 3) && t[2] < (t[1] >> 2)) {
          const seen = cam && fx.canSee ? fx.canSee(map, s.x, s.y, s.z, s.sectNum, cam.x, cam.y, cam.z, cam.sectNum) : false;
          if (rnd(fx, 192) && (t[2] & 1)) { if (seen) fx.visibility = 0; }
          else if (seen) fx.visibility = null;
          for (const j of bolts()) {
            const b = map.sprites[j];
            if (rnd(fx, 32) && (t[2] & 1)) {
              b.cstat &= 32767;
              if (fx.spawn) fx.spawn(j, SMALLSMOKE_TILE);
              if (cam && ldist(cam, b) < 768 && fx.shortCircuit) fx.shortCircuit(8 + (krand(fx) & 7));
              break;
            } else b.cstat |= 32768;
          }
        }
        break;
      }

      case SE.MIST: {
        // actors.c 1684, SE 35. While the ceiling is above the sprite's z,
        // eight puffs a tic: the angle jumps by up to 511, a SMALLSMOKE is
        // spawned and slid out at 96..223, and 1 in 16 an EXPLOSION2 too.
        // The ceiling sinks by yvel a tic (pushing the floor ahead of it) to
        // 32<<8 below the sprite, then rises by yvel<<2 back to T5.
        const sec = map.sectors[s.sectNum];
        if (!sec) break;
        active++; moved++;
        if (sec.ceilingZ > s.z) {
          for (let j = 0; j < 8; j++) {
            s.ang = (s.ang + (krand(fx) & 511)) & 2047;
            if (fx.spawnMoving) fx.spawnMoving(i, SMALLSMOKE_TILE, 96 + (krand(fx) & 127));
            if (rnd(fx, 16) && fx.spawn) fx.spawn(i, EXPLOSION2_TILE);
          }
        }
        if (t[0] === 0) {
          sec.ceilingZ += s.yVel;
          if (sec.ceilingZ > sec.floorZ) sec.floorZ = sec.ceilingZ;
          if (sec.ceilingZ > s.z + (32 << 8)) t[0]++;
        } else if (t[0] === 1) {
          sec.ceilingZ -= s.yVel << 2;
          if (sec.ceilingZ < t[4]) { sec.ceilingZ = t[4]; t[0] = 0; }
        }
        break;
      }

      case SE.GLASS_BREAK: {
        // actors.c 2178, SE 128, made by a shot GLASS wall (sector.c 1645).
        // `if(wal->cstat|32)` is always true in Duke (| for &): each tic the
        // pane becomes a masked wall again and steps its broken picture on
        // (overpicnum++, both sides) — five frames of shatter — and at the
        // end loses its masking bits (only 128|32|8|4|2 stay) and the
        // effector dies: the frame goes, the hole stays.
        const wal = map.walls[t[2]];
        if (!wal) { s.removed = true; break; }
        wal.cstat &= 255 - 32; wal.cstat |= 16;
        const nw = wal.nextWall >= 0 ? map.walls[wal.nextWall] : null;
        if (nw) { nw.cstat &= 255 - 32; nw.cstat |= 16; }
        wal.overPicNum++;
        if (nw) nw.overPicNum++;
        if (t[0] < t[1]) t[0]++;
        else {
          wal.cstat &= 128 + 32 + 8 + 4 + 2;
          if (nw) nw.cstat &= 128 + 32 + 8 + 4 + 2;
          s.removed = true;
        }
        moved++;
        break;
      }

      case SE.EXPLOSIONS_LONG:
      case SE.EXPLOSIONS_SHORT: {
        // actors.c 2206/2222, SE 130 and 131: for 80 (40) tics, one tic in
        // four (eight) a small EXPLOSION2 (2..9, 2..5) somewhere between
        // floor and ceiling, angle jittered, slid out by up to 127. Then gone.
        const long = s.lotag === SE.EXPLOSIONS_LONG;
        if (t[0] > (long ? 80 : 40)) { s.removed = true; break; }
        t[0]++;
        const sec = map.sectors[s.sectNum];
        if (!sec) break;
        active++;
        const h = sec.floorZ - sec.ceilingZ;
        if (rnd(fx, long ? 64 : 32) && fx.spawn) {
          const k = fx.spawn(i, EXPLOSION2_TILE);
          const e = map.sprites[k];
          if (e) {
            e.xRepeat = e.yRepeat = 2 + (krand(fx) & (long ? 7 : 3));
            e.z = sec.floorZ - (h > 0 ? krand(fx) % h : 0);
            e.ang = (e.ang + 256 - (krand(fx) % 511)) & 2047;
            e.xVel = krand(fx) & 127;
            if (fx.ssp) fx.ssp(k);
          }
        }
        break;
      }

      default:
        fx.skipped.set(s.lotag, (fx.skipped.get(s.lotag) ?? 0) + 1);
        break;
    }
  }
  // An effector that killed itself (SE13 after its 256 tics) leaves the
  // list, or its slot's next tenant — the first free slot goes to the next
  // makeSprite, in E1L1 a rocket's EXPLOSION2 — is run as an effector of
  // lotag 0 and vanishes the tic it is born. Duke's KILLIT unlinks the
  // sprite from its statnum list; this is that unlinking.
  for (let k = fx.list.length - 1; k >= 0; k--) { const sp = map.sprites[fx.list[k]]; if (!sp || sp.removed) fx.list.splice(k, 1); }
  return { moved, active, skipped: fx.skipped, fricX, fricY };
}

/**
 * A moving floor takes what stands on it with it.
 *
 * Build lifts the player when `on_ground`, and every sprite in the sector with
 * `zvel == 0` and a statnum outside 3 and 4 — effectors and projectiles stay
 * put. uDuke has no statnum lists, so effector sprites and anything marked
 * removed are excluded by hand; that is an approximation and the only one in
 * this file.
 */
function carrySprites(map, fx, sectNum, l) {
  for (const spr of map.sprites) {
    if (spr.sectNum !== sectNum || spr.removed) continue;
    if (spr.picNum === TILE.SECTOREFFECTOR) continue;
    if (spr.zVel !== 0) continue;
    spr.z += l;
  }
}

/**
 * A rotating sector turns its contents about the pivot, not about itself.
 *
 * Build does the player first and the sprites after, both with the same
 * rotatepoint call and the same `zchange`. The two exclusions it makes are
 * statnum 3 and 4 — effectors and projectiles — plus LASERLINE and a player's
 * own sprite; uDuke has no statnum lists, so effectors are excluded by picnum
 * and the rest do not exist yet. Same approximation as carrySprites, and for
 * the same reason.
 *
 * `dang` is passed unmasked, as in the source: rotatePoint masks it itself, and
 * the angles it is added to are masked at the point of use.
 */
function carryRotation(map, sec, sectNum, pivot, dang, zchange, cam, onGround) {
  if (cam && cam.sectNum === sectNum && onGround) {
    cam.ang = (cam.ang + dang) & 2047;
    cam.z += zchange;
    const r = rotatePoint(pivot.x, pivot.y, cam.x, cam.y, dang);
    cam.x = r.x;
    cam.y = r.y;
  }
  for (const spr of map.sprites) {
    if (spr.sectNum !== sectNum || spr.removed) continue;
    if (spr.picNum === TILE.SECTOREFFECTOR) continue;
    spr.ang = (spr.ang + dang) & 2047;
    spr.z += zchange;
    const r = rotatePoint(pivot.x, pivot.y, spr.x, spr.y, dang);
    spr.x = r.x;
    spr.y = r.y;
  }
}

/**
 * sector.c's operateactivators: what a switch actually pulls.
 *
 * ACTIVATOR sprites carry a lotag; everything sharing it fires together. For
 * each one, the effectors in ITS sector that answer to activation get their
 * running flag FLIPPED — not set — so a second pull stops a drop floor half
 * way, and then the sector itself is operated as if used.
 *
 * ACTIVATORLOCKED flips bit 16384 of its sector's lotag instead, which is how
 * Duke locks a door; nothing here reads that bit yet, so it is recorded and
 * not acted on.
 *
 * The hitag on an activator gates it: 1 means only while the sector is open
 * (floor and ceiling apart), 2 only while shut. Returns how many activators
 * fired.
 */
export function operateActivators(map, fx, anims, tag, operateSectorFn = null, ext = null) {
  let fired = 0;
  map.sprites.forEach((spr, idx) => {
    if (spr.removed || spr.lotag !== tag) return;
    if (spr.picNum !== ACTIVATOR && spr.picNum !== ACTIVATORLOCKED) return;
    const sec = map.sectors[spr.sectNum];
    if (!sec) return;

    if (spr.picNum === ACTIVATORLOCKED) {
      sec.lotag ^= LOTAG_LOCKED_BIT;
      fired++;
      return;
    }

    if (spr.hitag === 1 && sec.floorZ === sec.ceilingZ) return;
    if (spr.hitag === 2 && sec.floorZ !== sec.ceilingZ) return;

    // `if (sector[sprite[i].sectnum].lotag < 3)` — an activator sitting in a
    // sector that is itself something (a door, water) does not also poke the
    // effectors there.
    if ((sec.lotag & LOTAG_MASK) < 3) {
      for (const i of fx.list) {
        const se = map.sprites[i];
        if (se.sectNum !== spr.sectNum || !ACTIVATED_LOTAGS.has(se.lotag)) continue;
        const t = fx.temp(i);
        t[0] = 1 - t[0];
        // sector.c 1092: each toggled SE also calls the sector's sound —
        // the MUSICANDSFX (lotag = the sound) sitting with it: E1L4's
        // underwater hatch (SE 32 in 240) has one, sound 166, and it was
        // the acknowledgement Duke gives for the right dip combination.
        if (fx.callsound) fx.callsound(spr.sectNum, i);
      }
    }
    if (operateSectorFn) operateSectorFn(map, anims, spr.sectNum, ext);
    fired++;
  });
  // sector.c 1109: operaterespawns(low) closes operateactivators — the
  // RESPAWN sprites of the tag (con.js, through the page's hook).
  if (fx.operateRespawns) fx.operateRespawns(tag);
  return fired;
}

/**
 * activatebysector(), sector.c 1537: the sector's ACTIVATORs fire their tags
 * (operateactivators, no player); with none in it, operatesectors on the
 * sector itself. What an SE 10 calls to close its door. `operateSectorFn` is
 * sector.js's operateSector, handed in because sector.js is below this file.
 */
export function activateBySector(map, fx, anims, sectNum, operateSectorFn, ext = null) {
  let didit = false;
  for (const spr of map.sprites) {
    if (spr.removed || spr.sectNum !== sectNum || spr.picNum !== ACTIVATOR) continue;
    operateActivators(map, fx, anims, spr.lotag, operateSectorFn, ext);
    didit = true;
  }
  if (!didit && operateSectorFn) return !!operateSectorFn(map, anims, sectNum, ext);
  return didit;
}

/**
 * sector.c 1005, operatesectors case 27: the extend-o-bridge. The SE 20 in the
 * sector gets t[0] = 1 (out) or 2 (back) as the sector's state bit flips;
 * moveEffectors does the dragging. Returns true when an SE 20 was there.
 */
export function operateStretchBridge(map, fx, sectNum) {
  for (const j of fx.list) {
    const se = map.sprites[j];
    if ((se.lotag & 0xff) !== SE.STRETCH_BRIDGE || se.sectNum !== sectNum) continue;
    const sec = map.sectors[sectNum];
    sec.lotag ^= LOTAG_STATE_BIT;
    fx.temp(j)[0] = (sec.lotag & LOTAG_STATE_BIT) ? 1 : 2;
    return true;
  }
  return false;
}

/**
 * sector.c's operatesectors case 25, the "subway type sliding doors".
 *
 *   j = headspritestat[3];  ... find the SE with lotag 15 in this sector
 *   i = headspritestat[3];  ... every SE sharing its HITAG
 *       sector[SECT].lotag ^= 0x8000;
 *       SA += 1024;
 *       if(sector[SECT].lotag&0x8000) T5 = 1; else T5 = 2;
 *
 * Note what moves: nothing here. The operation flips a state bit, turns the SE
 * sprite around, and sets a direction; moveEffectors does the rest a frame at
 * a time. And it acts on every SE with the matching hitag, each toggling ITS
 * OWN sector — which is how the two halves of a double door move together.
 * E1L5's four SE-15 sprites are exactly two such pairs.
 *
 * Returns true when a door was found and started.
 */
export function operateSlidingDoor(map, fx, sectNum) {
  const found = fx.list.find((i) => map.sprites[i].lotag === SE.SLIDING_DOOR
    && map.sprites[i].sectNum === sectNum);
  if (found === undefined) return false;

  const hitag = map.sprites[found].hitag;
  let started = 0;
  for (const i of fx.list) {
    const s = map.sprites[i];
    if (s.hitag !== hitag || s.lotag !== SE.SLIDING_DOOR) continue;
    const sec = map.sectors[s.sectNum];
    if (!sec) continue;
    sec.lotag ^= LOTAG_STATE_BIT;
    s.ang = (s.ang + 1024) & 2047;
    fx.temp(i)[4] = (sec.lotag & LOTAG_STATE_BIT) ? 1 : 2;
    started++;
  }
  return started > 0;
}

/**
 * Duke's eye height when a transporter puts you down: `PHEIGHT (38<<8)`.
 *
 * NOT the 40<<8 that player.c seats a standing eye at. Two different numbers
 * for what looks like the same thing, 512 units apart, and a port that used one
 * for both would land you half a step low on every pad — small, permanent, and
 * exactly the sort of thing that gets blamed on the renderer later.
 */
export const TRANSPORT_HEIGHT = 38 << 8;

/**
 * actors.c's movetransports(), the player half.
 *
 * Not part of moveEffectors, because it is not part of moveeffectors: game.c
 * moves an SE 7 to statnum 9 at spawn and game.c calls this from its own place
 * in the frame, BEFORE the effectors run. Same order here.
 *
 * Two kinds, told apart by t[4] (`sector.floorz == sprite.z` at spawn):
 *
 *   a PAD you step onto      — sends you to the partner's position and ANGLE
 *   a SILENT one you pass    — shifts you by the difference between the two,
 *                              keeping your bearings, for looping corridors
 *
 * E1L5 has four of the first and one of the second.
 *
 * A third kind: the water pair. Sector lotag 1 is the surface and 2 is below it, and the same effector does
 * both directions — you dive through the surface and you surface through the
 * bottom. E1L3 has two such pairs (459/460 and 142/127); E1L5 has none, which
 * is why they were skipped when the transporters were first written.
 *
 * Not reproduced: the sprite arm, which selects by statnum — actors, weapons,
 * fallers — none of which exists here.
 *
 * `cam` is moved in place. `state` is a player state; its `transportHold`
 * is Build's `transporter_hold`, and `onWarpingSector` its `on_warping_sector`.
 * Returns the effector that fired, or -1.
 */
export function moveTransports(map, fx, cam, state, input = {}) {
  if (!cam || !state) return -1;

  // player.c decrements the hold in processinput, which Build runs after this
  // in the same frame; doing it at the top here using last tic's flag is the
  // same count, one step earlier in the tic. The reset to 2 is what stops a pad
  // from firing again while you are still standing on it.
  if (state.transportHold > 0) {
    state.transportHold--;
    if (state.transportHold === 0 && state.onWarpingSector) state.transportHold = 2;
  } else if (state.transportHold < 0) {
    state.transportHold++;
  }
  state.onWarpingSector = false;

  for (const i of fx.transports) {
    const s = map.sprites[i];
    if (!s || s.removed) continue;
    // `if(OW == i) continue;` — a 23 owns itself and is only ever a
    // destination.
    if (s.owner === i || s.owner < 0) continue;
    const partner = map.sprites[s.owner];
    if (!partner) continue;
    const sec = map.sectors[s.sectNum];
    if (!sec) continue;
    const t = fx.temp(i);
    if (t[0] > 0) t[0]--;

    if (cam.sectNum !== s.sectNum) continue;
    state.onWarpingSector = true;
    const onFloor = t[4] === 1;
    const sectLotag = sec.lotag & LOTAG_MASK;

    if (state.transportHold === 0 && (state.jumpCounter ?? 0) === 0) {
      if (state.onGround && sectLotag === 0 && onFloor) {
        cam.ang = partner.ang;
        cam.x = partner.x;
        cam.y = partner.y;
        cam.z = partner.z - TRANSPORT_HEIGHT;
        cam.sectNum = partner.sectNum;
        // Both ends get the hold, so arriving on a pad does not bounce you
        // straight back through it.
        if (partner.owner !== s.owner) {
          t[0] = 13;
          fx.temp(s.owner)[0] = 13;
          state.transportHold = 13;
        }
        return i;
      }
    } else if (!(sectLotag === 1 && state.onGround)) {
      // Held, or mid-jump: this transporter does nothing at all this tic —
      // and neither does any other, because Build breaks out of the sector
      // loop here rather than continuing.
      break;
    }

    // The water pair. Both directions in one effector, and both end in the
    // same relative shift the silent kind uses — you keep your place in the
    // room, only the depth changes.
    if (onFloor && (sectLotag === 1 || sectLotag === 2)) {
      const psec = map.sectors[partner.sectNum];
      let k = false;

      if (sectLotag === 1 && state.onGround
          && cam.z > sec.floorZ - (16 << 8)
          && (input.crouch || (state.zVel ?? 0) > 2048)) {
        // Going under. You have to be low in the water AND either crouching or
        // already falling fast — Build's `(sync.bits&2) || poszv > 2048`, which
        // is why you cannot walk into a pool by accident.
        k = true;
        // actors.c 2908: the dive stops every sound and plays DUKE_UNDERWATER
        // (for a living player); the page hears it through fx.dived.
        if (fx.dived) fx.dived();
        cam.z = psec.ceilingZ + (7 << 8);
        // `posxv = 4096-(TRAND&8192)` — the mask leaves 0 or 8192, so this is
        // +4096 or -4096 and not a spread. A shove either way as you break the
        // surface, and it uses the same krand the flickering lights draw from.
        state.xVel = 4096 - (krand(fx) & 8192);
        state.yVel = 4096 - (krand(fx) & 8192);
      } else if (sectLotag === 2 && cam.z < sec.ceilingZ + (6 << 8)) {
        // Coming up, and it hands you a jump: jumpToggle set, counter cleared,
        // which is what launches you clear of the surface rather than leaving
        // you bobbing in the ceiling.
        k = true;
        // actors.c 2927: surfacing stops every sound and gasps (DUKE_GASP).
        if (fx.surfaced) fx.surfaced();
        cam.z = psec.floorZ - (7 << 8);
        state.jumpToggle = 1;
        state.jumpCounter = 0;
      }

      if (k) {
        cam.x += partner.x - s.x;
        cam.y += partner.y - s.y;
        cam.sectNum = partner.sectNum;
        // MINUS two, and the sign matters: player.c counts a negative hold UP
        // toward zero, so a water crossing is held for two tics where a pad is
        // held for thirteen. Long enough not to bounce, short enough to dive
        // straight back down.
        if (partner.owner !== s.owner) state.transportHold = -2;
        return i;
      }
      continue;
    }

    // The silent kind. 6144 is Build's, and it is a band around the sprite's
    // own z rather than a floor test: you have to pass through the plane it
    // sits in, which is how a corridor loops without a visible seam.
    if (!onFloor && Math.abs(s.z - cam.z) < 6144) {
      cam.x += partner.x - s.x;
      cam.y += partner.y - s.y;
      // actors.c 2884: falling, `posz = OW.z + 6144`; rising under a jetpack
      // it is OW.z - 6144. No jetpack here, so the falling case.
      cam.z = partner.z + 6144;
      cam.sectNum = partner.sectNum;
      return i;
    }
  }
  return -1;
}

/**
 * sector.c's operatemasterswitches: arm every MASTERSWITCH carrying this tag.
 *
 *   if( PN == MASTERSWITCH && SLT == low && SP == 0 ) SP = 1;
 *
 * Arming is all it does. The countdown is the actor's, below.
 */
export function operateMasterSwitches(map, fx, tag) {
  let armed = 0;
  for (const i of fx.masters) {
    const s = map.sprites[i];
    if (!s || s.removed || s.lotag !== tag || s.yVel !== 0) continue;
    s.yVel = 1;
    armed++;
  }
  return armed;
}

/**
 * The MASTERSWITCH actor, actors.c 2079 — a delayed trigger.
 *
 *   if(s->yvel == 1) { s->hitag--;
 *       if(s->hitag <= 0) { operatesectors(sect,i);
 *           ...temp_data[0] = 1 on statnum-3 lotags 2/21/31/32/36 here...
 *           KILLIT(i); } }
 *
 * The hitag is the delay in tics, and E1L5 uses that to stagger: the eight
 * earthquake sectors carry 0, 24, 32, 60, 64, 96 and 128, so one switch makes
 * the room come apart in waves rather than all at once.
 *
 * Called once a tic, like the actor loop it comes from.
 */
export function moveMasterSwitches(map, fx, anims, operateSectorFn = null, ext = null) {
  let fired = 0;
  for (const i of fx.masters) {
    const s = map.sprites[i];
    if (!s || s.removed || s.yVel !== 1) continue;
    s.hitag--;
    if (s.hitag > 0) continue;

    if (operateSectorFn) operateSectorFn(map, anims, s.sectNum, ext);
    for (const j of fx.list) {
      const se = map.sprites[j];
      if (se.sectNum !== s.sectNum) continue;
      if (MASTER_LOTAGS.has(se.lotag)) fx.temp(j)[0] = 1;
      else if (se.lotag === 3) fx.temp(j)[4] = 1;             // SE3 random lights: lit (actors.c 2101)
    }
    // actors.c 2105: the tanks and ooze filters of its sector are set off
    // (shade -31 starts their countdown) — E1L1's plate behind the access
    // door blows the wall this way.
    for (const sp of map.sprites) {
      if (sp.removed || sp.sectNum !== s.sectNum) continue;
      if (sp.picNum === 1247 || sp.picNum === 1079) sp.shade = -31;
    }
    s.removed = true;
    fired++;
  }
  return fired;
}

/** The effector lotags a MASTERSWITCH starts. actors.c 2096-2101. */
const MASTER_LOTAGS = new Set([2, 21, 31, 32, 36]);

/** The sector lotag operateSlidingDoor answers to. */
export const SLIDING_DOOR_SECTOR_LOTAG = 25;
/** The sector lotag of an extend-o-bridge, operated through its SE 20. */
export const STRETCH_BRIDGE_SECTOR_LOTAG = 27;

/** True when this sector is a sliding door with an effector to drive it. */
export function isSlidingDoor(map, fx, sectNum) {
  const sec = map.sectors[sectNum];
  if (!sec || (sec.lotag & LOTAG_MASK) !== SLIDING_DOOR_SECTOR_LOTAG) return false;
  return fx.list.some((i) => map.sprites[i].lotag === SE.SLIDING_DOOR
    && map.sprites[i].sectNum === sectNum);
}

/** The sector lotag operateSwingDoor answers to. */
export const SWING_DOOR_SECTOR_LOTAG = 23;

/**
 * sector.c's operatesectors case 23, the swing doors.
 *
 * Two things here look like bugs and are reproduced anyway, because both are
 * observable and neither is a rounding question:
 *
 * The state bit `l` is sampled from the FOUND door's sector before anything is
 * flipped, and every later candidate is tested against that sample — while the
 * loop flips sectors as it goes. A second SE 11 in the SAME sector therefore
 * fails the test and does not start. Only the first one in a shared sector
 * moves.
 *
 * And `!T5` skips a door that is already swinging, so hammering the key mid
 * swing does nothing rather than reversing it. That is the difference between
 * this and the sliding door, which will happily be told to turn round.
 *
 * Returns true when a door was found and started.
 */
export function operateSwingDoor(map, fx, sectNum) {
  const j = fx.list.find((i) => map.sprites[i].lotag === SE.SWING_DOOR
    && map.sprites[i].sectNum === sectNum && !fx.temp(i)[4]);
  if (j === undefined) return false;

  const found = map.sprites[j];
  const l = map.sectors[found.sectNum].lotag & LOTAG_STATE_BIT;
  let started = 0;
  for (const i of fx.list) {
    const s = map.sprites[i];
    const sec = map.sectors[s.sectNum];
    if (!sec) continue;
    const t = fx.temp(i);
    if (l !== (sec.lotag & LOTAG_STATE_BIT)) continue;
    if (s.lotag !== SE.SWING_DOOR || s.hitag !== found.hitag || t[4]) continue;
    sec.lotag ^= LOTAG_STATE_BIT;
    t[4] = 1;         // T5: the running flag and the first unit of progress
    t[3] = -t[3];     // T4: turn round
    started++;
  }
  return started > 0;
}

/** The sector lotag operateRotateRise answers to. */
export const ROTATE_RISE_SECTOR_LOTAG = 30;

/**
 * sector.c's operatesectors case 30, the rise-and-rotate bridge.
 *
 *   j = sector[sn].hitag;
 *   if(sprite[j].extra == 1) sprite[j].extra = 3; else sprite[j].extra = 1;
 *
 * The whole operation is one toggle on the effector sprite — which is why
 * setup had to write the sprite's index into the sector's hitag, and why using
 * the bridge again half way through simply sends it back rather than stopping
 * it. The mover reads `extra` every frame and needs no state of its own beyond
 * tempang.
 */
export function operateRotateRise(map, fx, sectNum) {
  const sec = map.sectors[sectNum];
  if (!sec) return false;
  const s = map.sprites[sec.hitag];
  if (!s || s.removed || s.lotag !== SE.ROTATE_SECTOR) return false;
  s.extra = s.extra === 1 ? 3 : 1;
  return true;
}

/** game.c 3459 LocateTheLocator(n, sn): the LOCATORS sprite with lotag n in sector sn (any sector for -1). */
export function locateLocator(map, n, sn) {
  for (let j = 0; j < map.sprites.length; j++) {
    const q = map.sprites[j];
    if (!q.removed && q.picNum === LOCATORS && q.lotag === n && (sn === -1 || q.sectNum === sn)) return j;
  }
  return -1;
}

/**
 * operatesectors case 31, sector.c 572: the two-way train sets off — its
 * SE (the sector's hitag) gets t[4] = 1 if it is at rest; callsound.
 */
export function operateTwoWayTrain(map, fx, sectNum) {
  const sec = map.sectors[sectNum];
  if (!sec) return false;
  const s = map.sprites[sec.hitag];
  if (!s || s.removed || s.lotag !== SE.TWO_WAY_TRAIN) return false;
  const t = fx.temp(sec.hitag);
  if (t[4] === 0) t[4] = 1;
  if (fx.callsound) fx.callsound(sectNum, sec.hitag);
  return true;
}

/**
 * sector.c's operatesectors, for the cases that live in effectors rather than
 * in sector.js — the `ext` hook in one place instead of at every call site.
 *
 * This exists because the one-line version of it was copied into game.html,
 * index.html, gameprobe and doorprobe while there was a single case to handle.
 * Three cases across four copies is how the two halves of a project start
 * disagreeing about what a door is, which is the same argument that produced
 * boot.js.
 */
export function operateEffectorSector(map, fx, sectNum, lotag, who = null) {
  switch (lotag) {
    case SLIDING_DOOR_SECTOR_LOTAG: return operateSlidingDoor(map, fx, sectNum);
    case SWING_DOOR_SECTOR_LOTAG:   return operateSwingDoor(map, fx, sectNum);
    case ROTATE_RISE_SECTOR_LOTAG:  return operateRotateRise(map, fx, sectNum);
    case STRETCH_BRIDGE_SECTOR_LOTAG: return operateStretchBridge(map, fx, sectNum);
    case TWO_WAY_TRAIN_SECTOR_LOTAG: return operateTwoWayTrain(map, fx, sectNum);
    case WARP_ELEVATOR_SECTOR_LOTAG: return operateWarpElevator(map, fx, sectNum, who ? who.z : null, who ? who.sect : -1);
    case CASCADE_SECTOR_LOTAG: return operateCascade(map, fx, sectNum);
    case TEETH_DOOR_SECTOR_LOTAG: return armTeethDoor(map, fx, sectNum);
    default: return false;
  }
}

/** The sector lotag that starts a cascade (SE 21). */
const CASCADE_SECTOR_LOTAG = 28;
/** The teeth door: sector.js moves its ceiling, the SE 22s follow. */
const TEETH_DOOR_SECTOR_LOTAG = 29;

/**
 * sector.c 967, operatesectors case 28: the hitag of the sector's own SE 21
 * names the cascade; every SE 21 of that hitag still idle is started. A
 * sector without an SE 21 reads sprite[-1] in Build; here it does nothing.
 */
export function operateCascade(map, fx, sectNum) {
  const own = fx.list.find((i) => map.sprites[i] && (map.sprites[i].lotag & 0xff) === SE.CASCADE && map.sprites[i].sectNum === sectNum);
  if (own === undefined) return false;
  const h = map.sprites[own].hitag;
  for (const l of fx.list) {
    const o = map.sprites[l];
    if (o && !o.removed && (o.lotag & 0xff) === SE.CASCADE && fx.temp(l)[0] === 0 && o.hitag === h) fx.temp(l)[0] = 1;
  }
  if (fx.callsound) fx.callsound(sectNum, own);
  return true;
}

/**
 * sector.c 763, the SE part of operatesectors case 29: each SE 22 of the
 * sector's hitag negates its own sector's extra (the direction), remembers
 * the door (t[0]) and runs (t[1] = 1) while the door animates.
 */
export function armTeethDoor(map, fx, sectNum) {
  const sec = map.sectors[sectNum];
  if (!sec) return false;
  for (const i of fx.list) {
    const o = map.sprites[i];
    if (!o || o.removed || o.lotag !== SE.TEETH_DOOR || o.hitag !== sec.hitag) continue;
    const os = map.sectors[o.sectNum];
    if (os) os.extra = -os.extra;
    const t = fx.temp(i);
    t[0] = sectNum; t[1] = 1;
  }
  return true;
}

/**
 * True when operateEffectorSector would do something here — the effector half
 * of sector.js's isOperable, and what tells "nothing tagged in front of you"
 * from "something uDuke cannot work yet".
 */
export function isEffectorSector(map, fx, sectNum) {
  const sec = map.sectors[sectNum];
  if (!sec) return false;
  switch (sec.lotag & LOTAG_MASK) {
    case SLIDING_DOOR_SECTOR_LOTAG:
      return isSlidingDoor(map, fx, sectNum);
    case SWING_DOOR_SECTOR_LOTAG:
      return fx.list.some((i) => map.sprites[i].lotag === SE.SWING_DOOR
        && map.sprites[i].sectNum === sectNum);
    case ROTATE_RISE_SECTOR_LOTAG:
      return map.sprites[sec.hitag]?.lotag === SE.ROTATE_SECTOR;
    case TWO_WAY_TRAIN_SECTOR_LOTAG:
      return map.sprites[sec.hitag]?.lotag === SE.TWO_WAY_TRAIN;
    case WARP_ELEVATOR_SECTOR_LOTAG:
      return fx.list.some((i) => map.sprites[i].lotag === SE.WARP_ELEVATOR && map.sprites[i].sectNum === sectNum);
    case STRETCH_BRIDGE_SECTOR_LOTAG:
      return fx.list.some((i) => (map.sprites[i].lotag & 0xff) === SE.STRETCH_BRIDGE
        && map.sprites[i].sectNum === sectNum);
    case CASCADE_SECTOR_LOTAG:
      return fx.list.some((i) => (map.sprites[i].lotag & 0xff) === SE.CASCADE && map.sprites[i].sectNum === sectNum);
    default:
      return false;
  }
}

/**
 * sector.c activatewarpelevators(s, d): every SE 17 of s's hitag whose
 * sector is either not at its stopping floor (still moving) or whose
 * sector's hitag is this one's - d exists — else "no find" (returns true).
 * Found: ELEVATOR_ON (d != 0) or ELEVATOR_OFF, and every SE 17 of the
 * hitag gets t[0] = t[1] = d.
 */
export function activateWarpElevators(map, fx, s, d) {
  const sp = map.sprites[s];
  const sn = sp.sectNum;
  let found = -1;
  for (const i of fx.list) {
    const o = map.sprites[i];
    if (!o || o.removed || o.lotag !== SE.WARP_ELEVATOR || o.hitag !== sp.hitag) continue;
    if (Math.abs(map.sectors[sn].floorZ - fx.temp(s)[2]) > o.yVel || map.sectors[o.sectNum].hitag === (map.sectors[sn].hitag - d)) { found = i; break; }
  }
  if (found === -1) return true;
  if (fx.spriteSound) fx.spriteSound(d === 0 ? 'ELEVATOR_OFF' : 'ELEVATOR_ON', s);
  for (const i of fx.list) {
    const o = map.sprites[i];
    if (!o || o.removed || o.lotag !== SE.WARP_ELEVATOR || o.hitag !== sp.hitag) continue;
    const t = fx.temp(i);
    t[0] = d; t[1] = d;
  }
  return false;
}

/**
 * sector.c operatesectors case 15, the warp elevator, by the player: the
 * sector's SE 17; standing in it, down if possible else up; from outside,
 * down if the floor is below the player's eye else up.
 */
export function operateWarpElevator(map, fx, sectNum, playerZ = null, playerSect = -1) {
  let se = -1;
  for (const i of fx.list) { const o = map.sprites[i]; if (o && !o.removed && o.lotag === SE.WARP_ELEVATOR && o.sectNum === sectNum) { se = i; break; } }
  if (se < 0) return false;
  if (playerSect === sectNum || playerZ === null) {
    if (activateWarpElevators(map, fx, se, -1)) activateWarpElevators(map, fx, se, 1);
  } else if (map.sectors[sectNum].floorZ > playerZ) activateWarpElevators(map, fx, se, -1);
  else activateWarpElevators(map, fx, se, 1);
  return true;
}

/**
 * actors.c case 19, the half of it that reaches the rotators.
 *
 * A shot "Battlestar galactia shield" sector sets `temp_data[0] = 1` on every
 * SE with lotag 0, 1, 12 or 19 that shares its hitag — and when the shield
 * finishes closing, `= 2` on the pivots, which makes each SE 0 remove itself.
 * Activators, master switches and touchplates never reach a pivot; the spawn
 * does (t[0] = 1, game.c 4888 — E1L3's sectors 60/61, E2L2's 32/33 turn from
 * the start). SE 19 is the only thing that restarts or stops one later.
 *
 * SE 19 is not implemented, so this is exported rather than called; it keeps
 * the start/stop semantics tested. `state` is 1 to start and 2 to stop and
 * remove.
 */
export function startPivots(map, fx, hitag, state = 1) {
  let n = 0;
  for (const i of fx.list) {
    const s = map.sprites[i];
    // Lotags 12 and 19 are in Build's list and are not implemented, so they are
    // not in this one. Lotag 0 is deliberately absent: case 19 handles it in a
    // separate arm that only copies the pivot's shade and pal onto the sector,
    // and never touches its temp_data. The flag lives on the PIVOT alone.
    if (s.removed || s.lotag !== SE.PIVOT || s.hitag !== hitag) continue;
    const t = fx.temp(i);
    // `if(hittype[l].temp_data[0] == 0)` — starting is guarded, stopping is not.
    // Build also points the pivot's owner at the shield sprite here; nothing
    // reads that, and there is no shield to point at, so it is left alone.
    if (state === 1 && t[0] !== 0) continue;
    t[0] = state;
    n++;
  }
  return n;
}

/**
 * game.c 3364, the part of an earthquake you actually see.
 *
 *   if(earthquaketime > 0 && p->on_ground == 1) {
 *       cposz += 256-(((earthquaketime)&1)<<9);
 *       cang  += (2-((earthquaketime)&2))<<2;
 *   }
 *
 * A VIEW offset and not a move: the player's own position is untouched, which
 * is why the world stays put underfoot while the picture jolts. The z term
 * alternates +256/-256 every tic and the angle term +8/0 every two, so the
 * shake has a period of four tics and is not symmetric about zero — a
 * "nicer" symmetric one would be an invention.
 *
 * Only on the ground, as Build has it: jumping through a quake is smooth.
 *
 * Returns `{ z, ang }` to add to the camera for drawing only.
 */
export function earthquakeShake(fx, onGround) {
  if (!(fx.earthquakeTime > 0) || !onGround) return { z: 0, ang: 0 };
  return {
    z: 256 - ((fx.earthquakeTime & 1) << 9),
    ang: (2 - (fx.earthquakeTime & 2)) << 2,
  };
}

/**
 * The TOUCHPLATE actor, actors.c 2296 — a pressure plate.
 *
 * The missing link between walking around and half the effectors in a level:
 * E1L5 has 27 of them, and the one in sector 60 is the only thing that starts
 * the earthquakes. Until this existed the quakes were implemented and
 * unreachable, which is the same kind of gap as an unimplemented lotag and
 * harder to see, because nothing reports it.
 *
 *   p = checkcursectnums(sect);
 *   if( p >= 0 && ( ps[p].on_ground || s->ang == 512 ) ) {
 *       if( t[0] == 0 && !check_activator_motion(s->lotag) ) {
 *           t[0] = 1; t[1] = 1; t[3] = !t[3];
 *           operatemasterswitches(s->lotag);
 *           operateactivators(s->lotag,p);
 *           if(s->hitag > 0) { s->hitag--; if(s->hitag == 0) t[5] = 1; }
 *       }
 *   } else t[0] = 0;
 *
 * `t[0]` is "you are still standing on it", cleared the moment you step off, so
 * a plate fires once per visit rather than once per tic. `hitag` is a use
 * count: at zero it is unlimited, otherwise it counts down and `t[5]` retires
 * the plate for good — 6 of E1L5's 27 are one-shot.
 *
 * `ang == 512` is Build's "fires even in mid-air", and every plate in E1L5 is
 * at 1536 instead, so all of them want you on the ground.
 *
 * Not reproduced: the floor movement in the first half of the case (t[1]/t[3]
 * walking the plate sector's floor between T3 and the sprite's z at
 * `sector.extra` a tic) and the propagation of t[1]/t[3] to sibling plates.
 * Both are about the plate sinking under your feet; the triggering is the part
 * that makes levels work, and mixing the two in would have been a bigger
 * change than the thing it enables.
 */
export function moveTouchplates(map, fx, anims, cam, state, motionCheck = null,
                                fire = null) {
  let fired = 0;
  for (const i of fx.plates) {
    const s = map.sprites[i];
    if (!s || s.removed) continue;
    const t = fx.temp(i);
    if (t[5] === 1) continue;                       // used up

    const onIt = cam && cam.sectNum === s.sectNum
      && ((state && state.onGround) || s.ang === 512);
    if (!onIt) { t[0] = 0; continue; }
    if (t[0] !== 0) continue;
    if (motionCheck && motionCheck(map, fx, anims, s.lotag)) continue;

    t[0] = 1;
    t[1] = 1;
    t[3] = t[3] ? 0 : 1;
    operateMasterSwitches(map, fx, s.lotag);
    if (fire) fire(s.lotag);
    if (s.hitag > 0) {
      s.hitag--;
      if (s.hitag === 0) t[5] = 1;
    }
    fired++;
  }
  return fired;
}
