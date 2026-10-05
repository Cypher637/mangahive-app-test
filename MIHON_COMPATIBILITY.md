# Mihon / Tachiyomi compatibility

## Stage 1: real API foundation (read this first)

Upstream API profiles, pins and boundaries now live in **`MIHON_API_PROFILES.md`** (`MIHON_1_6`, `MIHON_1_4`).
Stage 6.6A deleted the old inert `eu.kanade.tachiyomi.*` stubs in `android/mihon` (and `android/internal-probe`). The one
host implementation of the tachiyomix 1.6.0 API now lives in the compat bundle (`MIHON_STAGE6_6_HOST_RUNTIME.md`).
`ControlledSource` (the old internal normalized Source abstraction, never a Mihon compatibility test) was deleted in Stage 4; see `MIHON_STAGE4_ISOLATION.md`.
No Mihon/Tachiyomi runtime compatibility is claimed; "Mode B" below is still planned, not delivered.

## Stage 6.5 (2026-10-03)
Read the real `tachiyomix-1.6.0` sources: the artifact is stubs only, so source execution also needs a MangaHive implementation of those classes
(not written). `RealSourceGateway` now implements details/chapters through the real `getMangaUpdate` signature and a host-bound network identity
(uncompiled Kotlin; identity core JVM-tested). Still: no real extension has run, no device run, `UPSTREAM_API_RUNTIME_COMPATIBLE=false`,
`SOURCE_EXECUTION_DEVICE_VERIFIED=false`, `SOURCE_NETWORK_FORCED_THROUGH_BROKER=false`. Details: `MIHON_API_PROFILES.md`, `MIHON_STAGE5_NETWORK_BROKER.md`.

## Stage 6.6A (2026-10-03)
MangaHive now has a real host implementation of the exact tachiyomix 1.6.0 extension API in `android/mihon-compat/gateway`
(ABI-diffed against the AAR: 38 classes, no missing members), wired to Injekt and to the existing broker and identity scopes.
`HostRuntime16Test` passes: a Source compiled only against upstream 1.6.0 runs through the production ClassLoader topology,
with real TLS through the broker. That is JVM evidence only. No device run, no third-party APK, and all three status flags are
still `false`. This is **not** Mihon application compatibility. Details: `MIHON_STAGE6_6_HOST_RUNTIME.md`.

## What this is

MangaHive can **discover and catalog** Mihon/Tachiyomi-style extension repositories (e.g. `index.min.json`).

## What this is not

MangaHive does **not**:

- Execute Mihon APK bytecode in the PWA/web runtime
- `eval` / `new Function` extension code
- Install APKs as normal Android apps automatically
- Claim “500 sources supported” because a repo lists 500 packages

**Repository compatibility ≠ execution compatibility.**

## Modes

| Mode | Platforms | Behavior |
|------|-----------|----------|
| **A — Repository / metadata** | PWA, Web, Android | Parse index, show name/version/lang/icon/compat |
| **B — Source execution** | Android (planned bridge) | Controlled native process only |

Default classification for Mihon packages: **`metadata-only`** / **requires native bridge**.

## IDs

- Extension: `mihon.<normalized-package-id>`
- Source: `mihon-<pkg-dashed>-<sourceKey>`
- Never collides with `mangahive.*`

## Adding a repo

Source Hub → **Mihon** → paste HTTPS `index.min.json` URL (example community fixture: Yuzono-style URLs).

Trust: **community** unless you have an independent reason to trust the host.

## Security

- HTTPS only for repo and APK URLs  
- Timeouts + response size limits  
- Non-HTTPS APK links dropped  
- No credential/cookie sharing with Mihon packages  
- Disable/uninstall follows owner-aware adapter rules  

## See also

- `MIHON_API_PROFILES.md` — pinned upstream API profiles and unresolved items
