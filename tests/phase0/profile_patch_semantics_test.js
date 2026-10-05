'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const p05 = fs.readFileSync(path.join(root, 'supabase/migrations/20261004080000_phase0_5_contract_and_privileges.sql'), 'utf8');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'contracts/rpc_catalog.json'), 'utf8'));
const idx = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
let n = 0;
function ok(c, m) { if (!c) { console.error('FAIL:', m); process.exitCode = 1; } else { console.log('PASS:', m); n++; } }

ok(/update_my_profile\(p_patch jsonb\)/.test(p05), 'signature is update_my_profile(jsonb)');
ok(/jsonb_object_keys/.test(p05), 'rejects unknown keys via key scan');
ok(/p_patch \? 'username'/.test(p05), 'missing key preserves (only apply if key present)');
ok(/p_patch->'username' = 'null'::jsonb/.test(p05), 'JSON null clears username');
ok(catalog.rpcs.update_my_profile.patch_semantics.missing_key === 'preserve', 'catalog documents preserve');
ok(catalog.rpcs.update_my_profile.patch_semantics.null === 'clear', 'catalog documents clear');
ok(/p_patch:\s*patch|p_patch:\s*\{/.test(idx), 'frontend sends p_patch');
ok(!/p_username:/.test(idx) || !/update_my_profile[\s\S]{0,200}p_username:/.test(idx), 'frontend no longer uses p_username args');
ok(/profiles_username_lower_uidx/.test(p05), 'username uniqueness index');
console.log('\nProfile patch semantics tests passed:', n);
