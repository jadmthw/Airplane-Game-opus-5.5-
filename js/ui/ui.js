/*
 * Ridgeline — RL.UI: DOM overlays inside #ui-root.
 *
 *   init(), toggleHelp(), helpOpen, toast(text, kind, duration)
 *
 * Title screen (over the live attract camera), pause menu, full help overlay, crash panel,
 * course results, toast stack and a vignette. The UI polls RL.Game.state on its own
 * requestAnimationFrame (main.js has no UI update hook) and only touches the DOM when something
 * changed. Buttons never keep keyboard focus, so Space / keys always keep flying the aircraft.
 */
(function (RL) {
  'use strict';

  var root = null;
  var el = {};                   // named elements
  var optionSets = [];           // option widgets to refresh (title + pause)
  var last = { state: '', crashReady: null, results: null, resultsShown: false, help: false, paused: false };
  var pausedByHelp = false;
  var toasts = [];
  var optionsSig = '';           // settings last shown in the option widgets (see settingsSig)

  var UI = {
    helpOpen: false,
    init: init,
    toggleHelp: toggleHelp,
    toast: toast
  };

  // ------------------------------------------------------------------ tiny DOM helpers
  function h(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }
  function show(e, on) {
    if (!e) return;
    if (on) e.classList.add('show'); else e.classList.remove('show');
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function game() { return RL.Game || null; }
  function fmtTime(t) {
    var G = game();
    if (G && G.formatTime) return G.formatTime(t);
    return t >= 0 ? t.toFixed(1) + ' s' : '--:--.-';
  }
  function fmtInt(n) { return Math.round(n || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  /** Drop keyboard focus from any widget, so flight keys reach RL.Input again. */
  function releaseFocus() {
    var a = document.activeElement;
    if (a && a !== document.body && a.blur) a.blur();
  }

  /** A button that runs fn on click and never keeps focus. */
  function button(label, cls, fn) {
    var b = h('button', 'rl-btn ' + (cls || ''), label);
    b.type = 'button';
    b.addEventListener('mousedown', function (e) { e.preventDefault(); });   // no focus steal
    b.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      b.blur();
      releaseFocus();                              // e.g. a slider focused before this click
      try { fn(e); } catch (err) { if (window.console) console.error('[RL.UI]', err); }
    });
    return b;
  }

  function action(name) {
    var G = game();
    if (G && G.handleAction) G.handleAction(name);
  }
  function lock() {
    if (RL.Input && RL.Input.requestPointerLock && RL.Input.mouseFlight !== false) RL.Input.requestPointerLock();
  }
  function unlockAudio() { if (RL.Audio && RL.Audio.unlock) { try { RL.Audio.unlock(); } catch (e) { /* ignore */ } } }

  // ------------------------------------------------------------------ build
  function init() {
    root = document.getElementById('ui-root');
    if (!root) {
      root = h('div');
      root.id = 'ui-root';
      document.body.appendChild(root);
    }
    root.innerHTML = '';
    el.vignette = h('div', 'rl-vignette');
    root.appendChild(el.vignette);
    buildTitle();
    buildPause();
    buildCrash();
    buildResults();
    buildHelp();
    el.toasts = h('div', 'rl-toasts');
    root.appendChild(el.toasts);

    var E = RL.Events;
    if (E) {
      E.on('message', function (d) { toast(d.text, d.kind, d.duration); });
      E.on('gear', function (d) { toast(d.down ? 'Gear down' : 'Gear up', 'info', 1.2); });
      E.on('flaps', function (d) { toast(d.label || ('Flaps ' + d.notch), 'info', 1.2); });
      E.on('courseStart', function () { toast('Clock running: go go go!', 'good', 1.8); });
      E.on('timeOfDay', function () { refreshOptions(); });
      // main.js emits 'ready' after every init (Game.init loads the saved records), so the title
      // never keeps the placeholders from a UI frame that ran before the records were loaded
      E.on('ready', function () { refreshRecords(); refreshOptions(); });
      E.on('crash', function () {
        el.vignette.classList.remove('flash');
        void el.vignette.offsetWidth;                     // restart the flash animation
        el.vignette.classList.add('flash');
      });
    }

    // "Press R or click to respawn": a click anywhere once the prompt is up
    window.addEventListener('click', function (e) {
      var G = game();
      if (!G || G.state !== 'crashed' || !G.crash || !G.crash.ready || e.button !== 0) return;
      if (e.target && e.target.closest && e.target.closest('.rl-interactive')) return;
      unlockAudio();
      action('reset');
      lock();
    }, false);

    requestAnimationFrame(loop);
  }

  // ---- title --------------------------------------------------------------------------
  function buildTitle() {
    var t = h('div', 'rl-layer rl-title');
    t.appendChild(h('div', 'rl-title-shade'));
    var col = h('div', 'rl-title-col rl-interactive');
    col.appendChild(h('div', 'rl-kicker', 'A valley flight'));
    col.appendChild(h('h1', 'rl-logo', 'RIDGELINE'));
    col.appendChild(h('p', 'rl-tagline', 'Lift off from a mountain airstrip, chase the rings up the valley, ' +
      'thread <b>Serpent Canyon</b> and the <b>Needle Arch</b>, skim <b>Mirror Lake</b>, then bring her home like butter.'));
    var fly = button('<span class="rl-fly-icon">&#9992;</span> Click to fly', 'rl-btn-primary rl-fly', function () {
      unlockAudio();
      action('start');
      lock();
    });
    col.appendChild(fly);
    el.records = h('div', 'rl-records');
    col.appendChild(el.records);

    var card = h('div', 'rl-panel rl-title-card');
    card.appendChild(h('div', 'rl-section-title', 'Options'));
    card.appendChild(buildOptions());
    col.appendChild(card);
    t.appendChild(col);

    var keys = h('div', 'rl-panel rl-title-keys rl-interactive');
    keys.appendChild(h('div', 'rl-section-title', 'Controls'));
    keys.appendChild(h('div', 'rl-mini-controls',
      row('Mouse', 'Stick: pitch &amp; roll') +
      row('<kbd>W</kbd><kbd>S</kbd> wheel', 'Throttle') +
      row('<kbd>A</kbd><kbd>D</kbd>', 'Rudder &amp; steering') +
      row('<kbd>F</kbd><kbd>G</kbd>', 'Flaps, gear') +
      row('<kbd>Space</kbd>', 'Brakes') +
      row('Left mouse / <kbd>Shift</kbd>', 'Skywriting smoke') +
      row('<kbd>C</kbd><kbd>N</kbd>', 'Camera, time of day')));
    keys.appendChild(button('All controls &amp; stunt book <kbd>H</kbd>', 'rl-btn-ghost rl-btn-small', function () { toggleHelp(); }));
    t.appendChild(keys);
    t.appendChild(h('div', 'rl-title-foot', 'Press <kbd>Enter</kbd> or click anywhere to fly &nbsp;·&nbsp; <kbd>H</kbd> controls'));
    root.appendChild(t);
    el.title = t;
  }

  function row(k, v) { return '<div class="rl-k">' + k + '</div><div class="rl-v">' + v + '</div>'; }

  function refreshRecords() {
    var G = game();
    if (!G || !el.records) return;
    var b = G.best || {};
    var landing = { perfect: 'Butter', good: 'Smooth', firm: 'Firm', hard: 'Hard' }[b.landing] || '—';
    el.records.innerHTML =
      rec('Best time', b.time > 0 ? fmtTime(b.time) : '—') +
      rec('Best score', b.score > 0 ? fmtInt(b.score) : '—') +
      rec('Best landing', landing);
  }
  function rec(label, value) {
    return '<div class="rl-rec"><div class="rl-rec-v">' + esc(value) + '</div><div class="rl-rec-l">' + label + '</div></div>';
  }

  // ---- options (shared by title & pause) ------------------------------------------------
  function buildOptions() {
    var wrap = h('div', 'rl-options');
    var set = {};

    // time of day chips
    var tod = h('div', 'rl-opt');
    tod.appendChild(h('div', 'rl-opt-l', 'Time of day'));
    var chips = h('div', 'rl-chips');
    set.tod = {};
    [['dawn', 'Dawn'], ['day', 'Midday'], ['sunset', 'Sunset'], ['night', 'Night']].forEach(function (p) {
      var c = button(p[1], 'rl-chip', function () {
        if (RL.Atmosphere && RL.Atmosphere.set) RL.Atmosphere.set(p[0]);
        refreshOptions();
      });
      set.tod[p[0]] = c;
      chips.appendChild(c);
    });
    tod.appendChild(chips);
    wrap.appendChild(tod);

    // toggles
    set.invert = toggleRow(wrap, 'Invert mouse pitch', function (on) {
      var I = RL.Input; if (!I || !I.settings) return;
      I.settings.invertPitch = on;
      if (I.saveSettings) I.saveSettings();
    });
    set.mouse = toggleRow(wrap, 'Mouse flight', function (on) {
      var I = RL.Input; if (!I) return;
      I.mouseFlight = on;
      if (I.centerStick) I.centerStick();
      if (I.saveSettings) I.saveSettings();
    });
    set.sound = toggleRow(wrap, 'Sound', function (on) {
      var A = RL.Audio;
      if (A && A.toggleMute && !!A.muted === on) A.toggleMute();
    });

    // sensitivity slider
    // A <div>, not a <label>: clicking a label focuses its range input, and a focused input
    // swallows every flight key in RL.Input.
    var sens = h('div', 'rl-opt rl-opt-range');
    sens.appendChild(h('div', 'rl-opt-l', 'Mouse sensitivity'));
    var range = h('input', 'rl-range');
    range.type = 'range'; range.min = '0.3'; range.max = '2.5'; range.step = '0.05';
    var val = h('span', 'rl-opt-val', '1.00×');
    range.addEventListener('input', function () {
      var I = RL.Input, v = parseFloat(range.value);
      if (I && I.settings && isFinite(v)) I.settings.sensitivity = v;
      val.textContent = (isFinite(v) ? v : 1).toFixed(2) + '×';
    });
    range.addEventListener('change', function () {
      if (RL.Input && RL.Input.saveSettings) RL.Input.saveSettings();
      range.blur();
    });
    range.addEventListener('pointerup', function () { range.blur(); });
    sens.appendChild(range);
    sens.appendChild(val);
    wrap.appendChild(sens);
    set.range = range; set.rangeVal = val;

    // graphics quality: terrain resolution, trees and the shadow map are built at load time,
    // so switching stores the choice (main.js reads 'ridgeline.quality') and reloads
    var gfx = h('div', 'rl-opt');
    gfx.appendChild(h('div', 'rl-opt-l', 'Graphics <span class="rl-opt-note">reloads</span>'));
    var gchips = h('div', 'rl-chips');
    set.gfx = {};
    [['high', 'High'], ['low', 'Low']].forEach(function (q) {
      var c = button(q[1], 'rl-chip', function () { setQuality(q[0]); });
      set.gfx[q[0]] = c;
      gchips.appendChild(c);
    });
    gfx.appendChild(gchips);
    wrap.appendChild(gfx);

    optionSets.push(set);
    refreshOptions();
    return wrap;
  }

  function currentQuality() { return RL.Params && RL.Params.quality === 'low' ? 'low' : 'high'; }

  function setQuality(q) {
    if (q === currentQuality()) return;
    try { window.localStorage.setItem('ridgeline.quality', q); } catch (e) { /* blocked storage */ }
    try {
      // an explicit ?quality= in the URL would win over the stored choice, so rewrite it
      var search = window.location.search, re = /([?&])quality=[^&]*/;
      if (re.test(search)) window.location.search = search.replace(re, '$1quality=' + q);
      else window.location.reload();
    } catch (e) { window.location.reload(); }
  }

  function toggleRow(parent, label, fn) {
    var r = h('label', 'rl-opt rl-opt-toggle');
    r.appendChild(h('div', 'rl-opt-l', label));
    var input = h('input', 'rl-switch');
    input.type = 'checkbox';
    input.addEventListener('change', function () {
      fn(input.checked);
      input.blur();
      refreshOptions();
    });
    input.addEventListener('mousedown', function (e) { e.preventDefault(); });
    r.addEventListener('mousedown', function (e) { e.preventDefault(); });
    r.appendChild(input);
    r.appendChild(h('span', 'rl-switch-ui'));
    parent.appendChild(r);
    return input;
  }

  function refreshOptions() {
    var I = RL.Input, A = RL.Audio, At = RL.Atmosphere;
    for (var i = 0; i < optionSets.length; i++) {
      var s = optionSets[i];
      for (var k in s.tod) s.tod[k].classList.toggle('on', !!At && At.name === k);
      for (var g in s.gfx) s.gfx[g].classList.toggle('on', currentQuality() === g);
      s.invert.checked = !!(I && I.settings && I.settings.invertPitch);
      s.mouse.checked = !I || I.mouseFlight !== false;
      s.sound.checked = !(A && A.muted);
      s.sound.disabled = !A || !!(RL.Params && RL.Params.noaudio);
      var v = I && I.settings ? I.settings.sensitivity : 1;
      if (!isFinite(v)) v = 1;
      if (document.activeElement !== s.range) s.range.value = String(v);
      s.rangeVal.textContent = v.toFixed(2) + '×';
    }
    optionsSig = settingsSig();
  }

  // I / V / M change settings from the keyboard without telling the UI; compare a cheap
  // signature each frame while a menu with options is up and refresh when it moved.
  function settingsSig() {
    var I = RL.Input, A = RL.Audio, At = RL.Atmosphere;
    return (I && I.settings ? (I.settings.invertPitch ? 1 : 0) + '|' + I.settings.sensitivity : '') + '|' +
      (I && I.mouseFlight !== false ? 1 : 0) + '|' + (A && A.muted ? 1 : 0) + '|' + (At ? At.name : '');
  }

  // ---- pause ----------------------------------------------------------------------------
  function buildPause() {
    var p = h('div', 'rl-layer rl-center rl-pause');
    var panel = h('div', 'rl-panel rl-menu rl-interactive');
    panel.appendChild(h('div', 'rl-kicker', 'Ridgeline'));
    panel.appendChild(h('h2', 'rl-menu-title', 'Paused'));
    var btns = h('div', 'rl-menu-btns');
    btns.appendChild(button('Resume', 'rl-btn-primary', function () { action('pause'); lock(); }));
    btns.appendChild(button('Restart course', '', function () { action('reset'); lock(); }));
    btns.appendChild(button('Controls &amp; stunts', 'rl-btn-ghost', function () { toggleHelp(); }));
    panel.appendChild(btns);
    panel.appendChild(h('div', 'rl-section-title', 'Options'));
    panel.appendChild(buildOptions());
    panel.appendChild(h('div', 'rl-menu-foot', '<kbd>P</kbd> / <kbd>Esc</kbd> resume &nbsp;·&nbsp; <kbd>R</kbd> restart &nbsp;·&nbsp; <kbd>H</kbd> help'));
    p.appendChild(panel);
    root.appendChild(p);
    el.pause = p;
  }

  // ---- crash ----------------------------------------------------------------------------
  function buildCrash() {
    var c = h('div', 'rl-layer rl-crash');
    var panel = h('div', 'rl-panel rl-crash-panel');
    el.crashKicker = h('div', 'rl-kicker rl-bad', 'Crashed');
    el.crashLabel = h('h2', 'rl-crash-label', '');
    el.crashTip = h('p', 'rl-crash-tip', '');
    el.crashStats = h('div', 'rl-crash-stats', '');
    el.crashPrompt = h('div', 'rl-crash-prompt', 'Press <kbd>R</kbd> or click to respawn');
    panel.appendChild(el.crashKicker);
    panel.appendChild(el.crashLabel);
    panel.appendChild(el.crashTip);
    panel.appendChild(el.crashStats);
    panel.appendChild(el.crashPrompt);
    c.appendChild(panel);
    root.appendChild(c);
    el.crash = c;
  }

  function fillCrash() {
    var G = game();
    if (!G) return;
    var cr = G.crash || {};
    el.crashLabel.textContent = cr.label || 'Crashed';
    el.crashTip.textContent = cr.tip || '';
    var c = G.course || {};
    var total = c.total || (RL.Rings && RL.Rings.total) || 0;
    el.crashStats.innerHTML =
      stat('Score', fmtInt(G.score)) +
      stat('Rings', (RL.Rings ? RL.Rings.current : c.ringsPassed || 0) + ' / ' + total) +
      stat('Flight time', fmtTime(G.flightTime || 0));
  }
  function stat(l, v) { return '<div class="rl-stat"><div class="rl-stat-v">' + esc(v) + '</div><div class="rl-stat-l">' + l + '</div></div>'; }

  // ---- results --------------------------------------------------------------------------
  function buildResults() {
    var r = h('div', 'rl-layer rl-center rl-results');
    var panel = h('div', 'rl-panel rl-results-panel rl-interactive');
    el.resBody = h('div', 'rl-res-body');
    panel.appendChild(el.resBody);
    var btns = h('div', 'rl-menu-btns rl-row');
    btns.appendChild(button('Fly again', 'rl-btn-primary', function () { action('reset'); lock(); }));
    btns.appendChild(button('Keep flying', '', function () {
      var G = game();
      if (G && G.dismissResults) G.dismissResults();
      if (G && G.state === 'paused') action('pause');
      lock();
    }));
    panel.appendChild(btns);
    panel.appendChild(h('div', 'rl-menu-foot', '<kbd>R</kbd> fly again &nbsp;·&nbsp; <kbd>Enter</kbd> keep flying &nbsp;·&nbsp; <kbd>Esc</kbd> free the mouse'));
    r.appendChild(panel);
    root.appendChild(r);
    el.results = r;
  }

  function fillResults(res) {
    var G = game();
    var medal = res.medal;
    var medalHtml = medal
      ? '<div class="rl-medal rl-medal-' + medal + '"><span>' + medal.toUpperCase() + '</span></div>'
      : '<div class="rl-medal rl-medal-none"><span>FINISH</span></div>';
    var par = res.par || {};
    var L = res.landing;
    var landingTxt = L ? esc(L.label) + ' <span class="rl-dim">' + Math.round(Math.abs(L.fpm || 0)) + ' fpm</span>' : '—';
    var stunts = res.stunts && res.stunts.length ? res.stunts : null;
    var chips = '';
    if (stunts) {
      var counts = {}, order = [];
      stunts.forEach(function (s) { if (!counts[s]) { counts[s] = 0; order.push(s); } counts[s]++; });
      chips = order.map(function (s) {
        return '<span class="rl-stunt-chip">' + esc(s) + (counts[s] > 1 ? ' ×' + counts[s] : '') + '</span>';
      }).join('');
    }
    el.resBody.innerHTML =
      '<div class="rl-res-head">' + medalHtml +
        '<div><div class="rl-kicker">Course complete</div>' +
        '<div class="rl-res-time">' + fmtTime(res.time) + (res.record ? '<span class="rl-badge">New record</span>' : '') + '</div>' +
        '<div class="rl-dim rl-res-par">Gold ' + fmtTime(par.gold) + ' · Silver ' + fmtTime(par.silver) + ' · Bronze ' + fmtTime(par.bronze) +
        (res.best > 0 && !res.record ? ' · Best ' + fmtTime(res.best) : '') + '</div></div>' +
      '</div>' +
      '<div class="rl-res-grid">' +
        '<div class="rl-res-k">Rings</div><div class="rl-res-v">' + res.rings + ' / ' + res.total + '</div>' +
        '<div class="rl-res-k">Landing</div><div class="rl-res-v">' + landingTxt + '</div>' +
        '<div class="rl-res-k">Stunts</div><div class="rl-res-v">' + (stunts ? stunts.length + '<div class="rl-stunt-chips">' + chips + '</div>' : '<span class="rl-dim">None this time. Press H for the stunt book.</span>') + '</div>' +
      '</div>' +
      '<div class="rl-res-score"><div class="rl-kicker">Score</div><div class="rl-res-score-v">' + fmtInt(res.score) + '</div>' +
        (res.recordScore ? '<span class="rl-badge">New high score</span>' : '<span class="rl-dim">Best ' + fmtInt(G && G.best ? G.best.score : res.bestScore) + '</span>') +
      '</div>';
  }

  // ---- help -----------------------------------------------------------------------------
  function buildHelp() {
    var hp = h('div', 'rl-layer rl-center rl-help');
    var panel = h('div', 'rl-panel rl-help-panel rl-interactive');
    var close = button('&times;', 'rl-close', function () { toggleHelp(); });
    close.setAttribute('aria-label', 'Close help');
    panel.appendChild(close);
    panel.appendChild(h('div', 'rl-kicker', 'Ridgeline'));
    panel.appendChild(h('h2', 'rl-menu-title', 'Controls &amp; stunt book'));
    var cols = h('div', 'rl-help-cols');
    cols.appendChild(h('div', 'rl-help-col',
      '<div class="rl-section-title">Flying</div><div class="rl-keys">' +
      row('Mouse move', 'Virtual stick: pitch &amp; roll (click to capture)') +
      row('Mouse wheel', 'Throttle') +
      row('<kbd>W</kbd> <kbd>S</kbd>', 'Throttle up / down') +
      row('<kbd>↑</kbd> <kbd>↓</kbd>', 'Pitch down / up') +
      row('<kbd>←</kbd> <kbd>→</kbd> <kbd>Q</kbd> <kbd>E</kbd>', 'Roll left / right') +
      row('<kbd>A</kbd> <kbd>D</kbd>', 'Rudder, nose-wheel steering') +
      row('<kbd>Space</kbd>', 'Wheel brakes') +
      row('<kbd>F</kbd>', 'Flaps 0 → 1 → 2') +
      row('<kbd>G</kbd>', 'Landing gear') +
      row('Middle click / <kbd>X</kbd>', 'Center the stick') +
      row('<kbd>V</kbd>', 'Mouse flight on / off') +
      row('<kbd>I</kbd>', 'Invert mouse pitch') +
      '</div>'));
    cols.appendChild(h('div', 'rl-help-col',
      '<div class="rl-section-title">View &amp; game</div><div class="rl-keys">' +
      row('Right mouse + move', 'Look around') +
      row('Left mouse / <kbd>Shift</kbd>', 'Skywriting smoke (hold)') +
      row('<kbd>T</kbd>', 'Smoke colour') +
      row('<kbd>C</kbd>', 'Camera: chase, cockpit, orbit, tower, flyby') +
      row('<kbd>N</kbd>', 'Time of day') +
      row('<kbd>U</kbd>', 'Hide / show HUD') +
      row('<kbd>M</kbd>', 'Mute') +
      row('<kbd>R</kbd>', 'Respawn / restart course') +
      row('<kbd>P</kbd> / <kbd>Esc</kbd>', 'Pause') +
      row('<kbd>H</kbd> / <kbd>F1</kbd>', 'This help') +
      '</div>' +
      '<div class="rl-section-title">Flying tips</div><ul class="rl-tips">' +
      '<li>Full throttle and keep straight with A / D (the mouse steers too). At about 60 kt tap ↓ to lift the nose to 10°, then gear up.</li>' +
      '<li>The clock starts at ring 1. Pass close to the centre for a bullseye.</li>' +
      '<li>To land: below 80 kt, flaps twice, gear down, flare just above the runway.</li>' +
      '<li>Chain rings and stunts within 12 s to build a combo multiplier.</li>' +
      '</ul>'));
    var book = '<div class="rl-section-title">Stunt book</div><div class="rl-stunts">' +
      stunt('Barrel roll', 'A full 360° roll in under 6 s', 150) +
      stunt('Loop the loop', 'A full loop, wings level', 250) +
      stunt('Inverted flight', 'Upside down for 3 s', 200) +
      stunt('Knife edge', 'Wings vertical for 2.5 s', 200) +
      stunt('Low pass', 'Along the runway, < 15 m, > 100 kt (gear up ×1.5)', 300) +
      stunt('Thread the needle', 'Fly under the Needle Arch', 500) +
      stunt('Canyon run', 'Most of Serpent Canyon below the rim', 600) +
      stunt('Thermal rider', 'Climb 150 m in a thermal (look for birds)', 250) +
      stunt('Lake skim', 'Under 5 m over Mirror Lake for 3 s', 300) +
      stunt('Butter landing', 'Touch down under 180 fpm on the centreline', 1000) +
      '</div>';
    cols.appendChild(h('div', 'rl-help-col rl-help-book', book));
    panel.appendChild(cols);
    panel.appendChild(h('div', 'rl-menu-foot', '<kbd>H</kbd> or <kbd>Esc</kbd> to close'));
    hp.appendChild(panel);
    root.appendChild(hp);
    el.help = hp;
  }
  function stunt(name, how, pts) {
    return '<div class="rl-stunt"><div class="rl-stunt-n">' + name + '</div><div class="rl-stunt-h">' + how +
      '</div><div class="rl-stunt-p">+' + pts + '</div></div>';
  }

  function toggleHelp() {
    var G = game();
    UI.helpOpen = !UI.helpOpen;
    if (UI.helpOpen) {
      if (G && G.state === 'playing' && G.setPaused) { G.setPaused(true); pausedByHelp = true; }
    } else if (pausedByHelp) {
      pausedByHelp = false;
      if (G && G.state === 'paused' && G.setPaused) G.setPaused(false);
    }
    sync();
    return UI.helpOpen;
  }

  // ---- toasts ---------------------------------------------------------------------------
  function toast(textStr, kind, duration) {
    if (!textStr || !el.toasts) return;
    kind = kind || 'info';
    var ms = Math.max(0.8, Math.min(8, +duration || 2.2)) * 1000;
    var lastT = toasts[toasts.length - 1];
    if (lastT && lastT.text === textStr && !lastT.dead) {
      clearTimeout(lastT.timer);
      lastT.node.classList.remove('bump'); void lastT.node.offsetWidth; lastT.node.classList.add('bump');
      lastT.timer = setTimeout(function () { removeToast(lastT); }, ms);
      return;
    }
    var n = h('div', 'rl-toast rl-toast-' + kind);
    n.textContent = textStr;
    el.toasts.appendChild(n);
    var t = { text: textStr, node: n, dead: false, timer: 0 };
    toasts.push(t);
    requestAnimationFrame(function () { n.classList.add('in'); });
    t.timer = setTimeout(function () { removeToast(t); }, ms);
    while (toasts.length > 4) removeToast(toasts[0], true);
  }
  function removeToast(t, fast) {
    if (t.dead) return;
    t.dead = true;
    clearTimeout(t.timer);
    var i = toasts.indexOf(t);
    if (i >= 0) toasts.splice(i, 1);
    t.node.classList.remove('in');
    t.node.classList.add('out');
    setTimeout(function () { if (t.node.parentNode) t.node.parentNode.removeChild(t.node); }, fast ? 150 : 350);
  }

  // ------------------------------------------------------------------ per-frame sync
  function loop() {
    requestAnimationFrame(loop);
    try { sync(); } catch (e) { /* never break the page over a panel */ }
  }

  function sync() {
    var G = game();
    var state = G ? G.state : 'title';
    var res = G && G.results && !G.results.dismissed ? G.results : null;
    var help = UI.helpOpen;

    if (state !== last.state) {
      if (state === 'title') refreshRecords();
      if (state === 'crashed') fillCrash();
      if (state === 'paused' || state === 'title') refreshOptions();
      root.setAttribute('data-state', state);
      last.state = state;
    }
    if ((state === 'paused' || state === 'title') && !help && settingsSig() !== optionsSig) refreshOptions();
    if (res && res !== last.results) { fillResults(res); last.results = res; }
    var showResults = !!res && !help && (state === 'playing' || state === 'paused');
    var crashReady = state === 'crashed' && !!(G && G.crash && G.crash.ready);

    show(el.title, state === 'title' && !help);
    show(el.pause, state === 'paused' && !help && !showResults);
    show(el.crash, state === 'crashed');
    if (crashReady !== last.crashReady) {
      el.crash.classList.toggle('ready', crashReady);
      last.crashReady = crashReady;
    }
    show(el.results, showResults);
    el.results.classList.toggle('interactive', state === 'paused' || !(RL.Input && RL.Input.pointerLocked));
    show(el.help, help);
    el.vignette.classList.toggle('dim', state === 'paused' || help || showResults);
    el.vignette.classList.toggle('crashed', state === 'crashed');
  }

  RL.UI = UI;
})(window.RL = window.RL || {});
