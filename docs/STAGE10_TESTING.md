# Stage 10 Testing

The Phase 10 static/regression suite checks:

- versioned IndexedDB stores
- persistent jobs
- pause/resume
- manifest creation/validation
- page size/count limits
- storage-limit handling
- source identity recording
- offline policy hooks
- service-worker cache boundaries
- absence of `eval` and `new Function`

Existing Stage 7/8/9 suites must also remain green.

Android Gradle/device instrumentation is reported separately as `UNVERIFIED` when Gradle 8.5 or an Android device/emulator is unavailable.
