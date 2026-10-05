# Phase 0 Authorization Matrix

Identity source: `auth.uid()` only. Client-supplied user ids are never trusted for authorization.

| Table | SELECT | INSERT | UPDATE | DELETE | Immutable fields | Notes |
|-------|--------|--------|--------|--------|------------------|-------|
| profiles | self always; `public` → any auth; `friends` → accepted friendship; else owner only | self only (`id = auth.uid()`) | self only | — | id | Privacy enforced via `can_view_profile()` |
| follows | follower or following | follower = self | — | follower = self | — | |
| friend_requests | requester or addressee | requester = self | involved parties; **trigger** freezes ids & status machine | involved | **requester_id, addressee_id** | pending→accepted/rejected by addressee; pending→cancelled by requester |
| blocks | blocker = self | blocker = self | — | blocker = self | — | |
| posts | authenticated (feed) | author = self | author = self | author = self | user_id | Refine with privacy later |
| post_likes | authenticated | user = self | — | user = self | — | |
| post_comments | authenticated | user = self | — | user = self | — | |
| chapter_comments | authenticated | user = self | — | user = self | — | |
| conversations | participants only | any auth (then must add self first) | — | — | — | |
| conversation_participants | participants of same conv | **first row = self on empty conv**; else **existing participant may invite** | — | self leave | — | **No arbitrary self-join** |
| messages | participants | self + participant | — | — | user_id | |
| message_reactions | participants | self + **must be participant of message's conversation** | — | self | — | |
| notifications | recipient = self | system/service | self (read_at) | — | user_id | |
| reports | reporter = self | reporter = self | — (mods later) | — | reporter_id | status not client-writable to resolved |
| rate_limit_buckets | **none** (RLS deny all) | via `check_rate_limit` RPC only | via RPC | — | — | SECURITY DEFINER |

## Adversarial guarantees

| Attack | Expected |
|--------|----------|
| User B INSERT into A's conversation_participants as self | DENY |
| User B SELECT A's private messages | DENY |
| User B INSERT message into A's conversation | DENY |
| User B INSERT reaction on message in A's conversation | DENY |
| User A UPDATE friend_requests.requester_id | DENY (trigger) |
| User B UPDATE friend_requests.requester_id | DENY |
| User C UPDATE A's pending request status | DENY |
| User B SELECT A's privacy=private profile | DENY |
