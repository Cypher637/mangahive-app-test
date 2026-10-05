'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const rc = fs.readFileSync(path.join(root, 'config/runtime-config.js'), 'utf8');
const idx = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

let n = 0;
function ok(c, m) {
  if (!c) { console.error('FAIL:', m); process.exitCode = 1; }
  else { console.log('PASS:', m); n++; }
}

ok(!/gfubquamaafpzzshrhzj/.test(rc), 'runtime-config.js has no production project URL');
ok(!/\|\|\s*['"]https:\/\//.test(rc), 'runtime-config.js has no || https:// fallback');
ok(/throw new Error/.test(rc), 'runtime-config throws on missing config');
ok(/__MANGAHIVE_CONFIG__/.test(rc), 'reads injected __MANGAHIVE_CONFIG__');
ok(/var SUPABASE_URL = \(typeof window/.test(idx) || /MangaHiveConfig\.supabaseUrl/.test(idx),
  'index uses MangaHiveConfig not hardcoded string assignment');
ok(!/var SUPABASE_URL\s*=\s*"https:\/\//.test(idx), 'index has no var SUPABASE_URL = "https://..."');
ok(fs.existsSync(path.join(root, 'config/runtime-config.production.js')),
  'explicit production inject file exists (not silent fallback)');
ok(/runtime-config\.production\.js/.test(idx), 'index loads production inject explicitly before validator');

// Simulate missing config: clear inject and require the throw path exists
const throwsOnMissing = /if \(!supabaseUrl \|\| !supabaseAnonKey\)/.test(rc) && /throw new Error/.test(rc);
ok(throwsOnMissing, 'runtime-config has explicit missing-config throw path');

console.log('\nConfig fail-closed tests passed:', n);
