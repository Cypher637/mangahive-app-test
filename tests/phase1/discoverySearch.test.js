'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const identity = require('../../src/domain/identity.js');
const sr = require('../../src/domain/searchResult.js');
const ds = require('../../src/services/discoverySearch.js');
const libraryStore = require('../../src/services/libraryStore.js');
const { createMemoryStorage } = require('./helpers/memoryStorage.js');

/* ---------- fakes ---------- */
const row = (sourceId, remoteId, title, extra) => Object.assign({ sourceId, remoteId, title }, extra || {});
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

function mkRegistry(sources, behaviours, calls) {
  const list = sources.map((s) => Object.assign({ enabled: true, available: true, priority: 100, reader: true, paginates: false }, s));
  return {
    listSearchSources: () => list,
    getAdapter: (id) => (behaviours[id] ? { search: (q, o) => { (calls || []).push({ id, q, page: o.page, limit: o.limit, signal: o.signal }); return behaviours[id](q, o); } } : null)
  };
}
const mk = (sources, behaviours, extra) => {
  const calls = [];
  const svc = ds.createDiscoverySearch(Object.assign({ registry: mkRegistry(sources, behaviours, calls), now: () => 1000 }, extra || {}));
  return { svc, calls };
};

/* ---------- identity ---------- */
test('canonical identity is deterministic from source+remoteId, not title/cover/position', () => {
  const a = sr.normalizeSearchResult(row('mangadex', 'abc', 'Naruto', { cover: 'x' }));
  const b = sr.normalizeSearchResult(row('mangadex', 'abc', 'Totally Different Title', { cover: 'y' }));
  assert.equal(a.canonicalSeriesId, b.canonicalSeriesId);
  assert.equal(a.resultId, a.canonicalSeriesId);
  assert.equal(a.sourceBindingKey, identity.canonicalBindingKey('builtin:mangadex', 'mangadex', 'abc'));
  assert.ok(sr.isCanonicalSeriesId(a.canonicalSeriesId));
  assert.equal(a.id, undefined, 'a result never carries a fake local series.id');
});

test('same title from different sources → different identities; unusable rows rejected', () => {
  const a = sr.normalizeSearchResult(row('mangadex', '1', 'One Piece'));
  const b = sr.normalizeSearchResult(row('comick', '1', 'One Piece'));
  assert.notEqual(a.canonicalSeriesId, b.canonicalSeriesId);
  assert.equal(sr.normalizeSearchResult(row('mangadex', '', 'X')), null);
  assert.equal(sr.normalizeSearchResult({ title: 'no source' }), null);
  assert.equal(sr.normalizeSearchResult(row('mangadex', '1', '')), null);
});

test('source reference URL is inert metadata only; never a navigation field', () => {
  const r = sr.normalizeSearchResult(row('mangadex', '1', 'X', { sourceUrl: 'https://example.org/t/1' }));
  assert.equal(r.sourceMetadata.reference, 'https://example.org/t/1');
  assert.equal(r.sourceUrl, undefined);
  const src = require('fs').readFileSync(require('path').resolve(__dirname, '../../src/services/discoverySearch.js'), 'utf8')
    + require('fs').readFileSync(require('path').resolve(__dirname, '../../src/domain/searchResult.js'), 'utf8');
  assert.ok(!/window\.open|location\.href\s*=|location\.assign|<a\s/.test(src));
});

test('strongSameWork is conservative: title alone never merges', () => {
  const a = sr.normalizeSearchResult(row('mangadex', '1', 'Berserk'));
  const b = sr.normalizeSearchResult(row('comick', '9', 'Berserk'));
  assert.equal(sr.strongSameWork(a, b), false, 'no corroboration');
  const c = sr.normalizeSearchResult(row('comick', '9', 'Berserk', { year: '1989', author: 'Miura' }));
  const d = sr.normalizeSearchResult(row('mangadex', '1', 'Berserk', { year: '1989', author: 'Miura' }));
  assert.equal(sr.strongSameWork(c, d), true);
  const e = sr.normalizeSearchResult(row('comick', '8', 'Berserk', { year: '2016', author: 'Miura' }));
  assert.equal(sr.strongSameWork(d, e), false, 'conflicting year');
  const f = sr.normalizeSearchResult(row('comick', '7', 'Berserk', { author: 'Someone Else' }));
  assert.equal(sr.strongSameWork(d, f), false, 'conflicting author');
  const g = sr.normalizeSearchResult(row('comick', '6', 'Ab', { year: '2000' })), h = sr.normalizeSearchResult(row('mangadex', '6', 'Ab', { year: '2000' }));
  assert.equal(sr.strongSameWork(g, h), false, 'too-short titles never merge');
});

/* ---------- query contract ---------- */
test('empty and whitespace queries never hit a source', async () => {
  const { svc, calls } = mk([{ id: 'a' }], { a: () => Promise.resolve([row('a', '1', 'X')]) });
  for (const q of ['', '   ', '\t\n', null, undefined]) {
    const r = await svc.search(q);
    assert.equal(r.status, 'idle'); assert.equal(r.reason, 'empty-query'); assert.deepEqual(r.results, []);
  }
  assert.equal(calls.length, 0);
});

test('over-long query is invalid, not a remote failure', async () => {
  const { svc, calls } = mk([{ id: 'a' }], { a: () => Promise.resolve([]) });
  const r = await svc.search('x'.repeat(500));
  assert.equal(r.status, 'invalid'); assert.equal(calls.length, 0);
});

test('whitespace is normalized before reaching sources', async () => {
  const { svc, calls } = mk([{ id: 'a' }], { a: () => Promise.resolve([]) });
  await svc.search('  one \n  piece  ');
  assert.equal(calls[0].q, 'one piece');
});

/* ---------- registry ---------- */
test('only enabled sources are queried; disabled excluded; unavailable reported, not called', async () => {
  const { svc, calls } = mk(
    [{ id: 'on', priority: 1 }, { id: 'off', enabled: false }, { id: 'down', available: false, unavailableReason: 'cooldown' }],
    { on: () => Promise.resolve([row('on', '1', 'Naruto')]), off: () => Promise.resolve([row('off', '1', 'Naruto')]), down: () => Promise.resolve([]) });
  const r = await svc.search('naruto');
  assert.deepEqual(calls.map((c) => c.id), ['on']);
  const ids = r.sourceStatuses.map((s) => s.sourceId).sort();
  assert.deepEqual(ids, ['down', 'on']);
  assert.equal(r.sourceStatuses.find((s) => s.sourceId === 'down').state, 'unavailable');
  assert.equal(r.status, 'ok'); assert.equal(r.partial, false, 'an unavailable source did not fail this request');
});

test('service requires a registry (no hidden parallel source list)', () => {
  assert.throws(() => ds.createDiscoverySearch({}));
});

test('adapter normalization: array and {results} shapes both accepted; unidentifiable rows dropped', async () => {
  const { svc } = mk([{ id: 'a', priority: 1 }, { id: 'b', priority: 2 }], {
    a: () => Promise.resolve([row('a', '1', 'Alpha'), { title: 'orphan' }, null]),
    b: () => Promise.resolve({ results: [{ remoteId: 'x', title: 'Beta', cover: 'c', author: 'Au', genres: ['G'] }] })
  });
  const r = await svc.search('a');
  assert.equal(r.results.length, 2);
  const beta = r.results.find((x) => x.title === 'Beta');
  assert.equal(beta.sourceId, 'b'); assert.equal(beta.coverUrl, 'c'); assert.equal(beta.author, 'Au'); assert.deepEqual(beta.genres, ['G']);
  assert.ok(beta.sourceBindingKey && beta.canonicalSeriesId);
});

/* ---------- failure handling ---------- */
test('partial failure keeps successful results and distinguishes error kinds', async () => {
  const { svc } = mk([{ id: 'ok', priority: 1 }, { id: 'slow', priority: 2 }, { id: 'boom', priority: 3 }], {
    ok: () => Promise.resolve([row('ok', '1', 'Naruto')]),
    slow: () => new Promise(() => {}),
    boom: () => Promise.reject(new Error('HTTP 500'))
  }, { limits: { sourceTimeoutMs: 20 } });
  const r = await svc.search('naruto');
  assert.equal(r.status, 'ok'); assert.equal(r.partial, true); assert.equal(r.results.length, 1);
  const by = Object.fromEntries(r.sourceStatuses.map((s) => [s.sourceId, s.state]));
  assert.deepEqual(by, { boom: 'error', ok: 'ok', slow: 'timeout' });
});

test('all sources failing → error (not "no results"); all-offline → offline', async () => {
  let a = mk([{ id: 'x' }, { id: 'y' }], { x: () => Promise.reject(new Error('HTTP 500')), y: () => Promise.reject(new Error('HTTP 502')) });
  let r = await a.svc.search('q');
  assert.equal(r.status, 'error'); assert.deepEqual(r.results, []);
  a = mk([{ id: 'x' }], { x: () => Promise.reject(new TypeError('Failed to fetch')) });
  r = await a.svc.search('q');
  assert.equal(r.status, 'offline');
});

test('empty results are "empty", distinct from errors; no enabled sources is its own error', async () => {
  let r = await mk([{ id: 'x' }], { x: () => Promise.resolve([]) }).svc.search('zzz');
  assert.equal(r.status, 'empty');
  r = await mk([{ id: 'x', enabled: false }], { x: () => Promise.resolve([]) }).svc.search('zzz');
  assert.equal(r.status, 'error'); assert.equal(r.reason, 'no-sources');
});

test('offline device: no source requests, status offline, retry path works afterwards', async () => {
  let online = false;
  const { svc, calls } = mk([{ id: 'x' }], { x: () => Promise.resolve([row('x', '1', 'Q')]) }, { isOnline: () => online });
  let r = await svc.search('q');
  assert.equal(r.status, 'offline'); assert.equal(calls.length, 0);
  online = true;
  r = await svc.retry();
  assert.equal(r.status, 'ok'); assert.equal(r.results.length, 1);
});

test('adapter that throws synchronously never rejects the search', async () => {
  const { svc } = mk([{ id: 'x' }], { x: () => { throw new Error('sync boom'); } });
  const r = await svc.search('q');
  assert.equal(r.status, 'error');
});

/* ---------- stale / abort ---------- */
test('stale request cannot overwrite the current results (naruto → one piece)', async () => {
  const slow = defer(), fast = defer();
  const { svc } = mk([{ id: 'x' }], { x: (q) => (q === 'naruto' ? slow.promise : fast.promise) });
  const p1 = svc.search('naruto');
  const p2 = svc.search('one piece');
  fast.resolve([row('x', '2', 'One Piece')]);
  const r2 = await p2;
  slow.resolve([row('x', '1', 'Naruto')]);
  const r1 = await p1;
  assert.equal(r1.stale, true);
  assert.equal(r2.stale, false);
  const st = svc.getState();
  assert.equal(st.query, 'one piece');
  assert.deepEqual(st.results.map((x) => x.title), ['One Piece']);
});

test('new search aborts the previous request signal; passes an AbortSignal to adapters', async () => {
  const d = defer();
  const { svc, calls } = mk([{ id: 'x' }], { x: (q) => (q === 'a' ? d.promise : Promise.resolve([])) });
  const p1 = svc.search('a');
  assert.ok(calls[0].signal && typeof calls[0].signal.aborted === 'boolean');
  await svc.search('b');
  assert.equal(calls[0].signal.aborted, true);
  d.resolve([row('x', '1', 'A')]);
  assert.equal((await p1).stale, true);
});

test('external AbortSignal cancels the search without leaving it loading forever', async () => {
  const ac = new AbortController();
  const { svc } = mk([{ id: 'x' }], { x: (q, o) => new Promise((res, rej) => o.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))) });
  const p = svc.search('a', { signal: ac.signal });
  ac.abort();
  const r = await p;
  assert.equal(r.stale, true);
  assert.notEqual(svc.getState().status, 'ok');
});

test('clear() invalidates in-flight work', async () => {
  const d = defer();
  const { svc } = mk([{ id: 'x' }], { x: () => d.promise });
  const p = svc.search('a'); svc.clear(); d.resolve([row('x', '1', 'A')]);
  assert.equal((await p).stale, true);
  assert.equal(svc.getState().status, 'idle');
  assert.deepEqual(svc.getState().results, []);
});

/* ---------- dedupe / ranking ---------- */
test('duplicate rows from the same source are collapsed; ranking is deterministic', async () => {
  const rows = [row('a', '2', 'Zeta'), row('a', '1', 'Alpha'), row('a', '1', 'Alpha dup'), row('a', '3', 'Alpha Two')];
  const run = async () => (await mk([{ id: 'a' }], { a: () => Promise.resolve(rows.slice()) }).svc.search('alpha')).results.map((x) => x.remoteId);
  const r1 = await run(), r2 = await run();
  assert.deepEqual(r1, r2);
  assert.deepEqual(r1, ['1', '3', '2'], 'exact, then prefix, then other');
});

test('cross-source: same title WITHOUT corroboration stays separate; corroborated merges and keeps both bindings', async () => {
  let r = await mk([{ id: 'a', priority: 1 }, { id: 'b', priority: 2 }], {
    a: () => Promise.resolve([row('a', '1', 'Berserk')]), b: () => Promise.resolve([row('b', '9', 'Berserk')])
  }).svc.search('berserk');
  assert.equal(r.results.length, 2);
  r = await mk([{ id: 'a', priority: 1 }, { id: 'b', priority: 2 }], {
    a: () => Promise.resolve([row('a', '1', 'Berserk', { year: 1989, author: 'Miura' })]),
    b: () => Promise.resolve([row('b', '9', 'Berserk', { year: 1989, author: 'Miura' })])
  }).svc.search('berserk');
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].sourceId, 'a');
  assert.equal(r.results[0].alsoFrom.length, 1);
  assert.equal(r.results[0].alsoFrom[0].sourceId, 'b');
});

test('dedupe is linear-ish: 4000 rows finish quickly', async () => {
  const many = Array.from({ length: 4000 }, (_, i) => row('a', String(i), 'Title ' + (i % 900)));
  const { svc } = mk([{ id: 'a' }], { a: () => Promise.resolve(many) }, { limits: { maxResults: 5000 } });
  const t = Date.now(); const r = await svc.search('title');
  assert.equal(r.results.length, 4000);
  assert.ok(Date.now() - t < 1500);
});

test('result cap is explicit: capped=true and hasMore=false, never silent', async () => {
  const many = Array.from({ length: 30 }, (_, i) => row('a', String(i), 'T' + i));
  const { svc } = mk([{ id: 'a', paginates: true }], { a: () => Promise.resolve({ results: many, hasMore: true }) }, { limits: { maxResults: 10 } });
  const r = await svc.search('t');
  assert.equal(r.results.length, 10); assert.equal(r.capped, true); assert.equal(r.hasMore, false);
});

/* ---------- pagination ---------- */
test('pagination: page 1 → load more → page 2 → exhausted; append-only; duplicate loadMore guarded', async () => {
  const pages = { 1: { results: [row('a', '1', 'A1'), row('a', '2', 'A2')], hasMore: true }, 2: { results: [row('a', '3', 'A3'), row('a', '1', 'A1')], hasMore: false } };
  const d2 = defer();
  const { svc, calls } = mk([{ id: 'a', paginates: true }], { a: (q, o) => (o.page === 2 ? d2.promise : Promise.resolve(pages[o.page])) });
  let r = await svc.search('a');
  assert.equal(r.hasMore, true); assert.deepEqual(r.results.map((x) => x.remoteId), ['1', '2']);
  const m1 = svc.loadMore(), m2 = svc.loadMore();
  assert.equal(m1, m2, 'duplicate in-flight page request returns the same promise');
  assert.equal(svc.getState().loadingMore, true);
  d2.resolve(pages[2]);
  r = await m1;
  assert.deepEqual(r.results.map((x) => x.remoteId), ['1', '2', '3'], 'append-only, deduped');
  assert.equal(r.hasMore, false);
  assert.deepEqual(calls.filter((c) => c.id === 'a').map((c) => c.page), [1, 2]);
  const again = await svc.loadMore();
  assert.equal(again.noop, true); assert.equal(calls.length, 2);
});

test('non-paginating source never reports hasMore and is not asked for page 2', async () => {
  const { svc, calls } = mk([{ id: 'a', paginates: false }], { a: () => Promise.resolve({ results: [row('a', '1', 'A')], hasMore: true }) });
  const r = await svc.search('a');
  assert.equal(r.hasMore, false);
  assert.equal(r.sourceStatuses[0].paginates, false);
  await svc.loadMore();
  assert.equal(calls.length, 1);
});

test('maxPages bound stops continuation; loadMore failure keeps results and retries the same page', async () => {
  let fail = true;
  const { svc, calls } = mk([{ id: 'a', paginates: true }], {
    a: (q, o) => {
      if (o.page === 2 && fail) return Promise.reject(new Error('HTTP 500'));
      return Promise.resolve({ results: [row('a', 'p' + o.page, 'P' + o.page)], hasMore: true });
    }
  }, { limits: { maxPages: 3 } });
  await svc.search('p');
  let r = await svc.loadMore();
  assert.equal(r.results.length, 1, 'failed page keeps existing results');
  assert.ok(r.loadMoreError); assert.equal(r.hasMore, true);
  fail = false;
  r = await svc.retry();
  assert.equal(r.results.length, 2);
  r = await svc.loadMore();
  assert.equal(r.results.length, 3);
  assert.equal(r.hasMore, false, 'maxPages reached');
  assert.deepEqual(calls.map((c) => c.page), [1, 2, 2, 3]);
});

test('loadMore from an old query is rejected after a new search', async () => {
  const d = defer();
  const { svc } = mk([{ id: 'a', paginates: true }], { a: (q, o) => (q === 'old' && o.page === 2 ? d.promise : Promise.resolve({ results: [row('a', q + o.page, q + o.page)], hasMore: true })) });
  await svc.search('old');
  const more = svc.loadMore();
  await svc.search('new');
  d.resolve({ results: [row('a', 'oldX', 'oldX')], hasMore: false });
  assert.equal((await more).stale, true);
  assert.deepEqual(svc.getState().results.map((x) => x.title), ['new1']);
});

/* ---------- retry ---------- */
test('retry after total failure re-runs the same query', async () => {
  let ok = false;
  const { svc } = mk([{ id: 'a' }], { a: () => (ok ? Promise.resolve([row('a', '1', 'X')]) : Promise.reject(new Error('HTTP 500'))) });
  assert.equal((await svc.search('x')).status, 'error');
  ok = true;
  const r = await svc.retry();
  assert.equal(r.status, 'ok'); assert.equal(r.query, 'x');
});

/* ---------- UI state model ---------- */
test('state transitions are observable: loading → ok; subscribers get snapshots, not live state', async () => {
  const d = defer();
  const { svc } = mk([{ id: 'a' }], { a: () => d.promise });
  const seen = [];
  svc.subscribe((s) => seen.push(s.status));
  const p = svc.search('a');
  assert.equal(svc.getState().status, 'loading');
  d.resolve([row('a', '1', 'A')]); await p;
  assert.deepEqual(seen, ['loading', 'ok']);
  const snap = svc.getState(); snap.results.length = 0;
  assert.equal(svc.getState().results.length, 1);
});

test('preview selection resolves by stable id and is cleared by a new search', async () => {
  const { svc } = mk([{ id: 'a' }], { a: () => Promise.resolve([row('a', '1', 'A')]) });
  const r = await svc.search('a');
  const id = r.results[0].resultId;
  assert.equal(svc.select(id).title, 'A');
  assert.equal(svc.getState().previewOpen, true);
  assert.equal(svc.select('nope'), null);
  await svc.search('a');
  assert.equal(svc.getState().previewOpen, false);
});

test('debounce coalesces rapid calls', () => {
  const timers = []; let n = 0;
  const fake = { set: (fn) => { timers.push(fn); return timers.length; }, clear: (h) => { timers[h - 1] = null; } };
  const d = ds.debounce(() => { n++; }, 300, fake);
  d(); d(); d();
  timers.forEach((f) => f && f());
  assert.equal(n, 1);
});

/* ---------- Library round trip (real libraryStore + real identity) ---------- */
function mkLibrary() {
  const storage = createMemoryStorage();
  const store = libraryStore.createLibraryStore({ storage, now: () => 1700000000000 });
  const lib = { series: [], progress: {}, settings: {} };
  let imports = 0;
  const api = {
    lib, storage, importsCount: () => imports,
    find(result) {
      const idx = ds.buildLibraryIndex(lib.series, identity);
      return ds.matchLibrary(result, idx);
    },
    async importResult(result) {
      imports++;
      const s = { id: 'local-' + imports, canonicalId: 'local-' + imports, title: result.title, sourceMappings: [{ sourceId: result.sourceId, remoteId: result.remoteId, extensionId: result.extensionId }], readChapters: {} };
      lib.series.unshift(s);
      await store.saveLibrary(lib);
      return s;
    }
  };
  return api;
}

test('search and preview never touch the Library or its storage', async () => {
  const L = mkLibrary();
  const { svc } = mk([{ id: 'a' }], { a: () => Promise.resolve([row('a', '1', 'Naruto')]) });
  const r = await svc.search('naruto');
  svc.select(r.results[0].resultId); svc.closePreview();
  await svc.loadMore();
  assert.equal(L.lib.series.length, 0);
  assert.equal(L.storage.calls.set.length, 0);
  assert.equal(L.importsCount(), 0);
});

test('Add is explicit, idempotent, and a concurrent double-add imports once', async () => {
  const L = mkLibrary();
  const { svc } = mk([{ id: 'a' }], { a: () => Promise.resolve([row('a', '1', 'Naruto')]) });
  const res = (await svc.search('naruto')).results[0];
  const [x, y] = await Promise.all([svc.addToLibrary(res, L), svc.addToLibrary(res, L)]);
  assert.equal(x.status, 'added'); assert.equal(y.status, 'added');
  assert.equal(L.importsCount(), 1); assert.equal(L.lib.series.length, 1);
  const z = await svc.addToLibrary(res, L);
  assert.equal(z.status, 'already'); assert.equal(L.lib.series.length, 1);
  assert.equal(L.storage.calls.set.filter((c) => c.key === 'fairs-library-v1').length >= 1, true);
});

test('round trip: Add → reopen search → same manga recognized; progress survives re-add', async () => {
  const L = mkLibrary();
  const { svc } = mk([{ id: 'a' }], { a: () => Promise.resolve([row('a', '1', 'Naruto')]) });
  let res = (await svc.search('naruto')).results[0];
  const added = await svc.addToLibrary(res, L);
  added.series.readChapters = { c1: { page: 7 } };
  const before = JSON.stringify(L.lib);
  const writesBefore = L.storage.calls.set.length;
  res = (await svc.search('naruto')).results[0];
  assert.ok(L.find(res), 'recognized as already added');
  const again = await svc.addToLibrary(res, L);
  assert.equal(again.status, 'already');
  assert.equal(JSON.stringify(L.lib), before, 'existing series and progress untouched');
  assert.equal(L.storage.calls.set.length, writesBefore, 'no re-write on repeat add');
});

test('Library manga searched again from a different result position is matched by identity, not title/position', async () => {
  const L = mkLibrary();
  L.lib.series.push({ id: 's1', canonicalId: 's1', title: 'Renamed Locally', sourceMappings: [{ sourceId: 'a', remoteId: '1' }] });
  const { svc } = mk([{ id: 'a' }], { a: () => Promise.resolve([row('a', '0', 'Other'), row('a', '1', 'Naruto')]) });
  const rs = (await svc.search('x')).results;
  assert.equal(L.find(rs.find((r) => r.remoteId === '0')), null);
  assert.equal(L.find(rs.find((r) => r.remoteId === '1')).id, 's1');
});

test('failed import returns an error and creates nothing', async () => {
  const L = mkLibrary();
  const bad = { find: () => null, importResult: () => Promise.reject(new Error('no-chapters')) };
  const { svc } = mk([{ id: 'a' }], { a: () => Promise.resolve([row('a', '1', 'N')]) });
  const res = (await svc.search('n')).results[0];
  const out = await svc.addToLibrary(res, bad);
  assert.equal(out.status, 'error'); assert.equal(L.lib.series.length, 0);
  const retry = await svc.addToLibrary(res, L);
  assert.equal(retry.status, 'added');
});

test('a failed search never creates library entries or fake results', async () => {
  const L = mkLibrary();
  const { svc } = mk([{ id: 'a' }], { a: () => Promise.reject(new Error('HTTP 500')) });
  const r = await svc.search('n');
  assert.deepEqual(r.results, []); assert.equal(L.lib.series.length, 0);
});
