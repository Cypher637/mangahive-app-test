-- MangaHive Phase 0 — Critical RLS hardening
-- Fixes:
--   1. conversation_participants self-join vulnerability
--   2. friend_requests mutable ownership fields
--   3. message_reactions without conversation membership check
--   4. privacy model enforcement for profiles
--   5. rate_limits table for server-side limiting

-- ============================================================================
-- 1. FRIEND REQUESTS — immutable parties + status state machine
-- ============================================================================

-- Restrict status values to those the app supports
ALTER TABLE public.friend_requests
  DROP CONSTRAINT IF EXISTS friend_requests_status_check;
ALTER TABLE public.friend_requests
  ADD CONSTRAINT friend_requests_status_check
  CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled'));

-- Trigger: freeze requester_id / addressee_id after insert; control status transitions
CREATE OR REPLACE FUNCTION public.friend_request_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Ownership fields are immutable
    IF NEW.requester_id IS DISTINCT FROM OLD.requester_id THEN
      RAISE EXCEPTION 'friend_requests.requester_id is immutable';
    END IF;
    IF NEW.addressee_id IS DISTINCT FROM OLD.addressee_id THEN
      RAISE EXCEPTION 'friend_requests.addressee_id is immutable';
    END IF;

    -- Status transitions
    IF OLD.status = 'pending' THEN
      IF NEW.status = 'cancelled' THEN
        IF auth.uid() IS DISTINCT FROM OLD.requester_id THEN
          RAISE EXCEPTION 'only requester may cancel a pending friend request';
        END IF;
      ELSIF NEW.status IN ('accepted', 'rejected') THEN
        IF auth.uid() IS DISTINCT FROM OLD.addressee_id THEN
          RAISE EXCEPTION 'only addressee may accept or reject a pending friend request';
        END IF;
      ELSE
        RAISE EXCEPTION 'invalid friend request status transition from pending to %', NEW.status;
      END IF;
    ELSE
      -- Terminal states cannot change
      RAISE EXCEPTION 'friend request in status % cannot be updated', OLD.status;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_friend_request_guard ON public.friend_requests;
CREATE TRIGGER trg_friend_request_guard
  BEFORE UPDATE ON public.friend_requests
  FOR EACH ROW EXECUTE FUNCTION public.friend_request_guard();

-- Replace broad UPDATE policy with one that still requires involvement;
-- the trigger enforces field-level rules.
DROP POLICY IF EXISTS fr_update ON public.friend_requests;
CREATE POLICY fr_update ON public.friend_requests
  FOR UPDATE TO authenticated
  USING (requester_id = auth.uid() OR addressee_id = auth.uid())
  WITH CHECK (requester_id = auth.uid() OR addressee_id = auth.uid());

-- ============================================================================
-- 2. CONVERSATION PARTICIPANTS — no arbitrary self-join
-- ============================================================================

-- Helper: is the current user already a participant?
CREATE OR REPLACE FUNCTION public.is_conversation_participant(cid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.conversation_participants
    WHERE conversation_id = cid AND user_id = auth.uid()
  );
$$;

-- Drop the permissive self-insert policy
DROP POLICY IF EXISTS cp_insert ON public.conversation_participants;

-- Only allow insert when:
--   (a) inserting yourself AND you are already a participant (no-op path), OR
--   (b) inserting yourself as the first participant of a brand-new conversation
--       (no existing participants), OR
--   (c) an existing participant invites another user (inserting someone else)
-- For (c) the inserter must already be a participant; the row's user_id may be another user.
CREATE POLICY cp_insert_authorized ON public.conversation_participants
  FOR INSERT TO authenticated
  WITH CHECK (
    -- Case: first participant of a new conversation (must be self)
    (
      user_id = auth.uid()
      AND NOT EXISTS (
        SELECT 1 FROM public.conversation_participants cp
        WHERE cp.conversation_id = conversation_id
      )
    )
    OR
    -- Case: existing participant invites another user
    (
      public.is_conversation_participant(conversation_id)
      AND user_id IS NOT NULL
    )
  );

-- Note: the second branch allows a participant to add others OR re-add themselves.
-- A non-participant cannot satisfy is_conversation_participant, so self-join fails.

-- ============================================================================
-- 3. MESSAGE REACTIONS — require conversation membership
-- ============================================================================

DROP POLICY IF EXISTS mr_insert ON public.message_reactions;
CREATE POLICY mr_insert ON public.message_reactions
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM public.messages m
      JOIN public.conversation_participants cp
        ON cp.conversation_id = m.conversation_id
      WHERE m.id = message_id
        AND cp.user_id = auth.uid()
    )
  );

-- ============================================================================
-- 4. MESSAGES — reinforce membership on INSERT (already present; keep explicit)
-- ============================================================================

DROP POLICY IF EXISTS msg_insert ON public.messages;
CREATE POLICY msg_insert ON public.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND public.is_conversation_participant(conversation_id)
  );

-- ============================================================================
-- 5. PROFILES PRIVACY — real enforcement
-- ============================================================================

-- Simplify privacy to values we can enforce now:
--   public  = any authenticated user may SELECT
--   private = only owner
--   friends = owner + accepted friendship either direction
-- Remove followers/hidden from Phase 0 if not fully implemented — keep columns
-- but map unsupported values to private for SELECT.

CREATE OR REPLACE FUNCTION public.can_view_profile(target uuid, privacy text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    CASE
      WHEN target = auth.uid() THEN true
      WHEN privacy = 'public' THEN true
      WHEN privacy = 'friends' THEN EXISTS (
        SELECT 1 FROM public.friend_requests fr
        WHERE fr.status = 'accepted'
          AND (
            (fr.requester_id = auth.uid() AND fr.addressee_id = target)
            OR (fr.addressee_id = auth.uid() AND fr.requester_id = target)
          )
      )
      -- private, hidden, followers (deferred): owner only
      ELSE false
    END;
$$;

DROP POLICY IF EXISTS profiles_select ON public.profiles;
CREATE POLICY profiles_select ON public.profiles
  FOR SELECT TO authenticated
  USING (public.can_view_profile(id, privacy));

-- ============================================================================
-- 6. RATE LIMITS — server-side table + RPC
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.rate_limit_buckets (
  bucket_key text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  hit_count int NOT NULL DEFAULT 0
);

ALTER TABLE public.rate_limit_buckets ENABLE ROW LEVEL SECURITY;
-- No direct client access; only via SECURITY DEFINER function
DROP POLICY IF EXISTS rl_deny_all ON public.rate_limit_buckets;
CREATE POLICY rl_deny_all ON public.rate_limit_buckets
  FOR ALL TO authenticated USING (false) WITH CHECK (false);

CREATE OR REPLACE FUNCTION public.check_rate_limit(
  p_operation text,
  p_limit int DEFAULT 30,
  p_window_seconds int DEFAULT 60,
  p_cost int DEFAULT 1
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_key text;
  v_now timestamptz := now();
  v_window_start timestamptz;
  v_count int;
  v_retry int;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'code', 'AUTHENTICATION_REQUIRED');
  END IF;

  v_key := p_operation || ':' || v_uid::text;
  v_window_start := v_now - make_interval(secs => p_window_seconds);

  INSERT INTO public.rate_limit_buckets (bucket_key, window_start, hit_count)
  VALUES (v_key, v_now, p_cost)
  ON CONFLICT (bucket_key) DO UPDATE
  SET
    hit_count = CASE
      WHEN rate_limit_buckets.window_start < v_window_start THEN p_cost
      ELSE rate_limit_buckets.hit_count + p_cost
    END,
    window_start = CASE
      WHEN rate_limit_buckets.window_start < v_window_start THEN v_now
      ELSE rate_limit_buckets.window_start
    END
  RETURNING hit_count, window_start INTO v_count, v_window_start;

  IF v_count > p_limit THEN
    v_retry := GREATEST(1, EXTRACT(EPOCH FROM (v_window_start + make_interval(secs => p_window_seconds) - v_now))::int);
    RETURN jsonb_build_object(
      'allowed', false,
      'code', 'RATE_LIMITED',
      'retryAfterSeconds', v_retry
    );
  END IF;

  RETURN jsonb_build_object('allowed', true, 'remaining', p_limit - v_count);
END;
$$;

REVOKE ALL ON FUNCTION public.check_rate_limit FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_rate_limit TO authenticated;
