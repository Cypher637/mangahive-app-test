# Phase 0.8 — room_messages RLS execution closure (code-side)

**Status: PHASE 0 CODE-SIDE CLOSURE: COMPLETE.** Not frozen. Live Supabase/Postgres adversarial verification and a real Android build remain external freeze gates. Phase 1 not started.

## Defect
`room_msg_select` (0.3) was `USING (public.room_is_accessible(room_id))`. PostgreSQL checks EXECUTE on a function called from a policy expression against the **caller** (`authenticated`); SECURITY DEFINER only changes who the function *body* runs as. Phase 0.5 correctly revoked EXECUTE on the helper from PUBLIC/anon/authenticated, so every authenticated `SELECT` on `room_messages` (and Realtime `postgres_changes`, which evaluates the same policy) would fail with `permission denied for function room_is_accessible`.

## Decision: inline the predicate, do not grant
A grant to `authenticated` was evaluated and rejected: `room_is_accessible` lives in schema `public`, which PostgREST exposes, so any grant makes it callable as `POST /rest/v1/rpc/room_is_accessible` / `supabase.rpc()`. That contradicts `client_callable=false`. The alternative the brief permits — inlining — meets every stated condition:

| Condition | Result |
|---|---|
| Authorization equivalent | Policy = `EXISTS(rooms r WHERE r.id = room_messages.room_id AND status='active' AND visibility='public')` — the helper's exact predicate. The subquery also runs under `rooms_select` (identical predicate, `TO authenticated`), which can only restrict. |
| No client bypass | No new function/RPC. Helper ACL unchanged (PUBLIC/anon/authenticated all revoked). |
| No PUBLIC/anon EXECUTE | None introduced. anon holds no privilege on `rooms`. |
| Verifier reflects final design | Yes — see below. |

The helper stays SECURITY DEFINER with pinned `search_path`; `send/edit/delete_room_message` (SECURITY DEFINER, run as owner) still gate through it.

## Changes
- `supabase/migrations/20261004100000_phase0_8_room_rls_execution_closure.sql` (new, last): explicit `rooms` table privileges (`authenticated`: SELECT only; anon/PUBLIC none), `room_msg_select` recreated without a function call, helper ACL re-asserted closed, comments.
- `contracts/rpc_execute_privileges.json` (v phase0.8): `rls_policy_use: "forbidden"` on internal helpers; new `rls_policy_contract` (rule + `inlined_helpers` entry with equivalence and table-privilege requirements).
- `contracts/rpc_catalog.json` (v phase0.8): `room_is_accessible` remains in `internal_helpers` (not in `rpcs`); reason updated.
- `tests/phase0/lib/rpc_verifier.js`:
  - the old non-failing RLS advisory is now **hard findings**: `RLS_POLICY_EXECUTE` (policy calls a function a policy role cannot execute) and `RLS_HELPER_IN_POLICY` (policy calls an internal helper, with or without `public.`);
  - `RLS_INLINE_CONTRACT`: inlined predicate must equal the helper body and `rooms_select`; policy must be `TO authenticated` only;
  - `RLS_TABLE_PRIVILEGE`: replays table GRANT/REVOKE for `rooms`.
- `tests/phase0/room_rls_execution_test.js` (new, 29 checks) and 17 new negative cases in `rpc_verifier_selftest_test.js` (55 total), including: 0.8 removed (old defect), grant to authenticated/anon/PUBLIC, helper re-added to a policy, weakened predicate, `rooms_select` drift, missing/extra table privilege, helper added to catalog RPCs, frontend `supabase.rpc('room_is_accessible')`.
- `tests/phase0/rpc_final_signature_test.js`: asserts and prints the required zero counters.
- `supabase/tests/rls_adversarial.sql`: room cases added for the live gate (specification only; not executed).

## Result (static)
39/39 catalog RPCs verified · 39/39 complete signatures · 54/54 frontend call sites · 0 unresolved dynamic RPCs · 0 migration replay errors · 0 unexpected client-callable functions · 0 privilege inconsistencies · 0 RLS predicate privilege contradictions (56 final policies) · 0 advisories/findings about `room_is_accessible()`. No advisory was suppressed.

## Residual / external
- Assumes Supabase default privileges (`platform_baseline`); confirm on a live project.
- Realtime evaluates `room_msg_select` as the subscriber; confirm on a live project.
- Run `supabase/tests/rls_adversarial.sql` (room section) and compare `has_function_privilege` / `has_table_privilege` with the contract.
- Real Android build not run.
