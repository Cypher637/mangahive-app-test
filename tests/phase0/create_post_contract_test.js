'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'contracts/rpc_catalog.json'), 'utf8'));
const files = fs.readdirSync(path.join(root, 'supabase/migrations')).filter(f => f.endsWith('.sql')).sort();
const sql = files.map(f => fs.readFileSync(path.join(root, 'supabase/migrations', f), 'utf8')).join('\n');
const p05 = fs.readFileSync(path.join(root, 'supabase/migrations/20261004080000_phase0_5_contract_and_privileges.sql'), 'utf8');
const idx = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
let n = 0;
function ok(c, m) { if (!c) { console.error('FAIL:', m); process.exitCode = 1; } else { console.log('PASS:', m); n++; } }

// Final create_post must use text series_id — take LAST definition
const parts = sql.split(/CREATE OR REPLACE FUNCTION public\.create_post\s*\(/i);
ok(parts.length >= 2, 'create_post defined');
const last = parts[parts.length - 1].slice(0, 800);
ok(/p_series_id\s+text/.test(last), 'final create_post p_series_id is text (not uuid)');
ok(!/p_series_id\s+uuid/.test(last), 'final create_post does not use uuid series_id');
// order: body, image, series_id, series_title, source, remote_id, cover_url, spoiler
ok(/p_body[\s\S]*p_image_url[\s\S]*p_series_id[\s\S]*p_series_title[\s\S]*p_source[\s\S]*p_remote_id[\s\S]*p_cover_url[\s\S]*p_spoiler/.test(last),
  'create_post argument order matches contract');
ok(catalog.rpcs.create_post.arg_types.p_series_id === 'text', 'catalog series_id type text');
ok(catalog.rpcs.create_post.signature.includes('boolean'), 'catalog signature ends with boolean spoiler');
// Frontend named args
ok(/p_series_id:\s*seriesId/.test(idx), 'frontend passes p_series_id');
ok(/p_spoiler:\s*!!spoiler/.test(idx), 'frontend passes p_spoiler');
// Drop wrong uuid overload
ok(/DROP FUNCTION IF EXISTS public\.create_post\(text, text, boolean, uuid/.test(p05), 'drops incorrect uuid overload');
console.log('\ncreate_post contract tests passed:', n);
