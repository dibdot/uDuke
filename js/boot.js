// Cache tripwire: every module carries the stage it shipped with, and boot.js
// refuses to run a mix. A browser that re-fetched one file and kept another
// from its cache showed up as 'HEALTH undefined' — a field the stale
// player.js did not have. That is the third stale-cache report; this makes
// the fourth say which file.
import { STAGE } from './version.js';
export const MODULE_STAGE = 'stage12.196';

// uDuke - loading a GRP and standing a level up.
//
// Two copies of this would be the "stale diagnostic" problem in its worst form:
// the tool used to MEASURE the engine loading it differently from the thing
// being measured, with every finding then arguably about the loader.
//

import { readGrp, grpEntry, grpByExtension } from './grp.js';
import { parsePalette, parseLookup, parseTables, applyBrightness, buildLut,
  buildShadeLuts, buildPalShadeLuts } from './palette.js';
import { ArtSet } from './art.js';
import { readMap } from './map.js';
import { prepareMap, buildSurfaceColours } from './render.js';
import { setupLevel, setupSprites, Animations } from './sector.js';
import { ConCompiler, ConVM, canSee, spawnFrom, shootFrom, moveSprite, isBadguy } from './con.js';
import { SoundSystem, parseVoc } from './sound.js';
import { shotHitWall, blastWalls, hitBreakable, lotsOfGlass, BREAKABLE_TILES } from './hitwall.js';
import { AFLAMABLE, spawnHead, spawnDecor } from './con.js';
import { isSwitchTile } from './switch.js';
import { setClipArt } from './clip.js';
import { setupEffectors } from './effector.js';
import { newPlayerState, EYE_HEIGHT } from './player.js';

/**
 * Everything a GRP gives that outlives a single level.
 *
 * @param {ArrayBuffer} buffer the whole GRP
 */
/**
 * The sound model with the GRP's VOCs behind it, decoded lazily and cached.
 * A level gets one with its VM; the start-up screens get one without (they
 * only play global sounds).
 */
export function buildSounds(assets, vm = null) {
  const sounds = new SoundSystem(assets.con.defs.sounds, vm);
  sounds.decoded = new Map();
  sounds.missing = new Set();
  sounds.silent = new Set();
  sounds.decode = (num) => {
    if (sounds.decoded.has(num)) return sounds.decoded.get(num);
    const def = assets.con.defs.sounds.get(num);
    const key = def && assets.grp.order.find((e) => e.toUpperCase() === def.file.toUpperCase());
    let out = null;
    if (key) {
      try { out = parseVoc(grpEntry(assets.grp, key)); } catch { out = null; }
    }
    // A file that parses but holds no samples is SILENT, not missing:
    // SNAKRM.VOC in the shipped GRP is 43 bytes and plays nothing in
    // Duke either. Only an absent or unparseable file is missing.
    if (!out) sounds.missing.add(num);
    else if (!out.samples.length) sounds.silent.add(num);
    sounds.decoded.set(num, out);
    return out;
  };
  return sounds;
}

export function loadAssets(buffer, { brightness = 0 } = {}) {
  const grp = readGrp(buffer);
  const palette = parsePalette(grpEntry(grp, 'PALETTE.DAT'));

  // TABLES.DAT's britable: Duke's brightness slider, a 6-bit ramp laid over
  // the whole palette by setbrightness(). subgrp has been copying this file
  // into every extract since the beginning and nobody read it. Level 0 is the
  // identity, so the default changes nothing — but a running Duke is usually
  // NOT at 0, and every colour comparison against one is off until this
  // matches. TABLES.DAT is optional here for the same reason LOOKUP.DAT is.
  let britable = null, radarang = null;
  if (grp.order.includes('TABLES.DAT')) {
    const tables = parseTables(grpEntry(grp, 'TABLES.DAT'));
    britable = tables.britable;
    radarang = tables.radarang;
  }

  // The game logic. GAME.CON pulls the other two in with `include`; an extract
  // without CON loads too, and its actors simply have no script.
  let con = null;
  if (grp.order.includes('GAME.CON')) {
    con = new ConCompiler((n) => {
      const key = grp.order.find((e) => e.toUpperCase() === n.toUpperCase());
      return key ? grpEntry(grp, key) : null;
    });
    con.compile(grpEntry(grp, 'GAME.CON'), 'GAME.CON');
  }
  const rgb = applyBrightness(palette.raw6, britable, brightness);
  // tiles.c loadpics(): `do { open tilesNNN.art; if found, load it,
  // numtilefiles++ } while (k != numtilefiles)` — TILES000, 001, 002 ... by
  // NUMBER, stopping at the first gap. Any other .ART in the archive is
  // never opened. The first version took every .ART in archive order, and a
  // later file in the full Atomic GRP that redeclares tile 2510 (the
  // devastator) as 0x0 overwrote the real one: 'no pixels (0x0)' on screen
  // while the same tile from a level extract drew.
  const artNames = pickArtFiles(grp.order);
  const artFiles = artNames.map((n) => grpEntry(grp, n));
  const art = new ArtSet(artFiles);
  // What was taken and what was left, with each file's declared range —
  // the one line that settles "which file redeclares tile N".
  const artRanges = artFiles.map((bytes, k) => {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return `${artNames[k]} ${v.getInt32(8, true)}..${v.getInt32(12, true)}`;
  });
  const artSkipped = grp.order.filter((n) => /\.ART$/i.test(n) && !artNames.includes(n));
  if (typeof window !== 'undefined' && console.info) {
    console.info(`uDuke ART: loaded ${artRanges.join(', ')}` + (artSkipped.length ? `; not opened (loadpics would not): ${artSkipped.join(', ')}` : ''));
  }

  // LOOKUP.DAT: the alternate palettes the `pal` field on a wall, sector or
  // sprite selects. parseLookup has been in palette.js for a long time and was
  // called by nobody — the file was read by subgrp and by nothing else, so
  // every pal in every level was silently drawn as pal 0. Duke exits with an
  // error when the file is missing; here it is optional, because a subgrp cut
  // for one investigation may not carry it and a missing tint should not stop
  // a map from loading.
  const palLuts = new Map();
  let lookups = null;
  if (grp.entries?.has?.('LOOKUP.DAT') || grp.order.includes('LOOKUP.DAT')) {
    lookups = parseLookup(grpEntry(grp, 'LOOKUP.DAT'));
    for (const [pal, remap] of lookups.lookups) {
      palLuts.set(pal, buildPalShadeLuts(palette.rgb, palette.shades,
        palette.numShades, remap));
    }
  }

  // The whole-screen tints. LOOKUP.DAT ends with five 768-byte palettes, and
  // premap.c reads them in this order: waterpal, slimepal, titlepal, drealms,
  // endingpal. Duke applies one by swapping the HARDWARE palette —
  // `setbrightness(..., &p->palette[0])` — so the colour indices are unchanged
  // and only their RGB values differ. Here that means a second complete set of
  // shade tables, base and per-pal: 26 of them, 8 ms and 832 KB, built once.
  //
  // Only waterpal is built. slimepal is selected by the CEILING picnum being
  // one of FLOORSLIME..+2 rather than by a lotag, which is a tile question and
  // a different piece of work; titlepal, drealms and endingpal belong to menus
  // and cutscenes that do not exist here.
  // A whole-palette swap, built from one of LOOKUP.DAT's base palettes the
  // way setpal() uses them: the same colour indices, different RGB.
  const swapFrom = (base) => {
    // The palette is stored expanded already, so the ramp is applied by
    // folding it back to 6 bits first — the same input setbrightness gets.
    const raw = Uint8Array.from(base, (v) => Math.round(v * 63 / 255));
    const rgb = applyBrightness(raw, britable, brightness);
    // `waterpal[765] = waterpal[766] = waterpal[767] = 0;` — premap.c forces
    // the last colour black (and slimepal's too). It is the transparent index
    // everywhere in uDuke, so this changes nothing that is drawn; it is here
    // because leaving it out would be a quiet divergence from the file Duke
    // actually uses.
    rgb[765] = rgb[766] = rgb[767] = 0;
    const pals = new Map();
    for (const [pal, remap] of lookups.lookups) {
      pals.set(pal, buildPalShadeLuts(rgb, palette.shades, palette.numShades, remap));
    }
    return {
      shadeLuts: buildShadeLuts(rgb, palette.shades, palette.numShades),
      palLuts: pals,
      // Kept so the zeroing above is observable: through the shade tables it is
      // not, because buildShadeLuts writes index 255 as transparent whatever
      // the palette says.
      rgb,
    };
  };
  const water = lookups && lookups.basePalettes.length > 0 ? swapFrom(lookups.basePalettes[0]) : null;
  // slimepal, the second base palette: the night vision's (setpal, player.c 36).
  const slime = lookups && lookups.basePalettes.length > 1 ? swapFrom(lookups.basePalettes[1]) : null;

  return {
    grp,
    palette,
    britable,
    radarang,
    con,
    brightness,
    rgb,
    lookups,
    palLuts,
    water,
    slime,
    lut: buildLut(rgb, palette.shades, 0),
    shadeLuts: buildShadeLuts(rgb, palette.shades, palette.numShades),
    numShades: palette.numShades,
    art,
    artFiles: artNames,
    artRanges,
    artSkipped,
    // The registered-only weapons are blank tiles in a shareware GRP: the
    // files are the same, the pictures are zeroed. Say so once, and let the
    // pages leave those weapons out rather than draw nothing.
    shareware: shareWareTiles(art),
    maps: grpByExtension(grp, '.MAP'),
    bytes: buffer.byteLength,
  };
}

/**
 * Read a map and bring it to the state a level starts in.
 *
 * The ORDER matters and is the reason this is one function rather than three
 * calls at each site: setupLevel fills in `sector.extra`, setupEffectors reads
 * it for every effector's speed, and both run before anything looks at the
 * geometry — a drop floor has already moved by the time the first frame is
 * drawn. Doing it in the wrong order leaves every door and effector at the
 * default speed and nothing complains.
 *
 * The camera comes back too, because where a level starts is part of standing
 * it up: `map.start.z` and `floorZ - EYE_HEIGHT` are not always the same and
 * the lower of the two is the one you can stand in.
 */
/** Recompute the renderer's per-map tables after the map's geometry was replaced (a load). */
export function refreshPrep(level) {
  level.res.prep = prepareMap(level.map);
}

export function buildLevel(assets, name, opts = {}) {
  // The clip passes (getZRange, clipMove) read tile sizes from this art.
  setClipArt(assets.art);
  const map = readMap(grpEntry(assets.grp, name));
  setupLevel(map);
  // The sprite half of spawn(). Before the effectors, as game.c has it, and
  // before anything draws: a hidden SEENINE that is drawn for one frame is
  // still a bug.
  setupSprites(map);
  const effectors = setupEffectors(map);
  effectors.radarang = assets.radarang;   // getangle for the subway's steering

  // The interpreter, and spawn()'s seeding of every scripted sprite from its
  // header — after setupSprites and setupEffectors, so the SEENINE rule and the
  // effector lists have already had their say about which sprites exist.
  const vm = assets.con ? new ConVM(assets.con, effectors) : null;
  if (vm) {
    if (opts.skill) vm.skill = opts.skill;   // 1..4, Let's Rock is 2
    vm.radarang = assets.radarang;
    vm.art = assets.art;
    vm.rpgBlastRadius = assets.con.defs.gamestartup?.[8] ?? 1780;   // RPGBLASTRADIUS
    vm.pipebombBlastRadius = assets.con.defs.gamestartup?.[9] ?? 2500;   // PIPEBOMBRADIUS
    vm.bouncemineBlastRadius = assets.con.defs.gamestartup?.[13] ?? 2500;
    vm.morterBlastRadius = assets.con.defs.gamestartup?.[12] ?? 2500;       // MORTERBLASTRADIUS  // BOUNCEMINERADIUS (gamedef.c 1446: rpg, pipebomb, shrinker, tripbomb, morter, bouncemine, seenine)
    vm.tripbombBlastRadius = assets.con.defs.gamestartup?.[11] ?? 3880;   // TRIPBOMBRADIUS
    vm.shrinkerBlastRadius = assets.con.defs.gamestartup?.[10] ?? 680;    // SHRINKERBLASTRADIUS
    vm.numFreezeBounces = assets.con.defs.gamestartup?.[26] ?? 3;         // numfreezebounces
    vm.seenineBlastRadius = assets.con.defs.gamestartup?.[14] ?? 2048;    // SEENINEBLASTRADIUS
    vm.impactDamage = assets.con.defs.gamestartup?.[1] ?? 5;              // impact_damage
    vm.camerasHitable = !!(assets.con.defs.gamestartup?.[25] ?? 0);      // camerashitable (CAMERASDESTRUCTABLE)
    // checkhitwall and the bullet-hole rules, for every hitscan that ends on a wall.
    vm.isSwitchTile = isSwitchTile;                 // spawn(): a tagged wall switch is not a faller
    vm.shotHitWall = shotHitWall;
    vm.blastWalls = blastWalls;
    vm.hitBreakable = hitBreakable;
    // lotsofglass, for the things in con.js that shatter (a pool ball).
    vm.lotsOfGlass = lotsOfGlass;
    vm.breakableTiles = BREAKABLE_TILES;
    // The sound model, fed by the CON's definesounds. Decoding is lazy and
    // cached: a VOC is parsed the first time its number plays. An extract
    // without VOCs gives a system that decodes nothing and plays nothing,
    // and says so in `missing`.
    const sounds = buildSounds(assets, vm);
    vm.sounds = sounds;
    // The effectors' reach into the actor side (effector.js cannot import
    // con.js: con.js imports it). Here rather than in the page, so the probes
    // and tests run the same effectors the game does. The page adds the ones
    // that need the player (quote, shortCircuit, sounds from the player).
    effectors.canSee = canSee;
    // Build's statnum of a sprite, for the effectors that filter on it (the
    // conveyor): a dozing actor is 2, a filed stat is itself, an unfiled
    // scripted actor 1, anything else 0.
    // actors.c 5892's list for SE 11: awake badguys (statnum 1) with strength.
    effectors.liveBadguys = () => {
      const out = [];
      for (let j = 0; j < map.sprites.length; j++) {
        const q = map.sprites[j];
        if (q.removed || !(q.extra > 0) || vm.asleep.has(j)) continue;
        const st = vm.stat.get(j);
        if (st !== undefined && st !== 1) continue;
        if (isBadguy(vm, q)) out.push(j);
      }
      return out;
    };
    effectors.statOf = (j) => {
      if (vm.asleep.has(j)) return 2;
      const st = vm.stat.get(j);
      if (st !== undefined) return st;
      return vm.hasScript(map.sprites[j]?.picNum) ? 1 : 0;
    };
    effectors.spawn = (i, tile) => spawnFrom(vm, map, i, tile);
    effectors.shoot = (i, tile) => shootFrom(vm, map, i, tile);
    // spawn(i, tile); xvel; ssp(k, CLIPMASK0) — SE 35's smoke puffs.
    const bsin = (a) => Math.round(Math.sin(((a & 2047) * Math.PI) / 1024) * 16384);
    // ssp(k, CLIPMASK0): one movesprite step along the sprite's own angle and speeds.
    effectors.ssp = (k) => {
      const q = map.sprites[k];
      if (q) moveSprite(vm, map, k, (q.xVel * bsin(q.ang + 512)) >> 14, (q.xVel * bsin(q.ang)) >> 14, q.zVel);
    };
    effectors.spawnMoving = (i, tile, xvel) => {
      const k = spawnFrom(vm, map, i, tile);
      if (k < 0) return k;
      map.sprites[k].xVel = xvel;
      effectors.ssp(k);
      return k;
    };
    // IFHIT on an effector sprite (SE 5): ifhitbyweapon — the filed hit, consumed.
    effectors.ifHit = (i) => {
      const e = vm.hitExtra.get(i) ?? -1;
      if (e < 0) return -1;
      vm.hitExtra.set(i, -1);
      return vm.hitPic.get(i) ?? 0;
    };
    // TestCallBack (sounds.c 624): an ambient MUSICANDSFX whose sound ended
    // gets t[0] = 0, so moveMusicAndSfx restarts it — the loop that is not
    // in the sound's flags.
    sounds.onEnd = (num, sprite) => {
      const sp = map.sprites[sprite];
      if (!sp || sp.removed || sp.picNum !== 5 || sp.lotag >= 999) return;
      const sec = map.sectors[sp.sectNum];
      if (!sec || sec.lotag >= 3) return;
      vm.fx.temp(sprite)[0] = 0;
    };
    map.sprites.forEach((spr, i) => {
      // Scripted actors, and the few unscripted tiles spawn() sets up in C
      // (the SEENINE cracks and OOZFILTERs are standables with no CON actor).
      if (!spr.removed && (vm.hasScript(spr.picNum) || spr.picNum === 1247 || spr.picNum === 1079 || spr.picNum === 916 || spr.picNum === 1960 || spr.picNum === 901 || spr.picNum === 902 || (spr.picNum >= 621 && spr.picNum <= 625) || spr.picNum === 554 || spr.picNum === 502 || spr.picNum === 499 || spr.picNum === 660 || spr.picNum === 5 || (spr.picNum >= 634 && spr.picNum <= 637) || (spr.picNum >= 4525 && spr.picNum <= 4528) || spr.picNum === 925 || spr.picNum === 926 || (spr.picNum >= 1007 && spr.picNum <= 1009) || spr.picNum === 1046 || (spr.picNum >= 142 && spr.picNum <= 145) || (spr.picNum >= 546 && spr.picNum <= 549) || spr.picNum === 9 || spr.picNum === 1267 || spr.picNum === 940 || spr.picNum === 1222 || spr.picNum === 1232 || (spr.picNum >= 4580 && spr.picNum <= 4582) || (spr.picNum >= 2370 && spr.picNum <= 2377) || spr.picNum === 2491 || spr.picNum === 1346 || spr.picNum === 568 || spr.picNum === 577 || spr.picNum === 1088 || spr.picNum === 578 || spr.picNum === 1272 || BREAKABLE_TILES.has(spr.picNum) || AFLAMABLE.has(spr.picNum) || ((spr.cstat & 48) && (spr.hitag !== 0 || ((spr.cstat & 16) && (isSwitchTile(spr.picNum) || spr.picNum === 1155 || spr.picNum === 1156)))))) vm.spawnActor(spr, i, map);
      // Everything else still meets spawn()'s head (game.c 3671): a blocking
      // sprite is hitscan-solid too (`if (CS&1) CS |= 256`).
      // ...and then their own case of spawn(), where they have one.
      else if (!spr.removed && !spawnHead(spr)) spawnDecor(spr);
    });
  }

  const floorZ = map.sectors[map.start.sectNum]?.floorZ ?? 0;
  return {
    name,
    map,
    effectors,
    vm,
    sounds: vm?.sounds ?? null,
    radarang: assets.radarang,
    anims: new Animations(),
    player: newPlayerState(assets.con?.defs.gamestartup?.[2] ?? 100,
      // max_ammo_amount[1..11] are gamestartup words 15..24 (pistol first;
      // GROW at 24 only in a 1.4/1.5 file). Slot 0 (knee) and 10 have none.
      assets.con ? [0, ...assets.con.defs.gamestartup.slice(15, 24), 0, assets.con.defs.gamestartup[24] ?? 0] : 200),
    cam: {
      x: map.start.x,
      y: map.start.y,
      z: Math.min(map.start.z, floorZ - EYE_HEIGHT),
      ang: map.start.ang,
      horiz: 100,
      sectNum: map.start.sectNum,
    },
    res: {
      map,
      prep: prepareMap(map),
      colours: buildSurfaceColours(map, assets.art, assets.palette),
      art: assets.art,
      shadeLuts: assets.shadeLuts,
      // The alternate palettes. Forgetting this line is invisible: every draw
      // site falls back to pal 0 and the picture is merely wrong, never broken.
      palLuts: assets.palLuts,
      // Spread over `res` while under water; see setpal in player.c.
      water: assets.water,
      slime: assets.slime,
      numShades: assets.numShades,
    },
  };
}

/**
 * Refuse a mix of module versions. Every module exports MODULE_STAGE; a page
 * hands in the ones it imported and gets back the names of any that do not
 * match version.js — a stale browser cache, always, and the fix is a hard
 * reload. The check is here rather than in the pages so that both pages ask
 * the same question.
 */
export function staleModules(modules) {
  const bad = [];
  for (const [name, m] of Object.entries(modules)) {
    if (m.MODULE_STAGE !== STAGE) bad.push(`${name} (${m.MODULE_STAGE ?? 'no stage'})`);
  }
  return bad;
}


/**
 * The ART files Build would load, in Build's order: TILES000.ART, then 001,
 * 002 ... until a number is missing. Case-insensitive on the name; any other
 * .ART entry (a stray tiles file out of sequence, a differently named one)
 * is left alone, as loadpics leaves it.
 */
export function pickArtFiles(order) {
  const byNum = new Map();
  for (const n of order) {
    const m = /^TILES(\d{3})\.ART$/i.exec(n);
    if (m) byNum.set(Number(m[1]), n);
  }
  const out = [];
  for (let k = 0; byNum.has(k); k++) out.push(byNum.get(k));
  return out;
}


/**
 * The weapon tiles a shareware GRP ships blank (0x0): DEVISTATOR 2510,
 * TRIPBOMB 2566, FREEZE 2548 and the shrinker 2556. Returns the weapon
 * slots that have no picture in this data — empty for a full GRP.
 */
export function shareWareTiles(art) {
  const check = [[7, 2510], [8, 2566], [9, 2548], [6, 2556]];
  const missing = [];
  for (const [slot, tile] of check) {
    const t = art.get(tile);
    if (!t || !t.pixels || t.pixels.length === 0) missing.push(slot);
  }
  return missing;
}
