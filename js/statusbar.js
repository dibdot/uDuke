// Cache tripwire: see con.js.
export const MODULE_STAGE = 'stage12.195';

// uDuke - the status bar, game.c coolgaugetext() / weapon_amounts() /
// digitalnumber() / invennum() / minitext(), for ud.screen_size 8: the full
// bar. Duke draws it with rotatesprite in 320x200 screen units (dastat
// 2+8+16: scaled to the virtual screen, unclipped, anchored top-left); this
// module lists those placements — {tile, x, y, shade, pal} — and the page
// blits them. Everything is redrawn each frame: Duke's `u` dirty mask exists
// because its page flipping needs patching, a canvas does not.
//
// The bar is 34 rows (BOTTOMSTATUSBAR 2462, 320x34) at y 166, and the 3D
// view above it is 166 rows (premap.c vscrn: y2 -= 34 for screen_size 8).

export const BAR_HEIGHT = 34;
export const VIEW_HEIGHT = 200 - BAR_HEIGHT;

const BOTTOMSTATUSBAR = 2462, DIGITALNUM = 2472, THREEBYFIVE = 3010, MINIFONT = 3072;
const ICONS = { 1: 2460, 2: 2469, 3: 2470, 4: 2467, 5: 2461, 6: 2468, 7: 2463 };   // inven_icon -> FIRSTAID/STEROIDS/HOLODUKE/JETPACK/HEAT/AIRTANK/BOOT
const ACCESS_ICON = 2471;

/** digitalnumber(): the number centred on x with the DIGITALNUM font, one pixel between digits. */
function digitalNumber(out, art, x, y, n, shade) {
  const b = String(Math.trunc(n));
  let w = 0;
  for (const ch of b) w += (art.get(DIGITALNUM + (ch.charCodeAt(0) - 48))?.width ?? 0) + 1;
  let c = x - (w >> 1);
  for (const ch of b) {
    const p = DIGITALNUM + (ch.charCodeAt(0) - 48);
    out.push({ tile: p, x: c, y, shade, pal: 0 });
    c += (art.get(p)?.width ?? 0) + 1;
  }
}

/** minitext(): 4 pixels per character, 5 for a space, MINIFONT from '!'. */
function miniText(out, x, y, str, pal, shade = 0) {
  for (const ch of str.toUpperCase()) {
    if (ch === ' ') { x += 5; continue; }
    out.push({ tile: MINIFONT + ch.charCodeAt(0) - 33, x, y, shade, pal });
    x += 4;
  }
  return x;
}

const T35 = (d) => THREEBYFIVE + d;
const digits3 = (n) => String(Math.trunc(n)).split('').map((c) => c.charCodeAt(0) - 48);

/** weaponnum(): index digit (pal 7), colon, two two-digit numbers, a slash between. */
function weaponNum(out, ind, x, y, num1, num2, ha) {
  out.push({ tile: THREEBYFIVE + ind + 1, x: x - 7, y, shade: ha - 10, pal: 7 });
  out.push({ tile: THREEBYFIVE + 10, x: x - 3, y, shade: ha, pal: 0 });
  out.push({ tile: THREEBYFIVE + 11, x: x + 9, y, shade: ha, pal: 0 });
  num1 = Math.min(num1, 99); num2 = Math.min(num2, 99);
  const a = digits3(num1), b = digits3(num2);
  if (num1 > 9) { out.push({ tile: T35(a[0]), x, y, shade: ha, pal: 0 }); out.push({ tile: T35(a[1]), x: x + 4, y, shade: ha, pal: 0 }); }
  else out.push({ tile: T35(a[0]), x: x + 4, y, shade: ha, pal: 0 });
  if (num2 > 9) { out.push({ tile: T35(b[0]), x: x + 13, y, shade: ha, pal: 0 }); out.push({ tile: T35(b[1]), x: x + 17, y, shade: ha, pal: 0 }); }
  else out.push({ tile: T35(b[0]), x: x + 13, y, shade: ha, pal: 0 });
}

/** weaponnum999(): the three-digit form for pistol, shotgun and chaingun. */
function weaponNum999(out, ind, x, y, num1, num2, ha) {
  out.push({ tile: THREEBYFIVE + ind + 1, x: x - 7, y, shade: ha - 10, pal: 7 });
  out.push({ tile: THREEBYFIVE + 10, x: x - 4, y, shade: ha, pal: 0 });
  out.push({ tile: THREEBYFIVE + 11, x: x + 13, y, shade: ha, pal: 0 });
  const a = digits3(num1), b = digits3(num2);
  if (num1 > 99) { out.push({ tile: T35(a[0]), x, y, shade: ha, pal: 0 }); out.push({ tile: T35(a[1]), x: x + 4, y, shade: ha, pal: 0 }); out.push({ tile: T35(a[2]), x: x + 8, y, shade: ha, pal: 0 }); }
  else if (num1 > 9) { out.push({ tile: T35(a[0]), x: x + 4, y, shade: ha, pal: 0 }); out.push({ tile: T35(a[1]), x: x + 8, y, shade: ha, pal: 0 }); }
  else out.push({ tile: T35(a[0]), x: x + 8, y, shade: ha, pal: 0 });
  if (num2 > 99) { out.push({ tile: T35(b[0]), x: x + 17, y, shade: ha, pal: 0 }); out.push({ tile: T35(b[1]), x: x + 21, y, shade: ha, pal: 0 }); out.push({ tile: T35(b[2]), x: x + 25, y, shade: ha, pal: 0 }); }
  else if (num2 > 9) { out.push({ tile: T35(b[0]), x: x + 17, y, shade: ha, pal: 0 }); out.push({ tile: T35(b[1]), x: x + 21, y, shade: ha, pal: 0 }); }
  else out.push({ tile: T35(b[0]), x: x + 25, y, shade: ha, pal: 0 });
}

/** orderweaponnum(): the VOLUMEONE (shareware) form — index, colon, "ORDER". */
function orderWeaponNum(out, ind, x, y, ha) {
  out.push({ tile: THREEBYFIVE + ind + 1, x: x - 7, y, shade: ha - 10, pal: 7 });
  out.push({ tile: THREEBYFIVE + 10, x: x - 3, y, shade: ha, pal: 0 });
  miniText(out, x + 1, y - 4, 'ORDER', 6, 26);
}

/** invennum(): a one- to three-digit percentage in the small font, right-ish aligned. */
function invenNum(out, x, y, n, ha) {
  const d = digits3(Math.max(0, Math.min(255, n)));
  if (n > 99) { out.push({ tile: T35(d[0]), x: x - 4, y, shade: ha, pal: 0 }); out.push({ tile: T35(d[1]), x, y, shade: ha, pal: 0 }); out.push({ tile: T35(d[2]), x: x + 4, y, shade: ha, pal: 0 }); }
  else if (n > 9) { out.push({ tile: T35(d[0]), x, y, shade: ha, pal: 0 }); out.push({ tile: T35(d[1]), x: x + 4, y, shade: ha, pal: 0 }); }
  else out.push({ tile: T35(d[0]), x: x + 4, y, shade: ha, pal: 0 });
}

/**
 * coolgaugetext() for one player: the bar and everything on it, as
 * placements in 320x200 screen units. `shareware` lists the weapon slots
 * this GRP has no picture for (they show as ORDER, as the shareware does).
 */
export function statusBar(art, pl, opts = {}) {
  const out = [];
  const shareware = opts.shareware ?? [];
  const isVolumeOne = (w) => shareware.includes(w);
  out.push({ tile: BOTTOMSTATUSBAR, x: 0, y: 200 - 34, shade: 4, pal: 0 });

  // Key cards, at the right.
  const access = pl.inventory?.access ?? 0;
  if (access & 4) out.push({ tile: ACCESS_ICON, x: 275, y: 182, shade: 0, pal: 23 });
  if (access & 2) out.push({ tile: ACCESS_ICON, x: 288, y: 182, shade: 0, pal: 21 });
  if (access & 1) out.push({ tile: ACCESS_ICON, x: 281, y: 189, shade: 0, pal: 0 });

  // weapon_amounts(p, 96, 178): the ammo list, three rows six apart. Shade
  // 12 normal, 21 not owned, bright (12-18/19/20) for the one in hand.
  // chocolate_duke3D's call site says 182, but its own patchstatusbar
  // rectangles for the rows are 178..184, 184..190 and 190..196 — and the
  // WEAPONS box in BOTTOMSTATUSBAR is dark from row 176 to 194: at 182 the
  // third row lands on the frame (seen on the router). 178 is the number
  // the geometry and the patch rectangles agree on.
  const cw = pl.currWeapon, x = 96, y = 178;
  const got = (w) => !!pl.gotWeapon[w], ammo = (w) => pl.ammoAmount[w] ?? 0, max = (w) => pl.maxAmmoAmount[w] ?? 0;
  weaponNum999(out, 1, x, y, ammo(1), max(1), 12 - 20 * (cw === 1));
  weaponNum999(out, 2, x, y + 6, ammo(2), max(2), (!got(2) * 9) + 12 - 18 * (cw === 2));
  weaponNum999(out, 3, x, y + 12, ammo(3), max(3), (!got(3) * 9) + 12 - 18 * (cw === 3));
  weaponNum(out, 4, x + 39, y, ammo(4), max(4), (!got(4) * 9) + 12 - 19 * (cw === 4));
  weaponNum(out, 5, x + 39, y + 6, ammo(5), max(5), (((!ammo(5)) | (!got(5))) * 9) + 12 - 19 * ((cw === 5) || (cw === 10)));
  if (isVolumeOne(6)) orderWeaponNum(out, 6, x + 39, y + 12, (!got(6) * 9) + 12 - 18 * (cw === 6));
  else if (pl.subweapon & (1 << 11)) weaponNum(out, 6, x + 39, y + 12, ammo(11), max(11), (!got(11) * 9) + 12 - 18 * (cw === 11));
  else weaponNum(out, 6, x + 39, y + 12, ammo(6), max(6), (!got(6) * 9) + 12 - 18 * (cw === 6));
  if (isVolumeOne(7)) orderWeaponNum(out, 7, x + 70, y, (!got(7) * 9) + 12 - 18 * (cw === 7));
  else weaponNum(out, 7, x + 70, y, ammo(7), max(7), (!got(7) * 9) + 12 - 18 * (cw === 7));
  if (isVolumeOne(8)) orderWeaponNum(out, 8, x + 70, y + 6, (!got(8) * 9) + 12 - 18 * (cw === 8));
  else weaponNum(out, 8, x + 70, y + 6, ammo(8), max(8), (!got(8) * 9) + 12 - 18 * (cw === 8));
  if (isVolumeOne(9)) orderWeaponNum(out, -1, x + 70, y + 12, (!got(9) * 9) + 12 - 18 * (cw === 9));
  else weaponNum(out, -1, x + 70, y + 12, ammo(9), max(9), (!got(9) * 9) + 12 - 18 * (cw === 9));

  // Health (a frozen player at under 2 shows 1), armour, the ammo in hand.
  // coolgaugetext: `sprite[p->i].pal == 1 && last_extra < 2` shows 1 — the
  // frozen player (pal 1 until shattered or thawed).
  const health = (pl.frozen && !pl.shattered && pl.health < 2) ? 1 : Math.max(0, pl.health);
  digitalNumber(out, art, 32, 200 - 17, health, -16);
  digitalNumber(out, art, 64, 200 - 17, pl.shield ?? 0, -16);
  if (cw !== 0) {
    const w = cw === 10 ? 5 : cw;
    digitalNumber(out, art, 230 - 22, 200 - 17, ammo(w), -16);
  }

  // The inventory item last touched: icon, percentage, ON/OFF or AUTO.
  const icon = pl.invenIcon ?? 0;
  if (icon) {
    const inv = pl.inventory;
    out.push({ tile: ICONS[icon], x: 231, y: 200 - 21, shade: 0, pal: 0 });
    miniText(out, 292 - 30, 190, '%', 6);
    if (icon >= 6) miniText(out, 284 - 35, 180, 'AUTO', 2);
    let j = null;
    if (icon === 3) j = pl.holodukeOn >= 0 ? 1 : 0;
    if (icon === 4) j = pl.jetpackOn ? 1 : 0;
    if (icon === 5) j = pl.heatOn ? 1 : 0;
    if (j === 1) miniText(out, 288 - 30, 180, 'ON', 0);
    else if (j === 0) miniText(out, 284 - 30, 180, 'OFF', 2);
    let n = 0;
    switch (icon) {
      case 1: n = inv.firstaid; break;
      case 2: n = (inv.steroids + 3) >> 2; break;
      case 3: n = Math.trunc((inv.holoduke + 15) / 24); break;
      case 4: n = (inv.jetpack + 15) >> 4; break;
      case 5: n = Math.trunc(inv.heat / 12); break;
      case 6: n = (inv.scuba + 63) >> 6; break;
      case 7: n = inv.boots >> 1; break;
      default: break;
    }
    invenNum(out, 284 - 30, 200 - 6, n, 0);
  }
  return out;
}

const HEALTHBOX = 30, AMMOBOX = 31, INVENTORYBOX = 33;

/**
 * coolgaugetext() at ud.screen_size 4, game.c 1945 ("DRAW MINI STATUS
 * BAR"): the full 200-row view with three boxes at its bottom left, no bar.
 * HEALTHBOX at (5,172) with the health on (20,183), AMMOBOX at (37,172)
 * with the ammo of the weapon in hand (the detonator counts its pipe bombs)
 * on (53,183) — no armour —, and with an item to show, INVENTORYBOX at
 * (69,170) and the item as the bar has it, 158 further left (o = 158). The
 * boxes in pal 21, the numbers at shade -16; dastat 10+16, top-left anchored.
 * As placements in 320x200 units; `ox` moves them all left by ox (a widened
 * view: to its left edge). Duke's own 1.5 has no other form of this HUD
 * (the chocolate port's extended_screen_size one is its own addition).
 */
export function miniStatusBar(art, pl, ox = 0) {
  const out = [];
  const icon = pl.invenIcon ?? 0;
  if (icon) out.push({ tile: INVENTORYBOX, x: 69, y: 200 - 30, shade: 0, pal: 21 });
  out.push({ tile: HEALTHBOX, x: 5, y: 200 - 28, shade: 0, pal: 21 });
  const health = (pl.frozen && !pl.shattered && pl.health < 2) ? 1 : Math.max(0, pl.health);
  digitalNumber(out, art, 20, 200 - 17, health, -16);
  out.push({ tile: AMMOBOX, x: 37, y: 200 - 28, shade: 0, pal: 21 });
  const w = pl.currWeapon === 10 ? 5 : pl.currWeapon;
  digitalNumber(out, art, 53, 200 - 17, pl.ammoAmount[w] ?? 0, -16);
  if (icon) {
    const o = 158, inv = pl.inventory;
    if (ICONS[icon]) out.push({ tile: ICONS[icon], x: 231 - o, y: 200 - 21, shade: 0, pal: 0 });
    miniText(out, 292 - 30 - o, 190, '%', 6);
    let n = 0, j = null;
    switch (icon) {
      case 1: n = inv.firstaid; break;
      case 2: n = (inv.steroids + 3) >> 2; break;
      case 3: n = Math.trunc((inv.holoduke + 15) / 24); j = pl.holodukeOn >= 0 ? 1 : 0; break;
      case 4: n = (inv.jetpack + 15) >> 4; j = pl.jetpackOn ? 1 : 0; break;
      case 5: n = Math.trunc(inv.heat / 12); j = pl.heatOn ? 1 : 0; break;
      case 6: n = (inv.scuba + 63) >> 6; break;
      case 7: n = inv.boots >> 1; break;
      default: break;
    }
    invenNum(out, 284 - 30 - o, 200 - 6, n, 0);
    if (j === 1) miniText(out, 288 - 30 - o, 180, 'ON', 0);
    else if (j === 0) miniText(out, 284 - 30 - o, 180, 'OFF', 2);
    if (icon >= 6) miniText(out, 284 - 35 - o, 180, 'AUTO', 2);
  }
  if (ox) for (const q of out) q.x -= ox;
  return out;
}
