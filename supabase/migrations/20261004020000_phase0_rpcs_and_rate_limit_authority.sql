-- MangaHive Phase 0 — Reproducible RPCs + server-authoritative rate limits
-- All functions referenced by index.html must be created here.
-- Rate-limit policy is SERVER-DEFINED; clients only pass operation name.

-- ============================================================================
-- Conversations: explicit creator
-- ============================================================================
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.profiles(id);

-- Backfill is best-effort; new rows must set created_by
CREATE OR REPLACE FUNCTION public.conversations_set_creator()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.created_by IS NULL THEN
    NEW.created_by := auth.uid();
  END IF;
  IF NEW.created_by IS DISTINCT FROM auth.uid() AND auth.uid() IS NOT NULL THEN
    -- Only the session user may set themselves as creator on insert
    IF TG_OP = 'INSERT' THEN
      NEW.created_by := auth.uid();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_conversations_creator ON public.conversations;
CREATE TRIGGER trg_conversations_creator
  BEFORE INSERT ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.conversations_set_creator();

-- created_by immutable after insert
CREATE OR REPLACE FUNCTION public.conversations_freeze_creator()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'conversations.created_by is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_conversations_freeze_creator ON public.conversations;
CREATE TRIGGER trg_conversations_freeze_creator
  BEFORE UPDATE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.conversations_freeze_creator();

-- ============================================================================
-- Server-authoritative rate limit policy (client cannot set limit/window/cost)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.check_rate_limit(p_operation text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_key text;
  v_now timestamptz := now();
  v_limit int;
  v_window int;
  v_cost int := 1;
  v_window_start timestamptz;
  v_count int;
  v_retry int;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'code', 'AUTHENTICATION_REQUIRED');
  END IF;

  -- Authoritative policy table (server only)
  CASE p_operation
    WHEN 'friend_request' THEN v_limit := 20;  v_window := 60;
    WHEN 'accept_friend_request' THEN v_limit := 30; v_window := 60;
    WHEN 'follow' THEN v_limit := 40; v_window := 60;
    WHEN 'block' THEN v_limit := 30; v_window := 60;
    WHEN 'send_message' THEN v_limit := 60; v_window := 60;
    WHEN 'message_reaction' THEN v_limit := 60; v_window := 60;
    WHEN 'report' THEN v_limit := 15; v_window := 60;
    WHEN 'post_create' THEN v_limit := 20; v_window := 60;
    WHEN 'post_comment' THEN v_limit := 30; v_window := 60;
    WHEN 'chapter_comment' THEN v_limit := 30; v_window := 60;
    WHEN 'conversation_create' THEN v_limit := 20; v_window := 60;
    WHEN 'group_member_add' THEN v_limit := 30; v_window := 60;
    WHEN 'search' THEN v_limit := 60; v_window := 60;
    ELSE
      -- Unknown operations get a conservative default, not unlimited
      v_limit := 30; v_window := 60;
  END CASE;

  v_key := p_operation || ':' || v_uid::text;
  v_window_start := v_now - make_interval(secs => v_window);

  INSERT INTO public.rate_limit_buckets (bucket_key, window_start, hit_count)
  VALUES (v_key, v_now, v_cost)
  ON CONFLICT (bucket_key) DO UPDATE
  SET
    hit_count = CASE
      WHEN rate_limit_buckets.window_start < v_window_start THEN v_cost
      ELSE rate_limit_buckets.hit_count + v_cost
    END,
    window_start = CASE
      WHEN rate_limit_buckets.window_start < v_window_start THEN v_now
      ELSE rate_limit_buckets.window_start
    END
  RETURNING hit_count, window_start INTO v_count, v_window_start;

  IF v_count > v_limit THEN
    v_retry := GREATEST(1, EXTRACT(EPOCH FROM (v_window_start + make_interval(secs => v_window) - v_now))::int);
    RETURN jsonb_build_object(
      'allowed', false,
      'code', 'RATE_LIMITED',
      'retryAfterSeconds', v_retry
    );
  END IF;

  RETURN jsonb_build_object('allowed', true, 'remaining', v_limit - v_count);
END;
$$;

REVOKE ALL ON FUNCTION public.check_rate_limit(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_rate_limit(text) TO authenticated;

-- Drop the old signature that accepted client-controlled limit/window/cost if present
DROP FUNCTION IF EXISTS public.check_rate_limit(text, int, int, int);

-- ============================================================================
-- Helper: require rate limit or raise (fail closed)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.require_rate_limit(p_operation text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.check_rate_limit(p_operation);
  IF (v_result->>'allowed')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION '%', coalesce(v_result->>'code', 'RATE_LIMITED')
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- ============================================================================
-- Participant policy: only creator/owner may add members (tighten)
-- ============================================================================
DROP POLICY IF EXISTS cp_insert_authorized ON public.conversation_participants;
DROP POLICY IF EXISTS cp_insert ON public.conversation_participants;

CREATE OR REPLACE FUNCTION public.can_manage_participants(cid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = cid AND c.created_by = auth.uid()
  );
$$;

-- Insert rules:
-- 1) First participant: must be self AND conversation created_by = self
-- 2) Additional: only conversation creator may add others
CREATE POLICY cp_insert_owner_only ON public.conversation_participants
  FOR INSERT TO authenticated
  WITH CHECK (
    (
      user_id = auth.uid()
      AND EXISTS (
        SELECT 1 FROM public.conversations c
        WHERE c.id = conversation_id AND c.created_by = auth.uid()
      )
      AND (
        NOT EXISTS (SELECT 1 FROM public.conversation_participants cp WHERE cp.conversation_id = conversation_id)
        OR public.can_manage_participants(conversation_id)
      )
    )
    OR
    (
      public.can_manage_participants(conversation_id)
    )
  );

-- ============================================================================
-- RPCs used by index.html (SECURITY DEFINER, safe search_path, rate limited)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.send_friend_request(p_addressee uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.friend_requests;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'AUTHENTICATION_REQUIRED';
  END IF;
  IF p_addressee IS NULL OR p_addressee = v_uid THEN
    RAISE EXCEPTION 'VALIDATION_ERROR';
  END IF;
  PERFORM public.require_rate_limit('friend_request');
  INSERT INTO public.friend_requests (requester_id, addressee_id, status)
  VALUES (v_uid, p_addressee, 'pending')
  ON CONFLICT (requester_id, addressee_id) DO UPDATE
    SET status = CASE
      WHEN friend_requests.status = 'cancelled' THEN 'pending'
      ELSE friend_requests.status
    END,
    updated_at = now()
  RETURNING * INTO v_row;
  RETURN to_jsonb(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.accept_friend_request(p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.friend_requests;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'AUTHENTICATION_REQUIRED'; END IF;
  PERFORM public.require_rate_limit('accept_friend_request');
  UPDATE public.friend_requests
  SET status = 'accepted', updated_at = now()
  WHERE id = p_request_id AND addressee_id = v_uid AND status = 'pending'
  RETURNING * INTO v_row;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  RETURN to_jsonb(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.toggle_follow(p_target uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_exists boolean;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'AUTHENTICATION_REQUIRED'; END IF;
  IF p_target IS NULL OR p_target = v_uid THEN RAISE EXCEPTION 'VALIDATION_ERROR'; END IF;
  PERFORM public.require_rate_limit('follow');
  SELECT EXISTS(SELECT 1 FROM public.follows WHERE follower_id = v_uid AND following_id = p_target) INTO v_exists;
  IF v_exists THEN
    DELETE FROM public.follows WHERE follower_id = v_uid AND following_id = p_target;
    RETURN jsonb_build_object('following', false);
  ELSE
    INSERT INTO public.follows (follower_id, following_id) VALUES (v_uid, p_target);
    RETURN jsonb_build_object('following', true);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.block_user(p_target uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'AUTHENTICATION_REQUIRED'; END IF;
  IF p_target IS NULL OR p_target = v_uid THEN RAISE EXCEPTION 'VALIDATION_ERROR'; END IF;
  PERFORM public.require_rate_limit('block');
  INSERT INTO public.blocks (blocker_id, blocked_id) VALUES (v_uid, p_target)
  ON CONFLICT DO NOTHING;
  -- Cancel pending friend requests both ways
  UPDATE public.friend_requests SET status = 'cancelled', updated_at = now()
  WHERE status = 'pending'
    AND ((requester_id = v_uid AND addressee_id = p_target)
      OR (requester_id = p_target AND addressee_id = v_uid));
  RETURN jsonb_build_object('blocked', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_or_create_direct_conversation(other_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_conv uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'AUTHENTICATION_REQUIRED'; END IF;
  IF other_user_id IS NULL OR other_user_id = v_uid THEN RAISE EXCEPTION 'VALIDATION_ERROR'; END IF;
  PERFORM public.require_rate_limit('conversation_create');

  -- Find existing direct (non-group) conversation with exactly these two participants
  SELECT c.id INTO v_conv
  FROM public.conversations c
  WHERE c.is_group = false
    AND EXISTS (SELECT 1 FROM public.conversation_participants p WHERE p.conversation_id = c.id AND p.user_id = v_uid)
    AND EXISTS (SELECT 1 FROM public.conversation_participants p WHERE p.conversation_id = c.id AND p.user_id = other_user_id)
    AND (SELECT count(*) FROM public.conversation_participants p WHERE p.conversation_id = c.id) = 2
  LIMIT 1;

  IF v_conv IS NOT NULL THEN
    RETURN v_conv;
  END IF;

  INSERT INTO public.conversations (is_group, created_by)
  VALUES (false, v_uid)
  RETURNING id INTO v_conv;

  INSERT INTO public.conversation_participants (conversation_id, user_id) VALUES (v_conv, v_uid);
  INSERT INTO public.conversation_participants (conversation_id, user_id) VALUES (v_conv, other_user_id);

  RETURN v_conv;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_group_conversation(group_name text, member_ids uuid[])
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_conv uuid;
  v_member uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'AUTHENTICATION_REQUIRED'; END IF;
  PERFORM public.require_rate_limit('conversation_create');
  INSERT INTO public.conversations (is_group, title, created_by)
  VALUES (true, group_name, v_uid)
  RETURNING id INTO v_conv;
  INSERT INTO public.conversation_participants (conversation_id, user_id) VALUES (v_conv, v_uid);
  IF member_ids IS NOT NULL THEN
    FOREACH v_member IN ARRAY member_ids LOOP
      IF v_member IS NOT NULL AND v_member <> v_uid THEN
        INSERT INTO public.conversation_participants (conversation_id, user_id)
        VALUES (v_conv, v_member) ON CONFLICT DO NOTHING;
      END IF;
    END LOOP;
  END IF;
  RETURN v_conv;
END;
$$;

CREATE OR REPLACE FUNCTION public.add_group_member(p_conversation_id uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'AUTHENTICATION_REQUIRED'; END IF;
  IF NOT public.can_manage_participants(p_conversation_id) THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;
  PERFORM public.require_rate_limit('group_member_add');
  INSERT INTO public.conversation_participants (conversation_id, user_id)
  VALUES (p_conversation_id, p_user_id)
  ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.toggle_message_reaction(p_message_id uuid, p_emoji text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_conv uuid;
  v_exists boolean;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'AUTHENTICATION_REQUIRED'; END IF;
  SELECT m.conversation_id INTO v_conv FROM public.messages m WHERE m.id = p_message_id;
  IF v_conv IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF NOT public.is_conversation_participant(v_conv) THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;
  PERFORM public.require_rate_limit('message_reaction');
  SELECT EXISTS(
    SELECT 1 FROM public.message_reactions
    WHERE message_id = p_message_id AND user_id = v_uid AND emoji = p_emoji
  ) INTO v_exists;
  IF v_exists THEN
    DELETE FROM public.message_reactions
    WHERE message_id = p_message_id AND user_id = v_uid AND emoji = p_emoji;
    RETURN jsonb_build_object('reacted', false);
  ELSE
    INSERT INTO public.message_reactions (message_id, user_id, emoji)
    VALUES (p_message_id, v_uid, p_emoji);
    RETURN jsonb_build_object('reacted', true);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_my_profile()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.profiles;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'AUTHENTICATION_REQUIRED'; END IF;
  SELECT * INTO v_row FROM public.profiles WHERE id = v_uid;
  RETURN to_jsonb(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_public_profile(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.profiles;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'AUTHENTICATION_REQUIRED'; END IF;
  SELECT * INTO v_row FROM public.profiles WHERE id = p_user_id;
  IF v_row.id IS NULL THEN RETURN NULL; END IF;
  IF NOT public.can_view_profile(v_row.id, v_row.privacy) THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;
  RETURN to_jsonb(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.search_profiles(q text)
RETURNS SETOF public.profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'AUTHENTICATION_REQUIRED'; END IF;
  PERFORM public.require_rate_limit('search');
  RETURN QUERY
  SELECT p.* FROM public.profiles p
  WHERE p.privacy = 'public'
    AND (
      p.username ILIKE '%' || q || '%'
      OR p.name ILIKE '%' || q || '%'
    )
  LIMIT 50;
END;
$$;

CREATE OR REPLACE FUNCTION public.is_name_available(candidate text, include_username boolean DEFAULT true)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF candidate IS NULL OR length(trim(candidate)) = 0 THEN
    RETURN false;
  END IF;
  IF include_username THEN
    RETURN NOT EXISTS (SELECT 1 FROM public.profiles WHERE lower(username) = lower(candidate));
  END IF;
  RETURN NOT EXISTS (SELECT 1 FROM public.profiles WHERE lower(name) = lower(candidate));
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_notifications_read(p_ids uuid[] DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'AUTHENTICATION_REQUIRED'; END IF;
  IF p_ids IS NULL THEN
    UPDATE public.notifications SET read_at = now()
    WHERE user_id = v_uid AND read_at IS NULL;
  ELSE
    UPDATE public.notifications SET read_at = now()
    WHERE user_id = v_uid AND id = ANY(p_ids);
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.rename_group(p_conversation_id uuid, p_name text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'AUTHENTICATION_REQUIRED'; END IF;
  IF NOT public.can_manage_participants(p_conversation_id) THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;
  UPDATE public.conversations SET title = p_name WHERE id = p_conversation_id AND is_group = true;
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.accept_message_request(p_conversation_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'AUTHENTICATION_REQUIRED'; END IF;
  IF NOT public.is_conversation_participant(p_conversation_id) THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.decline_message_request(p_conversation_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'AUTHENTICATION_REQUIRED'; END IF;
  IF NOT public.is_conversation_participant(p_conversation_id) THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_declined_message_request(p_conversation_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'AUTHENTICATION_REQUIRED'; END IF;
  DELETE FROM public.conversation_participants
  WHERE conversation_id = p_conversation_id AND user_id = auth.uid();
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_chapter_comment(
  p_series_id text,
  p_chapter_id text,
  p_body text,
  p_spoiler boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.chapter_comments;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'AUTHENTICATION_REQUIRED'; END IF;
  PERFORM public.require_rate_limit('chapter_comment');
  INSERT INTO public.chapter_comments (user_id, series_id, chapter_id, body, spoiler)
  VALUES (v_uid, p_series_id, p_chapter_id, p_body, coalesce(p_spoiler, false))
  RETURNING * INTO v_row;
  RETURN to_jsonb(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.app_schema_version()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT 'phase0-2026-10-04';
$$;

CREATE OR REPLACE FUNCTION public.conversation_last_messages(p_ids uuid[])
RETURNS TABLE(conversation_id uuid, body text, user_id uuid, created_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'AUTHENTICATION_REQUIRED'; END IF;
  RETURN QUERY
  SELECT DISTINCT ON (m.conversation_id)
    m.conversation_id, m.body, m.user_id, m.created_at
  FROM public.messages m
  WHERE m.conversation_id = ANY(p_ids)
    AND public.is_conversation_participant(m.conversation_id)
  ORDER BY m.conversation_id, m.created_at DESC;
END;
$$;

-- Grants
REVOKE ALL ON FUNCTION public.send_friend_request FROM PUBLIC;
REVOKE ALL ON FUNCTION public.accept_friend_request FROM PUBLIC;
REVOKE ALL ON FUNCTION public.toggle_follow FROM PUBLIC;
REVOKE ALL ON FUNCTION public.block_user FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_or_create_direct_conversation FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_group_conversation FROM PUBLIC;
REVOKE ALL ON FUNCTION public.add_group_member FROM PUBLIC;
REVOKE ALL ON FUNCTION public.toggle_message_reaction FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.send_friend_request TO authenticated;
GRANT EXECUTE ON FUNCTION public.accept_friend_request TO authenticated;
GRANT EXECUTE ON FUNCTION public.toggle_follow TO authenticated;
GRANT EXECUTE ON FUNCTION public.block_user TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_or_create_direct_conversation TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_group_conversation TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_group_member TO authenticated;
GRANT EXECUTE ON FUNCTION public.toggle_message_reaction TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_profile TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_profile TO authenticated;
GRANT EXECUTE ON FUNCTION public.search_profiles TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_name_available TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_name_available(text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_notifications_read TO authenticated;
GRANT EXECUTE ON FUNCTION public.rename_group TO authenticated;
GRANT EXECUTE ON FUNCTION public.accept_message_request TO authenticated;
GRANT EXECUTE ON FUNCTION public.decline_message_request TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_declined_message_request TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_chapter_comment TO authenticated;
GRANT EXECUTE ON FUNCTION public.app_schema_version TO authenticated;
GRANT EXECUTE ON FUNCTION public.conversation_last_messages TO authenticated;
