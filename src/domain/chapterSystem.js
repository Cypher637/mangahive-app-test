'use strict';
/**
 * MangaHive Phase 1 / Stage 4 — Chapter System (authoritative chapter domain).
 *
 * One normalized chapter representation between source adapters and Details/Reader.
 * Pure: no DOM, no network, no storage writes. Does not replace chapter.id.
 *
 * Pipeline:
 *   source response → normalize → identity → dedupe → merge → order → progress → open contract
 *
 * Depends on: identity, chapterOrder, progress (optional for read-state helpers).
 * Loading: classic <script> (MangaHiveDomain.chapterSystem) and CommonJS (tests).
 */
(function (root, factory) {
  var identity = (typeof require === 'function' && typeof module === 'object' && module && module.exports)
    ? require('./identity.js')
    : (root.MangaHiveDomain && root.MangaHiveDomain.identity);
  var chapterOrder = (typeof require === 'function' && typeof module === 'object' && module && module.exports)
    ? require('./chapterOrder.js')
    : (root.MangaHiveDomain && root.MangaHiveDomain.chapterOrder);
  var progressMod = (typeof require === 'function' && typeof module === 'object' && module && module.exports)
    ? (function () { try { return require('./progress.js'); } catch (e) { return null; } })()
    : (root.MangaHiveDomain && root.MangaHiveDomain.progress);
  var api = factory(identity, chapterOrder, progressMod);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.MangaHiveDomain = root.MangaHiveDomain || {};
  root.MangaHiveDomain.chapterSystem = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function (identity, chapterOrder, progressMod) {
  if (!identity) throw new Error('MangaHiveDomain.identity must be loaded before chapterSystem');
  if (!chapterOrder) throw new Error('MangaHiveDomain.chapterOrder must be loaded before chapterSystem');

  var MAX_TITLE = 500;
  var MAX_SOURCES = 32;

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

  function ts(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number' && isFinite(v) && v >= 0) return Math.floor(v);
    if (typeof v === 'string') {
      var n = Date.parse(v);
      if (isFinite(n) && n >= 0) return n;
      var num = Number(v);
      if (isFinite(num) && num >= 0) return Math.floor(num);
    }
    return null;
  }

  // ---- source binding ------------------------------------------------------

  /**
   * Normalize a single source binding on a chapter.
   * Never includes navigational URLs.
   */
  function normalizeSourceBinding(raw, defaults) {
    defaults = defaults || {};
    if (!isObj(raw) && typeof raw !== 'string') {
      if (!defaults.sourceId && !defaults.remoteId) return null;
      return {
        sourceId: str(defaults.sourceId) || 'unknown',
        remoteId: str(defaults.remoteId) || null,
        language: str(defaults.language) || null,
        available: defaults.available != null ? !!defaults.available : true,
        chapter: defaults.chapter != null ? str(defaults.chapter) : null
      };
    }
    var o = isObj(raw) ? raw : { remoteId: raw };
    var sourceId = str(o.sourceId || o.type || defaults.sourceId) || 'unknown';
    var remoteId = str(o.remoteId || o.id || defaults.remoteId) || null;
    if (!sourceId && !remoteId) return null;
    return {
      sourceId: sourceId,
      remoteId: remoteId,
      language: str(o.language || o.lang || defaults.language) || null,
      available: o.available != null ? !!o.available : (defaults.available != null ? !!defaults.available : true),
      chapter: o.chapter != null ? str(o.chapter) : (defaults.chapter != null ? str(defaults.chapter) : null)
    };
  }

  function mergeSourceBindings(existing, incoming) {
    var map = Object.create(null);
    function key(b) {
      return str(b.sourceId) + '\u001f' + str(b.remoteId);
    }
    (Array.isArray(existing) ? existing : []).forEach(function (b) {
      if (!b) return;
      var k = key(b);
      if (k !== '\u001f') map[k] = b;
    });
    (Array.isArray(incoming) ? incoming : []).forEach(function (b) {
      if (!b) return;
      var nb = normalizeSourceBinding(b);
      if (!nb) return;
      var k = key(nb);
      if (k === '\u001f') return;
      if (!map[k]) {
        map[k] = nb;
      } else {
        // enrich without wiping
        var cur = map[k];
        if (!cur.language && nb.language) cur.language = nb.language;
        if (nb.available === true) cur.available = true;
        if (!cur.chapter && nb.chapter) cur.chapter = nb.chapter;
      }
    });
    return Object.keys(map).map(function (k) { return map[k]; }).slice(0, MAX_SOURCES);
  }

  // ---- normalize single chapter from source / local ------------------------

  /**
   * Normalize a raw chapter (source adapter or library record) into the
   * Stage 4 chapter model. Preserves existing chapter.id when present.
   */
  function normalizeChapter(raw, series, options) {
    options = options || {};
    var c = isObj(raw) ? raw : {};
    var seriesId = str(series && series.id) || str(options.seriesId) || null;
    var seriesIdent = series ? identity.getSeriesIdentity(series) : { localId: seriesId, canonicalId: null };

    var numberText = '';
    if (c.chapter != null && c.chapter !== '') numberText = str(c.chapter);
    else if (c.number != null && c.number !== '') numberText = str(c.number);
    else if (c.chapterNumber != null) numberText = str(c.chapterNumber);

    var structure = identity.extractChapterStructure({
      chapter: numberText || c.chapter,
      volume: c.volume,
      title: c.title
    });

    var bindings = [];
    if (Array.isArray(c.sources)) {
      c.sources.forEach(function (s) {
        var b = normalizeSourceBinding(s, {
          chapter: numberText,
          language: c.language || c.lang
        });
        if (b) bindings.push(b);
      });
    }
    // single remoteId + series primary source
    if (str(c.remoteId)) {
      var primarySource = str(
        options.sourceId ||
        (series && series.source && (series.source.type || series.source.sourceId)) ||
        ''
      );
      if (primarySource) {
        bindings = mergeSourceBindings(bindings, [{
          sourceId: primarySource,
          remoteId: str(c.remoteId),
          chapter: numberText,
          language: c.language || c.lang,
          available: c.available != null ? c.available : true
        }]);
      }
    }
    if (options.sourceId && options.remoteId) {
      bindings = mergeSourceBindings(bindings, [{
        sourceId: options.sourceId,
        remoteId: options.remoteId,
        chapter: numberText,
        language: options.language,
        available: true
      }]);
    }

    var localId = str(c.id) || null;
    var existingCanon = typeof c.canonicalChapterId === 'string' ? c.canonicalChapterId : '';
    var ident = identity.getChapterIdentity({
      id: localId,
      chapter: numberText,
      volume: c.volume,
      title: c.title,
      remoteId: c.remoteId,
      sources: bindings,
      canonicalChapterId: existingCanon || undefined
    }, series);

    var available = true;
    if (c.available === false || c.unavailable === true) available = false;
    if (bindings.length && bindings.every(function (b) { return b.available === false; })) available = false;

    var pageCount = 0;
    if (Array.isArray(c.pages)) pageCount = c.pages.length;
    else if (typeof c.pageCount === 'number' && isFinite(c.pageCount)) pageCount = Math.max(0, Math.floor(c.pageCount));

    return {
      // local compatibility id — never mass-migrated
      id: localId,
      canonicalChapterId: ident.canonicalChapterId,
      canonicalSeriesId: seriesIdent.canonicalId || null,
      seriesId: seriesIdent.localId || seriesId,
      number: structure.number || null,
      numberText: numberText || null,
      volume: str(c.volume) || structure.volume || null,
      title: clip(c.title, MAX_TITLE) || null,
      publishedAt: ts(c.publishedAt || c.releaseDate || c.date || c.createdAt),
      language: str(c.language || c.lang) || null,
      pages: Array.isArray(c.pages) ? c.pages : [],
      pageCount: pageCount,
      sourceBindings: bindings,
      primarySourceId: bindings.length ? bindings[0].sourceId : null,
      remoteId: str(c.remoteId) || (bindings[0] && bindings[0].remoteId) || null,
      available: available,
      // progress/readState attached later by attachProgress
      readState: null,
      progress: null,
      // pass-through fields used by app (downloads, remote pages flag)
      remotePages: c.remotePages != null ? !!c.remotePages : (pageCount === 0 && !!str(c.remoteId)),
      processing: !!c.processing,
      // identity meta
      identityConfidence: ident.confidence,
      instanceKey: ident.instanceKey
    };
  }

  function normalizeChapterList(rawList, series, options) {
    var list = Array.isArray(rawList) ? rawList : [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      if (!isObj(list[i]) && list[i] == null) continue;
      out.push(normalizeChapter(list[i], series, options));
    }
    return out;
  }

  // ---- deduplication -------------------------------------------------------

  /**
   * Conservative dedupe. Match order:
   * 1. canonicalChapterId
   * 2. local id
   * 3. sourceId + remoteId binding
   * Does NOT merge solely on title or number.
   */
  function dedupeChapters(chapters, series) {
    var list = Array.isArray(chapters) ? chapters : [];
    var seenCanon = Object.create(null);
    var seenLocal = Object.create(null);
    var seenRemote = Object.create(null);
    var out = [];

    for (var i = 0; i < list.length; i++) {
      var ch = list[i];
      if (!isObj(ch)) continue;
      var ident = identity.getChapterIdentity(ch, series);
      var cid = ident.canonicalChapterId;
      var lid = ident.localId || str(ch.id);
      var remoteKeys = [];
      (ident.sources || ch.sourceBindings || []).forEach(function (b) {
        if (!b) return;
        var sid = str(b.sourceId);
        var rid = str(b.remoteId);
        if (sid && rid) remoteKeys.push(sid + '\u001f' + rid);
      });
      if (!remoteKeys.length && str(ch.remoteId)) {
        var ps = str(ch.primarySourceId || (series && series.source && series.source.type));
        if (ps) remoteKeys.push(ps + '\u001f' + str(ch.remoteId));
      }

      var hit = null;
      if (cid && seenCanon[cid] != null) hit = seenCanon[cid];
      else if (lid && seenLocal[lid] != null) hit = seenLocal[lid];
      else {
        for (var r = 0; r < remoteKeys.length; r++) {
          if (seenRemote[remoteKeys[r]] != null) { hit = seenRemote[remoteKeys[r]]; break; }
        }
      }

      if (hit != null) {
        // merge bindings into existing entry
        var existing = out[hit];
        existing.sourceBindings = mergeSourceBindings(
          existing.sourceBindings || existing.sources,
          ch.sourceBindings || ch.sources || []
        );
        if (!existing.title && ch.title) existing.title = ch.title;
        if (!existing.volume && ch.volume) existing.volume = ch.volume;
        if ((existing.numberText == null || existing.numberText === '') && ch.numberText) {
          existing.numberText = ch.numberText;
        }
        if (ch.available === true) existing.available = true;
        continue;
      }

      var idx = out.length;
      out.push(ch);
      if (cid) seenCanon[cid] = idx;
      if (lid) seenLocal[lid] = idx;
      remoteKeys.forEach(function (k) { seenRemote[k] = idx; });
    }
    return out;
  }

  // ---- merge (refresh) -----------------------------------------------------

  function preferString(localVal, incomingVal) {
    if (localVal != null && localVal !== '') return localVal;
    return incomingVal != null && incomingVal !== '' ? incomingVal : localVal;
  }

  /**
   * Deterministic merge of existing library chapters with incoming normalized chapters.
   * Preserves local id, progress linkage, and good metadata. Does not delete locals
   * that disappeared from the incoming feed.
   */
  function mergeChapters(existingChapters, incomingChapters, series) {
    var existing = Array.isArray(existingChapters) ? existingChapters : [];
    var incoming = Array.isArray(incomingChapters) ? incomingChapters : [];

    var byCanon = Object.create(null);
    var byLocal = Object.create(null);
    var byRemote = Object.create(null);

    existing.forEach(function (ch, idx) {
      if (!isObj(ch)) return;
      var ident = identity.getChapterIdentity(ch, series);
      if (ident.canonicalChapterId) byCanon[ident.canonicalChapterId] = idx;
      if (ident.localId) byLocal[ident.localId] = idx;
      (ident.sources || []).forEach(function (b) {
        var k = (b.bindingKey) || (str(b.sourceId) + '\u001f' + str(b.remoteId));
        if (k && k !== '\u001f') byRemote[k] = idx;
      });
      var bindings = ch.sourceBindings || ch.sources;
      if (Array.isArray(bindings)) {
        bindings.forEach(function (b) {
          if (!b) return;
          var k2 = str(b.sourceId) + '\u001f' + str(b.remoteId);
          if (k2 !== '\u001f') byRemote[k2] = idx;
        });
      }
      if (str(ch.remoteId) && series && series.source && series.source.type) {
        byRemote[str(series.source.type) + '\u001f' + str(ch.remoteId)] = idx;
      }
    });

    var merged = existing.map(function (ch) {
      return isObj(ch) ? Object.assign({}, ch) : ch;
    });
    var matched = Object.create(null);

    incoming.forEach(function (inc) {
      if (!isObj(inc)) return;
      // ensure normalized-ish
      var norm = inc.sourceBindings ? inc : normalizeChapter(inc, series);
      var ident = identity.getChapterIdentity(norm, series);
      var hit = null;
      if (ident.canonicalChapterId && byCanon[ident.canonicalChapterId] != null) {
        hit = byCanon[ident.canonicalChapterId];
      } else if (ident.localId && byLocal[ident.localId] != null) {
        hit = byLocal[ident.localId];
      } else {
        var keys = [];
        (ident.sources || []).forEach(function (b) {
          keys.push((b.bindingKey) || (str(b.sourceId) + '\u001f' + str(b.remoteId)));
        });
        (norm.sourceBindings || []).forEach(function (b) {
          keys.push(str(b.sourceId) + '\u001f' + str(b.remoteId));
        });
        if (str(norm.remoteId) && norm.primarySourceId) {
          keys.push(str(norm.primarySourceId) + '\u001f' + str(norm.remoteId));
        }
        for (var i = 0; i < keys.length; i++) {
          if (keys[i] && keys[i] !== '\u001f' && byRemote[keys[i]] != null) {
            hit = byRemote[keys[i]];
            break;
          }
        }
      }

      if (hit != null && !matched[hit]) {
        matched[hit] = true;
        var base = merged[hit];
        // preserve local id
        base.title = preferString(base.title, norm.title);
        base.volume = preferString(base.volume, norm.volume);
        if ((base.chapter == null || base.chapter === '') && (norm.numberText || norm.chapter)) {
          base.chapter = norm.numberText || norm.chapter;
        }
        if (norm.numberText && !base.numberText) base.numberText = norm.numberText;
        if (norm.publishedAt && !base.publishedAt) base.publishedAt = norm.publishedAt;
        if (norm.language && !base.language) base.language = norm.language;
        if (str(norm.remoteId) && !str(base.remoteId)) base.remoteId = norm.remoteId;
        if (ident.canonicalChapterId && !base.canonicalChapterId) {
          base.canonicalChapterId = ident.canonicalChapterId;
        }
        base.sources = mergeSourceBindings(base.sources || base.sourceBindings, norm.sourceBindings || norm.sources);
        base.sourceBindings = base.sources;
        if (norm.available === true) base.available = true;
        if (norm.available === false && base.available == null) base.available = false;
      } else if (hit == null) {
        var copy = Object.assign({}, norm);
        // keep id if incoming had one; caller may assign uid for brand-new
        if (ident.canonicalChapterId) copy.canonicalChapterId = ident.canonicalChapterId;
        if (copy.sources && !copy.sourceBindings) copy.sourceBindings = copy.sources;
        if (copy.sourceBindings && !copy.sources) copy.sources = copy.sourceBindings;
        if (copy.numberText && (copy.chapter == null || copy.chapter === '')) {
          copy.chapter = copy.numberText;
        }
        merged.push(copy);
        var newIdx = merged.length - 1;
        if (ident.canonicalChapterId) byCanon[ident.canonicalChapterId] = newIdx;
        if (ident.localId) byLocal[ident.localId] = newIdx;
      }
    });

    return merged;
  }

  // ---- ordering ------------------------------------------------------------

  function orderChapters(chapters, direction) {
    var sorted = chapterOrder.sortChapters(Array.isArray(chapters) ? chapters : []);
    if (direction === 'desc' || direction === 'descending') {
      return sorted.slice().reverse();
    }
    return sorted;
  }

  // ---- progress / read state -----------------------------------------------

  function chapterReadState(chapter, series, seriesProgress) {
    var cid = str(chapter && chapter.id);
    if (!cid) return 'unread';
    if (isObj(seriesProgress) && isObj(seriesProgress[cid])) {
      var rec = seriesProgress[cid];
      if (rec.completed === true) return 'completed';
      if (typeof rec.page === 'number' && rec.page > 0) return 'started';
      if (typeof rec.pageIndex === 'number' && rec.pageIndex > 0) return 'started';
      if (rec.completed === false && (typeof rec.page === 'number' || typeof rec.pageIndex === 'number')) {
        return 'started';
      }
    }
    // legacy series-level progress shape: { chapterId, pageIndex }
    if (isObj(seriesProgress) && str(seriesProgress.chapterId) === cid) {
      if (typeof seriesProgress.pageIndex === 'number' && seriesProgress.pageIndex > 0) return 'started';
    }
    if (isObj(series) && isObj(series.readChapters) && series.readChapters[cid]) {
      return 'completed';
    }
    return 'unread';
  }

  function attachProgress(chapters, series, seriesProgress) {
    var list = Array.isArray(chapters) ? chapters : [];
    return list.map(function (ch) {
      if (!isObj(ch)) return ch;
      var next = Object.assign({}, ch);
      var state = chapterReadState(ch, series, seriesProgress);
      next.readState = state;
      var cid = str(ch.id);
      var rec = isObj(seriesProgress) && cid && isObj(seriesProgress[cid]) ? seriesProgress[cid] : null;
      if (rec) {
        next.progress = {
          page: typeof rec.page === 'number' ? rec.page
            : (typeof rec.pageIndex === 'number' ? rec.pageIndex : 0),
          total: typeof rec.total === 'number' ? rec.total
            : (typeof rec.pageCount === 'number' ? rec.pageCount : null),
          completed: !!rec.completed,
          updatedAt: typeof rec.updatedAt === 'number' ? rec.updatedAt : null
        };
      } else if (isObj(seriesProgress) && str(seriesProgress.chapterId) === cid) {
        next.progress = {
          page: seriesProgress.pageIndex || 0,
          total: null,
          completed: false,
          updatedAt: seriesProgress.updatedAt || null
        };
      } else {
        next.progress = null;
      }
      return next;
    });
  }

  /**
   * Authoritative continue-reading target for a series chapter list.
   * Does not mutate chapters. Completed chapters are never resume targets
   * while unread/started chapters remain.
   */
  function resolveContinueChapter(chapters, series, seriesProgress) {
    var ordered = orderChapters(chapters, 'asc');
    if (!ordered.length) {
      return { kind: 'empty', label: 'No chapters available', chapterId: null, chapter: null };
    }

    var withState = attachProgress(ordered, series, seriesProgress);
    var bestStarted = null;
    var bestStartedAt = -1;
    var firstUnread = null;
    var allCompleted = true;

    for (var i = 0; i < withState.length; i++) {
      var ch = withState[i];
      if (ch.readState !== 'completed') allCompleted = false;
      if (ch.readState === 'started') {
        var at = ch.progress && typeof ch.progress.updatedAt === 'number' ? ch.progress.updatedAt : 0;
        if (at >= bestStartedAt) {
          bestStartedAt = at;
          bestStarted = ch;
        }
      }
      if (ch.readState === 'unread' && !firstUnread) firstUnread = ch;
    }

    if (bestStarted) {
      var num = str(bestStarted.numberText || bestStarted.chapter || bestStarted.number || bestStarted.title);
      return {
        kind: 'continue',
        label: num ? ('Continue Chapter ' + num) : 'Continue Reading',
        chapterId: bestStarted.id || null,
        chapter: bestStarted
      };
    }
    if (firstUnread) {
      var n2 = str(firstUnread.numberText || firstUnread.chapter || firstUnread.number || firstUnread.title);
      var anyProgress = false;
      if (isObj(seriesProgress)) {
        if (seriesProgress.chapterId) anyProgress = true;
        else {
          for (var k in seriesProgress) {
            if (Object.prototype.hasOwnProperty.call(seriesProgress, k) && isObj(seriesProgress[k])) {
              anyProgress = true;
              break;
            }
          }
        }
      }
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
      chapterId: ordered[0].id || null,
      chapter: ordered[0]
    };
  }

  // ---- availability / open validation (Reader handoff) ---------------------

  /**
   * Validate that a chapter can be opened in-app.
   * Never suggests external redirects.
   */
  function validateOpenChapter(series, chapterRef, options) {
    options = options || {};
    if (!isObj(series) || !str(series.id)) {
      return { ok: false, reason: 'series_missing', message: 'Manga not found', chapter: null };
    }
    var chapters = Array.isArray(series.chapters) ? series.chapters : [];
    var chapter = null;
    var ref = chapterRef;

    if (isObj(ref)) {
      var wantLocal = str(ref.id || ref.chapterId || ref.localId);
      var wantCanon = str(ref.canonicalChapterId);
      for (var i = 0; i < chapters.length; i++) {
        var c = chapters[i];
        if (!c) continue;
        if (wantLocal && str(c.id) === wantLocal) { chapter = c; break; }
        if (wantCanon && str(c.canonicalChapterId) === wantCanon) { chapter = c; break; }
      }
      if (!chapter && wantLocal) {
        // identity module equality
        for (var j = 0; j < chapters.length; j++) {
          if (identity.isSameChapter(chapters[j], { id: wantLocal, canonicalChapterId: wantCanon }, series)) {
            chapter = chapters[j];
            break;
          }
        }
      }
    } else if (typeof ref === 'string' || typeof ref === 'number') {
      var id = str(ref);
      for (var k = 0; k < chapters.length; k++) {
        if (str(chapters[k].id) === id || str(chapters[k].canonicalChapterId) === id) {
          chapter = chapters[k];
          break;
        }
      }
    }

    if (!chapter) {
      return { ok: false, reason: 'chapter_missing', message: 'Chapter not found', chapter: null };
    }

    // belongs to series — already found on series.chapters
    if (chapter.available === false) {
      return {
        ok: false,
        reason: 'unavailable',
        message: 'Chapter unavailable',
        chapter: chapter
      };
    }

    var hasRemote = !!str(chapter.remoteId) ||
      (Array.isArray(chapter.sources) && chapter.sources.length) ||
      (Array.isArray(chapter.sourceBindings) && chapter.sourceBindings.length);
    var hasPages = (Array.isArray(chapter.pages) && chapter.pages.length > 0) ||
      (typeof chapter.pageCount === 'number' && chapter.pageCount > 0);

    if (!hasRemote && !hasPages && options.requirePages) {
      return {
        ok: false,
        reason: 'unavailable',
        message: 'Chapter unavailable',
        chapter: chapter
      };
    }

    return {
      ok: true,
      reason: null,
      message: null,
      chapter: chapter
    };
  }

  /**
   * Build a stable open-chapter navigation contract (no full chapter object).
   * Reader stage consumes this; Stage 4 only defines the boundary.
   */
  function createOpenChapterRequest(series, chapter, options) {
    options = options || {};
    var seriesIdent = identity.getSeriesIdentity(series);
    var chIdent = identity.getChapterIdentity(chapter, series);
    var validation = validateOpenChapter(series, chapter, options);
    if (!validation.ok) {
      return {
        ok: false,
        reason: validation.reason,
        message: validation.message,
        // still include ids for diagnostics — never external URLs
        seriesId: seriesIdent.localId || str(series && series.id) || null,
        canonicalSeriesId: seriesIdent.canonicalId || null,
        chapterId: chIdent.localId || str(chapter && chapter.id) || null,
        canonicalChapterId: chIdent.canonicalChapterId || null,
        pageIndex: 0
      };
    }
    var pageIndex = 0;
    if (typeof options.pageIndex === 'number' && options.pageIndex >= 0) {
      pageIndex = Math.floor(options.pageIndex);
    }
    return {
      ok: true,
      reason: null,
      message: null,
      seriesId: seriesIdent.localId || str(series.id),
      canonicalSeriesId: seriesIdent.canonicalId || null,
      chapterId: chIdent.localId || str(chapter.id),
      canonicalChapterId: chIdent.canonicalChapterId || null,
      pageIndex: pageIndex
      // intentionally no sourceUrl / external link
    };
  }

  // ---- list assembly (fetch pipeline result shape) -------------------------

  /**
   * Assemble a deterministic chapter list result from one or more source batches.
   * Used by the fetch service after adapters return.
   *
   * @param {object} series
   * @param {Array} batches - [{ sourceId, chapters, error?, partial? }]
   * @param {object} [options] - { seriesProgress, direction, existingChapters }
   */
  function assembleChapterList(series, batches, options) {
    options = options || {};
    var batchList = Array.isArray(batches) ? batches : [];
    var sourceResults = [];
    var allIncoming = [];

    batchList.forEach(function (batch) {
      if (!isObj(batch)) return;
      var sourceId = str(batch.sourceId) || 'unknown';
      if (batch.error) {
        sourceResults.push({
          sourceId: sourceId,
          ok: false,
          error: str(batch.error) || 'error',
          count: 0
        });
        return;
      }
      var norms = normalizeChapterList(batch.chapters || [], series, {
        sourceId: sourceId
      });
      sourceResults.push({
        sourceId: sourceId,
        ok: true,
        error: null,
        count: norms.length,
        partial: !!batch.partial,
        hasMore: !!batch.hasMore,
        nextCursor: batch.nextCursor != null ? batch.nextCursor : null
      });
      allIncoming = allIncoming.concat(norms);
    });

    var existing = Array.isArray(options.existingChapters)
      ? options.existingChapters
      : (Array.isArray(series && series.chapters) ? series.chapters : []);

    var merged = mergeChapters(existing, allIncoming, series);
    merged = dedupeChapters(merged, series);
    var ordered = orderChapters(merged, options.direction || 'asc');
    var withProgress = attachProgress(ordered, series, options.seriesProgress);
    var cont = resolveContinueChapter(withProgress, series, options.seriesProgress);

    var anyOk = sourceResults.some(function (r) { return r.ok; });
    var anyFail = sourceResults.some(function (r) { return !r.ok; });

    return {
      chapters: withProgress,
      continue: cont,
      sourceResults: sourceResults,
      status: !batchList.length ? 'empty'
        : (anyOk && anyFail ? 'partial'
          : (anyOk ? 'ok' : 'error')),
      total: withProgress.length
    };
  }

  /**
   * Idempotent refresh helper: merge incoming into existing and return stable list.
   */
  function refreshChapters(series, incomingChapters, options) {
    options = options || {};
    var existing = Array.isArray(series && series.chapters) ? series.chapters : [];
    var incoming = normalizeChapterList(incomingChapters, series, options);
    var merged = mergeChapters(existing, incoming, series);
    merged = dedupeChapters(merged, series);
    return orderChapters(merged, options.direction || 'asc');
  }

  /** True when two successive refreshes with same data yield same logical ids. */
  function chapterIdentitySnapshot(chapters, series) {
    return orderChapters(chapters, 'asc').map(function (ch) {
      var ident = identity.getChapterIdentity(ch, series);
      return (ident.canonicalChapterId || '') + '|' + (ident.localId || '') + '|' + str(ch.remoteId);
    });
  }

  return {
    normalizeSourceBinding: normalizeSourceBinding,
    mergeSourceBindings: mergeSourceBindings,
    normalizeChapter: normalizeChapter,
    normalizeChapterList: normalizeChapterList,
    dedupeChapters: dedupeChapters,
    mergeChapters: mergeChapters,
    orderChapters: orderChapters,
    chapterReadState: chapterReadState,
    attachProgress: attachProgress,
    resolveContinueChapter: resolveContinueChapter,
    validateOpenChapter: validateOpenChapter,
    createOpenChapterRequest: createOpenChapterRequest,
    assembleChapterList: assembleChapterList,
    refreshChapters: refreshChapters,
    chapterIdentitySnapshot: chapterIdentitySnapshot
  };
});
