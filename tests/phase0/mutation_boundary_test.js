'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const st = JSON.parse(fs.readFileSync(path.join(root, 'contracts/sensitive_tables.json'), 'utf8'));
const p04 = fs.readFileSync(path.join(root, 'supabase/migrations/20261004070000_phase0_4_security_and_verification_closure.sql'), 'utf8');
let n = 0;
function ok(c, m) { if (!c) { console.error('FAIL:', m); process.exitCode = 1; } else { console.log('PASS:', m); n++; } }

ok(st.tables.follows.policy === 'rpc_only', 'follows rpc_only');
ok(st.tables.notifications.policy === 'rpc_only', 'notifications rpc_only');
ok(/profiles_username_lower_uidx/.test(p04), 'username unique index migration');
ok(/lower\(username\)/.test(p04), 'case-insensitive username uniqueness');
ok(/notif_update_deny|notifications[\s\S]{0,80}USING \(false\)/.test(p04), 'notifications direct UPDATE denied');
ok(/https:\/\//.test(p04) && /v_image/.test(p04), 'post image URL https enforced');
ok(/require_rate_limit\('post_create'\)/.test(p04), 'create_post rate limited');
ok(/DROP FUNCTION IF EXISTS public\.toggle_message_reaction\(uuid, text\)/.test(p04), 'obsolete toggle_message_reaction dropped');
ok(/DROP FUNCTION IF EXISTS public\.get_public_profile\(uuid\)/.test(p04), 'obsolete get_public_profile(uuid) dropped');
console.log('\nMutation boundary tests passed:', n);
