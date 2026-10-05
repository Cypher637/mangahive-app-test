'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'contracts/rpc_catalog.json'), 'utf8'));
const sql = fs.readdirSync(path.join(root, 'supabase/migrations'))
  .filter(f => f.endsWith('.sql')).sort()
  .map(f => fs.readFileSync(path.join(root, 'supabase/migrations', f), 'utf8')).join('\n');

let n = 0;
function ok(c, m) {
  if (!c) { console.error('FAIL:', m); process.exitCode = 1; }
  else { console.log('PASS:', m); n++; }
}

// Extract last require_rate_limit inside each function body (best-effort)
function lastRateLimitForFn(fnName) {
  const re = new RegExp('FUNCTION public\\.' + fnName + '[\\s\\S]*?\\$\\$[\\s\\S]*?\\$\\$', 'i');
  // find all CREATE OR REPLACE for this fn - take last
  const parts = sql.split(new RegExp('CREATE OR REPLACE FUNCTION public\\.' + fnName + '\\b', 'i'));
  if (parts.length < 2) return null;
  const body = parts[parts.length - 1];
  const end = body.indexOf('$$;');
  const chunk = end >= 0 ? body.slice(0, end) : body.slice(0, 4000);
  const m = [...chunk.matchAll(/require_rate_limit\(\s*'([^']+)'\s*\)/g)];
  return m.length ? m[m.length - 1][1] : null;
}

const checks = {
  toggle_post_like: 'post_like',
  create_post: 'post_create',
  add_post_comment: 'post_comment',
  send_message: 'send_message',
  submit_report: 'report',
  send_friend_request: 'friend_request',
  block_user: 'block',
};

for (const [fn, expected] of Object.entries(checks)) {
  const actual = lastRateLimitForFn(fn);
  ok(actual === expected, fn + ' rate limit is ' + expected + ' (got ' + actual + ')');
  // catalog should match if entry exists
  const cat = catalog.rpcs[fn];
  if (cat) {
    ok(cat.rate_limit === expected || cat.rate_limit === expected,
      'catalog ' + fn + ' rate_limit matches SQL (' + cat.rate_limit + ')');
  }
}

// policy CASE includes post_like
ok(/WHEN 'post_like'/.test(sql), "check_rate_limit CASE has 'post_like'");

console.log('\nRate-limit consistency passed:', n);
