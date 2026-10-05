'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ls = require('../../src/services/libraryStore.js');
const { createMemoryStorage } = require('./helpers/memoryStorage.js');

const KEY = 'fairs-library-v1', OLD = 'panel-library-v1';
const mkStore = (storage, extra) => ls.createLibraryStore(Object.assign({ storage, now: () => 1700000000000 }, extra || {}));
const lib = () => ({ series: [{ id: 's1', title: 'One', chapters: [{ id: 'c1' }], futureSeriesField: { keep: true } }], progress: {}, settings: { a: 1 }, unknownTopLevel: [1, 2, 3] });

test('load on an empty store → status empty, no write, writes allowed', async () => {
  const st = createMemoryStorage(); const store = mkStore(st);
  const r = await store.loadLibrary();
  assert.equal(r.status, 'empty'); assert.equal(r.library, null);
  assert.equal(st.calls.set.length, 0, 'loading never writes');
  assert.equal(store.isWriteBlocked(), false);
});

test('save → load round trip', async () => {
  const st = createMemoryStorage(); const store = mkStore(st);
  const res = await store.saveLibrary(lib());
  assert.equal(res.ok, true); assert.ok(res.bytes > 10);
  const r = await mkStore(st).loadLibrary();
  assert.equal(r.status, 'ok'); assert.deepEqual(r.library, lib()); assert.equal(r.migratedFromLegacyKey, false);
});

test('unknown fields survive load → migrateLibrary → save → load, and migrateLibrary is repeat-safe', async () => {
  const st = createMemoryStorage({}); st.data.set(KEY, JSON.stringify(lib()));
  const store = mkStore(st);
  const loaded = (await store.loadLibrary()).library;
  const m1 = ls.migrateLibrary(loaded), m2 = ls.migrateLibrary(m1.library);
  assert.equal(m1.changed, true); assert.equal(m2.changed, false); assert.deepEqual(m1.library, m2.library);
  assert.deepEqual(m1.library.unknownTopLevel, [1, 2, 3]);
  assert.deepEqual(m1.library.series[0].futureSeriesField, { keep: true });
  assert.equal(loaded.bookmarks, undefined, 'migrateLibrary does not mutate its input');
  await store.saveLibrary(m1.library);
  const again = (await mkStore(st).loadLibrary()).library;
  assert.deepEqual(again.unknownTopLevel, [1, 2, 3]); assert.deepEqual(again.series[0].futureSeriesField, { keep: true });
});

test('saveLibrary snapshots at call time: later mutation cannot change what was persisted', async () => {
  const st = createMemoryStorage(); const store = mkStore(st);
  const l = lib(); const p = store.saveLibrary(l); l.series.push({ id: 'late' });
  await p;
  assert.equal(JSON.parse(st.data.get(KEY)).series.length, 1);
});

test('writes are serialised in call order even when an older write is slower', async () => {
  const st = createMemoryStorage({ setDelay: (k, v) => (JSON.parse(v).n === 1 ? 40 : 1) }); const store = mkStore(st);
  const p1 = store.saveLibrary({ series: [], n: 1 }); const p2 = store.saveLibrary({ series: [], n: 2 });
  await Promise.all([p1, p2]);
  assert.equal(JSON.parse(st.data.get(KEY)).n, 2, 'the newest snapshot wins');
});

test('save refuses non-objects and unserialisable libraries without touching storage', async () => {
  const st = createMemoryStorage(); const store = mkStore(st);
  assert.equal((await store.saveLibrary(null)).code, 'INVALID_LIBRARY');
  assert.equal((await store.saveLibrary([1])).code, 'INVALID_LIBRARY');
  const cyc = { series: [] }; cyc.self = cyc;
  assert.equal((await store.saveLibrary(cyc)).code, 'SERIALIZE_FAILED');
  assert.equal(st.calls.set.length, 0);
});

test('a failing storage write is reported, not thrown', async () => {
  const st = createMemoryStorage({ failSet: () => true }); const store = mkStore(st);
  assert.equal((await store.saveLibrary(lib())).code, 'WRITE_FAILED');
  assert.equal((await mkStore(null).saveLibrary(lib())).code, 'STORAGE_UNAVAILABLE');
});

test('pre-rebrand key is read when the new key is missing and flagged for migration', async () => {
  const st = createMemoryStorage(); st.data.set(OLD, JSON.stringify(lib()));
  const store = mkStore(st);
  const r = await store.loadLibrary();
  assert.equal(r.status, 'ok'); assert.equal(r.migratedFromLegacyKey, true); assert.equal(r.sourceKey, OLD);
  assert.equal(st.calls.set.length, 0, 'load never writes or deletes');
  assert.equal(st.data.has(OLD), true);
  await store.saveLibrary(r.library);
  assert.equal((await store.deleteLegacyKey()).ok, true);
  assert.equal(st.data.has(OLD), false); assert.equal(st.data.has(KEY), true);
});

test('new key wins over the legacy key', async () => {
  const st = createMemoryStorage(); st.data.set(OLD, JSON.stringify({ series: [{ id: 'old' }] })); st.data.set(KEY, JSON.stringify({ series: [{ id: 'new' }] }));
  const r = await mkStore(st).loadLibrary();
  assert.equal(r.library.series[0].id, 'new'); assert.equal(r.migratedFromLegacyKey, false);
});

test('replaceLibrary backs up the previous blob first and overwrites', async () => {
  const st = createMemoryStorage(); const store = mkStore(st);
  await store.saveLibrary({ series: [{ id: 'before' }] });
  const res = await store.replaceLibrary({ series: [{ id: 'after' }] });
  assert.equal(res.ok, true); assert.ok(res.backupKey.startsWith(ls.PRE_REPLACE_BACKUP_PREFIX));
  assert.equal(JSON.parse(st.data.get(KEY)).series[0].id, 'after');
  assert.equal(JSON.parse(JSON.parse(st.data.get(res.backupKey)).raw).series[0].id, 'before');
  const fresh = await mkStore(createMemoryStorage()).replaceLibrary({ series: [] });
  assert.equal(fresh.ok, true, 'nothing to back up is not an error');
});

test('backupLibrary copies the persisted blob byte-for-byte; or a given in-memory library', async () => {
  const st = createMemoryStorage(); const store = mkStore(st);
  assert.equal((await store.backupLibrary({ label: 'x' })).code, 'NOTHING_TO_BACKUP');
  await store.saveLibrary(lib());
  const b = await store.backupLibrary({ label: 'manual' });
  assert.equal(b.ok, true); assert.equal(b.backupKey, ls.MANUAL_BACKUP_PREFIX + 'manual');
  assert.equal(JSON.parse(st.data.get(b.backupKey)).raw, st.data.get(KEY));
  const m = await store.backupLibrary({ label: 'mem', library: { series: [{ id: 'm' }] } });
  assert.equal(JSON.parse(JSON.parse(st.data.get(m.backupKey)).raw).series[0].id, 'm');
  assert.deepEqual((await store.listBackups()).sort(), [ls.MANUAL_BACKUP_PREFIX + 'manual', ls.MANUAL_BACKUP_PREFIX + 'mem'].sort());
});

test('restoreLibrary brings back a backed-up library; unknown/garbage backups change nothing', async () => {
  const st = createMemoryStorage(); const store = mkStore(st);
  await store.saveLibrary(lib());
  const b = await store.backupLibrary({ label: 'good' });
  await store.saveLibrary({ series: [{ id: 'changed' }] });
  const r = await store.restoreLibrary(b.backupKey);
  assert.equal(r.ok, true); assert.deepEqual(r.library, lib());
  assert.deepEqual(JSON.parse(st.data.get(KEY)), lib());
  assert.equal((await store.restoreLibrary('library-backup:nope')).code, 'BACKUP_NOT_FOUND');
  assert.equal((await store.restoreLibrary('')).code, 'INVALID_BACKUP_KEY');
  st.data.set('library-backup:junk', 'not json');
  const before = st.data.get(KEY);
  assert.equal((await store.restoreLibrary('library-backup:junk')).code, 'BACKUP_UNPARSEABLE');
  assert.equal(st.data.get(KEY), before);
});

test('validateLibraryBlob accepts only plain-object libraries', () => {
  assert.equal(ls.validateLibraryBlob('{"series":[]}').ok, true);
  assert.equal(ls.validateLibraryBlob({ series: [] }).ok, true);
  assert.equal(ls.validateLibraryBlob('{}').ok, true);
  for (const bad of ['{"series":', 'null', '[]', '42', '"str"', '{"series":"x"}', undefined, 5, true]) assert.equal(ls.validateLibraryBlob(bad).ok, false, String(bad));
});

test('metrics are recorded for load and save', async () => {
  let t = 0; const st = createMemoryStorage(); const store = mkStore(st, { perfNow: () => (t += 5) });
  await store.saveLibrary(lib()); await store.loadLibrary();
  const m = store.getMetrics();
  assert.ok(m.lastSaveMs > 0 && m.lastSaveBytes > 0 && m.lastLoadMs > 0 && m.saves === 1);
});
