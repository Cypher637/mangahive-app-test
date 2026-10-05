# mihon-compat — real upstream API foundation (Stage 1)

A **separate Gradle build** that type-checks Source shapes against the real `com.github.mihonapp:tachiyomix:1.6`
artifact. It exists to answer one question: *does this code compile against the real Mihon extension API?*

- Never depends on `:mihon` (MangaHive's stubs). A repository test enforces this.
- Contains **no runtime**: no ClassLoader, no execution, no network. Shapes are never run or loaded.
- Pins and rationale: `gradle/libs.versions.toml` and `../../MIHON_API_PROFILES.md`.

## Run (needs network, JDK 17+, Android SDK platform 37)

```
./verify-pins.sh        # tags->commits, JitPack coordinate check, compile gate, artifact checksums
```

## Not verified when this was written

The authoring environment had no network, no Android SDK and no Kotlin compiler, so **nothing here has been compiled**.
In particular: AGP 9.1.1 + Kotlin 2.4.0 + compileSdk 37 as configured; whether JitPack serves `tachiyomix:1.6`
or needs `1.6.0`; and the argument lists in `SuspendCallSurfaceShape.kt`. A compile error there is a real result.
`:shapes-1_4` is off (`enableLegacy14=false`) until a 1.4 artifact is pinned.
