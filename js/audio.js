// Cache tripwire: see version.js.
export const MODULE_STAGE = 'stage12.194';

// uDuke - the audio device: Web Audio behind the SoundSystem's events.
//
// The one browser-facing piece of the sound path. It exists so the pages
// share a single way of turning `{ num, gain, pan, rate, loop }` into a
// playing voice, and so the model in sound.js never has to know that an
// AudioContext exists — or that a browser refuses to create one before the
// user has clicked something.

/**
 * Wraps an AudioContext. `sounds.decode(num)` supplies decoded VOCs; each is
 * turned into an AudioBuffer once. `play(ev)` builds source → panner → gain
 * → destination for one event; `stop(num)` ends every voice of that sound.
 */
export class AudioOut {
  constructor(sounds) {
    this.sounds = sounds;
    this.ctx = null;
    this.buffers = new Map();
    this.rateFix = new Map();          // num -> playbackRate factor for a resampled buffer
    this.voices = new Map();          // num -> Set of source nodes
    this.master = null;
  }

  /** Create the context. Must be called from a user gesture. */
  start() {
    if (this.ctx) return true;
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return false;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.8;
    this.master.connect(this.ctx.destination);
    return true;
  }

  get ready() { return !!this.ctx && this.ctx.state === 'running'; }

  #buffer(num) {
    if (this.buffers.has(num)) return this.buffers.get(num);
    const voc = this.sounds.decode(num);
    let buf = null;
    if (voc && voc.samples.length && voc.sampleRate > 0) {
      // Web Audio refuses buffers below 8000 Hz (and above 96 kHz) in some
      // browsers — a NotSupportedError, and the sound is simply never heard.
      // SCUBA.VOC (DUKE_UNDERWATER) is a 5988 Hz file: play it as an 8 kHz
      // buffer with playbackRate scaled back, which keeps its pitch.
      let rate = voc.sampleRate, ratio = 1;
      if (rate < 8000) { ratio = rate / 8000; rate = 8000; }
      else if (rate > 96000) { ratio = rate / 96000; rate = 96000; }
      try {
        buf = this.ctx.createBuffer(1, voc.samples.length, rate);
        buf.getChannelData(0).set(voc.samples);
        if (ratio !== 1) this.rateFix.set(num, ratio);
      } catch (e) {
        buf = null;
      }
    }
    this.buffers.set(num, buf);
    return buf;
  }

  /** How long a sound runs, in tics, for the model's instance bookkeeping. */
  lengthTics(num) {
    const voc = this.sounds.decode(num);
    if (!voc || !voc.sampleRate) return 30;
    return Math.max(1, Math.ceil((voc.samples.length / voc.sampleRate) * 30));
  }

  play(ev) {
    if (!this.ctx) return;
    if (ev.stop !== undefined) { this.stop(ev.stop, ev.sprite); return; }
    const buf = this.#buffer(ev.num);
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    const rateFix = this.rateFix.get(ev.num) ?? 1;
    src.buffer = buf;
    src.playbackRate.value = (ev.rate || 1) * rateFix;
    src.loop = !!ev.loop;
    const gain = this.ctx.createGain();
    gain.gain.value = Math.max(0, Math.min(1, ev.gain ?? 1));
    let node = src;
    if (this.ctx.createStereoPanner) {
      const pan = this.ctx.createStereoPanner();
      pan.pan.value = Math.max(-1, Math.min(1, ev.pan ?? 0));
      src.connect(pan); node = pan;
    }
    node.connect(gain);
    gain.connect(this.master);
    src.start();
    src.spriteTag = ev.sprite;
    const set = this.voices.get(ev.num) ?? new Set();
    set.add(src);
    this.voices.set(ev.num, set);
    src.onended = () => { set.delete(src); };
  }

  stop(num, sprite = undefined) {
    const set = this.voices.get(num);
    if (!set) return;
    for (const src of [...set]) {
      if (sprite !== undefined && src.spriteTag !== sprite) continue;
      try { src.stop(); } catch { /* already ended */ }
      set.delete(src);
    }
  }

  /** Drain the model's events into voices. Call once a tic. */
  pump() {
    if (!this.ctx) { this.sounds.drain(); return; }
    for (const ev of this.sounds.drain()) this.play(ev);
  }
}
