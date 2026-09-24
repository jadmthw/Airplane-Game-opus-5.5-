/*
 * Ridgeline — RL.Sky: the sky dome and the clouds.
 *
 * draw(frame): full-screen triangle; view rays reconstructed from u_invViewProj. skyColor() from
 *   the shared shader lib, a crisp sun disc with bloom (by night u_sunDir is the moon: a cratered,
 *   gibbous moon with a halo), procedural stars with twinkle and a faint milky way.
 * drawClouds(frame): cumulus built from camera-facing puffs (procedural texture atlas made once),
 *   clustered into clouds at 900-1700 m, drifting with Config.wind (the caps over thermals stay
 *   put), lit per pixel from the cluster shape (bright tops / sun side, shaded bases, silver
 *   lining towards the sun), fogged, sorted back to front, faded near the camera, plus a soft
 *   white-out when the camera is inside a cloud.
 */
(function (RL) {
  'use strict';

  var C = RL.Config, M = RL.M;

  function sstep(a, b, x) {
    var t = (x - a) / (b - a);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return t * t * (3 - 2 * t);
  }

  // ------------------------------------------------------------------ shaders
  var FULLSCREEN_VS = [
    'out vec2 v_ndc;',
    'void main() {',
    '  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));',
    '  v_ndc = p * 2.0 - 1.0;',
    '  gl_Position = vec4(v_ndc, 1.0, 1.0);',
    '}'
  ].join('\n');

  var SKY_FS = [
    'in vec2 v_ndc;',
    'out vec4 outColor;',
    '',
    'float hash13(vec3 p) {',
    '  p = fract(p * 0.1031);',
    '  p += dot(p, p.zyx + 31.32);',
    '  return fract((p.x + p.y) * p.z);',
    '}',
    '',
    '// One layer of stars: a random point per cell of a 3D grid, projected onto the sphere.',
    'vec3 starLayer(vec3 dir, float scale, float keep, float pixAng, float boost) {',
    '  vec3 p = dir * scale;',
    '  vec3 ip = floor(p);',
    '  float h = hash13(ip);',
    '  if (h > keep) return vec3(0.0);',
    '  vec3 sp = ip + vec3(hash13(ip + 1.7), hash13(ip + 3.3), hash13(ip + 5.9)) * 0.8 + 0.1;',
    '  sp = normalize(sp) * scale;',
    '  float d = length(p - sp);',
    '  float r = pixAng * scale * 0.85;',
    '  float core = smoothstep(r, 0.0, d);',
    '  float mag = pow(hash13(ip + 7.7), 6.0) * 2.4 + 0.18;',
    '  float tw = 0.7 + 0.3 * sin(u_time * (1.5 + h * 30.0) + h * 91.0);',
    '  float temp = hash13(ip + 11.1);',
    '  vec3 tint = temp < 0.3 ? vec3(0.75, 0.85, 1.0) : (temp > 0.85 ? vec3(1.0, 0.82, 0.62) : vec3(1.0));',
    '  return tint * core * mag * tw * boost;',
    '}',
    '',
    'void main() {',
    '  vec4 a = u_invViewProj * vec4(v_ndc, -1.0, 1.0);',
    '  vec4 b = u_invViewProj * vec4(v_ndc, 1.0, 1.0);',
    '  vec3 dir = normalize(b.xyz / b.w - a.xyz / a.w);',
    '  vec3 col = skyColor(dir);',
    '  float pixAng = 2.0 / (u_proj[1][1] * u_resolution.y);',
    '  float cosA = dot(dir, u_sunDir);',
    '  float ang = sqrt(max(2.0 * (1.0 - cosA), 0.0));   // angle to the sun/moon (small-angle)',
    '  float aboveHorizon = smoothstep(-0.03, 0.01, dir.y);',
    '  float moonAmt = smoothstep(0.5, 0.7, u_nightFactor);',
    '  float sunAmt = 1.0 - moonAmt;',
    '',
    '  // sun: crisp disc (HDR, the tonemapper rolls it to white-yellow) + layered bloom',
    '  if (sunAmt > 0.0) {',
    '    float sunR = 0.0115;',
    '    float disc = smoothstep(sunR, sunR - max(pixAng * 1.5, 0.0008), ang);',
    '    float bloom = exp(-ang * ang / (0.03 * 0.03)) * 0.3 + exp(-ang / 0.08) * 0.12 + exp(-ang / 0.35) * 0.04;',
    '    col += u_sunColor * (disc * 22.0 + bloom) * sunAmt * aboveHorizon;',
    '  }',
    '',
    '  // stars + milky way',
    '  float starVis = smoothstep(0.35, 0.85, u_nightFactor) * smoothstep(-0.02, 0.18, dir.y);',
    '  if (starVis > 0.0) {',
    '    vec3 mwN = normalize(vec3(0.35, 0.55, 0.76));',
    '    float band = exp(-pow(dot(dir, mwN), 2.0) / 0.025);',
    '    vec2 sp = vec2(atan(dir.z, dir.x), dir.y);',
    '    float cloud = vnoise(sp * vec2(9.0, 14.0)) * 0.6 + vnoise(sp * vec2(23.0, 31.0)) * 0.4;',
    '    col += vec3(0.05, 0.06, 0.09) * band * (0.4 + 0.8 * cloud) * starVis;',
    '    vec3 st = starLayer(dir, 70.0, 0.06, pixAng, 1.4);',
    '    st += starLayer(dir, 160.0, 0.05 + band * 0.12, pixAng, 0.7);',
    '    st += starLayer(dir, 330.0, 0.025 + band * 0.1, pixAng, 0.45);',
    '    col += st * starVis * 0.9;',
    '  }',
    '',
    '  // moon: gibbous, cratered disc with a halo',
    '  if (moonAmt > 0.0) {',
    '    float moonR = 0.021;',
    '    vec3 t1 = normalize(cross(u_sunDir, vec3(0.0, 1.0, 0.0)));',
    '    vec3 t2 = cross(t1, u_sunDir);',
    '    vec2 uv = vec2(dot(dir, t1), dot(dir, t2)) / moonR;',
    '    float r2 = dot(uv, uv);',
    '    float disc = smoothstep(1.0, 1.0 - max(pixAng / moonR * 1.5, 0.02), sqrt(r2));',
    '    float z = sqrt(max(1.0 - r2, 0.0));',
    '    vec3 n = vec3(uv, z);',
    '    float lit = smoothstep(-0.15, 0.2, dot(n, normalize(vec3(-0.55, 0.25, 0.8))));',
    '    float maria = vnoise(uv * 2.2 + 3.0) * 0.6 + vnoise(uv * 5.0 + 1.0) * 0.4;',
    '    float surf = 0.62 + 0.38 * smoothstep(0.3, 0.72, maria);',
    '    vec3 moonCol = vec3(0.95, 0.96, 1.0) * surf * (0.04 + 0.96 * lit) * 1.15;',
    '    float halo = exp(-ang / 0.06) * 0.09 + exp(-ang / 0.25) * 0.025;',
    '    col = mix(col, moonCol, disc * moonAmt * aboveHorizon);',
    '    col += vec3(0.55, 0.62, 0.8) * halo * moonAmt * aboveHorizon;',
    '  }',
    '  outColor = vec4(finalColor(col), 1.0);',
    '}'
  ].join('\n');

  var CLOUD_VS = [
    'layout(location = 0) in vec3 a_position;',
    'layout(location = 3) in vec2 a_uv;',
    'layout(location = 4) in vec4 i_puff;     // center xyz, size (half extent)',
    'layout(location = 5) in vec4 i_cluster;  // cluster center xyz, horizontal radius',
    'layout(location = 6) in vec4 i_shape;    // base y, height, atlas variant, opacity',
    'layout(location = 7) in vec4 i_misc;     // rotation, brightness jitter',
    'out vec2 v_uv; out vec3 v_wpos; out vec4 v_cluster; out vec3 v_shape; out float v_radius;',
    'void main() {',
    '  vec3 right = vec3(u_view[0][0], u_view[1][0], u_view[2][0]);',
    '  vec3 up = vec3(u_view[0][1], u_view[1][1], u_view[2][1]);',
    '  float c = cos(i_misc.x), s = sin(i_misc.x);',
    '  vec2 q = vec2(c * a_position.x - s * a_position.y, s * a_position.x + c * a_position.y);',
    '  vec3 wp = i_puff.xyz + (right * q.x + up * q.y) * i_puff.w;',
    '  float v = i_shape.z;',
    '  v_uv = (a_uv + vec2(mod(v, 2.0), floor(v / 2.0))) * 0.5;',
    '  float d = length(i_puff.xyz - u_camPos);',
    '  // fade puffs as the camera approaches / flies through them',
    '  float nearFade = smoothstep(i_puff.w * 0.35, i_puff.w * 1.6, d);',
    '  v_shape = vec3(i_shape.xy, i_shape.w * nearFade);',
    '  v_cluster = vec4(i_cluster.xyz, i_misc.y);',
    '  v_radius = i_cluster.w;',
    '  v_wpos = wp;',
    '  gl_Position = u_viewProj * vec4(wp, 1.0);',
    '}'
  ].join('\n');

  var CLOUD_LIGHT = [
    '// Cloud radiance for a point: bright tops / sun-facing side, shaded bases, silver lining.',
    'vec3 cloudLight(vec3 wpos, vec3 center, float radius, float base, float height, float jitter) {',
    '  float hf = clamp((wpos.y - base) / max(height, 1.0), 0.0, 1.0);',
    '  vec3 rel = wpos - center;',
    '  float side = dot(normalize(rel + vec3(0.0, height * 0.35, 0.0)), u_sunDir) * 0.5 + 0.5;',
    '  float sunUp = clamp(u_sunDir.y * 2.5, 0.0, 1.0);',
    '  float lit = mix(side, hf * 0.65 + side * 0.35, sunUp);',
    '  lit = mix(0.22, 1.0, lit) * jitter;',
    '  vec3 V = normalize(wpos - u_camPos);',
    '  float fwd = pow(max(dot(V, u_sunDir), 0.0), 7.0);',
    '  // thin cloud near the silhouette (seen from the camera) scatters sunlight forward',
    '  float thin = smoothstep(0.45, 1.05, length(cross(V, rel)) / max(radius, 1.0));',
    '  vec3 c = u_sunColor * (lit * 0.58 + fwd * thin * 1.2);',
    '  c += u_ambientSky * (0.75 + 0.45 * hf) + u_ambientGround * 0.4;',
    '  return c * (1.0 - 0.3 * u_nightFactor);',
    '}'
  ].join('\n');

  var CLOUD_FS = [
    'in vec2 v_uv; in vec3 v_wpos; in vec4 v_cluster; in vec3 v_shape; in float v_radius;',
    'uniform sampler2D u_tex;',
    'out vec4 outColor;',
    CLOUD_LIGHT,
    'void main() {',
    '  vec4 t = texture(u_tex, v_uv);',
    '  float a = t.a * v_shape.z;',
    '  if (a < 0.003) discard;',
    '  vec3 c = cloudLight(v_wpos, v_cluster.xyz, v_radius, v_shape.x, v_shape.y, v_cluster.w * (0.88 + 0.12 * t.r));',
    '  c = applyFog(c, v_wpos);',
    '  outColor = vec4(finalColor(c), a);',
    '}'
  ].join('\n');

  var WHITEOUT_FS = [
    'in vec2 v_ndc;',
    'uniform float u_amount;',
    'out vec4 outColor;',
    'void main() {',
    '  vec3 c = (u_sunColor * 0.4 + u_ambientSky * 1.0 + u_ambientGround * 0.4) * (1.0 - 0.3 * u_nightFactor);',
    '  // a little texture so it reads as mist streaming past',
    '  float n = vnoise(v_ndc * 3.0 + vec2(u_time * 0.15, 0.0)) * 0.5 + vnoise(v_ndc * 7.0 - vec2(0.0, u_time * 0.3)) * 0.5;',
    '  outColor = vec4(finalColor(c * (0.9 + 0.2 * n)), u_amount * (0.8 + 0.2 * n));',
    '}'
  ].join('\n');

  // ------------------------------------------------------------------ cloud texture
  var ATLAS = 256, TILE = 128;

  function buildCloudAtlas(noise, rnd) {
    var data = new Uint8Array(ATLAS * ATLAS * 4);
    for (var v = 0; v < 4; v++) {
      var ox = (v % 2) * TILE, oy = Math.floor(v / 2) * TILE;
      var blobs = [], nb = 5 + Math.floor(rnd() * 4);
      for (var b = 0; b < nb; b++) {
        var ang = rnd() * Math.PI * 2, rr = rnd() * 0.2;
        blobs.push([0.5 + Math.cos(ang) * rr, 0.5 + Math.sin(ang) * rr * 0.8, 0.13 + rnd() * 0.12]);
      }
      for (var y = 0; y < TILE; y++) {
        for (var x = 0; x < TILE; x++) {
          var u = (x + 0.5) / TILE, w = (y + 0.5) / TILE;
          var dens = 0;
          for (b = 0; b < nb; b++) {
            var dx = u - blobs[b][0], dy = w - blobs[b][1], r = blobs[b][2];
            dens += Math.exp(-(dx * dx + dy * dy) / (r * r));
          }
          var n = noise.fbm(u * 5 + v * 13.1, w * 5 - v * 7.3, 4, 2.1, 0.5);
          dens *= 0.72 + 0.45 * n;
          var edge = Math.hypot(u - 0.5, w - 0.5);
          dens *= 1 - sstep(0.36, 0.5, edge);        // always zero at the tile border
          var alpha = sstep(0.08, 0.95, dens);
          var shade = 0.5 + 0.5 * noise.fbm(u * 9 - v * 3.3, w * 9 + v * 5.1, 3, 2.0, 0.5);
          var i = ((oy + y) * ATLAS + ox + x) * 4;
          data[i] = Math.round(M.clamp(shade, 0, 1) * 255);
          data[i + 1] = Math.round(M.clamp(dens, 0, 1) * 255);
          data[i + 2] = 255;
          data[i + 3] = Math.round(alpha * 255);
        }
      }
    }
    return data;
  }

  // ------------------------------------------------------------------ cloud field
  var WRAP = 11000;            // drifting clouds wrap around within [-WRAP, WRAP]
  var clusters = [];           // {x, z, base, height, rx, rz, anchored, puffStart, puffCount}
  var puffLocal = null;        // Float32Array per puff: lx, ly, lz, size, variant, rot, bright, alpha
  var puffCluster = null;      // Int16Array: cluster index per puff
  var nPuffs = 0;
  var order = null, dist2 = null, instData = null;
  var clusterPos = null;       // Float64Array per cluster: x, z (current, after drift)

  function buildClouds(low) {
    var rnd = M.rng((C.seed ^ 0xC10D5) >>> 0);
    var list = [];
    var nFree = low ? 16 : 26;
    for (var i = 0; i < nFree; i++) {
      var inPlay = i < nFree * 0.6;
      var span = inPlay ? 6500 : WRAP;
      list.push({
        x: (rnd() * 2 - 1) * span, z: (rnd() * 2 - 1) * span,
        base: 900 + rnd() * 450, height: 200 + rnd() * 330,
        rx: 320 + rnd() * 420, anchored: false
      });
    }
    // fair-weather cumulus caps over the thermals (they stay put)
    for (i = 0; i < C.thermals.length; i++) {
      var th = C.thermals[i];
      list.push({ x: th.x, z: th.z, base: 1250 + rnd() * 120, height: 260 + rnd() * 120, rx: 260 + rnd() * 120, anchored: true });
    }
    var maxPer = 34, puffs = [];
    for (i = 0; i < list.length; i++) {
      var c = list[i];
      c.rz = c.rx * (0.6 + rnd() * 0.4);
      c.puffStart = puffs.length;
      var np = Math.min(maxPer, Math.round(10 + c.rx / 26));
      if (low) np = Math.round(np * 0.7);
      for (var k = 0; k < np; k++) {
        // points in the ellipse, denser towards the middle; tops domed, bases flat
        var a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * 0.85;
        var lx = Math.cos(a) * rr * c.rx, lz = Math.sin(a) * rr * c.rz;
        var size = (70 + rnd() * 80) * (0.65 + 0.6 * (1 - rr)) * (c.rx / 500 + 0.5);
        var dome = c.height * Math.pow(1 - rr * rr, 0.6);
        var ly = size * 0.45 + rnd() * Math.max(dome - size * 0.55, 0);
        puffs.push([lx, ly, lz, size, Math.floor(rnd() * 4), rnd() * 6.283, 0.95 + rnd() * 0.1, 0.75 + rnd() * 0.25, i]);
      }
      c.puffCount = np;
    }
    clusters = list;
    nPuffs = puffs.length;
    puffLocal = new Float32Array(nPuffs * 8);
    puffCluster = new Int16Array(nPuffs);
    for (i = 0; i < nPuffs; i++) {
      for (k = 0; k < 8; k++) puffLocal[i * 8 + k] = puffs[i][k];
      puffCluster[i] = puffs[i][8];
    }
    order = new Uint16Array(nPuffs);
    for (i = 0; i < nPuffs; i++) order[i] = i;
    dist2 = new Float32Array(nPuffs);
    instData = new Float32Array(nPuffs * 16);
    clusterPos = new Float64Array(clusters.length * 2);
  }

  function wrap(v) {
    var s = 2 * WRAP;
    v = (v + WRAP) % s;
    if (v < 0) v += s;
    return v - WRAP;
  }

  // ------------------------------------------------------------------ module
  var glc = null, skyProg = null, cloudProg = null, whiteProg = null, cloudMesh = null, cloudTex = null;
  var driftX = 0, driftZ = 0;
  var cloudTime = 0;

  var Sky = {
    ready: false,
    whiteout: 0,

    init: function (gl) {
      if (!gl) return;
      glc = gl;
      var SL = RL.ShaderLib, G = RL.GL;
      var low = RL.Params && RL.Params.quality === 'low';
      skyProg = G.createProgram(gl, SL.vertex(FULLSCREEN_VS), SL.fragment(SKY_FS), 'sky');
      cloudProg = G.createProgram(gl, SL.vertex(CLOUD_VS), SL.fragment(CLOUD_FS), 'clouds');
      whiteProg = G.createProgram(gl, SL.vertex(FULLSCREEN_VS), SL.fragment(WHITEOUT_FS), 'cloudWhiteout');
      var noise = RL.Noise.create((C.seed + 4242) >>> 0);
      var rnd = M.rng((C.seed ^ 0xA7105) >>> 0);
      cloudTex = G.createTexture(gl, null, {
        width: ATLAS, height: ATLAS, data: buildCloudAtlas(noise, rnd), wrap: gl.CLAMP_TO_EDGE
      });
      buildClouds(low);
      cloudMesh = G.createMesh(gl, {
        positions: [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0],
        uvs: [0, 0, 1, 0, 1, 1, 0, 1],
        indices: [0, 1, 2, 0, 2, 3],
        instances: {
          data: instData, stride: 16, usage: gl.DYNAMIC_DRAW, count: 0,
          attribs: [{ loc: 4, size: 4, offset: 0 }, { loc: 5, size: 4, offset: 4 },
            { loc: 6, size: 4, offset: 8 }, { loc: 7, size: 4, offset: 12 }]
        }
      });
      var toRad = (C.wind.from + 180) * M.DEG;
      // clouds ride the stronger wind aloft
      var sp = C.wind.speed * 2.2;
      driftX = Math.sin(toRad) * sp; driftZ = -Math.cos(toRad) * sp;
      Sky.ready = true;
    },

    update: function (dt) {
      if (dt > 0 && dt < 1) cloudTime += dt;
    },

    draw: function (frame) {
      var gl = glc;
      if (!gl || !skyProg) return;
      RL.GL.use(gl, skyProg);
      RL.GL.applyFrame(gl, skyProg, frame);
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      RL.GL.drawFullscreenTriangle(gl);
      gl.depthMask(true);
      gl.enable(gl.DEPTH_TEST);
    },

    drawClouds: function (frame) {
      var gl = glc;
      if (!gl || !cloudProg || !nPuffs) return;
      var cam = frame.camPos, cx = cam[0], cy = cam[1], cz = cam[2];
      var i, k;
      // current cluster positions
      var inside = 0;
      for (i = 0; i < clusters.length; i++) {
        var c = clusters[i];
        var x = c.x, z = c.z;
        if (!c.anchored) { x = wrap(x + driftX * cloudTime); z = wrap(z + driftZ * cloudTime); }
        clusterPos[i * 2] = x; clusterPos[i * 2 + 1] = z;
        // how deep inside this cloud the camera is (ellipsoid metric)
        var ex = (cx - x) / c.rx, ez = (cz - z) / c.rz;
        var ey = (cy - (c.base + c.height * 0.45)) / (c.height * 0.6);
        var q = Math.sqrt(ex * ex + ey * ey + ez * ez);
        if (q < 1) inside = Math.max(inside, sstep(1.0, 0.5, q));
      }
      Sky.whiteout = inside;
      // puff world positions + distance for sorting
      for (i = 0; i < nPuffs; i++) {
        var ci = puffCluster[i], o = i * 8;
        var px = clusterPos[ci * 2] + puffLocal[o], py = clusters[ci].base + puffLocal[o + 1];
        var pz = clusterPos[ci * 2 + 1] + puffLocal[o + 2];
        var dx = px - cx, dy = py - cy, dz = pz - cz;
        dist2[i] = dx * dx + dy * dy + dz * dz;
      }
      // back to front; insertion sort is near-linear because the order barely changes per frame
      for (i = 1; i < nPuffs; i++) {
        var id = order[i], d = dist2[id];
        k = i - 1;
        while (k >= 0 && dist2[order[k]] < d) { order[k + 1] = order[k]; k--; }
        order[k + 1] = id;
      }
      var n = 0;
      for (var j = 0; j < nPuffs; j++) {
        i = order[j];
        ci = puffCluster[i]; o = i * 8;
        c = clusters[ci];
        var wx = clusterPos[ci * 2], wz = clusterPos[ci * 2 + 1];
        // fade out drifting clouds near the wrap seam so they never pop
        var edgeFade = c.anchored ? 1 : 1 - sstep(WRAP - 2500, WRAP - 300, Math.max(Math.abs(wx), Math.abs(wz)));
        var alpha = puffLocal[o + 7] * edgeFade;
        if (alpha < 0.01) continue;
        var b = n * 16;
        instData[b] = wx + puffLocal[o];
        instData[b + 1] = c.base + puffLocal[o + 1];
        instData[b + 2] = wz + puffLocal[o + 2];
        instData[b + 3] = puffLocal[o + 3];
        instData[b + 4] = wx; instData[b + 5] = c.base + c.height * 0.5; instData[b + 6] = wz;
        instData[b + 7] = c.rx;
        instData[b + 8] = c.base; instData[b + 9] = c.height; instData[b + 10] = puffLocal[o + 4];
        instData[b + 11] = alpha;
        instData[b + 12] = puffLocal[o + 5]; instData[b + 13] = puffLocal[o + 6];
        instData[b + 14] = 0; instData[b + 15] = 0;
        n++;
      }
      var G = RL.GL;
      G.updateInstances(gl, cloudMesh, instData, n);
      G.use(gl, cloudProg);
      G.applyFrame(gl, cloudProg, frame);
      var u = cloudProg.uniforms.u_tex;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, cloudTex);
      if (u) gl.uniform1i(u.loc, 0);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.disable(gl.CULL_FACE);
      if (n > 0) G.drawMesh(gl, cloudMesh, n);
      if (inside > 0.01 && whiteProg) {
        G.use(gl, whiteProg);
        G.applyFrame(gl, whiteProg, frame);
        var ua = whiteProg.uniforms.u_amount;
        if (ua) gl.uniform1f(ua.loc, inside * 0.85);
        gl.disable(gl.DEPTH_TEST);
        G.drawFullscreenTriangle(gl);
        gl.enable(gl.DEPTH_TEST);
      }
      gl.enable(gl.CULL_FACE);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
  };

  RL.Sky = Sky;
})(window.RL = window.RL || {});
