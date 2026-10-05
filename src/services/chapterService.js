'use strict';
/**
 * MangaHive Phase 1 / Stage 4 — Chapter fetch service.
 *
 * Orchestrates chapter discovery for a series without owning network code.
 * Callers inject source fetch functions (adapters). Results are normalized
 * through MangaHiveDomain.chapterSystem.
 *
 * getChapters(series, options) → Promise<assembleChapterList result>
 *
 * options:
 *   fetchers: [{ sourceId, fetch(series, ctx) → Promise<{ chapters, hasMore?, nextCursor?, error? }> }]
 *   seriesProgress
 *   direction: 'asc' | 'desc'
 *   existingChapters
 *   signal: AbortSignal
 *   requestToken: number (stale-response guard)
 *
 * Loading: classic <script> (MangaHiveServices.chapterService) and CommonJS.
 */
(function (root, factory) {
  var chapterSystem = (typeof require === 'function' && typeof module === 'object' && module && module.exports)
    ? require('../domain/chapterSystem.js')
    : (root.MangaHiveDomain && root.MangaHiveDomain.chapterSystem);
  var api = factory(chapterSystem);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.MangaHiveServices = root.MangaHiveServices || {};
  root.MangaHiveServices.chapterService = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function (chapterSystem) {
  if (!chapterSystem) throw new Error('MangaHiveDomain.chapterSystem must be loaded before chapterService');

  var activeTokens = Object.create(null);

  function str(v) {
    return v == null ? '' : String(v).trim();
  }

  function isObj(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function seriesKey(series) {
    return str(series && (series.id || series.canonicalId)) || '_';
  }

  /**
   * Fetch chapters from injected source fetchers, assemble via chapterSystem.
   * Isolates source failures (partial success).
   */
  function getChapters(series, options) {
    options = options || {};
    if (!isObj(series)) {
      return Promise.resolve({
        chapters: [],
        continue: { kind: 'empty', label: 'No chapters available', chapterId: null, chapter: null },
        sourceResults: [],
        status: 'error',
        total: 0,
        error: 'invalid_series'
      });
    }

    var token = options.requestToken != null ? options.requestToken : Date.now();
    var key = seriesKey(series);
    activeTokens[key] = token;

    var fetchers = Array.isArray(options.fetchers) ? options.fetchers : [];
    var signal = options.signal || null;

    if (!fetchers.length) {
      // No network — assemble from existing only
      var localOnly = chapterSystem.assembleChapterList(series, [], {
        seriesProgress: options.seriesProgress,
        direction: options.direction,
        existingChapters: options.existingChapters || series.chapters
      });
      localOnly.requestToken = token;
      return Promise.resolve(localOnly);
    }

    var ctx = { signal: signal, series: series };

    var jobs = fetchers.map(function (f) {
      var sourceId = str(f && f.sourceId) || 'unknown';
      if (!f || typeof f.fetch !== 'function') {
        return Promise.resolve({
          sourceId: sourceId,
          chapters: [],
          error: 'no_fetcher'
        });
      }
      return Promise.resolve()
        .then(function () { return f.fetch(series, ctx); })
        .then(function (res) {
          if (signal && signal.aborted) {
            var e = new Error('AbortError');
            e.name = 'AbortError';
            throw e;
          }
          if (!isObj(res)) {
            return { sourceId: sourceId, chapters: [], error: 'invalid_response' };
          }
          if (res.error) {
            return {
              sourceId: sourceId,
              chapters: [],
              error: str(res.error) || 'error'
            };
          }
          return {
            sourceId: sourceId,
            chapters: Array.isArray(res.chapters) ? res.chapters : [],
            hasMore: !!res.hasMore,
            nextCursor: res.nextCursor != null ? res.nextCursor : null,
            partial: !!res.partial
          };
        })
        .catch(function (err) {
          if (err && (err.name === 'AbortError' || err.cancelled)) {
            return { sourceId: sourceId, chapters: [], error: 'aborted' };
          }
          return {
            sourceId: sourceId,
            chapters: [],
            error: (err && err.message) ? str(err.message) : 'fetch_failed'
          };
        });
    });

    return Promise.all(jobs).then(function (batches) {
      // Stale token: newer request started for this series
      if (activeTokens[key] !== token) {
        return {
          chapters: [],
          continue: { kind: 'empty', label: 'No chapters available', chapterId: null, chapter: null },
          sourceResults: [],
          status: 'stale',
          total: 0,
          requestToken: token,
          stale: true
        };
      }
      var result = chapterSystem.assembleChapterList(series, batches, {
        seriesProgress: options.seriesProgress,
        direction: options.direction,
        existingChapters: options.existingChapters || series.chapters
      });
      result.requestToken = token;
      result.stale = false;
      return result;
    });
  }

  /** Cancel in-flight tracking for a series (optional helper). */
  function invalidate(series) {
    var key = seriesKey(series);
    activeTokens[key] = -1;
  }

  return {
    getChapters: getChapters,
    invalidate: invalidate
  };
});
