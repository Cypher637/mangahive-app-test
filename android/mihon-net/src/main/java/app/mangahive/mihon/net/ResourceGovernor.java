package app.mangahive.mihon.net;

import app.mangahive.mihon.spi.BrokerException;
import app.mangahive.mihon.spi.CancelSignal;
import app.mangahive.mihon.spi.Registration;

import java.io.Closeable;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Per-extension AND per-source resource limits, enforced where the work actually happens:
 *  - maximum concurrency (in-flight HTTP calls, counted until the response BODY is closed, plus concurrent jobs),
 *  - request rate (token bucket; every redirect hop is a real outbound request and costs a token),
 *  - call timeout ceiling and response size ceiling.
 * One extension can therefore not take unlimited sockets, threads or bandwidth, and one source cannot starve its siblings.
 *
 * Over the concurrency cap a request is REFUSED at once ({@code CONCURRENCY_LIMIT}); nothing queues unboundedly. Over the
 * rate it waits (cancellably) if the wait is within {@link Limits#maxRateWaitMs}, otherwise it is refused
 * ({@code RATE_LIMITED}). Both are retryable.
 */
public final class ResourceGovernor {

    /** Immutable limit set. */
    public static final class Limits {
        public final int maxConcurrent;        // in-flight HTTP calls
        public final int maxConcurrentJobs;    // runtime jobs (extension level)
        public final double requestsPerSecond;
        public final int burst;
        public final long maxRateWaitMs;       // 0 = never wait, fail fast
        public final int defaultCallMs, maxCallMs;
        public final long maxResponseBytes;

        public Limits(int maxConcurrent, int maxConcurrentJobs, double requestsPerSecond, int burst, long maxRateWaitMs,
                      int defaultCallMs, int maxCallMs, long maxResponseBytes) {
            if (maxConcurrent < 1 || maxConcurrentJobs < 1 || requestsPerSecond <= 0 || burst < 1) throw new IllegalArgumentException("limits");
            this.maxConcurrent = maxConcurrent; this.maxConcurrentJobs = maxConcurrentJobs;
            this.requestsPerSecond = requestsPerSecond; this.burst = burst; this.maxRateWaitMs = maxRateWaitMs;
            this.defaultCallMs = defaultCallMs; this.maxCallMs = maxCallMs; this.maxResponseBytes = maxResponseBytes;
        }

        /** Whole extension (all its sources together). */
        public static final Limits EXTENSION_DEFAULT = new Limits(8, 6, 20, 40, 1_500, 60_000, 120_000, 16L << 20);
        /** One source. */
        public static final Limits SOURCE_DEFAULT = new Limits(4, 4, 10, 20, 1_500, 60_000, 120_000, 16L << 20);
        /** Repository / APK downloads (no extension identity). */
        public static final Limits DOWNLOAD_DEFAULT = new Limits(2, 2, 5, 10, 1_500, 120_000, 600_000, 80L << 20);
    }

    /** Monotonic clock; injectable so rate tests do not sleep. */
    public interface Clock { long nanoTime(); }
    private static final Clock SYSTEM = new Clock() { @Override public long nanoTime() { return System.nanoTime(); } };

    private static final class Bucket {
        final Limits limits;
        int activeCalls, activeJobs;
        double tokens;
        long lastNanos;
        Bucket(Limits l, long now) { limits = l; tokens = l.burst; lastNanos = now; }
        void refill(long now) {
            double add = (now - lastNanos) / 1e9 * limits.requestsPerSecond;
            tokens = Math.min(limits.burst, tokens + add);
            lastNanos = now;
        }
        /** seconds until one token is available (0 = now). */
        double waitSeconds() { return tokens >= 1.0 ? 0 : (1.0 - tokens) / limits.requestsPerSecond; }
    }

    private final Clock clock;
    private final Map<String, Bucket> buckets = new HashMap<String, Bucket>();
    private final Map<String, Limits> overrides = new HashMap<String, Limits>();
    private final Limits extensionDefault, sourceDefault, downloadDefault;

    public ResourceGovernor() { this(Limits.EXTENSION_DEFAULT, Limits.SOURCE_DEFAULT, Limits.DOWNLOAD_DEFAULT, SYSTEM); }

    public ResourceGovernor(Limits extensionDefault, Limits sourceDefault, Limits downloadDefault, Clock clock) {
        this.extensionDefault = extensionDefault; this.sourceDefault = sourceDefault; this.downloadDefault = downloadDefault; this.clock = clock;
    }

    public synchronized void setExtensionLimits(String extensionId, Limits l) { overrides.put(extKey(extensionId), l); buckets.remove(extKey(extensionId)); }
    public synchronized void setSourceLimits(String extensionId, long sourceId, Limits l) { overrides.put(srcKey(extensionId, sourceId), l); buckets.remove(srcKey(extensionId, sourceId)); }

    /** Uninstall: forget the extension's buckets and overrides (a re-install starts with a full bucket, not a stale count). */
    public synchronized void clearExtension(String extensionId) {
        String p = extKey(extensionId);
        for (java.util.Iterator<String> it = buckets.keySet().iterator(); it.hasNext(); ) { String k = it.next(); if (k.equals(p) || k.startsWith(p + "#")) it.remove(); }
        for (java.util.Iterator<String> it = overrides.keySet().iterator(); it.hasNext(); ) { String k = it.next(); if (k.equals(p) || k.startsWith(p + "#")) it.remove(); }
    }

    private static String extKey(String e) { return "x:" + e; }
    private static String srcKey(String e, long s) { return "x:" + e + "#" + s; }
    private static final String DOWNLOAD_KEY = "dl";

    private Bucket bucket(String key, Limits dflt) {
        Bucket b = buckets.get(key);
        if (b == null) { Limits l = overrides.get(key); b = new Bucket(l != null ? l : dflt, clock.nanoTime()); buckets.put(key, b); }
        return b;
    }

    // ───────────────────────────── HTTP calls ─────────────────────────────

    /** Admits one HTTP call of a source: concurrency at source and extension level, plus the first hop's rate token. */
    public Lease admitCall(String extensionId, long sourceId, CancelSignal cancel) throws BrokerException {
        Bucket ext, src;
        synchronized (this) {
            ext = bucket(extKey(extensionId), extensionDefault);
            src = bucket(srcKey(extensionId, sourceId), sourceDefault);
            if (src.activeCalls >= src.limits.maxConcurrent) throw new BrokerException("CONCURRENCY_LIMIT", "source has " + src.activeCalls + " calls in flight");
            if (ext.activeCalls >= ext.limits.maxConcurrent) throw new BrokerException("CONCURRENCY_LIMIT", "extension has " + ext.activeCalls + " calls in flight");
            src.activeCalls++; ext.activeCalls++;
        }
        Lease l = new Lease(this, new Bucket[] { src, ext }, false);
        try { l.hop(cancel); } catch (BrokerException e) { l.close(); throw e; }
        return l;
    }

    public Lease admitDownload(CancelSignal cancel) throws BrokerException {
        Bucket dl;
        synchronized (this) {
            dl = bucket(DOWNLOAD_KEY, downloadDefault);
            if (dl.activeCalls >= dl.limits.maxConcurrent) throw new BrokerException("CONCURRENCY_LIMIT", "downloads in flight: " + dl.activeCalls);
            dl.activeCalls++;
        }
        Lease l = new Lease(this, new Bucket[] { dl }, false);
        try { l.hop(cancel); } catch (BrokerException e) { l.close(); throw e; }
        return l;
    }

    /** Admits one runtime job of an extension (concurrent-job cap). Released by closing the lease when the worker has really exited. */
    public Lease admitJob(String extensionId) throws BrokerException {
        Bucket ext;
        synchronized (this) {
            ext = bucket(extKey(extensionId), extensionDefault);
            if (ext.activeJobs >= ext.limits.maxConcurrentJobs) throw new BrokerException("CONCURRENCY_LIMIT", "extension has " + ext.activeJobs + " jobs running");
            ext.activeJobs++;
        }
        return new Lease(this, new Bucket[] { ext }, true);
    }

    /** In-flight HTTP calls charged to a source (tests / health). */
    public synchronized int activeCalls(String extensionId, long sourceId) { Bucket b = buckets.get(srcKey(extensionId, sourceId)); return b == null ? 0 : b.activeCalls; }
    public synchronized int activeCalls(String extensionId) { Bucket b = buckets.get(extKey(extensionId)); return b == null ? 0 : b.activeCalls; }
    public synchronized int activeJobs(String extensionId) { Bucket b = buckets.get(extKey(extensionId)); return b == null ? 0 : b.activeJobs; }
    public synchronized int activeDownloads() { Bucket b = buckets.get(DOWNLOAD_KEY); return b == null ? 0 : b.activeCalls; }

    /** A held slot. Close it (idempotent) when the response body is closed / the job's worker has exited. */
    public static final class Lease implements Closeable {
        private final ResourceGovernor g;
        private final Bucket[] buckets;
        private final boolean job;
        private final AtomicBoolean closed = new AtomicBoolean();

        private Lease(ResourceGovernor g, Bucket[] buckets, boolean job) { this.g = g; this.buckets = buckets; this.job = job; }

        /** Largest response any caller of this lease may receive. */
        public long maxResponseBytes() { long m = Long.MAX_VALUE; for (Bucket b : buckets) m = Math.min(m, b.limits.maxResponseBytes); return m; }

        /** Call timeout actually used: the caller's request (0 = default), clamped to every level's ceiling. */
        public int callMs(int requested) {
            int v = requested;
            if (v <= 0) { v = Integer.MAX_VALUE; for (Bucket b : buckets) v = Math.min(v, b.limits.defaultCallMs); }
            for (Bucket b : buckets) v = Math.min(v, b.limits.maxCallMs);
            return Math.max(1_000, v);
        }

        /** Takes one rate token at every level (one per outbound request, redirect hops included); waits cancellably or refuses. */
        public void hop(CancelSignal cancel) throws BrokerException {
            if (job) throw new IllegalStateException("job lease has no rate");
            g.takeToken(buckets, cancel);
        }

        @Override public void close() {
            if (!closed.compareAndSet(false, true)) return;
            synchronized (g) { for (Bucket b : buckets) { if (job) b.activeJobs--; else b.activeCalls--; } }
        }
    }

    private void takeToken(Bucket[] bs, CancelSignal cancel) throws BrokerException {
        final long startNanos = clock.nanoTime();
        while (true) {
            double waitSec;
            long maxWaitMs = Long.MAX_VALUE;
            synchronized (this) {
                long now = clock.nanoTime();
                waitSec = 0;
                for (Bucket b : bs) { b.refill(now); waitSec = Math.max(waitSec, b.waitSeconds()); maxWaitMs = Math.min(maxWaitMs, b.limits.maxRateWaitMs); }
                if (waitSec <= 0) { for (Bucket b : bs) b.tokens -= 1.0; return; }
            }
            long waitMs = (long) Math.ceil(waitSec * 1000.0);
            long waited = (clock.nanoTime() - startNanos) / 1_000_000L;
            if (waitMs + waited > maxWaitMs) throw new BrokerException("RATE_LIMITED", "retry in " + waitMs + " ms");
            if (cancel != null && cancel.isCancelled()) throw new BrokerException("CANCELLED", "request cancelled");
            sleepCancellable(waitMs, cancel);
        }
    }

    private static void sleepCancellable(long ms, CancelSignal cancel) throws BrokerException {
        final CountDownLatch wake = new CountDownLatch(1);
        Registration r = cancel == null ? Registration.NONE : cancel.onCancel(new Runnable() { @Override public void run() { wake.countDown(); } });
        try {
            wake.await(Math.max(1, ms), TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new BrokerException("CANCELLED", "interrupted while waiting for rate limit");
        } finally { r.close(); }
        if (cancel != null && cancel.isCancelled()) throw new BrokerException("CANCELLED", "request cancelled");
    }
}
