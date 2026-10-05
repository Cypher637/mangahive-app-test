-- =============================================================================
-- Phase 0.7 — EXECUTE privilege closure (REVOKE-only; no behaviour change)
--
-- Found by the authoritative RPC verifier (tests/phase0/rpc_final_signature_test.js):
--
-- 1. anon still holds EXECUTE on every authenticated-only RPC.
--    Supabase installs default privileges in schema public that GRANT EXECUTE on new
--    functions to anon, authenticated and service_role. "REVOKE ... FROM PUBLIC" (0.4/0.5)
--    does not remove those explicit role grants, so contract default_policy
--    "anon: NO EXECUTE" was not actually enforced. is_name_available() has no body-level
--    auth guard (auth_enforcement = acl_only), so for it the ACL is the only gate.
--
-- 2. The RLS predicates is_conversation_participant / can_view_profile /
--    can_manage_participants kept the PostgreSQL default PUBLIC EXECUTE. Every policy that
--    calls them is TO authenticated, so only authenticated needs EXECUTE.
--
-- Not changed (documented exception): app_schema_version() stays PUBLIC/anon/authenticated.
-- Not changed: internal helpers (require_rate_limit, room_is_accessible) stay revoked.
-- Idempotent: REVOKE on a role without the grant is a no-op.
-- =============================================================================

-- 1. authenticated-only RPCs: remove anon
REVOKE ALL ON FUNCTION public.send_message(uuid, text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.delete_message(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.create_post(text, text, text, text, text, text, text, boolean) FROM anon;
REVOKE ALL ON FUNCTION public.add_post_comment(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.toggle_post_like(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.submit_report(text, text, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.send_friend_request(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.accept_friend_request(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.decline_friend_request(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.cancel_friend_request(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.remove_friend(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.block_user(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.toggle_follow(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.toggle_message_reaction(text, uuid, text, boolean) FROM anon;
REVOKE ALL ON FUNCTION public.get_or_create_direct_conversation(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.create_group_conversation(text, uuid[]) FROM anon;
REVOKE ALL ON FUNCTION public.add_group_member(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.leave_conversation(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_public_profile(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.sync_chapter_comment(text, text, text, text, boolean) FROM anon;
REVOKE ALL ON FUNCTION public.check_rate_limit(text) FROM anon;
REVOKE ALL ON FUNCTION public.delete_post(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.update_post(uuid, text, boolean, text) FROM anon;
REVOKE ALL ON FUNCTION public.unblock_user(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.update_my_profile(jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.send_room_message(text, text) FROM anon;
REVOKE ALL ON FUNCTION public.delete_room_message(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.edit_message(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.edit_room_message(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.rename_group(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.mark_notifications_read(uuid[]) FROM anon;
REVOKE ALL ON FUNCTION public.delete_declined_message_request(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.accept_message_request(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.decline_message_request(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_my_profile() FROM anon;
REVOKE ALL ON FUNCTION public.search_profiles(text) FROM anon;
REVOKE ALL ON FUNCTION public.is_name_available(text, boolean) FROM anon;
REVOKE ALL ON FUNCTION public.conversation_last_messages(uuid[]) FROM anon;

-- 2. RLS predicates: authenticated only
REVOKE ALL ON FUNCTION public.is_conversation_participant(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_conversation_participant(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.is_conversation_participant(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.can_view_profile(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_view_profile(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.can_view_profile(uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.can_manage_participants(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_manage_participants(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.can_manage_participants(uuid) TO authenticated;
