package app.mangahive.mihon.loader

enum class LoadFailureCode {
    UNREADABLE_APK, PACKAGE_MISMATCH, BAD_PACKAGE_NAME, NOT_AN_EXTENSION, INCOMPATIBLE_API, BAD_ENTRY_POINT,
    COMPAT_RUNTIME_UNAVAILABLE, CLASSLOADER_FAILED, INIT_FAILED, NO_SOURCES, BAD_SOURCE_METADATA,
    DUPLICATE_SOURCE, OWNER_MISMATCH,
}

/** Static facts read from the APK manifest. No extension code has run. */
data class RawManifest(
    val packageName: String,
    val versionName: String?,
    val versionCode: Long,
    val features: Set<String>,
    val meta: Map<String, String?>,
    val signerSha256: List<String>,
)

data class ExtensionDescriptor(
    val extensionId: String,
    val displayName: String,
    val versionName: String?,
    val versionCode: Long,
    val apiVersion: String,
    val contentWarning: Int,
    val entryClasses: List<String>,
    val signerSha256: List<String>,
)

sealed class Detection {
    data class Compatible(val descriptor: ExtensionDescriptor) : Detection()
    data class Rejected(val code: LoadFailureCode, val detail: String) : Detection()
}

object ExtensionDetector {
    const val FEATURE = "tachiyomi.extension"
    const val META_LIB = "tachiyomix.extensionLib"
    const val META_NAME = "tachiyomix.name"
    const val META_WARNING = "tachiyomix.contentWarning"
    const val META_CLASS = "tachiyomi.extension.class"
    const val MAX_ENTRY_CLASSES = 16

    /** [supportedApiVersions]: exact extensionLib strings the active compat runtime implements. No ranges, no guessing. */
    fun detect(raw: RawManifest, supportedApiVersions: Set<String>): Detection {
        if (!SourceKey.isValidExtensionId(raw.packageName)) return Detection.Rejected(LoadFailureCode.BAD_PACKAGE_NAME, "package name not usable as extension id")
        if (FEATURE !in raw.features) return Detection.Rejected(LoadFailureCode.NOT_AN_EXTENSION, "missing uses-feature $FEATURE")
        val lib = raw.meta[META_LIB]?.trim().orEmpty()
        if (lib.isEmpty()) return Detection.Rejected(LoadFailureCode.INCOMPATIBLE_API, "missing $META_LIB")
        if (lib !in supportedApiVersions) return Detection.Rejected(LoadFailureCode.INCOMPATIBLE_API, "extension lib '$lib' not supported (supported: ${supportedApiVersions.sorted()})")
        val warning = (raw.meta[META_WARNING] ?: "0").trim().toIntOrNull()
        if (warning == null || warning !in 0..2) return Detection.Rejected(LoadFailureCode.NOT_AN_EXTENSION, "bad $META_WARNING")
        val entry = raw.meta[META_CLASS]
            ?: return Detection.Rejected(LoadFailureCode.BAD_ENTRY_POINT, "missing $META_CLASS")
        val classes = resolveEntryClasses(raw.packageName, entry)
            ?: return Detection.Rejected(LoadFailureCode.BAD_ENTRY_POINT, "entry class list invalid or outside the extension package")
        val name = raw.meta[META_NAME]?.trim()?.takeIf { it.isNotEmpty() && it.length <= 128 } ?: raw.packageName
        return Detection.Compatible(
            ExtensionDescriptor(raw.packageName, name, raw.versionName, raw.versionCode, lib, warning, classes, raw.signerSha256),
        )
    }

    /**
     * `tachiyomi.extension.class` holds one or more class names separated by ';' (list form ASSUMED from legacy
     * Tachiyomi; not verified for 1.6). Each is an FQCN, ".Relative" or a bare simple name, and must sit in the
     * APK's own package tree by exact segment match.
     */
    fun resolveEntryClasses(pkg: String, raw: String): List<String>? {
        val parts = raw.split(';').map { it.trim() }.filter { it.isNotEmpty() }
        if (parts.isEmpty() || parts.size > MAX_ENTRY_CLASSES) return null
        val own = PackageBoundary.builder().tree(pkg).build()
        val out = LinkedHashSet<String>()
        for (p in parts) {
            val fq = when {
                p.startsWith(".") -> pkg + p
                !p.contains('.') -> "$pkg.$p"
                else -> p
            }
            if (!own.allows(fq)) return null
            out += fq
        }
        return out.toList()
    }
}
