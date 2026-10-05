"use strict";
// Stage 4 invariants: extension process isolation + IPC.
// STATIC checks over the source tree. They prove the structure is what the design says it is.
// They do NOT compile Kotlin, do NOT run the service, and do NOT prove behaviour on a device.
const fs = require("fs");
const path = require("path");
let failed = 0;
function assert(c, m) { if (!c) { console.error("FAIL:", m); failed++; } else console.log("PASS:", m); }
const root = __dirname;
const android = path.join(root, "android");
const rd = (p) => fs.readFileSync(path.join(root, p), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "build" && e.name !== ".gradle") walk(f, out); } else out.push(f);
  }
  return out;
}
const rel = (f) => path.relative(root, f).split(path.sep).join("/");
const all = walk(android);
const mainSrc = all.filter((f) => /\/src\/main\//.test(rel(f)) && /\.(kt|java|aidl)$/.test(f));
const M = "android/mihon/src/main/java/app/mangahive/mihon/";

// ── 1. single runtime path ─────────────────────────────────────────────
for (const gone of ["runtime/MihonSourceRuntime.kt", "runtime/SourceClassLoaderRuntime.kt", "runtime/ControlledSource.kt", "bridge/MihonHostImpl.kt", "bridge/MihonBridgeApi.kt"]) {
  assert(!fs.existsSync(path.join(root, M + gone)), "removed duplicate execution path: " + gone);
}
const loaderUse = mainSrc.filter((f) => /\b(PathClassLoader|DexClassLoader|InMemoryDexClassLoader|BaseDexClassLoader)\b|Class\.forName|\.loadClass\(/.test(strip(fs.readFileSync(f, "utf8")))).map(rel).sort();
assert(JSON.stringify(loaderUse) === JSON.stringify([
  "android/mihon-compat/gateway/src/main/kotlin/app/mangahive/compat/gateway/RealCompatGateway.kt",
  M + "loader/AndroidLoaderPorts.kt", M + "loader/BoundaryClassLoader.kt"].sort()),
  "class loading APIs appear only in the loader ports, the boundary loader and the compat gateway (got " + loaderUse.join(", ") + ")");
const ctorUse = mainSrc.filter((f) => /(?<!class )\bExtensionLoader\(/.test(strip(fs.readFileSync(f, "utf8")))).map(rel);
assert(JSON.stringify(ctorUse) === JSON.stringify([M + "runtime/MihonExtensionService.kt"]), "only the runtime service constructs ExtensionLoader (got " + ctorUse.join(", ") + ")");

// ── 2. main-process code cannot reach extension code ──────────────────
const mainSide = [
  M + "ipc/MihonServiceClient.kt", M + "ipc/PendingRequests.kt", M + "ipc/ExtensionHealthTracker.kt", M + "ipc/RestartPolicy.kt",
  M + "bridge/MihonJsBridge.kt", M + "bridge/WebRequestParser.kt", M + "bridge/WebResponseMapper.kt",
  M + "ipc/contract/IpcProtocol.kt", M + "ipc/contract/IpcMessages.kt", M + "ipc/contract/IpcCodec.kt",
  "android/app/src/main/java/app/mangahive/MainActivity.kt",
];
const forbiddenImport = /^import\s+(app\.mangahive\.mihon\.(loader|runtime|apk|network|cookie|compat|persistence|security|spi)\b|eu\.kanade|dalvik\.system|okhttp3|java\.lang\.reflect|kotlin\.reflect)/m;
for (const f of mainSide) {
  const t = strip(rd(f));
  assert(!forbiddenImport.test(t), "main-side file imports no runtime/loader/network/reflection code: " + f.split("/").pop());
  assert(!/\b(Class\.forName|getDeclaredMethod|getMethod|getDeclaredConstructor|newInstance|\.invoke\()/.test(t), "no reflection calls: " + f.split("/").pop());
  assert(!/printStackTrace|getStackTraceString|\.stackTrace|StringWriter/.test(t), "no stack traces: " + f.split("/").pop());
}
const contractFiles = mainSide.filter((f) => f.includes("/contract/"));
for (const f of contractFiles) {
  const t = strip(rd(f));
  assert(!/\bAny\?|\bAny\b|Map<String,\s*Any|Serializable|Parcelable|import android\./.test(t), "contract has no Any/raw objects/android types: " + f.split("/").pop());
}
const wire = strip(rd(M + "bridge/WebRequestParser.kt")) + strip(rd(M + "bridge/WebResponseMapper.kt")) + strip(rd(M + "ipc/MihonServiceClient.kt")) + strip(rd(M + "ipc/PendingRequests.kt"));
assert(!/\bAny\?|Map<String,\s*Any/.test(wire), "bridge/client signatures use no Any? or untyped maps");

// ── 3. strict, allowlisted IPC ─────────────────────────────────────────
// Stage 10 extended the allowlist with download + deleteDownload.
// Source ops (isSourceOp=true) vs control ops are distinguished in Op.
// Invariant: closed allowlist + reject unknown ops (not a fixed count of 12).
const proto = rd(M + "ipc/contract/IpcProtocol.kt");
const wireOps = [...proto.matchAll(/^\s+[A-Z_]+\("([A-Za-z]+)"(?:,\s*(?:true|false))?\)[,;]/gm)].map((m) => m[1]).sort();
const sourceOps = ["search", "details", "chapters", "pages", "download"].sort();
const controlOps = ["install", "inspect", "enable", "disable", "uninstall", "listSources", "deleteDownload", "cancel", "health"].sort();
const spec = sourceOps.concat(controlOps).sort();
assert(JSON.stringify(wireOps) === JSON.stringify(spec), "Op enum is exactly the Stage 10 allowlist (got " + wireOps.join(",") + ")");
const flaggedSource = [...proto.matchAll(/^\s+[A-Z_]+\("([A-Za-z]+)",\s*true\)[,;]/gm)].map((m) => m[1]).sort();
assert(JSON.stringify(flaggedSource) === JSON.stringify(sourceOps), "isSourceOp=true marks exactly the source operations (got " + flaggedSource.join(",") + ")");
const msgs = rd(M + "ipc/contract/IpcMessages.kt");
// Match only RuntimeRequest subclasses (they override op or sit under sealed RuntimeRequest).
const reqClasses = [...msgs.matchAll(/data class (\w+)\b[\s\S]*?: RuntimeRequest\(\)/g)].map((m) => m[1]);
const uniqueReq = [...new Set(reqClasses)].sort();
const expectedReq = ["Cancel","Chapters","DeleteDownload","Details","Disable","Download","Enable","Health","Inspect","Install","ListSources","Pages","Search","Uninstall"].sort();
assert(JSON.stringify(uniqueReq) === JSON.stringify(expectedReq), "typed RuntimeRequest classes match Stage 10 allowlist (got " + uniqueReq.join(",") + ")");
const everything = mainSrc.map((f) => strip(fs.readFileSync(f, "utf8"))).join("\n");
assert(!/\bmethodName\b/.test(everything), "no methodName parameter anywhere in production code");
assert(!/fun\s+(execute|invoke|call)\s*\(\s*className/.test(everything), "no execute(className, ...) style API");
const ccOnly = mainSrc.filter((f) => /\bclassName\s*:\s*String/.test(strip(fs.readFileSync(f, "utf8")))).map(rel);
assert(ccOnly.every((f) => /\/loader\/|\/mihon-compat\//.test(f)), "String className parameters exist only inside the loader/compat layers (got " + ccOnly.join(", ") + ")");
const parser = rd(M + "bridge/WebRequestParser.kt");
assert(/when \(op\) \{/.test(parser) && !/else ->/.test(parser.slice(parser.indexOf("private fun build"), parser.indexOf("private fun str"))), "request builder is a closed when over Op (no else branch)");
assert(parser.indexOf("Op.fromWire(opName) ?: return Parsed.Rejected") >= 0, "unknown web operations are rejected");
const codec = rd(M + "ipc/contract/IpcCodec.kt");
assert(/onlyKeys\(/.test(codec) && codec.indexOf("UNSUPPORTED_VERSION") >= 0 && codec.indexOf("MAX_REQUEST_CHARS") >= 0, "codec rejects unknown keys, bad versions and oversize input");
assert(/val message: String, val retryable: Boolean/.test(proto) && !/message:\s*String\)/.test(strip(rd(M + "ipc/contract/IpcMessages.kt")).replace(/val message: String get\(\)/, "")), "error text is fixed per ErrorCode, never free text");
// extension id grammar must match SourceKey
const keyRe = rd(M + "loader/SourceKey.kt").match(/EXT_ID = Regex\("([^"]+)"\)/)[1];
const protoRe = proto.match(/EXTENSION_ID = Regex\("([^"]+)"\)/)[1];
assert(keyRe === protoRe, "IpcLimits.EXTENSION_ID equals SourceKey's grammar");

// ── 4. AIDL surface ────────────────────────────────────────────────────
const aidl = rd("android/mihon/src/main/aidl/app/mangahive/mihon/ipc/IMihonRuntime.aidl");
const aidlMethods = [...strip(aidl).matchAll(/^\s*(?:oneway\s+)?\w+\s+(\w+)\(/gm)].map((m) => m[1]).sort();
assert(JSON.stringify(aidlMethods) === JSON.stringify(["protocolVersion", "submit"]), "Binder interface has exactly protocolVersion + submit (got " + aidlMethods.join(",") + ")");
assert(/oneway void submit\(String requestJson, IMihonRuntimeCallback callback\)/.test(aidl), "submit takes only a String and a callback");
const cb = rd("android/mihon/src/main/aidl/app/mangahive/mihon/ipc/IMihonRuntimeCallback.aidl");
assert(/oneway void onResponse\(String responseJson\)/.test(cb) && !/Parcelable|Bundle/.test(strip(aidl) + strip(cb)), "callback is String only; no Parcelable/Bundle crosses Binder");
assert(/aidl = true/.test(rd("android/mihon/build.gradle.kts")), "AIDL enabled in the module build");

// ── 5. process model ───────────────────────────────────────────────────
const manifest = rd("android/app/src/main/AndroidManifest.xml");
const svc = manifest.match(/<service[\s\S]*?\/>/)[0];
assert(/MihonExtensionService/.test(svc) && /android:process=":mihon"/.test(svc), "service declared in process :mihon");
assert(/android:exported="false"/.test(svc), "service not exported");
assert(/android:isolatedProcess="false"/.test(svc), "isolatedProcess decision recorded explicitly in the manifest");
assert(proto.includes('"app.mangahive.mihon.runtime.MihonExtensionService"') && fs.existsSync(path.join(root, M + "runtime/MihonExtensionService.kt")), "RUNTIME_SERVICE_CLASS names a real class");
const service = rd(M + "runtime/MihonExtensionService.kt");
assert(service.indexOf("RuntimeProcessGate.openIfRuntimeProcess") >= 0, "service opens the process gate only after verifying the process name");
assert(service.indexOf("Binder.getCallingUid() != Process.myUid()") >= 0, "service checks the calling uid");
const ports = rd(M + "loader/AndroidLoaderPorts.kt");
assert((ports.match(/RuntimeProcessGate\.require\(\)/g) || []).length === 2, "both ClassLoader entry points call RuntimeProcessGate.require()");
assert(/@Volatile private var open = false/.test(rd(M + "runtime/RuntimeProcessGate.kt")), "gate is closed by default");

// ── 6. runtime failure handling (static presence; behaviour needs a device) ─
const client = rd(M + "ipc/MihonServiceClient.kt");
for (const needle of ["onServiceDisconnected", "onBindingDied", "linkToDeath", "failAll(ErrorCode.RUNTIME_DIED)", "health.onRuntimeDied", "health.onRuntimeUp", "BIND_AUTO_CREATE", "restartPolicy", "cancelQuietly", "ErrorCode.TIMEOUT"]) {
  assert(client.indexOf(needle) >= 0, "client handles runtime death/restart/timeout: " + needle);
}
assert(!/startService\(/.test(client), "client does not start the runtime as a started service (bind only)");
const disp = rd(M + "runtime/RuntimeDispatcher.kt");
assert(/is RuntimeRequest\.Cancel/.test(disp) && /is RuntimeRequest\.Health/.test(disp) && /tryComplete\(\)/.test(disp) && /AbortListener|jobs\.open\(/.test(disp), "cancel/health bypass the worker queue; one reply per request (Stage 6: decided by the job registry's CAS terminal state)");
const eng = rd(M + "runtime/RuntimeEngine.kt");
assert(/recoverFromCrash/.test(eng) && /CRASHED_WHILE_LOADING/.test(eng), "crash-while-loading quarantine exists");
assert(!/localPath/.test(eng + client + parser), "no localPath install (arbitrary file read) in the typed API");
assert(/urlPolicy\(req\.apkUrl\)/.test(eng), "install checks the APK URL against the SSRF policy before downloading");

// ── 7. honesty flags ───────────────────────────────────────────────────
const status = rd(M + "runtime/MihonRuntimeStatus.kt");
for (const k of ["SOURCE_EXECUTION_DEVICE_VERIFIED", "UPSTREAM_API_RUNTIME_COMPATIBLE", "ISOLATED_PROCESS_UID_SANDBOX", "MAIN_PROCESS_LOADS_EXTENSION_CODE"]) {
  assert(new RegExp("const val " + k + " = false").test(status), "status flag false: " + k);
}
assert(fs.existsSync(path.join(root, "MIHON_STAGE4_ISOLATION.md")), "threat model / decision document present");

if (failed) { console.error("\n" + failed + " failures"); process.exit(1); }
console.log("\nStage 4 STATIC invariants passed. Kotlin was not compiled and nothing was run on a device.");
