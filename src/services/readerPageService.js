'use strict';
/**
 * MangaHive Phase 1 / Stage 5 — Reader page load service.
 *
 * Boundary: Reader → readerPageService → injected page fetcher (adapter) → normalized pages.
 * Does not hard-code providers. Stale-request safe via requestToken / AbortSignal.
 *
 * Loading: MangaHiveServices.readerPageService / CommonJS.
 */
(function (root, factory) {
  var readerPages = (typeof require === 'function' && typeof module === 'object' && module && module.exports)
    ? require('../domain/readerPages.js')
    : (root.MangaHiveDomain && root.MangaHiveDomain.readerPages);
  var api = factory(readerPages);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.MangaHiveServices = root.MangaHiveServices || {};
  root.MangaHiveServices.readerPageService = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function (readerPages) {
  if (!readerPages) throw new Error('MangaHiveDomain.readerPages must be loaded before readerPageService');

  var activeTokens = Object.create(null);

  function str(v) { return v == null ? '' : String(v).trim(); }
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

  function chapterKey(seriesId, chapterId) {
    return str(seriesId) + '\u001f' + str(chapterId);
  }

  /**
   * Load and normalize pages for a chapter.
   *
   * @param {object} input
   * @param {string} input.seriesId
   * @param {string} input.chapterId
   * @param {string} [input.canonicalChapterId]
   * @param {function} input.fetchPages - () => Promise<raw pages array>
   * @param {number} [input.requestToken]
   * @param {AbortSignal} [input.signal]
   * @param {array} [input.existingPages] - already-held pages (skip network)
   */
  function loadChapterPages(input) {
    input = input || {};
    var seriesId = str(input.seriesId);
    var chapterId = str(input.chapterId);
    var token = input.requestToken != null ? input.requestToken : Date.now();
    var key = chapterKey(seriesId, chapterId);
    activeTokens[key] = token;

    var context = {
      chapterId: chapterId,
      canonicalChapterId: str(input.canonicalChapterId) || null
    };

    function finish(raw, meta) {
      if (activeTokens[key] !== token) {
        return {
          ok: false,
          stale: true,
          pages: [],
          usable: 0,
          error: 'stale',
          requestToken: token
        };
      }
      var pages = readerPages.normalizePageList(raw, context);
      var usable = readerPages.usableCount(pages);
      var empty = pages.length === 0 || usable === 0;
      return {
        ok: !empty,
        stale: false,
        pages: pages,
        legacyUrls: readerPages.toLegacyUrlList(pages),
        usable: usable,
        empty: empty,
        error: empty ? (meta && meta.error) || 'empty' : null,
        requestToken: token
      };
    }

    // Prefer existing in-memory pages when provided
    if (Array.isArray(input.existingPages) && input.existingPages.length) {
      return Promise.resolve(finish(input.existingPages, null));
    }

    if (typeof input.fetchPages !== 'function') {
      return Promise.resolve(finish([], { error: 'no_fetcher' }));
    }

    var signal = input.signal || null;
    return Promise.resolve()
      .then(function () {
        if (signal && signal.aborted) {
          var e = new Error('AbortError');
          e.name = 'AbortError';
          throw e;
        }
        return input.fetchPages();
      })
      .then(function (raw) {
        if (signal && signal.aborted) {
          var e2 = new Error('AbortError');
          e2.name = 'AbortError';
          throw e2;
        }
        if (!Array.isArray(raw)) {
          return finish([], { error: 'invalid_response' });
        }
        return finish(raw, null);
      })
      .catch(function (err) {
        if (activeTokens[key] !== token) {
          return {
            ok: false,
            stale: true,
            pages: [],
            usable: 0,
            error: 'stale',
            requestToken: token
          };
        }
        if (err && (err.name === 'AbortError' || err.cancelled)) {
          return {
            ok: false,
            stale: false,
            pages: [],
            usable: 0,
            error: 'aborted',
            requestToken: token
          };
        }
        return {
          ok: false,
          stale: false,
          pages: [],
          usable: 0,
          empty: true,
          error: (err && err.message) ? str(err.message) : 'fetch_failed',
          requestToken: token
        };
      });
  }

  function invalidate(seriesId, chapterId) {
    activeTokens[chapterKey(seriesId, chapterId)] = -1;
  }

  return {
    loadChapterPages: loadChapterPages,
    invalidate: invalidate
  };
});
