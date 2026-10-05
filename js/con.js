// Cache tripwire: every module carries the stage it shipped with, and boot.js
// refuses to run a mix. A browser that re-fetched one file and kept another
// from its cache showed up as 'HEALTH undefined' — a field the stale
// player.js did not have. That is the third stale-cache report; this makes
// the fourth say which file.
export const MODULE_STAGE = 'stage12.196';

// uDuke - CON: the tokenizer, the compiler and the interpreter, from gamedef.c.
import { krand } from './effector.js';
import { TICS_PER_FRAME, LOTAG_MASK, nearTag, isNearOperator } from './sector.js';
import { clipMove, getZRange, pushMove, CLIPMASK0, bumpSprites } from './clip.js';
import { updateSector, inside } from './geometry.js';
import { findDistance2D, findDistance3D } from './effector.js';
import { getZsOfSlope } from './map.js';
import { addAmmo, addWeapon, GET } from './player.js';
//
// CON is Duke's game-logic language: three files in the GRP (GAME.CON pulls in
// USER.CON and DEFS.CON with `include`), 10699 lines in the shipped game, and
// two subsystems in the source — a compiler (parsecommand, ~1100 lines) that
// turns the text into a bytecode array, and an interpreter (parse, ~1080) that
// runs it per actor per tic.
//
// This file is the first of those, and only its bottom half: the character
// rules and the three readers everything else is built from. It is separated
// out because it is the part that can be checked against the real files
// exhaustively — every token in the shipped CON has to come out as a keyword, a
// defined label, or a number, and anything else is a bug here rather than an
// opinion about the language.

/**
 * `keyw[NUMKEYWORDS]` — all 112, in order. The INDEX is the opcode: transword
 * writes it straight into the script, so the order of this array is part of the
 * bytecode format and not a detail.
 */
export const KEYWORDS = [
  'definelevelname', 'actor', 'addammo', 'ifrnd',
  'enda', 'ifcansee', 'ifhitweapon', 'action',
  'ifpdistl', 'ifpdistg', 'else', 'strength',
  'break', 'shoot', 'palfrom', 'sound',
  'fall', 'state', 'ends', 'define',
  '//', 'ifai', 'killit', 'addweapon',
  'ai', 'addphealth', 'ifdead', 'ifsquished',
  'sizeto', '{', '}', 'spawn',
  'move', 'ifwasweapon', 'ifaction', 'ifactioncount',
  'resetactioncount', 'debris', 'pstomp', '/*',
  'cstat', 'ifmove', 'resetplayer', 'ifonwater',
  'ifinwater', 'ifcanshoottarget', 'ifcount', 'resetcount',
  'addinventory', 'ifactornotstayput', 'hitradius', 'ifp',
  'count', 'ifactor', 'music', 'include',
  'ifstrength', 'definesound', 'guts', 'ifspawnedby',
  'gamestartup', 'wackplayer', 'ifgapzl', 'ifhitspace',
  'ifoutside', 'ifmultiplayer', 'operate', 'ifinspace',
  'debug', 'endofgame', 'ifbulletnear', 'ifrespawn',
  'iffloordistl', 'ifceilingdistl', 'spritepal', 'ifpinventory',
  'betaname', 'cactor', 'ifphealthl', 'definequote',
  'quote', 'ifinouterspace', 'ifnotmoving', 'respawnhitag',
  'tip', 'ifspritepal', 'money', 'soundonce',
  'addkills', 'stopsound', 'ifawayfromwall', 'ifcanseetarget',
  'globalsound', 'lotsofglass', 'ifgotweaponce', 'getlastpal',
  'pkick', 'mikesnd', 'useractor', 'sizeat',
  'addstrength', 'cstator', 'mail', 'paper',
  'tossweapon', 'sleeptime', 'nullop', 'definevolumename',
  'defineskillname', 'ifnosounds', 'clipdist', 'ifangdiffl'
];

/**
 * `ispecial()` — what ends a token, and the only place line numbers advance.
 *
 * Note what is NOT here: a tab. gamedef.c tests for 0x0a, ' ' and 0x0d only, so
 * a tab is an ordinary token character as far as this function is concerned —
 * and `getlabel` below reads until ispecial, which means a tab-indented label
 * would swallow its indentation. The shipped files use spaces.
 */
export function isSpecial(c) {
  return c === 0x0a || c === 0x20 || c === 0x0d;
}

/**
 * `isaltok()` — what a keyword or number token is made of.
 *
 * Alphanumeric plus `{ } / * - _ .` — the braces and slashes are in here so
 * that `{`, `}`, `//` and `/*` come through as tokens rather than being
 * skipped, which is how the compiler sees block structure and comments at all.
 */
export function isAlTok(c) {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)
    || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x2a
    || c === 0x2d || c === 0x5f || c === 0x2e;
}

/**
 * The compiler's cursor over one CON text, with the line counter gamedef.c
 * keeps in a global.
 *
 * Duke walks a char* and mutates globals; this keeps the same state on an
 * object so several files can be compiled without a reset step being forgotten.
 * `text` is bytes, not a string: CON is not UTF-8 and a stray high byte in a
 * comment must not become a replacement character halfway through a token.
 */
export class ConText {
  constructor(bytes, name = '<con>') {
    this.text = bytes;
    this.name = name;
    this.at = 0;
    this.line = 1;
  }

  get done() { return this.at >= this.text.length; }
  peekByte() { return this.at < this.text.length ? this.text[this.at] : 0; }

  /** The token at the cursor without consuming it — gamedef.c's keyword(). */
  peek() {
    let p = this.at;
    while (p < this.text.length && !isAlTok(this.text[p])) p++;
    let s = '';
    while (p < this.text.length && isAlTok(this.text[p])) s += String.fromCharCode(this.text[p++]);
    return s;
  }

  /** Consume and return the next token, advancing the line count on the way. */
  token() {
    while (this.at < this.text.length && !isAlTok(this.text[this.at])) {
      if (this.text[this.at] === 0x0a) this.line++;
      this.at++;
    }
    let s = '';
    while (this.at < this.text.length && isAlTok(this.text[this.at])) {
      s += String.fromCharCode(this.text[this.at++]);
    }
    return s;
  }

  /**
   * `getlabel()` — a NAME, and it does not use the same rules as a token.
   *
   * It skips to the next alphanumeric and then reads until `ispecial`, so a
   * label may contain `{`, `/`, `,` or anything else that is not a space or a
   * newline. Reading it with the token rules instead would split
   * `MYNAME{` into two and quietly change what a define is called.
   */
  label() {
    while (this.at < this.text.length && !isAlnum(this.text[this.at])) {
      if (this.text[this.at] === 0x0a) this.line++;
      this.at++;
    }
    let s = '';
    while (this.at < this.text.length && !isSpecial(this.text[this.at])) {
      s += String.fromCharCode(this.text[this.at++]);
    }
    return s;
  }
}

function isAlnum(c) {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}

/** Opcode for a keyword, or -1 — gamedef.c compares against the whole table. */
export function opcodeOf(word) {
  return KEYWORDS.indexOf(word);
}

// ---------------------------------------------------------------------------
// The compiler: gamedef.c's parsecommand(), lines 446..1495.
// ---------------------------------------------------------------------------

/** Opcodes by name, so the switch below can be read against the source. */
const OP = Object.fromEntries(KEYWORDS.map((k, i) => [k, i]));

/** The keywords that take exactly one number and nothing else. */
const ONE_NUM = new Set([
  OP.strength, OP.shoot, OP.addphealth, OP.spawn, OP.cstat, OP.count, OP.endofgame,
  OP.spritepal, OP.cactor, OP.quote, OP.money, OP.addkills, OP.debug, OP.addstrength,
  OP.cstator, OP.mail, OP.paper, OP.sleeptime, OP.clipdist,
  OP.sound, OP.globalsound, OP.soundonce, OP.stopsound, OP.lotsofglass,
]);
/** Two numbers. */
const TWO_NUM = new Set([
  OP.addammo, OP.addweapon, OP.sizeto, OP.sizeat, OP.debris, OP.addinventory, OP.guts,
]);
/** No arguments at all. */
const NO_ARG = new Set([
  OP.break, OP.fall, OP.tip, OP.killit, OP.resetactioncount, OP.pstomp, OP.resetplayer,
  OP.resetcount, OP.wackplayer, OP.operate, OP.respawnhitag, OP.getlastpal, OP.pkick,
  OP.mikesnd, OP.tossweapon, OP.nullop,
]);
/** Conditionals with one number, then a body. */
const IF_ONE = new Set([
  OP.ifrnd, OP.ifpdistl, OP.ifpdistg, OP.ifai, OP.ifwasweapon, OP.ifaction,
  OP.ifactioncount, OP.ifmove, OP.ifcount, OP.ifactor, OP.ifstrength, OP.ifspawnedby,
  OP.ifgapzl, OP.iffloordistl, OP.ifceilingdistl, OP.ifphealthl, OP.ifspritepal,
  OP.ifgotweaponce, OP.ifangdiffl,
]);
/** Conditionals with no number, then a body. */
const IF_ZERO = new Set([
  OP.ifonwater, OP.ifinwater, OP.ifactornotstayput, OP.ifcansee, OP.ifhitweapon,
  OP.ifsquished, OP.ifdead, OP.ifcanshoottarget, OP.ifp, OP.ifhitspace, OP.ifoutside,
  OP.ifmultiplayer, OP.ifinspace, OP.ifbulletnear, OP.ifrespawn, OP.ifinouterspace,
  OP.ifnotmoving, OP.ifawayfromwall, OP.ifcanseetarget, OP.ifnosounds,
]);

/**
 * Compile Duke's CON into the bytecode `execute()` runs.
 *
 * One instance per game. `includes(name)` returns the bytes of an included
 * file, or null — GAME.CON pulls USER.CON and DEFS.CON in that way, and the
 * compiler cannot know where files live.
 *
 * What comes out:
 *
 *   script      Int32Array of opcodes, numbers and ADDRESSES. Where gamedef.c
 *               stores a pointer into script[], this stores the index; every
 *               consumer is here too, so the choice is free and the index is
 *               easier to read in a dump.
 *   actorScr    picnum -> index of that actor's 4-word header; execute()
 *               starts at header + 4.
 *   actorType   picnum -> the type word from `useractor`.
 *   labels      name -> value, for defines; -> address, for states, moves,
 *               actions and ais. ONE table for all of them, as in the source:
 *               `define FOO 5` and `state FOO` share a namespace, and the
 *               first definition of a name wins with a warning for the second.
 *   defs        everything the compiler fills that is not bytecode — level
 *               names and par times, volume and skill names, quotes, sounds,
 *               music, the gamestartup block.
 *   errors, warnings   with line numbers, as printed by the original.
 *
 * Structure is kept as close to the C as a reading allows: one `command()`
 * per call, the same retractions of the opcode (`scriptptr--`) where the source
 * has them, and the same fall-throughs, because the bytecode has to come out
 * the same for the interpreter to be checkable against the source later.
 */
export class ConCompiler {
  constructor(includes = () => null) {
    this.includes = includes;
    this.script = new Int32Array(1 << 17);
    // `scriptptr = script+1` — word 0 is reserved and never written by a
    // command. It is not a formality: parsing_actor and actorscrptr[] are
    // pointers in C and are tested against 0 for "none", so an actor header at
    // offset 0 would read as no actor at all. With the index standing in for
    // the pointer the same test needs the same guarantee, and the first actor
    // in a file DID land at 0 before this line existed.
    this.ptr = 1;
    this.labels = new Map();
    this.actorScr = new Map();
    this.actorType = new Map();
    this.errors = [];
    this.warnings = [];
    this.defs = {
      levels: new Map(), volumes: [], skills: [], quotes: [], sounds: new Map(),
      music: [], envMusic: [], betaName: null, gamestartup: null, conVersion: 13,
    };
    // gamedef.c's globals, per compiler instance.
    this.parsingActor = 0;      // index of the actor header, or 0
    this.parsingState = false;
    this.braces = 0;
    this.checkingIfelse = 0;
    this.t = null;              // the current ConText
  }

  // --- emission -----------------------------------------------------------

  emit(v) {
    if (this.ptr >= this.script.length) {
      const bigger = new Int32Array(this.script.length * 2);
      bigger.set(this.script);
      this.script = bigger;
    }
    this.script[this.ptr++] = v | 0;
  }

  error(msg) { this.errors.push(`${this.t.name} L${this.t.line}: ${msg}`); }
  warn(msg) { this.warnings.push(`${this.t.name} L${this.t.line}: ${msg}`); }

  /** transword(): consume a token; emit its opcode and return it, or -1. */
  word() {
    const tok = this.t.token();
    if (tok === '') return -1;
    const op = opcodeOf(tok);
    if (op >= 0) { this.emit(op); return op; }
    // gamedef.c's diagnostics, kept because the specific one is the useful one.
    if (tok[0] === '{' && tok.length > 1) this.error(`Expecting a SPACE or CR between '{' and '${tok.slice(1)}'.`);
    else if (tok[0] === '}' && tok.length > 1) this.error(`Expecting a SPACE or CR between '}' and '${tok.slice(1)}'.`);
    else if (tok.startsWith('//') && tok.length > 2) this.error(`Expecting a SPACE between '//' and '${tok.slice(2)}'.`);
    else if (tok.startsWith('/*') && tok.length > 2) this.error(`Expecting a SPACE between '/*' and '${tok.slice(2)}'.`);
    else if (tok.startsWith('*/') && tok.length > 2) this.error(`Expecting a SPACE between '*/' and '${tok.slice(2)}'.`);
    else this.error(`Expecting key word, but found '${tok}'.`);
    return -1;
  }

  /**
   * transnum(): consume a token that must be a number or a defined label;
   * emit its value. Numbers go through atol, so `12abc` is 12 and `-` alone is
   * 0 — reproduced, because the shipped files are not the only files.
   */
  num() {
    const tok = this.t.token();
    if (tok === '') return;
    if (this.labels.has(tok)) { this.emit(this.labels.get(tok)); return; }
    const c = tok.charCodeAt(0);
    if (!(c >= 0x30 && c <= 0x39) && tok[0] !== '-') {
      this.error(`Parameter '${tok}' is undefined.`);
      return;
    }
    this.emit(parseInt(tok, 10) || 0);
  }

  /** Peek: is the next token a keyword? -1 if not, its opcode if so. */
  peekOp() { return opcodeOf(this.t.peek()); }

  /**
   * The shared prologue of every definition keyword: read a name, refuse a
   * keyword, warn on a duplicate. Returns the name, or null on error, and
   * whether it was new.
   */
  defineLabel(kind) {
    const name = this.t.label();
    if (opcodeOf(name) >= 0) {
      this.error(`Symbol '${name}' is a key word.`);
      return { name: null, isNew: false };
    }
    if (this.labels.has(name)) {
      this.warn(`Duplicate ${kind} '${name}' ignored.`);
      return { name, isNew: false };
    }
    return { name, isNew: true };
  }

  /** Up to `n` numbers, stopping at a keyword; the rest padded with zeroes. */
  numsPadded(n) {
    let j = 0;
    for (; j < n; j++) {
      if (this.peekOp() >= 0) break;
      this.num();
    }
    for (; j < n; j++) this.emit(0);
  }

  /** Numbers until a keyword, OR-ed together into one word. */
  orList() {
    let acc = 0;
    while (this.peekOp() === -1 && this.t.peek() !== '') {
      this.num();
      acc |= this.script[--this.ptr];
    }
    this.emit(acc);
  }

  /** Raw text to the end of the line, as the definition keywords read it. */
  restOfLine() {
    const b = this.t.text;
    let s = '';
    while (this.t.at < b.length && b[this.t.at] === 0x20) this.t.at++;
    while (this.t.at < b.length && b[this.t.at] !== 0x0a) s += String.fromCharCode(b[this.t.at++]);
    return s.replace(/\r$/, '');
  }

  /** Raw text to the next space, for filenames. */
  wordToSpace() {
    const b = this.t.text;
    let s = '';
    while (this.t.at < b.length && b[this.t.at] === 0x20) this.t.at++;
    while (this.t.at < b.length && b[this.t.at] !== 0x20 && b[this.t.at] !== 0x0a) {
      s += String.fromCharCode(b[this.t.at++]);
    }
    return s;
  }

  // --- the switch ----------------------------------------------------------

  /**
   * parsecommand(): one command. Returns true when this level of parsing is
   * finished — at end of text, after too many errors, or at a `}`.
   */
  command() {
    const t = this.t;
    if (this.errors.length > 12 || t.done || t.at + 1 >= t.text.length) return true;
    const tw = this.word();

    switch (tw) {
      case -1:
        return false;
      // No `default:` here, on purpose. gamedef.c lists every opcode as a case
      // and its default is unreachable; the grouped keywords below the switch
      // are this file's way of writing the same thing, and a default that
      // returned would swallow them — `ifrnd` came back without reading its
      // number, and the number was then read as a keyword. That was the first
      // compile of the shipped file, and it stopped at line 140.
      default:
        break;

      case OP['/*']: {
        this.ptr--;
        const from = t.line;
        const b = t.text;
        for (;;) {
          t.at++;
          if (t.at >= b.length) { this.error(`Found '/*' with no '*/'. (opened at L${from})`); return false; }
          if (b[t.at] === 0x0a) t.line++;
          if (b[t.at] === 0x2a && b[t.at + 1] === 0x2f) break;
        }
        t.at += 2;
        return false;
      }

      case OP['//']:
        this.ptr--;
        while (t.at < t.text.length && t.text[t.at] !== 0x0a) t.at++;
        return false;

      case OP.state: {
        if (!this.parsingActor && !this.parsingState) {
          // A definition: the name labels the address the body starts at.
          const name = t.label();
          this.ptr--;
          this.labels.set(name, this.ptr);
          this.parsingState = true;
          return false;
        }
        // A call: emit the state's address.
        const name = t.label();
        if (opcodeOf(name) >= 0) { this.error(`Symbol '${name}' is a key word.`); return false; }
        if (this.labels.has(name)) this.emit(this.labels.get(name));
        else { this.error(`State '${name}' not found.`); this.emit(0); }
        return false;
      }

      case OP.ends:
        if (!this.parsingState) this.error("Found 'ends' with no 'state'.");
        if (this.braces > 0) this.error("Found more '{' than '}' before 'ends'.");
        if (this.braces < 0) this.error("Found more '}' than '{' before 'ends'.");
        this.parsingState = false;
        return false;

      case OP.define: {
        const { name, isNew } = this.defineLabel('definition');
        if (name === null) return false;
        this.num();
        if (isNew) this.labels.set(name, this.script[this.ptr - 1]);
        this.ptr -= 2;
        return false;
      }

      case OP.palfrom:
        this.numsPadded(4);
        return false;

      case OP.move:
        if (this.parsingActor || this.parsingState) {
          this.num();
          this.orList();
        } else {
          this.ptr--;
          const { name, isNew } = this.defineLabel('move');
          if (name === null) return false;
          if (isNew) this.labels.set(name, this.ptr);
          this.numsPadded(2);
        }
        return false;

      case OP.music: {
        this.ptr--;
        this.num();
        const vol = this.script[--this.ptr] - 1;
        const list = vol >= 0 ? (this.defs.music[vol] = []) : this.defs.envMusic;
        while (this.peekOp() === -1 && t.peek() !== '') {
          list.push(t.token());
          if (list.length > 10) break;
        }
        return false;
      }

      case OP.include: {
        this.ptr--;
        const name = t.token();
        const bytes = this.includes(name);
        if (!bytes) { this.error(`Could not find '${name}'.`); return false; }
        const saved = { t: this.t, ifelse: this.checkingIfelse };
        this.t = new ConText(bytes, name);
        this.checkingIfelse = 0;
        while (!this.command()) { /* the included file, to its end */ }
        this.t = saved.t;
        this.checkingIfelse = saved.ifelse;
        return false;
      }

      case OP.ai:
        if (this.parsingActor || this.parsingState) {
          this.num();
        } else {
          this.ptr--;
          const { name, isNew } = this.defineLabel('ai');
          if (name === null) return false;
          if (isNew) this.labels.set(name, this.ptr);
          // Up to three words; the third is an OR-list of move flags.
          let j = 0;
          for (; j < 3; j++) {
            if (this.peekOp() >= 0) break;
            if (j === 2) { this.orList(); return false; }
            this.num();
          }
          for (; j < 3; j++) this.emit(0);
        }
        return false;

      case OP.action:
        if (this.parsingActor || this.parsingState) {
          this.num();
        } else {
          this.ptr--;
          const { name, isNew } = this.defineLabel('action');
          if (name === null) return false;
          if (isNew) this.labels.set(name, this.ptr);
          this.numsPadded(5);
        }
        return false;

      case OP.actor:
      case OP.useractor: {
        if (this.parsingState) this.error(`Found '${KEYWORDS[tw]}' within 'state'.`);
        if (this.parsingActor) this.error(`Found '${KEYWORDS[tw]}' within 'actor'.`);
        this.braces = 0;
        this.ptr--;
        const header = this.ptr;
        this.parsingActor = header;

        let type = 0;
        if (tw === OP.useractor) { this.num(); type = this.script[--this.ptr]; }
        this.num();
        const picnum = this.script[--this.ptr];
        this.actorScr.set(picnum, header);
        if (tw === OP.useractor) this.actorType.set(picnum, type);

        // Four words: strength, action, move, and an OR-list of move flags.
        // A keyword arriving early leaves the rest zero and skips over them.
        for (let j = 0; j < 4; j++) this.script[header + j] = 0;
        let j = 0;
        for (; j < 3; j++) {
          if (this.peekOp() >= 0) { this.ptr = header + 4; break; }
          this.num();
        }
        if (j === 3) this.orList();
        this.checkingIfelse = 0;
        return false;
      }

      case OP.else:
        if (this.checkingIfelse) {
          this.checkingIfelse--;
          const slot = this.ptr++;
          this.command();
          this.script[slot] = this.ptr;
        } else {
          this.ptr--;
          this.error("Found 'else' with no 'if'.");
        }
        return false;

      case OP['{']:
        this.braces++;
        while (!this.command()) { /* to the matching brace */ }
        return false;

      case OP['}']:
        this.braces--;
        if (this.braces < 0) this.error("Found more '}' than '{'.");
        return true;

      case OP.betaname:
        this.ptr--;
        this.defs.betaName = this.restOfLine();
        return false;

      case OP.definevolumename:
      case OP.defineskillname: {
        this.ptr--;
        this.num();
        const idx = this.script[--this.ptr];
        const text = this.restOfLine().toUpperCase();
        if (text.length > 32) this.error(`${tw === OP.definevolumename ? 'Volume' : 'Skill'} name exceeds character size limit of 32.`);
        (tw === OP.definevolumename ? this.defs.volumes : this.defs.skills)[idx] = text;
        return false;
      }

      case OP.definelevelname: {
        this.ptr--;
        this.num();
        const vol = this.script[--this.ptr];
        this.num();
        const lev = this.script[--this.ptr];
        const file = this.wordToSpace();
        const time = () => {
          const s = this.wordToSpace();
          // "MM:SS", read as two digit pairs at fixed offsets, in 26ths.
          const mm = (s.charCodeAt(0) - 48) * 10 + (s.charCodeAt(1) - 48);
          const ss = (s.charCodeAt(3) - 48) * 10 + (s.charCodeAt(4) - 48);
          return mm * 26 * 60 + ss * 26;
        };
        const par = time();
        const designer = time();
        const name = this.restOfLine().toUpperCase();
        this.defs.levels.set(vol * 11 + lev, { file, par, designer, name });
        return false;
      }

      case OP.definequote: {
        this.ptr--;
        this.num();
        const k = this.script[--this.ptr];
        const text = this.restOfLine();
        if (text.length > 64) this.error('Quote exceeds character size limit of 64.');
        this.defs.quotes[k] = text;
        return false;
      }

      case OP.definesound: {
        this.ptr--;
        this.num();
        const k = this.script[--this.ptr];
        const file = this.wordToSpace();
        const v = [];
        for (let j = 0; j < 5; j++) { this.num(); v.push(this.script[--this.ptr]); }
        this.defs.sounds.set(k, { file, ps: v[0], pe: v[1], pr: v[2], m: v[3], vo: v[4] });
        return false;
      }

      case OP.enda:
        if (!this.parsingActor) this.error("Found 'enda' without defining 'actor'.");
        if (this.braces > 0) this.error("Found more '{' than '}' before 'enda'.");
        this.parsingActor = 0;
        return false;

      case OP.gamestartup: {
        this.ptr--;
        // 26 values in a 1.3d file, 30 in 1.4/1.5. gamedef.c decides after the
        // 26th: if a keyword follows, the block is over.
        const p = [];
        for (let j = 0; j < 30; j++) {
          this.num();
          p.push(this.script[--this.ptr]);
          if (j === 25) {
            if (this.peekOp() !== -1) break;
            this.defs.conVersion = 15;
          }
        }
        this.defs.gamestartup = p;
        return false;
      }

      case OP.hitradius:
        for (let j = 0; j < 5; j++) this.num();
        return false;
    }

    // The groups, after the individually written cases so the individual ones
    // win when a keyword is in both.
    if (ONE_NUM.has(tw)) { this.num(); return false; }
    if (TWO_NUM.has(tw)) { this.num(); this.num(); return false; }
    if (NO_ARG.has(tw)) return false;

    if (tw === OP.ifpinventory || IF_ONE.has(tw) || IF_ZERO.has(tw)) {
      if (tw === OP.ifpinventory) { this.num(); this.num(); }
      else if (IF_ONE.has(tw)) this.num();
      if (tw === OP.ifp) {
        // `ifp` takes an OR-list, read with do..while: at least one.
        let acc = 0;
        do { this.num(); acc |= this.script[--this.ptr]; } while (this.peekOp() === -1 && t.peek() !== '');
        this.emit(acc);
      }
      const slot = this.ptr++;             // the fail address, filled in below
      // Comments between the condition and its body are stepped over.
      let j;
      do {
        j = this.peekOp();
        if (j === OP['//'] || j === OP['/*']) this.command();
      } while (j === OP['//'] || j === OP['/*']);
      this.command();
      this.script[slot] = this.ptr;
      this.checkingIfelse++;
      return false;
    }

    return false;
  }

  /** Compile one file (and whatever it includes). */
  compile(bytes, name = 'GAME.CON') {
    this.t = new ConText(bytes, name);
    while (!this.command()) { /* to the end */ }
    return this;
  }

  /** The script trimmed to what was written. */
  get bytecode() { return this.script.subarray(0, this.ptr); }

  /**
   * The line loadefs() prints: `Code Size:N bytes(M labels)`.
   *
   * N is `((scriptptr-script)<<2)-4`: the reserved word 0 counted and then
   * taken off again, which is `(ptr-1)*4` here. Every source port prints this line at
   * start-up, which makes it the one number a compile can be checked against
   * without running Duke.
   */
  report() {
    return `Code Size:${(this.ptr - 1) * 4} bytes(${this.labels.size} labels)`;
  }
}

// ---------------------------------------------------------------------------
// The interpreter: gamedef.c's parse() and execute(), lines 2031..3315.
// ---------------------------------------------------------------------------

/**
 * `#define random_angle 8` — the one move flag the interpreter itself reads.
 * The rest (seekplayer, furthestdir, faceplayer, ...) belong to move().
 */
export const RANDOM_ANGLE = 8;

/** `#define rnd(X) ((TRAND>>8)>=(255-(X)))` — a 0..255 chance, not a percent. */
export function rnd(fx, x) {
  return (krand(fx) >> 8) >= (255 - x);
}

/**
 * How many script words follow each opcode, so the interpreter can step over
 * a command it does not implement without losing its place. Derived from the
 * compiler above, which is the only place that knows.
 */
const ARGS = new Int8Array(KEYWORDS.length).fill(0);
for (const op of ONE_NUM) ARGS[op] = 1;
for (const op of TWO_NUM) ARGS[op] = 2;
for (const op of IF_ONE) ARGS[op] = 1;
ARGS[OP.ifpinventory] = 2;
ARGS[OP.ifp] = 1;
ARGS[OP.hitradius] = 5;
ARGS[OP.palfrom] = 4;
ARGS[OP.move] = 2;
ARGS[OP.action] = 1;
ARGS[OP.ai] = 1;
ARGS[OP.state] = 1;
ARGS[OP.else] = 1;
/** Steps one actor may take in one tic before it is declared lost. */
export const STEP_LIMIT = 100000;

/** Keywords whose opcode never survives into the script. */
const COMPILE_ONLY = new Set([
  OP.definelevelname, OP.define, OP.include, OP.music, OP.definesound, OP.definequote,
  OP.betaname, OP.definevolumename, OP.defineskillname, OP.gamestartup,
  OP['//'], OP['/*'], OP.actor, OP.useractor,
]);
const IS_IF = new Uint8Array(KEYWORDS.length);
for (const op of IF_ONE) IS_IF[op] = 1;
for (const op of IF_ZERO) IS_IF[op] = 1;
IS_IF[OP.ifpinventory] = 1;

/**
 * Run compiled CON against an actor, one tic at a time.
 *
 * This is parse()/execute() with one deliberate difference: an opcode this
 * file does not implement is stepped over and COUNTED, where gamedef.c's
 * `default:` kills the actor. Killing on unknown is right for a finished
 * interpreter meeting a corrupt script; it is wrong for a partial one meeting
 * a correct script, where it would erase every actor that ever calls `shoot`.
 * An unimplemented `if` takes its else branch — an unknown condition is not
 * true — and that choice is written down here so the passivity it produces is
 * recognised as a stand-in and not mistaken for behaviour.
 *
 * State per actor is Duke's: the six-word temp_data the effectors already
 * share (`fx.temp(i)`), with the interpreter's meaning for each slot —
 *
 *   t[0] count        t[1] move address   t[2] action count
 *   t[3] action frame t[4] action address t[5] ai address
 *
 * — plus `extra` (strength) and `hitag` (move flags) on the sprite itself,
 * which is where spawn() puts them.
 *
 * Not here yet: move(), the actor movement that execute() runs after the
 * script; every command that reaches into the player, weapons, sounds or
 * other sprites; and the sleep bookkeeping. All counted when met.
 */
export class ConVM {
  constructor(compiled, fx) {
    this.script = compiled.script;
    this.actorScr = compiled.actorScr;
    this.actorType = compiled.actorType;
    this.labels = compiled.labels;
    this.fx = fx;
    this.skipped = new Map();        // opcode -> times stepped over
    this.skippedArgs = new Map();    // 'spawn 1226' -> times, for one-arg commands
    this.stubbed = new Map();        // named stand-ins in move()/alterang, by use
    this.derailed = 0;               // times the pointer left the program
    // hittype[] fields the body keeps per sprite.
    this.floorZ = new Map();
    this.ceilingZ = new Map();
    this.bposZ = new Map();
    this.lastV = new Map();          // where ifcansee last saw the player
    this.stayPut = new Map();        // actorstayput: the sector a useractor&2 is bound to
    this.movFlag = new Map();        // hittype.movflag: movesprite's last report
    this.timeToSleep = new Map();    // hittype.timetosleep
    this.asleep = new Set();         // statnum 2: dozing until movefta wakes them
    this.stat = new Map();           // statnum of sprites this file created (4, 5)
    this.spawnUnhandled = new Map(); // picnum -> spawns that got no shape
    this.shootUnhandled = new Map(); // picnum -> shots this file cannot fire yet
    this.playerHits = new Map();     // picnum -> projectiles that reached the player
    this.playerHit = { picNum: -1, extra: 0, ang: 0, owner: -1 };   // hittype[player]: filed damage
    this.hitExtra = new Map();       // hittype[i].extra: damage filed on an actor, -1 = none
    this.hitPic = new Map();         // hittype[i].picnum after a hit: what hit it
    this.hitAng = new Map();         // hittype[i].ang: the weapon's angle
    this.hitOwner = new Map();       // hittype[i].owner: who fired
    this.lastHitSprite = -1;         // hitasprite's sprite, for ifcanshoottarget's kin check
    this.lastVx = new Map();         // hittype[i].lastvx: a trip bomb's beam length
    this.sounds = null;              // a SoundSystem, when the page has one
    this.operateSector = null;       // (sectNum) => operatesectors(), for `operate`; the page supplies it
    this.kills = 0;                  // actors_killed
    this.spawnedBy = new Map();      // hittype.picnum: who spawned this sprite
    this.radarang = null;            // set by the caller; getangle needs it
    this.art = null;                 // for movesprite's height
    this.skill = 2;                  // ud.player_skill: 1 Piece of Cake .. 4 Damn I'm Good; game.c 7131 defaults to 2, Let's Rock
    // The globals parse() reads: set by execute() for the actor in hand.
    this.i = -1; this.sp = null; this.t = null; this.x = 0; this.map = null;
    this.player = null;
    this.pstate = null;              // player.js state: onGround, jumpCounter, zVel
    this.holoduke = -1;              // ps->holoduke_on: the hologram sprite, else -1
    this.camSprite = -1;             // camsprite: the VIEWSCREEN showing its camera's picture, else -1
    this.restoreTile = null;         // loadtile(): the page's hook to put a monitor's own picture back
    this.pinput = null;              // the crouch and run keys this tic
    this.ip = 0;
    this.killit = false;
  }

  /** Does this picnum have a script at all? execute() returns at once if not. */
  hasScript(picnum) { return this.actorScr.has(picnum); }

  /**
   * spawn()'s seeding from the four-word header:
   *
   *   s->extra = header[0];  T5 = header[1];  T2 = header[2];  s->hitag = header[3];
   *   T1 = T3 = T4 = T6 = 0;
   */
  spawnActor(spr, i, map = this.map, fromSprite = false) {
    this.map = map;
    // game.c: `case APLAYER: xrepeat = yrepeat = 0; changespritestat(i, 5)`
    // in single player — a start mark, invisible, no script. Left as an
    // actor, every mark in the map ran the PLAYER's script with 100 health:
    // a blast near one reached `ifdead`, and the page showed PRESS SPACE TO
    // RESTART LEVEL while the player stood at full health.
    if (spr.picNum === T.APLAYER && (fromSprite || (this.playerSprite !== undefined && this.playerSprite >= 0))) {
      spr.xRepeat = 0; spr.yRepeat = 0;
      spr.cstat |= 32768;
      this.stat.set(i, STAT.MISC);
      return false;
    }
    // game.c 3637: before the tile switch, a map sprite that is wall- or
    // floor-aligned (cstat&48), not a switch, not one of a few tiles, and
    // CARRIES A HITAG is a FALLER: statnum 12, solid with the hitscan bit,
    // strength impact_damage — scenery that drops when an explosion of its
    // hitag's chain uses it up. The tile's own case is never reached: E1L1's
    // vent fan (FANSPRITE, hitag 253) is one, and vanishes with the tanks.
    // spawn() 3502, the same head, for a wall SWITCH (wallswitchcheck and
    // cstat&16): a palette other than 0 marks it multiplayer-only — in a
    // single-player game (or co-op) it is sized 0 and stripped of cstat,
    // lotag and hitag, gone for good; the access switches keep their pal
    // (it is the card colour). A kept switch gets cstat 257 and pal 0.
    if (!fromSprite && (spr.cstat & 48) && spr.shade !== 127 && !FALLER_EXEMPT.has(spr.picNum)
        && !(spr.picNum >= 546 && spr.picNum <= 549)
        && this.isSwitchTile && (this.isSwitchTile(spr.picNum) || spr.picNum === 1155 || spr.picNum === 1156) && (spr.cstat & 16)) {   // wallswitchcheck lists HANDPRINTSWITCH(+1) too — decor here, never operable (checkhitswitch has no case), but the pal rule applies
      const access = spr.picNum === 130 || spr.picNum === 170;   // ACCESSSWITCH, ACCESSSWITCH2
      if (!access && spr.pal) {
        spr.xRepeat = 0; spr.yRepeat = 0;
        spr.cstat = 0; spr.lotag = 0; spr.hitag = 0;
        this.stat.set(i, STAT.MISC);
        return false;
      }
      spr.cstat |= 257;
      if (spr.pal && !access) spr.pal = 0;
      return false;
    }
    if (!fromSprite && (spr.cstat & 48) && spr.hitag !== 0
        && !FALLER_EXEMPT.has(spr.picNum) && !(spr.picNum >= 546 && spr.picNum <= 549)
        && spr.shade !== 127 && !(this.isSwitchTile && this.isSwitchTile(spr.picNum) && (spr.cstat & 16))) {
      spr.cstat |= 257;
      spr.extra = this.impactDamage ?? 5;
      this.fx.temp(i).fill(0);
      this.stat.set(i, STAT.FALLER);
      return false;
    }
    // spawn()'s head for a map sprite, game.c 3637..3683, past the three
    // returns above (shade 127, wall switch, faller): `if (CS&1) CS |= 256`
    // for every sprite, then T1..T6 cleared and, for a scripted tile, the
    // CON header — SH (strength), T5, T2 and the flags into a hitag still 0.
    // Only then the tile's own case. The cases no longer clear T1..T6
    // themselves. spawnHead also runs, from boot, for the map sprites that
    // never come here.
    if (!fromSprite) {
      if (spawnHead(spr)) { this.stat.set(i, 0); return false; }
      // game.c 4194: a BLIMP (a CON actor) is solid and hittable, clipdist 128.
      if (spr.picNum === 3400) { spr.cstat |= 257; spr.clipDist = 128; }
      const th = this.fx.temp(i);
      th.fill(0);
      const hh = this.actorScr.get(spr.picNum);
      if (hh !== undefined) {
        spr.extra = this.script[hh];
        th[4] = this.script[hh + 1];
        th[1] = this.script[hh + 2];
        if (this.script[hh + 3] && spr.hitag === 0) spr.hitag = this.script[hh + 3];
      }
    }
    // premap.c 1215 resetpspritevars: the level's FIRST APLAYER is the
    // player's own sprite — 42x36, clipdist 64, its own owner, full health,
    // an actor running the APLAYER script (PSTAND, PWALKING...) — and it is
    // invisible in the player's own view; the mirror pass shows it. Duke
    // gives it cstat 257; here 32768 alone, so the player's own shots and
    // clipmove never meet it (Duke fends those off case by case). The other
    // APLAYER sprites are co-op starts: hidden, misc.
    if (!fromSprite && spr.picNum === 1405) {
      if (this.playerSprite === undefined || this.playerSprite < 0) {
        this.playerSprite = i;
        spr.xRepeat = 42; spr.yRepeat = 36; spr.cstat = 32768; spr.clipDist = 64; spr.owner = i;
        spr.extra = this.maxPlayerHealth ?? 100;
        this.fx.temp(i).fill(0);
        const hh = this.actorScr.get(1405);
        if (hh !== undefined) { this.fx.temp(i)[4] = this.script[hh + 1]; this.fx.temp(i)[1] = this.script[hh + 2]; }
        this.stat.set(i, STAT.ACTOR);
      } else {
        spr.xRepeat = 0; spr.yRepeat = 0; spr.cstat = 32768;
        this.stat.set(i, STAT.MISC);
      }
      return false;
    }
    // game.c 4206: MIKE carries its song in its hitag; spawn copies it to
    // yvel, which the CON's `mikesnd` plays (E3L1's karaoke bar: hitag 238).
    if (spr.picNum === 762) spr.yVel = spr.hitag;
    // game.c 4471 / 4809: WATERBUBBLEMAKER is invisible; FLOORFLAME burns at
    // shade -127 (and game.c 6033 draws it so). Both are CON actors run from
    // movestandables — here, with no statnum filed, from moveActors.
    if (spr.picNum === 662) spr.cstat |= 32768;
    if (spr.picNum === 2333) spr.shade = -127;
    // game.c 4674: REACTOR/REACTOR2 — strength impact_damage, hittable;
    // with a pal (a multiplayer-only one) hidden; else pal 0, shade -17, a
    // zombie (statnum 2) until movefta wakes it; then moveReactor.
    if (spr.picNum === REACTOR || spr.picNum === REACTOR2) {
      spr.extra = this.impactDamage ?? 5;
      spr.cstat |= 257;
      if (spr.pal !== 0) { spr.xRepeat = 0; spr.yRepeat = 0; this.stat.set(i, STAT.MISC); return false; }
      spr.shade = -17;
      this.stat.set(i, STAT.ZOMBIE);
      this.asleep.add(i);
      return false;
    }
    // game.c 4443: a placed TRASH — any angle, 24x24, a standable.
    if (!fromSprite && spr.picNum === TRASH) {
      spr.ang = krand(this.fx) & 2047;
      spr.xRepeat = spr.yRepeat = 24;
      this.stat.set(i, STAT.STANDABLE);
      return false;
    }
    // game.c 4676: RECON — the patrol vehicle: skill and palette rules as
    // for any monster, strength 130, hittable, t[5] = 0 (the locator to
    // restart the round at), an actor moved in C (moveRecon).
    if (!fromSprite && spr.picNum === T.RECON) {
      if (spr.lotag > this.skill || spr.pal !== 0) { spr.xRepeat = 0; spr.yRepeat = 0; this.stat.set(i, STAT.MISC); return false; }
      spr.extra = 130;
      spr.cstat |= 257;
      this.stat.set(i, STAT.ACTOR);
      this.maxKills = (this.maxKills ?? 0) + 1;
      return false;
    }
    // game.c 4161: QUEBALL/STRIPEBALL — a pool ball: hittable, not blocking
    // (cstat 256), clipdist 8, a zombie (statnum 2) until movefta sees it,
    // then moved in C (movePoolBall). POCKET is plain decoration; the balls
    // look for it themselves.
    if (!fromSprite && (spr.picNum === T.QUEBALL || spr.picNum === T.STRIPEBALL)) {
      spr.cstat = 256;
      spr.clipDist = 8;
      this.stat.set(i, STAT.ACTOR);
      this.asleep.add(i);
      return false;
    }
    // game.c: NUKEBUTTON..+3 — a misc sprite; moveexplosions runs its press.
    if (!fromSprite && spr.picNum >= T.NUKEBUTTON && spr.picNum <= T.NUKEBUTTON + 3) {
      this.stat.set(i, STAT.MISC);
      return false;
    }
    // game.c 4823: CAMERA1..+4 and CAMERAPOLE — strength 1, solid with the
    // hitscan bit only when the CON's CAMERASDESTRUCTABLE says so (the
    // shipped USER.CON says NO), else not even blocking. The camera is an
    // actor moved in C (moveCamera); the pole is a plain misc sprite.
    if (!fromSprite && ((spr.picNum >= T.CAMERA1 && spr.picNum <= T.CAMERA1 + 4) || spr.picNum === T.CAMERAPOLE)) {
      spr.extra = 1;
      spr.cstat = this.camerasHitable ? 257 : 0;
      spr.yVel = 0;
      this.stat.set(i, spr.picNum === T.CAMERAPOLE ? STAT.MISC : STAT.ACTOR);
      return false;
    }
    // game.c 3969: a map-placed TRIPBOMB — over the skill it is sized 0 and
    // misc; else 4x5, its own owner and hitag, stepped 16 along its angle
    // (ssp), T1 = 17 (the arming count, past the player-distance gate), T6
    // its angle, and a ZOMBIE until movefta sees it — then a standable.
    if (!fromSprite && spr.picNum === T.TRIPBOMB) {
      // Strength and cstat|256 from spawnHead above.
      if (spr.lotag > this.skill) { spr.xRepeat = 0; spr.yRepeat = 0; this.stat.set(i, STAT.MISC); return false; }
      spr.xRepeat = 4; spr.yRepeat = 5;
      spr.owner = i;
      spr.hitag = i;
      spr.xVel = 16;
      moveSprite(this, map, i, (spr.xVel * bsin(spr.ang + 512)) >> 14, (spr.xVel * bsin(spr.ang)) >> 14, 0);
      const t = this.fx.temp(i);
      t[0] = 17; t[2] = 0; t[5] = spr.ang;            // T2, T5 from the header stay
      this.stat.set(i, STAT.ZOMBIE);
      this.asleep.add(i);
      return false;
    }
    // game.c 4280: a RESPAWN (tile 9) — extra 66-13, invisible (cstat 32768),
    // statnum 11 (movefx). It waits for operaterespawns(lotag): then a
    // TRANSPORTERSTAR and thirteen tics later `spawn(i, hitag)` — a monster
    // closet's pigs, an item that arrives.
    if (!fromSprite && spr.picNum === 9) {
      spr.extra = 66 - 13;
      spr.cstat = 32768;
      this.stat.set(i, STAT.STANDABLE);
      return false;
    }
    // game.c 4814: a BOUNCEMINE — its own owner, cstat |= 257 (hittable),
    // 24x24, shade -127, strength impact_damage<<2, and a ZOMBIE: it moves
    // (moveHeavyBomb, the mine way) once movefta sees it.
    if (!fromSprite && spr.picNum === 940) {
      spr.owner = i;
      spr.cstat |= 257;
      spr.xRepeat = spr.yRepeat = 24;
      spr.shade = -127;
      spr.extra = (this.impactDamage ?? 5) << 2;
      // game.c 3634: hittype floorz/ceilingz start as the sector's — the
      // mine hangs between them; movesprite's z test needs them.
      { const sec = map.sectors[spr.sectNum]; if (sec) { this.floorZ.set(i, sec.floorZ); this.ceilingZ.set(i, sec.ceilingZ); } }
      this.stat.set(i, STAT.ZOMBIE);
      this.asleep.add(i);
      return false;
    }
    // game.c 4379: a CRANE. cstat |= 64|257, the picture two frames on
    // (CRANE+2, the hook down), hung 48<<8 under the sector's ceiling. Its
    // rest position and z are remembered; the CRANEPOLE with the same hitag
    // marks the pick-up spot: that spot is remembered too, the pole itself
    // is made 48x128 and moved under the crane (it is the cable), and the
    // pole's sector is the one the crane watches (T2). owner -1, extra 8,
    // a standable.
    if (!fromSprite && spr.picNum === 1222) {
      spr.cstat |= 64 | 257;
      spr.picNum += 2;
      spr.z = (map.sectors[spr.sectNum]?.ceilingZ ?? spr.z) + (48 << 8);
      const d = { ox: spr.x, oy: spr.y, oz: spr.z, px: spr.x, py: spr.y, pole: -1 };
      const t = this.fx.temp(i);
      for (let k = 0; k < map.sprites.length; k++) {
        const q = map.sprites[k];
        if (q.removed || q.picNum !== 1221 || q.hitag !== spr.hitag) continue;
        d.pole = k;
        t[1] = q.sectNum;
        q.xRepeat = 48; q.yRepeat = 128;
        d.px = q.x; d.py = q.y;
        q.x = spr.x; q.y = spr.y; q.z = spr.z; q.shade = spr.shade;
        q.sectNum = spr.sectNum;
        break;
      }
      if (!this.cranes) this.cranes = new Map();
      this.cranes.set(i, d);
      spr.owner = -1;
      spr.extra = 8;
      this.stat.set(i, STAT.STANDABLE);
      return false;
    }
    // game.c 4423: a map-placed WATERDRIP — 4<<8 lower, T1 its home z, T2 a
    // random first wait (0..127), size 24, a standable. It falls, lands,
    // vanishes, waits, and is put back home because its owner is itself.
    if (!fromSprite && spr.picNum === T.WATERDRIP) {
      spr.z += 4 << 8;
      const t = this.fx.temp(i);
      t[0] = spr.z;
      t[1] = krand(this.fx) & 127;
      spr.xRepeat = 24;
      spr.yRepeat = 24;
      spr.owner = i;
      this.stat.set(i, STAT.STANDABLE);
      return false;
    }
    // game.c 4441: MUSICANDSFX — invisible (cstat 32768); its own statnum
    // 11 in Duke, a standable here so moveStandables ticks it. A pal-1 one
    // is multiplayer-only and sized 0.
    if (!fromSprite && spr.picNum === 5) {
      if (spr.pal === 1) { spr.xRepeat = 0; spr.yRepeat = 0; this.stat.set(i, STAT.MISC); return false; }
      spr.cstat = 32768;
      this.stat.set(i, STAT.STANDABLE);
      return false;
    }
    // game.c 4475: BOLT1..+3 / SIDEBOLT1..+3 — the electric arc: T1/T2
    // keep its mapped size (it flickers to 0 and back), a standable.
    if (!fromSprite && ((spr.picNum >= T.BOLT1 && spr.picNum <= T.BOLT1 + 3) || (spr.picNum >= T.SIDEBOLT1 && spr.picNum <= T.SIDEBOLT1 + 3))) {
      const t = this.fx.temp(i);
      t[0] = spr.xRepeat;
      t[1] = spr.yRepeat;
      this.stat.set(i, STAT.STANDABLE);
      return false;
    }
    // game.c 3773: NEON1..6 — solid with the hitscan bit, a misc sprite;
    // moveexplosions flickers it.
    if (!fromSprite && [T.NEON1, T.NEON2, T.NEON3, T.NEON4, T.NEON5, T.NEON6].includes(spr.picNum)) {
      spr.cstat |= 257;
      this.stat.set(i, STAT.MISC);
      return false;
    }
    // game.c 4234: VIEWSCREEN/VIEWSCREEN2 — its own owner, lotag 1, strength
    // 1, a standable. The monitor a camera is watched on.
    if (!fromSprite && (spr.picNum === T.VIEWSCREEN || spr.picNum === T.VIEWSCREEN2)) {
      spr.owner = i;
      spr.lotag = 1;
      spr.extra = 1;
      this.stat.set(i, STAT.STANDABLE);
      return false;
    }
    // game.c 4796: WATERFOUNTAIN — lotag 1 (neartag only reports a tagged
    // sprite) and then the flammables' block: solid with the hitscan bit,
    // strength 1, a standable. Its drinking is C (moveWaterFountain).
    if (!fromSprite && spr.picNum === T.WATERFOUNTAIN) {
      spr.lotag = 1;
      spr.cstat |= 257;
      spr.extra = 1;
      spr.owner = i;
      this.stat.set(i, STAT.STANDABLE);
      return false;
    }
    // game.c 4799: TREE1/TREE2/TIRE/CONE/BOX — the flammables: solid with
    // the hitscan bit, strength 1, standables. No script; before the lookup.
    if (!fromSprite && AFLAMABLE.has(spr.picNum)) {
      spr.cstat = 257;
      spr.extra = 1;
      this.stat.set(i, STAT.STANDABLE);
      return false;
    }
    // game.c 5321: CRACK1..4 — a wall crack: blocking wall sprite (cstat
    // |= 17), strength 1, its own owner, a standable, stepped 8 off its
    // wall. Only an explosive hit sets it off (moveCrack).
    if (!fromSprite && (spr.picNum === T.FIREEXT || (spr.picNum >= 546 && spr.picNum <= 549))) {
      if (spr.picNum === T.FIREEXT) { spr.cstat = 257; spr.extra = (this.impactDamage ?? 5) << 2; }
      else { spr.cstat |= 17; spr.extra = 1; }
      spr.owner = i;
      this.stat.set(i, STAT.STANDABLE);
      spr.xVel = 8;
      moveSprite(this, map, i, (8 * bsin(spr.ang + 512)) >> 14, (8 * bsin(spr.ang)) >> 14, 0);
      spr.xVel = 0;
      return false;
    }
    // game.c: SEENINE/OOZFILTER — shade -16, solid with the hitscan bit
    // (or invisible and sized 0 when placed tiny), strength impact_damage<<2,
    // a standable. The wall cracks and the ooze filters that blow open.
    // No script of their own, so this comes BEFORE the script lookup — and
    // boot.js has to hand them in even though hasScript() says no.
    // game.c 4037: the breakable decoration — clipdist 32, solid with the
    // hitscan bit. No script; before the lookup.
    // game.c: TOILET and STALL get lotag 1 — without it neartag() never
    // reports them, and the use never reaches them — cstat 257, clipdist 8,
    // their own owner. Before the breakables' block, which they belong to.
    // game.c 4068: FEMMAG1/2 — the magazines lie flat and are never solid.
    if (!fromSprite && (spr.picNum === 568 || spr.picNum === 577)) { spr.cstat &= ~257; return false; }
    if (!fromSprite && (spr.picNum === 569 || spr.picNum === 571)) {
      spr.lotag = 1; spr.cstat |= 257; spr.clipDist = 8; spr.owner = i;
      return false;
    }
    if (this.breakableTiles && this.breakableTiles.has(spr.picNum) && !fromSprite) {
      spr.clipDist = 32;
      spr.cstat |= 257;
    }
    if (spr.picNum === T.SEENINE || spr.picNum === T.OOZFILTER) {
      spr.shade = -16;
      if (spr.xRepeat <= 8) { spr.cstat = 32768; spr.xRepeat = 0; spr.yRepeat = 0; }
      else spr.cstat = 257;
      spr.extra = (this.impactDamage ?? 5) << 2;
      spr.owner = i;
      this.stat.set(i, STAT.STANDABLE);
      return false;
    }
    const h = this.actorScr.get(spr.picNum);
    const t = this.fx.temp(i);
    t[0] = 0; t[2] = 0; t[3] = 0; t[5] = 0;
    // game.c 3697: a scripted actor placed by the map with a lotag above
    // the skill is not in this game — sized to nothing, filed as misc.
    // Monsters and items alike; the map's lotag is the skill they need.
    // ACCESSCARD (60) has its own case with no such check — the items fall
    // INTO its body after theirs — so a key card keeps whatever lotag the
    // map gave it (E1L5's carries 6543). The barrels (game.c 4600) have
    // none either.
    if (h !== undefined && !fromSprite && spr.lotag > this.skill
        && spr.picNum !== 60 && spr.picNum !== T.EXPLODINGBARREL && spr.picNum !== T.EXPLODINGBARREL + 1) {
      spr.xRepeat = 0; spr.yRepeat = 0;
      this.stat.set(i, STAT.MISC);
      return false;
    }
    // game.c 4702/4711: HEAVYHBOMB and the items — a pal other than 0 marks
    // a Dukematch-only pickup; in single player it is sized to nothing.
    // Otherwise the pal is cleared and the item shaded -17.
    if (!fromSprite && ITEM_TILES.has(spr.picNum)) {
      if (spr.pal !== 0) {
        spr.xRepeat = 0; spr.yRepeat = 0;
        this.stat.set(i, STAT.MISC);
        return false;
      }
      spr.shade = -17;
    }
    // game.c 4745 (with or without a script — spawn()'s case does not ask): a
    // pickup SPAWNED by a sprite (j >= 0) — an enemy's drop_ammo /
    // drop_shotgun, the player's tossweapon, a crate's first-aid kit: lotag 0,
    // lifted 32<<8 and tossed up (zvel -1024, one ssp), a random flip (cstat
    // TRAND&4), pal 0, ATOMICHEALTH translucent, 32x32 (AMMO 16x16), shade -17,
    // awake (statnum 1).
    // game.c 4690: a HEAVYHBOMB spawned by a sprite (the player's tossweapon
    // with the pipe bomb in hand): owned by the spawner, 9x9, yvel 4 (no
    // bounces left), hittable, shade -17 — a bomb lying there, to be picked up.
    if (fromSprite && spr.picNum === T.HEAVYHBOMB) {
      spr.xRepeat = spr.yRepeat = 9;
      spr.yVel = 4;
      spr.cstat |= 257;
      spr.pal = 0;
      spr.shade = -17;
    }
    if (fromSprite && ITEM_TILES.has(spr.picNum) && spr.picNum !== T.HEAVYHBOMB) {
      spr.lotag = 0;
      spr.z -= 32 << 8;
      spr.zVel = -1024;
      moveSprite(this, map, i, (spr.xVel * bsin(spr.ang + 512)) >> 14, (spr.xVel * bsin(spr.ang)) >> 14, spr.zVel);
      spr.cstat = krand(this.fx) & 4;
      spr.pal = 0;
      if (spr.picNum === 100) spr.cstat |= 128;                 // ATOMICHEALTH
      spr.xRepeat = spr.yRepeat = spr.picNum === 40 ? 16 : 32;   // AMMO 16
      spr.shade = -17;
      this.asleep.delete(i);
      this.stat.set(i, STAT.ACTOR);
    }
    // No script: the map's own hitag and extra stand (spawn() only writes
    // them from a CON header). A first version zeroed both and lost the
    // tags that tie scenery to its chain.
    if (h === undefined) {
      t[1] = 0; t[4] = 0;
      // game.c 4568: a RAT — no CON here (moveRat is C's) but in spawn()'s
      // monster case all the same: a random heading, 48x48, and NO cstat —
      // not blocking, not in any clip box. A map rat kept its mapped cstat 1
      // and, at the mouth of E1L4's crawlway, wedged a shrunk player for good.
      if (spr.picNum === T.RAT) {
        spr.ang = krand(this.fx) & 2047;
        spr.xRepeat = spr.yRepeat = 48;
        spr.cstat = 0;
        spr.clipDist = 80;
        { const sec = map.sectors[spr.sectNum]; if (sec) { this.floorZ.set(i, sec.floorZ); this.ceilingZ.set(i, sec.ceilingZ); } }
        this.stat.set(i, STAT.ACTOR);
        return true;
      }
      // game.c 5358: CANWITHSOMETHING1..4 have no CON — the barrel block all
      // the same (strength 0, clipdist 72, solid with the hitscan bit, a
      // random flip; the map's own owner) and a mover in C, movestandables
      // 2368 (moveCan here, from the actor loop). Without it a trash can was
      // a ghost: no clip bit, nothing to hit, nothing to break.
      // game.c 4507: GREENSLIME — no CON either; the monster block (40x40,
      // clipdist 80, cstat 257), strength 1, dozing until movefta.
      if (spr.picNum >= 2370 && spr.picNum <= 2377) {
        spr.picNum = 2370;
        spr.extra = 1;
        spr.xRepeat = spr.yRepeat = 40;
        spr.clipDist = 80;
        spr.cstat |= 257;
        { const sec = map.sectors[spr.sectNum]; if (sec) { this.floorZ.set(i, sec.floorZ); this.ceilingZ.set(i, sec.ceilingZ); } }
        this.fx.temp(i).fill(0);
        if (!fromSprite) { this.stat.set(i, STAT.ZOMBIE); this.asleep.add(i); } else this.stat.set(i, STAT.ACTOR);
        return true;
      }
      // game.c 4186: DUKECAR 2491 / HELECOPT 1346 — E1L1's crashing ship. No
      // CON: extra 1, xvel 292, zvel 360, then the BLIMP tail (cstat 257,
      // clipdist 128), statnum 1 — awake from the first tic.
      if (spr.picNum === 2491 || spr.picNum === 1346) {
        spr.cstat = 257; spr.extra = 1; spr.xVel = 292; spr.zVel = 360; spr.clipDist = 128;
        { const sec = map.sectors[spr.sectNum]; if (sec) { this.floorZ.set(i, sec.floorZ); this.ceilingZ.set(i, sec.ceilingZ); } }
        this.fx.temp(i).fill(0);
        this.stat.set(i, STAT.ACTOR);
        return true;
      }
      if (CAN_TILES.has(spr.picNum) && !fromSprite) {
        spr.extra = 0;
        spr.clipDist = 72;
        spr.cstat = 257 | (krand(this.fx) & 4);
        spr.owner = i;
        { const sec = map.sectors[spr.sectNum]; if (sec) { this.floorZ.set(i, sec.floorZ); this.ceilingZ.set(i, sec.ceilingZ); } }
        this.stat.set(i, STAT.ACTOR);
        return true;
      }
      return false;
    }
    spr.extra = this.script[h];
    t[4] = this.script[h + 1];
    t[1] = this.script[h + 2];
    // game.c 3683: the header's flags take the hitag only where the map
    // left it 0 — a mapper's hitag (a respawn tag on a captive, a tag on a
    // monster) stays. A first version overwrote it every time.
    if (this.script[h + 3] && spr.hitag === 0) spr.hitag = this.script[h + 3];
    // game.c 3634: a map sprite's hittype floorz/ceilingz start as its
    // SECTOR's, not zero. The height ifs read these before any `fall` has
    // measured, and with zeroes ifgapzl saw a gap of nothing and put the
    // player sprite into its ducking frames.
    const sec = this.map?.sectors?.[spr.sectNum];
    if (sec) { this.floorZ.set(i, sec.floorZ); this.ceilingZ.set(i, sec.ceilingZ); }
    this.lastV.delete(i);
    // game.c 3708..3735: a useractor with a type is a monster — it falls, may
    // be bound to its sector (type&2), and gets clipdist 80; anything else
    // scripted gets 40. The counters and stat changes are not reproduced.
    // The `else clipdist = 40` of the same block is NOT reproduced: it applies
    // only to picnums that have no case of their own in spawn()'s big switch,
    // and that list is a few hundred entries this file does not carry. A
    // wrong 40 on a SEENINE would be worse than the map's own value.
    const type = this.actorType.get(spr.picNum) ?? 0;
    if (type & 3) {
      if (type & 2) this.stayPut.set(i, spr.sectNum);
      spr.clipDist = 80;
    }
    // game.c 4505..4615, the monster case of spawn(): the whole LIZTROOP,
    // PIGCOP, OCTABRAIN ... family (and the bosses, sized 80 with clipdist
    // 164) gets size 40, clipdist 80, `cstat |= 257` — blocking AND the
    // hitscan bit, without which no shot can ever land on it — and, placed
    // by the map (j == -1), starts DOZING: statnum 2, woken by movefta when
    // the player comes near and into view, or by being hit. This is why
    // Duke's levels wake up room by room rather than all at once.
    // game.c: the barrels and cans — clipdist 72, on the floor, solid with
    // the hitscan bit and a random flip. EXPLODINGBARREL keeps its script.
    // game.c 5362: the same block takes the cans and the other barrels —
    // RUBBERCAN and CANWITHSOMETHING1..4 with strength 0 (their scripts
    // dent on any hit and go on a blast), HORSEONSIDE, FIREBARREL,
    // NUKEBARREL(+DENTED/LEAKED), FIREVASE, WOODENHORSE.
    if (BARREL_TILES.has(spr.picNum)) {
      spr.clipDist = 72;
      spr.cstat = 257 | (krand(this.fx) & 4);
      if (!fromSprite) spr.owner = i;
      if (CAN_TILES.has(spr.picNum)) spr.extra = 0;         // game.c: the cans' strength is 0, set after the CON header (this block runs after it)
    }
    // game.c 4531: the monster block runs for spawned ones too (the PIGCOP
    // bailing out of a RECON, a bee out of an egg) — same sizes, cstat and
    // clipdist — but a spawned monster is awake at once (stat 1) where a
    // map-placed one dozes (stat 2) until seen. A first version skipped
    // spawned monsters: the pilot bailed out at size 0, invisible.
    if (MONSTER_TILES.has(spr.picNum)) {
      if (STAYPUT_TILES.has(spr.picNum) && !fromSprite) this.stayPut.set(i, spr.sectNum);
      if (BOSS_TILES.has(spr.picNum)) {
        if (spr.pal) { spr.clipDist = 80; spr.xRepeat = 40; spr.yRepeat = 40; }
        else { spr.xRepeat = 80; spr.yRepeat = 80; spr.clipDist = 164; }
      } else if (spr.picNum === SHARK) {
        spr.xRepeat = 60; spr.yRepeat = 60;
      } else {
        spr.xRepeat = 40; spr.yRepeat = 40; spr.clipDist = 80;
      }
      spr.cstat |= 257;
      if (spr.picNum === ORGANTIC) spr.cstat |= 128;
      if (spr.picNum === ROTATEGUN) spr.zVel = 0;
      this.timeToSleep.set(i, 0);
      if (fromSprite) { spr.lotag = 0; this.asleep.delete(i); this.stat.set(i, STAT.ACTOR); }
      else this.asleep.add(i);
    }
    // game.c 4142: the women (FEM1..10, PODFEM1, NAKED1, STATUE, TOUGHGAL)
    // and BLOODYPOLE — hittable (cstat 257), clipdist 32, dozing (stat 2)
    // until seen; yvel keeps the respawn hitag; a woman in a pod has her
    // strength doubled. Her script frees her when she is shot.
    if (!fromSprite && FEM_TILES.has(spr.picNum)) {
      if (spr.picNum !== BLOODYPOLE) { spr.yVel = spr.hitag; spr.hitag = -1; }
      if (spr.picNum === PODFEM1) spr.extra <<= 1;
      spr.cstat |= 257;
      spr.clipDist = 32;
      this.asleep.add(i);
    }
    return true;
  }

  /**
   * execute(i, p, x): one tic of the actor's script. `x` is the distance to
   * the player; `player` is `{ x, y, z, ang, sectNum }`.
   * Returns true when the script asked for the actor to be removed.
   */
  execute(map, i, player, x) {
    const spr = map.sprites[i];
    const h = this.actorScr.get(spr.picNum);
    if (h === undefined) return false;
    this.map = map; this.i = i; this.sp = spr; this.t = this.fx.temp(i);
    this.player = player; this.x = x;
    this.ip = h + 4;
    this.killit = false;
    this.stopped = false;          // killit_flag == 2: script stopped, sprite kept

    // The running action, advanced before the body: lotag is borrowed as the
    // frame timer, t[2] counts completed frames, t[3] is the frame offset.
    const t = this.t;
    if (t[4]) {
      const s = this.script, a = t[4];
      spr.lotag += TICS_PER_FRAME;
      if (spr.lotag > s[a + 4]) {
        t[2]++;
        spr.lotag = 0;
        t[3] += s[a + 3];
      }
      if (Math.abs(t[3]) >= Math.abs(s[a + 1] * s[a + 3])) t[3] = 0;
    }

    // Duke has no such cap because Duke trusts its own compiler; this
    // interpreter is partial and should not. 16206 words of real bytecode run
    // in well under a thousand steps a tic.
    this.steps = 0;
    while (!this.#parse()) {
      if (++this.steps > STEP_LIMIT) { this.derailed++; break; }
    }
    // execute(): `if(killit_flag) deletesprite(); else move();` — then the
    // sleep bookkeeping for a badguy that is not huge: the countdown
    // `sleeptime`, `ifcansee` or a far `ifpdistl` started runs down, and at
    // 1 the actor changes to statnum 2 and stops executing until movefta()
    // decides the player is close enough to wake it. Zero means "no
    // countdown", and an actor nothing ever armed stays awake for ever.
    if (!this.killit) {
      moveActor(this, map, i);
      if (!(isBadguy(this, spr) && spr.xRepeat > 60)) {
        const tts = this.timeToSleep.get(i) ?? 0;
        if (tts > 1) this.timeToSleep.set(i, tts - 1);
        else if (tts === 1) this.asleep.add(i);
      }
    }
    return this.killit;
  }

  #skip(op) {
    this.skipped.set(op, (this.skipped.get(op) || 0) + 1);
    // For a one-argument command, which argument: `spawn` and `shoot` are
    // not one gap each but one gap per thing they are asked for, and the
    // list of those is what decides which spawn() cases to write next.
    if (ARGS[op] === 1) {
      const key = `${KEYWORDS[op]} ${this.script[this.ip + 1]}`;
      this.skippedArgs.set(key, (this.skippedArgs.get(key) || 0) + 1);
    }
  }

  /** A named stand-in in the body was met; counted, like a skipped opcode. */
  stub(name) {
    this.stubbed.set(name, (this.stubbed.get(name) || 0) + 1);
  }

  /** parseifelse(): run the body if true, else jump to the fail address. */
  #ifElse(cond) {
    const s = this.script;
    if (cond) {
      this.ip += 2;
      this.#parse();
    } else {
      this.ip = s[this.ip + 1];
      if (s[this.ip] === OP.else) {
        this.ip += 2;
        this.#parse();
      }
    }
  }

  /** parse(): one command. Returns true at the end of a body. */
  #parse() {
    // `if(killit_flag) return 1;` — flag 1 (killit) and flag 2 (stopped: the
    // item stays) both end every enclosing body at once.
    if (this.killit || this.stopped) return true;
    const s = this.script, sp = this.sp, t = this.t;
    const op = s[this.ip];

    // A tripwire, not a feature. These keywords exist only at compile time —
    // their opcodes are retracted the moment they are read — so meeting one
    // here means the instruction pointer has left the program: a jump slot
    // read wrong, a body run past its end. Stop this actor's tic and say so,
    // rather than execute words that were never code.
    if (this.ip <= 0 || COMPILE_ONLY.has(op)) {
      this.derailed++;
      return true;
    }

    switch (op) {
      case OP.ifrnd:
        this.ip++;
        this.#ifElse(rnd(this.fx, s[this.ip]));
        return false;

      case OP.ai: {
        this.ip++;
        const ai = s[this.ip];
        t[5] = ai;
        t[4] = s[ai];           // action
        t[1] = s[ai + 1];       // move
        sp.hitag = s[ai + 2];   // move flags
        t[0] = t[2] = t[3] = 0;
        if (sp.hitag & RANDOM_ANGLE) sp.ang = krand(this.fx) & 2047;
        this.ip++;
        return false;
      }

      case OP.action:
        this.ip++;
        t[2] = 0;
        t[3] = 0;
        // FIX_00093 from the source: the shipped 1.3/1.4 CON hands the blimp an
        // action "address" of 2048 that is really a timeout value. Reproduced,
        // because it is the same file.
        t[4] = s[this.ip] === 2048 ? 0 : s[this.ip];
        this.ip++;
        return false;

      case OP.move:
        t[0] = 0;
        this.ip++;
        t[1] = s[this.ip];
        this.ip++;
        sp.hitag = s[this.ip];
        this.ip++;
        if (sp.hitag & RANDOM_ANGLE) sp.ang = krand(this.fx) & 2047;
        return false;

      case OP.else:
        // Reached only by falling into it from a TRUE branch: the body has run,
        // so jump past the else-body.
        this.ip = s[this.ip + 1];
        return false;

      case OP.state: {
        const back = this.ip + 2;
        this.ip = s[this.ip + 1];
        while (!this.#parse()) { /* the state's body */ }
        this.ip = back;
        return false;
      }

      case OP['{']:
        this.ip++;
        while (!this.#parse()) { /* the block */ }
        return false;

      case OP['}']:
        this.ip++;
        return true;

      case OP.enda:
      case OP.break:
      case OP.ends:
        return true;

      case OP.killit:
        this.ip++;
        this.killit = true;
        return false;

      case OP.strength:
        this.ip++; sp.extra = s[this.ip]; this.ip++;
        return false;
      case OP.addstrength:
        this.ip++; sp.extra += s[this.ip]; this.ip++;
        return false;
      case OP.ifstrength:
        this.ip++; this.#ifElse(sp.extra <= s[this.ip]);
        return false;

      case OP.sizeat:
        this.ip++; sp.xRepeat = s[this.ip] & 255;
        this.ip++; sp.yRepeat = s[this.ip] & 255;
        this.ip++;
        return false;

      case OP.sizeto: {
        // gamedef.c: one step per tic toward the target, x always; y when the
        // sprite is a small player, when the target is below the current
        // size, or when the sprite's height `(yrepeat*(tilesizy+8))<<2` still
        // fits between its floor and ceiling. A first version had only the
        // middle clause — so nothing ever GREW in y: the hydrant's water
        // stayed a line, the expander's sizeto 60 60 widened only.
        this.ip++;
        const jx = (s[this.ip] - sp.xRepeat) << 1;
        sp.xRepeat += Math.sign(jx);
        this.ip++;
        const th = this.art?.get(sp.picNum)?.height ?? 0;
        const sec = this.map.sectors[sp.sectNum];
        const fz = this.floorZ.get(this.i) ?? sec?.floorZ ?? 0, cz = this.ceilingZ.get(this.i) ?? sec?.ceilingZ ?? 0;
        if ((sp.picNum === T.APLAYER && sp.yRepeat < 36) || s[this.ip] < sp.yRepeat || ((sp.yRepeat * (th + 8)) << 2) < fz - cz) {
          const jy = (s[this.ip] - sp.yRepeat) << 1;
          if (jy) sp.yRepeat += Math.sign(jy);
        }
        this.ip++;
        return false;
      }

      case OP.cstat:
        this.ip++; sp.cstat = s[this.ip] & 0xffff; this.ip++;
        return false;
      case OP.cstator:
        this.ip++; sp.cstat |= s[this.ip] & 0xffff; this.ip++;
        return false;
      case OP.clipdist:
        this.ip++; sp.clipDist = s[this.ip] & 0xffff; this.ip++;
        return false;
      case OP.spritepal:
        this.ip++;
        this.fx.ang.set(this.i, sp.pal);      // hittype.tempang keeps the old pal
        sp.pal = s[this.ip];
        this.ip++;
        return false;
      case OP.getlastpal:
        this.ip++;
        sp.pal = this.fx.ang.get(this.i) ?? sp.pal;
        return false;
      case OP.ifspritepal:
        this.ip++; this.#ifElse(sp.pal === s[this.ip]);
        return false;

      case OP.count:
        this.ip++; t[0] = s[this.ip] | 0; this.ip++;
        return false;
      case OP.ifcount:
        this.ip++; this.#ifElse(t[0] >= s[this.ip]);
        return false;
      case OP.resetcount:
        this.ip++; t[0] = 0;
        return false;
      case OP.ifactioncount:
        this.ip++; this.#ifElse(t[2] >= s[this.ip]);
        return false;
      case OP.resetactioncount:
        this.ip++; t[2] = 0;
        return false;
      case OP.ifaction:
        this.ip++; this.#ifElse(t[4] === s[this.ip]);
        return false;
      case OP.ifmove:
        this.ip++; this.#ifElse(t[1] === s[this.ip]);
        return false;
      case OP.ifai:
        this.ip++; this.#ifElse(t[5] === s[this.ip]);
        return false;
      case OP.ifactor:
        this.ip++; this.#ifElse(sp.picNum === s[this.ip]);
        return false;

      case OP.ifpdistl:
        this.ip++; this.#ifElse(this.x < s[this.ip]);
        // A player FAR away starts the sleep countdown, if none is running —
        // the other way round from what one would guess.
        if (this.x > MAXSLEEPDIST && (this.timeToSleep.get(this.i) ?? 0) === 0) {
          this.timeToSleep.set(this.i, SLEEPTIME);
        }
        return false;
      case OP.ifpdistg:
        this.ip++; this.#ifElse(this.x > s[this.ip]);
        return false;

      case OP.ifangdiffl: {
        this.ip++;
        const j = Math.abs(incAngle(this.player?.ang ?? 0, sp.ang));
        this.#ifElse(j <= s[this.ip]);
        return false;
      }

      case OP.ifonwater: {
        const sec = this.map.sectors[sp.sectNum];
        this.#ifElse(!!sec && Math.abs(sp.z - sec.floorZ) < (32 << 8) && (sec.lotag & LOTAG_MASK) === 1);
        return false;
      }
      case OP.ifinwater: {
        const sec = this.map.sectors[sp.sectNum];
        this.#ifElse(!!sec && (sec.lotag & LOTAG_MASK) === 2);
        return false;
      }

      case OP.nullop:
        this.ip++;
        return false;

      case OP.ifp: {
        // The player-status bits, DEFS.CON's pstanding..pfacing. Two things
        // to know before reading the list. `s` is g_sp->xvel — the ACTOR's
        // speed, not the player's, so `ifp pwalking` in a trooper's script
        // asks whether the trooper is walking; that is the source, and it is
        // reproduced. And the chain is else-if: the first bit that matches
        // decides, in this order.
        //
        // What the player carries: `onGround`, `jumpCounter`, `zVel` from
        // player.js's state, and the crouch and run keys as `crouch` and
        // `running` — handed in by moveActors. Weapons, jetpack, steroids,
        // shrinking and death do not exist here: pkicking, pshrunk, pjetpack,
        // ponsteroids and pdead are false, palive is true.
        this.ip++;
        const l = s[this.ip];
        const p = this.player, ps = this.pstate ?? {}, kb = this.pinput ?? {};
        const v = sp.xVel;
        const run = !!kb.running;
        let j = false;
        if ((l & 8) && ps.onGround && kb.crouch) j = true;
        else if ((l & 16) && (ps.jumpCounter ?? 0) === 0 && !ps.onGround && (ps.zVel ?? 0) > 2048) j = true;
        else if ((l & 32) && (ps.jumpCounter ?? 0) > 348) j = true;
        else if ((l & 1) && v >= 0 && v < 8) j = true;
        else if ((l & 2) && v >= 8 && !run) j = true;
        else if ((l & 4) && v >= 8 && run) j = true;
        else if ((l & 64) && p.z < (sp.z - (48 << 8))) j = true;
        else if ((l & 128) && v <= -8 && !run) j = true;
        else if ((l & 256) && v <= -8 && run) j = true;
        else if (l & 512) j = false;                       // pkicking: no weapons
        else if (l & 1024) j = (this.map.sprites[this.playerSprite]?.xRepeat ?? 42) < 32;   // pshrunk: gamedef.c 2850
        else if (l & 2048) j = false;                      // pjetpack
        else if (l & 4096) j = (ps.inventory?.steroids ?? 0) > 0 && ps.inventory.steroids < 400;   // ponsteroids: gamedef.c 2854, taken and running
        else if ((l & 8192) && ps.onGround) j = true;
        else if (l & 16384) j = true;                      // palive: no damage yet
        else if (l & 32768) j = false;                     // pdead
        else if (l & 65536) {
          // pfacing: the player looks within 128 either side of the actor.
          const a = incAngle(p.ang, getAngle(this.radarang, sp.x - p.x, sp.y - p.y));
          j = a > -128 && a < 128;
        }
        this.#ifElse(j);
        return false;
      }

      case OP.ifhitweapon: {
        // ifhitbyweapon(), actors.c: a hit filed by checkhitsprite comes off
        // the actor's strength, the owner passes to the shooter, the filing
        // is cleared to -1, and the weapon's picnum is what `ifwasweapon`
        // reads until the next hit.
        const filed = this.hitExtra.get(this.i) ?? -1;
        let j = -1;
        if (filed === 0 && (this.hitPic.get(this.i) ?? -1) === T.SHRINKSPARK && sp.xRepeat < 24) {
          // ifhitbyweapon: a zero-damage shrink on one already small: no hit.
          this.hitExtra.set(this.i, -1);
          this.#ifElse(false);
          return false;
        }
        if (filed >= 0 && sp.extra >= 0) {
          sp.extra -= filed;
          const own = this.hitOwner.get(this.i);
          if (sp.picNum !== 1960 /* RECON */ && own !== undefined && own >= 0) sp.owner = own;
          this.hitExtra.set(this.i, -1);
          j = this.hitPic.get(this.i) ?? -1;
        }
        this.#ifElse(j >= 0);
        return false;
      }
      case OP.ifwasweapon:
        this.ip++;
        this.#ifElse((this.hitPic.get(this.i) ?? -1) === s[this.ip]);
        return false;
      case OP.addkills:
        this.ip++;
        this.kills += s[this.ip];
        this.stayPut.delete(this.i);      // `actorstayput = -1`
        this.ip++;
        return false;

      // The sounds. `sound` is spritesound(num, g_i) from the actor's
      // position; `soundonce` the same unless an instance is already
      // running; `globalsound` plays from the PLAYER (ps[].i, no distance);
      // `stopsound` stops every instance; `ifnosounds` asks whether this
      // actor owns none. All four go through this.sounds, the SoundSystem
      // the page created — without one they are counted as skipped, as
      // before.
      case OP.sound:
      case OP.soundonce:
      case OP.globalsound:
      case OP.stopsound: {
        this.ip++;
        const num = s[this.ip];
        this.ip++;
        if (!this.sounds) { this.#skip(op); return false; }
        if (op === OP.stopsound) { if (this.sounds.isPlaying(num)) this.sounds.stop(num); }
        else if (op === OP.globalsound) this.sounds.at(num, -2, this.player.x, this.player.y, this.player.z, this.player, this.map);
        else if (op === OP.soundonce && this.sounds.isPlaying(num)) { /* already running */ }
        else this.sounds.at(num, this.i, sp.x, sp.y, sp.z, this.player, this.map);
        return false;
      }
      case OP.ifnosounds: {
        if (!this.sounds) { this.#skip(op); this.#ifElse(false); return false; }
        let owns = false;
        for (const list of this.sounds.playing.values()) if (list.some((v) => v.sprite === this.i)) { owns = true; break; }
        this.#ifElse(!owns);
        return false;
      }

      // --- pickups: the item's script hands things to the player ---------
      // `killit_flag = 2` in the source: the script stops for this tic and
      // the sprite STAYS — a full magazine leaves the ammo on the floor.
      case OP.addammo: {
        this.ip++;
        const w = s[this.ip], n = s[this.ip + 1];
        this.ip += 2;
        const pl = this.pstate;
        if (!pl) return false;
        // (stuffCheat: the page's standing DNSTUFF keeps every magazine full;
        // the item is still taken, as the bomb is, so nothing lies about for good)
        if (pl.ammoAmount[w] >= pl.maxAmmoAmount[w] && !pl.stuffCheat) { this.stopped = true; return true; }
        addAmmo(pl, w, n);
        if (pl.currWeapon === 0 && pl.gotWeapon[w]) addWeapon(pl, w);
        return false;
      }
      case OP.addweapon: {
        this.ip++;
        const w = s[this.ip], n = s[this.ip + 1];
        this.ip += 2;
        const pl = this.pstate;
        if (!pl) return false;
        if (!pl.gotWeapon[w]) addWeapon(pl, w);
        else if (pl.ammoAmount[w] >= pl.maxAmmoAmount[w] && !pl.stuffCheat) { this.stopped = true; return true; }
        addAmmo(pl, w, n);
        if (pl.currWeapon === 0 && pl.gotWeapon[w]) addWeapon(pl, w);
        return false;
      }
      case OP.addphealth: {
        // Health up to the maximum — or, for ATOMICHEALTH (100), twice it.
        // At or above the maximum an ordinary health item is left alone.
        this.ip++;
        const n = s[this.ip];
        this.ip++;
        const pl = this.pstate;
        if (!pl) return false;
        let j = pl.health;
        if (sp.picNum !== 100 /* ATOMICHEALTH */) {
          if (j > pl.maxHealth && n > 0 && !pl.stuffCheat) { this.stopped = true; return true; }
          if (j > 0) j += n;
          if (j > pl.maxHealth && n > 0) j = pl.maxHealth;
        } else {
          if (j > 0) j += n;
          if (j > (pl.maxHealth << 1)) j = pl.maxHealth << 1;
        }
        if (j < 0) j = 0;
        // gamedef.c 2560: `if(ud.god == 0) sprite[ps[g_p].i].extra = j;` —
        // with god on, addphealth changes nothing, up or down.
        if (!pl.god) pl.health = j;
        return false;
      }
      case OP.addinventory: {
        this.ip++;
        const slot = s[this.ip], n = s[this.ip + 1];
        this.ip += 2;
        const pl = this.pstate;
        if (!pl) return false;
        const inv = pl.inventory;
        // gamedef.c 2774: each pickup also becomes the status bar's inven_icon.
        switch (slot) {
          case GET.STEROIDS: inv.steroids = n; pl.invenIcon = 2; break;
          case GET.SHIELD: pl.shield = Math.min(pl.maxHealth, pl.shield + n); break;
          case GET.SCUBA: inv.scuba = n; pl.invenIcon = 6; break;
          case GET.HOLODUKE: inv.holoduke = n; pl.invenIcon = 3; break;
          case GET.JETPACK: inv.jetpack = n; pl.invenIcon = 4; break;
          case GET.ACCESS:
            if (sp.pal === 0) inv.access |= 1; else if (sp.pal === 21) inv.access |= 2; else if (sp.pal === 23) inv.access |= 4;
            break;
          case GET.HEATS: inv.heat = n; pl.invenIcon = 5; break;
          case GET.FIRSTAID: inv.firstaid = n; pl.invenIcon = 1; break;
          case GET.BOOTS: inv.boots = n; pl.invenIcon = 7; break;
          default: break;
        }
        return false;
      }
      case OP.ifpinventory: {
        // "Is there room for this?" — true when the slot is NOT already at
        // the amount offered (armour: not at max health).
        this.ip++;
        const slot = s[this.ip], n = s[this.ip + 1];
        this.ip++;
        const pl = this.pstate;
        let j = false;
        if (pl) {
          const inv = pl.inventory;
          switch (slot) {
            case GET.STEROIDS: j = inv.steroids !== n; break;
            case GET.SHIELD: j = pl.shield !== pl.maxHealth; break;
            case GET.SCUBA: j = inv.scuba !== n; break;
            case GET.HOLODUKE: j = inv.holoduke !== n; break;
            case GET.JETPACK: j = inv.jetpack !== n; break;
            case GET.ACCESS:
              j = sp.pal === 0 ? !!(inv.access & 1) : sp.pal === 21 ? !!(inv.access & 2) : sp.pal === 23 ? !!(inv.access & 4) : false;
              break;
            case GET.HEATS: j = inv.heat !== n; break;
            case GET.FIRSTAID: j = inv.firstaid !== n; break;
            case GET.BOOTS: j = inv.boots !== n; break;
            default: break;
          }
          if (pl.stuffCheat && slot !== GET.ACCESS) j = true;   // the standing cheat: always room, the item is taken
        }
        this.#ifElse(j);
        return false;
      }
      case OP.ifphealthl:
        this.ip++;
        this.#ifElse((this.pstate?.health ?? 0) < s[this.ip]);
        return false;
      case OP.ifcanseetarget: {
        // cansee from a random height below the sprite to the player's eye.
        const p = this.player;
        // Through a camera Duke's cansee gets the camera's x,y,z with the
        // player SPRITE's sector, a mismatch that never resolves: no actor
        // sees the player while they watch a monitor.
        const j = this.watching ? false : canSee(this.map, sp.x, sp.y, sp.z - ((krand(this.fx) & 41) << 8), sp.sectNum,
          p.x, p.y, p.z, p.sectNum);
        if (j) this.timeToSleep.set(this.i, SLEEPTIME);
        this.#ifElse(j);
        return false;
      }
      case OP.ifgotweaponce:
        // Co-op only (a weapon each player may take once); single player: no.
        this.ip++;
        this.#ifElse(false);
        return false;
      case OP.ifrespawn:
        // ud.respawn_monsters/items/inventory: all off in single player.
        this.#ifElse(false);
        return false;
      case OP.ifawayfromwall: {
        // gamedef.c 3040: the sprite's sector must hold all four corners of a
        // 216-wide square around it (updatesector from the sprite's sector,
        // each check starting where the last one left s1). A captain's
        // reappearance (troophidestate) waits on it; stepped over, the if
        // was always false and a hidden LIZTROOP never came back.
        const sp = this.map.sprites[this.i];
        const home = sp.sectNum;
        let s1 = home, ok = false;
        for (const [dx, dy] of [[108, 108], [-108, -108], [108, -108], [-108, 108]]) {
          s1 = updateSector(this.map, sp.x + dx, sp.y + dy, s1);
          if (s1 !== home) break;
        }
        ok = s1 === home;
        this.#ifElse(ok);
        return false;
      }

      case OP.ifmultiplayer:
        // gamedef.c: `parseifelse(ud.multimode > 1)` — single player: no.
        // APLAYER's death and pain branches ask it (GAME.CON 3415, 3569).
        this.#ifElse(false);
        return false;
      case OP.quote:
        this.ip++;
        if (this.pstate) { this.pstate.quote = s[this.ip]; this.pstate.quoteTime = 120; }
        this.ip++;
        return false;
      case OP.endofgame:
        // gamedef.c: timebeforeexit = the count, customexitsound -1, and
        // ud.eog — the episode ends with this level (BOSS1's death).
        this.ip++;
        if (this.pstate) { this.pstate.timeBeforeExit = s[this.ip]; this.pstate.customExitSound = -1; }
        this.eog = true;
        this.ip++;
        return false;
      case OP.palfrom: {
        // pals_time and the RGB of a screen flash: `palfrom 16 0 32` is a
        // green flash for 16 tics (time, r, g, b).
        this.ip++;
        if (this.pstate) {
          this.pstate.pal = { time: s[this.ip], r: s[this.ip + 1], g: s[this.ip + 2], b: s[this.ip + 3] };
        }
        this.ip += 4;
        return false;
      }
      case OP.respawnhitag:
        // Deferred respawn bookkeeping for an item that was picked up: a
        // no-op with respawns off.
        this.ip++;
        return false;

      case OP.operate: {
        // gamedef.c 2910: from a plain sector (lotag exactly 0) the actor
        // looks, at 32<<8 above its feet and 768 ahead, for a tagged sector
        // (tagsearch 1). A near-operator that is CLOSED (floorz == ceilingz,
        // or a swinging door, lotag 23), neither locked (16384) nor already
        // open (32768) and holding no ACTIVATOR is operated — the
        // `ifnotmoving ifrnd 32 operate` in every seekplayer state is how a
        // trooper comes through a door after you. It never closes one.
        this.ip++;
        const map = this.map;
        if ((map?.sectors[sp.sectNum]?.lotag ?? 1) === 0 && this.operateSector) {
          const tag = nearTag(map, sp.x, sp.y, sp.z - (32 << 8), sp.sectNum, sp.ang, 768, 1, this.art);
          if (tag.sector >= 0) {
            const sc = map.sectors[tag.sector], lt = sc.lotag;
            if (isNearOperator(lt) && ((lt & 0xff) === 23 || sc.floorZ === sc.ceilingZ)
                && !(lt & 16384) && !(lt & 32768)
                && !map.sprites.some((o) => !o.removed && o.sectNum === tag.sector && o.picNum === 2)) {
              this.operateSector(tag.sector);
            }
          }
        }
        return false;
      }

      case OP.hitradius: {
        // hitradius R hp1 hp2 hp3 hp4 — the barrel's own blast.
        this.ip++;
        const r = s[this.ip], h1 = s[this.ip + 1], h2 = s[this.ip + 2], h3 = s[this.ip + 3], h4 = s[this.ip + 4];
        this.ip += 5;
        hitRadius(this, this.map, this.i, r, h1, h2, h3, h4, this.player);
        return false;
      }
      case OP.pstomp: {
        // gamedef.c: the player is not already stomping and is full size,
        // and can see the actor: knee_incs starts, and this actor is the one
        // to squash (actorsqu) when the stomp lands.
        this.ip++;
        const pl = this.pstate;
        if (pl && !pl.kneeIncs && (pl.actorSqu ?? -1) < 0
            && canSee(this.map, sp.x, sp.y, sp.z - (4 << 8), sp.sectNum, this.player.x, this.player.y, this.player.z, this.player.sectNum)) {
          pl.kneeIncs = 1;
          if (pl.weaponPos === 0) pl.weaponPos = -1;
          pl.actorSqu = this.i;
        }
        return false;
      }
      case OP.tip:
        // gamedef.c 2346: ps[g_p].tipincs = 26 — the hand with the money,
        // drawn by animatetip for 26 tics. The FEMs: `state tipme`.
        this.ip++;
        if (this.pstate) this.pstate.tipIncs = 26;
        return false;
      case OP.resetplayer:
        // gamedef.c (opcode 42, single player): with a saved game Duke opens
        // the load prompt (cmenu 15000), otherwise gm = MODE_RESTART — the
        // level starts over; killit_flag = 2 stops this script here without
        // deleting the sprite. The page acts on the flag.
        this.ip++;
        this.resetPlayer = true;
        this.stopped = true;
        return true;
      case OP.wackplayer: {
        // gamedef.c 2895 → forceplayerangle (player.c 95): the view is
        // knocked up (horiz += 64) and to a random side (look_ang and
        // rotscrnang = n>>1, n = 128-(TRAND&255)); return_to_center = 9
        // brings the pitch back over the next tics (the page's player tic).
        // breakobject and headhitstate ask for it: a thing that hits Duke.
        this.ip++;
        const n = 128 - (krand(this.fx) & 255);
        if (this.player) this.player.horiz = (this.player.horiz ?? 100) + 64;
        const pl = this.pstate;
        if (pl) { pl.returnToCenter = 9; pl.lookAng = n >> 1; pl.rotScrnAng = n >> 1; }
        return false;
      }
      case OP.mikesnd:
        // gamedef.c 2274: the sprite's yvel is a sound; it is started unless
        // an instance of it is already playing (the MIKE actor).
        this.ip++;
        if (this.sounds && !this.sounds.isPlaying(sp.yVel)) this.sounds.at(sp.yVel, this.i, sp.x, sp.y, sp.z, this.player, this.map);
        return false;
      case OP.pkick: {
        // A quick kick at a frozen actor: 14 tics of quick_kick, the knee
        // fires on 8 of them (player.c), if no kick is already under way.
        this.ip++;
        const pl = this.pstate;
        if (pl && !(pl.quickKick > 0) && !pl.kneeIncs) pl.quickKick = 14;
        return false;
      }
      case OP.debris: {
        // debris TILE N, gamedef.c: N pieces of TILE + TRAND%3, the actor's
        // shade and pal, 32..47 square, up to 8191 above it, thrown 32..159
        // in a random direction and upward 0..2047, misc — scrap that
        // moveexplosions carries (the SCRAP tiles) or that just falls.
        this.ip++;
        const dnum = s[this.ip]; this.ip++;
        const count = s[this.ip]; this.ip++;
        if (sp.sectNum >= 0) {
          for (let k = count - 1; k >= 0; k--) {
            const l = makeSprite(this, this.map, sp.sectNum, sp.x + (krand(this.fx) & 255) - 128, sp.y + (krand(this.fx) & 255) - 128,
              sp.z - (8 << 8) - (krand(this.fx) & 8191), dnum + (krand(this.fx) % 3), sp.shade, 32 + (krand(this.fx) & 15), 32 + (krand(this.fx) & 15),
              krand(this.fx) & 2047, (krand(this.fx) & 127) + 32, -(krand(this.fx) & 2047), this.i, STAT.MISC);
            this.map.sprites[l].pal = sp.pal;
          }
        }
        return false;
      }
      case OP.guts: {
        // guts TILE N — actors.c 772. N jibs of TILE from the actor: size 32
        // (8 for a badguy under xrepeat 16), from 8<<8 above its z but never
        // deeper than 8<<8 above the floor (a COMMANDER 24<<8 higher still),
        // scattered ±128, up to 8191 higher, shade -32, any angle, xvel
        // 48..79, zvel -512..-2559 (up), owned by the player, misc. A JIBS2
        // is quartered; a pal-6 badguy bleeds pal 6.
        const gtype = s[this.ip + 1], n = s[this.ip + 2];
        this.ip += 3;
        guts(this, this.map, this.i, gtype, n);
        return false;
      }
      case OP.lotsofglass:
        // gamedef.c 2478: spriteglass(g_i, N) — N shards round the actor
        // (a frozen trooper kicked to pieces).
        spriteGlass(this, this.map, this.i, s[this.ip + 1]);
        this.ip += 2;
        return false;

      case OP.mail:
      case OP.paper: {
        // gamedef.c 102/103, lotsofmail/lotsofpaper (actors.c 750/760): the
        // same as money with MAIL or PAPER — they flutter down in
        // moveExplosions with the bills.
        const n = s[this.ip + 1];
        this.ip += 2;
        lotsOfMoney(this, this.map, this.i, n, op === OP.mail ? MAIL : PAPER);
        return false;
      }
      case OP.money: {
        // money N — actors.c 740: N MONEY sprites at the actor, each up to
        // 47<<8 higher, shade -32, size 8, any angle, misc, cstat rand&12
        // (flipped either way). They flutter down in moveExplosions.
        const n = s[this.ip + 1];
        this.ip += 2;
        lotsOfMoney(this, this.map, this.i, n);
        return false;
      }
      case OP.tossweapon:
        // checkweapons(&ps[yvel]), player.c 2321 — the player's death: for a
        // weapon in hand (1..11) a coin: heads, the weapon's pickup sprite
        // (weapon_sprites[]: KNEE, FIRSTGUNSPRITE 21, SHOTGUNSPRITE 28,
        // CHAINGUNSPRITE 22, RPGSPRITE 23, HEAVYHBOMB 26, SHRINKERSPRITE 25,
        // DEVISTATORSPRITE 29, TRIPBOMBSPRITE 27, FREEZESPRITE 24, HEAVYHBOMB,
        // SHRINKERSPRITE) is spawned off the player's sprite; tails, an RPG
        // or pipe bomb in hand explodes there (EXPLOSION2), anything else
        // nothing.
        this.ip++;
        {
          const pl = this.pstate, cw = pl?.currWeapon ?? 0;
          const WEAPON_SPRITES = [0, 21, 28, 22, 23, 26, 25, 29, 27, 24, 26, 25];
          if (pl && cw >= 1 && cw < 12 && this.playerSprite >= 0) {
            if (krand(this.fx) & 1) spawnFrom(this, this.map, this.playerSprite, WEAPON_SPRITES[cw]);
            else if (cw === 4 || cw === 5) spawnFrom(this, this.map, this.playerSprite, T.EXPLOSION2);
          }
        }
        return false;

      case OP.ifhitspace:
        // sync bits & (1<<29): the use key is DOWN this tic (a level, not
        // the press).
        this.#ifElse(!!this.pinput?.use);
        return false;

      case OP.ifsquished:
        this.#ifElse(ifSquished(this, this.map, this.i) === 1);
        return false;

      case OP.ifbulletnear:
        this.#ifElse(dodge(this, this.map, this.i) === 1);
        return false;

      case OP.ifactornotstayput:
        // `actorstayput == -1`: not bound to a sector.
        this.#ifElse(this.stayPut.get(this.i) === undefined);
        return false;

      case OP.ifnotmoving:
        // `(movflag&49152) > 16384` — movesprite's own report from the last
        // move(): 16384 is "moved, nothing hit", anything above it a wall,
        // sprite or refusal. Zero (never moved) is "moving" by this test.
        this.#ifElse(((this.movFlag.get(this.i) ?? 0) & 49152) > 16384);
        return false;

      case OP.ifdead: {
        // `extra < 0`, and the player counts one lower — dead at 0.
        let j = sp.extra;
        if (sp.picNum === APLAYER) j--;
        this.#ifElse(j < 0);
        return false;
      }

      case OP.ifspawnedby:
        // `hittype.picnum == arg`: the picnum of whatever spawned this sprite —
        // for a map-placed one, its own (game.c 3621). Nothing spawns here
        // yet, so it is always the sprite's own.
        this.ip++;
        this.#ifElse((this.spawnedBy.get(this.i) ?? sp.picNum) === s[this.ip]);
        return false;

      case OP.ifcansee: {
        // From a random height within 47<<8 below the sprite's origin to
        // 24<<8 below the player's eye — a line of sight that is not always
        // the same line, which is how an actor behind a low wall sometimes
        // sees you and sometimes does not. The holoduke branch is not here.
        const p = this.player;
        // gamedef.c 2133: with a holoduke out, the hologram is looked for
        // first (from a random height within 32<<8); unseen, the player.
        let j = false;
        if (this.holoduke >= 0 && !this.watching) {
          const h = this.map.sprites[this.holoduke];
          if (h && !h.removed) j = canSee(this.map, sp.x, sp.y, sp.z - (krand(this.fx) & ((32 << 8) - 1)), sp.sectNum, h.x, h.y, h.z, h.sectNum);
        }
        // Watching a camera: never seen (the sector mismatch, see ifcanseetarget).
        if (!j) j = this.watching ? false : canSee(this.map, sp.x, sp.y, sp.z - (krand(this.fx) & (47 << 8)), sp.sectNum,
          p.x, p.y, p.z - (24 << 8), p.sectNum);
        if (!j) {
          // Not seen. If the last known spot is nearer the actor than the
          // player is, keep it; then ask for a visible spot near the player
          // to head for instead.
          const lv = this.lastV.get(this.i);
          if (lv && (Math.abs(lv.x - sp.x) + Math.abs(lv.y - sp.y))
                  < (Math.abs(lv.x - p.x) + Math.abs(lv.y - p.y))) j = false;
          if (!j) j = furthestCanSeePoint(this, this.map, this.i, p) !== -1;
        } else {
          this.lastV.set(this.i, { x: p.x, y: p.y });
        }
        // Seen: the sleep countdown restarts in full.
        if (j) this.timeToSleep.set(this.i, SLEEPTIME);
        this.#ifElse(j);
        return false;
      }

      case OP.sleeptime:
        this.ip++;
        this.timeToSleep.set(this.i, s[this.ip]);
        this.ip++;
        return false;

      case OP.ifcanshoottarget: {
        // Three hitscans along the facing — straight, then +angdif, then
        // -angdif — must each run past `sclip` for the shot to be worth it.
        // Big badguys use a wider cone and a longer run. Close in (x <= 1024)
        // it is always yes.
        //
        // What is missing: hitasprite() reports a SPRITE hit, and a hit on
        // one's own kind means "don't shoot through a friend". This hitscan
        // has no sprite pass, so that check cannot fire. Named, not hidden.
        let j = true;
        if (this.x > 1024) {
          const big = isBadguy(this, sp) && sp.xRepeat > 56;
          const sclip = big ? 3084 : 768, angdif = big ? 48 : 16;
          const probe = (da) => {
            sp.ang += da;
            const h = hitASprite(this, this.map, this.i);
            sp.ang -= da;
            return h;
          };
          const d0 = probe(0);
          if (d0 === (1 << 30)) j = true;
          else if (d0 > sclip && probe(angdif) > sclip && probe(-angdif) > 768) j = true;
          else j = false;
        }
        this.#ifElse(j);
        return false;
      }

      case OP.fall:
        this.ip++;
        conFall(this, this.map, this.i, this.player);
        return false;

      case OP.spawn:
        this.ip++;
        spawnFrom(this, this.map, this.i, s[this.ip]);
        this.ip++;
        return false;

      case OP.shoot:
        this.ip++;
        this.onShoot?.(this.i, s[this.ip]);          // a probe's hook (development tooling)
        shootFrom(this, this.map, this.i, s[this.ip]);
        this.ip++;
        return false;

      case OP.cactor:
        // Change what the sprite IS. LIZTROOPDUCKING, LIZTROOPONTOILET and
        // their kin are placed as their own tiles and become a plain LIZTROOP
        // on the first tic — and the trooper's action frames are offsets from
        // 1680, so without this they would be drawn from 1744 up.
        this.ip++;
        sp.picNum = s[this.ip];
        this.ip++;
        return false;

      case OP.ifgapzl: {
        // The gap between the floor and ceiling the last `fall` measured — or,
        // before any fall, the sector's own, which spawn seeds.
        this.ip++;
        const fz = this.floorZ.get(this.i) ?? 0, cz = this.ceilingZ.get(this.i) ?? 0;
        this.#ifElse(((fz - cz) >> 8) < s[this.ip]);
        return false;
      }
      case OP.iffloordistl: {
        this.ip++;
        const fz = this.floorZ.get(this.i);
        this.#ifElse(fz !== undefined && (fz - sp.z) <= (s[this.ip] << 8));
        return false;
      }
      case OP.ifceilingdistl: {
        this.ip++;
        const cz = this.ceilingZ.get(this.i);
        this.#ifElse(cz !== undefined && (sp.z - cz) <= (s[this.ip] << 8));
        return false;
      }

      default:
        break;
    }

    // Not implemented: step over it exactly, and count it. An `if` takes its
    // fail branch, which is "not true" and not "false" — see the class note.
    this.#skip(op);
    if (IS_IF[op]) {
      // parseifelse() wants the pointer on the LAST argument — or on the
      // opcode itself when there is none — because the fail slot is at +1
      // from there. Landing on the slot instead read the first body word as
      // the jump target and sent actor 1294 to word 0 of the script, where
      // opcode 0 lives. The `derailed` count below exists because of that.
      this.ip += ARGS[op];
      this.#ifElse(false);
      return false;
    }
    this.ip += 1 + ARGS[op];
    return false;
  }
}

/** getincangle(a, na): the signed short way round from a to na. */
export function incAngle(a, na) {
  a &= 2047; na &= 2047;
  if (Math.abs(a - na) < 1024) return na - a;
  if (na > 1024) na -= 2048;
  if (a > 1024) a -= 2048;
  return (na - 2048) - (a - 2048);
}

// ---------------------------------------------------------------------------
// animatesprites: which tile an actor is drawn with. game.c 5889..5960.
// ---------------------------------------------------------------------------

/**
 * engine.c's getangle(), over radarang from TABLES.DAT. The table is 1280
 * entries in the engine (640 read, the mirror filled in), indexed around 640
 * by `scale(160, small, large)`; the last branch's `>>6` is the table's
 * fixed-point.
 */
export function getAngle(radarang, xv, yv) {
  if ((xv | yv) === 0) return 0;
  if (xv === 0) return 512 + ((yv < 0) << 10);
  if (yv === 0) return (xv < 0) << 10;
  if (xv === yv) return 256 + ((xv < 0) << 10);
  if (xv === -yv) return 768 + ((xv > 0) << 10);
  // radarang[1279-i] = -radarang[i] for the upper half, as the engine fills it.
  const r = (i) => (i < 640 ? radarang[i] : -radarang[1279 - i]);
  const scale = (a, b, c) => Math.trunc((a * b) / c);
  if (Math.abs(xv) > Math.abs(yv)) {
    return ((r(640 + scale(160, yv, xv)) >> 6) + ((xv < 0) << 10)) & 2047;
  }
  return ((r(640 - scale(160, xv, yv)) >> 6) + 512 + ((yv < 0) << 10)) & 2047;
}

/**
 * findplayer()'s distance: Manhattan in the plane, plus the height difference
 * (offset by 28<<8, the player's own height) at a sixteenth. Not a hypotenuse,
 * and the z term is deliberately small — it is a "how far is the player"
 * number for the script's ifpdistl, not geometry.
 */
export function playerDist(cam, spr) {
  return Math.abs(cam.x - spr.x) + Math.abs(cam.y - spr.y)
    + (Math.abs(cam.z - spr.z + (28 << 8)) >> 4);
}

/**
 * The drawn tile for every scripted sprite, once per frame, before rendering.
 *
 * For an actor whose action is running (t[4] is an address):
 *
 *   l = action.viewtype
 *   k = the rotation frame, from the angle between the sprite's facing and the
 *       camera — 1, 2, 5 (with mirroring), 8, or 12 views, by l
 *   picnum += k + action.startframe + l * t[3]
 *
 * and the mirroring goes on the DRAWING copy's cstat, never on the sprite. Here
 * that is `dispPicNum` and `dispFlip` on the sprite, read by the renderer and
 * rewritten every frame; `dispFlip` is null when the viewtype has no opinion,
 * so the sprite's own cstat&4 stands.
 *
 * The "hack, for actors": when the computed tile does not exist, step back by
 * one viewtype-width until one does. Kept, comment and all.
 *
 * `a` is the camera angle; viewtypes 5 and 7 use the direction TO the camera
 * instead, via getangle.
 */
/** animatesprites' switch: the tiles that break out before the default's floorpal (game.c 5642..5820). */
const PAL_EXEMPT = new Set([2270, 2310, 100, 502, 499, 1646, 2448, 2605, 1960, 46]);

export function animateSprites(map, vm, cam, radarang, art) {
  const s = vm.script;
  let animated = 0;
  // game.c 6008: with the night vision on, every badguy, dummy player and
  // the player's own sprite is drawn pal 6 at shade 0 — the heat signature.
  // Explosions, HANGLIGHT, DOMELITE and HOTMEAT excepted. Display-only:
  // dispPal/dispShade, which the renderer prefers to pal/shade.
  const heat = !!vm.heatOn;
  for (let i = 0; i < map.sprites.length; i++) {
    const spr = map.sprites[i];
    // game.c 5966, ud.shadows: every badguy, dummy player (statnum 13) and
    // live player sprite but EXPLOSION2, HANGLIGHT, DOMELITE and HOTMEAT
    // casts a shadow — a copy of its picture flat on "the floor" (the
    // sector's in a lotag > 2 sector, for statnum 4/5, DRONE, COMMANDER; else
    // the actor's own last floorz), 1/8 as tall, shade 127, translucent,
    // pal 4 — when the sprite is less than 8<<8 below that floor. Whether
    // the eye is above it is the renderer's test (it has the camera).
    spr.shadowZ = undefined;
    if (!spr.removed && !(spr.cstat & 0x8000) && ((spr.cstat >> 4) & 3) === 0
        && (isBadguy(vm, spr) || vm.stat.get(i) === STAT.DUMMY || (spr.picNum === APLAYER && spr.owner >= 0))
        && spr.picNum !== T.EXPLOSION2 && spr.picNum !== HANGLIGHT && spr.picNum !== DOMELITE && spr.picNum !== HOTMEAT) {
      const sec = map.sectors[spr.sectNum];
      if (sec) {
        const st = vm.stat.get(i);
        const daz = ((sec.lotag & 0xff) > 2 || st === STAT.WEAPON || st === STAT.MISC || spr.picNum === DRONE || spr.picNum === COMMANDER)
          ? sec.floorZ : (vm.floorZ.get(i) ?? sec.floorZ);
        if (spr.z - daz < (8 << 8)) spr.shadowZ = daz;
      }
    }
    if (heat && !spr.removed && (isBadguy(vm, spr) || vm.stat.get(i) === STAT.DUMMY || (spr.picNum === APLAYER && spr.owner >= 0))
        && spr.picNum !== T.EXPLOSION2 && spr.picNum !== HANGLIGHT && spr.picNum !== DOMELITE && spr.picNum !== HOTMEAT) {
      spr.dispPal = 6; spr.dispShade = 0;
    } else if (!spr.removed) {
      // game.c 5884, the switch's default: a sprite in a sector with a
      // floorpal is drawn in THAT palette — the water's, the slime's; a
      // WATERBUBBLE over FLOORSLIME is pal 7. The tiles that break out of
      // the switch before the default keep their own: burning things,
      // ATOMICHEALTH, the viewscreens, the sparks, the RPG, the RECON.
      const sec = map.sectors[spr.sectNum];
      let pal;
      if (spr.picNum === T.WATERBUBBLE && sec && sec.floorPicNum === 200) pal = 7;
      else if (sec && sec.floorPal && !PAL_EXEMPT.has(spr.picNum)) pal = sec.floorPal;
      if (pal !== undefined) { spr.dispPal = pal; spr.dispShade = undefined; }
      else if (spr.dispPal !== undefined) { spr.dispPal = undefined; spr.dispShade = undefined; }
    }
    // game.c 6072: REACTOR2 shows its t[2] frame; the shells tumble — SHELL
    // alternates two tiles on T1&1, both flip on T1: 0..1 both axes, 2 y
    // only, 3 none.
    // game.c 5665: a VIEWSCREEN while some monitor is live (camsprite >= 0)
    // whose owner's T1 is 1 — a destroyed camera — shows STATIC, its flips
    // at random (rand()&12) and 8 larger each way. tspr: the tsprite's
    // changes, which the renderer lays over the sprite for this frame only.
    if (spr.picNum === T.VIEWSCREEN || spr.picNum === T.VIEWSCREEN2) {
      spr.tspr = undefined;
      if (!spr.removed && vm.camSprite >= 0 && spr.owner >= 0 && vm.fx.temp(spr.owner)[0] === 1) {
        spr.tspr = { dispPicNum: 351, dispFlip: null, cstat: spr.cstat | (Math.floor(Math.random() * 65536) & 12), xRepeat: spr.xRepeat + 8, yRepeat: spr.yRepeat + 8 };
      }
      continue;
    }
    if (!spr.removed && spr.picNum === REACTOR2) { spr.dispPicNum = REACTOR2 + vm.fx.temp(i)[2]; spr.dispFlip = null; animated++; continue; }
    if (!spr.removed && (spr.picNum === SHELL || spr.picNum === SHOTGUNSHELL)) {
      const f = vm.fx.temp(i)[0];
      spr.dispPicNum = spr.picNum === SHELL ? SHELL + (f & 1) : SHOTGUNSHELL;
      spr.dispFlip = null;
      let c = spr.cstat | 12;
      if (f > 1) c &= ~4;
      if (f > 2) c &= ~12;
      spr.cstat = c;
      animated++;
      continue;
    }
    // A gib's frame is t[0] on top of its picnum, no action and no script
    // involved — so this comes BEFORE the script gate, or a gib is never
    // looked at.
    if (!spr.removed && (JIB_TILES.has(spr.picNum) || (spr.picNum >= 2390 && spr.picNum <= 2419)) && vm.stat.get(i) === STAT.MISC) {
      spr.dispPicNum = spr.picNum + vm.fx.temp(i)[0];
      spr.dispFlip = null;
      animated++;
      continue;
    }
    if (spr.removed || !vm.hasScript(spr.picNum)) {
      if (spr.dispPicNum !== undefined) { spr.dispPicNum = undefined; spr.dispFlip = null; }
      continue;
    }
    const t = vm.fx.temp(i);
    const t4 = t[4];
    // `if(t4 > 10000)`: the source's guard against a temp_data[4] that is a
    // timer and not an address (FIX_00093). Any real address clears 10000
    // only in a large script; this file's guard is "is it an address at all".
    if (!(t4 > 0 && t4 < s.length)) {
      spr.dispPicNum = undefined; spr.dispFlip = null;
      continue;
    }
    const l = s[t4 + 2];
    let k = 0, flip = null;
    const rel = () => (spr.ang + 3072 + 128 - cam.ang) & 2047;
    switch (l) {
      case 2:
        k = (rel() >> 8) & 1;
        break;
      case 3:
      case 4:
        k = (rel() >> 7) & 7;
        if (k > 3) { flip = true; k = 7 - k; } else flip = false;
        break;
      case 5: {
        const ka = getAngle(radarang, spr.x - cam.x, spr.y - cam.y);
        k = (((spr.ang + 3072 + 128 - ka) & 2047) >> 8) & 7;
        if (k > 4) { k = 8 - k; flip = true; } else flip = false;
        break;
      }
      case 7: {
        const ka = getAngle(radarang, spr.x - cam.x, spr.y - cam.y);
        k = Math.trunc(((spr.ang + 3072 + 128 - ka) & 2047) / 170);
        if (k > 6) { k = 12 - k; flip = true; } else flip = false;
        break;
      }
      case 8:
        k = (rel() >> 8) & 7;
        flip = false;
        break;
      default:
        k = 0;
    }
    let pic = spr.picNum + k + s[t4] + l * t[3];
    if (l > 0 && art) {
      while (pic > 0 && !(art.get(pic)?.width > 0)) pic -= l;   // Hack, for actors
    }
    spr.dispPicNum = pic;
    spr.dispFlip = flip;
    animated++;
  }
  return animated;
}

/**
 * moveactors(): one tic of every scripted sprite. What execute() returns
 * `true` for is removed, as deletesprite() would. Returns how many ran.
 */
export function moveActors(map, vm, cam, pstate = null, pinput = null) {
  vm.tic = (vm.tic ?? 0) + 1;
  bumpSprites(map);                    // the sector lists: rebuilt at least once a tic (clip.js)
  if (!vm) return 0;
  vm.pstate = pstate;
  vm.pinput = pinput;
  // game.c's frame: movefta, moveweapons, (transports, players), then
  // moveexplosions, THEN moveactors.
  // vm.prof (the page's performance probe, when set): milliseconds per phase
  // and per picnum of the actor loop, summed until the page reads them.
  const P = vm.prof;
  const clock = P ? () => performance.now() : null;
  const phase = (name, f) => { if (!P) { f(); return; } const t = clock(); f(); P[name] = (P[name] ?? 0) + clock() - t; };
  phase('fta', () => moveFta(map, vm, cam));
  phase('standables', () => moveStandables(map, vm, cam, pstate));
  phase('fallers', () => moveFallers(map, vm, cam));
  phase('weapons', () => moveWeapons(map, vm, cam));
  phase('transports', () => moveTransportSprites(map, vm, cam));
  phase('explosions', () => moveExplosions(map, vm, cam));
  // One sprite's tic, as a function so its cost can be charged to its picnum.
  const one = (i) => {
    const spr = map.sprites[i];
    // actors.c 3155, the top of moveactors' loop: an awake actor (statnum 1)
    // of width 0 or with no sector is deleted — whatever made it so. Not the
    // scripted standables (CON_STANDABLES): Duke keeps them in statnum 6 and
    // runs their CON from movestandables, which has no such test; here they
    // run in this loop as actors.
    if (!spr.removed && !vm.asleep.has(i) && (spr.xRepeat === 0 || spr.sectNum < 0) && !CON_STANDABLES.has(spr.picNum)) {
      const st0 = vm.stat.get(i);
      if (st0 === STAT.ACTOR || (st0 === undefined && vm.hasScript(spr.picNum))) {
        spr.removed = true; spr.dispPicNum = undefined; vm.stat.delete(i);
        return 0;
      }
    }
    // actors.c 3988: HEAVYHBOMB is moved in C and `goto BOLT` skips its
    // script entirely — the pipe bomb, thrown or lying in the map as ammo.
    if (!spr.removed && spr.picNum === T.HEAVYHBOMB && (vm.stat.get(i) ?? STAT.ACTOR) === STAT.ACTOR) {
      moveHeavyBomb(map, vm, i, cam, pstate);
      return 0;
    }
    // actors.c 3983: BOUNCEMINE shares the pipe bomb's mover (awake: stat 1).
    if (!spr.removed && spr.picNum === 940 && vm.stat.get(i) === STAT.ACTOR) {
      moveHeavyBomb(map, vm, i, cam, pstate, 'mine');
      return 0;
    }
    // the boss's MORTER (1650): the same mover, falling and bursting on contact
    if (!spr.removed && spr.picNum === 1650 && vm.stat.get(i) === STAT.ACTOR) {
      moveHeavyBomb(map, vm, i, cam, pstate, 'morter');
      return 0;
    }
    // moveactors() moves a few unscripted actors in C: the rat.
    if (!spr.removed && spr.picNum === T.RAT && (vm.stat.get(i) ?? STAT.ACTOR) === STAT.ACTOR) { moveRat(map, vm, i, cam); return 0; }
    if (!spr.removed && CAN_TILES.has(spr.picNum) && !vm.hasScript(spr.picNum) && vm.stat.get(i) === STAT.ACTOR) { moveCan(map, vm, i, cam); return 0; }
    if (!spr.removed && spr.picNum >= 2370 && spr.picNum <= 2377 && vm.stat.get(i) === STAT.ACTOR) { moveGreenslime(map, vm, i, cam, pstate); return 0; }
    if (!spr.removed && (spr.picNum === 2491 || spr.picNum === 1346) && vm.stat.get(i) === STAT.ACTOR) { moveDukecar(map, vm, i, cam); return 0; }
    if (!spr.removed && spr.picNum === T.RECON && (vm.stat.get(i) ?? STAT.ACTOR) === STAT.ACTOR) { moveRecon(map, vm, i, cam); return 0; }
    if (!spr.removed && (spr.picNum === REACTOR || spr.picNum === REACTOR2) && vm.stat.get(i) === STAT.ACTOR) { moveReactor(map, vm, i, cam, pstate); return 0; }
    if (!spr.removed && spr.picNum === T.CAMERA1 && (vm.stat.get(i) ?? STAT.ACTOR) === STAT.ACTOR) { moveCamera(map, vm, i); return 0; }
    if (!spr.removed && (spr.picNum === T.OOZ || spr.picNum === T.OOZ2) && (vm.stat.get(i) ?? STAT.ACTOR) === STAT.ACTOR) { moveOoz(map, vm, i); return 0; }
    // The pool balls: zombies until seen (movefta), then moved in C.
    if (!spr.removed && (spr.picNum === T.QUEBALL || spr.picNum === T.STRIPEBALL) && !vm.asleep.has(i) && (vm.stat.get(i) ?? STAT.ACTOR) === STAT.ACTOR) { movePoolBall(map, vm, i, cam); return 0; }
    if (spr.removed || !vm.hasScript(spr.picNum)) return 0;
    if (vm.asleep.has(i)) return 0;
    const st = vm.stat.get(i);
    if (st !== undefined && st !== STAT.ACTOR) return 0;
    if (vm.execute(map, i, cam, playerDist(cam, spr))) {
      spr.removed = true;
      spr.dispPicNum = undefined;
    }
    return 1;
  };
  let ran = 0;
  if (!P) { for (let i = 0; i < map.sprites.length; i++) ran += one(i); }
  else {
    const byPic = P.byPic ?? (P.byPic = new Map());
    for (let i = 0; i < map.sprites.length; i++) {
      const t = clock(), pic = map.sprites[i].picNum;
      ran += one(i);
      byPic.set(pic, (byPic.get(pic) ?? 0) + clock() - t);
    }
  }
  return ran;
}

// ---------------------------------------------------------------------------
// move(), alterang(), movesprite(), makeitfall(): the actor's body after its
// script. gamedef.c 1764..2028, actors.c 626..710, gamedef.c 254..292.
// ---------------------------------------------------------------------------

/** The move flags, duke3d.h 263..274. jumptoplayer is 257 — face_player set. */
export const MF = {
  face_player: 1, geth: 2, getv: 4, random_angle: 8, face_player_slow: 16, spin: 32,
  face_player_smart: 64, fleeenemy: 128, jumptoplayer: 257, seekplayer: 512,
  furthestdir: 1024, dodgebullet: 4096,
};

/** `MAXSLEEPDIST 16384`, `SLEEPTIME 24*64`: when an actor may doze, and for how long. */
export const MAXSLEEPDIST = 16384;
export const SLEEPTIME = 24 * 64;

/** `#define FOURSLEIGHT (1<<8)` — how far above the floor a sprite rests. */
export const FOURSLEIGHT = 1 << 8;

/** `gc` from gamestartup: GRAVITATIONALCONSTANT 176. */
export const GC = 176;

/** names.h tiles badguy() lists by hand, on top of `actortype[picnum]`. */
const BADGUY_TILES = new Set([
  1550, 1960, 1880, 1741, 1742, 1682, 1715, 1725, 1744, 1681, 1680, 1820, 1920, 1921,
  2000, 675, 2001, 2045, 2120, 2150, 2160, 2165, 2420, 2630, 2710, 2760, 4740,
  2370, 2371, 2372, 2373, 2374, 2375, 2376, 2377, 1267, 2360,
]);
const LIZMAN = 2120, LIZTROOP = 1680, DRONE = 1880, COMMANDER = 1920, SHARK = 1550, OCTABRAIN = 1820;
const ROTATEGUN = 2360, ORGANTIC = 2420, APLAYER = 1405, MIRROR = 560, HANGLIGHT = 979, DOMELITE = 551, HOTMEAT = 4427;
/** The last C-moved sprites (names.h). */
const REACTOR = 1088, REACTORSPARK = 1092, REACTORBURNT = 1096, REACTOR2 = 578, REACTOR2BURNT = 579, REACTOR2SPARK = 580,
  TONGUE = 1647, INNERJAW = 1860, SHELL = 2533, SHOTGUNSHELL = 2535, TRASH = 1272, MAIL = 4410, PAPER = 4460;
const BOSS1 = 2630, BOSS2 = 2710;
/** duke3d.h AFLAMABLE: BOX, TREE1, TREE2, TIRE, CONE. */
export const AFLAMABLE = new Set([951, 908, 910, 990, 978]);
/**
 * actors.c 2385, the end of movestandables: the statnum-6 sprites whose CON
 * Duke executes there — EXPLODINGBARREL, WOODENHORSE, HORSEONSIDE,
 * FLOORFLAME, FIREBARREL, FIREVASE, NUKEBARREL(+DENTED/LEAKED),
 * TOILETWATER, RUBBERCAN, STEAM, CEILINGSTEAM, WATERBUBBLEMAKER. uDuke runs
 * them in the actor loop; moveactors' width-0 deletion (actors.c 3155)
 * does not apply to them.
 */
export const CON_STANDABLES = new Set([1238, 904, 1026, 2333, 1240, 1390, 1227, 1228, 1229, 921, 1062, 1250, 1255, 662]);

/** game.c 5362: the barrels and cans that share EXPLODINGBARREL's spawn. */
const BARREL_TILES = new Set([1238, 1239, 1062, 1232, 4580, 4581, 4582, 1026, 1240, 1227, 1228, 1229, 1390, 904]);
const CAN_TILES = new Set([1062, 1232, 4580, 4581, 4582]);
/** game.c 3637: the tiles a hitag does NOT make a faller (plus CRACK1..4). */
/** MASKWALL1..MASKWALL15 (names.h): bars, grilles, see-through panels. */
export const MASKWALLS = new Set([285, 913, 914, 915, 514, 1059, 1174, 1124, 255, 387, 391, 609, 830, 988, 1024]);

/**
 * spawn()'s case for a MASKWALL sprite, game.c 4083: `cstat = (cstat&60)|1`
 * and statnum 0 — the flips and the alignment kept, BLOCKING set, and
 * everything else cleared: the hitscan bit (256), one-sidedness (64),
 * centring, translucency. Bars stop the player but not the bullets; a
 * turret or a ceiling switch behind them can be shot through the grille.
 */
export function spawnMaskWall(spr) {
  spr.cstat = (spr.cstat & 60) | 1;
}

/**
 * The rest of spawn()'s cases for map sprites that need no actor (game.c),
 * applied after the head for the sprites boot does not hand to spawnActor:
 * MASKWALL1..15 as above; NATURALLIGHTNING invisible and not solid
 * (`cstat &= ~257; cstat |= 32768`); BLIMP solid and hittable with clipdist
 * 128; DUKETAG, SIGN1, SIGN2 and GENERICPOLE with a pal are multiplayer
 * props — gone in single player, otherwise pal 0.
 */
export function spawnDecor(spr) {
  const pn = spr.picNum;
  if (MASKWALLS.has(pn)) spawnMaskWall(spr);
  else if (pn === 4890) { spr.cstat = (spr.cstat & ~257) | 32768; }                 // NATURALLIGHTNING
  else if (pn === 3400) { spr.cstat |= 257; spr.clipDist = 128; }                    // BLIMP
  else if (pn === 4900 || pn === 4909 || pn === 4912 || pn === 977) {               // DUKETAG, SIGN1, SIGN2, GENERICPOLE
    if (spr.pal) { spr.xRepeat = 0; spr.yRepeat = 0; spr.removed = true; } else spr.pal = 0;
  }
}

/**
 * The part of spawn()'s head (game.c 3637) that every map sprite meets,
 * scripted or not. A wall/floor sprite (cstat&48) other than SPEAKER,
 * LETTER, DUCK, TARGET, TRIPBOMB, VIEWSCREEN(2) and CRACK1..4 with shade
 * 127 returns at once — no case, no header, statnum 0: true here. Else
 * `if (CS&1) CS |= 256`: blocking means hitscan-solid too. (The switch and
 * faller returns come between the two in Duke and set 257 themselves.)
 */
export function spawnHead(spr) {
  if ((spr.cstat & 48) && !FALLER_EXEMPT.has(spr.picNum) && !(spr.picNum >= 546 && spr.picNum <= 549) && spr.shade === 127) return true;
  if (spr.cstat & 1) spr.cstat |= 256;
  return false;
}

const FALLER_EXEMPT = new Set([4397, 4502, 4361, 4359, 2566, 502, 499]);   // SPEAKER LETTER DUCK TARGET TRIPBOMB VIEWSCREEN VIEWSCREEN2
/** game.c 4702..4740: the pickups whose pal marks them Dukematch-only. */
const ITEM_TILES = new Set([26, 100, 55, 59, 54, 56, 27, 57, 1348, 21, 22, 28, 23, 25, 24, 29, 49, 37, 47, 46, 45, 41, 42, 44, 61, 40, 48, 51, 53, 52]);
/** game.c 4505: the monster case of spawn(), by tile. */
const PODFEM1 = 1294, BLOODYPOLE = 1324;
/** game.c 4142: FEM1..FEM10, PODFEM1, NAKED1, STATUE, TOUGHGAL, BLOODYPOLE. */
const FEM_TILES = new Set([1312, 1317, 1321, 1325, 1323, 1334, 1395, 1336, 3450, 4864, PODFEM1, 603, 753, 4866, BLOODYPOLE]);
const MONSTER_TILES = new Set([
  4741, 2630, 2710, 2760, 4740, 2360, 2370, 2371, 2372, 2373, 2374, 2375, 2376, 2377, 1880,
  1741, 1742, 1715, 1725, 1744, 1681, 1680, 1820, 1920, 2000, 2120, 2150, 2160, 2165, 2420,
  1267, 1550,
]);
const BOSS_TILES = new Set([4741, 2630, 2710, 2760, 4740]);
/**
 * game.c 4498: the STAYPUT variants — bound to their sector, then they fall
 * THROUGH into the monster case above. Left out of MONSTER_TILES at first:
 * E1L5 places almost none, E1L1 places them everywhere, and a stayput
 * trooper without cstat 257 became a LIZTROOP by `cactor` that no shot
 * could hit. Reported from E1L1 as "killing does not work".
 */
const STAYPUT_TILES = new Set([1821, 1682, 2001, 2121, 2631, 2045, 1921, 4741]);
for (const t of STAYPUT_TILES) MONSTER_TILES.add(t);

/** Build's sintable, amplitude 16384. */
const bsin = (a) => Math.round(Math.sin(((a & 2047) * Math.PI) / 1024) * 16384);

/** badguy(): the hand list, then whatever `useractor` declared with a type. */
export function isBadguy(vm, spr) {
  return BADGUY_TILES.has(spr.picNum) || (vm.actorType.get(spr.picNum) ?? 0) !== 0;
}

/**
 * makeitfall(): an actor's gravity. NOT the player's — a sprite falls at `gc`
 * a tic (a sixth of it under water), is capped at 6144, and comes to rest
 * FOURSLEIGHT above the floor getzrange reports with a walldist of 127.
 *
 * floorz/ceilingz are kept per sprite, as hittype[] keeps them: move() reads
 * them for its z clamp, and they are only as fresh as the last fall.
 */
/**
 * CON `fall`, gamedef.c 2348 — not makeitfall: the gravity the same (gc, a
 * sixth under water or under a sky ceiling), the floor/ceiling refreshed
 * every 6 tics (cgg) or every tic on a sloped floor, and on the floor a
 * landing: a badguy (or a dead player sprite) arriving faster than 3084
 * with strength at most 1 splats — 15 JIBS6, SQUISHED, a BLOODPOOL, and
 * a SHOTSPARK1 of 1 filed; faster than 2048 on dry land, pushmove and a
 * THUD. Then the water: standing on a lotag-1 floor (the surface) every
 * actor but OCTABRAIN, COMMANDER and DRONE is set 24<<8 lower — a corpse on
 * the water lies under it, out of sight; on dry land zvel is zeroed.
 */
export function conFall(vm, map, i, cam) {
  const s = map.sprites[i];
  const sec = map.sectors[s.sectNum];
  if (!sec) return;
  s.xOffset = 0; s.yOffset = 0;
  const lt = sec.lotag & LOTAG_MASK;
  // gamedef.c 2356: no pull at all over a "space" floor, a sixth under a
  // space ceiling or under water — space meaning MOONSKY1/BIGORBIT1 parallax
  // with ceilingpal 0 (actors.c 87/101), not any sky.
  const c = floorSpace(sec) ? 0 : (ceilingSpace(sec) || lt === 2) ? Math.trunc(GC / 6) : GC;
  const cgg = vm.cgg ?? (vm.cgg = new Map());
  const left = cgg.get(i) ?? 0;
  if (left <= 0 || (sec.floorStat & 2)) { getGlobalZ(vm, map, i); cgg.set(i, 6); } else cgg.set(i, left - 1);
  const fz = vm.floorZ.get(i) ?? sec.floorZ;
  if (s.z < fz - FOURSLEIGHT) {
    s.zVel += c;
    s.z += s.zVel;
    if (s.zVel > 6144) s.zVel = 6144;
    return;
  }
  s.z = fz - FOURSLEIGHT;
  const bg = isBadguy(vm, s) || (s.picNum === APLAYER && s.owner >= 0);
  if (bg) {
    if (s.zVel > 3084 && s.extra <= 1) {
      if (s.pal !== 1 && s.picNum !== DRONE && !(s.picNum === APLAYER && s.extra > 0)) {
        guts(vm, map, i, 2286, 15);   // JIBS6
        if (vm.sounds && cam) { const n = vm.labels?.get('SQUISHED'); if (n !== undefined) vm.sounds.at(n, i, s.x, s.y, s.z, cam, map); }
        spawnFrom(vm, map, i, T.BLOODPOOL);
      }
      vm.hitPic.set(i, T.SHOTSPARK1);
      vm.hitExtra.set(i, 1);
      s.zVel = 0;
    } else if (s.zVel > 2048 && lt !== 1) {
      const p = { x: s.x, y: s.y, z: s.z, sectNum: s.sectNum };
      pushMove(map, p, 128, 4 << 8, 4 << 8, CLIPMASK0);
      s.x = p.x; s.y = p.y; if (p.sectNum >= 0) s.sectNum = p.sectNum;
      if (vm.sounds && cam) { const n = vm.labels?.get('THUD'); if (n !== undefined) vm.sounds.at(n, i, s.x, s.y, s.z, cam, map); }
    }
  }
  if (lt === 1) {
    if (s.picNum !== OCTABRAIN && s.picNum !== COMMANDER && s.picNum !== DRONE) s.z += 24 << 8;
  } else s.zVel = 0;
}

export function makeItFall(vm, map, i) {
  const s = map.sprites[i];
  const sec = map.sectors[s.sectNum];
  if (!sec) return;
  const lt = sec.lotag & LOTAG_MASK;
  // gamedef.c 259: none over a space floor, a sixth under a space ceiling
  // or under water.
  const c = floorSpace(sec) ? 0 : (ceilingSpace(sec) || lt === 2) ? Math.trunc(GC / 6) : GC;

  // gamedef.c 268: getzrange only for actors, zombies, standables and the
  // player's sprite (statnum 1, 2, 6, 10); anything else — glass, scrap, jibs
  // on statnum 5 — takes its sector's flat ceilingz and floorz.
  const st = vm.stat.get(i) ?? STAT.ACTOR;
  const zr = (st === STAT.ACTOR || st === STAT.ZOMBIE || st === STAT.STANDABLE || st === STAT.PLAYER)
    ? getZRange(map, s.x, s.y, s.z - FOURSLEIGHT, s.sectNum, 127, CLIPMASK0, { art: vm.art })
    : { florZ: sec.floorZ, ceilZ: sec.ceilingZ };
  vm.floorZ.set(i, zr.florZ);
  vm.ceilingZ.set(i, zr.ceilZ);

  if (s.z < zr.florZ - FOURSLEIGHT) {
    if (lt === 2 && s.zVel > 3122) s.zVel = 3144;
    if (s.zVel < 6144) s.zVel += c; else s.zVel = 6144;
    s.z += s.zVel;
  }
  if (s.z >= zr.florZ - FOURSLEIGHT) {
    s.z = zr.florZ - FOURSLEIGHT;
    s.zVel = 0;
  }
}

/**
 * movesprite(): move a sprite through the world with clipping.
 *
 * The one number worth knowing: the velocity is passed as
 * `(xchange*TICSPERFRAME)<<11` and clipmove divides by 16384, so a sprite
 * moves HALF of xchange per call. move() pays that back by moving a badguy
 * only every other tic with `daxvel <<= 1`. The clip radius is 1024 for a big
 * sprite, 292 for a LIZMAN, `clipdist<<2` for a useractor with a type, and
 * 192 for any other badguy; a non-badguy uses `clipdist<<2` outright.
 *
 * Returns 0 for a clean move, or the clipmove result; the "stay put" and
 * water refusals of the original are reproduced where the data exists.
 */
/**
 * setsprite(i, x, y, z), engine.c 5844: the sector only changes when
 * updatesector finds one — a point outside every sector leaves the sprite
 * where it was filed (`if (tempsectnum < 0) return(-1)`). Assigning the -1
 * put a sprite in no sector at all: E2L3's census, a DRONE pushed out of the
 * map by a neighbour's blast, spawned its explosion in sector -1 and threw.
 */
function setSpriteSect(map, s) {
  const sn = updateSector(map, s.x, s.y, s.sectNum);
  if (sn >= 0) s.sectNum = sn;
}

export function moveSprite(vm, map, i, xchange, ychange, zchange, cliptype = CLIPMASK0) {
  const s = map.sprites[i];
  const bg = isBadguy(vm, s);

  if (bg && s.xRepeat < 4) {
    // Tiny ones just drift.
    s.x += (xchange * TICS_PER_FRAME) >> 2;
    s.y += (ychange * TICS_PER_FRAME) >> 2;
    s.z += (zchange * TICS_PER_FRAME) >> 2;
    setSpriteSect(map, s);
    return 0;
  }

  const tile = vm.art?.get(s.picNum);
  const h = ((tile?.height ?? 0) * s.yRepeat) << 1;
  const pos = { x: s.x, y: s.y, z: s.z - h, sectNum: s.sectNum };
  const oldx = s.x, oldy = s.y;

  let cd;
  if (bg) {
    if (s.xRepeat > 60) cd = 1024;
    else if (s.picNum === LIZMAN) cd = 292;
    else if ((vm.actorType.get(s.picNum) ?? 0) & 3) cd = s.clipDist << 2;
    else cd = 192;
  } else if (vm.stat.get(i) === STAT.WEAPON) {
    // actors.c movesprite: a projectile (statnum 4) clips walls at 8, whatever
    // its clipdist — a SHRINKSPARK (clipdist 32) born 122 from the side of
    // E1L4's emitter niche would otherwise die on the niche's corner.
    cd = 8;
  } else {
    cd = s.clipDist << 2;
  }
  // movesprite() does NOT put the mover's own cstat away (a first version
  // did, calling it Duke's; actors.c has no such line). It matters for a
  // WALL sprite: its own clip segment lies walldist ahead of it on the side
  // it faces, so a wall-sprite faller — a street sign — cannot move
  // sideways at all: it drops where it hangs and shatters on the ground.
  // A face sprite starts inside its own box, whose edges face inward, and
  // walks out freely; that is why actors move.
  const retval = clipMove(map, pos, (xchange * TICS_PER_FRAME) << 11,
    (ychange * TICS_PER_FRAME) << 11, cd, 4 << 8, 4 << 8, cliptype, { art: vm.art });
  s.x = pos.x; s.y = pos.y;
  let dasect = pos.sectNum;

  if (bg) {
    const dsec = dasect >= 0 ? map.sectors[dasect] : null;
    const dlot = dsec ? (dsec.lotag & LOTAG_MASK) : -1;
    const stay = vm.stayPut.get(i);
    if (dasect < 0
      || (stay !== undefined && stay >= 0 && stay !== dasect)
      || (s.picNum === BOSS2 && s.pal === 0 && dlot !== 3)
      || ((s.picNum === BOSS1 || s.picNum === BOSS2) && dlot === 1)
      || (dlot === 1 && (s.picNum === LIZMAN || (s.picNum === LIZTROOP && s.zVel === 0)))) {
      s.x = oldx; s.y = oldy;
      if (dlot === 1 && s.picNum === LIZMAN) s.ang = krand(vm.fx) & 2047;
      else if ((vm.fx.temp(i)[0] & 3) === 1 && s.picNum !== COMMANDER) s.ang = krand(vm.fx) & 2047;
      setSpriteSect(map, s);
      return 16384 + Math.max(0, dasect);
    }
    // `if((retval&49152) >= 32768 && cgg==0) ang += 768` — a wall hit turns
    // the actor three-eighths round, unless the counter says otherwise.
    if (typeof retval === 'number' && (retval & 49152) >= 32768) s.ang += 768;
  }

  if (dasect >= 0 && dasect !== s.sectNum) { s.sectNum = dasect; bumpSprites(map); }   // changespritesect
  const daz = s.z + ((zchange * TICS_PER_FRAME) >> 3);
  const cz = vm.ceilingZ.get(i), fz = vm.floorZ.get(i);
  if (cz !== undefined && fz !== undefined && daz > cz && daz <= fz) s.z = daz;
  else if (retval === 0) return 16384 + dasect;
  return retval;
}

/**
 * alterang(): the steering, from the move flags and the move's speeds.
 *
 * Speed eases toward the move's xvel at a fifth a tic; zvel likewise, while it
 * is under 648. Then the flags:
 *
 *   seekplayer   turn toward lastvx/lastvy — the spot ifcansee LAST SAW the
 *                player at, not the player. The turn itself is staged by
 *                `t[0]&31`: a random jink in the first two tics, a real turn
 *                in tics 18..25, nothing in between.
 *   furthestdir  every 32 tics, face the direction with the longest clear
 *                run (furthestangle).
 *   fleeenemy    the same, once.
 *
 * Stand-ins, named: `hits()` (a hitscan along the sprite's facing) and
 * `furthestangle()` need a ray through the map that this file does not have
 * yet. The jink is kept and never undone (Duke undoes it when the way is
 * short), and the two flags leave the angle alone. Both counted in `stubbed`.
 */
export function alterAng(vm, map, i, a) {
  const s = map.sprites[i];
  const t = vm.fx.temp(i);
  const sc = vm.script;
  const mv = t[1];
  const ticselapsed = t[0] & 31;
  const aang = s.ang;

  s.xVel += Math.trunc((sc[mv] - s.xVel) / 5);
  if (s.zVel < 648) s.zVel += Math.trunc(((sc[mv + 1] << 4) - s.zVel) / 5);

  if (a & MF.seekplayer) {
    // gamedef.c 1780: a holoduke the actor can see is the one it seeks —
    // its owner, and the goal is the hologram itself, not the last-seen spot.
    const holo = vm.holoduke >= 0 ? map.sprites[vm.holoduke] : null;
    const seesHolo = holo && !holo.removed && canSee(map, holo.x, holo.y, holo.z, holo.sectNum, s.x, s.y, s.z, s.sectNum);
    const lv = vm.lastV.get(i);
    const goalang = seesHolo
      ? getAngle(vm.radarang, holo.x - s.x, holo.y - s.y)
      : lv
        ? getAngle(vm.radarang, lv.x - s.x, lv.y - s.y)
        : getAngle(vm.radarang, vm.player.x - s.x, vm.player.y - s.y);
    if (s.xVel && s.picNum !== DRONE) {
      const angdif = incAngle(aang, goalang);
      if (ticselapsed < 2) {
        if (Math.abs(angdif) < 256) {
          const j = 128 - (krand(vm.fx) & 256);
          s.ang += j;
          if (hits(vm, map, i) < 844) s.ang -= j;
        }
      } else if (ticselapsed > 18 && ticselapsed < 26) {
        if (Math.abs(angdif >> 2) < 128) s.ang = goalang;
        else s.ang += angdif >> 2;
      }
    } else {
      s.ang = goalang;
    }
  }

  if (ticselapsed < 1) {
    if (a & MF.furthestdir) s.ang = furthestAngle(vm, map, i, 2);
    if (a & MF.fleeenemy) s.ang = furthestAngle(vm, map, i, 2);
  }
  s.ang &= 2047;
}

/**
 * move(): what happens to an actor after its script, every tic.
 *
 * FIRST: `g_t[0]++`. The count that `ifcount` reads advances HERE, in the
 * body, not in the interpreter — an interpreter without move() has a count
 * that never moves, and every `ifcount` in the game is false for ever.
 *
 * Then the facing flags (face_player at a quarter of the difference a tic,
 * face_player_slow at 32 a tic, spin from the sine table, face_player_smart
 * at where the player will be), the jump, geth/getv easing at a half, the
 * steering, the "every other tic, twice as far" for badguys, the z clamps,
 * movesprite, and the badguy's shade following its sector.
 *
 * Stand-ins: dodgebullet (needs hitscan), and the player being pushed by a
 * close badguy (`ps[].posxv` — the player's own momentum is not reachable
 * from here yet). Counted.
 */
export function moveActor(vm, map, i) {
  const s = map.sprites[i];
  const t = vm.fx.temp(i);
  const sc = vm.script;
  const p = vm.player;
  let a = s.hitag;
  if (a === -1) a = 0;

  t[0]++;

  const faceAt = (gx, gy) => getAngle(vm.radarang, gx - s.x, gy - s.y);

  if (a & MF.face_player) {
    let angdif = incAngle(s.ang, faceAt(p.x, p.y)) >> 2;
    if (angdif > -8 && angdif < 0) angdif = 0;
    s.ang += angdif;
  }
  if (a & MF.spin) s.ang += bsin((t[0] << 3) & 2047) >> 6;
  if (a & MF.face_player_slow) {
    const goalang = faceAt(p.x, p.y);
    let angdif = Math.sign(incAngle(s.ang, goalang)) << 5;
    if (angdif > -32 && angdif < 0) { angdif = 0; s.ang = goalang; }
    s.ang += angdif;
  }
  if ((a & MF.jumptoplayer) === MF.jumptoplayer) {
    if (t[0] < 16) s.zVel -= bsin((512 + (t[0] << 4)) & 2047) >> 5;
  }
  if (a & MF.face_player_smart) {
    // where the player WILL be: posxv/768 ahead. The player's momentum lives
    // in player.js's state, which is not handed in; the player's position
    // stands in, and the flag is counted.
    vm.stub('face_player_smart');
    let angdif = incAngle(s.ang, faceAt(p.x, p.y)) >> 2;
    if (angdif > -8 && angdif < 0) angdif = 0;
    s.ang += angdif;
  }
  s.ang &= 2047;

  if (t[1] === 0 || a === 0) {
    // Not moving: just make sure the sector is right, as setsprite() would.
    setSpriteSect(map, s);
    return;
  }

  const mv = t[1];
  if (a & MF.geth) s.xVel += (sc[mv] - s.xVel) >> 1;
  if (a & MF.getv) s.zVel += ((sc[mv + 1] << 4) - s.zVel) >> 1;
  if (a & MF.dodgebullet) dodge(vm, map, i);

  if (s.picNum !== APLAYER) alterAng(vm, map, i, a);

  if (s.xVel > -6 && s.xVel < 6) s.xVel = 0;

  const bg = isBadguy(vm, s);

  if (s.xVel || s.zVel) {
    if (bg && s.picNum !== ROTATEGUN) {
      if ((s.picNum === DRONE || s.picNum === COMMANDER) && s.extra > 0) {
        // Flyers hold a band above the floor and below the ceiling.
        const sec = map.sectors[s.sectNum];
        if (s.picNum === COMMANDER) {
          const l = sec.floorZ; vm.floorZ.set(i, l);
          if (s.z > l - (8 << 8)) { s.z = l - (8 << 8); s.zVel = 0; }
          const c = sec.ceilingZ; vm.ceilingZ.set(i, c);
          if (s.z - c < (80 << 8)) { s.z = c + (80 << 8); s.zVel = 0; }
        } else if (s.zVel > 0) {
          const l = sec.floorZ; vm.floorZ.set(i, l);
          if (s.z > l - (30 << 8)) s.z = l - (30 << 8);
        } else {
          const c = sec.ceilingZ; vm.ceilingZ.set(i, c);
          if (s.z - c < (50 << 8)) { s.z = c + (50 << 8); s.zVel = 0; }
        }
      } else if (s.picNum !== ORGANTIC) {
        const fz = vm.floorZ.get(i);
        if (s.zVel > 0 && fz !== undefined && fz < s.z) s.z = fz;
        if (s.zVel < 0 && map.sectors[s.sectNum]) {
          const c = map.sectors[s.sectNum].ceilingZ;
          if (s.z - c < (66 << 8)) { s.z = c + (66 << 8); s.zVel >>= 1; }
        }
      }
    }

    let daxvel = s.xVel;
    let angdif = s.ang;

    if (bg && s.picNum !== ROTATEGUN) {
      if (vm.x < 960 && s.xRepeat > 16) {
        // Close enough to shove the player: the actor drives INTO them and
        // the player's momentum is damped or zeroed. The push on the
        // player's own velocity is a stand-in until player.js's state is
        // handed in; the actor's part is done.
        daxvel = -(1024 - vm.x);
        angdif = faceAt(p.x, p.y);
        vm.stub('player_shove');
      } else if (s.picNum !== DRONE && s.picNum !== SHARK && s.picNum !== COMMANDER) {
        // Every other tic, twice as far — this is what pays back movesprite
        // moving half of xchange. On the easy skills, or when the actor has
        // not moved vertically, every second tic; otherwise every fourth,
        // four times as far.
        const bposz = vm.bposZ.get(i);
        if (bposz !== s.z || vm.skill < 2) {
          if (t[0] & 1) return;
          daxvel <<= 1;
        } else {
          if (t[0] & 3) return;
          daxvel <<= 2;
        }
      }
    }

    vm.movFlag.set(i, moveSprite(vm, map, i,
      (daxvel * bsin(angdif + 512)) >> 14,
      (daxvel * bsin(angdif)) >> 14,
      s.zVel));
  }

  if (bg) {
    const sec = map.sectors[s.sectNum];
    if (sec) {
      if (sec.ceilingStat & 1) s.shade += (sec.ceilingShade - s.shade) >> 1;
      else s.shade += (sec.floorShade - s.shade) >> 1;
      if (sec.floorPicNum === MIRROR) { s.removed = true; }
    }
  }
  vm.bposZ.set(i, s.z);
}

// ---------------------------------------------------------------------------
// cansee(): a line of sight through the map. engine.c 6090..6153.
// ---------------------------------------------------------------------------

/**
 * Is (x2,y2,z2) in sect2 visible from (x1,y1,z1) in sect1?
 *
 * Walk the sectors the segment passes through, starting at sect1. Every wall
 * the segment crosses from its front side must be a portal that is not
 * one-way, and the segment's z where it crosses must lie between the floor
 * and ceiling on BOTH sides. Reach sect2 that way and the answer is yes.
 *
 * The arithmetic is Build's: the cross products are 32-bit and wrap, and the
 * two `t` tests compare as UNSIGNED — a negative t reads as huge and fails,
 * which is how "the crossing is behind the start" is expressed without a
 * sign check. Math.imul and >>>0 keep exactly that; a double-precision
 * rewrite would agree on every level in hand and disagree on a big one.
 *
 * Honesty note on the first unsigned test: reproduced from the source and
 * UNEXERCISED by any fixture here. A wall directly behind the start is
 * back-facing and already dropped by `bot <= 0`; the unsigned compare only
 * decides for a FRONT-facing wall of a later sector in the walk whose
 * crossing lies behind the start — geometry that wraps round behind you.
 *
 * divscale24 and mulscale24 are 64-bit in the engine; here the products stay
 * under 2^53 for any coordinate the map format can hold, so doubles are
 * exact and Math.trunc / Math.floor give the integer divide and the
 * arithmetic shift.
 */
export function canSee(map, x1, y1, z1, sect1, x2, y2, z2, sect2) {
  if (x1 === x2 && y1 === y2) return sect1 === sect2;
  if (sect1 < 0 || sect2 < 0) return false;

  const x21 = x2 - x1, y21 = y2 - y1, z21 = z2 - z1;
  const list = [sect1];

  for (let dacnt = 0; dacnt < list.length; dacnt++) {
    const dasect = list[dacnt];
    const sec = map.sectors[dasect];
    if (!sec) continue;
    for (let w = sec.wallPtr; w < sec.wallPtr + sec.wallNum; w++) {
      const wal = map.walls[w];
      const wal2 = map.walls[wal.point2];
      const x31 = wal.x - x1, x34 = wal.x - wal2.x;
      const y31 = wal.y - y1, y34 = wal.y - wal2.y;

      const bot = (Math.imul(y21, x34) - Math.imul(x21, y34)) | 0;
      if (bot <= 0) continue;

      let t = (Math.imul(y21, x31) - Math.imul(x21, y31)) | 0;
      if ((t >>> 0) >= (bot >>> 0)) continue;
      t = (Math.imul(y31, x34) - Math.imul(x31, y34)) | 0;
      if ((t >>> 0) >= (bot >>> 0)) continue;

      const nexts = wal.nextSector;
      if (nexts < 0 || (wal.cstat & 32)) return false;

      const t24 = Math.trunc((t * 16777216) / bot);
      const x = x1 + Math.floor((x21 * t24) / 16777216);
      const y = y1 + Math.floor((y21 * t24) / 16777216);
      const z = z1 + Math.floor((z21 * t24) / 16777216);

      let zz = getZsOfSlope(map, dasect, x, y);
      if (z <= zz.ceilZ || z >= zz.floorZ) return false;
      zz = getZsOfSlope(map, nexts, x, y);
      if (z <= zz.ceilZ || z >= zz.floorZ) return false;

      if (!list.includes(nexts)) list.push(nexts);
    }
  }
  return list.includes(sect2);
}

// ---------------------------------------------------------------------------
// hitscan(): a ray through the map. engine.c 6233..6420, walls and planes.
// ---------------------------------------------------------------------------

/** `CLIPMASK1 = 0x01000040`: walls with cstat&64 block, sprites with cstat&256. */
export const CLIPMASK1 = 0x01000040;
/** `hitscangoalx = (1<<29)-1` — where a ray that hits nothing is said to end. */
const HITSCAN_GOAL = (1 << 29) - 1;

/** rintersect(): where a ray meets a segment, or null. engine.c's own tests. */
function rayIntersect(x1, y1, z1, vx, vy, vz, x3, y3, x4, y4) {
  const x34 = x3 - x4, y34 = y3 - y4;
  const bot = vx * y34 - vy * x34;
  let topt, topu;
  const x31 = x3 - x1, y31 = y3 - y1;
  if (bot >= 0) {
    if (bot === 0) return null;
    topt = x31 * y34 - y31 * x34;
    if (topt < 0) return null;
    topu = vx * y31 - vy * x31;
    if (topu < 0 || topu >= bot) return null;
  } else {
    topt = x31 * y34 - y31 * x34;
    if (topt > 0) return null;
    topu = vx * y31 - vy * x31;
    if (topu > 0 || topu <= bot) return null;
  }
  const t = Math.trunc((topt * 65536) / bot);
  return {
    x: x1 + Math.floor((vx * t) / 65536),
    y: y1 + Math.floor((vy * t) / 65536),
    z: z1 + Math.floor((vz * t) / 65536),
  };
}

/**
 * hitscan(): from (xs,ys,zs) in sectnum along (vx,vy,vz), what is hit first?
 *
 * Walls, floors and ceilings — the half of engine.c's hitscan that the three
 * steering helpers need. Each sector on the way is tested for a ceiling hit,
 * a floor hit (both sloped or flat), and each of its walls; a hit only counts
 * if it is nearer (Manhattan) than the best so far, and a portal wall counts
 * as a hit where the ray's z is outside the far sector. A ray that meets
 * nothing ends at hitscangoalx.
 *
 * Not here: the sprite pass (cstat&256 sprites block hitscan). For hits() and
 * furthestangle() that means an enemy standing in the way does not shorten
 * the run; noted, and `stubbed` no longer counts these three.
 *
 * nsqrtasm, Build's table square root, is Math.sqrt here: on a sloped plane
 * the slope's normal may differ in its last bit from Build's, which moves a
 * hit on a steep slope by a unit at most.
 *
 * Returns { sect, wall, x, y, z } with wall -1 for a plane hit and sect -1 for
 * no hit at all.
 */
export function hitScan(map, xs, ys, zs, sectnum, vx, vy, vz, cliptype = CLIPMASK1, art = null, player = null) {
  const hit = { sect: -1, wall: -1, sprite: -1, x: HITSCAN_GOAL, y: HITSCAN_GOAL, z: 0 };
  if (sectnum < 0) return hit;
  const wallMask = cliptype & 65535;
  const sprMask = cliptype >>> 16;
  // The player has no sprite in this world, so a ray cannot meet one. When a
  // `player` is handed in, they are tested as the APLAYER face sprite would
  // be — 40x82 tile, xrepeat 42, yrepeat 36, feet at eye+PHEIGHT, in their
  // sector — and reported as sprite -2. This is what lets a pigcop's shot
  // land. The player's own shots hand in nothing.
  const pl = player && sprMask ? {
    x: player.x, y: player.y, z: player.z + (38 << 8), sectNum: player.sectNum,
    width: 40, height: 82, xRepeat: 42, yRepeat: 36,
  } : null;
  const list = [sectnum];
  // engine.c 6300/6408: `if (klabs(intx-xs)+klabs(inty-ys) > ...) continue;` —
  // a hit at the SAME distance as the one held replaces it. Walls come
  // first and sprites after, so a wall-aligned sprite flat on its wall (a
  // switch panel) wins the tie; with a strict test the wall kept it and the
  // switch could not be hit.
  const nearer = (x, y) => Math.abs(x - xs) + Math.abs(y - ys) <= Math.abs(hit.x - xs) + Math.abs(hit.y - ys);

  for (let n = 0; n < list.length; n++) {
    const dasect = list[n];
    const sec = map.sectors[dasect];
    if (!sec) continue;

    // Ceiling, then floor. A sloped plane is hit where the ray crosses it; a
    // flat one only if the ray heads toward it from the right side.
    for (const ceiling of [true, false]) {
      const stat = ceiling ? sec.ceilingStat : sec.floorStat;
      const planeZ = ceiling ? sec.ceilingZ : sec.floorZ;
      const heinum = ceiling ? sec.ceilingHeinum : sec.floorHeinum;
      let x1 = null, y1 = 0, z1 = 0;
      if (stat & 2) {
        const wal = map.walls[sec.wallPtr], wal2 = map.walls[wal.point2];
        let dax = wal2.x - wal.x, day = wal2.y - wal.y;
        const len = Math.floor(Math.sqrt(dax * dax + day * day));
        if (len === 0) continue;
        const i = Math.trunc((heinum * 32768) / len);
        dax *= i; day *= i;
        const j = (vz * 256) - Math.floor((dax * vy - day * vx) / 32768);
        if (j !== 0) {
          const ii = ((planeZ - zs) * 256) + Math.floor((dax * (ys - wal.y) - day * (xs - wal.x)) / 32768);
          if ((ii ^ j) >= 0 && (Math.abs(ii) >> 1) < Math.abs(j)) {
            const t = Math.trunc((ii * 1073741824) / j);
            x1 = xs + Math.floor((vx * t) / 1073741824);
            y1 = ys + Math.floor((vy * t) / 1073741824);
            z1 = zs + Math.floor((vz * t) / 1073741824);
          }
        }
      } else if (ceiling ? (vz < 0 && zs >= planeZ) : (vz > 0 && zs <= planeZ)) {
        z1 = planeZ;
        const i = z1 - zs;
        if ((Math.abs(i) >> 1) < Math.abs(vz)) {
          const t = Math.trunc((i * 1073741824) / vz);
          x1 = xs + Math.floor((vx * t) / 1073741824);
          y1 = ys + Math.floor((vy * t) / 1073741824);
        }
      }
      if (x1 !== null && nearer(x1, y1) && inside(map, dasect, x1, y1)) {
        hit.sect = dasect; hit.wall = -1; hit.x = x1; hit.y = y1; hit.z = z1;
      }
    }

    for (let w = sec.wallPtr; w < sec.wallPtr + sec.wallNum; w++) {
      const wal = map.walls[w], wal2 = map.walls[wal.point2];
      const x1 = wal.x, y1 = wal.y, x2 = wal2.x, y2 = wal2.y;
      // Back-facing walls are skipped by the sign of the cross product. Kept
      // as the source has it, and redundant in practice: rintersect() refuses
      // a crossing behind the start on its own, so removing this line changed
      // nothing on any fixture or level in hand.
      if ((x1 - xs) * (y2 - ys) < (x2 - xs) * (y1 - ys)) continue;
      const p = rayIntersect(xs, ys, zs, vx, vy, vz, x1, y1, x2, y2);
      if (!p) continue;
      if (!nearer(p.x, p.y)) continue;

      const nexts = wal.nextSector;
      if (nexts < 0 || (wal.cstat & wallMask)) {
        hit.sect = dasect; hit.wall = w; hit.x = p.x; hit.y = p.y; hit.z = p.z;
        continue;
      }
      const zz = getZsOfSlope(map, nexts, p.x, p.y);
      if (p.z <= zz.ceilZ || p.z >= zz.floorZ) {
        hit.sect = dasect; hit.wall = w; hit.x = p.x; hit.y = p.y; hit.z = p.z;
        continue;
      }
      if (!list.includes(nexts)) list.push(nexts);
    }

    if (pl && pl.sectNum === dasect) {
      const topt = vx * (pl.x - xs) + vy * (pl.y - ys);
      const bot = vx * vx + vy * vy;
      if (topt > 0 && bot !== 0) {
        const intz = zs + Math.trunc((vz * topt) / bot);
        const h = (pl.height * pl.yRepeat) << 2;
        if (intz <= pl.z && intz >= pl.z - h) {
          const topu = vx * (pl.y - ys) - vy * (pl.x - xs);
          const offx = Math.trunc((vx * topu) / bot), offy = Math.trunc((vy * topu) / bot);
          let i = pl.width * pl.xRepeat; i *= i;
          if (offx * offx + offy * offy <= (i >> 7)) {
            const intx = xs + Math.trunc((vx * topt) / bot), inty = ys + Math.trunc((vy * topt) / bot);
            if (nearer(intx, inty)) {
              hit.sect = dasect; hit.wall = -1; hit.sprite = -2; hit.x = intx; hit.y = inty; hit.z = intz;
            }
          }
        }
      }
    }

    // The sprite pass, engine.c 6408: every sprite in the sector whose cstat
    // carries the mask bit (256 for hitscan). A face sprite is a disc across
    // the ray — project the sprite onto the ray, check the z band of its
    // height (centred if cstat&128, shifted by the tile's picanm y-offset),
    // and the perpendicular miss must be under (width*xrepeat)^2/128. A wall
    // sprite is its rotated segment through rintersect, with the same z band.
    // A floor sprite (cstat&32) is the rectangle in its plane (case 32).
    if (sprMask && art) {
      for (let z = 0; z < map.sprites.length; z++) {
        const spr = map.sprites[z];
        if (spr.removed || spr.sectNum !== dasect) continue;
        const cstat = spr.cstat;
        if ((cstat & sprMask) === 0) continue;
        const tile = art.get(spr.picNum);
        if (!tile) continue;
        let x1 = spr.x, y1 = spr.y, z1 = spr.z;
        const yoff = tile.anim?.yOffset ?? 0;
        switch (cstat & 48) {
          case 0: {
            const topt = vx * (x1 - xs) + vy * (y1 - ys);
            if (topt <= 0) continue;
            const bot = vx * vx + vy * vy;
            if (bot === 0) continue;
            const intz = zs + Math.trunc((vz * topt) / bot);
            let i = (tile.height * spr.yRepeat) << 2;
            if (cstat & 128) z1 += i >> 1;
            if (yoff) z1 -= (yoff * spr.yRepeat) << 2;
            if (intz > z1 || intz < z1 - i) continue;
            const topu = vx * (y1 - ys) - vy * (x1 - xs);
            const offx = Math.trunc((vx * topu) / bot), offy = Math.trunc((vy * topu) / bot);
            const dist = offx * offx + offy * offy;
            i = tile.width * spr.xRepeat;
            i *= i;
            if (dist > (i >> 7)) continue;
            const intx = xs + Math.trunc((vx * topt) / bot), inty = ys + Math.trunc((vy * topt) / bot);
            if (!nearer(intx, inty)) continue;
            hit.sect = dasect; hit.wall = -1; hit.sprite = z; hit.x = intx; hit.y = inty; hit.z = intz;
            break;
          }
          case 16: {
            let xoff = (tile.anim?.xOffset ?? 0) + (spr.xOffset ?? 0);
            if (cstat & 4) xoff = -xoff;
            const k0 = spr.ang, l0 = spr.xRepeat;
            const dax = bsin(k0) * l0, day = bsin(k0 + 1536) * l0;
            const l = tile.width, k = (l >> 1) + xoff;
            const sx1 = x1 - Math.floor((dax * k) / 65536), sx2 = sx1 + Math.floor((dax * l) / 65536);
            const sy1 = y1 - Math.floor((day * k) / 65536), sy2 = sy1 + Math.floor((day * l) / 65536);
            if (cstat & 64) if ((sx1 - xs) * (sy2 - ys) < (sx2 - xs) * (sy1 - ys)) continue;
            const p = rayIntersect(xs, ys, zs, vx, vy, vz, sx1, sy1, sx2, sy2);
            if (!p) continue;
            if (!nearer(p.x, p.y)) continue;
            const kk = (tile.height * spr.yRepeat) << 2;
            let daz = (cstat & 128) ? spr.z + (kk >> 1) : spr.z;
            if (yoff) daz -= (yoff * spr.yRepeat) << 2;
            if (p.z < daz && p.z > daz - kk) {
              hit.sect = dasect; hit.wall = -1; hit.sprite = z; hit.x = p.x; hit.y = p.y; hit.z = p.z;
            }
            break;
          }
          case 32: {
            // engine.c 6501: a floor sprite is a rotated rectangle in the
            // plane z = spr.z. The ray meets that plane (it must be heading
            // toward it; a one-sided one only from its face — above unless
            // y-flipped), and the crossing point is tested against the four
            // corners with Build's even-odd edge count.
            if (vz === 0) continue;
            const intz = z1;
            if (((intz - zs) ^ vz) < 0) continue;
            if (cstat & 64) if ((zs > intz) === ((cstat & 8) === 0)) continue;
            const intx = xs + Math.trunc(((intz - zs) * vx) / vz);
            const inty = ys + Math.trunc(((intz - zs) * vy) / vz);
            if (Math.abs(intx - xs) + Math.abs(inty - ys) > Math.abs(hit.x - xs) + Math.abs(hit.y - ys)) continue;
            let xoff = (tile.anim?.xOffset ?? 0) + (spr.xOffset ?? 0);
            let yoff2 = (tile.anim?.yOffset ?? 0) + (spr.yOffset ?? 0);
            if (cstat & 4) xoff = -xoff;
            if (cstat & 8) yoff2 = -yoff2;
            const cosang = bsin(spr.ang + 512), sinang = bsin(spr.ang);
            const xspan = tile.width, yspan = tile.height;
            const dax = ((xspan >> 1) + xoff) * spr.xRepeat;
            const day = ((yspan >> 1) + yoff2) * spr.yRepeat;
            let ax = x1 + Math.floor((sinang * dax + cosang * day) / 65536) - intx;
            let ay = y1 + Math.floor((sinang * day - cosang * dax) / 65536) - inty;
            let l = xspan * spr.xRepeat;
            const bx = ax - Math.floor((sinang * l) / 65536), by = ay + Math.floor((cosang * l) / 65536);
            l = yspan * spr.yRepeat;
            const kx = -Math.floor((cosang * l) / 65536), ky = -Math.floor((sinang * l) / 65536);
            const cx = bx + kx, dx = ax + kx, cy = by + ky, dy = ay + ky;
            const edge = (px, py, qx, qy) => {
              if ((py < 0) === (qy < 0)) return 0;
              if ((px < 0) !== (qx < 0)) return ((px * qy < qx * py) !== (py < qy)) ? 1 : 0;
              return px >= 0 ? 1 : 0;
            };
            const inside = edge(ax, ay, bx, by) ^ edge(bx, by, cx, cy) ^ edge(cx, cy, dx, dy) ^ edge(dx, dy, ax, ay);
            if (inside) { hit.sect = dasect; hit.wall = -1; hit.sprite = z; hit.x = intx; hit.y = inty; hit.z = intz; }
            break;
          }
          default:
            break;
        }
      }
    }
  }
  return hit;
}

/**
 * hits(): how far the actor can see along its own facing. player.c 136.
 * The player's eye is 40<<8 up; an actor scans from its origin.
 */
export function hits(vm, map, i) {
  const s = map.sprites[i];
  const zoff = s.picNum === APLAYER ? (40 << 8) : 0;
  const h = hitScan(map, s.x, s.y, s.z - zoff, s.sectNum, bsin(s.ang + 512), bsin(s.ang), 0, CLIPMASK1, vm.art);
  return findDistance2D(h.x - s.x, h.y - s.y);
}

/** hits() for the player: from the eye (40<<8 up in Duke's sprite terms — the eye itself here). */
export function hitsFromPlayer(vm, map, cam, withWall = false) {
  const h = hitScan(map, cam.x, cam.y, cam.z, cam.sectNum, bsin(cam.ang + 512), bsin(cam.ang), 0, CLIPMASK1, vm.art);
  const dist = findDistance2D(h.x - cam.x, h.y - cam.y);
  // hitawall(): the wall met, for the mirror's use line.
  if (withWall) return { dist, wall: h.wall, sprite: h.sprite };
  return dist;
}

/**
 * furthestangle(): the direction with the longest clear run, of `angs` tried.
 * gamedef.c 1698. For anything but the player, only in the first two tics of
 * every 64 — otherwise the answer is simply "behind you".
 */
export function furthestAngle(vm, map, i, angs) {
  const s = map.sprites[i];
  const t = vm.fx.temp(i);
  if (s.picNum !== APLAYER && (t[0] & 63) > 2) return (s.ang + 1024) & 2047;
  const angincs = Math.trunc(2048 / angs);
  let greatest = -(1 << 30), furthest = s.ang;
  for (let j = s.ang; j < 2048 + s.ang; j += angincs) {
    const h = hitScan(map, s.x, s.y, s.z - (8 << 8), s.sectNum, bsin(j + 512), bsin(j), 0, CLIPMASK1, vm.art);
    const d = Math.abs(h.x - s.x) + Math.abs(h.y - s.y);
    if (d > greatest) { greatest = d; furthest = j; }
  }
  return furthest & 2047;
}

/**
 * furthestcanseepoint(): a spot near the player the actor CAN see, to head
 * for when it cannot see the player. gamedef.c 1728. Only on the first tic
 * of every 64; rays from the player at a random spread, each tested with
 * cansee back to the actor. Returns the hit sector and fills lastV, or -1.
 */
export function furthestCanSeePoint(vm, map, i, player) {
  const s = map.sprites[i];
  const t = vm.fx.temp(i);
  if (t[0] & 63) return -1;
  const angincs = vm.skill < 3 ? 1024 : Math.trunc(2048 / (1 + (krand(vm.fx) & 1)));
  for (let j = player.ang; j < 2048 + player.ang; j += (angincs - (krand(vm.fx) & 511))) {
    const h = hitScan(map, player.x, player.y, player.z - (16 << 8), player.sectNum,
      bsin(j + 512), bsin(j), 16384 - (krand(vm.fx) & 32767));
    const d = Math.abs(h.x - player.x) + Math.abs(h.y - player.y);
    const da = Math.abs(h.x - s.x) + Math.abs(h.y - s.y);
    if (d < da && canSee(map, h.x, h.y, h.z, h.sect, s.x, s.y, s.z - (16 << 8), s.sectNum)) {
      vm.lastV.set(i, { x: h.x, y: h.y });
      return h.sect;
    }
  }
  return -1;
}

/**
 * hitasprite(): how far the actor's facing runs before it hits something.
 * player.c 153. A badguy scans from 42<<8 up, the player from 39<<8; a badguy
 * whose ray meets a MASKED wall (cstat&16) is told "infinitely far" — it may
 * shoot through a grate. Returns FindDistance2D, the octagonal one.
 */
export function hitASprite(vm, map, i) {
  const s = map.sprites[i];
  const zoff = isBadguy(vm, s) ? (42 << 8) : (s.picNum === APLAYER ? (39 << 8) : 0);
  // With the player as a target (sprite -2): in Duke the ray meets the
  // APLAYER sprite, and both ifcanshoottarget and the trip bomb's beam
  // depend on it — a player standing in the beam is what shortens it.
  const h = hitScan(map, s.x, s.y, s.z - zoff, s.sectNum, bsin(s.ang + 512), bsin(s.ang), 0, CLIPMASK1, vm.art, vm.player);
  vm.lastHitSprite = h.sprite;
  if (h.wall >= 0 && (map.walls[h.wall].cstat & 16) && isBadguy(vm, s)) return 1 << 30;
  return findDistance2D(h.x - s.x, h.y - s.y);
}

/**
 * movefta(): wake the dozing. actors.c. Every sleeping sprite's counter climbs
 * one a tic, and once it passes `distance>>8` the actor gets a look at the
 * player — a jittered line of sight for a badguy — and wakes if it lands.
 * Otherwise the counter goes back to zero and the wait begins again. A
 * player farther than 30000 is not looked for at all.
 */
/**
 * The holoduke, sector.c 2822 and actors.c 1264. Toggling it with charge
 * left: an APLAYER sprite at the player, 30<<8 down, shade -64, size 0,
 * the player's angle, owner -1, quote 47 (49 with no charge), TELEPORTER;
 * off: TELEPORTER, quote 48. While on, a unit of charge a tic (2400 full);
 * at zero it goes out by itself with TELEPORTER. Each tic the hologram
 * grows 4 a tic to 42x36 (translucent, cstat 2, until wide enough),
 * falls (not under water), sinks 32<<8 on a water surface, faces the
 * player's way for eight tics then its mirror (2047-ang), and takes the
 * floor's shade. Returns the quote to show.
 */
export function toggleHoloduke(vm, map, cam, pl, sounds) {
  const say = (name, sprite, x, y, z) => { const n = vm.labels?.get(name); if (n !== undefined && sounds) sounds.at(n, sprite, x, y, z, cam, map); };
  if (vm.holoduke < 0 || vm.holoduke === undefined) {
    if (pl.inventory?.holoduke > 0) {
      const i = makeSprite(vm, map, cam.sectNum, cam.x, cam.y, cam.z + (30 << 8), APLAYER, -64, 0, 0, cam.ang, 0, 0, -1, STAT.MISC);
      const sp = map.sprites[i];
      sp.extra = 0; sp.cstat = 0;
      vm.fx.temp(i).fill(0);
      vm.holoduke = i;
      // statnum 10, as Duke's EGS(..., 10): moveplayers' owner < 0 branch
      // moves it (holodukeTic) and never executes the APLAYER script.
      vm.stat.set(i, STAT.PLAYER);
      pl.holodukeOn = i;
      say('TELEPORTER', i, sp.x, sp.y, sp.z);
      return 47;
    }
    say('TELEPORTER', -2, cam.x, cam.y, cam.z);
    return 49;
  }
  const h = map.sprites[vm.holoduke];
  if (h) say('TELEPORTER', vm.holoduke, h.x, h.y, h.z);
  removeHoloduke(vm, map, pl);
  return 48;
}

export function removeHoloduke(vm, map, pl) {
  const i = vm.holoduke;
  if (i >= 0 && map.sprites[i]) { map.sprites[i].removed = true; vm.stat.delete(i); }
  vm.holoduke = -1;
  if (pl) pl.holodukeOn = -1;
}

export function holodukeTic(vm, map, cam, pl, sounds) {
  const i = vm.holoduke;
  if (!(i >= 0)) return;
  const s = map.sprites[i];
  if (!s || s.removed) { vm.holoduke = -1; if (pl) pl.holodukeOn = -1; return; }
  // player.c 2196: the charge
  if (pl?.inventory) {
    pl.inventory.holoduke--;
    if (pl.inventory.holoduke <= 0) {
      pl.inventory.holoduke = 0;
      const n = vm.labels?.get('TELEPORTER'); if (n !== undefined && sounds) sounds.at(n, -2, cam.x, cam.y, cam.z, cam, map);
      removeHoloduke(vm, map, pl);
      return;
    }
  }
  s.cstat = 0;
  if (s.xRepeat < 42) { s.xRepeat += 4; s.cstat |= 2; } else s.xRepeat = 42;
  if (s.yRepeat < 36) s.yRepeat += 4;
  else {
    s.yRepeat = 36;
    const lt = (map.sectors[s.sectNum]?.lotag ?? 0) & LOTAG_MASK;
    if (lt !== 2) makeItFall(vm, map, i);
    if (s.zVel === 0 && lt === 1) s.z += 32 << 8;
  }
  if (s.extra < 8) { s.xVel = 128; s.ang = cam.ang; s.extra++; }
  else { s.ang = (2047 - cam.ang) & 2047; const sn = updateSector(map, s.x, s.y, s.sectNum); if (sn >= 0) s.sectNum = sn; }
  const sec = map.sectors[s.sectNum];
  if (sec) s.shade += (((sec.ceilingStat & 1) ? sec.ceilingShade : sec.floorShade) - s.shade) >> 1;
}

/**
 * check_fta_sounds(), game.c 1232 — a monster's first-sight roar, on its
 * waking: the LIZTROOP family PRED_RECOG, LIZMAN CAPT_RECOG, the pigs
 * PIG_RECOG, RECON, DRONE, COMMANDER and ORGANTIC (TURR_RECOG) theirs, the
 * octabrains OCTA_RECOG — each from the sprite; the bosses global: BOSS1
 * BOS1_RECOG, BOSS2 BOS2_RECOG (pal 1) or WHIPYOURASS, BOSS3 BOS3_RECOG (pal
 * 1) or RIPHEADNECK, BOSS4 BOS4_RECOG (pal 1) and BOSS4_FIRSTSEE. Only a
 * live one (extra > 0).
 */
export function checkFtaSounds(vm, map, i, cam) {
  const s = map.sprites[i];
  if (!s || s.removed || !(s.extra > 0) || !vm.sounds || !cam) return;
  const L = vm.labels; if (!L) return;
  const at = (name) => { const n = L.get(name); if (n !== undefined) vm.sounds.at(n, i, s.x, s.y, s.z, cam, map); };
  const glob = (name) => { const n = L.get(name); if (n !== undefined) vm.sounds.global(n); };
  const pn = s.picNum;
  if (pn === 1680 || pn === 1681 || pn === 1715 || pn === 1725 || pn === 1741 || pn === 1742 || pn === 1744) at('PRED_RECOG');   // LIZTROOP, RUNNING, SHOOT, JETPACK, ONTOILET, JUSTSIT, DUCKING (not STAYPUT 1705 — Duke's list has none)
  else if (pn === LIZMAN || pn === 2150 || pn === 2160 || pn === 2165) at('CAPT_RECOG');
  else if (pn === 2000 || pn === 2045) at('PIG_RECOG');
  else if (pn === 1960) at('RECO_RECOG');
  else if (pn === DRONE) at('DRON_RECOG');
  else if (pn === COMMANDER || pn === 1921) at('COMM_RECOG');
  else if (pn === 2420) at('TURR_RECOG');
  else if (pn === OCTABRAIN || pn === 1821) at('OCTA_RECOG');
  else if (pn === 2370) at('SLIM_RECOG');                                   // GREENSLIME (game.c 1294)
  else if (pn === BOSS1) glob('BOS1_RECOG');
  else if (pn === BOSS2) glob(s.pal === 1 ? 'BOS2_RECOG' : 'WHIPYOURASS');
  else if (pn === 2760) glob(s.pal === 1 ? 'BOS3_RECOG' : 'RIPHEADNECK');
  else if (pn === 4740 || pn === 4741) { if (s.pal === 1) glob('BOS4_RECOG'); glob('BOSS4_FIRSTSEE'); }
}

export function moveFta(map, vm, cam) {
  let woke = 0;
  for (const i of vm.asleep) {
    const s = map.sprites[i];
    if (!s || s.removed) { vm.asleep.delete(i); continue; }
    const x = playerDist(cam, s);
    if (x >= 30000) continue;
    const tts = (vm.timeToSleep.get(i) ?? 0) + 1;
    vm.timeToSleep.set(i, tts);
    if (tts < (x >> 8)) continue;
    let j;
    if (isBadguy(vm, s)) {
      const px = cam.x + 64 - (krand(vm.fx) & 127), py = cam.y + 64 - (krand(vm.fx) & 127);
      const psect = updateSector(map, px, py, cam.sectNum);
      if (psect < 0) continue;
      const sx = s.x + 64 - (krand(vm.fx) & 127), sy = s.y + 64 - (krand(vm.fx) & 127);
      j = canSee(map, sx, sy, s.z - (krand(vm.fx) % (52 << 8)), s.sectNum,
        px, py, cam.z - (krand(vm.fx) % (32 << 8)), cam.sectNum);
    } else {
      j = canSee(map, s.x, s.y, s.z - ((krand(vm.fx) & 31) << 8), s.sectNum,
        cam.x, cam.y, cam.z - ((krand(vm.fx) & 31) << 8), cam.sectNum);
    }
    vm.timeToSleep.set(i, 0);
    if (j) {
      vm.asleep.delete(i); woke++;
      // movefta 1060: the cans, barrels, horses and a TRIPBOMB wake into
      // statnum 6 (movestandables), taking the sector's shade; everything
      // else into statnum 1.
      if (WAKE_TO_STANDABLE.has(s.picNum)) {
        const sec = map.sectors[s.sectNum];
        if (sec) s.shade = (sec.ceilingStat & 1) ? sec.ceilingShade : sec.floorShade;
        vm.stat.set(i, STAT.STANDABLE);
      } else {
        // movefta's default: `check_fta_sounds(i)` — the monster's
        // first-sight roar — then `changespritestat(i,1)`: a dozer (statnum
        // 2) becomes an actor. Monsters here doze with no stat filed at
        // all; a BOUNCEMINE is filed ZOMBIE by its spawn and moves only as 1.
        checkFtaSounds(vm, map, i, cam);
        if (vm.stat.get(i) === STAT.ZOMBIE) vm.stat.set(i, STAT.ACTOR);
      }
    }
  }
  return woke;
}

// ---------------------------------------------------------------------------
// Making sprites: EGS(), spawn(), shoot(), moveweapons(), moveexplosions().
// game.c 3470..3540 and 3604.., player.c 313.., actors.c 2521.. and 4395..
// ---------------------------------------------------------------------------

/** names.h tiles this file spawns or shoots. */
// Every number here is from names.h, looked up — not remembered. The first
// version of this table had COOLEXPLOSION1, SPIT and TRANSPORTERBEAM wrong
// from memory, and the only symptom was a projectile that never flew.
export const T = {
  TRANSPORTERSTAR: 1630, TRANSPORTERBEAM: 1261, FRAMEEFFECT1: 4095, FRAMEEFFECT1_13CON: 3999,
  FIRELASER: 1625, COOLEXPLOSION1: 1360, SPIT: 1636, SHOTSPARK1: 2595, SHOTGUN: 2613,
  CHAINGUN: 2536, RPG: 2605, APLAYER: 1405, HEAVYHBOMB: 26, TRIPBOMB: 2566, LASERLINE: 2567,
  HANDHOLDINGLASER: 2563, KNEE: 2521, WATERFOUNTAIN: 563, SHRINKSPARK: 1646, SHRINKER: 2556, FREEZEBLAST: 1641,
  GROWSPARK: 2448, SHRINKEREXPLOSION: 1656, SEENINE: 1247, SEENINEDEAD: 1248, OOZFILTER: 1079,
  EXPLODINGBARREL: 1238, GLASSPIECES: 1031, BURNING: 2270, BURNING2: 2310, TIRE: 990, BOX: 951, BLOODPOOL: 1226, RAT: 1267, FIREEXT: 916, NUKEBUTTON: 142, RECON: 1960, LOCATORS: 6, PIGCOP: 2000, EXPLOSION2: 1890, EXPLOSION2BOT: 2219, SMALLSMOKE: 2329,
  RADIUSEXPLOSION: 1670, MIRROR: 560, STRIPEBALL: 901, QUEBALL: 902, POCKET: 903, CAMERA1: 621, CAMERAPOLE: 554, VIEWSCREEN: 502, VIEWSCREEN2: 499, WATERDRIP: 660, MONEY: 1233, JIBS2: 2250, COMMANDER_T: 1920, BLOOD: 1620, BLOODSPLAT1: 2296, BLOODSPLAT3: 2297, BLOODSPLAT2: 2298, BLOODSPLAT4: 2299, PUKE: 4389, FECES: 4409, NUKEBARREL: 1227, BIGFORCE: 1497, NEWBEAST: 4610, OOZ: 2300, OOZ2: 2309, FORCERIPPLE: 1671, WATERBUBBLE: 661, WATERSPLASH2: 1380, BOLT1: 634, SIDEBOLT1: 4525, HURTRAIL: 859, NEON1: 925, NEON2: 926, NEON3: 1007, NEON4: 1008, NEON5: 1009, NEON6: 1046,   // 1670 — a first table said 1594, and every `ifwasweapon RADIUSEXPLOSION` in the CON missed for it
};
/** Duke's statnums, as far as they matter here: actors, weapons, misc. */
export const STAT = { ACTOR: 1, ZOMBIE: 2, WEAPON: 4, MISC: 5, STANDABLE: 6, PLAYER: 10, FALLER: 12, DUMMY: 13 };

/**
 * EGS(): make a sprite. game.c 3470. Every field is set — a fresh sprite has
 * cstat 0, pal 0, no offsets, no tags — and the CON header is seeded the way
 * spawnActor does it, because that is what EGS does for any picnum with a
 * script. `hittype.picnum` becomes the spawner's picnum (`ifspawnedby`), the
 * floor and ceiling are copied from the spawner, and the new sprite starts
 * awake. Returns the index; a removed slot is reused before the list grows.
 */
export function makeSprite(vm, map, sect, x, y, z, pic, shade, xr, yr, ang, xvel, zvel, owner, stat) {
  let i = map.sprites.findIndex((s) => s.removed);
  const spr = {
    x, y, z, sectNum: sect, picNum: pic, shade, xRepeat: xr, yRepeat: yr, pal: 0, ang: ang & 2047,
    xVel: xvel, zVel: zvel, yVel: 0, owner, xOffset: 0, yOffset: 0, clipDist: 0, lotag: 0, hitag: 0,
    extra: 0, cstat: 0, statNum: stat, removed: false,
    // `align` is what readMap derives from cstat&48 and what the renderer
    // dispatches on; a fresh sprite is a face sprite. Leave it out and the
    // sprite exists, moves, hits — and is drawn nowhere.
    align: 0, dispPicNum: undefined, dispFlip: null,
  };
  if (i < 0) { i = map.sprites.length; map.sprites.push(spr); } else map.sprites[i] = spr;
  bumpSprites(map);                                     // insertsprite: the sector lists change
  vm.fx.temp(i).fill(0);
  // EGS: `hittype[i].floorz = sector[sect].floorz; ceilingz = ...` — what
  // movesprite bounds a sprite by until something calls getzrange for it.
  if (vm.floorZ && vm.ceilingZ && map.sectors[sect]) { vm.floorZ.set(i, map.sectors[sect].floorZ); vm.ceilingZ.set(i, map.sectors[sect].ceilingZ); }
  // A reused slot carries nothing of its last tenant: not an effector-list
  // entry (a self-killed SE13 kept its place there and ran the next sprite
  // in that slot as an effector), not a sleep, not a filing.
  if (vm.fx.list) { const k = vm.fx.list.indexOf(i); if (k >= 0) vm.fx.list.splice(k, 1); }
  vm.asleep?.delete(i); vm.hitExtra?.delete(i); vm.hitPic?.delete(i); vm.stayPut?.delete(i); vm.lastVx?.delete(i); vm.spawnedBy?.delete(i);
  // The projectile log for the page's probe: birth of every weapon sprite.
  if (stat === STAT.WEAPON && (pic === T.RPG || pic === T.SHRINKSPARK || pic === T.FREEZEBLAST)) {
    if (!vm.projLog) vm.projLog = [];
    vm.projLog.push({ i, pic, born: vm.tic ?? 0, sect, x, y, z, end: null });
    if (vm.projLog.length > 6) vm.projLog.shift();
  }
  vm.stat.set(i, stat);
  vm.timeToSleep.delete(i); vm.asleep.delete(i); vm.stayPut.delete(i); vm.lastV.delete(i);
  vm.movFlag.delete(i);
  const own = map.sprites[owner];
  vm.spawnedBy.set(i, own ? own.picNum : pic);
  if (own) {
    vm.floorZ.set(i, vm.floorZ.get(owner) ?? map.sectors[sect]?.floorZ ?? 0);
    vm.ceilingZ.set(i, vm.ceilingZ.get(owner) ?? map.sectors[sect]?.ceilingZ ?? 0);
  }
  const h = vm.actorScr.get(pic);
  if (h !== undefined) {
    const t = vm.fx.temp(i);
    spr.extra = vm.script[h];
    t[4] = vm.script[h + 1];
    t[1] = vm.script[h + 2];
    spr.hitag = vm.script[h + 3];
  }
  return i;
}

/**
 * spawn(j, pn): a sprite spawned BY sprite j. game.c 3604 — EGS at the
 * spawner's position with size 0, then the big switch gives it its shape.
 * Two cases are here, the ones the shipped E1L5 asks for at run time; any
 * other picnum comes out sized 0 (invisible) and is counted in
 * `spawnUnhandled`, which is the list of what to write next.
 */
export function spawnFrom(vm, map, j, pn) {
  const parent = map.sprites[j];
  if (!parent) return -1;
  const i = makeSprite(vm, map, parent.sectNum, parent.x, parent.y, parent.z, pn, 0, 0, 0, 0, 0, 0, j, STAT.ACTOR);
  const sp = map.sprites[i];
  const pstat = vm.stat.get(j) ?? STAT.ACTOR;
  const t = vm.fx.temp(i);

  switch (pn) {
    case T.FRAMEEFFECT1:
    case T.FRAMEEFFECT1_13CON:
      // An afterimage: the spawner's size, and T2 remembers whose.
      sp.xRepeat = parent.xRepeat;
      sp.yRepeat = parent.yRepeat;
      t[1] = parent.picNum;
      vm.stat.set(i, STAT.MISC);
      break;

    case T.TRANSPORTERSTAR:
    case T.TRANSPORTERBEAM:
      if (pn === T.TRANSPORTERBEAM) {
        sp.xRepeat = 31; sp.yRepeat = 1;
        sp.z = map.sectors[parent.sectNum].floorZ - (40 << 8);
      } else if (pstat === STAT.WEAPON) {
        sp.xRepeat = 8; sp.yRepeat = 8;
      } else {
        sp.xRepeat = 48; sp.yRepeat = 64;
        if (pstat === STAT.PLAYER || isBadguy(vm, parent)) sp.z -= 32 << 8;
      }
      sp.shade = -127;
      sp.cstat = 128 | 2;
      sp.ang = parent.ang;
      sp.xVel = 128;
      vm.stat.set(i, STAT.MISC);
      // `ssp(i, CLIPMASK0)`: one step of its xvel along its angle.
      moveSprite(vm, map, i, (sp.xVel * bsin(sp.ang + 512)) >> 14, (sp.xVel * bsin(sp.ang)) >> 14, sp.zVel);
      break;

    case T.LASERLINE:
      // game.c: a 32x6 wall sprite (lasermode 0), turned across the beam
      // (the bomb's T6 + 512), misc.
      sp.yRepeat = 6; sp.xRepeat = 32; sp.cstat = 16;
      sp.ang = (vm.fx.temp(j)[5] + 512) & 2047;
      vm.stat.set(i, STAT.MISC);
      break;

    case T.EXPLOSION2:
    case T.EXPLOSION2BOT:
    case T.SMALLSMOKE:
    case T.SHRINKEREXPLOSION:
    case T.BURNING:
    case T.BURNING2:
      // game.c 4293 (BURNING2 with BURNING): the parent's angle, shade -64, a
      // random x-flip; an explosion is 48x48 at shade -127 and translucent;
      // smoke 24x24. Held at least 12<<8 above the floor. Misc sprites, their
      // CON actors run (EXPLOSION_FRAMES for 20 counts, SMOKEFRAMES for 4).
      sp.ang = parent.ang;
      sp.shade = -64;
      sp.cstat = 128 | (krand(vm.fx) & 4);
      if (pn === T.SMALLSMOKE) { sp.xRepeat = 24; sp.yRepeat = 24; }
      else if (pn === T.SHRINKEREXPLOSION) { sp.xRepeat = 32; sp.yRepeat = 32; }
      else if (pn === T.BURNING || pn === T.BURNING2) { sp.xRepeat = 4; sp.yRepeat = 4; }
      else { sp.xRepeat = 48; sp.yRepeat = 48; sp.shade = -127; sp.cstat |= 128; }
      {
        const fz = getZsOfSlope(map, sp.sectNum, sp.x, sp.y).floorZ;
        if (sp.z > fz - (12 << 8)) sp.z = fz - (12 << 8);
      }
      vm.stat.set(i, STAT.MISC);
      break;

    case T.WATERSPLASH2:
      // game.c 3749: a splash — at its parent, 8..15 square, shade -16,
      // centred. Born in a lotag-2 sector it sits 16<<8 under that
      // sector's ceiling, y-flipped (the underside of the surface); born in
      // a lotag-1 sector it is put ON the floor — the water's surface — no
      // matter how high the parent was (game.c 3766: the line the first
      // reading of this case stopped short of; a diving projectile's splash
      // "flew" at the projectile's own height). Over FLOORSLIME pal 7.
      sp.x = parent.x; sp.y = parent.y; sp.z = parent.z;
      sp.xRepeat = sp.yRepeat = 8 + (krand(vm.fx) & 7);
      sp.shade = -16;
      sp.cstat |= 128;
      {
        const plot = (map.sectors[parent.sectNum]?.lotag ?? 0) & LOTAG_MASK;
        if (plot === 2) {
          sp.z = getZsOfSlope(map, sp.sectNum, sp.x, sp.y).ceilZ + (16 << 8);
          sp.cstat |= 8;
        } else if (plot === 1) {
          sp.z = getZsOfSlope(map, sp.sectNum, sp.x, sp.y).floorZ;
        }
        const own = map.sectors[sp.sectNum];
        if (own && (own.floorPicNum === 200 || own.ceilingPicNum === 200)) sp.pal = 7;
      }
      vm.stat.set(i, STAT.MISC);
      break;

    case T.WATERBUBBLE:
      // game.c 4365: a bubble — 4x4, the parent's angle, 16<<8 up off a
      // player; its own CON actor (WATERBUBBLE) floats it. A misc sprite.
      sp.xRepeat = 4; sp.yRepeat = 4;
      sp.ang = parent.ang;
      if (parent.picNum === APLAYER) sp.z -= 16 << 8;
      vm.stat.set(i, STAT.MISC);
      break;

    case T.BLOOD:
      // game.c 3894: a blood puff — 16x16, 26<<8 up, pal 6 off a pal-6
      // parent, a misc sprite whose CON actor animates it.
      sp.xRepeat = 16; sp.yRepeat = 16;
      sp.z -= 26 << 8;
      if (parent.pal === 6) sp.pal = 6;
      vm.stat.set(i, STAT.MISC);
      break;

    case T.BLOODPOOL:
    case T.PUKE: {
      // game.c 3901: a pool needs level floor all round — the four points
      // 108 out must lie in sectors whose floor is the pool's, else it is
      // sized 0. No pool on a water surface (lotag 1). The colour is the
      // parent's: pal 1 stays 1; a plain parent bleeds red (2), FECES brown
      // (7); pal 6, a NUKEBARREL or a TIRE give green (0), and a TIRE's is
      // shade 127. Floor-aligned (cstat 32), size 1 — moveExplosions grows
      // it to 32.
      const fz = map.sectors[sp.sectNum]?.floorZ;
      let level = true;
      for (const [dx, dy] of [[108, 108], [-108, -108], [108, -108], [-108, 108]]) {
        const s1 = updateSector(map, sp.x + dx, sp.y + dy, sp.sectNum);
        if (s1 < 0 || map.sectors[s1].floorZ !== fz) { level = false; break; }
      }
      if (!level) { sp.xRepeat = sp.yRepeat = 0; vm.stat.set(i, STAT.MISC); break; }
      if ((map.sectors[sp.sectNum].lotag & LOTAG_MASK) === 1) { vm.stat.set(i, STAT.MISC); break; }
      if (pn !== T.PUKE) {
        if (parent.pal === 1) sp.pal = 1;
        else if (parent.pal !== 6 && parent.picNum !== T.NUKEBARREL && parent.picNum !== T.TIRE) sp.pal = parent.picNum === T.FECES ? 7 : 2;
        else sp.pal = 0;
        if (parent.picNum === T.TIRE) sp.shade = 127;
      }
      sp.cstat |= 32;
      sp.xRepeat = sp.yRepeat = 1;
      if (!vm.poolParent) vm.poolParent = new Map();
      vm.poolParent.set(i, parent.picNum);              // hittype[i].picnum, for the TIRE's 10 prints and 64 size
      vm.stat.set(i, STAT.MISC);
      break;
    }

    case 550: case 672: case 673: case 674: {
      // game.c 4019: FOOTPRINTS1..4 — level floor all round (84 out), else
      // sized 0; floor-aligned, x-flipped on every other print (the count's
      // low bit), the walker's angle, on the sector's floor, 32 wide off
      // water (in a lotag-1/2 sector left at 0), queued, misc.
      const fz = map.sectors[sp.sectNum]?.floorZ;
      let level = true;
      for (const [dx, dy] of [[84, 84], [-84, -84], [84, -84], [-84, 84]]) {
        const s1 = updateSector(map, sp.x + dx, sp.y + dy, sp.sectNum);
        if (s1 < 0 || map.sectors[s1].floorZ !== fz) { level = false; break; }
      }
      if (!level) { sp.xRepeat = sp.yRepeat = 0; vm.stat.set(i, STAT.MISC); break; }
      sp.cstat = 32 + (((vm.pstate?.footprintCount ?? 0) & 1) << 2);
      sp.ang = parent.ang;
      sp.z = fz;
      const lt = (map.sectors[sp.sectNum]?.lotag ?? 0) & LOTAG_MASK;
      if (lt !== 1 && lt !== 2) sp.xRepeat = sp.yRepeat = 32;
      vm.stat.set(i, STAT.MISC);
      break;
    }

    case T.BLOODSPLAT1: case T.BLOODSPLAT2: case T.BLOODSPLAT3: case T.BLOODSPLAT4:
      // game.c 3955: a splat on a wall — wall-aligned (cstat 16), 7..14
      // square, 16<<8 up, pal 6 off a pal-6 parent; it runs down the wall
      // in moveExplosions.
      sp.cstat |= 16;
      sp.xRepeat = 7 + (krand(vm.fx) & 7);
      sp.yRepeat = 7 + (krand(vm.fx) & 7);
      sp.z -= 16 << 8;
      if (parent.pal === 6) sp.pal = 6;
      vm.stat.set(i, STAT.MISC);
      break;

    case T.OOZ:
    case T.OOZ2: {
      // game.c 4645: a slime stream from ceiling to floor — shade -12, pal 8
      // off a NUKEBARREL, an actor; getglobalz, then yrepeat = the gap>>9
      // and xrepeat = 25 - half of that, a random x-flip. moveActors keeps
      // it stretched between the planes (moveOoz).
      sp.shade = -12;
      if (parent.picNum === T.NUKEBARREL) sp.pal = 8;
      vm.stat.set(i, STAT.ACTOR);
      getGlobalZ(vm, map, i);
      const j = ((vm.floorZ.get(i) ?? sp.z) - (vm.ceilingZ.get(i) ?? sp.z)) >> 9;
      sp.yRepeat = j & 255;
      sp.xRepeat = (25 - (j >> 1)) & 255;
      sp.cstat |= krand(vm.fx) & 4;
      break;
    }

    case 2370: case 2371: case 2372: case 2373:                            // GREENSLIME (game.c 4512)
    case 2374: case 2375: case 2376: case 2377:
      // An EGG's `spawn GREENSLIME` (GAME.CON 3031). No CON, so the default
      // arm below never saw it and the slimer hatched at size 0. spawnActor's
      // placed-sprite branch has the shape (40x40, clipdist 80, cstat 257,
      // strength 1); a spawned one is awake at once (statnum 1), lotag 0,
      // timetosleep 0, and roars (check_fta_sounds, game.c 4614).
      vm.spawnActor(sp, i, map, true);
      sp.lotag = 0;
      vm.timeToSleep.set(i, 0);
      vm.asleep.delete(i);
      vm.stat.set(i, STAT.ACTOR);
      checkFtaSounds(vm, map, i, vm.player);
      break;

    case SHELL:
    case SHOTGUNSHELL: {
      // game.c 4242: from the player — beside him (a = ang - (rand&63) + 8),
      // at his gun height (6<<8 for the shotgun's, 3<<8 for a SHELL, minus
      // the pitch <<4), zvel up to -255, T1 a coin for the frame; from
      // anything else at its angle, PHEIGHT below its top plus 3<<8. Then
      // shade -8, angle a-512 (out to the side), speed 20, size 4, misc.
      const par = map.sprites[j];
      let a = sp.ang;
      if (par && par.picNum === APLAYER && vm.player) {
        const cam = vm.player;
        a = (cam.ang - (krand(vm.fx) & 63) + 8) & 2047;
        vm.fx.temp(i)[0] = krand(vm.fx) & 1;
        const horizoff = (cam.horiz ?? 100) - 100;
        sp.z = (pn === SHOTGUNSHELL ? (6 << 8) : (3 << 8)) + Math.round(cam.z) - (horizoff << 4);
        sp.zVel = -(krand(vm.fx) & 255);
        sp.x = Math.round(cam.x) + (bsin(a + 512) >> 7);
        sp.y = Math.round(cam.y) + (bsin(a) >> 7);
      } else if (par) {
        sp.z = par.z - (38 << 8) + (3 << 8);
        sp.x = par.x + (bsin(a + 512) >> 7);
        sp.y = par.y + (bsin(a) >> 7);
      }
      { const sn = updateSector(map, sp.x, sp.y, sp.sectNum); if (sn >= 0) sp.sectNum = sn; }
      sp.shade = -8;
      sp.ang = (a - 512) & 2047;
      sp.xVel = 20;
      sp.xRepeat = sp.yRepeat = 4;
      vm.stat.set(i, STAT.MISC);
      break;
    }

    case TONGUE:
      // game.c 3802: the parent's angle, 38<<8 up, a random zvel and xvel; a projectile (statnum 4).
      if (map.sprites[j]) sp.ang = map.sprites[j].ang;
      sp.z -= 38 << 8;
      sp.zVel = 256 - (krand(vm.fx) & 511);
      sp.xVel = 64 - (krand(vm.fx) & 127);
      vm.stat.set(i, STAT.WEAPON);
      break;

    case TRASH:
      // game.c 4443: any angle, 24x24, a standable.
      sp.ang = krand(vm.fx) & 2047;
      sp.xRepeat = sp.yRepeat = 24;
      vm.stat.set(i, STAT.STANDABLE);
      break;

    case REACTOR:
    case REACTOR2:
      vm.spawnActor(sp, i, map, true);
      break;

    case 1267:                                                             // RAT (game.c 4595)
      // Out of a blasted can: a random heading, 48x48, not solid, an actor
      // whose script scurries off and dies.
      sp.ang = krand(vm.fx) & 2047;
      sp.xRepeat = 48; sp.yRepeat = 48;
      sp.cstat = 0;
      vm.stat.set(i, STAT.ACTOR);
      makeItFall(vm, map, i);
      break;

    case 2245: case 2250: case 2255: case 2260: case 2265: case 2286:     // JIBS1..6 (DEFS.CON: five frames apart, not consecutive)
    case 1768: case 1772: case 1776:                                       // HEADJIB1, ARMJIB1, LEGJIB1
    case 2201: case 2205: case 2209:                                       // LIZMANHEAD1, LIZMANARM1, LIZMANLEG1
    case 1520: case 1528: case 1536:                                       // DUKETORSO, DUKEGUN, DUKELEG
      // game.c 3790: gibs are misc sprites; their size and speed are given
      // by whoever spawns them (checkhitsprite: 24x24, xvel 16).
      vm.stat.set(i, STAT.MISC);
      break;

    case T.WATERDRIP: {                                                    // game.c 4423, spawned by a sprite
      // Off an actor or a player (statnum 1 or 10 — a frozen trooper, the
      // frozen player): shade 32; pal 2 and 18<<8 up off a normal one, 13<<8
      // up off a frozen (pal 1) one; aimed at the player, xvel 48 - TRAND&31,
      // one ssp. Then the splash's block: 24x24, a standable. Its owner is
      // the spawner, so moveWaterDrip lets it die on landing.
      const ps0 = pstat;
      if (ps0 === STAT.ACTOR || ps0 === STAT.PLAYER) {
        sp.shade = 32;
        if (parent.pal !== 1) { sp.pal = 2; sp.z -= 18 << 8; } else sp.z -= 13 << 8;
        const pc = vm.player;
        if (pc) sp.ang = getAngle(vm.radarang, pc.x - sp.x, pc.y - sp.y);
        sp.xVel = 48 - (krand(vm.fx) & 31);
        moveSprite(vm, map, i, (sp.xVel * bsin(sp.ang + 512)) >> 14, (sp.xVel * bsin(sp.ang)) >> 14, sp.zVel);
      }
      sp.xRepeat = 24; sp.yRepeat = 24;
      vm.stat.set(i, STAT.STANDABLE);
      break;
    }

    case 921:                                                              // TOILETWATER (game.c 5394)
      // A scripted standable (CON_STANDABLES): the CON header, then shade
      // -16; spawned 0x0, its script grows it with `sizeto 24 32`.
      vm.spawnActor(sp, i, map, true);
      sp.shade = -16;
      if (!vm.stat.has(i)) vm.stat.set(i, STAT.ACTOR);
      break;

    case 1250:                                                             // STEAM (game.c 4847)
      // `if(j >= 0)`: the parent's angle, a centred translucent wall sprite
      // (16+128+2) of 1x1, xvel -8 and one ssp — a burst pipe's steam.
      vm.spawnActor(sp, i, map, true);
      sp.ang = parent.ang;
      sp.cstat = 16 | 128 | 2;
      sp.xRepeat = 1; sp.yRepeat = 1;
      sp.xVel = -8;
      moveSprite(vm, map, i, (sp.xVel * bsin(sp.ang + 512)) >> 14, (sp.xVel * bsin(sp.ang)) >> 14, sp.zVel);
      if (!vm.stat.has(i)) vm.stat.set(i, STAT.ACTOR);
      break;

    default:
      // A pickup has its size from spawn()'s item case whether or not a
      // script is loaded for it (spawnActor's block, game.c 4745).
      if (ITEM_TILES.has(pn) && !(vm.hasScript && vm.hasScript(pn))) { vm.spawnActor(sp, i, map, true); sp.ang = parent.ang; break; }
      if (vm.hasScript && vm.hasScript(pn)) {
        // spawn()'s default for a scripted tile (game.c 3700): the CON
        // header's strength and flags, the monster block's size, clipdist
        // and cstat 257, awake at once (statnum 1), the parent's angle;
        // off a RESPAWN the parent's pal (and tempang). A first version
        // filed these as unhandled — a monster closet's pigs arrived at
        // size 0, invisible, and shooting.
        vm.spawnActor(sp, i, map, true);
        sp.ang = parent.ang;
        if (parent.picNum === 9) sp.pal = parent.pal;
        if (!vm.stat.has(i)) vm.stat.set(i, STAT.ACTOR);
        // game.c 4614: `if(j >= 0) { timetosleep = 0; check_fta_sounds(i); }`
        // — a monster spawned by something roars on arrival. Only moveFta
        // called it, so a RESPAWN's pigs arrived silent.
        if (MONSTER_TILES.has(sp.picNum) && vm.stat.get(i) === STAT.ACTOR) checkFtaSounds(vm, map, i, vm.player);
        break;
      }
      vm.spawnUnhandled.set(pn, (vm.spawnUnhandled.get(pn) || 0) + 1);
      break;
  }
  return i;
}

/**
 * A shard of glass, actors.c (GLASSPIECES..+2): falls at up to 4096 a tic;
 * on the floor it bounces up `(3 - bounces)<<8` plus a jitter (half under
 * water), halves in size, and counts the bounce; after the third it is
 * gone. Its speed drops 2 a tic and its flip bits follow the speed.
 */
export function moveGlassPiece(map, vm, i) {
  const s = map.sprites[i];
  const t = vm.fx.temp(i);
  makeItFall(vm, map, i);
  if (s.zVel > 4096) s.zVel = 4096;
  if (s.sectNum < 0) { s.removed = true; vm.stat.delete(i); return; }
  const fz = vm.floorZ.get(i) ?? getZsOfSlope(map, s.sectNum, s.x, s.y).floorZ;
  if (s.z === fz - FOURSLEIGHT && t[0] < 3) {
    s.zVel = -((3 - t[0]) << 8) - (krand(vm.fx) & 511);
    if (((map.sectors[s.sectNum].lotag ?? 0) & LOTAG_MASK) === 2) s.zVel >>= 1;
    s.xRepeat >>= 1; s.yRepeat >>= 1;
    t[0]++;
  } else if (t[0] === 3) { s.removed = true; vm.stat.delete(i); return; }
  if (s.xVel > 0) { s.xVel -= 2; s.cstat = (s.xVel & 3) << 2; } else s.xVel = 0;
  moveSprite(vm, map, i, (s.xVel * bsin(s.ang + 512)) >> 14, (s.xVel * bsin(s.ang)) >> 14, s.zVel);
}

const SCRAP6 = 2390, SCRAP5 = 2416;

/**
 * moveactors 3229, DUKECAR / HELECOPT: the opening of E1L1 — Duke's ship
 * crossing the sky on fire. Each tic: sinks zvel (360), t[0]++, at 4
 * WAR_AMBIENCE2; every fourth tic an EXPLOSION2 off it (the fire trail);
 * ssp along its angle at xvel 292; after 26*8 tics RPG_EXPLODE (global),
 * 32 RANDOMSCRAP, earthquaketime 16, gone.
 */
export function moveDukecar(map, vm, i, cam) {
  const s = map.sprites[i];
  const t = vm.fx.temp(i);
  const say = (name, global) => {
    if (!vm.sounds || !cam) return;
    const n = vm.labels?.get(name);
    if (n === undefined) return;
    if (global) vm.sounds.at(n, -2, cam.x, cam.y, cam.z, cam, map); else vm.sounds.at(n, i, s.x, s.y, s.z, cam, map);
  };
  s.z += s.zVel;
  t[0]++;
  if (t[0] === 4) say('WAR_AMBIENCE2', false);
  if (t[0] > 26 * 8) {
    say('RPG_EXPLODE', true);
    randomScrap(vm, map, i, 32);
    vm.fx.earthquakeTime = 16;
    s.removed = true; vm.stat.delete(i);
    return;
  } else if ((t[0] & 3) === 0) spawnFrom(vm, map, i, T.EXPLOSION2);
  moveSprite(vm, map, i, (s.xVel * bsin(s.ang + 512)) >> 14, (s.xVel * bsin(s.ang)) >> 14, 0);
}

/**
 * moveactors 3592, the GREENSLIME (the protozoid slimer), moved in C. t[0]
 * is its state: 0 crawling on the floor, 1 leaping to the ceiling, 2 on the
 * ceiling, 3 dropping, -1 shrinking back after a meal, -2 on top of a
 * trooper/lizman/pig it is swallowing (t[5]), -4 on the player's face, -5
 * frozen. t[1] is the wobble phase (+128 a tic), t[2] the face offset,
 * t[3] the bite frame. Beyond 20480 it dozes off after SLEEPTIME; within
 * 1596 it is not solid (cstat 0), else 257. Within 768 and slow it climbs
 * onto the player (somethingonplayer) unless one is already there; there it
 * rides at the eye, bites for 5+rand&3 every eight frames (SLIM_ATTACK),
 * and dies when the player fires or quick-kicks (eight green SCRAP3,
 * SLIM_DYING, SQUISHED, a pool one in eight). A hit anywhere else kills it
 * the same way (a FREEZEBLAST freezes it, -5). On the floor it slithers
 * toward the player at 64 - sin, breathing (36+sin x 16+sin), and one in 64
 * tics under a low enough ceiling (< 192<<8) it leaps: up at 348 a tic to
 * 4096 under the ceiling, hangs there until the ceiling is sky or too far,
 * then drops (picture +1) and lands 2048 over the floor.
 */
export function moveGreenslime(map, vm, i, cam, pl) {
  const s = map.sprites[i];
  const t = vm.fx.temp(i);
  const sec = map.sectors[s.sectNum];
  if (!sec) return;
  const G = 2370;
  const kill = () => { s.removed = true; vm.stat.delete(i); if (pl && pl.somethingOnPlayer === i) pl.somethingOnPlayer = -1; };
  const say = (name) => { if (vm.sounds && cam) { const n = vm.labels?.get(name); if (n !== undefined) vm.sounds.at(n, i, s.x, s.y, s.z, cam, map); } };
  const scraps = () => { for (let k = 0; k < 8; k++) { const j = makeSprite(vm, map, s.sectNum, s.x, s.y, s.z - (8 << 8), 2408 + (krand(vm.fx) & 3), -8, 48, 48, krand(vm.fx) & 2047, (krand(vm.fx) & 63) + 64, -(krand(vm.fx) & 4095) - (s.zVel >> 2), i, STAT.MISC); if (j >= 0) map.sprites[j].pal = 6; } };
  const filedHit = () => { const e = vm.hitExtra.get(i) ?? -1; if (e < 0) return -1; vm.hitExtra.set(i, -1); return vm.hitPic.get(i) ?? 0; };
  t[1] += 128;
  if (sec.floorStat & 1) { kill(); return; }
  const x = cam ? playerDist(cam, s) : 1e9;
  if (x > 20480) {
    const tts = (vm.timeToSleep.get(i) ?? 0) + 1;
    vm.timeToSleep.set(i, tts);
    if (tts > SLEEPTIME) { vm.timeToSleep.set(i, 0); vm.stat.set(i, STAT.ZOMBIE); vm.asleep.add(i); return; }
  }
  if (t[0] === -5) {                              // frozen
    t[3]++;
    if (t[3] > 280) { s.pal = 0; t[0] = 0; return; }
    makeItFall(vm, map, i);
    s.cstat = 257; s.picNum = G + 2; s.extra = 1; s.pal = 1;
    const hp = filedHit();
    if (hp >= 0) {
      if (hp === 1641) return;                    // FREEZEBLAST
      for (let j = 16; j >= 0; j--) { const k = makeSprite(vm, map, s.sectNum, s.x, s.y, s.z, 1031 + (j % 3), -32, 36, 36, krand(vm.fx) & 2047, 32 + (krand(vm.fx) & 63), 1024 - (krand(vm.fx) & 1023), i, STAT.MISC); if (k >= 0) map.sprites[k].pal = 1; }
      say('GLASS_BREAKING');
      kill();
    } else if (x < 1024 && pl && !(pl.quickKick > 0)) {
      const j = incAngle(cam.ang, getAngle(vm.radarang, s.x - cam.x, s.y - cam.y));
      if (j > -128 && j < 128) pl.quickKick = 14;
    }
    return;
  }
  s.cstat = x < 1596 ? 0 : 257;
  if (t[0] === -4) {                              // on the player
    if (!pl || !(pl.health > 0)) { t[0] = 0; return; }
    s.ang = cam.ang;
    const fire = pl.firing || pl.quickKick > 0;
    if (fire && pl.health > 0 && (pl.quickKick > 0 || (pl.currWeapon !== 10 && pl.currWeapon !== 5 && pl.currWeapon !== 8 && (pl.ammoAmount?.[pl.currWeapon] ?? 0) >= 0))) {
      scraps();
      say('SLIM_DYING'); say('SQUISHED');
      if ((krand(vm.fx) & 255) < 32) { const j = spawnFrom(vm, map, i, T.BLOODPOOL); if (j >= 0) map.sprites[j].pal = 0; }
      vm.kills++;
      t[0] = -3;
      kill();
      return;
    }
    s.z = cam.z + (pl.pyoff ?? 0) - t[2] + (8 << 8);
    s.z += (100 - cam.horiz) << 4;
    if (t[2] > 512) t[2] -= 128;
    if (t[2] < 348) t[2] += 128;
    if (pl.newOwner >= 0) pl.newOwner = -1;       // yanks the player off a monitor
    if (t[3] > 0) {
      const frames = [5, 5, 6, 6, 7, 7, 6, 5];
      s.picNum = G + frames[t[3]];
      if (t[3] === 5) {
        vm.playerHit.picNum = G; vm.playerHit.extra = 5 + (krand(vm.fx) & 3); vm.playerHit.ang = s.ang; vm.playerHit.owner = i;
        say('SLIM_ATTACK');
      }
      if (t[3] < 7) t[3]++; else t[3] = 0;
    } else {
      s.picNum = G + 5;
      if (rnd(vm.fx, 32)) t[3] = 1;
    }
    s.xRepeat = 20 + (bsin(t[1] & 2047) >> 13);
    s.yRepeat = 15 + (bsin(t[1] & 2047) >> 13);
    s.x = cam.x + (bsin(cam.ang + 512) >> 7);
    s.y = cam.y + (bsin(cam.ang) >> 7);
    const sn = updateSector(map, s.x, s.y, s.sectNum); if (sn >= 0) s.sectNum = sn;
    return;
  } else if (s.xVel < 64 && x < 768 && pl) {
    if (!(pl.somethingOnPlayer >= 0)) {
      pl.somethingOnPlayer = i;
      t[2] = (t[0] === 3 || t[0] === 2) ? (12 << 8) : -(13 << 8);
      t[0] = -4;
    }
  }
  {
    const hp = filedHit();
    if (hp >= 0) {
      say('SLIM_DYING');
      vm.kills++;
      if (pl && pl.somethingOnPlayer === i) pl.somethingOnPlayer = -1;
      if (hp === 1641) { say('SOMETHINGFROZE'); t[0] = -5; t[3] = 0; return; }
      if ((krand(vm.fx) & 255) < 32) { const j = spawnFrom(vm, map, i, T.BLOODPOOL); if (j >= 0) map.sprites[j].pal = 0; }
      scraps();
      t[0] = -3;
      kill();
      return;
    }
  }
  if (t[0] === -1) {                              // shrinking down after a meal
    makeItFall(vm, map, i);
    s.cstat &= ~8;
    s.picNum = G + 4;
    if (s.xRepeat > 32) s.xRepeat -= krand(vm.fx) & 7;
    if (s.yRepeat > 16) s.yRepeat -= krand(vm.fx) & 7;
    else { s.xRepeat = 40; s.yRepeat = 16; t[5] = -1; t[0] = 0; }
    return;
  } else if (t[0] !== -2) getGlobalZ(vm, map, i);
  if (t[0] === -2) {                              // on top of somebody
    makeItFall(vm, map, i);
    const v = map.sprites[t[5]];
    if (!v || v.removed) { t[0] = -1; return; }
    v.xVel = 0;
    const l = v.ang;
    s.z = v.z;
    s.x = v.x + (bsin(l + 512) >> 11);
    s.y = v.y + (bsin(l) >> 11);
    s.picNum = G + 2 + (vm.fx.globalRandom & 1);
    if (s.yRepeat < 64) s.yRepeat += 2;
    else if (s.xRepeat < 32) s.xRepeat += 4;
    else {
      t[0] = -1;
      if (ldist(s.x - v.x, s.y - v.y) < 768) v.xRepeat = 0;   // swallowed
    }
    return;
  }
  // one in eight tics: a meal in the sector
  if (rnd(vm.fx, 32)) {
    for (let j = 0; j < map.sprites.length; j++) {
      const q = map.sprites[j];
      if (q.removed || q.sectNum !== s.sectNum) continue;
      if (q.picNum !== LIZTROOP && q.picNum !== LIZMAN && q.picNum !== 2000 && q.picNum !== 4610) continue;
      if (ldist(s.x - q.x, s.y - q.y) < 768 && Math.abs(s.z - q.z) < 8192) { t[5] = j; t[0] = -2; t[1] = 0; return; }
    }
  }
  const fz = vm.floorZ.get(i) ?? sec.floorZ, cz = vm.ceilingZ.get(i) ?? sec.ceilingZ;
  if (t[0] === 0 || t[0] === 2) {                 // crawling, floor or ceiling
    s.picNum = G;
    if ((krand(vm.fx) & 511) === 0) say('SLIM_ROAM');
    if (t[0] === 2) {
      s.zVel = 0;
      s.cstat &= ~8;
      if ((sec.ceilingStat & 1) || cz + 6144 < s.z) { s.z += 2048; t[0] = 3; return; }
    } else {
      s.cstat |= 8;
      makeItFall(vm, map, i);
    }
    if (vm.tic & 1) moveSprite(vm, map, i, (s.xVel * bsin(s.ang + 512)) >> 14, (s.xVel * bsin(s.ang)) >> 14, s.zVel);
    if (s.xVel > 96) { s.xVel -= 2; return; }
    if (s.xVel < 32) s.xVel += 4;
    s.xVel = 64 - (bsin((t[1] + 512) & 2047) >> 9);
    if (cam) s.ang = (s.ang + (incAngle(s.ang, getAngle(vm.radarang, cam.x - s.x, cam.y - s.y)) >> 3)) & 2047;
    s.xRepeat = 36 + (bsin((t[1] + 512) & 2047) >> 11);
    s.yRepeat = 16 + (bsin(t[1] & 2047) >> 13);
    if (rnd(vm.fx, 4) && (sec.ceilingStat & 1) === 0 && Math.abs(fz - cz) < (192 << 8)) { s.zVel = 0; t[0]++; }
  }
  if (t[0] === 1) {                               // leaping to the ceiling
    s.picNum = G;
    if (s.yRepeat < 40) s.yRepeat += 8;
    if (s.xRepeat > 8) s.xRepeat -= 4;
    if (s.zVel > -(2048 + 1024)) s.zVel -= 348;
    s.z += s.zVel;
    if (s.z < cz + 4096) { s.z = cz + 4096; s.xVel = 0; t[0] = 2; }
  }
  if (t[0] === 3) {                               // dropping
    s.picNum = G + 1;
    makeItFall(vm, map, i);
    const fz2 = vm.floorZ.get(i) ?? sec.floorZ;
    if (s.z > fz2 - (8 << 8)) { s.yRepeat -= 4; s.xRepeat += 2; }
    else { if (s.yRepeat < 40 - 4) s.yRepeat += 8; if (s.xRepeat > 8) s.xRepeat -= 4; }
    if (s.z > fz2 - 2048) { s.z = fz2 - 2048; t[0] = 0; s.xVel = 0; }
  }
}

/**
 * movestandables 2368, CANWITHSOMETHING1..4: makeitfall; hit (IFHIT — a
 * filed hittype extra), VENT_BUST, ten RANDOMSCRAP, the lotag spawned (the
 * "something" in the can: a tile number), gone.
 */
export function moveCan(map, vm, i, cam) {
  const s = map.sprites[i];
  makeItFall(vm, map, i);
  const filed = vm.hitExtra.get(i) ?? -1;
  if (filed >= 0) {
    vm.hitExtra.set(i, -1);
    if (vm.sounds && cam) { const n = vm.labels?.get('VENT_BUST'); if (n !== undefined) vm.sounds.at(n, i, s.x, s.y, s.z, cam, map); }
    randomScrap(vm, map, i, 10);
    if (s.lotag) spawnFrom(vm, map, i, s.lotag);
    s.removed = true; vm.stat.delete(i);
  }
}

/**
 * RANDOMSCRAP, duke3d.h: a piece of debris — SCRAP6 + TRAND&15, 48x48 at
 * shade -8, within 128 of the parent, up to 8191 above it, thrown at
 * 64..127 in a random direction and upward at 512..2559, misc. What flies
 * off a broken fan, a landed faller, a detonated tank.
 */
export function randomScrap(vm, map, i, n = 1) {
  const s = map.sprites[i];
  const made = [];
  for (let k = 0; k < n; k++) {
    const j = makeSprite(vm, map, s.sectNum, s.x + (krand(vm.fx) & 255) - 128, s.y + (krand(vm.fx) & 255) - 128,
      s.z - (8 << 8) - (krand(vm.fx) & 8191), SCRAP6 + (krand(vm.fx) & 15), -8, 48, 48, krand(vm.fx) & 2047,
      (krand(vm.fx) & 63) + 64, -512 - (krand(vm.fx) & 2047), i, STAT.MISC);
    made.push(j);
  }
  return made;
}

/**
 * moveexplosions() for SCRAP6..SCRAP5+3, actors.c 4872: the speed drops one
 * a tic; above the floor (2<<8 up) the frame counter t[0] cycles (0..7 for
 * the first eight tiles, 0..3 after) every second tic, gravity gc-50 pulls
 * up to 4096, and it flies along its angle; at the floor it is gone.
 */
export function moveScrap(map, vm, i) {
  const s = map.sprites[i];
  const t = vm.fx.temp(i);
  if (s.xVel > 0) s.xVel--; else s.xVel = 0;
  if (s.zVel > 1024 && s.zVel < 1280) s.sectNum = updateSector(map, s.x, s.y, s.sectNum);
  const sec = map.sectors[s.sectNum];
  if (!sec) { s.removed = true; vm.stat.delete(i); return; }
  if (s.z < sec.floorZ - (2 << 8)) {
    if (t[1] < 1) t[1]++;
    else {
      t[1] = 0;
      if (s.picNum < SCRAP6 + 8) { if (t[0] > 6) t[0] = 0; else t[0]++; }
      else { if (t[0] > 2) t[0] = 0; else t[0]++; }
    }
    if (s.zVel < 4096) s.zVel += GC - 50;
    s.x += (s.xVel * bsin(s.ang + 512)) >> 14;
    s.y += (s.xVel * bsin(s.ang)) >> 14;
    s.z += s.zVel;
  } else {
    s.removed = true; vm.stat.delete(i);
  }
}

/** JIBS1..6 and the body parts moveexplosions() handles alike. */
// DEFS.CON: JIBS1 2245, JIBS2 2250, JIBS3 2255, JIBS4 2260, JIBS5 2265 (five
// frames each — a first table had them consecutive, 2246..2249, and every
// JIBS2..5 from `guts` then hung in the air, no mover claiming it), JIBS6
// 2286; HEADJIB1/ARMJIB1/LEGJIB1 1768/1772/1776; LIZMANHEAD1/ARM1/LEG1
// 2201/2205/2209; DUKETORSO/GUN/LEG 1520/1528/1536 — actors.c 4544's list.
const JIB_TILES = new Set([2245, 2250, 2255, 2260, 2265, 2286, 1768, 1772, 1776, 2201, 2205, 2209, 1520, 1528, 1536]);

/**
 * shoot(i, atwith): the projectile family — FIRELASER, SPIT, COOLEXPLOSION1.
 * player.c 701. From an actor: the muzzle is 4<<8 above the sprite's top,
 * minus 7<<8, shifted a little to the actor's right; the angle is the
 * actor's with a jitter of up to 31; the vertical speed aims at the player
 * over the octagonal distance. The projectile is 18x18, shade -127,
 * translucent (cstat 128), clipdist 4, statnum 4, with `extra + (TRAND&7)`.
 *
 * The hitscan family (SHOTSPARK1, SHOTGUN, ...) and RPG/MORTER are not here;
 * they are counted in `shootUnhandled`. And the spread that a second or third
 * shot gets (`scount > 1`) is only ever asked for by the player.
 */
/**
 * shoot(MORTER), player.c 1100: the shooter's shade -96 while alive; toward
 * the nearest player at ldist x, a lob — zvel -x/2 (under -4096 it is
 * -2048), xvel x/16 — born half a unit ahead, 6<<8 below the eye line,
 * 32x32, shade -64, owned by the shooter, statnum 1: the HEAVYHBOMB mover
 * runs it (moveHeavyBomb 'morter') until it lands or nears a player.
 */
export function shootMorter(vm, map, i) {
  const s = map.sprites[i];
  const p = vm.player;
  if (!s || !p) return -1;
  if (s.extra >= 0) s.shade = -96;
  const sa = s.ang;
  const sx = s.x, sy = s.y, sz = s.z - ((s.yRepeat * (vm.art?.get(s.picNum)?.height ?? 0)) << 1) + (4 << 8);
  const x = ldist(p.x - s.x, p.y - s.y);
  let zvel = -(x >> 1);
  if (zvel < -4096) zvel = -2048;
  const vel = x >> 4;
  const j = makeSprite(vm, map, s.sectNum, sx + (bsin(sa + 1024) >> 8), sy + (bsin(sa + 512) >> 8), sz + (6 << 8), 1650, -64, 32, 32, sa, vel, zvel, i, STAT.ACTOR);
  return j;
}

export function shootFrom(vm, map, i, atwith) {
  const s = map.sprites[i];
  if (!s) return -1;
  if (atwith === T.SHOTSPARK1 || atwith === T.SHOTGUN || atwith === T.CHAINGUN) {
    return actorHitscan(vm, map, i, atwith);
  }
  if (atwith === T.RPG) return shootRpg(vm, map, i, null, 0, atwith);
  if (atwith === 1650) return shootMorter(vm, map, i);
  if (atwith >= T.BLOODSPLAT1 && atwith <= T.BLOODSPLAT4) return shootBloodSplat(vm, map, i, atwith);
  if (atwith === T.SHRINKER) return shootShrinkerFrom(vm, map, i);
  if (atwith !== T.FIRELASER && atwith !== T.SPIT && atwith !== T.COOLEXPLOSION1) {
    vm.shootUnhandled.set(atwith, (vm.shootUnhandled.get(atwith) || 0) + 1);
    return -1;
  }
  const p = vm.player;
  const tile = vm.art?.get(s.picNum);
  let sa = s.ang;
  let sx = s.x, sy = s.y;
  let sz = s.z - ((s.yRepeat * (tile?.height ?? 0)) << 1) + (4 << 8);
  if (s.picNum !== ROTATEGUN) {
    sz -= 7 << 8;
    if (isBadguy(vm, s) && s.picNum !== COMMANDER) {
      sx += bsin(sa + 1024 + 96) >> 7;
      sy += bsin(sa + 512 + 96) >> 7;
    }
  }
  if (s.extra >= 0) s.shade = -96;

  let vel;
  if (atwith === T.SPIT) vel = 292;
  else if (atwith === T.COOLEXPLOSION1) { vel = s.picNum === BOSS2 ? 644 : 348; sz -= 4 << 7; }
  else { vel = 840; sz -= 4 << 7; }

  // findplayer(): the nearest player and the octagonal distance to them.
  sa += 16 - (krand(vm.fx) & 31);
  const pd = ldist(p.x - sx, p.y - sy) || 1;
  let zvel = Math.trunc(((p.z - sz + (3 << 8)) * vel) / pd);

  let sizx, sizy;
  if (atwith === T.SPIT) { sizx = 18; sizy = 18; sz -= 10 << 8; }
  else { sizx = 18; sizy = 18; }

  const j = makeSprite(vm, map, s.sectNum, sx, sy, sz, atwith, -127, sizx, sizy, sa, vel, zvel, i, STAT.WEAPON);
  const w = map.sprites[j];
  w.extra += krand(vm.fx) & 7;
  if (atwith === T.COOLEXPLOSION1) w.shade = 0;
  w.cstat = 128;
  w.clipDist = 4;
  return j;
}

/** ldist(): Build's octagonal distance over two sprites' x and y. */
function ldist(dx, dy) { return findDistance2D(dx, dy); }

/**
 * moveweapons(): one tic of every statnum-4 sprite. actors.c 2521 for the
 * projectile family. Move with CLIPMASK1; the ceiling and floor kept per
 * sprite turn into a "hit" of their own; on any hit a FIRELASER dies and a
 * COOLEXPLOSION1 stops and fades (shade up to 40, then dies). A hit on the
 * player is counted in `playerHits` — there is no damage yet, and this is
 * where it will go.
 *
 * Not here: the FIRELASER's trail of five faint copies (statnum 5 sprites
 * with no death of their own in this file yet), checkhitwall's effects, and
 * the mirror bounce.
 */
export function moveWeapons(map, vm, cam) {
  for (const [i, stat] of vm.stat) {
    if (stat !== STAT.WEAPON) continue;
    const s = map.sprites[i];
    if (!s || s.removed) { vm.stat.delete(i); continue; }
    if (s.picNum === TONGUE) { moveTongue(map, vm, i); continue; }
    if (s.picNum !== T.FIRELASER && s.picNum !== T.SPIT && s.picNum !== T.COOLEXPLOSION1 && s.picNum !== T.RPG
        && s.picNum !== T.SHRINKSPARK && s.picNum !== T.FREEZEBLAST) continue;
    // The probe's age counter lives in its own table: temp_data[3] is an
    // action's frame offset, not a free slot.
    if (!vm.projAge) vm.projAge = new Map();
    vm.projAge.set(i, (vm.projAge.get(i) ?? 0) + 1);
    if (s.sectNum < 0) { vm.lastProjEnd = { pic: s.picNum, kind: 'no sector', age: vm.projAge.get(i) }; { const e = vm.projLog?.find((q) => q.i === i && !q.end); if (e) e.end = 'no sector @' + vm.projAge.get(i); } vm.projAge.delete(i); s.removed = true; vm.stat.delete(i); continue; }
    // FREEZEBLAST, actors.c 2511: out of bounces, drained to under 2, or
    // stopped — a blue TRANSPORTERSTAR (32x32, pal 1) and gone.
    if (s.picNum === T.FREEZEBLAST && (s.yVel < 1 || s.extra < 2 || (s.xVel === 0 && s.zVel === 0))) {
      const k = spawnFrom(vm, map, i, T.TRANSPORTERSTAR);
      if (k >= 0) { map.sprites[k].pal = 1; map.sprites[k].xRepeat = 32; map.sprites[k].yRepeat = 32; }
      s.removed = true; vm.stat.delete(i);
      continue;
    }

    const k = s.xVel, ll = s.zVel;
    // getglobalz(): the floor and ceiling under the projectile, walldist 127.
    const zr = getZRange(map, s.x, s.y, s.z - FOURSLEIGHT, s.sectNum, 127, CLIPMASK0, { art: vm.art });
    vm.floorZ.set(i, zr.florZ); vm.ceilingZ.set(i, zr.ceilZ);

    const oldx = s.x, oldy = s.y;   // for the swept player test below
    let j = moveSprite(vm, map, i, (k * bsin(s.ang + 512)) >> 14, (k * bsin(s.ang)) >> 14, ll, CLIPMASK1);
    // A sprite hit is delivered once: by the flight test below, or, when
    // clipmove itself stopped the projectile at a sprite's box (CLIPMASK1's
    // hitscan bit), by the branch at the end — as actors.c 2612 does with
    // `checkhitsprite(j&4095, i)`.
    let spriteHitDone = false;
    if (s.sectNum < 0) { s.removed = true; vm.stat.delete(i); continue; }

    const lt = map.sectors[s.sectNum].lotag & LOTAG_MASK;
    if ((j & 49152) !== 49152) {
      if (s.z < zr.ceilZ) { j = 16384 | s.sectNum; s.zVel = -1; }
      else if ((s.z > zr.florZ && lt !== 1) || (s.z > zr.florZ + (16 << 8) && lt === 1)) {
        j = 16384 | s.sectNum;
        if (lt !== 1) s.zVel = 1;
      }
    }
    if (s.picNum === T.SPIT && s.zVel < 6144) s.zVel += GC - 112;

    // Did it hit a sprite? clipmove has no sprite pass here, so the flight
    // of this tic — from where it was to where it is — is tested against
    // every live badguy in its sector: the distance from the sprite's centre
    // to that SEGMENT under the sprite's clip radius, and z within its
    // height. A segment, because a rocket at 322 a tic would jump clean over
    // an 80-unit disc tested as a point. A hit is Duke's 49152|sprite, and
    // checkhitsprite(sprite, projectile) files the damage.
    if ((k !== 0 || ll !== 0) && (j === 0 || (j & 49152) === 16384)) {
      const x0 = s.x - ((k * bsin(s.ang + 512)) >> 15), y0 = s.y - ((k * bsin(s.ang)) >> 15);
      for (let t = 0; t < map.sprites.length; t++) {
        const tg = map.sprites[t];
        if (t === i || tg.removed || tg.extra < 0 || tg.sectNum !== s.sectNum) continue;
        // CLIPMASK1's sprite bit: anything solid with 256 — badguys, and the
        // barrels and cracks a rocket is meant to set off.
        if (!(tg.cstat & 256) || !(isBadguy(vm, tg) || (tg.cstat & 257) === 257)) continue;
        if (t === s.owner || t === vm.playerSprite) continue;   // the player has the swept box below, with the owner rule
        const rad = (tg.clipDist || 32) + 4;
        const th = ((vm.art?.get(tg.picNum)?.height ?? 0) * tg.yRepeat) << 2;
        if (s.z > tg.z || s.z < tg.z - th) continue;
        // point-to-segment distance in the plane
        const dx = s.x - x0, dy = s.y - y0;
        const len2 = dx * dx + dy * dy;
        let u = len2 ? ((tg.x - x0) * dx + (tg.y - y0) * dy) / len2 : 0;
        u = Math.max(0, Math.min(1, u));
        const px = x0 + dx * u, py = y0 + dy * u;
        if (Math.abs(tg.x - px) < rad && Math.abs(tg.y - py) < rad) {
          hitSprite(vm, map, t, i);
          j = 49152 | t;
          spriteHitDone = true;
          s.x = px; s.y = py;
          break;
        }
      }
    }
    // The player's disc — never the shooter's own projectile: in Duke a
    // rocket born inside the APLAYER box leaves it freely (clipmove's box
    // edges face the mover), and only a projectile ENTERING the box hits.
    if ((k !== 0 || ll !== 0) && (j === 0 || (j & 49152) === 16384) && s.owner !== -2) {
      // In Duke the player's APLAYER sprite (cstat 257, clipdist 64) is what
      // a projectile's clipmove meets: a box of clipdist<<2 + walldist =
      // 256 + 8 about the player, SWEPT along the tic's whole step. A test
      // of the end point alone against a 164 box let a spark at 384 a tic
      // pass through a standing player two times in three (E1L4's shrink
      // emitters). The sweep: does the segment old -> new pass through the
      // box?
      const half = 256 + 8;
      const minX = Math.min(oldx, s.x), maxX = Math.max(oldx, s.x), minY = Math.min(oldy, s.y), maxY = Math.max(oldy, s.y);
      let inBox = maxX >= cam.x - half && minX <= cam.x + half && maxY >= cam.y - half && minY <= cam.y + half;
      if (inBox && (s.x !== oldx || s.y !== oldy)) {
        // the segment clips the box: separating-axis test against the box's diagonals
        const dxs = s.x - oldx, dys = s.y - oldy;
        const cx = (minX + maxX) / 2 - cam.x, cy = (minY + maxY) / 2 - cam.y;
        // the box's centre projected onto the segment's normal, against the
        // box's own extent along that normal (a square: half*(|dx|+|dy|))
        inBox = Math.abs(dxs * cy - dys * cx) <= half * (Math.abs(dxs) + Math.abs(dys));
      }
      if (inBox && s.z > cam.z - (8 << 8) && s.z < cam.z + (32 << 8)) {
        vm.playerHits.set(s.picNum, (vm.playerHits.get(s.picNum) || 0) + 1);
        // (a filing of any kind, damage or none — the shrinker's spark is one)
      vm.playerHit.filed = true;
      // checkhitsprite(player, weapon), sector.c 2338: the damage is FILED
        // on the player — picnum, extra added up, angle, owner — and taken
        // off the health by ifhitbyweapon() on the player's own tic.
        vm.playerHit.picNum = s.picNum;
        vm.playerHit.extra += s.extra;
        vm.playerHit.ang = s.ang;
        vm.playerHit.owner = s.owner;
        j = 49152;
        spriteHitDone = true;
      }
    }

    if (j !== 0) {
      // For the page's probe: what the last projectile ended on.
      vm.lastProjEnd = { pic: s.picNum, kind: (j & 49152) === 49152 ? 'sprite ' + (j & 16383) : (j & 49152) === 32768 ? 'wall ' + (j & 16383) : 'floor/ceiling sect ' + (j & 16383), age: vm.projAge?.get(i) ?? -1 };
      vm.projAge?.delete(i);
      { const e = vm.projLog?.find((q) => q.i === i && !q.end); if (e) e.end = vm.lastProjEnd.kind + ' @' + vm.lastProjEnd.age; }
      if ((j & 49152) === 49152 && !spriteHitDone) hitSprite(vm, map, j & 16383, i);
      // FREEZEBLAST off a wall (actors.c 2677): half the strength, one
      // bounce fewer, the angle reflected — and it flies on. Off a floor or
      // ceiling (2706): bounce(), half strength, a little smaller, one
      // bounce fewer, flies on.
      if (s.picNum === T.FREEZEBLAST && (j & 49152) === 32768) {
        s.extra >>= 1; s.yVel--;
        const w = map.walls[j & 16383], w2 = map.walls[w.point2];
        const k2 = getAngle(vm.radarang, w2.x - w.x, w2.y - w.y);
        s.ang = ((k2 << 1) - s.ang) & 2047;
        continue;
      }
      if (s.picNum === T.FREEZEBLAST && (j & 49152) === 16384) {
        bounceSprite(map, vm, i);
        s.extra >>= 1;
        if (s.xRepeat > 8) s.xRepeat -= 2;
        if (s.yRepeat > 8) s.yRepeat -= 2;
        s.yVel--;
        continue;
      }
      if (s.picNum === T.COOLEXPLOSION1) { s.xVel = 0; s.zVel = 0; }
      if (s.picNum === T.SHRINKSPARK) {
        // actors.c 2740: SHRINKEREXPLOSION, SHRINKER_HIT, and hitradius in
        // its shrinker mode — no damage, a SHRINKSPARK filed on everyone
        // solid within shrinkerblastradius who is not already small.
        spawnFrom(vm, map, i, T.SHRINKEREXPLOSION);
        if (vm.sounds) { const n = vm.labels?.get('SHRINKER_HIT'); if (n !== undefined) vm.sounds.at(n, i, s.x, s.y, s.z, cam, map); }
        hitRadius(vm, map, i, vm.shrinkerBlastRadius ?? 680, 0, 0, 0, 0, cam);
      }
      if (s.picNum === T.RPG) {
        // actors.c 2718: EXPLOSION2 where it stopped (small if the rocket
        // is small; on a floor going down, EXPLOSION2BOT too; on a ceiling
        // flipped and lowered 48<<8), RPG_EXPLODE, and the blast —
        // hitradius over rpgblastradius with the rocket's strength x in
        // four bands x/4, x/2, x-x/4, x.
        const k = spawnFrom(vm, map, i, T.EXPLOSION2);
        const ex = map.sprites[k];
        ex.x = s.x; ex.y = s.y; ex.z = s.z;
        if (s.xRepeat < 10) { ex.xRepeat = 6; ex.yRepeat = 6; }
        else if ((j & 49152) === 16384) {
          if (s.zVel > 0) spawnFrom(vm, map, i, T.EXPLOSION2BOT);
          else { ex.cstat |= 8; ex.z += 48 << 8; }
        }
        if (vm.sounds) { const n = vm.labels.get('RPG_EXPLODE'); if (n !== undefined) vm.sounds.at(n, i, s.x, s.y, s.z, cam, map); }
        const x = s.extra;
        if (s.xRepeat >= 10) hitRadius(vm, map, i, vm.rpgBlastRadius ?? 1780, x >> 2, x >> 1, x - (x >> 2), x, cam);
        else { const xx = x + (krand(vm.fx) & 3); hitRadius(vm, map, i, (vm.rpgBlastRadius ?? 1780) >> 1, xx >> 2, xx >> 1, xx - (xx >> 2), xx, cam); }
      }
      if (s.picNum !== T.COOLEXPLOSION1) { s.removed = true; vm.stat.delete(i); continue; }
    }
    if (s.picNum === T.COOLEXPLOSION1) {
      s.shade++;
      if (s.shade >= 40) { s.removed = true; vm.stat.delete(i); }
    }
  }
}

/**
 * operaterespawns(), sector.c 996: every RESPAWN with the lotag gets a
 * TRANSPORTERSTAR 32<<8 above it and its count set to 66-12 — thirteen
 * tics later moveStandables spawns the hitag's tile there. Called at the
 * end of operateactivators (a switch, a touchplate, a master switch).
 */
export function operateRespawns(vm, map, tag) {
  let n = 0;
  for (let i = 0; i < map.sprites.length; i++) {
    const s = map.sprites[i];
    if (s.removed || s.picNum !== 9 || s.lotag !== tag) continue;
    const k = spawnFrom(vm, map, i, T.TRANSPORTERSTAR);
    if (k >= 0) map.sprites[k].z -= 32 << 8;
    s.extra = 66 - 12;
    n++;
  }
  return n;
}

/** movetransports 3009: what never goes through a transport. */
const NO_WARP = new Set([1630, 1261, 2566, 952, 1380, 2270, 2310, 2271, 2311, 921, 2567]);

/**
 * movestandables 1537, the CRANE. t[0] is the state, t[1] the sector it
 * watches (the pole's). 0: something in that sector (an actor, a dozer, a
 * standable, a player) — the crane turns toward the pick-up spot, the
 * thing is set ON the spot, state 1. 1: run out to the spot (xvel to 184,
 * picture CRANE+1), until the crane is in that sector. 2: lower 1536 a
 * tic; under 64<<8 over the floor the picture steps back; within 5120 of
 * the floor, state 3. 3: the picture steps to CRANE+2 — a player on the
 * ground in the sector is grabbed (owner -2, on_crane, DUKE_GRUNT, turned
 * to face the crane), else the first actor or standable there (owner);
 * state 4. 4: ten tics' pause. 5: lift 1536 a tic to the rest z, then
 * xvel 0, state 6. 6: run home (xvel to 192), state 7 within 128. 7:
 * lower; within 64<<8 of the floor the picture steps back and, at CRANE,
 * the load is let go (a player: DUKE_GRUNT, on_crane -1), state 8. 8: lift
 * (the picture forward again above 8192), then 9 -> 0. Every tic the pole
 * (the cable) is set to the crane, 34<<8 up; a load rides at the crane's
 * position; a hit crane drops its load and rests. The horizontal runs of
 * states 1 and 6 are ssp — as eduke32 has them; the 1.5 listing lost the
 * two lines and a crane that never moved.
 */
/**
 * The statnum the crane reads: filed ones as filed; a scripted sprite with
 * none filed is an actor (statnum 1 in Duke — a NUKEBARREL, a can, any CON
 * actor uDuke runs from the default stat). A first version counted only
 * badguys among the unfiled, and barrels delivered onto E1L4's crane pad
 * never fetched the crane.
 */
function craneStat(vm, q, j) {
  const st = vm.stat.get(j);
  if (st !== undefined) return st;
  return (isBadguy(vm, q) || (vm.hasScript && vm.hasScript(q.picNum))) ? STAT.ACTOR : -1;
}

export function moveCrane(map, vm, i, cam, pl) {
  const s = map.sprites[i];
  const t = vm.fx.temp(i);
  const d = vm.cranes?.get(i);
  if (!d) return;
  const sect = s.sectNum;
  const sec = map.sectors[sect];
  if (!sec) return;
  const CRANE = 1222;
  const say = (name, sprite, x, y, z) => { const n = vm.labels?.get(name); if (n !== undefined && vm.sounds && cam) vm.sounds.at(n, sprite, x, y, z, cam, map); };
  const run = () => moveSprite(vm, map, i, (s.xVel * bsin(s.ang + 512)) >> 14, (s.xVel * bsin(s.ang)) >> 14, 0, CLIPMASK0);
  if (s.xVel) { const zr = getZRange(map, s.x, s.y, s.z - FOURSLEIGHT, s.sectNum, 127, CLIPMASK0); vm.floorZ.set(i, zr.florZ); vm.ceilingZ.set(i, zr.ceilZ); }
  if (t[0] === 0) {
    // waiting: anyone in the watched sector
    let found = false;
    if (cam && pl && cam.sectNum === t[1]) found = true;
    if (!found) {
      for (let j = 0; j < map.sprites.length; j++) {
        const q = map.sprites[j];
        if (q.removed || q.sectNum !== t[1] || j === i) continue;
        const st = craneStat(vm, q, j);
        if (st === STAT.ACTOR || st === STAT.ZOMBIE || st === STAT.STANDABLE) {
          s.ang = getAngle(vm.radarang, d.px - s.x, d.py - s.y);
          q.x = d.px; q.y = d.py; { const sn = updateSector(map, q.x, q.y, q.sectNum); if (sn >= 0) q.sectNum = sn; }
          found = true;
          break;
        }
      }
    } else s.ang = getAngle(vm.radarang, d.px - s.x, d.py - s.y);
    if (found) { t[0]++; return; }
  } else if (t[0] === 1) {
    if (s.xVel < 184) { s.picNum = CRANE + 1; s.xVel += 8; }
    run();
    if (s.sectNum === t[1]) t[0]++;
  } else if (t[0] === 2 || t[0] === 7) {
    s.z += 1024 + 512;
    if (t[0] === 2) {
      if (sec.floorZ - s.z < (64 << 8) && s.picNum > CRANE) s.picNum--;
      if (sec.floorZ - s.z < 4096 + 1024) t[0]++;
    }
    if (t[0] === 7) {
      if (sec.floorZ - s.z < (64 << 8)) {
        if (s.picNum > CRANE) s.picNum--;
        else {
          if (s.owner === -2 && pl) { say('DUKE_GRUNT', -2, cam.x, cam.y, cam.z); if (pl.onCrane === i) pl.onCrane = -1; }
          t[0]++;
          s.owner = -1;
        }
      }
    }
  } else if (t[0] === 3) {
    s.picNum++;
    if (s.picNum === CRANE + 2) {
      if (cam && pl && cam.sectNum === t[1] && pl.onGround) {
        s.owner = -2;
        pl.onCrane = i;
        say('DUKE_GRUNT', -2, cam.x, cam.y, cam.z);
        cam.ang = (s.ang + 1024) & 2047;
      } else {
        for (let j = 0; j < map.sprites.length; j++) {
          const q = map.sprites[j];
          if (q.removed || q.sectNum !== t[1] || j === i) continue;
          const st = craneStat(vm, q, j);
          if (st === STAT.ACTOR || st === STAT.STANDABLE) s.owner = j;
        }
      }
      t[0]++;
      t[2] = 0;
      return;
    }
  } else if (t[0] === 4) {
    t[2]++;
    if (t[2] > 10) t[0]++;
  } else if (t[0] === 5 || t[0] === 8) {
    if (t[0] === 8 && s.picNum < CRANE + 2 && sec.floorZ - s.z > 8192) s.picNum++;
    if (s.z < d.oz) { t[0]++; s.xVel = 0; }
    else s.z -= 1024 + 512;
  } else if (t[0] === 6) {
    if (s.xVel < 192) s.xVel += 8;
    s.ang = getAngle(vm.radarang, d.ox - s.x, d.oy - s.y);
    run();
    const dx = s.x - d.ox, dy = s.y - d.oy;
    if (dx * dx + dy * dy < 128 * 128) t[0]++;
  } else if (t[0] === 9) t[0] = 0;
  // the cable follows
  const pole = map.sprites[d.pole];
  if (pole && !pole.removed) { pole.x = s.x; pole.y = s.y; pole.z = s.z - (34 << 8); const sn = updateSector(map, pole.x, pole.y, pole.sectNum); if (sn >= 0) pole.sectNum = sn; }
  if (s.owner !== -1) {
    const filed = vm.hitExtra.get(i) ?? -1;
    if (filed >= 0) {
      vm.hitExtra.set(i, -1);
      if (s.owner === -2 && pl && pl.onCrane === i) pl.onCrane = -1;
      s.owner = -1;
      s.picNum = CRANE;
      return;
    }
    if (s.owner >= 0) {
      const q = map.sprites[s.owner];
      if (q && !q.removed) { q.x = s.x; q.y = s.y; q.z = s.z; const sn = updateSector(map, q.x, q.y, q.sectNum); if (sn >= 0) q.sectNum = sn; q.zVel = 0; }
      else s.owner = -1;
    } else if (s.owner === -2 && cam) {
      cam.x = s.x - (bsin(cam.ang + 512) >> 6);
      cam.y = s.y - (bsin(cam.ang) >> 6);
      cam.z = s.z + (2 << 8);
      const sn = updateSector(map, cam.x, cam.y, cam.sectNum);
      if (sn >= 0) cam.sectNum = sn;
    }
  }
}

/**
 * movetransports(), actors.c 2986, the sprite side — the player's side is
 * effector.js's moveTransports. For each SE 7 with a partner: every
 * projectile, misc, faller or dummy sprite (statnum 4/5/12/13) in its
 * sector with a vertical speed is warped when it reaches the water's
 * boundary: under water (lotag 2) above ceilingz + |zvel|, at the surface
 * (lotag 1) below floorz - |zvel|; on a floor pad (lotag 0) a projectile
 * goes through at once, a misc sprite never. The named few never go
 * (stars, beams, trip bombs, holes, splashes, fire, laser lines);
 * PLAYERONWATER under water only loses its invisibility bit. On the way
 * through a water pad a WATERSPLASH2 is spawned at the sprite (a surface
 * projectile's splash rides at half speed); then the sprite lands at the
 * partner, at the partner sector's floor - |zvel| (surfacing) or ceiling
 * + |zvel| (diving). Bubbles rise into the air this way and pop; without
 * it they hung at the underwater ceiling.
 */
export function moveTransportSprites(map, vm, cam) {
  const fx = vm.fx;
  if (!fx?.transports) return 0;
  let warped = 0;
  for (const i of fx.transports) {
    const s = map.sprites[i];
    if (!s || s.removed || s.owner === i || s.owner < 0) continue;
    const ow = map.sprites[s.owner];
    if (!ow) continue;
    const sec = map.sectors[s.sectNum];
    if (!sec) continue;
    const sectLotag = sec.lotag & LOTAG_MASK;
    const onFloor = fx.temp(i)[4] === 1;
    for (let j = 0; j < map.sprites.length; j++) {
      const q = map.sprites[j];
      if (q.removed || q.sectNum !== s.sectNum || j === i) continue;
      const st = vm.stat.get(j);
      if (st !== STAT.WEAPON && st !== STAT.MISC && st !== STAT.FALLER && st !== STAT.DUMMY) continue;
      const ll = Math.abs(q.zVel);
      let warp = false;
      if (ll && sectLotag === 2 && q.z < sec.ceilingZ + ll) warp = true;
      if (ll && sectLotag === 1 && q.z > sec.floorZ - ll) warp = true;
      if (sectLotag === 0 && (onFloor || Math.abs(q.z - s.z) < 4096)) {
        if (ow.owner !== s.owner && onFloor && fx.temp(i)[0] > 0 && st !== STAT.MISC) { fx.temp(i)[0]++; continue; }
        warp = true;
      }
      if (!warp) continue;
      if (NO_WARP.has(q.picNum)) continue;
      if (q.picNum === 1420) { if (sectLotag === 2) { q.cstat &= 32767; continue; } }
      else if (st === STAT.MISC && !(sectLotag === 1 || sectLotag === 2)) continue;
      if (sectLotag > 0) {
        const k = spawnFrom(vm, map, j, T.WATERSPLASH2);
        if (k >= 0 && sectLotag === 1 && st === STAT.WEAPON) {
          const sp = map.sprites[k];
          sp.xVel = q.xVel >> 1; sp.ang = q.ang;
          moveSprite(vm, map, k, (sp.xVel * bsin(sp.ang + 512)) >> 14, (sp.xVel * bsin(sp.ang)) >> 14, 0, CLIPMASK0);
        }
      }
      const osec = map.sectors[ow.sectNum];
      if (!osec) continue;
      q.x += ow.x - s.x; q.y += ow.y - s.y;
      if (sectLotag === 0) {
        q.z = onFloor ? q.z - (s.z - osec.floorZ) : ow.z + 4096;
        // actors.c 3074: through a floor pad both pads get T1 = 13 — the
        // partner will not send the sprite straight back this tic.
        if (onFloor && ow.owner !== s.owner) { fx.temp(i)[0] = 13; fx.temp(s.owner)[0] = 13; }
      }
      else if (sectLotag === 1) q.z = osec.ceilingZ + ll;
      else q.z = osec.floorZ - ll;
      q.sectNum = ow.sectNum;
      vm.floorZ.set(j, osec.floorZ); vm.ceilingZ.set(j, osec.ceilingZ);
      warped++;
    }
  }
  return warped;
}

/**
 * moveexplosions(): one tic of every statnum-5 sprite this file knows.
 * actors.c 4395. FRAMEEFFECT1 counts to 7 and dies, going translucent on the
 * way; TRANSPORTERSTAR runs its own CON actor (`execute`), which animates it
 * forward and back and kills it.
 */
export function moveExplosions(map, vm, cam) {
  for (const [i, stat] of vm.stat) {
    if (stat !== STAT.MISC) continue;
    const s = map.sprites[i];
    if (!s || s.removed) { vm.stat.delete(i); continue; }
    // actors.c 4410: `if (sect < 0 || s->xrepeat == 0) KILLIT(i)` — a misc
    // sprite with no width is gone before its case runs. This is what ends
    // a BLOODPOOL spawned over water: the lotag-1 branch of its spawn
    // (game.c 3901) files it misc BEFORE the size-1 line, so it arrives at
    // EGS's 0 and dies here at once; a land pool arrives at 1 and grows.
    // Without this the water pool grew into a face-sprite blob standing on
    // the surface (E1L4's lake).
    if (s.sectNum < 0 || s.xRepeat === 0) { s.removed = true; vm.stat.delete(i); continue; }
    const t = vm.fx.temp(i);
    switch (s.picNum) {
      case T.WATERSPLASH2:
        // actors.c 4500: on its first tic a splash out of any water sector
        // (lotag 1 or 2) dies at once, else ITEM_SPLASH plays (one at a
        // time); then t[0] counts to 3 and t[1] up — at five threes (15
        // tics) it is gone.
        t[0]++;
        if (t[0] === 1) {
          const lot = (map.sectors[s.sectNum]?.lotag ?? 0) & LOTAG_MASK;
          if (lot !== 1 && lot !== 2) { s.removed = true; vm.stat.delete(i); break; }
          if (vm.sounds && vm.player) { const num = vm.labels.get('ITEM_SPLASH'); if (num !== undefined && !vm.sounds.isPlaying(num)) vm.sounds.at(num, i, s.x, s.y, s.z, vm.player, map); }
        }
        if (t[0] === 3) { t[0] = 0; t[1]++; }
        if (t[1] === 5) { s.removed = true; vm.stat.delete(i); }
        break;
      case T.FRAMEEFFECT1:
      case T.FRAMEEFFECT1_13CON:
        if (s.owner >= 0) {
          t[0]++;
          if (t[0] > 7) { s.removed = true; vm.stat.delete(i); break; }
          if (t[0] > 4) s.cstat |= 512 + 2;
          else if (t[0] > 2) s.cstat |= 2;
          const own = map.sprites[s.owner];
          if (own) { s.xOffset = own.xOffset; s.yOffset = own.yOffset; }
        }
        break;
      case T.BLOOD:
      case T.FORCERIPPLE:
      case T.WATERBUBBLE:
        // actors.c: `execute(i, p, x)` — the CON's BLOOD / FORCERIPPLE / WATERBUBBLE actors.
        if (vm.execute(map, i, cam, cam ? playerDist(cam, s) : 0)) { s.removed = true; vm.stat.delete(i); }
        break;

      case T.BLOODSPLAT1: case T.BLOODSPLAT2: case T.BLOODSPLAT3: case T.BLOODSPLAT4:
        // actors.c 4429: for 7*26 tics the splat runs down 16..31 a tic,
        // getting a unit taller every ninth.
        if (t[0] === 7 * 26) break;
        s.z += 16 + (krand(vm.fx) & 15);
        t[0]++;
        if ((t[0] % 9) === 0) s.yRepeat++;
        break;

      case T.BLOODPOOL:
      case T.PUKE:
        moveBloodPool(map, vm, i, cam);
        break;

      case T.MONEY + 1:
      case MAIL + 1:
      case PAPER + 1:
        // actors.c 4565: landed — kept on the floor under it, which may move.
        s.z = getZsOfSlope(map, s.sectNum, s.x, s.y).floorZ;
        vm.floorZ.set(i, s.z);
        break;

      case SHELL:
      case SHOTGUNSHELL: {
        // actors.c 4799: a spent case. ssp; below the floor by 24<<8 or out
        // of the map it is gone. Under water it tumbles slowly (frame every
        // 9 tics, sinks toward 128, drifts to a stop); in air a frame every
        // 4 tics, falls by gc/3 to 512, and dies when its speed runs out.
        const r = moveSprite(vm, map, i, (s.xVel * bsin(s.ang + 512)) >> 14, (s.xVel * bsin(s.ang)) >> 14, s.zVel);
        void r;
        const sec = map.sectors[s.sectNum];
        if (!sec || sec.floorZ + (24 << 8) < s.z) { s.removed = true; vm.stat.delete(i); break; }
        if ((sec.lotag & LOTAG_MASK) === 2) {
          t[1]++;
          if (t[1] > 8) { t[1] = 0; t[0] = (t[0] + 1) & 3; }
          if (s.zVel < 128) s.zVel += Math.trunc(GC / 13); else s.zVel -= 64;
          if (s.xVel > 0) s.xVel -= 4; else s.xVel = 0;
        } else {
          t[1]++;
          if (t[1] > 3) { t[1] = 0; t[0] = (t[0] + 1) & 3; }
          if (s.zVel < 512) s.zVel += Math.trunc(GC / 3);
          if (s.xVel > 0) s.xVel--; else { s.removed = true; vm.stat.delete(i); }
        }
        break;
      }

      case TONGUE:
        // actors.c 4560: a segment of the tongue lives one tic.
        s.removed = true; vm.stat.delete(i);
        break;

      case INNERJAW:
      case INNERJAW + 1: {
        // actors.c 4542: the jaw bites a player within 512 (4 off, red
        // flash), then — falling into the FIRELASER case — lives two tics.
        const pl = vm.pstate;
        if (cam && pl && playerDist(cam, s) < 512) {
          pl.pal = { time: 32, r: 32, g: 0, b: 0 };
          if (!pl.god) pl.health -= 4;   // Duke takes it off the extra, and moveplayers puts max back each tic under god
        }
        if (s.extra !== 999) s.extra = 999;
        else { s.removed = true; vm.stat.delete(i); }
        break;
      }

      case MAIL:
      case PAPER:
      case T.MONEY: {
        // actors.c 4173: a bill flutters — xvel from a sine of T1, T1 steps
        // by rand&63, and on the downward half of the cycle it sinks a little
        // faster (to 144, 64 under water); ssp; landed, it becomes MONEY+1
        // and turns red beside a blood pool.
        s.xVel = (krand(vm.fx) & 7) + (bsin(t[0] & 2047) >> 9);
        t[0] += krand(vm.fx) & 63;
        if ((t[0] & 2047) > 512 && (t[0] & 2047) < 1596) {
          const lt = map.sectors[s.sectNum]?.lotag & LOTAG_MASK;
          if (lt === 2) { if (s.zVel < 64) s.zVel += (GC >> 5) + (krand(vm.fx) & 7); }
          else if (s.zVel < 144) s.zVel += (GC >> 5) + (krand(vm.fx) & 7);
        }
        // The bounds movesprite clamps to: Duke's are hittype[].floorz as EGS
        // copied them from the OWNER (lotsofmoney passes 0 — sprite 0's,
        // whatever that is), so a bill sinks through its real floor and the
        // `z > l` test below lands it. Here the bounds are the floor and
        // ceiling under the bill each tic, and "on the floor" is landed:
        // a bill that fluttered off a stage sank in Duke; with the spawn
        // sector's floor kept it hung in the air over the lower room.
        {
          const zz = getZsOfSlope(map, s.sectNum, s.x, s.y);
          vm.floorZ.set(i, zz.floorZ); vm.ceilingZ.set(i, zz.ceilZ);
        }
        moveSprite(vm, map, i, (s.xVel * bsin(s.ang + 512)) >> 14, (s.xVel * bsin(s.ang)) >> 14, s.zVel);
        if ((krand(vm.fx) & 3) === 0) s.sectNum = updateSector(map, s.x, s.y, s.sectNum);
        if (s.sectNum < 0) { s.removed = true; vm.stat.delete(i); break; }
        const l = getZsOfSlope(map, s.sectNum, s.x, s.y).floorZ;
        // Landed: on the floor, or so close that the next sink step (which
        // movesprite would refuse) crosses it.
        if (s.z >= l || (s.zVel > 0 && s.z + ((s.zVel * TICS_PER_FRAME) >> 3) > l)) {
          s.z = l;
          s.picNum++;
          for (const o of map.sprites) {
            if (o.removed || o.picNum !== T.BLOODPOOL || (vm.stat.get(map.sprites.indexOf(o)) ?? -1) !== STAT.MISC) continue;
            if (ldist(s.x - o.x, s.y - o.y) < 348) { s.pal = 2; break; }
          }
        }
        break;
      }

      case T.NEON1: case T.NEON2: case T.NEON3: case T.NEON4: case T.NEON5: case T.NEON6:
        // actors.c 4520: the neon flicker off global_random, the lotag its
        // duty — `(global_random/(lotag+1)&31) > 4` is lit (shade -127),
        // else dark (127). The same sawtooth the SE 4 comment describes.
        s.shade = ((Math.floor(vm.fx.globalRandom / (s.lotag + 1))) & 31) > 4 ? -127 : 127;
        break;
      case T.NUKEBUTTON: case T.NUKEBUTTON + 1: case T.NUKEBUTTON + 2: case T.NUKEBUTTON + 3: {
        // actors.c 4405: once pressed (t[0] set), the button counts — at 8
        // the second tile, at 16 the third and the player's fist starts
        // (fist_incs = 1); when the fist reaches 26 the fourth tile.
        if (t[0]) {
          t[0]++;
          if (t[0] === 8) s.picNum = T.NUKEBUTTON + 1;
          else if (t[0] === 16) { s.picNum = T.NUKEBUTTON + 2; if (vm.pstate) vm.pstate.fistIncs = 1; }
          if (vm.pstate?.fistIncs === 26) s.picNum = T.NUKEBUTTON + 3;
        }
        break;
      }
      case T.TRANSPORTERSTAR:
      case T.TRANSPORTERBEAM:
      case T.EXPLOSION2:
      case T.EXPLOSION2BOT:
      case T.SMALLSMOKE:
      case T.SHRINKEREXPLOSION:
      case T.BURNING:
      case T.BURNING2:
        // moveexplosions(): `execute(i, p, x)` — their CON actors count frames
        // and killit.
        if (vm.execute(map, i, cam, playerDist(cam, s))) { s.removed = true; vm.stat.delete(i); }
        break;
      default:
        if (JIB_TILES.has(s.picNum)) moveJib(map, vm, i);
        else if (s.picNum >= T.GLASSPIECES && s.picNum <= T.GLASSPIECES + 2) moveGlassPiece(map, vm, i);
        else if (s.picNum >= SCRAP6 && s.picNum <= SCRAP5 + 3) moveScrap(map, vm, i);
        break;
    }
  }
}

/**
 * A gib, actors.c 4620. Its speed decays one a tic and it dies after 300
 * tics regardless. In the air: t[1] counts three tics, then the frame t[0]
 * cycles 0..3; gravity is gc-50 a tic (a trickle under water), and it moves
 * along its angle. On the floor: pinned at floor-2<<8, speed 0, and a JIBS6
 * — the blood — runs its splat frames every four tics up to 7 and is gone
 * 20 tics after landing. Anything else that lands becomes a JIBS6. The
 * drawn tile is picnum + t[0] (game.c 5868); animatesprites' shade -6 is
 * not applied.
 */
function moveJib(map, vm, i) {
  const s = map.sprites[i];
  const t = vm.fx.temp(i);
  if (s.xVel > 0) s.xVel--; else s.xVel = 0;
  if (t[5] < 30 * 10) t[5]++; else { s.removed = true; vm.stat.delete(i); return; }
  if (s.zVel > 1024 && s.zVel < 1280) s.sectNum = updateSector(map, s.x, s.y, s.sectNum);
  const sect = s.sectNum;
  if (sect < 0) { s.removed = true; vm.stat.delete(i); return; }
  const zz = getZsOfSlope(map, sect, s.x, s.y);
  if (zz.floorZ === zz.ceilZ) { s.removed = true; vm.stat.delete(i); return; }
  const lt = map.sectors[sect].lotag & LOTAG_MASK;
  if (s.z < zz.floorZ - (2 << 8)) {
    if (t[1] < 2) t[1]++;
    else if (lt !== 2) {
      t[1] = 0;
      if (t[0] > 2) t[0] = 0; else t[0]++;
    }
    if (s.zVel < 6144) {
      if (lt === 2) { if (s.zVel < 1024) s.zVel += 48; else s.zVel = 1024; }
      else s.zVel += GC - 50;
    }
    s.x += (s.xVel * bsin(s.ang + 512)) >> 14;
    s.y += (s.xVel * bsin(s.ang)) >> 14;
    s.z += s.zVel;
  } else {
    if (t[2] === 0) {
      if (map.sectors[sect].floorStat & 2) { s.removed = true; vm.stat.delete(i); return; }
      t[2]++;
    }
    s.z = zz.floorZ - (2 << 8);
    s.xVel = 0;
    if (s.picNum === 2286) {
      t[1]++;
      if ((t[1] & 3) === 0 && t[0] < 7) t[0]++;
      if (t[1] > 20) { s.removed = true; vm.stat.delete(i); }
    } else {
      s.picNum = 2286; t[0] = 0; t[1] = 0;
    }
  }
}


/**
 * ifhitbyweapon() for the player, actors.c: the damage filed on the player
 * by checkhitsprite comes off the health, and the player is SHOVED — their
 * momentum gains `damage*cos<<1` and `damage*sin<<1` along the weapon's
 * angle (explosions push twice as hard; none of those fly here yet). Health
 * bottoms out at 0. Returns the weapon's picnum if a hit was taken, else -1,
 * and the pain flash is left to the page: `player.painTime` is set to 32, as
 * Duke's pals_time is.
 *
 * `pl` is player.js's state, which carries xVel/yVel as posxv/posyv and, from
 * here on, `health`.
 */
export function takePlayerDamage(vm, pl) {
  // Called once a tic: the flash counts down here whether or not a hit lands.
  if (pl.painTime > 0) pl.painTime--;
  const h = vm.playerHit;
  // A SHRINKSPARK files no damage (extra 0) but a hit all the same: the
  // APLAYER script's `ifwasweapon SHRINKSPARK` — the shrink (GAME.CON
  // 3669: palfrom 48 0 48, move PSHRINKING, ACTOR_SHRINKING). God is NOT
  // spared: actors.c 1026, `if (ud.god && picnum != SHRINKSPARK) return
  // -1` — the one hit DNKROZ lets through.
  if (h.picNum === T.SHRINKSPARK && h.extra <= 0 && h.filed) {
    h.filed = false; h.picNum = -1;
    if (!(pl.shrinkCount >= 0)) { pl.shrinkCount = 0; pl.pal = { time: 48, r: 0, g: 48, b: 0 }; return T.SHRINKSPARK; }
    return -1;
  }
  if (h.extra <= 0) return -1;
  // `ud.god`: ifhitbyweapon returns -1 for the player before anything is
  // taken off — the filing is dropped, no shove, no flash. DNKROZ.
  if (pl.god) { h.extra = 0; h.picNum = -1; return -1; }
  if (pl.health <= 0) { h.extra = 0; return -1; }
  let dmg = h.extra;
  // incur_damage(): with armour on, a share of 20..49 % of the hit goes to
  // the shield — and if that empties it, the remainder comes back to the
  // health. `damage * (20 + TRAND%30) / 100`.
  if (pl.shield > 0) {
    let shieldDmg = Math.trunc((dmg * (20 + (krand(vm.fx) % 30))) / 100);
    dmg -= shieldDmg;
    pl.shield -= shieldDmg;
    if (pl.shield < 0) { dmg -= pl.shield; pl.shield = 0; }
  }
  pl.health -= dmg;
  if (pl.health < 0) pl.health = 0;
  // GAME.CON 3678: `ifwasweapon FREEZEBLAST { palfrom 48 0 0 48 ifdead {
  // sound SOMETHINGFROZE spritepal 1 move 0 action PFROZEN } }` — killed by
  // the freezer the player does not fall dead but freezes (pal 1); the
  // page and deathTic take it from here.
  if (h.picNum === T.FREEZEBLAST) {
    pl.pal = { time: 48, r: 0, g: 0, b: 48 };
    if (pl.health <= 0 && !pl.frozen) { pl.frozen = true; pl.frozenCount = -1; pl.shattered = false; }
  }
  pl.xVel += (dmg * bsin(h.ang + 512)) << 1;
  pl.yVel += (dmg * bsin(h.ang)) << 1;
  pl.painTime = 32;
  pl.lastHitBy = h.picNum;
  h.extra = 0;
  h.picNum = -1;
  return pl.lastHitBy;
}


// ---------------------------------------------------------------------------
// The player's pistol: shoot(player, SHOTSPARK1), player.c 489..640, and the
// hit it lands, checkhitsprite() for an actor, sector.c 2290..2345.
// ---------------------------------------------------------------------------

const JIBS6 = 2286;

/**
 * checkhitsprite(target, weapon) for an actor. What a hit does BEFORE the
 * script sees it: for a plain badguy, blood (JIBS6 — spawned sized 0 here,
 * no case yet); the actor turns to face the shot and is knocked back
 * (`xvel = -(damage<<2)`); a dozing actor wakes with a full sleep countdown;
 * and the damage is FILED — picnum, extra added, angle, owner — for
 * ifhitbyweapon on the actor's own tic. Switches, breakables and the other
 * picnum cases of the original are not here.
 */
export function hitSprite(vm, map, target, weapon) {
  const t = map.sprites[target], w = map.sprites[weapon];
  if (!t || !w || t.removed) return;
  const pn = t.picNum;
  // The decoration a shot breaks — fans, bottles, toilets, pipes, chairs —
  // handled by hitwall.js when the page wired it; those never file damage.
  if (vm.hitBreakable && !isBadguy(vm, t)) {
    const what = vm.hitBreakable(vm, map, target, weapon, vm.player);
    if (what) { vm.lastBreak = what; return; }
  }
  if (isBadguy(vm, t)) {
    const type = vm.actorType.get(pn) ?? 0;
    if (pn !== DRONE && pn !== ROTATEGUN && pn !== COMMANDER && !(pn >= 2370 && pn <= 2377) && type === 0) {
      const j = spawnFrom(vm, map, weapon, JIBS6);
      if (j >= 0) {
        const jb = map.sprites[j];
        jb.z += 4 << 8; jb.xVel = 16; jb.xRepeat = jb.yRepeat = 24;
        jb.ang += 32 - (krand(vm.fx) & 63);
      }
    }
    if (pn !== BOSS1 && pn !== BOSS2 && pn !== 1960 && pn !== ROTATEGUN) {
      if ((t.cstat & 48) === 0) t.ang = (w.ang + 1024) & 2047;
      t.xVel = -(w.extra << 2);
    }
    // sector.c 2328: `if(statnum == 2) { changespritestat(i,1); timetosleep
    // = SLEEPTIME; }`. A scripted dozer has no stat filed here and only
    // leaves `asleep`; a C-moved one (GREENSLIME, E2L2) dozes as statnum 2,
    // and taking it off `asleep` alone left it a zombie nothing ran and
    // movefta no longer looked at — hit once, it hung in the air for good.
    if (vm.asleep.has(target) || vm.stat.get(target) === STAT.ZOMBIE) {
      vm.asleep.delete(target);
      if (vm.stat.get(target) === STAT.ZOMBIE) vm.stat.set(target, STAT.ACTOR);
      vm.timeToSleep.set(target, SLEEPTIME);
    }
  }
  vm.hitPic.set(target, w.picNum);
  vm.hitExtra.set(target, Math.max(0, vm.hitExtra.get(target) ?? -1) + w.extra);
  vm.hitAng.set(target, w.ang);
  vm.hitOwner.set(target, w.owner);
}

/**
 * shoot(player, SHOTSPARK1): the pistol. From the eye (posz + 4<<8, then
 * 2<<8 lower), along the view with a jitter of up to 31 either side, the
 * vertical from horiz (`(100-horiz)<<5`, jittered by up to 255), hitscan
 * with CLIPMASK1 — sprites included. At the hit point a SHOTSPARK1 sprite
 * appears (size 10, shade -15, statnum 4, owner the player) carrying the
 * pistol's CON strength plus 0..5, and if a sprite was hit, checkhitsprite
 * files it. Auto-aim (`aim()`) is not here: every shot goes where the view
 * points. Returns the hit `{ sprite, wall, sect, x, y, z }`.
 */
export function shootPistol(vm, map, cam, horiz) {
  return shootHitscan(vm, map, cam, horiz, T.SHOTSPARK1);
}

/**
 * The player's hitscan family: SHOTSPARK1 (pistol), SHOTGUN, CHAINGUN.
 * player.c 489. All three auto-aim; the difference is the scatter. The
 * pistol scatters ONLY when no target was found. The shotgun and chaingun
 * ALWAYS add 16-(TRAND&31) to the angle and 128-(TRAND&255) to the vertical,
 * aimed or not — that is the spread of the seven shotgun pellets and the
 * chaingun's stream. The spark carries the weapon's CON strength + TRAND%6.
 */
export function shootHitscan(vm, map, cam, horiz, atwith) {
  const PLAYER_OWNER = -2;                       // no player sprite in this world
  const sx = cam.x, sy = cam.y;
  let sz = cam.z + (4 << 8);
  let sa = cam.ang, zvel;
  const j = aimAt(vm, map, cam, horiz, 48);
  if (j >= 0) {
    const tg = map.sprites[j];
    const th = vm.art?.get(tg.picNum)?.height ?? 0;
    let dal = ((tg.xRepeat * th) << 1) + (5 << 8);
    if (tg.picNum === ROTATEGUN || (tg.picNum >= 2370 && tg.picNum <= 2377)) dal -= 8 << 8;
    zvel = Math.trunc(((tg.z - sz - dal) << 8) / (ldist(tg.x - sx, tg.y - sy) || 1));
    sa = getAngle(vm.radarang, tg.x - sx, tg.y - sy);
  }
  if (atwith === T.SHOTSPARK1) {
    if (j === -1) {
      sa += 16 - (krand(vm.fx) & 31);
      zvel = ((100 - horiz) << 5) + 128 - (krand(vm.fx) & 255);
    }
  } else {
    sa += 16 - (krand(vm.fx) & 31);
    if (j === -1) zvel = (100 - horiz) << 5;
    zvel += 128 - (krand(vm.fx) & 255);
  }
  sz -= 2 << 8;
  const h = hitScan(map, sx, sy, sz, cam.sectNum, bsin(sa + 512), bsin(sa), zvel << 6, CLIPMASK1, vm.art);
  vm.shotsFired = (vm.shotsFired || 0) + 1;
  if (h.sect < 0) { vm.lastShot = { sprite: -1, wall: -1, sect: -1, aimed: j, x: 0, y: 0, z: 0 }; return h; }
  const k = makeSprite(vm, map, h.sect, h.x, h.y, h.z, T.SHOTSPARK1, -15, 10, 10, sa, 0, 0, PLAYER_OWNER, STAT.WEAPON);
  const spark = map.sprites[k];
  const hdr = vm.actorScr.get(atwith);
  spark.extra = (hdr !== undefined ? vm.script[hdr] : 0) + (krand(vm.fx) % 6);
  if (h.sprite >= 0) {
    // player.c 454: a player's hitscan on a sprite — checkhitsprite, then
    // checkhitswitch(p, hitspr, 1): a shot flips a wall switch as a hand
    // would (never an ACCESSSWITCH/ACCESSSWITCH2, those want the card).
    const hp = map.sprites[h.sprite]?.picNum;
    hitSprite(vm, map, h.sprite, k);
    if (hp !== 130 && hp !== 170 && vm.hitSwitch && (map.sprites[h.sprite]?.lotag ?? 0) !== 0) vm.hitSwitch(1, h.sprite);
  }
  else if (h.wall >= 0 && vm.shotHitWall) vm.lastWallHit = vm.shotHitWall(vm, map, h, cam, atwith, k);
  else if (zvel > 0 && ((map.sectors[h.sect]?.lotag ?? 0) & LOTAG_MASK) === 1 && vm.playerSprite >= 0) {
    // player.c 474: a shot downward that ends on a water surface (lotag 1,
    // nothing else hit): a WATERSPLASH2 spawned off the PLAYER's sprite —
    // its z, the player's feet — moved to the hit point, turned the
    // player's way, stepped 32 along it (ssp), then still.
    const w = spawnFrom(vm, map, vm.playerSprite, T.WATERSPLASH2);
    if (w >= 0) {
      const sp = map.sprites[w];
      sp.x = h.x; sp.y = h.y; sp.ang = cam.ang; sp.xVel = 32;
      const sn = updateSector(map, sp.x, sp.y, sp.sectNum); if (sn >= 0) sp.sectNum = sn;
      moveSprite(vm, map, w, (sp.xVel * bsin(sp.ang + 512)) >> 14, (sp.xVel * bsin(sp.ang)) >> 14, 0, CLIPMASK0);
      sp.xVel = 0;
    }
  }
  vm.lastShot = { sprite: h.sprite, wall: h.wall, sect: h.sect, aimed: j, x: h.x, y: h.y, z: h.z };
  // The spark and the smoke it spawns: SMALLSMOKE has no case here yet, the
  // spark itself is a statnum-4 sprite the weapons pass does not know and
  // leaves alone; it is removed at once so the list does not fill with them.
  spark.removed = true; vm.stat.delete(k);
  return h;
}

/**
 * The pistol's cycle, player.c: `kickback_pic` 1 fires, then it counts to 5
 * and resets — five tics a shot while the button is held — and every twelfth
 * round the count runs on to 27 for the reload instead. Ammo is not counted
 * (no pickups exist to refill it), which the HUD says.
 */
export function pistolTic(st, fire, shootFn) {
  st.kickback = st.kickback || 0;
  st.rounds = st.rounds || 0;
  if (st.kickback === 0) {
    // The press sets kickback_pic to 1 in getinput(); the shot comes on the
    // NEXT tic's weapon pass, when it reads 1. So a held button is a shot
    // every five tics, not four. And the round is spent HERE, on the press
    // (player.c 3581: `if(ammo > 0) { ammo--; kb = 1; }`) — an empty pistol
    // never arms.
    if (fire) {
      if (st.ammo === undefined) st.kickback = 1;
      else if (st.ammo > 0) { st.ammo--; st.kickback = 1; }
    }
    return false;
  }
  let fired = false;
  if (st.kickback === 1) { shootFn(); st.rounds++; fired = true; }
  else if (st.kickback === 2 && st.ejectShell) st.ejectShell('pistol');   // player.c 3778
  st.kickback++;
  if (st.kickback >= 5 && (st.rounds % 12) !== 0) st.kickback = 0;
  if (st.kickback >= 27) st.kickback = 0;
  return fired;
}


/**
 * aim(): the auto-aim, player.c. Of every live badguy with cstat 257 and not
 * invisible, the nearest that lies within `aang` either side of the facing,
 * farther than 512, whose height agrees with the view pitch (the scaled
 * vertical offset within 100 rows of horiz-100), and that can see the
 * shooter — both from 32<<8 up. Returns its index or -1. The shooter here is
 * always the player, so the sprite-shooter branches are not needed.
 */
export function aimAt(vm, map, cam, horiz, aang) {
  const a = cam.ang;
  const dx1 = bsin(a + 512 - aang), dy1 = bsin(a - aang);
  const dx2 = bsin(a + 512 + aang), dy2 = bsin(a + aang);
  const dx3 = bsin(a + 512), dy3 = bsin(a);
  let smax = 0x7fffffff, j = -1;
  for (let i = 0; i < map.sprites.length; i++) {
    const t = map.sprites[i];
    if (t.removed || t.xRepeat <= 0 || t.extra < 0) continue;
    if ((t.cstat & (257 + 32768)) !== 257) continue;
    if (!isBadguy(vm, t)) continue;
    const xv = t.x - cam.x, yv = t.y - cam.y;
    if (dy1 * xv > dx1 * yv) continue;
    if (dy2 * xv < dx2 * yv) continue;
    const sdist = Math.floor((dx3 * xv) / 16384) + Math.floor((dy3 * yv) / 16384);
    if (sdist <= 512 || sdist >= smax) continue;
    // `s` in aim() is the player's SPRITE, whose z is posz + PHEIGHT (38<<8)
    // — the feet, not the eye (player.c 3355). Measured from the eye, a
    // target on the same floor reads 10240 too low and fails the 100-row
    // test at any range under about 1000: every close shot went unaimed.
    const feet = cam.z + (38 << 8);
    const vert = Math.abs(Math.trunc(((t.z - feet) * 10) / sdist) - (horiz - 100)) < 100;
    if (!vert) continue;
    const from = (t.picNum === ORGANTIC || t.picNum === ROTATEGUN) ? t.z : t.z - (32 << 8);
    if (!canSee(map, t.x, t.y, from, t.sectNum, cam.x, cam.y, feet - (32 << 8), cam.sectNum)) continue;
    smax = sdist; j = i;
  }
  return j;
}


/**
 * shoot(i, SHOTSPARK1/SHOTGUN/CHAINGUN) from an ACTOR — player.c 489, the
 * p < 0 branch. Aimed at the player by findplayer: the vertical from the
 * player's eye over the octagonal distance, plus a jitter of up to 255; the
 * angle straight at the player plus 64-(TRAND&127) (a BOSS1 aims true). The
 * muzzle is 4<<8 lower than the actor's top. The actor's own hitscan bit is
 * dropped for the ray so it cannot shoot itself. At the hit a 24x24
 * SHOTSPARK1 carries the weapon's CON strength; on the player (sprite -2)
 * that is filed as damage, as checkhitsprite(player, k) does.
 */
export function actorHitscan(vm, map, i, atwith) {
  const s = map.sprites[i];
  const p = vm.player;
  if (!p) return -1;
  const tile = vm.art?.get(s.picNum);
  let sz = s.z - ((s.yRepeat * (tile?.height ?? 0)) << 1) + (4 << 8);
  let sx = s.x, sy = s.y;
  if (s.picNum !== ROTATEGUN) {
    sz -= 7 << 8;
    if (isBadguy(vm, s) && s.picNum !== COMMANDER) {
      sx += bsin(s.ang + 1024 + 96) >> 7;
      sy += bsin(s.ang + 512 + 96) >> 7;
    }
  }
  if (s.extra >= 0) s.shade = -96;
  sz -= 4 << 8;
  let zvel = Math.trunc(((p.z - sz) << 8) / (ldist(p.x - sx, p.y - sy) || 1));
  let sa;
  if (s.picNum === BOSS1) sa = getAngle(vm.radarang, p.x - sx, p.y - sy);
  else {
    zvel += 128 - (krand(vm.fx) & 255);
    sa = getAngle(vm.radarang, p.x - sx, p.y - sy) + 64 - (krand(vm.fx) & 127);
  }
  const own = s.cstat;
  s.cstat &= ~257;
  const h = hitScan(map, sx, sy, sz, s.sectNum, bsin(sa + 512), bsin(sa), zvel << 6, CLIPMASK1, vm.art, p);
  s.cstat = own;
  vm.shotsByActors = (vm.shotsByActors || 0) + 1;
  if (h.sect < 0) return -1;
  const k = makeSprite(vm, map, h.sect, h.x, h.y, h.z, T.SHOTSPARK1, -15, 24, 24, sa, 0, 0, i, STAT.WEAPON);
  const spark = map.sprites[k];
  const hdr = vm.actorScr.get(atwith);
  spark.extra = hdr !== undefined ? vm.script[hdr] : 0;
  if (h.sprite === -2) {
    vm.playerHits.set(atwith, (vm.playerHits.get(atwith) || 0) + 1);
    vm.playerHit.picNum = atwith;
    vm.playerHit.extra += spark.extra;
    vm.playerHit.ang = spark.ang;
    vm.playerHit.owner = i;
  } else if (h.sprite >= 0) {
    hitSprite(vm, map, h.sprite, k);
  } else if (h.wall >= 0 && vm.shotHitWall) {
    // player.c 677: an actor's shot on a wall goes through checkhitwall too.
    vm.shotHitWall(vm, map, h, p, T.SHOTSPARK1, k);
  }
  spark.removed = true; vm.stat.delete(k);
  return k;
}


/**
 * The three weapons' firing cycles, player.c: one function per weapon,
 * driven once a tic with the fire button. `shootFn(atwith)` fires one shot;
 * `soundFn(name)` plays a player sound by its CON name. Each returns what it
 * did this tic, for the HUD.
 *
 *   pistol    press arms kickback 1; shot on 1; five tics a round; every
 *             twelfth round the count runs to 27 (reload)
 *   shotgun   press arms 1; on 4 SEVEN shots and one shell spent, SHOTGUN_FIRE;
 *             on 15 the cock; the count runs to 31 — about a shot a second
 *   chaingun  press arms 1; while held, a shot every third tic up to 12,
 *             then round again while held; released, it stops at once
 */
export function weaponTic(st, fire, shootFn, soundFn = () => {}) {
  if (st.holsterWeapon) return false;                // player.c 3561: nothing fires while holstered
  if (st.weaponPos) return false;                // sinking or rising: no shot
  // player.c 3551: shrunk, or while the tip hand or the access card is up,
  // the fire bit is cleared.
  if (st.shrunk || st.tipIncs > 0 || st.accessIncs > 0) fire = false;
  const w = st.currWeapon ?? 1;
  if (w === 2) return shotgunTic(st, fire, shootFn, soundFn);
  if (w === 3) return chaingunTic(st, fire, shootFn, soundFn);
  if (w === 4) return rpgTic(st, fire, shootFn, soundFn);
  if (w === 7) return devastatorTic(st, fire, shootFn, soundFn);
  if (w === 5) return handbombTic(st, fire, !!st.crouching, (c) => shootFn(T.HEAVYHBOMB, { crouch: c }));
  if (w === 10) return handremoteTic(st, fire);
  if (w === 8) return tripbombTic(st, fire, () => shootFn(T.HANDHOLDINGLASER), () => st.canPlaceTripbomb ? st.canPlaceTripbomb() : true);
  if (w === 6) return shrinkerTic(st, fire, shootFn, soundFn);
  if (w === 11) return growTic(st, fire, shootFn, soundFn);
  if (w === 9) return freezeTic(st, fire, shootFn, soundFn);
  if (w === 0) { const k = kneeTic(st, fire, () => shootFn(T.KNEE), () => krandLite(st)); return k; }
  const fired = pistolTic(st, fire, () => shootFn(T.SHOTSPARK1));
  if (fired) soundFn('PISTOL_FIRE');
  return fired;
}

export function shotgunTic(st, fire, shootFn, soundFn) {
  st.kickback = st.kickback || 0;
  if (st.kickback === 0) {
    if (fire && st.ammoAmount[2] > 0) st.kickback = 1;
    return false;
  }
  st.kickback++;
  let fired = false;
  if (st.kickback === 4) {
    for (let n = 0; n < 7; n++) shootFn(T.SHOTGUN);
    st.ammoAmount[2]--;
    soundFn('SHOTGUN_FIRE');
    fired = true;
  }
  if (st.kickback === 15) soundFn('SHOTGUN_COCK');
  if (st.kickback === 24 && st.ejectShell) st.ejectShell('shotgun');      // player.c 3846
  if (st.kickback === 17 || st.kickback === 20 || st.kickback === 24) st.kickback++;
  if (st.kickback >= 31) st.kickback = 0;
  return fired;
}

export function chaingunTic(st, fire, shootFn, soundFn) {
  st.kickback = st.kickback || 0;
  if (st.kickback === 0) {
    if (fire && st.ammoAmount[3] > 0) st.kickback = 1;
    return false;
  }
  st.kickback++;
  let fired = false;
  if (st.kickback <= 12) {
    if (st.kickback % 3 === 0) {
      if (st.ammoAmount[3] > 0) {
        st.ammoAmount[3]--;
        if (st.ejectShell) st.ejectShell('chaingun');                        // player.c 3870
        soundFn('CHAINGUN_FIRE');
        shootFn(T.CHAINGUN);
        fired = true;
      }
      if (!fire || st.ammoAmount[3] <= 0) st.kickback = 0;
    }
  } else if (st.kickback > 10) {
    st.kickback = fire ? 1 : 0;
  }
  return fired;
}

/** A weapon key: switch if owned. Returns the slot switched to, or -1. */
export function selectWeapon(st, slot) {
  if (!st.gotWeapon[slot]) return -1;
  if (st.kickback) return -1;                    // not mid-cycle
  if (slot === st.currWeapon) return slot;
  addWeapon(st, slot);                           // the sink-and-rise, as a pickup does it
  return slot;
}


/**
 * shoot(i, RPG), player.c 803. Speed 644; a 14x14 rocket placed a little
 * ahead (sin(sa+348)/448) and 1<<8 up, statnum 4, strength from the CON
 * header + (TRAND&7). The player aims with the same aim() as the guns, the
 * vertical from the target's mid-height (8<<8 up) — unaimed, from horiz at
 * 81 a row; an ACTOR aims at the player, and its rocket is 30x30 with a
 * quarter of the strength (except the bosses). `player`/`horiz` for the
 * player's shot, `i` the shooter's sprite otherwise.
 */
export function shootRpg(vm, map, i, player, horiz, atwith) {
  const fromPlayer = !!player;
  let sx, sy, sz, sa, zvel, sect;
  const vel = 644;
  if (fromPlayer) {
    sx = player.x; sy = player.y; sz = player.z + (4 << 8); sa = player.ang; sect = player.sectNum;
    const j = aimAt(vm, map, player, horiz, 48);
    if (j >= 0) {
      const tg = map.sprites[j];
      const th = vm.art?.get(tg.picNum)?.height ?? 0;
      const dal = ((tg.xRepeat * th) << 1) + (8 << 8);
      zvel = Math.trunc(((tg.z - sz - dal) * vel) / (ldist(tg.x - sx, tg.y - sy) || 1));
      if (tg.picNum !== 1960) sa = getAngle(vm.radarang, tg.x - sx, tg.y - sy);
    } else zvel = (100 - horiz) * 81;
  } else {
    const s = map.sprites[i];
    const p = vm.player;
    const tile = vm.art?.get(s.picNum);
    sx = s.x; sy = s.y; sect = s.sectNum;
    sz = s.z - ((s.yRepeat * (tile?.height ?? 0)) << 1) + (4 << 8);
    if (s.picNum !== ROTATEGUN) {
      sz -= 7 << 8;
      if (isBadguy(vm, s) && s.picNum !== COMMANDER) { sx += bsin(s.ang + 1024 + 96) >> 7; sy += bsin(s.ang + 512 + 96) >> 7; }
    }
    if (s.extra >= 0) s.shade = -96;
    sa = getAngle(vm.radarang, p.x - sx, p.y - sy);
    zvel = Math.trunc(((p.z - sz) * vel) / (ldist(p.x - sx, p.y - sy) || 1));
    if (isBadguy(vm, s) && (s.hitag & MF.face_player_smart)) sa = s.ang + (krand(vm.fx) & 31) - 16;
  }
  const j = makeSprite(vm, map, sect,
    sx + Math.trunc(bsin(348 + sa + 512) / 448), sy + Math.trunc(bsin(sa + 348) / 448), sz - (1 << 8),
    atwith, 0, 14, 14, sa, vel, zvel, fromPlayer ? -2 : i, STAT.WEAPON);
  const r = map.sprites[j];
  r.extra += krand(vm.fx) & 7;
  if (!fromPlayer) { r.xRepeat = 30; r.yRepeat = 30; r.extra >>= 2; }
  else if (player.devastator) {
    // player.c 900: a devastator rocket is a quarter-strength RPG with
    // 16-(TRAND&31) of angle and 256-(TRAND&511) of vertical scatter, set
    // off to the side that fired (hbomb_hold_delay picks it).
    r.extra >>= 2;
    r.ang += 16 - (krand(vm.fx) & 31);
    r.zVel += 256 - (krand(vm.fx) & 511);
    if (player.holdDelay) {
      r.x -= Math.trunc(bsin(sa) / 644);
      r.y -= Math.trunc(bsin(sa + 1024 + 512) / 644);
    }
  }
  r.cstat = 128;
  r.clipDist = 4;
  return j;
}

/**
 * The devastator's cycle, player.c 3667 and 3935: a press (with ammo) arms
 * 1 and flips hbomb_hold_delay — the side; then the count runs, and on
 * every ODD count a rocket leaves and a round is spent; past 5 it resets.
 * Two rockets a press, alternating sides, six tics apart while held.
 */
export function devastatorTic(st, fire, shootFn, soundFn) {
  st.kickback = st.kickback || 0;
  if (st.kickback === 0) {
    if (fire && st.ammoAmount[7] > 0) { st.kickback = 1; st.holdDelay = !st.holdDelay; }
    return false;
  }
  st.kickback++;
  let fired = false;
  if (st.kickback & 1) {
    st.ammoAmount[7]--;
    shootFn(T.RPG, { devastator: true, holdDelay: st.holdDelay });
    soundFn('RPG_SHOOT');
    fired = true;
  }
  if (st.kickback > 5) st.kickback = 0;
  return fired;
}

/**
 * hitradius(i, r, hp1, hp2, hp3, hp4), actors.c 445: the blast. Every live
 * badguy (or hitscan-solid sprite) within r — the 3D octagonal distance with
 * the height at a sixteenth — that can see the blast (its 8<<8 to the
 * blast's 12<<8) is FILED a hit: the angle away from the blast, the weapon
 * (RPG for a live target of a rocket, RADIUSEXPLOSION otherwise), and a
 * damage from the band it stands in — under r/3 hp3..hp4, under 2r/3
 * hp2..hp3, under r hp1..hp2 — plus a knockback of `extra<<2`. The player
 * is a target too, measured from the eye, filed on vm.playerHit.
 *
 * Not here: the wall pass (checkhitwall on every wall within r), the
 * flammables, and the special picnums.
 */
export function hitRadius(vm, map, i, r, hp1, hp2, hp3, hp4, cam) {
  const s = map.sprites[i];
  const band = (d) => {
    if (d < Math.trunc(r / 3)) { if (hp4 === hp3) hp4++; return hp3 + (krand(vm.fx) % (hp4 - hp3)); }
    if (d < Math.trunc((2 * r) / 3)) { if (hp3 === hp2) hp3++; return hp2 + (krand(vm.fx) % (hp3 - hp2)); }
    if (d < r) { if (hp2 === hp1) hp2++; return hp1 + (krand(vm.fx) % (hp2 - hp1)); }
    return 0;
  };
  const shrinker = s.picNum === T.SHRINKSPARK;
  let hits = 0;
  // The wall pass first (actors.c 455), when the page has wired hitwall.js.
  if (vm.blastWalls && !shrinker) vm.blastWalls(vm, map, i, r, cam);
  for (let j = 0; j < map.sprites.length; j++) {
    const t = map.sprites[j];
    if (j === i || t.removed) continue;
    // actors.c 514: sprites of statnum 0 and 5 up — the decoration, the
    // standables, the misc — are hit DIRECTLY through checkhitsprite when
    // within r (a badguy among them only if it can see the blast); nothing
    // is filed for them, since nothing runs a script to collect it. The
    // fan beside the gas tanks breaks this way. Actors (1, 2) are filed.
    // statlist = {0,1,6,10,12,2,5} and `x == 0 || x >= 5`: the stats hit
    // directly are 0, 2 and 5; actors (1), standables (6), players (10) and
    // fallers (12) are filed, for their own tic to read.
    const st = vm.stat.get(j) ?? (vm.hasScript(t.picNum) ? STAT.ACTOR : 0);
    if (st === 0 || st === STAT.ZOMBIE || st === STAT.MISC || AFLAMABLE.has(t.picNum)) {
      if (t.cstat & 32768) continue;              // invisible: a start mark, a hidden charge
      if (shrinker && !(t.cstat & 257)) continue;
      if (findDistance3D(s.x - t.x, s.y - t.y, (s.z - t.z) >> 4) >= r) continue;
      if (isBadguy(vm, t) && !canSee(map, t.x, t.y, t.z - (8 << 8), t.sectNum, s.x, s.y, s.z - (12 << 8), s.sectNum)) continue;
      hitSprite(vm, map, j, i);
      hits++;
      continue;
    }
    if (t.extra < 0) continue;
    // actors.c 525 names four tiles beside badguy() and cstat&257: TRIPBOMB
    // (a placed one is cstat 16 — neither bit), the two pool balls and
    // DUKELYINGDEAD. Without them a blast walked past a trip bomb on a wall.
    if (!(isBadguy(vm, t) || (t.cstat & 257) || t.picNum === T.TRIPBOMB
        || t.picNum === T.QUEBALL || t.picNum === T.STRIPEBALL || t.picNum === 1518)) continue;   // 1518 DUKELYINGDEAD
    // The shrinker (actors.c 527): never its owner, never a shark, never
    // one already under 24 wide — and it needs the target SOLID (cstat 257).
    if (shrinker && (j === s.owner || t.picNum === SHARK || t.xRepeat < 24 || !(t.cstat & 257))) continue;
    const d = findDistance3D(s.x - t.x, s.y - t.y, (s.z - t.z) >> 4);
    if (d >= r) continue;
    if (!canSee(map, t.x, t.y, t.z - (8 << 8), t.sectNum, s.x, s.y, s.z - (12 << 8), s.sectNum)) continue;
    vm.hitAng.set(j, getAngle(vm.radarang, t.x - s.x, t.y - s.y));
    vm.hitOwner.set(j, s.owner);
    if (shrinker) {
      // Filed as SHRINKSPARK with no damage: the script does the shrinking.
      vm.hitPic.set(j, T.SHRINKSPARK);
      vm.hitExtra.set(j, Math.max(0, vm.hitExtra.get(j) ?? -1));
      hits++;
      continue;
    }
    vm.hitPic.set(j, (s.picNum === T.RPG && t.extra > 0) ? T.RPG : T.RADIUSEXPLOSION);
    vm.hitExtra.set(j, Math.max(0, vm.hitExtra.get(j) ?? -1) + band(d));
    if (t.picNum !== ROTATEGUN && t.picNum !== 1960 && !BOSS_TILES.has(t.picNum)) {
      if (t.xVel < 0) t.xVel = 0;
      t.xVel += s.extra << 2;
    }
    if (vm.asleep.has(j)) { vm.asleep.delete(j); vm.timeToSleep.set(j, SLEEPTIME); }
    hits++;
  }
  if (cam && !(shrinker && s.owner === -2)) {
    // The player: Duke measures from the sprite z less PHEIGHT — the eye.
    const d = findDistance3D(s.x - cam.x, s.y - cam.y, (s.z - cam.z) >> 4);
    if (d < r && canSee(map, cam.x, cam.y, cam.z - (8 << 8), cam.sectNum, s.x, s.y, s.z - (12 << 8), s.sectNum)) {
      // actors.c 531: the shrinker's blast files SHRINKSPARK and no damage
      // (its hp bands are zeros); the RPG its own name, anything else
      // RADIUSEXPLOSION.
      const dmg = shrinker ? 0 : band(d);
      vm.playerHit.picNum = shrinker ? T.SHRINKSPARK : (s.picNum === T.RPG ? T.RPG : T.RADIUSEXPLOSION);
      vm.playerHit.extra += dmg;
      vm.playerHit.filed = true;
      vm.playerHit.ang = getAngle(vm.radarang, cam.x - s.x, cam.y - s.y);
      vm.playerHit.owner = s.owner;
      vm.playerHits.set(vm.playerHit.picNum, (vm.playerHits.get(vm.playerHit.picNum) || 0) + 1);
      hits++;
    }
  }
  return hits;
}

/**
 * The RPG's cycle, player.c: the press arms 1; on 4 one rocket and one
 * round; the count runs to 20. About two shots every three seconds.
 */
export function rpgTic(st, fire, shootFn, soundFn) {
  st.kickback = st.kickback || 0;
  if (st.kickback === 0) {
    if (fire && st.ammoAmount[4] > 0) st.kickback = 1;
    return false;
  }
  st.kickback++;
  let fired = false;
  if (st.kickback === 4) {
    st.ammoAmount[4]--;
    shootFn(T.RPG);
    soundFn('RPG_SHOOT');
    fired = true;
  } else if (st.kickback === 20) st.kickback = 0;
  return fired;
}


/** The player's shot, by weapon tile: hitscan for the guns, a rocket for the RPG. */
export function playerShoot(vm, map, cam, horiz, atwith, opts = null) {
  if (atwith === T.HEAVYHBOMB) return throwPipebomb(vm, map, cam, vm.pstate, !!opts?.crouch);
  if (atwith === T.HANDHOLDINGLASER) return placeTripbomb(vm, map, cam, vm.pstate);
  if (atwith === T.KNEE) return shootKnee(vm, map, cam, horiz);
  if (atwith === T.SHRINKER) return shootShrinker(vm, map, cam, horiz);
  if (atwith === T.FREEZEBLAST) return shootFreeze(vm, map, cam, horiz);
  if (atwith === T.GROWSPARK) return shootGrow(vm, map, cam, horiz);
  if (atwith === T.RPG) {
    // The devastator's rockets carry their flags on a view of the camera.
    const shooter = opts?.devastator ? { ...cam, devastator: true, holdDelay: opts.holdDelay } : cam;
    return shootRpg(vm, map, -2, shooter, horiz, atwith);
  }
  return shootHitscan(vm, map, cam, horiz, atwith);
}


// ---------------------------------------------------------------------------
// Pipe bombs: HANDBOMB_WEAPON (slot 5) throws a HEAVYHBOMB, HANDREMOTE_WEAPON
// (slot 10) sets them off. The bomb itself is moved in C (actors.c 3988),
// not by its CON script.
// ---------------------------------------------------------------------------

/**
 * The throw, player.c: on count 12 a HEAVYHBOMB (9x9, shade -16) leaves from
 * a little ahead of the player at `140 + hold<<5` (or 15, dropped, when
 * crouching on the ground: yvel 3, 8<<8 lower), the vertical from horiz
 * (`-512 - (horiz-100)*20`). With a wall closer than 512 it is thrown
 * BACKWARDS at a third of the speed. Owner the player; hbomb_on set.
 */
export function throwPipebomb(vm, map, cam, pl, crouching) {
  let k, zv;
  if (pl.onGround && crouching) { k = 15; zv = (cam.horiz - 100) * 20; }
  else { k = 140; zv = -512 - (cam.horiz - 100) * 20; }
  const j = makeSprite(vm, map, cam.sectNum,
    cam.x + (bsin(cam.ang + 512) >> 6), cam.y + (bsin(cam.ang) >> 6), cam.z,
    T.HEAVYHBOMB, -16, 9, 9, cam.ang, k + ((pl.holdCount || 0) << 5), zv, -2, STAT.ACTOR);
  const b = map.sprites[j];
  if (k === 15) { b.yVel = 3; b.z += 8 << 8; }
  if (hitsFromPlayer(vm, map, cam) < 512) {
    b.ang = (b.ang + 1024) & 2047;
    b.zVel = Math.trunc(b.zVel / 3);
    b.xVel = Math.trunc(b.xVel / 3);
  }
  b.cstat = 257;
  b.clipDist = 8;
  vm.fx.temp(j).fill(0);
  const zz = getZsOfSlope(map, b.sectNum, b.x, b.y);
  vm.floorZ.set(j, zz.floorZ);
  vm.ceilingZ.set(j, zz.ceilZ);
  pl.hbombOn = 1;
  return j;
}

/**
 * The bomb's tic, actors.c 3988. Near the player (under 1220) it does not
 * block. A hit sets it off. Otherwise it falls, and on reaching the floor
 * bounces up `(4 - yvel)<<8` up to three times (PIPEBOMB_BOUNCE) — not in
 * water, where it sinks 32<<8 into the floor with one splash — moves
 * along its angle losing 5 a tic, and off a wall reflects its angle and
 * halves its speed. When the owner's hbomb_on is cleared (the detonator) or
 * it was hit: on the second tic the blast — hitradius over
 * pipebombblastradius with its strength in four bands — an EXPLOSION2, the
 * sound, then it vanishes (yrepeat 0) and is removed 20 tics on. A bomb
 * lying still (xvel 0, t[0] past 7) within 788 of a player who can see it
 * and has room is picked up as one round.
 */
export function moveHeavyBomb(map, vm, i, cam, pl, kind = false) {
  const s = map.sprites[i];
  const t = vm.fx.temp(i);
  // kind: false (a pipe bomb), 'mine' (BOUNCEMINE) or 'morter' (the boss's
  // MORTER, actors.c 3983): both of the latter glow (a FRAMEEFFECT1 a tic,
  // T1 3), go off on any contact or a player within 844, and are never
  // picked up; only the mine skips the fall — a mortar shell drops and
  // bursts where it lands.
  const mine = kind === 'mine' || kind === 'morter';
  const hangs = kind === 'mine';
  if (mine) { const g = spawnFrom(vm, map, i, T.FRAMEEFFECT1); if (g >= 0) vm.fx.temp(g)[0] = 3; }
  const x = playerDist(cam, s);
  if (x < 1220) s.cstat &= ~257; else s.cstat |= 257;
  let l = s.owner === -2 ? 0 : -1;             // the player's own: their hbomb_on counts
  let goDetonate = false;
  if (t[3] === 0) {
    const filed = vm.hitExtra.get(i) ?? -1;
    if (filed >= 0) {
      vm.hitExtra.set(i, -1);
      t[3] = 1; t[4] = 0; l = -1; s.xVel = 0;
      goDetonate = true;
    }
  }
  if (!goDetonate) {
    const lt = (map.sectors[s.sectNum]?.lotag ?? 0) & LOTAG_MASK;
    // actors.c 4020: a mine neither falls nor bounces — it hangs in the water.
    if (!hangs) makeItFall(vm, map, i);
    const fz = vm.floorZ.get(i) ?? getZsOfSlope(map, s.sectNum, s.x, s.y).floorZ;
    const cz = vm.ceilingZ.get(i) ?? getZsOfSlope(map, s.sectNum, s.x, s.y).ceilZ;
    if (!hangs && lt !== 1 && s.z >= fz - FOURSLEIGHT && s.yVel < 3) {
      if (s.yVel > 0 || (s.yVel === 0 && fz === map.sectors[s.sectNum].floorZ)) {
        const n = vm.labels?.get('PIPEBOMB_BOUNCE');
        if (n !== undefined && vm.sounds) vm.sounds.at(n, i, s.x, s.y, s.z, cam, map);
      }
      s.zVel = -((4 - s.yVel) << 8);
      if (lt === 2) s.zVel >>= 2;
      s.yVel++;
    }
    if (!hangs && s.z < cz) { s.z = cz + (3 << 8); s.zVel = 0; }
    const j = moveSprite(vm, map, i, (s.xVel * bsin(s.ang + 512)) >> 14, (s.xVel * bsin(s.ang)) >> 14, s.zVel);
    // actors.c 4043: resting in water (lotag 1, of the sector it is in now)
    // it sits 32<<8 into the floor — sunk, the surface over it — and the
    // first such tic spawns a WATERSPLASH2 (whose first tic plays
    // ITEM_SPLASH). It does not bounce there (the lotag != 1 above), so no
    // PIPEBOMB_BOUNCE either.
    if (((map.sectors[s.sectNum]?.lotag ?? 0) & LOTAG_MASK) === 1 && s.zVel === 0) {
      s.z += 32 << 8;
      if (t[5] === 0) { t[5] = 1; spawnFrom(vm, map, i, T.WATERSPLASH2); }
    } else t[5] = 0;
    // actors.c 4056: a mine that met anything, or a player within 844, goes off.
    if (mine && t[3] === 0 && (j || x < 844)) { t[3] = 1; t[4] = 0; l = -1; s.xVel = 0; goDetonate = true; }
    if (s.xVel > 0) {
      s.xVel -= 5;
      if (lt === 2) s.xVel -= 10;
      if (s.xVel < 0) s.xVel = 0;
      if (s.xVel & 8) s.cstat ^= 4;
    }
    if ((j & 49152) === 32768) {
      const w = map.walls[j & 16383], w2 = map.walls[w.point2];
      const k = getAngle(vm.radarang, w2.x - w.x, w2.y - w.y);
      s.ang = ((k << 1) - s.ang) & 2047;
      s.xVel >>= 1;
    }
  }
  // DETONATEB
  if ((l >= 0 && pl && !pl.hbombOn) || t[3] === 1) {
    t[4]++;
    if (t[4] === 2) {
      const xx = s.extra;
      hitRadius(vm, map, i, kind === 'mine' ? (vm.bouncemineBlastRadius ?? 2500) : kind === 'morter' ? (vm.morterBlastRadius ?? 2500) : (vm.pipebombBlastRadius ?? 2500), xx >> 2, xx >> 1, xx - (xx >> 2), xx, cam);
      spawnFrom(vm, map, i, T.EXPLOSION2);
      if (s.zVel === 0) spawnFrom(vm, map, i, T.EXPLOSION2BOT);
      const n = vm.labels?.get('PIPEBOMB_EXPLODE');
      if (n !== undefined && vm.sounds) vm.sounds.at(n, i, s.x, s.y, s.z, cam, map);
    }
    if (s.yRepeat) { s.yRepeat = 0; return; }
    if (t[4] > 20) { s.removed = true; vm.stat.delete(i); }
    return;
  }
  // Lying still near a player with room: picked up as a round — a pipe bomb, never a mine.
  if (!mine && x < 788 && t[0] > 7 && s.xVel === 0 && pl
      && canSee(map, s.x, s.y, s.z - (8 << 8), s.sectNum, cam.x, cam.y, cam.z, cam.sectNum)
      && (pl.ammoAmount[5] < pl.maxAmmoAmount[5] || pl.stuffCheat)) {   // the page's standing DNSTUFF keeps the magazine full; the bomb is still taken
    addAmmo(pl, 5, 1);
    const n = vm.labels?.get('DUKE_GET');
    if (n !== undefined && vm.sounds) vm.sounds.at(n, -2, cam.x, cam.y, cam.z, cam, map);
    if (!pl.gotWeapon[5] || s.owner === -2) addWeapon(pl, 5);
    if (s.owner !== -2) pl.pal = { time: 32, r: 0, g: 32, b: 0 };
    s.removed = true; vm.stat.delete(i);
    return;
  }
  if (t[0] < 8) t[0]++;
}

/**
 * The pipe bomb's cycle, player.c: the press (with ammo) arms 1 and clears
 * the hold count; counts 2..6 held add to it (up to 5, a throw of 140+160);
 * at 6 with the button still down it WAITS; released, it runs on to 12 and
 * throws, then to 20 and hands over to the detonator (slot 10, rising).
 */
export function handbombTic(st, fire, crouch, throwFn) {
  st.kickback = st.kickback || 0;
  if (st.kickback === 0) {
    if (fire && st.ammoAmount[5] > 0) { st.kickback = 1; st.holdCount = 0; }
    return false;
  }
  if (st.kickback === 6 && fire) return false;
  st.kickback++;
  if (st.kickback === 12) {
    st.ammoAmount[5]--;
    throwFn(crouch);
    return true;
  } else if (st.kickback < 12 && fire) {
    st.holdCount = (st.holdCount || 0) + 1;
  } else if (st.kickback > 19) {
    st.kickback = 0;
    st.currWeapon = 10;
    st.lastWeapon = -1;
    st.weaponPos = 10;
  }
  return false;
}

/**
 * The detonator, player.c: a press arms 1; on 2 hbomb_on is cleared and
 * every bomb of the player's goes off; on 10 the count resets and the
 * pipe bombs come back if any are left, else the pistol.
 */
export function handremoteTic(st, fire) {
  st.kickback = st.kickback || 0;
  if (st.kickback === 0) {
    if (fire) { st.kickback = 1; st.holdCount = 0; }
    return false;
  }
  st.kickback++;
  if (st.kickback === 2) st.hbombOn = 0;
  if (st.kickback === 10) {
    st.kickback = 0;
    if (st.ammoAmount[5] > 0) addWeapon(st, 5);
    else addWeapon(st, 1);
  }
  return false;
}


// ---------------------------------------------------------------------------
// Trip bombs (TRIPBOMB_WEAPON, slot 8) and the knee (KNEE_WEAPON, slot 0).
// ---------------------------------------------------------------------------

/**
 * The press, player.c 3690: a hitscan from the eye must meet a WALL (no
 * sprite) within 290, not masked, into a sector of lotag <= 2, with no
 * other trip bomb within 290 at that height. Then the cycle starts.
 */
export function canPlaceTripbomb(vm, map, cam) {
  const h = hitScan(map, cam.x, cam.y, cam.z, cam.sectNum, bsin(cam.ang + 512), bsin(cam.ang), (100 - cam.horiz) * 32, CLIPMASK1, vm.art);
  if (h.sect < 0 || h.sprite >= 0 || h.wall < 0) return false;
  const w = map.walls[h.wall];
  if (((map.sectors[h.sect].lotag ?? 0) & LOTAG_MASK) > 2) return false;
  if (w.cstat & 16) return false;
  const nextOk = w.nextSector >= 0 ? ((map.sectors[w.nextSector].lotag & LOTAG_MASK) <= 2) : ((map.sectors[h.sect].lotag & LOTAG_MASK) <= 2);
  if (!nextOk) return false;
  const dx = h.x - cam.x, dy = h.y - cam.y;
  if (dx * dx + dy * dy >= 290 * 290) return false;
  for (const sp of map.sprites) {
    if (sp.removed || sp.picNum !== T.TRIPBOMB || sp.sectNum !== h.sect) continue;
    const ex = sp.x - h.x, ey = sp.y - h.y;
    if (Math.abs(sp.z - h.z) < (12 << 8) && ex * ex + ey * ey < 290 * 290) return false;
  }
  return true;
}

/**
 * shoot(i, HANDHOLDINGLASER), player.c: the same hitscan; on a wall within
 * 290 into a lotag<=2 sector a TRIPBOMB (4x5, shade -16) is set at the hit
 * point, backed off the wall a step (xvel -20 through ssp), made a wall
 * sprite (cstat 16) turned square to the wall — T6 = the wall's angle - 512
 * — filed as a standable with hitag = its own index, LASERTRIP_ONWALL.
 */
export function placeTripbomb(vm, map, cam, pl) {
  const zvel = (100 - cam.horiz) * 32;
  const h = hitScan(map, cam.x, cam.y, cam.z, cam.sectNum, bsin(cam.ang + 512), bsin(cam.ang), zvel << 6, CLIPMASK1, vm.art);
  if (h.sprite >= 0 || h.wall < 0 || h.sect < 0) return -1;
  const dx = h.x - cam.x, dy = h.y - cam.y;
  if (dx * dx + dy * dy >= 290 * 290) return -1;
  const w = map.walls[h.wall];
  const ok = w.nextSector >= 0
    ? ((map.sectors[w.nextSector].lotag & LOTAG_MASK) <= 2 && (map.sectors[h.sect].lotag & LOTAG_MASK) <= 2)
    : ((map.sectors[h.sect].lotag & LOTAG_MASK) <= 2);
  if (!ok) return -1;
  const k = makeSprite(vm, map, h.sect, h.x, h.y, h.z, T.TRIPBOMB, -16, 4, 5, cam.ang, 0, 0, -2, STAT.STANDABLE);
  const b = map.sprites[k];
  b.hitag = k;
  b.xVel = -20;
  moveSprite(vm, map, k, (b.xVel * bsin(b.ang + 512)) >> 14, (b.xVel * bsin(b.ang)) >> 14, 0);
  b.xVel = 0;
  b.cstat = 16;
  const w2 = map.walls[w.point2];
  const t = vm.fx.temp(k); t.fill(0);
  t[5] = b.ang = (getAngle(vm.radarang, w.x - w2.x, w.y - w2.y) - 512) & 2047;
  if (vm.sounds) { const n = vm.labels?.get('LASERTRIP_ONWALL'); if (n !== undefined) vm.sounds.at(n, k, b.x, b.y, b.z, cam, map); }
  if (pl) pl.ammoAmount[8]--;
  return k;
}

/**
 * movestandables() for a TRIPBOMB, actors.c 1781. T3 counting down is the
 * fuse: at 8 the blast — hitradius over tripbombblastradius, an EXPLOSION2
 * sent along the beam at 348, its LASERLINEs blanked, KILLIT. Otherwise: a
 * hit of any kind lights the fuse (T3 = 16). T1 counts to 32 only while the
 * player is farther than 768 (past 16 it runs on regardless): the arming
 * delay. At 32 the beam is cast — from a step off the wall, square to it,
 * hitasprite measures it (lastvx) and a LASERLINE is laid every 1024 units,
 * the last one shortened; a sprite in the beam already lights the fuse
 * (T3 = 13). At 33, armed: the beam is measured every tic, and a change in
 * its length — someone in it — lights the fuse.
 */
export function moveTripbomb(map, vm, i, cam) {
  const s = map.sprites[i];
  const t = vm.fx.temp(i);
  if (t[2] > 0) {
    t[2]--;
    if (t[2] === 8) {
      if (vm.sounds) { const n = vm.labels?.get('LASERTRIP_EXPLODE'); if (n !== undefined) vm.sounds.at(n, i, s.x, s.y, s.z, cam, map); }
      const x = s.extra;
      hitRadius(vm, map, i, vm.tripbombBlastRadius ?? 3880, x >> 2, x >> 1, x - (x >> 2), x, cam);
      const j = spawnFrom(vm, map, i, T.EXPLOSION2);
      if (j >= 0) {
        const e = map.sprites[j];
        e.ang = s.ang; e.xVel = 348;
        moveSprite(vm, map, j, (e.xVel * bsin(e.ang + 512)) >> 14, (e.xVel * bsin(e.ang)) >> 14, 0);
        e.xVel = 0;
      }
      for (const l of map.sprites) if (!l.removed && l.picNum === T.LASERLINE && l.hitag === s.hitag) { l.xRepeat = 0; l.yRepeat = 0; }
      s.removed = true; vm.stat.delete(i);
    }
    return;
  }
  // Any hit lights the fuse.
  if ((vm.hitExtra.get(i) ?? -1) >= 0) { vm.hitExtra.set(i, -1); t[2] = 16; }
  const x = playerDist(cam, s);
  if (t[0] < 32) {
    if (x > 768) t[0]++;
    else if (t[0] > 16) t[0]++;
  }
  const measure = () => {
    const ox = s.x, oy = s.y, oz = s.z, oa = s.ang;
    s.ang = t[5];
    s.x += bsin(t[5] + 512) >> 9; s.y += bsin(t[5]) >> 9; s.z -= 3 << 8;
    const len = hitASprite(vm, map, i);
    const hit = vm.lastHitSprite;
    s.x = ox; s.y = oy; s.z = oz; s.ang = oa;
    return { len, hit };
  };
  if (t[0] === 32) {
    const { len, hit } = measure();
    vm.lastVx.set(i, len);
    let rem = len;
    let lx = s.x + (bsin(t[5] + 512) >> 9), ly = s.y + (bsin(t[5]) >> 9);
    const lz = s.z - (3 << 8);
    let guard = 0;
    while (rem > 0 && guard++ < 64) {
      const j = spawnFrom(vm, map, i, T.LASERLINE);
      if (j < 0) break;
      const l = map.sprites[j];
      l.x = lx; l.y = ly; l.z = lz; l.hitag = s.hitag;
      l.sectNum = updateSector(map, lx, ly, s.sectNum);
      lx += bsin(t[5] + 512) >> 4; ly += bsin(t[5]) >> 4;
      if (rem < 1024) { l.xRepeat = rem >> 5; break; }
      rem -= 1024;
    }
    t[0]++;
    if (hit >= 0) {
      t[2] = 13;
      if (vm.sounds) { const n = vm.labels?.get('LASERTRIP_ARMING'); if (n !== undefined) vm.sounds.at(n, i, s.x, s.y, s.z, cam, map); }
    } else t[2] = 0;
  }
  if (t[0] === 33) {
    t[1]++;
    const { len } = measure();
    if (vm.lastVx.get(i) !== len) {
      t[2] = 13;
      if (vm.sounds) { const n = vm.labels?.get('LASERTRIP_ARMING'); if (n !== undefined) vm.sounds.at(n, i, s.x, s.y, s.z, cam, map); }
    }
  }
}

/** actors.c 87: a parallaxed ceiling/floor that is a space sky, pal 0. */
export const ceilingSpace = (sec) => (sec.ceilingStat & 1) !== 0 && (sec.ceilingPal ?? 0) === 0 && (sec.ceilingPicNum === 80 || sec.ceilingPicNum === 84);
export const floorSpace = (sec) => (sec.floorStat & 1) !== 0 && (sec.ceilingPal ?? 0) === 0 && (sec.floorPicNum === 80 || sec.floorPicNum === 84);

/**
 * movefallers(), actors.c 1420. T1 == 0: waiting. A hit of FIREEXT, RPG,
 * RADIUSEXPLOSION, SEENINE or OOZFILTER that uses the strength up sets
 * every faller of the same hitag falling (T1 = 1, one-sidedness dropped,
 * steam made invisible); any other hit is undone. T1 == 1: the lotag counts
 * down by 3 as a delay, then a jump (xvel 32+, zvel -1024-); then the slide
 * loses 8 a tic, gravity (gc; gc/6 in ceiling space; none in floor space)
 * pulls while above the floor; within 16<<8 of the floor: scrap, gone.
 */
export function moveFallers(map, vm, cam) {
  for (let i = 0; i < map.sprites.length; i++) {
    const s = map.sprites[i];
    if (s.removed || vm.stat.get(i) !== STAT.FALLER) continue;
    const t = vm.fx.temp(i);
    if (t[0] === 0) {
      const x = s.extra;
      const filed = vm.hitExtra.get(i) ?? -1;
      if (filed >= 0) {
        vm.hitExtra.set(i, -1);
        s.extra -= filed;
        const j = vm.hitPic.get(i);
        if (j === 916 || j === T.RPG || j === T.RADIUSEXPLOSION || j === T.SEENINE || j === T.OOZFILTER) {
          if (s.extra <= 0) {
            t[0] = 1;
            for (let k = 0; k < map.sprites.length; k++) {
              const o = map.sprites[k];
              if (o.removed || vm.stat.get(k) !== STAT.FALLER || o.hitag !== s.hitag) continue;
              vm.fx.temp(k)[0] = 1;
              o.cstat &= 65535 - 64;
              if (o.picNum === 1255 || o.picNum === 1250) o.cstat |= 32768;
            }
          }
        } else {
          s.extra = x;
        }
      }
      continue;
    }
    if (t[0] === 1) {
      if (s.lotag > 0) {
        s.lotag -= 3;
        if (s.lotag <= 0) {
          s.xVel = 32 + (krand(vm.fx) & 63);
          s.zVel = -(1024 + (krand(vm.fx) & 1023));
        }
        continue;
      }
      if (s.xVel > 0) {
        s.xVel -= 8;
        moveSprite(vm, map, i, (s.xVel * bsin(s.ang + 512)) >> 14, (s.xVel * bsin(s.ang)) >> 14, 0);
      }
      const sec = map.sectors[s.sectNum];
      if (!sec) { s.removed = true; vm.stat.delete(i); continue; }
      // actors.c 87: floorspace/ceilingspace are the SPACE skies only —
      // a parallaxed flat showing MOONSKY1 or BIGORBIT1 with pal 0. A city
      // sky is not one; a first guess ("any parallax ceiling") made every
      // street a sixth-gravity zone, and a falling sign drifted 30 tics
      // instead of 14, three times as far along the street.
      let x;
      if (floorSpace(sec)) x = 0;
      else if (ceilingSpace(sec)) x = Math.trunc(GC / 6);
      else x = GC;
      if (s.z < sec.floorZ - FOURSLEIGHT) {
        s.zVel += x;
        if (s.zVel > 6144) s.zVel = 6144;
        s.z += s.zVel;
      }
      if (sec.floorZ - s.z < (16 << 8)) {
        randomScrap(vm, map, i, 1 + (krand(vm.fx) & 7));
        s.removed = true; vm.stat.delete(i);
      }
    }
  }
}

/**
 * movestandables() for CRACK1..4, actors.c 1901: with a hitag, a hit by
 * FIREEXT, RPG, RADIUSEXPLOSION, SEENINE or OOZFILTER lights every SEENINE
 * and OOZFILTER of that hitag (shade -32) and the crack detonates like a
 * tank; any other hit is undone. Without a hitag it does nothing.
 */
export function moveCrack(map, vm, i, cam) {
  const s = map.sprites[i];
  if (s.hitag <= 0) return;
  const filed = vm.hitExtra.get(i) ?? -1;
  if (filed < 0) return;
  vm.hitExtra.set(i, -1);
  const j = vm.hitPic.get(i);
  if (j === 916 || j === T.RPG || j === T.RADIUSEXPLOSION || j === T.SEENINE || j === T.OOZFILTER) {
    for (const o of map.sprites) {
      if (!o.removed && o.hitag === s.hitag && (o.picNum === T.SEENINE || o.picNum === T.OOZFILTER) && o.shade !== -32) o.shade = -32;
    }
    // DETONATE, as a tank does: effectors of the hitag, then the blast.
    vm.fx.earthquakeTime = 16;
    for (let k = 0; k < map.sprites.length; k++) {
      const e = map.sprites[k];
      if (e.removed || e.picNum !== 1 || e.hitag !== s.hitag) continue;
      const et = vm.fx.temp(k);
      if (e.lotag === 13) { if (et[2] === 0) et[2] = 1; }
      else if (e.lotag === 8) et[4] = 1;
      else if (e.lotag === 18) { if (et[0] === 0) et[0] = 1; }
      else if (e.lotag === 21) et[0] = 1;
    }
    s.z -= 32 << 8;
    const x = s.extra;
    spawnFrom(vm, map, i, T.EXPLOSION2);
    hitRadius(vm, map, i, vm.seenineBlastRadius ?? 2048, x >> 2, x - (x >> 1), x - (x >> 2), x, cam);
    if (vm.sounds) { const n = vm.labels?.get('PIPEBOMB_EXPLODE'); if (n !== undefined) vm.sounds.at(n, i, s.x, s.y, s.z, cam, map); }
    s.removed = true; vm.stat.delete(i);
  } else {
    s.extra = 0;
  }
}

/**
 * movestandables() for the flammables, actors.c 1742: once lit (T1 == 1),
 * every fourth tic it darkens a shade (to 64, then gone) and loses 0..7 of
 * its size each way (under 10 wide or 4 tall: gone); a TIRE at its 32nd
 * count turns into a dark BLOODPOOL instead. A BOX falls.
 */
export function moveFlammable(map, vm, i) {
  const s = map.sprites[i];
  const t = vm.fx.temp(i);
  if (t[0] === 1) {
    t[1]++;
    if ((t[1] & 3) === 0) {
      if (s.picNum === T.TIRE && t[1] === 32) {
        s.cstat = 0;
        const j = spawnFrom(vm, map, i, T.BLOODPOOL);
        if (j >= 0) map.sprites[j].shade = 127;
      } else {
        if (s.shade < 64) s.shade++;
        else { s.removed = true; vm.stat.delete(i); return; }
      }
      let j = s.xRepeat - (krand(vm.fx) & 7);
      if (j < 10) { s.removed = true; vm.stat.delete(i); return; }
      s.xRepeat = j;
      j = s.yRepeat - (krand(vm.fx) & 7);
      if (j < 4) { s.removed = true; vm.stat.delete(i); return; }
      s.yRepeat = j;
    }
  }
  if (s.picNum === T.BOX) makeItFall(vm, map, i);
}

/**
 * movestandables() for FIREEXT, actors.c 1929: any hit sets it off — 16
 * pieces of SCRAP3.. in pal 2, an EXPLOSION2, PIPEBOMB_EXPLODE and
 * GLASS_HEAVYBREAK; with a hitag it lights the SEENINE/OOZFILTER chain of
 * that hitag and detonates like a tank (a second EXPLOSION2, hitradius over
 * pipebombblastradius with its strength in four bands, the effectors);
 * without, hitradius over seenineblastradius with 10/15/20/25, and gone.
 */
/**
 * movestandables 1712, WATERFOUNTAIN..+3: once used (t[0] = 1 by
 * operatesprite), the picture steps a tic at a time through +1..+2 (a +3
 * folds back to +1) for twenty tics — the little arc of water — and then
 * keeps going while the player stands within 512, else back to the plain
 * fountain with t[0] = 0.
 */
export function moveWaterFountain(map, vm, i, cam) {
  const s = map.sprites[i];
  const t = vm.fx.temp(i);
  if (t[0] <= 0) return;
  if (t[0] < 20) {
    t[0]++;
    s.picNum++;
    if (s.picNum === T.WATERFOUNTAIN + 3) s.picNum = T.WATERFOUNTAIN + 1;
  } else {
    const x = cam ? playerDist(cam, s) : 1e9;
    if (x > 512) { t[0] = 0; s.picNum = T.WATERFOUNTAIN; }
    else t[0] = 1;
  }
}

/**
 * operatesprite 3112, WATERFOUNTAIN: the drink. Not already running: t[0] =
 * 1, the player its owner, and under the maximum a point of health with
 * DUKE_DRINKING. Returns 'drink' when the sip counted, 'running' else.
 */
export function useWaterFountain(vm, map, i, pl, say) {
  const s = map.sprites[i];
  const t = vm.fx.temp(i);
  if (t[0] === 1) return 'running';
  t[0] = 1;
  s.owner = vm.playerSprite;
  if (pl.health < pl.maxHealth) { pl.health++; if (say) say('DUKE_DRINKING'); return 'drink'; }
  return 'full';
}

export function moveFireExt(map, vm, i, cam) {
  const s = map.sprites[i];
  const filed = vm.hitExtra.get(i) ?? -1;
  if (filed < 0) return;
  vm.hitExtra.set(i, -1);
  s.extra -= filed;
  for (let k = 0; k < 16; k++) {
    const j = makeSprite(vm, map, s.sectNum, s.x, s.y, s.z - (krand(vm.fx) % (48 << 8)), 2408 + (krand(vm.fx) & 3), -8, 48, 48,
      krand(vm.fx) & 2047, (krand(vm.fx) & 63) + 64, -(krand(vm.fx) & 4095) - (s.zVel >> 2), i, STAT.MISC);
    map.sprites[j].pal = 2;
  }
  spawnFrom(vm, map, i, T.EXPLOSION2);
  if (vm.sounds) for (const n of ['PIPEBOMB_EXPLODE', 'GLASS_HEAVYBREAK']) { const k = vm.labels?.get(n); if (k !== undefined) vm.sounds.at(k, i, s.x, s.y, s.z, cam, map); }
  if (s.hitag > 0) {
    for (const o of map.sprites) if (!o.removed && o.hitag === s.hitag && (o.picNum === T.SEENINE || o.picNum === T.OOZFILTER) && o.shade !== -32) o.shade = -32;
    const x = s.extra;
    spawnFrom(vm, map, i, T.EXPLOSION2);
    hitRadius(vm, map, i, vm.pipebombBlastRadius ?? 2500, x >> 2, x - (x >> 1), x - (x >> 2), x, cam);
    // DETONATE: the effectors of the hitag, then gone (the blast is done).
    vm.fx.earthquakeTime = 16;
    for (let k = 0; k < map.sprites.length; k++) {
      const e = map.sprites[k];
      if (e.removed || e.picNum !== 1 || e.hitag !== s.hitag) continue;
      const et = vm.fx.temp(k);
      if (e.lotag === 13) { if (et[2] === 0) et[2] = 1; }
      else if (e.lotag === 8) et[4] = 1;
      else if (e.lotag === 18) { if (et[0] === 0) et[0] = 1; }
      else if (e.lotag === 21) et[0] = 1;
    }
  } else {
    hitRadius(vm, map, i, vm.seenineBlastRadius ?? 2048, 10, 15, 20, 25, cam);
  }
  s.removed = true; vm.stat.delete(i);
}

/**
 * moveactors() for RAT, actors.c 3255 — no script: it falls, runs along its
 * angle (ssp), and while it moves freely it wiggles (±15 plus a slow
 * sine on T1) and now and then squeaks (RATTY); blocked, T1 counts —
 * twice blocked and it is gone, once and it picks a new heading. Its speed
 * grows 2 a tic to 128, and its angle drifts -6..-3 a tic.
 */
export function moveRat(map, vm, i, cam) {
  const s = map.sprites[i];
  const t = vm.fx.temp(i);
  makeItFall(vm, map, i);
  const moved = moveSprite(vm, map, i, (s.xVel * bsin(s.ang + 512)) >> 14, (s.xVel * bsin(s.ang)) >> 14, s.zVel) === 0;
  if (moved) {
    if ((krand(vm.fx) & 255) < 3 && vm.sounds) { const n = vm.labels?.get('RATTY'); if (n !== undefined) vm.sounds.at(n, i, s.x, s.y, s.z, cam, map); }
    s.ang = (s.ang + (krand(vm.fx) & 31) - 15 + (bsin((t[0] << 8) & 2047) >> 11)) & 2047;
  } else {
    t[0]++;
    if (t[0] > 1) { s.removed = true; vm.stat.delete(i); return; }
    s.ang = krand(vm.fx) & 2047;
  }
  if (s.xVel < 128) s.xVel += 2;
  s.ang = (s.ang + (krand(vm.fx) & 3) - 6) & 2047;
}

/**
 * moveactors() for QUEBALL and STRIPEBALL, actors.c 3221 — the pool table.
 *
 * Rolling (xvel > 0): a POCKET within ldist 52 swallows it; clipmove along
 * the angle (walldist 24, clip 4<<8 both ways, CLIPMASK1); a wall reflects
 * the angle about the wall's own (`(k<<1) - ang`), a sprite is
 * checkhitsprite'd — another ball takes (xvel>>1)+(xvel>>2) and turns, the
 * mover recoils to `getangle(mover - hit) - 512`; anything else sends the
 * mover off at 164 in the hit thing's angle three times out of four, and
 * shatters it the fourth. xvel drops by one a tic. A STRIPEBALL spins by
 * flipping cstat bits 4 and 8 out of its speed.
 *
 * At rest: the player within 512 in the same sector nudges it away at 48;
 * the cue is the use key (cuePoolBall). No sleep: once seen, always moved.
 */
export function movePoolBall(map, vm, i, cam) {
  const s = map.sprites[i];
  if (s.xVel) {
    for (let j = 0; j < map.sprites.length; j++) {
      const o = map.sprites[j];
      if (o.removed || o.picNum !== T.POCKET) continue;
      if (ldist(o.x - s.x, o.y - s.y) < 52) { s.removed = true; vm.stat.delete(i); return; }
    }
    const pos = { x: s.x, y: s.y, z: s.z, sectNum: s.sectNum };
    const r = clipMove(map, pos,
      (((s.xVel * bsin(s.ang + 512)) >> 14) * TICS_PER_FRAME) << 11,
      (((s.xVel * bsin(s.ang)) >> 14) * TICS_PER_FRAME) << 11,
      24, 4 << 8, 4 << 8, CLIPMASK1, { art: vm.art });
    s.x = pos.x; s.y = pos.y; if (pos.sectNum >= 0) s.sectNum = pos.sectNum;
    if (typeof r === 'number' && (r & 49152)) {
      if ((r & 49152) === 32768) {
        const w = map.walls[r & 4095], w2 = map.walls[w.point2];
        const k = getAngle(vm.radarang, w2.x - w.x, w2.y - w.y);
        s.ang = ((k << 1) - s.ang) & 2047;
      } else if ((r & 49152) === 49152) {
        const j = r & 4095, o = map.sprites[j];
        if (o && !o.removed) {
          if (o.picNum === T.QUEBALL || o.picNum === T.STRIPEBALL) {
            o.xVel = (s.xVel >> 1) + (s.xVel >> 2);
            o.ang = (o.ang - ((s.ang << 1) + 1024)) & 2047;
            s.ang = (getAngle(vm.radarang, s.x - o.x, s.y - o.y) - 512) & 2047;
            if (vm.sounds) { const n = vm.labels?.get('POOLBALLHIT'); if (n !== undefined) vm.sounds.at(n, i, s.x, s.y, s.z, cam, map); }
          } else if (krand(vm.fx) & 3) {
            s.xVel = 164;
            s.ang = o.ang;
          } else {
            if (vm.lotsOfGlass) vm.lotsOfGlass(vm, map, s.x, s.y, s.z, s.ang, -1, 3, s.sectNum);
            s.removed = true; vm.stat.delete(i); return;
          }
        }
      }
    }
    s.xVel--;
    if (s.xVel < 0) s.xVel = 0;
    if (s.picNum === T.STRIPEBALL) {
      s.cstat = 257;
      s.cstat |= 4 & s.xVel;
      s.cstat |= 8 & s.xVel;
    }
  } else if (cam) {
    const x = playerDist(cam, s);
    if (x < 512 && s.sectNum === cam.sectNum) {
      s.ang = getAngle(vm.radarang, s.x - cam.x, s.y - cam.y);
      s.xVel = 48;
    }
  }
}

/**
 * moveactors() for CAMERA1, actors.c 4334: the security camera. While
 * intact (t[0] == 0) t[1] climbs by 8 a tic; with CAMERASDESTRUCTABLE a hit
 * makes it static — invisible (cstat 32768), five scraps, t[0] = 1. With a
 * hitag it pans: +8 a tic until t[1] reaches the hitag, -8 until three
 * hitags, +8 until four, then t[1] restarts at 8 with a 16 kick — a sweep
 * of 2*hitag units each way about a point hitag past the start.
 */
export function moveCamera(map, vm, i) {
  const s = map.sprites[i];
  const t = vm.fx.temp(i);
  if (t[0] !== 0) return;
  t[1] += 8;
  if (vm.camerasHitable && (vm.hitExtra.get(i) ?? -1) >= 0) {
    vm.hitExtra.set(i, -1);
    t[0] = 1;
    s.cstat = 32768;
    randomScrap(vm, map, i, 5);
    return;
  }
  if (s.hitag > 0) {
    if (t[1] < s.hitag) s.ang += 8;
    else if (t[1] < s.hitag * 3) s.ang -= 8;
    else if (t[1] < (s.hitag << 2)) s.ang += 8;
    else { t[1] = 8; s.ang += 16; }
    s.ang &= 2047;
  }
}

/**
 * The use key on a VIEWSCREEN, sector.c 3133. The first CAMERA1 not in use
 * (yvel 0) whose LOTAG is the screen's HITAG is switched to (yvel 1,
 * MONITOR_ACTIVE, the screen's owner and yvel note it), and the player's
 * `newowner` becomes that camera: from now on the view is drawn from the
 * camera (cameraViewTic), horiz 100 + the camera's shade (displayrooms
 * 3364), and the player does not move.
 *
 * What Duke does with the position: processinput 2678 sets posx/posy/posz
 * to the camera's, but returns before setsprite, so the player SPRITE
 * stays where the player stood. Every actor-side test that goes by the
 * sprite (movefta's cansee, shoot()'s aim at `sprite[ps[p].i]`) therefore
 * still sees the real spot; the ones that go by posx with the sprite's
 * sector (ifcansee, ifcanseetarget) get a point outside the sector they
 * name and fail. Here the player's place stays the player's place, the
 * view is a separate thing, and `vm.watching` makes those two fail. The
 * one deliberate difference: findplayer's distance is to the camera in
 * Duke (oposx = posx) and to the player here. Returns the camera or -1.
 *
 * Pressed again while watching: checksectors runs neartag from the
 * player's real place (oposx, oang) and lands here once more. The camera
 * in use keeps yvel 1, so the loop takes the NEXT free one of the same
 * lotag — the monitor steps through its cameras — and when none is left,
 * -1 means CLEARCAMERAS (leaveViewscreen): back to the player, all cameras
 * free, and the next press starts at the first again.
 */
export function useViewscreen(vm, map, screen, pl, cam) {
  const v = map.sprites[screen];
  if (!v || v.removed) return -1;
  // headspritestat[1], newest first: prelevel spawns in index order and
  // every changespritestat puts the sprite at the head, so among the
  // cameras the list runs from the highest index down.
  for (let i = map.sprites.length - 1; i >= 0; i--) {
    const s = map.sprites[i];
    if (s.removed || s.picNum !== T.CAMERA1 || s.yVel !== 0 || s.lotag !== v.hitag) continue;
    if ((vm.stat.get(i) ?? STAT.ACTOR) !== STAT.ACTOR) continue;
    s.yVel = 1;
    v.owner = i;
    v.yVel = 1;
    if (vm.sounds) { const n = vm.labels?.get('MONITOR_ACTIVE'); if (n !== undefined) vm.sounds.at(n, screen, v.x, v.y, v.z, cam, map); }
    pl.newOwner = i;
    return i;
  }
  return -1;
}

/**
 * CLEARCAMERAS, sector.c 3162: the use key while watching a camera.
 * newowner cleared, every CAMERA1 marked free again (yvel 0). The player
 * never left their spot (see useViewscreen), so nothing is put back.
 */
export function leaveViewscreen(vm, map, pl) {
  if (!(pl.newOwner >= 0)) return false;
  pl.newOwner = -1;
  for (const s of map.sprites) if (!s.removed && s.picNum === T.CAMERA1) s.yVel = 0;
  return true;
}

/**
 * processinput 2678 / displayrooms 3364, every tic while newowner is set:
 * the VIEW is the camera — its x, y, z, angle and sector, horiz 100 + its
 * shade — and the player does not move. Returns that view, or null (and
 * clears newowner) when the camera is gone.
 */
export function cameraViewTic(map, pl) {
  const s = map.sprites[pl.newOwner];
  if (!s || s.removed) { pl.newOwner = -1; return null; }
  return { x: s.x, y: s.y, z: s.z, ang: s.ang, sectNum: s.sectNum, horiz: 100 + s.shade };
}

/**
 * The cue — the use key, actors.c 3268: on the press tic (toggle_key_flag ==
 * 1), a resting ball within 1596 and within 64 of the view angle is struck
 * — 140, or 164 for pal 12 — along the player's angle, unless another ball
 * inside that cone is nearer. One ball per press. Returns the ball, or -1.
 */
export function cuePoolBall(vm, map, cam) {
  let best = -1, bestDist = 0x7fffffff;
  for (let i = 0; i < map.sprites.length; i++) {
    const s = map.sprites[i];
    if (s.removed || (s.picNum !== T.QUEBALL && s.picNum !== T.STRIPEBALL)) continue;
    if ((vm.stat.get(i) ?? STAT.ACTOR) !== STAT.ACTOR) continue;
    const x = playerDist(cam, s);
    if (x >= 1596) continue;
    const j = incAngle(cam.ang, getAngle(vm.radarang, s.x - cam.x, s.y - cam.y));
    if (!(j > -64 && j < 64)) continue;
    if (x < bestDist) { bestDist = x; best = i; }
  }
  if (best < 0) return -1;
  const s = map.sprites[best];
  if (s.xVel) return -1;
  s.xVel = s.pal === 12 ? 164 : 140;
  s.ang = cam.ang & 2047;
  vm.asleep.delete(best);
  return best;
}

/**
 * operatesprite() for NUKEBUTTON, sector.c 3095: the wall the player faces
 * must carry no overpicnum; pressed once (t[0] = 1), owned by the player;
 * the button's palette makes it a secret-level button, its lotag the secret
 * level. Returns whether it was pressed now.
 */
export function pressNukeButton(vm, map, i, wallOverPicNum = 0) {
  const s = map.sprites[i];
  if (wallOverPicNum !== 0) return false;
  const t = vm.fx.temp(i);
  if (t[0] !== 0) return false;
  t[0] = 1;
  s.owner = -2;
  vm.buttonPal = s.pal;
  vm.secretLevel = s.pal ? s.lotag : 0;
  return true;
}

/**
 * The player's sprite follows the player (player.c processinput): position,
 * feet at the eye plus PHEIGHT, angle, sector, health — and xvel is the
 * distance walked this tic (ksqrt of the step from bobposx/y), which is
 * what the APLAYER script's `ifp pwalking/prunning` read.
 */
export function syncPlayerSprite(vm, map, cam, pl, stepDist, eyeHeight = 40 << 8) {
  const i = vm.playerSprite;
  if (i === undefined || i < 0) return;
  const s = map.sprites[i];
  if (!s || s.removed) return;
  s.x = Math.round(cam.x); s.y = Math.round(cam.y); s.z = Math.round(cam.z) + eyeHeight;
  s.ang = cam.ang & 2047; s.sectNum = cam.sectNum;
  s.xVel = Math.round(stepDist);
  s.extra = pl.health;
  // actors.c 1305 (moveplayers): the sprite's shade eases halfway to its
  // sector's light each tic — the ceiling's under an open sky (ceilingstat
  // 1), else the floor's. displayweapon draws the weapon in it (gs).
  const sec = map.sectors[s.sectNum];
  if (sec) s.shade += (((sec.ceilingStat & 1) ? sec.ceilingShade : sec.floorShade) - s.shade) >> 1;
  // hittype[p->i].floorz/ceilingz: the player's getzrange, which the
  // script's ifgapzl (ducking under a low ceiling) reads.
  if (s.sectNum >= 0) {
    const zr = getZRange(map, s.x, s.y, s.z - (16 << 8), s.sectNum, 164, CLIPMASK0, { art: vm.art });
    vm.floorZ.set(i, zr.florZ); vm.ceilingZ.set(i, zr.ceilZ);
  }
}

/**
 * spriteglass(i, n), game.c 10370: n GLASSPIECES (three tiles in turn) at
 * the sprite, each at a random angle, up to 16<<8 higher, shade TRAND&15,
 * 36x36, speed 32 + TRAND&63, rising 512..2559, misc, in the sprite's pal
 * (a frozen one's shards are blue).
 */
export function spriteGlass(vm, map, i, n) {
  const sp = map.sprites[i];
  if (!sp || sp.sectNum < 0) return [];
  const made = [];
  for (let j = n; j > 0; j--) {
    const a = krand(vm.fx) & 2047;
    const z = sp.z - ((krand(vm.fx) & 16) << 8);
    const shade = krand(vm.fx) & 15;
    const xv = 32 + (krand(vm.fx) & 63);
    const zv = -512 - (krand(vm.fx) & 2047);
    const k = makeSprite(vm, map, sp.sectNum, sp.x, sp.y, z, 1031 + (j % 3), shade, 36, 36, a, xv, zv, i, STAT.MISC);
    map.sprites[k].pal = sp.pal;
    made.push(k);
  }
  return made;
}

/**
 * The APLAYER script's frozen branch takes its hits through ifhitbyweapon
 * (GAME.CON 3316); here the player's filed hit (vm.playerHit), taken and
 * cleared. The weapon's picnum, or -1 when nothing was filed.
 */
export function takeFrozenHit(vm) {
  const h = vm.playerHit;
  if (!h || !(h.picNum >= 0) || !(h.extra > 0 || h.filed)) return -1;
  const pic = h.picNum;
  h.extra = 0; h.picNum = -1; h.filed = false;
  return pic;
}

/** game.c 3459 LocateTheLocator: the LOCATORS sprite with this lotag (any sector). */
export function locateTheLocator(map, n) {
  for (let j = 0; j < map.sprites.length; j++) {
    const q = map.sprites[j];
    if (!q.removed && q.picNum === T.LOCATORS && q.lotag === n) return j;
  }
  return -1;
}

/**
 * moveactors() for REACTOR and REACTOR2, actors.c 4191. Standing: t[2]
 * counts 0..3 (REACTOR2's frame, animatesprites); a player within 4096 is
 * shocked one time in sixteen (SHORT_CIRCUIT, the pain line unless it is
 * already playing, 1 off, a red flash) and t[0]/t[3] run. Hit: 32 scraps,
 * and below 0 strength t[1] = 1 starts the meltdown — each tic the sprite
 * jumps to a random height in its sector, at t[1] 3 a hitradius of 4096
 * (impact_damage<<2) and every MASTERSWITCH of the same HITAG is armed, at
 * 4, 7, 10 and 15 one other sprite of the sector is deleted, 16 scraps a
 * tic, and at 20 t[4] = 1: the sector's SE 1 pivots are destroyed (lotag
 * and hitag 65535 — its rotators remove themselves), the reactors turn to
 * their BURNT tiles, the sparks vanish. SE 16 in the sector sees no
 * REACTOR left and dies.
 */
export function moveReactor(map, vm, i, cam, pl) {
  const s = map.sprites[i];
  const t = vm.fx.temp(i);
  const sec = map.sectors[s.sectNum];
  if (!sec) return;
  const inSector = () => map.sprites.map((o, j) => j).filter((j) => !map.sprites[j].removed && map.sprites[j].sectNum === s.sectNum).sort((a, b) => b - a);
  if (t[4] === 1) {
    for (const j of inSector()) {
      const o = map.sprites[j];
      if (o.picNum === 1 && o.lotag === 1) { o.lotag = 65535; o.hitag = 65535; }
      else if (o.picNum === REACTOR) o.picNum = REACTORBURNT;
      else if (o.picNum === REACTOR2) o.picNum = REACTOR2BURNT;
      else if (o.picNum === REACTORSPARK || o.picNum === REACTOR2SPARK) o.cstat = 32768;
    }
    return;
  }
  if (t[1] >= 20) { t[4] = 1; return; }
  t[2]++;
  if (t[2] === 4) t[2] = 0;
  const say = (name, at) => { if (vm.sounds && cam) { const n = vm.labels?.get(name); if (n !== undefined) { if (at < 0) vm.sounds.at(n, -2, cam.x, cam.y, cam.z, cam, map); else vm.sounds.at(n, i, s.x, s.y, s.z, cam, map); } } };
  if (cam && playerDist(cam, s) < 4096) {
    if ((krand(vm.fx) & 255) < 16) {
      const pain = vm.labels?.get('DUKE_LONGTERM_PAIN');
      if (!(vm.sounds && pain !== undefined && vm.sounds.isPlaying(pain))) say('DUKE_LONGTERM_PAIN', -1);
      say('SHORT_CIRCUIT', i);
      if (pl) { if (!pl.god) pl.health -= 1; pl.pal = { time: 32, r: 32, g: 0, b: 0 }; }   // god: moveplayers restores the extra
    }
    t[0] += 128;
    if (t[3] === 0) t[3] = 1;
  } else t[3] = 0;
  if (t[1]) {
    t[1]++;
    t[4] = s.z;
    s.z = sec.floorZ - (krand(vm.fx) % Math.max(1, sec.floorZ - sec.ceilingZ));
    if (t[1] === 3) {
      const d = (vm.impactDamage ?? 5) << 2;
      hitRadius(vm, map, i, 4096, d, d, d, d, cam);
      for (const j of vm.fx.masters ?? []) {
        const m = map.sprites[j];
        if (m && !m.removed && m.hitag === s.hitag && m.yVel === 0) m.yVel = 1;
      }
    } else if (t[1] === 4 || t[1] === 7 || t[1] === 10 || t[1] === 15) {
      // `deletesprite(j)` of the first other sprite in the sector's list —
      // Build's lists are head-inserted, so the newest first.
      const j = inSector().find((k) => k !== i);
      if (j !== undefined) { map.sprites[j].removed = true; vm.stat.delete(j); vm.asleep.delete(j); }
    }
    randomScrap(vm, map, i, 16);
    s.z = t[4];
    t[4] = 0;
  } else {
    const filed = vm.hitExtra.get(i) ?? -1;
    if (filed >= 0) {
      vm.hitExtra.set(i, -1);
      s.extra -= filed;
      randomScrap(vm, map, i, 32);
      if (s.extra < 0) t[1] = 1;
    }
  }
}

/**
 * moveweapons() for TONGUE, actors.c 2476: T1 = sin(T2)>>9 segments, T2
 * steps 32 to 2047 and the tongue is gone. It sits at its owner (34<<8 below
 * a player's sprite top), and each tic lays out T1 one-tic TONGUE segments
 * (8x8, pal 8, shade rising) and the INNERJAW at the tip — INNERJAW+1 while
 * T2 is between 512 and 1024 (the bite). No script or level of the 1.5 game
 * spawns one; kept for completeness, as Duke keeps it.
 */
export function moveTongue(map, vm, i) {
  const s = map.sprites[i];
  const t = vm.fx.temp(i);
  t[0] = bsin(t[1] & 2047) >> 9;
  t[1] += 32;
  if (t[1] > 2047) { s.removed = true; vm.stat.delete(i); return; }
  const o = map.sprites[s.owner];
  if (!o || (o.removed && !isBadguy(vm, o))) { s.removed = true; vm.stat.delete(i); return; }
  s.ang = o.ang; s.x = o.x; s.y = o.y;
  if (o.picNum === APLAYER) s.z = o.z - (34 << 8);
  const dz = Math.sign(s.zVel) * Math.abs(Math.trunc(s.zVel / 12));
  let k = 0;
  for (; k < t[0]; k++) {
    const q = makeSprite(vm, map, s.sectNum, s.x + ((k * bsin(s.ang + 512)) >> 9), s.y + ((k * bsin(s.ang)) >> 9), s.z + k * dz, TONGUE, -40 + (k << 1), 8, 8, 0, 0, 0, i, STAT.MISC);
    if (q >= 0) { map.sprites[q].cstat = 128; map.sprites[q].pal = 8; }
  }
  const q = makeSprite(vm, map, s.sectNum, s.x + ((k * bsin(s.ang + 512)) >> 9), s.y + ((k * bsin(s.ang)) >> 9), s.z + k * dz, INNERJAW, -40, 32, 32, 0, 0, 0, i, STAT.MISC);
  if (q >= 0) {
    map.sprites[q].cstat = 128;
    if (t[1] > 512 && t[1] < 1024) map.sprites[q].picNum = INNERJAW + 1;
  }
}

/**
 * movestandables() for TRASH, actors.c 2148: blown litter. At least speed
 * 1; while it moves freely (ssp) it falls, hops now and then (zvel -256 on a
 * coin), and speeds up to 48; stopped by anything, it is gone.
 */
export function moveTrash(map, vm, i) {
  const s = map.sprites[i];
  if (s.xVel === 0) s.xVel = 1;
  const r = moveSprite(vm, map, i, (s.xVel * bsin(s.ang + 512)) >> 14, (s.xVel * bsin(s.ang)) >> 14, s.zVel);
  if (r === 0) {
    makeItFall(vm, map, i);
    if (krand(vm.fx) & 1) s.zVel -= 256;
    if (Math.abs(s.xVel) < 48) s.xVel += krand(vm.fx) & 3;
  } else { s.removed = true; vm.stat.delete(i); }
}

/**
 * The player's spent cases, player.c: the pistol drops a SHELL on
 * kickback 2 (3778), the shotgun a SHOTGUNSHELL on 24 — turned round, one
 * ssp, turned back (3846) — and the chaingun a SHELL with every shot,
 * turned round, 32 faster, 3<<8 lower, one ssp (3870). spawn() places them
 * (game.c 4242).
 */
export function ejectShell(vm, map, kind) {
  const p = vm.playerSprite;
  if (p === undefined || p < 0) return -1;
  const k = spawnFrom(vm, map, p, kind === 'shotgun' ? SHOTGUNSHELL : SHELL);
  if (k < 0) return k;
  const q = map.sprites[k];
  const ssp = () => moveSprite(vm, map, k, (q.xVel * bsin(q.ang + 512)) >> 14, (q.xVel * bsin(q.ang)) >> 14, q.zVel);
  if (kind === 'shotgun') { q.ang = (q.ang + 1024) & 2047; ssp(); q.ang = (q.ang + 1024) & 2047; }
  else if (kind === 'chaingun') { q.ang = (q.ang + 1024) & 2047; q.xVel += 32; q.z += 3 << 8; ssp(); }
  return k;
}

/**
 * moveactors() for RECON, actors.c 3480 — the patrol vehicle, no script.
 * Its shade drifts to the sector's; it keeps 32<<8 under the ceiling and
 * 48<<8 above the floor. Hit: a scrap and RECO_PAIN, and once its strength
 * is gone t[0] = -1 — it sinks 1024 a tic, spins 96 a tic at speed 128,
 * spawns an EXPLOSION2 every fourth tic, and where it is blocked or
 * reaches the floor it blows (16 scrap, LASERTRIP_EXPLODE), the PIGCOP
 * bails out, and it is gone. Alive, t[0] is its state: 0/1 heading for
 * the next LOCATORS (hitag, then hitag+1 ...; none left: back to t[5] and
 * on), 2 matching the player's height then 3 shooting FIRELASER from a
 * standstill, 4/5 shooting on the move at tempang; after 78 tics or with
 * the player out of sight, back on patrol. Within 6144 and after four
 * seconds on patrol it picks 2 or 4. RECO_ROAM while nothing else plays.
 */
export function moveRecon(map, vm, i, cam) {
  const s = map.sprites[i];
  const t = vm.fx.temp(i);
  const sec = map.sectors[s.sectNum];
  if (!sec) return;
  const zr0 = getZRange(map, s.x, s.y, s.z - FOURSLEIGHT, s.sectNum, 127, CLIPMASK0, { art: vm.art });
  vm.floorZ.set(i, zr0.florZ); vm.ceilingZ.set(i, zr0.ceilZ);
  if (sec.ceilingStat & 1) s.shade += (sec.ceilingShade - s.shade) >> 1;
  else s.shade += (sec.floorShade - s.shade) >> 1;
  if (s.z < sec.ceilingZ + (32 << 8)) s.z = sec.ceilingZ + (32 << 8);
  const say = (n) => { if (vm.sounds) { const k = vm.labels?.get(n); if (k !== undefined) vm.sounds.at(k, i, s.x, s.y, s.z, cam, map); } };
  const filed = vm.hitExtra.get(i) ?? -1;
  if (filed >= 0) {
    vm.hitExtra.set(i, -1);
    s.extra -= filed;
    if (s.extra < 0 && t[0] !== -1) { t[0] = -1; s.extra = 0; }
    say('RECO_PAIN');
    randomScrap(vm, map, i, 1);
  }
  if (t[0] === -1) {
    s.z += 1024;
    t[2]++;
    if ((t[2] & 3) === 0) spawnFrom(vm, map, i, T.EXPLOSION2);
    const zr = getZRange(map, s.x, s.y, s.z - FOURSLEIGHT, s.sectNum, 127, CLIPMASK0, { art: vm.art });
    s.ang = (s.ang + 96) & 2047;
    s.xVel = 128;
    const j = moveSprite(vm, map, i, (s.xVel * bsin(s.ang + 512)) >> 14, (s.xVel * bsin(s.ang)) >> 14, s.zVel);
    if (j !== 0 || s.z > zr.florZ) {
      randomScrap(vm, map, i, 16);
      say('LASERTRIP_EXPLODE');
      const pig = spawnFrom(vm, map, i, T.PIGCOP);
      if (pig >= 0) vm.spawnActor(map.sprites[pig], pig, map, true);
      vm.kills++;
      s.removed = true; vm.stat.delete(i);
    }
    return;
  }
  const floorZ = vm.floorZ.get(i);
  if (s.z > floorZ - (48 << 8)) s.z = floorZ - (48 << 8);
  const px = cam.x, py = cam.y, pz = cam.z;
  const x = playerDist(cam, s);
  let j = s.owner;
  const toPlayer = () => getAngle(vm.radarang, px - s.x, py - s.y);
  const seesPlayer = () => canSee(map, s.x, s.y, s.z - (16 << 8), s.sectNum, px, py, pz, cam.sectNum);
  if (t[0] >= 4) {
    t[2]++;
    if ((t[2] & 15) === 0) {
      const a = s.ang; s.ang = t[4];
      say('RECO_ATTACK'); shootFrom(vm, map, i, T.FIRELASER);
      s.ang = a;
    }
    if (t[2] > 26 * 3 || !seesPlayer()) { t[0] = 0; t[2] = 0; }
    else t[4] = (t[4] + Math.trunc(incAngle(t[4], toPlayer()) / 3)) & 2047;
  } else if (t[0] === 2 || t[0] === 3) {
    t[3] = 0;
    if (s.xVel > 0) s.xVel -= 16; else s.xVel = 0;
    if (t[0] === 2) {
      const l = pz - s.z;
      if (Math.abs(l) < (48 << 8)) t[0] = 3;
      else s.z += Math.sign(pz - s.z) << 10;
    } else {
      t[2]++;
      if (t[2] > 26 * 3 || !seesPlayer()) { t[0] = 1; t[2] = 0; }
      else if ((t[2] & 15) === 0) { say('RECO_ATTACK'); shootFrom(vm, map, i, T.FIRELASER); }
    }
    s.ang = (s.ang + (incAngle(s.ang, toPlayer()) >> 2)) & 2047;
  }
  if (t[0] !== 2 && t[0] !== 3) {
    const loc = j >= 0 ? map.sprites[j] : null;
    let a;
    if (loc && ldist(loc.x - s.x, loc.y - s.y) <= 1524) { a = s.ang; s.xVel >>= 1; }
    else a = loc ? getAngle(vm.radarang, loc.x - s.x, loc.y - s.y) : s.ang;
    if (t[0] === 1 || t[0] === 4) {
      const l = loc ? findDistance3D(loc.x - s.x, loc.y - s.y, (loc.z - s.z) >> 4) : 0;
      if (l <= 1524) { t[0] = t[0] === 1 ? 0 : 5; }
      else if (s.xVel < 256) s.xVel += 32;
      if (t[0] < 2) t[2]++;
      if (x < 6144 && t[0] < 2 && t[2] > 26 * 4) { t[0] = 2 + (krand(vm.fx) & 2); t[2] = 0; t[4] = s.ang; }
    }
    if (t[0] === 0 || t[0] === 5) {
      t[0] = t[0] === 0 ? 1 : 4;
      j = s.owner = locateTheLocator(map, s.hitag);
      if (j === -1) {
        s.hitag = t[5];
        s.owner = j = locateTheLocator(map, t[5]);
        if (j === -1) { s.removed = true; vm.stat.delete(i); return; }
      } else s.hitag++;
    }
    t[3] = incAngle(s.ang, a);
    s.ang = (s.ang + (t[3] >> 3)) & 2047;
    const lz = j >= 0 ? map.sprites[j].z : s.z;
    if (s.z < lz) s.z += 1024; else s.z -= 1024;
  }
  if (vm.sounds && !vm.sounds.isPlaying?.(vm.labels?.get('RECO_ROAM'))) say('RECO_ROAM');
  moveSprite(vm, map, i, (s.xVel * bsin(s.ang + 512)) >> 14, (s.xVel * bsin(s.ang)) >> 14, s.zVel);
}

/**
 * movestandables() for VIEWSCREEN/VIEWSCREEN2, actors.c 2127. Size 0: gone.
 * The player within 2048 (findplayer) of a screen in use (yvel 1, set by
 * useViewscreen) makes it the camsprite — the one monitor whose picture the
 * page renders (animatecamsprite, sector.c 385). Out of reach, while some
 * monitor is live and this one's T1 is 1, the live one is let go: camsprite
 * -1, T1 0, and `loadtile` puts the screen's own picture back.
 */
export function moveViewscreen(map, vm, i, cam) {
  const s = map.sprites[i];
  if (s.xRepeat === 0) { s.removed = true; vm.stat.delete(i); return; }
  const t = vm.fx.temp(i);
  if (playerDist(cam, s) < 2048) {
    if (s.yVel === 1) vm.camSprite = i;
  } else if (vm.camSprite !== -1 && t[0] === 1) {
    vm.camSprite = -1;
    t[0] = 0;
    vm.restoreTile?.(s.picNum);
  }
}

/**
 * animatecamsprite(), sector.c 385, once a FRAME (displayrooms): the live
 * monitor's T1 counts 0..11; at 11 it is reset and, while the player
 * watches through a camera, the screen's owner becomes that camera —
 * otherwise, the player's sprite within 2048 (dist, 3D) of the screen, the
 * owner camera's view is drawn into the screen's tile (xyzmirror, `draw`).
 * `camsprite <= 0` returns: sprite 0 is never a monitor, as in Duke.
 */
export function animateCamSprite(map, vm, newOwner, draw) {
  const i = vm.camSprite;
  if (!(i > 0)) return false;
  const s = map.sprites[i];
  if (!s) return false;
  const t = vm.fx.temp(i);
  if (t[0] >= 11) {
    t[0] = 0;
    if (newOwner >= 0) { s.owner = newOwner; return false; }
    const p = map.sprites[vm.playerSprite];
    if (s.owner >= 0 && p && findDistance3D(p.x - s.x, p.y - s.y, (p.z - s.z) >> 4) < 2048) { draw(s.owner, s.picNum); return true; }
    return false;
  }
  t[0]++;
  return false;
}

/** movestandables(): the standables' tic. Trip bombs only, so far. */
export function moveStandables(map, vm, cam, pl) {
  for (let i = 0; i < map.sprites.length; i++) {
    const s = map.sprites[i];
    if (s.removed || vm.stat.get(i) !== STAT.STANDABLE) continue;
    if (s.picNum === TRASH) moveTrash(map, vm, i);
    else if (s.picNum === T.TRIPBOMB) moveTripbomb(map, vm, i, cam);
    else if (s.picNum === T.VIEWSCREEN || s.picNum === T.VIEWSCREEN2) moveViewscreen(map, vm, i, cam);
    else if (s.picNum >= 1222 && s.picNum <= 1225) moveCrane(map, vm, i, cam, pl);
    else if (s.picNum === 9) {
      // movefx 1331, RESPAWN: at extra 66 `spawn(i, hitag)` and gone; from
      // 54 (operaterespawns set it) it counts up a tic at a time.
      if (s.extra === 66) { spawnFrom(vm, map, i, s.hitag); s.removed = true; vm.stat.delete(i); }
      else if (s.extra > 66 - 13) s.extra++;
    }
    else if (AFLAMABLE.has(s.picNum)) moveFlammable(map, vm, i);
    else if (s.picNum === T.FIREEXT) moveFireExt(map, vm, i, cam);
    else if (s.picNum >= T.WATERFOUNTAIN && s.picNum <= T.WATERFOUNTAIN + 3) moveWaterFountain(map, vm, i, cam);
    else if (s.picNum === T.WATERDRIP) moveWaterDrip(map, vm, i, cam);
    else if (s.picNum === 5) moveMusicAndSfx(map, vm, i, cam);
    else if (s.picNum >= T.BOLT1 && s.picNum <= T.BOLT1 + 3) moveBolt(map, vm, i, cam);
    else if (s.picNum >= 546 && s.picNum <= 549) moveCrack(map, vm, i, cam);
    else if (s.picNum === T.SEENINE || s.picNum === T.SEENINEDEAD || s.picNum === T.SEENINEDEAD + 1 || s.picNum === T.OOZFILTER) {
      moveSeenine(map, vm, i, cam);
    }
  }
}

/**
 * The MUSICANDSFX sprite's own tic, actors.c 1342. Not the reverb kind
 * (lotag 1000..1999: not here). For a lotag under 999 in a sector of lotag
 * under 9 (unsigned: a secret's 32767 counts as big) that is not closed:
 * an ambient sound (soundm&2) starts when the player's sprite comes within
 * the hitag — dist(), 3D with z/16 — and t[0] notes it; past the hitag
 * again it is stopped (stopenvsound) and t[0] cleared. Whether it loops is
 * the sound's own business (soundm&1, or the VOC's repeat block): the bar's
 * BAR_MUSIC has neither, so it plays its seven seconds once per approach.
 * A soundm&16 sound (the random one-shots: lotag + rand%(hitag+1)) fires
 * while the player is in the sprite's sector, then waits 26*40..26*80 tics.
 */
export function moveMusicAndSfx(map, vm, i, cam) {
  const s = map.sprites[i];
  const t = vm.fx.temp(i);
  const sounds = vm.sounds;
  if (!sounds || !cam) return;
  const def = sounds.defs?.get(s.lotag);
  if (s.lotag >= 1000 && s.lotag < 2000) return;
  const sec = map.sectors[s.sectNum];
  if (!(s.lotag < 999) || !sec || (sec.lotag & 0xffff) >= 9 || sec.floorZ === sec.ceilingZ || !def) return;
  // dist(&sprite[ps[screenpeek].i], s): the player's SPRITE, which stands
  // at the player's feet — posz + PHEIGHT. Taken from the camera here.
  const px = cam.x, py = cam.y, pz = cam.z + (38 << 8);
  if (def.m & SM_MSFX) {
    const x = findDistance3D(px - s.x, py - s.y, (pz - s.z) >> 4);
    if (x < s.hitag && t[0] === 0) {
      sounds.at(s.lotag, i, s.x, s.y, s.z, cam, map);
      t[0] = 1;
    }
    if (x >= s.hitag && t[0] === 1) {
      t[0] = 0;
      sounds.stopEnv(s.lotag, i);
    }
  }
  if (def.m & 16) {
    if (t[4] > 0) t[4]--;
    else if (cam.sectNum === s.sectNum) {
      const j = s.lotag + (vm.fx.globalRandom % (s.hitag + 1));
      sounds.global(j, i);
      t[4] = 26 * 40 + (vm.fx.globalRandom % (26 * 40));
    }
  }
}
const SM_MSFX = 2;

/**
 * movefta 1060: what wakes into statnum 6 — in Duke the cans, barrels and
 * horses (RUBBERCAN 1062, EXPLODINGBARREL 1238, WOODENHORSE 904, HORSEONSIDE
 * 1026, CANWITHSOMETHING 1232/4580..4582, FIREBARREL 1240, FIREVASE 1390,
 * NUKEBARREL 1227..1229) and the TRIPBOMB. Only the TRIPBOMB is moved here:
 * the others run their CON from statnum 6 in Duke (movestandables'
 * `execute`), and in uDuke they still run it from the actor loop, which a
 * statnum change would silence. Named, not hidden.
 */
const WAKE_TO_STANDABLE = new Set([2566]);

/**
 * movestandables() for BOLT1..+3, actors.c 2198: the electric arc. Nothing
 * beyond 20480 of the player. t[3] remembers the sector's floor shade the
 * first time. A blackout (t[2]) counts down with both planes at shade 20.
 * Flickered out (size 0) it comes back to T1/T2; else one in eight tics
 * it blacks out for global_random&4 tics. Otherwise the frame advances
 * (BOLT1+4 wraps to BOLT1), the width is global_random&7 + 8 with an x-flip
 * on odd draws, BOLT1+1 over a HURTRAIL floor plays SHORT_CIRCUIT one in
 * eight, and the planes go shade 0 on odd frames and 20 on even.
 */
export function moveBolt(map, vm, i, cam) {
  const s = map.sprites[i];
  const t = vm.fx.temp(i);
  const sec = map.sectors[s.sectNum];
  if (!sec || !cam) return;
  if (playerDist(cam, s) > 20480) return;
  if (t[3] === 0) t[3] = sec.floorShade;
  for (;;) {
    if (t[2]) {
      t[2]--;
      sec.floorShade = 20;
      sec.ceilingShade = 20;
      return;
    }
    if ((s.xRepeat | s.yRepeat) === 0) {
      s.xRepeat = t[0];
      s.yRepeat = t[1];
    } else if ((krand(vm.fx) & 8) === 0) {
      t[0] = s.xRepeat;
      t[1] = s.yRepeat;
      t[2] = vm.fx.globalRandom & 4;
      s.xRepeat = s.yRepeat = 0;
      continue;
    }
    break;
  }
  s.picNum++;
  const l = vm.fx.globalRandom & 7;
  s.xRepeat = l + 8;
  if (l & 1) s.cstat ^= 2;
  if (s.picNum === T.BOLT1 + 1 && (krand(vm.fx) & 7) === 0 && sec.floorPicNum === T.HURTRAIL && vm.sounds) {
    const n = vm.labels?.get('SHORT_CIRCUIT');
    if (n !== undefined) vm.sounds.at(n, i, s.x, s.y, s.z, cam, map);
  }
  if (s.picNum === T.BOLT1 + 4) s.picNum = T.BOLT1;
  if (s.picNum & 1) { sec.floorShade = 0; sec.ceilingShade = 0; }
  else { sec.floorShade = 20; sec.ceilingShade = 20; }
}

/**
 * movestandables() for WATERDRIP, actors.c 1868. Waiting (t[1] > 0): count
 * down, and at zero become visible again. Falling: makeitfall, ssp, xvel
 * bleeds by 2; landed (zvel 0): invisible, SOMETHING_DRIPPING unless pal 2
 * or a hitag, and — its owner being itself for a map drip — back to its
 * home z (t[0]) with a wait of 48..79 tics. A spawned drip (owner not a
 * drip) dies on landing instead.
 */
export function moveWaterDrip(map, vm, i, cam) {
  const s = map.sprites[i];
  const t = vm.fx.temp(i);
  if (t[1]) {
    t[1]--;
    if (t[1] === 0) s.cstat &= 32767;
    return;
  }
  makeItFall(vm, map, i);
  moveSprite(vm, map, i, (s.xVel * bsin(s.ang + 512)) >> 14, (s.xVel * bsin(s.ang)) >> 14, s.zVel);
  if (s.xVel > 0) s.xVel -= 2;
  if (s.zVel === 0) {
    s.cstat |= 32768;
    if (s.pal !== 2 && s.hitag === 0 && vm.sounds) {
      const n = vm.labels?.get('SOMETHING_DRIPPING');
      if (n !== undefined) vm.sounds.at(n, i, s.x, s.y, s.z, cam, map);
    }
    const own = map.sprites[s.owner];
    if (!own || own.picNum !== T.WATERDRIP) { s.removed = true; vm.stat.delete(i); return; }
    s.z = t[0];
    t[1] = 48 + (krand(vm.fx) & 31);
  }
}

/**
 * guts(), actors.c 772: N jibs of `gtype` off sprite i. See OP.guts.
 */
export function guts(vm, map, i, gtype, n) {
  const s = map.sprites[i];
  const bg = isBadguy(vm, s);
  const size = (bg && s.xRepeat < 16) ? 8 : 32;
  let gutz = s.z - (8 << 8);
  const floorz = getZsOfSlope(map, s.sectNum, s.x, s.y).floorZ;
  if (gutz > floorz - (8 << 8)) gutz = floorz - (8 << 8);
  if (s.picNum === T.COMMANDER_T) gutz -= 24 << 8;
  const pal = (bg && s.pal === 6) ? 6 : 0;
  const made = [];
  for (let j = 0; j < n; j++) {
    const a = krand(vm.fx) & 2047;
    const k = makeSprite(vm, map, s.sectNum, s.x + (krand(vm.fx) & 255) - 128, s.y + (krand(vm.fx) & 255) - 128,
      gutz - (krand(vm.fx) & 8191), gtype, -32, size, size, a, 48 + (krand(vm.fx) & 31), -512 - (krand(vm.fx) & 2047),
      vm.playerSprite ?? -1, STAT.MISC);
    const g = map.sprites[k];
    if (gtype === T.JIBS2) { g.xRepeat >>= 2; g.yRepeat >>= 2; }
    if (pal === 6) g.pal = 6;
    made.push(k);
  }
  return made;
}

/**
 * lotsofmoney(), actors.c 740: N MONEY off sprite i. See OP.money.
 */
export function lotsOfMoney(vm, map, i, n, tile = T.MONEY) {
  const s = map.sprites[i];
  const made = [];
  for (let k = n; k > 0; k--) {
    const j = makeSprite(vm, map, s.sectNum, s.x, s.y, s.z - (krand(vm.fx) % (47 << 8)), tile, -32, 8, 8, krand(vm.fx) & 2047, 0, 0, 0, STAT.MISC);
    map.sprites[j].cstat = krand(vm.fx) & 12;
    made.push(j);
  }
  return made;
}

/**
 * ifsquished(), actors.c 406: the actor's sector has closed on it —
 * floorz - ceilingz under 12<<8 (32<<8 for a frozen one, and only while the
 * sector's state bit is off), never in a swinging-door sector (23). A
 * squished badguy stops; quote 10 for the player; a frozen one is filed a
 * SHOTSPARK1 hit of 1 instead and answers 0. The player with clipping off
 * is never squished.
 */
export function ifSquished(vm, map, i) {
  const s = map.sprites[i];
  if (s.picNum === APLAYER && vm.noClip) return 0;
  const sc = map.sectors[s.sectNum];
  if (!sc) return 0;
  const floorceildist = sc.floorZ - sc.ceilingZ;
  let squishme = false;
  if ((sc.lotag & LOTAG_MASK) !== 23) {
    if (s.pal === 1) squishme = floorceildist < (32 << 8) && (sc.lotag & 32768) === 0;
    else squishme = floorceildist < (12 << 8);
  }
  if (!squishme) return 0;
  if (vm.pstate) { vm.pstate.quote = 10; vm.pstate.quoteTime = 120; }
  if (isBadguy(vm, s)) s.xVel = 0;
  if (s.pal === 1) {
    vm.hitPic.set(i, T.SHOTSPARK1);
    vm.hitExtra.set(i, 1);
    return 0;
  }
  return 1;
}

/**
 * dodge(), gamedef.c 1666: a bullet (a statnum-4 sprite in the actor's
 * sector, not its own) that is ahead of the actor and flying toward it,
 * passing within 64 units of its line, makes the actor turn 512 or 1536.
 * Returns 1 when it dodged. `ifbulletnear`, and move's dodgebullet flag.
 */
export function dodge(vm, map, i) {
  const s = map.sprites[i];
  const mx = s.x, my = s.y;
  const mxvect = bsin(s.ang + 512), myvect = bsin(s.ang);
  for (const [w, stat] of vm.stat) {
    if (stat !== STAT.WEAPON) continue;
    const b = map.sprites[w];
    if (!b || b.removed || b.owner === w || b.sectNum !== s.sectNum) continue;
    const bx = b.x - mx, by = b.y - my;
    const bxvect = bsin(b.ang + 512), byvect = bsin(b.ang);
    if (mxvect * bx + myvect * by >= 0 && bxvect * bx + byvect * by < 0) {
      const d = bxvect * by - byvect * bx;
      if (Math.abs(d) < 65536 * 64) {
        s.ang = (s.ang - (512 + (krand(vm.fx) & 1024))) & 2047;
        return 1;
      }
    }
  }
  return 0;
}

/**
 * moveexplosions() for BLOODPOOL/PUKE, actors.c 4460. First tic: gone on a
 * sloped floor. Every tic: makeitfall, sat on its floor; for 32 tics it
 * grows by rand&3 a tic up to 32 (64 for a TIRE's pool). A player within
 * 844 on a pool over 6 wide: a GREEN pool (pal 0, not puke) costs a boot
 * unit, or with none a point of health and a red flash, one tic in 16 —
 * and leaves footprints (not kept here: uDuke draws none) while t[1]
 * marks them in the pool; when the pool is full-grown it shrinks by 6.
 */
export function moveBloodPool(map, vm, i, cam) {
  const s = map.sprites[i];
  const t = vm.fx.temp(i);
  if (t[0] === 0) {
    t[0] = 1;
    if (map.sectors[s.sectNum]?.floorStat & 2) { s.removed = true; vm.stat.delete(i); return; }
  }
  makeItFall(vm, map, i);
  const x = cam ? playerDist(cam, s) : 0x7fffffff;
  s.z = (vm.floorZ.get(i) ?? s.z) - FOURSLEIGHT;
  if (t[2] < 32) {
    t[2]++;
    const cap = vm.spawnedBy.get(i) === T.TIRE ? 64 : 32;
    if (s.xRepeat < cap && s.yRepeat < cap) {
      s.xRepeat += krand(vm.fx) & 3;
      s.yRepeat += krand(vm.fx) & 3;
    }
  }
  if (x < 844 && s.xRepeat > 6 && s.yRepeat > 6) {
    if (s.pal === 0 && (krand(vm.fx) & 255) < 16 && s.picNum !== T.PUKE && vm.pstate) {
      const pl = vm.pstate;
      if (pl.inventory?.boots > 0) pl.inventory.boots--;
      else {
        if (vm.sounds) { const n = vm.labels?.get('DUKE_LONGTERM_PAIN'); if (n !== undefined) vm.sounds.at(n, -2, cam.x, cam.y, cam.z, cam, map); }
        if (!pl.god) pl.health = Math.max(0, (pl.health ?? 0) - 1);
        pl.pal = { time: 32, r: 16, g: 0, b: 0 };
      }
    }
    if (t[1] === 1) return;
    t[1] = 1;
    // actors.c 4766: the player leaves the pool's colour behind — 10 prints
    // off a TIRE's pool, 3 off any other.
    if (vm.pstate) {
      const pl = vm.pstate;
      pl.footprintCount = vm.poolParent?.get(i) === T.TIRE ? 10 : 3;
      pl.footprintPal = s.pal;
      pl.footprintShade = s.shade;
    }
    if (t[2] === 32) { s.xRepeat -= 6; s.yRepeat -= 6; }
  } else t[1] = 0;
}

/**
 * player.c 2920/2939 — Duke's footprints. Wading (a lotag-1 sector, on the
 * ground, not shrunk) loads six wet prints, pal 8 over FLOORSLIME, else 0.
 * On land, on the ground and on a flat floor, each tic with prints left:
 * unless a print already lies within 384 in the sector, one print is
 * spent, and in a sector of lotag 0 and hitag 0 one of the four FOOTPRINTS
 * tiles is spawned off the player sprite in the stored pal and shade.
 */
export function playerFootprints(vm, map, cam, pl, wading, onGround) {
  const sec = map.sectors[cam.sectNum];
  if (!sec) return;
  if (wading) {
    if (onGround && !pl.shrunk) {
      pl.footprintCount = 6;
      pl.footprintPal = sec.floorPicNum === 200 ? 8 : 0;
      pl.footprintShade = 0;
    }
    return;
  }
  if (!(pl.footprintCount > 0) || !onGround || (sec.floorStat & 2)) return;
  for (let j = 0; j < map.sprites.length; j++) {
    const q = map.sprites[j];
    if (q.removed || q.sectNum !== cam.sectNum) continue;
    if (q.picNum !== 550 && (q.picNum < 672 || q.picNum > 674)) continue;
    if (Math.abs(q.x - cam.x) < 384 && Math.abs(q.y - cam.y) < 384) return;
  }
  pl.footprintCount--;
  if ((sec.lotag & LOTAG_MASK) === 0 && sec.hitag === 0 && vm.playerSprite >= 0) {
    const pick = [550, 672, 673, 674][krand(vm.fx) & 3];
    const j = spawnFrom(vm, map, vm.playerSprite, pick);
    if (j >= 0) { map.sprites[j].pal = pl.footprintPal ?? 0; map.sprites[j].shade = pl.footprintShade ?? 0; }
  }
}

/**
 * shoot(i, BLOODSPLAT1..4), player.c 356 — an actor's blood on the wall
 * behind it. From the actor's muzzle point, the angle turned round with a
 * jitter of ±63, the vertical ±1023, a hitscan; a wall within 1024 that is
 * either an outer wall of a plain sector or a step of over 16<<8 down into
 * a plain sector, not a BIGFORCE, not masked (cstat 16), with no SE 13
 * beyond it and no hitag on it or its twin, gets the splat: spawned off the
 * actor, xvel -12, at the wall's angle + 512, on the hit point, a random
 * x-flip, stepped once by ssp. An OOZFILTER's or a NEWBEAST's is pal 6.
 * Returns the splat, or -1.
 */
export function shootBloodSplat(vm, map, i, atwith) {
  const s = map.sprites[i];
  const tile = vm.art?.get(s.picNum);
  let sa = s.ang;
  let sx = s.x, sy = s.y;
  let sz = s.z - ((s.yRepeat * (tile?.height ?? 0)) << 1) + (4 << 8);
  if (s.picNum !== ROTATEGUN) {
    sz -= 7 << 8;
    if (isBadguy(vm, s) && s.picNum !== COMMANDER) {
      sx += bsin(sa + 1024 + 96) >> 7;
      sy += bsin(sa + 512 + 96) >> 7;
    }
  }
  sa += 1024 + 64 - (krand(vm.fx) & 127);
  const zvel = 1024 - (krand(vm.fx) & 2047);
  const h = hitScan(map, sx, sy, sz, s.sectNum, bsin(sa + 512), bsin(sa), zvel << 6, CLIPMASK1, vm.art);
  if (h.wall < 0 || findDistance2D(sx - h.x, sy - h.y) >= 1024) return -1;
  const w = map.walls[h.wall];
  if (w.overPicNum === T.BIGFORCE) return -1;
  const hs = h.sect >= 0 ? map.sectors[h.sect] : null;
  const ns = w.nextSector >= 0 ? map.sectors[w.nextSector] : null;
  const plainHit = hs && (hs.lotag & LOTAG_MASK) === 0;
  const ok = (ns && plainHit && (ns.lotag & LOTAG_MASK) === 0 && (hs.floorZ - ns.floorZ) > (16 << 8))
    || (w.nextSector === -1 && plainHit);
  if (!ok || (w.cstat & 16)) return -1;
  if (w.nextSector >= 0) {
    for (const o of map.sprites) if (!o.removed && o.sectNum === w.nextSector && o.picNum === 1 && o.lotag === 13) return -1;
  }
  if (w.nextWall >= 0 && map.walls[w.nextWall].hitag !== 0) return -1;
  if (w.hitag !== 0) return -1;
  const k = spawnFrom(vm, map, i, atwith);
  if (k < 0) return -1;
  const sp = map.sprites[k];
  const w2 = map.walls[w.point2];
  sp.xVel = -12;
  sp.ang = (getAngle(vm.radarang, w.x - w2.x, w.y - w2.y) + 512) & 2047;
  sp.x = h.x; sp.y = h.y; sp.z = h.z;
  sp.cstat |= krand(vm.fx) & 4;
  moveSprite(vm, map, k, (sp.xVel * bsin(sp.ang + 512)) >> 14, (sp.xVel * bsin(sp.ang)) >> 14, 0);
  sp.sectNum = updateSector(map, sp.x, sp.y, sp.sectNum);
  if (s.picNum === T.OOZFILTER || s.picNum === T.NEWBEAST) sp.pal = 6;
  return k;
}

/**
 * getglobalz(), gamedef.c 206, the plain part: getzrange under the sprite
 * (walldist 127, 4 for a projectile) into its floorz/ceilingz. The pushes
 * off a badguy or the player standing under it are not here.
 */
export function getGlobalZ(vm, map, i) {
  const s = map.sprites[i];
  if (s.sectNum < 0 || !map.sectors[s.sectNum]) return;
  const zr = getZRange(map, s.x, s.y, s.z - FOURSLEIGHT, s.sectNum, (vm.stat.get(i) === STAT.WEAPON) ? 4 : 127, CLIPMASK0, { art: vm.art });
  vm.floorZ.set(i, zr.florZ);
  vm.ceilingZ.set(i, zr.ceilZ);
}

/**
 * moveactors() for OOZ/OOZ2, actors.c 4290: every tic the stream is fitted
 * to the gap between ceiling and floor at its spot — yrepeat the gap>>9
 * (at most 255), xrepeat 25 minus half of that clamped to 8..48, its z on
 * the floor.
 */
export function moveOoz(map, vm, i) {
  const s = map.sprites[i];
  getGlobalZ(vm, map, i);
  let j = ((vm.floorZ.get(i) ?? s.z) - (vm.ceilingZ.get(i) ?? s.z)) >> 9;
  if (j > 255) j = 255;
  let x = 25 - (j >> 1);
  if (x < 8) x = 8; else if (x > 48) x = 48;
  s.yRepeat = j;
  s.xRepeat = x;
  s.z = vm.floorZ.get(i) ?? s.z;
}

/**
 * movestandables() for SEENINE / OOZFILTER, actors.c 1972. A hit (or a
 * MASTERSWITCH's shade -31) puts every one of the same hitag on shade -32:
 * the chain. At -32 the sprite's lotag — the map's delay — counts down by 3
 * a tic, then -33; from -33 T3 counts three tics a stage: SEENINE →
 * SEENINEDEAD → +1 → DETONATE (an OOZFILTER detonates on the first). The
 * detonation shakes the screen 16 tics, sets off the effectors of the same
 * hitag — SE13 (t[2] = 1: walls and ceilings blow open), SE8 (t[4]), SE18
 * and SE21 (t[0]) — and, when it was hit or timed out (lotag -99), an
 * EXPLOSION2 with hitradius over seenineblastradius and PIPEBOMB_EXPLODE.
 */
export function moveSeenine(map, vm, i, cam) {
  const s = map.sprites[i];
  const t = vm.fx.temp(i);
  const detonate = () => {
    vm.fx.earthquakeTime = 16;
    for (let j = 0; j < map.sprites.length; j++) {
      const e = map.sprites[j];
      if (e.removed || e.picNum !== 1 || e.hitag !== s.hitag) continue;    // SECTOREFFECTOR
      const et = vm.fx.temp(j);
      if (e.lotag === 13) { if (et[2] === 0) et[2] = 1; }
      else if (e.lotag === 8) et[4] = 1;
      else if (e.lotag === 18) { if (et[0] === 0) et[0] = 1; }
      else if (e.lotag === 21) et[0] = 1;
    }
    s.z -= 32 << 8;
    if ((t[3] === 1 && s.xRepeat) || s.lotag === -99) {
      const x = s.extra;
      spawnFrom(vm, map, i, T.EXPLOSION2);
      randomScrap(vm, map, i, 8);
      hitRadius(vm, map, i, vm.seenineBlastRadius ?? 2048, x >> 2, x - (x >> 1), x - (x >> 2), x, cam);
      if (vm.sounds) { const n = vm.labels?.get('PIPEBOMB_EXPLODE'); if (n !== undefined) vm.sounds.at(n, i, s.x, s.y, s.z, cam, map); }
    }
    s.removed = true; vm.stat.delete(i);
  };
  if (s.shade !== -32 && s.shade !== -33) {
    let j = false;
    if (s.xRepeat) {
      const filed = vm.hitExtra.get(i) ?? -1;
      if (filed >= 0) { vm.hitExtra.set(i, -1); s.extra -= filed; j = true; }
    }
    if (j || s.shade === -31) {
      if (j) s.lotag = 0;
      t[3] = 1;
      for (const o of map.sprites) {
        if (!o.removed && o.hitag === s.hitag && (o.picNum === T.SEENINE || o.picNum === T.OOZFILTER)) o.shade = -32;
      }
    }
    return;
  }
  if (s.shade === -32) {
    if (s.lotag > 0) { s.lotag -= 3; if (s.lotag <= 0) s.lotag = -99; }
    else s.shade = -33;
    return;
  }
  // shade -33: the stages, then the detonation
  if (s.xRepeat > 0) {
    t[2]++;
    if (t[2] === 3) {
      if (s.picNum === T.OOZFILTER) { t[2] = 0; detonate(); return; }
      if (s.picNum !== T.SEENINEDEAD + 1) {
        t[2] = 0;
        if (s.picNum === T.SEENINEDEAD) s.picNum++;
        else if (s.picNum === T.SEENINE) s.picNum = T.SEENINEDEAD;
      } else { detonate(); return; }
    }
    return;
  }
  detonate();
}

/**
 * The trip bomb's cycle, player.c: counts 1..3 hold the player's height;
 * on 3 the bomb is placed; at 16 the count resets and the weapon lowers
 * (weapon_pos -9: checkavailweapon picks the next).
 */
export function tripbombTic(st, fire, placeFn, canPlaceFn) {
  st.kickback = st.kickback || 0;
  if (st.kickback === 0) {
    if (fire && st.ammoAmount[8] > 0 && canPlaceFn()) st.kickback = 1;
    return false;
  }
  let placed = false;
  if (st.kickback < 4 && st.kickback === 3) { placeFn(); placed = true; }
  if (st.kickback === 16) {
    st.kickback = 0;
    st.weaponPos = -9;
    if (st.ammoAmount[8] <= 0) { st.lastWeapon = 8; st.currWeapon = 1; }
    else { st.lastWeapon = 8; }
  } else st.kickback++;
  return placed;
}

/**
 * shoot(i, KNEE), player.c: from 6<<8 below the eye, 15 angle units to the
 * right, a hitscan; a wall or sprite within 1024 takes a KNEE (invisible,
 * strength 10 + TRAND&7) — a sprite through checkhitsprite.
 */
export function shootKnee(vm, map, cam, horiz) {
  const sa = cam.ang + 15;
  const sz = cam.z + (4 << 8) + (6 << 8);
  const zvel = (100 - horiz) << 5;
  const h = hitScan(map, cam.x, cam.y, sz, cam.sectNum, bsin(sa + 512), bsin(sa), zvel << 6, CLIPMASK1, vm.art);
  if (h.sect < 0) return -1;
  if (Math.abs(cam.x - h.x) + Math.abs(cam.y - h.y) >= 1024) return -1;
  if (h.wall < 0 && h.sprite < 0) return -1;
  const k = makeSprite(vm, map, h.sect, h.x, h.y, h.z, T.KNEE, -15, 0, 0, sa, 32, 0, -2, STAT.WEAPON);
  const knee = map.sprites[k];
  const hdr = vm.actorScr.get(T.KNEE);
  knee.extra = (hdr !== undefined ? vm.script[hdr] : 10) + (krand(vm.fx) & 7);
  if (h.sprite >= 0) hitSprite(vm, map, h.sprite, k);
  knee.removed = true; vm.stat.delete(k);
  vm.lastShot = { sprite: h.sprite, wall: h.wall, sect: h.sect, aimed: -1, x: h.x, y: h.y, z: h.z };
  return h.sprite >= 0 ? h.sprite : (h.wall >= 0 ? -3 : -1);
}

/**
 * The knee's cycle, player.c: the press arms 1; on 7 the kick; at 14 the
 * count resets — or, still held, re-arms at 1 + (TRAND&3).
 */
export function kneeTic(st, fire, kickFn, rnd = () => 0) {
  st.kickback = st.kickback || 0;
  if (st.kickback === 0) {
    if (fire) st.kickback = 1;
    return false;
  }
  st.kickback++;
  let kicked = false;
  if (st.kickback === 7) { kickFn(); kicked = true; }
  else if (st.kickback === 14) st.kickback = fire ? 1 + (rnd() & 3) : 0;
  return kicked;
}


/** A small deterministic-enough random for the knee's re-arm, off the player state. */
function krandLite(st) { st.rnd = ((st.rnd || 1) * 1103515245 + 12345) & 0x7fffffff; return st.rnd >> 16; }


// ---------------------------------------------------------------------------
// Shrinker (slot 6), Expander (slot 11) and Freezer (slot 9): projectiles and
// a hitscan whose EFFECT lives in the target's script, not in a damage.
// ---------------------------------------------------------------------------

/**
 * shoot(i, SHRINKER), player.c 1082: a SHRINKSPARK, 28x28, at 768, from
 * 2<<8 below the eye, aimed at a target's mid-height with `*768/ldist`
 * (unaimed: horiz*98). cstat 128, clipdist 32, a weapon.
 */
export function shootShrinker(vm, map, cam, horiz) {
  const sx = cam.x, sy = cam.y, sz = cam.z + (4 << 8);
  let sa = cam.ang, zvel;
  const j = aimAt(vm, map, cam, horiz, 48);
  if (j >= 0) {
    const tg = map.sprites[j];
    const th = vm.art?.get(tg.picNum)?.height ?? 0;
    const dal = (tg.xRepeat * th) << 1;
    zvel = Math.trunc(((tg.z - sz - dal - (4 << 8)) * 768) / (ldist(tg.x - sx, tg.y - sy) || 1));
    sa = getAngle(vm.radarang, tg.x - sx, tg.y - sy);
  } else zvel = (100 - horiz) * 98;
  const k = makeSprite(vm, map, cam.sectNum, sx + (bsin(512 + sa + 512) >> 12), sy + (bsin(sa + 512) >> 12), sz + (2 << 8),
    T.SHRINKSPARK, -16, 28, 28, sa, 768, zvel, -2, STAT.WEAPON);
  const r = map.sprites[k];
  r.cstat = 128; r.clipDist = 32;
  return k;
}

/**
 * shoot(i, SHRINKER) from a sprite, player.c 1082: an actor (statnum not 3)
 * aims the vertical at the player — (oposz - sz)*512 / ldist; an effector
 * (statnum 3, E1L4's wall shrinker, an SE 36) fires level. The spark:
 * SHRINKSPARK, shade -16, 28x28, at the shooter's angle, xvel 768, from the
 * muzzle point plus 2<<8, owned by the shooter, cstat 128, clipdist 32.
 */
export function shootShrinkerFrom(vm, map, i) {
  const s = map.sprites[i];
  const tile = vm.art?.get(s.picNum);
  let sx = s.x, sy = s.y;
  let sz = s.z - ((s.yRepeat * (tile?.height ?? 0)) << 1) + (4 << 8);
  const sa = s.ang;
  if (s.picNum !== ROTATEGUN) {
    sz -= 7 << 8;
    if (isBadguy(vm, s) && s.picNum !== COMMANDER) { sx += bsin(sa + 1024 + 96) >> 7; sy += bsin(sa + 512 + 96) >> 7; }
  }
  if (s.extra >= 0) s.shade = -96;
  let zvel = 0;
  if (s.picNum !== 1) {   // statnum 3 is the effectors: SECTOREFFECTOR sprites
    const p = vm.player;
    if (p) { const l = ldist(p.x - s.x, p.y - s.y) || 1; zvel = Math.trunc(((p.z - sz) * 512) / l); }
  }
  const k = makeSprite(vm, map, s.sectNum, sx + (bsin(512 + sa + 512) >> 12), sy + (bsin(sa + 512) >> 12), sz + (2 << 8),
    T.SHRINKSPARK, -16, 28, 28, sa, 768, zvel, i, STAT.WEAPON);
  const r = map.sprites[k];
  r.cstat = 128; r.clipDist = 32;
  return k;
}

/**
 * shoot(i, FREEZEBLAST): the RPG case with the freezer's twist — after the
 * 14x14 rocket at 644 it is halved to 7x7, yvel holds numfreezebounces, and
 * the vertical is lifted by 2<<4. Strength from the header + TRAND&7.
 */
export function shootFreeze(vm, map, cam, horiz) {
  const k = shootRpg(vm, map, -2, cam, horiz, T.FREEZEBLAST);
  const r = map.sprites[k];
  r.yVel = vm.numFreezeBounces ?? 1;
  r.xRepeat >>= 1; r.yRepeat >>= 1;
  r.zVel -= 2 << 4;
  return k;
}

/**
 * shoot(i, GROWSPARK), player.c 991: a hitscan like the pistol's, aimed
 * (5<<8 up the target) or scattered; a GROWSPARK (1x1, pal 2, cstat |130)
 * at the hit, and a sprite hit is filed through checkhitsprite with the
 * expander's strength — the script does the growing.
 */
export function shootGrow(vm, map, cam, horiz) {
  const sx = cam.x, sy = cam.y;
  let sz = cam.z + (4 << 8), sa = cam.ang, zvel;
  const j = aimAt(vm, map, cam, horiz, 48);
  if (j >= 0) {
    const tg = map.sprites[j];
    const th = vm.art?.get(tg.picNum)?.height ?? 0;
    let dal = ((tg.xRepeat * th) << 1) + (5 << 8);
    if (tg.picNum === ROTATEGUN || (tg.picNum >= 2370 && tg.picNum <= 2377)) dal -= 8 << 8;
    zvel = Math.trunc(((tg.z - sz - dal) << 8) / (ldist(tg.x - sx, tg.y - sy) || 1));
    sa = getAngle(vm.radarang, tg.x - sx, tg.y - sy);
  } else {
    sa += 16 - (krand(vm.fx) & 31);
    zvel = ((100 - horiz) << 5) + 128 - (krand(vm.fx) & 255);
  }
  sz -= 2 << 8;
  const h = hitScan(map, sx, sy, sz, cam.sectNum, bsin(sa + 512), bsin(sa), zvel << 6, CLIPMASK1, vm.art);
  if (h.sect < 0) return -1;
  const k = makeSprite(vm, map, h.sect, h.x, h.y, h.z, T.GROWSPARK, -16, 28, 28, sa, 0, 0, -2, STAT.ACTOR);
  const g = map.sprites[k];
  g.pal = 2; g.cstat |= 130; g.xRepeat = 1; g.yRepeat = 1;
  const hdr = vm.actorScr.get(T.GROWSPARK);
  g.extra = hdr !== undefined ? vm.script[hdr] : 15;
  if (h.sprite >= 0) hitSprite(vm, map, h.sprite, k);
  g.removed = true; vm.stat.delete(k);
  vm.lastShot = { sprite: h.sprite, wall: h.wall, sect: h.sect, aimed: j, x: h.x, y: h.y, z: h.z };
  return h.sprite;
}

/**
 * bounce(i), actors.c: reflect the projectile's velocity off the floor or
 * ceiling plane it is nearer to — the plane's normal from the sector's
 * first wall and its heinum — and rewrite ang/xvel/zvel from the result.
 */
export function bounceSprite(map, vm, i) {
  const s = map.sprites[i];
  const sec = map.sectors[s.sectNum];
  if (!sec) return;
  let xvect = (s.xVel * bsin(s.ang + 512)) >> 10;
  let yvect = (s.xVel * bsin(s.ang)) >> 10;
  let zvect = s.zVel;
  const w = map.walls[sec.wallPtr], w2 = map.walls[w.point2];
  const daang = getAngle(vm.radarang, w2.x - w.x, w2.y - w.y);
  const fz = vm.floorZ.get(i) ?? sec.floorZ, cz = vm.ceilingZ.get(i) ?? sec.ceilingZ;
  const k = s.z < ((fz + cz) >> 1) ? (sec.ceilingHeinum ?? 0) : (sec.floorHeinum ?? 0);
  const dax = (k * bsin(daang)) >> 14, day = (k * bsin(daang + 1536)) >> 14, daz = 4096;
  const dot = xvect * dax + yvect * day + zvect * daz;
  const l = dax * dax + day * day + daz * daz;
  if ((Math.abs(dot) >> 14) < l) {
    const kk = Math.trunc((dot * 131072) / l);
    xvect -= (dax * kk) >> 16;
    yvect -= (day * kk) >> 16;
    zvect -= (daz * kk) >> 16;
  }
  s.zVel = zvect;
  s.xVel = Math.trunc(Math.sqrt((xvect * xvect + yvect * yvect) / 256));
  s.ang = getAngle(vm.radarang, xvect, yvect);
}

/** shrinker: the press (with ammo) arms 1; past 10 the shot and a reset. */
export function shrinkerTic(st, fire, shootFn, soundFn) {
  st.kickback = st.kickback || 0;
  if (st.kickback === 0) {
    if (fire && st.ammoAmount[6] > 0) { st.kickback = 1; soundFn('SHRINKER_FIRE'); }
    return false;
  }
  if (st.kickback > 10) {
    st.kickback = 0;
    st.ammoAmount[6]--;
    shootFn(T.SHRINKER);
    return true;
  }
  st.kickback++;
  return false;
}

/** expander (GROW_WEAPON): the press arms 1; past 3 the shot and a reset. */
export function growTic(st, fire, shootFn, soundFn) {
  st.kickback = st.kickback || 0;
  if (st.kickback === 0) {
    if (fire && st.ammoAmount[11] > 0) { st.kickback = 1; soundFn('EXPANDERSHOOT'); }
    return false;
  }
  if (st.kickback > 3) {
    st.kickback = 0;
    st.ammoAmount[11]--;
    shootFn(T.GROWSPARK);
    return true;
  }
  st.kickback++;
  return false;
}

/**
 * freezer: counts 1..3, the shot on 3; from 4 on, held, it re-arms at 1
 * with CAT_FIRE (a stream while the button is down), released it rests.
 */
export function freezeTic(st, fire, shootFn, soundFn) {
  st.kickback = st.kickback || 0;
  if (st.kickback === 0) {
    if (fire && st.ammoAmount[9] > 0) { st.kickback = 1; soundFn('CAT_FIRE'); }
    return false;
  }
  let fired = false;
  if (st.kickback < 4) {
    st.kickback++;
    if (st.kickback === 3) {
      st.ammoAmount[9]--;
      shootFn(T.FREEZEBLAST);
      fired = true;
    }
  } else if (fire && st.ammoAmount[9] > 0) { st.kickback = 1; soundFn('CAT_FIRE'); }
  else st.kickback = 0;
  return fired;
}

/**
 * The stomp (knee_incs, player.c) and the quick kick (quick_kick), one tic:
 * knee_incs counts from 1; at 15 the actor marked by pstomp (actorsqu) is
 * squashed — SQUISHED, a kill, gone — and at 25 the count rests. quick_kick
 * counts down from 14 and fires the knee on 8. Returns 'squish' or 'kick'
 * for the caller's shooting and sounds, else null.
 */
export function stompTic(vm, map, pl, cam, kickFn) {
  let out = null;
  if (pl.kneeIncs > 0) {
    pl.kneeIncs++;
    if (pl.kneeIncs === 15) {
      const a = pl.actorSqu ?? -1;
      const t = map.sprites[a];
      if (t && !t.removed) {
        if (vm.sounds) { const n = vm.labels?.get('SQUISHED'); if (n !== undefined) vm.sounds.at(n, a, t.x, t.y, t.z, cam, map); }
        t.removed = true; vm.stat.delete(a);
        vm.kills++;
        out = 'squish';
      }
      pl.actorSqu = -1;
    }
    if (pl.kneeIncs > 25) { pl.kneeIncs = 0; pl.actorSqu = -1; }
  }
  if (pl.quickKick > 0) {
    pl.quickKick--;
    if (pl.quickKick === 8) { kickFn(); out = out ?? 'kick'; }
  }
  return out;
}
