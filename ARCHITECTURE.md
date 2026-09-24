# Ridgeline — architecture & module contract

Ridgeline is a dependency-free WebGL2 flight game. The plane starts on a runway in a mountain
valley; the player takes off, flies a ring course up the valley, through a canyon and under a
stone arch, skims a lake and lands back on the runway. Mouse + keyboard are the main inputs.

This file is the contract between modules. **Read it fully before touching any file.**

## Ground rules

* Plain JavaScript (ES2017 is fine), **no build step, no ES modules, no external libraries or
  CDNs, no network requests, no image/audio files.** Everything is procedural. The game must run
  by double-clicking `index.html` (file://) as well as from any static server.
* Each file is an IIFE that attaches to the global namespace:
  ```js
  (function (RL) {
    'use strict';
    // ...
    RL.Terrain = Terrain;
  })(window.RL = window.RL || {});
  ```
  Script order is fixed in `index.html`; a module may only use other modules **inside
  functions** called after boot (init/update/draw), never at file-evaluation time
  (exception: core files `math.js`, `events.js`, `gl.js`, `shaderlib.js`, `geometry.js`,
  `config.js`, which load first).
* Files you do not own: **do not edit them.** If you need something from a core file, work
  around it locally in your own module and mention it in your report.
* `main.js` calls every module function through `RL.safe(mod, fn, args)`, which swallows and
  logs exceptions once. Do not rely on that — code must not throw. Errors are collected in
  `RL.errors` and the tests fail on them.
* Performance budget (desktop iGPU, 1080p): 60 fps. Avoid per-frame allocations in hot paths
  (reuse vectors/typed arrays). Terrain + everything else init must total < ~2.5 s.
* Style: 2-space indent, semicolons, `var`/`function` or `const`/`let` both fine, comments that
  explain *why*. Keep each file focused; no dead code.

## Conventions

* Units: meters, seconds, radians internally. Right-handed, **Y up, North = -Z, East = +X**.
  Heading = degrees clockwise from north (0 = -Z, 90 = +X).
* Model/aircraft space: **nose = -Z, right wing = +X, up = +Y.** `plane.quat` maps model → world.
* Body angular velocity `plane.angVel = [x, y, z]` uses the right-hand rule about model axes:
  `+x` = nose up, `+y` = nose **left**, `+z` = roll **left** (right wing up). (Verified in
  tests; `RL.quat.integrateLocal(q, q, angVel, dt)` integrates it.)
* Matrices: column-major `Float32Array(16)` (gl-matrix layout). See `js/core/math.js`
  (`RL.M`, `RL.v3`, `RL.quat`, `RL.m4`).
* Colors authored as sRGB 0..1; shaders convert with `toLinear()`, light in linear space, then
  `applyFog()` and `finalColor()` (exposure + ACES + gamma). All world shaders must end that way
  so everything matches.
* Winding: CCW = front face. Default GL state that **every draw function must restore**:
  depth test on, depthMask true, depthFunc LEQUAL, cull back faces, blend off,
  blendFunc(SRC_ALPHA, ONE_MINUS_SRC_ALPHA), polygon offset off. (`RL.GL.resetState(gl)`.)
  `main.js` also calls `resetState` between modules.

## Core API (already written — use it)

* `RL.GL` (`js/core/gl.js`): `createProgram(gl, vs, fs, name)` → `{program, uniforms}`;
  `use(gl, prog, {u_name: value})`; `setUniform`; `applyFrame(gl, prog, frame)` sets every
  standard frame uniform the program declares; `createMesh(gl, spec)` (fixed attribute
  locations: 0 position, 1 normal, 2 color (vec4, 3-comp data ok), 3 uv, 4–7 instance attribs);
  `meshFromGeo(gl, geo)`; `updateInstances`; `updateAttribute`; `drawMesh(gl, mesh, [instances])`;
  `createTexture(gl, canvasOrNull, opts)`; `createShadowTarget`; `drawFullscreenTriangle(gl)`;
  `resetState(gl)`. Texture unit 7 is reserved for the shadow map.
* `RL.ShaderLib` (`js/core/shaderlib.js`): `vertex(body)` / `fragment(body)` prepend
  `#version 300 es`, precision, the standard uniforms and (fragment) these functions:
  `toLinear`, `skyColor(dir)`, `applyFog(col, worldPos)`, `shadowFactor(worldPos, N)`,
  `hemiAmbient(N)`, `spotLight(worldPos, N)`, `shadeLit(albedoLin, N, worldPos, shadow, spec,
  shininess)`, `acesTonemap`, `finalColor(linear)`, `hash12`, `vnoise`.
  Standard uniforms: `u_viewProj u_view u_proj u_invViewProj u_camPos u_time u_resolution
  u_sunDir u_sunColor u_ambientSky u_ambientGround u_skyZenith u_skyHorizon u_fogColor
  u_fogDensity u_fogHeightFalloff u_nightFactor u_exposure u_shadowMatrix u_shadowEnabled
  u_spotPos u_spotDir u_spotIntensity` + `u_shadowMap` (fragment). Use `layout(location = N)`
  on vertex inputs and `out vec4 outColor;` in fragment shaders.
* `RL.Geo` (`js/core/geometry.js`): CPU mesh builders — `box, cylinder, cone, sphere, torus,
  lathe, extrude, plane, quad`, transforms `transform/translate/scale/rotate/rotateX/Y/Z`
  (mirroring flips winding automatically), `merge, clone, setColor, colorBy, computeNormals,
  toFlat` (low-poly flat shading), `bounds`, `triangulate`.
* `RL.Events` (`js/core/events.js`): `on(type, fn)` → unsubscribe fn, `once`, `off`, `emit`.
* `RL.Config` (`js/config.js`): world layout (runway, flat zone, valley, lake, canyon, arch,
  rings, thermals, wind), physics & render constants, `isOnRunway(x, z, margin)`.
* `RL.World` (`js/world/world.js`): **the physical-world query API** — `heightAt(x,z)`,
  `normalAt(x,z,out)`, `surfaceHeightAt` (max of terrain and water), `isWater`, `surfaceAt(x,z)`
  → `'water'|'runway'|'paved'|'grass'|'rough'`, `getColliders()`, `pointHitsCollider(p)`,
  `outOfBounds(x,z)`, `windAt(x,y,z,t,out)` (wind + gusts + thermals), `thermalStrengthAt`,
  `waterLevel`.
* `RL.Atmosphere` (`js/world/atmosphere.js`): time-of-day presets `day, sunset, night, dawn`,
  `params` (current interpolated lighting, linear colors, `nightFactor` 0..1), `cycle()`.
* `RL.Params`: URL flags `autostart`, `quality=low`, `debug`, `time=<preset>`, `noaudio`,
  `camera=<mode>`.

## The frame object (built by main.js every frame)

```
frame = {
  time, dt, realTime,                        // time = game time (freezes when paused)
  view, proj, viewProj, invViewProj,         // Float32Array(16)
  camPos, camForward,                        // v3
  resolution: [w, h], pixelRatio, aspect, fov, near, far,
  sunDir, sunColor, ambientSky, ambientGround, skyZenith, skyHorizon,
  fogColor, fogDensity, fogHeightFalloff, nightFactor, exposure,
  spotPos, spotDir, spotIntensity,           // aircraft landing light (night)
  shadow: { texture, matrix, enabled } | null,
  cameraMode, gameState
}
```

## Main loop (js/main.js) — call order

Boot (in order, each once): `Atmosphere.init()`, `Terrain.init(gl, {resolution})`,
`Water.init(gl)`, `Sky.init(gl)`, `Airfield.init(gl)`, `Rings.init(gl)`, `Aircraft.init(gl)`,
`Particles.init(gl)`, `Effects.init(gl)`, `Shadow.init(gl, size)`, `Input.init(canvas)`,
`CameraRig.init()`, `Audio.init()`, `HUD.init(hudCanvas)`, `UI.init()`, `Game.init()`.

Every frame:
1. `Input.update(realDt)`; `Input.consumeActions()` → each action dispatched: `camera` →
   `CameraRig.cycle()`, `mute` → `Audio.toggleMute()`, `timeOfDay` → `Atmosphere.cycle()`,
   `smokeColor` → `Effects.cycleSmokeColor()`, `help` → `UI.toggleHelp()`, `hud` →
   `HUD.toggle()`, anything else → `Game.handleAction(name)`.
2. `Atmosphere.update(dt)`, `Game.update(simDt, controls)` (simDt = 0 while paused),
   `Effects.update(simDt, plane, controls, gameState)`, `Particles.update(simDt)`,
   `Sky.update(simDt)`, `Airfield.update(simDt)`, `Water.update(simDt)`, `Rings.animate(simDt)`,
   `CameraRig.update(realDt, plane, RL.Input, gameState)`.
3. Build frame. Shadow pass: `Aircraft.getShadowCasters(plane)` → `Shadow.render(frame,
   casters, plane.pos)`.
4. Opaque: `Sky.draw`, `Terrain.draw`, `Airfield.draw`, `Aircraft.draw(frame, plane, opts)`,
   `Effects.draw`. Transparent: `Water.draw`, `Rings.draw`, `Sky.drawClouds`, `Particles.draw`,
   `Airfield.drawLights`, `Aircraft.drawLights(frame, plane, opts)`.
   `opts = { cockpit: bool, crashed: bool, hidden: bool }`.
5. `HUD.draw(realDt)`, `Audio.update(realDt, plane, controls, {state, cameraMode})`.

Test hooks (`RL.debug`): `controls` (object merged over input controls), `camera`
(`{pos, target, fovDeg}` overrides the camera rig — use it for screenshots), `freeze`,
`simulate(seconds, controls, dt)` (synchronous sim without rendering), `state()`,
`teleport(x, y, z, heading, speed)`.

## Module APIs (owned by feature agents)

### RL.Terrain — js/world/noise.js, js/world/terrain.js (world agent)
* `init(gl, {resolution})`; `ready` (true after init).
* `heightAt(x, z)` — **must interpolate exactly the rendered triangles** (same diagonal split),
  clamped at the world edge. Inside `Config.airfield.flatZone` it returns exactly
  `Config.airfield.elevation`.
* `normalAt(x, z, out)`; `draw(frame)` (ground + trees + rocks + arch).
* `colliders` — spheres approximating the stone arch (`{type:'sphere', center, radius, name:'arch'}`).
* `landmarks` — `[{name, x, z, y}]` (peaks, lake, canyon, arch, airfield) for HUD/minimap.
* `getHeightData()` → `{ data: Float32Array((res+1)^2), res, half }` row-major z then x.
* `arch` — `{ center: [x, floorY, z], dir: [dx, 0, dz] (unit canyon direction), openingHeight,
  openingHalfWidth }` describing the clear opening (rings.js puts the arch ring there).

### RL.Water — js/world/water.js (world agent)
* `init(gl)`, `update(dt)`, `draw(frame)` (blended surface at `Config.water.level`).

### RL.Sky — js/world/sky.js (world agent)
* `init(gl)`, `update(dt)`, `draw(frame)` (background: gradient via `skyColor`, sun disc,
  stars/moon at night; depth write off), `drawClouds(frame)` (soft billboard clouds, blended).

### RL.Airfield — js/world/airfield.js (airfield agent)
* `init(gl)`, `update(dt)`, `draw(frame)`, `drawLights(frame)` (runway edge/threshold lights,
  PAPI, beacon glow; visible mainly at dusk/night, PAPI always).
* `colliders` — `[{type:'box', min:[x,y,z], max:[x,y,z], name}]` for buildings.
* `isPaved(x, z)` — taxiway/apron (not runway).
* `towerCamPos` — v3, a good camera point on the control tower (camera 'tower' mode).

### RL.Rings — js/world/rings.js (airfield agent)
* `init(gl)`, `reset()`, `animate(dt)`, `draw(frame)`.
* `list` — `[{ pos: v3, dir: v3 (unit, direction of travel through the ring), radius,
  special: null|'arch'|'lake'|'final', passed: bool, index }]`; `current` (index of the next
  ring, `list.length` when done); `total`; `complete` (bool).
* `check(prevPos, pos)` → `null` or the ring object just passed. Only the current ring counts;
  it counts when the segment prevPos→pos crosses the ring plane within `radius` in the direction
  of travel. Advances `current`.
* `getCurrent()` → ring or null.

### RL.FlightModel — js/aircraft/flightmodel.js (aircraft agent)
* `create()` → plane state (see below). `reset(plane, spawn)` where spawn is
  `{x, z, heading, onGround: true}` (resting on the gear on the ground) or
  `{x, y, z, heading, speed, onGround: false}` (level flight at speed).
* `step(plane, controls, dt, world)` → array of raw events
  `{type: 'liftoff'|'touchdown'|'bounce'|'crash'|'stall'|'stallRecover', ...data}`;
  `touchdown` includes `{verticalSpeed (m/s, +down), speed, surface, onRunway,
  centerlineOffset, headingError (deg vs runway axis), roll (deg)}`; `crash` includes
  `{reason: 'terrain'|'water'|'building'|'arch'|'hardLanding'|'wingStrike'|'bellyLanding'|
  'noseStrike'|'rough'|'bounds', speed}`. `world` is `RL.World`.
* `toggleGear(plane)` → bool accepted (refused on the ground); `cycleFlaps(plane)` → new notch.
* `specs` — `{ vStall, vStallFlaps, vRotate, vCruise, vMax, vNeverExceed }` in m/s for HUD tapes.

Plane state fields (all kept up to date by `step`/`reset`):
```
pos v3, vel v3 (world m/s), quat, angVel v3 (body rad/s), forward/up/right v3 (world),
throttle 0..1 (as applied), rpm 0..1 (spools toward throttle; prop & audio),
flaps 0..1 (animated), flapsNotch 0|1|2, gearDown bool, gear 0..1 (animated, 1 = down),
brake 0..1, onGround bool, wheelsOnGround 0..3,
airspeed (m/s TAS along-velocity vs air), groundSpeed, verticalSpeed (m/s, +up),
altitude (= pos.y), agl (above terrain/water under the plane), aoa (rad), slip (rad),
gForce (load factor), stall bool, stallWarning 0..1,
heading/pitch/roll (degrees; roll + = right wing down),
surfaces {aileron, elevator, rudder} (-1..1 smoothed deflections for the model),
crashed bool, crashReason string, smoke bool, time (s since reset)
```

### RL.Aircraft — js/aircraft/model.js (aircraft agent)
* `init(gl)`, `draw(frame, plane, opts)`, `drawLights(frame, plane, opts)` (nav lights red/
  green/white strobe, beacon), `getShadowCasters(plane)` → `[{mesh, model}]` (mesh uses
  attribute 0 positions), `cockpitOffset` v3 (model-space eye point),
  `getLandingLight(plane, nightFactor)` → `{pos, dir, intensity}`.
* Animated parts: propeller (blur disc at high rpm), ailerons/elevator/rudder, flaps, gear
  retraction. Crashed: charred look.

### RL.Autopilot — js/aircraft/autopilot.js (aircraft agent)
* `fly(plane, target v3, dt, opts)` → controls object steering toward target (used by tests to
  prove the ring course is flyable, and by the title-screen attract camera if wanted).

### RL.Particles — js/fx/particles.js (fx agent)
* `init(gl)`, `emit(type, pos, vel, count, opts)`, `update(dt)`, `draw(frame)`, `clear()`.

### RL.Effects — js/fx/effects.js (fx agent)
* `init(gl)`, `update(dt, plane, controls, gameState)`, `draw(frame)` (opaque extras such as
  birds circling thermals), `cycleSmokeColor()` → label, `reset()`. Subscribes to events
  (crash → explosion/fire/smoke, touchdown → tire smoke, ring → sparkle burst, splash…).
  Continuous: exhaust, runway dust, wingtip vortices at high G, skywriting smoke while
  `controls.smoke`.

### RL.Shadow — js/fx/shadow.js (fx agent)
* `init(gl, size)`, `render(frame, casters, focusPos)` → sets `frame.shadow = {texture,
  matrix, enabled: true}` (orthographic box around the aircraft along `frame.sunDir`), restores
  the default framebuffer. Disabled (frame.shadow stays null) when the sun is below ~2°.

### RL.Input — js/io/input.js (controls agent)
* `init(canvas)`, `update(dt)`, `controls` = `{pitch, roll, yaw, throttle, brake, smoke}`
  (pitch + = nose up, roll + = right, yaw + = nose right; throttle 0..1 is state kept by Input;
  brake 0..1; smoke bool), `consumeActions()` → array of names, `stick` `{x, y}` (virtual
  stick for HUD), `pointerLocked`, `mouseFlight` bool, `look` `{yaw, pitch, active}` (free-look
  offsets in radians for the camera), `setThrottle(v)`, `requestPointerLock()`,
  `exitPointerLock()`, `settings` `{invertPitch, sensitivity, stickReturn}` (localStorage).
* Emits `userGesture` on the first key/mouse interaction (audio unlock).

### RL.CameraRig — js/io/camera.js (controls agent)
* `init()`, `update(dt, plane, input, gameState)`, `mode` (`chase|cockpit|orbit|tower|flyby`,
  plus `attract` while gameState = 'title'), `cycle()` → label, `setMode(name)`,
  `position` v3, `view` m4, `fov` (radians), `near`, `far`, `shake(amount)`.
  Never lets the camera go below the terrain/water surface.

### RL.Audio — js/io/audio.js (controls agent)
* `init()`, `unlock()` (resume AudioContext on a user gesture), `update(dt, plane, controls,
  info)`, `toggleMute()` → muted bool, `muted`. All sounds synthesized with WebAudio.
  Subscribes to events for one-shots. Must do nothing (and not throw) with `?noaudio`.

### RL.Game — js/game/game.js (game agent)
* `init()`, `state` (`'title'|'playing'|'paused'|'crashed'`), `plane`, `start()`,
  `handleAction(name)`, `update(dt, controls)` (fixed 1/120 s physics substeps via
  `RL.FlightModel.step`, ring checks, scoring, crash/respawn, stunts), `score`, plus whatever
  HUD needs. Emits the bus events below.

### RL.HUD — js/ui/hud.js, RL.UI — js/ui/ui.js, css/ui.css (game agent)
* HUD: `init(canvas2d)`, `resize(w, h, dpr)`, `draw(dt)`, `toggle()`. Reads `RL.Game`,
  `RL.Input`, `RL.CameraRig`, `RL.Rings`, `RL.Terrain`, `RL.Atmosphere` directly.
* UI: `init()`, `toggleHelp()`, DOM overlays inside `#ui-root` (title screen, pause, help,
  crash / results panels, toasts).

## Input map

| Input | Action |
|---|---|
| Mouse move (pointer locked) | Virtual stick: pitch / roll |
| Mouse wheel | Throttle |
| Left mouse (hold) | Skywriting smoke |
| Right mouse (hold) + move | Free look |
| Middle click / X | Center the stick |
| W / S | Throttle up / down |
| A / D | Rudder (nose-wheel steering on the ground) |
| ↑ / ↓ | Pitch down / up |
| ← / → and Q / E | Roll left / right |
| Space | Wheel brakes |
| F | Flaps (0 → 1 → 2 → 0) |
| G | Landing gear |
| C | Camera mode |
| T | Smoke color |
| N | Time of day |
| R | Respawn / restart course |
| P / Esc | Pause |
| H / F1 | Help |
| M | Mute |
| I | Invert mouse pitch |
| V | Toggle mouse flight |
| U | Toggle HUD |
| Enter / click | Start (title screen) |

Action names: `start, pause, reset, flaps, gear, camera, smokeColor, timeOfDay, help, mute,
hud` (Input handles `centerStick`, `invertPitch`, `mouseFlight` itself).

## Event catalogue (RL.Events)

| Event | Emitted by | Payload |
|---|---|---|
| `ready` | main | `{}` |
| `userGesture` | Input | `{}` |
| `gameStart` | Game | `{}` |
| `respawn` | Game | `{}` |
| `liftoff` | Game | `{speed}` |
| `touchdown` | Game | `{verticalSpeed, speed, surface, onRunway, centerlineOffset, headingError, pos}` |
| `landing` | Game | `{grade: 'perfect'|'good'|'firm'|'hard', label, points}` |
| `bounce` | Game | `{pos}` |
| `crash` | Game | `{reason, label, pos, vel, speed}` |
| `stall` | Game | `{active: bool}` |
| `gear` | Game | `{down: bool}` |
| `flaps` | Game | `{notch, label}` |
| `ring` | Game | `{index, total, pos, special, points, time}` |
| `courseStart` / `courseComplete` | Game | `{}` / `{time, best, record}` |
| `score` | Game | `{delta, total, reason}` |
| `stunt` | Game | `{name, points}` |
| `pause` | Game | `{paused}` |
| `message` | anyone | `{text, kind: 'info'|'good'|'warn'|'bad', duration}` → toast |
| `timeOfDay` | Atmosphere | `{name, label}` |
| `camera` | CameraRig | `{mode, label}` |
| `smokeColor` | Effects | `{name, color}` |

## Testing

`node tests/harness.js --params "autostart&noaudio" --eval "<expr>" --shot out.png` loads the
game in headless Chromium (SwiftShader WebGL2), runs expressions, takes screenshots and prints
console errors + `RL.errors` (exit code 1 if any). Screenshots are the way to *look* at your
work — use them. `--params "quality=low"` speeds things up. See the header of
`tests/harness.js`.
