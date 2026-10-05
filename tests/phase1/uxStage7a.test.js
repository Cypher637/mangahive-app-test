'use strict';
/**
 * Stage 7A — UX, responsive design & visual polish.
 *
 * Two kinds of checks:
 *  - BEHAVIORAL: the real presentation functions are lifted out of index.html into a vm
 *    (with stubbed collaborators) and executed. No browser is involved.
 *  - STRUCTURAL: the shipped CSS / markup contains the responsive, safe-area, touch-target
 *    and recovery-path rules this stage promises, and the Stage 1-6 architecture is not bypassed.
 *
 * This file does NOT verify real rendering on a browser or device; that verification is deferred.
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var html = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  OK  ' + name); }
  catch (e) { failed++; console.error('  FAIL  ' + name); console.error('    ' + (e && e.stack ? e.stack : e)); }
}

/* ---------- helpers: pull real top-level functions out of index.html ---------- */
var lines = html.split('\n');
function extractFn(name) {
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('  function ' + name + '(') === 0) {
      var depth = 0, started = false, out = [];
      for (var j = i; j < lines.length; j++) {
        out.push(lines[j]);
        for (var k = 0; k < lines[j].length; k++) {
          var ch = lines[j][k];
          if (ch === '{') { depth++; started = true; } else if (ch === '}') depth--;
        }
        if (started && depth <= 0) break;
      }
      return out.join('\n');
    }
  }
  throw new Error('function not found in index.html: ' + name);
}
function extractVar(name) {
  var re = new RegExp('^  var ' + name + '\\s*=');
  for (var i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      var txt = [lines[i]], j = i;
      while (!/;\s*(\/\/.*)?$/.test(txt[txt.length - 1]) && j < lines.length - 1) { j++; txt.push(lines[j]); }
      return txt.join('\n');
    }
  }
  throw new Error('var not found in index.html: ' + name);
}
function loadUx(extraFns, stubs) {
  var src = [extractFn('esc'), extractVar('UX_STATE_ICONS'), extractFn('uxStateHTML'),
    extractFn('uxSkeletonGridHTML'), extractFn('uxSkeletonRowsHTML'), extractFn('continueCue')]
    .concat((extraFns || []).map(function (n) { return /^[A-Z_]+$/.test(n) ? extractVar(n) : extractFn(n); })).join('\n');
  var ctx = Object.assign({ console: console, Math: Math, Number: Number, String: String, Object: Object }, stubs || {});
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx;
}

/* ---------- uxStateHTML ---------- */
console.log('uxStage7a.test.js');
var ux = loadUx();

test('uxStateHTML: error/offline tones are alerts, empty/info are polite status', function () {
  assert.ok(ux.uxStateHTML({ tone: 'error', title: 'x' }).indexOf('role="alert"') >= 0);
  assert.ok(ux.uxStateHTML({ tone: 'offline', title: 'x' }).indexOf('role="alert"') >= 0);
  assert.ok(ux.uxStateHTML({ tone: 'empty', title: 'x' }).indexOf('role="status"') >= 0);
  assert.ok(ux.uxStateHTML({ tone: 'info', title: 'x' }).indexOf('role="status"') >= 0);
  assert.ok(ux.uxStateHTML({ title: 'x' }).indexOf('mh-state--empty') >= 0, 'unknown tone falls back to empty');
});

test('uxStateHTML: title, body and hint are escaped (no markup injection from titles/queries/errors)', function () {
  var out = ux.uxStateHTML({ tone: 'empty', title: '<img src=x onerror=1>', body: 'a "q" & <b>', hint: "it's <i>" });
  assert.ok(out.indexOf('<img') < 0 && out.indexOf('<b>') < 0 && out.indexOf('<i>') < 0);
  assert.ok(out.indexOf('&lt;img') >= 0 && out.indexOf('&amp;') >= 0 && out.indexOf('&quot;q&quot;') >= 0);
});

test('uxStateHTML: renders what / why / next and passes caller-built actions through', function () {
  var out = ux.uxStateHTML({ title: 'What', body: 'Why', hint: 'Next', actions: '<button data-action="search-retry">Try again</button>' });
  assert.ok(out.indexOf('mh-state-title') >= 0 && out.indexOf('mh-state-body') >= 0 && out.indexOf('mh-state-hint') >= 0);
  assert.ok(out.indexOf('<button data-action="search-retry">Try again</button>') >= 0);
  assert.ok(out.indexOf('undefined') < 0 && out.indexOf('null') < 0);
});

test('uxStateHTML: compact variant drops the icon; empty options never print "undefined"', function () {
  assert.ok(ux.uxStateHTML({ compact: true, title: 'x' }).indexOf('mh-state-icon') < 0);
  var bare = ux.uxStateHTML();
  assert.ok(bare.indexOf('undefined') < 0 && bare.indexOf('mh-state-actions') < 0);
});

test('skeleton helpers are aria-hidden placeholders and clamp their size', function () {
  var g = ux.uxSkeletonGridHTML(500);
  assert.ok(g.indexOf('aria-hidden="true"') >= 0);
  assert.strictEqual((g.match(/mh-skel-card/g) || []).length, 12, 'grid clamps to 12');
  assert.strictEqual((ux.uxSkeletonGridHTML(0).match(/mh-skel-card/g) || []).length, 6, 'falsy count falls back to the default of 6');
  assert.strictEqual((ux.uxSkeletonRowsHTML(99).match(/skeleton-row/g) || []).length, 8, 'rows clamp to 8');
});

/* ---------- continueCue: presentation of the authoritative ReadingContinuity result ---------- */
test('continueCue: partially-read chapter says Resume with page n of total', function () {
  var c = ux.continueCue('continue', { title: 'Chapter 12', pages: new Array(24) }, 4);
  assert.strictEqual(c.tag, 'Resume');
  assert.strictEqual(c.resuming, true);
  assert.strictEqual(c.page, 5);
  assert.strictEqual(c.text, 'Chapter 12 \u00b7 page 5 of 24');
});

test('continueCue: continue at page 0, next, and start are distinguishable and not "resuming"', function () {
  var ch = { title: 'Chapter 3' };
  var a = ux.continueCue('continue', ch, 0), n = ux.continueCue('next', ch, 0), s = ux.continueCue('start', ch, 0);
  assert.strictEqual(a.tag, 'Continue'); assert.strictEqual(a.resuming, false);
  assert.strictEqual(n.tag, 'Up next'); assert.strictEqual(n.resuming, false);
  assert.strictEqual(s.tag, 'Start');   assert.strictEqual(s.resuming, false);
  assert.strictEqual(n.text, 'Chapter 3');
});

test('continueCue: tolerates missing chapter, bad page index, and falls back to chapter number', function () {
  assert.strictEqual(ux.continueCue('continue', null, 7).text, 'page 8');
  assert.strictEqual(ux.continueCue('next', null, 'abc').text, '');
  assert.strictEqual(ux.continueCue('continue', { chapter: 9 }, 2).text, 'Ch. 9 \u00b7 page 3');
  assert.strictEqual(ux.continueCue('weird-kind', { title: 'T' }, 0).tag, 'Continue');
});

test('continueCue never selects a chapter: it only reads what ReadingContinuity resolved', function () {
  var body = extractFn('continueCue');
  assert.ok(!/resolveSeriesContinue|ReadingContinuity|getNextUnread|firstUnreadChapter|\.sort\(|state\.progress/.test(body));
});

/* ---------- Search UX states: execute the real discoverySearchResultsHTML ---------- */
function searchUi(stateObj, query) {
  var stubs = {
    sourceHubQuery: query == null ? 'solo' : query,
    discovery: { getState: function () { return stateObj; } },
    libraryBindingIndex: function () { return {}; },
    findLibrarySeriesForResult: function (r) { return r.__inLib ? { id: 'lib1' } : null; },
    coverHTML: function () { return '<img alt="">'; }
  };
  var c = loadUx(['SOURCE_STATE_LABEL', 'discoverPosterHTML', 'discoverySearchResultsHTML'], stubs);
  return c.discoverySearchResultsHTML(false);
}
var ok = function (name) { return { name: name, state: 'ok' }; };
var res = function (id, extra) { return Object.assign({ remoteId: id, sourceId: 'mangadex', title: 'Title ' + id, year: 2020 }, extra || {}); };

test('Search: idle with no query renders nothing', function () {
  assert.strictEqual(searchUi({ status: 'idle', sourceStatuses: [], results: [] }, ''), '');
});

test('Search loading: skeleton grid, polite status, no premature results or empty message', function () {
  var out = searchUi({ status: 'loading', sourceStatuses: [], results: [] });
  // Stage 7B: loading is aria-busy and announced once through announceStatus (no second live region here).
  assert.ok(out.indexOf('mh-skel-grid') >= 0 && out.indexOf('aria-busy="true"') >= 0 && out.indexOf('role="status"') < 0);
  assert.ok(out.indexOf('Searching') >= 0);
  assert.ok(out.indexOf('No manga found') < 0 && out.indexOf('data-action="discover-result"') < 0);
});

test('Search offline: explains, reassures Library still works, offers an obvious retry', function () {
  var out = searchUi({ status: 'offline', sourceStatuses: [], results: [] });
  // esc() renders the apostrophe as &#39;, which the browser displays as "You're offline".
  assert.ok(out.indexOf('You&#39;re offline') >= 0 && out.indexOf('Library') >= 0);
  assert.ok(out.indexOf('data-action="search-retry"') >= 0 && out.indexOf('btn-primary') >= 0);
});

test('Search all-sources error: names the failing sources, retry is primary, never shows raw errors', function () {
  var out = searchUi({ status: 'error', reason: 'all-failed', results: [], sourceStatuses: [{ name: 'MangaDex', state: 'timeout' }, { name: 'ComicK', state: 'error' }] });
  assert.ok(out.indexOf('MangaDex timed out') >= 0 && out.indexOf('ComicK returned an error') >= 0);
  assert.ok(out.indexOf('data-action="search-retry"') >= 0 && out.indexOf('data-action="open-source-hub"') >= 0);
  assert.ok(!/stack|TypeError|undefined|\[object/.test(out));
});

test('Search with no sources enabled: explains why and points to Manage sources (no pointless retry)', function () {
  var out = searchUi({ status: 'error', reason: 'no-sources', results: [], sourceStatuses: [] });
  assert.ok(out.indexOf('data-action="open-source-hub"') >= 0);
  assert.ok(out.indexOf('data-action="search-retry"') < 0);
});

test('Search no-results: names the query (escaped) and gives next steps', function () {
  var out = searchUi({ status: 'empty', query: '<b>zzz</b>', results: [], sourceStatuses: [ok('MangaDex')] });
  assert.ok(out.indexOf('No manga found') >= 0 && out.indexOf('&lt;b&gt;zzz') >= 0 && out.indexOf('<b>zzz') < 0);
  assert.ok(out.indexOf('mh-state-hint') >= 0 && out.indexOf('data-action="open-source-hub"') >= 0);
});

test('Search results: library titles are marked, others are not, and nothing is auto-added', function () {
  var out = searchUi({ status: 'ready', query: 'q', hasMore: false, results: [res('1', { __inLib: true }), res('2')], sourceStatuses: [ok('MangaDex')] });
  assert.strictEqual((out.match(/is-in-library/g) || []).length, 1);
  assert.strictEqual((out.match(/In Library/g) || []).length, 1);
  assert.ok(out.indexOf('data-action="preview-add"') < 0 && out.indexOf('add-to-library') < 0, 'results never expose a one-tap add');
  assert.strictEqual((out.match(/data-action="discover-result"/g) || []).length, 2, 'every result opens the preview first');
});

test('Search partial failure: warns, keeps results visible, offers retry', function () {
  var out = searchUi({ status: 'ready', query: 'q', hasMore: false, results: [res('1')], sourceStatuses: [ok('MangaDex'), { name: 'ComicK', state: 'timeout' }] });
  assert.ok(out.indexOf('mh-partial') >= 0 && out.indexOf('ComicK timed out') >= 0);
  assert.ok(out.indexOf('Showing results from the other sources') >= 0 && out.indexOf('data-action="discover-result"') >= 0);
  assert.ok(out.indexOf('data-action="search-retry"') >= 0);
});

test('Search pagination: load-more, loading-more, load-more error and end-of-results are each distinct', function () {
  var base = { status: 'ready', query: 'q', results: [res('1')], sourceStatuses: [ok('MangaDex')] };
  var more = searchUi(Object.assign({}, base, { hasMore: true }));
  assert.ok(more.indexOf('data-action="search-load-more"') >= 0);
  var loading = searchUi(Object.assign({}, base, { hasMore: true, loadingMore: true }));
  assert.ok(loading.indexOf('Loading more') >= 0 && loading.indexOf('search-load-more') < 0);
  var err = searchUi(Object.assign({}, base, { hasMore: true, loadMoreError: true }));
  assert.ok(err.indexOf("Couldn't load more") >= 0 && err.indexOf('data-action="search-retry"') >= 0);
  var end = searchUi(Object.assign({}, base, { hasMore: false }));
  assert.ok(end.indexOf('reached the end') >= 0 && end.indexOf('search-load-more') < 0);
  var capped = searchUi(Object.assign({}, base, { hasMore: false, capped: true }));
  assert.ok(capped.indexOf('refine your search') >= 0);
});

/* ---------- Structural: responsive CSS, safe areas, touch targets ---------- */
var cssStart = html.indexOf('<style id="mangahive-stage7a">');
var css = cssStart >= 0 ? html.slice(cssStart, html.indexOf('</style>', cssStart)) : '';

test('Stage 7A stylesheet exists, loads after the earlier polish layers, and has balanced braces', function () {
  assert.ok(css.length > 1000);
  assert.ok(cssStart > html.indexOf('<style id="mangahive-polish">'));
  var d = 0; for (var i = 0; i < css.length; i++) { if (css[i] === '{') d++; else if (css[i] === '}') d--; assert.ok(d >= 0); }
  assert.strictEqual(d, 0);
});

test('safe areas: top, bottom, left and right insets are all handled', function () {
  ['top', 'right', 'bottom', 'left'].forEach(function (side) {
    assert.ok(css.indexOf('env(safe-area-inset-' + side) >= 0, 'missing safe-area-inset-' + side);
  });
  assert.ok(/#tabbar\{[^}]*max\(14px, var\(--mh-safe-left\)\)/.test(css), 'floating tab bar respects side insets');
  assert.ok(/\.reader-bottombar\{[^}]*safe-bottom/.test(css), 'Reader bottom bar clears the home indicator');
  assert.ok(/\.action-sheet\{[^}]*safe-bottom/.test(css), 'sheets clear the home indicator');
});

test('touch targets: Reader nav, bottom tools and top buttons are 44px', function () {
  assert.ok(/\.reader-top-nav button\{\s*width:44px;\s*height:44px;/.test(css));
  assert.ok(/\.reader-bottom-tool\{\s*width:44px;\s*height:44px;/.test(css));
  assert.ok(/\.reader-top \.icon-btn\{\s*width:44px;\s*height:44px;/.test(css));
  assert.ok(/\.library-search-clear\{[^}]*min-width:44px;\s*min-height:44px/.test(css));
  assert.ok(/\.collection-tab\{[^}]*min-height:44px/.test(css));
});

test('responsive: grids fill available width; frame widens on tablet and desktop; narrow phones get a 2-col floor', function () {
  assert.ok(/\.grid\{[^}]*auto-fill/.test(css) && /\.poster-grid\{[^}]*auto-fill/.test(css) && /\.result-grid\{[^}]*auto-fill/.test(css));
  assert.ok(/@media \(min-width:700px\)\{\s*#frame\{ max-width:680px; \}/.test(css));
  assert.ok(/@media \(min-width:1024px\)\{\s*#frame\{ max-width:880px; \}/.test(css));
  assert.ok(/@media \(max-width:359px\)/.test(css));
});

test('dialogs, sheets and dropdowns are height-capped and scrollable so they cannot exceed the viewport', function () {
  assert.ok(/\[role="dialog"\], \.action-sheet, \.peek-sheet, \.reader-sheet\{[^}]*max-height:min\(86vh[^}]*100dvh[^}]*overflow-y:auto/.test(css));
  assert.ok(/\.reader-dropdown\{[^}]*max-height[^}]*overflow-y:auto/.test(css));
});

test('visual states are defined: disabled, busy, pressed, hover (pointer devices only), current, unavailable, in-library', function () {
  assert.ok(/button:disabled/.test(css) && /aria-busy="true"/.test(css));
  assert.ok(/@media \(hover:hover\) and \(pointer:fine\)/.test(css));
  assert.ok(/\.chapter-row\.is-current/.test(css) && /\.chapter-row\.is-unavailable/.test(css));
  assert.ok(/\.poster-card\.is-in-library/.test(css));
  assert.ok(/prefers-reduced-motion:reduce/.test(css));
});

test('no new colour palette: Stage 7A CSS defines no new colour custom properties', function () {
  var decl = css.match(/--[a-z0-9-]+\s*:\s*[^;]+;/gi) || [];
  decl.forEach(function (d) { assert.ok(!/#[0-9a-f]{3,8}|rgba?\(|hsl/i.test(d), 'new colour token: ' + d); });
});

test('previously unstyled structures now have layout rules (.poster-art continue-card art, discover search field)', function () {
  assert.ok(/\.poster-art\{[^}]*width:148px;[^}]*height:210px/.test(css));
  assert.ok(/input\[type="search"\]/.test(css));
});

/* ---------- Structural: Continue Reading, Details, chapter list ---------- */
test('Home Continue Reading uses the authoritative list and keeps the resume-series action unchanged', function () {
  var home = extractFn('renderHome');
  assert.ok(home.indexOf('continueReadingItems()') >= 0);
  assert.ok(home.indexOf('continueCue(item.kind, ch, item.pageIndex)') >= 0);
  assert.ok(home.indexOf('data-action="resume-series"') >= 0);
  assert.ok(home.indexOf('.sort(') < 0, 'Home does not re-rank continuity');
  var items = extractFn('continueReadingItems');
  assert.ok(items.indexOf('resolveSeriesContinue') >= 0, 'items still come from ReadingContinuity via resolveSeriesContinue');
});

test('Details: CTA note describes the chapter the CTA will open, from the same continuity source', function () {
  var det = extractFn('renderSeriesDetail');
  assert.ok(det.indexOf('series-continue-note') >= 0);
  assert.ok(det.indexOf('resolveSeriesContinue(s)') >= 0);
  assert.ok(det.indexOf('_cont.chapterId === _tid') >= 0, 'only trusts continuity when it targets the CTA chapter');
  var ctaIdx = det.indexOf('series-primary-cta');
  assert.ok(det.indexOf('data-chapter="\' + esc(target.chapterId || "")') > 0 && ctaIdx > det.indexOf('series-continue-note') - 4000);
});

test('Chapter list: ordering still comes from ChapterSystem; no second sort or chapter model was added', function () {
  var det = extractFn('renderSeriesDetail');
  var a = det.indexOf('var chapterView = ');
  var b = det.indexOf('chapters-panel glass-panel');
  assert.ok(a > 0 && b > a);
  var seg = det.slice(a, b);
  assert.ok(seg.indexOf('getDetailsChapterView') >= 0);
  assert.ok(seg.indexOf('.sort(') < 0 && seg.indexOf('.reverse(') < 0);
});

test('Chapter rows express current, unavailable and read states and keep canonical ids in data attributes', function () {
  var det = extractFn('renderSeriesDetail');
  assert.ok(det.indexOf("' is-current'") >= 0 && det.indexOf("' is-unavailable'") >= 0 && det.indexOf("' is-read'") >= 0);
  assert.ok(det.indexOf('aria-current="true"') >= 0);
  assert.ok(det.indexOf('data-action="open-reader" data-series="\' + esc(s.id) + \'" data-chapter="\' + esc(c.id)') >= 0);
  assert.ok(det.indexOf('mh-row-tag--unavailable') >= 0 && det.indexOf('mh-row-tag--current') >= 0);
});

test('Details loading/error/partial/empty states: skeleton, explained error with retry, partial warning, why-empty copy', function () {
  var det = extractFn('renderSeriesDetail');
  assert.ok(det.indexOf('uxSkeletonRowsHTML(4)') >= 0);
  assert.ok(det.indexOf("title: \"Couldn't load chapters\"") >= 0 && det.indexOf('data-action="refresh-details-chapters"') >= 0);
  assert.ok(det.indexOf('may be incomplete') >= 0);
  assert.ok(det.indexOf('No chapters yet') >= 0 && det.indexOf('All chapters are read') >= 0);
  assert.ok(det.indexOf('No chapters available</div>') < 0, 'old bare empty message is gone');
});

/* ---------- Structural: Library ---------- */
test('Library: empty Library explains what/why/next and never claims anything is added automatically', function () {
  var e = extractFn('emptyStateHTML');
  assert.ok(e.indexOf('Your Library is empty') >= 0 && e.indexOf('Nothing is added automatically') >= 0);
  assert.ok(e.indexOf('data-action="nav-discover"') >= 0);
  assert.ok(e.indexOf('Your shelf is empty') < 0);
});

test('Library: generic "Nothing here" is replaced by filter/search-specific recovery', function () {
  var lib = extractFn('renderLibrary');
  assert.ok(lib.indexOf('<h3>Nothing here</h3>') < 0);
  assert.ok(lib.indexOf('library-clear-search') >= 0 && lib.indexOf('data-tab="all"') >= 0);
  assert.ok(lib.indexOf('manhwa in your collection') < 0, 'copy no longer assumes every title is manhwa');
});

test('Library: "Clear search" action is handled and resets only the query', function () {
  var m = /else if\(action === "library-clear-search"\)\{([^}]*)\}/.exec(html);
  assert.ok(m, 'handler present');
  assert.ok(m[1].indexOf('libraryQuery=""') >= 0 && m[1].indexOf('saveState') < 0 && m[1].indexOf('progress') < 0);
});

/* ---------- Structural: Reader ---------- */
test('Reader error screens never dead-end: each has a back path', function () {
  var r = extractFn('renderReader');
  var err = r.slice(r.indexOf('Couldn’t load this chapter') - 900, r.indexOf('Couldn’t load this chapter') + 900);
  assert.ok(err.indexOf('data-action="reader-back"') >= 0, 'load-failure screen has Back');
  assert.ok(err.indexOf('id="reader-retry-remote"') >= 0 && err.indexOf('role="alert"') >= 0);
  var np = r.slice(r.indexOf('No pages for this chapter') - 900, r.indexOf('No pages for this chapter') + 700);
  assert.ok(np.indexOf('data-action="reader-back"') >= 0 && np.indexOf('reader-top') >= 0);
});

test('Reader loading screen names the chapter and keeps its Back button', function () {
  var r = extractFn('renderReader');
  assert.ok(r.indexOf("'<strong>Loading ' + esc(c.title) + '</strong>'") >= 0);
  assert.ok(r.indexOf('reader-loading-spinner" aria-hidden="true"') >= 0);
});

test('Reader chapter end: one primary action, secondary row, all existing share/comment actions preserved', function () {
  var r = extractFn('renderReader');
  var a = r.indexOf('reader-end-primary'), b = r.indexOf('reader-end-more');
  assert.ok(a > 0 && b > a);
  var end = r.slice(r.indexOf('<div class="reader-end">'), r.indexOf('reader-bottombar'));
  ['next-chapter', 'reader-back', 'toggle-reader-comments', 'open-chapter-end-sheet', 'quick-share-finished', 'share-series', 'share-page']
    .forEach(function (act) { assert.ok(end.indexOf('data-action="' + act + '"') >= 0, 'missing ' + act); });
  assert.strictEqual((end.match(/btn btn-primary/g) || []).length, 2, 'primary styling only on the mutually exclusive Next / Back-to-series button');
});

test('Reader prev/next, chapter pill and bottom controls still derive from ChapterOrder and keep their actions', function () {
  var r = extractFn('renderReader');
  assert.ok(r.indexOf('window.MangaHiveDomain.chapterOrder.getPreviousChapter') >= 0);
  ['prev-chapter', 'next-chapter', 'toggle-chapter-dropdown', 'toggle-page-dropdown', 'toggle-bookmark', 'toggle-reader-settings'].forEach(function (act) {
    assert.ok(r.indexOf('data-action="' + act + '"') >= 0, 'missing ' + act);
  });
});

test('Reader sentinel error explains that progress is safe and offers retry', function () {
  var f = extractFn('showSentinelError');
  assert.ok(f.indexOf('Your place in this chapter is saved') >= 0 && f.indexOf('data-action="retry-chapter-append"') >= 0);
});

/* ---------- Architecture guards ---------- */
test('Stage 7A presentation code does not touch ProgressStore / ReaderSession / LibraryStore writes', function () {
  ['uxStateHTML', 'uxSkeletonGridHTML', 'uxSkeletonRowsHTML', 'continueCue', 'discoverySearchResultsHTML'].forEach(function (n) {
    var body = extractFn(n);
    assert.ok(!/saveState|ProgressStore|ReaderSession|LibraryStore|state\.progress\s*\[[^\]]*\]\s*=|markChapterRead|navigate\(/.test(body), n + ' must stay presentation-only');
  });
});

test('no redirects: presentation helpers and Stage 7A CSS add no external navigation, iframes or source links', function () {
  ['uxStateHTML', 'continueCue', 'discoverySearchResultsHTML', 'discoverPosterHTML'].forEach(function (n) {
    var body = extractFn(n);
    assert.ok(!/window\.open|location\.(href|assign|replace)|<iframe|target="_blank"|<a\s+href/i.test(body), n + ' has an external navigation primitive');
  });
  assert.ok(!/url\(\s*['"]?https?:/i.test(css), 'no remote assets in Stage 7A CSS');
  var reader = extractFn('renderReader');
  assert.ok(!/<iframe|window\.open|target="_blank"/i.test(reader));
});

test('every data-action introduced by Stage 7A has a handler in the global click router (navigation stays predictable)', function () {
  var used = ['search-retry', 'search-load-more', 'open-source-hub', 'nav-discover', 'library-clear-search', 'collection-tab',
    'refresh-details-chapters', 'toggle-hide-read', 'show-more-chapters', 'resume-series', 'reader-back',
    'toggle-reader-comments', 'open-chapter-end-sheet', 'quick-share-finished', 'share-series', 'share-page', 'retry-discover',
    'retry-chapter-append', 'open-reader', 'preview-add', 'open-series'];
  used.forEach(function (a) {
    assert.ok(html.indexOf('action === "' + a + '"') >= 0 || html.indexOf("action === '" + a + "'") >= 0, 'no handler for data-action=' + a);
  });
  // Chapter switching is bound directly (querySelectorAll over the Reader container), not through the router.
  ['next-chapter', 'prev-chapter'].forEach(function (a) {
    assert.ok(html.indexOf("querySelectorAll('[data-action=\"" + a + "\"]:not([data-bound])')") >= 0, 'no binder for data-action=' + a);
  });
});

test('duplicate Add feedback: "already in library" is acknowledged without changing the service contract', function () {
  assert.ok(/out\.status === "already"\)\{ delete previewAddState\[pid\]; toast\("Already in your Library"\); \}/.test(html));
  var svc = fs.readFileSync(path.join(__dirname, '../../src/services/discoverySearch.js'), 'utf8');
  assert.ok(svc.indexOf("status: 'already'") >= 0, 'service still reports already');
});

test('import failure copy no longer exposes raw error messages to users', function () {
  assert.ok(html.indexOf('"Couldn\'t import this source (" +') < 0);
  assert.ok(html.indexOf("Couldn't add this title right now. Please try again.") >= 0);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
