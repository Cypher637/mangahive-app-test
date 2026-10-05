/**
 * MangaHive public runtime configuration — NO production fallbacks.
 * Inject via window.__MANGAHIVE_CONFIG__ before this script, or replace this file at deploy.
 * Missing required values → throw (app must not connect).
 */
(function (root) {
  'use strict';
  var injected = (root && root.__MANGAHIVE_CONFIG__) || {};
  var supabaseUrl = injected.supabaseUrl || '';
  var supabaseAnonKey = injected.supabaseAnonKey || '';
  var googleClientId = injected.googleClientId || '';
  var env = injected.env || 'development';

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      'MangaHiveConfig missing: set window.__MANGAHIVE_CONFIG__ = { supabaseUrl, supabaseAnonKey, googleClientId } before loading the app'
    );
  }
  if (supabaseUrl.indexOf('YOUR_') === 0 || supabaseAnonKey.indexOf('YOUR_') === 0) {
    throw new Error('MangaHiveConfig: placeholder values are not allowed');
  }
  if (supabaseUrl.indexOf('https://') !== 0) {
    throw new Error('MangaHiveConfig: supabaseUrl must be https://');
  }

  root.MangaHiveConfig = Object.freeze({
    env: env,
    supabaseUrl: supabaseUrl,
    supabaseAnonKey: supabaseAnonKey,
    googleClientId: googleClientId,
    features: Object.freeze({ autoSourceFallbackDefault: false }),
  });
})(typeof window !== 'undefined' ? window : globalThis);
