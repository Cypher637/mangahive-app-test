'use strict';
/** Load the real repository inputs for the RPC verifier. */
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../../..');

const SKIP_DIRS = new Set(['node_modules', 'tests', 'docs', 'supabase', '.git']);

function loadFrontendFiles() {
  const files = [];
  (function walk(d) {
    for (const n of fs.readdirSync(d)) {
      if (SKIP_DIRS.has(n)) continue;
      const p = path.join(d, n);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(js|mjs|cjs|ts|html)$/.test(n) && n !== 'vendor-supabase.js' && !/test\.js$/.test(n)) {
        files.push({ path: path.relative(root, p), src: fs.readFileSync(p, 'utf8') });
      }
    }
  })(root);
  return files;
}

function loadRepo() {
  const migDir = path.join(root, 'supabase/migrations');
  return {
    root,
    catalog: JSON.parse(fs.readFileSync(path.join(root, 'contracts/rpc_catalog.json'), 'utf8')),
    privileges: JSON.parse(fs.readFileSync(path.join(root, 'contracts/rpc_execute_privileges.json'), 'utf8')),
    migrations: fs.readdirSync(migDir).filter(f => f.endsWith('.sql')).sort()
      .map(f => ({ name: f, sql: fs.readFileSync(path.join(migDir, f), 'utf8') })),
    frontendFiles: loadFrontendFiles(),
  };
}

module.exports = { loadRepo, root };
