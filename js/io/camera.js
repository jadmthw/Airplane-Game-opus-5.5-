/*
 * Ridgeline — RL.CameraRig: every camera in the game.
 *
 *   init(), update(dt, plane, input, gameState), cycle() -> label, setMode(name), shake(amount)
 *   mode ('chase'|'cockpit'|'orbit'|'tower'|'flyby', 'attract' on the title screen; the
 *   crash-site orbit reports 'orbit'), userMode (the player's pick), position v3, view m4,
 *   fov (rad), near, far.
 *
 * Each mode computes a pose (eye, forward, up, fov). Mode changes blend the pose over ~0.4 s
 * (long jumps cut instead of swooping across the valley). Terrain/water clearance is applied to
 * the final eye with a lift that rises instantly and relaxes smoothly, so the camera never
 * clips into a slope and never jitters over bumpy ground. No allocations per frame.
 */
(function (RL) {
  'use strict';
  var M = RL.M, v3 = RL.v3, quat = RL.quat, m4 = RL.m4;

  var ORDER = ['chase', 'cockpit', 'orbit', 'tower', 'flyby'];
  var LABELS = {
    chase: 'Chase', cockpit: 'Cockpit', orbit: 'Orbit', tower: 'Tower', flyby: 'Flyby',
    attract: 'Showcase'
  };
  var BLEND_TIME = 0.42;
  var CUT_DISTANCE = 120;      // blends longer than this cut instead (no valley-wide swoops)
  var WORLD_UP = v3.create(0, 1, 0);
  var AX_FWD = v3.create(0, 0, -1), AX_UP = v3.create(0, 1, 0), AX_RIGHT = v3.create(1, 0, 0);
  var COCKPIT_FALLBACK = v3.create(0, 1, 0.5);

  // ------------------------------------------------------------------ scratch
  var tmpA = v3.create(), tmpB = v3.create(), tmpC = v3.create(), tmpD = v3.create();
  var pForward = v3.create(0, 0, -1), pUp = v3.create(0, 1, 0), pRight = v3.create(1, 0, 0);
  var pPos = v3.create(), pVel = v3.create();
  var fallbackQuat = quat.create();
  var lookTarget = v3.create();

  // pose computed by the active mode this frame
  var want = { eye: v3.create(), fwd: v3.create(0, 0, -1), up: v3.create(0, 1, 0), fov: 1, near: 0.8, clearance: 1.5, los: true };
  // pose we blend from (eye relative to the aircraft position)
  var from = { eye: v3.create(), fwd: v3.create(0, 0, -1), up: v3.create(0, 1, 0), fov: 1 };
  // final output pose
  var out = { eye: v3.create(0, 60, 700), fwd: v3.create(0, 0, -1), up: v3.create(0, 1, 0), fov: 1 };

  var blendT = 1, blendDur = BLEND_TIME, blendEaseIn = false;
  var effectiveMode = 'chase', reportedMode = 'chase', pendingCockpit = false;
  var terrainLift = 0;
  var shakeAmt = 0, shakeTime = 0;
  var lastPlanePos = v3.create(), havePlane = false, snapNext = true;
  var time = 0;

  // chase state
  var chaseQ = quat.create();
  var chaseSpeed = 0, chaseFov = 1, chaseGroundBlend = 1, gSmooth = 1;
  // cockpit state
  var cockpitQ = quat.create(), headG = 0;
  // orbit state (world-relative angles)
  var orbitYaw = 0, orbitPitch = 0.28, orbitYawS = 0, orbitPitchS = 0.28, orbitDist = 17;
  // tower / flyby
  var towerTarget = v3.create(), towerFov = 0.5;
  var flybyPos = v3.create(), flybyTarget = v3.create(), flybyFov = 0.8, flybyValid = false;
  // attract / crashed orbits
  var attractAngle = 0.9, crashAngle = 0, crashCenter = v3.create();

  var Rig = {
    mode: 'chase',
    userMode: 'chase',
    position: v3.create(0, 60, 700),
    view: m4.create(),
    fov: 62 * Math.PI / 180,
    near: 0.8,
    far: 26000,
    labels: LABELS,

    init: init,
    update: update,
    cycle: cycle,
    setMode: setMode,
    shake: shake
  };

  // ------------------------------------------------------------------ helpers
  function cfgRender() { return (RL.Config && RL.Config.render) || { fovDeg: 62, near: 0.8, nearCockpit: 0.12, far: 26000 }; }
  function baseFov() { return cfgRender().fovDeg * M.DEG; }
  function fin(x, d) { return (typeof x === 'number' && isFinite(x)) ? x : d; }

  function surfaceAt(x, z) {
    var W = RL.World;
    var h = W && W.surfaceHeightAt ? W.surfaceHeightAt(x, z) : (RL.Config ? RL.Config.airfield.elevation : 0);
    return fin(h, 0);
  }

  // Deterministic smooth noise in [-1, 1] (sum of incommensurate sines) for camera shake.
  function wobble(t, seed) {
    return (Math.sin(t * 17.3 + seed * 3.1) * 0.5 + Math.sin(t * 29.7 + seed * 7.3) * 0.3 +
      Math.sin(t * 47.9 + seed * 1.7) * 0.2);
  }

  function readPlane(plane) {
    if (!plane || !plane.pos) return false;
    v3.copy(pPos, plane.pos);
    if (!(isFinite(pPos[0]) && isFinite(pPos[1]) && isFinite(pPos[2]))) return false;
    if (plane.vel) v3.copy(pVel, plane.vel); else v3.set(pVel, 0, 0, 0);
    var q = plane.quat;
    if (q && isFinite(q[3])) {
      v3.transformQuat(pForward, AX_FWD, q);
      v3.transformQuat(pUp, AX_UP, q);
      v3.transformQuat(pRight, AX_RIGHT, q);
    } else if (plane.forward && plane.up) {
      v3.normalize(pForward, plane.forward);
      v3.normalize(pUp, plane.up);
      v3.cross(pRight, pForward, pUp);
      v3.normalize(pRight, pRight);
    } else {
      v3.set(pForward, 0, 0, -1); v3.set(pUp, 0, 1, 0); v3.set(pRight, 1, 0, 0);
    }
    return true;
  }

  function planeQuat(plane) {
    if (plane && plane.quat && isFinite(plane.quat[3])) return plane.quat;
    quat.fromMat3Axes(fallbackQuat, pRight, pUp, v3.negate(tmpD, pForward));
    return fallbackQuat;
  }

  function speedOf(plane) {
    var s = plane && fin(plane.airspeed, NaN);
    return isFinite(s) ? s : v3.length(pVel);
  }

  function setWantLookAt(eye, target, up) {
    v3.copy(want.eye, eye);
    v3.sub(want.fwd, target, eye);
    if (v3.lengthSq(want.fwd) < 1e-8) v3.copy(want.fwd, pForward);
    v3.normalize(want.fwd, want.fwd);
    v3.copy(want.up, up || WORLD_UP);
  }

  // ------------------------------------------------------------------ public
  function init() {
    Rig.far = cfgRender().far;
    Rig.near = cfgRender().near;
    Rig.fov = baseFov();
    chaseFov = baseFov();
    out.fov = baseFov();
    if (RL.Events) {
      RL.Events.on('crash', function () { shake(1.0); });
      RL.Events.on('touchdown', function (d) {
        var vs = Math.abs(fin(d && d.verticalSpeed, 1));
        shake(M.clamp(vs / 5, 0.06, 0.7));
      });
      RL.Events.on('bounce', function () { shake(0.3); });
      RL.Events.on('respawn', function () { snapNext = true; });
    }
  }

  function modeValid(name) { return ORDER.indexOf(name) >= 0; }

  function announce() {
    if (RL.Events) RL.Events.emit('camera', { mode: Rig.userMode, label: LABELS[Rig.userMode] });
  }

  function setMode(name) {
    if (!modeValid(name)) return undefined;
    Rig.userMode = name;
    announce();
    return LABELS[name];
  }

  function cycle() {
    var i = ORDER.indexOf(Rig.userMode);
    Rig.userMode = ORDER[(i + 1) % ORDER.length];
    announce();
    return LABELS[Rig.userMode];
  }

  function shake(amount) {
    shakeAmt = M.clamp(Math.max(shakeAmt, fin(amount, 0)), 0, 1.5);
  }

  // ------------------------------------------------------------------ modes
  function poseChase(dt, plane, input) {
    var speed = speedOf(plane);
    var onGround = !!plane.onGround;
    // orientation follows the aircraft with lag: dynamic but never twitchy
    var lag = onGround ? 7 : 4.2;
    quat.slerp(chaseQ, chaseQ, planeQuat(plane), 1 - Math.exp(-lag * dt));
    chaseSpeed = M.damp(chaseSpeed, speed, 1.6, dt);
    chaseGroundBlend = M.damp(chaseGroundBlend, onGround ? 1 : 0, 1.5, dt);
    gSmooth = M.damp(gSmooth, fin(plane.gForce, 1), 4, dt);

    // accelerating pulls the camera back a touch, braking lets it close in
    var accelLag = M.clamp((speed - chaseSpeed) * 0.35, -2.5, 3.5);
    var dist = M.lerp(14 + Math.min(speed, 90) * 0.045, 11.5, chaseGroundBlend) + accelLag;
    var height = M.lerp(3.4, 2.4, chaseGroundBlend);

    // free look swings the camera around the aircraft
    var ly = 0, lp = 0;
    if (input && input.look) { ly = fin(input.look.yaw, 0); lp = fin(input.look.pitch, 0); }
    var cy = Math.cos(ly), sy = Math.sin(ly), cp = Math.cos(lp), sp = Math.sin(lp);
    // offset in chase frame: behind (+Z) and above; look yaw + = look right -> camera swings left
    var ox = -sy * dist * cp, oz = cy * dist * cp, oy = height + sp * dist * 0.9;
    v3.set(tmpA, ox, oy, oz);
    v3.transformQuat(tmpA, tmpA, chaseQ);
    v3.add(tmpB, pPos, tmpA);   // eye

    // up: partially follows the bank; fully when steep/inverted so loops never flip
    v3.transformQuat(tmpC, AX_UP, chaseQ);
    var w = M.lerp(1, 0.38, M.smoothstep(0.0, 0.6, tmpC[1]));
    v3.lerp(tmpC, WORLD_UP, tmpC, w);
    v3.normalize(tmpC, tmpC);

    // look a little ahead of the aircraft so it sits below center with room to see where it goes
    v3.transformQuat(tmpD, AX_FWD, chaseQ);
    var ahead = (onGround ? 5 : 7) + Math.min(speed, 90) * 0.06;
    v3.scaleAndAdd(lookTarget, pPos, tmpD, ahead * (1 - Math.min(1, Math.abs(ly) * 0.8)));
    v3.scaleAndAdd(lookTarget, lookTarget, tmpC, 1.1);
    setWantLookAt(tmpB, lookTarget, tmpC);

    // speed widens the view a little; high G adds a subtle rumble
    var targetFov = baseFov() + M.smoothstep(35, 95, speed) * 9 * M.DEG;
    chaseFov = M.damp(chaseFov, targetFov, 2, dt);
    want.fov = chaseFov;
    want.near = cfgRender().near;
    want.clearance = 1.6;
    want.los = true;
    if (gSmooth > 3.2) shake(Math.min(0.24, (gSmooth - 3.2) * 0.07));
    if (onGround && speed > 4) shake(Math.min(0.1, speed * 0.002));
  }

  function poseCockpit(dt, plane, input) {
    // slight head lag behind aircraft rotation, and the head sinks under positive G
    quat.slerp(cockpitQ, cockpitQ, planeQuat(plane), 1 - Math.exp(-16 * dt));
    headG = M.damp(headG, M.clamp(fin(plane.gForce, 1) - 1, -2, 5), 5, dt);
    var off = (RL.Aircraft && RL.Aircraft.cockpitOffset) || COCKPIT_FALLBACK;
    v3.set(tmpA, fin(off[0], 0), fin(off[1], 1) - M.clamp(headG * 0.018, -0.05, 0.07), fin(off[2], 0.5));
    v3.transformQuat(tmpA, tmpA, planeQuat(plane));
    v3.add(tmpB, pPos, tmpA);

    var ly = 0, lp = 0;
    if (input && input.look) { ly = fin(input.look.yaw, 0); lp = fin(input.look.pitch, 0); }
    v3.set(tmpC, Math.sin(ly) * Math.cos(lp), Math.sin(lp), -Math.cos(ly) * Math.cos(lp));
    v3.transformQuat(tmpC, tmpC, cockpitQ);
    v3.copy(want.eye, tmpB);
    v3.normalize(want.fwd, tmpC);
    v3.transformQuat(want.up, AX_UP, cockpitQ);
    want.fov = baseFov() + 6 * M.DEG;
    want.near = cfgRender().nearCockpit || 0.12;
    want.clearance = 0.25;
    want.los = false;
  }

  function poseOrbit(dt, plane, input) {
    if (input && input.look && input.look.active) {
      orbitYaw += fin(input.look.dYaw, 0) * 1.3;
      orbitPitch = M.clamp(orbitPitch + fin(input.look.dPitch, 0) * 1.1, -0.35, 1.35);
    }
    orbitYawS = M.damp(orbitYawS, orbitYaw, 9, dt);
    orbitPitchS = M.damp(orbitPitchS, orbitPitch, 9, dt);
    var cp = Math.cos(orbitPitchS);
    v3.set(tmpA, Math.sin(orbitYawS) * cp, Math.sin(orbitPitchS), Math.cos(orbitYawS) * cp);
    v3.scaleAndAdd(tmpB, pPos, tmpA, orbitDist);
    v3.set(lookTarget, pPos[0], pPos[1] + 0.8, pPos[2]);
    setWantLookAt(tmpB, lookTarget, WORLD_UP);
    want.fov = baseFov() - 4 * M.DEG;
    want.near = cfgRender().near;
    want.clearance = 1.5;
    want.los = true;
  }

  function resetOrbitBehind() {
    // start the orbit behind the aircraft in world terms
    orbitYaw = Math.atan2(-pForward[0], -pForward[2]);
    orbitPitch = 0.28;
    orbitYawS = orbitYaw; orbitPitchS = orbitPitch;
  }

  function framingFov(dist, halfSize, minDeg, maxDeg) {
    return M.clamp(2 * Math.atan(halfSize / Math.max(dist, 1)), minDeg * M.DEG, maxDeg * M.DEG);
  }

  function poseTower(dt, plane, snap) {
    var tp = RL.Airfield && RL.Airfield.towerCamPos;
    var E = RL.Config ? RL.Config.airfield.elevation : 50;
    if (tp && isFinite(tp[0])) v3.copy(tmpB, tp); else v3.set(tmpB, -229, E + 18, -30);
    // a camera operator: slightly lagged, leading the aircraft along its path
    v3.scaleAndAdd(tmpA, pPos, pVel, 0.15);
    if (snap) v3.copy(towerTarget, tmpA); else v3.damp(towerTarget, towerTarget, tmpA, 6, dt);
    var d = v3.dist(tmpB, pPos);
    var f = framingFov(d, 20, 5, 60);
    towerFov = snap ? f : M.damp(towerFov, f, 3, dt);
    setWantLookAt(tmpB, towerTarget, WORLD_UP);
    want.fov = towerFov;
    want.near = cfgRender().near;
    want.clearance = 1.5;
    want.los = false;
  }

  // True when the straight line a->b stays above the terrain/water surface.
  function lineClear(a, b) {
    for (var i = 1; i <= 5; i++) {
      var f = i / 6;
      if (M.lerp(a[1], b[1], f) < surfaceAt(M.lerp(a[0], b[0], f), M.lerp(a[2], b[2], f)) + 1) return false;
    }
    return true;
  }

  function placeFlyby(plane) {
    var speed = v3.length(pVel);
    if (speed > 3) v3.scale(tmpA, pVel, 1 / speed); else v3.copy(tmpA, pForward);
    // ahead along the path (~3.5 s), off to the side and a little below the flight line
    var ahead = M.clamp(speed * 3.5, 60, 320);
    v3.cross(tmpC, tmpA, WORLD_UP);
    if (v3.lengthSq(tmpC) < 1e-6) v3.copy(tmpC, pRight);
    v3.normalize(tmpC, tmpC);
    var sideSign = Math.random() < 0.5 ? 1 : -1;
    var sideDist = 16 + Math.random() * 14;
    var dy = plane.onGround ? 1.2 : (Math.random() * 10 - 6);
    // try both sides, then higher, until the camera can actually see the aircraft
    for (var attempt = 0; attempt < 4; attempt++) {
      var sgn = (attempt % 2) ? -sideSign : sideSign;
      v3.scaleAndAdd(flybyPos, pPos, tmpA, ahead);
      v3.scaleAndAdd(flybyPos, flybyPos, tmpC, sgn * sideDist);
      flybyPos[1] += dy + (attempt >= 2 ? 25 : 0);
      flybyPos[1] = Math.max(flybyPos[1], surfaceAt(flybyPos[0], flybyPos[2]) + 2.5);
      if (lineClear(flybyPos, pPos)) break;
    }
    v3.copy(flybyTarget, pPos);
    flybyFov = framingFov(v3.dist(flybyPos, pPos), 14, 12, 65);
    flybyValid = true;
  }

  function poseFlyby(dt, plane) {
    var cut = false;
    v3.sub(tmpA, flybyPos, pPos);
    var d = v3.length(tmpA);
    var receding = v3.dot(tmpA, pVel) < 0;   // aircraft moving away from the camera
    if (!flybyValid || d > 1200 || (receding && d > 260) || (v3.length(pVel) < 2 && d > 400)) {
      placeFlyby(plane);
      cut = true;
      d = v3.dist(flybyPos, pPos);
    }
    v3.damp(flybyTarget, flybyTarget, pPos, cut ? 1000 : 9, dt);
    var f = framingFov(d, 14, 12, 65);
    flybyFov = M.damp(flybyFov, f, 2.5, dt);
    setWantLookAt(flybyPos, flybyTarget, WORLD_UP);
    want.fov = flybyFov;
    want.near = cfgRender().near;
    want.clearance = 1.5;
    want.los = false;
    return cut;
  }

  function poseAttract(dt, center) {
    // slow cinematic orbit that breathes in and out to show the valley behind the aircraft
    attractAngle += dt * 0.075;
    var breath = 0.5 + 0.5 * Math.sin(attractAngle * 1.7);
    var r = M.lerp(15, 34, breath);
    var h = M.lerp(2.2, 9, 0.5 + 0.5 * Math.sin(attractAngle * 1.1 + 1.0));
    v3.set(tmpB, center[0] + Math.sin(attractAngle) * r, center[1] + h, center[2] + Math.cos(attractAngle) * r);
    v3.set(lookTarget, center[0], center[1] + 1.2 + breath * 1.5, center[2]);
    setWantLookAt(tmpB, lookTarget, WORLD_UP);
    want.fov = baseFov() - 8 * M.DEG;
    want.near = cfgRender().near;
    want.clearance = 1.5;
    want.los = true;
  }

  function poseCrashed(dt) {
    crashAngle += dt * 0.12;
    v3.damp(crashCenter, crashCenter, pPos, 2, dt);   // follow the wreck as it settles
    var r = 38;
    v3.set(tmpB, crashCenter[0] + Math.sin(crashAngle) * r, crashCenter[1] + 15, crashCenter[2] + Math.cos(crashAngle) * r);
    v3.set(lookTarget, crashCenter[0], crashCenter[1] + 2, crashCenter[2]);
    setWantLookAt(tmpB, lookTarget, WORLD_UP);
    want.fov = baseFov() - 4 * M.DEG;
    want.near = cfgRender().near;
    want.clearance = 2;
    want.los = true;
  }

  // ------------------------------------------------------------------ blending
  // The start pose is stored relative to the aircraft so a blend never lags behind a fast plane.
  function startBlend(dur, easeIn) {
    v3.sub(from.eye, out.eye, pPos);
    v3.copy(from.fwd, out.fwd);
    v3.copy(from.up, out.up);
    from.fov = out.fov;
    blendT = 0;
    blendDur = dur;
    blendEaseIn = !!easeIn;
  }

  function snapChase(plane) {
    quat.copy(chaseQ, planeQuat(plane));
    quat.copy(cockpitQ, planeQuat(plane));
    chaseSpeed = speedOf(plane);
    chaseGroundBlend = plane.onGround ? 1 : 0;
    terrainLift = 0;
    flybyValid = false;
  }

  // ------------------------------------------------------------------ update
  function update(dt, plane, input, gameState) {
    dt = M.clamp(fin(dt, 0.016), 0, 0.1);
    time += dt;
    input = input || RL.Input || null;
    var state = gameState || 'title';

    var hasPlane = readPlane(plane);
    if (!hasPlane) {
      // no aircraft yet: circle the spawn point on the runway
      var C = RL.Config;
      v3.set(pPos, C ? C.spawn.x : 0, C ? C.airfield.elevation + 1.5 : 50, C ? C.spawn.z : 0);
      v3.set(pVel, 0, 0, 0);
      v3.set(pForward, 0, 0, -1); v3.set(pUp, 0, 1, 0); v3.set(pRight, 1, 0, 0);
      plane = null;
    }

    // teleports (respawn, debug) snap instead of dragging the camera across the map
    if (hasPlane && (!havePlane || v3.distSq(lastPlanePos, pPos) > 150 * 150)) snapNext = true;
    havePlane = hasPlane;
    v3.copy(lastPlanePos, pPos);

    // which mode is live?
    var next;
    if (state === 'title' || !plane) next = 'attract';
    else if (state === 'crashed') next = 'crashed';
    else next = Rig.userMode;

    var snap = snapNext;
    snapNext = false;
    if (snap && plane) snapChase(plane);

    if (next !== effectiveMode) {
      var prev = effectiveMode;
      effectiveMode = next;
      if (next === 'orbit') resetOrbitBehind();
      if (next === 'flyby') flybyValid = false;
      if (next === 'crashed') {
        v3.copy(crashCenter, pPos);
        crashAngle = Math.atan2(out.eye[0] - pPos[0], out.eye[2] - pPos[2]);
      }
      if (next === 'cockpit' || prev === 'cockpit') { quat.copy(cockpitQ, planeQuat(plane || null)); }
      if (next === 'chase' && plane) { quat.copy(chaseQ, planeQuat(plane)); }
      var dur = BLEND_TIME;
      if (prev === 'attract') dur = 1.3;
      if (next === 'crashed') dur = 1.1;
      if (!snap) startBlend(dur, next === 'cockpit');
      pendingCockpit = next === 'cockpit';
    }

    // compute the target pose
    var cut = false;
    switch (effectiveMode) {
      case 'chase': poseChase(dt, plane, input); break;
      case 'cockpit': poseCockpit(dt, plane, input); break;
      case 'orbit': poseOrbit(dt, plane, input); break;
      case 'tower': poseTower(dt, plane, snap || blendT < 1e-6); break;
      case 'flyby': cut = poseFlyby(dt, plane); break;
      case 'crashed': poseCrashed(dt); break;
      default: poseAttract(dt, pPos);
    }
    if (cut && blendT >= 1) blendT = 1;

    // long moves cut; otherwise blend with an ease (in when diving into the cockpit)
    v3.add(tmpD, pPos, from.eye);   // blend start in world space
    if (blendT < 1 && v3.dist(tmpD, want.eye) > CUT_DISTANCE) blendT = 1;
    if (snap) blendT = 1;
    var t = 1;
    if (blendT < 1) {
      blendT = Math.min(1, blendT + dt / blendDur);
      t = blendEaseIn ? blendT * blendT * blendT : M.smoothstep(0, 1, blendT);
    }
    if (t >= 1) {
      v3.copy(out.eye, want.eye); v3.copy(out.fwd, want.fwd); v3.copy(out.up, want.up); out.fov = want.fov;
    } else {
      v3.lerp(out.eye, tmpD, want.eye, t);
      v3.lerp(out.fwd, from.fwd, want.fwd, t);
      if (v3.lengthSq(out.fwd) < 1e-6) v3.copy(out.fwd, want.fwd);
      v3.normalize(out.fwd, out.fwd);
      v3.lerp(out.up, from.up, want.up, t);
      if (v3.lengthSq(out.up) < 1e-6) v3.copy(out.up, WORLD_UP);
      v3.normalize(out.up, out.up);
      out.fov = M.lerp(from.fov, want.fov, t);
    }

    // The aircraft model switches to its cockpit rendering only once we are (nearly) inside.
    reportedMode = effectiveMode === 'attract' ? 'attract'
      : effectiveMode === 'crashed' ? 'orbit'
      : (pendingCockpit && t < 0.9) ? previousNonCockpit() : effectiveMode;
    if (pendingCockpit && t >= 0.9) pendingCockpit = false;

    // shake (decaying trauma, squared for a soft onset)
    shakeAmt = Math.max(0, shakeAmt - dt * 1.4);
    shakeTime += dt;
    var s = shakeAmt * shakeAmt;
    v3.copy(tmpB, out.eye);
    if (s > 1e-5) {
      var mag = effectiveMode === 'cockpit' ? 0.12 : 0.55;
      v3.cross(tmpC, out.fwd, out.up);
      v3.normalize(tmpC, tmpC);
      v3.scaleAndAdd(tmpB, tmpB, tmpC, wobble(shakeTime, 1) * s * mag);
      v3.scaleAndAdd(tmpB, tmpB, out.up, wobble(shakeTime, 2) * s * mag);
    }

    // terrain / water clearance: at the eye and along the sight line to the aircraft
    var clearance = effectiveMode === 'cockpit' && blendT >= 1 ? want.clearance : Math.max(want.clearance, 0.6);
    var need = surfaceAt(tmpB[0], tmpB[2]) + clearance - tmpB[1];
    if (want.los && effectiveMode !== 'cockpit') {
      for (var i = 1; i <= 2; i++) {
        var f = i / 3;
        var x = M.lerp(tmpB[0], pPos[0], f), z = M.lerp(tmpB[2], pPos[2], f);
        var yLine = M.lerp(tmpB[1], pPos[1], f);
        var n = (surfaceAt(x, z) + 1.0 - yLine) / (1 - f);   // lift the eye so the line clears
        if (n > need) need = n;
      }
    }
    need = Math.max(0, need);
    if (snap || need > terrainLift) terrainLift = need;
    else terrainLift = M.damp(terrainLift, need, 2.5, dt);
    // never below the surface right under the eye, whatever the smoothing did
    var hardMin = surfaceAt(tmpB[0], tmpB[2]) + Math.min(clearance, 0.25);
    tmpB[1] = Math.max(tmpB[1] + terrainLift, hardMin);

    // output
    if (!(isFinite(tmpB[0]) && isFinite(tmpB[1]) && isFinite(tmpB[2]))) v3.set(tmpB, 0, 200, 800);
    v3.copy(Rig.position, tmpB);
    v3.add(tmpA, tmpB, out.fwd);
    if (s > 1e-5) {
      // a touch of rotational shake too
      v3.cross(tmpC, out.fwd, out.up);
      v3.scaleAndAdd(tmpA, tmpA, tmpC, wobble(shakeTime + 3.3, 3) * s * 0.012);
      v3.scaleAndAdd(tmpA, tmpA, out.up, wobble(shakeTime + 5.1, 4) * s * 0.012);
    }
    m4.lookAt(Rig.view, Rig.position, tmpA, out.up);
    Rig.fov = M.clamp(fin(out.fov, baseFov()), 2 * M.DEG, 120 * M.DEG);
    Rig.near = reportedMode === 'cockpit' ? (cfgRender().nearCockpit || 0.12) : cfgRender().near;
    Rig.far = cfgRender().far;
    Rig.mode = reportedMode;
  }

  var lastNonCockpit = 'chase';
  function previousNonCockpit() {
    if (Rig.mode !== 'cockpit') lastNonCockpit = Rig.mode;
    return lastNonCockpit;
  }

  RL.CameraRig = Rig;
})(window.RL = window.RL || {});
