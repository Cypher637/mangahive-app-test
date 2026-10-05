# Downloads

## User-facing states

- Not downloaded
- Queued
- Resolving
- Downloading
- Paused
- Downloaded
- Failed

## Actions

- Download
- Pause
- Resume
- Cancel
- Retry
- Delete
- Redownload

Duplicate active jobs for the same canonical chapter/source binding are rejected.

## Failure classes

`NETWORK`, `TIMEOUT`, `SOURCE_UNAVAILABLE`, `IMAGE_INVALID`, `TOO_LARGE`, `STORAGE`, `POLICY_BLOCKED`, `CANCELLED`, and `UNKNOWN` are kept distinct so retry behavior can remain bounded.
