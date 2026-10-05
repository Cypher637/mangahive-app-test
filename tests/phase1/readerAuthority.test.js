'use strict';
/**
 * Stage 5 final hardening — ReaderSession authority, completion, keyboard, structural regression.
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');

var readerSession = require(path.join(__dirname, '../../src/domain/readerSession.js'));
var readerKeyboard = require(path.join(__dirname, '../../src/domain/readerKeyboard.js'));
var readerPageService = require(path.join(__dirname, '../../src/services/readerPageService.js'));
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

console.log('readerAuthority.test.js');

// ---- Structural architecture ----

test('live Reader has applyDomainPage / activeDomainReaderSession', function () {
  assert.ok(indexHtml.indexOf('function applyDomainPage') >= 0);
  assert.ok(indexHtml.indexOf('activeDomainReaderSession') >= 0);
  assert.ok(indexHtml.indexOf('function applyDomainComplete') >= 0);
});

test('applyPageIndex routes through applyDomainPage', function () {
  var start = indexHtml.indexOf('function applyPageIndex');
  assert.ok(start >= 0);
  var slice = indexHtml.slice(start, start + 2000);
  assert.ok(slice.indexOf('applyDomainPage') >= 0);
});

test('completion routes through ReaderSession.complete via applyDomainComplete', function () {
  assert.ok(indexHtml.indexOf('ReaderSessionDomain.complete') >= 0);
  assert.ok(indexHtml.indexOf('function applyDomainComplete') >= 0);
});

test('ReaderPageService remains authoritative page path', function () {
  var start = indexHtml.indexOf('function resolvePagesForChapter');
  var slice = indexHtml.slice(start, start + 3000);
  assert.ok(slice.indexOf('ReaderPageService.loadChapterPages') >= 0);
});

test('keyboard controller is dedicated and attachable', function () {
  assert.ok(indexHtml.indexOf('function attachReaderKeyboardController') >= 0);
  assert.ok(indexHtml.indexOf('function onReaderKeyboardEvent') >= 0);
  assert.ok(indexHtml.indexOf('src/domain/readerKeyboard.js') >= 0);
});

test('stale session cleared on new renderReader and goBack', function () {
  assert.ok(indexHtml.indexOf('clearActiveDomainReaderSession') >= 0);
  assert.ok(indexHtml.indexOf('detachReaderKeyboardController') >= 0);
});

// ---- Session authority (domain) ----

test('page change goes through setPage', function () {
  var s = readerSession.createReaderSession({
    series: { id: 's1' }, chapter: { id: 'c1' }, pageCount: 10, currentPage: 0, sessionId: 'a1'
  });
  var r = readerSession.setPage(s, 4);
  assert.strictEqual(r.session.currentPage, 4);
  assert.strictEqual(r.session.sessionId, 'a1');
});

test('next/previous page update session', function () {
  var s = readerSession.createReaderSession({
    series: { id: 's1' }, chapter: { id: 'c1' }, pageCount: 5, currentPage: 2, sessionId: 'a2'
  });
  var n = readerSession.nextPage(s);
  assert.strictEqual(n.session.currentPage, 3);
  var p = readerSession.previousPage(n.session);
  assert.strictEqual(p.session.currentPage, 2);
});

test('resume initializes clamped page', function () {
  var s = readerSession.createReaderSession({
    series: { id: 's1' }, chapter: { id: 'c1' }, pageCount: 10, currentPage: 99, sessionId: 'a3'
  });
  assert.strictEqual(s.currentPage, 9);
  var s2 = readerSession.createReaderSession({
    series: { id: 's1' }, chapter: { id: 'c1' }, pageCount: 10, currentPage: -5, sessionId: 'a4'
  });
  assert.strictEqual(s2.currentPage, 0);
});

test('jump-to-page is setPage', function () {
  var s = readerSession.createReaderSession({
    series: { id: 's1' }, chapter: { id: 'c1' }, pageCount: 20, currentPage: 0, sessionId: 'a5'
  });
  var j = readerSession.setPage(s, 12);
  assert.strictEqual(j.session.currentPage, 12);
});

// ---- Completion ----

test('complete is idempotent', function () {
  var s = readerSession.createReaderSession({
    series: { id: 's1' }, chapter: { id: 'c1' }, pageCount: 5, currentPage: 4, sessionId: 'c1'
  });
  var d1 = readerSession.complete(s, { now: 1000 });
  assert.strictEqual(d1.session.completed, true);
  assert.strictEqual(d1.session.completedAt, 1000);
  var d2 = readerSession.complete(d1.session, { now: 2000 });
  assert.strictEqual(d2.session.completed, true);
  // existing contract: already completed does not rewrite completedAt
  assert.strictEqual(d2.session.completedAt, 1000);
  assert.deepStrictEqual(d2.events, []);
});

test('completing one chapter does not affect another session', function () {
  var a = readerSession.createReaderSession({
    series: { id: 's1' }, chapter: { id: 'c1' }, pageCount: 3, currentPage: 2, sessionId: 'x1'
  });
  var b = readerSession.createReaderSession({
    series: { id: 's1' }, chapter: { id: 'c2' }, pageCount: 3, currentPage: 0, sessionId: 'x2'
  });
  var done = readerSession.complete(a);
  assert.strictEqual(done.session.chapter.id, 'c1');
  assert.strictEqual(b.completed, false);
  assert.strictEqual(b.chapter.id, 'c2');
});

// ---- Race: sessions are independent snapshots ----

test('old session object cannot mutate new session', function () {
  var oldS = readerSession.createReaderSession({
    series: { id: 's1' }, chapter: { id: 'c1' }, pageCount: 5, currentPage: 1, sessionId: 'old'
  });
  var newS = readerSession.createReaderSession({
    series: { id: 's1' }, chapter: { id: 'c2' }, pageCount: 8, currentPage: 0, sessionId: 'new'
  });
  var moved = readerSession.setPage(oldS, 4);
  assert.strictEqual(moved.session.sessionId, 'old');
  assert.strictEqual(newS.currentPage, 0);
  assert.strictEqual(newS.chapter.id, 'c2');
});

// ---- Keyboard ----

test('Escape closes reader', function () {
  var r = readerKeyboard.resolveKeyAction({
    key: 'Escape', readerActive: true, target: { tagName: 'DIV' }
  });
  assert.strictEqual(r.action, 'close_reader');
  assert.strictEqual(r.preventDefault, true);
});

test('Arrow navigation paged LTR', function () {
  var left = readerKeyboard.resolveKeyAction({
    key: 'ArrowLeft', readerActive: true, mode: 'paged', direction: 'ltr', target: { tagName: 'DIV' }
  });
  var right = readerKeyboard.resolveKeyAction({
    key: 'ArrowRight', readerActive: true, mode: 'paged', direction: 'ltr', target: { tagName: 'DIV' }
  });
  assert.strictEqual(left.action, 'previous_page');
  assert.strictEqual(right.action, 'next_page');
});

test('Arrow navigation paged RTL reverses physical arrows', function () {
  var left = readerKeyboard.resolveKeyAction({
    key: 'ArrowLeft', readerActive: true, mode: 'paged', direction: 'rtl', target: { tagName: 'DIV' }
  });
  var right = readerKeyboard.resolveKeyAction({
    key: 'ArrowRight', readerActive: true, mode: 'paged', direction: 'rtl', target: { tagName: 'DIV' }
  });
  assert.strictEqual(left.action, 'next_page');
  assert.strictEqual(right.action, 'previous_page');
});

test('PageUp/PageDown map to previous/next page', function () {
  var up = readerKeyboard.resolveKeyAction({
    key: 'PageUp', readerActive: true, target: { tagName: 'BODY' }
  });
  var down = readerKeyboard.resolveKeyAction({
    key: 'PageDown', readerActive: true, target: { tagName: 'BODY' }
  });
  assert.strictEqual(up.action, 'previous_page');
  assert.strictEqual(down.action, 'next_page');
});

test('Space next page; Shift+Space previous', function () {
  var sp = readerKeyboard.resolveKeyAction({
    key: ' ', readerActive: true, target: { tagName: 'DIV' }
  });
  var sh = readerKeyboard.resolveKeyAction({
    key: ' ', shiftKey: true, readerActive: true, target: { tagName: 'DIV' }
  });
  assert.strictEqual(sp.action, 'next_page');
  assert.strictEqual(sh.action, 'previous_page');
});

test('keyboard inactive inside text inputs', function () {
  var r = readerKeyboard.resolveKeyAction({
    key: 'ArrowRight', readerActive: true, target: { tagName: 'INPUT' }
  });
  assert.strictEqual(r.action, null);
  var r2 = readerKeyboard.resolveKeyAction({
    key: ' ', readerActive: true, target: { tagName: 'TEXTAREA' }
  });
  assert.strictEqual(r2.action, null);
});

test('keyboard inactive when reader not active', function () {
  var r = readerKeyboard.resolveKeyAction({
    key: 'Escape', readerActive: false, target: { tagName: 'DIV' }
  });
  assert.strictEqual(r.action, null);
});

test('continuous mode arrows scroll', function () {
  var up = readerKeyboard.resolveKeyAction({
    key: 'ArrowUp', readerActive: true, mode: 'webtoon', target: { tagName: 'DIV' }
  });
  var down = readerKeyboard.resolveKeyAction({
    key: 'ArrowDown', readerActive: true, mode: 'webtoon', target: { tagName: 'DIV' }
  });
  assert.strictEqual(up.action, 'scroll_up');
  assert.strictEqual(down.action, 'scroll_down');
});

// ---- ChapterOrder still authoritative ----

test('ChapterOrder prev/next still used (not index math alone)', function () {
  assert.ok(indexHtml.indexOf('getNextChapter') >= 0);
  var chapters = [
    { id: 'a', chapter: '1' },
    { id: 'b', chapter: '2.5' },
    { id: 'c', chapter: '2' }
  ];
  assert.strictEqual(chapterOrder.getNextChapter(chapters, chapters[0]).id, 'c');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
