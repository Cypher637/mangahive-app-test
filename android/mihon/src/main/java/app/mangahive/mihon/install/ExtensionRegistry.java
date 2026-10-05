package app.mangahive.mihon.install;

import java.io.*;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.Charset;
import java.security.MessageDigest;
import java.util.*;

/**
 * Persistent registry. Survives process kill: writes go to a temp file, are fsync'd, the previous good copy is kept as .bak,
 * then the temp file is renamed into place. A trailing checksum detects truncation; load falls back main -> .bak -> .tmp.
 * Corrupt individual rows are skipped, never fatal.
 */
public final class ExtensionRegistry {
    private static final Charset UTF8 = Charset.forName("UTF-8");
    private static final String HEADER = "MH-EXT-REGISTRY 1";
    private final File main, bak, tmp;
    private final Map<String, InstalledExtension> rows = new LinkedHashMap<String, InstalledExtension>();

    public ExtensionRegistry(File dir) {
        dir.mkdirs();
        main = new File(dir, "extensions.reg"); bak = new File(dir, "extensions.reg.bak"); tmp = new File(dir, "extensions.reg.tmp");
        load();
    }

    public synchronized List<InstalledExtension> all() { List<InstalledExtension> o = new ArrayList<InstalledExtension>(); for (InstalledExtension r : rows.values()) o.add(r.copy()); return o; }
    public synchronized InstalledExtension get(String extensionId) { InstalledExtension r = rows.get(extensionId); return r == null ? null : r.copy(); }
    public synchronized void put(InstalledExtension r) throws IOException { Map<String, InstalledExtension> old = new LinkedHashMap<String, InstalledExtension>(rows); rows.put(r.extensionId, r.copy()); try { persist(); } catch (IOException e) { rows.clear(); rows.putAll(old); throw e; } }
    public synchronized void remove(String extensionId) throws IOException { Map<String, InstalledExtension> old = new LinkedHashMap<String, InstalledExtension>(rows); rows.remove(extensionId); try { persist(); } catch (IOException e) { rows.clear(); rows.putAll(old); throw e; } }

    private void persist() throws IOException {
        StringBuilder sb = new StringBuilder(HEADER).append('\n');
        for (InstalledExtension r : rows.values()) sb.append(encode(r)).append('\n');
        String body = sb.toString();
        String full = body + "#sha256=" + sha(body) + "\n";
        FileOutputStream out = new FileOutputStream(tmp);
        try { out.write(full.getBytes(UTF8)); out.flush(); out.getFD().sync(); } finally { out.close(); }
        if (main.exists()) { if (bak.exists()) bak.delete(); if (!main.renameTo(bak)) throw new IOException("cannot rotate registry"); }
        if (!tmp.renameTo(main)) throw new IOException("cannot publish registry");
    }

    private void load() {
        for (File f : new File[]{main, bak, tmp}) {
            Map<String, InstalledExtension> got = tryRead(f);
            if (got != null) { rows.putAll(got); return; }
        }
    }

    private Map<String, InstalledExtension> tryRead(File f) {
        if (!f.isFile()) return null;
        try {
            String all = new String(readAll(f), UTF8);
            int i = all.lastIndexOf("#sha256=");
            if (i < 0) return null;
            String body = all.substring(0, i);
            if (!all.substring(i + 8).trim().equals(sha(body))) return null;
            String[] lines = body.split("\n");
            if (lines.length == 0 || !lines[0].equals(HEADER)) return null;
            Map<String, InstalledExtension> m = new LinkedHashMap<String, InstalledExtension>();
            for (int k = 1; k < lines.length; k++) {
                try { InstalledExtension r = decode(lines[k]); if (r != null) m.put(r.extensionId, r); } catch (RuntimeException skip) { /* corrupt row */ }
            }
            return m;
        } catch (Exception e) { return null; }
    }

    private static byte[] readAll(File f) throws IOException {
        ByteArrayOutputStream bo = new ByteArrayOutputStream(); InputStream in = new FileInputStream(f);
        try { byte[] b = new byte[8192]; int n; while ((n = in.read(b)) > 0) bo.write(b, 0, n); } finally { in.close(); }
        return bo.toByteArray();
    }
    private static String sha(String s) { try { byte[] d = MessageDigest.getInstance("SHA-256").digest(s.getBytes(UTF8)); StringBuilder sb = new StringBuilder(); for (byte b : d) sb.append(String.format("%02x", b)); return sb.toString(); } catch (Exception e) { throw new RuntimeException(e); } }
    private static String enc(String s) { try { return s == null ? "~" : "=" + URLEncoder.encode(s, "UTF-8"); } catch (Exception e) { throw new RuntimeException(e); } }
    private static String dec(String s) { try { return s.equals("~") ? null : URLDecoder.decode(s.substring(1), "UTF-8"); } catch (Exception e) { throw new RuntimeException(e); } }
    private static String list(List<String> l) { StringBuilder sb = new StringBuilder(); for (String s : l) { if (sb.length() > 0) sb.append(','); try { sb.append(URLEncoder.encode(s, "UTF-8")); } catch (Exception e) { throw new RuntimeException(e); } } return "=" + sb; }
    private static List<String> unlist(String s) { List<String> o = new ArrayList<String>(); String v = s.substring(1); if (v.isEmpty()) return o; for (String p : v.split(",")) { try { o.add(URLDecoder.decode(p, "UTF-8")); } catch (Exception e) { throw new RuntimeException(e); } } return o; }

    private static String encode(InstalledExtension r) {
        String[][] kv = {
            {"eco", enc(r.ecosystem)}, {"repo", enc(r.repositoryId)}, {"id", enc(r.extensionId)}, {"pkg", enc(r.packageName)}, {"name", enc(r.displayName)},
            {"vn", enc(r.versionName)}, {"vc", enc(String.valueOf(r.versionCode))}, {"sha", enc(r.sha256)}, {"apk", enc(r.apkPath)}, {"trust", enc(r.trust.name())},
            {"inst", enc(String.valueOf(r.installedAt))}, {"upd", enc(String.valueOf(r.updatedAt))}, {"certs", list(r.certSha256)}, {"srcs", list(r.sourceIds)},
            {"en", enc(String.valueOf(r.enabled))}, {"st", enc(r.state.name())}, {"cp", enc(r.compatibility.name())}, {"own", enc(r.ownership.name())},
            {"fc", enc(r.failureCode)}, {"lf", enc(r.lastFailure)}, {"fn", enc(String.valueOf(r.failureCount))}, {"fat", enc(String.valueOf(r.lastFailureAt))},
            {"pvc", enc(String.valueOf(r.prevVersionCode))}, {"pvn", enc(r.prevVersionName)}, {"psha", enc(r.prevSha256)}, {"papk", enc(r.prevApkPath)}, {"pcerts", list(r.prevCertSha256)},
        };
        StringBuilder sb = new StringBuilder();
        for (String[] p : kv) { if (sb.length() > 0) sb.append('\t'); sb.append(p[0]).append(p[1]); }
        return sb.toString();
    }

    private static InstalledExtension decode(String line) {
        Map<String, String> m = new HashMap<String, String>();
        for (String part : line.split("\t")) { int i = 0; while (i < part.length() && part.charAt(i) != '=' && part.charAt(i) != '~') i++; if (i >= part.length()) throw new IllegalArgumentException(); m.put(part.substring(0, i), part.substring(i)); }
        InstalledExtension r = new InstalledExtension();
        r.ecosystem = dec(m.get("eco")); r.repositoryId = dec(m.get("repo")); r.extensionId = dec(m.get("id")); r.packageName = dec(m.get("pkg"));
        if (r.extensionId == null || r.packageName == null) throw new IllegalArgumentException();
        r.displayName = dec(m.get("name")); r.versionName = dec(m.get("vn")); r.versionCode = Long.parseLong(dec(m.get("vc")));
        r.sha256 = dec(m.get("sha")); r.apkPath = dec(m.get("apk")); r.trust = States.RepoTrust.valueOf(dec(m.get("trust")));
        r.installedAt = Long.parseLong(dec(m.get("inst"))); r.updatedAt = Long.parseLong(dec(m.get("upd")));
        r.certSha256 = unlist(m.get("certs")); r.sourceIds = unlist(m.get("srcs")); r.enabled = Boolean.parseBoolean(dec(m.get("en")));
        r.state = States.Lifecycle.valueOf(dec(m.get("st"))); r.compatibility = States.Compatibility.valueOf(dec(m.get("cp"))); r.ownership = States.Ownership.valueOf(dec(m.get("own")));
        r.failureCode = dec(m.get("fc")); r.lastFailure = dec(m.get("lf")); r.failureCount = Integer.parseInt(dec(m.get("fn"))); r.lastFailureAt = Long.parseLong(dec(m.get("fat")));
        r.prevVersionCode = Long.parseLong(dec(m.get("pvc"))); r.prevVersionName = dec(m.get("pvn")); r.prevSha256 = dec(m.get("psha")); r.prevApkPath = dec(m.get("papk")); r.prevCertSha256 = unlist(m.get("pcerts"));
        return r;
    }
}
