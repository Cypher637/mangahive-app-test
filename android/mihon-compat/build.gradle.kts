// Isolated from the main MangaHive Android build on purpose:
// tachiyomix 1.6 requires Kotlin 2.4.0 / compileSdk 37 (upstream README + CHANGELOG), which the
// main build (AGP 8.2.2, Kotlin 1.9.22) cannot read. Keeping this build separate means the
// real-API foundation can move without risking :app / :mihon.
buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        // AGP 9.x has built-in Kotlin (default KGP 2.2.10). Upstream requires Kotlin 2.4.0 for
        // metadata compatibility with the stubs, so the KGP version is forced here.
        // UNVERIFIED COMBINATION: AGP 9.1.1 + KGP 2.4.0 has not been built (no network/SDK in the
        // authoring environment). The first CI run is the check. See README.md.
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin") {
            // Must equal [versions] kotlin in gradle/libs.versions.toml (catalog accessors are unavailable in buildscript {}).
            version { strictly("2.4.0") }
        }
    }
}

plugins {
    alias(libs.plugins.android.library) apply false
}
