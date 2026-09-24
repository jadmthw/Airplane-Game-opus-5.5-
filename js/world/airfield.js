/*
 * Ridgeline — RL.Airfield: "Ridgeline Field", the mountain airstrip the game starts and ends on.
 *
 *   init(gl), update(dt), draw(frame), drawLights(frame), colliders, isPaved(x, z), towerCamPos
 *
 * Layout (world meters, runway 18/36 along Z centered on Config.airfield.runway):
 *   runway (painted procedurally: canvas atlas for the threshold/number/TDZ markings of each end,
 *   analytic edge stripes + centerline), a parallel taxiway on the WEST side with three connectors,
 *   an apron with the hangar, control tower, clubhouse, T-hangars, fuel farm and parked aircraft,
 *   two windsocks, PAPIs for both runway directions, approach lights + sequenced flashers south of
 *   runway 36, REILs on runway 18 and a rotating white/green beacon on the tower.
 *
 * Everything paved or built stays inside Config.airfield.flatZone (terrain there is exactly flat at
 * the field elevation) and nothing collidable is within 30 m of the runway centerline.
 */
(function (RL) {
  'use strict';

  var M = RL.M, v3 = RL.v3, m4 = RL.m4, Geo = RL.Geo, C = RL.Config;
  var AF = C.airfield, RW = AF.runway, E = AF.elevation;
  var CX = RW.cx, CZ = RW.cz, HL = RW.length / 2, HW = RW.width / 2;

  // ------------------------------------------------------------------ layout
  // All positions are relative to the runway center so the field moves with the config.
  var TWY_X = CX - 95, TWY_HW = 9;                 // parallel taxiway "A" (west side)
  var TWY_Z0 = CZ - 664, TWY_Z1 = CZ + 664;
  var CONNECTORS = [CZ - 655, CZ + 40, CZ + 655];  // connector centerlines (z), 18 m wide
  var APRON = { minX: CX - 220, maxX: TWY_X - TWY_HW, minZ: CZ - 110, maxZ: CZ + 190 };
  var LOT = { minX: CX - 282, maxX: CX - 258, minZ: CZ + 8, maxZ: CZ + 62 };
  var PAD_LEN = 45;                                 // blast pads beyond both runway ends
  var PAPI_D = 300;                                 // PAPI / aiming point distance from threshold
  var PAPI_SPACING = 12, PAPI_INNER = HW + 18;      // lateral offsets of the 4 PAPI boxes
  var PAPI_ANGLES = [2.5, 2.83, 3.17, 3.5];         // outer -> inner (degrees)

  // Paved rectangles (not the runway). Used by isPaved and to build the pavement mesh.
  // type: 0 asphalt, 1 concrete slabs
  var PAVED = [
    { minX: TWY_X - TWY_HW, maxX: TWY_X + TWY_HW, minZ: TWY_Z0, maxZ: TWY_Z1, type: 0, color: [0.25, 0.25, 0.26] },
    { minX: APRON.minX, maxX: APRON.maxX, minZ: APRON.minZ, maxZ: APRON.maxZ, type: 1, color: [0.47, 0.465, 0.445] },
    { minX: CX - HW, maxX: CX + HW, minZ: CZ + HL, maxZ: CZ + HL + PAD_LEN, type: 0, color: [0.21, 0.21, 0.22] },
    { minX: CX - HW, maxX: CX + HW, minZ: CZ - HL - PAD_LEN, maxZ: CZ - HL, type: 0, color: [0.21, 0.21, 0.22] },
    { minX: LOT.minX, maxX: LOT.maxX, minZ: LOT.minZ, maxZ: LOT.maxZ, type: 0, color: [0.24, 0.24, 0.25] }
  ];
  CONNECTORS.forEach(function (zc) {
    PAVED.push({ minX: TWY_X + TWY_HW, maxX: CX - HW, minZ: zc - 9, maxZ: zc + 9, type: 0, color: [0.25, 0.25, 0.26] });
  });

  // Buildings (world positions of their local origins; "heading" = direction the front faces).
  var HANGAR = { x: CX - 224, z: CZ + 125, R: 15, L: 36, doorHW: 11, doorH: 8.5 };
  var TOWER = { x: CX - 236, z: CZ - 30 };
  var CLUB = { x: CX - 241, z: CZ + 34 };
  var THANGARS = { x: CX - 239, z: CZ + 178 };
  var FUEL = { x: CX - 240, z: CZ - 85 };
  var WINDSOCKS = [{ x: CX - 48, z: CZ + 460, circle: true }, { x: CX + 48, z: CZ - 460, circle: false }];
  var FLOODS = [[CX - 217, CZ - 62, 1, 0], [CX - 217, CZ + 88, 1, 0], [CX - 150, CZ - 116, 0, 1], [CX - 160, CZ + 197, 0, -1]];
  var PARKED = [
    { x: CX - 165, z: CZ - 72, h: 90, c1: [0.95, 0.94, 0.9], c2: [0.8, 0.16, 0.14] },
    { x: CX - 165, z: CZ - 38, h: 90, c1: [0.96, 0.9, 0.62], c2: [0.16, 0.32, 0.66] },
    { x: CX - 165, z: CZ - 4, h: 90, c1: [0.92, 0.93, 0.95], c2: [0.95, 0.52, 0.12] },
    { x: CX - 192, z: CZ + 152, h: 125, c1: [0.9, 0.88, 0.8], c2: [0.2, 0.52, 0.34] },
    { x: HANGAR.x - 12, z: HANGAR.z, h: 90, c1: [0.95, 0.95, 0.95], c2: [0.5, 0.26, 0.6] }
  ];

  var Airfield = {
    ready: false,
    name: AF.name,
    colliders: [],
    /** Camera point just outside the tower cab, on the runway side. */
    towerCamPos: v3.create(TOWER.x + 6.8, E + 18.2, TOWER.z),
    /** Where the PAPIs are, for HUD/debug: [{x, z, facing, lights:[{x,y,z,angleDeg}]}] */
    papi: [],
    windsockDir: 0,
    windsockFill: 0
  };

  /** Taxiway / apron / blast pads / parking lot (the runway itself is not "paved"). */
  Airfield.isPaved = function (x, z) {
    if (C.isOnRunway(x, z)) return false;
    for (var i = 0; i < PAVED.length; i++) {
      var r = PAVED[i];
      if (x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ) return true;
    }
    return false;
  };

  // ------------------------------------------------------------------ geometry helpers
  // Every part carries a per-vertex uv: (emissive, 0) for plain parts, (u, 1 + v) for parts that
  // sample the sign texture. The object shader decodes that.
  function Parts() { this.list = []; }
  Parts.prototype.add = function (g, emis) {
    var n = g.positions.length / 3;
    g.uvs = new Array(n * 2);
    for (var i = 0; i < n; i++) { g.uvs[i * 2] = emis || 0; g.uvs[i * 2 + 1] = 0; }
    this.list.push(g);
    return g;
  };
  Parts.prototype.addRaw = function (g) { this.list.push(g); return g; };
  /** Box with its BASE at y. */
  Parts.prototype.box = function (sx, sy, sz, c, x, y, z, emis) {
    return this.add(Geo.translate(Geo.box(sx, sy, sz, c), x, y + sy / 2, z), emis);
  };
  /** Vertical cylinder with its base at y. */
  Parts.prototype.cyl = function (rt, rb, h, seg, c, x, y, z, emis, opts) {
    return this.add(Geo.translate(Geo.cylinder(rt, rb, h, seg, c, opts), x, y + h / 2, z), emis);
  };
  /** Thin beam between two points (square section). */
  Parts.prototype.beam = function (a, b, t, c, emis) {
    var d = v3.sub([0, 0, 0], b, a), len = v3.length(d);
    if (len < 1e-4) return null;
    var g = Geo.box(t, len, t, c);
    var q = RL.quat.create();
    var axis = v3.cross([0, 0, 0], [0, 1, 0], d);
    var al = v3.length(axis);
    if (al > 1e-6) RL.quat.setAxisAngle(q, v3.scale(axis, axis, 1 / al), Math.acos(M.clamp(d[1] / len, -1, 1)));
    else if (d[1] < 0) RL.quat.setAxisAngle(q, [1, 0, 0], Math.PI);
    Geo.rotate(g, q);
    Geo.translate(g, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
    return this.add(g, emis);
  };
  Parts.prototype.merge = function () { return Geo.merge(this.list); };

  /** Merge a local-space group, rotate it to face `headingDeg` (local -Z = front... see callers),
   *  move it to (x, E, z) and register a collider from its bounds. */
  function place(target, group, x, z, rotY, name, y) {
    var g = group.merge();
    if (rotY) Geo.rotateY(g, rotY);
    Geo.translate(g, x, y === undefined ? E : y, z);
    target.addRaw(g);
    if (name) {
      var b = Geo.bounds(g);
      Airfield.colliders.push({ type: 'box', min: [b.min[0], b.min[1], b.min[2]], max: [b.max[0], b.max[1], b.max[2]], name: name });
    }
    return g;
  }

  // ------------------------------------------------------------------ palette (sRGB)
  var COL = {
    concrete: [0.62, 0.61, 0.58], darkConcrete: [0.42, 0.41, 0.4], white: [0.93, 0.92, 0.88],
    cream: [0.94, 0.89, 0.76], red: [0.74, 0.2, 0.16], roofRed: [0.62, 0.23, 0.17],
    wood: [0.62, 0.42, 0.26], woodLight: [0.76, 0.6, 0.42], woodDark: [0.36, 0.23, 0.14],
    glass: [0.2, 0.3, 0.36], glassTower: [0.16, 0.34, 0.38], steel: [0.62, 0.65, 0.68],
    darkSteel: [0.3, 0.32, 0.34], hangarRoof: [0.7, 0.72, 0.74], hangarInside: [0.2, 0.19, 0.18],
    blueDoor: [0.2, 0.44, 0.72], orange: [0.98, 0.46, 0.1], yellow: [0.95, 0.76, 0.12],
    black: [0.08, 0.08, 0.09], pine: [0.16, 0.34, 0.2], pine2: [0.2, 0.4, 0.22], trunk: [0.36, 0.24, 0.15],
    stone: [0.5, 0.48, 0.45], lightFixture: [0.85, 0.82, 0.6], blueFixture: [0.25, 0.4, 0.85]
  };

  // ------------------------------------------------------------------ building builders (local space)
  // Local convention for buildings: front faces +X (towards the runway), y = 0 at the ground.

  function buildHangar() {
    var p = new Parts(), H = HANGAR, R = H.R, L = H.L;
    // Quonset roof: half cylinder along X spanning x in [-L, 0]
    function halfCyl(r, len, color, inside) {
      var g = Geo.cylinder(r, r, len, 14, color, { caps: false, thetaStart: Math.PI, thetaLength: Math.PI });
      Geo.rotateZ(g, -Math.PI / 2);
      if (inside) for (var i = 0; i < g.indices.length; i += 3) {
        var t = g.indices[i + 1]; g.indices[i + 1] = g.indices[i + 2]; g.indices[i + 2] = t;
      }
      return g;
    }
    p.add(Geo.translate(halfCyl(R, L, COL.hangarRoof, false), -L / 2, 0, 0));
    p.add(Geo.translate(halfCyl(R - 0.25, L, COL.hangarInside, true), -L / 2, 0, 0));
    // ribs
    for (var k = 0; k <= 6; k++) {
      p.add(Geo.translate(halfCyl(R + 0.14, 0.45, COL.steel, false), -L + 0.25 + k * (L - 0.5) / 6, 0, 0));
    }
    // walls: shapes in (a, y) where world z = -a after rotateY(PI/2)
    function wall(shape, depth, color, x) {
      var g = Geo.extrude(shape, depth, color);
      Geo.rotateY(g, Math.PI / 2);
      Geo.translate(g, x, 0, 0);
      return g;
    }
    var n = 20, i;
    // back wall: CCW half disc from (R, 0) over the top to (-R, 0)
    var back = [];
    for (i = 0; i <= n; i++) back.push([Math.cos((i / n) * Math.PI) * R, Math.sin((i / n) * Math.PI) * R]);
    p.add(wall(back, 0.4, COL.red, -L + 0.2));
    // front: two pillars and the lintel above the door opening
    var dw = H.doorHW, dh = H.doorH;
    var lintel = [];
    var th0 = Math.asin(dh / R), th1 = Math.PI - th0;
    // lintel: region of the half disc above y = dh, clipped to |a| <= R
    lintel.push([Math.sqrt(R * R - dh * dh), dh]);
    for (i = 1; i < n; i++) {
      var t2 = th0 + (i / n) * (th1 - th0);
      lintel.push([Math.cos(t2) * R, Math.sin(t2) * R]);
    }
    lintel.push([-Math.sqrt(R * R - dh * dh), dh]);
    p.add(wall(lintel, 0.5, COL.red, -0.25));
    // pillars (between |a| = dw and the arc, below dh)
    var pil = [[dw, 0], [R, 0]];
    var steps = 6;
    for (i = 1; i <= steps; i++) {
      var yy = (i / steps) * dh;
      pil.push([Math.sqrt(R * R - yy * yy), yy]);
    }
    pil.push([dw, dh]);
    p.add(wall(pil, 0.5, COL.red, -0.25));
    var pil2 = pil.map(function (q) { return [-q[0], q[1]]; }).reverse();
    p.add(wall(pil2, 0.5, COL.red, -0.25));
    // white trim along the door head
    p.box(0.6, 0.35, dw * 2 + 0.6, COL.white, 0.05, dh, 0);
    // sliding doors parked in front of the pillars (open)
    var dx = 0.55;
    [-1, 1].forEach(function (s) {
      for (var j = 0; j < 2; j++) {
        var zc = s * (dw + 2.6 + j * 0.0);
        var off = dx + j * 0.35;
        p.box(0.25, dh - 0.3, 5.4, j ? COL.blueDoor : [0.24, 0.5, 0.78], off, 0.1, zc + s * j * 1.2);
        p.box(0.28, 0.35, 5.4, COL.white, off, dh * 0.5, zc + s * j * 1.2);
      }
    });
    // door rail
    p.box(0.3, 0.3, R * 2 + 4, COL.darkSteel, 0.9, dh - 0.05, 0);
    // interior: floor, workbench, shelves, a glowing work lamp (emissive at night)
    p.box(L - 0.6, 0.06, R * 1.9, COL.darkConcrete, -L / 2, 0.0, 0);
    p.box(1.2, 1.0, 6, COL.woodDark, -L + 1.4, 0, -8);
    p.box(1.0, 2.6, 4, COL.steel, -L + 1.2, 0, 7);
    p.box(3.0, 0.2, 3.0, [1.0, 0.92, 0.7], -L / 2, 11.5, 0, 1.0);
    // sign board above the door ("RIDGELINE FIELD")
    signQuad(p, 0.32, 0, 9.4, 12.2, 8.4, 0);
    // roof obstruction light housing
    p.cyl(0.15, 0.15, 0.6, 6, COL.darkSteel, -L / 2, R, 0);
    // side windows row (emissive)
    for (i = 0; i < 4; i++) {
      var wx = -L + 5 + i * 8.5;
      p.box(2.8, 1.1, 0.2, COL.glass, wx, 3.6, R * 0.935, 0.9);
      p.box(2.8, 1.1, 0.2, COL.glass, wx, 3.6, -R * 0.935, 0.9);
    }
    return p;
  }

  /**
   * Textured sign quad on a plane facing +X at local x. Rows of the sign atlas: 0 = RIDGELINE FIELD,
   * 1 = CAFE / FLIGHT SCHOOL.
   */
  function signQuad(parts, x, zc, y0, y1, halfW, row) {
    var g = Geo.quad([x, y0, zc + halfW], [x, y0, zc - halfW], [x, y1, zc - halfW], [x, y1, zc + halfW], [1, 1, 1]);
    var vTop = row * 0.5 + 0.02, vBot = row * 0.5 + 0.48;
    g.uvs = [0, 1 + vBot, 1, 1 + vBot, 1, 1 + vTop, 0, 1 + vTop];
    parts.addRaw(g);
    return g;
  }

  function buildTower() {
    var p = new Parts();
    // ground-floor office building behind the shaft
    p.box(12, 4.2, 10, COL.cream, -4, 0, 0);
    p.box(12.6, 0.4, 10.6, COL.roofRed, -4, 4.2, 0);
    for (var i = 0; i < 3; i++) {
      p.box(0.2, 1.4, 2.0, COL.glass, 2.05, 1.6, -3.2 + i * 3.2, 1);
      p.box(0.2, 1.4, 2.0, COL.glass, -10.05, 1.6, -3.2 + i * 3.2, 1);
    }
    p.box(0.2, 2.4, 1.6, COL.woodDark, 2.05, 0, 3.9);
    // shaft
    p.box(5, 15, 5, COL.cream, 0, 0, 0);
    p.box(5.1, 0.9, 5.1, COL.orange, 0, 6.5, 0);
    p.box(5.1, 0.9, 5.1, COL.orange, 0, 11.5, 0);
    for (i = 0; i < 4; i++) p.box(0.15, 1.0, 0.8, COL.glass, 2.55, 2 + i * 3.1, 0, 0.8);
    // cab: floor slab, outward-leaning glass, roof
    p.cyl(5.3, 5.0, 0.7, 8, COL.white, 0, 14.8, 0);
    p.cyl(4.95, 4.3, 3.4, 8, COL.glassTower, 0, 15.5, 0, 0.5);
    // mullions at the octagon corners
    for (i = 0; i < 8; i++) {
      var a = i / 8 * Math.PI * 2;
      p.beam([Math.sin(a) * 4.3, 15.5, Math.cos(a) * 4.3], [Math.sin(a) * 4.95, 18.9, Math.cos(a) * 4.95], 0.18, COL.white);
    }
    p.cyl(5.6, 5.4, 0.55, 8, COL.roofRed, 0, 18.9, 0);
    p.cyl(1.2, 1.4, 0.8, 8, COL.white, 0, 19.45, 0);   // beacon plinth (beacon head is dynamic)
    // antenna mast with obstruction light
    p.beam([-2.6, 19.4, -2.6], [-2.6, 25.5, -2.6], 0.14, COL.darkSteel);
    p.beam([-2.6, 23.0, -2.6], [-1.2, 23.0, -2.6], 0.08, COL.darkSteel);
    // catwalk railing
    for (i = 0; i < 8; i++) {
      var a0 = i / 8 * Math.PI * 2, a1 = (i + 1) / 8 * Math.PI * 2;
      p.beam([Math.sin(a0) * 5.25, 16.2, Math.cos(a0) * 5.25], [Math.sin(a1) * 5.25, 16.2, Math.cos(a1) * 5.25], 0.08, COL.white);
    }
    return p;
  }

  function buildClubhouse() {
    var p = new Parts();
    p.box(18.6, 0.5, 28.6, COL.stone, 0, 0, 0);
    p.box(18, 4.2, 28, COL.wood, 0, 0.5, 0);
    // roof: gabled prism along Z
    var roof = Geo.extrude([[-10.4, 0], [10.4, 0], [0, 5.2]], 30, COL.roofRed);
    p.add(Geo.translate(roof, 0, 4.7, 0));
    p.box(1.3, 3.4, 1.3, COL.stone, -3.5, 6.2, 8);
    // windows (warm glow at night) + door
    var zs = [-11, -6.5, 6.5, 11];
    for (var i = 0; i < zs.length; i++) {
      p.box(0.25, 1.7, 2.6, COL.glass, 9.02, 1.9, zs[i], 1.0);
      p.box(0.3, 0.2, 2.9, COL.white, 9.05, 1.8, zs[i]);
      p.box(0.25, 1.7, 2.6, COL.glass, -9.02, 1.9, zs[i], 1.0);
    }
    p.box(0.25, 2.7, 3.4, [0.55, 0.2, 0.16], 9.02, 0.5, 0);
    p.box(0.26, 2.1, 1.3, [1.0, 0.85, 0.55], 9.05, 0.6, 0, 1.0);
    for (i = -1; i <= 1; i += 2) p.box(2.6, 1.6, 0.25, COL.glass, -2 + i * 4, 1.9, 14.02, 1.0);
    // deck with railing, umbrellas and tables
    p.box(7, 0.5, 24, COL.woodLight, 12.5, 0, 0);
    for (i = 0; i <= 8; i++) p.box(0.14, 1.0, 0.14, COL.white, 15.9, 0.5, -12 + i * 3);
    p.box(0.1, 0.1, 24, COL.white, 15.9, 1.45, 0);
    var umb = [[0.95, 0.35, 0.25], [0.98, 0.8, 0.25], [0.25, 0.6, 0.9]];
    for (i = 0; i < 3; i++) {
      var uz = -7 + i * 7;
      p.cyl(0.07, 0.07, 2.4, 5, COL.white, 12.8, 0.5, uz);
      p.add(Geo.translate(Geo.cone(1.9, 0.75, 8, umb[i]), 12.8, 0.5 + 2.4 + 0.3, uz));
      p.cyl(0.65, 0.65, 0.08, 8, COL.white, 12.8, 1.2, uz);
      p.cyl(0.1, 0.1, 0.7, 5, COL.woodDark, 12.8, 0.5, uz);
    }
    // sign on posts at the deck edge ("CAFE - FLIGHT SCHOOL")
    p.box(0.15, 3.0, 0.15, COL.woodDark, 16.2, 0.5, -4.2);
    p.box(0.15, 3.0, 0.15, COL.woodDark, 16.2, 0.5, 4.2);
    p.box(0.12, 1.5, 9.0, COL.woodDark, 16.1, 2.4, 0);
    signQuad(p, 16.2, 0, 2.5, 3.8, 4.4, 1);
    // flower boxes
    for (i = 0; i < zs.length; i++) p.box(0.5, 0.35, 2.4, [0.85, 0.3, 0.45], 9.3, 1.5, zs[i]);
    return p;
  }

  function buildTHangars() {
    var p = new Parts();
    p.box(14, 5, 36, COL.cream, 0, 0, 0);
    p.box(15, 0.45, 37, [0.42, 0.5, 0.56], -0.3, 5, 0);
    var doors = [[0.22, 0.46, 0.74], [0.85, 0.3, 0.22], [0.25, 0.6, 0.4], [0.95, 0.72, 0.2]];
    for (var i = 0; i < 4; i++) {
      var z = -13.5 + i * 9;
      p.box(0.25, 4.0, 8.0, doors[i], 7.05, 0, z);
      p.box(0.3, 0.25, 8.0, COL.white, 7.08, 2.0, z);
    }
    return p;
  }

  function buildFuelFarm() {
    var p = new Parts();
    p.box(10, 0.8, 26, COL.concrete, 0, 0, 0);
    [-6.5, 6.5].forEach(function (z) {
      p.cyl(3.2, 3.2, 6, 12, COL.white, 0, 0.8, z);
      p.cyl(3.25, 3.25, 0.8, 12, COL.red, 0, 5.0, z);
      p.add(Geo.translate(Geo.cone(3.25, 0.9, 12, COL.white), 0, 0.8 + 6 + 0.45, z));
      p.beam([3.3, 0.8, z], [3.3, 7.0, z], 0.12, COL.darkSteel);
    });
    p.box(2.2, 2.4, 2.4, COL.red, 4, 0.8, 0);
    return p;
  }

  function buildPine(s, c) {
    var p = new Parts();
    p.cyl(0.25 * s, 0.35 * s, 1.6 * s, 5, COL.trunk, 0, 0, 0);
    p.add(Geo.translate(Geo.cone(2.4 * s, 4.2 * s, 7, c), 0, 1.2 * s + 2.1 * s, 0));
    p.add(Geo.translate(Geo.cone(1.8 * s, 3.4 * s, 7, c), 0, 3.6 * s + 1.7 * s, 0));
    p.add(Geo.translate(Geo.cone(1.1 * s, 2.6 * s, 7, c), 0, 5.8 * s + 1.3 * s, 0));
    return p;
  }

  /** Small high-wing aircraft, model space nose = -Z. */
  function buildLightPlane(c1, c2) {
    var p = new Parts();
    p.box(1.15, 1.25, 4.6, c1, 0, 0.75, 0.2);
    p.box(0.72, 0.8, 2.6, c1, 0, 1.05, 3.6);
    p.box(1.17, 0.2, 7.2, c2, 0, 1.2, 1.0);
    p.box(1.05, 1.0, 1.1, c2, 0, 0.85, -2.6);
    p.add(Geo.translate(Geo.rotateX(Geo.cone(0.32, 0.5, 6, c1), -Math.PI / 2), 0, 1.35, -3.4));
    p.box(1.2, 0.55, 1.6, COL.glass, 0, 1.45, -1.0, 0.25);
    p.box(10.6, 0.14, 1.5, c1, 0, 2.02, -0.7);
    p.box(0.8, 0.16, 1.52, c2, 4.95, 2.02, -0.7);
    p.box(0.8, 0.16, 1.52, c2, -4.95, 2.02, -0.7);
    p.beam([0.55, 1.0, -0.7], [2.7, 2.02, -0.7], 0.08, COL.darkSteel);
    p.beam([-0.55, 1.0, -0.7], [-2.7, 2.02, -0.7], 0.08, COL.darkSteel);
    p.box(3.6, 0.1, 0.9, c1, 0, 1.4, 4.5);
    p.box(0.1, 1.5, 1.1, c2, 0, 1.45, 4.5);
    // gear
    [[1.1, -0.2], [-1.1, -0.2], [0, -2.7]].forEach(function (w) {
      p.add(Geo.translate(Geo.rotateZ(Geo.cylinder(0.3, 0.3, 0.2, 8, COL.black), Math.PI / 2), w[0], 0.3, w[1]));
      p.beam([w[0] * 0.5, 0.9, w[1]], [w[0], 0.3, w[1]], 0.07, COL.darkSteel);
    });
    // two-blade prop
    p.add(Geo.translate(Geo.rotateZ(Geo.box(0.14, 1.9, 0.05, COL.black), 0.35), 0, 1.35, -3.62));
    return p;
  }

  function buildCar(c) {
    var p = new Parts();
    p.box(1.8, 0.75, 4.2, c, 0, 0.25, 0);
    p.box(1.6, 0.6, 2.2, COL.glass, 0, 1.0, 0.2, 0.15);
    p.box(1.62, 0.08, 2.1, c, 0, 1.6, 0.2);
    [[0.85, 1.3], [-0.85, 1.3], [0.85, -1.3], [-0.85, -1.3]].forEach(function (w) {
      p.add(Geo.translate(Geo.rotateZ(Geo.cylinder(0.32, 0.32, 0.25, 8, COL.black), Math.PI / 2), w[0], 0.32, w[1]));
    });
    return p;
  }

  // ------------------------------------------------------------------ light instances
  var LIGHT = {
    white: [1.0, 0.9, 0.74], green: [0.25, 1.0, 0.45], red: [1.0, 0.12, 0.06], blue: [0.2, 0.4, 1.0],
    amber: [1.0, 0.66, 0.2], strobe: [0.9, 0.95, 1.0], flood: [1.0, 0.85, 0.62]
  };
  var KIND = { normal: 0, papi: 1, beacon: 2, strobe: 3, flash: 4 };
  var lightData = [];
  function addLight(x, y, z, size, col, kind, dir, param) {
    lightData.push(x, y, z, size, col[0], col[1], col[2], kind,
      dir ? dir[0] : 0, dir ? dir[1] : 0, dir ? dir[2] : 0, param || 0);
  }

  // ------------------------------------------------------------------ state
  var gl = null;
  var progObj = null, progPaved = null, progRunway = null, progLight = null;
  var meshStatic = null, meshPaved = null, meshDecals = null, meshRunway = null;
  var meshSock = null, meshBeacon = null, meshLights = null;
  var texMarks = null, texSign = null;
  var lightCount = 0;
  var beaconAngle = 0;
  var socks = [];
  var IDENT = m4.create();
  var tmpM = m4.create(), tmpQ = RL.quat.create(), tmpV = v3.create();
  var AXIS_Y = [0, 1, 0];
  var bendVec = new Float32Array(4), noBend = new Float32Array(4);
  var pools = new Float32Array(16);
  var rwInfo = new Float32Array(4);
  // uniform maps reused every frame (no per-frame allocations)
  var U_PAVED = { u_pools: pools };
  var U_RUNWAY = { u_pools: pools, u_marks: 0, u_rw: rwInfo };
  var U_OBJ = { u_model: IDENT, u_bend: noBend, u_tex: 0 };
  var U_LIGHTS = { u_lightsOn: 0, u_beaconAngle: 0, u_minPx: 2.6 };

  // ------------------------------------------------------------------ shaders
  var OBJ_VS = [
    'layout(location = 0) in vec3 a_position;',
    'layout(location = 1) in vec3 a_normal;',
    'layout(location = 2) in vec4 a_color;',
    'layout(location = 3) in vec2 a_uv;',
    'uniform mat4 u_model;',
    'uniform vec4 u_bend;   // windsock: x droop, y extra droop toward the tail, z flutter, w length',
    'out vec3 v_world; out vec3 v_normal; out vec3 v_color; out vec2 v_uv;',
    'void main() {',
    '  vec3 p = a_position; vec3 n = a_normal;',
    '  if (u_bend.w > 0.0) {',
    '    float s = clamp(p.x / u_bend.w, 0.0, 1.0);',
    '    float fl = u_bend.z * s;',
    '    p.y += sin(u_time * 9.0 - p.x * 2.4) * fl * 0.16;',
    '    p.z += sin(u_time * 6.7 - p.x * 1.9 + 1.3) * fl * 0.22;',
    '    float a = -(u_bend.x + u_bend.y * s);',
    '    float c = cos(a), sn = sin(a);',
    '    p.xy = vec2(c * p.x - sn * p.y, sn * p.x + c * p.y);',
    '    n.xy = vec2(c * n.x - sn * n.y, sn * n.x + c * n.y);',
    '  }',
    '  vec4 w = u_model * vec4(p, 1.0);',
    '  v_world = w.xyz;',
    '  v_normal = mat3(u_model) * n;',
    '  v_color = a_color.rgb;',
    '  v_uv = a_uv;',
    '  gl_Position = u_viewProj * w;',
    '}'
  ].join('\n');

  var OBJ_FS = [
    'in vec3 v_world; in vec3 v_normal; in vec3 v_color; in vec2 v_uv;',
    'uniform sampler2D u_tex;',
    'out vec4 outColor;',
    'void main() {',
    '  vec3 N = normalize(v_normal);',
    '  if (!gl_FrontFacing) N = -N;',
    '  float isTex = step(0.5, v_uv.y);',
    '  vec3 tex = texture(u_tex, vec2(v_uv.x, v_uv.y - 1.0)).rgb;',
    '  vec3 base = mix(v_color, tex, isTex);',
    '  float emis = mix(v_uv.x, 0.35, isTex);',
    '  vec3 alb = toLinear(base);',
    '  float sh = shadowFactor(v_world, N);',
    '  vec3 c = shadeLit(alb, N, v_world, sh, 0.12 + 0.3 * emis, 32.0);',
    '  // windows and lamps: warm interior light at dusk / night',
    '  c += vec3(1.0, 0.68, 0.32) * emis * u_nightFactor * 1.4 * mix(1.0, alb.r * 3.0 + 0.3, isTex);',
    '  outColor = vec4(finalColor(applyFog(c, v_world)), 1.0);',
    '}'
  ].join('\n');

  var PAVED_VS = [
    'layout(location = 0) in vec3 a_position;',
    'layout(location = 2) in vec4 a_color;',
    'layout(location = 3) in vec2 a_uv;',
    'out vec3 v_world; out vec3 v_color; out float v_type;',
    'void main() {',
    '  v_world = a_position; v_color = a_color.rgb; v_type = a_uv.x;',
    '  gl_Position = u_viewProj * vec4(a_position, 1.0);',
    '}'
  ].join('\n');

  // Shared ground-surface helpers (pavement + runway): detail noise that fades out before it
  // aliases, and warm light pools under the apron floodlights at night.
  var GROUND_FUNCS = [
    'uniform vec4 u_pools[4];',
    'float detailNoise(vec2 p, float freq) {',
    '  float fw = length(fwidth(p * freq));',
    '  return (vnoise(p * freq) - 0.5) * (1.0 - smoothstep(0.35, 1.2, fw));',
    '}',
    'vec3 poolLight(vec3 wp) {',
    '  vec3 acc = vec3(0.0);',
    '  for (int i = 0; i < 4; i++) {',
    '    vec2 d = wp.xz - u_pools[i].xy;',
    '    acc += exp(-dot(d, d) / (u_pools[i].z * u_pools[i].z));',
    '  }',
    '  return vec3(1.0, 0.72, 0.42) * acc * 0.9 * u_nightFactor;',
    '}'
  ].join('\n');

  var PAVED_FS = [
    'in vec3 v_world; in vec3 v_color; in float v_type;',
    'out vec4 outColor;',
    GROUND_FUNCS,
    'void main() {',
    '  vec3 base = v_color;',
    '  vec2 p = v_world.xz;',
    '  float paint = step(1.5, v_type);',
    '  float n = detailNoise(p, 1.3) * 0.12 + detailNoise(p, 0.25) * 0.14 + (vnoise(p * 0.03) - 0.5) * 0.16;',
    '  base *= 1.0 + n * (1.0 - paint * 0.6);',
    '  // concrete slab joints (5 m slabs), antialiased',
    '  if (v_type > 0.5 && v_type < 1.5) {',
    '    vec2 g = abs(fract(p / 5.0) - 0.5) * 5.0;   // 2.5 at a joint',
    '    vec2 w = fwidth(p);',
    '    float jx = smoothstep(2.42 - w.x, 2.42, g.x);',
    '    float jz = smoothstep(2.42 - w.y, 2.42, g.y);',
    '    float fade = 1.0 - smoothstep(0.25, 0.8, max(w.x, w.y));',
    '    base *= 1.0 - 0.16 * max(jx, jz) * fade;',
    '    base *= 0.97 + 0.06 * hash12(floor(p / 5.0));',
    '  }',
    '  vec3 N = vec3(0.0, 1.0, 0.0);',
    '  vec3 alb = toLinear(base);',
    '  vec3 c = shadeLit(alb, N, v_world, shadowFactor(v_world, N), 0.05 + paint * 0.1, 16.0);',
    '  c += alb * poolLight(v_world);',
    '  outColor = vec4(finalColor(applyFog(c, v_world)), 1.0);',
    '}'
  ].join('\n');

  var RUNWAY_FS = [
    'in vec3 v_world; in vec3 v_color; in float v_type;',
    'uniform sampler2D u_marks;',
    'uniform vec4 u_rw;        // cx, cz, halfLength, halfWidth',
    'out vec4 outColor;',
    GROUND_FUNCS,
    // Piecewise row mapping of the marking atlas: d in [0,100] -> rows 0..1024, [100,512] -> 1024..2048
    'float rowOf(float d) { return d < 100.0 ? d * 10.24 : 1024.0 + (d - 100.0) * (1024.0 / 412.0); }',
    'float band(float x, float a, float b, float aa) { return smoothstep(a - aa, a + aa, x) - smoothstep(b - aa, b + aa, x); }',
    'void main() {',
    '  float x = v_world.x - u_rw.x, z = v_world.z - u_rw.y;',
    '  float hl = u_rw.z, hw = u_rw.w;',
    '  bool south = z > 0.0;',
    '  float d = hl - abs(z);                       // distance from the nearest threshold',
    '  float lat = south ? (x + hw) : (hw - x);      // from the landing pilot\'s left edge',
    '  vec2 uv = vec2(clamp(lat / (2.0 * hw), 0.001, 0.999) * 0.5 + (south ? 0.0 : 0.5), rowOf(clamp(d, 0.0, 511.0)) / 2048.0);',
    '  float dvdd = (d < 100.0 ? 10.24 : 1024.0 / 412.0) / 2048.0;',
    '  vec2 gx = vec2(dFdx(x) / (4.0 * hw), abs(dFdx(abs(z))) * dvdd);',
    '  vec2 gy = vec2(dFdy(x) / (4.0 * hw), abs(dFdy(abs(z))) * dvdd);',
    '  vec4 mk = textureGrad(u_marks, uv, gx, gy) * step(d, 510.0);',
    '  // analytic edge stripes + dashed centerline (same everywhere, crisp at any distance)',
    '  float aax = fwidth(x) * 0.75 + 0.02, aad = fwidth(d) * 0.75 + 0.02;',
    '  float ax = abs(x);',
    '  float edge = band(ax, hw - 1.1, hw - 0.2, aax);',
    '  float ph = d / 50.0;',
    '  float dash = band(fract(ph) * 50.0, 10.0, 40.0, aad) * step(105.0, d);',
    '  float center = band(x, -0.45, 0.45, aax) * dash;',
    '  float paint = clamp(max(mk.r, max(edge, center)), 0.0, 1.0);',
    '  vec2 p = v_world.xz;',
    '  float grain = detailNoise(p, 2.1) * 0.10 + detailNoise(p, 0.45) * 0.12;',
    '  float patches = smoothstep(0.62, 0.7, vnoise(p * vec2(0.035, 0.012) + 3.7));',
    '  vec3 asphalt = vec3(0.205, 0.205, 0.215) * (1.0 + grain + (vnoise(p * 0.02) - 0.5) * 0.18);',
    '  asphalt = mix(asphalt, asphalt * vec3(0.8, 0.8, 0.82), patches * 0.8);',
    '  // rubber deposits: centre of the touchdown zones + painted tire-mark atlas',
    '  float rubber = mk.g + smoothstep(9.0, 0.0, ax) * smoothstep(120.0, 260.0, d) * smoothstep(650.0, 420.0, d) * 0.35;',
    '  float wear = 0.8 + 0.2 * vnoise(p * vec2(1.7, 0.6));',
    '  vec3 base = mix(asphalt, vec3(0.9, 0.9, 0.88) * wear, paint * 0.95);',
    '  base *= 1.0 - clamp(rubber, 0.0, 1.0) * 0.55;',
    '  vec3 N = vec3(0.0, 1.0, 0.0);',
    '  vec3 alb = toLinear(base);',
    '  vec3 c = shadeLit(alb, N, v_world, shadowFactor(v_world, N), 0.06 + paint * 0.12, 20.0);',
    '  // warm pools under the edge lights at night',
    '  float sp = 2.0 * hl / 24.0;',
    '  float zl = (floor((z + hl) / sp + 0.5)) * sp - hl;',
    '  vec2 dl = vec2(ax - (hw + 1.5), z - zl);',
    '  c += alb * vec3(1.0, 0.82, 0.6) * exp(-dot(dl, dl) / 9.0) * 1.3 * clamp(u_nightFactor * 2.2, 0.0, 1.0);',
    '  c += alb * poolLight(v_world);',
    '  outColor = vec4(finalColor(applyFog(c, v_world)), 1.0);',
    '}'
  ].join('\n');

  // Additive light sprites with a minimum on-screen size.
  var LIGHT_VS = [
    'layout(location = 0) in vec3 a_position;',
    'layout(location = 4) in vec4 i_pos;   // xyz, size (m)',
    'layout(location = 5) in vec4 i_col;   // sRGB color, kind',
    'layout(location = 6) in vec4 i_dir;   // facing (xz) or 0, param',
    'uniform float u_lightsOn; uniform float u_beaconAngle; uniform float u_minPx;',
    'out vec2 v_q; out vec3 v_col; out float v_int; out float v_op;',
    'float fogF(vec3 wp) {',
    '  vec3 d = wp - u_camPos; float dist = length(d);',
    '  if (dist < 1e-3) return 0.0;',
    '  float b = max(u_fogHeightFalloff, 1e-6);',
    '  float ry = d.y / dist; if (abs(ry) < 1e-4) ry = 1e-4;',
    '  float fa = (u_fogDensity / b) * exp(-max(u_camPos.y, -500.0) * b) * (1.0 - exp(-dist * ry * b)) / ry;',
    '  return 1.0 - exp(-max(fa, 0.0));',
    '}',
    'void main() {',
    '  vec3 P = i_pos.xyz;',
    '  vec3 toCam = u_camPos - P;',
    '  float dist = max(length(toCam), 1e-3);',
    '  vec2 th = toCam.xz / max(length(toCam.xz), 1e-3);',
    '  float kind = i_col.w;',
    '  vec3 col = pow(i_col.rgb, vec3(2.2));',
    '  float inten = 1.0;',
    '  float op = 0.0, minPx = u_minPx;',
    '  if (dot(i_dir.xz, i_dir.xz) > 0.0) inten *= smoothstep(-0.3, 0.35, dot(th, i_dir.xz));',
    '  if (kind < 0.5) {',
    '    inten *= u_lightsOn;',
    '  } else if (kind < 1.5) {',
    '    // PAPI: white above this box\'s angle, red below (narrow pink transition like the real thing)',
    '    float elev = atan(toCam.y, max(length(toCam.xz), 1e-3));',
    '    float t = smoothstep(i_dir.w - 0.0008, i_dir.w + 0.0008, elev);',
    '    col = mix(vec3(1.0, 0.012, 0.004), vec3(1.0, 0.86, 0.72), t);',
    '    inten *= 1.6;',
    '    op = 0.92; minPx *= 2.0;   // opaque cores so red reads as red against daylit grass',
    '  } else if (kind < 2.5) {',
    '    float a = u_beaconAngle + i_dir.w;',
    '    vec2 bd = vec2(sin(a), -cos(a));',
    '    float beam = pow(max(dot(bd, th), 0.0), 28.0);',
    '    inten *= (0.12 + 3.5 * beam) * u_lightsOn;',
    '  } else if (kind < 3.5) {',
    '    float ph = fract(u_time * 2.0 - i_dir.w);',
    '    inten *= exp(-ph * 30.0) * 3.0 * u_lightsOn;',
    '  } else {',
    '    inten *= (0.15 + 0.85 * step(0.55, fract(u_time * 0.8 + i_dir.w))) * u_lightsOn;',
    '  }',
    '  inten *= 1.0 - 0.85 * fogF(P);',
    '  vec4 clip = u_viewProj * vec4(P, 1.0);',
    '  float pxPerM = u_proj[1][1] * u_resolution.y * 0.5 / max(clip.w, 1e-3);',
    '  float size = max(i_pos.w, minPx / pxPerM);',
    '  // lights inflated to the minimum pixel size get dimmer so distant rows do not merge into blobs',
    '  if (op == 0.0) inten *= clamp(sqrt(i_pos.w / size), 0.4, 1.0);',
    '  vec3 right = vec3(u_view[0][0], u_view[1][0], u_view[2][0]);',
    '  vec3 up = vec3(u_view[0][1], u_view[1][1], u_view[2][1]);',
    '  vec3 wp = P + (right * a_position.x + up * a_position.y) * size + (toCam / dist) * min(size, dist * 0.5);',
    '  v_q = a_position.xy; v_col = col; v_int = inten; v_op = op * clamp(inten, 0.0, 1.0);',
    '  gl_Position = inten > 0.002 ? u_viewProj * vec4(wp, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);',
    '}'
  ].join('\n');

  var LIGHT_FS = [
    'in vec2 v_q; in vec3 v_col; in float v_int; in float v_op;',
    'out vec4 outColor;',
    'void main() {',
    '  float r2 = dot(v_q, v_q);',
    '  if (r2 > 1.0) discard;',
    '  float core = exp(-r2 * 22.0);',
    '  float halo = exp(-r2 * 5.0) * 0.35;',
    '  vec3 c = v_col * v_int * (core * 5.0 + halo);',
    '  // premultiplied: alpha 0 = purely additive glow, alpha > 0 also covers what is behind',
    '  outColor = vec4(finalColor(c), v_op * smoothstep(0.35, 0.15, r2));',
    '}'
  ].join('\n');

  // ------------------------------------------------------------------ textures
  function makeMarkingsAtlas() {
    var W = 1024, H = 2048, half = 512, sx = half / (2 * HW);
    var cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    var syA = 10.24, syB = 1024 / 412, offB = 1024 - 100 * syB;
    function rowOf(d) { return d < 100 ? d * syA : offB + d * syB; }
    // Rectangle in (lat, d) runway-end coordinates.
    function rect(endIdx, lat0, lat1, d0, d1) {
      var x0 = endIdx * half + lat0 * sx, x1 = endIdx * half + lat1 * sx;
      var y0 = rowOf(d0), y1 = rowOf(d1);
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
    // symmetric bars about the centerline (lateral offsets from the centerline)
    function pair(endIdx, o0, o1, d0, d1) {
      rect(endIdx, HW + o0, HW + o1, d0, d1);
      rect(endIdx, HW - o1, HW - o0, d0, d1);
    }
    var digits = { 0: '36', 1: '18' };
    for (var e = 0; e < 2; e++) {
      ctx.fillStyle = '#f00';
      // threshold bar and piano keys
      rect(e, 1.0, 2 * HW - 1.0, 1.0, 2.8);
      for (var k = 0; k < 6; k++) pair(e, 2.2 + k * 2.8, 3.6 + k * 2.8, 6, 51);
      // touchdown zone (150 m, 450 m) and aiming point (300 m)
      for (k = 0; k < 3; k++) pair(e, 3.0 + k * 3.3, 4.8 + k * 3.3, 150, 172.5);
      pair(e, 5.0, 10.5, 300, 345);
      for (k = 0; k < 2; k++) pair(e, 3.0 + k * 3.3, 4.8 + k * 3.3, 450, 472.5);
      // runway designator: digits 13 m tall (drawn in a 3 x 9 unit box, scaled), tops pointing
      // away from the threshold so a pilot landing on this end reads them upright
      var numD = 62, str = digits[e], ks = 13 / 9, dW = 3 * ks, gap = 1.6;
      for (var c = 0; c < 2; c++) {
        var left = HW - (2 * dW + gap) / 2 + c * (dW + gap);
        ctx.save();
        // digit coords (xv right, yv down with yv = 0 at the digit top = far end) -> atlas
        ctx.setTransform(sx * ks, 0, 0, -syA * ks, e * half + left * sx, (numD + 13) * syA);
        ctx.strokeStyle = '#f00';
        ctx.lineWidth = 0.8;
        ctx.lineCap = 'butt';
        ctx.lineJoin = 'round';
        drawDigit(ctx, str[c]);
        ctx.restore();
      }
      // tire marks (green channel, additive) in the touchdown zones
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      var rnd = M.rng(1234 + e * 77);
      for (k = 0; k < 140; k++) {
        var side = rnd() < 0.5 ? -1 : 1;
        var off = side * (0.8 + rnd() * 3.8);
        var d0 = 110 + Math.pow(rnd(), 1.6) * 360, len = 15 + rnd() * 120;
        var a = 0.06 + rnd() * 0.16;
        ctx.fillStyle = 'rgba(0,255,0,' + a.toFixed(3) + ')';
        var w = 0.25 + rnd() * 0.35, drift = (rnd() - 0.5) * 0.8;
        var x0 = e * half + (HW + off) * sx, x1 = e * half + (HW + off + drift) * sx;
        var y0 = rowOf(Math.max(d0, 101)), y1 = rowOf(Math.min(d0 + len, 505));
        ctx.beginPath();
        ctx.moveTo(x0, y0); ctx.lineTo(x0 + w * sx, y0);
        ctx.lineTo(x1 + w * sx, y1); ctx.lineTo(x1, y1);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }
    return cv;
  }

  /** Stroke a runway numeral in a 3 x 9 box (x right, y down from the digit top). */
  function drawDigit(ctx, ch) {
    ctx.beginPath();
    if (ch === '1') {
      ctx.moveTo(1.7, 0.42); ctx.lineTo(1.7, 8.58);
      ctx.moveTo(0.55, 1.7); ctx.lineTo(1.75, 0.5);
    } else if (ch === '3') {
      ctx.moveTo(1.5 + 1.15 * Math.cos(1.1 * Math.PI), 2.3 + 1.85 * Math.sin(1.1 * Math.PI));
      ctx.ellipse(1.5, 2.3, 1.15, 1.85, 0, 1.1 * Math.PI, 2.5 * Math.PI, false);
      ctx.moveTo(1.5, 4.25);
      ctx.ellipse(1.5, 6.45, 1.2, 2.13, 0, 1.5 * Math.PI, 2.92 * Math.PI, false);
    } else if (ch === '6') {
      ctx.moveTo(1.5 + 1.15, 6.4);
      ctx.ellipse(1.5, 6.4, 1.15, 2.15, 0, 0, 2 * Math.PI, false);
      ctx.moveTo(0.35, 6.4);
      ctx.bezierCurveTo(0.35, 2.2, 0.9, 0.42, 2.55, 0.62);
    } else if (ch === '8') {
      ctx.moveTo(1.5 + 1.0, 2.3);
      ctx.ellipse(1.5, 2.3, 1.0, 1.88, 0, 0, 2 * Math.PI, false);
      ctx.moveTo(1.5 + 1.2, 6.45);
      ctx.ellipse(1.5, 6.45, 1.2, 2.13, 0, 0, 2 * Math.PI, false);
    }
    ctx.stroke();
  }

  function makeSignTexture() {
    var cv = document.createElement('canvas');
    cv.width = 1024; cv.height = 256;
    var ctx = cv.getContext('2d');
    function board(y, bg, fg, text, sub) {
      ctx.fillStyle = bg;
      ctx.fillRect(0, y, 1024, 128);
      ctx.strokeStyle = fg;
      ctx.lineWidth = 6;
      ctx.strokeRect(10, y + 10, 1004, 108);
      // little mountain emblem
      ctx.fillStyle = fg;
      ctx.beginPath();
      ctx.moveTo(40, y + 98); ctx.lineTo(80, y + 38); ctx.lineTo(100, y + 64); ctx.lineTo(118, y + 44); ctx.lineTo(152, y + 98);
      ctx.closePath(); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(872, y + 98); ctx.lineTo(906, y + 44); ctx.lineTo(924, y + 64); ctx.lineTo(944, y + 38); ctx.lineTo(984, y + 98);
      ctx.closePath(); ctx.fill();
      ctx.font = 'bold ' + (sub ? 58 : 68) + 'px "Trebuchet MS", "DejaVu Sans", Verdana, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 512, y + 66);
    }
    board(0, '#23493a', '#f3ead2', 'RIDGELINE FIELD', false);
    board(128, '#8c2f22', '#fbe9c4', 'CAFÉ · FLIGHT SCHOOL', true);
    return cv;
  }

  // ------------------------------------------------------------------ build
  function buildStatic() {
    var all = new Parts();
    var p;

    // Hangar (door faces +X / the apron)
    place(all, buildHangar(), HANGAR.x, HANGAR.z, 0, 'hangar');
    place(all, buildTower(), TOWER.x, TOWER.z, 0, 'tower');
    place(all, buildClubhouse(), CLUB.x, CLUB.z, 0, 'clubhouse');
    place(all, buildTHangars(), THANGARS.x, THANGARS.z, 0, 't-hangars');
    place(all, buildFuelFarm(), FUEL.x, FUEL.z, 0, 'fuel farm');

    // Parked aircraft
    PARKED.forEach(function (pp, i) {
      place(all, buildLightPlane(pp.c1, pp.c2), pp.x, pp.z, -pp.h * M.DEG, 'parked aircraft ' + (i + 1));
    });

    // Cars in the lot
    var carCols = [[0.8, 0.18, 0.15], [0.2, 0.35, 0.6], [0.92, 0.9, 0.85], [0.3, 0.5, 0.3], [0.95, 0.7, 0.2]];
    var carGroup = new Parts();
    [16, 23, 30, 44, 55].forEach(function (dz, i) {
      var g = buildCar(carCols[i]).merge();
      Geo.rotateY(g, i % 2 ? Math.PI / 2 : -Math.PI / 2);
      Geo.translate(g, -5 + (i % 2) * 10, 0, dz - 35);
      carGroup.addRaw(g);
    });
    place(all, carGroup, (LOT.minX + LOT.maxX) / 2, CZ + 35, 0, 'parked cars');

    // Pump island on the apron
    p = new Parts();
    p.box(3, 0.3, 6, COL.concrete, 0, 0, 0);
    p.box(0.8, 1.6, 0.8, COL.red, 0, 0.3, -1.4);
    p.box(0.8, 1.6, 0.8, COL.red, 0, 0.3, 1.4);
    p.box(3.6, 0.3, 7.2, COL.white, 0, 3.6, 0);
    p.box(0.25, 3.3, 0.25, COL.steel, 0, 0.3, -3.2);
    p.box(0.25, 3.3, 0.25, COL.steel, 0, 0.3, 3.2);
    place(all, p, CX - 206, CZ - 96, 0, 'fuel pumps');

    // Floodlight poles
    FLOODS.forEach(function (f, i) {
      var q = new Parts();
      q.cyl(0.18, 0.28, 14, 6, COL.steel, 0, 0, 0);
      q.box(1.8, 0.5, 0.9, COL.darkSteel, f[2] * 0.6, 13.6, f[3] * 0.6);
      q.box(1.5, 0.12, 0.6, [1.0, 0.95, 0.8], f[2] * 0.6, 13.5, f[3] * 0.6, 1.0);
      place(all, q, f[0], f[1], 0, 'floodlight ' + (i + 1));
    });

    // Fence behind the buildings
    p = new Parts();
    var fz0 = CZ - 150, fz1 = CZ + 240, fx = CX - 292;
    for (var z = fz0; z <= fz1; z += 6) p.box(0.14, 1.7, 0.14, COL.darkSteel, 0, 0, z - fz0);
    p.box(0.06, 0.08, fz1 - fz0, COL.steel, 0, 0.7, (fz1 - fz0) / 2);
    p.box(0.06, 0.08, fz1 - fz0, COL.steel, 0, 1.55, (fz1 - fz0) / 2);
    place(all, p, fx, fz0, 0, 'fence');

    // Pines around the buildings (each its own collider)
    var rnd = M.rng(99);
    var pines = [[-310, -120], [-318, -60], [-305, 10], [-322, 60], [-309, 118], [-326, 170], [-312, 225],
      [-340, -20], [-345, 100], [-338, 205], [-255, 72], [-262, 80], [-252, 98], [-262, -120], [-252, -128],
      [-360, -140], [-372, 40], [-366, 150], [-390, -80], [-395, 95]];
    pines.forEach(function (t, i) {
      var s = 0.8 + rnd() * 0.7;
      var c = rnd() < 0.5 ? COL.pine : COL.pine2;
      place(all, buildPine(s, c), CX + t[0], CZ + t[1], rnd() * 6, 'tree');
    });

    // Windsock poles (+ segmented circle around the main one)
    WINDSOCKS.forEach(function (ws, i) {
      var q = new Parts();
      q.cyl(0.1, 0.14, 6.6, 6, COL.white, 0, 0, 0);
      q.box(0.3, 0.3, 0.3, COL.red, 0, 6.5, 0);
      q.cyl(0.6, 0.6, 0.4, 8, COL.concrete, 0, 0, 0);
      place(all, q, ws.x, ws.z, 0, 'windsock ' + (i + 1));
      if (ws.circle) {
        var sc = new Parts();
        for (var k = 0; k < 16; k++) {
          var a = k / 16 * Math.PI * 2;
          var g = Geo.box(3.2, 0.25, 0.8, k % 2 ? COL.white : COL.orange);
          Geo.rotateY(g, a);   // long side tangent to the circle
          Geo.translate(g, Math.sin(a) * 13, 0.12, Math.cos(a) * 13);
          sc.add(g);
        }
        place(all, sc, ws.x, ws.z, 0, null);
      }
    });

    // Hold-short signs at every connector (outside the 30 m strip)
    CONNECTORS.forEach(function (zc) {
      [-1, 1].forEach(function (s) {
        var q = new Parts();
        q.box(0.1, 0.5, 0.1, COL.darkSteel, 0, 0, -0.8);
        q.box(0.1, 0.5, 0.1, COL.darkSteel, 0, 0, 0.8);
        q.box(0.3, 0.8, 2.4, COL.red, 0, 0.5, 0);
        q.box(0.32, 0.3, 1.6, COL.white, 0, 0.75, 0);
        place(all, q, CX - HW - 32, zc + s * 12.5, 0, 'sign');
      });
    });

    // --- light fixtures (visual stubs; not colliders) + light instances
    buildLights(all);

    return Geo.toFlat(all.merge());
  }

  function buildLights(all) {
    lightData.length = 0;
    var p = new Parts();
    var y = E + 0.45;
    var sp = RW.length / 24;
    var i, k, z, x;
    // runway edge lights: bidirectional, amber toward the pilot on the last 600 m
    for (i = 1; i < 24; i++) {
      z = CZ - HL + i * sp;
      for (var s = -1; s <= 1; s += 2) {
        x = CX + s * (HW + 1.5);
        p.box(0.22, 0.4, 0.22, COL.lightFixture, x, E, z);
        var northPart = z < CZ - HL + 600, southPart = z > CZ + HL - 600;
        addLight(x, y, z, 1.0, northPart ? LIGHT.amber : LIGHT.white, KIND.normal, [0, 0, 1]);   // seen by 36 traffic
        addLight(x, y, z, 1.0, southPart ? LIGHT.amber : LIGHT.white, KIND.normal, [0, 0, -1]);  // seen by 18 traffic
      }
    }
    // threshold (green, outward) / runway end (red, inward) lights at both ends
    [1, -1].forEach(function (endSign) {
      var zt = CZ + endSign * (HL + 0.8);
      for (k = 0; k <= 10; k++) {
        x = CX - HW + k * 4;
        p.box(0.3, 0.35, 0.3, COL.lightFixture, x, E, zt);
        addLight(x, y - 0.05, zt + endSign * 0.2, 1.15, LIGHT.green, KIND.normal, [0, 0, endSign]);
        addLight(x, y - 0.05, zt - endSign * 0.2, 1.0, LIGHT.red, KIND.normal, [0, 0, -endSign]);
      }
    });
    // approach lights + sequenced flashers south of runway 36
    for (k = 0; k < 10; k++) {
      z = CZ + HL + 60 + k * 30;
      var ground = groundAt(CX, z);
      var ly = Math.max(E + 1.0, ground + 0.8);
      var xs = [-6, -3, 0, 3, 6];
      if (k === 8) xs = xs.concat([-15, -12, -9, 9, 12, 15]);
      p.box(k === 8 ? 31 : 13, 0.14, 0.14, COL.darkSteel, CX, ly - 0.35, z);   // crossbar
      for (i = 0; i < xs.length; i++) {
        var g2 = groundAt(CX + xs[i], z);
        p.box(0.12, Math.max(0.2, ly - 0.2 - g2), 0.12, COL.darkSteel, CX + xs[i], g2, z);
        addLight(CX + xs[i], ly, z, 1.0, LIGHT.white, KIND.normal, [0, 0, 1]);
      }
      addLight(CX, ly + 0.5, z, 1.7, LIGHT.strobe, KIND.strobe, [0, 0, 1], (9 - k) * 0.045);
    }
    // REIL on runway 18 (synchronized strobes either side of the threshold)
    [-1, 1].forEach(function (s) {
      x = CX + s * (HW + 5);
      z = CZ - HL - 2;
      p.box(0.5, 0.6, 0.5, COL.darkSteel, x, E, z);
      addLight(x, E + 0.9, z, 1.6, LIGHT.strobe, KIND.strobe, [0, 0, -1], 0.5);
    });
    // PAPI: left of each touchdown zone. Inner box = highest angle.
    Airfield.papi = [];
    [{ dir: 1, side: -1 }, { dir: -1, side: 1 }].forEach(function (rw) {
      var zp = CZ + rw.dir * (HL - PAPI_D);
      var unit = { x: CX + rw.side * PAPI_INNER, z: zp, facing: [0, 0, rw.dir], lights: [] };
      for (k = 0; k < 4; k++) {
        // k = 0 outer (2.5 deg) ... 3 inner (3.5 deg)
        x = CX + rw.side * (PAPI_INNER + (3 - k) * PAPI_SPACING);
        p.box(1.8, 0.9, 1.1, [0.78, 0.76, 0.7], x, E + 0.25, zp);
        p.box(0.2, 0.25, 0.2, COL.darkSteel, x - 0.7, E, zp);
        p.box(0.2, 0.25, 0.2, COL.darkSteel, x + 0.7, E, zp);
        p.box(1.3, 0.5, 0.1, COL.black, x, E + 0.45, zp + rw.dir * 0.56);
        var ang = PAPI_ANGLES[k];
        addLight(x, E + 0.72, zp + rw.dir * 0.8, 2.0, LIGHT.white, KIND.papi, [0, 0, rw.dir], ang * M.DEG);
        unit.lights.push({ x: x, y: E + 0.72, z: zp + rw.dir * 0.8, angleDeg: ang });
      }
      Airfield.papi.push(unit);
    });
    // taxiway edge lights (blue)
    var tx = [TWY_X - TWY_HW - 0.8, TWY_X + TWY_HW + 0.8];
    for (z = TWY_Z0 + 4; z <= TWY_Z1 - 4; z += 30) {
      for (i = 0; i < 2; i++) {
        var skip = false;
        if (i === 1) CONNECTORS.forEach(function (zc) { if (Math.abs(z - zc) < 13) skip = true; });
        if (i === 0 && z > APRON.minZ - 4 && z < APRON.maxZ + 4) skip = true;
        if (skip) continue;
        p.box(0.2, 0.35, 0.2, COL.blueFixture, tx[i], E, z);
        addLight(tx[i], E + 0.4, z, 0.75, LIGHT.blue, KIND.normal);
      }
    }
    CONNECTORS.forEach(function (zc) {
      for (x = TWY_X + TWY_HW + 8; x < CX - HW - 5; x += 16) {
        [-1, 1].forEach(function (s) {
          p.box(0.2, 0.35, 0.2, COL.blueFixture, x, E, zc + s * 9.8);
          addLight(x, E + 0.4, zc + s * 9.8, 0.75, LIGHT.blue, KIND.normal);
        });
      }
    });
    for (x = APRON.minX + 6; x < APRON.maxX - 2; x += 26) {
      [APRON.minZ - 0.8, APRON.maxZ + 0.8].forEach(function (zz) {
        p.box(0.2, 0.35, 0.2, COL.blueFixture, x, E, zz);
        addLight(x, E + 0.4, zz, 0.75, LIGHT.blue, KIND.normal);
      });
    }
    // floodlight lamps
    FLOODS.forEach(function (f) {
      addLight(f[0] + f[2] * 0.6, E + 13.4, f[1] + f[3] * 0.6, 2.2, LIGHT.flood, KIND.normal);
    });
    // rotating beacon on the tower (white + green, opposite sides) and obstruction lights
    addLight(TOWER.x, E + 20.9, TOWER.z, 3.2, [1.0, 0.95, 0.85], KIND.beacon, null, 0);
    addLight(TOWER.x, E + 20.9, TOWER.z, 3.2, [0.3, 1.0, 0.5], KIND.beacon, null, Math.PI);
    addLight(TOWER.x - 2.6, E + 25.7, TOWER.z - 2.6, 1.1, LIGHT.red, KIND.flash, null, 0);
    addLight(HANGAR.x - HANGAR.L / 2, E + HANGAR.R + 0.8, HANGAR.z, 1.1, LIGHT.red, KIND.flash, null, 0.37);
    all.addRaw(p.merge());
  }

  function groundAt(x, z) {
    var h = RL.World ? RL.World.heightAt(x, z) : E;
    return isFinite(h) ? h : E;
  }

  function buildPaved() {
    var y = E + 0.02;
    function rectQuad(r) {
      var q = Geo.quad([r.minX, y, r.maxZ], [r.maxX, y, r.maxZ], [r.maxX, y, r.minZ], [r.minX, y, r.minZ], r.color);
      var n = q.positions.length / 3;
      q.uvs = [];
      for (var i = 0; i < n; i++) q.uvs.push(r.type, 0);
      return q;
    }
    var list = PAVED.map(rectQuad);
    // fillets where the connectors meet the runway and the taxiway
    CONNECTORS.forEach(function (zc) {
      [-1, 1].forEach(function (s) {
        var tri = Geo.create();
        var a = [CX - HW, y, zc + s * 9], b = [CX - HW, y, zc + s * 21], c = [CX - HW - 12, y, zc + s * 9];
        var ta = [TWY_X + TWY_HW, y, zc + s * 9], tb = [TWY_X + TWY_HW + 12, y, zc + s * 9], tc = [TWY_X + TWY_HW, y, zc + s * 21];
        [[a, b, c], [ta, tb, tc]].forEach(function (t) {
          var base = tri.positions.length / 3;
          t.forEach(function (pp) { tri.positions.push(pp[0], pp[1], pp[2]); tri.normals.push(0, 1, 0); tri.colors.push(0.25, 0.25, 0.26); tri.uvs.push(0, 0); });
          // ensure CCW seen from above (+Y)
          var e1x = t[1][0] - t[0][0], e1z = t[1][2] - t[0][2], e2x = t[2][0] - t[0][0], e2z = t[2][2] - t[0][2];
          var ny = e1z * e2x - e1x * e2z;
          if (ny > 0) tri.indices.push(base, base + 1, base + 2); else tri.indices.push(base, base + 2, base + 1);
        });
        // keep only fillets that stay on flat ground inside the paved area
        if (Math.abs(zc) < HL - 30 || s === (zc > 0 ? -1 : 1)) list.push(tri);
      });
    });
    return Geo.merge(list);
  }

  function buildDecals() {
    var g = [];
    var y = E + 0.04;
    var YEL = [0.93, 0.72, 0.1], WHITE = [0.92, 0.92, 0.9];
    function stripe(x0, z0, x1, z1, w, col) {
      var dx = x1 - x0, dz = z1 - z0, l = Math.hypot(dx, dz);
      if (l < 1e-3) return;
      var nx = -dz / l * w / 2, nz = dx / l * w / 2;
      var q = Geo.quad([x0 - nx, y, z0 - nz], [x0 + nx, y, z0 + nz], [x1 + nx, y, z1 + nz], [x1 - nx, y, z1 - nz], col);
      if (q.normals[1] < 0) q = Geo.quad([x0 + nx, y, z0 + nz], [x0 - nx, y, z0 - nz], [x1 - nx, y, z1 - nz], [x1 + nx, y, z1 + nz], col);
      q.uvs = [2, 0, 2, 0, 2, 0, 2, 0];
      g.push(q);
    }
    // taxiway A centerline
    stripe(TWY_X, TWY_Z0 + 9, TWY_X, TWY_Z1 - 9, 0.45, YEL);
    CONNECTORS.forEach(function (zc) {
      stripe(CX - HW + 1, zc, TWY_X, zc, 0.45, YEL);
      // hold-short: two solid lines on the taxiway side, two dashed on the runway side
      var hx = CX - HW - 30;
      stripe(hx - 1.2, zc - 8.5, hx - 1.2, zc + 8.5, 0.3, YEL);
      stripe(hx - 0.6, zc - 8.5, hx - 0.6, zc + 8.5, 0.3, YEL);
      for (var zz = zc - 8.5; zz < zc + 8.5; zz += 1.8) {
        stripe(hx + 0.3, zz, hx + 0.3, Math.min(zz + 0.9, zc + 8.5), 0.3, YEL);
        stripe(hx + 0.9, zz, hx + 0.9, Math.min(zz + 0.9, zc + 8.5), 0.3, YEL);
      }
    });
    // apron lead-in lines + parking "T" bars
    PARKED.slice(0, 3).forEach(function (pp) {
      stripe(TWY_X - TWY_HW, pp.z, pp.x - 1, pp.z, 0.4, YEL);
      stripe(pp.x - 1, pp.z - 3, pp.x - 1, pp.z + 3, 0.5, YEL);
    });
    // hangar lead-in
    stripe(TWY_X - TWY_HW, HANGAR.z, HANGAR.x + 2, HANGAR.z, 0.4, YEL);
    // blast pad chevrons pointing at the runway
    [1, -1].forEach(function (s) {
      var z0 = CZ + s * HL;
      for (var k = 0; k < 3; k++) {
        var zt = z0 + s * (8 + k * 13);
        stripe(CX, zt, CX - HW + 1.5, zt + s * 11, 1.0, YEL);
        stripe(CX, zt, CX + HW - 1.5, zt + s * 11, 1.0, YEL);
      }
    });
    // parking lot bays (white)
    for (var z = LOT.minZ + 4; z <= LOT.maxZ - 4; z += 3.5) {
      stripe(LOT.minX + 1, z, LOT.minX + 7, z, 0.15, WHITE);
      stripe(LOT.maxX - 7, z, LOT.maxX - 1, z, 0.15, WHITE);
    }
    return Geo.merge(g);
  }

  function buildSock() {
    // 5 alternating bands, mouth at x = 0 (radius 0.45) tapering to 0.18 at x = 3.6
    var list = [], n = 5, len = 3.6;
    for (var i = 0; i < n; i++) {
      var x0 = i * len / n, x1 = (i + 1) * len / n;
      var r0 = M.lerp(0.46, 0.2, x0 / len), r1 = M.lerp(0.46, 0.2, x1 / len);
      var g = Geo.cylinder(r1, r0, x1 - x0, 8, i % 2 ? COL.white : COL.orange, { caps: false });
      Geo.rotateZ(g, -Math.PI / 2); // +Y -> +X
      Geo.translate(g, (x0 + x1) / 2, 0, 0);
      // inside faces too, so you can look into the sock
      var inner = Geo.clone(g);
      for (var k = 0; k < inner.indices.length; k += 3) {
        var t = inner.indices[k + 1]; inner.indices[k + 1] = inner.indices[k + 2]; inner.indices[k + 2] = t;
      }
      list.push(g, inner);
    }
    // mouth hoop
    var hoop = Geo.torus(0.47, 0.035, 5, 12, COL.darkSteel);
    Geo.rotateY(hoop, Math.PI / 2);
    list.push(hoop);
    var m = Geo.toFlat(Geo.merge(list));
    for (i = 0; i < m.uvs.length; i++) m.uvs[i] = 0;
    return m;
  }

  function buildBeaconHead() {
    var p = new Parts();
    p.cyl(0.7, 0.8, 0.9, 8, COL.darkSteel, 0, 0, 0);
    p.box(0.9, 0.7, 0.2, [1.0, 0.97, 0.85], 0, 0.1, -0.8, 1.0);  // white lens (local -Z = heading 0)
    p.box(0.9, 0.7, 0.2, [0.5, 1.0, 0.6], 0, 0.1, 0.8, 1.0);     // green lens
    p.cyl(0.2, 0.5, 0.35, 8, COL.darkSteel, 0, 0.9, 0);
    return Geo.toFlat(p.merge());
  }

  // ------------------------------------------------------------------ init
  Airfield.init = function (glCtx) {
    gl = glCtx;
    Airfield.colliders.length = 0;
    var SL = RL.ShaderLib, G = RL.GL;
    progObj = G.createProgram(gl, SL.vertex(OBJ_VS), SL.fragment(OBJ_FS), 'airfield-objects');
    progPaved = G.createProgram(gl, SL.vertex(PAVED_VS), SL.fragment(PAVED_FS), 'airfield-paved');
    progRunway = G.createProgram(gl, SL.vertex(PAVED_VS), SL.fragment(RUNWAY_FS), 'airfield-runway');
    progLight = G.createProgram(gl, SL.vertex(LIGHT_VS), SL.fragment(LIGHT_FS), 'airfield-lights');

    texMarks = G.createTexture(gl, makeMarkingsAtlas(), { wrap: gl.CLAMP_TO_EDGE, anisotropy: 16 });
    texSign = G.createTexture(gl, makeSignTexture(), { wrap: gl.CLAMP_TO_EDGE, anisotropy: 8 });

    var st = buildStatic();
    meshStatic = G.meshFromGeo(gl, st);
    meshPaved = G.meshFromGeo(gl, buildPaved());
    meshDecals = G.meshFromGeo(gl, buildDecals());
    var ry = E + 0.03;
    var rq = Geo.quad([CX - HW, ry, CZ + HL], [CX + HW, ry, CZ + HL], [CX + HW, ry, CZ - HL], [CX - HW, ry, CZ - HL], [1, 1, 1]);
    meshRunway = G.meshFromGeo(gl, rq);
    meshSock = G.meshFromGeo(gl, buildSock());
    meshBeacon = G.meshFromGeo(gl, buildBeaconHead());

    lightCount = lightData.length / 12;
    meshLights = G.createMesh(gl, {
      positions: [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0],
      indices: [0, 1, 2, 0, 2, 3],
      instances: {
        data: new Float32Array(lightData), stride: 12,
        attribs: [{ loc: 4, size: 4, offset: 0 }, { loc: 5, size: 4, offset: 4 }, { loc: 6, size: 4, offset: 8 }]
      }
    });

    socks = WINDSOCKS.map(function (ws) {
      return { pos: v3.create(ws.x, E + 6.25, ws.z), yaw: 0, fill: 0.5, model: m4.create(), wind: v3.create() };
    });
    // apron floodlight pools (x, z, radius)
    for (var i = 0; i < 4; i++) {
      var f = FLOODS[i];
      pools[i * 4] = f[0] + f[2] * 20; pools[i * 4 + 1] = f[1] + f[3] * 20; pools[i * 4 + 2] = 17; pools[i * 4 + 3] = 0;
    }
    rwInfo[0] = CX; rwInfo[1] = CZ; rwInfo[2] = HL; rwInfo[3] = HW;
    Airfield.update(0);
    Airfield.ready = true;
    if (RL.Params && RL.Params.debug) {
      console.log('[Airfield] ' + (st.positions.length / 3) + ' static verts, ' + lightCount + ' lights, ' +
        Airfield.colliders.length + ' colliders');
    }
  };

  // ------------------------------------------------------------------ update
  Airfield.update = function (dt) {
    dt = dt > 0 ? Math.min(dt, 0.1) : 0;
    beaconAngle = (beaconAngle + dt * 1.2566) % (Math.PI * 2);   // 12 rpm
    var t = RL.frame ? RL.frame.time : 0;
    for (var i = 0; i < socks.length; i++) {
      var s = socks[i];
      if (RL.World && RL.World.windAt) RL.World.windAt(s.pos[0], s.pos[1], s.pos[2], t, s.wind);
      var wx = s.wind[0], wz = s.wind[2];
      var spd = Math.sqrt(wx * wx + wz * wz);
      if (!isFinite(spd)) continue;
      var targetYaw = spd > 0.05 ? Math.atan2(-wz, wx) : s.yaw;
      var dy = M.wrapPi(targetYaw - s.yaw);
      s.yaw = dt > 0 ? M.wrapPi(s.yaw + dy * (1 - Math.exp(-2.2 * dt))) : targetYaw;
      var targetFill = M.clamp(spd / 7.7, 0, 1);   // fully extended at 15 kt
      s.fill = dt > 0 ? M.damp(s.fill, targetFill, 1.8, dt) : targetFill;
      RL.quat.setAxisAngle(tmpQ, AXIS_Y, s.yaw);
      m4.fromRotationTranslation(s.model, tmpQ, s.pos);
    }
    if (socks.length) { Airfield.windsockDir = socks[0].yaw; Airfield.windsockFill = socks[0].fill; }
  };

  // ------------------------------------------------------------------ draw
  Airfield.draw = function (frame) {
    if (!gl || !progObj) return;
    var G = RL.GL;
    // --- ground surfaces (pushed towards the camera so they never z-fight with the flat terrain)
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-2, -4);
    G.use(gl, progPaved, U_PAVED);
    G.applyFrame(gl, progPaved, frame);
    G.drawMesh(gl, meshPaved);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texMarks);
    G.use(gl, progRunway, U_RUNWAY);
    G.applyFrame(gl, progRunway, frame);
    G.drawMesh(gl, meshRunway);

    gl.polygonOffset(-4, -8);
    G.use(gl, progPaved, U_PAVED);
    G.drawMesh(gl, meshDecals);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(0, 0);

    // --- buildings & props
    gl.bindTexture(gl.TEXTURE_2D, texSign);
    G.use(gl, progObj, U_OBJ);
    G.applyFrame(gl, progObj, frame);
    G.drawMesh(gl, meshStatic);

    // beacon head
    RL.quat.setAxisAngle(tmpQ, AXIS_Y, -beaconAngle);
    v3.set(tmpV, TOWER.x, E + 20.3, TOWER.z);
    m4.fromRotationTranslation(tmpM, tmpQ, tmpV);
    G.setUniform(gl, progObj, 'u_model', tmpM);
    G.drawMesh(gl, meshBeacon);

    // windsocks (double sided cloth)
    gl.disable(gl.CULL_FACE);
    for (var i = 0; i < socks.length; i++) {
      var s = socks[i];
      var droop = (1 - s.fill) * 1.2;          // radians below horizontal at the mouth
      bendVec[0] = droop * 0.75 + 0.05;
      bendVec[1] = droop * 0.35 + (1 - s.fill) * 0.1;
      bendVec[2] = 0.25 + s.fill * 0.9;
      bendVec[3] = 3.6;
      G.setUniform(gl, progObj, 'u_model', s.model);
      G.setUniform(gl, progObj, 'u_bend', bendVec);
      G.drawMesh(gl, meshSock);
    }
    gl.enable(gl.CULL_FACE);
    gl.bindTexture(gl.TEXTURE_2D, null);
  };

  Airfield.drawLights = function (frame) {
    if (!gl || !progLight || !lightCount) return;
    var G = RL.GL;
    var nf = frame.nightFactor || 0;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    U_LIGHTS.u_lightsOn = M.clamp(nf * 2.2, 0, 1);
    U_LIGHTS.u_beaconAngle = beaconAngle;
    U_LIGHTS.u_minPx = 2.2 * (frame.pixelRatio || 1);
    G.use(gl, progLight, U_LIGHTS);
    G.applyFrame(gl, progLight, frame);
    G.drawMesh(gl, meshLights);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.CULL_FACE);
  };

  RL.Airfield = Airfield;
})(window.RL = window.RL || {});
