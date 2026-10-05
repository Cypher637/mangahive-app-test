# MangaHive — Source matrix

Canonical series identity: **source + remote_id** (+ title/cover). Never title-only for cross-device share.

## Reader-capable (in-app pages)

| id | Name | Search | Chapters | Pages | Notes |
|----|------|--------|----------|-------|-------|
| mangadex | MangaDex | yes | yes | yes | Official API; covers may need proxy |
| comick | ComicK | yes | yes | yes | Public API base configurable |
| mangpi | Mangpi | yes | yes | yes | Needs self-hosted server URL |
| mangahook | MangaHook | yes | yes | yes | Needs self-hosted server URL |
| github | GitHub | — | local | local | User library path |

Routing uses **`source.capabilities.reader`** / `isReaderSourceType()`, not ad-hoc name lists.

## Metadata-only (not in-app reader)

| id | Name | Purpose |
|----|------|---------|
| anilist | AniList | Search, covers, genres; import resolves to a reader source |
| jikan | MAL / Jikan | Same |
| kitsu | Kitsu | Same |

These never appear as preferred *reader* sources.

## Health

`markSourceHealth` tracks healthy / degraded / offline with cooldown after consecutive failures.  
Library refresh **never** replaces a known chapter list with empty data on failure.

## Config (Settings / state)

- `mangpiBaseUrl`, `mangahookBaseUrl`, `mangadexProxyUrl`, `comickApiBase`
- Optional user CORS proxy URL

## Environment

No required env vars for core reader sources beyond optional self-hosted bases and proxies.
