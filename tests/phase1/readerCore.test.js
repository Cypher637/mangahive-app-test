'use strict';
/**
 * Phase 1 / Stage 5 — Reader Core tests (page model, page service, session, handoff).
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');

var readerPages = require(path.join(__dirname, '../../src/domain/readerPages.js'));
var readerPageService = require(path.join(__dirname, '../../src/services/readerPageService.js'));
var readerSession = require(path.join(__dirname, '../../src/domain/readerSession.js'));
var chapterSystem = require(path.join(__dirname, '../../src/domain/chapterSystem.js'));
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

console.log('readerCore.test.js');

// ---- Structural ----
test('index loads readerPages and readerPageService', function () {
  assert.ok(indexHtml.indexOf('src/domain/readerPages.js') >= 0);
  assert.ok(indexHtml.indexOf('src/services/readerPageService.js') >= 0);
});

test('openChapterInApp and renderReader exist', function () {
  assert.ok(indexHtml.indexOf('function openChapterInApp') >= 0);
  assert.ok(indexHtml.indexOf('function renderReader') >= 0);
});

test('open-reader uses openChapterInApp (no external redirect path)', function () {
  assert.ok(indexHtml.indexOf('else if(action === "open-reader") openChapterInApp') >= 0);
  var start = indexHtml.indexOf('function openChapterInApp');
  var slice = indexHtml.slice(start, start + 2000);
  assert.ok(slice.indexOf('window.open') < 0);
  assert.ok(slice.indexOf('location.href') < 0);
});

test('prev/next use chapterOrder in renderReader', function () {
  assert.ok(indexHtml.indexOf('getNextChapter') >= 0);
  assert.ok(indexHtml.indexOf('getPreviousChapter') >= 0);
});

// ---- Page normalization ----
test('normalize string URLs in order', function () {
  var pages = readerPages.normalizePageList(
    ['https://cdn.example/1.jpg', 'https://cdn.example/2.jpg', 'https://cdn.example/3.jpg'],
    { chapterId: 'c1' }
  );
  assert.strictEqual(pages.length, 3);
  assert.strictEqual(pages[0].pageIndex, 0);
  assert.strictEqual(pages[2].pageIndex, 2);
  assert.strictEqual(pages[0].imageUrl, 'https://cdn.example/1.jpg');
  assert.strictEqual(pages[0].availability, 'available');
});

test('rejects javascript: and unsafe schemes', function () {
  assert.strictEqual(readerPages.sanitizeImageUrl('javascript:alert(1)'), null);
  assert.strictEqual(readerPages.sanitizeImageUrl('https://ok.example/a.jpg'), 'https://ok.example/a.jpg');
  var pages = readerPages.normalizePageList(
    ['javascript:evil', 'https://cdn.example/ok.jpg'],
    { chapterId: 'c1' }
  );
  assert.strictEqual(pages[0].availability, 'unavailable');
  assert.strictEqual(pages[1].availability, 'available');
});

test('explicit pageIndex orders pages (not URL alpha sort)', function () {
  var pages = readerPages.normalizePageList([
    { url: 'https://cdn.example/c.jpg', pageIndex: 2 },
    { url: 'https://cdn.example/a.jpg', pageIndex: 0 },
    { url: 'https://cdn.example/b.jpg', pageIndex: 1 }
  ], { chapterId: 'c1' });
  assert.strictEqual(pages[0].imageUrl, 'https://cdn.example/a.jpg');
  assert.strictEqual(pages[1].imageUrl, 'https://cdn.example/b.jpg');
  assert.strictEqual(pages[2].imageUrl, 'https://cdn.example/c.jpg');
});

test('missing page data handled', function () {
  var pages = readerPages.normalizePageList([null, '', { foo: 1 }, 'https://x/1.jpg'], { chapterId: 'c' });
  assert.ok(pages.length >= 1);
  assert.ok(pages.some(function (p) { return p.imageUrl === 'https://x/1.jpg'; }));
});

test('empty chapter yields zero usable pages', function () {
  var pages = readerPages.normalizePageList([], { chapterId: 'c' });
  assert.strictEqual(readerPages.usableCount(pages), 0);
});

test('clampPageIndex handles out of bounds', function () {
  assert.strictEqual(readerPages.clampPageIndex(99, 10), 9);
  assert.strictEqual(readerPages.clampPageIndex(-3, 10), 0);
  assert.strictEqual(readerPages.clampPageIndex(5, 0), 0);
  assert.strictEqual(readerPages.clampPageIndex(3, 10), 3);
});

test('toLegacyUrlList maps unavailable to empty string', function () {
  var pages = readerPages.normalizePageList(
    ['https://a/1.jpg', 'javascript:x'],
    { chapterId: 'c' }
  );
  var urls = readerPages.toLegacyUrlList(pages);
  assert.strictEqual(urls[0], 'https://a/1.jpg');
  assert.strictEqual(urls[1], '');
});

// ---- Page service (async body in runAsync) ----

// ---- Reader session ----
test('createReaderSession for valid chapter', function () {
  var series = { id: 's1', canonicalId: 's1' };
  var chapter = { id: 'c1', canonicalChapterId: 'mhch:x' };
  var session = readerSession.createReaderSession({
    series: series,
    chapter: chapter,
    pageCount: 10,
    currentPage: 3,
    sessionId: 't1'
  });
  assert.ok(session);
  assert.strictEqual(session.chapter.id, 'c1');
  assert.strictEqual(session.currentPage, 3);
});

test('createReaderSession fails safely without chapter', function () {
  var session = readerSession.createReaderSession({ series: { id: 's1' }, sessionId: 't2' });
  assert.ok(session);
  assert.ok(session.error || session.status === 'error');
});

test('setPage and complete emit progress events', function () {
  var session = readerSession.createReaderSession({
    series: { id: 's1' },
    chapter: { id: 'c1' },
    pageCount: 5,
    currentPage: 0,
    sessionId: 't3'
  });
  var moved = readerSession.setPage(session, 4);
  assert.strictEqual(moved.session.currentPage, 4);
  var done = readerSession.complete(moved.session);
  assert.strictEqual(done.session.completed, true);
});

// ---- Chapter navigation order ----
test('next/prev respect decimal chapter order', function () {
  var chapters = [
    { id: 'a', chapter: '1' },
    { id: 'b', chapter: '2.5' },
    { id: 'c', chapter: '2' },
    { id: 'd', chapter: '10' }
  ];
  var sorted = chapterOrder.sortChapters(chapters);
  assert.deepStrictEqual(sorted.map(function (c) { return c.id; }), ['a', 'c', 'b', 'd']);
  assert.strictEqual(chapterOrder.getNextChapter(chapters, chapters[0]).id, 'c');
  assert.strictEqual(chapterOrder.getPreviousChapter(chapters, chapters[3]).id, 'b');
});

// ---- Handoff ----
test('Details handoff validates chapter before reader', function () {
  var series = {
    id: 's1',
    chapters: [
      { id: 'c1', chapter: '1', remoteId: 'r1', sources: [{ sourceId: 'mangadex', remoteId: 'r1' }] }
    ]
  };
  var v = chapterSystem.validateOpenChapter(series, 'c1');
  assert.strictEqual(v.ok, true);
  var req = chapterSystem.createOpenChapterRequest(series, v.chapter, { pageIndex: 2 });
  assert.strictEqual(req.ok, true);
  assert.strictEqual(req.chapterId, 'c1');
  assert.ok(!('sourceUrl' in req));
});

test('unavailable chapter handoff fails safely', function () {
  var series = {
    id: 's1',
    chapters: [{ id: 'c1', chapter: '1', available: false }]
  };
  var v = chapterSystem.validateOpenChapter(series, 'c1');
  assert.strictEqual(v.ok, false);
});

function runAsync() {
  return readerPageService.loadChapterPages({
    seriesId: 's1', chapterId: 'c1', requestToken: 1,
    fetchPages: function () {
      return Promise.resolve(['https://cdn.example/1.jpg', 'https://cdn.example/2.jpg']);
    }
  }).then(function (res) {
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.usable, 2);
    passed++;
    console.log('  OK  loadChapterPages normalizes and succeeds');
  }).then(function () {
    return readerPageService.loadChapterPages({
      seriesId: 's1', chapterId: 'c1', requestToken: 2,
      fetchPages: function () { return Promise.resolve([]); }
    });
  }).then(function (res) {
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.empty, true);
    passed++;
    console.log('  OK  empty pages failure');
  }).then(function () {
    return readerPageService.loadChapterPages({
      seriesId: 's1', chapterId: 'c1', requestToken: 3,
      fetchPages: function () { return Promise.reject(new Error('network')); }
    });
  }).then(function (res) {
    assert.strictEqual(res.ok, false);
    passed++;
    console.log('  OK  fetch failure handled without throw');
  }).then(function () {
    var slow = readerPageService.loadChapterPages({
      seriesId: 's1', chapterId: 'cx', requestToken: 10,
      fetchPages: function () {
        return new Promise(function (resolve) {
          setTimeout(function () { resolve(['https://cdn.example/old.jpg']); }, 40);
        });
      }
    });
    var fast = readerPageService.loadChapterPages({
      seriesId: 's1', chapterId: 'cx', requestToken: 20,
      fetchPages: function () {
        return Promise.resolve(['https://cdn.example/new.jpg']);
      }
    });
    return Promise.all([slow, fast]);
  }).then(function (pair) {
    assert.strictEqual(pair[0].stale, true);
    assert.strictEqual(pair[1].stale, false);
    passed++;
    console.log('  OK  stale page request discarded');
  }).then(function () {
    return readerPageService.loadChapterPages({
      seriesId: 's1', chapterId: 'c1', requestToken: 5,
      existingPages: ['https://cdn.example/a.jpg'],
      fetchPages: function () { throw new Error('should not call'); }
    });
  }).then(function (res) {
    assert.strictEqual(res.ok, true);
    passed++;
    console.log('  OK  existingPages skips network');
  }).then(function () {
    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    if (failed) process.exit(1);
  }).catch(function (e) {
    failed++;
    console.error('FAIL async', e);
    process.exit(1);
  });
}

runAsync();
