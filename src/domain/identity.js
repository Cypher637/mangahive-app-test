/**
 * MangaHive Phase 1 / Stage 1 — Identity contract (pure domain module).
 *
 * Three different things are called "an id" in this codebase. This module keeps
 * them apart and is the ONLY place new code should ask "which chapter is this?":
 *
 *   local identity     series.id / chapter.id        – stable client ids; the keys
 *                      every persisted record (progress, history, bookmarks,
 *                      downloads, routes…) already uses. Never rewritten here.
 *   canonical identity series.canonicalId            – the library-wide id of a
 *                      chapter.canonicalChapterId      logical series / chapter,
 *                      independent of any source. It is canonical *within this
 *                      library*; it is NOT a global registry id (see
 *                      isGlobalCanonical: false).
 *   source identity    extensionId + sourceId + remoteId – one provider's copy.
 *
 * Rules: deterministic, never mutates input, never touches DOM / network /
 * storage, tolerates malformed input (never throws), never invents random ids.
 *
 * Loading: classic <script> (browser, exposes MangaHiveDomain.identity) and
 * CommonJS (tests). No bundler.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.MangaHiveDomain = root.MangaHiveDomain || {};
  root.MangaHiveDomain.identity = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  var CANONICAL_CHAPTER_PREFIX = 'mhch:';
  var MAX_KEY_LEN = 160;
  var BINDING_SEP = '\u001f'; // identical to the app's canonicalSourceBindingKey()

  // ---- tiny pure helpers -------------------------------------------------

  /** Accept only strings and finite numbers; everything else is "absent". */
  function str(v) {
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number' && isFinite(v)) return String(v);
    return '';
  }

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

  /** Same normalisation the app's normalizeTitleKey() applies. */
  function normalizeTitleKey(v) {
    return str(v).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  /** cyrb53 – small, fast, deterministic 53-bit string hash (not cryptographic). */
  function hashString(input) {
    var s = String(input == null ? '' : input);
    var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }

  function stripLeadingZeros(n) { return n.replace(/^0+(?=\d)/, '') || '0'; }

  // ---- structured chapter identity (pure port of the app's extractChapterIdentity)

  /**
   * number / suffix / part / volume / titleKey / key for a chapter-ish object.
   * Mirrors index.html extractChapterIdentity() so keys stay compatible with
   * every canonicalChapterId the app has already persisted.
   */
  function extractChapterStructure(ch) {
    var empty = { key: '', number: '', suffix: '', part: '', volume: '', titleKey: '' };
    if (!isObj(ch)) return empty;
    var vol = str(ch.volume);
    var raw = str(ch.chapter);
    var title = str(ch.title);
    var suffix = '', part = '', number = '';

    if (raw) {
      var mNum = /^(\d+(?:\.\d+)?)([A-Za-z]+)?$/.exec(raw);
      if (mNum) {
        number = stripLeadingZeros(mNum[1]);
        if (mNum[2]) suffix = mNum[2].toLowerCase();
      } else {
        var mHy = /^(\d+(?:\.\d+)?)\s*[-_]?\s*(.+)$/i.exec(raw);
        if (mHy) {
          number = stripLeadingZeros(mHy[1]);
          suffix = normalizeTitleKey(mHy[2]).replace(/\s+/g, '-');
        } else {
          number = raw.replace(/^0+(?=\d)/, '') || raw;
        }
      }
    }

    if (title) {
      if (!number) {
        var cm = /(?:ch(?:apter)?|ep(?:isode)?)[.\s#:/-]*(\d+(?:\.\d+)?)([A-Za-z])?/i.exec(title);
        if (cm) {
          number = stripLeadingZeros(cm[1]);
          if (cm[2]) suffix = suffix || cm[2].toLowerCase();
        } else {
          var lm = /^(\d+(?:\.\d+)?)([A-Za-z])?\b/.exec(title);
          if (lm) {
            number = stripLeadingZeros(lm[1]);
            if (lm[2]) suffix = suffix || lm[2].toLowerCase();
          }
        }
      }
      if (!vol) {
        var vm = /vol(?:ume)?[.\s-]*(\d+)/i.exec(title);
        if (vm) vol = vm[1];
      }
      var low = title.toLowerCase();
      if (/\bextra\b/.test(low) || /\bomake\b/.test(low)) suffix = suffix || 'extra';
      else if (/\bspecial\b/.test(low) || /\bsp\b/.test(low)) suffix = suffix || 'special';
      else if (/\bside[\s-]?story\b/.test(low)) suffix = suffix || 'side-story';
      else if (/\bbonus\b/.test(low)) suffix = suffix || 'bonus';
      var pm = /\bpart\s*([0-9]+|[ivx]+)\b/i.exec(title);
      if (pm) part = String(pm[1]).toLowerCase();
    }

    var titleKey = normalizeTitleKey(title).slice(0, 48);
    var key = [number || '', suffix || '', part ? ('part-' + part) : ''].filter(Boolean).join('-') || titleKey;
    if (vol) key = 'v' + vol + ':' + key;
    return { key: key, number: number, suffix: suffix, part: part, volume: vol, titleKey: titleKey };
  }

  // ---- source identity ---------------------------------------------------

  function canonicalBindingKey(extensionId, sourceId, remoteId) {
    var e = str(extensionId), s = str(sourceId), r = str(remoteId);
    if (!e || !s || !r) return '';
    return e + BINDING_SEP + s + BINDING_SEP + r;
  }

  /**
   * Normalise one source binding. The extension owner is the explicit
   * extensionId if present, else an injected resolver, else `builtin:<sourceId>`
   * (the same fallback the app uses). Returns null when sourceId/remoteId are
   * unusable – an incomplete binding is not an identity.
   */
  function normalizeBinding(b, options) {
    if (!isObj(b)) return null;
    var sourceId = str(b.sourceId);
    var remoteId = str(b.remoteId != null ? b.remoteId : b.chapterRemoteId);
    if (!sourceId || !remoteId) return null;
    var extensionId = str(b.extensionId);
    if (!extensionId && options && typeof options.resolveExtensionId === 'function') {
      try { extensionId = str(options.resolveExtensionId(sourceId)); } catch (e) { extensionId = ''; }
    }
    if (!extensionId) extensionId = 'builtin:' + sourceId;
    return {
      extensionId: extensionId,
      sourceId: sourceId,
      remoteId: remoteId,
      bindingKey: canonicalBindingKey(extensionId, sourceId, remoteId)
    };
  }

  function dedupeBindings(list) {
    var seen = {}, out = [];
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (!b || seen[b.bindingKey]) continue;
      seen[b.bindingKey] = true;
      out.push(b);
    }
    return out;
  }

  function chapterBindings(chapter, options) {
    if (!isObj(chapter)) return [];
    var out = [];
    if (Array.isArray(chapter.sources)) {
      for (var i = 0; i < chapter.sources.length; i++) {
        var b = normalizeBinding(chapter.sources[i], options);
        if (b) out.push(b);
      }
    }
    // legacy single-source chapter: { sourceId, remoteId }
    var legacy = normalizeBinding({ sourceId: chapter.sourceId, remoteId: chapter.remoteId != null ? chapter.remoteId : chapter.remoteChapterId, extensionId: chapter.extensionId }, options);
    if (legacy) out.push(legacy);
    return dedupeBindings(out);
  }

  /**
   * Source identity of a chapter for a given source. With no sourceId it is
   * only returned when the chapter has exactly one binding (otherwise it is
   * ambiguous and null is returned rather than guessing).
   */
  function getChapterSourceIdentity(chapter, sourceId, options) {
    var list = chapterBindings(chapter, options);
    var want = str(sourceId);
    if (!want) return list.length === 1 ? list[0] : null;
    for (var i = 0; i < list.length; i++) if (list[i].sourceId === want) return list[i];
    return null;
  }

  // ---- series identity ---------------------------------------------------

  /**
   * Distinguishes local / canonical / source identity of a series. The
   * canonical id is library-scoped: a client-generated id is never presented
   * as globally canonical (isGlobalCanonical is always false in Stage 1).
   */
  function getSeriesIdentity(series, options) {
    var s = isObj(series) ? series : {};
    var localId = str(s.id) || null;
    var explicit = str(s.canonicalId);
    var canonicalId = explicit || localId;
    var sources = [];
    if (Array.isArray(s.sourceMappings)) {
      for (var i = 0; i < s.sourceMappings.length; i++) {
        var b = normalizeBinding(s.sourceMappings[i], options);
        if (b) sources.push(b);
      }
    }
    if (isObj(s.source)) {
      var legacy = normalizeBinding({ sourceId: s.source.type != null ? s.source.type : s.source.sourceId, remoteId: s.source.remoteId, extensionId: s.source.extensionId }, options);
      if (legacy) sources.push(legacy);
    }
    sources = dedupeBindings(sources);
    return {
      localId: localId,
      canonicalId: canonicalId || null,
      canonicalScope: 'library',
      isGlobalCanonical: false,
      hasExplicitCanonicalId: !!explicit,
      sources: sources,
      primarySource: sources.length ? sources[0] : null
    };
  }

  // ---- chapter identity --------------------------------------------------

  /**
   * Contract for a *canonical* chapter id: `mhch:<seriesCanonicalId>:<key>`,
   * non-empty series part (no ':'), non-empty key, no control characters.
   * Anything else is a legacy/foreign string and is never treated as canonical.
   */
  function isCanonicalChapterId(id) {
    if (typeof id !== 'string') return false;
    if (id.length < 8 || id.length > 400) return false;
    return /^mhch:[^:\u0000-\u001f]+:[^\u0000-\u001f]+$/.test(id);
  }

  function escapeSeriesPart(id) {
    return String(id).replace(/%/g, '%25').replace(/:/g, '%3A');
  }

  function clipKey(key) {
    if (key.length <= MAX_KEY_LEN) return key;
    return key.slice(0, MAX_KEY_LEN - 14) + '~' + hashString(key); // keep long keys collision-resistant
  }

  /** The ONE place a canonical chapter id is derived. Returns { id, confidence }. */
  function deriveCanonicalChapterId(seriesCanonicalId, chapter, structure, bindings) {
    var sid = str(seriesCanonicalId);
    if (!sid) return { id: null, confidence: 'none' };
    var key = '', confidence = 'none';
    var localId = isObj(chapter) ? str(chapter.id) : '';
    if (structure.number) {
      key = structure.key; confidence = 'structured';
    } else if (bindings.length) {
      key = 'r~' + hashString(bindings[0].bindingKey); confidence = 'remote';
    } else if (structure.key) {
      // title-only: duplicate titles are possible, so disambiguate with the local id when there is one
      key = localId ? (structure.key + '~' + hashString(localId)) : structure.key; confidence = 'weak';
    } else if (localId) {
      key = 'id~' + hashString(localId); confidence = 'weak';
    }
    if (!key) return { id: null, confidence: 'none' };
    var id = CANONICAL_CHAPTER_PREFIX + escapeSeriesPart(sid) + ':' + clipKey(key);
    return isCanonicalChapterId(id) ? { id: id, confidence: confidence } : { id: null, confidence: 'none' };
  }

  /**
   * Full identity of a chapter.
   *   localId             chapter.id, untouched (null if absent)
   *   canonicalChapterId  existing value if it satisfies the contract, else derived, else null
   *   canonicalSource     'existing' | 'derived' | 'none'
   *   confidence          'existing' | 'structured' | 'remote' | 'weak' | 'none'
   *   isCanonical         canonicalChapterId !== null
   *   structured          number / suffix / part / volume / titleKey / key
   *   sources             normalised source bindings
   *   instanceKey         canonical id + primary binding: unique per provider copy
   * Same logical chapter from two sources ⇒ same canonicalChapterId, different instanceKey.
   */
  function getChapterIdentity(chapter, series, options) {
    var c = isObj(chapter) ? chapter : {};
    var sid = getSeriesIdentity(series, options);
    var structure = extractChapterStructure(c);
    var bindings = chapterBindings(c, options);
    var localId = str(c.id) || null;
    var existing = typeof c.canonicalChapterId === 'string' ? c.canonicalChapterId : '';
    var canonicalChapterId = null, canonicalSource = 'none', confidence = 'none';
    if (isCanonicalChapterId(existing)) {
      canonicalChapterId = existing; canonicalSource = 'existing'; confidence = 'existing';
    } else {
      var d = deriveCanonicalChapterId(sid.canonicalId, c, structure, bindings);
      if (d.id) { canonicalChapterId = d.id; canonicalSource = 'derived'; confidence = d.confidence; }
    }
    var instanceKey = (canonicalChapterId || ('legacy:' + (localId || ''))) + '|' + (bindings.length ? bindings[0].bindingKey : '');
    return {
      localId: localId,
      canonicalChapterId: canonicalChapterId,
      canonicalSource: canonicalSource,
      confidence: confidence,
      isCanonical: canonicalChapterId !== null,
      seriesLocalId: sid.localId,
      seriesCanonicalId: sid.canonicalId,
      structured: structure,
      sources: bindings,
      instanceKey: instanceKey
    };
  }

  /** D1 entry point: canonical identity without forcing any consumer to migrate off chapter.id. */
  function getCanonicalChapterIdentity(chapter, series, options) {
    var i = getChapterIdentity(chapter, series, options);
    return {
      id: i.canonicalChapterId,
      source: i.canonicalSource,
      confidence: i.confidence,
      isCanonical: i.isCanonical,
      localId: i.localId
    };
  }

  function getCanonicalChapterId(chapter, series, options) {
    return getChapterIdentity(chapter, series, options).canonicalChapterId;
  }

  /** True when two chapter objects are the same logical chapter (canonical id equality, else local id). */
  function isSameChapter(a, b, seriesA, seriesB) {
    var ia = getChapterIdentity(a, seriesA), ib = getChapterIdentity(b, seriesB || seriesA);
    if (ia.canonicalChapterId && ib.canonicalChapterId) return ia.canonicalChapterId === ib.canonicalChapterId;
    return !!ia.localId && ia.localId === ib.localId;
  }

  return {
    CANONICAL_CHAPTER_PREFIX: CANONICAL_CHAPTER_PREFIX,
    str: str,
    isObj: isObj,
    hashString: hashString,
    normalizeTitleKey: normalizeTitleKey,
    extractChapterStructure: extractChapterStructure,
    canonicalBindingKey: canonicalBindingKey,
    normalizeBinding: normalizeBinding,
    isCanonicalChapterId: isCanonicalChapterId,
    getSeriesIdentity: getSeriesIdentity,
    getChapterIdentity: getChapterIdentity,
    getCanonicalChapterIdentity: getCanonicalChapterIdentity,
    getCanonicalChapterId: getCanonicalChapterId,
    getChapterSourceIdentity: getChapterSourceIdentity,
    isSameChapter: isSameChapter
  };
});
