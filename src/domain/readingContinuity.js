'use strict';
/**
 * MangaHive Phase 1 / Stage 6 — Reading Continuity & Resume (pure domain).
 *
 * Authoritative resolution of where a user should continue reading a series.
 * Uses ChapterOrder + Progress contracts. No DOM / network / storage.
 *
 * Loading: MangaHiveDomain.readingContinuity / CommonJS.
 */
(function (root, factory) {
  var chapterOrder = null;
  var progress = null;
  var identity = null;
  try {
    if (typeof require === 'function' && typeof module === 'object' && module && module.exports) {
      chapterOrder = require('./chapterOrder.js');
      progress = require('./progress.js');
      identity = require('./identity.js');
    }
  } catch (e) {}
  if (!chapterOrder) chapterOrder = root.MangaHiveDomain && root.MangaHiveDomain.chapterOrder;
  if (!progress) progress = root.MangaHiveDomain && root.MangaHiveDomain.progress;
  if (!identity) identity = root.MangaHiveDomain && root.MangaHiveDomain.identity;

  var api = factory(chapterOrder, progress, identity);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.MangaHiveDomain = root.MangaHiveDomain || {};
  root.MangaHiveDomain.readingContinuity = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function (chapterOrder, progress, identity) {
  function str(v) {
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number' && isFinite(v)) return String(v);
    return '';
  }
  function isObj(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }
  function num(v, fallback) {
    var n = Number(v);
    return isFinite(n) ? n : (fallback != null ? fallback : 0);
  }

  function orderedChapters(series) {
    var raw = Array.isArray(series && series.chapters) ? series.chapters.slice() : [];
    if (chapterOrder && typeof chapterOrder.sortChapters === 'function') {
      return chapterOrder.sortChapters(raw, series);
    }
    return raw;
  }

  function chapterById(chapters, id) {
    var want = str(id);
    if (!want) return null;
    for (var i = 0; i < chapters.length; i++) {
      if (str(chapters[i].id) === want) return chapters[i];
    }
    return null;
  }

  /**
   * Find chapter by canonical chapter id or remote binding when local id changed.
   */
  function findChapterByIdentity(chapters, series, hint) {
    if (!hint) return null;
    var byLocal = chapterById(chapters, hint.chapterId);
    if (byLocal) return byLocal;
    var canon = str(hint.canonicalChapterId);
    if (canon) {
      for (var i = 0; i < chapters.length; i++) {
        var ch = chapters[i];
        if (str(ch.canonicalChapterId) === canon) return ch;
        if (identity && typeof identity.getChapterIdentity === 'function') {
          try {
            var cid = identity.getChapterIdentity(ch, series);
            if (cid && str(cid.canonicalChapterId) === canon) return ch;
          } catch (e) {}
        }
      }
    }
    // remoteId / source binding fallback
    var remote = str(hint.remoteId);
    if (remote) {
      for (var j = 0; j < chapters.length; j++) {
        if (str(chapters[j].remoteId) === remote) return chapters[j];
      }
    }
    return null;
  }

  /**
   * Normalize a single chapter progress entry into a continuity-friendly record.
   * Accepts Progress Store records or legacy { chapterId, pageIndex, updatedAt, completed? }.
   */
  function normalizeContinuityRecord(raw, seriesId) {
    if (!isObj(raw)) return null;
    var record = null;
    if (progress && typeof progress.normalizeProgressRecord === 'function') {
      record = progress.normalizeProgressRecord(raw);
    }
    if (record) {
      return {
        seriesId: str(record.seriesId) || str(seriesId) || null,
        canonicalSeriesId: str(record.canonicalSeriesId) || null,
        chapterId: str(record.chapterId) || null,
        canonicalChapterId: str(record.canonicalChapterId) || null,
        pageIndex: typeof record.pageIndex === 'number' ? record.pageIndex : 0,
        pageCount: typeof record.pageCount === 'number' ? record.pageCount : 0,
        completed: record.completed === true,
        completedAt: record.completedAt != null ? record.completedAt : null,
        updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
        sourceBindingKey: str(record.sourceBindingKey) || null,
        remoteId: str(raw.remoteId) || null,
        valid: true
      };
    }
    // Soft recovery for malformed legacy-ish objects
    var chapterId = str(raw.chapterId);
    if (!chapterId) return null;
    var pageIndex = num(raw.pageIndex, 0);
    if (pageIndex < 0 || !isFinite(pageIndex)) pageIndex = 0;
    var pageCount = num(raw.pageCount, 0);
    if (pageCount < 0 || !isFinite(pageCount)) pageCount = 0;
    if (pageCount > 0 && pageIndex >= pageCount) pageIndex = pageCount - 1;
    var updatedAt = num(raw.updatedAt, 0);
    return {
      seriesId: str(seriesId) || null,
      canonicalSeriesId: null,
      chapterId: chapterId,
      canonicalChapterId: str(raw.canonicalChapterId) || null,
      pageIndex: Math.floor(pageIndex),
      pageCount: Math.floor(pageCount),
      completed: raw.completed === true,
      completedAt: raw.completedAt != null ? raw.completedAt : null,
      updatedAt: updatedAt,
      sourceBindingKey: str(raw.sourceBindingKey) || null,
      remoteId: str(raw.remoteId) || null,
      valid: true
    };
  }

  /**
   * Collect continuity records from:
   * - seriesProgress map: { [chapterId]: record }
   * - or a single legacy state.progress[seriesId] entry
   * - or an array of records
   */
  function collectRecords(series, seriesProgress) {
    var seriesId = str(series && series.id);
    var out = [];
    if (Array.isArray(seriesProgress)) {
      seriesProgress.forEach(function (r) {
        var n = normalizeContinuityRecord(r, seriesId);
        if (n) out.push(n);
      });
      return out;
    }
    if (!isObj(seriesProgress)) return out;
    // Legacy single pointer: { chapterId, pageIndex, updatedAt }
    if (seriesProgress.chapterId && (seriesProgress.pageIndex != null || seriesProgress.updatedAt != null) &&
        !seriesProgress[seriesProgress.chapterId]) {
      var leg = normalizeContinuityRecord(seriesProgress, seriesId);
      if (leg) out.push(leg);
      return out;
    }
    Object.keys(seriesProgress).forEach(function (key) {
      var val = seriesProgress[key];
      if (!isObj(val)) return;
      // If value lacks chapterId, use key
      if (!val.chapterId) val = Object.assign({}, val, { chapterId: key });
      var n = normalizeContinuityRecord(val, seriesId);
      if (n) out.push(n);
    });
    return out;
  }

  function pickLatestRecord(records) {
    if (progress && typeof progress.pickLatestRecord === 'function') {
      var mapped = records.map(function (r) {
        return {
          seriesId: r.seriesId,
          chapterId: r.chapterId,
          pageIndex: r.pageIndex,
          pageCount: r.pageCount,
          completed: r.completed,
          completedAt: r.completedAt,
          updatedAt: r.updatedAt,
          scope: 'local',
          scopeId: 'default'
        };
      });
      var best = progress.pickLatestRecord(mapped);
      if (!best) return null;
      for (var i = 0; i < records.length; i++) {
        if (records[i].chapterId === best.chapterId && records[i].updatedAt === best.updatedAt) {
          return records[i];
        }
      }
    }
    var top = null;
    records.forEach(function (r) {
      if (!top || r.updatedAt > top.updatedAt ||
          (r.updatedAt === top.updatedAt && r.chapterId > top.chapterId)) {
        top = r;
      }
    });
    return top;
  }

  function isChapterCompleted(series, chapter, records, readChapters) {
    if (!chapter) return false;
    if (readChapters && readChapters[chapter.id]) return true;
    for (var i = 0; i < records.length; i++) {
      if (records[i].chapterId === str(chapter.id) && records[i].completed) return true;
    }
    return false;
  }

  /**
   * Next unread chapter after `fromChapter` (exclusive), or first unread if fromChapter null.
   * Uses ChapterOrder.
   */
  function getNextUnreadChapter(series, options) {
    options = options || {};
    var chapters = orderedChapters(series);
    if (!chapters.length) return null;
    var records = collectRecords(series, options.seriesProgress);
    var readChapters = options.readChapters || (series && series.readChapters) || null;

    var startIdx = 0;
    if (options.fromChapter) {
      var fromId = str(options.fromChapter.id || options.fromChapter);
      for (var i = 0; i < chapters.length; i++) {
        if (str(chapters[i].id) === fromId) {
          startIdx = i + 1;
          break;
        }
      }
    }

    for (var j = startIdx; j < chapters.length; j++) {
      if (!isChapterCompleted(series, chapters[j], records, readChapters)) {
        return chapters[j];
      }
    }
    // If fromChapter was set and nothing after, scan from start for any unread
    if (options.fromChapter && startIdx > 0) {
      for (var k = 0; k < chapters.length; k++) {
        if (!isChapterCompleted(series, chapters[k], records, readChapters)) {
          return chapters[k];
        }
      }
    }
    return null;
  }

  function clampPage(pageIndex, pageCount) {
    if (progress && typeof progress.clampPage === 'function') {
      return progress.clampPage(pageIndex, pageCount);
    }
    var count = Math.floor(Number(pageCount));
    if (!isFinite(count) || count <= 0) return 0;
    var idx = Math.floor(Number(pageIndex));
    if (!isFinite(idx) || idx < 0) return 0;
    if (idx >= count) return count - 1;
    return idx;
  }

  /**
   * Authoritative Continue Reading resolution for a series.
   *
   * @returns {
   *   kind: 'empty'|'start'|'continue'|'next'|'finished'|'missing',
   *   label, seriesId, chapterId, chapter, pageIndex, pageCount,
   *   completed, updatedAt, record
   * }
   */
  function resolveSeriesContinuity(series, seriesProgress, options) {
    options = options || {};
    if (!series || !str(series.id)) {
      return {
        kind: 'empty',
        label: 'No series',
        seriesId: null,
        chapterId: null,
        chapter: null,
        pageIndex: 0,
        pageCount: 0,
        completed: false,
        updatedAt: 0,
        record: null
      };
    }

    var chapters = orderedChapters(series);
    var seriesId = str(series.id);
    var records = collectRecords(series, seriesProgress);
    var readChapters = options.readChapters || series.readChapters || null;

    if (!chapters.length) {
      return {
        kind: 'empty',
        label: 'No chapters available',
        seriesId: seriesId,
        chapterId: null,
        chapter: null,
        pageIndex: 0,
        pageCount: 0,
        completed: false,
        updatedAt: 0,
        record: null
      };
    }

    var latest = pickLatestRecord(records);

    // Case: no progress → first unread (or first chapter)
    if (!latest) {
      var first = getNextUnreadChapter(series, { seriesProgress: seriesProgress, readChapters: readChapters });
      if (!first) first = chapters[0];
      var anyRead = readChapters && Object.keys(readChapters).length > 0;
      return {
        kind: anyRead ? 'next' : 'start',
        label: anyRead ? chapterLabel(first, 'Continue') : chapterLabel(first, 'Start'),
        seriesId: seriesId,
        chapterId: first.id,
        chapter: first,
        pageIndex: 0,
        pageCount: Array.isArray(first.pages) ? first.pages.length : 0,
        completed: false,
        updatedAt: 0,
        record: null
      };
    }

    // Resolve chapter identity (handles missing / id drift)
    var chapter = findChapterByIdentity(chapters, series, latest);

    // Saved chapter missing → next unread from order, else first
    if (!chapter) {
      var fallback = getNextUnreadChapter(series, { seriesProgress: seriesProgress, readChapters: readChapters });
      if (!fallback) {
        return {
          kind: 'missing',
          label: 'No continuation available',
          seriesId: seriesId,
          chapterId: latest.chapterId,
          chapter: null,
          pageIndex: 0,
          pageCount: 0,
          completed: latest.completed,
          updatedAt: latest.updatedAt,
          record: latest
        };
      }
      return {
        kind: 'next',
        label: chapterLabel(fallback, 'Continue'),
        seriesId: seriesId,
        chapterId: fallback.id,
        chapter: fallback,
        pageIndex: 0,
        pageCount: Array.isArray(fallback.pages) ? fallback.pages.length : 0,
        completed: false,
        updatedAt: latest.updatedAt,
        record: latest
      };
    }

    // Completed chapter → next unread
    if (latest.completed || isChapterCompleted(series, chapter, records, readChapters)) {
      var next = getNextUnreadChapter(series, {
        seriesProgress: seriesProgress,
        readChapters: readChapters,
        fromChapter: chapter
      });
      if (!next) {
        return {
          kind: 'finished',
          label: 'All caught up',
          seriesId: seriesId,
          chapterId: chapter.id,
          chapter: chapter,
          pageIndex: clampPage(latest.pageIndex, latest.pageCount || (chapter.pages && chapter.pages.length) || 0),
          pageCount: latest.pageCount || (chapter.pages && chapter.pages.length) || 0,
          completed: true,
          updatedAt: latest.updatedAt,
          record: latest
        };
      }
      return {
        kind: 'next',
        label: chapterLabel(next, 'Continue'),
        seriesId: seriesId,
        chapterId: next.id,
        chapter: next,
        pageIndex: 0,
        pageCount: Array.isArray(next.pages) ? next.pages.length : 0,
        completed: false,
        updatedAt: latest.updatedAt,
        record: latest
      };
    }

    // Incomplete progress → resume saved chapter + clamped page
    var pageCount = latest.pageCount || (chapter.pages && chapter.pages.length) ||
      (chapter._normalizedPages && chapter._normalizedPages.length) || 0;
    var pageIndex = clampPage(latest.pageIndex, pageCount || (latest.pageIndex + 1));
    // If we have no pageCount yet, keep saved index (Reader will clamp after load)
    if (!pageCount && typeof latest.pageIndex === 'number' && latest.pageIndex >= 0) {
      pageIndex = Math.floor(latest.pageIndex);
    }

    return {
      kind: 'continue',
      label: chapterLabel(chapter, 'Continue'),
      seriesId: seriesId,
      chapterId: chapter.id,
      chapter: chapter,
      pageIndex: pageIndex,
      pageCount: pageCount,
      completed: false,
      updatedAt: latest.updatedAt,
      record: latest
    };
  }

  function chapterLabel(chapter, verb) {
    if (!chapter) return verb + ' Reading';
    var num = str(chapter.chapter) || str(chapter.numberText) || str(chapter.number) || '';
    if (num) return verb + ' Chapter ' + num;
    var title = str(chapter.title);
    if (title && title.length < 40) return verb + ' ' + title;
    return verb + ' Reading';
  }

  /**
   * Explicit chapter open: do not skip completed chapters.
   * Returns resume page for that chapter (completed policy from progress.getResumePage).
   */
  /**
   * Locate a progress record for an explicit chapter open using:
   * 1) exact local chapter id
   * 2) canonicalChapterId
   * 3) remoteId / source binding
   * Never title matching.
   */
  function findProgressRecordForChapter(series, chapter, records) {
    if (!chapter || !records || !records.length) return null;
    var localId = str(chapter.id);
    var best = null;
    var i;
    // Pass 1: exact local id
    for (i = 0; i < records.length; i++) {
      if (str(records[i].chapterId) === localId) {
        if (!best || records[i].updatedAt >= best.updatedAt) best = records[i];
      }
    }
    if (best) return best;

    // Pass 2: canonical chapter id
    var canon = str(chapter.canonicalChapterId);
    if (!canon && identity && typeof identity.getChapterIdentity === 'function') {
      try {
        var cid = identity.getChapterIdentity(chapter, series);
        if (cid && cid.canonicalChapterId) canon = str(cid.canonicalChapterId);
      } catch (e) {}
    }
    if (canon) {
      for (i = 0; i < records.length; i++) {
        if (str(records[i].canonicalChapterId) === canon) {
          if (!best || records[i].updatedAt >= best.updatedAt) best = records[i];
        }
      }
      if (best) return best;
    }

    // Pass 3: remoteId
    var remote = str(chapter.remoteId);
    if (remote) {
      for (i = 0; i < records.length; i++) {
        if (str(records[i].remoteId) === remote) {
          if (!best || records[i].updatedAt >= best.updatedAt) best = records[i];
        }
      }
    }
    return best;
  }

  function resolveExplicitChapterOpen(series, chapter, seriesProgress) {
    if (!chapter) {
      return { ok: false, pageIndex: 0, completed: false };
    }
    var records = collectRecords(series, seriesProgress);
    var rec = findProgressRecordForChapter(series, chapter, records);
    var pageCount = (rec && rec.pageCount) ||
      (chapter.pages && chapter.pages.length) ||
      (chapter._normalizedPages && chapter._normalizedPages.length) || 0;
    var pageIndex = 0;
    if (rec) {
      if (progress && typeof progress.getResumePage === 'function') {
        pageIndex = progress.getResumePage({
          seriesId: str(series && series.id),
          chapterId: str(chapter.id),
          pageIndex: rec.pageIndex,
          pageCount: pageCount || rec.pageCount,
          completed: rec.completed,
          updatedAt: rec.updatedAt || 1,
          scope: 'local',
          scopeId: 'default'
        });
      } else if (rec.completed && pageCount > 0 && rec.pageIndex >= pageCount - 1) {
        pageIndex = 0;
      } else {
        pageIndex = clampPage(rec.pageIndex, pageCount || rec.pageIndex + 1);
      }
    }
    return {
      ok: true,
      seriesId: str(series && series.id),
      chapterId: str(chapter.id),
      chapter: chapter,
      pageIndex: pageIndex,
      pageCount: pageCount,
      completed: !!(rec && rec.completed),
      record: rec,
      matchedBy: rec
        ? (str(rec.chapterId) === str(chapter.id)
          ? 'localId'
          : (str(rec.canonicalChapterId) && str(rec.canonicalChapterId) === str(chapter.canonicalChapterId)
            ? 'canonical'
            : 'remote'))
        : null
    };
  }

  /**
   * Build seriesProgress map from legacy state.progress[seriesId] + optional per-chapter store snapshot.
   */
  function mergeProgressSources(legacyEntry, chapterMap) {
    var map = {};
    if (isObj(chapterMap)) {
      Object.keys(chapterMap).forEach(function (k) {
        map[k] = chapterMap[k];
      });
    }
    if (isObj(legacyEntry) && legacyEntry.chapterId) {
      var cid = str(legacyEntry.chapterId);
      if (!map[cid]) {
        map[cid] = {
          chapterId: cid,
          pageIndex: legacyEntry.pageIndex,
          pageCount: legacyEntry.pageCount,
          updatedAt: legacyEntry.updatedAt,
          completed: legacyEntry.completed === true
        };
      }
    }
    return map;
  }

  return {
    normalizeContinuityRecord: normalizeContinuityRecord,
    collectRecords: collectRecords,
    pickLatestRecord: pickLatestRecord,
    getNextUnreadChapter: getNextUnreadChapter,
    resolveSeriesContinuity: resolveSeriesContinuity,
    resolveExplicitChapterOpen: resolveExplicitChapterOpen,
    findProgressRecordForChapter: findProgressRecordForChapter,
    mergeProgressSources: mergeProgressSources,
    clampPage: clampPage,
    findChapterByIdentity: findChapterByIdentity,
    orderedChapters: orderedChapters
  };
});
