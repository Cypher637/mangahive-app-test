/**
 * MangaHive Phase 1 / Stage 1 — Progress store (separate from the library store).
 *
 * ARCHITECTURAL RULE: progress updates must not require serializing the entire library.
 * Each chapter's progress is ONE small record under its own key
 *     mangahive-progress-v1:<scope>:<scopeId>:<seriesId>:<chapterId>   (ids URI-escaped)
 * so a page turn persists ~200 bytes instead of `JSON.stringify(library)`.
 *
 * Backed by the existing `window.storage` contract (get/set/delete/list); no new database,
 * no server. Writes (including read-modify-write updates) are serialised on one queue so a
 * slow older write can never land after a newer one.
 *
 * Legacy compatibility: `state.progress[seriesId] = { chapterId, pageIndex, updatedAt }` lives
 * on in the library blob and is NEVER deleted here. hydrateLibraryProgress() (1) converts legacy
 * entries into records when the chapter can be identified with confidence, and (2) projects newer
 * records back onto the legacy-shaped view so existing UI keeps working unchanged. That function
 * is the single, documented boundary between the old and new progress representations.
 */
(function (root, factory) {
  var isNode = typeof require === 'function' && typeof module === 'object' && module && module.exports;
  var identity = isNode ? require('../domain/identity.js') : (root.MangaHiveDomain && root.MangaHiveDomain.identity);
  var progress = isNode ? require('../domain/progress.js') : (root.MangaHiveDomain && root.MangaHiveDomain.progress);
  var api = factory(identity, progress);
  if (isNode) module.exports = api;
  root.MangaHiveServices = root.MangaHiveServices || {};
  root.MangaHiveServices.progressStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function (identity, progress) {
  'use strict';

  if (!identity || !progress) throw new Error('MangaHiveDomain.identity/progress must be loaded before progressStore');

  var DEFAULT_PREFIX = 'mangahive-progress-v1:';

  function enc(v) { return encodeURIComponent(String(v == null ? '' : v)); }

  function createProgressStore(options) {
    var o = options || {};
    var PREFIX = o.prefix || DEFAULT_PREFIX;
    var scope = o.scope === 'user' && identity.str(o.scopeId) ? 'user' : 'local';
    var scopeId = scope === 'user' ? identity.str(o.scopeId) : null;
    var now = typeof o.now === 'function' ? o.now : function () { return Date.now(); };
    var perfNow = typeof o.perfNow === 'function' ? o.perfNow
      : (typeof performance !== 'undefined' && performance && typeof performance.now === 'function' ? function () { return performance.now(); } : now);

    var cache = Object.create(null);       // storage key -> normalised record
    var queue = Promise.resolve();
    var metrics = { lastWriteMs: null, lastWriteBytes: null, writes: 0 };

    var SCOPE_PREFIX = PREFIX + scope + ':' + enc(scopeId) + ':';
    // Tiny per-series "latest record" index: startup reads at most ONE small record per series
    // instead of every chapter record the user has ever produced.
    var LATEST_PREFIX = PREFIX + 'latest:' + scope + ':' + enc(scopeId) + ':';
    function latestKey(seriesId) { return LATEST_PREFIX + enc(identity.str(seriesId)); }

    function storage() {
      var s = typeof o.getStorage === 'function' ? o.getStorage() : o.storage;
      return (s && typeof s.get === 'function' && typeof s.set === 'function') ? s : null;
    }

    function recordKey(seriesId, chapterId) { return PREFIX + progress.progressRecordKey(scope, scopeId, seriesId, chapterId); }
    function seriesPrefix(seriesId) { return SCOPE_PREFIX + enc(identity.str(seriesId)) + ':'; }

    /** Serialise `fn` after everything already queued; a failed task never wedges the queue. */
    function enqueue(fn) {
      var run = queue.catch(function () {}).then(fn);
      queue = run;
      return run;
    }

    function readRecord(st, key) {
      if (cache[key]) return Promise.resolve(cache[key]);
      return Promise.resolve().then(function () { return st.get(key, false); }).then(function (res) {
        if (!res || res.value == null) return null;
        var parsed;
        try { parsed = typeof res.value === 'string' ? JSON.parse(res.value) : res.value; } catch (e) { return null; }
        var rec = progress.normalizeProgressRecord(parsed);
        if (rec) cache[key] = rec;
        return rec;
      }, function () { return null; });
    }

    function writeRecord(st, key, rec) {
      var text;
      try { text = JSON.stringify(rec); } catch (e) { return Promise.resolve({ ok: false, code: 'SERIALIZE_FAILED' }); }
      var t0 = perfNow();
      return Promise.resolve().then(function () { return st.set(key, text, false); }).then(function (res) {
        if (!res) return { ok: false, code: 'WRITE_FAILED' };
        cache[key] = rec;
        metrics.lastWriteMs = perfNow() - t0; metrics.lastWriteBytes = text.length; metrics.writes += 1;
        return updateLatest(st, rec).then(function () { return { ok: true, record: rec, key: key, bytes: text.length }; });
      }, function () { return { ok: false, code: 'WRITE_FAILED' }; });
    }

    /** Keep the per-series latest index in step. Best effort: the chapter record is the source of truth. */
    function updateLatest(st, rec) {
      var lk = latestKey(rec.seriesId);
      return readRecord(st, lk).then(function (cur) {
        if (cur && cur.updatedAt > rec.updatedAt) return null;
        var text = JSON.stringify(rec);
        return Promise.resolve().then(function () { return st.set(lk, text, false); }).then(function (res) {
          if (res) cache[lk] = rec;
        }, function () {});
      }).catch(function () {});
    }

    /** After a record is cleared, point the index at the newest remaining record (or drop it). */
    function rebuildLatest(st, seriesId) {
      var lk = latestKey(seriesId);
      return listKeys(seriesPrefix(seriesId)).then(function (keys) {
        return Promise.all((keys || []).map(function (k) { return readRecord(st, k); }));
      }).then(function (recs) {
        var best = progress.pickLatestRecord(recs.filter(Boolean));
        delete cache[lk];
        if (!best) return Promise.resolve().then(function () { return st.delete(lk, false); });
        return Promise.resolve().then(function () { return st.set(lk, JSON.stringify(best), false); }).then(function (res) { if (res) cache[lk] = best; });
      }).catch(function () {});
    }

    function listKeys(prefix) {
      var st = storage();
      if (!st || typeof st.list !== 'function') return Promise.resolve(null);
      return Promise.resolve().then(function () { return st.list(prefix, false); }).then(function (l) {
        return (l && Array.isArray(l.keys)) ? l.keys.filter(function (k) { return k.indexOf(prefix) === 0; }) : null;
      }, function () { return null; });
    }

    /**
     * loadProgress() → { ok, records, invalid }. Unreadable/invalid entries are reported in
     * `invalid` and left in storage untouched (never deleted). ok:false = key listing unavailable
     * (records then only contains what is cached in memory).
     */
    function loadProgress() {
      var st = storage();
      if (!st) return Promise.resolve({ ok: false, code: 'STORAGE_UNAVAILABLE', records: [], invalid: [] });
      return listKeys(SCOPE_PREFIX).then(function (keys) {
        if (!keys) return { ok: false, code: 'LIST_UNAVAILABLE', records: Object.keys(cache).filter(function (k) { return k.indexOf(SCOPE_PREFIX) === 0; }).map(function (k) { return cache[k]; }), invalid: [] };
        var records = [], invalid = [];
        return Promise.all(keys.map(function (k) {
          return Promise.resolve().then(function () { return st.get(k, false); }).then(function (res) {
            var rec = null;
            try { rec = progress.normalizeProgressRecord(typeof res.value === 'string' ? JSON.parse(res.value) : res.value); } catch (e) { rec = null; }
            if (rec) { cache[k] = rec; records.push(rec); } else invalid.push(k);
          }, function () { invalid.push(k); });
        })).then(function () { return { ok: true, records: records, invalid: invalid }; });
      });
    }

    /** The newest record of every series: one small read per series. → { ok, records } */
    function loadLatest() {
      var st = storage();
      if (!st) return Promise.resolve({ ok: false, code: 'STORAGE_UNAVAILABLE', records: [] });
      return listKeys(LATEST_PREFIX).then(function (keys) {
        if (!keys) return { ok: false, code: 'LIST_UNAVAILABLE', records: [] };
        return Promise.all(keys.map(function (k) { return readRecord(st, k); })).then(function (recs) {
          return { ok: true, records: recs.filter(Boolean) };
        });
      });
    }

    /** saveProgress(record) → one small targeted write. Never touches the library. */
    function saveProgress(record) {
      var rec = progress.normalizeProgressRecord(record);
      if (!rec) return Promise.resolve({ ok: false, code: 'INVALID_RECORD' });
      return enqueue(function () {
        var st = storage();
        if (!st) return { ok: false, code: 'STORAGE_UNAVAILABLE' };
        return writeRecord(st, PREFIX + progress.progressRecordKey(rec.scope, rec.scopeId, rec.seriesId, rec.chapterId), rec);
      });
    }

    function getChapterProgress(ref) {
      var r = ref || {};
      var sid = identity.str(r.seriesId), cid = identity.str(r.chapterId);
      if (!sid || !cid) return Promise.resolve(null);
      var st = storage();
      if (!st) return Promise.resolve(null);
      return readRecord(st, recordKey(sid, cid));
    }

    /**
     * getSeriesProgress(seriesId) → { seriesId, records (newest first), latest, completedCount }
     */
    function getSeriesProgress(seriesId) {
      var sid = identity.str(seriesId);
      var empty = { seriesId: sid, records: [], latest: null, completedCount: 0 };
      var st = storage();
      if (!sid || !st) return Promise.resolve(empty);
      var prefix = seriesPrefix(sid);
      return listKeys(prefix).then(function (keys) {
        var useKeys = keys || Object.keys(cache).filter(function (k) { return k.indexOf(prefix) === 0; });
        return Promise.all(useKeys.map(function (k) { return readRecord(st, k); }));
      }).then(function (recs) {
        var records = recs.filter(Boolean).sort(function (a, b) { return (b.updatedAt - a.updatedAt) || (a.chapterId < b.chapterId ? -1 : 1); });
        return {
          seriesId: sid,
          records: records,
          latest: progress.pickLatestRecord(records),
          completedCount: records.filter(function (r) { return r.completed; }).length
        };
      });
    }

    function buildInput(a, p) {
      return {
        series: p.series, chapter: p.chapter, seriesId: p.seriesId, chapterId: p.chapterId,
        pageIndex: p.pageIndex, pageCount: p.pageCount, scope: scope, scopeId: scopeId, now: a, sourceBindingKey: p.sourceBindingKey
      };
    }

    /**
     * updateChapterProgress({ series?, chapter?, seriesId?, chapterId?, pageIndex, pageCount?, now?, completeOnLastPage? })
     * Read-modify-write of ONE record, serialised on the queue. → { ok, record }
     */
    function updateChapterProgress(params) {
      var p = identity.isObj(params) ? params : {};
      var seriesId = identity.str(p.series && p.series.id) || identity.str(p.seriesId);
      var chapterId = identity.str(p.chapter && p.chapter.id) || identity.str(p.chapterId);
      if (!seriesId || !chapterId) return Promise.resolve({ ok: false, code: 'INVALID_REFERENCE' });
      return enqueue(function () {
        var st = storage();
        if (!st) return { ok: false, code: 'STORAGE_UNAVAILABLE' };
        var key = recordKey(seriesId, chapterId);
        var at = typeof p.now === 'number' ? p.now : now();
        return readRecord(st, key).then(function (existing) {
          var next = existing
            ? progress.updateProgressRecord(existing, { pageIndex: p.pageIndex, pageCount: p.pageCount, now: at, completeOnLastPage: p.completeOnLastPage === true, sourceBindingKey: p.sourceBindingKey })
            : progress.createProgressRecord(Object.assign(buildInput(at, p), { seriesId: seriesId, chapterId: chapterId }));
          if (!next) return { ok: false, code: 'INVALID_RECORD' };
          return writeRecord(st, key, next);
        });
      });
    }

    function mutateExisting(params, domainFn, createCompleted) {
      var p = identity.isObj(params) ? params : {};
      var seriesId = identity.str(p.series && p.series.id) || identity.str(p.seriesId);
      var chapterId = identity.str(p.chapter && p.chapter.id) || identity.str(p.chapterId);
      if (!seriesId || !chapterId) return Promise.resolve({ ok: false, code: 'INVALID_REFERENCE' });
      return enqueue(function () {
        var st = storage();
        if (!st) return { ok: false, code: 'STORAGE_UNAVAILABLE' };
        var key = recordKey(seriesId, chapterId);
        var at = typeof p.now === 'number' ? p.now : now();
        return readRecord(st, key).then(function (existing) {
          var base = existing || (createCompleted
            ? progress.createProgressRecord(Object.assign(buildInput(at, p), { seriesId: seriesId, chapterId: chapterId }))
            : null);
          if (!base) return { ok: false, code: 'NO_PROGRESS_RECORD' };
          var next = domainFn(base, { now: at, resetPage: p.resetPage });
          if (!next) return { ok: false, code: 'INVALID_RECORD' };
          return writeRecord(st, key, next);
        });
      });
    }

    /** Explicit completion (creates the record if the chapter has none yet). */
    function markCompleted(params) { return mutateExisting(params, progress.markChapterCompleted, true); }

    /** Re-read: clear completion and return to page 0 (needs an existing record). */
    function resetChapterProgress(params) { return mutateExisting(params, progress.markChapterIncomplete, false); }

    /** Remove one chapter's progress record. Only ever called for an explicit user action. */
    function clearChapterProgress(ref) {
      var r = ref || {};
      var sid = identity.str(r.seriesId), cid = identity.str(r.chapterId);
      if (!sid || !cid) return Promise.resolve({ ok: false, code: 'INVALID_REFERENCE' });
      return enqueue(function () {
        var st = storage();
        if (!st || typeof st.delete !== 'function') return { ok: false, code: 'STORAGE_UNAVAILABLE' };
        var key = recordKey(sid, cid);
        return Promise.resolve().then(function () { return st.delete(key, false); }).then(function (res) {
          delete cache[key];
          return rebuildLatest(st, sid).then(function () { return { ok: !!res, key: key }; });
        }, function () { return { ok: false, code: 'DELETE_FAILED' }; });
      });
    }

    /**
     * Legacy → records. Non-destructive and repeat-safe: records are written only when none exists
     * or the legacy entry is strictly newer; the legacy map is never edited.
     * → { ok, migrated, alreadyPresent, preserved:[{seriesId,reason}], stats }
     */
    function hydrateLegacy(library, hints) {
      return hydrateLegacyCore(library, enqueue, hints);
    }

    // `run` is how each record write is sequenced: the public path queues every write; callers that
    // already hold the queue (replaceProgressFromLibrary) pass a direct runner to avoid self-deadlock.
    //
    // `hints.latestBySeries` (seriesId -> newest record from the latest index) lets startup skip the
    // per-chapter read when the index PROVES the legacy entry is already converted: the index holds a
    // copy of a chapter record for the SAME chapter whose updatedAt is >= the legacy entry's. That is
    // exactly the condition under which the read below would have answered "alreadyPresent", so the
    // outcome is identical, just without the get(). Anything else (different chapter, older index
    // entry, no index entry, index unavailable) takes the full read path. No caching is added.
    function hydrateLegacyCore(library, run, hints) {
      var lib = identity.isObj(library) ? library : {};
      var res = progress.migrateLegacyProgress(lib.progress, lib, { scope: scope, scopeId: scopeId });
      var migrated = 0, alreadyPresent = 0, skippedByIndex = 0, migratedRecords = [];
      var latestBySeries = (hints && identity.isObj(hints.latestBySeries)) ? hints.latestBySeries : null;
      var st = storage();
      if (!st) return Promise.resolve({ ok: false, code: 'STORAGE_UNAVAILABLE', migrated: 0, alreadyPresent: 0, preserved: res.preserved, stats: res.stats });
      var chain = Promise.resolve();
      res.records.forEach(function (rec) {
        var idx = latestBySeries ? latestBySeries[rec.seriesId] : null;
        if (idx && idx.chapterId === rec.chapterId && idx.updatedAt >= rec.updatedAt) { alreadyPresent += 1; skippedByIndex += 1; return; }
        chain = chain.then(function () {
          return run(function () {
            var key = recordKey(rec.seriesId, rec.chapterId);
            return readRecord(st, key).then(function (existing) {
              if (existing && existing.updatedAt >= rec.updatedAt) { alreadyPresent += 1; return null; }
              return writeRecord(st, key, rec).then(function (w) { if (w.ok) { migrated += 1; migratedRecords.push(rec); } return w; });
            });
          });
        });
      });
      return chain.then(function () {
        return { ok: true, migrated: migrated, alreadyPresent: alreadyPresent, skippedByIndex: skippedByIndex, migratedRecords: migratedRecords, preserved: res.preserved.map(function (x) { return { seriesId: x.seriesId, reason: x.reason }; }), stats: res.stats };
      });
    }

    /** Delete every key in `keys` (+ extra known keys), dropping them from the cache. → { failed, removed } */
    function deleteKeys(st, keys) {
      var failed = 0, removed = 0;
      return Promise.all(keys.map(function (k) {
        delete cache[k];
        return Promise.resolve().then(function () { return st.delete(k, false); }).then(function (res) {
          if (res) removed += 1; else failed += 1;
        }, function () { failed += 1; });
      })).then(function () { return { failed: failed, removed: removed }; });
    }

    function cachedKeysWithPrefix(prefix) {
      return Object.keys(cache).filter(function (k) { return k.indexOf(prefix) === 0; });
    }

    /** Core of clearSeriesProgress; runs inside the queue. */
    function clearSeriesCore(st, sid) {
      var prefix = seriesPrefix(sid), lk = latestKey(sid);
      return listKeys(prefix).then(function (keys) {
        var listed = !!keys;
        var all = (keys || []).concat(cachedKeysWithPrefix(prefix));
        all.push(lk);
        var uniq = all.filter(function (k, i) { return all.indexOf(k) === i; });
        // Snapshot the chapter records BEFORE deleting so Undo can restore them (latest index excluded:
        // it is derived and is rebuilt when the records are written back).
        var chapterKeys = uniq.filter(function (k) { return k !== lk; });
        return Promise.all(chapterKeys.map(function (k) { return readRecord(st, k); })).then(function (recs) {
          var snapshot = recs.filter(Boolean);
          return deleteKeys(st, uniq).then(function (d) {
            if (!listed) return { ok: false, code: 'LIST_UNAVAILABLE', seriesId: sid, removed: d.removed, records: snapshot };
            if (d.failed) return { ok: false, code: 'DELETE_FAILED', seriesId: sid, removed: d.removed, records: snapshot };
            return { ok: true, seriesId: sid, removed: d.removed, records: snapshot };
          });
        });
      });
    }

    /** Core of clearAllProgress; runs inside the queue. Covers chapter records AND the latest index. */
    function clearAllCore(st) {
      return Promise.all([listKeys(SCOPE_PREFIX), listKeys(LATEST_PREFIX)]).then(function (lists) {
        var listed = !!(lists[0] && lists[1]);
        var all = (lists[0] || []).concat(lists[1] || [], cachedKeysWithPrefix(SCOPE_PREFIX), cachedKeysWithPrefix(LATEST_PREFIX));
        var uniq = all.filter(function (k, i) { return all.indexOf(k) === i; });
        return deleteKeys(st, uniq).then(function (d) {
          if (!listed) return { ok: false, code: 'LIST_UNAVAILABLE', removed: d.removed };
          if (d.failed) return { ok: false, code: 'DELETE_FAILED', removed: d.removed };
          return { ok: true, removed: d.removed };
        });
      });
    }

    /**
     * clearSeriesProgress(seriesId) — THE canonical "this series is gone" operation. Removes every
     * per-chapter record of the series plus its latest-index entry. Call it from every destructive
     * removal path; no caller may touch progress storage keys itself. → { ok, removed }
     * ok:false means something may remain (code: LIST_UNAVAILABLE | DELETE_FAILED | ...).
     */
    function clearSeriesProgress(seriesId) {
      var sid = identity.str(seriesId);
      if (!sid) return Promise.resolve({ ok: false, code: 'INVALID_REFERENCE' });
      return enqueue(function () {
        var st = storage();
        if (!st || typeof st.delete !== 'function') return { ok: false, code: 'STORAGE_UNAVAILABLE' };
        return clearSeriesCore(st, sid);
      });
    }

    /**
     * restoreSeriesProgress(seriesId, records) — Undo support. Writes back the records that
     * clearSeriesProgress() returned (only those belonging to `seriesId`), keeping their original
     * timestamps. This is the ONLY way removed progress comes back; a normal re-add never calls it.
     * → { ok, written }
     */
    function restoreSeriesProgress(seriesId, records) {
      var sid = identity.str(seriesId);
      var list = Array.isArray(records) ? records : [];
      if (!sid) return Promise.resolve({ ok: false, code: 'INVALID_REFERENCE' });
      return enqueue(function () {
        var st = storage();
        if (!st) return { ok: false, code: 'STORAGE_UNAVAILABLE' };
        var written = 0, skipped = 0, chain = Promise.resolve();
        list.forEach(function (raw) {
          chain = chain.then(function () {
            var rec = progress.normalizeProgressRecord(raw);
            if (!rec || rec.seriesId !== sid) { skipped += 1; return null; }
            return writeRecord(st, recordKey(rec.seriesId, rec.chapterId), rec).then(function (w) { if (w.ok) written += 1; else skipped += 1; });
          });
        });
        return chain.then(function () { return { ok: skipped === 0, written: written, skipped: skipped }; });
      });
    }

    /** clearAllProgress() — drop every record and latest-index entry in this store's scope. */
    function clearAllProgress() {
      return enqueue(function () {
        var st = storage();
        if (!st || typeof st.delete !== 'function') return { ok: false, code: 'STORAGE_UNAVAILABLE' };
        return clearAllCore(st);
      });
    }

    /**
     * replaceAllProgress(records) — atomically (on the queue) clear everything, then write exactly
     * `records` (invalid ones are skipped and reported). If the clear fails nothing is written, so
     * stale and new progress are never mixed. → { ok, written, skipped }
     */
    function replaceAllProgress(records) {
      var list = Array.isArray(records) ? records : [];
      return enqueue(function () {
        var st = storage();
        if (!st || typeof st.delete !== 'function') return { ok: false, code: 'STORAGE_UNAVAILABLE' };
        return clearAllCore(st).then(function (c) {
          if (!c.ok) return { ok: false, code: c.code, written: 0, skipped: list.length };
          var written = 0, skipped = 0, chain = Promise.resolve();
          list.forEach(function (raw) {
            chain = chain.then(function () {
              var rec = progress.normalizeProgressRecord(raw);
              if (!rec) { skipped += 1; return null; }
              return writeRecord(st, recordKey(rec.seriesId, rec.chapterId), rec).then(function (w) { if (w.ok) written += 1; else skipped += 1; });
            });
          });
          return chain.then(function () { return { ok: skipped === 0, written: written, skipped: skipped }; });
        });
      });
    }

    /**
     * replaceProgressFromLibrary(library) — full-library import: clear ALL local progress, then
     * rebuild records from the imported library's legacy-shaped `progress` map (same chapter
     * identification rules as hydrateLegacy). Backup with no progress → local progress ends empty.
     * → { ok, cleared, migrated, preserved }
     */
    function replaceProgressFromLibrary(library) {
      return enqueue(function () {
        var st = storage();
        if (!st || typeof st.delete !== 'function') return { ok: false, code: 'STORAGE_UNAVAILABLE' };
        return clearAllCore(st).then(function (c) {
          if (!c.ok) return { ok: false, code: c.code };
          return hydrateLegacyCore(library, function (fn) { return Promise.resolve().then(fn); }).then(function (h) {
            return { ok: h.ok, cleared: c.removed, migrated: h.migrated, preserved: h.preserved };
          });
        });
      });
    }

    /**
     * hydrateLibraryProgress(library) — the legacy boundary. Migrates legacy entries, then merges
     * newer per-chapter records back onto `library.progress` in the legacy shape (unknown legacy
     * fields are kept) so existing UI reads keep working. Only series that exist in `library` are
     * touched. Mutates `library.progress` (and nothing else). → report
     */
    function hydrateLibraryProgress(library) {
      if (!identity.isObj(library)) return Promise.resolve({ ok: false, code: 'INVALID_LIBRARY' });
      if (!identity.isObj(library.progress)) library.progress = {};
      // Latest index FIRST: one list + one small read per series. When it already covers a legacy
      // entry, migration for that entry needs no further reads (see hydrateLegacyCore).
      return loadLatest().then(function (loaded) {
        var latestBySeries = null;
        if (loaded.ok) {
          latestBySeries = {};
          loaded.records.forEach(function (r) {
            var cur = latestBySeries[r.seriesId];
            if (!cur || r.updatedAt > cur.updatedAt) latestBySeries[r.seriesId] = r;
          });
        }
        return hydrateLegacy(library, { latestBySeries: latestBySeries }).then(function (mig) {
          var known = {};
          (Array.isArray(library.series) ? library.series : []).forEach(function (s) { var id = identity.str(s && s.id); if (id) known[id] = true; });
          // Index entries plus anything the migration just wrote (the index read happened before it).
          var records = loaded.records.concat(mig.migratedRecords || []).filter(function (r) { return known[r.seriesId]; });
          var updates = progress.projectLegacyProgress(records, library.progress);
          var applied = 0;
          Object.keys(updates).forEach(function (sid) {
            library.progress[sid] = Object.assign({}, library.progress[sid], updates[sid]);
            applied += 1;
          });
          return { ok: mig.ok && loaded.ok, migration: mig, recordsLoaded: loaded.records.length, legacyViewUpdated: applied, legacyReadsSkipped: mig.skippedByIndex || 0 };
        });
      });
    }

    return {
      scope: scope,
      loadProgress: loadProgress,
      loadLatest: loadLatest,
      saveProgress: saveProgress,
      updateChapterProgress: updateChapterProgress,
      markCompleted: markCompleted,
      resetChapterProgress: resetChapterProgress,
      clearChapterProgress: clearChapterProgress,
      clearSeriesProgress: clearSeriesProgress,
      restoreSeriesProgress: restoreSeriesProgress,
      clearAllProgress: clearAllProgress,
      replaceAllProgress: replaceAllProgress,
      replaceProgressFromLibrary: replaceProgressFromLibrary,
      getChapterProgress: getChapterProgress,
      getSeriesProgress: getSeriesProgress,
      hydrateLegacy: hydrateLegacy,
      hydrateLibraryProgress: hydrateLibraryProgress,
      getMetrics: function () { return Object.assign({}, metrics); }
    };
  }

  return { DEFAULT_PREFIX: DEFAULT_PREFIX, createProgressStore: createProgressStore };
});
