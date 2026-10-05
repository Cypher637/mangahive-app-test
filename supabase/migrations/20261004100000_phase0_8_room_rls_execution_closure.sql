-- =============================================================================
-- Phase 0.8 — room_messages RLS execution closure
--
-- DEFECT (found by the Phase 0.7 verifier, RLS_POLICY_EXECUTE advisory)
--   room_messages SELECT policy "room_msg_select" (0.3) is
--       USING (public.room_is_accessible(room_id))
--   PostgreSQL checks EXECUTE on a function called from a policy expression against the
--   CALLER (role "authenticated"), not the function owner. SECURITY DEFINER only changes who
--   the function BODY runs as. Phase 0.5 correctly made room_is_accessible() an internal
--   helper (EXECUTE revoked from PUBLIC / anon / authenticated), so every authenticated
--   SELECT on room_messages (including Realtime postgres_changes, which evaluates the same
--   policy) would fail with "permission denied for function room_is_accessible".
--
-- WHY NOT "GRANT EXECUTE ... TO authenticated"
--   The function lives in schema public, which PostgREST exposes. Any EXECUTE grant to
--   authenticated makes it reachable as POST /rest/v1/rpc/room_is_accessible, i.e. through
--   supabase.rpc(). That would turn an internal helper into a client RPC and contradict the
--   contract (client_callable=false). A grant is therefore rejected.
--
-- FIX: inline the predicate; keep the helper non-callable
--   The policy no longer calls any function. The predicate is the same one the helper
--   evaluates (active AND public room) expressed as an EXISTS over public.rooms.
--   The subquery is evaluated as the caller, so it is additionally filtered by rooms_select
--   (TO authenticated USING status='active' AND visibility='public' — the identical
--   predicate), which can only restrict, never widen. Net authorization is unchanged:
--       before: rooms row exists AND status='active' AND visibility='public'   (definer bypass)
--       after : rooms row exists AND status='active' AND visibility='public'   (+ identical RLS)
--   The caller needs table-level SELECT on public.rooms for the subquery; it is granted
--   explicitly here rather than relying on Supabase default privileges. anon gets nothing.
--
-- UNCHANGED
--   room_is_accessible(text) stays SECURITY DEFINER + pinned search_path, EXECUTE revoked from
--   PUBLIC / anon / authenticated. The room RPCs (send/edit/delete_room_message) keep calling it;
--   they are SECURITY DEFINER and run as the function owner, who always holds EXECUTE.
--   No new function, no new RPC, no catalog RPC change, rooms write policies still deny.
-- Idempotent.
-- =============================================================================

-- 1. caller-context table privileges required by the inlined subquery
REVOKE ALL ON TABLE public.rooms FROM PUBLIC;
REVOKE ALL ON TABLE public.rooms FROM anon;
REVOKE ALL ON TABLE public.rooms FROM authenticated;
GRANT SELECT ON TABLE public.rooms TO authenticated;

-- 2. policy without any function call
DROP POLICY IF EXISTS room_msg_select ON public.room_messages;
CREATE POLICY room_msg_select ON public.room_messages FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.rooms r
      WHERE r.id = room_messages.room_id
        AND r.status = 'active'
        AND r.visibility = 'public'
    )
  );

-- 3. re-assert the helper's closed ACL (no-op if already closed; guards against drift)
REVOKE ALL ON FUNCTION public.room_is_accessible(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.room_is_accessible(text) FROM anon;
REVOKE ALL ON FUNCTION public.room_is_accessible(text) FROM authenticated;

COMMENT ON FUNCTION public.room_is_accessible IS
  'INTERNAL helper — not client-callable, not referenced by any RLS policy (room_msg_select inlines the same predicate since 0.8); used only by SECURITY DEFINER room RPCs';
COMMENT ON POLICY room_msg_select ON public.room_messages IS
  'Phase 0.8: inlined active+public room predicate; must stay equivalent to rooms_select and room_is_accessible()';
