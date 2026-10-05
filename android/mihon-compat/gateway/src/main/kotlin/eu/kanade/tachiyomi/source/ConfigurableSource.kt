package eu.kanade.tachiyomi.source

import androidx.preference.PreferenceScreen

/**
 * tachiyomix 1.6.0 `ConfigurableSource`. Present so extensions implementing it load; MangaHive does not yet show a
 * preference screen (the host never calls [setupPreferenceScreen]; androidx.preference is not routed to extensions).
 */
@Suppress("Unused")
interface ConfigurableSource {
    fun setupPreferenceScreen(screen: PreferenceScreen)
}
