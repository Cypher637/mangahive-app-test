'use strict';
/**
 * Stage 2 P1 — startup, migration & recovery hardening. Behavioral tests (A–H) against the real
 * libraryStore / progressStore / startupCoordinator over the in-memory window.storage contract.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ls = require('../../src/services/libraryStore.js');
const ps = require('../../src/services/progressStore.js');
const sc = require('../../src/services/startupCoordinator.js');
const { createMemoryStorage } = require('./helpers/memoryStorage.js');
const { loadAppFunctions } = require('./helpers/appFunctions.js');

const KEY = 'fairs-library-v1';
const LEGACY = 'panel-library-v1';
const P = ps.DEFAULT_PREFIX;
const pages = (n) => new Array(n).fill('p');
const series = (id, nums) => ({ id, canonicalId: id, title: id, chapters: nums.map((n) => ({ id: 'c' + n, chapter: String(n), pages: pages(30) })) });
const libOf = (list, progress) => ({ series: list, progress: progress || {}, history: [], bookmarks: {}, ratings: {} });
let tick = 1000;
const mkLib = (st, extra) => ls.createLibraryStore(Object.assign({ storage: st, now: () => (tick += 1) }, extra || {}));
const mkProg = (st) => ps.createProgressStore({ storage: st });
const tick0 = () => new Promise((r) => setImmediate(r));

/** A storage whose reads of the library key stay pending until released (simulates slow/hung storage). */
function gatedStorage(opts) {
  const st = createMemoryStorage(opts);
  const realGet = st.get;
  let release = null, gate = null, held = false;
  st.hold = () => { held = true; gate = new Promise((r) => { release = r; }); };
  st.release = () => { held = false; release(); };
  st.get = function (key) {
    if (held && (key === KEY || key === LEGACY)) return gate.then(() => realGet.call(st, key));
    return realGet.call(st, key);
  };
  return st;
}

/** Coordinator wired to fake host hooks that record everything the app would do. */
function harness(st, extra) {
  const e = extra || {};
  const lib = mkLib(st);
  const prog = mkProg(st);
  const host = { state: { series: [], progress: {} }, events: [], notices: [], errors: [], refused: 0, timerFn: null, cleared: 0, finalized: 0, saves: 0 };
  const coord = sc.createStartupCoordinator({
    load: () => lib.loadLibrary(),
    deleteLegacyKey: () => lib.deleteLegacyKey(),
    progStore: e.noProg ? null : prog,
    hasStorage: e.hasStorage || (() => true),
    setTimer: (fn) => { host.timerFn = fn; return 1; },
    clearTimer: () => { host.cleared += 1; host.timerFn = null; },
    hooks: {
      adopt: (library) => { host.state = library; host.events.push('adopt'); },
      finalize: () => { host.finalized += 1; host.events.push('finalize'); return e.finalize ? e.finalize(host) : undefined; },
      save: () => { host.saves += 1; return lib.saveLibrary(host.state); },
      present: (info) => host.events.push(info.fallback ? 'present-fallback' : (info.blocked ? 'present-blocked' : 'present')),
      refresh: () => host.events.push('refresh'),
      notify: (m, k) => host.notices.push({ m, k }),
      logError: (c, err) => host.errors.push({ c, m: String(err && err.message || err) }),
      pendingEdits: () => host.refused,
      onLoadedChange: (v) => host.events.push('loaded=' + v)
    }
  });
  return { host, coord, lib, prog };
}

/** What the app's saveState() does with the gate. Returns the library-store result or null when refused. */
async function appSave(h) {
  if (!h.coord.isLoaded()) { h.host.refused += 1; return null; }
  return h.lib.saveLibrary(h.host.state);
}

// ------------------------------------------------------------------------------------------------ A

test('A: delayed storage → failsafe fires → real library arrives late → adopted, finalized (migration), hydrated, refreshed', async () => {
  const st = gatedStorage();
  const real = libOf([series('s1', [1, 2])], { s1: { chapterId: 'c2', pageIndex: 7, updatedAt: 500 } });
  real.collections = { favorites: ['s1'], reading: [], completed: [], plan: [] };
  st.data.set(KEY, JSON.stringify(real));
  st.hold();
  const h = harness(st);
  const started = h.coord.start();
  await tick0();
  assert.equal(h.coord.isLoaded(), false, 'nothing loaded yet');
  h.host.timerFn();                                           // 8s failsafe fires
  assert.deepEqual(h.host.events.filter((x) => x.startsWith('present')), ['present-fallback']);
  assert.equal(h.coord.isLoaded(), false, 'failsafe does not open the save gate');
  assert.ok(h.host.notices.some((n) => n.k === 'recovery' && /reload/i.test(n.m)), 'user is told, not left with a silent empty library');
  st.release();                                               // storage finally answers
  const out = await started;
  assert.equal(out.applied, true); assert.equal(out.late, true);
  assert.deepEqual(h.host.state.series.map((s) => s.id), ['s1'], 'real library adopted');
  assert.equal(h.host.finalized, 1, 'finalize (normalisation + canonical migration) ran for the late library');
  assert.ok(h.host.events.indexOf('adopt') < h.host.events.indexOf('finalize'), 'adopt → finalize');
  assert.ok(h.host.events.includes('refresh'), 'UI refreshed');
  assert.equal(h.host.events.filter((x) => x === 'present').length, 0, 'no second first-presentation');
  assert.equal(h.coord.isLoaded(), true, 'gate opens only now');
  // progress hydration ran against the late library
  const rec = await mkProg(st).getChapterProgress({ seriesId: 's1', chapterId: 'c2' });
  assert.ok(rec && rec.pageIndex === 7, 'legacy progress was migrated into a record');
});

test('A2: a library that arrives in time is finalized once and presented once (no refresh, no failsafe notice)', async () => {
  const st = createMemoryStorage();
  st.data.set(KEY, JSON.stringify(libOf([series('s1', [1])])));
  const h = harness(st);
  const out = await h.coord.start();
  assert.equal(out.late, false);
  assert.equal(h.host.finalized, 1);
  assert.deepEqual(h.host.events.filter((x) => /^(present|refresh)/.test(x)), ['present']);
  assert.equal(h.host.cleared >= 1, true, 'failsafe timer cleared');
  assert.equal(h.host.notices.length, 0);
});

// ------------------------------------------------------------------------------------------------ B

test('B: migration is idempotent — library migration, progress hydration and re-delivery of the same result change nothing', async () => {
  const st = createMemoryStorage();
  const raw = { series: [series('s1', [1, 2])], progress: { s1: { chapterId: 'c1', pageIndex: 5, updatedAt: 300 } }, extra: { keep: true } };
  // library-level migration
  const once = ls.migrateLibrary(raw).library;
  const twice = ls.migrateLibrary(once).library;
  assert.deepEqual(twice, once); assert.equal(ls.migrateLibrary(once).changed, false);
  // progress hydration, run twice over the same storage
  const prog = mkProg(st);
  const L = libOf([series('s1', [1, 2])], { s1: { chapterId: 'c1', pageIndex: 5, updatedAt: 300 } });
  const r1 = await prog.hydrateLibraryProgress(L);
  const afterFirst = JSON.stringify(L); const keysFirst = JSON.stringify([...st.data.entries()]);
  const writesFirst = st.calls.set.length;
  const r2 = await prog.hydrateLibraryProgress(L);
  assert.equal(r1.migration.migrated, 1); assert.equal(r2.migration.migrated, 0, 'second pass migrates nothing');
  assert.equal(JSON.stringify(L), afterFirst, 'library identical');
  assert.equal(JSON.stringify([...st.data.entries()]), keysFirst, 'storage identical');
  assert.equal(st.calls.set.length, writesFirst, 'second pass performs zero writes');
  // coordinator: the same load result delivered twice is applied once
  const st2 = createMemoryStorage(); st2.data.set(KEY, JSON.stringify(libOf([series('s1', [1])])));
  const h = harness(st2);
  await h.coord.start();
  const adopts = h.host.events.filter((x) => x === 'adopt').length;
  assert.equal(adopts, 1);
  assert.equal((await h.coord.start()).applied, true, 'start() is itself idempotent (returns the same run)');
  assert.equal(h.host.events.filter((x) => x === 'adopt').length, 1);
});

test('B2: the REAL migrateCanonicalState from index.html is repeat-safe (second run reports no change, state identical)', () => {
  const app = loadAppFunctions(['migrateCanonicalState']);
  app.run("state.series = [{ id: 's1', title: 'One Piece', chapters: [{ id: 'c1', chapter: '1', pages: [] }, { id: 'c2', chapter: '2' }] }, { id: 's2', title: 'Naruto', chapters: [] }];");
  assert.equal(app.run('migrateCanonicalState()'), true, 'first run migrates legacy series');
  const snap = app.run('JSON.stringify(state)');
  assert.equal(app.run('migrateCanonicalState()'), false, 'second run reports no change');
  assert.equal(app.run('JSON.stringify(state)'), snap, 'state byte-identical after the second run');
  assert.equal(app.run('state.series.every(function(s){ return s.canonicalModelVersion === CANONICAL_MODEL_VERSION; })'), true);
  assert.deepEqual(JSON.parse(snap).series.map((s) => s.id), ['s1', 's2'], 'identities untouched');
});

// ------------------------------------------------------------------------------------------------ C

test('C: latest index proves migration unnecessary → no per-chapter legacy reads; index that cannot prove it → reads happen', async () => {
  const st = createMemoryStorage();
  const prog = mkProg(st);
  await prog.updateChapterProgress({ seriesId: 's1', chapterId: 'c1', pageIndex: 5, pageCount: 30, now: 300 });
  await prog.updateChapterProgress({ seriesId: 's2', chapterId: 'c1', pageIndex: 9, pageCount: 30, now: 400 });
  const L = libOf([series('s1', [1, 2]), series('s2', [1])], {
    s1: { chapterId: 'c1', pageIndex: 5, updatedAt: 300 },
    s2: { chapterId: 'c1', pageIndex: 9, updatedAt: 400 }
  });
  const fresh = mkProg(st);                       // new session: empty cache
  st.calls.get.length = 0; st.calls.set.length = 0;
  const rep = await fresh.hydrateLibraryProgress(L);
  const chapterReads = st.calls.get.filter((k) => k.startsWith(P) && !k.startsWith(P + 'latest:'));
  assert.deepEqual(chapterReads, [], 'no per-chapter record reads');
  assert.equal(rep.legacyReadsSkipped, 2);
  assert.equal(st.calls.set.length, 0, 'and nothing written');
  assert.equal(rep.migration.migrated, 0);
  assert.equal(L.progress.s1.pageIndex, 5);

  // correctness guard 1: legacy entry NEWER than the index → must be read and migrated
  const L2 = libOf([series('s1', [1, 2])], { s1: { chapterId: 'c1', pageIndex: 20, updatedAt: 900 } });
  const r2 = await mkProg(st).hydrateLibraryProgress(L2);
  assert.equal(r2.legacyReadsSkipped, 0); assert.equal(r2.migration.migrated, 1);
  assert.equal((await mkProg(st).getChapterProgress({ seriesId: 's1', chapterId: 'c1' })).pageIndex, 20);

  // correctness guard 2: index points at a DIFFERENT chapter → the legacy chapter's record must still be created
  const st3 = createMemoryStorage(); const p3 = mkProg(st3);
  await p3.updateChapterProgress({ seriesId: 's1', chapterId: 'c2', pageIndex: 3, pageCount: 30, now: 800 });
  const L3 = libOf([series('s1', [1, 2])], { s1: { chapterId: 'c1', pageIndex: 11, updatedAt: 100 } });
  const r3 = await mkProg(st3).hydrateLibraryProgress(L3);
  assert.equal(r3.legacyReadsSkipped, 0);
  assert.equal((await mkProg(st3).getChapterProgress({ seriesId: 's1', chapterId: 'c1' })).pageIndex, 11, 'older chapter progress not lost');
  assert.equal(L3.progress.s1.chapterId, 'c2', 'legacy view shows the newest chapter');

  // correctness guard 3: index unavailable (list fails) → full path, nothing skipped
  const st4 = createMemoryStorage(); await mkProg(st4).updateChapterProgress({ seriesId: 's1', chapterId: 'c1', pageIndex: 5, pageCount: 30, now: 300 });
  st4.failList = true;
  const r4 = await mkProg(st4).hydrateLibraryProgress(libOf([series('s1', [1])], { s1: { chapterId: 'c1', pageIndex: 5, updatedAt: 300 } }));
  assert.equal(r4.legacyReadsSkipped, 0);
});

// ------------------------------------------------------------------------------------------------ D / E

test('D: backup retention keeps only the configured number (default 5), newest survive — per category', async () => {
  assert.equal(ls.MAX_BACKUPS, 5);
  const st = createMemoryStorage(); const store = mkLib(st);
  assert.equal(store.maxBackups, 5);
  await store.saveLibrary(libOf([series('a', [1])]));
  const made = [];
  for (let i = 0; i < 9; i++) made.push((await store.backupLibrary({ label: 'm' + i })).backupKey);
  const manual = (await store.listBackups()).filter((k) => k.startsWith(ls.MANUAL_BACKUP_PREFIX));
  assert.deepEqual(manual.sort(), made.slice(4).sort(), 'exactly the 5 newest manual backups remain');
  // pre-replace category is separate and capped on its own
  for (let i = 0; i < 8; i++) await store.replaceLibrary(libOf([series('r' + i, [1])]));
  const all = await store.listBackups();
  assert.equal(all.filter((k) => k.startsWith(ls.PRE_REPLACE_BACKUP_PREFIX)).length, 5);
  assert.equal(all.filter((k) => k.startsWith(ls.MANUAL_BACKUP_PREFIX)).length, 5, 'manual category untouched by pre-replace pruning');
  // custom bound
  const st2 = createMemoryStorage(); const small = mkLib(st2, { maxBackups: 2 });
  await small.saveLibrary(libOf([]));
  for (let i = 0; i < 5; i++) await small.backupLibrary({ label: 'k' + i });
  assert.equal((await small.listBackups()).length, 2);
});

test('E: pruning never touches the active library (or legacy key / progress), reports what it removed, protects the newest', async () => {
  const st = createMemoryStorage(); const store = mkLib(st);
  const live = libOf([series('live', [1])]);
  await store.saveLibrary(live);
  st.data.set(LEGACY, JSON.stringify(libOf([series('old', [1])])));
  await mkProg(st).updateChapterProgress({ seriesId: 'live', chapterId: 'c1', pageIndex: 2, pageCount: 30, now: 5 });
  const progKeys = () => [...st.data.keys()].filter((k) => k.startsWith(P)).sort();
  const progBefore = progKeys();
  let last;
  for (let i = 0; i < 12; i++) last = await store.backupLibrary({ label: 'e' + i });
  assert.deepEqual(JSON.parse(st.data.get(KEY)), live, 'active library byte-for-byte intact');
  assert.ok(st.data.has(LEGACY), 'legacy key intact');
  assert.deepEqual(progKeys(), progBefore, 'progress records intact');
  assert.equal(last.prune.ok, true);
  const man = last.prune.categories.find((c) => c.prefix === ls.MANUAL_BACKUP_PREFIX);
  assert.equal(man.kept, 5); assert.equal(man.removed.length, 1, 'one old backup pruned on the last pass');
  assert.ok(st.data.has(last.backupKey), 'the backup just made survives');
  assert.equal(st.calls.delete.every((k) => k.startsWith(ls.MANUAL_BACKUP_PREFIX)), true, 'only backup keys were ever deleted');
});

test('E2: pruning failures are visible (result, last report, callback) and never lose or fail the new backup', async () => {
  const st = createMemoryStorage(); const seen = [];
  const store = mkLib(st, { maxBackups: 2, onPruneFailure: (r) => seen.push(r) });
  await store.saveLibrary(libOf([series('a', [1])]));
  await store.backupLibrary({ label: 'b1' }); await store.backupLibrary({ label: 'b2' });
  st.delete = (key) => { st.calls.delete.push(key); return Promise.resolve(null); };   // deletes fail
  const r = await store.backupLibrary({ label: 'b3' });
  assert.equal(r.ok, true, 'the backup itself still succeeded');
  assert.ok(st.data.has(r.backupKey));
  assert.equal(r.prune.ok, false);
  const cat = r.prune.categories.find((c) => c.prefix === ls.MANUAL_BACKUP_PREFIX);
  assert.equal(cat.failed.length, 1);
  assert.equal(seen.length, 1, 'onPruneFailure called');
  assert.equal(store.getLastPruneReport().ok, false);
  // listing failure is also reported
  st.failList = true;
  const r2 = await store.pruneBackups();
  assert.equal(r2.ok, false); assert.ok(r2.categories.every((c) => c.code === 'LIST_UNAVAILABLE'));
});

test('E3: backups that cannot be ranked are kept, not guessed at', async () => {
  const st = createMemoryStorage(); const store = mkLib(st, { maxBackups: 1 });
  await store.saveLibrary(libOf([]));
  st.data.set(ls.MANUAL_BACKUP_PREFIX + 'junk', 'not json at all');
  await store.backupLibrary({ label: 'n1' }); await store.backupLibrary({ label: 'n2' });
  assert.ok(st.data.has(ls.MANUAL_BACKUP_PREFIX + 'junk'), 'unreadable backup preserved');
  assert.equal((await store.listBackups()).filter((k) => k !== ls.MANUAL_BACKUP_PREFIX + 'junk').length, 1);
});

// ------------------------------------------------------------------------------------------------ F

test('F: corrupt library → recoverable backup, original untouched, no silent empty library, backup survives later pruning', async () => {
  const st = createMemoryStorage(); const store = mkLib(st, { maxBackups: 2 });
  const garbage = '{"series":[{"id":"s1"';        // truncated JSON
  st.data.set(KEY, garbage);
  const r = await store.loadLibrary();
  assert.equal(r.status, 'corrupt'); assert.equal(r.library, null);
  assert.equal(r.backupVerified, true);
  assert.equal(st.data.get(KEY), garbage, 'original corrupt payload untouched');
  assert.equal(JSON.parse(st.data.get(r.backupKey)).raw, garbage, 'backup holds the exact bytes');
  assert.equal((await store.saveLibrary(libOf([]))).code, 'WRITES_BLOCKED', 'empty state cannot replace it');
  assert.equal(st.data.get(KEY), garbage);
  // Even if many other corrupt blobs were backed up earlier/later, the blocking backup is protected.
  for (let i = 0; i < 4; i++) {
    const t = mkLib(createMemoryStorage()); void t;
  }
  for (let i = 0; i < 4; i++) st.data.set(ls.CORRUPT_BACKUP_PREFIX + 'newer' + i, JSON.stringify({ kind: 'library-corrupt-backup', detectedAt: 9e9 + i, raw: 'x' + i }));
  await store.pruneBackups();
  assert.ok(st.data.has(r.backupKey), 'the backup the write-block depends on survives pruning even though newer ones exist');
  // recovery works: restore after the user hand-repairs → the store unblocks
  const fixed = JSON.stringify(libOf([series('s1', [1])]));
  const env = JSON.parse(st.data.get(r.backupKey)); env.raw = fixed; st.data.set(r.backupKey, JSON.stringify(env));
  const rec = await store.restoreLibrary(r.backupKey);
  assert.equal(rec.ok, true); assert.equal(store.isWriteBlocked(), false);
});

test('F2: coordinator surfaces corruption to the user, keeps the original, never presents it as a normal empty library', async () => {
  const st = createMemoryStorage(); const garbage = 'not json {';
  st.data.set(KEY, garbage);
  const h = harness(st);
  const out = await h.coord.start();
  assert.equal(out.status, 'corrupt');
  assert.ok(h.host.events.includes('present-blocked'));
  assert.ok(h.host.notices.some((n) => n.k === 'recovery' && /copy was kept/i.test(n.m)));
  assert.equal(h.host.finalized, 0 + 0, 'no library was adopted/finalized');
  assert.equal((await appSave(h)).code, 'WRITES_BLOCKED');
  assert.equal(st.data.get(KEY), garbage);
});

// ------------------------------------------------------------------------------------------------ G

test('G: storage init failure → no empty replacement state is ever persisted; user is told; saves refused', async () => {
  for (const mode of ['no-storage', 'read-error', 'rejected-load']) {
    const st = createMemoryStorage();
    st.data.set(KEY, JSON.stringify(libOf([series('precious', [1])])));
    const before = st.data.get(KEY);
    let h;
    if (mode === 'no-storage') h = harness(st, { hasStorage: () => false });
    if (mode === 'read-error') { st.failGet = (k) => (k === KEY ? new Error('IDBTransaction aborted') : undefined); st.failList = true; h = harness(st); }
    if (mode === 'rejected-load') { h = harness(st); h.coord = sc.createStartupCoordinator({ load: () => Promise.reject(new Error('boom')), hasStorage: () => true, setTimer: () => 1, clearTimer: () => {}, hooks: { present: (i) => h.host.events.push(i.fallback ? 'present-fallback' : 'present'), notify: (m, k) => h.host.notices.push({ m, k }), logError: (c, e) => h.host.errors.push({ c }), pendingEdits: () => 0 } }); }
    await h.coord.start();
    assert.ok(h.host.events.some((e) => /^present/.test(e)), mode + ': app is shown (not stuck on splash)');
    assert.ok(h.host.notices.some((n) => n.k === 'recovery' && /reload/i.test(n.m)), mode + ': recovery/reload message shown');
    if (mode !== 'read-error') assert.equal(h.coord.isLoaded(), false, mode + ': save gate stays closed');
    const res = await appSave(h);
    assert.equal(res === null || res.ok === false, true, mode + ': a save attempt does not succeed');
    assert.equal(st.data.get(KEY), before, mode + ': persisted library untouched');
    assert.equal(st.calls.set.filter((c) => c.key === KEY).length, 0, mode + ': zero writes to the library key');
  }
});

test('G2: failsafe timeout alone (storage never answers) shows the reload UI and keeps the gate closed', async () => {
  const st = gatedStorage(); st.data.set(KEY, JSON.stringify(libOf([series('s1', [1])]))); st.hold();
  const h = harness(st);
  h.coord.start(); await tick0();
  h.host.timerFn();
  assert.equal(h.coord.getPhase(), 'fallback');
  assert.ok(h.host.notices.some((n) => n.k === 'recovery'));
  assert.equal(await appSave(h), null); assert.equal(h.host.refused, 1);
  assert.equal(st.calls.set.filter((c) => c.key === KEY).length, 0);
});

// ------------------------------------------------------------------------------------------------ H

test('H: late storage availability never overwrites valid library state', async () => {
  // (1) hang, user edits during the fallback are refused (never persisted), then the real library arrives
  const st = gatedStorage();
  const real = libOf([series('s1', [1, 2]), series('s2', [1])]);
  st.data.set(KEY, JSON.stringify(real)); const before = st.data.get(KEY);
  st.hold();
  const h = harness(st); const started = h.coord.start(); await tick0();
  h.host.timerFn();
  h.host.state.series.push(series('temp-edit', [1]));            // user acts on the temporary empty state
  assert.equal(await appSave(h), null);
  assert.equal(st.data.get(KEY), before, 'temporary state did not overwrite the library');
  st.release(); await started;
  assert.deepEqual(h.host.state.series.map((s) => s.id), ['s1', 's2'], 'valid library wins; the temporary state is gone');
  assert.equal(st.data.get(KEY), before, 'still byte-identical');
  assert.ok(h.host.notices.some((n) => /weren't saved/i.test(n.m)), 'user told their temporary edits were not saved');
  assert.equal((await appSave(h)).ok, true, 'saving works normally after the real load');

  // (2) storage missing at startup, appears later: still no write until a real load completed
  const st2 = createMemoryStorage(); st2.data.set(KEY, JSON.stringify(real));
  let available = false;
  const lib2 = ls.createLibraryStore({ getStorage: () => (available ? st2 : null), now: () => (tick += 1) });
  const host2 = { events: [], notices: [], state: { series: [] } };
  const coord2 = sc.createStartupCoordinator({
    load: () => lib2.loadLibrary(), hasStorage: () => true, setTimer: () => 1, clearTimer: () => {},
    hooks: { adopt: (l) => { host2.state = l; }, present: (i) => host2.events.push(i.fallback ? 'fallback' : 'present'), notify: (m, k) => host2.notices.push({ m, k }), pendingEdits: () => 0 }
  });
  await coord2.start();                                           // loadLibrary → 'unavailable'
  assert.equal(coord2.isLoaded(), false, "'unavailable' is not a definite answer: gate closed");
  available = true;                                               // storage shows up afterwards
  if (coord2.isLoaded()) await lib2.saveLibrary(host2.state);     // what an app save would do — it must NOT happen
  assert.equal(st2.data.get(KEY), JSON.stringify(real), 'valid library untouched when storage appears late');

  // (3) the user imports a backup while the original load is still hanging → the stale read must not clobber it
  const st3 = gatedStorage(); st3.data.set(KEY, JSON.stringify(libOf([series('old', [1])]))); st3.hold();
  const h3 = harness(st3); const started3 = h3.coord.start(); await tick0();
  h3.host.timerFn();
  h3.coord.markReplaced();                                        // import succeeded (replaceLibrary wrote)
  h3.host.state = libOf([series('imported', [1])]);
  st3.release(); const out3 = await started3;
  assert.equal(out3.applied, false); assert.equal(out3.reason, 'superseded');
  assert.deepEqual(h3.host.state.series.map((s) => s.id), ['imported'], 'late stale result discarded');
});

// ------------------------------------------------------------------------------------------------ wiring

test('wiring: index.html uses the coordinator, the shell precaches it, finalize is split out and idempotent-guarded', () => {
  const root = path.resolve(__dirname, '../..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  const a = html.indexOf('<script src="src/services/progressStore.js"></script>');
  const b = html.indexOf('<script src="src/services/startupCoordinator.js"></script>');
  assert.ok(a > 0 && b > a, 'coordinator loads after the stores');
  assert.ok(b < html.indexOf('var STORAGE_KEY = "fairs-library-v1"'), 'and before the app script');
  assert.ok(sw.includes('"./src/services/startupCoordinator.js"'), 'precached');
  assert.ok(Number(/fairs-library-shell-v(\d+)/.exec(sw)[1]) >= 74, 'shell cache version bumped');
  assert.ok(html.includes('function finalizeLoadedState()'));
  assert.ok(html.includes('sessionCountedFor !== state'), 'session counter guarded against re-run');
  assert.ok(/startup\.markReplaced\(\)/.test(html), 'import tells the coordinator the library was replaced');
  assert.ok(html.includes('onPruneFailure'), 'prune failures are surfaced to the user/log');
  assert.equal((html.match(/createStartupCoordinator\(/g) || []).length, 1, 'exactly one startup state machine');
  assert.ok(!/libraryLoaded = true/.test(html.replace(/\/\/.*$/gm, '').replace(/\blibraryLoaded = !!v\b/, '')) , 'only the coordinator mirror may open the gate');
});
