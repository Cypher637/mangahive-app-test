package app.mangahive.mihon.install;

import java.util.HashMap;
import java.util.Map;

/** Per-extension failure bookkeeping with exponential cooldown, so a crashing extension is not restarted forever. */
public final class FailureTracker {
    public interface Clock { long now(); }
    public static final class Entry { public int count; public String type; public long lastAt, retryAt; }

    private final Map<String, Entry> map = new HashMap<String, Entry>();
    private final Clock clock;
    private final long baseMs, maxMs;
    private final int quarantineAfter;

    public FailureTracker(Clock clock, long baseMs, long maxMs, int quarantineAfter) { this.clock = clock; this.baseMs = baseMs; this.maxMs = maxMs; this.quarantineAfter = quarantineAfter; }

    public synchronized Entry record(String id, String type) {
        Entry e = map.get(id);
        if (e == null) { e = new Entry(); map.put(id, e); }
        e.count++; e.type = type; e.lastAt = clock.now();
        long backoff = baseMs << Math.min(e.count - 1, 20);
        e.retryAt = e.lastAt + Math.min(backoff <= 0 ? maxMs : backoff, maxMs);
        return e;
    }
    public synchronized void success(String id) { map.remove(id); }
    public synchronized boolean mayAttempt(String id) {
        Entry e = map.get(id);
        return e == null || (e.count < quarantineAfter && clock.now() >= e.retryAt);
    }
    public synchronized boolean quarantined(String id) { Entry e = map.get(id); return e != null && e.count >= quarantineAfter; }
    public synchronized Entry get(String id) { return map.get(id); }
    /** User explicitly re-enabled: forgive. */
    public synchronized void release(String id) { map.remove(id); }
}
