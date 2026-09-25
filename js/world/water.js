/*
 * Ridgeline — RL.Water: the lake surface at Config.water.level.
 *
 * One quad per lake (terrain stays above the water level everywhere else). The fragment shader
 * reads the terrain heightfield (R16F texture from Terrain.getHeightData) to get the water depth:
 * depth-tinted colour and alpha, a soft shoreline and animated foam. Waves are a sum of wind-aligned
 * directional swells plus drifting noise ripples (faded by pixel footprint so they never alias);
 * fresnel mixes in a reflection found by ray-marching the reflected ray over the heightfield
 * (mirrored hills and peaks, skyColor() above them) and a sun / moon glint. The march is skipped
 * where fresnel makes the reflection negligible; quality=low also drops the finest ripple octave.
 */
(function (RL) {
  'use strict';

  var C = RL.Config;

  var VS = [
    'layout(location = 0) in vec3 a_position;',
    'out vec3 v_pos;',
    'void main() {',
    '  v_pos = a_position;',
    '  gl_Position = u_viewProj * vec4(a_position, 1.0);',
    '}'
  ].join('\n');

  // Quality switch, prepended to FS. (The reflection march keeps its 22 steps on low: with fewer,
  // longer steps whole ridges drop out of the mirrored image.)
  var FS_HIGH = 'const bool FINE_RIPPLES = true;';
  var FS_LOW = 'const bool FINE_RIPPLES = false;';

  var FS = [
    'in vec3 v_pos;',
    'uniform sampler2D u_height;',
    'uniform vec4 u_hmap;      // half, cell, texels per side, water level',
    'uniform vec2 u_windDir;   // unit, direction the wind blows towards (xz)',
    'out vec4 outColor;',
    '',
    'float terrainH(vec2 p) {',
    '  vec2 uv = ((p + u_hmap.x) / u_hmap.y + 0.5) / u_hmap.z;',
    '  return texture(u_height, uv).r;',
    '}',
    '',
    '// Attenuation for a wave of wavenumber k given the pixel footprint fp (m): fades waves that',
    '// would be narrower than a few pixels, which otherwise alias into moire rings far away.',
    'float aa(float k, float fp) { return 1.0 - smoothstep(0.3, 1.0, k * fp); }',
    '',
    '// Mirrored terrain at ground point p: albedo by height (grass, rock, snow), lit like the real',
    '// terrain, fogged along the reflected path. The slope normal comes from two extra taps a cell',
    '// and a half apart: the R16F heights are quantised to ~1 m up high, so closer taps give',
    '// striped, noisy shading on the reflected peaks.',
    'vec3 reflTerrain(vec2 p) {',
    '  float e = u_hmap.y * 1.5;',
    '  float h = terrainH(p);',
    '  vec3 Nt = normalize(vec3(h - terrainH(p + vec2(e, 0.0)), e, h - terrainH(p + vec2(0.0, e))));',
    '  vec3 alb = mix(vec3(0.27, 0.40, 0.19), vec3(0.45, 0.41, 0.36), smoothstep(200.0, 650.0, h));',
    '  alb = mix(alb, vec3(0.92, 0.94, 0.98), smoothstep(1150.0, 1300.0, h));',
    '  vec3 c = toLinear(alb) * (hemiAmbient(Nt) + u_sunColor * max(dot(Nt, u_sunDir), 0.0));',
    '  return applyFog(c, vec3(p.x, h, p.y));',
    '}',
    '',
    '// Reflected view: march the reflected ray over the heightfield so the surrounding hills and',
    '// peaks appear mirrored in the lake; the sky where nothing is hit. A hit is refined between',
    '// the last two samples. A near miss still blends in the ground it passed closest to, by the',
    '// angle it cleared it by (soft, from the wave roughness): rippled water blurs the mirror image,',
    '// and a binary hit / miss test turns every ripple into a hard-edged dark slick.',
    'vec3 reflection(vec3 ro, vec3 rd, float soft) {',
    '  float t = 6.0, tPrev = 0.0, best = -1.0, tBest = 0.0;',
    '  for (int i = 0; i < 22; i++) {',
    '    vec3 p = ro + rd * t;',
    '    float d = p.y - terrainH(p.xz);',
    '    if (d < 0.0) {',
    '      // refine the crossing: a few bisection steps between the last two samples',
    '      float a = tPrev, b = t;',
    '      for (int k = 0; k < 4; k++) {',
    '        float c = 0.5 * (a + b);',
    '        vec3 q = ro + rd * c;',
    '        if (q.y < terrainH(q.xz)) b = c; else a = c;',
    '      }',
    '      return reflTerrain((ro + rd * b).xz);',
    '    }',
    '    float m = -d / t;          // angle by which the ray clears the ground here (negative)',
    '    if (m > best) { best = m; tBest = t; }',
    '    tPrev = t;',
    '    t *= 1.38;',
    '  }',
    '  vec3 sky = skyColor(rd);',
    '  if (best <= -soft) return sky;',
    '  return mix(sky, reflTerrain((ro + rd * tBest).xz), smoothstep(-soft, 0.0, best));',
    '}',
    '',
    '// Slope (d height / d xz) of the animated surface.',
    'vec2 waveSlope(vec2 p, float t, float fp) {',
    '  vec2 w = u_windDir;',
    '  vec2 s = vec2(0.0);',
    '  // wind-aligned swells: direction, wavenumber, steepness, speed',
    '  vec2 d0 = w;',
    '  vec2 d1 = normalize(w + vec2(-w.y, w.x) * 0.55);',
    '  vec2 d2 = normalize(w - vec2(-w.y, w.x) * 0.7);',
    '  vec2 d3 = normalize(vec2(-w.y, w.x) + w * 0.3);',
    '  s += d0 * cos(dot(d0, p) * 0.62 - t * 2.4) * 0.055 * aa(0.62, fp);',
    '  s += d1 * cos(dot(d1, p) * 1.13 - t * 3.3) * 0.045 * aa(1.13, fp);',
    '  s += d2 * cos(dot(d2, p) * 1.91 - t * 4.2) * 0.035 * aa(1.91, fp);',
    '  s += d3 * cos(dot(d3, p) * 3.40 - t * 5.8) * 0.025 * aa(3.40, fp);',
    '  // drifting cat\'s-paw ripples (noise gradient)',
    '  float e = 0.35;',
    '  vec2 q = p * 0.35 - w * t * 0.6;',
    '  float n0 = vnoise(q), nx = vnoise(q + vec2(e, 0.0)), nz = vnoise(q + vec2(0.0, e));',
    '  s += vec2(nx - n0, nz - n0) / e * 0.05 * aa(2.2, fp);',
    '  float fine = aa(8.0, fp);',
    '  if (FINE_RIPPLES && fine > 0.0) {',
    '    vec2 q2 = p * 1.3 + w.yx * t * 0.9;',
    '    float m0 = vnoise(q2), mx = vnoise(q2 + vec2(e, 0.0)), mz = vnoise(q2 + vec2(0.0, e));',
    '    s += vec2(mx - m0, mz - m0) / e * 0.022 * fine;',
    '  }',
    '  // gusts roughen patches of the lake',
    '  float gust = 0.6 + 0.8 * vnoise(p * 0.004 - w * t * 0.02);',
    '  return s * gust;',
    '}',
    '',
    'void main() {',
    '  float level = u_hmap.w;',
    '  float depth = level - terrainH(v_pos.xz);',
    '  if (depth < -0.25) discard;',
    '  vec3 toCam = u_camPos - v_pos;',
    '  float dist = length(toCam);',
    '  vec3 V = toCam / max(dist, 1e-3);',
    '  float fp = length(fwidth(v_pos.xz));',
    '  float fade = 1.0 - 0.85 * smoothstep(60.0, 1600.0, dist);',
    '  vec2 sl = waveSlope(v_pos.xz, u_time, fp) * fade;',
    '  vec3 N = normalize(vec3(-sl.x, 1.0, -sl.y));',
    '  float sh = shadowFactor(v_pos, vec3(0.0, 1.0, 0.0));',
    '',
    '  float cosT = clamp(dot(N, V), 0.0, 1.0);',
    '  float fres = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);',
    '  vec3 R = reflect(-V, N);',
    '  R.y = abs(R.y);',
    '  R.y = max(R.y, 0.004);',
    '  // The mirror image uses calmer waves at grazing angles: full wave slopes swing the nearly',
    '  // horizontal reflected ray between the far bank and the sky from pixel to pixel.',
    '  float calm = mix(0.3, 1.0, smoothstep(0.05, 0.5, V.y));',
    '  vec3 Rm = reflect(-V, normalize(vec3(-sl.x * calm, 1.0, -sl.y * calm)));',
    '  Rm.y = max(abs(Rm.y), 0.004);',
    '  Rm = normalize(Rm);',
    '  float soft = 0.02 + 0.6 * length(sl) * calm;',
    '  // below ~2.5 % fresnel the mirrored terrain cannot show: skip the march',
    '  vec3 refl = fres < 0.025 ? skyColor(Rm) : reflection(v_pos + vec3(0.0, 0.5, 0.0), Rm, soft);',
    '',
    '  // water body: shallow turquoise -> deep blue-green, lit by sun + sky',
    '  float dk = 1.0 - exp(-max(depth, 0.0) * 0.16);',
    '  vec3 shallow = toLinear(vec3(0.24, 0.50, 0.44));',
    '  vec3 deep = toLinear(vec3(0.03, 0.15, 0.20));',
    '  vec3 bodyAlb = mix(shallow, deep, dk);',
    '  vec3 body = bodyAlb * (hemiAmbient(N) + u_sunColor * max(u_sunDir.y, 0.0) * (0.35 + 0.65 * sh) * 0.55);',
    '  body += bodyAlb * spotLight(v_pos, N);',
    '  vec3 col = mix(body, refl, fres);',
    '',
    '  // sun (or moon) glint',
    '  float sd = max(dot(R, u_sunDir), 0.0);',
    '  float glint = pow(sd, 900.0) * 9.0 + pow(sd, 90.0) * 0.35;',
    '  col += u_sunColor * glint * sh * (0.4 + 0.6 * fade);',
    '',
    '  // foam where the lake laps the shore',
    '  float band = 1.0 - smoothstep(0.0, 1.1, depth);',
    '  float fn = vnoise(v_pos.xz * 0.45 + vec2(u_time * 0.21, -u_time * 0.17));',
    '  float lap = 0.5 + 0.5 * sin(depth * 7.0 - u_time * 1.6 + fn * 4.0);',
    '  float foam = band * smoothstep(0.45, 0.8, fn * 0.6 + lap * 0.55) * (1.0 - smoothstep(300.0, 1200.0, dist));',
    '  vec3 foamCol = toLinear(vec3(0.92, 0.95, 0.95)) * (hemiAmbient(vec3(0.0, 1.0, 0.0)) + u_sunColor * max(u_sunDir.y, 0.0) * sh);',
    '  col = mix(col, foamCol, foam * 0.75);',
    '',
    '  float alpha = mix(0.5, 0.94, dk);',
    '  alpha = mix(alpha, 1.0, fres * 0.8);',
    '  alpha = clamp(alpha + glint * 0.2 + foam * 0.5, 0.0, 1.0);',
    '  alpha *= smoothstep(-0.25, 0.35, depth);    // soft shoreline',
    '  col = applyFog(col, v_pos);',
    '  outColor = vec4(finalColor(col), alpha);',
    '}'
  ].join('\n');

  var glc = null, prog = null, meshes = [], heightTex = null;
  var hmap = new Float32Array(4), windDir = new Float32Array(2);

  function buildHeightTexture(gl) {
    var T = RL.Terrain;
    var hd = T && T.ready && T.getHeightData ? T.getHeightData() : null;
    if (!hd || !hd.data) return null;
    var n = hd.res + 1;
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    // R16F is filterable in WebGL2 without extensions; uploading FLOAT data into it is allowed.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, n, n, 0, gl.RED, gl.FLOAT, hd.data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    hmap[0] = hd.half; hmap[1] = 2 * hd.half / hd.res; hmap[2] = n; hmap[3] = C.water.level;
    return tex;
  }

  var Water = {
    ready: false,

    init: function (gl) {
      if (!gl) return;
      glc = gl;
      var SL = RL.ShaderLib;
      var low = RL.Params && RL.Params.quality === 'low';
      prog = RL.GL.createProgram(gl, SL.vertex(VS), SL.fragment((low ? FS_LOW : FS_HIGH) + '\n' + FS), 'water');
      var lvl = C.water.level;
      meshes = [];
      for (var i = 0; i < C.water.lakes.length; i++) {
        var lk = C.water.lakes[i], r = lk.radius * 1.4 + 80;
        // CCW seen from above
        var pos = [lk.x - r, lvl, lk.z - r, lk.x - r, lvl, lk.z + r, lk.x + r, lvl, lk.z + r, lk.x + r, lvl, lk.z - r];
        meshes.push(RL.GL.createMesh(gl, { positions: pos, indices: [0, 1, 2, 0, 2, 3] }));
      }
      heightTex = buildHeightTexture(gl);
      var toRad = (C.wind.from + 180) * RL.M.DEG;
      windDir[0] = Math.sin(toRad); windDir[1] = -Math.cos(toRad);
      Water.ready = !!heightTex;
    },

    /** Waves are driven by frame.time (game time, frozen while paused), so nothing to step. */
    update: function () {},

    draw: function (frame) {
      var gl = glc;
      if (!gl || !prog) return;
      if (!heightTex) {
        // Terrain was not ready when we initialised (odd boot order); retry until it is.
        heightTex = buildHeightTexture(gl);
        if (!heightTex) return;
        Water.ready = true;
      }
      RL.GL.use(gl, prog);
      RL.GL.applyFrame(gl, prog, frame);
      var u = prog.uniforms;
      if (u.u_hmap) gl.uniform4fv(u.u_hmap.loc, hmap);
      if (u.u_windDir) gl.uniform2fv(u.u_windDir.loc, windDir);
      if (u.u_height) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, heightTex);
        gl.uniform1i(u.u_height.loc, 0);
      }
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      for (var i = 0; i < meshes.length; i++) RL.GL.drawMesh(gl, meshes[i]);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
  };

  RL.Water = Water;
})(window.RL = window.RL || {});
