/**
 * MangaHive Phase 0 — Rate limit architecture (server-authoritative)
 *
 * Client-side timers are NOT security controls.
 * This module defines the contract and an in-memory reference implementation
 * suitable for tests and single-node development. Production should use a
 * shared store (Redis / Supabase / Edge) without changing the interface.
 */

'use strict';

const { rateLimited } = require('./errors');

/**
 * @typedef {{ limit: number, windowMs: number, cost?: number }} RateLimitPolicy
 */

/** Default policies — tune per deployment; do not break legitimate use. */
const DefaultPolicies = Object.freeze({
  authentication: { limit: 20, windowMs: 60_000 },
  search:         { limit: 60, windowMs: 60_000 },
  comments:       { limit: 30, windowMs: 60_000 },
  reactions:      { limit: 60, windowMs: 60_000 },
  friend_requests:{ limit: 20, windowMs: 60_000 },
  follows:        { limit: 40, windowMs: 60_000 },
  reports:        { limit: 15, windowMs: 60_000 },
  messaging:      { limit: 60, windowMs: 60_000 },
  downloads:      { limit: 30, windowMs: 60_000 },
  extension_ops:  { limit: 20, windowMs: 60_000 },
  expensive_rpc:  { limit: 10, windowMs: 60_000 },
});

/**
 * In-memory sliding window limiter (dev / test).
 * Key format: `${operation}:${subject}` where subject is userId or ip.
 */
class RateLimitService {
  constructor(policies = DefaultPolicies) {
    this.policies = policies;
    /** @type {Map<string, number[]>} */
    this._hits = new Map();
  }

  /**
   * @param {string} operation
   * @param {string} subject userId | ip | session
   * @param {number} [cost]
   * @param {string} [requestId]
   * @returns {{ allowed: true } | { allowed: false, error: object }}
   */
  check(operation, subject, cost = 1, requestId) {
    const policy = this.policies[operation] || this.policies.expensive_rpc;
    const key = `${operation}:${subject}`;
    const now = Date.now();
    const windowStart = now - policy.windowMs;
    let hits = (this._hits.get(key) || []).filter((t) => t > windowStart);
    const used = hits.length;
    if (used + cost > policy.limit) {
      const oldest = hits[0] || now;
      const retryAfterSeconds = Math.ceil((oldest + policy.windowMs - now) / 1000);
      return {
        allowed: false,
        error: rateLimited('Rate limit exceeded', Math.max(1, retryAfterSeconds), requestId),
      };
    }
    for (let i = 0; i < cost; i++) hits.push(now);
    this._hits.set(key, hits);
    return { allowed: true };
  }

  reset(operation, subject) {
    this._hits.delete(`${operation}:${subject}`);
  }

  clear() {
    this._hits.clear();
  }
}

module.exports = {
  DefaultPolicies,
  RateLimitService,
};
