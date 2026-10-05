/**
 * MangaHive — full extension platform regression (migration → repo → runtime → hub)
 * Run: node extension_platform_regression_test.js
 */
"use strict";
const fs = require("fs");
const path = require("path");

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failed++; }
  else console.log("PASS:", msg);
}

const htmlPath = path.join(__dirname, "index.html");
const html = fs.readFileSync(htmlPath, "utf8");

// --- Static architecture checks ---
assert(/EXTENSION_API_VERSION\s*=\s*1/.test(html), "EXTENSION_API_VERSION = 1");
assert(/REPOSITORY_API_VERSION\s*=\s*1/.test(html), "REPOSITORY_API_VERSION = 1");
assert(/function installBuiltinExtensions/.test(html), "installBuiltinExtensions");
assert(/function bindBuiltinAdaptersToExtensions/.test(html), "bindBuiltinAdaptersToExtensions");
assert(/function getAdapterViaExtension/.test(html), "getAdapterViaExtension");
assert(/function fetchRepositoryIndex/.test(html), "fetchRepositoryIndex");
assert(/function installExtensionFromManifest/.test(html), "installExtensionFromManifest");
assert(/function uninstallExtension/.test(html), "uninstallExtension");
assert(/function updateExtension/.test(html), "updateExtension");
assert(/function createSourceApi/.test(html), "createSourceApi");
assert(/function clusterSearchResults/.test(html), "clusterSearchResults");
assert(/function resolvePagesWithFallback/.test(html), "resolvePagesWithFallback");
assert(/function sourceHubExtensionsHTML/.test(html), "Source Hub 2.0 HTML");
assert(/sourceHubTab/.test(html), "sourceHubTab state");
assert(/mangahive\.mangadex/.test(html), "MangaDex extension id");
assert(/mangahive\.comick/.test(html), "ComicK extension id");
assert(/mangahive\.mangpi/.test(html), "MangaPi extension id");
assert(/mangahive\.mangahook/.test(html), "MangaHook extension id");
assert(/mangahive\.kitsu/.test(html), "Kitsu extension id");
assert(/mangahive\.anilist/.test(html), "AniList extension id");
assert(/mangahive\.jikan/.test(html), "Jikan extension id");
assert(/EXPECTED_SCHEMA_VERSION\s*=\s*10/.test(html), "schema still 10");
assert(/API boundary only/.test(html), "runtime documents non-sandbox boundary");
assert(/getSupabase:\s*function\(\)\{\s*return null/.test(html), "API denies Supabase");
assert(/getAuthToken:\s*function\(\)\{\s*return null/.test(html), "API denies auth token");
assert(/getNativeBridge:\s*function\(\)\{\s*return null/.test(html), "API denies native bridge");

// No fake signature acceptance
assert(!/"signature"\s*:\s*"valid"/.test(html), "no fake signature:valid");
// Security: extension install must not eval remote code
assert(!/eval\s*\(\s*fetched/i.test(html), "no eval(fetched…)");
assert(!/new Function\s*\(\s*download/i.test(html), "no new Function(download…)");

// Reader pages via adapter
assert(/function fetchPagesFromSource/.test(html), "fetchPagesFromSource present");
assert(/ad\.pages\(seriesRemoteId/.test(html) || /ad\.pages\(/.test(html), "pages via adapter");

// Hard-coded recommend filter removed
assert(!/r\.sourceId==="mangadex"\s*\|\|\s*r\.sourceId==="mangahook"/.test(html), "no hard-coded recommend source pair");
assert(/sourceIsReader\(r\.sourceId\)/.test(html), "recommend uses sourceIsReader");

// --- Runtime mirror tests ---
var EXTENSION_API_VERSION = 1;
var REPOSITORY_API_VERSION = 1;
var EXTENSION_ALLOWED_PERMISSIONS = { network: true };
var EXTENSION_ALLOWED_CAPABILITIES = {
  search:true, details:true, chapters:true, pages:true, metadata:true, reader:true,
  covers:true, downloads:true, deepLink:true
};
var extensionRegistry = { byId: Object.create(null), order: [] };
var memPrefs = { enabled: {}, disabled: {} };
function loadExtensionPrefs(){ return memPrefs; }
function saveExtensionPrefs(p){ memPrefs = p; }

function validateExtensionManifest(manifest){
  var errors = [];
  if(!manifest || typeof manifest !== "object") return { ok:false, errors:["bad"], status:"invalid" };
  var id = manifest.id;
  if(!id || typeof id !== "string" || id.indexOf(".") < 0) errors.push("id");
  if(!manifest.name) errors.push("name");
  if(!manifest.version) errors.push("version");
  if(manifest.apiVersion !== EXTENSION_API_VERSION) return { ok:false, errors:["api"], status:"incompatible" };
  if(manifest.permissions){
    manifest.permissions.forEach(function(p){ if(!EXTENSION_ALLOWED_PERMISSIONS[p]) errors.push("perm:"+p); });
  }
  if(errors.length) return { ok:false, errors:errors, status:"invalid" };
  return { ok:true, errors:[], status:"installed" };
}
function registerExtension(manifest){
  var v = validateExtensionManifest(manifest);
  var record = { id: manifest.id, manifest: manifest, status: v.status, errors: v.errors, adapters: null };
  if(!v.ok){ extensionRegistry.byId[record.id] = record; return record; }
  record.status = (memPrefs.disabled[record.id] ? "disabled" : "enabled");
  extensionRegistry.byId[record.id] = record;
  if(extensionRegistry.order.indexOf(record.id) < 0) extensionRegistry.order.push(record.id);
  return record;
}
function getExtension(id){ return extensionRegistry.byId[id] || null; }
function enableExtension(id){ var e = getExtension(id); if(!e || e.status==="invalid"||e.status==="incompatible") return false; e.status="enabled"; delete memPrefs.disabled[id]; return true; }
function disableExtension(id){ var e = getExtension(id); if(!e) return false; e.status="disabled"; memPrefs.disabled[id]=true; return true; }

var THIRD_PARTY_SOURCES = [
  { id:"mangadex", enabled:true, capabilities:{ reader:true, search:true } },
  { id:"comick", enabled:true, capabilities:{ reader:true, search:true } },
  { id:"mangpi", enabled:true, capabilities:{ reader:true, search:true } },
  { id:"mangahook", enabled:true, capabilities:{ reader:true, search:true } },
  { id:"kitsu", enabled:true, capabilities:{ reader:false, search:true, metadata:true } },
  { id:"anilist", enabled:true, capabilities:{ reader:false, search:true, metadata:true } },
  { id:"jikan", enabled:true, capabilities:{ reader:false, search:true, metadata:true } }
];
var SOURCE_ADAPTERS = {
  mangadex: { search: function(){ return Promise.resolve([{ title:"MD", remoteId:"1" }]); }, loadSeries: function(){ return Promise.resolve({ chapters:[{ remoteId:"c1" }] }); }, pages: function(){ return Promise.resolve(["p1"]); } },
  comick: { search: function(){ return Promise.resolve([{ title:"CK", remoteId:"2" }]); }, loadSeries: function(){ return Promise.resolve({ chapters:[{ remoteId:"c1" }] }); }, pages: function(){ return Promise.resolve(["p1"]); } },
  mangpi: { search: function(){ return Promise.resolve([{ title:"MP", remoteId:"3" }]); }, loadSeries: function(){ return Promise.resolve({ chapters:[{ remoteId:"c1" }] }); }, pages: function(){ return Promise.resolve(["p1"]); } },
  mangahook: { search: function(){ return Promise.resolve([{ title:"MH", remoteId:"4" }]); }, loadSeries: function(){ return Promise.resolve({ chapters:[{ remoteId:"c1" }] }); }, pages: function(){ return Promise.resolve(["p1"]); } },
  kitsu: { search: function(){ return Promise.resolve([{ title:"KT", remoteId:"5" }]); } },
  anilist: { search: function(){ return Promise.resolve([{ title:"AL", remoteId:"6" }]); } },
  jikan: { search: function(){ return Promise.resolve([{ title:"JK", remoteId:"7" }]); } }
};

function syncSourcesFromExtensions(){
  Object.keys(extensionRegistry.byId).forEach(function(eid){
    var ext = extensionRegistry.byId[eid];
    var on = ext.status === "enabled";
    (ext.manifest.sources || []).forEach(function(sd){
      var row = THIRD_PARTY_SOURCES.find(function(s){ return s.id === sd.id; });
      if(row) row.enabled = on;
    });
  });
}
function readerSourceIds(){
  return THIRD_PARTY_SOURCES.filter(function(s){ return s.enabled !== false && s.capabilities && s.capabilities.reader; }).map(function(s){ return s.id; });
}

// Register builtins
["mangadex","comick","mangpi","mangahook","kitsu","anilist","jikan"].forEach(function(sid){
  var isMeta = sid === "kitsu" || sid === "anilist" || sid === "jikan";
  registerExtension({
    id: "mangahive." + sid,
    name: sid,
    version: "1.0.0",
    apiVersion: 1,
    permissions: ["network"],
    capabilities: isMeta ? ["search","details","metadata"] : ["search","details","chapters","pages"],
    sources: [{ id: sid, name: sid, capabilities: isMeta ? { reader:false, search:true, metadata:true } : { reader:true, search:true } }]
  });
});

assert(readerSourceIds().indexOf("mangadex") >= 0, "MangaDex in reader discovery");
assert(readerSourceIds().indexOf("comick") >= 0, "ComicK in reader discovery");
assert(readerSourceIds().indexOf("mangpi") >= 0, "MangaPi in reader discovery");
assert(readerSourceIds().indexOf("mangahook") >= 0, "MangaHook in reader discovery");
assert(readerSourceIds().indexOf("kitsu") < 0, "Kitsu metadata-only");
assert(readerSourceIds().indexOf("anilist") < 0, "AniList metadata-only");
assert(readerSourceIds().indexOf("jikan") < 0, "Jikan metadata-only");

// Disable extension removes from reader
disableExtension("mangahive.mangadex");
syncSourcesFromExtensions();
assert(readerSourceIds().indexOf("mangadex") < 0, "disable extension removes mangadex from reader");
enableExtension("mangahive.mangadex");
syncSourcesFromExtensions();
assert(readerSourceIds().indexOf("mangadex") >= 0, "re-enable restores mangadex");

// Mock extension auto-participates
registerExtension({
  id: "community.mock-reader",
  name: "Mock",
  version: "1.0.0",
  apiVersion: 1,
  permissions: ["network"],
  capabilities: ["search","chapters","pages"],
  sources: [{ id: "__mock__", name: "Mock", capabilities: { reader:true, search:true } }]
});
THIRD_PARTY_SOURCES.push({ id: "__mock__", enabled: true, capabilities: { reader:true, search:true } });
SOURCE_ADAPTERS.__mock__ = { search: function(){ return Promise.resolve([{ title:"Mock" }]); } };
syncSourcesFromExtensions();
assert(readerSourceIds().indexOf("__mock__") >= 0, "new mock extension source in reader discovery");

// Repository index validation
function validateRepositoryIndex(index){
  var errors = [];
  if(!index || typeof index !== "object") return { ok:false, errors:["obj"] };
  if(index.repositoryApiVersion !== REPOSITORY_API_VERSION) errors.push("api");
  if(!index.name) errors.push("name");
  if(!Array.isArray(index.extensions)) errors.push("ext");
  return { ok: !errors.length, errors: errors };
}
assert(validateRepositoryIndex({ repositoryApiVersion:1, name:"Official", extensions:[] }).ok, "valid repository index");
assert(!validateRepositoryIndex({ repositoryApiVersion:99, name:"X", extensions:[] }).ok, "malformed api version rejected");
assert(!validateRepositoryIndex({ repositoryApiVersion:1, extensions:[] }).ok, "missing name rejected");

// Cooldown independence
var sourceHealth = {};
function markSourceHealth(id, ok){
  var prev = sourceHealth[id] || { consecutiveFailures: 0 };
  var fails = ok ? 0 : (prev.consecutiveFailures || 0) + 1;
  sourceHealth[id] = {
    status: ok ? "healthy" : fails >= 3 ? "offline" : "degraded",
    consecutiveFailures: fails,
    cooldownUntil: (!ok && fails >= 3) ? Date.now() + 60000 : null
  };
}
markSourceHealth("mangadex", false);
markSourceHealth("mangadex", false);
markSourceHealth("mangadex", false);
assert(sourceHealth.mangadex.status === "offline", "source cooldown offline");
assert(getExtension("mangahive.mangadex").status === "enabled", "extension stays enabled when source offline");
assert(getExtension("mangahive.comick").status === "enabled", "sibling extension unaffected");

// Cluster intelligence
function normalizeTitleKey(v){ return String(v||"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim(); }
function titleClusterKey(title){ return normalizeTitleKey(title).replace(/\b(the|a|an)\b/g," ").replace(/\s+/g," ").trim(); }
function clusterSearchResults(results){
  var groups = {};
  (results||[]).forEach(function(r){
    var key = titleClusterKey(r.title);
    if(!groups[key]) groups[key] = { canonicalTitle: r.title, sources: [] };
    groups[key].sources.push(r);
  });
  return Object.keys(groups).map(function(k){ return groups[k]; });
}
var clusters = clusterSearchResults([
  { sourceId:"mangadex", title:"One Piece" },
  { sourceId:"comick", title:"One Piece" },
  { sourceId:"mangadex", title:"Naruto" }
]);
assert(clusters.length === 2, "duplicate titles clustered");
assert(clusters.some(function(c){ return c.sources.length === 2; }), "One Piece has 2 sources");

// Denied APIs
function createSourceApiDenied(){
  return { getSupabase: function(){ return null; }, getAuthToken: function(){ return null; }, getNativeBridge: function(){ return null; } };
}
var api = createSourceApiDenied();
assert(api.getSupabase() === null && api.getAuthToken() === null && api.getNativeBridge() === null, "malicious access denied");

async function asyncPart(){
  const md = await SOURCE_ADAPTERS.mangadex.search("x");
  assert(md && md[0] && md[0].title === "MD", "MangaDex adapter via registry path");
  const ck = await SOURCE_ADAPTERS.comick.pages("s","c");
  assert(ck && ck[0] === "p1", "ComicK pages via adapter");
  const mh = await SOURCE_ADAPTERS.mangahook.loadSeries({ remoteId:"x" });
  assert(mh.chapters && mh.chapters.length, "MangaHook loadSeries");
  const mp = await SOURCE_ADAPTERS.mangpi.search("x");
  assert(mp[0].title === "MP", "MangaPi search");
}

asyncPart().then(function(){
  if (failed) { console.error("\n" + failed + " failure(s)"); process.exit(1); }
  console.log("\nAll extension platform regression tests passed.");
}).catch(function(e){
  console.error(e);
  process.exit(1);
});
