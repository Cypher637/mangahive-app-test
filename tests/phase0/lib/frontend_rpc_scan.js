'use strict';
/**
 * Frontend RPC usage scanner.
 *
 * Finds every client RPC invocation:
 *   x.rpc("name", {...})                       literal
 *   var r = cond ? "a" : "b"; x.rpc(r, {...})  dynamic, statically resolved
 *   function rpc(name, args) { return sb.rpc(name, args) }  +  rpc('n', {...})   wrapper call sites
 * Anything it cannot resolve to string literals is returned in `unresolved` with file:line.
 * It NEVER silently ignores an `.rpc` reference (bare `.rpc` without a call, bracket access,
 * aliasing, `.rpc.call/apply` all land in `unresolved`).
 */

/** Blank out comments (keep offsets and newlines) so regexes do not match commented-out calls. */
function blankComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i++; }
    } else if (c === '/' && d === '*') {
      out += '  '; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      out += '  '; i += 2;
    } else if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c; i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        if (q !== '`' && src[i] === '\n') break;
        out += src[i]; i++;
      }
      if (i < n) { out += src[i]; i++; }
    } else { out += c; i++; }
  }
  return out;
}

function lineOf(src, idx) { let l = 1; for (let i = 0; i < idx; i++) if (src.charCodeAt(i) === 10) l++; return l; }

/** Match bracket starting at src[open] ((, {, [); string-aware. Returns index of closer or -1. */
function matchBracket(src, open) {
  const pairs = { '(': ')', '{': '}', '[': ']' };
  const o = src[open], cl = pairs[o];
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
      continue;
    }
    if (c === o) depth++;
    else if (c === cl) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function splitTopJs(str) {
  const parts = []; let depth = 0, cur = '';
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c; cur += c; i++;
      while (i < str.length && str[i] !== q) { if (str[i] === '\\') { cur += str[i]; i++; } cur += str[i]; i++; }
      cur += str[i] || ''; continue;
    }
    if ('({['.includes(c)) depth++;
    if (')}]'.includes(c)) depth--;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map(s => s.trim());
}

const STR = /^(?:"([A-Za-z0-9_]+)"|'([A-Za-z0-9_]+)')$/;
const strVal = s => { const m = STR.exec(s.trim()); return m ? (m[1] || m[2]) : null; };

/** Resolve an identifier to a set of string literals using the nearest preceding assignment in the file. */
function resolveIdent(clean, ident, beforeIdx) {
  const re = new RegExp('\\b(?:var|let|const)\\s+' + ident.replace(/\$/g, '\\$') + '\\s*=\\s*([^;]+);', 'g');
  let m, last = null;
  while ((m = re.exec(clean)) !== null) { if (m.index < beforeIdx) last = m; else break; }
  if (!last) return null;
  const expr = last[1].trim();
  const lit = strVal(expr);
  if (lit) return [lit];
  const t = /^[\w.$!()\s&|=<>'"]+?\?\s*("[A-Za-z0-9_]+"|'[A-Za-z0-9_]+')\s*:\s*("[A-Za-z0-9_]+"|'[A-Za-z0-9_]+')$/.exec(expr);
  if (t) return [strVal(t[1]), strVal(t[2])];
  return null;
}

/** Parse the call argument list starting at the '(' index. */
function parseCall(clean, openIdx) {
  const close = matchBracket(clean, openIdx);
  if (close < 0) return null;
  return { args: splitTopJs(clean.slice(openIdx + 1, close)), close };
}

function objectKeys(argText) {
  const t = argText.trim();
  if (!t.startsWith('{')) return { verifiable: false };
  const close = matchBracket(t, 0);
  const inner = t.slice(1, close);
  const keys = [];
  for (const part of splitTopJs(inner)) {
    if (part.startsWith('...')) return { verifiable: false };
    const m = /^(?:["']?([A-Za-z_$][\w$]*)["']?)\s*(?::|$)/.exec(part);
    if (!m) return { verifiable: false };
    keys.push(m[1]);
  }
  return { verifiable: true, keys };
}


/** Keys of an object literal held in a local variable: `var a = {k:v}; a.x = ...;` before the call. */
function resolveObjectVarKeys(clean, ident, beforeIdx) {
  const re = new RegExp('\\b(?:var|let|const)\\s+' + ident.replace(/\$/g, '\\$') + '\\s*=\\s*\\{', 'g');
  let m, last = null;
  while ((m = re.exec(clean)) !== null) { if (m.index < beforeIdx) last = m; else break; }
  if (!last) return null;
  const open = last.index + last[0].length - 1;
  const close = matchBracket(clean, open);
  const info = objectKeys(clean.slice(open, close + 1));
  if (!info.verifiable) return null;
  const keys = info.keys.slice();
  const seg = clean.slice(close + 1, beforeIdx);
  for (const am of seg.matchAll(new RegExp('(?<![\\w$.])' + ident.replace(/\$/g, '\\$') + '\\.([A-Za-z_$][\\w$]*)\\s*=(?!=)', 'g'))) {
    if (!keys.includes(am[1])) keys.push(am[1]);
  }
  return keys;
}

function keysFor(clean, secondArg, idx) {
  if (secondArg === undefined) return { verifiable: true, keys: [] };
  const direct = objectKeys(secondArg);
  if (direct.verifiable) return direct;
  if (/^[A-Za-z_$][\w$]*$/.test(secondArg.trim())) {
    const k = resolveObjectVarKeys(clean, secondArg.trim(), idx);
    if (k) return { verifiable: true, keys: k, viaVar: true };
  }
  return { verifiable: false };
}

/**
 * @param {{path:string, src:string}[]} files
 * @returns {{calls:{name:string,file:string,line:number,via:string,keys:string[]|null}[],
 *            unresolved:{file:string,line:number,reason:string}[],
 *            dynamic:{file:string,line:number,names:string[],via:string}[],
 *            wrappers:{name:string,file:string}[]}}
 */
function scanFrontend(files) {
  const calls = [], unresolved = [], dynamic = [], wrappers = [];
  const cleaned = files.map(f => ({ path: f.path, src: f.src, clean: blankComments(f.src) }));

  const record = (f, idx, rawFirst, rawSecond, via) => {
    const line = lineOf(f.src, idx);
    let names = null;
    const lit = strVal(rawFirst);
    if (lit) names = [lit];
    else if (/^[A-Za-z_$][\w$]*$/.test(rawFirst.trim())) {
      names = resolveIdent(f.clean, rawFirst.trim(), idx);
      if (names) dynamic.push({ file: f.path, line, names, via });
    }
    return { line, names };
  };

  const wrapperDefs = new Map();     // wrapper name → file

  // pass 1: direct .rpc( usages
  for (const f of cleaned) {
    // any `.rpc` / ['rpc'] token that is not `.rpc(` is unresolved by definition
    for (const m of f.clean.matchAll(/(?:\.\s*rpc\b(?!\s*\()|\[\s*["']rpc["']\s*\])/g)) {
      unresolved.push({ file: f.path, line: lineOf(f.src, m.index), reason: 'rpc referenced without a direct call (alias / bracket access / .call)' });
    }
    for (const m of f.clean.matchAll(/\.\s*rpc\s*\(/g)) {
      const open = m.index + m[0].length - 1;
      const call = parseCall(f.clean, open);
      const line = lineOf(f.src, m.index);
      if (!call || call.args.length === 0) { unresolved.push({ file: f.path, line, reason: 'cannot parse .rpc( arguments' }); continue; }
      const first = call.args[0];
      const { names } = record(f, m.index, first, call.args[1], 'ident');
      if (names) {
        const keyInfo = keysFor(f.clean, call.args[1], m.index);
        for (const name of names) calls.push({ name, file: f.path, line, via: strVal(first) ? 'literal' : 'dynamic', keys: keyInfo.verifiable ? keyInfo.keys : null });
        continue;
      }
      // identifier that is parameter 0 of the enclosing function ⇒ wrapper
      const id = first.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(id)) {
        const before = f.clean.slice(0, m.index);
        const fm = [...before.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g)].pop();
        const am = [...before.matchAll(/(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/g)].pop();
        const cand = [fm, am].filter(Boolean).sort((a, b) => b.index - a.index)[0];
        if (cand) {
          const p0 = cand[2].split(',')[0].trim();
          if (p0 === id) { wrapperDefs.set(cand[1], f.path); wrappers.push({ name: cand[1], file: f.path }); continue; }
        }
      }
      unresolved.push({ file: f.path, line, reason: 'dynamic RPC name "' + first.trim().slice(0, 60) + '" cannot be resolved to string literals' });
    }
  }

  // pass 2: wrapper call sites
  for (const [wname, wfile] of wrapperDefs) {
    const re = new RegExp('(?<![.\\w$])' + wname.replace(/\$/g, '\\$') + '\\s*\\(', 'g');
    for (const f of cleaned) {
      for (const m of f.clean.matchAll(re)) {
        const pre = f.clean.slice(Math.max(0, m.index - 20), m.index);
        if (/function\s+$|async\s+function\s+$/.test(pre)) continue;          // the definition itself
        const open = m.index + m[0].length - 1;
        const call = parseCall(f.clean, open);
        const line = lineOf(f.src, m.index);
        if (!call || call.args.length === 0) { unresolved.push({ file: f.path, line, reason: 'cannot parse wrapper ' + wname + '( arguments' }); continue; }
        const { names } = record(f, m.index, call.args[0], call.args[1], 'wrapper:' + wname);
        if (!names) { unresolved.push({ file: f.path, line, reason: 'wrapper ' + wname + '() called with unresolvable RPC name "' + call.args[0].slice(0, 60) + '"' }); continue; }
        const keyInfo = keysFor(f.clean, call.args[1], m.index);
        for (const name of names) calls.push({ name, file: f.path, line, via: 'wrapper:' + wname, keys: keyInfo.verifiable ? keyInfo.keys : null });
      }
    }
  }
  return { calls, unresolved, dynamic, wrappers };
}

module.exports = { scanFrontend, blankComments, lineOf, matchBracket, splitTopJs };
