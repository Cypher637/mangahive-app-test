package app.mangahive.mihon.install;

import java.net.URI;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

/** Repository metadata is untrusted. Syntactic validation only; destination safety is DestinationPolicy at download time. */
public final class MetadataValidator {
    public static final long MAX_APK_BYTES = 80L * 1024 * 1024;
    private static final Pattern PKG = Pattern.compile("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+");
    private static final Pattern EXT_ID = Pattern.compile("[a-z][a-z0-9._-]{0,95}");
    private static final Pattern SRC_ID = Pattern.compile("[A-Za-z0-9._:-]{1,64}");
    private static final Pattern HEX64 = Pattern.compile("[0-9a-f]{64}");
    private static final Pattern LANG = Pattern.compile("[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*|all|multi");
    private MetadataValidator() {}

    public static List<String> validate(RepoEntry e) {
        List<String> err = new ArrayList<String>();
        if (e == null) { err.add("entry is null"); return err; }
        if (!"mihon".equals(e.ecosystem)) err.add("unsupported ecosystem");
        if (e.repositoryId == null || e.repositoryId.isEmpty() || e.repositoryId.length() > 96 || bad(e.repositoryId)) err.add("bad repositoryId");
        if (e.extensionId == null || !EXT_ID.matcher(e.extensionId).matches() || e.extensionId.indexOf('.') < 0) err.add("bad extensionId");
        if (e.packageName == null || !PKG.matcher(e.packageName).matches() || e.packageName.length() > 200) err.add("bad packageName");
        if (e.versionName == null || e.versionName.isEmpty() || e.versionName.length() > 64 || bad(e.versionName)) err.add("bad versionName");
        if (e.versionCode <= 0) err.add("bad versionCode");
        if (!httpsUrl(e.downloadUrl)) err.add("downloadUrl must be https");
        if (e.iconUrl != null && !httpsUrl(e.iconUrl)) err.add("iconUrl must be https");
        if (e.language == null || !LANG.matcher(e.language).matches()) err.add("bad language");
        if (e.sourceIds == null || e.sourceIds.isEmpty() || e.sourceIds.size() > 64) err.add("bad sourceIds");
        else {
            Set<String> seen = new HashSet<String>();
            for (String s : e.sourceIds) {
                if (s == null || !SRC_ID.matcher(s).matches()) { err.add("bad source id"); break; }
                if (!seen.add(s)) { err.add("duplicate source id"); break; }
            }
            if (e.sourceNames != null && !e.sourceNames.isEmpty() && e.sourceNames.size() != e.sourceIds.size()) err.add("sourceNames/sourceIds length differ");
        }
        if (e.sourceNames != null) for (String n : e.sourceNames) if (n == null || n.length() > 128 || bad(n)) { err.add("bad source name"); break; }
        if (e.sourceUrls != null) for (String u : e.sourceUrls) if (u != null && !httpsUrl(u)) { err.add("bad source url"); break; }
        if (e.sha256 != null && !HEX64.matcher(e.sha256).matches()) err.add("sha256 must be 64 lowercase hex");
        if (e.certSha256 != null && !HEX64.matcher(e.certSha256).matches()) err.add("certSha256 must be 64 lowercase hex");
        if (e.sizeBytes != null && (e.sizeBytes <= 0 || e.sizeBytes > MAX_APK_BYTES)) err.add("size out of range");
        if (e.minHost != null && e.minHost < 0) err.add("bad minHost");
        if (e.maxHost != null && (e.maxHost < 0 || (e.minHost != null && e.maxHost < e.minHost))) err.add("bad maxHost");
        return err;
    }

    /** Control characters / markup-significant chars are rejected so metadata cannot smuggle markup or log lines. */
    private static boolean bad(String s) {
        for (int i = 0; i < s.length(); i++) { char c = s.charAt(i); if (c < 0x20 || c == 0x7f || c == '<' || c == '>') return true; }
        return false;
    }

    static boolean httpsUrl(String u) {
        if (u == null || u.length() > 2048 || bad(u)) return false;
        try {
            URI uri = new URI(u);
            return "https".equals(uri.getScheme()) && uri.getHost() != null && uri.getUserInfo() == null && !uri.getHost().isEmpty();
        } catch (Exception ex) { return false; }
    }
}
