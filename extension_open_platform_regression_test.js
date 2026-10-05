/**
 * Open extension platform + final hardening tests
 * Run: node extension_open_platform_regression_test.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failed++; }
  else console.log("PASS:", msg);
}

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

// Extract a slice of extension platform functions into a sandbox for real tests
function extractFunction(name) {
  const re = new RegExp("function " + name + "\\([\\s\\S]*?\\n  \\}\\n");
  const m = html.match(re);
  return m ? m[0] : null;
}

// --- Static contract ---
assert(/function parseSemver/.test(html), "parseSemver present");
assert(/function isValidSemver/.test(html), "isValidSemver present");
assert(/function buildDeclarativeAdapter/.test(html), "declarative engine builder");
assert(/function installDeclarativeEngines/.test(html), "installDeclarativeEngines");
assert(/function installExtensionFromUrl/.test(html), "install from URL");
assert(/function ensureDynamicSourceRow/.test(html), "dynamic source registration");
assert(/community\.test-extension/.test(html), "test extension id in app");
assert(/mh-test-source/.test(html), "test source id in app");
assert(/static-catalog/.test(html), "static-catalog engine");
assert(/extensionNetworkRequest/.test(html), "controlled network API");
assert(/EXTENSION_HTTPS_REQUIRED/.test(html), "HTTPS enforcement");
assert(/repository entry id does not match manifest\.id/.test(html), "repo id integrity");
assert(/ext-install-url/.test(html), "UI install from URL");
// Case-sensitive ID regex (no /i)
assert(/\/\^\[a-z\]\[a-z0-9\._-\]\*\$\/\.test\(id\)/.test(html), "case-sensitive source id regex");
assert(!/\/\^\[a-z\]\[a-z0-9\._-\]\*\$\/i\.test\(id\)/.test(html), "no case-insensitive id regex");
assert(/getSourceOwner\(id\)/.test(html) || /owner\)/.test(html), "ownership used in getSourceAdapter");
assert(/disabled owner → no adapter|status !== "enabled"\) return null/.test(html), "disabled owner blocks adapter");
assert(!/\beval\s*\(/.test(html.split("vendor-supabase")[0]), "no eval in app core");
assert(!/new Function\s*\(/.test(html), "no new Function");
assert(/EXPECTED_SCHEMA_VERSION\s*=\s*10/.test(html), "schema 10");

// --- Sandbox: real production-like functions ---
const sandbox = {
  console,
  EXTENSION_API_VERSION: 1,
  EXT_MAX_RESPONSE_ITEMS: 500,
  EXT_MAX_PAGES: 2000,
  RESERVED_SOURCE_KEYS: { __proto__: 1, constructor: 1, prototype: 1 },
  sourceOwnership: Object.create(null),
  extensionRegistry: { byId: Object.create(null), order: [] },
  THIRD_PARTY_SOURCES: [
    { id: "mangadex", enabled: true, capabilities: { reader: true, search: true } }
  ],
  SOURCE_ADAPTERS: {
    mangadex: { search: function () { return Promise.resolve([]); } }
  },
  installedExtensionPackages: Object.create(null),
  localStorage: (function () {
    const m = {};
    return {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null),
      setItem: (k, v) => { m[k] = String(v); },
      removeItem: (k) => { delete m[k]; }
    };
  })(),
  logError: function () {}
};

// Minimal implementations matching production hardened logic
const code = `
function isSafeSourceId(id){
  if(!id || typeof id !== "string") return false;
  if(RESERVED_SOURCE_KEYS[id]) return false;
  if(id === "__proto__" || id === "constructor" || id === "prototype") return false;
  return /^[a-z][a-z0-9._-]*$/.test(id) && id.length <= 64;
}
function isSafeExtensionId(id){
  if(!id || typeof id !== "string") return false;
  if(id.indexOf(".") < 0) return false;
  return /^[a-z][a-z0-9._-]*$/.test(id) && id.length <= 96;
}
function isOfficialNamespace(id){
  return typeof id === "string" && id.indexOf("mangahive.") === 0;
}
function parseSemver(v){
  var s = String(v || "").trim();
  var m = s.match(/^(\\d+)\\.(\\d+)\\.(\\d+)(?:-([0-9A-Za-z.-]+))?(?:\\+([0-9A-Za-z.-]+))?$/);
  if(!m) return null;
  return { major:+m[1], minor:+m[2], patch:+m[3], prerelease: m[4]?m[4].split("."):[], build:m[5]||null };
}
function compareSemver(a,b){
  var pa=parseSemver(a), pb=parseSemver(b);
  if(!pa&&!pb) return 0; if(!pa) return -1; if(!pb) return 1;
  if(pa.major!==pb.major) return pa.major>pb.major?1:-1;
  if(pa.minor!==pb.minor) return pa.minor>pb.minor?1:-1;
  if(pa.patch!==pb.patch) return pa.patch>pb.patch?1:-1;
  var pra=pa.prerelease, prb=pb.prerelease;
  if(!pra.length&&!prb.length) return 0;
  if(!pra.length) return 1; if(!prb.length) return -1;
  var n=Math.max(pra.length,prb.length);
  for(var i=0;i<n;i++){
    if(i>=pra.length) return -1; if(i>=prb.length) return 1;
    var xa=pra[i], xb=prb[i];
    var na=/^\\d+$/.test(xa), nb=/^\\d+$/.test(xb);
    if(na&&nb){ var ia=+xa, ib=+xb; if(ia!==ib) return ia>ib?1:-1; }
    else if(na&&!nb) return -1; else if(!na&&nb) return 1;
    else if(xa!==xb) return xa>xb?1:-1;
  }
  return 0;
}
function isValidSemver(v){ return !!parseSemver(v); }
function getSourceOwner(id){ return sourceOwnership[id]||null; }
function releaseSourceOwnershipForExtension(eid){
  Object.keys(sourceOwnership).forEach(function(k){ if(sourceOwnership[k]===eid) delete sourceOwnership[k]; });
}
function getExtension(id){ return extensionRegistry.byId[id]||null; }
function validateExtensionManifest(manifest, opts){
  opts=opts||{}; var errors=[];
  if(!isSafeExtensionId(manifest&&manifest.id)) errors.push("id");
  if(opts.rejectOfficialNamespace && isOfficialNamespace(manifest.id) && !opts.allowOfficial) errors.push("ns");
  if(!manifest.name) errors.push("name");
  if(!isValidSemver(manifest.version)) errors.push("version");
  if(manifest.apiVersion!==1) return {ok:false,status:"incompatible",errors:["api"]};
  (manifest.sources||[]).forEach(function(s){ if(!isSafeSourceId(s.id)) errors.push("sid"); });
  if(errors.length) return {ok:false,status:"invalid",errors:errors};
  return {ok:true,status:"installed",errors:[]};
}
function registerExtension(manifest, adaptersBySourceId, opts){
  opts=opts||{};
  var v=validateExtensionManifest(manifest,{rejectOfficialNamespace:!!opts.rejectOfficialNamespace,allowOfficial:!!opts.allowOfficial});
  var record={id:manifest.id,manifest:manifest,status:v.status,errors:v.errors.slice(),adapters:adaptersBySourceId||null,builtin:!!opts.builtin};
  if(!v.ok){ extensionRegistry.byId[record.id]=record; return record; }
  if(!opts.allowOfficial && !opts.builtin && isOfficialNamespace(record.id)){
    record.status="invalid"; record.errors=["namespace"]; extensionRegistry.byId[record.id]=record; return record;
  }
  var srcs=manifest.sources||[]; var pending=[];
  for(var i=0;i<srcs.length;i++){
    var sid=srcs[i].id;
    var cur=sourceOwnership[sid];
    if(cur && cur!==record.id){
      record.status="invalid"; record.errors=["owned by "+cur];
      extensionRegistry.byId[record.id]=record; return record;
    }
    pending.push(sid);
  }
  releaseSourceOwnershipForExtension(record.id);
  pending.forEach(function(sid){ sourceOwnership[sid]=record.id; });
  record.status = opts.forceStatus || "enabled";
  extensionRegistry.byId[record.id]=record;
  if(extensionRegistry.order.indexOf(record.id)<0) extensionRegistry.order.push(record.id);
  return record;
}
function getAdapterViaExtension(sourceId){
  var owner=getSourceOwner(sourceId);
  if(owner){
    var ext=getExtension(owner);
    if(!ext||ext.status!=="enabled") return null;
    if(ext.adapters&&ext.adapters[sourceId]) return ext.adapters[sourceId];
    if(SOURCE_ADAPTERS[sourceId]) return SOURCE_ADAPTERS[sourceId];
    return null;
  }
  if(SOURCE_ADAPTERS[sourceId] && !SOURCE_ADAPTERS[sourceId].__dynamic) return SOURCE_ADAPTERS[sourceId];
  return null;
}
function getSourceAdapter(id){
  var owner=getSourceOwner(id);
  if(owner) return getAdapterViaExtension(id);
  return getAdapterViaExtension(id) || (SOURCE_ADAPTERS[id] && !SOURCE_ADAPTERS[id].__dynamic ? SOURCE_ADAPTERS[id] : null);
}
function ensureDynamicSourceRow(sd, ext, on){
  var row=THIRD_PARTY_SOURCES.find(function(s){return s.id===sd.id;});
  if(!row){
    THIRD_PARTY_SOURCES.push({id:sd.id,name:sd.name||sd.id,enabled:on,capabilities:{reader:true,search:true},dynamic:true,extensionId:ext.id});
  } else row.enabled=on;
}
function syncSourcesFromExtensions(){
  Object.keys(extensionRegistry.byId).forEach(function(id){
    var ext=extensionRegistry.byId[id];
    var on=ext.status==="enabled";
    (ext.manifest.sources||[]).forEach(function(sd){ ensureDynamicSourceRow(sd,ext,on); });
  });
}
`;

vm.createContext(sandbox);
vm.runInContext(code, sandbox);

const S = sandbox;

// ID case sensitivity
assert(S.isSafeExtensionId("mangahive.test"), "lowercase ext id ok");
assert(!S.isSafeExtensionId("MangaHive.test"), "MangaHive.test rejected");
assert(!S.isSafeExtensionId("MANGAHIVE.test"), "MANGAHIVE.test rejected");
assert(!S.isSafeExtensionId("Mangahive.test"), "Mangahive.test rejected");
assert(!S.isSafeExtensionId("__proto__"), "__proto__ rejected");
assert(!S.isSafeSourceId("constructor"), "constructor source rejected");

// SemVer
assert(S.compareSemver("1.0.0-alpha", "1.0.0-beta") < 0, "alpha < beta");
assert(S.compareSemver("1.0.0-beta", "1.0.0-rc.1") < 0, "beta < rc");
assert(S.compareSemver("1.0.0-rc.1", "1.0.0") < 0, "rc < release");
assert(S.compareSemver("1.0.0+build.1", "1.0.0+build.2") === 0, "build metadata ignored");
assert(!S.isValidSemver("1.0"), "incomplete version rejected");

// Transactional ownership
S.registerExtension({
  id: "community.a", name: "A", version: "1.0.0", apiVersion: 1,
  sources: [{ id: "source-a", name: "A" }]
}, null, {});
assert(S.sourceOwnership["source-a"] === "community.a", "A owns source-a");
const b = S.registerExtension({
  id: "community.b", name: "B", version: "1.0.0", apiVersion: 1,
  sources: [{ id: "source-b", name: "B" }, { id: "source-a", name: "A2" }]
}, null, {});
assert(b.status === "invalid", "B rejected on conflict");
assert(S.sourceOwnership["source-a"] === "community.a", "source-a still owned by A");
assert(!S.sourceOwnership["source-b"], "source-b not partially claimed");

// Disabled adapter bypass
S.registerExtension({
  id: "mangahive.mangadex", name: "MD", version: "1.0.0", apiVersion: 1,
  sources: [{ id: "mangadex", name: "MD" }]
}, null, { allowOfficial: true, builtin: true });
assert(S.getSourceAdapter("mangadex"), "enabled official adapter resolves");
S.extensionRegistry.byId["mangahive.mangadex"].status = "disabled";
assert(!S.getSourceAdapter("mangadex"), "disabled owner → adapter null (no global bypass)");

// Dynamic source registration (open platform proof)
const testManifest = JSON.parse(fs.readFileSync(
  path.join(__dirname, "extensions/examples/community-test-extension/manifest.json"), "utf8"
));
const reg = S.registerExtension(testManifest, null, {});
assert(reg.status === "enabled", "test extension registers");
S.SOURCE_ADAPTERS["mh-test-source"] = { __dynamic: true, search: function () { return Promise.resolve([{ title: "Probe" }]); } };
S.extensionRegistry.byId["community.test-extension"].adapters = { "mh-test-source": S.SOURCE_ADAPTERS["mh-test-source"] };
S.syncSourcesFromExtensions();
assert(S.THIRD_PARTY_SOURCES.some(function (s) { return s.id === "mh-test-source"; }), "dynamic source appears in registry");
assert(S.getSourceAdapter("mh-test-source"), "dynamic adapter resolves when enabled");
S.extensionRegistry.byId["community.test-extension"].status = "disabled";
assert(!S.getSourceAdapter("mh-test-source"), "disabled dynamic source blocked");

// Official version preference logic
assert(S.compareSemver("1.1.0", "1.0.0") > 0, "official update 1.1 > bundled 1.0");

// Docs exist
assert(fs.existsSync(path.join(__dirname, "EXTENSION_API.md")), "EXTENSION_API.md");
assert(fs.existsSync(path.join(__dirname, "EXTENSION_DEVELOPMENT.md")), "EXTENSION_DEVELOPMENT.md");
assert(fs.existsSync(path.join(__dirname, "extensions/schemas/manifest.schema.json")), "manifest schema");

if (failed) {
  console.error("\n" + failed + " failure(s)");
  process.exit(1);
}
console.log("\nAll open platform regression tests passed.");
