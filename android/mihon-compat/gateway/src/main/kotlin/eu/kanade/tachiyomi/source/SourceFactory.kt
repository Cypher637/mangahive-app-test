package eu.kanade.tachiyomi.source

@Suppress("Unused")
interface SourceFactory {
    fun createSources(): List<Source>
}
