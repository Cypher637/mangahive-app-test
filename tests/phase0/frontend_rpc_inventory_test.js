'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'contracts/rpc_catalog.json'), 'utf8'));
const sources = [];
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (['node_modules','android','docs','tests','supabase','.git'].includes(name)) continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p);
    else if (/\.(js|html)$/.test(name)) sources.push(p);
  }
}
walk(root);
const found = new Set();
for (const file of sources) {
  const src = fs.readFileSync(file, 'utf8');
  let m;
  const lit = /\.rpc\s*\(\s*['"]([A-Za-z0-9_]+)['"]/g;
  while ((m = lit.exec(src)) !== null) found.add(m[1]);
  // dynamic: var rpc = cond ? "a" : "b"  near .rpc(rpc
  const tern = /=\s*[^;]*\?\s*['"]([A-Za-z0-9_]+)['"]\s*:\s*['"]([A-Za-z0-9_]+)['"]/g;
  while ((m = tern.exec(src)) !== null) {
    // only if rpc-ish context within 200 chars of .rpc(
    const around = src.slice(Math.max(0, m.index - 80), m.index + 120);
    if (/\.rpc\s*\(|\brpc\b/.test(around)) {
      found.add(m[1]); found.add(m[2]);
    }
  }
}
const list = [...found].filter(n => n !== 'dm' && n !== 'room' && n.length > 2).sort();
let n = 0, bad = 0;
function ok(c, m) { if (!c) { console.error('FAIL:', m); process.exitCode = 1; bad++; } else { console.log('PASS:', m); n++; } }

ok(list.includes('app_schema_version'), 'discovers app_schema_version (no name filter)');
ok(list.includes('edit_message') && list.includes('edit_room_message'), 'dynamic edit_* pair');
ok(list.includes('toggle_follow'), 'toggle_follow');
ok(list.includes('create_post'), 'create_post');
ok(list.includes('update_my_profile'), 'update_my_profile');

const missing = list.filter(name => !catalog.rpcs[name]);
ok(missing.length === 0, 'all discovered RPCs catalogued (missing: ' + missing.join(',') + ')');

for (const name of list) {
  const meta = catalog.rpcs[name];
  if (!meta) continue;
  ok(meta.kind === 'mutation' || meta.kind === 'read_only', name + ' classified');
}
console.log('frontend RPCs:', list.join(', '));
console.log('\nFrontend inventory passed:', n, 'failed:', bad);
