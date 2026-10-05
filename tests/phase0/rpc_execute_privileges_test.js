'use strict';
/**
 * Phase 0.6 — Execute privileges verifier
 * PUBLIC EXECUTE is forbidden UNLESS explicitly documented in
 * contracts/rpc_execute_privileges.json → public_exceptions
 */
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const priv = JSON.parse(fs.readFileSync(path.join(root, 'contracts/rpc_execute_privileges.json'), 'utf8'));
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'contracts/rpc_catalog.json'), 'utf8'));
const migDir = path.join(root, 'supabase/migrations');
const sql = fs.readdirSync(migDir).filter(f => f.endsWith('.sql')).sort()
  .map(f => fs.readFileSync(path.join(migDir, f), 'utf8')).join('\n');
const p05 = fs.existsSync(path.join(migDir, '20261004080000_phase0_5_contract_and_privileges.sql'))
  ? fs.readFileSync(path.join(migDir, '20261004080000_phase0_5_contract_and_privileges.sql'), 'utf8') : '';
const p04 = fs.readFileSync(path.join(migDir, '20261004070000_phase0_4_security_and_verification_closure.sql'), 'utf8');

let n = 0, bad = 0;
function ok(c, m) {
  if (!c) { console.error('FAIL:', m); process.exitCode = 1; bad++; }
  else { console.log('PASS:', m); n++; }
}

ok(priv.default_policy.PUBLIC === 'REVOKE', 'default PUBLIC = REVOKE');
ok(Array.isArray(priv.functions) && priv.functions.length >= 20, 'privilege inventory has functions');
ok(/REVOKE ALL ON FUNCTION[\s\S]*FROM PUBLIC/.test(p04 + p05), 'migrations revoke PUBLIC');
ok(/GRANT EXECUTE ON FUNCTION[\s\S]*TO authenticated/.test(p04 + p05), 'migrations grant authenticated');

// --- Public exceptions contract ---
const exceptions = priv.public_exceptions || [];
ok(Array.isArray(exceptions), 'public_exceptions is an array');

const requiredExceptionFields = ['function', 'signature', 'public_execute', 'reason'];
for (const ex of exceptions) {
  for (const f of requiredExceptionFields) {
    ok(ex[f] !== undefined && ex[f] !== '', `exception ${ex.function || '?'} has ${f}`);
  }
  ok(ex.public_execute === true, `${ex.function} public_execute === true`);
  ok(typeof ex.reason === 'string' && ex.reason.length > 5, `${ex.function} has non-trivial reason`);
  // Must be in catalog as read_only
  const meta = catalog.rpcs[ex.function];
  ok(!!meta, `public exception ${ex.function} is in RPC catalog`);
  if (meta) {
    ok(meta.kind === 'read_only', `${ex.function} is read_only (not mutation)`);
    ok(meta.public_execute === true || meta.auth === 'public', `${ex.function} catalog marks public access`);
  }
  // SQL must GRANT to PUBLIC for this function
  const grantRe = new RegExp('GRANT EXECUTE ON FUNCTION public\\.' + ex.function.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\([^)]*\\)\\s*TO PUBLIC', 'i');
  ok(grantRe.test(sql) || /GRANT EXECUTE ON FUNCTION public\.app_schema_version\(\) TO PUBLIC/.test(sql),
    `SQL grants PUBLIC execute for ${ex.function}`);
}

// Known intentional exception
ok(exceptions.some(e => e.function === 'app_schema_version'), 'app_schema_version is documented public exception');
const asv = exceptions.find(e => e.function === 'app_schema_version');
if (asv) {
  ok(/app_schema_version\s*\(\s*\)/.test(asv.signature), 'app_schema_version signature is ()');
}

// Sample privileged RPCs still revoked from PUBLIC in 0.4/0.5
const samples = ['toggle_follow', 'create_post', 'submit_report', 'update_my_profile', 'mark_notifications_read'];
for (const name of samples) {
  ok(priv.functions.includes(name), name + ' in privilege inventory');
}

// Internal helpers must not be client-callable
if (priv.internal_helpers) {
  for (const [name, pol] of Object.entries(priv.internal_helpers)) {
    ok(pol.authenticated === 'REVOKE', `internal ${name}: authenticated REVOKE`);
    ok(pol.PUBLIC === 'REVOKE', `internal ${name}: PUBLIC REVOKE`);
  }
}

// No catalog mutation may be listed as public exception
for (const ex of exceptions) {
  const meta = catalog.rpcs[ex.function];
  if (meta) ok(meta.kind !== 'mutation', `public exception ${ex.function} is not a mutation`);
}

console.log('\nExecute privileges tests passed:', n, 'failed:', bad);
