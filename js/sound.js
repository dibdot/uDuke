// Cache tripwire: see version.js.
export const MODULE_STAGE = 'stage12.196';

// uDuke - sound: Creative VOC files and Duke's positional sound model.
//
// Two halves. `parseVoc` reads the format the Apogee sound library reads
// (multivoc.c, MV_GetNextVOCBlock): a 26-byte header, then blocks of a type
// byte and a 24-bit length. `SoundSystem` is sounds.c's xyzsound() and
// sound(): which of the CON's 374 definesounds to play, how loud, how far
// left, at what pitch — and the four-instances-per-sound and one-voice-
// per-sprite rules that keep a level from becoming a wall of noise.
//
// The audio device itself is Web Audio, created by the page on the first
// user gesture (browsers allow nothing before one). Nothing here touches it
// directly: the system produces `{ num, gain, pan, rate, buffer }` events and
// the page hands them to an AudioContext. That is what makes the model
// testable without a browser.

import { findDistance3D, krand } from './effector.js';
import { getAngle, canSee } from './con.js';

/**
 * Creative Voice File → mono float samples.
 *
 * Block types, as multivoc.c handles them:
 *   1  sound data: a rate byte tc (rate = 1000000/(256-tc)), a pack byte
 *      (only 0 = unpacked 8-bit is played), then samples
 *   2  continuation of the previous block's data at its rate
 *   3  silence, 4 marker, 5 text: skipped
 *   6  repeat begin (count, 0xffff = for ever), 7 repeat end
 *   8  extended: a 16-bit tc, pack, and stereo flag for the NEXT block 1
 *   9  new data: 32-bit rate, bits, channels, format; 8-bit mono or 16-bit
 *      mono are played
 *   0  terminator
 *
 * Samples are unsigned 8-bit centred on 128 (or signed 16-bit). Loops are
 * returned as sample offsets; Duke uses them for the looping sounds
 * (soundm&1), which play from `start` in the header to the end.
 */
export function parseVoc(bytes) {
  const magic = 'Creative Voice File';
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic.charCodeAt(i)) throw new Error('not a VOC file');
  }
  const dataOff = bytes[20] | (bytes[21] << 8);
  let p = dataOff;
  let rate = 0;
  const chunks = [];
  let total = 0;
  let loopStart = -1, loopEnd = -1, loopCount = 0;
  let extTc = -1, extStereo = 0, lastType = 0;
  const blocks = [];            // [type, length] — what the file is made of

  while (p < bytes.length) {
    const type = bytes[p];
    if (type === 0) { blocks.push([0, 0]); break; }
    const len = bytes[p + 1] | (bytes[p + 2] << 8) | (bytes[p + 3] << 16);
    blocks.push([type, len]);
    let q = p + 4;
    switch (type) {
      case 1: {
        let tc, pack, stereo = 0;
        if (lastType === 8) { tc = extTc; stereo = extStereo; pack = bytes[q + 1]; }
        else { tc = bytes[q] << 8; pack = bytes[q + 1]; }
        // `samplespeed = 256000000 / (65536 - tc)` with tc pre-shifted by 8.
        rate = Math.trunc(256000000 / (65536 - tc));
        if (pack === 0 && stereo === 0) {
          const n = len - 2;
          const out = new Float32Array(n);
          for (let i = 0; i < n; i++) out[i] = (bytes[q + 2 + i] - 128) / 128;
          chunks.push(out); total += n;
        }
        break;
      }
      case 2: {
        const out = new Float32Array(len);
        for (let i = 0; i < len; i++) out[i] = (bytes[q + i] - 128) / 128;
        chunks.push(out); total += len;
        break;
      }
      case 6:
        if (loopEnd < 0) { loopCount = bytes[q] | (bytes[q + 1] << 8); loopStart = total; }
        break;
      case 7:
        if (lastType === 6) loopCount = 0;
        else if (loopCount > 0 && loopStart >= 0 && loopEnd < 0) loopEnd = total;
        break;
      case 8:
        extTc = bytes[q] | (bytes[q + 1] << 8);
        extStereo = bytes[q + 3];
        break;
      case 9: {
        const r = bytes[q] | (bytes[q + 1] << 8) | (bytes[q + 2] << 16) | (bytes[q + 3] << 24);
        const bits = bytes[q + 4], channels = bytes[q + 5];
        const format = bytes[q + 6] | (bytes[q + 7] << 8);
        if (channels === 1 && bits === 8 && format === 0) {
          rate = r;
          const n = len - 12;
          const out = new Float32Array(n);
          for (let i = 0; i < n; i++) out[i] = (bytes[q + 12 + i] - 128) / 128;
          chunks.push(out); total += n;
        } else if (channels === 1 && bits === 16 && format === 4) {
          rate = r;
          const n = (len - 12) >> 1;
          const out = new Float32Array(n);
          for (let i = 0; i < n; i++) {
            let v = bytes[q + 12 + i * 2] | (bytes[q + 13 + i * 2] << 8);
            if (v > 32767) v -= 65536;
            out[i] = v / 32768;
          }
          chunks.push(out); total += n;
        }
        break;
      }
      default:
        break;
    }
    lastType = type;
    p = q + len;
  }

  const samples = new Float32Array(total);
  let o = 0;
  for (const c of chunks) { samples.set(c, o); o += c.length; }
  return { sampleRate: rate, samples, loopStart, loopEnd, loopCount, blocks, dataOff };
}

// --- Duke's sound model, sounds.c ------------------------------------------

/** `#define LOUDESTVOLUME 150` — nothing plays louder than distance (255-150)<<6. */
export const LOUDESTVOLUME = 150;

/** The soundm flags from definesound's `m` word. */
export const SM = { LOOP: 1, MSFX: 2, DUKE: 4, ADULT: 8, GLOBAL_NODIST: 16, GLOBAL: 128 };

/**
 * FX_Pan3D / MV_CalcPanTable: 32 pan positions, 64 volume steps. `distance`
 * is sndist>>6 (0..255), `angle` is sndang>>6 (0..31). Returns left and
 * right gains in 0..1. Position 0 is in front (both full), 8 is hard right,
 * 16 behind (both full), 24 hard left.
 */
export function pan3D(angle, distance) {
  const MV_MaxVolume = 63;
  const dist = Math.max(0, Math.min(distance, 255));
  const volume = (dist * (MV_MaxVolume + 1)) >> 8;          // MIX_VOLUME
  const level = Math.trunc((255 * (MV_MaxVolume - volume)) / MV_MaxVolume);
  const a = angle & 31;
  const half = 16;
  // The table is built from the quarter 0..8 and mirrored; read it back.
  let q, side;   // q: 0..8 within the quarter; side: which channel ramps
  if (a <= 8) { q = a; side = 'left'; }
  else if (a <= 16) { q = 16 - a; side = 'left'; }
  else if (a <= 24) { q = a - 16; side = 'right'; }
  else { q = 32 - a; side = 'right'; }
  const ramp = level - Math.trunc((level * q) / (32 / 4));
  const left = side === 'left' ? ramp : level;
  const right = side === 'right' ? ramp : level;
  void half;
  return { left: left / 255, right: right / 255 };
}

/**
 * The positional model of xyzsound(), reduced to numbers a page can hand to
 * an audio graph: `{ gain, pan, rate }` — or null when Duke would not play
 * the sound at all (beyond 31444, or more than four instances running).
 *
 *   sndist  = FindDistance3D(dx, dy, dz>>4) + soundvo
 *           + sndist>>5 when the listener cannot see the source
 *           never below (255-LOUDESTVOLUME)<<6 = 6720 — a sound at your feet
 *   pitch   = a random point in [ps, pe] (hundredths of a semitone)
 *   sndang  = (2048 + camAng - getangle(cam - source)) & 2047
 *
 * The listener is at the eye; the source's z is compared at a sixteenth.
 */
export class SoundSystem {
  constructor(defs, vm = null) {
    this.defs = defs;                 // num -> { file, ps, pe, pr, m, vo }
    this.vm = vm;                     // for radarang and cansee
    this.playing = new Map();         // num -> [{ sprite, endsAt }]
    this.events = [];                 // what to play this tic, drained by the page
    this.now = 0;                     // tics
    this.enabled = true;
  }

  tick() {
    this.now++;
    for (const [num, list] of this.playing) {
      const live = list.filter((v) => v.endsAt > this.now);
      // TestCallBack, sounds.c 605: a sound's end reaches its owner. For a
      // MUSICANDSFX owner (lotag under 999, in a sector of lotag under 3 —
      // signed there) the callback clears temp_data[0], and the ambient tic
      // starts the sound again next tic: this is how a seven-second bar
      // track with no loop flag plays forever. The hook is the game's.
      if (this.onEnd && !((this.defs.get(num)?.m ?? 0) & SM.GLOBAL_NODIST)) {
        for (const v of list) if (v.endsAt <= this.now && v.sprite >= 0) this.onEnd(num, v.sprite);
      }
      if (live.length) this.playing.set(num, live); else this.playing.delete(num);
    }
  }

  count(num) { return (this.playing.get(num) ?? []).length; }

  /**
   * How long a sound runs, in tics, from its decoded samples — the instance
   * bookkeeping (four per sound, eight voices, the owner rule) depends on
   * knowing when one ends. Without a decoder (tests), 30.
   */
  length(num) {
    const voc = this.decode ? this.decode(num) : null;
    if (!voc || !voc.sampleRate || !voc.samples.length) return 30;
    return Math.max(1, Math.ceil((voc.samples.length / voc.sampleRate) * 30));
  }
  isPlaying(num) { return this.count(num) > 0; }

  stop(num) { this.playing.delete(num); this.events.push({ stop: num }); }

  /** stopenvsound(num, i), sounds.c 509: the one instance of `num` that sprite i started. */
  stopEnv(num, sprite) {
    const list = this.playing.get(num);
    if (!list) return;
    const k = list.findIndex((v) => v.sprite === sprite);
    if (k < 0) return;
    list.splice(k, 1);
    if (!list.length) this.playing.delete(num);
    this.events.push({ stop: num, sprite });
  }

  /** The pitch draw, shared by every play path. */
  #pitch(def) {
    const range = Math.abs(def.pe - def.ps);
    if (!range) return def.ps;
    const r = krand(this.vm?.fx ?? { randomSeed: 0 }) % range;
    return def.ps < def.pe ? def.ps + r : def.pe + r;
  }

  /** sound(num): global, no position. */
  global(num, sprite = -1, lengthTics = null) {
    lengthTics ??= this.length(num);
    const def = this.defs.get(num);
    if (!def || !this.enabled) return null;
    if (this.count(num) > 3) return null;
    if (!this.#voiceFor(def.pr)) return null;
    const pitch = this.#pitch(def);
    const ev = { num, sprite, gain: (255 - Math.max(0, Math.min(255, def.vo >> 6))) / 255, pan: 0,
      rate: Math.pow(2, pitch / 1200), loop: !!(def.m & SM.LOOP) };
    this.events.push(ev);
    this.#track(num, sprite, lengthTics);
    return ev;
  }

  /** Is any Duke voice line (soundm&4) running? They never overlap. */
  dukeTalking() {
    for (const [num, list] of this.playing) {
      if (list.length && ((this.defs.get(num)?.m ?? 0) & SM.DUKE)) return true;
    }
    return false;
  }

  /** spritesound(num, i) / xyzsound(num, i, x, y, z). */
  at(num, sprite, x, y, z, cam, map = null, lengthTics = null) {
    lengthTics ??= this.length(num);
    const def = this.defs.get(num);
    if (!def || !this.enabled) return null;
    if (def.m & SM.GLOBAL) return this.global(num, sprite, lengthTics);
    if (this.count(num) > 3) return null;
    // A Duke line while another is running: refused. xyzsound() scans every
    // sound for a playing soundm&4 before it lets one start; this is why
    // Duke never talks over himself.
    if ((def.m & SM.DUKE) && this.dukeTalking()) return null;

    let sndist = findDistance3D(cam.x - x, cam.y - y, (cam.z - z) >> 4);
    // xyzsound 333: an ambient MUSICANDSFX (lotag under 999, in a sector of
    // lotag under 9, not a soundm&16) has its distance DIVIDED by hitag+1 —
    // divscale14 — which is what lets a hitag of 10000 fill a whole bar.
    if (sprite >= 0 && map) {
      const src = map.sprites[sprite];
      if (src && src.picNum === 5 && src.lotag < 999 && !(def.m & SM.GLOBAL_NODIST)
          && ((map.sectors[src.sectNum]?.lotag ?? 0) & 0xff) < 9) {
        sndist = Math.trunc((sndist * 16384) / (src.hitag + 1));
      }
    }
    sndist += def.vo;
    if (sndist < 0) sndist = 0;
    // The line-of-sight penalty only ADDS distance, so a sound already past
    // the 31444 cap is refused without the (costly) cansee — the same answer
    // Duke reaches after it. And FX_VoiceAvailable(priority): eight voices,
    // and a new sound takes one from a lower-priority voice or is refused.
    if (sndist > 31444) return null;
    if (!this.#voiceFor(def.pr)) return null;
    if (sndist && map && this.vm
        && !canSee(map, cam.x, cam.y, cam.z - (24 << 8), cam.sectNum, x, y, z - (24 << 8),
          map.sprites[sprite]?.sectNum ?? cam.sectNum)) {
      sndist += sndist >> 5;
    }
    if (sndist > 31444) return null;

    // A second instance from the same sprite, or more than one already,
    // stops the earlier one first.
    if (this.count(num) > 0) {
      const list = this.playing.get(num);
      if (list.some((v) => v.sprite === sprite) || list.length > 1) this.stop(num);
    }

    let sndang = 0;
    if (sprite === -2) { sndist = 0; }                  // the player's own
    else sndang = (2048 + cam.ang - getAngle(this.vm?.radarang ?? null, cam.x - x, cam.y - y)) & 2047;

    if (def.m & SM.GLOBAL_NODIST) sndist = 0;
    if (sndist < ((255 - LOUDESTVOLUME) << 6)) sndist = (255 - LOUDESTVOLUME) << 6;

    const pitch = this.#pitch(def);
    const { left, right } = pan3D(sndang >> 6, sndist >> 6);
    const gain = Math.max(left, right);
    const pan = right === left ? 0 : (right - left) / Math.max(left, right, 1e-6);
    const ev = { num, sprite, gain, pan, rate: Math.pow(2, pitch / 1200), loop: !!(def.m & SM.LOOP),
      left, right };
    this.events.push(ev);
    this.#track(num, sprite, lengthTics);
    return ev;
  }

  /**
   * FX_VoiceAvailable(priority): MV_MaxVoices is 8. With all eight busy, a
   * voice whose sound has a LOWER priority is stopped for the newcomer;
   * otherwise the newcomer is refused. Priorities come from definesound.
   */
  #voiceFor(priority) {
    let total = 0, lowestNum = -1, lowestPr = Infinity;
    for (const [num, list] of this.playing) {
      total += list.length;
      const pr = this.defs.get(num)?.pr ?? 0;
      if (pr < lowestPr) { lowestPr = pr; lowestNum = num; }
    }
    if (total < 8) return true;
    if (lowestNum >= 0 && lowestPr < priority) { this.stop(lowestNum); return true; }
    return false;
  }

  #track(num, sprite, lengthTics) {
    const list = this.playing.get(num) ?? [];
    list.push({ sprite, endsAt: this.now + lengthTics });
    this.playing.set(num, list);
  }

  /** The page takes what accumulated this tic. */
  drain() { const e = this.events; this.events = []; return e; }
}


/**
 * callsound(sn, whatsprite), sector.c 33: the MUSICANDSFX sprite (tile 5)
 * in sector `sn` with lotag under 1000 is the sector's sound source. Its
 * lotag is the sound to start (a door opening, a lift starting), its hitag
 * the sound to end on; T1 remembers which comes next. The first call plays
 * lotag and stops a running hitag; the second plays hitag and stops lotag if
 * it loops or differs; a sector of lotag 22 never flips. Sounds with soundm&16
 * are not started this way. Returns the lotag, or -1 with no source.
 *
 * The source position is the MUSICANDSFX sprite itself (whatsprite -1).
 */
export function callSound(map, sounds, fx, cam, sn, whatsprite = -1) {
  if (!sounds) return -1;
  for (let i = 0; i < map.sprites.length; i++) {
    const s = map.sprites[i];
    if (s.removed || s.sectNum !== sn || s.picNum !== 5 || s.lotag >= 1000) continue;
    if (whatsprite === -1) whatsprite = i;
    const src = map.sprites[whatsprite] ?? s;
    const t = fx.temp(i);
    const slt = s.lotag, sht = s.hitag;
    const def = sounds.defs.get(slt);
    if (t[0] === 0) {
      if (!def || (def.m & SM.GLOBAL_NODIST) === 0) {
        if (slt) {
          sounds.at(slt, whatsprite, src.x, src.y, src.z, cam, map);
          if (sht && slt !== sht && sounds.defs.has(sht)) sounds.stop(sht);
        }
        if ((map.sectors[s.sectNum].lotag & 0xff) !== 22) t[0] = 1;
      }
    } else if (sounds.defs.has(sht) || sht === 0) {
      if (sht) sounds.at(sht, whatsprite, src.x, src.y, src.z, cam, map);
      if ((def && (def.m & SM.LOOP)) || (sht && sht !== slt)) sounds.stop(slt);
      t[0] = 0;
    }
    return slt;
  }
  return -1;
}
