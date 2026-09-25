/*
 * Ridgeline — RL.Particles: CPU-simulated billboard particles.
 *
 *   init(gl)                              pool, procedural sprite atlas, program
 *   emit(type, pos, vel, count, opts)     spawn `count` particles of a type (see TYPES)
 *   update(dt)                            simulate (dt = 0 while paused: frozen)
 *   draw(frame)                           one sorted, instanced draw
 *   clear()
 *
 * opts (all optional): color [r,g,b] sRGB, colorEnd, size (m, start radius), grow (end size
 * factor), life (s), spread (m/s velocity jitter), posSpread (m), alpha, glow (emissive
 * multiplier, e.g. night skywriting; fades over life for smoke), heat (0..1 fire ramp start), inherit (0..1 scale of vel),
 * drag (1/s), gravity (m/s^2, negative = buoyant).
 *
 * Blending: every particle is drawn premultiplied with blendFunc(ONE, ONE_MINUS_SRC_ALPHA)
 * in a single back-to-front sorted instanced draw. "Additive" particles output alpha = 0 (pure
 * light added), "alpha" particles output normal premultiplied colour, and fire cross-fades
 * between the two as it cools from glowing flame into dark smoke. So flames sit correctly in
 * front of / behind smoke without two passes. Depth test on, depth write off.
 *
 * Memory: structure-of-arrays typed pools (MAX particles), counting sort into a preallocated
 * order array, instance data written into one preallocated Float32Array: no per-frame garbage.
 */
(function (RL) {
  'use strict';

  var M = RL.M;
  var MAX = 8000;
  var STRIDE = 16;               // floats per instance
  var SORT_BUCKETS = 2048;
  var SORT_FAR = 9000;           // m, depth mapped onto the sort buckets (sqrt-spaced)

  // Sprite atlas cells (2x2): 0 puff A, 1 puff B, 2 soft glow, 3 star. 4 = hard chunk (puff A thresholded).
  var CELL_PUFF = 0, CELL_GLOW = 2, CELL_STAR = 3, CELL_CHUNK = 4;

  // Type flags
  var F_GROUND = 1, F_BOUNCE = 2, F_WATERKILL = 4, F_HEAT = 8, F_TWINKLE = 16, F_TRAIL = 32,
    F_SMOKETRAIL = 64, F_PUFFVAR = 128, F_GLOWFADE = 256;

  /*
   * Per-type behaviour. life/size are [min, max]; grow = end size factor; drag 1/s (relaxes the
   * velocity towards wind * wind); gravity m/s^2 (negative = buoyant); lit 0..1 (0 flat colour,
   * 1 full puff lighting); add 0..1 additivity; emis emissive multiplier; stretch s (streak length
   * = speed * stretch); fadeIn / fadeOut fractions of life; spin rad/s range.
   */
  var TYPES = {
    smoke:     { life: [5, 8], size: [1.6, 2.4], grow: 5.0, drag: 0.7, gravity: -0.35, wind: 1, lit: 1, add: 0, emis: 0,
                 alpha: 0.55, color: [0.52, 0.52, 0.53], colorEnd: [0.66, 0.66, 0.68], spread: 1.2, fadeIn: 0.06, fadeOut: 0.55,
                 spin: 0.25, flags: F_GROUND | F_PUFFVAR | F_GLOWFADE },
    exhaust:   { life: [0.7, 1.2], size: [0.14, 0.2], grow: 3.5, drag: 2.2, gravity: -0.6, wind: 1, lit: 1, add: 0, emis: 0,
                 alpha: 0.3, color: [0.5, 0.5, 0.52], colorEnd: [0.62, 0.62, 0.64], spread: 0.5, fadeIn: 0.1, fadeOut: 0.6,
                 spin: 0.8, flags: F_PUFFVAR },
    dust:      { life: [1.6, 2.8], size: [0.7, 1.2], grow: 4.5, drag: 1.6, gravity: 0.25, wind: 1, lit: 1, add: 0, emis: 0,
                 alpha: 0.42, color: [0.64, 0.54, 0.39], colorEnd: [0.72, 0.64, 0.52], spread: 1.8, fadeIn: 0.08, fadeOut: 0.6,
                 spin: 0.4, flags: F_GROUND | F_PUFFVAR },
    tireSmoke: { life: [1.3, 2.4], size: [0.45, 0.7], grow: 6.0, drag: 2.0, gravity: -0.25, wind: 1, lit: 1, add: 0, emis: 0,
                 alpha: 0.62, color: [0.93, 0.93, 0.94], colorEnd: [0.86, 0.86, 0.88], spread: 1.4, fadeIn: 0.04, fadeOut: 0.6,
                 spin: 0.6, flags: F_GROUND | F_PUFFVAR },
    fire:      { life: [0.8, 1.4], size: [1.3, 2.1], grow: 1.9, drag: 1.4, gravity: -5.5, wind: 0.7, lit: 1, add: 1, emis: 1.9,
                 alpha: 0.75, color: [1, 1, 1], colorEnd: [1, 1, 1], spread: 1.0, fadeIn: 0.08, fadeOut: 0.45,
                 spin: 1.2, flags: F_HEAT | F_PUFFVAR },
    explosion: { life: [0.9, 1.7], size: [3.0, 5.5], grow: 2.6, drag: 3.2, gravity: -2.5, wind: 0.3, lit: 1, add: 1, emis: 1.7,
                 alpha: 0.7, color: [1, 1, 1], colorEnd: [1, 1, 1], spread: 14, fadeIn: 0.02, fadeOut: 0.4,
                 spin: 1.0, flags: F_HEAT | F_PUFFVAR },
    spark:     { life: [0.5, 1.3], size: [0.08, 0.13], grow: 0.4, drag: 0.5, gravity: 9.81, wind: 0, lit: 0, add: 1, emis: 3.5,
                 alpha: 1.0, color: [1.0, 0.72, 0.32], colorEnd: [1.0, 0.35, 0.08], spread: 22, fadeIn: 0.0, fadeOut: 0.5,
                 spin: 0, stretch: 0.045, cell: CELL_GLOW, flags: F_GROUND | F_BOUNCE },
    debris:    { life: [3.5, 6.0], size: [0.3, 0.7], grow: 1.0, drag: 0.15, gravity: 9.81, wind: 0, lit: 1, add: 0, emis: 0,
                 alpha: 1.0, color: [0.13, 0.12, 0.11], colorEnd: [0.1, 0.09, 0.09], spread: 16, fadeIn: 0.0, fadeOut: 0.15,
                 spin: 9, cell: CELL_CHUNK, flags: F_GROUND | F_BOUNCE | F_SMOKETRAIL },
    splash:    { life: [0.9, 1.7], size: [0.4, 0.8], grow: 3.2, drag: 0.7, gravity: 9.81, wind: 0.3, lit: 1, add: 0, emis: 0,
                 alpha: 0.75, color: [0.94, 0.97, 1.0], colorEnd: [0.88, 0.93, 0.98], spread: 5, fadeIn: 0.03, fadeOut: 0.5,
                 spin: 0.8, flags: F_WATERKILL | F_PUFFVAR },
    sparkle:   { life: [0.9, 1.7], size: [0.8, 1.4], grow: 0.35, drag: 1.4, gravity: -0.6, wind: 0, lit: 0, add: 1, emis: 2.2,
                 alpha: 1.0, color: [1.0, 0.88, 0.5], colorEnd: [1.0, 0.6, 0.9], spread: 5, fadeIn: 0.05, fadeOut: 0.5,
                 spin: 1.5, cell: CELL_STAR, flags: F_TWINKLE },
    vapor:     { life: [0.8, 1.3], size: [0.2, 0.28], grow: 3.0, drag: 0.4, gravity: 0, wind: 0.5, lit: 0.5, add: 0, emis: 0,
                 alpha: 0.32, color: [1.0, 1.0, 1.0], colorEnd: [1.0, 1.0, 1.0], spread: 0.15, fadeIn: 0.05, fadeOut: 0.7,
                 spin: 0.3, flags: F_PUFFVAR },
    skywrite:  { life: [42, 48], size: [1.5, 1.9], grow: 3.6, drag: 0.35, gravity: -0.04, wind: 1, lit: 0.55, add: 0, emis: 0,
                 alpha: 0.9, color: [0.96, 0.96, 0.96], colorEnd: null, spread: 0.5, fadeIn: 0.004, fadeOut: 0.3,
                 spin: 0.12, growPow: 5, flags: F_PUFFVAR },
    firework:  { life: [1.5, 2.3], size: [0.8, 1.1], grow: 0.35, drag: 1.25, gravity: 3.2, wind: 0.2, lit: 0, add: 1, emis: 1.8,
                 alpha: 1.0, color: [1, 0.5, 0.3], colorEnd: null, spread: 0, fadeIn: 0.0, fadeOut: 0.45,
                 spin: 0, stretch: 0.035, cell: CELL_GLOW, flags: F_TRAIL | F_TWINKLE },
    trail:     { life: [0.4, 0.8], size: [0.4, 0.55], grow: 0.3, drag: 2.0, gravity: 1.6, wind: 0.3, lit: 0, add: 1, emis: 1.5,
                 alpha: 0.9, color: [1.0, 0.75, 0.4], colorEnd: null, spread: 0.6, fadeIn: 0.0, fadeOut: 0.8,
                 spin: 0, cell: CELL_GLOW, flags: 0 }
  };
  var TYPE_NAMES = Object.keys(TYPES);
  var NT = TYPE_NAMES.length;
  var TYPE_ID = {};

  // Per-type constants in flat arrays (hot loop reads these, not the objects).
  var tDrag = new Float32Array(NT), tWind = new Float32Array(NT),
    tLit = new Float32Array(NT), tAdd = new Float32Array(NT), tEmis = new Float32Array(NT),
    tStretch = new Float32Array(NT), tFadeIn = new Float32Array(NT), tFadeOut = new Float32Array(NT),
    tCell = new Float32Array(NT), tGrowPow = new Float32Array(NT), tDragExp = new Float32Array(NT);
  var tFlags = new Uint16Array(NT);
  for (var ti = 0; ti < NT; ti++) {
    var T = TYPES[TYPE_NAMES[ti]];
    TYPE_ID[TYPE_NAMES[ti]] = ti;
    tDrag[ti] = T.drag; tWind[ti] = T.wind; tLit[ti] = T.lit; tAdd[ti] = T.add;
    tEmis[ti] = T.emis; tStretch[ti] = T.stretch || 0; tFadeIn[ti] = T.fadeIn; tFadeOut[ti] = T.fadeOut;
    tCell[ti] = T.cell !== undefined ? T.cell : CELL_PUFF; tGrowPow[ti] = T.growPow || 2; tFlags[ti] = T.flags;
  }
  var ID_SMOKE = TYPE_ID.smoke, ID_TRAIL = TYPE_ID.trail;

  // ------------------------------------------------------------------ pool (structure of arrays)
  var px = new Float32Array(MAX), py = new Float32Array(MAX), pz = new Float32Array(MAX);
  var vx = new Float32Array(MAX), vy = new Float32Array(MAX), vz = new Float32Array(MAX);
  var wx = new Float32Array(MAX), wy = new Float32Array(MAX), wz = new Float32Array(MAX);
  var age = new Float32Array(MAX), life = new Float32Array(MAX);
  var size0 = new Float32Array(MAX), grow = new Float32Array(MAX);
  var rot = new Float32Array(MAX), rotV = new Float32Array(MAX);
  var r0 = new Float32Array(MAX), g0 = new Float32Array(MAX), b0 = new Float32Array(MAX);
  var r1 = new Float32Array(MAX), g1 = new Float32Array(MAX), b1 = new Float32Array(MAX);
  var alpha0 = new Float32Array(MAX), glow = new Float32Array(MAX), heat0 = new Float32Array(MAX);
  var drag = new Float32Array(MAX), grav = new Float32Array(MAX);
  var seed = new Float32Array(MAX), aux = new Float32Array(MAX);   // aux: trail emission timer
  var type = new Uint8Array(MAX), cellV = new Uint8Array(MAX);
  var count = 0, cursor = 0, frameNo = 0, simTime = 0;

  // draw scratch
  var inst = new Float32Array(MAX * STRIDE);
  var depthKey = new Uint16Array(MAX), order = new Uint16Array(MAX);
  var bucketCount = new Uint32Array(SORT_BUCKETS);
  var windTmp = new Float32Array(3);
  var heatTmp = new Float32Array(3);

  var gl = null, prog = null, mesh = null, atlas = null;

  function rand(a, b) { return a + (b - a) * Math.random(); }

  /** Black-body-ish flame ramp: 1 white-yellow -> orange -> red -> 0 dark soot (sRGB). */
  function heatColor(h, out) {
    var r, g, b;
    if (h > 0.7) { var t = (h - 0.7) / 0.3; r = 1; g = 0.62 + 0.22 * t; b = 0.22 + 0.2 * t; }
    else if (h > 0.4) { t = (h - 0.4) / 0.3; r = 0.97 + 0.03 * t; g = 0.34 + 0.28 * t; b = 0.08 + 0.14 * t; }
    else if (h > 0.18) { t = (h - 0.18) / 0.22; r = 0.3 + 0.67 * t; g = 0.1 + 0.24 * t; b = 0.07 + 0.01 * t; }
    else { t = h / 0.18; r = 0.11 + 0.19 * t; g = 0.1; b = 0.095 - 0.025 * t; }
    out[0] = r; out[1] = g; out[2] = b;
    return out;
  }

  function copyParticle(d, s) {
    px[d] = px[s]; py[d] = py[s]; pz[d] = pz[s];
    vx[d] = vx[s]; vy[d] = vy[s]; vz[d] = vz[s];
    wx[d] = wx[s]; wy[d] = wy[s]; wz[d] = wz[s];
    age[d] = age[s]; life[d] = life[s]; size0[d] = size0[s]; grow[d] = grow[s];
    rot[d] = rot[s]; rotV[d] = rotV[s];
    r0[d] = r0[s]; g0[d] = g0[s]; b0[d] = b0[s]; r1[d] = r1[s]; g1[d] = g1[s]; b1[d] = b1[s];
    alpha0[d] = alpha0[s]; glow[d] = glow[s]; drag[d] = drag[s]; grav[d] = grav[s]; heat0[d] = heat0[s]; seed[d] = seed[s]; aux[d] = aux[s];
    type[d] = type[s]; cellV[d] = cellV[s];
  }

  function allocIndex() {
    if (count < MAX) return count++;
    // Pool full: recycle round-robin (the oldest particles tend to sit near the start).
    cursor = (cursor + 1) % MAX;
    return cursor;
  }

  function sampleWind(i, t) {
    if (RL.World && RL.World.windAt) {
      RL.World.windAt(px[i], py[i], pz[i], t, windTmp);
      var x = windTmp[0], y = windTmp[1], z = windTmp[2];
      if (x === x && y === y && z === z) { wx[i] = x; wy[i] = y; wz[i] = z; return; }
    }
    wx[i] = 0; wy[i] = 0; wz[i] = 0;
  }

  /** Spawn one particle of type id at (x,y,z) with velocity (ux,uy,uz). opts may be null. */
  function spawn(id, x, y, z, ux, uy, uz, opts) {
    var T = TYPES[TYPE_NAMES[id]];
    var i = allocIndex();
    var sp = opts && opts.spread !== undefined ? opts.spread : T.spread;
    var ps = opts && opts.posSpread ? opts.posSpread : 0;
    // velocity jitter: uniform in a sphere (rejection-free approximation via cube-to-sphere scaling)
    var jx = Math.random() * 2 - 1, jy = Math.random() * 2 - 1, jz = Math.random() * 2 - 1;
    var jl = Math.sqrt(jx * jx + jy * jy + jz * jz) || 1;
    var jr = Math.cbrt(Math.random()) / jl;
    px[i] = x + (ps ? (Math.random() * 2 - 1) * ps : 0);
    py[i] = y + (ps ? (Math.random() * 2 - 1) * ps * 0.6 : 0);
    pz[i] = z + (ps ? (Math.random() * 2 - 1) * ps : 0);
    vx[i] = ux + jx * jr * sp; vy[i] = uy + jy * jr * sp; vz[i] = uz + jz * jr * sp;
    var lf = opts && opts.life ? opts.life * rand(0.85, 1.15) : rand(T.life[0], T.life[1]);
    life[i] = lf > 0.01 ? lf : 0.01;
    age[i] = 0;
    var sz = opts && opts.size ? opts.size * rand(0.85, 1.15) : rand(T.size[0], T.size[1]);
    size0[i] = sz;
    grow[i] = opts && opts.grow !== undefined ? opts.grow : T.grow;
    rot[i] = Math.random() * 6.2832;
    rotV[i] = (Math.random() * 2 - 1) * T.spin;
    var c = (opts && opts.color) || T.color;
    var ce = (opts && opts.colorEnd) || (opts && opts.color ? null : T.colorEnd) || c;
    r0[i] = c[0]; g0[i] = c[1]; b0[i] = c[2];
    r1[i] = ce[0]; g1[i] = ce[1]; b1[i] = ce[2];
    alpha0[i] = opts && opts.alpha !== undefined ? opts.alpha : T.alpha;
    glow[i] = opts && opts.glow ? opts.glow : 0;
    heat0[i] = opts && opts.heat !== undefined ? opts.heat : rand(0.8, 1.0);
    drag[i] = opts && opts.drag !== undefined ? opts.drag : T.drag;
    grav[i] = opts && opts.gravity !== undefined ? opts.gravity : T.gravity;
    seed[i] = Math.random();
    aux[i] = 0;
    type[i] = id;
    var cell = tCell[id];
    if (cell === CELL_PUFF && (tFlags[id] & F_PUFFVAR) && seed[i] > 0.5) cell = 1;
    cellV[i] = cell;
    if (tWind[id] > 0) sampleWind(i, simTime); else { wx[i] = 0; wy[i] = 0; wz[i] = 0; }
  }

  function killAt(i) {
    count--;
    if (i !== count) copyParticle(i, count);
  }

  // ------------------------------------------------------------------ sprite atlas
  function vnoise(x, y, s) {
    var ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    var ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    var h = M.hash2;
    var a = h(ix, iy, s), b = h(ix + 1, iy, s), c = h(ix, iy + 1, s), d = h(ix + 1, iy + 1, s);
    return (a + (b - a) * ux) + ((c + (d - c) * ux) - (a + (b - a) * ux)) * uy;
  }
  function fbm(x, y, s) {
    return vnoise(x, y, s) * 0.55 + vnoise(x * 2.1, y * 2.1, s + 7) * 0.3 + vnoise(x * 4.3, y * 4.3, s + 13) * 0.15;
  }

  function buildAtlas() {
    var N = 128, W = N * 2;
    var data = new Uint8Array(W * W * 4);
    for (var cy = 0; cy < 2; cy++) for (var cx = 0; cx < 2; cx++) {
      var cell = cy * 2 + cx;
      for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) {
        var u = (x + 0.5) / N * 2 - 1, v = (y + 0.5) / N * 2 - 1;
        var r = Math.sqrt(u * u + v * v);
        var a = 0, lum = 1;
        if (cell < 2) {
          // cauliflower puff: lumpy fbm edge + a few sub-blobs, soft falloff
          var n = fbm(u * 2.3 + 11 * cell, v * 2.3 + 5 * cell, 101 + cell * 17);
          var ang = Math.atan2(v, u);
          var lobes = 0.08 * Math.sin(ang * 3 + cell * 2) + 0.06 * Math.sin(ang * 5 + 1 + cell);
          var edge = 0.78 + lobes + (n - 0.5) * 0.42;
          a = M.smoothstep(edge, edge - 0.42, r);
          a *= 0.75 + 0.25 * n;
          lum = 0.7 + 0.3 * fbm(u * 5 + 3, v * 5 - 2, 57 + cell);
          // very edge must be 0 (mipmaps / neighbours)
          a *= M.smoothstep(1.0, 0.9, r);
        } else if (cell === 2) {
          a = Math.exp(-r * r * 5.5) * 0.85 + Math.exp(-r * r * 30) * 0.15;
          a *= M.smoothstep(1.0, 0.85, r);
        } else {
          // four-point star with a soft core
          var ax = Math.abs(u), ay = Math.abs(v);
          var rays = Math.exp(-ax * 16) * Math.exp(-ay * 2.4) + Math.exp(-ay * 16) * Math.exp(-ax * 2.4);
          var diag = (Math.exp(-Math.abs(ax - ay) * 22) * Math.exp(-r * 3.5)) * 0.35;
          a = Math.min(1, rays * 0.9 + diag + Math.exp(-r * r * 14) * 0.9);
          a *= M.smoothstep(1.0, 0.8, r);
        }
        var o = ((cy * N + y) * W + (cx * N + x)) * 4;
        data[o] = Math.round(M.saturate(lum) * 255);
        data[o + 1] = data[o];
        data[o + 2] = data[o];
        data[o + 3] = Math.round(M.saturate(a) * 255);
      }
    }
    return RL.GL.createTexture(gl, null, {
      width: W, height: W, data: data, wrap: gl.CLAMP_TO_EDGE, anisotropy: 1
    });
  }

  // ------------------------------------------------------------------ shaders
  var VS = [
    'layout(location = 0) in vec3 a_position;',   // quad corner in [-1,1]^2
    'layout(location = 4) in vec4 i_posSize;',     // world pos, radius
    'layout(location = 5) in vec4 i_color;',       // sRGB rgb, alpha
    'layout(location = 6) in vec4 i_params;',      // rotation, cell, lit, emissive
    'layout(location = 7) in vec4 i_stretch;',     // streak vector (world), additivity',
    'out vec2 v_uv;',
    'out vec2 v_q;',
    'out vec4 v_color;',
    'out vec3 v_world;',
    'out vec3 v_right;',
    'out vec3 v_up;',
    'out vec3 v_toCam;',
    'out vec4 v_params;',
    'out float v_add;',
    'out vec3 v_fogF;',                             // fog in-scatter  (applyFog(c) = c * T + F)
    'out float v_fogT;',                            // fog transmittance
    '// Per-particle fog, evaluated once per vertex (the sprite shares one world position).',
    '// Same model as ShaderLib applyFog/skyColor, which only exist in fragment shaders.',
    'vec3 skyColorV(vec3 dir) {',
    '  float h = dir.y;',
    '  vec3 c = mix(u_skyHorizon, u_skyZenith, pow(clamp(h, 0.0, 1.0), 0.45));',
    '  c = mix(c, u_skyHorizon * 0.82, clamp(-h * 6.0, 0.0, 1.0));',
    '  float s = max(dot(dir, u_sunDir), 0.0);',
    '  float dayish = 1.0 - 0.85 * u_nightFactor;',
    '  c += u_sunColor * (0.045 * pow(s, 6.0) + 0.16 * pow(s, 48.0)) * dayish;',
    '  c += u_sunColor * 0.06 * exp(-abs(h) * 9.0) * pow(s, 2.0) * dayish;',
    '  return c;',
    '}',
    'void fogV(vec3 worldPos, out float T, out vec3 F) {',
    '  vec3 d = worldPos - u_camPos;',
    '  float dist = length(d);',
    '  T = 1.0; F = vec3(0.0);',
    '  if (dist < 1e-3) return;',
    '  vec3 rd = d / dist;',
    '  float b = max(u_fogHeightFalloff, 1e-6);',
    '  float ry = rd.y;',
    '  if (abs(ry) < 1e-4) ry = 1e-4;',
    '  float amt = (u_fogDensity / b) * exp(-max(u_camPos.y, -500.0) * b) * (1.0 - exp(-dist * ry * b)) / ry;',
    '  float f = clamp(1.0 - exp(-max(amt, 0.0)), 0.0, 1.0);',
    '  vec3 fogCol = mix(u_fogColor, skyColorV(vec3(rd.x, max(rd.y, 0.0) * 0.5, rd.z)), 0.65);',
    '  T = 1.0 - f; F = fogCol * f;',
    '}',
    'void main() {',
    '  vec3 camRight = vec3(u_view[0][0], u_view[1][0], u_view[2][0]);',
    '  vec3 camUp = vec3(u_view[0][1], u_view[1][1], u_view[2][1]);',
    '  vec3 center = i_posSize.xyz;',
    '  vec3 toCamV = u_camPos - center;',
    '  float dist = max(length(toCamV), 1e-3);',
    '  vec3 toCam = toCamV / dist;',
    '  float size = i_posSize.w;',
    '  float a = i_color.a;',
    '  // keep tiny far particles at >= ~1.5 px, trading size for opacity (no sparkle aliasing).',
    '  // Smoke conserves coverage (1/k^2); glows only lose 1/k so distant fireworks still read.',
    '  float pxPerM = u_proj[1][1] * u_resolution.y * 0.5 / dist;',
    '  float px = size * pxPerM;',
    '  if (px < 1.5) { float k = 1.5 / max(px, 1e-4); size *= k; a /= mix(k * k, k, i_stretch.w); }',
    '  // fade out particles that would clip the near plane or smother the view (a chase camera',
    '  // flying through its own smoke trail): by distance and by on-screen size',
    '  a *= smoothstep(size * 0.35, size * 1.6 + 0.6, dist);',
    '  float scr = size * u_proj[1][1] / dist;',          // radius as a fraction of the half-height
    '  a *= 1.0 - smoothstep(0.22, 0.75, scr) * (1.0 - 0.6 * i_stretch.w);',
    '  float cr = cos(i_params.x), sr = sin(i_params.x);',
    '  vec3 R = camRight * cr + camUp * sr;',
    '  vec3 U = -camRight * sr + camUp * cr;',
    '  vec3 st = i_stretch.xyz;',
    '  vec3 stp = st - toCam * dot(st, toCam);',
    '  float sl = length(stp);',
    '  vec3 offs;',
    '  if (sl > 1e-3) {',
    '    vec3 ax = stp / sl;',
    '    vec3 pr = normalize(cross(ax, toCam));',
    '    // streak: centered behind the particle along its motion',
    '    offs = ax * (a_position.x * (size + sl * 0.5) - sl * 0.5) + pr * a_position.y * size;',
    '    R = ax; U = pr;',
    '  } else {',
    '    offs = (R * a_position.x + U * a_position.y) * size;',
    '  }',
    '  vec3 world = center + offs;',
    '  gl_Position = u_viewProj * vec4(world, 1.0);',
    '  float cell = i_params.y;',
    '  float c = cell > 3.5 ? 0.0 : cell;',
    '  vec2 cellOrigin = vec2(mod(c, 2.0), floor(c / 2.0)) * 0.5;',
    '  v_q = a_position.xy;',
    '  v_uv = cellOrigin + (a_position.xy * 0.5 + 0.5) * 0.5;',
    '  v_color = vec4(i_color.rgb, a);',
    '  v_world = center;',
    '  v_right = R; v_up = U; v_toCam = toCam;',
    '  v_params = i_params;',
    '  v_add = i_stretch.w;',
    '  fogV(center, v_fogT, v_fogF);',
    '}'
  ].join('\n');

  var FS = [
    'uniform sampler2D u_atlas;',
    'in vec2 v_uv;',
    'in vec2 v_q;',
    'in vec4 v_color;',
    'in vec3 v_world;',
    'in vec3 v_right;',
    'in vec3 v_up;',
    'in vec3 v_toCam;',
    'in vec4 v_params;',
    'in float v_add;',
    'in vec3 v_fogF;',
    'in float v_fogT;',
    'out vec4 outColor;',
    'void main() {',
    '  vec4 tex = texture(u_atlas, v_uv);',
    '  float a = tex.a;',
    '  if (v_params.y > 3.5) a = smoothstep(0.32, 0.42, a);    // hard-edged debris chunk',
    '  a *= v_color.a;',
    '  if (a < 0.003) discard;',
    '  vec3 alb = toLinear(v_color.rgb);',
    '  vec3 lit = vec3(0.0);',
    '  if (v_add < 1.0) {',
    '  // Puff lighting: treat the sprite as a soft sphere (bright sun side, dark underside).',
    '  float r2 = min(dot(v_q, v_q), 1.0);',
    '  vec3 N = normalize(v_right * v_q.x + v_up * v_q.y + v_toCam * sqrt(1.0 - r2) * 0.9);',
    '  float ndl = dot(N, u_sunDir);',
    '  float wrap = clamp(ndl * 0.6 + 0.4, 0.0, 1.0);',
    '  // forward scattering: smoke glows when back-lit by a low sun',
    '  float fwd = pow(max(dot(-v_toCam, u_sunDir), 0.0), 6.0) * 0.6;',
    '  vec3 shaded = alb * (hemiAmbient(N) * 1.1 + u_sunColor * (wrap * 0.55 + fwd) + spotLight(v_world, v_toCam) * 0.6);',
    '  vec3 flat_ = alb * (u_ambientSky * 1.4 + u_sunColor * (0.35 + 0.2 * wrap));',
    '  lit = mix(flat_, shaded, v_params.z) * mix(0.8, 1.1, tex.r);',
    '  }',
    '  float keep = 1.0 - v_add;',
    '  vec3 body = keep > 0.0 ? finalColor(lit * v_fogT + v_fogF) : vec3(0.0);',
    '  // emitters are light sources: independent of the scene exposure so their hue survives the tonemap',
    '  vec3 emi = v_params.w > 0.0 ? finalColor(alb * v_params.w * mix(0.8, 1.2, tex.r) * v_fogT / max(u_exposure, 0.1)) : vec3(0.0);',
    '  outColor = vec4(body * a * keep + emi * a, a * keep);',
    '}'
  ].join('\n');

  // ------------------------------------------------------------------ API
  var Particles = {
    MAX: MAX,
    TYPES: TYPES,
    ready: false,
    /** Live particle count (read-only). */
    get count() { return count; },
    /** Timing of the last update/draw in ms (for perf checks). */
    stats: { updateMs: 0, drawMs: 0, drawn: 0 },

    init: function (glCtx) {
      gl = glCtx;
      var SL = RL.ShaderLib;
      prog = RL.GL.createProgram(gl, SL.vertex(VS), SL.fragment(FS), 'particles');
      atlas = buildAtlas();
      mesh = RL.GL.createMesh(gl, {
        positions: [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0],
        indices: [0, 1, 2, 0, 2, 3],
        instances: {
          data: inst, stride: STRIDE, usage: gl.DYNAMIC_DRAW, count: 0,
          attribs: [{ loc: 4, size: 4, offset: 0 }, { loc: 5, size: 4, offset: 4 },
            { loc: 6, size: 4, offset: 8 }, { loc: 7, size: 4, offset: 12 }]
        }
      });
      count = 0;
      Particles.ready = true;
    },

    /**
     * Spawn `count` particles. pos: v3 (required). vel: v3 base velocity or null.
     * Returns the number spawned (0 for unknown types / bad input).
     */
    emit: function (typeName, pos, vel, n, opts) {
      var id = TYPE_ID[typeName];
      if (id === undefined || !pos) return 0;
      var x = +pos[0], y = +pos[1], z = +pos[2];
      if (!(x === x && y === y && z === z)) return 0;
      var ux = 0, uy = 0, uz = 0;
      if (vel) {
        var inh = opts && opts.inherit !== undefined ? opts.inherit : 1;
        ux = vel[0] * inh; uy = vel[1] * inh; uz = vel[2] * inh;
        if (!(ux === ux && uy === uy && uz === uz)) { ux = 0; uy = 0; uz = 0; }
      }
      n = n === undefined ? 1 : Math.min(MAX, Math.max(0, n | 0));
      for (var k = 0; k < n; k++) spawn(id, x, y, z, ux, uy, uz, opts || null);
      return n;
    },

    update: function (dt) {
      if (!(dt > 0)) return;
      var t0 = performance.now();
      dt = Math.min(dt, 0.1);
      simTime += dt;
      frameNo++;
      for (var k = 0; k < NT; k++) tDragExp[k] = 1 - Math.exp(-tDrag[k] * dt);
      var W = RL.World, hasWorld = !!(W && W.heightAt);
      var waterY = RL.Config.water.level;
      var phase = frameNo & 3;

      var i = 0;
      while (i < count) {
        var a = age[i] + dt;
        if (a >= life[i]) { killAt(i); continue; }
        age[i] = a;
        var id = type[i], fl = tFlags[id];
        // wind (refreshed for a quarter of the pool per frame: windAt samples terrain + thermals)
        var wf = tWind[id];
        if (wf > 0 && ((i & 3) === phase)) sampleWind(i, simTime);
        var dg = drag[i];
        var kd = dg === tDrag[id] ? tDragExp[id] : 1 - Math.exp(-dg * dt);
        vx[i] += (wx[i] * wf - vx[i]) * kd;
        vy[i] += (wy[i] * wf - vy[i]) * kd - grav[i] * dt;
        vz[i] += (wz[i] * wf - vz[i]) * kd;
        px[i] += vx[i] * dt; py[i] += vy[i] * dt; pz[i] += vz[i] * dt;
        rot[i] += rotV[i] * dt;

        if ((fl & F_GROUND) && hasWorld) {
          var gh = W.heightAt(px[i], pz[i]);
          if (fl & F_BOUNCE) {
            if (py[i] < gh) {
              py[i] = gh;
              if (vy[i] < 0) vy[i] = -vy[i] * 0.35;
              vx[i] *= 0.6; vz[i] *= 0.6; rotV[i] *= 0.6;
              if (gh < waterY) { killAt(i); continue; }   // sank into the lake
            }
          } else {
            var floor = gh + size0[i] * 0.4;
            if (py[i] < floor) { py[i] = floor; if (vy[i] < 0) vy[i] = 0; }
          }
        }
        if ((fl & F_WATERKILL) && vy[i] < 0 && py[i] < waterY - 0.5) { killAt(i); continue; }

        // firework trails: about half the stars leave one, and never once the pool is 70% full
        // (a big show must not recycle the player's skywriting)
        if ((fl & F_TRAIL) && age[i] > 0.12 && seed[i] > 0.45 && count < MAX * 0.7) {
          aux[i] += dt;
          if (aux[i] > 0.06) {
            aux[i] = 0;
            spawn(ID_TRAIL, px[i], py[i], pz[i], vx[i] * 0.1, vy[i] * 0.1, vz[i] * 0.1, null);
            var j = count - 1;
            if (j >= 0 && type[j] === ID_TRAIL) {
              r0[j] = r1[j] = r0[i] * 0.8 + 0.2; g0[j] = g1[j] = g0[i] * 0.8 + 0.12; b0[j] = b1[j] = b0[i] * 0.8 + 0.05;
              size0[j] = size0[i] * 0.55; alpha0[j] = 0.7;
            }
          }
        } else if ((fl & F_SMOKETRAIL) && seed[i] > 0.55 && age[i] < life[i] * 0.7 && py[i] > 0) {
          aux[i] += dt;
          if (aux[i] > 0.09) {
            aux[i] = 0;
            spawn(ID_SMOKE, px[i], py[i], pz[i], 0, 1, 0, null);
            j = count - 1;
            if (j >= 0 && type[j] === ID_SMOKE) {
              size0[j] = 0.35 + size0[i]; grow[j] = 4; life[j] = rand(1.6, 2.6); alpha0[j] = 0.45;
              r0[j] = g0[j] = b0[j] = 0.2; r1[j] = g1[j] = b1[j] = 0.42;
            }
          }
        }
        i++;
      }
      if (cursor >= count) cursor = 0;
      Particles.stats.updateMs = performance.now() - t0;
    },

    draw: function (frame) {
      if (!Particles.ready || count === 0 || !frame) { Particles.stats.drawn = 0; return; }
      var t0 = performance.now();
      var cam = frame.camPos, fwd = frame.camForward;
      var cx = cam[0], cy = cam[1], cz = cam[2], fx = fwd[0], fy = fwd[1], fz = fwd[2];
      var i, n = 0, key;

      // 1. cull + depth keys (sqrt-spaced buckets: fine resolution close to the camera)
      bucketCount.fill(0);
      var scale = (SORT_BUCKETS - 1) / Math.sqrt(SORT_FAR);
      for (i = 0; i < count; i++) {
        var dx = px[i] - cx, dy = py[i] - cy, dz = pz[i] - cz;
        var d = dx * fx + dy * fy + dz * fz;
        var sz = size0[i] * (1 + grow[i]) + tStretch[type[i]] * 60;
        if (d < -sz) { depthKey[i] = 65535; continue; }
        key = d > 0 ? Math.sqrt(d) * scale : 0;
        key = key > SORT_BUCKETS - 1 ? SORT_BUCKETS - 1 : key | 0;
        depthKey[i] = key;
        bucketCount[key]++;
        n++;
      }
      if (n === 0) { Particles.stats.drawn = 0; return; }
      // 2. prefix sums, far buckets first
      var run = 0;
      for (key = SORT_BUCKETS - 1; key >= 0; key--) {
        var cnt = bucketCount[key];
        bucketCount[key] = run;
        run += cnt;
      }
      for (i = 0; i < count; i++) {
        key = depthKey[i];
        if (key !== 65535) order[bucketCount[key]++] = i;
      }

      // 3. instance data
      var night = frame.nightFactor || 0;
      for (var s = 0; s < n; s++) {
        i = order[s];
        var id = type[i];
        var t = age[i] / life[i];
        var fi = tFadeIn[id], fo = tFadeOut[id];
        var al = alpha0[i];
        if (fi > 0 && t < fi) al *= t / fi;
        if (t > 1 - fo) { var q = (1 - t) / fo; al *= q * q * (3 - 2 * q); }
        var fl = tFlags[id];
        if (fl & F_TWINKLE) al *= 0.6 + 0.4 * Math.sin(age[i] * 23 + seed[i] * 40);
        var gp = tGrowPow[id], e = 1 - t, ep = e;
        for (var gk = 1; gk < gp; gk++) ep *= e;
        var size = size0[i] * (1 + (grow[i] - 1) * (1 - ep));
        var gw = glow[i];
        if (gw > 0 && (fl & F_GLOWFADE)) gw *= Math.exp(-age[i] * 1.1);   // fire-lit smoke cools as it rises
        var add = tAdd[id], emis = tEmis[id] + gw;
        var cr, cg, cb;
        if (fl & F_HEAT) {
          var h = heat0[i] * (1 - t);
          h = h * h * (3 - 2 * h) * 0.25 + h * 0.75;
          heatColor(h, heatTmp);
          cr = heatTmp[0]; cg = heatTmp[1]; cb = heatTmp[2];
          var hot = M.smoothstep(0.16, 0.42, h);
          add = hot;
          emis = tEmis[id] * hot * hot * (1 + night * 0.5);
          al *= 0.55 + 0.45 * hot;   // cooled soot is thinner than the flame
        } else {
          cr = r0[i] + (r1[i] - r0[i]) * t; cg = g0[i] + (g1[i] - g0[i]) * t; cb = b0[i] + (b1[i] - b0[i]) * t;
        }
        var o = s * STRIDE;
        inst[o] = px[i]; inst[o + 1] = py[i]; inst[o + 2] = pz[i]; inst[o + 3] = size;
        inst[o + 4] = cr; inst[o + 5] = cg; inst[o + 6] = cb; inst[o + 7] = al;
        inst[o + 8] = rot[i]; inst[o + 9] = cellV[i]; inst[o + 10] = tLit[id]; inst[o + 11] = emis;
        var stt = tStretch[id];
        inst[o + 12] = vx[i] * stt; inst[o + 13] = vy[i] * stt; inst[o + 14] = vz[i] * stt; inst[o + 15] = add;
      }
      RL.GL.updateInstances(gl, mesh, inst, n);

      // 4. draw
      RL.GL.use(gl, prog);
      RL.GL.applyFrame(gl, prog, frame);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, atlas);
      RL.GL.setUniform(gl, prog, 'u_atlas', 0);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.disable(gl.CULL_FACE);
      RL.GL.drawMesh(gl, mesh, n);
      gl.bindTexture(gl.TEXTURE_2D, null);
      RL.GL.resetState(gl);
      Particles.stats.drawn = n;
      Particles.stats.drawMs = performance.now() - t0;
    },

    clear: function () {
      count = 0;
      cursor = 0;
    }
  };

  RL.Particles = Particles;
})(window.RL = window.RL || {});
