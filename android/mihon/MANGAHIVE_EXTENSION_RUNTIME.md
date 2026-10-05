# MangaHive Extension Runtime

## Single runtime

Third-party Mihon-compatible extension code executes only in the `:mihon` process through the existing Stage 6.6A `ExtensionLoader` and its per-extension `PathClassLoader`.

Stage 7 is the authoritative installation/persistence policy layer. `Stage7ExtensionRecords` bridges the existing IPC/runtime record interface to the Stage 7 persistent registry without introducing a second store.

## Network boundary

Extension source requests continue to use the existing `MihonSourceRegistry -> MangaHiveSourceAdapter -> compat gateway -> NetworkHelper -> HostNetwork -> broker` path. No direct extension HTTP client is granted MangaHive credentials or privileged headers.

## Installation boundary

The Android runtime downloads and verifies an APK before requesting PackageInstaller installation. The installed package is re-read through PackageManager before its source path is passed to ExtensionLoader.

## Lifecycle

Enable/disable/uninstall operate through the same runtime process. Uninstall clears broker cookies and resource-governor state through the existing service hook, unregisters sources, removes the Stage 7 registry record, and requests Android package removal when the real installer is wired.

## Failure isolation

Loader failures are converted to structured IPC errors. An extension that fails to load does not register its sources and does not prevent unrelated extensions from being served.
