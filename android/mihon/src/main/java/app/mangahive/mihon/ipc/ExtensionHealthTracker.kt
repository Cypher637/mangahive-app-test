package app.mangahive.mihon.ipc

import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Main-process view of extension health, driven by what happens to the runtime process.
 *
 * - runtime dies            -> every known extension becomes RUNTIME_UNAVAILABLE; extensions that had a request in flight
 *                              when it died get a crash strike.
 * - [crashThreshold] strikes in a row -> QUARANTINED: the main process stops sending source calls for it until the
 *                              user re-enables it. This breaks crash loops caused by one bad extension.
 * - a successful reply clears the strikes.
 * Blame is approximate when several extensions are in flight at the moment of a crash; all of them are charged.
 */
class ExtensionHealthTracker(private val crashThreshold: Int = 3) {
    enum class Health { UNKNOWN, HEALTHY, RUNTIME_UNAVAILABLE, QUARANTINED }

    private val lock = ReentrantLock()
    private val strikes = HashMap<String, Int>()
    private val states = HashMap<String, Health>()

    fun noteExtension(id: String) = lock.withLock { states.putIfAbsent(id, Health.UNKNOWN); Unit }

    fun onRuntimeDied(inFlightExtensionIds: Set<String>) {
        lock.withLock {
            for (id in inFlightExtensionIds) {
                states.putIfAbsent(id, Health.UNKNOWN)
                strikes[id] = (strikes[id] ?: 0) + 1
            }
            for (id in states.keys.toList()) {
                states[id] = when {
                    (strikes[id] ?: 0) >= crashThreshold -> Health.QUARANTINED
                    states[id] == Health.QUARANTINED -> Health.QUARANTINED
                    else -> Health.RUNTIME_UNAVAILABLE
                }
            }
        }
    }

    /** The restarted runtime answered a health ping. */
    fun onRuntimeUp() {
        lock.withLock {
            for (id in states.keys.toList()) if (states[id] == Health.RUNTIME_UNAVAILABLE) states[id] = Health.UNKNOWN
        }
    }

    fun onSuccess(id: String) {
        lock.withLock {
            strikes[id] = 0
            if (states[id] != Health.QUARANTINED) states[id] = Health.HEALTHY
        }
    }

    /** User re-enabled the extension: forgive past crashes. */
    fun release(id: String) {
        lock.withLock { strikes[id] = 0; states[id] = Health.UNKNOWN }
    }

    fun mayDispatch(id: String): Boolean = lock.withLock { states[id] != Health.QUARANTINED }

    fun healthOf(id: String): Health = lock.withLock { states[id] ?: Health.UNKNOWN }

    fun snapshot(): Map<String, Health> = lock.withLock { HashMap(states) }
}
