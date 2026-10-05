'use strict';
/**
 * Stage 1 P1 — progress lifecycle & data integrity.
 * Behavioral tests: real progress store + in-memory window.storage contract. "Reload" = a NEW store
 * instance over the same storage plus a fresh library object, exactly what loadState() does at startup.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ps = require('../../src/services/progressStore.js');
const { createMemoryStorage } = require('./helpers/memoryStorage.js');

const pages = (n) => new Array(n).fill('p');
const P = ps.DEFAULT_PREFIX;
const seriesDef = (id, chapterNums) => ({ id, canonicalId: id, title: id, chapters: chapterNums.map((n) => ({ id: 'c' + n, chapter: String(n), pages: pages(30) })) });
const lib = (seriesList, progress) => ({ series: seriesList, progress: progress || {} });
const store = (st, extra) => ps.createProgressStore(Object.assign({ storage: st }, extra || {}));
const keysOf = (st) => [...st.data.keys()].filter((k) => k.startsWith(P));
const keysFor = (st, sid) => keysOf(st).filter((k) => k.includes(':' + encodeURIComponent(sid) + ':') || k.endsWith(':' + encodeURIComponent(sid)));
/** What the app does on startup. */
async function reload(st, library) { const s = store(st); await s.hydrateLibraryProgress(library); return library; }

// ---------------------------------------------------------------- series removal

test('A: remove series → its progress disappears (records, latest index, nothing left in storage)', async () => {
  const st = createMemoryStorage(); const s = store(st);
  await s.updateChapterProgress({ seriesId: 's1', chapterId: 'c1', pageIndex: 15, pageCount: 30 });
  assert.ok(keysOf(st).length >= 2, 'chapter record + latest index exist');
  const r = await s.clearSeriesProgress('s1');
  assert.equal(r.ok, true);
  assert.deepEqual(keysOf(st), [], 'no key of any kind remains');
  assert.equal((await s.getSeriesProgress('s1')).records.length, 0);
  assert.equal((await s.loadLatest()).records.length, 0);
  assert.equal(await s.getChapterProgress({ seriesId: 's1', chapterId: 'c1' }), null);
});

test('B: read ch A p15 → remove → re-add same series id → hydrate (fresh store): no page-15 progress returns', async () => {
  const st = createMemoryStorage(); const s = store(st);
  const library = lib([seriesDef('s1', [1, 2])]);
  await s.updateChapterProgress({ seriesId: 's1', chapterId: 'c1', pageIndex: 15, pageCount: 30 });
  await s.hydrateLibraryProgress(library);
  assert.equal(library.progress.s1.pageIndex, 15, 'precondition: progress is visible');
  // what the app's removal does: drop the series + legacy view, then purge via the store
  library.series = library.series.filter((x) => x.id !== 's1'); delete library.progress.s1;
  await s.clearSeriesProgress('s1');
  // re-add the same id (later session: new store instance, fresh library object)
  const readded = lib([seriesDef('s1', [1, 2])]);
  const rep = await reload(st, readded);
  assert.equal(readded.progress.s1, undefined, 'no resurrected progress');
  assert.equal(rep && true, true);
  assert.equal(await store(st).getChapterProgress({ seriesId: 's1', chapterId: 'c1' }), null);
});

test('B2: legacy-view-only progress (never migrated) is also not resurrected, because removal deletes the legacy entry', async () => {
  const st = createMemoryStorage();
  const library = lib([seriesDef('s1', [1])], { s1: { chapterId: 'c1', pageIndex: 15, updatedAt: 100 } });
  await store(st).hydrateLibraryProgress(library);                 // migrates legacy → record
  delete library.progress.s1; library.series = [];                 // app removal
  await store(st).clearSeriesProgress('s1');
  const readded = lib([seriesDef('s1', [1])]);                      // saved blob had no progress for s1
  await reload(st, readded);
  assert.equal(readded.progress.s1, undefined);
});

test('C: multiple chapters → remove series → every chapter record disappears; other series are untouched', async () => {
  const st = createMemoryStorage(); const s = store(st);
  for (const n of [1, 2, 3, 4]) await s.updateChapterProgress({ seriesId: 's1', chapterId: 'c' + n, pageIndex: n, pageCount: 30 });
  await s.updateChapterProgress({ seriesId: 's2', chapterId: 'c1', pageIndex: 7, pageCount: 30 });
  await s.updateChapterProgress({ seriesId: 'A', chapterId: '1', pageIndex: 2, pageCount: 30 });
  await s.updateChapterProgress({ seriesId: 'A::1', chapterId: '1', pageIndex: 3, pageCount: 30 }); // id-prefix lookalike
  const r = await s.clearSeriesProgress('A');
  assert.equal(r.ok, true);
  assert.equal(keysFor(st, 'A').length, 0, 'series A fully gone');
  assert.equal((await s.getChapterProgress({ seriesId: 'A::1', chapterId: '1' })).pageIndex, 3, 'lookalike id "A::1" untouched');
  const r1 = await s.clearSeriesProgress('s1');
  assert.equal(r1.ok, true); assert.equal(r1.records.length, 4);
  const fresh = store(st);
  for (const n of [1, 2, 3, 4]) assert.equal(await fresh.getChapterProgress({ seriesId: 's1', chapterId: 'c' + n }), null);
  assert.equal((await fresh.getSeriesProgress('s1')).records.length, 0);
  assert.equal((await fresh.getChapterProgress({ seriesId: 's2', chapterId: 'c1' })).pageIndex, 7, 'other series untouched');
  assert.equal((await fresh.loadLatest()).records.some((x) => x.seriesId === 's1'), false, 'latest index dropped too');
});

test('clearSeriesProgress reports failure honestly (listing unavailable / delete failed / bad input) and never throws', async () => {
  const noList = createMemoryStorage({ failList: true }); const a = store(noList);
  await a.updateChapterProgress({ seriesId: 's1', chapterId: 'c1', pageIndex: 1 });
  const r = await a.clearSeriesProgress('s1');
  assert.equal(r.ok, false); assert.equal(r.code, 'LIST_UNAVAILABLE');
  assert.equal(await a.getChapterProgress({ seriesId: 's1', chapterId: 'c1' }), null, 'the cached key was still dropped');
  const st = createMemoryStorage(); const b = store(st);
  await b.updateChapterProgress({ seriesId: 's1', chapterId: 'c1', pageIndex: 1 });
  const realDelete = st.delete; st.delete = () => Promise.resolve(null);
  assert.equal((await b.clearSeriesProgress('s1')).code, 'DELETE_FAILED');
  st.delete = realDelete;
  assert.equal((await b.clearSeriesProgress('')).code, 'INVALID_REFERENCE');
  assert.equal((await store(null).clearSeriesProgress('s1')).code, 'STORAGE_UNAVAILABLE');
});

test('clearSeriesProgress is queued behind in-flight writes: a slow earlier save cannot land after it', async () => {
  const st = createMemoryStorage({ setDelay: () => 10 }); const s = store(st);
  const w = s.updateChapterProgress({ seriesId: 's1', chapterId: 'c1', pageIndex: 5, pageCount: 30 });
  const c = s.clearSeriesProgress('s1');
  await Promise.all([w, c]);
  assert.deepEqual(keysFor(st, 's1'), []);
});

// ---------------------------------------------------------------- Undo semantics

test('Undo (explicit) restores exactly the removed progress; a NORMAL re-add never does (Remove + re-add ≠ Undo)', async () => {
  const st = createMemoryStorage(); const s = store(st);
  await s.updateChapterProgress({ seriesId: 's1', chapterId: 'c1', pageIndex: 15, pageCount: 30, now: 500 });
  await s.updateChapterProgress({ seriesId: 's1', chapterId: 'c2', pageIndex: 4, pageCount: 30, now: 400 });
  const removed = await s.clearSeriesProgress('s1');
  assert.equal(removed.records.length, 2, 'removal hands back what it deleted');
  // normal re-add path → nothing comes back
  const normal = lib([seriesDef('s1', [1, 2])]);
  await reload(st, normal);
  assert.equal(normal.progress.s1, undefined);
  // Undo path → restore through the store, then hydrate
  const r = await s.restoreSeriesProgress('s1', removed.records);
  assert.equal(r.ok, true); assert.equal(r.written, 2);
  const undone = lib([seriesDef('s1', [1, 2])]);
  await reload(st, undone);
  assert.equal(undone.progress.s1.chapterId, 'c1'); assert.equal(undone.progress.s1.pageIndex, 15); assert.equal(undone.progress.s1.updatedAt, 500);
  assert.equal((await store(st).getChapterProgress({ seriesId: 's1', chapterId: 'c2' })).pageIndex, 4);
});

test('restoreSeriesProgress refuses records that belong to a different series', async () => {
  const st = createMemoryStorage(); const s = store(st);
  await s.updateChapterProgress({ seriesId: 'other', chapterId: 'c1', pageIndex: 3 });
  const other = (await s.clearSeriesProgress('other')).records;
  const r = await s.restoreSeriesProgress('s1', other);
  assert.equal(r.written, 0); assert.equal(r.ok, false);
  assert.deepEqual(keysFor(st, 'other'), []);
  assert.deepEqual(keysFor(st, 's1'), []);
});

// ---------------------------------------------------------------- import replacement

const importedLibrary = (progress, chapters) => lib([seriesDef('s1', chapters || [9, 10, 11])], progress);

test('D: local ch10 p18 vs imported ch10 p4 → after import + reload, ch10 is page 4 (not 18)', async () => {
  const st = createMemoryStorage();
  await store(st).updateChapterProgress({ seriesId: 's1', chapterId: 'c10', pageIndex: 18, pageCount: 30, now: 9000 }); // local is NEWER
  const imported = importedLibrary({ s1: { chapterId: 'c10', pageIndex: 4, updatedAt: 1000 } });
  const r = await store(st).replaceProgressFromLibrary(imported);
  assert.equal(r.ok, true);
  // reload: the app persisted `imported` as the library blob; fresh library object + fresh store
  const reloaded = importedLibrary({ s1: { chapterId: 'c10', pageIndex: 4, updatedAt: 1000 } });
  await reload(st, reloaded);
  assert.equal(reloaded.progress.s1.chapterId, 'c10'); assert.equal(reloaded.progress.s1.pageIndex, 4);
  assert.equal((await store(st).getChapterProgress({ seriesId: 's1', chapterId: 'c10' })).pageIndex, 4);
});

test('D-control: WITHOUT the replacement, the stale newer local record wins (documents the original defect)', async () => {
  const st = createMemoryStorage();
  await store(st).updateChapterProgress({ seriesId: 's1', chapterId: 'c10', pageIndex: 18, pageCount: 30, now: 9000 });
  const reloaded = importedLibrary({ s1: { chapterId: 'c10', pageIndex: 4, updatedAt: 1000 } });
  await reload(st, reloaded);
  assert.equal(reloaded.progress.s1.pageIndex, 18);
});

test('E: import a backup with zero progress → old local progress does not return after reload', async () => {
  const st = createMemoryStorage(); const s = store(st);
  await s.updateChapterProgress({ seriesId: 's1', chapterId: 'c10', pageIndex: 18, pageCount: 30 });
  await s.updateChapterProgress({ seriesId: 's2', chapterId: 'c1', pageIndex: 2, pageCount: 30 });
  const r = await s.replaceProgressFromLibrary(importedLibrary({}));
  assert.equal(r.ok, true); assert.equal(r.migrated, 0);
  assert.deepEqual(keysOf(st), [], 'storage holds no progress at all');
  const reloaded = importedLibrary({});
  await reload(st, reloaded);
  assert.deepEqual(reloaded.progress, {});
  // also when the backup omitted `progress` entirely
  await store(st).replaceProgressFromLibrary({ series: [seriesDef('s1', [10])] });
  assert.deepEqual(keysOf(st), []);
});

test('F: import has Chapter B progress → old Chapter A progress does not survive (A and B records, latest index)', async () => {
  const st = createMemoryStorage(); const s = store(st);
  await s.updateChapterProgress({ seriesId: 's1', chapterId: 'c9', pageIndex: 12, pageCount: 30, now: 9000 }); // chapter A
  const imported = importedLibrary({ s1: { chapterId: 'c11', pageIndex: 6, updatedAt: 100 } });              // chapter B
  await s.replaceProgressFromLibrary(imported);
  const fresh = store(st);
  assert.equal(await fresh.getChapterProgress({ seriesId: 's1', chapterId: 'c9' }), null, 'old chapter A record gone');
  assert.equal((await fresh.getChapterProgress({ seriesId: 's1', chapterId: 'c11' })).pageIndex, 6);
  assert.equal((await fresh.getSeriesProgress('s1')).records.length, 1);
  const reloaded = importedLibrary({ s1: { chapterId: 'c11', pageIndex: 6, updatedAt: 100 } });
  await reload(st, reloaded);
  assert.equal(reloaded.progress.s1.chapterId, 'c11');
});

test('G: import → NEW store instance → hydrate → imported progress remains (and is stable across repeated hydrates)', async () => {
  const st = createMemoryStorage();
  await store(st).updateChapterProgress({ seriesId: 's1', chapterId: 'c10', pageIndex: 18, pageCount: 30, now: 9000 });
  await store(st).replaceProgressFromLibrary(importedLibrary({ s1: { chapterId: 'c10', pageIndex: 4, updatedAt: 1000 } }));
  for (let i = 0; i < 3; i++) {
    const l = importedLibrary({ s1: { chapterId: 'c10', pageIndex: 4, updatedAt: 1000 } });
    const rep = await store(st).hydrateLibraryProgress(l);
    assert.equal(rep.ok, true);
    assert.equal(l.progress.s1.pageIndex, 4, 'hydrate #' + (i + 1));
  }
});

test('import keeps progress that cannot be mapped to a chapter in the library blob (nothing silently dropped) and still clears stale records', async () => {
  const st = createMemoryStorage();
  await store(st).updateChapterProgress({ seriesId: 's1', chapterId: 'c10', pageIndex: 18, pageCount: 30, now: 9000 });
  const weak = lib([{ id: 's1', title: 'Weak', chapters: [{ id: 'w1', title: 'Prologue', pages: pages(3) }] }], { s1: { chapterId: 'w1', pageIndex: 1, updatedAt: 5 } });
  const r = await store(st).replaceProgressFromLibrary(weak);
  assert.equal(r.ok, true); assert.equal(r.migrated, 0); assert.equal(r.preserved.length, 1);
  assert.equal(await store(st).getChapterProgress({ seriesId: 's1', chapterId: 'c10' }), null);
  assert.equal(weak.progress.s1.chapterId, 'w1', 'legacy entry untouched');
});

test('failed replacement never mixes stale + new: if clearing fails nothing is written', async () => {
  const st = createMemoryStorage(); const s = store(st);
  await s.updateChapterProgress({ seriesId: 's1', chapterId: 'c10', pageIndex: 18, pageCount: 30 });
  st.delete = () => Promise.resolve(null);
  const r = await s.replaceProgressFromLibrary(importedLibrary({ s1: { chapterId: 'c11', pageIndex: 6, updatedAt: 100 } }));
  assert.equal(r.ok, false); assert.equal(r.code, 'DELETE_FAILED');
  assert.equal(await store(st).getChapterProgress({ seriesId: 's1', chapterId: 'c11' }), null, 'imported record not written on top of stale ones');
  const ra = await s.replaceAllProgress([{ seriesId: 's1', chapterId: 'c11', pageIndex: 1 }]);
  assert.equal(ra.ok, false); assert.equal(ra.written, 0);
});

test('clearAllProgress / replaceAllProgress touch only their own scope', async () => {
  const st = createMemoryStorage();
  const local = store(st); const user = store(st, { scope: 'user', scopeId: 'u1' });
  await local.updateChapterProgress({ seriesId: 's1', chapterId: 'c1', pageIndex: 1 });
  await user.updateChapterProgress({ seriesId: 's1', chapterId: 'c1', pageIndex: 9 });
  assert.equal((await local.clearAllProgress()).ok, true);
  assert.equal(await store(st).getChapterProgress({ seriesId: 's1', chapterId: 'c1' }), null);
  assert.equal((await store(st, { scope: 'user', scopeId: 'u1' }).getChapterProgress({ seriesId: 's1', chapterId: 'c1' })).pageIndex, 9, 'user scope survives');
  assert.equal((await local.loadLatest()).records.length, 0);
  assert.equal((await store(st, { scope: 'user', scopeId: 'u1' }).loadLatest()).records.length, 1);
  const rec = (await user.getChapterProgress({ seriesId: 's1', chapterId: 'c1' }));
  const r = await local.replaceAllProgress([{ seriesId: 's2', chapterId: 'c3', pageIndex: 2 }, { nope: true }]);
  assert.equal(r.written, 1); assert.equal(r.skipped, 1); assert.equal(r.ok, false);
  assert.equal((await store(st).getChapterProgress({ seriesId: 's2', chapterId: 'c3' })).pageIndex, 2);
  assert.ok(rec);
});

// ---------------------------------------------------------------- wiring (index.html uses the canonical operations)

const html = fs.readFileSync(path.resolve(__dirname, '../../index.html'), 'utf8');

test('wiring: every removal path goes through removeSeriesAndProgress → progStore.clearSeriesProgress; no handler edits progress itself', () => {
  assert.equal((html.match(/removeSeriesAndProgress\(/g) || []).length, 3, 'definition + sheet-remove-series + remove-series');
  const sheet = html.slice(html.indexOf('action === "sheet-remove-series"){'), html.indexOf('// Detect a long-press'));
  const main = html.slice(html.indexOf('else if(action === "remove-series"){'), html.indexOf('else if(action === "cancel-remove-series"){'));
  for (const [name, body] of [['sheet-remove-series', sheet], ['remove-series', main]]) {
    assert.ok(body.includes('removeSeriesAndProgress(id)'), name + ' uses the canonical removal');
    assert.ok(!/delete state\.progress/.test(body) && !/state\.progress\[id\]\s*=/.test(body), name + ' does not edit progress directly');
    assert.ok(body.includes('undoSeriesRemoval('), name + ' undo goes through undoSeriesRemoval');
  }
  const helper = html.slice(html.indexOf('function purgeSeriesProgress'), html.indexOf('function importLibraryData'));
  assert.ok(helper.includes('progStore.clearSeriesProgress(id)'));
  assert.ok(helper.includes('progStore.restoreSeriesProgress('), 'Undo restores through the progress store');
  const prune = html.slice(html.indexOf('function pruneDemoIfRealLibrary'), html.indexOf('function buildDemoSeries'));
  assert.ok(prune.includes('purgeSeriesProgress('), 'demo-series pruning also purges stored progress');
});

test('wiring: importLibraryData replaces stored progress through the store, only after the library write succeeded', () => {
  const imp = html.slice(html.indexOf('function importLibraryData'), html.indexOf('var autoSyncTimer=null'));
  assert.ok(imp.includes('progStore.replaceProgressFromLibrary(state)'));
  assert.ok(imp.indexOf('replaceLibrary(state') < imp.indexOf('replaceProgressFromLibrary'), 'library persisted first');
  assert.ok(imp.indexOf('if(!res) return;') < imp.indexOf('replaceProgressFromLibrary'), 'skipped when the library write failed');
});

test('wiring: the UI layer never touches progress-store storage keys', () => {
  assert.equal(/mangahive-progress-v1/.test(html), false);
});
