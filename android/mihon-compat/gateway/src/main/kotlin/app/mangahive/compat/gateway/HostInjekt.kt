package app.mangahive.compat.gateway

import dev.mihon.injekt.patchInjekt
import eu.kanade.tachiyomi.network.NetworkHelper
import kotlinx.serialization.json.Json
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.InjektScope
import uy.kohesive.injekt.api.fullType

/**
 * Installs the Injekt registry extensions resolve their dependencies from (`by injectLazy()` / `Injekt.get()`), exactly the
 * way upstream hosts do: `dev.mihon.injekt.patchInjekt()` (PatchedDefaultRegister), then singletons for the host
 * [NetworkHelper] and the app-wide kotlinx [Json] (same configuration Mihon registers).
 *
 * Called by the gateway before EVERY extension construction. If extension code replaced the global scope or re-registered a
 * host type since, the host scope and registrations are restored first. Note a re-registered NetworkHelper cannot escape the
 * broker anyway: NetworkHelper is final and every instance resolves its client from the host identity scope.
 */
internal object HostInjekt {
    private var scope: InjektScope? = null

    @Synchronized
    fun ensureInstalled() {
        val current = scope
        if (current == null || Injekt !== current || !hostRegistrationsIntact(current)) {
            if (current == null) {
                patchInjekt()
                scope = Injekt
            } else {
                Injekt = current
            }
            register(scope!!)
        }
    }

    private fun register(s: InjektScope) {
        s.addSingleton(fullType<NetworkHelper>(), networkHelper)
        s.addSingleton(fullType<Json>(), json)
    }

    private fun hostRegistrationsIntact(s: InjektScope): Boolean = try {
        s.getInstance<NetworkHelper>(fullType<NetworkHelper>().type) === networkHelper &&
            s.getInstance<Json>(fullType<Json>().type) === json
    } catch (_: Exception) {
        false
    }

    private val networkHelper = NetworkHelper()

    private val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
    }
}
