'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const pg = require('../../src/domain/progress.js');
const { deepFreeze } = require('./helpers/memoryStorage.js');

const series = { id: 's1', canonicalId: 's1', sourceMappings: [{ sourceId: 'md', remoteId: 'x' }] };
const chapter = { id: 'c1', chapter: '4', sources: [{ sourceId: 'md', remoteId: 'rc1' }], pages: new Array(10).fill('p') };
const mk = (over) => pg.createProgressRecord(Object.assign({ series, chapter, pageIndex: 2, now: 1000 }, over || {}));

test('createProgressRecord builds the full conceptual structure', () => {
  const r = mk();
  assert.deepEqual(Object.keys(r).sort(), ['canonicalChapterId', 'canonicalSeriesId', 'chapterId', 'completed', 'completedAt', 'pageCount', 'pageIndex', 'schemaVersion', 'scope', 'scopeId', 'seriesId', 'sourceBindingKey', 'updatedAt'].sort());
  assert.equal(r.seriesId, 's1'); assert.equal(r.chapterId, 'c1');
  assert.equal(r.canonicalSeriesId, 's1'); assert.equal(r.canonicalChapterId, 'mhch:s1:4');
  assert.equal(r.pageCount, 10); assert.equal(r.pageIndex, 2);
  assert.equal(r.completed, false); assert.equal(r.completedAt, null);
  assert.equal(r.updatedAt, 1000); assert.equal(r.scope, 'local');
  assert.equal(r.sourceBindingKey, 'builtin:md\u001fmd\u001frc1');
});

test('creation from bare ids; deterministic with an injected clock', () => {
  const a = pg.createProgressRecord({ seriesId: 's', chapterId: 'c', pageIndex: 1, pageCount: 3, now: 5 });
  const b = pg.createProgressRecord({ seriesId: 's', chapterId: 'c', pageIndex: 1, pageCount: 3, now: 5 });
  assert.deepEqual(a, b);
  assert.equal(a.canonicalChapterId, null, 'canonical ids are never invented from bare ids');
});

test('missing chapter / series → null, not a half-built record', () => {
  assert.equal(pg.createProgressRecord({ series }), null);
  assert.equal(pg.createProgressRecord({ chapter }), null);
  assert.equal(pg.createProgressRecord(null), null);
  assert.equal(pg.createProgressRecord({ seriesId: 's', chapterId: '' }), null);
});

test('a weakly identified chapter keeps its local id but gets no canonical id', () => {
  const r = pg.createProgressRecord({ series, chapter: { id: 'only-title', title: 'Hello' }, pageIndex: 0, now: 1 });
  assert.equal(r.chapterId, 'only-title'); assert.equal(r.canonicalChapterId, null);
});

test('scope: local default; user scope requires a user id', () => {
  assert.equal(mk().scope, 'local');
  const u = mk({ scope: 'user', scopeId: 'u-1' });
  assert.equal(u.scope, 'user'); assert.equal(u.scopeId, 'u-1');
  const bad = mk({ scope: 'user' });
  assert.equal(bad.scope, 'local'); assert.equal(bad.scopeId, null);
  assert.equal(mk({ scope: 'galaxy' }).scope, 'local');
});

test('page index is clamped: negative → 0, beyond pageCount → last page, junk → 0', () => {
  assert.equal(mk({ pageIndex: -5 }).pageIndex, 0);
  assert.equal(mk({ pageIndex: 999 }).pageIndex, 9);
  assert.equal(mk({ pageIndex: 3.9 }).pageIndex, 3);
  for (const junk of [NaN, 'abc', null, undefined, {}, Infinity]) assert.equal(mk({ pageIndex: junk }).pageIndex, 0, String(junk));
  assert.equal(pg.createProgressRecord({ seriesId: 's', chapterId: 'c', pageIndex: 40, pageCount: 0, now: 1 }).pageIndex, 40, 'unknown pageCount only clamps the lower bound');
  assert.equal(pg.clampPage('7', 5), 4);
});

test('updateProgressRecord is immutable, bumps updatedAt, re-clamps, keeps identity', () => {
  const r = deepFreeze(mk());
  const u = pg.updateProgressRecord(r, { pageIndex: 7, now: 2000 });
  assert.equal(u.pageIndex, 7); assert.equal(u.updatedAt, 2000); assert.equal(r.pageIndex, 2);
  assert.equal(u.chapterId, r.chapterId); assert.equal(u.canonicalChapterId, r.canonicalChapterId);
  assert.equal(pg.updateProgressRecord(r, { pageIndex: 500, now: 1 }).pageIndex, 9);
  assert.equal(pg.updateProgressRecord(r, { pageIndex: -1, now: 1 }).pageIndex, 0);
  const shrunk = pg.updateProgressRecord(r, { pageIndex: 9, pageCount: 4, now: 1 });
  assert.equal(shrunk.pageCount, 4); assert.equal(shrunk.pageIndex, 3);
  assert.equal(pg.updateProgressRecord(r, { now: 9 }).pageIndex, 2, 'no pageIndex in the patch keeps the position');
  assert.equal(pg.updateProgressRecord(null, { pageIndex: 1 }), null);
});

test('percentage: position based, last page = 100, completed = 100, unknown count = 0', () => {
  assert.equal(pg.getProgressPercentage(mk({ pageIndex: 0 })), 10);
  assert.equal(pg.getProgressPercentage(mk({ pageIndex: 4 })), 50);
  assert.equal(pg.getProgressPercentage(mk({ pageIndex: 9 })), 100);
  assert.equal(pg.getProgressPercentage(pg.markChapterCompleted(mk({ pageIndex: 1 }), { now: 5 })), 100);
  assert.equal(pg.getProgressPercentage(pg.createProgressRecord({ seriesId: 's', chapterId: 'c', pageIndex: 3, now: 1 })), 0);
  assert.equal(pg.getProgressPercentage(null), 0);
  assert.equal(pg.getProgressPercentage({ nonsense: true }), 0);
});

test('completion is explicit: reaching the last page alone does not complete', () => {
  const last = pg.updateProgressRecord(mk(), { pageIndex: 9, now: 3 });
  assert.equal(last.completed, false);
  assert.equal(pg.isChapterCompleted(last), false);
  const viaOption = pg.updateProgressRecord(mk(), { pageIndex: 9, now: 3, completeOnLastPage: true });
  assert.equal(viaOption.completed, true); assert.equal(viaOption.completedAt, 3);
  const mid = pg.updateProgressRecord(mk(), { pageIndex: 4, now: 3, completeOnLastPage: true });
  assert.equal(mid.completed, false);
});

test('markChapterCompleted records completedAt, parks on the last page, is idempotent', () => {
  const done = pg.markChapterCompleted(mk(), { now: 5000 });
  assert.equal(done.completed, true); assert.equal(done.completedAt, 5000);
  assert.equal(done.pageIndex, 9); assert.equal(done.updatedAt, 5000);
  assert.equal(pg.isChapterCompleted(done), true);
  const again = pg.markChapterCompleted(done, { now: 9000 });
  assert.equal(again.completedAt, 5000, 'first completion time is kept');
  assert.equal(again.updatedAt, 9000);
  assert.equal(pg.markChapterCompleted(null), null);
});

test('updating a completed record does not silently un-complete it', () => {
  const done = pg.markChapterCompleted(mk(), { now: 10 });
  const moved = pg.updateProgressRecord(done, { pageIndex: 2, now: 20 });
  assert.equal(moved.completed, true); assert.equal(moved.completedAt, 10); assert.equal(moved.pageIndex, 2);
});

test('re-reading: markChapterIncomplete resets to page 0 without corrupting identity', () => {
  const done = pg.markChapterCompleted(mk(), { now: 10 });
  const fresh = pg.markChapterIncomplete(done, { now: 50 });
  assert.equal(fresh.completed, false); assert.equal(fresh.completedAt, null); assert.equal(fresh.pageIndex, 0); assert.equal(fresh.updatedAt, 50);
  for (const k of ['seriesId', 'chapterId', 'canonicalSeriesId', 'canonicalChapterId', 'sourceBindingKey', 'scope', 'pageCount']) assert.equal(fresh[k], done[k], k);
  assert.equal(pg.markChapterIncomplete(done, { now: 1, resetPage: false }).pageIndex, 9);
  assert.equal(done.completed, true, 'input untouched');
  assert.equal(pg.markChapterIncomplete(undefined), null);
});

test('resume page: finished chapters restart, in-progress and re-reads resume', () => {
  assert.equal(pg.getResumePage(mk({ pageIndex: 6 })), 6);
  assert.equal(pg.getResumePage(pg.markChapterCompleted(mk(), { now: 1 })), 0);
  const reread = pg.updateProgressRecord(pg.markChapterCompleted(mk(), { now: 1 }), { pageIndex: 3, now: 2 });
  assert.equal(pg.getResumePage(reread), 3);
  assert.equal(pg.getResumePage(null), 0);
  assert.equal(pg.getResumePage({}), 0);
});

test('malformed records are rejected or normalised, never thrown on', () => {
  for (const bad of [null, undefined, 'x', 5, [], {}, { seriesId: 's' }, { chapterId: 'c' }, { seriesId: '', chapterId: 'c' }]) {
    assert.equal(pg.normalizeProgressRecord(bad), null);
    assert.equal(pg.isChapterCompleted(bad), false);
    assert.equal(pg.getResumePage(bad), 0);
    assert.equal(pg.markChapterCompleted(bad), null);
  }
  const n = pg.normalizeProgressRecord({ seriesId: 's', chapterId: 'c', pageIndex: -9, pageCount: '12', completed: 'yes', completedAt: 'x', updatedAt: 'now', canonicalChapterId: 'nope', scope: 'user' });
  assert.equal(n.pageIndex, 0); assert.equal(n.pageCount, 12); assert.equal(n.completed, false); assert.equal(n.completedAt, null);
  assert.equal(n.updatedAt, 0); assert.equal(n.canonicalChapterId, null); assert.equal(n.scope, 'local');
});

test('normalizeProgressRecord preserves unknown fields (forward compatibility)', () => {
  const n = pg.normalizeProgressRecord(Object.assign(mk(), { futureField: { a: 1 } }));
  assert.deepEqual(n.futureField, { a: 1 });
});

test('record keys: per-chapter, scope-aware and collision-safe for ids containing ":"', () => {
  const k1 = pg.progressRecordKey('local', null, 'A::1', '23');
  const k2 = pg.progressRecordKey('local', null, 'A', '1::23');
  assert.notEqual(k1, k2);
  assert.notEqual(pg.progressRecordKey('local', null, 's', 'c'), pg.progressRecordKey('user', 'u1', 's', 'c'));
  assert.ok(pg.progressRecordKey('local', null, 's', 'c1').startsWith(pg.progressSeriesPrefix('local', null, 's')));
  assert.ok(!pg.progressRecordKey('local', null, 's', 'c1').startsWith(pg.progressSeriesPrefix('local', null, 's2')));
});

test('pickLatestRecord is deterministic', () => {
  const a = mk({ now: 5 }), b = pg.createProgressRecord({ seriesId: 's1', chapterId: 'c2', pageIndex: 0, now: 9 });
  assert.equal(pg.pickLatestRecord([a, b]).chapterId, 'c2');
  assert.equal(pg.pickLatestRecord([b, a]).chapterId, 'c2');
  assert.equal(pg.pickLatestRecord([]), null);
  assert.equal(pg.pickLatestRecord([null, 3]), null);
});
