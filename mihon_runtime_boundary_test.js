"use strict";
// Updated for Stage 4. Structural checks only: this does NOT compile Kotlin and does NOT run a device.
// The full Stage 4 invariants live in mihon_stage4_isolation_test.js.
const fs = require("fs");
const path = require("path");
let failed = 0;
function assert(c, m) { if (!c) { console.error("FAIL:", m); failed++; } else console.log("PASS:", m); }
const root = __dirname;
const M = "android/mihon/src/main/java/app/mangahive/mihon/";
const rd = (p) => fs.readFileSync(path.join(root, p), "utf8");
const service = rd(M + "runtime/MihonExtensionService.kt");
const engine = rd(M + "runtime/RuntimeEngine.kt");
const client = rd(M + "ipc/MihonServiceClient.kt");
const bridge = rd(M + "bridge/MihonJsBridge.kt");
const status = rd(M + "runtime/MihonRuntimeStatus.kt");
const html = rd("index.html");
const manifest = rd("android/app/src/main/AndroidManifest.xml");

assert(/ExtensionLoader\(/.test(service), "service builds the one ExtensionLoader pipeline");
assert(service.indexOf("RuntimeEngine(") >= 0 && engine.indexOf("loader.load(") >= 0, "service hosts RuntimeEngine, which loads through ExtensionLoader");
assert(/IMihonRuntime\.Stub/.test(service), "service speaks the AIDL contract");
assert(manifest.indexOf('android:process=":mihon"') >= 0, "manifest process :mihon");
assert(client.indexOf("RUNTIME_SERVICE_CLASS") >= 0 && client.indexOf("MihonExtensionService") < 0, "client addresses the service by name constant, no class link");
assert(bridge.indexOf("MihonServiceClient") >= 0 && bridge.indexOf("UNKNOWN_OP") >= 0, "JS bridge goes through the client and rejects unknown ops");
assert(status.indexOf("SOURCE_EXECUTION_DEVICE_VERIFIED = false") >= 0, "device not falsely verified");
assert(!/PathClassLoader/.test(html), "no ClassLoader in web");
assert(html.indexOf("mihonInvoke") >= 0, "web bridge present");
for (const gone of ["runtime/MihonSourceRuntime.kt", "runtime/SourceClassLoaderRuntime.kt", "bridge/MihonHostImpl.kt", "bridge/MihonBridgeApi.kt"]) {
  assert(!fs.existsSync(path.join(root, M + gone)), "duplicate execution path removed: " + gone);
}
if (failed) { console.error(failed + " failures"); process.exit(1); }
console.log("\nRuntime boundary tests passed (structural only).");
