// uDuke - the keyboard, as Duke's setup ships it.
//
// Duke's own layout is the table below, `keydefaults[]` from _functio.h, copied
// in Duke's order with Duke's key names — so it can be laid beside the source
// line by line, and beside SETUP.EXE's "Choose a key definition to modify"
// screen.
//
// chocolate_duke3D's _functio.h is not the DOS game's: it has 55 entries
// where Duke 1.5 has 52. xDuke added Hide_Weapon (S), Auto_Aim (V) and
// Console (`), and moved Quick_Kick from ` to C to make room for its console.
// JonoF's port keeps the 1.5 table as its "classic" defaults (jfduke3d
// src/_functio.h, the 52 plus its own Show_Console): identical to chocolate's
// for the 52 shared functions except Quick_Kick, which is ` there. The table
// here is the 52 of 1.5.
//
// The names are translated to KeyboardEvent.code once, below. `code` is the
// physical key, not the character: `KeyA` is the key where A sits on a US
// board, which is also where Duke's scan code 0x1e is. Duke read scan codes;
// this is the same choice, and it keeps the layout where a German keyboard's
// hands expect it (Z is the key left of X on QWERTY, Y on QWERTZ — as in Duke).
//
// Every function is in the table, including the ones this build has no use for
// (multiplayer messages, the co-op view, the console). They bind nothing here;
// they are listed so the table stays the table.

export const MODULE_STAGE = 'stage12.195';

/** _functio.h keydefaults[]: [function, primary, secondary], Duke's spelling. */
export const KEY_DEFAULTS = [
  ['Move_Forward', 'Up', 'Kpad8'],
  ['Move_Backward', 'Down', 'Kpad2'],
  ['Turn_Left', 'Left', 'Kpad4'],
  ['Turn_Right', 'Right', 'KPad6'],
  ['Strafe', 'LAlt', 'RAlt'],
  ['Fire', 'LCtrl', 'RCtrl'],
  ['Open', 'Space', ''],
  ['Run', 'LShift', 'RShift'],
  ['AutoRun', 'CapLck', ''],
  ['Jump', 'A', '/'],
  ['Crouch', 'Z', ''],
  ['Look_Up', 'PgUp', 'Kpad9'],
  ['Look_Down', 'PgDn', 'Kpad3'],
  ['Look_Left', 'Insert', 'Kpad0'],
  ['Look_Right', 'Delete', 'Kpad.'],
  ['Strafe_Left', ',', ''],
  ['Strafe_Right', '.', ''],
  ['Aim_Up', 'Home', 'KPad7'],
  ['Aim_Down', 'End', 'Kpad1'],
  ['Weapon_1', '1', ''],
  ['Weapon_2', '2', ''],
  ['Weapon_3', '3', ''],
  ['Weapon_4', '4', ''],
  ['Weapon_5', '5', ''],
  ['Weapon_6', '6', ''],
  ['Weapon_7', '7', ''],
  ['Weapon_8', '8', ''],
  ['Weapon_9', '9', ''],
  ['Weapon_10', '0', ''],
  ['Inventory', 'Enter', 'KpdEnt'],
  ['Inventory_Left', '[', ''],
  ['Inventory_Right', ']', ''],
  ['Holo_Duke', 'H', ''],
  ['Jetpack', 'J', ''],
  ['NightVision', 'N', ''],
  ['MedKit', 'M', ''],          // the source has "\t\t" as the secondary — a stray tab, i.e. none
  ['TurnAround', 'BakSpc', ''],
  ['SendMessage', 'T', ''],
  ['Map', 'Tab', ''],
  ['Shrink_Screen', '-', 'Kpad-'],
  ['Enlarge_Screen', '=', 'Kpad+'],
  ['Center_View', 'KPad5', ''],
  ['Holster_Weapon', 'ScrLck', ''],
  ['Show_Opponents_Weapon', 'W', ''],
  ['Map_Follow_Mode', 'F', ''],
  ['See_Coop_View', 'K', ''],
  ['Mouse_Aiming', 'U', ''],
  ['Toggle_Crosshair', 'I', ''],
  ['Steroids', 'R', ''],
  ['Quick_Kick', '`', ''],        // chocolate_duke3D: C (its console took `)
  ['Next_Weapon', "'", ''],
  ['Previous_Weapon', ';', ''],
];

// On a notebook Home/End (Aim_Up/Aim_Down) are a hand's reach from the
// arrows, and pitching the view — the crosshair, the shot — should not be.
// Strafe (Alt) + Move_Forward/Move_Backward (the up/down arrows, Kpad8/2)
// is Aim_Up/Aim_Down: 6 a tic, and it stays where it is left. While the
// chord is held the arrow does not move.
//
// The price, knowingly paid: in Duke Alt alters only the TURN keys
// (getinput), so Alt+Up walks forward and Alt+Up+Left is the diagonal
// sidestep. Here that diagonal is , or . with the up arrow instead.
export const UDUKE_CHORDS = [
  ['Strafe', 'Move_Forward', 'Aim_Up'],
  ['Strafe', 'Move_Backward', 'Aim_Down'],
];

// Duke's key names (the scan-code table in keyboard.c) to KeyboardEvent.code.
// Keypad names are matched without regard to case: the table itself writes
// both "Kpad" and "KPad".
const NAMED = {
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  lalt: 'AltLeft', ralt: 'AltRight', lctrl: 'ControlLeft', rctrl: 'ControlRight',
  lshift: 'ShiftLeft', rshift: 'ShiftRight', space: 'Space', caplck: 'CapsLock',
  pgup: 'PageUp', pgdn: 'PageDown', home: 'Home', end: 'End', insert: 'Insert', delete: 'Delete',
  enter: 'Enter', kpdent: 'NumpadEnter', bakspc: 'Backspace', tab: 'Tab', scrlck: 'ScrollLock',
  'kpad.': 'NumpadDecimal', 'kpad-': 'NumpadSubtract', 'kpad+': 'NumpadAdd',
  ',': 'Comma', '.': 'Period', '/': 'Slash', '[': 'BracketLeft', ']': 'BracketRight',
  '-': 'Minus', '=': 'Equal', "'": 'Quote', ';': 'Semicolon', '`': 'Backquote',
};

/** One of Duke's key names as a KeyboardEvent.code, or null for none. */
export function dukeKeyCode(name) {
  if (!name || !name.trim()) return null;
  const k = name.toLowerCase();
  if (NAMED[k]) return NAMED[k];
  let m = /^kpad([0-9])$/.exec(k);
  if (m) return `Numpad${m[1]}`;
  if (/^[a-z]$/.test(k)) return `Key${k.toUpperCase()}`;
  if (/^[0-9]$/.test(k)) return `Digit${k}`;
  return null;
}

/** function -> [codes], from the table. */
export const BINDINGS = new Map(KEY_DEFAULTS.map(([fn, a, b]) =>
  [fn, [dukeKeyCode(a), dukeKeyCode(b)].filter(Boolean)]));

/** code -> [functions]; a key can serve several (none does in Duke's table). */
export const FUNCTIONS_OF = new Map();
for (const [fn, codes] of BINDINGS) for (const c of codes) {
  if (!FUNCTIONS_OF.has(c)) FUNCTIONS_OF.set(c, []);
  FUNCTIONS_OF.get(c).push(fn);
}

/** ACTION(gamefunc_X): is any key of the function held in `keys` (a Set of codes)? */
export function action(keys, fn) {
  const codes = BINDINGS.get(fn);
  if (!codes) throw new Error(`no such game function: ${fn}`);
  return codes.some((c) => keys.has(c));
}

/** CONTROL_ClearAction: forget the function's keys until they are pressed again. */
export function clearAction(keys, fn) {
  for (const c of BINDINGS.get(fn) ?? []) keys.delete(c);
}

/** A function held by Duke's keys OR by one of uDuke's chords. */
export function held(keys, fn) {
  if (action(keys, fn)) return true;
  return UDUKE_CHORDS.some(([mod, key, as]) => as === fn && action(keys, mod) && action(keys, key));
}
/** A key that is part of a held chord does not do its own function. */
export function chorded(keys, fn) {
  return UDUKE_CHORDS.some(([mod, key]) => key === fn && action(keys, mod) && action(keys, key));
}

/** The first key of a function — for the touch buttons, which press one. */
export const primaryCode = (fn) => BINDINGS.get(fn)?.[0] ?? null;
