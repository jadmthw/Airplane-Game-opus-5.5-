/*
 * Ridgeline — RL.World: the single physical-world query interface used by physics, camera,
 * effects and game logic. Delegates to RL.Terrain / RL.Airfield when they are ready and falls
 * back to a flat plane at airfield elevation otherwise (so partial builds still run).
 */
(function (RL) {
  'use strict';
  var C = RL.Config, M = RL.M;

  function terrainReady() { return RL.Terrain && RL.Terrain.ready; }

  var World = {
    get waterLevel() { return C.water.level; },
    half: C.world.half,

    /** Terrain surface height (m). Matches the rendered terrain triangles. */
    heightAt: function (x, z) {
      if (terrainReady()) return RL.Terrain.heightAt(x, z);
      return C.airfield.elevation;
    },

    /** Unit terrain normal written into out (v3). */
    normalAt: function (x, z, out) {
      out = out || RL.v3.create();
      if (terrainReady()) return RL.Terrain.normalAt(x, z, out);
      out[0] = 0; out[1] = 1; out[2] = 0;
      return out;
    },

    /** Height of whatever the aircraft would touch: max(terrain, water surface). */
    surfaceHeightAt: function (x, z) {
      return Math.max(World.heightAt(x, z), C.water.level);
    },

    /** True when the terrain here is below the water surface (i.e. you would be in a lake). */
    isWater: function (x, z) {
      return World.heightAt(x, z) < C.water.level - 0.05;
    },

    /**
     * Surface type at (x, z): 'water' | 'runway' | 'paved' | 'grass' | 'rough'.
     * 'grass' = gentle natural ground you can (carefully) land on; 'rough' = too steep.
     */
    surfaceAt: function (x, z) {
      if (World.isWater(x, z)) return 'water';
      if (C.isOnRunway(x, z)) return 'runway';
      if (RL.Airfield && RL.Airfield.isPaved && RL.Airfield.isPaved(x, z)) return 'paved';
      var n = World.normalAt(x, z, tmpN);
      return n[1] > 0.96 ? 'grass' : 'rough';
    },

    /** All static colliders: [{type:'box', min, max, name} | {type:'sphere', center, radius, name}]. */
    getColliders: function () {
      var list = [];
      if (RL.Terrain && RL.Terrain.colliders) list = list.concat(RL.Terrain.colliders);
      if (RL.Airfield && RL.Airfield.colliders) list = list.concat(RL.Airfield.colliders);
      return list;
    },

    /** Returns the first collider containing point p (v3), or null. */
    pointHitsCollider: function (p) {
      var cols = World.getColliders();
      for (var i = 0; i < cols.length; i++) {
        var c = cols[i];
        if (c.type === 'box') {
          if (p[0] >= c.min[0] && p[0] <= c.max[0] && p[1] >= c.min[1] && p[1] <= c.max[1] &&
              p[2] >= c.min[2] && p[2] <= c.max[2]) return c;
        } else if (c.type === 'sphere') {
          var dx = p[0] - c.center[0], dy = p[1] - c.center[1], dz = p[2] - c.center[2];
          if (dx * dx + dy * dy + dz * dz <= c.radius * c.radius) return c;
        }
      }
      return null;
    },

    /** Horizontal distance outside the playable square (0 when inside). */
    outOfBounds: function (x, z, margin) {
      var h = C.world.half - (margin || 0);
      return Math.max(0, Math.abs(x) - h, Math.abs(z) - h);
    },

    /**
     * Air velocity (m/s, world frame) at a point and time: prevailing wind that weakens near the
     * ground, gusts, and thermal updrafts. Writes into out.
     */
    windAt: function (x, y, z, t, out) {
      out = out || RL.v3.create();
      var w = C.wind;
      var toRad = (w.from + 180) * M.DEG;            // direction the air moves towards
      var agl = Math.max(0, y - World.heightAt(x, z));
      var shear = M.clamp(Math.log(1 + agl / 2) / Math.log(1 + 300 / 2), 0.35, 1.0);
      var gust = w.gust * (Math.sin(t * 0.63 + x * 0.004) * 0.6 + Math.sin(t * 1.71 + z * 0.006) * 0.4);
      var s = (w.speed + gust) * shear;
      out[0] = Math.sin(toRad) * s;
      out[1] = 0;
      out[2] = -Math.cos(toRad) * s;
      // thermals: Gaussian columns, fading above 1800 m and within 15 m of the ground
      var th = C.thermals;
      for (var i = 0; i < th.length; i++) {
        var dx = x - th[i].x, dz = z - th[i].z;
        var r2 = (dx * dx + dz * dz) / (th[i].radius * th[i].radius);
        if (r2 > 9) continue;
        var core = Math.exp(-r2) * th[i].strength;
        var vfade = M.smoothstep(0, 15, agl) * (1 - M.smoothstep(1400, 2000, y));
        out[1] += core * vfade * (0.85 + 0.15 * Math.sin(t * 0.4 + i));
      }
      return out;
    },

    /** Thermal strength (0..1+) near a point, for effects / HUD variometer hints. */
    thermalStrengthAt: function (x, z) {
      var th = C.thermals, best = 0;
      for (var i = 0; i < th.length; i++) {
        var dx = x - th[i].x, dz = z - th[i].z;
        var r2 = (dx * dx + dz * dz) / (th[i].radius * th[i].radius);
        best = Math.max(best, Math.exp(-r2));
      }
      return best;
    }
  };

  var tmpN = RL.v3.create();
  RL.World = World;
})(window.RL = window.RL || {});
