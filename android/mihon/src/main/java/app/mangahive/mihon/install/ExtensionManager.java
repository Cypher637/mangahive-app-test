package app.mangahive.mihon.install;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/**
 * Legacy policy/lifecycle test harness. Production Android lifecycle is owned by RuntimeEngine + Stage7ExtensionRecords; this
 * class remains only for JVM policy tests and must not be instantiated by the Android service.
 *
 * Install / enable / disable / update / uninstall over the persistent registry. Registry rows are written only after the new
 * package passed [InstallPolicy] AND activated; a failed update leaves the working version untouched. The manager holds NO handle to
 * library, history, progress, downloads, account or community data, so uninstall cannot reach them.
 */
public final class ExtensionManager {
    /** Loads the validated package through the Stage 6.6A runtime. Throwing means the package could not be activated. */
    public interface Activator { void activate(InstalledExtension candidate) throws Exception; void deactivate(String extensionId); }
    /** Extension-owned state only. */
    public interface Cleanup {
        void releaseSources(String extensionId) throws Exception;
        void deleteRuntimeState(String extensionId) throws Exception;
        void deleteStorage(String extensionId) throws Exception;
        void deleteCookies(String extensionId) throws Exception;
        void deleteCache(String extensionId) throws Exception;
        void deleteApk(InstalledExtension rec) throws Exception;
    }

    private final ExtensionRegistry registry;
    private final Activator activator;
    private final Cleanup cleanup;
    private final Ownership.SourceTable sources;
    private final FailureTracker failures;

    public ExtensionManager(ExtensionRegistry r, Activator a, Cleanup c, Ownership.SourceTable s, FailureTracker f) { registry = r; activator = a; cleanup = c; sources = s; failures = f; }

    /** Install or update. [outcome] must be the result of InstallPolicy.evaluate for exactly this entry/facts pair. */
    public InstallPolicy.Outcome apply(RepoEntry e, ApkFacts a, InstallPolicy.Context ctx, String apkPath, long now) {
        InstallPolicy.Outcome o = InstallPolicy.evaluate(e, a, ctx);
        if (!o.ok() || o.state != States.Lifecycle.INSTALL_PENDING) return o;
        InstalledExtension old = registry.get(e.extensionId);
        InstalledExtension n = new InstalledExtension();
        n.ecosystem = e.ecosystem; n.repositoryId = e.repositoryId; n.extensionId = e.extensionId; n.packageName = a.packageName;
        n.displayName = a.applicationLabel != null ? a.applicationLabel : e.extensionId; n.versionName = a.versionName; n.versionCode = a.versionCode;
        n.sha256 = a.sha256; n.apkPath = apkPath; n.trust = ctx.trust; n.certSha256 = new ArrayList<String>(a.certSha256); n.sourceIds = new ArrayList<String>(e.sourceIds);
        n.compatibility = o.compatibility; n.ownership = ctx.ownership; n.enabled = true; n.state = States.Lifecycle.ENABLED;
        n.installedAt = old != null ? old.installedAt : now; n.updatedAt = now;
        if (old != null) { n.prevVersionCode = old.versionCode; n.prevVersionName = old.versionName; n.prevSha256 = old.sha256; n.prevApkPath = old.apkPath; n.prevCertSha256 = new ArrayList<String>(old.certSha256); n.enabled = old.enabled; if (!old.enabled) n.state = States.Lifecycle.DISABLED; }
        try {
            if (n.enabled) activator.activate(n);                 // new package only becomes current if it loads
        } catch (Throwable t) {
            failures.record(e.extensionId, "LOAD_FAILED");
            if (old != null) { // working version retained; record why the update did not take
                old.failureCode = "update-activation-failed"; old.lastFailure = "The update could not be loaded. The previous version is still installed."; old.failureCount++; old.lastFailureAt = now;
                try { registry.put(old); } catch (IOException ignored) { }
            }
            return new InstallPolicy.Outcome(States.Lifecycle.LOAD_FAILED, "activation-failed", "The extension could not be loaded.", States.Compatibility.FAILED, o.version);
        }
        try { registry.put(n); } catch (IOException io) {
            activator.deactivate(n.extensionId);
            if (old != null) { try { activator.activate(old); } catch (Throwable ignored) { } }
            return new InstallPolicy.Outcome(States.Lifecycle.INSTALL_FAILED, "persist-failed", "MangaHive could not save the installation.", States.Compatibility.FAILED, o.version);
        }
        for (String s : n.sourceIds) sources.claim(Ownership.SourceTable.key(n.extensionId, s), n.extensionId);
        failures.success(n.extensionId);
        return new InstallPolicy.Outcome(n.state, "installed", "Ready.", o.compatibility, o.version);
    }

    public boolean mayLoad(String id) {
        InstalledExtension r = registry.get(id);
        return r != null && r.enabled && r.state.mayExecute() && failures.mayAttempt(id);
    }

    public States.Lifecycle disable(String id) throws IOException {
        InstalledExtension r = registry.get(id);
        if (r == null) return null;
        activator.deactivate(id);                        // stop new execution; library/history/downloads untouched
        r.enabled = false; r.state = States.Lifecycle.DISABLED; registry.put(r);
        return r.state;
    }

    public States.Lifecycle enable(String id, long now) throws IOException {
        InstalledExtension r = registry.get(id);
        if (r == null) return null;
        if (r.state.isHardBlock() || r.state == States.Lifecycle.MISSING) return r.state;   // needs a fresh passing verification first
        try { activator.activate(r); } catch (Throwable t) {
            r.state = States.Lifecycle.LOAD_FAILED; r.enabled = false; r.failureCode = "load-failed"; r.failureCount++; r.lastFailureAt = now; failures.record(id, "LOAD_FAILED"); registry.put(r); return r.state;
        }
        failures.release(id);
        r.enabled = true; r.state = States.Lifecycle.ENABLED; r.failureCode = null; r.lastFailure = null; registry.put(r);
        return r.state;
    }

    /** Returns the list of cleanup steps that failed (empty = fully removed). On any failure the row stays so uninstall can be retried. */
    public List<String> uninstall(final String id) throws IOException {
        final InstalledExtension r = registry.get(id);
        final List<String> errs = new ArrayList<String>();
        if (r == null) return errs;
        activator.deactivate(id);
        run(errs, "sources", new Op() { public void run() throws Exception { cleanup.releaseSources(id); } });
        run(errs, "runtime", new Op() { public void run() throws Exception { cleanup.deleteRuntimeState(id); } });
        run(errs, "storage", new Op() { public void run() throws Exception { cleanup.deleteStorage(id); } });
        run(errs, "cookies", new Op() { public void run() throws Exception { cleanup.deleteCookies(id); } });
        run(errs, "cache", new Op() { public void run() throws Exception { cleanup.deleteCache(id); } });
        run(errs, "apk", new Op() { public void run() throws Exception { cleanup.deleteApk(r); } });
        sources.releaseExtension(id);
        if (errs.isEmpty()) registry.remove(id);
        else { r.enabled = false; r.state = States.Lifecycle.INSTALL_FAILED; r.failureCode = "uninstall-incomplete"; registry.put(r); }
        return errs;
    }

    private interface Op { void run() throws Exception; }
    private static void run(List<String> errs, String name, Op op) { try { op.run(); } catch (Throwable t) { errs.add(name); } }
}
