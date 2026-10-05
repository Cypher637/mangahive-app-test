'use strict';
/**
 * Deterministic PostgreSQL function-state reconstruction from ordered migrations.
 *
 * Replays, in file order:
 *   CREATE FUNCTION / CREATE OR REPLACE FUNCTION
 *   ALTER FUNCTION (SECURITY, volatility, RENAME TO; other sub-commands ignored)
 *   DROP FUNCTION [IF EXISTS] (one or many signatures)
 *   GRANT/REVOKE EXECUTE|ALL ON FUNCTION (explicit sig, name-only, ALL FUNCTIONS IN SCHEMA)
 *   DO blocks of the form  FOR r IN SELECT ... proname IN (...) LOOP EXECUTE format('GRANT|REVOKE ... %s ...', r.sig)
 *   ALTER DEFAULT PRIVILEGES ... ON FUNCTIONS (initial ACL of later-created functions)
 *
 * It also models the PostgreSQL rules that make a real migration FAIL:
 *   - CREATE FUNCTION on an existing signature
 *   - CREATE OR REPLACE changing an input-parameter NAME, the RETURN TYPE, or removing a DEFAULT
 *   - DROP FUNCTION (without IF EXISTS) / GRANT / REVOKE / ALTER on a missing function
 *   - name-only GRANT/REVOKE/DROP that is ambiguous across overloads
 * Anything it cannot interpret (unknown DO block, dynamic DDL) is reported as an
 * `unsupported` error — it is never silently skipped.
 *
 * Function identity = name + IN/INOUT argument types (exactly as pg_proc/regprocedure).
 */

// ───────────────────────── lexical helpers ─────────────────────────

/** Split SQL into top-level statements. Comments removed; strings/$$ bodies preserved. */
function splitStatements(sql) {
  const out = [];
  let cur = '';
  let line = 1;
  let startLine = null;
  let i = 0;
  const n = sql.length;
  const push = () => {
    const t = cur.trim();
    if (t) out.push({ text: t, line: startLine || 1 });
    cur = '';
    startLine = null;
  };
  while (i < n) {
    const c = sql[i];
    const two = sql.substr(i, 2);
    if (two === '--') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (two === '/*') {
      let depth = 1; i += 2;
      while (i < n && depth > 0) {
        if (sql.substr(i, 2) === '/*') { depth++; i += 2; }
        else if (sql.substr(i, 2) === '*/') { depth--; i += 2; }
        else { if (sql[i] === '\n') line++; i++; }
      }
      cur += ' ';
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      if (startLine === null) startLine = line;
      cur += sql.slice(i, j + 1);
      for (let k = i; k <= j; k++) if (sql[k] === '\n') line++;
      i = j + 1;
      continue;
    }
    if (c === '"') {
      let j = sql.indexOf('"', i + 1);
      if (j < 0) j = n - 1;
      if (startLine === null) startLine = line;
      cur += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z_0-9]*)?\$/.exec(sql.slice(i, i + 64));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const j = end < 0 ? n : end + tag.length;
        if (startLine === null) startLine = line;
        cur += sql.slice(i, j);
        for (let k = i; k < j; k++) if (sql[k] === '\n') line++;
        i = j;
        continue;
      }
    }
    if (c === ';') { push(); i++; continue; }
    if (c === '\n') line++;
    if (startLine === null && !/\s/.test(c)) startLine = line;
    cur += c;
    i++;
  }
  push();
  return out;
}

/** Split on a separator at paren depth 0, outside quotes. */
function splitTop(str, sep) {
  const parts = [];
  let depth = 0, cur = '', q = null;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (c === sep && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim() !== '') parts.push(cur);
  return parts.map(s => s.trim());
}

/** Index of the paren matching the '(' at openIdx, or -1. */
function matchParen(str, openIdx) {
  let depth = 0, q = null;
  for (let i = openIdx; i < str.length; i++) {
    const c = str[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// ───────────────────────── type normalisation ─────────────────────────

const TYPE_ALIASES = {
  int: 'integer', int4: 'integer', int8: 'bigint', int2: 'smallint',
  bool: 'boolean', float8: 'double precision', float4: 'real',
  varchar: 'character varying', char: 'character', bpchar: 'character',
  timestamptz: 'timestamp with time zone', timestamp: 'timestamp without time zone',
  timetz: 'time with time zone', time: 'time without time zone',
  decimal: 'numeric', serial: 'integer', bigserial: 'bigint',
};
const KNOWN_BASE = new Set([
  'text', 'uuid', 'jsonb', 'json', 'boolean', 'integer', 'bigint', 'smallint', 'numeric', 'real',
  'double precision', 'character varying', 'character', 'date', 'bytea', 'inet', 'citext', 'void',
  'record', 'trigger', 'interval', 'timestamp with time zone', 'timestamp without time zone',
  'time with time zone', 'time without time zone', 'oid', 'regclass', 'name', 'xml', 'tsvector',
]);

function normType(raw) {
  let t = String(raw).trim().toLowerCase().replace(/\s+/g, ' ');
  t = t.replace(/^public\./, '').replace(/^pg_catalog\./, '').replace(/"/g, '');
  let dims = '';
  const arr = /((?:\s*\[\s*\d*\s*\])+)\s*$/.exec(t);
  if (arr) { dims = '[]'.repeat((arr[1].match(/\[/g) || []).length); t = t.slice(0, arr.index).trim(); }
  if (/ array$/.test(t)) { t = t.replace(/ array$/, ''); dims = '[]'; }
  t = t.replace(/\(\s*\d+(\s*,\s*\d+)?\s*\)/g, '');             // typmods are not part of identity
  t = t.replace(/^timestamp\s*(?:without|with) time zone$/, m => m.replace(/\s+/g, ' '));
  t = t.replace(/\s+/g, ' ').trim();
  if (TYPE_ALIASES[t]) t = TYPE_ALIASES[t];
  return t + dims;
}

function isTypeLike(raw) {
  const t = normType(raw);
  const base = t.replace(/(\[\])+$/, '');
  return KNOWN_BASE.has(base) || /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/.test(base) && !/\s/.test(base);
}

// ───────────────────────── argument parsing ─────────────────────────

const MODE_RE = /^(in|out|inout|variadic)\s+/i;

/** Parse one argument definition from a CREATE FUNCTION header. */
function parseCreateArg(def) {
  let s = def.trim();
  let hasDefault = false;
  // top-level DEFAULT or '='
  const dm = /\s+default\s+|\s*=\s*/i.exec(s.replace(/\([^()]*\)/g, m => ' '.repeat(m.length)));
  if (dm) { hasDefault = true; s = s.slice(0, dm.index).trim(); }
  let mode = 'in';
  const mm = MODE_RE.exec(s);
  if (mm) { mode = mm[1].toLowerCase(); s = s.slice(mm[0].length).trim(); }
  const bits = s.split(/\s+/);
  let name = null, type;
  if (bits.length === 1) type = bits[0];
  else { name = bits[0].replace(/"/g, ''); type = bits.slice(1).join(' '); }
  return { name, type: normType(type), mode, hasDefault };
}

/** Parse a type-only (or named) signature list from DROP/GRANT/ALTER. */
function parseSigArgs(listText) {
  if (listText.trim() === '') return [];
  return splitTop(listText, ',').map(def => {
    let s = def.trim().replace(MODE_RE, m => (/^out/i.test(m) ? '\u0000' : ''));
    if (s.startsWith('\u0000')) return null;               // OUT args are not part of identity
    if (isTypeLike(s) && !(/\s/.test(s) && !KNOWN_BASE.has(normType(s).replace(/(\[\])+$/, '')))) return normType(s);
    const bits = s.split(/\s+/);
    return normType(bits.slice(1).join(' '));
  }).filter(x => x !== null);
}

function keyOf(name, types) { return name + '(' + types.join(',') + ')'; }

// ───────────────────────── CREATE FUNCTION parser ─────────────────────────

function parseCreateFunction(text) {
  const m = /^create\s+(or\s+replace\s+)?function\s+([\w."]+)\s*\(/i.exec(text);
  if (!m) return null;
  const qual = m[2].replace(/"/g, '');
  const parts = qual.split('.');
  const name = parts.pop().toLowerCase();
  const schema = (parts.pop() || 'public').toLowerCase();
  const open = m[0].length - 1;
  const close = matchParen(text, open);
  if (close < 0) return { error: 'unbalanced parentheses in CREATE FUNCTION header' };
  const argDefs = splitTop(text.slice(open + 1, close), ',').map(parseCreateArg);
  let rest = text.slice(close + 1);

  // body
  let body = '';
  const dq = /\bas\s+(\$[A-Za-z_0-9]*\$)([\s\S]*?)\1/i.exec(rest);
  if (dq) { body = dq[2]; rest = rest.slice(0, dq.index) + ' ' + rest.slice(dq.index + dq[0].length); }
  else {
    const sq = /\bas\s+'((?:[^']|'')*)'/i.exec(rest);
    if (sq) { body = sq[1].replace(/''/g, "'"); rest = rest.slice(0, sq.index) + ' ' + rest.slice(sq.index + sq[0].length); }
  }

  // returns
  let returns = null;
  const rm = /\breturns\s+/i.exec(rest);
  if (rm) {
    let after = rest.slice(rm.index + rm[0].length);
    if (/^table\s*\(/i.test(after)) {
      const o = after.indexOf('(');
      const c = matchParen(after, o);
      const cols = splitTop(after.slice(o + 1, c), ',').map(col => {
        const b = col.trim().split(/\s+/);
        return b[0].toLowerCase() + ' ' + normType(b.slice(1).join(' '));
      });
      returns = 'table(' + cols.join(', ') + ')';
    } else {
      const stop = /\b(language|security|stable|volatile|immutable|strict|cost|rows|parallel|leakproof|called|set|window|transform|support|not)\b/i.exec(after);
      const typeText = (stop ? after.slice(0, stop.index) : after).trim();
      const setof = /^setof\s+/i.test(typeText);
      returns = (setof ? 'setof ' : '') + normType(typeText.replace(/^setof\s+/i, ''));
    }
  }
  const attrText = rest;
  const lang = /\blanguage\s+(\w+)/i.exec(attrText);
  return {
    schema, name,
    orReplace: !!m[1],
    args: argDefs,
    returns,
    language: lang ? lang[1].toLowerCase() : null,
    securityDefiner: /\bsecurity\s+definer\b/i.test(attrText),
    volatility: /\bimmutable\b/i.test(attrText) ? 'immutable' : /\bstable\b/i.test(attrText) ? 'stable' : 'volatile',
    searchPathPinned: /\bset\s+search_path\b/i.test(attrText),
    body,
  };
}

// ───────────────────────── state machine ─────────────────────────

const ROLES = ['PUBLIC', 'anon', 'authenticated', 'service_role'];

class PgFunctionState {
  /**
   * @param {object} opts
   * @param {string[]} [opts.platformDefaultGrantees] roles that receive EXECUTE automatically on every
   *        new function (e.g. Supabase: anon, authenticated, service_role). PUBLIC always does (PostgreSQL).
   */
  constructor(opts = {}) {
    this.funcs = new Map();                       // key → fn record
    this.errors = [];                             // migration-would-fail / unsupported findings
    this.log = [];                                // obsolete/dropped history
    this.defaultGrantees = new Set(opts.platformDefaultGrantees || []);
    this.dropped = [];                            // {key, at}
    this.ever = new Map();                        // key → first creation location (history of every signature)
  }

  err(kind, msg, loc) { this.errors.push({ kind, msg, loc }); }

  initialAcl() {
    const acl = { PUBLIC: true, anon: false, authenticated: false, service_role: false };
    for (const r of this.defaultGrantees) acl[r] = true;
    return acl;
  }

  byName(name) { return [...this.funcs.values()].filter(f => f.name === name); }

  /** Resolve `name` or `name(types)` → array of fn records. */
  resolve(ref, loc, { ifExists = false, what = 'function' } = {}) {
    const m = /^([\w."]+)\s*(?:\(([\s\S]*)\))?$/.exec(ref.trim());
    if (!m) { this.err('unsupported', `cannot parse function reference "${ref}"`, loc); return []; }
    const qual = m[1].replace(/"/g, '').toLowerCase().split('.');
    const name = qual.pop(); const schema = qual.pop() || 'public';
    if (schema !== 'public') return [];
    if (m[2] === undefined) {
      const all = this.byName(name);
      if (all.length === 0) { if (!ifExists) this.err('missing_function', `${what} ${name} does not exist`, loc); return []; }
      if (all.length > 1) { this.err('ambiguous_function', `function name "${name}" is not unique (${all.map(f => f.key).join(' | ')})`, loc); return []; }
      return all;
    }
    const key = keyOf(name, parseSigArgs(m[2]));
    const f = this.funcs.get(key);
    if (!f) { if (!ifExists) this.err('missing_function', `${what} ${key} does not exist`, loc); return []; }
    return [f];
  }

  create(parsed, loc) {
    if (parsed.error) return this.err('unsupported', parsed.error, loc);
    if (parsed.schema !== 'public') return;
    const inArgs = parsed.args.filter(a => a.mode !== 'out');
    const key = keyOf(parsed.name, inArgs.map(a => a.type));
    const existing = this.funcs.get(key);
    const rec = {
      key, name: parsed.name, args: inArgs, returns: parsed.returns,
      language: parsed.language, securityDefiner: parsed.securityDefiner,
      volatility: parsed.volatility, searchPathPinned: parsed.searchPathPinned, body: parsed.body,
      acl: existing ? existing.acl : this.initialAcl(),
      createdAt: existing ? existing.createdAt : loc, replacedAt: existing ? loc : null,
    };
    if (existing) {
      if (!parsed.orReplace) return this.err('already_exists', `CREATE FUNCTION ${key}: function already exists`, loc);
      for (let i = 0; i < existing.args.length; i++) {
        const o = existing.args[i], nw = inArgs[i];
        if (o.name && nw.name !== o.name) {
          return this.err('replace_rename_param',
            `CREATE OR REPLACE ${key}: cannot change name of input parameter "${o.name}" → "${nw.name}" (SQLSTATE 42P13; DROP FUNCTION first)`, loc);
        }
        if (o.hasDefault && !nw.hasDefault) {
          return this.err('replace_remove_default', `CREATE OR REPLACE ${key}: cannot remove parameter default of "${o.name}"`, loc);
        }
      }
      if (existing.returns !== rec.returns) {
        return this.err('replace_return_type',
          `CREATE OR REPLACE ${key}: cannot change return type ${existing.returns} → ${rec.returns} (SQLSTATE 42P13; DROP FUNCTION first)`, loc);
      }
    }
    this.funcs.set(key, rec);
    if (!this.ever.has(key)) this.ever.set(key, loc);
  }

  drop(text, loc) {
    const m = /^drop\s+function\s+(if\s+exists\s+)?([\s\S]*?)(?:\s+(cascade|restrict))?$/i.exec(text);
    if (!m) return this.err('unsupported', 'cannot parse DROP FUNCTION', loc);
    for (const ref of splitTopFnList(m[2])) {
      for (const f of this.resolve(ref, loc, { ifExists: !!m[1] })) {
        this.funcs.delete(f.key);
        this.dropped.push({ key: f.key, at: loc });
      }
    }
  }

  alter(text, loc) {
    const m = /^alter\s+function\s+([\w."]+\s*(?:\([^)]*\))?)\s+([\s\S]*)$/i.exec(text);
    if (!m) return this.err('unsupported', 'cannot parse ALTER FUNCTION', loc);
    const fns = this.resolve(m[1], loc);
    const action = m[2].trim();
    for (const f of fns) {
      if (/^(external\s+)?security\s+definer\b/i.test(action)) f.securityDefiner = true;
      else if (/^(external\s+)?security\s+invoker\b/i.test(action)) f.securityDefiner = false;
      else if (/^stable\b/i.test(action)) f.volatility = 'stable';
      else if (/^immutable\b/i.test(action)) f.volatility = 'immutable';
      else if (/^volatile\b/i.test(action)) f.volatility = 'volatile';
      else if (/^rename\s+to\s+/i.test(action)) {
        const nn = action.replace(/^rename\s+to\s+/i, '').replace(/"/g, '').trim().toLowerCase();
        this.funcs.delete(f.key);
        f.name = nn; f.key = keyOf(nn, f.args.map(a => a.type));
        this.funcs.set(f.key, f);
      } else if (/^set\s+schema\b/i.test(action)) {
        this.err('unsupported', `ALTER FUNCTION ${f.key} SET SCHEMA is not modelled`, loc);
      } else if (/^(owner\s+to|set\s|reset\s|cost\b|rows\b|parallel\b|strict\b|called\s+on|returns\s+null|leakproof|not\s+leakproof|depends\s+on|no\s+depends|support\b)/i.test(action)) {
        /* no effect on contract-relevant state */
      } else {
        this.err('unsupported', `ALTER FUNCTION ${f.key}: unrecognised action "${action.slice(0, 40)}"`, loc);
      }
    }
  }

  /** Apply GRANT/REVOKE to a list of fn records. */
  applyAcl(fns, grant, roles) {
    for (const f of fns) {
      for (const r of roles) {
        const role = /^public$/i.test(r) ? 'PUBLIC' : r.toLowerCase();
        f.acl[role] = grant;
      }
    }
  }

  privilege(text, loc) {
    const m = /^(grant|revoke)\s+(?:grant\s+option\s+for\s+)?(execute|all(?:\s+privileges)?)\s+on\s+(function|all\s+functions\s+in\s+schema)\s+([\s\S]*?)\s+(to|from)\s+([\s\S]*?)(?:\s+with\s+grant\s+option)?(?:\s+cascade|\s+restrict)?$/i.exec(text);
    if (!m) {
      if (/^(grant|revoke)\b[\s\S]*\bon\s+(function|routine|all\s+(functions|routines))/i.test(text)) {
        this.err('unsupported', 'cannot parse GRANT/REVOKE on function', loc);
      }
      return;
    }
    const grant = m[1].toLowerCase() === 'grant';
    const roles = splitTop(m[6], ',').map(r => r.replace(/^group\s+/i, '').trim());
    if (/^all\s+functions/i.test(m[3])) {
      const sch = m[4].trim().toLowerCase();
      if (sch === 'public') this.applyAcl([...this.funcs.values()], grant, roles);
      return;
    }
    const refs = splitTopFnList(m[4]);
    for (const ref of refs) this.applyAcl(this.resolve(ref, loc), grant, roles);
  }

  alterDefaultPrivileges(text, loc) {
    const m = /^alter\s+default\s+privileges\b([\s\S]*?)\b(grant|revoke)\b([\s\S]*?)\bon\s+functions\s+(to|from)\s+([\s\S]*)$/i.exec(text);
    if (!m) {
      if (/^alter\s+default\s+privileges\b[\s\S]*\bfunctions\b/i.test(text)) this.err('unsupported', 'cannot parse ALTER DEFAULT PRIVILEGES ... ON FUNCTIONS', loc);
      return;
    }
    if (/\bin\s+schema\s+(?!public\b)/i.test(m[1])) return;
    const grant = m[2].toLowerCase() === 'grant';
    for (const r of splitTop(m[5], ',')) {
      const role = /^public$/i.test(r.trim()) ? 'PUBLIC' : r.trim().toLowerCase();
      if (grant) this.defaultGrantees.add(role); else this.defaultGrantees.delete(role);
    }
  }

  /** DO $$ ... $$ blocks: only the documented GRANT/REVOKE-over-pg_proc loop is understood. */
  doBlock(text, loc) {
    const body = (/^do\s+(?:language\s+\w+\s+)?(\$[A-Za-z_0-9]*\$)([\s\S]*?)\1/i.exec(text) || [])[2];
    if (body === undefined) return this.err('unsupported', 'cannot parse DO block', loc);
    const inList = /proname\s+IN\s*\(([\s\S]*?)\)/i.exec(body);
    const execs = [...body.matchAll(/EXECUTE\s+format\(\s*'((?:[^']|'')*)'\s*,\s*r\.sig\s*\)/gi)].map(x => x[1].replace(/''/g, "'"));
    const ddlOutsideFormat = /\b(create|drop|alter)\s+function\b/i.test(body.replace(/EXECUTE\s+format\([\s\S]*?\)\s*;/gi, ''));
    const onlyKnown = inList && execs.length > 0 && !ddlOutsideFormat
      && /FOR\s+r\s+IN\s+SELECT\s+p\.oid::regprocedure\s+AS\s+sig/i.test(body)
      && /nspname\s*=\s*'public'/i.test(body)
      && execs.every(e => /^(GRANT|REVOKE)\b[\s\S]*%s[\s\S]*$/i.test(e));
    if (!onlyKnown) {
      return this.err('unsupported', 'DO block is not a recognised GRANT/REVOKE-over-pg_proc loop; ACL effect unknown', loc);
    }
    const names = new Set([...inList[1].matchAll(/'([^']+)'/g)].map(x => x[1].toLowerCase()));
    const targets = [...this.funcs.values()].filter(f => names.has(f.name));
    for (const f of targets) {
      for (const tpl of execs) {
        const stmt = tpl.replace('%s', f.key);
        this.privilege(stmt, loc);
      }
    }
  }

  applyStatement(stmt, file) {
    const loc = `${file}:${stmt.line}`;
    const t = stmt.text;
    if (/^create\s+(or\s+replace\s+)?function\b/i.test(t)) return this.create(parseCreateFunction(t), loc);
    if (/^create\s+(or\s+replace\s+)?procedure\b/i.test(t)) return this.err('unsupported', 'CREATE PROCEDURE not modelled', loc);
    if (/^drop\s+function\b/i.test(t)) return this.drop(t, loc);
    if (/^drop\s+(routine|procedure)\b/i.test(t)) return this.err('unsupported', 'DROP ROUTINE/PROCEDURE not modelled', loc);
    if (/^alter\s+function\b/i.test(t)) return this.alter(t, loc);
    if (/^alter\s+default\s+privileges\b/i.test(t)) return this.alterDefaultPrivileges(t, loc);
    if (/^(grant|revoke)\b/i.test(t)) return this.privilege(t, loc);
    if (/^do\b/i.test(t)) return this.doBlock(t, loc);
    if (/^(alter\s+schema|drop\s+schema|create\s+schema)\b/i.test(t) && /public/i.test(t)) {
      return this.err('unsupported', 'schema-level DDL on public is not modelled', loc);
    }
  }

  applyMigration(name, sql) {
    for (const s of splitStatements(sql)) this.applyStatement(s, name);
  }

  effectiveExecute(fn, role) { return !!(fn.acl[role] || fn.acl.PUBLIC); }
}

/** `a(uuid), b(text,int)` → refs. Splits only at commas outside parentheses. */
function splitTopFnList(text) { return splitTop(text, ','); }

/** Convenience: build state from [{name, sql}] in the order given (caller sorts). */
function buildState(migrations, opts) {
  const st = new PgFunctionState(opts);
  for (const m of migrations) st.applyMigration(m.name, m.sql);
  return st;
}

module.exports = {
  splitStatements, splitTop, matchParen, normType, parseSigArgs, parseCreateFunction,
  PgFunctionState, buildState, keyOf, ROLES,
};
