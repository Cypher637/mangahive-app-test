# MangaHive Extension API

**API version:** `1` (`apiVersion` / `extensionApiVersion`)  
**Manifest version:** `1` (`manifestVersion`)

This is the public contract for third-party source extensions.

## What “any extension” means

Any package that:

1. Uses a valid lowercase namespaced `id` (`^[a-z][a-z0-9._-]*$` with a dot)
2. Declares `apiVersion: 1`
3. Uses a valid SemVer 2.0 `version`
4. Lists only allowed `permissions`
5. Declares `sources[]` with safe source ids and explicit capabilities
6. Uses a **supported controlled engine** (no arbitrary JavaScript)

…can be installed without editing MangaHive core.

It does **not** mean arbitrary remote code execution.

## Reserved namespaces

| Prefix | Meaning |
|--------|---------|
| `mangahive.*` | Official / first-party only |
| `community.*` | Community extensions |
| `vendor.*` | Vendor-published extensions |

IDs are **case-sensitive and must be lowercase**. `MangaHive.evil` is rejected.

## Manifest (minimal)

```json
{
  "manifestVersion": 1,
  "id": "community.example",
  "name": "Example Source",
  "version": "1.0.0",
  "apiVersion": 1,
  "author": "Your Name",
  "description": "What this extension provides",
  "license": "MIT",
  "permissions": ["network"],
  "capabilities": ["search", "details", "chapters", "pages"],
  "contentTypes": ["manga"],
  "languages": ["en"],
  "sources": [
    {
      "id": "example",
      "name": "Example",
      "type": "manga",
      "capabilities": ["search", "details", "chapters", "pages"],
      "engine": {
        "type": "static-catalog",
        "catalog": []
      }
    }
  ],
  "signature": null,
  "signingKeyId": null
}
```

## Permissions (enforced)

| Permission | Allows |
|------------|--------|
| `network` | Controlled HTTPS requests via runtime |
| `storage` | Isolated `mangahive-ext-store:<id>` |

Not granted: native, filesystem, arbitrary-code, Supabase, auth tokens.

## Capabilities

Reader-capable sources need: `search`, `details`/`chapters`, `pages` (or `reader`).

Metadata-only: `search`, `details` — never opened as in-app reader.

## Engines (controlled)

| `engine.type` | Description |
|---------------|-------------|
| `static-catalog` | Embedded catalog in manifest (demos/tests) |
| `rest` | Declarative URL templates `{query}`, `{id}`, `{chapter}` |

Future (not executable until implemented): `graphql`, `madara`, `manga-themesia`, `custom-controlled`.

**No engine may ship executable JavaScript.**

## Installation channels

1. Official repository index  
2. Community repository index (HTTPS JSON)  
3. Direct HTTPS manifest URL  
4. (Package format reserved: `.mhex` — declarative archive, no binaries)

## Source ownership

Each `sources[].id` has exactly one owning extension. Conflicts reject install/update.

## Runtime API surface

Extensions do not receive `fetch`, Supabase, or native bridges directly.

MangaHive exposes controlled operations equivalent to:

- `search(query)`
- `getDetails(remoteId)`
- `getChapters(remoteId)`
- `getPages(seriesRemoteId, chapterRemoteId)`

with permission checks, rate limits, timeouts, and response validation.

## Signing

`signature` / `signingKeyId` / `signingAlgorithm` are reserved. Unsigned packages are **unsigned** — never labeled verified without crypto verification.
