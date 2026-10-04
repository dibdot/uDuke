// Cache tripwire: see version.js.
export const MODULE_STAGE = 'stage12.194';

// uDuke - displayweapon(): the gun in Duke's hands. player.c 1294..1630.
//
// Pure placement: given the player's state, which tiles go where on the
// 320x200 screen this frame. The page blits them. Duke's rotatesprite puts a
// tile's CENTRE plus its picanm offset at (x, y) — dorotatesprite: `xoff =
// picanm.x + width/2`, `yoff = picanm.y + height/2` — and `o|4` flips it
// horizontally (angle 1024 with the y-offset mirrored). Coordinates are the
// 320x200 ones the original used; the page scales.

const FIRSTGUN = 2524, SHOTGUN = 2613, CHAINGUN = 2536, RPGGUN = 2544, DEVISTATOR = 2510,
  HANDTHROW = 2573, HANDREMOTE = 2570, HANDHOLDINGLASER = 2563, KNEE = 2521,
  SHRINKER = 2556, FREEZE = 2548;

/** Build's sintable, amplitude 16384. */
const bsin = (a) => Math.round(Math.sin(((a & 2047) * Math.PI) / 1024) * 16384);

/**
 * The frames for this tic: `[{ tile, x, y, flip, shade }]`, back to front.
 * `st` is player.js's state (currWeapon, lastWeapon, weaponPos, kickback,
 * weaponSway, hardLanding); `shade` is the sprite's — the sector's floor
 * shade, capped at 24 — and `rnd` supplies the chaingun's judder.
 */
export function weaponFrames(st, shade = 0, rnd = () => 0) {
  const kb = st.kickback || 0;
  const gs = Math.min(24, shade);
  const lookingArc = 0;                                  // look_ang: none here
  let gunPos = 80 - st.weaponPos * st.weaponPos;
  let xoff = 160 - 90;
  xoff -= Math.trunc(bsin((st.weaponSway >> 1) + 512) / (1024 + 512));
  xoff -= 58;                                            // + weapon_ang, none here
  gunPos -= Math.abs(bsin(st.weaponSway >> 1) >> 10);
  gunPos -= (st.hardLanding || 0) << 3;
  const cw = st.lastWeapon >= 0 ? st.lastWeapon : st.currWeapon;
  const out = [];
  const put = (x, y, tile, sh = gs, flip = false) => out.push({ tile, x, y, flip, shade: sh });

  switch (cw) {
    case 1: {                                            // PISTOL_WEAPON
      if (kb < 5) {
        const frames = [0, 1, 2, 0, 0];
        let l = 195 - 12 + xoff;
        if (kb === 2) l -= 3;
        put(l, lookingArc + 244 - gunPos, FIRSTGUN + frames[kb]);
      } else if (kb < 10) {
        put(194, lookingArc + 230 - gunPos, FIRSTGUN + 4);
      } else if (kb < 15) {
        put(244 - (kb << 3), lookingArc + 130 - gunPos + (kb << 4), FIRSTGUN + 6);
        put(224, lookingArc + 220 - gunPos, FIRSTGUN + 5);
      } else if (kb < 20) {
        put(124 + (kb << 1), lookingArc + 430 - gunPos - (kb << 3), FIRSTGUN + 6);
        put(224, lookingArc + 220 - gunPos, FIRSTGUN + 5);
      } else if (kb < 23) {
        put(184, lookingArc + 235 - gunPos, FIRSTGUN + 8);
        put(224, lookingArc + 210 - gunPos, FIRSTGUN + 5);
      } else if (kb < 25) {
        put(164, lookingArc + 245 - gunPos, FIRSTGUN + 8);
        put(224, lookingArc + 220 - gunPos, FIRSTGUN + 5);
      } else if (kb < 27) {
        put(194, lookingArc + 235 - gunPos, FIRSTGUN + 5);
      }
      break;
    }
    case 2: {                                            // SHOTGUN_WEAPON
      xoff -= 8;
      switch (kb) {
        case 1: case 2:
          put(xoff + 168, lookingArc + 201 - gunPos, SHOTGUN + 2, -128);
          // fall through
        case 0: case 6: case 7: case 8:
          put(xoff + 146, lookingArc + 202 - gunPos, SHOTGUN);
          break;
        case 3: case 4: case 5: case 9: case 10: case 11: case 12:
          if (kb > 1 && kb < 5) {
            gunPos -= 40; xoff += 20;
            put(xoff + 178, lookingArc + 194 - gunPos, SHOTGUN + 1 + ((kb - 1) >> 1), -128);
          }
          put(xoff + 158, lookingArc + 220 - gunPos, SHOTGUN + 3);
          break;
        case 13: case 14: case 15:
          put(32 + xoff + 166, lookingArc + 210 - gunPos, SHOTGUN + 4);
          break;
        case 16: case 17: case 18: case 19:
          put(64 + xoff + 170, lookingArc + 196 - gunPos, SHOTGUN + 5);
          break;
        case 20: case 21: case 22: case 23:
          put(64 + xoff + 176, lookingArc + 196 - gunPos, SHOTGUN + 6);
          break;
        case 24: case 25: case 26: case 27:
          put(64 + xoff + 170, lookingArc + 196 - gunPos, SHOTGUN + 5);
          break;
        case 28: case 29: case 30:
          put(32 + xoff + 156, lookingArc + 206 - gunPos, SHOTGUN + 4);
          break;
        default:
          put(xoff + 146, lookingArc + 202 - gunPos, SHOTGUN);
          break;
      }
      break;
    }
    case 3: {                                            // CHAINGUN_WEAPON
      if (kb > 0) gunPos -= bsin(kb << 7) >> 12;
      if (kb > 0) xoff += 1 - (rnd() & 3);
      put(xoff + 168, lookingArc + 260 - gunPos, CHAINGUN);
      if (kb === 0) {
        put(xoff + 178, lookingArc + 233 - gunPos, CHAINGUN + 1);
      } else {
        if (kb > 4 && kb < 12) {
          let i = rnd() & 7;
          put(i + xoff - 4 + 140, i + lookingArc - (kb >> 1) + 208 - gunPos, CHAINGUN + 5 + Math.trunc((kb - 4) / 5));
          i = rnd() & 7;
          put(i + xoff - 4 + 184, i + lookingArc - (kb >> 1) + 208 - gunPos, CHAINGUN + 5 + Math.trunc((kb - 4) / 5));
        }
        if (kb < 8) {
          const i = rnd() & 7;
          put(i + xoff - 4 + 162, i + lookingArc - (kb >> 1) + 208 - gunPos, CHAINGUN + 5 + Math.trunc((kb - 2) / 5));
          put(xoff + 178, lookingArc + 233 - gunPos, CHAINGUN + 1 + (kb >> 1));
        } else {
          put(xoff + 178, lookingArc + 233 - gunPos, CHAINGUN + 1);
        }
      }
      break;
    }
    case 4: {                                            // RPG_WEAPON
      // The launcher swings with the count: sin(768 + kb<<7) on both axes.
      xoff -= bsin(768 + (kb << 7)) >> 11;
      gunPos += bsin(768 + ((kb << 7) & 2047)) >> 11;
      if (kb > 0 && kb < 8) put(xoff + 164, (lookingArc << 1) + 176 - gunPos, RPGGUN + (kb >> 1));
      put(xoff + 164, (lookingArc << 1) + 176 - gunPos, RPGGUN);
      break;
    }
    case 7: {                                            // DEVISTATOR_WEAPON
      // Two launchers, right (268) and left (30, mirrored). The one that
      // fires bobs on a cycloid and shows DEVISTATOR+1 from count 4.
      const cycloidy = [0, 4, 12, 24, 12, 4, 0];
      if (kb) {
        const i = kb >> 2 ? 1 : 0;
        const cy = cycloidy[Math.min(kb, 6)];
        if (st.holdDelay) {
          put((cy >> 1) + xoff + 268, cy + lookingArc + 238 - gunPos, DEVISTATOR + i, -32);
          put(xoff + 30, lookingArc + 240 - gunPos, DEVISTATOR, gs, true);
        } else {
          put(-(cy >> 1) + xoff + 30, cy + lookingArc + 240 - gunPos, DEVISTATOR + i, -32, true);
          put(xoff + 268, lookingArc + 238 - gunPos, DEVISTATOR);
        }
      } else {
        put(xoff + 268, lookingArc + 238 - gunPos, DEVISTATOR);
        put(xoff + 30, lookingArc + 240 - gunPos, DEVISTATOR, gs, true);
      }
      break;
    }
    case 5: {                                            // HANDBOMB_WEAPON
      // The hand with the bomb: down for six counts, up to the throw at 12,
      // down again after it; the frames 0/1/2 by throw_frames[].
      if (kb) {
        const throwFrames = [0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2];
        if (kb < 7) gunPos -= 10 * kb;
        else if (kb < 12) gunPos += 20 * (kb - 10);
        else if (kb < 20) gunPos -= 9 * (kb - 14);
        put(xoff + 190, lookingArc + 250 - gunPos, HANDTHROW + throwFrames[Math.min(kb, 20)]);
      } else {
        put(xoff + 190, lookingArc + 260 - gunPos, HANDTHROW);
      }
      break;
    }
    case 10: {                                           // HANDREMOTE_WEAPON
      const remoteFrames = [0, 1, 1, 2, 1, 1, 0, 0, 0, 0, 0];
      const x0 = -48;
      put(x0 + 150, lookingArc + 258 - gunPos, HANDREMOTE + (kb ? remoteFrames[Math.min(kb, 10)] : 0));
      break;
    }
    case 8: {                                            // TRIPBOMB_WEAPON
      // Two hands (the right mirrored) holding the bomb, HANDHOLDINGLASER +
      // kb>>2; before count 4 the bomb itself (+3) sits between them; past
      // 6 the hands drop by kb<<3 (looking_arc).
      xoff += 8;
      gunPos -= 10;
      let arc = lookingArc;
      if (kb > 6) arc += kb << 3;
      else if (kb < 4) put(xoff + 142, arc + 234 - gunPos, HANDHOLDINGLASER + 3);
      put(xoff + 130, arc + 249 - gunPos, HANDHOLDINGLASER + (kb >> 2));
      put(xoff + 152, arc + 249 - gunPos, HANDHOLDINGLASER + (kb >> 2), gs, true);
      break;
    }
    case 0: {                                            // KNEE_WEAPON
      if (kb > 0) {
        if (kb < 5 || kb > 9) put(xoff + 220, lookingArc + 250 - gunPos, KNEE);
        else put(xoff + 160, lookingArc + 214 - gunPos, KNEE + 1);
      }
      break;
    }
    case 6:                                              // SHRINKER_WEAPON
    case 11: {                                           // GROW_WEAPON
      // The gun and its crystal: at rest the crystal (SHRINKER+2) pulses in
      // shade (random_club_frame); firing, SHRINKER+3+(kb&3) with a jitter.
      // The expander is the same gun two tiles lower (SHRINKER-2/-1), the
      // crystal in pal 2. `pal` rides on the frame for the page.
      const grow = cw === 11;
      const pulse = 16 - (bsin(st.clubFrame || 0) >> 10);
      if (kb === 0) {
        put(xoff + 184, lookingArc + 240 - gunPos, SHRINKER + 2, pulse);
        out[out.length - 1].pal = grow ? 2 : 0;
        put(xoff + 188, lookingArc + 240 - gunPos, grow ? SHRINKER - 2 : SHRINKER);
      } else {
        const jx = rnd() & 3, jy = rnd() & 3;
        put(xoff + jx + 184, lookingArc + 240 - gunPos - jy, SHRINKER + 3 + (kb & 3), -32);
        out[out.length - 1].pal = grow ? 2 : 0;
        put(xoff + jx + 188, lookingArc + 240 - gunPos - jy, grow ? SHRINKER - 1 : SHRINKER + 1);
      }
      break;
    }
    case 9: {                                            // FREEZE_WEAPON
      const catFrames = [0, 0, 1, 1, 2, 2];
      if (kb) {
        const jx = rnd() & 3, jy = rnd() & 3;
        put(xoff + jx + 210, lookingArc + 261 - gunPos - jy, FREEZE + 2, -32);
        put(xoff + jx + 210, lookingArc + 235 - gunPos - jy, FREEZE + 3 + catFrames[kb % 6], -32);
      } else {
        put(xoff + 210, lookingArc + 261 - gunPos, FREEZE);
      }
      break;
    }
    default:
      break;
  }
  return out;
}

/**
 * Where a frame's tile goes on the 320x200 canvas, top-left, from the anchor
 * rule of dorotatesprite: pixel (picanm.x + w/2, picanm.y + h/2) lands on
 * (x, y); flipped, the y-offset is mirrored and the tile drawn mirrored.
 */
export function tilePlacement(frame, tile) {
  const w = tile.width, h = tile.height;
  const xo = (tile.anim?.xOffset ?? 0) + (w >> 1);
  const yo = (tile.anim?.yOffset ?? 0) + (h >> 1);
  // A zoomed frame (rotatesprite's z, as a fraction of 65536) scales about
  // its anchor: the fist punching the nuke button.
  // dastat&16: the top-left corner is the anchor (the scuba mask).
  if (frame.corner) return { left: frame.x, top: frame.y };
  if (frame.zoom && frame.zoom !== 1) return { left: frame.x - xo * frame.zoom, top: frame.y - yo * frame.zoom, scale: frame.zoom };
  if (!frame.flip) return { left: frame.x - xo, top: frame.y - yo };
  // `o|4`: dorotatesprite with dastat&4 (yoff = h - yoff) at angle 1024. A
  // half turn about the anchor followed by the y-flip is a horizontal
  // mirror — and the anchor pixel is mirrored with it. Original pixel
  // (px, py) lands at (x + xo - px, y - h + yo + py): the tile spans
  // x - (w - xo) .. x + xo and y - (h - yo) .. y + yo. The first version
  // mirrored only the y offset, so a tile with a picanm x offset — the
  // hand holding the trip bomb — sat on the wrong side of its anchor.
  return { left: frame.x - (w - xo) + 1, top: frame.y - (h - yo) };
}


/**
 * displayweapon 1355, a shrunk Duke (the sprite under 40 wide): no weapon,
 * two FISTs (1640) pumping as he runs. fistsign is a running phase, moved
 * by xvel/2 a frame (on foot; the jetpack keeps it still), and looking_arc
 * is raised by 32 - xvel/2. The right fist sits at x 250 + sin(fistsign)>>10
 * from the weapon's x, y 258 - |sin>>8|; the left, mirrored, at x 40 -
 * sin>>10, y 200 + |sin>>8| — one up while the other is down. The weapon's
 * x is 160-90-58 = 12 with no sway or turn.
 */
export function shrunkFistFrames(fistsign, xvel, jetpackOn, shade = 0) {
  let arc = 0;
  if (!jetpackOn) arc += 32 - (xvel >> 1);
  const sn = bsin(fistsign & 2047);
  const wx = 12;
  return [
    { tile: 1640, x: wx + (sn >> 10) + 250, y: arc + 258 - Math.abs(sn >> 8), flip: false, shade },
    { tile: 1640, x: wx - (sn >> 10) + 40, y: arc + 200 + Math.abs(sn >> 8), flip: true, shade },
  ];
}

/** The phase step of the shrunk fists for one frame: xvel/2 on foot, nothing with the jetpack. */
export function shrunkFistStep(fistsign, xvel, jetpackOn) {
  return jetpackOn ? fistsign : (fistsign + (xvel >> 1)) & 2047;
}

/**
 * displayfist(), player.c 1138: Duke's fist rising to punch the nuke
 * button. fisti = fist_incs capped at 32; zoom 65536 - (sin(512+fisti*64)
 * << 2) clamped to 40920..90612; y = 194 + (sin((6+fisti)*128) >> 9); x =
 * 222 - fisti (plus the turn rate, none here). FIST is tile 1640, drawn
 * with the sector's floor pal (0 here).
 */
export function fistFrame(fistIncs, shade = 0) {
  let fisti = Math.min(32, fistIncs);
  if (fisti <= 0) return null;
  let zoom = 65536 - (bsin((512 + (fisti << 6)) & 2047) << 2);
  if (zoom > 90612) zoom = 90612;
  if (zoom < 40920) zoom = 40290;
  const y = 194 + (bsin(((6 + fisti) << 7) & 2047) >> 9);
  return { tile: 1640, x: 222 - fisti, y, flip: false, shade, zoom: zoom / 65536 };
}


const ACCESS_Y = [0, -8, -16, -32, -64, -84, -108, -108, -108, -108, -108, -108, -108, -108, -108, -108, -96, -72, -64, -32, -16];

/**
 * displayaccess(), player.c 1269: the hand holding the key card, in the
 * card's palette. y = 266 + access_y[incs] (the hand rises 108 then sinks
 * back), x = 170 + (access_y >> 2); from the fourth tic on the frames are
 * HANDHOLDINGLASER + (incs >> 3) — the card going in — else
 * HANDHOLDINGACCESS mirrored.
 */
/**
 * animatetip(), player.c 1241: the hand offering a bill. tipincs runs
 * 26 down to 1; tip_y[] is the same 21-entry arc the access card uses,
 * read at tipincs — indices 21..26 are past the array in Duke (six tics of
 * whatever sits after it; 0 here, the hand still off screen), then the arc
 * up and down. The tile is TIP (2576) for tipincs over 10, TIP+1 (the bill
 * held out) from 10 down. x 170, y 240 + arc/2 - (horiz-100)/16, in the
 * sector's floor pal.
 */
export function tipFrame(tipIncs, horiz = 100, pal = 0, shade = 0) {
  const k = tipIncs | 0;
  if (k <= 0) return null;
  const arc = k < ACCESS_Y.length ? ACCESS_Y[k] : 0;
  return { tile: 2576 + ((26 - k) >> 4), x: 170, y: 240 + (arc >> 1) - ((horiz - 100) >> 4), flip: false, shade, pal };
}

/**
 * displaymasks(), player.c 1226: with the scuba on, SCUBAMASK (2581) in
 * both lower corners — left at x 43, right at 320-43 mirrored, y 200-8
 * minus the tile's height (the full-screen layout), top-left anchored
 * (dastat 16), translucent, in the sector's floor pal. Drawn under the
 * weapon, which is not replaced.
 */
export function scubaFrames(tileW, tileH, pal = 0) {
  const y = 200 - 8 - tileH;
  return [
    { tile: 2581, x: 43, y, flip: false, corner: true, shade: 0, pal, translucent: true },
    { tile: 2581, x: 320 - 43 - tileW, y, flip: true, corner: true, shade: 0, pal, translucent: true },
  ];
}

export function accessFrame(accessIncs, pal = 0, shade = 0) {
  const k = accessIncs | 0;
  if (k <= 0 || k >= ACCESS_Y.length) return null;
  const y = 266 + ACCESS_Y[k];
  const x = 170 + (ACCESS_Y[k] >> 2);
  if (k - 3 > 0 && (k - 3) >> 3) return { tile: 2563 + (k >> 3), x, y, flip: false, shade, pal };
  return { tile: 2568, x, y, flip: true, shade, pal };
}

/**
 * cameratext(), game.c — what displayrooms puts over a camera's picture in
 * place of the weapon (game.c 2757: `if (newowner >= 0) cameratext(...)
 * else displayweapon(...)`). A working camera (T1 0): CAMCORNER (2482) at
 * the top left, CAMCORNER+1 at the top right and, turned a quarter (angle
 * 512), at the bottom right — and at the bottom left turned and flipped
 * (dastat 4) — with CAMLIGHT (2484) blinking on `totalclock & 16` (16 of
 * every 32 ticks at 120 Hz). A destroyed one (T1 1): STATIC (351) tiled
 * every 64 from 0..393 by 0..199, its anchor jumping between centre and
 * corner with `(totalclock<<1) & 48` — dastat 16 is the top-left anchor;
 * 32 (reverse translucency) does nothing without 1.
 *
 * All with dastat 2: rotatesprite scales to the 3D window — x is the same
 * at 320 wide, y is measured from the window's middle: with the status bar
 * (166 rows) everything sits 17 rows higher. `viewH` is the window height.
 * Frames: { tile, x, y, ang (Build units), yflip, corner }.
 */
export function cameraTextFrames(destroyed, totalclock, viewH = 200, ox = 0) {
  // `ox`: how far a widened view reaches past the 320 screen on each
  // side. The frame belongs to the view's edges, so the left corners and
  // the light move out by ox, the right ones in the other direction, and
  // the static covers the whole width. At ox 0, Duke's numbers.
  const dy = (viewH - 200) >> 1;
  const f = [];
  if (!destroyed) {
    f.push({ tile: 2482, x: 24 - ox, y: 33 + dy, ang: 0 });
    f.push({ tile: 2483, x: 320 - 26 + ox, y: 34 + dy, ang: 0 });
    f.push({ tile: 2483, x: 22 - ox, y: 163 + dy, ang: 512, yflip: true });
    f.push({ tile: 2483, x: 310 - 10 + ox, y: 163 + dy, ang: 512 });
    if (totalclock & 16) f.push({ tile: 2484, x: 46 - ox, y: 32 + dy, ang: 0 });
  } else {
    const corner = !!(((totalclock << 1) & 48) & 16);
    for (let x = -Math.ceil(ox / 64) * 64; x < 394 + ox; x += 64) for (let y = 0; y < 200; y += 64) f.push({ tile: 351, x, y: y + dy, ang: 0, corner });
  }
  return f;
}

/**
 * dorotatesprite's geometry for a frame with an angle and dastat 4/16:
 * xoff = picanm x + w/2, yoff = picanm y + h/2 (0 and 0 with dastat 16),
 * `if (dastat&4) yoff = h - yoff` with the tile read upside down, then a
 * tile pixel (u, v) lands at anchor + R(a)·(u - xoff, v - yoff), where the
 * tile's x runs along (cos a, sin a) on screen — `yv*xoff + xv*yoff` in
 * engine.c. Angle 512 is a quarter turn clockwise (screen y down).
 * Returns the canvas transform: translate(x, y), rotate(rot), then the
 * (flipped) tile at (left, top).
 */
export function rotatedPlacement(frame, tile) {
  const w = tile.width, h = tile.height;
  let xo = frame.corner ? 0 : (tile.anim?.xOffset ?? 0) + (w >> 1);
  let yo = frame.corner ? 0 : (tile.anim?.yOffset ?? 0) + (h >> 1);
  if (frame.yflip) yo = h - yo;
  return { x: frame.x, y: frame.y, rot: ((frame.ang ?? 0) & 2047) * Math.PI / 1024, left: -xo, top: -yo, yflip: !!frame.yflip };
}

/** Where a frame's tile pixel (u, v) lands on screen — the same map, for tests. */
export function rotatedPixel(frame, tile, u, v) {
  const p = rotatedPlacement(frame, tile);
  const r = frame.yflip ? tile.height - 1 - v : v;
  const lx = u + p.left, ly = r + p.top;
  const c = Math.round(Math.cos(p.rot)), s = Math.round(Math.sin(p.rot));
  return [p.x + lx * c - ly * s, p.y + lx * s + ly * c];
}
