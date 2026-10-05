package app.mangahive.mihon.spi;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A cancellable scope: the single cancellation primitive that travels Web -> IPC -> job -> Source -> HTTP -> body stream.
 *
 * - {@link #cancel} is first-wins (the reason sticks) and runs every registered abort hook once, outside the lock.
 * - Hooks registered after cancellation run immediately.
 * - {@link #child} scopes are cancelled with their parent; {@link #close} detaches a finished child from its parent,
 *   so completed work leaves no hook behind. {@link #hookCount} exists so tests can prove that.
 */
public final class CancelScope implements CancelSignal {
    public enum Reason { CANCELLED, TIMEOUT }

    private final Object lock = new Object();
    private final Map<Long, Runnable> hooks = new LinkedHashMap<Long, Runnable>();
    private long nextKey;
    private boolean cancelled;
    private Reason reason;
    private Registration parentLink = Registration.NONE;

    public static CancelScope root() { return new CancelScope(); }

    private CancelScope() { }

    /** A scope that is cancelled when this one is. Close it when its work is done. */
    public CancelScope child() {
        final CancelScope c = new CancelScope();
        Registration link = onCancel(new Runnable() {
            @Override public void run() { c.cancel(reason()); }
        });
        synchronized (c.lock) { c.parentLink = link; }
        return c;
    }

    /** @return true when this call is the one that cancelled the scope. */
    public boolean cancel(Reason why) {
        List<Runnable> toRun;
        synchronized (lock) {
            if (cancelled) return false;
            cancelled = true;
            reason = why == null ? Reason.CANCELLED : why;
            toRun = new ArrayList<Runnable>(hooks.values());
            hooks.clear();
        }
        // newest first: the resource opened last (the body stream) is torn down before the one it rides on
        for (int i = toRun.size() - 1; i >= 0; i--) {
            try { toRun.get(i).run(); } catch (Throwable ignored) { /* an abort hook must not stop the others */ }
        }
        return true;
    }

    @Override public boolean isCancelled() { synchronized (lock) { return cancelled; } }

    /** null until cancelled. */
    public Reason reason() { synchronized (lock) { return reason; } }

    @Override public Registration onCancel(final Runnable abort) {
        final long key;
        synchronized (lock) {
            if (!cancelled) {
                key = nextKey++;
                hooks.put(key, abort);
                return new Registration() {
                    @Override public void close() { synchronized (lock) { hooks.remove(key); } }
                };
            }
        }
        try { abort.run(); } catch (Throwable ignored) { }
        return Registration.NONE;
    }

    /** Detaches this scope from its parent and drops its hooks. Does NOT cancel. Idempotent. */
    public void close() {
        Registration link;
        synchronized (lock) { link = parentLink; parentLink = Registration.NONE; hooks.clear(); }
        link.close();
    }

    /** Number of live hooks (tests: must be 0 once the work finished). */
    public int hookCount() { synchronized (lock) { return hooks.size(); } }

    /** The failure a blocked operation should surface once this scope aborted it. */
    public BrokerException asException() {
        Reason r = reason();
        return r == Reason.TIMEOUT ? new BrokerException("TIMEOUT", "timed out") : new BrokerException("CANCELLED", "request cancelled");
    }
}
