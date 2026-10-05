package app.mangahive.mihon.net;

import java.nio.charset.Charset;
import java.security.MessageDigest;

/**
 * Cookie identity = (extensionId, sourceId). Both are fixed when the host creates the broker for a source, so there is
 * no "currently active extension" variable anywhere: two extensions, or two sources of one extension, can never read
 * or overwrite each other's cookies because they never share a key.
 */
public final class CookieScope {
    public final String extensionId;
    public final long sourceId;

    public CookieScope(String extensionId, long sourceId) {
        if (extensionId == null || extensionId.isEmpty() || extensionId.length() > 256) throw new IllegalArgumentException("extensionId");
        this.extensionId = extensionId;
        this.sourceId = sourceId;
    }

    /** Stable file/map key; hashed so no extension-controlled string is ever used as a path. */
    public String key() {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            md.update(extensionId.getBytes(Charset.forName("UTF-8")));
            md.update((byte) 0);
            md.update(Long.toString(sourceId).getBytes(Charset.forName("UTF-8")));
            byte[] d = md.digest();
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 16; i++) sb.append(String.format("%02x", d[i] & 0xff));
            return sb.toString();
        } catch (java.security.NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
    }

    @Override public boolean equals(Object o) {
        return o instanceof CookieScope && ((CookieScope) o).extensionId.equals(extensionId) && ((CookieScope) o).sourceId == sourceId;
    }
    @Override public int hashCode() { return extensionId.hashCode() * 31 + (int) (sourceId ^ (sourceId >>> 32)); }
    @Override public String toString() { return "scope[" + extensionId + "/" + sourceId + "]"; }
}
