/*
 * Ridgeline — bootstrap, main loop, render orchestration, action dispatch and test hooks.
 * Every module call goes through RL.safe() so a missing or failing module degrades gracefully
 * (errors are logged once and collected in RL.errors for the automated tests).
 */
(function (RL) {
  'use strict';
  var M = RL.M, v3 = RL.v3, m4 = RL.m4, C = RL.Config;

  // ------------------------------------------------------------------ params
  var qs = new URLSearchParams(window.location.search);
  RL.Params = {
    autostart: qs.has('autostart'),
    quality: qs.get('quality') === 'low' ? 'low' : 'high',
    debug: qs.has('debug'),
    time: qs.get('time'),
    noaudio: qs.has('noaudio'),
    camera: qs.get('camera')
  };

  RL.errors = [];
  var reported = {};

  /** Call RL[modName][fnName](...args) if it exists; log the first failure per function. */
  function safe(modName, fnName, args) {
    var mod = RL[modName];
    if (!mod || typeof mod[fnName] !== 'function') return undefined;
    try {
      return mod[fnName].apply(mod, args || []);
    } catch (e) {
      var key = modName + '.' + fnName;
      if (!reported[key]) {
        reported[key] = true;
        console.error('[RL] ' + key + ' threw:', e);
        RL.errors.push(key + ': ' + (e && e.message ? e.message : e));
      }
      return undefined;
    }
  }
  RL.safe = safe;

  window.addEventListener('error', function (e) {
    RL.errors.push('window: ' + (e.message || e.error));
  });

  // ------------------------------------------------------------------ state
  var gl, canvas, hudCanvas;
  var width = 1, height = 1, dpr = 1;
  var lastNow = 0, worldTime = 0, realTime = 0;
  var fpsAccum = 0, fpsFrames = 0;
  var defaultControls = { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0, smoke: false };

  var frame = {
    time: 0, dt: 0, realTime: 0,
    view: m4.create(), proj: m4.create(), viewProj: m4.create(), invViewProj: m4.create(),
    camPos: v3.create(0, 60, 700), camForward: v3.create(0, 0, -1),
    resolution: new Float32Array(2), pixelRatio: 1, aspect: 1, fov: 1, near: 1, far: 1000,
    sunDir: [0, 1, 0], sunColor: [1, 1, 1], ambientSky: [0.3, 0.3, 0.3], ambientGround: [0.1, 0.1, 0.1],
    skyZenith: [0.1, 0.2, 0.6], skyHorizon: [0.5, 0.6, 0.8], fogColor: [0.5, 0.6, 0.7],
    fogDensity: 1e-4, fogHeightFalloff: 1e-3, nightFactor: 0, exposure: 1,
    spotPos: v3.create(), spotDir: v3.create(0, 0, -1), spotIntensity: 0,
    shadow: null,
    cameraMode: 'chase',
    gameState: 'title'
  };
  RL.frame = frame;

  function getPlane() { return RL.Game ? RL.Game.plane : null; }
  function getControls() {
    var c = (RL.Input && RL.Input.controls) || defaultControls;
    if (RL.debug.controls) {
      var o = {};
      for (var k in c) o[k] = c[k];
      for (k in RL.debug.controls) o[k] = RL.debug.controls[k];
      return o;
    }
    return c;
  }
  function gameState() { return (RL.Game && RL.Game.state) || 'title'; }

  function toast(text, kind) {
    if (text) RL.Events.emit('message', { text: text, kind: kind || 'info', duration: 1.6 });
  }

  // ------------------------------------------------------------------ boot
  function showFatal(msg) {
    var el = document.getElementById('loading');
    if (el) {
      el.classList.add('fatal');
      el.innerHTML = '<div class="loading-title">Ridgeline</div><div class="loading-msg">' + msg + '</div>';
    }
    console.error('[RL] fatal:', msg);
  }

  function setLoading(msg, frac) {
    var m = document.getElementById('loading-msg');
    var b = document.getElementById('loading-bar-fill');
    if (m) m.textContent = msg;
    if (b) b.style.width = Math.round(frac * 100) + '%';
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, RL.Params.quality === 'low' ? 1 : 2);
    var w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    var h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (w !== canvas.width || h !== canvas.height) {
      canvas.width = w; canvas.height = h;
    }
    width = w; height = h;
    var hw = Math.max(1, Math.floor(hudCanvas.clientWidth * dpr));
    var hh = Math.max(1, Math.floor(hudCanvas.clientHeight * dpr));
    if (hw !== hudCanvas.width || hh !== hudCanvas.height) {
      hudCanvas.width = hw; hudCanvas.height = hh;
      safe('HUD', 'resize', [hw, hh, dpr]);
    }
  }

  function boot() {
    canvas = document.getElementById('gl');
    hudCanvas = document.getElementById('hud');
    try {
      gl = canvas.getContext('webgl2', {
        antialias: true, alpha: false, depth: true, stencil: false,
        powerPreference: 'high-performance', preserveDrawingBuffer: !!RL.Params.debug
      });
    } catch (e) { gl = null; }
    if (!gl) {
      showFatal('Your browser or GPU does not support WebGL2, which Ridgeline needs. ' +
        'Try a current version of Chrome, Firefox, Edge or Safari.');
      return;
    }
    RL.gl = gl;
    RL.GL.gl = gl;
    canvas.addEventListener('webglcontextlost', function (e) {
      e.preventDefault();
      showFatal('The graphics context was lost. Please reload the page.');
      document.getElementById('loading').style.display = '';
    });
    resize();
    window.addEventListener('resize', resize);

    var low = RL.Params.quality === 'low';
    var steps = [
      ['Atmosphere', 'init', [], 'Mixing the sky'],
      ['Terrain', 'init', [gl, { resolution: low ? 256 : C.world.resolution }], 'Raising mountains'],
      ['Water', 'init', [gl], 'Filling the lake'],
      ['Sky', 'init', [gl], 'Painting clouds'],
      ['Airfield', 'init', [gl], 'Paving the runway'],
      ['Rings', 'init', [gl], 'Hanging the rings'],
      ['Aircraft', 'init', [gl], 'Rolling out the aircraft'],
      ['Particles', 'init', [gl], 'Stirring up dust'],
      ['Effects', 'init', [gl], 'Waking the birds'],
      ['Shadow', 'init', [gl, low ? 1024 : C.render.shadowMapSize], 'Casting shadows'],
      ['Input', 'init', [canvas], 'Connecting controls'],
      ['CameraRig', 'init', [], 'Mounting cameras'],
      ['Audio', 'init', [], 'Tuning the engine'],
      ['HUD', 'init', [hudCanvas], 'Calibrating instruments'],
      ['UI', 'init', [], 'Printing the checklist'],
      ['Game', 'init', [], 'Clearing for takeoff']
    ];
    var i = 0;
    function next() {
      if (i >= steps.length) { start(); return; }
      var s = steps[i];
      setLoading(s[3] + '…', i / steps.length);
      // yield so the loading text paints before heavy work
      setTimeout(function () {
        var t0 = performance.now();
        safe(s[0], s[1], s[2]);
        var ms = performance.now() - t0;
        if (RL.Params.debug) console.log('[RL] init ' + s[0] + ' ' + ms.toFixed(1) + ' ms');
        i++;
        next();
      }, 0);
    }
    next();
  }

  function start() {
    setLoading('Ready', 1);
    var el = document.getElementById('loading');
    if (el) el.classList.add('done');
    setTimeout(function () { if (el) el.style.display = 'none'; }, 600);
    if (RL.Params.camera) safe('CameraRig', 'setMode', [RL.Params.camera]);
    resize();
    RL.ready = true;
    RL.Events.emit('ready', {});
    lastNow = performance.now();
    requestAnimationFrame(loop);
  }

  // ------------------------------------------------------------------ actions
  function dispatchAction(a) {
    var r;
    switch (a) {
      case 'camera':
        r = safe('CameraRig', 'cycle');
        if (r) toast('Camera: ' + r);
        break;
      case 'mute':
        r = safe('Audio', 'toggleMute');
        if (r !== undefined) toast(r ? 'Sound off' : 'Sound on');
        break;
      case 'timeOfDay':
        r = safe('Atmosphere', 'cycle');
        if (r) toast(r);
        break;
      case 'smokeColor':
        r = safe('Effects', 'cycleSmokeColor');
        if (r) toast('Smoke: ' + r);
        break;
      case 'help':
        safe('UI', 'toggleHelp');
        break;
      case 'hud':
        safe('HUD', 'toggle');
        break;
      default:
        safe('Game', 'handleAction', [a]);
    }
  }
  RL.dispatchAction = dispatchAction;

  // ------------------------------------------------------------------ simulation step
  function stepWorld(dt, realDt) {
    var controls = getControls();
    var gs = gameState();
    var simDt = gs === 'paused' ? 0 : dt;
    worldTime += simDt;
    safe('Atmosphere', 'update', [realDt]);
    safe('Game', 'update', [simDt, controls]);
    var plane = getPlane();
    safe('Effects', 'update', [simDt, plane, controls, gameState()]);
    safe('Particles', 'update', [simDt]);
    safe('Sky', 'update', [simDt]);
    safe('Airfield', 'update', [simDt]);
    safe('Water', 'update', [simDt]);
    safe('Rings', 'animate', [simDt]);
    safe('CameraRig', 'update', [realDt, plane, RL.Input || null, gameState()]);
  }

  // ------------------------------------------------------------------ frame building
  var tmpV = v3.create();
  function buildFrame(dt) {
    var cam = RL.CameraRig;
    var mode = cam && cam.mode ? cam.mode : 'chase';
    frame.time = worldTime;
    frame.realTime = realTime;
    frame.dt = dt;
    frame.pixelRatio = dpr;
    frame.resolution[0] = width; frame.resolution[1] = height;
    frame.aspect = width / height;
    frame.cameraMode = mode;
    frame.gameState = gameState();
    frame.fov = (cam && cam.fov) || C.render.fovDeg * M.DEG;
    frame.near = (cam && cam.near) || (mode === 'cockpit' ? C.render.nearCockpit : C.render.near);
    frame.far = (cam && cam.far) || C.render.far;

    var dc = RL.debug.camera;
    if (dc && dc.pos && dc.target) {
      // test override: RL.debug.camera = { pos: [x,y,z], target: [x,y,z], fovDeg? }
      v3.copy(frame.camPos, dc.pos);
      m4.lookAt(frame.view, frame.camPos, dc.target, [0, 1, 0]);
      if (dc.fovDeg) frame.fov = dc.fovDeg * M.DEG;
    } else if (cam && cam.view) {
      m4.copy(frame.view, cam.view);
      v3.copy(frame.camPos, cam.position);
    } else {
      // fallback camera: look at the aircraft (or the runway) from behind
      var p = getPlane();
      var target = p ? p.pos : [0, C.airfield.elevation, 0];
      v3.set(frame.camPos, target[0], target[1] + 6, target[2] + 22);
      m4.lookAt(frame.view, frame.camPos, target, [0, 1, 0]);
    }
    m4.perspective(frame.proj, frame.fov, frame.aspect, frame.near, frame.far);
    m4.multiply(frame.viewProj, frame.proj, frame.view);
    m4.invert(frame.invViewProj, frame.viewProj);
    frame.camForward[0] = -frame.view[2]; frame.camForward[1] = -frame.view[6]; frame.camForward[2] = -frame.view[10];

    var ap = RL.Atmosphere && RL.Atmosphere.params;
    if (ap) {
      frame.sunDir = ap.sunDir; frame.sunColor = ap.sunColor;
      frame.ambientSky = ap.ambientSky; frame.ambientGround = ap.ambientGround;
      frame.skyZenith = ap.skyZenith; frame.skyHorizon = ap.skyHorizon;
      frame.fogColor = ap.fogColor; frame.fogDensity = ap.fogDensity;
      frame.fogHeightFalloff = ap.fogHeightFalloff;
      frame.nightFactor = ap.nightFactor; frame.exposure = ap.exposure;
    }

    frame.spotIntensity = 0;
    var plane = getPlane();
    if (plane && frame.nightFactor > 0.05) {
      var L = safe('Aircraft', 'getLandingLight', [plane, frame.nightFactor]);
      if (L && L.intensity > 0) {
        v3.copy(frame.spotPos, L.pos);
        v3.copy(frame.spotDir, L.dir);
        frame.spotIntensity = L.intensity;
      }
    }
  }

  // ------------------------------------------------------------------ rendering
  function render() {
    var G = RL.GL;
    var plane = getPlane();
    G.resetState(gl);

    // Shadow pass (aircraft only). Shadow.render sets frame.shadow = {texture, matrix, enabled}.
    frame.shadow = null;
    if (plane && RL.Shadow && RL.debug.shadows !== false) {
      var casters = safe('Aircraft', 'getShadowCasters', [plane]);
      if (casters && casters.length) safe('Shadow', 'render', [frame, casters, plane.pos]);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    G.resetState(gl);
    G.bindShadowUnit(gl, frame);
    var fc = frame.fogColor;
    gl.clearColor(Math.pow(fc[0], 1 / 2.2), Math.pow(fc[1], 1 / 2.2), Math.pow(fc[2], 1 / 2.2), 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    var opts = {
      cockpit: frame.cameraMode === 'cockpit',
      crashed: gameState() === 'crashed',
      hidden: false
    };

    // Opaque
    safe('Sky', 'draw', [frame]); G.resetState(gl);
    safe('Terrain', 'draw', [frame]); G.resetState(gl);
    safe('Airfield', 'draw', [frame]); G.resetState(gl);
    if (plane) { safe('Aircraft', 'draw', [frame, plane, opts]); G.resetState(gl); }
    safe('Effects', 'draw', [frame]); G.resetState(gl);

    // Transparent / additive
    safe('Water', 'draw', [frame]); G.resetState(gl);
    safe('Rings', 'draw', [frame]); G.resetState(gl);
    safe('Sky', 'drawClouds', [frame]); G.resetState(gl);
    safe('Particles', 'draw', [frame]); G.resetState(gl);
    safe('Airfield', 'drawLights', [frame]); G.resetState(gl);
    if (plane) { safe('Aircraft', 'drawLights', [frame, plane, opts]); G.resetState(gl); }
  }

  // ------------------------------------------------------------------ loop
  function loop(now) {
    requestAnimationFrame(loop);
    var realDt = Math.min(Math.max((now - lastNow) / 1000, 0), 0.1);
    lastNow = now;
    realTime += realDt;
    fpsAccum += realDt; fpsFrames++;
    if (fpsAccum >= 0.5) { RL.fps = fpsFrames / fpsAccum; fpsAccum = 0; fpsFrames = 0; }

    resize();
    safe('Input', 'update', [realDt]);
    var actions = RL.Input && RL.Input.consumeActions ? (safe('Input', 'consumeActions') || []) : [];
    for (var i = 0; i < actions.length; i++) dispatchAction(actions[i]);

    if (!RL.debug.freeze) stepWorld(realDt, realDt);
    else safe('CameraRig', 'update', [realDt, getPlane(), RL.Input || null, gameState()]);

    buildFrame(realDt);
    render();
    safe('HUD', 'draw', [realDt]);
    safe('Audio', 'update', [realDt, getPlane(), getControls(), { state: gameState(), cameraMode: frame.cameraMode }]);
  }

  // ------------------------------------------------------------------ test / debug hooks
  RL.debug = {
    controls: null,      // object merged over RL.Input.controls (tests / autopilot)
    camera: null,        // { pos: [x,y,z], target: [x,y,z], fovDeg? } overrides the camera rig
    freeze: false,       // true: stop per-frame simulation (use simulate() instead)
    shadows: true,

    /** Run the simulation synchronously for `seconds` of game time (no rendering). */
    simulate: function (seconds, controls, dt) {
      dt = dt || 1 / 60;
      var prev = RL.debug.controls;
      if (controls) RL.debug.controls = controls;
      var n = Math.ceil(seconds / dt);
      for (var i = 0; i < n; i++) stepWorld(dt, dt);
      RL.debug.controls = prev;
      return RL.debug.state();
    },

    /** Compact snapshot of the aircraft + game for assertions. */
    state: function () {
      var p = getPlane();
      if (!p) return { state: gameState() };
      var hpr = RL.quat.toHeadingPitchRoll(p.quat);
      return {
        state: gameState(),
        pos: [p.pos[0], p.pos[1], p.pos[2]],
        vel: [p.vel[0], p.vel[1], p.vel[2]],
        airspeed: p.airspeed, onGround: p.onGround, crashed: p.crashed, crashReason: p.crashReason,
        agl: p.agl, throttle: p.throttle, gearDown: p.gearDown, flaps: p.flaps, stall: p.stall,
        heading: hpr.heading * M.RAD, pitch: hpr.pitch * M.RAD, roll: hpr.roll * M.RAD,
        ring: RL.Rings ? RL.Rings.current : -1,
        score: RL.Game ? RL.Game.score : 0
      };
    },

    /** Place the aircraft in the air: teleport(x, y, z, headingDeg, speed). */
    teleport: function (x, y, z, heading, speed) {
      if (RL.Game && RL.Game.state !== 'playing' && RL.Game.start) RL.Game.start();
      var p = getPlane();
      if (!p || !RL.FlightModel) return false;
      RL.FlightModel.reset(p, { x: x, y: y, z: z, heading: heading || 0, speed: speed || 55, onGround: false });
      return true;
    },

    errors: function () { return RL.errors.slice(); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window.RL = window.RL || {});
