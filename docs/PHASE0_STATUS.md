# Phase 0 Status Report

**Date:** 2026-10-03  
**Baseline codebase:** MangaHive Stage 10.1 Stabilized

## What existed before this Phase 0 work

- Single-file PWA with rich reader, library, downloads, and partial social features
- Canonical manga/chapter identity and source bindings (Stage 9)
- Source-qualified, integrity-checked downloads with Android native store (Stage 10 / 10.1)
- Manifest-based extension system with controlled engines
- Android network broker with strong isolation
- Supabase Auth + several social tables already in use
- Extensive regression test suite for stages 8–10

## What was added in this Phase 0 pass

### Documentation (new)

| Path | Purpose |
|------|---------|
| `docs/architecture/OVERVIEW.md` | System shape and layer boundaries |
| `docs/architecture/DOMAIN_MODEL.md` | Canonical entities, ownership, lifecycle |
| `docs/architecture/IDENTITY.md` | Canonical vs external ID rules |
| `docs/architecture/SOURCE_AND_EXTENSION.md` | SourceAdapter / Extension boundaries |
| `docs/security/THREAT_MODEL.md` | 15-threat model with mitigations |
| `docs/security/AUTHORIZATION.md` | Server-authoritative rules, roles, privacy |
| `docs/api/CONVENTIONS.md` | Error shape, authn/z, pagination |
| `docs/database/INTEGRITY.md` | Constraints, cascades, RLS expectations |
| `docs/PHASE0_STATUS.md` | This report |

These documents formalize the architecture that Stage 9/10 already partially implemented and make the Phase 0 contracts explicit for all future work.

## What was intentionally NOT changed

- No rewrite of the monolithic `index.html`
- No breaking changes to download identity or Mihon compatibility
- No new social features or Phase 1+ product work
- No removal of existing working functionality
- No claim that live Supabase RLS has been re-audited (requires project access)

## Remaining work before Phase 0 can be marked COMPLETE

1. **Live RLS audit** on the Supabase project for every table touched by the client.
2. **Verification** that every sensitive mutation derives user identity only from the session (code audit of the large `index.html` social paths).
3. **Configuration hygiene** — move hard-coded Supabase URL/anon key behind a clear build-time or runtime config boundary (without breaking the current deployment).
4. **Shared contract extraction** (longer-term) so Android and web share typed domain IDs and DTOs.
5. **Rate-limiting architecture** — currently not centralized.
6. **Automated tests** that explicitly assert the Phase 0 invariants (canonical ID separation, ownership checks, binding isolation).

## Status

**PHASE 0 — NOT READY** for the “COMPLETE” label.

The architectural foundation documents are now in place and aligned with the existing Stage 9/10 design.  
The remaining items above are required before the freeze.

## Next recommended actions

1. Audit Supabase RLS policies against `docs/database/INTEGRITY.md` and `docs/security/AUTHORIZATION.md`.
2. Grep the client for client-supplied `user_id` used in authorization decisions and fix any violations.
3. Add a small set of regression tests that lock the canonical-identity and ownership invariants.
4. Only after the above: mark Phase 0 COMPLETE and move to Phase 1.
