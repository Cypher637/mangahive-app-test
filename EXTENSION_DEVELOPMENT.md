# Developing a MangaHive extension

The contract is in `EXTENSION_API.md`. This page is the short workflow.

1. Write a `manifest.json` that follows `extensions/schemas/manifest.schema.json`.
   A working example is in `extensions/examples/community-test-extension/manifest.json`.
2. Use a lowercase, namespaced `id` (for example `community.example`). The
   `mangahive.*` prefix is reserved for first-party extensions.
3. Declare `apiVersion: 1`, a SemVer `version`, only the permissions you need,
   and each source's capabilities and engine. Engines are declarative; the app
   never runs arbitrary extension JavaScript.
4. Host the manifest over HTTPS, or list it in a repository index
   (see `extensions/examples/repository-index.example.json`).
5. In the app, open Sources and add the manifest or repository URL.

Mihon/Tachiyomi repositories are catalogued only. See `MIHON_COMPATIBILITY.md`.

## Checking your work

```bash
node extension_registry_regression_test.js
node extension_hardening_regression_test.js
node extension_open_platform_regression_test.js
```
