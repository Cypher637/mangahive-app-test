# MangaHive

Single-file manga reader PWA with optional Android shell and Mihon catalog support.

## Phase 0 foundation

- `docs/PHASE0_AUDIT_FIX_REPORT.md` — audit fix status
- `supabase/migrations/` — schema + RLS
- `contracts/` — shared IDs, errors, rate limit, config
- `tests/phase0/` — invariant tests

## Run (web)

Serve this folder over HTTPS (or local static server):

- `index.html` — app
- `sw.js`, `manifest.json`, icons — PWA
- `vendor-supabase.js` — bundled Supabase client (required)

```bash
npx serve .
```

## Android APK

See `HOW_TO_GET_AN_APK.md`. Open the `android/` folder in Android Studio after copying web assets into `android/app/src/main/assets/`. The copy must include the `src/` folder (Phase 1 domain/service modules loaded by `index.html`) and `config/`, not just `index.html`; there is no build step that does this automatically, so a stale or partial copy will break the app at startup.
The launcher icon is already set up in `android/app/src/main/res/` (generated from `icon-maskable-512.png`).

## Sources

Built-in readers: MangaDex, ComicK (and optional self-hosted Mangpi/MangaHook).  
Details: `SOURCES.md`.

## Tests

```bash
node production_security_regression_test.js
node ux_audit_regression_test.js
node source_registry_regression_test.js
```
