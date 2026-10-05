/**
 * MangaHive(13) source-registry regression tests
 * Run: node source_registry_regression_test.js
 * Also validates architectural invariants in index.html
 */
"use strict";
const fs = require("fs");
const path = require("path");

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    failed++;
  } else {
    console.log("PASS:", msg);
  }
}

// --- Mirror app health helpers (must match index.html contract) ---
var sourceHealth = {};
function markSourceHealth(id, ok, error, latencyMs) {
  var prev = sourceHealth[id] || { consecutiveFailures: 0 };
  var fails = ok ? 0 : (prev.consecutiveFailures || 0) + 1;
  var cooldown = null;
  if (!ok && fails >= 3) {
    cooldown = Date.now() + Math.min(30 * 60 * 1000, 15000 * Math.pow(2, Math.min(fails - 3, 5)));
  }
  sourceHealth[id] = {
    status: ok ? "healthy" : fails >= 3 ? "offline" : "degraded",
    ok: !!ok,
    at: Date.now(),
    error: error ? String(error).slice(0, 120) : null,
    consecutiveFailures: fails,
    cooldownUntil: ok ? null : cooldown,
    latencyMs: typeof latencyMs === "number" ? latencyMs : prev.latencyMs || null,
  };
}
function sourceIsInCooldown(id) {
  var h = sourceHealth[id];
  return !!(h && h.cooldownUntil && Date.now() < h.cooldownUntil);
}
function sourceCanProbe(id) {
  return !sourceIsInCooldown(id);
}

// --- Mock registry/adapters (same shape as app) ---
var THIRD_PARTY_SOURCES = [
  { id: "mangadex", enabled: true, capabilities: { reader: true, search: true } },
  { id: "comick", enabled: true, capabilities: { reader: true, search: true } },
  { id: "anilist", enabled: true, capabilities: { reader: false, search: true, metadata: true } },
  { id: "jikan", enabled: true, capabilities: { reader: false, search: true, metadata: true } },
  { id: "kitsu", enabled: true, capabilities: { reader: false, search: true, metadata: true } },
];
var SOURCE_ADAPTERS = {
  mangadex: { search: function () { return Promise.resolve([{ title: "MD" }]); }, loadSeries: function () { return Promise.resolve({ chapters: [1] }); } },
  comick: { search: function () { return Promise.resolve([{ title: "CK" }]); }, loadSeries: function () { return Promise.resolve({ chapters: [1] }); } },
  anilist: { search: function () { return Promise.resolve([{ title: "AL" }]); } },
  jikan: { search: function () { return Promise.resolve([{ title: "JK" }]); } },
  kitsu: { search: function () { return Promise.resolve([{ title: "KT" }]); } },
};
function getSourceAdapter(id) { return SOURCE_ADAPTERS[id] || null; }
function readerSourceIds() {
  return THIRD_PARTY_SOURCES.filter(function (s) {
    return s.enabled !== false && s.capabilities && s.capabilities.reader === true;
  }).map(function (s) { return s.id; });
}

function searchReaderSourcesForTitle(title) {
  var calls = [];
  var jobs = readerSourceIds().map(function (id) {
    if (!sourceCanProbe(id)) return Promise.resolve({ id: id, skipped: true, list: [] });
    var adapter = getSourceAdapter(id);
    if (!adapter || typeof adapter.search !== "function") return Promise.resolve({ id: id, skipped: true, list: [] });
    calls.push(id);
    return adapter.search(title).then(function (list) {
      return { id: id, skipped: false, list: list || [] };
    });
  });
  return Promise.all(jobs).then(function (parts) {
    return { parts: parts, calls: calls };
  });
}

function loadSeriesPackFromMatch(match) {
  var adapter = getSourceAdapter(match.sourceId);
  if (adapter && typeof adapter.loadSeries === "function") return adapter.loadSeries(match.result);
  return Promise.reject(new Error("unknown-source"));
}

async function run() {
  // Test 1: registry-driven discovery with mock reader
  THIRD_PARTY_SOURCES.push({
    id: "__test_reader__",
    enabled: true,
    capabilities: { reader: true, search: true },
  });
  var searchCalled = false;
  SOURCE_ADAPTERS.__test_reader__ = {
    search: function () {
      searchCalled = true;
      return Promise.resolve([{ sourceId: "__test_reader__", remoteId: "test-1", title: "Registry Test Manga" }]);
    },
  };
  assert(readerSourceIds().indexOf("__test_reader__") >= 0, "mock reader in readerSourceIds");
  var r1 = await searchReaderSourcesForTitle("Registry Test Manga");
  assert(searchCalled, "mock reader adapter.search invoked without searchFn map");
  assert(r1.calls.indexOf("__test_reader__") >= 0, "mock reader included in discovery calls");

  // Remove mock
  THIRD_PARTY_SOURCES = THIRD_PARTY_SOURCES.filter(function (s) { return s.id !== "__test_reader__"; });
  delete SOURCE_ADAPTERS.__test_reader__;
  assert(readerSourceIds().indexOf("__test_reader__") < 0, "removed mock leaves discovery");

  // Test 2: metadata excluded
  var meta = ["anilist", "jikan", "kitsu"];
  meta.forEach(function (id) {
    assert(readerSourceIds().indexOf(id) < 0, id + " excluded from reader discovery");
  });
  var r2 = await searchReaderSourcesForTitle("One Piece");
  meta.forEach(function (id) {
    assert(r2.calls.indexOf(id) < 0, id + " search not called in reader discovery");
  });

  // Test 3: active cooldown blocks
  markSourceHealth("mangadex", false);
  markSourceHealth("mangadex", false);
  markSourceHealth("mangadex", false);
  assert(sourceHealth.mangadex.status === "offline", "3 failures → offline");
  assert(sourceIsInCooldown("mangadex"), "cooldown active");
  assert(!sourceCanProbe("mangadex"), "cannot probe while cooldown active");
  var r3 = await searchReaderSourcesForTitle("Title");
  assert(r3.calls.indexOf("mangadex") < 0, "active cooldown blocks search");

  // Test 4: expired cooldown allows probe
  sourceHealth.mangadex.cooldownUntil = Date.now() - 1000;
  assert(sourceCanProbe("mangadex"), "expired cooldown → can probe");
  var r4 = await searchReaderSourcesForTitle("Title");
  assert(r4.calls.indexOf("mangadex") >= 0, "probe search invoked after cooldown");

  // Test 5: successful probe restores health
  markSourceHealth("mangadex", true);
  assert(sourceHealth.mangadex.status === "healthy", "success → healthy");
  assert(sourceHealth.mangadex.consecutiveFailures === 0, "failures reset");
  assert(sourceHealth.mangadex.cooldownUntil == null, "cooldown cleared");

  // Test 6: failed probe remains retryable
  markSourceHealth("comick", false);
  markSourceHealth("comick", false);
  markSourceHealth("comick", false);
  assert(sourceHealth.comick.status === "offline", "offline after failures");
  sourceHealth.comick.cooldownUntil = Date.now() - 1;
  assert(sourceCanProbe("comick"), "still probe-eligible after expire");
  markSourceHealth("comick", false);
  assert(sourceHealth.comick.consecutiveFailures >= 1, "failure recorded");
  // not a permanent blacklist
  sourceHealth.comick.cooldownUntil = Date.now() - 1;
  assert(sourceCanProbe("comick"), "no permanent lock");

  // Test 7: adapter loadSeries dispatch
  for (const id of ["mangadex", "comick"]) {
    const pack = await loadSeriesPackFromMatch({ sourceId: id, result: { remoteId: "x" } });
    assert(pack && pack.chapters, id + " loadSeries via getSourceAdapter");
  }

  // Test 8: Kitsu metadata-only in registry
  var kitsu = THIRD_PARTY_SOURCES.find(function (s) { return s.id === "kitsu"; });
  assert(kitsu && kitsu.capabilities.reader === false, "Kitsu reader=false");
  assert(!!SOURCE_ADAPTERS.kitsu.search, "Kitsu has search");
  assert(!SOURCE_ADAPTERS.kitsu.loadSeries && !SOURCE_ADAPTERS.kitsu.pages, "Kitsu no pages/loadSeries");

  // Architectural invariants in index.html
  var htmlPath = path.join(__dirname, "index.html");
  if (!fs.existsSync(htmlPath)) htmlPath = path.join(__dirname, "MangaHive", "index.html");
  if (fs.existsSync(htmlPath)) {
    var html = fs.readFileSync(htmlPath, "utf8");
    assert(!/\bvar searchFn\s*=/.test(html), "index.html has no var searchFn");
    assert(/SOURCE_ADAPTERS/.test(html), "SOURCE_ADAPTERS present");
    assert(/sourceCanProbe/.test(html), "sourceCanProbe present");
    assert(/getSourceAdapter\(sid\)/.test(html) || /getSourceAdapter\(sourceId\)/.test(html) || /getSourceAdapter\(/.test(html), "getSourceAdapter used");
    // loadSeriesPackFromMatch should use adapter
    var m = html.match(/function loadSeriesPackFromMatch[\s\S]{0,400}/);
    assert(m && /getSourceAdapter/.test(m[0]), "loadSeriesPackFromMatch uses getSourceAdapter");
    assert(m && !/sid === "mangadex"/.test(m[0]), "loadSeriesPackFromMatch no sid===mangadex chain");
  } else {
    console.warn("WARN: index.html not found for static scan");
  }


  // MangaHive(15) Source Hub generic dispatch
  if (fs.existsSync(htmlPath)) {
    var html15 = fs.readFileSync(htmlPath, "utf8");
    assert(/function importHubResult/.test(html15), "importHubResult present");
    var srcResult = html15.match(/action === "source-result"[\s\S]{0,250}/);
    // Stage 2: search results open a PREVIEW; importHubResult is reached only via the explicit Add action.
    assert(srcResult && /openSearchPreview/.test(srcResult[0]) && !/importHubResult/.test(srcResult[0]), "source-result opens preview (no auto-import)");
    assert(srcResult && !/sourceId==="mangadex"/.test(srcResult[0]), "source-result no mangadex if-chain");
    var searchFn = html15.match(/function searchThirdPartySources[\s\S]{0,600}/);
    var regFn = html15.match(/var discoveryRegistry = \{[\s\S]{0,2600}/);
    // Stage 2: discovery resolves adapters through the registry glue (getSourceAdapter), not a parallel list.
    assert(regFn && /getSourceAdapter/.test(regFn[0]) && /THIRD_PARTY_SOURCES/.test(regFn[0]), "discoveryRegistry uses getSourceAdapter");
    assert(searchFn && /discovery\.search/.test(searchFn[0]) && !/mangaDexSearch\(q/.test(searchFn[0]), "searchThirdPartySources delegates to discovery service, no direct mangaDexSearch list");
  }

  if (failed) {
    console.error("\n" + failed + " failure(s)");
    process.exit(1);
  }
  console.log("\nAll regression tests passed.");
}

run().catch(function (e) {
  console.error(e);
  process.exit(1);
});

// ─── MangaHive(14) library-refresh regression ───────────────────────────────
(function libraryRefreshTests() {
  // Minimal mirror of refreshLibrarySources dispatch rules
  function isReaderSourceTypeLocal(type, registry) {
    if (!type) return false;
    if (type === "github") return true;
    var s = registry.find(function (x) { return x.id === type; });
    return !!(s && s.capabilities && s.capabilities.reader);
  }
  function simulateRefresh(entries, registry, adapters, health) {
    var loadCalls = [];
    var results = [];
    entries.forEach(function (s) {
      var t = s.source.type;
      if (t === "github") {
        results.push({ id: s.id, path: "github", added: 0 });
        return;
      }
      if (!isReaderSourceTypeLocal(t, registry)) {
        results.push({ id: s.id, path: "skipped-meta", added: 0 });
        return;
      }
      var h = health[t];
      var inCd = h && h.cooldownUntil && Date.now() < h.cooldownUntil;
      if (inCd) {
        results.push({ id: s.id, path: "skipped-cooldown", added: 0, loadCalled: false });
        return;
      }
      var ad = adapters[t];
      if (!ad || (typeof ad.loadSeries !== "function" && typeof ad.loadSeriesSync !== "function")) {
        results.push({ id: s.id, path: "no-adapter", added: 0 });
        return;
      }
      loadCalls.push(t);
      try {
        var pack = typeof ad.loadSeriesSync === "function" ? ad.loadSeriesSync() : { chapters: [{ remoteId: "c1", title: "Ch1" }] };
        results.push({ id: s.id, path: "adapter", added: pack.chapters.length, loadCalled: true });
      } catch (e) {
        results.push({ id: s.id, path: "fail", error: e.message, loadCalled: true });
      }
    });
    return { loadCalls: loadCalls, results: results };
  }

  var reg = [
    { id: "mangadex", capabilities: { reader: true } },
    { id: "anilist", capabilities: { reader: false, metadata: true } },
    { id: "jikan", capabilities: { reader: false } },
    { id: "kitsu", capabilities: { reader: false } },
    { id: "__test_library_reader__", capabilities: { reader: true } },
    { id: "__test_cooldown_reader__", capabilities: { reader: true } },
    { id: "__test_fail_reader__", capabilities: { reader: true } },
    { id: "__test_success_reader__", capabilities: { reader: true } },
  ];
  var adapters = {
    __test_library_reader__: {
      loadSeriesSync: function () {
        return { chapters: [{ remoteId: "n1", title: "New" }] };
      },
    },
    __test_cooldown_reader__: {
      loadSeriesSync: function () {
        throw new Error("should not be called");
      },
    },
    __test_fail_reader__: {
      loadSeriesSync: function () {
        throw new Error("boom");
      },
    },
    __test_success_reader__: {
      loadSeriesSync: function () {
        return { chapters: [{ remoteId: "ok", title: "OK" }] };
      },
    },
  };

  // New reader participates without hard-coded list
  var sim1 = simulateRefresh(
    [{ id: "s1", source: { type: "__test_library_reader__", remoteId: "r1" }, chapters: [] }],
    reg,
    adapters,
    {}
  );
  assert(sim1.loadCalls.indexOf("__test_library_reader__") >= 0, "library refresh uses adapter for mock reader");
  assert(sim1.results[0].path === "adapter", "mock library reader refreshed via adapter");

  // Active cooldown blocks
  var sim2 = simulateRefresh(
    [{ id: "s2", source: { type: "__test_cooldown_reader__", remoteId: "r2" }, chapters: [] }],
    reg,
    adapters,
    { __test_cooldown_reader__: { status: "offline", cooldownUntil: Date.now() + 60000 } }
  );
  assert(sim2.loadCalls.indexOf("__test_cooldown_reader__") < 0, "active cooldown blocks library refresh");
  assert(sim2.results[0].path === "skipped-cooldown", "cooldown skip path");

  // Expired cooldown allows
  var sim3 = simulateRefresh(
    [{ id: "s3", source: { type: "__test_library_reader__", remoteId: "r3" }, chapters: [] }],
    reg,
    adapters,
    { __test_library_reader__: { status: "offline", cooldownUntil: Date.now() - 1000 } }
  );
  assert(sim3.loadCalls.indexOf("__test_library_reader__") >= 0, "expired cooldown allows library probe");

  // One failure does not abort others
  var sim4 = simulateRefresh(
    [
      { id: "f", source: { type: "__test_fail_reader__", remoteId: "x" }, chapters: [] },
      { id: "ok", source: { type: "__test_success_reader__", remoteId: "y" }, chapters: [] },
    ],
    reg,
    adapters,
    {}
  );
  assert(sim4.results.some(function (r) { return r.id === "f" && r.path === "fail"; }), "fail reader recorded");
  assert(sim4.results.some(function (r) { return r.id === "ok" && r.path === "adapter"; }), "success reader still refreshed");

  // Metadata excluded
  ["anilist", "jikan", "kitsu"].forEach(function (id) {
    var sim = simulateRefresh(
      [{ id: "m", source: { type: id, remoteId: "1" }, chapters: [] }],
      reg,
      adapters,
      {}
    );
    assert(sim.loadCalls.length === 0, id + " excluded from library chapter refresh");
  });

  // GitHub special path
  var simG = simulateRefresh(
    [{ id: "g", source: { type: "github" }, chapters: [] }],
    reg,
    adapters,
    {}
  );
  assert(simG.results[0].path === "github", "GitHub uses special refresh path");

  // index.html architectural scan for refresh
  var htmlPath2 = path.join(__dirname, "index.html");
  if (!fs.existsSync(htmlPath2)) htmlPath2 = path.join(__dirname, "MangaHive", "index.html");
  if (fs.existsSync(htmlPath2)) {
    var html2 = fs.readFileSync(htmlPath2, "utf8");
    var rf = html2.match(/function refreshLibrarySources\([\s\S]*?\n  \}/);
    assert(rf, "refreshLibrarySources found");
    if (rf) {
      assert(/getSourceAdapter/.test(rf[0]), "refreshLibrarySources uses getSourceAdapter");
      assert(/sourceCanProbe/.test(rf[0]), "refreshLibrarySources uses sourceCanProbe");
      assert(/adapter\.loadSeries/.test(rf[0]), "refreshLibrarySources calls adapter.loadSeries");
      assert(!/else if\(t === "mangadex"\)/.test(rf[0]), "no mangadex if-chain in refreshLibrarySources");
      assert(/t === "github"/.test(rf[0]), "GitHub special path retained");
    }
  }
})();
