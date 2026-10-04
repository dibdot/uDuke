// uDuke - the music in a Web Worker: sequencer, AdLib driver and OPL3 off the
// page's main thread, where the renderer draws.
//
// A worker needs no secure context (an AudioWorklet does, and the router
// serves plain HTTP). The page asks for blocks; each comes back as two
// transferred Float32Arrays, tagged with the generation of the request, so
// blocks of a song that has since been stopped or changed are dropped there.
//
// Messages in:  { type: 'init', rate, timbres }  { type: 'play', bytes, gen }
//               { type: 'stop' }                  { type: 'render', frames, gen }
// Messages out: { type: 'ready', stages }         { type: 'block', gen, left, right }
//               { type: 'error', message }

import { MusicRenderer, parseTimbres, MODULE_STAGE as MUSIC_STAGE } from './music.js';
import { MODULE_STAGE as OPL3_STAGE } from './opl3.js';

export const MODULE_STAGE = 'stage12.194';

let renderer = null;
self.onmessage = ({ data: m }) => {
  try {
    switch (m.type) {
      case 'init':
        renderer = new MusicRenderer(m.rate, parseTimbres(new Uint8Array(m.timbres)));
        // The page's cache tripwire cannot see a worker's imports: they report here.
        self.postMessage({ type: 'ready', stages: { musicworker: MODULE_STAGE, music: MUSIC_STAGE, opl3: OPL3_STAGE } });
        break;
      case 'play': renderer.play(new Uint8Array(m.bytes), true); break;
      case 'stop': renderer.stop(); break;
      case 'render': {
        const left = new Float32Array(m.frames), right = new Float32Array(m.frames);
        renderer.render(left, right);
        self.postMessage({ type: 'block', gen: m.gen, left, right }, [left.buffer, right.buffer]);
        break;
      }
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};
