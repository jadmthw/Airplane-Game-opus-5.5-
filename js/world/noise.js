/*
 * Ridgeline — RL.Noise: seeded, deterministic 2D gradient noise for world generation.
 *
 *   var n = RL.Noise.create(seed);
 *   n.simplex2(x, y)                      -> [-1, 1]  (2D simplex noise)
 *   n.fbm(x, y, octaves, lacunarity, gain) -> about [-1, 1]  (fractal sum, normalised)
 *   n.ridged(x, y, octaves, lacunarity, gain) -> [0, 1]  (Musgrave ridged multifractal: sharp crests)
 *   n.warp(x, y, freq, amp, out)          -> out = [x', y'] domain-warped coordinates
 *
 * RL.Noise.simplex2 / fbm / ridged / warp are bound to a default instance seeded with
 * RL.Config.seed. Nothing here allocates per call, so it is safe in hot loops.
 */
(function (RL) {
  'use strict';

  var F2 = 0.5 * (Math.sqrt(3) - 1);
  var G2 = (3 - Math.sqrt(3)) / 6;

  // 16 unit gradients evenly spread around the circle (offset so none is axis aligned):
  // isotropic noise without the grid-aligned streaks of the classic 8-gradient table.
  var GX = new Float64Array(16), GY = new Float64Array(16);
  for (var gi = 0; gi < 16; gi++) {
    var ang = (gi + 0.37) / 16 * Math.PI * 2;
    GX[gi] = Math.cos(ang);
    GY[gi] = Math.sin(ang);
  }
  // With unit gradients the raw simplex sum peaks near 1/99; normalise to [-1, 1].
  var SCALE = 99.2;

  // Per-octave coordinate offsets so octaves never line up at the origin.
  var OFF_X = [0, 31.7, -17.3, 47.1, -59.9, 71.3, -83.9, 97.7, 13.1, -29.3];
  var OFF_Y = [0, -11.3, 23.9, -37.1, 43.7, -53.3, 67.1, -79.9, 89.3, -7.7];

  function create(seed) {
    var rand = RL.M.rng((seed >>> 0) ^ 0x9E3779B9);
    var p = new Uint8Array(256);
    for (var i = 0; i < 256; i++) p[i] = i;
    for (i = 255; i > 0; i--) {
      var j = Math.floor(rand() * (i + 1));
      var t = p[i]; p[i] = p[j]; p[j] = t;
    }
    var perm = new Uint8Array(512), permG = new Uint8Array(512);
    for (i = 0; i < 512; i++) { perm[i] = p[i & 255]; permG[i] = perm[i] & 15; }

    function simplex2(xin, yin) {
      var s = (xin + yin) * F2;
      var i = Math.floor(xin + s), j = Math.floor(yin + s);
      var t = (i + j) * G2;
      var x0 = xin - (i - t), y0 = yin - (j - t);
      var i1 = x0 > y0 ? 1 : 0, j1 = 1 - i1;
      var x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
      var x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
      var ii = i & 255, jj = j & 255;
      var n = 0, g;
      var t0 = 0.5 - x0 * x0 - y0 * y0;
      if (t0 > 0) { g = permG[ii + perm[jj]]; t0 *= t0; n += t0 * t0 * (GX[g] * x0 + GY[g] * y0); }
      var t1 = 0.5 - x1 * x1 - y1 * y1;
      if (t1 > 0) { g = permG[ii + i1 + perm[jj + j1]]; t1 *= t1; n += t1 * t1 * (GX[g] * x1 + GY[g] * y1); }
      var t2 = 0.5 - x2 * x2 - y2 * y2;
      if (t2 > 0) { g = permG[ii + 1 + perm[jj + 1]]; t2 *= t2; n += t2 * t2 * (GX[g] * x2 + GY[g] * y2); }
      return n * SCALE;
    }

    /** Fractal Brownian motion, normalised by the amplitude sum (about [-1, 1]). */
    function fbm(x, y, octaves, lacunarity, gain) {
      octaves = octaves || 4; lacunarity = lacunarity || 2.0; gain = gain || 0.5;
      var sum = 0, amp = 1, norm = 0, f = 1;
      for (var o = 0; o < octaves; o++) {
        sum += amp * simplex2(x * f + OFF_X[o % 10], y * f + OFF_Y[o % 10]);
        norm += amp;
        amp *= gain;
        f *= lacunarity;
      }
      return sum / norm;
    }

    /**
     * Ridged multifractal (Musgrave): each octave is weighted by the previous one, so fine
     * detail piles up on the crests and valleys stay smooth — natural sharp ridgelines.
     */
    function ridged(x, y, octaves, lacunarity, gain) {
      octaves = octaves || 6; lacunarity = lacunarity || 2.0; gain = gain || 0.5;
      var sum = 0, amp = 1, norm = 0, f = 1, weight = 1;
      for (var o = 0; o < octaves; o++) {
        var n = 1 - Math.abs(simplex2(x * f + OFF_X[o % 10], y * f + OFF_Y[o % 10]));
        n *= n;
        n *= weight;
        weight = n * 2;
        if (weight > 1) weight = 1;
        sum += n * amp;
        norm += amp;
        amp *= gain;
        f *= lacunarity;
      }
      return sum / norm;
    }

    /** Domain warp: out = (x, y) displaced by `amp` * a 2-octave fbm of frequency `freq`. */
    function warp(x, y, freq, amp, out) {
      var fx = x * freq, fy = y * freq;
      out[0] = x + amp * fbm(fx + 5.2, fy + 1.3, 2, 2.0, 0.5);
      out[1] = y + amp * fbm(fx - 3.7, fy + 8.1, 2, 2.0, 0.5);
      return out;
    }

    return { seed: seed, simplex2: simplex2, fbm: fbm, ridged: ridged, warp: warp };
  }

  var def = create(RL.Config ? RL.Config.seed : 1337);

  RL.Noise = {
    create: create,
    simplex2: def.simplex2,
    fbm: def.fbm,
    ridged: def.ridged,
    warp: def.warp
  };
})(window.RL = window.RL || {});
