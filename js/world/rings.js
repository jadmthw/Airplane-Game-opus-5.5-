/*
 * Ridgeline — RL.Rings: the ring course.
 *
 *   init(gl), reset(), animate(dt), draw(frame), check(prevPos, pos), getCurrent()
 *   list [{pos, dir, radius, special, passed, index}], current, total, complete
 *
 * init() resolves Config.rings against the real terrain: heights above the ground/water, the arch
 * ring placed exactly in RL.Terrain.arch's opening (shrunk to fit), then every straight leg
 * (runway -> ring 0 -> ... -> last ring) is sampled every ~20 m and rings are raised until the
 * leg keeps 35 m of terrain clearance and misses every collider. The adjustments are summarised
 * in one console.info line and kept in Rings.stats.
 *
 * Look: the current ring is a solid glowing gold torus with a chasing highlight, a shimmering
 * membrane and a light column rising from it so it can be found from kilometres away; the next
 * ring is a dimmer cyan preview, later ones are faint; specials have their own colours (arch
 * violet, lake aqua, final green). Passed rings burst outwards and fade. Flowing chevrons mark the
 * leg from the current ring to the next one (the final ring's leg ends on the runway).
 */
(function (RL) {
  'use strict';

  var M = RL.M, v3 = RL.v3, C = RL.Config;

  var CLEARANCE = 35;        // m of terrain clearance required along every leg
  var SAMPLE_STEP = 20;      // m between clearance samples
  // A deliberately low ring (the lake ring is 14 m over the water) keeps its own clearance for
  // NEAR_HOLD m either side; beyond that the requirement ramps up to CLEARANCE.
  var NEAR_HOLD = 300, NEAR_SLOPE = 0.1;
  var START_AGL = 25;        // the first leg starts over the runway's north end, already climbing
  var START_SLOPE = 0.1;
  var COLLIDER_MARGIN = 8;   // m kept from buildings / the arch rock
  var TUBE = 1.45;           // torus tube radius (m)
  var TUBE_BUILD = 0.05;     // tube radius the unit torus mesh is built with
  var PASS_TIME = 0.9;       // s of the burst animation of a passed ring
  var COLUMN_HEIGHT = 900;

  function lin(c) { return [Math.pow(c[0], 2.2), Math.pow(c[1], 2.2), Math.pow(c[2], 2.2)]; }
  var COLORS = {
    current: lin([1.0, 0.58, 0.1]),
    next: lin([0.35, 0.85, 1.0]),
    later: lin([0.72, 0.84, 1.0]),
    arch: lin([0.74, 0.46, 1.0]),
    lake: lin([0.2, 1.0, 0.82]),
    final: lin([0.45, 1.0, 0.38])
  };

  var Rings = {
    list: [],
    current: 0,
    total: 0,
    complete: false,
    /** Resolution report: {raised: [{index, meters}], archRadius, minClearance, blocked: [...]}. */
    stats: null,
    /** Point on runway 36 the final leg aims at (touchdown aiming point). */
    runwayAim: v3.create(0, 0, 0)
  };

  // ------------------------------------------------------------------ course resolution
  function world() { return RL.World; }
  function groundAt(x, z) {
    var W = world();
    var h = W && W.surfaceHeightAt ? W.surfaceHeightAt(x, z) : C.airfield.elevation;
    return isFinite(h) ? h : C.airfield.elevation;
  }

  /** Arch opening description (RL.Terrain.arch or a Config-based fallback). */
  function archInfo() {
    var T = RL.Terrain, a = C.arch;
    if (T && T.arch && T.arch.center) {
      var d = T.arch.dir || [0, 0, -1];
      return {
        center: T.arch.center, dir: v3.normalize([0, 0, 0], [d[0], 0, d[2]]),
        H: T.arch.openingHeight || a.openingHeight, W: T.arch.openingHalfWidth || a.openingHalfWidth
      };
    }
    // fallback: canyon direction from the config path around the arch point
    var path = C.canyon.path, best = 0, bd = Infinity;
    for (var i = 0; i < path.length; i++) {
      var dd = Math.hypot(path[i][0] - a.x, path[i][1] - a.z);
      if (dd < bd) { bd = dd; best = i; }
    }
    var p0 = path[Math.max(0, best - 1)], p1 = path[Math.min(path.length - 1, best + 1)];
    var W = world();
    return {
      center: [a.x, W ? W.heightAt(a.x, a.z) : 0, a.z],
      dir: v3.normalize([0, 0, 0], [p1[0] - p0[0], 0, p1[1] - p0[1]]),
      H: a.openingHeight, W: a.openingHalfWidth
    };
  }

  function archColliders() {
    var W = world(), out = [];
    var cols = W && W.getColliders ? W.getColliders() : [];
    for (var i = 0; i < cols.length; i++) if (cols[i].type === 'sphere' && /arch/.test(cols[i].name || '')) out.push(cols[i]);
    return out;
  }

  /**
   * Largest radius (<= r0) for which a ring centered `yc` above the arch floor fits the parabolic
   * opening (half-width W*sqrt(1 - y/H)) and clears the arch rock spheres, keeping `margin`.
   */
  function fitArchRadius(arch, yc, r0, margin, rocks) {
    var across = [-arch.dir[2], 0, arch.dir[0]];
    var p = [0, 0, 0];
    for (var r = r0; r >= 8; r -= 0.5) {
      var ok = yc - r >= margin && yc + r <= arch.H - margin;
      for (var k = 0; ok && k < 48; k++) {
        var ph = k / 48 * Math.PI * 2;
        var u = Math.cos(ph) * r, y = yc + Math.sin(ph) * r;
        var hw = arch.W * Math.sqrt(Math.max(0, 1 - y / arch.H));
        if (Math.abs(u) > hw - margin) ok = false;
        p[0] = arch.center[0] + across[0] * u; p[1] = arch.center[1] + y; p[2] = arch.center[2] + across[2] * u;
        for (var s = 0; ok && s < rocks.length; s++) {
          if (v3.dist(p, rocks[s].center) < rocks[s].radius + margin * 0.5) ok = false;
        }
      }
      if (ok) return r;
    }
    return 8;
  }

  function colliderDeficit(p, cols, skipArch) {
    // how far p would have to rise to clear the collider it is in (0 if clear); -1 = arch rock hit
    for (var i = 0; i < cols.length; i++) {
      var c = cols[i], m = COLLIDER_MARGIN;
      if (c.type === 'box') {
        if (p[0] >= c.min[0] - m && p[0] <= c.max[0] + m && p[1] >= c.min[1] - m && p[1] <= c.max[1] + m &&
            p[2] >= c.min[2] - m && p[2] <= c.max[2] + m) return c.max[1] + m - p[1];
      } else if (c.type === 'sphere') {
        var dx = p[0] - c.center[0], dy = p[1] - c.center[1], dz = p[2] - c.center[2];
        var rr = c.radius + m;
        if (dx * dx + dy * dy + dz * dz <= rr * rr) {
          if (/arch/.test(c.name || '')) return skipArch ? 0 : -1;
          return c.center[1] + Math.sqrt(Math.max(0, rr * rr - dx * dx - dz * dz)) - p[1];
        }
      }
    }
    return 0;
  }

  /**
   * Worst clearance violation along the leg A -> B.
   * a/b: {pos, base (clearance at the endpoint itself), hold, slope}. Returns {def, t, arch}.
   */
  var segP = [0, 0, 0];
  function inspectLeg(a, b, cols, out) {
    var A = a.pos, B = b.pos;
    var len = v3.dist(A, B);
    var n = Math.max(2, Math.ceil(len / SAMPLE_STEP));
    out.def = 0; out.t = 0.5; out.arch = false; out.minClear = Infinity; out.minOpen = Infinity;
    for (var k = 0; k <= n; k++) {
      var t = k / n;
      v3.lerp(segP, A, B, t);
      var g = groundAt(segP[0], segP[2]);
      var req = Math.min(CLEARANCE, a.base + Math.max(0, t * len - a.hold) * a.slope,
        b.base + Math.max(0, (1 - t) * len - b.hold) * b.slope);
      var clear = segP[1] - g;
      if (clear < out.minClear) out.minClear = clear;
      if (req >= CLEARANCE && clear < out.minOpen) out.minOpen = clear;
      var def = g + req - segP[1];
      // the leg may pass the arch rock only right at the arch ring itself
      var cd = colliderDeficit(segP, cols, (a.isArch && t * len < 25) || (b.isArch && (1 - t) * len < 25));
      if (cd < 0) { out.arch = true; out.archT = t; continue; }
      if (cd > def) def = cd;
      if (def > out.def) { out.def = def; out.t = t; }
    }
    return out;
  }

  function resolveCourse() {
    var cfg = C.rings || [];
    var E = C.airfield.elevation, rw = C.airfield.runway;
    var list = [];
    var arch = archInfo();
    var rocks = archColliders();
    var W = world();
    var cols = W && W.getColliders ? W.getColliders() : [];
    var archRadius = null;
    for (var i = 0; i < cfg.length; i++) {
      var c = cfg[i];
      var r = {
        pos: v3.create(c.x, groundAt(c.x, c.z) + c.agl, c.z),
        dir: v3.create(0, 0, -1),
        radius: C.ringRadius,
        special: c.special || null,
        passed: false,
        index: i,
        // presentation state (not part of the contract)
        agl: c.agl, baseY: 0, anim: -1, glow: 0, col: v3.create(0, 0, 0),
        ax: v3.create(1, 0, 0), ay: v3.create(0, 1, 0)
      };
      if (r.special === 'arch') {
        var yc = arch.H * 0.45;
        r.pos[0] = arch.center[0]; r.pos[1] = arch.center[1] + yc; r.pos[2] = arch.center[2];
        r.radius = fitArchRadius(arch, yc, C.ringRadius, 8, rocks);
        r.agl = yc;
        archRadius = r.radius;
      }
      r.baseY = r.pos[1];
      list.push(r);
    }
    Rings.runwayAim[0] = rw.cx; Rings.runwayAim[1] = E + 1; Rings.runwayAim[2] = rw.cz + rw.length / 2 - 300;
    var start = { pos: v3.create(rw.cx, E + START_AGL, rw.cz - rw.length / 2), base: START_AGL, hold: 0, slope: START_SLOPE, fixed: true };

    function node(r) {
      return { pos: r.pos, base: Math.min(CLEARANCE, r.pos[1] - groundAt(r.pos[0], r.pos[2])), hold: NEAR_HOLD, slope: NEAR_SLOPE,
        fixed: r.special === 'arch', isArch: r.special === 'arch', ring: r };
    }

    // Iteratively raise rings until every leg is clear (bounded).
    var info = { def: 0, t: 0, arch: false, minClear: 0 };
    var blocked = [];
    for (var iter = 0; iter < 80; iter++) {
      var changed = false;
      for (i = 0; i < list.length; i++) {
        var a = i === 0 ? start : node(list[i - 1]), b = node(list[i]);
        inspectLeg(a, b, cols, info);
        if (info.arch) {
          // the straight leg clips the arch rock: pull the far ring's height toward the arch ring
          var far = a.isArch ? b : (b.isArch ? a : null);
          if (far && !far.fixed) {
            var target = (a.isArch ? a : b).pos[1];
            var minY = groundAt(far.pos[0], far.pos[2]) + Math.min(far.ring.agl, CLEARANCE);
            var ny = Math.max(minY, M.lerp(far.pos[1], target, 0.35));
            if (Math.abs(ny - far.pos[1]) > 0.2) { far.pos[1] = ny; changed = true; continue; }
          }
          if (blocked.indexOf(i) < 0) blocked.push(i);
        }
        if (info.def > 0.25) {
          var t = info.t, d = info.def + 0.5;
          var wa = 1 - t, wb = t;
          if (!a.fixed && !b.fixed) {
            var nrm = wa * wa + wb * wb;
            a.pos[1] += d * wa / nrm; b.pos[1] += d * wb / nrm;
          } else if (!a.fixed) {
            a.pos[1] += Math.min(d / Math.max(wa, 0.2), 150);
          } else if (!b.fixed) {
            b.pos[1] += Math.min(d / Math.max(wb, 0.2), 150);
          } else continue;
          changed = true;
        }
      }
      if (!changed) break;
    }

    // Orientation: face the direction of travel (prev -> next), the arch ring along the canyon.
    var prev = [0, 0, 0], next = [0, 0, 0], tan = [0, 0, 0], up = [0, 1, 0];
    for (i = 0; i < list.length; i++) {
      var ring = list[i];
      v3.copy(prev, i === 0 ? start.pos : list[i - 1].pos);
      v3.copy(next, i === list.length - 1 ? Rings.runwayAim : list[i + 1].pos);
      v3.sub(tan, next, prev);
      v3.normalize(tan, tan);
      if (ring.special === 'arch') {
        var s = v3.dot(tan, arch.dir) >= 0 ? 1 : -1;
        v3.set(tan, arch.dir[0] * s, 0, arch.dir[2] * s);
      }
      tan[1] = M.clamp(tan[1], -0.35, 0.35);
      v3.normalize(ring.dir, tan);
      // in-plane basis: ay = up projected into the ring plane, ax = ay x dir
      v3.scaleAndAdd(ring.ay, up, ring.dir, -v3.dot(up, ring.dir));
      v3.normalize(ring.ay, ring.ay);
      v3.cross(ring.ax, ring.ay, ring.dir);
    }

    // Final report (runway -> rings, plus the final ring -> runway aim which is only reported)
    var raised = [], minClear = Infinity, minOpen = Infinity;
    for (i = 0; i < list.length; i++) {
      var dy = list[i].pos[1] - list[i].baseY;
      if (dy > 0.05) raised.push({ index: i, meters: Math.round(dy * 10) / 10 });
      inspectLeg(i === 0 ? start : node(list[i - 1]), node(list[i]), cols, info);
      minClear = Math.min(minClear, info.minClear);
      minOpen = Math.min(minOpen, info.minOpen);
      if (info.def > 0.5 && blocked.indexOf(i) < 0) blocked.push(i);
    }
    var finalLeg = null;
    if (list.length) {
      inspectLeg(node(list[list.length - 1]), { pos: Rings.runwayAim, base: 0, hold: 0, slope: 0.03, fixed: true }, cols, info);
      finalLeg = { minClear: Math.round(info.minClear * 10) / 10, deficit: Math.round(info.def * 10) / 10 };
    }
    Rings.stats = {
      raised: raised, archRadius: archRadius, minClearance: Math.round(minClear * 10) / 10,
      minOpenClearance: Math.round(minOpen * 10) / 10,
      blocked: blocked, finalLeg: finalLeg, iterations: iter + 1
    };
    var msg = '[Rings] course resolved: ' + list.length + ' rings; ' +
      (raised.length ? 'raised ' + raised.map(function (r) { return '#' + r.index + ' +' + r.meters + ' m'; }).join(', ')
        : 'no rings raised') +
      (archRadius !== null ? '; arch ring radius ' + archRadius + ' m' : '') +
      '; min clearance ' + Rings.stats.minOpenClearance + ' m on open legs, ' + Rings.stats.minClearance +
      ' m next to low rings' +
      (blocked.length ? '; legs still tight: ' + blocked.join(', ') : '');
    console.info(msg);
    return list;
  }

  // ------------------------------------------------------------------ gameplay API
  Rings.reset = function () {
    for (var i = 0; i < Rings.list.length; i++) {
      var r = Rings.list[i];
      r.passed = false;
      r.anim = -1;
    }
    Rings.current = 0;
    Rings.complete = Rings.list.length === 0;
  };

  Rings.getCurrent = function () {
    return Rings.current < Rings.list.length ? Rings.list[Rings.current] : null;
  };

  var cA = [0, 0, 0], cB = [0, 0, 0], cX = [0, 0, 0];
  /** Did the segment prevPos -> pos fly through the current ring (in its direction)? */
  Rings.check = function (prevPos, pos) {
    var r = Rings.getCurrent();
    if (!r || !prevPos || !pos) return null;
    v3.sub(cA, prevPos, r.pos);
    v3.sub(cB, pos, r.pos);
    var d0 = v3.dot(cA, r.dir), d1 = v3.dot(cB, r.dir);
    if (!(d0 < 0 && d1 >= 0)) return null;           // must cross the plane going forwards
    var t = d0 / (d0 - d1);
    v3.lerp(cX, prevPos, pos, t);
    if (!(v3.dist(cX, r.pos) <= r.radius)) return null;
    r.passed = true;
    r.anim = 0;
    Rings.current++;
    Rings.complete = Rings.current >= Rings.list.length;
    return r;
  };

  // ------------------------------------------------------------------ presentation state
  var guideData = new Float32Array(64 * 8);
  var guideCount = 0, guidePhase = 0;
  // three subtle chevrons just past the final ring, pointing down the approach at the runway
  var finalData = new Float32Array(3 * 8);
  var finalCount = 0;
  var guideCol = v3.create();

  function targetColor(r, state) {
    if (r.special && COLORS[r.special]) return COLORS[r.special];
    return state === 0 ? COLORS.current : state === 1 ? COLORS.next : COLORS.later;
  }

  Rings.animate = function (dt) { step(dt, false); };

  // snap = jump straight to the target look (init); otherwise ease (dt = 0 while paused freezes)
  function step(dt, snap) {
    dt = dt > 0 ? Math.min(dt, 0.1) : 0;
    var list = Rings.list;
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (r.passed) {
        if (r.anim >= 0 && r.anim < PASS_TIME) r.anim += dt;
        continue;
      }
      var state = i - Rings.current;                    // 0 current, 1 next, 2+ later
      var target = state === 0 ? 1 : state === 1 ? 0.45 : 0.16;
      var k = snap ? 1 : 1 - Math.exp(-4 * dt);
      r.glow += (target - r.glow) * k;
      var tc = targetColor(r, Math.min(state, 2));
      for (var j = 0; j < 3; j++) r.col[j] += (tc[j] - r.col[j]) * k;
    }
    guidePhase += dt;
    buildGuide();
    buildFinalMarks();
  }

  function buildFinalMarks() {
    finalCount = 0;
    var list = Rings.list, f = null;
    for (var i = 0; i < list.length; i++) if (list[i].special === 'final') f = list[i];
    // the regular guide already covers the final leg while the final ring is current
    if (!f || f.passed || f === Rings.getCurrent()) return;
    v3.sub(gD, Rings.runwayAim, f.pos);
    var len = v3.length(gD);
    if (len < 200) return;
    v3.scale(gD, gD, 1 / len);
    for (var k = 0; k < 3; k++) {
      var s = 40 + k * 32, o = k * 8;
      finalData[o] = f.pos[0] + gD[0] * s; finalData[o + 1] = f.pos[1] + gD[1] * s; finalData[o + 2] = f.pos[2] + gD[2] * s;
      finalData[o + 3] = (0.3 + 0.2 * Math.sin(guidePhase * 3 - k * 0.9)) * f.glow * 2.5;
      finalData[o + 4] = gD[0]; finalData[o + 5] = gD[1]; finalData[o + 6] = gD[2];
      finalData[o + 7] = 3.6;
      finalCount++;
    }
  }

  /** Flowing chevrons from the current ring to the next one (or to the runway after the last). */
  var gA = [0, 0, 0], gB = [0, 0, 0], gD = [0, 0, 0];
  function buildGuide() {
    guideCount = 0;
    var cur = Rings.getCurrent();
    if (!cur) return;
    var nxt = Rings.current + 1 < Rings.list.length ? Rings.list[Rings.current + 1] : null;
    v3.copy(gA, cur.pos);
    v3.copy(gB, nxt ? nxt.pos : Rings.runwayAim);
    v3.copy(guideCol, nxt ? (nxt.special ? COLORS[nxt.special] : COLORS.next) : COLORS.final);
    v3.sub(gD, gB, gA);
    var len = v3.length(gD);
    if (len < 60) return;
    v3.scale(gD, gD, 1 / len);
    var spacing = 42, speed = 24;
    var off = (guidePhase * speed) % spacing;
    for (var s = off + 30; s < len - 30 && guideCount < 64; s += spacing) {
      var fade = M.smoothstep(30, 120, s) * M.smoothstep(30, 120, len - s);
      var o = guideCount * 8;
      guideData[o] = gA[0] + gD[0] * s; guideData[o + 1] = gA[1] + gD[1] * s; guideData[o + 2] = gA[2] + gD[2] * s;
      guideData[o + 3] = fade;
      guideData[o + 4] = gD[0]; guideData[o + 5] = gD[1]; guideData[o + 6] = gD[2];
      guideData[o + 7] = 3.2;
      guideCount++;
    }
  }

  // ------------------------------------------------------------------ rendering
  var gl = null;
  var progRing = null, progColumn = null, progGuide = null;
  var meshTorus = null, meshHalo = null, meshDisc = null, meshColumn = null, meshGuide = null;

  var FOG_FN = [
    'float fogF(vec3 wp) {',
    '  vec3 d = wp - u_camPos; float dist = length(d);',
    '  if (dist < 1e-3) return 0.0;',
    '  float b = max(u_fogHeightFalloff, 1e-6);',
    '  float ry = d.y / dist; if (abs(ry) < 1e-4) ry = 1e-4;',
    '  float fa = (u_fogDensity / b) * exp(-max(u_camPos.y, -500.0) * b) * (1.0 - exp(-dist * ry * b)) / ry;',
    '  return 1.0 - exp(-max(fa, 0.0));',
    '}'
  ].join('\n');

  var RING_VS = [
    'layout(location = 0) in vec3 a_position;',
    'layout(location = 1) in vec3 a_normal;',
    'layout(location = 3) in vec2 a_uv;',
    'uniform vec3 u_center; uniform vec3 u_ax; uniform vec3 u_ay; uniform vec3 u_az;',
    'uniform float u_radius; uniform float u_mode; uniform float u_tube;',
    'out vec3 v_world; out vec3 v_n; out vec2 v_uv; out vec2 v_local; out float v_k;',
    'void main() {',
    '  vec3 p = a_position; vec3 n = a_normal;',
    '  float dist = length(u_center - u_camPos);',
    '  v_k = 0.0; v_local = a_position.xy;',
    '  if (u_mode < 0.5) {',
    '    // torus: keep the tube at least ~1.5 px wide far away',
    '    vec2 rp = normalize(p.xy);',
    '    vec3 tube = (p - vec3(rp, 0.0)) / ' + TUBE_BUILD.toFixed(3) + ';',
    '    p = vec3(rp * u_radius, 0.0) + tube * u_tube * max(1.0, dist * 0.0011);',
    '  } else if (u_mode < 1.5) {',
    '    // glow band around the ring: widens with distance so the ring always reads',
    '    float hw = max(u_radius * 0.16, dist * 0.007);',
    '    v_k = p.z;',
    '    p = vec3(p.xy * (u_radius + p.z * hw), 0.0);',
    '  } else {',
    '    p = vec3(p.xy * (u_radius - u_tube * 0.6), 0.0);',
    '  }',
    '  vec3 w = u_center + u_ax * p.x + u_ay * p.y + u_az * p.z;',
    '  v_n = u_ax * n.x + u_ay * n.y + u_az * n.z;',
    '  v_world = w; v_uv = a_uv;',
    '  gl_Position = u_viewProj * vec4(w, 1.0);',
    '}'
  ].join('\n');

  var RING_FS = [
    'in vec3 v_world; in vec3 v_n; in vec2 v_uv; in vec2 v_local; in float v_k;',
    'uniform vec3 u_color; uniform float u_intensity; uniform float u_alpha; uniform float u_current;',
    'uniform float u_mode; uniform float u_flash;',
    'out vec4 outColor;',
    FOG_FN,
    'void main() {',
    '  float vis = 1.0 - 0.6 * fogF(v_world);',
    '  vec3 col = u_color;',
    '  if (u_mode < 0.5) {',
    '    vec3 N = normalize(v_n); vec3 V = normalize(u_camPos - v_world);',
    '    float rim = pow(1.0 - abs(dot(N, V)), 2.0);',
    '    float sun = max(dot(N, u_sunDir), 0.0);',
    '    float spec = pow(max(dot(reflect(-u_sunDir, N), V), 0.0), 28.0);',
    '    float chase = pow(0.5 + 0.5 * sin(v_uv.x * 6.2831853 * 3.0 - u_time * 4.5), 12.0) * u_current;',
    '    float pulse = 1.0 + 0.22 * sin(u_time * 3.2) * u_current;',
    '    float body = 0.16 + 0.5 * sun + 0.12 * max(N.y, 0.0);',
    '    vec3 c = col * (body + 0.6 * rim + 1.5 * chase) * pulse * u_intensity;',
    '    c += vec3(1.0, 0.95, 0.85) * spec * 0.5 * u_intensity * (1.0 - 0.7 * u_nightFactor);',
    '    c = c * vis + col * u_flash * 6.0;',
    '    outColor = vec4(finalColor(c) * u_alpha, u_alpha * 0.85);',
    '  } else if (u_mode < 1.5) {',
    '    float g = exp(-v_k * v_k * 5.0) * (1.0 - abs(v_k));',
    '    vec3 c = col * g * u_intensity * vis * ((0.16 + 0.2 * u_nightFactor) + u_flash * 3.0);',
    '    outColor = vec4(finalColor(c) * u_alpha, 0.0);',
    '  } else {',
    '    float r = length(v_local);',
    '    float ripple = 0.5 + 0.5 * sin(r * 11.0 - u_time * 2.6);',
    '    float sh = vnoise(v_local * 5.0 + vec2(u_time * 0.6, -u_time * 0.45));',
    '    float edge = smoothstep(0.5, 1.0, r);',
    '    float a = 0.012 + 0.04 * ripple * sh + 0.16 * edge * edge * edge;',
    '    a *= 0.85 + 0.15 * sin(u_time * 3.2);',
    '    vec3 c = col * a * u_intensity * vis;',
    '    outColor = vec4(finalColor(c) * u_alpha, 0.0);',
    '  }',
    '}'
  ].join('\n');

  var COLUMN_VS = [
    'layout(location = 0) in vec3 a_position;',
    'uniform vec3 u_base; uniform float u_height;',
    'out vec2 v_q; out vec3 v_world;',
    'void main() {',
    '  vec3 toCam = u_camPos - u_base;',
    '  vec3 side = vec3(toCam.z, 0.0, -toCam.x);',
    '  float sl = length(side);',
    '  side = sl > 1e-3 ? side / sl : vec3(1.0, 0.0, 0.0);',
    '  float w = max(7.0, length(toCam.xz) * 0.0055);',
    '  vec3 wp = u_base + side * a_position.x * w + vec3(0.0, a_position.y * u_height, 0.0);',
    '  v_q = a_position.xy; v_world = wp;',
    '  gl_Position = u_viewProj * vec4(wp, 1.0);',
    '}'
  ].join('\n');

  var COLUMN_FS = [
    'in vec2 v_q; in vec3 v_world;',
    'uniform vec3 u_color; uniform float u_intensity;',
    'out vec4 outColor;',
    FOG_FN,
    'void main() {',
    '  float x2 = v_q.x * v_q.x;',
    '  float across = exp(-x2 * 4.0) * 0.45 + exp(-x2 * 30.0) * 0.9;',
    '  float y = v_q.y;',
    '  float fade = pow(1.0 - y, 1.8) * smoothstep(0.0, 0.015, y);',
    '  float pulses = 0.72 + 0.28 * sin(y * 70.0 - u_time * 5.0);',
    '  vec3 c = u_color * across * fade * pulses * u_intensity * (1.0 - 0.45 * fogF(v_world));',
    '  outColor = vec4(finalColor(c), 0.0);',
    '}'
  ].join('\n');

  var GUIDE_VS = [
    'layout(location = 0) in vec3 a_position;',
    'layout(location = 4) in vec4 i_pos;   // xyz, alpha',
    'layout(location = 5) in vec4 i_dir;   // unit direction along the leg, size (m)',
    'out vec2 v_q; out float v_a; out vec3 v_world;',
    'void main() {',
    '  vec3 d = i_dir.xyz;',
    '  vec3 toCam = u_camPos - i_pos.xyz;',
    '  float dist = length(toCam);',
    '  vec3 side = cross(d, toCam / max(dist, 1e-3));',
    '  float sl = length(side);',
    '  vec3 camRight = vec3(u_view[0][0], u_view[1][0], u_view[2][0]);',
    '  vec3 camUp = vec3(u_view[0][1], u_view[1][1], u_view[2][1]);',
    '  vec3 camFwd = -vec3(u_view[0][2], u_view[1][2], u_view[2][2]);',
    '  side = sl > 1e-3 ? side / sl : camRight;',
    '  if (dot(side, camRight) < 0.0) side = -side;',
    '  // seen end-on the leg collapses: fall back to a screen-facing chevron pointing',
    '  // "into the screen" (up) when the leg leads away from the camera, down when it comes at it',
    '  float w = smoothstep(0.2, 0.55, sl);',
    '  vec3 ax = normalize(mix(camRight, side, w));',
    '  vec3 ay = normalize(mix(dot(d, camFwd) >= 0.0 ? camUp : -camUp, d, w) + 1e-5);',
    '  float size = max(i_dir.w, dist * 0.0045);',
    '  vec3 wp = i_pos.xyz + (ax * a_position.x + ay * a_position.y) * size;',
    '  v_a = i_pos.w;',
    '  v_q = a_position.xy; v_world = wp;',
    '  gl_Position = u_viewProj * vec4(wp, 1.0);',
    '}'
  ].join('\n');

  var GUIDE_FS = [
    'in vec2 v_q; in float v_a; in vec3 v_world;',
    'uniform vec3 u_color;',
    'out vec4 outColor;',
    FOG_FN,
    'void main() {',
    '  float s = abs(v_q.y - (0.3 - abs(v_q.x) * 0.85));',
    '  float w = fwidth(s) + 1e-3;',
    '  float m = (1.0 - smoothstep(0.16 - w, 0.16 + w, s)) * (1.0 - smoothstep(0.78, 0.9, abs(v_q.x)));',
    '  float k = m * v_a * (1.0 - 0.5 * fogF(v_world));',
    '  // partly opaque so the trail still reads over bright grass / snow, glowing on top',
    '  outColor = vec4(finalColor(u_color * 1.1) * k, k * 0.55);',
    '}'
  ].join('\n');

  function buildMeshes() {
    var G = RL.GL, Geo = RL.Geo;
    meshTorus = G.meshFromGeo(gl, Geo.torus(1, TUBE_BUILD, 10, 96, [1, 1, 1]));
    // glow band: two rings of vertices, z = -1 (inside) .. +1 (outside)
    var seg = 96, pos = [], idx = [], i;
    for (i = 0; i <= seg; i++) {
      var a = i / seg * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      pos.push(c, s, -1, c, s, 1);
    }
    for (i = 0; i < seg; i++) {
      var b = i * 2;
      idx.push(b, b + 2, b + 3, b, b + 3, b + 1);
    }
    meshHalo = G.createMesh(gl, { positions: pos, indices: idx });
    // membrane disc (triangle fan as a list)
    pos = [0, 0, 0]; idx = [];
    for (i = 0; i <= seg; i++) {
      var a2 = i / seg * Math.PI * 2;
      pos.push(Math.cos(a2), Math.sin(a2), 0);
    }
    for (i = 1; i <= seg; i++) idx.push(0, i, i + 1);
    meshDisc = G.createMesh(gl, { positions: pos, indices: idx });
    meshColumn = G.createMesh(gl, { positions: [-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0], indices: [0, 1, 2, 0, 2, 3] });
    meshGuide = G.createMesh(gl, {
      positions: [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0],
      indices: [0, 1, 2, 0, 2, 3],
      instances: {
        data: guideData, stride: 8, count: 0, usage: gl.DYNAMIC_DRAW,
        attribs: [{ loc: 4, size: 4, offset: 0 }, { loc: 5, size: 4, offset: 4 }]
      }
    });
  }

  Rings.init = function (glCtx) {
    gl = glCtx;
    Rings.list = resolveCourse();
    Rings.total = Rings.list.length;
    Rings.reset();
    step(0, true);
    if (!gl) return;
    var SL = RL.ShaderLib, G = RL.GL;
    progRing = G.createProgram(gl, SL.vertex(RING_VS), SL.fragment(RING_FS), 'rings');
    progColumn = G.createProgram(gl, SL.vertex(COLUMN_VS), SL.fragment(COLUMN_FS), 'ring-column');
    progGuide = G.createProgram(gl, SL.vertex(GUIDE_VS), SL.fragment(GUIDE_FS), 'ring-guide');
    buildMeshes();
  };

  function setRing(r, radius, mode, intensity, alpha, current, flash, col) {
    var G = RL.GL;
    G.setUniform(gl, progRing, 'u_center', r.pos);
    G.setUniform(gl, progRing, 'u_ax', r.ax);
    G.setUniform(gl, progRing, 'u_ay', r.ay);
    G.setUniform(gl, progRing, 'u_az', r.dir);
    G.setUniform(gl, progRing, 'u_radius', radius);
    G.setUniform(gl, progRing, 'u_mode', mode);
    G.setUniform(gl, progRing, 'u_intensity', intensity);
    G.setUniform(gl, progRing, 'u_alpha', alpha);
    G.setUniform(gl, progRing, 'u_current', current);
    G.setUniform(gl, progRing, 'u_flash', flash);
    G.setUniform(gl, progRing, 'u_color', col);
  }

  var colBase = [0, 0, 0];
  var U_COLUMN = { u_base: colBase, u_height: COLUMN_HEIGHT, u_color: null, u_intensity: 0 };
  var U_GUIDE = { u_color: guideCol };
  var U_FINAL = { u_color: COLORS.final };
  Rings.draw = function (frame) {
    if (!gl || !progRing || !Rings.list.length) return;
    var G = RL.GL, list = Rings.list;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);

    G.use(gl, progRing, null);
    G.applyFrame(gl, progRing, frame);
    G.setUniform(gl, progRing, 'u_tube', TUBE);
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      var radius = r.radius, inten, alpha, flash = 0, cur = 0;
      if (r.passed) {
        if (r.anim < 0 || r.anim >= PASS_TIME) continue;
        var e = r.anim / PASS_TIME, ease = 1 - (1 - e) * (1 - e);
        radius *= 1 + 0.9 * ease;
        inten = 1.0;
        alpha = (1 - e) * (1 - e);
        flash = (1 - e) * (1 - e) * 0.6;
        cur = 1;
      } else {
        inten = 0.35 + 0.65 * r.glow;
        alpha = 0.25 + 0.75 * M.smoothstep(0.1, 0.5, r.glow);
        cur = M.smoothstep(0.5, 1.0, r.glow);
      }
      // torus
      gl.enable(gl.CULL_FACE);
      setRing(r, radius, 0, inten, alpha, cur, flash, r.col);
      G.drawMesh(gl, meshTorus);
      // glow band (+ membrane for the current ring)
      gl.disable(gl.CULL_FACE);
      setRing(r, radius, 1, inten * (0.4 + 0.6 * r.glow), alpha, cur, flash, r.col);
      G.drawMesh(gl, meshHalo);
      if (cur > 0.01 && !r.passed) {
        setRing(r, radius, 2, cur, 1, cur, 0, r.col);
        G.drawMesh(gl, meshDisc);
      }
    }

    // light column above the current ring (fades in as it becomes current, out up close)
    var c = Rings.getCurrent();
    if (c && progColumn) {
      var dist = v3.dist(c.pos, frame.camPos);
      var k = M.smoothstep(0.5, 1.0, c.glow) * (0.25 + 0.75 * M.smoothstep(60, 450, dist));
      if (k > 0.01) {
        colBase[0] = c.pos[0]; colBase[1] = c.pos[1] + c.radius * 0.6; colBase[2] = c.pos[2];
        U_COLUMN.u_color = c.col;
        U_COLUMN.u_intensity = k * 0.5;
        G.use(gl, progColumn, U_COLUMN);
        G.applyFrame(gl, progColumn, frame);
        G.drawMesh(gl, meshColumn);
      }
    }

    // flowing chevrons along the next leg
    if (guideCount > 0 && progGuide) {
      G.updateInstances(gl, meshGuide, guideData, guideCount);
      G.use(gl, progGuide, U_GUIDE);
      G.applyFrame(gl, progGuide, frame);
      G.drawMesh(gl, meshGuide, guideCount);
    }
    if (finalCount > 0 && progGuide) {
      G.updateInstances(gl, meshGuide, finalData, finalCount);
      G.use(gl, progGuide, U_FINAL);
      G.applyFrame(gl, progGuide, frame);
      G.drawMesh(gl, meshGuide, finalCount);
    }

    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.CULL_FACE);
  };

  RL.Rings = Rings;
})(window.RL = window.RL || {});
