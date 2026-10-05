/**
 * MangaHive Phase 1 / Stage 1 — Reader session contract (pure domain module).
 *
 * A reader session is the ephemeral, in-memory description of ONE chapter being read:
 *
 *   { sessionId, series:{id,canonicalId}, chapter:{id,canonicalChapterId},
 *     pageCount, currentPage, maxPage, mode, direction,
 *     loading, error, completed, completedAt, status }
 *
 * THE READER DOES NOT OWN PERSISTENT DOMAIN STATE. A session:
 *   - holds identity SNAPSHOTS (ids), never the series/chapter objects, so it cannot mutate them;
 *   - never writes IndexedDB / storage, never touches the library, Supabase or the network;
 *   - never edits persisted progress. It only EMITS events; whoever owns persistence decides
 *     what to do with them:
 *
 *        Reader UI → Reader Session → Progress Event → Progress Store
 *
 * Every operation is pure and returns `{ session, events }`. Sessions are frozen and
 * independent: operating on one never affects another (session isolation).
 * Stage 1 establishes this contract only; the existing reader UI is not rewritten.
 */
(function (root, factory) {
  var identity = (typeof require === 'function' && typeof module === 'object' && module && module.exports)
    ? require('./identity.js')
    : (root.MangaHiveDomain && root.MangaHiveDomain.identity);
  var progress = (typeof require === 'function' && typeof module === 'object' && module && module.exports)
    ? require('./progress.js')
    : (root.MangaHiveDomain && root.MangaHiveDomain.progress);
  var api = factory(identity, progress);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.MangaHiveDomain = root.MangaHiveDomain || {};
  root.MangaHiveDomain.readerSession = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function (identity, progress) {
  'use strict';

  if (!identity || !progress) throw new Error('MangaHiveDomain.identity/progress must be loaded before readerSession');

  var MODES = ['webtoon', 'paged'];
  var DIRECTIONS = ['ltr', 'rtl', 'ttb'];
  var sessionCounter = 0;

  function nextSessionId() { sessionCounter += 1; return 'rs-' + sessionCounter; }
  function clock(now) { return (typeof now === 'number' && isFinite(now)) ? now : Date.now(); }
  function toCount(v) { var n = Math.floor(Number(v)); return (isFinite(n) && n > 0) ? n : 0; }
  function freeze(o) { return Object.freeze(o); }

  function deriveStatus(s) {
    if (s.error) return 'error';
    if (s.loading) return 'loading';
    if (s.completed) return 'completed';
    return 'ready';
  }

  function build(fields) {
    var s = Object.assign({}, fields);
    s.status = deriveStatus(s);
    return freeze(s);
  }

  function evt(session, type, extra) {
    return Object.assign({
      type: type,
      sessionId: session.sessionId,
      seriesId: session.series.id,
      canonicalSeriesId: session.series.canonicalId,
      chapterId: session.chapter.id,
      canonicalChapterId: session.chapter.canonicalChapterId,
      pageIndex: session.currentPage,
      pageCount: session.pageCount
    }, extra || {});
  }

  /**
   * createReaderSession({ series, chapter, pageCount?, currentPage?, mode?, direction?, sessionId?, loading? })
   * A missing/unusable chapter yields a session in the 'error' state (CHAPTER_MISSING) rather than throwing.
   */
  function createReaderSession(input) {
    var p = identity.isObj(input) ? input : {};
    var series = identity.isObj(p.series) ? p.series : null;
    var chapter = identity.isObj(p.chapter) ? p.chapter : null;
    var sid = identity.getSeriesIdentity(series);
    var cid = identity.getChapterIdentity(chapter, series);
    var pageCount = toCount(p.pageCount != null ? p.pageCount : (chapter && Array.isArray(chapter.pages) ? chapter.pages.length : 0));
    var mode = MODES.indexOf(p.mode) >= 0 ? p.mode : 'webtoon';
    var direction = DIRECTIONS.indexOf(p.direction) >= 0 ? p.direction : (mode === 'paged' ? 'rtl' : 'ttb');
    var page = progress.clampPage(p.currentPage, pageCount);
    var error = null;
    if (!cid.localId) error = freeze({ code: 'CHAPTER_MISSING', message: 'No usable chapter was provided' });
    else if (!sid.localId) error = freeze({ code: 'SERIES_MISSING', message: 'No usable series was provided' });
    return build({
      sessionId: identity.str(p.sessionId) || nextSessionId(),
      series: freeze({ id: sid.localId, canonicalId: sid.canonicalId }),
      chapter: freeze({ id: cid.localId, canonicalChapterId: (cid.confidence === 'existing' || cid.confidence === 'structured' || cid.confidence === 'remote') ? cid.canonicalChapterId : null }),
      pageCount: pageCount,
      currentPage: page,
      maxPage: page,
      mode: mode,
      direction: direction,
      loading: p.loading === true,
      error: error,
      completed: false,
      completedAt: null
    });
  }

  /** Jump to a page (clamped). Emits reader/page-changed only when the page actually changes. */
  function setPage(session, page) {
    if (!session || session.error) return { session: session, events: [] };
    var next = progress.clampPage(page, session.pageCount);
    if (next === session.currentPage) return { session: session, events: [] };
    var s = build(Object.assign({}, session, { currentPage: next, maxPage: Math.max(session.maxPage, next) }));
    return { session: s, events: [evt(s, 'reader/page-changed', { previousPage: session.currentPage })] };
  }

  /** Advance one page; at the last page emits a boundary event instead of moving. */
  function nextPage(session) {
    if (!session || session.error || session.pageCount <= 0) return { session: session, events: [] };
    if (session.currentPage >= session.pageCount - 1) return { session: session, events: [evt(session, 'reader/boundary', { edge: 'end' })] };
    return setPage(session, session.currentPage + 1);
  }

  /** Go back one page; at page 0 emits a boundary event instead of moving. */
  function previousPage(session) {
    if (!session || session.error || session.pageCount <= 0) return { session: session, events: [] };
    if (session.currentPage <= 0) return { session: session, events: [evt(session, 'reader/boundary', { edge: 'start' })] };
    return setPage(session, session.currentPage - 1);
  }

  /** Explicit completion (the session never decides this by itself). Idempotent. */
  function complete(session, options) {
    if (!session || session.error) return { session: session, events: [] };
    if (session.completed) return { session: session, events: [] };
    var now = clock(options && options.now);
    var last = session.pageCount > 0 ? session.pageCount - 1 : session.currentPage;
    var s = build(Object.assign({}, session, { completed: true, completedAt: now, currentPage: last, maxPage: Math.max(session.maxPage, last) }));
    return { session: s, events: [evt(s, 'reader/completed', { completedAt: now })] };
  }

  /** Re-read: clear completion/error, return to `options.page` (default 0). Same sessionId. */
  function reset(session, options) {
    if (!session) return { session: session, events: [] };
    var page = progress.clampPage(options && options.page, session.pageCount);
    var s = build(Object.assign({}, session, { completed: false, completedAt: null, error: null, loading: false, currentPage: page, maxPage: page }));
    return { session: s, events: [evt(s, 'reader/reset')] };
  }

  function setLoading(session, loading) {
    if (!session) return { session: session, events: [] };
    var s = build(Object.assign({}, session, { loading: loading === true }));
    return { session: s, events: [evt(s, 'reader/loading', { loading: s.loading })] };
  }

  function setError(session, error) {
    if (!session) return { session: session, events: [] };
    var e = identity.isObj(error)
      ? freeze({ code: identity.str(error.code) || 'READER_ERROR', message: identity.str(error.message) || 'Reader error' })
      : (error ? freeze({ code: 'READER_ERROR', message: identity.str(error) || 'Reader error' }) : null);
    var s = build(Object.assign({}, session, { error: e, loading: false }));
    return { session: s, events: [evt(s, 'reader/error', { error: e })] };
  }

  /** Pages resolved after creation (loading → ready). Re-clamps the current page. */
  function setPageCount(session, pageCount) {
    if (!session) return { session: session, events: [] };
    var n = toCount(pageCount);
    var page = progress.clampPage(session.currentPage, n);
    var s = build(Object.assign({}, session, { pageCount: n, currentPage: page, maxPage: Math.min(session.maxPage, n > 0 ? n - 1 : session.maxPage), loading: false }));
    return { session: s, events: [evt(s, 'reader/page-count', {})] };
  }

  /** The snapshot a progress consumer needs. Pure; carries no persistence handle. */
  function toProgressEvent(session) {
    if (!session) return null;
    return evt(session, 'reader/progress', { completed: session.completed, completedAt: session.completedAt });
  }

  return {
    createReaderSession: createReaderSession,
    setPage: setPage,
    nextPage: nextPage,
    previousPage: previousPage,
    complete: complete,
    reset: reset,
    setLoading: setLoading,
    setError: setError,
    setPageCount: setPageCount,
    toProgressEvent: toProgressEvent
  };
});
