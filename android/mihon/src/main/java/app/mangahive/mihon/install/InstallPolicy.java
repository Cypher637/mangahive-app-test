package app.mangahive.mihon.install;

import java.util.List;
import java.util.Set;

/**
 * The verification pipeline, in the mandated order: trust -> namespace -> hash -> inspect -> package -> signature -> version
 * -> permissions -> compatibility. Pure decision function: it never installs and never executes extension code.
 * Every failure is explicit and carries a human-readable message (no stack traces for users).
 */
public final class InstallPolicy {
    private InstallPolicy() {}

    public static final class Context {
        public States.RepoTrust trust = States.RepoTrust.COMMUNITY;
        public States.Ownership ownership = States.Ownership.PRIMARY;
        public InstalledExtension installed;            // null on fresh install
        public Set<String> supportedLibs;               // exact extensionLib strings the active runtime implements
        public int hostVersion = 1;
        public boolean ackHighRiskPermissions;          // explicit user acknowledgement
        public boolean debugRecovery;                   // developer/debug downgrade only
        public boolean signerMigrationAllowed;          // default false: signer change is SIGNATURE_MISMATCH
        public boolean androidHost = true;              // false on the PWA: APKs never run in a browser
        public String pinnedCert;                       // TOFU pin for community/direct, if one is already recorded
    }

    public static final class Outcome {
        public final States.Lifecycle state;
        public final String code, message;
        public final States.Compatibility compatibility;
        public final Policies.VersionDecision version;
        Outcome(States.Lifecycle s, String code, String msg, States.Compatibility c, Policies.VersionDecision v) { state = s; this.code = code; message = msg; compatibility = c; version = v; }
        public boolean ok() { return !state.isFailure() && state != States.Lifecycle.DISABLED; }
        @Override public String toString() { return state + "/" + code; }
    }

    private static Outcome fail(States.Lifecycle s, String code, String msg, States.Compatibility c) { return new Outcome(s, code, msg, c, null); }

    public static Outcome evaluate(RepoEntry e, ApkFacts a, Context c) {
        if (!c.androidHost) return fail(States.Lifecycle.INCOMPATIBLE, "android-only", "This extension requires the MangaHive Android app.", States.Compatibility.METADATA_ONLY);
        // 1. trust
        if (c.trust == States.RepoTrust.BLOCKED || c.ownership == States.Ownership.BLOCKED)
            return fail(States.Lifecycle.BLOCKED, "blocked", "MangaHive blocked this extension because its package or signature failed verification.", States.Compatibility.BLOCKED);
        if (!c.trust.mayInstall())
            return fail(States.Lifecycle.UNTRUSTED, "untrusted-repository", "This repository is not trusted. Review it before installing from it.", States.Compatibility.BLOCKED);
        if (c.ownership == States.Ownership.CONFLICT)
            return fail(States.Lifecycle.BLOCKED, "identity-conflict", "Another repository already provides a different package under this extension identity.", States.Compatibility.BLOCKED);
        // 2. reserved namespace
        if (e.extensionId.startsWith("mangahive.") && c.trust != States.RepoTrust.OFFICIAL)
            return fail(States.Lifecycle.BLOCKED, "reserved-namespace", "This extension claims a MangaHive-reserved identity.", States.Compatibility.BLOCKED);
        // 3. hash (and size) over the bytes that were actually streamed to disk
        if (a.sha256 == null) return fail(States.Lifecycle.MALFORMED, "no-hash", "The downloaded file could not be verified.", States.Compatibility.MALFORMED);
        if (e.sha256 != null && !e.sha256.equalsIgnoreCase(a.sha256))
            return fail(States.Lifecycle.HASH_MISMATCH, "sha256-mismatch", "The downloaded file does not match the repository checksum.", States.Compatibility.BLOCKED);
        if (e.sizeBytes != null && a.sizeBytes >= 0 && e.sizeBytes.longValue() != a.sizeBytes)
            return fail(States.Lifecycle.HASH_MISMATCH, "size-mismatch", "The downloaded file does not match the repository checksum.", States.Compatibility.BLOCKED);
        // 4. inspection must have produced facts
        if (a.error != null || a.packageName == null || a.versionCode <= 0)
            return fail(States.Lifecycle.MALFORMED, "unreadable-apk", "The extension package is malformed.", States.Compatibility.MALFORMED);
        // 5. package identity: never trust filename, label or extension id alone
        if (!e.packageName.equals(a.packageName))
            return fail(States.Lifecycle.PACKAGE_MISMATCH, "package-mismatch", "The extension package does not match what the repository advertised.", States.Compatibility.BLOCKED);
        if (e.versionCode != a.versionCode)
            return fail(States.Lifecycle.MALFORMED, "version-mismatch", "The extension package version does not match the repository metadata.", States.Compatibility.MALFORMED);
        // 6. signature
        if (a.certSha256 == null || a.certSha256.isEmpty())
            return fail(States.Lifecycle.SIGNATURE_MISMATCH, "unsigned", "The extension was not signed.", States.Compatibility.BLOCKED);
        if (e.certSha256 != null && !a.certSha256.contains(e.certSha256))
            return fail(States.Lifecycle.SIGNATURE_MISMATCH, "cert-mismatch", "The extension was signed by a different certificate than expected.", States.Compatibility.BLOCKED);
        if (c.pinnedCert != null && c.installed == null && !a.certSha256.contains(c.pinnedCert))
            return fail(States.Lifecycle.SIGNATURE_MISMATCH, "pin-mismatch", "The extension was signed by a different certificate than expected.", States.Compatibility.BLOCKED);
        if (c.trust == States.RepoTrust.OFFICIAL && e.certSha256 == null && c.pinnedCert == null && c.installed == null)
            return fail(States.Lifecycle.UNTRUSTED, "official-needs-known-signer", "Official extensions must come with a known signing certificate.", States.Compatibility.BLOCKED);
        // 7. version / signer change versus what is installed
        Policies.VersionDecision vd = Policies.decide(c.installed, a.versionCode, a.certSha256, a.sha256, c.debugRecovery, c.signerMigrationAllowed);
        switch (vd) {
            case SIGNATURE_MISMATCH:
                return fail(States.Lifecycle.SIGNATURE_MISMATCH, "signer-changed", "The update was signed by a different certificate than the installed extension.", States.Compatibility.BLOCKED);
            case DOWNGRADE_BLOCKED:
                return fail(States.Lifecycle.OBSOLETE, "downgrade-blocked", "This version is older than the installed one.", States.Compatibility.OBSOLETE);
            case SAME_VERSION_DIFFERENT_CONTENT:
                return fail(States.Lifecycle.BLOCKED, "same-version-different-content", "The package changed without a version change.", States.Compatibility.BLOCKED);
            case UP_TO_DATE:
                return new Outcome(States.Lifecycle.INSTALLED, "up-to-date", "Already up to date.", States.Compatibility.SUPPORTED, vd);
            default: break;
        }
        // 8. permissions: recorded + classified; declared != granted
        Policies.Risk worst = Policies.worst(a.permissions);
        if (worst == Policies.Risk.CRITICAL)
            return fail(States.Lifecycle.BLOCKED, "dangerous-permission", "MangaHive blocked this extension because it requests permissions a source extension should not need.", States.Compatibility.BLOCKED);
        if (worst == Policies.Risk.HIGH && !c.ackHighRiskPermissions)
            return fail(States.Lifecycle.UNTRUSTED, "needs-acknowledgement", "This extension requests unusual permissions. Review them before installing.", States.Compatibility.BLOCKED);
        // 9. compatibility, decided up front instead of waiting for a ClassLoader exception
        if (e.obsolete) return fail(States.Lifecycle.OBSOLETE, "obsolete", "This extension is marked obsolete by its repository.", States.Compatibility.OBSOLETE);
        if (!a.hasExtensionFeature) return fail(States.Lifecycle.INCOMPATIBLE, "not-an-extension", "This package is not a source extension.", States.Compatibility.UNSUPPORTED);
        if (a.extensionLib == null || c.supportedLibs == null || !c.supportedLibs.contains(a.extensionLib.trim()))
            return fail(States.Lifecycle.INCOMPATIBLE, "unsupported-api", "This extension requires a newer MangaHive runtime.", States.Compatibility.UNSUPPORTED);
        if (!a.entryClassesValid) return fail(States.Lifecycle.INCOMPATIBLE, "bad-entry-point", "The extension package is malformed.", States.Compatibility.MALFORMED);
        if ((e.minHost != null && c.hostVersion < e.minHost) || (e.maxHost != null && c.hostVersion > e.maxHost))
            return fail(States.Lifecycle.INCOMPATIBLE, "host-version", "This extension requires a different MangaHive runtime version.", States.Compatibility.UNSUPPORTED);
        return new Outcome(States.Lifecycle.INSTALL_PENDING, "ok", "Ready to install.", States.Compatibility.SUPPORTED, vd);
    }
}
