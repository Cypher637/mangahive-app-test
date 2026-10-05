'use strict';
/**
 * Authoritative RPC verifier (Phase 0.7; RLS execution boundary added in 0.8).
 *
 * Pure function over in-memory inputs so it can be driven by the real repo (rpc_final_signature_test.js)
 * and by isolated mutated fixtures (rpc_verifier_selftest_test.js).
 *
 *   FRONTEND RPC USAGE → CATALOG (contracts/rpc_catalog.json) → FINAL FUNCTION STATE → PRIVILEGE + SECURITY CONTRACT
 *
 * The "final function state" is reconstructed by replaying every migration in order
 * (lib/pg_state.js). When a live database is available the same contract can be checked against
 * pg_proc / has_function_privilege instead — that is a separate, external freeze gate.
 */
const { buildState, splitStatements, keyOf } = require('./pg_state');
const { scanFrontend } = require('./frontend_rpc_scan');

const RATE_LIMIT_HELPERS = new Set(['check_rate_limit', 'require_rate_limit']);
const KINDS = new Set(['mutation', 'read_only']);
const AUTHS = new Set(['authenticated', 'public']);
const AUTH_ENFORCEMENT = new Set(['guard', 'uid_scoped', 'acl_only', 'public']);

const stripComments = b => b.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--.*$/gm, ' ');
const stripStrings = b => b.replace(/'(?:[^']|'')*'/g, "''");

function bodyFacts(f, state) {
  const code = stripComments(f.body || '');
  const noStr = stripStrings(code);
  const directDml = /\b(insert\s+into|delete\s+from|truncate\b|update\s+[\w."]+\s+set\b)/i.test(noStr);
  const callees = new Set();
  for (const m of noStr.matchAll(/\b(?:public\.)?([a-z_][a-z0-9_]*)\s*\(/gi)) {
    const nm = m[1].toLowerCase();
    if (nm !== f.name && state.byName(nm).length) callees.add(nm);
  }
  const rl = [...code.matchAll(/require_rate_limit\(\s*'([^']+)'\s*\)/gi)].map(x => x[1]);
  const hasUid = /auth\.uid\(\)/i.test(noStr);
  const guard = hasUid && /(auth\.uid\(\)|\bv_uid)\s+IS\s+NULL/i.test(noStr);
  return { code, directDml, callees, rateLimitOps: rl, authEnforcement: guard ? 'guard' : hasUid ? 'uid_scoped' : 'acl_only' };
}

function isCallable(state, f) {
  if (f.returns === 'trigger') return false;                       // PostgreSQL refuses direct calls; not RPC-exposed
  return state.effectiveExecute(f, 'PUBLIC') || state.effectiveExecute(f, 'anon') || state.effectiveExecute(f, 'authenticated');
}


/** Split a WHERE/USING expression on top-level AND (outside parens and quotes). */
function splitConjuncts(txt) {
  const out = []; let depth = 0, q = false, cur = '';
  const t = txt.trim();
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === "'") { q = !q; cur += c; continue; }
    if (!q) {
      if (c === '(') depth++;
      if (c === ')') depth--;
      if (depth === 0) {
        const am = /^\s+and\s+/i.exec(t.slice(i));
        if (am) { out.push(cur); cur = ''; i += am[0].length - 1; continue; }
      }
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.map(x => x.trim());
}

/**
 * Replay table-level GRANT/REVOKE for the tables named by the inlined-helper contracts.
 * Initial state = platform baseline (Supabase grants ALL on new public tables to anon/authenticated).
 */
function tablePrivilegeState(migrations, contracts, baseline) {
  const ALL = ['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger'];
  const tables = new Set();
  for (const c of contracts) for (const t of Object.keys(c.table_privileges || {})) tables.add(t);
  const st = {};
  for (const t of tables) {
    st[t] = { PUBLIC: new Set(), anon: new Set(), authenticated: new Set(), service_role: new Set() };
    for (const r of Array.isArray(baseline) ? baseline : []) if (st[t][r]) ALL.forEach(x => st[t][r].add(x));
  }
  for (const mig of migrations) {
    for (const s of splitStatements(mig.sql)) {
      const m = /^(grant|revoke)\s+([\s\S]+?)\s+on\s+(?:table\s+)?(?:public\.)?"?([a-z_]\w*)"?\s+(to|from)\s+([\s\S]+?)(?:\s+with\s+grant\s+option|\s+cascade|\s+restrict)?$/i.exec(s.text);
      if (!m || !st[m[3].toLowerCase()]) continue;
      const grant = m[1].toLowerCase() === 'grant';
      const privs = m[2].split(',').map(x => x.trim().toLowerCase().replace(/\s+privileges$/, ''));
      const list = privs.includes('all') ? ALL : privs;
      for (const r0 of m[5].split(',')) {
        const r = /^public$/i.test(r0.trim()) ? 'PUBLIC' : r0.trim().toLowerCase();
        if (!st[m[3].toLowerCase()][r]) continue;
        for (const x of list) grant ? st[m[3].toLowerCase()][r].add(x) : st[m[3].toLowerCase()][r].delete(x);
      }
    }
  }
  return st;
}

/** Final RLS policies (CREATE/DROP POLICY replay) → [{name, table, roles[], text, loc}] */
function finalPolicies(migrations) {
  const pol = new Map();
  for (const mig of migrations) {
    for (const s of splitStatements(mig.sql)) {
      let m = /^drop\s+policy\s+(?:if\s+exists\s+)?"?([\w]+)"?\s+on\s+([\w."]+)/i.exec(s.text);
      if (m) { pol.delete(m[2].toLowerCase().replace(/^public\./, '') + '/' + m[1].toLowerCase()); continue; }
      m = /^create\s+policy\s+"?([\w]+)"?\s+on\s+([\w."]+)([\s\S]*)$/i.exec(s.text);
      if (m) {
        const table = m[2].toLowerCase().replace(/^public\./, '');
        const tm = /\bto\s+([\w,\s]+?)(?=\s+(using|with)\b|$)/i.exec(m[3]);
        const roles = tm ? tm[1].split(',').map(x => x.trim().toLowerCase()) : ['public'];
        pol.set(table + '/' + m[1].toLowerCase(), { name: m[1], table, roles, text: m[3], loc: mig.name + ':' + s.line });
      }
    }
  }
  return [...pol.values()];
}

/**
 * @param {object} input
 * @param {object} input.catalog
 * @param {object} input.privileges
 * @param {{name:string, sql:string}[]} input.migrations     ordered
 * @param {{path:string, src:string}[]} input.frontendFiles
 */
function verify({ catalog, privileges, migrations, frontendFiles }) {
  const findings = [];
  const advisories = [];
  const fail = (code, subject, msg) => findings.push({ code, subject, msg });
  const stats = {
    catalogRpcs: 0, completeSignatures: 0, dbRpcsVerified: 0, dbFunctionsTotal: 0,
    frontendCallSites: 0, frontendDistinct: 0, frontendKeysVerified: 0, frontendKeysUnverifiable: 0,
    obsoleteSignatures: 0, dynamicResolved: [], unresolved: [],
  };

  const rpcs = (catalog && catalog.rpcs) || {};
  const helpers = (catalog && catalog.internal_helpers) || {};
  const preds = (catalog && catalog.rls_predicates) || {};
  const trigs = (catalog && catalog.trigger_functions) || {};
  const obsolete = (catalog && catalog.obsolete_signatures) || [];
  stats.catalogRpcs = Object.keys(rpcs).length;

  // ── platform baseline must be explicit ──
  const baseline = privileges && privileges.platform_baseline && privileges.platform_baseline.default_function_grantees;
  if (!Array.isArray(baseline)) fail('BASELINE_MISSING', 'privileges', 'contracts/rpc_execute_privileges.json must declare platform_baseline.default_function_grantees');

  // ── 1. replay migrations ──
  const state = buildState(migrations, { platformDefaultGrantees: Array.isArray(baseline) ? baseline : [] });
  stats.dbFunctionsTotal = state.funcs.size;
  for (const e of state.errors) fail('MIGRATION_ERROR', e.loc, `[${e.kind}] ${e.msg}`);

  // ── 2. catalog completeness / self-consistency ──
  const completeness = (name, meta, section) => {
    const miss = [];
    const need = ['args', 'required', 'arg_types', 'signature', 'returns', 'security_definer', 'client_callable'];
    if (section === 'rpcs') need.push('kind', 'auth', 'auth_enforcement');
    for (const f of need) if (meta[f] === undefined || meta[f] === null || meta[f] === '') miss.push(f);
    if (section === 'rpcs' && !('rate_limit' in meta)) {
      fail('RATE_LIMIT_METADATA', name, 'catalog entry has no rate_limit field (must be an operation name or null)');
    }
    if (miss.length) { fail('CATALOG_INCOMPLETE', name, `catalog entry missing: ${miss.join(', ')}`); return false; }
    let ok = true;
    const bad = (m) => { fail('CATALOG_INCONSISTENT', name, m); ok = false; };
    if (!Array.isArray(meta.args) || !meta.args.every(a => typeof a === 'string')) return bad('args must be string[]'), false;
    if (typeof meta.arg_types !== 'object' || Array.isArray(meta.arg_types)) return bad('arg_types must be an object keyed by arg name'), false;
    if (JSON.stringify(Object.keys(meta.arg_types)) !== JSON.stringify(meta.args)) bad('arg_types keys must equal args, in order');
    if (!Object.values(meta.arg_types).every(t => typeof t === 'string' && t)) bad('arg_types values must be PostgreSQL type names');
    const sigStr = name + '(' + Object.values(meta.arg_types).join(',') + ')';
    if (meta.signature !== sigStr) bad(`signature "${meta.signature}" disagrees with arg_types → "${sigStr}"`);
    if (!Array.isArray(meta.required) || !meta.required.every(a => meta.args.includes(a))) bad('required must be a subset of args');
    if (typeof meta.security_definer !== 'boolean') bad('security_definer must be boolean');
    if (section === 'rpcs') {
      if (!KINDS.has(meta.kind)) bad(`kind must be mutation|read_only (got ${meta.kind})`);
      if (!AUTHS.has(meta.auth)) bad(`auth must be authenticated|public (got ${meta.auth})`);
      if (!AUTH_ENFORCEMENT.has(meta.auth_enforcement)) bad(`auth_enforcement invalid (${meta.auth_enforcement})`);
      if (meta.client_callable !== true) bad('client_callable must be true for an RPC catalog entry');
      if (!(meta.rate_limit === null || (typeof meta.rate_limit === 'string' && meta.rate_limit))) {
        fail('RATE_LIMIT_METADATA', name, 'rate_limit must be a non-empty operation string or null'); ok = false;
      }
      if (meta.kind === 'mutation' && meta.rate_limit === null && !(typeof meta.rate_limit_reason === 'string' && meta.rate_limit_reason.length > 5)) {
        fail('RATE_LIMIT_METADATA', name, 'mutation without rate_limit needs a rate_limit_reason'); ok = false;
      }
      if (meta.auth === 'public' && meta.public_execute !== true) bad('public RPC must set public_execute: true');
    } else if (typeof meta.client_callable !== 'boolean') bad('client_callable must be boolean');
    return ok;
  };

  const sections = [['rpcs', rpcs], ['internal_helpers', helpers], ['rls_predicates', preds], ['trigger_functions', trigs]];
  const allNames = new Map();
  for (const [sec, obj] of sections) {
    for (const [name, meta] of Object.entries(obj)) {
      if (allNames.has(name)) fail('CATALOG_INCONSISTENT', name, `listed in both ${allNames.get(name)} and ${sec}`);
      allNames.set(name, sec);
      if (completeness(name, meta, sec) && sec === 'rpcs') stats.completeSignatures++;
    }
  }

  // ── 3. every catalogued function vs the FINAL database state ──
  const rateLimitFn = state.byName('check_rate_limit')[0];
  const rlBranches = rateLimitFn ? new Set([...stripComments(rateLimitFn.body).matchAll(/WHEN\s+'([^']+)'\s+THEN/gi)].map(m => m[1])) : new Set();
  const mutMemo = new Map();
  const businessMutating = (f, seen = new Set()) => {
    if (mutMemo.has(f.key)) return mutMemo.get(f.key);
    if (RATE_LIMIT_HELPERS.has(f.name)) return false;
    if (seen.has(f.key)) return false;
    seen.add(f.key);
    const facts = bodyFacts(f, state);
    let r = facts.directDml;
    if (!r) for (const c of facts.callees) for (const g of state.byName(c)) if (businessMutating(g, seen)) { r = true; break; }
    mutMemo.set(f.key, r);
    return r;
  };

  for (const [sec, obj] of sections) {
    for (const [name, meta] of Object.entries(obj)) {
      const fns = state.byName(name);
      if (fns.length === 0) { fail('CATALOG_NOT_IN_DB', name, `${sec} entry has no function in the final database state`); continue; }
      const expectedSig = meta.signature;
      let f = fns.find(x => x.key === expectedSig);
      if (fns.length > 1) {
        fail('UNEXPECTED_OVERLOAD', name, `${fns.length} overloads in final state: ${fns.map(x => x.key).join(' | ')}`);
      }
      if (!f) {
        fail('SIGNATURE_MISMATCH', name, `final state has ${fns.map(x => x.key).join(' | ')}; catalog says ${expectedSig}`);
        f = fns[0];
      }
      const catNames = Array.isArray(meta.args) ? meta.args : [];
      const catTypes = meta.arg_types && typeof meta.arg_types === 'object' ? Object.values(meta.arg_types) : [];
      const dbNames = f.args.map(a => a.name), dbTypes = f.args.map(a => a.type);
      if (catNames.length !== dbNames.length) fail('ARG_COUNT', name, `catalog ${catNames.length} args vs database ${dbNames.length} (${f.key})`);
      else {
        if (JSON.stringify(catNames) !== JSON.stringify(dbNames)) {
          const sameSet = [...catNames].sort().join() === [...dbNames].sort().join();
          fail(sameSet ? 'ARG_ORDER' : 'ARG_NAME', name, `catalog (${catNames.join(', ')}) vs database (${dbNames.join(', ')})`);
        }
        for (let i = 0; i < dbTypes.length; i++) {
          if (catTypes[i] !== undefined && String(catTypes[i]).toLowerCase() !== dbTypes[i]) {
            fail('ARG_TYPE', name, `arg ${i + 1} (${dbNames[i]}): catalog ${catTypes[i]} vs database ${dbTypes[i]}`);
          }
        }
      }
      if (meta.returns !== undefined && String(meta.returns).toLowerCase() !== f.returns) {
        fail('RETURN_TYPE', name, `catalog returns ${meta.returns} vs database ${f.returns}`);
      }
      const dbRequired = f.args.filter(a => !a.hasDefault).map(a => a.name);
      if (Array.isArray(meta.required) && JSON.stringify(meta.required) !== JSON.stringify(dbRequired)) {
        fail('REQUIRED_ARGS', name, `catalog required [${meta.required}] vs database (no DEFAULT) [${dbRequired}]`);
      }
      if (typeof meta.security_definer === 'boolean' && meta.security_definer !== f.securityDefiner) {
        fail('SECURITY_DEFINER', name, `catalog security_definer=${meta.security_definer} vs database ${f.securityDefiner}`);
      }
      if (f.securityDefiner && !f.searchPathPinned) {
        fail('SEARCH_PATH_UNPINNED', name, 'SECURITY DEFINER function without SET search_path');
      }
      if (sec === 'trigger_functions' && f.returns !== 'trigger') fail('TRIGGER_CONTRACT', name, `trigger_functions entry returns ${f.returns}`);
      if (sec !== 'trigger_functions' && f.returns === 'trigger') fail('TRIGGER_CONTRACT', name, `${sec} entry returns trigger`);
      stats.dbRpcsVerified += sec === 'rpcs' ? 1 : 0;

      // ── privilege + security contract ──
      const eff = r => state.effectiveExecute(f, r);
      const callable = isCallable(state, f);
      if (sec === 'rpcs') {
        const facts = bodyFacts(f, state);
        if (meta.auth === 'authenticated') {
          if (!eff('authenticated')) fail('ACL_AUTHENTICATED_MISSING', name, 'authenticated cannot EXECUTE');
          if (f.acl.PUBLIC) fail('UNDOCUMENTED_PUBLIC_EXECUTE', name, 'PUBLIC has EXECUTE on an authenticated-only RPC');
          else if (eff('anon')) fail('ANON_EXECUTE', name, 'anon retains EXECUTE (explicit grant or platform default privilege) on an authenticated-only RPC');
          if (meta.auth_enforcement === 'public') fail('AUTH_CONTRACT', name, 'auth=authenticated but auth_enforcement=public');
        } else if (meta.auth === 'public') {
          const ex = (privileges.public_exceptions || []).find(e => e.function === name);
          if (!ex) fail('UNDOCUMENTED_PUBLIC_EXECUTE', name, 'catalog says public but no entry in public_exceptions');
          else if (ex.signature !== name + '(' + dbTypes.join(',') + ')') fail('PUBLIC_EXCEPTION_SIGNATURE', name, `exception signature ${ex.signature} vs ${f.key}`);
          if (!eff('anon')) fail('AUTH_CONTRACT', name, 'public RPC is not executable by anon');
          if (meta.kind !== 'read_only') fail('AUTH_CONTRACT', name, 'public RPC must be read_only');
        }
        if (meta.auth_enforcement !== 'public' && meta.auth_enforcement !== facts.authEnforcement) {
          fail('AUTH_CONTRACT', name, `catalog auth_enforcement=${meta.auth_enforcement} vs body analysis=${facts.authEnforcement}`);
        }
        // mutation / read-only classification by observed effect
        const mutates = facts.directDml || businessMutating(f);
        const derived = mutates ? 'mutation' : 'read_only';
        if (meta.kind !== derived) fail('KIND_MISMATCH', name, `catalog kind=${meta.kind} but function body is ${derived} (${facts.directDml ? 'direct DML' : 'no DML' + (mutates ? ' / mutating callee' : '')})`);
        // rate-limit metadata
        const ops = [...new Set(facts.rateLimitOps)];
        if ('rate_limit' in meta) {
          if (meta.rate_limit === null) {
            if (ops.length) fail('RATE_LIMIT_METADATA', name, `catalog rate_limit=null but body calls require_rate_limit(${ops.join(', ')})`);
          } else {
            if (ops.length !== 1 || ops[0] !== meta.rate_limit) fail('RATE_LIMIT_METADATA', name, `catalog rate_limit=${meta.rate_limit} vs body require_rate_limit(${ops.join(', ') || 'none'})`);
            if (!rlBranches.has(meta.rate_limit)) fail('RATE_LIMIT_METADATA', name, `operation "${meta.rate_limit}" has no explicit WHEN branch in final check_rate_limit`);
          }
        }
      } else if (sec === 'internal_helpers') {
        if (meta.client_callable !== false) fail('HELPER_CALLABLE', name, 'internal helper must declare client_callable=false');
        for (const r of ['PUBLIC', 'anon', 'authenticated']) if (eff(r)) fail('HELPER_CALLABLE', name, `internal helper is EXECUTE-able by ${r}`);
      } else if (sec === 'rls_predicates') {
        if (!eff('authenticated')) fail('ACL_AUTHENTICATED_MISSING', name, 'RLS predicate must be EXECUTE-able by authenticated (policies run as the caller)');
        if (f.acl.PUBLIC) fail('UNDOCUMENTED_PUBLIC_EXECUTE', name, 'PUBLIC has EXECUTE on an RLS predicate');
        else if (eff('anon')) fail('ANON_EXECUTE', name, 'anon has EXECUTE on an RLS predicate (all policies using it are TO authenticated)');
      } else if (sec === 'trigger_functions') {
        if (callable) fail('TRIGGER_CONTRACT', name, 'trigger function reported callable');
      }
    }
  }

  // ── 4. every database function must be classified; client-callable ones must be catalogued ──
  for (const f of state.funcs.values()) {
    const sec = allNames.get(f.name);
    if (!sec) {
      fail(isCallable(state, f) ? 'UNDOCUMENTED_CALLABLE' : 'UNDOCUMENTED_FUNCTION', f.key,
        `database function in schema public is not in the catalog (callable by: ${['PUBLIC', 'anon', 'authenticated'].filter(r => state.effectiveExecute(f, r)).join(',') || 'nobody'})`);
      continue;
    }
    const meta = ({ rpcs, internal_helpers: helpers, rls_predicates: preds, trigger_functions: trigs })[sec][f.name];
    if (meta.signature && f.key !== meta.signature && state.byName(f.name).length === 1) {
      /* reported as SIGNATURE_MISMATCH above */
    }
    if (meta.signature && f.key !== meta.signature && state.byName(f.name).length > 1) {
      /* extra overload: reported as UNEXPECTED_OVERLOAD above; also flag callability */
      if (isCallable(state, f)) fail('UNDOCUMENTED_CALLABLE', f.key, 'client-callable overload not described by the catalog');
    }
  }

  // PUBLIC / anon execute set must equal the documented exceptions exactly
  const exc = (privileges && privileges.public_exceptions) || [];
  for (const f of state.funcs.values()) {
    if (f.returns === 'trigger') continue;
    const anonOrPublic = state.effectiveExecute(f, 'PUBLIC') || state.effectiveExecute(f, 'anon');
    const documented = exc.some(e => e.function === f.name && e.signature === f.key);
    if (documented && !anonOrPublic) fail('PUBLIC_EXCEPTION_STALE', f.key, 'documented public exception is not actually public');
    if (f.acl.PUBLIC && !documented && isCallable(state, f)) {
      if (!findings.some(x => x.code === 'UNDOCUMENTED_PUBLIC_EXECUTE' && x.subject === f.name)) {
        fail('UNDOCUMENTED_PUBLIC_EXECUTE', f.key, 'PUBLIC has EXECUTE and the function is not a documented public exception');
      }
    }
  }
  for (const e of exc) {
    if (!state.byName(e.function).some(f => f.key === e.signature)) fail('PUBLIC_EXCEPTION_STALE', e.function, `documented exception ${e.signature} does not exist`);
  }

  // privilege inventory == catalog
  const invList = (privileges && privileges.functions) || [];
  const catSet = new Set(Object.keys(rpcs));
  for (const n of invList) if (!catSet.has(n)) fail('PRIVILEGE_INVENTORY_MISMATCH', n, 'in rpc_execute_privileges.functions but not in catalog');
  for (const n of catSet) if (!invList.includes(n)) fail('PRIVILEGE_INVENTORY_MISMATCH', n, 'in catalog but not in rpc_execute_privileges.functions');
  const ph = (privileges && privileges.internal_helpers) || {};
  for (const n of Object.keys(ph)) if (!helpers[n]) fail('PRIVILEGE_INVENTORY_MISMATCH', n, 'internal helper in privileges but not in catalog.internal_helpers');
  for (const n of Object.keys(helpers)) if (!ph[n]) fail('PRIVILEGE_INVENTORY_MISMATCH', n, 'catalog internal helper missing from privileges.internal_helpers');
  const pp = (privileges && privileges.rls_predicates) || {};
  for (const n of Object.keys(pp)) if (!preds[n]) fail('PRIVILEGE_INVENTORY_MISMATCH', n, 'rls predicate in privileges but not in catalog.rls_predicates');
  for (const n of Object.keys(preds)) if (!pp[n]) fail('PRIVILEGE_INVENTORY_MISMATCH', n, 'catalog rls predicate missing from privileges.rls_predicates');

  // ── 5. obsolete / historical overloads ──
  stats.obsoleteSignatures = obsolete.length;
  const obsSet = new Set(obsolete.map(o => o.signature));
  for (const sig of obsSet) {
    if (state.funcs.has(sig)) fail('OBSOLETE_OVERLOAD', sig, 'obsolete signature still exists in the final database state');
  }
  for (const [key, loc] of state.ever) {
    if (!state.funcs.has(key) && !obsSet.has(key)) fail('OBSOLETE_UNDOCUMENTED', key, `historical signature (created ${loc}) was dropped but is not listed in catalog.obsolete_signatures`);
  }
  for (const sig of obsSet) {
    if (!state.ever.has(sig)) fail('OBSOLETE_STALE', sig, 'listed as obsolete but never created by any migration');
  }

  // ── 6. frontend ↔ catalog ──
  const scan = scanFrontend(frontendFiles || []);
  stats.frontendCallSites = scan.calls.length;
  stats.dynamicResolved = scan.dynamic;
  stats.unresolved = scan.unresolved;
  const used = new Map();
  for (const u of scan.unresolved) fail('DYNAMIC_UNRESOLVED', `${u.file}:${u.line}`, u.reason);
  for (const c of scan.calls) {
    if (!used.has(c.name)) used.set(c.name, []);
    used.get(c.name).push(c);
    const loc = `${c.file}:${c.line}`;
    const meta = rpcs[c.name];
    if (!meta) {
      if (helpers[c.name] || trigs[c.name] || preds[c.name]) fail('FRONTEND_CALLS_NONCLIENT', c.name, `${loc} calls a function the catalog marks non-client (${allNames.get(c.name)})`);
      else fail('FRONTEND_NOT_IN_CATALOG', c.name, `${loc} calls an RPC that is not in the catalog`);
      continue;
    }
    if (c.keys === null) { stats.frontendKeysUnverifiable++; continue; }
    stats.frontendKeysVerified++;
    const unknown = c.keys.filter(k => !meta.args.includes(k));
    const missing = (meta.required || []).filter(k => !c.keys.includes(k));
    if (unknown.length) fail('FRONTEND_ARG_MISMATCH', c.name, `${loc} passes unknown argument(s) ${unknown.join(', ')}`);
    if (missing.length) fail('FRONTEND_ARG_MISMATCH', c.name, `${loc} omits required argument(s) ${missing.join(', ')}`);
  }
  stats.frontendDistinct = used.size;

  // ── 7. RLS policy ↔ function privilege (Phase 0.8: HARD findings, no longer advisory) ──
  // Policy expressions run as the CALLER, so PostgreSQL checks EXECUTE for every role the policy applies to.
  //  RLS_POLICY_EXECUTE   a policy calls a public function a policy role cannot EXECUTE
  //  RLS_HELPER_IN_POLICY a policy calls an internal helper (client_callable=false). The only way to make that work
  //                       is a grant, which would expose the helper through PostgREST /rpc → the predicate must be inlined.
  stats.rlsPoliciesChecked = 0;
  stats.rlsContradictions = 0;
  const policies = finalPolicies(migrations);
  const knownFns = new Set([...state.funcs.values()].map(f => f.name));
  const contradiction = (code, subject, msg) => { stats.rlsContradictions++; fail(code, subject, msg); };
  for (const p of policies) {
    stats.rlsPoliciesChecked++;
    const body = stripStrings(stripComments(p.text));
    const seen = new Set();
    for (const m of body.matchAll(/\b(?:public\.)?([a-z_][a-z0-9_]*)\s*\(/gi)) {
      const nm = m[1].toLowerCase();
      if (!knownFns.has(nm) || seen.has(nm)) continue;
      seen.add(nm);
      if (helpers[nm] || trigs[nm]) {
        contradiction('RLS_HELPER_IN_POLICY', `${p.table}/${p.name}`, `policy (${p.loc}) calls internal function ${nm}() — it cannot run as the caller without a grant that would expose it via supabase.rpc(); inline the predicate`);
      }
      for (const f of state.byName(nm)) {
        for (const role of p.roles) {
          const r = role === 'public' ? 'authenticated' : role;
          if (!state.effectiveExecute(f, r)) {
            contradiction('RLS_POLICY_EXECUTE', `${p.table}/${p.name}`, `policy (${p.loc}) calls ${f.key} but role "${r}" has no EXECUTE on it → "permission denied for function ${nm}" when that policy is evaluated`);
          }
        }
      }
    }
  }

  // ── 8. inlined-helper contract: the inlined predicate must stay equivalent to the helper and to the source table's RLS ──
  const normConj = (txt, alias, argName, policyCol) => splitConjuncts(txt).map(c => {
    let x = c.replace(/\s+/g, ' ').trim().toLowerCase();
    if (alias) x = x.split(alias.toLowerCase() + '.').join('');
    if (policyCol) x = x.split(policyCol.toLowerCase()).join('$arg');
    if (argName) x = x.replace(new RegExp('\\b' + argName.toLowerCase() + '\\b', 'g'), '$arg');
    return x;
  }).sort();
  const existsParts = txt => {
    const m = /EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+(?:public\.)?([a-z_]\w*)\s+([a-z_]\w*)\s+WHERE\s+([\s\S]*?)\)\s*;?\s*$/i.exec(txt.trim());
    return m ? { table: m[1].toLowerCase(), alias: m[2], where: m[3] } : null;
  };
  const policyUsing = p => { const m = /\bUSING\s*\(([\s\S]*)\)\s*$/i.exec(stripComments(p.text).trim()); return m ? m[1] : null; };
  const tablePrivs = tablePrivilegeState(migrations, ((privileges && privileges.rls_policy_contract) || {}).inlined_helpers || [], baseline);
  const inl = (privileges && privileges.rls_policy_contract && privileges.rls_policy_contract.inlined_helpers) || [];
  stats.inlinedHelperContracts = inl.length;
  for (const e of inl) {
    const bad = (msg) => fail('RLS_INLINE_CONTRACT', e.policy, msg);
    if (!helpers[e.helper]) { bad(`contract helper ${e.helper} is not in catalog.internal_helpers`); continue; }
    const pol = policies.find(p => p.table + '/' + p.name.toLowerCase() === e.policy);
    const src = policies.find(p => p.table === e.source_table && p.name.toLowerCase() === e.source_table + '_select');
    const hf = state.byName(e.helper)[0];
    if (!pol) { bad('policy does not exist in final state'); continue; }
    if (!hf) { bad('helper function does not exist in final state'); continue; }
    if (pol.roles.length !== 1 || pol.roles[0] !== 'authenticated') bad(`policy must be TO authenticated only (got ${pol.roles.join(',')})`);
    const pe = existsParts(policyUsing(pol) || '');
    const he = existsParts(stripComments(hf.body || ''));
    if (!pe) { bad('policy USING is not the inlined EXISTS(SELECT 1 FROM <table> <alias> WHERE …) form'); continue; }
    if (!he) { bad('helper body is not an EXISTS(SELECT 1 FROM <table> <alias> WHERE …) predicate; cannot prove equivalence'); continue; }
    if (pe.table !== e.source_table || he.table !== e.source_table) bad(`source table mismatch: policy=${pe.table} helper=${he.table} contract=${e.source_table}`);
    const polConj = normConj(pe.where, pe.alias, null, `${pol.table}.${e.policy_column}`);
    const helConj = normConj(he.where, he.alias, hf.args[0] && hf.args[0].name, null);
    if (JSON.stringify(polConj) !== JSON.stringify(helConj)) bad(`inlined predicate [${polConj.join(' AND ')}] is not equivalent to ${e.helper}() [${helConj.join(' AND ')}]`);
    if (!polConj.includes(`${e.key_column} = $arg`)) bad(`inlined predicate lacks key equality "${e.key_column} = <${e.policy_column}>"`);
    if (!src) bad(`source table ${e.source_table} has no SELECT policy`);
    else {
      const su = policyUsing(src);
      const srcConj = su ? normConj(su, null, null, null) : null;
      const extra = helConj.filter(c => c !== `${e.key_column} = $arg`);
      if (!srcConj || JSON.stringify(srcConj) !== JSON.stringify(extra)) bad(`${src.table}/${src.name} USING [${(srcConj || ['?']).join(' AND ')}] differs from the helper's row filter [${extra.join(' AND ')}] — the inlined subquery would not match the helper`);
      if (src.roles.indexOf('authenticated') < 0) bad(`${src.table}/${src.name} does not apply to authenticated`);
    }
    for (const [tbl, want] of Object.entries(e.table_privileges || {})) {
      const st = tablePrivs[tbl] || {};
      for (const [role, priv] of Object.entries(want)) {
        const have = st[role] || new Set();
        if (priv === 'NONE' && have.size) fail('RLS_TABLE_PRIVILEGE', `${tbl}/${role}`, `${role} must hold no privileges on ${tbl} (has ${[...have].join(',')})`);
        if (priv !== 'NONE' && !have.has(priv.toLowerCase())) fail('RLS_TABLE_PRIVILEGE', `${tbl}/${role}`, `${role} lacks ${priv} on ${tbl}; the inlined policy subquery runs as the caller and would fail with permission denied`);
      }
    }
  }
  for (const [nm, pol] of Object.entries(helpers)) {
    const ph2 = privileges && privileges.internal_helpers && privileges.internal_helpers[nm];
    if (ph2 && ph2.rls_policy_use !== 'forbidden') fail('RLS_INLINE_CONTRACT', nm, 'internal helper must declare rls_policy_use="forbidden" in rpc_execute_privileges.internal_helpers');
  }

  return { findings, advisories, stats, state };
}

module.exports = { verify, finalPolicies, bodyFacts, splitConjuncts };
