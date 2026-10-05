'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const order = require('../../src/domain/chapterOrder.js');
const { deepFreeze } = require('./helpers/memoryStorage.js');

const ch = (id, chapter, extra) => Object.assign({ id, chapter: chapter == null ? undefined : String(chapter) }, extra || {});
const numbers = (list) => list.map((c) => c.chapter);

test('numeric, not lexicographic: 1 2 2.5 3 10', () => {
  const list = [ch('a', 10), ch('b', 2.5), ch('c', 1), ch('d', 3), ch('e', 2)];
  assert.deepEqual(numbers(order.sortChapters(list)), ['1', '2', '2.5', '3', '10']);
});

test('10 10.5 11 and 9 < 10 < 100 (string order would be wrong)', () => {
  assert.deepEqual(numbers(order.sortChapters([ch('a', 11), ch('b', 10.5), ch('c', 10)])), ['10', '10.5', '11']);
  assert.deepEqual(numbers(order.sortChapters([ch('a', 100), ch('b', 9), ch('c', 10)])), ['9', '10', '100']);
});

test('decimals compare exactly: 2.5 < 2.10? no — 2.10 < 2.5 numerically; 2.5 == 2.50', () => {
  assert.equal(order.compareDecimalStrings('2.5', '2.50'), 0);
  assert.equal(order.compareDecimalStrings('2.10', '2.5'), -1);
  assert.equal(order.compareDecimalStrings('2.5', '2.10'), 1);
  assert.equal(order.compareDecimalStrings('9007199254740993', '9007199254740992'), 1, 'no float rounding');
  assert.deepEqual(numbers(order.sortChapters([ch('a', '10.15'), ch('b', '10.5'), ch('c', '10.05')])), ['10.15', '10.5', '10.05'].sort((x, y) => parseFloat(x) - parseFloat(y)));
});

test('suffixes: plain < a < b < extra < special < side-story < bonus, all within the same number', () => {
  const list = [
    ch('1', '12', { title: 'Chapter 12 Bonus' }), ch('2', '12', { title: 'Chapter 12 Side Story' }),
    ch('3', '12b'), ch('4', '12'), ch('5', '12a'), ch('6', '12', { title: 'Chapter 12 Special' }),
    ch('7', '12', { title: 'Chapter 12 Extra' }), ch('8', '13')
  ];
  assert.deepEqual(order.sortChapters(list).map((c) => c.id), ['4', '5', '3', '7', '6', '2', '1', '8']);
});

test('12.5 sorts after 12a (number first, then suffix)', () => {
  assert.deepEqual(numbers(order.sortChapters([ch('a', '12.5'), ch('b', '12a'), ch('c', '12')])), ['12', '12a', '12.5']);
});

test('volume: no volume before volume 1 before volume 2, only after number/suffix tie', () => {
  const list = [ch('a', 5, { volume: '2' }), ch('b', 5), ch('c', 5, { volume: '1' }), ch('d', 4, { volume: '9' })];
  assert.deepEqual(order.sortChapters(list).map((c) => c.id), ['d', 'b', 'c', 'a']);
});

test('part: no part < part 1 < part 2 < part III (roman numerals understood)', () => {
  const list = [
    ch('p3', 8, { title: 'Chapter 8 Part III' }), ch('p0', 8), ch('p2', 8, { title: 'Chapter 8 Part 2' }), ch('p1', 8, { title: 'Chapter 8 Part I' })
  ];
  assert.deepEqual(order.sortChapters(list).map((c) => c.id), ['p0', 'p1', 'p2', 'p3']);
});

test('unnumbered chapters sort after numbered ones, then by title, then by stable identity', () => {
  const list = [{ id: 'z', title: 'Zeta' }, ch('n', 1), { id: 'b', title: 'Beta' }, { id: 'a2', title: 'Alpha' }, { id: 'a1', title: 'Alpha' }];
  assert.deepEqual(order.sortChapters(list).map((c) => c.id), ['n', 'a1', 'a2', 'b', 'z']);
});

test('fallback chain is total: full ties are broken by canonical id, then local id', () => {
  const a = ch('id-a', 1, { canonicalChapterId: 'mhch:s:1' }), b = ch('id-b', 1, { canonicalChapterId: 'mhch:s:1' });
  assert.equal(order.compareChapters(a, b), -1);
  assert.equal(order.compareChapters(b, a), 1);
  assert.equal(order.compareChapters(a, Object.assign({}, a)), 0);
});

test('does not mutate the source array or chapters; returns a new array', () => {
  const list = deepFreeze([ch('a', 3), ch('b', 1), ch('c', 2)]);
  const out = order.sortChapters(list);
  assert.notEqual(out, list);
  assert.deepEqual(list.map((c) => c.id), ['a', 'b', 'c']);
  assert.deepEqual(out.map((c) => c.id), ['b', 'c', 'a']);
  assert.equal(out[0], list[1], 'chapter objects are the same references, not copies');
  assert.doesNotThrow(() => order.getNextChapter(list, list[0]));
});

test('deterministic regardless of input order (all permutations of distinct chapters)', () => {
  const base = [ch('a', 1), ch('b', 2), ch('c', 2.5), ch('d', 3), ch('e', 10), { id: 'f', title: 'Omake' }];
  const expected = order.sortChapters(base).map((c) => c.id);
  const perms = (arr) => arr.length <= 1 ? [arr] : arr.flatMap((x, i) => perms([...arr.slice(0, i), ...arr.slice(i + 1)]).map((p) => [x, ...p]));
  for (const p of perms(base)) assert.deepEqual(order.sortChapters(p).map((c) => c.id), expected);
});

test('comparator is a consistent total order (antisymmetric + transitive on a random mix)', () => {
  let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pool = [];
  for (let i = 0; i < 60; i++) {
    const n = rnd() < 0.15 ? undefined : Math.floor(rnd() * 8) + (rnd() < 0.3 ? 0.5 : 0);
    pool.push({ id: 'x' + i, chapter: n == null ? undefined : String(n), volume: rnd() < 0.3 ? String(1 + Math.floor(rnd() * 3)) : undefined, title: rnd() < 0.4 ? ['Extra', 'Part 2', 'Special', 'Misc'][Math.floor(rnd() * 4)] : undefined });
  }
  for (const a of pool) for (const b of pool) assert.equal(Math.sign(order.compareChapters(a, b)) + Math.sign(order.compareChapters(b, a)), 0);
  const sorted = order.sortChapters(pool);
  for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) assert.ok(order.compareChapters(sorted[i], sorted[j]) <= 0);
});

test('getNextChapter / getPreviousChapter follow reading order, not array position', () => {
  const list = [ch('c', 10), ch('a', 1), ch('b', 2), ch('x', 2.5)];
  assert.equal(order.getNextChapter(list, list[1]).id, 'b');
  assert.equal(order.getNextChapter(list, list[2]).id, 'x');
  assert.equal(order.getNextChapter(list, list[3]).id, 'c');
  assert.equal(order.getNextChapter(list, list[0]), null, 'last chapter has no next');
  assert.equal(order.getPreviousChapter(list, list[0]).id, 'x');
  assert.equal(order.getPreviousChapter(list, list[1]), null, 'first chapter has no previous');
});

test('lookup by canonical id when the local id is not in the list; positioning when absent entirely', () => {
  const list = [ch('a', 1, { canonicalChapterId: 'mhch:s:1' }), ch('b', 3), ch('c', 5)];
  assert.equal(order.getNextChapter(list, { id: 'renamed', canonicalChapterId: 'mhch:s:1' }).id, 'b');
  assert.equal(order.getNextChapter(list, ch('new', 4)).id, 'c', 'a chapter not in the list is positioned by the comparator');
  assert.equal(order.getPreviousChapter(list, ch('new', 4)).id, 'b');
  assert.equal(order.getNextChapter(list, ch('new', 99)), null);
});

test('malformed inputs are tolerated', () => {
  assert.deepEqual(order.sortChapters(null), []);
  assert.deepEqual(order.sortChapters('x'), []);
  assert.deepEqual(order.sortChapters([null, 3, 'a', ch('a', 2), undefined, ch('b', 1)]).map((c) => c.id), ['b', 'a']);
  assert.equal(order.getNextChapter([], ch('a', 1)), null);
  assert.equal(order.getNextChapter([ch('a', 1)], null), null);
  assert.equal(order.getPreviousChapter(undefined, ch('a', 1)), null);
  assert.doesNotThrow(() => order.compareChapters(null, undefined));
  assert.equal(order.compareChapters(null, undefined), 0);
});

test('performance guard: sorting 5000 chapters is fast and correct', () => {
  const list = []; for (let i = 5000; i >= 1; i--) list.push(ch('c' + i, i));
  const t0 = Date.now(); const out = order.sortChapters(list); const ms = Date.now() - t0;
  assert.equal(out[0].chapter, '1'); assert.equal(out[4999].chapter, '5000');
  assert.ok(ms < 2000, 'took ' + ms + 'ms');
});
