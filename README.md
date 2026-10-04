# uDuke — Duke Nukem 3D in the browser, served by OpenWrt / uhttpd

A dependency-free JavaScript port of the Build engine and of Duke Nukem 3D's game code. It reads the **original Duke Nukem 3D data** — your own `DUKE3D.GRP` — and plays it in the browser.

To be clear about the division of labour, because the setting invites the wrong idea: **the router does not run the game.** It serves a handful of static files over `uhttpd` — the page, the JavaScript and the GRP you supply. Everything else happens client-side, in the browser on your phone or PC: the renderer, the CON scripts, the actors, the sound and the music.

**No game content is shipped.** You supply the data from a copy you own. The engine only *interprets* it.

## Data file

One file: `DUKE3D.GRP` from **Duke Nukem 3D: Atomic Edition 1.5** (about 44 MB), copied into the page's folder next to `index.html`. The page fetches it by exactly that name, so on a case-sensitive file system (the router) it must be upper case — or name it in the URL: `index.html?grp=duke3d.grp`.

Everything comes out of that one archive: the maps, the tiles and palettes, the CON scripts, the sounds, the MIDI music with Duke's own FM instruments (`D3DTIMBR.TMB`) and the cutscenes.

Don't own a copy? Duke Nukem 3D: Atomic Edition can be bought (around $5.99) on ZOOM Platform: <https://www.zoom-platform.com/product/duke-nukem-3d-atomic-edition> — `DUKE3D.GRP` is in the installed game folder. The shareware GRP loads too, but only with its first episode and without the registered weapons.

## What it does

- **The Build engine, ported rule by rule from Ken Silverman's `engine.c`**: portal traversal with Build's bunch ordering, textured walls, floors and ceilings, sloped sectors, parallax skies, all three sprite alignments (face, wall, floor), masked walls, animated tiles, view pitch, mirrors, the alternate palettes, distance shading — every constant derived from the engine's own arithmetic, not calibrated by eye (Build does not even share one focal length between the two axes, and neither does uDuke)
- **Collision as Build does it**: `clipmove`, `getzrange` and `pushmove` against walls, steps and sprites of all three alignments — a flat sprite blocks at its own height, a one-sided one from one side only
- **The CON interpreter**: `GAME.CON`, `USER.CON` and `DEFS.CON` from your GRP are compiled and run, every command of the 1.5 CON, so every scripted actor behaves the way its script says
- **The actors' C side** from `actors.c`: troopers, captains, pig cops, octabrains, drones, slimers and their eggs, the bosses, the rat, water mines, turrets, recon cars, the reactors and their meltdown, trash, flying mail and paper, spent shells — everything the original moves in C rather than in CON
- **Every weapon of the 1.5 GRP**: kick, pistol, shotgun, chaingun, RPG, pipe bombs, shrinker and expander, devastator, trip bombs and the freezer — with the original timings, spread, auto-aim, ricochets and blast radii
- **The world**: every door kind, lifts and warp elevators, trains and subways, every sector effector of `moveeffectors` (SE 0–36) plus the run-time ones (glass breakage, explosions), switches and key cards, touchplates, master switches, respawn closets, force fields, conveyors, earthquakes, crushers, water and diving
- **The player**: Duke's physics (acceleration and friction per tic, not per second), jumping, crouching, swimming, the jetpack, the inventory (medkit, steroids, night vision, holoduke, scuba gear, boots, jetpack), shrinking, freezing (a frozen Duke thaws after a while — or is kicked to pieces), drowning, footprints, the death view lying on its side
- **The camera monitors**: watch through a camera, step through the monitor's cameras with the use key, the camcorder frame — and the monitor's own picture, the camera's view drawn into the screen's tile every twelfth frame, as Duke's `xyzmirror` does
- **Sound** from your GRP: Duke's lines, the weapons, the monsters, ambient loops, with the original sound model — distance, priorities, one line at a time for Duke
- **Music as Duke played it on a Sound Blaster**: the GRP's MIDI files through Apogee's sequencer and AdLib driver on an emulated **OPL3**, with Duke's own instruments — the title song, each level's song from `USER.CON`, silence for the endings. The chip runs in a **Web Worker**, off the main thread; unlike an AudioWorklet that works over plain HTTP too, so the router needs no HTTPS for it
- **The cutscenes**: the start-up sequence (`LOGO.ANM` with its sounds, the 3D Realms screen, the title), the ENTERING screen between levels, and the four episode endings with their films, stills and text
- **Duke's status bar**, tile for tile as `coolgaugetext` draws it, and the full-screen view with Duke's mini HUD (`-` and `=`), set at the window's bottom-left corner
- **No black bars**: in play the picture fills the window — on a wide screen the 3D view is widened at the same focal length (you see more to the left and right, nothing is stretched), with Duke's weapon, status bar and texts centred in it; the start-up, loading and ending screens stay 4:3
- **Saved games** in three slots, stored in the browser's `localStorage`
- **Mobile controls** for phones and tablets, alongside keyboard and mouse

Not done: Duke's own menus (uDuke has a menu of its own), demos and multiplayer.

## Controls

Desktop: Duke's own default key layout — the `keydefaults` table of `SETUP.EXE`, by physical key position, so on a German keyboard crouch is the key labelled Y. **↑/↓** move, **←/→** turn, **Alt** + **←/→** or **,/.** strafe, **Shift** run (**CapsLock** auto run), **Ctrl** fire, **Space** open and use, **A** jump, **Z** crouch, **PgUp/PgDn** look up and down, **Home/End** aim, **1–0** weapons, **Enter** use the item on show, **[ ]** choose an item, **H/J/N** holoduke, jetpack, night vision, **M/R** medkit, steroids, **`** quick kick, **Tab** map, **-/=** status bar, mini HUD (health and ammo at the bottom left), no HUD — Duke's screen sizes 8, 4 and 0, **Esc** menu. The full list is on the menu page.

On a German keyboard the keys are where a US keyboard has them, so the punctuation ones carry other labels: - and = (screen size) are ß and ´, the two keys left of Backspace (the keypad's - and + work too), [ and ] (choose an item) are Ü and +, ; and ' (previous and next weapon) are Ö and Ä, ` (quick kick) is ^, and / (jump, besides A) is -.

Click the view to capture the mouse: it turns and looks, the left button fires. **U** toggles mouse aiming (on by default).

Two additions of uDuke's own: **Alt+↑/↓** aim like Home/End, for keyboards where those are out of reach, and **Alt+D** shows the debug lines over the view.

Touch: tick **mobile controls** on the menu — on by default on a phone or tablet (the browser reports a finger as its main pointer), off otherwise; a change holds for the visit, not across reloads. A **d-pad** bottom left: up/down walk, left/right turn, the centre opens and uses. The pad is one capture surface, so your thumb can slide from "forward" straight into "turn" without lifting. Bottom right: **FIRE** (hold it), **JMP**, **CRO**, **WPN** (next weapon), **USE ITEM** and **ITEM ›**. A drag anywhere else on the view turns and looks, like the mouse. **MENU** and **MAP** sit top right. Every touch control feeds the same keys as the keyboard, so the two cannot behave differently. Landscape fits best — the view then fills the whole screen; in portrait it is letterboxed and the controls sit under it.

On the menu you pick the level by episode and set the difficulty, the crosshair, **god mode**, **all weapons, full ammo and all key cards**, the mobile controls and the music.

## Saved games

Three slots on the menu, stored in the browser's `localStorage`, so they work entirely offline and the router never stores anything — but they are per-browser and per-origin, and clearing the site data removes them.

A save holds everything that changes while a level runs — the map's sectors, walls and sprites, the actors' and scripts' state, the effectors, the running animations, the player and the inventory — stored only as the difference from a freshly loaded copy of the level, about 100 KB for a large level mid-game. Loading builds the level fresh and puts that state back into it.

## Layout

```
uDuke/
  index.html          the game: menu, level picker, options, save/load, pointer lock, mobile controls
  js/grp.js           GRP archive reader
  js/palette.js       PALETTE.DAT, LOOKUP.DAT, shade tables
  js/art.js           TILESnnn.ART tiles
  js/map.js           MAP v7, sector loops, slopes
  js/geometry.js      point-in-sector, sector search, loop nesting
  js/render.js        the portal renderer
  js/clip.js          collision: clipmove, getzrange, pushmove
  js/sector.js        sector state: animations, doors, neartag
  js/effector.js      sector effectors, activators, master switches, touchplates, transporters
  js/switch.js        switches: checkhitswitch
  js/player.js        the player: physics, inventory, death
  js/con.js           CON: compiler, interpreter, and the actors' C side
  js/hitwall.js       shots on walls and breakables
  js/weaponview.js    the weapon in hand
  js/monitor.js       the camera monitors' picture (xyzmirror)
  js/blit.js          the 2D layer: tiles written into the frame's pixels, the tilted view
  js/statusbar.js     Duke's status bar
  js/screens.js       ANM decoder, the start-up sequence, the loading screen
  js/sound.js         the sound model: xyzsound, callsound, priorities
  js/audio.js         the sound device (Web Audio)
  js/opl3.js          the OPL3 FM chip (Nuked OPL3 1.8)
  js/music.js         Apogee's MIDI sequencer and AdLib driver
  js/musicout.js      the music's way out: blocks from the worker onto the AudioContext
  js/musicworker.js   the Web Worker that runs the music
  js/save.js          saving and loading
  js/keys.js          Duke's default key table
  js/menu.js          the menu's level list
  js/boot.js          loading the GRP and standing a level up
  js/version.js       the release stage
```

## Deploy on OpenWrt (uhttpd)

Serve the whole thing from a mounted disk (USB/NVMe) via its own uhttpd instance, so you don't touch the router's flash — the GRP alone is about 44 MB:

```sh
mkdir -p /mnt/data/uDuke      # your USB/NVMe mount
# copy the uDuke/ contents here, and your DUKE3D.GRP next to index.html
```

Add an instance to `/etc/config/uhttpd`:

```
config uhttpd 'duke'
    option listen_http '0.0.0.0:8089'
    option home '/mnt/data/uDuke'
    option index_page 'index.html'
    option max_requests '5'
```

```sh
/etc/init.d/uhttpd restart
```

Then browse to `http://<router-ip>:8089/`.

The page uses ES modules, so it has to come over HTTP — opening `index.html` from disk (`file://`) fails. Any static web server will do; on a desktop, for example `busybox httpd -f -p 8080 -h .` in the uDuke folder. The GRP is read with `fetch().arrayBuffer()`, so no special MIME configuration is needed for it. Plain HTTP is enough for everything, the music included.

## Source & credits

uDuke is a port, not a clean-room reimplementation: its behaviour is transcribed rule by rule from the released source code and checked against the original game, and the comments cite the files and lines they follow.

- Duke Nukem 3D source code, released by 3D Realms under the GPL, read in Fabien Sanglard's Chocolate Duke3D: <https://github.com/fabiensanglard/chocolate_duke3D>
- Ken Silverman's Build engine source (`engine.c`), included there
- Apogee's audiolib by James R. Dose, as EDuke32 and NBlood keep it — the MIDI sequencer and the AdLib driver
- Nuked OPL3 by Nuke.YKT — the FM chip

Huge thanks to all of them.

This browser port — "uDuke" — was written by Dirk Brenken with **Claude** (Anthropic).

## Licensing

uDuke is not a clean-room reimplementation. It is a port to JavaScript, and large parts are transcribed rule by rule from the released source code; the comments cite the files and lines they follow.

- The game logic — the CON interpreter (gamedef.c), the actors and effectors (actors.c), sectors, switches and doors (sector.c), the player (player.c), spawning and the level setup (game.c, premap.c), the sound model (sounds.c) — is derived from the Duke Nukem 3D source code, released by 3D Realms in 2003 under the GNU General Public License, version 2 or (at your option) any later version. uDuke is distributed under the same license, GPL version 2 or later.
- The engine parts — collision and zrange (clip.js), hitscan and cansee, the sector and portal geometry, parts of the renderer (render.js), the palette and shade tables (palette.js) — follow Ken Silverman's Build engine source (engine.c), which is not under the GPL but under Ken Silverman's own license (BUILDLIC.TXT): free for non-commercial use, with credit to Ken Silverman, and not compatible with the GPL for commercial redistribution. Those parts carry his terms along, so in effect uDuke as a whole can only be used and passed on non-commercially.
- The music — js/music.js (the MIDI sequencer with Apogee's EMIDI extensions, and the General MIDI driver for AdLib-type cards) — is ported from Apogee's audiolib by James R. Dose (midi.cpp and driver_adlib.cpp / AL_MIDI.C as EDuke32 and NBlood keep them), GPL version 2 or later. js/opl3.js is a port of Nuked OPL3 1.8 by Nuke.YKT (with its stereo extension, as in the same audiolib), under the GNU Lesser General Public License 2.1 or later; that file keeps the LGPL. The instruments are Duke's own D3DTIMBR.TMB from your GRP.

"Build Engine & Tools" Copyright (c) 1993-1997 Ken Silverman. Ken Silverman's official web site: "http://www.advsys.net/ken". See BUILDLIC.TXT (shipped with the Build and Duke Nukem 3D source releases) for the exact terms.

## Legal

Duke Nukem 3D and its data files are the property of their respective rights holders; nothing from the game is included here. Use only data from a copy you legally own.
