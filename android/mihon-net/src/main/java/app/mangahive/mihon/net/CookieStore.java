package app.mangahive.mihon.net;

import java.nio.charset.Charset;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * RFC 6265 cookie jar, keyed by {@link CookieScope}. It is MangaHive's own jar: it never reads or writes the WebView's
 * CookieManager, so the user's browser/login cookies (including the Supabase session cookies the PWA keeps) are not
 * reachable from extension traffic, and extension cookies are not visible to the WebView.
 *
 * Persistence is minimal: only cookies with an explicit expiry are written; session cookies live in memory only.
 * {@link #clearExtension} wipes memory and disk for every source of an extension (called on uninstall).
 *
 * Known gap: there is no public-suffix list on-device here, so supercookie protection is a heuristic (see isPublicSuffix).
 * Impact is contained: a cookie can only ever be read back by the same (extension, source) that received it.
 */
public final class CookieStore {
    public interface Clock { long nowMs(); }

    public static final int MAX_PER_SCOPE = 180;
    public static final int MAX_PER_DOMAIN = 50;
    public static final int MAX_COOKIE_BYTES = 4096;
    private static final Charset UTF8 = Charset.forName("UTF-8");

    private static final class Cookie {
        String name, value, domain, path;
        boolean hostOnly, secure;
        long expiresMs;           // Long.MAX_VALUE = session
        long createdMs;
        boolean persistent() { return expiresMs != Long.MAX_VALUE; }
    }

    private final Map<CookieScope, List<Cookie>> jars = new HashMap<CookieScope, List<Cookie>>();
    private final CookieStorage storage;
    private final Clock clock;

    public CookieStore(CookieStorage storage, Clock clock) { this.storage = storage; this.clock = clock; }

    // ───────────────────────────── public API ─────────────────────────────

    /** Stores every acceptable cookie from a response's Set-Cookie headers (one string per header line). */
    public void saveFromResponse(CookieScope scope, SafeUrl url, List<String> setCookieHeaders) {
        if (setCookieHeaders == null || setCookieHeaders.isEmpty()) return;
        boolean persistentChanged = false;
        synchronized (this) {
            List<Cookie> jar = jar(scope);
            long now = clock.nowMs();
            for (String line : setCookieHeaders) {
                Cookie c = parse(line, url, now);
                if (c == null) continue;
                Iterator<Cookie> it = jar.iterator();
                while (it.hasNext()) {
                    Cookie o = it.next();
                    if (o.name.equals(c.name) && o.domain.equals(c.domain) && o.path.equals(c.path) && o.hostOnly == c.hostOnly) {
                        persistentChanged |= o.persistent();
                        c.createdMs = o.createdMs;               // RFC 6265 5.3 step 11.3: keep creation time
                        it.remove();
                    }
                }
                if (c.expiresMs <= now) { continue; }            // expired = delete only
                jar.add(c);
                persistentChanged |= c.persistent();
            }
            persistentChanged |= evict(jar, now);
            if (persistentChanged) persist(scope, jar);
        }
    }

    /** Value of the Cookie request header for this URL, or null. */
    public String cookieHeader(CookieScope scope, SafeUrl url) {
        synchronized (this) {
            List<Cookie> jar = jar(scope);
            long now = clock.nowMs();
            List<Cookie> hit = new ArrayList<Cookie>();
            boolean expiredSome = false;
            for (Cookie c : jar) {
                if (c.expiresMs <= now) { expiredSome = true; continue; }
                if (c.secure && !url.isHttps()) continue;
                if (!(c.hostOnly ? url.host.equals(c.domain) : domainMatch(url.host, c.domain))) continue;
                if (url.ipLiteral != null && !c.hostOnly) continue;
                if (!pathMatch(url.path(), c.path)) continue;
                hit.add(c);
            }
            if (expiredSome) { evict(jar, now); persist(scope, jar); }
            if (hit.isEmpty()) return null;
            Collections.sort(hit, new Comparator<Cookie>() {
                @Override public int compare(Cookie a, Cookie b) {
                    if (a.path.length() != b.path.length()) return b.path.length() - a.path.length();
                    return Long.compare(a.createdMs, b.createdMs);
                }
            });
            StringBuilder sb = new StringBuilder();
            for (Cookie c : hit) { if (sb.length() > 0) sb.append("; "); sb.append(c.name).append('=').append(c.value); }
            return sb.toString();
        }
    }

    public synchronized int count(CookieScope scope) { return jar(scope).size(); }

    public synchronized void clearScope(CookieScope scope) {
        jars.put(scope, new ArrayList<Cookie>());
        if (storage != null) storage.save(scope, Collections.<String>emptyList());
    }

    /** Uninstall: forget every source's cookies of this extension, in memory and on disk. */
    public synchronized void clearExtension(String extensionId) {
        Iterator<CookieScope> it = jars.keySet().iterator();
        while (it.hasNext()) if (it.next().extensionId.equals(extensionId)) it.remove();
        if (storage != null) storage.deleteExtension(extensionId);
    }

    // ───────────────────────────── internals ─────────────────────────────

    private List<Cookie> jar(CookieScope scope) {
        List<Cookie> j = jars.get(scope);
        if (j == null) {
            j = new ArrayList<Cookie>();
            if (storage != null) for (String l : storage.load(scope)) { Cookie c = fromLine(l); if (c != null) j.add(c); }
            jars.put(scope, j);
        }
        return j;
    }

    private void persist(CookieScope scope, List<Cookie> jar) {
        if (storage == null) return;
        List<String> lines = new ArrayList<String>();
        for (Cookie c : jar) if (c.persistent()) lines.add(toLine(c));
        storage.save(scope, lines);
    }

    /** Drops expired, then oldest beyond per-domain and per-scope caps. Returns true if a persistent cookie was dropped. */
    private boolean evict(List<Cookie> jar, long now) {
        boolean persistentDropped = false;
        Iterator<Cookie> it = jar.iterator();
        while (it.hasNext()) { Cookie c = it.next(); if (c.expiresMs <= now) { persistentDropped |= c.persistent(); it.remove(); } }
        Map<String, Integer> perDomain = new HashMap<String, Integer>();
        Collections.sort(jar, new Comparator<Cookie>() { @Override public int compare(Cookie a, Cookie b) { return Long.compare(b.createdMs, a.createdMs); } });
        it = jar.iterator();
        while (it.hasNext()) {
            Cookie c = it.next();
            Integer n = perDomain.get(c.domain);
            n = n == null ? 1 : n + 1;
            perDomain.put(c.domain, n);
            if (n > MAX_PER_DOMAIN) { persistentDropped |= c.persistent(); it.remove(); }
        }
        while (jar.size() > MAX_PER_SCOPE) { Cookie c = jar.remove(jar.size() - 1); persistentDropped |= c.persistent(); }
        return persistentDropped;
    }

    // ───────────────────────────── Set-Cookie parsing ─────────────────────────────

    static Cookie parse(String header, SafeUrl url, long now) {
        if (header == null || header.length() > MAX_COOKIE_BYTES + 1024) return null;
        String[] parts = header.split(";", -1);
        String nv = parts[0];
        int eq = nv.indexOf('=');
        if (eq < 0) return null;
        String name = nv.substring(0, eq).trim();
        String value = nv.substring(eq + 1).trim();
        if (name.isEmpty()) return null;
        if (name.getBytes(UTF8).length + value.getBytes(UTF8).length > MAX_COOKIE_BYTES) return null;
        for (int i = 0; i < name.length(); i++) { char ch = name.charAt(i); if (ch < 0x21 || ch > 0x7e || ch == '=' || ch == ',' || ch == '"') return null; }
        for (int i = 0; i < value.length(); i++) { char ch = value.charAt(i); if (ch < 0x20 || ch == 0x7f) return null; }

        String domainAttr = null, pathAttr = null;
        boolean secure = false;
        Long maxAge = null;
        Long expires = null;
        for (int i = 1; i < parts.length; i++) {
            String a = parts[i].trim();
            if (a.isEmpty()) continue;
            int e = a.indexOf('=');
            String an = (e < 0 ? a : a.substring(0, e)).trim().toLowerCase(Locale.ROOT);
            String av = e < 0 ? "" : a.substring(e + 1).trim();
            if (an.equals("domain")) domainAttr = av;
            else if (an.equals("path")) pathAttr = av;
            else if (an.equals("secure")) secure = true;
            else if (an.equals("max-age")) {
                try { maxAge = Long.parseLong(av); } catch (NumberFormatException ignored) { }
            } else if (an.equals("expires")) {
                Long t = parseDate(av);
                if (t != null) expires = t;
            }
        }
        Cookie c = new Cookie();
        c.name = name; c.value = value; c.secure = secure; c.createdMs = now;
        if (maxAge != null) c.expiresMs = maxAge <= 0 ? 0 : (maxAge > (Long.MAX_VALUE - now) / 1000 ? Long.MAX_VALUE - 1 : now + maxAge * 1000);
        else if (expires != null) c.expiresMs = expires;
        else c.expiresMs = Long.MAX_VALUE;

        if (domainAttr != null && !domainAttr.isEmpty()) {
            String d = domainAttr.toLowerCase(Locale.ROOT);
            if (d.startsWith(".")) d = d.substring(1);
            if (url.ipLiteral != null) { if (!d.equals(url.host)) return null; c.domain = url.host; c.hostOnly = true; }
            else {
                if (isPublicSuffix(d)) { if (!d.equals(url.host)) return null; c.domain = url.host; c.hostOnly = true; }
                else {
                    if (!domainMatch(url.host, d)) return null;      // a host can only set cookies for itself/its parents
                    c.domain = d; c.hostOnly = false;
                }
            }
        } else { c.domain = url.host; c.hostOnly = true; }

        c.path = (pathAttr != null && pathAttr.startsWith("/")) ? pathAttr : defaultPath(url.path());
        if (c.secure && !url.isHttps()) return null;                 // Secure cookies only from secure origins
        if (name.startsWith("__Secure-") && !c.secure) return null;
        if (name.startsWith("__Host-") && (!c.secure || !c.hostOnly || !"/".equals(c.path))) return null;
        return c;
    }

    static String defaultPath(String requestPath) {
        if (requestPath == null || requestPath.isEmpty() || requestPath.charAt(0) != '/') return "/";
        int last = requestPath.lastIndexOf('/');
        return last <= 0 ? "/" : requestPath.substring(0, last);
    }

    static boolean domainMatch(String host, String domain) {
        if (host.equals(domain)) return true;
        return host.endsWith("." + domain) && !looksLikeIp(host);
    }

    static boolean pathMatch(String reqPath, String cookiePath) {
        if (reqPath.equals(cookiePath)) return true;
        if (!reqPath.startsWith(cookiePath)) return false;
        return cookiePath.endsWith("/") || reqPath.charAt(cookiePath.length()) == '/';
    }

    private static boolean looksLikeIp(String h) { return h.indexOf(':') >= 0 || h.matches("[0-9.]+"); }

    private static final Set<String> TWO_LABEL_SUFFIXES = new HashSet<String>(java.util.Arrays.asList(
        "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "net.uk", "com.au", "net.au", "org.au", "edu.au", "gov.au",
        "co.jp", "ne.jp", "or.jp", "ac.jp", "co.kr", "or.kr", "com.br", "net.br", "org.br", "co.in", "net.in", "org.in",
        "com.ng", "org.ng", "name.ng", "gov.ng", "edu.ng", "net.ng", "co.za", "org.za", "com.cn", "net.cn", "org.cn",
        "com.tw", "com.hk", "com.mx", "com.ar", "com.tr", "co.nz", "com.sg", "com.my", "com.ph", "co.id", "or.id", "co.th"));

    /** Heuristic stand-in for the Public Suffix List: a bare TLD or a well-known two-label suffix. */
    static boolean isPublicSuffix(String d) { return d.indexOf('.') < 0 || TWO_LABEL_SUFFIXES.contains(d); }

    private static final Pattern TIME = Pattern.compile("(\\d{1,2}):(\\d{1,2}):(\\d{1,2})");
    private static final String[] MONTHS = { "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec" };

    /** RFC 6265 §5.1.1, tolerant token scan. Returns epoch millis or null. */
    static Long parseDate(String s) {
        int h = -1, mi = -1, sec = -1, day = -1, mon = -1, year = -1;
        for (String tok : s.split("[\\x09\\x20-\\x2F\\x3B-\\x40\\x5B-\\x60\\x7B-\\x7E]+")) {
            if (tok.isEmpty()) continue;
            Matcher m = TIME.matcher(tok);
            if (h < 0 && m.lookingAt()) { h = Integer.parseInt(m.group(1)); mi = Integer.parseInt(m.group(2)); sec = Integer.parseInt(m.group(3)); continue; }
            if (day < 0 && tok.matches("\\d{1,2}.*")) { day = Integer.parseInt(tok.replaceAll("^(\\d{1,2}).*$", "$1")); continue; }
            if (mon < 0 && tok.length() >= 3) {
                String t = tok.substring(0, 3).toLowerCase(Locale.ROOT);
                for (int i = 0; i < 12; i++) if (MONTHS[i].equals(t)) { mon = i; break; }
                if (mon >= 0) continue;
            }
            if (year < 0 && tok.matches("\\d{2,4}.*")) { year = Integer.parseInt(tok.replaceAll("^(\\d{2,4}).*$", "$1")); }
        }
        if (year >= 70 && year <= 99) year += 1900; else if (year >= 0 && year <= 69) year += 2000;
        if (h < 0 || day < 1 || day > 31 || mon < 0 || year < 1601 || h > 23 || mi > 59 || sec > 59) return null;
        java.util.Calendar cal = java.util.Calendar.getInstance(java.util.TimeZone.getTimeZone("UTC"), Locale.ROOT);
        cal.clear();
        cal.set(year, mon, day, h, mi, sec);
        return cal.getTimeInMillis();
    }

    // ───────────────────────────── persistence line format ─────────────────────────────

    private static String toLine(Cookie c) {
        return FileCookieStorage.escape(c.domain) + "\t" + (c.hostOnly ? 1 : 0) + "\t" + FileCookieStorage.escape(c.path) + "\t" + (c.secure ? 1 : 0)
            + "\t" + c.expiresMs + "\t" + c.createdMs + "\t" + FileCookieStorage.escape(c.name) + "\t" + FileCookieStorage.escape(c.value);
    }

    private static Cookie fromLine(String l) {
        String[] f = l.split("\t", -1);
        if (f.length != 8) return null;
        try {
            Cookie c = new Cookie();
            c.domain = unescape(f[0]); c.hostOnly = "1".equals(f[1]); c.path = unescape(f[2]); c.secure = "1".equals(f[3]);
            c.expiresMs = Long.parseLong(f[4]); c.createdMs = Long.parseLong(f[5]); c.name = unescape(f[6]); c.value = unescape(f[7]);
            return c.persistent() ? c : null;
        } catch (RuntimeException e) { return null; }
    }

    private static String unescape(String s) {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            if (ch == '%' && i + 2 <= s.length() - 1) { out.write(Integer.parseInt(s.substring(i + 1, i + 3), 16)); i += 2; }
            else out.write(ch);
        }
        return new String(out.toByteArray(), UTF8);
    }
}
