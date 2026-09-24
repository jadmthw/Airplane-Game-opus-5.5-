/*
 * Ridgeline — CPU geometry builders (RL.Geo).
 *
 * A geometry is { positions: [], normals: [], colors: [], uvs: [], indices: [] } using plain JS
 * arrays (xyz / xyz / rgb (sRGB 0..1) / uv / triangle indices). Front faces are CCW when seen
 * from outside. Upload with RL.GL.meshFromGeo(gl, geo).
 *
 * All builders are centered on the origin unless stated otherwise. Colors are [r, g, b] sRGB.
 */
(function (RL) {
  'use strict';

  var v3 = RL.v3, m4 = RL.m4;

  function create() { return { positions: [], normals: [], colors: [], uvs: [], indices: [] }; }
  function col(c) { return c || [0.8, 0.8, 0.8]; }

  function pushV(g, x, y, z, nx, ny, nz, c, u, v) {
    g.positions.push(x, y, z);
    g.normals.push(nx, ny, nz);
    g.colors.push(c[0], c[1], c[2]);
    g.uvs.push(u || 0, v || 0);
    return g.positions.length / 3 - 1;
  }

  var Geo = { create: create };

  /** Axis-aligned box of size sx*sy*sz with flat faces. */
  Geo.box = function (sx, sy, sz, color) {
    var g = create(), c = col(color);
    var h = [sx / 2, sy / 2, sz / 2];
    var faces = [
      [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
      [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
      [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
      [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
      [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
      [[0, 0, -1], [-1, 0, 0], [0, 1, 0]]
    ];
    var corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (var f = 0; f < 6; f++) {
      var n = faces[f][0], u = faces[f][1], v = faces[f][2];
      var base = g.positions.length / 3;
      for (var k = 0; k < 4; k++) {
        var a = corners[k][0], b = corners[k][1];
        var p = [0, 0, 0];
        for (var i = 0; i < 3; i++) p[i] = n[i] * h[i] + u[i] * h[i] * a + v[i] * h[i] * b;
        pushV(g, p[0], p[1], p[2], n[0], n[1], n[2], c, (a + 1) / 2, (b + 1) / 2);
      }
      g.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    return g;
  };

  /**
   * Cylinder / truncated cone along Y from -height/2 to +height/2.
   * opts: { caps: true, capTop: true, capBottom: true, thetaStart: 0, thetaLength: 2PI }
   */
  Geo.cylinder = function (rTop, rBottom, height, segments, color, opts) {
    opts = opts || {};
    var g = create(), c = col(color);
    var seg = Math.max(3, segments | 0);
    var hh = height / 2;
    var t0 = opts.thetaStart || 0, tl = opts.thetaLength || Math.PI * 2;
    var slope = (rBottom - rTop);
    for (var i = 0; i <= seg; i++) {
      var th = t0 + (i / seg) * tl;
      var s = Math.sin(th), co = Math.cos(th);
      var n = v3.normalize([0, 0, 0], [s * height, slope, co * height]);
      pushV(g, rBottom * s, -hh, rBottom * co, n[0], n[1], n[2], c, i / seg, 0);
      pushV(g, rTop * s, hh, rTop * co, n[0], n[1], n[2], c, i / seg, 1);
    }
    for (i = 0; i < seg; i++) {
      var b0 = i * 2, t0i = i * 2 + 1, b1 = i * 2 + 2, t1 = i * 2 + 3;
      g.indices.push(b0, b1, t1, b0, t1, t0i);
    }
    var caps = opts.caps !== false;
    if (caps && opts.capTop !== false && rTop > 0) {
      var ct = pushV(g, 0, hh, 0, 0, 1, 0, c, 0.5, 0.5);
      var startT = g.positions.length / 3;
      for (i = 0; i <= seg; i++) {
        th = t0 + (i / seg) * tl;
        pushV(g, rTop * Math.sin(th), hh, rTop * Math.cos(th), 0, 1, 0, c, 0, 0);
      }
      for (i = 0; i < seg; i++) g.indices.push(ct, startT + i, startT + i + 1);
    }
    if (caps && opts.capBottom !== false && rBottom > 0) {
      var cb = pushV(g, 0, -hh, 0, 0, -1, 0, c, 0.5, 0.5);
      var startB = g.positions.length / 3;
      for (i = 0; i <= seg; i++) {
        th = t0 + (i / seg) * tl;
        pushV(g, rBottom * Math.sin(th), -hh, rBottom * Math.cos(th), 0, -1, 0, c, 0, 0);
      }
      for (i = 0; i < seg; i++) g.indices.push(cb, startB + i + 1, startB + i);
    }
    return g;
  };

  /** Cone along Y, apex at +height/2. */
  Geo.cone = function (radius, height, segments, color, opts) {
    return Geo.cylinder(0, radius, height, segments, color, opts);
  };

  /** UV sphere. */
  Geo.sphere = function (radius, wSeg, hSeg, color) {
    var g = create(), c = col(color);
    wSeg = Math.max(3, wSeg | 0); hSeg = Math.max(2, hSeg | 0);
    for (var iy = 0; iy <= hSeg; iy++) {
      var phi = (iy / hSeg) * Math.PI;
      for (var ix = 0; ix <= wSeg; ix++) {
        var th = (ix / wSeg) * Math.PI * 2;
        var x = Math.sin(phi) * Math.sin(th), y = Math.cos(phi), z = Math.sin(phi) * Math.cos(th);
        pushV(g, x * radius, y * radius, z * radius, x, y, z, c, ix / wSeg, iy / hSeg);
      }
    }
    var row = wSeg + 1;
    for (iy = 0; iy < hSeg; iy++) {
      for (ix = 0; ix < wSeg; ix++) {
        var t0 = iy * row + ix, t1 = iy * row + ix + 1, b0 = (iy + 1) * row + ix, b1 = (iy + 1) * row + ix + 1;
        if (iy !== hSeg - 1) g.indices.push(b0, b1, t1); // skip degenerate at the bottom pole
        if (iy !== 0) g.indices.push(b0, t1, t0);         // skip degenerate at the top pole
      }
    }
    return g;
  };

  /** Torus in the XY plane (hole axis = Z). R = ring radius, r = tube radius. */
  Geo.torus = function (R, r, radialSegments, tubularSegments, color) {
    var g = create(), c = col(color);
    var ts = Math.max(3, tubularSegments | 0), rs = Math.max(3, radialSegments | 0);
    for (var j = 0; j <= ts; j++) {
      var u = (j / ts) * Math.PI * 2;
      for (var i = 0; i <= rs; i++) {
        var v = (i / rs) * Math.PI * 2;
        var cx = Math.cos(u), sx = Math.sin(u), cv = Math.cos(v), sv = Math.sin(v);
        pushV(g, (R + r * cv) * cx, (R + r * cv) * sx, r * sv, cv * cx, cv * sx, sv, c, j / ts, i / rs);
      }
    }
    var row = rs + 1;
    for (j = 0; j < ts; j++) {
      for (i = 0; i < rs; i++) {
        var a = j * row + i, b = (j + 1) * row + i, cc = (j + 1) * row + i + 1, d = j * row + i + 1;
        g.indices.push(a, b, cc, a, cc, d);
      }
    }
    return g;
  };

  /**
   * Surface of revolution around Y. profile: [[radius, y], ...] ordered bottom -> top.
   * opts: { thetaStart, thetaLength }
   */
  Geo.lathe = function (profile, segments, color, opts) {
    opts = opts || {};
    var g = create(), c = col(color);
    var seg = Math.max(3, segments | 0), np = profile.length;
    var t0 = opts.thetaStart || 0, tl = opts.thetaLength || Math.PI * 2;
    // per-profile-point 2D normals (average of adjacent segment normals)
    var n2 = [];
    for (var k = 0; k < np; k++) {
      var nx = 0, ny = 0;
      if (k > 0) {
        var dr = profile[k][0] - profile[k - 1][0], dy = profile[k][1] - profile[k - 1][1];
        var l = Math.hypot(dr, dy) || 1; nx += dy / l; ny += -dr / l;
      }
      if (k < np - 1) {
        dr = profile[k + 1][0] - profile[k][0]; dy = profile[k + 1][1] - profile[k][1];
        l = Math.hypot(dr, dy) || 1; nx += dy / l; ny += -dr / l;
      }
      var ln = Math.hypot(nx, ny) || 1;
      n2.push([nx / ln, ny / ln]);
    }
    for (var i = 0; i <= seg; i++) {
      var th = t0 + (i / seg) * tl, s = Math.sin(th), co = Math.cos(th);
      for (k = 0; k < np; k++) {
        var r = profile[k][0], y = profile[k][1];
        pushV(g, r * s, y, r * co, n2[k][0] * s, n2[k][1], n2[k][0] * co, c, i / seg, k / (np - 1));
      }
    }
    for (i = 0; i < seg; i++) {
      for (k = 0; k < np - 1; k++) {
        var b0 = i * np + k, t0i = i * np + k + 1, b1 = (i + 1) * np + k, t1 = (i + 1) * np + k + 1;
        g.indices.push(b0, b1, t1, b0, t1, t0i);
      }
    }
    return g;
  };

  // Ear-clipping triangulation of a simple CCW polygon [[x,y],...]; returns index triples.
  function triangulate(poly) {
    var n = poly.length, idx = [], res = [];
    for (var i = 0; i < n; i++) idx.push(i);
    function area2(a, b, c) { return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); }
    function inside(p, a, b, c) {
      return area2(a, b, p) >= 0 && area2(b, c, p) >= 0 && area2(c, a, p) >= 0;
    }
    var guard = 0;
    while (idx.length > 3 && guard++ < 10000) {
      var clipped = false;
      for (i = 0; i < idx.length; i++) {
        var i0 = idx[(i + idx.length - 1) % idx.length], i1 = idx[i], i2 = idx[(i + 1) % idx.length];
        var a = poly[i0], b = poly[i1], c = poly[i2];
        if (area2(a, b, c) <= 0) continue; // reflex
        var ok = true;
        for (var j = 0; j < idx.length; j++) {
          var q = idx[j];
          if (q === i0 || q === i1 || q === i2) continue;
          if (inside(poly[q], a, b, c)) { ok = false; break; }
        }
        if (!ok) continue;
        res.push(i0, i1, i2);
        idx.splice(i, 1);
        clipped = true;
        break;
      }
      if (!clipped) break; // degenerate; bail out
    }
    if (idx.length === 3) res.push(idx[0], idx[1], idx[2]);
    return res;
  }
  Geo.triangulate = triangulate;

  /** Extrude a simple CCW 2D polygon (in XY) along Z from -depth/2 to +depth/2, flat shaded. */
  Geo.extrude = function (shape, depth, color) {
    var g = create(), c = col(color), n = shape.length, hd = depth / 2;
    var tris = triangulate(shape);
    var base = g.positions.length / 3;
    for (var i = 0; i < n; i++) pushV(g, shape[i][0], shape[i][1], hd, 0, 0, 1, c, 0, 0);
    for (i = 0; i < tris.length; i += 3) g.indices.push(base + tris[i], base + tris[i + 1], base + tris[i + 2]);
    base = g.positions.length / 3;
    for (i = 0; i < n; i++) pushV(g, shape[i][0], shape[i][1], -hd, 0, 0, -1, c, 0, 0);
    for (i = 0; i < tris.length; i += 3) g.indices.push(base + tris[i], base + tris[i + 2], base + tris[i + 1]);
    for (i = 0; i < n; i++) {
      var p0 = shape[i], p1 = shape[(i + 1) % n];
      var dx = p1[0] - p0[0], dy = p1[1] - p0[1], l = Math.hypot(dx, dy) || 1;
      var nx = dy / l, ny = -dx / l;
      var A = pushV(g, p0[0], p0[1], -hd, nx, ny, 0, c, 0, 0);
      var B = pushV(g, p1[0], p1[1], -hd, nx, ny, 0, c, 1, 0);
      var C = pushV(g, p1[0], p1[1], hd, nx, ny, 0, c, 1, 1);
      var D = pushV(g, p0[0], p0[1], hd, nx, ny, 0, c, 0, 1);
      g.indices.push(A, B, C, A, C, D);
    }
    return g;
  };

  /** Flat XZ grid facing +Y, size w (x) by d (z). */
  Geo.plane = function (w, d, color, segW, segD) {
    var g = create(), c = col(color);
    segW = Math.max(1, segW | 0); segD = Math.max(1, segD | 0);
    for (var iz = 0; iz <= segD; iz++) {
      for (var ix = 0; ix <= segW; ix++) {
        pushV(g, -w / 2 + (ix / segW) * w, 0, -d / 2 + (iz / segD) * d, 0, 1, 0, c, ix / segW, iz / segD);
      }
    }
    var row = segW + 1;
    for (iz = 0; iz < segD; iz++) {
      for (ix = 0; ix < segW; ix++) {
        var a = iz * row + ix, b = (iz + 1) * row + ix, cc = (iz + 1) * row + ix + 1, dd = iz * row + ix + 1;
        g.indices.push(a, b, cc, a, cc, dd);
      }
    }
    return g;
  };

  /** Single quad from 4 points given CCW as seen from the front; normal computed. */
  Geo.quad = function (p0, p1, p2, p3, color) {
    var g = create(), c = col(color);
    var e1 = v3.sub([0, 0, 0], p1, p0), e2 = v3.sub([0, 0, 0], p2, p0);
    var n = v3.normalize([0, 0, 0], v3.cross([0, 0, 0], e1, e2));
    pushV(g, p0[0], p0[1], p0[2], n[0], n[1], n[2], c, 0, 0);
    pushV(g, p1[0], p1[1], p1[2], n[0], n[1], n[2], c, 1, 0);
    pushV(g, p2[0], p2[1], p2[2], n[0], n[1], n[2], c, 1, 1);
    pushV(g, p3[0], p3[1], p3[2], n[0], n[1], n[2], c, 0, 1);
    g.indices.push(0, 1, 2, 0, 2, 3);
    return g;
  };

  // --------------------------------------------------------------- transforms

  /** Apply a mat4 in place (normals use the inverse-transpose; winding flipped for mirrors). */
  Geo.transform = function (g, m) {
    var nm = m4.normalMatrix(new Float32Array(9), m);
    var p = [0, 0, 0], n = [0, 0, 0];
    for (var i = 0; i < g.positions.length; i += 3) {
      p[0] = g.positions[i]; p[1] = g.positions[i + 1]; p[2] = g.positions[i + 2];
      v3.transformMat4(p, p, m);
      g.positions[i] = p[0]; g.positions[i + 1] = p[1]; g.positions[i + 2] = p[2];
      if (g.normals.length && nm) {
        var x = g.normals[i], y = g.normals[i + 1], z = g.normals[i + 2];
        n[0] = nm[0] * x + nm[3] * y + nm[6] * z;
        n[1] = nm[1] * x + nm[4] * y + nm[7] * z;
        n[2] = nm[2] * x + nm[5] * y + nm[8] * z;
        v3.normalize(n, n);
        g.normals[i] = n[0]; g.normals[i + 1] = n[1]; g.normals[i + 2] = n[2];
      }
    }
    // determinant of upper 3x3
    var det = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
    if (det < 0) {
      for (i = 0; i < g.indices.length; i += 3) {
        var t = g.indices[i + 1]; g.indices[i + 1] = g.indices[i + 2]; g.indices[i + 2] = t;
      }
    }
    return g;
  };

  Geo.translate = function (g, x, y, z) { return Geo.transform(g, m4.fromTranslation(m4.create(), [x, y, z])); };
  Geo.scale = function (g, x, y, z) { return Geo.transform(g, m4.fromScaling(m4.create(), [x, y, z])); };
  /** Rotate by quaternion. */
  Geo.rotate = function (g, q) { return Geo.transform(g, m4.fromQuat(m4.create(), q)); };
  Geo.rotateX = function (g, rad) { return Geo.transform(g, m4.rotateX(m4.create(), m4.create(), rad)); };
  Geo.rotateY = function (g, rad) { return Geo.transform(g, m4.rotateY(m4.create(), m4.create(), rad)); };
  Geo.rotateZ = function (g, rad) { return Geo.transform(g, m4.rotateZ(m4.create(), m4.create(), rad)); };

  /** Deep copy. */
  Geo.clone = function (g) {
    return {
      positions: g.positions.slice(), normals: g.normals.slice(), colors: g.colors.slice(),
      uvs: (g.uvs || []).slice(), indices: g.indices.slice()
    };
  };

  /** Set every vertex color. */
  Geo.setColor = function (g, color) {
    for (var i = 0; i < g.colors.length; i += 3) { g.colors[i] = color[0]; g.colors[i + 1] = color[1]; g.colors[i + 2] = color[2]; }
    return g;
  };

  /** Recolor via fn(position[3], normal[3], vertexIndex) -> [r,g,b]. */
  Geo.colorBy = function (g, fn) {
    for (var i = 0; i < g.positions.length / 3; i++) {
      var p = [g.positions[i * 3], g.positions[i * 3 + 1], g.positions[i * 3 + 2]];
      var n = [g.normals[i * 3], g.normals[i * 3 + 1], g.normals[i * 3 + 2]];
      var c = fn(p, n, i);
      g.colors[i * 3] = c[0]; g.colors[i * 3 + 1] = c[1]; g.colors[i * 3 + 2] = c[2];
    }
    return g;
  };

  /** Concatenate geometries into a new one. */
  Geo.merge = function (list) {
    var out = create();
    for (var k = 0; k < list.length; k++) {
      var g = list[k];
      if (!g) continue;
      var base = out.positions.length / 3;
      var nv = g.positions.length / 3;
      Array.prototype.push.apply(out.positions, g.positions);
      if (g.normals.length) Array.prototype.push.apply(out.normals, g.normals);
      else for (var i = 0; i < nv; i++) out.normals.push(0, 1, 0);
      if (g.colors.length) Array.prototype.push.apply(out.colors, g.colors);
      else for (i = 0; i < nv; i++) out.colors.push(0.8, 0.8, 0.8);
      if (g.uvs && g.uvs.length) Array.prototype.push.apply(out.uvs, g.uvs);
      else for (i = 0; i < nv; i++) out.uvs.push(0, 0);
      if (g.indices.length) for (i = 0; i < g.indices.length; i++) out.indices.push(g.indices[i] + base);
      else for (i = 0; i < nv; i++) out.indices.push(base + i);
    }
    return out;
  };

  /** Recompute smooth vertex normals from triangles (area weighted). */
  Geo.computeNormals = function (g) {
    var P = g.positions, I = g.indices, N = new Array(P.length).fill(0);
    var a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0], e1 = [0, 0, 0], e2 = [0, 0, 0], n = [0, 0, 0];
    for (var t = 0; t < I.length; t += 3) {
      var ia = I[t] * 3, ib = I[t + 1] * 3, ic = I[t + 2] * 3;
      a[0] = P[ia]; a[1] = P[ia + 1]; a[2] = P[ia + 2];
      b[0] = P[ib]; b[1] = P[ib + 1]; b[2] = P[ib + 2];
      c[0] = P[ic]; c[1] = P[ic + 1]; c[2] = P[ic + 2];
      v3.sub(e1, b, a); v3.sub(e2, c, a); v3.cross(n, e1, e2);
      for (var k = 0; k < 3; k++) { N[ia + k] += n[k]; N[ib + k] += n[k]; N[ic + k] += n[k]; }
    }
    for (var i = 0; i < N.length; i += 3) {
      var l = Math.hypot(N[i], N[i + 1], N[i + 2]) || 1;
      N[i] /= l; N[i + 1] /= l; N[i + 2] /= l;
    }
    g.normals = N;
    return g;
  };

  /** Convert to non-indexed flat shading (each triangle gets its face normal). Low-poly look. */
  Geo.toFlat = function (g) {
    var out = create(), P = g.positions, C = g.colors, U = g.uvs || [];
    var I = g.indices.length ? g.indices : null;
    var nt = I ? I.length : P.length / 3;
    var a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0], e1 = [0, 0, 0], e2 = [0, 0, 0], n = [0, 0, 0];
    for (var t = 0; t < nt; t += 3) {
      var ids = I ? [I[t], I[t + 1], I[t + 2]] : [t, t + 1, t + 2];
      a[0] = P[ids[0] * 3]; a[1] = P[ids[0] * 3 + 1]; a[2] = P[ids[0] * 3 + 2];
      b[0] = P[ids[1] * 3]; b[1] = P[ids[1] * 3 + 1]; b[2] = P[ids[1] * 3 + 2];
      c[0] = P[ids[2] * 3]; c[1] = P[ids[2] * 3 + 1]; c[2] = P[ids[2] * 3 + 2];
      v3.sub(e1, b, a); v3.sub(e2, c, a); v3.cross(n, e1, e2); v3.normalize(n, n);
      for (var k = 0; k < 3; k++) {
        var id = ids[k];
        out.positions.push(P[id * 3], P[id * 3 + 1], P[id * 3 + 2]);
        out.normals.push(n[0], n[1], n[2]);
        if (C.length) out.colors.push(C[id * 3], C[id * 3 + 1], C[id * 3 + 2]);
        else out.colors.push(0.8, 0.8, 0.8);
        out.uvs.push(U[id * 2] || 0, U[id * 2 + 1] || 0);
        out.indices.push(out.positions.length / 3 - 1);
      }
    }
    return out;
  };

  /** Axis-aligned bounds {min:[..], max:[..]}. */
  Geo.bounds = function (g) {
    var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < g.positions.length; i += 3) {
      for (var k = 0; k < 3; k++) {
        var v = g.positions[i + k];
        if (v < mn[k]) mn[k] = v;
        if (v > mx[k]) mx[k] = v;
      }
    }
    return { min: mn, max: mx };
  };

  RL.Geo = Geo;
})(window.RL = window.RL || {});
