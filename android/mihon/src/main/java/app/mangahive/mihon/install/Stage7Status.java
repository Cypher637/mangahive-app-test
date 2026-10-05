package app.mangahive.mihon.install;

/**
 * Honest Stage 7 flags. "JVM" means: exercised by android/mihon-install/run-install-harness.sh with fakes for Android-only parts
 * (PackageManager inspection, ClassLoader activation, real downloads). NOTHING here is device-verified or third-party-APK-verified.
 * The spec's device-level flags stay false until a real APK is installed and executed on Android.
 */
public final class Stage7Status {
    private Stage7Status() {}
    // verified on the JVM in this repo
    public static final boolean INSTALL_POLICY_JVM_VERIFIED = true;
    public static final boolean REGISTRY_PERSISTENCE_JVM_VERIFIED = true;
    public static final boolean LIFECYCLE_STATE_MACHINE_JVM_VERIFIED = true;
    public static final boolean UPDATE_ROLLBACK_POLICY_JVM_VERIFIED = true;
    public static final boolean UNINSTALL_CLEANUP_JVM_VERIFIED = true;   // against a fake Cleanup; Android-owned storage wiring remains separately unverified
    // NOT verified: need Android / a real third-party APK
    public static final boolean EXTENSION_APK_INSTALLATION_VERIFIED = false;
    public static final boolean EXTENSION_HASH_VERIFICATION_VERIFIED = false;      // hash-while-streaming exists in ApkDownloader but has no Stage 7 end-to-end proof
    public static final boolean EXTENSION_SIGNATURE_VERIFICATION_VERIFIED = false; // decision logic is JVM-tested; real certificate extraction is not
    public static final boolean EXTENSION_PERSISTENCE_VERIFIED = false;            // JVM file-registry only; not the :mihon process/reboot path
    public static final boolean EXTENSION_UPDATE_VERIFIED = false;
    public static final boolean EXTENSION_UNINSTALL_CLEANUP_VERIFIED = false;
    public static final boolean EXTENSION_LIFECYCLE_VERIFIED = false;
    public static final boolean REAL_THIRD_PARTY_APK_INSTALLED = false;
    public static final boolean STAGE7_COMPLETE = false;
}
