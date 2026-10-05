'use strict';
/**
 * Phase 0.8 — room_messages RLS execution closure (static).
 * room_is_accessible() is an internal helper. It must stay non-callable by PUBLIC/anon/authenticated,
 * must not be reachable through supabase.rpc(), and must not be called by any RLS policy
 * (policies run as the caller; the only way to make that work is a grant, which PostgREST would expose).
 */
const fs = require('fs');
const path = require('path');
const { loadRepo } = require('./lib/load_repo');
const { verify, finalPolicies } = require('./lib/rpc_verifier');
const repo = loadRepo();
const res = verify(repo);
let n = 0;
function ok(c, m) { if (!c) { console.error('FAIL:', m); process.exitCode = 1; } else { console.log('PASS:', m); n++; } }

const H = res.state.byName('room_is_accessible');
ok(H.length === 1 && H[0].key === 'room_is_accessible(text)', 'single room_is_accessible(text) in final state');
const h = H[0];
for (const r of ['PUBLIC', 'anon', 'authenticated']) ok(!res.state.effectiveExecute(h, r), `${r} has no EXECUTE on room_is_accessible`);
ok(h.securityDefiner && h.searchPathPinned, 'helper keeps SECURITY DEFINER + pinned search_path');
ok(/status\s*=\s*'active'/.test(h.body) && /visibility\s*=\s*'public'/.test(h.body), 'helper authorization semantics unchanged (active AND public)');

ok(!repo.catalog.rpcs.room_is_accessible && !!repo.catalog.internal_helpers.room_is_accessible, 'helper is catalogued as internal, not as a client RPC');
ok(repo.catalog.internal_helpers.room_is_accessible.client_callable === false, 'catalog client_callable=false');
ok(repo.privileges.internal_helpers.room_is_accessible.rls_policy_use === 'forbidden', 'privilege contract: rls_policy_use=forbidden');
ok(!repo.privileges.functions.includes('room_is_accessible'), 'not in client EXECUTE inventory');
ok((repo.privileges.rls_policy_contract.inlined_helpers || []).some(e => e.helper === 'room_is_accessible' && e.policy === 'room_messages/room_msg_select'), 'RLS predicate contract records the inlined helper');

const hits = repo.frontendFiles.filter(f => /room_is_accessible/.test(f.src)).map(f => f.path);
ok(hits.length === 0, 'no frontend/runtime file references room_is_accessible (' + (hits.join(',') || 'none') + ')');

const pol = finalPolicies(repo.migrations);
const rm = pol.filter(p => p.table === 'room_messages');
const sel = rm.find(p => p.name === 'room_msg_select');
ok(!!sel && sel.roles.length === 1 && sel.roles[0] === 'authenticated', 'room_msg_select exists and is TO authenticated only');
ok(!/room_is_accessible/i.test(sel.text), 'room_msg_select does not call room_is_accessible');
ok(/EXISTS\s*\(\s*SELECT 1 FROM public\.rooms r/i.test(sel.text) && /r\.id\s*=\s*room_messages\.room_id/.test(sel.text), 'room_msg_select checks room existence via rooms');
ok(/r\.status\s*=\s*'active'/.test(sel.text) && /r\.visibility\s*=\s*'public'/.test(sel.text), 'room_msg_select keeps active + public room checks (no weakening)');
ok(rm.every(p => !/room_is_accessible/i.test(p.text)), 'no room_messages policy references the helper');
ok(pol.every(p => !/room_is_accessible/i.test(p.text)), 'no policy anywhere references the helper');
ok(res.findings.length === 0, 'verifier: zero findings');
ok(res.advisories.length === 0 && res.stats.rlsContradictions === 0, 'verifier: zero advisories, zero RLS privilege contradictions');

const mig = repo.migrations.map(m => m.name);
ok(mig[mig.length - 1].includes('phase0_8_room_rls_execution_closure'), '0.8 migration is last in replay order');
const sql = repo.migrations.find(m => m.name.includes('phase0_8')).sql;
ok(!/GRANT[^;]*room_is_accessible/i.test(sql.replace(/--.*$/gm, '')), '0.8 migration grants nothing on the helper');
ok(!/\bGRANT\b[^;]*\bTO\s+(anon|PUBLIC)\b/i.test(sql.replace(/--.*$/gm, '')), '0.8 migration grants nothing to anon/PUBLIC');

// rooms write paths stay closed
const rp = pol.filter(p => p.table === 'rooms');
for (const nm of ['rooms_insert_deny', 'rooms_update_deny', 'rooms_delete_deny']) ok(rp.some(p => p.name === nm), nm + ' still present');
// room RPCs still authorize through the helper (definer context)
for (const f of ['send_room_message', 'edit_room_message', 'delete_room_message']) {
  const fn = res.state.byName(f)[0];
  ok(fn && fn.securityDefiner && /room_is_accessible\(/.test(fn.body), `${f} is SECURITY DEFINER and still gates on room_is_accessible()`);
}
console.log('\nRoom RLS execution tests passed:', n);
