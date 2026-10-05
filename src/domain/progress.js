/**
 * MangaHive Phase 1 / Stage 1 — Progress domain model (pure domain module).
 *
 * Progress is recorded PER CHAPTER and is scoped:
 *
 *   {
 *     schemaVersion, scope, scopeId,
 *     seriesId, canonicalSeriesId,
 *     chapterId, canonicalChapterId,
 *     pageIndex, pageCount,
 *     completed, completedAt, updatedAt,
 *     sourceBindingKey
 *   }
 *
 *   scope      'local' (this device/profile) | 'user' (needs scopeId = user id).
 *              Stage 1 only ever writes 'local'; 'user' exists so the record
 *              shape never has to change when sync arrives. No server involved.
 *   seriesId / chapterId   LOCAL ids – the keys all existing persisted data uses.
 *   canonical*             library-canonical ids, or null when they could not be
 *                          established with confidence (never invented).
 *
 * All functions are pure: they return new records, never mutate arguments,
 * never touch storage / DOM / network, and never throw on malformed input
 * (they return null / false / 0 instead). The only impurity is the *default*
 * clock; pass `now` for fully deterministic results.
 */
(function (root, factory) {
  var identity = (typeof require === 'function' && typeof module === 'object' && module && module.exports)
    ? require('./identity.js')
    : (root.MangaHiveDomain && root.MangaHiveDomain.identity);
  var api = factory(identity);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.MangaHiveDomain = root.MangaHiveDomain || {};
  root.MangaHiveDomain.progress = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function (identity) {
  'use strict';

  if (!identity) throw new Error('MangaHiveDomain.identity must be loaded before progress');

  var SCHEMA_VERSION = 1;
  var SCOPES = ['local', 'user'];
  // canonical ids derived with these confidences are trusted enough to be stored on a record
  var CONFIDENT = { existing: true, structured: true, remote: true };

  function clock(now) { return (typeof now === 'number' && isFinite(now)) ? now : Date.now(); }
  function toCount(v) { var n = Math.floor(Number(v)); return (isFinite(n) && n > 0) ? n : 0; }
  function ts(v) { var n = Number(v); return (isFinite(n) && n >= 0) ? n : null; }

  /** Clamp to [0, pageCount-1]; pageCount 0 = unknown, so only the lower bound applies. */
  function clampPage(pageIndex, pageCount) {
    var n = Math.floor(Number(pageIndex));
    if (!isFinite(n) || n < 0) n = 0;
    var count = toCount(pageCount);
    if (count > 0 && n > count - 1) n = count - 1;
    return n;
  }

  function lastPage(pageCount) { var c = toCount(pageCount); return c > 0 ? c - 1 : null; }

  function normalizeScope(scope, scopeId) {
    var sc = SCOPES.indexOf(scope) >= 0 ? scope : 'local';
    var sid = identity.str(scopeId);
    if (sc === 'user' && !sid) return { scope: 'local', scopeId: null }; // a user scope without a user is not a user scope
    return { scope: sc, scopeId: sc === 'user' ? sid : null };
  }

  // ---- record construction / validation ----------------------------------

  /**
   * Validate + normalise an arbitrary value into a progress record, or null.
   * Unknown fields are preserved so a newer schema survives a round trip.
   */
  function normalizeProgressRecord(raw) {
    if (!identity.isObj(raw)) return null;
    var seriesId = identity.str(raw.seriesId), chapterId = identity.str(raw.chapterId);
    if (!seriesId || !chapterId) return null;
    var sc = normalizeScope(raw.scope, raw.scopeId);
    var pageCount = toCount(raw.pageCount);
    var completed = raw.completed === true;
    var out = Object.assign({}, raw);
    out.schemaVersion = SCHEMA_VERSION;
    out.scope = sc.scope;
    out.scopeId = sc.scopeId;
    out.seriesId = seriesId;
    out.canonicalSeriesId = identity.str(raw.canonicalSeriesId) || null;
    out.chapterId = chapterId;
    out.canonicalChapterId = identity.isCanonicalChapterId(raw.canonicalChapterId) ? raw.canonicalChapterId : null;
    out.pageCount = pageCount;
    out.pageIndex = clampPage(raw.pageIndex, pageCount);
    out.completed = completed;
    out.completedAt = completed ? ts(raw.completedAt) : null;
    out.updatedAt = ts(raw.updatedAt) || 0;
    out.sourceBindingKey = identity.str(raw.sourceBindingKey) || null;
    return out;
  }

  /**
   * createProgressRecord({ series?, chapter?, seriesId?, chapterId?, pageIndex, pageCount,
   *                        scope, scopeId, completed, completedAt, sourceBindingKey, now })
   * Pass the series/chapter objects (preferred – canonical ids are then derived through the
   * identity contract) or just the local ids. Returns null without both a series and chapter id.
   */
  function createProgressRecord(input) {
    var p = identity.isObj(input) ? input : {};
    var series = identity.isObj(p.series) ? p.series : null;
    var chapter = identity.isObj(p.chapter) ? p.chapter : null;
    var seriesId = identity.str(series && series.id) || identity.str(p.seriesId);
    var chapterId = identity.str(chapter && chapter.id) || identity.str(p.chapterId);
    if (!seriesId || !chapterId) return null;

    var canonicalSeriesId = null, canonicalChapterId = null, bindingKey = identity.str(p.sourceBindingKey) || null;
    if (series) canonicalSeriesId = identity.getSeriesIdentity(series).canonicalId;
    else canonicalSeriesId = identity.str(p.canonicalSeriesId) || null;
    if (chapter) {
      var ci = identity.getChapterIdentity(chapter, series);
      if (CONFIDENT[ci.confidence]) canonicalChapterId = ci.canonicalChapterId;
      if (!bindingKey && ci.sources.length === 1) bindingKey = ci.sources[0].bindingKey;
    } else if (identity.isCanonicalChapterId(p.canonicalChapterId)) {
      canonicalChapterId = p.canonicalChapterId;
    }

    var now = clock(p.now);
    var sc = normalizeScope(p.scope, p.scopeId);
    var pageCount = toCount(p.pageCount != null ? p.pageCount : (chapter && Array.isArray(chapter.pages) ? chapter.pages.length : 0));
    var completed = p.completed === true;
    return {
      schemaVersion: SCHEMA_VERSION,
      scope: sc.scope,
      scopeId: sc.scopeId,
      seriesId: seriesId,
      canonicalSeriesId: canonicalSeriesId,
      chapterId: chapterId,
      canonicalChapterId: canonicalChapterId,
      pageIndex: clampPage(p.pageIndex, pageCount),
      pageCount: pageCount,
      completed: completed,
      completedAt: completed ? (ts(p.completedAt) != null ? ts(p.completedAt) : now) : null,
      updatedAt: now,
      sourceBindingKey: bindingKey
    };
  }

  /**
   * New record with an updated position. `patch`: { pageIndex, pageCount?, now?,
   * completeOnLastPage? (default false – completion is explicit), sourceBindingKey? }.
   * An already-completed record stays completed (re-reading does not un-read a chapter);
   * use markChapterIncomplete to reset it.
   */
  function updateProgressRecord(record, patch) {
    var r = normalizeProgressRecord(record);
    if (!r) return null;
    var p = identity.isObj(patch) ? patch : {};
    var now = clock(p.now);
    // an unknown/zero page count in a patch means "not known right now" – it never erases a known count
    var pageCount = toCount(p.pageCount) > 0 ? toCount(p.pageCount) : r.pageCount;
    var next = Object.assign({}, r, {
      pageCount: pageCount,
      pageIndex: clampPage(p.pageIndex != null ? p.pageIndex : r.pageIndex, pageCount),
      updatedAt: now
    });
    if (p.sourceBindingKey != null) next.sourceBindingKey = identity.str(p.sourceBindingKey) || null;
    if (p.canonicalChapterId != null && identity.isCanonicalChapterId(p.canonicalChapterId)) next.canonicalChapterId = p.canonicalChapterId;
    if (!next.completed && p.completeOnLastPage === true && lastPage(pageCount) !== null && next.pageIndex >= lastPage(pageCount)) {
      next.completed = true;
      next.completedAt = now;
    }
    return next;
  }

  /** Explicit completion. Idempotent: the first completion time is kept. */
  function markChapterCompleted(record, options) {
    var r = normalizeProgressRecord(record);
    if (!r) return null;
    var now = clock(options && options.now);
    var last = lastPage(r.pageCount);
    return Object.assign({}, r, {
      completed: true,
      completedAt: (r.completed && r.completedAt != null) ? r.completedAt : now,
      pageIndex: last !== null ? last : r.pageIndex,
      updatedAt: now
    });
  }

  /**
   * Re-read support: clears completion and (by default) returns to page 0.
   * Identity fields are carried over unchanged.
   */
  function markChapterIncomplete(record, options) {
    var r = normalizeProgressRecord(record);
    if (!r) return null;
    var now = clock(options && options.now);
    var resetPage = !(options && options.resetPage === false);
    return Object.assign({}, r, {
      completed: false,
      completedAt: null,
      pageIndex: resetPage ? 0 : r.pageIndex,
      updatedAt: now
    });
  }

  function isChapterCompleted(record) {
    return identity.isObj(record) && record.completed === true;
  }

  /** 0–100. Position-based: viewing the last page of a chapter is 100%. Completed ⇒ 100. */
  function getProgressPercentage(record) {
    var r = normalizeProgressRecord(record);
    if (!r) return 0;
    if (r.completed) return 100;
    if (r.pageCount <= 0) return 0;
    var pct = Math.round(((r.pageIndex + 1) / r.pageCount) * 100);
    return Math.max(0, Math.min(100, pct));
  }

  /**
   * Page the reader should open on. A chapter that was finished (completed and parked on its
   * last page) restarts at 0; a completed chapter being re-read resumes where it was left.
   */
  function getResumePage(record) {
    var r = normalizeProgressRecord(record);
    if (!r) return 0;
    var last = lastPage(r.pageCount);
    if (r.completed && (last === null || r.pageIndex >= last)) return 0;
    return r.pageIndex;
  }

  // ---- keys ---------------------------------------------------------------

  function enc(v) { return encodeURIComponent(String(v == null ? '' : v)); }

  /** Per-series key prefix (ends with ':'): `local:<scopeId>:<seriesId>:` */
  function progressSeriesPrefix(scope, scopeId, seriesId) {
    var sc = normalizeScope(scope, scopeId);
    return sc.scope + ':' + enc(sc.scopeId) + ':' + enc(identity.str(seriesId)) + ':';
  }

  /** Unique key for one chapter's record within a scope. Colons in ids are escaped. */
  function progressRecordKey(scope, scopeId, seriesId, chapterId) {
    return progressSeriesPrefix(scope, scopeId, seriesId) + enc(identity.str(chapterId));
  }

  /** Most recently updated record (ties broken by chapterId, so the answer is deterministic). */
  function pickLatestRecord(records) {
    var best = null;
    (Array.isArray(records) ? records : []).forEach(function (rec) {
      var r = normalizeProgressRecord(rec);
      if (!r) return;
      if (!best || r.updatedAt > best.updatedAt || (r.updatedAt === best.updatedAt && r.chapterId > best.chapterId)) best = r;
    });
    return best;
  }

  // ---- legacy migration ---------------------------------------------------

  /**
   * Convert the legacy `state.progress[seriesId] = { chapterId, pageIndex, updatedAt }` map into
   * per-chapter records. Pure, deterministic (no clock), idempotent, non-destructive: it only
   * reports; it never edits `legacyMap` or `library`.
   *
   * A legacy entry is converted only when its series AND chapter exist in `library` and the
   * chapter's canonical id can be established with confidence. Otherwise it is returned in
   * `preserved` with a reason, and the caller leaves the legacy entry exactly where it is.
   *
   * @returns { records: [...], preserved: [{ seriesId, reason, legacy }], stats: {...} }
   */
  function migrateLegacyProgress(legacyMap, library, options) {
    var records = [], preserved = [];
    var sc = normalizeScope(options && options.scope, options && options.scopeId);
    var seriesList = (library && Array.isArray(library.series)) ? library.series : [];
    var bySid = {};
    seriesList.forEach(function (s) { var id = identity.str(s && s.id); if (id && !bySid[id]) bySid[id] = s; });

    var keys = identity.isObj(legacyMap) ? Object.keys(legacyMap).sort() : [];
    keys.forEach(function (seriesId) {
      var legacy = legacyMap[seriesId];
      var chapterId = identity.isObj(legacy) ? identity.str(legacy.chapterId) : '';
      if (!chapterId) return preserved.push({ seriesId: seriesId, reason: 'malformed-legacy-record', legacy: legacy });
      var series = bySid[identity.str(seriesId)];
      if (!series) return preserved.push({ seriesId: seriesId, reason: 'series-not-found', legacy: legacy });
      var chapter = null;
      var chapters = Array.isArray(series.chapters) ? series.chapters : [];
      for (var i = 0; i < chapters.length; i++) {
        if (identity.isObj(chapters[i]) && identity.str(chapters[i].id) === chapterId) { chapter = chapters[i]; break; }
      }
      if (!chapter) return preserved.push({ seriesId: seriesId, reason: 'chapter-not-found', legacy: legacy });
      var ci = identity.getChapterIdentity(chapter, series);
      if (!CONFIDENT[ci.confidence]) return preserved.push({ seriesId: seriesId, reason: 'canonical-identity-not-confident', legacy: legacy });
      var rec = createProgressRecord({
        series: series, chapter: chapter,
        pageIndex: legacy.pageIndex,
        pageCount: Array.isArray(chapter.pages) ? chapter.pages.length : (toCount(chapter.pageCount)),
        scope: sc.scope, scopeId: sc.scopeId,
        now: ts(legacy.updatedAt) || 0
      });
      if (!rec) return preserved.push({ seriesId: seriesId, reason: 'malformed-legacy-record', legacy: legacy });
      records.push(rec);
    });
    return { records: records, preserved: preserved, stats: { legacy: keys.length, migrated: records.length, preserved: preserved.length } };
  }

  /**
   * Legacy-shaped view of newer per-chapter records, for UI code that still reads
   * `state.progress[seriesId]`. Returns ONLY the entries that should change
   * (`{ seriesId: { chapterId, pageIndex, updatedAt } }`); the caller merges them over the
   * existing legacy entry so unknown legacy fields survive.
   */
  function projectLegacyProgress(records, legacyMap) {
    var legacy = identity.isObj(legacyMap) ? legacyMap : {};
    var bySeries = {};
    (Array.isArray(records) ? records : []).forEach(function (rec) {
      var r = normalizeProgressRecord(rec);
      if (!r || r.scope !== 'local') return;
      (bySeries[r.seriesId] = bySeries[r.seriesId] || []).push(r);
    });
    var updates = {};
    Object.keys(bySeries).sort().forEach(function (sid) {
      var latest = pickLatestRecord(bySeries[sid]);
      var cur = legacy[sid];
      var curAt = identity.isObj(cur) ? (ts(cur.updatedAt) || 0) : -1;
      if (latest && latest.updatedAt > curAt) {
        updates[sid] = { chapterId: latest.chapterId, pageIndex: latest.pageIndex, updatedAt: latest.updatedAt };
      }
    });
    return updates;
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    clampPage: clampPage,
    normalizeProgressRecord: normalizeProgressRecord,
    createProgressRecord: createProgressRecord,
    updateProgressRecord: updateProgressRecord,
    markChapterCompleted: markChapterCompleted,
    markChapterIncomplete: markChapterIncomplete,
    isChapterCompleted: isChapterCompleted,
    getProgressPercentage: getProgressPercentage,
    getResumePage: getResumePage,
    progressSeriesPrefix: progressSeriesPrefix,
    progressRecordKey: progressRecordKey,
    pickLatestRecord: pickLatestRecord,
    migrateLegacyProgress: migrateLegacyProgress,
    projectLegacyProgress: projectLegacyProgress
  };
});
