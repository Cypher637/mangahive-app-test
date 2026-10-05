-- Phase 0.3 — Enforce RPC-only writes at the database boundary
-- Authenticated clients may SELECT (per policy) but must NOT INSERT/UPDATE/DELETE
-- sensitive tables via PostgREST. Mutations go through SECURITY DEFINER RPCs only.
SET search_path = public;

-- ---------------------------------------------------------------------------
-- Helper: revoke direct write policies (keep SELECT where intentional)
-- ---------------------------------------------------------------------------

-- posts: drop client write policies
DROP POLICY IF EXISTS posts_insert ON public.posts;
DROP POLICY IF EXISTS posts_update ON public.posts;
DROP POLICY IF EXISTS posts_delete ON public.posts;
-- Explicit deny for authenticated writes (defense in depth; no policy = deny for RLS)
CREATE POLICY posts_insert_deny ON public.posts FOR INSERT TO authenticated WITH CHECK (false);
CREATE POLICY posts_update_deny ON public.posts FOR UPDATE TO authenticated USING (false);
CREATE POLICY posts_delete_deny ON public.posts FOR DELETE TO authenticated USING (false);

-- post_comments
DROP POLICY IF EXISTS pc_insert ON public.post_comments;
DROP POLICY IF EXISTS pc_delete ON public.post_comments;
CREATE POLICY pc_insert_deny ON public.post_comments FOR INSERT TO authenticated WITH CHECK (false);
CREATE POLICY pc_delete_deny ON public.post_comments FOR DELETE TO authenticated USING (false);

-- post_likes
DROP POLICY IF EXISTS pl_insert ON public.post_likes;
DROP POLICY IF EXISTS pl_delete ON public.post_likes;
CREATE POLICY pl_insert_deny ON public.post_likes FOR INSERT TO authenticated WITH CHECK (false);
CREATE POLICY pl_delete_deny ON public.post_likes FOR DELETE TO authenticated USING (false);

-- messages
DROP POLICY IF EXISTS msg_insert ON public.messages;
CREATE POLICY msg_insert_deny ON public.messages FOR INSERT TO authenticated WITH CHECK (false);
CREATE POLICY msg_update_deny ON public.messages FOR UPDATE TO authenticated USING (false);
CREATE POLICY msg_delete_deny ON public.messages FOR DELETE TO authenticated USING (false);

-- message_reactions
DROP POLICY IF EXISTS mr_insert ON public.message_reactions;
DROP POLICY IF EXISTS mr_delete ON public.message_reactions;
CREATE POLICY mr_insert_deny ON public.message_reactions FOR INSERT TO authenticated WITH CHECK (false);
CREATE POLICY mr_delete_deny ON public.message_reactions FOR DELETE TO authenticated USING (false);

-- friend_requests (writes via RPC only; keep SELECT for participants)
DROP POLICY IF EXISTS fr_insert ON public.friend_requests;
DROP POLICY IF EXISTS fr_update ON public.friend_requests;
DROP POLICY IF EXISTS fr_delete ON public.friend_requests;
CREATE POLICY fr_insert_deny ON public.friend_requests FOR INSERT TO authenticated WITH CHECK (false);
CREATE POLICY fr_update_deny ON public.friend_requests FOR UPDATE TO authenticated USING (false);
CREATE POLICY fr_delete_deny ON public.friend_requests FOR DELETE TO authenticated USING (false);

-- blocks
DROP POLICY IF EXISTS blocks_insert ON public.blocks;
DROP POLICY IF EXISTS blocks_delete ON public.blocks;
CREATE POLICY blocks_insert_deny ON public.blocks FOR INSERT TO authenticated WITH CHECK (false);
CREATE POLICY blocks_delete_deny ON public.blocks FOR DELETE TO authenticated USING (false);

-- conversations
DROP POLICY IF EXISTS conv_insert ON public.conversations;
CREATE POLICY conv_insert_deny ON public.conversations FOR INSERT TO authenticated WITH CHECK (false);
CREATE POLICY conv_update_deny ON public.conversations FOR UPDATE TO authenticated USING (false);
CREATE POLICY conv_delete_deny ON public.conversations FOR DELETE TO authenticated USING (false);

-- conversation_participants
DROP POLICY IF EXISTS cp_insert ON public.conversation_participants;
DROP POLICY IF EXISTS cp_insert_authorized ON public.conversation_participants;
DROP POLICY IF EXISTS cp_insert_owner_only ON public.conversation_participants;
DROP POLICY IF EXISTS cp_delete ON public.conversation_participants;
CREATE POLICY cp_insert_deny ON public.conversation_participants FOR INSERT TO authenticated WITH CHECK (false);
CREATE POLICY cp_delete_deny ON public.conversation_participants FOR DELETE TO authenticated USING (false);

-- profiles: only via update_my_profile RPC
DROP POLICY IF EXISTS profiles_insert_own ON public.profiles;
DROP POLICY IF EXISTS profiles_update_own ON public.profiles;
CREATE POLICY profiles_insert_deny ON public.profiles FOR INSERT TO authenticated WITH CHECK (false);
CREATE POLICY profiles_update_deny ON public.profiles FOR UPDATE TO authenticated USING (false);

-- reports
DROP POLICY IF EXISTS reports_insert ON public.reports;
CREATE POLICY reports_insert_deny ON public.reports FOR INSERT TO authenticated WITH CHECK (false);
CREATE POLICY reports_update_deny ON public.reports FOR UPDATE TO authenticated USING (false);

-- chapter_comments
DROP POLICY IF EXISTS cc_insert ON public.chapter_comments;
DROP POLICY IF EXISTS cc_delete ON public.chapter_comments;
CREATE POLICY cc_insert_deny ON public.chapter_comments FOR INSERT TO authenticated WITH CHECK (false);
CREATE POLICY cc_delete_deny ON public.chapter_comments FOR DELETE TO authenticated USING (false);

-- room_messages: deny direct writes (RPC only)
DROP POLICY IF EXISTS room_msg_insert ON public.room_messages;
DROP POLICY IF EXISTS room_msg_delete ON public.room_messages;
CREATE POLICY room_msg_insert_deny ON public.room_messages FOR INSERT TO authenticated WITH CHECK (false);
CREATE POLICY room_msg_update_deny ON public.room_messages FOR UPDATE TO authenticated USING (false);
CREATE POLICY room_msg_delete_deny ON public.room_messages FOR DELETE TO authenticated USING (false);

-- notifications: only mark read via RPC; no client insert
CREATE POLICY notif_insert_deny ON public.notifications FOR INSERT TO authenticated WITH CHECK (false);
CREATE POLICY notif_delete_deny ON public.notifications FOR DELETE TO authenticated USING (false);

-- ---------------------------------------------------------------------------
-- Room registry (formalize public_authenticated model)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.rooms (
  id text PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'disabled')),
  visibility text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.rooms ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rooms_select ON public.rooms;
CREATE POLICY rooms_select ON public.rooms FOR SELECT TO authenticated
  USING (status = 'active' AND visibility = 'public');
CREATE POLICY rooms_insert_deny ON public.rooms FOR INSERT TO authenticated WITH CHECK (false);
CREATE POLICY rooms_update_deny ON public.rooms FOR UPDATE TO authenticated USING (false);
CREATE POLICY rooms_delete_deny ON public.rooms FOR DELETE TO authenticated USING (false);

-- Seed default public rooms used by the product (idempotent)
INSERT INTO public.rooms (id, name, status, visibility) VALUES
  ('general', 'General', 'active', 'public'),
  ('spoilers', 'Spoilers', 'active', 'public'),
  ('help', 'Help', 'active', 'public')
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.room_is_accessible(p_room_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.rooms r
    WHERE r.id = p_room_id
      AND r.status = 'active'
      AND r.visibility = 'public'
  );
$$;

-- Harden send_room_message / edit_room_message / delete_room_message
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
  IF NOT public.room_is_accessible(p_room_id) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  PERFORM public.require_rate_limit('send_message');
  INSERT INTO public.room_messages (room_id, user_id, body)
  VALUES (p_room_id, v_uid, v_body)
  RETURNING * INTO v_row;
  RETURN to_jsonb(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.edit_room_message(p_message_id uuid, p_body text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_body text := trim(coalesce(p_body, ''));
  v_row public.room_messages;
  v_owner uuid;
  v_room text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED'; END IF;
  IF p_message_id IS NULL OR length(v_body) = 0 THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  IF length(v_body) > 8000 THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  SELECT user_id, room_id INTO v_owner, v_room FROM public.room_messages WHERE id = p_message_id;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF v_owner IS DISTINCT FROM v_uid THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF NOT public.room_is_accessible(v_room) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  PERFORM public.require_rate_limit('send_message');
  UPDATE public.room_messages SET body = v_body WHERE id = p_message_id AND user_id = v_uid
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
  v_owner uuid;
  v_room text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED'; END IF;
  SELECT user_id, room_id INTO v_owner, v_room FROM public.room_messages WHERE id = p_message_id;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF v_owner IS DISTINCT FROM v_uid THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF NOT public.room_is_accessible(v_room) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  DELETE FROM public.room_messages WHERE id = p_message_id AND user_id = v_uid;
  RETURN jsonb_build_object('deleted', true);
END;
$$;

-- Room SELECT: only messages in accessible public rooms
DROP POLICY IF EXISTS room_msg_select ON public.room_messages;
CREATE POLICY room_msg_select ON public.room_messages FOR SELECT TO authenticated
  USING (public.room_is_accessible(room_id));

-- Ensure toggle_post_like uses post_like (not post_comment)
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

-- Profile validation hardening
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
  v_username text;
  v_name text;
  v_bio text;
  v_avatar text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED'; END IF;
  IF p_privacy IS NOT NULL AND p_privacy NOT IN ('public','friends','private','hidden','followers') THEN
    RAISE EXCEPTION 'INVALID_INPUT';
  END IF;
  v_username := NULLIF(trim(p_username), '');
  v_name := NULLIF(trim(p_name), '');
  v_bio := NULLIF(trim(p_bio), '');
  v_avatar := NULLIF(trim(p_avatar_url), '');
  IF v_username IS NOT NULL THEN
    IF length(v_username) < 3 OR length(v_username) > 32 THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
    IF v_username !~ '^[A-Za-z][A-Za-z0-9_]*$' THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  END IF;
  IF v_name IS NOT NULL AND length(v_name) > 64 THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  IF v_bio IS NOT NULL AND length(v_bio) > 500 THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  IF v_avatar IS NOT NULL THEN
    IF length(v_avatar) > 2048 THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
    IF v_avatar !~ '^https://' THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  END IF;
  INSERT INTO public.profiles (id, username, name, avatar_url, bio, privacy)
  VALUES (v_uid, v_username, v_name, v_avatar, v_bio, coalesce(p_privacy, 'public'))
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

GRANT EXECUTE ON FUNCTION public.room_is_accessible(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.send_room_message(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.edit_room_message(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_room_message(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.toggle_post_like(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_my_profile(text, text, text, text, text) TO authenticated;
