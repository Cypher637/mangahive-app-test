package eu.kanade.tachiyomi.extension.all.mhfixture

import eu.kanade.tachiyomi.source.Source
import eu.kanade.tachiyomi.source.SourceFactory

/** Entry class, as declared by a real extension's manifest (tachiyomi.extension.class). */
class MhFixtureFactory : SourceFactory {
    override fun createSources(): List<Source> = listOf(MhFixtureJsonSource(), MhFixtureHtmlSource())
}

internal fun fixtureBaseUrl(): String = System.getProperty("mh.fixture.baseUrl") ?: "https://localhost:8443"
