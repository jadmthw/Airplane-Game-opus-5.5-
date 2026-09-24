/*
 * Ridgeline — tiny event bus. See ARCHITECTURE.md for the event catalogue.
 *   RL.Events.on(type, fn) -> unsubscribe function
 *   RL.Events.emit(type, data)
 * Listener exceptions are caught and logged so one broken subscriber cannot break the game.
 */
(function (RL) {
  'use strict';
  var listeners = {};
  var Events = {
    on: function (type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
      return function () { Events.off(type, fn); };
    },
    once: function (type, fn) {
      var off = Events.on(type, function (d) { off(); fn(d); });
      return off;
    },
    off: function (type, fn) {
      var l = listeners[type];
      if (!l) return;
      var i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    },
    emit: function (type, data) {
      var l = listeners[type];
      if (RL.Params && RL.Params.debug && type !== 'message') console.log('[event]', type, data);
      if (!l || !l.length) return;
      var copy = l.slice();
      for (var i = 0; i < copy.length; i++) {
        try { copy[i](data || {}); }
        catch (e) {
          console.error('[RL.Events] listener for "' + type + '" threw:', e);
          if (RL.errors) RL.errors.push('event ' + type + ': ' + (e && e.message));
        }
      }
    }
  };
  RL.Events = Events;
})(window.RL = window.RL || {});
