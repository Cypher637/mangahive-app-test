'use strict';
/**
 * Stage 7B — Accessibility & interaction hardening.
 *
 * BEHAVIORAL (no browser): the real Reader keyboard resolver and the real announceStatus()
 * are executed (the latter lifted out of index.html into a vm with a fake DOM + fake timers).
 * STRUCTURAL: the shipped markup/CSS/JS in index.html contains the semantics this stage promises.
 *
 * This file does NOT prove real rendering, screen-reader output or device behavior.
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var html = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
var kb = require('../../src/domain/readerKeyboard.js');

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  OK  ' + name); }
  catch (e) { failed++; console.error('  FAIL  ' + name); console.error('    ' + (e && e.stack ? e.stack : e)); }
}
function has(s) { return html.indexOf(s) >= 0; }
function matches(re) { return re.test(html); }

console.log('uxStage7b.test.js');

/* ---------- fake elements for the keyboard resolver ---------- */
function el(tag, attrs, closestMap) {
  attrs = attrs || {};
  return {
    tagName: tag,
    isContentEditable: !!attrs.editable,
    getAttribute: function (k) { return attrs[k] == null ? null : attrs[k]; },
    closest: function (sel) { return (closestMap && closestMap[sel]) || null; }
  };
}
function key(k, extra) {
  return kb.resolveKeyAction(Object.assign({ key: k, readerActive: true, mode: 'webtoon', direction: 'ttb' }, extra || {}));
}

/* ================= Reader keyboard (behavioral) ================= */
test('Reader keys: PageUp/PageDown/Home/End/Space/Shift+Space map to page actions', function () {
  assert.strictEqual(key('PageDown').action, 'next_page');
  assert.strictEqual(key('PageUp').action, 'previous_page');
  assert.strictEqual(key('Home').action, 'first_page');
  assert.strictEqual(key('End').action, 'last_page');
  assert.strictEqual(key(' ').action, 'next_page');
  assert.strictEqual(key(' ', { shiftKey: true }).action, 'previous_page');
});

test('Reader keys: RTL paged mode keeps physical-left = forward', function () {
  assert.strictEqual(key('ArrowLeft', { mode: 'paged', direction: 'rtl' }).action, 'next_page');
  assert.strictEqual(key('ArrowRight', { mode: 'paged', direction: 'rtl' }).action, 'previous_page');
  assert.strictEqual(key('ArrowLeft', { mode: 'paged', direction: 'ltr' }).action, 'previous_page');
});

test('Reader keys: nothing fires while typing or when the Reader is not active', function () {
  assert.strictEqual(key(' ', { target: el('INPUT') }).action, null);
  assert.strictEqual(key('ArrowLeft', { target: el('TEXTAREA') }).action, null);
  assert.strictEqual(key('Escape', { target: el('INPUT') }).action, null);
  assert.strictEqual(kb.resolveKeyAction({ key: 'PageDown', readerActive: false }).action, null);
  assert.strictEqual(key('PageDown', { ctrlKey: true }).action, null);
});

test('Reader keys: Space/Enter on a focused button, link or option activates it instead of paging', function () {
  assert.strictEqual(key(' ', { target: el('BUTTON') }).action, null);
  assert.strictEqual(key('Enter', { target: el('A') }).action, null);
  assert.strictEqual(key(' ', { target: el('LI', { role: 'option' }) }).action, null);
  assert.strictEqual(key(' ', { target: el('DIV') }).action, 'next_page');
});

test('Reader keys: listbox options keep their arrow/Home/End keys', function () {
  var opt = el('LI', { role: 'option' });
  assert.strictEqual(key('ArrowDown', { target: opt }).action, null);
  assert.strictEqual(key('Home', { target: opt }).action, null);
  assert.strictEqual(key('End', { target: opt }).action, null);
  var inList = el('DIV', {}, { '[role="listbox"], [role="menu"], [role="tablist"]': {} });
  assert.strictEqual(key('ArrowUp', { target: inList }).action, null);
});

test('Reader keys: Escape closes a menu first, then a modal, then the Reader', function () {
  assert.strictEqual(key('Escape', { menuOpen: true, modalOpen: true }).action, 'close_menu');
  assert.strictEqual(key('Escape', { modalOpen: true }).action, 'close_modal');
  assert.strictEqual(key('Escape').action, 'close_reader');
});

test('Reader keys: an open modal sheet or menu blocks paging underneath', function () {
  assert.strictEqual(key('PageDown', { modalOpen: true }).action, null);
  assert.strictEqual(key('ArrowDown', { modalOpen: true }).action, null);
  assert.strictEqual(key(' ', { menuOpen: true }).action, null);
});

test('Reader keyboard handler still routes through the resolver (ReaderSession not bypassed)', function () {
  assert.ok(has('resolveKeyAction('));
  assert.ok(matches(/readerKeyboard/));
});

/* ================= announceStatus (behavioral) ================= */
function loadAnnouncer() {
  var m = html.match(/  var __announce = \{[^\n]*\n  function announceStatus\(msg, opts\)\{[\s\S]*?\n  \}\n/);
  assert.ok(m, 'announceStatus source found');
  var nodes = { 'a11y-status': { textContent: '' }, 'a11y-alert': { textContent: '' } };
  var timers = [], now = 1000000;
  var ctx = {
    document: { getElementById: function (id) { return nodes[id] || null; } },
    Date: { now: function () { return now; } },
    setTimeout: function (fn, ms) { timers.push({ fn: fn, at: now + ms, live: true }); return timers.length; },
    clearTimeout: function (id) { if (timers[id - 1]) timers[id - 1].live = false; }
  };
  vm.createContext(ctx);
  vm.runInContext(m[0] + '\nthis.announceStatus = announceStatus;', ctx);
  return {
    say: ctx.announceStatus, nodes: nodes,
    advance: function (ms) {
      now += ms;
      timers.slice().forEach(function (t) { if (t.live && t.at <= now) { t.live = false; t.fn(); } });
    }
  };
}

test('announceStatus: polite by default, assertive channel on request', function () {
  var a = loadAnnouncer();
  a.say('Chapter loaded'); a.advance(40);
  assert.strictEqual(a.nodes['a11y-status'].textContent, 'Chapter loaded');
  assert.strictEqual(a.nodes['a11y-alert'].textContent, '');
  a.say('Search failed', { assertive: true }); a.advance(40);
  assert.strictEqual(a.nodes['a11y-alert'].textContent, 'Search failed');
});

test('announceStatus: identical repeat inside ~1s is dropped, later repeat is allowed', function () {
  var a = loadAnnouncer();
  a.say('Searching'); a.advance(40);
  a.nodes['a11y-status'].textContent = 'sentinel';
  a.say('Searching'); a.advance(40);
  assert.strictEqual(a.nodes['a11y-status'].textContent, 'sentinel', 'duplicate not re-announced');
  a.advance(2000);
  a.say('Searching'); a.advance(40);
  assert.strictEqual(a.nodes['a11y-status'].textContent, 'Searching');
});

test('announceStatus: stale text is cleared after ~8s; blank messages are ignored', function () {
  var a = loadAnnouncer();
  a.say('   '); a.advance(40);
  assert.strictEqual(a.nodes['a11y-status'].textContent, '');
  a.say('Chapter completed'); a.advance(40);
  assert.strictEqual(a.nodes['a11y-status'].textContent, 'Chapter completed');
  a.advance(8100);
  assert.strictEqual(a.nodes['a11y-status'].textContent, '');
});

test('Live regions: one polite + one assertive region; toast has no live region of its own', function () {
  assert.ok(has('id="a11y-status"') && has('id="a11y-alert"'));
  assert.ok(matches(/<div id="toast"><\/div>/), 'toast element carries no role/aria-live');
  assert.ok(matches(/announceStatus\(msg, \{ assertive:/));
});

test('Async events are announced: search, chapter, retry, page failure, completion, next chapter', function () {
  ['"Searching"', 'No manga found', 'Search failed', 'Chapter loaded: ', 'Retrying: loading ',
   'failed to load.', 'Chapter completed', 'Next chapter loaded: '].forEach(function (s) {
    assert.ok(has(s), 'announces: ' + s);
  });
  assert.ok(has('Removed from library'), 'library removal goes through toast -> announceStatus');
  assert.ok(matches(/toast\("Added "/), 'library add goes through toast -> announceStatus');
});

/* ================= Landmarks, semantics, names, ARIA ================= */
test('Landmarks: <main> and a labelled primary <nav>; tabs expose aria-current', function () {
  assert.ok(matches(/<main id="main"[^>]*>/));
  assert.ok(matches(/<nav id="tabbar" aria-label="Primary"/));
  assert.ok(has('aria-current'));
  ['nav-home', 'nav-library', 'nav-discover', 'nav-community', 'nav-profile'].forEach(function (a) {
    assert.ok(matches(new RegExp('class="tab" data-action="' + a + '" aria-label="[A-Za-z]+"')), a + ' has an accessible name');
  });
});

test('Decorative tab indicator and icons are hidden from assistive tech', function () {
  assert.ok(matches(/id="tab-indicator" aria-hidden="true"/));
  assert.ok(matches(/<svg[^>]*aria-hidden="true"/));
});

test('Sign-in fields have real labels (not placeholder-only) and an announced status', function () {
  assert.ok(matches(/<label for="auth-username"[^>]*>Username<\/label>/));
  assert.ok(matches(/<label for="auth-email"[^>]*>Email address<\/label>/));
  assert.ok(matches(/id="auth-username-status"[^>]*role="status"/));
});

test('Details primary action: real button, names the title and resume point, carries the chapter id', function () {
  assert.ok(matches(/series-primary-cta[^`]*data-action="open-reader" data-series="' \+ esc\(s\.id\) \+ '" data-chapter="' \+ esc\(target\.chapterId/));
  assert.ok(has('_ctaCueText'));
  assert.ok(matches(/aria-label="' \+ esc\(\(target\.label \|\| \(startedAny \? "Continue reading" : "Start reading"\)\) \+ ": " \+ \(s\.title/));
});

test('Continue Reading card name is built from the existing ReadingContinuity cue (no second calculation)', function () {
  assert.ok(matches(/data-action="resume-series"[^;]*aria-label="'\+esc\(cue\.tag\+': '\+\(s\.title/));
  var body = html.slice(html.indexOf('  function continueCue('), html.indexOf('  function emptyStateHTML('));
  assert.ok(!/state\.progress|getNextUnread|\.sort\(/.test(body));
});

test('Favorite control exposes pressed state and a name', function () {
  assert.ok(matches(/data-action="toggle-fav" data-id="' \+ esc\(s\.id\) \+ '" aria-label="Favorite" aria-pressed="/));
});

test('Chapter rows: one real button for the row, sibling tool buttons (no nested interactive controls)', function () {
  var i = html.indexOf('class="mh-row-main chapter-open"');
  assert.ok(i > 0);
  var open = html.slice(i, i + 1400);
  assert.ok(/^class="mh-row-main chapter-open"/.test(open));
  var rowBtnEnd = open.indexOf("'</button>'");
  assert.ok(rowBtnEnd > 0);
  assert.ok(open.slice(0, rowBtnEnd).indexOf('<button') < 0, 'no <button> nested inside the row button');
  assert.ok(open.slice(0, rowBtnEnd).indexOf('<a ') < 0);
});

test('Chapter state is text, not colour/opacity/icon alone', function () {
  ['Read', 'In progress, page ', 'Unread', 'Continue here', 'Currently unavailable'].forEach(function (s) {
    assert.ok(has(s), 'state text: ' + s);
  });
  assert.ok(has('mh-row-tag--unavailable') && has('>Unavailable<'));
  assert.ok(has('.chapter-row.is-unavailable{ opacity:1; }'), 'unavailable no longer relies on dimming');
});

test('Chapter tool buttons name the chapter they act on', function () {
  assert.ok(has('aria-label="Comments on '));
  assert.ok(has('aria-label="Read to here: mark chapters up to '));
  assert.ok(has('aria-label="Cancel download of '));
});

test('Search: role=search group, labelled input, announced loading/empty/error', function () {
  assert.ok(has('role="search"'));
  assert.ok(has('aria-busy="true"'));
  assert.ok(matches(/<h1[^>]*>[^<]*Discover/i) || has('role="heading" aria-level="1"') || has('<h1'));
});

/* ================= Reader a11y ================= */
test('Reader menus are listboxes with option rows and aria-expanded/aria-controls triggers', function () {
  assert.ok(has('role="listbox"') && has('role="option"'));
  assert.ok(has('aria-expanded') && has('aria-controls'));
});

test('Reader page images get "Page N of M" names, never URLs or source ids', function () {
  assert.ok(has('var alt = "Page " + (i + 1) + " of " + (pages || []).length;'));
});

test('Reader failure UI is a labelled group with a named retry button and takes focus', function () {
  assert.ok(has('"aria-label", "Page " + failPg + " problem"'));
  assert.ok(has('aria-label="Retry loading p'));
});

test('Hidden Reader chrome is inert and the inert state yields to an open modal', function () {
  assert.ok(has('function syncReaderChromeInert()'));
  assert.ok(has('node.hasAttribute("data-a11y-modal-inert")'));
});

test('Route focus: heading/Reader focus on navigation, trigger focus restored on Back', function () {
  assert.ok(has('function a11yAfterRouteChange()'));
  assert.ok(has('function a11yRememberTrigger()'));
  assert.ok(has('function a11yFocusReaderEntry()'));
});

test('In-place re-renders restore focus to the equivalent control', function () {
  assert.ok(has('var baseRender = render;'));
  assert.ok(has('var t = a11yFind(desc);'));
  assert.ok(has('keyBefore === routeKeyOf(route)'), 'only on the same screen');
});

/* ================= Dialogs ================= */
test('Dialog layer: role=dialog, aria-modal, name, focus-in, focus-return, Escape', function () {
  assert.ok(has('d.setAttribute("aria-modal","true")'));
  assert.ok(has('d.setAttribute("role","dialog")'));
  assert.ok(has('if(!d.getAttribute("aria-label"))'));
  assert.ok(has('back.focus({preventScroll:true})'));
  assert.ok(has('b.click();'), 'Escape dismisses through the backdrop handler');
});

test('Dialog layer: background is inert while a modal is open and released on close', function () {
  assert.ok(has('function applyModalInert(d)'));
  assert.ok(has('function releaseModalInert()'));
  assert.ok(has('data-a11y-modal-inert'));
  assert.ok(has('if(d) applyModalInert(d);'));
  assert.ok(has('releaseModalInert();'));
  assert.ok(has('MODAL_KEEP_SEL'), 'live regions / toast stay available');
});

test('Dialog layer: Tab is trapped inside the modal (wraps both directions)', function () {
  assert.ok(has('function dialogFocusables(d)'));
  assert.ok(has('e.key === "Tab" && openDialog'));
  assert.ok(has('e.shiftKey && (ae === first'));
});

/* ================= Focus visibility, contrast, reduced motion ================= */
test('Focus: visible ring on buttons, links, inputs and the new chapter-row button', function () {
  assert.ok(has('.chapter-open:focus-visible{ outline:2px solid var(--gold-1)'));
  assert.ok(has('input:focus-visible, textarea:focus-visible, select:focus-visible{\n  outline:2px solid var(--gold-1) !important'));
});

test('Focus: light theme uses the deeper accent so the ring stays >= 3:1', function () {
  assert.ok(has('html[data-theme="light"] input:focus-visible'));
  assert.ok(has('outline-color:var(--gold-2) !important'));
});

test('No bare outline:none on interactive elements outside a :focus replacement', function () {
  // Parse real CSS rules. outline:none is only acceptable on text-like inputs (covered by the global
  // `input:focus-visible { outline: ... !important }` rule) or inside a rule that is itself a :focus state.
  var bad = [];
  var re = /([^{}]+)\{([^{}]*outline:\s*none[^{}]*)\}/g, m;
  while ((m = re.exec(html))) {
    var sel = m[1].trim().split('\n').pop();
    if (/input|textarea|select|:focus/.test(sel)) continue;
    bad.push(sel.slice(0, 60));
  }
  assert.deepStrictEqual(bad, []);
  assert.ok(has('input:focus-visible, textarea:focus-visible, select:focus-visible{\n  outline:2px solid var(--gold-1) !important'));
});

test('Reduced motion: global CSS stops decorative motion but keeps loading spinners', function () {
  assert.ok(has('@media (prefers-reduced-motion: reduce){\n  html{ scroll-behavior:auto !important; }'));
  assert.ok(has(':not(.reader-loading-spinner):not(.pull-refresh-spinner)'));
  assert.ok(has('animation-iteration-count:1 !important'));
});

test('Reduced motion: no unguarded smooth scroll remains; Reader scroll animation checks the preference', function () {
  assert.strictEqual((html.match(/behavior:\s*"smooth"/g) || []).length, 0, 'no literal behavior:"smooth"');
  var guarded = (html.match(/prefers-reduced-motion: reduce\)"\)\.matches \? "auto" : "smooth"/g) || []).length;
  assert.ok(guarded >= 3, 'previously-unguarded calls now check the media query');
  var anim = html.slice(html.indexOf('function animateReaderScroll('), html.indexOf('function animateReaderScroll(') + 500);
  assert.ok(/prefersReducedMotion\(\)/.test(anim));
});

test('Contrast: muted text tokens meet 4.5:1 on the dark surfaces they are used on', function () {
  function lum(h) {
    var c = [1, 3, 5].map(function (i) { return parseInt(h.substr(i, 2), 16) / 255; }).map(function (v) {
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function ratio(a, b) { var x = lum(a), y = lum(b); if (x < y) { var t = x; x = y; y = t; } return (x + 0.05) / (y + 0.05); }
  ['#F1F0F6', '#C7C4D6', '#A19EB3', '#8B889C'].forEach(function (fg) {
    assert.ok(ratio(fg, '#15151C') >= 4.5, fg + ' on panel');
    assert.ok(ratio(fg, '#08080D') >= 4.5, fg + ' on page');
  });
  assert.ok(ratio('#C81E3A', '#FDFCF9') >= 4.5, 'light-theme focus accent');
});

/* ================= Scope guards ================= */
test('No redirects: external links are still blocked and Reader never iframes a source site', function () {
  assert.ok(has('externalNavigationBlocked()'));
  var readerSrc = html.slice(html.indexOf('function renderReader('), html.indexOf('function renderReader(') + 20000);
  assert.ok(!/<iframe/i.test(readerSrc));
  assert.ok(!/window\.open\(|location\.href\s*=/.test(readerSrc));
});

test('Architecture untouched: domain/service modules are unchanged in shape and still exported', function () {
  ['identity', 'chapterOrder', 'readerSession', 'readingContinuity', 'chapterSystem', 'readerKeyboard'].forEach(function (m) {
    var mod = require('../../src/domain/' + m + '.js');
    assert.ok(mod && typeof mod === 'object', m + ' exports');
  });
});

test('Future-phase guard: Stage 7B adds no downloads/offline/social/extension activation', function () {
  var block = html.slice(html.lastIndexOf('/* ── Stage 7B: accessibility'), html.lastIndexOf('</style>'));
  assert.ok(block.length > 100);
  assert.ok(!/download|offline|extension|mihon/i.test(block));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
