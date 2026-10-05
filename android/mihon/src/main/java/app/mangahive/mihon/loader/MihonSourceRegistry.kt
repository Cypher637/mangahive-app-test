package app.mangahive.mihon.loader

/**
 * Canonical production source registry. A source identity is always extensionId + sourceId; source ids from different
 * extensions are intentionally allowed to collide because the stable key contains the owning extension.
 *
 * The registry owns adapters only while their extension ClassLoader is live. Persisted extension state is the authority
 * across process restarts; RuntimeEngine reloads enabled APKs before exposing this registry to callers.
 */
class MihonSourceRegistry(
    val health: SourceHealthTracker = SourceHealthTracker(),
) {
    class Entry(val key: SourceKey, val ownerSigners: Set<String>, val adapter: MangaHiveSourceAdapter)

    private val byKey = LinkedHashMap<String, Entry>()
    private val signersByExtension = HashMap<String, Set<String>>()

    @Synchronized
    fun mayOwn(extensionId: String, signers: List<String>): Boolean {
        if (signers.isEmpty()) return false
        val current = signersByExtension[extensionId] ?: return true
        return current == signers.toSet()
    }

    @Synchronized
    fun restoreOwnership(extensionId: String, signers: List<String>) {
        require(extensionId.isNotBlank() && signers.isNotEmpty()) { "invalid persisted ownership" }
        val existing = signersByExtension[extensionId]
        if (existing == null) signersByExtension[extensionId] = signers.toSet()
        else require(existing == signers.toSet()) { "OWNER_MISMATCH" }
    }

    @Synchronized
    fun replaceExtension(extensionId: String, signers: List<String>, entries: List<Entry>) {
        require(mayOwn(extensionId, signers)) { "OWNER_MISMATCH" }
        val seen = HashSet<String>()
        for (e in entries) {
            require(e.key.extensionId == extensionId) { "OWNER_MISMATCH: key ${e.key} not owned by $extensionId" }
            require(seen.add(e.key.value)) { "DUPLICATE_SOURCE: ${e.key}" }
        }
        byKey.keys.removeAll { SourceKey.parse(it)?.extensionId == extensionId }
        entries.forEach { byKey[it.key.value] = it }
        signersByExtension[extensionId] = signers.toSet()
    }

    @Synchronized
    fun unregister(extensionId: String) {
        byKey.keys.removeAll { SourceKey.parse(it)?.extensionId == extensionId }
        signersByExtension.remove(extensionId)
    }

    @Synchronized fun get(key: String): MangaHiveSourceAdapter? = byKey[key]?.adapter
    @Synchronized fun get(extensionId: String, sourceId: Long): MangaHiveSourceAdapter? = byKey[SourceKey.of(extensionId, sourceId).value]?.adapter
    @Synchronized fun all(): List<SourceInfo> = byKey.values.map { it.adapter.info }
    @Synchronized fun sourcesOf(extensionId: String): List<SourceInfo> = byKey.values.filter { it.key.extensionId == extensionId }.map { it.adapter.info }
    @Synchronized fun entries(): List<Entry> = byKey.values.toList()
    @Synchronized fun clearAdapterSession(extensionId: String) { byKey.values.filter { it.key.extensionId == extensionId }.forEach { it.adapter.clearSessionState() } }
}
