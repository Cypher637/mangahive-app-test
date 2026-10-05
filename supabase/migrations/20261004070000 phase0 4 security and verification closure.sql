-- Phase 0.4 — Final security + verification closure
-- follows RPC-only, REVOKE PUBLIC on all app RPCs, username uniqueness,
-- notifications write boundary, post validation, overload cleanup
SET search_path = public;

-- =============================================================================
-- 1. FOLLOWS: remove direct write bypass
-- =============================================================================
DROP POLICY IF EXISTS follows_insert_own ON public.follows;
DROP POLICY IF EXISTS follows_delete_own ON public.follows;
DROP POLICY IF EXISTS follows_insert ON public.follows;
DROP POLICY IF EXISTS follows_delete ON public.follows;
CREATE POLICY follows_insert_deny ON public.follows
  FOR INSERT TO authenticated WITH CHECK (false);
CREATE POLICY follows_delete_deny ON public.follows
  FOR DELETE TO authenticated USING (false);
-- SELECT policy retained from earlier migrations

-- Ensure toggle_follow is rate-limited and SECURITY DEFINER
CREATE OR REPLACE FUNCTION public.toggle_follow(p_target uuid)
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
  IF p_target IS NULL OR p_target = v_uid THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  PERFORM public.require_rate_limit('follow');
  SELECT EXISTS(
    SELECT 1 FROM public.follows WHERE follower_id = v_uid AND following_id = p_target
  ) INTO v_exists;
  IF v_exists THEN
    DELETE FROM public.follows WHERE follower_id = v_uid AND following_id = p_target;
    RETURN jsonb_build_object('following', false);
  ELSE
    INSERT INTO public.follows (follower_id, following_id) VALUES (v_uid, p_target);
    RETURN jsonb_build_object('following', true);
  END IF;
END;
$$;

-- =============================================================================
-- 2. NOTIFICATIONS: RPC-only writes
-- =============================================================================
DROP POLICY IF EXISTS notifications_update ON public.notifications;
DROP POLICY IF EXISTS notif_update ON public.notifications;
DROP POLICY IF EXISTS notifications_update_own ON public.notifications;
DROP POLICY IF EXISTS notif_insert_deny ON public.notifications;
DROP POLICY IF EXISTS notif_update_deny ON public.notifications;
DROP POLICY IF EXISTS notif_delete_deny ON public.notifications;
CREATE POLICY notif_insert_deny ON public.notifications
  FOR INSERT TO authenticated WITH CHECK (false);
CREATE POLICY notif_update_deny ON public.notifications
  FOR UPDATE TO authenticated USING (false);
CREATE POLICY notif_delete_deny ON public.notifications
  FOR DELETE TO authenticated USING (false);

CREATE OR REPLACE FUNCTION public.mark_notifications_read(p_ids uuid[] DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_count int;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED'; END IF;
  IF p_ids IS NULL THEN
    UPDATE public.notifications SET read_at = now()
    WHERE user_id = v_uid AND read_at IS NULL;
  ELSE
    UPDATE public.notifications SET read_at = now()
    WHERE user_id = v_uid AND id = ANY(p_ids) AND read_at IS NULL;
  END IF;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN jsonb_build_object('updated', v_count);
END;
$$;

-- =============================================================================
-- 3. USERNAME uniqueness (case-insensitive)
-- =============================================================================
CREATE UNIQUE INDEX IF NOT EXISTS profiles_username_lower_uidx
  ON public.profiles (lower(username))
  WHERE username IS NOT NULL;

-- =============================================================================
-- 4. create_post / update_post hardened validation
-- =============================================================================
CREATE OR REPLACE FUNCTION public.create_post(
  p_body text DEFAULT NULL,
  p_image_url text DEFAULT NULL,
  p_spoiler boolean DEFAULT false,
  p_series_id uuid DEFAULT NULL,
  p_series_title text DEFAULT NULL,
  p_source text DEFAULT NULL,
  p_remote_id text DEFAULT NULL,
  p_cover_url text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_body text := NULLIF(trim(coalesce(p_body, '')), '');
  v_image text := NULLIF(trim(coalesce(p_image_url, '')), '');
  v_cover text := NULLIF(trim(coalesce(p_cover_url, '')), '');
  v_title text := NULLIF(trim(coalesce(p_series_title, '')), '');
  v_source text := NULLIF(trim(coalesce(p_source, '')), '');
  v_remote text := NULLIF(trim(coalesce(p_remote_id, '')), '');
  v_row public.posts;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED'; END IF;
  IF v_body IS NULL AND v_image IS NULL THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  IF v_body IS NOT NULL AND length(v_body) > 8000 THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  IF v_image IS NOT NULL THEN
    IF length(v_image) > 2048 OR v_image !~ '^https://' THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  END IF;
  IF v_cover IS NOT NULL THEN
    IF length(v_cover) > 2048 OR v_cover !~ '^https://' THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  END IF;
  IF v_title IS NOT NULL AND length(v_title) > 200 THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  IF v_source IS NOT NULL AND length(v_source) > 64 THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  IF v_remote IS NOT NULL AND length(v_remote) > 128 THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  PERFORM public.require_rate_limit('post_create');
  INSERT INTO public.posts (user_id, body, image_url, spoiler, series_id, series_title, source, remote_id, cover_url)
  VALUES (v_uid, v_body, v_image, coalesce(p_spoiler, false), p_series_id, v_title, v_source, v_remote, v_cover)
  RETURNING * INTO v_row;
  RETURN to_jsonb(v_row);
EXCEPTION
  WHEN undefined_column THEN
    INSERT INTO public.posts (user_id, body, image_url, spoiler)
    VALUES (v_uid, v_body, v_image, coalesce(p_spoiler, false))
    RETURNING * INTO v_row;
    RETURN to_jsonb(v_row);
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
  v_body text;
  v_image text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED'; END IF;
  SELECT * INTO v_row FROM public.posts WHERE id = p_post_id;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF v_row.user_id IS DISTINCT FROM v_uid THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF p_body IS NOT NULL THEN
    v_body := trim(p_body);
    IF length(v_body) > 8000 THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
    v_row.body := v_body;
  END IF;
  IF p_spoiler IS NOT NULL THEN v_row.spoiler := p_spoiler; END IF;
  IF p_image_url IS NOT NULL THEN
    v_image := NULLIF(trim(p_image_url), '');
    IF v_image IS NOT NULL AND (length(v_image) > 2048 OR v_image !~ '^https://') THEN
      RAISE EXCEPTION 'INVALID_INPUT';
    END IF;
    v_row.image_url := v_image;
  END IF;
  UPDATE public.posts SET body = v_row.body, spoiler = v_row.spoiler, image_url = v_row.image_url
  WHERE id = p_post_id AND user_id = v_uid
  RETURNING * INTO v_row;
  RETURN to_jsonb(v_row);
END;
$$;

-- =============================================================================
-- 5. Drop obsolete overloads (exact signatures)
-- =============================================================================
DROP FUNCTION IF EXISTS public.toggle_message_reaction(uuid, text);
DROP FUNCTION IF EXISTS public.get_public_profile(uuid);
DROP FUNCTION IF EXISTS public.block_user(uuid); -- keep only block_user(p_blocked uuid) if ambiguous
-- Recreate single canonical block_user after potential drop
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
  RETURN jsonb_build_object('blocked', true);
END;
$$;

DROP FUNCTION IF EXISTS public.block_user_by_target(uuid);
DROP FUNCTION IF EXISTS public.sync_chapter_comment(text, text, text, boolean);

-- =============================================================================
-- 6. REVOKE PUBLIC + GRANT authenticated on ALL application RPCs
-- =============================================================================
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'toggle_follow','toggle_post_like','toggle_message_reaction',
        'send_message','edit_message','delete_message',
        'send_room_message','edit_room_message','delete_room_message',
        'create_post','update_post','delete_post','add_post_comment',
        'submit_report','send_friend_request','accept_friend_request',
        'decline_friend_request','cancel_friend_request','remove_friend',
        'block_user','unblock_user','update_my_profile',
        'leave_conversation','add_group_member','rename_group',
        'create_group_conversation','get_or_create_direct_conversation',
        'mark_notifications_read','accept_message_request','decline_message_request',
        'delete_declined_message_request','sync_chapter_comment',
        'check_rate_limit','require_rate_limit','get_public_profile',
        'get_my_profile','search_profiles','is_name_available',
        'conversation_last_messages','room_is_accessible'
      )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', r.sig);
  END LOOP;
END $$;

-- Explicit grants for fixed signatures (works even if DO loop misses)
REVOKE ALL ON FUNCTION public.toggle_follow(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.toggle_follow(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.mark_notifications_read(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_notifications_read(uuid[]) TO authenticated;
REVOKE ALL ON FUNCTION public.create_post(text, text, boolean, uuid, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_post(text, text, boolean, uuid, text, text, text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.update_post(uuid, text, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_post(uuid, text, boolean, text) TO authenticated;
REVOKE ALL ON FUNCTION public.block_user(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.block_user(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.edit_message(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.edit_message(uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.edit_room_message(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.edit_room_message(uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.delete_message(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_message(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.delete_post(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_post(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.send_room_message(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.send_room_message(text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.delete_room_message(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_room_message(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.update_my_profile(text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_my_profile(text, text, text, text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.submit_report(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_report(text, text, text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.add_post_comment(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_post_comment(uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.toggle_post_like(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.toggle_post_like(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.unblock_user(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.unblock_user(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.leave_conversation(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.leave_conversation(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.send_friend_request(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.send_friend_request(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.accept_friend_request(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.accept_friend_request(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.decline_friend_request(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.decline_friend_request(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.cancel_friend_request(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_friend_request(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.remove_friend(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remove_friend(uuid) TO authenticated;

COMMENT ON FUNCTION public.toggle_follow IS 'Authoritative follow toggle; direct follows INSERT/DELETE denied';
COMMENT ON FUNCTION public.edit_message IS 'Rate limit shares send_message bucket intentionally (create+edit abuse control)';
COMMENT ON FUNCTION public.edit_room_message IS 'Rate limit shares send_message bucket intentionally';
