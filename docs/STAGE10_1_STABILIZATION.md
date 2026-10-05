# Stage 10.1 — Download & Offline Runtime Stabilization

This build applies the complete Stage 10 audit stabilization set.

## Fixed

- Download jobs are keyed by canonical manga + canonical chapter + extension + source + remote chapter.
- Completed page storage is source-qualified and validated against the same five-part identity.
- Automatic source fallback is strictly opt-in; the default remains off.
- Legacy fallback resolver now obeys the same opt-in setting.
- If a browser download actually succeeds through an alternate source, job ownership is migrated to that actual source identity and the stale primary job is removed.
- Mihon-backed downloads execute through the native runtime and broker instead of browser `fetch`.
- Native Mihon downloads receive the configured storage quota and automatic-cleanup policy.
- Native offline jobs have durable state and startup recovery.
- Native page acquisition has bounded per-page retry/backoff and cancellation handling.
- Native offline manifests now contain verified image dimensions; malformed zero-dimension manifests are rejected.
- Browser native-manifest validation requires positive, bounded dimensions.
- Offline reader selection validates the manifest identity before serving pages.
- Offline NSFW/age policy is re-evaluated when a downloaded chapter is opened.
- Browser storage quota, app-owned storage limits, and cleanup are checked before page persistence.
- Browser page responses remain stream-bounded and reject oversized/non-image responses.

## Verification

Passed:

- Stage 10 download regression
- Stage 9 canonical regression
- runtime-boundary regression
- production-security regression
- extension hardening regression
- extension open-platform regression
- extension registry regression
- Stage 8 source-runtime regression
- Mihon compatibility regression suite except the pre-existing typed-operation expectation noted below
- Stage 10.1 stabilization regression
- inline JavaScript syntax check

The repository's older Mihon compatibility test still reports two pre-existing contract expectations: it expects exactly 12 operations/classes and rejects the current cancel/health control additions. Those expectations were not changed as part of Stage 10.1 because doing so would weaken the current cancellation/health IPC contract.

Android Gradle/device execution remains unverified because the required Gradle distribution/device environment is not available in this workspace. No Android runtime verification flag is marked green on that basis.
