/*
 * Ridgeline — RL.FlightModel: flight dynamics of the "Ridgeline Sparrow", a small aerobatic
 * sport monoplane (~950 kg, 9 m span, 7.4 m long, retractable tricycle gear).
 *
 *   create() -> plane state          reset(plane, spawn)
 *   step(plane, controls, dt, world) -> raw events [{type, ...}]
 *   toggleGear(plane) -> accepted    cycleFlaps(plane) -> notch
 *   specs {vStall, vStallFlaps, vRotate, vCruise, vMax, vNeverExceed} (m/s)
 *   params (airframe constants, used by the autopilot), points (body-space reference points
 *   for effects: wingtips, wheels, exhaust, smoke nozzle).
 *
 * Model: rigid body with forces in newtons (lift/drag/side force from the air-relative velocity,
 * prop thrust, gravity, per-wheel spring-damper ground contacts) and rotational dynamics written
 * as body-axis angular accelerations (aero) plus contact torques / inertia. The aero moments are
 * shaped for game feel: the elevator adds angle of attack on top of a light stability
 * augmentation that holds the flight path with the stick centred (bank compensated, gentle
 * return toward level, fading out near the stall and with flaps); ailerons command a roll rate
 * proportional to airspeed; rudder vs. a strong weathervane. Damping acts relative to the
 * rotation of the flight path, so steady turns and loops aren't resisted and banks persist.
 * Near the ground (fading out 30-120 m AGL) a held pull can't stall the wing or, while slow,
 * pitch past a steady climb, so rotating with a held key gives a climb (plane.stallProtect is
 * the level of the soft AoA limiter, for the stall warnings).
 *
 * Body axes: nose = -Z, right wing = +X, up = +Y. angVel = [pitch up, yaw LEFT, roll LEFT] rad/s.
 * Controls: pitch + = nose up, roll + = roll right, yaw + = nose right.
 * Internally the step is sub-stepped to <= 1/120 s so callers may pass 1/60 as well.
 */
(function (RL) {
  'use strict';
  var M = RL.M, v3 = RL.v3, C = RL.Config;

  var DEG = Math.PI / 180;
  var G = 9.81, RHO = 1.225;

  // ------------------------------------------------------------------ airframe constants
  var P = {
    mass: 950,
    inertia: [1800, 2100, 1150],        // pitch (x), yaw (y), roll (z) kg m^2 (ground torques)
    wingArea: 13.0, span: 9.0,
    cl0: 0.25,                           // CL at zero fuselage AoA (camber + incidence)
    clAlpha: 4.75,                       // per rad (AR ~6.2)
    alphaStall: 16.5 * DEG,              // clean critical AoA
    alphaStallFlaps: -2.0 * DEG,         // change of critical AoA with full flaps
    alphaStallNeg: -12.5 * DEG,          // inverted stall
    clFlaps: 0.75,                       // CL increment at full flaps
    cd0: 0.019, cdGear: 0.014, cdFlaps: 0.045, oswald: 0.85, cyBeta: 0.55,
    // engine / prop: thrust = min(linear static region, power-limited P/V), plus windmill drag
    thrustStatic: 2000, thrustAt36: 2800, power: 100000, powerExp: 1.8, windmill: 0.37,
    idleRpm: 0.2, propDisk: 2.54, propWash: 0.7,
    // rotational "feel" constants (angular accelerations at the reference dynamic pressure)
    vRef: 55,
    kElev: 4.2, kAlpha: 16.0, alphaTrim: 1.5 * DEG, dampPitch0: 0.5, dampPitch: 3.0, pathReturn: 2.5, holdFlaps: 0.5,
    stallPitch: 2.6,
    protectAgl: [30, 120],               // m AGL: takeoff / low-level stall protection fades out
    kAil: 15.3, dampRoll0: 0.4, dampRoll: 5.5, kDihedral: 4.0,
    kRud: 2.2, kBeta: 7.0, dampYaw0: 0.5, dampYaw: 2.5,
    // gear (body space, model origin = CG). Wheel points are the tyre bottoms, strut extended.
    gearHeight: 1.45, noseZ: -2.30, mainZ: 0.28, mainX: 1.3, staticSag: 0.08, stroke: 0.30,
    muRoll: 0.035, muRollSpeed: 0.0035, muStatic: 0.045, muBrake: 0.45, muLat: 0.55,
    gearTime: 3.2, flapRate: 0.45
  };
  P.weight = P.mass * G;
  P.aspect = P.span * P.span / P.wingArea;
  P.qRef = 0.5 * RHO * P.vRef * P.vRef;

  // Static wheel loads -> spring rates that give the same sag on every wheel (level at rest).
  var noseLoad = P.weight * P.mainZ / (P.mainZ - P.noseZ);
  var mainLoad = (P.weight - noseLoad) / 2;
  var WHEELS = [
    { name: 'nose', p: [0, -P.gearHeight, P.noseZ], k: noseLoad / P.staticSag, c: 2400, steer: true, brake: false },
    { name: 'left', p: [-P.mainX, -P.gearHeight, P.mainZ], k: mainLoad / P.staticSag, c: 5600, steer: false, brake: true },
    { name: 'right', p: [P.mainX, -P.gearHeight, P.mainZ], k: mainLoad / P.staticSag, c: 5600, steer: false, brake: true }
  ];
  // Hard points: touching the ground/water/colliders with these ends the flight (tail = skid).
  var POINTS = [
    { name: 'nose', p: [0, 0, -3.55], reason: 'noseStrike' },
    { name: 'prop', p: [0, -0.86, -3.3], reason: 'noseStrike' },
    { name: 'wingL', p: [-4.5, 0.02, 0.1], reason: 'wingStrike' },
    { name: 'wingR', p: [4.5, 0.02, 0.1], reason: 'wingStrike' },
    { name: 'belly', p: [0, -0.55, -0.3], reason: 'belly' },
    { name: 'bellyF', p: [0, -0.48, -1.6], reason: 'belly' },
    { name: 'bellyR', p: [0, -0.28, 1.9], reason: 'belly' },
    { name: 'tail', p: [0, 0.02, 3.95], reason: 'tail' },
    { name: 'fin', p: [0, 1.4, 3.95], reason: 'terrain' },
    { name: 'canopy', p: [0, 1.0, 0.7], reason: 'terrain' },
    { name: 'stabL', p: [-1.55, 0.15, 3.75], reason: 'wingStrike' },
    { name: 'stabR', p: [1.55, 0.15, 3.75], reason: 'wingStrike' }
  ];
  var TAIL_SKID = 7;                     // index into POINTS
  var COLLIDER_POINTS = [0, 2, 3, 4, 7, 8, 9];

  var HARD_LANDING = 4.5;                // m/s touchdown sink rate that breaks the gear
  var NOSE_FIRST = 3.0;                  // m/s sink on the nose wheel alone -> nose strike (the
                                         // main-gear 'firm/hard' boundary: flat arrivals aren't crashes)
  var WING_STRIKE_ROLL = 25;             // deg
  var MAX_SUBSTEP = 1 / 110;
  var BOUNDS_MARGIN = 4000;               // m past the terrain edge (the Game handles the soft edge)

  function clCurve(a, flaps, out) {
    // Lift coefficient over the full +-180 deg range: linear up to the critical AoA, a smooth
    // loss of lift past it, flat-plate behaviour deep in the stall and when flying backwards.
    var aS = P.alphaStall + P.alphaStallFlaps * flaps, aN = P.alphaStallNeg;
    var lin = P.cl0 + P.clAlpha * a + P.clFlaps * flaps;
    var plate = 1.05 * Math.sin(2 * a);
    var s = 0;
    if (a > aS) s = M.smoothstep(aS, aS + 0.10, a);
    else if (a < aN) s = M.smoothstep(aN, aN - 0.10, a);
    out.stall = s;
    out.aS = aS;
    return lin * (1 - s) + plate * s;
  }

  // ------------------------------------------------------------------ specs (m/s)
  var clMaxClean = P.cl0 + P.clAlpha * P.alphaStall;
  var clMaxFlaps = P.cl0 + P.clFlaps + P.clAlpha * (P.alphaStall + P.alphaStallFlaps);
  function stallSpeed(clMax) { return Math.sqrt(2 * P.weight / (RHO * P.wingArea * clMax)); }
  var specs = {
    vStall: stallSpeed(clMaxClean),
    vStallFlaps: stallSpeed(clMaxFlaps),
    vRotate: 0,
    vCruise: 67,
    vMax: 87,
    vNeverExceed: 108
  };
  specs.vRotate = specs.vStall * 1.12;

  // ------------------------------------------------------------------ scratch (no garbage)
  var FWD = [0, 0, -1], UP = [0, 1, 0], RIGHT = [1, 0, 0];
  var qc = new Float32Array(4);
  var tA = v3.create(), tB = v3.create(), tC = v3.create(), tD = v3.create();
  var wind = v3.create(), air = v3.create(), vb = v3.create();
  var force = v3.create(), torque = v3.create(), angAcc = v3.create();
  var liftDir = v3.create(), nrm = v3.create(), wp = v3.create(), rel = v3.create();
  var fwdG = v3.create(), latG = v3.create(), vPt = v3.create(), fC = v3.create(), fB = v3.create();
  var clOut = { stall: 0, aS: 0 };
  var NO_EVENTS = [], evBuf = [];

  function num(x, d) { return (typeof x === 'number' && isFinite(x)) ? x : d; }
  function sat(x) { return x < -1 ? -1 : x > 1 ? 1 : x; }

  // body -> world for a direction
  function toWorld(out, a, q) { return v3.transformQuat(out, a, q); }
  function toBody(out, a, q) {
    qc[0] = -q[0]; qc[1] = -q[1]; qc[2] = -q[2]; qc[3] = q[3];
    return v3.transformQuat(out, a, qc);
  }

  // q = q * exp(w dt / 2), allocation-free version of RL.quat.integrateLocal.
  function integrateQuat(q, w, dt) {
    var wx = w[0], wy = w[1], wz = w[2];
    var mag = Math.sqrt(wx * wx + wy * wy + wz * wz);
    var ang = mag * dt;
    if (ang < 1e-10) return;
    var s = Math.sin(ang * 0.5) / mag, c = Math.cos(ang * 0.5);
    var bx = wx * s, by = wy * s, bz = wz * s, bw = c;
    var ax = q[0], ay = q[1], az = q[2], aw = q[3];
    var x = ax * bw + aw * bx + ay * bz - az * by;
    var y = ay * bw + aw * by + az * bx - ax * bz;
    var z = az * bw + aw * bz + ax * by - ay * bx;
    var ww = aw * bw - ax * bx - ay * by - az * bz;
    var l = Math.sqrt(x * x + y * y + z * z + ww * ww) || 1;
    q[0] = x / l; q[1] = y / l; q[2] = z / l; q[3] = ww / l;
  }

  // ------------------------------------------------------------------ state
  function create() {
    var p = {
      pos: v3.create(0, C.airfield.elevation + P.gearHeight - P.staticSag, 0),
      vel: v3.create(), quat: RL.quat.create(), angVel: v3.create(),
      forward: v3.create(0, 0, -1), up: v3.create(0, 1, 0), right: v3.create(1, 0, 0),
      throttle: 0, rpm: P.idleRpm, flaps: 0, flapsNotch: 0, gearDown: true, gear: 1, brake: 0,
      onGround: true, wheelsOnGround: 3,
      airspeed: 0, groundSpeed: 0, verticalSpeed: 0, altitude: 0, agl: 0,
      aoa: 0, slip: 0, gForce: 1, stall: false, stallWarning: 0, stallProtect: 0,
      heading: 0, pitch: 0, roll: 0,
      surfaces: { aileron: 0, elevator: 0, rudder: 0 },
      crashed: false, crashReason: '', smoke: false, time: 0,
      // extras (not in the contract, read by model.js / effects)
      gearCompression: [0, 0, 0],       // m, per wheel (nose, left, right)
      wheelContact: [false, false, false],
      thrust: 0, overspeed: 0, steer: 0,
      // private flight-phase bookkeeping
      _phase: 'ground', _noContact: 0, _sinceTouchdown: 99, _bounced: false, _gFilt: 1,
      _colliders: null, _colT: -1
    };
    reset(p, C.spawn);
    return p;
  }

  function levelAlpha(speed, flaps) {
    var q = 0.5 * RHO * speed * speed;
    var cl = P.weight / Math.max(q * P.wingArea, 1);
    return M.clamp((cl - P.cl0 - P.clFlaps * flaps) / P.clAlpha, -4 * DEG, 12 * DEG);
  }

  function reset(p, spawn) {
    spawn = spawn || C.spawn;
    var W = RL.World;
    var hdg = num(spawn.heading, 0) * DEG;
    var x = num(spawn.x, 0), z = num(spawn.z, 0);
    p.crashed = false; p.crashReason = '';
    v3.set(p.angVel, 0, 0, 0);
    p.surfaces.aileron = 0; p.surfaces.elevator = 0; p.surfaces.rudder = 0;
    p.stall = false; p.stallWarning = 0; p.stallProtect = 0; p.brake = 0; p.smoke = false; p.time = 0;
    p.flapsNotch = 0; p.flaps = 0; p.steer = 0; p.overspeed = 0; p._handsOff = 0;
    p._bounced = false; p._sinceTouchdown = 99; p._colT = -1;
    var onGround = spawn.onGround !== false && spawn.y === undefined;
    if (onGround) {
      // Rest exactly in static equilibrium on the gear: no bounce, no creep.
      RL.quat.fromHeadingPitchRoll(p.quat, hdg, 0, 0);
      var g = W ? W.surfaceHeightAt(x, z) : C.airfield.elevation;
      v3.set(p.pos, x, g + P.gearHeight - P.staticSag, z);
      v3.set(p.vel, 0, 0, 0);
      p.gearDown = true; p.gear = 1;
      p.throttle = 0; p.rpm = P.idleRpm;
      p._phase = 'ground'; p._noContact = 0;
      p.onGround = true; p.wheelsOnGround = 3;
      for (var i = 0; i < 3; i++) { p.gearCompression[i] = P.staticSag; p.wheelContact[i] = true; }
    } else {
      var spd = Math.max(0, num(spawn.speed, 55));
      var a = spd > 5 ? levelAlpha(spd, 0) : 0;
      RL.quat.fromHeadingPitchRoll(p.quat, hdg, a, 0);
      var y = num(spawn.y, (W ? W.surfaceHeightAt(x, z) : 0) + 300);
      v3.set(p.pos, x, y, z);
      v3.set(p.vel, Math.sin(hdg) * spd, 0, -Math.cos(hdg) * spd);
      p.gearDown = spawn.gearDown === true; p.gear = p.gearDown ? 1 : 0;
      p.throttle = 0.6; p.rpm = P.idleRpm + (1 - P.idleRpm) * 0.6;
      p._phase = 'air'; p._noContact = 10;
      p.onGround = false; p.wheelsOnGround = 0;
      for (var j = 0; j < 3; j++) { p.gearCompression[j] = 0; p.wheelContact[j] = false; }
    }
    p._gFilt = 1;
    updateDerived(p, W, 0);
    return p;
  }

  // ------------------------------------------------------------------ derived instrument values
  function updateDerived(p, W, dt) {
    toWorld(p.forward, FWD, p.quat);
    toWorld(p.up, UP, p.quat);
    toWorld(p.right, RIGHT, p.quat);
    var f = p.forward, r = p.right, u = p.up;
    p.pitch = Math.asin(M.clamp(f[1], -1, 1)) * M.RAD;
    var h = Math.atan2(f[0], -f[2]) * M.RAD;
    p.heading = h < 0 ? h + 360 : h;
    p.roll = Math.atan2(-r[1], u[1]) * M.RAD;
    p.groundSpeed = Math.sqrt(p.vel[0] * p.vel[0] + p.vel[2] * p.vel[2]);
    p.verticalSpeed = p.vel[1];
    p.altitude = p.pos[1];
    var sh = W ? W.surfaceHeightAt(p.pos[0], p.pos[2]) : C.airfield.elevation;
    p.agl = p.pos[1] - sh;
    if (dt === 0) {
      // fresh reset: air data from still air
      var sp = v3.length(p.vel);
      p.airspeed = sp; p.aoa = 0; p.slip = 0; p.gForce = 1;
    }
  }

  // ------------------------------------------------------------------ helpers
  function crash(p, events, reason, speed) {
    if (p.crashed) return;
    p.crashed = true;
    p.crashReason = reason;
    events.push({ type: 'crash', reason: reason, speed: speed });
    v3.set(p.vel, 0, 0, 0);
    v3.set(p.angVel, 0, 0, 0);
    p.stall = false; p.stallWarning = 0;
  }

  function colliderList(p, W) {
    // World.getColliders() concatenates arrays; cache it and refresh once a second.
    if (!p._colliders || p.time - p._colT > 1 || p.time < p._colT) {
      p._colliders = (W && W.getColliders) ? W.getColliders() : [];
      p._colT = p.time;
    }
    return p._colliders;
  }

  function hitCollider(list, pt) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c.type === 'box') {
        if (pt[0] >= c.min[0] && pt[0] <= c.max[0] && pt[1] >= c.min[1] && pt[1] <= c.max[1] &&
            pt[2] >= c.min[2] && pt[2] <= c.max[2]) return c;
      } else if (c.type === 'sphere') {
        var dx = pt[0] - c.center[0], dy = pt[1] - c.center[1], dz = pt[2] - c.center[2];
        if (dx * dx + dy * dy + dz * dz <= c.radius * c.radius) return c;
      }
    }
    return null;
  }

  function nearAnyCollider(list, pos, margin) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c.type === 'box') {
        if (pos[0] >= c.min[0] - margin && pos[0] <= c.max[0] + margin && pos[1] >= c.min[1] - margin &&
            pos[1] <= c.max[1] + margin && pos[2] >= c.min[2] - margin && pos[2] <= c.max[2] + margin) return true;
      } else if (c.type === 'sphere') {
        var dx = pos[0] - c.center[0], dy = pos[1] - c.center[1], dz = pos[2] - c.center[2];
        var rr = c.radius + margin;
        if (dx * dx + dy * dy + dz * dz <= rr * rr) return true;
      }
    }
    return false;
  }

  function headingErrorToRunway(hdg) {
    // signed degrees from the nearest runway direction (36 = 0 deg or 18 = 180 deg)
    var e0 = M.wrapPi(hdg * DEG) * M.RAD;
    var e1 = M.wrapPi((hdg - 180) * DEG) * M.RAD;
    return Math.abs(e0) < Math.abs(e1) ? e0 : e1;
  }

  // ------------------------------------------------------------------ one physics sub-step
  function subStep(p, c, dt, W, events) {
    p.time += dt;
    var q = p.quat, vel = p.vel, w = p.angVel, pos = p.pos;

    // ---- controls -> smoothed surfaces, engine, gear/flaps animation
    var inPitch = sat(num(c.pitch, 0)), inRoll = sat(num(c.roll, 0)), inYaw = sat(num(c.yaw, 0));
    var thr = M.saturate(num(c.throttle, 0));
    var sf = p.surfaces;
    sf.aileron = M.damp(sf.aileron, inRoll, 16, dt);
    sf.elevator = M.damp(sf.elevator, inPitch, 13, dt);
    sf.rudder = M.damp(sf.rudder, inYaw, 10, dt);
    p.throttle = thr;
    p.brake = M.saturate(num(c.brake, 0));
    p.smoke = !!c.smoke;
    var rpmTarget = P.idleRpm + (1 - P.idleRpm) * thr;
    p.rpm = M.damp(p.rpm, rpmTarget, rpmTarget > p.rpm ? 1.5 : 1.1, dt);
    p.gear = M.approach(p.gear, p.gearDown ? 1 : 0, dt / P.gearTime);
    p.flaps = M.approach(p.flaps, p.flapsNotch / 2, dt * P.flapRate);

    toWorld(p.forward, FWD, q);
    toWorld(p.up, UP, q);
    toWorld(p.right, RIGHT, q);

    // ---- air data (airspeed is relative to the moving air: wind, gusts, thermals)
    if (W && W.windAt) W.windAt(pos[0], pos[1], pos[2], p.time, wind); else v3.set(wind, 0, 0, 0);
    if (!(isFinite(wind[0]) && isFinite(wind[1]) && isFinite(wind[2]))) v3.set(wind, 0, 0, 0);
    v3.sub(air, vel, wind);
    var V = v3.length(air);
    toBody(vb, air, q);
    var alpha = 0, beta = 0;
    if (V > 0.5) {
      alpha = Math.atan2(-vb[1], -vb[2]);
      beta = Math.asin(M.clamp(vb[0] / V, -1, 1));
    }
    var qbar = 0.5 * RHO * V * V;
    var qS = qbar * P.wingArea;
    var surfH = W ? W.surfaceHeightAt(pos[0], pos[2]) : C.airfield.elevation;

    // ---- aerodynamic coefficients
    var cl = clCurve(alpha, p.flaps, clOut);
    var stallAmt = clOut.stall, aS = clOut.aS;
    var hw = Math.max(0, pos[1] - 0.35 - surfH) / P.span;       // wing height / span
    var ge = (16 * hw * hw) / (1 + 16 * hw * hw);                 // ground effect on induced drag
    cl *= 1 + 0.07 * (1 - ge) * (1 - stallAmt);
    var sa = Math.sin(alpha), sb = Math.sin(beta);
    var cd = P.cd0 + P.cdGear * p.gear + P.cdFlaps * p.flaps +
      ge * cl * cl / (Math.PI * P.oswald * P.aspect) +
      stallAmt * 1.25 * sa * sa + 0.45 * sb * sb;
    var overspeed = Math.max(0, V - specs.vNeverExceed);
    if (overspeed > 0) cd += 0.0006 * overspeed * overspeed;
    p.overspeed = M.saturate(overspeed / 15);
    var cy = -P.cyBeta * sb;

    // ---- engine thrust along the nose
    var spool = M.saturate((p.rpm - P.idleRpm) / (1 - P.idleRpm));
    var vf = Math.max(0, -vb[2]);
    var tLin = spool * (P.thrustStatic + (P.thrustAt36 - P.thrustStatic) * Math.min(vf, 36) / 36);
    var tPow = P.power * Math.pow(spool, P.powerExp) / Math.max(vf, 1);
    var thrust = Math.min(tLin, tPow) - P.windmill * vf * vf * (1 - spool) * (1 - spool);
    if (p.crashed) thrust = 0;
    p.thrust = thrust;

    // ---- forces (world)
    v3.set(force, 0, -P.weight, 0);
    v3.scaleAndAdd(force, force, p.forward, thrust);
    if (V > 0.5) {
      var invV = 1 / V;
      // lift is perpendicular to the relative wind, in the plane of symmetry
      v3.cross(liftDir, p.right, air);
      var ll = v3.length(liftDir);
      if (ll > 1e-3 * V) v3.scaleAndAdd(force, force, liftDir, qS * cl / ll);
      v3.scaleAndAdd(force, force, air, -qS * cd * invV);
      v3.scaleAndAdd(force, force, p.right, qS * cy);
    }

    // ---- aerodynamic angular accelerations (body)
    var qn = Math.min(qbar / P.qRef, 4);
    var qnT = Math.min((qbar + P.propWash * Math.max(0, thrust) / P.propDisk) / P.qRef, 4);
    var sq = Math.sqrt(qn);
    var qnA = qn < 1.3 ? qn : 1.3 + 0.3 * (qn - 1.3);
    var el = sf.elevator, ai = sf.aileron, ru = sf.rudder;
    var stallSign = alpha >= 0 ? 1 : -1;
    var airborne = p._phase !== 'ground';
    // Rotation of the flight path itself (from the current acceleration). Damping acts on the
    // body rates relative to it, so steady turns / loops are not resisted (no overbanking, the
    // commanded AoA is reached in a pull) while oscillations about the path are damped.
    var pathPitch = 0, pathYaw = 0, turnRoll = 0;
    if (airborne && V > 12) {
      v3.cross(tC, air, force);
      v3.scale(tC, tC, 1 / (V * V * P.mass));
      pathPitch = v3.dot(tC, p.right);
      pathYaw = v3.dot(tC, p.up);
      var vh2 = air[0] * air[0] + air[2] * air[2];
      if (vh2 > 100) turnRoll = -(tC[1] * V * V / vh2) * p.forward[1];
    }
    // Stability augmentation ("mild pitch stability"): with the stick centred the aeroplane
    // holds its flight path with a gentle return toward level (bank compensated, so banked turns
    // hold altitude); a steady stick holds a steady climb angle. The hold fades out approaching
    // the stall, so a slow aeroplane lowers its nose toward trim by itself.
    var aNeutral = P.alphaTrim, hold = 0;
    if (airborne && V > 5) {
      var vsNow = M.lerp(specs.vStall, specs.vStallFlaps, p.flaps);
      // With flaps the fade band moves closer to the (lower) flapped stall speed and the hold stays
      // partly on, so a flapped approach keeps a damped flight path instead of a long, lightly
      // damped phugoid (the flap-drop balloon and a sink rate that swings +5..-9 m/s).
      hold = M.smoothstep(M.lerp(1.12, 1.08, p.flaps) * vsNow, M.lerp(1.45, 1.30, p.flaps) * vsNow, V) *
        (1 - P.holdFlaps * p.flaps);
      if (hold > 0) {
        var sg = M.clamp(air[1] / V, -1, 1), cg = Math.sqrt(1 - sg * sg);
        var cphi = M.clamp(p.up[1] / Math.max(0.2, Math.sqrt(Math.max(0, 1 - p.forward[1] * p.forward[1]))), -1, 1);
        // Bank compensation (1/cos bank): stick centred it reaches ~3 g (70 deg) so steep turns
        // hold altitude; with the stick pulled it stays at the old 2 g cap so full-back pulls
        // don't gain AoA on top of it and stall. The return-to-level term is signed with the
        // bank (inverted it pulls the nose up through the top) and kept alive near vertical, so
        // a hands-off dive, upright or inverted, flattens out instead of running past VNE.
        var bankFloor = M.lerp(0.111, 0.25, Math.min(1, Math.abs(el) * 2));
        var nHold = cg * cphi / Math.max(cphi * cphi, bankFloor) -
          cphi * V * sg * Math.max(cg, 0.5) / (P.pathReturn * G);
        var aHold = (nHold * P.weight / Math.max(qS, 1) - P.cl0 - P.clFlaps * p.flaps) / P.clAlpha;
        aHold = M.clamp(aHold, P.alphaStallNeg + 3 * DEG, aS - 2.5 * DEG);
        aNeutral += hold * (aHold - P.alphaTrim);
      }
    }
    // Full stick at speed stops just short of the critical AoA; slow (hold faded) it reaches past
    // it, so the aeroplane can still be stalled deliberately.
    var elevGain = airborne ? 1 + 0.4 * (1 - hold) : 1;
    // Takeoff / low-level protection, full on the ground and fading out over P.protectAgl.
    // (1) At rotation speed the prop wash roughly doubles elevator power; capped so the stick
    // that lifts the nose wheel isn't also the stick that over-rotates into a stall. The cap only
    // bites when slow under power, and not at height: the slow, full-power top of a loop needs
    // the blown elevator.
    // A held pull also stops adding nose-up near the critical AoA (the limiter below alone can't
    // out-pull a full, blown elevator at liftoff speed) and, while slow, past a climb attitude of
    // ~20 deg, so holding the stick back after rotation settles into a steady full-power climb
    // instead of pulling up into a low-level loop that runs out of speed. (With speed in hand -
    // hold - steep pull-ups near the ground, e.g. out of the canyon, are not limited.)
    var lowF = airborne ? 1 - M.smoothstep(P.protectAgl[0], P.protectAgl[1], p.agl) : 1;
    var qnE = M.lerp(qnT, Math.min(qnT, qn * 1.4 + 0.05), lowF);
    var elE = el > 0 ? el * (1 - lowF * Math.max(M.smoothstep(aS - 3.5 * DEG, aS - 0.5 * DEG, alpha),
      M.smoothstep(0.3, 0.42, p.forward[1]) * (1 - hold))) : el;
    angAcc[0] = qnE * P.kElev * elevGain * elE + qn * P.kAlpha * (aNeutral - sa) -
      (P.dampPitch0 + P.dampPitch * sq + (airborne ? 0 : 2.5)) * (w[0] - pathPitch) -
      qn * P.stallPitch * stallAmt * stallSign;
    // (2) Soft AoA limiter while the augmentation is active (i.e. with speed in hand): hard pulls
    // ride the buffet instead of departing. Slow, the hold has faded and a stall is possible -
    // except near the ground (lowF), where holding the stick back must give a climb, not a
    // stall onto the runway. Scaled with the prop-blown dynamic pressure so it matches the
    // elevator it is working against. Exposed as plane.stallProtect for the warnings.
    // Only meaningful with air arriving over the nose: parked or taxiing downwind, AoA reads
    // about +/-180 deg and an unbounded correction would stand the aeroplane on its tail.
    var lim = Math.max(hold, lowF * M.smoothstep(3, 8, -vb[2]));
    p.stallProtect = lim;
    if (lim > 0) {
      var aHi = aS - 1.5 * DEG, aLo = P.alphaStallNeg + 1.5 * DEG;
      if (alpha > aHi) angAcc[0] -= lim * qnT * P.kAlpha * 3 * Math.min(alpha - aHi, 10 * DEG);
      else if (alpha < aLo) angAcc[0] -= lim * qnT * P.kAlpha * 3 * Math.max(alpha - aLo, -10 * DEG);
    }
    // in a stall the wing drops toward the slip side (gently, this is a forgiving aeroplane)
    var drop = airborne ? stallAmt * qn * (5 * sb + 0.5 * Math.sin(p.time * 1.7)) : 0;
    angAcc[2] = -qnA * P.kAil * ai * (1 - 0.5 * stallAmt) - (P.dampRoll0 + P.dampRoll * sq) * (w[2] - turnRoll) +
      P.kDihedral * qn * sb + drop;
    // (weathervaning is mostly resisted by the tyres on the ground: a light crosswind shouldn't
    // turn the aeroplane off the runway during a hands-off takeoff roll)
    angAcc[1] = -qnT * P.kRud * ru - qn * P.kBeta * sb * (airborne ? 1 : 0.35) -
      (P.dampYaw0 + P.dampYaw * sq) * (w[1] - pathYaw);
    // Hands-off in a steep-bank dive: roll gently back toward wings-level so the path-return
    // augmentation can pull out, instead of the dive tightening into a spiral past VNE. Stops
    // short of ~120 deg of bank so inverted recoveries (which pull through) are left alone.
    if (airborne && Math.abs(el) < 0.05 && Math.abs(ai) < 0.05) p._handsOff = (p._handsOff || 0) + dt;
    else p._handsOff = 0;
    var absRoll = Math.abs(p.roll);
    if (p._handsOff > 1 && p.pitch < -15) {
      angAcc[2] += Math.sign(p.roll) * qn * 1.5 * M.smoothstep(20, 45, absRoll) * (1 - M.smoothstep(112, 122, absRoll));
    }
    if (p.overspeed > 0) {
      // buffet
      angAcc[0] += p.overspeed * 3 * Math.sin(p.time * 37);
      angAcc[2] += p.overspeed * 4 * Math.sin(p.time * 29 + 1);
    }

    // ---- ground contacts (per-wheel spring-dampers + tyre friction)
    v3.set(torque, 0, 0, 0);
    var wheels = 0, nTotal = 0, gearOk = p.gear >= 0.95;
    var steerMax = M.lerp(0.55, 0.07, M.smoothstep(2, 26, p.groundSpeed));
    p.steer = inYaw * steerMax;
    var surfType = null, mu = P.muRoll;
    if (p.agl < 6 && W && W.surfaceAt) {
      surfType = W.surfaceAt(pos[0], pos[2]);
      mu = surfType === 'grass' ? 0.06 : surfType === 'rough' ? 0.09 : P.muRoll;
    }
    var firstContact = -1, noseOnly = true, contactSink = 0, noseSink = 0;
    for (var i = 0; i < 3; i++) {
      var wh = WHEELS[i];
      p.wheelContact[i] = false;
      p.gearCompression[i] = 0;
      if (!gearOk) continue;
      toWorld(wp, wh.p, q);
      v3.add(wp, wp, pos);
      var gy = W ? W.surfaceHeightAt(wp[0], wp[2]) : C.airfield.elevation;
      var pen = gy - wp[1];
      if (!(pen > 0)) continue;
      if (W && W.isWater && W.isWater(wp[0], wp[2]) && wp[1] < W.waterLevel) {
        crash(p, events, 'water', v3.length(vel));
        return;
      }
      if (W && W.normalAt) W.normalAt(wp[0], wp[2], nrm); else v3.set(nrm, 0, 1, 0);
      // velocity of the contact point
      v3.cross(rel, w, wh.p);
      toWorld(rel, rel, q);
      v3.add(vPt, vel, rel);
      var vn = v3.dot(vPt, nrm);
      var penN = pen * nrm[1];
      var N = wh.k * penN - wh.c * vn;
      if (penN > P.stroke) N += wh.k * 12 * (penN - P.stroke);
      if (N < 0) N = 0;
      p.wheelContact[i] = true;
      p.gearCompression[i] = Math.min(penN, P.stroke);
      wheels++;
      nTotal += N;
      if (firstContact < 0) firstContact = i;
      if (i > 0) noseOnly = false;
      contactSink = Math.max(contactSink, -vn);
      if (i === 0) noseSink = -vn;
      // tyre frame on the ground plane
      if (wh.steer) v3.set(tA, Math.sin(p.steer), 0, -Math.cos(p.steer));
      else v3.copy(tA, FWD);
      toWorld(fwdG, tA, q);
      v3.scaleAndAdd(fwdG, fwdG, nrm, -v3.dot(fwdG, nrm));
      v3.normalize(fwdG, fwdG);
      v3.cross(latG, fwdG, nrm);
      var vLong = v3.dot(vPt, fwdG), vLat = v3.dot(vPt, latG);
      var muL = mu + (wh.brake ? P.muBrake * p.brake : 0);
      var fLong = -N * muL * sat(vLong / 0.3);
      var fLat = -N * P.muLat * sat(vLat / 0.15);          // stiff sideways: tyres don't creep
      v3.scale(fC, nrm, N);
      v3.scaleAndAdd(fC, fC, fwdG, fLong);
      v3.scaleAndAdd(fC, fC, latG, fLat);
      v3.add(force, force, fC);
      toBody(fB, fC, q);
      v3.cross(tB, wh.p, fB);
      v3.add(torque, torque, tB);
      // speed-dependent wheel/ground drag (tyre scrub, runway roughness). Applied through the
      // CG so it doesn't pitch the nose down and fight rotation. Tunes the takeoff roll.
      v3.scaleAndAdd(force, force, fwdG, -N * P.muRollSpeed * vLong);
    }
    p.wheelsOnGround = wheels;

    // ---- leaving the map (the Game may warn earlier; this is the hard edge)
    if (W && W.outOfBounds && W.outOfBounds(pos[0], pos[2]) > BOUNDS_MARGIN) {
      crash(p, events, 'bounds', v3.length(vel));
      return;
    }

    // ---- hard points: terrain, water, colliders
    var skid = false;
    var checkGround = p.agl < 12 || (W && W.heightAt && W.heightAt(pos[0], pos[2]) > pos[1] - 12);
    var cols = colliderList(p, W);
    var nearCol = cols.length && nearAnyCollider(cols, pos, 8);
    if (checkGround || nearCol) {
      for (var k = 0; k < POINTS.length; k++) {
        var hp = POINTS[k];
        toWorld(wp, hp.p, q);
        v3.add(wp, wp, pos);
        if (nearCol) {
          var hit = null;
          for (var ci = 0; ci < COLLIDER_POINTS.length; ci++) if (COLLIDER_POINTS[ci] === k) { hit = hitCollider(cols, wp); break; }
          if (hit) { crash(p, events, /arch/i.test(hit.name || '') ? 'arch' : 'building', v3.length(vel)); return; }
        }
        if (!checkGround) continue;
        var gh = W ? W.surfaceHeightAt(wp[0], wp[2]) : C.airfield.elevation;
        var pen2 = gh - wp[1];
        if (!(pen2 > 0)) continue;
        if (W && W.isWater && W.isWater(wp[0], wp[2])) { crash(p, events, 'water', v3.length(vel)); return; }
        if (k === TAIL_SKID && pen2 < 0.3) {
          // tail skid: a firm spring + scraping friction (over-rotation), not a crash
          skid = true;
          if (W && W.normalAt) W.normalAt(wp[0], wp[2], nrm); else v3.set(nrm, 0, 1, 0);
          v3.cross(rel, w, hp.p);
          toWorld(rel, rel, q);
          v3.add(vPt, vel, rel);
          var vn2 = v3.dot(vPt, nrm);
          var N2 = Math.max(0, 60000 * pen2 * nrm[1] - 4000 * vn2);
          v3.scaleAndAdd(tC, vPt, nrm, -vn2);
          var vt = v3.length(tC);
          v3.scale(fC, nrm, N2);
          if (vt > 1e-4) v3.scaleAndAdd(fC, fC, tC, -0.5 * N2 * Math.min(1, vt / 0.5) / vt);
          v3.add(force, force, fC);
          toBody(fB, fC, q);
          v3.cross(tB, hp.p, fB);
          v3.add(torque, torque, tB);
          continue;
        }
        var reason = hp.reason;
        if (reason === 'belly' || (hp.name === 'prop' && !gearOk)) reason = gearOk ? 'terrain' : 'bellyLanding';
        else if (reason === 'tail') reason = 'terrain';
        else if (reason !== 'terrain') {
          // nose / wingtip strikes are landing mishaps; flying into a hillside is 'terrain'
          if (W && W.normalAt) W.normalAt(wp[0], wp[2], nrm); else v3.set(nrm, 0, 1, 0);
          var nearLanding = nrm[1] > 0.9 && p.agl < P.gearHeight + 1.5 && vel[1] > -8;
          if (!nearLanding) reason = 'terrain';
        }
        crash(p, events, reason, v3.length(vel));
        return;
      }
    }

    // ---- touchdown / liftoff / bounce bookkeeping (before integration: sink rate at impact)
    var contact = wheels > 0 || skid;
    if (contact) {
      var sink = Math.max(contactSink, -vel[1]);
      if (p._phase === 'air' || p._phase === 'bounce') {
        var surface = surfType || (W && W.surfaceAt ? W.surfaceAt(pos[0], pos[2]) : 'runway');
        var onRunway = C.isOnRunway(pos[0], pos[2]);
        var gs = p.groundSpeed;
        var rollDeg = Math.atan2(-p.right[1], p.up[1]) * M.RAD;
        if (p._phase === 'air') {
          var hErr = headingErrorToRunway(Math.atan2(p.forward[0], -p.forward[2]) * M.RAD);
          events.push({
            type: 'touchdown', verticalSpeed: sink, speed: gs, airspeed: V, surface: surface,
            onRunway: onRunway, centerlineOffset: C.runwayCenterlineOffset(pos[0]),
            headingError: hErr, roll: rollDeg, noseFirst: noseOnly && firstContact === 0
          });
          p._sinceTouchdown = 0;
          p._bounced = false;
        }
        p._phase = 'ground';
        if (!gearOk) { crash(p, events, 'bellyLanding', v3.length(vel)); return; }
        if (sink > HARD_LANDING) { crash(p, events, 'hardLanding', v3.length(vel)); return; }
        if (noseOnly && firstContact === 0 && sink > NOSE_FIRST) { crash(p, events, 'noseStrike', v3.length(vel)); return; }
        if (Math.abs(rollDeg) > WING_STRIKE_ROLL) { crash(p, events, 'wingStrike', v3.length(vel)); return; }
        if (surface === 'water') { crash(p, events, 'water', v3.length(vel)); return; }
        if (surface === 'rough' && gs > 12) { crash(p, events, 'rough', v3.length(vel)); return; }
      } else if (noseSink > HARD_LANDING + 1) {
        // slamming the nose wheel down after a main-gear touchdown
        crash(p, events, 'noseStrike', v3.length(vel));
        return;
      }
      if (surfType === 'rough' && p.groundSpeed > 18) { crash(p, events, 'rough', v3.length(vel)); return; }
      p._noContact = 0;
    } else {
      p._noContact += dt;
      if (p._phase === 'ground') {
        var clearance = p.agl - (P.gearHeight - 0.05);
        if (p._sinceTouchdown < 2.5) {
          if (clearance > 0.25 && !p._bounced) {
            p._bounced = true;
            p._phase = 'bounce';
            events.push({ type: 'bounce', verticalSpeed: vel[1] });
          }
        } else if (p._noContact > 0.25 && clearance > 0.5) {
          p._phase = 'air';
          events.push({ type: 'liftoff', speed: V });
        }
      } else if (p._phase === 'bounce' && p._noContact > 3) {
        // the bounce turned into a go-around
        p._phase = 'air';
        events.push({ type: 'liftoff', speed: V });
      }
    }
    p._sinceTouchdown += dt;
    p.onGround = contact || (p._phase === 'ground' && p._noContact < 0.12);

    // ---- integrate
    var invM = 1 / P.mass;
    v3.scaleAndAdd(vel, vel, force, invM * dt);
    angAcc[0] += torque[0] / P.inertia[0];
    angAcc[1] += torque[1] / P.inertia[1];
    angAcc[2] += torque[2] / P.inertia[2];
    w[0] += angAcc[0] * dt; w[1] += angAcc[1] * dt; w[2] += angAcc[2] * dt;

    // Parking brake of physics: at (near) standstill on all wheels, static friction holds the
    // aeroplane exactly still unless the driving force breaks it loose. Prevents creep/jitter.
    // (Tyre friction is velocity-saturated, so at standstill `force` is the driving force.)
    if (wheels === 3 && p.groundSpeed < 0.3 && Math.abs(w[1]) < 0.08) {
      var fh = Math.sqrt(force[0] * force[0] + force[2] * force[2]);
      var holdF = nTotal * (P.muStatic + P.muBrake * p.brake);
      if (fh < holdF) {
        vel[0] = 0; vel[2] = 0;
        w[1] = 0;
        w[2] *= 0.9;
      }
    }

    var wm = Math.sqrt(w[0] * w[0] + w[1] * w[1] + w[2] * w[2]);
    if (wm > 7) v3.scale(w, w, 7 / wm);
    var vm = v3.length(vel);
    if (vm > 220) v3.scale(vel, vel, 220 / vm);
    v3.scaleAndAdd(pos, pos, vel, dt);
    integrateQuat(q, w, dt);

    // ---- air data for instruments
    p.airspeed = V;
    p.aoa = alpha;
    p.slip = beta;
    // load factor = specific force (everything but gravity) along the body up axis
    v3.set(tD, force[0], force[1] + P.weight, force[2]);
    p._gFilt = M.damp(p._gFilt, v3.dot(tD, p.up) / P.weight, 12, dt);
    p.gForce = p._gFilt;

    // ---- stall state (airborne only)
    airborne = p._phase !== 'ground';
    var aN = P.alphaStallNeg;
    var warn = Math.max(M.smoothstep(aS - 5 * DEG, aS, alpha), M.smoothstep(aN + 4 * DEG, aN, alpha));
    p.stallWarning = airborne && V > 3 ? warn : 0;
    var stalled = airborne && (alpha > aS + 1.2 * DEG || alpha < aN - 1.2 * DEG);
    var recovered = !airborne || (alpha < aS - 1.5 * DEG && alpha > aN + 1.5 * DEG);
    if (!p.stall && stalled) { p.stall = true; events.push({ type: 'stall' }); }
    else if (p.stall && recovered) { p.stall = false; events.push({ type: 'stallRecover' }); }
  }

  // ------------------------------------------------------------------ public step
  function step(p, controls, dt, world) {
    evBuf.length = 0;
    NO_EVENTS.length = 0;
    if (!p || !(dt > 0)) return NO_EVENTS;
    var W = world || RL.World;
    controls = controls || {};
    if (p.crashed) {
      // wreck: engine winds down, nothing moves
      p.rpm = M.damp(p.rpm, 0, 1.5, Math.min(dt, 0.1));
      p.throttle = 0; p.stall = false; p.stallWarning = 0; p.stallProtect = 0; p.smoke = false;
      v3.set(p.vel, 0, 0, 0); v3.set(p.angVel, 0, 0, 0);
      p.airspeed = 0; p.groundSpeed = 0; p.verticalSpeed = 0; p.gForce = 1;
      return NO_EVENTS;
    }
    dt = Math.min(dt, 0.1);
    var n = Math.max(1, Math.ceil(dt / MAX_SUBSTEP - 1e-6));
    var h = dt / n;
    for (var i = 0; i < n && !p.crashed; i++) subStep(p, controls, h, W, evBuf);
    if (p.crashed) settleWreck(p, W);
    // final NaN guard: never let a bad value escape into the game
    if (!isStateFinite(p)) reset(p, C.spawn);
    updateDerived(p, W, dt);
    // allocate only when something happened (rare)
    return evBuf.length ? evBuf.slice() : NO_EVENTS;
  }

  function settleWreck(p, W) {
    // keep the wreck on (not in) the surface it hit
    if (!W) return;
    var sh = W.surfaceHeightAt(p.pos[0], p.pos[2]);
    if (p.pos[1] < sh + 0.4) p.pos[1] = sh + 0.4;
  }

  function isStateFinite(p) {
    var a = p.pos, b = p.vel, q = p.quat, w = p.angVel;
    return isFinite(a[0] + a[1] + a[2] + b[0] + b[1] + b[2] + q[0] + q[1] + q[2] + q[3] + w[0] + w[1] + w[2]) &&
      isFinite(p.airspeed);
  }

  function toggleGear(p) {
    if (!p || p.crashed || p.onGround) return false;
    p.gearDown = !p.gearDown;
    return true;
  }

  function cycleFlaps(p) {
    if (!p) return 0;
    p.flapsNotch = (p.flapsNotch + 1) % 3;
    return p.flapsNotch;
  }

  RL.FlightModel = {
    create: create,
    reset: reset,
    step: step,
    toggleGear: toggleGear,
    cycleFlaps: cycleFlaps,
    specs: specs,
    params: P,
    clCurve: function (a, flaps) { return clCurve(a, flaps || 0, clOut); },
    levelAlpha: levelAlpha,
    // body-space reference points for effects / camera (nose = -Z, right = +X, up = +Y)
    points: {
      wingtipL: [-4.5, 0.02, 0.1], wingtipR: [4.5, 0.02, 0.1],
      wheels: [WHEELS[0].p, WHEELS[1].p, WHEELS[2].p],
      exhaust: [0.45, -0.25, -2.2], smoke: [0, -0.1, 4.1], tail: [0, 0.3, 4.1], nose: [0, 0, -3.55]
    }
  };
})(window.RL = window.RL || {});
