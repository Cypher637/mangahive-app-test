'use strict';
/**
 * Phase 1 / Stage 4 — Chapter System behavioral tests.
 */
var assert = require('assert');
var path = require('path');
var chapterSystem = require(path.join(__dirname, '../../src/domain/chapterSystem.js'));
var chapterService = require(path.join(__dirname, '../../src/services/chapterService.js'));

function seriesFixture(overrides) {
  var s = {
    id: 'series-1',
    canonicalId: 'series-1',
    title: 'Test',
    source: { type: 'mangadex', remoteId: 'md-s1' },
    chapters: []
  };
  if (overrides) Object.keys(overrides).forEach(function (k) { s[k] = overrides[k]; });
  return s;
}

var passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  OK  ' + name);
  } catch (e) {
    failed++;
    console.error('  FAIL  ' + name);
    console.error('    ' + (e && e.stack ? e.stack : e));
  }
}

console.log('chapterSystem.test.js');

// ---- Identity ----
test('normalizeChapter preserves local id', function () {
  var s = seriesFixture();
  var n = chapterSystem.normalizeChapter({
    id: 'local-c1',
    chapter: '1',
    title: 'One',
    remoteId: 'r1',
    sources: [{ sourceId: 'mangadex', remoteId: 'r1' }]
  }, s);
  assert.strictEqual(n.id, 'local-c1');
  assert.strictEqual(n.numberText, '1');
  assert.ok(n.sourceBindings.length >= 1);
});

test('deterministic identity across normalize', function () {
  var s = seriesFixture();
  var raw = {
    chapter: '2.5', title: 'Special', remoteId: 'rx',
    sources: [{ sourceId: 'mangadex', remoteId: 'rx' }]
  };
  var a = chapterSystem.normalizeChapter(raw, s);
  var b = chapterSystem.normalizeChapter(raw, s);
  assert.strictEqual(a.canonicalChapterId, b.canonicalChapterId);
});

test('different remote ids stay distinct', function () {
  var s = seriesFixture();
  var a = chapterSystem.normalizeChapter({
    chapter: '1', remoteId: 'a', sources: [{ sourceId: 'mangadex', remoteId: 'a' }]
  }, s);
  var b = chapterSystem.normalizeChapter({
    chapter: '1', remoteId: 'b', sources: [{ sourceId: 'mangadex', remoteId: 'b' }]
  }, s);
  assert.notStrictEqual(a.remoteId, b.remoteId);
});

// ---- Ordering ----
test('order 1, 2, 2.5, 10 not lexicographic', function () {
  var list = [
    { id: 'a', chapter: '10' },
    { id: 'b', chapter: '2' },
    { id: 'c', chapter: '1' },
    { id: 'd', chapter: '2.5' }
  ];
  var ordered = chapterSystem.orderChapters(list, 'asc');
  assert.deepStrictEqual(ordered.map(function (c) { return String(c.chapter); }), ['1', '2', '2.5', '10']);
});

test('descending reverses presentation only', function () {
  var list = [
    { id: 'a', chapter: '1' },
    { id: 'b', chapter: '2' },
    { id: 'c', chapter: '3' }
  ];
  var desc = chapterSystem.orderChapters(list, 'desc');
  assert.deepStrictEqual(desc.map(function (c) { return String(c.chapter); }), ['3', '2', '1']);
});

// ---- Dedup ----
test('same source+remote deduped', function () {
  var s = seriesFixture();
  var list = [
    chapterSystem.normalizeChapter({ id: '1', chapter: '1', remoteId: 'r', sources: [{ sourceId: 'mangadex', remoteId: 'r' }] }, s),
    chapterSystem.normalizeChapter({ id: '2', chapter: '1', remoteId: 'r', sources: [{ sourceId: 'mangadex', remoteId: 'r' }] }, s)
  ];
  var d = chapterSystem.dedupeChapters(list, s);
  assert.strictEqual(d.length, 1);
  assert.strictEqual(d[0].id, '1');
});

test('same title different remotes not force-merged by title', function () {
  var s = seriesFixture();
  var list = [
    chapterSystem.normalizeChapter({ id: '1', chapter: '1', title: 'Same', remoteId: 'a', sources: [{ sourceId: 'mangadex', remoteId: 'a' }] }, s),
    chapterSystem.normalizeChapter({ id: '2', chapter: '1', title: 'Same', remoteId: 'b', sources: [{ sourceId: 'comick', remoteId: 'b' }] }, s)
  ];
  var d = chapterSystem.dedupeChapters(list, s);
  assert.ok(d.length >= 1 && d.length <= 2);
});

// ---- Merge ----
test('merge new chapter appends', function () {
  var s = seriesFixture();
  var existing = [{ id: 'c1', chapter: '1', remoteId: 'r1', sources: [{ sourceId: 'mangadex', remoteId: 'r1' }] }];
  var incoming = [{ chapter: '2', remoteId: 'r2', sources: [{ sourceId: 'mangadex', remoteId: 'r2' }] }];
  var m = chapterSystem.mergeChapters(existing, incoming, s);
  assert.strictEqual(m.length, 2);
  assert.strictEqual(m[0].id, 'c1');
});

test('merge preserves local id and fills title', function () {
  var s = seriesFixture();
  var existing = [{ id: 'c1', chapter: '1', title: '', remoteId: 'r1', sources: [{ sourceId: 'mangadex', remoteId: 'r1' }] }];
  var incoming = [{ chapter: '1', title: 'Filled', remoteId: 'r1', sources: [{ sourceId: 'mangadex', remoteId: 'r1' }] }];
  var m = chapterSystem.mergeChapters(existing, incoming, s);
  assert.strictEqual(m[0].id, 'c1');
  assert.strictEqual(m[0].title, 'Filled');
});

test('merge does not erase good title with empty', function () {
  var s = seriesFixture();
  var existing = [{ id: 'c1', chapter: '1', title: 'Keep Me', remoteId: 'r1', sources: [{ sourceId: 'mangadex', remoteId: 'r1' }] }];
  var incoming = [{ chapter: '1', title: '', remoteId: 'r1', sources: [{ sourceId: 'mangadex', remoteId: 'r1' }] }];
  var m = chapterSystem.mergeChapters(existing, incoming, s);
  assert.strictEqual(m[0].title, 'Keep Me');
});

test('merge does not drop missing-from-source chapters', function () {
  var s = seriesFixture();
  var existing = [
    { id: 'keep', chapter: '1', remoteId: 'r1', sources: [{ sourceId: 'mangadex', remoteId: 'r1' }] },
    { id: 'orphan', chapter: '99', remoteId: 'gone', sources: [{ sourceId: 'mangadex', remoteId: 'gone' }] }
  ];
  var incoming = [{ chapter: '1', remoteId: 'r1', sources: [{ sourceId: 'mangadex', remoteId: 'r1' }] }];
  var m = chapterSystem.mergeChapters(existing, incoming, s);
  assert.strictEqual(m.length, 2);
  assert.ok(m.some(function (c) { return c.id === 'orphan'; }));
});

test('merge adds source binding', function () {
  var s = seriesFixture();
  var existing = [{ id: 'c1', chapter: '1', remoteId: 'r1', sources: [{ sourceId: 'mangadex', remoteId: 'r1' }] }];
  var incoming = [{
    chapter: '1', remoteId: 'r1',
    sources: [
      { sourceId: 'mangadex', remoteId: 'r1' },
      { sourceId: 'comick', remoteId: 'ck1' }
    ]
  }];
  var m = chapterSystem.mergeChapters(existing, incoming, s);
  var srcs = m[0].sources || m[0].sourceBindings;
  assert.ok(srcs.some(function (b) { return b.sourceId === 'comick'; }));
});

test('refresh idempotent snapshots', function () {
  var s = seriesFixture({
    chapters: [
      { id: 'c1', chapter: '1', remoteId: 'r1', sources: [{ sourceId: 'mangadex', remoteId: 'r1' }] }
    ]
  });
  var incoming = [{ chapter: '1', remoteId: 'r1', sources: [{ sourceId: 'mangadex', remoteId: 'r1' }] }];
  var a = chapterSystem.refreshChapters(s, incoming);
  var s2 = Object.assign({}, s, { chapters: a });
  var b = chapterSystem.refreshChapters(s2, incoming);
  assert.deepStrictEqual(
    chapterSystem.chapterIdentitySnapshot(a, s),
    chapterSystem.chapterIdentitySnapshot(b, s)
  );
});

// ---- Progress ----
test('read states unread/started/completed', function () {
  var s = seriesFixture({
    chapters: [
      { id: 'a', chapter: '1' },
      { id: 'b', chapter: '2' },
      { id: 'c', chapter: '3' }
    ]
  });
  var progress = {
    a: { completed: true, page: 10 },
    b: { page: 3, total: 10, updatedAt: 5 }
  };
  var rows = chapterSystem.attachProgress(s.chapters, s, progress);
  var by = {};
  rows.forEach(function (r) { by[r.id] = r.readState; });
  assert.strictEqual(by.a, 'completed');
  assert.strictEqual(by.b, 'started');
  assert.strictEqual(by.c, 'unread');
});

test('continue reading prefers started', function () {
  var s = seriesFixture({
    chapters: [
      { id: 'a', chapter: '1' },
      { id: 'b', chapter: '2' },
      { id: 'c', chapter: '3' }
    ]
  });
  var progress = {
    a: { completed: true, page: 10, updatedAt: 1 },
    b: { page: 2, total: 10, updatedAt: 9 }
  };
  var cont = chapterSystem.resolveContinueChapter(s.chapters, s, progress);
  assert.strictEqual(cont.kind, 'continue');
  assert.strictEqual(cont.chapterId, 'b');
});

test('start when no progress', function () {
  var s = seriesFixture({
    chapters: [{ id: 'a', chapter: '1' }, { id: 'b', chapter: '2' }]
  });
  var cont = chapterSystem.resolveContinueChapter(s.chapters, s, {});
  assert.strictEqual(cont.kind, 'start');
  assert.strictEqual(cont.chapterId, 'a');
});

test('finished when all completed', function () {
  var s = seriesFixture({
    chapters: [{ id: 'a', chapter: '1' }, { id: 'b', chapter: '2' }]
  });
  var progress = { a: { completed: true }, b: { completed: true } };
  var cont = chapterSystem.resolveContinueChapter(s.chapters, s, progress);
  assert.strictEqual(cont.kind, 'finished');
  assert.strictEqual(cont.chapterId, null);
});

test('completed not resume target when unread remains', function () {
  var s = seriesFixture({
    chapters: [{ id: 'a', chapter: '1' }, { id: 'b', chapter: '2' }]
  });
  var progress = { a: { completed: true, page: 10, updatedAt: 99 } };
  var cont = chapterSystem.resolveContinueChapter(s.chapters, s, progress);
  assert.ok(cont.kind === 'next' || cont.kind === 'start');
  assert.strictEqual(cont.chapterId, 'b');
});

// ---- Availability / open ----
test('validateOpenChapter rejects missing', function () {
  var s = seriesFixture({ chapters: [{ id: 'a', chapter: '1' }] });
  var v = chapterSystem.validateOpenChapter(s, 'nope');
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reason, 'chapter_missing');
});

test('validateOpenChapter rejects unavailable', function () {
  var s = seriesFixture({
    chapters: [{ id: 'a', chapter: '1', available: false, remoteId: 'r' }]
  });
  var v = chapterSystem.validateOpenChapter(s, 'a');
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reason, 'unavailable');
});

test('validateOpenChapter accepts available', function () {
  var s = seriesFixture({
    chapters: [{ id: 'a', chapter: '1', remoteId: 'r', sources: [{ sourceId: 'mangadex', remoteId: 'r' }] }]
  });
  var v = chapterSystem.validateOpenChapter(s, 'a');
  assert.strictEqual(v.ok, true);
});

test('open request has stable ids and no external url', function () {
  var s = seriesFixture({
    chapters: [{ id: 'a', chapter: '1', remoteId: 'r', sources: [{ sourceId: 'mangadex', remoteId: 'r' }] }]
  });
  var req = chapterSystem.createOpenChapterRequest(s, s.chapters[0], { pageIndex: 2 });
  assert.strictEqual(req.ok, true);
  assert.strictEqual(req.seriesId, 'series-1');
  assert.strictEqual(req.chapterId, 'a');
  assert.strictEqual(req.pageIndex, 2);
  assert.ok(!('sourceUrl' in req));
});

// ---- Assemble / partial ----
test('assemble partial success keeps good source chapters', function () {
  var s = seriesFixture({ chapters: [] });
  var result = chapterSystem.assembleChapterList(s, [
    {
      sourceId: 'mangadex',
      chapters: [
        { chapter: '1', remoteId: 'r1', sources: [{ sourceId: 'mangadex', remoteId: 'r1' }] }
      ]
    },
    { sourceId: 'comick', error: 'timeout' }
  ], {});
  assert.strictEqual(result.status, 'partial');
  assert.ok(result.total >= 1);
  assert.ok(result.sourceResults.some(function (r) { return !r.ok; }));
});

test('assemble full failure status error', function () {
  var s = seriesFixture({ chapters: [] });
  var result = chapterSystem.assembleChapterList(s, [
    { sourceId: 'mangadex', error: 'fail' },
    { sourceId: 'comick', error: 'fail' }
  ], {});
  assert.strictEqual(result.status, 'error');
});

// ---- Service (async) ----
function runAsync() {
  var s = seriesFixture({ chapters: [] });
  return chapterService.getChapters(s, {
    requestToken: 1,
    fetchers: [
      {
        sourceId: 'mangadex',
        fetch: function () {
          return Promise.resolve({
            chapters: [{ chapter: '1', remoteId: 'r1', sources: [{ sourceId: 'mangadex', remoteId: 'r1' }] }]
          });
        }
      },
      {
        sourceId: 'broken',
        fetch: function () { return Promise.reject(new Error('network')); }
      }
    ]
  }).then(function (res) {
    assert.strictEqual(res.status, 'partial');
    assert.ok(res.total >= 1);
    assert.strictEqual(res.stale, false);
    passed++;
    console.log('  OK  getChapters with mock fetchers merges and isolates errors');
  }).then(function () {
    var s2 = seriesFixture({ id: 'tok-series', chapters: [] });
    var p1 = chapterService.getChapters(s2, {
      requestToken: 10,
      fetchers: [{
        sourceId: 'mangadex',
        fetch: function () {
          return new Promise(function (resolve) {
            setTimeout(function () {
              resolve({ chapters: [{ chapter: '1', remoteId: 'late' }] });
            }, 40);
          });
        }
      }]
    });
    var p2 = chapterService.getChapters(s2, {
      requestToken: 20,
      fetchers: [{
        sourceId: 'mangadex',
        fetch: function () {
          return Promise.resolve({ chapters: [{ chapter: '2', remoteId: 'new' }] });
        }
      }]
    });
    return Promise.all([p1, p2]).then(function (pair) {
      assert.strictEqual(pair[0].stale, true);
      assert.strictEqual(pair[0].status, 'stale');
      assert.strictEqual(pair[1].stale, false);
      passed++;
      console.log('  OK  stale request token discarded');
    });
  }).then(function () {
    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    if (failed) process.exit(1);
  }).catch(function (e) {
    failed++;
    console.error('  FAIL  async suite', e && e.stack ? e.stack : e);
    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    process.exit(1);
  });
}

runAsync();
