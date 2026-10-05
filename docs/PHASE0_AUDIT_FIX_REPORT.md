# MANGAHIVE — PHASE 0 AUDIT FIX REPORT

**Date:** 2026-10-04  
**Baseline:** Stage 10.1 Stabilized + Phase 0 foundation docs  
**Scope:** Audit fix pass only (no Phase 1 features)

---

## 1. Original findings → fixes

| # | Finding | Root cause | Fix |
|---|---------|------------|-----|
| 1 | DB/RLS not auditable in repo | Schema lived only on remote Supabase | Added `supabase/migrations/` with core schema + RLS policies for tables the client already uses |
| 2 | Shared contracts missing | No contract layer | Added `contracts/ids.js`, `errors.js`, `rate_limit.js`, `config.js` |
| 3 | Centralized rate limiting | Only extension/network governors | Added `RateLimitService` contract + default policies (server-authoritative interface; in-memory ref impl for tests) |
| 4 | Phase 0 invariant tests | Missing | Added `tests/phase0/invariants_test.js` (27 assertions, all pass) |
| 5 | Request-ID regression | `RuntimeEngine` used `UUID.randomUUID()` for offline recovery | Replaced with deterministic internal `job-…` id; external request ids remain boundary-only. Stage 6 test now PASS |
| 6 | Mihon Op enum count | Stage 4 test expected 12 ops; Stage 10 added download/deleteDownload | Updated test to assert Stage 10 allowlist + `isSourceOp` split (14 ops). Stage 4 test now PASS |
| 7 | Config/env separation | Hard-coded client constants | Added config classification module (PUBLIC vs SECRET); documented anon key is public by design |
| 8–9 | Architectural / API boundaries | Monolithic PWA | Established contracts + migrations + docs; no mass rewrite of `index.html` (preserves working behaviour) |
| 10 | User/Profile | Auth UID already used as profile id | Documented: `auth.users` → `profiles.id = auth.uid()`; no duplicate password storage |
| 11 | DB integrity | Missing in-repo constraints | Migration adds PKs, FKs, UNIQUEs, CHECKs for social tables |
| 12–13 | Storage/network boundaries | Already strong in Stage 10 | Preserved; regression suites re-run PASS |
| 14–16 | Error model / logging / audit | Informal | Standard error codes + safe stripping of secrets in `contracts/errors.js` |
| 17 | Test suite reconciliation | Two failures | Both fixed; full suite green |
| 23 | Android build | No Gradle 8.5 in environment | **Documented blocker** — not claimed verified |
| 24 | PWA build | Static single-file app | No bundler step required; Node regression suite is the verification gate used |
| 25 | Static secret scan | — | No service_role assignment in client; only a warning comment remains |

---

## 2. Files / modules changed

**New**
- `supabase/migrations/20261004000000_phase0_core_schema.sql`
- `supabase/migrations/20261004000001_phase0_rls_policies.sql`
- `contracts/ids.js`
- `contracts/errors.js`
- `contracts/rate_limit.js`
- `contracts/config.js`
- `tests/phase0/invariants_test.js`
- `docs/PHASE0_AUDIT_FIX_REPORT.md` (this file)

**Modified**
- `mihon_stage4_isolation_test.js` — Stage 10 Op allowlist + source/control split
- `android/mihon/.../RuntimeEngine.kt` — internal job id for offline recovery (no UUID request-id mint)

**Preserved**
- All Stage 9/10 download, canonical identity, extension, Mihon, and PWA behaviour

---

## 3. Database / RLS

- Migrations define profiles, follows, friend_requests, blocks, posts, likes, comments, conversations, messages, reactions, notifications, reports.
- RLS enabled; policies derive identity from `auth.uid()`.
- Intentional `USING (true)` only on authenticated public feed tables (posts/comments likes) — documented.
- Library/progress/downloads remain primarily client-local (Stage 10 design); server sync tables deferred until needed (documented in migration comments).

**Limitation:** Policies are not executed against a live Postgres in this environment. They are reproducible SQL ready to apply.

---

## 4. Contracts

- Canonical vs external ID separation encoded in `contracts/ids.js`
- Download identity requires source binding
- Error model with safe detail stripping
- Rate limit interface independent of vendor

---

## 5. Tests executed (all PASS)

- `tests/phase0/invariants_test.js` (27)
- `production_security_regression_test.js`
- `phase9_canonical_regression_test.js`
- `phase10_download_regression_test.js`
- `stage10_1_stabilization_regression_test.js`
- `source_registry_regression_test.js`
- `mihon_stage4_isolation_test.js` (was FAIL → PASS)
- `mihon_stage6_resource_controls_test.js` (was FAIL → PASS)
- `mihon_runtime_boundary_test.js`
- `extension_hardening_regression_test.js`
- `extension_registry_regression_test.js`
- `extension_platform_regression_test.js`
- `ux_audit_regression_test.js`
- `stage8_source_runtime_regression_test.js`
- `mihon_compatibility_regression_test.js`

---

## 6. Build results

| Target | Result |
|--------|--------|
| Node regression suite | PASS |
| Phase 0 invariants | PASS |
| Android Gradle compile | **NOT VERIFIED** — Gradle 8.5 / full dependency environment unavailable |
| PWA bundler | N/A (single-file static app); security + regression gates used |

---

## 7. Security audit (static)

- No `service_role` key assignment in `index.html` or `sw.js`
- Anon key remains public (Supabase design); classified as PUBLIC in config module
- No `eval` / `new Function` in production paths (existing regressions)
- Extension network isolation regressions PASS
- Request IDs minted only at IPC boundary (Stage 6 PASS)

---

## 8. Remaining limitations (honest)

1. **Live RLS execution** — migrations are reproducible but not applied/tested against a running Postgres in this sandbox.
2. **Android build** — environment blocker (Gradle distribution).
3. **Server-side rate limiting enforcement** — contract + in-memory reference exist; production shared store wiring is deployment work.
4. **Monolithic `index.html`** — still contains most UI + domain logic; contracts are the boundary layer, not a full modular rewrite.
5. **Hard-coded Supabase URL/anon in `index.html`** — still present for backward compatibility; config module provides the injection path for future builds.

---

## 9. Phase 0 freeze gate checklist

| Criterion | Status |
|-----------|--------|
| 1. DB migrations reproducible | PASS |
| 2. RLS executable & tested | PARTIAL (SQL present; live DB not exercised here) |
| 3. Canonical IDs source-independent | PASS |
| 4. External IDs source-scoped | PASS |
| 5. Shared contracts exist | PASS |
| 6. Sensitive ops server-authoritative | PARTIAL (RLS + session; full API layer not extracted from monolith) |
| 7. Authorization tested | PARTIAL (structural + policy SQL; no multi-user live RLS test runner) |
| 8. Central rate limiting exists | PASS (contract + ref impl) |
| 9. Security invariants tested | PASS |
| 10. Existing regressions pass | PASS |
| 11. Request-ID semantics resolved | PASS |
| 12. Mihon operation allowlisting resolved | PASS |
| 13. Configuration boundaries established | PASS (module + classification) |
| 14. No secrets exposed | PASS |
| 15. Android build verified | FAIL / documented blocker |
| 16. PWA production build | PASS (static + regressions) |
| 17. Documentation matches implementation | PASS |
| 18. Existing functionality operational | PASS |
| 19. No critical security findings | PASS |
| 20. No major architectural blockers | PARTIAL (live RLS + Android remain) |

---

## 10. Final status

**PHASE 0 — NOT READY**

### Why not READY TO FREEZE

Two freeze-gate items remain open:

1. Live RLS verification against a real database (policies written, not executed here).
2. Android Gradle build verification (environment blocker).

Everything else required for a safe Phase 1 foundation is in place: migrations, contracts, rate-limit architecture, invariant tests, fixed regressions, and documentation.

### What unblocks READY TO FREEZE

1. Apply `supabase/migrations/*` to a test project and run multi-user RLS scenarios (User A cannot read/mutate User B data).
2. Provide Gradle 8.5 (or confirm wrapper download) and complete Android module compile.

Until those two are done, Phase 0 must stay **NOT READY**.
