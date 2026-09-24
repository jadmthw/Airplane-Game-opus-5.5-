/*
 * Ridgeline — core math.
 * Small gl-matrix style library. Vectors are plain arrays or Float32Arrays of
 * length 3, quaternions [x, y, z, w], matrices are column-major Float32Array(16).
 * Every function that produces a vector/quat/matrix writes into `out` and returns it.
 *
 * World conventions: right-handed, Y up, meters. North = -Z, East = +X.
 * Aircraft/model space: nose points -Z, right wing +X, up +Y.
 */
(function (RL) {
  'use strict';

  var EPS = 1e-6;

  // ---------------------------------------------------------------- scalars
  var M = {
    EPS: EPS,
    DEG: Math.PI / 180,
    RAD: 180 / Math.PI,
    clamp: function (x, a, b) { return x < a ? a : x > b ? b : x; },
    saturate: function (x) { return x < 0 ? 0 : x > 1 ? 1 : x; },
    lerp: function (a, b, t) { return a + (b - a) * t; },
    invLerp: function (a, b, x) { return (x - a) / (b - a); },
    smoothstep: function (a, b, x) {
      var t = (x - a) / (b - a);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      return t * t * (3 - 2 * t);
    },
    // Frame-rate independent exponential approach of `a` towards `b`.
    damp: function (a, b, lambda, dt) { return a + (b - a) * (1 - Math.exp(-lambda * dt)); },
    // Move `a` towards `b` by at most `maxDelta`.
    approach: function (a, b, maxDelta) {
      if (a < b) return Math.min(a + maxDelta, b);
      return Math.max(a - maxDelta, b);
    },
    // Wrap angle (radians) into (-PI, PI].
    wrapPi: function (a) {
      a = (a + Math.PI) % (2 * Math.PI);
      if (a < 0) a += 2 * Math.PI;
      return a - Math.PI;
    },
    // Wrap degrees into [0, 360).
    wrap360: function (d) { d = d % 360; return d < 0 ? d + 360 : d; },
    // Seeded PRNG (mulberry32). Returns a function producing floats in [0, 1).
    rng: function (seed) {
      var s = seed >>> 0;
      return function () {
        s = (s + 0x6D2B79F5) >>> 0;
        var t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    },
    // Integer hash -> [0,1)
    hash2: function (x, y, seed) {
      var h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695041)) | 0;
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      h ^= h >>> 16;
      return (h >>> 0) / 4294967296;
    }
  };

  // ---------------------------------------------------------------- vec3
  var v3 = {
    create: function (x, y, z) {
      var o = new Float32Array(3);
      if (x !== undefined) { o[0] = x; o[1] = y; o[2] = z; }
      return o;
    },
    fromValues: function (x, y, z) { return v3.create(x, y, z); },
    clone: function (a) { return v3.create(a[0], a[1], a[2]); },
    set: function (out, x, y, z) { out[0] = x; out[1] = y; out[2] = z; return out; },
    copy: function (out, a) { out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; return out; },
    add: function (out, a, b) { out[0] = a[0] + b[0]; out[1] = a[1] + b[1]; out[2] = a[2] + b[2]; return out; },
    sub: function (out, a, b) { out[0] = a[0] - b[0]; out[1] = a[1] - b[1]; out[2] = a[2] - b[2]; return out; },
    mul: function (out, a, b) { out[0] = a[0] * b[0]; out[1] = a[1] * b[1]; out[2] = a[2] * b[2]; return out; },
    scale: function (out, a, s) { out[0] = a[0] * s; out[1] = a[1] * s; out[2] = a[2] * s; return out; },
    // out = a + b * s
    scaleAndAdd: function (out, a, b, s) {
      out[0] = a[0] + b[0] * s; out[1] = a[1] + b[1] * s; out[2] = a[2] + b[2] * s; return out;
    },
    negate: function (out, a) { out[0] = -a[0]; out[1] = -a[1]; out[2] = -a[2]; return out; },
    dot: function (a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; },
    cross: function (out, a, b) {
      var ax = a[0], ay = a[1], az = a[2], bx = b[0], by = b[1], bz = b[2];
      out[0] = ay * bz - az * by;
      out[1] = az * bx - ax * bz;
      out[2] = ax * by - ay * bx;
      return out;
    },
    length: function (a) { return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]); },
    lengthSq: function (a) { return a[0] * a[0] + a[1] * a[1] + a[2] * a[2]; },
    dist: function (a, b) {
      var x = a[0] - b[0], y = a[1] - b[1], z = a[2] - b[2];
      return Math.sqrt(x * x + y * y + z * z);
    },
    distSq: function (a, b) {
      var x = a[0] - b[0], y = a[1] - b[1], z = a[2] - b[2];
      return x * x + y * y + z * z;
    },
    normalize: function (out, a) {
      var x = a[0], y = a[1], z = a[2];
      var l = x * x + y * y + z * z;
      if (l > 0) { l = 1 / Math.sqrt(l); }
      out[0] = x * l; out[1] = y * l; out[2] = z * l;
      return out;
    },
    lerp: function (out, a, b, t) {
      out[0] = a[0] + (b[0] - a[0]) * t;
      out[1] = a[1] + (b[1] - a[1]) * t;
      out[2] = a[2] + (b[2] - a[2]) * t;
      return out;
    },
    // Frame-rate independent exponential approach.
    damp: function (out, a, b, lambda, dt) {
      return v3.lerp(out, a, b, 1 - Math.exp(-lambda * dt));
    },
    // Rotate vector a by unit quaternion q.
    transformQuat: function (out, a, q) {
      var qx = q[0], qy = q[1], qz = q[2], qw = q[3];
      var x = a[0], y = a[1], z = a[2];
      // t = 2 * cross(q.xyz, v)
      var tx = 2 * (qy * z - qz * y);
      var ty = 2 * (qz * x - qx * z);
      var tz = 2 * (qx * y - qy * x);
      // v + w*t + cross(q.xyz, t)
      out[0] = x + qw * tx + (qy * tz - qz * ty);
      out[1] = y + qw * ty + (qz * tx - qx * tz);
      out[2] = z + qw * tz + (qx * ty - qy * tx);
      return out;
    },
    // Transform point by column-major mat4 (w = 1, no perspective divide).
    transformMat4: function (out, a, m) {
      var x = a[0], y = a[1], z = a[2];
      var w = m[3] * x + m[7] * y + m[11] * z + m[15];
      w = w || 1.0;
      out[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
      out[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
      out[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
      return out;
    },
    // Transform direction by mat4 (ignores translation).
    transformDirMat4: function (out, a, m) {
      var x = a[0], y = a[1], z = a[2];
      out[0] = m[0] * x + m[4] * y + m[8] * z;
      out[1] = m[1] * x + m[5] * y + m[9] * z;
      out[2] = m[2] * x + m[6] * y + m[10] * z;
      return out;
    }
  };

  // ---------------------------------------------------------------- quat
  var quat = {
    create: function () { var q = new Float32Array(4); q[3] = 1; return q; },
    clone: function (a) { var q = new Float32Array(4); q[0] = a[0]; q[1] = a[1]; q[2] = a[2]; q[3] = a[3]; return q; },
    copy: function (out, a) { out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; out[3] = a[3]; return out; },
    identity: function (out) { out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1; return out; },
    set: function (out, x, y, z, w) { out[0] = x; out[1] = y; out[2] = z; out[3] = w; return out; },
    setAxisAngle: function (out, axis, rad) {
      var s = Math.sin(rad * 0.5);
      out[0] = s * axis[0]; out[1] = s * axis[1]; out[2] = s * axis[2]; out[3] = Math.cos(rad * 0.5);
      return out;
    },
    // out = a * b  (apply b first, then a)
    multiply: function (out, a, b) {
      var ax = a[0], ay = a[1], az = a[2], aw = a[3];
      var bx = b[0], by = b[1], bz = b[2], bw = b[3];
      out[0] = ax * bw + aw * bx + ay * bz - az * by;
      out[1] = ay * bw + aw * by + az * bx - ax * bz;
      out[2] = az * bw + aw * bz + ax * by - ay * bx;
      out[3] = aw * bw - ax * bx - ay * by - az * bz;
      return out;
    },
    // Local-axis rotations (post-multiply): rotate about the object's own axes.
    rotateX: function (out, a, rad) {
      rad *= 0.5;
      var ax = a[0], ay = a[1], az = a[2], aw = a[3];
      var bx = Math.sin(rad), bw = Math.cos(rad);
      out[0] = ax * bw + aw * bx;
      out[1] = ay * bw + az * bx;
      out[2] = az * bw - ay * bx;
      out[3] = aw * bw - ax * bx;
      return out;
    },
    rotateY: function (out, a, rad) {
      rad *= 0.5;
      var ax = a[0], ay = a[1], az = a[2], aw = a[3];
      var by = Math.sin(rad), bw = Math.cos(rad);
      out[0] = ax * bw - az * by;
      out[1] = ay * bw + aw * by;
      out[2] = az * bw + ax * by;
      out[3] = aw * bw - ay * by;
      return out;
    },
    rotateZ: function (out, a, rad) {
      rad *= 0.5;
      var ax = a[0], ay = a[1], az = a[2], aw = a[3];
      var bz = Math.sin(rad), bw = Math.cos(rad);
      out[0] = ax * bw + ay * bz;
      out[1] = ay * bw - ax * bz;
      out[2] = az * bw + aw * bz;
      out[3] = aw * bw - az * bz;
      return out;
    },
    conjugate: function (out, a) { out[0] = -a[0]; out[1] = -a[1]; out[2] = -a[2]; out[3] = a[3]; return out; },
    normalize: function (out, a) {
      var l = a[0] * a[0] + a[1] * a[1] + a[2] * a[2] + a[3] * a[3];
      l = l > 0 ? 1 / Math.sqrt(l) : 0;
      out[0] = a[0] * l; out[1] = a[1] * l; out[2] = a[2] * l; out[3] = a[3] * l;
      return out;
    },
    dot: function (a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]; },
    slerp: function (out, a, b, t) {
      var ax = a[0], ay = a[1], az = a[2], aw = a[3];
      var bx = b[0], by = b[1], bz = b[2], bw = b[3];
      var cosom = ax * bx + ay * by + az * bz + aw * bw;
      if (cosom < 0) { cosom = -cosom; bx = -bx; by = -by; bz = -bz; bw = -bw; }
      var s0, s1;
      if (1 - cosom > EPS) {
        var omega = Math.acos(cosom), sinom = Math.sin(omega);
        s0 = Math.sin((1 - t) * omega) / sinom;
        s1 = Math.sin(t * omega) / sinom;
      } else { s0 = 1 - t; s1 = t; }
      out[0] = s0 * ax + s1 * bx; out[1] = s0 * ay + s1 * by;
      out[2] = s0 * az + s1 * bz; out[3] = s0 * aw + s1 * bw;
      return quat.normalize(out, out);
    },
    // Integrate a body-frame angular velocity (rad/s, [pitchRate(x), yawRate(y), rollRate(z)])
    // over dt: q = q * exp(omega*dt/2). Result is normalized.
    integrateLocal: function (out, q, omegaLocal, dt) {
      var wx = omegaLocal[0], wy = omegaLocal[1], wz = omegaLocal[2];
      var ang = Math.sqrt(wx * wx + wy * wy + wz * wz) * dt;
      if (ang < 1e-9) return quat.copy(out, q);
      var s = Math.sin(ang * 0.5) / (ang / dt);
      var dq = [wx * s, wy * s, wz * s, Math.cos(ang * 0.5)];
      quat.multiply(out, q, dq);
      return quat.normalize(out, out);
    },
    // Rotation that maps model axes so that model -Z points along `forward` and +Y is as close to `up` as possible.
    fromForwardUp: function (out, forward, up) {
      var f = v3.normalize([0, 0, 0], forward);
      var z = [-f[0], -f[1], -f[2]];          // model +Z = -forward
      var x = v3.cross([0, 0, 0], up, z);
      if (v3.lengthSq(x) < 1e-10) x = v3.cross(x, [1, 0, 0], z);
      v3.normalize(x, x);
      var y = v3.cross([0, 0, 0], z, x);
      return quat.fromMat3Axes(out, x, y, z);
    },
    // Build from orthonormal basis columns x, y, z.
    fromMat3Axes: function (out, x, y, z) {
      var m00 = x[0], m01 = y[0], m02 = z[0];
      var m10 = x[1], m11 = y[1], m12 = z[1];
      var m20 = x[2], m21 = y[2], m22 = z[2];
      var tr = m00 + m11 + m22, s;
      if (tr > 0) {
        s = Math.sqrt(tr + 1.0) * 2;
        out[3] = 0.25 * s; out[0] = (m21 - m12) / s; out[1] = (m02 - m20) / s; out[2] = (m10 - m01) / s;
      } else if (m00 > m11 && m00 > m22) {
        s = Math.sqrt(1.0 + m00 - m11 - m22) * 2;
        out[3] = (m21 - m12) / s; out[0] = 0.25 * s; out[1] = (m01 + m10) / s; out[2] = (m02 + m20) / s;
      } else if (m11 > m22) {
        s = Math.sqrt(1.0 + m11 - m00 - m22) * 2;
        out[3] = (m02 - m20) / s; out[0] = (m01 + m10) / s; out[1] = 0.25 * s; out[2] = (m12 + m21) / s;
      } else {
        s = Math.sqrt(1.0 + m22 - m00 - m11) * 2;
        out[3] = (m10 - m01) / s; out[0] = (m02 + m20) / s; out[1] = (m12 + m21) / s; out[2] = 0.25 * s;
      }
      return quat.normalize(out, out);
    },
    // Aviation Euler angles -> quaternion. heading: radians clockwise from north (-Z);
    // pitch: radians nose-up positive; roll: radians right-wing-down positive.
    fromHeadingPitchRoll: function (out, heading, pitch, roll) {
      quat.identity(out);
      quat.rotateY(out, out, -heading);  // yaw about world up (clockwise from above = negative)
      quat.rotateX(out, out, pitch);     // nose up about right wing (+X)
      quat.rotateZ(out, out, -roll);     // right wing down about nose axis
      return out;
    },
    // Inverse of fromHeadingPitchRoll. Returns {heading, pitch, roll} in radians
    // (heading in [0, 2PI)).
    toHeadingPitchRoll: function (q, outObj) {
      var o = outObj || {};
      var f = v3.transformQuat([0, 0, 0], [0, 0, -1], q);
      var r = v3.transformQuat([0, 0, 0], [1, 0, 0], q);
      var u = v3.transformQuat([0, 0, 0], [0, 1, 0], q);
      o.pitch = Math.asin(M.clamp(f[1], -1, 1));
      var h = Math.atan2(f[0], -f[2]);
      o.heading = h < 0 ? h + 2 * Math.PI : h;
      // roll: angle of right wing below the horizon, sign-corrected when inverted
      o.roll = Math.atan2(-r[1], u[1]);
      return o;
    }
  };

  // ---------------------------------------------------------------- mat4
  var m4 = {
    create: function () { var m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; },
    clone: function (a) { return new Float32Array(a); },
    copy: function (out, a) { for (var i = 0; i < 16; i++) out[i] = a[i]; return out; },
    identity: function (out) {
      for (var i = 0; i < 16; i++) out[i] = 0;
      out[0] = out[5] = out[10] = out[15] = 1;
      return out;
    },
    multiply: function (out, a, b) {
      var a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
      var a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
      var a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
      var a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
      for (var i = 0; i < 4; i++) {
        var b0 = b[i * 4], b1 = b[i * 4 + 1], b2 = b[i * 4 + 2], b3 = b[i * 4 + 3];
        out[i * 4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
        out[i * 4 + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
        out[i * 4 + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
        out[i * 4 + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
      }
      return out;
    },
    invert: function (out, a) {
      var a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
      var a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
      var a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
      var a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
      var b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10;
      var b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
      var b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
      var b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
      var b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31;
      var b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
      var det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
      if (!det) return null;
      det = 1.0 / det;
      out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
      out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
      out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
      out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
      out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
      out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
      out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
      out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
      out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
      out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
      out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
      out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
      out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
      out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
      out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
      out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
      return out;
    },
    transpose: function (out, a) {
      if (out === a) {
        var a01 = a[1], a02 = a[2], a03 = a[3], a12 = a[6], a13 = a[7], a23 = a[11];
        out[1] = a[4]; out[2] = a[8]; out[3] = a[12];
        out[4] = a01; out[6] = a[9]; out[7] = a[13];
        out[8] = a02; out[9] = a12; out[11] = a[14];
        out[12] = a03; out[13] = a13; out[14] = a23;
      } else {
        out[0] = a[0]; out[1] = a[4]; out[2] = a[8]; out[3] = a[12];
        out[4] = a[1]; out[5] = a[5]; out[6] = a[9]; out[7] = a[13];
        out[8] = a[2]; out[9] = a[6]; out[10] = a[10]; out[11] = a[14];
        out[12] = a[3]; out[13] = a[7]; out[14] = a[11]; out[15] = a[15];
      }
      return out;
    },
    perspective: function (out, fovy, aspect, near, far) {
      var f = 1.0 / Math.tan(fovy / 2);
      m4.identity(out);
      out[0] = f / aspect;
      out[5] = f;
      out[11] = -1;
      out[15] = 0;
      var nf = 1 / (near - far);
      out[10] = (far + near) * nf;
      out[14] = 2 * far * near * nf;
      return out;
    },
    ortho: function (out, left, right, bottom, top, near, far) {
      var lr = 1 / (left - right), bt = 1 / (bottom - top), nf = 1 / (near - far);
      m4.identity(out);
      out[0] = -2 * lr; out[5] = -2 * bt; out[10] = 2 * nf;
      out[12] = (left + right) * lr; out[13] = (top + bottom) * bt; out[14] = (far + near) * nf;
      return out;
    },
    // View matrix looking from eye to center.
    lookAt: function (out, eye, center, up) {
      var z0 = eye[0] - center[0], z1 = eye[1] - center[1], z2 = eye[2] - center[2];
      var len = Math.hypot(z0, z1, z2);
      if (len < EPS) return m4.identity(out);
      z0 /= len; z1 /= len; z2 /= len;
      var x0 = up[1] * z2 - up[2] * z1, x1 = up[2] * z0 - up[0] * z2, x2 = up[0] * z1 - up[1] * z0;
      len = Math.hypot(x0, x1, x2);
      if (len < EPS) {
        // up parallel to view direction: pick another up
        var alt = Math.abs(z1) > 0.9 ? [0, 0, 1] : [0, 1, 0];
        x0 = alt[1] * z2 - alt[2] * z1; x1 = alt[2] * z0 - alt[0] * z2; x2 = alt[0] * z1 - alt[1] * z0;
        len = Math.hypot(x0, x1, x2);
      }
      x0 /= len; x1 /= len; x2 /= len;
      var y0 = z1 * x2 - z2 * x1, y1 = z2 * x0 - z0 * x2, y2 = z0 * x1 - z1 * x0;
      out[0] = x0; out[1] = y0; out[2] = z0; out[3] = 0;
      out[4] = x1; out[5] = y1; out[6] = z1; out[7] = 0;
      out[8] = x2; out[9] = y2; out[10] = z2; out[11] = 0;
      out[12] = -(x0 * eye[0] + x1 * eye[1] + x2 * eye[2]);
      out[13] = -(y0 * eye[0] + y1 * eye[1] + y2 * eye[2]);
      out[14] = -(z0 * eye[0] + z1 * eye[1] + z2 * eye[2]);
      out[15] = 1;
      return out;
    },
    fromTranslation: function (out, v) {
      m4.identity(out); out[12] = v[0]; out[13] = v[1]; out[14] = v[2]; return out;
    },
    fromScaling: function (out, v) {
      m4.identity(out); out[0] = v[0]; out[5] = v[1]; out[10] = v[2]; return out;
    },
    fromQuat: function (out, q) {
      return m4.fromRotationTranslation(out, q, [0, 0, 0]);
    },
    fromRotationTranslation: function (out, q, v) {
      var x = q[0], y = q[1], z = q[2], w = q[3];
      var x2 = x + x, y2 = y + y, z2 = z + z;
      var xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
      var wx = w * x2, wy = w * y2, wz = w * z2;
      out[0] = 1 - (yy + zz); out[1] = xy + wz; out[2] = xz - wy; out[3] = 0;
      out[4] = xy - wz; out[5] = 1 - (xx + zz); out[6] = yz + wx; out[7] = 0;
      out[8] = xz + wy; out[9] = yz - wx; out[10] = 1 - (xx + yy); out[11] = 0;
      out[12] = v[0]; out[13] = v[1]; out[14] = v[2]; out[15] = 1;
      return out;
    },
    fromRotationTranslationScale: function (out, q, v, s) {
      m4.fromRotationTranslation(out, q, v);
      var sx = s[0], sy = s[1], sz = s[2];
      out[0] *= sx; out[1] *= sx; out[2] *= sx;
      out[4] *= sy; out[5] *= sy; out[6] *= sy;
      out[8] *= sz; out[9] *= sz; out[10] *= sz;
      return out;
    },
    // out = a * translation(v)
    translate: function (out, a, v) {
      var x = v[0], y = v[1], z = v[2];
      if (out !== a) m4.copy(out, a);
      out[12] = a[0] * x + a[4] * y + a[8] * z + a[12];
      out[13] = a[1] * x + a[5] * y + a[9] * z + a[13];
      out[14] = a[2] * x + a[6] * y + a[10] * z + a[14];
      out[15] = a[3] * x + a[7] * y + a[11] * z + a[15];
      return out;
    },
    // out = a * scale(v)
    scale: function (out, a, v) {
      var x = v[0], y = v[1], z = v[2];
      for (var i = 0; i < 4; i++) {
        out[i] = a[i] * x; out[4 + i] = a[4 + i] * y; out[8 + i] = a[8 + i] * z; out[12 + i] = a[12 + i];
      }
      return out;
    },
    // out = a * rotation(axis, rad)
    rotate: function (out, a, rad, axis) {
      var q = quat.setAxisAngle(quat.create(), v3.normalize([0, 0, 0], axis), rad);
      var r = m4.fromQuat(m4.create(), q);
      return m4.multiply(out, a, r);
    },
    rotateX: function (out, a, rad) { return m4.rotate(out, a, rad, [1, 0, 0]); },
    rotateY: function (out, a, rad) { return m4.rotate(out, a, rad, [0, 1, 0]); },
    rotateZ: function (out, a, rad) { return m4.rotate(out, a, rad, [0, 0, 1]); },
    // Upper-left 3x3 inverse-transpose packed into a Float32Array(9) (column-major) for normals.
    normalMatrix: function (out9, a) {
      var a00 = a[0], a01 = a[1], a02 = a[2];
      var a10 = a[4], a11 = a[5], a12 = a[6];
      var a20 = a[8], a21 = a[9], a22 = a[10];
      var b01 = a22 * a11 - a12 * a21;
      var b11 = -a22 * a10 + a12 * a20;
      var b21 = a21 * a10 - a11 * a20;
      var det = a00 * b01 + a01 * b11 + a02 * b21;
      if (!det) return null;
      det = 1.0 / det;
      // Entries of the 3x3 inverse, written directly in transposed position
      // (i.e. this is inverse-transpose, column-major).
      out9[0] = b01 * det;
      out9[3] = (-a22 * a01 + a02 * a21) * det;
      out9[6] = (a12 * a01 - a02 * a11) * det;
      out9[1] = b11 * det;
      out9[4] = (a22 * a00 - a02 * a20) * det;
      out9[7] = (-a12 * a00 + a02 * a10) * det;
      out9[2] = b21 * det;
      out9[5] = (-a21 * a00 + a01 * a20) * det;
      out9[8] = (a11 * a00 - a01 * a10) * det;
      return out9;
    },
    getTranslation: function (out, a) { out[0] = a[12]; out[1] = a[13]; out[2] = a[14]; return out; }
  };

  RL.M = M;
  RL.v3 = v3;
  RL.quat = quat;
  RL.m4 = m4;
})(window.RL = window.RL || {});
