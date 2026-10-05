/**
 * MangaHive Phase 1 / Stage 1 — Library store (persistence boundary for library state).
 *
 * The rest of the app talks to this module instead of poking window.storage directly.
 * The underlying technology is unchanged: it drives the existing `window.storage`
 * get/set/delete/list contract (IndexedDB-backed polyfill, or Claude.ai's storage).
 * No server-side library table, no new database.
 *
 * Corruption protection (the reason this exists):
 *   persisted blob can't be parsed / has the wrong shape
 *        → status 'corrupt'
 *        → raw bytes are copied to `library-corrupt-backup:<hash>` and read back to verify
 *        → the ORIGINAL key is never touched or deleted
 *        → library WRITES ARE BLOCKED, so the empty in-memory state can never overwrite it
 *        → the caller is told (status/backupKey) so it can report to the user.
 *   A storage *read error* on a key that may exist ('read-error') blocks writes the same way.
 *   Writes are re-enabled only by an explicit replaceLibrary({force:true}) / restoreLibrary(),
 *   i.e. a deliberate user action (import / restore), never implicitly.
 *
 * Backup retention (Stage 2): every backup category (corrupt / manual / pre-replace) is pruned
 * independently to the newest MAX_BACKUPS entries after each verified backup. Never deleted:
 * the live library keys, the backup just written, the backup the current write-block points at,
 * and any backup whose envelope can't be read/ranked (unknown data is kept, not guessed at).
 * Pruning failures are never swallowed: they are returned as `result.prune`, kept in
 * getLastPruneReport(), and passed to the optional `onPruneFailure` callback.
 *
 * Progress is NOT stored here – see progressStore.js. Progress updates must not
 * require serializing the entire library.
 */
(function (root, factory) {
  var identity = (typeof require === 'function' && typeof module === 'object' && module && module.exports)
    ? require('../domain/identity.js')
    : (root.MangaHiveDomain && root.MangaHiveDomain.identity);
  var api = factory(identity);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.MangaHiveServices = root.MangaHiveServices || {};
  root.MangaHiveServices.libraryStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function (identity) {
  'use strict';

  if (!identity) throw new Error('MangaHiveDomain.identity must be loaded before libraryStore');

  var DEFAULT_KEY = 'fairs-library-v1';
  var DEFAULT_LEGACY_KEY = 'panel-library-v1';
  var CORRUPT_BACKUP_PREFIX = 'library-corrupt-backup:';
  var MANUAL_BACKUP_PREFIX = 'library-backup:';
  var PRE_REPLACE_BACKUP_PREFIX = 'library-pre-replace-backup:';
  var DEFAULT_MAX_BACKUPS = 5;
  var NOT_FOUND_RE = /not[\s_-]*found|no such key|does not exist|missing key/i;

  /**
   * Validate a persisted library blob. Returns { ok:true, library } or { ok:false, reason }.
   * Accepts a JSON string or an already-parsed object. Unknown fields are preserved untouched.
   */
  function validateLibraryBlob(raw) {
    var parsed = raw;
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw); } catch (e) { return { ok: false, reason: 'json-parse-failed' }; }
    } else if (!identity.isObj(raw)) {
      return { ok: false, reason: 'unsupported-value-type' };
    }
    if (!identity.isObj(parsed)) return { ok: false, reason: 'not-an-object' };
    if (parsed.series !== undefined && !Array.isArray(parsed.series)) return { ok: false, reason: 'series-not-an-array' };
    return { ok: true, library: parsed };
  }

  /**
   * Fill in the known top-level containers WITHOUT dropping anything else (repeat-safe:
   * applying it twice equals applying it once). Never mutates its input.
   */
  function migrateLibrary(library) {
    if (!identity.isObj(library)) return { library: library, changed: false };
    var out = Object.assign({}, library), changed = false;
    if (!Array.isArray(out.series)) { out.series = []; changed = true; }
    ['progress', 'bookmarks', 'ratings'].forEach(function (k) {
      if (!identity.isObj(out[k])) { out[k] = {}; changed = true; }
    });
    if (!Array.isArray(out.history)) { out.history = []; changed = true; }
    return { library: out, changed: changed };
  }

  function createLibraryStore(options) {
    var o = options || {};
    var KEY = o.key || DEFAULT_KEY;
    var LEGACY_KEY = o.legacyKey === undefined ? DEFAULT_LEGACY_KEY : o.legacyKey;
    var now = typeof o.now === 'function' ? o.now : function () { return Date.now(); };
    var perfNow = typeof o.perfNow === 'function' ? o.perfNow
      : (typeof performance !== 'undefined' && performance && typeof performance.now === 'function' ? function () { return performance.now(); } : now);

    var MAX_BACKUPS = (typeof o.maxBackups === 'number' && isFinite(o.maxBackups) && o.maxBackups >= 1) ? Math.floor(o.maxBackups) : DEFAULT_MAX_BACKUPS;
    var onPruneFailure = typeof o.onPruneFailure === 'function' ? o.onPruneFailure : null;
    var lastPrune = null;             // report of the most recent prune pass
    var pruneQueue = Promise.resolve(); // prune passes never overlap each other
    var block = null;                 // { reason, sourceKey, backupKey, backupVerified }
    var queue = Promise.resolve();    // serialises writes: strictly one at a time, in call order
    var metrics = { lastLoadMs: null, lastLoadBytes: null, lastSaveMs: null, lastSaveBytes: null, saves: 0 };

    function storage() {
      var s = typeof o.getStorage === 'function' ? o.getStorage() : o.storage;
      return (s && typeof s.get === 'function' && typeof s.set === 'function') ? s : null;
    }

    /** Read one key. → { state:'present'|'missing'|'error', value?, error? } */
    function readKey(st, key) {
      return Promise.resolve().then(function () { return st.get(key, false); }).then(function (res) {
        if (res && res.value !== undefined && res.value !== null) return { state: 'present', value: res.value };
        return { state: 'missing' };
      }, function (err) {
        var msg = String((err && err.message) || err || '');
        if (NOT_FOUND_RE.test(msg)) return { state: 'missing' };
        // Unknown failure: the key may well exist. Ask the key index before deciding it doesn't.
        if (typeof st.list === 'function') {
          return Promise.resolve().then(function () { return st.list(key, false); }).then(function (l) {
            if (l && Array.isArray(l.keys)) return l.keys.indexOf(key) >= 0 ? { state: 'error', error: msg } : { state: 'missing' };
            return { state: 'error', error: msg };
          }, function () { return { state: 'error', error: msg }; });
        }
        return { state: 'error', error: msg };
      });
    }

    function rawToString(value) {
      if (typeof value === 'string') return value;
      try { return JSON.stringify(value); } catch (e) { return ''; }
    }

    /** Copy raw data to a backup key and read it back. Never deletes or edits the source. */
    function writeBackup(st, backupKey, envelope, rawString) {
      return Promise.resolve().then(function () {
        return Promise.resolve().then(function () { return st.get(backupKey, false); }).then(function (res) {
          var existing = null;
          try { existing = res && res.value ? JSON.parse(res.value) : null; } catch (e) { existing = null; }
          return existing && existing.raw === rawString ? { reuse: true } : { reuse: false };
        }, function () { return { reuse: false }; });
      }).then(function (chk) {
        if (chk.reuse) return { backupKey: backupKey, verified: true };
        return Promise.resolve(st.set(backupKey, JSON.stringify(envelope), false)).then(function (res) {
          if (!res) return { backupKey: backupKey, verified: false };
          return Promise.resolve().then(function () { return st.get(backupKey, false); }).then(function (back) {
            var ok = false;
            try { ok = !!back && JSON.parse(back.value).raw === rawString; } catch (e) { ok = false; }
            return { backupKey: backupKey, verified: ok };
          }, function () { return { backupKey: backupKey, verified: false }; });
        });
      }).catch(function () { return { backupKey: backupKey, verified: false }; });
    }


    /** Timestamp recorded inside a backup envelope, or null when it can't be read. */
    function envelopeTime(value) {
      var env;
      try { env = typeof value === 'string' ? JSON.parse(value) : value; } catch (e) { return null; }
      if (!identity.isObj(env)) return null;
      var t = typeof env.createdAt === 'number' ? env.createdAt : env.detectedAt;
      return (typeof t === 'number' && isFinite(t)) ? t : null;
    }

    /** Prune ONE backup category down to MAX_BACKUPS. → { prefix, ok, kept, removed[], failed[{key,error}], unranked[] } */
    function pruneCategory(st, prefix, protectedKeys) {
      var report = { prefix: prefix, ok: true, kept: 0, removed: [], failed: [], unranked: [] };
      if (typeof st.list !== 'function' || typeof st.delete !== 'function') { report.ok = false; report.code = 'PRUNE_UNSUPPORTED'; return Promise.resolve(report); }
      return Promise.resolve().then(function () { return st.list(prefix, false); }).then(function (l) {
        if (!l || !Array.isArray(l.keys)) { report.ok = false; report.code = 'LIST_UNAVAILABLE'; return report; }
        var keys = l.keys.filter(function (k) { return k.indexOf(prefix) === 0 && k !== KEY && k !== LEGACY_KEY; });
        return Promise.all(keys.map(function (k) {
          return Promise.resolve().then(function () { return st.get(k, false); }).then(function (res) {
            return { key: k, at: envelopeTime(res && res.value) };
          }, function () { return { key: k, at: null }; });
        })).then(function (entries) {
          var ranked = entries.filter(function (e) { return e.at !== null; }).sort(function (a, b) {
            return (b.at - a.at) || (a.key < b.key ? 1 : (a.key > b.key ? -1 : 0));
          });
          entries.forEach(function (e) { if (e.at === null) report.unranked.push(e.key); });
          var keep = {};
          ranked.forEach(function (e) { if (protectedKeys.indexOf(e.key) >= 0) keep[e.key] = true; });
          var room = MAX_BACKUPS - Object.keys(keep).length;
          ranked.forEach(function (e) { if (!keep[e.key] && room > 0) { keep[e.key] = true; room -= 1; } });
          var doomed = ranked.filter(function (e) { return !keep[e.key]; }).map(function (e) { return e.key; });
          report.kept = ranked.length - doomed.length;
          return Promise.all(doomed.map(function (k) {
            return Promise.resolve().then(function () { return st.delete(k, false); }).then(function (res) {
              if (res) report.removed.push(k); else report.failed.push({ key: k, error: 'delete-returned-falsy' });
            }, function (err) { report.failed.push({ key: k, error: String((err && err.message) || err || 'delete-failed') }); });
          }));
        }).then(function () { report.kept += report.failed.length; report.ok = report.failed.length === 0; return report; });
      }, function (err) { report.ok = false; report.code = 'LIST_UNAVAILABLE'; report.error = String((err && err.message) || err || ''); return report; });
    }

    /**
     * Prune every backup category (each independently). Never throws. Records the report and calls
     * onPruneFailure when anything couldn't be listed/removed. `extraProtected` = keys to keep regardless.
     */
    function runPrune(st, extraProtected) {
      var run = pruneQueue.catch(function () {}).then(function () {
        var prot = (extraProtected || []).filter(Boolean);
        if (block && block.backupKey) prot.push(block.backupKey);
        var prefixes = [CORRUPT_BACKUP_PREFIX, MANUAL_BACKUP_PREFIX, PRE_REPLACE_BACKUP_PREFIX];
        return Promise.all(prefixes.map(function (p) {
          return pruneCategory(st, p, prot).catch(function (e) { return { prefix: p, ok: false, code: 'PRUNE_FAILED', error: String((e && e.message) || e), kept: 0, removed: [], failed: [], unranked: [] }; });
        })).then(function (cats) {
          var report = { ok: cats.every(function (c) { return c.ok; }), max: MAX_BACKUPS, categories: cats, at: now() };
          lastPrune = report;
          if (!report.ok && onPruneFailure) { try { onPruneFailure(report); } catch (e) {} }
          return report;
        });
      });
      pruneQueue = run;
      return run;
    }

    function preserveCorrupt(st, sourceKey, value, reason) {
      var rawString = rawToString(value);
      var backupKey = CORRUPT_BACKUP_PREFIX + identity.hashString(rawString) + '-' + rawString.length;
      return writeBackup(st, backupKey, {
        kind: 'library-corrupt-backup', version: 1, sourceKey: sourceKey, reason: reason,
        detectedAt: now(), rawLength: rawString.length, raw: rawString
      }, rawString).then(function (b) {
        // Only a verified backup earns a prune pass; the backup just made is always protected.
        return b.verified ? runPrune(st, [b.backupKey]).then(function (p) { b.prune = p; return b; }) : b;
      });
    }

    /**
     * loadLibrary() → Promise<{
     *   status: 'ok' | 'empty' | 'corrupt' | 'read-error' | 'unavailable',
     *   library: object|null,            // the parsed library, exactly as persisted (unknown fields intact)
     *   migratedFromLegacyKey: boolean,  // true when the data came from the pre-rebrand key
     *   sourceKey, backupKey?, backupVerified?, reason?, error?
     * }>
     * On 'corrupt' / 'read-error' writes are blocked (see header).
     */
    function loadLibrary() {
      var t0 = perfNow();
      var st = storage();
      if (!st) return Promise.resolve({ status: 'unavailable', library: null, migratedFromLegacyKey: false });

      function finish(result, bytes) {
        metrics.lastLoadMs = perfNow() - t0;
        metrics.lastLoadBytes = bytes == null ? null : bytes;
        return result;
      }

      function handlePresent(key, value, viaLegacy) {
        var v = validateLibraryBlob(value);
        if (v.ok) {
          block = null;
          return finish({ status: 'ok', library: v.library, migratedFromLegacyKey: viaLegacy, sourceKey: key }, rawToString(value).length);
        }
        return preserveCorrupt(st, key, value, v.reason).then(function (b) {
          block = { reason: 'corrupt', sourceKey: key, backupKey: b.backupKey, backupVerified: b.verified };
          return finish({ status: 'corrupt', library: null, migratedFromLegacyKey: false, sourceKey: key, reason: v.reason, backupKey: b.backupKey, backupVerified: b.verified }, rawToString(value).length);
        });
      }

      function handleError(key, r) {
        block = { reason: 'read-error', sourceKey: key, backupKey: null, backupVerified: false };
        return finish({ status: 'read-error', library: null, migratedFromLegacyKey: false, sourceKey: key, error: r.error }, null);
      }

      return readKey(st, KEY).then(function (r) {
        if (r.state === 'present') return handlePresent(KEY, r.value, false);
        if (r.state === 'error') return handleError(KEY, r);
        if (!LEGACY_KEY) { block = null; return finish({ status: 'empty', library: null, migratedFromLegacyKey: false }, 0); }
        return readKey(st, LEGACY_KEY).then(function (r2) {
          if (r2.state === 'present') return handlePresent(LEGACY_KEY, r2.value, true);
          if (r2.state === 'error') return handleError(LEGACY_KEY, r2);
          block = null;
          return finish({ status: 'empty', library: null, migratedFromLegacyKey: false }, 0);
        });
      });
    }

    function isWriteBlocked() { return block !== null; }
    function getBlockInfo() { return block ? Object.assign({}, block) : null; }

    function snapshot(library) {
      if (!identity.isObj(library)) return { ok: false, code: 'INVALID_LIBRARY' };
      try { return { ok: true, text: JSON.stringify(library) }; }
      catch (e) { return { ok: false, code: 'SERIALIZE_FAILED' }; }
    }

    function enqueueWrite(text, allowWhenBlocked) {
      var run = queue.catch(function () {}).then(function () {
        if (block && !allowWhenBlocked) return { ok: false, code: 'WRITES_BLOCKED', reason: block.reason, backupKey: block.backupKey };
        var st = storage();
        if (!st) return { ok: false, code: 'STORAGE_UNAVAILABLE' };
        var t0 = perfNow();
        return Promise.resolve().then(function () { return st.set(KEY, text, false); }).then(function (res) {
          if (!res) return { ok: false, code: 'WRITE_FAILED' };
          metrics.lastSaveMs = perfNow() - t0; metrics.lastSaveBytes = text.length; metrics.saves += 1;
          return { ok: true, bytes: text.length };
        }, function () { return { ok: false, code: 'WRITE_FAILED' }; });
      });
      queue = run;
      return run;
    }

    /**
     * saveLibrary(library) — snapshot NOW (later mutation can't change what this write persists),
     * write strictly in call order. Refused while writes are blocked.
     * → Promise<{ ok, bytes? , code? }>
     */
    function saveLibrary(library) {
      if (block) return Promise.resolve({ ok: false, code: 'WRITES_BLOCKED', reason: block.reason, backupKey: block.backupKey });
      var snap = snapshot(library);
      if (!snap.ok) return Promise.resolve(snap);
      return enqueueWrite(snap.text, false);
    }

    /** Snapshot what is persisted under KEY into `<prefix><suffix>`; used before destructive replaces. */
    function backupPersisted(st, prefix, suffix) {
      return readKey(st, KEY).then(function (r) {
        if (r.state !== 'present') return { ok: false, code: r.state === 'missing' ? 'NOTHING_TO_BACKUP' : 'READ_FAILED' };
        var rawString = rawToString(r.value);
        return writeBackup(st, prefix + suffix, { kind: 'library-backup', version: 1, sourceKey: KEY, createdAt: now(), rawLength: rawString.length, raw: rawString }, rawString)
          .then(function (b) { return finishBackup(st, b); });
      });
    }

    /** Shape a writeBackup() outcome for callers; a verified backup triggers a prune pass that protects it. */
    function finishBackup(st, b) {
      var out = { ok: b.verified, code: b.verified ? undefined : 'BACKUP_NOT_VERIFIED', backupKey: b.backupKey };
      if (!b.verified) return out;
      return runPrune(st, [b.backupKey]).then(function (p) { out.prune = p; return out; });
    }

    /**
     * replaceLibrary(library, { force?, acknowledgeDataLoss?, backupBefore? = true })
     * Deliberate whole-library replacement (import / restore). The only way out of a blocked state:
     *  - while blocked it requires force:true;
     *  - if the blocked data has no verified backup it additionally requires acknowledgeDataLoss:true.
     * The previous persisted blob is backed up first (unless there is none).
     */
    function replaceLibrary(library, opts) {
      var p = opts || {};
      if (block) {
        if (p.force !== true) return Promise.resolve({ ok: false, code: 'WRITES_BLOCKED', reason: block.reason, backupKey: block.backupKey });
        if ((block.reason === 'read-error' || !block.backupVerified) && p.acknowledgeDataLoss !== true) {
          return Promise.resolve({ ok: false, code: 'BACKUP_NOT_VERIFIED', reason: block.reason });
        }
      }
      var snap = snapshot(library);
      if (!snap.ok) return Promise.resolve(snap);
      var st = storage();
      if (!st) return Promise.resolve({ ok: false, code: 'STORAGE_UNAVAILABLE' });
      var wasBlocked = !!block;
      var doBackup = p.backupBefore !== false && !wasBlocked; // a blocked blob already has its corrupt-backup
      var pre = doBackup
        ? backupPersisted(st, PRE_REPLACE_BACKUP_PREFIX, String(now()))
        : Promise.resolve({ ok: true });
      return pre.then(function (b) {
        if (!b.ok && b.code !== 'NOTHING_TO_BACKUP') return { ok: false, code: b.code || 'BACKUP_NOT_VERIFIED' };
        return enqueueWrite(snap.text, true).then(function (res) {
          if (res.ok) block = null;
          if (res.ok && b.backupKey) res.backupKey = b.backupKey;
          if (res.ok && b.prune) res.prune = b.prune;
          return res;
        });
      });
    }

    /**
     * backupLibrary({ label?, library? }) — keep a copy under `library-backup:<label|timestamp>`.
     * Without `library` it copies the persisted blob byte-for-byte.
     */
    function backupLibrary(opts) {
      var p = opts || {};
      var st = storage();
      if (!st) return Promise.resolve({ ok: false, code: 'STORAGE_UNAVAILABLE' });
      var suffix = identity.str(p.label) || String(now());
      if (p.library !== undefined) {
        var snap = snapshot(p.library);
        if (!snap.ok) return Promise.resolve(snap);
        return writeBackup(st, MANUAL_BACKUP_PREFIX + suffix, { kind: 'library-backup', version: 1, sourceKey: 'memory', createdAt: now(), rawLength: snap.text.length, raw: snap.text }, snap.text)
          .then(function (b) { return finishBackup(st, b); });
      }
      return backupPersisted(st, MANUAL_BACKUP_PREFIX, suffix);
    }

    /**
     * restoreLibrary(backupKey) — load a backup envelope and replace the library with it.
     * Fails with BACKUP_UNPARSEABLE (and changes nothing) when the backup's raw data still isn't a valid library.
     */
    function restoreLibrary(backupKey, opts) {
      var st = storage();
      if (!st) return Promise.resolve({ ok: false, code: 'STORAGE_UNAVAILABLE' });
      var key = identity.str(backupKey);
      if (!key) return Promise.resolve({ ok: false, code: 'INVALID_BACKUP_KEY' });
      return readKey(st, key).then(function (r) {
        if (r.state !== 'present') return { ok: false, code: 'BACKUP_NOT_FOUND' };
        var env;
        try { env = JSON.parse(r.value); } catch (e) { return { ok: false, code: 'BACKUP_UNPARSEABLE' }; }
        if (!identity.isObj(env) || typeof env.raw !== 'string') return { ok: false, code: 'BACKUP_UNPARSEABLE' };
        var v = validateLibraryBlob(env.raw);
        if (!v.ok) return { ok: false, code: 'BACKUP_UNPARSEABLE', reason: v.reason };
        return replaceLibrary(v.library, Object.assign({ force: true, acknowledgeDataLoss: true }, opts || {})).then(function (res) {
          if (res.ok) res.library = v.library;
          return res;
        });
      });
    }

    /** Keys of every backup this store has made. */
    function listBackups() {
      var st = storage();
      if (!st || typeof st.list !== 'function') return Promise.resolve([]);
      return Promise.resolve(st.list('library-', false)).then(function (l) {
        var keys = (l && Array.isArray(l.keys)) ? l.keys : [];
        return keys.filter(function (k) {
          return k.indexOf(CORRUPT_BACKUP_PREFIX) === 0 || k.indexOf(MANUAL_BACKUP_PREFIX) === 0 || k.indexOf(PRE_REPLACE_BACKUP_PREFIX) === 0;
        }).sort();
      }, function () { return []; });
    }

    /** Remove the pre-rebrand key once its data has been written under the new key. Explicit, never automatic. */
    function deleteLegacyKey() {
      var st = storage();
      if (!st || typeof st.delete !== 'function' || !LEGACY_KEY) return Promise.resolve({ ok: false });
      return Promise.resolve(st.delete(LEGACY_KEY, false)).then(function (r) { return { ok: !!r }; }, function () { return { ok: false }; });
    }

    return {
      key: KEY,
      loadLibrary: loadLibrary,
      saveLibrary: saveLibrary,
      replaceLibrary: replaceLibrary,
      backupLibrary: backupLibrary,
      restoreLibrary: restoreLibrary,
      listBackups: listBackups,
      pruneBackups: function () { var st = storage(); return st ? runPrune(st, []) : Promise.resolve({ ok: false, code: 'STORAGE_UNAVAILABLE', categories: [] }); },
      getLastPruneReport: function () { return lastPrune; },
      maxBackups: MAX_BACKUPS,
      deleteLegacyKey: deleteLegacyKey,
      isWriteBlocked: isWriteBlocked,
      getBlockInfo: getBlockInfo,
      getMetrics: function () { return Object.assign({}, metrics); }
    };
  }

  return {
    CORRUPT_BACKUP_PREFIX: CORRUPT_BACKUP_PREFIX,
    MANUAL_BACKUP_PREFIX: MANUAL_BACKUP_PREFIX,
    PRE_REPLACE_BACKUP_PREFIX: PRE_REPLACE_BACKUP_PREFIX,
    MAX_BACKUPS: DEFAULT_MAX_BACKUPS,
    validateLibraryBlob: validateLibraryBlob,
    migrateLibrary: migrateLibrary,
    createLibraryStore: createLibraryStore
  };
});
