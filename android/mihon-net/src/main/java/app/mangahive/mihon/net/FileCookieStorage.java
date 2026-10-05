package app.mangahive.mihon.net;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.Charset;
import java.util.ArrayList;
import java.util.List;

/**
 * One small text file per scope, named by the scope's hash (never by extension-controlled text).
 * Line 1: "#ext\t<extensionId percent-escaped>" so uninstall can find every file of an extension.
 * Directory must be app-private (the runtime passes filesDir/mihon_cookies).
 */
public final class FileCookieStorage implements CookieStorage {
    private static final Charset UTF8 = Charset.forName("UTF-8");
    private final File dir;

    public FileCookieStorage(File dir) { this.dir = dir; }

    @Override public List<String> load(CookieScope scope) {
        File f = new File(dir, scope.key() + ".ck");
        List<String> out = new ArrayList<String>();
        if (!f.isFile()) return out;
        BufferedReader r = null;
        try {
            r = new BufferedReader(new InputStreamReader(new FileInputStream(f), UTF8));
            String line = r.readLine();                         // header
            if (line == null || !line.startsWith("#ext\t")) return out;
            while ((line = r.readLine()) != null) if (!line.isEmpty()) out.add(line);
        } catch (IOException ignored) {
        } finally { closeQuietly(r); }
        return out;
    }

    @Override public synchronized void save(CookieScope scope, List<String> lines) {
        if (!dir.isDirectory() && !dir.mkdirs()) return;
        File f = new File(dir, scope.key() + ".ck");
        if (lines.isEmpty()) { f.delete(); return; }
        File tmp = new File(dir, scope.key() + ".tmp");
        Writer w = null;
        try {
            w = new OutputStreamWriter(new FileOutputStream(tmp), UTF8);
            w.write("#ext\t" + escape(scope.extensionId) + "\n");
            for (String l : lines) w.write(l + "\n");
            w.close(); w = null;
            if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f); }
        } catch (IOException ignored) {
        } finally { closeQuietly(w); tmp.delete(); }
    }

    @Override public synchronized void deleteExtension(String extensionId) {
        File[] files = dir.listFiles();
        if (files == null) return;
        String want = "#ext\t" + escape(extensionId);
        for (File f : files) {
            if (!f.getName().endsWith(".ck")) continue;
            BufferedReader r = null;
            try {
                r = new BufferedReader(new InputStreamReader(new FileInputStream(f), UTF8));
                String first = r.readLine();
                closeQuietly(r); r = null;
                if (want.equals(first)) f.delete();
            } catch (IOException ignored) { } finally { closeQuietly(r); }
        }
    }

    static String escape(String s) {
        StringBuilder sb = new StringBuilder();
        for (byte b : s.getBytes(UTF8)) {
            int c = b & 0xff;
            if (c > 0x20 && c < 0x7f && c != '%' && c != '\t') sb.append((char) c);
            else sb.append('%').append(String.format("%02X", c));
        }
        return sb.toString();
    }

    private static void closeQuietly(java.io.Closeable c) { if (c != null) try { c.close(); } catch (IOException ignored) {} }
}
