-- MangaHive Phase 0 — RLS policies
-- Principle: identity always from auth.uid(). Never trust client-supplied user_id for authorization.
-- No unrestricted USING (true) on private tables.

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.follows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.friend_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chapter_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;

-- ---------- profiles ----------
DROP POLICY IF EXISTS profiles_select ON public.profiles;
CREATE POLICY profiles_select ON public.profiles
  FOR SELECT TO authenticated
  USING (
    id = auth.uid()
    OR privacy = 'public'
    -- friends/followers visibility can be refined when privacy UI lands
  );

DROP POLICY IF EXISTS profiles_update_own ON public.profiles;
CREATE POLICY profiles_update_own ON public.profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

DROP POLICY IF EXISTS profiles_insert_own ON public.profiles;
CREATE POLICY profiles_insert_own ON public.profiles
  FOR INSERT TO authenticated
  WITH CHECK (id = auth.uid());

-- ---------- follows ----------
DROP POLICY IF EXISTS follows_select ON public.follows;
CREATE POLICY follows_select ON public.follows
  FOR SELECT TO authenticated
  USING (follower_id = auth.uid() OR following_id = auth.uid());

DROP POLICY IF EXISTS follows_insert_own ON public.follows;
CREATE POLICY follows_insert_own ON public.follows
  FOR INSERT TO authenticated
  WITH CHECK (follower_id = auth.uid());

DROP POLICY IF EXISTS follows_delete_own ON public.follows;
CREATE POLICY follows_delete_own ON public.follows
  FOR DELETE TO authenticated
  USING (follower_id = auth.uid());

-- ---------- friend_requests ----------
DROP POLICY IF EXISTS fr_select ON public.friend_requests;
CREATE POLICY fr_select ON public.friend_requests
  FOR SELECT TO authenticated
  USING (requester_id = auth.uid() OR addressee_id = auth.uid());

DROP POLICY IF EXISTS fr_insert ON public.friend_requests;
CREATE POLICY fr_insert ON public.friend_requests
  FOR INSERT TO authenticated
  WITH CHECK (requester_id = auth.uid());

DROP POLICY IF EXISTS fr_update ON public.friend_requests;
CREATE POLICY fr_update ON public.friend_requests
  FOR UPDATE TO authenticated
  USING (requester_id = auth.uid() OR addressee_id = auth.uid())
  WITH CHECK (requester_id = auth.uid() OR addressee_id = auth.uid());

DROP POLICY IF EXISTS fr_delete ON public.friend_requests;
CREATE POLICY fr_delete ON public.friend_requests
  FOR DELETE TO authenticated
  USING (requester_id = auth.uid() OR addressee_id = auth.uid());

-- ---------- blocks ----------
DROP POLICY IF EXISTS blocks_select ON public.blocks;
CREATE POLICY blocks_select ON public.blocks
  FOR SELECT TO authenticated
  USING (blocker_id = auth.uid());

DROP POLICY IF EXISTS blocks_insert ON public.blocks;
CREATE POLICY blocks_insert ON public.blocks
  FOR INSERT TO authenticated
  WITH CHECK (blocker_id = auth.uid());

DROP POLICY IF EXISTS blocks_delete ON public.blocks;
CREATE POLICY blocks_delete ON public.blocks
  FOR DELETE TO authenticated
  USING (blocker_id = auth.uid());

-- ---------- posts ----------
DROP POLICY IF EXISTS posts_select ON public.posts;
CREATE POLICY posts_select ON public.posts
  FOR SELECT TO authenticated
  USING (true);  -- feed is intentionally public among authenticated users; refine with privacy later

DROP POLICY IF EXISTS posts_insert ON public.posts;
CREATE POLICY posts_insert ON public.posts
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS posts_update ON public.posts;
CREATE POLICY posts_update ON public.posts
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS posts_delete ON public.posts;
CREATE POLICY posts_delete ON public.posts
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- ---------- post_likes ----------
DROP POLICY IF EXISTS pl_select ON public.post_likes;
CREATE POLICY pl_select ON public.post_likes FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS pl_insert ON public.post_likes;
CREATE POLICY pl_insert ON public.post_likes
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS pl_delete ON public.post_likes;
CREATE POLICY pl_delete ON public.post_likes
  FOR DELETE TO authenticated USING (user_id = auth.uid());

-- ---------- post_comments ----------
DROP POLICY IF EXISTS pc_select ON public.post_comments;
CREATE POLICY pc_select ON public.post_comments FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS pc_insert ON public.post_comments;
CREATE POLICY pc_insert ON public.post_comments
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS pc_delete ON public.post_comments;
CREATE POLICY pc_delete ON public.post_comments
  FOR DELETE TO authenticated USING (user_id = auth.uid());

-- ---------- chapter_comments ----------
DROP POLICY IF EXISTS cc_select ON public.chapter_comments;
CREATE POLICY cc_select ON public.chapter_comments FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS cc_insert ON public.chapter_comments;
CREATE POLICY cc_insert ON public.chapter_comments
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS cc_delete ON public.chapter_comments;
CREATE POLICY cc_delete ON public.chapter_comments
  FOR DELETE TO authenticated USING (user_id = auth.uid());

-- ---------- conversations / participants / messages ----------
DROP POLICY IF EXISTS conv_select ON public.conversations;
CREATE POLICY conv_select ON public.conversations
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.conversation_participants cp
      WHERE cp.conversation_id = id AND cp.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS cp_select ON public.conversation_participants;
CREATE POLICY cp_select ON public.conversation_participants
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.conversation_participants me
      WHERE me.conversation_id = conversation_id AND me.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS cp_insert ON public.conversation_participants;
CREATE POLICY cp_insert ON public.conversation_participants
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS cp_delete ON public.conversation_participants;
CREATE POLICY cp_delete ON public.conversation_participants
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS msg_select ON public.messages;
CREATE POLICY msg_select ON public.messages
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.conversation_participants cp
      WHERE cp.conversation_id = conversation_id AND cp.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS msg_insert ON public.messages;
CREATE POLICY msg_insert ON public.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.conversation_participants cp
      WHERE cp.conversation_id = conversation_id AND cp.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS mr_select ON public.message_reactions;
CREATE POLICY mr_select ON public.message_reactions
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.messages m
      JOIN public.conversation_participants cp ON cp.conversation_id = m.conversation_id
      WHERE m.id = message_id AND cp.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS mr_insert ON public.message_reactions;
CREATE POLICY mr_insert ON public.message_reactions
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS mr_delete ON public.message_reactions;
CREATE POLICY mr_delete ON public.message_reactions
  FOR DELETE TO authenticated USING (user_id = auth.uid());

-- ---------- notifications ----------
DROP POLICY IF EXISTS notif_select ON public.notifications;
CREATE POLICY notif_select ON public.notifications
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS notif_update ON public.notifications;
CREATE POLICY notif_update ON public.notifications
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ---------- reports ----------
DROP POLICY IF EXISTS reports_insert ON public.reports;
CREATE POLICY reports_insert ON public.reports
  FOR INSERT TO authenticated WITH CHECK (reporter_id = auth.uid());

DROP POLICY IF EXISTS reports_select_own ON public.reports;
CREATE POLICY reports_select_own ON public.reports
  FOR SELECT TO authenticated
  USING (reporter_id = auth.uid());
-- Moderators resolving reports require a separate elevated policy (not granted to normal users).
