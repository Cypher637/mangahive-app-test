'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ps = require('../../src/services/progressStore.js');
const ls = require('../../src/services/libraryStore.js');
const pg = require('../../src/domain/progress.js');
const { createMemoryStorage, deepFreeze } = require('./helpers/memoryStorage.js');

const pages = (n) => new Array(n).fill('p');
const library = () => ({
  series: [
    { id: 's1', canonicalId: 's1', title: 'One', chapters: [{ id: 'c1', chapter: '1', pages: pages(10) }, { id: 'c2', chapter: '2', pages: pages(8), sources: [{ sourceId: 'md', remoteId: 'r2' }] }] },
    { id: 's2', title: 'Two (legacy, no canonicalId)', chapters: [{ id: 'k1', chapter: '5', pages: pages(4) }] },
    { id: 's3', title: 'Weak', chapters: [{ id: 'w1', title: 'Prologue', pages: pages(3) }] }
  ],
  progress: {
    s1: { chapterId: 'c2', pageIndex: 3, updatedAt: 500, legacyExtra: 'keep-me' },
    s2: { chapterId: 'k1', pageIndex: 99, updatedAt: 700 },
    s3: { chapterId: 'w1', pageIndex: 1, updatedAt: 800 },
    gone: { chapterId: 'x', pageIndex: 1, updatedAt: 1 },
    s1missing: 'garbage'
  },
  unknownField: { stays: true }
});

test('legacy → records: confident chapters convert, with canonical ids, clamping and legacy timestamps', () => {
  const res = pg.migrateLegacyProgress(library().progress, library(), {});
  const by = Object.fromEntries(res.records.map((r) => [r.seriesId, r]));
  assert.deepEqual(Object.keys(by).sort(), ['s1', 's2']);
  assert.equal(by.s1.chapterId, 'c2'); assert.equal(by.s1.canonicalChapterId, 'mhch:s1:2'); assert.equal(by.s1.pageIndex, 3); assert.equal(by.s1.pageCount, 8); assert.equal(by.s1.updatedAt, 500);
  assert.equal(by.s1.sourceBindingKey, 'builtin:md\u001fmd\u001fr2');
  assert.equal(by.s2.pageIndex, 3, 'page 99 clamped to last page of 4');
  assert.equal(by.s2.canonicalSeriesId, 's2', 'series without canonicalId falls back to its id');
  assert.equal(by.s1.completed, false);
});

test('unconfident or unresolvable legacy entries are PRESERVED with a reason, never mapped', () => {
  const res = pg.migrateLegacyProgress(library().progress, library(), {});
  const reasons = Object.fromEntries(res.preserved.map((p) => [p.seriesId, p.reason]));
  assert.equal(reasons.s3, 'canonical-identity-not-confident');
  assert.equal(reasons.gone, 'series-not-found');
  assert.equal(reasons.s1missing, 'malformed-legacy-record');
  assert.equal(res.stats.legacy, 5); assert.equal(res.stats.migrated, 2); assert.equal(res.stats.preserved, 3);
  const lib = library(); lib.progress.s1.chapterId = 'ghost';
  assert.equal(pg.migrateLegacyProgress(lib.progress, lib, {}).preserved.find((p) => p.seriesId === 's1').reason, 'chapter-not-found');
});

test('deterministic: same input → deep-equal output, no clock involved', () => {
  const a = pg.migrateLegacyProgress(library().progress, library(), {});
  const b = pg.migrateLegacyProgress(library().progress, library(), {});
  assert.deepEqual(a, b);
});

test('non-destructive: the legacy map and library are never edited (deep-frozen inputs)', () => {
  const lib = deepFreeze(library());
  assert.doesNotThrow(() => pg.migrateLegacyProgress(lib.progress, lib, {}));
});

test('safe with missing / malformed pieces', () => {
  for (const [legacy, lib] of [[undefined, undefined], [null, {}], [{}, { series: 'x' }], [[], { series: [] }], [{ s: { chapterId: 5 } }, { series: [{ id: 's', chapters: 'nope' }] }], [{ s: {} }, { series: [null, 4] }]]) {
    assert.doesNotThrow(() => pg.migrateLegacyProgress(legacy, lib, {}));
    assert.deepEqual(pg.migrateLegacyProgress(legacy, lib, {}).records, []);
  }
  const lib = { series: [{ id: 's', chapters: [{ id: 'c', chapter: '1' }] }] };
  const r = pg.migrateLegacyProgress({ s: { chapterId: 'c' } }, lib, {});
  assert.equal(r.records[0].pageIndex, 0); assert.equal(r.records[0].updatedAt, 0); assert.equal(r.records[0].pageCount, 0);
});

test('numeric legacy chapter ids are matched as strings', () => {
  const lib = { series: [{ id: 's', chapters: [{ id: 7, chapter: '1' }] }] };
  assert.equal(pg.migrateLegacyProgress({ s: { chapterId: 7, pageIndex: 1, updatedAt: 3 } }, lib, {}).records.length, 1);
});

test('hydrateLegacy writes records once and is idempotent', async () => {
  const st = createMemoryStorage(); const store = ps.createProgressStore({ storage: st });
  const lib = library();
  const r1 = await store.hydrateLegacy(lib);
  assert.equal(r1.ok, true); assert.equal(r1.migrated, 2); assert.equal(r1.alreadyPresent, 0); assert.equal(r1.preserved.length, 3);
  const snapshot = new Map(st.data);
  const writes = st.calls.set.length;
  const r2 = await store.hydrateLegacy(lib);
  assert.equal(r2.migrated, 0); assert.equal(r2.alreadyPresent, 2);
  assert.equal(st.calls.set.length, writes, 'second run performs no writes');
  assert.deepEqual([...st.data], [...snapshot]);
  const fresh = ps.createProgressStore({ storage: st });
  assert.equal((await fresh.hydrateLegacy(lib)).migrated, 0, 'repeat-safe across instances/restarts');
});

test('hydration never deletes or edits the legacy progress (non-destructive, backward compatible)', async () => {
  const st = createMemoryStorage(); const store = ps.createProgressStore({ storage: st });
  const lib = library(); const before = JSON.stringify(lib);
  await store.hydrateLegacy(lib);
  assert.equal(JSON.stringify(lib), before);
  assert.equal(st.calls.delete.length, 0);
});

test('a newer per-chapter record never gets clobbered by an older legacy entry; a strictly newer legacy entry wins', async () => {
  const st = createMemoryStorage(); const store = ps.createProgressStore({ storage: st, now: () => 9000 });
  await store.updateChapterProgress({ seriesId: 's1', chapterId: 'c2', pageIndex: 7, pageCount: 8, now: 9000 });
  await store.hydrateLegacy(library());
  assert.equal((await store.getChapterProgress({ seriesId: 's1', chapterId: 'c2' })).pageIndex, 7);
  const st2 = createMemoryStorage(); const s2 = ps.createProgressStore({ storage: st2 });
  await s2.updateChapterProgress({ seriesId: 's1', chapterId: 'c2', pageIndex: 7, pageCount: 8, now: 100 });
  await s2.hydrateLegacy(library());
  assert.equal((await s2.getChapterProgress({ seriesId: 's1', chapterId: 'c2' })).pageIndex, 3, 'legacy updatedAt=500 is newer than 100');
});

test('hydrateLibraryProgress projects newer records onto the legacy view and keeps unknown legacy fields', async () => {
  const st = createMemoryStorage(); const store = ps.createProgressStore({ storage: st });
  await store.updateChapterProgress({ seriesId: 's1', chapterId: 'c1', pageIndex: 6, pageCount: 10, now: 5000 });
  const lib = library();
  const rep = await store.hydrateLibraryProgress(lib);
  assert.equal(rep.ok, true); assert.equal(rep.migration.migrated, 2);
  assert.deepEqual(lib.progress.s1, { chapterId: 'c1', pageIndex: 6, updatedAt: 5000, legacyExtra: 'keep-me' });
  assert.equal(lib.progress.s2.chapterId, 'k1', 'untouched where the record is not newer');
  assert.equal(lib.progress.s3.chapterId, 'w1', 'unmigratable legacy entry survives untouched');
  assert.equal(lib.progress.gone.chapterId, 'x'); assert.equal(lib.progress.s1missing, 'garbage');
  assert.deepEqual(lib.unknownField, { stays: true });
  const rep2 = await store.hydrateLibraryProgress(lib);
  assert.equal(rep2.legacyViewUpdated, 0, 'idempotent');
});

test('records for series that are not in the library are not resurrected into state.progress', async () => {
  const st = createMemoryStorage(); const store = ps.createProgressStore({ storage: st });
  await store.updateChapterProgress({ seriesId: 'removed-series', chapterId: 'c', pageIndex: 3, now: 9 });
  const lib = library(); await store.hydrateLibraryProgress(lib);
  assert.equal(lib.progress['removed-series'], undefined);
});

test('hydration fills in a missing progress container and rejects non-libraries', async () => {
  const store = ps.createProgressStore({ storage: createMemoryStorage() });
  const lib = { series: [] }; await store.hydrateLibraryProgress(lib);
  assert.deepEqual(lib.progress, {});
  assert.equal((await store.hydrateLibraryProgress(null)).code, 'INVALID_LIBRARY');
});

test('end-to-end: library blob → legacy migration → targeted updates → reload shows the newest position', async () => {
  const st = createMemoryStorage(); st.data.set('fairs-library-v1', JSON.stringify(library()));
  const libStore = ls.createLibraryStore({ storage: st }); const progStore = ps.createProgressStore({ storage: st, now: () => 10000 });
  const loaded = (await libStore.loadLibrary()).library;
  await progStore.hydrateLibraryProgress(loaded);
  const libBytes = st.data.get('fairs-library-v1');
  await progStore.updateChapterProgress({ seriesId: 's2', chapterId: 'k1', pageIndex: 2, pageCount: 4 });
  assert.equal(st.data.get('fairs-library-v1'), libBytes, 'library blob untouched by progress updates');
  const reloaded = (await ls.createLibraryStore({ storage: st }).loadLibrary()).library;
  await ps.createProgressStore({ storage: st }).hydrateLibraryProgress(reloaded);
  assert.equal(reloaded.progress.s2.pageIndex, 2); assert.equal(reloaded.progress.s2.updatedAt, 10000);
});

test('projectLegacyProgress is pure and only emits strictly newer entries', () => {
  const recs = [pg.createProgressRecord({ seriesId: 's', chapterId: 'a', pageIndex: 1, now: 10 }), pg.createProgressRecord({ seriesId: 's', chapterId: 'b', pageIndex: 2, now: 20 })];
  assert.deepEqual(pg.projectLegacyProgress(recs, { s: { chapterId: 'z', pageIndex: 0, updatedAt: 15 } }), { s: { chapterId: 'b', pageIndex: 2, updatedAt: 20 } });
  assert.deepEqual(pg.projectLegacyProgress(recs, { s: { chapterId: 'z', pageIndex: 0, updatedAt: 20 } }), {});
  assert.deepEqual(pg.projectLegacyProgress(recs, {}), { s: { chapterId: 'b', pageIndex: 2, updatedAt: 20 } });
  assert.deepEqual(pg.projectLegacyProgress(null, null), {});
});
