'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ls = require('../../src/services/libraryStore.js');
const ps = require('../../src/services/progressStore.js');
const { createMemoryStorage } = require('./helpers/memoryStorage.js');

const KEY = 'fairs-library-v1', OLD = 'panel-library-v1';
const good = () => ({ series: [{ id: 's1', title: 'One', chapters: [{ id: 'c1', chapter: '1' }] }], progress: { s1: { chapterId: 'c1', pageIndex: 3, updatedAt: 99 } }, hints: { precious: true } });
const truncated = () => JSON.stringify(good()).slice(0, 60);          // cut mid-structure
const mkStore = (st) => ls.createLibraryStore({ storage: st, now: () => 42 });

test('corrupt JSON: detected, raw preserved byte-for-byte, original untouched, writes blocked', async () => {
  const st = createMemoryStorage(); const raw = truncated(); st.data.set(KEY, raw);
  const store = mkStore(st);
  const r = await store.loadLibrary();
  assert.equal(r.status, 'corrupt'); assert.equal(r.library, null); assert.equal(r.reason, 'json-parse-failed');
  assert.equal(r.backupVerified, true);
  assert.ok(r.backupKey.startsWith(ls.CORRUPT_BACKUP_PREFIX));
  assert.equal(JSON.parse(st.data.get(r.backupKey)).raw, raw, 'recoverable raw data is preserved exactly');
  assert.equal(st.data.get(KEY), raw, 'the original blob is never deleted or modified');
  assert.equal(store.isWriteBlocked(), true);
  assert.equal(store.getBlockInfo().reason, 'corrupt');
  assert.equal(st.calls.delete.length, 0, 'nothing deleted');
});

test('the silent-overwrite bug is gone: after a corrupt load an "empty library" save does NOT replace the blob', async () => {
  const st = createMemoryStorage(); const raw = truncated(); st.data.set(KEY, raw);
  const store = mkStore(st);
  await store.loadLibrary();
  const res = await store.saveLibrary({ series: [], progress: {} });   // what the old app did right after
  assert.equal(res.ok, false); assert.equal(res.code, 'WRITES_BLOCKED');
  assert.equal(st.data.get(KEY), raw);
  assert.equal(st.calls.set.filter((c) => c.key === KEY).length, 0, 'no write to the library key at all');
  const rep = await store.replaceLibrary({ series: [] });                // even replace needs force
  assert.equal(rep.code, 'WRITES_BLOCKED'); assert.equal(st.data.get(KEY), raw);
});

test('wrong-shaped blobs are corruption too (null, array, series not an array)', async () => {
  for (const raw of ['null', '[]', '{"series":"oops"}', '17']) {
    const st = createMemoryStorage(); st.data.set(KEY, raw);
    const store = mkStore(st); const r = await store.loadLibrary();
    assert.equal(r.status, 'corrupt', raw); assert.equal(st.data.get(KEY), raw); assert.equal(store.isWriteBlocked(), true);
  }
});

test('the same corrupt blob loaded repeatedly keeps ONE backup (no accumulation)', async () => {
  const st = createMemoryStorage(); st.data.set(KEY, truncated());
  const a = await mkStore(st).loadLibrary(); const b = await mkStore(st).loadLibrary(); const c = await mkStore(st).loadLibrary();
  assert.equal(a.backupKey, b.backupKey); assert.equal(b.backupKey, c.backupKey);
  assert.equal([...st.data.keys()].filter((k) => k.startsWith(ls.CORRUPT_BACKUP_PREFIX)).length, 1);
});

test('a corrupt pre-rebrand key blocks writes too (an empty new-key save would shadow it forever)', async () => {
  const st = createMemoryStorage(); st.data.set(OLD, truncated());
  const store = mkStore(st); const r = await store.loadLibrary();
  assert.equal(r.status, 'corrupt'); assert.equal(r.sourceKey, OLD);
  assert.equal(store.isWriteBlocked(), true); assert.equal(st.data.has(KEY), false);
});

test('backup failure is reported honestly; recovery then demands explicit acknowledgement', async () => {
  const st = createMemoryStorage({ failSet: (k) => k.startsWith(ls.CORRUPT_BACKUP_PREFIX) }); const raw = truncated(); st.data.set(KEY, raw);
  const store = mkStore(st); const r = await store.loadLibrary();
  assert.equal(r.status, 'corrupt'); assert.equal(r.backupVerified, false);
  assert.equal(st.data.get(KEY), raw, 'original still intact');
  assert.equal(store.isWriteBlocked(), true);
  const refused = await store.replaceLibrary(good(), { force: true });
  assert.equal(refused.code, 'BACKUP_NOT_VERIFIED'); assert.equal(st.data.get(KEY), raw);
  const ok = await store.replaceLibrary(good(), { force: true, acknowledgeDataLoss: true });
  assert.equal(ok.ok, true); assert.equal(store.isWriteBlocked(), false);
});

test('explicit user recovery (import/restore) unblocks writes; the corrupt copy stays available', async () => {
  const st = createMemoryStorage(); const raw = truncated(); st.data.set(KEY, raw);
  const store = mkStore(st); const r = await store.loadLibrary();
  const res = await store.replaceLibrary(good(), { force: true });
  assert.equal(res.ok, true); assert.equal(store.isWriteBlocked(), false);
  assert.deepEqual(JSON.parse(st.data.get(KEY)), good());
  assert.equal(JSON.parse(st.data.get(r.backupKey)).raw, raw, 'corrupt copy is still there after recovery');
  assert.equal((await store.saveLibrary({ series: [{ id: 'next' }] })).ok, true);
});

test('restoring the corrupt backup itself fails cleanly while its data is still unparseable', async () => {
  const st = createMemoryStorage(); const raw = truncated(); st.data.set(KEY, raw);
  const store = mkStore(st); const r = await store.loadLibrary();
  const res = await store.restoreLibrary(r.backupKey);
  assert.equal(res.code, 'BACKUP_UNPARSEABLE');
  assert.equal(st.data.get(KEY), raw); assert.equal(store.isWriteBlocked(), true);
});

test('a hand-repaired corrupt blob can be restored from its backup envelope', async () => {
  const st = createMemoryStorage(); st.data.set(KEY, truncated());
  const store = mkStore(st); const r = await store.loadLibrary();
  // someone repairs the raw text inside the preserved envelope
  const env = JSON.parse(st.data.get(r.backupKey)); env.raw = JSON.stringify(good());
  st.data.set(r.backupKey, JSON.stringify(env));
  const res = await store.restoreLibrary(r.backupKey);
  assert.equal(res.ok, true); assert.deepEqual(res.library, good());
  assert.equal(store.isWriteBlocked(), false);
});

test('transient read failure on an existing key blocks writes, then a healthy reload unblocks without data loss', async () => {
  const st = createMemoryStorage(); const text = JSON.stringify(good()); st.data.set(KEY, text);
  let failing = true; st.failGet = (k) => (failing && k === KEY ? new Error('indexeddb-timeout') : undefined);
  const store = mkStore(st);
  const r1 = await store.loadLibrary();
  assert.equal(r1.status, 'read-error'); assert.equal(store.isWriteBlocked(), true);
  assert.equal((await store.saveLibrary({ series: [] })).code, 'WRITES_BLOCKED');
  assert.equal(st.data.get(KEY), text);
  failing = false;
  const r2 = await store.loadLibrary();
  assert.equal(r2.status, 'ok'); assert.equal(store.isWriteBlocked(), false); assert.deepEqual(r2.library, good());
});

test('read-error needs acknowledgement to overwrite (the unreadable blob cannot be backed up)', async () => {
  const st = createMemoryStorage(); st.data.set(KEY, JSON.stringify(good())); st.failGet = (k) => (k === KEY ? new Error('boom') : undefined);
  const store = mkStore(st); await store.loadLibrary();
  assert.equal((await store.replaceLibrary({ series: [] }, { force: true })).code, 'BACKUP_NOT_VERIFIED');
});

test('an unfamiliar get() error for a key that does not exist is NOT treated as data at risk', async () => {
  const st = createMemoryStorage(); st.failGet = () => new Error('Key lookup failed: weird wording');
  const store = mkStore(st); const r = await store.loadLibrary();
  assert.equal(r.status, 'empty'); assert.equal(store.isWriteBlocked(), false, 'a fresh install must still be able to save');
});

test('read error where existence cannot be established stays blocked (fail closed)', async () => {
  const st = createMemoryStorage({ failList: true }); st.failGet = () => new Error('db down');
  const store = mkStore(st); assert.equal((await store.loadLibrary()).status, 'read-error'); assert.equal(store.isWriteBlocked(), true);
});

test('progress keeps persisting while the library is blocked (separate store, separate keys)', async () => {
  const st = createMemoryStorage(); const raw = truncated(); st.data.set(KEY, raw);
  const lib = mkStore(st); await lib.loadLibrary();
  const prog = ps.createProgressStore({ storage: st, now: () => 5 });
  const res = await prog.updateChapterProgress({ seriesId: 's1', chapterId: 'c1', pageIndex: 4, pageCount: 9 });
  assert.equal(res.ok, true);
  assert.equal(st.data.get(KEY), raw);
  assert.equal((await prog.getChapterProgress({ seriesId: 's1', chapterId: 'c1' })).pageIndex, 4);
});
