// uDuke - the music's way out: js/music.js's renderer, in a Web Worker when
// the browser can, on the main thread otherwise.
//
// Worker (MusicOut): the worker renders blocks of BLOCK frames; the page keeps
// LEAD seconds of them queued as AudioBufferSourceNodes, start times laid end
// to end, and asks for the next block as each one arrives or ends. The main
// thread only copies and schedules — the synthesis never competes with the
// frame. A song change cuts what is queued (every node stopped) and bumps the
// generation, so blocks still on their way from the old song are dropped:
// the new one starts within a block's rendering time.
//
// Fallback (MusicOutDirect): a ScriptProcessorNode on the main thread, for a
// browser without module workers. uWolf's experience: on plain HTTP that path
// stutters under load — hence the worker first.

import { MusicRenderer } from './music.js';

export const MODULE_STAGE = 'stage12.194';

const BLOCK = 4096;          // frames per block (~85 ms at 48 kHz)
const LEAD = 0.4;            // seconds kept queued ahead of the clock
const START_GAP = 0.05;      // an empty queue starts this far ahead
// The music's level against the effects (their master is 0.8, js/audio.js):
// 0.4 is half, about -6 dB. Duke had separate music and effects volumes in
// its setup.
export const MUSIC_GAIN = 0.4;

export class MusicOut {
  /** @param {AudioContext} ctx  @param {Uint8Array} tmb  D3DTIMBR.TMB's bytes */
  constructor(ctx, tmb, { onReady, onError } = {}) {
    this.ctx = ctx;
    this.gain = ctx.createGain();
    this.gain.gain.value = MUSIC_GAIN;
    this.gain.connect(ctx.destination);
    this.gen = 0;
    this.active = false;
    this.nextTime = 0;
    this.inflight = 0;
    this.sources = new Set();
    this.worker = new Worker(new URL('./musicworker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data: m }) => {
      if (m.type === 'ready') onReady?.(m.stages);
      else if (m.type === 'error') onError?.(m.message);
      else if (m.type === 'block') {
        if (m.gen !== this.gen) return;              // from a song since stopped or changed
        this.inflight--;
        this.schedule(m.left, m.right);
        this.pump();
      }
    };
    this.worker.onerror = (e) => onError?.(e.message || 'worker failed');
    const t = tmb.slice();
    this.worker.postMessage({ type: 'init', rate: ctx.sampleRate, timbres: t.buffer }, [t.buffer]);
  }

  /** Seconds of music queued beyond the audio clock. */
  ahead() { return Math.max(0, this.nextTime - this.ctx.currentTime); }

  pump() {
    while (this.active && this.ahead() + this.inflight * BLOCK / this.ctx.sampleRate < LEAD) {
      this.worker.postMessage({ type: 'render', frames: BLOCK, gen: this.gen });
      this.inflight++;
    }
  }

  schedule(left, right) {
    const ctx = this.ctx;
    const buf = ctx.createBuffer(2, left.length, ctx.sampleRate);
    buf.copyToChannel(left, 0);
    buf.copyToChannel(right, 1);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    // Underrun (the tab slept, the thread stalled): start again a little ahead.
    if (this.nextTime < ctx.currentTime + 0.01) {
      if (this.nextTime) this.underruns = (this.underruns ?? 0) + 1;   // not the first block of a song
      this.nextTime = ctx.currentTime + START_GAP;
    }
    src.start(this.nextTime);
    this.nextTime += buf.duration;
    this.sources.add(src);
    src.onended = () => { this.sources.delete(src); this.pump(); };
  }

  /** Stop everything queued; blocks in flight are recognised as stale by the generation. */
  cut() {
    this.gen++;
    for (const s of this.sources) { s.onended = null; try { s.stop(); } catch { /* not started */ } }
    this.sources.clear();
    this.inflight = 0;
    this.nextTime = 0;
  }

  /** A MIDI file's bytes, looped. */
  play(bytes) {
    this.cut();
    const b = bytes.slice();
    this.worker.postMessage({ type: 'play', bytes: b.buffer, gen: this.gen }, [b.buffer]);
    this.active = true;
    this.pump();
  }
  stop() {
    this.cut();
    this.active = false;
    this.worker.postMessage({ type: 'stop' });
  }
  get playing() { return this.active; }
}

/** The fallback: the renderer in a ScriptProcessorNode on the main thread. */
export class MusicOutDirect {
  constructor(ctx, timbres) {
    this.ctx = ctx;
    this.renderer = new MusicRenderer(ctx.sampleRate, timbres);
    this.node = ctx.createScriptProcessor(BLOCK, 0, 2);
    this.gain = ctx.createGain();
    this.gain.gain.value = MUSIC_GAIN;
    this.node.onaudioprocess = (e) => {
      const out = e.outputBuffer;
      try { this.renderer.render(out.getChannelData(0), out.getChannelData(1)); }
      catch (err) { console.warn('uDuke music:', err.message); this.renderer.stop(); }
    };
    this.node.connect(this.gain);
    this.gain.connect(ctx.destination);
  }
  play(bytes) { this.renderer.play(bytes, true); }
  stop() { this.renderer.stop(); }
  get playing() { return this.renderer.playing; }
}
