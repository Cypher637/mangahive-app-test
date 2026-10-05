'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const id = require('../../src/domain/identity.js');
const { deepFreeze } = require('./helpers/memoryStorage.js');

const series = () => ({ id: 's1', canonicalId: 's1', sourceMappings: [{ sourceId: 'mangadex', remoteId: 'md-1' }] });

test('identical chapter → identical identity (deterministic, repeatable)', () => {
  const ch = { id: 'c1', chapter: '12', title: 'Chapter 12', sources: [{ sourceId: 'mangadex', remoteId: 'r12' }] };
  const a = id.getChapterIdentity(ch, series());
  const b = id.getChapterIdentity(JSON.parse(JSON.stringify(ch)), series());
  assert.deepEqual(a, b);
  for (let i = 0; i < 50; i++) assert.equal(id.getCanonicalChapterId(ch, series()), a.canonicalChapterId);
});

test('property order of the input does not change the identity', () => {
  const a = { id: 'c1', chapter: '3', volume: '1', title: 'x' };
  const b = { title: 'x', volume: '1', chapter: '3', id: 'c1' };
  assert.deepEqual(id.getChapterIdentity(a, series()), id.getChapterIdentity(b, series()));
});

test('never mutates its inputs (deep-frozen chapter and series)', () => {
  const ch = deepFreeze({ id: 'c1', chapter: '7', sources: [{ sourceId: 'x', remoteId: 'y' }] });
  const s = deepFreeze(series());
  assert.doesNotThrow(() => { id.getChapterIdentity(ch, s); id.getSeriesIdentity(s); id.getChapterSourceIdentity(ch, 'x'); });
  assert.equal(ch.canonicalChapterId, undefined);
});

test('chapter.id is never rewritten and is reported as the local identity (D1)', () => {
  const ch = { id: 'legacy-abc', chapter: '4' };
  const i = id.getChapterIdentity(ch, series());
  assert.equal(i.localId, 'legacy-abc');
  assert.equal(ch.id, 'legacy-abc');
  assert.notEqual(i.canonicalChapterId, i.localId);
});

test('different remote IDs → different identity (no number to merge on)', () => {
  const a = id.getChapterIdentity({ id: 'a', sources: [{ sourceId: 'src', remoteId: 'r1' }] }, series());
  const b = id.getChapterIdentity({ id: 'b', sources: [{ sourceId: 'src', remoteId: 'r2' }] }, series());
  assert.notEqual(a.canonicalChapterId, b.canonicalChapterId);
  assert.notEqual(a.instanceKey, b.instanceKey);
  assert.equal(a.confidence, 'remote');
});

test('same logical chapter number from two remote ids: same canonical id, distinct instance keys', () => {
  const a = id.getChapterIdentity({ id: 'a', chapter: '9', sources: [{ sourceId: 'src', remoteId: 'r1' }] }, series());
  const b = id.getChapterIdentity({ id: 'b', chapter: '9', sources: [{ sourceId: 'src', remoteId: 'r2' }] }, series());
  assert.equal(a.canonicalChapterId, b.canonicalChapterId);
  assert.notEqual(a.instanceKey, b.instanceKey);
});

test('same remote ID from the same source → same identity; from another source → different binding', () => {
  const mk = (src) => ({ id: 'x', sources: [{ sourceId: src, remoteId: 'R' }] });
  const a = id.getChapterIdentity(mk('s-a'), series());
  const b = id.getChapterIdentity(mk('s-a'), series());
  const c = id.getChapterIdentity(mk('s-b'), series());
  assert.deepEqual(a, b);
  assert.notEqual(a.sources[0].bindingKey, c.sources[0].bindingKey);
  assert.notEqual(a.canonicalChapterId, c.canonicalChapterId);
});

test('missing remote id falls back: number → title (weak) → local id (weak) → none', () => {
  assert.equal(id.getChapterIdentity({ id: 'c', chapter: '5' }, series()).confidence, 'structured');
  const t = id.getChapterIdentity({ id: 'c', title: 'The Beginning' }, series());
  assert.equal(t.confidence, 'weak'); assert.ok(t.canonicalChapterId);
  const l = id.getChapterIdentity({ id: 'only-id' }, series());
  assert.equal(l.confidence, 'weak'); assert.ok(l.canonicalChapterId);
  const n = id.getChapterIdentity({}, series());
  assert.equal(n.confidence, 'none'); assert.equal(n.canonicalChapterId, null); assert.equal(n.isCanonical, false);
});

test('a series with no usable id cannot yield a canonical chapter id', () => {
  const i = id.getChapterIdentity({ id: 'c', chapter: '1' }, null);
  assert.equal(i.canonicalChapterId, null);
  assert.equal(i.localId, 'c');
});

test('duplicate-title edge cases', () => {
  const a = id.getChapterIdentity({ id: 'a', title: 'Prologue' }, series());
  const b = id.getChapterIdentity({ id: 'b', title: 'Prologue' }, series());
  assert.notEqual(a.canonicalChapterId, b.canonicalChapterId, 'same title, different local ids must not collide');
  const c1 = id.getChapterIdentity({ title: 'Prologue' }, series());
  const c2 = id.getChapterIdentity({ title: 'Prologue' }, series());
  assert.deepEqual(c1, c2);
  assert.equal(c1.confidence, 'weak');
  // title punctuation/case is normalised, so these are the same weak key without ids
  assert.equal(id.getChapterIdentity({ title: 'PROLOGUE!' }, series()).canonicalChapterId, c1.canonicalChapterId);
});

test('volume / number / suffix / part handling', () => {
  const cid = (c) => id.getChapterIdentity(c, series()).canonicalChapterId;
  assert.equal(cid({ chapter: '12' }), 'mhch:s1:12');
  assert.equal(cid({ chapter: '012' }), 'mhch:s1:12');
  assert.equal(cid({ chapter: '12.5' }), 'mhch:s1:12.5');
  assert.equal(cid({ chapter: '12a' }), 'mhch:s1:12-a');
  assert.equal(cid({ chapter: '12', title: 'Chapter 12 Extra' }), 'mhch:s1:12-extra');
  assert.equal(cid({ chapter: '12', title: 'Chapter 12 Part 2' }), 'mhch:s1:12-part-2');
  assert.equal(cid({ chapter: '12', volume: '3' }), 'mhch:s1:v3:12');
  const variants = [
    { chapter: '12' }, { chapter: '12.5' }, { chapter: '12a' },
    { chapter: '12', title: 'Chapter 12 Extra' }, { chapter: '12', title: 'Chapter 12 Part 2' }
  ].map(cid);
  assert.equal(new Set(variants).size, variants.length, '12, 12.5, 12a, 12 extra and 12 part 2 are never silently merged');
  assert.notEqual(cid({ chapter: '12', volume: '1' }), cid({ chapter: '12', volume: '2' }), 'conflicting volumes are different chapters');
  const s = id.extractChapterStructure({ chapter: '12', title: 'Vol.4 Chapter 12 Part IV' });
  assert.equal(s.volume, '4'); assert.equal(s.part, 'iv'); assert.equal(s.number, '12');
});

test('legacy chapter objects: existing canonical ids are preserved, non-conforming ones are not trusted', () => {
  const kept = id.getChapterIdentity({ id: 'c1', chapter: '5', canonicalChapterId: 'mhch:other-series:777' }, series());
  assert.equal(kept.canonicalChapterId, 'mhch:other-series:777');
  assert.equal(kept.canonicalSource, 'existing');
  const junk = id.getChapterIdentity({ id: 'c1', chapter: '5', canonicalChapterId: 'chapter-5' }, series());
  assert.equal(junk.canonicalSource, 'derived');
  assert.equal(junk.canonicalChapterId, 'mhch:s1:5');
  for (const bad of ['mhch:', 'mhch::x', 'mhch:s1:', 'mhch:s1', 42, {}, null, 'mhch:s1:a\nb']) {
    assert.equal(id.isCanonicalChapterId(bad), false, String(bad));
  }
  assert.equal(id.isCanonicalChapterId('mhch:s1:12.5'), true);
  assert.equal(id.isCanonicalChapterId('mhch:s1:v2:12-extra'), true);
});

test('legacy single-source chapter fields (sourceId/remoteId) are understood', () => {
  const i = id.getChapterIdentity({ id: 'c', sourceId: 'mangadex', remoteId: 'abc' }, series());
  assert.equal(i.sources.length, 1);
  assert.equal(i.sources[0].extensionId, 'builtin:mangadex');
});

test('malformed inputs never throw and never produce junk ids', () => {
  const bad = [null, undefined, 'str', 42, [], [1, 2], true, { id: {} }, { chapter: {} }, { title: ['x'] }, { sources: 'no' }, { sources: [null, 7, {}] }, { id: NaN }, { chapter: Infinity }];
  for (const b of bad) {
    assert.doesNotThrow(() => id.getChapterIdentity(b, b));
    assert.doesNotThrow(() => id.getSeriesIdentity(b));
    assert.doesNotThrow(() => id.getChapterSourceIdentity(b, b));
    assert.doesNotThrow(() => id.getCanonicalChapterIdentity(b, b));
    const r = id.getChapterIdentity(b, series());
    assert.ok(r.canonicalChapterId === null || id.isCanonicalChapterId(r.canonicalChapterId));
  }
});

test('collision resistance: 2000 distinct chapters, 2000 distinct canonical ids', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) seen.add(id.getCanonicalChapterId({ id: 'c' + i, chapter: String(i / 4) }, series()));
  assert.equal(seen.size, 2000);
  // very long keys are clipped but stay collision resistant
  const long1 = 'x'.repeat(300) + 'a', long2 = 'x'.repeat(300) + 'b';
  const a = id.getCanonicalChapterId({ chapter: '1-' + long1 }, series());
  const b = id.getCanonicalChapterId({ chapter: '1-' + long2 }, series());
  assert.notEqual(a, b);
  assert.ok(a.length < 200 && id.isCanonicalChapterId(a));
});

test('same chapter number in different series never shares a canonical id', () => {
  const a = id.getCanonicalChapterId({ chapter: '1' }, { id: 'sA' });
  const b = id.getCanonicalChapterId({ chapter: '1' }, { id: 'sB' });
  assert.notEqual(a, b);
  assert.notEqual(id.getCanonicalChapterId({ chapter: '1' }, { id: 'a:b' }), id.getCanonicalChapterId({ chapter: 'b:1' }, { id: 'a' }));
});

test('series identity separates local, canonical and source identity', () => {
  const s = id.getSeriesIdentity({ id: 'local-1', canonicalId: 'canon-1', sourceMappings: [{ sourceId: 'a', remoteId: '1' }, { sourceId: 'a', remoteId: '1' }, { sourceId: 'b' }], source: { type: 'c', remoteId: '9' } });
  assert.equal(s.localId, 'local-1');
  assert.equal(s.canonicalId, 'canon-1');
  assert.equal(s.hasExplicitCanonicalId, true);
  assert.equal(s.isGlobalCanonical, false, 'a client-generated id is never globally canonical');
  assert.equal(s.canonicalScope, 'library');
  assert.equal(s.sources.length, 2, 'duplicates and incomplete bindings are dropped');
  assert.equal(s.primarySource.sourceId, 'a');
  const legacy = id.getSeriesIdentity({ id: 'only-local' });
  assert.equal(legacy.canonicalId, 'only-local'); assert.equal(legacy.hasExplicitCanonicalId, false);
  const none = id.getSeriesIdentity(null);
  assert.equal(none.localId, null); assert.equal(none.canonicalId, null);
});

test('chapter source identity lookup', () => {
  const ch = { id: 'c', sources: [{ sourceId: 'a', remoteId: '1', extensionId: 'ext.a' }, { sourceId: 'b', remoteId: '2' }] };
  assert.deepEqual(id.getChapterSourceIdentity(ch, 'a'), { extensionId: 'ext.a', sourceId: 'a', remoteId: '1', bindingKey: 'ext.a\u001fa\u001f1' });
  assert.equal(id.getChapterSourceIdentity(ch, 'b').extensionId, 'builtin:b');
  assert.equal(id.getChapterSourceIdentity(ch, 'zzz'), null);
  assert.equal(id.getChapterSourceIdentity(ch), null, 'ambiguous without a source id → null, never a guess');
  assert.equal(id.getChapterSourceIdentity({ sources: [{ sourceId: 'only', remoteId: '1' }] }).sourceId, 'only');
  assert.equal(id.getChapterSourceIdentity({ sources: [{ sourceId: 'x', remoteId: '' }] }, 'x'), null);
  const resolved = id.getChapterSourceIdentity({ sources: [{ sourceId: 'm', remoteId: '1' }] }, 'm', { resolveExtensionId: () => 'owner.ext' });
  assert.equal(resolved.extensionId, 'owner.ext');
});

test('isSameChapter: canonical equality, else local id', () => {
  assert.equal(id.isSameChapter({ id: 'a', chapter: '2' }, { id: 'b', chapter: '2' }, { id: 's' }), true);
  assert.equal(id.isSameChapter({ id: 'a', chapter: '2' }, { id: 'b', chapter: '3' }, { id: 's' }), false);
  assert.equal(id.isSameChapter({ id: 'a' }, { id: 'a' }, null), true);
  assert.equal(id.isSameChapter({}, {}, null), false);
});
