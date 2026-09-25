/*
 * Ridgeline — RL.Input: mouse + keyboard flight controls.
 *
 *   init(canvas), update(dt), consumeActions() -> [names]
 *   controls {pitch, roll, yaw, throttle, brake, smoke}   (pitch + = nose up, roll + = right,
 *                                                          yaw + = nose right)
 *   stick {x, y}        virtual stick for the HUD, unit disc (x + = roll right, y + = pull/nose up)
 *   look {yaw, pitch, active, dYaw, dPitch}   free look (radians; yaw + = look right, pitch + =
 *                       look up). dYaw/dPitch are this frame's raw deltas (orbit camera).
 *   pointerLocked, pointerFallback, mouseFlight, settings {invertPitch, sensitivity, stickReturn}
 *   setThrottle(v), requestPointerLock(), exitPointerLock(), centerStick()
 *
 * Mouse flight works like a physical stick: mouse motion moves the stick, it stays where you
 * leave it and drifts gently back to center once the mouse is idle (settings.stickReturn), so
 * holding a turn needs only small corrections. An expo curve gives fine control near center.
 * Keys ramp smoothly and take over their axis while held (the mouse stick on that axis is
 * zeroed so releasing a key never snaps back to a stale mouse position). A pitch key starts as a
 * moderate input and only grows to full deflection when held on, so holding it gives a partial
 * pull (flare, steady climb) while a long hold still loops; [ / ] add a persistent pitch trim.
 */
(function (RL) {
  'use strict';
  var M = RL.M;

  var STORE_KEY = 'ridgeline.input.v1';
  var FULL_DEFLECTION_PX = 340;   // mouse travel (CSS px) for full stick at sensitivity 1
  var EXPO = 0.45;                // 0 = linear, 1 = pure cubic
  var IDLE_BEFORE_RETURN = 0.18;  // s without mouse motion before auto-centering starts
  var LOOK_RAD_PER_PX = 0.0042;
  var LOOK_MAX_YAW = 2.7, LOOK_MAX_PITCH = 1.25;
  var FALLBACK_DEADZONE = 0.06;
  var FALLBACK_ARM_RADIUS = 0.15;  // no-lock mode: cursor must come this close to center to fly
  var LOCK_COOLDOWN = 2.0;         // s after losing the lock during which a refusal may be temporary
  // keyboard axes: attack rates (per s) — roll is slower so an ordinary press is a normal bank
  var KEY_ATTACK = 3.6, KEY_ROLL_ATTACK = 2.2;
  var PITCH_KEY_SOFT = 0.45;                          // pitch key level for the first moments
  var PITCH_KEY_GROW0 = 1.0, PITCH_KEY_GROW1 = 2.5;   // held this long (s) it grows to full
  var TRIM_STEP = 0.04, TRIM_MAX = 0.4;

  // key code -> discrete action (queued once per physical press)
  var ACTION_KEYS = {
    Enter: 'start', NumpadEnter: 'start',
    KeyP: 'pause', Escape: 'pause',
    KeyR: 'reset', KeyF: 'flaps', KeyG: 'gear', KeyC: 'camera', KeyT: 'smokeColor',
    KeyN: 'timeOfDay', KeyH: 'help', F1: 'help', KeyM: 'mute', KeyU: 'hud',
    KeyX: 'centerStick', KeyI: 'invertPitch', KeyV: 'mouseFlight',
    BracketLeft: 'trimDown', BracketRight: 'trimUp'
  };
  // handled inside Input, never queued for main.js
  var INTERNAL_ACTIONS = { centerStick: 1, invertPitch: 1, mouseFlight: 1, trimDown: 1, trimUp: 1 };
  // keys held for continuous controls
  var HOLD_KEYS = {
    ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1, KeyQ: 1, KeyE: 1, KeyA: 1, KeyD: 1,
    KeyW: 1, KeyS: 1, Space: 1, ShiftLeft: 1, ShiftRight: 1
  };

  var canvas = null;
  var keys = {};
  var btn = { left: false, right: false, middle: false };
  var smokeFromLock = false;        // the LMB press that grabbed the lock must not puff smoke
  var gestureSent = false;
  var queue = [], outQueue = [];
  var lastPauseAt = -1;
  var now = 0;                       // accumulated real time (s), for dedupe / idle timers

  // mouse state accumulated between frames
  var accDX = 0, accDY = 0, wheelAcc = 0;
  var mouseIdle = 0;
  var mouseX = -1, mouseY = -1;      // last client position (fallback mode)
  var lockSupported = false;
  var lockClickFailures = 0, lockRequestFromClick = false, lastLockRequestAt = -10;
  var lastUnlockAt = -1e9;           // wall-clock s when the pointer lock was last lost
  var fallbackArmed = false, fallbackHintAt = -1;
  var prevState = null;

  // stick (raw virtual stick, unit disc) and smoothed key axes
  var raw = { x: 0, y: 0 };
  var keyAxis = { pitch: 0, roll: 0, yaw: 0 };
  var keyWeight = { pitch: 0, roll: 0 };
  var pitchHold = 0, pitchHoldDir = 0;   // how long (s) a pitch key has been held, and which way

  var Input = {
    controls: { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0, smoke: false },
    stick: { x: 0, y: 0 },
    look: { yaw: 0, pitch: 0, active: false, dYaw: 0, dPitch: 0 },
    pointerLocked: false,
    pointerFallback: false,
    fallbackArmed: false,           // no-lock mode: false until the cursor has been re-centred
    mouseFlight: true,
    trim: 0,                        // persistent pitch trim added to controls.pitch (-0.4..0.4)
    throttleTarget: 0,
    settings: { invertPitch: false, sensitivity: 1.0, stickReturn: 0.7 },

    init: init,
    update: update,
    consumeActions: consumeActions,
    setThrottle: setThrottle,
    requestPointerLock: requestPointerLock,
    exitPointerLock: exitPointerLock,
    centerStick: centerStick,
    saveSettings: saveSettings
  };

  // ------------------------------------------------------------------ helpers
  function gameState() { return (RL.Game && RL.Game.state) || 'title'; }
  function fin(x, d) { return (typeof x === 'number' && isFinite(x)) ? x : d; }
  // Wall-clock seconds: lock cool-downs run in real time even when the frame rate is poor.
  function wallNow() {
    return ((window.performance && performance.now) ? performance.now() : Date.now()) / 1000;
  }

  function toast(text, kind, duration) {
    if (RL.Events) RL.Events.emit('message', { text: text, kind: kind || 'info', duration: duration || 1.6 });
  }

  function queueAction(name) {
    if (name === 'pause') {
      // Esc can arrive both as a keydown and as a pointer-lock loss: count it once.
      if (lastPauseAt >= 0 && now - lastPauseAt < 0.35) return;
      lastPauseAt = now;
    }
    if (queue.length < 32) queue.push(name);
  }

  function gesture() {
    if (gestureSent) return;
    gestureSent = true;
    if (RL.Events) RL.Events.emit('userGesture', {});
  }

  // Only fields that take typed text swallow flight keys; a focused slider or checkbox must not.
  var TEXT_INPUTS = { text: 1, search: 1, email: 1, number: 1, password: 1, url: 1, tel: 1 };
  function isTextTarget(t) {
    if (!t || !t.tagName) return false;
    var n = t.tagName;
    if (n === 'INPUT') return !!TEXT_INPUTS[(t.type || 'text').toLowerCase()];
    return n === 'TEXTAREA' || n === 'SELECT' || !!t.isContentEditable;
  }

  function loadSettings() {
    try {
      var s = window.localStorage && window.localStorage.getItem(STORE_KEY);
      if (!s) return;
      var o = JSON.parse(s);
      if (typeof o.invertPitch === 'boolean') Input.settings.invertPitch = o.invertPitch;
      Input.settings.sensitivity = M.clamp(fin(o.sensitivity, 1), 0.2, 4);
      Input.settings.stickReturn = M.clamp(fin(o.stickReturn, 0.7), 0, 5);
      if (typeof o.mouseFlight === 'boolean') Input.mouseFlight = o.mouseFlight;
    } catch (e) { /* storage blocked: keep defaults */ }
  }

  function saveSettings() {
    try {
      if (!window.localStorage) return;
      window.localStorage.setItem(STORE_KEY, JSON.stringify({
        invertPitch: Input.settings.invertPitch,
        sensitivity: Input.settings.sensitivity,
        stickReturn: Input.settings.stickReturn,
        mouseFlight: Input.mouseFlight
      }));
    } catch (e) { /* ignore */ }
  }

  function clampDisc(s) {
    var l = s.x * s.x + s.y * s.y;
    if (l > 1) { l = 1 / Math.sqrt(l); s.x *= l; s.y *= l; }
  }

  // Expo curve: gentle near center, full authority at the edge.
  function expo(v) {
    var a = Math.abs(v);
    return (v < 0 ? -1 : 1) * (EXPO * a * a * a + (1 - EXPO) * a);
  }

  // Map the round stick gate to a square so full pitch + full roll is reachable on diagonals.
  var sq = { x: 0, y: 0 };
  function discToSquare(x, y) {
    var m = Math.max(Math.abs(x), Math.abs(y));
    var l = Math.sqrt(x * x + y * y);
    var k = m > 1e-6 ? l / m : 1;
    sq.x = M.clamp(x * k, -1, 1);
    sq.y = M.clamp(y * k, -1, 1);
    return sq;
  }

  // ------------------------------------------------------------------ public actions
  function setThrottle(v) {
    v = M.clamp(fin(v, 0), 0, 1);
    Input.throttleTarget = v;
    Input.controls.throttle = v;
  }

  function centerStick() {
    raw.x = 0; raw.y = 0;
    accDX = 0; accDY = 0;
    Input.trim = 0;
  }

  function setTrim(v) {
    Input.trim = Math.round(M.clamp(fin(v, 0), -TRIM_MAX, TRIM_MAX) / TRIM_STEP) * TRIM_STEP;
    var pct = Math.round(Input.trim * 100);
    toast(pct === 0 ? 'Pitch trim neutral' : 'Pitch trim ' + Math.abs(pct) + '% nose ' + (pct > 0 ? 'up' : 'down'));
  }

  function lockElement() {
    return document.pointerLockElement || document.mozPointerLockElement || null;
  }

  /**
   * fromGesture: true when called from a click/key handler, false for automatic retries. Left
   * out, the browser's user-activation state decides, so UI buttons calling requestPointerLock()
   * still count their refusals (which is what switches to the no-lock fallback).
   */
  function requestPointerLock(fromGesture) {
    if (!canvas || !lockSupported || lockElement() === canvas) return;
    var ua = navigator.userActivation;
    lockRequestFromClick = fromGesture === true || (fromGesture === undefined && !!(ua && ua.isActive));
    lastLockRequestAt = now;
    try {
      var r = (canvas.requestPointerLock || canvas.mozRequestPointerLock).call(canvas);
      // Newer browsers return a promise that rejects (e.g. right after Esc); never let that leak.
      if (r && typeof r.catch === 'function') r.catch(onLockError);
    } catch (e) { onLockError(); }
  }

  function exitPointerLock() {
    try {
      if (lockElement() && document.exitPointerLock) document.exitPointerLock();
    } catch (e) { /* ignore */ }
  }

  function handleInternal(name) {
    if (name === 'centerStick') {
      centerStick();
      toast('Stick and trim centered');
    } else if (name === 'trimUp' || name === 'trimDown') {
      if (gameState() === 'playing') setTrim(Input.trim + (name === 'trimUp' ? TRIM_STEP : -TRIM_STEP));
    } else if (name === 'invertPitch') {
      Input.settings.invertPitch = !Input.settings.invertPitch;
      saveSettings();
      toast(Input.settings.invertPitch ? 'Mouse pitch inverted (push forward = climb)' : 'Mouse pitch normal (pull back = climb)');
    } else if (name === 'mouseFlight') {
      Input.mouseFlight = !Input.mouseFlight;
      centerStick();
      saveSettings();
      if (Input.mouseFlight) {
        if (gameState() === 'playing') requestPointerLock(true);
        toast('Mouse flight on');
      } else {
        exitPointerLock();
        toast('Mouse flight off: keyboard only');
      }
    }
  }

  // ------------------------------------------------------------------ DOM events
  function onKeyDown(e) {
    if (isTextTarget(e.target)) return;
    gesture();
    if (e.ctrlKey || e.metaKey || e.altKey) return;   // never hijack browser/OS shortcuts
    var code = e.code || '';
    var action = ACTION_KEYS[code];
    if (action || HOLD_KEYS[code]) e.preventDefault();
    if (e.repeat || keys[code]) return;               // key repeat never re-triggers
    keys[code] = true;
    if (!action) return;
    if (INTERNAL_ACTIONS[action]) {
      handleInternal(action);
      return;
    }
    // (not when this Enter only closes help on the title, or the crash prompt isn't up yet: the
    // state stays put, so the capture would never be released)
    var st = gameState();
    var noStart = (st === 'title' && RL.UI && RL.UI.helpOpen) ||
      (st === 'crashed' && RL.Game && RL.Game.crash && !RL.Game.crash.ready);
    if (action === 'start' && lockSupported && Input.mouseFlight && st !== 'playing' && !noStart) {
      // Enter is a user gesture: grab the mouse now so flight can begin immediately.
      requestPointerLock(true);
    }
    queueAction(action);
  }

  function onKeyUp(e) {
    var code = e.code || '';
    keys[code] = false;
    if (ACTION_KEYS[code] || HOLD_KEYS[code]) {
      if (!e.ctrlKey && !e.metaKey && !e.altKey && !isTextTarget(e.target)) e.preventDefault();
    }
  }

  function onMouseDown(e) {
    gesture();
    var onCanvas = e.target === canvas || Input.pointerLocked;
    // A click on a menu leaves the cursor wherever that button was: in no-lock mode that spot
    // must not become a stick deflection, so wait for the cursor to come back to center.
    if (!onCanvas) fallbackArmed = false;
    if (e.button === 1) {
      if (onCanvas) { e.preventDefault(); centerStick(); }
      btn.middle = true;
      return;
    }
    if (e.button === 2) {
      if (onCanvas) { btn.right = true; e.preventDefault(); }
      return;
    }
    if (e.button !== 0 || !onCanvas) return;
    btn.left = true;
    var st = gameState();
    if (st === 'title') {
      queueAction('start');
      if (Input.mouseFlight) { smokeFromLock = true; requestPointerLock(true); }
    } else if (st === 'playing' && Input.mouseFlight && lockSupported && !Input.pointerLocked) {
      smokeFromLock = true;
      requestPointerLock(true);
    }
  }

  function onMouseUp(e) {
    if (e.button === 0) { btn.left = false; smokeFromLock = false; }
    else if (e.button === 1) btn.middle = false;
    else if (e.button === 2) btn.right = false;
  }

  function onMouseMove(e) {
    var dx = fin(e.movementX, 0), dy = fin(e.movementY, 0);
    // Some browsers report absurd spikes on the first locked event; ignore them.
    if (Math.abs(dx) > 400 || Math.abs(dy) > 400) { dx = 0; dy = 0; }
    accDX += dx; accDY += dy;
    mouseX = e.clientX; mouseY = e.clientY;
  }

  function onWheel(e) {
    var t = e.target;
    var ours = Input.pointerLocked || t === canvas || t === document.body ||
      t === document.documentElement || (t && (t.id === 'hud' || t.id === 'ui-root'));
    if (!ours) return;   // let scrollable UI panels scroll
    e.preventDefault();
    var d = fin(e.deltaY, 0);
    if (e.deltaMode === 1) d *= 33;          // lines
    else if (e.deltaMode === 2) d *= 400;    // pages
    wheelAcc += M.clamp(d, -300, 300);
  }

  function onContextMenu(e) { if (e.target === canvas || Input.pointerLocked) e.preventDefault(); }

  function onLockChange() {
    var locked = lockElement() === canvas;
    var was = Input.pointerLocked;
    Input.pointerLocked = locked;
    if (locked) {
      Input.pointerFallback = false;
      lockClickFailures = 0;
      accDX = 0; accDY = 0;
    } else if (was) {
      // Browsers swallow Esc while locked: losing the lock mid-flight means "pause".
      lastUnlockAt = wallNow();
      btn.left = btn.right = btn.middle = false;
      if (gameState() === 'playing') queueAction('pause');
    }
  }

  function onLockError() {
    // (a duplicate request refused after another one already got the lock is no failure)
    if (lockRequestFromClick && lockElement() !== canvas) {
      lockClickFailures++;
      // A refusal right after losing the lock can be the browser's cool-down after Esc, so then
      // it takes two; otherwise one refusal of a real click means it won't lock (e.g. sandboxed
      // iframe) and the cursor-offset fallback takes over at once.
      var coolingDown = wallNow() - lastUnlockAt < LOCK_COOLDOWN;
      if (lockClickFailures >= 2 || !coolingDown) {
        if (!Input.pointerFallback) { fallbackArmed = false; fallbackHintAt = now + 0.8; }
        Input.pointerFallback = true;
      }
    }
    lockRequestFromClick = false;
  }

  function releaseAll() {
    for (var k in keys) keys[k] = false;
    btn.left = btn.right = btn.middle = false;
    smokeFromLock = false;
    accDX = 0; accDY = 0; wheelAcc = 0;
  }

  // ------------------------------------------------------------------ init
  function init(cv) {
    canvas = cv || document.getElementById('gl');
    loadSettings();
    lockSupported = !!(canvas && (canvas.requestPointerLock || canvas.mozRequestPointerLock));
    Input.pointerFallback = !lockSupported;
    window.addEventListener('keydown', onKeyDown, false);
    window.addEventListener('keyup', onKeyUp, false);
    window.addEventListener('mousedown', onMouseDown, false);
    window.addEventListener('mouseup', onMouseUp, false);
    window.addEventListener('mousemove', onMouseMove, false);
    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('contextmenu', onContextMenu, false);
    window.addEventListener('blur', releaseAll, false);
    document.addEventListener('visibilitychange', function () { if (document.hidden) releaseAll(); });
    document.addEventListener('pointerlockchange', onLockChange, false);
    document.addEventListener('mozpointerlockchange', onLockChange, false);
    document.addEventListener('pointerlockerror', onLockError, false);
    document.addEventListener('mozpointerlockerror', onLockError, false);
    // a fresh flight starts untrimmed (R respawns without leaving the 'playing' state)
    if (RL.Events) RL.Events.on('respawn', function () { Input.trim = 0; });
    // touch taps still count as a gesture (audio unlock) even though flight needs a mouse
    window.addEventListener('touchstart', gesture, { passive: true });
  }

  // ------------------------------------------------------------------ per-frame update
  // Smooth key ramp: quick attack, quicker release, instant-ish reversal.
  function rampAxis(cur, target, dt, attack) {
    var rate;
    if (target === 0) rate = 6.5;
    else if (cur * target < 0) rate = 9;
    else rate = attack;
    return M.approach(cur, target, rate * dt);
  }

  function keyTarget(neg, neg2, pos, pos2) {
    var v = 0;
    if (keys[neg] || (neg2 && keys[neg2])) v -= 1;
    if (keys[pos] || (pos2 && keys[pos2])) v += 1;
    return v;
  }

  function update(dt) {
    dt = M.clamp(fin(dt, 0), 0, 0.1);
    now += dt;
    var st = gameState();
    var s = Input.settings;
    var c = Input.controls;
    var look = Input.look;

    // Leaving the flight state releases the mouse so menus are clickable; coming back (e.g.
    // unpause with P, a recent user gesture) tries to grab it again.
    Input.pointerLocked = lockElement() === canvas;
    if (st !== prevState) {
      if (st !== 'playing' && Input.pointerLocked) exitPointerLock();
      if (st === 'playing' && prevState !== null && Input.mouseFlight && !Input.pointerLocked &&
          now - lastLockRequestAt > 0.5) {   // (a click/Enter may already have asked)
        requestPointerLock(false);
      }
      if (st === 'playing' && prevState === 'title') centerStick();
      if (st === 'title' || st === 'crashed') Input.trim = 0;
      if (st === 'playing') { fallbackArmed = false; fallbackHintAt = now + 0.8; }
      prevState = st;
    }

    var dx = accDX, dy = accDY;
    accDX = 0; accDY = 0;
    var moved = dx !== 0 || dy !== 0;

    // ---- free look (RMB) — mouse motion looks around instead of flying
    look.dYaw = 0; look.dPitch = 0;
    look.active = btn.right;
    if (look.active) {
      look.dYaw = dx * LOOK_RAD_PER_PX * s.sensitivity;
      look.dPitch = -dy * LOOK_RAD_PER_PX * s.sensitivity;
      look.yaw = M.clamp(look.yaw + look.dYaw, -LOOK_MAX_YAW, LOOK_MAX_YAW);
      look.pitch = M.clamp(look.pitch + look.dPitch, -LOOK_MAX_PITCH, LOOK_MAX_PITCH);
      dx = 0; dy = 0;
    } else {
      look.yaw = M.damp(look.yaw, 0, 7, dt);
      look.pitch = M.damp(look.pitch, 0, 7, dt);
      if (Math.abs(look.yaw) < 1e-4) look.yaw = 0;
      if (Math.abs(look.pitch) < 1e-4) look.pitch = 0;
    }

    // ---- mouse virtual stick
    var flying = st === 'playing';
    var pitchSign = s.invertPitch ? -1 : 1;   // mouse down (dy > 0) = pull = nose up
    if (Input.mouseFlight && flying && Input.pointerLocked) {
      var k = s.sensitivity / FULL_DEFLECTION_PX;
      raw.x += dx * k;
      raw.y += dy * k * pitchSign;
      clampDisc(raw);
      if (moved && !look.active) mouseIdle = 0; else mouseIdle += dt;
      if (s.stickReturn > 0 && mouseIdle > IDLE_BEFORE_RETURN) {
        // roll recenters a little faster than pitch: a held bank keeps rolling, a held pull
        // only holds a turn, so roll is the axis that needs help settling
        raw.x = M.damp(raw.x, 0, s.stickReturn * 1.4, dt);
        raw.y = M.damp(raw.y, 0, s.stickReturn * 0.6, dt);
      }
    } else if (Input.mouseFlight && flying && Input.pointerFallback && mouseX >= 0 && !look.active) {
      // No pointer lock: the cursor's offset from the screen center is the stick.
      var w = window.innerWidth || 1, h = window.innerHeight || 1;
      var R = 0.42 * Math.min(w, h);
      var fx = (mouseX - w * 0.5) / R, fy = (mouseY - h * 0.5) / R * pitchSign;
      var l = Math.sqrt(fx * fx + fy * fy);
      // Start (or resume) with a neutral stick until the cursor visits the center, so the spot
      // where a menu button sat is not applied as a sudden deflection.
      if (!fallbackArmed && l <= FALLBACK_ARM_RADIUS) fallbackArmed = true;
      if (!fallbackArmed && fallbackHintAt >= 0 && now > fallbackHintAt) {
        fallbackHintAt = -1;
        toast('Move the mouse to the middle of the screen to take control', 'info', 3.5);
      }
      var t = (!fallbackArmed || l <= FALLBACK_DEADZONE) ? 0 : Math.min(1, (l - FALLBACK_DEADZONE) / (1 - FALLBACK_DEADZONE));
      var tx = l > 1e-6 ? fx / l * t : 0, ty = l > 1e-6 ? fy / l * t : 0;
      raw.x = M.damp(raw.x, tx, 25, dt);
      raw.y = M.damp(raw.y, ty, 25, dt);
    } else {
      // menus, paused, mouse flight off: let the stick settle at center
      raw.x = M.damp(raw.x, 0, 8, dt);
      raw.y = M.damp(raw.y, 0, 8, dt);
    }

    // ---- keyboard axes (ramped), overriding the mouse on their axis while held
    var tp = keyTarget('ArrowUp', null, 'ArrowDown', null);          // ↓ = nose up
    var tr = keyTarget('ArrowLeft', 'KeyQ', 'ArrowRight', 'KeyE');
    var ty2 = keyTarget('KeyA', null, 'KeyD', null);
    // a pitch key grows from a moderate to a full input the longer it is held
    if (tp !== 0 && tp === pitchHoldDir) pitchHold += dt; else pitchHold = 0;
    pitchHoldDir = tp;
    var tpMag = PITCH_KEY_SOFT + (1 - PITCH_KEY_SOFT) * M.smoothstep(PITCH_KEY_GROW0, PITCH_KEY_GROW1, pitchHold);
    keyAxis.pitch = rampAxis(keyAxis.pitch, tp * tpMag, dt, KEY_ATTACK);
    keyAxis.roll = rampAxis(keyAxis.roll, tr, dt, KEY_ROLL_ATTACK);
    keyAxis.yaw = rampAxis(keyAxis.yaw, ty2, dt, KEY_ATTACK);
    if (tp !== 0) raw.y = 0;
    if (tr !== 0) raw.x = 0;
    keyWeight.pitch = M.approach(keyWeight.pitch, (tp !== 0 || keyAxis.pitch !== 0) ? 1 : 0, 8 * dt);
    keyWeight.roll = M.approach(keyWeight.roll, (tr !== 0 || keyAxis.roll !== 0) ? 1 : 0, 8 * dt);

    var m = discToSquare(raw.x, raw.y);
    var mouseRoll = expo(m.x), mousePitch = expo(m.y);
    var roll = M.lerp(mouseRoll, keyAxis.roll, keyWeight.roll);
    var pitch = M.lerp(mousePitch, keyAxis.pitch, keyWeight.pitch);

    // On the ground the mouse also steers the nose wheel (fading out by rotation speed), so
    // mouse-only players can taxi and track the centerline without reaching for A/D.
    var yaw = keyAxis.yaw;
    var plane = RL.Game && RL.Game.plane;
    if (ty2 === 0 && plane && plane.onGround && Input.mouseFlight) {
      var gs = fin(plane.groundSpeed, 0);
      yaw = M.clamp(yaw + mouseRoll * (1 - M.smoothstep(12, 32, gs)), -1, 1);
    }

    c.pitch = M.clamp(fin(pitch + Input.trim, 0), -1, 1);
    c.roll = M.clamp(fin(roll, 0), -1, 1);
    c.yaw = M.clamp(fin(yaw, 0), -1, 1);

    // HUD stick: the mouse stick where the mouse is in charge, the key value where keys are.
    Input.stick.x = M.lerp(raw.x, keyAxis.roll, keyWeight.roll);
    Input.stick.y = M.clamp(M.lerp(raw.y, keyAxis.pitch, keyWeight.pitch) + Input.trim, -1, 1);
    Input.fallbackArmed = fallbackArmed;

    // ---- throttle: W/S ramp, wheel steps, output eased so the lever never jumps. Only live in
    // flight: moving it while paused (or scrolling over a menu) would jump the engine on resume.
    if (flying) {
      if (keys.KeyW) Input.throttleTarget += 0.55 * dt;
      if (keys.KeyS) Input.throttleTarget -= 0.55 * dt;
      Input.throttleTarget -= wheelAcc * 0.0005;   // one 100px notch = 5 %
    }
    wheelAcc = 0;
    Input.throttleTarget = M.clamp(fin(Input.throttleTarget, 0), 0, 1);
    c.throttle = M.approach(fin(c.throttle, 0), Input.throttleTarget, 2.5 * dt);

    // ---- brake / smoke
    c.brake = M.approach(c.brake, keys.Space ? 1 : 0, (keys.Space ? 5 : 8) * dt);
    var lmbSmoke = btn.left && !smokeFromLock && (Input.pointerLocked || Input.pointerFallback || !Input.mouseFlight);
    c.smoke = flying && (lmbSmoke || !!keys.ShiftLeft || !!keys.ShiftRight);
  }

  /** Returns the actions queued since the last call (the array is reused next call). */
  function consumeActions() {
    var q = outQueue;
    q.length = 0;
    outQueue = queue;
    queue = q;
    return outQueue;
  }

  RL.Input = Input;
})(window.RL = window.RL || {});
