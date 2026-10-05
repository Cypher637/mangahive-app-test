package app.mangahive.mihon.ipc

/**
 * Throttles reconnect attempts after repeated runtime deaths so a crash-looping runtime is not hammered.
 * [maxDeaths] deaths inside [windowMs] -> no restart attempts for [cooldownMs].
 */
class RestartPolicy(
    private val maxDeaths: Int = 5,
    private val windowMs: Long = 60_000,
    private val cooldownMs: Long = 30_000,
) {
    private val deaths = ArrayDeque<Long>()
    private var blockedUntil = 0L

    @Synchronized fun recordDeath(now: Long) {
        deaths.addLast(now)
        while (deaths.isNotEmpty() && now - deaths.first() > windowMs) deaths.removeFirst()
        if (deaths.size >= maxDeaths) { blockedUntil = now + cooldownMs; deaths.clear() }
    }

    @Synchronized fun mayStart(now: Long): Boolean = now >= blockedUntil
}
