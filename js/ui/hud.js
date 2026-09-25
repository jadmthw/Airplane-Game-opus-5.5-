/*
 * Ridgeline — RL.HUD: the glass-cockpit overlay, drawn on the 2D canvas above the 3D view.
 *
 *   init(canvas2d), resize(w, h, dpr), draw(dt), toggle()
 *
 * Reads RL.Game (plane, course, score, warnings, hints, popups), RL.Input (virtual stick, pointer
 * lock), RL.CameraRig / RL.frame (projection for the conformal pitch ladder, flight path marker
 * and ring cues), RL.Rings and RL.Terrain (minimap relief, rendered once to an offscreen canvas).
 *
 * Everything is laid out in "design units" (1280x720 reference) and scaled by S = dpr * ui scale,
 * so it is crisp on any display. Scene-overlaid strokes get a soft dark shadow and panels get
 * semi-transparent dark plates, so the HUD reads over bright sky and dark terrain alike.
 * No allocations in the per-frame path besides the unavoidable number -> string conversions.
 */
(function (RL) {
  'use strict';
  var M = RL.M;

  // ------------------------------------------------------------------ palette
  var INK = '#eef4fa', INK_DIM = 'rgba(238,244,250,0.62)', INK_FAINT = 'rgba(238,244,250,0.28)';
  var ACCENT = '#f4b942', WARN = '#ff5b4d', CAUTION = '#ffb02e', GOOD = '#7de38a', CYAN = '#6fd6ff';
  var PLATE = 'rgba(9,15,24,0.4)', PLATE_EDGE = 'rgba(255,255,255,0.09)', BOX = 'rgba(6,10,16,0.86)';
  var SHADOW = 'rgba(0,0,0,0.6)';
  var RING_COL = { current: '#ffa21f', next: '#59d9ff', arch: '#bd75ff', lake: '#33ffd1', final: '#73ff61' };
  var FONT = '"Segoe UI", system-ui, -apple-system, Roboto, "Helvetica Neue", Arial, sans-serif';
  var MONO = 'ui-monospace, "SFMono-Regular", Menlo, Consolas, "Liberation Mono", "DejaVu Sans Mono", monospace';

  // ------------------------------------------------------------------ state
  var cv = null, ctx = null;
  var W = 1, H = 1, dpr = 1, S = 1, cx = 0, cy = 0;
  var visible = true, alpha = 0;
  var F = {};                                   // font strings, rebuilt on resize
  var DASH = [1, 1], NODASH = [];
  var clip = new Float32Array(4);               // projection scratch: sx, sy, w, depth
  var clipB = new Float32Array(4);
  var clipC = new Float32Array(4);
  var time = 0;
  var cockpitView = false;   // set each frame in draw()
  var accelKt = 0, prevKt = -1;
  var hintW = 0, hintKey = '';
  var map = null, mapRes = 0, mapHalf = 6000, mapTries = 0;
  var KT = 1.943844, FT = 3.28084, FPM = 196.8504;

  var HUD = {
    visible: true,
    init: init,
    resize: resize,
    draw: draw,
    toggle: toggle,
    /** Re-render the minimap relief (e.g. after the terrain changes). */
    rebuildMap: function () { map = null; mapTries = 0; }
  };

  // ------------------------------------------------------------------ setup
  function init(canvas2d) {
    cv = canvas2d || document.getElementById('hud');
    if (!cv || !cv.getContext) return;
    ctx = cv.getContext('2d');
    var C = RL.Config;
    if (C && C.units) { KT = C.units.knots; FT = C.units.feet; FPM = C.units.fpm; }
    // main.js may cap the pixel ratio (quality=low): derive it from the canvas it sized
    var pr = cv.clientWidth > 0 && cv.width > 0 ? cv.width / cv.clientWidth : (window.devicePixelRatio || 1);
    resize(cv.width || 1, cv.height || 1, pr);
  }

  function resize(w, h, pr) {
    W = Math.max(1, w | 0); H = Math.max(1, h | 0);
    dpr = pr > 0 ? pr : 1;
    var cssW = W / dpr, cssH = H / dpr;
    var u = M.clamp(Math.min(cssW / 1280, cssH / 720), 0.66, 1.45);
    S = dpr * u;
    cx = W / 2; cy = H / 2;
    F.tiny = '600 ' + (9.5 * S).toFixed(1) + 'px ' + FONT;
    F.small = '600 ' + (11 * S).toFixed(1) + 'px ' + FONT;
    F.label = '700 ' + (12.5 * S).toFixed(1) + 'px ' + FONT;
    F.med = '700 ' + (15 * S).toFixed(1) + 'px ' + FONT;
    F.big = '800 ' + (21 * S).toFixed(1) + 'px ' + FONT;
    F.banner = '900 ' + (46 * S).toFixed(1) + 'px ' + FONT;
    F.warn = '900 ' + (20 * S).toFixed(1) + 'px ' + FONT;
    F.mono = '600 ' + (12 * S).toFixed(1) + 'px ' + MONO;
    F.monoMed = '700 ' + (15 * S).toFixed(1) + 'px ' + MONO;
    F.monoBig = '700 ' + (19 * S).toFixed(1) + 'px ' + MONO;
    F.monoHuge = '700 ' + (26 * S).toFixed(1) + 'px ' + MONO;
    DASH = [5 * S, 4 * S];
    hintKey = '';
  }

  function toggle() {
    visible = !visible;
    HUD.visible = visible;
    if (RL.Events) RL.Events.emit('message', { text: visible ? 'HUD on' : 'HUD hidden (U to show)', kind: 'info', duration: 1.4 });
    return visible;
  }

  // ------------------------------------------------------------------ small helpers
  function fin(x, d) { return (typeof x === 'number' && isFinite(x)) ? x : d; }

  function rr(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  function plate(x, y, w, h, r) {
    rr(x, y, w, h, (r === undefined ? 8 : r) * S);
    ctx.fillStyle = PLATE;
    ctx.fill();
    ctx.lineWidth = 1 * S;
    ctx.strokeStyle = PLATE_EDGE;
    ctx.stroke();
  }

  function text(str, x, y, font, color, align, base) {
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = align || 'left';
    ctx.textBaseline = base || 'alphabetic';
    ctx.fillText(str, x, y);
  }

  function shadowOn(blur) {
    ctx.shadowColor = SHADOW;
    ctx.shadowBlur = (blur || 3) * S;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0.5 * S;
  }
  function shadowOff() { ctx.shadowBlur = 0; ctx.shadowOffsetY = 0; ctx.shadowColor = 'rgba(0,0,0,0)'; }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtTime(t) {
    if (!(t >= 0)) return '-:--.-';
    // round once to tenths before splitting: 59.97 s -> '1:00.0', never '0:60.0'
    var d = Math.round(t * 10), m = Math.floor(d / 600), s = (d - m * 600) / 10;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  }
  function fmtInt(n) {
    n = Math.round(n);
    var neg = n < 0; if (neg) n = -n;
    var s = '' + n;
    if (n >= 1000) {
      var out = '';
      while (s.length > 3) { out = ',' + s.slice(-3) + out; s = s.slice(0, -3); }
      s = s + out;
    }
    return neg ? '-' + s : s;
  }
  function fmtDist(m) { return m < 1000 ? Math.round(m / 10) * 10 + ' m' : (m / 1000).toFixed(1) + ' km'; }

  /** Project world point to HUD pixels. out = [sx, sy, clipW]; returns false when behind. */
  function project(x, y, z, out) {
    var f = RL.frame, m = f && f.viewProj;
    if (!m) return false;
    var px = m[0] * x + m[4] * y + m[8] * z + m[12];
    var py = m[1] * x + m[5] * y + m[9] * z + m[13];
    var pw = m[3] * x + m[7] * y + m[11] * z + m[15];
    out[2] = pw;
    if (!(pw > 1e-3)) return false;
    out[0] = (px / pw * 0.5 + 0.5) * W;
    out[1] = (0.5 - py / pw * 0.5) * H;
    return isFinite(out[0]) && isFinite(out[1]);
  }
  /** Project a direction from the camera (unit vector) far away. */
  function projectDir(dx, dy, dz, out) {
    var c = RL.frame.camPos;
    return project(c[0] + dx * 2000, c[1] + dy * 2000, c[2] + dz * 2000, out);
  }

  // ------------------------------------------------------------------ main draw
  function draw(dt) {
    if (!ctx) return;
    dt = M.clamp(fin(dt, 0.016), 0, 0.1);
    time += dt;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    var G = RL.Game;
    var state = G ? G.state : 'title';
    var p = G && G.plane;
    var target = (visible && p && (state === 'playing' || state === 'paused')) ? 1 : 0;
    alpha = M.damp(alpha, target, target > alpha ? 5 : 9, dt);
    if (alpha < 0.01 || !p || !RL.frame) { if (!map) ensureMap(); return; }
    ensureMap();
    ctx.globalAlpha = alpha;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    var kt = fin(p.airspeed, 0) * KT;
    if (prevKt < 0) prevKt = kt;
    if (dt > 0) accelKt = M.damp(accelKt, (kt - prevKt) / dt, 3, dt);
    prevKt = kt;

    var mode = RL.frame.cameraMode || (RL.CameraRig && RL.CameraRig.mode) || 'chase';
    // In the cockpit the 3D panel already shows airspeed, attitude, altitude, rpm, gear and
    // flaps, so the duplicate tapes/ladder/engine box step aside and leave the view clear.
    cockpitView = mode === 'cockpit';

    if (mode === 'chase') drawAttitude(p, mode);
    drawNav(G, p);
    if (!cockpitView) {
      drawSpeedTape(p, kt);
      drawAltTape(p);
    }
    drawHeadingTape(G, p);
    drawCoursePanel(G);
    drawScorePanel(G);
    if (!cockpitView) drawEnginePanel(p);
    drawMinimap(G, p);
    drawPopups(G);
    drawLanding(G);
    drawWarnings(G);
    drawHint(G);
    drawCaptureHint(G);
    ctx.globalAlpha = 1;
    shadowOff();
  }

  // ------------------------------------------------------------------ attitude (conformal)
  function drawAttitude(p, mode) {
    var hdg = fin(p.heading, 0) * M.DEG;
    var sh = Math.sin(hdg), ch = Math.cos(hdg);
    var pitch = fin(p.pitch, 0);
    var x0 = cx - 250 * S, x1 = cx + 250 * S, y0 = cy - 215 * S, y1 = cy + 200 * S;
    var la = alpha * M.smoothstep(12, 45, fin(p.airspeed, 0) * KT);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip();
    // Chase view: keep the ladder off the aircraft itself (the -10 rung otherwise runs straight
    // through the wings). Cut an ellipse around the projected airframe, aligned with its wings.
    ctx.save();
    if (mode === 'chase') clipAircraftHole(p, x0, y0, x1, y1);
    shadowOn(3);
    ctx.lineWidth = 1.6 * S;
    ctx.strokeStyle = INK;
    // pitch ladder every 10 deg, horizon wider
    var first = Math.max(-80, Math.floor((pitch - 40) / 10) * 10);
    var last = Math.min(80, Math.ceil((pitch + 40) / 10) * 10);
    for (var a = first; a <= last; a += 10) {
      var th = a * M.DEG, ct = Math.cos(th), stt = Math.sin(th);
      if (!projectDir(sh * ct, stt, -ch * ct, clip)) continue;
      // screen direction of "right" at this rung: project a point a little to the right
      if (!projectDir(sh * ct + ch * 0.06, stt, -ch * ct + sh * 0.06, clipB)) continue;
      var ux = clipB[0] - clip[0], uy = clipB[1] - clip[1];
      var ul = Math.hypot(ux, uy);
      if (ul < 1e-3) continue;
      ux /= ul; uy /= ul;
      // normal pointing towards the horizon (down for positive rungs)
      var nx = -uy, ny = ux;
      var horizon = a === 0;
      var half = (horizon ? 240 : 70) * S, gap = (horizon ? 58 : 26) * S, tick = 7 * S;
      var sign = a > 0 ? 1 : -1;
      ctx.globalAlpha = la * (horizon ? 0.95 : 0.8);
      if (a < 0) ctx.setLineDash(DASH);
      ctx.beginPath();
      // left half
      ctx.moveTo(clip[0] - ux * half, clip[1] - uy * half);
      ctx.lineTo(clip[0] - ux * gap, clip[1] - uy * gap);
      // right half
      ctx.moveTo(clip[0] + ux * gap, clip[1] + uy * gap);
      ctx.lineTo(clip[0] + ux * half, clip[1] + uy * half);
      if (!horizon) {
        ctx.moveTo(clip[0] - ux * half, clip[1] - uy * half);
        ctx.lineTo(clip[0] - ux * half + nx * tick * sign, clip[1] - uy * half + ny * tick * sign);
        ctx.moveTo(clip[0] + ux * half, clip[1] + uy * half);
        ctx.lineTo(clip[0] + ux * half + nx * tick * sign, clip[1] + uy * half + ny * tick * sign);
      }
      ctx.stroke();
      if (a < 0) ctx.setLineDash(NODASH);
      if (!horizon) {
        var lbl = '' + a;
        ctx.font = F.tiny;
        ctx.fillStyle = INK;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'right';
        ctx.fillText(lbl, clip[0] - ux * (half + 6 * S), clip[1] - uy * (half + 6 * S));
        ctx.textAlign = 'left';
        ctx.fillText(lbl, clip[0] + ux * (half + 6 * S), clip[1] + uy * (half + 6 * S));
      }
    }
    ctx.globalAlpha = alpha;
    ctx.restore();                                  // drop the aircraft hole (markers go on top)
    shadowOn(3);                                    // the restore also dropped the shadow

    // boresight: where the nose points
    var f = p.forward;
    if (projectDir(f[0], f[1], f[2], clip)) {
      var bx = clip[0], by = clip[1], s = 9 * S;
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 2 * S;
      ctx.beginPath();
      ctx.moveTo(bx - s * 2.2, by);
      ctx.lineTo(bx - s, by);
      ctx.lineTo(bx - s * 0.5, by + s * 0.6);
      ctx.lineTo(bx, by);
      ctx.lineTo(bx + s * 0.5, by + s * 0.6);
      ctx.lineTo(bx + s, by);
      ctx.lineTo(bx + s * 2.2, by);
      ctx.stroke();
    }
    // flight path marker: where the aircraft is actually going
    var v = p.vel, sp = Math.hypot(v[0], v[1], v[2]);
    if (sp > 6 && !p.onGround && projectDir(v[0] / sp, v[1] / sp, v[2] / sp, clip)) {
      var fx = clip[0], fy = clip[1], r = 6.5 * S;
      ctx.strokeStyle = GOOD;
      ctx.lineWidth = 2 * S;
      ctx.beginPath();
      ctx.arc(fx, fy, r, 0, Math.PI * 2);
      ctx.moveTo(fx - r, fy); ctx.lineTo(fx - r * 2.6, fy);
      ctx.moveTo(fx + r, fy); ctx.lineTo(fx + r * 2.6, fy);
      ctx.moveTo(fx, fy - r); ctx.lineTo(fx, fy - r * 2);
      ctx.stroke();
    }
    ctx.restore();
    shadowOff();
  }

  /** Add an even-odd clip that excludes an ellipse around the aircraft's screen footprint. */
  function clipAircraftHole(p, x0, y0, x1, y1) {
    var P = p.pos, r = p.right, half = 5.2;         // a little more than the 4.5 m half-span
    if (!project(P[0], P[1], P[2], clip)) return;
    var ax = clip[0], ay = clip[1];
    if (!project(P[0] + r[0] * half, P[1] + r[1] * half, P[2] + r[2] * half, clipB)) return;
    var wx = clipB[0] - ax, wy = clipB[1] - ay;
    var rx = M.clamp(Math.hypot(wx, wy) + 14 * S, 40 * S, 300 * S);
    var ry = Math.max(rx * 0.38, 26 * S);
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.ellipse(ax, ay, rx, ry, Math.atan2(wy, wx), 0, Math.PI * 2);
    ctx.clip('evenodd');
  }

  // ------------------------------------------------------------------ ring navigation
  function navTarget(G) {
    var R = RL.Rings;
    if (R && R.getCurrent) {
      var r = R.getCurrent();
      if (r) return r;
    }
    return null;
  }

  /** Does the boresight or flight path marker (as drawAttitude places them) touch this box? */
  function markerNear(p, l, t, r, b) {
    var mode = RL.frame.cameraMode || (RL.CameraRig && RL.CameraRig.mode) || 'chase';
    if (mode !== 'chase') return false;             // the only view that draws these markers
    var f = p.forward, v = p.vel, sp = Math.hypot(v[0], v[1], v[2]);
    if (projectDir(f[0], f[1], f[2], clipC) && boxHit(clipC[0], clipC[1], 21 * S, 7 * S, l, t, r, b)) return true;
    return sp > 6 && !p.onGround && projectDir(v[0] / sp, v[1] / sp, v[2] / sp, clipC) &&
      boxHit(clipC[0], clipC[1], 18 * S, 14 * S, l, t, r, b);
  }
  function boxHit(x, y, hw, hh, l, t, r, b) { return x + hw > l && x - hw < r && y + hh > t && y - hh < b; }

  function drawNav(G, p) {
    var R = RL.Rings, ring = navTarget(G);
    var tx, ty, tz, radius, label, col;
    if (ring && ring.pos) {
      tx = ring.pos[0]; ty = ring.pos[1]; tz = ring.pos[2];
      radius = ring.radius || 22;
      col = ring.special ? RING_COL[ring.special] : RING_COL.current;
      var total = R.total || R.list.length;
      label = ring.special === 'arch' ? 'ARCH' : ring.special === 'lake' ? 'LAKE' : ring.special === 'final' ? 'FINAL' : 'RING ' + (ring.index + 1);
      if (!ring.special && total) label = 'RING ' + (ring.index + 1) + '/' + total;
    } else if (G.course.state === 'done' && R && R.runwayAim && !G.results && !p.onGround) {
      tx = R.runwayAim[0]; ty = R.runwayAim[1]; tz = R.runwayAim[2];
      radius = 30; col = RING_COL.final; label = 'RWY 36';
    } else return;
    if (G.state !== 'playing' && G.state !== 'paused') return;
    var dist = Math.hypot(tx - p.pos[0], ty - p.pos[1], tz - p.pos[2]);
    var f = RL.frame, view = f.view, proj = f.proj;
    var on = project(tx, ty, tz, clip) && clip[0] > 40 * S && clip[0] < W - 40 * S && clip[1] > 60 * S && clip[1] < H - 60 * S;
    shadowOn(3);
    if (on) {
      var pr = radius * proj[5] * H * 0.5 / clip[2];
      pr = M.clamp(pr, 14 * S, H * 0.4);
      var bx = clip[0], by = clip[1], c = Math.min(pr * 0.45, 16 * S);
      ctx.strokeStyle = col;
      ctx.lineWidth = 2.2 * S;
      ctx.beginPath();
      // four corner brackets
      ctx.moveTo(bx - pr, by - pr + c); ctx.lineTo(bx - pr, by - pr); ctx.lineTo(bx - pr + c, by - pr);
      ctx.moveTo(bx + pr - c, by - pr); ctx.lineTo(bx + pr, by - pr); ctx.lineTo(bx + pr, by - pr + c);
      ctx.moveTo(bx + pr, by + pr - c); ctx.lineTo(bx + pr, by + pr); ctx.lineTo(bx + pr - c, by + pr);
      ctx.moveTo(bx - pr + c, by + pr); ctx.lineTo(bx - pr, by + pr); ctx.lineTo(bx - pr, by + pr - c);
      ctx.stroke();
      // The label normally sits above the bracket, which is exactly where the flight path marker
      // and boresight land when on course in chase view: move it beside the bracket then.
      ctx.font = F.small;
      var lw = ctx.measureText(label).width, lTop = by - pr - 6 * S - 13 * S, lBot = by - pr - 4 * S;
      if (markerNear(p, bx - lw / 2 - 4 * S, lTop, bx + lw / 2 + 4 * S, lBot)) {
        var rightX = bx + pr + 8 * S;
        if (rightX + lw < W - 8 * S) text(label, rightX, by - pr, F.small, col, 'left', 'top');
        else text(label, bx - pr - 8 * S, by - pr, F.small, col, 'right', 'top');
      } else {
        text(label, bx, by - pr - 6 * S, F.small, col, 'center', 'bottom');
      }
      text(fmtDist(dist), bx, by + pr + 5 * S, F.mono, INK, 'center', 'top');
    } else {
      // off-screen: arrow on an ellipse around the centre, pointing at the target
      var vx = view[0] * tx + view[4] * ty + view[8] * tz + view[12];
      var vy = view[1] * tx + view[5] * ty + view[9] * tz + view[13];
      var vz = view[2] * tx + view[6] * ty + view[10] * tz + view[14];
      if (vz > 0 && Math.abs(vx) < 1e-3 && Math.abs(vy) < 1e-3) vy = -1;
      var ang = Math.atan2(-vy, vx);
      var rx = Math.min(W * 0.3, 262 * S), ry = Math.min(H * 0.34, 205 * S);
      var ax = cx + Math.cos(ang) * rx, ay = cy + Math.sin(ang) * ry;
      var s = 13 * S;
      ctx.save();
      ctx.translate(ax, ay);
      ctx.rotate(ang);
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(s, 0);
      ctx.lineTo(-s * 0.7, -s * 0.75);
      ctx.lineTo(-s * 0.35, 0);
      ctx.lineTo(-s * 0.7, s * 0.75);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      var lx = ax - Math.cos(ang) * 30 * S, ly = ay - Math.sin(ang) * 22 * S;
      text(label, lx, ly - 2 * S, F.tiny, col, 'center', 'bottom');
      text(fmtDist(dist), lx, ly + 1 * S, F.mono, INK, 'center', 'top');
    }
    shadowOff();
  }

  // ------------------------------------------------------------------ airspeed tape
  function drawSpeedTape(p, kt) {
    var specs = (RL.FlightModel && RL.FlightModel.specs) || { vStall: 28, vStallFlaps: 24, vCruise: 67, vMax: 87, vNeverExceed: 108 };
    var w = 64 * S, h = 256 * S, x = cx - 330 * S - w, y = cy - h / 2;
    plate(x, y, w, h, 7);
    var mid = y + h / 2, ppk = h / 120;           // pixels per knot (120 kt visible)
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y + 2 * S, w, h - 4 * S); ctx.clip();
    // colour bands on the inner edge: red < Vs0, white flap range, green normal, yellow caution, red > Vne
    var vs0 = specs.vStallFlaps * KT, vs1 = specs.vStall * KT, vfe = Math.min(specs.vCruise * 0.8, specs.vMax * 0.62) * KT;
    var vno = specs.vMax * KT, vne = specs.vNeverExceed * KT;
    var bx = x + w - 7 * S;
    band(bx, mid, ppk, kt, 0, vs0, WARN, 5 * S);
    band(bx - 5 * S, mid, ppk, kt, vs0, vfe, 'rgba(255,255,255,0.85)', 3 * S);
    band(bx, mid, ppk, kt, vs1, vno, GOOD, 5 * S);
    band(bx, mid, ppk, kt, vno, vne, CAUTION, 5 * S);
    band(bx, mid, ppk, kt, vne, vne + 200, WARN, 5 * S);
    // ticks + labels
    ctx.strokeStyle = INK_DIM;
    ctx.lineWidth = 1.2 * S;
    ctx.beginPath();
    var start = Math.floor((kt - 62) / 5) * 5;
    for (var v = Math.max(0, start); v <= kt + 62; v += 5) {
      var yy = mid - (v - kt) * ppk;
      var major = v % 10 === 0;
      ctx.moveTo(bx - 1 * S, yy);
      ctx.lineTo(bx - (major ? 11 : 6) * S, yy);
    }
    ctx.stroke();
    ctx.font = F.mono; ctx.fillStyle = INK; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (var v2 = Math.max(0, Math.floor((kt - 62) / 20) * 20); v2 <= kt + 62; v2 += 20) {
      ctx.fillText('' + v2, bx - 15 * S, mid - (v2 - kt) * ppk);
    }
    // speed trend (where we will be in 6 s)
    var trend = M.clamp(accelKt * 6, -60, 60) * ppk;
    if (Math.abs(trend) > 3 * S) {
      ctx.strokeStyle = ACCENT; ctx.lineWidth = 2.5 * S;
      ctx.beginPath(); ctx.moveTo(bx - 3 * S, mid); ctx.lineTo(bx - 3 * S, mid - trend); ctx.stroke();
    }
    ctx.restore();
    // readout box with a pointer
    var danger = kt < vs1 * 1.05 && !p.onGround ? WARN : kt > vne * 0.96 ? WARN : INK;
    readout(x + 4 * S, mid, w - 12 * S, 30 * S, 'right', '' + Math.round(kt), danger, F.monoHuge);
    text('KT', x + w / 2, y - 6 * S, F.small, INK_DIM, 'center', 'bottom');
    text('GS ' + Math.round(fin(p.groundSpeed, 0) * KT), x + w / 2, y + h + 6 * S, F.mono, INK_DIM, 'center', 'top');
  }

  function band(x, mid, ppk, kt, a, b, color, width) {
    var y1 = mid - (b - kt) * ppk, y2 = mid - (a - kt) * ppk;
    if (y2 < y1) return;
    ctx.fillStyle = color;
    ctx.fillRect(x, y1, width, y2 - y1);
  }

  /** Value readout box with an arrow notch on `side` ('right' or 'left'). */
  function readout(x, midY, w, h, side, str, color, font) {
    var y = midY - h / 2, n = 8 * S;
    ctx.beginPath();
    if (side === 'right') {
      ctx.moveTo(x, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, midY - n * 0.7); ctx.lineTo(x + w + n, midY);
      ctx.lineTo(x + w, midY + n * 0.7); ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h);
    } else {
      ctx.moveTo(x + w, y); ctx.lineTo(x, y); ctx.lineTo(x, midY - n * 0.7); ctx.lineTo(x - n, midY);
      ctx.lineTo(x, midY + n * 0.7); ctx.lineTo(x, y + h); ctx.lineTo(x + w, y + h);
    }
    ctx.closePath();
    ctx.fillStyle = BOX; ctx.fill();
    ctx.lineWidth = 1.5 * S; ctx.strokeStyle = color === INK ? 'rgba(238,244,250,0.75)' : color; ctx.stroke();
    text(str, side === 'right' ? x + w - 6 * S : x + w - 6 * S, midY + 1 * S, font, color, 'right', 'middle');
  }

  // ------------------------------------------------------------------ altitude tape + VSI
  function drawAltTape(p) {
    var w = 74 * S, h = 256 * S, x = cx + 330 * S, y = cy - h / 2;
    plate(x, y, w, h, 7);
    var ft = fin(p.pos[1], 0) * FT, mid = y + h / 2, ppf = h / 800;
    var groundFt = (fin(p.pos[1], 0) - fin(p.agl, 0)) * FT;
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y + 2 * S, w, h - 4 * S); ctx.clip();
    // ground band
    var gy = mid - (groundFt - ft) * ppf;
    if (gy < y + h) {
      ctx.fillStyle = 'rgba(176,112,52,0.38)';
      ctx.fillRect(x, Math.max(y, gy), w, y + h - Math.max(y, gy));
      ctx.strokeStyle = 'rgba(230,160,90,0.9)'; ctx.lineWidth = 1.5 * S;
      ctx.beginPath(); ctx.moveTo(x, gy); ctx.lineTo(x + w, gy); ctx.stroke();
    }
    ctx.strokeStyle = INK_DIM; ctx.lineWidth = 1.2 * S;
    ctx.beginPath();
    var start = Math.floor((ft - 420) / 50) * 50;
    for (var v = start; v <= ft + 420; v += 50) {
      var yy = mid - (v - ft) * ppf, major = v % 100 === 0;
      ctx.moveTo(x + 1 * S, yy); ctx.lineTo(x + (major ? 11 : 6) * S, yy);
    }
    ctx.stroke();
    ctx.font = F.mono; ctx.fillStyle = INK; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (var v2 = Math.floor((ft - 420) / 100) * 100; v2 <= ft + 420; v2 += 100) {
      ctx.fillText('' + v2, x + 15 * S, mid - (v2 - ft) * ppf);
    }
    ctx.restore();
    readout(x + 8 * S, mid, w - 12 * S, 30 * S, 'left', '' + Math.round(ft / 10) * 10, INK, F.monoBig);
    text('FT', x + w / 2, y - 6 * S, F.small, INK_DIM, 'center', 'bottom');

    // radar altitude near the ground
    // radar altitude near the ground, measured from the wheels (plane.agl is the CG height, which
    // reads ~5 ft sitting on the runway), in 1 ft steps below 50 ft to help time the flare
    var FMp = RL.FlightModel && RL.FlightModel.params;
    var wheelOff = FMp ? (fin(FMp.gearHeight, 0) - fin(FMp.staticSag, 0)) * M.clamp(fin(p.gear, 1), 0, 1) : 0;
    var aglFt = Math.max(0, fin(p.agl, 0) - wheelOff) * FT;
    if (p.onGround) aglFt = 0;
    if (aglFt < 2500 && !p.crashed) {
      var low = aglFt < 100 && !p.gearDown && !p.onGround;
      text('RA ' + (aglFt < 50 ? Math.round(aglFt) : Math.round(aglFt / 5) * 5), x + w / 2, y + h + 6 * S, F.monoMed, low ? CAUTION : ACCENT, 'center', 'top');
    }

    // vertical speed indicator (non-linear: finer near zero)
    var vx = x + w + 7 * S, vw = 15 * S, vh = h * 0.78, vy = mid - vh / 2;
    plate(vx, vy, vw, vh, 5);
    ctx.strokeStyle = INK_FAINT; ctx.lineWidth = 1 * S;
    ctx.beginPath();
    var marks = [0, 500, 1000, 2000];
    for (var i = 0; i < marks.length; i++) {
      var off = Math.sqrt(marks[i] / 2000) * vh / 2;
      ctx.moveTo(vx + 2 * S, mid - off); ctx.lineTo(vx + (i === 0 ? vw - 2 * S : 7 * S), mid - off);
      ctx.moveTo(vx + 2 * S, mid + off); ctx.lineTo(vx + (i === 0 ? vw - 2 * S : 7 * S), mid + off);
    }
    ctx.stroke();
    var fpm = fin(p.verticalSpeed, 0) * FPM;
    var vo = Math.sign(fpm) * Math.sqrt(Math.min(Math.abs(fpm), 2000) / 2000) * vh / 2;
    ctx.strokeStyle = fpm < -1500 && p.agl < 300 ? WARN : ACCENT;
    ctx.lineWidth = 3 * S;
    ctx.beginPath(); ctx.moveTo(vx + vw / 2, mid); ctx.lineTo(vx + vw / 2, mid - vo); ctx.stroke();
    if (Math.abs(fpm) >= 50) {
      var vsStr = (fpm > 0 ? '+' : '') + Math.round(fpm / 10) * 10;
      text(vsStr, vx + vw / 2, fpm > 0 ? vy - 5 * S : vy + vh + 5 * S, F.mono, INK, 'center', fpm > 0 ? 'bottom' : 'top');
    }
    // thermal cue
    var Wd = RL.World;
    if (Wd && Wd.thermalStrengthAt && !p.onGround && Wd.thermalStrengthAt(p.pos[0], p.pos[2]) > 0.3) {
      text('THERMAL', vx + vw / 2, vy - 22 * S, F.tiny, GOOD, 'center', 'bottom');
    }
  }

  // ------------------------------------------------------------------ heading tape
  function drawHeadingTape(G, p) {
    var w = 440 * S, h = 34 * S, x = cx - w / 2, y = 14 * S;
    plate(x, y, w, h, 7);
    var hdg = fin(p.heading, 0), ppd = w / 90;         // 90 deg visible
    ctx.save();
    ctx.beginPath(); ctx.rect(x + 2 * S, y, w - 4 * S, h); ctx.clip();
    ctx.strokeStyle = INK_DIM; ctx.lineWidth = 1.2 * S;
    ctx.beginPath();
    var start = Math.floor((hdg - 50) / 5) * 5;
    for (var d = start; d <= hdg + 50; d += 5) {
      var xx = cx + (d - hdg) * ppd, major = ((d % 10) + 10) % 10 === 0;
      ctx.moveTo(xx, y + h); ctx.lineTo(xx, y + h - (major ? 9 : 5) * S);
    }
    ctx.stroke();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (var d2 = Math.floor((hdg - 50) / 30) * 30; d2 <= hdg + 50; d2 += 30) {
      var n = ((d2 % 360) + 360) % 360;
      var lbl = n === 0 ? 'N' : n === 90 ? 'E' : n === 180 ? 'S' : n === 270 ? 'W' : pad2(n / 10);
      var card = n % 90 === 0;
      ctx.font = card ? F.label : F.mono;
      ctx.fillStyle = card ? ACCENT : INK;
      ctx.fillText(lbl, cx + (d2 - hdg) * ppd, y + h * 0.38);
    }
    // bearing bug to the nav target
    var R = RL.Rings, ring = navTarget(G), tx = null, tz = 0, col = RING_COL.current;
    if (ring) { tx = ring.pos[0]; tz = ring.pos[2]; if (ring.special) col = RING_COL[ring.special]; }
    else if (G.course.state === 'done' && R && R.runwayAim && !G.results) { tx = R.runwayAim[0]; tz = R.runwayAim[2]; col = RING_COL.final; }
    ctx.restore();
    if (tx !== null) {
      var brg = Math.atan2(tx - p.pos[0], -(tz - p.pos[2])) * M.RAD;
      var rel = ((brg - hdg + 540) % 360) - 180;
      var bxp = cx + M.clamp(rel, -44, 44) * ppd;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(bxp, y + h - 1 * S);
      ctx.lineTo(bxp - 6 * S, y + h + 8 * S);
      ctx.lineTo(bxp + 6 * S, y + h + 8 * S);
      ctx.closePath();
      ctx.fill();
    }
    // readout
    var rw = 52 * S, rh = 22 * S;
    rr(cx - rw / 2, y + h + 3 * S, rw, rh, 4 * S);
    ctx.fillStyle = BOX; ctx.fill();
    ctx.strokeStyle = 'rgba(238,244,250,0.7)'; ctx.lineWidth = 1.2 * S; ctx.stroke();
    var hv = Math.round(hdg) % 360;
    text((hv < 10 ? '00' : hv < 100 ? '0' : '') + hv + '°', cx, y + h + 3 * S + rh / 2 + 1 * S, F.monoMed, INK, 'center', 'middle');
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.moveTo(cx, y + h - 1 * S); ctx.lineTo(cx - 5 * S, y + h + 3 * S); ctx.lineTo(cx + 5 * S, y + h + 3 * S);
    ctx.closePath(); ctx.fill();
  }

  // ------------------------------------------------------------------ course panel (top-left)
  function drawCoursePanel(G) {
    var c = G.course, x = 18 * S, y = 14 * S, w = 212 * S, h = 92 * S;
    plate(x, y, w, h, 9);
    var total = c.total || (RL.Rings && RL.Rings.total) || 0;
    var passed = RL.Rings ? RL.Rings.current : c.ringsPassed;
    text('RINGS', x + 14 * S, y + 22 * S, F.small, INK_DIM);
    text(passed + '/' + total, x + 62 * S, y + 23 * S, F.med, INK);
    // progress pips
    var px = x + 118 * S, pw = w - 132 * S, n = Math.max(1, total);
    for (var i = 0; i < n; i++) {
      var sx = px + (i + 0.5) * pw / n;
      ctx.fillStyle = i < passed ? ACCENT : i === passed ? 'rgba(244,185,66,0.45)' : 'rgba(255,255,255,0.16)';
      ctx.fillRect(sx - pw / n * 0.36, y + 14 * S, pw / n * 0.72, 7 * S);
    }
    var tcol = c.state === 'done' ? ACCENT : c.state === 'running' ? INK : INK_FAINT;
    text(fmtTime(c.time), x + 14 * S, y + 56 * S, F.monoHuge, tcol);
    // split vs. best (for 4 s after each ring)
    var ls = c.lastSplit;
    if (ls && ls.delta !== null && c.time - ls.time < 4 && c.state !== 'ready') {
      var dl = ls.delta;
      text((dl <= 0 ? '−' : '+') + Math.abs(dl).toFixed(1), x + w - 14 * S, y + 54 * S, F.monoMed, dl <= 0 ? GOOD : WARN, 'right');
    } else if (c.state === 'done' && c.medal) {
      var mc = c.medal === 'gold' ? '#ffd35a' : c.medal === 'silver' ? '#d9e2ea' : '#e0a06a';
      text(c.medal.toUpperCase(), x + w - 14 * S, y + 54 * S, F.label, mc, 'right');
    }
    var best = G.best && G.best.time;
    var sub;
    if (c.state === 'ready') sub = 'Clock starts at ring 1';
    else if (c.state === 'done') sub = G.results ? 'Course landed' : 'Land on runway 36';
    else {
      var nextMedal = c.time <= c.par.gold ? 'GOLD ' + fmtTime(c.par.gold) : c.time <= c.par.silver ? 'SILVER ' + fmtTime(c.par.silver) :
        c.time <= c.par.bronze ? 'BRONZE ' + fmtTime(c.par.bronze) : '';
      sub = nextMedal;
    }
    text(sub, x + 14 * S, y + 79 * S, F.tiny, c.state === 'done' ? ACCENT : INK_DIM);
    if (best > 0) text('BEST ' + fmtTime(best), x + w - 14 * S, y + 79 * S, F.tiny, INK_DIM, 'right');
  }

  // ------------------------------------------------------------------ score (top-right)
  function drawScorePanel(G) {
    var w = 196 * S, h = 70 * S, x = W - w - 18 * S, y = 14 * S;
    plate(x, y, w, h, 9);
    text('SCORE', x + 14 * S, y + 22 * S, F.small, INK_DIM);
    text(fmtInt(G.score), x + w - 14 * S, y + 28 * S, F.big, INK, 'right');
    var cb = G.combo;
    if (cb && cb.mult > 1 && cb.timer > 0) {
      var m = cb.mult.toFixed(2).replace(/\.?0+$/, '');
      text('COMBO ×' + m, x + 14 * S, y + 52 * S, F.label, ACCENT);
      var bw = w - 28 * S, frac = M.clamp(cb.timer / 12, 0, 1);
      ctx.fillStyle = 'rgba(255,255,255,0.14)';
      ctx.fillRect(x + 14 * S, y + 58 * S, bw, 3 * S);
      ctx.fillStyle = ACCENT;
      ctx.fillRect(x + 14 * S, y + 58 * S, bw * frac, 3 * S);
    } else if (G.best && G.best.score > 0) {
      text('BEST ' + fmtInt(G.best.score), x + w - 14 * S, y + 54 * S, F.tiny, INK_DIM, 'right');
    }
  }

  // ------------------------------------------------------------------ engine & config (bottom-left)
  function drawEnginePanel(p) {
    var In = RL.Input;
    var showStick = In && In.mouseFlight && In.stick;
    var w = (showStick ? 318 : 250) * S, h = 112 * S, x = 18 * S, y = H - h - 18 * S;
    plate(x, y, w, h, 10);
    // throttle bar
    var tx = x + 16 * S, ty = y + 14 * S, tw = 12 * S, th = 72 * S;
    var thr = M.clamp(fin(p.throttle, 0), 0, 1);
    var cmd = In && In.controls ? M.clamp(fin(In.controls.throttle, thr), 0, 1) : thr;
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(tx, ty, tw, th);
    ctx.fillStyle = ACCENT;
    ctx.fillRect(tx, ty + th * (1 - thr), tw, th * thr);
    ctx.fillStyle = INK;
    ctx.fillRect(tx - 3 * S, ty + th * (1 - cmd) - 1 * S, tw + 6 * S, 2 * S);
    text('THR', tx + tw / 2, y + h - 11 * S, F.tiny, INK_DIM, 'center');
    text(Math.round(thr * 100) + '', tx + tw / 2, ty - 2 * S, F.tiny, INK, 'center', 'bottom');
    // rpm gauge
    var gx = x + 78 * S, gy = y + 52 * S, gr = 30 * S;
    var a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
    var rpm = M.clamp(fin(p.rpm, 0), 0, 1.1);
    ctx.lineWidth = 5 * S;
    ctx.lineCap = 'butt';
    ctx.strokeStyle = 'rgba(255,255,255,0.13)';
    ctx.beginPath(); ctx.arc(gx, gy, gr, a0, a1); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,91,77,0.8)';
    ctx.beginPath(); ctx.arc(gx, gy, gr, a0 + (a1 - a0) * 0.93, a1); ctx.stroke();
    ctx.strokeStyle = ACCENT;
    ctx.beginPath(); ctx.arc(gx, gy, gr, a0, a0 + (a1 - a0) * Math.min(rpm, 1)); ctx.stroke();
    ctx.lineCap = 'round';
    var na = a0 + (a1 - a0) * Math.min(rpm, 1);
    ctx.strokeStyle = INK; ctx.lineWidth = 2 * S;
    ctx.beginPath(); ctx.moveTo(gx, gy); ctx.lineTo(gx + Math.cos(na) * (gr - 8 * S), gy + Math.sin(na) * (gr - 8 * S)); ctx.stroke();
    text('' + Math.round(rpm * 2700 / 10) * 10, gx, gy + 18 * S, F.mono, INK, 'center', 'middle');
    text('RPM', gx, y + h - 11 * S, F.tiny, INK_DIM, 'center');

    // configuration column
    var cxp = x + 128 * S, row = y + 24 * S, lh = 22 * S;
    // flaps
    text('FLAPS', cxp, row, F.tiny, INK_DIM, 'left', 'middle');
    var notch = p.flapsNotch | 0, flaps = M.clamp(fin(p.flaps, 0), 0, 1);
    for (var i = 0; i < 2; i++) {
      var fx = cxp + 50 * S + i * 17 * S;
      ctx.fillStyle = 'rgba(255,255,255,0.14)';
      ctx.fillRect(fx, row - 4 * S, 13 * S, 8 * S);
      var fill = M.clamp(flaps * 2 - i, 0, 1);
      if (fill > 0) { ctx.fillStyle = i < notch ? CYAN : 'rgba(111,214,255,0.5)'; ctx.fillRect(fx, row - 4 * S, 13 * S * fill, 8 * S); }
    }
    text(notch === 0 ? 'UP' : '' + notch, cxp + 90 * S, row, F.mono, notch ? CYAN : INK, 'left', 'middle');
    // gear
    row += lh;
    text('GEAR', cxp, row, F.tiny, INK_DIM, 'left', 'middle');
    var gear = M.clamp(fin(p.gear, 1), 0, 1);
    var transit = (p.gearDown && gear < 0.99) || (!p.gearDown && gear > 0.01);
    var gcol = transit ? CAUTION : p.gearDown ? GOOD : 'rgba(255,255,255,0.25)';
    for (var j = 0; j < 3; j++) {
      var gxx = cxp + 55 * S + j * 13 * S, gyy = row + (j === 1 ? -3 : 2) * S;
      ctx.beginPath(); ctx.arc(gxx, gyy, 4.2 * S, 0, Math.PI * 2);
      if (p.gearDown || transit) { ctx.fillStyle = gcol; ctx.fill(); }
      else { ctx.strokeStyle = gcol; ctx.lineWidth = 1.4 * S; ctx.stroke(); }
    }
    text(transit ? 'TRANSIT' : p.gearDown ? 'DOWN' : 'UP', cxp + 95 * S, row, F.tiny, gcol === 'rgba(255,255,255,0.25)' ? INK : gcol, 'left', 'middle');
    // brakes + G
    row += lh;
    var brk = fin(p.brake, 0) > 0.05;
    rr(cxp, row - 8 * S, 42 * S, 16 * S, 3 * S);
    ctx.fillStyle = brk ? 'rgba(255,91,77,0.85)' : 'rgba(255,255,255,0.08)'; ctx.fill();
    text('BRAKE', cxp + 21 * S, row + 0.5 * S, F.tiny, brk ? '#fff' : INK_FAINT, 'center', 'middle');
    var g = fin(p.gForce, 1);
    var gc = g > 5 || g < -1.5 ? WARN : g > 3.5 || g < -0.5 ? CAUTION : INK;
    text(g.toFixed(1) + ' G', cxp + 55 * S, row + 0.5 * S, F.monoMed, gc, 'left', 'middle');
    // smoke indicator
    if (p.smoke || (In && In.controls && In.controls.smoke)) text('SMOKE', cxp, row + lh, F.tiny, ACCENT, 'left', 'middle');

    // virtual stick
    if (showStick) {
      var sx = x + w - 40 * S, sy = y + 50 * S, sr = 24 * S;
      ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 1.2 * S;
      ctx.beginPath(); ctx.arc(sx, sy, sr, 0, Math.PI * 2);
      ctx.moveTo(sx - sr, sy); ctx.lineTo(sx + sr, sy); ctx.moveTo(sx, sy - sr); ctx.lineTo(sx, sy + sr);
      ctx.stroke();
      var stx = M.clamp(fin(In.stick.x, 0), -1, 1), sty = M.clamp(fin(In.stick.y, 0), -1, 1);
      var dotX = sx + stx * sr, dotY = sy + sty * sr;
      ctx.fillStyle = In.pointerLocked || In.pointerFallback ? ACCENT : INK_FAINT;
      ctx.beginPath(); ctx.arc(dotX, dotY, 4.5 * S, 0, Math.PI * 2); ctx.fill();
      text('STICK', sx, y + h - 11 * S, F.tiny, INK_DIM, 'center');
    }
  }

  // ------------------------------------------------------------------ minimap
  function ensureMap() {
    if (map || mapTries > 3) return;
    var T = RL.Terrain;
    if (!T || !T.ready) return;
    mapTries++;
    try { buildMap(T); } catch (e) { map = null; }
  }

  // hypsometric stops (m, sRGB) tuned to the game's stylised palette
  var TINT = [
    [0, 108, 152, 84], [120, 122, 164, 88], [300, 150, 170, 98], [520, 170, 160, 112],
    [760, 150, 138, 124], [1000, 168, 160, 152], [1250, 232, 236, 240]
  ];
  function tint(h, out) {
    var i = 0;
    while (i < TINT.length - 1 && h > TINT[i + 1][0]) i++;
    if (i >= TINT.length - 1) { out[0] = TINT[i][1]; out[1] = TINT[i][2]; out[2] = TINT[i][3]; return; }
    var a = TINT[i], b = TINT[i + 1], t = M.clamp((h - a[0]) / (b[0] - a[0]), 0, 1);
    out[0] = a[1] + (b[1] - a[1]) * t; out[1] = a[2] + (b[2] - a[2]) * t; out[2] = a[3] + (b[3] - a[3]) * t;
  }

  function buildMap(T) {
    var C = RL.Config, Wd = RL.World;
    var half = (C && C.world && C.world.half) || 6000;
    var N = 512;
    var hd = T.getHeightData ? T.getHeightData() : null;
    var data = hd && hd.data, res = hd && hd.res, dh = hd && hd.half ? hd.half : half;
    function H(x, z) {
      if (data) {
        var fx = (x + dh) / (2 * dh) * res, fz = (z + dh) / (2 * dh) * res;
        var ix = Math.max(0, Math.min(res - 1, Math.floor(fx))), iz = Math.max(0, Math.min(res - 1, Math.floor(fz)));
        var tx = M.clamp(fx - ix, 0, 1), tz = M.clamp(fz - iz, 0, 1), r1 = res + 1;
        var a = data[iz * r1 + ix], b = data[iz * r1 + ix + 1], c = data[(iz + 1) * r1 + ix], d = data[(iz + 1) * r1 + ix + 1];
        return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
      }
      return Wd ? Wd.heightAt(x, z) : 0;
    }
    var hts = new Float32Array(N * N), cell = 2 * half / N;
    for (var j = 0; j < N; j++) {
      for (var i = 0; i < N; i++) hts[j * N + i] = H(-half + (i + 0.5) * cell, -half + (j + 0.5) * cell);
    }
    var cvs = document.createElement('canvas');
    cvs.width = N; cvs.height = N;
    var c2 = cvs.getContext('2d');
    var img = c2.createImageData(N, N), px = img.data;
    var water = (C && C.water && C.water.level) || 40;
    var L = [-0.55, 0.62, -0.55], ll = Math.hypot(L[0], L[1], L[2]);
    L[0] /= ll; L[1] /= ll; L[2] /= ll;
    var col = [0, 0, 0];
    for (var y = 0; y < N; y++) {
      for (var x = 0; x < N; x++) {
        var h = hts[y * N + x];
        var hl = hts[y * N + Math.max(0, x - 1)], hr = hts[y * N + Math.min(N - 1, x + 1)];
        var hu = hts[Math.max(0, y - 1) * N + x], hdn = hts[Math.min(N - 1, y + 1) * N + x];
        // normal from central differences (x east, z south), exaggerated for readable relief
        var nx = -(hr - hl) / (2 * cell) * 1.6, nz = -(hdn - hu) / (2 * cell) * 1.6, ny = 1;
        var nl = Math.hypot(nx, ny, nz);
        var shade = M.clamp((nx * L[0] + ny * L[1] + nz * L[2]) / nl, 0, 1);
        var o = (y * N + x) * 4;
        if (h < water - 0.05) {
          var depth = M.clamp((water - h) / 25, 0, 1);
          px[o] = 58 - 20 * depth; px[o + 1] = 128 - 30 * depth; px[o + 2] = 178 - 20 * depth;
        } else {
          tint(h, col);
          var k = 0.48 + 0.72 * shade;
          px[o] = Math.min(255, col[0] * k); px[o + 1] = Math.min(255, col[1] * k); px[o + 2] = Math.min(255, col[2] * k);
        }
        px[o + 3] = 255;
      }
    }
    c2.putImageData(img, 0, 0);
    // runway
    var rw = C.airfield.runway, s = N / (2 * half);
    c2.fillStyle = '#3a3f46';
    c2.fillRect((rw.cx - rw.width / 2 - 10 + half) * s, (rw.cz - rw.length / 2 + half) * s, (rw.width + 20) * s, rw.length * s);
    c2.fillStyle = '#e9edf0';
    c2.fillRect((rw.cx - 4 + half) * s, (rw.cz - rw.length / 2 + 30 + half) * s, 8 * s, (rw.length - 60) * s);
    map = cvs; mapRes = N; mapHalf = half;
  }

  function drawMinimap(G, p) {
    var R0 = 92 * S, mx = W - R0 - 22 * S, my = H - R0 - 22 * S;
    var range = 2600;                                  // metres from centre to rim
    var k = R0 / range;
    var hdg = fin(p.heading, 0) * M.DEG;
    var px = p.pos[0], pz = p.pos[2];
    var ca = Math.cos(-hdg), sa = Math.sin(-hdg);
    // backing
    ctx.beginPath(); ctx.arc(mx, my, R0 + 4 * S, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(9,15,24,0.55)'; ctx.fill();
    ctx.save();
    ctx.beginPath(); ctx.arc(mx, my, R0, 0, Math.PI * 2); ctx.clip();
    ctx.translate(mx, my);
    ctx.rotate(-hdg);
    if (map) {
      ctx.imageSmoothingEnabled = true;
      ctx.globalAlpha = alpha * 0.92;
      ctx.drawImage(map, (-mapHalf - px) * k, (-mapHalf - pz) * k, 2 * mapHalf * k, 2 * mapHalf * k);
      ctx.globalAlpha = alpha;
      // match the time of day: the daylight relief would glare at night
      var night = fin(RL.frame.nightFactor, 0);
      if (night > 0.05) {
        ctx.fillStyle = 'rgba(6,12,30,' + (0.5 * night).toFixed(2) + ')';
        ctx.fillRect(-R0 * 1.5, -R0 * 1.5, R0 * 3, R0 * 3);
      }
    } else {
      ctx.fillStyle = 'rgba(80,110,80,0.5)'; ctx.fillRect(-R0 * 1.5, -R0 * 1.5, R0 * 3, R0 * 3);
    }
    // thermals: faint dashed circles
    var C = RL.Config;
    if (C && C.thermals) {
      ctx.strokeStyle = 'rgba(255,236,170,0.55)'; ctx.lineWidth = 1 * S;
      ctx.setLineDash(DASH);
      for (var t = 0; t < C.thermals.length; t++) {
        var th = C.thermals[t];
        ctx.beginPath(); ctx.arc((th.x - px) * k, (th.z - pz) * k, Math.max(4 * S, th.radius * k), 0, Math.PI * 2); ctx.stroke();
      }
      ctx.setLineDash(NODASH);
    }
    // ring route
    var Rg = RL.Rings;
    if (Rg && Rg.list && Rg.list.length) {
      var list = Rg.list, cur = Rg.current;
      ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = 1.2 * S;
      ctx.setLineDash(DASH);
      ctx.beginPath();
      ctx.moveTo(0, 0);                                // from the aircraft through the remaining rings
      for (var i = cur; i < list.length; i++) {
        var q = list[i].pos;
        ctx.lineTo((q[0] - px) * k, (q[2] - pz) * k);
      }
      ctx.stroke();
      ctx.setLineDash(NODASH);
      for (var i2 = list.length - 1; i2 >= cur; i2--) {
        var rg = list[i2], rx = (rg.pos[0] - px) * k, rz = (rg.pos[2] - pz) * k;
        var isCur = i2 === cur;
        var col = rg.special ? RING_COL[rg.special] : isCur ? RING_COL.current : i2 === cur + 1 ? RING_COL.next : 'rgba(220,232,255,0.8)';
        ctx.fillStyle = col;
        ctx.beginPath(); ctx.arc(rx, rz, (isCur ? 4.5 : 3) * S, 0, Math.PI * 2); ctx.fill();
        if (isCur) {
          var pulse = 0.5 + 0.5 * Math.sin(time * 5);
          ctx.strokeStyle = col; ctx.lineWidth = 1.6 * S;
          ctx.beginPath(); ctx.arc(rx, rz, (7 + pulse * 4) * S, 0, Math.PI * 2); ctx.stroke();
        }
      }
    }
    ctx.restore();

    // landmark labels (upright text at rotated positions)
    var T = RL.Terrain, lm = T && T.landmarks;
    if (lm && lm.length) {
      ctx.font = F.tiny; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      shadowOn(2);
      for (var l = 0; l < lm.length; l++) {
        var L = lm[l];
        if (L.kind === 'airfield') continue;
        var dx = (L.x - px) * k, dz = (L.z - pz) * k;
        var sx = dx * ca - dz * sa, sy = dx * sa + dz * ca;
        if (sx * sx + sy * sy > (R0 - 16 * S) * (R0 - 16 * S)) continue;
        ctx.fillStyle = L.kind === 'lake' ? '#bff3ff' : L.kind === 'arch' ? '#e2c6ff' : L.kind === 'canyon' ? '#ffe2b8' : 'rgba(255,255,255,0.85)';
        if (L.kind === 'peak') {
          ctx.beginPath(); ctx.moveTo(mx + sx, my + sy - 4 * S); ctx.lineTo(mx + sx - 3.5 * S, my + sy + 2 * S); ctx.lineTo(mx + sx + 3.5 * S, my + sy + 2 * S); ctx.fill();
          ctx.fillText(L.name, mx + sx, my + sy + 10 * S);
        } else ctx.fillText(L.name, mx + sx, my + sy);
      }
      shadowOff();
    }
    // rim, north marker, plane arrow
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1.5 * S;
    ctx.beginPath(); ctx.arc(mx, my, R0, 0, Math.PI * 2); ctx.stroke();
    var nX = mx - Math.sin(hdg) * (R0 - 1 * S), nY = my - Math.cos(hdg) * (R0 - 1 * S);
    ctx.beginPath(); ctx.arc(nX, nY, 8 * S, 0, Math.PI * 2);
    ctx.fillStyle = BOX; ctx.fill();
    text('N', nX, nY + 0.5 * S, F.tiny, ACCENT, 'center', 'middle');
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 1.5 * S;
    ctx.beginPath();
    ctx.moveTo(mx, my - 8 * S); ctx.lineTo(mx + 6 * S, my + 6 * S); ctx.lineTo(mx, my + 3 * S); ctx.lineTo(mx - 6 * S, my + 6 * S);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    // bounds warning tint
    if (G.warnings && G.warnings.bounds) {
      ctx.strokeStyle = 'rgba(255,176,46,' + (0.5 + 0.4 * Math.sin(time * 6)).toFixed(2) + ')';
      ctx.lineWidth = 3 * S;
      ctx.beginPath(); ctx.arc(mx, my, R0 + 2 * S, 0, Math.PI * 2); ctx.stroke();
    }
  }

  // ------------------------------------------------------------------ popups (rings, stunts)
  function drawPopups(G) {
    var list = G.popups;
    if (!list) return;
    var baseY = cy - 165 * S;                       // above the 10 deg rung in level chase flight
    shadowOn(4);
    for (var i = 0; i < list.length; i++) {
      var q = list[i];
      if (!q.active) continue;
      var slot = 0;
      for (var j = 0; j < list.length; j++) if (list[j].active && list[j].age < q.age) slot++;
      var t = q.age / q.life;
      var a = Math.min(1, q.age / 0.15) * (1 - M.smoothstep(0.7, 1, t));
      var pop = 1 + 0.25 * Math.max(0, 1 - q.age / 0.18);
      var y = baseY - slot * 36 * S - q.age * 10 * S;
      var col = q.kind === 'stunt' ? ACCENT : q.kind === 'special' ? '#ffe7a8' : INK;
      ctx.globalAlpha = alpha * a;
      ctx.save();
      ctx.translate(cx, y);
      ctx.scale(pop, pop);
      text(q.text.toUpperCase(), -6 * S, 0, F.med, col, 'right', 'middle');
      text('+' + fmtInt(q.points), 6 * S, 0, F.monoBig, col === INK ? ACCENT : col, 'left', 'middle');
      if (q.sub) text(q.sub, 0, 15 * S, F.tiny, INK_DIM, 'center', 'middle');
      ctx.restore();
    }
    ctx.globalAlpha = alpha;
    shadowOff();
  }

  // ------------------------------------------------------------------ landing banner
  function drawLanding(G) {
    var L = G.lastLanding;
    if (!L || L.age > 5) return;
    var a = Math.min(1, L.age / 0.2) * (1 - M.smoothstep(4, 5, L.age));
    var col = L.grade === 'perfect' ? ACCENT : L.grade === 'good' ? GOOD : L.grade === 'firm' ? INK : CAUTION;
    var y = cy - 40 * S;
    ctx.globalAlpha = alpha * a;
    shadowOn(10);
    var pop = 1 + 0.35 * Math.max(0, 1 - L.age / 0.25);
    ctx.save();
    ctx.translate(cx, y);
    ctx.scale(pop, pop);
    var big = L.grade === 'perfect' ? 'BUTTER!' : L.grade === 'good' ? 'SMOOTH' : L.grade === 'firm' ? 'FIRM' : 'HARD';
    text(big, 0, 0, F.banner, col, 'center', 'middle');
    ctx.restore();
    shadowOff();
    rr(cx - 190 * S, y + 22 * S, 380 * S, 46 * S, 10 * S);
    ctx.fillStyle = 'rgba(9,15,24,0.62)'; ctx.fill();
    var off = fin(L.offset, 0);
    var detail = Math.round(Math.abs(fin(L.fpm, 0))) + ' fpm  ·  ' + Math.abs(off).toFixed(1) + ' m ' + (off >= 0 ? 'right' : 'left') +
      '  ·  ' + Math.abs(fin(L.heading, 0)).toFixed(1) + '° off' + (L.bounced ? '  ·  bounced' : '');
    text(L.label + '   +' + fmtInt(L.points), cx, y + 36 * S, F.med, INK, 'center', 'middle');
    text(detail, cx, y + 55 * S, F.small, 'rgba(238,244,250,0.8)', 'center', 'middle');
    shadowOff();
    ctx.globalAlpha = alpha;
  }

  // ------------------------------------------------------------------ warnings
  function drawWarnings(G) {
    var w = G.warnings;
    if (!w || G.state !== 'playing') return;
    var y = cy + 128 * S, n = 0;
    var flash = (time * 2.6) % 1 < 0.62;
    if (w.pullUp) { warnBox('PULL UP', WARN, y, flash, true); y += 38 * S; n++; }
    if (w.stall && n < 2) { warnBox('STALL', WARN, y, flash, true); y += 38 * S; n++; }
    if (w.overspeed && n < 2) { warnBox('OVERSPEED', CAUTION, y, true, false); y += 38 * S; n++; }
    if (w.gear && n < 2) { warnBox('GEAR', CAUTION, y, true, false); y += 38 * S; n++; }
    if (w.bounds && n < 2) { warnBox('BOUNDS · TURN BACK', CAUTION, y, true, false); n++; }
  }

  function warnBox(str, col, y, on, solid) {
    ctx.font = F.warn;
    var tw = ctx.measureText(str).width + 30 * S, th = 30 * S;
    rr(cx - tw / 2, y - th / 2, tw, th, 5 * S);
    if (solid && on) { ctx.fillStyle = col; ctx.fill(); }
    else { ctx.fillStyle = 'rgba(8,12,18,0.72)'; ctx.fill(); }
    ctx.lineWidth = 2 * S; ctx.strokeStyle = col; ctx.stroke();
    text(str, cx, y + 1 * S, F.warn, solid && on ? '#fff' : col, 'center', 'middle');
  }

  // ------------------------------------------------------------------ hint line with key caps
  function drawHint(G) {
    var h = G.hint;
    if (!h || !h.text) return;
    var a = Math.min(1, h.age / 0.35);
    var str = h.text;
    ctx.font = F.label;
    if (hintKey !== str) { hintKey = str; hintW = measureHint(str); }
    var pw = hintW + 36 * S, ph = 34 * S, x = cx - pw / 2;
    var y = cockpitView ? 96 * S : H - 64 * S - ph / 2;   // above the glare shield in the cockpit
    ctx.globalAlpha = alpha * a;
    rr(x, y, pw, ph, 17 * S);
    ctx.fillStyle = 'rgba(9,15,24,0.72)'; ctx.fill();
    ctx.lineWidth = 1.2 * S; ctx.strokeStyle = 'rgba(244,185,66,0.55)'; ctx.stroke();
    // walk segments: plain text and [KEY] caps
    var xx = x + 18 * S, my = y + ph / 2 + 0.5 * S, i = 0;
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    while (i < str.length) {
      var o = str.indexOf('[', i);
      if (o < 0) o = str.length;
      if (o > i) {
        var seg = str.substring(i, o);
        ctx.font = F.label; ctx.fillStyle = INK;
        ctx.fillText(seg, xx, my);
        xx += ctx.measureText(seg).width;
      }
      if (o >= str.length) break;
      var c = str.indexOf(']', o);
      if (c < 0) c = str.length;
      var key = str.substring(o + 1, c);
      ctx.font = F.small;
      var kw = ctx.measureText(key).width + 12 * S;
      rr(xx + 2 * S, my - 10 * S, kw, 20 * S, 4 * S);
      ctx.fillStyle = ACCENT; ctx.fill();
      ctx.fillStyle = '#1a1206';
      ctx.fillText(key, xx + 8 * S, my + 0.5 * S);
      xx += kw + 4 * S;
      i = c + 1;
    }
    ctx.globalAlpha = alpha;
  }

  function measureHint(str) {
    var w = 0, i = 0;
    while (i < str.length) {
      var o = str.indexOf('[', i);
      if (o < 0) o = str.length;
      if (o > i) { ctx.font = F.label; w += ctx.measureText(str.substring(i, o)).width; }
      if (o >= str.length) break;
      var c = str.indexOf(']', o);
      if (c < 0) c = str.length;
      ctx.font = F.small;
      w += ctx.measureText(str.substring(o + 1, c)).width + 16 * S;
      i = c + 1;
    }
    return w;
  }

  // ------------------------------------------------------------------ mouse capture hint
  function drawCaptureHint(G) {
    var In = RL.Input;
    if (!In || G.state !== 'playing' || !In.mouseFlight || In.pointerLocked || In.pointerFallback) return;
    if ((G.results && !G.results.dismissed) || (RL.UI && RL.UI.helpOpen)) return;
    var a = 0.55 + 0.25 * Math.sin(time * 3);
    ctx.globalAlpha = alpha * a;
    shadowOn(4);
    text('Click to capture the mouse for flight  ·  V for keyboard only', cx,
      cockpitView ? 150 * S : cy + 250 * S, F.small, INK, 'center', 'middle');
    shadowOff();
    ctx.globalAlpha = alpha;
  }

  RL.HUD = HUD;
})(window.RL = window.RL || {});
