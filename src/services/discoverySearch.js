'use strict';
/**
 * Phase 1 / Stage 2 — Discovery & Search service.
 *
 * Orchestrates search over a SOURCE REGISTRY (injected; the app wires its existing registry in).
 * The UI never fans out to adapters itself. Responsibilities: validate/normalize the query,
 * resolve enabled+available search-capable sources, run them with AbortSignal + per-source
 * timeout, reject stale responses (monotonic token), normalize + dedupe + rank deterministically,
 * keep per-source continuation (real pagination only), and report per-source health so partial
 * failure never destroys successful results.
 *
 * Search state is TRANSIENT and in-memory only. Nothing here reads or writes the Library.
 * Importing is a separate, explicit action (addToLibrary) that goes through injected library deps.
 *
 * Registry contract (duck-typed):
 *   listSearchSources() -> [{ id, name, kind, priority, reader, enabled, available, unavailableReason,
 *                             paginates }]       (any order; the service sorts by priority)
 *   getAdapter(id)      -> { search(query, { page, limit, signal }) -> Promise<Array | {results, hasMore}> } | null
 *   resolveExtensionId(sourceId) -> string        (optional)
 *
 * Loading: classic <script> (MangaHiveServices.discoverySearch) and CommonJS (tests).
 */
(function (root, factory) {
  var sr = (typeof require === 'function' && typeof module === 'object' && module && module.exports)
    ? require('../domain/searchResult.js')
    : (root.MangaHiveDomain && root.MangaHiveDomain.searchResult);
  var api = factory(sr);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.MangaHiveServices = root.MangaHiveServices || {};
  root.MangaHiveServices.discoverySearch = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function (sr) {
  var DEFAULT_LIMITS = {
    maxQueryLength: 120,
    minQueryLength: 1,
    perSourceLimit: 20,      // rows requested per source per page
    maxPages: 5,             // pages per source per query (continuation stops here, and says so)
    maxResults: 200,         // total rows held for one query (stops here, and says so)
    maxSources: 8,           // concurrent sources per request
    sourceTimeoutMs: 12000
  };

  function normalizeQuery(q) {
    return String(q == null ? '' : q).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /** Error classes: 'aborted' | 'timeout' | 'offline' | 'error'. */
  function classifyError(err, online) {
    if (err && (err.name === 'AbortError' || err.code === 'ABORTED' || err.userCancelled)) return 'aborted';
    if (err && (err.code === 'TIMEOUT' || err.name === 'TimeoutError' || /timed? ?out/i.test(String(err && err.message)))) return 'timeout';
    if (online === false) return 'offline';
    var m = String((err && err.message) || err || '');
    if (/failed to fetch|networkerror|network request failed|load failed|offline|ERR_INTERNET|ENOTFOUND|ECONNREFUSED/i.test(m)) return 'offline';
    return 'error';
  }

  function timeoutError() { var e = new Error('source timed out'); e.code = 'TIMEOUT'; return e; }
  function abortError() { var e = new Error('aborted'); e.name = 'AbortError'; e.code = 'ABORTED'; return e; }

  function newController() { return (typeof AbortController !== 'undefined') ? new AbortController() : null; }

  /** Relevance of a title to the query: 0 exact, 1 prefix, 2 contains, 3 other (deterministic, no I/O). */
  function relevance(result, qKey) {
    if (!qKey) return 3;
    var t = sr.titleKey(result.title);
    if (t === qKey) return 0;
    if (t.indexOf(qKey) === 0) return 1;
    if (t.indexOf(qKey) >= 0) return 2;
    for (var i = 0; i < result.alternateTitles.length; i++) {
      var a = sr.titleKey(result.alternateTitles[i]);
      if (a === qKey) return 1;
      if (a.indexOf(qKey) >= 0) return 2;
    }
    return 3;
  }

  /** Library index: Map(sourceBindingKey -> series) built once per lookup batch (O(N), not O(N*M)). */
  function buildLibraryIndex(seriesList, identity, options) {
    var map = new Map();
    (seriesList || []).forEach(function (s) {
      var ident = identity.getSeriesIdentity(s, options);
      for (var i = 0; i < ident.sources.length; i++) {
        if (!map.has(ident.sources[i].bindingKey)) map.set(ident.sources[i].bindingKey, s);
      }
    });
    return map;
  }

  /** Library match for a result: exact binding match on its own binding or any merged alias. */
  function matchLibrary(result, index) {
    if (!result || !index) return null;
    var hit = index.get(result.sourceBindingKey);
    if (hit) return hit;
    var also = result.alsoFrom || [];
    for (var i = 0; i < also.length; i++) { hit = index.get(also[i].sourceBindingKey); if (hit) return hit; }
    return null;
  }

  function debounce(fn, ms, timers) {
    timers = timers || { set: setTimeout, clear: clearTimeout };
    var h = null;
    function d() { var args = arguments; if (h != null) timers.clear(h); h = timers.set(function () { h = null; fn.apply(null, args); }, ms); }
    d.cancel = function () { if (h != null) { timers.clear(h); h = null; } };
    d.pending = function () { return h != null; };
    return d;
  }

  function createDiscoverySearch(deps) {
    deps = deps || {};
    var registry = deps.registry;
    if (!registry || typeof registry.listSearchSources !== 'function' || typeof registry.getAdapter !== 'function') {
      throw new Error('discoverySearch: a source registry is required');
    }
    var limits = Object.assign({}, DEFAULT_LIMITS, deps.limits || {});
    var now = deps.now || function () { return Date.now(); };
    var isOnline = deps.isOnline || function () { return true; };
    var setT = deps.setTimeout || setTimeout, clearT = deps.clearTimeout || clearTimeout;

    var seq = 0;                 // monotonic request token
    var activeCtl = null;        // controller for the in-flight request
    var inflight = null;         // { kind, token, promise }
    var listeners = [];
    var byId = new Map();        // resultId -> result (current query only)
    var byTitle = new Map();     // titleKey -> [result] (cross-source strong-match index)
    var cursors = Object.create(null); // sourceId -> { page, hasMore, paginates, pages }

    var state = freshState('');
    function freshState(q) {
      return {
        query: q, status: 'idle', reason: 'empty-query', results: [], sourceStatuses: [],
        page: 0, hasMore: false, capped: false, partial: false, loadingMore: false, loadMoreError: null,
        error: null, requestToken: seq, selectedResultId: null, previewOpen: false
      };
    }
    function snapshot() {
      return Object.assign({}, state, { results: state.results.slice(), sourceStatuses: state.sourceStatuses.map(function (x) { return Object.assign({}, x); }) });
    }
    function emit() { var s = snapshot(); listeners.slice().forEach(function (fn) { try { fn(s); } catch (e) { /* listener faults never break search */ } }); }
    function set(patch) { Object.assign(state, patch); emit(); }
    function resetIndexes() { byId = new Map(); byTitle = new Map(); cursors = Object.create(null); }

    function sourcesFor(options) {
      var all = [];
      try { all = registry.listSearchSources() || []; } catch (e) { all = []; }
      var want = options && Array.isArray(options.sources) && options.sources.length ? new Set(options.sources.map(String)) : null;
      var enabled = all.filter(function (s) { return s && s.id && s.enabled !== false && (!want || want.has(String(s.id))); });
      enabled.sort(function (a, b) {
        var pa = a.priority != null ? a.priority : 100, pb = b.priority != null ? b.priority : 100;
        return pa !== pb ? pa - pb : String(a.id).localeCompare(String(b.id));
      });
      return enabled;
    }

    function callSource(src, query, page, outerSignal, token) {
      var started = now();
      var adapter = null;
      try { adapter = registry.getAdapter(src.id); } catch (e) { adapter = null; }
      var base = { sourceId: String(src.id), name: src.name || String(src.id), page: page, paginates: !!src.paginates, hasMore: false, count: 0, rows: [], error: null, latencyMs: 0 };
      if (!adapter || typeof adapter.search !== 'function') {
        return Promise.resolve(Object.assign(base, { state: 'unavailable', error: 'no-adapter' }));
      }
      var ctl = newController();
      var timer = null, settled = false;
      function link() { if (ctl) { try { ctl.abort(); } catch (e) { /* ignore */ } } }
      if (outerSignal) { if (outerSignal.aborted) link(); else outerSignal.addEventListener('abort', link); }
      return new Promise(function (resolve) {
        function done(patch) {
          if (settled) return; settled = true;
          if (timer != null) clearT(timer);
          if (outerSignal && outerSignal.removeEventListener) outerSignal.removeEventListener('abort', link);
          resolve(Object.assign(base, { latencyMs: Math.max(0, now() - started) }, patch));
        }
        timer = setT(function () { link(); done({ state: 'timeout', error: 'timeout' }); }, limits.sourceTimeoutMs);
        if (outerSignal && outerSignal.aborted) { done({ state: 'aborted', error: 'aborted' }); return; }
        var p;
        try { p = Promise.resolve(adapter.search(query, { page: page, limit: limits.perSourceLimit, signal: ctl ? ctl.signal : outerSignal })); }
        catch (e) { p = Promise.reject(e); }
        p.then(function (out) {
          var rows = Array.isArray(out) ? out : (out && Array.isArray(out.results) ? out.results : []);
          var more = !Array.isArray(out) && out && typeof out.hasMore === 'boolean' ? out.hasMore : null;
          if (more == null) more = false; // an adapter that does not report continuation has none (no guessing)
          done({ state: rows.length ? 'ok' : 'empty', rows: rows, count: rows.length, hasMore: !!src.paginates && more });
        }, function (err) {
          var cls = classifyError(err, isOnline());
          done({ state: cls, error: String((err && err.message) || err || 'error').slice(0, 160) });
        });
      });
    }

    /** Merge normalized rows into the current result set (append-only for pages > 1). */
    function mergeRows(rowsBySource, qKey, firstPage) {
      var fresh = [];
      rowsBySource.forEach(function (entry) {
        var src = entry.src;
        entry.rows.forEach(function (raw) {
          var r = sr.normalizeSearchResult(raw, {
            sourceId: src.id, fetchedAt: now(),
            resolveExtensionId: registry.resolveExtensionId ? registry.resolveExtensionId.bind(registry) : undefined,
            sourceMeta: { name: src.name, kind: src.kind, reader: !!src.reader }
          });
          if (!r) return;
          r._priority = src.priority != null ? src.priority : 100;
          r._reader = !!src.reader;
          if (byId.has(r.resultId)) return;                       // same source+remote: exact duplicate
          var tk = sr.titleKey(r.title), group = tk ? byTitle.get(tk) : null, merged = false;
          if (group) {
            for (var i = 0; i < group.length; i++) {
              if (sr.strongSameWork(group[i], r)) {
                (group[i].alsoFrom = group[i].alsoFrom || []).push({ sourceId: r.sourceId, remoteId: r.remoteId, extensionId: r.extensionId, canonicalSeriesId: r.canonicalSeriesId, sourceBindingKey: r.sourceBindingKey });
                byId.set(r.resultId, group[i]);
                merged = true; break;
              }
            }
          }
          if (merged) return;
          byId.set(r.resultId, r);
          if (tk) { if (!group) byTitle.set(tk, [r]); else group.push(r); }
          fresh.push(r);
        });
      });
      fresh.sort(function (a, b) {
        if (a._reader !== b._reader) return a._reader ? -1 : 1;
        var ra = relevance(a, qKey), rb = relevance(b, qKey);
        if (ra !== rb) return ra - rb;
        if (a._priority !== b._priority) return a._priority - b._priority;
        var t = a.title.localeCompare(b.title);
        return t !== 0 ? t : (a.canonicalSeriesId < b.canonicalSeriesId ? -1 : (a.canonicalSeriesId > b.canonicalSeriesId ? 1 : 0));
      });
      return fresh;
    }

    function statusFrom(results, statuses, queriedCount) {
      var failed = statuses.filter(function (s) { return s.state === 'timeout' || s.state === 'error' || s.state === 'offline'; });
      var okSources = statuses.filter(function (s) { return s.state === 'ok' || s.state === 'empty'; });
      if (results.length) return { status: 'ok', partial: failed.length > 0 };
      if (okSources.length) return { status: 'empty', partial: failed.length > 0 };
      if (!queriedCount) return { status: 'error', partial: false, reason: 'no-sources' };
      var allOffline = failed.length && failed.every(function (s) { return s.state === 'offline'; });
      return { status: allOffline || isOnline() === false ? 'offline' : 'error', partial: false, reason: 'all-failed' };
    }

    /** Core runner for a fresh search (page 1) or a continuation (loadMore). */
    function run(kind, query, options) {
      options = options || {};
      var token = ++seq;
      if (activeCtl) { try { activeCtl.abort(); } catch (e) { /* ignore */ } }
      activeCtl = newController();
      var ctl = activeCtl;
      if (options.signal) { if (options.signal.aborted) { if (ctl) ctl.abort(); } else options.signal.addEventListener('abort', function () { if (ctl) { try { ctl.abort(); } catch (e) { /* ignore */ } } }); }
      var signal = ctl ? ctl.signal : options.signal;
      var qKey = sr.titleKey(query);
      var firstPage = kind === 'search';

      if (firstPage) {
        resetIndexes();
        state = Object.assign(freshState(query), { status: 'loading', reason: null, requestToken: token, selectedResultId: null, previewOpen: false });
        state.results = [];
        emit();
      } else {
        Object.assign(state, { loadingMore: true, loadMoreError: null, requestToken: token });
        emit();
      }

      var srcs = sourcesFor(options);
      var targets = [], statuses = [];
      srcs.forEach(function (s) {
        if (s.available === false) { statuses.push({ sourceId: String(s.id), name: s.name || String(s.id), state: 'unavailable', error: s.unavailableReason || 'unavailable', page: 0, paginates: !!s.paginates, hasMore: false, count: 0 }); return; }
        if (!firstPage) {
          var c = cursors[s.id];
          if (!c || !c.hasMore) return;
        }
        targets.push(s);
      });
      var skipped = targets.slice(limits.maxSources);
      targets = targets.slice(0, limits.maxSources);
      skipped.forEach(function (s) { statuses.push({ sourceId: String(s.id), name: s.name || String(s.id), state: 'unavailable', error: 'source-limit', page: 0, paginates: !!s.paginates, hasMore: false, count: 0 }); });

      if (firstPage && isOnline() === false) {
        state.requestToken = token;
        Object.assign(state, { status: 'offline', reason: 'offline', sourceStatuses: statuses, error: 'offline' });
        emit();
        return Promise.resolve(response(token, false));
      }

      var jobs = targets.map(function (s) {
        var page = firstPage ? 1 : (cursors[s.id].page + 1);
        return callSource(s, query, page, signal, token).then(function (res) { return { src: s, res: res }; });
      });

      return Promise.all(jobs).then(function (done) {
        if (token !== seq) return response(token, true);        // stale: a newer request owns the state
        var rowsBySource = [];
        done.forEach(function (d) {
          var res = d.res, id = d.src.id;
          var prev = cursors[id] || { page: 0, hasMore: false, pages: 0 };
          if (res.state === 'aborted') { statuses.push(publicStatus(res)); return; }
          if (res.state === 'ok' || res.state === 'empty') {
            var pages = prev.pages + 1;
            var more = res.hasMore && pages < limits.maxPages;
            cursors[id] = { page: res.page, hasMore: more, paginates: !!d.src.paginates, pages: pages, hitPageCap: res.hasMore && !more };
            rowsBySource.push({ src: d.src, rows: res.rows });
          } else if (!firstPage) {
            cursors[id] = prev; // failed continuation: keep the cursor so retry asks for the SAME page
          } else {
            cursors[id] = { page: 0, hasMore: false, paginates: !!d.src.paginates, pages: 0 };
          }
          statuses.push(publicStatus(res, cursors[id]));
        });
        if (done.length && done.every(function (d) { return d.res.state === 'aborted'; })) return response(token, true);

        var fresh = mergeRows(rowsBySource, qKey, firstPage);
        var room = limits.maxResults - state.results.length, capped = false;
        if (fresh.length > room) { fresh = fresh.slice(0, Math.max(0, room)); capped = true; }
        var results = state.results.concat(fresh);
        if (results.length >= limits.maxResults) capped = capped || Object.keys(cursors).some(function (k) { return cursors[k].hasMore; });
        var hasMore = !capped && Object.keys(cursors).some(function (k) { return cursors[k].hasMore; });

        if (firstPage) {
          var st = statusFrom(results, statuses, targets.length);
          Object.assign(state, { results: results, sourceStatuses: sortStatuses(statuses), status: st.status, reason: st.reason || null, partial: st.partial, page: 1, hasMore: hasMore, capped: capped, error: st.status === 'error' || st.status === 'offline' ? (st.reason || 'failed') : null });
        } else {
          var failedMore = done.some(function (d) { return d.res.state === 'timeout' || d.res.state === 'error' || d.res.state === 'offline'; });
          var merged = mergeStatuses(state.sourceStatuses, statuses);
          Object.assign(state, { results: results, sourceStatuses: merged, page: state.page + 1, hasMore: hasMore || (failedMore && Object.keys(cursors).some(function (k) { return cursors[k].hasMore; })), capped: capped, loadingMore: false, loadMoreError: failedMore ? 'partial-failure' : null, partial: state.partial || failedMore });
        }
        state.loadingMore = false;
        emit();
        return response(token, false);
      }).catch(function (err) {
        // Defensive: the runner itself must never reject into the UI.
        if (token !== seq) return response(token, true);
        var cls = classifyError(err, isOnline());
        if (firstPage) Object.assign(state, { status: cls === 'offline' ? 'offline' : 'error', reason: 'internal', error: String((err && err.message) || err).slice(0, 160) });
        else Object.assign(state, { loadingMore: false, loadMoreError: cls });
        emit();
        return response(token, false);
      });
    }

    function publicStatus(res, cur) {
      return { sourceId: res.sourceId, name: res.name, state: res.state, error: res.error, page: res.page, paginates: res.paginates, hasMore: !!(cur && cur.hasMore), count: res.count, latencyMs: res.latencyMs };
    }
    function sortStatuses(list) { return list.slice().sort(function (a, b) { return a.sourceId < b.sourceId ? -1 : (a.sourceId > b.sourceId ? 1 : 0); }); }
    function mergeStatuses(oldList, newList) {
      var m = new Map(); oldList.forEach(function (s) { m.set(s.sourceId, s); });
      newList.forEach(function (s) { var o = m.get(s.sourceId); m.set(s.sourceId, Object.assign({}, s, { count: (o ? o.count : 0) + (s.state === 'ok' || s.state === 'empty' ? s.count : 0), state: (s.state === 'ok' || s.state === 'empty') ? (o && o.state === 'ok' ? 'ok' : s.state) : s.state })); });
      return sortStatuses(Array.from(m.values()));
    }
    function response(token, stale) {
      var s = snapshot();
      s.stale = !!stale; s.token = token;
      return s;
    }

    /** Public: search(query, options). Empty/invalid queries never reach a source. */
    function search(query, options) {
      var q = normalizeQuery(query);
      if (!q) {
        invalidate();
        state = Object.assign(freshState(''), { status: 'idle', reason: 'empty-query', requestToken: seq });
        emit();
        return Promise.resolve(response(seq, false));
      }
      if (q.length < limits.minQueryLength || q.length > limits.maxQueryLength) {
        invalidate();
        state = Object.assign(freshState(q.slice(0, limits.maxQueryLength)), { status: 'invalid', reason: 'invalid-query', error: 'invalid-query', requestToken: seq });
        emit();
        return Promise.resolve(response(seq, false));
      }
      var p = run('search', q, options);
      inflight = { kind: 'search', token: seq, promise: p };
      return p;
    }

    /** Cancels whatever is in flight and makes its result stale. */
    function invalidate() {
      seq++;
      if (activeCtl) { try { activeCtl.abort(); } catch (e) { /* ignore */ } activeCtl = null; }
      inflight = null;
    }

    function loadMore() {
      if (state.status !== 'ok' || !state.hasMore) return Promise.resolve(Object.assign(response(seq, false), { noop: true }));
      if (state.loadingMore && inflight && inflight.kind === 'more') return inflight.promise; // duplicate page request guard
      var p = run('more', state.query, {});
      inflight = { kind: 'more', token: seq, promise: p };
      return p;
    }

    function retry() {
      if (state.status === 'ok' && state.loadMoreError) { state.loadMoreError = null; return loadMore(); }
      if (!state.query) return search('');
      return search(state.query);
    }

    function clear() { invalidate(); resetIndexes(); state = Object.assign(freshState(''), { requestToken: seq }); emit(); }

    function select(resultId) {
      var r = byId.get(resultId);
      if (!r) return null;
      Object.assign(state, { selectedResultId: r.resultId, previewOpen: true });
      emit();
      return r;
    }
    function closePreview() { Object.assign(state, { previewOpen: false }); emit(); }
    /** Resolve any displayed (or merged-alias) result by id – used by route-driven preview. */
    function getResult(resultId) { return byId.get(resultId) || null; }

    /**
     * Explicit import. deps.library: { find(result) -> series|null, importResult(result) -> Promise<series> }.
     * Idempotent: an existing match (or an in-flight import of the same canonical id) short-circuits
     * and NEVER re-imports, so reading progress on an existing series is untouched.
     */
    var importing = new Map();
    function addToLibrary(result, lib) {
      if (!result || !result.canonicalSeriesId || !lib || typeof lib.find !== 'function' || typeof lib.importResult !== 'function') {
        return Promise.resolve({ status: 'error', error: 'invalid-request' });
      }
      var existing = lib.find(result);
      if (existing) return Promise.resolve({ status: 'already', series: existing });
      var key = result.canonicalSeriesId;
      if (importing.has(key)) return importing.get(key);
      var p = Promise.resolve().then(function () { return lib.importResult(result); }).then(function (series) {
        importing.delete(key);
        return series ? { status: 'added', series: series } : { status: 'error', error: 'import-failed' };
      }, function (err) {
        importing.delete(key);
        return { status: 'error', error: String((err && err.message) || err || 'import-failed').slice(0, 160) };
      });
      importing.set(key, p);
      return p;
    }

    return {
      search: search, loadMore: loadMore, retry: retry, clear: clear, invalidate: invalidate,
      select: select, closePreview: closePreview, getResult: getResult, addToLibrary: addToLibrary,
      getState: snapshot,
      subscribe: function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (x) { return x !== fn; }); }; },
      limits: limits
    };
  }

  return {
    DEFAULT_LIMITS: DEFAULT_LIMITS,
    normalizeQuery: normalizeQuery,
    classifyError: classifyError,
    relevance: relevance,
    buildLibraryIndex: buildLibraryIndex,
    matchLibrary: matchLibrary,
    debounce: debounce,
    createDiscoverySearch: createDiscoverySearch
  };
});
