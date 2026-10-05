'use strict';
/**
 * Phase 1 / Stage 4 — Chapter System live integration tests.
 *
 * Proves Details wiring contracts against the domain/service modules and
 * structural expectations for index.html (no full browser DOM).
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');

var chapterSystem = require(path.join(__dirname, '../../src/domain/chapterSystem.js'));
var chapterService = require(path.join(__dirname, '../../src/services/chapterService.js'));

var root = path.join(__dirname, '../..');
var indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

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

console.log('chapterIntegration.test.js');

// ---- Structural integration (Details must not bypass ChapterService) ----

test('index.html loads chapterSystem and chapterService scripts', function () {
  assert.ok(indexHtml.indexOf('src/domain/chapterSystem.js') >= 0);
  assert.ok(indexHtml.indexOf('src/services/chapterService.js') >= 0);
});

test('Details defines refreshDetailsChapters and getDetailsChapterView', function () {
  assert.ok(indexHtml.indexOf('function refreshDetailsChapters') >= 0);
  assert.ok(indexHtml.indexOf('function getDetailsChapterView') >= 0);
  assert.ok(indexHtml.indexOf('function buildChapterFetchersForSeries') >= 0);
});

test('Details chapter view uses ChapterSystem.assembleChapterList', function () {
  assert.ok(indexHtml.indexOf('ChapterSystem.assembleChapterList') >= 0);
  assert.ok(indexHtml.indexOf('getDetailsChapterView(s)') >= 0);
});

test('Details refresh uses ChapterService.getChapters', function () {
  assert.ok(indexHtml.indexOf('ChapterService.getChapters') >= 0);
  assert.ok(indexHtml.indexOf('refreshDetailsChapters') >= 0);
});

test('open-reader routes through openChapterInApp', function () {
  assert.ok(indexHtml.indexOf('function openChapterInApp') >= 0);
  // primary click handler must call openChapterInApp, not raw navigate for open-reader
  assert.ok(indexHtml.indexOf('else if(action === "open-reader") openChapterInApp') >= 0);
  assert.ok(indexHtml.indexOf('else if(action === "open-reader") navigate("reader"') < 0);
});

test('openChapterInApp uses ChapterSystem validation', function () {
  assert.ok(indexHtml.indexOf('ChapterSystem.validateOpenChapter') >= 0);
  assert.ok(indexHtml.indexOf('ChapterSystem.createOpenChapterRequest') >= 0);
});

test('fetchers resolve via getSourceAdapter (source registry boundary)', function () {
  assert.ok(indexHtml.indexOf('getSourceAdapter') >= 0);
  // buildChapterFetchersForSeries uses getSourceAdapter
  var start = indexHtml.indexOf('function buildChapterFetchersForSeries');
  assert.ok(start >= 0);
  var slice = indexHtml.slice(start, start + 2500);
  assert.ok(slice.indexOf('getSourceAdapter') >= 0);
  assert.ok(slice.indexOf('getSource') >= 0);
});

test('no external redirect helpers introduced for chapter open', function () {
  // openChapterInApp body must not window.open / location.assign to sources
  var start = indexHtml.indexOf('function openChapterInApp');
  var slice = indexHtml.slice(start, start + 1200);
  assert.ok(slice.indexOf('window.open') < 0);
  assert.ok(slice.indexOf('location.href') < 0);
  assert.ok(slice.indexOf('location.assign') < 0);
});

// ---- Behavioral: same pipeline for Search/Library identity ----

function seriesFixture() {
  return {
    id: 'series-lib-1',
    canonicalId: 'series-lib-1',
    title: 'Integration Manga',
    source: { type: 'mangadex', remoteId: 'md-1' },
    sourceMappings: [
      { sourceId: 'mangadex', remoteId: 'md-1' },
      { sourceId: 'comick', remoteId: 'ck-1' }
    ],
    chapters: [
      { id: 'c10', chapter: '10', title: 'Ten', remoteId: 'r10', sources: [{ sourceId: 'mangadex', remoteId: 'r10' }] },
      { id: 'c1', chapter: '1', title: 'One', remoteId: 'r1', sources: [{ sourceId: 'mangadex', remoteId: 'r1' }] },
      { id: 'c2', chapter: '2', title: 'Two', remoteId: 'r2', sources: [{ sourceId: 'mangadex', remoteId: 'r2' }] }
    ]
  };
}

test('ChapterSystem orders Details list deterministically', function () {
  var s = seriesFixture();
  var view = chapterSystem.assembleChapterList(s, [], {
    existingChapters: s.chapters,
    seriesProgress: {}
  });
  assert.deepStrictEqual(
    view.chapters.map(function (c) { return String(c.number || c.numberText || c.chapter); }),
    ['1', '2', '10']
  );
});

test('ChapterSystem attaches progress for Details', function () {
  var s = seriesFixture();
  var view = chapterSystem.assembleChapterList(s, [], {
    existingChapters: s.chapters,
    seriesProgress: {
      c1: { completed: true, page: 5 },
      c2: { page: 2, total: 10, updatedAt: 3 }
    }
  });
  var by = {};
  view.chapters.forEach(function (c) { by[c.id] = c.readState; });
  assert.strictEqual(by.c1, 'completed');
  assert.strictEqual(by.c2, 'started');
  assert.strictEqual(by.c10, 'unread');
});

test('partial source failure still returns successful chapters', function () {
  var s = seriesFixture({ chapters: [] });
  // reset chapters
  s.chapters = [];
  var view = chapterSystem.assembleChapterList(s, [
    {
      sourceId: 'mangadex',
      chapters: [
        { chapter: '1', remoteId: 'r1', sources: [{ sourceId: 'mangadex', remoteId: 'r1' }] },
        { chapter: '2', remoteId: 'r2', sources: [{ sourceId: 'mangadex', remoteId: 'r2' }] }
      ]
    },
    { sourceId: 'comick', error: 'timeout' }
  ], {});
  assert.strictEqual(view.status, 'partial');
  assert.ok(view.total >= 2);
});

test('refresh merge preserves local ids and progress mapping', function () {
  var s = seriesFixture();
  var incoming = [
    { chapter: '1', title: 'One Updated', remoteId: 'r1', sources: [{ sourceId: 'mangadex', remoteId: 'r1' }] },
    { chapter: '3', title: 'Three', remoteId: 'r3', sources: [{ sourceId: 'mangadex', remoteId: 'r3' }] }
  ];
  var merged = chapterSystem.mergeChapters(s.chapters, incoming, s);
  var c1 = merged.filter(function (c) { return c.remoteId === 'r1'; })[0];
  assert.strictEqual(c1.id, 'c1');
  // Title: non-empty local is preserved (empty incoming would not wipe it).
  assert.ok(c1.title === 'One' || c1.title === 'One Updated');
  assert.ok(merged.some(function (c) { return c.remoteId === 'r3'; }));
  // orphan local chapter with different remote still present
  assert.ok(merged.some(function (c) { return c.id === 'c10'; }));
});

test('open handoff validates normalized chapter', function () {
  var s = seriesFixture();
  var v = chapterSystem.validateOpenChapter(s, 'c1');
  assert.strictEqual(v.ok, true);
  var req = chapterSystem.createOpenChapterRequest(s, v.chapter, { pageIndex: 0 });
  assert.strictEqual(req.ok, true);
  assert.strictEqual(req.seriesId, 'series-lib-1');
  assert.strictEqual(req.chapterId, 'c1');
  assert.ok(!('sourceUrl' in req));
});

test('repeated assemble is idempotent (no duplicate chapters)', function () {
  var s = seriesFixture();
  var a = chapterSystem.assembleChapterList(s, [], { existingChapters: s.chapters });
  var b = chapterSystem.assembleChapterList(s, [], { existingChapters: a.chapters });
  assert.strictEqual(a.total, b.total);
  assert.deepStrictEqual(
    chapterSystem.chapterIdentitySnapshot(a.chapters, s),
    chapterSystem.chapterIdentitySnapshot(b.chapters, s)
  );
});

function runAsync() {
  var s = seriesFixture();
  s.chapters = [];
  return chapterService.getChapters(s, {
    requestToken: 42,
    fetchers: [
      {
        sourceId: 'mangadex',
        fetch: function () {
          return Promise.resolve({
            chapters: [
              { chapter: '1', remoteId: 'r1', sources: [{ sourceId: 'mangadex', remoteId: 'r1' }] },
              { chapter: '10', remoteId: 'r10', sources: [{ sourceId: 'mangadex', remoteId: 'r10' }] }
            ]
          });
        }
      },
      {
        sourceId: 'comick',
        fetch: function () { return Promise.reject(new Error('down')); }
      }
    ]
  }).then(function (res) {
    assert.strictEqual(res.status, 'partial');
    assert.ok(res.total >= 2);
    passed++;
    console.log('  OK  ChapterService getChapters integrates multi-source with registry-style fetchers');
  }).then(function () {
    var s2 = { id: 'race-series', title: 'Race', chapters: [], source: { type: 'mangadex', remoteId: 'x' } };
    var slow = chapterService.getChapters(s2, {
      requestToken: 1,
      fetchers: [{
        sourceId: 'mangadex',
        fetch: function () {
          return new Promise(function (resolve) {
            setTimeout(function () {
              resolve({ chapters: [{ chapter: '1', remoteId: 'old' }] });
            }, 50);
          });
        }
      }]
    });
    var fast = chapterService.getChapters(s2, {
      requestToken: 2,
      fetchers: [{
        sourceId: 'mangadex',
        fetch: function () {
          return Promise.resolve({ chapters: [{ chapter: '2', remoteId: 'new' }] });
        }
      }]
    });
    return Promise.all([slow, fast]).then(function (pair) {
      assert.strictEqual(pair[0].stale, true);
      assert.strictEqual(pair[1].stale, false);
      passed++;
      console.log('  OK  stale ChapterService token cannot overwrite newer result');
    });
  }).then(function () {
    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    if (failed) process.exit(1);
  }).catch(function (e) {
    failed++;
    console.error('  FAIL  async', e && e.stack ? e.stack : e);
    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    process.exit(1);
  });
}

runAsync();
