# Stage 4 — extension process isolation + IPC

**Status: code written, NOT compiled, NOT run on a device.** No Kotlin compiler or Android toolchain was available.
What *was* run: the repository's Node tests, including `mihon_stage4_isolation_test.js`, which are **static** checks of
the source tree. Every claim below says which kind of evidence backs it.

## 1. The one runtime path

```
WebView ──JS bridge──▶ MihonJsBridge ──▶ MihonServiceClient ═══ Binder (AIDL, Strings) ═══▶ MihonExtensionService  [:mihon]
 (main process)        WebRequestParser   typed RuntimeRequest                               RuntimeDispatcher
                                                                                             RuntimeEngine ─▶ ExtensionLoader ─▶ Source
```

Deleted (second/third execution paths): `MihonHostImpl`, `MihonBridgeApi`, `SourceClassLoaderRuntime`, `MihonSourceRuntime`,
`ControlledSource`. The old service ran the hand-written stub runtime and never used the Stage 3 `ExtensionLoader`.
Now `ExtensionLoader` is the only way extension code loads, and only `MihonExtensionService` constructs it.
`eu.kanade.*` stubs, `internal-probe` and the OkHttp bridge classes remain but nothing executes them (inert; remove with the probe).

## 2. Process model decision: `:mihon` now, `isolatedProcess` later

| Concern | `android:process=":mihon"` (chosen) | `android:isolatedProcess="true"` |
|---|---|---|
| Binder | works | works (`bindIsolatedService`), server must accept the app's uid, not its own |
| APK access | same UID: reads its own files | **cannot read app files**; APK/dex must be passed as fd or bytes (`InMemoryDexClassLoader`: dex only, no resources) |
| Network | has `INTERNET`, direct OkHttp | **no sockets at all**; every request needs a broker in the UI process (streaming bodies, cookies, redirects, TLS + SSRF policy) |
| Runtime deps | bundle loaded from private files | bundle (Kotlin 2.4, OkHttp 5.5, …) must also arrive by fd/bytes |
| Lifecycle | normal bound service, auto-restart | per-instance, no app data dir, no `Context`-backed prefs that many extensions use |
| IPC | AIDL, `getCallingUid` check | same contract works unchanged |

Choosing `isolatedProcess` today would make **every** extension fail (no network, no APK access) until a broker exists,
so it is not "practical" yet. The IPC contract, the `ApkAcquirer`/records ports and the single network seam are
transport-agnostic, so moving the runtime into an isolated process is a Stage 5 job, not a rewrite.

### Threat model

*Asset:* the UI process (Supabase session in WebView storage, library data) and the user's device/network position.
*Attacker:* a malicious or buggy third-party extension APK, i.e. arbitrary code running inside the runtime.

What `:mihon` **does** give: the extension's heap, crashes, OOMs, ANRs and hangs are separate from the UI process; the UI
process never loads its bytecode (`RuntimeProcessGate`); the runtime's replies are untrusted input and are strictly
decoded; one crash-looping extension is quarantined instead of boot-looping the app.

What it does **not** give (read this): `:mihon` shares the app **UID**. Code executing there can read the app's private
files — including the WebView's storage under the app data dir — and use the app's `INTERNET` permission. **It is not a
confidentiality boundary.** Today the real controls against a hostile extension are: signer pinning per extension id
(first signer owns it), optional SHA-256 / expected-signer on install, HTTPS-only + SSRF-checked downloads, and the user
choosing what to install. Closing the file-read gap requires `isolatedProcess` + a network broker (Stage 5).

## 3. IPC

Binder surface (`IMihonRuntime.aidl`): `protocolVersion()` and `oneway submit(String, IMihonRuntimeCallback)`; callback
`oneway onResponse(String)`. Strings only — no Parcelable/Bundle ever crosses, so neither side unparcels peer-shaped
objects. The String is a versioned JSON document handled **only** by `IpcCodec`, which rejects unknown keys, wrong JSON
types, bad versions, over-long strings and over-long lists, on both ends.

Allowed operations (`Op`): `install inspect enable disable uninstall listSources search details chapters pages cancel health`.
Each has its own typed request class; there is no member that carries a class name, method name, path or open map.
Web input is mapped by `WebRequestParser` through a closed `when`; unknown ops → `UNKNOWN_OP`; extra payload fields are
dropped. `install` no longer accepts `localPath` (it was an arbitrary-file primitive). The old `discover`/`listInstalled`
ops are gone; `listSources` and `health` replace them (the web layer only called search/details/chapters/pages).

Errors: closed `ErrorCode` set with **fixed** message text and a `retryable` flag; optional `detail` must be an
`[A-Z0-9_]` token (e.g. a `LoadFailureCode` name). Exception messages and stack traces stay in the runtime's logcat.

## 4. Runtime death, restart, stale work

* Detected two ways: `linkToDeath` and `onServiceDisconnected`/`onBindingDied` (idempotent).
* Every waiting call completes immediately with `RUNTIME_DIED` (retryable). The UI process keeps running.
* `ExtensionHealthTracker`: all known extensions → `RUNTIME_UNAVAILABLE`; extensions with a request in flight at the
  moment of death get a crash strike; 3 consecutive strikes → `QUARANTINED` (source calls refused locally until the user
  re-enables). Blame is approximate when several extensions were in flight. State is in memory (resets with the app).
* Restart: next call re-binds (`BIND_AUTO_CREATE`); on connect the client pings `health`, which moves extensions back to
  `UNKNOWN`. `RestartPolicy` stops hammering after 5 deaths/60 s (30 s cool-down).
* Stale operations: pending table is cleared on death; answers for unknown/expired ids are dropped; timeouts discard the
  waiter and send a best-effort `cancel`; runtime tasks have a 90 s hard deadline and exactly-once replies.
* Runtime side: extensions load **lazily** on first use (no extension code at process start). A durable "loading" marker
  is written before extension code runs; if the process dies mid-load, that extension is quarantined at next start.
* Fixed bug: `cancel` used to queue behind the single worker thread, i.e. behind the call it was cancelling. `cancel` and
  `health` now run immediately; work runs on a bounded pool (queue full → `BUSY`).

## 5. Acceptance gate — honest status

| Gate item | Status | Evidence |
|---|---|---|
| Source execution occurs in the runtime process | Implemented | static: only `MihonExtensionService` builds `ExtensionLoader`; ClassLoader APIs only in loader/compat layers. **Not run.** |
| Main process not executing third-party bytecode | Implemented | static import/reflection checks on all main-side files + `RuntimeProcessGate.require()` in both ClassLoader entry points (JVM test written, not run). Caveat: `:mihon` module classes are still *packaged* in the UI process; nothing instantiates them there. |
| IPC explicit and allowlisted | Implemented | static: 12-op enum, 12 request classes, AIDL = 2 methods; codec unit tests written, not run |
| Runtime crash does not kill the main app | Implemented, **unverified** | separate process by manifest; client death handling present; needs a device kill test (`adb shell am kill app.mangahive:mihon`) |
| Runtime can restart | Implemented, **unverified** | `BIND_AUTO_CREATE` + re-bind + ping; needs the same device test |
| No generic reflection API | Implemented | static: no `methodName`, no `execute(className…)`, no reflection in main-side code |

## 6. Known limits

* **No compat bundle exists yet** (Stage 3 blocker). Without `filesDir/mihon_compat/manifest.json` every install/load fails
  closed with `COMPAT_RUNTIME_UNAVAILABLE`, before any download. So no real extension executes end to end yet.
* Binder transactions are ~1 MB shared; responses over 250 000 chars become `RESPONSE_TOO_LARGE` (very long chapter lists).
  Fix later with fd/pipe transfer or paging.
* `cancel` interrupts the worker thread; a blocking OkHttp call may keep running until its own timeout. The UI side
  detaches immediately regardless.
* The JS bridge is still synchronous (WebView runs `@JavascriptInterface` calls serially), so a web-side `cancel` cannot
  overtake a blocking call from the same WebView. Async/promise bridge is a follow-up.
* The web adapter passes its own `sourceId` strings; the runtime needs the numeric Mihon source id (or `mihon:<ext>:<id>`
  key from `listSources`). Web-side id mapping must be aligned when a real extension first runs.
* Old records (`mihon_ext_records`) written by the stub runtime are not migrated; they described code that is gone.

## 7. Verify on a machine with the toolchain

1. `./gradlew :mihon:testDebugUnitTest` — new tests: `IpcCodecTest`, `ClientStateTest`, `WebRequestParserTest`,
   `RuntimeDispatcherTest`, `RuntimeEngineTest`, `RuntimeProcessGateTest` (all written, none run; expect to fix compile slips).
2. Install the app; `adb shell ps -A | grep mangahive` must show two processes. Call `health` from the WebView.
3. `adb shell am kill app.mangahive:mihon` during a search: UI stays up, the call returns `RUNTIME_DIED`, next call works.
4. Stage 3 gate (`RealStage2ApkLoadTest`) once a compat bundle exists.
