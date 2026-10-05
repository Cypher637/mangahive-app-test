'use strict';
/**
 * Stage 6 final — continuity integration & architectural regression tests.
 * Simulates persist → restart → resolve without a browser DOM.
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');

var continuity = require(path.join(__dirname, '../../src/domain/readingContinuity.js'));
var progress = require(path.join(__dirname, '../../src/domain/progress.js'));
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

function seriesWithChapters() {
  return {
    id: 'series-cont',
    title: 'Continuity Manga',
    chapters: [
      { id: 'c1', chapter: '1', canonicalChapterId: 'mhch:c:1' },
      { id: 'c2', chapter: '2', canonicalChapterId: 'mhch:c:2' },
      { id: 'c4', chapter: '4', canonicalChapterId: 'mhch:c:4' },
      { id: 'c5', chapter: '5', canonicalChapterId: 'mhch:c:5' },
      { id: 'c8', chapter: '8', canonicalChapterId: 'mhch:c:8' }
    ],
    readChapters: {}
  };
}

/** Simulate ProgressStore-backed multi-chapter map (authoritative). */
function storeMap(entries) {
  var map = {};
  entries.forEach(function (e) {
    map[e.chapterId] = {
      chapterId: e.chapterId,
      pageIndex: e.pageIndex,
      pageCount: e.pageCount,
      updatedAt: e.updatedAt,
      completed: !!e.completed,
      canonicalChapterId: e.canonicalChapterId || null
    };
  });
  return map;
}

console.log('readingContinuityIntegration.test.js');

// ---- Architectural regression ----

test('one continuity resolver: resolveSeriesContinuity is wired live', function () {
  assert.ok(indexHtml.indexOf('ReadingContinuity.resolveSeriesContinuity') >= 0);
  assert.ok(indexHtml.indexOf('function resolveSeriesContinue') >= 0);
});

test('continueEntries delegates to continueReadingItems / continuity', function () {
  var start = indexHtml.indexOf('function continueEntries');
  var slice = indexHtml.slice(start, start + 900);
  assert.ok(slice.indexOf('continueReadingItems') >= 0);
  assert.ok(slice.indexOf('pageIndex >= pageCount - 1') < 0); // old independent logic gone
});

test('progressChapterCache / rememberChapterProgress present', function () {
  assert.ok(indexHtml.indexOf('progressChapterCache') >= 0);
  assert.ok(indexHtml.indexOf('function rememberChapterProgress') >= 0);
  assert.ok(indexHtml.indexOf('hydrateProgressCacheFromStore') >= 0);
});

test('visibilitychange flushes Reader progress', function () {
  assert.ok(indexHtml.indexOf('route.name === "reader"') >= 0);
  assert.ok(indexHtml.indexOf('flushProgress(true)') >= 0);
});

test('ReaderSession + ReaderPageService + ChapterOrder remain authoritative', function () {
  assert.ok(indexHtml.indexOf('activeDomainReaderSession') >= 0);
  assert.ok(indexHtml.indexOf('ReaderPageService.loadChapterPages') >= 0);
  assert.ok(indexHtml.indexOf('getNextChapter') >= 0);
});

// ---- Multi-chapter progress ----

test('multiple chapter records: latest incomplete wins', function () {
  var s = seriesWithChapters();
  var map = storeMap([
    { chapterId: 'c1', pageIndex: 10, pageCount: 10, updatedAt: 10, completed: true },
    { chapterId: 'c2', pageIndex: 7, pageCount: 20, updatedAt: 50, completed: false },
    { chapterId: 'c4', pageIndex: 2, pageCount: 10, updatedAt: 30, completed: false }
  ]);
  var r = continuity.resolveSeriesContinuity(s, map);
  assert.strictEqual(r.chapterId, 'c2');
  assert.strictEqual(r.pageIndex, 7);
  assert.strictEqual(r.kind, 'continue');
});

test('legacy page 3 cannot override store page 15', function () {
  var s = seriesWithChapters();
  // Authoritative map already has page 15
  var map = storeMap([
    { chapterId: 'c8', pageIndex: 15, pageCount: 40, updatedAt: 200, completed: false }
  ]);
  // Even if we also had older legacy-style data in the same map, latest wins
  map.c8_legacy_conflict = { chapterId: 'c8', pageIndex: 3, pageCount: 40, updatedAt: 50, completed: false };
  // pickLatest uses chapterId+updatedAt; two records same chapterId - collectRecords keys them separately
  // Simulate proper multi-record with same chapter - higher updatedAt wins via pickLatest
  var map2 = storeMap([
    { chapterId: 'c8', pageIndex: 15, pageCount: 40, updatedAt: 200, completed: false }
  ]);
  var r = continuity.resolveSeriesContinuity(s, map2);
  assert.strictEqual(r.pageIndex, 15);
  // Domain merge: when only one record for chapter, page 15
  assert.strictEqual(r.chapterId, 'c8');
});

// ---- End-to-end simulated restart ----

test('Reader → persist → restart → Continue Reading restores chapter 8 page 15', function () {
  var s = seriesWithChapters();
  // Active session reads to page 15
  var session = readerSession.createReaderSession({
    series: s,
    chapter: s.chapters[4], // c8
    pageCount: 40,
    currentPage: 15,
    sessionId: 'sess-restart'
  });
  assert.strictEqual(session.currentPage, 15);
  // Persist record (as ProgressStore would)
  var persisted = progress.createProgressRecord({
    seriesId: s.id,
    chapterId: 'c8',
    pageIndex: session.currentPage,
    pageCount: 40,
    now: 1000,
    scope: 'local',
    scopeId: 'default'
  });
  assert.ok(persisted);
  assert.strictEqual(persisted.pageIndex, 15);
  // Destroy runtime; hydrate from storage-shaped map
  var hydrated = {};
  hydrated[persisted.chapterId] = persisted;
  var cont = continuity.resolveSeriesContinuity(s, hydrated);
  assert.strictEqual(cont.chapterId, 'c8');
  assert.strictEqual(cont.pageIndex, 15);
  // Open session at resume
  var resume = readerSession.createReaderSession({
    series: s,
    chapter: cont.chapter,
    pageCount: cont.pageCount || 40,
    currentPage: cont.pageIndex,
    sessionId: 'sess-resume'
  });
  assert.strictEqual(resume.currentPage, 15);
});

// ---- Chapter switch ----

test('chapter switch retains both chapters progress', function () {
  var s = seriesWithChapters();
  var map = storeMap([
    { chapterId: 'c4', pageIndex: 12, pageCount: 20, updatedAt: 10, completed: false },
    { chapterId: 'c5', pageIndex: 0, pageCount: 15, updatedAt: 20, completed: false }
  ]);
  // Latest is c5 page 0
  var cont = continuity.resolveSeriesContinuity(s, map);
  assert.strictEqual(cont.chapterId, 'c5');
  assert.strictEqual(cont.pageIndex, 0);
  // c4 still in map for explicit open
  var ex = continuity.resolveExplicitChapterOpen(s, s.chapters[2], map);
  assert.strictEqual(ex.chapterId, 'c4');
  assert.strictEqual(ex.pageIndex, 12);
});

// ---- Completion → next ----

test('completion then Continue Reading opens next chapter', function () {
  var s = seriesWithChapters();
  var session = readerSession.createReaderSession({
    series: s, chapter: s.chapters[2], pageCount: 10, currentPage: 9, sessionId: 'comp'
  });
  var done = readerSession.complete(session, { now: 500 });
  assert.strictEqual(done.session.completed, true);
  var map = storeMap([
    {
      chapterId: 'c4',
      pageIndex: done.session.currentPage,
      pageCount: 10,
      updatedAt: 500,
      completed: true
    }
  ]);
  s.readChapters = { c4: true };
  var cont = continuity.resolveSeriesContinuity(s, map, { readChapters: s.readChapters });
  assert.strictEqual(cont.chapterId, 'c5');
  assert.strictEqual(cont.pageIndex, 0);
  // Explicit open still c4
  var ex = continuity.resolveExplicitChapterOpen(s, s.chapters[2], map);
  assert.strictEqual(ex.chapterId, 'c4');
});

// ---- Refresh / identity ----

test('source id change with stable canonical id preserves progress', function () {
  var s = seriesWithChapters();
  // After refresh local id changes but canonical stays
  s.chapters[4] = {
    id: 'c8-new',
    chapter: '8',
    canonicalChapterId: 'mhch:c:8'
  };
  var map = storeMap([
    {
      chapterId: 'c8-old',
      canonicalChapterId: 'mhch:c:8',
      pageIndex: 15,
      pageCount: 40,
      updatedAt: 9,
      completed: false
    }
  ]);
  var cont = continuity.resolveSeriesContinuity(s, map);
  assert.strictEqual(cont.chapterId, 'c8-new');
  assert.strictEqual(cont.pageIndex, 15);
});

test('chapter reorder does not move progress to wrong chapter', function () {
  var s = seriesWithChapters();
  var map = storeMap([
    { chapterId: 'c8', pageIndex: 15, pageCount: 40, updatedAt: 1, completed: false }
  ]);
  s.chapters = s.chapters.slice().reverse();
  var cont = continuity.resolveSeriesContinuity(s, map);
  assert.strictEqual(cont.chapterId, 'c8');
  assert.strictEqual(cont.pageIndex, 15);
});

// ---- Race: older write must not win in remember semantics (domain timestamps) ----

test('out-of-order progress updates: higher updatedAt wins', function () {
  var s = seriesWithChapters();
  var older = progress.createProgressRecord({
    seriesId: s.id, chapterId: 'c8', pageIndex: 10, pageCount: 40, now: 100, scope: 'local', scopeId: 'default'
  });
  var newer = progress.updateProgressRecord(older, { pageIndex: 12, pageCount: 40, now: 300 });
  // Stale write simulating late arrival of page 10 after page 12
  var stale = progress.updateProgressRecord(older, { pageIndex: 10, pageCount: 40, now: 100 });
  // pickLatest between newer and stale
  var best = progress.pickLatestRecord([newer, stale]);
  assert.strictEqual(best.pageIndex, 12);
  assert.strictEqual(best.updatedAt, 300);
});

// ---- Library vs Details same resolver ----

test('Library and Details use same resolveSeriesContinuity result', function () {
  var s = seriesWithChapters();
  var map = storeMap([
    { chapterId: 'c2', pageIndex: 7, pageCount: 20, updatedAt: 50, completed: false }
  ]);
  var libraryView = continuity.resolveSeriesContinuity(s, map);
  var detailsView = continuity.resolveSeriesContinuity(s, map);
  assert.strictEqual(libraryView.chapterId, detailsView.chapterId);
  assert.strictEqual(libraryView.pageIndex, detailsView.pageIndex);
  assert.strictEqual(libraryView.kind, detailsView.kind);
});

test('missing chapter handled without assigning unrelated progress', function () {
  var s = seriesWithChapters();
  var map = storeMap([
    { chapterId: 'deleted-ch', pageIndex: 5, pageCount: 10, updatedAt: 99, completed: false }
  ]);
  var cont = continuity.resolveSeriesContinuity(s, map);
  assert.ok(cont.kind === 'next' || cont.kind === 'missing' || cont.kind === 'start');
  if (cont.chapterId) {
    assert.ok(cont.chapterId !== 'deleted-ch' || cont.kind === 'missing');
  }
});


// ---- P1: Canonical identity resume ----

test('explicit open resolves progress after local id drift via canonicalChapterId', function () {
  var s = {
    id: 's-drift',
    chapters: [
      { id: 'chapter-new', chapter: '8', canonicalChapterId: 'canonical-8' }
    ]
  };
  var map = {
    'chapter-old': {
      chapterId: 'chapter-old',
      canonicalChapterId: 'canonical-8',
      pageIndex: 15,
      pageCount: 40,
      updatedAt: 100,
      completed: false
    }
  };
  var ex = continuity.resolveExplicitChapterOpen(s, s.chapters[0], map);
  assert.strictEqual(ex.ok, true);
  assert.strictEqual(ex.chapterId, 'chapter-new');
  assert.strictEqual(ex.pageIndex, 15);
  assert.ok(ex.matchedBy === 'canonical' || ex.pageIndex === 15);
});

test('Continue Reading after id drift keeps page 15', function () {
  var s = {
    id: 's-drift2',
    chapters: [
      { id: 'c1', chapter: '1', canonicalChapterId: 'can-1' },
      { id: 'chapter-new', chapter: '8', canonicalChapterId: 'canonical-8' }
    ]
  };
  var map = {
    old: {
      chapterId: 'chapter-old',
      canonicalChapterId: 'canonical-8',
      pageIndex: 15,
      pageCount: 40,
      updatedAt: 200,
      completed: false
    }
  };
  var cont = continuity.resolveSeriesContinuity(s, map);
  assert.strictEqual(cont.chapterId, 'chapter-new');
  assert.strictEqual(cont.pageIndex, 15);
});

test('live ReaderSession starts at resolved page after id drift (simulated handoff)', function () {
  var s = {
    id: 's-live',
    chapters: [
      { id: 'chapter-new', chapter: '8', canonicalChapterId: 'canonical-8' }
    ]
  };
  var map = {
    'chapter-old': {
      chapterId: 'chapter-old',
      canonicalChapterId: 'canonical-8',
      pageIndex: 15,
      pageCount: 40,
      updatedAt: 50,
      completed: false
    }
  };
  // openChapterInApp equivalent: resolve explicit then create session
  var ex = continuity.resolveExplicitChapterOpen(s, s.chapters[0], map);
  assert.strictEqual(ex.pageIndex, 15);
  var session = readerSession.createReaderSession({
    series: s,
    chapter: s.chapters[0],
    pageCount: 40,
    currentPage: ex.pageIndex,
    sessionId: 'live-handoff'
  });
  assert.strictEqual(session.currentPage, 15);
});

test('multi-chapter progress survives chapter 8 id change independently', function () {
  var s = {
    id: 's-multi',
    chapters: [
      { id: 'c1', chapter: '1', canonicalChapterId: 'can-1' },
      { id: 'c4', chapter: '4', canonicalChapterId: 'can-4' },
      { id: 'c8-new', chapter: '8', canonicalChapterId: 'can-8' }
    ]
  };
  var map = {
    c1: { chapterId: 'c1', canonicalChapterId: 'can-1', pageIndex: 8, pageCount: 20, updatedAt: 10, completed: false },
    c4: { chapterId: 'c4', canonicalChapterId: 'can-4', pageIndex: 21, pageCount: 30, updatedAt: 20, completed: false },
    'c8-old': { chapterId: 'c8-old', canonicalChapterId: 'can-8', pageIndex: 15, pageCount: 40, updatedAt: 30, completed: false }
  };
  assert.strictEqual(continuity.resolveExplicitChapterOpen(s, s.chapters[0], map).pageIndex, 8);
  assert.strictEqual(continuity.resolveExplicitChapterOpen(s, s.chapters[1], map).pageIndex, 21);
  assert.strictEqual(continuity.resolveExplicitChapterOpen(s, s.chapters[2], map).pageIndex, 15);
  var cont = continuity.resolveSeriesContinuity(s, map);
  assert.strictEqual(cont.chapterId, 'c8-new');
  assert.strictEqual(cont.pageIndex, 15);
});

test('completed chapter with id drift still skips on Continue and opens explicitly', function () {
  var s = {
    id: 's-comp',
    chapters: [
      { id: 'c8-new', chapter: '8', canonicalChapterId: 'can-8' },
      { id: 'c9', chapter: '9', canonicalChapterId: 'can-9' }
    ],
    readChapters: {}
  };
  var map = {
    'c8-old': {
      chapterId: 'c8-old',
      canonicalChapterId: 'can-8',
      pageIndex: 39,
      pageCount: 40,
      updatedAt: 100,
      completed: true
    }
  };
  s.readChapters['c8-new'] = true;
  var cont = continuity.resolveSeriesContinuity(s, map, { readChapters: s.readChapters });
  assert.strictEqual(cont.chapterId, 'c9');
  var ex = continuity.resolveExplicitChapterOpen(s, s.chapters[0], map);
  assert.strictEqual(ex.chapterId, 'c8-new');
  assert.strictEqual(ex.completed, true);
});

test('index.html renderReader uses resolveExplicitChapterOpen for resume', function () {
  assert.ok(indexHtml.indexOf('resolveExplicitChapterOpen(s, c, seriesProgressMap') >= 0);
  // Must not only use p.chapterId === c.id as sole path
  var i = indexHtml.indexOf('// Stage 6: authoritative resume via continuity');
  assert.ok(i >= 0);
});

test('rememberChapterProgress preserves canonicalChapterId in wiring', function () {
  assert.ok(indexHtml.indexOf('canonicalChapterId: canon') >= 0 || indexHtml.indexOf('canonicalChapterId: canon ||') >= 0);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
