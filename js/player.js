// Cache tripwire: every module carries the stage it shipped with, and boot.js
// refuses to run a mix. A browser that re-fetched one file and kept another
// from its cache showed up as 'HEALTH undefined' — a field the stale
// player.js did not have. That is the third stale-cache report; this makes
// the fourth say which file.
export const MODULE_STAGE = 'stage12.196';

// uDuke - the player's vertical physics.
//
// This replaces an invention. Duke's is not an easing: it is a HALVING with a
// dead band, a velocity that bleeds off separately, and a fall that accelerates
// by a fixed amount per tic. The difference shows the moment you step off
// anything.
//
// All of it is per TIC, never per second, and integer — the same reasoning as
// the animation engine. Source: player.c, processinput().

import { getZRange, CLIPMASK0 } from './clip.js';
import { getZsOfSlope } from './map.js';
import { TICS_PER_FRAME, LOTAG_MASK } from './sector.js';
import { krand } from './effector.js';

/**
 * Gravity per tic. player.c adds `gc+80` while falling, and `gc` is the CON
 * variable GRAVITATIONALCONSTANT, defaulting to 176 (gamedef.c). So 256, which
 * looks like a round number chosen on purpose and is in fact two numbers.
 */
export const GRAVITY = 176 + 80;
/** `if(p->poszv >= (4096+2048)) p->poszv = (4096+2048);` */
export const TERMINAL_VELOCITY = 4096 + 2048;
/** The eye above the floor: `i = 40`, and the eye at `fz-(i<<8)`. */
export const EYE_HEIGHT = 40 << 8;
/** `if(p->posz < (cz+(4<<8)))` — the headroom the eye keeps. */
export const CEIL_CLEARANCE = 4 << 8;
/** Crouch pushes the eye down by this much every tic it is held. */
export const CROUCH_STEP = 2048 + 768;
/** A jump needs this much floor-to-ceiling: `if( (fz-cz) > (56<<8) )`. */
export const JUMP_HEADROOM = 56 << 8;
/** The jump impulse runs while the counter is under this, stepping by 180. */
export const JUMP_LIMIT = 1024 + 256, JUMP_STEP = 180;
/** Below this the settle is treated as arrived: `if( klabs(k) < 256 ) k = 0;` */
export const SETTLE_DEAD_BAND = 256;
/** Standing still, the eye bleeds vertical speed at this rate. */
export const GROUND_DRAG = 768;
/** `if(p->posz >= (fz-(i<<8)-(16<<8)))` — how far a slope may snap the eye. */
export const SLOPE_SNAP = 16 << 8;

/** Build's sintable: 2048 steps, amplitude 16384. */
const bsin = (a) => Math.round(Math.sin(((a & 2047) * Math.PI) / 1024) * 16384);

/** The mutable half of a player. Position lives with the caller's camera. */
/** duke3d.h 280: the weapon slots. */
export const WEAPON = { KNEE: 0, PISTOL: 1, SHOTGUN: 2, CHAINGUN: 3, RPG: 4, HANDBOMB: 5,
  SHRINKER: 6, DEVISTATOR: 7, TRIPBOMB: 8, FREEZE: 9, GROW: 11 };
/** The inventory slots addinventory/ifpinventory name (GET_*). */
export const GET = { STEROIDS: 0, SHIELD: 1, SCUBA: 2, HOLODUKE: 3, JETPACK: 4, ACCESS: 6,
  HEATS: 7, FIRSTAID: 9, BOOTS: 10 };

export function newPlayerState(maxHealth = 100, maxAmmo = 200) {
  const st = { zVel: 0, onGround: true, jumpCounter: 0, jumpToggle: 0, fallCounter: 0,
    xVel: 0, yVel: 0, turnHeldTime: 0, pyCount: 0,
    // Build's transporter_hold and on_warping_sector; see moveTransports.
    transportHold: 0, onWarpingSector: false,
    // sprite[ps[p].i].extra — the health, from gamestartup's MAXPLAYERHEALTH.
    // painTime is pals_time: the red flash after a hit, counting down.
    health: maxHealth, maxHealth, painTime: 0, lastHitBy: -1,
    // premap.c 549: knee and pistol owned, 48 rounds; max_ammo_amount[] from
    // gamestartup (an array of 12, the pistol's at slot 1). `god` is ud.god.
    gotWeapon: Uint8Array.from([1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    ammoAmount: Int32Array.from([0, 48, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    maxAmmoAmount: Array.isArray(maxAmmo) ? Int32Array.from(maxAmmo) : Int32Array.from([0, maxAmmo, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    currWeapon: 1, god: false,
    // shield_amount (armour) and the inventory the CON's GET_* slots fill.
    shield: 0, inventory: { steroids: 0, scuba: 0, holoduke: 0, jetpack: 0, heat: 0, firstaid: 0, boots: 0, access: 0 },
    // quote N: the line and how long it stays; palfrom: a screen flash.
    quote: -1, quoteTime: 0, pal: { time: 0, r: 0, g: 0, b: 0 },
    // player.c: crack_time counts down from 777 while the player is idle and
    // is put back to 777 by any move, turn, shot, jump or crouch; at zero
    // knuckle_incs starts, and ten tics later Duke cracks his knuckles and
    // says one of two lines. 26 seconds of standing still.
    crackTime: 777, knuckleIncs: 0,
    // displayweapon(): weapon_pos runs -1..-9 (the old gun sinks), then 10..0
    // (the new one rises); last_weapon is what is drawn while it sinks;
    // weapon_sway is the bob counter while walking, easing back to 1024 at
    // rest; bobCounter climbs with the distance walked; hardLanding lowers it.
    weaponPos: 0, lastWeapon: -1, weaponSway: 1024, bobCounter: 1024, hardLanding: 0,
    // jetpack_on: 0 off, 1..10 the lift-off ramp, 11 cruising.
    jetpackOn: 0,
    // newowner: the CAMERA1 the view is drawn from, or -1.
    newOwner: -1,
    // heat_on: the night vision goggles.
    heatOn: false,
    // checksectors' ways out: timebeforeexit (a lotag -2 sector: 26*8 tics to
    // the end), its exit sound, and the secrets found.
    timeBeforeExit: 0, customExitSound: -1, secretRooms: 0,
    // tipincs: the hand with the bill, 26 tics from CON `tip`.
    tipIncs: 0,
    // Under water: scuba_on, the air left without it (15*26 tics), and
    // extra_extra8 — damage owed in eighths, taken by incurDamage.
    scubaOn: false, airLeft: 15 * 26, extraExtra8: 0,
    // hurt_delay: the pause between force-field / cactus stings.
    hurtDelay: 0,
    // dead_flag: 0 alive, else the roll of the dying view; deadCount the tics since.
    deadFlag: 0, deadCount: 0, deadSquished: false,
    // The shrink: -1 not shrinking, else the APLAYER script's count since the spark.
    shrinkCount: -1,
    // on_crane: the CRANE sprite carrying the player, else -1 (no walking, no falling).
    onCrane: -1,
    // footprintcount/pal/shade: prints still to leave (wet ones from wading, a pool's colour).
    footprintCount: 0, footprintPal: 0, footprintShade: 0,
    // holoduke_on: the hologram sprite while the holoduke is out, else -1.
    holodukeOn: -1,
    // somethingonplayer: the GREENSLIME riding the player's face, else -1; firing: the fire button this tic.
    somethingOnPlayer: -1, firing: false,
    // inven_icon: the inventory item the status bar shows (1 medkit .. 7 boots), 0 none.
    invenIcon: 0 };
  // `ammo` and `maxAmmo` as the pistol's, for the HUD and pistolTic — the
  // magazine that existed before there were other weapons.
  Object.defineProperty(st, 'ammo', { get() { return st.ammoAmount[1]; }, set(v) { st.ammoAmount[1] = v; }, enumerable: true });
  Object.defineProperty(st, 'maxAmmo', { get() { return st.maxAmmoAmount[1]; }, enumerable: true });
  return st;
}

/** addammo(weapon, p, amount), player.c: add and clamp to the maximum. */
export function addAmmo(st, weapon, amount) {
  st.ammoAmount[weapon] += amount;
  if (st.ammoAmount[weapon] > st.maxAmmoAmount[weapon]) st.ammoAmount[weapon] = st.maxAmmoAmount[weapon];
}

/**
 * addweapon(p, weapon) / a weapon key: own it and switch to it. actors.c
 * 123: `weapon_pos = -1; last_weapon = curr_weapon; curr_weapon = weapon;
 * kickback_pic = 0` — the old gun sinks, then the new one rises.
 */
export function addWeapon(st, weapon) {
  st.gotWeapon[weapon] = 1;
  if (st.currWeapon !== weapon) {
    st.weaponPos = -1;
    st.lastWeapon = st.currWeapon;
    st.currWeapon = weapon;
    st.kickback = 0;
  }
}

/**
 * One tic of the raise/lower animation (player.c 3522) and the sway
 * (player.c 2748): `moved` is the distance walked this tic.
 */
export function weaponPosTic(st, moved = 0) {
  if (st.weaponPos !== 0) {
    if (st.weaponPos === -9) {
      if (st.lastWeapon >= 0) { st.weaponPos = 10; st.lastWeapon = -1; }
      else st.weaponPos = 10;
    } else st.weaponPos--;
  }
  if (moved < 32 || !st.onGround) {
    const w = st.weaponSway & 2047;
    if (w > 1024 + 96) st.weaponSway -= 96;
    else if (w < 1024 - 96) st.weaponSway += 96;
    else st.weaponSway = 1024;
  } else st.weaponSway = st.bobCounter;
  if (st.onGround) st.bobCounter += moved >> 1;
}

/**
 * The idle timer, one tic. `active` is true on a tic with movement, turning,
 * firing, jumping or crouching (player.c 333, 2881, 2887, 3054, 3138, 3231,
 * 3557 — each of them `crack_time = 777`). Returns 'crack' on the one tic
 * the line should play (knuckle_incs == 10), else null.
 */
export function idleTic(st, active) {
  if (active) st.crackTime = 777;
  if (st.crackTime > 0) {
    st.crackTime--;
    if (st.crackTime === 0) { st.knuckleIncs = 1; st.crackTime = 777; }
  }
  if (st.knuckleIncs) {
    st.knuckleIncs++;
    if (st.knuckleIncs === 10) return 'crack';
    if (st.knuckleIncs === 22) st.knuckleIncs = 0;
  }
  return null;
}

/**
 * One tic of vertical movement.
 *
 * `p` carries `{ z }` and is written in place; `st` is the state from
 * newPlayerState(); `zr` is a getZRange result; `input` is `{ jump, crouch }`.
 * `sloped` says whether the sector under the player has a sloped floor, which
 * only affects whether a small gap is snapped shut instead of fallen through.
 *
 * Returns `{ landed, hitCeiling, fell }` so a caller can react without reading
 * the state back out — landing is where Duke plays a sound and takes damage,
 * neither of which exists yet.
 */
export function movePlayerZ(p, st, zr, input = {}, sloped = false) {
  const fz = zr.florZ, cz = zr.ceilZ;
  const target = fz - EYE_HEIGHT;
  const jump = !!input.jump, crouch = !!input.crouch;
  let landed = false, hitCeiling = false;

  // Under water — sector lotag 2 — is a different set of rules entirely, not
  // a modified version of the ones below. There is no gravity in it at all.
  if (input.water) return swimZ(p, st, fz, cz, jump, crouch);

  if (p.z < target) {
    // Above the floor. A small gap over a SLOPED floor is closed rather than
    // fallen through, but only with no key held — walking up a ramp should not
    // feel like a series of tiny falls.
    if (!jump && !crouch && st.onGround && sloped && p.z >= target - SLOPE_SNAP) {
      p.z = target;
    } else {
      st.onGround = false;
      st.zVel += GRAVITY;
      if (st.zVel >= TERMINAL_VELOCITY) st.zVel = TERMINAL_VELOCITY;
      if (st.zVel > 2400 && st.fallCounter < 255) {
        st.fallCounter++;
        // player.c 2977: at the 38th tic of a fast fall Duke screams; the
        // voice is kept (scream_voice) to be cut on landing, death or the
        // jetpack. The page plays and stops it.
        if (st.fallCounter === 38) st.screamStart = true;
      }
      // Build only plays sounds and deals damage here; the position is not
      // clamped, which is why a hard landing visibly sinks in and rises back.
      if (p.z + st.zVel >= target) { landed = true; st.landingVel = st.zVel; }
    }
  } else {
    st.fallCounter = 0;
    // player.c 3009: on the ground the scream is stopped.
    if (st.screaming) st.screamStop = true;
    // player.c 3024: arriving (on_ground was 0) faster than 3072 on dry land
    // — not in a lotag 1 or 2 sector — is a hard landing of poszv >> 10: the
    // view dips (pitchTic) and the gun drops (weaponview) while it counts down.
    if (input.lotag !== 1 && input.lotag !== 2 && !st.onGround && st.zVel > (6144 >> 1)) st.hardLanding = st.zVel >> 10;
    st.onGround = true;

    // Settling is a HALVING with a dead band, not an easing: half the gap per
    // tic until the last 256 units, then nothing. A rate-based ease reaches a
    // step in a time that depends on the frame rate; this reaches it in a
    // number of tics that depends on nothing.
    if (input.surface) {
      // "Smooth on the water" — a different target and no dead band, and the
      // drag is not applied either; Build's second branch, not a variation of
      // the first.
      p.z += ((fz - (WADE_EYE << 7)) - p.z) >> 1;
      if (!st.onWarpingSector && p.z > fz - WADE_CLAMP) {
        p.z = fz - WADE_CLAMP;
        st.zVel >>= 1;
      }
    } else {
      let k = (target - p.z) >> 1;
      if (Math.abs(k) < SETTLE_DEAD_BAND) k = 0;
      p.z += k;
      st.zVel -= GROUND_DRAG;
      if (st.zVel < 0) st.zVel = 0;
    }

    if (crouch) p.z += CROUCH_STEP;

    // Jump. The toggle stops a held key from re-triggering, and the headroom
    // test stops a jump that would only bang the eye into the ceiling.
    if (!jump && st.jumpToggle === 1) st.jumpToggle = 0;
    else if (jump && st.jumpToggle === 0 && st.jumpCounter === 0 && (fz - cz) > JUMP_HEADROOM) {
      st.jumpCounter = 1;
      st.jumpToggle = 1;
    }
    if (st.jumpCounter && !jump) st.jumpToggle = 0;
  }

  if (st.jumpCounter) {
    if (st.jumpCounter < JUMP_LIMIT) {
      // The impulse is a slice of the sine table rather than a constant, so
      // the push tails off — the counter walks 1, 181, 361 ... through it.
      st.zVel -= Math.trunc(bsin(2048 - 128 + st.jumpCounter) / 12);
      st.jumpCounter += JUMP_STEP;
      st.onGround = false;
    } else {
      st.jumpCounter = 0;
      st.zVel = 0;
    }
  }

  p.z += st.zVel;

  if (p.z < cz + CEIL_CLEARANCE) {
    st.jumpCounter = 0;
    hitCeiling = st.zVel < 0;      // Build also kills horizontal speed here
    st.zVel = 128;
    p.z = cz + CEIL_CLEARANCE;
  }

  return { landed, hitCeiling, fell: !st.onGround };
}

/**
 * Where the eye sits when you are put down at a point.
 *
 * NOT `sector.floorZ - EYE_HEIGHT`. The floor you actually stand on is the one
 * getZRange finds, which reaches through portals and can belong to a
 * neighbouring sector: at 7506,50660 in E1L5 the camera is in sector 125, whose
 * floor is 232448, while the floor under its feet is sector 248's at 225280 —
 * 7168 units higher, a step.
 *
 * Getting this wrong is not a cosmetic drop. It moved the eye 6720 units off,
 * which is enough for checksectors' probe ladder to miss a switch entirely, and
 * cost a round of "the use key is broken" when the use key was fine and the
 * viewpoint was not.
 */
export function eyeZAt(map, x, y, sectNum, walldist = 164) {
  // 164 is player.c's clipmove walldist, the same number the pages already pass
  // when they move; a different one here would seat the eye on a floor the
  // player could not stand on.
  //
  // getZRange's answer depends on the z you hand it — it is a query about a
  // point in space, not about a column — so it needs a starting height, and
  // passing 0 is not "unspecified", it is "at Build's zero", which at 7506,50660
  // in E1L5 answers with a floor 7168 units off. Start from the sector's own
  // floor, then let the range correct it.
  const sec = map.sectors[sectNum];
  if (!sec) return 0;
  const guess = sec.floorZ - EYE_HEIGHT;
  const zr = getZRange(map, x, y, guess, sectNum, walldist, CLIPMASK0);
  return zr.florZ - EYE_HEIGHT;
}

/**
 * Duke's horizontal friction, applied as `mulscale(posxv, dukefriction, 16)`
 * once per tic.
 *
 * 0xcfd0 and not the 0xcc00 that global.c initialises it to. The CON compiler
 * found this: `gamestartup`'s seventh word is assigned to dukefriction when the
 * CON is loaded, and USER.CON defines it as RUNNINGSPEED 53200 = 0xcfd0. The
 * value in global.c is only what the game would use if it had no CON, which it
 * never does. Off by 1.5 % — enough to have felt right at the wrong number,
 * and a reminder that a constant read from a C initialiser is a default, not
 * necessarily the value in play. Once the compiled CON is wired into the game
 * this becomes `defs.gamestartup[6]`.
 */
export const DUKE_FRICTION = 0xcfd0;

/** How hard a swim stroke pushes, and the speed it is allowed to reach. */
/**
 * Standing in a water SURFACE sector — lotag 1 — is a third set of rules, and
 * leaving it out is why diving could not be triggered at all.
 *
 *   psectlotag == 1:  i = 34            (not the 40 of dry land)
 *   settle:           posz += ((fz-(i<<7)) - posz)>>1     // note <<7, not <<8
 *   clamp:            if(on_warping_sector == 0 && posz > fz-(16<<8))
 *                         { posz = fz-(16<<8); poszv >>= 1; }
 *
 * Two things make this work, and both are easy to miss:
 *
 * The settle target is `fz - (34<<7)` = fz-4352, a SHIFT smaller than the dry
 * `fz - (40<<8)` = fz-10240 — you wade in up to your chest rather than standing
 * on the surface. Reading the `<<7` as a `<<8` puts the eye at fz-8704 and no
 * amount of crouching reaches the water.
 *
 * And the clamp at fz-4096 is exactly the depth the dive test wants to see
 * exceeded — but it is skipped `if(on_warping_sector == 0)`, which
 * movetransports sets to 1 for anyone standing in a transporter's sector. So
 * the wall that keeps you out of the water is lifted precisely where there is
 * something to dive into. Without it, crouching settles at fz-4608 and the
 * dive condition misses by 512 units, which is what it did.
 */
export const WADE_EYE = 34;
export const WADE_CLAMP = 16 << 8;

export const SWIM_ACCEL = 348;
export const SWIM_MAX = 256 * 6;
/** How fast an unheld swimmer coasts to a stop, per tic. */
export const SWIM_DRIFT = 256;
/** `if(p->posz > (fz-(15<<8)))` and `(cz+(4<<8))` — the two soft limits. */
export const SWIM_FLOOR = 15 << 8;
export const SWIM_CEIL = 4 << 8;

/**
 * One tic of vertical movement under water.
 *
 *   jumping_counter = 0
 *   if (jump)   { if(poszv>0) poszv=0; poszv -= 348; clamp at -(256*6) }
 *   else if (Z) { if(poszv<0) poszv=0; poszv += 348; clamp at +(256*6) }
 *   else        { walk poszv toward zero by 256 }
 *   if (poszv > 2048) poszv >>= 1;
 *   posz += poszv;
 *   if (posz > fz-(15<<8)) posz += ((fz-(15<<8))-posz)>>1;
 *   if (posz < cz+(4<<8))  { posz = cz+(4<<8); poszv = 0; }
 *
 * Three things worth naming, because each is the opposite of the dry rules
 * directly below:
 *
 *   - No gravity. Let go and you coast to a halt and hang there; you do not
 *     sink. The 256-a-tic drift is the whole of the braking.
 *   - Reversing is instant. Pressing up while sinking zeroes the velocity
 *     first, so a stroke always starts from nothing.
 *   - The FLOOR is soft and the CEILING is hard. Going down you approach
 *     `fz-(15<<8)` by halving the remaining gap and never quite arrive; going
 *     up you stop dead at `cz+(4<<8)` with the velocity cleared. A symmetric
 *     pair would have been the natural guess and is wrong on both ends.
 *
 * The `poszv > 2048` halving applies only downward, so sinking fast is damped
 * and rising fast is not.
 */
function swimZ(p, st, fz, cz, jump, crouch) {
  st.jumpCounter = 0;
  st.onGround = false;
  st.fallCounter = 0;

  if (jump) {
    if (st.zVel > 0) st.zVel = 0;
    st.zVel -= SWIM_ACCEL;
    if (st.zVel < -SWIM_MAX) st.zVel = -SWIM_MAX;
  } else if (crouch) {
    if (st.zVel < 0) st.zVel = 0;
    st.zVel += SWIM_ACCEL;
    if (st.zVel > SWIM_MAX) st.zVel = SWIM_MAX;
  } else {
    if (st.zVel < 0) {
      st.zVel += SWIM_DRIFT;
      if (st.zVel > 0) st.zVel = 0;
    }
    if (st.zVel > 0) {
      st.zVel -= SWIM_DRIFT;
      if (st.zVel < 0) st.zVel = 0;
    }
  }

  if (st.zVel > 2048) st.zVel >>= 1;
  p.z += st.zVel;

  let hitCeiling = false;
  if (p.z > fz - SWIM_FLOOR) p.z += ((fz - SWIM_FLOOR) - p.z) >> 1;
  if (p.z < cz + SWIM_CEIL) {
    p.z = cz + SWIM_CEIL;
    st.zVel = 0;
    hitCeiling = true;
  }
  return { landed: false, hitCeiling, fell: false };
}

/** player.c's movement constants. NORMALKEYMOVE doubles while running. */
export const NORMAL_KEYMOVE = 40;
/** `MAXVEL ((NORMALKEYMOVE*2)+10)` — ninety, and the same for strafing. */
export const MAX_VEL = NORMAL_KEYMOVE * 2 + 10;

/** `mulscale9(a,b)` — an arithmetic shift, so it floors on negatives. */
const mulscale9 = (a, b) => (a * b) >> 9;

/**
 * getinput's last step, player.c 2089..2123: the keys as `vel`/`svel`
 * (keymove 40, doubled while running, clamped to MAXVEL 90), turned by the
 * player's angle into loc.fvel/loc.svel — world axes, not view axes — with
 * the conveyor push added. movePlayerXY feeds it to the velocity;
 * checksectors reads it to drop a camera view (watchInputClears).
 */
export function inputMomentum(ang, input = {}, fricX = 0, fricY = 0) {
  const keymove = input.running ? NORMAL_KEYMOVE << 1 : NORMAL_KEYMOVE;
  let vel = Math.round((input.forward ?? 0) * keymove);
  let svel = Math.round((input.strafe ?? 0) * keymove);
  vel = Math.max(-MAX_VEL, Math.min(MAX_VEL, vel));
  svel = Math.max(-MAX_VEL, Math.min(MAX_VEL, svel));
  // sintable[(a+2560)&2047] is cos(a), [(a+2048)] is sin(a), [(a+1536)] is
  // -cos(a). Written as Build indexes them rather than as trigonometry, so the
  // shape can be compared with the source line by line.
  const a = Math.round(ang);
  const momx = mulscale9(vel, bsin(a + 2560)) + mulscale9(svel, bsin(a + 2048)) + fricX;
  const momy = mulscale9(vel, bsin(a + 2048)) + mulscale9(svel, bsin(a + 1536)) + fricY;
  return { momx, momy };
}

/**
 * sector.c 2967 (checksectors): watching a camera, `klabs(svel) > 768 ||
 * klabs(fvel) > 768` is CLEARCAMERAS — walking off the monitor ends the
 * view. A walking key alone is 40*32 = 1280 along its axis, at worst 905 on
 * a diagonal heading, so any movement key does it; a conveyor's push
 * alone can too. `ang` is p->ang, which processinput has set to the
 * camera's (player.c 2683).
 */
export function watchInputClears(ang, input = {}, fricX = 0, fricY = 0) {
  const { momx, momy } = inputMomentum(ang, input, fricX, fricY);
  return Math.abs(momx) > 768 || Math.abs(momy) > 768;
}

/**
 * One tic of horizontal movement, as player.c does it.
 *
 * This replaces an invention. The pages used to compute a direction from the
 * keys, normalise it, multiply by a speed in units per SECOND and hand that to
 * clipMove once per frame. Duke does none of those four things: it works in
 * tics, it does not normalise, its speed is a key-move constant rather than a
 * chosen number, and — the part that actually changes the feel — it does not
 * move you at all. It accelerates a velocity that friction then eats.
 *
 *   getinput:     vel  += keymove             (40, doubled while running)
 *                 momx  = mulscale9(vel,  cos) + mulscale9(svel, sin)
 *                 momy  = mulscale9(vel,  sin) - mulscale9(svel, cos)
 *                 momx += fricxv               (conveyors, from the effectors)
 *   processinput: posxv += (momx*doubvel)<<6   (doubvel = TICSPERFRAME = 4)
 *                 posxv  = mulscale(posxv, dukefriction, 16)
 *                 if both axes under 2048, both are zeroed
 *                 clipmove(..., posxv, posyv, 164, 4<<8, i, CLIPMASK0)
 *
 * Three consequences worth stating, because each is visible and none of them
 * was true before:
 *
 *   - You do not stop when you let go. Friction takes about twenty tics to
 *     bring you under the dead band.
 *   - Diagonal movement is FASTER. `vel` and `svel` are separate axes and Build
 *     never normalises the pair, so forward-plus-strafe is a factor of about
 *     1.41 quicker. That is a real Duke behaviour, not a rounding artefact.
 *   - A conveyor is no longer a separate accumulator. It enters at `fricxv`,
 *     exactly where Build puts it, and the same friction carries both.
 *
 * `input.steroids` is `doubvel<<=1` for steroids (the page decides, onSteroids).
 * Not modelled, and each is a condition rather than an omission: the crouch and knee friction variants
 * (`dukefriction-0x2000`), the underwater one (`-0x1400`, sector lotag 2), and
 * the shrunk multiplier.
 *
 * `input` is `{ forward, strafe, running }` with forward and strafe in
 * -1..1; `fricX`/`fricY` are the effectors' push for this tic. Returns the
 * displacement for clipMove, in map units.
 */
export function movePlayerXY(state, ang, input = {}, fricX = 0, fricY = 0) {
  // Under water the friction is stronger: `mulscale(posxv, dukefriction-0x1400, 16)`.
  // 0x1400 of 0xcc00 is a sixth off, so a swimmer coasts noticeably less far
  // than a runner — and it is a different constant, not a scaled one.
  const friction = input.water ? DUKE_FRICTION - 0x1400 : DUKE_FRICTION;
  const { momx, momy } = inputMomentum(ang, input, fricX, fricY);

  // player.c 3274: on steroids (taken, not the jetpack) the step doubles.
  const doubvel = input.steroids ? TICS_PER_FRAME << 1 : TICS_PER_FRAME;
  state.xVel = (((state.xVel + ((momx * doubvel) << 6)) * friction) / 65536) | 0;
  state.yVel = (((state.yVel + ((momy * doubvel) << 6)) * friction) / 65536) | 0;
  // Both axes together, as processinput writes it: a belt running along one
  // axis would otherwise creep sideways for ever.
  if (Math.abs(state.xVel) < 2048 && Math.abs(state.yVel) < 2048) {
    state.xVel = 0;
    state.yVel = 0;
  }
  // player.c 3302: shrunk, a second friction of dukefriction*3/4 on top.
  if (input.shrunk) {
    const f = DUKE_FRICTION - (DUKE_FRICTION >> 1) + (DUKE_FRICTION >> 2);
    state.xVel = ((state.xVel * f) / 65536) | 0;
    state.yVel = ((state.yVel * f) / 65536) | 0;
  }
  return { dx: state.xVel >> 14, dy: state.yVel >> 14 };
}

/** `NORMALTURN 15`, doubled while running — the settled turn rate. */
export const NORMAL_TURN = 15;
/** `PREAMBLETURN 5` — the slower rate for the first moments of a press. */
export const PREAMBLE_TURN = 5;
/**
 * `TURBOTURNTIME (TICRATE/8)`, and TICRATE is 120 (game.c 82), so fifteen tics.
 * The comment beside the define in player.c says `// 7`, which was true of some
 * earlier tick rate and is not true of this one — taking the comment instead of
 * the arithmetic would make the preamble twice as long as Build's.
 */
export const TURBO_TURN_TIME = 15;
/** `MAXANGVEL 127`. */
export const MAX_ANGVEL = 127;

/**
 * One tic of turning, as player.c does it.
 *
 * The last invented constant in the input path: the pages turned at `900 * dt`,
 * a rate per second with no ramp. Duke's has two rates and a threshold —
 *
 *   getinput:      turnheldtime += tics
 *                  angvel += (turnheldtime >= TURBOTURNTIME)
 *                            ? turnamount        // NORMALTURN, <<1 running
 *                            : PREAMBLETURN
 *                  ...and turnheldtime = 0 the moment neither key is held
 *   processinput:  tempang = avel<<1
 *                  p->ang += tempang * ksgn(doubvel)
 *                  p->ang &= 2047
 *
 * — so a tap turns at ten units a tic and a held key accelerates to thirty,
 * or sixty while running. That ramp is what makes keyboard aiming in Duke
 * usable at all, and 900/s happened to match only the settled walking rate.
 *
 * `ksgn(doubvel)` is not reproduced as a multiplier because the cases that zero
 * doubvel — a raised fist, a hard landing, `transporter_hold > 2` — do not
 * exist here; the transporter hold does, and freezing turning during it would
 * be a change nobody asked for. Noted rather than half-built.
 *
 * The mouse is a separate path in Build too (`angvel = dyaw/64`), and it
 * bypasses the preamble; the pages keep their own mouse handling.
 *
 * Returns the angle delta for this tic. The caller masks.
 */
export function turnPlayer(state, input = {}) {
  const turnamount = input.running ? NORMAL_TURN << 1 : NORMAL_TURN;
  let angvel = 0;
  if (input.left) {
    state.turnHeldTime += TICS_PER_FRAME;
    angvel -= state.turnHeldTime >= TURBO_TURN_TIME ? turnamount : PREAMBLE_TURN;
  } else if (input.right) {
    state.turnHeldTime += TICS_PER_FRAME;
    angvel += state.turnHeldTime >= TURBO_TURN_TIME ? turnamount : PREAMBLE_TURN;
  } else {
    state.turnHeldTime = 0;
  }
  angvel = Math.max(-MAX_ANGVEL, Math.min(MAX_ANGVEL, angvel));
  const tempang = angvel << 1;
  // `if(psectlotag == 2) angvel = (tempang-(tempang>>3))` — seven eighths under
  // water, and an arithmetic shift, so turning left is damped by one unit more
  // than turning right at the same rate.
  return input.water ? tempang - (tempang >> 3) : tempang;
}

/**
 * The underwater sway — Duke's `pyoff`.
 *
 *   p->pycount += 32; p->pycount &= 2047;
 *   p->pyoff = sintable[p->pycount]>>7;
 *
 * and game.c 3358 adds it to the DRAWING camera, not to the player: the eye
 * rocks while the body holds still, which is why swimming feels different
 * without anything actually moving differently.
 *
 * 32 a tic over 2048 is a full cycle every 64 tics, a little over two seconds
 * at 30 Hz, and `>>7` puts the amplitude at 128 z-units either way.
 *
 * The counter runs only under water and is left where it stopped otherwise, so
 * surfacing does not snap the view.
 */
export function swimSway(state, underwater, surface = false, jetpack = false) {
  // With the jetpack on (and not under water — player.c takes the water
  // branch first), jetpackTic has already advanced the counter; the offset
  // is `sintable[pycount]>>7`, the under-water amplitude.
  if (jetpack && !underwater) return bsin(state.pyCount) >> 7;
  if (!underwater && !surface) return 0;
  state.pyCount = (state.pyCount + 32) & 2047;
  // `>>7` under water, `>>6` at the surface — the bob is TWICE as strong when
  // you are wading in it, which is the opposite of the intuition and is what
  // player.c 2917 against 2796 says.
  return bsin(state.pyCount) >> (underwater ? 7 : 6);
}


/**
 * The head of checksectors(), sector.c 1300: what the sector the player
 * stands in does by its lotag, once (the lotag is zeroed after):
 *
 *   32767  a secret place: quote 9, secret_rooms++
 *      -1  the level ends now
 *      -2  the level ends in 26*8 tics (timebeforeexit), with the sector's
 *          hitag as the exit sound — E1L2's cage
 *   10000..16382  play sound lotag-10000
 *
 * Returns 'secret', 'eol', 'exit', { sound } or null. The lotag is read
 * signed, as the short is.
 */
export function checkSectorLotag(map, st, sectNum) {
  const sec = map.sectors[sectNum];
  if (!sec) return null;
  const lt = sec.lotag;
  if (lt === 32767) { sec.lotag = 0; st.quote = 9; st.quoteTime = 120; st.secretRooms++; return 'secret'; }
  if (lt === -1) { sec.lotag = 0; return 'eol'; }
  if (lt === -2) { sec.lotag = 0; st.timeBeforeExit = 26 * 8; st.customExitSound = sec.hitag; return 'exit'; }
  if (lt >= 10000 && lt < 16383) { sec.lotag = 0; return { sound: lt - 10000 }; }
  return null;
}

/**
 * processinput 2226, once a tic: the exit clock. While it runs (and the
 * player lives), it counts down; at 26*5 every sound stops and the custom
 * exit sound plays with quote 102; at 1 the level is over. Returns
 * { sound, quote } on the 26*5 tic, 'eol' at 1, else null.
 */
export function exitTic(st) {
  if (!(st.timeBeforeExit > 1) || (st.health ?? 1) <= 0) return null;
  st.timeBeforeExit--;
  if (st.timeBeforeExit === 26 * 5) {
    return { stopAll: true, sound: st.customExitSound >= 0 ? st.customExitSound : -1, quote: st.customExitSound >= 0 ? 102 : -1 };
  }
  if (st.timeBeforeExit === 1) return 'eol';
  return null;
}

/** doincrements(), player.c 2144: the tip hand's clock. */
export function tipTic(st) {
  if (st.tipIncs > 0) st.tipIncs--;
}

/**
 * The air, player.c 2265, once a tic. In an under-water sector (lotag 2)
 * with the scuba off: a charge switches it on (quote 76); without one the
 * air left counts down, and at zero the player owes 32 eighths a tic
 * (extra_extra8), with DUKE_LONGTERM_PAIN every fourth point below half
 * health. With the scuba on it drains a unit a tic and switches off at
 * zero. Out of the water (player.c 2893/2904) the air is refilled to 15*26
 * and the scuba switched off — its charge keeps. Returns 'scuba-on',
 * 'scuba-off', 'drowning' (a pain tic) or null.
 */
export function airTic(st, sectLotag, maxHealth = 100) {
  const wet = (sectLotag & LOTAG_MASK) === 2;
  // player.c 2893/2907: out of the water (jetpack or not) the air is full
  // again and the scuba goes off — the mask comes down at the surface.
  if (!wet) { if (st.airLeft !== 15 * 26) st.airLeft = 15 * 26; if (st.scubaOn) st.scubaOn = false; }
  if (!st.scubaOn && wet) {
    if (st.inventory.scuba > 0) { st.scubaOn = true; st.quote = 76; st.quoteTime = 120; return 'scuba-on'; }
    if (st.airLeft > 0) { st.airLeft--; return null; }
    st.extraExtra8 += 32;
    if (st.health < (maxHealth >> 1) && (st.health & 3) === 0) return 'drowning';
    return null;
  }
  if (st.inventory.scuba > 0 && st.scubaOn) {
    st.inventory.scuba--;
    if (st.inventory.scuba === 0) { st.scubaOn = false; return 'scuba-off'; }
  }
  return null;
}

/**
 * incur_damage(), player.c 52, the extra_extra8 part: the eighths owed come
 * off the health whole, and a share of 20..49 % of any loss goes to the
 * shield first (the same split takePlayerDamage makes for a hit). Returns
 * the health lost this tic.
 */
export function incurDamage(st, fx) {
  let dmg = st.extraExtra8 >> 8;
  if (dmg <= 0) return 0;
  st.extraExtra8 = 0;
  if (st.god) return 0;
  if (st.shield > 0) {
    const shieldDmg = Math.trunc((dmg * (20 + (krand(fx) % 30))) / 100);
    dmg -= shieldDmg;
    st.shield -= shieldDmg;
    if (st.shield < 0) { dmg -= st.shield; st.shield = 0; }
  }
  st.health = Math.max(0, st.health - dmg);
  return dmg;
}

/** HURTRAIL, FLOORSLIME, FLOORPLASMA — the floors that hurt (player.c 3170). */
export const HURT_FLOORS = { 859: 'rail', 200: 'slime', 1082: 'plasma' };

/**
 * player.c 3164: standing (on the ground, no more than 16<<8 above the
 * floor) on a hurting floor. HURTRAIL: 32 in 256 a tic, boots else a white
 * flash, 1..4 health, DUKE_LONGTERM_PAIN and SHORT_CIRCUIT; FLOORSLIME: 16
 * in 256, a green flash; FLOORPLASMA: 32 in 256, a red flash. With boots
 * on, quote 75 and two boot units instead. `rnd(x)` is `(TRAND>>8) >=
 * 255-x`. Returns null, or { pal, damage, sounds } / { boots: true }.
 */
export function hurtFloorTic(map, st, fx, sectNum, onGround, trueFDist) {
  const sec = map.sectors[sectNum];
  if (!sec || !onGround || trueFDist > EYE_HEIGHT + (16 << 8)) return null;
  const kind = HURT_FLOORS[sec.floorPicNum];
  if (!kind) return null;
  const rnd = (x) => (krand(fx) >> 8) >= (255 - x);
  if (!rnd(kind === 'slime' ? 16 : 32)) return null;
  if (st.inventory.boots > 0) {
    st.quote = 75; st.quoteTime = 120;
    st.inventory.boots -= 2;
    if (st.inventory.boots < 0) st.inventory.boots = 0;
    return { boots: true };
  }
  const dmg = 1 + (krand(fx) & 3);
  if (!st.god) st.health = Math.max(0, st.health - dmg);
  st.pal = kind === 'rail' ? { time: 32, r: 64, g: 64, b: 64 } : kind === 'slime' ? { time: 32, r: 0, g: 8, b: 0 } : { time: 32, r: 8, g: 0, b: 0 };
  return { kind, damage: dmg, sounds: kind === 'rail' ? ['DUKE_LONGTERM_PAIN', 'SHORT_CIRCUIT'] : ['DUKE_LONGTERM_PAIN'] };
}

/**
 * checkplayerhurt(p, j), sector.c 1807, with clipmove's answer. A CACTUS
 * sprite (49152|i): 5 health, hurt_delay 16, a red flash, the pain sound,
 * while hurt_delay is under 8. A wall (32768|w): hurt_delay counts down
 * here (only while something is being walked into); at zero a live
 * (cstat&85) W_FORCEFIELD costs 5 health with a red flash, throws the
 * player straight back (posxv = -cos<<8), plays the pain sound, and hits
 * the wall with atwith -1 (the ripple, the flash — the page's checkHitWall);
 * a BIGFORCE only sets hurt_delay 26 and hits the wall. Returns
 * { kind, wall } for the page, or null.
 */
export function checkPlayerHurt(map, st, cam, hit) {
  if (typeof hit !== 'number' || hit < 0) return null;
  if ((hit & 49152) === 49152) {
    const spr = map.sprites[hit & 4095];
    if (spr && !spr.removed && spr.picNum === 1216 && st.hurtDelay < 8) {   // CACTUS
      if (!st.god) st.health = Math.max(0, st.health - 5);
      st.hurtDelay = 16;
      st.pal = { time: 32, r: 32, g: 0, b: 0 };
      return { kind: 'cactus', sprite: hit & 4095 };
    }
    return null;
  }
  if ((hit & 49152) !== 32768) return null;
  const w = hit & 16383;
  const wal = map.walls[w];
  if (!wal) return null;
  if (st.hurtDelay > 0) { st.hurtDelay--; return null; }
  if (!(wal.cstat & 85)) return null;
  const over = wal.overPicNum;
  if (over >= 663 && over <= 665) {
    if (!st.god) st.health = Math.max(0, st.health - 5);
    st.hurtDelay = 16;
    st.pal = { time: 32, r: 32, g: 0, b: 0 };
    st.xVel = -(bsin(cam.ang + 512) << 8);
    st.yVel = -(bsin(cam.ang) << 8);
    return { kind: 'field', wall: w, x: cam.x + (bsin(cam.ang + 512) >> 9), y: cam.y + (bsin(cam.ang) >> 9), z: cam.z };
  }
  if (over === 230) {
    st.hurtDelay = 26;
    return { kind: 'bigforce', wall: w, x: cam.x + (bsin(cam.ang + 512) >> 9), y: cam.y + (bsin(cam.ang) >> 9), z: cam.z };
  }
  return null;
}

/**
 * quickkill(), player.c 82: a grey flash (48,48,48 for 48), health 0 — the
 * crush, the fall past 62 counts, the lift, the space. The eight JIBS6 are
 * the page's (guts), unless god. Returns true when it killed.
 */
export function quickKill(st) {
  st.pal = { time: 48, r: 48, g: 48, b: 48 };
  if (st.god) return false;
  st.health = 0;
  st.deadSquished = true;
  return true;
}

/**
 * The dying player, once a tic while health is 0 — processinput 2547 and
 * the APLAYER script's `ifdead` (GAME.CON 3367). The first tic: a red flash
 * (63,0,0 for 63), the eye lifted 16<<8, dead_flag rolled (a screen tilt
 * uDuke does not draw), jetpack off. Then the sprite falls (CON `fall`;
 * squished it stays — `ifsquished palfrom` instead) and the eye follows it
 * at 20<<8 over the floor (moveplayers 1244). PTHROWNBACK runs five frames
 * of 18 tics; one of DUKE_KILLED1/2/3/5 at action count 6 (108 tics); at
 * PLYINGDEAD (90 tics) quote 13, and `ifhitspace` restarts the level
 * (resetplayer). Returns 'died' on the first tic, { sound } for the line,
 * 'restart' when use is pressed on the lying body, else null.
 */
export function deathTic(st, cam, zr, input, fx) {
  if (st.health > 0) return null;
  if (st.frozen) return frozenTic(st, cam, zr, input, fx);
  if (st.deadFlag === 0) {
    st.pal = { time: 63, r: 63, g: 0, b: 0 };
    cam.z -= 16 << 8;
    st.deadFlag = (512 - ((krand(fx) & 1) << 10) + (krand(fx) & 255) - 512) & 2047 || 1;
    st.deadCount = 0;
    st.jetpackOn = 0;
    st.zVel = 0;
    deadTilt(st, cam, zr);
    return 'died';
  }
  st.deadCount++;
  if (!st.deadSquished) {
    // the fall of the body, as makeitfall would: gravity to the floor
    const rest = zr.florZ - (20 << 8);
    if (cam.z < rest) {
      st.zVel = Math.min(st.zVel + 256, 6144);
      cam.z = Math.min(cam.z + st.zVel, rest);
    } else cam.z = rest;
  }
  cam.horiz = 100;
  deadTilt(st, cam, zr);
  if (st.deadCount === 108) {
    const r = krand(fx) & 255;
    return { sound: r < 32 ? 'DUKE_KILLED5' : r < 64 ? 'DUKE_KILLED3' : r < 96 ? 'DUKE_KILLED1' : r < 128 ? 'DUKE_KILLED2' : null };
  }
  if (st.deadCount >= 90) {
    st.quote = 13; st.quoteTime = 120;
    if (input?.use) return 'restart';
  }
  return null;
}

/** USER.CON 99/100: when the frozen player drips, and when he thaws. */
export const FROZENDRIPTIME = 90, THAWTIME = 138;

/**
 * The frozen player, GAME.CON 3306 (APLAYER, `ifaction PFROZEN`), with
 * player.c's dead branch around it. Killed by the freezer the sprite is pal
 * 1, and every `s->pal != 1` of processinput's dead branch is skipped: no
 * red flash, no 16<<8 drop, no dead_flag — so no tilt (player.c 2661) —
 * while moveplayers still sets the eye 20<<8 over the falling sprite.
 * A tic of PFROZEN: `fall`, `palfrom 16 0 0 24` (the blue stays). Not yet
 * shattered (move 0): a hit by anything but the freezer shatters him —
 * `lotsofglass 60`, ifrnd 84 a BLOODPOOL, GLASS_BREAKING, an ATOMICHEALTH,
 * getlastpal, move 1 — after which quote 13 asks for Space (resetplayer).
 * Untouched, the action count reaches THAWTIME (138 tics): getlastpal,
 * strength 1, PSTAND — he THAWS and plays on with 1 health; from
 * FROZENDRIPTIME (90) on, one tic in eight-ish (ifrnd 32) a WATERDRIP.
 *
 * `input.hit`: the weapon of a hit filed this tic (takeFrozenHit), or -1.
 * Returns 'frozen' on the first tic, then 'shatter', 'thaw', 'restart',
 * { drip: true }, or null. The page does the spawning and the sounds.
 */
export function frozenTic(st, cam, zr, input, fx) {
  if (st.frozenCount < 0) {
    st.frozenCount = 0;
    st.jetpackOn = 0;
    st.zVel = 0;
    st.rotScrnAng = 0;
    return 'frozen';
  }
  // fall: the sprite, and the eye 20<<8 above it (moveplayers 1248)
  const rest = zr.florZ - (20 << 8);
  if (cam.z < rest) {
    st.zVel = Math.min(st.zVel + 256, 6144);
    cam.z = Math.min(cam.z + st.zVel, rest);
  } else cam.z = rest;
  cam.horiz = 100;
  st.pal = { time: 16, r: 0, g: 0, b: 24 };
  if (!st.shattered) {
    const hit = input?.hit ?? -1;
    if (hit === 1641) { st.frozenCount++; return null; }                       // `ifwasweapon FREEZEBLAST break`
    if (hit >= 0) { st.shattered = true; return 'shatter'; }
    // execute(): the action count steps after the script ran (gamedef.c)
    const n = st.frozenCount++;
    if (n >= THAWTIME) {
      st.frozen = false; st.frozenCount = -1;
      st.health = 1; st.zVel = 0;
      return 'thaw';
    }
    if (n >= FROZENDRIPTIME) return (krand(fx) >> 8) >= 255 - 32 ? { drip: true } : null;   // ifrnd 32: rnd(X) = (TRAND>>8) >= 255-X
    return null;
  }
  st.quote = 13; st.quoteTime = 120;
  if (input?.use) return 'restart';
  return null;
}

/**
 * player.c 2661: the dead view lies on its side./**
 * player.c 2661: the dead view lies on its side. With room (floor more than
 * 16<<8 under the ceiling) rotscrnang = dead_flag + (fz + posz) >> 7 — the
 * body's random side, turned further by how far it has sunk; nothing decays
 * it while dead (the dead branch returns before the decay). A frozen player
 * (sprite pal 1) does not tilt — `st.frozen` if the page tracks it.
 */
export function deadTilt(st, cam, zr) {
  if (zr.florZ > zr.ceilZ + (16 << 8) && !st.frozen) st.rotScrnAng = (st.deadFlag + ((zr.florZ + Math.trunc(cam.z)) >> 7)) & 2047;
}

/** sizeto X Y (gamedef.c): each repeat moves one unit a tic toward the target. */
export function sizeTo(spr, x, y) {
  if (spr.xRepeat < x) spr.xRepeat++; else if (spr.xRepeat > x) spr.xRepeat--;
  if (spr.yRepeat < y) spr.yRepeat++; else if (spr.yRepeat > y) spr.yRepeat--;
}

export const SHRUNK_COUNT = 270, SHRUNK_DONE_COUNT = 304;

/**
 * The APLAYER script's PSHRINKING branch (GAME.CON 3529), once a tic while
 * the spark's count runs. Under 32: the sprite goes to 8x9 (sizeto), one
 * unit a tic, with FRAMEEFFECT1s; steroids IN EFFECT (1..399) skip straight
 * to 270. 32..269:
 * small — `ifp pshrunk` is the sprite under 32 wide. 270..303: back to
 * 42x36, and a ceiling within 24<<8 of the floor crushes the growing body
 * (strength 0, SQUISHED, a grey flash). 304: done, cstat 257. Returns
 * 'small' on the tic the body first counts as shrunk, 'grown' at 304,
 * 'crushed' on the crush, else null. `shrunk` for the physics is
 * `sprite.yRepeat < 32` (player.c 2376).
 */
export function shrinkTic(st, spr, gap = 1 << 30) {
  if (!(st.shrinkCount >= 0) || !spr) return null;
  const wasSmall = spr.yRepeat < 32;
  // `ifp ponsteroids` (gamedef.c 2860): steroids TAKEN — amount between 1
  // and 399; a full unused bottle (400, DNSTUFF's) does nothing.
  const onSteroids = st.inventory.steroids > 0 && st.inventory.steroids < 400;
  if (st.shrinkCount < 32 && onSteroids) st.shrinkCount = SHRUNK_COUNT;
  if (st.shrinkCount >= 32) {
    if (st.shrinkCount >= SHRUNK_DONE_COUNT) {
      st.shrinkCount = -1;
      // The script's `cstat 257` — Duke's player sprite is solid and
      // hittable. uDuke's player sprite is 32768 (invisible, in no clip
      // box) by design: its own rockets and its clipmove never meet it. A
      // first version set 257 here, and every rocket fired after a shrink
      // died on the player's own sprite at birth.
      spr.cstat = 32768;
      return 'grown';
    }
    if (st.shrinkCount >= SHRUNK_COUNT) {
      sizeTo(spr, 42, 36);
      if (gap < (24 << 8)) {
        st.health = 0;
        st.deadSquished = true;
        st.pal = { time: 64, r: 48, g: 48, b: 48 };
        st.shrinkCount = -1;
        return 'crushed';
      }
    } else if (onSteroids) st.shrinkCount = SHRUNK_COUNT;
  } else sizeTo(spr, 8, 9);
  st.shrinkCount++;
  return !wasSmall && spr.yRepeat < 32 ? 'small' : null;
}

/** player.c 2376: `shrunk = (s->yrepeat < 32)`. */
export const isShrunk = (spr) => !!spr && spr.yRepeat < 32;

/**
 * The inventory key on the jetpack — sector.c 2872 (checksectors' sync bit
 * 25): with fuel, on becomes off and off becomes on. Switching on speaks
 * DUKE_JETPACK_ON and quote 52; switching off clears the hard landing and
 * poszv, speaks DUKE_JETPACK_OFF and quote 53. Returns 'on', 'off', or
 * null with no fuel.
 */
export function toggleJetpack(st) {
  if (!(st.inventory?.jetpack > 0)) return null;
  if (st.jetpackOn) {
    st.jetpackOn = 0;
    st.hardLanding = 0;
    st.zVel = 0;
    return 'off';
  }
  st.jetpackOn = 1;
  return 'on';
}

/**
 * The night vision — sector.c 2498 (sync bit 15): with a charge, on becomes
 * off and off on, NITEVISION_ONOFF either way, quote 106 on / 107 off.
 * Returns 'on', 'off', or null without a charge.
 */
export function toggleHeat(st) {
  if (!(st.inventory?.heat > 0)) return null;
  st.heatOn = !st.heatOn;
  return st.heatOn ? 'on' : 'off';
}

/**
 * player.c 2184: one unit of charge a tic while on; at zero it goes off by
 * itself (NITEVISION_ONOFF). 1200 is the full charge. Returns true on the
 * tic it ran out.
 */
export function heatTic(st) {
  if (!st.heatOn || !(st.inventory?.heat > 0)) return false;
  st.inventory.heat--;
  if (st.inventory.heat === 0) { st.heatOn = false; return true; }
  return false;
}

/**
 * Jetpack fuel — player.c 2207, once a tic ahead of the input: one unit a
 * tic while it is on, and at zero it switches itself off (DUKE_JETPACK_OFF).
 * 1600 units is the full tank, a minute at 26 tics. Returns true when it
 * ran dry this tic.
 */
export function jetpackFuelTic(st) {
  if (!st.jetpackOn || !(st.inventory?.jetpack > 0)) return false;
  st.inventory.jetpack--;
  if (st.inventory.jetpack <= 0) { st.jetpackOn = 0; return true; }
  return false;
}

/**
 * The jetpack's vertical tic — player.c 2856, the branch that replaces the
 * whole gravity model while it is on:
 *
 *   p->on_ground = 0; jumping_counter = 0; hard_landing = 0; falling_counter = 0;
 *   pycount += 32 (the sway, >>7 — swimSway's under-water amplitude)
 *   if(jetpack_on < 11) { jetpack_on++; posz -= (jetpack_on<<7); }   // lift-off ramp
 *   j = shrunk ? 512 : 2048;
 *   if(jump)   posz -= j;                                           // soar high
 *   if(crouch) posz += j;                                           // soar low
 *   k = (!shrunk && (lotag == 0 || lotag == 2)) ? 32 : 16;
 *   if(posz > fz-(k<<8)) posz += ((fz-(k<<8))-posz)>>1;             // held off the floor
 *   if(posz < ceilingz+(18<<8)) posz = ceilingz+(18<<8);            // and off the ceiling
 *
 * The ramp: the first ten tics climb 256, 384, .. 1408 — 8320 units before
 * the keys do anything, which is the hop you see when it lights. The floor
 * hold is a half-gap settle, so hovering just above a step rides up over it;
 * the ceiling is a hard stop. `posz += poszv` at the end of processinput is
 * inside the non-jetpack branch, so nothing carries over. Returns
 * { idle: true } on the tic the ramp ends (DUKE_JETPACK_IDLE starts then).
 */
export function jetpackTic(p, st, zr, input = {}, sectLotag = 0, shrunk = false) {
  st.onGround = false;
  st.jumpCounter = 0;
  st.hardLanding = 0;
  st.fallCounter = 0;
  st.pyCount = (st.pyCount + 32) & 2047;
  let idle = false;
  if (st.jetpackOn < 11) {
    st.jetpackOn++;
    p.z -= st.jetpackOn << 7;
    if (st.jetpackOn === 11) idle = true;
  }
  const j = shrunk ? 512 : 2048;
  if (input.jump) p.z -= j;
  if (input.crouch) p.z += j;
  const lot = sectLotag & LOTAG_MASK;
  const k = (!shrunk && (lot === 0 || lot === 2)) ? 32 : 16;
  if (p.z > zr.florZ - (k << 8)) p.z += ((zr.florZ - (k << 8)) - p.z) >> 1;
  if (p.z < zr.ceilZ + (18 << 8)) p.z = zr.ceilZ + (18 << 8);
  return { idle };
}

/**
 * The DRAWING camera's z — game.c displayrooms, 3373..3384:
 *
 *   else if(p->spritebridge == 0)
 *   {
 *       if( cposz < ( p->truecz + (4<<8) ) ) cposz = cz + (4<<8);
 *       else if( cposz > ( p->truefz - (4<<8) ) ) cposz = fz - (4<<8);
 *   }
 *   if (sect >= 0)
 *   {
 *       getzsofslope(sect,cposx,cposy,&cz,&fz);
 *       if (cposz < cz+(4<<8)) cposz = cz+(4<<8);
 *       if (cposz > fz-(4<<8)) cposz = fz-(4<<8);
 *   }
 *
 * `cz`/`fz` are hittype's — getzrange's answer from processinput, `zr` here —
 * and truecz/truefz the sector's own slopes at the camera. The first pair
 * compares against the true values and sets to the range values; the second
 * pair clamps against the true values outright. Both kept, in that order.
 *
 * Why it exists: the player's posz is allowed to leave the sector's slab and
 * the picture is not. Found at the E1L2 manhole drop: the shaft's water
 * sector (135) holds an off-floor SE7 partner, so `on_warping_sector` is set
 * every tic, the wading clamp in processinput is skipped every tic, and with
 * the fall speed still in poszv the player settles at fz-4352+2*poszv — 6911
 * units UNDER the floor. Duke's motion does that too; what Duke does not do
 * is draw from there. The view sits at fz-1024, just over the water, and
 * walking out into a sector without an SE7 lets the clamp pull posz back up.
 *
 * `spritebridge` is player.c 2417: the floor hit is a sprite with
 * `(cstat&33) == 33`. Sway and quake are already in `cposz`, as game.c has
 * them before this block.
 */
export function viewZ(map, cam, zr, cposz) {
  if (!map || !cam || cam.sectNum < 0 || !map.sectors[cam.sectNum]) return cposz;
  const t = getZsOfSlope(map, cam.sectNum, cam.x, cam.y);
  const trueCz = t.ceilZ, trueFz = t.floorZ;
  let spriteBridge = false;
  if (zr && zr.florHit >= 0 && (zr.florHit & 49152) === 49152) {
    const spr = map.sprites[zr.florHit & 4095];
    spriteBridge = !!spr && (spr.cstat & 33) === 33;
  }
  if (!spriteBridge && zr) {
    if (cposz < trueCz + (4 << 8)) cposz = zr.ceilZ + (4 << 8);
    else if (cposz > trueFz - (4 << 8)) cposz = zr.florZ - (4 << 8);
  }
  if (cposz < trueCz + (4 << 8)) cposz = trueCz + (4 << 8);
  if (cposz > trueFz - (4 << 8)) cposz = trueFz - (4 << 8);
  return cposz;
}

/**
 * operatesprite() for TOILET and STALL, sector.c 3073: with no urination
 * under way, DUKE_URINATE, last_pissed_time = 26*220, two seconds of
 * standing still (transporter_hold 58), the weapon holstered (weapon_pos -1),
 * and health: up a tenth of the maximum when at or under nine tenths, else
 * topped up to the maximum. While the timer runs, a second use only
 * flushes. Returns 'urinate', 'flush'.
 */
export function useToilet(st, maxHealth, say) {
  st.lastPissedTime = st.lastPissedTime || 0;
  if (st.lastPissedTime === 0) {
    say('DUKE_URINATE');
    st.lastPissedTime = 26 * 220;
    st.transporterHold = 29 * 2;
    if (!st.holsterWeapon) { st.holsterWeapon = 1; st.weaponPos = -1; }
    if (st.health <= maxHealth - Math.trunc(maxHealth / 10)) st.health += Math.trunc(maxHealth / 10);
    else if (st.health < maxHealth) st.health = maxHealth;
    return 'urinate';
  }
  say('FLUSH_TOILET');
  return 'flush';
}

/**
 * The urination timer, player.c 2146: counts down; at 26*219 the flush and
 * DUKE_PISSRELIEF; at 26*218 the weapon comes back up (holster off,
 * weapon_pos 10).
 */
export function pissTic(st, say) {
  if (!(st.lastPissedTime > 0)) return;
  st.lastPissedTime--;
  if (st.lastPissedTime === 26 * 219) { say('FLUSH_TOILET'); say('DUKE_PISSRELIEF'); }
  if (st.lastPissedTime === 26 * 218) { st.holsterWeapon = 0; st.weaponPos = 10; }
}


/**
 * The nuke-button punch, player.c 2454: fist_incs counts from 1; at 28 the
 * blast (PIPEBOMB_EXPLODE) and a white flash (pals 64,64,64 for 48 tics);
 * past 42 the level ends — returns 'eol' once and clears the count.
 */
export function fistTic(st, say) {
  if (!(st.fistIncs > 0)) return null;
  st.fistIncs++;
  if (st.fistIncs === 28) { say('PIPEBOMB_EXPLODE'); st.pal = { time: 48, r: 64, g: 64, b: 64 }; }
  if (st.fistIncs > 42) { st.fistIncs = 0; return 'eol'; }
  return null;
}

/**
 * Which level follows, player.c 2469: a button with a palette sends the
 * player to the secret level (`secretLevel - 1`) and remembers where to
 * come back to (from_bonus = level + 1); a plain button after a secret
 * level returns there; otherwise the next level, wrapping past 10 to 0.
 * `st` carries fromBonus between levels.
 */
export function nextLevel(st, level, buttonPal, secretLevel) {
  st.fromBonus = st.fromBonus || 0;
  let next;
  if (buttonPal && st.fromBonus === 0) {
    st.fromBonus = level + 1;
    next = (secretLevel > 0 && secretLevel < 12) ? secretLevel - 1 : level + 1;
  } else if (st.fromBonus) {
    next = st.fromBonus; st.fromBonus = 0;
  } else {
    next = level + 1;
    if (next > 10) next = 0;
  }
  return next;
}


/**
 * The key card going in, player.c 2227: access_incs counts from 1; at 12
 * the switch it was started on fires (the caller's `fire(target)`) and the
 * card of that palette is spent; past 20 the hand goes and the weapon
 * comes back (weapon_pos 10, kickback 0). Returns the target to fire at 12,
 * else null.
 */
export function accessTic(st) {
  if (!(st.accessIncs > 0)) return null;
  st.accessIncs++;
  let fire = null;
  if (st.accessIncs === 12 && st.accessTarget) {
    fire = st.accessTarget;              // the caller fires it and spends the card of its palette
    st.accessTarget = null;
  }
  if (st.accessIncs > 20) { st.accessIncs = 0; st.weaponPos = 10; st.kickback = 0; }
  return fire;
}


/**
 * What survives a level change, and what does not. Duke keeps the player
 * struct between levels — weapons, ammo, the current weapon, health,
 * shield and the inventory (jetpack, scuba, holoduke, medkit, boots,
 * night vision) — and premap.c's resetplayerstats() clears the rest:
 * got_access = 0 in single player (a new level, new key cards), the
 * counters. A new game (or a retry after death) starts fresh instead.
 */
export function carryPlayer(from, to) {
  to.gotWeapon.set(from.gotWeapon);
  to.ammoAmount.set(from.ammoAmount);
  to.currWeapon = from.currWeapon;
  to.health = from.health;
  to.shield = from.shield;
  if (from.inventory && to.inventory) {
    for (const k of Object.keys(from.inventory)) to.inventory[k] = from.inventory[k];
    to.inventory.access = 0;
  }
  return to;
}


// --- the interface keys (sector.c 2440..2906, player.c 2700/3398) ----------
//
// Duke's sync bits split in two. The level bits (move, turn, fire, jump,
// crouch, look, aim) are read every tic. The rest pass through
// interface_toggle_flag — a press counts once, on the tic it goes down — and
// run through one dispatcher at the top of processinput. The pieces of that
// dispatcher are below; the page feeds them edges from Duke's key table.

/** checkavailinven (actors.c 180): the first item there is, in Duke's order. */
export function checkAvailInven(st) {
  const inv = st.inventory;
  if (inv.firstaid > 0) st.invenIcon = 1;
  else if (inv.steroids > 0) st.invenIcon = 2;
  else if (inv.holoduke > 0) st.invenIcon = 3;
  else if (inv.jetpack > 0) st.invenIcon = 4;
  else if (inv.heat > 0) st.invenIcon = 5;
  else if (inv.scuba > 0) st.invenIcon = 6;
  else if (inv.boots > 0) st.invenIcon = 7;
  else st.invenIcon = 0;
}

/**
 * Inventory_Left / Inventory_Right (sector.c 2520, CHECKINV1). From the icon
 * shown, step through the ring 1 medkit, 2 steroids, 3 holoduke, 4 jetpack,
 * 5 night vision, 6 scuba, 7 boots until an item with charge is found; the
 * first step always moves (`i > 1`), nine steps without one is icon 0.
 * invdisptime 26*2. Returns the quote to show (FTA 3/90/91/88/101/89/6), or 0.
 */
export const INVEN_QUOTES = [0, 3, 90, 91, 88, 101, 89, 6];
export function cycleInventory(st, right) {
  const inv = st.inventory;
  const has = [inv.firstaid, inv.firstaid, inv.steroids, inv.holoduke, inv.jetpack, inv.heat, inv.scuba, inv.boots];
  const next = right ? [2, 2, 3, 4, 5, 6, 7, 1] : [7, 7, 1, 2, 3, 4, 5, 6];
  let dainv = st.invenIcon ?? 0;
  let i = 0;
  for (;;) {
    if (i >= 9) { dainv = 0; break; }
    i++;
    if (has[dainv] > 0 && i > 1) break;
    dainv = next[dainv];
  }
  st.invenIcon = dainv;
  st.invDispTime = 26 * 2;
  return INVEN_QUOTES[dainv];
}

/** The Inventory key (sector.c 2486): the item on show, as the key it stands for. */
export function inventoryFunction(st) {
  return ({ 4: 'Jetpack', 3: 'Holo_Duke', 5: 'NightVision', 1: 'MedKit', 2: 'Steroids' })[st.invenIcon] ?? null;
}

/**
 * Steroids (sector.c 2507): only a full bottle is taken — 400 becomes 399 and
 * the count runs down in steroidsTic. DUKE_TAKEPILLS, icon 2, quote 12.
 * Returns true if taken. Pressed, the key ends the dispatcher's tic (`return`).
 */
export function takeSteroids(st) {
  if (st.inventory.steroids !== 400) return false;
  st.inventory.steroids--;
  st.invenIcon = 2;
  return true;
}

/**
 * doincrements (player.c): a bottle taken runs down one a tic; empty, the
 * status bar looks for the next item; every eighth a heartbeat. Returns
 * 'heartbeat' on those tics.
 */
export function steroidsTic(st) {
  const inv = st.inventory;
  if (!(inv.steroids > 0 && inv.steroids < 400)) return null;
  inv.steroids--;
  if (inv.steroids === 0) checkAvailInven(st);
  return (inv.steroids & 7) === 0 ? 'heartbeat' : null;
}

/** On steroids, processinput doubles the walk (player.c 3274) — not with the jetpack. */
export const onSteroids = (st) => !st.jetpackOn && st.inventory.steroids > 0 && st.inventory.steroids < 400;

/**
 * MedKit (sector.c 2851): as much of the kit as the missing health, the rest
 * stays; a kit spent to the last point hands the icon on. Returns true if used
 * (the page plays DUKE_USEMEDKIT).
 */
export function useMedkit(st) {
  const inv = st.inventory;
  if (!(inv.firstaid > 0 && st.health < st.maxHealth)) return false;
  const j = st.maxHealth - st.health;
  if (inv.firstaid > j) { inv.firstaid -= j; st.health = st.maxHealth; st.invenIcon = 1; }
  else { st.health += inv.firstaid; inv.firstaid = 0; checkAvailInven(st); }
  return true;
}

/**
 * Holster_Weapon (sector.c 2800): with anything but the foot in hand, put it
 * away (weapon_pos -1 starts the sink, quote 73) or, once fully down (-9),
 * bring it back (weapon_pos 10, quote 74). Returns the quote or 0.
 *
 * The block sits inside the weapon-change branch, which runs only with no
 * cycle, kick, card or toilet under way — `canChangeWeapon`.
 */
export function toggleHolster(st) {
  if (!(st.currWeapon > WEAPON.KNEE)) return 0;
  if (!st.holsterWeapon && st.weaponPos === 0) { st.holsterWeapon = 1; st.weaponPos = -1; return 73; }
  if (st.holsterWeapon === 1 && st.weaponPos === -9) { st.holsterWeapon = 0; st.weaponPos = 10; return 74; }
  return 0;
}

/**
 * sector.c 2600: the condition for the weapon-change branch — no piss pause,
 * no empty-weapon flash, no cycle, no quick kick, not shrunk (sprite over 32
 * wide), no key card, no stomp; and the gun up (or holstered all the way down).
 */
export function canChangeWeapon(st, spriteXRepeat = 42) {
  const pissed = (st.lastPissedTime ?? 0) <= 26 * 218;
  const idle = pissed && !(st.showEmptyWeapon > 0) && !st.kickback && !(st.quickKick > 0)
    && spriteXRepeat > 32 && !(st.accessIncs > 0) && !st.kneeIncs;
  return idle && (st.weaponPos === 0 || (st.holsterWeapon && st.weaponPos === -9));
}

/**
 * Next_Weapon / Previous_Weapon (sector.c 2605): from the weapon in hand,
 * step through 0..9 (wrapping) to the next one owned WITH ammo; the shrinker
 * slot means the expander when subweapon says so, and a dry one of the pair
 * hands over to the other. Ten steps without a find give the foot.
 * Returns the slot to switch to, or -1.
 */
export function cycleWeapon(st, dir) {
  const GROW = WEAPON.GROW, SHRINK = WEAPON.SHRINKER;
  let sub = st.subweapon ?? (st.currWeapon === GROW ? 1 << GROW : 0);
  let k = st.currWeapon, j = -1, i = 0;
  while ((k >= 0 && k < 10) || (k === GROW && (sub & (1 << GROW)))) {
    if (k === GROW) k = dir < 0 ? 5 : 7;
    else { k += dir; if (k === 6 && (sub & (1 << GROW))) k = GROW; }
    if (k === -1) k = 9; else if (k === 10) k = 0;
    if (st.gotWeapon[k] && st.ammoAmount[k] > 0) {
      if (k === SHRINK && (sub & (1 << GROW))) k = GROW;
      j = k; break;
    } else if (k === GROW && st.ammoAmount[GROW] === 0 && st.gotWeapon[SHRINK] && st.ammoAmount[SHRINK] > 0) {
      j = SHRINK; sub &= ~(1 << GROW); break;
    } else if (k === SHRINK && st.ammoAmount[SHRINK] === 0 && st.gotWeapon[SHRINK] && st.ammoAmount[GROW] > 0) {
      j = GROW; sub |= 1 << GROW; break;
    }
    i++;
    if (i === 10) { j = WEAPON.KNEE; break; }
  }
  st.subweapon = sub;
  return j;
}

/** TurnAround (sector.c 2905): a half turn over eight tics, not while one runs. */
export function turnAround(st) {
  if (!st.oneEightyCount) st.oneEightyCount = -1024;
}
/** player.c 2780: 128 a tic until the 1024 are done. Returns the angle to add. */
export function turnAroundTic(st) {
  if (!(st.oneEightyCount < 0)) return 0;
  st.oneEightyCount += 128;
  return 128;
}

/**
 * The pitch keys, player.c 3398, once a tic. `input`: lookUp/lookDown (Look_Up/
 * Down, 12 a tic and the return to centre armed), aimUp/aimDown (Aim_Up/Down,
 * 6 a tic, stays), center (Center_View), run (the Run KEY — sync bit 5, not
 * auto run: both rates double while it is held), aimMode (mouse aiming on:
 * the 95..105 snap to level is off). The return to centre eases horiz toward
 * 100 while no look key is held, nine tics. Clamped to -99..299. Returns horiz.
 */
export function pitchTic(st, horiz, input = {}) {
  let h = horiz;
  if (input.center || st.hardLanding) st.returnToCenter = 9;
  if (input.lookUp) { st.returnToCenter = 9; if (input.run) h += 12; h += 12; }
  else if (input.lookDown) { st.returnToCenter = 9; if (input.run) h -= 12; h -= 12; }
  else if (input.aimUp) { if (input.run) h += 6; h += 6; }
  else if (input.aimDown) { if (input.run) h -= 6; h -= 6; }
  if (st.returnToCenter > 0 && !input.lookUp && !input.lookDown) {
    st.returnToCenter--;
    h += 33 - Math.trunc(h / 3);
  }
  // player.c 3433: the hard landing pulls the view down, less each tic.
  if (st.hardLanding > 0) { st.hardLanding--; h -= st.hardLanding << 4; }
  if (!input.aimMode && h > 95 && h < 105) h = 100;
  return Math.max(-99, Math.min(299, h));
}

/**
 * Look_Left / Look_Right (player.c 2703): look_ang fades by a quarter a tic,
 * then a held key swings it 152 and tilts the screen 24 the other way
 * (rotscrnang, which the renderer does not draw).
 */
export function lookSideTic(st, left, right) {
  st.lookAng = (st.lookAng ?? 0) - ((st.lookAng ?? 0) >> 2);
  if (left) { st.lookAng -= 152; st.rotScrnAng = (st.rotScrnAng ?? 0) + 24; }
  if (right) { st.lookAng += 152; st.rotScrnAng = (st.rotScrnAng ?? 0) - 24; }
}
