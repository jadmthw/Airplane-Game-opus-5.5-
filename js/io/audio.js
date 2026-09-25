/*
 * Ridgeline — RL.Audio: every sound in the game, synthesized live with WebAudio (no files).
 *
 *   init(), unlock(), update(dt, plane, controls, {state, cameraMode}), toggleMute() -> muted,
 *   muted, ready, getContext()
 *
 * Graph:
 *   engine (pulse + sub + harmonic oscillators, exhaust noise, soft saturation, load-dependent
 *   tone filter, amplitude-modulated at the prop's blade-pass rate) + prop "wop" noise
 *     -> view filter (cockpit muffled / outside bright / distance air absorption) -> panner
 *   wind rush + canopy whistle, ground rumble + tyre hiss, stall horn, smoke hiss
 *   all of the above -> worldBus (ducked when paused)  -> compressor -> master -> out
 *   chimes / jingles / blips -> uiBus (not ducked)     ->
 *   crashes, chimes and the engine also feed a small "valley" reverb with a mountain slap echo.
 *
 * The AudioContext is created only in unlock() (on the first user gesture). Every parameter
 * change is ramped with setTargetAtTime so nothing clicks. With ?noaudio nothing is created.
 */
(function (RL) {
  'use strict';
  var M = RL.M, v3 = RL.v3;

  var STORE_KEY = 'ridgeline.audio.muted';
  var MASTER = 0.8;
  var SOUND_C = 343;

  var ctx = null, disabled = false, subscribed = false;
  var N = {};                      // graph nodes
  var whiteBuf = null, brownBuf = null, pulseWave = null;
  var lastFeatureSfx = -10, lastBlip = -10;
  var surfaceTimer = 0, surfaceKind = 'runway';
  var gearWarnTimer = 0, overspeedTimer = 0;
  var camPrev = v3.create(), camVel = v3.create(), haveCamPrev = false;
  var dopplerS = 1, lastState = '', pausedDuck = false;
  var tmpA = v3.create();

  var Sound = {
    muted: false,
    ready: false,
    init: init,
    unlock: unlock,
    update: update,
    toggleMute: toggleMute,
    getContext: function () { return ctx; }
  };

  function fin(x, d) { return (typeof x === 'number' && isFinite(x)) ? x : d; }
  function noAudio() { return !!(RL.Params && RL.Params.noaudio); }

  // ------------------------------------------------------------------ init / unlock
  function init() {
    try {
      var s = window.localStorage && window.localStorage.getItem(STORE_KEY);
      Sound.muted = s === '1';
    } catch (e) { /* storage blocked */ }
    if (noAudio()) { disabled = true; return; }
    if (!subscribed && RL.Events) {
      subscribed = true;
      subscribe();
    }
    // Belt and braces: any later gesture also (re)unlocks — e.g. after the OS suspended audio.
    var again = function () { if (!ctx || ctx.state === 'suspended') unlock(); };
    window.addEventListener('pointerdown', again, true);
    window.addEventListener('keydown', again, true);
    document.addEventListener('visibilitychange', function () {
      if (!ctx) return;
      try {
        if (document.hidden) { var p = ctx.suspend(); if (p && p.catch) p.catch(noop); }
        else { var r = ctx.resume(); if (r && r.catch) r.catch(noop); }
      } catch (e) { /* ignore */ }
    });
  }

  function noop() {}

  function unlock() {
    if (disabled || noAudio()) return false;
    try {
      if (!ctx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) { disabled = true; return false; }
        ctx = new AC({ latencyHint: 'interactive' });
        build();
        Sound.ready = true;
      }
      if (ctx.state === 'suspended') {
        var p = ctx.resume();
        if (p && p.catch) p.catch(noop);
      }
    } catch (e) {
      console.warn('[RL.Audio] audio unavailable:', e && e.message);
      try { if (ctx) ctx.close(); } catch (e2) { /* ignore */ }
      ctx = null; disabled = true; Sound.ready = false;
      return false;
    }
    return true;
  }

  function toggleMute() {
    Sound.muted = !Sound.muted;
    try { if (window.localStorage) window.localStorage.setItem(STORE_KEY, Sound.muted ? '1' : '0'); } catch (e) { /* ignore */ }
    if (ctx && N.master) {
      N.master.gain.cancelScheduledValues(ctx.currentTime);
      N.master.gain.setTargetAtTime(Sound.muted ? 0 : MASTER, ctx.currentTime, 0.06);
    }
    return Sound.muted;
  }

  // ------------------------------------------------------------------ graph construction
  function gain(v, dest) {
    var g = ctx.createGain();
    g.gain.value = v;
    if (dest) g.connect(dest);
    return g;
  }
  function filter(type, freq, q, dest) {
    var f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    if (dest) f.connect(dest);
    return f;
  }
  function osc(type, freq, dest) {
    var o = ctx.createOscillator();
    if (type === 'pulse') o.setPeriodicWave(pulseWave); else o.type = type;
    o.frequency.value = freq;
    if (dest) o.connect(dest);
    o.start();
    return o;
  }
  function loopNoise(buf, dest, offset) {
    var s = ctx.createBufferSource();
    s.buffer = buf; s.loop = true;
    if (dest) s.connect(dest);
    s.start(0, offset || 0);
    return s;
  }

  function makeBuffers() {
    var sr = ctx.sampleRate, len = Math.floor(sr * 2.3), i;
    whiteBuf = ctx.createBuffer(1, len, sr);
    var w = whiteBuf.getChannelData(0);
    for (i = 0; i < len; i++) w[i] = Math.random() * 2 - 1;
    brownBuf = ctx.createBuffer(1, len, sr);
    var b = brownBuf.getChannelData(0), last = 0;
    for (i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; b[i] = last * 3.5; }
    // make the brown loop seamless: fade the ends into each other
    var fade = Math.floor(sr * 0.05);
    for (i = 0; i < fade; i++) { var t = i / fade; b[len - fade + i] = b[len - fade + i] * (1 - t) + b[i] * t; }

    // narrow-ish pulse (28 % duty): buzzy piston-engine fundamental
    var H = 48, re = new Float32Array(H), im = new Float32Array(H), d = 0.28;
    for (var n = 1; n < H; n++) re[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * d) * Math.pow(0.97, n);
    pulseWave = ctx.createPeriodicWave(re, im);
  }

  function makeReverb() {
    var sr = ctx.sampleRate, len = Math.floor(sr * 2.0);
    var ir = ctx.createBuffer(2, len, sr);
    for (var c = 0; c < 2; c++) {
      var ch = ir.getChannelData(c);
      for (var i = 0; i < len; i++) {
        var t = i / sr;
        var tail = Math.exp(-t * 3.4) * (Math.random() * 2 - 1) * 0.5;
        // a soft slap-back off the valley walls ~0.33 s later
        var echoT = t - (0.33 + c * 0.02);
        var echo = echoT > 0 ? Math.exp(-echoT * 16) * (Math.random() * 2 - 1) * 0.35 : 0;
        ch[i] = t < 0.012 ? 0 : tail + echo;
      }
    }
    var conv = ctx.createConvolver();
    conv.buffer = ir;
    return conv;
  }

  function build() {
    makeBuffers();
    var now = ctx.currentTime;

    N.master = gain(0, ctx.destination);
    N.master.gain.setTargetAtTime(Sound.muted ? 0 : MASTER, now, 0.3);   // gentle fade-in
    N.comp = ctx.createDynamicsCompressor();
    N.comp.threshold.value = -16; N.comp.knee.value = 12; N.comp.ratio.value = 4;
    N.comp.attack.value = 0.004; N.comp.release.value = 0.22;
    N.comp.connect(N.master);
    N.worldBus = gain(1, N.comp);
    N.uiBus = gain(0.9, N.comp);
    N.reverb = makeReverb();
    N.reverbOut = gain(0.32, N.comp);
    N.reverb.connect(N.reverbOut);
    N.reverbSend = gain(1, N.reverb);

    // ---------------- engine
    N.panner = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
    N.panner.connect(N.worldBus);
    N.viewLP = filter('lowpass', 8000, 0.5, N.panner);
    N.engVol = gain(0, N.viewLP);
    N.engRev = gain(0.08, N.reverbSend);
    N.engVol.connect(N.engRev);
    N.engAM = gain(0.8, N.engVol);
    N.engTone = filter('lowpass', 900, 0.9, N.engAM);
    N.engShaper = ctx.createWaveShaper();
    var curve = new Float32Array(1024);
    for (var i = 0; i < 1024; i++) { var x = i / 511.5 - 1; curve[i] = Math.tanh(x * 1.8) / Math.tanh(1.8); }
    N.engShaper.curve = curve;
    N.engShaper.connect(N.engTone);
    N.engMix = gain(0.55, N.engShaper);
    N.gMain = gain(0.55, N.engMix);
    N.gSub = gain(0.32, N.engMix);
    N.gHi = gain(0.09, N.engMix);
    N.oMain = osc('pulse', 40, N.gMain);
    N.oSub = osc('sawtooth', 20, N.gSub);
    N.oHi = osc('sawtooth', 80, N.gHi);
    N.noise = loopNoise(whiteBuf, null, 0);   // one source feeds several filters below
    N.exhBP = filter('bandpass', 300, 1.1, null);
    N.gExh = gain(0.1, N.engMix);
    N.exhBP.connect(N.gExh);
    N.noise.connect(N.exhBP);
    // blade-pass throb: an LFO modulating the engine amplitude and the prop "wop" noise
    N.lfo = osc('sine', 20, null);
    N.lfoDepth = gain(0.15, N.engAM.gain);
    N.lfo.connect(N.lfoDepth);
    N.propBP = filter('bandpass', 850, 0.7, null);
    N.propAM = gain(0.5, null);
    N.propVol = gain(0, N.viewLP);
    N.noise.connect(N.propBP);
    N.propBP.connect(N.propAM);
    N.propAM.connect(N.propVol);
    N.lfoProp = gain(0.45, N.propAM.gain);
    N.lfo.connect(N.lfoProp);

    // ---------------- wind + canopy whistle
    N.windLP = filter('lowpass', 9000, 0.4, N.worldBus);
    N.windBP = filter('bandpass', 400, 0.5, null);
    N.windVol = gain(0, N.windLP);
    N.windBP.connect(N.windVol);
    N.whistleBP = filter('bandpass', 1500, 9, null);
    N.whistleVol = gain(0, N.windLP);
    N.whistleBP.connect(N.whistleVol);
    N.noise2 = loopNoise(whiteBuf, N.windBP, 1.1);   // decorrelated from the engine noise
    N.noise2.connect(N.whistleBP);

    // ---------------- ground roll
    N.rumbleVol = gain(0, N.worldBus);
    N.brownLP = filter('lowpass', 150, 0.8, N.rumbleVol);
    N.brown = loopNoise(brownBuf, N.brownLP, 0);
    N.tireBP = filter('bandpass', 700, 1.4, null);
    N.tireVol = gain(0, N.worldBus);
    N.tireBP.connect(N.tireVol);
    N.noise.connect(N.tireBP);

    // ---------------- stall horn (two detuned reeds)
    N.hornBP = filter('bandpass', 1050, 2.2, null);
    N.hornVol = gain(0, N.worldBus);
    N.hornBP.connect(N.hornVol);
    N.horn1 = osc('square', 432, N.hornBP);
    N.horn2 = osc('square', 438, N.hornBP);

    // ---------------- smoke hiss
    N.smokeHP = filter('highpass', 2600, 0.6, null);
    N.smokeVol = gain(0, N.worldBus);
    N.smokeHP.connect(N.smokeVol);
    N.noise2.connect(N.smokeHP);
  }

  // Ramp an AudioParam towards v (skipping negligible changes so the timeline stays short).
  function setP(param, v, tc) {
    if (typeof v !== 'number' || !isFinite(v)) return;
    var last = param._rlLast;
    if (last !== undefined && Math.abs(last - v) <= Math.abs(v) * 0.003 + 1e-5) return;
    param._rlLast = v;
    param.setTargetAtTime(v, ctx.currentTime, tc);
  }

  // ------------------------------------------------------------------ one-shot helpers
  function envelope(g, t0, attack, peak, dur) {
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + attack);
    g.gain.setTargetAtTime(0, t0 + attack, Math.max(0.01, (dur - attack) / 4));
  }

  /** Short tone: {f, f2 (glide to), type, t (delay s), dur, g (peak), a (attack), dest, rev} */
  function tone(o) {
    var t0 = ctx.currentTime + 0.005 + (o.t || 0), dur = o.dur || 0.3;
    var g = gain(0, o.dest || N.uiBus);
    if (o.rev) { var s = gain(o.rev, N.reverbSend); g.connect(s); }
    var src = ctx.createOscillator();
    if (o.type === 'pulse') src.setPeriodicWave(pulseWave); else src.type = o.type || 'sine';
    src.frequency.setValueAtTime(o.f, t0);
    if (o.f2) src.frequency.exponentialRampToValueAtTime(o.f2, t0 + dur);
    if (o.lp) { var f = filter('lowpass', o.lp, 0.7, g); src.connect(f); } else src.connect(g);
    envelope(g, t0, o.a || 0.005, o.g || 0.2, dur);
    src.start(t0);
    src.stop(t0 + dur * 1.6 + 0.1);
  }

  /** Filtered noise burst: {t, dur, g, type, f, f2, q, a, dest, rev, brown} */
  function noiseHit(o) {
    var t0 = ctx.currentTime + 0.005 + (o.t || 0), dur = o.dur || 0.2;
    var src = ctx.createBufferSource();
    src.buffer = o.brown ? brownBuf : whiteBuf;
    var f = filter(o.type || 'bandpass', o.f || 1000, o.q || 1, null);
    if (o.f2) {
      f.frequency.setValueAtTime(o.f, t0);
      f.frequency.exponentialRampToValueAtTime(o.f2, t0 + dur);
    }
    var g = gain(0, o.dest || N.worldBus);
    if (o.rev) { var s = gain(o.rev, N.reverbSend); g.connect(s); }
    src.connect(f); f.connect(g);
    envelope(g, t0, o.a || 0.004, o.g || 0.2, dur);
    src.start(t0, Math.random() * 1.5);
    src.stop(t0 + dur * 1.6 + 0.1);
  }

  function live() { return !!(ctx && N.master && ctx.state !== 'closed'); }
  function note(n) { return 440 * Math.pow(2, (n - 69) / 12); }   // MIDI note -> Hz

  function sparkle(t, count, base, gain0) {
    var pent = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21];
    for (var i = 0; i < count; i++) {
      tone({ f: note(base + pent[(Math.random() * pent.length) | 0]), t: t + i * 0.045, dur: 0.18,
        g: gain0 * (1 - i / (count + 2)), type: 'sine', rev: 0.5 });
    }
  }

  // ------------------------------------------------------------------ event sounds
  var PENTA = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, 26, 28, 31, 33, 36];

  function sfxRing(d) {
    var idx = Math.max(0, fin(d.index, 0) | 0);
    var n = 74 + PENTA[Math.min(idx, PENTA.length - 1)];         // climbs with each ring
    tone({ f: note(n), dur: 0.55, g: 0.2, type: 'sine', rev: 0.6 });
    tone({ f: note(n) * 2.756, dur: 0.18, g: 0.05, type: 'sine' });  // bell partial
    tone({ f: note(n + 7), t: 0.075, dur: 0.5, g: 0.13, type: 'triangle', rev: 0.6 });
    if (d.special) sparkle(0.14, 6, n + 5, 0.07);
  }

  function brass(n, t, dur, g) {
    tone({ f: note(n), t: t, dur: dur, g: g, type: 'sawtooth', lp: 1800, a: 0.03, rev: 0.4 });
    tone({ f: note(n) * 1.004, t: t, dur: dur, g: g * 0.6, type: 'sawtooth', lp: 1400, a: 0.04 });
  }

  function sfxCourseComplete(d) {
    var seq = [72, 76, 79, 84];
    for (var i = 0; i < seq.length; i++) brass(seq[i], i * 0.13, 0.22, 0.09);
    [72, 76, 79, 84].forEach(function (n) { brass(n, 0.55, 1.5, 0.06); });
    if (d && d.record) sparkle(0.6, 10, 88, 0.06);
    noiseHit({ t: 0.55, dur: 0.9, g: 0.25, type: 'lowpass', f: 180, brown: true, dest: N.uiBus, rev: 0.6 });
  }

  function sfxLanding(d) {
    var g = d && d.grade;
    if (g === 'perfect') {
      [79, 83, 86, 91].forEach(function (n, i) { tone({ f: note(n), t: i * 0.08, dur: 0.4, g: 0.12, type: 'triangle', rev: 0.5 }); });
      sparkle(0.35, 8, 91, 0.06);
    } else if (g === 'good') {
      [76, 79, 84].forEach(function (n, i) { tone({ f: note(n), t: i * 0.09, dur: 0.4, g: 0.12, type: 'triangle', rev: 0.4 }); });
    } else if (g === 'firm') {
      tone({ f: note(72), dur: 0.3, g: 0.1, type: 'triangle' });
      tone({ f: note(76), t: 0.12, dur: 0.35, g: 0.1, type: 'triangle' });
    } else {
      tone({ f: note(64), dur: 0.25, g: 0.09, type: 'square', lp: 1200 });
      tone({ f: note(60), t: 0.16, dur: 0.45, g: 0.09, type: 'square', lp: 1000 });
    }
  }

  function sfxTouchdown(d) {
    var vs = Math.abs(fin(d.verticalSpeed, 1));
    var soft = d.surface === 'grass' || d.surface === 'rough';
    var k = M.clamp(vs / 3, 0.15, 1.3);
    if (!soft) {
      noiseHit({ dur: 0.1 + 0.12 * k, g: 0.12 + 0.18 * k, f: 3200, f2: 1500, q: 3.5 });   // tyre chirp
      noiseHit({ t: 0.05, dur: 0.08 + 0.08 * k, g: 0.07 + 0.1 * k, f: 2800, f2: 1600, q: 3 });
    } else {
      noiseHit({ dur: 0.35, g: 0.15 + 0.15 * k, type: 'lowpass', f: 900, q: 0.6 });
    }
    tone({ f: 80, f2: 42, dur: 0.22, g: 0.12 + 0.25 * k, type: 'sine', dest: N.worldBus });
  }

  function sfxBounce() {
    tone({ f: 90, f2: 45, dur: 0.2, g: 0.28, type: 'sine', dest: N.worldBus });
    noiseHit({ dur: 0.12, g: 0.14, f: 2600, f2: 1400, q: 3 });
  }

  function sfxCrash() {
    noiseHit({ dur: 1.8, g: 0.9, type: 'lowpass', f: 2400, f2: 90, q: 0.7, rev: 0.9, a: 0.01 });
    noiseHit({ dur: 2.2, g: 0.6, type: 'lowpass', f: 300, f2: 60, q: 0.5, brown: true, rev: 0.5 });
    tone({ f: 58, f2: 26, dur: 1.4, g: 0.6, type: 'sine', dest: N.worldBus });
    for (var i = 0; i < 16; i++) {         // debris, crackle and tumbling metal
      var t = 0.08 + Math.pow(Math.random(), 1.6) * 2.2;
      noiseHit({ t: t, dur: 0.03 + Math.random() * 0.08, g: 0.04 + Math.random() * 0.12,
        f: 800 + Math.random() * 3500, q: 2 + Math.random() * 4, rev: 0.4 });
    }
    tone({ f: 340, f2: 120, t: 0.2, dur: 0.9, g: 0.03, type: 'sawtooth', lp: 900, dest: N.worldBus });
  }

  function motor(f0, f1, dur, g) {
    tone({ f: f0, f2: f1, dur: dur, g: g, type: 'sawtooth', lp: 700, a: 0.12, dest: N.worldBus });
    tone({ f: f0 * 2.01, f2: f1 * 2.01, dur: dur, g: g * 0.4, type: 'triangle', a: 0.12, dest: N.worldBus });
  }

  function sfxGear(d) {
    var down = !!(d && d.down);
    motor(down ? 150 : 170, down ? 185 : 210, 2.6, 0.035);
    // the gear locks: a solid clunk (down) or a softer thunk into the wells (up)
    tone({ t: 2.75, f: down ? 110 : 80, f2: 50, dur: 0.2, g: down ? 0.3 : 0.18, type: 'sine', dest: N.worldBus });
    noiseHit({ t: 2.75, dur: 0.06, g: down ? 0.18 : 0.1, type: 'lowpass', f: 1500, q: 0.7 });
  }

  function sfxFlaps() {
    motor(260, 300, 1.2, 0.028);
    noiseHit({ t: 1.2, dur: 0.05, g: 0.06, type: 'lowpass', f: 1200, q: 0.7 });
  }

  function sfxStunt() {
    noiseHit({ dur: 0.7, g: 0.2, f: 300, f2: 3200, q: 1.3, a: 0.25, dest: N.uiBus, rev: 0.4 });
    sparkle(0.25, 7, 86, 0.07);
  }

  function sfxMessage(d) {
    var t = ctx.currentTime;
    if (t - lastFeatureSfx < 0.35 || t - lastBlip < 0.12) return;   // don't double up on a chime
    lastBlip = t;
    if (d.kind === 'good') {
      tone({ f: 880, dur: 0.08, g: 0.08, type: 'sine' });
      tone({ f: 1320, t: 0.07, dur: 0.12, g: 0.08, type: 'sine' });
    } else if (d.kind === 'bad') {
      tone({ f: 330, dur: 0.12, g: 0.08, type: 'triangle' });
      tone({ f: 247, t: 0.11, dur: 0.2, g: 0.08, type: 'triangle' });
    }
  }

  function sfxPause(d) {
    var paused = !!(d && d.paused);
    tone({ f: paused ? 660 : 494, dur: 0.09, g: 0.06, type: 'sine' });
    tone({ f: paused ? 494 : 660, t: 0.08, dur: 0.14, g: 0.06, type: 'sine' });
    duck(paused);
  }

  function sfxRespawn() {
    noiseHit({ dur: 0.55, g: 0.12, f: 2400, f2: 400, q: 1.2, a: 0.2, dest: N.uiBus });
    tone({ f: note(79), t: 0.3, dur: 0.4, g: 0.07, type: 'triangle', rev: 0.4 });
  }

  function sfxCourseStart() {
    tone({ f: note(76), dur: 0.12, g: 0.08, type: 'triangle' });
    tone({ f: note(83), t: 0.12, dur: 0.25, g: 0.09, type: 'triangle', rev: 0.3 });
  }

  function duck(paused) {
    if (!live() || paused === pausedDuck) return;
    pausedDuck = paused;
    N.worldBus.gain.setTargetAtTime(paused ? 0.07 : 1, ctx.currentTime, paused ? 0.08 : 0.25);
  }

  function subscribe() {
    var E = RL.Events;
    function on(type, fn, feature) {
      E.on(type, function (d) {
        if (!live()) return;
        try {
          if (feature) lastFeatureSfx = ctx.currentTime;
          fn(d || {});
        } catch (e) { /* a sound must never break gameplay */ }
      });
    }
    E.on('userGesture', function () { unlock(); });
    on('ring', sfxRing, true);
    on('courseComplete', sfxCourseComplete, true);
    on('courseStart', sfxCourseStart, true);
    on('landing', sfxLanding, true);
    on('touchdown', sfxTouchdown, false);
    on('bounce', sfxBounce, false);
    on('crash', sfxCrash, true);
    on('gear', sfxGear, false);
    on('flaps', sfxFlaps, false);
    on('stunt', sfxStunt, true);
    on('message', sfxMessage, false);
    on('pause', sfxPause, false);
    on('respawn', sfxRespawn, true);
  }

  // ------------------------------------------------------------------ continuous update
  function update(dt, plane, controls, info) {
    if (!live()) return;
    dt = M.clamp(fin(dt, 0.016), 0.0001, 0.1);
    var state = (info && info.state) || 'title';
    var mode = (info && info.cameraMode) || 'chase';
    var cockpit = mode === 'cockpit';
    var chase = mode === 'chase';

    if (state !== lastState) { lastState = state; duck(state === 'paused'); }

    var alive = !!plane && !plane.crashed && state !== 'crashed';
    var title = state === 'title';
    var playing = state === 'playing';

    // ---- listener geometry (camera from the frame main.js just built)
    var cam = (RL.frame && RL.frame.camPos) || (RL.CameraRig && RL.CameraRig.position);
    var dist = 15, pan = 0, vr = 0;
    if (cam && plane && plane.pos) {
      if (haveCamPrev && v3.distSq(cam, camPrev) < 200 * 200) {
        v3.sub(tmpA, cam, camPrev);
        v3.scale(tmpA, tmpA, 1 / dt);
        v3.damp(camVel, camVel, tmpA, 8, dt);
      } else v3.set(camVel, 0, 0, 0);
      v3.copy(camPrev, cam); haveCamPrev = true;
      v3.sub(tmpA, cam, plane.pos);
      dist = v3.length(tmpA);
      if (dist > 0.5) {
        v3.scale(tmpA, tmpA, 1 / dist);
        if (playing && plane.vel && !cockpit && !chase) {   // chase/cockpit ride along: no doppler
          // closing speed between source and listener (+ = approaching)
          vr = (plane.vel[0] - camVel[0]) * tmpA[0] + (plane.vel[1] - camVel[1]) * tmpA[1] + (plane.vel[2] - camVel[2]) * tmpA[2];
        }
        var view = RL.frame && RL.frame.view;
        if (view && !cockpit && !chase) {
          // camera right axis = first row of the view matrix; the source is at -tmpA
          pan = -(view[0] * tmpA[0] + view[4] * tmpA[1] + view[8] * tmpA[2]) * 0.75;
        }
      }
    }
    dist = fin(dist, 15);
    var dop = SOUND_C / (SOUND_C - M.clamp(fin(vr, 0), -160, 160));
    dopplerS = M.damp(dopplerS, M.clamp(dop, 0.7, 1.45), 7, dt);
    var att = cockpit ? 1 : (dist <= 25 ? 1 : Math.max(0.012, 25 / (25 + (dist - 25) * 1.1)));
    var absorb = cockpit ? 1300 : Math.min(9500, 9500 / (1 + dist / 260));

    // ---- engine
    var rpm = alive ? M.clamp(fin(plane.rpm, 0.2), 0, 1.2) : 0;
    var thr = alive ? M.clamp(fin(plane.throttle, controls ? fin(controls.throttle, 0) : 0), 0, 1) : 0;
    var f0 = (26 + rpm * 64) * dopplerS;
    var load = thr * rpm;
    var engLevel = alive ? (0.17 + 0.3 * rpm + 0.12 * load) : 0;
    if (title) engLevel *= 0.45;
    engLevel *= cockpit ? 1.05 : att;
    setP(N.oMain.frequency, f0, 0.04);
    setP(N.oSub.frequency, f0 * 0.5, 0.04);
    setP(N.oHi.frequency, f0 * 2.003, 0.04);
    setP(N.lfo.frequency, f0 * 0.5, 0.04);
    setP(N.exhBP.frequency, 180 + f0 * 5, 0.05);
    setP(N.gExh.gain, 0.05 + 0.3 * load, 0.08);
    setP(N.engTone.frequency, (420 + 700 * rpm + 2600 * load) * Math.min(1.3, dopplerS), 0.06);
    var amDepth = cockpit ? 0.1 : chase ? 0.2 : 0.34;
    setP(N.lfoDepth.gain, amDepth, 0.1);
    setP(N.engAM.gain, 1 - amDepth, 0.1);
    setP(N.engVol.gain, engLevel, alive ? 0.06 : 0.03);
    // the prop's "wop-wop" is an outside-the-aircraft sound
    var propLevel = alive ? (cockpit ? 0.03 : chase ? 0.1 : 0.2) * (0.3 + rpm) * (cockpit ? 1 : att) : 0;
    if (title) propLevel *= 0.5;
    setP(N.propVol.gain, propLevel, 0.08);
    setP(N.propBP.frequency, (500 + rpm * 900) * dopplerS, 0.08);
    setP(N.viewLP.frequency, absorb, 0.08);
    if (N.panner.pan) setP(N.panner.pan, M.clamp(pan, -0.9, 0.9), 0.08);

    // ---- wind rush + whistle (heard around the camera/cockpit; far views hear little)
    var speed = plane ? Math.max(0, fin(plane.airspeed, 0)) : 0;
    if (!playing) speed = state === 'paused' ? speed : 0;
    var near = cockpit || chase ? 1 : mode === 'orbit' ? 0.6 : att * 0.5;
    var w = M.smoothstep(6, 95, speed);
    var buffet = plane && playing && !plane.onGround ? M.clamp(fin(plane.stallWarning, 0), 0, 1) : 0;
    var windLevel = w * w * 0.38 * near * (1 + buffet * (Math.random() * 0.9 - 0.2));
    if (state === 'crashed' || title) windLevel = 0;
    setP(N.windVol.gain, windLevel, 0.06);
    setP(N.windBP.frequency, 220 + speed * 15, 0.1);
    setP(N.whistleBP.frequency, 900 + speed * 17, 0.1);
    setP(N.whistleVol.gain, M.smoothstep(45, 100, speed) * (cockpit ? 0.05 : 0.025) * near * (title ? 0 : 1), 0.1);
    setP(N.windLP.frequency, cockpit ? 2400 : 9000, 0.1);

    // ---- ground roll: rumble + tyre hiss, rougher on grass
    var rumble = 0, tire = 0;
    if (alive && plane.onGround && playing) {
      surfaceTimer -= dt;
      if (surfaceTimer <= 0 && RL.World && RL.World.surfaceAt) {
        surfaceTimer = 0.2;
        surfaceKind = RL.World.surfaceAt(plane.pos[0], plane.pos[2]) || 'runway';
      }
      var gs = Math.max(0, fin(plane.groundSpeed, speed));
      var rough = surfaceKind === 'grass' || surfaceKind === 'rough';
      rumble = M.smoothstep(0.5, 30, gs) * (rough ? 0.6 : 0.32);
      tire = M.smoothstep(2, 40, gs) * (rough ? 0.03 : 0.08) * (1 + fin(plane.brake, 0) * 0.8);
      var gAtt = cockpit ? 1 : Math.min(1, att * 1.3);
      rumble *= gAtt; tire *= gAtt;
      setP(N.tireBP.frequency, 500 + gs * 9 + fin(plane.brake, 0) * 600, 0.1);
    }
    setP(N.rumbleVol.gain, rumble, 0.07);
    setP(N.tireVol.gain, tire, 0.07);

    // ---- stall horn
    var sw = alive && playing && !plane.onGround ? M.clamp(fin(plane.stallWarning, 0), 0, 1) : 0;
    // softer while the AoA protection is holding the wing (a hard pull, not a real stall)
    var hornScale = 1 - 0.6 * M.clamp(fin(plane.stallProtect, 0), 0, 1);
    setP(N.hornVol.gain, sw > 0.12 ? (0.035 + 0.05 * sw) * (cockpit ? 1.2 : 0.8) * hornScale : 0, 0.03);

    // ---- smoke hiss
    var smoking = alive && playing && !!(controls && controls.smoke);
    setP(N.smokeVol.gain, smoking ? (cockpit ? 0.012 : 0.03 * Math.min(1, att * 1.5)) : 0, 0.08);

    // ---- warnings: gear-up on approach, overspeed clacker
    if (alive && playing && !plane.onGround) {
      var agl = fin(plane.agl, 999);
      var gearWarn = !plane.gearDown && agl < 120 && speed < 42 && thr < 0.25;
      gearWarnTimer -= dt;
      if (gearWarn && gearWarnTimer <= 0) {
        gearWarnTimer = 1.1;
        tone({ f: 1000, dur: 0.1, g: 0.05, type: 'square', lp: 2200, dest: N.worldBus });
        tone({ f: 1000, t: 0.16, dur: 0.1, g: 0.05, type: 'square', lp: 2200, dest: N.worldBus });
      }
      var specs = RL.FlightModel && RL.FlightModel.specs;
      var vne = specs && specs.vNeverExceed ? specs.vNeverExceed : 999;
      overspeedTimer -= dt;
      if (speed > vne * 0.97 && overspeedTimer <= 0) {
        overspeedTimer = 0.14;
        noiseHit({ dur: 0.03, g: 0.08, type: 'highpass', f: 2500, q: 0.7 });
      }
    }
  }

  RL.Audio = Sound;
})(window.RL = window.RL || {});
