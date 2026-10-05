'use strict';
/**
 * MangaHive Phase 1 / Stage 5 — Reader page model (pure domain).
 *
 * Normalizes source page payloads into a deterministic ordered list for the
 * in-app Reader. No DOM, network, or storage.
 *
 * Loading: MangaHiveDomain.readerPages (script) / CommonJS (tests).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.MangaHiveDomain = root.MangaHiveDomain || {};
  root.MangaHiveDomain.readerPages = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function () {
  var MAX_URL = 4000;
  var MAX_PAGES = 5000;

  function str(v) {
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number' && isFinite(v)) return String(v);
    return '';
  }

  function isObj(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  /**
   * Accept only http(s) and blob: URLs for in-app image display.
   * Rejects javascript:, data:text, empty, and malformed values.
   */
  function sanitizeImageUrl(raw) {
    var url = str(raw);
    if (!url || url.length > MAX_URL) return null;
    var lower = url.toLowerCase();
    if (lower.indexOf('javascript:') === 0) return null;
    if (lower.indexOf('data:text') === 0) return null;
    if (lower.indexOf('vbscript:') === 0) return null;
    // Allow http(s), blob, and relative paths used by offline/local assets
    if (
      lower.indexOf('http://') === 0 ||
      lower.indexOf('https://') === 0 ||
      lower.indexOf('blob:') === 0 ||
      lower.indexOf('/') === 0 ||
      lower.indexOf('./') === 0 ||
      lower.indexOf('../') === 0 ||
      lower.indexOf('data:image/') === 0
    ) {
      return url;
    }
    // Reject unknown schemes
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return null;
    // bare relative path without scheme
    if (url.indexOf('://') < 0) return url;
    return null;
  }

  /**
   * Normalize a single raw page entry (string URL or object).
   * @returns {object|null}
   */
  function normalizePage(raw, index, context) {
    context = context || {};
    var chapterId = str(context.chapterId) || null;
    var canonicalChapterId = str(context.canonicalChapterId) || null;
    var imageUrl = null;
    var width = null;
    var height = null;
    var pageNumber = index + 1;
    var id = null;
    var available = true;

    if (typeof raw === 'string' || typeof raw === 'number') {
      imageUrl = sanitizeImageUrl(raw);
    } else if (isObj(raw)) {
      imageUrl = sanitizeImageUrl(
        raw.imageUrl || raw.url || raw.src || raw.uri || raw.link || raw.page
      );
      if (typeof raw.width === 'number' && isFinite(raw.width) && raw.width > 0) {
        width = Math.floor(raw.width);
      }
      if (typeof raw.height === 'number' && isFinite(raw.height) && raw.height > 0) {
        height = Math.floor(raw.height);
      }
      if (raw.available === false || raw.unavailable === true) available = false;
      if (raw.pageIndex != null && isFinite(Number(raw.pageIndex))) {
        // keep for ordering hint only
      }
      if (raw.pageNumber != null && isFinite(Number(raw.pageNumber))) {
        pageNumber = Math.floor(Number(raw.pageNumber));
      }
      id = str(raw.id) || null;
    } else {
      return null;
    }

    if (!imageUrl) available = false;

    return {
      id: id || (chapterId ? (chapterId + ':p' + index) : ('p' + index)),
      chapterId: chapterId,
      canonicalChapterId: canonicalChapterId,
      pageIndex: index,
      pageNumber: pageNumber,
      imageUrl: imageUrl,
      width: width,
      height: height,
      alt: 'Page ' + pageNumber,
      availability: available ? 'available' : 'unavailable'
    };
  }

  /**
   * Normalize and order a page list.
   * Prefer explicit pageIndex/pageNumber when present and consistent;
   * otherwise preserve source array order (do not sort URLs alphabetically).
   */
  function normalizePageList(rawPages, context) {
    context = context || {};
    var list = Array.isArray(rawPages) ? rawPages : [];
    if (list.length > MAX_PAGES) list = list.slice(0, MAX_PAGES);

    var hasExplicitIndex = false;
    var withHint = [];
    for (var i = 0; i < list.length; i++) {
      var raw = list[i];
      var hint = i;
      if (isObj(raw)) {
        if (raw.pageIndex != null && isFinite(Number(raw.pageIndex))) {
          hint = Math.floor(Number(raw.pageIndex));
          hasExplicitIndex = true;
        } else if (raw.index != null && isFinite(Number(raw.index))) {
          hint = Math.floor(Number(raw.index));
          hasExplicitIndex = true;
        } else if (raw.pageNumber != null && isFinite(Number(raw.pageNumber))) {
          hint = Math.floor(Number(raw.pageNumber)) - 1;
          hasExplicitIndex = true;
        }
      }
      withHint.push({ raw: raw, hint: hint, ord: i });
    }

    if (hasExplicitIndex) {
      withHint.sort(function (a, b) {
        if (a.hint !== b.hint) return a.hint - b.hint;
        return a.ord - b.ord;
      });
    }

    var out = [];
    for (var j = 0; j < withHint.length; j++) {
      var page = normalizePage(withHint[j].raw, j, context);
      if (page) out.push(page);
    }
    return out;
  }

  /** Count usable (available + URL) pages. */
  function usableCount(pages) {
    var n = 0;
    (Array.isArray(pages) ? pages : []).forEach(function (p) {
      if (p && p.availability === 'available' && p.imageUrl) n += 1;
    });
    return n;
  }

  /**
   * Clamp a resume page index into [0, pageCount-1] or 0 if empty.
   */
  function clampPageIndex(pageIndex, pageCount) {
    var count = Math.floor(Number(pageCount));
    if (!isFinite(count) || count <= 0) return 0;
    var idx = Math.floor(Number(pageIndex));
    if (!isFinite(idx) || idx < 0) return 0;
    if (idx >= count) return count - 1;
    return idx;
  }

  /**
   * Extract plain string URLs for legacy Reader img src assignment.
   * Unavailable pages become empty string placeholders (UI may show retry).
   */
  function toLegacyUrlList(pages) {
    return (Array.isArray(pages) ? pages : []).map(function (p) {
      if (p && p.availability === 'available' && p.imageUrl) return p.imageUrl;
      return '';
    });
  }

  return {
    sanitizeImageUrl: sanitizeImageUrl,
    normalizePage: normalizePage,
    normalizePageList: normalizePageList,
    usableCount: usableCount,
    clampPageIndex: clampPageIndex,
    toLegacyUrlList: toLegacyUrlList
  };
});
