plugins { alias(libs.plugins.android.library) }

// Stage 6.6A: the compat bundle. Holds the MangaHive HOST implementation of the tachiyomix 1.6.0 extension API
// (eu.kanade.tachiyomi.*) next to the gateway, HostNetwork and the terminal BrokerInterceptor. The upstream artifact is NOT a
// dependency here (it is stubs); it is the ABI reference (see verify-abi.sh) and the compile target of :fixture-ext16.
android {
    namespace = "app.mangahive.compat.gateway"
    compileSdk = 37
    defaultConfig { minSdk = 26 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    // The SPI is plain Java shared with :mihon; the gateway implements it. Source-level share, no project dependency.
    sourceSets["main"].java.srcDir("../../mihon-spi/src/main/java")
    // JVM tests drive the real Stage 5/6 broker (mihon-net, JDK-only) and the real loader boundary classes from :mihon.
    sourceSets["test"].java.srcDirs("../../mihon-net/src/main/java", layout.buildDirectory.get().asFile.resolve("generated/netTestTransport"))
    sourceSets["test"].kotlin.srcDir(layout.buildDirectory.get().asFile.resolve("generated/loaderBoundary"))
    testOptions { unitTests.isReturnDefaultValues = true }
}

// The three JDK-only loader-boundary classes from :mihon, copied verbatim so the tests exercise the production code.
val copyLoaderBoundary by tasks.registering(Copy::class) {
    from("../../mihon/src/main/java/app/mangahive/mihon/loader") {
        include("BoundaryClassLoader.kt", "PackageBoundary.kt", "ExtensionBoundaries.kt")
    }
    into(layout.buildDirectory.dir("generated/loaderBoundary/app/mangahive/mihon/loader"))
}

dependencies {
    // Host-provided runtime libraries (tachiyomix 1.6.0 README "App Dependency Requirements" + pom). Packaged in the bundle.
    implementation(libs.kotlinx.coroutines.core)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)   // SManga.memo / SChapter.memo are JsonObject; Json is Injekt-provided
    implementation(libs.jsoup)
    implementation(libs.injekt)                       // dev.mihon.injekt.patchInjekt + uy.kohesive.injekt registry
    implementation(libs.rxjava)
    compileOnly(libs.androidx.preference)             // ConfigurableSource signature only

    testImplementation(libs.junit)
    testImplementation(libs.orgjson)
}

val fixtureAar = project(":fixture-ext16").layout.buildDirectory.file("outputs/aar/fixture-ext16-debug.aar")
tasks.withType<Test>().configureEach {
    dependsOn(":fixture-ext16:assembleDebug")
    systemProperty("mh.fixture.aar", fixtureAar.get().asFile.absolutePath)
    val upstream = configurations.detachedConfiguration(project.dependencies.create("com.github.mihonapp:tachiyomix:${libs.versions.tachiyomix16.get()}@aar"))
    doFirst { systemProperty("mh.upstream.aar", upstream.singleFile.absolutePath) }
    systemProperty("mh.live", System.getenv("MH_LIVE_HTTPS") ?: "")
    testLogging { events("passed", "failed"); showStandardStreams = true; exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL }
}
// The real-socket TLS test transport of the Stage 5 harness (the rest of that harness runs in mihon-net's own JDK build).
val copyNetTestTransport by tasks.registering(Copy::class) {
    from("../../mihon-net/src/test/java/app/mangahive/mihon/net") { include("PinnedSocketTransport.java") }
    into(layout.buildDirectory.dir("generated/netTestTransport/app/mangahive/mihon/net"))
}
tasks.matching { it.name.startsWith("compile") && it.name.contains("UnitTest") }.configureEach { dependsOn(copyLoaderBoundary, copyNetTestTransport) }
