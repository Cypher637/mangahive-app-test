package app.mangahive.mihon.net;

import app.mangahive.mihon.spi.BrokerException;
import app.mangahive.mihon.spi.CancelScope;
import app.mangahive.mihon.spi.Registration;
import app.mangahive.mihon.spi.RequestContext;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/**
 * The runtime's registry of live work: {@code requestId -> Job}. The id is the one the web layer minted; the registry
 * mints nothing.
 *
 * A job reaches exactly one terminal state, decided by compare-and-set, so exactly one party owns the reply:
 *   DONE (the worker finished first) | CANCELLED (a cancel arrived) | TIMED_OUT (the deadline fired).
 * Aborting is REAL: it cancels the job's {@link CancelScope} (every HTTP call, connection and body stream registered
 * under it is torn down on the cancelling thread), runs the job's {@link Job#setRunner runner} (coroutine/Future
 * cancel) and interrupts the bound worker thread. At every terminal state the entry leaves the map, the deadline timer
 * is cancelled and the scope is detached; the extension's job slot is returned when the worker thread has really
 * exited (a wedged worker cannot be used to spawn unlimited new ones).
 */
public final class ActiveJobs {
    public enum State { RUNNING, DONE, CANCELLED, TIMED_OUT }

    private final ConcurrentHashMap<String, Job> jobs = new ConcurrentHashMap<String, Job>();
    private final ResourceGovernor governor;
    private final Deadlines deadlines;
    private final CancelScope root = CancelScope.root();
    private final AtomicInteger liveWorkers = new AtomicInteger();

    public ActiveJobs(ResourceGovernor governor, Deadlines deadlines) { this.governor = governor; this.deadlines = deadlines; }

    /** Called once, on the winning thread, when a job is aborted (cancel or timeout). Not called for normal completion. */
    public interface AbortListener { void aborted(Job job, CancelScope.Reason reason); }

    public final class Job {
        public final String requestId;
        public final String extensionId;   // null for jobs not tied to one extension (health, lifecycle)
        public final CancelScope scope;
        public final RequestContext ctx;
        private final AtomicReference<State> state = new AtomicReference<State>(State.RUNNING);
        private final Object lock = new Object();
        private Thread worker;
        private Runnable runner;
        private Registration timer = Registration.NONE;
        private ResourceGovernor.Lease slot;
        private boolean workerExited;
        private AbortListener listener;

        private Job(String requestId, String extensionId, CancelScope scope) {
            this.requestId = requestId; this.extensionId = extensionId; this.scope = scope;
            this.ctx = new RequestContext(requestId, scope);
        }

        public State state() { return state.get(); }

        /** How to cancel the thing executing this job (coroutine Job.cancel / Future.cancel). Called on abort. */
        public void setRunner(Runnable r) {
            boolean runNow;
            synchronized (lock) { runner = r; runNow = state.get() != State.RUNNING; }
            if (runNow) { try { r.run(); } catch (Throwable ignored) { } }
        }

        /** The calling thread is the one executing the job: abort may interrupt it (until {@link #workerExited}). */
        public void bindThread() {
            synchronized (lock) { worker = Thread.currentThread(); }
            if (state.get() != State.RUNNING) Thread.currentThread().interrupt();
        }

        /** The worker finished normally first. Returns true if the caller now owns the (success/failure) reply. */
        public boolean tryComplete() {
            if (!state.compareAndSet(State.RUNNING, State.DONE)) return false;
            retire();
            return true;
        }

        /** Abort with a real cancellation. Returns true if this call won the race (and so owns the failure reply). */
        public boolean tryAbort(CancelScope.Reason why) {
            State target = why == CancelScope.Reason.TIMEOUT ? State.TIMED_OUT : State.CANCELLED;
            if (!state.compareAndSet(State.RUNNING, target)) return false;
            scope.cancel(why);                          // sockets, calls, body streams
            Runnable r; Thread t;
            synchronized (lock) { r = runner; t = worker; }
            if (r != null) { try { r.run(); } catch (Throwable ignored) { } }
            if (t != null && t != Thread.currentThread()) t.interrupt();
            retire();
            AbortListener l; synchronized (lock) { l = listener; }
            if (l != null) { try { l.aborted(this, why); } catch (Throwable ignored) { } }
            return true;
        }

        /** Call from the worker's finally block: the thread is done with this job. Returns the extension's job slot. */
        public void workerExited() {
            ResourceGovernor.Lease s;
            synchronized (lock) {
                if (workerExited) return;
                workerExited = true; worker = null; s = slot; slot = null;
            }
            if (Thread.interrupted()) { /* clear a late interrupt so it cannot leak into the pool thread's next task */ }
            if (s != null) s.close();
            liveWorkers.decrementAndGet();
            // a worker that outlived its job (abandoned) still gets the entry removed above; nothing more to do
        }

        /** Terminal: leave the registry, stop the timer, detach the scope. Idempotent. */
        private void retire() {
            jobs.remove(requestId, this);
            Registration t;
            synchronized (lock) { t = timer; timer = Registration.NONE; }
            t.close();
            scope.close();
        }
    }

    /**
     * Registers a job under the web-supplied id and arms its deadline.
     * @throws BrokerException DUPLICATE_ID if the id is live; CONCURRENCY_LIMIT if the extension is at its job cap.
     */
    public Job open(String requestId, String extensionId, long timeoutMs) throws BrokerException { return open(requestId, extensionId, timeoutMs, null); }

    public Job open(String requestId, String extensionId, long timeoutMs, AbortListener listener) throws BrokerException {
        if (requestId == null || !requestId.matches("[A-Za-z0-9_.-]{1,64}")) throw new BrokerException("BAD_REQUEST", "request id");
        ResourceGovernor.Lease slot = extensionId == null ? null : governor.admitJob(extensionId);
        final Job j = new Job(requestId, extensionId, root.child());
        j.slot = slot; j.listener = listener;
        if (jobs.putIfAbsent(requestId, j) != null) {
            if (slot != null) slot.close();
            j.scope.close();
            throw new BrokerException("DUPLICATE_ID", "request id already in flight");
        }
        liveWorkers.incrementAndGet();
        Registration t = deadlines.after(timeoutMs, new Runnable() { @Override public void run() { j.tryAbort(CancelScope.Reason.TIMEOUT); } });
        synchronized (j.lock) { j.timer = t; }
        if (j.state.get() != State.RUNNING) t.close();   // finished before the timer was stored
        return j;
    }

    /** Web/IPC cancel. Unknown or already finished ids are a harmless no-op. */
    public boolean cancel(String requestId) {
        Job j = jobs.get(requestId);
        return j != null && j.tryAbort(CancelScope.Reason.CANCELLED);
    }

    /** Runtime shutdown / uninstall: abort everything (or everything of one extension). */
    public int cancelAll(String extensionIdOrNull) { return cancelAll(extensionIdOrNull, null); }

    /** As above, but never the job {@code exceptRequestId} (the uninstall request that is doing the cancelling). */
    public int cancelAll(String extensionIdOrNull, String exceptRequestId) {
        int n = 0;
        for (Job j : new ArrayList<Job>(jobs.values())) {
            if (extensionIdOrNull != null && !extensionIdOrNull.equals(j.extensionId)) continue;
            if (exceptRequestId != null && exceptRequestId.equals(j.requestId)) continue;
            if (j.tryAbort(CancelScope.Reason.CANCELLED)) n++;
        }
        return n;
    }

    public int size() { return jobs.size(); }
    /** Worker threads that have not exited yet (may exceed {@link #size} while an aborted worker is still unwinding). */
    public int liveWorkers() { return liveWorkers.get(); }
    public List<String> ids() { return new ArrayList<String>(jobs.keySet()); }
    /** Hooks still attached below the registry root (tests: 0 when idle). */
    public int rootHooks() { return root.hookCount(); }
}
