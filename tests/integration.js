#!/usr/bin/env node
/*
 * Ridgeline end-to-end integration tests (headless Chromium + SwiftShader).
 *
 *   node tests/integration.js [--shots <dir>] [--only name,name] [--quality low|high]
 *
 * Scenarios run inside the page against the real modules via RL.debug.simulate (fixed-step,
 * no rendering), then screenshots are taken of interesting states. Exit code 1 on any failure.
 */
'use strict';
const path = require('path');
const fs = require('fs');
let playwright;
try { playwright = require('playwright'); }
catch (e) { playwright = require('/opt/node22/lib/node_modules/playwright'); }

const argv = process.argv.slice(2);
function arg(name, def) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; }
const shotsDir = arg('--shots', null);
const only = (arg('--only', '') || '').split(',').filter(Boolean);
const quality = arg('--quality', 'low');
if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });

const results = [];
function record(name, ok, details) {
  results.push({ name, ok, details });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (details ? ' — ' + details : ''));
}

async function newPage(browser, params) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const logs = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push('[' + m.type() + '] ' + m.text()); });
  page.on('pageerror', (e) => logs.push('[pageerror] ' + (e && e.stack || e)));
  const url = 'file://' + path.resolve(__dirname, '..', 'index.html') + '?' + params;
  await page.goto(url);
  await page.waitForFunction(() => window.RL && window.RL.ready === true, null, { timeout: 90000 });
  await page.waitForTimeout(300);
  return { page, logs };
}

// Shared in-page helpers installed once per page.
const HELPERS = `
window.T = {
  reset: function () {
    RL.debug.freeze = true;
    RL.Game.handleAction('reset');
    if (RL.Game.state !== 'playing') RL.Game.start();
    RL.debug.controls = null;
  },
  events: [],
  listen: function () {
    if (T._listening) return; T._listening = true;
    ['liftoff','touchdown','landing','bounce','crash','ring','courseComplete','stall','stunt'].forEach(function (t) {
      RL.Events.on(t, function (d) {
        var o = { type: t };
        for (var k in d) if (typeof d[k] !== 'object') o[k] = d[k];
        o.t = RL.Game.plane ? RL.Game.plane.time : 0;
        T.events.push(o);
      });
    });
  },
  step: function (controls, seconds, dt) {
    dt = dt || 1 / 60;
    RL.debug.simulate(seconds, controls, dt);
    return RL.debug.state();
  },
  // Takeoff by hand: full throttle, rotate at vRotate, climb to agl, then gear up.
  takeoff: function (targetAgl) {
    var p = RL.Game.plane, specs = RL.FlightModel.specs || { vRotate: 31 };
    var startZ = p.pos[2], liftoffZ = null, t = 0;
    while (t < 90) {
      var rot = p.airspeed > specs.vRotate ? 0.55 : 0;
      if (!p.onGround) rot = p.pitch > 12 ? 0 : 0.35;
      T.step({ throttle: 1, pitch: rot, roll: -p.roll * 0.02, yaw: 0, brake: 0, smoke: false }, 1 / 60);
      t += 1 / 60;
      if (liftoffZ === null && !p.onGround && p.agl > 1) liftoffZ = p.pos[2];
      if (p.crashed) return { crashed: true, reason: p.crashReason, t: t };
      if (p.agl > (targetAgl || 40)) break;
    }
    if (p.gearDown) RL.Game.handleAction('gear');
    return { roll: liftoffZ === null ? null : startZ - liftoffZ, t: t, agl: p.agl, airspeed: p.airspeed };
  }
};
T.listen();
`;

async function run() {
  const browser = await playwright.chromium.launch({
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
  });
  const { page, logs } = await newPage(browser, 'autostart&noaudio&quality=' + quality);
  await page.evaluate(HELPERS);
  const want = (n) => !only.length || only.includes(n);

  // ---------------------------------------------------------------- boot
  if (want('boot')) {
    const info = await page.evaluate(() => ({
      mods: ['Terrain', 'Water', 'Sky', 'Airfield', 'Rings', 'FlightModel', 'Aircraft', 'Autopilot',
        'Particles', 'Effects', 'Shadow', 'Input', 'CameraRig', 'Audio', 'Game', 'HUD', 'UI']
        .filter((m) => !window.RL[m]),
      terrainReady: !!(RL.Terrain && RL.Terrain.ready),
      state: RL.Game && RL.Game.state,
      errors: RL.errors.slice()
    }));
    record('boot: all modules present', info.mods.length === 0, info.mods.length ? 'missing ' + info.mods.join(',') : '');
    record('boot: terrain ready', info.terrainReady);
    record('boot: autostart -> playing', info.state === 'playing', 'state=' + info.state);
    record('boot: no errors', info.errors.length === 0, info.errors.join(' | '));
  }

  // ---------------------------------------------------------------- world sanity
  if (want('world')) {
    const w = await page.evaluate(() => {
      var C = RL.Config, r = C.airfield.runway, bad = [];
      for (var z = -r.length / 2; z <= r.length / 2; z += 100) {
        for (var x = -r.width / 2; x <= r.width / 2; x += 10) {
          var h = RL.World.heightAt(r.cx + x, r.cz + z);
          if (Math.abs(h - C.airfield.elevation) > 0.01) bad.push([x, z, h]);
        }
      }
      // water only in the lake
      var wet = 0, wetOutside = 0;
      for (var gx = -5800; gx <= 5800; gx += 100) for (var gz = -5800; gz <= 5800; gz += 100) {
        if (RL.World.isWater(gx, gz)) {
          wet++;
          var inLake = C.water.lakes.some(function (l) { return Math.hypot(gx - l.x, gz - l.z) < l.radius + 400; });
          if (!inLake) wetOutside++;
        }
      }
      // arch opening clear
      var a = RL.Terrain.arch, blocked = 0;
      if (a) for (var y = 5; y < a.openingHeight * 0.85; y += 5) {
        if (RL.World.pointHitsCollider([a.center[0], a.center[1] + y, a.center[2]])) blocked++;
      }
      return { runwayBad: bad.length, sample: bad.slice(0, 3), wet: wet, wetOutside: wetOutside, arch: !!a, archBlocked: blocked };
    });
    record('world: runway exactly flat', w.runwayBad === 0, JSON.stringify(w.sample));
    record('world: water only in lake', w.wet > 0 && w.wetOutside === 0, 'wet=' + w.wet + ' outside=' + w.wetOutside);
    record('world: arch opening clear', w.arch && w.archBlocked === 0, 'blocked=' + w.archBlocked);
  }

  // ---------------------------------------------------------------- parked
  if (want('parked')) {
    const s = await page.evaluate(() => {
      T.reset();
      var p = RL.Game.plane, z0 = p.pos[2], y0 = p.pos[1];
      T.step({ throttle: 0, pitch: 0, roll: 0, yaw: 0, brake: 0 }, 8);
      return { dz: Math.abs(p.pos[2] - z0), dy: Math.abs(p.pos[1] - y0), speed: p.groundSpeed, onGround: p.onGround, crashed: p.crashed, wheels: p.wheelsOnGround };
    });
    record('parked: stays put', s.dz < 0.05 && s.dy < 0.05 && s.speed < 0.05 && s.onGround && !s.crashed, JSON.stringify(s));
  }

  // ---------------------------------------------------------------- takeoff
  if (want('takeoff')) {
    const s = await page.evaluate(() => { T.reset(); return T.takeoff(40); });
    record('takeoff: liftoff roll 300-650 m', s.roll !== null && s.roll > 300 && s.roll < 650 && !s.crashed, JSON.stringify(s));
    if (shotsDir) {
      await page.evaluate(() => { RL.debug.freeze = false; });
      await page.waitForTimeout(1500);
      await page.screenshot({ path: path.join(shotsDir, 'takeoff-climb.png'), timeout: 180000 });
      await page.evaluate(() => { RL.debug.freeze = true; });
    }
  }

  // ---------------------------------------------------------------- performance envelope
  if (want('envelope')) {
    const e = await page.evaluate(() => {
      T.reset();
      // start well south so two minutes of northbound flight stays inside the map
      RL.debug.teleport(0, 900, 4500, 0, 60);
      var p = RL.Game.plane, out = {};
      if (p.gearDown) RL.Game.handleAction('gear');
      // level cruise at 75% throttle: hold altitude with a simple P loop on pitch
      function hold(throttle, seconds) {
        var alt = p.pos[1];
        for (var t = 0; t < seconds; t += 1 / 60) {
          var err = alt - p.pos[1];
          var pitchCmd = Math.max(-1, Math.min(1, err * 0.02 - p.verticalSpeed * 0.05));
          T.step({ throttle: throttle, pitch: pitchCmd, roll: -p.roll * 0.03, yaw: 0 }, 1 / 60);
        }
        return p.airspeed * 1.943844;
      }
      out.cruise75kt = hold(0.75, 60);
      out.maxkt = hold(1.0, 60);
      // roll rate at cruise
      RL.debug.teleport(0, 900, 0, 0, 62);
      var r0 = p.roll, maxRate = 0, prev = p.roll;
      for (var i = 0; i < 60; i++) {
        T.step({ throttle: 0.75, pitch: 0, roll: 1, yaw: 0 }, 1 / 60);
        var d = p.roll - prev; if (d < -180) d += 360; if (d > 180) d -= 360;
        maxRate = Math.max(maxRate, Math.abs(d) * 60); prev = p.roll;
      }
      out.rollRate = maxRate;
      // climb rate at full throttle ~70 kt
      RL.debug.teleport(0, 600, 0, 0, 36);
      var vs = 0, n = 0;
      for (var t2 = 0; t2 < 30; t2 += 1 / 60) {
        var spdErr = p.airspeed - 36;
        T.step({ throttle: 1, pitch: Math.max(-1, Math.min(1, spdErr * 0.08)), roll: -p.roll * 0.03, yaw: 0 }, 1 / 60);
        if (t2 > 15) { vs += p.verticalSpeed; n++; }
      }
      out.climbFpm = vs / n * 196.85;
      out.crashed = p.crashed;
      return out;
    });
    record('envelope: cruise 75% 105-145 kt', e.cruise75kt > 105 && e.cruise75kt < 145, e.cruise75kt.toFixed(0) + ' kt');
    record('envelope: max level 145-185 kt', e.maxkt > 145 && e.maxkt < 185, e.maxkt.toFixed(0) + ' kt');
    record('envelope: roll rate 120-240 deg/s', e.rollRate > 120 && e.rollRate < 240, e.rollRate.toFixed(0) + ' deg/s');
    record('envelope: climb 1100-2400 fpm', e.climbFpm > 1100 && e.climbFpm < 2400, e.climbFpm.toFixed(0) + ' fpm');
  }

  // ---------------------------------------------------------------- course via autopilot
  if (want('course')) {
    const c = await page.evaluate(() => {
      T.reset();
      T.events.length = 0;
      var to = T.takeoff(30);
      if (to.crashed) return { takeoff: to };
      var p = RL.Game.plane, t = 0, lastRing = RL.Rings.current, stuck = 0, log = [];
      while (t < 900 && !RL.Rings.complete && !p.crashed) {
        var ring = RL.Rings.getCurrent();
        if (!ring) break;
        var ctl = RL.Autopilot.fly(p, ring.pos, 1 / 60, { speed: 58, ring: ring });
        T.step(ctl, 1 / 60);
        t += 1 / 60;
        if (RL.Rings.current !== lastRing) { log.push({ ring: lastRing, t: +t.toFixed(1) }); lastRing = RL.Rings.current; stuck = 0; }
        else if ((stuck += 1 / 60) > 150) break;
      }
      return {
        takeoff: to, passed: RL.Rings.current, total: RL.Rings.total, complete: RL.Rings.complete,
        crashed: p.crashed, reason: p.crashReason, t: t, log: log,
        stuckAt: RL.Rings.current, pos: [p.pos[0], p.pos[1], p.pos[2]].map(Math.round),
        ringEvents: T.events.filter(function (e) { return e.type === 'ring'; }).length,
        complEvents: T.events.filter(function (e) { return e.type === 'courseComplete'; }).length
      };
    });
    record('course: autopilot completes all rings', c.complete && !c.crashed,
      `passed ${c.passed}/${c.total} crashed=${c.crashed} ${c.reason || ''} t=${c.t && c.t.toFixed(0)}s pos=${c.pos} log=${JSON.stringify(c.log)}`);
    record('course: ring + complete events', c.ringEvents === c.passed && (!c.complete || c.complEvents === 1), `ring=${c.ringEvents} complete=${c.complEvents}`);
  }

  // ---------------------------------------------------------------- landing
  if (want('landing')) {
    const l = await page.evaluate(() => {
      T.reset();
      T.events.length = 0;
      var C = RL.Config, r = C.airfield.runway;
      // 3-degree final: 1500 m south of the south threshold, heading north
      var thrZ = r.cz + r.length / 2, dist = 1500;
      RL.debug.teleport(r.cx, C.airfield.elevation + dist * Math.tan(3 * Math.PI / 180) + 3, thrZ + dist, 0, 38);
      var p = RL.Game.plane;
      if (!p.gearDown) RL.Game.handleAction('gear');
      RL.Game.handleAction('flaps'); RL.Game.handleAction('flaps');
      var t = 0;
      while (t < 120 && !p.crashed) {
        var aimZ = thrZ - 250;                          // aim point
        var d = Math.max(1, p.pos[2] - aimZ);
        var targetAlt = C.airfield.elevation + d * Math.tan(3 * Math.PI / 180);
        var agl = p.agl;
        var ctl = { throttle: 0.35, pitch: 0, roll: 0, yaw: 0, brake: 0 };
        if (!p.onGround) {
          var vsTarget = agl < 8 ? -0.8 : -Math.max(1.5, p.groundSpeed * 0.052);
          if (agl > 8) vsTarget += (targetAlt - p.pos[1]) * 0.15;
          ctl.pitch = Math.max(-1, Math.min(1, (vsTarget - p.verticalSpeed) * 0.12 + (agl < 8 ? 0.15 : 0)));
          ctl.throttle = agl < 8 ? 0 : Math.max(0.1, Math.min(0.8, 0.35 + (36 - p.airspeed) * 0.05));
          ctl.roll = Math.max(-1, Math.min(1, (-p.pos[0] * 0.02 - p.roll * 0.03)));
          ctl.yaw = Math.max(-1, Math.min(1, -p.pos[0] * 0.01));
        } else {
          ctl.throttle = 0; ctl.brake = p.groundSpeed < 25 ? 1 : 0.3; ctl.pitch = 0;
          ctl.yaw = Math.max(-1, Math.min(1, -p.pos[0] * 0.05));
        }
        T.step(ctl, 1 / 60);
        t += 1 / 60;
        if (p.onGround && p.groundSpeed < 0.5) break;
      }
      var td = T.events.filter(function (e) { return e.type === 'touchdown'; })[0];
      var land = T.events.filter(function (e) { return e.type === 'landing'; })[0];
      return { crashed: p.crashed, reason: p.crashReason, stopped: p.onGround && p.groundSpeed < 0.5, td: td, landing: land, x: p.pos[0], z: p.pos[2] };
    });
    record('landing: stabilized approach lands and stops on runway',
      !l.crashed && l.stopped && l.td && l.td.onRunway, JSON.stringify(l));
    record('landing: graded', !!l.landing, JSON.stringify(l.landing || null));
  }

  // ---------------------------------------------------------------- crash detection
  if (want('crash')) {
    const k = await page.evaluate(() => {
      var out = {};
      // straight into a mountainside
      T.reset(); T.events.length = 0;
      var best = null;
      for (var a = 0; a < 360 && !best; a += 15) {
        var x = Math.sin(a * Math.PI / 180) * 3500, z = -Math.cos(a * Math.PI / 180) * 3500;
        if (RL.World.heightAt(x, z) > 900) best = [x, z];
      }
      var h = RL.World.heightAt(best[0], best[1]);
      var dir = Math.atan2(best[0], -best[1]) * 180 / Math.PI;
      RL.debug.teleport(best[0] * 0.8, h - 150, best[1] * 0.8, (dir + 360) % 360, 60);
      T.step({ throttle: 1, pitch: 0, roll: 0, yaw: 0 }, 30);
      var ev = T.events.filter(function (e) { return e.type === 'crash'; });
      out.terrain = { crashed: RL.Game.plane.crashed, reason: RL.Game.plane.crashReason, state: RL.Game.state, events: ev.length };
      // hard landing: drop onto the runway at 7 m/s
      T.reset(); T.events.length = 0;
      RL.debug.teleport(0, RL.Config.airfield.elevation + 12, 200, 0, 35, true);
      var p = RL.Game.plane;
      p.vel[1] = -9;
      T.step({ throttle: 0, pitch: 0, roll: 0, yaw: 0 }, 5);
      out.hard = { crashed: p.crashed, reason: p.crashReason, gear: p.gear };
      // water
      T.reset(); T.events.length = 0;
      var L = RL.Config.water.lakes[0];
      RL.debug.teleport(L.x, RL.Config.water.level + 6, L.z + 200, 0, 50);
      T.step({ throttle: 0, pitch: -1, roll: 0, yaw: 0 }, 6);
      out.water = { crashed: RL.Game.plane.crashed, reason: RL.Game.plane.crashReason };
      // respawn works
      RL.Game.handleAction('reset');
      out.respawn = { state: RL.Game.state, onGround: RL.Game.plane.onGround, crashed: RL.Game.plane.crashed };
      return out;
    });
    record('crash: mountain', k.terrain.crashed && k.terrain.state === 'crashed' && k.terrain.events === 1, JSON.stringify(k.terrain));
    record('crash: hard landing (gear down)', k.hard.crashed && k.hard.reason === 'hardLanding', JSON.stringify(k.hard));
    record('crash: water', k.water.crashed && k.water.reason === 'water', JSON.stringify(k.water));
    record('crash: respawn', k.respawn.state === 'playing' && k.respawn.onGround && !k.respawn.crashed, JSON.stringify(k.respawn));
  }

  // ---------------------------------------------------------------- numerical robustness
  if (want('robust')) {
    const r = await page.evaluate(() => {
      T.reset();
      RL.debug.teleport(0, 1200, -1000, 90, 70);
      var p = RL.Game.plane, nan = false, t = 0;
      var seq = [
        { throttle: 1, pitch: 1, roll: 1, yaw: 1 }, { throttle: 0, pitch: -1, roll: -1, yaw: -1 },
        { throttle: 1, pitch: 1, roll: 0, yaw: 0 }, { throttle: 0, pitch: 1, roll: 0, yaw: 1 }
      ];
      for (var k = 0; k < 4 && !p.crashed; k++) {
        for (var i = 0; i < 600 && !p.crashed; i++) {
          T.step(seq[k], 1 / 60);
          if (![p.pos[0], p.pos[1], p.pos[2], p.vel[0], p.vel[1], p.vel[2], p.quat[3], p.airspeed].every(isFinite)) nan = true;
        }
      }
      return { nan: nan, crashed: p.crashed, alt: p.pos[1], speed: p.airspeed };
    });
    record('robust: no NaN under abuse', !r.nan, JSON.stringify(r));
  }

  // ---------------------------------------------------------------- screenshots
  if (shotsDir && want('shots')) {
    const shots = [
      ['title', null],
      ['runway-chase', "T.reset(); RL.debug.freeze=false; RL.CameraRig && RL.CameraRig.setMode('chase');"],
      ['cockpit', "RL.CameraRig && RL.CameraRig.setMode('cockpit');"],
      ['valley-air', "T.reset(); RL.debug.teleport(0, 450, 1500, 0, 60); RL.CameraRig && RL.CameraRig.setMode('chase'); RL.debug.freeze=false;"],
      ['canyon-arch', "var a=RL.Terrain.arch; RL.debug.teleport(a.center[0]+a.dir[0]*400, a.center[1]+70, a.center[2]+a.dir[2]*400, (Math.atan2(-a.dir[0], a.dir[2])*180/Math.PI+360)%360, 55); RL.debug.freeze=false;"],
      ['sunset', "T.reset(); RL.Atmosphere.set('sunset', true); RL.debug.teleport(0, 300, 1200, 300, 60); RL.debug.freeze=false;"],
      ['night-runway', "T.reset(); RL.Atmosphere.set('night', true); RL.debug.freeze=false;"],
      ['dawn', "T.reset(); RL.Atmosphere.set('dawn', true); RL.debug.teleport(1200, 200, 800, 20, 55); RL.debug.freeze=false;"]
    ];
    for (const [name, js] of shots) {
      if (name === 'title') {
        const p2 = await newPage(browser, 'noaudio&quality=' + quality);
        await p2.page.waitForTimeout(1500);
        await p2.page.screenshot({ path: path.join(shotsDir, 'title.png'), timeout: 180000 });
        await p2.page.close();
        continue;
      }
      await page.evaluate(js);
      await page.waitForTimeout(2500);
      await page.screenshot({ path: path.join(shotsDir, name + '.png'), timeout: 180000 });
      await page.evaluate("RL.debug.freeze=true; RL.Atmosphere.set('day', true);");
    }
    console.log('screenshots in ' + shotsDir);
  }

  const errs = await page.evaluate(() => RL.errors.slice());
  const pageLogs = logs.filter((l) => !/ERR_FILE_NOT_FOUND|Failed to load resource/.test(l));
  record('no runtime errors during tests', errs.length === 0 && pageLogs.filter((l) => /error/.test(l)).length === 0,
    errs.concat(pageLogs).slice(0, 8).join(' | '));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(3); });
