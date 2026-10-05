"use strict";
const fs = require("fs");
const { URL } = require("url");
const path = require("path");
let failed = 0;
function assert(c, m) { if (!c) { console.error("FAIL:", m); failed++; } else console.log("PASS:", m); }

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
function extract(name) {
  const key = "function " + name;
  let i = html.indexOf(key);
  if (i < 0) throw new Error("missing " + name);
  let j = html.indexOf("\n  function ", i + 10);
  let k = html.indexOf("\n  var ", i + 10);
  let end = Math.min(j > 0 ? j : 1e12, k > 0 ? k : 1e12);
  return html.slice(i, end);
}
const names = [
  "isSafeSourceId","isSafeExtensionId","isOfficialNamespace","normalizeMihonPackageId",
  "mihonPackageToExtensionId","normalizeMihonSourceId","classifyMihonCompatibility",
  "normalizeMihonExtensionEntry","detectRepositoryFormat","parseMihonRepositoryIndex"
];
const prelude = `
const REPOSITORY_API_VERSION = 1;
const RESERVED_SOURCE_KEYS = { __proto__: 1, constructor: 1, prototype: 1, toString: 1, valueOf: 1 };
function logError() {}
const URL = global.URL;
`;
const body = names.map(extract).join("\n");
const fn = new Function("global", prelude + body + `
return {
  detectRepositoryFormat,
  parseMihonRepositoryIndex,
  normalizeMihonExtensionEntry,
  classifyMihonCompatibility
};
`);
global.URL = URL;
const api = fn(global);

assert(html.indexOf("yuzono/manga-repo/repo/index.min.json") >= 0, "default yuzono URL in UI");
assert(html.indexOf("mihon-repo-add") >= 0, "add repo action");
assert(html.indexOf("refreshMihonRepository") >= 0, "refresh function");

const REPO = "https://raw.githubusercontent.com/yuzono/manga-repo/repo/index.min.json";

function run(json, label) {
  assert(api.detectRepositoryFormat(json) === "mihon", label + " detect mihon format");
  const parsed = api.parseMihonRepositoryIndex(json, REPO);
  assert(parsed.ok === true, label + " parse ok");
  assert(parsed.extensions.length === 2, label + " two notice entries");
  parsed.extensions.forEach(function (ex) {
    assert(!!ex.extensionId, label + " extensionId " + ex.name);
    assert(ex.extensionId.indexOf("mihon.") === 0, label + " mihon namespace");
    assert(ex.compatibility === "unsupported", label + " notice unsupported: " + ex.name);
    assert(ex.apkUrl && ex.apkUrl.indexOf("https://") === 0, label + " https apk");
  });
}

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "tests", "fixtures", "yuzono", "yuzono-index.min.json"), "utf8"));
run(fixture, "fixture");

// No live fetch: the test is deterministic and offline (fixture lives in tests/fixtures/yuzono/, see its README).
if (failed) { console.error(failed + " failures"); process.exit(1); }
console.log("\nYuzono Mihon repo tests passed (repository fixture, no network).");
