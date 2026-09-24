/*
 * Ridgeline — shared GLSL (ES 3.00) chunks.
 *
 * Build shaders with:
 *   RL.ShaderLib.vertex(body)    -> '#version 300 es' + precision + FRAME_UNIFORMS + body
 *   RL.ShaderLib.fragment(body)  -> '#version 300 es' + precision + FRAME_UNIFORMS + shadow uniforms
 *                                   + FRAGMENT_FUNCS + body
 * then RL.GL.createProgram(gl, vs, fs, 'name') and each frame RL.GL.use(...) + RL.GL.applyFrame(gl, prog, frame).
 *
 * Color pipeline: author colors in sRGB (0..1) -> toLinear() -> light in linear space ->
 * applyFog() -> finalColor() (exposure + ACES tonemap + gamma). Every opaque/transparent
 * world shader should end with `outColor = vec4(finalColor(c), alpha);` so everything matches.
 */
(function (RL) {
  'use strict';

  var HEADER = '#version 300 es\n';
  var PRECISION =
    'precision highp float;\n' +
    'precision highp int;\n';

  var FRAME_UNIFORMS = [
    'uniform mat4 u_viewProj;',
    'uniform mat4 u_view;',
    'uniform mat4 u_proj;',
    'uniform mat4 u_invViewProj;',
    'uniform vec3 u_camPos;',
    'uniform float u_time;',
    'uniform vec2 u_resolution;',
    'uniform vec3 u_sunDir;',          // unit vector pointing TO the sun (or moon at night)
    'uniform vec3 u_sunColor;',        // linear, includes intensity
    'uniform vec3 u_ambientSky;',      // linear hemisphere ambient (from above)
    'uniform vec3 u_ambientGround;',   // linear hemisphere ambient (from below)
    'uniform vec3 u_skyZenith;',       // linear
    'uniform vec3 u_skyHorizon;',      // linear
    'uniform vec3 u_fogColor;',        // linear
    'uniform float u_fogDensity;',     // extinction per meter at y = 0
    'uniform float u_fogHeightFalloff;', // 1/m
    'uniform float u_nightFactor;',    // 0 = day, 1 = full night
    'uniform float u_exposure;',
    'uniform mat4 u_shadowMatrix;',    // world -> shadow map [0,1]^3
    'uniform float u_shadowEnabled;',
    'uniform vec3 u_spotPos;',         // aircraft landing light
    'uniform vec3 u_spotDir;',
    'uniform float u_spotIntensity;',
    ''
  ].join('\n');

  var SHADOW_UNIFORMS = 'uniform highp sampler2DShadow u_shadowMap;\n';

  var FRAGMENT_FUNCS = [
    'const float PI = 3.14159265359;',
    '',
    'vec3 toLinear(vec3 c) { return pow(max(c, vec3(0.0)), vec3(2.2)); }',
    '',
    '// Sky radiance (linear) seen along a unit direction, without the sun disc.',
    'vec3 skyColor(vec3 dir) {',
    '  float h = dir.y;',
    '  float up = clamp(h, 0.0, 1.0);',
    '  vec3 c = mix(u_skyHorizon, u_skyZenith, pow(up, 0.45));',
    '  // below the horizon fade to a slightly darker haze',
    '  c = mix(c, u_skyHorizon * 0.82, clamp(-h * 6.0, 0.0, 1.0));',
    '  float s = max(dot(dir, u_sunDir), 0.0);',
    '  float dayish = 1.0 - 0.85 * u_nightFactor;',
    '  // broad glow near the sun + horizon warming towards the sun',
    '  c += u_sunColor * (0.045 * pow(s, 6.0) + 0.16 * pow(s, 48.0)) * dayish;',
    '  float horizonBand = exp(-abs(h) * 9.0);',
    '  c += u_sunColor * 0.06 * horizonBand * pow(s, 2.0) * dayish;',
    '  return c;',
    '}',
    '',
    '// Exponential height fog (IQ). Fog colour follows the sky in the view direction so',
    '// distant terrain melts seamlessly into the horizon.',
    'vec3 applyFog(vec3 col, vec3 worldPos) {',
    '  vec3 d = worldPos - u_camPos;',
    '  float dist = length(d);',
    '  if (dist < 1e-3) return col;',
    '  vec3 rd = d / dist;',
    '  float b = max(u_fogHeightFalloff, 1e-6);',
    '  float ry = rd.y;',
    '  if (abs(ry) < 1e-4) ry = 1e-4;',
    '  float fogAmount = (u_fogDensity / b) * exp(-max(u_camPos.y, -500.0) * b) * (1.0 - exp(-dist * ry * b)) / ry;',
    '  float f = 1.0 - exp(-max(fogAmount, 0.0));',
    '  vec3 fogCol = mix(u_fogColor, skyColor(vec3(rd.x, max(rd.y, 0.0) * 0.5, rd.z)), 0.65);',
    '  return mix(col, fogCol, clamp(f, 0.0, 1.0));',
    '}',
    '',
    '// 1 = fully lit, 0 = fully shadowed. Samples the aircraft shadow map with hardware PCF.',
    'float shadowFactor(vec3 worldPos, vec3 N) {',
    '  if (u_shadowEnabled < 0.5) return 1.0;',
    '  vec3 p = worldPos + N * 0.08;',
    '  vec4 sc = u_shadowMatrix * vec4(p, 1.0);',
    '  vec3 s = sc.xyz / sc.w;',
    '  if (s.x <= 0.001 || s.x >= 0.999 || s.y <= 0.001 || s.y >= 0.999 || s.z >= 1.0) return 1.0;',
    '  vec2 texel = 1.0 / vec2(textureSize(u_shadowMap, 0));',
    '  float bias = 0.0006;',
    '  float sum = 0.0;',
    '  sum += texture(u_shadowMap, vec3(s.xy + vec2(-0.5, -0.5) * texel * 1.5, s.z - bias));',
    '  sum += texture(u_shadowMap, vec3(s.xy + vec2( 0.5, -0.5) * texel * 1.5, s.z - bias));',
    '  sum += texture(u_shadowMap, vec3(s.xy + vec2(-0.5,  0.5) * texel * 1.5, s.z - bias));',
    '  sum += texture(u_shadowMap, vec3(s.xy + vec2( 0.5,  0.5) * texel * 1.5, s.z - bias));',
    '  float lit = sum * 0.25;',
    '  // fade out near the edges of the shadow box',
    '  vec2 e = min(s.xy, 1.0 - s.xy);',
    '  float edge = smoothstep(0.0, 0.08, min(e.x, e.y));',
    '  return mix(1.0, lit, edge);',
    '}',
    '',
    '// Hemisphere ambient.',
    'vec3 hemiAmbient(vec3 N) {',
    '  return mix(u_ambientGround, u_ambientSky, N.y * 0.5 + 0.5);',
    '}',
    '',
    '// Aircraft landing light (spot) contribution, radiance multiplier for albedo.',
    'vec3 spotLight(vec3 worldPos, vec3 N) {',
    '  if (u_spotIntensity <= 0.0) return vec3(0.0);',
    '  vec3 L = u_spotPos - worldPos;',
    '  float d = length(L);',
    '  L /= max(d, 1e-3);',
    '  float cone = smoothstep(0.90, 0.97, dot(-L, u_spotDir));',
    '  float atten = 1.0 / (1.0 + d * d * 0.0012);',
    '  return vec3(1.0, 0.95, 0.85) * u_spotIntensity * cone * atten * max(dot(N, L), 0.0);',
    '}',
    '',
    '// Standard lighting: hemisphere ambient + sun (shadowed) + Blinn-Phong spec + landing light.',
    '// albedo is LINEAR. spec in [0,1], shininess ~ 8..128.',
    'vec3 shadeLit(vec3 albedo, vec3 N, vec3 worldPos, float shadow, float spec, float shininess) {',
    '  vec3 V = normalize(u_camPos - worldPos);',
    '  float ndl = max(dot(N, u_sunDir), 0.0);',
    '  vec3 H = normalize(u_sunDir + V);',
    '  float sp = spec * pow(max(dot(N, H), 0.0), shininess) * ndl;',
    '  vec3 c = albedo * (hemiAmbient(N) + u_sunColor * ndl * shadow + spotLight(worldPos, N));',
    '  c += u_sunColor * sp * shadow;',
    '  return c;',
    '}',
    '',
    'vec3 acesTonemap(vec3 x) {',
    '  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;',
    '  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);',
    '}',
    '',
    '// Linear HDR -> display sRGB.',
    'vec3 finalColor(vec3 c) {',
    '  c = acesTonemap(max(c, vec3(0.0)) * u_exposure);',
    '  return pow(c, vec3(1.0 / 2.2));',
    '}',
    '',
    '// Cheap hash / value noise helpers usable by any shader.',
    'float hash12(vec2 p) {',
    '  vec3 p3 = fract(vec3(p.xyx) * 0.1031);',
    '  p3 += dot(p3, p3.yzx + 33.33);',
    '  return fract((p3.x + p3.y) * p3.z);',
    '}',
    'float vnoise(vec2 p) {',
    '  vec2 i = floor(p); vec2 f = fract(p);',
    '  vec2 u = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),',
    '             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);',
    '}',
    ''
  ].join('\n');

  RL.ShaderLib = {
    HEADER: HEADER,
    PRECISION: PRECISION,
    FRAME_UNIFORMS: FRAME_UNIFORMS,
    SHADOW_UNIFORMS: SHADOW_UNIFORMS,
    FRAGMENT_FUNCS: FRAGMENT_FUNCS,
    vertex: function (body) {
      return HEADER + PRECISION + FRAME_UNIFORMS + '\n' + body;
    },
    fragment: function (body) {
      return HEADER + PRECISION + FRAME_UNIFORMS + SHADOW_UNIFORMS + FRAGMENT_FUNCS + '\n' + body;
    }
  };
})(window.RL = window.RL || {});
