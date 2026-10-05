# MangaHive Extension Security — Stage 7.1

## Trust boundary

Repository metadata and APK contents are untrusted until validated. Direct APK installs are treated as `DIRECT` trust by the Stage 7 policy; repository-backed installs must provide their repository trust and signer metadata at the repository integration layer.

## APK verification

The runtime verifies:

- HTTPS download policy through the existing broker
- streamed SHA-256
- APK size limits
- package identity
- versionCode
- signing certificate fingerprint
- extension feature/API metadata
- entry-point shape
- host compatibility
- manifest permission risk

## Android package verification

When running with the real Android installer, PackageInstaller performs the platform package transaction. MangaHive then re-queries PackageManager and compares the installed package, version and signer set with the pre-install APK facts before executing extension code.

## Code execution restrictions

No extension path may introduce `eval`, `new Function`, remote JavaScript execution, WebView-based native execution, shell commands, root, or direct access to MangaHive/Supabase credentials.

## Status flags

Device-level verification flags remain false until a real Android device/emulator executes the complete third-party APK path. JVM policy tests are not treated as device evidence.

## Startup reconciliation and failure containment

On runtime startup, persisted extension identities are checked against Android `PackageManager` for package presence, versionCode, signing certificate set and current installed `sourceDir`. A mismatch disables that extension; it does not disable unrelated extensions or the runtime process.

Runtime activation failures are persisted as `RECOVERY_REQUIRED` and quarantined. The runtime does not silently retry broken extension code on every request, and it does not claim that a failed update was automatically rolled back.

The APK inspector exposes Android signing-certificate facts and signer history/multiple-signer information where the platform provides them. It does **not** claim to independently prove the exact APK Signature Scheme (v1/v2/v3/v4) used by a package; that requires a dedicated signature-verification implementation and is not represented as verified here.
