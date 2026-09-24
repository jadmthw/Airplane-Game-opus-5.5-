/*
 * Ridgeline — RL.Terrain: the heightfield world (mountains, valley, lake basin, Serpent Canyon,
 * the stone arch), its vegetation and boulders, and a distant horizon ring of mountains.
 *
 * Height is generated in layers (all deterministic from Config.seed):
 *   1. "Layout" fields on a coarse grid: distance to the open regions (valley, the high pass to
 *      the canyon, the lake) and their floor heights, distance/position along the canyon.
 *   2. Natural terrain: floor + gentle rolling, then foothills and ridged, domain-warped mountains
 *      whose amplitude grows with distance from the open ground, plus a few named peaks.
 *   3. Carving: a mesa plateau around the canyon (so it always reads as a deep gorge), the canyon
 *      itself (flat floor, terraced rock walls), the lake bowl, and the airfield flat zone.
 *
 * heightAt() interpolates exactly the rendered triangles (alternating diagonals, see cellTri()).
 */
(function (RL) {
  'use strict';

  var C = RL.Config;
  var M = RL.M;

  function sstep(a, b, x) {
    var t = (x - a) / (b - a);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return t * t * (3 - 2 * t);
  }
  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }

  // ------------------------------------------------------------------ world layout constants
  // High pass linking the valley's north end to the canyon's north-east mouth (the ring course
  // flies it). Local to terrain.js; floors are per control point.
  var PASS = {
    name: 'Kestrel Pass',
    path: [[300, -4300], [1000, -4680], [1700, -4760], [2600, -4660], [3500, -4450], [3900, -4200]],
    floors: [190, 222, 250, 246, 230, 226],
    halfWidth: 360
  };
  // Standout named peaks (extra height on top of the ridged mountains).
  var PEAKS = [
    { name: 'Mount Kestrel', x: -2900, z: -2350, h: 760, R: 1750 },
    { name: 'The Sentinel', x: 4300, z: -1900, h: 640, R: 1500 },
    { name: 'Grandmother', x: -2000, z: 4700, h: 950, R: 1600 },
    { name: 'Aurora Peak', x: -1400, z: -5350, h: 950, R: 1500 }
  ];
  var HILL_AMP = 300;       // foothills
  var MTN_AMP = 1750;       // main ranges
  var LAYOUT_RES = 256;     // layout grid cells per side
  var SKIRT_OUTER = 24000;  // horizon ring radius
  var SKIRT_CELL = 500;

  // ------------------------------------------------------------------ state
  var half = C.world.half;
  var res = 256, N = 257, cell = 1, invCell = 1;
  var data = null;                 // Float32Array(N*N) heights, row-major z then x
  var heightData = null;
  var nA = null, nB = null;        // noise instances (terrain shape / surface variety)
  var OCT = 6;
  var W2 = new Float64Array(2);    // warp scratch
  var L = { D: 0, F: 0, CD: 0, CT: 0, out: 0 }; // layout sample scratch
  var layoutD, layoutF, layoutCD, layoutCT, layoutCell, layoutInv, LN;
  var valleyPl, canyonPl, passPl, sAirfield = 0;
  var colTmp = new Float64Array(6);

  // GL resources
  var glc = null, progTerrain = null, progProps = null;
  var terrainMesh = null, skirtMesh = null, coniferMesh = null, broadleafMesh = null;
  var boulderMesh = null, archMesh = null;
  var windVec = new Float32Array(2);
  var flatZoneVec = new Float32Array(4);

  // ------------------------------------------------------------------ polylines
  /** Catmull-Rom spline through control points, resampled every ~step meters. */
  function buildPolyline(ctrl, step) {
    var xs = [], zs = [], ctrlIdx = [];
    var n = ctrl.length;
    function pt(i) {
      if (i < 0) return [2 * ctrl[0][0] - ctrl[1][0], 2 * ctrl[0][1] - ctrl[1][1]];
      if (i >= n) return [2 * ctrl[n - 1][0] - ctrl[n - 2][0], 2 * ctrl[n - 1][1] - ctrl[n - 2][1]];
      return ctrl[i];
    }
    for (var i = 0; i < n - 1; i++) {
      var p0 = pt(i - 1), p1 = pt(i), p2 = pt(i + 1), p3 = pt(i + 2);
      var segLen = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
      var k = Math.max(2, Math.ceil(segLen / step));
      ctrlIdx.push(xs.length);
      for (var j = 0; j < k; j++) {
        var t = j / k, t2 = t * t, t3 = t2 * t;
        for (var c = 0; c < 2; c++) {
          var v = 0.5 * ((2 * p1[c]) + (-p0[c] + p2[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 +
            (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t3);
          (c === 0 ? xs : zs).push(v);
        }
      }
    }
    ctrlIdx.push(xs.length);
    xs.push(ctrl[n - 1][0]); zs.push(ctrl[n - 1][1]);
    var m = xs.length;
    var pl = {
      n: m, xs: new Float64Array(xs), zs: new Float64Array(zs), cum: new Float64Array(m),
      segLen: new Float64Array(m), inv2: new Float64Array(m), ctrlS: [], total: 0,
      dScr: new Float64Array(m), sScr: new Float64Array(m)
    };
    for (i = 0; i < m - 1; i++) {
      var dx = pl.xs[i + 1] - pl.xs[i], dz = pl.zs[i + 1] - pl.zs[i];
      var l2 = dx * dx + dz * dz;
      pl.segLen[i] = Math.sqrt(l2);
      pl.inv2[i] = l2 > 0 ? 1 / l2 : 0;
      pl.cum[i + 1] = pl.cum[i] + pl.segLen[i];
    }
    pl.total = pl.cum[m - 1];
    pl.minX = Math.min.apply(null, xs); pl.maxX = Math.max.apply(null, xs);
    pl.minZ = Math.min.apply(null, zs); pl.maxZ = Math.max.apply(null, zs);
    for (i = 0; i < ctrlIdx.length; i++) pl.ctrlS.push(pl.cum[ctrlIdx[i]]);
    return pl;
  }

  /**
   * Distance from (x, z) to the polyline (out.d, exact) and a smoothly blended arc-length
   * position (out.s): a soft-min over segments, so s never jumps across medial axes (which would
   * put cliffs into the terrain where floor heights differ).
   */
  function queryPath(pl, x, z, kappa, out) {
    var xs = pl.xs, zs = pl.zs, dS = pl.dScr, sS = pl.sScr, n = pl.n - 1;
    var d2min = Infinity;
    for (var i = 0; i < n; i++) {
      var ax = xs[i], az = zs[i], dx = xs[i + 1] - ax, dz = zs[i + 1] - az;
      var t = ((x - ax) * dx + (z - az) * dz) * pl.inv2[i];
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      var px = ax + dx * t - x, pz = az + dz * t - z;
      var d2 = px * px + pz * pz;
      dS[i] = d2;
      sS[i] = pl.cum[i] + t * pl.segLen[i];
      if (d2 < d2min) d2min = d2;
    }
    // compact polynomial kernel (1 - x/6)^4: exp-like falloff without the exp() cost
    var dmin = Math.sqrt(d2min), lim = dmin + 6 * kappa, lim2 = lim * lim, inv = 1 / (6 * kappa);
    var ws = 0, ss = 0;
    for (i = 0; i < n; i++) {
      if (dS[i] >= lim2) continue;
      var w = 1 - (Math.sqrt(dS[i]) - dmin) * inv;
      w *= w; w *= w;
      ws += w; ss += w * sS[i];
    }
    out.d = dmin;
    out.s = ws > 0 ? ss / ws : 0;
    return out;
  }

  /** Distance from (x, z) to the polyline's bounding box (0 inside). */
  function boxDist(pl, x, z) {
    var ex = Math.max(pl.minX - x, 0, x - pl.maxX), ez = Math.max(pl.minZ - z, 0, z - pl.maxZ);
    return Math.sqrt(ex * ex + ez * ez);
  }

  /** Unit tangent (xz) of a polyline at arc length s. */
  function pathTangent(pl, s, out) {
    var a = Math.max(0, s - 40), b = Math.min(pl.total, s + 40);
    var pa = pathPoint(pl, a, [0, 0]), pb = pathPoint(pl, b, [0, 0]);
    var dx = pb[0] - pa[0], dz = pb[1] - pa[1], l = Math.hypot(dx, dz) || 1;
    out[0] = dx / l; out[1] = dz / l;
    return out;
  }
  function pathPoint(pl, s, out) {
    var i = 0;
    while (i < pl.n - 2 && pl.cum[i + 1] < s) i++;
    var t = pl.segLen[i] > 0 ? clamp((s - pl.cum[i]) / pl.segLen[i], 0, 1) : 0;
    out[0] = pl.xs[i] + (pl.xs[i + 1] - pl.xs[i]) * t;
    out[1] = pl.zs[i] + (pl.zs[i + 1] - pl.zs[i]) * t;
    return out;
  }

  // ------------------------------------------------------------------ floors
  function valleyFloor(s) {
    var V = C.valley, t = s / valleyPl.total, ta = sAirfield / valleyPl.total;
    var elev = C.airfield.elevation;
    // Flat near the field (so the airfield sits naturally), climbing towards the north end.
    if (t <= ta) return V.floorStart + (elev - V.floorStart) * sstep(0, 1, t / Math.max(ta, 1e-3));
    var u = (t - ta) / Math.max(1 - ta, 1e-3);
    return elev + (V.floorEnd - elev) * Math.pow(u, 1.5);
  }
  function passFloor(s) {
    var cs = passPl.ctrlS, f = PASS.floors;
    for (var i = 0; i < cs.length - 1; i++) {
      if (s <= cs[i + 1] || i === cs.length - 2) {
        var t = clamp((s - cs[i]) / Math.max(cs[i + 1] - cs[i], 1e-3), 0, 1);
        return f[i] + (f[i + 1] - f[i]) * sstep(0, 1, t);
      }
    }
    return f[f.length - 1];
  }
  function canyonFloor(t) { return C.canyon.floorStart + (C.canyon.floorEnd - C.canyon.floorStart) * t; }
  // Extra plateau height around the canyon: zero at the lake mouth and the NE exit, 300 m mid-way.
  function canyonRim(t) { return 300 * sstep(0.04, 0.30, t) * (1 - sstep(0.60, 0.80, t)); }
  // Terraced (strata) rock wall profile, 0 at the floor edge -> 1 at the rim. Monotonic.
  function wallCurve(s) {
    var b = 1 - (1 - s) * (1 - s);
    var q = b * 5, fq = q - Math.floor(q);
    var terr = (Math.floor(q) + sstep(0.3, 0.7, fq)) / 5;
    return b + (terr - b) * 0.5;
  }

  // ------------------------------------------------------------------ layout grid
  function buildLayout() {
    LN = LAYOUT_RES + 1;
    layoutCell = 2 * half / LAYOUT_RES;
    layoutInv = 1 / layoutCell;
    layoutD = new Float32Array(LN * LN);
    layoutF = new Float32Array(LN * LN);
    layoutCD = new Float32Array(LN * LN);
    layoutCT = new Float32Array(LN * LN);
    var qv = { d: 0, s: 0 }, qp = { d: 0, s: 0 }, qc = { d: 0, s: 0 };
    var lakes = C.water.lakes, lvl = C.water.level;
    var V = C.valley;
    var K = 150, KF = 320;
    var Ds = new Float64Array(2 + lakes.length), Fs = new Float64Array(2 + lakes.length);
    for (var iz = 0; iz < LN; iz++) {
      var z = -half + iz * layoutCell;
      for (var ix = 0; ix < LN; ix++) {
        var x = -half + ix * layoutCell;
        queryPath(valleyPl, x, z, 150, qv);
        queryPath(passPl, x, z, 150, qp);
        // the canyon only shapes terrain within ~1.25 km, so skip the exact query far away
        var bd = boxDist(canyonPl, x, z);
        if (bd > 1500) { qc.d = bd; qc.s = 0; } else queryPath(canyonPl, x, z, 45, qc);
        Ds[0] = qv.d - V.halfWidth; Fs[0] = valleyFloor(qv.s);
        Ds[1] = qp.d - PASS.halfWidth; Fs[1] = passFloor(qp.s);
        for (var l = 0; l < lakes.length; l++) {
          Ds[2 + l] = Math.hypot(x - lakes[l].x, z - lakes[l].z) - (lakes[l].radius + 150);
          Fs[2 + l] = lvl + 7;
        }
        var dmin = Infinity, k;
        for (k = 0; k < Ds.length; k++) if (Ds[k] < dmin) dmin = Ds[k];
        var sum = 0, wsum = 0, fsum = 0;
        for (k = 0; k < Ds.length; k++) {
          sum += Math.exp(-(Ds[k] - dmin) / K);
          var w = Math.exp(-(Ds[k] - dmin) / KF);
          wsum += w; fsum += w * Fs[k];
        }
        var i = iz * LN + ix;
        layoutD[i] = dmin - K * Math.log(sum);   // smooth union of the open regions
        layoutF[i] = fsum / wsum;
        layoutCD[i] = qc.d;
        layoutCT[i] = qc.s / canyonPl.total;
      }
    }
  }

  function sampleLayout(x, z) {
    var gx = (x + half) * layoutInv, gz = (z + half) * layoutInv;
    var ox = 0, oz = 0;
    if (!(gx >= 0)) { ox = gx === gx ? -gx * layoutCell : 0; gx = 0; }
    else if (gx > LAYOUT_RES) { ox = (gx - LAYOUT_RES) * layoutCell; gx = LAYOUT_RES; }
    if (!(gz >= 0)) { oz = gz === gz ? -gz * layoutCell : 0; gz = 0; }
    else if (gz > LAYOUT_RES) { oz = (gz - LAYOUT_RES) * layoutCell; gz = LAYOUT_RES; }
    var ix = Math.floor(gx), iz = Math.floor(gz);
    if (ix > LAYOUT_RES - 1) ix = LAYOUT_RES - 1;
    if (iz > LAYOUT_RES - 1) iz = LAYOUT_RES - 1;
    var fx = gx - ix, fz = gz - iz;
    var i = iz * LN + ix;
    var w00 = (1 - fx) * (1 - fz), w10 = fx * (1 - fz), w01 = (1 - fx) * fz, w11 = fx * fz;
    L.D = layoutD[i] * w00 + layoutD[i + 1] * w10 + layoutD[i + LN] * w01 + layoutD[i + LN + 1] * w11;
    L.F = layoutF[i] * w00 + layoutF[i + 1] * w10 + layoutF[i + LN] * w01 + layoutF[i + LN + 1] * w11;
    L.CD = layoutCD[i] * w00 + layoutCD[i + 1] * w10 + layoutCD[i + LN] * w01 + layoutCD[i + LN + 1] * w11;
    L.CT = layoutCT[i] * w00 + layoutCT[i + 1] * w10 + layoutCT[i + LN] * w01 + layoutCT[i + LN + 1] * w11;
    L.out = Math.sqrt(ox * ox + oz * oz);
    L.D += L.out;
    L.CD += L.out;
    return L;
  }

  // ------------------------------------------------------------------ height function
  function lakeDist(lk, x, z) {
    // wobbly shoreline so the lake is not a perfect circle
    return Math.hypot(x - lk.x, z - lk.z) * (1 + 0.075 * nB.simplex2(x * 0.0024 + 3.3, z * 0.0024 - 1.7));
  }

  function heightFn(x, z) {
    sampleLayout(x, z);
    var D = L.D;
    var V = C.valley, CN = C.canyon;
    var h = L.F + 2.6 + 2.4 * nA.fbm(x * 0.0032, z * 0.0032, 2, 2.0, 0.5);

    var aHill = HILL_AMP * sstep(0, V.ramp, D);
    if (aHill > 0) {
      var aMtn = MTN_AMP * sstep(250, V.ramp + 2100, D) * (1 + 0.35 * sstep(0, 8000, L.out));
      nA.warp(x, z, 0.00026, 620, W2);
      var r = nA.ridged(W2[0] * 0.00034, W2[1] * 0.00034, OCT, 2.07, 0.45);
      var hills = 0.5 + 0.5 * nA.fbm(x * 0.0012 + 3.1, z * 0.0012 - 7.7, 3, 2.0, 0.5);
      // broad massifs so ranges have mass and saddles instead of uniform needles
      var massif = 0.5 + 0.5 * nA.fbm(x * 0.00021 + 7.7, z * 0.00021 - 2.2, 2, 2.0, 0.5);
      h += aHill * hills * (0.5 + 0.9 * r) + aMtn * (0.1 + 0.9 * r) * (0.5 + 0.75 * massif);
      var pm = sstep(0, V.ramp, D);
      for (var p = 0; p < PEAKS.length; p++) {
        var pk = PEAKS[p];
        var rr = Math.hypot(x - pk.x, z - pk.z) / pk.R;
        if (rr < 1) h += pk.h * Math.pow(1 - rr, 1.7) * (0.65 + 0.7 * r) * pm;
      }
    }

    // Serpent Canyon: plateau around it, then carve floor + terraced walls.
    var cd = L.CD, edge = CN.halfWidth + CN.wallWidth;
    if (cd < edge + 950) {
      var t = L.CT, fl = canyonFloor(t), rim = canyonRim(t);
      if (rim > 0) {
        var plateau = fl + rim + 35 * nA.fbm(x * 0.0021 - 9.3, z * 0.0021 + 4.4, 2, 2.0, 0.5);
        var m = 1 - sstep(edge + 300, edge + 950, cd);
        if (plateau > h) h += (plateau - h) * m;
      }
      if (cd < edge && h > fl) {
        var s = clamp((cd - CN.halfWidth) / CN.wallWidth, 0, 1);
        var bed = fl + 0.45 * nB.simplex2(x * 0.02, z * 0.02);
        if (cd < 26) bed -= 1.8 * (1 - (cd / 26) * (cd / 26));   // dry river channel
        h = bed + (h - bed) * wallCurve(s);
      }
    }

    // Lake basins: bowl below the water level, gentle beach, then rising banks.
    var lakes = C.water.lakes, lvl = C.water.level, inBasin = false;
    for (var l = 0; l < lakes.length; l++) {
      var lk = lakes[l], d = lakeDist(lk, x, z);
      if (d < lk.radius * 1.3) inBasin = true;
      if (d < lk.radius * 2) {
        var bowl;
        if (d < lk.radius) {
          var q = d / lk.radius;
          bowl = lvl - lk.depth * Math.pow(1 - q * q, 0.85);
        } else {
          var dd = d - lk.radius;
          bowl = lvl + 0.05 * dd + 0.0025 * dd * dd;
        }
        if (bowl < h) h = bowl;
      }
    }

    // Airfield: exactly flat inside the zone (+ ~1.5 grid cells so partially covered cells are
    // flat too), blending back to natural terrain over `blend` meters.
    var A = C.airfield, fz = A.flatZone, mg = cell * 1.5;
    var ex = Math.max(fz.minX - mg - x, 0, x - fz.maxX - mg);
    var ez = Math.max(fz.minZ - mg - z, 0, z - fz.maxZ - mg);
    var de = Math.sqrt(ex * ex + ez * ez);
    if (de < A.blend) {
      var wgt = sstep(0, A.blend, de);
      h = A.elevation + (h - A.elevation) * wgt;
    }

    if (!inBasin && h < lvl + 3.2) h = lvl + 3.2;
    if (h > 1800) h = 1800 + (h - 1800) * 0.45;
    return h;
  }

  // ------------------------------------------------------------------ surface colour
  function forestDensity(x, z) {
    return 0.5 + 0.5 * nB.fbm(x * 0.0011 + 17.1, z * 0.0011 - 4.2, 3, 2.1, 0.5);
  }
  function treeLine(x, z) { return 960 + 70 * nB.simplex2(x * 0.0017, z * 0.0017); }

  // Banded canyon sandstone (shared with the arch so they match).
  function sandstone(x, y, z, out) {
    var wob = 2.2 * nB.simplex2(x * 0.004, z * 0.004);
    var b1 = Math.sin(y * 0.085 + wob) * 0.5 + 0.5;
    var b2 = Math.sin(y * 0.23 + wob * 1.7 + 1.3) * 0.5 + 0.5;
    var r = 0.70, g = 0.44, b = 0.24;                 // rust sandstone
    r += (0.80 - r) * b1 * 0.8; g += (0.63 - g) * b1 * 0.8; b += (0.38 - b) * b1 * 0.8; // ochre/buff bands
    var k = 0.84 + 0.16 * b2;
    out[0] = r * k; out[1] = g * k; out[2] = b * k;
    return out;
  }

  /**
   * Vertex albedo (sRGB) + shine, meadow amount, snow amount written into out[0..5].
   * ny = up component of the smooth normal, ao = baked occlusion factor.
   */
  function surfaceColor(x, z, h, ny, ao, out) {
    var lvl = C.water.level, CN = C.canyon;
    var slope = 1 - ny;
    var n1 = nB.simplex2(x * 0.0021 - 7.1, z * 0.0021 + 2.9);
    var n2 = nB.simplex2(x * 0.013 + 1.7, z * 0.013 - 5.3);
    var moist = clamp(0.62 + 0.38 * nB.fbm(x * 0.0007 + 11, z * 0.0007 - 5, 2, 2, 0.5) - (h - 90) / 1300, 0, 1);
    // meadow: dry gold <-> lush green
    var r = 0.52 + (0.27 - 0.52) * moist, g = 0.51 + (0.41 - 0.51) * moist, b = 0.29 + (0.18 - 0.29) * moist;
    var vv = 1 + 0.07 * n2;
    r *= vv; g *= vv; b *= vv;
    // alpine tundra above the forests
    var alp = sstep(620, 1050, h + n1 * 80);
    r += (0.50 - r) * alp; g += (0.48 - g) * alp; b += (0.31 - b) * alp;
    var meadow = (1 - alp);
    // forest floor under the tree clusters (matches tree placement)
    var fd = forestDensity(x, z), tl = treeLine(x, z);
    var fAmt = sstep(0.56, 0.7, fd) * (1 - sstep(tl - 90, tl + 10, h)) * sstep(lvl + 4, lvl + 14, h) *
      (1 - sstep(0.22, 0.36, slope)) * 0.7;
    r += (0.19 - r) * fAmt; g += (0.32 - g) * fAmt; b += (0.15 - b) * fAmt;
    meadow *= 1 - fAmt;
    // rock on steep slopes and bare summits
    var cd = sampleLayout(x, z).CD;
    var edge = CN.halfWidth + CN.wallWidth;
    // vegetation clings to steeper ground low down; high up only gentle slopes stay green
    var rockSlope = 0.44 - 0.14 * sstep(250, 1100, h);
    var rockAmt = Math.max(sstep(rockSlope - 0.12, rockSlope + 0.04, slope + n2 * 0.04), sstep(1050, 1300, h + n1 * 60) * 0.75);
    var canyonAmt = 1 - sstep(edge - 10, edge + 110, cd);
    if (canyonAmt > 0) rockAmt = Math.max(rockAmt, sstep(0.16, 0.3, slope) * canyonAmt);
    var canyonRock = 0;
    if (rockAmt > 0) {
      canyonRock = rockAmt * canyonAmt;
      var kr = 0.86 + 0.16 * n1 + 0.06 * n2;
      var rr = 0.43 * kr, rg = 0.38 * kr, rb = 0.33 * kr;
      if (canyonAmt > 0) {
        sandstone(x, h, z, colTmp);
        rr += (colTmp[0] - rr) * canyonAmt; rg += (colTmp[1] - rg) * canyonAmt; rb += (colTmp[2] - rb) * canyonAmt;
      }
      r += (rr - r) * rockAmt; g += (rg - g) * rockAmt; b += (rb - b) * rockAmt;
      meadow *= 1 - rockAmt;
    }
    // canyon floor: warm gravel with a pale dry riverbed
    var floorAmt = (1 - sstep(CN.halfWidth - 12, CN.halfWidth + 18, cd)) * sstep(0.02, 0.06, sampleLayout(x, z).CT + 0.05);
    if (floorAmt > 0) {
      var bedAmt = 1 - sstep(14, 30, cd);
      var fr = 0.55 + 0.08 * bedAmt, fg = 0.47 + 0.08 * bedAmt, fb = 0.36 + 0.09 * bedAmt;
      // patches of scrub along the dry riverbed
      var scrub = sstep(0.1, 0.45, nB.simplex2(x * 0.012 + 4.4, z * 0.012 - 8.8)) * (1 - bedAmt);
      fr += (0.36 - fr) * scrub; fg += (0.42 - fg) * scrub; fb += (0.22 - fb) * scrub;
      var kf = 1 + 0.08 * n2;
      r += (fr * kf - r) * floorAmt; g += (fg * kf - g) * floorAmt; b += (fb * kf - b) * floorAmt;
      meadow *= 1 - floorAmt;
      canyonRock *= 1 - floorAmt;
    }
    // snow (not on steep faces)
    var snowLine = 1170 + 110 * n1;
    var snow = sstep(snowLine - 50, snowLine + 80, h) * (1 - sstep(0.40, 0.62, slope));
    r += (0.93 - r) * snow; g += (0.95 - g) * snow; b += (1.0 - b) * snow;
    // shore sand, darker wet lakebed below the waterline
    var shine = snow * 0.9;
    var sand = 1 - sstep(lvl + 1.8, lvl + 4.0, h);
    if (sand > 0) {
      var sr = 0.80, sg = 0.72, sb = 0.52;
      var wet = sstep(lvl + 0.8, lvl - 1.5, h);
      sr += (0.50 - sr) * wet; sg += (0.46 - sg) * wet; sb += (0.34 - sb) * wet;
      var deep = sstep(lvl - 3, lvl - 16, h);
      sr += (0.30 - sr) * deep; sg += (0.33 - sg) * deep; sb += (0.26 - sb) * deep;
      r += (sr - r) * sand; g += (sg - g) * sand; b += (sb - b) * sand;
      shine = Math.max(shine, wet * 0.5 * sand);
      meadow *= 1 - sand;
    }
    out[0] = r * ao; out[1] = g * ao; out[2] = b * ao;
    // alpha: shine, or (negative) canyon rock amount so the shader can draw crisp strata
    out[3] = canyonRock > 0.02 ? -canyonRock : shine; out[4] = clamp(meadow * sstep(0.35, 0.7, moist + 0.2), 0, 1); out[5] = snow;
    return out;
  }

  // ------------------------------------------------------------------ triangles / queries
  function heightAt(x, z) {
    var gx = (x + half) * invCell, gz = (z + half) * invCell;
    if (!(gx > 0)) gx = 0; else if (gx > res) gx = res;
    if (!(gz > 0)) gz = 0; else if (gz > res) gz = res;
    var ix = gx | 0, iz = gz | 0;
    if (ix >= res) ix = res - 1;
    if (iz >= res) iz = res - 1;
    var fx = gx - ix, fz = gz - iz;
    var i = iz * N + ix;
    var ha = data[i], hb = data[i + 1], hc = data[i + N], hd = data[i + N + 1];
    if (((ix + iz) & 1) === 0) {           // diagonal a-d: triangles (a,c,d) and (a,d,b)
      if (fz > fx) return ha + (hd - hc) * fx + (hc - ha) * fz;
      return ha + (hb - ha) * fx + (hd - hb) * fz;
    }
    // diagonal b-c: triangles (a,c,b) and (b,c,d)
    if (fx + fz <= 1) return ha + (hb - ha) * fx + (hc - ha) * fz;
    return hd + (hc - hd) * (1 - fx) + (hb - hd) * (1 - fz);
  }

  function normalAt(x, z, out) {
    out = out || RL.v3.create();
    if (!data) { out[0] = 0; out[1] = 1; out[2] = 0; return out; }
    var gx = (x + half) * invCell, gz = (z + half) * invCell;
    if (!(gx > 0)) gx = 0; else if (gx > res) gx = res;
    if (!(gz > 0)) gz = 0; else if (gz > res) gz = res;
    var ix = gx | 0, iz = gz | 0;
    if (ix >= res) ix = res - 1;
    if (iz >= res) iz = res - 1;
    var fx = gx - ix, fz = gz - iz;
    var i = iz * N + ix;
    var ha = data[i], hb = data[i + 1], hc = data[i + N], hd = data[i + N + 1];
    var dx, dz;
    if (((ix + iz) & 1) === 0) {
      if (fz > fx) { dx = hd - hc; dz = hc - ha; } else { dx = hb - ha; dz = hd - hb; }
    } else if (fx + fz <= 1) { dx = hb - ha; dz = hc - ha; } else { dx = hd - hc; dz = hd - hb; }
    var nx = -dx, ny = cell, nz = -dz;
    var l = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
    out[0] = nx * l; out[1] = ny * l; out[2] = nz * l;
    return out;
  }

  // ------------------------------------------------------------------ mesh building
  function buildTerrainMesh(gl) {
    var nv = N * N;
    var pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3);
    var col = new Float32Array(nv * 4), uv = new Float32Array(nv * 2);
    var out = new Float64Array(6);
    for (var iz = 0; iz < N; iz++) {
      var z = -half + iz * cell;
      for (var ix = 0; ix < N; ix++) {
        var x = -half + ix * cell, i = iz * N + ix, h = data[i];
        pos[i * 3] = x; pos[i * 3 + 1] = h; pos[i * 3 + 2] = z;
        var hl = data[iz * N + Math.max(ix - 1, 0)], hr = data[iz * N + Math.min(ix + 1, res)];
        var hu = data[Math.max(iz - 1, 0) * N + ix], hdn = data[Math.min(iz + 1, res) * N + ix];
        var nx = hl - hr, ny = 2 * cell, nz = hu - hdn;
        var l = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
        nx *= l; ny *= l; nz *= l;
        nrm[i * 3] = nx; nrm[i * 3 + 1] = ny; nrm[i * 3 + 2] = nz;
        // cheap baked occlusion: concave spots (gullies, canyon floor edges) darker, crests lighter
        var ao = 1;
        var rr = Math.max(2, Math.round(70 / cell));
        var a1 = data[iz * N + Math.max(ix - rr, 0)], a2 = data[iz * N + Math.min(ix + rr, res)];
        var a3 = data[Math.max(iz - rr, 0) * N + ix], a4 = data[Math.min(iz + rr, res) * N + ix];
        var conc = (a1 + a2 + a3 + a4) * 0.25 - h;
        ao = clamp(1 - conc * 0.0035, 0.7, 1.06);
        surfaceColor(x, z, h, ny, ao, out);
        col[i * 4] = out[0]; col[i * 4 + 1] = out[1]; col[i * 4 + 2] = out[2]; col[i * 4 + 3] = out[3];
        uv[i * 2] = out[4]; uv[i * 2 + 1] = out[5];
      }
    }
    var idx = new Uint32Array(res * res * 6), k = 0;
    for (iz = 0; iz < res; iz++) {
      for (ix = 0; ix < res; ix++) {
        var a = iz * N + ix, b = a + 1, c = a + N, d = a + N + 1;
        if (((ix + iz) & 1) === 0) { idx[k++] = a; idx[k++] = c; idx[k++] = d; idx[k++] = a; idx[k++] = d; idx[k++] = b; }
        else { idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = d; }
      }
    }
    return RL.GL.createMesh(gl, { positions: pos, normals: nrm, colors: col, colorSize: 4, uvs: uv, indices: idx });
  }

  /** Horizon ring of low-detail mountains from the playable square out to ~24 km. */
  function buildSkirtMesh(gl) {
    var cells = Math.round(2 * SKIRT_OUTER / SKIRT_CELL), n = cells + 1;
    var hs = new Float32Array(n * n);
    var inner = half;
    for (var iz = 0; iz < n; iz++) {
      var z = -SKIRT_OUTER + iz * SKIRT_CELL;
      for (var ix = 0; ix < n; ix++) {
        var x = -SKIRT_OUTER + ix * SKIRT_CELL;
        var h;
        if (Math.abs(x) <= inner + 1 && Math.abs(z) <= inner + 1) {
          // Boundary vertex: stay below the terrain edge over the whole adjacent span so the
          // ring never pokes above the detailed terrain (no cracks, no overlap).
          h = Infinity;
          for (var k = -SKIRT_CELL; k <= SKIRT_CELL; k += cell) {
            var sx = Math.abs(z) >= inner - 1 ? clamp(x + k, -inner, inner) : x;
            var sz = Math.abs(z) >= inner - 1 ? z : clamp(z + k, -inner, inner);
            h = Math.min(h, heightAt(sx, sz));
          }
          h -= 20;
        } else {
          h = heightFn(x, z);
        }
        hs[iz * n + ix] = h;
      }
    }
    var pos = [], nrm = [], col = [], uv = [], idx = [], out = new Float64Array(6);
    for (iz = 0; iz < n; iz++) {
      for (ix = 0; ix < n; ix++) {
        x = -SKIRT_OUTER + ix * SKIRT_CELL; z = -SKIRT_OUTER + iz * SKIRT_CELL;
        h = hs[iz * n + ix];
        var nx = hs[iz * n + Math.max(ix - 1, 0)] - hs[iz * n + Math.min(ix + 1, cells)];
        var nz = hs[Math.max(iz - 1, 0) * n + ix] - hs[Math.min(iz + 1, cells) * n + ix];
        var ny = 2 * SKIRT_CELL, l = 1 / Math.hypot(nx, ny, nz);
        pos.push(x, h, z);
        nrm.push(nx * l, ny * l, nz * l);
        surfaceColor(x, z, h, ny * l, 1, out);
        col.push(out[0], out[1], out[2], out[3]);
        uv.push(0, out[5]);
      }
    }
    for (iz = 0; iz < cells; iz++) {
      for (ix = 0; ix < cells; ix++) {
        var cx = -SKIRT_OUTER + (ix + 0.5) * SKIRT_CELL, cz = -SKIRT_OUTER + (iz + 0.5) * SKIRT_CELL;
        if (Math.abs(cx) < inner && Math.abs(cz) < inner) continue;
        if (Math.hypot(cx, cz) > SKIRT_OUTER) continue;
        var a = iz * n + ix, b = a + 1, c = a + n, d = a + n + 1;
        idx.push(a, c, d, a, d, b);
      }
    }
    return RL.GL.createMesh(gl, { positions: pos, normals: nrm, colors: col, colorSize: 4, uvs: uv, indices: idx });
  }

  // ------------------------------------------------------------------ props (trees, boulders)
  function coniferGeo() {
    var G = RL.Geo, parts = [];
    var trunk = G.cylinder(0.028, 0.045, 0.2, 5, [0.36, 0.25, 0.16]);
    G.translate(trunk, 0, 0.1, 0);
    parts.push(trunk);
    var tiers = [[0.33, 0.10, 0.48, [0.16, 0.32, 0.19]], [0.26, 0.33, 0.43, [0.18, 0.35, 0.20]],
      [0.18, 0.56, 0.44, [0.21, 0.39, 0.22]]];
    for (var i = 0; i < tiers.length; i++) {
      var t = tiers[i], c = G.cone(t[0], t[2], 7, t[3], { capBottom: i === 0 });
      G.rotateY(c, i * 0.45);
      G.translate(c, 0, t[1] + t[2] / 2, 0);
      parts.push(c);
    }
    return G.toFlat(G.merge(parts));
  }
  function broadleafGeo() {
    var G = RL.Geo, parts = [];
    var trunk = G.cylinder(0.045, 0.07, 0.46, 5, [0.38, 0.28, 0.18]);
    G.translate(trunk, 0, 0.23, 0);
    parts.push(trunk);
    var blobs = [[0, 0.62, 0, 0.36, [0.31, 0.48, 0.19]], [0.19, 0.76, 0.07, 0.24, [0.36, 0.53, 0.21]],
      [-0.17, 0.72, -0.1, 0.25, [0.33, 0.50, 0.20]], [0.02, 0.86, -0.12, 0.2, [0.38, 0.55, 0.22]]];
    for (var i = 0; i < blobs.length; i++) {
      var b = blobs[i], s = G.sphere(b[3], 7, 5, b[4]);
      G.scale(s, 1, 0.82, 1);
      G.translate(s, b[0], b[1], b[2]);
      parts.push(s);
    }
    return G.toFlat(G.merge(parts));
  }
  function boulderGeo() {
    var G = RL.Geo, g = G.sphere(1, 7, 5, [0.5, 0.46, 0.41]);
    var P = g.positions;
    for (var i = 0; i < P.length; i += 3) {
      var x = P[i], y = P[i + 1], z = P[i + 2];
      var k = 1 + 0.28 * nB.simplex2(x * 1.7 + z * 0.9 + 3.1, y * 1.9 - z * 0.6) + 0.12 * nB.simplex2(x * 4.1, z * 4.3 + y * 2);
      P[i] = x * k; P[i + 1] = y * k * 0.72 + 0.25; P[i + 2] = z * k;
    }
    G.colorBy(g, function (p) { var v = 0.9 + 0.1 * p[1]; return [0.5 * v, 0.46 * v, 0.41 * v]; });
    return G.toFlat(g);
  }

  function nearRing(x, z, r) {
    var rings = C.rings;
    for (var i = 0; i < rings.length; i++) {
      var dx = x - rings[i].x, dz = z - rings[i].z;
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  }
  function inFlatZone(x, z, margin) {
    var fz = C.airfield.flatZone;
    return x > fz.minX - margin && x < fz.maxX + margin && z > fz.minZ - margin && z < fz.maxZ + margin;
  }
  function inLake(x, z, margin) {
    var lakes = C.water.lakes;
    for (var i = 0; i < lakes.length; i++) if (lakeDist(lakes[i], x, z) < lakes[i].radius + margin) return true;
    return false;
  }

  function placeProps(low) {
    var rnd = M.rng((C.seed ^ 0x51ED) >>> 0);
    var nrm = [0, 0, 0];
    var lvl = C.water.level, CN = C.canyon, rw = C.airfield.runway;
    var wantCon = low ? 5000 : 10000, wantBroad = low ? 1500 : 3000, wantRock = low ? 400 : 850;
    var con = new Float32Array(wantCon * 8), broad = new Float32Array(wantBroad * 8), rock = new Float32Array(wantRock * 8);
    var nc = 0, nb = 0, nr = 0;
    var canyonRocks = low ? 60 : 130, landRocks = wantRock - canyonRocks;
    var span = half - 60;
    var archX = C.arch.x, archZ = C.arch.z;
    for (var att = 0; att < 400000 && (nc < wantCon || nb < wantBroad || nr < landRocks); att++) {
      var x = (rnd() * 2 - 1) * span, z = (rnd() * 2 - 1) * span;
      var u = rnd(), v = rnd(), w = rnd();
      if (inFlatZone(x, z, 60)) continue;
      if (Math.abs(x - rw.cx) < 150 && z > -2800 && z < 3600) continue;   // keep the approach clear
      var h = heightAt(x, z);
      if (h < lvl + 3.5 || inLake(x, z, 20)) continue;
      normalAt(x, z, nrm);
      var cd = sampleLayout(x, z).CD;
      var onCanyonFloor = cd < CN.halfWidth + 20;
      // boulders: rocky slopes, canyon floor edges, scattered in meadows
      if (nr < landRocks && w < 0.05) {
        var rockOk = (nrm[1] < 0.93 && nrm[1] > 0.55 && h < 1500 && !onCanyonFloor) || (u < 0.08 && !onCanyonFloor);
        if (rockOk && !nearRing(x, z, 40)) {
          var s = 1.4 + Math.pow(rnd(), 2.2) * 5;
          var o = nr * 8;
          rock[o] = x; rock[o + 1] = h - s * 0.3; rock[o + 2] = z; rock[o + 3] = s;
          rock[o + 4] = rnd() * 6.283; rock[o + 5] = rnd() * 2 - 1; rock[o + 6] = 0; rock[o + 7] = 0.7 + rnd() * 0.6;
          nr++;
          continue;
        }
      }
      if (onCanyonFloor || nrm[1] < 0.8 || nearRing(x, z, 50)) continue;
      var tl = treeLine(x, z);
      if (h > tl) continue;
      var fd = forestDensity(x, z);
      // forests (same field as the ground tint), densest near the open ground where people fly
      var near = 1 - 0.75 * sstep(900, 2600, sampleLayout(x, z).D);
      var dens = sstep(0.56, 0.7, fd) * (1 - sstep(0.22, 0.36, 1 - nrm[1])) * near;
      var lone = 0.018;
      if (h < 480 && nb < wantBroad) {
        // broadleaf groves on the valley floor and low foothills
        var grove = sstep(0.55, 0.7, 0.5 + 0.5 * nB.fbm(x * 0.0024 - 31, z * 0.0024 + 12, 2, 2, 0.5));
        if (v < grove * 0.8 + lone + dens * 0.25 * (1 - sstep(250, 480, h))) {
          var sb = 9 + rnd() * 7, ob = nb * 8;
          broad[ob] = x; broad[ob + 1] = h - 0.4; broad[ob + 2] = z; broad[ob + 3] = sb;
          broad[ob + 4] = rnd() * 6.283; broad[ob + 5] = rnd() * 2 - 1; broad[ob + 6] = rnd() * 6.283; broad[ob + 7] = 0.85 + rnd() * 0.3;
          nb++;
          continue;
        }
      }
      if (nc < wantCon && v < dens * (0.55 + 0.45 * sstep(90, 260, h)) + lone * 0.5) {
        var sc = (12 + rnd() * 12) * (1 - 0.35 * sstep(tl - 250, tl, h)), oc = nc * 8;
        con[oc] = x; con[oc + 1] = h - 0.5 - (1 - nrm[1]) * sc * 0.15; con[oc + 2] = z; con[oc + 3] = sc;
        con[oc + 4] = rnd() * 6.283; con[oc + 5] = rnd() * 2 - 1; con[oc + 6] = rnd() * 6.283; con[oc + 7] = 0.85 + rnd() * 0.35;
        nc++;
      }
    }
    // boulders strewn along the canyon floor (clear of the channel centre and the arch)
    var tg = [0, 0], pp = [0, 0];
    for (var e = 0; e < canyonRocks * 4 && nr < wantRock; e++) {
      var sp = rnd() * canyonPl.total;
      pathPoint(canyonPl, sp, pp);
      pathTangent(canyonPl, sp, tg);
      var off = (rnd() < 0.5 ? -1 : 1) * (35 + rnd() * (CN.halfWidth - 30));
      var bx = pp[0] - tg[1] * off, bz = pp[1] + tg[0] * off;
      if (Math.hypot(bx - archX, bz - archZ) < 90 || inLake(bx, bz, 30) || nearRing(bx, bz, 40)) continue;
      var bs = 1.5 + Math.pow(rnd(), 2) * 5.5, ob2 = nr * 8;
      rock[ob2] = bx; rock[ob2 + 1] = heightAt(bx, bz) - bs * 0.3; rock[ob2 + 2] = bz; rock[ob2 + 3] = bs;
      rock[ob2 + 4] = rnd() * 6.283; rock[ob2 + 5] = rnd() * 2 - 1; rock[ob2 + 6] = 0; rock[ob2 + 7] = 0.7 + rnd() * 0.6;
      nr++;
    }
    return { con: con, nc: nc, broad: broad, nb: nb, rock: rock, nr: nr };
  }

  function instancedMesh(gl, geo, inst, count) {
    return RL.GL.meshFromGeo(gl, geo, {
      instances: {
        data: inst.subarray(0, Math.max(count, 1) * 8), stride: 8, count: count,
        attribs: [{ loc: 4, size: 4, offset: 0 }, { loc: 5, size: 4, offset: 4 }]
      }
    });
  }

  // ------------------------------------------------------------------ the stone arch
  var archInfo = null;

  function buildArch(gl) {
    var A = C.arch;
    var q = { d: 0, s: 0 };
    queryPath(canyonPl, A.x, A.z, 5, q);
    var tan = pathTangent(canyonPl, q.s, [0, 0]);
    var dx = tan[0], dz = tan[1];
    var ax = -dz, az = dx;                      // across the canyon (horizontal)
    var H = A.openingHeight, Wd = A.openingHalfWidth, T = A.thickness;
    // floor reference: the highest floor point across the opening (the dry channel is lower)
    var floorY = -Infinity;
    for (var u = -Wd; u <= Wd; u += 5) floorY = Math.max(floorY, heightAt(A.x + ax * u, A.z + az * u));
    var Hout = H + 50, Wout = Wd + 105, foot = -20;
    var UiEnd = Wd * Math.sqrt(1 - foot / H), UoEnd = Wout * Math.sqrt(1 - foot / Hout);
    function inner(p, o) { var uu = p * UiEnd; o[0] = uu; o[1] = H * (1 - (uu / Wd) * (uu / Wd)); return o; }
    function outer(p, o) {
      var uu = p * UoEnd;
      o[0] = uu; o[1] = Hout * (1 - (uu / Wout) * (uu / Wout)) + 7 * nB.simplex2(p * 2.3 + 4.1, 0.7);
      return o;
    }
    // rounded-rectangle cross-section loop in (r across the band 0..1, w along the canyon -0.5..0.5)
    var LOOP = [[0, -0.32], [0, 0], [0, 0.32], [0.07, 0.5], [0.35, 0.5], [0.65, 0.5], [0.93, 0.5],
      [1, 0.32], [1, 0], [1, -0.32], [0.93, -0.5], [0.65, -0.5], [0.35, -0.5], [0.07, -0.5]];
    var K = LOOP.length, NP = 64;
    var pos = [], colr = [], ind = [];
    var I = [0, 0], O = [0, 0], cs = new Float64Array(3);
    for (var ip = 0; ip <= NP; ip++) {
      var p = -1 + 2 * ip / NP;
      inner(p, I); outer(p, O);
      var bu = O[0] - I[0], bv = O[1] - I[1], bl = Math.hypot(bu, bv) || 1;
      var ru = bu / bl, rv = bv / bl;          // band direction: from the opening into the rock
      var thick = T * (1 + 0.9 * Math.pow(Math.abs(p), 3));
      for (var k = 0; k < K; k++) {
        var r = LOOP[k][0], wf = LOOP[k][1];
        var uu = I[0] + bu * r, vv = I[1] + bv * r, ww = wf * thick;
        // rocky displacement; the inner face only moves into the rock so the opening stays clear
        var nz1 = nB.simplex2(uu * 0.022 + ww * 0.017 + 11.3, vv * 0.024 - ww * 0.013);
        var nz2 = nB.simplex2(uu * 0.07 - 3.3 + ww * 0.05, vv * 0.07 + ww * 0.04);
        var disp = 4.5 * nz1 + 1.4 * nz2;
        if (r === 0) { uu += ru * (Math.abs(disp) * 0.7 + 0.6); vv += rv * (Math.abs(disp) * 0.7 + 0.6); }
        else if (r === 1) { uu += ru * disp; vv += rv * disp; }
        else { ww += (wf > 0 ? 1 : -1) * disp * 0.8; }
        var wx = A.x + ax * uu + dx * ww, wy = floorY + vv, wz = A.z + az * uu + dz * ww;
        pos.push(wx, wy, wz);
        sandstone(wx, wy, wz, cs);
        var shade = (r === 0 ? 0.78 : 1.0) * (0.8 + 0.2 * sstep(-10, 40, vv)) * (1 + 0.06 * nz2);
        colr.push(cs[0] * shade, cs[1] * shade, cs[2] * shade);
      }
    }
    for (ip = 0; ip < NP; ip++) {
      for (k = 0; k < K; k++) {
        var a = ip * K + k, b = ip * K + (k + 1) % K, c = (ip + 1) * K + k, d = (ip + 1) * K + (k + 1) % K;
        ind.push(a, c, d, a, d, b);
      }
    }
    var geo = { positions: pos, normals: [], colors: colr, uvs: [], indices: ind };
    // Fix winding so faces point outwards: the crown's top face (r = 1) must face up.
    var mid = (NP / 2) * K + 8, tri = null;
    for (var t = 0; t < ind.length; t += 3) if (ind[t] === mid) { tri = t; break; }
    if (tri !== null) {
      var P = pos, i0 = ind[tri] * 3, i1 = ind[tri + 1] * 3, i2 = ind[tri + 2] * 3;
      var e1 = [P[i1] - P[i0], P[i1 + 1] - P[i0 + 1], P[i1 + 2] - P[i0 + 2]];
      var e2 = [P[i2] - P[i0], P[i2 + 1] - P[i0 + 1], P[i2 + 2] - P[i0 + 2]];
      var ny = e1[2] * e2[0] - e1[0] * e2[2];
      if (ny < 0) for (t = 0; t < ind.length; t += 3) { var tmp = ind[t + 1]; ind[t + 1] = ind[t + 2]; ind[t + 2] = tmp; }
    }
    var flat = RL.Geo.toFlat(geo);
    archMesh = RL.GL.meshFromGeo(gl, flat, {
      instances: { data: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1]), stride: 8, count: 1,
        attribs: [{ loc: 4, size: 4, offset: 0 }, { loc: 5, size: 4, offset: 4 }] }
    });

    // Sphere colliders along the band, each capped so it never reaches into the opening.
    var cols = [];
    var NS = 72;
    for (var is = 0; is <= NS; is++) {
      var ps = -1 + 2 * is / NS;
      inner(ps, I); outer(ps, O);
      var bw = Math.hypot(O[0] - I[0], O[1] - I[1]);
      var rows = Math.max(1, Math.ceil(bw / 44));
      var th = T * (1 + 0.9 * Math.pow(Math.abs(ps), 3));
      for (var rw = 0; rw < rows; rw++) {
        var rf = (rw + 0.5) / rows;
        var cu = I[0] + (O[0] - I[0]) * rf, cv = I[1] + (O[1] - I[1]) * rf;
        var rad = Math.min(bw / (2 * rows), th / 2 + 3);
        // distance to the opening's parabola
        var dmin = Infinity;
        for (var j = 0; j <= 240; j++) {
          var pu = -Wd + (2 * Wd) * j / 240, pv = H * (1 - (pu / Wd) * (pu / Wd));
          dmin = Math.min(dmin, Math.hypot(cu - pu, cv - pv));
        }
        if (Math.abs(cu) < Wd && cv < H * (1 - (cu / Wd) * (cu / Wd))) continue;  // inside the opening
        rad = Math.min(rad, dmin - 1.5);
        if (rad < 4 || cv + rad < -5) continue;
        cols.push({
          type: 'sphere', name: 'arch', radius: rad,
          center: [A.x + ax * cu, floorY + cv, A.z + az * cu]
        });
      }
    }
    archInfo = {
      center: [A.x, floorY, A.z], dir: [dx, 0, dz], across: [ax, 0, az],
      openingHeight: H, openingHalfWidth: Wd, thickness: T
    };
    return cols;
  }

  // ------------------------------------------------------------------ shaders
  var TERRAIN_VS = [
    'layout(location = 0) in vec3 a_position;',
    'layout(location = 1) in vec3 a_normal;',
    'layout(location = 2) in vec4 a_color;',
    'layout(location = 3) in vec2 a_uv;',
    'out vec3 v_pos; out vec3 v_nrm; out vec4 v_col; out vec2 v_mat;',
    'void main() {',
    '  v_pos = a_position; v_nrm = a_normal; v_col = a_color; v_mat = a_uv;',
    '  gl_Position = u_viewProj * vec4(a_position, 1.0);',
    '}'
  ].join('\n');

  var TERRAIN_FS = [
    'in vec3 v_pos; in vec3 v_nrm; in vec4 v_col; in vec2 v_mat;',
    'uniform vec4 u_flatZone;',
    'out vec4 outColor;',
    'void main() {',
    '  float dist = length(v_pos - u_camPos);',
    '  vec3 Ns = normalize(v_nrm);',
    '  // faceted (per-triangle) normal for the low-poly look, faded out far away',
    '  vec3 Nf = normalize(cross(dFdx(v_pos), dFdy(v_pos)));',
    '  if (Nf.y < 0.0) Nf = -Nf;',
    '  vec3 N = normalize(mix(Ns, Nf, 0.6 * (1.0 - smoothstep(3000.0, 9000.0, dist))));',
    '  vec3 alb = toLinear(v_col.rgb);',
    '  // multi-scale detail so the ground reads up close and from altitude',
    '  float n1 = vnoise(v_pos.xz * 0.018);',
    '  float n2 = vnoise(v_pos.xz * 0.11 + 7.0);',
    '  float n3 = vnoise(v_pos.xz * 0.55 + 3.0);',
    '  float fine = 1.0 - smoothstep(150.0, 900.0, dist);',
    '  alb *= 1.0 + (n1 - 0.5) * 0.28 + ((n2 - 0.5) * 0.22 + (n3 - 0.5) * 0.16) * fine;',
    '  // mown stripes on the airfield grass',
    '  vec2 inz = step(u_flatZone.xy, v_pos.xz) * step(v_pos.xz, u_flatZone.zw);',
    '  float stripe = step(0.5, fract(v_pos.x / 18.0));',
    '  alb *= 1.0 + inz.x * inz.y * (stripe - 0.5) * 0.10 * (1.0 - smoothstep(400.0, 2500.0, dist));',
    '  // wildflowers sprinkled over lush meadows (near the camera only)',
    '  if (dist < 220.0 && v_mat.x > 0.2) {',
    '    vec2 cp = v_pos.xz * 0.8;',
    '    vec2 ci = floor(cp);',
    '    float hh = hash12(ci + 17.0);',
    '    float patchN = vnoise(v_pos.xz * 0.03 + 11.0);',
    '    vec2 off = vec2(hash12(ci + 3.1), hash12(ci + 9.7)) * 0.6 + 0.2;',
    '    float dot0 = smoothstep(0.2, 0.1, length(fract(cp) - off));',
    '    float fl = dot0 * step(0.96 - 0.12 * patchN, hh) * smoothstep(0.5, 0.75, patchN) * v_mat.x;',
    '    fl *= 1.0 - smoothstep(120.0, 220.0, dist);',
    '    float hue = hash12(ci + 5.5);',
    '    vec3 fc = hue < 0.4 ? vec3(0.95, 0.85, 0.25) : (hue < 0.75 ? vec3(0.95, 0.95, 0.92) : vec3(0.62, 0.45, 0.85));',
    '    alb = mix(alb, toLinear(fc), fl);',
    '  }',
    '  // sedimentary strata on the canyon walls (vertex colours are too coarse for crisp bands)',
    '  float canyonRock = max(-v_col.a, 0.0);',
    '  if (canyonRock > 0.01) {',
    '    float y = v_pos.y + (vnoise(v_pos.xz * 0.008) - 0.5) * 16.0;',
    '    float b1 = sin(y * 0.33) * 0.5 + 0.5;',
    '    float b2 = smoothstep(0.82, 0.9, fract(y / 23.0)) * (1.0 - smoothstep(0.93, 1.0, fract(y / 23.0)));',
    '    float b3 = smoothstep(0.6, 0.9, vnoise(vec2(y * 0.09, 3.7)));',
    '    alb *= mix(1.0, (0.86 + 0.24 * b1) * (1.0 - 0.28 * b2) * (1.0 + 0.12 * b3), canyonRock);',
    '  }',
    '  // moonlit scenes read less saturated (night vision)',
    '  alb = mix(alb, vec3(dot(alb, vec3(0.3, 0.55, 0.15))) * vec3(0.85, 0.95, 1.15), u_nightFactor * 0.45);',
    '  float sh = shadowFactor(v_pos, N);',
    '  float shine = max(v_col.a, 0.0);',
    '  vec3 c = shadeLit(alb, N, v_pos, sh, shine * 0.35, mix(10.0, 36.0, shine));',
    '  // snow glitter',
    '  if (v_mat.y > 0.5 && dist < 600.0) {',
    '    float g = step(0.985, hash12(floor(v_pos.xz * 2.3)));',
    '    c += u_sunColor * g * 0.6 * max(dot(N, u_sunDir), 0.0) * sh * (1.0 - smoothstep(200.0, 600.0, dist)) * v_mat.y;',
    '  }',
    '  c = applyFog(c, v_pos);',
    '  outColor = vec4(finalColor(c), 1.0);',
    '}'
  ].join('\n');

  var PROPS_VS = [
    'layout(location = 0) in vec3 a_position;',
    'layout(location = 1) in vec3 a_normal;',
    'layout(location = 2) in vec4 a_color;',
    'layout(location = 4) in vec4 i_a;   // x, y, z, scale',
    'layout(location = 5) in vec4 i_b;   // yaw, tint (-1..1), sway phase, height scale',
    'uniform float u_sway;',
    'uniform vec2 u_wind;',
    'uniform float u_baseAO;',
    'out vec3 v_pos; out vec3 v_nrm; out vec3 v_col;',
    'void main() {',
    '  float c = cos(i_b.x), s = sin(i_b.x);',
    '  vec3 p = a_position; p.y *= i_b.w;',
    '  vec3 r = vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z) * i_a.w;',
    '  float hy = max(a_position.y, 0.0);',
    '  float sway = (sin(u_time * 1.3 + i_b.z) * 0.7 + sin(u_time * 2.9 + i_b.z * 1.7) * 0.3 + 0.6) * hy * hy * u_sway;',
    '  r.xz += u_wind * sway * i_a.w * 0.03;',
    '  v_pos = i_a.xyz + r;',
    '  v_nrm = vec3(c * a_normal.x + s * a_normal.z, a_normal.y, -s * a_normal.x + c * a_normal.z);',
    '  float t = i_b.y;',
    '  vec3 tint = vec3(1.0 + 0.10 * t, 1.0 + 0.04 * t, 1.0 - 0.10 * t) * (1.0 + 0.08 * sin(i_b.z * 3.1));',
    '  float ao = mix(1.0, mix(0.5, 1.0, clamp(a_position.y * 1.6, 0.0, 1.0)), u_baseAO);',
    '  v_col = a_color.rgb * tint * ao;',
    '  gl_Position = u_viewProj * vec4(v_pos, 1.0);',
    '}'
  ].join('\n');

  var PROPS_FS = [
    'in vec3 v_pos; in vec3 v_nrm; in vec3 v_col;',
    'uniform float u_rockDetail;',
    'out vec4 outColor;',
    'void main() {',
    '  vec3 N = normalize(v_nrm);',
    '  vec3 alb = toLinear(v_col);',
    '  if (u_rockDetail > 0.0) alb *= 1.0 + (vnoise(v_pos.xz * 0.3 + v_pos.y * 0.21) - 0.5) * 0.25 * u_rockDetail;',
    '  alb = mix(alb, vec3(dot(alb, vec3(0.3, 0.55, 0.15))) * vec3(0.85, 0.95, 1.15), u_nightFactor * 0.45);',
    '  float sh = shadowFactor(v_pos, N);',
    '  vec3 c = shadeLit(alb, N, v_pos, sh, 0.04, 16.0);',
    '  // foliage lets a little light through on the shaded side',
    '  c += alb * u_sunColor * 0.10 * (1.0 - u_rockDetail) * clamp(0.5 - 0.5 * dot(N, u_sunDir), 0.0, 1.0);',
    '  c = applyFog(c, v_pos);',
    '  outColor = vec4(finalColor(c), 1.0);',
    '}'
  ].join('\n');

  function setU(gl, prog, name, a, b, c, d) {
    var u = prog.uniforms[name];
    if (!u) return;
    if (b === undefined) gl.uniform1f(u.loc, a);
    else if (c === undefined) gl.uniform2f(u.loc, a, b);
    else gl.uniform4f(u.loc, a, b, c, d);
  }

  // ------------------------------------------------------------------ landmarks
  function summit(pk) {
    var best = -Infinity, bx = pk.x, bz = pk.z;
    for (var dz = -500; dz <= 500; dz += 25) {
      for (var dx = -500; dx <= 500; dx += 25) {
        var h = heightAt(pk.x + dx, pk.z + dz);
        if (h > best) { best = h; bx = pk.x + dx; bz = pk.z + dz; }
      }
    }
    return { name: pk.name, x: bx, z: bz, y: best, kind: 'peak' };
  }

  function buildLandmarks() {
    var lm = [];
    var A = C.airfield;
    lm.push({ name: A.name, x: A.runway.cx, z: A.runway.cz, y: A.elevation, kind: 'airfield' });
    for (var i = 0; i < C.water.lakes.length; i++) {
      var lk = C.water.lakes[i];
      lm.push({ name: lk.name, x: lk.x, z: lk.z, y: C.water.level, kind: 'lake' });
    }
    var mid = pathPoint(canyonPl, canyonPl.total * 0.3, [0, 0]);
    lm.push({ name: C.canyon.name, x: mid[0], z: mid[1], y: heightAt(mid[0], mid[1]), kind: 'canyon' });
    if (archInfo) lm.push({ name: 'Needle Arch', x: C.arch.x, z: C.arch.z, y: archInfo.center[1] + archInfo.openingHeight, kind: 'arch' });
    var pp = pathPoint(passPl, passPl.ctrlS[2], [0, 0]);
    lm.push({ name: PASS.name, x: pp[0], z: pp[1], y: heightAt(pp[0], pp[1]), kind: 'pass' });
    for (i = 0; i < PEAKS.length; i++) lm.push(summit(PEAKS[i]));
    return lm;
  }

  // ------------------------------------------------------------------ public API
  var Terrain = {
    ready: false,
    colliders: [],
    landmarks: [],
    arch: null,
    res: 0,
    half: half,
    initMs: 0,
    heightAt: function (x, z) { return data ? heightAt(x, z) : C.airfield.elevation; },
    normalAt: normalAt,

    init: function (gl, opts) {
      var t0 = performance.now();
      opts = opts || {};
      res = Math.max(32, (opts.resolution || C.world.resolution) | 0);
      N = res + 1;
      cell = 2 * half / res;
      invCell = 1 / cell;
      OCT = res >= 400 ? 6 : 5;
      nA = RL.Noise.create(C.seed);
      nB = RL.Noise.create((C.seed + 7919) >>> 0);

      valleyPl = buildPolyline(C.valley.path, 80);
      canyonPl = buildPolyline(C.canyon.path, 60);
      passPl = buildPolyline(PASS.path, 80);
      var q = { d: 0, s: 0 };
      sAirfield = queryPath(valleyPl, C.airfield.runway.cx, C.airfield.runway.cz, 5, q).s;
      buildLayout();
      var tLayout = performance.now();

      data = new Float32Array(N * N);
      for (var iz = 0; iz < N; iz++) {
        var z = -half + iz * cell;
        for (var ix = 0; ix < N; ix++) data[iz * N + ix] = heightFn(-half + ix * cell, z);
      }
      heightData = { data: data, res: res, half: half };
      Terrain.heightAt = heightAt;      // fast path once the data exists
      var tHeights = performance.now();

      glc = gl;
      var low = res < 400;
      if (gl) {
        var SL = RL.ShaderLib;
        progTerrain = RL.GL.createProgram(gl, SL.vertex(TERRAIN_VS), SL.fragment(TERRAIN_FS), 'terrain');
        progProps = RL.GL.createProgram(gl, SL.vertex(PROPS_VS), SL.fragment(PROPS_FS), 'terrainProps');
        terrainMesh = buildTerrainMesh(gl);
        skirtMesh = buildSkirtMesh(gl);
        var props = placeProps(low);
        coniferMesh = instancedMesh(gl, coniferGeo(), props.con, props.nc);
        broadleafMesh = instancedMesh(gl, broadleafGeo(), props.broad, props.nb);
        boulderMesh = instancedMesh(gl, boulderGeo(), props.rock, props.nr);
        Terrain.counts = { conifers: props.nc, broadleaf: props.nb, boulders: props.nr };
        Terrain.colliders = buildArch(gl);
      } else {
        Terrain.colliders = [];
      }
      Terrain.arch = archInfo;
      Terrain.landmarks = buildLandmarks();
      var fz = C.airfield.flatZone;
      flatZoneVec[0] = fz.minX; flatZoneVec[1] = fz.minZ; flatZoneVec[2] = fz.maxX; flatZoneVec[3] = fz.maxZ;
      var toRad = (C.wind.from + 180) * M.DEG, ws = clamp(C.wind.speed / 4, 0.3, 2.5);
      windVec[0] = Math.sin(toRad) * ws; windVec[1] = -Math.cos(toRad) * ws;
      Terrain.res = res;
      Terrain.ready = true;
      Terrain.initMs = performance.now() - t0;
      Terrain.timings = { layout: tLayout - t0, heights: tHeights - tLayout, total: Terrain.initMs };
    },

    getHeightData: function () { return heightData; },

    draw: function (frame) {
      var gl = glc;
      if (!Terrain.ready || !gl || !progTerrain) return;
      var G = RL.GL;
      G.use(gl, progTerrain);
      G.applyFrame(gl, progTerrain, frame);
      var u = progTerrain.uniforms.u_flatZone;
      if (u) gl.uniform4fv(u.loc, flatZoneVec);
      G.drawMesh(gl, terrainMesh);
      G.drawMesh(gl, skirtMesh);

      G.use(gl, progProps);
      G.applyFrame(gl, progProps, frame);
      setU(gl, progProps, 'u_wind', windVec[0], windVec[1]);
      setU(gl, progProps, 'u_sway', 1);
      setU(gl, progProps, 'u_baseAO', 1);
      setU(gl, progProps, 'u_rockDetail', 0);
      G.drawMesh(gl, coniferMesh);
      G.drawMesh(gl, broadleafMesh);
      setU(gl, progProps, 'u_sway', 0);
      setU(gl, progProps, 'u_baseAO', 0);
      setU(gl, progProps, 'u_rockDetail', 1);
      G.drawMesh(gl, boulderMesh);
      if (archMesh) G.drawMesh(gl, archMesh);
    },

    /** Internal helpers exposed for tests / debugging (not part of the contract). */
    _debug: {
      canyonAt: function (x, z) { var l = sampleLayout(x, z); return { dist: l.CD, t: l.CT, floor: canyonFloor(l.CT) }; },
      openAt: function (x, z) { var l = sampleLayout(x, z); return { D: l.D, floor: l.F }; },
      mesh: function () { return terrainMesh; },
      canyonPoint: function (t) { return pathPoint(canyonPl, t * canyonPl.total, [0, 0]); },
      canyonLength: function () { return canyonPl ? canyonPl.total : 0; }
    }
  };

  RL.Terrain = Terrain;
})(window.RL = window.RL || {});
