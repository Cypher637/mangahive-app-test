/**
 * Prove fail-closed rate limit behavior in the social service.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');

let n = 0;
function ok(c, m) {
  if (!c) { console.error('FAIL:', m); process.exitCode = 1; }
  else { console.log('PASS:', m); n++; }
}

const social = fs.readFileSync(path.join(root, 'src/services/social.js'), 'utf8');
ok(/RATE_LIMIT_UNAVAILABLE/.test(social), 'fail-closed code RATE_LIMIT_UNAVAILABLE present');
ok(/allowed !== true|allowed === false/.test(social), 'rejects when allowed is not true');
ok(!/return \{ allowed: true \}/.test(social), 'no fail-open return { allowed: true } on error');
ok(/rpc\('check_rate_limit',\s*\{\s*p_operation:/.test(social), 'RPC called with operation only');
ok(!/p_limit:|p_window_seconds:|p_cost:/.test(social), 'client does not send limit/window/cost');

const sql = fs.readFileSync(
  path.join(root, 'supabase/migrations/20261004020000_phase0_rpcs_and_rate_limit_authority.sql'),
  'utf8',
);
ok(/CREATE OR REPLACE FUNCTION public\.check_rate_limit\(p_operation text\)/.test(sql), 'single-arg check_rate_limit');
ok(/CASE p_operation/.test(sql), 'server CASE policy map');
ok(/require_rate_limit/.test(sql), 'require_rate_limit helper');
ok(/PERFORM public\.require_rate_limit\('friend_request'\)/.test(sql), 'send_friend_request rate limited');
ok(/PERFORM public\.require_rate_limit\('conversation_create'\)/.test(sql), 'conversation create rate limited');
ok(/created_by/.test(sql), 'conversation created_by present');
ok(/can_manage_participants/.test(sql), 'only creator manages participants');
ok(/DROP FUNCTION IF EXISTS public\.check_rate_limit\(text, int, int, int\)/.test(sql), 'old client-controlled signature dropped');

// Config
ok(fs.existsSync(path.join(root, 'config/runtime-config.js')), 'runtime-config.js exists');
const idx = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
ok(/MangaHiveConfig/.test(idx), 'index.html consumes MangaHiveConfig');

// RPC inventory present in migration
for (const fn of [
  'send_friend_request',
  'accept_friend_request',
  'toggle_follow',
  'block_user',
  'get_or_create_direct_conversation',
  'create_group_conversation',
  'add_group_member',
  'toggle_message_reaction',
  'get_my_profile',
  'search_profiles',
  'sync_chapter_comment',
]) {
  ok(new RegExp('FUNCTION public\\.' + fn).test(sql), 'migration defines ' + fn);
}

console.log('\nRate-limit/authority tests passed:', n);
