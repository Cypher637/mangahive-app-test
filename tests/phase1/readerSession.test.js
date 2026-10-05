'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const rs = require('../../src/domain/readerSession.js');
const { deepFreeze } = require('./helpers/memoryStorage.js');

const series = () => ({ id: 's1', canonicalId: 's1' });
const chapter = (n) => ({ id: 'c1', chapter: '3', pages: new Array(n == null ? 5 : n).fill('p') });
const open = (over) => rs.createReaderSession(Object.assign({ series: series(), chapter: chapter(), sessionId: 'sess-1' }, over || {}));

test('initialization captures identity snapshots, page count and defaults', () => {
  const s = open();
  assert.equal(s.sessionId, 'sess-1');
  assert.deepEqual(s.series, { id: 's1', canonicalId: 's1' });
  assert.deepEqual(s.chapter, { id: 'c1', canonicalChapterId: 'mhch:s1:3' });
  assert.equal(s.pageCount, 5); assert.equal(s.currentPage, 0);
  assert.equal(s.mode, 'webtoon'); assert.equal(s.direction, 'ttb');
  assert.equal(s.loading, false); assert.equal(s.error, null); assert.equal(s.completed, false);
  assert.equal(s.status, 'ready');
  assert.equal(open({ mode: 'paged' }).direction, 'rtl');
  assert.equal(open({ mode: 'bogus', direction: 'sideways' }).mode, 'webtoon');
});

test('starting page is clamped; loading flag sets loading status', () => {
  assert.equal(open({ currentPage: 99 }).currentPage, 4);
  assert.equal(open({ currentPage: -3 }).currentPage, 0);
  assert.equal(open({ loading: true, pageCount: 0 }).status, 'loading');
});

test('missing or unusable chapter/series yields an error session, not an exception', () => {
  const noCh = rs.createReaderSession({ series: series() });
  assert.equal(noCh.status, 'error'); assert.equal(noCh.error.code, 'CHAPTER_MISSING');
  assert.equal(rs.createReaderSession({ chapter: chapter() }).error.code, 'SERIES_MISSING');
  assert.equal(rs.createReaderSession(null).status, 'error');
  assert.deepEqual(rs.setPage(noCh, 3).events, []);
  assert.deepEqual(rs.nextPage(noCh).events, []);
});

test('page movement emits page-changed events carrying everything a progress store needs', () => {
  const r = rs.nextPage(open());
  assert.equal(r.session.currentPage, 1);
  assert.deepEqual(r.events, [{
    type: 'reader/page-changed', sessionId: 'sess-1', seriesId: 's1', canonicalSeriesId: 's1',
    chapterId: 'c1', canonicalChapterId: 'mhch:s1:3', pageIndex: 1, pageCount: 5, previousPage: 0
  }]);
  const jump = rs.setPage(r.session, 3);
  assert.equal(jump.session.currentPage, 3); assert.equal(jump.session.maxPage, 3);
  assert.equal(rs.previousPage(jump.session).session.currentPage, 2);
  assert.equal(rs.previousPage(jump.session).session.maxPage, 3, 'maxPage tracks the furthest page reached');
  assert.equal(rs.setPage(open(), 0).events.length, 0, 'no event when the page does not change');
});

test('boundaries: cannot go past the first/last page; boundary event instead of movement', () => {
  const first = rs.previousPage(open());
  assert.equal(first.session.currentPage, 0); assert.equal(first.events[0].type, 'reader/boundary'); assert.equal(first.events[0].edge, 'start');
  const lastS = rs.setPage(open(), 100).session;
  assert.equal(lastS.currentPage, 4);
  const end = rs.nextPage(lastS);
  assert.equal(end.session.currentPage, 4); assert.equal(end.events[0].edge, 'end');
  assert.equal(rs.setPage(open(), -10).session.currentPage, 0);
  assert.equal(rs.nextPage(open({ pageCount: 0, chapter: { id: 'c1' } })).session.currentPage, 0, 'no pages → no movement');
});

test('completion is explicit, records completedAt, is idempotent', () => {
  const atEnd = rs.setPage(open(), 4).session;
  assert.equal(atEnd.completed, false, 'reaching the last page does not complete by itself');
  const done = rs.complete(atEnd, { now: 777 });
  assert.equal(done.session.completed, true); assert.equal(done.session.completedAt, 777); assert.equal(done.session.status, 'completed');
  assert.equal(done.events[0].type, 'reader/completed'); assert.equal(done.events[0].completedAt, 777);
  const again = rs.complete(done.session, { now: 999 });
  assert.equal(again.session.completedAt, 777); assert.deepEqual(again.events, []);
  assert.equal(rs.complete(open(), { now: 1 }).session.currentPage, 4, 'completing parks on the last page');
});

test('reset returns to page 0 / chosen page, clears completion and error, keeps the session id', () => {
  const done = rs.complete(rs.setPage(open(), 3).session, { now: 5 }).session;
  const r = rs.reset(done);
  assert.equal(r.session.currentPage, 0); assert.equal(r.session.completed, false); assert.equal(r.session.completedAt, null);
  assert.equal(r.session.sessionId, 'sess-1'); assert.equal(r.events[0].type, 'reader/reset');
  assert.equal(rs.reset(done, { page: 2 }).session.currentPage, 2);
  const errored = rs.setError(open(), { code: 'X', message: 'boom' }).session;
  assert.equal(errored.status, 'error');
  assert.equal(rs.reset(errored).session.status, 'ready');
});

test('loading / error / page-count transitions', () => {
  let s = open({ loading: true, pageCount: 0, chapter: { id: 'c1', chapter: '3' }, currentPage: 4 });
  assert.equal(s.currentPage, 4, 'a resume page is kept while the page count is still unknown');
  s = rs.setPageCount(s, 3).session;
  assert.equal(s.pageCount, 3); assert.equal(s.currentPage, 2, 're-clamped when pages resolve'); assert.equal(s.loading, false);
  const e = rs.setError(s, 'network down');
  assert.deepEqual(e.session.error, { code: 'READER_ERROR', message: 'network down' });
  assert.equal(rs.setError(e.session, null).session.error, null);
  assert.equal(rs.setLoading(s, true).session.status, 'loading');
});

test('session isolation: independent ids, no shared state between sessions', () => {
  const a = rs.createReaderSession({ series: series(), chapter: chapter() });
  const b = rs.createReaderSession({ series: series(), chapter: chapter() });
  assert.notEqual(a.sessionId, b.sessionId);
  const a2 = rs.setPage(a, 3).session;
  assert.equal(a.currentPage, 0); assert.equal(b.currentPage, 0); assert.equal(a2.currentPage, 3);
  const bDone = rs.complete(b, { now: 1 }).session;
  assert.equal(a2.completed, false);
  assert.ok(bDone.completed);
  // two sessions over the same chapter do not interfere
  const x = rs.nextPage(open({ sessionId: 'X' })).session, y = rs.nextPage(rs.nextPage(open({ sessionId: 'Y' })).session).session;
  assert.equal(x.currentPage, 1); assert.equal(y.currentPage, 2);
});

test('sessions are frozen and never mutate the series/chapter they were built from', () => {
  const s0 = deepFreeze(series()), c0 = deepFreeze(chapter());
  const s = rs.createReaderSession({ series: s0, chapter: c0, sessionId: 'f' });
  assert.ok(Object.isFrozen(s)); assert.ok(Object.isFrozen(s.chapter));
  assert.throws(() => { 'use strict'; s.currentPage = 3; }, TypeError);
  assert.doesNotThrow(() => { let t = rs.nextPage(s).session; t = rs.complete(t, { now: 1 }).session; rs.reset(t); });
  assert.equal(c0.canonicalChapterId, undefined);
  assert.equal(s.chapter.id, 'c1');
});

test('the reader session never touches storage, network, or globals', () => {
  const trap = (name) => { Object.defineProperty(globalThis, name, { configurable: true, get() { throw new Error('reader session touched ' + name); } }); };
  const names = ['indexedDB', 'localStorage', 'sessionStorage', 'fetch', 'XMLHttpRequest', 'window', 'document', 'sb', 'supabase'];
  const saved = names.map((n) => [n, Object.getOwnPropertyDescriptor(globalThis, n)]);
  names.forEach(trap);
  try {
    let s = open();
    s = rs.nextPage(s).session; s = rs.setPage(s, 3).session; s = rs.complete(s, { now: 1 }).session; s = rs.reset(s).session;
    assert.ok(rs.toProgressEvent(s));
  } finally {
    saved.forEach(([n, d]) => { if (d) Object.defineProperty(globalThis, n, d); else delete globalThis[n]; });
  }
});

test('toProgressEvent is a pure snapshot', () => {
  const s = rs.setPage(open(), 2).session;
  assert.deepEqual(rs.toProgressEvent(s), rs.toProgressEvent(s));
  const ev = rs.toProgressEvent(s);
  assert.equal(ev.type, 'reader/progress'); assert.equal(ev.pageIndex, 2); assert.equal(ev.completed, false);
  assert.equal(rs.toProgressEvent(null), null);
});
