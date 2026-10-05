'use strict';
/**
 * Phase 0.7 — verifier SELF-TEST.
 *
 * Proves the RPC verifier (lib/rpc_verifier.js) is not vacuous: each case below applies ONE
 * mutation to a private deep copy of the real inputs (catalog JSON, privilege JSON, migration SQL text,
 * frontend source text) and requires the verifier to FAIL with the expected finding code.
 *
 * Mutations live only in memory — no repository file is ever written, so there is nothing to clean up.
 * A positive control (unmutated inputs → zero findings) guards against a verifier that always fails
 * or a mutation that is a silent no-op.
 */
const { loadRepo } = require('./lib/load_repo');
const { verify } = require('./lib/rpc_verifier');

let n = 0, bad = 0;
function ok(c, m) {
  if (!c) { console.error('FAIL:', m); process.exitCode = 1; bad++; }
  else { console.log('PASS:', m); n++; }
}

const base = loadRepo();
const clone = () => JSON.parse(JSON.stringify({
  catalog: base.catalog, privileges: base.privileges, migrations: base.migrations, frontendFiles: base.frontendFiles,
}));

// positive control
const control = verify(clone());
ok(control.findings.length === 0, 'control: unmutated inputs produce ZERO findings (' + control.findings.length + ')');

/** sql edit helper: asserts the text really changed (a no-op mutation would make the case meaningless) */
function editSql(inp, file, from, to) {
  const m = inp.migrations.find(x => x.name.includes(file));
  if (!m) throw new Error('migration not found: ' + file);
  const next = typeof from === 'string' ? m.sql.replace(from, to) : m.sql.replace(from, to);
  if (next === m.sql) throw new Error('mutation had no effect on ' + file);
  m.sql = next;
}
const addMigration = (inp, sql) => inp.migrations.push({ name: '29991231000000_selftest_mutation.sql', sql });

function expectFail(label, code, mutate, subjectRe) {
  const inp = clone();
  mutate(inp);
  const r = verify(inp);
  const hits = r.findings.filter(f => f.code === code && (!subjectRe || subjectRe.test(f.subject + ' ' + f.msg)));
  ok(r.findings.length > 0 && hits.length > 0, `${label} → verifier FAILS with ${code}` + (hits[0] ? ` ("${hits[0].subject}: ${hits[0].msg.slice(0, 110)}")` : ` (got: ${[...new Set(r.findings.map(f => f.code))].join(',') || 'nothing'})`));
}

// ───────────── the 10 required negative cases ─────────────
// 1. wrong argument type (catalog side, signature kept self-consistent so ONLY the DB comparison can catch it)
expectFail('1. wrong argument type (catalog says create_post.p_body is uuid)', 'ARG_TYPE', inp => {
  const m = inp.catalog.rpcs.create_post;
  m.arg_types.p_body = 'uuid';
  m.signature = 'create_post(' + Object.values(m.arg_types).join(',') + ')';
}, /create_post/);
expectFail('1b. wrong argument type (database side: migration declares p_spoiler as text)', 'ARG_TYPE', inp => {
  editSql(inp, '080000', /p_spoiler\s+boolean/, 'p_spoiler text');
}, /create_post|p_spoiler/);

// 2. wrong argument order
expectFail('2. wrong argument order (catalog swaps send_message.p_conversation_id / p_body)', 'ARG_ORDER', inp => {
  const m = inp.catalog.rpcs.send_message;
  m.args = ['p_body', 'p_conversation_id', 'p_reply_to_message_id'];
  m.arg_types = { p_body: 'text', p_conversation_id: 'uuid', p_reply_to_message_id: 'uuid' };
  m.signature = 'send_message(text,uuid,uuid)';
}, /send_message/);

// 3. wrong return type
expectFail('3. wrong return type (catalog says create_post returns text)', 'RETURN_TYPE', inp => {
  inp.catalog.rpcs.create_post.returns = 'text';
}, /create_post/);

// 4. unexpected overload
expectFail('4. unexpected overload (extra toggle_follow(uuid, text) created)', 'UNEXPECTED_OVERLOAD', inp => {
  addMigration(inp, `CREATE FUNCTION public.toggle_follow(p_target uuid, p_note text) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ SELECT '{}'::jsonb $$;`);
}, /toggle_follow/);

// 5. obsolete overload (the DROP of the uuid-series create_post overload is removed → it survives)
expectFail('5. obsolete overload (DROP of create_post(text,text,boolean,uuid,…) removed)', 'OBSOLETE_OVERLOAD', inp => {
  editSql(inp, '080000', 'DROP FUNCTION IF EXISTS public.create_post(text, text, boolean, uuid, text, text, text, text);', '');
}, /create_post/);
expectFail('5b. obsolete overload re-created after its DROP', 'OBSOLETE_OVERLOAD', inp => {
  addMigration(inp, `CREATE FUNCTION public.get_public_profile(p_user_id uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ SELECT '{}'::jsonb $$;`);
}, /get_public_profile/);

// 6. missing catalog entry (function exists in DB and frontend, catalog entry deleted)
expectFail('6. missing catalog entry (toggle_follow removed from catalog) — DB side', 'UNDOCUMENTED_CALLABLE', inp => {
  delete inp.catalog.rpcs.toggle_follow;
}, /toggle_follow/);
expectFail('6b. missing catalog entry (toggle_follow removed from catalog) — frontend side', 'FRONTEND_NOT_IN_CATALOG', inp => {
  delete inp.catalog.rpcs.toggle_follow;
}, /toggle_follow/);

// 7. nonexistent catalog RPC
expectFail('7. nonexistent catalog RPC (ghost_rpc listed, no function)', 'CATALOG_NOT_IN_DB', inp => {
  inp.catalog.rpcs.ghost_rpc = JSON.parse(JSON.stringify(inp.catalog.rpcs.delete_post));
  inp.catalog.rpcs.ghost_rpc.signature = 'ghost_rpc(uuid)';
}, /ghost_rpc/);

// 8. undocumented PUBLIC EXECUTE
expectFail('8. undocumented PUBLIC EXECUTE (GRANT … delete_post(uuid) TO PUBLIC)', 'UNDOCUMENTED_PUBLIC_EXECUTE', inp => {
  addMigration(inp, 'GRANT EXECUTE ON FUNCTION public.delete_post(uuid) TO PUBLIC;');
}, /delete_post/);
expectFail('8b. undocumented PUBLIC EXECUTE (new function created and never revoked)', 'UNDOCUMENTED_CALLABLE', inp => {
  addMigration(inp, `CREATE FUNCTION public.leaky_helper(x int) RETURNS int LANGUAGE sql AS $$ SELECT x $$;`);
}, /leaky_helper/);
expectFail('8c. anon EXECUTE regained via explicit GRANT', 'ANON_EXECUTE', inp => {
  addMigration(inp, 'GRANT EXECUTE ON FUNCTION public.delete_post(uuid) TO anon;');
}, /delete_post/);

// 9. incorrect SECURITY DEFINER status
expectFail('9. incorrect SECURITY DEFINER (catalog says toggle_follow is NOT definer)', 'SECURITY_DEFINER', inp => {
  inp.catalog.rpcs.toggle_follow.security_definer = false;
}, /toggle_follow/);
expectFail('9b. incorrect SECURITY DEFINER (ALTER FUNCTION delete_post(uuid) SECURITY INVOKER)', 'SECURITY_DEFINER', inp => {
  addMigration(inp, 'ALTER FUNCTION public.delete_post(uuid) SECURITY INVOKER;');
}, /delete_post/);

// 10. missing rate-limit metadata
expectFail('10. missing rate-limit metadata (send_message.rate_limit removed)', 'RATE_LIMIT_METADATA', inp => {
  delete inp.catalog.rpcs.send_message.rate_limit;
}, /send_message/);
expectFail('10b. wrong rate-limit metadata (create_post claims no rate limit)', 'RATE_LIMIT_METADATA', inp => {
  inp.catalog.rpcs.create_post.rate_limit = null;
  inp.catalog.rpcs.create_post.rate_limit_reason = 'selftest';
}, /create_post/);
expectFail('10c. rate-limit operation with no WHEN branch in check_rate_limit', 'RATE_LIMIT_METADATA', inp => {
  inp.catalog.rpcs.toggle_follow.rate_limit = 'no_such_operation';
}, /no_such_operation|toggle_follow/);

// ───────────── additional negative cases for the rest of the chain ─────────────
expectFail('11. incomplete catalog entry (arg_types removed) is NOT skipped', 'CATALOG_INCOMPLETE', inp => {
  delete inp.catalog.rpcs.delete_post.arg_types;
}, /delete_post/);
expectFail('12. wrong argument count (catalog drops a trailing arg)', 'ARG_COUNT', inp => {
  const m = inp.catalog.rpcs.add_post_comment;
  m.args = ['p_post_id']; m.arg_types = { p_post_id: 'uuid' }; m.signature = 'add_post_comment(uuid)'; m.required = ['p_post_id'];
}, /add_post_comment/);
expectFail('13. incorrect mutation/read classification (delete_post marked read_only)', 'KIND_MISMATCH', inp => {
  inp.catalog.rpcs.delete_post.kind = 'read_only';
}, /delete_post/);
expectFail('13b. incorrect classification (get_my_profile marked mutation)', 'KIND_MISMATCH', inp => {
  inp.catalog.rpcs.get_my_profile.kind = 'mutation';
  inp.catalog.rpcs.get_my_profile.rate_limit_reason = 'selftest reason';
}, /get_my_profile/);
expectFail('14. incorrect authentication contract (delete_post claims acl_only)', 'AUTH_CONTRACT', inp => {
  inp.catalog.rpcs.delete_post.auth_enforcement = 'acl_only';
}, /delete_post/);
expectFail('14b. authenticated EXECUTE revoked from a client RPC', 'ACL_AUTHENTICATED_MISSING', inp => {
  addMigration(inp, 'REVOKE EXECUTE ON FUNCTION public.delete_post(uuid) FROM authenticated;');
}, /delete_post/);
expectFail('15. replay honours DROP FUNCTION (delete_post dropped → catalog RPC missing from DB)', 'CATALOG_NOT_IN_DB', inp => {
  addMigration(inp, 'DROP FUNCTION public.delete_post(uuid);');
}, /delete_post/);
expectFail('16. migration that PostgreSQL would reject (CREATE OR REPLACE renames a parameter)', 'MIGRATION_ERROR', inp => {
  addMigration(inp, `CREATE OR REPLACE FUNCTION public.delete_post(p_other_name uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ SELECT '{}'::jsonb $$;`);
}, /42P13|rename|name of input parameter/);
expectFail('16b. unknown DO block is reported, never silently skipped', 'MIGRATION_ERROR', inp => {
  addMigration(inp, `DO $$ BEGIN EXECUTE 'GRANT EXECUTE ON FUNCTION public.delete_post(uuid) TO PUBLIC'; END $$;`);
}, /DO block/);
expectFail('17. unresolved dynamic RPC name fails with file:line', 'DYNAMIC_UNRESOLVED', inp => {
  inp.frontendFiles.push({ path: 'src/selftest_dynamic.js', src: 'function go(sb, x){\n  return sb.rpc(pick(x) + "_post", {});\n}\n' });
}, /src\/selftest_dynamic\.js:2/);
expectFail('17b. aliasing sb.rpc is not silently ignored', 'DYNAMIC_UNRESOLVED', inp => {
  inp.frontendFiles.push({ path: 'src/selftest_alias.js', src: 'var f = sb.rpc;\nf("delete_post", {});\n' });
}, /src\/selftest_alias\.js:1/);
expectFail('18. frontend calls an RPC missing from the catalog', 'FRONTEND_NOT_IN_CATALOG', inp => {
  inp.frontendFiles.push({ path: 'src/selftest_unknown.js', src: 'sb.rpc("brand_new_rpc", {});\n' });
}, /brand_new_rpc/);
expectFail('19. frontend passes a wrong argument key', 'FRONTEND_ARG_MISMATCH', inp => {
  inp.frontendFiles.push({ path: 'src/selftest_args.js', src: 'sb.rpc("delete_post", { post_id: 1 });\n' });
}, /delete_post/);
expectFail('20. frontend calls an internal helper', 'FRONTEND_CALLS_NONCLIENT', inp => {
  inp.frontendFiles.push({ path: 'src/selftest_helper.js', src: 'sb.rpc("require_rate_limit", { p_operation: "x" });\n' });
}, /require_rate_limit/);
expectFail('21. internal helper made client-callable', 'HELPER_CALLABLE', inp => {
  addMigration(inp, 'GRANT EXECUTE ON FUNCTION public.require_rate_limit(text) TO authenticated;');
}, /require_rate_limit/);
expectFail('22. undocumented historical signature (obsolete list entry removed)', 'OBSOLETE_UNDOCUMENTED', inp => {
  inp.catalog.obsolete_signatures = inp.catalog.obsolete_signatures.filter(o => o.signature !== 'block_user_by_target(uuid)');
}, /block_user_by_target/);
expectFail('23. platform baseline must be declared (anon default grants are not assumed away)', 'BASELINE_MISSING', inp => {
  delete inp.privileges.platform_baseline;
});

// the documented exception must survive and must be the ONLY thing that is public
const keep = clone();
const r = verify(keep);
ok(r.findings.length === 0 && keep.privileges.public_exceptions.some(e => e.function === 'app_schema_version'), 'documented app_schema_version() PUBLIC exception still passes and is the only PUBLIC/anon-executable RPC');
expectFail('24. a documented public exception that is no longer public is flagged stale', 'PUBLIC_EXCEPTION_STALE', inp => {
  addMigration(inp, 'REVOKE ALL ON FUNCTION public.app_schema_version() FROM PUBLIC; REVOKE ALL ON FUNCTION public.app_schema_version() FROM anon;');
}, /app_schema_version/);


// ───────────── Phase 0.8: RLS execution boundary ─────────────
const MIG08 = '100000';
expectFail('25. 0.8 migration removed → room_msg_select calls the revoked internal helper (old defect)', 'RLS_HELPER_IN_POLICY', inp => {
  inp.migrations = inp.migrations.filter(m => !m.name.includes(MIG08));
}, /room_messages\/room_msg_select/);
expectFail('25b. same defect also reported as an EXECUTE contradiction', 'RLS_POLICY_EXECUTE', inp => {
  inp.migrations = inp.migrations.filter(m => !m.name.includes(MIG08));
}, /room_is_accessible/);
expectFail('26. fix by granting EXECUTE on the helper to authenticated is rejected (helper becomes client-callable)', 'HELPER_CALLABLE', inp => {
  addMigration(inp, 'GRANT EXECUTE ON FUNCTION public.room_is_accessible(text) TO authenticated;');
}, /room_is_accessible/);
expectFail('26b. fix by granting EXECUTE to anon is rejected', 'HELPER_CALLABLE', inp => {
  addMigration(inp, 'GRANT EXECUTE ON FUNCTION public.room_is_accessible(text) TO anon;');
}, /room_is_accessible/);
expectFail('26c. fix by granting EXECUTE to PUBLIC is rejected', 'HELPER_CALLABLE', inp => {
  addMigration(inp, 'GRANT EXECUTE ON FUNCTION public.room_is_accessible(text) TO PUBLIC;');
}, /room_is_accessible/);
expectFail('27. helper re-introduced into a policy later', 'RLS_HELPER_IN_POLICY', inp => {
  addMigration(inp, 'DROP POLICY IF EXISTS room_msg_select ON public.room_messages; CREATE POLICY room_msg_select ON public.room_messages FOR SELECT TO authenticated USING (public.room_is_accessible(room_id));');
}, /room_msg_select/);
expectFail('28. helper referenced WITHOUT the public. prefix is still caught', 'RLS_HELPER_IN_POLICY', inp => {
  addMigration(inp, 'DROP POLICY IF EXISTS room_msg_select ON public.room_messages; CREATE POLICY room_msg_select ON public.room_messages FOR SELECT TO authenticated USING (room_is_accessible(room_id));');
}, /room_msg_select/);
expectFail('29. inlined predicate weakened (visibility check dropped)', 'RLS_INLINE_CONTRACT', inp => {
  editSql(inp, MIG08, "        AND r.visibility = 'public'\n", '');
}, /not equivalent/);
expectFail('29b. inlined predicate loses the room key equality', 'RLS_INLINE_CONTRACT', inp => {
  editSql(inp, MIG08, 'WHERE r.id = room_messages.room_id\n        AND', 'WHERE');
}, /equivalent|key equality/);
expectFail('30. rooms_select drifts from the helper filter (private rooms would become visible)', 'RLS_INLINE_CONTRACT', inp => {
  addMigration(inp, "DROP POLICY IF EXISTS rooms_select ON public.rooms; CREATE POLICY rooms_select ON public.rooms FOR SELECT TO authenticated USING (status = 'active');");
}, /rooms_select|differs/);
expectFail('31. authenticated loses table SELECT on rooms (subquery would be permission denied)', 'RLS_TABLE_PRIVILEGE', inp => {
  editSql(inp, MIG08, 'GRANT SELECT ON TABLE public.rooms TO authenticated;', '');
}, /rooms\/authenticated/);
expectFail('32. anon holds a privilege on rooms', 'RLS_TABLE_PRIVILEGE', inp => {
  addMigration(inp, 'GRANT SELECT ON TABLE public.rooms TO anon;');
}, /rooms\/anon/);
expectFail('33. room_msg_select widened to anon', 'RLS_INLINE_CONTRACT', inp => {
  editSql(inp, MIG08, 'FOR SELECT TO authenticated', 'FOR SELECT TO authenticated, anon');
}, /TO authenticated only/);
expectFail('34. room_is_accessible added to the client RPC catalog', 'CATALOG_INCONSISTENT', inp => {
  inp.catalog.rpcs.room_is_accessible = JSON.parse(JSON.stringify(inp.catalog.internal_helpers.room_is_accessible));
}, /room_is_accessible/);
expectFail('35. frontend calls room_is_accessible through supabase.rpc()', 'FRONTEND_CALLS_NONCLIENT', inp => {
  inp.frontendFiles.push({ path: 'src/selftest_room.js', src: 'sb.rpc("room_is_accessible", { p_room_id: "general" });\n' });
}, /room_is_accessible/);
expectFail('36. any policy calling a function its role cannot execute is a hard finding (generic rule)', 'RLS_POLICY_EXECUTE', inp => {
  addMigration(inp, "REVOKE ALL ON FUNCTION public.can_view_profile(uuid, text) FROM authenticated;");
}, /can_view_profile/);
expectFail('37. SECURITY DEFINER helper without pinned search_path', 'SEARCH_PATH_UNPINNED', inp => {
  addMigration(inp, "CREATE OR REPLACE FUNCTION public.room_is_accessible(p_room_id text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT EXISTS (SELECT 1 FROM public.rooms r WHERE r.id = p_room_id AND r.status = 'active' AND r.visibility = 'public') $$;");
}, /room_is_accessible/);

console.log('\nVerifier self-test passed:', n, 'failed:', bad);
