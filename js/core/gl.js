/*
 * Ridgeline — WebGL2 helpers.
 *
 * Fixed attribute locations (use `layout(location = N)` in GLSL):
 *   0 a_position (vec3)   1 a_normal (vec3)   2 a_color (vec4; 3-component data gets w = 1)
 *   3 a_uv (vec2)         4..7 per-instance attributes (vec4 each, divisor 1)
 *
 * Texture unit 7 is reserved for the shadow map (sampler2DShadow u_shadowMap).
 *
 * Default GL state that every draw function must leave behind:
 *   DEPTH_TEST on, depthMask(true), depthFunc(LEQUAL), CULL_FACE on (back faces, CCW = front),
 *   BLEND off, blendFunc(SRC_ALPHA, ONE_MINUS_SRC_ALPHA), colorMask all true.
 */
(function (RL) {
  'use strict';

  var ATTR = { position: 0, normal: 1, color: 2, uv: 3, inst0: 4, inst1: 5, inst2: 6, inst3: 7 };
  var SHADOW_UNIT = 7;

  var GL = { ATTR: ATTR, SHADOW_UNIT: SHADOW_UNIT, gl: null };

  function numberLines(src) {
    return src.split('\n').map(function (l, i) { return (i + 1) + ': ' + l; }).join('\n');
  }

  GL.createShader = function (gl, type, src, name) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      var log = gl.getShaderInfoLog(sh);
      console.error('[RL.GL] ' + (type === gl.VERTEX_SHADER ? 'vertex' : 'fragment') +
        ' shader "' + (name || '?') + '" failed:\n' + log + '\n' + numberLines(src));
      gl.deleteShader(sh);
      throw new Error('Shader compile failed: ' + (name || '?') + ': ' + log);
    }
    return sh;
  };

  /**
   * Compile + link a program. Returns
   *   { program, name, uniforms: { name: {loc, type, size} }, hasUniform(name) }.
   * Uniform arrays are registered under both "u_x" and "u_x[0]".
   * If the program declares u_shadowMap it is bound to texture unit 7 immediately.
   */
  GL.createProgram = function (gl, vsSrc, fsSrc, name) {
    var vs = GL.createShader(gl, gl.VERTEX_SHADER, vsSrc, name);
    var fs = GL.createShader(gl, gl.FRAGMENT_SHADER, fsSrc, name);
    var p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) {
      var log = gl.getProgramInfoLog(p);
      console.error('[RL.GL] program "' + (name || '?') + '" link failed:\n' + log);
      throw new Error('Program link failed: ' + (name || '?') + ': ' + log);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    var prog = { program: p, name: name || '?', uniforms: {} };
    var n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < n; i++) {
      var info = gl.getActiveUniform(p, i);
      if (!info) continue;
      var loc = gl.getUniformLocation(p, info.name);
      if (!loc) continue; // uniform block members
      var entry = { loc: loc, type: info.type, size: info.size };
      prog.uniforms[info.name] = entry;
      if (/\[0\]$/.test(info.name)) prog.uniforms[info.name.slice(0, -3)] = entry;
    }
    prog.hasUniform = function (u) { return !!prog.uniforms[u]; };
    if (prog.uniforms.u_shadowMap) {
      gl.useProgram(p);
      gl.uniform1i(prog.uniforms.u_shadowMap.loc, SHADOW_UNIT);
    }
    return prog;
  };

  /** Set one uniform on the currently bound program by its reflected type. */
  GL.setUniform = function (gl, prog, name, value) {
    var u = prog.uniforms[name];
    if (!u || value === undefined || value === null) return false;
    var loc = u.loc;
    switch (u.type) {
      case gl.FLOAT:
        if (u.size > 1 || (value.length !== undefined)) gl.uniform1fv(loc, value.length !== undefined ? value : [value]);
        else gl.uniform1f(loc, value);
        break;
      case gl.FLOAT_VEC2: gl.uniform2fv(loc, value); break;
      case gl.FLOAT_VEC3: gl.uniform3fv(loc, value); break;
      case gl.FLOAT_VEC4: gl.uniform4fv(loc, value); break;
      case gl.INT: case gl.BOOL:
      case gl.SAMPLER_2D: case gl.SAMPLER_2D_SHADOW: case gl.SAMPLER_CUBE: case gl.SAMPLER_3D:
      case gl.SAMPLER_2D_ARRAY:
        if (value.length !== undefined) gl.uniform1iv(loc, value);
        else gl.uniform1i(loc, typeof value === 'boolean' ? (value ? 1 : 0) : value);
        break;
      case gl.INT_VEC2: case gl.BOOL_VEC2: gl.uniform2iv(loc, value); break;
      case gl.INT_VEC3: case gl.BOOL_VEC3: gl.uniform3iv(loc, value); break;
      case gl.INT_VEC4: case gl.BOOL_VEC4: gl.uniform4iv(loc, value); break;
      case gl.FLOAT_MAT2: gl.uniformMatrix2fv(loc, false, value); break;
      case gl.FLOAT_MAT3: gl.uniformMatrix3fv(loc, false, value); break;
      case gl.FLOAT_MAT4: gl.uniformMatrix4fv(loc, false, value); break;
      default:
        console.warn('[RL.GL] unhandled uniform type for ' + name);
        return false;
    }
    return true;
  };

  /** Bind program and set a map of uniforms. Unknown names are ignored silently. */
  GL.use = function (gl, prog, values) {
    gl.useProgram(prog.program);
    if (values) {
      for (var k in values) if (Object.prototype.hasOwnProperty.call(values, k)) GL.setUniform(gl, prog, k, values[k]);
    }
  };

  var FRAME_KEYS = [
    ['u_viewProj', 'viewProj'], ['u_view', 'view'], ['u_proj', 'proj'], ['u_invViewProj', 'invViewProj'],
    ['u_camPos', 'camPos'], ['u_time', 'time'], ['u_resolution', 'resolution'],
    ['u_sunDir', 'sunDir'], ['u_sunColor', 'sunColor'],
    ['u_ambientSky', 'ambientSky'], ['u_ambientGround', 'ambientGround'],
    ['u_skyZenith', 'skyZenith'], ['u_skyHorizon', 'skyHorizon'],
    ['u_fogColor', 'fogColor'], ['u_fogDensity', 'fogDensity'], ['u_fogHeightFalloff', 'fogHeightFalloff'],
    ['u_nightFactor', 'nightFactor'], ['u_exposure', 'exposure'],
    ['u_spotPos', 'spotPos'], ['u_spotDir', 'spotDir'], ['u_spotIntensity', 'spotIntensity']
  ];

  /**
   * Set every standard per-frame uniform the program declares (see ShaderLib.FRAME_UNIFORMS)
   * from the frame object built in main.js. Program must already be bound (GL.use).
   */
  GL.applyFrame = function (gl, prog, frame) {
    for (var i = 0; i < FRAME_KEYS.length; i++) {
      var k = FRAME_KEYS[i];
      if (prog.uniforms[k[0]]) GL.setUniform(gl, prog, k[0], frame[k[1]]);
    }
    if (prog.uniforms.u_shadowMatrix) {
      var sh = frame.shadow;
      GL.setUniform(gl, prog, 'u_shadowMatrix', sh && sh.matrix ? sh.matrix : IDENTITY);
      GL.setUniform(gl, prog, 'u_shadowEnabled', sh && sh.enabled ? 1 : 0);
    }
    if (prog.uniforms.u_shadowMap) gl.uniform1i(prog.uniforms.u_shadowMap.loc, SHADOW_UNIT);
  };
  var IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  function toTyped(arr, Type) {
    if (!arr) return null;
    return arr instanceof Type ? arr : new Type(arr);
  }

  /**
   * Create a mesh (VAO + buffers).
   * spec: {
   *   positions (required, xyz), normals?, colors?, colorSize? (3|4, default 3), uvs?,
   *   indices? (Uint16Array/Uint32Array/array; auto-picks 32-bit when needed),
   *   mode? (gl.TRIANGLES default), usage? (gl.STATIC_DRAW default; affects positions),
   *   instances?: { data: Float32Array, stride: floats per instance,
   *                 attribs: [{ loc: 4..7, size: 1..4, offset: floats }], usage?, count? }
   * }
   * Returns { vao, count, indexType, mode, buffers, instanceCount, instanceStride }.
   */
  GL.createMesh = function (gl, spec) {
    var vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    var buffers = {};
    function attrib(name, loc, data, size, usage) {
      if (!data) return;
      var buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, toTyped(data, Float32Array), usage || gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
      buffers[name] = buf;
    }
    attrib('position', ATTR.position, spec.positions, 3, spec.usage);
    attrib('normal', ATTR.normal, spec.normals, 3);
    attrib('color', ATTR.color, spec.colors, spec.colorSize || 3);
    attrib('uv', ATTR.uv, spec.uvs, 2);
    // Constant defaults for attributes not supplied
    if (!spec.normals) gl.vertexAttrib3f(ATTR.normal, 0, 1, 0);
    if (!spec.colors) gl.vertexAttrib4f(ATTR.color, 1, 1, 1, 1);

    var mesh = {
      vao: vao, buffers: buffers, mode: spec.mode !== undefined ? spec.mode : gl.TRIANGLES,
      count: 0, indexType: 0, instanceCount: 0, instanceStride: 0, instanceCapacity: 0
    };

    if (spec.indices) {
      var idx = spec.indices;
      if (!(idx instanceof Uint16Array) && !(idx instanceof Uint32Array)) {
        var max = 0;
        for (var i = 0; i < idx.length; i++) if (idx[i] > max) max = idx[i];
        idx = max > 65535 ? new Uint32Array(idx) : new Uint16Array(idx);
      }
      var ib = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
      buffers.index = ib;
      mesh.count = idx.length;
      mesh.indexType = idx instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    } else {
      mesh.count = spec.positions.length / 3;
    }

    if (spec.instances) {
      var inst = spec.instances;
      var ibuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, ibuf);
      var data = toTyped(inst.data, Float32Array);
      gl.bufferData(gl.ARRAY_BUFFER, data, inst.usage || gl.STATIC_DRAW);
      var strideBytes = inst.stride * 4;
      for (var a = 0; a < inst.attribs.length; a++) {
        var at = inst.attribs[a];
        gl.enableVertexAttribArray(at.loc);
        gl.vertexAttribPointer(at.loc, at.size, gl.FLOAT, false, strideBytes, (at.offset || 0) * 4);
        gl.vertexAttribDivisor(at.loc, 1);
      }
      buffers.instance = ibuf;
      mesh.instanceStride = inst.stride;
      mesh.instanceCapacity = data.length / inst.stride;
      mesh.instanceCount = inst.count !== undefined ? inst.count : mesh.instanceCapacity;
    }
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    return mesh;
  };

  /** Replace per-instance data (grows the buffer if needed). */
  GL.updateInstances = function (gl, mesh, data, count) {
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.buffers.instance);
    var cap = data.length / mesh.instanceStride;
    if (cap > mesh.instanceCapacity) {
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      mesh.instanceCapacity = cap;
    } else {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, (count !== undefined ? count : cap) * mesh.instanceStride);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    mesh.instanceCount = count !== undefined ? count : cap;
  };

  /** Replace a vertex attribute buffer's contents (e.g. dynamic positions). */
  GL.updateAttribute = function (gl, mesh, name, data) {
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.buffers[name]);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  };

  /** Draw a mesh (instanced when it has instance data or instanceCount is given). */
  GL.drawMesh = function (gl, mesh, instanceCount) {
    var n = instanceCount !== undefined ? instanceCount : (mesh.buffers.instance ? mesh.instanceCount : -1);
    if (n === 0) return;
    gl.bindVertexArray(mesh.vao);
    if (n > 0) {
      if (mesh.indexType) gl.drawElementsInstanced(mesh.mode, mesh.count, mesh.indexType, 0, n);
      else gl.drawArraysInstanced(mesh.mode, 0, mesh.count, n);
    } else {
      if (mesh.indexType) gl.drawElements(mesh.mode, mesh.count, mesh.indexType, 0);
      else gl.drawArrays(mesh.mode, 0, mesh.count);
    }
    gl.bindVertexArray(null);
  };

  /** Mesh built from an RL.Geo geometry ({positions, normals, colors, uvs?, indices?}). */
  GL.meshFromGeo = function (gl, geo, extra) {
    var spec = {
      positions: geo.positions, normals: geo.normals, colors: geo.colors,
      colorSize: geo.colorSize || 3, uvs: geo.uvs, indices: geo.indices
    };
    if (extra) for (var k in extra) spec[k] = extra[k];
    return GL.createMesh(gl, spec);
  };

  /**
   * Create a 2D texture from an image/canvas/ImageData or raw data.
   * opts: { width, height, data (TypedArray) , format (gl.RGBA), internalFormat, type,
   *         wrap (gl.REPEAT | gl.CLAMP_TO_EDGE), minFilter, magFilter, mipmaps (true), anisotropy (8) }
   */
  GL.createTexture = function (gl, source, opts) {
    opts = opts || {};
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    var fmt = opts.format || gl.RGBA;
    var ifmt = opts.internalFormat || fmt;
    var type = opts.type || gl.UNSIGNED_BYTE;
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, !!opts.flipY);
    if (source) {
      gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, fmt, type, source);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, opts.width, opts.height, 0, fmt, type, opts.data || null);
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    var mip = opts.mipmaps !== false;
    var wrap = opts.wrap || gl.REPEAT;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, opts.wrapS || wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, opts.wrapT || wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, opts.minFilter || (mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, opts.magFilter || gl.LINEAR);
    if (mip) gl.generateMipmap(gl.TEXTURE_2D);
    var aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    if (aniso && mip) {
      var maxA = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
      gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(maxA, opts.anisotropy || 8));
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
  };

  /** Depth-only render target usable with sampler2DShadow (hardware PCF). */
  GL.createShadowTarget = function (gl, size) {
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, size, size);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, tex, 0);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    var status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      console.warn('[RL.GL] shadow framebuffer incomplete: 0x' + status.toString(16));
      return null;
    }
    return { fbo: fbo, texture: tex, size: size };
  };

  /**
   * 1x1 depth texture (depth = 1.0, compare mode on). Bound to unit 7 whenever no real
   * shadow map is available so sampler2DShadow is always valid and returns "lit".
   */
  GL.getDummyShadowTexture = function (gl) {
    if (GL._dummyShadow) return GL._dummyShadow;
    var t = GL.createShadowTarget(gl, 1);
    if (!t) return null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.viewport(0, 0, 1, 1);
    gl.clearDepth(1.0);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    GL._dummyShadow = t.texture;
    return t.texture;
  };

  /** Bind the frame's shadow texture (or the dummy) to unit 7. Called by main.js each frame. */
  GL.bindShadowUnit = function (gl, frame) {
    gl.activeTexture(gl.TEXTURE0 + SHADOW_UNIT);
    var tex = frame && frame.shadow && frame.shadow.enabled && frame.shadow.texture;
    gl.bindTexture(gl.TEXTURE_2D, tex || GL.getDummyShadowTexture(gl));
    gl.activeTexture(gl.TEXTURE0);
  };

  /** Restore the documented default state. */
  GL.resetState = function (gl) {
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CCW);
    gl.disable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.colorMask(true, true, true, true);
    gl.disable(gl.POLYGON_OFFSET_FILL);
  };

  /** Draw a full-screen triangle (no VAO attributes needed; use gl_VertexID in the shader). */
  GL.drawFullscreenTriangle = function (gl) {
    if (!GL._emptyVao) GL._emptyVao = gl.createVertexArray();
    gl.bindVertexArray(GL._emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  };

  RL.GL = GL;
})(window.RL = window.RL || {});
