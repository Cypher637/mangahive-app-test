package app.mangahive.mihon.install;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Startup recovery: compare the registry with what is actually on disk. Never trusts an APK just because it exists. */
public final class Reconciler {
    private Reconciler() {}

    public interface ApkProbe { ApkFacts probe(File apk); }

    public static final class Report {
        public final List<String> missing = new ArrayList<String>(), changed = new ArrayList<String>(), orphans = new ArrayList<String>(), healthy = new ArrayList<String>();
    }

    public static Report reconcile(ExtensionRegistry reg, File apkDir, ApkProbe probe, long now) throws IOException {
        Report rep = new Report();
        Set<String> referenced = new HashSet<String>();
        for (InstalledExtension r : reg.all()) {
            if (r.apkPath != null) referenced.add(new File(r.apkPath).getAbsolutePath());
            if (r.state.isHardBlock() || r.state == States.Lifecycle.DISABLED && !new File(String.valueOf(r.apkPath)).isFile()) { /* still check below */ }
            File apk = r.apkPath == null ? null : new File(r.apkPath);
            if (apk == null || !apk.isFile()) {
                if (r.state != States.Lifecycle.MISSING) { r.state = States.Lifecycle.MISSING; r.enabled = false; r.failureCode = "apk-missing"; r.lastFailure = "The installed package is no longer on this device."; r.updatedAt = now; reg.put(r); }
                rep.missing.add(r.extensionId);
                continue;
            }
            ApkFacts f = probe.probe(apk);
            String problem = null;
            if (f == null || f.error != null || f.packageName == null) problem = "unreadable-apk";
            else if (!f.packageName.equals(r.packageName)) problem = "package-changed";
            else if (f.versionCode != r.versionCode) problem = "version-changed";
            else if (!Policies.sameSet(f.certSha256, r.certSha256)) problem = "signer-changed";
            else if (f.sha256 != null && r.sha256 != null && !f.sha256.equalsIgnoreCase(r.sha256)) problem = "content-changed";
            if (problem != null) {
                r.state = problem.equals("signer-changed") ? States.Lifecycle.SIGNATURE_MISMATCH : problem.equals("content-changed") ? States.Lifecycle.HASH_MISMATCH : States.Lifecycle.BLOCKED;
                r.enabled = false; r.failureCode = problem; r.lastFailure = "The installed package no longer matches the registry."; r.updatedAt = now; reg.put(r);
                rep.changed.add(r.extensionId);
            } else {
                if (r.state == States.Lifecycle.MISSING) { r.state = States.Lifecycle.DISABLED; r.failureCode = null; r.lastFailure = null; r.updatedAt = now; reg.put(r); }
                rep.healthy.add(r.extensionId);
            }
        }
        File[] files = apkDir.listFiles();
        if (files != null) for (File f : files) if (f.isFile() && f.getName().endsWith(".apk") && !referenced.contains(f.getAbsolutePath())) rep.orphans.add(f.getName()); // ORPHANED: reported, never loaded
        return rep;
    }
}
