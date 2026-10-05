package app.mangahive.mihon.install;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** Persistent registry row. Identity = ecosystem + repositoryId + extensionId + packageName (never the display name). */
public final class InstalledExtension {
    public String ecosystem = "mihon", repositoryId, extensionId, packageName, displayName, versionName, sha256, apkPath;
    public States.RepoTrust trust = States.RepoTrust.COMMUNITY;
    public long versionCode, installedAt, updatedAt;
    public List<String> certSha256 = new ArrayList<String>(), sourceIds = new ArrayList<String>();
    public boolean enabled;
    public States.Lifecycle state = States.Lifecycle.INSTALLED;
    public States.Compatibility compatibility = States.Compatibility.SUPPORTED;
    public States.Ownership ownership = States.Ownership.PRIMARY;
    public String failureCode, lastFailure;
    public int failureCount;
    public long lastFailureAt;
    // rollback info (what we replaced). Android install semantics may not permit an automatic downgrade; this is for recovery UI.
    public long prevVersionCode = -1;
    public String prevVersionName, prevSha256, prevApkPath;
    public List<String> prevCertSha256 = new ArrayList<String>();

    public InstalledExtension copy() {
        InstalledExtension c = new InstalledExtension();
        c.ecosystem = ecosystem; c.repositoryId = repositoryId; c.extensionId = extensionId; c.packageName = packageName;
        c.displayName = displayName; c.versionName = versionName; c.sha256 = sha256; c.apkPath = apkPath; c.trust = trust;
        c.versionCode = versionCode; c.installedAt = installedAt; c.updatedAt = updatedAt;
        c.certSha256 = new ArrayList<String>(certSha256); c.sourceIds = new ArrayList<String>(sourceIds);
        c.enabled = enabled; c.state = state; c.compatibility = compatibility; c.ownership = ownership;
        c.failureCode = failureCode; c.lastFailure = lastFailure; c.failureCount = failureCount; c.lastFailureAt = lastFailureAt;
        c.prevVersionCode = prevVersionCode; c.prevVersionName = prevVersionName; c.prevSha256 = prevSha256; c.prevApkPath = prevApkPath;
        c.prevCertSha256 = new ArrayList<String>(prevCertSha256);
        return c;
    }

    public String identity() { return ecosystem + "|" + repositoryId + "|" + extensionId + "|" + packageName; }
    public List<String> certs() { return Collections.unmodifiableList(certSha256); }
}
