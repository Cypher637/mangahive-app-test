plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}
android {
    namespace = "app.mangahive.mihon"
    compileSdk = 34
    defaultConfig {
        minSdk = 26
        targetSdk = 34
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        consumerProguardFiles("consumer-rules.pro")
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { aidl = true } // IMihonRuntime / IMihonRuntimeCallback (src/main/aidl)
    testOptions { unitTests.isReturnDefaultValues = true }
    // Plain-Java SPI shared by source with the compat gateway build (no project dependency between builds).
    sourceSets["main"].java.srcDir("../mihon-spi/src/main/java")
    // Stage 5: pure-JDK network core (policy, cookies, engine) shared at source level; its Java test harness runs as a unit test.
    sourceSets["main"].java.srcDir("../mihon-net/src/main/java")
    sourceSets["test"].java.srcDir("../mihon-net/src/test/java")
}
dependencies {
    implementation("org.jetbrains.kotlin:kotlin-stdlib:1.9.22")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303") // android.jar org.json is stubbed in JVM unit tests
    androidTestImplementation("androidx.test.ext:junit:1.1.5")
    androidTestImplementation("androidx.test:runner:1.5.2")
    testImplementation("org.jetbrains.kotlin:kotlin-test:1.9.22")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
}
