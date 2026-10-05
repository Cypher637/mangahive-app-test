package app.mangahive.mihon.runtime

/**
 * Honest status flags. A flag is true only if it is true of REAL upstream Mihon/Tachiyomi extensions.
 * Stage 1 establishes the API foundation only; no upstream-compatible runtime exists.
 */
object MihonRuntimeStatus {
    const val ACQUISITION_READY = true
    const val INSPECTION_READY = true

    // Upstream profiles (MIHON_1_6 / MIHON_1_4) are defined as data; some pins are still UNRESOLVED.
    const val UPSTREAM_PROFILES_DEFINED = true
    const val UPSTREAM_API_RUNTIME_COMPATIBLE = false

    // These described the hand-written stub runtime, not the upstream API, so they no longer read "ready".
    const val CLASSLOADER_RUNTIME_READY = false
    const val HTTP_SOURCE_API = false
    const val SOURCE_EXECUTION_CODE_READY = false
    const val INTERNAL_STUB_RUNTIME_PRESENT = false // stub runtime + ControlledSource path deleted in Stage 4; eu.kanade stubs remain only as inert probe fixtures

    // Stage 3: loader code exists (app.mangahive.mihon.loader) but has never been compiled or run, and the compat
    // bundle it needs does not exist yet. Presence of code is not readiness; the flags above stay false.
    const val REAL_LOADER_CODE_PRESENT = true

    // Stage 4. These describe code structure, not a device run; SOURCE_EXECUTION_DEVICE_VERIFIED stays false.
    const val PROCESS_ISOLATION = true // service is declared in process :mihon (fact about the manifest)
    const val SINGLE_RUNTIME_PATH = true // Main -> IPC (AIDL, typed) -> RuntimeEngine/ExtensionLoader -> Source; the stub runtime is gone
    const val MAIN_PROCESS_LOADS_EXTENSION_CODE = false // RuntimeProcessGate refuses ClassLoader creation outside :mihon
    const val ISOLATED_PROCESS_UID_SANDBOX = false // :mihon shares the app UID; isolatedProcess needs a network broker (Stage 5)
    const val SOURCE_EXECUTION_DEVICE_VERIFIED = false

    // Stage 5. Pure-JDK broker core is exercised by a JVM harness (real TLS + the real Stage 2 fixture server).
    // The compat-side interceptor, OkHttp transport and gateway wiring are UNCOMPILED; the Source-to-broker seam is open.
    const val NETWORK_BROKER_CORE_JVM_VERIFIED = true
    const val NETWORK_BROKER_END_TO_END_DEVICE_VERIFIED = false
    const val SOURCE_NETWORK_FORCED_THROUGH_BROKER = false
    // Stage 6. The pure-JDK core (bounded streaming, scope cancellation, deadlines, governor, job registry) is JVM verified against
    // real TLS sockets. The Kotlin/OkHttp/AIDL/WebView pieces that CARRY the cancel to it are uncompiled and not run on a device.
    const val RESOURCE_CONTROLS_CORE_JVM_VERIFIED = true
    const val CANCEL_PATH_END_TO_END_DEVICE_VERIFIED = false
    const val COMPAT_PROFILE = MihonCompatibilityProfile.PROFILE_ID
    const val NOTE = "No Mihon/Tachiyomi runtime compatibility is claimed. Stage 4 moved execution into one process-isolated runtime path; it is uncompiled and has not been run on a device. See MIHON_STAGE4_ISOLATION.md."
}
