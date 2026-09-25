/*
 * Ridgeline — RL.Effects: gameplay-driven visual effects built on RL.Particles, plus birds.
 *
 *   init(gl)                                   bird mesh/program, event subscriptions
 *   update(dt, plane, controls, gameState)     continuous emitters, fires, fireworks, birds
 *   draw(frame)                                opaque extras: soaring birds (instanced)
 *   cycleSmokeColor() -> label                 skywriting colour (emits 'smokeColor')
 *   reset()                                    clears particles, fires, fireworks
 *
 * Event reactions: crash (fireball, sparks, smoking debris, a fire that burns down under a tall
 * wind-blown smoke column; a water crash throws up a huge splash instead), touchdown (tyre smoke
 * scaled by sink rate, dust on grass), bounce, ring (sparkle burst traced around the ring's
 * rim), stunt (a little glitter), courseComplete and 'perfect' landings (a fireworks show over
 * the airfield), respawn (reset).
 * Continuous: exhaust wisps, grass dust and prop wash, a rooster-tail of spray when skimming the
 * lake, wingtip vapour at high g (and at high AoA in humid dawn air), skywriting smoke.
 * Birds: raptors circling in every thermal (stacked, all turning the same way — a visual hint
 * of where the lift is) and a V of geese gliding up and down the valley; they scatter from the
 * aircraft and roost at night.
 */
(function (RL) {
  'use strict';

  var M = RL.M, v3 = RL.v3, C = RL.Config;
  var DEG = Math.PI / 180;

  // ------------------------------------------------------------------ skywriting colours (sRGB)
  var SMOKE_COLORS = [
    { name: 'white', label: 'White', rgb: [0.97, 0.97, 0.97] },
    { name: 'crimson', label: 'Crimson', rgb: [0.88, 0.09, 0.15] },
    { name: 'sunflower', label: 'Sunflower', rgb: [1.0, 0.8, 0.08] },
    { name: 'sky', label: 'Sky', rgb: [0.25, 0.62, 1.0] },
    { name: 'mint', label: 'Mint', rgb: [0.35, 0.95, 0.66] },
    { name: 'violet', label: 'Violet', rgb: [0.6, 0.32, 0.98] },
    { name: 'rainbow', label: 'Rainbow', rgb: null }
  ];

  // Strongly saturated: emissive colours lose saturation through the ACES tonemap.
  var FW_COLORS = [
    [1.0, 0.1, 0.06], [1.0, 0.62, 0.05], [0.15, 1.0, 0.2], [0.12, 0.3, 1.0],
    [0.7, 0.15, 1.0], [0.95, 0.9, 0.8], [0.05, 0.9, 1.0], [1.0, 0.2, 0.6]
  ];
  var GOLD = [1.0, 0.72, 0.3];
  // shared constant colours (sRGB) so hot paths never allocate
  var WHITE = [1, 1, 1], EMBER = [0.9, 0.35, 0.1];
  var SOOT = [0.14, 0.13, 0.13], SOOT_END = [0.38, 0.37, 0.37], PLUME_END = [0.46, 0.45, 0.45];
  var FIRELIT = [0.3, 0.15, 0.08], MIST = [0.9, 0.94, 0.98], MIST_END = [0.95, 0.97, 1.0];
  var GRASS_DUST = [0.6, 0.55, 0.4], GRASS_DUST_END = [0.7, 0.65, 0.52];
  var AXIS_X = [1, 0, 0], AXIS_Y = [0, 1, 0], AXIS_Z = [0, 0, 1];

  // Default body-space reference points (overridden by RL.FlightModel.points when present).
  var DEFAULT_POINTS = {
    wingtipL: [-4.5, 0.02, 0.1], wingtipR: [4.5, 0.02, 0.1],
    wheels: [[0, -1.45, -2.3], [-1.3, -1.45, 0.28], [1.3, -1.45, 0.28]],
    exhaust: [0.45, -0.25, -2.2], smoke: [0, -0.1, 4.1]
  };

  // ------------------------------------------------------------------ state
  var gl = null;
  var smokeIdx = 0;
  var time = 0;
  var lastPlane = null;
  var subs = [];

  // continuous emitter accumulators / previous emission points
  var acc = { exhaust: 0, dust: 0, wash: 0, spray: 0, mist: 0, smokeT: 0 };
  var prevSmoke = v3.create(), prevTipL = v3.create(), prevTipR = v3.create(), prevExh = v3.create();
  var prevValid = false;
  var distSmoke = 0, distVaporL = 0, distVaporR = 0;

  // scratch (no per-frame allocation)
  var tA = v3.create(), tB = v3.create(), tC = v3.create(), tV = v3.create(), tP = v3.create();
  var tU = v3.create(), tW = v3.create(), exhL = v3.create(), tRGB = [1, 1, 1];
  var optsA = newOpts(), optsB = newOpts();   // reusable emitter options (see newOpts)

  // fires left by crashes
  var FIRE_MAX = 4;
  var fires = [];
  for (var fi = 0; fi < FIRE_MAX; fi++) fires.push({ active: false, x: 0, y: 0, z: 0, t: 0, dur: 30, strength: 1, fAcc: 0, sAcc: 0, bAcc: 0 });

  // fireworks: shells in flight + scheduled launches
  var SHELL_MAX = 24, LAUNCH_MAX = 40;
  var shells = [], launches = [];
  for (var si = 0; si < SHELL_MAX; si++) shells.push({ active: false, pos: v3.create(), vel: v3.create(), fuse: 0, kind: 0, c1: 0, c2: 0, tAcc: 0 });
  for (var li = 0; li < LAUNCH_MAX; li++) launches.push({ active: false, at: 0, x: 0, z: 0 });

  function rand(a, b) { return a + (b - a) * Math.random(); }

  function points() {
    return (RL.FlightModel && RL.FlightModel.points) || DEFAULT_POINTS;
  }

  /** out = plane.pos + plane.quat * local */
  function toWorld(out, plane, local) {
    v3.transformQuat(out, local, plane.quat);
    out[0] += plane.pos[0]; out[1] += plane.pos[1]; out[2] += plane.pos[2];
    return out;
  }

  function hsv(h, s, v, out) {
    h = ((h % 1) + 1) % 1 * 6;
    var i = Math.floor(h), f = h - i, p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
    var r, g, b;
    switch (i) {
      case 0: r = v; g = t; b = p; break;
      case 1: r = q; g = v; b = p; break;
      case 2: r = p; g = v; b = t; break;
      case 3: r = p; g = q; b = v; break;
      case 4: r = t; g = p; b = v; break;
      default: r = v; g = p; b = q;
    }
    out[0] = r; out[1] = g; out[2] = b;
    return out;
  }

  function P() { return RL.Particles && RL.Particles.ready ? RL.Particles : null; }

  function groundY(x, z) {
    return RL.World ? RL.World.heightAt(x, z) : C.airfield.elevation;
  }

  function finiteV(p) { return p && isFinite(p[0]) && isFinite(p[1]) && isFinite(p[2]); }

  // Emitter option objects are reused; reset every key RL.Particles.emit reads (keeps one shape).
  function newOpts() {
    return { color: undefined, colorEnd: undefined, size: undefined, grow: undefined, life: undefined,
      spread: undefined, posSpread: undefined, alpha: undefined, glow: undefined, heat: undefined,
      inherit: undefined, drag: undefined, gravity: undefined };
  }
  function clearOpts(o) {
    o.color = o.colorEnd = o.size = o.grow = o.life = o.spread = o.posSpread = o.alpha = o.glow =
      o.heat = o.inherit = o.drag = o.gravity = undefined;
    return o;
  }

  // ------------------------------------------------------------------ one-shot bursts
  function randomUnit(out) {
    var z = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r = Math.sqrt(1 - z * z);
    out[0] = r * Math.cos(a); out[1] = z; out[2] = r * Math.sin(a);
    return out;
  }

  function explosion(pos, vel, speed) {
    var Pt = P(); if (!Pt) return;
    var k = M.clamp(0.55 + (speed || 30) / 80, 0.55, 1.4);
    var vx = vel ? vel[0] : 0, vy = vel ? vel[1] : 0, vz = vel ? vel[2] : 0;
    // flash
    Pt.emit('explosion', pos, null, 1, clearOpts(optsA));
    optsA.size = 11 * k; optsA.life = 0.35; optsA.heat = 1; optsA.spread = 0; optsA.grow = 1.8;
    Pt.emit('explosion', pos, null, 1, optsA);
    // fireball
    v3.set(tV, vx * 0.12, vy * 0.05 + 3, vz * 0.12);
    clearOpts(optsA); optsA.spread = 13 * k; optsA.size = 3.6 * k; optsA.posSpread = 2;
    Pt.emit('explosion', pos, tV, Math.round(34 * k), optsA);
    // sparks and debris thrown forward along the direction of travel
    v3.set(tV, vx * 0.25, Math.max(vy * 0.1, 0) + 7, vz * 0.25);
    clearOpts(optsA); optsA.spread = 26 * k;
    Pt.emit('spark', pos, tV, Math.round(90 * k), optsA);
    v3.set(tV, vx * 0.3, Math.max(vy * 0.1, 0) + 9, vz * 0.3);
    clearOpts(optsA); optsA.spread = 13 * k;
    Pt.emit('debris', pos, tV, Math.round(40 * k), optsA);
    // first dark billow
    v3.set(tV, vx * 0.05, 4, vz * 0.05);
    clearOpts(optsA); optsA.color = SOOT; optsA.colorEnd = SOOT_END;
    optsA.size = 3.2 * k; optsA.grow = 4; optsA.life = 7; optsA.alpha = 0.7; optsA.spread = 5; optsA.posSpread = 3;
    Pt.emit('smoke', pos, tV, 14, optsA);
  }

  function waterSplash(pos, vel, speed) {
    var Pt = P(); if (!Pt) return;
    var k = M.clamp(0.6 + (speed || 30) / 70, 0.6, 1.5);
    v3.set(tP, pos[0], C.water.level + 0.3, pos[2]);
    var vx = vel ? vel[0] : 0, vz = vel ? vel[2] : 0;
    // central column in layers of rising speed (a tall plume, not a ball) + wide crown
    for (var layer = 0; layer < 4; layer++) {
      v3.set(tV, vx * 0.12, (9 + layer * 6) * k, vz * 0.12);
      clearOpts(optsA); optsA.spread = (6 - layer) * k; optsA.size = 0.8 - layer * 0.1; optsA.life = 1.6 + layer * 0.35;
      Pt.emit('splash', tP, tV, Math.round(34 * k), optsA);
    }
    for (var i = 0; i < 48; i++) {
      var a = (i / 48) * Math.PI * 2;
      var c = Math.cos(a), s = Math.sin(a);
      v3.set(tA, tP[0] + c * 3, tP[1], tP[2] + s * 3);
      v3.set(tV, c * 9 * k + vx * 0.1, rand(7, 12) * k, s * 9 * k + vz * 0.1);
      clearOpts(optsA); optsA.spread = 1.5; optsA.size = 0.7;
      Pt.emit('splash', tA, tV, 1, optsA);
    }
    // lingering mist
    v3.set(tV, vx * 0.05, 2.5, vz * 0.05);
    clearOpts(optsA); optsA.color = MIST; optsA.colorEnd = MIST_END;
    optsA.size = 3; optsA.grow = 4; optsA.life = 4; optsA.alpha = 0.4; optsA.spread = 4; optsA.posSpread = 4;
    Pt.emit('smoke', tP, tV, 24, optsA);
  }

  function startFire(x, y, z, strength) {
    var f = null, oldest = null;
    for (var i = 0; i < fires.length; i++) {
      if (!fires[i].active) { f = fires[i]; break; }
      if (!oldest || fires[i].t > oldest.t) oldest = fires[i];
    }
    f = f || oldest;
    f.active = true; f.x = x; f.y = y; f.z = z; f.t = 0; f.dur = 32; f.strength = strength;
    f.fAcc = 0; f.sAcc = 0; f.bAcc = 0;
  }

  function updateFires(dt, night) {
    var Pt = P(); if (!Pt) return;
    for (var i = 0; i < fires.length; i++) {
      var f = fires[i];
      if (!f.active) continue;
      f.t += dt;
      var lf = f.t / f.dur;
      if (lf >= 1) { f.active = false; continue; }
      var inten = f.strength * (1 - M.smoothstep(0.45, 1, lf));
      // secondary blasts in the first moment
      if (f.t < 0.7) {
        f.bAcc += dt * 30;
        while (f.bAcc >= 1) {
          f.bAcc -= 1;
          v3.set(tP, f.x + rand(-4, 4), f.y + rand(1, 5), f.z + rand(-4, 4));
          v3.set(tV, 0, 5, 0);
          clearOpts(optsB); optsB.size = 3.2 * f.strength; optsB.spread = 6;
          Pt.emit('explosion', tP, tV, 1, optsB);
        }
      }
      // flames
      f.fAcc += dt * 40 * inten;
      while (f.fAcc >= 1) {
        f.fAcc -= 1;
        var a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * 3.2 * (0.5 + 0.5 * inten);
        v3.set(tP, f.x + Math.cos(a) * r, f.y + 0.4, f.z + Math.sin(a) * r);
        v3.set(tV, 0, rand(1, 3), 0);
        clearOpts(optsB); optsB.size = rand(1.3, 2.3) * (0.5 + 0.6 * inten); optsB.heat = rand(0.75, 1.0);
        Pt.emit('fire', tP, tV, 1, optsB);
      }
      // smoke column: dark, rising fast, spreading and drifting with the wind
      f.sAcc += dt * 6.5 * (0.35 + inten);
      while (f.sAcc >= 1) {
        f.sAcc -= 1;
        v3.set(tP, f.x + rand(-1.5, 1.5), f.y + 2.5, f.z + rand(-1.5, 1.5));
        v3.set(tV, 0, rand(6, 9) * (0.6 + 0.4 * inten), 0);
        clearOpts(optsB);
        var dark = 0.13 + 0.12 * (1 - inten);
        if (night > 0.3) {
          // at night the base of the column is lit from below by the flames
          optsB.color = FIRELIT; optsB.glow = 1.6 * night * inten;
        } else {
          tRGB[0] = dark; tRGB[1] = dark * 0.97; tRGB[2] = dark * 0.95;
          optsB.color = tRGB;
        }
        optsB.colorEnd = PLUME_END;
        // hot plume: low drag + strong buoyancy -> a tall column that leans with the wind
        optsB.drag = 0.22; optsB.gravity = -1.3;
        optsB.size = 2.0; optsB.grow = 6; optsB.life = rand(11, 15); optsB.alpha = 0.6; optsB.spread = 1.0;
        Pt.emit('smoke', tP, tV, 1, optsB);
      }
    }
  }

  // ------------------------------------------------------------------ fireworks
  function scheduleShow(n, duration, cx, cz) {
    var k = 0;
    for (var i = 0; i < launches.length && k < n; i++) {
      var L = launches[i];
      if (L.active) continue;
      L.active = true;
      L.at = time + (k / Math.max(1, n - 1)) * duration + rand(0, 0.25);
      L.x = cx + rand(-60, 60);
      L.z = cz + rand(-260, 260);
      k++;
    }
  }

  function showCenter(out) {
    // over the grass west of the runway, abeam the aircraft (clamped to the field)
    var r = C.airfield.runway;
    var z = lastPlane && finiteV(lastPlane.pos) ? lastPlane.pos[2] : r.cz;
    out[0] = r.cx - 150;
    out[2] = M.clamp(z, r.cz - r.length * 0.35, r.cz + r.length * 0.35);
    return out;
  }

  function launchShell(x, z) {
    for (var i = 0; i < shells.length; i++) {
      var s = shells[i];
      if (s.active) continue;
      s.active = true;
      v3.set(s.pos, x, groundY(x, z) + 1, z);
      v3.set(s.vel, rand(-4, 4), rand(60, 72), rand(-4, 4));
      s.fuse = rand(2.3, 3.0);
      s.kind = Math.floor(Math.random() * 4);
      s.c1 = Math.floor(Math.random() * FW_COLORS.length);
      s.c2 = (s.c1 + 1 + Math.floor(Math.random() * (FW_COLORS.length - 1))) % FW_COLORS.length;
      s.tAcc = 0;
      return;
    }
  }

  function burst(s) {
    var Pt = P(); if (!Pt) return;
    var c1 = FW_COLORS[s.c1], c2 = FW_COLORS[s.c2];
    var i, n, sp;
    // flash
    clearOpts(optsA); optsA.size = 9; optsA.life = 0.3; optsA.spread = 0; optsA.color = c1; optsA.colorEnd = WHITE;
    Pt.emit('sparkle', s.pos, null, 1, optsA);
    if (s.kind === 0) {             // peony
      n = 110;
      clearOpts(optsA); optsA.color = c1; optsA.colorEnd = c2; optsA.spread = 0;
      for (i = 0; i < n; i++) { randomUnit(tU); sp = rand(30, 34); v3.scale(tV, tU, sp); v3.scaleAndAdd(tV, tV, s.vel, 0.3); Pt.emit('firework', s.pos, tV, 1, optsA); }
    } else if (s.kind === 1) {      // ring + core
      randomUnit(tW); if (Math.abs(tW[1]) < 0.4) { tW[1] = 0.8; v3.normalize(tW, tW); }
      v3.cross(tA, tW, Math.abs(tW[0]) < 0.9 ? AXIS_X : AXIS_Z); v3.normalize(tA, tA);
      v3.cross(tB, tW, tA);
      clearOpts(optsA); optsA.color = c1; optsA.colorEnd = c1; optsA.spread = 0.6;
      n = 64;
      for (i = 0; i < n; i++) {
        var a = (i / n) * Math.PI * 2;
        v3.scale(tV, tA, Math.cos(a) * 36); v3.scaleAndAdd(tV, tV, tB, Math.sin(a) * 36);
        Pt.emit('firework', s.pos, tV, 1, optsA);
      }
      clearOpts(optsA); optsA.color = c2; optsA.colorEnd = WHITE; optsA.spread = 0;
      for (i = 0; i < 36; i++) { randomUnit(tU); v3.scale(tV, tU, rand(8, 12)); Pt.emit('firework', s.pos, tV, 1, optsA); }
    } else if (s.kind === 2) {      // golden willow: long, drooping
      clearOpts(optsA); optsA.color = GOLD; optsA.colorEnd = EMBER; optsA.spread = 0; optsA.life = 3.4;
      for (i = 0; i < 90; i++) { randomUnit(tU); v3.scale(tV, tU, rand(22, 26)); Pt.emit('firework', s.pos, tV, 1, optsA); }
    } else {                        // two-tone chrysanthemum
      clearOpts(optsA); optsA.color = c1; optsA.colorEnd = c1; optsA.spread = 0;
      for (i = 0; i < 60; i++) { randomUnit(tU); v3.scale(tV, tU, rand(32, 36)); Pt.emit('firework', s.pos, tV, 1, optsA); }
      clearOpts(optsA); optsA.color = c2; optsA.colorEnd = WHITE; optsA.spread = 0;
      for (i = 0; i < 50; i++) { randomUnit(tU); v3.scale(tV, tU, rand(16, 19)); Pt.emit('firework', s.pos, tV, 1, optsA); }
    }
  }

  function updateFireworks(dt) {
    var Pt = P();
    for (var i = 0; i < launches.length; i++) {
      var L = launches[i];
      if (L.active && time >= L.at) { L.active = false; launchShell(L.x, L.z); }
    }
    for (i = 0; i < shells.length; i++) {
      var s = shells[i];
      if (!s.active) continue;
      s.vel[1] -= 9.81 * dt;
      v3.scaleAndAdd(s.pos, s.pos, s.vel, dt);
      s.fuse -= dt;
      if (Pt) {
        s.tAcc += dt;
        while (s.tAcc > 0.018) {
          s.tAcc -= 0.018;
          v3.set(tV, s.vel[0] * 0.05, -2, s.vel[2] * 0.05);
          clearOpts(optsB); optsB.color = GOLD; optsB.size = 0.35; optsB.spread = 1.2;
          Pt.emit('trail', s.pos, tV, 1, optsB);
        }
      }
      if (s.fuse <= 0) { s.active = false; burst(s); }
    }
  }

  // ------------------------------------------------------------------ event handlers
  function onCrash(d) {
    var pos = finiteV(d.pos) ? d.pos : (lastPlane && finiteV(lastPlane.pos) ? lastPlane.pos : null);
    if (!pos) return;
    var vel = finiteV(d.vel) ? d.vel : null;
    var W = RL.World;
    var wet = d.reason === 'water' || (W && W.isWater(pos[0], pos[2]) && pos[1] < C.water.level + 6);
    if (wet) { waterSplash(pos, vel, d.speed); return; }
    explosion(pos, vel, d.speed);
    var gy = groundY(pos[0], pos[2]);
    if (gy < C.water.level) return;       // wreck sinks: no fire on the lake
    startFire(pos[0], gy, pos[2], M.clamp(0.6 + (d.speed || 30) / 90, 0.6, 1.2));
  }

  function wheelPuffs(type, n, opts, plane, groundedY) {
    var Pt = P(); if (!Pt || !plane) return;
    var pts = points();
    for (var w = 1; w <= 2; w++) {
      toWorld(tA, plane, pts.wheels[w]);
      if (groundedY !== undefined) tA[1] = groundedY + 0.25;
      v3.scale(tV, plane.vel, 0.28);
      tV[1] = 0.6;
      Pt.emit(type, tA, tV, n, opts);
    }
  }

  function onTouchdown(d) {
    var plane = lastPlane;
    if (!plane || !finiteV(plane.pos)) return;
    var vs = Math.max(0, +d.verticalSpeed || 0);
    var speed = +d.speed || plane.groundSpeed || 0;
    if (speed < 8) return;
    var gy = groundY(plane.pos[0], plane.pos[2]);
    var n = Math.round(M.clamp(3 + vs * 7 + speed * 0.05, 3, 24));
    if (d.surface === 'grass' || d.surface === 'rough') {
      clearOpts(optsA); optsA.spread = 2.5;
      wheelPuffs('dust', n + 4, optsA, plane, gy);
    } else if (d.surface !== 'water') {
      clearOpts(optsA); optsA.spread = 1.2 + vs * 0.6; optsA.size = 0.4 + vs * 0.12;
      wheelPuffs('tireSmoke', n, optsA, plane, gy);
    }
  }

  function onBounce(d) {
    var plane = lastPlane;
    if (!plane || !finiteV(plane.pos)) return;
    var gy = groundY(plane.pos[0], plane.pos[2]);
    var s = RL.World ? RL.World.surfaceAt(plane.pos[0], plane.pos[2]) : 'runway';
    clearOpts(optsA); optsA.spread = 1.6;
    wheelPuffs(s === 'grass' || s === 'rough' ? 'dust' : 'tireSmoke', 5, optsA, plane, gy);
  }

  function onRing(d) {
    var Pt = P(); if (!Pt) return;
    var ring = RL.Rings && RL.Rings.list && RL.Rings.list[d.index];
    var pos = ring && finiteV(ring.pos) ? ring.pos : (finiteV(d.pos) ? d.pos : null);
    if (!pos) return;
    var radius = ring && ring.radius ? ring.radius : C.ringRadius;
    if (ring && finiteV(ring.dir)) v3.copy(tW, ring.dir);
    else if (lastPlane && lastPlane.forward) v3.copy(tW, lastPlane.forward);
    else v3.set(tW, 0, 0, -1);
    v3.normalize(tW, tW);
    v3.cross(tA, tW, Math.abs(tW[1]) < 0.95 ? AXIS_Y : AXIS_X); v3.normalize(tA, tA);
    v3.cross(tB, tA, tW);
    var special = !!d.special;
    var n = special ? 110 : 56;
    var carry = lastPlane && lastPlane.vel ? 0.12 : 0;
    for (var i = 0; i < n; i++) {
      var a = (i / n) * Math.PI * 2 + rand(-0.03, 0.03);
      var c = Math.cos(a), s = Math.sin(a);
      tP[0] = pos[0] + (tA[0] * c + tB[0] * s) * radius;
      tP[1] = pos[1] + (tA[1] * c + tB[1] * s) * radius;
      tP[2] = pos[2] + (tA[2] * c + tB[2] * s) * radius;
      var out = rand(5, 11);
      tV[0] = (tA[0] * c + tB[0] * s) * out + (carry ? lastPlane.vel[0] * carry : 0);
      tV[1] = (tA[1] * c + tB[1] * s) * out + (carry ? lastPlane.vel[1] * carry : 0);
      tV[2] = (tA[2] * c + tB[2] * s) * out + (carry ? lastPlane.vel[2] * carry : 0);
      clearOpts(optsA); optsA.spread = 1.5; optsA.size = 1.5;
      if (special) { optsA.color = hsv(i / n, 0.7, 1, tRGB); optsA.colorEnd = WHITE; optsA.size = 1.9; }
      Pt.emit('sparkle', tP, tV, 1, optsA);
    }
    if (special && d.special === 'final') scheduleShow(4, 2.5, showCenter(tC)[0], tC[2]);
  }

  function onStunt() {
    var Pt = P(), plane = lastPlane;
    if (!Pt || !plane || !finiteV(plane.pos)) return;
    v3.scale(tV, plane.vel, 0.6);
    clearOpts(optsA); optsA.spread = 7; optsA.posSpread = 3; optsA.size = 0.8;
    Pt.emit('sparkle', plane.pos, tV, 28, optsA);
  }

  function onCourseComplete() {
    showCenter(tC);
    scheduleShow(18, 11, tC[0], tC[2]);
  }

  function onLanding(d) {
    if (d && d.grade === 'perfect') { showCenter(tC); scheduleShow(7, 3.5, tC[0], tC[2]); }
  }

  // ------------------------------------------------------------------ continuous emitters
  function emitContinuous(dt, plane, controls, gameState, night) {
    var Pt = P(); if (!Pt) return;
    var W = RL.World;
    var pts = points();
    var alive = !plane.crashed && gameState !== 'crashed';
    var pos = plane.pos, vel = plane.vel;

    // nozzle / wingtip / exhaust world positions this frame
    toWorld(tA, plane, pts.smoke);
    toWorld(tB, plane, pts.wingtipL);
    toWorld(tC, plane, pts.wingtipR);
    toWorld(tP, plane, pts.exhaust);
    if (!prevValid || v3.dist(tA, prevSmoke) > 60) {
      v3.copy(prevSmoke, tA); v3.copy(prevTipL, tB); v3.copy(prevTipR, tC); v3.copy(prevExh, tP);
      distSmoke = distVaporL = distVaporR = 0;
      prevValid = true;
    }
    if (!alive) {
      v3.copy(prevSmoke, tA); v3.copy(prevTipL, tB); v3.copy(prevTipR, tC); v3.copy(prevExh, tP);
      return;
    }

    var rpm = plane.rpm !== undefined ? plane.rpm : plane.throttle || 0;
    var speed = v3.length(vel);

    // ---- exhaust: short grey wisps from both stacks, denser at high power
    if (rpm > 0.05) {
      acc.exhaust += dt * (8 + 38 * rpm);
      var nEx = Math.floor(acc.exhaust);
      acc.exhaust -= nEx;
      clearOpts(optsA);
      optsA.alpha = 0.16 + 0.24 * rpm;
      exhL[0] = -pts.exhaust[0]; exhL[1] = pts.exhaust[1]; exhL[2] = pts.exhaust[2];
      toWorld(tW, plane, exhL);
      v3.sub(tW, tW, tP);                    // offset from the right stack to the left one
      for (var k = 0; k < nEx; k++) {
        var f = (k + Math.random()) / nEx;
        v3.lerp(tU, prevExh, tP, f);
        if (k & 1) v3.add(tU, tU, tW);       // alternate stacks
        v3.scale(tV, vel, 0.85);
        tV[0] -= plane.up[0] * 1.2; tV[1] -= plane.up[1] * 1.2; tV[2] -= plane.up[2] * 1.2;
        Pt.emit('exhaust', tU, tV, 1, optsA);
      }
    }

    // ---- skywriting smoke: distance-spaced puffs so lines stay continuous at any speed
    var smoking = gameState === 'playing' && (!!(controls && controls.smoke) || !!plane.smoke);
    var seg = v3.dist(prevSmoke, tA);
    if (smoking) {
      var spacing = 1.15;
      distSmoke += seg;
      acc.smokeT += dt * 6;                  // a few puffs per second even when parked
      var nS = Math.floor(distSmoke / spacing);
      if (nS < 1 && acc.smokeT >= 1) nS = 1;
      if (nS > 0) {
        acc.smokeT = 0;
        distSmoke -= nS * spacing;
        if (distSmoke < 0) distSmoke = 0;
        nS = Math.min(nS, 40);
        var entry = SMOKE_COLORS[smokeIdx];
        clearOpts(optsA);
        optsA.glow = night * 0.45;
        for (k = 0; k < nS; k++) {
          f = (k + 1) / nS;
          v3.lerp(tU, prevSmoke, tA, f);
          if (entry.rgb) optsA.color = entry.rgb;
          else optsA.color = hsv(time * 0.12 + k * 0.004, 0.72, 1.0, tRGB);
          v3.scale(tV, vel, 0.08);
          Pt.emit('skywrite', tU, tV, 1, optsA);
        }
      }
    } else {
      distSmoke = 0;
      acc.smokeT = 0;
    }

    // ---- wingtip vapour: high g, or high AoA in the humid dawn air
    var g = plane.gForce || 1;
    var humid = RL.Atmosphere && RL.Atmosphere.name === 'dawn';
    var aoa = Math.abs(plane.aoa || 0);
    var iv = M.smoothstep(3.3, 5.0, g);
    if (humid) iv = Math.max(iv, M.smoothstep(2.2, 3.2, g), M.smoothstep(9 * DEG, 14 * DEG, aoa) * M.smoothstep(30, 45, speed));
    if (plane.onGround) iv = 0;
    if (iv > 0.02) {
      clearOpts(optsA); optsA.alpha = 0.34 * iv; optsA.inherit = 0.25;
      distVaporL += v3.dist(prevTipL, tB);
      distVaporR += v3.dist(prevTipR, tC);
      var nL = Math.min(Math.floor(distVaporL / 0.7), 60), nR = Math.min(Math.floor(distVaporR / 0.7), 60);
      distVaporL -= nL * 0.7; distVaporR -= nR * 0.7;
      for (k = 0; k < nL; k++) { v3.lerp(tU, prevTipL, tB, (k + 1) / nL); Pt.emit('vapor', tU, vel, 1, optsA); }
      for (k = 0; k < nR; k++) { v3.lerp(tU, prevTipR, tC, (k + 1) / nR); Pt.emit('vapor', tU, vel, 1, optsA); }
    } else {
      distVaporL = distVaporR = 0;
    }

    // ---- ground: dust from the wheels on grass, prop wash over grass
    if (W) {
      var surf = plane.onGround || plane.agl < 4 ? W.surfaceAt(pos[0], pos[2]) : '';
      var soft = surf === 'grass' || surf === 'rough';
      var gs = plane.groundSpeed !== undefined ? plane.groundSpeed : speed;
      if (plane.onGround && soft && gs > 4) {
        acc.dust += dt * Math.min(gs, 40) * 0.8;
        var nD = Math.floor(acc.dust); acc.dust -= nD;
        clearOpts(optsA); optsA.alpha = 0.3; optsA.color = GRASS_DUST; optsA.colorEnd = GRASS_DUST_END;
        var gy = W.heightAt(pos[0], pos[2]);
        for (k = 0; k < nD; k++) {
          toWorld(tU, plane, pts.wheels[1 + (k & 1)]);
          tU[1] = gy + 0.3;
          v3.scale(tV, vel, 0.25); tV[1] = rand(0.5, 1.5);
          Pt.emit('dust', tU, tV, 1, optsA);
        }
      }
      if (soft && plane.agl < 3.5 && rpm > 0.45) {
        acc.wash += dt * (rpm - 0.4) * 22;
        var nW = Math.floor(acc.wash); acc.wash -= nW;
        clearOpts(optsA); optsA.alpha = 0.28; optsA.spread = 2.5;
        gy = W.heightAt(pos[0], pos[2]);
        for (k = 0; k < nW; k++) {
          v3.scaleAndAdd(tU, pos, plane.forward, -rand(3, 7));
          tU[1] = gy + 0.3;
          v3.scale(tV, plane.forward, -rand(5, 9)); tV[1] = 0.8;
          Pt.emit('dust', tU, tV, 1, optsA);
        }
      }

      // ---- rooster tail when skimming the lake
      if (!plane.onGround && speed > 20 && plane.agl < 7 && W.isWater(pos[0], pos[2])) {
        var ks = Math.pow(1 - M.saturate(plane.agl / 7), 1.5) * M.smoothstep(20, 45, speed);
        var hx = vel[0], hz = vel[2], hl = Math.sqrt(hx * hx + hz * hz) || 1;
        hx /= hl; hz /= hl;
        acc.spray += dt * 240 * ks;
        var nSp = Math.floor(acc.spray); acc.spray -= nSp;
        clearOpts(optsA); optsA.spread = 1.6; optsA.size = 0.32; optsA.grow = 2.5; optsA.life = 1.4;
        for (k = 0; k < nSp; k++) {
          var back = rand(2, 7);
          v3.set(tU, pos[0] - hx * back + rand(-0.6, 0.6), C.water.level + 0.2, pos[2] - hz * back + rand(-0.6, 0.6));
          // a fan thrown up and back: the "rooster tail" of a hull skimming the surface
          v3.set(tV, vel[0] * rand(0.35, 0.7), rand(7, 15) * (0.45 + ks), vel[2] * rand(0.35, 0.7));
          Pt.emit('splash', tU, tV, 1, optsA);
        }
        acc.mist += dt * 16 * ks;
        var nM = Math.floor(acc.mist); acc.mist -= nM;
        clearOpts(optsA);
        optsA.color = MIST; optsA.colorEnd = MIST_END;
        optsA.size = 1.2; optsA.grow = 4; optsA.life = 2.0; optsA.alpha = 0.2; optsA.spread = 1.5;
        for (k = 0; k < nM; k++) {
          v3.set(tU, pos[0] - hx * 6, C.water.level + 1.2, pos[2] - hz * 6);
          v3.set(tV, vel[0] * 0.35, 2.5, vel[2] * 0.35);
          Pt.emit('smoke', tU, tV, 1, optsA);
        }
      }
    }

    v3.copy(prevSmoke, tA); v3.copy(prevTipL, tB); v3.copy(prevTipR, tC); v3.copy(prevExh, tP);
  }

  // ------------------------------------------------------------------ birds
  var BIRD_STRIDE = 12;
  var birds = [];
  var birdInst = null, birdMesh = null, birdProg = null, birdCount = 0, birdsReady = false;
  var glide = { phi: 0, y: 0, init: false };
  var BIRD_VS = [
    'layout(location = 0) in vec3 a_position;',
    'layout(location = 1) in vec3 a_normal;',
    'layout(location = 2) in vec4 a_color;',
    'layout(location = 3) in vec2 a_uv;',       // x: 1 = wing vertex (flaps)
    'layout(location = 4) in vec4 i_pos;',      // xyz, scale
    'layout(location = 5) in vec4 i_rot;',      // heading, bank, pitch, flap phase
    'layout(location = 6) in vec4 i_flap;',     // flap frequency (rad/s), flapping 0..1, goose tint
    'out vec3 v_world;',
    'out vec3 v_normal;',
    'out vec3 v_color;',
    'vec3 rotZ(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(v.x * c - v.y * s, v.x * s + v.y * c, v.z); }',
    'vec3 rotX(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(v.x, v.y * c - v.z * s, v.y * s + v.z * c); }',
    'vec3 rotY(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(v.x * c + v.z * s, v.y, -v.x * s + v.z * c); }',
    'void main() {',
    '  vec3 p = a_position;',
    '  vec3 n = a_normal;',
    '  if (a_uv.x > 0.5) {',
    '    float side = p.x < 0.0 ? -1.0 : 1.0;',
    '    float beat = sin(u_time * i_flap.x + i_rot.w);',
    '    float ang = mix(0.12, 0.62 * beat + 0.1, i_flap.y);',
    '    // outer wing lags behind the inner wing a little for a softer stroke',
    '    float ax = abs(p.x) - 0.1;',
    '    float bend = ang + 0.25 * i_flap.y * sin(u_time * i_flap.x + i_rot.w - 0.9) * smoothstep(0.4, 1.1, ax);',
    '    float c = cos(bend), s = sin(bend);',
    '    p.x = side * (0.1 + ax * c);',
    '    p.y += ax * s;',
    '    n = rotZ(n, side * bend);',
    '  }',
    '  // keep far flocks legible: grow birds so the wingspan stays >= ~14 px (up to 5x)',
    '  float dist = max(length(i_pos.xyz - u_camPos), 1.0);',
    '  float spanPx = 2.2 * i_pos.w * u_proj[1][1] * u_resolution.y * 0.5 / dist;',
    '  p *= i_pos.w * clamp(14.0 / max(spanPx, 1e-3), 1.0, 5.0);',
    '  p = rotY(rotX(rotZ(p, -i_rot.y), i_rot.z), -i_rot.x);',
    '  n = rotY(rotX(rotZ(n, -i_rot.y), i_rot.z), -i_rot.x);',
    '  v_world = i_pos.xyz + p;',
    '  v_normal = n;',
    '  vec3 goose = mix(vec3(dot(a_color.rgb, vec3(0.3, 0.5, 0.2))), a_color.rgb, 0.25) * 1.35;',
    '  v_color = mix(a_color.rgb, goose, i_flap.z);',
    '  gl_Position = u_viewProj * vec4(v_world, 1.0);',
    '}'
  ].join('\n');
  var BIRD_FS = [
    'in vec3 v_world;',
    'in vec3 v_normal;',
    'in vec3 v_color;',
    'out vec4 outColor;',
    'void main() {',
    '  vec3 N = normalize(v_normal);',
    '  if (!gl_FrontFacing) N = -N;',
    '  vec3 alb = toLinear(v_color);',
    '  vec3 c = shadeLit(alb, N, v_world, shadowFactor(v_world, N), 0.05, 12.0);',
    '  c = applyFog(c, v_world);',
    '  outColor = vec4(finalColor(c), 1.0);',
    '}'
  ].join('\n');

  function buildBirdGeo() {
    var pos = [], nrm = [], col = [], uv = [];
    function tri(a, b, c, ca, cb, cc, wing) {
      var ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      var wx = c[0] - a[0], wy = c[1] - a[1], wz = c[2] - a[2];
      var nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      var l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      var verts = [a, b, c], cols = [ca, cb, cc];
      for (var i = 0; i < 3; i++) {
        pos.push(verts[i][0], verts[i][1], verts[i][2]);
        nrm.push(nx / l, ny / l, nz / l);
        col.push(cols[i][0], cols[i][1], cols[i][2]);
        uv.push(wing ? 1 : 0, 0);
      }
    }
    var body = [0.3, 0.23, 0.17], belly = [0.55, 0.48, 0.38], head = [0.92, 0.9, 0.84], beak = [0.95, 0.72, 0.2];
    var wingC = [0.36, 0.28, 0.2], tipC = [0.12, 0.1, 0.09], tail = [0.9, 0.88, 0.82];
    // body: diamond cross-section from beak to tail
    var nose = [0, 0.01, -0.55], neckT = [0, 0.09, -0.3], midT = [0, 0.1, -0.05], midB = [0, -0.09, -0.05];
    var midL = [-0.11, 0, -0.05], midR = [0.11, 0, -0.05], tailP = [0, 0.02, 0.38];
    tri(nose, midL, neckT, beak, body, head);
    tri(nose, neckT, midR, beak, head, body);
    tri(neckT, midL, midT, head, body, body);
    tri(neckT, midT, midR, head, body, body);
    tri(nose, midB, midL, beak, belly, body);
    tri(nose, midR, midB, beak, body, belly);
    tri(midT, midL, tailP, body, body, body);
    tri(midT, tailP, midR, body, body, body);
    tri(midB, tailP, midL, belly, body, body);
    tri(midB, midR, tailP, belly, body, body);
    // tail fan (flat; double-sided in the shader)
    tri([0, 0.02, 0.25], [-0.2, 0.02, 0.6], [0.2, 0.02, 0.6], body, tail, tail);
    // wings: inner panel + fingered outer panel, mirrored
    for (var s = -1; s <= 1; s += 2) {
      var rootL = [0.08 * s, 0.03, -0.2], rootT = [0.08 * s, 0.03, 0.2];
      var midLE = [0.62 * s, 0.05, -0.22], midTE = [0.62 * s, 0.05, 0.24];
      var tip = [1.12 * s, 0.07, 0.1], tip2 = [1.02 * s, 0.07, 0.28];
      if (s > 0) {
        tri(rootL, midLE, rootT, wingC, wingC, wingC, true);
        tri(rootT, midLE, midTE, wingC, wingC, wingC, true);
        tri(midLE, tip, midTE, wingC, tipC, wingC, true);
        tri(midTE, tip, tip2, wingC, tipC, tipC, true);
      } else {
        tri(rootL, rootT, midLE, wingC, wingC, wingC, true);
        tri(rootT, midTE, midLE, wingC, wingC, wingC, true);
        tri(midLE, midTE, tip, wingC, wingC, tipC, true);
        tri(midTE, tip2, tip, wingC, tipC, tipC, true);
      }
    }
    return { positions: pos, normals: nrm, colors: col, uvs: uv };
  }

  function initBirds() {
    birds.length = 0;
    var rng = M.rng(C.seed + 77);
    var th = C.thermals || [];
    for (var j = 0; j < th.length; j++) {
      var dir = rng() < 0.5 ? -1 : 1;
      var n = 6 + Math.floor(rng() * 3);
      for (var k = 0; k < n; k++) {
        var r = 35 + rng() * 75;
        var v = 10 + rng() * 3;
        birds.push({
          mode: 0, th: j, cx: th[j].x, cz: th[j].z, r: r, w: dir * v / r, ang: rng() * Math.PI * 2,
          alt: 110 + k * 42 + rng() * 30, bob: rng() * 6.28, scale: 0.85 + rng() * 0.35,
          phase: rng() * 6.28, freq: 9 + rng() * 3, flap: 0, flapTarget: 0,
          pos: v3.create(), flee: v3.create(), heading: 0, bank: 0, pitch: 0, gy: null
        });
      }
    }
    // a V of geese gliding up and down the valley
    for (var g = 0; g < 7; g++) {
      var row = Math.ceil(g / 2), side = g === 0 ? 0 : (g & 1 ? -1 : 1);
      birds.push({
        mode: 1, slot: [side * row * 5.5, -row * 0.6, row * 4.5], scale: 0.75, phase: rng() * 6.28,
        freq: 11 + rng() * 2, flap: 1, flapTarget: 1, pos: v3.create(), flee: v3.create(), heading: 0, bank: 0, pitch: 0
      });
    }
    birdCount = birds.length;
    birdInst = new Float32Array(Math.max(1, birdCount) * BIRD_STRIDE);
  }

  var GLIDE = { cx: -50, cz: -700, rx: 480, rz: 2500, speed: 15 };

  function updateBirds(dt, plane) {
    if (!birdCount) return;
    var W = RL.World;
    var hasPlane = plane && finiteV(plane.pos);
    // glide flock leader on an ellipse over the valley floor
    var phiRate = GLIDE.speed / ((GLIDE.rx + GLIDE.rz) * 0.5);
    glide.phi += phiRate * dt;
    var sx = Math.sin(glide.phi), cz = Math.cos(glide.phi);
    var lx = GLIDE.cx + GLIDE.rx * sx, lz = GLIDE.cz + GLIDE.rz * cz;
    var dlx = GLIDE.rx * Math.cos(glide.phi), dlz = -GLIDE.rz * Math.sin(glide.phi);
    var lh = Math.atan2(dlx, -dlz);
    var targetY = (W ? W.heightAt(lx, lz) : 50) + 170;
    if (!glide.init) { glide.y = targetY; glide.init = true; }
    glide.y = M.damp(glide.y, targetY, 0.3, dt);
    var ch = Math.cos(lh), shd = Math.sin(lh);   // heading basis: fwd = (sin h, -cos h), right = (cos h, sin h)

    for (var i = 0; i < birdCount; i++) {
      var b = birds[i];
      var x, y, z, hd, bank = 0, pitch = 0;
      if (b.mode === 0) {
        if (b.gy === null) b.gy = W ? Math.max(W.heightAt(b.cx, b.cz), C.water.level) : 50;
        b.ang += b.w * dt;
        b.bob += dt * 0.4;
        x = b.cx + Math.cos(b.ang) * b.r;
        z = b.cz + Math.sin(b.ang) * b.r;
        y = b.gy + b.alt + Math.sin(b.bob) * 6;
        var tvx = -Math.sin(b.ang) * b.w, tvz = Math.cos(b.ang) * b.w;
        hd = Math.atan2(tvx, -tvz);
        var v = Math.abs(b.w) * b.r;
        bank = (b.w > 0 ? 1 : -1) * Math.atan(v * Math.abs(b.w) / 9.81);
        b.flapTarget = Math.sin(time * 0.35 + b.phase) > 0.82 ? 1 : 0;   // occasional flaps, mostly soaring
      } else {
        var s = b.slot;
        x = lx + ch * s[0] - shd * s[2];
        z = lz + shd * s[0] + ch * s[2];
        y = glide.y + s[1] + Math.sin(time * 0.5 + b.phase) * 0.6;
        hd = lh;
        bank = -0.08;
        b.flapTarget = Math.sin(time * 0.6 + b.phase * 0.2) > -0.3 ? 1 : 0;
      }
      // scatter away from the aircraft
      if (hasPlane) {
        var dx = x + b.flee[0] - plane.pos[0], dy = y + b.flee[1] - plane.pos[1], dz = z + b.flee[2] - plane.pos[2];
        var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < 90 && d > 1e-3) {
          var push = (90 - d) / 90 * 55 * dt / d;
          b.flee[0] += dx * push; b.flee[1] += dy * push * 0.7; b.flee[2] += dz * push;
          b.flapTarget = 1;
          bank += M.clamp(dx * 0.02, -0.8, 0.8);
        }
      }
      var decay = Math.exp(-0.25 * dt);
      b.flee[0] *= decay; b.flee[1] *= decay; b.flee[2] *= decay;
      var fl = v3.length(b.flee);
      if (fl > 120) v3.scale(b.flee, b.flee, 120 / fl);
      b.flap = M.damp(b.flap, b.flapTarget, 2.5, dt);
      b.pos[0] = x + b.flee[0]; b.pos[1] = y + b.flee[1]; b.pos[2] = z + b.flee[2];
      b.heading = hd; b.bank = bank; b.pitch = pitch;

      var o = i * BIRD_STRIDE;
      birdInst[o] = b.pos[0]; birdInst[o + 1] = b.pos[1]; birdInst[o + 2] = b.pos[2]; birdInst[o + 3] = b.scale;
      birdInst[o + 4] = hd; birdInst[o + 5] = bank; birdInst[o + 6] = pitch; birdInst[o + 7] = b.phase;
      birdInst[o + 8] = b.freq; birdInst[o + 9] = b.flap; birdInst[o + 10] = b.mode; birdInst[o + 11] = 0;
    }
    birdsReady = true;
  }

  // ------------------------------------------------------------------ API
  var Effects = {
    SMOKE_COLORS: SMOKE_COLORS,
    /** Current skywriting colour label / sRGB (null for rainbow). */
    get smokeColor() { return SMOKE_COLORS[smokeIdx].label; },
    get smokeRGB() { return SMOKE_COLORS[smokeIdx].rgb; },
    birds: birds,

    init: function (glCtx) {
      gl = glCtx;
      var SL = RL.ShaderLib;
      initBirds();
      try {
        birdProg = RL.GL.createProgram(gl, SL.vertex(BIRD_VS), SL.fragment(BIRD_FS), 'birds');
        birdMesh = RL.GL.meshFromGeo(gl, buildBirdGeo(), {
          instances: {
            data: birdInst, stride: BIRD_STRIDE, usage: gl.DYNAMIC_DRAW,
            attribs: [{ loc: 4, size: 4, offset: 0 }, { loc: 5, size: 4, offset: 4 }, { loc: 6, size: 4, offset: 8 }]
          }
        });
      } catch (e) {
        birdProg = null; birdMesh = null;
        if (RL.errors) RL.errors.push('Effects birds: ' + (e && e.message));
      }
      if (!subs.length && RL.Events) {
        var E = RL.Events;
        subs.push(E.on('crash', onCrash), E.on('touchdown', onTouchdown), E.on('bounce', onBounce),
          E.on('ring', onRing), E.on('stunt', onStunt), E.on('courseComplete', onCourseComplete),
          E.on('landing', onLanding), E.on('respawn', function () { Effects.reset(); }));
      }
    },

    update: function (dt, plane, controls, gameState) {
      if (!(dt > 0)) return;
      dt = Math.min(dt, 0.1);
      time += dt;
      var night = RL.Atmosphere && RL.Atmosphere.params ? RL.Atmosphere.params.nightFactor || 0 : 0;
      if (plane && plane.quat && finiteV(plane.pos) && finiteV(plane.vel)) {
        lastPlane = plane;
        emitContinuous(dt, plane, controls, gameState, night);
      } else {
        prevValid = false;
      }
      updateFires(dt, night);
      updateFireworks(dt);
      updateBirds(dt, plane);
    },

    draw: function (frame) {
      if (!birdProg || !birdMesh || !birdsReady || !birdCount || !frame) return;
      if ((frame.nightFactor || 0) > 0.65) return;          // birds roost at night
      RL.GL.updateInstances(gl, birdMesh, birdInst, birdCount);
      RL.GL.use(gl, birdProg);
      RL.GL.applyFrame(gl, birdProg, frame);
      gl.disable(gl.CULL_FACE);
      RL.GL.drawMesh(gl, birdMesh, birdCount);
      RL.GL.resetState(gl);
    },

    cycleSmokeColor: function () {
      smokeIdx = (smokeIdx + 1) % SMOKE_COLORS.length;
      var c = SMOKE_COLORS[smokeIdx];
      if (RL.Events) RL.Events.emit('smokeColor', { name: c.name, label: c.label, color: c.rgb ? c.rgb.slice() : null, rainbow: !c.rgb });
      return c.label;
    },

    reset: function () {
      if (RL.Particles && RL.Particles.clear) RL.Particles.clear();
      for (var i = 0; i < fires.length; i++) fires[i].active = false;
      for (i = 0; i < shells.length; i++) shells[i].active = false;
      for (i = 0; i < launches.length; i++) launches[i].active = false;
      for (i = 0; i < birds.length; i++) v3.set(birds[i].flee, 0, 0, 0);
      acc.exhaust = acc.dust = acc.wash = acc.spray = acc.mist = acc.smokeT = 0;
      prevValid = false;
    },

    /** Test hook: launch a fireworks show now (n shells over `duration` s) near (x, z). */
    fireworks: function (n, duration, x, z) {
      if (x === undefined) { showCenter(tC); x = tC[0]; z = tC[2]; }
      scheduleShow(n || 10, duration || 6, x, z);
    }
  };

  RL.Effects = Effects;
})(window.RL = window.RL || {});
