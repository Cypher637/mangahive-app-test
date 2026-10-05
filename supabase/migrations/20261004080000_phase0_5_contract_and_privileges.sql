-- Phase 0.5 — create_post signature fix, profile JSON patch, internal helper privileges
SET search_path = public;

-- =============================================================================
-- 1. create_post: series_id is text (schema), canonical argument order
-- Drop incorrect uuid overload if present
-- =============================================================================
DROP FUNCTION IF EXISTS public.create_post(text, text, boolean, uuid, text, text, text, text);
DROP FUNCTION IF EXISTS public.create_post(text, text, text, text, text, text, text, boolean);

CREATE OR REPLACE FUNCTION public.create_post(
  p_body text DEFAULT NULL,
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
  v_body text := NULLIF(trim(coalesce(p_body, '')), '');
  v_image text := NULLIF(trim(coalesce(p_image_url, '')), '');
  v_cover text := NULLIF(trim(coalesce(p_cover_url, '')), '');
  v_title text := NULLIF(trim(coalesce(p_series_title, '')), '');
  v_source text := NULLIF(trim(coalesce(p_source, '')), '');
  v_remote text := NULLIF(trim(coalesce(p_remote_id, '')), '');
  v_series text := NULLIF(trim(coalesce(p_series_id, '')), '');
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
  IF v_series IS NOT NULL AND length(v_series) > 128 THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
  PERFORM public.require_rate_limit('post_create');
  INSERT INTO public.posts (
    user_id, body, image_url, series_id, series_title, source, remote_id, cover_url, spoiler
  ) VALUES (
    v_uid, v_body, v_image, v_series, v_title, v_source, v_remote, v_cover, coalesce(p_spoiler, false)
  )
  RETURNING * INTO v_row;
  RETURN to_jsonb(v_row);
END;
$$;

REVOKE ALL ON FUNCTION public.create_post(text, text, text, text, text, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_post(text, text, text, text, text, text, text, boolean) TO authenticated;

-- =============================================================================
-- 2. update_my_profile: explicit JSON patch semantics
-- missing key = preserve; null = clear; value = set; unknown key = reject
-- =============================================================================
DROP FUNCTION IF EXISTS public.update_my_profile(text, text, text, text, text);

CREATE OR REPLACE FUNCTION public.update_my_profile(p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.profiles;
  v_key text;
  v_username text;
  v_name text;
  v_bio text;
  v_avatar text;
  v_privacy text;
  v_allowed text[] := ARRAY['username','name','bio','avatar_url','privacy'];
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED'; END IF;
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'INVALID_INPUT';
  END IF;

  -- reject unknown keys
  FOR v_key IN SELECT jsonb_object_keys(p_patch)
  LOOP
    IF NOT (v_key = ANY (v_allowed)) THEN
      RAISE EXCEPTION 'INVALID_INPUT';
    END IF;
  END LOOP;

  -- ensure row exists
  INSERT INTO public.profiles (id) VALUES (v_uid)
  ON CONFLICT (id) DO NOTHING;

  SELECT * INTO v_row FROM public.profiles WHERE id = v_uid;

  IF p_patch ? 'username' THEN
    IF p_patch->'username' = 'null'::jsonb THEN
      v_row.username := NULL;
    ELSE
      v_username := trim(p_patch->>'username');
      IF v_username = '' THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF; -- empty string invalid (use null to clear)
      IF length(v_username) < 3 OR length(v_username) > 32 THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
      IF v_username !~ '^[A-Za-z][A-Za-z0-9_]*$' THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
      v_row.username := v_username;
    END IF;
  END IF;

  IF p_patch ? 'name' THEN
    IF p_patch->'name' = 'null'::jsonb THEN
      v_row.name := NULL;
    ELSE
      v_name := trim(p_patch->>'name');
      IF v_name = '' THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
      IF length(v_name) > 64 THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
      v_row.name := v_name;
    END IF;
  END IF;

  IF p_patch ? 'bio' THEN
    IF p_patch->'bio' = 'null'::jsonb THEN
      v_row.bio := NULL;
    ELSE
      v_bio := trim(p_patch->>'bio');
      IF length(v_bio) > 500 THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
      v_row.bio := v_bio; -- empty string after trim allowed as short bio
    END IF;
  END IF;

  IF p_patch ? 'avatar_url' THEN
    IF p_patch->'avatar_url' = 'null'::jsonb THEN
      v_row.avatar_url := NULL;
    ELSE
      v_avatar := trim(p_patch->>'avatar_url');
      IF v_avatar = '' THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
      IF length(v_avatar) > 2048 OR v_avatar !~ '^https://' THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
      v_row.avatar_url := v_avatar;
    END IF;
  END IF;

  IF p_patch ? 'privacy' THEN
    IF p_patch->'privacy' = 'null'::jsonb THEN
      RAISE EXCEPTION 'INVALID_INPUT'; -- privacy cannot be cleared to null
    END IF;
    v_privacy := p_patch->>'privacy';
    IF v_privacy NOT IN ('public','friends','private','hidden','followers') THEN
      RAISE EXCEPTION 'INVALID_INPUT';
    END IF;
    v_row.privacy := v_privacy;
  END IF;

  UPDATE public.profiles SET
    username = v_row.username,
    name = v_row.name,
    bio = v_row.bio,
    avatar_url = v_row.avatar_url,
    privacy = coalesce(v_row.privacy, 'public'),
    updated_at = now()
  WHERE id = v_uid
  RETURNING * INTO v_row;

  RETURN to_jsonb(v_row);
END;
$$;

REVOKE ALL ON FUNCTION public.update_my_profile(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_my_profile(jsonb) TO authenticated;

-- Username uniqueness (idempotent)
CREATE UNIQUE INDEX IF NOT EXISTS profiles_username_lower_uidx
  ON public.profiles (lower(username))
  WHERE username IS NOT NULL;

-- =============================================================================
-- 3. Internal helpers: NOT client-callable
-- =============================================================================
REVOKE ALL ON FUNCTION public.require_rate_limit(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.require_rate_limit(text) FROM anon;
REVOKE ALL ON FUNCTION public.require_rate_limit(text) FROM authenticated;

REVOKE ALL ON FUNCTION public.room_is_accessible(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.room_is_accessible(text) FROM anon;
REVOKE ALL ON FUNCTION public.room_is_accessible(text) FROM authenticated;

-- check_rate_limit remains client-callable for UX preflight
REVOKE ALL ON FUNCTION public.check_rate_limit(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_rate_limit(text) TO authenticated;

-- app_schema_version is intentionally public/read-only
CREATE OR REPLACE FUNCTION public.app_schema_version()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT 'phase0.5';
$$;
GRANT EXECUTE ON FUNCTION public.app_schema_version() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_schema_version() TO anon;
GRANT EXECUTE ON FUNCTION public.app_schema_version() TO authenticated;

COMMENT ON FUNCTION public.create_post IS 'Canonical: (text,text,text,text,text,text,text,boolean) — series_id is text';
COMMENT ON FUNCTION public.update_my_profile IS 'JSON patch: missing=preserve, null=clear, value=set; unknown keys rejected';
COMMENT ON FUNCTION public.require_rate_limit IS 'INTERNAL helper — not client-callable';
COMMENT ON FUNCTION public.room_is_accessible IS 'INTERNAL helper — not client-callable';
COMMENT ON FUNCTION public.app_schema_version IS 'Public read-only schema version marker';
