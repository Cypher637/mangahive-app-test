package app.mangahive.mihon.install;

import java.util.Collections;
import java.util.List;

/** One extension entry from a repository index. UNTRUSTED INPUT until [MetadataValidator] accepts it. */
public final class RepoEntry {
    public String ecosystem = "mihon", repositoryId, extensionId, packageName, versionName, downloadUrl, iconUrl, language;
    public long versionCode = -1;
    public List<String> sourceIds = Collections.emptyList(), sourceNames = Collections.emptyList(), sourceUrls = Collections.emptyList();
    public String sha256, certSha256;     // optional, lowercase hex when present
    public Long sizeBytes;                // optional
    public Integer minHost, maxHost;      // optional host runtime versions
    public boolean obsolete;
}
