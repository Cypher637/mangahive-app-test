'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const st = JSON.parse(fs.readFileSync(path.join(root, 'contracts/sensitive_tables.json'), 'utf8'));
const mig = fs.readdirSync(path.join(root, 'supabase/migrations')).filter(f => f.endsWith('.sql')).sort()
  .map(f => fs.readFileSync(path.join(root, 'supabase/migrations', f), 'utf8')).join('\n');
const p04 = fs.readFileSync(path.join(root, 'supabase/migrations/20261004070000_phase0_4_security_and_verification_closure.sql'), 'utf8');
let n = 0;
function ok(c, m) { if (!c) { console.error('FAIL:', m); process.exitCode = 1; } else { console.log('PASS:', m); n++; } }

ok(st.tables.follows && st.tables.follows.policy === 'rpc_only', 'follows classified rpc_only');
ok(st.tables.follows.rpc.includes('toggle_follow'), 'toggle_follow is declared mutation path');
ok(/DROP POLICY IF EXISTS follows_insert_own/.test(p04), 'follows_insert_own dropped');
ok(/DROP POLICY IF EXISTS follows_delete_own/.test(p04), 'follows_delete_own dropped');
ok(/follows_insert_deny[\s\S]*WITH CHECK \(false\)/.test(p04), 'follows INSERT deny');
ok(/follows_delete_deny[\s\S]*USING \(false\)/.test(p04), 'follows DELETE deny');
ok(/FUNCTION public\.toggle_follow\(p_target uuid\)/.test(mig), 'toggle_follow RPC exists');
ok(/require_rate_limit\('follow'\)/.test(p04), 'toggle_follow rate limited');
ok(/REVOKE ALL ON FUNCTION public\.toggle_follow\(uuid\) FROM PUBLIC/.test(p04), 'PUBLIC execute revoked');
ok(/GRANT EXECUTE ON FUNCTION public\.toggle_follow\(uuid\) TO authenticated/.test(p04), 'authenticated execute granted');
console.log('\nFollows RPC-only tests passed:', n);
