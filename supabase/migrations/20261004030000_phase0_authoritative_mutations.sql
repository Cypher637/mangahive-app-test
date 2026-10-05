-- Phase 0 — Authoritative mutations + RPC contract alignment
-- Aligns SQL with frontend argument names where product already depends on them.
-- Implements missing send_message, delete_message, create_post, comments, likes, reports, leave, friend cancel/decline.

SET search_path = public;

-- ---------------------------------------------------------------------------
-- Align toggle_message_reaction with frontend (p_kind, p_message_id, p_emoji, p_adding)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.toggle_message_reaction(
  p_kind text,
  p_message_id uuid,
  p_emoji text,
  p_adding boolean DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_conv uuid;
  v_exists boolean;
  v_emoji text := coalesce(nullif(trim(p_emoji), ''), '👍');
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED'; END IF;
  IF p_message_id IS NULL THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  -- DM path (room messages are separate product surface; only messages table here)
  SELECT m.conversation_id INTO v_conv FROM public.messages m WHERE m.id = p_message_id;
  IF v_conv IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF NOT public.is_conversation_participant(v_conv) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  PERFORM public.require_rate_limit('message_reaction');

  SELECT EXISTS(
    SELECT 1 FROM public.message_reactions
    WHERE message_id = p_message_id AND user_id = v_uid AND emoji = v_emoji
  ) INTO v_exists;

  IF p_adding IS TRUE OR (p_adding IS NULL AND NOT v_exists) THEN
    IF NOT v_exists THEN
      INSERT INTO public.message_reactions (message_id, user_id, emoji)
      VALUES (p_message_id, v_uid, v_emoji);
    END IF;
    RETURN jsonb_build_object('reacted', true, 'emoji', v_emoji);
  ELSE
    DELETE FROM public.message_reactions
    WHERE message_id = p_message_id AND user_id = v_uid AND emoji = v_emoji;
    RETURN jsonb_build_object('reacted', false, 'emoji', v_emoji);
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- block_user: accept p_blocked (frontend) as alias
-- ---------------------------------------------------------------------------
-- Phase 0.7: migration 0.2 created block_user(p_target uuid). PostgreSQL refuses
-- CREATE OR REPLACE that renames an input parameter (SQLSTATE 42P13), so the
-- same-signature function must be dropped first. Grants are re-applied below
-- and in 0.4 (DROP resets the ACL to the PostgreSQL default).
DROP FUNCTION IF EXISTS public.block_user(uuid);
CREATE OR REPLACE FUNCTION public.block_user(p_blocked uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED'; END IF;
  IF p_blocked IS NULL OR p_blocked = v_uid THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  PERFORM public.require_rate_limit('block');
  INSERT INTO public.blocks (blocker_id, blocked_id) VALUES (v_uid, p_blocked)
  ON CONFLICT DO NOTHING;
  UPDATE public.friend_requests SET status = 'cancelled', updated_at = now()
  WHERE status = 'pending'
    AND ((requester_id = v_uid AND addressee_id = p_blocked)
      OR (requester_id = p_blocked AND addressee_id = v_uid));
  RETURN jsonb_build_object('blocked', true);
END;
$$;

-- Also support p_target name used in earlier migration
CREATE OR REPLACE FUNCTION public.block_user_by_target(p_target uuid)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.block_user(p_target);
$$;

-- ---------------------------------------------------------------------------
-- get_public_profile: accept target_id (frontend) 
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_public_profile(target_id uuid DEFAULT NULL, target_name text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.profiles;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED'; END IF;
  IF target_id IS NOT NULL THEN
    SELECT * INTO v_row FROM public.profiles WHERE id = target_id;
  ELSIF target_name IS NOT NULL THEN
    SELECT * INTO v_row FROM public.profiles WHERE lower(username) = lower(target_name) OR lower(name) = lower(target_name) LIMIT 1;
  ELSE
    RAISE EXCEPTION 'INVALID_INPUT';
  END IF;
  IF v_row.id IS NULL THEN RETURN NULL; END IF;
  IF NOT public.can_view_profile(v_row.id, v_row.privacy) THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;
  RETURN to_jsonb(v_row);
END;
$$;

-- ---------------------------------------------------------------------------
-- sync_chapter_comment: support p_client_id for idempotency
-- ---------------------------------------------------------------------------
ALTER TABLE public.chapter_comments
  ADD COLUMN IF NOT EXISTS client_id text;

CREATE UNIQUE INDEX IF NOT EXISTS chapter_comments_client_id_uidx
  ON public.chapter_comments (user_id, client_id)
  WHERE client_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.sync_chapter_comment(
  p_client_id text,
  p_series_id text,
  p_chapter_id text,
  p_body text,
  p_spoiler boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.chapter_comments;
  v_body text := trim(coalesce(p_body, ''));
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED'; END IF;
  IF p_series_id IS NULL OR p_chapter_id IS NULL OR length(v_body) = 0 THEN
    RAISE EXCEPTION 'INVALID_INPUT';
  END IF;
  IF length(v_body) > 4000 THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  PERFORM public.require_rate_limit('chapter_comment');

  IF p_client_id IS NOT NULL THEN
    SELECT * INTO v_row FROM public.chapter_comments
    WHERE user_id = v_uid AND client_id = p_client_id;
    IF v_row.id IS NOT NULL THEN
      RETURN to_jsonb(v_row);
    END IF;
  END IF;

  INSERT INTO public.chapter_comments (user_id, series_id, chapter_id, body, spoiler, client_id)
  VALUES (v_uid, p_series_id, p_chapter_id, v_body, coalesce(p_spoiler, false), p_client_id)
  RETURNING * INTO v_row;
  RETURN to_jsonb(v_row);
END;
$$;

-- ---------------------------------------------------------------------------
-- send_message (authoritative)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.send_message(
  p_conversation_id uuid,
  p_body text,
  p_reply_to_message_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_body text := trim(coalesce(p_body, ''));
  v_row public.messages;
  v_reply_conv uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED'; END IF;
  IF p_conversation_id IS NULL OR length(v_body) = 0 THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  IF length(v_body) > 8000 THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  IF NOT public.is_conversation_participant(p_conversation_id) THEN RAISE EXCEPTION 'NOT_MEMBER'; END IF;
  IF p_reply_to_message_id IS NOT NULL THEN
    SELECT conversation_id INTO v_reply_conv FROM public.messages WHERE id = p_reply_to_message_id;
    IF v_reply_conv IS DISTINCT FROM p_conversation_id THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  END IF;
  PERFORM public.require_rate_limit('send_message');
  INSERT INTO public.messages (conversation_id, user_id, body)
  VALUES (p_conversation_id, v_uid, v_body)
  RETURNING * INTO v_row;
  RETURN to_jsonb(v_row);
END;
$$;

-- ---------------------------------------------------------------------------
-- delete_message (author only)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.delete_message(p_message_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_owner uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED'; END IF;
  IF p_message_id IS NULL THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  SELECT user_id INTO v_owner FROM public.messages WHERE id = p_message_id;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF v_owner IS DISTINCT FROM v_uid THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  DELETE FROM public.messages WHERE id = p_message_id AND user_id = v_uid;
  RETURN jsonb_build_object('deleted', true);
END;
$$;

-- ---------------------------------------------------------------------------
-- create_post
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_post(
  p_body text,
  p_image_url text DEFAULT NULL,
  p_series_id text DEFAULT NULL,
  p_series_title text DEFAULT NULL,
  p_source text DEFAULT NULL,
  p_remote_id text DEFAULT NULL,
  p_cover_url text DEFAULT NULL,
  p_spoiler boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_body text := coalesce(p_body, '');
  v_row public.posts;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED'; END IF;
  IF length(trim(v_body)) = 0 AND p_image_url IS NULL THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  IF length(v_body) > 8000 THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  PERFORM public.require_rate_limit('post_create');
  INSERT INTO public.posts (
    user_id, body, image_url, series_id, series_title, source, remote_id, cover_url, spoiler
  ) VALUES (
    v_uid, v_body, p_image_url, p_series_id, p_series_title, p_source, p_remote_id, p_cover_url, coalesce(p_spoiler, false)
  ) RETURNING * INTO v_row;
  RETURN to_jsonb(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.add_post_comment(p_post_id uuid, p_body text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_body text := trim(coalesce(p_body, ''));
  v_row public.post_comments;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED'; END IF;
  IF p_post_id IS NULL OR length(v_body) = 0 THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  IF length(v_body) > 4000 THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.posts WHERE id = p_post_id) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  PERFORM public.require_rate_limit('post_comment');
  INSERT INTO public.post_comments (post_id, user_id, body)
  VALUES (p_post_id, v_uid, v_body)
  RETURNING * INTO v_row;
  RETURN to_jsonb(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.toggle_post_like(p_post_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_exists boolean;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED'; END IF;
  IF p_post_id IS NULL THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.posts WHERE id = p_post_id) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  PERFORM public.require_rate_limit('post_comment'); -- reuse moderate bucket
  SELECT EXISTS(SELECT 1 FROM public.post_likes WHERE post_id = p_post_id AND user_id = v_uid) INTO v_exists;
  IF v_exists THEN
    DELETE FROM public.post_likes WHERE post_id = p_post_id AND user_id = v_uid;
    RETURN jsonb_build_object('liked', false);
  ELSE
    INSERT INTO public.post_likes (post_id, user_id) VALUES (p_post_id, v_uid);
    RETURN jsonb_build_object('liked', true);
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- submit_report (canonical schema)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.submit_report(
  p_target_type text,
  p_target_id text,
  p_reason text,
  p_details text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_reason text := trim(coalesce(p_reason, ''));
  v_row public.reports;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED'; END IF;
  IF p_target_type IS NULL OR p_target_id IS NULL OR length(v_reason) = 0 THEN
    RAISE EXCEPTION 'INVALID_INPUT';
  END IF;
  IF length(v_reason) > 500 THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  PERFORM public.require_rate_limit('report');
  INSERT INTO public.reports (reporter_id, target_type, target_id, reason, status)
  VALUES (v_uid, p_target_type, p_target_id, v_reason, 'open')
  RETURNING * INTO v_row;
  RETURN to_jsonb(v_row);
END;
$$;

-- ---------------------------------------------------------------------------
-- Friend decline / cancel / remove
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.decline_friend_request(p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.friend_requests;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED'; END IF;
  UPDATE public.friend_requests
  SET status = 'rejected', updated_at = now()
  WHERE id = p_request_id AND addressee_id = v_uid AND status = 'pending'
  RETURNING * INTO v_row;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  RETURN to_jsonb(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_friend_request(p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.friend_requests;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED'; END IF;
  UPDATE public.friend_requests
  SET status = 'cancelled', updated_at = now()
  WHERE id = p_request_id AND requester_id = v_uid AND status = 'pending'
  RETURNING * INTO v_row;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  RETURN to_jsonb(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.remove_friend(p_other_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED'; END IF;
  IF p_other_user_id IS NULL OR p_other_user_id = v_uid THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  UPDATE public.friend_requests
  SET status = 'cancelled', updated_at = now()
  WHERE status = 'accepted'
    AND ((requester_id = v_uid AND addressee_id = p_other_user_id)
      OR (requester_id = p_other_user_id AND addressee_id = v_uid));
  RETURN jsonb_build_object('removed', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.leave_conversation(p_conversation_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED'; END IF;
  IF NOT public.is_conversation_participant(p_conversation_id) THEN RAISE EXCEPTION 'NOT_MEMBER'; END IF;
  DELETE FROM public.conversation_participants
  WHERE conversation_id = p_conversation_id AND user_id = v_uid;
  RETURN jsonb_build_object('left', true);
END;
$$;

-- Grants
GRANT EXECUTE ON FUNCTION public.toggle_message_reaction(text, uuid, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.block_user(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_profile(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_chapter_comment(text, text, text, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.send_message(uuid, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_message(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_post(text, text, text, text, text, text, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_post_comment(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.toggle_post_like(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_report(text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.decline_friend_request(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_friend_request(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_friend(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.leave_conversation(uuid) TO authenticated;
