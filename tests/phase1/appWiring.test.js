'use strict';
// Structural wiring checks for the shell (script order, service worker, android docs).
// Behavior of the modules themselves is covered by the other phase1 suites; this guards the integration seams.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const MODULES = ['src/domain/identity.js', 'src/domain/chapterOrder.js', 'src/domain/progress.js', 'src/domain/readerSession.js', 'src/services/libraryStore.js', 'src/services/progressStore.js'];

test('index.html loads every Stage 1 module, in dependency order, before the main app script', () => {
  const html = read('index.html');
  let last = -1;
  for (const m of MODULES) {
    const i = html.indexOf('<script src="' + m + '"></script>');
    assert.ok(i > last, m + ' present and after the previous module');
    last = i;
  }
  assert.ok(html.indexOf('var STORAGE_KEY = "fairs-library-v1"') > last, 'main app script comes after the modules');
});

test('the modules load as classic scripts in a bare global (no module system) and expose their APIs', () => {
  const vm = require('vm');
  const ctx = { console, Promise, setTimeout, clearTimeout, Date, Math, JSON, Object, Array, String, Number, isFinite, parseFloat, parseInt, encodeURIComponent, Error, TypeError, Infinity, NaN };
  ctx.globalThis = ctx; vm.createContext(ctx);
  for (const m of MODULES) vm.runInContext(read(m), ctx, { filename: m });
  assert.equal(typeof ctx.MangaHiveDomain.identity.getCanonicalChapterIdentity, 'function');
  assert.equal(typeof ctx.MangaHiveDomain.chapterOrder.sortChapters, 'function');
  assert.equal(typeof ctx.MangaHiveDomain.progress.createProgressRecord, 'function');
  assert.equal(typeof ctx.MangaHiveDomain.readerSession.createReaderSession, 'function');
  assert.equal(typeof ctx.MangaHiveServices.libraryStore.createLibraryStore, 'function');
  assert.equal(typeof ctx.MangaHiveServices.progressStore.createProgressStore, 'function');
});

test('domain modules contain no DOM / IndexedDB / Supabase / fetch / storage access', () => {
  for (const m of MODULES.filter((x) => x.startsWith('src/domain/'))) {
    const code = read(m).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const bad of [/\bdocument\b/, /\bwindow\b/, /indexedDB/, /localStorage/, /sessionStorage/, /\bfetch\s*\(/, /XMLHttpRequest/, /\bsb\b/, /supabase/i, /\.from\s*\(/, /\.rpc\s*\(/, /window\.storage/]) {
      assert.ok(!bad.test(code), m + ' must not reference ' + bad);
    }
  }
});

test('services reach persistence only through an injected storage, never directly or via the network', () => {
  for (const m of MODULES.filter((x) => x.startsWith('src/services/'))) {
    const code = read(m).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const bad of [/\bdocument\b/, /indexedDB/, /localStorage/, /\bfetch\s*\(/, /XMLHttpRequest/, /supabase/i, /\.from\s*\(/, /\.rpc\s*\(/, /window\.storage/]) {
      assert.ok(!bad.test(code), m + ' must not reference ' + bad);
    }
  }
});

test('service worker precaches every module, bumps the shell version, and adds no data caching', () => {
  const sw = read('sw.js');
  for (const m of MODULES) assert.ok(sw.includes('"./' + m + '"'), m + ' in SHELL_FILES');
  assert.match(sw, /fairs-library-shell-v(\d+)/);
  assert.ok(Number(/fairs-library-shell-v(\d+)/.exec(sw)[1]) >= 72, 'shell cache version bumped from v71');
  assert.ok(/var STATIC_EXT_RE = \/\\\.\(js\|css\|woff2\?\|ttf\)\$\/i;/.test(sw), 'static extension policy unchanged (no json/images)');
  const entries = [...sw.split('var SHELL_FILES')[1].split(']')[0].replace(/\/\/.*$/gm, '').matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  for (const e of entries) assert.ok(!/^https?:|\/api\/|\.json$|\.(jpe?g|webp|gif)$/i.test(e) || e === './manifest.json', 'SHELL_FILES entry is app code/shell only: ' + e);
});

test('progress turn path in index.html no longer serialises the library', () => {
  const html = read('index.html');
  const fn = html.slice(html.indexOf('function flushProgress(immediate)'), html.indexOf('function prefetchReaderPages'));
  assert.ok(fn.includes('progStore.updateChapterProgress'), 'uses the progress store');
  assert.ok(/if\(immediate\) saveState\(\);/.test(fn), 'library is saved only on reader exit / chapter switch');
  const debounced = fn.split('if(progStore){')[1].split('if(immediate)')[0];
  assert.ok(!/saveState\(/.test(debounced) && !/JSON\.stringify/.test(debounced), 'debounced page-turn path has no library save');
  assert.ok(html.includes('progressSaveTimer = setTimeout(function(){ flushProgress(false); }, 500);'), 'page turns call flushProgress(false)');
});

test('loadState no longer converts an unparseable library into an empty one that then gets saved', () => {
  const html = read('index.html');
  assert.ok(html.includes('libStore.loadLibrary()'), 'load goes through the library store');
  assert.ok(html.includes('if(!libraryLoaded) return Promise.resolve(null);'), 'no saves before a real load');
  assert.ok(html.includes('libStore.saveLibrary(state)'), 'saves go through the library store');
});

test('Android docs tell the user to copy src/ and config/', () => {
  assert.ok(/src\/.*folder|`src\/`/.test(read('README.md')));
  assert.ok(/src\/ and config\//.test(read('HOW_TO_GET_AN_APK.md')));
});
