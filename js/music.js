// uDuke - Duke's music: MIDI played on an OPL3, as Duke played it on a Sound
// Blaster.
//
// Two ports of Apogee's audiolib (James R. Dose, 1994; GPL), as EDuke32 and
// NBlood keep it (source/audiolib/src):
//   - midi.cpp, the MIDI sequencer, with Apogee's EMIDI extensions (track
//     inclusion per card, loop points, contexts) — Duke's MIDIs use them;
//   - driver_adlib.cpp (AL_MIDI.C), the General MIDI driver for AdLib-type
//     cards: 18 two-operator voices on the two halves of an OPL3, voices
//     allocated per note, the drum channel's notes as their own timbres,
//     pitch from a fine-tuned F-number table, pan through the chip's stereo
//     extension.
// The instruments are Duke's own: D3DTIMBR.TMB from the GRP, which game.c
// loadtmb() hands to MUSIC_RegisterTimbreBank — 256 timbres of 13 bytes.
//
// The C code's integer arithmetic is kept where it decides what is heard
// (volumes, pitch bend, tempo); names follow the source.

import { Opl3 } from './opl3.js';

export const MODULE_STAGE = 'stage12.195';

// --- the timbre bank (AL_RegisterTimbreBank) --------------------------------

/** D3DTIMBR.TMB: 256 x { SAVEK[2], Level[2], Env1[2], Env2[2], Wave[2], Feedback, Transpose(s8), Velocity(s8) }. */
export function parseTimbres(bytes) {
  if (!bytes || bytes.length < 256 * 13) return null;
  const bank = [];
  for (let i = 0, p = 0; i < 256; i++, p += 13) {
    bank.push({
      SAVEK: [bytes[p], bytes[p + 1]], Level: [bytes[p + 2], bytes[p + 3]],
      Env1: [bytes[p + 4], bytes[p + 5]], Env2: [bytes[p + 6], bytes[p + 7]],
      Wave: [bytes[p + 8], bytes[p + 9]], Feedback: bytes[p + 10],
      Transpose: (bytes[p + 11] << 24) >> 24, Velocity: (bytes[p + 12] << 24) >> 24,
    });
  }
  return bank;
}

// --- the AdLib driver (driver_adlib.cpp) ------------------------------------

const AL_MaxVolume = 127, AL_DefaultChannelVolume = 90, AL_DefaultPitchBendRange = 200;
const NUMADLIBVOICES = 9, NUMADLIBCHANNELS = 16;
const NOTE_ON = 0x2000, NOTE_OFF = 0x0000;
const MAX_VELOCITY = 0x7f, MAX_OCTAVE = 7, MAX_NOTE = MAX_OCTAVE * 12 + 11, FINETUNE_MAX = 31, FINETUNE_RANGE = FINETUNE_MAX + 1;
const PITCHBEND_CENTER = 1638400;
const AL_PostAmp = 3;
export const MIDI_MaxVolume = 255;
// opl3_reg.h
const OPL3_FNUM_LOW = 0xA0, OPL3_KEYON_BLOCK = 0xB0, OPL3_ATTACK_DECAY = 0x60, OPL3_SUSTAIN_RELEASE = 0x80,
  OPL3_ENABLE_WAVE_SELECT = 0x20, OPL3_WAVE_SELECT = 0xE0, OPL3_KSL_LEVEL = 0x40, OPL3_FEEDBACK_CONNECTION = 0xC0,
  OPL3_TOTAL_LEVEL_MASK = 0x3F, OPL3_KSL_MASK = 0xC0, OPL3_FEEDBACK_MASK = 0x0E, OPL3_CONNECTION_BIT = 0x01,
  OPL3_STEREO_BITS = 0x30, OPL3_KBD_SPLIT_REGISTER = 0x08, OPL3_PERCUSSION_REGISTER = 0xBD, OPL3_MODE_REGISTER = 0x05;
// midi.h
const MIDI_VOLUME = 7, MIDI_PAN = 10, MIDI_DETUNE = 94, MIDI_ALL_NOTES_OFF = 0x7b, MIDI_RESET_ALL_CONTROLLERS = 0x79,
  MIDI_RPN_MSB = 100, MIDI_RPN_LSB = 101, MIDI_DATAENTRY_MSB = 6, MIDI_DATAENTRY_LSB = 38, MIDI_PITCHBEND_MSB = 0,
  MIDI_PITCHBEND_LSB = 0, MIDI_HOLD1 = 0x40, MIDI_SOSTENUTO = 0x42, MIDI_ALL_SOUNDS_OFF = 0x78, MIDI_REVERB = 0x5b,
  MIDI_CHORUS = 0x5d, MIDI_BANK_SELECT_MSB = 0, MIDI_BANK_SELECT_LSB = 32, MIDI_MONO_MODE_ON = 0x7E;

const OctavePitch = [0x0000, 0x0400, 0x0800, 0x0C00, 0x1000, 0x1400, 0x1800, 0x1C00];
const NotePitch = [
  [0x157, 0x16b, 0x181, 0x198, 0x1b0, 0x1ca, 0x1e5, 0x202, 0x220, 0x241, 0x263, 0x287],
  [0x157, 0x16b, 0x181, 0x198, 0x1b0, 0x1ca, 0x1e5, 0x202, 0x220, 0x242, 0x264, 0x288],
  [0x158, 0x16c, 0x182, 0x199, 0x1b1, 0x1cb, 0x1e6, 0x203, 0x221, 0x243, 0x265, 0x289],
  [0x158, 0x16c, 0x183, 0x19a, 0x1b2, 0x1cc, 0x1e7, 0x204, 0x222, 0x244, 0x266, 0x28a],
  [0x159, 0x16d, 0x183, 0x19a, 0x1b3, 0x1cd, 0x1e8, 0x205, 0x223, 0x245, 0x267, 0x28b],
  [0x15a, 0x16e, 0x184, 0x19b, 0x1b3, 0x1ce, 0x1e9, 0x206, 0x224, 0x246, 0x268, 0x28c],
  [0x15a, 0x16e, 0x185, 0x19c, 0x1b4, 0x1ce, 0x1ea, 0x207, 0x225, 0x247, 0x269, 0x28e],
  [0x15b, 0x16f, 0x185, 0x19d, 0x1b5, 0x1cf, 0x1eb, 0x208, 0x226, 0x248, 0x26a, 0x28f],
  [0x15b, 0x170, 0x186, 0x19d, 0x1b6, 0x1d0, 0x1ec, 0x209, 0x227, 0x249, 0x26b, 0x290],
  [0x15c, 0x170, 0x187, 0x19e, 0x1b7, 0x1d1, 0x1ec, 0x20a, 0x228, 0x24a, 0x26d, 0x291],
  [0x15d, 0x171, 0x188, 0x19f, 0x1b7, 0x1d2, 0x1ed, 0x20b, 0x229, 0x24b, 0x26e, 0x292],
  [0x15d, 0x172, 0x188, 0x1a0, 0x1b8, 0x1d3, 0x1ee, 0x20c, 0x22a, 0x24c, 0x26f, 0x293],
  [0x15e, 0x172, 0x189, 0x1a0, 0x1b9, 0x1d4, 0x1ef, 0x20d, 0x22b, 0x24d, 0x270, 0x295],
  [0x15f, 0x173, 0x18a, 0x1a1, 0x1ba, 0x1d4, 0x1f0, 0x20e, 0x22c, 0x24e, 0x271, 0x296],
  [0x15f, 0x174, 0x18a, 0x1a2, 0x1bb, 0x1d5, 0x1f1, 0x20f, 0x22d, 0x24f, 0x272, 0x297],
  [0x160, 0x174, 0x18b, 0x1a3, 0x1bb, 0x1d6, 0x1f2, 0x210, 0x22e, 0x250, 0x273, 0x298],
  [0x161, 0x175, 0x18c, 0x1a3, 0x1bc, 0x1d7, 0x1f3, 0x211, 0x22f, 0x251, 0x274, 0x299],
  [0x161, 0x176, 0x18c, 0x1a4, 0x1bd, 0x1d8, 0x1f4, 0x212, 0x230, 0x252, 0x276, 0x29b],
  [0x162, 0x176, 0x18d, 0x1a5, 0x1be, 0x1d9, 0x1f5, 0x212, 0x231, 0x254, 0x277, 0x29c],
  [0x162, 0x177, 0x18e, 0x1a6, 0x1bf, 0x1d9, 0x1f5, 0x213, 0x232, 0x255, 0x278, 0x29d],
  [0x163, 0x178, 0x18f, 0x1a6, 0x1bf, 0x1da, 0x1f6, 0x214, 0x233, 0x256, 0x279, 0x29e],
  [0x164, 0x179, 0x18f, 0x1a7, 0x1c0, 0x1db, 0x1f7, 0x215, 0x235, 0x257, 0x27a, 0x29f],
  [0x164, 0x179, 0x190, 0x1a8, 0x1c1, 0x1dc, 0x1f8, 0x216, 0x236, 0x258, 0x27b, 0x2a1],
  [0x165, 0x17a, 0x191, 0x1a9, 0x1c2, 0x1dd, 0x1f9, 0x217, 0x237, 0x259, 0x27c, 0x2a2],
  [0x166, 0x17b, 0x192, 0x1aa, 0x1c3, 0x1de, 0x1fa, 0x218, 0x238, 0x25a, 0x27e, 0x2a3],
  [0x166, 0x17b, 0x192, 0x1aa, 0x1c3, 0x1df, 0x1fb, 0x219, 0x239, 0x25b, 0x27f, 0x2a4],
  [0x167, 0x17c, 0x193, 0x1ab, 0x1c4, 0x1e0, 0x1fc, 0x21a, 0x23a, 0x25c, 0x280, 0x2a6],
  [0x168, 0x17d, 0x194, 0x1ac, 0x1c5, 0x1e0, 0x1fd, 0x21b, 0x23b, 0x25d, 0x281, 0x2a7],
  [0x168, 0x17d, 0x194, 0x1ad, 0x1c6, 0x1e1, 0x1fe, 0x21c, 0x23c, 0x25e, 0x282, 0x2a8],
  [0x169, 0x17e, 0x195, 0x1ad, 0x1c7, 0x1e2, 0x1ff, 0x21d, 0x23d, 0x260, 0x283, 0x2a9],
  [0x16a, 0x17f, 0x196, 0x1ae, 0x1c8, 0x1e3, 0x1ff, 0x21e, 0x23e, 0x261, 0x284, 0x2ab],
  [0x16a, 0x17f, 0x197, 0x1af, 0x1c8, 0x1e4, 0x200, 0x21f, 0x23f, 0x262, 0x286, 0x2ac],
];
const slotVoice = [[0, 3], [1, 4], [2, 5], [6, 9], [7, 10], [8, 11], [12, 15], [13, 16], [14, 17]];
const offsetSlot = [0, 1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 16, 17, 18, 19, 20, 21];
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * AL_MIDI: the MIDI functions (noteOn, noteOff, controlChange, programChange,
 * pitchBend) driving an Opl3. Voice lists are arrays in the linked lists'
 * order. LL_AddToTail passes (end, start) as (head, tail) and (prev, next)
 * as (next, prev) to LL_AddNode — the two swaps cancel: it appends. So the
 * pool hands out its oldest voice (start) and takes a freed one at its end;
 * a note joins its channel's list at the end; lookups run from the start.
 */
export class AdLibMidi {
  constructor(chip, timbres) {
    this.chip = chip;
    this.bank = timbres;
    this.stereo = true;
    this.additive = false;
    this.volume = MIDI_MaxVolume;
    this.VoiceLevel = Array.from({ length: 18 }, () => [0, 0]);
    this.VoiceKsl = Array.from({ length: 18 }, () => [0, 0]);
    this.init();
  }

  init() {
    this.reset();
    this.resetVoices();
  }

  send(port, reg, data) { this.chip.writeRegBuffered((reg + ((port & 2) << 7)) & 0x1ff, data & 0xff); }
  // AL_SendOutput(voice port 0/1): port 0 is the right (0x38a), 1 the left (0x388) — as in the source.
  out(port, reg, data) { this.send(port ? 0x388 : 0x38a, reg, data); }

  reset() {
    this.send(0x388, 1, OPL3_ENABLE_WAVE_SELECT);
    this.send(0x388, OPL3_KBD_SPLIT_REGISTER, 0);
    this.send(0x388, OPL3_PERCUSSION_REGISTER, 0);
    this.send(0x38a, OPL3_MODE_REGISTER, ((this.stereo ? 1 : 0) << 1) + 1);
    this.flushCard(0x388);
    this.flushCard(0x38a);
  }
  flushCard(port) {
    for (let i = 0; i < NUMADLIBVOICES; i++) {
      const s1 = offsetSlot[slotVoice[i][0]], s2 = offsetSlot[slotVoice[i][1]];
      this.send(port, OPL3_FNUM_LOW + i, 0);
      this.send(port, OPL3_KEYON_BLOCK + i, 0);
      this.send(port, OPL3_WAVE_SELECT + s1, 0);
      this.send(port, OPL3_WAVE_SELECT + s2, 0);
      this.send(port, OPL3_ATTACK_DECAY + s1, 0xff);
      this.send(port, OPL3_ATTACK_DECAY + s2, 0xff);
      this.send(port, OPL3_SUSTAIN_RELEASE + s1, 0xff);
      this.send(port, OPL3_SUSTAIN_RELEASE + s2, 0xff);
      this.send(port, OPL3_KSL_LEVEL + s1, 0xff);
      this.send(port, OPL3_KSL_LEVEL + s2, 0xff);
    }
  }
  resetVoices() {
    this.Voice = [];
    this.pool = [];
    for (let i = 0; i < NUMADLIBVOICES * 2; i++) {
      const v = { num: i, key: 0, velocity: 0, channel: -1, timbre: -1, port: i < NUMADLIBVOICES ? 0 : 1, status: NOTE_OFF, pitchleft: 0 };
      this.Voice.push(v);
      this.pool.push(v);
    }
    this.Channel = [];
    for (let c = 0; c < NUMADLIBCHANNELS; c++) {
      this.Channel.push({ voices: [], Timbre: 0, Pitchbend: 0, KeyOffset: 0, KeyDetune: 0, Volume: AL_DefaultChannelVolume,
        Pan: 64, Detune: 0, RPN: 0, PitchBendRange: AL_DefaultPitchBendRange,
        PitchBendSemiTones: Math.trunc(AL_DefaultPitchBendRange / 100), PitchBendHundreds: AL_DefaultPitchBendRange % 100 });
    }
  }

  setVoiceTimbre(voice) {
    const V = this.Voice[voice], channel = V.channel;
    const patch = channel === 9 ? V.key + 128 : this.Channel[channel].Timbre;
    if (V.timbre === patch) return;
    V.timbre = patch;
    const t = this.bank[patch];
    const port = V.port, voc = voice >= NUMADLIBVOICES ? voice - NUMADLIBVOICES : voice;
    let slot = slotVoice[voc][0], off = offsetSlot[slot];
    this.VoiceLevel[slot][port] = OPL3_TOTAL_LEVEL_MASK - (t.Level[0] & OPL3_TOTAL_LEVEL_MASK);
    this.VoiceKsl[slot][port] = t.Level[0] & OPL3_KSL_MASK;
    this.out(port, OPL3_FNUM_LOW + voc, 0);
    this.out(port, OPL3_KEYON_BLOCK + voc, 0);
    this.out(port, OPL3_SUSTAIN_RELEASE + off, 0xff);
    this.out(port, OPL3_ATTACK_DECAY + off, t.Env1[0]);
    this.out(port, OPL3_SUSTAIN_RELEASE + off, t.Env2[0]);
    this.out(port, OPL3_ENABLE_WAVE_SELECT + off, t.SAVEK[0]);
    this.out(port, OPL3_WAVE_SELECT + off, t.Wave[0]);
    this.out(port, OPL3_KSL_LEVEL + off, t.Level[0]);
    slot = slotVoice[voc][1];
    this.out(port, OPL3_FEEDBACK_CONNECTION + voc, (t.Feedback & (OPL3_FEEDBACK_MASK | OPL3_CONNECTION_BIT)) | OPL3_STEREO_BITS);
    off = offsetSlot[slot];
    this.VoiceLevel[slot][port] = OPL3_TOTAL_LEVEL_MASK - (t.Level[1] & OPL3_TOTAL_LEVEL_MASK);
    this.VoiceKsl[slot][port] = t.Level[1] & OPL3_KSL_MASK;
    this.out(port, OPL3_KSL_LEVEL + off, OPL3_TOTAL_LEVEL_MASK);
    this.out(port, OPL3_SUSTAIN_RELEASE + off, 0xff);
    this.out(port, OPL3_ATTACK_DECAY + off, t.Env1[1]);
    this.out(port, OPL3_SUSTAIN_RELEASE + off, t.Env2[1]);
    this.out(port, OPL3_ENABLE_WAVE_SELECT + off, t.SAVEK[1]);
    this.out(port, OPL3_WAVE_SELECT + off, t.Wave[1]);
  }

  setVoiceVolume(voice) {
    const V = this.Voice[voice], channel = V.channel, t = this.bank[V.timbre];
    const velocity = Math.min(V.velocity + t.Velocity, MAX_VELOCITY);
    const voc = voice >= NUMADLIBVOICES ? voice - NUMADLIBVOICES : voice;
    const slot = slotVoice[voc][1], port = V.port;
    let t1 = (this.VoiceLevel[slot][port] * (velocity + 0x80)) >>> 0;
    t1 = (this.Channel[channel].Volume * t1) >>> 15;
    let volume = (t1 ^ OPL3_TOTAL_LEVEL_MASK) | this.VoiceKsl[slot][port];
    this.out(port, OPL3_KSL_LEVEL + offsetSlot[slot], volume);
    if (t.Feedback & 0x01) {                                       // additive
      const slot0 = slotVoice[voc][0];
      if (this.additive) t1 = (this.VoiceLevel[slot0][port] * (velocity + 0x80)) >>> 0;
      const t2 = (this.Channel[channel].Volume * t1) >>> 15;
      volume = (t2 ^ OPL3_TOTAL_LEVEL_MASK) | this.VoiceKsl[slot0][port];
      this.out(port, OPL3_KSL_LEVEL + offsetSlot[slot0], volume);
    }
  }

  setVoicePitch(voice) {
    const V = this.Voice[voice], port = V.port, channel = V.channel;
    const voc = voice >= NUMADLIBVOICES ? voice - NUMADLIBVOICES : voice;
    let note;
    if (channel === 9) note = this.bank[V.key + 128].Transpose;
    else note = V.key + this.bank[this.Channel[channel].Timbre].Transpose;
    note += this.Channel[channel].KeyOffset - 12;
    note = clamp(note, 0, MAX_NOTE);
    const detune = this.Channel[channel].KeyDetune;
    let pitch = OctavePitch[Math.trunc(note / 12)] | NotePitch[detune][note % 12];
    V.pitchleft = pitch;
    pitch |= V.status;
    this.out(port, OPL3_FNUM_LOW + voc, pitch);
    this.out(port, OPL3_KEYON_BLOCK + voc, pitch >> 8);
  }

  setVoicePan(voice) {
    const V = this.Voice[voice];
    const voc = voice >= NUMADLIBVOICES ? voice - NUMADLIBVOICES : voice;
    if (this.stereo) this.out(V.port, 0xD0 + voc, this.Channel[V.channel].Pan << 1);
  }

  getVoice(channel, key) {
    for (const v of this.Channel[channel].voices) if (v.key === key) return v.num;
    return -1;
  }

  noteOff(channel, key) {
    if (channel >= NUMADLIBCHANNELS) return;
    const voice = this.getVoice(channel, key);
    if (voice < 0) return;
    const V = this.Voice[voice];
    V.status = NOTE_OFF;
    const voc = voice >= NUMADLIBVOICES ? voice - NUMADLIBVOICES : voice;
    this.out(V.port, OPL3_KEYON_BLOCK + voc, (V.pitchleft >> 8) & 0xff);
    const list = this.Channel[channel].voices;
    list.splice(list.indexOf(V), 1);
    this.pool.push(V);
  }

  noteOn(channel, key, velocity) {
    if (channel >= NUMADLIBCHANNELS) return;
    if (velocity === 0) { this.noteOff(channel, key); return; }
    let V = this.pool.shift();
    if (!V) {
      const drums = this.Channel[9].voices;
      if (drums.length) { this.noteOff(9, drums[0].key); V = this.pool.shift(); }
      if (!V) return;
    }
    V.key = key; V.channel = channel; V.velocity = velocity; V.status = NOTE_ON;
    this.Channel[channel].voices.push(V);
    this.setVoiceTimbre(V.num);
    this.setVoiceVolume(V.num);
    this.setVoicePitch(V.num);
    this.setVoicePan(V.num);
  }

  allNotesOff(channel) {
    const list = this.Channel[channel].voices;
    while (list.length) this.noteOff(channel, list[0].key);
  }

  controlChange(channel, type, data) {
    if (channel >= NUMADLIBCHANNELS) return;
    const C = this.Channel[channel];
    switch (type) {
      case MIDI_VOLUME:
        C.Volume = clamp(data, 0, AL_MaxVolume);
        for (const v of C.voices) this.setVoiceVolume(v.num);
        break;
      case MIDI_PAN:
        if (channel !== 9) C.Pan = data;                            // drums are not panned
        for (const v of C.voices) this.setVoicePan(v.num);
        break;
      case MIDI_DETUNE: C.Detune = data; break;
      case MIDI_ALL_NOTES_OFF: this.allNotesOff(channel); break;
      case MIDI_RESET_ALL_CONTROLLERS:
        this.resetVoices();
        this.controlChange(channel, MIDI_VOLUME, AL_DefaultChannelVolume);
        this.controlChange(channel, MIDI_PAN, 64);
        this.Channel[channel].Detune = 0;
        break;
      case MIDI_RPN_MSB: C.RPN = (C.RPN & 0x00FF) | ((data & 0xFF) << 8); break;
      case MIDI_RPN_LSB: C.RPN = (C.RPN & 0xFF00) | (data & 0xFF); break;
      case MIDI_DATAENTRY_MSB:
        if (C.RPN === MIDI_PITCHBEND_MSB) { C.PitchBendSemiTones = data; C.PitchBendRange = C.PitchBendSemiTones * 100 + C.PitchBendHundreds; }
        break;
      case MIDI_DATAENTRY_LSB:
        if (C.RPN === MIDI_PITCHBEND_LSB) { C.PitchBendHundreds = data; C.PitchBendRange = C.PitchBendSemiTones * 100 + C.PitchBendHundreds; }
        break;
    }
  }

  programChange(channel, patch) { if (channel < NUMADLIBCHANNELS) this.Channel[channel].Timbre = patch; }

  /** AL_SetPitchBend: lsb + (msb << 8) — eight bits, not seven, as the source has it. */
  pitchBend(channel, lsb, msb) {
    if (channel >= NUMADLIBCHANNELS) return;
    const C = this.Channel[channel];
    const pitchbend = lsb + (msb << 8);
    const TotalBend = Math.trunc(pitchbend * C.PitchBendRange / Math.trunc(PITCHBEND_CENTER / FINETUNE_RANGE));
    C.Pitchbend = pitchbend;
    C.KeyOffset = Math.trunc(TotalBend / FINETUNE_RANGE) - C.PitchBendSemiTones;
    C.KeyDetune = TotalBend % FINETUNE_RANGE;
    for (const v of C.voices) this.setVoicePitch(v.num);
  }
}

// --- the sequencer (midi.cpp) ------------------------------------------------

const CommandLengths = [0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 2, 2, 1, 1, 2, 0];
const EMIDI_INFINITE = -1, EMIDI_END_LOOP_VALUE = 127, EMIDI_ALL_CARDS = 127;
const EMIDI_INCLUDE_TRACK = 110, EMIDI_EXCLUDE_TRACK = 111, EMIDI_PROGRAM_CHANGE = 112, EMIDI_VOLUME_CHANGE = 113,
  EMIDI_CONTEXT_START = 114, EMIDI_CONTEXT_END = 115, EMIDI_LOOP_START = 116, EMIDI_LOOP_END = 117,
  EMIDI_SONG_LOOP_START = 118, EMIDI_SONG_LOOP_END = 119, EMIDI_NUM_CONTEXTS = 7;
export const EMIDI_AdLib = 7;
const GENMIDI_DefaultVolume = 90;
const TIME_PRECISION = 16;

const newContext = () => ({ pos: -1, loopstart: -1, loopcount: 0, RunningStatus: 0, active: false, delay: 0, time: 0,
  FPSecondsPerTick: 0, tick: 0, beat: 0, measure: 0, BeatsPerMeasure: 0, TicksPerBeat: 0, TimeBase: 0 });

/**
 * One song on a set of MIDI functions (an AdLibMidi). `service()` is
 * MIDI_ServiceRoutine, called once per MIDI tick; `ticksPerSecond` is what
 * the AdLib driver's render loop runs it at (tempo * division / 60).
 */
export class MidiSong {
  constructor(bytes, funcs, { loop = true, cardType = EMIDI_AdLib } = {}) {
    const b = bytes;
    const n32 = (p) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
    const n16 = (p) => (b[p] << 8) | b[p + 1];
    if (String.fromCharCode(b[0], b[1], b[2], b[3]) !== 'MThd') throw new Error('MIDI: no MThd');
    const headersize = n32(4);
    const format = n16(8);
    const numTracks = n16(10);
    let division = n16(12);
    if (division & 0x8000) division = 96;                          // SMPTE: 96, as the source
    if (format > 1) throw new Error(`MIDI: format ${format}`);
    if (!numTracks) throw new Error('MIDI: no tracks');
    this.b = b; this.funcs = funcs; this.loop = loop; this.cardType = cardType;
    this.division = division;
    this.tracks = [];
    let p = 8 + headersize;
    for (let i = 0; i < numTracks; i++) {
      if (String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]) !== 'MTrk') throw new Error('MIDI: bad track');
      const len = n32(p + 4);
      p += 8;
      this.tracks.push({ start: p, end: p + len, pos: p, delay: 0, active: false, RunningStatus: 0, currentcontext: 0,
        context: Array.from({ length: EMIDI_NUM_CONTEXTS }, newContext),
        EMIDI_IncludeTrack: false, EMIDI_ProgramChange: false, EMIDI_VolumeChange: false });
      p += len;
    }
    this.channelVolume = new Array(16).fill(GENMIDI_DefaultVolume);
    this.initEMIDI();
    this.resetTracks();
    this.tempo = 120; this.ticksPerSecond = 0; this.FPSecondsPerTick = 0;
    this.active = true;
    // MIDI_PlaySong then: MIDI_Reset (unless a stop just did it), the driver's
    // StartPlayback (AL_Init: chip and voices reset), MIDI_SetTempo(120). The
    // renderer runs that order.
  }

  byte(T) { return T.pos < this.b.length ? this.b[T.pos++] : 0; }
  readDelta(T) {
    let value = this.byte(T);
    if (value & 0x80) {
      value &= 0x7f;
      let c;
      do { c = this.byte(T); value = (value << 7) + (c & 0x7f); } while (c & 0x80);
    }
    return value;
  }
  resetTracks() {
    this.Tick = 0; this.Beat = 1; this.Measure = 1; this.Time = 0;
    this.BeatsPerMeasure = 4; this.TicksPerBeat = this.division; this.TimeBase = 4;
    this.ActiveTracks = 0; this.Context = 0;
    for (const T of this.tracks) {
      T.pos = T.start;
      T.delay = this.readDelta(T);
      T.active = T.EMIDI_IncludeTrack;
      T.RunningStatus = 0;
      T.currentcontext = 0;
      T.context[0].loopstart = T.start;
      T.context[0].loopcount = 0;
      if (T.active) this.ActiveTracks++;
    }
  }
  advanceTick() {
    this.Time += this.FPSecondsPerTick;
    this.Tick++;
    while (this.Tick > this.TicksPerBeat) { this.Tick -= this.TicksPerBeat; this.Beat++; }
    while (this.Beat > this.BeatsPerMeasure) { this.Beat -= this.BeatsPerMeasure; this.Measure++; }
  }
  sysEx(T) { const len = this.readDelta(T); T.pos += len; }
  metaEvent(T) {
    const command = this.byte(T);
    const length = this.byte(T);                                    // one byte, as the source reads it
    switch (command) {
      case 0x2F:                                                    // end of track
        T.active = false;
        this.ActiveTracks--;
        break;
      case 0x51: {                                                  // tempo: whole beats per minute
        const us = (this.b[T.pos] << 16) | (this.b[T.pos + 1] << 8) | this.b[T.pos + 2];
        this.setTempo(Math.trunc(60000000 / us));
        break;
      }
      case 0x58: {                                                  // time signature
        if (this.Tick > 0 || this.Beat > 1) this.Measure++;
        this.Tick = 0; this.Beat = 1; this.TimeBase = 1;
        this.BeatsPerMeasure = this.b[T.pos];
        let den = this.b[T.pos + 1];
        while (den > 0) { this.TimeBase += this.TimeBase; den--; }
        this.TicksPerBeat = Math.trunc(this.division * 4 / this.TimeBase);
        break;
      }
    }
    T.pos += length;
  }
  setTempo(tempo) {
    this.tempo = tempo;
    this.onTempo?.();                                               // AdLibDrv_MIDI_SetTempo zeroes the render timer
    this.ticksPerSecond = tempo * this.division / 60;               // MV_MIDIRenderTempo (integer in C)
    const tps = Math.trunc(tempo * this.division / 60);
    this.FPSecondsPerTick = tps ? Math.trunc((1 << TIME_PRECISION) / tps) : 0;
  }

  setChannelVolume(channel, volume) {
    this.channelVolume[channel] = volume;
    // The AdLib driver has SetVolume: the channel volume goes through as is.
    this.funcs.controlChange(channel, MIDI_VOLUME, volume);
  }
  midiReset() {
    for (let ch = 0; ch < 16; ch++) {
      this.funcs.controlChange(ch, MIDI_HOLD1, 0);
      this.funcs.controlChange(ch, MIDI_SOSTENUTO, 0);
      this.funcs.controlChange(ch, MIDI_ALL_NOTES_OFF, 0);
      this.funcs.controlChange(ch, MIDI_ALL_SOUNDS_OFF, 0);
    }
    for (let ch = 0; ch < 16; ch++) {
      this.funcs.controlChange(ch, MIDI_RESET_ALL_CONTROLLERS, 0);
      this.funcs.controlChange(ch, MIDI_RPN_MSB, MIDI_PITCHBEND_MSB);
      this.funcs.controlChange(ch, MIDI_RPN_LSB, MIDI_PITCHBEND_LSB);
      this.funcs.controlChange(ch, MIDI_DATAENTRY_MSB, 2);
      this.funcs.controlChange(ch, MIDI_DATAENTRY_LSB, 0);
      this.channelVolume[ch] = GENMIDI_DefaultVolume;
      this.funcs.controlChange(ch, MIDI_PAN, 64);
      this.funcs.controlChange(ch, MIDI_REVERB, 40);
      this.funcs.controlChange(ch, MIDI_CHORUS, 0);
      this.funcs.controlChange(ch, MIDI_BANK_SELECT_MSB, 0);
      this.funcs.controlChange(ch, MIDI_BANK_SELECT_LSB, 0);
      this.funcs.programChange(ch, 0);
    }
    for (let ch = 0; ch < 16; ch++) this.setChannelVolume(ch, this.channelVolume[ch]);
  }

  saveContext(ctx, T) {
    ctx.RunningStatus = T.RunningStatus; ctx.time = this.Time; ctx.FPSecondsPerTick = this.FPSecondsPerTick;
    ctx.tick = this.Tick; ctx.beat = this.Beat; ctx.measure = this.Measure; ctx.BeatsPerMeasure = this.BeatsPerMeasure;
    ctx.TicksPerBeat = this.TicksPerBeat; ctx.TimeBase = this.TimeBase;
  }
  restoreTime(ctx) {
    this.Time = ctx.time; this.FPSecondsPerTick = ctx.FPSecondsPerTick; this.Tick = ctx.tick; this.Beat = ctx.beat;
    this.Measure = ctx.measure; this.BeatsPerMeasure = ctx.BeatsPerMeasure; this.TicksPerBeat = ctx.TicksPerBeat;
    this.TimeBase = ctx.TimeBase;
  }

  /** _MIDI_InitEMIDI: a dry run over every track, deciding inclusion and noting loop points. */
  initEMIDI() {
    const type = this.cardType;
    const affects = (c) => c === EMIDI_ALL_CARDS || c === type;
    this.resetTracks();
    for (const T of this.tracks) {
      this.Tick = 0; this.Beat = 1; this.Measure = 1; this.Time = 0; this.BeatsPerMeasure = 4;
      this.TicksPerBeat = this.division; this.TimeBase = 4; this.ActiveTracks = 0; this.Context = -1;
      T.RunningStatus = 0; T.active = true;
      T.EMIDI_ProgramChange = false; T.EMIDI_VolumeChange = false; T.EMIDI_IncludeTrack = true;
      T.context = Array.from({ length: EMIDI_NUM_CONTEXTS }, newContext);
      while (T.delay > 0) { this.advanceTick(); T.delay--; }
      let includeFound = false;
      while (T.active && T.pos < T.end) {
        let event = this.byte(T);
        if ((event >> 4) === 0xF) {
          if (event === 0xF0 || event === 0xF7) this.sysEx(T);
          else if (event === 0xFF) this.metaEvent(T);
          if (T.active) { T.delay = this.readDelta(T); while (T.delay > 0) { this.advanceTick(); T.delay--; } }
          continue;
        }
        if (event & 0x80) T.RunningStatus = event; else { event = T.RunningStatus; T.pos--; }
        const command = event >> 4;
        let length = CommandLengths[command];
        if (command === 0xB) {
          if (this.b[T.pos] === MIDI_MONO_MODE_ON) length++;
          const c1 = this.byte(T), c2 = this.byte(T);
          length -= 2;
          const C0 = T.context[0];
          switch (c1) {
            case EMIDI_LOOP_START:
            case EMIDI_SONG_LOOP_START:
              C0.loopcount = c2 === 0 ? EMIDI_INFINITE : c2;
              C0.pos = T.pos; C0.loopstart = T.pos;
              this.saveContext(C0, T);
              break;
            case EMIDI_LOOP_END:
            case EMIDI_SONG_LOOP_END:
              if (c2 === EMIDI_END_LOOP_VALUE) { C0.loopstart = -1; C0.loopcount = 0; }
              break;
            case EMIDI_INCLUDE_TRACK:
              if (affects(c2)) { includeFound = true; T.EMIDI_IncludeTrack = true; }
              else if (!includeFound) { includeFound = true; T.EMIDI_IncludeTrack = false; }
              break;
            case EMIDI_EXCLUDE_TRACK:
              if (affects(c2)) T.EMIDI_IncludeTrack = false;
              break;
            case EMIDI_PROGRAM_CHANGE: T.EMIDI_ProgramChange = true; break;
            case EMIDI_VOLUME_CHANGE: T.EMIDI_VolumeChange = true; break;
            case EMIDI_CONTEXT_START:
              if (c2 > 0 && c2 < EMIDI_NUM_CONTEXTS) {
                const C = T.context[c2];
                C.pos = T.pos; C.loopstart = C0.loopstart; C.loopcount = C0.loopcount;
                this.saveContext(C, T);
              }
              break;
          }
        }
        T.pos += length;
        T.delay = this.readDelta(T);
        while (T.delay > 0) { this.advanceTick(); T.delay--; }
      }
    }
    this.resetTracks();
  }

  interpretController(T, TimeSet, channel, c1, c2) {
    switch (c1) {
      case MIDI_MONO_MODE_ON: T.pos++; break;
      case MIDI_VOLUME: if (!T.EMIDI_VolumeChange) this.setChannelVolume(channel, c2); break;
      case EMIDI_INCLUDE_TRACK: case EMIDI_EXCLUDE_TRACK: break;
      case EMIDI_PROGRAM_CHANGE: if (T.EMIDI_ProgramChange) this.funcs.programChange(channel, c2 & 0x7f); break;
      case EMIDI_VOLUME_CHANGE: if (T.EMIDI_VolumeChange) this.setChannelVolume(channel, c2); break;
      case EMIDI_CONTEXT_START: break;
      case EMIDI_CONTEXT_END: {
        const ctx = this.Context;
        if (T.currentcontext === ctx || ctx < 0 || T.context[ctx].pos < 0) break;
        T.currentcontext = ctx;
        T.context[0].loopstart = T.context[ctx].loopstart;
        T.context[0].loopcount = T.context[ctx].loopcount;
        T.pos = T.context[ctx].pos;
        T.RunningStatus = T.context[ctx].RunningStatus;
        if (TimeSet) break;
        this.restoreTime(T.context[ctx]);
        TimeSet = true;
        break;
      }
      case EMIDI_LOOP_START:
      case EMIDI_SONG_LOOP_START: {
        const loopcount = c2 === 0 ? EMIDI_INFINITE : c2;
        const list = c1 === EMIDI_SONG_LOOP_START ? this.tracks : [T];
        for (const tr of list) {
          const C0 = tr.context[0];
          C0.loopcount = loopcount; C0.pos = tr.pos; C0.loopstart = tr.pos;
          C0.active = tr.active; C0.delay = tr.delay;
          this.saveContext(C0, tr);
        }
        break;
      }
      case EMIDI_LOOP_END:
      case EMIDI_SONG_LOOP_END: {
        if (c2 !== EMIDI_END_LOOP_VALUE || T.context[0].loopstart < 0 || T.context[0].loopcount === 0) break;
        let list;
        if (c1 === EMIDI_SONG_LOOP_END) { list = this.tracks; this.ActiveTracks = 0; }
        else { list = [T]; this.ActiveTracks--; }
        for (const tr of list) {
          const C0 = tr.context[0];
          if (C0.loopcount !== EMIDI_INFINITE) C0.loopcount--;
          tr.pos = C0.loopstart; tr.RunningStatus = C0.RunningStatus; tr.delay = C0.delay; tr.active = C0.active;
          if (tr.active) this.ActiveTracks++;
          if (!TimeSet) { this.restoreTime(C0); TimeSet = true; }
        }
        break;
      }
      default: this.funcs.controlChange(channel, c1, c2);
    }
    return TimeSet;
  }

  /** MIDI_ServiceRoutine: one MIDI tick. */
  service() {
    if (!this.active) return;
    let TimeSet = false;
    for (let tracknum = 0; tracknum < this.tracks.length; tracknum++) {
      const T = this.tracks[tracknum];
      while (T.active && T.delay === 0) {
        let event = this.byte(T);
        if ((event >> 4) === 0xF) {
          if (event === 0xF0 || event === 0xF7) this.sysEx(T);
          else if (event === 0xFF) this.metaEvent(T);
          if (T.active) T.delay = this.readDelta(T);
          continue;
        }
        if (event & 0x80) T.RunningStatus = event; else { event = T.RunningStatus; T.pos--; }
        const channel = event & 0xf, command = event >> 4;
        let c1 = 0, c2 = 0;
        if (CommandLengths[command] > 0) { c1 = this.byte(T); if (CommandLengths[command] > 1) c2 = this.byte(T); }
        switch (command) {
          case 0x8: this.funcs.noteOff(channel, c1, c2); break;
          case 0x9: this.funcs.noteOn(channel, c1, c2); break;
          case 0xB: TimeSet = this.interpretController(T, TimeSet, channel, c1, c2); break;
          case 0xC: if (!T.EMIDI_ProgramChange) this.funcs.programChange(channel, c1 & 0x7f); break;
          case 0xE: this.funcs.pitchBend(channel, c1, c2); break;
          default: break;
        }
        T.delay = this.readDelta(T);
      }
      T.delay--;
      if (this.ActiveTracks === 0) {
        this.resetTracks();
        if (this.loop) tracknum = -1;
        else { this.active = false; break; }
      }
    }
    this.advanceTick();
  }
}

// --- the renderer (AdLibDrv_MIDI_Service) --------------------------------------

// `clamp(buf * AL_PostAmp * AL_Volume * (1.f / MIDI_MaxVolume), INT16_MIN, INT16_MAX)`
// in single precision, as the C computes it, then stored as int16 (truncated).
const INV_MAX = Math.fround(1 / MIDI_MaxVolume);
function post(sample, volume) {
  const f = Math.fround(Math.fround(Math.fround(sample * AL_PostAmp) * volume) * INV_MAX);
  return f < -32768 ? -32768 : f > 32767 ? 32767 : Math.trunc(f);
}

/**
 * Chip, driver and song, rendering at `rate`: for every output sample the
 * MIDI timer advances by the tempo (ticks a second) and runs a tick each time
 * it passes the mix rate; the chip's resampled output times AL_PostAmp and
 * the music volume. `render(left, right)` fills two Float32Arrays.
 */
export class MusicRenderer {
  constructor(rate, timbres) {
    this.rate = rate;
    this.chip = new Opl3(rate);
    this.driver = new AdLibMidi(this.chip, timbres);
    this.song = null;
    this.timer = 0;
    this.volume = MIDI_MaxVolume;
    this.buf = [0, 0];
    this.hooked = false;
    this.resetDone = false;
  }
  /** MIDI_PlaySong, in its order. Throws on a file it cannot read (nothing changes then). */
  play(bytes, loop = true) {
    const song = new MidiSong(bytes, this.driver, { loop });
    if (this.song) this.stop();
    if (!this.resetDone) song.midiReset();
    this.resetDone = false;
    this.chip.reset(this.rate);                                     // AdLibDrv_MIDI_StartPlayback: AL_Init
    this.driver.init();
    this.hooked = true;
    this.song = song;
    song.onTempo = () => { this.timer = 0; };
    song.setTempo(120);
  }
  /** MIDI_StopSong: the music routine unhooked (silence), then MIDI_Reset through the driver. */
  stop() {
    if (!this.song) return;
    this.hooked = false;
    this.song.active = false;
    this.song.midiReset();
    this.resetDone = true;
    this.song = null;
  }
  get playing() { return !!this.song?.active; }
  render(left, right) {
    const n = left.length, rate = this.rate, buf = this.buf;
    if (!this.hooked) { left.fill(0); right.fill(0); return; }
    for (let i = 0; i < n; i++) {
      // MV_MIDIRenderTempo >= 0 once the song has set its tempo.
      const song = this.song, tempo = Math.trunc(song.ticksPerSecond);
      while (this.timer >= rate) { if (tempo >= 0) song.service(); this.timer -= rate; }
      if (tempo >= 0) this.timer += Math.trunc(song.ticksPerSecond);
      this.chip.generateResampled(buf);
      left[i] = post(buf[0], this.volume) / 32768;
      right[i] = post(buf[1], this.volume) / 32768;
    }
  }
}

// --- which song ------------------------------------------------------------

/**
 * premap.c enterlevel: music_select = volume*11 + level, music_fn[volume][level]
 * — USER.CON's `music <volume> ...` lists (defs.music, 0-based). The level's
 * slot comes from definelevelname by its file, or from an E<v>L<l> name.
 */
export function levelMusic(defs, file) {
  const up = String(file).toUpperCase();
  let k;
  for (const [key, lv] of defs?.levels ?? []) if (lv?.file?.toUpperCase() === up) { k = key; break; }
  if (k === undefined) {
    const m = /^E(\d)L(\d+)\.MAP$/.exec(up);
    if (m) k = (Number(m[1]) - 1) * 11 + Number(m[2]) - 1;
  }
  if (k === undefined) return null;
  return defs?.music?.[Math.floor(k / 11)]?.[k % 11] ?? null;
}
/** game.c Logo(): env_music_fn[0], the title's song (`music 0 ...`, first). */
export const titleMusic = (defs) => defs?.envMusic?.[0] ?? null;
