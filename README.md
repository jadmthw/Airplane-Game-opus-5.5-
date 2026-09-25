# Ridgeline

A small WebGL2 flight game. You start on a runway in a mountain valley, take off, and fly a
14-ring course up the valley, over Kestrel Pass, down the winding Serpent Canyon, under the
Needle Arch and low across Mirror Lake. Then you bring the plane home for a graded landing.

Everything is procedural and dependency-free: terrain, trees, clouds, the aircraft, textures
and sound are all generated in code. There's no build step and nothing is downloaded.

## Play

Open `index.html` in a current desktop browser (Chrome, Edge, Firefox or Safari with WebGL2).
Double-clicking the file works, and so does any static server, for example
`npx http-server .` or `python3 -m http.server`.

Click **Click to fly**. Hold **W** (or roll the mouse wheel) for full throttle and keep
straight with **A / D**. At about 60 kt, hold **↓** or ease the mouse back until the nose is
about 10° up. Then raise the gear with **G** and follow the gold ring. The course clock starts at
ring 1.

To land, slow below 80 kt, press **F** twice for full flaps and **G** for the gear. Line up with
the runway (the lights beside it show 2 white + 2 red on the right glide path), flare just above
the runway and hold **Space** to brake.

## Controls

| Input | Action |
|---|---|
| Mouse (click to capture) | Virtual stick: pitch and roll |
| Mouse wheel / **W** **S** | Throttle |
| **↑** **↓** | Pitch down / up (starts gentle, builds to full) |
| **←** **→** / **Q** **E** | Roll |
| **A** **D** | Rudder and nose-wheel steering |
| **[** **]** | Pitch trim |
| **Space** | Wheel brakes |
| **F** / **G** | Flaps (0 → 1 → 2) / landing gear |
| Left mouse or **Shift** (hold) | Skywriting smoke; **T** changes its colour |
| Right mouse + move | Look around |
| **C** | Camera: chase, cockpit, orbit, tower, flyby |
| **N** | Time of day: midday, sunset, night, dawn |
| **X** / middle click | Center the stick and trim |
| **V** / **I** | Mouse flight on/off / invert mouse pitch |
| **R** | Respawn / restart the course |
| **P** / **Esc** | Pause (graphics quality, sensitivity and other options live here) |
| **H** / **F1** | Help and the stunt book |
| **U** / **M** | Hide HUD / mute |

## What's in it

- **World:** a 12 km valley ringed by named snow-capped peaks. It has forests, a lake with
  mirror reflections, a sandstone canyon with a natural arch, drifting cumulus, and a horizon
  that goes on past the playable area.
- **Airfield:** a painted runway with correct 36/18 markings, a taxiway, apron, hangar, tower
  and windsock, plus edge, threshold and approach lights and working PAPI glide-slope lights for
  both directions.
- **Aircraft:** an aerobatic sport plane with animated control surfaces, retractable gear, a
  spinning prop, navigation and strobe lights, and a landing light. The cockpit has a working
  instrument panel.
- **Flight model:** lift, drag, stalls, flaps, prop thrust, wind, gusts and thermals, plus
  spring-damper landing gear and ground steering. It's forgiving near the ground and fully
  aerobatic higher up.
- **Game:** the timed ring course with gold/silver/bronze times, bullseyes and combo
  multipliers, landing grades (Butter, good, firm, hard), crash reasons with tips, and saved
  records.
- **Stunts:** barrel roll, loop, inverted flight, knife edge, low pass, thread the needle
  (under the arch), canyon run, thermal rider (follow the circling birds), lake skim and butter
  landing.
- **Look and sound:** four times of day, with stars and moonlight at night. Skywriting smoke
  comes in seven colours. There are explosions, smoke columns, tire smoke, water spray, and
  fireworks when you finish the course or land a butter landing. All sound is synthesized with WebAudio.

## Code

Plain JavaScript files under `js/` share a `window.RL` namespace and load in order from
`index.html`. `ARCHITECTURE.md` has the module contract, conventions, event catalogue and test
hooks.

```
js/core      math, WebGL2 helpers, shared GLSL, geometry builders, event bus
js/world     terrain, water, sky and clouds, airfield, ring course, atmosphere, world queries
js/aircraft  flight model, aircraft model, autopilot (used by tests)
js/fx        particles, effects, aircraft shadow map
js/io        input, cameras, audio
js/game      rules, scoring, stunts, tutorial
js/ui        HUD (2D canvas) and menus (DOM)
```

## Tests

The tests run the real game in headless Chromium through Playwright; WebGL2 comes from
SwiftShader.

```
node tests/integration.js          # 23 end-to-end checks
node tests/harness.js --params "autostart&noaudio" --eval "RL.debug.state()" --shot out.png
                                   # ad-hoc: load, run expressions, take screenshots (see its header)
```

The integration suite checks:

- that the runway is flat and water appears only in the lake;
- that the arch opening is clear;
- that a parked plane stays still;
- takeoff distance and the flight envelope;
- an autopilot run through all 14 rings;
- a stabilized approach and a graded landing;
- crash detection and respawn;
- NaN robustness under abusive inputs.

URL flags that help with testing: `?autostart`, `?quality=low`, `?time=sunset`, `?noaudio`,
`?camera=cockpit`, `?debug`.
