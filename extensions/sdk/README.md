# MangaHive Extension SDK (lightweight)

This folder documents the contract. There is no privileged compiler.

1. Author a `manifest.json` per `EXTENSION_API.md`
2. Validate IDs (lowercase), SemVer, permissions, engine type
3. Host over HTTPS or ship via repository index
4. Install in the app — core discovers sources dynamically

Package format `.mhex` is reserved for a future declarative archive (manifest + static assets only).
