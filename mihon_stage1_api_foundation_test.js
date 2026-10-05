"use strict";
// Stage 1 invariants for the real Mihon/Tachiyomi API foundation.
// Scope: repository-level facts that can be checked without Gradle. This does NOT compile Kotlin and does NOT
// prove upstream compatibility; the compile gate is android/mihon-compat (see verify-pins.sh).
const fs = require("fs");
const path = require("path");
let failed = 0;
function assert(c, m) { if (!c) { console.error("FAIL:", m); failed++; } else console.log("PASS:", m); }
const root = __dirname;
const rd = (p) => fs.readFileSync(path.join(root, p), "utf8");
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "build" && e.name !== ".gradle") walk(f, out); } else out.push(f);
  }
  return out;
}
const android = path.join(root, "android");
const all = walk(android);
const rel = (f) => path.relative(root, f);

// 1. Pins
const toml = rd("android/mihon-compat/gradle/libs.versions.toml");
assert(/module = "com\.github\.mihonapp:tachiyomix", version\.ref = "tachiyomix16"/.test(toml) && /tachiyomix16 = "1\.6\.0"/.test(toml), "tachiyomix 1.6.0 artifact pinned in version catalog (JitPack: 1.6 is 404, 1.6.0 resolves)");
assert(/kotlin = "2\.4\.0"/.test(toml) && /okhttp = "5\.5\.0"/.test(toml) && /coroutines = "1\.11\.0"/.test(toml), "host dependency pins present");
assert(!/[:"]\s*(latest|\+|SNAPSHOT)/i.test(toml.replace(/#.*$/gm, "")), "no floating versions in catalog");

// 2. The real-API build never depends on the MangaHive :mihon module
const compatGradle = all.filter((f) => rel(f).startsWith("android/mihon-compat") && f.endsWith(".kts"));
assert(compatGradle.length >= 3, "mihon-compat build files found");
assert(compatGradle.every((f) => !/project\(\s*":mihon"\s*\)/.test(fs.readFileSync(f, "utf8").replace(/\/\/.*$/gm, ""))), "mihon-compat never uses project(':mihon')");
assert(/includeGroup\("com\.github\.mihonapp"\)/.test(rd("android/mihon-compat/settings.gradle.kts")), "JitPack restricted to the upstream group");

// 3. Only :app compiles against :mihon (Stage 6.6A deleted android/internal-probe, which only exercised the old stubs)
const projDeps = all.filter((f) => f.endsWith("build.gradle.kts") && /project\(\s*":mihon"\s*\)/.test(fs.readFileSync(f, "utf8").replace(/\/\/.*$/gm, "")));
const projDepNames = projDeps.map(rel).sort();
assert(JSON.stringify(projDepNames) === JSON.stringify(["android/app/build.gradle.kts"]), "only :app depends on :mihon (got " + projDepNames.join(",") + ")");
assert(!fs.existsSync(path.join(android, "test-extension")), "old Mihon-looking test-extension module removed");
assert(!/test-extension/.test(rd("android/settings.gradle.kts")), "root settings no longer include test-extension");
assert(!fs.existsSync(path.join(android, "internal-probe")) && !/internal-probe/.test(rd("android/settings.gradle.kts")), "Stage 6.6A: internal-probe removed");

// 4. Stage 6.6A: no inert eu.kanade stubs in :mihon; the one host implementation lives in the compat bundle
const stubs = all.filter((f) => /android\/mihon\/src\/main\/java\/eu\/kanade\//.test(f.split(path.sep).join("/")));
assert(stubs.length === 0, "no local eu.kanade stub files remain in :mihon (got " + stubs.length + ")");
const hostApi = all.filter((f) => /android\/mihon-compat\/gateway\/src\/main\/kotlin\/eu\/kanade\/tachiyomi\//.test(f.split(path.sep).join("/")));
assert(hostApi.length >= 20, "host eu.kanade.tachiyomi.* implementation present in mihon-compat/gateway (" + hostApi.length + " files)");
assert(hostApi.every((f) => !/MANGAHIVE INTERNAL STUB|throw Exception\("Stub!"\)/.test(fs.readFileSync(f, "utf8"))), "host API files are implementations, not stubs");
assert(!fs.existsSync(path.join(root, "android/mihon/src/main/java/app/mangahive/mihon/runtime/ControlledSource.kt")), "Stage 4: ControlledSource (second execution path) is deleted");
const status = rd("android/mihon/src/main/java/app/mangahive/mihon/runtime/MihonRuntimeStatus.kt");
for (const k of ["UPSTREAM_API_RUNTIME_COMPATIBLE", "CLASSLOADER_RUNTIME_READY", "HTTP_SOURCE_API", "SOURCE_EXECUTION_CODE_READY", "SOURCE_EXECUTION_DEVICE_VERIFIED"]) {
  assert(new RegExp("const val " + k + " = false").test(status), "status flag false: " + k);
}
assert(!/mangahive-mihon-httpsource/.test(rd("android/mihon/src/main/java/app/mangahive/mihon/runtime/MihonCompatibilityProfile.kt")), "legacy profile id no longer claims Mihon httpsource");

// 5. Profiles exist and are honest
const prof = rd("android/mihon/src/main/java/app/mangahive/mihon/compat/MihonApiProfile.kt");
assert(/val MIHON_1_6 = /.test(prof) && /val MIHON_1_4 = /.test(prof), "MIHON_1_6 and MIHON_1_4 defined");
assert((prof.match(/runtimeImplemented = true/g) || []).length === 0, "no profile sets runtimeImplemented = true");
assert(/Pin\(\s*null,\s*"UNRESOLVED/.test(prof), "unresolved pins are explicit");

// 6. Docs
const doc = rd("MIHON_API_PROFILES.md");
for (const needle of ["MIHON_1_6", "MIHON_1_4", "com.github.mihonapp:tachiyomix:1.6", "KeiSource", "Unresolved", "not part of", "Mihon v0.20.0"]) {
  assert(doc.includes(needle), "MIHON_API_PROFILES.md mentions: " + needle);
}
// (Stage 4) ControlledSource removed; nothing left to mislabel.
assert(/Do not claim|no .*runtime compatibility|NOT claimed|not claimed/i.test(doc), "doc states runtime compatibility is not claimed");

// 7. No fake runtime added in Stage 1
// Stage 3: the runtime gateway lives in android/mihon-compat/gateway on purpose; the invariant covers the shape modules only.
const compatSrc = all.filter((f) => /^android\/mihon-compat\/shapes-/.test(rel(f).split(path.sep).join("/")) && f.endsWith(".kt"));
assert(compatSrc.every((f) => !/PathClassLoader|DexClassLoader|runBlocking|Class\.forName/.test(fs.readFileSync(f, "utf8"))), "compat shapes contain no loader/runtime code");

if (failed) { console.error(failed + " failures"); process.exit(1); }
console.log("\nStage 1 API foundation invariants passed (repository-level only; Kotlin compile gate NOT run here).");
