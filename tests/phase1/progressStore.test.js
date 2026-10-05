'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ps = require('../../src/services/progressStore.js');
const pg = require('../../src/domain/progress.js');
const { createMemoryStorage } = require('./helpers/memoryStorage.js');

// per-chapter records only (the tiny per-series "latest" index lives under <prefix>latest:)
const chapterKeys = (st) => [...st.data.keys()].filter((k) => k.startsWith(ps.DEFAULT_PREFIX) && !k.startsWith(ps.DEFAULT_PREFIX + 'latest:'));
const chapterSets = (st) => st.calls.set.filter((c) => !c.key.startsWith(ps.DEFAULT_PREFIX + 'latest:'));

const series = { id: 's1', canonicalId: 's1' };
const chapter = (id, n, pages) => ({ id, chapter: String(n), pages: new Array(pages == null ? 10 : pages).fill('p') });
let clock; const mk = (st, extra) => { clock = 1000; return ps.createProgressStore(Object.assign({ storage: st, now: () => (clock += 10) }, extra || {})); };

test('update creates a record, then updates the same one (read-modify-write)', async () => {
  const st = createMemoryStorage(); const store = mk(st);
  const a = await store.updateChapterProgress({ series, chapter: chapter('c1', 1), pageIndex: 2 });
  assert.equal(a.ok, true); assert.equal(a.record.pageIndex, 2); assert.equal(a.record.canonicalChapterId, 'mhch:s1:1');
  const b = await store.updateChapterProgress({ series, chapter: chapter('c1', 1), pageIndex: 6 });
  assert.equal(b.record.pageIndex, 6); assert.ok(b.record.updatedAt > a.record.updatedAt);
  assert.equal(chapterKeys(st).length, 1, 'one record per chapter');
  const got = await store.getChapterProgress({ seriesId: 's1', chapterId: 'c1' });
  assert.deepEqual(got, b.record);
});

test('a progress update is a small targeted write and never touches the library key', async () => {
  const st = createMemoryStorage();
  const bigLibrary = { series: Array.from({ length: 500 }, (_, i) => ({ id: 's' + i, title: 'Series ' + i, chapters: Array.from({ length: 50 }, (_, j) => ({ id: 'c' + j, chapter: String(j), pages: new Array(20).fill('https://example.invalid/page.jpg') })) })) };
  st.data.set('fairs-library-v1', JSON.stringify(bigLibrary));
  const libraryBytes = st.data.get('fairs-library-v1').length;
  const store = mk(st);
  await store.updateChapterProgress({ seriesId: 's7', chapterId: 'c3', pageIndex: 5, pageCount: 20 });
  assert.equal(chapterSets(st).length, 1);
  assert.equal(st.calls.set.length, 2, 'one chapter record + one tiny latest-index record');
  st.calls.set.forEach((c) => { assert.ok(c.key.startsWith(ps.DEFAULT_PREFIX)); assert.ok(c.bytes < 600, c.key + ' is ' + c.bytes + ' bytes'); });
  assert.ok(libraryBytes > st.calls.set[0].bytes * 1000, 'library blob is ' + libraryBytes + ' bytes — not rewritten per page turn');
  assert.equal(st.calls.set.some((c) => c.key === 'fairs-library-v1'), false);
  assert.equal(st.calls.get.includes('fairs-library-v1'), false, 'the library is not even read');
});

test('records from different chapters/series are independent', async () => {
  const st = createMemoryStorage(); const store = mk(st);
  await store.updateChapterProgress({ seriesId: 's1', chapterId: 'c1', pageIndex: 1 });
  await store.updateChapterProgress({ seriesId: 's1', chapterId: 'c2', pageIndex: 4 });
  await store.updateChapterProgress({ seriesId: 's2', chapterId: 'c1', pageIndex: 7 });
  assert.equal(chapterKeys(st).length, 3);
  assert.equal((await store.getChapterProgress({ seriesId: 's1', chapterId: 'c2' })).pageIndex, 4);
  assert.equal((await store.getChapterProgress({ seriesId: 's2', chapterId: 'c1' })).pageIndex, 7);
  assert.equal(await store.getChapterProgress({ seriesId: 's9', chapterId: 'c1' }), null);
});

test('ids containing ":" / "::" cannot collide', async () => {
  const st = createMemoryStorage(); const store = mk(st);
  await store.updateChapterProgress({ seriesId: 'A::1', chapterId: '23', pageIndex: 1 });
  await store.updateChapterProgress({ seriesId: 'A', chapterId: '1::23', pageIndex: 2 });
  assert.equal(chapterKeys(st).length, 2);
  assert.equal((await store.getChapterProgress({ seriesId: 'A::1', chapterId: '23' })).pageIndex, 1);
  assert.equal((await store.getChapterProgress({ seriesId: 'A', chapterId: '1::23' })).pageIndex, 2);
  const sp = await store.getSeriesProgress('A');
  assert.equal(sp.records.length, 1, 'series "A" does not see series "A::1"');
});

test('page index is clamped and records stay valid', async () => {
  const st = createMemoryStorage(); const store = mk(st);
  const r = await store.updateChapterProgress({ series, chapter: chapter('c1', 1, 5), pageIndex: 99 });
  assert.equal(r.record.pageIndex, 4);
  const n = await store.updateChapterProgress({ series, chapter: chapter('c1', 1, 5), pageIndex: -4 });
  assert.equal(n.record.pageIndex, 0);
});

test('markCompleted creates/completes; resetChapterProgress re-reads; clearChapterProgress deletes', async () => {
  const st = createMemoryStorage(); const store = mk(st);
  const c = await store.markCompleted({ series, chapter: chapter('c1', 1) });
  assert.equal(c.record.completed, true); assert.ok(c.record.completedAt > 0); assert.equal(c.record.pageIndex, 9);
  const reread = await store.resetChapterProgress({ seriesId: 's1', chapterId: 'c1' });
  assert.equal(reread.record.completed, false); assert.equal(reread.record.pageIndex, 0); assert.equal(reread.record.canonicalChapterId, 'mhch:s1:1');
  assert.equal((await store.resetChapterProgress({ seriesId: 's1', chapterId: 'nope' })).code, 'NO_PROGRESS_RECORD');
  const cleared = await store.clearChapterProgress({ seriesId: 's1', chapterId: 'c1' });
  assert.equal(cleared.ok, true); assert.equal(chapterKeys(st).length, 0); assert.equal([...st.data.keys()].filter((k) => k.includes('latest:')).length, 0, 'latest index dropped with its last record');
  assert.equal(await store.getChapterProgress({ seriesId: 's1', chapterId: 'c1' }), null);
});

test('getSeriesProgress returns newest-first records, the latest, and the completed count', async () => {
  const st = createMemoryStorage(); const store = mk(st);
  await store.updateChapterProgress({ series, chapter: chapter('c1', 1), pageIndex: 1 });
  await store.markCompleted({ series, chapter: chapter('c2', 2) });
  await store.updateChapterProgress({ series, chapter: chapter('c3', 3), pageIndex: 2 });
  await store.updateChapterProgress({ seriesId: 'other', chapterId: 'x', pageIndex: 2 });
  const sp = await store.getSeriesProgress('s1');
  assert.deepEqual(sp.records.map((r) => r.chapterId), ['c3', 'c2', 'c1']);
  assert.equal(sp.latest.chapterId, 'c3'); assert.equal(sp.completedCount, 1);
  const none = await store.getSeriesProgress('zzz');
  assert.deepEqual(none.records, []); assert.equal(none.latest, null);
});

test('loadProgress (fresh store instance) returns what was persisted; invalid entries are reported, never deleted', async () => {
  const st = createMemoryStorage(); const a = mk(st);
  await a.updateChapterProgress({ seriesId: 's1', chapterId: 'c1', pageIndex: 3 });
  st.data.set(ps.DEFAULT_PREFIX + 'local::s1:garbage', '{not json');
  st.data.set(ps.DEFAULT_PREFIX + 'local::s1:alsobad', JSON.stringify({ hello: 'world' }));
  const b = ps.createProgressStore({ storage: st });
  const r = await b.loadProgress();
  assert.equal(r.ok, true); assert.equal(r.records.length, 1); assert.equal(r.invalid.length, 2);
  assert.equal(st.data.has(ps.DEFAULT_PREFIX + 'local::s1:garbage'), true, 'invalid data is preserved');
  assert.equal(st.calls.delete.length, 0);
});

test('scopes are isolated: a user-scoped store does not see local records', async () => {
  const st = createMemoryStorage();
  const local = ps.createProgressStore({ storage: st }); const user = ps.createProgressStore({ storage: st, scope: 'user', scopeId: 'u1' }); const other = ps.createProgressStore({ storage: st, scope: 'user', scopeId: 'u2' });
  await local.updateChapterProgress({ seriesId: 's', chapterId: 'c', pageIndex: 1 });
  await user.updateChapterProgress({ seriesId: 's', chapterId: 'c', pageIndex: 5 });
  assert.equal(chapterKeys(st).length, 2);
  assert.equal((await user.getChapterProgress({ seriesId: 's', chapterId: 'c' })).pageIndex, 5);
  assert.equal((await local.getChapterProgress({ seriesId: 's', chapterId: 'c' })).pageIndex, 1);
  assert.equal(await other.getChapterProgress({ seriesId: 's', chapterId: 'c' }), null);
  assert.equal((await user.loadProgress()).records.length, 1);
  assert.equal(ps.createProgressStore({ storage: st, scope: 'user' }).scope, 'local', 'user scope without an id falls back to local');
});

test('rapid concurrent updates are serialised: last call wins, nothing is lost or reordered', async () => {
  const st = createMemoryStorage({ setDelay: (k, v) => (JSON.parse(v).pageIndex % 2 ? 15 : 1) }); const store = mk(st);
  const ps1 = []; for (let i = 0; i < 12; i++) ps1.push(store.updateChapterProgress({ seriesId: 's', chapterId: 'c', pageIndex: i, pageCount: 20 }));
  await Promise.all(ps1);
  const fresh = ps.createProgressStore({ storage: st });
  assert.equal((await fresh.getChapterProgress({ seriesId: 's', chapterId: 'c' })).pageIndex, 11);
});

test('failures are reported, not thrown, and do not wedge later updates', async () => {
  let fail = true; const st = createMemoryStorage({ failSet: () => fail }); const store = mk(st);
  assert.equal((await store.updateChapterProgress({ seriesId: 's', chapterId: 'c', pageIndex: 1 })).code, 'WRITE_FAILED');
  fail = false;
  assert.equal((await store.updateChapterProgress({ seriesId: 's', chapterId: 'c', pageIndex: 2 })).ok, true);
  assert.equal((await store.updateChapterProgress({ pageIndex: 1 })).code, 'INVALID_REFERENCE');
  assert.equal((await store.saveProgress({ nope: true })).code, 'INVALID_RECORD');
  assert.equal((await ps.createProgressStore({ storage: null }).updateChapterProgress({ seriesId: 's', chapterId: 'c', pageIndex: 1 })).code, 'STORAGE_UNAVAILABLE');
  const noList = createMemoryStorage({ failList: true });
  const s2 = mk(noList); await s2.updateChapterProgress({ seriesId: 's', chapterId: 'c', pageIndex: 3 });
  const l = await s2.loadProgress();
  assert.equal(l.ok, false); assert.equal(l.code, 'LIST_UNAVAILABLE'); assert.equal(l.records.length, 1, 'falls back to what is cached');
});

test('saveProgress writes exactly the normalised record', async () => {
  const st = createMemoryStorage(); const store = mk(st);
  const rec = pg.createProgressRecord({ series, chapter: chapter('c1', 1), pageIndex: 3, now: 55 });
  const r = await store.saveProgress(rec);
  assert.equal(r.ok, true); assert.deepEqual(JSON.parse(st.data.get(r.key)), rec);
});

test('metrics record the size/time of the last progress write', async () => {
  let t = 0; const st = createMemoryStorage(); const store = ps.createProgressStore({ storage: st, perfNow: () => (t += 3) });
  await store.updateChapterProgress({ seriesId: 's', chapterId: 'c', pageIndex: 1 });
  const m = store.getMetrics(); assert.ok(m.lastWriteBytes > 0 && m.lastWriteMs > 0 && m.writes === 1);
});
