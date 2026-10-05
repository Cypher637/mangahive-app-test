'use strict';
/**
 * Phase 1 / Stage 3 — Manga Details domain behavioral tests.
 */
var assert = require('assert');
var path = require('path');
var identity = require(path.join(__dirname, '../../src/domain/identity.js'));
var chapterOrder = require(path.join(__dirname, '../../src/domain/chapterOrder.js'));
var details = require(path.join(__dirname, '../../src/domain/mangaDetails.js'));

function seriesFixture(overrides) {
  var base = {
    id: 'local-series-1',
    title: 'Test Manga',
    description: '<p>Hello <b>world</b></p><script>alert(1)</script>',
    cover: 'https://example.com/cover.jpg',
    author: 'Alice, Bob',
    artist: 'Carol',
    status: 'Ongoing',
    year: 2020,
    genres: ['Action', 'action', 'Fantasy', ''],
    tags: [{ name: 'Magic' }, 'Magic', '  '],
    source: { type: 'mangadex', remoteId: 'md-1' },
    sourceMappings: [{ sourceId: 'mangadex', remoteId: 'md-1', matchConfidence: 1 }],
    chapters: [
      { id: 'c1', chapter: '1', title: 'Start', remoteId: 'r1', sources: [{ sourceId: 'mangadex', remoteId: 'r1' }] },
      { id: 'c2', chapter: '2.5', title: 'Special', remoteId: 'r2', sources: [{ sourceId: 'mangadex', remoteId: 'r2' }] },
      { id: 'c3', chapter: '10', title: 'Ten', remoteId: 'r3', sources: [{ sourceId: 'mangadex', remoteId: 'r3' }] },
      { id: 'c4', chapter: '2', title: 'Two', remoteId: 'r4', sources: [{ sourceId: 'mangadex', remoteId: 'r4' }] }
    ],
    updatedAt: 1000
  };
  if (overrides) {
    Object.keys(overrides).forEach(function (k) { base[k] = overrides[k]; });
  }
  return base;
}

var passed = 0;
var failed = 0;
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

console.log('mangaDetails.test.js');

// ---- Identity ----
test('Details resolves canonical series identity', function () {
  var s = seriesFixture();
  var vm = details.buildDetailsViewModel(s);
  assert.strictEqual(vm.ok, true);
  assert.strictEqual(vm.localId, 'local-series-1');
  assert.ok(vm.canonicalSeriesId == null || typeof vm.canonicalSeriesId === 'string');
});

test('Invalid identity fails safely', function () {
  var vm = details.buildDetailsViewModel(null);
  assert.strictEqual(vm.ok, false);
  assert.strictEqual(vm.error, 'not_found');
  assert.strictEqual(vm.localId, null);
});

test('Same series resolves consistently', function () {
  var s = seriesFixture();
  var a = details.buildDetailsViewModel(s);
  var b = details.buildDetailsViewModel(s);
  assert.strictEqual(a.localId, b.localId);
  assert.strictEqual(a.canonicalSeriesId, b.canonicalSeriesId);
  assert.strictEqual(a.title, b.title);
});

// ---- Metadata ----
test('metadata normalization strips HTML and scripts from description', function () {
  var meta = details.normalizeMetadata(seriesFixture());
  assert.ok(meta.description.indexOf('<') === -1);
  assert.ok(meta.description.indexOf('script') === -1);
  assert.ok(meta.description.indexOf('Hello') !== -1);
  assert.ok(meta.description.indexOf('world') !== -1);
});

test('missing metadata uses safe empty values', function () {
  var meta = details.normalizeMetadata({ id: 'x', title: '' });
  assert.strictEqual(meta.title, 'Untitled');
  assert.strictEqual(meta.description, '');
  assert.deepStrictEqual(meta.authors, []);
  assert.strictEqual(meta.status, 'unknown');
  assert.strictEqual(meta.year, null);
  assert.strictEqual(meta.cover, null);
});

test('duplicate contributors are removed', function () {
  var people = details.normalizePeople(['Alice', 'alice', 'Bob', ' Alice ']);
  assert.deepStrictEqual(people, ['Alice', 'Bob']);
});

test('tags dedupe and drop empties', function () {
  var tags = details.normalizeTags(['Action', 'action', '', 'Fantasy', { name: 'Drama' }]);
  assert.deepStrictEqual(tags, ['Action', 'Fantasy', 'Drama']);
});

test('status normalization maps common vocabularies', function () {
  assert.strictEqual(details.normalizeStatus('Ongoing').status, 'ongoing');
  assert.strictEqual(details.normalizeStatus('finished').status, 'completed');
  assert.strictEqual(details.normalizeStatus('on_hiatus').status, 'hiatus');
  assert.strictEqual(details.normalizeStatus('Canceled').status, 'cancelled');
  assert.strictEqual(details.normalizeStatus('???').status, 'unknown');
  assert.strictEqual(details.normalizeStatus('completed').label, 'Completed');
});

test('year normalization', function () {
  assert.strictEqual(details.normalizeYear(2019), 2019);
  assert.strictEqual(details.normalizeYear('Published 2018'), 2018);
  assert.strictEqual(details.normalizeYear('nope'), null);
  assert.strictEqual(details.normalizeYear(999), null);
});

test('cover rejects dangerous schemes', function () {
  assert.strictEqual(details.normalizeCover('javascript:alert(1)'), null);
  assert.strictEqual(details.normalizeCover('https://cdn.example/c.jpg'), 'https://cdn.example/c.jpg');
});

test('descriptionPreview truncates long text', function () {
  var long = new Array(50).join('word ') + 'end';
  var p = details.descriptionPreview(long, 40);
  assert.strictEqual(p.truncated, true);
  assert.ok(p.text.length <= 45);
});

test('displayFallback never returns undefined/null for known fields', function () {
  assert.strictEqual(details.displayFallback('description', ''), 'No description available');
  assert.strictEqual(details.displayFallback('authors', []), 'Unknown');
  assert.strictEqual(details.displayFallback('year', null), 'Not available');
});

// ---- Library state ----
test('library state for series in library', function () {
  var vm = details.buildDetailsViewModel(seriesFixture());
  assert.strictEqual(vm.libraryState.inLibrary, true);
  assert.strictEqual(vm.libraryState.canRemove, true);
  assert.strictEqual(vm.libraryState.canAdd, false);
});

test('library state when adding', function () {
  var vm = details.buildDetailsViewModel(seriesFixture(), { adding: true });
  assert.strictEqual(vm.libraryState.state, 'adding');
  assert.strictEqual(vm.libraryState.canAdd, false);
});

// ---- Chapters ----
test('deterministic chapter ordering (1, 2, 2.5, 10)', function () {
  var s = seriesFixture();
  var rows = details.buildChapterRows(s, null);
  var numbers = rows.map(function (r) { return r.number; });
  assert.deepStrictEqual(numbers, ['1', '2', '2.5', '10']);
});

test('canonical chapter identity on rows', function () {
  var s = seriesFixture();
  var rows = details.buildChapterRows(s, null);
  rows.forEach(function (r) {
    assert.ok(r.id);
    // canonical may be derived
    assert.ok(r.canonicalChapterId == null || typeof r.canonicalChapterId === 'string');
  });
});

test('duplicate chapters by canonical identity are collapsed', function () {
  var s = seriesFixture({
    chapters: [
      { id: 'a', chapter: '1', title: 'One', canonicalChapterId: 'mhch:same', sources: [{ sourceId: 'mangadex', remoteId: 'x' }] },
      { id: 'b', chapter: '1', title: 'One copy', canonicalChapterId: 'mhch:same', sources: [{ sourceId: 'comick', remoteId: 'y' }] },
      { id: 'c', chapter: '2', title: 'Two', sources: [{ sourceId: 'mangadex', remoteId: 'z' }] }
    ]
  });
  var rows = details.buildChapterRows(s, null);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].id, 'a');
});

test('read/unread/completed display states', function () {
  var s = seriesFixture();
  var progress = {
    c1: { page: 0, completed: true, updatedAt: 1 },
    c4: { page: 3, total: 10, updatedAt: 2 }
  };
  var rows = details.buildChapterRows(s, progress);
  var byId = {};
  rows.forEach(function (r) { byId[r.id] = r; });
  assert.strictEqual(byId.c1.readState, 'completed');
  assert.strictEqual(byId.c4.readState, 'started');
  assert.strictEqual(byId.c2.readState, 'unread');
});

// ---- Progress / Continue ----
test('Continue Reading picks started chapter', function () {
  var s = seriesFixture();
  var progress = {
    c4: { page: 2, total: 10, updatedAt: 50 },
    c1: { page: 1, total: 10, completed: true, updatedAt: 10 }
  };
  var vm = details.buildDetailsViewModel(s, { seriesProgress: progress });
  assert.strictEqual(vm.readingState.continue.kind, 'continue');
  assert.strictEqual(vm.readingState.continue.chapterId, 'c4');
  assert.ok(vm.readingState.continue.label.indexOf('2') !== -1);
});

test('Start Reading when no progress', function () {
  var s = seriesFixture();
  var vm = details.buildDetailsViewModel(s, { seriesProgress: {} });
  assert.strictEqual(vm.readingState.continue.kind, 'start');
  assert.strictEqual(vm.readingState.continue.chapterId, 'c1');
});

test('All chapters completed finished state', function () {
  var s = seriesFixture({
    chapters: [
      { id: 'a', chapter: '1' },
      { id: 'b', chapter: '2' }
    ]
  });
  var progress = {
    a: { completed: true, page: 5 },
    b: { completed: true, page: 5 }
  };
  var vm = details.buildDetailsViewModel(s, { seriesProgress: progress });
  assert.strictEqual(vm.readingState.continue.kind, 'finished');
  assert.strictEqual(vm.readingState.continue.chapterId, null);
});

test('completed chapter is not resume target when unread remain', function () {
  var s = seriesFixture({
    chapters: [
      { id: 'a', chapter: '1' },
      { id: 'b', chapter: '2' }
    ]
  });
  var progress = { a: { completed: true, page: 10, updatedAt: 99 } };
  var vm = details.buildDetailsViewModel(s, { seriesProgress: progress });
  assert.ok(vm.readingState.continue.kind === 'next' || vm.readingState.continue.kind === 'start');
  assert.strictEqual(vm.readingState.continue.chapterId, 'b');
});

// ---- Merge ----
test('chapter merge preserves local id and fills gaps', function () {
  var s = seriesFixture();
  var existing = [
    { id: 'c1', chapter: '1', title: '', remoteId: 'r1', sources: [{ sourceId: 'mangadex', remoteId: 'r1' }] }
  ];
  var incoming = [
    { chapter: '1', title: 'Filled Title', remoteId: 'r1', sources: [{ sourceId: 'mangadex', remoteId: 'r1' }] },
    { id: 'new', chapter: '3', title: 'Three', remoteId: 'r9', sources: [{ sourceId: 'mangadex', remoteId: 'r9' }] }
  ];
  var merged = details.mergeChapterLists(existing, incoming, s);
  assert.strictEqual(merged[0].id, 'c1');
  assert.strictEqual(merged[0].title, 'Filled Title');
  assert.strictEqual(merged.length, 2);
  assert.strictEqual(merged[1].chapter, '3');
});

test('chapter merge does not drop local chapters missing from incoming', function () {
  var s = seriesFixture();
  var existing = [
    { id: 'keep', chapter: '1', remoteId: 'r1', sources: [{ sourceId: 'mangadex', remoteId: 'r1' }] },
    { id: 'orphan', chapter: '99', remoteId: 'gone', sources: [{ sourceId: 'mangadex', remoteId: 'gone' }] }
  ];
  var incoming = [
    { chapter: '1', remoteId: 'r1', sources: [{ sourceId: 'mangadex', remoteId: 'r1' }] }
  ];
  var merged = details.mergeChapterLists(existing, incoming, s);
  assert.strictEqual(merged.length, 2);
  assert.ok(merged.some(function (c) { return c.id === 'orphan'; }));
});

test('metadata merge does not overwrite good local with empty incoming', function () {
  var existing = {
    title: 'Local Title',
    description: 'Local desc',
    cover: 'https://example.com/a.jpg',
    status: 'completed',
    authors: ['Local Author']
  };
  var incoming = {
    title: '',
    description: '',
    cover: '',
    status: 'ongoing',
    authors: []
  };
  var m = details.mergeMetadata(existing, incoming);
  assert.strictEqual(m.title, 'Local Title');
  assert.strictEqual(m.description, 'Local desc');
  assert.strictEqual(m.cover, 'https://example.com/a.jpg');
  assert.deepStrictEqual(m.authors, ['Local Author']);
});

test('metadata merge fills gaps from incoming', function () {
  var existing = { title: 'T', description: '', authors: [] };
  var incoming = { description: 'New desc', authors: ['New Author'], year: 2021 };
  var m = details.mergeMetadata(existing, incoming);
  assert.strictEqual(m.description, 'New desc');
  assert.deepStrictEqual(m.authors, ['New Author']);
  assert.strictEqual(m.year, 2021);
});

// ---- View model shape ----
test('view model exposes required Stage 3 fields', function () {
  var vm = details.buildDetailsViewModel(seriesFixture());
  assert.ok(vm.ok);
  [
    'localId', 'canonicalSeriesId', 'title', 'alternateTitles', 'cover', 'description',
    'authors', 'artists', 'status', 'statusLabel', 'year', 'genres', 'tags',
    'sourceBindings', 'libraryState', 'readingState', 'chapters',
    'metadataState', 'chapterState', 'updatedAt'
  ].forEach(function (k) {
    assert.ok(k in vm, 'missing field ' + k);
  });
  assert.ok(Array.isArray(vm.chapters));
  assert.ok(vm.readingState.continue);
  assert.ok(vm.libraryState.state);
});

test('source bindings are attribution only (no urls)', function () {
  var vm = details.buildDetailsViewModel(seriesFixture());
  vm.sourceBindings.forEach(function (b) {
    assert.ok(!('url' in b) || b.url == null);
    assert.ok(b.sourceId);
  });
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
