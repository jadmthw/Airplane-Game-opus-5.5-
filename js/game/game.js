/*
 * Ridgeline — RL.Game: game flow, rules and scoring.
 *
 *   init(), start(), handleAction(name), update(dt, controls)
 *   state 'title' | 'playing' | 'paused' | 'crashed', plane, score
 *
 * Flow: title (plane parked, attract camera) -> playing <-> paused; playing -> crashed ->
 * (R / click) playing. Physics runs in fixed 1/120 s substeps with an accumulator; raw flight
 * model events are translated into bus events (see ARCHITECTURE.md) and drive the course
 * (ring timer, splits vs. best, medals), stunt detection, landing grades, tutorial hints and the
 * warning flags the HUD shows. Everything the HUD / UI need is exposed as plain fields that are
 * updated in place (no per-frame allocation).
 */
(function (RL) {
  'use strict';
  var M = RL.M, v3 = RL.v3, C = RL.Config;
  var KT = C.units.knots;
  var STORE_KEY = 'ridgeline.game.v1';

  // ------------------------------------------------------------------ tuning
  var RESPAWN_DELAY = 1.5;          // s after a crash before the respawn prompt shows
  var COMBO_WINDOW = 12;            // s between scoring moves to keep a combo alive
  var BOUNDS_RESPAWN = 1500;        // m past the edge of the map before we bring the player home
  var RING_POINTS = { normal: 100, arch: 400, lake: 300, final: 250 };
  var BULLSEYE_FRAC = 0.35;         // pass within 35 % of the ring radius -> bullseye bonus
  var BULLSEYE_POINTS = 50;
  var LANDING_POINTS = { perfect: 1000, good: 500, firm: 200, hard: 50 };
  var LANDING_LABEL = { perfect: 'Butter!', good: 'Smooth landing', firm: 'Firm landing', hard: 'Hard landing' };
  var GRADE_ORDER = ['perfect', 'good', 'firm', 'hard'];
  var STUNT_POINTS = {
    barrelRoll: 150, loop: 250, inverted: 200, knifeEdge: 200, lowPass: 300,
    arch: 500, canyon: 600, thermal: 250, lakeSkim: 300
  };
  var STUNT_NAMES = {
    barrelRoll: 'Barrel roll', loop: 'Loop the loop', inverted: 'Inverted flight',
    knifeEdge: 'Knife edge', lowPass: 'Low pass', arch: 'Thread the needle',
    canyon: 'Canyon run', thermal: 'Thermal rider', lakeSkim: 'Lake skim'
  };
  var STUNT_COOLDOWN = {
    barrelRoll: 1.5, loop: 3, inverted: 15, knifeEdge: 15, lowPass: 20,
    arch: 20, canyon: 40, thermal: 40, lakeSkim: 25
  };

  var CRASH_TEXT = {
    terrain: ['You met the mountain', 'Watch the PULL UP cue: it looks a few seconds ahead of you.'],
    groundHit: ['Flew into the ground', 'Watch the PULL UP cue: it looks a few seconds ahead of you.'],
    climbStall: ['Stalled on climb-out', 'Too much nose-up: hold about 10 degrees and let the speed build before climbing harder.'],
    water: ['Splashdown', 'Mirror Lake is for skimming, not swimming. Keep 5 m over the water.'],
    building: ['Hangar rash', 'Buildings are harder than they look. Taxi on the paved areas.'],
    arch: ['The arch won', 'Aim for the violet ring: it marks the widest part of the opening.'],
    hardLanding: ['Gear collapsed', 'Flare: ease back just above the runway to keep the sink under 300 fpm.'],
    wingStrike: ['Wingtip strike', 'Keep the wings level in the last few metres before touchdown.'],
    bellyLanding: ['Belly landing', 'Forgot something? Gear down with G before you land.'],
    noseStrike: ['Prop strike', 'Touch down on the main wheels: hold the nose up a little in the flare.'],
    rough: ['Ran off into the rough', 'Slow down before leaving the pavement or grass strip.'],
    bounds: ['Lost beyond the ridges', 'Stay inside the valley. The minimap shows the way home.'],
    tail: ['Tail strike', 'Do not over-rotate: 8 to 10 degrees nose up is plenty.'],
    belly: ['Belly scrape', 'Gear down with G before you land.']
  };
  var FLAP_LABELS = ['Flaps up', 'Flaps 1: takeoff', 'Flaps 2: landing'];

  // ------------------------------------------------------------------ scratch (no garbage)
  var prevPos = v3.create(), prevVel = v3.create(), framePrev = v3.create();
  var tA = v3.create();
  var PARK = { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 1, smoke: false };
  // rotation history sampled every 0.1 s: 6 s window for rolls, 14 s for loops
  var ROLL_SAMPLES = 150, ROLL_WINDOW = 60, LOOP_WINDOW = 140;
  var rollBuf = new Float32Array(ROLL_SAMPLES), pitchBuf = new Float32Array(ROLL_SAMPLES);
  // per-sample extremes, so a loop must really go over the top (a steep turn also piles up
  // body-axis pitch rotation, but never points the nose up or turns the aircraft over)
  var pitchMaxBuf = new Float32Array(ROLL_SAMPLES), upMinBuf = new Float32Array(ROLL_SAMPLES);

  // ------------------------------------------------------------------ helpers
  function emit(type, data) { if (RL.Events) RL.Events.emit(type, data); }
  function fin(x, d) { return (typeof x === 'number' && isFinite(x)) ? x : d; }
  function message(text, kind, duration) {
    emit('message', { text: text, kind: kind || 'info', duration: duration || 2.2 });
  }
  function copy3(a) { return [fin(a[0], 0), fin(a[1], 0), fin(a[2], 0)]; }
  function rings() { return RL.Rings && RL.Rings.list ? RL.Rings : null; }
  function world() { return RL.World; }

  function load() {
    try {
      var s = window.localStorage && window.localStorage.getItem(STORE_KEY);
      if (!s) return;
      var o = JSON.parse(s) || {};
      Game.best.time = fin(o.bestTime, 0) > 0 ? o.bestTime : null;
      Game.best.score = Math.max(0, Math.round(fin(o.bestScore, 0)));
      Game.best.landing = typeof o.bestLanding === 'string' ? o.bestLanding : null;
      Game.best.splits = Array.isArray(o.bestSplits) ? o.bestSplits.map(function (x) { return fin(x, 0); }) : null;
      tutorialDone = !!o.tutorialDone;
    } catch (e) { /* private mode / corrupt data: start fresh */ }
  }

  function save() {
    try {
      if (!window.localStorage) return;
      window.localStorage.setItem(STORE_KEY, JSON.stringify({
        bestTime: Game.best.time, bestScore: Game.best.score, bestLanding: Game.best.landing,
        bestSplits: Game.best.splits, tutorialDone: tutorialDone
      }));
    } catch (e) { /* storage full or blocked: records just are not persisted */ }
  }

  function formatTime(t) {
    if (!(t >= 0)) return '--:--.-';
    // round once to tenths, then split, so 59.97 s carries into the minutes ('1:00.0')
    var d = Math.round(t * 10), m = Math.floor(d / 600), s = (d - m * 600) / 10;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  }

  // ------------------------------------------------------------------ state
  var acc = 0;                        // physics accumulator
  var lastPlaneTime = 0;              // detects external resets (debug teleport)
  var tutorialDone = false;
  var pendingTD = null;               // touchdown awaiting its landing grade
  var comboTimer = 0;
  var cooldown = {};
  var boundsWarned = false;
  var st = null;                      // stunt trackers (reset per flight)
  var canyonSeg = null, canyonLen = 0;
  var flightStartBest = 0;           // best score when this flight began (for 'new record')

  var Game = {
    state: 'title',
    plane: null,
    score: 0,
    flightTime: 0,
    course: {
      state: 'ready',                 // 'ready' (before ring 1) | 'running' | 'done'
      time: 0, ringsPassed: 0, total: 0,
      lastSplit: null,                // {index, time, delta (vs best, s) | null}
      length: 0, par: { gold: 0, silver: 0, bronze: 0 }, medal: null
    },
    best: { time: null, score: 0, landing: null, splits: null },
    combo: { count: 0, mult: 1, timer: 0 },
    popups: [],                       // [{active, text, sub, points, kind, age, life}]
    hint: { text: '', age: 0, id: '' },
    warnings: { stall: false, pullUp: false, overspeed: false, gear: false, bounds: false, boundsDist: 0 },
    crash: { reason: '', label: '', tip: '', t: 0, ready: false },
    lastLanding: null,               // {grade, label, points, fpm, offset, heading, bounced, age}
    stunts: [],                       // names of stunts flown this course
    results: null,                    // set when the course ends with a full-stop landing
    formatTime: formatTime,
    STUNT_NAMES: STUNT_NAMES,

    init: init,
    start: start,
    handleAction: handleAction,
    update: update,
    respawn: respawn,
    dismissResults: dismissResults,
    gradeLanding: gradeLanding
  };
  for (var pi = 0; pi < 6; pi++) {
    Game.popups.push({ active: false, text: '', sub: '', points: 0, kind: 'good', age: 0, life: 2.6 });
  }

  // ------------------------------------------------------------------ lifecycle
  function init() {
    load();
    buildCanyon();
    computePar();
    if (RL.FlightModel) {
      Game.plane = RL.FlightModel.create();
      RL.FlightModel.reset(Game.plane, C.spawn);
      lastPlaneTime = 0;
    }
    resetFlight();
    Game.state = 'title';
    if (RL.Params && RL.Params.autostart) start();
  }

  /** Begin play from the title screen (or restart everything). */
  function start() {
    resetFlight();
    if (Game.plane && RL.FlightModel) RL.FlightModel.reset(Game.plane, C.spawn);
    lastPlaneTime = 0;
    if (RL.Input && RL.Input.setThrottle) RL.Input.setThrottle(0);
    Game.state = 'playing';
    closeHelp();
    emit('gameStart', {});
  }

  /** Put the aircraft back on the runway and restart the course. */
  function respawn(reason) {
    var was = Game.state;
    maybeSaveBestScore();
    resetFlight();
    if (Game.plane && RL.FlightModel) RL.FlightModel.reset(Game.plane, C.spawn);
    lastPlaneTime = 0;
    if (RL.Input && RL.Input.setThrottle) RL.Input.setThrottle(0);
    Game.state = 'playing';
    closeHelp();
    emit('respawn', {});
    if (reason === 'bounds') message('Too far from home: back at Ridgeline Field', 'warn', 3);
    if (was === 'paused' && RL.Input && RL.Input.requestPointerLock) RL.Input.requestPointerLock();
  }

  // Starting or respawning must never leave the help overlay over live flight. Called after the
  // state is already 'playing', so toggleHelp only closes the panel (no pause/resume side effects).
  function closeHelp() {
    if (RL.UI && RL.UI.helpOpen && RL.UI.toggleHelp) RL.UI.toggleHelp();
  }

  function resetFlight() {
    acc = 0;
    flightStartBest = Game.best.score;
    Game.score = 0;
    Game.flightTime = 0;
    Game.stunts.length = 0;
    Game.results = null;
    Game.lastLanding = null;
    var c = Game.course;
    c.state = 'ready'; c.time = 0; c.ringsPassed = 0; c.lastSplit = null; c.medal = null;
    c.splits = [];
    var R = rings();
    if (R && R.reset) R.reset();
    c.total = R ? (R.total || R.list.length) : 0;
    Game.combo.count = 0; Game.combo.mult = 1; Game.combo.timer = 0; comboTimer = 0;
    for (var i = 0; i < Game.popups.length; i++) Game.popups[i].active = false;
    Game.crash.reason = ''; Game.crash.label = ''; Game.crash.tip = ''; Game.crash.t = 0; Game.crash.ready = false;
    var w = Game.warnings;
    w.stall = w.pullUp = w.overspeed = w.gear = w.bounds = false; w.boundsDist = 0;
    pendingTD = null;
    boundsWarned = false;
    cooldown = {};
    resetTrackers();
    resetHints();
  }

  function resetTrackers() {
    st = {
      rollCum: 0, pitchCum: 0, sampleT: 0, nSamples: 0, head: 0,
      inverted: 0, knife: 0, lakeSkim: 0,
      lowPassDist: 0, lowPassGearUp: true, lowPassGrace: 0, lowPassDone: false,
      canyon: { active: false, sMin: 0, sMax: 0, grace: 0, done: false },
      thermal: { inside: false, base: 0, grace: 0 },
      pullUpHold: 0,
      pitchMaxS: -90, upMinS: 1, prevHdg: Game.plane ? fin(Game.plane.heading, 0) : 0, hdgRate: 0,
      liftoffAt: -1e9,                  // far past: teleported approaches still get landing coaching
      stalledSinceLiftoff: false,
      landingHintShown: false, brakeHintShown: false, steerHintShown: false
    };
    if (Game.plane) v3.copy(framePrev, Game.plane.pos);
  }

  // ------------------------------------------------------------------ course geometry
  function computePar() {
    // Timed distance: ring 1 -> last ring along straight legs, flown at typical speeds.
    var r = C.rings, L = 0;
    for (var i = 1; i < r.length; i++) L += Math.hypot(r[i].x - r[i - 1].x, r[i].z - r[i - 1].z);
    var c = Game.course;
    c.length = L;
    function round5(t) { return Math.round(t / 5) * 5; }
    c.par.gold = round5(L / 66);
    c.par.silver = round5(L / 57);
    c.par.bronze = round5(L / 47);
  }

  function buildCanyon() {
    var p = C.canyon && C.canyon.path;
    canyonSeg = [];
    canyonLen = 0;
    if (!p || p.length < 2) return;
    for (var i = 0; i < p.length - 1; i++) {
      var dx = p[i + 1][0] - p[i][0], dz = p[i + 1][1] - p[i][1];
      var len = Math.hypot(dx, dz) || 1;
      canyonSeg.push({ x: p[i][0], z: p[i][1], dx: dx / len, dz: dz / len, len: len, s0: canyonLen });
      canyonLen += len;
    }
  }

  // Nearest point on the canyon polyline -> shared {dist, s (arc length), nx, nz (normal), qx, qz}.
  var canyonHit = { dist: 1e9, s: 0, nx: 0, nz: 0, qx: 0, qz: 0 };
  function canyonNearest(x, z) {
    var best = canyonHit;
    best.dist = 1e9;
    for (var i = 0; i < canyonSeg.length; i++) {
      var sg = canyonSeg[i];
      var t = M.clamp((x - sg.x) * sg.dx + (z - sg.z) * sg.dz, 0, sg.len);
      var qx = sg.x + sg.dx * t, qz = sg.z + sg.dz * t;
      var d = Math.hypot(x - qx, z - qz);
      if (d < best.dist) {
        best.dist = d; best.s = sg.s0 + t; best.qx = qx; best.qz = qz;
        best.nx = -sg.dz; best.nz = sg.dx;
      }
    }
    return best;
  }

  // ------------------------------------------------------------------ actions
  function handleAction(name) {
    var p = Game.plane, FM = RL.FlightModel, s = Game.state;
    switch (name) {
      case 'start':
        // Enter on the title with help open just closes help (the player was reading it)
        if (s === 'title') { if (RL.UI && RL.UI.helpOpen && RL.UI.toggleHelp) RL.UI.toggleHelp(); else start(); }
        else if (s === 'paused') setPaused(false);
        else if (s === 'crashed' && Game.crash.ready) respawn();
        else if (s === 'playing' && Game.results && !Game.results.dismissed) dismissResults();
        break;
      case 'pause':
        if (RL.UI && RL.UI.helpOpen && RL.UI.toggleHelp && s !== 'playing') { RL.UI.toggleHelp(); break; }
        if (s === 'playing') setPaused(true);
        else if (s === 'paused') setPaused(false);
        break;
      case 'reset':
        if (s === 'title') start();
        else respawn();
        break;
      case 'flaps':
        if (!p || !FM || s !== 'playing' || p.crashed) break;
        var notch = FM.cycleFlaps(p);
        emit('flaps', { notch: notch, label: FLAP_LABELS[notch] || ('Flaps ' + notch) });
        break;
      case 'gear':
        if (!p || !FM || s !== 'playing' || p.crashed) break;
        if (p.onGround) { message('Gear stays down on the ground', 'warn', 1.8); break; }
        if (FM.toggleGear(p)) {
          emit('gear', { down: p.gearDown });
          if (hintIs('gear') && !p.gearDown) completeHint('gear');
        }
        break;
      default:
        break;
    }
  }

  function setPaused(on) {
    if (on && Game.state === 'playing') {
      Game.state = 'paused';
      if (RL.Input && RL.Input.exitPointerLock) RL.Input.exitPointerLock();
      emit('pause', { paused: true });
    } else if (!on && Game.state === 'paused') {
      Game.state = 'playing';
      if (RL.UI && RL.UI.helpOpen && RL.UI.toggleHelp) RL.UI.toggleHelp();
      if (RL.Input && RL.Input.requestPointerLock && RL.Input.mouseFlight !== false) RL.Input.requestPointerLock();
      emit('pause', { paused: false });
    }
  }
  Game.setPaused = setPaused;

  function dismissResults() {
    if (Game.results) Game.results.dismissed = true;
  }

  // ------------------------------------------------------------------ scoring
  function addScore(delta, reason) {
    delta = Math.round(fin(delta, 0));
    if (!delta) return;
    Game.score += delta;
    emit('score', { delta: delta, total: Game.score, reason: reason });
  }

  function bumpCombo() {
    var c = Game.combo;
    c.count = comboTimer > 0 ? c.count + 1 : 1;
    c.mult = Math.min(3, 1 + 0.25 * (c.count - 1));
    comboTimer = COMBO_WINDOW;
    c.timer = COMBO_WINDOW;
    return c.mult;
  }

  function popup(text, sub, points, kind) {
    var list = Game.popups, slot = null, oldest = -1;
    for (var i = 0; i < list.length; i++) {
      if (!list[i].active) { slot = list[i]; break; }
      if (list[i].age > oldest) { oldest = list[i].age; slot = list[i]; }
    }
    slot.active = true; slot.text = text; slot.sub = sub || ''; slot.points = points || 0;
    slot.kind = kind || 'good'; slot.age = 0; slot.life = 2.8;
  }

  function awardStunt(key, extraLabel, factor) {
    if (cooldown[key] > 0) return;
    cooldown[key] = STUNT_COOLDOWN[key] || 10;
    var mult = bumpCombo();
    var pts = Math.round((STUNT_POINTS[key] || 100) * (factor || 1) * mult);
    var name = extraLabel || STUNT_NAMES[key] || key;
    Game.stunts.push(name);
    addScore(pts, 'stunt');
    popup(name, mult > 1 ? 'combo x' + mult.toFixed(2).replace(/\.?0+$/, '') : '', pts, 'stunt');
    emit('stunt', { name: name, points: pts, key: key });
  }

  // ------------------------------------------------------------------ rings / course
  function onRing(ring, pos) {
    var R = rings(), c = Game.course;
    var idx = ring.index !== undefined ? ring.index : (R ? R.current - 1 : 0);
    var total = R ? (R.total || R.list.length) : c.total;
    c.total = total;
    c.ringsPassed = idx + 1;
    if (idx === 0 && c.state === 'ready') {
      c.state = 'running';
      c.time = 0;
      emit('courseStart', {});
      if (hintIs('ring')) completeHint('ring');
    }
    // how close to the centre did we pass? (distance in the ring plane)
    v3.sub(tA, pos, ring.pos);
    var along = v3.dot(tA, ring.dir);
    v3.scaleAndAdd(tA, tA, ring.dir, -along);
    var off = v3.length(tA) / Math.max(1, ring.radius);
    var base = RING_POINTS[ring.special] || RING_POINTS.normal;
    var bull = off <= BULLSEYE_FRAC;
    var mult = bumpCombo();
    var pts = Math.round((base + (bull ? BULLSEYE_POINTS : 0)) * mult);
    // split vs. best
    var delta = null;
    if (c.state === 'running') {
      c.splits[idx] = c.time;
      var bs = Game.best.splits;
      if (bs && bs.length === total && bs[idx] > 0) delta = c.time - bs[idx];
    }
    c.lastSplit = { index: idx, time: c.time, delta: delta };
    addScore(pts, 'ring');
    var label = ring.special === 'arch' ? 'Arch ring' : ring.special === 'lake' ? 'Lake ring' :
      ring.special === 'final' ? 'Final ring' : 'Ring ' + (idx + 1);
    var sub = bull ? 'Bullseye' : '';
    if (mult > 1) sub += (sub ? ' · ' : '') + 'combo x' + mult.toFixed(2).replace(/\.?0+$/, '');
    popup(label, sub, pts, ring.special ? 'special' : 'ring');
    emit('ring', {
      index: idx, total: total, pos: copy3(ring.pos), special: ring.special || null,
      points: pts, time: c.state === 'running' ? c.time : 0, bullseye: bull, delta: delta
    });
    if (R && R.complete) completeCourse();
  }

  function completeCourse() {
    var c = Game.course;
    if (c.state === 'done') return;
    var t = c.time;
    c.state = 'done';
    var prev = Game.best.time;
    var record = !(prev > 0) || t < prev;
    if (record) {
      Game.best.time = t;
      Game.best.splits = c.splits.slice();
    }
    c.medal = t <= c.par.gold ? 'gold' : t <= c.par.silver ? 'silver' : t <= c.par.bronze ? 'bronze' : null;
    var bonus = Math.max(0, Math.round((c.par.bronze - t) * 10));
    if (bonus > 0) {
      addScore(bonus, 'time');
      popup('Time bonus', formatTime(t), bonus, 'special');
    }
    tutorialDone = true;
    maybeSaveBestScore();
    save();
    emit('courseComplete', { time: t, best: Game.best.time, record: record, medal: c.medal, bonus: bonus });
    message(record ? 'New course record: ' + formatTime(t) + '!' : 'Course complete: ' + formatTime(t),
      record ? 'good' : 'info', 3.5);
    showHint('land', 'Course complete! Head home and land on runway 36 for your results', 8);
  }

  // ------------------------------------------------------------------ landings
  /**
   * Grade a touchdown. td: {verticalSpeed (m/s, +down), centerlineOffset, headingError (deg),
   * onRunway, bounced, surface}. Returns {grade, label, points}.
   */
  function gradeLanding(td) {
    var sink = Math.abs(fin(td.verticalSpeed, 0));
    var off = Math.abs(fin(td.centerlineOffset, 0));
    var hdg = Math.abs(fin(td.headingError, 0));
    var g = sink <= 0.9 ? 0 : sink <= 1.8 ? 1 : sink <= 3.0 ? 2 : 3;
    if (td.onRunway) {
      g = Math.max(g, off <= 3.5 ? 0 : off <= 8 ? 1 : off <= 14 ? 2 : 3);
      g = Math.max(g, hdg <= 3 ? 0 : hdg <= 7 ? 1 : hdg <= 12 ? 2 : 3);
    }
    if (td.bounced) g = Math.min(3, g + 1);
    var grade = GRADE_ORDER[g];
    var pts = LANDING_POINTS[grade];
    var label = LANDING_LABEL[grade];
    if (!td.onRunway) { pts = Math.round(pts * 0.5); label = 'Off-field: ' + label.toLowerCase(); }
    return { grade: grade, label: label, points: pts };
  }

  function finishLanding(touchAndGo) {
    var td = pendingTD;
    pendingTD = null;
    if (!td) return;
    var r = gradeLanding(td);
    var pts = r.points, label = r.label;
    if (touchAndGo) { pts = Math.round(pts * 0.5); label = 'Touch & go: ' + label.toLowerCase(); }
    var homecoming = !touchAndGo && Game.course.state === 'done' && td.onRunway && !Game.results;
    if (homecoming) pts = Math.round(pts * 1.5);
    addScore(pts, 'landing');
    Game.lastLanding = {
      grade: r.grade, label: label, points: pts, fpm: td.verticalSpeed * C.units.fpm,
      offset: td.centerlineOffset, heading: td.headingError, bounced: td.bounced,
      onRunway: td.onRunway, age: 0, touchAndGo: !!touchAndGo
    };
    emit('landing', { grade: r.grade, label: label, points: pts });
    if (!touchAndGo && td.onRunway) {
      var gi = GRADE_ORDER.indexOf(r.grade), bi = GRADE_ORDER.indexOf(Game.best.landing);
      if (bi < 0 || gi < bi) { Game.best.landing = r.grade; save(); }
    }
    if (homecoming) showResults();
  }

  function showResults() {
    var c = Game.course;
    maybeSaveBestScore();
    Game.results = {
      time: c.time, best: Game.best.time, record: Game.best.time === c.time,
      rings: c.ringsPassed, total: c.total, medal: c.medal, par: c.par,
      stunts: Game.stunts.slice(), landing: Game.lastLanding,
      score: Game.score, bestScore: Game.best.score, recordScore: Game.score > flightStartBest,
      dismissed: false
    };
    save();
    hideHint();
  }

  function maybeSaveBestScore() {
    if (Game.score > Game.best.score) {
      Game.best.score = Game.score;
      save();
    }
  }

  // ------------------------------------------------------------------ raw physics events
  function handleEvents(events) {
    var p = Game.plane;
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      switch (ev.type) {
        case 'liftoff':
          emit('liftoff', { speed: fin(ev.speed, p.airspeed), label: 'Liftoff' });
          st.liftoffAt = Game.flightTime;
          st.stalledSinceLiftoff = false;
          if (pendingTD) {
            if (pendingTD.roll > 0.8) finishLanding(true);
            else pendingTD = null;
          }
          if (hintIs('rotate')) completeHint('rotate');
          break;
        case 'touchdown':
          var vs = fin(ev.verticalSpeed, 0);
          // The flight model reports the offset east of the centreline; the landing banner wants it
          // as the pilot sees it, which flips when landing south on runway 18.
          pendingTD = {
            verticalSpeed: vs,
            centerlineOffset: fin(ev.centerlineOffset, 0) * (p.forward && p.forward[2] > 0 ? -1 : 1),
            headingError: fin(ev.headingError, 0), onRunway: !!ev.onRunway,
            surface: ev.surface || 'grass', bounced: false, roll: 0
          };
          emit('touchdown', {
            verticalSpeed: vs, speed: fin(ev.speed, 0), surface: ev.surface || 'grass',
            onRunway: !!ev.onRunway, centerlineOffset: fin(ev.centerlineOffset, 0),
            headingError: fin(ev.headingError, 0), roll: fin(ev.roll, 0), pos: copy3(p.pos),
            label: Math.round(vs * C.units.fpm) + ' fpm'
          });
          break;
        case 'bounce':
          if (pendingTD) pendingTD.bounced = true;
          emit('bounce', { pos: copy3(p.pos) });
          break;
        case 'crash':
          onCrash(ev.reason || 'terrain', fin(ev.speed, v3.length(prevVel)));
          return;                       // nothing after a crash matters
        case 'stall':
          st.stalledSinceLiftoff = true;
          emit('stall', { active: true });
          break;
        case 'stallRecover':
          emit('stall', { active: false });
          break;
      }
    }
  }

  function onCrash(reason, speed) {
    var p = Game.plane;
    var txt = CRASH_TEXT[reason] || CRASH_TEXT.terrain;
    var W = world();
    if (reason === 'terrain' && W && W.normalAt) {
      // flat valley floor, not a mountainside: say so
      var n = W.normalAt(p.pos[0], p.pos[2], tA);
      if (n && n[1] > 0.93 && p.pos[1] < 400) txt = CRASH_TEXT.groundHit;
    }
    if ((reason === 'hardLanding' || reason === 'terrain') && st && st.stalledSinceLiftoff &&
        Game.flightTime - st.liftoffAt < 15) {
      txt = CRASH_TEXT.climbStall;           // the real lesson is the over-rotation, not the flare
    }
    Game.state = 'crashed';
    Game.crash.reason = reason;
    Game.crash.label = txt[0];
    Game.crash.tip = txt[1];
    Game.crash.t = 0;
    Game.crash.ready = false;
    pendingTD = null;
    hideHint();
    maybeSaveBestScore();
    emit('crash', { reason: reason, label: txt[0], pos: copy3(p.pos), vel: copy3(prevVel), speed: fin(speed, 0) });
  }

  // ------------------------------------------------------------------ per-frame
  function update(dt, controls) {
    dt = fin(dt, 0);
    if (dt <= 0) return;
    dt = Math.min(dt, 0.25);
    var p = Game.plane, FM = RL.FlightModel, W = world();
    tickPopups(dt);
    if (!p || !FM) return;

    // debug teleport / external reset: forget per-flight trackers
    if (p.time < lastPlaneTime - 1e-6) { resetTrackers(); pendingTD = null; acc = 0; }

    if (Game.state === 'title') {
      // parked: engine idling, brakes on, nothing else advances
      FM.step(p, PARK, dt, W);
      lastPlaneTime = p.time;
      return;
    }
    if (Game.state === 'crashed') {
      FM.step(p, PARK, dt, W);          // the wreck: prop winds down, nothing moves
      lastPlaneTime = p.time;
      Game.crash.t += dt;
      if (!Game.crash.ready && Game.crash.t >= RESPAWN_DELAY) Game.crash.ready = true;
      return;
    }
    if (Game.state !== 'playing') return;

    controls = controls || PARK;
    var phys = C.physics, fdt = phys.fixedDt || 1 / 120, maxN = phys.maxSubSteps || 12;
    var R = rings();
    acc += dt;
    var n = 0;
    v3.copy(framePrev, p.pos);
    while (acc >= fdt && n < maxN && Game.state === 'playing') {
      v3.copy(prevPos, p.pos);
      v3.copy(prevVel, p.vel);
      var events = FM.step(p, controls, fdt, W);
      acc -= fdt;
      n++;
      if (Game.course.state === 'running') Game.course.time += fdt;
      if (events && events.length) handleEvents(events);
      if (Game.state !== 'playing') break;
      if (R && R.check && !p.crashed) {
        var ring = R.check(prevPos, p.pos);
        if (ring) onRing(ring, p.pos);
      }
    }
    if (n >= maxN) acc = 0;              // fell behind (tab hitch): drop time instead of spiralling
    lastPlaneTime = p.time;
    if (Game.state !== 'playing') return;

    Game.flightTime += dt;
    updateCombo(dt);
    updateLandingRoll(dt);
    updateStunts(dt, W);
    updateWarnings(dt, W);
    updateBounds(W);
    updateHints(dt, controls);
    if (Game.lastLanding) Game.lastLanding.age += dt;
    if (Game.results && !Game.results.dismissed && !p.onGround && p.agl > 5) Game.results.dismissed = true;
  }

  function tickPopups(dt) {
    var list = Game.popups;
    for (var i = 0; i < list.length; i++) {
      var q = list[i];
      if (!q.active) continue;
      q.age += dt;
      if (q.age >= q.life) q.active = false;
    }
    for (var k in cooldown) if (cooldown[k] > 0) cooldown[k] -= dt;
  }

  function updateCombo(dt) {
    if (comboTimer > 0) {
      comboTimer -= dt;
      Game.combo.timer = Math.max(0, comboTimer);
      if (comboTimer <= 0) { Game.combo.count = 0; Game.combo.mult = 1; }
    }
  }

  function updateLandingRoll(dt) {
    var p = Game.plane;
    if (!pendingTD) return;
    if (p.onGround) pendingTD.roll += dt;
    // a full stop (or a slow taxi) completes the landing
    if (p.onGround && p.groundSpeed < 1.0) finishLanding(false);
    else if (p.onGround && p.groundSpeed > 10 && !st.brakeHintShown && pendingTD && pendingTD.roll > 1.5) {
      st.brakeHintShown = true;
      showHint('brake', 'Nice! Throttle to idle and hold [Space] to brake', 5);
    }
  }

  // ------------------------------------------------------------------ stunts
  function updateStunts(dt, W) {
    var p = Game.plane;
    var airborne = !p.onGround && !p.crashed;
    var agl = fin(p.agl, 0);
    var roll = fin(p.roll, 0), absRoll = Math.abs(roll);
    var spd = fin(p.airspeed, 0);

    // ---- body-axis roll / pitch integrals (robust through loops, unlike Euler roll)
    var wr = -fin(p.angVel[2], 0) * M.RAD, wp = fin(p.angVel[0], 0) * M.RAD;
    if (airborne && agl > 8) {
      st.rollCum += wr * dt;
      st.pitchCum += wp * dt;
    }
    st.pitchMaxS = Math.max(st.pitchMaxS, fin(p.pitch, 0));
    st.upMinS = Math.min(st.upMinS, fin(p.up[1], 1));
    st.sampleT += dt;
    if (st.sampleT >= 0.1) {
      st.sampleT = 0;
      st.head = (st.head + 1) % ROLL_SAMPLES;
      rollBuf[st.head] = st.rollCum;
      pitchBuf[st.head] = st.pitchCum;
      pitchMaxBuf[st.head] = st.pitchMaxS;
      upMinBuf[st.head] = st.upMinS;
      st.pitchMaxS = -90; st.upMinS = 1;
      st.nSamples = Math.min(ROLL_SAMPLES, st.nSamples + 1);
    }
    if (airborne && agl > 8) {
      // barrel roll: 360 deg of roll within 6 s; loop: 360 deg of pitch within 14 s that also
      // went nose-up past 65 deg and over the top (inverted) somewhere in that window
      var nS = Math.min(st.nSamples, LOOP_WINDOW), maxDR = 0, maxDP = 0, winPitch = -90, winUp = 1;
      for (var i = 0; i < nS; i++) {
        var idx = (st.head - i + ROLL_SAMPLES) % ROLL_SAMPLES;
        if (i < ROLL_WINDOW) {
          var dr = Math.abs(st.rollCum - rollBuf[idx]);
          if (dr > maxDR) maxDR = dr;
        }
        var dp = Math.abs(st.pitchCum - pitchBuf[idx]);
        if (dp > maxDP) maxDP = dp;
        if (pitchMaxBuf[idx] > winPitch) winPitch = pitchMaxBuf[idx];
        if (upMinBuf[idx] < winUp) winUp = upMinBuf[idx];
      }
      if (maxDR >= 350 && !(cooldown.barrelRoll > 0)) {
        awardStunt('barrelRoll');
        clearRotationHistory();
      } else if (maxDP >= 340 && maxDR < 200 && winPitch > 65 && winUp < -0.4 && !(cooldown.loop > 0)) {
        awardStunt('loop');
        clearRotationHistory();
      }
    } else if (!airborne) {
      clearRotationHistory();
    }

    // ---- inverted flight (3 s) and knife edge (2.5 s)
    st.inverted = (airborne && agl > 20 && absRoll > 150 && Math.abs(p.pitch) < 35) ? st.inverted + dt : 0;
    if (st.inverted >= 3) { awardStunt('inverted'); st.inverted = -30; }
    // Knife edge is flying on the side, not turning: a steep banked turn has the same roll angle
    // but swings the heading round at 30+ deg/s, while a real knife edge barely changes it.
    var hdgNow = fin(p.heading, 0);
    var hdgStep = Math.abs(M.wrapPi((hdgNow - st.prevHdg) * M.DEG)) * M.RAD / Math.max(dt, 1e-3);
    st.prevHdg = hdgNow;
    st.hdgRate = M.damp(st.hdgRate, Math.min(hdgStep, 360), 4, dt);
    var knife = airborne && agl > 20 && absRoll > 72 && absRoll < 108 && Math.abs(p.pitch) < 30 && spd > 35 &&
      st.hdgRate < 10;
    st.knife = knife ? st.knife + dt : 0;
    if (st.knife >= 2.5) { awardStunt('knifeEdge'); st.knife = -30; }

    // ---- low pass along the runway: < 15 m AGL at > 100 kt, lined up with it
    var rw = C.airfield.runway;
    var hdgErr = Math.abs(M.wrapPi(fin(p.heading, 0) * M.DEG) * M.RAD);
    hdgErr = Math.min(hdgErr, 180 - hdgErr);
    var overRunway = Math.abs(p.pos[0] - rw.cx) < rw.width / 2 + 25 && Math.abs(p.pos[2] - rw.cz) < rw.length / 2;
    // (a short grace period forgives a brief bobble above 15 m)
    if (airborne && overRunway && agl < 15 && spd * KT > 100 && hdgErr < 25) {
      st.lowPassDist += fin(p.groundSpeed, 0) * dt;
      st.lowPassGrace = 0;
      if (p.gearDown) st.lowPassGearUp = false;
      if (st.lowPassDist >= 450 && !st.lowPassDone) {
        st.lowPassDone = true;
        if (st.lowPassGearUp) awardStunt('lowPass', 'Gear-up low pass', 1.5);
        else awardStunt('lowPass');
      }
    } else if (st.lowPassDist > 0) {
      st.lowPassGrace += dt;
      if (st.lowPassGrace > 1.0 || !overRunway || !airborne) {
        st.lowPassDist = 0; st.lowPassGearUp = true; st.lowPassDone = false;
      }
    }

    // ---- thread the needle: fly under the arch (anytime)
    var A = RL.Terrain && RL.Terrain.arch;
    if (A && A.center && A.dir && airborne) {
      var cx = A.center[0], cy = A.center[1], cz = A.center[2], dx = A.dir[0], dz = A.dir[2];
      var d0 = (framePrev[0] - cx) * dx + (framePrev[2] - cz) * dz;
      var d1 = (p.pos[0] - cx) * dx + (p.pos[2] - cz) * dz;
      if ((d0 < 0) !== (d1 < 0) && Math.abs(d0 - d1) < 60) {
        var t = d0 / (d0 - d1);
        var X = M.lerp(framePrev[0], p.pos[0], t), Y = M.lerp(framePrev[1], p.pos[1], t), Z = M.lerp(framePrev[2], p.pos[2], t);
        var lateral = Math.abs((X - cx) * -dz + (Z - cz) * dx);
        var hgt = Y - cy;
        if (lateral < fin(A.openingHalfWidth, 90) + 10 && hgt > 0 && hgt < fin(A.openingHeight, 150) + 5) awardStunt('arch');
      }
    }

    // ---- canyon run: most of Serpent Canyon below the rim
    if (canyonSeg.length && airborne) {
      var cn = canyonNearest(p.pos[0], p.pos[2]);
      var cc = C.canyon, cv = st.canyon;
      var inCorridor = cn.dist < cc.halfWidth + 50;
      var below = false;
      if (inCorridor && W) {
        var off = cc.halfWidth + cc.wallWidth;
        var rimA = W.heightAt(cn.qx + cn.nx * off, cn.qz + cn.nz * off);
        var rimB = W.heightAt(cn.qx - cn.nx * off, cn.qz - cn.nz * off);
        below = p.pos[1] < Math.min(rimA, rimB) + 10;
      }
      if (inCorridor && below) {
        if (!cv.active) { cv.active = true; cv.sMin = cn.s; cv.sMax = cn.s; cv.done = false; }
        cv.sMin = Math.min(cv.sMin, cn.s); cv.sMax = Math.max(cv.sMax, cn.s);
        cv.grace = 0;
        if (!cv.done && cv.sMax - cv.sMin >= canyonLen * 0.72) { cv.done = true; awardStunt('canyon'); }
      } else if (cv.active) {
        cv.grace += dt;
        if (cv.grace > 2) cv.active = false;
      }
    }

    // ---- thermal rider: gain 150 m inside a thermal
    if (W && W.thermalStrengthAt && airborne) {
      var th = st.thermal, ts = W.thermalStrengthAt(p.pos[0], p.pos[2]);
      if (ts > 0.25) {
        if (!th.inside) { th.inside = true; th.base = p.pos[1]; }
        th.grace = 0;
        th.base = Math.min(th.base, p.pos[1]);
        if (p.pos[1] - th.base >= 150) { awardStunt('thermal'); th.base = p.pos[1]; }
      } else if (th.inside) {
        th.grace += dt;
        if (th.grace > 5) th.inside = false;
      }
    }

    // ---- lake skim: < 5 m over the water for 3 s
    var overWater = W && W.isWater && W.isWater(p.pos[0], p.pos[2]);
    st.lakeSkim = (airborne && overWater && agl < 5 && spd > 25) ? st.lakeSkim + dt : 0;
    if (st.lakeSkim >= 3) { awardStunt('lakeSkim'); st.lakeSkim = -30; }
  }

  function clearRotationHistory() {
    st.rollCum = 0; st.pitchCum = 0; st.nSamples = 0;
    st.pitchMaxS = -90; st.upMinS = 1;
    for (var i = 0; i < ROLL_SAMPLES; i++) { rollBuf[i] = 0; pitchBuf[i] = 0; pitchMaxBuf[i] = -90; upMinBuf[i] = 1; }
  }

  // ------------------------------------------------------------------ warnings
  function updateWarnings(dt, W) {
    var p = Game.plane, w = Game.warnings, specs = (RL.FlightModel && RL.FlightModel.specs) || {};
    var airborne = !p.onGround && !p.crashed;
    var spd = fin(p.airspeed, 0), agl = fin(p.agl, 0);
    // While the soft AoA limiter is holding the aircraft (riding the buffet in a hard pull) the
    // stall is being prevented, so only the horn/buffet speak; the red box is for a real stall
    // or an unprotected approach to one.
    var protect = fin(p.stallProtect, 0);
    w.stall = airborne && agl > 2 && (p.stall || (fin(p.stallWarning, 0) > 0.65 && protect < 0.5));
    // remember a nose-high moment (stalled, or held at the AoA limit) for the crash advice
    if (airborne && (p.stall || fin(p.stallWarning, 0) > 0.65)) st.stalledSinceLiftoff = true;
    w.overspeed = spd > fin(specs.vNeverExceed, 108) * 0.96;
    w.gear = airborne && !p.gearDown && agl < 70 && spd < 42 && p.verticalSpeed < 0.5;

    // Terrain closure: look ahead along the velocity (1.5, 3, 4.5 s) for the ground surface.
    var danger = false;
    if (airborne && agl > 2 && W) {
      var approach = p.gearDown && C.isOnRunway(p.pos[0], p.pos[2], 700) && p.verticalSpeed > -6;
      if (!approach) {
        // Level or climbing flight keeps a margin relative to the current height, so a deliberate
        // low pass or lake skim stays quiet while rising ground ahead still triggers.
        var margin = p.verticalSpeed >= -1 ? Math.min(6, agl * 0.5) : 6;
        for (var k = 1; k <= 3 && !danger; k++) {
          var t = k * 1.5;
          var x = p.pos[0] + p.vel[0] * t, y = p.pos[1] + p.vel[1] * t, z = p.pos[2] + p.vel[2] * t;
          if (y < W.surfaceHeightAt(x, z) + margin) danger = true;
        }
        if (agl < 40 && p.verticalSpeed < -agl * 0.35 && p.verticalSpeed < -4) danger = true;
      }
    }
    if (danger) st.pullUpHold = 0.6;
    else st.pullUpHold = Math.max(0, st.pullUpHold - dt);
    w.pullUp = st.pullUpHold > 0;
  }

  function updateBounds(W) {
    var p = Game.plane, w = Game.warnings;
    var d = W && W.outOfBounds ? fin(W.outOfBounds(p.pos[0], p.pos[2]), 0) : 0;
    w.boundsDist = d;
    w.bounds = d > 0;
    if (d > 0 && !boundsWarned) {
      boundsWarned = true;
      message('Leaving the valley: turn back!', 'warn', 3);
    } else if (d === 0) boundsWarned = false;
    if (d > BOUNDS_RESPAWN) respawn('bounds');
  }

  // ------------------------------------------------------------------ hints (tutorial)
  var hintTimer = 0, hintDone = {};
  function resetHints() {
    hintDone = {};
    hideHint();
  }
  function hintIs(id) { return Game.hint.id === id && !!Game.hint.text; }
  function showHint(id, text, duration) {
    Game.hint.id = id; Game.hint.text = text; Game.hint.age = 0;
    hintTimer = duration || 0;
  }
  function hideHint() { Game.hint.text = ''; Game.hint.id = ''; hintTimer = 0; }
  function completeHint(id) {
    hintDone[id] = true;
    if (Game.hint.id === id) hideHint();
  }

  // Is the mouse actually flying the aircraft right now (captured, or the no-lock fallback)?
  function mouseFlying() {
    var I = RL.Input;
    return !!(I && I.mouseFlight !== false && (I.pointerLocked || I.pointerFallback));
  }
  function centerlineOffset(p) { return Math.abs(p.pos[0] - C.airfield.runway.cx); }

  // Rotation: a keyboard pilot who holds the pitch key over-rotates and stalls, so say "tap" and
  // give the target attitude (the HUD ladder's 10 degree rung). Mouse wording follows the invert
  // setting and is only offered when the mouse is really flying.
  function rotateText() {
    var I = RL.Input || {};
    if (!mouseFlying()) return 'At 60 kt tap [↓] to lift the nose to about 10°, then let go and let her climb';
    var dir = I.settings && I.settings.invertPitch ? 'forward' : 'back';
    return 'At 60 kt ease the mouse ' + dir + ' (or tap [↓]): nose up about 10°, then let her climb';
  }
  function steerText() {
    return 'Keep her on the centreline: steer with [A] / [D]' + (mouseFlying() ? ' or the mouse' : '');
  }

  // Tutorial steps: [id, text (string or function), when to show, when done, timed seconds
  // (0 = until done)]. Steps run in order, so every step must eventually resolve.
  var TUTORIAL = [
    ['throttle', 'Throttle up: hold [W] or roll the mouse wheel forward',
      function (p) { return p.onGround; }, function (p) { return p.throttle > 0.85 || p.airspeed > 20; }, 0],
    // shown early in every first takeoff roll (crosswind and torque drift an unsteered aircraft
    // towards the runway edge, and nothing else teaches A / D), gone once the player steers or
    // lifts off; timed, so it can never hold up the rotate step
    ['steer', steerText,
      function (p) { return p.onGround && p.groundSpeed > 5 && (p.airspeed * KT > 22 || centerlineOffset(p) > 4); },
      function (p, c) { return !p.onGround || (c && Math.abs(fin(c.yaw, 0)) > 0.3); }, 5],
    ['rotate', rotateText,
      function (p) { return p.onGround && p.airspeed * KT > 40; }, function (p) { return !p.onGround && p.agl > 3; }, 0],
    ['gear', 'Positive climb: raise the gear with [G]',
      function (p) { return !p.onGround && p.agl > 12 && p.gearDown; }, function (p) { return !p.gearDown; }, 9],
    ['ring', 'Fly through the gold ring to start the clock. The arrow shows the way',
      function (p) { return !p.onGround && p.agl > 20; }, function () { return Game.course.ringsPassed > 0; }, 12],
    ['smoke', 'Hold the [left mouse button] to skywrite. [T] changes the smoke colour',
      function () { return Game.course.ringsPassed >= 2; }, null, 6],
    ['camera', '[C] cycles cameras. Hold the [right mouse button] to look around',
      function () { return Game.course.ringsPassed >= 4; }, null, 6]
  ];

  function updateHints(dt, controls) {
    var p = Game.plane, h = Game.hint;
    h.age += dt;
    if (h.text && hintTimer > 0) {
      hintTimer -= dt;
      if (hintTimer <= 0) { hintDone[h.id] = true; hideHint(); }
    }
    // tutorial: only on the first flights, one step at a time
    if (!tutorialDone) {
      var allDone = true;
      for (var j = 0; j < TUTORIAL.length; j++) if (!hintDone[TUTORIAL[j][0]]) allDone = false;
      if (allDone) { tutorialDone = true; save(); }
      for (var i = 0; i < TUTORIAL.length && !tutorialDone; i++) {
        var s = TUTORIAL[i];
        if (hintDone[s[0]]) continue;
        if (s[3] && s[3](p, controls)) { completeHint(s[0]); continue; }
        if (h.text && h.id !== s[0]) break;          // another hint is up: wait
        if (!h.text && s[2](p, controls)) showHint(s[0], typeof s[1] === 'function' ? s[1](p, controls) : s[1], s[4]);
        break;
      }
    }
    // every flight, once: drifting towards the runway edge on the takeoff/landing roll
    if (!st.steerHintShown && !h.text && p.onGround && p.groundSpeed > 8 &&
        C.isOnRunway(p.pos[0], p.pos[2], 0) && centerlineOffset(p) > 11 &&
        !(controls && Math.abs(fin(controls.yaw, 0)) > 0.3)) {
      st.steerHintShown = true;
      showHint('steerEdge', steerText(), 5);
    }
    // landing coaching (every flight, once): lined up with the runway and going down
    if (!st.landingHintShown && !h.text && !p.onGround) {
      var rw = C.airfield.runway;
      var dx = p.pos[0] - rw.cx, dz = p.pos[2] - rw.cz;
      var dist = Math.hypot(dx, dz);
      var hdgErr = Math.abs(M.wrapPi(fin(p.heading, 0) * M.DEG) * M.RAD);
      hdgErr = Math.min(hdgErr, 180 - hdgErr);
      var dirty = p.airspeed * KT > 85 || !p.gearDown || p.flapsNotch < 2;
      // not the post-rotation settle (that looks just like an approach), and only when closing
      // on the field rather than departing it
      var sinceLiftoff = Game.flightTime - st.liftoffAt;
      var closing = -dx * p.vel[0] - dz * p.vel[2] > 0;
      if (sinceLiftoff > 25 && closing &&
          dist < 3000 && Math.abs(dx) < 400 && p.agl < 300 && hdgErr < 30 && p.verticalSpeed < -1 && dirty &&
          (Game.course.state === 'done' || !tutorialDone)) {
        st.landingHintShown = true;
        showHint('landing', 'To land: slow below 80 kt, flaps [F] twice, gear down [G], flare just above the runway', 9);
      }
    }
  }

  RL.Game = Game;
})(window.RL = window.RL || {});
