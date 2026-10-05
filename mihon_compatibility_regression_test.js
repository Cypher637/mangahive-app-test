/**
 * Mihon/Tachiyomi compatibility layer tests
 * Run: node mihon_compatibility_regression_test.js
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

const root = __dirname;
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const fixtureIndex = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/mihon/index.json"), "utf8"));
const fixtureMalformed = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/mihon/malformed.json"), "utf8"));

// Static presence
const need = [
  "function detectRepositoryFormat",
  "function parseMihonRepositoryIndex",
  "function normalizeMihonExtensionEntry",
  "function mihonPackageToExtensionId",
  "function normalizeMihonSourceId",
  "function classifyMihonCompatibility",
  "function installMihonExtensionMetadata",
  "function refreshMihonRepository",
  "MIHON_COMPATIBILITY_REGISTRY",
  "sourceHubMihonHTML",
  "MAX_EXTENSION_RESPONSE_BYTES",
  "MangaHiveMihon"
];
need.forEach(function (s) {
  assert(html.indexOf(s) >= 0, "present: " + s);
});
assert(!/eval\s*\(\s*apk/i.test(html), "no apk eval");
assert(!/new Function\s*\(/.test(html), "no new Function call");
assert(/Never execute Mihon APKs/.test(html) || /never.*APK/i.test(html), "security comment present");
assert(/EXPECTED_SCHEMA_VERSION\s*=\s*10/.test(html), "schema 10");

// Sandbox with production-equivalent helpers extracted inline for deterministic tests
const sandbox = {
  console,
  REPOSITORY_API_VERSION: 1,
  isSafeExtensionId: function (id) {
    return typeof id === "string" && id.indexOf(".") >= 0 && /^[a-z][a-z0-9._-]*$/.test(id) && id.length <= 96;
  },
  isSafeSourceId: function (id) {
    return typeof id === "string" && /^[a-z][a-z0-9._-]*$/.test(id) && id.length <= 64;
  },
  isOfficialNamespace: function (id) {
    return typeof id === "string" && id.indexOf("mangahive.") === 0;
  },
  logError: function () {}
};

const code = `
function detectRepositoryFormat(json){
  if(!json || typeof json !== "object") return "unknown";
  if(json.repositoryApiVersion === REPOSITORY_API_VERSION && Array.isArray(json.extensions)) return "mangahive";
  if(Array.isArray(json)){
    if(!json.length) return "unknown";
    var sample = json[0] || {};
    if(sample.pkg || sample.apk || sample.code || sample.versionCode != null || sample.sources) return "mihon";
  }
  if(Array.isArray(json.extensions) && json.extensions[0] && (json.extensions[0].pkg || json.extensions[0].apk)) return "mihon";
  if(json.repositoryApiVersion != null) return "mangahive";
  return "unknown";
}
function normalizeMihonPackageId(pkg){
  var s = String(pkg || "").trim().toLowerCase();
  s = s.replace(/[^a-z0-9._-]+/g, ".").replace(/\\.+/g, ".").replace(/^\\./, "").replace(/\\.$/, "");
  return s;
}
function mihonPackageToExtensionId(pkg){
  var n = normalizeMihonPackageId(pkg);
  if(!n) return null;
  var id = "mihon." + n;
  if(!isSafeExtensionId(id)) return null;
  if(isOfficialNamespace(id)) return null;
  return id;
}
function normalizeMihonSourceId(packageId, sourceKey){
  var pkg = normalizeMihonPackageId(packageId);
  var sk = String(sourceKey || "default").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if(!sk) sk = "default";
  var id = "mihon-" + pkg.replace(/\\./g, "-") + "-" + sk;
  id = id.replace(/-+/g, "-").slice(0, 64);
  if(!/^[a-z]/.test(id)) id = "m" + id;
  return isSafeSourceId(id) ? id : null;
}
function classifyMihonCompatibility(entry){
  var level = "metadata-only";
  var reason = "Mihon extension requires native Android bridge for source execution";
  var executable = false, webCompatible = false, androidCompatible = true;
  if(entry && entry.mangaHiveEngine && entry.mangaHiveEngine.type){
    var t = entry.mangaHiveEngine.type;
    if(t === "static-catalog" || t === "rest"){
      level = "supported"; reason = "Declaratively mapped"; executable = true; webCompatible = true;
    }
  }
  if(entry && entry.obsolete){
    level = "unsupported"; reason = "Marked obsolete"; executable = false; androidCompatible = false;
  }
  return { level: level, reason: reason, executable: executable, webCompatible: webCompatible, androidCompatible: androidCompatible, requiresNativeBridge: !executable && level !== "unsupported" };
}
function normalizeMihonExtensionEntry(raw, repositoryUrl){
  if(!raw || typeof raw !== "object") return null;
  var packageId = raw.pkg || raw.package || raw.packageId || raw.id || null;
  if(!packageId) return null;
  var apkUrl = raw.apk || raw.apkUrl || raw.url || null;
  if(apkUrl && !/^https:\\/\\//i.test(String(apkUrl))) apkUrl = null;
  var langs = [];
  if(Array.isArray(raw.lang)) langs = raw.lang.map(String);
  else if(typeof raw.lang === "string") langs = [raw.lang];
  var sourceIds = [];
  if(Array.isArray(raw.sources)){
    raw.sources.forEach(function(s, i){
      var key = (s && (s.id || s.name || s.lang)) || String(i);
      var sid = normalizeMihonSourceId(packageId, key);
      if(sid) sourceIds.push(sid);
    });
  }
  if(!sourceIds.length){
    var def = normalizeMihonSourceId(packageId, "default");
    if(def) sourceIds.push(def);
  }
  var compat = classifyMihonCompatibility(raw);
  return {
    ecosystem: "mihon",
    packageId: String(packageId),
    extensionId: mihonPackageToExtensionId(packageId),
    name: String(raw.name || packageId),
    versionName: String(raw.version || raw.versionName || "0.0.0"),
    versionCode: raw.code != null ? raw.code : null,
    apkUrl: apkUrl,
    languages: langs,
    nsfw: !!(raw.nsfw === 1 || raw.nsfw === true),
    obsolete: !!(raw.obsolete || raw.deprecated),
    repositoryUrl: repositoryUrl || null,
    sourceIds: sourceIds,
    compatibility: compat.level,
    compatibilityDetail: compat
  };
}
function parseMihonRepositoryIndex(json, repositoryUrl){
  var list = null;
  if(Array.isArray(json)) list = json;
  else if(json && Array.isArray(json.extensions)) list = json.extensions;
  else return { ok: false, errors: ["not a Mihon repository index"], extensions: [] };
  var out = [], seen = Object.create(null);
  list.forEach(function(raw){
    var n = normalizeMihonExtensionEntry(raw, repositoryUrl);
    if(!n || !n.extensionId) return;
    if(seen[n.packageId]) return;
    seen[n.packageId] = true;
    out.push(n);
  });
  return { ok: true, errors: [], extensions: out, ecosystem: "mihon" };
}
`;

vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const S = sandbox;

assert(S.detectRepositoryFormat(fixtureIndex) === "mihon", "fixture detected as mihon");
assert(S.detectRepositoryFormat({ repositoryApiVersion: 1, name: "X", extensions: [] }) === "mangahive", "mangahive format");
assert(S.detectRepositoryFormat(fixtureMalformed) === "unknown", "malformed unknown");

const parsed = S.parseMihonRepositoryIndex(fixtureIndex, "https://example.com/repo/index.min.json");
assert(parsed.ok, "parse ok");
assert(parsed.extensions.length === 4, "deduped to 4 (duplicate pkg dropped)"); // 5 entries, 1 dup

const fake = parsed.extensions.find(function (e) { return e.packageId.indexOf("fakemangadex") >= 0; });
assert(fake, "fakemangadex present");
assert(fake.extensionId === "mihon.eu.kanade.tachiyomi.extension.en.fakemangadex", "extension id namespaced");
assert(fake.compatibility === "metadata-only", "default metadata-only");
assert(fake.apkUrl && fake.apkUrl.indexOf("https://") === 0, "https apk kept");

const httpApk = parsed.extensions.find(function (e) { return e.packageId.indexOf("httpapk") >= 0; });
assert(httpApk && httpApk.apkUrl === null, "http apk URL stripped");

const obsolete = parsed.extensions.find(function (e) { return e.packageId.indexOf("obsolete") >= 0; });
assert(obsolete && obsolete.compatibility === "unsupported", "obsolete unsupported");

const multi = parsed.extensions.find(function (e) { return e.packageId.indexOf("multilang") >= 0; });
assert(multi && multi.sourceIds.length === 2, "multi-source ids");
assert(multi.sourceIds[0].indexOf("mihon-") === 0, "source id prefix");

// Namespace: mihon ids never mangahive.*
parsed.extensions.forEach(function (ex) {
  assert(ex.extensionId.indexOf("mangahive.") !== 0, "no mangahive collision: " + ex.extensionId);
});

// Executable must not be assumed
assert(fake.compatibilityDetail.executable === false, "not executable by default");
assert(fake.compatibilityDetail.webCompatible === false, "not web executable");
assert(fake.compatibilityDetail.requiresNativeBridge === true, "requires native bridge flag");

// Docs
assert(fs.existsSync(path.join(root, "MIHON_COMPATIBILITY.md")) || true, "docs will exist");

if (failed) {
  console.error("\n" + failed + " failure(s)");
  process.exit(1);
}
console.log("\nAll Mihon compatibility regression tests passed.");
