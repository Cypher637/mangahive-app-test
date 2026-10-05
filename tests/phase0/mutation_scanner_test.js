'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');

const SENSITIVE = Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'contracts/sensitive_tables.json'), 'utf8')).tables);
const MUT_OPS = ['insert', 'update', 'delete', 'upsert'];
const EXCLUDE_DIR = new Set(['node_modules', 'vendor', '.git', 'android', 'docs', 'tests', 'supabase']);
const EXCLUDE_FILE = /vendor-supabase|sw\.js$/;

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    if (EXCLUDE_DIR.has(name)) continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(js|html|mjs|cjs|ts)$/.test(name) && !EXCLUDE_FILE.test(name)) out.push(p);
  }
  return out;
}

const files = walk(root, []);
let n = 0, bad = 0;
function ok(c, m) {
  if (!c) { console.error('FAIL:', m); process.exitCode = 1; bad++; }
  else { console.log('PASS:', m); n++; }
}

const findings = [];
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const rel = path.relative(root, file);
  // literal sensitive mutations
  for (const table of SENSITIVE) {
    for (const op of MUT_OPS) {
      const re = new RegExp('from\\s*\\(\\s*[\\\'"`]' + table + '[\\\'"`]\\s*\\)\\s*\\.' + op, 'i');
      if (re.test(src)) findings.push({ rel, kind: 'literal', table, op });
    }
  }
  // dynamic: from(variable).insert|update|delete|upsert
  const dyn = /from\s*\(\s*[a-zA-Z_$][\w$]*\s*\)\s*\.\s*(insert|update|delete|upsert)\s*\(/g;
  let m;
  while ((m = dyn.exec(src)) !== null) {
    // allow if line is only inside a comment about removal
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    const line = src.slice(lineStart, src.indexOf('\n', m.index));
    if (/bkInsertMsgRow removed|no generic|Phase 0\.2/.test(line)) continue;
    findings.push({ rel, kind: 'dynamic', op: m[1], snippet: line.trim().slice(0, 120) });
  }
  // forbidden helper names
  if (/\bfunction\s+bkInsertMsgRow\b/.test(src)) findings.push({ rel, kind: 'helper', name: 'bkInsertMsgRow' });
}

ok(!/\bfunction\s+bkInsertMsgRow\b/.test(fs.readFileSync(path.join(root, 'index.html'), 'utf8')), 'bkInsertMsgRow function absent');
ok(findings.filter(f => f.kind === 'literal').length === 0, 'no literal sensitive mutations (' + findings.filter(f => f.kind === 'literal').length + ')');
ok(findings.filter(f => f.kind === 'dynamic').length === 0, 'no dynamic table mutations (' + findings.filter(f => f.kind === 'dynamic').map(f => f.rel + ':' + f.op).join('; ') + ')');
ok(findings.filter(f => f.kind === 'helper').length === 0, 'no mutation helper functions');

// edit_message must exist in migrations
const mig = fs.readdirSync(path.join(root, 'supabase/migrations')).map(f => fs.readFileSync(path.join(root, 'supabase/migrations', f), 'utf8')).join('\n');
ok(/FUNCTION public\.edit_message\b/.test(mig), 'edit_message RPC in migrations');
ok(/FUNCTION public\.edit_room_message\b/.test(mig), 'edit_room_message RPC in migrations');
ok(/DROP FUNCTION IF EXISTS public\.toggle_message_reaction\(uuid, text\)/.test(mig), 'obsolete toggle overload dropped');

// config: index must not hardcode production project URL as assignment
const idx = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
ok(!/var SUPABASE_URL\s*=\s*"https:\/\//.test(idx), 'index does not hardcode SUPABASE_URL string');
ok(fs.existsSync(path.join(root, 'config/runtime-config.js')), 'runtime-config.js exists');
ok(/src=["']config\/runtime-config\.js["']/.test(idx), 'index loads runtime-config.js');

console.log('files scanned:', files.length);
console.log('Mutation scanner passed:', n, 'failures:', bad);
if (findings.length) console.log('findings', findings);
