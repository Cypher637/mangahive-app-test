/**
 * MangaHive Phase 0 — Invariant & security contract tests
 * Pure Node tests (no live database required for these structural invariants).
 */

'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const root = path.resolve(__dirname, '../..');
const { downloadIdentityKey, assertCanonicalNotExternal } = require(path.join(root, 'contracts/ids'));
const { ErrorCode, apiError, rateLimited, forbidden } = require(path.join(root, 'contracts/errors'));
const { RateLimitService, DefaultPolicies } = require(path.join(root, 'contracts/rate_limit'));
const { getPublicConfig, getServerConfig, CONFIG_CLASSIFICATION } = require(path.join(root, 'contracts/config'));

let passed = 0;
function ok(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exitCode = 1;
  } else {
    console.log('PASS:', msg);
    passed++;
  }
}

// ── Canonical identity ──────────────────────────────────────────────
{
  const id = {
    canonicalMangaId: 'mh-manga-001',
    canonicalChapterId: 'mh-ch-010',
    extensionId: 'builtin',
    sourceId: 'mangadex',
    remoteMangaId: 'a1b2c3d4',
    remoteChapterId: 'ch-ext-99',
  };
  const key = downloadIdentityKey(id);
  ok(key.includes('mh-ch-010') && key.includes('mangadex') && key.includes('ch-ext-99'),
    'download identity key includes canonical chapter + source binding');

  let threw = false;
  try { downloadIdentityKey({ canonicalChapterId: 'x' }); } catch (e) { threw = true; }
  ok(threw, 'download identity without sourceId throws');

  // Two sources can bind to one canonical manga (keys differ by source)
  const id2 = { ...id, sourceId: 'comick', remoteChapterId: 'other-99' };
  ok(downloadIdentityKey(id) !== downloadIdentityKey(id2),
    'different source bindings produce different download identities');
}

// ── Error model ─────────────────────────────────────────────────────
{
  const err = apiError(ErrorCode.FORBIDDEN, 'no', { stack: 'secret', token: 'x', reason: 'owner' });
  ok(err.code === 'FORBIDDEN' && err.details && err.details.reason === 'owner', 'error carries safe details');
  ok(!err.details.stack && !err.details.token, 'error strips stack and token');
  const rl = rateLimited('slow', 12, 'req-1');
  ok(rl.code === 'RATE_LIMITED' && rl.details.retryAfterSeconds === 12 && rl.requestId === 'req-1',
    'rate limit error shape');
}

// ── Rate limiting ───────────────────────────────────────────────────
{
  const rl = new RateLimitService({ search: { limit: 3, windowMs: 60_000 } });
  ok(rl.check('search', 'user-a').allowed, 'first search allowed');
  ok(rl.check('search', 'user-a').allowed, 'second search allowed');
  ok(rl.check('search', 'user-a').allowed, 'third search allowed');
  const blocked = rl.check('search', 'user-a');
  ok(!blocked.allowed && blocked.error.code === 'RATE_LIMITED', 'fourth search rate-limited');
  ok(rl.check('search', 'user-b').allowed, 'different subject not affected');
  ok(DefaultPolicies.authentication && DefaultPolicies.reports, 'default policies cover auth and reports');
}

// ── Config classification ───────────────────────────────────────────
{
  ok(CONFIG_CLASSIFICATION.SUPABASE_ANON_KEY === 'PUBLIC', 'anon key classified PUBLIC');
  ok(CONFIG_CLASSIFICATION.SUPABASE_SERVICE_ROLE_KEY === 'SECRET', 'service_role classified SECRET');
  const pub = getPublicConfig({ supabaseUrl: 'https://example.supabase.co', supabaseAnonKey: 'anon' });
  ok(pub.supabaseUrl.startsWith('https://') && pub.features.autoSourceFallbackDefault === false,
    'public config exposes url and safe feature defaults');
  // getServerConfig must not run in a simulated browser
  const prev = global.window;
  global.window = {}; global.document = {};
  let denied = false;
  try { getServerConfig(); } catch (e) { denied = /browser/.test(e.message); }
  global.window = prev; delete global.document;
  ok(denied, 'getServerConfig refuses browser context');
}

// ── Migration files exist ───────────────────────────────────────────
{
  const mig = path.join(root, 'supabase/migrations');
  ok(fs.existsSync(path.join(mig, '20261004000000_phase0_core_schema.sql')), 'core schema migration present');
  ok(fs.existsSync(path.join(mig, '20261004000001_phase0_rls_policies.sql')), 'RLS migration present');
  const rls = fs.readFileSync(path.join(mig, '20261004000001_phase0_rls_policies.sql'), 'utf8');
  ok(/auth\.uid\(\)/.test(rls), 'RLS policies use auth.uid()');
  ok(/ENABLE ROW LEVEL SECURITY/.test(rls), 'RLS is enabled on tables');
  // posts_select uses USING (true) intentionally for authenticated feed — documented
  ok(/posts_select[\s\S]*USING \(true\)/.test(rls), 'posts feed policy documented as intentional public-among-auth');
}

// ── IpcProtocol still has closed allowlist + source/control split ───
{
  const proto = fs.readFileSync(path.join(root, 'android/mihon/src/main/java/app/mangahive/mihon/ipc/contract/IpcProtocol.kt'), 'utf8');
  ok(/DOWNLOAD\("download", true\)/.test(proto), 'download is a source op');
  ok(/DELETE_DOWNLOAD\("deleteDownload"/.test(proto), 'deleteDownload is on the allowlist');
  ok(/fun fromWire/.test(proto), 'unknown ops rejected via fromWire');
}

// ── No service_role in client-facing sources ────────────────────────
{
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  // Comments may mention service_role as a warning; ensure no actual key assignment.
  ok(!/service_role\s*[:=]\s*['"]/i.test(index), 'index.html does not assign a service_role key');
  ok(!/SUPABASE_SERVICE_ROLE\s*[:=]/i.test(index), 'index.html does not reference SUPABASE_SERVICE_ROLE assignment');
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  ok(!/service_role/i.test(sw), 'service worker does not contain service_role');
}

console.log('\nPhase 0 invariant tests passed:', passed);
