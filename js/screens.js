// uDuke - Duke's full-screen 2D pictures: the ANM player, the logo and title
// sequence at start-up, and the "ENTERING <level>" screen between levels.
//
// Sources (chocolate_duke3D): Game/src/animlib.c (the Deluxe Paint ANM "large
// page" format and its RunSkipDump decoder), menues.c (playanm, logoanimsounds,
// menutext, palto), game.c Logo() and premap.c dofrontscreens().
//
// Everything here draws into an INDEXED 320x200 buffer, as Duke's screen was,
// and the page converts it with one palette and one palto() fade. The
// pictures use different palettes — the ANM brings its own, the 3D Realms
// screen is `drealms` and the title `titlepal`, both from LOOKUP.DAT, the
// loading screen the game's — so indices first, colours last.

export const MODULE_STAGE = 'stage12.196';

/** names.h */
export const T = {
  LOADSCREEN: 3281, DREALMS: 2492, BETASCREEN: 2493, DUKENUKEM: 2497, THREEDEE: 2498,
  PLUTOPAKSPRITE: 2501, BIGALPHANUM: 2940, BIGPERIOD: 3002, BIGCOMMA: 3003, BIGX: 3004,
  BIGQ: 3005, BIGSEMI: 3006, BIGCOLIN: 3007, BIGAPPOS: 3022, STARTALPHANUM: 2822, ENDALPHANUM: 2915,
};

// LOOKUP.DAT's five base palettes after the remaps, in genspriteremaps()'s
// order: waterpal, slimepal, titlepal, drealms, endingpal.
export const BASE_PAL = { WATER: 0, SLIME: 1, TITLE: 2, DREALMS: 3, ENDING: 4 };

// ---------------------------------------------------------------------------
// The ANM file (animlib.c). Layout: a 128-byte lpfileheader, 128 bytes unused,
// the palette as 256 x (B, G, R, pad) at 256, the 256 large-page descriptors
// (baseRecord, nRecords, nBytes: three uint16) at 1280, the pages at 0xb00 +
// n*0x10000. A page starts with its own descriptor and a uint16, then one
// uint16 length per record, then the records.

export class Anm {
  constructor(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const id = String.fromCharCode(b[0], b[1], b[2], b[3]);
    if (id !== 'LPF ') throw new Error(`ANM: not an LPF file (${JSON.stringify(id)})`);
    this.bytes = b; this.dv = dv;
    this.nLps = dv.getUint16(6, true);
    this.numFrames = dv.getUint32(8, true);          // ANIM_NumFrames: lpheader.nRecords
    this.width = dv.getUint16(20, true);
    this.height = dv.getUint16(22, true);
    // ANIM_LoadAnim: pal[i+2] = B, pal[i+1] = G, pal[i] = R, one byte skipped.
    this.palette = new Uint8Array(768);
    for (let i = 0, o = 256; i < 768; i += 3, o += 4) {
      this.palette[i + 2] = b[o]; this.palette[i + 1] = b[o + 1]; this.palette[i] = b[o + 2];
    }
    this.lps = [];
    for (let i = 0; i < 256; i++) {
      const o = 1280 + i * 6;
      this.lps.push({ baseRecord: dv.getUint16(o, true), nRecords: dv.getUint16(o + 2, true), nBytes: dv.getUint16(o + 4, true) });
    }
    this.image = new Uint8Array(0x10000);
    this.curlpnum = 0xffff;
    this.curlp = null;
    this.pageOff = 0;
    this.currentFrame = -1;
  }

  /** findpage: the large page holding a frame. */
  findPage(frame) {
    let i;
    for (i = 0; i < this.nLps; i++) {
      const lp = this.lps[i];
      if (lp.baseRecord <= frame && lp.baseRecord + lp.nRecords > frame) return i;
    }
    return i;
  }

  /** loadpage: the page's own descriptor; its record table follows 8 bytes in. */
  loadPage(n) {
    if (this.curlpnum === n) return;
    this.curlpnum = n;
    const o = 0xb00 + n * 0x10000;
    const dv = this.dv;
    this.curlp = { baseRecord: dv.getUint16(o, true), nRecords: dv.getUint16(o + 2, true), nBytes: dv.getUint16(o + 4, true) };
    this.pageOff = o + 6 + 2;
  }

  /** renderframe + CPlayRunSkipDump. */
  renderFrame(frame) {
    const dv = this.dv, lp = this.curlp;
    const dest = (frame - lp.baseRecord) & 0xffff;
    let offset = 0;
    for (let i = 0; i < dest; i++) offset = (offset + dv.getUint16(this.pageOff + i * 2, true)) & 0xffff;
    let p = this.pageOff + lp.nRecords * 2 + offset;
    if (this.bytes[p + 1]) {
      const w = dv.getUint16(p + 2, true);
      p += 4 + (w + (w & 1));
    } else p += 4;
    runSkipDump(this.bytes, p, this.image);
  }

  /**
   * ANIM_DrawFrame(n): brings the image up to n by drawing the frames from
   * the current one up to n-1 — so DrawFrame(1) shows frame 0, and playanm's
   * loop from 1 to numframes-1 never draws the last record (the last-to-
   * first delta). Returns the 320x200 image, row-major.
   */
  drawFrame(n) {
    const from = this.currentFrame !== -1 && this.currentFrame <= n ? this.currentFrame : 0;
    for (let cnt = from; cnt < n; cnt++) { this.loadPage(this.findPage(cnt)); this.renderFrame(cnt); }
    this.currentFrame = n;
    return this.image;
  }
}

/**
 * CPlayRunSkipDump, the portable decoder. The counts are the C types':
 * an int8 op (positive: dump; zero: an 8-bit run; negative: a 7-bit skip,
 * or with -128 the 16-bit ops), and the do/while loops, which run a zero
 * count 65536 times (bounded here by the buffer).
 */
export function runSkipDump(src, p, dst) {
  let d = 0;
  const n16 = () => { const v = src[p] | (src[p + 1] << 8); p += 2; return v; };
  for (;;) {
    let cnt = (src[p++] << 24) >> 24;
    if (cnt > 0) { do { dst[d++] = src[p++]; } while (--cnt); continue; }
    if (cnt === 0) {
      let w = src[p++]; const px = src[p++];
      if (w === 0) w = 0x10000;
      while (w-- > 0) { if (d < dst.length) dst[d] = px; d++; }
      continue;
    }
    cnt &= 0x7f;                                // (int8)(cnt - 0x80)
    if (cnt) { d += cnt; continue; }            // shortSkip
    let w = n16();                              // longOp
    if (((w << 16) >> 16) > 0) { d += w; continue; }   // longSkip
    if (w === 0) return d;                      // stop
    w -= 0x8000;
    if (w >= 0x4000) {                          // longRun
      w -= 0x4000; const px = src[p++];
      if (w === 0) w = 0x10000;
      while (w-- > 0) { if (d < dst.length) dst[d] = px; d++; }
    } else {                                    // longDump
      if (w === 0) w = 0x10000;
      while (w-- > 0) { if (d < dst.length) dst[d] = src[p]; d++; p++; }
    }
  }
}

// ---------------------------------------------------------------------------
// The logo: playanm("logo.anm", 5). The first frame at totalclock + 10, then
// every 9 tics of 120 Hz; frame i is the one DrawFrame(i) leaves (record i-1).
// logoanimsounds: FLY_BY at 1, PIPEBOMB_EXPLODE at 19.

export const TICRATE = 120;
export const LOGO_SOUNDS = new Map([[1, 'FLY_BY'], [19, 'PIPEBOMB_EXPLODE']]);
/**
 * The step i shown at `tick` (120 Hz from the start), 0 before the first, or
 * numFrames when done: the first frame at +10, then one every `per` tics.
 */
export function anmStepAt(tick, numFrames, per) {
  if (tick < 10) return 0;
  return Math.min(numFrames, Math.floor((tick - 10) / per) + 1);
}
export const logoStepAt = (tick, numFrames) => anmStepAt(tick, numFrames, 9);

/**
 * playanm's frame period by its `t` and ud.volume_number (0-based): the
 * chain of ifs in menues.c 4665, in its order.
 */
export function anmFrameTics(t, vol) {
  if (t === 10) return 14;
  if (t === 9) return 10;
  if (t === 7) return 18;
  if (t === 6) return 14;
  if (t === 5) return 9;
  if (vol === 3 || vol === 2) return 10;
  if (vol === 1) return 18;
  return 10;
}
/** playanm flushes the keyboard first, except for t 7, 9, 10, 11 (a key from before may skip those). */
export const anmFlushes = (t) => ![7, 9, 10, 11].includes(t);

// The sound schedules playanm calls after each frame (menues.c 4426..4599).
const END_VOL = {
  1: new Map([[1, ['WIND_AMBIENCE']], [26, ['ENDSEQVOL2SND1']], [36, ['ENDSEQVOL2SND2']], [54, ['THUD']], [62, ['ENDSEQVOL2SND3']],
    [75, ['ENDSEQVOL2SND4']], [81, ['ENDSEQVOL2SND5']], [115, ['ENDSEQVOL2SND6']], [124, ['ENDSEQVOL2SND7']]]),
  2: new Map([[1, ['WIND_REPEAT']], [98, ['DUKE_GRUNT']], [102, ['THUD', 'SQUISHED']], [124, ['ENDSEQVOL3SND3']],
    [134, ['ENDSEQVOL3SND2']], [158, ['PIPEBOMB_EXPLODE']]]),
};
const VOL4 = {
  // Episode 4's opening films (premap.c newgame: vol41a t6, vol42a t7, vol43a t9)
  6: new Map([[1, ['INTRO4_1']], [7, ['INTRO4_3']], [12, ['INTRO4_2']], [26, ['INTRO4_4']]]),   // first4animsounds
  7: new Map([[1, ['INTRO4_B']], [12, ['SHORT_CIRCUIT']], [18, ['INTRO4_5']], [34, ['SHORT_CIRCUIT']]]),   // intro4animsounds
  9: new Map([[10, ['INTRO4_6']]]),                                                            // intro42animsounds
  8: new Map([[3, ['DUKE_UNDERWATER']], [35, ['VOL4ENDSND1']]]),
  10: new Map([[11, ['DUKE_UNDERWATER']], [20, ['VOL4ENDSND1']], [39, ['VOL4ENDSND2']], [50, ['*STOPALL*']]]),
  11: new Map([[1, ['BOSS4_DEADSPEECH']], [40, ['VOL4ENDSND1', 'DUKE_UNDERWATER']], [50, ['BIGBANG']]]),
};
/**
 * What playanm(fn, t) plays after frame `fr` (names; '*STOPALL*' is
 * FX_StopAllSounds). t 6/7/9: Episode 4's opening films; t 8/10/11 its
 * three ending films; t 5 the logo;
 * t < 4 endanimsounds by the volume — so RADLOGO.ANM (t 3) at the end of
 * Episode 3 runs Episode 3's list too, as in Duke. t 4 (DUKETEAM) none.
 */
export function anmSounds(t, vol, fr) {
  if (VOL4[t]) return VOL4[t].get(fr) ?? [];
  if (t === 5) return LOGO_SOUNDS.has(fr) ? [LOGO_SOUNDS.get(fr)] : [];
  if (t < 4) return END_VOL[vol]?.get(fr) ?? [];
  return [];
}

// ---------------------------------------------------------------------------
// dobonus (game.c 9732): the end of an episode, before the level's tally.

export const VICTORY1 = 3260;
/** The still after each ending (Episodes 1 and 2), in the game palette. */
export const ENDING_STILL = { 0: 3292, 1: 3293 };
const BREATHE = [[0, 30, VICTORY1 + 1, 176, 59], [30, 60, VICTORY1 + 2, 176, 59], [60, 90, VICTORY1 + 1, 176, 59], [90, 120, 0, 176, 59]];
const BOSSMOVE = [[0, 120, VICTORY1 + 3, 86, 59], [220, 260, VICTORY1 + 4, 86, 59], [260, 290, VICTORY1 + 5, 86, 59],
  [290, 320, VICTORY1 + 6, 86, 59], [320, 350, VICTORY1 + 7, 86, 59], [350, 380, VICTORY1 + 8, 86, 59]];

/**
 * Episode 1's ending, one frame at `clock` (120 Hz), in `endingpal`: the
 * VICTORY1 picture at (0, 50); the boss's move between 390 and 780 (frames
 * by clock % 390; the shotgun and the squish on the third, once); outside
 * 450..750 the breathing (clock % 120; BOSSTALKTODUKE on the second phase,
 * once) and from 750 VICTORY1+8 with DUKETALKTOBOSS. `bonuscnt` orders the
 * three lines: each fires only after the one before. dastat 64: the patches
 * are drawn unmasked. Duke's boss loop runs t to 35 over a 30-entry table;
 * the entry past its end is none here. Returns { ops, bonuscnt, sounds }.
 */
export function victory1Frame(clock, bonuscnt) {
  const ops = [{ tile: VICTORY1, x: 0, y: 50, corner: true, opaque: true }];
  const sounds = [];
  if (clock > 390 && clock < 780) {
    BOSSMOVE.forEach(([a, b, tile, x, y], i) => {
      const m = clock % 390;
      if (tile && m > a && m <= b) {
        if (i === 2 && bonuscnt === 1) { sounds.push('SHOTGUN_FIRE', 'SQUISHED'); bonuscnt++; }
        ops.push({ tile, x, y, corner: true, opaque: true });
      }
    });
  }
  if (clock < 450 || clock >= 750) {
    if (clock >= 750) {
      ops.push({ tile: VICTORY1 + 8, x: 86, y: 59, corner: true, opaque: true });
      if (bonuscnt === 2) { sounds.push('DUKETALKTOBOSS'); bonuscnt++; }
    }
    BREATHE.forEach(([a, b, tile, x, y], i) => {
      const m = clock % 120;
      if (tile && m > a && m <= b) {
        if (i === 1 && bonuscnt === 0) { sounds.push('BOSSTALKTODUKE'); bonuscnt++; }
        ops.push({ tile, x, y, corner: true, opaque: true });
      }
    });
  }
  return { ops, bonuscnt, sounds };
}

/** Episode 4's last words (menutext on black). */
export function thanksOps(art) {
  return [...menuText(art, 160, 60, 'THANKS TO ALL OUR'), ...menuText(art, 160, 60 + 16, 'FANS FOR GIVING'),
    ...menuText(art, 160, 60 + 16 + 16, 'US BIG HEADS.'), ...menuText(art, 160, 70 + 16 + 16 + 16, 'LOOK FOR A DUKE NUKEM 3D'),
    ...menuText(art, 160, 70 + 16 + 16 + 16 + 16, 'SEQUEL SOON.')];
}
/** `for(t=a; t>b / t<b; t+=s)` as the list of palto values. */
export function paltoSteps(from, to, step) {
  const out = [];
  if (step > 0) for (let t = from; t < to; t += step) out.push(t);
  else for (let t = from; t > to; t += step) out.push(t);
  return out;
}

// ---------------------------------------------------------------------------
// The title (game.c Logo, after the ANM): DREALMS held 7 seconds; then
// BETASCREEN with the two words zooming in and, on the Atomic GRP, the
// PLUTOPAK badge shrinking in — 980 tics, three explosions and a fly-by.
// rotatesprite's z is a 16.16 zoom; flags 2+8 without 16 anchor the tile at
// its centre plus picanm offsets.

export const DREALMS_TICS = TICRATE * 7;
export const TITLE_TICS = 860 + 120;

/**
 * One frame of the title at `clock` (120 Hz since the picture was up).
 * `soundanm` is Duke's little state variable: each sound fires once, on the
 * first frame inside its window, and a frame that misses the window misses
 * the sound — as in Duke. Returns { ops, soundanm, sounds }.
 */
export function titleFrame(clock, soundanm, plutopak) {
  const ops = [{ tile: T.BETASCREEN, x: 0, y: 0, corner: true, opaque: true }];
  const sounds = [];
  const t = clock;
  if (t > 120 && t < 180) {
    if (soundanm === 0) { soundanm = 1; sounds.push('PIPEBOMB_EXPLODE'); }
    ops.push({ tile: T.DUKENUKEM, x: 160, y: 104, zoom: ((t - 120) << 10) / 65536 });
  } else if (t >= 180) ops.push({ tile: T.DUKENUKEM, x: 160, y: 104, zoom: (60 << 10) / 65536 });
  if (t > 220 && t < 250) {
    if (soundanm === 1) { soundanm = 2; sounds.push('PIPEBOMB_EXPLODE'); }
    ops.push({ tile: T.DUKENUKEM, x: 160, y: 104, zoom: (60 << 10) / 65536 });
    ops.push({ tile: T.THREEDEE, x: 160, y: 129, zoom: ((t - 220) << 11) / 65536 });
  } else if (t >= 250) ops.push({ tile: T.THREEDEE, x: 160, y: 129, zoom: (30 << 11) / 65536 });
  if (plutopak) {
    if (t >= 280 && t < 395) {
      ops.push({ tile: T.PLUTOPAKSPRITE + 1, x: 160, y: 151, zoom: ((410 - t) << 12) / 65536 });
      if (soundanm === 2) { soundanm = 3; sounds.push('FLY_BY'); }
    } else if (t >= 395) {
      if (soundanm === 3) { soundanm = 4; sounds.push('PIPEBOMB_EXPLODE'); }
      ops.push({ tile: T.PLUTOPAKSPRITE + 1, x: 160, y: 151, zoom: (30 << 11) / 65536 });
    }
  }
  return { ops, soundanm, sounds };
}

// ---------------------------------------------------------------------------
// menutext (menues.c 915): the big font, BIGALPHANUM. x == 160 centres the
// string: the width is summed as (tile width - 1) per glyph and 5 per space
// or unknown character, then x = (320 - width - 10) >> 1; drawing advances by
// the full tile width. y is the baseline 12 below the tiles' top. Both
// quirks are Duke's and kept: the centring sum and the advance differ by
// one a glyph, and ':' is measured as BIGSEMI but drawn as BIGCOLIN.

function glyph(c, measuring) {
  if (c >= '0' && c <= '9') return c.charCodeAt(0) - 48 + T.BIGALPHANUM - 10;
  if (c >= 'a' && c <= 'z') return c.toUpperCase().charCodeAt(0) - 65 + T.BIGALPHANUM;
  if (c >= 'A' && c <= 'Z') return c.charCodeAt(0) - 65 + T.BIGALPHANUM;
  switch (c) {
    case '-': return T.BIGALPHANUM - 11;
    case '.': return T.BIGPERIOD;
    case "'": return T.BIGAPPOS;
    case ',': return T.BIGCOMMA;
    case '!': return T.BIGX;
    case '?': return T.BIGQ;
    case ';': return T.BIGSEMI;
    case ':': return measuring ? T.BIGSEMI : T.BIGCOLIN;
    default: return -1;
  }
}

/** menutext(x, y, 0, 0, text) as tile ops (top-left anchored, masked). */
export function menuText(art, x, y, text) {
  const ops = [];
  y -= 12;
  let centre = 0;
  if (x === 160) {
    for (const c of text) {
      if (c === ' ') { centre += 5; continue; }
      const ac = glyph(c, true);
      if (ac < 0) { centre += 5; continue; }
      centre += (art.get(ac)?.width ?? 0) - 1;
    }
  }
  if (centre) x = (320 - centre - 10) >> 1;
  for (const c of text) {
    if (c === ' ') { x += 5; continue; }
    const ac = glyph(c, false);
    if (ac < 0) { x += 5; continue; }
    ops.push({ tile: ac, x, y, corner: true });
    x += art.get(ac)?.width ?? 0;
  }
  return ops;
}

/**
 * gametext (game.c 152): the small font, STARTALPHANUM + (c - '!') up to
 * ENDALPHANUM — ASCII 33..126, lower case included. x == 160 centres on the
 * summed width (digits count 8, a space 5), x = 160 - (width >> 1); a
 * character outside the font ends the string. Top-left anchored (the
 * callers pass dabits 2+8+16).
 */
export function gameText(art, x, y, text) {
  const ops = [];
  const code = (c) => c.charCodeAt(0) - 33 + T.STARTALPHANUM;
  const adv = (c, ac) => (c >= '0' && c <= '9' ? 8 : art.get(ac)?.width ?? 0);
  if (x === 160) {
    let w = 0;
    for (const c of text) {
      if (c === ' ') { w += 5; continue; }
      const ac = code(c);
      if (ac < T.STARTALPHANUM || ac > T.ENDALPHANUM) break;
      w += adv(c, ac);
    }
    x = 160 - (w >> 1);
  }
  for (const c of text) {
    if (c === ' ') { x += 5; continue; }
    const ac = code(c);
    if (ac < T.STARTALPHANUM || ac > T.ENDALPHANUM) break;
    ops.push({ tile: ac, x, y, corner: true });
    x += adv(c, ac);
  }
  return ops;
}

/**
 * The gate before the intro (not Duke's — a browser plays no sound before a
 * click or a key): Duke's own words in Duke's own fonts, on black.
 */
export function gateOps(art) {
  return [...menuText(art, 160, 90, 'COME GET SOME!'), ...gameText(art, 160, 104, 'press a key')];
}

/**
 * dofrontscreens (premap.c 1366): LOADSCREEN centred and opaque, "ENTERING"
 * on 90 and the level's name 24 below. `name` is level_names[] — USER.CON's
 * definelevelname.
 */
export function loadScreenOps(art, name) {
  return [{ tile: T.LOADSCREEN, x: 160, y: 100, opaque: true },
    ...menuText(art, 160, 90, 'ENTERING'), ...menuText(art, 160, 90 + 16 + 8, name ?? '')];
}

// ---------------------------------------------------------------------------
// Drawing: rotatesprite with dastat 2 (320x200 coordinates), angle 0, into
// the indexed buffer. `corner` is dastat&16 (top-left anchor), `opaque`
// dastat&64 (index 255 drawn too); otherwise the anchor is the tile's centre
// plus its picanm offsets, as in dorotatesprite, and 255 is transparent.
// The zoom samples nearest-neighbour.

export function blitTile(buf, art, op, W = 320, H = 200) {
  const t = art.get(op.tile);
  if (!t || !t.pixels || !t.width || !t.height) return false;
  const z = op.zoom ?? 1;
  if (!(z > 0)) return false;
  const xo = op.corner ? 0 : (t.anim?.xOffset ?? 0) + (t.width >> 1);
  const yo = op.corner ? 0 : (t.anim?.yOffset ?? 0) + (t.height >> 1);
  const left = op.x - xo * z, top = op.y - yo * z;
  const x0 = Math.max(0, Math.ceil(left)), x1 = Math.min(W, Math.ceil(left + t.width * z));
  const y0 = Math.max(0, Math.ceil(top)), y1 = Math.min(H, Math.ceil(top + t.height * z));
  for (let x = x0; x < x1; x++) {
    const sx = Math.min(t.width - 1, Math.floor((x - left) / z));
    const col = sx * t.height;
    for (let y = y0; y < y1; y++) {
      const sy = Math.min(t.height - 1, Math.floor((y - top) / z));
      const c = t.pixels[col + sy];
      if (c !== 255 || op.opaque) buf[y * W + x] = c;
    }
  }
  return true;
}

/**
 * palto(0,0,0,e) (menues.c 4152): each channel moved toward black by e/64,
 * `c + ((0 - c) * (e & 127) >> 6)`. Applied here to 8-bit channels.
 * Writes RGBA for an indexed buffer.
 */
export function toRgba(buf, palette, e, out) {
  const k = e & 127;
  for (let i = 0, o = 0; i < buf.length; i++, o += 4) {
    const p = buf[i] * 3;
    out[o] = palette[p] + ((-palette[p] * k) >> 6);
    out[o + 1] = palette[p + 1] + ((-palette[p + 1] * k) >> 6);
    out[o + 2] = palette[p + 2] + ((-palette[p + 2] * k) >> 6);
    out[o + 3] = 255;
  }
  return out;
}

// The fades as Duke writes them: out `for(i=0;i<64;i+=7)` — 0, 7, .. 63 —
// and in `for(i=63;i>0;i-=7)` — 63, 56, .. 7. The fade-in never reaches 0:
// the picture stays 7/64 dark until the next palette is set. Kept.
export const FADE_OUT = [0, 7, 14, 21, 28, 35, 42, 49, 56, 63];
export const FADE_IN = [63, 56, 49, 42, 35, 28, 21, 14, 7];
