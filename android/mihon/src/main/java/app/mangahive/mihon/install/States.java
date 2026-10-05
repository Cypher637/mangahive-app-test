package app.mangahive.mihon.install;

/** Stage 7 state vocabularies. Lifecycle, installation, compatibility and repository trust are SEPARATE axes. */
public final class States {
    private States() {}

    /** Authoritative pipeline + explicit failure states (no generic FAILED). */
    public enum Lifecycle {
        DISCOVERED, METADATA_VALIDATED, DOWNLOAD_PENDING, DOWNLOADING, DOWNLOADED, HASH_VERIFIED, APK_INSPECTED,
        SIGNATURE_VERIFIED, COMPATIBILITY_CHECKED, INSTALL_PENDING, INSTALLED, ENABLED, RUNNING,
        MALFORMED, BLOCKED, UNTRUSTED, HASH_MISMATCH, SIGNATURE_MISMATCH, PACKAGE_MISMATCH, INCOMPATIBLE, OBSOLETE,
        DISABLED, INSTALL_FAILED, LOAD_FAILED, RUNTIME_FAILED, RECOVERY_REQUIRED, NETWORK_FAILED, MISSING, ORPHANED;

        public boolean isPipeline() { return ordinal() <= RUNNING.ordinal(); }
        public boolean isFailure() { return !isPipeline() && this != DISABLED; }
        /** Failures that must never be loaded or re-enabled without a fresh, passing verification. */
        public boolean isHardBlock() {
            switch (this) {
                case MALFORMED: case BLOCKED: case UNTRUSTED: case HASH_MISMATCH: case SIGNATURE_MISMATCH:
                case PACKAGE_MISMATCH: case INCOMPATIBLE: case OBSOLETE: case ORPHANED: return true;
                default: return false;
            }
        }
        /** Extension code may run only in these states. */
        public boolean mayExecute() { return this == INSTALLED || this == ENABLED || this == RUNNING; }

        public static boolean canTransition(Lifecycle from, Lifecycle to) {
            if (from == to) return false;
            if (from.isPipeline() && to.isPipeline()) {
                if (to.ordinal() == from.ordinal() + 1) return true;
                // a running extension can be stopped back to ENABLED
                return from == RUNNING && to == ENABLED || from == INSTALLED && to == ENABLED;
            }
            if (to == DISABLED) return from.isPipeline() && from.ordinal() >= INSTALLED.ordinal() || from == LOAD_FAILED || from == RUNTIME_FAILED;
            if (from == DISABLED) return to == ENABLED;
            if (to.isFailure()) {
                if (from == BLOCKED) return false;           // terminal: no casual bypass
                if (to == MISSING || to == ORPHANED) return from.ordinal() >= INSTALLED.ordinal() && from.isPipeline() || from == DISABLED;
                if (to == LOAD_FAILED || to == RUNTIME_FAILED) return from.ordinal() >= INSTALL_PENDING.ordinal() && from.isPipeline();
                if (to == SIGNATURE_MISMATCH || to == BLOCKED) return true;
                return from.isPipeline() && from.ordinal() < INSTALLED.ordinal() || from == DISCOVERED;
            }
            if (from.isFailure()) {
                if (from == BLOCKED) return false;
                if (to == DISCOVERED) return true;                       // fresh retry from the top
                return (from == LOAD_FAILED || from == RUNTIME_FAILED) && to == ENABLED; // user retry
            }
            return false;
        }
    }

    public enum Installation { NOT_INSTALLED, INSTALLING, INSTALLED, MISSING, ORPHANED }

    public enum Compatibility {
        SUPPORTED, DECLARATIVE_COMPATIBLE, NATIVE_BRIDGE_REQUIRED, METADATA_ONLY, UNSUPPORTED, MALFORMED, BLOCKED,
        DISABLED, FAILED, OBSOLETE
    }

    public enum RepoTrust {
        OFFICIAL, COMMUNITY, DIRECT, UNTRUSTED, BLOCKED;
        public boolean mayInstall() { return this == OFFICIAL || this == COMMUNITY || this == DIRECT; }
    }

    public enum Ownership { PRIMARY, ALTERNATE_REPOSITORY, CONFLICT, BLOCKED }
}
