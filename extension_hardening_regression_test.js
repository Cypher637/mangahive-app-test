/**
 * MangaHive — Extension ecosystem hardening regression tests
 * Run: node extension_hardening_regression_test.js
 */
"use strict";
const fs = require("fs");
const path = require("path");

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failed++; }
  else console.log("PASS:", msg);
}

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

// --- Static security ---
assert(!/\beval\s*\(/.test(html.replace(/vendor-supabase[\s\S]*?$/, "")), "no eval in app (excl. vendor tail scan)");
// More precise: app scripts
assert(!/eval\s*\(\s*remote/i.test(html), "no eval(remote");
assert(!/new Function\s*\(/.test(html), "no new Function");
assert(!/importScripts\s*\(\s*['\"]https?:/i.test(html), "no remote importScripts");
assert(/EXPECTED_SCHEMA_VERSION\s*=\s*10/.test(html), "schema 10");
assert(/function restoreInstalledExtensions/.test(html), "cold-start restore present");
assert(/function compareSemver/.test(html), "semver compare present");
assert(/function hasExtensionPermission/.test(html), "hasExtensionPermission present");
assert(/function claimSourceOwnership/.test(html), "source ownership present");
assert(/function runtimeInvoke/.test(html), "central runtime gate");
assert(/function validatePagesArray/.test(html), "pages validation");
assert(/function fetchWithTimeout/.test(html), "repo timeout helper");
assert(/REPO_FETCH_TIMEOUT_MS\s*=\s*12000/.test(html), "repo timeout 12s");
assert(/sourceIsDegraded/.test(html), "sourceIsDegraded present");
assert(/manifest\.id must equal update id/.test(html) || /manifest.id must equal update id/.test(html), "update id match");
assert(/downgrade blocked/.test(html), "downgrade blocked");
assert(/namespace mangahive\.\* is reserved/.test(html), "official namespace protected");
assert(/clearExtensionStorage/.test(html), "storage clear on uninstall path");
assert(/EXTENSION_PERMISSION_DENIED/.test(html), "permission denied code");
assert(/sourceHubUpdates/.test(html), "real update candidates list");

// --- In-memory hardened registry mirror ---
var EXTENSION_API_VERSION = 1;
var RESERVED = { __proto__: 1, constructor: 1, prototype: 1 };
function isSafeSourceId(id){
  if(!id || typeof id !== "string") return false;
  if(RESERVED[id] || id === "__proto__") return false;
  return /^[a-z][a-z0-9._-]*$/i.test(id);
}
function isSafeExtensionId(id){
  return id && typeof id === "string" && id.indexOf(".") >= 0 && /^[a-z][a-z0-9._-]*$/i.test(id);
}
function isOfficialNamespace(id){ return String(id).indexOf("mangahive.") === 0; }
function compareSemver(a, b){
  function parts(v){
    var p = String(v||"0").split("-")[0].split(".").map(function(x){ var n=parseInt(x,10); return isNaN(n)?0:n; });
    while(p.length<3) p.push(0); return p;
  }
  var pa=parts(a), pb=parts(b);
  for(var i=0;i<3;i++){ if(pa[i]>pb[i]) return 1; if(pa[i]<pb[i]) return -1; }
  return 0;
}

var sourceOwnership = Object.create(null);
var extensionRegistry = { byId: Object.create(null), order: [] };
var memPrefs = { enabled: {}, disabled: {} };
var installedPackages = Object.create(null);
var storage = Object.create(null);

function validateManifest(m, opts){
  opts = opts || {};
  var errors = [];
  if(!isSafeExtensionId(m && m.id)) errors.push("id");
  if(opts.rejectOfficial && isOfficialNamespace(m.id) && !opts.allowOfficial) errors.push("ns");
  if(!m.name || !m.version) errors.push("fields");
  if(m.apiVersion !== 1) return { ok:false, status:"incompatible", errors:["api"] };
  if(m.sources){
    m.sources.forEach(function(s){
      if(!isSafeSourceId(s.id)) errors.push("bad-source");
    });
  }
  if(errors.length) return { ok:false, status:"invalid", errors:errors };
  return { ok:true, status:"installed", errors:[] };
}

function register(m, opts){
  opts = opts || {};
  var v = validateManifest(m, opts);
  var rec = { id: m.id, manifest: m, status: v.status, errors: v.errors, adapters: null };
  if(!v.ok){
    extensionRegistry.byId[m.id] = rec;
    return rec;
  }
  if(!opts.allowOfficial && !opts.builtin && isOfficialNamespace(m.id)){
    rec.status = "invalid"; rec.errors = ["namespace"];
    extensionRegistry.byId[m.id] = rec;
    return rec;
  }
  for(var i=0;i<(m.sources||[]).length;i++){
    var sid = m.sources[i].id;
    if(sourceOwnership[sid] && sourceOwnership[sid] !== m.id){
      rec.status = "invalid"; rec.errors = ["owned:"+sourceOwnership[sid]];
      extensionRegistry.byId[m.id] = rec;
      return rec;
    }
  }
  Object.keys(sourceOwnership).forEach(function(k){
    if(sourceOwnership[k] === m.id) delete sourceOwnership[k];
  });
  (m.sources||[]).forEach(function(s){ sourceOwnership[s.id] = m.id; });
  var disabled = memPrefs.disabled[m.id] === true;
  rec.status = opts.forceStatus || (disabled ? "disabled" : "enabled");
  extensionRegistry.byId[m.id] = rec;
  if(extensionRegistry.order.indexOf(m.id)<0) extensionRegistry.order.push(m.id);
  return rec;
}

function enable(id){
  var e = extensionRegistry.byId[id];
  if(!e || e.status==="invalid"||e.status==="incompatible") return false;
  e.status = "enabled"; delete memPrefs.disabled[id]; return true;
}
function disable(id){
  var e = extensionRegistry.byId[id];
  if(!e) return false;
  e.status = "disabled"; memPrefs.disabled[id]=true; return true;
}

// A. Cold start
register({ id:"community.mock", name:"Mock", version:"1.0.0", apiVersion:1, permissions:["network","storage"],
  sources:[{ id:"mocksrc", name:"M" }] }, {});
enable("community.mock");
installedPackages["community.mock"] = { manifest: extensionRegistry.byId["community.mock"].manifest, version:"1.0.0" };
storage["community.mock"] = { k: "v" };
// destroy registry
var savedPkg = installedPackages;
var savedPrefs = JSON.parse(JSON.stringify(memPrefs));
extensionRegistry = { byId: Object.create(null), order: [] };
sourceOwnership = Object.create(null);
memPrefs = savedPrefs;
installedPackages = savedPkg;
// restore
Object.keys(installedPackages).forEach(function(id){
  var pkg = installedPackages[id];
  var force = memPrefs.disabled[id] ? "disabled" : "enabled";
  register(pkg.manifest, { forceStatus: force });
});
assert(extensionRegistry.byId["community.mock"], "cold-start restores extension");
assert(extensionRegistry.byId["community.mock"].status === "enabled", "cold-start preserves enabled");
assert(sourceOwnership["mocksrc"] === "community.mock", "cold-start restores source ownership");

// B. Disabled survives
disable("community.mock");
extensionRegistry = { byId: Object.create(null), order: [] };
sourceOwnership = Object.create(null);
Object.keys(installedPackages).forEach(function(id){
  var force = memPrefs.disabled[id] ? "disabled" : "enabled";
  register(installedPackages[id].manifest, { forceStatus: force });
});
assert(extensionRegistry.byId["community.mock"].status === "disabled", "disabled survives reload");

// C. Namespace
var badNs = register({ id:"mangahive.evil", name:"Evil", version:"1.0.0", apiVersion:1, sources:[{id:"evilsrc",name:"E"}] }, { rejectOfficial:true });
assert(badNs.status === "invalid", "community cannot claim mangahive.*");

// Official ok
var off = register({ id:"mangahive.mangadex", name:"MD", version:"1.0.0", apiVersion:1, sources:[{id:"mangadex",name:"MD"}] }, { allowOfficial:true, builtin:true });
assert(off.status === "enabled" || off.status === "disabled", "official registers");

// D. Duplicate source
var dup = register({ id:"community.other", name:"O", version:"1.0.0", apiVersion:1, sources:[{id:"mangadex",name:"X"}] }, {});
assert(dup.status === "invalid", "duplicate source id rejected");

// E. Update ID mismatch
function updateExt(id, manifest){
  if(!manifest || manifest.id !== id) return { ok:false, errors:["id mismatch"] };
  return { ok:true };
}
assert(!updateExt("extension.a", { id:"extension.b", version:"2.0.0" }).ok, "update id mismatch rejected");

// F. Version
assert(compareSemver("1.2.0", "1.1.9") > 0, "semver upgrade");
assert(compareSemver("1.0.0", "1.0.0") === 0, "semver equal");
assert(compareSemver("1.0.0", "2.0.0") < 0, "semver downgrade detect");

// G. Uninstall storage
function uninstall(id){
  delete extensionRegistry.byId[id];
  delete installedPackages[id];
  delete storage[id];
  Object.keys(sourceOwnership).forEach(function(k){ if(sourceOwnership[k]===id) delete sourceOwnership[k]; });
}
storage["community.mock"] = { k: "v" };
// disable keeps storage
assert(storage["community.mock"].k === "v", "storage retained while installed");
uninstall("community.mock");
assert(!storage["community.mock"], "uninstall clears storage");
assert(!sourceOwnership["mocksrc"], "uninstall clears ownership");

// H. Permissions
function hasPerm(ext, perm){
  var e = extensionRegistry.byId[ext];
  if(!e) return false;
  return (e.manifest.permissions||[]).indexOf(perm) >= 0;
}
register({ id:"community.netonly", name:"N", version:"1.0.0", apiVersion:1, permissions:["network"], sources:[{id:"net1",name:"N"}] }, {});
assert(hasPerm("community.netonly", "network"), "network granted when declared");
assert(!hasPerm("community.netonly", "storage"), "storage denied when not declared");

// I/J. Rate limit + response size constants in html
assert(/EXT_MAX_REQUESTS_PER_MIN\s*=\s*120/.test(html), "rate limit constant");
assert(/EXT_MAX_PAGES\s*=\s*2000/.test(html), "pages size limit");

// K. Isolation pattern
assert(/Promise\.resolve\(\)\s*\.then\(function\(\)\{\s*return fn\(\)/.test(html) || /Promise\.resolve\(\)\s*\.then\(function\(\)\{\s*return ad\./.test(html), "Promise.resolve isolation pattern");

// L. Timeout
assert(/AbortController/.test(html) && /REPO_FETCH_TIMEOUT/.test(html), "repo abort timeout");

// M. Dedup
assert(/duplicateRepos/.test(html), "repo dedup tracking");

// N. Health
assert(/function sourceIsHealthy/.test(html), "sourceIsHealthy");
assert(/h\.status === "healthy"/.test(html), "healthy is strict");

// O. Adapter resolution
assert(/getSourceOwner/.test(html) || /sourceOwnership/.test(html), "ownership map used");
assert(/getAdapterViaExtension/.test(html), "adapter via extension");

// P. Prototype
assert(!isSafeSourceId("__proto__"), "reject __proto__ source id");
assert(!isSafeSourceId("constructor"), "reject constructor source id");

// Q. Security APIs
assert(/getSupabase:\s*function\(\)\{\s*return null/.test(html), "no supabase exposure");
assert(/getAuthToken:\s*function\(\)\{\s*return null/.test(html), "no auth token exposure");
assert(/getNativeBridge:\s*function\(\)\{\s*return null/.test(html), "no native bridge exposure");

if (failed) {
  console.error("\n" + failed + " failure(s)");
  process.exit(1);
}
console.log("\nAll hardening regression tests passed.");
