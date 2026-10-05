package app.mangahive.mihon.install;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Duplicate-id policy and JVM-test ownership table. Runtime source objects are owned by MihonSourceRegistry; this table is not a second Android runtime registry. */
public final class Ownership {
    private Ownership() {}

    /** Never silently lets repository B take over an identity owned by repository A. */
    public static States.Ownership resolve(Collection<InstalledExtension> installed, RepoEntry incoming, List<String> incomingCerts, States.RepoTrust incomingTrust) {
        if (incomingTrust == States.RepoTrust.BLOCKED) return States.Ownership.BLOCKED;
        InstalledExtension owner = null;
        for (InstalledExtension i : installed) if (i.extensionId.equals(incoming.extensionId)) { owner = i; break; }
        if (owner == null) return States.Ownership.PRIMARY;
        if (owner.repositoryId.equals(incoming.repositoryId)) return owner.packageName.equals(incoming.packageName) ? States.Ownership.PRIMARY : States.Ownership.CONFLICT;
        boolean samePackage = owner.packageName.equals(incoming.packageName);
        boolean sameSigner = Policies.sameSet(owner.certSha256, incomingCerts);
        return samePackage && sameSigner ? States.Ownership.ALTERNATE_REPOSITORY : States.Ownership.CONFLICT;
    }

    /**
     * canonical source -> ordered claimants. The owner is the first claimant that is currently usable. Releasing an extension is
     * copy-on-write (build new table, then swap), so readers never see a half-cleaned state; another valid claimant is restored.
     */
    public static final class SourceTable {
        public interface Usable { boolean test(String extensionId); }
        private volatile Map<String, List<String>> claims = new LinkedHashMap<String, List<String>>();

        public static String key(String extensionId, String sourceId) { return extensionId + "/" + sourceId; }

        public synchronized void claim(String canonicalSource, String extensionId) {
            Map<String, List<String>> next = copy(claims);
            List<String> l = next.get(canonicalSource);
            if (l == null) { l = new ArrayList<String>(); next.put(canonicalSource, l); }
            if (!l.contains(extensionId)) l.add(extensionId);
            claims = next;
        }

        public synchronized void releaseExtension(String extensionId) {
            Map<String, List<String>> next = copy(claims);
            for (java.util.Iterator<Map.Entry<String, List<String>>> it = next.entrySet().iterator(); it.hasNext(); ) {
                Map.Entry<String, List<String>> en = it.next();
                en.getValue().remove(extensionId);
                if (en.getValue().isEmpty()) it.remove();
            }
            claims = next;
        }

        public String owner(String canonicalSource, Usable usable) {
            List<String> l = claims.get(canonicalSource);
            if (l == null) return null;
            for (String ext : l) if (usable.test(ext)) return ext;
            return null;
        }

        public List<String> sourcesOf(String extensionId) {
            List<String> out = new ArrayList<String>();
            for (Map.Entry<String, List<String>> en : claims.entrySet()) if (en.getValue().contains(extensionId)) out.add(en.getKey());
            return out;
        }

        private static Map<String, List<String>> copy(Map<String, List<String>> m) {
            Map<String, List<String>> n = new LinkedHashMap<String, List<String>>();
            for (Map.Entry<String, List<String>> en : m.entrySet()) n.put(en.getKey(), new ArrayList<String>(en.getValue()));
            return n;
        }
    }
}
