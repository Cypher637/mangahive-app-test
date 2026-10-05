'use strict';
/**
 * Loads REAL top-level functions/vars out of index.html's main app script into a vm context, together with
 * everything they (transitively) reference by name. Lets tests execute app code such as migrateCanonicalState
 * without a browser. Only declarations at the IIFE's top level (two-space indent) are considered.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadAppFunctions(rootNames, setup) {
  const html = fs.readFileSync(path.resolve(__dirname, '../../../index.html'), 'utf8');
  const app = html.slice(html.indexOf('var STORAGE_KEY = "fairs-library-v1"'));
  const lines = app.split('\n');
  const fns = Object.create(null), vars = Object.create(null);
  for (let i = 0; i < lines.length; i++) {
    let m = /^  function (\w+)\s*\(/.exec(lines[i]);
    if (m) {
      let j = i, depth = 0, started = false; const txt = [];
      for (; j < lines.length; j++) {
        txt.push(lines[j]);
        for (const ch of lines[j]) { if (ch === '{') { depth++; started = true; } else if (ch === '}') depth--; }
        if (started && depth <= 0) break;
      }
      fns[m[1]] = txt.join('\n'); i = j; continue;
    }
    m = /^  var (\w+)\s*=/.exec(lines[i]);
    if (m && !vars[m[1]]) {
      let j = i; const txt = [lines[i]];
      while (!/;\s*(\/\/.*)?$/.test(txt[txt.length - 1]) && j < lines.length - 1) { j++; txt.push(lines[j]); }
      vars[m[1]] = txt.join('\n'); i = j;
    }
  }
  const need = rootNames.slice(), done = new Set();
  while (need.length) {
    const n = need.pop(); if (done.has(n)) continue; done.add(n);
    const src = fns[n] || vars[n]; if (!src) continue;
    for (const id of new Set(src.match(/[A-Za-z_]\w*/g) || [])) if ((fns[id] || vars[id]) && !done.has(id)) need.push(id);
  }
  const code = [...done].filter((n) => vars[n]).map((n) => vars[n]).join('\n') + '\n' + [...done].filter((n) => fns[n]).map((n) => fns[n]).join('\n');
  const el = new Proxy(function () {}, { get: () => el, apply: () => el, set: () => true });
  const ctx = {
    console, Date, Math, JSON, Object, Array, String, Number, RegExp, Set, Map, isFinite, parseFloat, parseInt, encodeURIComponent, decodeURIComponent, Error, setTimeout, clearTimeout,
    window: {}, document: { getElementById: () => el, createElement: () => el, createTextNode: () => el }, navigator: {}, location: {}, localStorage: { getItem: () => null, setItem() {} }
  };
  ctx.globalThis = ctx; vm.createContext(ctx);
  vm.runInContext(code, ctx, { filename: 'index.html(app)' });
  if (setup) setup(ctx, vm);
  return { ctx, run: (src) => vm.runInContext(src, ctx), loaded: [...done] };
}

module.exports = { loadAppFunctions };
