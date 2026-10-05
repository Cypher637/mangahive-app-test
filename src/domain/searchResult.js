'use strict';
/**
 * Phase 1 / Stage 2 (Discovery & Search) — search-result domain model.
 *
 * A SearchResult describes a REMOTE work. It is not a Library entity: it never carries a local
 * `series.id`, and producing one never touches the Library. Identity is derived only from
 * source + remote id through the Stage 1 identity module (normalizeBinding / bindingKey):
 *
 *   sourceBindingKey  = identity bindingKey  (extensionId ␟ sourceId ␟ remoteId)
 *   canonicalSeriesId = 'mhseries:' + sourceBindingKey with the separator rendered as '|'
 *   resultId          = canonicalSeriesId (stable across searches, pages and sessions)
 *
 * Title, cover URL, array index and result position are NEVER part of the identity.
 * `sourceUrl` (if an adapter supplies one) is kept as inert internal metadata under
 * `sourceMetadata.reference`; nothing in this module or the UI may navigate to it.
 *
 * Loading: classic <script> (MangaHiveDomain.searchResult) and CommonJS (tests).
 */
(function (root, factory) {
  var identity = (typeof require === 'function' && typeof module === 'object' && module && module.exports)
    ? require('./identity.js')
    : (root.MangaHiveDomain && root.MangaHiveDomain.identity);
  var api = factory(identity);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.MangaHiveDomain = root.MangaHiveDomain || {};
  root.MangaHiveDomain.searchResult = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function (identity) {
  var CANONICAL_SERIES_PREFIX = 'mhseries:';
  var SEP = '\u001f';
  var MAX_TEXT = 4000, MAX_LIST = 40, MAX_ITEM = 120;

  function str(v) { return v == null ? '' : String(v).trim(); }
  function clip(v, n) { var s = str(v); return s.length > n ? s.slice(0, n) : s; }
  function list(v) {
    var arr = Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]);
    var seen = Object.create(null), out = [];
    for (var i = 0; i < arr.length && out.length < MAX_LIST; i++) {
      var item = arr[i];
      if (item && typeof item === 'object') item = item.name || item.title || item.label || '';
      var s = clip(item, MAX_ITEM);
      var k = s.toLowerCase();
      if (!s || seen[k]) continue;
      seen[k] = true; out.push(s);
    }
    return out;
  }
  function firstOf(a) { return a.length ? a[0] : ''; }

  /** Deterministic canonical series id for a normalized binding; '' when the binding is unusable. */
  function canonicalSeriesIdFromBinding(binding) {
    if (!binding || !binding.bindingKey) return '';
    return CANONICAL_SERIES_PREFIX + binding.bindingKey.split(SEP).join('|');
  }

  function isCanonicalSeriesId(id) {
    return typeof id === 'string' && id.indexOf(CANONICAL_SERIES_PREFIX) === 0 && id.length > CANONICAL_SERIES_PREFIX.length && id.split('|').length >= 3;
  }

  /**
   * Normalize one adapter row into a SearchResult. Returns null when the row has no usable
   * source+remote identity (an unidentifiable row must never reach the UI or the Library).
   * options.sourceId        – fallback when the row has none
   * options.resolveExtensionId(sourceId) – extension owner resolver (same hook as identity.normalizeBinding)
   * options.fetchedAt       – timestamp (injected for determinism)
   * options.sourceMeta      – { name, kind, reader } copied into sourceMetadata
   */
  function normalizeSearchResult(raw, options) {
    options = options || {};
    if (!raw || typeof raw !== 'object') return null;
    var sourceId = str(raw.sourceId || options.sourceId);
    var remoteId = str(raw.remoteId != null ? raw.remoteId : raw.id);
    var binding = identity.normalizeBinding({ sourceId: sourceId, remoteId: remoteId, extensionId: raw.extensionId }, options);
    if (!binding) return null;
    var title = clip(raw.title, 300);
    if (!title) return null;
    var authors = list(raw.authors != null ? raw.authors : raw.author);
    var artists = list(raw.artists != null ? raw.artists : raw.artist);
    var canonicalSeriesId = canonicalSeriesIdFromBinding(binding);
    var meta = options.sourceMeta || {};
    var result = {
      resultId: canonicalSeriesId,
      sourceId: binding.sourceId,
      remoteId: binding.remoteId,
      extensionId: binding.extensionId,
      canonicalSeriesId: canonicalSeriesId,
      sourceBindingKey: binding.bindingKey,
      title: title,
      alternateTitles: list(raw.alternateTitles || raw.altTitles),
      description: clip(raw.description, MAX_TEXT),
      coverUrl: clip(raw.coverUrl != null ? raw.coverUrl : raw.cover, 2000),
      author: firstOf(authors),
      authors: authors,
      artist: firstOf(artists),
      artists: artists,
      status: clip(raw.status, 40),
      year: clip(raw.year, 8),
      genres: list(raw.genres),
      tags: list(raw.tags),
      sourceMetadata: {
        sourceName: clip(meta.name, 80),
        kind: clip(meta.kind, 40),
        readable: !!meta.reader,
        // Internal reference only. NEVER navigate to this (no-redirect rule).
        reference: clip(raw.sourceUrl, 2000) || null
      },
      fetchedAt: typeof options.fetchedAt === 'number' ? options.fetchedAt : 0
    };
    return result;
  }

  /** Title key used ONLY for ordering ties and the (opt-in) strong-match guard – never for identity. */
  function titleKey(t) { return identity.normalizeTitleKey(t); }

  /**
   * Conservative "same work" test between two results from DIFFERENT sources. True only when
   * the normalized primary titles are equal (length >= 4) AND at least one corroborating
   * signal agrees and nothing contradicts: same year, or an author overlap. Title similarity
   * alone is never enough. False-positive merges are worse than duplicates.
   */
  function strongSameWork(a, b) {
    if (!a || !b || a.canonicalSeriesId === b.canonicalSeriesId) return false;
    var ta = titleKey(a.title), tb = titleKey(b.title);
    if (!ta || ta !== tb || ta.length < 4) return false;
    if (a.year && b.year && a.year !== b.year) return false;
    var aa = a.authors.map(titleKey).filter(Boolean), bb = b.authors.map(titleKey).filter(Boolean);
    if (aa.length && bb.length) {
      var set = Object.create(null); aa.forEach(function (x) { set[x] = true; });
      var overlap = bb.some(function (x) { return set[x]; });
      if (!overlap) return false;
      return true;
    }
    return !!(a.year && b.year && a.year === b.year);
  }

  return {
    CANONICAL_SERIES_PREFIX: CANONICAL_SERIES_PREFIX,
    canonicalSeriesIdFromBinding: canonicalSeriesIdFromBinding,
    isCanonicalSeriesId: isCanonicalSeriesId,
    normalizeSearchResult: normalizeSearchResult,
    strongSameWork: strongSameWork,
    titleKey: titleKey
  };
});
