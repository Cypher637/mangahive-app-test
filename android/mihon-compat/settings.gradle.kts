pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // The ONLY reason JitPack is here: upstream publishes the extension API stubs
        // (tachiyomix) and Injekt there. Restricted to the one upstream group so nothing
        // else can be resolved from it.
        maven(url = "https://www.jitpack.io") {
            content { includeGroup("com.github.mihonapp") }
        }
    }
}

rootProject.name = "MangaHiveMihonCompat"

// Compile-time shapes against upstream tachiyomix 1.6. Never depends on :mihon.
include(":shapes-1_6")
// Stage 3: the gateway that hosts the real Source API inside the compat bundle (implements the shared Java SPI).
include(":gateway")
// Stage 6.6A test fixture: a Source compiled ONLY against upstream tachiyomix 1.6.0 (compileOnly). Loaded by :gateway's JVM tests
// through the real BoundaryClassLoader. Not an independent third-party extension and not shipped.
include(":fixture-ext16")

// Legacy 1.4 shapes: only when the 1.4 artifact is pinned (see README.md, "Unresolved").
if (providers.gradleProperty("enableLegacy14").orNull == "true") {
    include(":shapes-1_4")
}
