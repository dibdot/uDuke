// Cache tripwire: every module carries the stage it shipped with, and boot.js
// refuses to run a mix. A browser that re-fetched one file and kept another
// from its cache showed up as 'HEALTH undefined' — a field the stale
// player.js did not have. That is the third stale-cache report; this makes
// the fourth say which file.
export const MODULE_STAGE = 'stage12.195';

/**
 * How far behind the stored depth a sprite may be and still be drawn.
 *
 * Build has no depth buffer. Masked walls and sprites are drawn in their own
 * pass, back to front, and they overwrite whatever is already there — a tie
 * cannot arise, because the question is settled by ORDER and not by a number.
 * uDuke's per-pixel z-buffer is its own construction, and a wall-aligned
 * sprite is exactly coplanar with the wall it hangs on: the two depths agree
 * to eleven digits and differ only by rounding, so `invZ <= zbuf[i]` threw the
 * sprite away in whichever columns the noise happened to fall the wrong way.
 * That is the vertical striping on switches, signs and control panels — the
 * sprites that by definition sit flat against a wall.
 *
 * So sprites win ties, which is what drawing them last means. The threshold is
 * measured rather than chosen. Sweeping 120 viewpoints across E1L5 and
 * recording the relative depth difference of every REJECTED sprite pixel:
 *
 *     coplanar ties (22 % of rejections)    0     .. 7.5e-9
 *     smallest genuine occlusion            3.4e-4
 *
 * Eight orders of magnitude of empty space between them. 1e-6 is the middle of
 * that gap on a log scale — about 130x above the worst tie and 340x below the
 * closest real occlusion — so it is a bound read off a measurement, not a
 * number turned until the picture looked right.
 */
export const SPRITE_DEPTH_TIE = 1e-6;

// uDuke - stage 3b portal renderer.
//
// Vertical walls only, flat floors and ceilings, one colour per surface. No
// textures, no slopes, no sprites.
//
// Traversal follows Build rather than the recursive portal descent of stage
// 3a: sectors are flooded once per frame, their visible walls are grouped into
// bunches, and the bunches are drawn front to back against one global pair of
// column clip arrays. That removes the three stopgaps 3a needed — a per-sector
// visit cap, a guard against re-entering the camera's sector, and a recursion
// depth limit — because no sector is ever scanned twice.
//
// One deliberate departure: Build accumulates floor and ceiling spans per
// bunch and clips them by hand. This keeps the per-pixel depth buffer instead,
// which gets flats right without the span bookkeeping and, more usefully,
// makes sorting mistakes measurable — see stats.sortErrors.

import { sectorLoops, getZsOfSlope } from './map.js';
import { classifyLoops, loopSignedArea } from './geometry.js';
import { nearestIndex } from './palette.js';
import { animOffset } from './art.js';

// The stage number lives in js/version.js — it names the whole tree, not this
// file. Re-exported here because that is where callers have always found it.
export { STAGE as VERSION } from './version.js';

const NEAR = 4;               // near plane, Build units
const BUNCH_BUDGET = 4096;

// Horizontal texture span of a wall, in texels: Build stores xrepeat as a
// byte and the engine works in units of eight.
const U_PER_XREPEAT = 8;

// Texels of wall height per Build z unit, per unit of yrepeat.
//
// Settled against the original running side by side: at yrepeat 8 this puts
// one texel every 16 Build units, matching what xrepeat gives horizontally.
// The first guess of 1/256 was eight times too fine, which made wall art
// repeat eight times too often up the wall and alias badly under point
// sampling. Overridable per render() call.
//
// The cross-check that needs no reference: a lower step has to line up with
// the solid wall beside it, because Duke's maps depend on that.
const V_PER_YREPEAT = 1 / 2048;

// Texels per Build unit for floors and ceilings.
//
// Flats have no per-sector repeat field — Build fixes the scale in the engine
// and maps them to world coordinates, which is why a floor texture runs
// continuously across sector boundaries instead of restarting.
//
// Derived, not calibrated, and the derivation needs both halves of the engine.
// ceilscan() builds the origin
//
//   globalxpanning = (globalposx<<20);
//   globalxshift = (8 - (picsiz[globalpicnum]&15));   // 8 - log2 width
//   globalxpanning <<= globalxshift;
//
// so the accumulator holds posx << (28 - log2 w). hlineasm4() then takes the
// texel from the TOP log2(w) bits of that 32-bit word:
//
//   source = i5 >> ((256-machxbits_al) & 0x1f);       // i5 >> (32 - log2 w)
//
// and the two shifts cancel exactly: u = posx >> 4, whatever the tile's
// resolution. grouscan lands on the same figure by the same cancellation —
// globalx1 <<= (i+12) against slopevlin's ah1/ah2 — so slopes share it.
//
// **One sixteenth of a texel per Build unit, for every flat tile.** A 64-wide
// tile therefore spans 1024 units and a 128-wide one spans 2048: the world
// span scales WITH the resolution, it is not constant across resolutions.
//
// A reading of `8 - log2(size)` in ceilscan alone as "every flat tile covers
// the same world area" stops one file too early: the shift there compensates the
// fetch shift in draw.c and means nothing on its own. It made 128-wide flats
// run twice as fast as they should, which is what put E1L5's sloped ceiling
// out of step with the wall it meets.
//
// bit 3 increments both shifts, so it doubles the rate — half-size texels.
//
// Nothing here is measured any more, so flatScale is a multiplier defaulting
// to 1: if it has to be moved, that is a finding rather than a setting.
const FLAT_TEXELS_PER_UNIT = 1 / 16;

// How the sky wraps around a full turn. Build divides the 2048 angle units
// into 2^pskybits segments and picks a tile per segment through pskyoff, so a
// panorama is a permutation of a handful of tiles rather than a run of them.
//
// These numbers are GAME data, not engine or map data: Duke3D sets them in
// setupbackdrop() per base tile, and nothing in the GRP or the MAP records
// them. Reproduced here because uDuke parses no CON. Everything else in this
// file is derived from the format or the engine; this table is not, so it is
// the first thing to distrust if a sky looks wrong in a mod or a user map.
/**
 * ypanning in texels.
 *
 * Build shifts the byte up by 24 and reads the texel through a shift of
 * 32-L, where L = ceil(log2 tileHeight). The byte therefore means an L-th of
 * a tile in 256ths: half a texel per unit on a 128-tall tile, a quarter on a
 * 64-tall one, and a full texel only at 256. Taking it as a raw texel count
 * is correct for exactly one tile size and wrong for every other.
 *
 * L is the height rounded UP to a power of two, not the height itself, so a
 * 300-tall tile pans in 512ths rather than 300ths.
 *
 * A y-flip negates globalzd after the panning has been folded into it, so the
 * pan reverses along with the texture; vScale already carries that sign.
 */
function panTexels(yPan, height, vScale) {
  if (!yPan) return 0;
  const l = 1 << Math.ceil(Math.log2(height));
  return yPan * l / 256 * (vScale < 0 ? -1 : 1);
}

/**
 * Pitch — and Build does not pitch. `horiz` is a SHEAR of the frame.
 *
 * drawrooms() turns it into one number and then never looks at it again:
 *
 *   globalhoriz = mulscale16(dahoriz-100,xdimenscale) + (ydimen>>1);
 *
 * Every vertical path adds that number and does nothing else with it —
 * owallmost() as `y+(globalhoriz<<16)` after the interpolation is built,
 * wallscan() as `vplce = globalzd + vince*(y1-globalhoriz+1)`, hline() as the
 * table index `yp-globalhoriz+horizycent`, grouscan() as
 * `mulscale10(1-globalhoriz,globalzd)` in the slope accumulator, drawsprite()
 * as `y1 += (globalhoriz<<8)-ysiz`. Nothing rotates. The camera basis, the
 * column of a world point and its depth are all untouched, which gives the
 * sharpest test this renderer has:
 *
 *   the texel under a fixed world point may not change when horiz moves,
 *   only the screen row it lands on.
 *
 * The unit falls out of setview():
 *
 *   setaspect(65536, divscale16(ydim*320, xdim*200));
 *   xdimenscale = scale(xdimen,yxaspect,320);
 *
 * so for a full-window view xdimenscale/65536 = ydim/200: one horiz unit is
 * one row of a 200-row frame, whatever the resolution and whatever the field
 * of view. 100 is level, 0 puts the horizon on the top edge, 200 on the
 * bottom. DERIVED, no knob — a shear that had to be scaled to look right
 * would be a finding about the projection, not a setting.
 *
 * Duke clamps p->horiz to -99..299 (player.c), which is where the range comes
 * from; the engine itself does not care.
 */
/**
 * Vertical focal length, in pixels per world unit at unit depth. DERIVED.
 *
 * Build does NOT project the two axes alike, and uDuke used to. A column comes
 * from scansector(),
 *
 *   screenSpaceCoo[VEC_COL] = halfxdimen + scale(xp1,halfxdimen,yp1);
 *
 * which with yp = depth*256 is `halfxdimen + halfxdimen*lateral/depth`, so the
 * horizontal focal is xdim/2 — 90 degrees across at viewingrange 65536. A row
 * comes from owallmost(),
 *
 *   z <<= 7;
 *   y = (scale(z,xdimenscale,iy1)<<4);
 *   ... qinterpolatedown16short(..., y+(globalhoriz<<16), yinc);
 *
 * with the same iy1 = depth*256 and xdimenscale = 65536*ydim/200, which comes
 * out at 8*z/depth 16.16 rows, z in Build z units. Sixteen of those to the
 * world unit leaves
 *
 *   Fv = 128 * ydim/200 = 0.64 * ydim,
 *
 * against Fh = 0.5 * xdim. At 320x200 that is 128 against 160: Build shows a
 * vertical field of 76 degrees where the horizontal one is 90, and uDuke was
 * drawing every wall, flat, slope and sprite 25 % too tall.
 *
 * Confirmed twice more from paths that share nothing with owallmost: the face
 * sprite's ysiz (`mulscale14(siz, yrepeat*height)` against a world height of
 * `(height*yrepeat)<<2` z units) and the general form Fv = 0.64*ydim at any
 * resolution.
 *
 * Note this is NOT the pixel aspect ratio of the display: the page shows
 * Duke's pixels 1:1.2 as the original did (a 320x200 frame at 4:3, or a
 * widened frame at the same pixel shape), so the two stay comparable.
 */
const VERT_FOCAL = 128, VERT_FOCAL_ROWS = 200;

// Build's default viewingrange, as a field of view. Present so the zoom below
// can be written as a ratio of tangents against it: at the default the two
// tangents are the same expression and cancel EXACTLY, where dividing by
// tan(45 degrees) leaves 0.9999999999999999 and puts a third of an ulp into
// every focal length. That is invisible until a texel lands precisely on a
// boundary, and then it is a whole texel — one assertion caught it.
const REF_FOV = 90;

/**
 * Face sprites are narrower than everything else, by exactly a fifth.
 *
 * Their CENTRE is projected like a wall — `spritesx[i] = scale(xp+yp,
 * xdimen<<7, yp)` is `halfxdimen + halfxdimen*lateral/depth` — but their WIDTH
 * comes from
 *
 *   siz  = divscale19(xdimenscale,yp);
 *   xv   = mulscale16(((int32_t)tspr->xrepeat)<<16,xyaspect);
 *   xsiz = mulscale30(siz,xv * spriteDim.width);
 *
 * and xdimenscale*xyaspect collapses to 2^32*xdim/320, leaving 0.4*xdim per
 * world unit against the wall's 0.5. The ratio is 4/5 at every resolution and
 * every viewingrange, because both carry the same 1/yp.
 *
 * So a face sprite that is square in the world is square in the FRAMEBUFFER,
 * which on a 4:3-stretched 320x200 makes it a fifth taller than wide. That is
 * Build's behaviour and the art was drawn against it, so it is reproduced
 * rather than corrected.
 */
const SPRITE_FOCAL_RATIO = 0.8;

const HORIZ_LEVEL = 100;
const BUILD_REF_HEIGHT = 200;
export const HORIZ_MIN = -99, HORIZ_MAX = 299;

/** The screen row the horizon sits on, as a float. */
export function horizonRow(horiz, height, refHeight = height) {
  // drawrooms: globalhoriz = mulscale16(horiz-100, xdimenscale) + (ydimen>>1)
  // — the unit comes from the FULL screen height (xdimenscale ∝ ydim), the
  // centre from the viewport (ydimen). Equal unless a status bar shortens
  // the view (premap.c vscrn).
  return height / 2 + (horiz - HORIZ_LEVEL) * refHeight / BUILD_REF_HEIGHT;
}

const SKY_BITS = 3;                       // pskybits, constant across Duke3D
const SKY_SEGMENTS = 1 << SKY_BITS;

// `off` is pskyoff, `yScale` is parallaxyscale/65536 — both from
// setupbackdrop() in premap.c, and both are game data rather than anything the
// GRP or the MAP knows.
//
// parascan() shears the sky by its own, smaller amount:
//
//   globalhorizbak = globalhoriz;
//   if (parallaxyscale != 65536)
//       globalhoriz = mulscale16(globalhoriz-(ydimen>>1),parallaxyscale) + (ydimen>>1);
//
// restoring it on the way out, so it applies to the panorama alone. The
// default is a half: newgame() clears parallaxyscale and setupbackdrop() opens
// with `if (parallaxyscale != 65536) parallaxyscale = 32768;` before the switch
// gets a chance to override it. Looking up therefore moves the sky half as far
// as the world, which is what keeps a panorama anchored on the horizon from
// running off the top of the frame.
//
// Duke's own quirk, deliberately not reproduced: that guard means a level with
// CLOUDYOCEAN leaves parallaxyscale at 65536 for every later level in the same
// session, since only 65536 fails the test. It is sticky across a level change
// and only newgame() clears it. uDuke shows one map at a time, so each sky gets
// the value a freshly started level would give it.
const SKY_TABLE = new Map([
  [78, { off: [0, 0, 0, 0, 0, 0, 0, 0], yScale: 1 }],           // CLOUDYOCEAN, 65536
  [80, { off: [0, 2, 3, 0, 2, 0, 1, 0], yScale: 1 / 2 }],       // MOONSKY1
  [84, { off: [0, 0, 4, 0, 0, 1, 2, 3], yScale: 1 / 2 }],       // BIGORBIT1
  [89, { off: [1, 2, 1, 3, 4, 0, 2, 3], yScale: 17408 / 65536 }], // LA, 16384+1024
]);
const SKY_DEFAULT = { off: [0, 0, 0, 0, 0, 0, 0, 0], yScale: 1 / 2 };

// The engine-wide visibility scalar. Duke copies ud.const_visibility into the
// engine every frame; the released sources declare that field but never
// assign it, so the value has to come from initengine(), which sets
// visibility = 512. parallaxvisibility gets the same.
const BUILD_VISIBILITY = 512;

// Shade levels gained per Build unit of depth, before sector visibility.
// DERIVED, not calibrated.
//
// The wall chain, all of it in engine.c:
//
//   yCam    = dmulscale6(x, cosviewingrangeglobalang, y, sinviewingrangeglobalang)
//   swall   = mulscale19(yCam, xdimscale)                          prepwall()
//   davis   = mulscale16(swall, globvis)                           wallscan()
//   shade  += davis >> 8                                           getpalookup()
//
// with globvis = globalvisibility = mulscale16(visibility,
// mulscale16(xdimenscale, viewingrangerecip)) from drawrooms().
//
// The step that hid this for a session is the first line: sintable has
// amplitude 2^14 and dmulscale6 shifts back only 6, so camera-space Y is the
// depth times 256 — never the depth itself. The same 256 is why the near
// clip reads `< 256`, i.e. one Build unit. Feed that in and the screen terms
// cancel exactly:
//
//   xdimscale * xdimen * yxaspect / 320 = xyaspect * yxaspect = 2^32
//
// leaving depth * visibility / 2^19, independent of resolution, aspect and
// viewing range. Build ties the fade to the world, not to the picture.
//
// Floors and ceilings take a completely separate route — globalcisibility,
// horizlookup2 and globalzd, none of which appear above — and reduce to the
// same thing once owallmost's `z <<= 7` is accounted for: the height above
// the plane cancels and only the depth survives. Two independent paths, one
// scalar, so this is attested rather than fitted.
//
// Overridable per render() call; see also fadeScale, the HUD multiplier.
const DEFAULT_FADE_RATE = BUILD_VISIBILITY / 2 ** 19;   // = 1/1024

/**
 * Sector visibility folded into the fade rate.
 *
 * Build does this as
 *
 *   if (sec->visibility != 0)
 *     globvis = mulscale4(globvis, (int32_t)((uint8_t)(sec->visibility + 16)));
 *
 * The cast is not decoration. visibility is a signed byte, so a mapper's -16
 * lands on 0 and kills distance shading outright — a sector that stays as
 * bright at the far wall as at the near one. One less, -17, wraps to 255 and
 * multiplies the rate by nearly sixteen instead. The cliff between those two
 * is a real feature of the original that maps were lit against.
 *
 * Reading the field unsigned, as a MAP parser naturally does, changes
 * nothing: (uint8)(v + 16) is the same residue either way. Dropping the
 * truncation changes everything.
 */
function foldVisibility(visibility) {
  if (!visibility) return 1;
  return ((visibility + 16) & 0xff) / 16;
}

// Build units per texel of a sprite, per unit of xrepeat/yrepeat.
//
// Unlike the other two scale constants this one is derived rather than dialled
// in. Build builds a floor sprite's corners with mulscale16(sintable[a], l),
// and sintable has amplitude 2^14 while mulscale16 shifts down by 2^16 — so
// the world length works out as tilesize * repeat / 4, independent of the
// angle. Overridable per render() call all the same, since the derivation
// rests on recalled source rather than on measurement.
const SPRITE_SCALE = 1 / 4;

export const ALIGN_FACE = 0, ALIGN_WALL = 1, ALIGN_FLOOR = 2;

// Sprites a Build map carries but the game never shows.
//
// Tiles 1..10 are the editor's marker sprites — sector effectors, activators,
// touchplates and so on. They exist so a mapper can see and select the logic,
// and the game strips them at spawn. Their tile numbers come from the CON
// scripts, which uDuke does not parse, but 1..10 is the convention Build games
// share and matches what the tile browser shows for Duke.
//
// APLAYER is the player and the multiplayer start points. A map holds one per
// spawn position and the game turns them into players rather than drawing
// them, so a viewer that renders the raw data ends up with a crowd of Dukes
// standing around.
const MARKER_TILE_MIN = 1, MARKER_TILE_MAX = 10;
const TILE_APLAYER = 1405;

function isHiddenSprite(picNum) {
  return (picNum >= MARKER_TILE_MIN && picNum <= MARKER_TILE_MAX) || picNum === TILE_APLAYER;
}

export const MODE_FULL = 0;
export const MODE_NO_FADE = 1;
export const MODE_FULLBRIGHT = 2;
export const MODE_SURFACE = 3;   // colour by surface kind
export const MODE_SECTOR = 4;    // colour by sector index

export const SHADE_FULL = MODE_FULL;
export const SHADE_NO_FADE = MODE_NO_FADE;
export const SHADE_FULLBRIGHT = MODE_FULLBRIGHT;

const KIND_WALL = 0, KIND_UPPER = 1, KIND_LOWER = 2, KIND_CEIL = 3, KIND_FLOOR = 4;

// Exported so diagnostics can name the surface under a pixel in MODE_SURFACE
// without keeping their own copy of the table, which would drift.
export const KIND_NAMES = ['wall', 'upper', 'lower', 'ceiling', 'floor'];

// Packed 0xAABBGGRR to match buildLut() on a little-endian machine.
export const KIND_COLOURS = new Uint32Array([
  0xffd08040, // wall        blue
  0xffd0d040, // upper step  cyan
  0xff40c040, // lower step  green
  0xff4040d0, // ceiling     red
  0xff40d0d0, // floor       yellow
]);

/**
 * Why a pixel ended up unpainted.
 *
 * Every span that declines to draw stamps its reason on the rows it skipped,
 * first writer wins. Pixels another span later covers are simply not counted,
 * so what comes out is the reason for the gaps that survived. Without this the
 * only way to attribute a gap is to guess which guard fired, and the guards
 * are spread over four drawing paths.
 *
 * DROP_NONE means no span ever considered the pixel — a traversal question,
 * not a rounding one.
 */
export const DROP_NONE = 0;
export const DROP_FLAT_HORIZON = 1;    // row on the horizon, no flat can own it
export const DROP_FLAT_BEHIND = 2;     // flat plane behind the eye — see below
export const DROP_SLOPE_PARALLEL = 3;  // ray parallel to a sloped plane
export const DROP_SLOPE_BEHIND = 4;    // sloped plane behind the eye — see below
export const DROP_NAMES = [
  'never considered', 'horizon row', 'flat behind eye',
  'ray parallel to slope', 'slope behind eye',
];

const UNPAINTED = 0xffff00ff;
const BACKGROUND = 0xff101014;

/**
 * One-time per-map precomputation.
 *
 * `facing` is each sector's winding sign. Build culls walls that face away
 * from the camera, which requires every wall to face into its own sector — so
 * within one sector, the outer loop and its holes must wind oppositely. What
 * is *not* guaranteed is which absolute direction the outer loop takes, nor
 * that the outer loop is stored first. Deriving the sign per sector from the
 * containment-identified outer loop makes the cull correct either way.
 *
 * `prevWall` inverts point2, which bunch formation needs: a visible wall
 * starts a bunch when its predecessor around the loop is not visible.
 */
export function prepareMap(map) {
  const facing = new Int8Array(map.sectors.length);
  const prevWall = new Int32Array(map.walls.length).fill(-1);
  const stats = { negativeWinding: 0, outerNotFirst: 0, holeSameWinding: 0, ambiguous: 0, sloped: 0 };

  for (let i = 0; i < map.walls.length; i++) {
    const p2 = map.walls[i].point2;
    if (p2 >= 0 && p2 < map.walls.length) prevWall[p2] = i;
  }

  for (let i = 0; i < map.sectors.length; i++) {
    const loops = sectorLoops(map, i);
    const cls = classifyLoops(map, loops);

    if (cls.ambiguous) stats.ambiguous++;
    if (loops.length > 1 && cls.outer !== loops[0]) stats.outerNotFirst++;

    const sign = Math.sign(loopSignedArea(map, cls.outer)) || 1;
    facing[i] = sign;
    if (sign < 0) stats.negativeWinding++;

    for (const hole of cls.holes) {
      if (Math.sign(loopSignedArea(map, hole)) === sign) stats.holeSameWinding++;
    }
  }

  // A load-time census only. These planes are NOT handed to the renderer, which
  // rebuilds them per frame: a plane carries the sector's z as its constant
  // term, so a stored one is a snapshot that goes wrong the first time a door
  // moves. Kept because "how many sloped sectors are in this level" is a
  // question about the file, and the file does not move.
  const planes = new Array(map.sectors.length);
  for (let i = 0; i < map.sectors.length; i++) {
    planes[i] = { ceil: slopePlane(map, i, true), floor: slopePlane(map, i, false) };
    if (planes[i].ceil.sloped || planes[i].floor.sloped) stats.sloped++;
  }

  // Sprites are stored in one flat list; the renderer wants them per sector so
  // it can walk only the sectors the flood actually reached.
  const spritesBySector = new Array(map.sectors.length);
  for (let i = 0; i < map.sprites.length; i++) {
    const n = map.sprites[i].sectNum;
    if (n < 0 || n >= map.sectors.length) continue;
    (spritesBySector[n] ??= []).push(i);
  }

  return { facing, prevWall, planes, spritesBySector, stats };
}

/**
 * One representative colour per tile, for flat-shaded surfaces.
 *
 * Averages the tile's opaque pixels in RGB, then snaps back to the nearest
 * palette index so shading still runs through the game's own shade tables.
 */
export function buildSurfaceColours(map, artSet, palette) {
  const wanted = new Set();
  for (const s of map.sectors) { wanted.add(s.floorPicNum); wanted.add(s.ceilingPicNum); }
  for (const w of map.walls) { wanted.add(w.picNum); wanted.add(w.overPicNum); }

  let max = 0;
  for (const n of wanted) if (n > max) max = n;
  const colours = new Uint8Array(max + 1).fill(96);

  for (const n of wanted) {
    const tile = artSet.get(n);
    if (!tile?.pixels) continue;

    let r = 0, g = 0, b = 0, count = 0;
    const stride = Math.max(1, Math.floor(tile.pixels.length / 4096));
    for (let i = 0; i < tile.pixels.length; i += stride) {
      const c = tile.pixels[i];
      if (c === 255) continue;
      r += palette.rgb[c * 3]; g += palette.rgb[c * 3 + 1]; b += palette.rgb[c * 3 + 2];
      count++;
    }
    if (count) colours[n] = nearestIndex(palette.rgb, r / count, g / count, b / count);
  }

  return colours;
}

/**
 * A sector's floor or ceiling as a plane, z = A*x + B*y + C.
 *
 * Build stores a slope as a heinum measured against the sector's first wall:
 * the height at a point is the sector's z plus heinum times the signed
 * perpendicular distance from that wall, over 256. That is affine in world
 * position, so it collapses into three coefficients and the renderer never
 * has to redo the wall lookup per pixel.
 *
 * Cross-checked against getZsOfSlope() in map.js, which is the same relation
 * written out per point.
 *
 * Cheap enough to call per sector per frame, and it HAS to be: the sector's z
 * is one of the three coefficients, so a cached plane is only valid until
 * something moves. That used to be never — the renderer arrived before the
 * doors did — and then it was wrong everywhere a floor or ceiling travelled.
 * See the Renderer's #plane().
 */
export function slopePlane(map, sectorIndex, ceiling) {
  const sec = map.sectors[sectorIndex];
  const z = ceiling ? sec.ceilingZ : sec.floorZ;
  const stat = ceiling ? sec.ceilingStat : sec.floorStat;
  const heinum = ceiling ? sec.ceilingHeinum : sec.floorHeinum;

  const flat = { sloped: false, A: 0, B: 0, C: z };
  if (!(stat & 2) || heinum === 0) return flat;

  const w1 = map.walls[sec.wallPtr];
  const w2 = w1 ? map.walls[w1.point2] : null;
  if (!w1 || !w2) return flat;

  const dx = w2.x - w1.x, dy = w2.y - w1.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return flat;

  const k = heinum / (256 * len);
  return {
    sloped: true,
    A: -k * dy,
    B: k * dx,
    C: z + k * (dy * w1.x - dx * w1.y),
  };
}

/** Signed side of the line a1->a2 that the point (px, py) falls on. */
function side(a1, a2, px, py) {
  return (a2.x - a1.x) * (py - a1.y) - (px - a1.x) * (a2.y - a1.y);
}

export class Renderer {
  constructor(width = 320, height = 200, fov = 90, opts = {}) {
    this.fov = fov;
    // refHeight: the screen's full height (Build's ydim) when the view is a
    // shorter viewport of it — with the status bar, 166 of 200 rows. The
    // focal length and the horiz unit belong to the screen, the centre row
    // to the viewport (setview / vscrn).
    this.refHeight = opts.refHeight ?? height;
    // tall: a viewport larger than its reference screen is allowed — the
    // tilted view (rotscrnang) renders a margin around the screen to rotate.
    this.tall = !!opts.tall;
    this.resize(width, height);
  }

  resize(width, height) {
    this.width = width;
    this.height = height;
    if (!this.refHeight || (this.refHeight < height && !this.tall)) this.refHeight = height;
    this.halfW = width / 2;
    this.halfH = height / 2;
    // viewingrange is a zoom on BOTH axes: it enters through yp, the depth
    // denominator every projection divides by. So one factor, and the ratio
    // between the axes is fixed by the resolution alone — not a knob.
    const zoom = Math.tan(REF_FOV * Math.PI / 360) / Math.tan(this.fov * Math.PI / 360);
    this.focalX = this.halfW * zoom;                                  // xdim/2
    this.focalY = this.refHeight * VERT_FOCAL / VERT_FOCAL_ROWS * zoom;   // 0.64*ydim — the screen's, not the viewport's
    this.spriteFocalX = this.focalX * SPRITE_FOCAL_RATIO;             // 0.4*xdim

    this.pixels = new Uint32Array(width * height);
    this.depth = new Float32Array(width * height);
    // Which wall drew each pixel (-1: a flat, a sprite, or nothing yet).
    // Build clips a face sprite against a wall by SIDE, not by depth —
    // spritewallfront(): the sprite's centre must lie behind the wall's
    // line for the wall to hide it. A billboard's far corner dipping behind
    // an oblique facade is not hidden in Build; a per-pixel depth test cut
    // the left half off an explosion on E1L1's street. This buffer lets
    // the sprite drawer ask the wall instead of the depth.
    this.wallOf = new Int16Array(width * height);
    this.umost = new Int16Array(width);
    this.dmost = new Int16Array(width);

    // For a horizontal surface the depth at a screen row is constant, so the
    // reciprocal can be tabulated once. That is what makes per-pixel flat
    // texturing cheap enough to skip Build's span bookkeeping: no division in
    // the inner loop, just multiplies.
    //
    // All three are measured from the HORIZON, not from the middle of the
    // frame — the two only coincide at horiz 100. Build's own tables are
    // indexed as `yp-globalhoriz+horizycent`, i.e. relative to the same row.
    this.invRow = new Float32Array(height);
    this.invRowF = new Float32Array(height);
    this.rowK = new Float32Array(height);
    this.horizon = this.halfH;
    this.tabHorizon = NaN;
    this.#retable(this.halfH);

    // Horizontal angle each column looks along, in Build's 2048-unit turn.
    // The sky depends on view direction only, so this is all it needs.
    // Unaffected by pitch: a shear moves no column.
    this.colAng = new Float32Array(width);
    for (let x = 0; x < width; x++) {
      this.colAng[x] = Math.atan((x + 0.5 - this.halfW) / this.focalX) * 1024 / Math.PI;
    }

    // How fast the sky runs past vertically, in texels per screen row.
    // DERIVED, and it belongs to the vertical axis — this used to be tied to
    // the frame WIDTH, the same mistake as the shared focal length and
    // invisible for the same reason: at 320x200 both readings are 1.
    //
    // parascan hands wallscan a constant span, swplc = mulscale16(xdimscale,
    // viewingrange), and wallscan turns it into
    //
    //   vince = swal * globalyscale,  texel = vplce >> globalshiftval
    //
    // with globalyscale = 8 << (globalshiftval-19). The tile's height cancels
    // out of that pair, leaving swal/2^16 texels per row — a 300-tall sky
    // steps exactly like a 128-tall one. Unfolding
    //
    //   xdimscale = scale(320,xyaspect,xdimen),  xyaspect = divscale32(1,yxaspect)
    //   yxaspect  = divscale16(ydim*320, xdim*200)
    //
    // collapses the whole thing to 200/ydim at the default viewingrange, and
    // the zoom divides it as it multiplies every focal length. That is exactly
    // VERT_FOCAL/focalY: the sky advances one texel per 1/128 of the vertical
    // focal length, which is also one unit of horiz. The panorama and the
    // pitch move in the same currency, as they must, since parascan reaches
    // the panorama through globalhoriz.
    this.skyStep = VERT_FOCAL / this.focalY;
  }

  /**
   * Refill the row tables for a horizon row, if it has moved.
   *
   * A frame costs one pass over `height` entries when the pitch changes and
   * nothing at all when it does not, so holding still is as cheap as it was
   * before pitch existed. Keeping the tables indexed by absolute row instead —
   * offsetting at each lookup — would put an add and a bounds question in the
   * innermost loop of every flat span, which is the one place this renderer
   * has bothered to keep free of them.
   */
  #retable(horizon) {
    if (this.tabHorizon === horizon) return;
    this.tabHorizon = horizon;
    const { height, focalY } = this;
    for (let y = 0; y < height; y++) {
      const dy = y + 0.5 - horizon;
      const inv = Math.abs(dy) < 1e-6 ? 0 : 1 / dy;
      this.invRow[y] = inv;
      // Both convert a row offset into a world quantity, so both are vertical.
      this.invRowF[y] = inv / focalY;
      this.rowK[y] = dy / focalY;
    }
  }

  /**
   * @param {object} cam {x, y, z, ang, sectNum} — z in Build z units (1/16)
   * @param {object} res {map, prep, colours, shadeLuts, numShades, mode}
   */
  /** This frame's planes, by sector index. Rebuilt every render(); see #plane. */
  #planeCache = [];

  /**
   * The sector's floor or ceiling plane, as it stands RIGHT NOW.
   *
   * prepareMap() used to hand these out, computed once when the level loaded.
   * That was correct for exactly as long as nothing in a level moved, which
   * stopped being true when the doors arrived and was not noticed because the
   * two halves of the error look like different problems: the rows a wall is
   * clipped to came from the frozen plane, while #flatDesc took the surface's
   * own height live from sec.floorZ. A moved floor was therefore drawn in the
   * old place and textured for the new one — read as a texture bug in E1L3,
   * with 590 sort errors in the frame because the depth comparison was being
   * made against a surface that was not there.
   *
   * Rebuilt per frame rather than invalidated per move: a floor can be moved by
   * doAnimations, moveEffectors or a test poking sec.floorZ directly, and a
   * cache that three callers have to remember to dirty is a cache that will be
   * stale again. One slopePlane call per visited sector per frame is nothing
   * next to the per-pixel work it feeds.
   */
  #plane(sectIdx) {
    let p = this.#planeCache[sectIdx];
    if (p === undefined) {
      p = {
        ceil: slopePlane(this.res.map, sectIdx, true),
        floor: slopePlane(this.res.map, sectIdx, false),
      };
      this.#planeCache[sectIdx] = p;
    }
    return p;
  }

  render(cam, res) {
    const { width, height } = this;
    this.mode = res.mode ?? res.shadeMode ?? MODE_FULL;
    // fadeScale is the HUD knob. Now that the rate is derived rather than
    // dialled in, the knob is a pure multiplier defaulting to 1: if it has to
    // be moved to make a scene look right, that is a finding about the
    // derivation, not a setting. fadeRate stays a separate override so tests
    // can pin a rate without depending on this default.
    this.fadeRate = (res.fadeRate ?? DEFAULT_FADE_RATE) * (res.fadeScale ?? 1);
    this.clock = res.clock ?? 0;
    this.wallV = res.wallVScale ?? V_PER_YREPEAT;

    // Pitch. Level by default, so a caller that knows nothing about horiz gets
    // exactly the frame it got before. See HORIZ_LEVEL for why this is the
    // only place the value is consulted: from here on the horizon is a row,
    // and every path adds it.
    this.horiz = cam.horiz ?? HORIZ_LEVEL;
    this.horizon = horizonRow(this.horiz, this.height, this.refHeight);
    this.#retable(this.horizon);
    // Two conventions the format alone did not settle, stated as values
    // rather than as flips — the flip form had already inverted meaning twice
    // and each inversion silently rewrote what the tests were asserting.
    //
    // 'ceiling' anchors the texture at the sector ceiling, 'floor' at its
    // floor; cstat bit 2 swaps whichever is in force. 'down' runs v the way
    // the tile is drawn, 'up' mirrors it; cstat bit 8 swaps that.
    // No wallAnchor switch: Build has no single anchor rule to switch. Each
    // wall part picks its own pair of origins, keyed on cstat bit 2 alone.

    // Masked walls anchor independently of solid ones. Tying the two together
    // was a mistake: a setting that put brickwork right on one level threw the
    // grates off on another, because they answer to different conventions.
    // Likewise for masked walls: bit clear anchors to the top of the opening.

    // What ends up under the middle of the screen. Answering "which tile am I
    // looking at" turns questions like whether a texture is upside down from
    // an argument into a lookup in the tile browser.
    //
    // `probeAt` overrides it. Reading a seam means reading the texel just
    // above and just below one edge, and the crosshair cannot be in two places
    // at once; moving the camera instead changes the very thing being
    // measured. Out of range falls back to the centre rather than silently
    // probing nothing.
    const centre = (this.halfH | 0) * width + (this.halfW | 0);
    const at = res.probeAt;
    this.probeIdx = (Number.isInteger(at) && at >= 0 && at < width * height) ? at : centre;
    this.probe = null;
    // The pending texel too, not just the report. Left standing it survives
    // into the next frame and turns a stale reading into a plausible one.
    this.pUV = null;
    this.res = res;
    this.cam = cam;
    // Planes are rebuilt for this frame on first use. They cannot be prepared
    // once and kept: a plane's constant term IS the sector's z, so a stored
    // plane is only true until a door, a drop floor or a rise bridge moves —
    // and then the rows a wall is clipped to come from the old height while
    // the flat's own height comes from the new one. See #plane().
    this.#planeCache = new Array(res.map.sectors.length);

    this.pixels.fill(this.mode >= MODE_FULLBRIGHT ? UNPAINTED : BACKGROUND);
    this.depth.fill(0);
    this.wallOf.fill(-1);
    this.curWall = -1;
    this.umost.fill(0);
    this.dmost.fill(height - 1);

    // Opt-in: one byte per pixel, cleared per frame. Off by default so the
    // interactive path pays nothing for it.
    this.trackDrops = !!res.trackDrops;
    if (this.trackDrops) {
      if (!this.drops || this.drops.length !== width * height) {
        this.drops = new Uint8Array(width * height);
        this.dropSect = new Int32Array(width * height);
      }
      this.drops.fill(DROP_NONE);
      this.dropSect.fill(-1);
    }

    const a = cam.ang * Math.PI / 1024;
    this.fx = Math.cos(a); this.fy = Math.sin(a);
    this.rx = -this.fy; this.ry = this.fx;

    const map = res.map;
    // Both dimensions have to be checked, not just the sector count. Two maps
    // can agree on sectors and differ in walls, and then the wall arrays stay
    // at the old length: writes past the end of a TypedArray are silently
    // dropped and reads come back undefined, so `wallSeen[wi] === stamp` is
    // false for every wall beyond the old bound. Nothing throws — the frame
    // just comes back with no bunches at all, which reads as a traversal
    // failure rather than as the stale buffer it is.
    if (!this.got || this.got.length !== map.sectors.length
        || this.wallSeen.length !== map.walls.length) {
      this.got = new Uint8Array(map.sectors.length);
      this.wallSeen = new Int32Array(map.walls.length);
      this.wallSlot = new Int32Array(map.walls.length);
      this.wallTaken = new Int32Array(map.walls.length);
      this.stamp = 0;
    }
    this.got.fill(0);
    this.stamp++;

    this.scanned = [];
    this.bunches = [];
    this.masked = [];
    this.stats = {
      sectors: 0, walls: 0, portals: 0,
      bunches: 0, sortErrors: 0, incomparable: 0, disjoint: 0, untextured: 0, unpainted: 0,
      sprites: 0, spritesSkipped: 0, spritesHidden: 0, spriteIds: [], markers: 0, masked: 0, maskedSkipped: 0,
      // Retained so callers written against stage 3a keep working; the
      // architecture no longer has anything to report here.
      reentered: 0, capped: 0, truncated: 0, maxDepth: 0, maxVisits: 1,
      visited: new Set(),
    };

    this.mirrorSeen = -1;
    if (cam.sectNum >= 0 && cam.sectNum < map.sectors.length) {
      this.#scan(cam.sectNum);
      // A camera standing on a portal's line: engine.c scansector takes the
      // sector across it by its own rule (#scan).
      this.#drawBunches();
      this.#drawMaskedWalls();
      this.#drawSprites();
      if (this.mirrorSeen >= 0 && !this.inMirrorPass) this.#drawMirror(this.mirrorSeen);
    }

    // Coverage, measured from the depth buffer rather than from pixel colour:
    // a zero there means nothing was ever drawn. This separates "the
    // traversal missed geometry" from "the geometry is there but shaded to
    // black", which look identical on screen and have nothing in common.
    let blank = 0;
    for (let i = 0; i < this.depth.length; i++) if (this.depth[i] === 0) blank++;
    this.stats.unpainted = blank;

    // Attribute the survivors. A reason stamped on a pixel that some later
    // span covered is not a gap and is not counted here.
    if (this.trackDrops) {
      const why = new Uint32Array(DROP_NAMES.length);
      const bySect = new Map();
      for (let i = 0; i < this.depth.length; i++) {
        if (this.depth[i] !== 0) continue;
        why[this.drops[i]]++;
        const sect = this.dropSect[i];
        if (sect >= 0) {
          const key = `${sect}:${this.drops[i]}`;
          bySect.set(key, (bySect.get(key) ?? 0) + 1);
        }
      }
      this.stats.drops = why;
      this.stats.dropsBySector = bySect;
    }

    return this.stats;
  }

  // --- scanning -------------------------------------------------------------

  /** Flood sectors once each, projecting their visible walls into bunches. */
  #scan(startSector) {
    const { map, prep } = this.res;
    const queue = [startSector];
    this.got[startSector] = 1;

    while (queue.length) {
      const sectIdx = queue.shift();
      const sec = map.sectors[sectIdx];
      const sign = prep.facing[sectIdx];
      const end = sec.wallPtr + sec.wallNum;

      this.stats.sectors++;
      this.stats.visited.add(sectIdx);

      const visible = [];
      for (let wi = sec.wallPtr; wi < end; wi++) {
        // engine.c scansector: a portal whose line passes within a hair of
        // the camera takes its sector along whatever the projection says —
        // `tempint = x1*y2-x2*y1` (twice the triangle camera/wall) below
        // 262144 in magnitude, and tempint^2>>5 no more than the wall's
        // squared length, i.e. the camera within about sqrt(32) units of the
        // line. A camera standing ON a portal (E4L10, sector 644 on the
        // diagonal into 643) sees that portal edge-on and culled, and the
        // sector behind it — which fills the view — was never scanned.
        {
          const w = map.walls[wi];
          if (w.nextSector >= 0 && (w.cstat & 32) === 0 && !this.got[w.nextSector]) {
            const p2 = map.walls[w.point2];
            const cx = Math.trunc(this.cam.x), cy = Math.trunc(this.cam.y);
            const x1 = w.x - cx, y1 = w.y - cy, x2 = p2.x - cx, y2 = p2.y - cy;
            const t = x1 * y2 - x2 * y1;
            if (t + 262144 >= 0 && t + 262144 < 524288 && Math.floor(t * t / 32) <= (x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1)) {
              this.got[w.nextSector] = 1;
              queue.push(w.nextSector);
              this.stats.nearPortals = (this.stats.nearPortals ?? 0) + 1;
            }
          }
        }
        const entry = this.#project(wi, sectIdx, sign);
        if (!entry) continue;

        this.wallSeen[wi] = this.stamp;
        this.wallSlot[wi] = this.scanned.length;
        this.scanned.push(entry);
        visible.push(wi);
        this.stats.walls++;

        if (entry.portal) {
          this.stats.portals++;
          entry.closed = this.#closedPortal(sectIdx, entry.next, wi);
          if (!this.got[entry.next] && !entry.closed) {
            this.got[entry.next] = 1;
            queue.push(entry.next);
          }
        }
      }

      this.#formBunches(sectIdx, visible);
    }
  }

  /**
   * Cull, clip and project one wall. Returns null when the wall cannot
   * contribute: facing away, entirely behind the near plane, or off screen.
   */
  /**
   * game.c displayrooms + engine.c preparemirror/completemirror: a mirror
   * is a one-way wall (cstat 32) carrying MIRROR (560) as its overpicnum,
   * with a sector behind it. The scene is drawn a second time from the
   * REFLECTED camera — the position mirrored across the wall's line, the
   * angle 2*wallangle - ang, starting in the mirror sector and looking back
   * out through the wall — and that image, flipped left to right, is what
   * the mirror shows. Here the main pass has already painted the mirror
   * wall (tagging its pixels in wallOf); the second pass renders into a
   * scratch renderer of the same size, and every tagged pixel takes the
   * scratch pixel of the mirrored column. Duke draws the player's own
   * sprite in the mirror; uDuke has no player sprite yet.
   */
  #drawMirror(wi) {
    const { map } = this.res;
    const w = map.walls[wi], w2 = map.walls[w.point2];
    const dx = w2.x - w.x, dy = w2.y - w.y;
    const jj = dx * dx + dy * dy;
    if (jj === 0 || w.nextSector < 0) return;
    const cam = this.cam;
    const ii = ((cam.x - w.x) * dx + (cam.y - w.y) * dy) * 2;
    const tx = (w.x * 2) + Math.floor(dx * ii / jj) - cam.x;
    const ty = (w.y * 2) + Math.floor(dy * ii / jj) - cam.y;
    const wallAng = Math.round(Math.atan2(dy, dx) * 1024 / Math.PI) & 2047;
    const tang = ((wallAng << 1) - cam.ang) & 2047;
    if (!this.scratch || this.scratch.width !== this.width || this.scratch.height !== this.height) {
      this.scratch = new Renderer(this.width, this.height, this.fov);
    }
    const sc = this.scratch;
    const mcam = { x: tx, y: ty, z: cam.z, ang: tang, horiz: cam.horiz, sectNum: w.nextSector };
    // The actors' view frames are chosen for the camera that looks at them:
    // for the mirror that is the reflected one (Duke calls animatesprites
    // again with tposx/tposy/tang). The page hands the call in.
    if (this.res.animateFor) this.res.animateFor(mcam);
    sc.inMirrorPass = true;
    sc.render(mcam, this.res);
    sc.inMirrorPass = false;
    if (this.res.animateFor) this.res.animateFor(cam);
    const W = this.width, H = this.height;
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        const i = row + x;
        if (this.wallOf[i] !== wi) continue;
        this.pixels[i] = sc.pixels[row + (W - 1 - x)];
      }
    }
    this.stats.mirror = { wall: wi, sector: w.nextSector, tx, ty, tang };
  }

  /**
   * A portal whose window is empty at both ends of the wall — the higher
   * ceiling at or below the lower floor — shows nothing beyond it, so the
   * neighbour is not scanned through it (a closed ceiling door, a shut lift
   * shaft). It matters for sprites: E1L1's cinema hides a secret niche
   * whose sector OVERLAPS the lobby in the map; reached through the shut
   * door it was "visited", and its goggles floated in the lobby's air. The
   * wall itself is still projected and drawn per edge as before; parallax
   * ceilings are left alone, since the sky beyond a wall is drawn by the
   * far sector.
   */
  #closedPortal(sectIdx, next, wi) {
    const { map } = this.res;
    const a = map.sectors[sectIdx], b = map.sectors[next];
    if ((a.ceilingStat & 1) || (b.ceilingStat & 1)) return false;
    const w1 = map.walls[wi], w2 = map.walls[w1.point2];
    for (const p of [w1, w2]) {
      const za = getZsOfSlope(map, sectIdx, p.x, p.y), zb = getZsOfSlope(map, next, p.x, p.y);
      const top = Math.max(za.ceilZ, zb.ceilZ), bot = Math.min(za.floorZ, zb.floorZ);
      if (top < bot) return false;
    }
    return true;
  }

  #project(wi, sectIdx, sign) {
    const { map } = this.res;
    const cam = this.cam;
    const w = map.walls[wi];
    const p2 = map.walls[w.point2];
    if (!p2) return null;

    // The camera must be on the sector side of the wall.
    if (side(w, p2, cam.x, cam.y) * sign <= 0) return null;

    // In a sector whose outer loop winds the other way, the walls run the
    // other way round too and would project right-to-left.
    let ax = w.x - cam.x, ay = w.y - cam.y;
    let bx = p2.x - cam.x, by = p2.y - cam.y;
    if (sign < 0) { const tx = ax, ty = ay; ax = bx; ay = by; bx = tx; by = ty; }

    let d1 = ax * this.fx + ay * this.fy;
    let l1 = ax * this.rx + ay * this.ry;
    let d2 = bx * this.fx + by * this.fy;
    let l2 = bx * this.rx + by * this.ry;

    // Texture parameter at each end, following the wall's own direction. The
    // swap above reverses it, and near-plane clipping moves an endpoint along
    // the wall, so both have to be tracked rather than assumed 0 and 1.
    let t1 = sign < 0 ? 1 : 0;
    let t2 = sign < 0 ? 0 : 1;

    if (d1 < NEAR && d2 < NEAR) return null;
    if (d1 < NEAR) {
      const c = (NEAR - d1) / (d2 - d1);
      l1 += (l2 - l1) * c; t1 += (t2 - t1) * c; d1 = NEAR;
    } else if (d2 < NEAR) {
      const c = (NEAR - d2) / (d1 - d2);
      l2 += (l1 - l2) * c; t2 += (t1 - t2) * c; d2 = NEAR;
    }

    const sxa = this.halfW + l1 / d1 * this.focalX;
    const sxb = this.halfW + l2 / d2 * this.focalX;
    if (sxb - sxa < 1e-6) return null;

    const x1 = Math.max(0, Math.ceil(sxa - 0.5));
    const x2 = Math.min(this.width - 1, Math.floor(sxb - 0.5));
    if (x1 > x2) return null;

    // Build enters the solid ("white wall") path on exactly two conditions:
    // no neighbour, or the one-way bit. There is no test for whether the
    // neighbour has vertical extent — a degenerate neighbour is still a
    // portal, and what shows through it is decided per edge further down.
    // uDuke used to treat a zero-height neighbour as a closed door, which
    // painted picnum 0 over every sky opening in the level.
    let portal = null, next = -1;
    if (w.nextSector >= 0 && (w.cstat & 32) === 0) {
      portal = map.sectors[w.nextSector];
      next = w.nextSector;
    } else if (w.nextSector >= 0 && (w.cstat & 32) && w.overPicNum === 560 && !this.inMirrorPass) {
      // A mirror in view: the nearest one (game.c takes the nearest by
      // Manhattan distance) gets the second pass after this one.
      const d = Math.abs(w.x - this.cam.x) + Math.abs(w.y - this.cam.y);
      if (this.mirrorSeen < 0 || d < this.mirrorDist) { this.mirrorSeen = wi; this.mirrorDist = d; }
    }

    const entry = {
      wall: wi, sect: sectIdx, d1, d2, sxa, sxb, x1, x2, portal, next,
      tOverZ1: t1 / d1, tOverZ2: t2 / d2,
    };
    // A masked wall hangs a transparent texture in the portal opening, so it
    // has to wait until the geometry behind it exists — it goes in with the
    // sprites rather than into a bunch. Build's test is (cstat&48)==16: the
    // one-way bit wins over the mask bit rather than combining with it.
    if (w.nextSector >= 0 && (w.cstat & 48) === 16) this.masked.push(entry);
    return entry;
  }

  /**
   * Group a sector's visible walls into bunches: maximal runs joined by
   * point2. A run starts where the predecessor around the loop is invisible.
   */
  #formBunches(sectIdx, visible) {
    const { prep } = this.res;

    for (const wi of visible) {
      const prev = prep.prevWall[wi];
      if (prev >= 0 && this.wallSeen[prev] === this.stamp) continue;
      this.#collectBunch(sectIdx, wi);
    }
    // A loop entirely on screen has no invisible predecessor to start from.
    for (const wi of visible) {
      if (this.wallTaken[wi] !== this.stamp) this.#collectBunch(sectIdx, wi);
    }
  }

  #collectBunch(sectIdx, first) {
    const { map } = this.res;
    if (this.wallTaken[first] === this.stamp) return;
    if (this.bunches.length >= BUNCH_BUDGET) return;

    const walls = [];
    let x1 = Infinity, x2 = -Infinity;
    let wi = first;

    while (wi >= 0 && this.wallSeen[wi] === this.stamp && this.wallTaken[wi] !== this.stamp) {
      this.wallTaken[wi] = this.stamp;
      const entry = this.scanned[this.wallSlot[wi]];
      walls.push(entry);
      if (entry.x1 < x1) x1 = entry.x1;
      if (entry.x2 > x2) x2 = entry.x2;
      wi = map.walls[wi].point2;
    }

    if (walls.length) {
      this.bunches.push({ sect: sectIdx, walls, x1, x2 });
      this.stats.bunches++;
    }
  }

  // --- ordering -------------------------------------------------------------

  /**
   * Is wall `a` in front of wall `b`, seen from the camera?
   *
   * If b lies wholly on one side of a's line, then a is in front exactly when
   * the camera is on the other side — otherwise b sits between the camera and
   * a. If b straddles a's line, the same test is applied the other way round.
   * Walls that straddle each other would have to cross in plan view, which
   * Build geometry does not do.
   *
   * @returns {boolean|null} null when the two cannot be ordered
   */
  #wallInFront(ea, eb) {
    const W = this.res.map.walls;
    const cam = this.cam;
    const a1 = W[ea.wall], a2 = W[a1.point2];
    const b1 = W[eb.wall], b2 = W[b1.point2];

    let t1 = side(a1, a2, b1.x, b1.y);
    let t2 = side(a1, a2, b2.x, b2.y);
    if (t1 === 0) t1 = t2;
    if (t2 === 0) t2 = t1;
    if (t1 !== 0 && (t1 > 0) === (t2 > 0)) {
      const tc = side(a1, a2, cam.x, cam.y);
      if (tc === 0) return null;
      return (tc > 0) !== (t1 > 0);
    }

    let s1 = side(b1, b2, a1.x, a1.y);
    let s2 = side(b1, b2, a2.x, a2.y);
    if (s1 === 0) s1 = s2;
    if (s2 === 0) s2 = s1;
    if (s1 !== 0 && (s1 > 0) === (s2 > 0)) {
      const sc = side(b1, b2, cam.x, cam.y);
      if (sc === 0) return null;
      return (sc > 0) === (s1 > 0);
    }

    return null;
  }

  /**
   * Order two bunches by the first wall pair that overlaps on screen.
   *
   * Two outcomes share the return value null and must not share a counter.
   * Bunches that do not overlap on screen need no ordering at all — Build's
   * bunchfront() returns -1 for exactly this and it is the common case, one
   * per pair of bunches looking in different directions. Bunches that DO
   * overlap and still yield no decision are the ones worth knowing about,
   * because an undetermined order is what comes back later as a sort error.
   */
  #bunchInFront(a, b) {
    if (a.x1 > b.x2 || b.x1 > a.x2) { this.stats.disjoint++; return null; }
    for (const ea of a.walls) {
      for (const eb of b.walls) {
        if (ea.x1 > eb.x2 || eb.x1 > ea.x2) continue;
        const r = this.#wallInFront(ea, eb);
        if (r !== null) return r;
      }
    }
    this.stats.incomparable++;
    return null;
  }

  // --- drawing --------------------------------------------------------------

  #drawBunches() {
    const pending = this.bunches;
    while (pending.length) {
      const closest = closestBunch(pending.length,
        (i, j) => this.#bunchInFront(pending[i], pending[j]));

      const bunch = pending[closest];
      pending[closest] = pending[pending.length - 1];
      pending.pop();

      for (const entry of bunch.walls) this.#drawWall(entry);
    }
  }

  #drawWall(entry) {
    const { map, textures } = this.res;
    const { horizon, focalY, cam, umost, dmost, width, depth: zbuf } = this;
    this.curWall = entry.wall;

    const sec = map.sectors[entry.sect];
    const w = map.walls[entry.wall];
    const portal = entry.portal;

    const invZ1 = 1 / entry.d1, invZ2 = 1 / entry.d2;

    // Floor and ceiling heights along the wall. A slope is affine in world
    // position and the wall is a straight line, so z is linear in the wall
    // parameter t — the same t the texture already uses, so a sloped edge
    // costs two multiplies per column and no special case.
    const p2w = map.walls[w.point2];
    const zLine = (plane) => ({
      z0: plane.A * w.x + plane.B * w.y + plane.C,
      zs: plane.A * (p2w.x - w.x) + plane.B * (p2w.y - w.y),
    });
    const planes = this.#plane(entry.sect);
    const lc = zLine(planes.ceil);
    const lf = zLine(planes.floor);
    const nplanes = entry.next >= 0 ? this.#plane(entry.next) : null;
    const lnc = nplanes ? zLine(nplanes.ceil) : null;
    const lnf = nplanes ? zLine(nplanes.floor) : null;

    const span = entry.sxb - entry.sxa;
    const ceilFlat = this.#flatDesc(entry.sect, sec, true);
    const floorFlat = this.#flatDesc(entry.sect, sec, false);

    // Bit 1 sends the lower step to the neighbour's wall for its texture, so
    // a step reads as part of the room it steps down into.
    const swapLower = (w.cstat & 2) !== 0 && w.nextWall >= 0;
    const lowerWall = swapLower ? map.walls[w.nextWall] : w;

    const xflip = (w.cstat & 8) !== 0;
    const vUp = (w.cstat & 0x100) !== 0;
    const vScale = w.yRepeat * this.wallV * (vUp ? -1 : 1);
    const uSpan = w.xRepeat * U_PER_XREPEAT;

    const flat = !textures || this.mode === MODE_SURFACE || this.mode === MODE_SECTOR;
    // engine.c 2516: a one-way wall WITH a neighbour is textured with its
    // overpicnum (a mirror, and MIRRORBROKE once it is shot), a true one-
    // sided wall with its picnum.
    const oneWayOver = w.nextSector >= 0 && (w.cstat & 32) !== 0;
    const mainTile = flat ? null : this.#tile(oneWayOver ? w.overPicNum : w.picNum);
    const lowerTile = flat ? null : this.#tile(lowerWall.picNum);

    // Build's vertical origin, one row of the table per wall part. Bit 2 of
    // cstat is the only input; there is deliberately no global override,
    // because no single choice can satisfy all three rows at once:
    //
    //   part    bit clear            bit set
    //   solid   sec.ceilingz         sec.floorz
    //   upper   nextsec.ceilingz     sec.ceilingz
    //   lower   nextsec.floorz       sec.ceilingz
    //
    // Note the lower step: its default origin is its OWN top edge, the
    // neighbour's floor, not the sector floor. Reaching up to the sector
    // ceiling is what the bit buys, and that is the quirk which lets a step
    // continue the texture of the wall above it.
    const alignBottom = (w.cstat & 4) !== 0;

    const nsec = entry.next >= 0 ? map.sectors[entry.next] : null;

    // Every origin below is a raw sector field — ceilingz, floorz — read once
    // for the whole wall. Build never runs them through getzsofslope, and it
    // must not: an origin taken from the sloped edge is a different height in
    // every column, so the texture re-anchors as it goes and its courses tilt
    // to follow the slope instead of staying level. The clip edges are
    // geometry and do follow the slope; the origin is not.
    const oSolid = alignBottom ? sec.floorZ : sec.ceilingZ;
    const oUpper = alignBottom ? sec.ceilingZ : (nsec ? nsec.ceilingZ : sec.ceilingZ);
    const oLower = alignBottom ? sec.ceilingZ : (nsec ? nsec.floorZ : sec.floorZ);

    // When both sides parallax the same plane there is no step to draw: the
    // sky is continuous across the opening, so Build skips the surface and,
    // with it, the clipping. That skipped clip is what lets the view flood on
    // through and reach the sky rather than stopping at this wall.
    const skipUpper = !!nsec && (sec.ceilingStat & 1) !== 0 && (nsec.ceilingStat & 1) !== 0;
    const skipLower = !!nsec && (sec.floorStat & 1) !== 0 && (nsec.floorStat & 1) !== 0;

    for (let x = entry.x1; x <= entry.x2; x++) {
      const top = umost[x], bot = dmost[x];
      if (top > bot) continue;

      const f = (x + 0.5 - entry.sxa) / span;
      const invZ = invZ1 + (invZ2 - invZ1) * f;
      const dist = 1 / invZ;

      // Perspective-correct parameter along the wall: 1/z and t/z are both
      // linear in screen x, so their ratio recovers t.
      const t = (entry.tOverZ1 + (entry.tOverZ2 - entry.tOverZ1) * f) / invZ;

      // The x-flip belongs to the texture only. Build mirrors lwall, which is
      // the texture parameter, and never touches the parameter the geometry
      // runs on — so a flipped wall in a sloped sector keeps its edges.
      // Folding the flip into t before evaluating the slope planes reads the
      // ceiling and floor at the wrong end of the wall, which bends every
      // flipped wall that happens to sit on a slope.
      const uRaw = Math.floor(t * uSpan);
      const uOff = xflip ? uSpan - 1 - uRaw : uRaw;

      const zCeil = lc.z0 + lc.zs * t;
      const zFloor = lf.z0 + lf.zs * t;
      const yCeil = horizon + (zCeil - cam.z) / 16 * focalY * invZ;
      const yFloor = horizon + (zFloor - cam.z) / 16 * focalY * invZ;
      const rowCeil = clamp(Math.round(yCeil), top, bot + 1);
      const rowFloor = clamp(Math.round(yFloor), top - 1, bot);

      // Flats carry their slope in the probe too: a surface that looks too
      // steep is a question about heinum and the reference wall, and neither
      // is visible in a picture.
      // The gradient settles whether two neighbouring panels slope together
      // or against each other. heinum alone cannot: its sign is relative to
      // each sector's own first wall, so equal heinums on oppositely aimed
      // reference walls tilt in opposite directions.
      this.#mark('ceiling', entry.sect, sec.ceilingPicNum, sec.ceilingShade, {
        stat: sec.ceilingStat, heinum: sec.ceilingHeinum,
        across: ceilFlat.align ? ceilFlat.align.across : null,
        flatZ: sec.ceilingZ, slopeZ: Math.round(zCeil), refWall: sec.wallPtr,
        gradX: planes.ceil.A, gradY: planes.ceil.B,
        // Raw bytes, not the folded texel counts in the descriptor: the fold
        // is what is under test whenever a seam is being chased, so the probe
        // has to report the datum and let the HUD show the conversion.
        xPan: sec.ceilingXPanning, yPan: sec.ceilingYPanning,
        tileW: ceilFlat.tile ? ceilFlat.tile.width : 0,
        tileH: ceilFlat.tile ? ceilFlat.tile.height : 0,
      });
      this.#flatSpan(x, top, rowCeil - 1, ceilFlat);
      this.#mark('floor', entry.sect, sec.floorPicNum, sec.floorShade, {
        stat: sec.floorStat, heinum: sec.floorHeinum,
        across: floorFlat.align ? floorFlat.align.across : null,
        flatZ: sec.floorZ, slopeZ: Math.round(zFloor), refWall: sec.wallPtr,
        gradX: planes.floor.A, gradY: planes.floor.B,
        xPan: sec.floorXPanning, yPan: sec.floorYPanning,
        tileW: floorFlat.tile ? floorFlat.tile.width : 0,
        tileH: floorFlat.tile ? floorFlat.tile.height : 0,
      });
      this.#flatSpan(x, rowFloor + 1, bot, floorFlat);

      const shade = this.shade(w.shade, dist, sec.visibility);
      const detail = (tile, anchor) => ({
        wall: entry.wall, cstat: w.cstat,
        yPan: w.yPanning, yRep: w.yRepeat, xPan: w.xPanning, xRep: w.xRepeat,
        tileH: tile ? tile.height : null, tileW: tile ? tile.width : null,
        anchor,
      });

      if (!portal) {
        this.#mark('wall', entry.sect, w.picNum, w.shade,
          detail(mainTile, alignBottom ? 'floor' : 'ceiling'));
        this.#surface(x, rowCeil, rowFloor, mainTile, uOff, w.xPanning, w.yPanning,
          zCeil, zFloor, yCeil, yFloor, oSolid, vScale,
          KIND_WALL, entry.sect, w.picNum, shade, invZ, w.pal);
        // Build closes the whole column after a white wall (umost 1, dmost
        // 0): its ceiling and floor spans were painted just before and the
        // wall fills the rest. That holds only while the spans actually
        // painted every row — a plane the eye is on the wrong side of, or a
        // flat's rows beyond the horizon, or a slope (relative to a dragged
        // hinge wall) that turns away halfway down the column, paint
        // nothing there (florscan's "UNDER the floor: do NOT render"), and
        // closing those rows leaves them to nobody: Build's hall of mirrors.
        // E1L5: the quake drags sector 114 and squashes the goggle niche 323
        // until its back walls sort in front of the portal; seen from far
        // below or, with the jetpack, from above, the niche's planes cover
        // nothing of the column and its off-screen white wall blanked what
        // the portal's steps should have painted. So the closure is read
        // off the z-buffer: the rows above the wall are done only if all of
        // them were painted, likewise the rows below. The wall's own rows
        // are z-buffer-guarded regardless. One pass over the column, for
        // white walls only.
        let topDone = true, botDone = true;
        for (let y = rowCeil - 1; y >= top; y--) if (zbuf[y * width + x] === 0) { topDone = false; break; }
        for (let y = rowFloor + 1; y <= bot; y++) if (zbuf[y * width + x] === 0) { botDone = false; break; }
        if (topDone && botDone) { umost[x] = 1; dmost[x] = 0; }
        else if (topDone) umost[x] = Math.max(top, rowFloor + 1);
        else if (botDone) dmost[x] = Math.min(bot, rowCeil - 1);
        continue;
      }

      const zNCeil = lnc.z0 + lnc.zs * t;
      const zNFloor = lnf.z0 + lnf.zs * t;
      const yNCeil = horizon + (zNCeil - cam.z) / 16 * focalY * invZ;
      const yNFloor = horizon + (zNFloor - cam.z) / 16 * focalY * invZ;
      const rowNCeil = clamp(Math.round(yNCeil), top, bot + 1);
      const rowNFloor = clamp(Math.round(yNFloor), top - 1, bot);

      // Through a closed portal nothing is scanned, so the window row the
      // neighbour used to paint — where the upper step's last row and the
      // lower step's first meet — is the upper step's too.
      const upperEnd = entry.closed && !skipLower ? Math.max(rowNCeil - 1, rowNFloor) : rowNCeil - 1;
      if (!skipUpper) {
        this.#mark('upper', entry.sect, w.picNum, w.shade,
          detail(mainTile, alignBottom ? 'ceiling' : 'nextCeil'));
        this.#surface(x, rowCeil, upperEnd, mainTile, uOff, w.xPanning, w.yPanning,
          zCeil, zNCeil, yCeil, yNCeil, oUpper, vScale,
          KIND_UPPER, entry.sect, w.picNum, shade, invZ, w.pal);
      }
      // A lower step shares its bottom edge with the sector floor, so under
      // floor anchoring it continues the solid wall beside it for free. Under
      // ceiling anchoring the same continuity is what Build's quirk buys by
      // reaching all the way up to the sector ceiling for the origin.
      if (!skipLower) {
        this.#mark('lower', entry.sect, lowerWall.picNum, w.shade,
          { ...detail(lowerTile, alignBottom ? 'ceiling' : 'nextFloor'), swapped: swapLower });
        this.#surface(x, rowNFloor + 1, rowFloor, lowerTile, uOff, w.xPanning, w.yPanning,
          zNFloor, zFloor, yNFloor, yFloor, oLower, vScale,
          KIND_LOWER, entry.sect, lowerWall.picNum, shade, invZ, lowerWall.pal);
      }

      if (!skipUpper) umost[x] = Math.max(top, upperEnd + 1);
      if (!skipLower) dmost[x] = Math.min(bot, rowNFloor);
    }
  }

  /**
   * One vertical run of a wall surface: textured when a tile is available,
   * otherwise the flat average colour of stage 3.
   *
   * topZ/botZ are the world heights of the run's ends and yTop/yBot their
   * unrounded screen rows, so the texture stays put when the run is clipped.
   */
  #surface(x, y0, y1, tile, uOff, xPan, yPan, topZ, botZ, yTop, yBot,
           // pal last, so every existing call keeps its shape and a caller that
           // has not been taught about palettes draws in pal 0 as before.
           originZ, vScale, kind, sectIdx, picNum, shade, invZ, pal = 0) {
    if (y1 < y0) return;

    if (!tile) {
      // Distinguish "textures are switched off" from "this wall's tile is not
      // in the ART set". The second is worth counting: it is the difference
      // between a deliberate flat render and a surface that silently lost its
      // texture.
      if (this.res.textures && this.mode !== MODE_SURFACE && this.mode !== MODE_SECTOR) {
        this.stats.untextured++;
      }
      const base = this.res.colours[picNum] ?? 96;
      this.#column(x, y0, y1, this.#pick(kind, sectIdx, base, shade), invZ);
      return;
    }

    // A wall of no screen height still owns its rows.
    //
    // y0..y1 has already been established as non-empty, and the ceiling and
    // floor spans beside it are cut to start after it — so whoever is handed
    // these rows has to fill them or nobody will. Returning here left a
    // one-row gap with the sector's own ceiling above and floor below, which
    // is what E1L1 shows wherever a closed door is in view: a door sector has
    // floorz == ceilingz, so its walls are exactly this case.
    //
    // The untextured path above never had the problem, because #column takes
    // the rows as given. That asymmetry is why the flat and textured modes
    // disagreed on coverage by precisely this count.
    //
    // vStep is a limit, not a division: with no height the wall shows one row
    // of texels, so the step is zero and the start is the top edge itself.
    const dy = yBot - yTop;
    const degenerate = Math.abs(dy) < 1e-6;

    const pan = panTexels(yPan, tile.height, vScale);
    const u = mod(xPan + uOff, tile.width);
    const vTop = (topZ - originZ) * vScale + pan;
    const vStep = degenerate ? 0 : ((botZ - originZ) * vScale + pan - vTop) / dy;

    // y0 has already been clamped to the column's clip window by the caller,
    // so the texture start is measured from the unrounded screen row of the
    // surface's top edge — that is what keeps it still under clipping.
    const vStart = degenerate ? vTop : vTop + (y0 + 0.5 - yTop) * vStep;

    // Which band of the tile this surface actually shows. A wall shorter than
    // one repeat displays a slice and never the rest, so "the tile looks
    // wrong" is usually a question about which slice — and that is not
    // readable from panning and repeat without doing the arithmetic. Added to
    // the probe detail here, after #mark has run and before #hit can fire.
    {
      const vBot = (botZ - originZ) * vScale + pan;
      this.pDetail = { ...(this.pDetail ?? {}), vTop, vBot };
    }

    this.#texColumn(x, y0, y1, tile, u, vStart, vStep, shade, invZ, pal);
  }

  #texColumn(x, y0, y1, tile, u, v, vStep, shade, invZ, pal = 0) {
    const { width, pixels, depth: zbuf, height } = this;
    const shadeLuts = this.#luts(pal);
    const h = tile.height;
    const col = u * h;
    const lut = shade * 256;

    if (y1 > height - 1) y1 = height - 1;

    for (let y = y0; y <= y1; y++, v += vStep) {
      const i = y * width + x;
      if (zbuf[i] !== 0) {
        if (invZ > zbuf[i]) this.stats.sortErrors++;
        else continue;
      }
      let iv = v % h;
      if (iv < 0) iv += h;
      zbuf[i] = invZ;
      this.wallOf[i] = this.curWall;
      pixels[i] = shadeLuts[lut + tile.pixels[col + (iv | 0)]];
      this.#uvAt(i, u, iv | 0);
      this.#hit(i);
    }
  }

  // --- masked walls -----------------------------------------------------------

  #drawMaskedWalls() {
    if (!this.res.textures) return;
    for (const entry of this.masked) this.#drawMaskedWall(entry);
  }

  /**
   * The transparent texture a portal can carry: fences, grates, window bars.
   *
   * It fills the opening — between the lower of the two ceilings and the
   * higher of the two floors — and is drawn against the depth buffer after
   * the walls, so whatever shows through it is already there.
   */
  /**
   * Build's translucency, in RGB. The engine looks the pair up in the
   * 256x256 `transluc` table of PALETTE.DAT: TRANS_NORMAL is
   * transluc[(old<<8)|new], TRANS_REVERSE transluc[(new<<8)|old]. Measured
   * over Duke's table (a least-squares fit across 20000 pairs), the entry is
   * 0.313*old + 0.665*new with an 8.5/255 residual that is the palette's
   * quantisation — a third of what was there and two thirds of what is
   * drawn. So: normal keeps a third of the background, reverse two thirds.
   * The frame buffer holds RGBA, not indices, which is why it is done here
   * rather than through the table; the weights are the table's.
   */
  static blend(old, colour, reverse) {
    const wo = reverse ? 2 : 1, wn = 3 - wo;
    const r = ((old & 255) * wo + (colour & 255) * wn) / 3;
    const g = (((old >>> 8) & 255) * wo + ((colour >>> 8) & 255) * wn) / 3;
    const b = (((old >>> 16) & 255) * wo + ((colour >>> 16) & 255) * wn) / 3;
    return ((colour & 0xff000000) | (b << 16) | (g << 8) | r) >>> 0;
  }

  /** spritewallfront(), engine.c: the sprite's centre on the wall's front side. */
  #spriteInFrontOfWall(spr, w) {
    const { map } = this.res;
    const wa = map.walls[w], wb = map.walls[wa.point2];
    return (wb.x - wa.x) * (spr.y - wa.y) - (spr.x - wa.x) * (wb.y - wa.y) >= 0;
  }

  #drawMaskedWall(entry) {
    const { map } = this.res;
    this.curWall = entry.wall;
    const trans = (map.walls[entry.wall].cstat & 128) !== 0, transRev = (map.walls[entry.wall].cstat & 512) !== 0;
    const { horizon, focalY, cam, width, height, pixels, depth: zbuf } = this;

    const w = map.walls[entry.wall];
    const tile = this.#tile(w.overPicNum);
    if (!tile) { this.stats.maskedSkipped++; return; }

    const p2w = map.walls[w.point2];
    const zLine = (plane) => ({
      z0: plane.A * w.x + plane.B * w.y + plane.C,
      zs: plane.A * (p2w.x - w.x) + plane.B * (p2w.y - w.y),
    });
    const here = this.#plane(entry.sect), there = this.#plane(entry.next);
    const lc = zLine(here.ceil), lf = zLine(here.floor);
    const lnc = zLine(there.ceil), lnf = zLine(there.floor);

    const invZ1 = 1 / entry.d1, invZ2 = 1 / entry.d2;
    const span = entry.sxb - entry.sxa;
    const uSpan = w.xRepeat * U_PER_XREPEAT;
    const xflip = (w.cstat & 8) !== 0;
    const vUp = (w.cstat & 0x100) !== 0;
    const vScale = w.yRepeat * this.wallV * (vUp ? -1 : 1);
    // Masked walls hang from the bottom of the opening by default, the
    // opposite of a solid wall. A fence floating above the floor is the sign
    // that this is the wrong way round.
    const alignTop = (w.cstat & 4) === 0;
    const th = tile.height, tw = tile.width;
    const maskPan = panTexels(w.yPanning, th, vScale);
    // A grate or a force field carries its own pal like any other surface.
    const maskedLuts = this.#luts(w.pal);

    // The origin is fixed for the whole wall, and Build takes it from the flat
    // sector heights rather than the sloped planes:
    //
    //   z1 = max(nsec->ceilingz, sec->ceilingz)
    //   z2 = min(nsec->floorz,   sec->floorz)
    //
    // both computed once, outside any per-column work. Anchoring to the
    // sloped opening instead re-anchors the texture in every column, which
    // shears a grate across a tilted opening — the pattern slides along the
    // slope instead of hanging straight.
    const nearSec = map.sectors[entry.sect], farSec = map.sectors[entry.next];
    const originZ = alignTop
      ? Math.max(nearSec.ceilingZ, farSec.ceilingZ)
      : Math.min(nearSec.floorZ, farSec.floorZ);
    this.#mark('masked', entry.sect, w.overPicNum, w.shade, {
      wall: entry.wall, cstat: w.cstat,
      yPan: w.yPanning, yRep: w.yRepeat, xPan: w.xPanning, xRep: w.xRepeat,
      tileH: th, tileW: tw, anchor: alignTop ? 'top' : 'bottom',
    });
    let drawn = false;

    for (let x = entry.x1; x <= entry.x2; x++) {
      const f = (x + 0.5 - entry.sxa) / span;
      const invZ = invZ1 + (invZ2 - invZ1) * f;
      const dist = 1 / invZ;
      const t = (entry.tOverZ1 + (entry.tOverZ2 - entry.tOverZ1) * f) / invZ;
      const uRaw = Math.floor(t * uSpan);          // see #drawWall: geometry
      const uOff = xflip ? uSpan - 1 - uRaw : uRaw; // keeps the unflipped t

      // z grows downwards, so the opening's top is the larger of the two
      // ceiling heights and its floor the smaller of the two floors.
      const zTop = Math.max(lc.z0 + lc.zs * t, lnc.z0 + lnc.zs * t);
      const zBot = Math.min(lf.z0 + lf.zs * t, lnf.z0 + lnf.zs * t);
      if (zBot <= zTop) continue;

      const yTop = horizon + (zTop - cam.z) / 16 * focalY * invZ;
      const yBot = horizon + (zBot - cam.z) / 16 * focalY * invZ;
      if (yBot - yTop < 1e-6) continue;

      const vTop = (zTop - originZ) * vScale + maskPan;
      const vStep = ((zBot - originZ) * vScale + maskPan - vTop) / (yBot - yTop);
      const col = mod(w.xPanning + uOff, tw) * th;
      const shade = this.shade(w.shade, dist, map.sectors[entry.sect].visibility) * 256;

      const ya = Math.max(0, Math.ceil(yTop - 0.5));
      const yb = Math.min(height - 1, Math.floor(yBot - 0.5));
      let v = vTop + (ya + 0.5 - yTop) * vStep;

      for (let y = ya; y <= yb; y++, v += vStep) {
        const i = y * width + x;
        if (invZ < zbuf[i] * (1 - SPRITE_DEPTH_TIE)) continue;
        let iv = v % th;
        if (iv < 0) iv += th;
        const texel = tile.pixels[col + (iv | 0)];
        if (texel === 255) continue;
        zbuf[i] = invZ;
        this.wallOf[i] = this.curWall;
        // Wall cstat 128: translucent (512 reverses it).
        pixels[i] = trans ? Renderer.blend(pixels[i], maskedLuts[shade + texel], transRev) : maskedLuts[shade + texel];
        this.#hit(i);
        drawn = true;
      }
    }
    if (drawn) this.stats.masked++;
  }

  // --- sprites --------------------------------------------------------------

  /**
   * Sprites go in after the walls, tested against the depth buffer rather
   * than woven into the bunch order. With binary transparency — palette index
   * 255 and nothing in between — a depth test is order-independent, so no
   * sorting is needed and sprites occlude and are occluded correctly.
   */
  #drawSprites() {
    const { map, textures } = this.res;
    if (!textures) return;

    // The per-sector index is rebuilt every frame from the live list, not
    // taken from prep. prep's copy was built once at load, and a sprite that
    // walks into another sector stayed filed under the one it was born in:
    // drawn when THAT sector was in view, missing when its real one was, and a
    // sprite made after load — every projectile — was in no list at all. The
    // trooper brightened (it had fired) and no laser ever appeared.
    const bySector = this.#indexSprites(map);
    for (const sectIdx of this.stats.visited) {
      const list = bySector[sectIdx];
      if (!list || list.length === 0) continue;
      for (const si of list) {
        const spr = map.sprites[si];

        // Build's own visibility test, from scansector():
        //
        //   if ((((spr->cstat&0x8000) == 0) || (showinvisibility)) &&
        //       (spr->xrepeat > 0) && (spr->yrepeat > 0) && ...
        //
        // The repeats are as much a part of it as the invisible bit. A sprite
        // scaled to zero is one of the ways a map hides something it still
        // wants to keep — the editor shows it, the game never does — so a
        // viewer that only honours cstat draws objects the original does not.
        // The player's own sprite shows in a mirror, and wherever Duke's
        // animatesprites lets it through: display_mirror (a monitor's
        // picture, xyzmirror) or newowner > -1 (the player watching a
        // camera) — the page sets res.showPlayer for those.
        const ownShown = (this.inMirrorPass || this.res.showPlayer) && si === this.res.playerSprite;
        if ((spr.cstat & 0x8000) && !ownShown) continue;   // marked invisible
        if (spr.xRepeat <= 0 || spr.yRepeat <= 0) { this.stats.spritesHidden++; continue; }
        // An APLAYER with no owner and no stat 10 is the holoduke's hologram
        // (actors.c 1264: owner -1) — drawn like any sprite.
        if (isHiddenSprite(spr.picNum) && !ownShown && !(spr.picNum === TILE_APLAYER && spr.owner === -1 && si === this.res.holoduke)) {
          this.stats.markers++;
          if (!this.res.showMarkers) continue;
        }
        const sec = map.sectors[sectIdx];
        // animatesprites' tsprite changes for this frame (spr.tspr), laid
        // over the sprite: a dead camera's monitor as STATIC, larger, flipped.
        const view = spr.tspr ? { ...spr, ...spr.tspr } : spr;
        // The index travels with the record so the probe can name it. A tile
        // number alone does not identify a sprite — the same tile appears
        // dozens of times in a map — and without the index there is no way to
        // go from something odd on screen to the record that produced it.
        // The alignment is cstat's bits 4..5, read here rather than from
        // the `align` field readMap derives at load: a sprite made at run
        // time — a bullet hole, a trip bomb, a laser line — is given its
        // cstat AFTER makeSprite, and a stale `align` of 0 drew every one of
        // them as a 3x3 face sprite on the wall's own plane, hidden in it.
        const align = (view.cstat >> 4) & 3;
        // game.c 5966: the shadow, drawn first so the actor's own picture
        // wins where they meet. Only while the eye is above its floor.
        if (align === ALIGN_FACE && spr.shadowZ !== undefined && this.res.shadows !== false && this.cam.z < spr.shadowZ && (spr.yRepeat >> 3) > 0) {
          this.#drawFaceSprite({ ...spr, z: spr.shadowZ, yRepeat: spr.yRepeat >> 3, shade: 127, dispShade: 127, pal: 4, dispPal: 4, cstat: spr.cstat | 2 }, sec, -1);
          this.stats.shadows = (this.stats.shadows ?? 0) + 1;
        }
        if (align === ALIGN_FACE) this.#drawFaceSprite(view, sec, si);
        else if (align === ALIGN_WALL) this.#drawWallSprite(view, sec, si);
        else if (align === ALIGN_FLOOR) this.#drawFloorSprite(view, sec, si);
        else this.stats.spritesSkipped++;
      }
    }
  }

  /**
   * A face sprite is a billboard square to the view, so every point on it
   * shares one depth and the texture runs linearly in screen space.
   */
  /**
   * Live sprites by their CURRENT sector, for this frame. ~1000 sprites.
   *
   * The per-sector arrays are kept between frames and emptied, not
   * reallocated. It was first written against a rise in frame time; the rise
   * was the scene: the live index draws every sprite
   * where it now IS, and a level with 65 monsters awake has more of them in
   * view than one where they were filed under the sector they were born in.
   * The reuse stays because it costs nothing; the claim does not.
   */
  #spriteIndex = null;
  #indexSprites(map) {
    let by = this.#spriteIndex;
    if (!by || by.length !== map.sectors.length) {
      by = this.#spriteIndex = new Array(map.sectors.length);
      for (let n = 0; n < by.length; n++) by[n] = [];
    } else {
      for (let n = 0; n < by.length; n++) by[n].length = 0;
    }
    for (let i = 0; i < map.sprites.length; i++) {
      const spr = map.sprites[i];
      if (spr.removed) continue;
      const n = spr.sectNum;
      if (n < 0 || n >= by.length) continue;
      by[n].push(i);
    }
    return by;
  }

  #drawFaceSprite(spr, sec, spriteIdx = -1) {
    const trans = (spr.cstat & 2) !== 0, transRev = (spr.cstat & 512) !== 0;
    const { halfW, horizon, focalX, focalY, cam, width, height, pixels, depth: zbuf } = this;

    const dx = spr.x - cam.x, dy = spr.y - cam.y;
    const d = dx * this.fx + dy * this.fy;
    const dbg = spriteIdx === this.debugSprite ? (this.stats.spriteWhy = { idx: spriteIdx, stage: 'start', d, sect: spr.sectNum, px: 0, depthFlat: 0, depthWall: 0, transparent: 0 }) : null;
    if (d < NEAR) { if (dbg) dbg.stage = 'too near'; return; }

    // animatesprites' pick, when the CON has one; the map's tile otherwise.
    const tile = this.#tile(spr.dispPicNum ?? spr.picNum);
    if (!tile) { if (dbg) dbg.stage = 'no tile ' + spr.picNum; this.stats.spritesSkipped++; return; }

    const scale = this.res.spriteScale ?? SPRITE_SCALE;
    const worldW = tile.width * spr.xRepeat * scale;
    const worldH = tile.height * spr.yRepeat * scale;
    if (worldW <= 0 || worldH <= 0) { if (dbg) dbg.stage = 'zero size'; return; }

    // The tile's own centring offsets from picanm, plus the sprite's.
    const anim = tile.anim ?? { xOffset: 0, yOffset: 0 };
    const xoff = (anim.xOffset + spr.xOffset) * spr.xRepeat * scale;
    const yoff = (anim.yOffset + spr.yOffset) * spr.yRepeat * scale;

    const invZ = 1 / d;
    const l = dx * this.rx + dy * this.ry;
    // The centre is projected like a wall, the half-width is not: Build takes
    // the column from spritesx[] (halfxdimen*lateral/depth, so focalX) and the
    // extent from xsiz (0.4*xdim, so spriteFocalX). The tile's own centring
    // offset belongs to the extent, since Build applies it as
    // `i = mulscale30(siz,xv*xoff)` off the already-projected column.
    const cx = halfW + l * invZ * focalX - xoff * invZ * this.spriteFocalX;
    const halfW2 = worldW / 2 * invZ * this.spriteFocalX;
    const sxa = cx - halfW2, sxb = cx + halfW2;

    // z is the sprite's foot unless bit 7 asks for true centring.
    let botZ = spr.z - yoff * 16;
    if (spr.cstat & 0x80) botZ += worldH * 16 / 2;
    const topZ = botZ - worldH * 16;
    const yBot = horizon + (botZ - cam.z) / 16 * focalY * invZ;
    const yTop = horizon + (topZ - cam.z) / 16 * focalY * invZ;
    if (yBot - yTop < 1e-6 || sxb - sxa < 1e-6) { if (dbg) dbg.stage = 'degenerate'; return; }

    const x1 = Math.max(0, Math.ceil(sxa - 0.5));
    const x2 = Math.min(width - 1, Math.floor(sxb - 0.5));
    if (x1 > x2) { if (dbg) dbg.stage = 'off screen x'; return; }
    if (dbg) {
      dbg.stage = 'columns'; dbg.x1 = x1; dbg.x2 = x2; dbg.yTop = Math.round(yTop); dbg.yBot = Math.round(yBot);
      dbg.cam = `${cam.x},${cam.y},${cam.z} a${cam.ang & 2047}`;
      // What already sits in the sprite's box: the walls by pixel count and the depth range.
      const hist = new Map(); let dmin = 1e9, dmax = 0;
      const ya = Math.max(0, Math.round(yTop)), yb = Math.min(height - 1, Math.round(yBot));
      for (let yy = ya; yy <= yb; yy += 2) for (let xx = x1; xx <= x2; xx += 2) { const k = yy * width + xx; const w = this.wallOf[k]; hist.set(w, (hist.get(w) || 0) + 1); const dd = zbuf[k] > 0 ? 1 / zbuf[k] : 1e9; if (dd < dmin) dmin = dd; if (dd > dmax && dd < 1e8) dmax = dd; }
      dbg.there = [...hist].sort((p, q) => q[1] - p[1]).slice(0, 4).map(([w, n]) => `${w}:${n}`).join(',') + ` depth ${Math.round(dmin)}..${Math.round(dmax)} vs ${Math.round(d)}`;
    }

    // The rotation frame's mirror is set on Duke's DRAWING copy, overriding
    // the sprite's own bit; null means the viewtype had no opinion.
    const xflip = spr.dispFlip ?? ((spr.cstat & 4) !== 0);
    const yflip = (spr.cstat & 8) !== 0;
    const shade = this.shade(spr.dispShade ?? spr.shade, d, sec.visibility);
    this.#markSprite(spr, spriteIdx, 'face');
    const lut = shade * 256;
    const th = tile.height, tw = tile.width;
    const spriteLuts = this.#luts(spr.dispPal ?? spr.pal);
    const vScale = th / (yBot - yTop);

    let drawn = false;
    for (let x = x1; x <= x2; x++) {
      let uf = (x + 0.5 - sxa) / (sxb - sxa);
      if (xflip) uf = 1 - uf;
      const u = clamp(Math.floor(uf * tw), 0, tw - 1);
      const col = u * th;

      const y1 = Math.max(0, Math.ceil(yTop - 0.5));
      const y2 = Math.min(height - 1, Math.floor(yBot - 0.5));
      for (let y = y1; y <= y2; y++) {
        const i = y * width + x;
        if (invZ < zbuf[i] * (1 - SPRITE_DEPTH_TIE)) {           // something nearer
          // A nearer WALL hides the billboard only when its centre lies
          // behind that wall's line (spritewallfront); a nearer flat or
          // sprite hides it outright.
          const w = this.wallOf[i];
          if (w < 0 || !this.#spriteInFrontOfWall(spr, w)) { if (dbg) { if (w < 0) dbg.depthFlat++; else { dbg.depthWall++; dbg.lastWall = w; } } continue; }
        }
        let v = (y + 0.5 - yTop) * vScale;
        if (yflip) v = th - v;
        const texel = tile.pixels[col + clamp(Math.floor(v), 0, th - 1)];
        if (texel === 255) { if (dbg) dbg.transparent++; continue; }             // transparent
        zbuf[i] = invZ;
        this.wallOf[i] = -1;
        if (dbg) dbg.px++;
        pixels[i] = trans ? Renderer.blend(pixels[i], spriteLuts[lut + texel], transRev) : spriteLuts[lut + texel];
        this.#hit(i);
        drawn = true;
      }
    }
    // Recorded only when something actually landed on screen, alongside the
    // counter it belongs to. Listing every candidate instead put four indices
    // next to "sprites 2", which reads as a contradiction and sends the
    // reader after sprites that were never drawn.
    if (drawn) { this.stats.sprites++; this.stats.spriteIds.push(spriteIdx); }
  }

  /** Common geometry: world size, texel offsets and vertical extent. */
  #spriteMetrics(spr, tile) {
    const scale = this.res.spriteScale ?? SPRITE_SCALE;
    const anim = tile.anim ?? { xOffset: 0, yOffset: 0 };
    const worldW = tile.width * spr.xRepeat * scale;
    const worldH = tile.height * spr.yRepeat * scale;
    let xoff = (anim.xOffset + spr.xOffset) * spr.xRepeat * scale;
    let yoff = (anim.yOffset + spr.yOffset) * spr.yRepeat * scale;
    if (spr.cstat & 4) xoff = -xoff;
    if (spr.cstat & 8) yoff = -yoff;

    let botZ = spr.z - yoff * 16;
    if (spr.cstat & 0x80) botZ += worldH * 16 / 2;
    return { worldW, worldH, xoff, yoff, botZ, topZ: botZ - worldH * 16 };
  }

  /**
   * A wall-aligned sprite is a vertical quad at a fixed angle — geometrically
   * a free-standing wall, so it projects the same way and gets the same
   * perspective-correct parameter along its length.
   *
   * Unlike a real wall it is two-sided unless cstat bit 6 says otherwise, so
   * seeing it from behind reverses it rather than culling it.
   */
  #drawWallSprite(spr, sec, spriteIdx = -1) {
    const trans = (spr.cstat & 2) !== 0, transRev = (spr.cstat & 512) !== 0;
    this.#markSprite(spr, spriteIdx, 'wall');
    const { halfW, horizon, focalX, focalY, cam, width, height, pixels, depth: zbuf } = this;

    // animatesprites' pick, when the CON has one; the map's tile otherwise.
    const tile = this.#tile(spr.dispPicNum ?? spr.picNum);
    if (!tile) { this.stats.spritesSkipped++; return; }
    const m = this.#spriteMetrics(spr, tile);
    if (m.worldW <= 0 || m.worldH <= 0) return;

    const a = spr.ang * Math.PI / 1024;
    const sn = Math.sin(a), cs = Math.cos(a);

    // Build lays a wall sprite's width along (sin ang, sin(ang + 1536)), and
    // 1536 of 2048 is three quarters of a turn, so the second term is -cos.
    // The check that settles the handedness: viewed from the facing side the
    // camera's own right vector is exactly (sin ang, -cos ang), so u has to
    // run that way or the texture comes out mirrored.
    const ux = sn, uy = -cs;

    if (spr.cstat & 0x40) {                        // one-sided
      if ((cam.x - spr.x) * cs + (cam.y - spr.y) * sn <= 0) return;
    }

    const ox = spr.x - ux * m.xoff, oy = spr.y - uy * m.xoff;
    let ax = ox - ux * m.worldW / 2 - cam.x, ay = oy - uy * m.worldW / 2 - cam.y;
    let bx = ox + ux * m.worldW / 2 - cam.x, by = oy + uy * m.worldW / 2 - cam.y;

    let d1 = ax * this.fx + ay * this.fy, l1 = ax * this.rx + ay * this.ry;
    let d2 = bx * this.fx + by * this.fy, l2 = bx * this.rx + by * this.ry;
    let t1 = 0, t2 = 1;
    if (d1 < NEAR && d2 < NEAR) return;
    if (d1 < NEAR) { const c = (NEAR - d1) / (d2 - d1); l1 += (l2 - l1) * c; t1 += (t2 - t1) * c; d1 = NEAR; }
    else if (d2 < NEAR) { const c = (NEAR - d2) / (d1 - d2); l2 += (l1 - l2) * c; t2 += (t1 - t2) * c; d2 = NEAR; }

    let sxa = halfW + l1 / d1 * focalX, sxb = halfW + l2 / d2 * focalX;
    let iz1 = 1 / d1, iz2 = 1 / d2;
    if (sxb < sxa) {                               // seen from the back
      [sxa, sxb] = [sxb, sxa]; [iz1, iz2] = [iz2, iz1]; [t1, t2] = [t2, t1];
    }
    if (sxb - sxa < 1e-6) return;

    const x1 = Math.max(0, Math.ceil(sxa - 0.5));
    const x2 = Math.min(width - 1, Math.floor(sxb - 0.5));
    if (x1 > x2) return;

    const tOverZ1 = t1 * iz1, tOverZ2 = t2 * iz2;
    const xflip = spr.dispFlip ?? ((spr.cstat & 4) !== 0), yflip = (spr.cstat & 8) !== 0;
    const kTop = (m.topZ - cam.z) / 16 * focalY, kBot = (m.botZ - cam.z) / 16 * focalY;
    const th = tile.height, tw = tile.width;
    const lutBase = 256;
    const spriteLuts = this.#luts(spr.dispPal ?? spr.pal);
    let drawn = false;

    for (let x = x1; x <= x2; x++) {
      const f = (x + 0.5 - sxa) / (sxb - sxa);
      const invZ = iz1 + (iz2 - iz1) * f;
      let t = (tOverZ1 + (tOverZ2 - tOverZ1) * f) / invZ;
      if (xflip) t = 1 - t;
      const u = clamp(Math.floor(t * tw), 0, tw - 1) * th;

      const yTop = horizon + kTop * invZ, yBot = horizon + kBot * invZ;
      if (yBot - yTop < 1e-6) continue;
      const vScale = th / (yBot - yTop);
      const shade = this.shade(spr.dispShade ?? spr.shade, 1 / invZ, sec.visibility) * lutBase;

      const ya = Math.max(0, Math.ceil(yTop - 0.5));
      const yb = Math.min(height - 1, Math.floor(yBot - 0.5));
      for (let y = ya; y <= yb; y++) {
        const i = y * width + x;
        if (invZ < zbuf[i] * (1 - SPRITE_DEPTH_TIE)) {
          // As for a face sprite: a nearer WALL hides a wall sprite only
          // when the sprite's centre lies behind that wall's line — Build
          // decides wall-against-sprite by side (spritewallfront), not per
          // pixel. E2L1's SECURITY poster (#109, tile 499) hangs eight
          // units in front of its own back wall 1523, slightly skewed; by
          // depth the wall won the poster's left half.
          const w = this.wallOf[i];
          if (w < 0 || !this.#spriteInFrontOfWall(spr, w)) continue;
        }
        let v = (y + 0.5 - yTop) * vScale;
        if (yflip) v = th - v;
        const texel = tile.pixels[u + clamp(Math.floor(v), 0, th - 1)];
        if (texel === 255) continue;
        zbuf[i] = invZ;
        this.wallOf[i] = -1;
        pixels[i] = trans ? Renderer.blend(pixels[i], spriteLuts[shade + texel], transRev) : spriteLuts[shade + texel];
        this.#hit(i);
        drawn = true;
      }
    }
    // Recorded only when something actually landed on screen, alongside the
    // counter it belongs to. Listing every candidate instead put four indices
    // next to "sprites 2", which reads as a contradiction and sends the
    // reader after sprites that were never drawn.
    if (drawn) { this.stats.sprites++; this.stats.spriteIds.push(spriteIdx); }
  }

  /**
   * A floor-aligned sprite is a rectangle lying in a horizontal plane, so it
   * is drawn like a flat: the ray meets the plane, and the world point is
   * then carried back into the sprite's own frame to test the bounds and pick
   * the texel.
   */
  #drawFloorSprite(spr, sec, spriteIdx = -1) {
    const trans = (spr.cstat & 2) !== 0, transRev = (spr.cstat & 512) !== 0;
    this.#markSprite(spr, spriteIdx, 'floor');
    const { halfW, horizon, focalX, focalY, cam, width, height, pixels, depth: zbuf, invRow, invRowF } = this;

    // animatesprites' pick, when the CON has one; the map's tile otherwise.
    const tile = this.#tile(spr.dispPicNum ?? spr.picNum);
    if (!tile) { this.stats.spritesSkipped++; return; }
    const m = this.#spriteMetrics(spr, tile);
    if (m.worldW <= 0 || m.worldH <= 0) return;

    // One-sided floor sprites face up unless the y-flip bit turns them over.
    if (spr.cstat & 0x40) {
      if ((cam.z > spr.z) === ((spr.cstat & 8) === 0)) return;
    }

    const a = spr.ang * Math.PI / 1024;
    const sn = Math.sin(a), cs = Math.cos(a);
    // Floor sprites take the opposite sense from wall sprites in Build's own
    // corner construction. Unverified against real art: a floor decal with
    // legible text or a directional arrow would settle it.
    const ux = -sn, uy = cs;      // tile x runs this way
    const vx = -cs, vy = -sn;     // tile y runs this way

    // Corner the local frame is measured from, offsets folded in.
    const cx = spr.x + sn * (m.worldW / 2 + m.xoff) + cs * (m.worldH / 2 + m.yoff);
    const cy = spr.y + sn * (m.worldH / 2 + m.yoff) - cs * (m.worldW / 2 + m.xoff);

    const k = (spr.z - cam.z) / 16 * focalY;
    if (k === 0) return;

    // Screen bounds from the four corners; anything crossing the near plane
    // falls back to the whole frame rather than producing a bogus box.
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, safe = true;
    for (const [su, sv] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const wx = cx + ux * m.worldW * su + vx * m.worldH * sv;
      const wy = cy + uy * m.worldW * su + vy * m.worldH * sv;
      const dx = wx - cam.x, dy = wy - cam.y;
      const d = dx * this.fx + dy * this.fy;
      if (d < NEAR) { safe = false; break; }
      const iz = 1 / d;
      const px2 = halfW + (dx * this.rx + dy * this.ry) * iz * focalX;
      const py2 = horizon + (spr.z - cam.z) / 16 * focalY * iz;
      if (px2 < minX) minX = px2; if (px2 > maxX) maxX = px2;
      if (py2 < minY) minY = py2; if (py2 > maxY) maxY = py2;
    }
    const x1 = safe ? Math.max(0, Math.floor(minX)) : 0;
    const x2 = safe ? Math.min(width - 1, Math.ceil(maxX)) : width - 1;
    const y1 = safe ? Math.max(0, Math.floor(minY)) : 0;
    const y2 = safe ? Math.min(height - 1, Math.ceil(maxY)) : height - 1;
    if (x1 > x2 || y1 > y2) return;

    const th = tile.height, tw = tile.width;
    const spriteLuts = this.#luts(spr.dispPal ?? spr.pal);
    let drawn = false;

    for (let x = x1; x <= x2; x++) {
      const lat = x + 0.5 - halfW;
      for (let y = y1; y <= y2; y++) {
        const inv = invRow[y];
        if (inv === 0) continue;
        const dist = k * inv;
        if (dist <= 0) continue;
        const invZ = 1 / dist;
        const i = y * width + x;
        if (invZ < zbuf[i] * (1 - SPRITE_DEPTH_TIE)) continue;

        const off = lat * k * invRowF[y];
        const relx = cam.x + this.fx * dist + this.rx * off - cx;
        const rely = cam.y + this.fy * dist + this.ry * off - cy;

        const tu = relx * ux + rely * uy;
        if (tu < 0 || tu >= m.worldW) continue;
        const tv = relx * vx + rely * vy;
        if (tv < 0 || tv >= m.worldH) continue;

        const texel = tile.pixels[
          clamp(Math.floor(tu / m.worldW * tw), 0, tw - 1) * th +
          clamp(Math.floor(tv / m.worldH * th), 0, th - 1)];
        if (texel === 255) continue;
        zbuf[i] = invZ;
        {
          const c = spriteLuts[this.shade(spr.dispShade ?? spr.shade, dist, sec.visibility) * 256 + texel];
          pixels[i] = trans ? Renderer.blend(pixels[i], c, transRev) : c;
        }
        this.#hit(i);
        drawn = true;
      }
    }
    // Recorded only when something actually landed on screen, alongside the
    // counter it belongs to. Listing every candidate instead put four indices
    // next to "sprites 2", which reads as a contradiction and sends the
    // reader after sprites that were never drawn.
    if (drawn) { this.stats.sprites++; this.stats.spriteIds.push(spriteIdx); }
  }

  /**
   * Resolve a tile through its animation. picanm lives on the base tile, so
   * the frame offset is worked out there and then applied to the number.
   */
  #tile(picNum) {
    const base = tileOf(this.res.art, picNum);
    if (!base) return null;
    const off = animOffset(base.anim, this.clock);
    return off === 0 ? base : (tileOf(this.res.art, picNum + off) ?? base);
  }

  /**
   * The shade table for a surface's palette.
   *
   * `pal` selects one of LOOKUP.DAT's alternate palettes, and until now the
   * renderer ignored the field entirely: every coloured wall, sector and sprite
   * in every level was drawn in pal 0. Falls back to the base table for pal 0
   * and for any pal the file does not define, which is what Build does by
   * leaving palookup[pal] pointing at nothing usable.
   */
  #luts(pal) {
    if (!pal) return this.res.shadeLuts;
    return this.res.palLuts?.get(pal) ?? this.res.shadeLuts;
  }

  #pick(kind, sectIdx, base, shade) {
    if (this.mode === MODE_SURFACE) return KIND_COLOURS[kind];
    if (this.mode === MODE_SECTOR) return sectorColour(sectIdx);
    return this.res.shadeLuts[shade * 256 + base];
  }

  /**
   * Distance shading.
   *
   * Build's formula, not an approximation of it:
   *
   *   shade = globalshade + ((swall * globvis) >> 24)
   *
   * with the whole fixed-point chain collapsed into DEFAULT_FADE_RATE — see
   * there for the derivation and for why the screen geometry drops out.
   *
   * `dist` must be depth along the view axis, which is what camera-space Y is
   * in Build and what both call sites here already pass. Euclidean distance
   * would darken the edges of the frame in a way the original does not.
   */
  shade(baseShade, dist, visibility) {
    if (this.mode >= MODE_FULLBRIGHT) return 0;
    if (this.mode === MODE_NO_FADE) return clamp(Math.round(baseShade), 0, this.res.numShades - 1);
    const fade = dist * this.fadeRate * foldVisibility(visibility);
    // getpalookup adds the distance term as (davis>>8) — an integer shift,
    // so it truncates. Rounding instead biases every surface by half a shade,
    // uniformly across the frame, which reads as the whole scene sitting one
    // step too bright or too dark. The base shade is already an integer from
    // the map, so flooring the sum is the same operation Build performs.
    return clamp(Math.floor(baseShade + fade), 0, this.res.numShades - 1);
  }

  /**
   * Remember what a surface is, for the pixel under the crosshair.
   *
   * `detail` carries whatever the surface kind can say about its own texture
   * mapping — panning, repeat, tile height. Those are the numbers that decide
   * whether a misplaced texture is a mirror, an anchor, or a panning unit, and
   * reading them off the wall beats inferring them from the picture.
   */
  #mark(kind, sect, pic, shade, detail) {
    this.pKind = kind; this.pSect = sect; this.pPic = pic; this.pShade = shade;
    this.pDetail = detail ?? null;
  }

  /**
   * Stamp a reason on one pixel index, with the sector whose span declined it.
   *
   * The sector is the part that turns a category into a lead: "a floor span
   * was dropped" is a symptom, "sector 94's floor span was dropped over the
   * lower half of the frame" is something you can go and look at.
   */
  #dropAt(i, reason, sect = -1) {
    if (!this.trackDrops || this.drops[i] !== DROP_NONE) return;
    this.drops[i] = reason;
    this.dropSect[i] = sect;
  }

  /**
   * Record a sprite as the surface under the crosshair.
   *
   * All three alignments, not just face sprites. Only the face path used to
   * do this, so a crosshair on a wall-aligned or floor-aligned sprite kept
   * whatever surface was marked last — normally the wall behind it — and the
   * probe confidently named the wrong thing. A probe that is silently stale
   * is worse than one that says nothing.
   *
   * The index matters as much as the tile: one tile appears dozens of times
   * in a map, and only the index leads back to the record. Pair it with
   * `spriteprobe <GRP> <MAP> tile:N` or `near:x,y`.
   */
  #markSprite(spr, spriteIdx, align) {
    this.#mark('sprite', spr.sectNum, spr.picNum, spr.shade, {
      sprite: spriteIdx,
      align,
      cstat: spr.cstat,
      xRep: spr.xRepeat, yRep: spr.yRepeat,
      spriteAng: spr.ang,
    });
  }

  /**
   * The texel a path is about to write, when it is the probe pixel.
   *
   * "Do the courses line up where a wall meets a sloped ceiling" is a
   * question about texture coordinates, and comparing two surfaces by eye at
   * a seam is exactly the kind of judgement that has been wrong before here.
   * Reading u and v off both sides turns it into two numbers.
   */
  #uvAt(i, u, v) {
    if (i === this.probeIdx) this.pUV = { u, v };
  }

  #hit(i) {
    if (i !== this.probeIdx) return;
    // Depth as well as identity. Two surfaces at the same screen position can
    // only be told apart by how far away they are, and "is this sprite in
    // front of that wall or behind it" is not answerable from a tile number.
    // Read from the buffer, which every path has just written, so it is the
    // depth actually used for the test rather than a recomputation.
    const inv = this.depth[i];
    this.probe = {
      kind: this.pKind, sect: this.pSect, pic: this.pPic, shade: this.pShade,
      dist: inv ? 1 / inv : null,
      ...(this.pDetail ?? {}),
      ...(this.pUV ?? {}),
    };
    this.pUV = null;
  }

  #column(x, y0, y1, colour, invZ) {
    const { width, pixels, depth: zbuf } = this;
    if (y0 < 0) y0 = 0;
    if (y1 > this.height - 1) y1 = this.height - 1;
    for (let y = y0; y <= y1; y++) {
      const i = y * width + x;
      // Bunches are drawn front to back, so a pixel that already has depth
      // should win. Anything arriving nearer than what is there means the
      // ordering was wrong — counted rather than hidden.
      if (zbuf[i] !== 0) {
        if (invZ > zbuf[i]) this.stats.sortErrors++;
        else continue;
      }
      zbuf[i] = invZ;
      this.wallOf[i] = this.curWall;
      pixels[i] = colour;
      this.#hit(i);
    }
  }

  /**
   * Everything about one flat that does not vary along a column, worked out
   * once per wall rather than once per pixel.
   */
  #flatDesc(sectIdx, sec, ceiling) {
    const { map, colours, textures } = this.res;
    const stat = ceiling ? sec.ceilingStat : sec.floorStat;
    const picNum = ceiling ? sec.ceilingPicNum : sec.floorPicNum;
    const flat = !textures || this.mode === MODE_SURFACE || this.mode === MODE_SECTOR;

    const desc = {
      sect: sectIdx,
      kind: ceiling ? KIND_CEIL : KIND_FLOOR,
      k: ((ceiling ? sec.ceilingZ : sec.floorZ) - this.cam.z) / 16 * this.focalY,
      plane: this.#plane(sectIdx)[ceiling ? 'ceil' : 'floor'],
      base: colours[picNum] ?? 96,
      shade: ceiling ? sec.ceilingShade : sec.floorShade,
      // A sector's two planes carry separate pals, and SE 4 flips them every
      // time a light flashes — so this is read per frame like the shade is,
      // not baked when the level loads.
      pal: ceiling ? sec.ceilingPal : sec.floorPal,
      visibility: sec.visibility,
      parallax: (stat & 1) !== 0,
      tile: flat ? null : this.#tile(picNum),
      swapXY: (stat & 4) !== 0,
      xflip: (stat & 16) !== 0,
      yflip: (stat & 32) !== 0,
      xPan: ceiling ? sec.ceilingXPanning : sec.floorXPanning,
      yPan: ceiling ? sec.ceilingYPanning : sec.floorYPanning,
      align: null,
    };

    // Bit 3 doubles the rate, halving the texel; bit 6 turns the texture with
    // the sector's first wall instead of leaving it on the world axes.
    //
    // One rate for both axes. Build derives each from its own dimension, but
    // the dimension cancels against the fetch shift on each axis separately,
    // so a non-square tile is not a special case: u and v both run at a
    // sixteenth of a texel per unit.
    const rate = FLAT_TEXELS_PER_UNIT * ((stat & 8) ? 2 : 1) * (this.res.flatScale ?? 1);
    desc.uScale = rate;
    desc.vScale = rate;
    desc.scale = rate;   // kept for the flat-colour paths

    // Panning is a byte covering exactly one repetition, not a texel count —
    // the same shape as the wall case, and for the same reason. ceilscan
    // shifts the accumulated origin by globalxshift and only then adds
    //
    //   globalxpanning += (((int32_t)sec->ceilingxpanning)<<24);
    //
    // while hlineasm4 takes the texel from the top log2(width) bits of that
    // 32-bit accumulator. So one unit is 2^(log2 w - 8) = width/256 texels,
    // and a full 256 walks the tile once whatever its resolution. grouscan
    // and slopevlin land on the same figure, so slopes share it.
    //
    // Bit 3 does not reach this: the sector's byte is added after the shift,
    // so halving the texel size does not halve the pan.
    if (desc.tile) {
      desc.xPan = desc.xPan * desc.tile.width / 256;
      desc.yPan = desc.yPan * desc.tile.height / 256;
    }

    if ((stat & 64) && desc.tile) {
      const w1 = map.walls[sec.wallPtr];
      const w2 = w1 ? map.walls[w1.point2] : null;
      if (w1 && w2) {
        const dx = w2.x - w1.x, dy = w2.y - w1.y;
        const len = Math.hypot(dx, dy);
        if (len > 0) {
          // Across the reference wall the texture is stretched by the slope's
          // secant. grouscan():
          //
          //   i = nsqrtasm(daslope*daslope + 16777216);   // 4096^2
          //   globaly = mulscale12(dmulscale16(-y,dx,x,dy), i);
          //
          // mulscale12 divides by 4096, so the factor is
          // sqrt(heinum^2 + 4096^2)/4096 — exactly sec of the tilt. It keeps
          // the texels square ON the sloped surface rather than in its
          // ground-plan projection, which is what makes a sloped ceiling
          // continue the courses of the wall it meets.
          //
          // Without it the flat runs slow by that factor and the seam drifts:
          // at heinum 4096 the tilt is 45 degrees and the error is sqrt(2),
          // which is what put E1L5's ceiling rivets out of step with the
          // wall's. Flat surfaces have heinum 0 and a factor of 1, so this
          // costs them nothing.
          const heinum = ceiling ? sec.ceilingHeinum : sec.floorHeinum;
          const across = Math.hypot(heinum, 4096) / 4096;
          desc.align = { ox: w1.x, oy: w1.y, ux: dx / len, uy: dy / len, across };
        }
      }
    }

    if (desc.parallax) {
      desc.skyColour = this.#pick(desc.kind, sectIdx, desc.base, this.shade(desc.shade, 0, 0));
      desc.sky = flat ? null : this.#skyPanorama(picNum);
      desc.skyShade = this.shade(desc.shade, 0, 0);
    }
    return desc;
  }

  /**
   * A parallaxed ceiling is a panorama, not a surface: Build spreads a run of
   * consecutive tiles around the full turn and picks by view angle.
   *
   * How many tiles that run holds is set in the game's CON scripts, which are
   * not parsed here, so it is recovered from the art instead: tiles following
   * the first one that share its exact dimensions belong to the same sky.
   */
  #skyPanorama(picNum) {
    if (!this.skyCache) this.skyCache = new Map();
    const hit = this.skyCache.get(picNum);
    if (hit !== undefined) return hit;

    const art = this.res.art;
    const first = tileOf(art, picNum);
    if (!first) { this.skyCache.set(picNum, null); return null; }

    // One tile per segment, via the offset table. An offset whose tile is
    // missing from the ART falls back to the base rather than dropping the
    // segment, which keeps the panorama the right width either way.
    const spec = SKY_TABLE.get(picNum) ?? SKY_DEFAULT;
    const tiles = spec.off.map((o) => {
      const t = o === 0 ? first : tileOf(art, picNum + o);
      return t && t.width === first.width && t.height === first.height ? t : first;
    });

    const sky = {
      tiles, tileW: first.width, height: first.height,
      width: SKY_SEGMENTS * first.width,
      yScale: spec.yScale,
      known: SKY_TABLE.has(picNum),
    };
    this.skyCache.set(picNum, sky);
    return sky;
  }

  #skySpan(x, y0, y1, d) {
    const { width, pixels, depth: zbuf } = this;
    // A parallax sky takes its sector's pal like any other flat.
    const shadeLuts = this.#luts(d.pal);
    const sky = d.sky;

    // The sky has its own horizon. parascan() shears it by parallaxyscale and
    // puts the engine's back afterwards, so the panorama lags the world by
    // that factor — a half for most Duke skies, all of it for CLOUDYOCEAN,
    // about a quarter for LA. It is an anchor, not a plane intersection: the
    // row below is a distance from this line and nothing here meets geometry.
    const skyHorizon = this.halfH + (this.horizon - this.halfH) * sky.yScale;

    const ang = mod(this.cam.ang + this.colAng[x], 2048);
    const su = mod(Math.floor(ang / 2048 * sky.width), sky.width);
    const tile = sky.tiles[Math.floor(su / sky.tileW)];
    const col = (su % sky.tileW) * sky.height;

    // Build anchors the panorama by its middle: globalzd puts texel h/2 on
    // the horizon, so only the upper half of the tile is ever above it.
    //
    // One texel per row at the reference width and field of view, scaled for
    // both. The slider stays as a debug override with a default of 1, so a
    // mismatch shows up as a number away from 1 rather than as a constant
    // quietly absorbing an error elsewhere.
    const vScale = this.skyStep * (this.res.skyVScale ?? 1);
    const vMid = sky.height / 2;
    const lut = d.skyShade * 256;

    for (let y = y0; y <= y1; y++) {
      const i = y * width + x;
      if (zbuf[i] !== 0) continue;
      zbuf[i] = 1e-6;                       // effectively infinitely far away
      this.#hit(i);
      const v = clamp(Math.floor(vMid + (y - skyHorizon) * vScale), 0, sky.height - 1);
      pixels[i] = shadeLuts[lut + tile.pixels[col + v]];
    }
  }

  /**
   * A sloped floor or ceiling.
   *
   * The flat case gets away with one reciprocal per screen row because depth
   * is constant along a row. On a slope it is not, so each pixel needs the
   * ray meeting the plane. Everything that depends only on the column is
   * lifted out, leaving one division in the inner loop.
   */
  #slopedSpan(x, y0, y1, d) {
    const { width, pixels, depth: zbuf, cam, rowK, halfW, focalX } = this;
    const { A, B, C } = d.plane;

    if (y0 < 0) y0 = 0;
    if (y1 > this.height - 1) y1 = this.height - 1;

    const u = (x + 0.5 - halfW) / focalX;
    const hx = this.fx + this.rx * u;
    const hy = this.fy + this.ry * u;
    const den1 = A * hx + B * hy;
    const num = cam.z - A * cam.x - B * cam.y - C;

    const tile = d.tile;
    const th = tile ? tile.height : 0;
    const tw = tile ? tile.width : 0;

    for (let y = y0; y <= y1; y++) {
      const i = y * width + x;
      const den = den1 - 16 * rowK[y];
      if (Math.abs(den) < 1e-9) { this.#dropAt(i, DROP_SLOPE_PARALLEL, d.sect); continue; }
      // The sloped twin of the flat guard above; grouscan compares against
      // getflorzofslope/getceilzofslope and calls it back-face culling.
      const dist = num / den;
      if (dist <= 0) { this.#dropAt(i, DROP_SLOPE_BEHIND, d.sect); continue; }

      if (zbuf[i] !== 0) continue;
      zbuf[i] = 1 / dist;

      if (!tile) {
        pixels[i] = this.#pick(d.kind, d.sect, d.base, this.shade(d.shade, dist, d.visibility));
        this.#hit(i);
        continue;
      }

      const wx = cam.x + hx * dist;
      const wy = cam.y + hy * dist;
      let tu, tv;
      if (d.align) {
        const rx = wx - d.align.ox, ry = wy - d.align.oy;
        tu = rx * d.align.ux + ry * d.align.uy;
        tv = (ry * d.align.ux - rx * d.align.uy) * d.align.across;
      } else { tu = wx; tv = -wy; }   // world axes: v runs against world y
      tu *= d.uScale; tv *= d.vScale;
      if (d.swapXY) { const t = tu; tu = tv; tv = t; }
      if (d.xflip) tu = -tu;
      if (d.yflip) tv = -tv;

      const fu = mod(Math.floor(tu + d.xPan), tw), fv = mod(Math.floor(tv + d.yPan), th);
      this.#uvAt(i, fu, fv);
      const texel = tile.pixels[fu * th + fv];
      pixels[i] = this.#luts(d.pal)[this.shade(d.shade, dist, d.visibility) * 256 + texel];
      // After #uvAt, never before: #hit folds the pending texel into the
      // report and clears it. Called first it would fold in whatever #uvAt
      // left behind last — the previous frame's, since nothing else consumes
      // it. The wall path has always had this order.
      this.#hit(i);
    }
  }

  #flatSpan(x, y0, y1, d) {
    if (y1 < y0) return;
    const { width, pixels, depth: zbuf, cam, invRow, invRowF, halfW } = this;

    if (y0 < 0) y0 = 0;
    if (y1 > this.height - 1) y1 = this.height - 1;

    // Parallax first, and without consulting the plane at all.
    //
    // A parallaxed ceiling is a panorama, not a surface: Build's parascan
    // never intersects the ray with the sector's plane, and neither may this.
    // Routing the untextured fallback through the plane below made the sky
    // depend on where its ceilingz happened to sit — with the eye above that
    // plane, `dist = k * invRow` comes out negative for every row above the
    // horizon and the guard drops the lot. The result was the whole upper
    // half of the frame unpainted, in runs ending exactly at the horizon row,
    // whenever the view carried a sky whose plane lay below eye level. Only
    // the flat paths could show it, since the textured path takes #skySpan
    // one line down and that has no plane in it either.
    if (d.parallax) {
      if (d.sky) { this.#skySpan(x, y0, y1, d); return; }
      for (let y = y0; y <= y1; y++) {
        const i = y * width + x;
        if (zbuf[i] !== 0) continue;
        zbuf[i] = 1e-6;                     // effectively infinitely far away
        this.#hit(i);
        pixels[i] = d.skyColour;
      }
      return;
    }
    if (d.plane.sloped) { this.#slopedSpan(x, y0, y1, d); return; }

    const lat = x + 0.5 - halfW;
    const tile = d.tile;
    const th = tile ? tile.height : 0;
    const tw = tile ? tile.width : 0;

    for (let y = y0; y <= y1; y++) {
      const i = y * width + x;
      const inv = invRow[y];
      if (inv === 0) { this.#dropAt(i, DROP_FLAT_HORIZON, d.sect); continue; }

      // Back-face culling, and Build does exactly this. florscan opens with
      //
      //   globalzd = globalposz - sec->floorz;
      //   //We are UNDER the floor: Do NOT render anything.
      //   if (globalzd > 0) return;
      //
      // ceilscan has the mirror of it and grouscan the sloped version, where
      // the comment in the original reads "Back-face culling" outright. A
      // plane the eye is on the wrong side of is not drawn, full stop.
      //
      // So pixels dropped here are not a defect: the original leaves them
      // unpainted too, which is where Build's famous hall-of-mirrors comes
      // from. They turn up in a sweep at vantage points a player never
      // occupies and are invisible in normal play.
      const dist = d.k * inv;
      if (dist <= 0) { this.#dropAt(i, DROP_FLAT_BEHIND, d.sect); continue; }

      if (zbuf[i] !== 0) continue;
      zbuf[i] = 1 / dist;

      if (!tile) {
        pixels[i] = this.#pick(d.kind, d.sect, d.base, this.shade(d.shade, dist, d.visibility));
        this.#hit(i);
        continue;
      }

      // World point under this pixel. Depth is fixed for the row, and the
      // sideways offset scales with it, so both fall out of the tabulated
      // reciprocal without a division.
      const off = lat * d.k * invRowF[y];
      const wx = cam.x + this.fx * dist + this.rx * off;
      const wy = cam.y + this.fy * dist + this.ry * off;

      let tu, tv;
      if (d.align) {
        const rx = wx - d.align.ox, ry = wy - d.align.oy;
        tu = rx * d.align.ux + ry * d.align.uy;
        tv = (ry * d.align.ux - rx * d.align.uy) * d.align.across;
      } else {
        // World axes. Build's v runs against world y: ceilscan sets
        //
        //   globalxpanning = (globalposx<<20);
        //   globalypanning = -(globalposy<<20);
        //
        // and grouscan the same, as globalx1 = (globalposx<<8), globaly1 =
        // -(globalposy<<8). Relative alignment (bit 6) reverses v again —
        // both its origin and the coefficients that drive it flip sign — so
        // with a reference wall along +x the two modes agree on u and run v
        // in opposite directions. That relation is pinned in the tests.
        tu = wx; tv = -wy;
      }
      tu *= d.uScale; tv *= d.vScale;
      if (d.swapXY) { const t = tu; tu = tv; tv = t; }
      if (d.xflip) tu = -tu;
      if (d.yflip) tv = -tv;

      const u = mod(Math.floor(tu + d.xPan), tw);
      const v = mod(Math.floor(tv + d.yPan), th);
      this.#uvAt(i, u, v);
      pixels[i] = this.#luts(d.pal)[this.shade(d.shade, dist, d.visibility) * 256 + tile.pixels[u * th + v]];
      this.#hit(i);   // after #uvAt — see the sloped span
    }
  }
}

/**
 * Which of `n` candidates is nearest, given a partial "is i in front of j"
 * relation that may answer null.
 *
 * The relation is not a total order, so one pass over the candidates does not
 * find the nearest. A candidate that could not be ordered against the running
 * winner may well be in front of the one that replaces it later, and a single
 * pass never asks again. Build's drawrooms() does not settle for that: a
 * second pass revisits everything the first left undecided and restarts from
 * the top whenever the winner changes. Its own comment on the first pass is
 * "Almost works, but not quite :(".
 *
 * `tested` is Build's tempbuf. A candidate is marked once it has been compared
 * against the current winner, so the second pass only revisits what could not
 * be ordered — a candidate that was compared and lost stays lost, as in Build.
 *
 * On E1L5 the single-pass version left 167896 pixels drawn out of order across
 * a 3216-frame sweep, in 300 of those frames; this leaves 4, in 2 frames.
 *
 * @param {number} n
 * @param {(i: number, j: number) => boolean|null} inFront
 * @returns {number} index of the nearest candidate
 */
export function closestBunch(n, inFront) {
  const tested = new Array(n).fill(false);
  let closest = 0;
  tested[0] = true;

  for (let i = 1; i < n; i++) {
    const r = inFront(i, closest);
    if (r === null) continue;
    tested[i] = true;
    if (r) { tested[closest] = true; closest = i; }
  }
  for (let i = 0; i < n; i++) {
    if (tested[i]) continue;
    const r = inFront(i, closest);
    if (r === null) continue;
    tested[i] = true;
    if (r) { tested[closest] = true; closest = i; i = -1; }
  }
  return closest;
}

/** Stable, well-spread colour per sector index. */
function sectorColour(i) {
  const h = (i * 0.61803398875) % 1;   // golden ratio keeps neighbours apart
  const s = 0.55, v = 0.85;
  const j = Math.floor(h * 6), f = h * 6 - j;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  let r, g, b;
  switch (j % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q;
  }
  return (255 << 24) | (Math.round(b * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(r * 255);
}

function tileOf(art, picNum) {
  const tile = art?.get(picNum);
  return tile?.pixels && tile.width > 0 && tile.height > 0 ? tile : null;
}

function mod(a, n) {
  const r = a % n;
  return r < 0 ? r + n : r;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
