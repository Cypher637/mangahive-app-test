# Stage 6 - Streaming limits, real cancellation, rate limits

Scope: network/resource controls only. UI, source adapters, process model untouched.

## What was wrong in Stage 5
- Size cap checked per read but the cancel signal was a polled flag: a thread parked in a socket read never noticed a cancel
  or a timeout until the read timeout (up to 120 s). `cancel` "interrupted the worker; a blocking OkHttp call may keep running".
- The call deadline was only checked between hops and on the next body read.
- Redirect bodies were closed (drained) rather than aborted.
- Each layer kept its own table (dispatcher `inFlight`, `PendingRequests`, `AtomicBoolean` per download); no per-extension limits.
- Web repository fetch / manifest install / extension HTTP read the whole body (`res.text()`, `res.json()`) and checked after.

## Design
```
Web (id, AbortSignal) -> mihonStart / mihonCancel -> IPC (same id) -> ActiveJobs.Job(id, CancelScope)
   -> SourceGateway(ctx) -> RequestScope (thread / coroutine / OkHttp dispatcher) -> BrokerInterceptor -> HttpBroker.execute(ctx)
   -> BrokerEngine (child CancelScope + deadline) -> Transport (Call.cancel / Socket.close hook) -> BoundedStreams.Body
```
- `CancelScope` (spi): first-wins cancel with reason CANCELLED/TIMEOUT; runs abort hooks on the cancelling thread; hooks added after
  cancel run at once; `child()` / `close()` leave no hook behind (`hookCount()`).
- `BoundedStreams.Body`: counts bytes as they arrive, asks the wire for at most `limit+1`, throws on the first byte past the limit,
  aborts the transport (no drain). An abort that closes the socket can never look like a clean EOF.
- `Transport.Response` now carries `abort()` and an `onClosed` hook; transports must register `cancel.onCancel(...)` that closes the socket.
- `Deadlines`: one daemon timer; a deadline is a callback that cancels the scope. Per HTTP call (`callMs`, clamped by governor ceilings)
  and per runtime job.
- `ActiveJobs`: `requestId -> Job`. CAS terminal state DONE/CANCELLED/TIMED_OUT, so exactly one party replies. Abort = scope cancel +
  runner (Future cancel) + thread interrupt. Every terminal path removes the entry, cancels the timer, detaches the scope.
  The extension's job slot is returned only when the worker thread has really exited (a wedged worker cannot be used to spawn more).
- `ResourceGovernor`: per extension and per source: max concurrent HTTP calls (held until the body is closed), max concurrent jobs,
  token-bucket request rate (redirect hops cost a token; wait is cancellable and bounded, else `RATE_LIMITED`), call-timeout ceiling,
  response ceiling. Downloads have their own bucket. Defaults: extension 8 calls / 6 jobs / 20 rps; source 4 calls / 10 rps; download 2 / 5 rps.
- One id: `WebRequestParser` is the only place an id may be minted (when the web sent none); a malformed id is refused, not replaced.
  The id is the IPC id, the job id, `RequestContext.requestId`, the id handed to `Transport.Request` and the OkHttp call tag.
- Web: `mihonStart` returns at once, result arrives via `window.__mihonResult`; `AbortSignal` -> `mihonCancel(id)` (a separate immediate
  call; the Stage 4 synchronous bridge could not be overtaken). `readBodyBounded` replaces every `text()/json()` on extension HTTP,
  repository index, manifest install, catalog import and GitHub tree fetch.

## Verification actually run
| What | Result |
|---|---|
| `android/mihon-net/run-jvm-harness.sh <mihon-test-extension dir>` (JDK 21) | Stage 5: 332 checks, 0 failed (ported to the new API); Stage 6: 97 checks, 0 failed; Stage 6 repeated 6x, stable |
| `node mihon_stage6_resource_controls_test.js` | 30 static gates pass |
| Stage 1/4/5, boundary, production-security, extension suites | pass (two pinned-string assertions in the Stage 4/5 static tests updated for the new dispatcher/uninstall shape) |

Stage 6 JVM suite uses a scripted real TLS server (stalls after headers, never answers, trickles 1 byte/100 ms, streams chunks forever,
promises 50 MB) and the real `BrokerEngine`, `ResourceGovernor`, `Deadlines`, `ActiveJobs`. It observes the SERVER side: that the client
really closed the connection.

Covered: oversized Content-Length (refused before any body byte, connection closed); oversized chunked (cut at the cap, <= cap bytes delivered,
endless server stopped); exact-cap and cap+1 boundaries; cancel while the reader is blocked in a socket read (ms, not the 30 s read timeout);
cancel during header wait and rate wait; pre-cancelled never dials; call timeout and job timeout against a body that is still trickling in
(read timeout never fires); Source asking for 10 min clamped to ceiling; per-source and per-extension concurrency, other extension unaffected;
rate burst/refill/idle cap, redirect hops cost tokens; job cap; duplicate ids; wedged worker; 300 complete-vs-cancel races (exactly one owner);
120-job mixed churn leaving no jobs, workers, slots, hooks or timers; one request id on all 5 hops of a redirect chain.

Bugs found by these tests and fixed: abort surfacing as clean EOF; an interrupted DNS lookup reported as `DNS_FAILURE` instead of a cancel.

## NOT verified (read this)
- No Kotlin compile, Gradle, instrumented test or device. Everything below the JVM core that carries the cancel is unverified code:
  `OkHttpTransport` (Call.cancel hook), `BrokerInterceptor` / `CallScopes` / `RequestScope` (ThreadLocal + `ThreadContextElement` + OkHttp
  dispatcher wrapper; coroutines API surface unchecked), `RealSourceGateway`, `RuntimeDispatcher`/engine, `MihonJsBridge`, `index.html` bridge.
  `RuntimeDispatcherTest` (new cases: cancel via scope hook, deadline reply TIMEOUT, job cap BUSY) and `NetworkStage6Test` are written, not run.
- `NetworkStage6Test` runs the JVM suite from Gradle; it needs `keytool` and loopback sockets.
- DNS resolution cannot be interrupted (`InetAddress.getAllByName`); cancel during it takes effect when it returns, and nothing is dialled after.
- Source-to-broker seam (Stage 5 finding F1) is still open; a Source that builds its own OkHttpClient bypasses all of this in the same-UID process.
- AIDL `RESPONSE_TOO_LARGE` Binder cap, and importing GitHub/catalog JSON through `corsFetch`, are bounded by the same web reader but untested in a browser.
- Rate/concurrency defaults are guesses, not tuned against real sources.

## Stage 6.6 (partial) — read-timeout classification fix

Two real defects were found by tracing the read-timeout path (broker -> gateway -> RuntimeEngine -> IPC):

1. `BoundedStreams.Body.read` mapped only `java.net.SocketTimeoutException` to `TIMEOUT`. okio/OkHttp's `AsyncTimeout` raises
   `InterruptedIOException("timeout")`, which fell through to `IO_ERROR`. It now uses `BrokerEngine.isTimeout`, the same classifier
   as `mapIo`. Regression tests in `Stage6SelfTest` (JVM, run): timeout -> `TIMEOUT`; a user cancel that surfaces the same
   exception stays `CANCELLED`. The first test was confirmed to FAIL with the old code and PASS with the fix.
2. `RuntimeEngine.sourceFailure` treated every `InterruptedIOException` as a cancel before looking at error codes, but
   `SocketTimeoutException` is a subclass of it, so a raw read timeout would reach IPC as `CANCELLED`. It now treats only
   `CancelledException`/`InterruptedException` as an immediate cancel, maps timeout-shaped I/O to `TIMEOUT`, and falls back to
   `CANCELLED` for other `InterruptedIOException`. **This Kotlin change is NOT compiled or run** (no Kotlin toolchain available);
   it needs a `RuntimeEngineTest` case when Gradle is available.

Stage 6.6 as a whole is NOT complete: see the status flags (all unchanged).

## Stage 6.6A — resource controls under a real 1.6.0 Source (JVM, run)
`HostRuntime16Test` (see `MIHON_STAGE6_6_HOST_RUNTIME.md`) drives the controls through a Source compiled against upstream 1.6.0.
That Source runs in the production loader topology over real TLS, and each failure keeps its own code:
- read timeout → `TIMEOUT` (server delays 5 s, `newBuilder().readTimeout(1 s)`; fails in about 1-2 s);
- host cancel → `CANCELLED` within 3 s, and `activeCalls` returns to 0;
- Source-side `withTimeout` cancels the brokered call (`Call.await` cancels the OkHttp `Call`), and the slot is released;
- `RATE_LIMITED`, `CONCURRENCY_LIMIT` and `RESPONSE_TOO_LARGE` each come from a dedicated governor or limit configuration.
Still not run: `RuntimeEngine.sourceFailure` (Kotlin in `:mihon`), IPC and device. See the 6.6A doc for the main-build result.
