package app.mangahive.mihon.install;

import java.util.Collections;
import java.util.List;

/** What static inspection of the downloaded APK found. No extension code has run to produce this. */
public final class ApkFacts {
    public String packageName, versionName, applicationLabel, extensionLib, sha256, error;
    public long versionCode = -1, sizeBytes = -1;
    public int minSdk, targetSdk;
    public boolean hasExtensionFeature, entryClassesValid;
    public List<String> permissions = Collections.emptyList(), certSha256 = Collections.emptyList();
    public List<String> services = Collections.emptyList(), activities = Collections.emptyList(),
        receivers = Collections.emptyList(), providers = Collections.emptyList();
}
