'use strict';
/**
 * MangaHive Phase 1 / Stage 3 — Manga Details domain.
 *
 * Builds a normalized Details view model from a library series record (and optional
 * progress map). Pure: no DOM, no network, no storage writes.
 *
 * Identity: resolves through Stage 1 identity (local series.id + canonicalId).
 * Chapters: ordered via Stage 1 chapterOrder; identity via Stage 1 identity.
 * Progress/Continue: consumed from the existing progress map shape used by the app
 * (state.progress[seriesId] keyed by chapterId).
 *
 * Loading: classic <script> (MangaHiveDomain.mangaDetails) and CommonJS (tests).
 */
(function (root, factory) {
  var identity = (typeof require === 'function' && typeof module === 'object' && module && module.exports)
    ? require('./identity.js')
    : (root.MangaHiveDomain && root.MangaHiveDomain.identity);
  var chapterOrder = (typeof require === 'function' && typeof module === 'object' && module && module.exports)
    ? require('./chapterOrder.js')
    : (root.MangaHiveDomain && root.MangaHiveDomain.chapterOrder);
  var api = factory(identity, chapterOrder);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.MangaHiveDomain = root.MangaHiveDomain || {};
  root.MangaHiveDomain.mangaDetails = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function (identity, chapterOrder) {
  if (!identity) throw new Error('MangaHiveDomain.identity must be loaded before mangaDetails');
  if (!chapterOrder) throw new Error('MangaHiveDomain.chapterOrder must be loaded before mangaDetails');

  var MAX_DESC = 12000;
  var MAX_LIST = 64;
  var MAX_ITEM = 160;

  function str(v) {
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number' && isFinite(v)) return String(v);
    return '';
  }

  function isObj(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function clip(v, n) {
    var s = str(v);
    return s.length > n ? s.slice(0, n) : s;
  }

  /** Deduplicate list of strings (case-insensitive key), preserve first-seen order. */
  function uniqueStrings(list, max) {
    var out = [];
    var seen = Object.create(null);
    var src = Array.isArray(list) ? list : [];
    for (var i = 0; i < src.length; i++) {
      var t = clip(src[i], MAX_ITEM);
      if (!t) continue;
      var key = t.toLowerCase();
      if (seen[key]) continue;
      seen[key] = true;
      out.push(t);
      if (out.length >= (max || MAX_LIST)) break;
    }
    return out;
  }

  // ---- status normalization ------------------------------------------------

  var STATUS_MAP = {
    ongoing: 'ongoing',
    continuing: 'ongoing',
    publishing: 'ongoing',
    current: 'ongoing',
    completed: 'completed',
    finished: 'completed',
    complete: 'completed',
    ended: 'completed',
    hiatus: 'hiatus',
    'on hiatus': 'hiatus',
    on_hiatus: 'hiatus',
    paused: 'hiatus',
    cancelled: 'cancelled',
    canceled: 'cancelled',
    dropped: 'cancelled',
    unknown: 'unknown',
    '': 'unknown'
  };

  var STATUS_LABEL = {
    ongoing: 'Ongoing',
    completed: 'Completed',
    hiatus: 'Hiatus',
    cancelled: 'Cancelled',
    unknown: 'Unknown'
  };

  function normalizeStatus(raw) {
    var s = str(raw).toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    var key = STATUS_MAP[s] || STATUS_MAP[s.replace(/\s/g, '_')] || 'unknown';
    return { status: key, label: STATUS_LABEL[key] || 'Unknown' };
  }

  // ---- year / publication --------------------------------------------------

  function normalizeYear(raw) {
    if (raw == null || raw === '') return null;
    if (typeof raw === 'number' && isFinite(raw)) {
      var n = Math.floor(raw);
      if (n >= 1800 && n <= 2100) return n;
      return null;
    }
    var s = str(raw);
    var m = /(\d{4})/.exec(s);
    if (m) {
      var y = parseInt(m[1], 10);
      if (y >= 1800 && y <= 2100) return y;
    }
    return null;
  }

  // ---- authors / artists ---------------------------------------------------

  function normalizePeople(raw) {
    if (raw == null) return [];
    if (typeof raw === 'string') {
      return uniqueStrings(raw.split(/\s*[,;/|]\s*|\s+&\s+|\s+and\s+/i), MAX_LIST);
    }
    if (Array.isArray(raw)) {
      var flat = [];
      for (var i = 0; i < raw.length; i++) {
        var item = raw[i];
        if (typeof item === 'string' || typeof item === 'number') flat.push(item);
        else if (isObj(item)) flat.push(item.name || item.author || item.artist || item.value || '');
      }
      return uniqueStrings(flat, MAX_LIST);
    }
    if (isObj(raw)) return uniqueStrings([raw.name || raw.author || raw.artist || ''], MAX_LIST);
    return [];
  }

  // ---- genres / tags -------------------------------------------------------

  function normalizeTags(raw) {
    if (raw == null) return [];
    if (typeof raw === 'string') return uniqueStrings(raw.split(/\s*[,;/|]\s*/), MAX_LIST);
    if (Array.isArray(raw)) {
      var flat = [];
      for (var i = 0; i < raw.length; i++) {
        var item = raw[i];
        if (typeof item === 'string' || typeof item === 'number') flat.push(item);
        else if (isObj(item)) flat.push(item.name || item.tag || item.genre || item.label || '');
      }
      return uniqueStrings(flat, MAX_LIST);
    }
    return [];
  }

  // ---- description sanitization --------------------------------------------

  /**
   * Strip dangerous HTML while preserving basic line breaks.
   * Returns plain text. Callers must still escape when inserting into HTML.
   */
  function sanitizeDescription(raw) {
    var s = str(raw);
    if (!s) return '';
    s = s
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/gi, "'");
    s = s.replace(/<\s*(script|style|iframe|object|embed)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
    s = s.replace(/<\s*br\s*\/?\s*>/gi, '\n');
    s = s.replace(/<\s*\/\s*p\s*>/gi, '\n');
    s = s.replace(/<\s*\/\s*div\s*>/gi, '\n');
    s = s.replace(/<\s*\/\s*li\s*>/gi, '\n');
    s = s.replace(/<[^>]+>/g, '');
    s = s.replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n');
    s = s.replace(/\n{3,}/g, '\n\n');
    s = s.replace(/[ \t]{2,}/g, ' ');
    s = s.trim();
    if (s.length > MAX_DESC) s = s.slice(0, MAX_DESC);
    return s;
  }

  function descriptionPreview(text, maxLen) {
    var t = str(text);
    var limit = maxLen || 180;
    if (t.length <= limit) return { text: t, truncated: false };
    var cut = t.slice(0, limit).replace(/\s+\S*$/, '');
    if (!cut) cut = t.slice(0, limit);
    return { text: cut + '\u2026', truncated: true };
  }

  // ---- cover ---------------------------------------------------------------

  function normalizeCover(raw) {
    var url = str(raw);
    if (!url) return null;
    var lower = url.toLowerCase();
    if (lower.indexOf('javascript:') === 0 || lower.indexOf('data:text') === 0) return null;
    return url;
  }

  // ---- source bindings (attribution only; never navigation) ----------------

  function normalizeSourceBindings(series) {
    var out = [];
    var seen = Object.create(null);
    function push(sourceId, remoteId, extra) {
      var sid = str(sourceId);
      var rid = str(remoteId);
      if (!sid && !rid) return;
      var key = sid + '\u001f' + rid;
      if (seen[key]) return;
      seen[key] = true;
      out.push({
        sourceId: sid || 'unknown',
        remoteId: rid || null,
        matchConfidence: extra && typeof extra.matchConfidence === 'number' ? extra.matchConfidence : null,
        readerAvailable: extra && extra.readerAvailable != null ? !!extra.readerAvailable : null
      });
    }
    if (!isObj(series)) return out;
    if (Array.isArray(series.sourceMappings)) {
      for (var i = 0; i < series.sourceMappings.length; i++) {
        var m = series.sourceMappings[i];
        if (!isObj(m)) continue;
        push(m.sourceId || m.type, m.remoteId, m);
      }
    }
    if (isObj(series.source)) {
      push(series.source.type || series.source.sourceId, series.source.remoteId, series.source);
    }
    if (Array.isArray(series.altSources)) {
      for (var j = 0; j < series.altSources.length; j++) {
        var a = series.altSources[j];
        if (!isObj(a)) continue;
        push(a.sourceId || a.type, a.remoteId, a);
      }
    }
    return out;
  }

  // ---- chapter read state --------------------------------------------------

  function chapterReadState(chapter, series, seriesProgress) {
    var cid = str(chapter && chapter.id);
    if (!cid) return 'unread';
    if (isObj(seriesProgress) && isObj(seriesProgress[cid])) {
      var rec = seriesProgress[cid];
      if (rec.completed === true) return 'completed';
      if (typeof rec.page === 'number' && rec.page > 0) return 'started';
      if (rec.completed === false && typeof rec.page === 'number') return 'started';
    }
    if (isObj(series) && isObj(series.readChapters) && series.readChapters[cid]) {
      return 'completed';
    }
    return 'unread';
  }

  // ---- Continue Reading ----------------------------------------------------

  function resolveContinueTarget(orderedChapters, series, seriesProgress) {
    var chapters = Array.isArray(orderedChapters) ? orderedChapters : [];
    if (!chapters.length) {
      return { kind: 'empty', label: 'No chapters available', chapterId: null, chapter: null };
    }

    var bestStarted = null;
    var bestStartedAt = -1;
    var firstUnread = null;
    var allCompleted = true;

    for (var i = 0; i < chapters.length; i++) {
      var ch = chapters[i];
      var st = chapterReadState(ch, series, seriesProgress);
      if (st !== 'completed') allCompleted = false;
      if (st === 'started') {
        var rec = isObj(seriesProgress) && isObj(seriesProgress[ch.id]) ? seriesProgress[ch.id] : null;
        var ts = rec && typeof rec.updatedAt === 'number' ? rec.updatedAt : 0;
        if (ts >= bestStartedAt) {
          bestStartedAt = ts;
          bestStarted = ch;
        }
      }
      if (st === 'unread' && !firstUnread) firstUnread = ch;
    }

    if (bestStarted) {
      var num = str(bestStarted.chapter) || str(bestStarted.title) || '';
      return {
        kind: 'continue',
        label: num ? ('Continue Chapter ' + num) : 'Continue Reading',
        chapterId: bestStarted.id || null,
        chapter: bestStarted
      };
    }
    if (firstUnread) {
      var n2 = str(firstUnread.chapter) || str(firstUnread.title) || '';
      var anyProgress = isObj(seriesProgress) && Object.keys(seriesProgress).length > 0;
      return {
        kind: anyProgress ? 'next' : 'start',
        label: anyProgress
          ? (n2 ? ('Continue Chapter ' + n2) : 'Continue Reading')
          : (n2 ? ('Start Chapter ' + n2) : 'Start Reading'),
        chapterId: firstUnread.id || null,
        chapter: firstUnread
      };
    }
    if (allCompleted) {
      return { kind: 'finished', label: 'All chapters completed', chapterId: null, chapter: null };
    }
    return {
      kind: 'start',
      label: 'Start Reading',
      chapterId: chapters[0].id || null,
      chapter: chapters[0]
    };
  }

  // ---- chapter list rows ---------------------------------------------------

  function buildChapterRows(series, seriesProgress) {
    var raw = Array.isArray(series && series.chapters) ? series.chapters.slice() : [];
    var ordered;
    if (chapterOrder.sortChapters) {
      ordered = chapterOrder.sortChapters(raw, series);
    } else if (chapterOrder.compareChapters) {
      ordered = raw.slice().sort(function (a, b) {
        return chapterOrder.compareChapters(a, b, series);
      });
    } else {
      ordered = raw;
    }

    var seenCanon = Object.create(null);
    var rows = [];
    for (var i = 0; i < ordered.length; i++) {
      var ch = ordered[i];
      if (!isObj(ch)) continue;
      var ident = identity.getChapterIdentity(ch, series);
      var dedupeKey = ident.canonicalChapterId || ('local:' + (ident.localId || i));
      if (seenCanon[dedupeKey]) continue;
      seenCanon[dedupeKey] = true;

      var readState = chapterReadState(ch, series, seriesProgress);
      rows.push({
        id: ident.localId || str(ch.id) || null,
        canonicalChapterId: ident.canonicalChapterId,
        number: str(ch.chapter) || (ident.structured && ident.structured.number) || null,
        volume: str(ch.volume) || (ident.structured && ident.structured.volume) || null,
        title: str(ch.title) || null,
        releaseDate: str(ch.publishedAt || ch.releaseDate || ch.date) || null,
        sourceIds: (ident.sources || []).map(function (b) { return b.sourceId; }),
        readState: readState,
        remoteId: str(ch.remoteId) || null
      });
    }
    return rows;
  }

  // ---- metadata normalization ----------------------------------------------

  function normalizeMetadata(series) {
    var s = isObj(series) ? series : {};
    var statusInfo = normalizeStatus(s.status || s.publicationStatus);
    var authors = normalizePeople(s.authors != null ? s.authors : s.author);
    var artists = normalizePeople(s.artists != null ? s.artists : s.artist);
    var genres = normalizeTags(s.genres != null ? s.genres : s.genre);
    var tags = normalizeTags(s.tags != null ? s.tags : s.tag);
    var year = normalizeYear(s.year != null ? s.year : s.publishedYear || s.publicationYear);
    var description = sanitizeDescription(s.description || s.synopsis || s.summary || '');
    var cover = normalizeCover(s.cover || s.coverUrl || s.thumbnail);
    var title = clip(s.title || s.name, 500) || 'Untitled';
    var alternateTitles = uniqueStrings(
      Array.isArray(s.alternateTitles) ? s.alternateTitles
        : (s.altTitles || s.titles || []),
      20
    ).filter(function (t) { return t.toLowerCase() !== title.toLowerCase(); });

    return {
      title: title,
      alternateTitles: alternateTitles,
      cover: cover,
      description: description,
      authors: authors,
      artists: artists,
      status: statusInfo.status,
      statusLabel: statusInfo.label,
      year: year,
      genres: genres,
      tags: tags,
      language: str(s.language || s.lang) || null
    };
  }

  function resolveLibraryState(series, options) {
    options = options || {};
    if (!isObj(series) || !str(series.id)) {
      return { inLibrary: false, state: 'not_in_library', canAdd: true, canRemove: false };
    }
    if (options.adding === true) {
      return { inLibrary: false, state: 'adding', canAdd: false, canRemove: false };
    }
    return {
      inLibrary: true,
      state: 'in_library',
      canAdd: false,
      canRemove: true
    };
  }

  // ---- main view model -----------------------------------------------------

  /**
   * Build the canonical Details view model.
   *
   * @param {object} series - library series record
   * @param {object} [ctx]
   * @param {object} [ctx.seriesProgress] - state.progress[seriesId]
   * @param {boolean} [ctx.adding]
   * @param {string}  [ctx.metadataState]
   * @param {string}  [ctx.chapterState]
   * @param {number}  [ctx.updatedAt]
   */
  function buildDetailsViewModel(series, ctx) {
    ctx = ctx || {};
    if (!isObj(series)) {
      return {
        ok: false,
        error: 'not_found',
        message: 'Manga not found',
        canonicalSeriesId: null,
        localId: null
      };
    }

    var seriesIdent = identity.getSeriesIdentity(series);
    var meta = normalizeMetadata(series);
    var bindings = normalizeSourceBindings(series);
    var libraryState = resolveLibraryState(series, { adding: ctx.adding });
    var seriesProgress = isObj(ctx.seriesProgress) ? ctx.seriesProgress : null;
    var chapterRows = buildChapterRows(series, seriesProgress);
    var byId = Object.create(null);
    (Array.isArray(series.chapters) ? series.chapters : []).forEach(function (c) {
      if (c && c.id) byId[c.id] = c;
    });
    var orderedObjs = chapterRows.map(function (r) {
      return byId[r.id] || { id: r.id, chapter: r.number, title: r.title };
    });
    var continueTarget = resolveContinueTarget(orderedObjs, series, seriesProgress);

    var readingState = {
      hasProgress: !!(seriesProgress && Object.keys(seriesProgress).length),
      continue: continueTarget,
      completedCount: chapterRows.filter(function (r) { return r.readState === 'completed'; }).length,
      startedCount: chapterRows.filter(function (r) { return r.readState === 'started'; }).length,
      totalChapters: chapterRows.length
    };

    return {
      ok: true,
      error: null,
      message: null,
      localId: seriesIdent.localId || str(series.id) || null,
      canonicalSeriesId: seriesIdent.canonicalId || null,
      title: meta.title,
      alternateTitles: meta.alternateTitles,
      cover: meta.cover,
      description: meta.description,
      authors: meta.authors,
      artists: meta.artists,
      status: meta.status,
      statusLabel: meta.statusLabel,
      year: meta.year,
      genres: meta.genres,
      tags: meta.tags,
      language: meta.language,
      sourceBindings: bindings,
      libraryState: libraryState,
      readingState: readingState,
      chapters: chapterRows,
      metadataState: ctx.metadataState || 'ready',
      chapterState: ctx.chapterState || 'ready',
      updatedAt: typeof ctx.updatedAt === 'number' ? ctx.updatedAt
        : (typeof series.updatedAt === 'number' ? series.updatedAt : null)
    };
  }

  /**
   * Merge chapter lists deterministically for refresh.
   * Preserves local chapter.id, read state, and canonical identity when matched.
   * Does not delete local chapters that disappeared from the remote list.
   */
  function mergeChapterLists(existingChapters, incomingChapters, series) {
    var existing = Array.isArray(existingChapters) ? existingChapters : [];
    var incoming = Array.isArray(incomingChapters) ? incomingChapters : [];
    var byCanon = Object.create(null);
    var byLocal = Object.create(null);
    var byRemote = Object.create(null);

    existing.forEach(function (ch, idx) {
      if (!isObj(ch)) return;
      var ident = identity.getChapterIdentity(ch, series);
      if (ident.canonicalChapterId) byCanon[ident.canonicalChapterId] = { ch: ch, idx: idx };
      if (ident.localId) byLocal[ident.localId] = { ch: ch, idx: idx };
      (ident.sources || []).forEach(function (b) {
        if (b.bindingKey) byRemote[b.bindingKey] = { ch: ch, idx: idx };
        else if (b.sourceId && b.remoteId) {
          byRemote[b.sourceId + '\u001f' + b.remoteId] = { ch: ch, idx: idx };
        }
      });
      if (str(ch.remoteId) && isObj(series) && series.source && series.source.type) {
        byRemote[str(series.source.type) + '\u001f' + str(ch.remoteId)] = { ch: ch, idx: idx };
      }
    });

    var merged = existing.map(function (ch) {
      return isObj(ch) ? Object.assign({}, ch) : ch;
    });
    var matchedExisting = Object.create(null);

    incoming.forEach(function (inc) {
      if (!isObj(inc)) return;
      var ident = identity.getChapterIdentity(inc, series);
      var hit = null;
      if (ident.canonicalChapterId && byCanon[ident.canonicalChapterId]) {
        hit = byCanon[ident.canonicalChapterId];
      } else if (ident.localId && byLocal[ident.localId]) {
        hit = byLocal[ident.localId];
      } else {
        for (var si = 0; si < (ident.sources || []).length; si++) {
          var b = ident.sources[si];
          var k = b.bindingKey || (b.sourceId + '\u001f' + b.remoteId);
          if (byRemote[k]) { hit = byRemote[k]; break; }
        }
      }
      if (hit && !matchedExisting[hit.idx]) {
        matchedExisting[hit.idx] = true;
        var base = merged[hit.idx];
        if (str(inc.title) && !str(base.title)) base.title = str(inc.title);
        if (str(inc.chapter) && (base.chapter == null || base.chapter === '')) base.chapter = inc.chapter;
        if (str(inc.volume) && !str(base.volume)) base.volume = inc.volume;
        if (str(inc.remoteId) && !str(base.remoteId)) base.remoteId = inc.remoteId;
        if (str(inc.publishedAt) && !str(base.publishedAt)) base.publishedAt = inc.publishedAt;
        var srcMap = Object.create(null);
        (Array.isArray(base.sources) ? base.sources : []).forEach(function (s) {
          if (s && s.sourceId) srcMap[s.sourceId + '\u001f' + str(s.remoteId)] = s;
        });
        (Array.isArray(inc.sources) ? inc.sources : []).forEach(function (s) {
          if (!s || !s.sourceId) return;
          var key = s.sourceId + '\u001f' + str(s.remoteId);
          if (!srcMap[key]) srcMap[key] = s;
        });
        base.sources = Object.keys(srcMap).map(function (k) { return srcMap[k]; });
        if (ident.canonicalChapterId && !base.canonicalChapterId) {
          base.canonicalChapterId = ident.canonicalChapterId;
        }
      } else if (!hit) {
        var copy = Object.assign({}, inc);
        if (ident.canonicalChapterId) copy.canonicalChapterId = ident.canonicalChapterId;
        merged.push(copy);
      }
    });

    return merged;
  }

  /**
   * Merge metadata with deterministic precedence:
   * existing non-empty local fields win; incoming fills gaps only.
   */
  function mergeMetadata(existingSeries, incomingMeta) {
    var base = isObj(existingSeries) ? Object.assign({}, existingSeries) : {};
    var inc = isObj(incomingMeta) ? incomingMeta : {};
    var normInc = normalizeMetadata(inc);
    var normBase = normalizeMetadata(base);

    function prefer(localVal, incomingVal) {
      if (localVal != null && localVal !== '' && !(Array.isArray(localVal) && !localVal.length)) {
        return localVal;
      }
      return incomingVal;
    }

    base.title = prefer(normBase.title !== 'Untitled' ? normBase.title : '', normInc.title) || base.title || 'Untitled';
    base.description = prefer(normBase.description, normInc.description);
    base.cover = prefer(normBase.cover, normInc.cover);
    base.status = prefer(normBase.status !== 'unknown' ? base.status : '', inc.status || normInc.status);
    base.year = prefer(normBase.year, normInc.year);
    base.authors = (normBase.authors && normBase.authors.length) ? normBase.authors : normInc.authors;
    base.artists = (normBase.artists && normBase.artists.length) ? normBase.artists : normInc.artists;
    base.genres = (normBase.genres && normBase.genres.length) ? normBase.genres : normInc.genres;
    base.tags = (normBase.tags && normBase.tags.length) ? normBase.tags : normInc.tags;
    if (normInc.alternateTitles && normInc.alternateTitles.length) {
      base.alternateTitles = uniqueStrings(
        (normBase.alternateTitles || []).concat(normInc.alternateTitles),
        20
      );
    }
    return base;
  }

  function displayFallback(field, value) {
    if (value != null && value !== '' && !(Array.isArray(value) && !value.length)) return value;
    var map = {
      description: 'No description available',
      author: 'Unknown',
      authors: 'Unknown',
      artist: 'Unknown',
      artists: 'Unknown',
      status: 'Unknown',
      year: 'Not available',
      genres: [],
      tags: [],
      cover: null
    };
    return map[field] != null ? map[field] : 'Not available';
  }

  return {
    normalizeStatus: normalizeStatus,
    normalizeYear: normalizeYear,
    normalizePeople: normalizePeople,
    normalizeTags: normalizeTags,
    sanitizeDescription: sanitizeDescription,
    descriptionPreview: descriptionPreview,
    normalizeCover: normalizeCover,
    normalizeMetadata: normalizeMetadata,
    normalizeSourceBindings: normalizeSourceBindings,
    chapterReadState: chapterReadState,
    resolveContinueTarget: resolveContinueTarget,
    buildChapterRows: buildChapterRows,
    buildDetailsViewModel: buildDetailsViewModel,
    mergeChapterLists: mergeChapterLists,
    mergeMetadata: mergeMetadata,
    displayFallback: displayFallback,
    uniqueStrings: uniqueStrings
  };
});
