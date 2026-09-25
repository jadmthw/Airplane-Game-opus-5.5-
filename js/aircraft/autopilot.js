/*
 * Ridgeline — RL.Autopilot: steers an RL.FlightModel plane through a target point.
 *
 *   fly(plane, target v3, dt, opts) -> controls {pitch, roll, yaw, throttle, brake, smoke}
 *
 * opts (all optional):
 *   speed      target airspeed m/s (default 60)
 *   ring       the ring being flown (uses ring.dir to cross it square-on)
 *   bankLimit  degrees (default 62)
 *   takeoff    true: full-power takeoff run / rotation / initial climb while low
 *   clearance  terrain clearance to keep (default 30 m)
 *
 * Guidance: lateral = L1-style path following along the leg (previous target -> target) blended
 * into a lead-pursuit of a point behind the ring along its axis, turned into a bank command;
 * vertical = flight-path-angle command that reaches the target height a little before the
 * target, floored by a terrain look-ahead; the pitch stick is computed from the flight model's
 * own AoA-per-stick constants (model-based) plus a small integrator. Throttle holds speed.
 * Allocation-free per call (state and the controls object live on the plane).
 */
(function (RL) {
  'use strict';
  var M = RL.M, v3 = RL.v3;
  var DEG = Math.PI / 180, G = 9.81;

  function state(p) {
    if (!p._ap) {
      p._ap = {
        ctl: { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0, smoke: false },
        last: v3.create(), prev: v3.create(), has: false, iGam: 0, iSpd: 0, t: 0, escape: 0
      };
    }
    return p._ap;
  }

  var aim = v3.create(), legDir = v3.create(), rel = v3.create();
  // returned (reset) when there is no plane to keep state on
  var NEUTRAL = { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0, smoke: false };

  function groundAt(x, z) {
    var W = RL.World;
    var h = W ? W.surfaceHeightAt(x, z) : RL.Config.airfield.elevation;
    return isFinite(h) ? h : 0;
  }

  function fly(p, target, dt, opts) {
    opts = opts || {};
    if (!p) {
      NEUTRAL.pitch = NEUTRAL.roll = NEUTRAL.yaw = NEUTRAL.throttle = NEUTRAL.brake = 0;
      NEUTRAL.smoke = false;
      return NEUTRAL;
    }
    var s = state(p), c = s.ctl;
    c.brake = 0; c.smoke = false; c.yaw = 0;
    if (!target || p.crashed || !(dt > 0)) {
      c.pitch = 0; c.roll = 0; c.throttle = 0;
      return c;
    }
    var FM = RL.FlightModel, P = FM.params, specs = FM.specs;
    var V = Math.max(p.airspeed, 1);
    var vT = opts.speed || 60;

    // track the leg: when the target changes, the old target becomes the leg start
    if (!s.has) { v3.copy(s.prev, p.pos); v3.copy(s.last, target); s.has = true; }
    else if (v3.distSq(s.last, target) > 1) {
      if (v3.dist(p.pos, s.last) < 400) v3.copy(s.prev, s.last); else v3.copy(s.prev, p.pos);
      v3.copy(s.last, target);
      s.iGam = 0; s.escape = 0;
    }

    var hdg = p.heading * DEG;
    // ground track (includes wind drift) is what we steer with in the air
    var trk = p.groundSpeed > 5 ? Math.atan2(p.vel[0], -p.vel[2]) : hdg;
    var dx = target[0] - p.pos[0], dz = target[2] - p.pos[2];
    var dist = Math.sqrt(dx * dx + dz * dz);

    // ---------------------------------------------------------------- ground: takeoff roll
    if (p.onGround) {
      var ehd = M.wrapPi(Math.atan2(dx, -dz) - hdg);
      if (dist < 50) ehd = 0;
      c.throttle = 1;
      c.yaw = M.clamp(ehd * 3 + p.angVel[1] * 1.5, -1, 1);   // angVel[1] + = nose left
      c.roll = M.clamp(-p.roll * 0.05, -1, 1);
      c.pitch = p.airspeed > specs.vRotate ? 0.45 : 0;
      s.iGam = 0; s.iSpd = 0;
      return c;
    }

    // ---------------------------------------------------------------- lateral guidance
    // leg line prev -> target; L1 lookahead point on it, blended to a point on the ring axis
    v3.sub(legDir, target, s.prev);
    legDir[1] = 0;
    var legLen = v3.length(legDir);
    var L1 = Math.max(90, V * 2.6);
    if (legLen > 1) {
      v3.scale(legDir, legDir, 1 / legLen);
      v3.sub(rel, p.pos, s.prev);
      var along = rel[0] * legDir[0] + rel[2] * legDir[2];
      var ahead = Math.min(along + L1, legLen);
      aim[0] = s.prev[0] + legDir[0] * ahead; aim[2] = s.prev[2] + legDir[2] * ahead;
    } else {
      aim[0] = target[0]; aim[2] = target[2];
    }
    var ring = opts.ring;
    var bankLimit = (opts.bankLimit || 62) * DEG;
    var turnR = V * V / (G * Math.tan(bankLimit));
    if (ring && ring.dir) {
      // approaching, line up on a point behind the ring on its axis (sets up the next leg);
      // inside ~one turn radius just go for the centre - any crossing angle counts
      var lead = M.clamp((dist - 1.2 * turnR) * 0.45, 0, 110);
      var rx = target[0] - ring.dir[0] * lead, rz = target[2] - ring.dir[2] * lead;
      var wRing = 1 - M.smoothstep(250, 600, dist);
      aim[0] = M.lerp(aim[0], rx, wRing); aim[2] = M.lerp(aim[2], rz, wRing);
      if (dist < 45) { aim[0] = target[0] + ring.dir[0] * 60; aim[2] = target[2] + ring.dir[2] * 60; }
    }
    var ax = aim[0] - p.pos[0], az = aim[2] - p.pos[2];
    var eTrk = M.wrapPi(Math.atan2(ax, -az) - trk);
    // Too close to turn onto it (the classic pursuit orbit): fly straight out, then come back.
    s.t += dt;
    if (s.escape > 0) {
      s.escape -= dt;
      eTrk = 0;
    } else if (dist < 1.8 * turnR && Math.abs(M.wrapPi(Math.atan2(dx, -dz) - trk)) > 1.9) {
      s.escape = 2.6 * turnR / V;
      eTrk = 0;
    }
    var turnRate = M.clamp(eTrk * 0.9, -0.6, 0.6);
    var bankCmd = M.clamp(Math.atan(turnRate * V / G), -bankLimit, bankLimit);
    var roll = p.roll * DEG;
    var rollRateMax = Math.max(0.4, (P.kAil / P.dampRoll) * Math.sqrt(Math.max(p.airspeed, 1) / P.vRef));
    var rollRate = -p.angVel[2];                       // + = rolling right
    c.roll = M.clamp(((bankCmd - roll) * 2.6 - rollRate * 0.25) / rollRateMax, -1, 1);
    c.yaw = M.clamp(p.slip * 3, -0.5, 0.5);

    // ---------------------------------------------------------------- vertical guidance
    var dist3 = Math.max(dist, 1);
    var tgo = Math.max(dist3 / Math.max(p.groundSpeed, 20) - 1.5, 1.2);
    var vsCmd = M.clamp((target[1] - p.pos[1]) / tgo, -14, 16);
    // terrain look-ahead along the track (and toward the aim point)
    var clr = opts.clearance || 30;
    var ringAgl = target[1] - groundAt(target[0], target[2]);
    if (dist < 700) clr = Math.min(clr, Math.max(8, ringAgl * 0.6));
    var sx = Math.sin(trk), sz = -Math.cos(trk), gs = Math.max(p.groundSpeed, 25);
    var need = -1e9;
    // don't look past the target: legs between rings are guaranteed clear, the turn after isn't
    var reach = Math.max(60, dist - 20);
    for (var i = 1; i <= 6; i++) {
      var d = Math.min(gs * i * 1.1, reach);
      var gy = groundAt(p.pos[0] + sx * d, p.pos[2] + sz * d);
      need = Math.max(need, gy + clr - d * 0.08);
    }
    need = Math.max(need, groundAt(p.pos[0], p.pos[2]) + clr * 0.6);
    if (p.pos[1] < need) vsCmd = Math.max(vsCmd, Math.min(16, (need - p.pos[1]) * 0.6 + 2));
    if (opts.takeoff && p.agl < 25) vsCmd = Math.max(vsCmd, 5);
    // never ask for more climb than the speed margin over the stall can pay for
    var vs1 = specs.vStall + (specs.vStallFlaps - specs.vStall) * p.flaps;
    vsCmd = Math.min(vsCmd, Math.max(0.5, (V - vs1 * 1.15) * 0.9));
    var gCmd = Math.asin(M.clamp(vsCmd / V, -0.45, 0.45));
    var gam = Math.asin(M.clamp(p.verticalSpeed / V, -1, 1));
    var eG = gCmd - gam;
    s.iGam = M.clamp(s.iGam + eG * dt * 0.6, -0.25, 0.25);
    // desired flight-path rate -> extra load factor -> extra AoA -> stick (flight model constants)
    var cphi = Math.cos(roll);
    // (+ cancel the flight model's own return-to-level term, which the stick has to hold off)
    var nExtra = V * (eG * 0.9) / G + cphi * V * Math.sin(gam) * Math.max(Math.cos(gam), 0.5) / (P.pathReturn * G);
    var qS = 0.5 * 1.225 * V * V * P.wingArea;
    var dAlpha = nExtra * P.weight / Math.max(qS * P.clAlpha, 1);
    var perStick = P.kElev / P.kAlpha;
    var pitch = dAlpha / perStick + s.iGam;
    // stall protection: an AoA limiter a few degrees short of the critical angle
    var aLim = P.alphaStall + P.alphaStallFlaps * p.flaps - 4 * DEG;
    if (p.aoa > aLim - 3 * DEG) pitch = Math.min(pitch, (aLim - p.aoa) * 5);
    if (p.aoa > aLim) s.iGam = Math.min(s.iGam, 0);
    c.pitch = M.clamp(pitch, -0.8, 1);

    // ---------------------------------------------------------------- speed
    var eV = vT - p.airspeed;
    s.iSpd = M.clamp(s.iSpd + eV * dt * 0.02, -0.4, 0.4);
    var ff = 0.62 + p.verticalSpeed * 0.022 + (1 / Math.max(cphi, 0.4) - 1) * 0.35;
    c.throttle = M.clamp(ff + eV * 0.07 + s.iSpd, 0, 1);
    if (opts.takeoff && p.agl < 25) c.throttle = 1;
    return c;
  }

  /** Forget guidance state (call after a respawn). */
  function reset(p) { if (p && p._ap) { p._ap.has = false; p._ap.iGam = 0; p._ap.iSpd = 0; p._ap.escape = 0; } }

  RL.Autopilot = { fly: fly, reset: reset };
})(window.RL = window.RL || {});
