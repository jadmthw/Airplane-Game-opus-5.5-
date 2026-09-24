/*
 * Ridgeline — RL.Aircraft: the procedural low-poly "Ridgeline Sparrow" aerobatic monoplane.
 *
 *   init(gl), draw(frame, plane, opts), drawLights(frame, plane, opts),
 *   getShadowCasters(plane) -> [{mesh, model}], cockpitOffset (model-space eye point),
 *   getLandingLight(plane, nightFactor) -> {pos, dir, intensity}
 *
 * Model space: nose = -Z, right wing = +X, up = +Y, origin = centre of gravity (matches the
 * flight model's contact points). Geometry is authored in model space for every part; animated
 * parts (ailerons, flaps, elevator, rudder, prop, gear legs, wheels) get their own mesh and a
 * per-frame matrix = planeMatrix * hinge rotation, so the livery (computed procedurally in the
 * fragment shader from the un-animated model-space position) stays continuous across hinges.
 *
 * Materials (uv.x of every vertex): 0 plain vertex colour, 1 wing livery, 2 fuselage, 3 cowling,
 * 4 tail surfaces, 5 spinner swirl, 6 prop blade, 7 tyre/rubber, 8 instrument dial, 9 metal.
 * Transparent pass (drawLights): canopy glass, prop blur disc, additive glow sprites for the
 * nav lights / strobes / beacon / landing light.
 */
(function (RL) {
  'use strict';
  var M = RL.M, v3 = RL.v3, m4 = RL.m4;
  var DEG = Math.PI / 180;

  // ------------------------------------------------------------------ palette (sRGB)
  var COL = {
    cream: [0.95, 0.91, 0.82], red: [0.84, 0.16, 0.10], orange: [0.98, 0.50, 0.10],
    navy: [0.10, 0.14, 0.30], dark: [0.10, 0.10, 0.11], metal: [0.62, 0.64, 0.67],
    tyre: [0.07, 0.07, 0.075], hub: [0.78, 0.78, 0.8], helmet: [0.96, 0.95, 0.92],
    visor: [0.08, 0.12, 0.2], jacket: [0.42, 0.25, 0.14], panel: [0.13, 0.14, 0.16],
    lensR: [1.0, 0.15, 0.1], lensG: [0.1, 1.0, 0.35], lensW: [1, 1, 1], blade: [0.16, 0.16, 0.17]
  };

  // ------------------------------------------------------------------ geometry constants
  var WING = { rootX: 0.45, tipX: 4.5, rootLE: -0.75, rootTE: 0.85, tipLE: -0.35, tipTE: 0.55,
    rootY: -0.32, dihedral: 4.5 * DEG, rootT: 0.2, tipT: 0.1, hingeU: 0.74 };
  var FLAP = [0.58, 2.33], AIL = [2.47, 4.17];
  var STAB = { y: 0.15, rootLE: 3.15, rootTE: 4.05, tipX: 1.55, tipLE: 3.5, tipTE: 3.95, t: 0.07, hingeZ: 3.75 };
  var FIN = { rootY: 0.12, topY: 1.42, rootLE: 3.0, rootTE: 4.1, topLE: 3.62, topTE: 4.05, t: 0.09, hingeZ: 3.74, rudderY0: 0.3 };
  var PROP_Z = -3.30, PROP_R = 0.88, PROP_SOLID_RPM = 0.45;
  var MAIN_PIVOT = [1.3, -0.42, 0.28], NOSE_PIVOT = [0, -0.45, -2.3];
  var MAIN_WHEEL_R = 0.27, NOSE_WHEEL_R = 0.24;
  var GEAR_H = 1.45;
  var FLAP_MAX = 35 * DEG, AIL_MAX = 20 * DEG, ELEV_MAX = 25 * DEG, RUD_MAX = 25 * DEG;

  // ------------------------------------------------------------------ geometry helpers
  var tmpA = [0, 0, 0], tmpB = [0, 0, 0], tmpN = [0, 0, 0];

  function newGeo() { return RL.Geo.create(); }

  /** Push one flat triangle, wound so its normal points away from `center`. */
  function tri(g, a, b, c, col, mat, center) {
    v3.sub(tmpA, b, a); v3.sub(tmpB, c, a); v3.cross(tmpN, tmpA, tmpB);
    var len = v3.length(tmpN);
    if (len < 1e-9) return;
    tmpN[0] /= len; tmpN[1] /= len; tmpN[2] /= len;
    if (center) {
      var cx = (a[0] + b[0] + c[0]) / 3 - center[0], cy = (a[1] + b[1] + c[1]) / 3 - center[1],
        cz = (a[2] + b[2] + c[2]) / 3 - center[2];
      if (cx * tmpN[0] + cy * tmpN[1] + cz * tmpN[2] < 0) {
        var t = b; b = c; c = t;
        tmpN[0] = -tmpN[0]; tmpN[1] = -tmpN[1]; tmpN[2] = -tmpN[2];
      }
    }
    var pts = [a, b, c];
    for (var i = 0; i < 3; i++) {
      g.positions.push(pts[i][0], pts[i][1], pts[i][2]);
      g.normals.push(tmpN[0], tmpN[1], tmpN[2]);
      g.colors.push(col[0], col[1], col[2]);
      g.uvs.push(mat, 0);
      g.indices.push(g.positions.length / 3 - 1);
    }
  }

  function centroid(list) {
    var c = [0, 0, 0], n = 0;
    for (var i = 0; i < list.length; i++) for (var j = 0; j < list[i].length; j++) {
      c[0] += list[i][j][0]; c[1] += list[i][j][1]; c[2] += list[i][j][2]; n++;
    }
    return [c[0] / n, c[1] / n, c[2] / n];
  }

  /** Loft a closed solid through a list of section loops (same point count), capped at both ends. */
  function loft(g, sections, col, mat) {
    var center = centroid(sections);
    var n = sections[0].length;
    for (var s = 0; s < sections.length - 1; s++) {
      var A = sections[s], B = sections[s + 1];
      for (var i = 0; i < n; i++) {
        var j = (i + 1) % n;
        tri(g, A[i], A[j], B[j], col, mat, center);
        tri(g, A[i], B[j], B[i], col, mat, center);
      }
    }
    capLoop(g, sections[0], col, mat, center);
    capLoop(g, sections[sections.length - 1], col, mat, center);
  }

  function capLoop(g, loop, col, mat, center) {
    var c = centroid([loop]);
    for (var i = 0; i < loop.length; i++) tri(g, c, loop[i], loop[(i + 1) % loop.length], col, mat, center);
  }

  // NACA-style half thickness (max 0.5 at ~30% chord), closed trailing edge.
  function halfT(u) {
    u = M.clamp(u, 0, 1);
    return 5 * (0.2969 * Math.sqrt(u) - 0.126 * u - 0.3516 * u * u + 0.2843 * u * u * u - 0.1036 * u * u * u * u);
  }

  /**
   * Airfoil section loop between chord fractions u0..u1.
   * le/te: 3D chord end points, up: thickness direction (unit), t: max thickness (m),
   * camber: fraction of t used as camber, n: samples per surface.
   */
  function section(le, te, up, t, u0, u1, camber, n) {
    var pts = [], i, u, k;
    function at(u, side) {
      var h = halfT(u) * t, cmb = camber * t * 4 * u * (1 - u) * 0.5;
      var off = side * h + cmb;
      return [le[0] + (te[0] - le[0]) * u + up[0] * off, le[1] + (te[1] - le[1]) * u + up[1] * off,
        le[2] + (te[2] - le[2]) * u + up[2] * off];
    }
    for (i = 0; i <= n; i++) { u = u0 + (u1 - u0) * (i / n); pts.push(at(u, 1)); }
    for (i = n; i >= 0; i--) {
      u = u0 + (u1 - u0) * (i / n);
      if ((i === n && u1 >= 0.999) || (i === 0 && u0 <= 0.001)) continue;   // shared LE / TE point
      k = at(u, -1);
      pts.push(k);
    }
    return pts;
  }

  // wing station at span x (> 0): chord line and thickness
  function wingStation(x) {
    var s = (x - WING.rootX) / (WING.tipX - WING.rootX);
    var y = WING.rootY + (x - WING.rootX) * Math.tan(WING.dihedral);
    return { le: [x, y, M.lerp(WING.rootLE, WING.tipLE, s)], te: [x, y, M.lerp(WING.rootTE, WING.tipTE, s)],
      t: M.lerp(WING.rootT, WING.tipT, s) };
  }
  var WING_UP = [0, 1, 0];

  function wingPart(g, x0, x1, u0, u1, mat, col, sign) {
    var a = wingStation(x0), b = wingStation(x1);
    var n = (u1 - u0) > 0.5 ? 5 : 2;
    var sa = section(a.le, a.te, WING_UP, a.t, u0, u1, 0.35, n);
    var sb = section(b.le, b.te, WING_UP, b.t, u0, u1, 0.35, n);
    var gg = newGeo();
    loft(gg, [sa, sb], col, mat);
    if (sign < 0) RL.Geo.scale(gg, -1, 1, 1);
    append(g, gg);
  }

  function append(dst, src) {
    var base = dst.positions.length / 3;
    Array.prototype.push.apply(dst.positions, src.positions);
    Array.prototype.push.apply(dst.normals, src.normals);
    Array.prototype.push.apply(dst.colors, src.colors);
    Array.prototype.push.apply(dst.uvs, src.uvs);
    for (var i = 0; i < src.indices.length; i++) dst.indices.push(src.indices[i] + base);
    return dst;
  }

  function setMat(g, mat) { for (var i = 0; i < g.uvs.length; i += 2) { g.uvs[i] = mat; g.uvs[i + 1] = 0; } return g; }
  function flat(g, col, mat) { g = RL.Geo.toFlat(g); if (col) RL.Geo.setColor(g, col); return setMat(g, mat || 0); }

  // lathe along -Z: profile [[r, s]] where s = distance forward (model z = -s)
  function latheZ(profile, seg, col, mat, sx, sy) {
    var g = RL.Geo.lathe(profile, seg, col);
    RL.Geo.rotateX(g, -Math.PI / 2);          // +y -> -z
    if (sx || sy) RL.Geo.scale(g, sx || 1, sy || 1, 1);
    return flat(g, col, mat);
  }

  // ------------------------------------------------------------------ part builders
  function buildFuselage() {
    var body = latheZ([[0.001, -4.1], [0.1, -3.95], [0.2, -3.3], [0.31, -2.4], [0.44, -1.4], [0.53, -0.4],
      [0.56, 0.6], [0.55, 1.4], [0.55, 1.9]], 12, COL.cream, 2, 0.9, 1);
    // tail cone sweeps up (top line stays straighter than the belly)
    for (var i = 0; i < body.positions.length; i += 3) {
      var z = body.positions[i + 2];
      body.positions[i + 1] += 0.28 * M.smoothstep(0.3, 4.0, z);
    }
    body = RL.Geo.toFlat(body);
    var cowl = latheZ([[0.55, 1.88], [0.54, 2.35], [0.5, 2.8], [0.44, 3.08], [0.35, 3.26]], 12, COL.red, 3, 0.9, 1);
    var intake = latheZ([[0.35, 3.24], [0.001, 3.25]], 12, COL.dark, 0, 0.9, 1);
    var g = newGeo();
    append(g, body); append(g, cowl); append(g, intake);
    // turtle-deck spine behind the canopy
    var spine = latheZ([[0.001, -3.0], [0.1, -2.2], [0.16, -1.0], [0.2, -0.55]], 6, COL.cream, 2, 1, 1);
    RL.Geo.translate(spine, 0, 0.47, 0);
    for (i = 0; i < spine.positions.length; i += 3) spine.positions[i + 1] += 0.2 * M.smoothstep(0.3, 3.0, spine.positions[i + 2]);
    append(g, spine);
    // exhaust stubs
    for (var s = -1; s <= 1; s += 2) {
      var ex = RL.Geo.cylinder(0.05, 0.06, 0.22, 6, COL.dark);
      RL.Geo.rotateZ(ex, s * 1.1);
      RL.Geo.translate(ex, s * 0.47, -0.25, -2.2);
      append(g, flat(ex, COL.dark, 9));
    }
    // air scoop under the cowl
    var scoop = RL.Geo.box(0.34, 0.12, 0.7, COL.red);
    RL.Geo.translate(scoop, 0, -0.5, -2.55);
    append(g, flat(scoop, COL.red, 3));
    return g;
  }

  function buildWingsFixed() {
    var g = newGeo();
    for (var sgn = -1; sgn <= 1; sgn += 2) {
      wingPart(g, WING.rootX, WING.tipX, 0, WING.hingeU, 1, COL.cream, sgn);        // main box
      wingPart(g, WING.rootX, FLAP[0], WING.hingeU, 1, 1, COL.cream, sgn);          // root fillet TE
      wingPart(g, FLAP[1], AIL[0], WING.hingeU, 1, 1, COL.cream, sgn);              // between
      wingPart(g, AIL[1], WING.tipX, WING.hingeU, 1, 1, COL.cream, sgn);            // tip TE
      // rounded tip cap
      var a = wingStation(WING.tipX);
      var b = { le: [WING.tipX + 0.1, a.le[1] + 0.01, a.le[2] + 0.12], te: [WING.tipX + 0.06, a.te[1] + 0.01, a.te[2] - 0.08], t: a.t * 0.45 };
      var ga = newGeo();
      loft(ga, [section(a.le, a.te, WING_UP, a.t, 0, 1, 0.35, 5), section(b.le, b.te, WING_UP, b.t, 0, 1, 0.35, 5)], COL.cream, 1);
      if (sgn < 0) RL.Geo.scale(ga, -1, 1, 1);
      append(g, ga);
      // nav light lens
      var lens = RL.Geo.box(0.06, 0.06, 0.12, sgn < 0 ? COL.lensR : COL.lensG);
      RL.Geo.translate(lens, sgn * (WING.tipX + 0.09), a.le[1] + 0.02, a.le[2] + 0.2);
      append(g, flat(lens, sgn < 0 ? COL.lensR : COL.lensG, 0));
    }
    // landing light lens in the left leading edge
    var st = wingStation(1.9);
    var ll = RL.Geo.box(0.22, 0.06, 0.04, [0.9, 0.95, 1.0]);
    RL.Geo.translate(ll, -1.9, st.le[1] + 0.02, st.le[2] - 0.005);
    append(g, flat(ll, [0.92, 0.95, 1.0], 0));
    return g;
  }

  function buildTailFixed() {
    var g = newGeo();
    // horizontal stabiliser (fixed part, both sides)
    for (var sgn = -1; sgn <= 1; sgn += 2) {
      var stations = [0.0, STAB.tipX], secs = [];
      for (var i = 0; i < stations.length; i++) {
        var x = stations[i], s = x / STAB.tipX;
        var le = [x, STAB.y, M.lerp(STAB.rootLE, STAB.tipLE, s)], te = [x, STAB.y, M.lerp(STAB.rootTE, STAB.tipTE, s)];
        var uh = (STAB.hingeZ - le[2]) / (te[2] - le[2]);
        secs.push(section(le, te, WING_UP, STAB.t, 0, uh, 0, 4));
      }
      var gs = newGeo();
      loft(gs, secs, COL.cream, 4);
      if (sgn < 0) RL.Geo.scale(gs, -1, 1, 1);
      append(g, gs);
    }
    // vertical fin (fixed part)
    var fsecs = [];
    var ys = [FIN.rootY, FIN.topY];
    for (var k = 0; k < 2; k++) {
      var sy = (ys[k] - FIN.rootY) / (FIN.topY - FIN.rootY);
      var fle = [0, ys[k], M.lerp(FIN.rootLE, FIN.topLE, sy)], fte = [0, ys[k], M.lerp(FIN.rootTE, FIN.topTE, sy)];
      var fu = (FIN.hingeZ - fle[2]) / (fte[2] - fle[2]);
      fsecs.push(section(fle, fte, [1, 0, 0], M.lerp(FIN.t, FIN.t * 0.55, sy), 0, fu, 0, 4));
    }
    var gf = newGeo();
    loft(gf, fsecs, COL.cream, 4);
    append(g, gf);
    // tail light housing + beacon on the fin tip
    var bea = RL.Geo.box(0.05, 0.07, 0.12, COL.lensR);
    RL.Geo.translate(bea, 0, FIN.topY + 0.03, M.lerp(FIN.rootLE, FIN.topLE, 1) + 0.12);
    append(g, flat(bea, COL.lensR, 0));
    return g;
  }

  function buildCanopyFrame() {
    var g = newGeo();
    // windscreen bow and rear hoop: thin tori squashed onto the bubble's cross-section
    var hoops = [-0.92, 0.55];
    for (var i = 0; i < hoops.length; i++) {
      var z = hoops[i], f = Math.sqrt(Math.max(0, 1 - Math.pow((z - CANOPY.z) / CANOPY.rz, 2)));
      var t = RL.Geo.torus(1, 0.028, 4, 18, COL.navy);
      RL.Geo.scale(t, CANOPY.rx * f + 0.01, CANOPY.ry * f + 0.01, 1);
      RL.Geo.translate(t, 0, CANOPY.y, z);
      append(g, flat(t, COL.navy, 0));
    }
    // canopy rails
    for (var s = -1; s <= 1; s += 2) {
      var rail = RL.Geo.box(0.04, 0.04, 2.0, COL.navy);
      RL.Geo.translate(rail, s * (CANOPY.rx - 0.02), CANOPY.y + 0.01, CANOPY.z);
      append(g, flat(rail, COL.navy, 0));
    }
    return g;
  }

  var CANOPY = { y: 0.4, z: -0.05, rx: 0.42, ry: 0.56, rz: 1.05 };
  function buildCanopyGlass() {
    var prof = [[1.0, 0.0], [0.97, 0.25], [0.87, 0.5], [0.66, 0.75], [0.38, 0.93], [0.001, 1.0]];
    var g = RL.Geo.lathe(prof, 20, [0.6, 0.75, 0.9]);
    // lathe is round about Y: squash into an elongated bubble
    RL.Geo.scale(g, CANOPY.rx, CANOPY.ry, CANOPY.rz);
    RL.Geo.translate(g, 0, CANOPY.y, CANOPY.z);
    return setMat(g, 0);
  }

  function buildPilot() {
    var g = newGeo();
    var head = RL.Geo.sphere(0.14, 8, 6, COL.helmet);
    RL.Geo.scale(head, 1, 1.05, 1.1);
    RL.Geo.translate(head, 0, 0.68, 0.16);
    append(g, flat(head, COL.helmet, 0));
    var stripe = RL.Geo.box(0.05, 0.03, 0.3, COL.red);
    RL.Geo.translate(stripe, 0, 0.815, 0.16);
    append(g, flat(stripe, COL.red, 0));
    var visor = RL.Geo.box(0.22, 0.08, 0.06, COL.visor);
    RL.Geo.translate(visor, 0, 0.68, 0.03);
    append(g, flat(visor, COL.visor, 0));
    var body = RL.Geo.box(0.46, 0.3, 0.3, COL.jacket);
    RL.Geo.translate(body, 0, 0.44, 0.22);
    append(g, flat(body, COL.jacket, 0));
    return g;
  }

  function buildPanel() {
    // cockpit-view only: dark tub over the fuselage skin, glare shield, instrument panel
    var g = newGeo();
    var tub = RL.Geo.box(0.7, 0.06, 1.25, [0.16, 0.16, 0.18]);
    RL.Geo.translate(tub, 0, 0.555, 0.08);
    append(g, flat(tub, [0.16, 0.16, 0.18], 0));
    var glare = RL.Geo.box(0.7, 0.05, 0.26, COL.panel);
    RL.Geo.translate(glare, 0, 0.59, -0.66);
    append(g, flat(glare, COL.panel, 0));
    var face = RL.Geo.box(0.68, 0.2, 0.04, COL.panel);
    RL.Geo.translate(face, 0, 0.49, -0.55);
    append(g, flat(face, COL.panel, 0));
    var dials = [[-0.22, 0.53], [-0.075, 0.53], [0.075, 0.53], [0.22, 0.53], [-0.15, 0.43], [0.0, 0.43], [0.15, 0.43]];
    for (var i = 0; i < dials.length; i++) {
      var d = RL.Geo.cylinder(0.052, 0.052, 0.02, 14, COL.panel);
      RL.Geo.rotateX(d, Math.PI / 2);
      RL.Geo.translate(d, dials[i][0], dials[i][1], -0.525);
      // dial centre encoded in the vertex colour (the shader draws the face procedurally)
      append(g, flat(d, [dials[i][0] + 0.5, dials[i][1], i / 8], 8));
    }
    return g;
  }

  function buildControlSurfaces() {
    var parts = {};
    function wingSurface(x0, x1, sgn) {
      var g = newGeo();
      wingPart(g, x0, x1, WING.hingeU, 1, 1, COL.cream, sgn);
      var a = wingStation(x0), b = wingStation(x1);
      var ha = hingePoint(a), hb = hingePoint(b);
      if (sgn < 0) { ha[0] = -ha[0]; hb[0] = -hb[0]; }
      // axis roughly +X on both sides (positive angle = trailing edge down)
      var p0 = sgn > 0 ? ha : hb, p1 = sgn > 0 ? hb : ha;
      var axis = v3.normalize([0, 0, 0], v3.sub([0, 0, 0], p1, p0));
      return { geo: g, pivot: ha, axis: axis };
    }
    function hingePoint(st) {
      var u = WING.hingeU;
      return [st.le[0], st.le[1] + 0.35 * st.t * 4 * u * (1 - u) * 0.5, st.le[2] + (st.te[2] - st.le[2]) * u];
    }
    parts.flapL = wingSurface(FLAP[0], FLAP[1], -1);
    parts.flapR = wingSurface(FLAP[0], FLAP[1], 1);
    parts.ailL = wingSurface(AIL[0], AIL[1], -1);
    parts.ailR = wingSurface(AIL[0], AIL[1], 1);

    // elevator: both halves with a gap for the rudder, hinge along X
    var ge = newGeo();
    for (var sgn = -1; sgn <= 1; sgn += 2) {
      var secs = [], xs = [0.1, STAB.tipX - 0.05];
      for (var i = 0; i < 2; i++) {
        var x = xs[i], s = x / STAB.tipX;
        var le = [x, STAB.y, M.lerp(STAB.rootLE, STAB.tipLE, s)], te = [x, STAB.y, M.lerp(STAB.rootTE, STAB.tipTE, s)];
        var uh = (STAB.hingeZ - le[2]) / (te[2] - le[2]);
        secs.push(section(le, te, WING_UP, STAB.t, uh, 1, 0, 2));
      }
      var gs = newGeo();
      loft(gs, secs, COL.cream, 4);
      if (sgn < 0) RL.Geo.scale(gs, -1, 1, 1);
      append(ge, gs);
    }
    parts.elevator = { geo: ge, pivot: [0, STAB.y, STAB.hingeZ], axis: [1, 0, 0] };

    // rudder, hinge vertical
    var rsecs = [], ys = [FIN.rudderY0, FIN.topY + 0.04];
    for (var k = 0; k < 2; k++) {
      var sy = M.clamp((ys[k] - FIN.rootY) / (FIN.topY - FIN.rootY), 0, 1.05);
      var fle = [0, ys[k], M.lerp(FIN.rootLE, FIN.topLE, sy)], fte = [0, ys[k], M.lerp(FIN.rootTE, FIN.topTE, sy)];
      var fu = (FIN.hingeZ - fle[2]) / (fte[2] - fle[2]);
      rsecs.push(section(fle, fte, [1, 0, 0], M.lerp(FIN.t, FIN.t * 0.55, sy), fu, 1, 0, 2));
    }
    var gr = newGeo();
    loft(gr, rsecs, COL.cream, 4);
    parts.rudder = { geo: gr, pivot: [0, 0, FIN.hingeZ], axis: [0, 1, 0] };
    return parts;
  }

  function buildSpinner() {
    // swirl painted in the shader; spins with the prop
    return latheZ([[0.21, 3.22], [0.2, 3.3], [0.16, 3.42], [0.09, 3.51], [0.001, 3.56]], 12, [1, 1, 1], 5);
  }

  function buildProp(bent) {
    var g = newGeo();
    // two twisted, tapered blades
    for (var b = 0; b < 2; b++) {
      var secs = [], rs = [0.16, 0.45, 0.75, PROP_R];
      for (var i = 0; i < rs.length; i++) {
        var r = rs[i], chord = M.lerp(0.17, 0.09, (r - 0.16) / (PROP_R - 0.16));
        var pitch = M.lerp(38, 14, (r - 0.16) / (PROP_R - 0.16)) * DEG;
        var th = 0.035 * (1 - 0.5 * (r - 0.16));
        var bend = bent ? Math.max(0, r - 0.4) * 0.9 : 0;          // crashed: tips curl back
        // blade along +Y (then rotated per blade); chord in the XZ plane, pitched
        var cx = Math.cos(pitch) * chord / 2, cz = Math.sin(pitch) * chord / 2;
        var y = r, zc = PROP_Z + bend * bend * 0.8, xb = bent ? bend * 0.3 : 0;
        var loop = [[xb - cx, y, zc + cz], [xb, y, zc + th], [xb + cx, y, zc - cz], [xb, y, zc - th]];
        if (bent) loop.forEach(function (p) { p[1] = r - bend * bend * 0.45; });
        secs.push(loop);
      }
      var gb = newGeo();
      loft(gb, secs, COL.blade, 6);
      if (b === 1) RL.Geo.rotateZ(gb, Math.PI);
      append(g, gb);
    }
    return g;
  }

  function buildDisc() {
    var g = newGeo(), n = 40, c = [0, 0, PROP_Z - 0.02];
    for (var i = 0; i < n; i++) {
      var a0 = i / n * Math.PI * 2, a1 = (i + 1) / n * Math.PI * 2;
      var p0 = [Math.cos(a0) * (PROP_R + 0.02), Math.sin(a0) * (PROP_R + 0.02), c[2]];
      var p1 = [Math.cos(a1) * (PROP_R + 0.02), Math.sin(a1) * (PROP_R + 0.02), c[2]];
      tri(g, c, p0, p1, [1, 1, 1], 0, null);
    }
    return g;
  }

  function buildGearLeg(side) {
    // side: -1 left, +1 right, 0 nose. Returns {leg, wheel, pivot, axle, r}
    var leg = newGeo(), wheel = newGeo();
    var isNose = side === 0;
    var px = isNose ? 0 : side * MAIN_PIVOT[0], py = isNose ? NOSE_PIVOT[1] : MAIN_PIVOT[1], pz = isNose ? NOSE_PIVOT[2] : MAIN_PIVOT[2];
    var r = isNose ? NOSE_WHEEL_R : MAIN_WHEEL_R;
    var axleY = -GEAR_H + r;
    var len = py - axleY;
    var strut = RL.Geo.cylinder(0.045, 0.055, len, 6, COL.metal);
    RL.Geo.translate(strut, px + (isNose ? 0 : -side * 0.1), (py + axleY) / 2, pz);
    append(leg, flat(strut, COL.metal, 9));
    // fork / axle stub
    var stub = RL.Geo.box(isNose ? 0.2 : 0.14, 0.07, 0.07, COL.metal);
    RL.Geo.translate(stub, px + (isNose ? 0 : -side * 0.05), axleY, pz);
    append(leg, flat(stub, COL.metal, 9));
    // gear door (colored, rides with the leg)
    var door = RL.Geo.box(0.025, len * 0.55, 0.22, COL.cream);
    RL.Geo.translate(door, px + (isNose ? 0.1 : side * 0.07), py - len * 0.3, pz);
    append(leg, flat(door, COL.cream, 2));
    if (isNose) {
      var door2 = RL.Geo.clone(door);
      RL.Geo.translate(door2, -0.2, 0, 0);
      append(leg, door2);
    }
    // wheel: tyre + hub, axis along X
    var tyre = RL.Geo.cylinder(r, r, isNose ? 0.12 : 0.15, 12, COL.tyre);
    RL.Geo.rotateZ(tyre, Math.PI / 2);
    var wx = px + (isNose ? 0 : side * 0.04);
    RL.Geo.translate(tyre, wx, axleY, pz);
    append(wheel, flat(tyre, COL.tyre, 7));
    var hub = RL.Geo.cylinder(r * 0.45, r * 0.45, isNose ? 0.14 : 0.17, 6, COL.hub);
    RL.Geo.rotateZ(hub, Math.PI / 2);
    RL.Geo.translate(hub, wx, axleY, pz);
    append(wheel, flat(hub, COL.red, 0));
    return { leg: leg, wheel: wheel, pivot: [px, py, pz], axle: [wx, axleY, pz], r: r };
  }

  function buildLightHousings() {
    // small navigation light lens at the tail cone end
    var g = newGeo();
    var t = RL.Geo.box(0.05, 0.05, 0.05, COL.lensW);
    RL.Geo.translate(t, 0, 0.36, 4.1);
    append(g, flat(t, COL.lensW, 0));
    return g;
  }

  // ------------------------------------------------------------------ shaders
  var VS = [
    'layout(location = 0) in vec3 a_position;',
    'layout(location = 1) in vec3 a_normal;',
    'layout(location = 2) in vec4 a_color;',
    'layout(location = 3) in vec2 a_uv;',
    'uniform mat4 u_model;',
    'out vec3 v_world; out vec3 v_normal; out vec3 v_local; out vec3 v_lnormal; out vec3 v_color;',
    'flat out int v_mat;',
    'void main() {',
    '  vec4 w = u_model * vec4(a_position, 1.0);',
    '  v_world = w.xyz;',
    '  v_normal = mat3(u_model) * a_normal;',
    '  v_local = a_position; v_lnormal = a_normal; v_color = a_color.rgb;',
    '  v_mat = int(a_uv.x + 0.5);',
    '  gl_Position = u_viewProj * w;',
    '}'
  ].join('\n');

  var FS = [
    'in vec3 v_world; in vec3 v_normal; in vec3 v_local; in vec3 v_lnormal; in vec3 v_color;',
    'flat in int v_mat;',
    'uniform float u_char;',
    'out vec4 outColor;',
    'const vec3 CREAM = vec3(0.95, 0.91, 0.82);',
    'const vec3 RED = vec3(0.84, 0.16, 0.10);',
    'const vec3 ORANGE = vec3(0.98, 0.50, 0.10);',
    'const vec3 NAVY = vec3(0.10, 0.14, 0.30);',
    // anti-aliased step
    'float aa(float edge, float x) { float w = fwidth(x) * 0.7 + 1e-5; return smoothstep(edge - w, edge + w, x); }',
    'float band(float x, float a, float b) { return aa(a, x) * (1.0 - aa(b, x)); }',
    // 3x5 pixel font: R L - 2 6
    'int glyph(int c) {',
    '  if (c == 0) return 27565; if (c == 1) return 18727; if (c == 2) return 448;',
    '  if (c == 3) return 29671; return 14831;',
    '}',
    // p: text-space (x in pixel columns, y in rows from the top); chars from `first`, `count` long
    'float textMask(vec2 p, int first, int count) {',
    '  if (p.x < 0.0 || p.y < 0.0 || p.y >= 5.0) return 0.0;',
    '  int ci = int(floor(p.x / 4.0));',
    '  if (ci >= count) return 0.0;',
    '  int col = int(floor(mod(p.x, 4.0)));',
    '  if (col > 2) return 0.0;',
    '  int row = int(floor(p.y));',
    '  int bit = 14 - (row * 3 + col);',
    '  return float((glyph(first + ci) >> bit) & 1);',
    '}',
    // sunburst: alternating rays around a focal point, limited to radius r1
    'float rays(vec2 d, float period, float a0, float a1) {',
    '  float a = atan(d.x, -d.y);',
    '  float inside = band(a, a0, a1);',
    '  float s = fract((a - a0) / period);',
    '  return inside * (aa(0.08, s) * (1.0 - aa(0.55, s)));',
    '}',
    'vec3 livery(int m, vec3 P, vec3 N, vec3 base, out float spec, out float emis) {',
    '  spec = 0.35; emis = 0.0;',
    '  vec3 c = base;',
    '  float ax = abs(P.x);',
    '  if (m == 1) {',                                   // wings
    '    c = CREAM;',
    '    if (N.y > 0.0) {',
    '      vec2 d = vec2(ax - 0.5, P.z - 0.95);',
    '      float r = length(d);',
    '      float ray = rays(d, 0.2, 0.1, 1.5) * (1.0 - aa(2.05, r));',
    '      c = mix(c, RED, ray);',
    '      c = mix(c, ORANGE, band(r, 2.05, 2.16) * band(atan(d.x, -d.y), 0.1, 1.5));',
    '      if (P.x > 0.0) c = mix(c, NAVY, textMask(vec2((P.x - 2.35) / 0.088, (P.z + 0.28) / 0.088), 0, 5));',
    '    } else {',
    '      float s = fract((ax * 0.8 + P.z * 0.9) / 1.15);',
    '      c = mix(c, RED, band(s, 0.0, 0.34) * (1.0 - aa(2.2, ax)) * aa(0.6, ax));',
    '      if (P.x < 0.0) c = mix(c, NAVY, textMask(vec2((P.x + 4.0) / 0.088, (P.z + 0.28) / 0.088), 0, 5));',
    '    }',
    '    c = mix(c, ORANGE, band(ax, 3.93, 4.0));',
    '    c = mix(c, RED, aa(4.0, ax));',
    '  } else if (m == 2) {',                            // fuselage
    '    c = CREAM;',
    '    float t = clamp((P.z + 1.9) / 6.0, 0.0, 1.0);',
    '    float yc = -0.06 + 0.3 * t * t;',
    '    float hw = mix(0.13, 0.022, t);',
    '    float side = smoothstep(0.25, 0.45, abs(N.x));',
    '    c = mix(c, RED, band(P.y - yc, -hw, hw) * side);',
    '    c = mix(c, ORANGE, band(P.y - yc, hw + 0.03, hw + 0.065) * side);',
    '    c = mix(c, RED, band(ax, 0.0, 0.07) * step(0.35, P.y) * step(0.9, P.z));',
    '    c = mix(c, NAVY, (1.0 - aa(0.2 + 0.06 * clamp(-P.z - 0.9, 0.0, 1.0), ax)) * step(0.3, P.y) * band(-P.z, 0.85, 1.9));',
    '    c = mix(c, vec3(0.78, 0.8, 0.82), smoothstep(-0.55, -0.8, N.y) * step(P.y, -0.2));',
    '  } else if (m == 3) {',                            // cowling
    '    c = RED;',
    '    c = mix(c, ORANGE, aa(3.05, -P.z));',
    '    c = mix(c, NAVY, band(-P.z, 1.88, 1.98));',
    '    spec = 0.5;',
    '  } else if (m == 4) {',                            // tail surfaces
    '    c = CREAM;',
    '    if (abs(N.x) > 0.5) {',
    '      vec2 d = vec2(P.z - 3.0, -(P.y - 0.15));',
    '      c = mix(c, RED, rays(vec2(d.x, d.y), 0.24, 0.3, 1.45));',
    '      c = mix(c, RED, aa(1.18, P.y));',
    '      c = mix(c, ORANGE, band(P.y, 1.1, 1.16));',
    '      float tz = N.x > 0.0 ? (3.98 - P.z) : (P.z - 3.43);',
    '      c = mix(c, NAVY, textMask(vec2(tz / 0.075, (0.9 - P.y) / 0.075), 3, 2));',
    '    } else {',
    '      c = mix(c, RED, aa(1.2, ax));',
    '      c = mix(c, ORANGE, band(ax, 1.12, 1.18));',
    '      c = mix(c, RED, band(P.z, 3.0, 3.3) * step(0.25, ax));',
    '    }',
    '  } else if (m == 5) {',                            // spinner swirl
    '    float a = atan(P.y, P.x) / 6.2831853;',
    '    float s = fract(a * 2.0 + (-P.z - 3.2) * 2.2);',
    '    c = mix(CREAM, RED, band(s, 0.0, 0.5));',
    '    spec = 0.7;',
    '  } else if (m == 6) {',                            // prop blades
    '    float r = length(P.xy);',
    '    c = mix(base, vec3(1.0, 0.8, 0.1), aa(0.76, r));',
    '    spec = 0.3;',
    '  } else if (m == 7) {',                            // tyres
    '    spec = 0.05;',
    '  } else if (m == 8) {',                            // instrument dials (centre in base.xy)
    '    vec2 d = P.xy - vec2(base.x - 0.5, base.y);',
    '    float r = length(d) / 0.052;',
    '    float ang = atan(d.x, d.y);',
    '    float needleA = (base.z * 8.0 * 1.7 + 0.6) + 0.35 * sin(u_time * (0.3 + base.z));',
    '    float nd = abs(sin(ang - needleA)) * r;',
    '    float needle = (1.0 - aa(0.07, nd)) * step(cos(ang - needleA), 0.0) * (1.0 - aa(0.85, r));',
    '    float ticks = band(r, 0.7, 0.86) * aa(0.8, abs(cos(ang * 6.0)));',
    '    float rim = band(r, 0.9, 1.0);',
    '    c = vec3(0.03, 0.035, 0.04);',
    '    c = mix(c, vec3(0.85, 0.85, 0.8), max(ticks, rim));',
    '    c = mix(c, vec3(1.0, 0.55, 0.15), needle);',
    '    spec = 0.6; emis = max(ticks, needle);',
'  } else if (m == 9) {',                            // metal
    '    spec = 0.8;',
    '  }',
    '  return c;',
    '}',
    'void main() {',
    '  vec3 N = normalize(v_normal);',
    '  if (!gl_FrontFacing) N = -N;',
    '  float spec, emis;',
    '  vec3 alb = livery(v_mat, v_local, normalize(v_lnormal), v_color, spec, emis);',
    '  // soot when crashed',
    '  float soot = u_char * (0.55 + 0.45 * vnoise(v_local.xz * 3.0 + v_local.y * 2.0));',
    '  alb = mix(alb, vec3(0.05, 0.045, 0.04), clamp(soot, 0.0, 0.92));',
    '  spec *= 1.0 - u_char * 0.8;',
    '  vec3 lin = toLinear(alb);',
    '  float sh = shadowFactor(v_world, N);',
    '  sh = mix(1.0, sh, 0.85);',
    '  vec3 col = shadeLit(lin, N, v_world, sh, spec, 48.0);',
    '  // gentle sky-reflection rim so the paint reads glossy against the sky',
    '  vec3 V = normalize(u_camPos - v_world);',
    '  float fr = pow(1.0 - max(dot(N, V), 0.0), 4.0);',
    '  col += skyColor(reflect(-V, N)) * fr * spec * 0.35 * (1.0 - u_char);',
    '  // instrument markings glow softly at night',
    '  col += vec3(0.5, 1.0, 0.7) * emis * 0.25 * u_nightFactor;',
    '  col = applyFog(col, v_world);',
    '  outColor = vec4(finalColor(col), 1.0);',
    '}'
  ].join('\n');

  var GLASS_VS = [
    'layout(location = 0) in vec3 a_position;',
    'layout(location = 1) in vec3 a_normal;',
    'uniform mat4 u_model;',
    'out vec3 v_world; out vec3 v_normal; out vec3 v_local;',
    'void main() {',
    '  vec4 w = u_model * vec4(a_position, 1.0);',
    '  v_world = w.xyz; v_normal = mat3(u_model) * a_normal; v_local = a_position;',
    '  gl_Position = u_viewProj * w;',
    '}'
  ].join('\n');

  var GLASS_FS = [
    'in vec3 v_world; in vec3 v_normal; in vec3 v_local;',
    'uniform float u_char;',
    'out vec4 outColor;',
    'void main() {',
    '  vec3 N = normalize(v_normal);',
    '  vec3 V = normalize(u_camPos - v_world);',
    '  float ndv = max(dot(N, V), 0.0);',
    '  float fr = 0.06 + 0.94 * pow(1.0 - ndv, 4.0);',
    '  vec3 R = reflect(-V, N);',
    '  vec3 refl = skyColor(R) * 1.1;',
    '  // horizon line of the reflected world: ground below the horizon is darker',
    '  refl = mix(refl, u_ambientGround * 1.5 + u_fogColor * 0.3, smoothstep(0.02, -0.08, R.y));',
    '  vec3 H = normalize(u_sunDir + V);',
    '  float sp = pow(max(dot(N, H), 0.0), 220.0) * 4.0;',
    '  vec3 tint = toLinear(vec3(0.16, 0.24, 0.32)) * (hemiAmbient(N) + u_sunColor * 0.15);',
    '  vec3 col = mix(tint, refl, fr) + u_sunColor * sp * (1.0 - u_char);',
    '  col = mix(col, vec3(0.02), u_char * 0.8);',
    '  float alpha = clamp(0.28 + fr * 0.7 + sp * 0.3 + u_char * 0.6, 0.0, 0.96);',
    '  col = applyFog(col, v_world);',
    '  outColor = vec4(finalColor(col), alpha);',
    '}'
  ].join('\n');

  var DISC_FS = [
    'in vec3 v_world; in vec3 v_normal; in vec3 v_local;',
    'uniform float u_rpm; uniform float u_ghost; uniform float u_char;',
    'out vec4 outColor;',
    'void main() {',
    '  vec2 q = v_local.xy;',
    '  float r = length(q) / ' + PROP_R.toFixed(3) + ';',
    '  if (r > 1.02 || r < 0.2) discard;',
    '  float a = atan(q.y, q.x) + u_ghost;',
    '  float ghost = pow(abs(cos(a)), 16.0);',                        // two faint ghost blades
    '  float den = 0.18 + 0.25 * ghost;',
    '  den *= smoothstep(0.2, 0.3, r) * (1.0 - smoothstep(0.96, 1.02, r));',
    '  vec3 base = mix(vec3(0.22), vec3(1.0, 0.8, 0.15), smoothstep(0.84, 0.9, r));',
    '  float tipRing = smoothstep(0.84, 0.9, r) * (1.0 - smoothstep(0.97, 1.0, r));',
    '  den += tipRing * 0.25;',
    '  float alpha = den * u_rpm;',
    '  vec3 N = normalize(v_normal);',
    '  vec3 col = toLinear(base) * (hemiAmbient(N) + u_sunColor * 0.35);',
    '  col = applyFog(col, v_world);',
    '  outColor = vec4(finalColor(col), clamp(alpha, 0.0, 0.7));',
    '}'
  ].join('\n');

  var GLOW_VS = [
    'layout(location = 0) in vec3 a_position;',             // corner (-1..1, -1..1, 0)
    'layout(location = 4) in vec4 i_posSize;',
    'layout(location = 5) in vec4 i_color;',
    'out vec2 v_q; out vec4 v_col; out float v_fade;',
    'void main() {',
    '  vec3 camRight = vec3(u_view[0][0], u_view[1][0], u_view[2][0]);',
    '  vec3 camUp = vec3(u_view[0][1], u_view[1][1], u_view[2][1]);',
    '  vec3 toCam = u_camPos - i_posSize.xyz;',
    '  float dist = length(toCam);',
    '  // keep a minimum on-screen size so distant lights stay visible points',
    '  float pix = 2.0 * dist * tan(0.5 * 1.1) / u_resolution.y;',
    '  float size = max(i_posSize.w, pix * 3.5);',
    '  vec3 c = i_posSize.xyz + toCam / max(dist, 1e-3) * min(0.35, dist * 0.3);',
    '  vec3 w = c + (camRight * a_position.x + camUp * a_position.y) * size;',
    '  v_q = a_position.xy;',
    '  v_col = i_color;',
    '  v_fade = exp(-dist * u_fogDensity * 1.2);',
    '  gl_Position = u_viewProj * vec4(w, 1.0);',
    '}'
  ].join('\n');

  var GLOW_FS = [
    'in vec2 v_q; in vec4 v_col; in float v_fade;',
    'out vec4 outColor;',
    'void main() {',
    '  float r2 = dot(v_q, v_q);',
    '  if (r2 > 1.0) discard;',
    '  float core = exp(-r2 * 18.0);',
    '  float halo = exp(-r2 * 4.0) * 0.35;',
    '  vec3 c = v_col.rgb * v_col.a * (core * 2.0 + halo) * v_fade;',
    '  c += vec3(1.0) * v_col.a * exp(-r2 * 60.0) * v_fade;',        // white-hot centre
    '  vec3 outc = acesTonemap(c * u_exposure);',
    '  outColor = vec4(pow(outc, vec3(1.0 / 2.2)), 1.0);',
    '}'
  ].join('\n');

  // ------------------------------------------------------------------ module state
  var gl = null, ready = false;
  var progSolid, progGlass, progDisc, progGlow;
  var meshes = {}, parts = {}, gearParts = {};
  var planeM = m4.create();
  var mats = {};
  var casters = [];
  var propAngle = 0, wheelSpin = [0, 0, 0], lastTime = -1;
  var glowData = new Float32Array(8 * 12), glowMesh = null;
  var landing = { pos: v3.create(), dir: v3.create(), intensity: 0 };
  var UNIFORM_MODEL = 'u_model';
  var NO_SURFACES = { aileron: 0, elevator: 0, rudder: 0 };
  var GEAR_NAMES = ['nose', 'left', 'right'], GEAR_LEG = ['noseLeg', 'leftLeg', 'rightLeg'],
    GEAR_WHEEL = ['noseWheel', 'leftWheel', 'rightWheel'];
  var tmpM = m4.create(), tmpR = m4.create(), tmpV = v3.create();

  var Aircraft = {
    /** Model-space pilot eye point (inside the canopy, just above the glare shield). */
    cockpitOffset: v3.create(0, 0.88, 0.12)
  };

  function mk(name, geo) {
    meshes[name] = RL.GL.meshFromGeo(gl, geo);
    mats[name] = m4.create();
    return meshes[name];
  }

  Aircraft.init = function (glCtx) {
    gl = glCtx;
    var SL = RL.ShaderLib;
    progSolid = RL.GL.createProgram(gl, SL.vertex(VS), SL.fragment(FS), 'aircraft');
    progGlass = RL.GL.createProgram(gl, SL.vertex(GLASS_VS), SL.fragment(GLASS_FS), 'aircraft-glass');
    progDisc = RL.GL.createProgram(gl, SL.vertex(GLASS_VS), SL.fragment(DISC_FS), 'aircraft-disc');
    progGlow = RL.GL.createProgram(gl, SL.vertex(GLOW_VS), SL.fragment(GLOW_FS), 'aircraft-glow');

    var body = newGeo();
    append(body, buildFuselage());
    append(body, buildWingsFixed());
    append(body, buildTailFixed());
    append(body, buildCanopyFrame());
    append(body, buildLightHousings());
    mk('body', body);
    mk('pilot', buildPilot());
    mk('panel', buildPanel());
    mk('canopy', buildCanopyGlass());
    mk('spinner', buildSpinner());
    mk('prop', buildProp(false));
    mk('propBent', buildProp(true));
    mk('disc', buildDisc());
    var cs = buildControlSurfaces();
    ['flapL', 'flapR', 'ailL', 'ailR', 'elevator', 'rudder'].forEach(function (k) {
      mk(k, cs[k].geo);
      parts[k] = { pivot: cs[k].pivot, axis: cs[k].axis };
    });
    var legs = { nose: buildGearLeg(0), left: buildGearLeg(-1), right: buildGearLeg(1) };
    for (var k in legs) {
      mk(k + 'Leg', legs[k].leg);
      mk(k + 'Wheel', legs[k].wheel);
      gearParts[k] = legs[k];
    }
    // glow sprites: one quad, instanced
    glowMesh = RL.GL.createMesh(gl, {
      positions: [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], indices: [0, 1, 2, 0, 2, 3],
      instances: { data: glowData, stride: 8, usage: gl.DYNAMIC_DRAW,
        attribs: [{ loc: 4, size: 4, offset: 0 }, { loc: 5, size: 4, offset: 4 }], count: 0 }
    });
    // shadow caster list (fixed objects, matrices updated in place)
    ['body', 'flapL', 'flapR', 'ailL', 'ailR', 'elevator', 'rudder', 'canopy', 'spinner', 'prop',
      'noseLeg', 'noseWheel', 'leftLeg', 'leftWheel', 'rightLeg', 'rightWheel'].forEach(function (k) {
      casters.push({ mesh: meshes[k], model: mats[k], name: k, gear: /Leg|Wheel/.test(k) });
    });
    ready = true;
  };

  // ------------------------------------------------------------------ pose
  /** out = planeM * T(p) * R(axis, angle) * T(-p) */
  function hinge(out, pivot, axis, angle) {
    var x = axis[0], y = axis[1], z = axis[2];
    var c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
    var r = out;
    r[0] = t * x * x + c; r[1] = t * x * y + s * z; r[2] = t * x * z - s * y; r[3] = 0;
    r[4] = t * x * y - s * z; r[5] = t * y * y + c; r[6] = t * y * z + s * x; r[7] = 0;
    r[8] = t * x * z + s * y; r[9] = t * y * z - s * x; r[10] = t * z * z + c; r[11] = 0;
    var px = pivot[0], py = pivot[1], pz = pivot[2];
    r[12] = px - (r[0] * px + r[4] * py + r[8] * pz);
    r[13] = py - (r[1] * px + r[5] * py + r[9] * pz);
    r[14] = pz - (r[2] * px + r[6] * py + r[10] * pz);
    r[15] = 1;
    return r;
  }

  var AX_X = [1, 0, 0], AX_Y = [0, 1, 0], AX_Z = [0, 0, 1], PROP_HUB = [0, 0, PROP_Z];

  function updatePose(plane, dtGame) {
    m4.fromRotationTranslation(planeM, plane.quat, plane.pos);
    m4.copy(mats.body, planeM);
    m4.copy(mats.pilot, planeM);
    m4.copy(mats.panel, planeM);
    m4.copy(mats.canopy, planeM);
    m4.copy(mats.disc, planeM);
    var sf = plane.surfaces || NO_SURFACES;
    var fl = (plane.flaps || 0) * FLAP_MAX;
    m4.multiply(mats.flapL, planeM, hinge(tmpM, parts.flapL.pivot, parts.flapL.axis, fl));
    m4.multiply(mats.flapR, planeM, hinge(tmpM, parts.flapR.pivot, parts.flapR.axis, fl));
    m4.multiply(mats.ailL, planeM, hinge(tmpM, parts.ailL.pivot, parts.ailL.axis, sf.aileron * AIL_MAX));
    m4.multiply(mats.ailR, planeM, hinge(tmpM, parts.ailR.pivot, parts.ailR.axis, -sf.aileron * AIL_MAX));
    m4.multiply(mats.elevator, planeM, hinge(tmpM, parts.elevator.pivot, AX_X, -sf.elevator * ELEV_MAX));
    m4.multiply(mats.rudder, planeM, hinge(tmpM, parts.rudder.pivot, AX_Y, sf.rudder * RUD_MAX));

    // propeller
    if (dtGame > 0 && !plane.crashed) propAngle = (propAngle + plane.rpm * 60 * dtGame) % (Math.PI * 2);
    m4.multiply(mats.prop, planeM, hinge(tmpM, PROP_HUB, AX_Z, -propAngle));
    m4.copy(mats.propBent, mats.prop);
    m4.copy(mats.spinner, mats.prop);

    // gear: retract inward (mains) / aft (nose), compress with the suspension, wheels spin
    var g = M.saturate(plane.gear === undefined ? 1 : plane.gear);
    var retract = 1 - M.smoothstep(0, 1, g);
    var comp = plane.gearCompression || ZERO3;
    for (var i = 0; i < 3; i++) {
      var gp = gearParts[GEAR_NAMES[i]];
      var legM = mats[GEAR_LEG[i]], wheelM = mats[GEAR_WHEEL[i]];
      var ang = i === 0 ? -retract * 95 * DEG : (i === 1 ? 1 : -1) * retract * 88 * DEG;
      hinge(legM, gp.pivot, i === 0 ? AX_X : AX_Z, ang);
      m4.copy(tmpM, legM);
      // suspension (before the retraction rotation): shift the leg up by the compression
      var c = g > 0.95 ? Math.min(comp[i] || 0, 0.3) : 0;
      if (plane.crashed) c = 0;
      compV[1] = c;
      m4.translate(tmpM, tmpM, compV);
      if (i === 0) {
        // nose-wheel steering about the strut
        var st = (plane.steer || 0) * g;
        m4.multiply(tmpM, tmpM, hinge(tmpR, gp.pivot, AX_Y, -st));
      }
      m4.multiply(legM, planeM, tmpM);
      // wheel spin
      if (dtGame > 0) {
        var on = plane.wheelContact ? plane.wheelContact[i] : plane.onGround;
        var spd = plane.groundSpeed || 0;
        wheelSpin[i] -= (on ? spd : spd * 0.97) * dtGame / gp.r;
        wheelSpin[i] %= Math.PI * 2;
      }
      m4.multiply(tmpM, tmpM, hinge(tmpR, gp.axle, AX_X, wheelSpin[i]));
      m4.multiply(wheelM, planeM, tmpM);
    }
  }
  var compV = [0, 0, 0], ZERO3 = [0, 0, 0];

  function gameDt(frame) {
    var t = frame && typeof frame.time === 'number' ? frame.time : 0;
    var d = lastTime < 0 ? 0 : t - lastTime;
    lastTime = t;
    return d > 0 && d < 0.25 ? d : 0;
  }

  // ------------------------------------------------------------------ draw
  function drawPart(name) {
    RL.GL.setUniform(gl, progSolid, UNIFORM_MODEL, mats[name]);
    RL.GL.drawMesh(gl, meshes[name]);
  }

  Aircraft.draw = function (frame, plane, opts) {
    if (!ready || !plane || !plane.quat || (opts && opts.hidden)) return;
    opts = opts || {};
    var dt = gameDt(frame);
    updatePose(plane, dt);
    var crashed = !!(opts.crashed || plane.crashed);
    var G = RL.GL;
    G.use(gl, progSolid, null);
    G.applyFrame(gl, progSolid, frame);
    G.setUniform(gl, progSolid, 'u_char', crashed ? 1 : 0);
    drawPart('body');
    drawPart('flapL'); drawPart('flapR'); drawPart('ailL'); drawPart('ailR');
    drawPart('elevator'); drawPart('rudder');
    if (!opts.cockpit) drawPart('pilot');
    else drawPart('panel');
    // solid blades while they can be seen turning; above that only the blur disc (drawn in the
    // transparent pass) represents them
    drawPart('spinner');
    if (crashed) drawPart('propBent');
    else if (plane.rpm < PROP_SOLID_RPM) drawPart('prop');
    var g = plane.gear === undefined ? 1 : plane.gear;
    if (g > 0.01) {
      drawPart('noseLeg'); drawPart('noseWheel');
      drawPart('leftLeg'); drawPart('leftWheel');
      drawPart('rightLeg'); drawPart('rightWheel');
    }
  };

  Aircraft.drawLights = function (frame, plane, opts) {
    if (!ready || !plane || !plane.quat || (opts && opts.hidden)) return;
    opts = opts || {};
    var G = RL.GL;
    var crashed = !!(opts.crashed || plane.crashed);
    m4.fromRotationTranslation(planeM, plane.quat, plane.pos);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);

    // canopy glass (from inside it is back-facing and culled: the cockpit view stays clear)
    G.use(gl, progGlass, null);
    G.applyFrame(gl, progGlass, frame);
    G.setUniform(gl, progGlass, 'u_model', planeM);
    G.setUniform(gl, progGlass, 'u_char', crashed ? 1 : 0);
    G.drawMesh(gl, meshes.canopy);

    // propeller blur disc
    var rpmVis = crashed ? 0 : M.smoothstep(0.3, PROP_SOLID_RPM + 0.05, plane.rpm);
    if (rpmVis > 0.01) {
      gl.disable(gl.CULL_FACE);
      G.use(gl, progDisc, null);
      G.applyFrame(gl, progDisc, frame);
      G.setUniform(gl, progDisc, 'u_model', planeM);
      G.setUniform(gl, progDisc, 'u_rpm', rpmVis * (opts.cockpit ? 0.55 : 1));
      G.setUniform(gl, progDisc, 'u_ghost', (frame.time || 0) * (1.3 - plane.rpm) * 2.0);
      G.drawMesh(gl, meshes.disc);
      gl.enable(gl.CULL_FACE);
    }

    // additive glow sprites
    var n = fillGlow(frame, plane, crashed, opts);
    if (n > 0) {
      gl.blendFunc(gl.ONE, gl.ONE);
      G.use(gl, progGlow, null);
      G.applyFrame(gl, progGlow, frame);
      G.updateInstances(gl, glowMesh, glowData, n);
      G.drawMesh(gl, glowMesh, n);
    }
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  };

  var LIGHTS = {
    left: [-(WING.tipX + 0.1), 0.03, 0.0], right: [WING.tipX + 0.1, 0.03, 0.0],
    strobeL: [-(WING.tipX + 0.08), 0.04, 0.3], strobeR: [WING.tipX + 0.08, 0.04, 0.3],
    tail: [0, 0.37, 4.14], beaconTop: [0, FIN.topY + 0.08, FIN.topLE + 0.12], beaconBelly: [0, -0.58, 0.4],
    landing: [-1.9, -0.24, -0.66]
  };

  function pushGlow(i, local, size, r, g, b, inten) {
    v3.transformQuat(tmpV, local, planeQuat);
    var o = i * 8;
    glowData[o] = tmpV[0] + planePos[0]; glowData[o + 1] = tmpV[1] + planePos[1]; glowData[o + 2] = tmpV[2] + planePos[2];
    glowData[o + 3] = size;
    glowData[o + 4] = r; glowData[o + 5] = g; glowData[o + 6] = b; glowData[o + 7] = inten;
    return i + 1;
  }
  var planeQuat = null, planePos = null;

  function fillGlow(frame, plane, crashed, opts) {
    if (crashed) return 0;
    planeQuat = plane.quat; planePos = plane.pos;
    var night = M.saturate(frame.nightFactor || 0);
    var dayDim = M.lerp(0.18, 1.0, night);
    var t = frame.time || 0;
    var i = 0;
    i = pushGlow(i, LIGHTS.left, 0.35 + 0.35 * night, 1.0, 0.12, 0.08, 1.4 * dayDim);
    i = pushGlow(i, LIGHTS.right, 0.35 + 0.35 * night, 0.1, 1.0, 0.3, 1.4 * dayDim);
    i = pushGlow(i, LIGHTS.tail, 0.3 + 0.3 * night, 1.0, 0.95, 0.85, 1.1 * dayDim);
    // strobes: double flash every 1.3 s
    var ph = t % 1.3;
    var flash = (ph < 0.05 || (ph > 0.14 && ph < 0.19)) ? 1 : 0;
    if (flash) {
      i = pushGlow(i, LIGHTS.strobeL, 1.1 + 1.3 * night, 1, 1, 1, 3.0 * M.lerp(0.5, 1, night));
      i = pushGlow(i, LIGHTS.strobeR, 1.1 + 1.3 * night, 1, 1, 1, 3.0 * M.lerp(0.5, 1, night));
    }
    // red anti-collision beacons, alternating top / belly at ~1 Hz
    var bp = (t * 1.1) % 1;
    var bI = Math.max(0, Math.sin(bp * Math.PI * 2)) * 2.2;
    var bJ = Math.max(0, -Math.sin(bp * Math.PI * 2)) * 2.2;
    if (bI > 0.05) i = pushGlow(i, LIGHTS.beaconTop, 0.5 + 0.6 * night, 1.0, 0.1, 0.05, bI * dayDim);
    if (bJ > 0.05) i = pushGlow(i, LIGHTS.beaconBelly, 0.5 + 0.6 * night, 1.0, 0.1, 0.05, bJ * dayDim);
    // landing light lens glow
    var L = Aircraft.getLandingLight(plane, night);
    if (L.intensity > 0.01 && !opts.cockpit) i = pushGlow(i, LIGHTS.landing, 0.9, 1.0, 0.95, 0.85, 2.0 * M.saturate(L.intensity / 6));
    return i;
  }

  // ------------------------------------------------------------------ shadows / light
  Aircraft.getShadowCasters = function (plane) {
    if (!ready || !plane || !plane.quat) return [];
    updatePose(plane, 0);
    // retracted gear lives inside the wing: skip it; hide solid blades when they're a blur
    var g = plane.gear === undefined ? 1 : plane.gear;
    var out = castersOut;
    out.length = 0;
    for (var i = 0; i < casters.length; i++) {
      var c = casters[i];
      if (g < 0.02 && c.gear) continue;
      if (c.name === 'prop' && plane.rpm >= PROP_SOLID_RPM && !plane.crashed) continue;
      out.push(c);
    }
    return out;
  };
  var castersOut = [];

  var LL_DIR = v3.normalize(v3.create(), [0, -Math.sin(6 * DEG), -Math.cos(6 * DEG)]);
  Aircraft.getLandingLight = function (plane, nightFactor) {
    landing.intensity = 0;
    if (!plane || !plane.quat || plane.crashed) return landing;
    v3.transformQuat(landing.pos, LIGHTS.landing, plane.quat);
    v3.add(landing.pos, landing.pos, plane.pos);
    v3.transformQuat(landing.dir, LL_DIR, plane.quat);
    var gearOn = plane.gearDown ? 1 : 0;
    var low = 1 - M.smoothstep(120, 300, plane.agl || 0);
    landing.intensity = 7.0 * M.saturate(nightFactor || 0) * Math.max(gearOn, low);
    return landing;
  };

  RL.Aircraft = Aircraft;
})(window.RL = window.RL || {});
