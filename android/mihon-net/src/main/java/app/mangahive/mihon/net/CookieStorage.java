package app.mangahive.mihon.net;

import java.util.List;

/** Persistence port. Only PERSISTENT cookies (explicit expiry) are ever passed here; session cookies stay in memory. */
public interface CookieStorage {
    /** All persisted scopes, so the store can reload lazily by scope. */
    List<String> load(CookieScope scope);
    void save(CookieScope scope, List<String> lines);
    /** Removes every file belonging to this extension (all of its sources). */
    void deleteExtension(String extensionId);
}
