// Cache tripwire: every module carries the stage it shipped with, and boot.js
// refuses to run a mix. A browser that re-fetched one file and kept another
// from its cache showed up as 'HEALTH undefined' — a field the stale
// player.js did not have. That is the third stale-cache report; this makes
// the fourth say which file.
export const MODULE_STAGE = 'stage12.195';

// uDuke - sector state: the animation engine, doors, and the "use" key.
//
// This is the first part of uDuke that carries STATE from one frame to the
// next. Everything before it was a pure function of the map: give the renderer
// a camera and a MAP and the frame follows. From here a sector's ceiling is
// wherever the last few seconds put it, which changes what a bug looks like —
// a wrong frame is no longer evidence about the frame it appeared in.
//
// Two consequences are baked into the shapes below. The animation list is an
// explicit object passed in rather than module state, so a test can build one,
// run it, and read it; and the simulation advances in fixed TICS, never in
// elapsed seconds, so a run is reproducible and a slow frame cannot change
// where a door ends up.
//
// Sources: sector.c for doanimations/setanimation/operatesectors, engine.c for
// nextsectorneighborz/neartag/lintersect, premap.c for the level setup.


/**
 * The clock. game.c sets `g_iTickRate = 120` and `g_iTicksPerFrame = 26`, and
 * duke3d.h defines `TICSPERFRAME (TICRATE/g_iTicksPerFrame)` — an INTEGER
 * divide, so 120/26 is 4 and not 4.615. The main loop then runs a game frame
 * per TICSPERFRAME units of the 120 Hz clock:
 *
 *   if ((totalclock < ototalclock+TICSPERFRAME) || (ready2send == 0)) ...
 *   ototalclock += TICSPERFRAME;
 *
 * so the simulation is 30 Hz, not the 26 the constant's name suggests. Worth
 * stating plainly, because "26" is the number everyone quotes for Duke and it
 * is the wrong one to build a clock on.
 */
export const TICRATE = 120;
export const TICS_PER_FRAME = Math.floor(TICRATE / 26);   // 4
export const SIM_HZ = TICRATE / TICS_PER_FRAME;           // 30

/** Tile numbers that are level-setup instructions rather than scenery. */
export const TILE = { SECTOREFFECTOR: 1, ACTIVATOR: 2, TOUCHPLATE: 3, GPSPEED: 10 };

/**
 * Door lotags that move a sector's floor or ceiling plane.
 *
 * These three are the whole of this slice. Build's other doors — 9, 23, 26, 29
 * — move WALLS, rewriting wall coordinates as they go, which is a different
 * kind of change to the map and a much larger one. E1L5 justifies the split
 * empirically: 17 sectors at lotag 20, three at 22, one at 21, and not a single
 * wall-moving door in the level.
 */
export const LOTAG = { CEILING_DOOR: 20, FLOOR_DOOR: 21, SPLIT_DOOR: 22, PLATFORM_DOWN: 16, PLATFORM_UP: 17, ELEVATOR_DOWN: 18, ELEVATOR_UP: 19, SLIDING_DOOR_9: 9, SPLIT_SLIDE_DOOR: 26, TEETH_DOOR: 29 };

/**
 * Which sector lotags operateSector actually understands.
 *
 * Exported so a caller can tell "there is nothing tagged in front of you" from
 * "there is, and it is a kind uDuke does not do yet". Those look identical from
 * outside, and the difference is the difference between a bug and a gap —
 * which cost a round of investigation the first time a door refused to open.
 *
 * 26 is 22 and 9 at once, 29 the teeth door (with its SE 22s, through `ext`). 25 and 23 look like doors and are not ones either — sector.c calls
 * the first "subway type sliding doors" and the second swing doors, and in both
 * operatesectors only flips a state bit and marks an SE sprite; moveeffectors()
 * does the moving, by sliding or turning walls. Those two and lotag 30 live in
 * effector.js and reach this switch through `ext` below. E1L5 has four lotag
 * 25, matched by four SE 15, and no lotag 23 at all.
 */
export const OPERABLE_LOTAGS = new Set([LOTAG.CEILING_DOOR, LOTAG.FLOOR_DOOR, LOTAG.SPLIT_DOOR, LOTAG.PLATFORM_DOWN, LOTAG.PLATFORM_UP, LOTAG.ELEVATOR_DOWN, LOTAG.ELEVATOR_UP, LOTAG.SLIDING_DOOR_9, LOTAG.SPLIT_SLIDE_DOOR, LOTAG.TEETH_DOOR]);

/** True when operateSector would do something with this sector. */
export function isOperable(map, sectNum) {
  const sec = map.sectors[sectNum];
  return !!sec && OPERABLE_LOTAGS.has(sec.lotag & LOTAG_MASK);
}

/**
 * Build keeps a door's open/closed state in the top bit of the sector's own
 * lotag and flips it on every operation (`sptr->lotag ^= 0x8000`). The map
 * itself is the save game — there is no separate door table.
 */
export const LOTAG_STATE_BIT = 0x8000;
/** operatesectors dispatches on `sptr->lotag&(0xffff-49152)`, i.e. the low 14. */
export const LOTAG_MASK = 0x3fff;

/** premap.c gives every sector this before the GPSPEED sprites are read. */
export const DEFAULT_SPEED = 256;

/**
 * Apply the parts of premap.c's level setup that this module depends on.
 *
 * `sector.extra` in the MAP file is NOT the door speed — E1L5 stores -1 in
 * every one of them. premap.c overwrites all of them with 256 and then lets
 * GPSPEED sprites override per sector:
 *
 *   for(i=0;i<numsectors;i++) sector[i].extra = 256;
 *   ...
 *   case GPSPEED: sector[SECT].extra = SLT; deletesprite(i); break;
 *
 * E1L5 has 80 of those, from 32 to 2556, so ignoring them would put nearly
 * every door in the level at the wrong speed.
 *
 * One deliberate difference: Build deletes the sprite and uDuke only marks it
 * `removed`. Sprite INDICES are how the probes and the renderer's stats refer
 * to sprites, and renumbering them would invalidate every recorded finding.
 * Everything that walks sprites has to honour the flag instead — nearTag below
 * does, and the renderer already skips tiles 1..10 as markers.
 */
export function setupLevel(map) {
  for (const sec of map.sectors) sec.extra = DEFAULT_SPEED;
  let applied = 0;
  for (const spr of map.sprites) {
    if (spr.picNum !== TILE.GPSPEED) continue;
    const sec = map.sectors[spr.sectNum];
    if (sec) { sec.extra = spr.lotag; applied++; }
    spr.removed = true;
  }
  // premap.c 862: the wall pass. A fan (FANSPRITE/FANSHADOW over a wall)
  // gets cstat 65 (blocking, hitscan). A force field (W_FORCEFIELD..+2
  // over a wall) gets cstat 85+256 — blocking, masked, one-way, hitscan,
  // translucent — unless its shade is over 31, which is a field that starts
  // OFF (cstat 0); and its lotag is copied to the twin wall, so a switch
  // finds both sides. A BIGFORCE is only listed for animation. Every wall's
  // extra is -1 (the "hit me" flag the fields use).
  let fields = 0;
  for (const wal of map.walls) {
    wal.extra = -1;
    const over = wal.overPicNum;
    if (over === 1096 || over === 1097) wal.cstat |= 65;           // FANSPRITE, FANSHADOW
    else if (over >= 663 && over <= 665) {
      if (wal.shade > 31) wal.cstat = 0; else wal.cstat |= 85 + 256;
      if (wal.lotag && wal.nextWall >= 0) map.walls[wal.nextWall].lotag = wal.lotag;
      fields++;
    }
  }
  return { speeds: applied, fields };
}

// --- the animation engine ----------------------------------------------------

/**
 * Build's animateptr/animategoal/animatevel/animatesect, as one object.
 *
 * The C version identifies what is moving by the ADDRESS of an int — a pointer
 * straight into the sector array — which is why setanimation can be handed
 * `&sptr->ceilingz` and later compare it against `&sector[n].floorz`. A
 * (sector, plane) pair is the same statement without the pointer, and it makes
 * `find` a comparison rather than an identity test.
 */
export class Animations {
  constructor() { this.list = []; }
  get count() { return this.list.length; }

  /** Build's getanimationgoal: the index, or -1 when that plane is at rest. */
  find(sect, plane) {
    return this.list.findIndex((a) => a.sect === sect && a.plane === plane);
  }

  /**
   * Build's setanimation. Replaces any animation already running on the same
   * plane rather than adding a second — that is what lets a door be reversed
   * mid-travel by operating it again.
   *
   * The sign of the velocity is decided here, from which way the goal lies,
   * so callers pass a speed and never a direction.
   */
  set(map, sect, plane, goal, speed) {
    const now = map.sectors[sect][plane];
    const vel = goal >= now ? speed : -speed;
    const i = this.find(sect, plane);
    if (i >= 0) { this.list[i].goal = goal; this.list[i].vel = vel; return i; }
    this.list.push({ sect, plane, goal, vel });
    return this.list.length - 1;
  }

  /** A wall coordinate under animation — `animateptr == &wall[i].x` in Build. */
  findWall(wall, axis) {
    return this.list.findIndex((a) => a.wall === wall && a.axis === axis);
  }

  /**
   * setanimation on a wall's x or y (the lotag-9 sliding door). Same
   * replace-not-stack rule, same sign rule; `sect` is the sector the
   * animation belongs to, for the door sound and getanimationgoal.
   */
  setWall(map, sect, wall, axis, goal, speed) {
    const now = map.walls[wall][axis];
    const vel = goal >= now ? speed : -speed;
    const i = this.findWall(wall, axis);
    if (i >= 0) { this.list[i].goal = goal; this.list[i].vel = vel; return i; }
    this.list.push({ sect, wall, axis, goal, vel });
    return this.list.length - 1;
  }
}

/** The value an animation entry points at, and its setter. */
const animGet = (map, a) => (a.wall !== undefined ? map.walls[a.wall][a.axis] : map.sectors[a.sect][a.plane]);
const animPut = (map, a, v) => { if (a.wall !== undefined) map.walls[a.wall][a.axis] = v; else map.sectors[a.sect][a.plane] = v; };

/**
 * Advance every running animation by one game frame.
 *
 * `v = animatevel[i]*TICSPERFRAME` — the step is per FRAME, not per second,
 * and the whole thing is integer. Reached goals are removed by swapping the
 * last entry down, exactly as the C does, which is why the loop counts
 * backwards.
 *
 * Returns the number still running, so a caller can tell a settled level from
 * a moving one without reaching inside.
 */
export function doAnimations(map, anims) {
  const list = anims.list;
  for (let i = list.length - 1; i >= 0; i--) {
    const a = list[i];
    const v = a.vel * TICS_PER_FRAME;
    const cur = animGet(map, a);

    if (cur === a.goal) {
      list[i] = list[list.length - 1];
      list.pop();
      continue;
    }

    const next = v > 0 ? Math.min(cur + v, a.goal)
      : Math.max(cur + v, a.goal);

    // A rising floor carries what is standing on it. Build lifts the player
    // and every sprite in the sector by the same v, which is why a lift does
    // not leave you behind or push you through its own floor.
    if (a.plane === 'floorZ') {
      for (const spr of map.sprites) {
        if (spr.sectNum === a.sect && !spr.removed) spr.z += v;
      }
    }

    animPut(map, a, next);
  }
  return list.length;
}

// --- where a door opens to ---------------------------------------------------

/**
 * engine.c's nextsectorneighborz: the neighbouring sector whose floor or
 * ceiling is the next one past `thez` in the given direction.
 *
 * This is how a door knows how far to open: it does not carry an "open height"
 * anywhere, it asks its neighbours. `topbottom` picks floor (1) or ceiling (0),
 * `direction` picks downward in z (1) or upward (-1).
 */
export function nextSectorNeighborZ(map, sectNum, thez, topbottom, direction) {
  let nextz = direction === 1 ? 0x7fffffff : -0x80000000;
  let found = -1;
  const sec = map.sectors[sectNum];
  const end = sec.wallPtr + sec.wallNum;
  for (let i = sec.wallPtr; i < end; i++) {
    const ns = map.walls[i].nextSector;
    if (ns < 0 || !map.sectors[ns]) continue;
    const testz = topbottom === 1 ? map.sectors[ns].floorZ : map.sectors[ns].ceilingZ;
    if (direction === 1) {
      if (testz > thez && testz < nextz) { nextz = testz; found = ns; }
    } else if (testz < thez && testz > nextz) { nextz = testz; found = ns; }
  }
  return found;
}

// --- operating a door --------------------------------------------------------

/**
 * Build's operatesectors, for the three plane-moving door lotags.
 *
 * Returns true when the sector was something this understands. The state bit
 * is flipped on every successful operation, so calling it twice closes what it
 * opened — including mid-travel, since Animations.set replaces rather than
 * stacks.
 */
export function operateSector(map, anims, sectNum, ext = null) {
  const started = operateSectorInner(map, anims, sectNum, ext);
  // sector.c: every door case of operatesectors() ends in callsound(sn, ii)
  // when the door sets off. The sound is the caller's business (it needs the
  // sound system), so it comes in as ext.callsound — and is called once per
  // operation here rather than in each of the nine cases.
  if (started && ext?.callsound) ext.callsound(sectNum);
  return started;
}

function operateSectorInner(map, anims, sectNum, ext = null) {
  const sec = map.sectors[sectNum];
  if (!sec) return false;
  const speed = sec.extra ?? DEFAULT_SPEED;

  switch (sec.lotag & LOTAG_MASK) {
    case LOTAG.SLIDING_DOOR_9: {
      // sector.c 598, lotag 9: the door that slides its own WALL POINTS —
      // no effector, no plane. The centre of the sector (the average of
      // its points) is found; the two points that share the centre's x or
      // y are the door's meeting edge, one per half. Speed is extra>>4.
      //
      // For a point sitting exactly on the centre (a closed door): its
      // opening direction is the side its two neighbours are on; the
      // three points (it, its predecessor, its point2) all travel the
      // length of the wall AFTER point2, i.e. into the side pocket. For a
      // point off the centre (an open door) the three come back: the point
      // to the centre, its neighbours to centre + the half-offset. Every
      // travel is a setanimation on one wall coordinate, and the operation
      // is not toggled by a state bit but by where the points stand.
      const start = sec.wallPtr, end = sec.wallPtr + sec.wallNum - 1;
      const sp = speed >> 4;
      let dax = 0, day = 0;
      for (let i = start; i <= end; i++) { dax += map.walls[i].x; day += map.walls[i].y; }
      dax = Math.trunc(dax / (end - start + 1));
      day = Math.trunc(day / (end - start + 1));
      const wallfind = [-1, -1];
      for (let i = start; i <= end; i++) {
        if (map.walls[i].x === dax || map.walls[i].y === day) {
          if (wallfind[0] === -1) wallfind[0] = i; else wallfind[1] = i;
        }
      }
      let started = false;
      for (let j = 0; j < 2; j++) {
        const wf = wallfind[j];
        if (wf < 0) continue;
        const w = map.walls[wf];
        let i = wf - 1; if (i < start) i = end;
        const p2 = w.point2, p3 = map.walls[p2].point2;
        if (w.x === dax && w.y === day) {
          let dax2 = ((map.walls[i].x + map.walls[p2].x) >> 1) - w.x;
          let day2 = ((map.walls[i].y + map.walls[p2].y) >> 1) - w.y;
          if (dax2 !== 0) {
            dax2 = map.walls[p3].x - map.walls[p2].x;
            anims.setWall(map, sectNum, wf, 'x', w.x + dax2, sp);
            anims.setWall(map, sectNum, i, 'x', map.walls[i].x + dax2, sp);
            anims.setWall(map, sectNum, p2, 'x', map.walls[p2].x + dax2, sp);
            started = true;
          } else if (day2 !== 0) {
            day2 = map.walls[p3].y - map.walls[p2].y;
            anims.setWall(map, sectNum, wf, 'y', w.y + day2, sp);
            anims.setWall(map, sectNum, i, 'y', map.walls[i].y + day2, sp);
            anims.setWall(map, sectNum, p2, 'y', map.walls[p2].y + day2, sp);
            started = true;
          }
        } else {
          const dax2 = ((map.walls[i].x + map.walls[p2].x) >> 1) - w.x;
          const day2 = ((map.walls[i].y + map.walls[p2].y) >> 1) - w.y;
          if (dax2 !== 0) {
            anims.setWall(map, sectNum, wf, 'x', dax, sp);
            anims.setWall(map, sectNum, i, 'x', dax + dax2, sp);
            anims.setWall(map, sectNum, p2, 'x', dax + dax2, sp);
            started = true;
          } else if (day2 !== 0) {
            anims.setWall(map, sectNum, wf, 'y', day, sp);
            anims.setWall(map, sectNum, i, 'y', day + day2, sp);
            anims.setWall(map, sectNum, p2, 'y', day + day2, sp);
            started = true;
          }
        }
      }
      return started;
    }

    case LOTAG.PLATFORM_DOWN:
    case LOTAG.PLATFORM_UP: {
      // sector.c 164 (16, 17): a platform — the floor alone travels, to the
      // nearest neighbour floor BELOW it if there is one, else to the nearest
      // above; nothing while it is already moving. The ceiling stays.
      if (anims.find(sectNum, 'floorZ') >= 0) return false;
      let n = nextSectorNeighborZ(map, sectNum, sec.floorZ, 1, 1);
      if (n < 0) n = nextSectorNeighborZ(map, sectNum, sec.floorZ, 1, -1);
      if (n < 0) return false;
      anims.set(map, sectNum, 'floorZ', map.sectors[n].floorZ, speed);
      return true;
    }

    case LOTAG.ELEVATOR_DOWN:
    case LOTAG.ELEVATOR_UP: {
      // sector.c 189 (18, 19): an elevator — floor and ceiling travel
      // together, keeping their distance, to the nearest neighbour floor
      // ABOVE if there is one, else the nearest below.
      if (anims.find(sectNum, 'floorZ') >= 0) return false;
      let n = nextSectorNeighborZ(map, sectNum, sec.floorZ, 1, -1);
      if (n < 0) n = nextSectorNeighborZ(map, sectNum, sec.floorZ, 1, 1);
      if (n < 0) return false;
      const goal = map.sectors[n].floorZ;
      const height = sec.ceilingZ - sec.floorZ;
      anims.set(map, sectNum, 'floorZ', goal, speed);
      anims.set(map, sectNum, 'ceilingZ', goal + height, speed);
      return true;
    }

    case LOTAG.CEILING_DOOR: {
      // Open: lift the ceiling to the next one above. Closed: drop it to the
      // sector's own floor. Build reaches the second case through a goto that
      // sets the state bit and re-enters, having found no neighbour at all —
      // the fallback and the closed case are the same code there.
      let goal;
      if (sec.lotag & LOTAG_STATE_BIT) {
        goal = sec.floorZ;
      } else {
        const n = nextSectorNeighborZ(map, sectNum, sec.ceilingZ, 0, -1);
        if (n >= 0) goal = map.sectors[n].ceilingZ;
        else { sec.lotag |= LOTAG_STATE_BIT; goal = sec.floorZ; }
      }
      sec.lotag ^= LOTAG_STATE_BIT;
      anims.set(map, sectNum, 'ceilingZ', goal, speed);
      return true;
    }

    case LOTAG.FLOOR_DOOR: {
      // The floor drops away to the next floor below and comes back up to the
      // ceiling. Already running: only the goal is rewritten, and the state
      // bit is deliberately NOT flipped — Build reverses a moving floor door
      // without changing what it thinks its state is.
      const i = anims.find(sectNum, 'floorZ');
      if (i >= 0) {
        const a = anims.list[i];
        if (a.goal === sec.ceilingZ) {
          const n = nextSectorNeighborZ(map, sectNum, sec.ceilingZ, 1, 1);
          a.goal = n >= 0 ? map.sectors[n].floorZ : sec.floorZ;
        } else {
          a.goal = sec.ceilingZ;
        }
        a.vel = a.goal >= sec.floorZ ? Math.abs(a.vel) : -Math.abs(a.vel);
        return true;
      }
      let goal;
      if (sec.ceilingZ === sec.floorZ) {
        const n = nextSectorNeighborZ(map, sectNum, sec.ceilingZ, 1, 1);
        goal = n >= 0 ? map.sectors[n].floorZ : sec.floorZ;
      } else {
        goal = sec.ceilingZ;
      }
      sec.lotag ^= LOTAG_STATE_BIT;
      anims.set(map, sectNum, 'floorZ', goal, speed);
      return true;
    }

    case LOTAG.SPLIT_DOOR: {
      // Both planes at once. Closing meets in the middle rather than at either
      // plane — `q = (ceilingz+floorz)>>1` — which is what makes the two
      // halves land together whatever their travel.
      if (sec.lotag & LOTAG_STATE_BIT) {
        const q = (sec.ceilingZ + sec.floorZ) >> 1;
        anims.set(map, sectNum, 'floorZ', q, speed);
        anims.set(map, sectNum, 'ceilingZ', q, speed);
      } else {
        const nf = nextSectorNeighborZ(map, sectNum, sec.floorZ, 1, 1);
        if (nf >= 0) anims.set(map, sectNum, 'floorZ', map.sectors[nf].floorZ, speed);
        const nc = nextSectorNeighborZ(map, sectNum, sec.ceilingZ, 0, -1);
        if (nc >= 0) anims.set(map, sectNum, 'ceilingZ', map.sectors[nc].ceilingZ, speed);
      }
      sec.lotag ^= LOTAG_STATE_BIT;
      return true;
    }

    case LOTAG.SPLIT_SLIDE_DOOR: {
      // sector.c 581, lotag 26, "the split doors": only when the ceiling has
      // stopped, the sector is run as a split door (22) and then as a wall
      // sliding door (9), and put back to 26. Build silences the first of
      // the two sounds (haltsoundhack); here the sound is one call anyway.
      if (anims.find(sectNum, 'ceilingZ') !== -1) return false;
      const keep = sec.lotag;
      sec.lotag = (keep & 0xff00) | LOTAG.SPLIT_DOOR;
      operateSectorInner(map, anims, sectNum, ext);
      sec.lotag = (sec.lotag & 0xff00) | LOTAG.SLIDING_DOOR_9;
      operateSectorInner(map, anims, sectNum, ext);
      sec.lotag = (sec.lotag & 0xff00) | LOTAG.SPLIT_SLIDE_DOOR;
      return true;
    }

    case LOTAG.TEETH_DOOR: {
      // sector.c 756, lotag 29: the ceiling goes to the next floor above
      // (open state) or the next ceiling below, at the sector's extra; every
      // SE 22 of the sector's hitag is armed (its own sector's extra negated,
      // t[0] = this sector, t[1] = 1) — effector.js's part, through `ext`.
      let goal;
      if (sec.lotag & LOTAG_STATE_BIT) {
        const n = nextSectorNeighborZ(map, sectNum, sec.ceilingZ, 1, 1);
        goal = n >= 0 ? map.sectors[n].floorZ : sec.ceilingZ;
      } else {
        const n = nextSectorNeighborZ(map, sectNum, sec.ceilingZ, -1, -1);
        goal = n >= 0 ? map.sectors[n].ceilingZ : sec.ceilingZ;
      }
      if (ext) ext(map, sectNum, LOTAG.TEETH_DOOR);
      sec.lotag ^= LOTAG_STATE_BIT;
      anims.set(map, sectNum, 'ceilingZ', goal, sec.extra);
      return true;
    }

    default:
      // Everything else is somebody else's case. `ext` is how effector.js
      // supplies lotag 25 without this module having to know about effectors —
      // operatesectors in Build reaches straight into hittype[] for that, and
      // one import in that direction would make the two files a cycle.
      return ext ? !!ext(map, sectNum, sec.lotag & LOTAG_MASK) : false;
  }
}

// --- finding what the player is pointing at ----------------------------------

/** engine.c's lintersect, two segments, without the z it does not need here. */
function lintersect(x1, y1, x2, y2, x3, y3, x4, y4) {
  const x21 = x2 - x1, x34 = x3 - x4, y21 = y2 - y1, y34 = y3 - y4;
  const bot = x21 * y34 - y21 * x34;
  const x31 = x3 - x1, y31 = y3 - y1;
  const topt = x31 * y34 - y31 * x34;
  const topu = x21 * y31 - y21 * x31;
  if (bot >= 0) {
    if (bot === 0) return null;
    if (topt < 0 || topt >= bot) return null;
    if (topu < 0 || topu >= bot) return null;
  } else {
    if (topt > 0 || topt <= bot) return null;
    if (topu > 0 || topu <= bot) return null;
  }
  const t = Math.trunc((topt * 2 ** 24) / bot);
  return { x: x1 + Math.floor((x21 * t) / 2 ** 24), y: y1 + Math.floor((y21 * t) / 2 ** 24) };
}

// Build's sintable, in the two forms neartag needs. The engine's is a 2048-step
// table at amplitude 16384; a cosine here is the same table 512 steps along.
const buildSin = (a) => Math.round(Math.sin(((a & 2047) * Math.PI) / 1024) * 16384);

/**
 * engine.c's neartag: what lies within `range` straight ahead that carries a
 * tag.
 *
 * It is a portal walk and not a hitscan — it steps through neighbouring
 * sectors, and each wall it crosses can shorten the ray. `tagsearch` bit 0
 * looks at lotags, bit 1 at hitags; the "use" key wants bit 0.
 *
 * A tagged SECTOR is reported through the wall that leads into it, which is
 * why a door is opened by facing the wall of the door sector rather than by
 * standing in it.
 *
 * The SPRITE arm needs the eye height and the tile's dimensions — a sprite is
 * only reachable if the ray passes through the rectangle it occupies. Without
 * an `art` accessor it is skipped, and skipping it costs the switches: E1L5's
 * 39 switches are all wall-aligned SPRITES, not tagged walls, so a nearTag
 * without art finds none of them.
 */
export function nearTag(map, xs, ys, zs, sectNum, ang, range, tagsearch = 1, art = null) {
  const out = { sector: -1, wall: -1, sprite: -1, dist: 0 };
  if (sectNum < 0 || tagsearch < 1 || tagsearch > 3) return out;

  const sinA = buildSin(ang + 2560), cosA = buildSin(ang + 2048);
  const vx = Math.floor((sinA * range) / 16384);
  const vy = Math.floor((cosA * range) / 16384);
  let xe = xs + vx, ye = ys + vy;
  const scale = (a, b, c) => Math.trunc((a * b) / c);

  const list = [sectNum];
  let cnt = 0;
  do {
    const dasect = list[cnt];
    const sec = map.sectors[dasect];
    const end = sec.wallPtr + sec.wallNum;
    for (let z = sec.wallPtr; z < end; z++) {
      const wal = map.walls[z];
      const wal2 = map.walls[wal.point2];
      if (!wal2) continue;
      const x1 = wal.x, y1 = wal.y, x2 = wal2.x, y2 = wal2.y;
      const ns = wal.nextSector;

      let good = 0;
      if (ns >= 0 && map.sectors[ns]) {
        if ((tagsearch & 1) && map.sectors[ns].lotag) good |= 1;
        if ((tagsearch & 2) && map.sectors[ns].hitag) good |= 1;
      }
      if ((tagsearch & 1) && wal.lotag) good |= 2;
      if ((tagsearch & 2) && wal.hitag) good |= 2;

      if (good === 0 && ns < 0) continue;
      // Facing test: a wall is only reached from its front.
      if ((x1 - xs) * (y2 - ys) < (x2 - xs) * (y1 - ys)) continue;

      const hit = lintersect(xs, ys, xe, ye, x1, y1, x2, y2);
      if (!hit) continue;

      if (good !== 0) {
        if (good & 1) out.sector = ns;
        if (good & 2) out.wall = z;
        out.dist = Math.floor(((hit.x - xs) * sinA + (hit.y - ys) * cosA) / 16384);
        // The ray is shortened to the tag just found, so a nearer tag behind
        // one already seen still wins and a further one cannot.
        xe = hit.x; ye = hit.y;
      }
      if (ns >= 0 && !list.includes(ns)) list.push(ns);
    }

    // Sprites in the same sector. Build walks headspritesect; uDuke has no
    // per-sector lists, so this filters — 1068 sprites over a handful of
    // sectors, which is nothing beside the wall loop above.
    if (art) {
      for (let z = 0; z < map.sprites.length; z++) {
        const spr = map.sprites[z];
        if (spr.sectNum !== dasect || spr.removed) continue;
        let good = 0;
        if ((tagsearch & 1) && spr.lotag) good = 1;
        if ((tagsearch & 2) && spr.hitag) good = 1;
        if (!good) continue;

        const topt = vx * (spr.x - xs) + vy * (spr.y - ys);
        if (topt <= 0) continue;                       // behind
        const bot = vx * vx + vy * vy;
        if (bot === 0) continue;

        const tile = art.get(spr.picNum);
        if (!tile) continue;
        // vz is 0 here, so the ray stays at eye height and the z test is just
        // "is the eye within the sprite's band". cstat bit 7 centres it.
        const h = tile.height * spr.yRepeat;
        let z1 = spr.z;
        if (spr.cstat & 128) z1 += h << 1;
        if (!(zs <= z1 && zs >= z1 - (h << 2))) continue;

        // How far the ray passes to one side, against half the sprite's width.
        const topu = vx * (spr.y - ys) - vy * (spr.x - xs);
        const offx = scale(vx, topu, bot), offy = scale(vy, topu, bot);
        const w = tile.width * spr.xRepeat;
        if (offx * offx + offy * offy > ((w * w) >> 7)) continue;

        const intx = xs + scale(vx, topt, bot), inty = ys + scale(vy, topt, bot);
        if (Math.abs(intx - xs) + Math.abs(inty - ys)
            >= Math.abs(xe - xs) + Math.abs(ye - ys)) continue;
        out.sprite = z;
        out.dist = Math.floor(((intx - xs) * sinA + (inty - ys) * cosA) / 16384);
        xe = intx; ye = inty;
      }
    }
    cnt++;
  } while (cnt < list.length);

  return out;
}

/**
 * The "use" key: what checksectors() in sector.c does with space.
 *
 * Build's range is 1280. The sprite half of checksectors (cameras, respawns)
 * is not reproduced, and neither is the key-card check.
 *
 * Returns the sector operated, or -1.
 */
export function useKey(map, anims, x, y, z, sectNum, ang, range = 1280, ext = null,
                       art = null) {
  const tag = useProbe(map, x, y, z, sectNum, ang, range, art);
  // checksectors(), sector.c 3054/3233: with nothing tagged in reach, or
  // with a tagged sector that is no near-operator, the sector the player
  // STANDS in is operated when it is an under-operator (a platform, an
  // elevator, a split door) — riding a lift up again from inside it, or
  // the way out of a shaft. Not when an activator or master switch lives
  // in that sector: those belong to a switch.
  const own = map.sectors[sectNum];
  const underOwn = own && isUnderOperator(own.lotag) && !(own.lotag & 16384) && !hasActivator(map, sectNum);
  if (tag.sector < 0) {
    if (tag.sprite < 0 && tag.wall < 0 && underOwn) return operateSector(map, anims, sectNum, ext) ? sectNum : -1;
    return -1;
  }
  // sector.c 3220/3241: a LOCKED sector (lotag & 16384 — an ACTIVATORLOCKED
  // lives in it, or a switch locked it) is not operated by hand; only its
  // switch, through the activators, gets it moving. Nor is a sector that
  // holds an activator or master switch.
  const near = map.sectors[tag.sector];
  if (near.lotag & 16384) return -1;
  if (isNearOperator(near.lotag) && hasActivator(map, tag.sector)) return -1;
  // sector.c 3220: only a NEAR-OPERATOR lotag is operated by hand. A tagged
  // sector that is none (a rotate-rise 30, a water 1/2, a secret) is
  // passed over — the use falls through to the player's own sector, or to
  // nothing. This used to operate it anyway, and a Space in front of one
  // opening of E1L3's revolving door turned that single segment alone.
  if (!isNearOperator(near.lotag)) return underOwn ? (operateSector(map, anims, sectNum, ext) ? sectNum : -1) : -1;
  return operateSector(map, anims, tag.sector, ext) ? tag.sector : -1;
}

/** sector.c 156: the sectors a player operates by standing in them. */
export const isUnderOperator = (lotag) => [15, 16, 17, 18, 19, 22, 26].includes(lotag & 0xff);
/** sector.c 172: the sectors a player operates by facing them. */
export const isNearOperator = (lotag) => [9, 15, 16, 17, 18, 19, 20, 21, 22, 23, 25, 26, 29].includes(lotag & 0xff);
const hasActivator = (map, sectNum) => map.sprites.some((sp) => !sp.removed && sp.sectNum === sectNum && (sp.picNum === 2 || sp.picNum === 8));

/**
 * checksectors()'s probe ladder: the eye, then 8 and then 16 units below it.
 *
 *   neartag(posx,posy,posz,          ...,1280,1);
 *   if (nothing) neartag(...,posz+(8<<8), ...,1280,1);
 *   if (nothing) neartag(...,posz+(16<<8),...,1280,1);
 *
 * This used to be one probe with a comment claiming the retries were
 * reproduced. They were not, and the cost was concrete: E1L5's switch 688,
 * which drives the rise bridges 104 and 105, sits 7168 z-units below the eye
 * and its top is still 3072 short of it. A single probe misses it from
 * everywhere in the room — the switch simply could not be operated, and it read
 * as "there is nothing here" rather than as a missing feature.
 *
 * Two callers need this rather than one, because the pages probe for a switch
 * sprite before falling through to useKey; having them do their own single
 * nearTag is how the ladder got skipped in the first place.
 */
export function useProbe(map, x, y, z, sectNum, ang, range = 1280, art = null) {
  let tag = nearTag(map, x, y, z, sectNum, ang, range, 1, art);
  for (const dz of [8 << 8, 16 << 8]) {
    if (tag.sprite >= 0 || tag.wall >= 0 || tag.sector >= 0) break;
    tag = nearTag(map, x, y, z + dz, sectNum, ang, range, 1, art);
  }
  return tag;
}

/** names.h: the two explosive canisters that share one spawn case. */
export const SEENINE = 1247, OOZFILTER = 1079;

/**
 * The sprite half of game.c's spawn(), for the cases that change what is drawn.
 *
 *   case SEENINE: case OOZFILTER:
 *       sp->shade = -16;
 *       if(sp->xrepeat <= 8) { sp->cstat = 32768; sp->xrepeat = sp->yrepeat = 0; }
 *       else sp->cstat = 1+256;
 *       sp->extra = impact_damage<<2;
 *       sp->owner = i;
 *
 * A SEENINE with a repeat of 8 or less is a charge hidden inside a wall or
 * floor, waiting behind a crack — Duke makes it invisible AND zeroes its size,
 * two independent ways of not drawing it. Without this step they are drawn:
 * 61 orange slivers along E3L11's platform, 127 in E1L5, 10 in E1L3. They look
 * like a renderer fault and are a missing spawn rule.
 *
 * Note `cstat = 1+256` is an ASSIGNMENT, not an or — a visible canister has
 * exactly blocking and hitscan set, whatever the map said.
 *
 * `extra = impact_damage<<2` is not reproduced: impact_damage is a CON
 * variable and there is no damage here. `owner = i` is, because it costs
 * nothing and something later will want it.
 *
 * Returns how many sprites were hidden.
 */
/** names.h MASKWALL1..15. */
export const MASKWALL_TILES = new Set([285, 913, 914, 915, 514, 1059, 1174, 1124, 255, 387, 391, 609, 830, 988, 1024]);

export function setupSprites(map) {
  let hidden = 0;
  map.sprites.forEach((spr, i) => {
    if (spr.removed) return;
    // game.c 4083: a MASKWALL sprite keeps only its alignment and flips
    // (cstat & 60) and is made blocking (| 1), statnum 0. The bars of a
    // cell gate are such a sprite (E4L3, #340 in sector 140, placed with
    // cstat 16 alone) — without this the player and every actor walked
    // straight through them.
    if (MASKWALL_TILES.has(spr.picNum)) { spr.cstat = (spr.cstat & 60) | 1; return; }
    if (spr.picNum !== SEENINE && spr.picNum !== OOZFILTER) return;
    spr.shade = -16;
    if (spr.xRepeat <= 8) {
      spr.cstat = 0x8000;
      spr.xRepeat = 0;
      spr.yRepeat = 0;
      hidden++;
    } else {
      spr.cstat = 1 + 256;
    }
    spr.owner = i;
  });
  return hidden;
}
