-- Phase 0.1 — Remaining authoritative mutations + contract fixes
SET search_path = public;

-- reports.details persistence
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS details text;

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
  INSERT INTO public.reports (reporter_id, target_type, target_id, reason, details, status)
  VALUES (v_uid, p_target_type, p_target_id, v_reason, p_details, 'open')
  RETURNING * INTO v_row;
  RETURN to_jsonb(v_row);
END;
$$;

-- post_like dedicated rate limit in check_rate_limit CASE
CREATE OR REPLACE FUNCTION public.check_rate_limit(p_operation text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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
    WHEN 'post_like' THEN v_limit := 60; v_window := 60;
    WHEN 'chapter_comment' THEN v_limit := 30; v_window := 60;
    WHEN 'conversation_create' THEN v_limit := 20; v_window := 60;
    WHEN 'group_member_add' THEN v_limit := 30; v_window := 60;
    WHEN 'search' THEN v_limit := 60; v_window := 60;
    ELSE v_limit := 30; v_window := 60;
  END CASE;
  v_key := p_operation || ':' || v_uid::text;
  v_window_start := v_now - make_interval(secs => v_window);
  INSERT INTO public.rate_limit_buckets (bucket_key, window_start, hit_count)
  VALUES (v_key, v_now, v_cost)
  ON CONFLICT (bucket_key) DO UPDATE
  SET
    hit_count = CASE WHEN rate_limit_buckets.window_start < v_window_start THEN v_cost ELSE rate_limit_buckets.hit_count + v_cost END,
    window_start = CASE WHEN rate_limit_buckets.window_start < v_window_start THEN v_now ELSE rate_limit_buckets.window_start END
  RETURNING hit_count, window_start INTO v_count, v_window_start;
  IF v_count > v_limit THEN
    v_retry := GREATEST(1, EXTRACT(EPOCH FROM (v_window_start + make_interval(secs => v_window) - v_now))::int);
    RETURN jsonb_build_object('allowed', false, 'code', 'RATE_LIMITED', 'retryAfterSeconds', v_retry);
  END IF;
  RETURN jsonb_build_object('allowed', true, 'remaining', v_limit - v_count);
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
  PERFORM public.require_rate_limit('post_like');
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

CREATE OR REPLACE FUNCTION public.delete_post(p_post_id uuid)
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
  SELECT user_id INTO v_owner FROM public.posts WHERE id = p_post_id;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF v_owner IS DISTINCT FROM v_uid THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  DELETE FROM public.post_likes WHERE post_id = p_post_id;
  DELETE FROM public.post_comments WHERE post_id = p_post_id;
  DELETE FROM public.posts WHERE id = p_post_id AND user_id = v_uid;
  RETURN jsonb_build_object('deleted', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.update_post(
  p_post_id uuid,
  p_body text DEFAULT NULL,
  p_spoiler boolean DEFAULT NULL,
  p_image_url text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.posts;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED'; END IF;
  SELECT * INTO v_row FROM public.posts WHERE id = p_post_id;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF v_row.user_id IS DISTINCT FROM v_uid THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF p_body IS NOT NULL THEN
    IF length(p_body) > 8000 THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
    v_row.body := p_body;
  END IF;
  IF p_spoiler IS NOT NULL THEN v_row.spoiler := p_spoiler; END IF;
  IF p_image_url IS NOT NULL THEN v_row.image_url := p_image_url; END IF;
  UPDATE public.posts SET body = v_row.body, spoiler = v_row.spoiler, image_url = v_row.image_url
  WHERE id = p_post_id AND user_id = v_uid
  RETURNING * INTO v_row;
  RETURN to_jsonb(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.unblock_user(p_blocked_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED'; END IF;
  IF p_blocked_user_id IS NULL OR p_blocked_user_id = v_uid THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  DELETE FROM public.blocks WHERE blocker_id = v_uid AND blocked_id = p_blocked_user_id;
  RETURN jsonb_build_object('unblocked', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.update_my_profile(
  p_username text DEFAULT NULL,
  p_name text DEFAULT NULL,
  p_avatar_url text DEFAULT NULL,
  p_bio text DEFAULT NULL,
  p_privacy text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.profiles;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED'; END IF;
  IF p_privacy IS NOT NULL AND p_privacy NOT IN ('public','friends','private','hidden','followers') THEN
    RAISE EXCEPTION 'INVALID_INPUT';
  END IF;
  INSERT INTO public.profiles (id, username, name, avatar_url, bio, privacy)
  VALUES (
    v_uid,
    p_username,
    p_name,
    p_avatar_url,
    p_bio,
    coalesce(p_privacy, 'public')
  )
  ON CONFLICT (id) DO UPDATE SET
    username = COALESCE(EXCLUDED.username, profiles.username),
    name = COALESCE(EXCLUDED.name, profiles.name),
    avatar_url = COALESCE(EXCLUDED.avatar_url, profiles.avatar_url),
    bio = COALESCE(EXCLUDED.bio, profiles.bio),
    privacy = COALESCE(EXCLUDED.privacy, profiles.privacy),
    updated_at = now()
  RETURNING * INTO v_row;
  RETURN to_jsonb(v_row);
END;
$$;

-- room_messages table (if product uses rooms) + send_room_message
CREATE TABLE IF NOT EXISTS public.room_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_room_messages_room ON public.room_messages(room_id, created_at);
ALTER TABLE public.room_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS room_msg_select ON public.room_messages;
CREATE POLICY room_msg_select ON public.room_messages FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS room_msg_insert ON public.room_messages;
CREATE POLICY room_msg_insert ON public.room_messages FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS room_msg_delete ON public.room_messages;
CREATE POLICY room_msg_delete ON public.room_messages FOR DELETE TO authenticated USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.send_room_message(p_room_id text, p_body text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_body text := trim(coalesce(p_body, ''));
  v_row public.room_messages;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED'; END IF;
  IF p_room_id IS NULL OR length(v_body) = 0 THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  IF length(v_body) > 8000 THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  PERFORM public.require_rate_limit('send_message');
  INSERT INTO public.room_messages (room_id, user_id, body)
  VALUES (p_room_id, v_uid, v_body)
  RETURNING * INTO v_row;
  RETURN to_jsonb(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_room_message(p_message_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED'; END IF;
  DELETE FROM public.room_messages WHERE id = p_message_id AND user_id = v_uid;
  IF NOT FOUND THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  RETURN jsonb_build_object('deleted', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_post(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_post(uuid, text, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unblock_user(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_my_profile(text, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.send_room_message(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_room_message(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_report(text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.toggle_post_like(uuid) TO authenticated;
