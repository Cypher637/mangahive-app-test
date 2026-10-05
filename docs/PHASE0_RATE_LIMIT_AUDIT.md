# Phase 0 Rate Limit Audit

## Architecture

```
UI → Application Service / RPC → require_rate_limit(op) → policy CASE → rate_limit_buckets → mutation
```

- Client may only pass **operation name**.
- Limit, window, and cost are **server-defined** in `check_rate_limit(p_operation text)`.
- Failure of the rate-limit decision **fails closed** for sensitive RPCs (`require_rate_limit` raises).
- JS service layer mirrors fail-closed behavior.

## Policy map (server)

| Operation | Limit | Window (s) | Key |
|-----------|-------|------------|-----|
| friend_request | 20 | 60 | op:userId |
| accept_friend_request | 30 | 60 | op:userId |
| follow | 40 | 60 | op:userId |
| block | 30 | 60 | op:userId |
| send_message | 60 | 60 | op:userId |
| message_reaction | 60 | 60 | op:userId |
| report | 15 | 60 | op:userId |
| post_create | 20 | 60 | op:userId |
| post_comment | 30 | 60 | op:userId |
| chapter_comment | 30 | 60 | op:userId |
| conversation_create | 20 | 60 | op:userId |
| group_member_add | 30 | 60 | op:userId |
| search | 60 | 60 | op:userId |
| (unknown) | 30 | 60 | op:userId |

## Operation enforcement

| Operation | Entry | Service / RPC | Auth | Rate limit | Direct table bypass |
|-----------|-------|---------------|------|------------|---------------------|
| Send friend request | UI | `send_friend_request` RPC | session | friend_request | Prefer RPC; RLS still applies |
| Accept friend request | UI | `accept_friend_request` RPC | addressee | accept_friend_request | Trigger freezes IDs |
| Toggle follow | UI | `toggle_follow` RPC | session | follow | |
| Block user | UI | `block_user` RPC | session | block | |
| DM conversation | UI | `get_or_create_direct_conversation` | session | conversation_create | Creator + participants set in RPC |
| Group create | UI | `create_group_conversation` | session | conversation_create | |
| Add group member | UI | `add_group_member` | **creator only** | group_member_add | |
| Message reaction | UI | `toggle_message_reaction` | participant | message_reaction | |
| Chapter comment | UI | `sync_chapter_comment` | session | chapter_comment | |
| Search profiles | UI | `search_profiles` | session | search | public only |

## Bypass protections

| Attack | Protection |
|--------|------------|
| Client passes limit=1e6 | Not accepted — single-arg RPC only |
| Client passes cost=0 | Not accepted |
| Call check_rate_limit with fake user | Key uses auth.uid() only |
| Skip JS service, call table insert | RLS + prefer RPCs; some legacy `.from()` selects remain |
| RPC unavailable | require_rate_limit raises; JS fail-closed rejects |

## Residual risk

Some UI paths still use `.from()` for **reads** and a few deletes (e.g. leave conversation, cancel request via delete). Mutations that create social graph edges or messages should go through RPCs listed above after migration deploy.
