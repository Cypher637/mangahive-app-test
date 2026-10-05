-- MangaHive Phase 0 — Adversarial RLS test script
-- Run against a real Supabase/Postgres with migrations applied.
-- Requires three test users (A, B, C) with JWTs or SET request.jwt.claim.sub.
--
-- This file is the executable specification. It cannot pass in an environment
-- without a live database. Document result as PASS only after actual execution.

-- Setup note: replace :uid_a, :uid_b, :uid_c with real UUIDs from auth.users.

BEGIN;

-- Example using set_config for role simulation (Supabase-style):
-- SELECT set_config('request.jwt.claim.sub', '<uid_a>', true);
-- SET ROLE authenticated;

-- ========== FRIEND REQUEST IMMUTABILITY ==========
-- As A: insert pending request to B
-- As A: UPDATE requester_id -> must FAIL
-- As B: UPDATE requester_id -> must FAIL
-- As B: UPDATE status = accepted -> must PASS
-- As C: UPDATE status -> must FAIL
-- As A after accept: UPDATE status -> must FAIL (terminal)

-- ========== CONVERSATION SELF-JOIN ==========
-- As A: create conversation
-- As A: insert self as first participant -> PASS
-- As A: insert C as participant -> PASS
-- As B: insert self into same conversation -> must FAIL
-- As B: SELECT messages -> must FAIL / empty
-- As B: INSERT message -> must FAIL
-- As B: INSERT reaction on A's message -> must FAIL
-- As C: SELECT / INSERT message / reaction -> PASS

-- ========== PROFILE PRIVACY ==========
-- A privacy=private: B SELECT -> FAIL
-- A privacy=public: B SELECT -> PASS
-- A privacy=friends + accepted friendship with B: B SELECT -> PASS
-- A privacy=friends without friendship: C SELECT -> FAIL

ROLLBACK;

-- When automated with pgTAP or a JS harness, assert each RAISE/permission denied.
-- ========== ROOM MESSAGES (Phase 0.8 — policy runs as caller; no helper call) ==========
-- As A (authenticated): SELECT * FROM room_messages WHERE room_id='general' -> PASS (must NOT raise
--   "permission denied for function room_is_accessible")
-- As A: SELECT from room_messages for a room with status<>'active' or visibility<>'public' -> 0 rows
-- As A: SELECT from room_messages for a nonexistent room_id -> 0 rows
-- As A: SELECT public.room_is_accessible('general') -> must FAIL (permission denied for function)
-- As anon: SELECT from room_messages -> must FAIL / 0 rows; SELECT from rooms -> must FAIL (permission denied)
-- As anon / authenticated via PostgREST: POST /rest/v1/rpc/room_is_accessible -> must FAIL (not callable)
-- As A: send_room_message('general','x') -> PASS (SECURITY DEFINER path still calls the helper as owner)
-- As A: INSERT/UPDATE/DELETE on rooms -> must FAIL (deny policies)
-- Compare: SELECT has_function_privilege('authenticated','public.room_is_accessible(text)','EXECUTE') -> false
--          SELECT has_table_privilege('authenticated','public.rooms','SELECT') -> true
--          SELECT has_table_privilege('anon','public.rooms','SELECT') -> false

ROLLBACK;