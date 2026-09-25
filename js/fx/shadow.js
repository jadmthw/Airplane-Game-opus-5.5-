/*
 * Ridgeline — RL.Shadow: the aircraft's sun shadow.
 *
 *   init(gl, size)                     depth-only program + depth texture target
 *   render(frame, casters, focusPos)   sets frame.shadow = {texture, matrix, enabled: true}
 *
 * One orthographic box (~60 m across) around the aircraft, looking along -sunDir. Only the
 * aircraft casts; terrain / airfield / water / aircraft receive through ShaderLib.shadowFactor.
 *
 * Depth range is adaptive: we march from the aircraft down the sun ray to the ground and size the
 * box to end just past that hit. Parked, the box is ~100 m deep, so shadowFactor's constant
 * 0.0006 depth bias is only a few centimetres (crisp wheel contact shadow); at altitude with a
 * low sun it stretches to several km so the shadow still lands on the valley floor.
 * The light-space center is snapped to whole texels so the shadow edge does not shimmer as the
 * aircraft moves. Casters draw double-sided with a slope-scaled polygon offset (thin control
 * surfaces are not closed solids, so front-face culling would drop them).
 */
(function (RL) {
  'use strict';

  var v3 = RL.v3, m4 = RL.m4, M = RL.M;

  var BOX_HALF = 30;           // m, half-width of the ortho box (60 m across)
  var NEAR_MARGIN = 25;        // m, how far the box starts on the sun side of the aircraft
  var MAX_RANGE = 9000;        // m, deepest box (very low sun from high up)
  var MIN_ELEV_SIN = Math.sin(2 * M.DEG);
  var MAX_CAM_DIST = 2500;     // m, beyond this the shadow is sub-pixel: skip the pass

  var VS = [
    'layout(location = 0) in vec3 a_position;',
    'uniform mat4 u_lightViewProj;',
    'uniform mat4 u_model;',
    'void main() {',
    '  gl_Position = u_lightViewProj * u_model * vec4(a_position, 1.0);',
    '}'
  ].join('\n');

  var FS = [
    'void main() {}'
  ].join('\n');

  var gl = null, prog = null, target = null;
  var view = m4.create(), proj = m4.create(), lightVP = m4.create(), shadowMatrix = m4.create();
  var bias = new Float32Array([0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0.5, 0, 0.5, 0.5, 0.5, 1]);
  var right = v3.create(), up = v3.create(), eye = v3.create();
  var shadowObj = { texture: null, matrix: shadowMatrix, enabled: true };
  var UP = [0, 1, 0], NORTH = [0, 0, -1];

  /**
   * Distance along -sunDir from p to the terrain/water surface, or `maxDist` when the ray
   * escapes (sun ray never reaches the ground inside the range). Coarse march with geometric
   * steps, then a short bisection.
   */
  function groundHitDistance(p, s, maxDist) {
    var W = RL.World;
    if (!W || !W.surfaceHeightAt) return maxDist;
    var px = p[0], py = p[1], pz = p[2];
    var h0 = py - W.surfaceHeightAt(px, pz);
    if (!(h0 > 0)) return 0;                               // at/below the surface (or NaN)
    var prevT = 0, t = Math.min(2, h0), step = 2;
    while (t < maxDist) {
      var y = py - s[1] * t;
      var gh = W.surfaceHeightAt(px - s[0] * t, pz - s[2] * t);
      if (y <= gh) {
        var lo = prevT, hi = t;
        for (var k = 0; k < 8; k++) {
          var mid = (lo + hi) * 0.5;
          if (py - s[1] * mid <= W.surfaceHeightAt(px - s[0] * mid, pz - s[2] * mid)) hi = mid; else lo = mid;
        }
        return hi;
      }
      prevT = t;
      step = Math.min(step * 1.35, 150);
      t += step;
    }
    return maxDist;
  }

  var Shadow = {
    ready: false,
    size: 0,
    /** Diagnostics for tests: last box depth (m), ground hit distance (m), skip reason. */
    info: { range: 0, hit: 0, skipped: 'init' },

    init: function (glCtx, size) {
      gl = glCtx;
      size = size || 2048;
      var SL = RL.ShaderLib;
      prog = RL.GL.createProgram(gl, SL.vertex(VS), SL.fragment(FS), 'shadow-depth');
      // Create the 1x1 "fully lit" fallback now (it is cached), not lazily mid-frame the first
      // time a frame has no shadow (sun low, aircraft far from the camera, or no target below).
      if (RL.GL.getDummyShadowTexture) RL.GL.getDummyShadowTexture(gl);
      target = RL.GL.createShadowTarget(gl, size);
      if (!target) return;
      Shadow.size = size;
      shadowObj.texture = target.texture;
      Shadow.ready = true;
    },

    render: function (frame, casters, focusPos) {
      var info = Shadow.info;
      if (!Shadow.ready || !frame || !casters || !casters.length || !focusPos) { info.skipped = 'nodata'; return; }
      var s = frame.sunDir;
      if (!s || !(s[1] > MIN_ELEV_SIN)) { info.skipped = 'sunLow'; return; }
      if (frame.camPos && v3.dist(frame.camPos, focusPos) > MAX_CAM_DIST) { info.skipped = 'far'; return; }
      if (!isFinite(focusPos[0] + focusPos[1] + focusPos[2])) { info.skipped = 'nan'; return; }

      // Light basis: looking along -s. Reference up is world Y unless the sun is near zenith.
      v3.cross(right, s, Math.abs(s[1]) > 0.98 ? NORTH : UP);
      // right = s x ref is perpendicular to s; flip so that it matches a right-handed view basis
      v3.negate(right, right);
      v3.normalize(right, right);
      v3.cross(up, s, right);          // up = s x right  (view basis: right, up, back = s)
      v3.normalize(up, up);

      // Texel-snapped light-space center (the basis only changes during time-of-day blends).
      var texel = (2 * BOX_HALF) / target.size;
      var cx = Math.floor(v3.dot(focusPos, right) / texel) * texel;
      var cy = Math.floor(v3.dot(focusPos, up) / texel) * texel;
      v3.scaleAndAdd(eye, focusPos, s, NEAR_MARGIN);
      var cz = v3.dot(eye, s);

      // Box depth: just past where the sun ray from the aircraft meets the ground.
      var hit = groundHitDistance(focusPos, s, MAX_RANGE);
      var range = M.clamp(NEAR_MARGIN + hit + 40 + hit * 0.15, 80, MAX_RANGE + NEAR_MARGIN);
      info.hit = hit; info.range = range; info.skipped = '';

      view[0] = right[0]; view[4] = right[1]; view[8] = right[2]; view[12] = -cx;
      view[1] = up[0]; view[5] = up[1]; view[9] = up[2]; view[13] = -cy;
      view[2] = s[0]; view[6] = s[1]; view[10] = s[2]; view[14] = -cz;
      view[3] = 0; view[7] = 0; view[11] = 0; view[15] = 1;
      m4.ortho(proj, -BOX_HALF, BOX_HALF, -BOX_HALF, BOX_HALF, 0, range);
      m4.multiply(lightVP, proj, view);
      m4.multiply(shadowMatrix, bias, lightVP);

      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.viewport(0, 0, target.size, target.size);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.clearDepth(1.0);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(1.6, 4.0);

      gl.useProgram(prog.program);
      RL.GL.setUniform(gl, prog, 'u_lightViewProj', lightVP);
      for (var i = 0; i < casters.length; i++) {
        var c = casters[i];
        if (!c || !c.mesh || !c.model) continue;
        RL.GL.setUniform(gl, prog, 'u_model', c.model);
        RL.GL.drawMesh(gl, c.mesh);
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      RL.GL.resetState(gl);
      shadowObj.enabled = true;
      frame.shadow = shadowObj;
    }
  };

  RL.Shadow = Shadow;
})(window.RL = window.RL || {});
