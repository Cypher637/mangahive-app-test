/**
 * Validate machine-readable JSON Schema contracts exist and are parseable.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const schemasDir = path.join(root, 'contracts/schemas');
let n = 0;
function ok(c, m) {
  if (!c) { console.error('FAIL:', m); process.exitCode = 1; }
  else { console.log('PASS:', m); n++; }
}

ok(fs.existsSync(schemasDir), 'schemas directory exists');
const files = fs.readdirSync(schemasDir).filter((f) => f.endsWith('.schema.json'));
ok(files.length >= 3, 'at least 3 schema files present (' + files.length + ')');

for (const f of files) {
  const raw = fs.readFileSync(path.join(schemasDir, f), 'utf8');
  let doc;
  try { doc = JSON.parse(raw); } catch (e) { ok(false, f + ' parses as JSON'); continue; }
  ok(doc.$schema && doc.title && doc.type, f + ' has $schema, title, type');
  ok(doc.properties || doc.$ref, f + ' defines properties');
}

// ids + errors modules still load
const ids = require(path.join(root, 'contracts/ids'));
const errors = require(path.join(root, 'contracts/errors'));
ok(typeof ids.downloadIdentityKey === 'function', 'downloadIdentityKey exported');
ok(errors.ErrorCode.RATE_LIMITED === 'RATE_LIMITED', 'ErrorCode.RATE_LIMITED');

// social service file exists
ok(fs.existsSync(path.join(root, 'src/services/social.js')), 'social service boundary file exists');
const socialSrc = fs.readFileSync(path.join(root, 'src/services/social.js'), 'utf8');
ok(/check_rate_limit/.test(socialSrc), 'social service calls check_rate_limit RPC');
ok(/sendFriendRequest|createConversation|reactToMessage/.test(socialSrc), 'social service exposes sensitive operations');

// critical migration present
const mig = path.join(root, 'supabase/migrations/20261004010000_phase0_critical_rls_hardening.sql');
ok(fs.existsSync(mig), 'critical RLS hardening migration exists');
const sql = fs.readFileSync(mig, 'utf8');
ok(/friend_request_guard/.test(sql), 'friend request immutability trigger present');
ok(/cp_insert_authorized|is_conversation_participant/.test(sql), 'conversation membership guard present');
ok(/message_reactions[\s\S]*is_conversation_participant|message_id[\s\S]*conversation_participants/.test(sql), 'reaction membership check present');
ok(/can_view_profile/.test(sql), 'profile privacy function present');
ok(/check_rate_limit/.test(sql), 'server rate limit RPC present');

console.log('\nContract/schema tests passed:', n);
