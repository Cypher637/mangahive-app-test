plugins {
    alias(libs.plugins.android.library)
}

android {
    namespace = "app.mangahive.compat.shapes16"
    compileSdk = 37 // tachiyomix 1.6.0 CHANGELOG: "Bump Android compileSdk to 37"
    defaultConfig {
        minSdk = 26 // tachiyomix README: host/min SDK 26
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17 // upstream .jitpack.yml builds with openjdk17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    // WHY: the real extension API. compileOnly because upstream ships stub interfaces only;
    // implementations live in the host app (tachiyomix README).
    compileOnly(libs.tachiyomix.v16)

    // WHY (all compileOnly): these types appear in the stubs' public signatures and are
    // provided by the host at runtime, so a compiling extension sees the same classes.
    compileOnly(libs.kotlinx.coroutines.core)      // suspend Source API
    compileOnly(libs.kotlinx.serialization.json)   // SManga.memo / SChapter.memo
    compileOnly(libs.okhttp)                       // Request / Response / Headers
    compileOnly(libs.jsoup)                        // HTML parsing used by extensions
    compileOnly(libs.injekt)                       // NetworkHelper / Json are obtained via Injekt
}
