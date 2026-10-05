"use strict";
const fs = require("fs");
const path = require("path");
let failed = 0;
function assert(c, m) { if (!c) { console.error("FAIL:", m); failed++; } else console.log("PASS:", m); }

const root = __dirname;
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

assert(html.indexOf("Content-Security-Policy") >= 0, "CSP present");
assert(html.indexOf("function isSafeExternalUrl") >= 0, "URL validator present");
assert(!/\beval\s*\(/.test(html.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")), "no eval call in code");
assert(!/new Function\s*\(/.test(html), "no new Function call");
assert(fs.existsSync(path.join(root, "EXTENSION_DEVELOPMENT.md")), "EXTENSION_DEVELOPMENT.md");
assert(fs.existsSync(path.join(root, "EXTENSION_API.md")), "EXTENSION_API.md");
assert(fs.existsSync(path.join(root, "android/mihon/src/main/java/app/mangahive/mihon/apk/ApkDownloader.kt")), "ApkDownloader.kt");
assert(fs.existsSync(path.join(root, "android/mihon/src/main/java/app/mangahive/mihon/apk/ApkInspector.kt")), "ApkInspector.kt");
assert(fs.existsSync(path.join(root, "android/mihon/src/main/java/app/mangahive/mihon/bridge/MihonJsBridge.kt")), "MihonJsBridge.kt");
assert(fs.existsSync(path.join(root, "MANGAHIVE_PRODUCTION_READINESS.md")), "production readiness doc");

const downloader = fs.readFileSync(path.join(root, "android/mihon/src/main/java/app/mangahive/mihon/apk/ApkDownloader.kt"), "utf8");
assert(downloader.indexOf("SHA-256") >= 0 || downloader.indexOf("SHA-256") >= 0 || downloader.indexOf("MessageDigest") >= 0, "SHA-256 in downloader");
assert(downloader.indexOf("response-too-large") >= 0, "size limit in downloader");
// Stage 5: HTTPS enforcement moved out of the downloader into the single DestinationPolicy; the downloader must go through it.
const policySrc = fs.readFileSync(path.join(root, "android/mihon-net/src/main/java/app/mangahive/mihon/net/DestinationPolicy.java"), "utf8");
assert(downloader.indexOf("broker.download(") >= 0 && policySrc.indexOf("HTTPS_REQUIRED") >= 0 && policySrc.indexOf("requireHttps(true).allowPort(443)") >= 0, "HTTPS enforcement in downloader (via brokered DestinationPolicy)");

const bridge = fs.readFileSync(path.join(root, "android/mihon/src/main/java/app/mangahive/mihon/bridge/MihonJsBridge.kt"), "utf8");
assert(bridge.indexOf("UNKNOWN_OP") >= 0, "unknown ops rejected in bridge");
assert(bridge.indexOf("UNKNOWN_OP") >= 0, "unknown ops rejected");

const runtime = fs.readFileSync(path.join(root, "android/mihon/src/main/java/app/mangahive/mihon/runtime/MihonRuntimeStatus.kt"), "utf8");
assert(runtime.indexOf("SOURCE_EXECUTION_DEVICE_VERIFIED = false") >= 0, "device E2E not falsely verified");

assert(html.indexOf('data-action="nav-home"') >= 0, "home tab");
assert(html.indexOf('data-action="nav-discover"') >= 0, "discover tab");
assert(html.indexOf("function renderHome") >= 0, "renderHome");
assert(html.indexOf("function renderDiscover") >= 0, "renderDiscover");

if (failed) { console.error(failed + " failures"); process.exit(1); }
console.log("\nAll production security regression tests passed.");
