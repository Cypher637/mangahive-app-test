# Authorization Model — Phase 0

## Hard Rule

**The client is never the final authority for security-sensitive state.**

Every sensitive mutation must:

1. Authenticate the session
2. Derive the acting user from the session (never from a client-supplied user_id)
3. Authorize the action
4. Perform the mutation
5. Return the result

## Roles (conceptual)

| Role                | Capabilities                                      |
|---------------------|---------------------------------------------------|
| PUBLIC              | Read public data only                             |
| AUTHENTICATED USER  | Act on own resources, create social content       |
| RESOURCE OWNER      | Full control of own library, progress, downloads, posts |
| MODERATOR           | Handle reports, remove content (future)           |
| ADMIN / SYSTEM      | Configuration, extension trust, account status    |

## Derivation of Identity

```js
// CORRECT
const userId = session.user.id;           // from authenticated session

// FORBIDDEN for authorization
const userId = request.body.user_id;      // client-supplied
const isAdmin = request.body.isAdmin;     // client-supplied
```

## Existing Tables That Require This Discipline

From Stage 10.1 client code the following tables are already touched:

- `profiles`
- `posts`, `post_likes`, `post_comments`
- `friend_requests`, `follows`
- `blocks`
- `reports`
- `notifications`
- `conversations`, `conversation_participants`, `messages`, `message_reactions`
- `chapter_comments`

For each of these, RLS (or equivalent server checks) must enforce:

- A user can only insert rows that belong to themselves.
- A user can only update/delete their own rows (unless moderator).
- Private data is not readable by arbitrary authenticated users.

## Privacy Levels (architectural preparation)

Future privacy settings must be able to express:

- public
- friends
- followers
- private
- hidden

Phase 0 does not implement the full privacy UI; it only requires that the data model and authorization checks can support these distinctions later without a rewrite.

## Blocking

`Block` is a first-class relationship:

```
blocker_id → blocked_id
```

Authorization and visibility checks for profiles, comments, messages, follows, and notifications must eventually consult the block list. Phase 0 establishes the contract; full enforcement can be completed in later social phases.

## Reports

Generic report shape:

- reporter_id (from session)
- target_type + target_id
- reason
- status
- timestamps
- moderation metadata

Client cannot set status to “resolved” or assign moderators.
