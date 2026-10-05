/**
 * MangaHive — Extension Registry regression tests (foundation phase)
 * Run: node extension_registry_regression_test.js
 *
 * Mirrors the extension platform contract in index.html without loading the
 * full app. Also statically scans index.html for security invariants.
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

// --- Mirror of host constants / registry (must stay aligned with index.html) ---
var EXTENSION_API_VERSION = 1;
var EXTENSION_ALLOWED_PERMISSIONS = { network: true };
var EXTENSION_ALLOWED_CAPABILITIES = {
  search: true, details: true, chapters: true, pages: true,
  metadata: true, reader: true, catalog: true, filters: true,
  genres: true, languages: true, authentication: true,
  comments: true, favorites: true, externalRead: true,
  popular: true, latest: true, updates: true, deepLink: true,
  covers: true, downloads: true
};

var extensionRegistry = { byId: Object.create(null), order: [] };
var memPrefs = { enabled: {}, disabled: {} };

function loadExtensionPrefs(){ return memPrefs; }
function saveExtensionPrefs(p){ memPrefs = { enabled: p.enabled || {}, disabled: p.disabled || {} }; }

function validateExtensionManifest(manifest){
  var errors = [];
  if(!manifest || typeof manifest !== "object"){
    return { ok: false, errors: ["manifest must be an object"], status: "invalid" };
  }
  var id = manifest.id;
  if(!id || typeof id !== "string" || !/^[a-z][a-z0-9._-]*$/i.test(id) || id.indexOf(".") < 0){
    errors.push("id must be a namespaced stable identifier (e.g. mangahive.mangadex)");
  }
  if(!manifest.name || typeof manifest.name !== "string") errors.push("name required");
  if(!manifest.version || typeof manifest.version !== "string") errors.push("version required");
  var api = manifest.apiVersion;
  if(typeof api !== "number" || !isFinite(api)) errors.push("apiVersion must be a number");
  else if(api !== EXTENSION_API_VERSION){
    return {
      ok: false,
      errors: ["incompatible apiVersion " + api + " (host " + EXTENSION_API_VERSION + ")"],
      status: "incompatible"
    };
  }
  if(manifest.permissions){
    if(!Array.isArray(manifest.permissions)) errors.push("permissions must be an array");
    else {
      manifest.permissions.forEach(function(p){
        if(!EXTENSION_ALLOWED_PERMISSIONS[p]) errors.push("permission not allowed: " + p);
      });
    }
  }
  if(manifest.capabilities){
    if(!Array.isArray(manifest.capabilities)) errors.push("capabilities must be an array");
    else {
      manifest.capabilities.forEach(function(c){
        if(!EXTENSION_ALLOWED_CAPABILITIES[c]) errors.push("unknown capability: " + c);
      });
    }
  }
  if(manifest.sources !== undefined){
    if(!Array.isArray(manifest.sources)) errors.push("sources must be an array");
    else {
      manifest.sources.forEach(function(s, i){
        if(!s || typeof s.id !== "string" || !s.id) errors.push("sources[" + i + "].id required");
      });
    }
  }
  if(manifest.signature != null && typeof manifest.signature !== "string"){
    errors.push("signature must be a string or null");
  }
  if(errors.length) return { ok: false, errors: errors, status: "invalid" };
  return { ok: true, errors: [], status: "installed" };
}

function getExtension(id){ return extensionRegistry.byId[id] || null; }
function getExtensions(){
  return extensionRegistry.order.map(function(id){ return extensionRegistry.byId[id]; }).filter(Boolean);
}
function isExtensionEnabled(id){
  var ext = getExtension(id);
  return !!(ext && ext.status === "enabled");
}

function registerExtension(manifest, adaptersBySourceId){
  var v = validateExtensionManifest(manifest);
  var record = {
    id: manifest && manifest.id,
    manifest: manifest || {},
    status: v.status,
    errors: v.errors.slice(),
    diagnostic: v.errors.length ? v.errors.join("; ") : null,
    adapters: adaptersBySourceId || null,
    registeredAt: Date.now(),
    signature: (manifest && manifest.signature) || null,
    signingKeyId: (manifest && manifest.signingKeyId) || null
  };
  if(!v.ok){
    if(record.id && typeof record.id === "string"){
      extensionRegistry.byId[record.id] = record;
      if(extensionRegistry.order.indexOf(record.id) < 0) extensionRegistry.order.push(record.id);
    }
    return record;
  }
  var prefs = loadExtensionPrefs();
  var userDisabled = prefs.disabled && prefs.disabled[record.id] === true;
  record.status = userDisabled ? "disabled" : "enabled";
  extensionRegistry.byId[record.id] = record;
  if(extensionRegistry.order.indexOf(record.id) < 0) extensionRegistry.order.push(record.id);
  return record;
}

function unregisterExtension(id){
  if(!extensionRegistry.byId[id]) return false;
  delete extensionRegistry.byId[id];
  extensionRegistry.order = extensionRegistry.order.filter(function(x){ return x !== id; });
  return true;
}

function enableExtension(id){
  var ext = getExtension(id);
  if(!ext) return false;
  if(ext.status === "incompatible" || ext.status === "invalid") return false;
  ext.status = "enabled";
  var prefs = loadExtensionPrefs();
  delete prefs.disabled[id];
  prefs.enabled[id] = true;
  saveExtensionPrefs(prefs);
  return true;
}

function disableExtension(id){
  var ext = getExtension(id);
  if(!ext) return false;
  if(ext.status === "incompatible" || ext.status === "invalid") return false;
  ext.status = "disabled";
  var prefs = loadExtensionPrefs();
  prefs.disabled[id] = true;
  delete prefs.enabled[id];
  saveExtensionPrefs(prefs);
  return true;
}

function markExtensionFailed(id, err){
  var ext = getExtension(id);
  if(!ext) return;
  ext.status = "failed";
  ext.diagnostic = String((err && err.message) || err || "failed").slice(0, 160);
}

// Minimal source registry mirror for multi-source + enable tests
var THIRD_PARTY_SOURCES = [];
var SOURCE_ADAPTERS = {};
function getSourceAdapter(id){ return SOURCE_ADAPTERS[id] || null; }
function readerSourceIds(){
  return THIRD_PARTY_SOURCES.filter(function(s){
    return s.enabled !== false && s.capabilities && s.capabilities.reader === true;
  }).map(function(s){ return s.id; });
}
function syncSourcesFromExtensions(){
  getExtensions().forEach(function(ext){
    if(!ext || !ext.manifest || !ext.manifest.sources) return;
    var on = ext.status === "enabled";
    ext.manifest.sources.forEach(function(sd){
      if(!sd || !sd.id) return;
      var row = THIRD_PARTY_SOURCES.find(function(s){ return s.id === sd.id; });
      if(row) row.enabled = on;
    });
  });
}

// Source health (independent of extension)
var sourceHealth = {};
function markSourceHealth(id, ok, error){
  var prev = sourceHealth[id] || { consecutiveFailures: 0 };
  var fails = ok ? 0 : (prev.consecutiveFailures || 0) + 1;
  var cooldown = null;
  if(!ok && fails >= 3){
    cooldown = Date.now() + Math.min(30 * 60 * 1000, 15000 * Math.pow(2, Math.min(fails - 3, 5)));
  }
  sourceHealth[id] = {
    status: ok ? "healthy" : fails >= 3 ? "offline" : "degraded",
    ok: !!ok,
    consecutiveFailures: fails,
    cooldownUntil: ok ? null : cooldown
  };
}
function sourceIsInCooldown(id){
  var h = sourceHealth[id];
  return !!(h && h.cooldownUntil && Date.now() < h.cooldownUntil);
}

function validManifest(overrides){
  return Object.assign({
    id: "mangahive.test-source",
    name: "Test Source",
    version: "1.0.0",
    apiVersion: 1,
    author: "Test",
    description: "unit test",
    languages: ["en"],
    contentTypes: ["manga"],
    engine: "builtin.test",
    capabilities: ["search", "details", "chapters", "pages"],
    permissions: ["network"],
    sources: [{ id: "testsrc", name: "Test", capabilities: { search: true, reader: true, chapters: true, pages: true } }],
    signature: null,
    signingKeyId: null
  }, overrides || {});
}

function run(){
  // 1. Valid registration
  var r1 = registerExtension(validManifest());
  assert(r1.status === "enabled", "valid extension registers as enabled");
  assert(isExtensionEnabled("mangahive.test-source"), "isExtensionEnabled true");
  assert(getExtension("mangahive.test-source"), "getExtension returns record");

  // 2. Invalid rejection (missing name / bad id)
  var rBad = registerExtension({ id: "not-namespaced", version: "1", apiVersion: 1 });
  assert(rBad.status === "invalid", "invalid extension status=invalid");
  assert(!isExtensionEnabled("not-namespaced"), "invalid not enabled");

  // 3. Duplicate id — re-register replaces/updates, stays in registry once
  var before = extensionRegistry.order.filter(function(x){ return x === "mangahive.test-source"; }).length;
  registerExtension(validManifest({ version: "1.0.1" }));
  var after = extensionRegistry.order.filter(function(x){ return x === "mangahive.test-source"; }).length;
  assert(before === 1 && after === 1, "duplicate id does not double-list in order");
  assert(getExtension("mangahive.test-source").manifest.version === "1.0.1", "re-register updates manifest");

  // 4. Incompatible API
  var rInc = registerExtension(validManifest({
    id: "mangahive.future",
    apiVersion: 99
  }));
  assert(rInc.status === "incompatible", "incompatible apiVersion rejected");
  assert(!enableExtension("mangahive.future"), "cannot enable incompatible");

  // 5. Forbidden permission
  var rPerm = registerExtension(validManifest({
    id: "mangahive.evil",
    permissions: ["network", "serviceRole"]
  }));
  assert(rPerm.status === "invalid", "unknown permission → invalid");

  // 6. Enable / disable
  assert(disableExtension("mangahive.test-source"), "disable succeeds");
  assert(getExtension("mangahive.test-source").status === "disabled", "status disabled");
  assert(!isExtensionEnabled("mangahive.test-source"), "isExtensionEnabled false when disabled");
  assert(enableExtension("mangahive.test-source"), "enable succeeds");
  assert(isExtensionEnabled("mangahive.test-source"), "enabled again");

  // 7. Multi-source extension
  var multi = registerExtension(validManifest({
    id: "mangahive.multi",
    sources: [
      { id: "src-a", name: "A", capabilities: { search: true, reader: true } },
      { id: "src-b", name: "B", capabilities: { search: true, reader: false, metadata: true } }
    ]
  }));
  assert(multi.status === "enabled", "multi-source extension enabled");
  assert(multi.manifest.sources.length === 2, "two sources on one extension");

  THIRD_PARTY_SOURCES = [
    { id: "src-a", enabled: true, capabilities: { reader: true, search: true } },
    { id: "src-b", enabled: true, capabilities: { reader: false, search: true, metadata: true } },
    { id: "testsrc", enabled: true, capabilities: { reader: true, search: true } }
  ];
  SOURCE_ADAPTERS = {
    "src-a": { search: function(){ return Promise.resolve([{ title: "A" }]); } },
    "src-b": { search: function(){ return Promise.resolve([{ title: "B" }]); } },
    "testsrc": { search: function(){ return Promise.resolve([{ title: "T" }]); } }
  };
  disableExtension("mangahive.multi");
  syncSourcesFromExtensions();
  assert(THIRD_PARTY_SOURCES.find(function(s){ return s.id === "src-a"; }).enabled === false, "disable extension disables source-a");
  assert(THIRD_PARTY_SOURCES.find(function(s){ return s.id === "src-b"; }).enabled === false, "disable extension disables source-b");
  enableExtension("mangahive.multi");
  syncSourcesFromExtensions();
  assert(readerSourceIds().indexOf("src-a") >= 0, "enabled multi-source reader participates");
  assert(readerSourceIds().indexOf("src-b") < 0, "metadata-only source not in readerSourceIds");

  // 8. Failure isolation
  markExtensionFailed("mangahive.test-source", new Error("boom"));
  assert(getExtension("mangahive.test-source").status === "failed", "failed status");
  assert(getExtension("mangahive.multi").status === "enabled", "other extension unaffected");

  // 9. Source health independent of extension
  markSourceHealth("src-a", false);
  markSourceHealth("src-a", false);
  markSourceHealth("src-a", false);
  assert(sourceHealth["src-a"].status === "offline", "source offline after 3 failures");
  assert(sourceIsInCooldown("src-a"), "source cooldown active");
  assert(getExtension("mangahive.multi").status === "enabled", "extension still enabled while source offline");

  // 10. Unregister
  assert(unregisterExtension("mangahive.future"), "unregister incompatible");
  assert(!getExtension("mangahive.future"), "gone after unregister");

  // 11. Built-in-shaped manifests (MangaDex / ComicK style)
  ["mangahive.mangadex", "mangahive.comick", "mangahive.anilist", "mangahive.kitsu"].forEach(function(id){
    var sid = id.split(".").pop();
    var isMeta = sid === "anilist" || sid === "kitsu" || sid === "jikan";
    var m = validManifest({
      id: id,
      name: sid,
      capabilities: isMeta ? ["search", "details", "metadata"] : ["search", "details", "chapters", "pages"],
      sources: [{
        id: sid,
        name: sid,
        capabilities: isMeta
          ? { search: true, metadata: true, reader: false }
          : { search: true, metadata: true, chapters: true, pages: true, reader: true }
      }]
    });
    var rec = registerExtension(m);
    assert(rec.status === "enabled", id + " built-in shape enabled");
  });

  // 12. Security static scan of index.html
  var htmlPath = path.join(__dirname, "index.html");
  if (!fs.existsSync(htmlPath)) htmlPath = path.join(__dirname, "MangaHive", "index.html");
  if (fs.existsSync(htmlPath)) {
    var html = fs.readFileSync(htmlPath, "utf8");
    assert(/EXTENSION_API_VERSION\s*=\s*1/.test(html), "index.html EXTENSION_API_VERSION = 1");
    assert(/function registerExtension/.test(html), "registerExtension present");
    assert(/function validateExtensionManifest/.test(html), "validateExtensionManifest present");
    assert(/function enableExtension/.test(html), "enableExtension present");
    assert(/function disableExtension/.test(html), "disableExtension present");
    assert(/installBuiltinExtensions/.test(html), "installBuiltinExtensions present");
    assert(/mangahive\.mangadex/.test(html), "built-in mangadex extension id");
    assert(/mangahive\.comick/.test(html), "built-in comick extension id");
    assert(/SOURCE_ADAPTERS/.test(html), "SOURCE_ADAPTERS retained");
    assert(/sourceCanProbe/.test(html), "sourceCanProbe retained");
    // No insecure dynamic code execution introduced by extension layer
    // (allow vendor/minified patterns only outside our extension block by checking key phrases)
    assert(!/eval\s*\(\s*extension/i.test(html), "no eval(extension…)");
    assert(!/new Function\s*\(\s*['\"]return extension/i.test(html), "no new Function extension loader");
    assert(!/importScripts\s*\(\s*remote/i.test(html), "no remote importScripts loader");
    // Schema unchanged
    assert(/EXPECTED_SCHEMA_VERSION\s*=\s*10/.test(html), "schema version still 10");
  } else {
    console.warn("WARN: index.html not found for static scan");
  }

  // 13. sw.js cache name still present (do not require v68 specifically if project moved to v69)
  var swPath = path.join(__dirname, "sw.js");
  if (fs.existsSync(swPath)) {
    var sw = fs.readFileSync(swPath, "utf8");
    assert(/fairs-library-shell-v\d+/.test(sw), "service worker cache name present");
  }

  if (failed) {
    console.error("\n" + failed + " failure(s)");
    process.exit(1);
  }
  console.log("\nAll extension registry regression tests passed.");
}

run();
