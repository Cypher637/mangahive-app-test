'use strict';
// STATIC wiring checks for Stage 2 (they inspect index.html text; behaviour is covered in discoverySearch.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.resolve(__dirname, '../../', f), 'utf8');
const html = read('index.html');
const fnBody = (name, len) => { const i = html.indexOf('function ' + name); assert.ok(i >= 0, name + ' exists'); return html.slice(i, i + (len || 1800)); };

test('Stage 2 modules load after libraryStore and before the main app script; SW precaches them', () => {
  const a = html.indexOf('src/services/libraryStore.js'), b = html.indexOf('src/domain/searchResult.js'), c = html.indexOf('src/services/discoverySearch.js');
  const main = html.indexOf('var STORAGE_KEY = "fairs-library-v1"');
  assert.ok(a > 0 && a < b && b < c && c < main);
  const sw = read('sw.js');
  assert.ok(sw.includes('./src/domain/searchResult.js') && sw.includes('./src/services/discoverySearch.js'));
});

test('no search/discovery entry point imports directly: every click path opens the preview', () => {
  for (const act of ['action === "source-result"', 'action === "discover-result"', 'action === "peek-discover"']) {
    const i = html.indexOf(act); assert.ok(i > 0, act);
    const seg = html.slice(i, i + 900);
    assert.ok(/openSearchPreview/.test(seg), act + ' opens preview');
    assert.ok(!/importHubResult\(/.test(seg), act + ' does not import');
  }
  // importHubResult is reachable from exactly one UI path: the explicit Add action's library deps.
  const callers = html.split('importHubResult(').length - 1;
  const defs = (html.match(/function importHubResult\(/g) || []).length;
  assert.equal(callers - defs, 1, 'exactly one call site (discoveryLibraryDeps.importResult)');
  assert.ok(/importResult: function\(r\)\{ return importHubResult\(toImportShape\(r\), \{ stay: true \}\)/.test(html));
});

test('discovery resolves sources through the registry glue; no parallel list or direct adapter fan-out in the UI', () => {
  assert.ok(/var discoveryRegistry = \{/.test(html) && /createDiscoverySearch\(\{\s*registry: discoveryRegistry/.test(html));
  const wrapper = fnBody('searchThirdPartySources', 500);
  assert.ok(/discovery\.search/.test(wrapper));
  const handlers = html.slice(html.indexOf('action === "discover-search"'), html.indexOf('action === "open-source-hub"'));
  assert.ok(!/mangaDexSearch|comickSearch|anilistSearch|jikanSearch|kitsuSearch/.test(handlers));
});

test('empty submit clears discovery without touching sources', () => {
  const seg = html.slice(html.indexOf('action === "discover-search"'), html.indexOf('action === "search-load-more"'));
  assert.ok(/discovery\.clear\(\)/.test(seg) && seg.indexOf('discovery.clear()') < seg.indexOf('runDiscoverySearch'));
});

test('no source redirects were introduced by Stage 2 code', () => {
  const stage2 = html.slice(html.indexOf('Phase 1 / Stage 2: Discovery & Search'), html.indexOf('// After primary import, discover other reader sources'))
    + html.slice(html.indexOf('function discoverySearchResultsHTML'), html.indexOf('function renderDiscover()'));
  assert.ok(stage2.length > 3000);
  assert.ok(!/window\.open|location\.href\s*=|location\.assign|target="_blank"|<a\s|href=/.test(stage2));
  assert.ok(!/Read on source|Open on /.test(stage2));
});

test('preview route exists, back-navigates to Discover, and shows explicit Add states', () => {
  assert.ok(/route\.name === "searchPreview"\) renderSearchPreview\(route\.params\.id\)/.test(html));
  assert.ok(/route\.name === "searchPreview"\)\{\s*navigate\("discover"/.test(html));
  const prev = fnBody('renderSearchPreview', 4200);
  for (const t of ['Add to Library', 'Added to Library', 'Already in Library']) assert.ok(prev.includes(t), t);
  assert.ok(!/saveState\(|importHubResult\(/.test(prev), 'rendering a preview never saves or imports');
});

test('search state is transient: subscriber and search path never call saveState / library store', () => {
  const glue = html.slice(html.indexOf('Phase 1 / Stage 2: Discovery & Search'), html.indexOf('// After primary import, discover other reader sources'));
  assert.ok(!/saveState\(|saveLibrary\(|persistCanonicalSeries\(/.test(glue.replace(/importResult: function[^\n]*\n/, '')));
  assert.ok(/libraryBindingIndex/.test(glue) && !/ensureCanonicalSeriesModel/.test(fnBody('libraryBindingIndex', 700)), 'library lookup is read-only');
});

test('MangaDex uses real offset pagination; other adapters are not given fake paging', () => {
  assert.ok(/offset=/.test(fnBody('mangaDexSearchPage', 900)));
  assert.ok(/paginates: src\.id === "mangadex"/.test(html));
});
