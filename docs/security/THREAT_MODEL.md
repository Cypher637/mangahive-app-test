# Phase 0 Security Threat Model

**Status:** Phase 0 Foundation  
**Baseline:** Stage 10.1

## Scope

This document covers the threats that Phase 0 architecture must address or explicitly prepare for. It is not a claim that every mitigation is already fully implemented.

## Threats & Mitigations

### 1. Compromised client
- **Surface**: Browser / Android WebView under attacker control.
- **Impact**: Can send arbitrary requests, read local storage, call Supabase with the user's session.
- **Mitigation**: Server-authoritative mutations; RLS; never trust client-supplied user_id/role/ownership flags; derive identity from authenticated session.
- **Detection**: Anomalous mutation patterns, rate limits.
- **Recovery**: Session revocation, forced re-auth.

### 2. Malicious user
- **Surface**: Authenticated endpoints (posts, comments, reports, blocks, library, downloads).
- **Impact**: Spam, harassment, data pollution, storage abuse.
- **Mitigation**: Rate limiting (server-side), content policy checks, report + block model, moderation tools (later phases).
- **Detection**: Rate-limit counters, report volume.
- **Recovery**: Account status flags, content removal.

### 3. Stolen session
- **Surface**: XSS, token leakage, physical device access.
- **Impact**: Full account takeover while token is valid.
- **Mitigation**: Short-lived tokens + refresh, secure cookie / storage practices, logout/revocation support, avoid long-lived secrets in localStorage where possible.
- **Detection**: Concurrent session anomalies (future).
- **Recovery**: Password reset / session revoke.

### 4. Malicious extension
- **Surface**: Installed extension with network or storage permissions.
- **Impact**: Data exfiltration, phishing, resource exhaustion, attempt to reach private APIs.
- **Mitigation** (already partially present):
  - Controlled engines only (no arbitrary JS).
  - Explicit permission model.
  - Android network broker with destination / header / resource policies.
  - Extension storage isolated from application storage.
  - Trust state (trusted / community / quarantined).
- **Detection**: Permission misuse, anomalous network destinations.
- **Recovery**: Disable / quarantine / uninstall extension; completed downloads remain user data.

### 5. Malicious repository
- **Surface**: Extension repository serving tampered packages.
- **Impact**: Supply-chain compromise.
- **Mitigation**: Signature / hash verification (architecture prepared), pinned known-good indexes, user confirmation for community sources.
- **Detection**: Hash mismatch, unexpected permission escalation.
- **Recovery**: Revoke repository trust, force update or removal.

### 6. Compromised external source
- **Surface**: MangaDex / ComicK / self-hosted sources returning hostile content or metadata.
- **Impact**: Malicious images, tracking, phishing links in metadata.
- **Mitigation**: Content-type and size validation on pages (Stage 10), no execution of downloaded content, CSP, image decode checks.
- **Detection**: Validation failures, unexpected content types.
- **Recovery**: Mark source unhealthy, clear affected cache.

### 7. Abusive API client
- **Surface**: Direct calls to Supabase or future backend endpoints.
- **Impact**: Enumeration, scraping, DoS, cost amplification.
- **Mitigation**: RLS, rate limiting, request size limits, pagination.
- **Detection**: Rate-limit hits, unusual query patterns.
- **Recovery**: Temporary blocks, key rotation if needed.

### 8. Data leakage
- **Surface**: Overly permissive RLS, client-side over-fetching, logs.
- **Impact**: Private profiles, reading history, messages exposed.
- **Mitigation**: Strict RLS, privacy model (public / friends / private), never log tokens or private message bodies.
- **Detection**: Access audits, unexpected SELECT patterns.
- **Recovery**: Policy fix, session revoke, user notification if required.

### 9. ID enumeration
- **Surface**: Sequential or guessable IDs on public endpoints.
- **Impact**: Discovery of private resources.
- **Mitigation**: UUIDs for canonical IDs, authorization checks on every read of private data.
- **Detection**: High volume of 404 / 403 on ID probes.
- **Recovery**: Rate limit + monitoring.

### 10. Unauthorized mutation
- **Surface**: Client sending another user's ID or forged ownership flags.
- **Impact**: Editing / deleting other users' data.
- **Mitigation**: **Hard rule** — derive user identity only from the authenticated session. Never trust client-supplied user_id for authorization.
- **Detection**: Mismatch between session user and claimed owner.
- **Recovery**: Reject + log.

### 11. Malicious uploaded content
- **Surface**: Avatars, post images, future uploads.
- **Impact**: XSS, malware, storage abuse.
- **Mitigation**: Content-type validation, size limits, no execution of user content, CSP.
- **Detection**: Validation failures.
- **Recovery**: Remove content, quarantine user.

### 12. Storage abuse
- **Surface**: Downloads, IndexedDB, Android filesystem.
- **Impact**: Device fill, quota exhaustion.
- **Mitigation**: Configurable download limits, page size caps (25 MiB), chapter page caps, storage estimates (Stage 10).
- **Detection**: Quota warnings.
- **Recovery**: User-initiated cleanup, automatic stale staging cleanup.

### 13. Network abuse
- **Surface**: Extension or source adapters making excessive requests.
- **Impact**: IP bans from upstream, battery/data drain.
- **Mitigation**: Android resource governor, concurrency limits, backoff (Stage 10 download retry).
- **Detection**: Broker metrics, failure rates.
- **Recovery**: Cooldown, disable source.

### 14. Privilege escalation
- **Surface**: Role / moderator flags supplied by client.
- **Impact**: User becomes admin/moderator.
- **Mitigation**: Roles live only in server-side claims or protected tables; client cannot set them.
- **Detection**: Unexpected role changes.
- **Recovery**: Force role reset, session revoke.

### 15. Database compromise
- **Surface**: Supabase project, leaked service_role key.
- **Impact**: Full data exposure / destruction.
- **Mitigation**: Never embed service_role in clients; least-privilege keys; backups; monitoring.
- **Detection**: Unusual admin activity.
- **Recovery**: Key rotation, restore from backup, incident response.

## Phase 0 Hard Rules Derived From This Model

1. Client is never the final authority for security-sensitive state.
2. Canonical IDs are never external source IDs.
3. Extensions cannot access private backend APIs or auth tokens.
4. RLS must be restrictive by default; no blanket `USING (true)` for private tables.
5. Service-role credentials must never appear in browser, PWA, Android client, or extension runtime.
6. Completed user downloads are user data, not extension-controlled data.
