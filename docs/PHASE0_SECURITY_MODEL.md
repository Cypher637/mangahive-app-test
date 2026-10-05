# Phase 0 Security Model

## Boundaries

1. **Authentication** — Supabase Auth. Session user id is the only trusted identity.
2. **Authorization** — Postgres RLS + triggers + SECURITY DEFINER helpers. UI is not a security boundary.
3. **Extensions** — Controlled engines; Android network broker; no service_role or auth token exposure.
4. **Downloads** — User data; integrity hashed; not executable.
5. **Rate limiting** — `check_rate_limit` RPC writes to `rate_limit_buckets` (no direct client table access).

## Critical fixes in this pass

| Issue | Fix |
|-------|-----|
| Conversation self-join | `cp_insert_authorized` requires empty-conv self-first OR existing participant invite |
| Friend request ID rewrite | Trigger freezes `requester_id`/`addressee_id`; status state machine |
| Reaction without membership | INSERT requires join messages → participants → auth.uid() |
| Profile privacy | `can_view_profile()` implements public / friends / private |

## Rate limiting

- Storage: `rate_limit_buckets` (shared Postgres — works across instances)
- API: `check_rate_limit(operation, limit, window, cost)`
- Client service layer calls RPC before sensitive mutations
- Direct table access denied by RLS

## Secrets

| Item | Class |
|------|-------|
| Supabase URL | PUBLIC |
| Supabase anon key | PUBLIC (RLS protects data) |
| Supabase service_role | SECRET — never in client |
| OAuth client id | PUBLIC |
| OAuth client secret | SECRET — never in client |

## Verification status

| Control | Status |
|---------|--------|
| RLS SQL present | PASS |
| Live multi-user RLS execution | BLOCKED (no live DB in this environment) |
| Static secret scan | PASS |
| Extension isolation regressions | PASS |
| Request-id boundary | PASS |
