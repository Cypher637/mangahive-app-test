-- Phase 0.2 — edit_message / edit_room_message + drop obsolete overloads
SET search_path = public;

CREATE OR REPLACE FUNCTION public.edit_message(p_message_id uuid, p_body text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_body text := trim(coalesce(p_body, ''));
  v_row public.messages;
  v_owner uuid;
  v_conv uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED'; END IF;
  IF p_message_id IS NULL OR length(v_body) = 0 THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  IF length(v_body) > 8000 THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  SELECT user_id, conversation_id INTO v_owner, v_conv FROM public.messages WHERE id = p_message_id;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF v_owner IS DISTINCT FROM v_uid THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF NOT public.is_conversation_participant(v_conv) THEN RAISE EXCEPTION 'NOT_MEMBER'; END IF;
  PERFORM public.require_rate_limit('send_message'); -- shared with send to curb edit spam
  UPDATE public.messages SET body = v_body WHERE id = p_message_id AND user_id = v_uid
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
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED'; END IF;
  IF p_message_id IS NULL OR length(v_body) = 0 THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  IF length(v_body) > 8000 THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  SELECT user_id INTO v_owner FROM public.room_messages WHERE id = p_message_id;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  IF v_owner IS DISTINCT FROM v_uid THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  -- Room model: intentionally public among authenticated users (product decision Phase 0)
  PERFORM public.require_rate_limit('send_message');
  UPDATE public.room_messages SET body = v_body WHERE id = p_message_id AND user_id = v_uid
  RETURNING * INTO v_row;
  RETURN to_jsonb(v_row);
END;
$$;

-- Drop obsolete overloads where safe (old signatures from earlier migrations)
DROP FUNCTION IF EXISTS public.toggle_message_reaction(uuid, text);
DROP FUNCTION IF EXISTS public.block_user_by_target(uuid);
DROP FUNCTION IF EXISTS public.get_public_profile(uuid);
DROP FUNCTION IF EXISTS public.sync_chapter_comment(text, text, text, boolean);
DROP FUNCTION IF EXISTS public.check_rate_limit(text, int, int, int);

GRANT EXECUTE ON FUNCTION public.edit_message(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.edit_room_message(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.edit_message IS 'Author-only message edit; rate limited via send_message policy';
COMMENT ON FUNCTION public.edit_room_message IS 'Author-only room message edit; rooms are public among authenticated users';
