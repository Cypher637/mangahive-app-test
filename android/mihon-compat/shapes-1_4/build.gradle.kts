// DISABLED BY DEFAULT (enableLegacy14=false). The 1.4 artifact coordinate is UNRESOLVED, so there is nothing
// honest to compile against. Candidates seen only in third-party fork READMEs (not upstream-authoritative):
//   com.github.mihonapp:tachiyomix:1.4.4   (komikku-app/tachiyomix README)
//   com.github.mihonapp:extensions-lib:1.4.4 (stumpapp/mihon-extension README)
// Fill the dependency below ONLY after verify-pins.sh proves a coordinate resolves and its tag/commit is recorded.
plugins {
    alias(libs.plugins.android.library)
}

android {
    namespace = "app.mangahive.compat.shapes14"
    compileSdk = 37
    defaultConfig { minSdk = 26 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    // compileOnly("<RESOLVE-ME: pinned 1.4 coordinate>")
    compileOnly(libs.okhttp)
}
