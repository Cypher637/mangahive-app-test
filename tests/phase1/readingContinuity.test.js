'use strict';
/**
 * Phase 1 / Stage 6 — Reading Continuity & Resume tests.
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');

var continuity = require(path.join(__dirname, '../../src/domain/readingContinuity.js'));
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

function seriesFixture(chapters) {
  return {
    id: 's1',
    canonicalId: 's1',
    title: 'Test',
    chapters: chapters || [
      { id: 'c1', chapter: '1', title: 'One' },
      { id: 'c2', chapter: '2', title: 'Two' },
      { id: 'c2_5', chapter: '2.5', title: 'Extra' },
      { id: 'c3', chapter: '3', title: 'Three' },
      { id: 'c10', chapter: '10', title: 'Ten' }
    ],
    readChapters: {}
  };
}

console.log('readingContinuity.test.js');

// ---- Structural ----
test('index loads readingContinuity and resolveSeriesContinue', function () {
  assert.ok(indexHtml.indexOf('src/domain/readingContinuity.js') >= 0);
  assert.ok(indexHtml.indexOf('function resolveSeriesContinue') >= 0);
  assert.ok(indexHtml.indexOf('ReadingContinuity.resolveSeriesContinuity') >= 0);
});

test('bestOpenTarget uses continuity resolver', function () {
  var start = indexHtml.indexOf('function bestOpenTarget');
  var slice = indexHtml.slice(start, start + 800);
  assert.ok(slice.indexOf('resolveSeriesContinue') >= 0);
});

test('continueReadingItems uses resolveSeriesContinue', function () {
  var start = indexHtml.indexOf('function continueReadingItems');
  var slice = indexHtml.slice(start, start + 1500);
  assert.ok(slice.indexOf('resolveSeriesContinue') >= 0);
});

// ---- Resolution cases ----

test('no progress → first unread / start', function () {
  var s = seriesFixture();
  var r = continuity.resolveSeriesContinuity(s, {});
  assert.strictEqual(r.kind, 'start');
  assert.strictEqual(r.chapterId, 'c1');
  assert.strictEqual(r.pageIndex, 0);
});

test('incomplete progress → saved chapter and page', function () {
  var s = seriesFixture();
  var r = continuity.resolveSeriesContinuity(s, {
    c2: { chapterId: 'c2', pageIndex: 7, pageCount: 20, updatedAt: 100, completed: false }
  });
  assert.strictEqual(r.kind, 'continue');
  assert.strictEqual(r.chapterId, 'c2');
  assert.strictEqual(r.pageIndex, 7);
});

test('completed chapter → next unread', function () {
  var s = seriesFixture();
  s.readChapters = { c1: true };
  var r = continuity.resolveSeriesContinuity(s, {
    c1: { chapterId: 'c1', pageIndex: 9, pageCount: 10, updatedAt: 50, completed: true }
  });
  assert.ok(r.kind === 'next' || r.kind === 'continue');
  assert.strictEqual(r.chapterId, 'c2');
  assert.strictEqual(r.pageIndex, 0);
});

test('all chapters completed → finished / all caught up', function () {
  var s = seriesFixture([
    { id: 'a', chapter: '1' },
    { id: 'b', chapter: '2' }
  ]);
  s.readChapters = { a: true, b: true };
  var r = continuity.resolveSeriesContinuity(s, {
    a: { chapterId: 'a', pageIndex: 5, pageCount: 5, updatedAt: 1, completed: true },
    b: { chapterId: 'b', pageIndex: 5, pageCount: 5, updatedAt: 2, completed: true }
  });
  assert.strictEqual(r.kind, 'finished');
});

test('multiple records → latest by updatedAt', function () {
  var s = seriesFixture();
  var r = continuity.resolveSeriesContinuity(s, {
    c1: { chapterId: 'c1', pageIndex: 1, pageCount: 10, updatedAt: 10, completed: false },
    c3: { chapterId: 'c3', pageIndex: 4, pageCount: 10, updatedAt: 99, completed: false }
  });
  assert.strictEqual(r.chapterId, 'c3');
  assert.strictEqual(r.pageIndex, 4);
});

test('page index clamped to page count', function () {
  var s = seriesFixture();
  var r = continuity.resolveSeriesContinuity(s, {
    c1: { chapterId: 'c1', pageIndex: 999, pageCount: 10, updatedAt: 1, completed: false }
  });
  assert.strictEqual(r.pageIndex, 9);
});

test('negative / invalid page recovers', function () {
  var s = seriesFixture();
  var r = continuity.resolveSeriesContinuity(s, {
    c1: { chapterId: 'c1', pageIndex: -50, pageCount: 10, updatedAt: 1, completed: false }
  });
  assert.ok(r.pageIndex >= 0);
  var r2 = continuity.resolveSeriesContinuity(s, {
    c1: { chapterId: 'c1', pageIndex: 'abc', pageCount: 10, updatedAt: 1, completed: false }
  });
  assert.ok(r2.pageIndex >= 0);
});

test('missing saved chapter → safe continuation', function () {
  var s = seriesFixture();
  var r = continuity.resolveSeriesContinuity(s, {
    gone: { chapterId: 'gone', pageIndex: 3, pageCount: 10, updatedAt: 50, completed: false }
  });
  assert.ok(r.chapter);
  assert.ok(r.chapterId !== 'gone' || r.kind === 'missing');
  if (r.kind !== 'missing') {
    assert.ok(['c1', 'c2', 'c2_5', 'c3', 'c10'].indexOf(r.chapterId) >= 0);
  }
});

test('decimal chapter order for next unread', function () {
  var s = seriesFixture();
  s.readChapters = { c1: true, c2: true };
  var next = continuity.getNextUnreadChapter(s, {
    seriesProgress: {
      c1: { chapterId: 'c1', completed: true, updatedAt: 1, pageIndex: 0, pageCount: 1 },
      c2: { chapterId: 'c2', completed: true, updatedAt: 2, pageIndex: 0, pageCount: 1 }
    },
    readChapters: s.readChapters
  });
  assert.strictEqual(next.id, 'c2_5');
});

test('explicit open of completed chapter does not skip', function () {
  var s = seriesFixture();
  var ch = s.chapters[0];
  var ex = continuity.resolveExplicitChapterOpen(s, ch, {
    c1: { chapterId: 'c1', pageIndex: 9, pageCount: 10, updatedAt: 1, completed: true }
  });
  assert.strictEqual(ex.ok, true);
  assert.strictEqual(ex.chapterId, 'c1');
  // completed + last page → resume policy restarts at 0
  assert.strictEqual(ex.pageIndex, 0);
});

test('Continue Reading skips completed; explicit does not', function () {
  var s = seriesFixture();
  var cont = continuity.resolveSeriesContinuity(s, {
    c1: { chapterId: 'c1', pageIndex: 5, pageCount: 5, updatedAt: 10, completed: true }
  }, { readChapters: { c1: true } });
  assert.notStrictEqual(cont.chapterId, 'c1');
  var ex = continuity.resolveExplicitChapterOpen(s, s.chapters[0], {
    c1: { chapterId: 'c1', pageIndex: 5, pageCount: 5, updatedAt: 10, completed: true }
  });
  assert.strictEqual(ex.chapterId, 'c1');
});

test('legacy single progress pointer works', function () {
  var s = seriesFixture();
  var r = continuity.resolveSeriesContinuity(s, {
    chapterId: 'c3',
    pageIndex: 2,
    updatedAt: 40
  });
  assert.strictEqual(r.chapterId, 'c3');
  assert.strictEqual(r.pageIndex, 2);
});

test('empty series safe', function () {
  var r = continuity.resolveSeriesContinuity({ id: 'x', chapters: [] }, {});
  assert.strictEqual(r.kind, 'empty');
});

test('malformed chapterId null does not crash', function () {
  var s = seriesFixture();
  var r = continuity.resolveSeriesContinuity(s, {
    bad: { chapterId: null, pageIndex: 1, updatedAt: 1 }
  });
  assert.ok(r);
  assert.ok(r.kind === 'start' || r.kind === 'continue' || r.kind === 'next');
});

test('chapter reorder keeps progress on same chapter id', function () {
  var s = seriesFixture();
  // progress on c3
  var r1 = continuity.resolveSeriesContinuity(s, {
    c3: { chapterId: 'c3', pageIndex: 1, pageCount: 8, updatedAt: 5, completed: false }
  });
  assert.strictEqual(r1.chapterId, 'c3');
  // reorder chapters array
  s.chapters = s.chapters.slice().reverse();
  var r2 = continuity.resolveSeriesContinuity(s, {
    c3: { chapterId: 'c3', pageIndex: 1, pageCount: 8, updatedAt: 5, completed: false }
  });
  assert.strictEqual(r2.chapterId, 'c3');
  assert.strictEqual(r2.pageIndex, 1);
});

test('canonical identity finds chapter when local id drifts', function () {
  var s = seriesFixture();
  s.chapters[1].canonicalChapterId = 'mhch:series:2';
  var r = continuity.resolveSeriesContinuity(s, {
    old: {
      chapterId: 'old',
      canonicalChapterId: 'mhch:series:2',
      pageIndex: 3,
      pageCount: 10,
      updatedAt: 7,
      completed: false
    }
  });
  assert.strictEqual(r.chapterId, 'c2');
  assert.strictEqual(r.pageIndex, 3);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
