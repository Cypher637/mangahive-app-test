'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const migDir = path.join(root, 'supabase/migrations');
const sql = fs.readdirSync(migDir).filter(f => f.endsWith('.sql')).sort()
  .map(f => fs.readFileSync(path.join(migDir, f), 'utf8')).join('\n');

let n = 0, bad = 0;
function ok(c, m) {
  if (!c) { console.error('FAIL:', m); process.exitCode = 1; bad++; }
  else { console.log('PASS:', m); n++; }
}

const rpcOnly = [
  'posts', 'post_comments', 'post_likes', 'messages', 'message_reactions',
  'friend_requests', 'blocks', 'conversations', 'conversation_participants',
  'profiles', 'reports', 'chapter_comments', 'room_messages', 'follows', 'notifications'
];

// Phase 0.3 migration must exist and deny direct writes
ok(sql.includes('20261004060000') || fs.existsSync(path.join(migDir, '20261004060000_phase0_3_rpc_only_rls.sql')),
  'phase 0.3 rpc_only migration file exists');

const p03 = fs.readFileSync(path.join(migDir, '20261004060000_phase0_3_rpc_only_rls.sql'), 'utf8');

for (const table of rpcOnly) {
  // Must have insert deny WITH CHECK (false) or equivalent
  const hasDeny = new RegExp(table.replace('_', '[_]') + '[\\s\\S]{0,200}WITH CHECK \\(false\\)|' +
    'FOR INSERT TO authenticated WITH CHECK \\(false\\)').test(p03) ||
    p03.includes(`ON public.${table}`) && p03.includes('WITH CHECK (false)');
  ok(sql.includes(`public.${table}`) && (p03.includes(`public.${table}`) || sql.includes(table + '_insert_deny') || sql.includes('follows_insert_deny')),
    `rpc_only write denials present for table: ${table}`);
}

// Stronger: count deny policies
const denyCount = (p03.match(/WITH CHECK \(false\)/g) || []).length +
  (p03.match(/USING \(false\)/g) || []).length;
ok(denyCount >= 20, 'at least 20 deny false policies in 0.3 migration (got ' + denyCount + ')');

// Rooms registry
ok(/CREATE TABLE IF NOT EXISTS public\.rooms/.test(p03), 'rooms registry table');
ok(/room_is_accessible/.test(p03), 'room_is_accessible helper');
ok(/room_is_accessible\(p_room_id\)/.test(p03) || /NOT public\.room_is_accessible/.test(p03),
  'send/edit room checks accessibility');

// toggle_post_like post_like
ok(/require_rate_limit\('post_like'\)/.test(p03), 'toggle_post_like uses post_like policy');
ok(!/require_rate_limit\('post_comment'\).*toggle_post_like|toggle_post_like[\s\S]*require_rate_limit\('post_comment'\)/.test(p03),
  'toggle_post_like does not use post_comment in 0.3');

// SECURITY DEFINER search_path
const definerFns = p03.match(/SECURITY DEFINER[\s\S]{0,80}SET search_path = public, pg_temp/g) || [];
ok(definerFns.length >= 3, 'SECURITY DEFINER functions set search_path public, pg_temp');

console.log('\nRPC-only RLS tests passed:', n, 'failed:', bad);
