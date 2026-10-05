"use strict";
const fs = require("fs");
const path = require("path");
let failed = 0;
function assert(c, m) { if (!c) { console.error("FAIL:", m); failed++; } else console.log("PASS:", m); }
const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
assert(html.indexOf("Content-Security-Policy") >= 0, "CSP present");
assert(html.indexOf("./vendor-supabase.js") >= 0, "local vendor supabase");
assert(html.indexOf("__MANGAHIVE_DEV_CDN__") >= 0 || html.indexOf("mh_dev_cdn") >= 0, "CDN gated to dev");
// Profile tab must not host dm-tab-badge
const profileChunk = html.split('data-action="nav-profile"')[1] || "";
const profileBtn = profileChunk.slice(0, 400);
assert(profileBtn.indexOf("dm-tab-badge") < 0, "no dm badge on Profile tab");
assert(html.indexOf("community-tab-badge") >= 0, "community badge exists");
assert(html.indexOf("Plan to Read") >= 0, "library Plan to Read label");
assert(html.indexOf("Completed") >= 0, "library Completed label");
assert(html.indexOf("Android only") >= 0 || html.indexOf("Native runtime required") >= 0, "Mihon Android-only labeling");
assert(html.indexOf("function renderHome") >= 0, "renderHome");
assert(html.indexOf("function renderDiscover") >= 0, "renderDiscover");
assert(html.indexOf("Start reading") >= 0 || html.indexOf("Continue reading") >= 0, "home continue/start");
assert(html.indexOf("Searches your enabled sources") >= 0, "discover helper text");
assert(!/\beval\s*\(/.test(html.replace(/\/\*[\s\S]*?\*\//g,"").replace(/\/\/.*$/gm,"")), "no eval");
if (failed) { console.error(failed + " failures"); process.exit(1); }
console.log("\nUX audit regression tests passed.");
