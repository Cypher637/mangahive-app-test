package app.mangahive.mihon.runtime

/**
 * LEGACY / INTERNAL. Describes the MangaHive-internal stub runtime only (the hand-written
 * eu.kanade.tachiyomi.* stubs inside this module). It is NOT a Mihon compatibility profile and must not
 * be shown or reported as one.
 *
 * The real, pinned upstream profiles are [app.mangahive.mihon.compat.MihonApiProfiles] (MIHON_1_6, MIHON_1_4).
 * Those are descriptions only; no runtime implements them yet.
 */
object MihonCompatibilityProfile {
    const val PROFILE_ID = "mangahive-internal-stub-v1"
    const val SUPPORTED_SOURCE_API = "mangahive-internal-stub (NOT upstream Mihon API)"

    /** The only manifest meta-data key documented upstream for the entry class (tachiyomix README). */
    const val REQUIRED_META = "tachiyomi.extension.class"

    val internalStubInterfaces = listOf(
        "eu.kanade.tachiyomi.source.CatalogueSource (internal stub)",
        "eu.kanade.tachiyomi.source.HttpSource (internal stub; upstream lives in ...source.online)"
    )

    const val NOTES = """
Internal stub runtime only. Proves nothing about Mihon/Tachiyomi extension compatibility.
Upstream API pins and boundaries: MIHON_API_PROFILES.md.
"""
}
