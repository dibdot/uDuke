// Cache tripwire: see con.js.
export const MODULE_STAGE = 'stage12.196';

// uDuke - saving and loading a game.
//
// Duke's savegame (game.c saveplayer) writes the whole engine state: every
// sector, wall and sprite, hittype[], the player struct, the animations, the
// effector lists, the random seed and the counters. This does the same for
// uDuke's objects: the map's three tables, the ConVM's bookkeeping, the
// effectors, the animations, the player state and the camera — everything
// that changes while the level runs. What does NOT change (the compiled
// script, the art, the palettes, the sound definitions, the radar table) is
// rebuilt by buildLevel() and left out, so a save is data only and a load is
// "build the level fresh, then put the saved state back into it".
//
// Containers are restored IN PLACE — a Map is cleared and refilled, an array
// emptied and repushed — because the running code holds references to them
// (vm.map is level.map, fx.t is the temp store the actors read). Replacing
// the container would leave those references pointing at the old one.

const TYPED = { Int8Array, Uint8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array };

/** Fields of the ConVM that are references to constant or rebuilt things. */
const VM_SKIP = new Set(['script', 'actorScr', 'actorType', 'labels', 'fx', 'sounds', 'operateSector', 'radarang',
  'art', 'map', 'player', 'pstate', 'pinput', 'sp', 't', 'breakableTiles', 'isSwitchTile', 'hitBreakable', 'hitSwitch',
  'aflammable', 'defs', 'projLog']);

function encode(v) {
  if (v === null || v === undefined) return v;
  if (typeof v === 'function') return undefined;
  if (typeof v !== 'object') return v;
  if (v instanceof Map) return { __map: [...v].map(([k, x]) => [k, encode(x)]) };
  if (v instanceof Set) return { __set: [...v].map(encode) };
  if (ArrayBuffer.isView(v)) return { __ta: v.constructor.name, data: Array.from(v) };
  if (Array.isArray(v)) return v.map(encode);
  const o = {};
  for (const k of Object.keys(v)) {
    const e = encode(v[k]);
    if (e !== undefined) o[k] = e;
  }
  return o;
}

function decode(v) {
  if (v === null || v === undefined || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(decode);
  if (v.__map) return new Map(v.__map.map(([k, x]) => [k, decode(x)]));
  if (v.__set) return new Set(v.__set.map(decode));
  if (v.__ta) { const C = TYPED[v.__ta] || Int32Array; return C.from(v.data); }
  const o = {};
  for (const k of Object.keys(v)) o[k] = decode(v[k]);
  return o;
}

/** Put a decoded value into obj[key], reusing the container that is there. */
function assign(obj, key, value) {
  const cur = obj[key];
  if (cur instanceof Map && value instanceof Map) { cur.clear(); for (const [k, x] of value) cur.set(k, x); return; }
  if (cur instanceof Set && value instanceof Set) { cur.clear(); for (const x of value) cur.add(x); return; }
  if (ArrayBuffer.isView(cur) && ArrayBuffer.isView(value) && cur.length === value.length) { cur.set(value); return; }
  if (Array.isArray(cur) && Array.isArray(value)) { cur.length = 0; for (const x of value) cur.push(x); return; }
  if (cur && typeof cur === 'object' && !Array.isArray(cur) && !(cur instanceof Map) && !(cur instanceof Set)
      && !ArrayBuffer.isView(cur) && value && typeof value === 'object' && !Array.isArray(value)
      && !(value instanceof Map) && !(value instanceof Set) && !ArrayBuffer.isView(value)) {
    for (const k of Object.keys(value)) assign(cur, k, value[k]);
    return;
  }
  if (writable(obj, key)) obj[key] = value;
}

function snapshotObject(obj, skip = new Set()) {
  const o = {};
  for (const k of Object.keys(obj)) {
    if (skip.has(k) || !writable(obj, k)) continue;
    const e = encode(obj[k]);
    if (e !== undefined) o[k] = e;
  }
  return o;
}

function writable(obj, key) {
  // A getter-only property (player.maxAmmo is one) is read from a snapshot
  // but cannot be assigned; it derives from what is.
  for (let o = obj; o; o = Object.getPrototypeOf(o)) {
    const d = Object.getOwnPropertyDescriptor(o, key);
    if (d) return !!(d.writable || d.set);
  }
  return true;
}

function restoreObject(obj, snap, skip = new Set()) {
  for (const k of Object.keys(snap)) {
    if (skip.has(k) || !writable(obj, k)) continue;
    assign(obj, k, decode(snap[k]));
  }
}

/**
 * The saved game: everything a running level has changed, plus what the
 * page needs to put the player back (cheats, the name of the level).
 */
export function snapshotLevel(level, page = {}, base = null) {
  const { map, vm, effectors, anims, player, cam } = level;
  // Sectors and walls are stored as the difference from a freshly built
  // level (`base`, when the caller has one): a wall that never moved and
  // never changed its picture is an empty record. Sprites are stored whole
  // — they are what changes.
  const diff = (obj, ref) => {
    if (!ref) return encode(obj);
    const o = {};
    for (const k of Object.keys(obj)) {
      const e = encode(obj[k]);
      if (e === undefined) continue;
      if (JSON.stringify(e) !== JSON.stringify(encode(ref[k]))) o[k] = e;
    }
    return o;
  };
  return {
    format: 'uduke-save-1',
    name: level.name,
    savedAt: new Date().toISOString(),
    page,
    delta: !!base,
    map: {
      sectors: map.sectors.map((s, i) => diff(s, base?.map.sectors[i])),
      walls: map.walls.map((w, i) => diff(w, base?.map.walls[i])),
      sprites: map.sprites.map((sp, i) => diff(sp, base?.map.sprites[i])),
    },
    vm: vm ? snapshotObject(vm, VM_SKIP) : null,
    effectors: snapshotObject(effectors),
    anims: anims ? snapshotObject(anims) : null,
    player: encode(player),
    cam: encode(cam),
    zr: level.zr ? encode(level.zr) : null,
  };
}

/** Put a snapshot into a freshly built level of the same name. */
export function restoreLevel(level, snap) {
  if (!snap || snap.format !== 'uduke-save-1') throw new Error('not a uDuke save');
  if (snap.name !== level.name) throw new Error(`save is for ${snap.name}, not ${level.name}`);
  const { map } = level;
  if (snap.map.sectors.length !== map.sectors.length || snap.map.walls.length !== map.walls.length) {
    throw new Error('save does not match the map');
  }
  for (let i = 0; i < map.sectors.length; i++) restoreObject(map.sectors[i], snap.map.sectors[i]);
  for (let i = 0; i < map.walls.length; i++) restoreObject(map.walls[i], snap.map.walls[i]);
  if (snap.delta) {
    // The fresh level's own sprite objects, patched; sprites the game
    // spawned beyond the map's count come whole.
    const n = map.sprites.length;
    for (let i = 0; i < snap.map.sprites.length; i++) {
      if (i < n) restoreObject(map.sprites[i], snap.map.sprites[i]);
      else map.sprites.push(decode(snap.map.sprites[i]));
    }
    map.sprites.length = snap.map.sprites.length;
  } else {
    const sprites = snap.map.sprites.map(decode);
    map.sprites.length = 0;
    for (const s of sprites) map.sprites.push(s);
  }
  if (level.vm && snap.vm) restoreObject(level.vm, snap.vm, VM_SKIP);
  if (snap.effectors) restoreObject(level.effectors, snap.effectors);
  if (level.anims && snap.anims) restoreObject(level.anims, snap.anims);
  restoreObject(level.player, snap.player);
  restoreObject(level.cam, snap.cam);
  if (snap.zr) level.zr = decode(snap.zr);
  return level;
}

export function saveToStorage(slot, snap, storage = globalThis.localStorage) {
  if (!storage) throw new Error('no storage');
  storage.setItem(`uduke-save-${slot}`, JSON.stringify(snap));
}

export function loadFromStorage(slot, storage = globalThis.localStorage) {
  if (!storage) return null;
  const text = storage.getItem(`uduke-save-${slot}`);
  return text ? JSON.parse(text) : null;
}

export function listSaves(storage = globalThis.localStorage, slots = 3) {
  const out = [];
  for (let s = 1; s <= slots; s++) {
    const text = storage?.getItem(`uduke-save-${s}`);
    if (!text) { out.push(null); continue; }
    try { const j = JSON.parse(text); out.push({ name: j.name, savedAt: j.savedAt, bytes: text.length, page: j.page }); }
    catch { out.push(null); }
  }
  return out;
}
