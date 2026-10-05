plugins { alias(libs.plugins.android.library) }

// Stage 6.6A TEST FIXTURE (not shipped, not an independent third-party extension): a Source written only against the
// extension-facing API and compiled ONLY against the published upstream tachiyomix 1.6.0 stubs (compileOnly), exactly like a
// real extension. :gateway's JVM tests load its classes through the real BoundaryClassLoader into the host runtime.
android {
    namespace = "eu.kanade.tachiyomi.extension.all.mhfixture"
    compileSdk = 37
    defaultConfig { minSdk = 26 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    compileOnly(libs.tachiyomix.v16)
    compileOnly(libs.kotlinx.coroutines.core)
    compileOnly(libs.kotlinx.serialization.json)
    compileOnly(libs.okhttp)
    compileOnly(libs.jsoup)
    compileOnly(libs.injekt)
    compileOnly(libs.rxjava)
}
