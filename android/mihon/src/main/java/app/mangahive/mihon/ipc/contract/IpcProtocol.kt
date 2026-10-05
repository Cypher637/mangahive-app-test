package app.mangahive.mihon.ipc.contract

/**
 * Wire contract between the MangaHive main process and the :mihon runtime process.
 *
 * This package is shared by both processes and therefore must stay free of: android.* types, reflection, any
 * loader/runtime/network package, and untyped containers. A static test (mihon_stage4_isolation_test.js) enforces it.
 */
const val IPC_PROTOCOL_VERSION = 1

/** Fully qualified service class, as a string so the main process never links against runtime classes. */
const val RUNTIME_SERVICE_CLASS = "app.mangahive.mihon.runtime.MihonExtensionService"

/** The complete operation allowlist. Anything not listed here cannot be expressed on the wire. */
enum class Op(val wire: String, val isSourceOp: Boolean = false) {
    INSTALL("install"),
    INSPECT("inspect"),
    ENABLE("enable"),
    DISABLE("disable"),
    UNINSTALL("uninstall"),
    LIST_SOURCES("listSources"),
    SEARCH("search", true),
    DETAILS("details", true),
    CHAPTERS("chapters", true),
    PAGES("pages", true),
    DOWNLOAD("download", true),
    DELETE_DOWNLOAD("deleteDownload", false),
    CANCEL("cancel"),
    HEALTH("health");

    companion object {
        private val byWire = values().associateBy { it.wire }
        fun fromWire(s: String): Op? = byWire[s]
    }
}

/**
 * Closed set of failure codes. The human text is fixed per code, so no exception message, class name or stack
 * trace can ever cross the process boundary (or reach the WebView) by construction.
 */
enum class ErrorCode(val message: String, val retryable: Boolean) {
    BAD_REQUEST("The request was malformed.", false),
    UNSUPPORTED_VERSION("Unsupported protocol version.", false),
    UNKNOWN_OP("Unknown operation.", false),
    NOT_FOUND("Extension or source not found.", false),
    DISABLED("Extension is disabled.", false),
    QUARANTINED("Extension is quarantined after repeated runtime crashes.", false),
    COMPAT_RUNTIME_UNAVAILABLE("The Mihon compatibility runtime is not available.", false),
    DOWNLOAD_FAILED("The extension download failed.", true),
    OFFLINE_DOWNLOAD_FAILED("The offline chapter download failed.", true),
    OFFLINE_STORAGE_FULL("Offline storage is full.", true),
    OFFLINE_CORRUPTED("The saved offline chapter is corrupted.", false),
    OFFLINE_POLICY_BLOCKED("Offline download is blocked by content policy.", false),
    VERIFICATION_FAILED("The extension failed verification.", false),
    DOWNGRADE_BLOCKED("Installing an older version is blocked.", false),
    OWNER_MISMATCH("The extension is owned by a different signer.", false),
    LOAD_FAILED("The extension could not be loaded.", false),
    SOURCE_ERROR("The source reported an error.", true),
    CANCELLED("The operation was cancelled.", false),
    TIMEOUT("The operation timed out.", true),
    RUNTIME_DIED("The extension runtime stopped unexpectedly.", true),
    RUNTIME_UNAVAILABLE("The extension runtime is not available.", true),
    BUSY("The extension runtime is busy.", true),
    RESPONSE_TOO_LARGE("The response was too large to transfer.", false),
    INTERNAL("Internal error.", false);

    companion object {
        fun fromWire(name: String): ErrorCode? = values().firstOrNull { it.name == name }
    }
}

object IpcLimits {
    const val MAX_REQUEST_CHARS = 16 * 1024
    /** Binder transactions share ~1 MB per process and Strings are UTF-16, so keep well below it. */
    const val MAX_RESPONSE_CHARS = 250_000

    val REQUEST_ID = Regex("[A-Za-z0-9_.-]{1,64}")
    /** Must stay identical to SourceKey's extension-id grammar (checked by a static test). */
    val EXTENSION_ID = Regex("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+")
    val SHA256 = Regex("[0-9a-fA-F]{64}")
    val DETAIL = Regex("[A-Z0-9_]{1,48}")

    const val MAX_EXTENSION_ID = 255
    const val MAX_QUERY = 512
    const val MAX_URL = 2048
    const val MAX_TEXT = 512
    const val MAX_DESCRIPTION = 8192
    const val MAX_PAGE_NUMBER = 1000

    const val MAX_MANGA = 100
    const val MAX_CHAPTERS = 5000
    const val MAX_PAGES = 500
    const val MAX_GENRES = 64
    const val MAX_SOURCES = 512
    const val MAX_EXTENSIONS = 256
    const val MAX_SIGNERS = 8
    const val MAX_CANONICAL_ID = 256
    const val MAX_REMOTE_ID = 2048
    const val MAX_OFFLINE_BYTES = 512L * 1024L * 1024L
    const val MAX_PAGE_BYTES = 25L * 1024L * 1024L
    const val DEFAULT_OFFLINE_STORAGE_BYTES = 2L * 1024L * 1024L * 1024L
    const val MAX_OFFLINE_STORAGE_BYTES = 8L * 1024L * 1024L * 1024L
    const val MAX_CLEANUP_DAYS = 3650
}
