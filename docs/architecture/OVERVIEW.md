# MangaHive Architecture Overview — Phase 0

**Status:** Phase 0 Foundation  
**Baseline:** Stage 10.1 Stabilized  
**Date:** 2026-10-03

## Goal of Phase 0

Establish the architectural, domain, security, data, API, and application foundations that every later MangaHive phase will depend upon.

This document describes the **target architecture** that the existing Stage 10.1 codebase is being aligned to. It does **not** claim that every boundary is already fully enforced in code.

## System Shape

```
                    MANGAHIVE
                       │
        ┌──────────────┼──────────────┐
        │              │              │
      WEB/PWA       ANDROID         BACKEND
        │              │           (Supabase)
        └──────────────┼──────────────┘
                       │
               SHARED CONTRACTS
                       │
     ┌─────────────────┼─────────────────┐
     │                 │                 │
   MANGA             SOCIAL           SOURCES
     │                 │                 │
  LIBRARY          COMMUNITY        EXTENSIONS
     │
 DOWNLOADS
```

## Layer Boundaries (Target)

| Layer                  | Responsibility                                      | Must not do                                      |
|------------------------|-----------------------------------------------------|--------------------------------------------------|
| Presentation           | UI, navigation, local ephemeral state               | Authorization decisions, privileged mutations    |
| Domain                 | Canonical entities, invariants, identity            | Know about HTTP, IndexedDB, or specific sources  |
| Application Services   | Use-cases, orchestration, transactions              | Direct UI or raw SQL                             |
| Data Access            | Persistence adapters (Supabase, IndexedDB, FS)      | Business rules                                   |
| External Sources       | SourceAdapters / ExtensionRuntime                   | Access private user data or auth tokens          |
| Platform Services      | Auth session, logging, config, rate limits          | Domain logic                                     |
| Security               | Authorization, RLS, threat controls                 | —                                                |

## Current Reality (Stage 10.1)

- **Web**: Large single-file PWA (`index.html`). Domain logic, UI, Supabase calls, download manager, reader, and social features live together.
- **Backend**: Supabase (Auth + Postgres + RLS). Anon key is embedded in the client.
- **Android**: WebView shell + native network broker (`mihon-net`) + offline download store. Strong isolation for extension network traffic.
- **Canonical identity**: Already present for Manga and Chapter (Stage 9). Source bindings are explicit.
- **Downloads**: Source-qualified, integrity-checked, atomic (Stage 10 / 10.1).
- **Extensions**: Manifest-driven, controlled engines only (no arbitrary JS execution).

## Non-Goals of Phase 0

- Recommendation engine, social feed, messaging UI, advanced offline reader, discovery, achievements, etc.
- Mass rewrite of the monolithic `index.html`.
- Replacing Supabase.
- Breaking existing Stage 9/10 download or Mihon compatibility behaviour.

## Evolution Rule

Existing working functionality is preserved unless it directly conflicts with the architecture defined in Phase 0 documents.

Any change must follow:

PLAN → INSPECT → IMPLEMENT → AUDIT → FIX → VERIFY → FREEZE
