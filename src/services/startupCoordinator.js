/**
 * MangaHive Phase 1 / Stage 2 — Startup coordinator (the ONE startup state machine).
 *
 * Problem it fixes: the app shows itself after an 8s failsafe even if storage hasn't answered. The
 * real library may arrive afterwards. Before this module that late result got adopted but skipped
 * normalisation, canonical migration and the follow-up render logic, because those lived inside the
 * one-shot "finish" step that had already run against the temporary empty state.
 *
 * State:
 *   loading ──(result)──────────────▶ ready | blocked     (normal path)
 *   loading ──(failsafe / failure)──▶ fallback ──(late result)──▶ ready | blocked
 *
 * Rules (each is covered by tests/phase1/startupRecovery.test.js):
 *  - One pipeline for every library result, early or late:  adopt → hydrate progress → legacy-key
 *    move → finalize (normalise + canonical migration, idempotent) → present / refresh.
 *  - `loaded` (the save gate) opens ONLY when a load actually completed with a definite answer
 *    ('ok', 'empty', or 'corrupt'/'read-error' where the library store itself blocks writes).
 *    A timeout, a rejected load, missing storage or 'unavailable' NEVER opens it, so the temporary
 *    empty state can never be written over persisted data.
 *  - The fallback is never silent: the user is told the library hasn't loaded and nothing was overwritten.
 *  - A late result is discarded if the user already replaced the library explicitly (import):
 *    the stale read must not clobber the newer data.
 *  - Applying the same result twice is a no-op; every step it calls is repeat-safe.
 *
 * No storage access here: it drives injected stores and UI hooks only.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.MangaHiveServices = root.MangaHiveServices || {};
  root.MangaHiveServices.startupCoordinator = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  var DEFAULT_TIMEOUT_MS = 8000;

  var MSG = {
    slow: "Your library is taking longer than usual to load. Nothing has been changed — reload to try again.",
    failed: "Couldn't load your library. Nothing has been changed — reload to try again.",
    noStorage: "Storage isn't available, so your library can't be loaded. Nothing has been changed — reload to try again.",
    corrupt: "Your saved library couldn't be read. A copy was kept and nothing was overwritten.",
    readError: "Couldn't read your saved library. Nothing was overwritten — reload to try again.",
    lateLoaded: "Your library finished loading.",
    lateDiscardedEdits: "Your library finished loading. Changes made while it was loading weren't saved."
  };

  function noop() {}

  /**
   * options:
   *   load()              required: → Promise<loadLibrary() result>
 *   deleteLegacyKey()   optional: called after the pre-rebrand key's data was saved under the new key
   *   progStore           optional: { hydrateLibraryProgress }
   *   hasStorage()        → boolean (false = no storage at all)
   *   timeoutMs, setTimer(fn, ms) → handle, clearTimer(handle)
   *   hooks:
   *     adopt(library)         replace app state with the loaded library + persisted-state defaults (sync)
   *     finalize({late})       idempotent normalisation + canonical migration (+ save when migration changed things)
   *     save()                 persist the current state (after the legacy-key move) → Promise
   *     present({fallback})    first presentation of the app (the one-time UI bring-up)
   *     refresh()              re-draw after a LATE adoption (fallback was already presented)
   *     notify(message, kind)  tell the user
   *     logError(ctx, err)
   *     pendingEdits()         → number of edits refused while the library wasn't loaded
   *     onLoadedChange(bool)   mirror of the save gate for the host
   */
  function createStartupCoordinator(options) {
    var o = options || {};
    var load = o.load;
    var deleteLegacyKey = typeof o.deleteLegacyKey === 'function' ? o.deleteLegacyKey : function () { return Promise.resolve(); };
    var progStore = o.progStore || null;
    var h = o.hooks || {};
    var hasStorage = typeof o.hasStorage === 'function' ? o.hasStorage : function () { return true; };
    var timeoutMs = typeof o.timeoutMs === 'number' ? o.timeoutMs : DEFAULT_TIMEOUT_MS;
    var setTimer = typeof o.setTimer === 'function' ? o.setTimer : function (fn, ms) { return setTimeout(fn, ms); };
    var clearTimer = typeof o.clearTimer === 'function' ? o.clearTimer : function (t) { clearTimeout(t); };
    var adopt = h.adopt || noop, finalize = h.finalize || noop, save = h.save || function () { return Promise.resolve(null); };
    var present = h.present || noop, refresh = h.refresh || noop;
    var notify = h.notify || noop, logError = h.logError || noop;
    var pendingEdits = h.pendingEdits || function () { return 0; };
    var onLoadedChange = h.onLoadedChange || noop;

    var phase = 'idle';          // idle | loading | fallback | ready | blocked
    var loaded = false;          // the save gate
    var presented = false;       // present() has run (fallback or real)
    var superseded = false;      // the user replaced the library explicitly; any in-flight read is stale
    var timer = null;
    var lastApplied = null;      // last result object processed (re-delivery guard)
    var startedPromise = null;

    function setLoaded(v) { if (loaded !== v) { loaded = v; try { onLoadedChange(v); } catch (e) {} } }
    function safe(ctx, fn) {
      try { return Promise.resolve(fn()).catch(function (e) { try { logError(ctx, e); } catch (_) {} }); }
      catch (e) { try { logError(ctx, e); } catch (_) {} return Promise.resolve(); }
    }
    function say(msg, kind) { try { notify(msg, kind || 'info'); } catch (e) {} }

    function showFallback(reason) {
      if (presented) return;
      presented = true;
      phase = 'fallback';
      try { present({ fallback: true, reason: reason }); } catch (e) { try { logError('startup-present', e); } catch (_) {} }
      say(reason === 'no-storage' ? MSG.noStorage : (reason === 'timeout' ? MSG.slow : MSG.failed), 'recovery');
    }

    function onTimeout() {
      timer = null;
      if (presented) return;
      showFallback('timeout');            // loaded stays false: no save can happen until the load answers
    }

    /** The single pipeline every library result goes through. */
    function applyResult(r) {
      if (r === lastApplied) return Promise.resolve({ applied: false, reason: 'already-applied' });
      lastApplied = r;
      var late = presented;               // the app is already showing its temporary state
      if (superseded) {
        try { logError('startup-late-result-discarded', new Error('library was replaced explicitly while loading')); } catch (e) {}
        return Promise.resolve({ applied: false, reason: 'superseded' });
      }
      if (timer !== null) { clearTimer(timer); timer = null; }

      var status = r && r.status;
      if (status === 'ok') {
        setLoaded(true); phase = 'ready';
        var lost = late ? pendingEdits() : 0;
        adopt(r.library);
        var hydrate = progStore ? safe('progress-hydrate', function () { return progStore.hydrateLibraryProgress(r.library); }) : Promise.resolve();
        return hydrate.then(function () {
          if (r.migratedFromLegacyKey) {
            return safe('legacy-key-move', function () {
              return Promise.resolve(save()).then(function (res) { if (res) return deleteLegacyKey(); });
            });
          }
        }).then(function () {
          return safe('startup-finalize', function () { return finalize({ late: late }); });
        }).then(function () {
          if (!presented) { presented = true; present({ fallback: false }); }
          else { safe('startup-refresh', function () { return refresh(); }); say(lost > 0 ? MSG.lateDiscardedEdits : MSG.lateLoaded, 'info'); }
          return { applied: true, late: late, status: status };
        });
      }

      if (status === 'empty') {           // the key is definitely missing: a genuinely new library
        setLoaded(true); phase = 'ready';
        return safe('startup-finalize', function () { return finalize({ late: late }); }).then(function () {
          if (!presented) { presented = true; present({ fallback: false }); } else { safe('startup-refresh', function () { return refresh(); }); }
          return { applied: true, late: late, status: status };
        });
      }

      if (status === 'corrupt' || status === 'read-error') {
        // The library store now refuses writes and (for corrupt) holds a verified copy. Keep the gate open so
        // save attempts reach the store and produce its "changes aren't being saved" message.
        setLoaded(true); phase = 'blocked';
        try { logError('library-' + status, new Error(r.reason || r.error || status)); } catch (e) {}
        if (!presented) { presented = true; present({ fallback: false, blocked: true }); }
        say(status === 'corrupt' ? MSG.corrupt : MSG.readError, 'recovery');   // after present: first paint must not hide it
        return Promise.resolve({ applied: true, late: late, status: status });
      }

      // 'unavailable' or anything unexpected: no definite answer about what is persisted → never open the gate.
      setLoaded(false);
      showFallback('no-storage');
      return Promise.resolve({ applied: false, status: status || 'unknown' });
    }

    function onLoadFailed(err) {
      try { logError('library-load', err); } catch (e) {}
      if (timer !== null) { clearTimer(timer); timer = null; }
      if (superseded) return { applied: false, reason: 'superseded' };
      setLoaded(false);
      showFallback('load-failed');
      return { applied: false, reason: 'load-failed' };
    }

    /** Begin startup. Resolves once the load has been fully processed (or has definitively failed). */
    function start() {
      if (startedPromise) return startedPromise;
      phase = 'loading';
      if (!hasStorage()) {
        setLoaded(false);
        showFallback('no-storage');
        startedPromise = Promise.resolve({ applied: false, reason: 'no-storage' });
        return startedPromise;
      }
      timer = setTimer(onTimeout, timeoutMs);
      var p;
      try { p = Promise.resolve(load()); } catch (e) { p = Promise.reject(e); }
      startedPromise = p.then(applyResult, onLoadFailed);
      return startedPromise;
    }

    /**
     * The user deliberately replaced the library (import / restore) and the write succeeded. That write is
     * now the truth; open the gate and make sure a slow in-flight read can never overwrite it.
     */
    function markReplaced() {
      superseded = true;
      if (timer !== null) { clearTimer(timer); timer = null; }
      setLoaded(true);
      phase = 'ready';
    }

    return {
      start: start,
      isLoaded: function () { return loaded; },
      getPhase: function () { return phase; },
      hasPresented: function () { return presented; },
      markReplaced: markReplaced,
      messages: MSG
    };
  }

  return { DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS, MESSAGES: MSG, createStartupCoordinator: createStartupCoordinator };
});
