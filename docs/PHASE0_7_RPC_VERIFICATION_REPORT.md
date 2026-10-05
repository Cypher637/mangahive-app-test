# Phase 0.7 — Final RPC verification closure (code-side only)

**Status: PHASE 0 CODE-SIDE CLOSURE: READY.** Not frozen — live Supabase and real Android build evidence are still required.

## What changed
| Area | Change |
|---|---|
| `tests/phase0/lib/pg_state.js` | Deterministic final-state reconstruction: CREATE / CREATE OR REPLACE / ALTER / DROP FUNCTION, GRANT / REVOKE EXECUTE (explicit, name-only, ALL FUNCTIONS), the 0.4 `DO` ACL loop, overloads, history of every signature. Reproduces PostgreSQL migration-failure rules (42P13 rename / return-type change, duplicate create, missing target). Unknown DDL/DO blocks are reported, never skipped. |
| `tests/phase0/lib/frontend_rpc_scan.js` | Finds literal, ternary-resolved dynamic and wrapper-based RPC usage, with argument keys; anything unresolvable fails with `file:line`. |
| `tests/phase0/lib/rpc_verifier.js` | Pure verifier over catalog + privileges + migrations + frontend sources. |
| `tests/phase0/rpc_final_signature_test.js` | Rewritten: authoritative, per-RPC verdicts; fails on incomplete catalog entries. |
| `tests/phase0/rpc_verifier_selftest_test.js` | New: 38 checks proving the verifier fails for each negative case (in-memory mutations only; nothing to clean up). |
| `contracts/rpc_catalog.json` | All 39 RPCs now carry exact `arg_types`, `signature`, `returns`, `security_definer`, `auth_enforcement`, `client_callable`, `rate_limit`. New sections: `internal_helpers` (exact), `rls_predicates`, `trigger_functions`, `obsolete_signatures`. |
| `contracts/rpc_execute_privileges.json` | Explicit `platform_baseline` (Supabase default function grantees) and `rls_predicates` policy. |
| `supabase/migrations/20261004030000_…` | Added `DROP FUNCTION IF EXISTS public.block_user(uuid)` before the renaming `CREATE OR REPLACE` (it failed with 42P13 on PostgreSQL). |
| `supabase/migrations/20261004090000_phase0_7_execute_acl_closure.sql` | New, REVOKE-only: `anon` removed from 38 authenticated-only RPCs; PUBLIC/anon removed from 3 RLS predicates. `app_schema_version()` PUBLIC exception untouched. |

## Defects the authoritative verifier found
1. **Migration 0.3 would abort on PostgreSQL** (`block_user` parameter rename, 42P13). Fixed.
2. **Catalog disagreed with the SQL** (metadata only; SQL unchanged):
   `accept_friend_request` rate_limit null → `accept_friend_request`; `check_rate_limit` read_only → mutation (it upserts `rate_limit_buckets`);
   `toggle_message_reaction` / `sync_chapter_comment` `required` omitted `p_kind` / `p_client_id`;
   `accept_message_request` / `decline_message_request` mutation → read_only (their bodies change no state).
3. **anon kept EXECUTE** on every authenticated-only RPC under Supabase default privileges (REVOKE FROM PUBLIC does not remove it); `is_name_available` has no body guard. Fixed by 0.7 migration.
4. **PUBLIC EXECUTE on 3 RLS predicates** (`is_conversation_participant`, `can_view_profile`, `can_manage_participants`). Fixed by 0.7 migration.

## Open items for the owner (not changed — outside this phase's scope)
- **[RESOLVED in Phase 0.8 — see PHASE0_8_ROOM_RLS_EXECUTION_CLOSURE.md] ADVISORY — likely runtime defect:** `room_messages` SELECT policy `room_msg_select` (0.3) calls `room_is_accessible()`, but 0.5 revoked EXECUTE on it from `authenticated`. Policy expressions run as the caller, so a direct `SELECT` on `room_messages` should fail with `permission denied for function room_is_accessible`. The verifier prints this as a non-failing ADVISORY because "internal helper protection" was declared out of scope. Decide: re-grant `authenticated` and document it as an RLS predicate, or inline the EXISTS in the policy.
- `accept_message_request` / `decline_message_request` are no-op stubs (validate membership, return `{ok:true}`).
- `app_schema_version()` returns text `'phase0.5'`; the frontend only flags "outdated" when it receives a number, so the schema banner can never show.
- Supabase's default-privilege baseline is an assumption encoded in `platform_baseline`; confirm on a live project.

## External freeze gates (NOT done here)
Live Supabase: apply all migrations in order, run `supabase/tests/rls_adversarial.sql`, compare `pg_proc` / `has_function_privilege` against the catalog. Real Android build. Neither was executed.
