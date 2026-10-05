package app.mangahive.mihon.install;

import java.io.File;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Set;

/** Keeps cache directories under a byte budget. Never deletes anything in [protectedPaths] (installed APKs). */
public final class BoundedCache {
    private BoundedCache() {}

    /** Abandoned partial downloads are always removable; completed cache files are evicted oldest-first until under budget. */
    public static long enforce(File dir, long maxBytes, Set<String> protectedPaths) {
        File[] files = dir.listFiles();
        if (files == null) return 0;
        List<File> list = new ArrayList<File>();
        for (File f : files) if (f.isFile() && !protectedPaths.contains(canon(f))) list.add(f);
        long freed = 0;
        for (File f : new ArrayList<File>(list)) if (f.getName().endsWith(".part")) { long n = f.length(); if (f.delete()) { freed += n; list.remove(f); } }
        long total = 0;
        for (File f : list) total += f.length();
        long protectedBytes = 0;
        for (File f : files) if (f.isFile() && protectedPaths.contains(canon(f))) protectedBytes += f.length();
        Collections.sort(list, new Comparator<File>() { public int compare(File a, File b) { return Long.compare(a.lastModified(), b.lastModified()); } });
        for (File f : list) {
            if (total + protectedBytes <= maxBytes) break;
            long n = f.length();
            if (f.delete()) { total -= n; freed += n; }
        }
        return freed;
    }

    private static String canon(File f) { try { return f.getCanonicalPath(); } catch (Exception e) { return f.getAbsolutePath(); } }
    static List<String> names(File[] fs) { List<String> o = new ArrayList<String>(); if (fs != null) for (File f : fs) o.add(f.getName()); Collections.sort(o); return o; }
    static { Arrays.asList(); }
}
