'use strict';
/**
 * Phase 1 / Stage 5 — Reader live integration tests.
 * Structural checks against index.html + behavioral service/domain tests.
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');

var readerPages = require(path.join(__dirname, '../../src/domain/readerPages.js'));
var readerPageService = require(path.join(__dirname, '../../src/services/readerPageService.js'));
var readerSession = require(path.join(__dirname, '../../src/domain/readerSession.js'));
var chapterOrder = require(path.join(__dirname, '../../src/domain/chapterOrder.js'));

var indexHtml = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');

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

console.log('readerIntegration.test.js');

// ---- Architecture (structural) ----

test('live resolvePagesForChapter uses ReaderPageService.loadChapterPages', function () {
  var start = indexHtml.indexOf('function resolvePagesForChapter');
  assert.ok(start >= 0);
  var slice = indexHtml.slice(start, start + 3500);
  assert.ok(slice.indexOf('ReaderPageService.loadChapterPages') >= 0);
  assert.ok(slice.indexOf('fetchPages') >= 0);
});

test('renderReader remote path uses resolvePagesForChapter not bare ensureRemote', function () {
  // The withRetry load path should call resolvePagesForChapter
  assert.ok(indexHtml.indexOf('resolvePagesForChapter(s,c,{ requestToken: session })') >= 0 ||
            indexHtml.indexOf('resolvePagesForChapter(s,c') >= 0);
  // chapterImagesHtml accepts normalized objects
  var start = indexHtml.indexOf('function chapterImagesHtml');
  var slice = indexHtml.slice(start, start + 1200);
  assert.ok(slice.indexOf('imageUrl') >= 0);
  assert.ok(slice.indexOf('availability') >= 0);
});

test('renderReader prefers _normalizedPages', function () {
  assert.ok(indexHtml.indexOf('c._normalizedPages') >= 0);
  assert.ok(indexHtml.indexOf('Prefer Stage 5 normalized') >= 0 ||
            indexHtml.indexOf('_normalizedPages') >= 0);
});

test('ReaderSessionDomain created in renderReader', function () {
  assert.ok(indexHtml.indexOf('ReaderSessionDomain.createReaderSession') >= 0);
});

test('chapter switch invalidates ReaderPageService', function () {
  assert.ok(indexHtml.indexOf('ReaderPageService.invalidate') >= 0);
});

test('prev/next still use chapterOrder', function () {
  assert.ok(indexHtml.indexOf('getNextChapter') >= 0);
  assert.ok(indexHtml.indexOf('getPreviousChapter') >= 0);
});

test('no external redirect in openChapterInApp', function () {
  var start = indexHtml.indexOf('function openChapterInApp');
  var slice = indexHtml.slice(start, start + 2500);
  assert.ok(slice.indexOf('window.open') < 0);
  assert.ok(slice.indexOf('location.href') < 0);
});

// ---- Offline + remote same model ----

test('local and remote both normalize to same page model', function () {
  var local = readerPages.normalizePageList(
    ['blob:http://local/1', 'blob:http://local/2'],
    { chapterId: 'c1', canonicalChapterId: 'mhch:1' }
  );
  var remote = readerPages.normalizePageList(
    ['https://cdn.example/1.jpg', 'https://cdn.example/2.jpg'],
    { chapterId: 'c1', canonicalChapterId: 'mhch:1' }
  );
  assert.strictEqual(local.length, 2);
  assert.strictEqual(remote.length, 2);
  assert.strictEqual(local[0].chapterId, remote[0].chapterId);
  assert.strictEqual(local[0].pageIndex, 0);
  assert.strictEqual(remote[0].pageIndex, 0);
  assert.ok(local[0].id);
  assert.ok(remote[0].imageUrl);
});

test('unsafe URLs blocked in normalized model', function () {
  var pages = readerPages.normalizePageList(
    ['javascript:alert(1)', 'https://ok.example/a.jpg'],
    { chapterId: 'c' }
  );
  assert.strictEqual(pages[0].availability, 'unavailable');
  assert.strictEqual(pages[1].availability, 'available');
});

// ---- Session / progress ----

test('Reader Session owns current page; complete only via complete()', function () {
  var session = readerSession.createReaderSession({
    series: { id: 's1' },
    chapter: { id: 'c1' },
    pageCount: 10,
    currentPage: 0,
    sessionId: 'int-1'
  });
  var moved = readerSession.setPage(session, 9);
  assert.strictEqual(moved.session.currentPage, 9);
  assert.strictEqual(moved.session.completed, false);
  var done = readerSession.complete(moved.session);
  assert.strictEqual(done.session.completed, true);
});

test('resume clamp against normalized page count', function () {
  assert.strictEqual(readerPages.clampPageIndex(100, 40), 39);
  assert.strictEqual(readerPages.clampPageIndex(-1, 40), 0);
});

// ---- Navigation ----

test('previous/next use ChapterOrder not index math', function () {
  var chapters = [
    { id: 'a', chapter: '1' },
    { id: 'b', chapter: '10' },
    { id: 'c', chapter: '2.5' },
    { id: 'd', chapter: '2' }
  ];
  var next = chapterOrder.getNextChapter(chapters, chapters[0]);
  assert.strictEqual(next.id, 'd'); // 1 → 2
  var prev = chapterOrder.getPreviousChapter(chapters, chapters[1]);
  assert.strictEqual(prev.id, 'c'); // 10 ← 2.5
});

// ---- Service integration ----

function runAsync() {
  return readerPageService.loadChapterPages({
    seriesId: 's1',
    chapterId: 'c1',
    canonicalChapterId: 'mhch:c1',
    requestToken: 1,
    fetchPages: function () {
      // simulates injected source/offline fetcher
      return Promise.resolve([
        'https://cdn.example/1.jpg',
        'https://cdn.example/2.jpg',
        'https://cdn.example/3.jpg'
      ]);
    }
  }).then(function (res) {
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.usable, 3);
    assert.strictEqual(res.pages[0].canonicalChapterId, 'mhch:c1');
    assert.strictEqual(res.pages[1].pageIndex, 1);
    passed++;
    console.log('  OK  remote pages flow through ReaderPageService with identity');
  }).then(function () {
    return readerPageService.loadChapterPages({
      seriesId: 's1',
      chapterId: 'c1',
      requestToken: 2,
      existingPages: ['blob:offline-1', 'blob:offline-2'],
      fetchPages: function () { throw new Error('network should not run'); }
    });
  }).then(function (res) {
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.usable, 2);
    passed++;
    console.log('  OK  offline/existing pages use same service pipeline');
  }).then(function () {
    return readerPageService.loadChapterPages({
      seriesId: 's1',
      chapterId: 'c1',
      requestToken: 3,
      fetchPages: function () { return Promise.reject(new Error('source down')); }
    });
  }).then(function (res) {
    assert.strictEqual(res.ok, false);
    assert.ok(res.error);
    passed++;
    console.log('  OK  remote failure produces internal error result');
  }).then(function () {
    var slow = readerPageService.loadChapterPages({
      seriesId: 's1', chapterId: 'race', requestToken: 1,
      fetchPages: function () {
        return new Promise(function (r) {
          setTimeout(function () { r(['https://old/1.jpg']); }, 40);
        });
      }
    });
    var fast = readerPageService.loadChapterPages({
      seriesId: 's1', chapterId: 'race', requestToken: 2,
      fetchPages: function () {
        return Promise.resolve(['https://new/1.jpg']);
      }
    });
    return Promise.all([slow, fast]);
  }).then(function (pair) {
    assert.strictEqual(pair[0].stale, true);
    assert.strictEqual(pair[1].stale, false);
    passed++;
    console.log('  OK  stale page response cannot overwrite current');
  }).then(function () {
    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    if (failed) process.exit(1);
  }).catch(function (e) {
    console.error(e);
    process.exit(1);
  });
}

runAsync();
