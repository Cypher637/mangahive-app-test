/**
 * MangaHive Phase 0 — Configuration boundary
 *
 * Classification:
 *   PUBLIC     — safe for browser / PWA / Android client / extension runtime
 *   SERVER_ONLY — must never reach any client bundle
 *   SECRET     — credentials; never commit; never embed in clients
 *
 * A Supabase anon/publishable key is PUBLIC (by design of Supabase RLS).
 * A Supabase service_role key is SECRET and must never appear here or in clients.
 */

'use strict';

const ENV = {
  development: 'development',
  staging: 'staging',
  production: 'production',
};

/**
 * Resolve public client config.
 * In production builds, inject via build-time defines or a non-secret config endpoint.
 * Never place service_role or JWT secrets in this object.
 */
function getPublicConfig(overrides = {}) {
  const env = overrides.env || process.env.MANGAHIVE_ENV || 'development';

  // These values are intentionally public (RLS protects data).
  // Prefer environment injection over hard-coding in production deploys.
  const supabaseUrl =
    overrides.supabaseUrl ||
    process.env.MANGAHIVE_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    '';

  const supabaseAnonKey =
    overrides.supabaseAnonKey ||
    process.env.MANGAHIVE_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    '';

  return Object.freeze({
    env,
    supabaseUrl,
    supabaseAnonKey,
    // Feature flags (public)
    features: Object.freeze({
      autoSourceFallbackDefault: false,
    }),
  });
}

/**
 * Server-only config — must only be loaded in trusted server/Edge contexts.
 * Throws if called in a context that looks like a browser bundle.
 */
function getServerConfig(overrides = {}) {
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    throw new Error('getServerConfig must not be called from a browser context');
  }
  const serviceRole =
    overrides.serviceRoleKey ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.MANGAHIVE_SERVICE_ROLE_KEY ||
    '';

  if (serviceRole && overrides.allowEmpty !== true) {
    // Present only on server. Never log the value.
  }

  return Object.freeze({
    env: overrides.env || process.env.MANGAHIVE_ENV || 'development',
    hasServiceRole: Boolean(serviceRole),
    // Intentionally do not return the raw key from this helper in most call sites.
    // Callers that need it must read process.env directly in server code.
  });
}

/** Static classification for audits */
const CONFIG_CLASSIFICATION = Object.freeze({
  MANGAHIVE_SUPABASE_URL: 'PUBLIC',
  MANGAHIVE_SUPABASE_ANON_KEY: 'PUBLIC',
  SUPABASE_URL: 'PUBLIC',
  SUPABASE_ANON_KEY: 'PUBLIC',
  SUPABASE_SERVICE_ROLE_KEY: 'SECRET',
  MANGAHIVE_SERVICE_ROLE_KEY: 'SECRET',
  MANGAHIVE_ENV: 'PUBLIC',
});

module.exports = {
  ENV,
  getPublicConfig,
  getServerConfig,
  CONFIG_CLASSIFICATION,
};
