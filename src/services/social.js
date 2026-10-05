/**
 * MangaHive Phase 0.1 — Social application service (RPC-only mutations)
 */
(function (root) {
  'use strict';

  function getSb() {
    if (root.__mh_sb) return root.__mh_sb;
    if (root.sb) return root.sb;
    throw new Error('Supabase client not initialized');
  }

  async function ensureUid() {
    var sb = getSb();
    var res = await sb.auth.getSession();
    var uid = res && res.data && res.data.session && res.data.session.user
      ? res.data.session.user.id
      : null;
    if (!uid) throw { code: 'AUTHENTICATION_REQUIRED', message: 'Authentication required' };
    return uid;
  }

  async function rateLimit(operation) {
    var sb = getSb();
    try {
      var res = await sb.rpc('check_rate_limit', { p_operation: operation });
      if (res.error) return { allowed: false, code: 'RATE_LIMIT_UNAVAILABLE' };
      if (!res.data || typeof res.data !== 'object') return { allowed: false, code: 'RATE_LIMIT_UNAVAILABLE' };
      return res.data;
    } catch (e) {
      return { allowed: false, code: 'RATE_LIMIT_UNAVAILABLE' };
    }
  }

  async function requireRateLimit(operation) {
    var result = await rateLimit(operation);
    if (!result || result.allowed !== true) {
      var code = (result && result.code) || 'RATE_LIMIT_UNAVAILABLE';
      throw {
        code: code,
        message: code === 'RATE_LIMITED' ? 'Rate limit exceeded' : 'Please try again shortly.',
        details: result && result.retryAfterSeconds != null ? { retryAfterSeconds: result.retryAfterSeconds } : undefined,
      };
    }
  }

  async function rpc(name, args) {
    await ensureUid();
    var sb = getSb();
    var res = await sb.rpc(name, args || {});
    if (res.error) throw res.error;
    return res.data;
  }

  root.MangaHiveSocial = {
    sendFriendRequest: function (addresseeId) {
      return requireRateLimit('friend_request').then(function () {
        return rpc('send_friend_request', { p_addressee: addresseeId });
      });
    },
    acceptFriendRequest: function (requestId) {
      return rpc('accept_friend_request', { p_request_id: requestId });
    },
    rejectFriendRequest: function (requestId) {
      return rpc('decline_friend_request', { p_request_id: requestId });
    },
    cancelFriendRequest: function (requestId) {
      return rpc('cancel_friend_request', { p_request_id: requestId });
    },
    removeFriend: function (otherId) {
      return rpc('remove_friend', { p_other_user_id: otherId });
    },
    createConversation: function (participantIds, opts) {
      opts = opts || {};
      if (opts.isGroup) {
        return rpc('create_group_conversation', {
          group_name: opts.title || 'Group',
          member_ids: participantIds || [],
        });
      }
      var other = (participantIds || []).filter(Boolean)[0];
      return rpc('get_or_create_direct_conversation', { other_user_id: other });
    },
    sendMessage: function (conversationId, body, replyToId) {
      var args = { p_conversation_id: conversationId, p_body: body };
      if (replyToId) args.p_reply_to_message_id = replyToId;
      return rpc('send_message', args);
    },
    reactToMessage: function (messageId, emoji, kind, adding) {
      return rpc('toggle_message_reaction', {
        p_kind: kind === 'room' ? 'room' : 'dm',
        p_message_id: messageId,
        p_emoji: emoji || '',
        p_adding: adding !== false,
      });
    },
    submitReport: function (targetType, targetId, reason, details) {
      return rpc('submit_report', {
        p_target_type: targetType,
        p_target_id: String(targetId),
        p_reason: reason,
        p_details: details || null,
      });
    },
    blockUser: function (blockedId) {
      return rpc('block_user', { p_blocked: blockedId });
    },
    unblockUser: function (blockedId) {
      return rpc('unblock_user', { p_blocked_user_id: blockedId });
    },
    leaveConversation: function (conversationId) {
      return rpc('leave_conversation', { p_conversation_id: conversationId });
    },
    checkRateLimit: rateLimit,
  };
})(typeof window !== 'undefined' ? window : global);
