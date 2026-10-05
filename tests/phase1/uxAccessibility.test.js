
'use strict';
/**
 * Phase 1 / Stage 7 — UX, accessibility & performance structural tests.
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');

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

console.log('uxAccessibility.test.js');

test('sr-only utility and a11y-status live region exist', function () {
  assert.ok(indexHtml.indexOf('class="sr-only"') >= 0 || indexHtml.indexOf('.sr-only{') >= 0);
  assert.ok(indexHtml.indexOf('id="a11y-status"') >= 0);
  assert.ok(indexHtml.indexOf('aria-live="polite"') >= 0);
});

test('announceStatus helper exists and toast wires it', function () {
  assert.ok(indexHtml.indexOf('function announceStatus') >= 0);
  // Stage 7B: the toast no longer owns a live region; it routes through the single announcer.
  assert.ok(/announceStatus\(msg, \{ assertive:/.test(indexHtml));
});

test('focus-visible styles for primary controls', function () {
  assert.ok(indexHtml.indexOf(':focus-visible') >= 0);
  assert.ok(indexHtml.indexOf('.btn:focus-visible') >= 0 || indexHtml.indexOf('button:focus-visible') >= 0);
});

test('touch target minima for icon and tab controls', function () {
  assert.ok(indexHtml.indexOf('min-height: 44px') >= 0 || indexHtml.indexOf('min-height:44px') >= 0);
  assert.ok(indexHtml.indexOf('.icon-btn') >= 0);
});

test('safe-area insets used for fixed chrome', function () {
  assert.ok(indexHtml.indexOf('safe-area-inset-top') >= 0);
  assert.ok(indexHtml.indexOf('safe-area-inset-bottom') >= 0);
});

test('prefers-reduced-motion is respected', function () {
  assert.ok(indexHtml.indexOf('prefers-reduced-motion') >= 0);
});

test('horizontal overflow guarded on shell', function () {
  assert.ok(indexHtml.indexOf('overflow-x: hidden') >= 0 || indexHtml.indexOf('overflow-x:hidden') >= 0);
});

test('Reader keyboard controller still present (Stage 5)', function () {
  assert.ok(indexHtml.indexOf('attachReaderKeyboardController') >= 0);
  assert.ok(indexHtml.indexOf('readerKeyboard') >= 0 || indexHtml.indexOf('ReaderKeyboard') >= 0);
});

test('chapter list pagination limit remains (performance)', function () {
  assert.ok(indexHtml.indexOf('seriesChapterLimit') >= 0);
  assert.ok(indexHtml.indexOf('show-more-chapters') >= 0);
});

test('Reader page pipeline still uses ReaderPageService', function () {
  assert.ok(indexHtml.indexOf('ReaderPageService.loadChapterPages') >= 0);
});

test('Continuity resolver still authoritative', function () {
  assert.ok(indexHtml.indexOf('ReadingContinuity.resolveSeriesContinuity') >= 0);
  assert.ok(indexHtml.indexOf('resolveExplicitChapterOpen') >= 0);
});

test('toast is role=status for polite announcements', function () {
  assert.ok(indexHtml.indexOf('id="toast"') >= 0);
  assert.ok(indexHtml.indexOf('role="status"') >= 0);
});

test('enhanceActionableFocusability exists for non-native controls', function () {
  assert.ok(indexHtml.indexOf('function enhanceActionableFocusability') >= 0);
});

test('no chapter reading redirects introduced (structural)', function () {
  // openChapterInApp must not window.open
  var start = indexHtml.indexOf('function openChapterInApp');
  var slice = indexHtml.slice(start, start + 2500);
  assert.ok(slice.indexOf('window.open') < 0);
});

test('ux-state empty/error pattern available', function () {
  assert.ok(indexHtml.indexOf('.ux-state') >= 0);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
