'use strict';
/**
 * Phase 0.7 — AUTHORITATIVE final RPC verifier (code-side / static CI)
 *
 *   FRONTEND RPC USAGE → RPC CATALOG → FINAL FUNCTION STATE (ordered migration replay) → PRIVILEGE + SECURITY CONTRACT
 *
 * For EVERY catalog RPC (no skipping when a field is absent — an incomplete entry FAILS):
 *   exact name · arg count · arg order · arg names · PostgreSQL arg types · return type · overload uniqueness
 *   mutation/read-only classification (observed body effect) · authentication requirement (ACL + body guard)
 *   SECURITY DEFINER (+ pinned search_path) · rate-limit operation · client-callable / PUBLIC / anon EXECUTE
 * plus: undocumented client-callable functions, obsolete/historical overloads, frontend ↔ catalog (names + argument keys),
 * and unresolved dynamic RPC names (fail with file:line).
 *
 * The state is reconstructed deterministically from supabase/migrations/*.sql (see lib/pg_state.js):
 * CREATE / CREATE OR REPLACE / ALTER / DROP FUNCTION, GRANT / REVOKE EXECUTE, overloads, DO-block ACL loops and
 * the PostgreSQL rules that make a migration fail. It is NOT a live pg_proc check — that remains an external freeze gate.
 *
 * The verifier itself is proven by tests/phase0/rpc_verifier_selftest_test.js (negative cases on isolated inputs).
 */
const { loadRepo } = require('./lib/load_repo');
const { verify } = require('./lib/rpc_verifier');

let n = 0, bad = 0;
function ok(c, m) {
  if (!c) { console.error('FAIL:', m); process.exitCode = 1; bad++; }
  else { console.log('PASS:', m); n++; }
}

const repo = loadRepo();
const res = verify(repo);
const { findings, advisories, stats, state } = res;
const cat = repo.catalog;

// ── per-RPC verdicts (a catalog RPC passes only if the verifier produced NO finding about it) ──
for (const name of Object.keys(cat.rpcs)) {
  const mine = findings.filter(f => f.subject === name || f.subject.startsWith(name + '('));
  ok(mine.length === 0, `${cat.rpcs[name].signature} → ${cat.rpcs[name].returns} [${cat.rpcs[name].kind}/${cat.rpcs[name].auth_enforcement}/rl=${cat.rpcs[name].rate_limit}]` +
    (mine.length ? ' :: ' + mine.map(f => f.code + ': ' + f.msg).join(' ; ') : ''));
}

// ── everything else the verifier found (migration errors, undocumented functions, frontend, obsolete, inventory …) ──
const perRpc = new Set(Object.keys(cat.rpcs));
const other = findings.filter(f => !perRpc.has(f.subject) && ![...perRpc].some(r => f.subject.startsWith(r + '(')));
for (const f of other) console.error(`FAIL: [${f.code}] ${f.subject} — ${f.msg}`);
ok(other.length === 0, 'no cross-cutting findings (migration replay, undocumented functions, obsolete overloads, frontend chain, privilege inventory)');
if (other.length) bad += other.length;

// ── structural invariants that must hold for the contract to mean anything ──
ok(stats.catalogRpcs > 0 && stats.completeSignatures === stats.catalogRpcs,
  `every catalog RPC has a complete signature contract (${stats.completeSignatures}/${stats.catalogRpcs})`);
ok(stats.dbRpcsVerified === stats.catalogRpcs, `every catalog RPC verified against final database state (${stats.dbRpcsVerified}/${stats.catalogRpcs})`);
ok(state.errors.length === 0, 'migration replay: no statement would fail on PostgreSQL (' + state.errors.length + ' errors)');
ok(stats.frontendDistinct > 0 && stats.unresolved.length === 0, `frontend: ${stats.frontendDistinct} distinct RPCs, ${stats.unresolved.length} unresolved dynamic usages`);
ok(stats.frontendKeysUnverifiable === 0, `frontend: argument keys verified for all ${stats.frontendKeysVerified} call sites`);

// ── critical contracts kept from Phase 0.6 (now asserted against the reconstructed FINAL state) ──
const one = n => state.byName(n);
const create = one('create_post');
ok(create.length === 1, 'create_post: exactly one overload in final state');
if (create.length === 1) {
  const a = create[0].args;
  ok(a.map(x => x.name).join(',') === 'p_body,p_image_url,p_series_id,p_series_title,p_source,p_remote_id,p_cover_url,p_spoiler', 'create_post arg order exact');
  ok(a.find(x => x.name === 'p_series_id').type === 'text', 'create_post p_series_id is text');
  ok(!a.some(x => x.type === 'uuid'), 'create_post has no uuid argument');
  ok(a[a.length - 1].name === 'p_spoiler' && a[a.length - 1].type === 'boolean', 'create_post ends with p_spoiler boolean');
}
const prof = one('update_my_profile');
ok(prof.length === 1 && prof[0].args.length === 1 && prof[0].args[0].name === 'p_patch' && prof[0].args[0].type === 'jsonb', 'update_my_profile(p_patch jsonb) only');
for (const k of ['create_post(text,text,boolean,uuid,text,text,text,text)', 'get_public_profile(uuid)', 'toggle_message_reaction(uuid,text)', 'update_my_profile(text,text,text,text,text)']) {
  ok(!state.funcs.has(k), 'obsolete overload absent from final state: ' + k);
}
ok(!cat.rpcs.require_rate_limit && !cat.rpcs.room_is_accessible, 'internal helpers are not in the client RPC catalog');
const asv = state.byName('app_schema_version')[0];
ok(asv && state.effectiveExecute(asv, 'PUBLIC') && (repo.privileges.public_exceptions || []).some(e => e.function === 'app_schema_version'),
  'documented app_schema_version() PUBLIC exception preserved');

// ── report ──
const dyn = stats.dynamicResolved.map(d => `${d.file}:${d.line} → ${d.names.join(' | ')}`);
const PRIV_CODES = new Set(['ACL_AUTHENTICATED_MISSING', 'ANON_EXECUTE', 'UNDOCUMENTED_PUBLIC_EXECUTE', 'PUBLIC_EXCEPTION_STALE',
  'PUBLIC_EXCEPTION_SIGNATURE', 'PRIVILEGE_INVENTORY_MISMATCH', 'HELPER_CALLABLE', 'RLS_TABLE_PRIVILEGE', 'BASELINE_MISSING']);
const unexpectedCallable = findings.filter(f => ['UNDOCUMENTED_CALLABLE', 'HELPER_CALLABLE', 'FRONTEND_CALLS_NONCLIENT'].includes(f.code)).length;
const privInconsistencies = findings.filter(f => PRIV_CODES.has(f.code)).length;
const roomAdvisories = advisories.filter(a => /room_is_accessible/.test(a.msg + a.subject)).length +
  findings.filter(f => /room_is_accessible/.test(f.subject + f.msg)).length;
ok(unexpectedCallable === 0, 'unexpected client-callable functions: 0');
ok(privInconsistencies === 0, 'privilege inconsistencies: 0');
ok(stats.rlsContradictions === 0 && stats.rlsPoliciesChecked > 0, `RLS predicate privilege contradictions: 0 (${stats.rlsPoliciesChecked} final policies checked)`);
ok(advisories.length === 0, 'verifier advisories: 0 (none suppressed; advisory channel is empty)');
ok(roomAdvisories === 0, 'security advisories/findings concerning room_is_accessible(): 0');
ok(stats.inlinedHelperContracts >= 1, 'inlined-helper contract present and verified (room_is_accessible → room_msg_select)');

console.log('\n── Phase 0.8 verifier report ──');
console.log('catalog RPCs                       :', stats.catalogRpcs);
console.log('frontend RPCs discovered (distinct):', stats.frontendDistinct, `(${stats.frontendCallSites} call sites)`);
console.log('database RPCs verified             :', stats.dbRpcsVerified, `(of ${stats.dbFunctionsTotal} functions in schema public)`);
console.log('RPCs with complete signatures      :', stats.completeSignatures);
console.log('dynamic RPC usages (resolved)      :', dyn.length ? dyn.join(' ; ') : 'none');
console.log('dynamic RPC usages (UNRESOLVED)    :', stats.unresolved.length);
console.log('obsolete signatures documented     :', stats.obsoleteSignatures, '(all absent from final state)');
console.log('migration replay errors            :', state.errors.length);
console.log('unexpected client-callable funcs   :', unexpectedCallable);
console.log('privilege inconsistencies          :', privInconsistencies);
console.log('RLS predicate privilege contradict.:', stats.rlsContradictions, `(${stats.rlsPoliciesChecked} policies)`);
console.log('advisories concerning room_is_accessible():', roomAdvisories);
for (const a of advisories) console.log(`ADVISORY (non-failing) [${a.code}] ${a.subject}: ${a.msg}`);
console.log('\nFinal signature tests passed:', n, 'failed:', bad);
