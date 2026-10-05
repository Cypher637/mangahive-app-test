# API Conventions — Phase 0

## Principles

- Request and response shapes should be predictable.
- Errors must be typed and safe.
- Privileged operations are server-authoritative.
- Clients consume stable contracts, not raw database rows, wherever practical.

## Standard Error Shape (target)

```json
{
  "code": "VALIDATION_ERROR | AUTHENTICATION_ERROR | AUTHORIZATION_ERROR | NOT_FOUND | CONFLICT | RATE_LIMITED | EXTERNAL_SOURCE_ERROR | NETWORK_ERROR | INTERNAL_ERROR",
  "message": "Human-readable summary",
  "details": {},
  "requestId": "optional correlation id"
}
```

Never expose:

- Stack traces
- Database internals
- Secrets or tokens
- Internal infrastructure details

## Authentication

All mutating endpoints require a valid authenticated session.  
Identity is taken from the session, never from a body field named `user_id`.

## Authorization

Every sensitive operation performs its own permission check.  
UI visibility is not authorization.

## Pagination

Where lists can grow (posts, messages, search results, library), use consistent cursor or offset pagination. Avoid unbounded selects.

## Versioning

Prefer additive changes. Breaking changes require a new contract version or explicit migration path.

## Existing Supabase Usage

Current client code talks directly to Supabase tables. Phase 0 does not require an immediate rewrite to a custom REST/GraphQL layer, but all new code and any refactors must:

1. Treat the session user as the only trusted identity source.
2. Rely on RLS (or server functions) for authorization.
3. Avoid returning more data than the caller is allowed to see.
