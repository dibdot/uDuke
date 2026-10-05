// Cache tripwire: see version.js.
export const MODULE_STAGE = 'stage12.196';

// uDuke - checkhitwall(): what a shot does to a wall. sector.c 1567.
//
// Glass shatters and becomes walkable, fans and screens break, tech walls
// take their dented tile, wall lights go out, a mirror breaks only for an
// explosive, a force field only hums. And before checkhitwall itself, the
// shooter's hitscan (player.c 617) treats a switch as a switch, skips door
// tiles and tagged walls, and leaves a BULLETHOLE where the rules allow one.
//
// Everything acts on the wall's own fields; the renderer reads them the next
// frame. Sounds go through the CON's labels; debris (lotsofglass) is counted.

import { canSee, makeSprite, spawnFrom, randomScrap, AFLAMABLE, STAT, T } from './con.js';
import { getAngle } from './con.js';
import { updateSector } from './geometry.js';
import { krand } from './effector.js';

const MIRROR = 560, MIRRORBROKE = 70, BIGFORCE = 230, W_FORCEFIELD = 663;
const FANSPRITE = 407, FANSPRITEBROKE = 411, GLASS = 503, GLASS2 = 504, STAINGLASS1 = 510;
const ATM = 867, ATMBROKE = 888, W_SCREENBREAK = 357, BULLETHOLE = 952;
const W_MILKSHELF = 4181, W_MILKSHELFBROKE = 4203;
const HITTECH = new Map([
  [306, 4145],                       // W_TECHWALL10 -> W_HITTECHWALL10
  [293, 363], [4130, 363], [4131, 363], [4132, 363], [4133, 363],   // 1, 11..14 -> W_HITTECHWALL1
  [299, 4147],                       // W_TECHWALL15
  [307, 4144],                       // W_TECHWALL16
  [297, 362], [301, 360], [305, 361],   // 2, 3, 4
]);
const TECHWALL_PLUS1 = new Set([4134, 4136, 4138, 4140, 4142]);          // W_TECHWALL5..9: picnum + 1
const SCREENS = new Set([806, 1289, 1298, 268, 269, 270, 263, 264, 265, 266, 267, 271, 272, 273, 274, 275,
  4120, 4123, 4127, 4128, 4129, 3370, 342, 343, 344]);                  // OJ, FEMPIC2/3, SCREENBREAK*, BORNTOBEWILD, PANNEL1..3
const LIGHT_BUST = new Map([[703, 704], [705, 706], [701, 702], [124, 125], [120, 121], [122, 123]]);
const DOORTILES = new Set([152, 153, 154, 155, 150, 151, 156, 157, 158, 159, 1178, 1179, 717, 1102, 781, 1169, 447, 448, 449, 1144, 395, 4391]);
const SWITCH_BY_SHOT = new Set([162, 163, 164, 165, 168, 169, 1111, 1112]);   // DIPSWITCH..3 and HANDSWITCH, on/off

export const isDoorWall = (pic) => DOORTILES.has(pic);

/**
 * lotsofglass(i, wallnum, n), game.c 10322: n shards along the wall, one
 * step in from it (the wall's normal), each at a random height within the
 * sector's span (or within 64<<8 of the hit when that is absurd), turned
 * away from the wall (the shooter's angle - 1024), speed 32 + TRAND&63,
 * rising up to 1023, 36x36 at shade -32, misc. GLASSPIECES cycles three
 * tiles. With no wall (-1): n shards around the sprite itself.
 */
export function lotsOfGlass(vm, map, x, y, z, ang, wallIdx, n, sectHint = -1) {
  const made = [];
  if (wallIdx < 0) {
    const sect = updateSector(map, x, y, sectHint);
    if (sect < 0) return made;
    for (let j = n - 1; j >= 0; j--) {
      const a = (ang - 256 + (krand(vm.fx) & 511) + 1024) & 2047;
      const k = makeSprite(vm, map, sect, x, y, z, 1031 + (j % 3), -32, 36, 36, a, 32 + (krand(vm.fx) & 63), 1024 - (krand(vm.fx) & 1023), -1, STAT.MISC);
      made.push(k);
    }
    return made;
  }
  const wal = map.walls[wallIdx], w2 = map.walls[wal.point2];
  const j = n + 1;
  let x1 = wal.x, y1 = wal.y;
  let xv = w2.x - x1, yv = w2.y - y1;
  x1 -= Math.sign(yv); y1 += Math.sign(xv);
  xv = Math.trunc(xv / j); yv = Math.trunc(yv / j);
  let sect = sectHint;
  for (let k = n; k > 0; k--) {
    x1 += xv; y1 += yv;
    sect = updateSector(map, x1, y1, sect);
    if (sect < 0) continue;
    const sec = map.sectors[sect];
    let zz = sec.floorZ - (krand(vm.fx) & Math.abs(sec.ceilingZ - sec.floorZ));
    if (zz < -(32 << 8) || zz > (32 << 8)) zz = z - (32 << 8) + (krand(vm.fx) & ((64 << 8) - 1));
    const a = (ang - 1024) & 2047;
    const idx = makeSprite(vm, map, sect, x1, y1, zz, 1031 + (k % 3), -32, 36, 36, a, 32 + (krand(vm.fx) & 63), -(krand(vm.fx) & 1023), -1, STAT.MISC);
    made.push(idx);
  }
  return made;
}

const say = (vm, name, x, y, z, cam, map) => {
  const n = vm.labels?.get(name);
  if (n !== undefined && vm.sounds) vm.sounds.at(n, -1, x, y, z, cam, map);
};

/**
 * checkhitwall(spr, dawallnum, x, y, z, atwith). `atwith` is the tile of
 * what hit — SHOTSPARK1 for a gun, the explosive's tile for a blast.
 * Returns what happened, for tests and the probe: 'mirror', 'force',
 * 'fan', 'glass', 'stainglass', 'screen', 'techwall', 'shelf', 'atm',
 * 'light', or null.
 */
export function checkHitWall(vm, map, wallIdx, x, y, z, atwith, cam) {
  const wal = map.walls[wallIdx];
  if (!wal) return null;
  if (wal.overPicNum === MIRROR) {
    switch (atwith) {
      case 26: case 1670: case 2605: case 981: case 1247: case 1079: case 1238:   // HEAVYHBOMB RADIUSEXPLOSION RPG HYDRENT SEENINE OOZFILTER EXPLODINGBARREL
        wal.overPicNum = MIRRORBROKE;
        lotsOfGlass(vm, map, x, y, z, cam?.ang ?? 0, wallIdx, 70, wal.nextSector >= 0 ? wal.nextSector : -1);
        say(vm, 'GLASS_HEAVYBREAK', x, y, z, cam, map);
        return 'mirror';
      default:
        return null;
    }
  }
  if (((wal.cstat & 16) || wal.overPicNum === BIGFORCE) && wal.nextSector >= 0
      && map.sectors[wal.nextSector].floorZ > z
      && map.sectors[wal.nextSector].floorZ - map.sectors[wal.nextSector].ceilingZ) {
    switch (wal.overPicNum) {
      case W_FORCEFIELD: case W_FORCEFIELD + 1: case W_FORCEFIELD + 2: case BIGFORCE: {
        // sector.c 1600: the field is told to animate (extra = 1, not for a
        // BIGFORCE), and a FORCERIPPLE (its own CON actor, RIP_F) is put at
        // the hit: 8x8 for a touch (atwith -1), 16+the shooter's size for
        // the chaingun, 32x32 for anything else; shade -127, translucent,
        // blocking-masked (cstat 18+128), facing off the wall.
        if (wal.overPicNum !== BIGFORCE) wal.extra = 1;
        const sn = updateSector(map, x, y, wal.nextSector >= 0 ? wal.nextSector : -1);
        if (sn < 0) return 'force';
        const shooter = map.sprites[vm.playerSprite] ?? null;
        const size = atwith === -1 ? 8 : (atwith === T.CHAINGUN && shooter ? 16 + shooter.xRepeat : 32);
        const i = makeSprite(vm, map, sn, x, y, z, T.FORCERIPPLE, -127, size, size, 0, 0, 0, vm.playerSprite ?? -1, STAT.MISC);
        const rip = map.sprites[i];
        rip.cstat |= 18 + 128;
        const w2 = map.walls[wal.point2];
        rip.ang = (getAngle(vm.radarang, wal.x - w2.x, wal.y - w2.y) - 512) & 2047;
        say(vm, 'SOMETHINGHITFORCE', x, y, z, cam, map);
        return 'force';
      }
      case FANSPRITE:
        wal.overPicNum = FANSPRITEBROKE;
        wal.cstat &= 65535 - 65;
        if (wal.nextWall >= 0) { map.walls[wal.nextWall].overPicNum = FANSPRITEBROKE; map.walls[wal.nextWall].cstat &= 65535 - 65; }
        say(vm, 'VENT_BUST', x, y, z, cam, map);
        say(vm, 'GLASS_BREAKING', x, y, z, cam, map);
        return 'fan';
      case GLASS: {
        const sn = updateSector(map, x, y, wal.nextSector);
        if (sn < 0) return null;
        // The glass is gone: the masked picture becomes the broken pane and
        // the wall loses every cstat bit — blocking, hitscan, masking — on
        // both sides. Walk through, shoot through.
        wal.overPicNum = GLASS2;
        lotsOfGlass(vm, map, x, y, z, cam?.ang ?? 0, wallIdx, 10, sn);
        wal.cstat = 0;
        if (wal.nextWall >= 0) map.walls[wal.nextWall].cstat = 0;
        // sector.c 1645: an SE 128 (statnum 3) runs the shatter — T2 = 5
        // frames, T3 = the wall; effector.js moves it.
        {
          const k = makeSprite(vm, map, sn, x, y, z, 1, 0, 0, 0, cam?.ang ?? 0, 0, 0, -1, STAT.MISC);
          if (k >= 0) {
            const e = map.sprites[k];
            e.lotag = 128; e.cstat = 32768;
            vm.stat.set(k, 3);                   // statnum 3: an effector, not an actor
            const t = vm.fx.temp(k); t.fill(0); t[1] = 5; t[2] = wallIdx;
            vm.fx.list.unshift(k);               // head-inserted: runs first, as a new statnum-3 sprite does
            say(vm, 'GLASS_BREAKING', e.x, e.y, e.z, cam, map);
          }
        }
        return 'glass';
      }
      case STAINGLASS1: {
        const sn = updateSector(map, x, y, wal.nextSector);
        if (sn < 0) return null;
        lotsOfGlass(vm, map, x, y, z, cam?.ang ?? 0, wallIdx, 80, sn);
        wal.cstat = 0;
        if (wal.nextWall >= 0) map.walls[wal.nextWall].cstat = 0;
        say(vm, 'VENT_BUST', x, y, z, cam, map);
        say(vm, 'GLASS_BREAKING', x, y, z, cam, map);
        return 'stainglass';
      }
      default:
        break;
    }
  }
  const pn = wal.picNum;
  if (pn === 1215 || pn === 1212) { say(vm, 'VENT_BUST', x, y, z, cam, map); return 'machine'; }   // COLAMACHINE VENDMACHINE
  if (SCREENS.has(pn)) {
    lotsOfGlass(vm, map, x, y, z, cam?.ang ?? 0, wallIdx, 30, wal.nextSector);
    wal.picNum = W_SCREENBREAK + (krand(vm.fx) % 3);
    say(vm, 'GLASS_HEAVYBREAK', x, y, z, cam, map);
    return 'screen';
  }
  const breakwall = (newpn) => {
    wal.picNum = newpn;
    say(vm, 'VENT_BUST', x, y, z, cam, map);
    say(vm, 'GLASS_HEAVYBREAK', x, y, z, cam, map);
    lotsOfGlass(vm, map, x, y, z, cam?.ang ?? 0, wallIdx, 10, wal.nextSector);
  };
  if (TECHWALL_PLUS1.has(pn)) { breakwall(pn + 1); return 'techwall'; }
  if (pn === W_MILKSHELF) { breakwall(W_MILKSHELFBROKE); return 'shelf'; }
  if (HITTECH.has(pn)) { breakwall(HITTECH.get(pn)); return 'techwall'; }
  if (pn === ATM) { wal.picNum = ATMBROKE; say(vm, 'GLASS_HEAVYBREAK', x, y, z, cam, map); return 'atm'; }
  if (LIGHT_BUST.has(pn)) {
    say(vm, (krand(vm.fx) & 255) < 128 ? 'GLASS_HEAVYBREAK' : 'GLASS_BREAKING', x, y, z, cam, map);
    lotsOfGlass(vm, map, x, y, z, cam?.ang ?? 0, wallIdx, 30, wal.nextSector);
    wal.picNum = LIGHT_BUST.get(pn);
    if (!wal.lotag) return 'light';
    // A tagged light: the SE3 (random light) of that hitag is told to go
    // out — T3 a coin, T4 the darkest wall shade of the next sector, T5 1.
    const sn = wal.nextSector;
    if (sn < 0) return 'light';
    let darkest = 0;
    const sec = map.sectors[sn];
    for (let w = sec.wallPtr; w < sec.wallPtr + sec.wallNum; w++) if (map.walls[w].shade > darkest) darkest = map.walls[w].shade;
    const coin = krand(vm.fx) & 1;
    for (let i = 0; i < map.sprites.length; i++) {
      const e = map.sprites[i];
      if (!e.removed && e.picNum === 1 && e.lotag === 3 && e.hitag === wal.lotag) {
        const et = vm.fx.temp(i);
        et[2] = coin; et[3] = darkest; et[4] = 1;
      }
    }
    return 'light';
  }
  return null;
}

/**
 * The shooter's wall hit, player.c 617..677, for a hitscan that ended on a
 * wall: smoke; a door tile takes nothing; a switch tile is thrown (through
 * `vm.hitSwitch`, which the page wires to switch.js); a wall with a hitag —
 * or whose other side has one — takes no hole; otherwise, in an untagged
 * sector with an untagged sector behind, no SE13 behind it and no other
 * hole within 12..19, a BULLETHOLE is set on the wall; and finally
 * checkhitwall, on the other side of a translucent wall when the hit is
 * below the far floor.
 */
export function shotHitWall(vm, map, h, cam, atwith = T.SHOTSPARK1, sparkIdx = -1) {
  const wal = map.walls[h.wall];
  if (!wal) return null;
  if (sparkIdx >= 0) spawnFrom(vm, map, sparkIdx, T.SMALLSMOKE);
  if (isDoorWall(wal.picNum)) return checkHitWall(vm, map, h.wall, h.x, h.y, h.z, atwith, cam);
  if (SWITCH_BY_SHOT.has(wal.picNum)) {
    if (vm.hitSwitch) vm.hitSwitch(0, h.wall);
    return 'switch';
  }
  let hole = false;
  const other = wal.nextWall >= 0 ? map.walls[wal.nextWall] : null;
  if (!(wal.hitag !== 0 || (other && other.hitag !== 0))) {
    const sec = map.sectors[h.sect];
    if (h.sect >= 0 && (sec.lotag & 0xffff) === 0 && wal.overPicNum !== BIGFORCE
        && ((wal.nextSector >= 0 && (map.sectors[wal.nextSector].lotag & 0xffff) === 0) || (wal.nextSector === -1))
        && (wal.cstat & 16) === 0) {
      let skip = false;
      if (wal.nextSector >= 0) {
        for (const s of map.sprites) if (!s.removed && s.picNum === 1 && s.lotag === 13 && s.sectNum === wal.nextSector) { skip = true; break; }
      }
      if (!skip) {
        for (const s of map.sprites) {
          if (s.removed || s.picNum !== BULLETHOLE) continue;
          const d = Math.abs(s.x - h.x) + Math.abs(s.y - h.y);
          if (d < 12 + (krand(vm.fx) & 7)) { skip = true; break; }
        }
      }
      if (!skip) {
        // game.c: 3x3, a wall sprite turned along the wall, cstat 16 + a
        // random flip pair.
        const k = makeSprite(vm, map, h.sect, h.x, h.y, h.z, BULLETHOLE, 0, 3, 3, 0, 0, 0, -2, STAT.MISC);
        const b = map.sprites[k];
        const w2 = map.walls[wal.point2];
        b.ang = (getAngle(vm.radarang, wal.x - w2.x, wal.y - w2.y) + 512) & 2047;
        b.cstat = 16 + (krand(vm.fx) & 12);
        b.xVel = 0;
        hole = true;
      }
    }
  }
  let target = h.wall;
  if ((wal.cstat & 2) && wal.nextSector >= 0 && h.z >= map.sectors[wal.nextSector].floorZ) target = wal.nextWall;
  const what = checkHitWall(vm, map, target, h.x, h.y, h.z, atwith, cam);
  return what ?? (hole ? 'hole' : null);
}


/**
 * hitradius' wall pass, actors.c 455: from the blast's sector outward
 * through portals, every wall within r (Manhattan, from its first point):
 * the point halfway between the blast and the wall's middle must be in a
 * sector and see the blast; then checkhitwall(i, wall, wal.x, wal.y, s.z,
 * picnum). A small RPG (xrepeat < 11) and the shrinker skip it. The
 * ceiling check (checkhitceiling) is not here.
 */
export function blastWalls(vm, map, i, r, cam) {
  const s = map.sprites[i];
  if (s.picNum === 2605 && s.xRepeat < 11) return 0;
  if (s.picNum === 1646) return 0;
  const seen = [s.sectNum];
  let hits = 0;
  for (let n = 0; n < seen.length && n < 256; n++) {
    const sec = map.sectors[seen[n]];
    if (!sec) continue;
    for (let w = sec.wallPtr; w < sec.wallPtr + sec.wallNum; w++) {
      const wal = map.walls[w];
      if (Math.abs(wal.x - s.x) + Math.abs(wal.y - s.y) >= r) continue;
      if (wal.nextSector >= 0 && !seen.includes(wal.nextSector)) seen.push(wal.nextSector);
      const w2 = map.walls[wal.point2];
      const x1 = (((wal.x + w2.x) >> 1) + s.x) >> 1, y1 = (((wal.y + w2.y) >> 1) + s.y) >> 1;
      const sect = updateSector(map, x1, y1, s.sectNum);
      if (sect < 0) continue;
      if (!canSee(map, x1, y1, s.z, sect, s.x, s.y, s.z, s.sectNum)) continue;
      if (checkHitWall(vm, map, w, wal.x, wal.y, s.z, s.picNum, cam)) hits++;
    }
  }
  return hits;
}


// ---------------------------------------------------------------------------
// checkhitsprite() for the things that are not enemies: the decoration a
// shot breaks. sector.c 1947. Each group in the order the source has it.
// ---------------------------------------------------------------------------

const FANSPRITE_T = 407, FANSPRITEBROKE_T = 411, FANSHADOW = 412, FANSHADOWBROKE = 416;
const WATERFOUNTAIN = 563, WATERFOUNTAINBROKE = 567, TOILET = 569, TOILETBROKE = 615, STALL = 571, STALLBROKE = 573;
const HYDRENT = 981, BROKEFIREHYDRENT = 950, GRATE1 = 595, BGRATE1 = 596, CIRCLEPANNEL = 1113, CIRCLEPANNELBROKE = 1114;
const PANNEL1 = 342, PANNEL2 = 343, BPANNEL1 = 341, PANNEL3 = 4099, BPANNEL3 = 4100;
const PIPES = new Map([[619, 617], [616, 633], [618, 700], [996, 997], [994, 1005], [995, 1260]]);
const CHAIR1 = 556, CHAIR2 = 557, BROKENCHAIR = 559;
const TOILETWATER = 921, STEAM = 1250, EXPLOSION2 = 1890;
/** The bottles, plates, vases and lamps that shatter into glass and vanish. */
const GLASSY = new Set([954, 955, 956, 957, 1012, 1013, 1014, 1157, 1158, 1159, 1160, 1161, 1162, 1163, 1164, 1165, 1166,
  1025, 567, 551, 768, 776, 784, 792, 800, 716, 765, 869, 753, 1358, 1359, 969, 1003, 2590]);
/** The things that fly apart as scrap and vanish (RANDOMSCRAP x16). */
const SCRAPPY = new Set([680, 686, 678, 669, 685, 689, 694, 695, 697, 4444]);   // CHAIR3 MOVIECAMERA SCALE VACUUM CAMERALIGHT IVUNIT POT1..3 TRIPODCAMERA
/** The satellite dishes and pods that explode (unless a pistol shot). */
const EXPLODY = new Set([516, 517, 602, 607]);

/** The breakables spawn() makes solid with the hitscan bit (clipdist 32). */
export const BREAKABLE_TILES = new Set([
  FANSPRITE_T, 911, 939, 979, 1358, 1359, 685, 686, 689, 694, 695, 697, 4444, 768, 776, 784, 792, 800, 716, 765,
  619, 616, 618, 996, 994, 995, HYDRENT, PANNEL1, PANNEL2, 516, 517, 602, 607, GRATE1, CHAIR1, CHAIR2, 680,
  954, 955, 956, 957, 1012, 1013, 1025, 1014, 1157, 1158, 1159, 1160, 1161, 1162, 1163, 1164, 1165, 1166,
  678, 669, TOILET, STALL, WATERFOUNTAIN, CIRCLEPANNEL, PANNEL3, 551, 869, 753, 969, 2590,
  971, 972, 973, 975,   // OCEANSPRITE1..3, 5 (game.c 4027); OCEANSPRITE4 stays non-solid (4065)
]);

/**
 * A shot on a breakable. `weapon` is the hitting sprite (a spark, a rocket,
 * a blast). Returns what happened, or null if the tile is not one of these.
 */
export function hitBreakable(vm, map, i, weapon, cam) {
  const s = map.sprites[i];
  const w = map.sprites[weapon];
  const pn = s.picNum;
  const at = (name) => say(vm, name, s.x, s.y, s.z, cam, map);
  const gone = () => { s.removed = true; vm.stat.delete(i); };
  switch (true) {
    case AFLAMABLE.has(pn): {
      // sector.c 2020: a tree, tire, cone or box catches fire from an
      // explosion, a rocket, a laser, a hydrant or a pipe bomb — once: it
      // stops blocking, T1 marks it lit, a BURNING is spawned on it.
      const wp = w?.picNum;
      if (wp === 1670 || wp === 2605 || wp === 1625 || wp === 981 || wp === 26) {
        const t = vm.fx.temp(i);
        if (t[0] === 0) { s.cstat &= ~257; t[0] = 1; spawnFrom(vm, map, i, 2270); }
        return 'lit';
      }
      return 'flammable';
    }
    case pn === 911: {
      // sector.c 2009, a CACTUS: only an explosion, a rocket, a laser, a
      // hydrant or a pipe bomb breaks it — 64 SCRAP3 pieces (pal 8) fly,
      // the picture becomes CACTUSBROKE and it stops blocking. Bullets do
      // nothing (the case lists no spark).
      const wp = w?.picNum;
      if (wp === 1670 || wp === 2605 || wp === 1625 || wp === 981 || wp === 26) {
        for (let k = 0; k < 64; k++) {
          const j = makeSprite(vm, map, s.sectNum, s.x, s.y, s.z - (krand(vm.fx) % (48 << 8)), 2408 + (krand(vm.fx) & 3), -8, 48, 48,
            krand(vm.fx) & 2047, (krand(vm.fx) & 63) + 64, -(krand(vm.fx) & 4095) - ((w?.zVel ?? 0) >> 2), i, STAT.MISC);
          if (j >= 0) map.sprites[j].pal = 8;
        }
        s.picNum = 939;
        s.cstat &= ~257;
        return 'cactus broken';
      }
      return 'cactus';
    }
    case pn >= 971 && pn <= 975:
      // sector.c 1956: OCEANSPRITE1..5 — a puff of SMALLSMOKE, and gone.
      spawnFrom(vm, map, i, T.SMALLSMOKE);
      gone();
      return 'ocean sprite';
    case pn === T.QUEBALL || pn === T.STRIPEBALL: {
      // sector.c 1964, a shot on a ball: three times in four it goes off at
      // 164 in the shot's direction; the fourth it shatters (lotsofglass 3).
      if (krand(vm.fx) & 3) {
        s.xVel = 164;
        s.ang = w ? w.ang : s.ang;
        vm.asleep?.delete(i);
        return 'ball';
      }
      lotsOfGlass(vm, map, s.x, s.y, s.z, s.ang, -1, 3, s.sectNum);
      gone();
      return 'shattered';
    }
    case pn === FANSPRITE_T: {
      s.picNum = FANSPRITEBROKE_T;
      s.cstat &= 65535 - 257;
      const sec = map.sectors[s.sectNum];
      if (sec && sec.floorPicNum === FANSHADOW) sec.floorPicNum = FANSHADOWBROKE;
      at('GLASS_HEAVYBREAK');
      randomScrap(vm, map, i, 16);
      return 'fan';
    }
    case pn >= WATERFOUNTAIN && pn <= WATERFOUNTAIN + 3:
      s.picNum = WATERFOUNTAINBROKE;
      spawnFrom(vm, map, i, TOILETWATER);
      return 'fountain';
    case EXPLODY.has(pn): {
      // Not for the pistol's strength: a spark of exactly SHOTSPARK1's
      // header value leaves them; anything stronger blows them up.
      const hdr = vm.actorScr.get(2595);
      if (w && hdr !== undefined && w.extra === vm.script[hdr]) return 'explody-pistol';
      spawnFrom(vm, map, i, EXPLOSION2);
      gone();
      return 'explody';
    }
    case GLASSY.has(pn): {
      if (pn === 765) lotsOfGlass(vm, map, s.x, s.y, s.z, s.ang, -1, 40, s.sectNum);            // VASE
      else if (pn === 753 || pn === 869) { lotsOfGlass(vm, map, s.x, s.y, s.z, s.ang, -1, 40, s.sectNum); at('GLASS_HEAVYBREAK'); }   // STATUE
      at('GLASS_BREAKING');
      s.ang = krand(vm.fx) & 2047;
      lotsOfGlass(vm, map, s.x, s.y, s.z, s.ang, -1, 8, s.sectNum);
      gone();
      return 'glassy';
    }
    case pn === TOILET:
      s.picNum = TOILETBROKE; s.cstat |= (krand(vm.fx) & 1) << 2; s.cstat &= ~257;
      spawnFrom(vm, map, i, TOILETWATER); at('GLASS_BREAKING');
      return 'toilet';
    case pn === STALL:
      s.picNum = STALLBROKE; s.cstat |= (krand(vm.fx) & 1) << 2; s.cstat &= ~257;
      spawnFrom(vm, map, i, TOILETWATER); at('GLASS_HEAVYBREAK');
      return 'stall';
    case pn === HYDRENT:
      s.picNum = BROKEFIREHYDRENT; spawnFrom(vm, map, i, TOILETWATER); at('GLASS_HEAVYBREAK');
      return 'hydrant';
    case pn === GRATE1:
      s.picNum = BGRATE1; s.cstat &= 65535 - 256 - 1; at('VENT_BUST');
      return 'grate';
    case pn === CIRCLEPANNEL:
      s.picNum = CIRCLEPANNELBROKE; s.cstat &= 65535 - 256 - 1; at('VENT_BUST');
      return 'pannel';
    case pn === PANNEL1 || pn === PANNEL2:
      s.picNum = BPANNEL1; s.cstat &= 65535 - 256 - 1; at('VENT_BUST');
      return 'pannel';
    case pn === PANNEL3:
      s.picNum = BPANNEL3; s.cstat &= 65535 - 256 - 1; at('VENT_BUST');
      return 'pannel';
    case PIPES.has(pn): {
      s.picNum = PIPES.get(pn);
      const j = spawnFrom(vm, map, i, STEAM);
      if (j >= 0) map.sprites[j].z = map.sectors[s.sectNum].floorZ - (32 << 8);
      return 'pipe';
    }
    case pn === CHAIR1 || pn === CHAIR2:
      s.picNum = BROKENCHAIR; s.cstat = 0;
      return 'chair';
    case SCRAPPY.has(pn):
      at('GLASS_HEAVYBREAK');
      randomScrap(vm, map, i, 16);
      gone();
      return 'scrap';
    default:
      return null;
  }
}
