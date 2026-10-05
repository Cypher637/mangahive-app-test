package app.mangahive.mihon.install;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.file.Files;
import java.util.*;

/** Stage 7 JDK self-test: policy, registry persistence, lifecycle, update safety, failure isolation, uninstall cleanup. */
public class InstallSelfTest {
    static int pass, fail;
    static void ok(boolean c, String m) { if (c) { pass++; System.out.println("PASS: " + m); } else { fail++; System.out.println("FAIL: " + m); } }
    static final String CERT_A = rep('a'), CERT_B = rep('b'), H1 = rep('1'), H2 = rep('2');
    static String rep(char c) { char[] x = new char[64]; Arrays.fill(x, c); return new String(x); }

    static RepoEntry entry(String ext, String pkg, long vc, String sha) {
        RepoEntry e = new RepoEntry();
        e.repositoryId = "repo.a"; e.extensionId = ext; e.packageName = pkg; e.versionName = "1." + vc; e.versionCode = vc;
        e.downloadUrl = "https://example.org/x.apk"; e.language = "en"; e.sourceIds = Arrays.asList("1234"); e.sha256 = sha; e.certSha256 = CERT_A;
        return e;
    }
    static ApkFacts facts(String pkg, long vc, String sha, String cert) {
        ApkFacts a = new ApkFacts();
        a.packageName = pkg; a.versionCode = vc; a.versionName = "1." + vc; a.sha256 = sha; a.certSha256 = Arrays.asList(cert);
        a.hasExtensionFeature = true; a.extensionLib = "1.6"; a.entryClassesValid = true; a.applicationLabel = "Fixture";
        a.permissions = Arrays.asList("android.permission.INTERNET");
        return a;
    }
    static InstallPolicy.Context ctx(States.RepoTrust t) {
        InstallPolicy.Context c = new InstallPolicy.Context();
        c.trust = t; c.supportedLibs = new HashSet<String>(Arrays.asList("1.6")); return c;
    }
    static String code(InstallPolicy.Outcome o) { return o.state + "/" + o.code; }

    // fakes ------------------------------------------------------------
    static class FakeActivator implements ExtensionManager.Activator {
        Set<String> broken = new HashSet<String>(), active = new HashSet<String>();
        public void activate(InstalledExtension c) throws Exception { if (broken.contains(c.extensionId)) throw new RuntimeException("boom"); active.add(c.extensionId); }
        public void deactivate(String id) { active.remove(id); }
    }
    static class FakeCleanup implements ExtensionManager.Cleanup {
        List<String> calls = new ArrayList<String>(); Set<String> failOn = new HashSet<String>();
        void c(String s, String id) throws Exception { calls.add(s + ":" + id); if (failOn.contains(s)) throw new RuntimeException("x"); }
        public void releaseSources(String id) throws Exception { c("sources", id); }
        public void deleteRuntimeState(String id) throws Exception { c("runtime", id); }
        public void deleteStorage(String id) throws Exception { c("storage", id); }
        public void deleteCookies(String id) throws Exception { c("cookies", id); }
        public void deleteCache(String id) throws Exception { c("cache", id); }
        public void deleteApk(InstalledExtension r) throws Exception { c("apk", r.extensionId); new File(r.apkPath).delete(); }
    }

    public static void main(String[] args) throws Exception {
        status(); lifecycle(); metadata(); policy(); ownership(); registry(); reconcile(); manager(); isolation(); tracker(); cache();
        System.out.println("\n" + pass + " passed, " + fail + " failed");
        System.exit(fail == 0 ? 0 : 1);
    }

    static void status() {
        ok(!Stage7Status.STAGE7_COMPLETE && !Stage7Status.REAL_THIRD_PARTY_APK_INSTALLED && !Stage7Status.EXTENSION_LIFECYCLE_VERIFIED && !Stage7Status.EXTENSION_APK_INSTALLATION_VERIFIED, "status: no device-level or complete claim is made");
    }

    static void lifecycle() {
        States.Lifecycle[] pipe = {States.Lifecycle.DISCOVERED, States.Lifecycle.METADATA_VALIDATED, States.Lifecycle.DOWNLOAD_PENDING, States.Lifecycle.DOWNLOADING, States.Lifecycle.DOWNLOADED, States.Lifecycle.HASH_VERIFIED, States.Lifecycle.APK_INSPECTED, States.Lifecycle.SIGNATURE_VERIFIED, States.Lifecycle.COMPATIBILITY_CHECKED, States.Lifecycle.INSTALL_PENDING, States.Lifecycle.INSTALLED, States.Lifecycle.ENABLED, States.Lifecycle.RUNNING};
        boolean fwd = true; for (int i = 0; i + 1 < pipe.length; i++) fwd &= States.Lifecycle.canTransition(pipe[i], pipe[i + 1]);
        ok(fwd, "lifecycle: every mandated pipeline step is allowed in order");
        ok(!States.Lifecycle.canTransition(States.Lifecycle.DOWNLOADED, States.Lifecycle.INSTALLED), "lifecycle: cannot skip hash/inspect/signature/compat steps");
        ok(!States.Lifecycle.canTransition(States.Lifecycle.DOWNLOADING, States.Lifecycle.RUNNING), "lifecycle: cannot jump to RUNNING");
        ok(States.Lifecycle.canTransition(States.Lifecycle.DOWNLOADING, States.Lifecycle.NETWORK_FAILED), "lifecycle: a download can fail as NETWORK_FAILED");
        ok(States.Lifecycle.canTransition(States.Lifecycle.DOWNLOADED, States.Lifecycle.HASH_MISMATCH), "lifecycle: hash failure is explicit");
        ok(!States.Lifecycle.canTransition(States.Lifecycle.BLOCKED, States.Lifecycle.DISCOVERED), "lifecycle: BLOCKED is terminal (no casual bypass)");
        ok(States.Lifecycle.canTransition(States.Lifecycle.HASH_MISMATCH, States.Lifecycle.DISCOVERED), "lifecycle: a failed verification can only restart from the top");
        ok(!States.Lifecycle.canTransition(States.Lifecycle.SIGNATURE_MISMATCH, States.Lifecycle.ENABLED), "lifecycle: signature mismatch cannot be enabled directly");
        ok(States.Lifecycle.canTransition(States.Lifecycle.ENABLED, States.Lifecycle.DISABLED) && States.Lifecycle.canTransition(States.Lifecycle.DISABLED, States.Lifecycle.ENABLED), "lifecycle: enable/disable round trip");
        ok(!States.Lifecycle.DISABLED.mayExecute() && !States.Lifecycle.LOAD_FAILED.mayExecute() && States.Lifecycle.ENABLED.mayExecute(), "lifecycle: only INSTALLED/ENABLED/RUNNING may execute extension code");
        ok(!States.Lifecycle.DISABLED.isFailure() && States.Lifecycle.MALFORMED.isFailure(), "lifecycle: DISABLED is a user state, MALFORMED is a failure");
    }

    static void metadata() {
        RepoEntry good = entry("mihon.test.ext", "eu.kanade.tachiyomi.extension.en.test", 5, H1);
        ok(MetadataValidator.validate(good).isEmpty(), "metadata: valid entry accepted");
        String[] names = {"http download url", "javascript url", "userinfo url", "path chars in source id", "bad package", "bad sha256", "bad cert", "zero versionCode", "markup in name", "newline in name",
            "oversized size", "duplicate source ids", "no sources", "bad language", "uppercase extension id", "min>max host", "bad ecosystem", "control char version"};
        List<RepoEntry> bad = new ArrayList<RepoEntry>();
        RepoEntry x;
        x = entry("mihon.t.e", "a.b.c", 1, H1); x.downloadUrl = "http://example.org/x.apk"; bad.add(x);
        x = entry("mihon.t.e", "a.b.c", 1, H1); x.downloadUrl = "javascript:alert(1)"; bad.add(x);
        x = entry("mihon.t.e", "a.b.c", 1, H1); x.downloadUrl = "https://user:pw@example.org/x.apk"; bad.add(x);
        x = entry("mihon.t.e", "a.b.c", 1, H1); x.sourceIds = Arrays.asList("1/../2"); bad.add(x);
        x = entry("mihon.t.e", "not a package", 1, H1); bad.add(x);
        x = entry("mihon.t.e", "a.b.c", 1, "zz"); bad.add(x);
        x = entry("mihon.t.e", "a.b.c", 1, H1); x.certSha256 = "short"; bad.add(x);
        x = entry("mihon.t.e", "a.b.c", 0, H1); bad.add(x);
        x = entry("mihon.t.e", "a.b.c", 1, H1); x.sourceIds = Arrays.asList("1"); x.sourceNames = Arrays.asList("<img src=x onerror=alert(1)>"); bad.add(x);
        x = entry("mihon.t.e", "a.b.c", 1, H1); x.sourceIds = Arrays.asList("1"); x.sourceNames = Arrays.asList("line1\nforged log line"); bad.add(x);
        x = entry("mihon.t.e", "a.b.c", 1, H1); x.sizeBytes = MetadataValidator.MAX_APK_BYTES + 1; bad.add(x);
        x = entry("mihon.t.e", "a.b.c", 1, H1); x.sourceIds = Arrays.asList("1", "1"); bad.add(x);
        x = entry("mihon.t.e", "a.b.c", 1, H1); x.sourceIds = new ArrayList<String>(); bad.add(x);
        x = entry("mihon.t.e", "a.b.c", 1, H1); x.language = "english!!"; bad.add(x);
        x = entry("Mihon.T.E", "a.b.c", 1, H1); bad.add(x);
        x = entry("mihon.t.e", "a.b.c", 1, H1); x.minHost = 5; x.maxHost = 2; bad.add(x);
        x = entry("mihon.t.e", "a.b.c", 1, H1); x.ecosystem = "evil"; bad.add(x);
        x = entry("mihon.t.e", "a.b.c", 1, H1); x.versionName = "1.0\u0000"; bad.add(x);
        for (int i = 0; i < bad.size(); i++) ok(!MetadataValidator.validate(bad.get(i)).isEmpty(), "metadata: rejected - " + names[i]);
        ok(!MetadataValidator.validate(null).isEmpty(), "metadata: null entry rejected");
    }

    static void policy() {
        RepoEntry e = entry("mihon.test.ext", "eu.kanade.tachiyomi.extension.en.test", 5, H1);
        ApkFacts a = facts(e.packageName, 5, H1, CERT_A);
        InstallPolicy.Outcome o = InstallPolicy.evaluate(e, a, ctx(States.RepoTrust.COMMUNITY));
        ok(o.state == States.Lifecycle.INSTALL_PENDING && o.compatibility == States.Compatibility.SUPPORTED, "policy: valid package passes the whole pipeline");
        ok(code(InstallPolicy.evaluate(e, facts("evil.pkg.name", 5, H1, CERT_A), ctx(States.RepoTrust.COMMUNITY))).equals("PACKAGE_MISMATCH/package-mismatch"), "policy: wrong package name -> PACKAGE_MISMATCH");
        ok(code(InstallPolicy.evaluate(e, facts(e.packageName, 5, H2, CERT_A), ctx(States.RepoTrust.COMMUNITY))).equals("HASH_MISMATCH/sha256-mismatch"), "policy: wrong SHA-256 -> HASH_MISMATCH");
        ok(code(InstallPolicy.evaluate(e, facts(e.packageName, 5, H1, CERT_B), ctx(States.RepoTrust.COMMUNITY))).equals("SIGNATURE_MISMATCH/cert-mismatch"), "policy: wrong certificate -> SIGNATURE_MISMATCH");
        ApkFacts unsigned = facts(e.packageName, 5, H1, CERT_A); unsigned.certSha256 = new ArrayList<String>();
        ok(code(InstallPolicy.evaluate(e, unsigned, ctx(States.RepoTrust.COMMUNITY))).equals("SIGNATURE_MISMATCH/unsigned"), "policy: unsigned APK rejected");
        ApkFacts corrupt = facts(e.packageName, 5, H1, CERT_A); corrupt.error = "unreadable-apk";
        ok(code(InstallPolicy.evaluate(e, corrupt, ctx(States.RepoTrust.COMMUNITY))).equals("MALFORMED/unreadable-apk"), "policy: malformed APK -> MALFORMED");
        ApkFacts lib = facts(e.packageName, 5, H1, CERT_A); lib.extensionLib = "9.9";
        ok(code(InstallPolicy.evaluate(e, lib, ctx(States.RepoTrust.COMMUNITY))).equals("INCOMPATIBLE/unsupported-api"), "policy: unsupported API -> INCOMPATIBLE (not a ClassLoader surprise)");
        ApkFacts noEntry = facts(e.packageName, 5, H1, CERT_A); noEntry.entryClassesValid = false;
        ok(code(InstallPolicy.evaluate(e, noEntry, ctx(States.RepoTrust.COMMUNITY))).equals("INCOMPATIBLE/bad-entry-point"), "policy: missing/invalid entry point -> INCOMPATIBLE");
        ApkFacts notExt = facts(e.packageName, 5, H1, CERT_A); notExt.hasExtensionFeature = false;
        ok(code(InstallPolicy.evaluate(e, notExt, ctx(States.RepoTrust.COMMUNITY))).equals("INCOMPATIBLE/not-an-extension"), "policy: not an extension -> INCOMPATIBLE");
        ApkFacts vmis = facts(e.packageName, 6, H1, CERT_A);
        ok(code(InstallPolicy.evaluate(e, vmis, ctx(States.RepoTrust.COMMUNITY))).equals("MALFORMED/version-mismatch"), "policy: APK versionCode must equal metadata");
        InstallPolicy.Context web = ctx(States.RepoTrust.OFFICIAL); web.androidHost = false;
        ok(code(InstallPolicy.evaluate(e, a, web)).equals("INCOMPATIBLE/android-only"), "policy: web/PWA host never installs APKs");
        ok(code(InstallPolicy.evaluate(e, a, ctx(States.RepoTrust.BLOCKED))).equals("BLOCKED/blocked"), "policy: BLOCKED repository refused");
        ok(code(InstallPolicy.evaluate(e, a, ctx(States.RepoTrust.UNTRUSTED))).equals("UNTRUSTED/untrusted-repository"), "policy: UNTRUSTED repository refused");
        RepoEntry noCert = entry("mihon.test.ext", e.packageName, 5, H1); noCert.certSha256 = null;
        ok(code(InstallPolicy.evaluate(noCert, a, ctx(States.RepoTrust.OFFICIAL))).equals("UNTRUSTED/official-needs-known-signer"), "policy: OFFICIAL requires a known signer");
        ok(InstallPolicy.evaluate(noCert, a, ctx(States.RepoTrust.COMMUNITY)).state == States.Lifecycle.INSTALL_PENDING, "policy: community is explicit TOFU, not treated as official");
        InstallPolicy.Context pin = ctx(States.RepoTrust.COMMUNITY); pin.pinnedCert = CERT_B;
        ok(code(InstallPolicy.evaluate(noCert, a, pin)).equals("SIGNATURE_MISMATCH/pin-mismatch"), "policy: a previously pinned community signer is enforced");
        RepoEntry mh = entry("mangahive.thing", e.packageName, 5, H1);
        ok(code(InstallPolicy.evaluate(mh, a, ctx(States.RepoTrust.COMMUNITY))).equals("BLOCKED/reserved-namespace"), "policy: community cannot claim the mangahive.* namespace");
        ApkFacts crit = facts(e.packageName, 5, H1, CERT_A); crit.permissions = Arrays.asList("android.permission.INTERNET", "android.permission.READ_SMS");
        ok(code(InstallPolicy.evaluate(e, crit, ctx(States.RepoTrust.OFFICIAL))).equals("BLOCKED/dangerous-permission"), "policy: READ_SMS is blocked even for OFFICIAL");
        ApkFacts hi = facts(e.packageName, 5, H1, CERT_A); hi.permissions = Arrays.asList("android.permission.ACCESS_FINE_LOCATION");
        ok(code(InstallPolicy.evaluate(e, hi, ctx(States.RepoTrust.COMMUNITY))).equals("UNTRUSTED/needs-acknowledgement"), "policy: high-risk permission needs explicit acknowledgement");
        InstallPolicy.Context ack = ctx(States.RepoTrust.COMMUNITY); ack.ackHighRiskPermissions = true;
        ok(InstallPolicy.evaluate(e, hi, ack).state == States.Lifecycle.INSTALL_PENDING, "policy: acknowledged high-risk permission proceeds");
        ok(Policies.hostGrants(Arrays.asList("android.permission.READ_SMS", "android.permission.CAMERA")).equals(Policies.hostGrants(new ArrayList<String>())), "policy: declared permissions never change what the host grants");
        ok(!Policies.hostGrants(null).contains(Policies.HostPermission.COOKIES), "policy: extensions are not granted raw cookie access");
        ok(Policies.classify("com.vendor.CUSTOM") == Policies.Risk.HIGH, "policy: unknown custom permission is not assumed benign");
        RepoEntry obs = entry("mihon.test.ext", e.packageName, 5, H1); obs.obsolete = true;
        ok(code(InstallPolicy.evaluate(obs, a, ctx(States.RepoTrust.COMMUNITY))).equals("OBSOLETE/obsolete"), "policy: obsolete entry -> OBSOLETE");
        RepoEntry hostv = entry("mihon.test.ext", e.packageName, 5, H1); hostv.minHost = 3;
        ok(code(InstallPolicy.evaluate(hostv, a, ctx(States.RepoTrust.COMMUNITY))).equals("INCOMPATIBLE/host-version"), "policy: host version range enforced");
        InstalledExtension inst = new InstalledExtension();
        inst.extensionId = e.extensionId; inst.packageName = e.packageName; inst.versionCode = 120; inst.certSha256 = Arrays.asList(CERT_A); inst.sha256 = H1;
        RepoEntry down = entry("mihon.test.ext", e.packageName, 119, H2); ApkFacts downF = facts(e.packageName, 119, H2, CERT_A);
        InstallPolicy.Context up = ctx(States.RepoTrust.COMMUNITY); up.installed = inst;
        ok(code(InstallPolicy.evaluate(down, downF, up)).equals("OBSOLETE/downgrade-blocked"), "update: v120 -> v119 downgrade blocked");
        up.debugRecovery = true;
        ok(InstallPolicy.evaluate(down, downF, up).state == States.Lifecycle.INSTALL_PENDING, "update: downgrade only with explicit debug recovery");
        up.debugRecovery = false;
        RepoEntry v121 = entry("mihon.test.ext", e.packageName, 121, H2); v121.certSha256 = CERT_B;
        ok(code(InstallPolicy.evaluate(v121, facts(e.packageName, 121, H2, CERT_B), up)).equals("SIGNATURE_MISMATCH/signer-changed"), "update: signer change -> SIGNATURE_MISMATCH by default");
        up.signerMigrationAllowed = true;
        ok(InstallPolicy.evaluate(v121, facts(e.packageName, 121, H2, CERT_B), up).state == States.Lifecycle.INSTALL_PENDING, "update: signer migration only with an explicit policy flag");
        up.signerMigrationAllowed = false;
        RepoEntry v121ok = entry("mihon.test.ext", e.packageName, 121, H2);
        ok(InstallPolicy.evaluate(v121ok, facts(e.packageName, 121, H2, CERT_A), up).state == States.Lifecycle.INSTALL_PENDING, "update: same package + same cert + higher versionCode + valid hash passes");
        RepoEntry same = entry("mihon.test.ext", e.packageName, 120, H2);
        ok(code(InstallPolicy.evaluate(same, facts(e.packageName, 120, H2, CERT_A), up)).equals("BLOCKED/same-version-different-content"), "update: same versionCode with different bytes is blocked");
        RepoEntry sameOk = entry("mihon.test.ext", e.packageName, 120, H1);
        ok(code(InstallPolicy.evaluate(sameOk, facts(e.packageName, 120, H1, CERT_A), up)).equals("INSTALLED/up-to-date"), "update: identical package reports up-to-date");
    }

    static void ownership() {
        InstalledExtension i = new InstalledExtension();
        i.repositoryId = "repo.a"; i.extensionId = "mihon.x.y"; i.packageName = "p.q.r"; i.certSha256 = Arrays.asList(CERT_A);
        RepoEntry in = entry("mihon.x.y", "p.q.r", 2, H1); in.repositoryId = "repo.b";
        List<InstalledExtension> l = Arrays.asList(i);
        ok(Ownership.resolve(new ArrayList<InstalledExtension>(), in, Arrays.asList(CERT_A), States.RepoTrust.COMMUNITY) == States.Ownership.PRIMARY, "ownership: first claimant is PRIMARY");
        ok(Ownership.resolve(l, in, Arrays.asList(CERT_A), States.RepoTrust.COMMUNITY) == States.Ownership.ALTERNATE_REPOSITORY, "ownership: same package+signer in another repo is ALTERNATE_REPOSITORY");
        ok(Ownership.resolve(l, in, Arrays.asList(CERT_B), States.RepoTrust.COMMUNITY) == States.Ownership.CONFLICT, "ownership: same id, different signer in another repo is CONFLICT");
        in.packageName = "other.pkg.name";
        ok(Ownership.resolve(l, in, Arrays.asList(CERT_A), States.RepoTrust.COMMUNITY) == States.Ownership.CONFLICT, "ownership: same id, different package in another repo is CONFLICT");
        ok(Ownership.resolve(l, in, Arrays.asList(CERT_A), States.RepoTrust.BLOCKED) == States.Ownership.BLOCKED, "ownership: blocked repo is BLOCKED");
        RepoEntry same = entry("mihon.x.y", "other.pkg.name", 2, H1); same.repositoryId = "repo.a";
        ok(Ownership.resolve(l, same, Arrays.asList(CERT_A), States.RepoTrust.COMMUNITY) == States.Ownership.CONFLICT, "ownership: same repo swapping the package under an id is CONFLICT");
        InstallPolicy.Context c = ctx(States.RepoTrust.COMMUNITY); c.ownership = States.Ownership.CONFLICT;
        RepoEntry e = entry("mihon.test.ext", "eu.kanade.tachiyomi.extension.en.test", 5, H1);
        ok(code(InstallPolicy.evaluate(e, facts(e.packageName, 5, H1, CERT_A), c)).equals("BLOCKED/identity-conflict"), "ownership: conflicting identity cannot be installed unknowingly");
        Ownership.SourceTable t = new Ownership.SourceTable();
        t.claim("canon:one", "ext.a"); t.claim("canon:one", "ext.b"); t.claim(Ownership.SourceTable.key("ext.a", "1"), "ext.a"); t.claim(Ownership.SourceTable.key("ext.b", "1"), "ext.b");
        Ownership.SourceTable.Usable all = new Ownership.SourceTable.Usable() { public boolean test(String x) { return true; } };
        ok(!Ownership.SourceTable.key("ext.a", "1").equals(Ownership.SourceTable.key("ext.b", "1")), "ownership: extension A/source 1 differs from extension B/source 1");
        ok("ext.a".equals(t.owner("canon:one", all)), "ownership: first usable claimant owns the canonical source");
        t.releaseExtension("ext.a");
        ok("ext.b".equals(t.owner("canon:one", all)), "ownership: removing the owner restores the next valid owner");
        ok(t.sourcesOf("ext.a").isEmpty() && t.owner(Ownership.SourceTable.key("ext.a", "1"), all) == null, "ownership: removed extension leaves no stale source adapters");
        Ownership.SourceTable.Usable noB = new Ownership.SourceTable.Usable() { public boolean test(String x) { return !x.equals("ext.b"); } };
        ok(t.owner("canon:one", noB) == null, "ownership: a disabled claimant is not an owner");
    }

    static File tmp() throws Exception { return Files.createTempDirectory("mh7").toFile(); }
    static InstalledExtension row(String id, long vc) {
        InstalledExtension r = new InstalledExtension();
        r.repositoryId = "repo.a"; r.extensionId = id; r.packageName = "a.b." + id.replace('.', '_'); r.displayName = "N\tame=\u00e9"; r.versionName = "1." + vc; r.versionCode = vc; r.sha256 = H1;
        r.certSha256 = Arrays.asList(CERT_A); r.sourceIds = Arrays.asList("1", "2"); r.enabled = true; r.state = States.Lifecycle.ENABLED; r.installedAt = 10; r.updatedAt = 20; r.apkPath = "/nonexistent/" + id + ".apk";
        return r;
    }

    static void registry() throws Exception {
        File d = tmp();
        ExtensionRegistry r1 = new ExtensionRegistry(d);
        r1.put(row("mihon.a", 5)); r1.put(row("mihon.b", 7));
        InstalledExtension x = r1.get("mihon.b"); x.enabled = false; x.state = States.Lifecycle.DISABLED; x.prevVersionCode = 6; r1.put(x);
        ExtensionRegistry r2 = new ExtensionRegistry(d);
        InstalledExtension a = r2.get("mihon.a"), b = r2.get("mihon.b");
        ok(r2.all().size() == 2 && a != null && b != null, "persistence: both extensions survive a restart");
        ok(a.versionCode == 5 && a.enabled && a.state == States.Lifecycle.ENABLED && a.certSha256.equals(Arrays.asList(CERT_A)) && a.sourceIds.equals(Arrays.asList("1", "2")) && a.sha256.equals(H1), "persistence: version, enabled, certificate, hash and source ownership survive");
        ok(!b.enabled && b.state == States.Lifecycle.DISABLED && b.prevVersionCode == 6, "persistence: disabled state and rollback info survive");
        ok(("N\tame=\u00e9").equals(a.displayName), "persistence: awkward characters round-trip safely");
        FileOutputStream o = new FileOutputStream(new File(d, "extensions.reg")); o.write("garbage".getBytes("UTF-8")); o.close();
        ExtensionRegistry r3 = new ExtensionRegistry(d);
        ok(r3.all().size() >= 1 && r3.get("mihon.a") != null, "persistence: corrupt registry falls back to the backup instead of losing everything");
        File d2 = tmp(); ExtensionRegistry q = new ExtensionRegistry(d2); q.put(row("mihon.a", 1)); q.put(row("mihon.b", 2));
        byte[] bytes = Files.readAllBytes(new File(d2, "extensions.reg").toPath());
        FileOutputStream tr = new FileOutputStream(new File(d2, "extensions.reg")); tr.write(bytes, 0, bytes.length / 2); tr.close();
        ok(new ExtensionRegistry(d2).get("mihon.a") != null, "persistence: a truncated write (power loss) is detected and the backup is used");
        File d4 = tmp(); ExtensionRegistry tq = new ExtensionRegistry(d4); tq.put(row("mihon.a", 1)); tq.put(row("mihon.b", 2));
        File main4 = new File(d4, "extensions.reg");
        String txt = new String(Files.readAllBytes(main4.toPath()), "UTF-8");
        Files.write(main4.toPath(), txt.replace("vn=1.2", "vn=9.9").getBytes("UTF-8"));   // content altered, checksum trailer kept
        ExtensionRegistry tampered = new ExtensionRegistry(d4);
        ok(tampered.get("mihon.b") == null || !"9.9".equals(tampered.get("mihon.b").versionName), "persistence: a registry whose content no longer matches its checksum is not trusted");
        ok(new ExtensionRegistry(tmp()).all().isEmpty(), "persistence: empty store starts empty, no crash");
        File d3 = tmp(); ExtensionRegistry rm = new ExtensionRegistry(d3); rm.put(row("mihon.a", 1)); rm.remove("mihon.a");
        ok(new ExtensionRegistry(d3).get("mihon.a") == null, "persistence: removal persists");
    }

    static void reconcile() throws Exception {
        File d = tmp(), apks = new File(d, "apks"); apks.mkdirs();
        ExtensionRegistry reg = new ExtensionRegistry(new File(d, "reg"));
        File f1 = new File(apks, "good.apk"), f2 = new File(apks, "swapped.apk"), orphan = new File(apks, "orphan.apk");
        Files.write(f1.toPath(), new byte[]{1}); Files.write(f2.toPath(), new byte[]{2}); Files.write(orphan.toPath(), new byte[]{3});
        InstalledExtension good = row("mihon.good", 5); good.apkPath = f1.getPath();
        InstalledExtension gone = row("mihon.gone", 5); gone.apkPath = new File(apks, "gone.apk").getPath();
        InstalledExtension swapped = row("mihon.swapped", 5); swapped.apkPath = f2.getPath();
        reg.put(good); reg.put(gone); reg.put(swapped);
        Reconciler.ApkProbe probe = new Reconciler.ApkProbe() { public ApkFacts probe(File f) {
            if (f.getName().equals("good.apk")) return facts(row("mihon.good", 5).packageName, 5, H1, CERT_A);
            return facts(row("mihon.swapped", 5).packageName, 5, H1, CERT_B); } };
        Reconciler.Report rep = Reconciler.reconcile(reg, apks, probe, 99);
        ok(rep.missing.equals(Arrays.asList("mihon.gone")) && reg.get("mihon.gone").state == States.Lifecycle.MISSING && !reg.get("mihon.gone").enabled, "recovery: registry row whose APK vanished -> MISSING, no crash");
        ok(reg.get("mihon.swapped").state == States.Lifecycle.SIGNATURE_MISMATCH && !reg.get("mihon.swapped").enabled, "recovery: APK re-signed behind our back -> SIGNATURE_MISMATCH and disabled");
        ok(rep.healthy.equals(Arrays.asList("mihon.good")) && reg.get("mihon.good").enabled, "recovery: a matching APK stays healthy");
        ok(rep.orphans.equals(Arrays.asList("orphan.apk")), "recovery: an APK with no registry row is reported ORPHANED, not trusted");
    }

    static class Env {
        File dir, apks; ExtensionRegistry reg; FakeActivator act = new FakeActivator(); FakeCleanup cl = new FakeCleanup(); Ownership.SourceTable src = new Ownership.SourceTable();
        long clock = 1000; FailureTracker ft; ExtensionManager m;
        Env() throws Exception { dir = tmp(); apks = new File(dir, "apks"); apks.mkdirs(); reg = new ExtensionRegistry(new File(dir, "reg")); ft = new FailureTracker(new FailureTracker.Clock() { public long now() { return clock; } }, 1000, 60000, 3); m = new ExtensionManager(reg, act, cl, src, ft); }
        File apk(String n) throws Exception { File f = new File(apks, n); Files.write(f.toPath(), new byte[]{9}); return f; }
        InstallPolicy.Outcome install(String ext, String pkg, long vc, String sha, String cert) throws Exception {
            RepoEntry e = entry(ext, pkg, vc, sha); e.certSha256 = cert;
            InstallPolicy.Context c = ctx(States.RepoTrust.COMMUNITY); c.installed = reg.get(ext);
            return m.apply(e, facts(pkg, vc, sha, cert), c, apk(ext + "-" + vc + ".apk").getPath(), clock);
        }
    }

    static void manager() throws Exception {
        Env v = new Env();
        InstallPolicy.Outcome o = v.install("mihon.life", "p.life.one", 1, H1, CERT_A);
        ok(o.state == States.Lifecycle.ENABLED && v.act.active.contains("mihon.life") && v.reg.get("mihon.life") != null, "lifecycle: install -> ENABLED, activated, registered");
        ok(v.src.sourcesOf("mihon.life").size() == 1, "lifecycle: sources claimed on install");
        ExtensionRegistry reopened = new ExtensionRegistry(new File(v.dir, "reg"));
        ok(reopened.get("mihon.life").enabled && reopened.get("mihon.life").versionCode == 1, "lifecycle: restart keeps the installed, enabled extension");
        ok(v.m.disable("mihon.life") == States.Lifecycle.DISABLED && !v.act.active.contains("mihon.life") && !v.m.mayLoad("mihon.life"), "lifecycle: disable stops execution and blocks loading");
        ok(v.cl.calls.isEmpty(), "lifecycle: disable deletes nothing (library/history/downloads/metadata preserved)");
        ok(v.m.enable("mihon.life", v.clock) == States.Lifecycle.ENABLED && v.m.mayLoad("mihon.life") && v.act.active.contains("mihon.life"), "lifecycle: re-enable restores it without reinstalling");
        o = v.install("mihon.life", "p.life.one", 2, H2, CERT_A);
        InstalledExtension cur = v.reg.get("mihon.life");
        ok(o.state == States.Lifecycle.ENABLED && cur.versionCode == 2 && cur.prevVersionCode == 1 && H1.equals(cur.prevSha256) && cur.prevCertSha256.equals(Arrays.asList(CERT_A)), "update: v1 -> v2 applied; rollback info stored");
        ok(new ExtensionRegistry(new File(v.dir, "reg")).get("mihon.life").versionCode == 2, "update: restart keeps v2");
        o = v.install("mihon.life", "p.life.one", 1, H1, CERT_A);
        ok(code(o).equals("OBSOLETE/downgrade-blocked") && v.reg.get("mihon.life").versionCode == 2, "update: v2 -> v1 downgrade blocked, v2 kept");
        o = v.install("mihon.life", "p.life.one", 3, rep('3'), CERT_B);
        ok(code(o).equals("SIGNATURE_MISMATCH/signer-changed") && v.reg.get("mihon.life").versionCode == 2 && v.reg.get("mihon.life").certSha256.equals(Arrays.asList(CERT_A)), "update: v3 signed by certificate B refused, installed identity unchanged");
        v.act.broken.add("mihon.life");
        o = v.install("mihon.life", "p.life.one", 4, rep('4'), CERT_A);
        InstalledExtension kept = v.reg.get("mihon.life");
        ok(o.state == States.Lifecycle.LOAD_FAILED && kept.versionCode == 2 && kept.state == States.Lifecycle.ENABLED && "update-activation-failed".equals(kept.failureCode), "update: failed activation -> LOAD_FAILED outcome, working v2 retained");
        v.act.broken.clear();
        List<String> errs = v.m.uninstall("mihon.life");
        ok(errs.isEmpty() && v.reg.get("mihon.life") == null && v.src.sourcesOf("mihon.life").isEmpty(), "uninstall: row and source registrations removed");
        ok(v.cl.calls.containsAll(Arrays.asList("sources:mihon.life", "runtime:mihon.life", "storage:mihon.life", "cookies:mihon.life", "cache:mihon.life", "apk:mihon.life")) && v.cl.calls.size() == 6, "uninstall: removes APK, runtime state, storage, cookies, cache, sources - exactly those");
        ok(new ExtensionRegistry(new File(v.dir, "reg")).get("mihon.life") == null, "uninstall: removal survives restart");
        o = v.install("mihon.life", "p.life.one", 1, H1, CERT_A);
        ok(o.state == States.Lifecycle.ENABLED && v.reg.get("mihon.life") != null, "lifecycle: reinstall after uninstall works");
        v.cl.failOn.add("cookies");
        errs = v.m.uninstall("mihon.life");
        ok(errs.equals(Arrays.asList("cookies")) && v.reg.get("mihon.life").state == States.Lifecycle.INSTALL_FAILED && !v.reg.get("mihon.life").enabled, "uninstall: a failed cleanup step is reported and the row stays for retry");
        v.cl.failOn.clear();
        ok(v.m.uninstall("mihon.life").isEmpty() && v.reg.get("mihon.life") == null, "uninstall: retry completes");
        InstalledExtension bad = row("mihon.bad", 1); bad.state = States.Lifecycle.SIGNATURE_MISMATCH; bad.enabled = false; v.reg.put(bad);
        ok(v.m.enable("mihon.bad", v.clock) == States.Lifecycle.SIGNATURE_MISMATCH && !v.act.active.contains("mihon.bad"), "enable: SIGNATURE_MISMATCH cannot be enabled, extension code is never loaded");
        Env w = new Env();
        RepoEntry e = entry("mihon.evil2", "p.evil.two", 1, H1);
        InstallPolicy.Outcome r = w.m.apply(e, facts("someone.else.pkg", 1, H1, CERT_A), ctx(States.RepoTrust.COMMUNITY), w.apk("x.apk").getPath(), 5);
        ok(r.state == States.Lifecycle.PACKAGE_MISMATCH && w.reg.get("mihon.evil2") == null && !w.act.active.contains("mihon.evil2"), "install: rejected package is never activated or registered");
    }

    static void isolation() throws Exception {
        Env v = new Env();
        v.install("mihon.aaa", "p.a.one", 1, H1, CERT_A);
        v.act.broken.add("mihon.bbb");
        InstallPolicy.Outcome ob = v.install("mihon.bbb", "p.b.one", 1, H2, CERT_A);
        v.install("mihon.ccc", "p.c.one", 1, rep('c'), CERT_A);
        ok(ob.state == States.Lifecycle.LOAD_FAILED && v.reg.get("mihon.bbb") == null, "isolation: broken extension B fails as LOAD_FAILED and is not registered");
        ok(v.m.mayLoad("mihon.aaa") && v.m.mayLoad("mihon.ccc") && v.act.active.contains("mihon.aaa") && v.act.active.contains("mihon.ccc"), "isolation: A and C keep working; the manager survives");
        v.act.broken.add("mihon.aaa");
        ok(v.m.disable("mihon.aaa") == States.Lifecycle.DISABLED && v.m.enable("mihon.aaa", v.clock) == States.Lifecycle.LOAD_FAILED, "isolation: enable failure of A -> LOAD_FAILED only for A");
        ok(v.m.mayLoad("mihon.ccc") && v.reg.get("mihon.ccc").state == States.Lifecycle.ENABLED, "isolation: C unaffected by A's failure");
        ok(!v.m.mayLoad("mihon.aaa"), "isolation: a LOAD_FAILED extension is not loaded");
    }

    static void tracker() {
        final long[] now = {0};
        FailureTracker t = new FailureTracker(new FailureTracker.Clock() { public long now() { return now[0]; } }, 1000, 8000, 3);
        ok(t.mayAttempt("x"), "backoff: no failures -> may attempt");
        t.record("x", "RUNTIME_FAILED");
        ok(!t.mayAttempt("x"), "backoff: immediately after a failure the extension is on cooldown");
        now[0] = 1001; ok(t.mayAttempt("x"), "backoff: after the cooldown it may be retried");
        t.record("x", "RUNTIME_FAILED"); now[0] += 1500; ok(!t.mayAttempt("x"), "backoff: second failure doubles the cooldown");
        now[0] += 5000; t.record("x", "RUNTIME_FAILED");
        ok(t.quarantined("x") && !t.mayAttempt("x"), "backoff: repeated failures quarantine the extension (no endless restarts)");
        now[0] += 10000000; ok(!t.mayAttempt("x"), "backoff: quarantine does not expire on its own");
        t.release("x"); ok(t.mayAttempt("x") && t.get("x") == null, "backoff: explicit user re-enable forgives");
        t.record("y", "A"); t.success("y"); ok(t.mayAttempt("y"), "backoff: success clears failures");
    }

    static void cache() throws Exception {
        File d = tmp();
        File keep = new File(d, "installed.apk"); Files.write(keep.toPath(), new byte[1000]);
        File part = new File(d, "dl-1.apk.part"); Files.write(part.toPath(), new byte[500]);
        File c1 = new File(d, "icon1.png"), c2 = new File(d, "icon2.png"); Files.write(c1.toPath(), new byte[400]); Files.write(c2.toPath(), new byte[400]);
        c1.setLastModified(1000); c2.setLastModified(2000);
        Set<String> prot = new HashSet<String>(Arrays.asList(keep.getCanonicalPath()));
        BoundedCache.enforce(d, 1500, prot);
        ok(keep.exists(), "cache: an installed APK is never evicted as cache");
        ok(!part.exists(), "cache: abandoned partial download removed");
        ok(!c1.exists() && c2.exists(), "cache: oldest cache entry evicted first until under budget");
    }
}
