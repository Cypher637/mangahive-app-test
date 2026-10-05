# MangaHive Stage 7.1 — Real Android Installation + Runtime Wiring

Stage 7 policy and persistence are now part of the `:mihon` runtime rather than a parallel standalone module.

## Runtime path

`repository/direct metadata -> streamed APK -> SHA-256 -> PackageManager inspection -> Stage 7 InstallPolicy -> Android PackageInstaller -> installed PackageManager sourceDir -> Stage 6.6A ExtensionLoader -> MihonSourceRegistry -> HostNetwork broker`

The old `PrefsExtensionRecords` store is no longer the live service registry. `Stage7ExtensionRecords` adapts the existing runtime record interface onto the Stage 7 `ExtensionRegistry` so IPC behavior remains stable while persistence is consolidated.

## Android installation

`AndroidPackageInstaller` uses Android `PackageInstaller`. It does not use shell commands, `pm`, `adb`, root, or `Runtime.exec`/`ProcessBuilder`.

Non-device-owner installs may require Android's confirmation UI and `REQUEST_INSTALL_PACKAGES` permission. A real device is required to verify that flow.

After PackageInstaller success MangaHive re-queries `PackageManager`, verifies package/version/signers, and only then passes the installed APK path into the existing Stage 6.6A `ExtensionLoader`.

## Verification state

The Stage 7 status flags remain conservative. Adding the Android implementation does not set device-verification flags. A successful real-device run with a real third-party APK is required before those flags may be changed.

## Current limitation

This environment cannot execute an Android emulator/device and cannot download the Gradle 8.5 distribution because `services.gradle.org` is unreachable. The pure Stage 7 harness remains independently verified at 124/124.

### Android update rollback limitation

Normal third-party applications cannot be silently downgraded through the public PackageInstaller API. Stage 7 therefore blocks downgrade before installation and, if an accepted update installs but fails runtime activation, persists the extension as disabled/quarantined rather than pretending the old package was restored. A future recovery UI can request an explicit user-approved reinstall of a retained known-good APK when the platform permits it.

## 7.1A stabilization changes

The production runtime now has a single Android lifecycle path: `RuntimeEngine` backed by `Stage7ExtensionRecords`. The older `ExtensionManager` remains only as a JVM policy/lifecycle test harness and is not constructed by the Android service.

Startup also reconciles persisted extension rows against Android `PackageManager`. Missing packages become `MISSING`, version changes become `OBSOLETE`, signer changes become `SIGNATURE_MISMATCH`, and valid packages refresh their current `sourceDir`. A bad persisted signer-ownership row quarantines only that extension rather than taking down the whole runtime.

A failed runtime activation after PackageInstaller commit is recorded as `RECOVERY_REQUIRED` against the newly installed package. MangaHive does not claim an automatic rollback that Android's public PackageInstaller API cannot guarantee. Downloaded APKs that are rejected as already up-to-date are explicitly cleaned up.

Downgrade protection now checks both MangaHive's persistent registry and the actual Android-installed version, preventing a stale registry from becoming an upgrade/downgrade bypass.
