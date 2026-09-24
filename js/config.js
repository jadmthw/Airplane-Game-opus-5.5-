/*
 * Ridgeline — world layout & tuning constants shared by every module.
 * Coordinates: meters, Y up, North = -Z, East = +X. Headings are degrees clockwise from north.
 */
(function (RL) {
  'use strict';

  var Config = {
    seed: 20260924,

    world: {
      half: 6000,          // terrain covers x,z in [-half, half]
      resolution: 512,     // grid segments per side (quality=low uses 256)
      maxHeight: 2000
    },

    airfield: {
      name: 'Ridgeline Field',
      elevation: 50,       // runway / apron surface height (terrain is exactly this inside flatZone)
      // Runway centered at (cx, cz), running north-south along Z.
      // South threshold ("36") at z = cz + length/2, north threshold ("18") at z = cz - length/2.
      runway: { cx: 0, cz: 0, length: 1400, width: 40 },
      // Everything paved or built lives inside this rectangle; terrain is perfectly flat inside it
      // and blends back to natural terrain over `blend` meters outside it.
      flatZone: { minX: -420, maxX: 170, minZ: -950, maxZ: 950 },
      blend: 450
    },

    // Where the aircraft starts: on the runway centerline near the south threshold, facing north.
    spawn: { x: 0, z: 630, heading: 0 },

    // Broad open valley the airfield sits in (a polyline the mountains stay away from).
    valley: {
      path: [[0, 3300], [0, -900], [-300, -2600], [300, -4300]],
      halfWidth: 900,      // fully open floor half-width
      ramp: 900,           // distance over which mountains rise to full height beyond halfWidth
      floorStart: 45,      // floor height at the first path point
      floorEnd: 190        // floor height at the last path point
    },

    water: {
      level: 40,
      lakes: [{ name: 'Mirror Lake', x: 1500, z: -300, radius: 620, depth: 22 }]
    },

    // A river canyon carved from the lake's north shore up into the eastern mountains.
    canyon: {
      name: 'Serpent Canyon',
      path: [[1800, -800], [2250, -1900], [2050, -2700], [2450, -3400], [3250, -3950], [3900, -4200]],
      floorStart: 48,      // floor height at the lake end
      floorEnd: 240,       // floor height at the mountain end
      halfWidth: 110,      // flat floor half-width
      wallWidth: 170       // horizontal distance over which the walls rise to the surrounding terrain
    },

    // Natural stone arch spanning the canyon (terrain.js builds it and exposes colliders).
    arch: {
      x: 2050, z: -2700,   // center of the opening (on the canyon path)
      openingHeight: 150,  // clear height above canyon floor at the center
      openingHalfWidth: 95,// clear half-width of the opening at floor level
      thickness: 34        // depth of the arch along the canyon direction
    },

    // Ring course. Each ring: x, z, agl (height above ground or water surface, whichever is higher).
    // rings.js resolves final positions (may raise rings for terrain clearance) and orientation
    // (facing the direction of travel). special: 'arch' ring sits exactly in the arch opening.
    rings: [
      { x: 0, z: -1700, agl: 80 },
      { x: -250, z: -2900, agl: 140 },
      { x: 250, z: -4050, agl: 200 },
      { x: 1700, z: -4700, agl: 260 },
      { x: 3500, z: -4450, agl: 150 },
      { x: 3250, z: -3950, agl: 70 },
      { x: 2450, z: -3400, agl: 60 },
      { x: 2050, z: -2700, agl: 70, special: 'arch' },
      { x: 2250, z: -1900, agl: 50 },
      { x: 1800, z: -800, agl: 40 },
      { x: 1450, z: -250, agl: 14, special: 'lake' },
      { x: 1100, z: 1400, agl: 120 },
      { x: 250, z: 2600, agl: 120 },
      { x: 0, z: 1900, agl: 70, special: 'final' }
    ],
    ringRadius: 22,

    // Rising air columns (m/s updraft at the core, falling off with a Gaussian of `radius`).
    thermals: [
      { x: -1400, z: -1300, radius: 190, strength: 6.5 },
      { x: 700, z: -3350, radius: 210, strength: 7.5 },
      { x: -700, z: 1900, radius: 170, strength: 5.0 },
      { x: 2700, z: -1200, radius: 160, strength: 6.0 }
    ],

    // Prevailing wind: direction it blows FROM (degrees), speed m/s, gust amplitude m/s.
    wind: { from: 340, speed: 4.0, gust: 1.6 },

    physics: {
      gravity: 9.81,
      airDensity: 1.225,
      fixedDt: 1 / 120,
      maxSubSteps: 12
    },

    render: {
      fovDeg: 62,
      near: 0.8,
      nearCockpit: 0.12,
      far: 26000,
      shadowMapSize: 2048
    },

    units: { knots: 1.943844, feet: 3.28084, fpm: 196.8504 } // m/s->kt, m->ft, m/s->ft/min
  };

  /** True if (x, z) lies on the runway surface (optionally with extra margin in meters). */
  Config.isOnRunway = function (x, z, margin) {
    var r = Config.airfield.runway, m = margin || 0;
    return Math.abs(x - r.cx) <= r.width / 2 + m && Math.abs(z - r.cz) <= r.length / 2 + m;
  };

  /** Signed distance from the runway centerline (east positive). */
  Config.runwayCenterlineOffset = function (x) { return x - Config.airfield.runway.cx; };

  RL.Config = Config;
})(window.RL = window.RL || {});
