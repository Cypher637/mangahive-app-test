package app.mangahive.mihon.loader

/** `mihon:<extension-id>:<source-id>`. extension-id = APK package name; source-id = decimal Long. Neither can contain ':'. */
class SourceKey private constructor(val extensionId: String, val sourceId: Long) {
    val value: String get() = "$PREFIX:$extensionId:$sourceId"
    override fun toString() = value
    override fun equals(other: Any?) = other is SourceKey && other.extensionId == extensionId && other.sourceId == sourceId
    override fun hashCode() = 31 * extensionId.hashCode() + sourceId.hashCode()

    companion object {
        const val PREFIX = "mihon"
        private val EXT_ID = Regex("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+")
        private val SRC_ID = Regex("-?[0-9]{1,19}")

        fun isValidExtensionId(id: String) = EXT_ID.matches(id)

        fun of(extensionId: String, sourceId: Long): SourceKey {
            require(isValidExtensionId(extensionId)) { "bad extension id" }
            return SourceKey(extensionId, sourceId)
        }

        fun parse(text: String): SourceKey? {
            val parts = text.split(':')
            if (parts.size != 3 || parts[0] != PREFIX || !EXT_ID.matches(parts[1]) || !SRC_ID.matches(parts[2])) return null
            val id = parts[2].toLongOrNull() ?: return null
            return SourceKey(parts[1], id)
        }
    }
}
