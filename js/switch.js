// Cache tripwire: every module carries the stage it shipped with, and boot.js
// refuses to run a mix. A browser that re-fetched one file and kept another
// from its cache showed up as 'HEALTH undefined' — a field the stale
// player.js did not have. That is the third stale-cache report; this makes
// the fourth say which file.
export const MODULE_STAGE = 'stage12.194';

// uDuke - switches.
//
// The activator chain has been in place since SE 31 arrived; this is its
// proper trigger.
//
// Source: sector.c, checkhitswitch() and check_activator_motion().

import { operateActivators, operateMasterSwitches } from './effector.js';

/**
 * Switch tiles, names.h. Each is a PAIR: the base tile is the off state and
 * base+1 the on state, and flipping a switch is literally `picnum++` or
 * `picnum--`. MULTISWITCH is a run of four that cycles.
 */
export const SWITCH = {
  ACCESSSWITCH: 130, SLOTDOOR: 132, LIGHTSWITCH: 134, SPACEDOORSWITCH: 136,
  SPACELIGHTSWITCH: 138, FRANKENSTINESWITCH: 140, MULTISWITCH: 146,
  DIPSWITCH: 162, DIPSWITCH2: 164, TECHSWITCH: 166, DIPSWITCH3: 168,
  ACCESSSWITCH2: 170, LIGHTSWITCH2: 712, POWERSWITCH1: 860, LOCKSWITCH1: 862,
  POWERSWITCH2: 864, HANDSWITCH: 1111, PULLSWITCH: 1122, ALIENSWITCH: 1142,
};

/** The three that come in pairs and count toward a combination, not a toggle. */
const DIP_PAIRS = [SWITCH.DIPSWITCH, SWITCH.TECHSWITCH, SWITCH.ALIENSWITCH];

/** Everything that is simply base/base+1. ACCESSSWITCH2 is a lone base tile. */
const TOGGLE_BASES = [
  SWITCH.ACCESSSWITCH, SWITCH.ACCESSSWITCH2, SWITCH.SLOTDOOR, SWITCH.LIGHTSWITCH,
  SWITCH.SPACEDOORSWITCH, SWITCH.SPACELIGHTSWITCH, SWITCH.FRANKENSTINESWITCH,
  SWITCH.DIPSWITCH2, SWITCH.DIPSWITCH3, SWITCH.LIGHTSWITCH2, SWITCH.POWERSWITCH1,
  SWITCH.LOCKSWITCH1, SWITCH.POWERSWITCH2, SWITCH.HANDSWITCH, SWITCH.PULLSWITCH,
];

const MULTI = SWITCH.MULTISWITCH;

/** isadoorwall(), sector.c — a door texture can be used instead of a switch. */
const DOOR_WALL_TILES = new Set([
  150, 151, 152, 153, 154, 155, 156, 157, 158, 159, 395, 447, 448, 449,
  717, 781, 1102, 1144, 1169, 1178, 1179, 4391,
]);
export const isADoorWall = (pic) => DOOR_WALL_TILES.has(pic);

/** Which of the three states a tile is in, or null when it is not a switch. */
function classify(pic) {
  if (pic >= MULTI && pic <= MULTI + 3) return { kind: 'multi' };
  for (const b of DIP_PAIRS) {
    if (pic === b) return { kind: 'dip', base: b, on: false };
    if (pic === b + 1) return { kind: 'dip', base: b, on: true };
  }
  for (const b of TOGGLE_BASES) {
    if (pic === b) return { kind: 'toggle', base: b, on: false };
    if (pic === b + 1) return { kind: 'toggle', base: b, on: true };
  }
  return null;
}

/** True when this tile is a switch of any sort. */
export const isSwitchTile = (pic) => classify(pic) !== null;

/**
 * check_activator_motion(), sector.c: refuse while the thing is still moving.
 *
 * Without it a switch pressed twice quickly leaves a door half open and its
 * state bit inverted, and the level is stuck. Build looks at the animation list
 * and at the effectors in each activator's sector; both are checked here.
 */
export function checkActivatorMotion(map, fx, anims, lotag) {
  for (let i = 0; i < map.sprites.length; i++) {
    const spr = map.sprites[i];
    if (spr.removed || spr.lotag !== lotag) continue;
    if (spr.picNum !== 2 && spr.picNum !== 4) continue;         // ACTIVATOR(LOCKED)

    if (anims && anims.list.some((a) => a.sect === spr.sectNum)) return true;

    for (const j of fx.list) {
      const se = map.sprites[j];
      if (se.sectNum !== spr.sectNum) continue;
      const t = fx.temp(j);
      switch (se.lotag) {
        case 11: case 30:
          if (t[4]) return true;
          break;
        case 20: case 31: case 32: case 18:
          if (t[0]) return true;
          break;
        default:
          break;
      }
    }
  }
  return false;
}

/**
 * checkhitswitch(), sector.c. `kind` is Build's switchtype: 0 a wall, 1 a
 * sprite.
 *
 * Three things happen, in this order: the tile is checked and the motion guard
 * consulted, EVERY switch sharing the lotag flips its picture, and then the
 * activators fire. The middle step is why a room full of matching switches
 * moves together — the picture is the state, stored in the map like a door's.
 *
 * Deliberately not reproduced: keycards (ACCESSSWITCH consults the player's
 * inventory, and there is no player), the dip-switch combination that ends a
 * level, sounds, and force fields. Each is noted where it would go.
 *
 * Returns true when the switch fired.
 */
export function checkHitSwitch(map, fx, anims, kind, index, operateSectorFn = null,
                               ext = null) {
  if (index < 0) return false;
  const obj = kind === 1 ? map.sprites[index] : map.walls[index];
  if (!obj) return false;
  const lotag = obj.lotag;
  if (!lotag) return false;
  const picnum = obj.picNum;

  // sector.c 1350: an ACCESSSWITCH asks for the key card of its palette —
  // 0 blue (got_access & 1), 21 red (& 2), 23 yellow (& 4). With no card in
  // hand, the quote (70..72) and nothing else; with it, the insert begins
  // (access_incs = 1, remembering the switch) and the switch itself waits
  // until the hand has put the card in — the tic calls back with
  // player.accessIncs > 0, and then the switch fires like any other.
  if ((picnum === SWITCH.ACCESSSWITCH || picnum === SWITCH.ACCESSSWITCH2) && ext?.player) {
    const pl = ext.player;
    if (!(pl.accessIncs > 0)) {
      const pal = obj.pal ?? 0;
      const bit = pal === 21 ? 2 : pal === 23 ? 4 : 1;
      if ((pl.inventory?.access ?? 0) & bit) {
        pl.accessIncs = 1;
        pl.accessTarget = { kind, index };
      } else if (ext.quote) {
        ext.quote(pal === 21 ? 71 : pal === 23 ? 72 : 70);
      }
      return false;
    }
  }

  const cls = classify(picnum);
  if (!cls) {
    // A door texture works as a switch; anything else is scenery with a tag,
    // which is exactly what E1L5's four tagged walls are.
    if (!isADoorWall(picnum)) return false;
  } else if (cls.kind !== 'dip') {
    // Build guards only the non-dip tiles here.
    if (checkActivatorMotion(map, fx, anims, lotag)) return false;
  }

  // Flip every switch carrying the same lotag, sprites then walls, as Build
  // does. The one that was hit flips; the others of a dip pair are only
  // counted, which is how a combination lock works.
  let flipped = 0;
  // The combination lock (sector.c 1270): every dip pair with the lotag is
  // counted; the one hit flips, each OTHER one is "correct" when its frame
  // matches its hitag — off with hitag 0, on with hitag 1. correctdips
  // starts at 1 (the hit one is taken as read). Unless every dip is
  // correct, nothing fires: the click plays and that is all. E1L4 opens
  // with three DIPSWITCHes of lotag 185 and hitags 1/0/1.
  let numDips = 0, correctDips = 1;
  const flip = (o, isHit) => {
    const c = classify(o.picNum);
    if (!c) return;
    if (c.kind === 'multi') {
      o.picNum = o.picNum >= MULTI + 3 ? MULTI : o.picNum + 1;
      flipped++;
    } else if (c.kind === 'dip') {
      numDips++;
      if (isHit) { o.picNum += c.on ? -1 : 1; flipped++; }
      else if ((o.hitag ?? 0) === (c.on ? 1 : 0)) correctDips++;
    } else {
      o.picNum += c.on ? -1 : 1;
      flipped++;
    }
  };
  map.sprites.forEach((spr, i) => {
    if (spr.removed || spr.lotag !== lotag) return;
    flip(spr, kind === 1 && i === index);
  });
  map.walls.forEach((wal, i) => {
    if (wal.lotag !== lotag) return;
    flip(wal, kind === 0 && i === index);
  });

  // A dip pair: the click, then the count. ALIENSWITCH clicks differently.
  if (cls && cls.kind === 'dip') {
    const click = cls.base === SWITCH.ALIENSWITCH ? 'ALIEN_SWITCH1' : 'SWITCH_ON';
    if (numDips !== correctDips) return { fired: 0, flipped, tag: lotag, armed: 0, fields: 0, sound: click, dips: { num: numDips, correct: correctDips } };
    // the combination: END_OF_LEVEL_WARN on top of the click, then the tail
    // as for any switch (which, for a dip, plays no further sound)
    const r = fireTag(map, fx, anims, lotag, operateSectorFn, ext);
    return { ...r, flipped, sound: click, extraSound: 'END_OF_LEVEL_WARN', dips: { num: numDips, correct: correctDips } };
  }

  // MULTISWITCH picks one of four tags from which frame it landed on.
  let tag = lotag;
  if (cls && cls.kind === 'multi') tag += picnum - MULTI;

  const r = fireTag(map, fx, anims, tag, operateSectorFn, ext);
  // sector.c, the tail of checkhitswitch: the sound. A switch with hitag 0
  // clicks (SWITCH_ON) — unless it is a door texture, which stays quiet;
  // one with a hitag plays THAT sound number instead. E1L1's Duke arcade
  // cabinet is a DIPSWITCH2 with hitag 177, myself3a.voc: "no time to play
  // with myself".
  const hitag = obj.hitag ?? 0;
  const sound = hitag !== 0 ? hitag : (isADoorWall(picnum) ? null : 'SWITCH_ON');
  return { ...r, flipped, sound };
}

/**
 * The tail of checkhitswitch for a tag: the effectors keyed on it by HITAG
 * (SE 12 stepped, 24/34/25 flagged — sector.c 1475), then activators,
 * force fields, master switches.
 */
function fireTag(map, fx, anims, tag, operateSectorFn, ext) {
  for (const j of fx.list) {
    const se = map.sprites[j];
    if (se.hitag !== tag) continue;
    const t = fx.temp(j);
    if (se.lotag === 12) {
      map.sectors[se.sectNum].floorPal = 0;
      t[0]++;
      if (t[0] === 2) t[0]++;
    } else if (se.lotag === 24 || se.lotag === 34 || se.lotag === 25) {
      t[4] = t[4] ? 0 : 1;
    }
  }

  const fired = operateActivators(map, fx, anims, tag, operateSectorFn, ext);
  // checkhitswitch fires all three in a row:
  //   operateactivators(lotag,snum); operateforcefields(...); operatemasterswitches(lotag);
  const fields = operateForceFields(map, tag);
  const armed = operateMasterSwitches(map, fx, tag);
  return { fired, tag, armed, fields };
}


/** The force-field tiles: W_FORCEFIELD, its two frames, and BIGFORCE. */
const W_FORCEFIELD = 663, BIGFORCE = 230;
export const isForceField = (over) => (over >= W_FORCEFIELD && over <= W_FORCEFIELD + 2) || over === BIGFORCE;

/**
 * operateforcefields(s, low), sector.c 1128: every force-field wall whose
 * lotag is `low` (or all of them for -1) toggles — a live one (any cstat)
 * goes to cstat 0 (open, walk through; and an SE 30 caller clears its
 * lotag for good), a dead one comes back as cstat 85 (blocking, masked,
 * hitscan, one-way). The animation tag restarts. Returns the walls toggled.
 */
export function operateForceFields(map, low, fromSE30 = false) {
  let n = 0;
  for (const wal of map.walls) {
    if (!isForceField(wal.overPicNum)) continue;
    if (!(low === wal.lotag || low === -1)) continue;
    wal.animTag = 0;
    if (wal.cstat) {
      wal.cstat = 0;
      if (fromSE30) wal.lotag = 0;
    } else wal.cstat = 85;
    n++;
  }
  return n;
}

/**
 * animatewalls(), sector.c 456, the force-field part, once a frame for every
 * masked wall with a field on it: while the wall is live (cstat&254) the
 * panning drifts by tag>>10, and the tag counts up 128 a frame — under 2048
 * the picture alternates W_FORCEFIELD / +1 on the tag's bit 7; past that,
 * one frame in eight the tag is thrown back to 128<<(rand&3), else the +1
 * frame shows. A wall whose `extra` was set to 1 (something hit it)
 * restarts its tag at 0. `rand` is the game's krand.
 */
export function animateForceFields(map, rand) {
  for (const wal of map.walls) {
    if (!(wal.cstat & 16) || !(wal.overPicNum >= W_FORCEFIELD && wal.overPicNum <= W_FORCEFIELD + 2)) continue;
    const t = wal.animTag | 0;
    if (!(wal.cstat & 254)) continue;
    wal.xPanning = (wal.xPanning - (t >> 10)) & 255;
    wal.yPanning = (wal.yPanning - (t >> 10)) & 255;
    if (wal.extra === 1) { wal.extra = 0; wal.animTag = 0; }
    else wal.animTag = t + 128;
    if (wal.animTag < (128 << 4)) {
      wal.overPicNum = (wal.animTag & 128) ? W_FORCEFIELD : W_FORCEFIELD + 1;
    } else if ((rand() & 255) < 32) {
      wal.animTag = 128 << (rand() & 3);
    } else wal.overPicNum = W_FORCEFIELD + 1;
  }
}
