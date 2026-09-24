/*
 * Ridgeline — RL.Atmosphere: time-of-day lighting presets with smooth transitions.
 * RL.Atmosphere.params always holds the current (interpolated) values that main.js copies
 * into the frame object / standard shader uniforms. All colors are LINEAR.
 */
(function (RL) {
  'use strict';
  var M = RL.M, v3 = RL.v3;

  function sunDir(azDeg, elDeg) {
    var az = azDeg * M.DEG, el = elDeg * M.DEG;
    return [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
  }

  var PRESETS = {
    dawn: {
      label: 'Dawn',
      sunDir: sunDir(80, 7),
      sunColor: [2.7, 1.85, 1.2],
      ambientSky: [0.24, 0.26, 0.36],
      ambientGround: [0.09, 0.08, 0.08],
      skyZenith: [0.16, 0.24, 0.48],
      skyHorizon: [0.92, 0.68, 0.56],
      fogColor: [0.78, 0.66, 0.64],
      fogDensity: 3.2e-4,
      fogHeightFalloff: 1 / 320,
      nightFactor: 0.15,
      exposure: 1.1
    },
    day: {
      label: 'Midday',
      sunDir: sunDir(205, 44),
      sunColor: [3.1, 2.95, 2.7],
      ambientSky: [0.30, 0.40, 0.56],
      ambientGround: [0.12, 0.11, 0.09],
      skyZenith: [0.09, 0.25, 0.68],
      skyHorizon: [0.56, 0.69, 0.86],
      fogColor: [0.56, 0.66, 0.80],
      fogDensity: 1.5e-4,
      fogHeightFalloff: 1 / 900,
      nightFactor: 0.0,
      exposure: 1.0
    },
    sunset: {
      label: 'Sunset',
      sunDir: sunDir(282, 5),
      sunColor: [3.0, 1.55, 0.65],
      ambientSky: [0.22, 0.20, 0.30],
      ambientGround: [0.10, 0.07, 0.06],
      skyZenith: [0.11, 0.14, 0.36],
      skyHorizon: [0.98, 0.50, 0.28],
      fogColor: [0.72, 0.44, 0.34],
      fogDensity: 2.0e-4,
      fogHeightFalloff: 1 / 600,
      nightFactor: 0.3,
      exposure: 1.1
    },
    night: {
      label: 'Night',
      sunDir: sunDir(140, 38),          // the moon
      sunColor: [0.22, 0.27, 0.40],
      ambientSky: [0.028, 0.038, 0.075],
      ambientGround: [0.010, 0.010, 0.016],
      skyZenith: [0.004, 0.008, 0.026],
      skyHorizon: [0.022, 0.036, 0.075],
      fogColor: [0.020, 0.030, 0.055],
      fogDensity: 1.3e-4,
      fogHeightFalloff: 1 / 700,
      nightFactor: 1.0,
      exposure: 1.7
    }
  };
  var ORDER = ['day', 'sunset', 'night', 'dawn'];

  function clonePreset(p) {
    var o = {};
    for (var k in p) o[k] = Array.isArray(p[k]) ? p[k].slice() : p[k];
    return o;
  }

  var Atmosphere = {
    PRESETS: PRESETS,
    ORDER: ORDER,
    name: 'day',
    params: null,
    _from: null,
    _to: null,
    _t: 1,
    _duration: 3.5,

    init: function () {
      var start = (RL.Params && RL.Params.time && PRESETS[RL.Params.time]) ? RL.Params.time : 'day';
      Atmosphere.name = start;
      Atmosphere.params = clonePreset(PRESETS[start]);
      Atmosphere.params.name = start;
      Atmosphere._t = 1;
    },

    /** Jump or transition to a preset by name. */
    set: function (name, instant) {
      if (!PRESETS[name]) return;
      Atmosphere.name = name;
      if (instant) {
        Atmosphere.params = clonePreset(PRESETS[name]);
        Atmosphere.params.name = name;
        Atmosphere._t = 1;
      } else {
        Atmosphere._from = clonePreset(Atmosphere.params);
        Atmosphere._to = PRESETS[name];
        Atmosphere._t = 0;
      }
      if (RL.Events) RL.Events.emit('timeOfDay', { name: name, label: PRESETS[name].label });
    },

    /** Advance to the next preset; returns its label. */
    cycle: function () {
      var i = ORDER.indexOf(Atmosphere.name);
      var next = ORDER[(i + 1) % ORDER.length];
      Atmosphere.set(next);
      return PRESETS[next].label;
    },

    update: function (dt) {
      if (Atmosphere._t >= 1 || !Atmosphere._to) return;
      Atmosphere._t = Math.min(1, Atmosphere._t + dt / Atmosphere._duration);
      var t = M.smoothstep(0, 1, Atmosphere._t);
      var a = Atmosphere._from, b = Atmosphere._to, p = Atmosphere.params;
      for (var k in b) {
        if (k === 'label') continue;
        if (Array.isArray(b[k])) {
          for (var i = 0; i < b[k].length; i++) p[k][i] = M.lerp(a[k][i], b[k][i], t);
        } else if (k === 'fogHeightFalloff' || k === 'fogDensity') {
          p[k] = Math.exp(M.lerp(Math.log(a[k]), Math.log(b[k]), t)); // log-space for smoothness
        } else {
          p[k] = M.lerp(a[k], b[k], t);
        }
      }
      v3.normalize(p.sunDir, p.sunDir);
      p.name = Atmosphere.name;
      p.label = b.label;
    }
  };

  RL.Atmosphere = Atmosphere;
})(window.RL = window.RL || {});
