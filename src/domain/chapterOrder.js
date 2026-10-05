/**
 * MangaHive Phase 1 / Stage 1 — Chapter ordering contract (pure domain module).
 *
 * Ascending reading order (oldest → newest). The order never depends on array
 * position or lexicographic string order. Precedence:
 *
 *   1. chapter number     numeric, decimal-aware ("2" < "2.5" < "3" < "10").
 *                         Chapters with no number sort AFTER numbered ones.
 *   2. suffix             none < a < b … < extra < special < side-story < bonus < other (alpha)
 *   3. volume             no volume < volume 1 < volume 2 …   (total order, so the
 *                         comparator stays transitive when only some chapters have one)
 *   4. part               no part < part 1 < part 2 … (roman numerals understood)
 *   5. title              normalised title, plain code-unit order (locale independent)
 *   6. stable identity    canonicalChapterId, then chapter.id, then source instance key
 *
 * Nothing here mutates its inputs. Non-object entries in a list are dropped
 * from sorted results (they are not chapters). Stage 4 will build the chapter
 * UI on this contract; Stage 1 deliberately does not rewire the existing UI.
 */
(function (root, factory) {
  var identity = (typeof require === 'function' && typeof module === 'object' && module && module.exports)
    ? require('./identity.js')
    : (root.MangaHiveDomain && root.MangaHiveDomain.identity);
  var api = factory(identity);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.MangaHiveDomain = root.MangaHiveDomain || {};
  root.MangaHiveDomain.chapterOrder = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function (identity) {
  'use strict';

  if (!identity) throw new Error('MangaHiveDomain.identity must be loaded before chapterOrder');

  var NAMED_SUFFIX_RANK = { 'extra': 100, 'special': 101, 'side-story': 102, 'bonus': 103 };

  function cmpNum(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }
  function cmpStr(a, b) { return a < b ? -1 : (a > b ? 1 : 0); } // code-unit order, locale independent

  /** Compare non-negative decimal strings exactly (no float rounding): "2.5" vs "2.50", "10" vs "9". */
  function compareDecimalStrings(a, b) {
    var pa = String(a).split('.'), pb = String(b).split('.');
    var ia = pa[0].replace(/^0+(?=\d)/, ''), ib = pb[0].replace(/^0+(?=\d)/, '');
    if (ia.length !== ib.length) return ia.length < ib.length ? -1 : 1;
    var c = cmpStr(ia, ib);
    if (c) return c;
    var fa = pa[1] || '', fb = pb[1] || '';
    var n = Math.max(fa.length, fb.length);
    while (fa.length < n) fa += '0';
    while (fb.length < n) fb += '0';
    return cmpStr(fa, fb);
  }

  function suffixRank(s) {
    if (!s) return 0;
    if (/^[a-z]$/.test(s)) return 1 + (s.charCodeAt(0) - 97);
    if (NAMED_SUFFIX_RANK[s] != null) return NAMED_SUFFIX_RANK[s];
    return 200;
  }

  function romanToInt(s) {
    var map = { i: 1, v: 5, x: 10 }, total = 0, prev = 0;
    for (var i = s.length - 1; i >= 0; i--) {
      var v = map[s[i]];
      if (!v) return NaN;
      total += v < prev ? -v : v;
      prev = v;
    }
    return total;
  }

  function partValue(p) {
    if (!p) return -1; // "no part" sorts before any part
    if (/^\d+$/.test(p)) return parseInt(p, 10);
    var r = romanToInt(p);
    return isNaN(r) ? Infinity : r;
  }

  function volumeValue(v) {
    if (!v) return -1;
    var n = parseFloat(v);
    return isFinite(n) ? n : Infinity;
  }

  /** Everything the comparator needs, computed once per chapter. */
  function sortKey(chapter) {
    var id = identity.getChapterIdentity(chapter);
    var s = id.structured;
    return {
      number: s.number,
      suffix: s.suffix,
      volume: volumeValue(s.volume),
      volumeRaw: s.volume,
      part: partValue(s.part),
      partRaw: s.part,
      title: identity.normalizeTitleKey(chapter && chapter.title),
      canonical: id.canonicalChapterId || '',
      local: id.localId || '',
      instance: id.instanceKey || ''
    };
  }

  function compareKeys(a, b) {
    var c;
    if (a.number || b.number) {
      if (!a.number) return 1;   // unnumbered after numbered
      if (!b.number) return -1;
      c = compareDecimalStrings(a.number, b.number); if (c) return c;
    }
    c = cmpNum(suffixRank(a.suffix), suffixRank(b.suffix)); if (c) return c;
    if (suffixRank(a.suffix) === 200) { c = cmpStr(a.suffix, b.suffix); if (c) return c; }
    c = cmpNum(a.volume, b.volume); if (c) return c;
    if (a.volume === Infinity) { c = cmpStr(a.volumeRaw, b.volumeRaw); if (c) return c; }
    c = cmpNum(a.part, b.part); if (c) return c;
    if (a.part === Infinity) { c = cmpStr(a.partRaw, b.partRaw); if (c) return c; }
    c = cmpStr(a.title, b.title); if (c) return c;
    c = cmpStr(a.canonical, b.canonical); if (c) return c;
    c = cmpStr(a.local, b.local); if (c) return c;
    return cmpStr(a.instance, b.instance);
  }

  /** Deterministic comparator usable directly with Array.prototype.sort. */
  function compareChapters(a, b) {
    return compareKeys(sortKey(a), sortKey(b));
  }

  /** Returns a NEW array in reading order; never mutates `chapters`. */
  function sortChapters(chapters) {
    if (!Array.isArray(chapters)) return [];
    var entries = [];
    for (var i = 0; i < chapters.length; i++) {
      if (identity.isObj(chapters[i])) entries.push({ ch: chapters[i], k: sortKey(chapters[i]), i: i });
    }
    entries.sort(function (x, y) { return compareKeys(x.k, y.k) || (x.i - y.i); });
    return entries.map(function (e) { return e.ch; });
  }

  /** Index of `chapter` inside an already-sorted list: by local id, then canonical id; -1 if absent. */
  function indexOfChapter(sorted, chapter) {
    if (!identity.isObj(chapter)) return -1;
    var lid = identity.str(chapter.id);
    var i;
    if (lid) for (i = 0; i < sorted.length; i++) if (identity.str(sorted[i].id) === lid) return i;
    var cid = identity.getChapterIdentity(chapter).canonicalChapterId;
    if (cid) for (i = 0; i < sorted.length; i++) if (identity.getChapterIdentity(sorted[i]).canonicalChapterId === cid) return i;
    return -1;
  }

  /**
   * The chapter after `chapter` in reading order, or null. If `chapter` is not
   * in the list (e.g. after a refresh) it is positioned by the comparator, so
   * the answer is the first chapter that sorts strictly after it.
   */
  function getNextChapter(chapters, chapter) {
    var sorted = sortChapters(chapters);
    if (!identity.isObj(chapter)) return null;
    var idx = indexOfChapter(sorted, chapter);
    if (idx >= 0) return idx + 1 < sorted.length ? sorted[idx + 1] : null;
    var k = sortKey(chapter);
    for (var i = 0; i < sorted.length; i++) if (compareKeys(sortKey(sorted[i]), k) > 0) return sorted[i];
    return null;
  }

  /** The chapter before `chapter`, or null. Same positioning rules as getNextChapter. */
  function getPreviousChapter(chapters, chapter) {
    var sorted = sortChapters(chapters);
    if (!identity.isObj(chapter)) return null;
    var idx = indexOfChapter(sorted, chapter);
    if (idx >= 0) return idx > 0 ? sorted[idx - 1] : null;
    var k = sortKey(chapter);
    for (var i = sorted.length - 1; i >= 0; i--) if (compareKeys(sortKey(sorted[i]), k) < 0) return sorted[i];
    return null;
  }

  return {
    compareChapters: compareChapters,
    sortChapters: sortChapters,
    getNextChapter: getNextChapter,
    getPreviousChapter: getPreviousChapter,
    compareDecimalStrings: compareDecimalStrings
  };
});
