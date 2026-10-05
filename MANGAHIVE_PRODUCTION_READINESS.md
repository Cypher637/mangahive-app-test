# MangaHive production readiness

A plain status list. "Open" means not done yet.

## Done

- Content-Security-Policy is set, and extension code is never run with
  `eval` or `new Function` (checked by `production_security_regression_test.js`).
- Extension IDs and permissions are validated; reserved namespaces are enforced.
- The Android APK downloader enforces HTTPS, a size limit and a SHA-256 check.
- The native bridge rejects unknown operations.
- Interface pass: accessible names for controls and fields, switch semantics on
  toggles, dialog semantics with Escape to close and focus return, visible
  keyboard focus, larger touch targets, and text contrast checked on the dark and
  light themes.

## Open

- **Mihon source execution on a real device is not verified.** The code is in
  place, but `SOURCE_EXECUTION_DEVICE_VERIFIED` is `false` until it is run on
  hardware.
- **The CSP still allows `'unsafe-inline'`** because the app's scripts and styles
  are inline in `index.html`. Moving them into separate files would let that be removed.
- **Sign-in needs a Google OAuth Client ID** (`GOOGLE_CLIENT_ID` in `index.html`)
  and a configured Supabase project.

## Before each release

- Run every `*_test.js` file in this folder.
- Bump the cache name in `sw.js` so installed copies fetch the new `index.html`.
