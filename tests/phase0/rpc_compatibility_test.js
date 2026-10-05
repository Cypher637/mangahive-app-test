/**
 * Detect frontend ↔ SQL RPC argument mismatches using rpc_catalog.json
 * and scanning index.html + migrations.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'contracts/rpc_catalog.json'), 'utf8'));
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const migrations = fs.readdirSync(path.join(root, 'supabase/migrations'))
  .filter((f) => f.endsWith('.sql'))
  .map((f) => fs.readFileSync(path.join(root, 'supabase/migrations', f), 'utf8'))
  .join('\n');

let n = 0;
let mismatches = 0;
function ok(c, m) {
  if (!c) { console.error('FAIL:', m); process.exitCode = 1; mismatches++; }
  else { console.log('PASS:', m); n++; }
}

// Extract frontend rpc calls: .rpc("name", { ... })
const callRe = /\.rpc\(\s*["']([a-z_]+)["']\s*,\s*\{([^}]*)\}/g;
const frontendCalls = [];
let m;
while ((m = callRe.exec(index)) !== null) {
  const name = m[1];
  const body = m[2];
  const keys = [...body.matchAll(/([a-z_][a-z0-9_]*)\s*:/gi)].map((x) => x[1]).filter((k) => k !== 'null' && k !== 'true' && k !== 'false' && (k.startsWith('p_') || k === 'other_user_id' || k === 'group_name' || k === 'member_ids' || k === 'target_id' || k === 'target_name' || k === 'q'));
  frontendCalls.push({ name, keys: [...new Set(keys)] });
}

ok(frontendCalls.length > 0, 'found frontend rpc calls: ' + frontendCalls.length);

const sensitiveTables = ['messages', 'posts', 'post_comments', 'post_likes', 'reports', 'friend_requests'];
for (const table of sensitiveTables) {
  const insertPat = new RegExp('from\\([\'"]' + table + '[\'"]\\)\\.insert');
  ok(!insertPat.test(index), 'no direct insert into ' + table);
}
ok(!/delete-message-fallback|from\([\'"]messages[\'"]\)\.delete/.test(index), 'no messages.delete fallback path');
ok(!/from\([\'"]friend_requests[\'"]\)\.delete/.test(index), 'no direct friend_requests.delete');
ok(!/from\([\'"]conversation_participants[\'"]\)\.delete/.test(index), 'no direct conversation_participants.delete');

// For each catalog RPC that appears in frontend, keys must be subset of catalog args
const byName = {};
for (const c of frontendCalls) {
  if (!byName[c.name]) byName[c.name] = [];
  byName[c.name].push(c.keys);
}

for (const [name, calls] of Object.entries(byName)) {
  const spec = catalog.rpcs[name];
  if (!spec) {
    // allow read-only / optional RPCs not in mutation catalog
    console.log('INFO: rpc not in mutation catalog (ok if read-only):', name);
    continue;
  }
  for (const keys of calls) {
    const unknown = keys.filter((k) => !spec.args.includes(k));
    ok(unknown.length === 0, name + ' args subset of catalog (unknown: ' + unknown.join(',') + ') keys=' + keys.join(','));
  }
  // SQL must mention the function
  ok(new RegExp('FUNCTION public\\.' + name + '\\b|function public\\.' + name + '\\b', 'i').test(migrations),
    'migration defines ' + name);
}

// Catalog required mutations must exist in SQL
for (const name of ['send_message', 'delete_message', 'create_post', 'add_post_comment', 'toggle_post_like', 'submit_report', 'leave_conversation', 'decline_friend_request', 'remove_friend']) {
  ok(new RegExp('FUNCTION public\\.' + name, 'i').test(migrations), 'authoritative RPC present: ' + name);
}

console.log('\nRPC compatibility checks passed:', n, 'mismatches flagged:', mismatches);
