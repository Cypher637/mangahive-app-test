package app.mangahive.mihon.install;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Version, signer and permission rules. Pure functions; no I/O. */
public final class Policies {
    private Policies() {}

    // ---------- version / signer ----------
    public enum VersionDecision { FRESH_INSTALL, UPDATE, UP_TO_DATE, DOWNGRADE_BLOCKED, SAME_VERSION_DIFFERENT_CONTENT, SIGNATURE_MISMATCH }

    /** versionCode is authoritative ordering. Repository order never matters. */
    public static VersionDecision decide(InstalledExtension installed, long incomingCode, List<String> incomingCerts, String incomingSha,
                                         boolean debugRecovery, boolean signerMigrationAllowed) {
        if (installed == null) return VersionDecision.FRESH_INSTALL;
        if (!sameSet(installed.certSha256, incomingCerts) && !signerMigrationAllowed) return VersionDecision.SIGNATURE_MISMATCH;
        if (incomingCode < installed.versionCode) return debugRecovery ? VersionDecision.UPDATE : VersionDecision.DOWNGRADE_BLOCKED;
        if (incomingCode == installed.versionCode) {
            return installed.sha256 != null && installed.sha256.equalsIgnoreCase(incomingSha) ? VersionDecision.UP_TO_DATE : VersionDecision.SAME_VERSION_DIFFERENT_CONTENT;
        }
        return VersionDecision.UPDATE;
    }

    static boolean sameSet(List<String> a, List<String> b) {
        if (a == null || b == null) return false;
        return new HashSet<String>(a).equals(new HashSet<String>(b)) && !a.isEmpty();
    }

    // ---------- permissions ----------
    public enum Risk { NONE, LOW, HIGH, CRITICAL }
    public enum HostPermission { NETWORK, STORAGE, SOURCE, COOKIES }

    private static final Set<String> CRITICAL = new HashSet<String>(Arrays.asList(
        "android.permission.REQUEST_INSTALL_PACKAGES", "android.permission.READ_SMS", "android.permission.RECEIVE_SMS",
        "android.permission.SEND_SMS", "android.permission.RECORD_AUDIO", "android.permission.CAMERA",
        "android.permission.READ_CALL_LOG", "android.permission.WRITE_CALL_LOG", "android.permission.CALL_PHONE"));
    private static final Set<String> HIGH = new HashSet<String>(Arrays.asList(
        "android.permission.QUERY_ALL_PACKAGES", "android.permission.READ_CONTACTS", "android.permission.WRITE_CONTACTS",
        "android.permission.ACCESS_FINE_LOCATION", "android.permission.ACCESS_COARSE_LOCATION", "android.permission.READ_PHONE_STATE"));
    private static final Set<String> LOW = new HashSet<String>(Arrays.asList(
        "android.permission.INTERNET", "android.permission.ACCESS_NETWORK_STATE", "android.permission.WAKE_LOCK",
        "android.permission.READ_EXTERNAL_STORAGE", "android.permission.WRITE_EXTERNAL_STORAGE", "android.permission.FOREGROUND_SERVICE"));

    public static Risk classify(String perm) {
        if (CRITICAL.contains(perm)) return Risk.CRITICAL;
        if (HIGH.contains(perm)) return Risk.HIGH;
        if (LOW.contains(perm)) return Risk.LOW;
        return perm != null && perm.startsWith("android.permission.") ? Risk.LOW : Risk.HIGH; // unknown/custom perms are not assumed benign
    }

    public static Risk worst(List<String> perms) {
        Risk w = Risk.NONE;
        if (perms != null) for (String p : perms) { Risk r = classify(p); if (r.ordinal() > w.ordinal()) w = r; }
        return w;
    }

    public static List<String> atRisk(List<String> perms, Risk min) {
        List<String> out = new ArrayList<String>();
        if (perms != null) for (String p : perms) if (classify(p).ordinal() >= min.ordinal()) out.add(p);
        return out;
    }

    /** What the HOST actually lets an extension do. Independent of the manifest on purpose: declaring grants nothing. */
    public static Set<HostPermission> hostGrants(List<String> declaredIgnored) {
        return Collections.unmodifiableSet(new HashSet<HostPermission>(Arrays.asList(HostPermission.NETWORK, HostPermission.STORAGE, HostPermission.SOURCE)));
        // COOKIES is deliberately not granted: cookies are brokered per extensionId+sourceId, never handed to extension code.
    }
}
