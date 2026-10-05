'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const p05 = fs.readFileSync(path.join(root, 'supabase/migrations/20261004080000_phase0_5_contract_and_privileges.sql'), 'utf8');
const priv = JSON.parse(fs.readFileSync(path.join(root, 'contracts/rpc_execute_privileges.json'), 'utf8'));
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'contracts/rpc_catalog.json'), 'utf8'));
let n = 0;
function ok(c, m) { if (!c) { console.error('FAIL:', m); process.exitCode = 1; } else { console.log('PASS:', m); n++; } }

ok(priv.internal_helpers.require_rate_limit.authenticated === 'REVOKE', 'require_rate_limit not client-callable');
ok(priv.internal_helpers.room_is_accessible.authenticated === 'REVOKE', 'room_is_accessible not client-callable');
ok(/REVOKE ALL ON FUNCTION public\.require_rate_limit\(text\) FROM authenticated/.test(p05), 'SQL revokes require_rate_limit from authenticated');
ok(/REVOKE ALL ON FUNCTION public\.room_is_accessible\(text\) FROM authenticated/.test(p05), 'SQL revokes room_is_accessible from authenticated');
ok(!catalog.rpcs.require_rate_limit, 'require_rate_limit not in client RPC catalog');
ok(!catalog.rpcs.room_is_accessible, 'room_is_accessible not in client RPC catalog');
ok(catalog.rpcs.app_schema_version.public_execute === true, 'app_schema_version public exception');
ok(priv.public_exceptions.some(e => e.function === 'app_schema_version'), 'public exception documented');
console.log('\nInternal helper privilege tests passed:', n);
