/**
 * HASS PETROLEUM CMS - CHAT SERVICE
 * Version: 3.0.0
 *
 * Staff team collaboration chat - rooms and direct messages.
 * All reads/writes go to Turso via DatabaseSetup helpers.
 * Uses StaffMessages table in Turso.
 */

function handleChatRequest(params) {
  try {
    var action = params.action;
    switch (action) {
      case 'getChatMessages':    return getChatMessages(params.roomId, params.limit);
      case 'sendChatMessage':    return sendChatMessage(params.roomId, params.roomType, params.senderId, params.senderName, params.content);
      case 'getNewChatMessages': return getNewChatMessages(params.roomId, params.since);
      case 'getStaffMembers':    return getStaffMembers();
      default:
        return { success: false, error: 'Unknown chat action: ' + action };
    }
  } catch(e) {
    Logger.log('[ChatService] error: ' + e.message);
    return { success: false, error: 'Chat service error: ' + e.message };
  }
}

/**
 * Returns last N messages for a room, sorted ascending by timestamp.
 */
function getChatMessages(roomId, limit) {
  if (!roomId) return { success: false, error: 'roomId required' };
  limit = parseInt(limit) || 50;

  try {
    var table = TABLE_MAP['StaffMessages'] || 'staff_messages';
    var rows  = tursoSelect(
      'SELECT * FROM ' + table +
      ' WHERE room_id = ? ORDER BY created_at ASC LIMIT ?',
      [roomId, limit]
    );
    return { success: true, messages: rows, checkedAt: new Date().toISOString() };
  } catch(e) {
    Logger.log('[ChatService] getChatMessages error: ' + e.message);
    return { success: false, error: e.message };
  }
}

/**
 * Sends a chat message - inserts into StaffMessages via Turso.
 */
function sendChatMessage(roomId, roomType, senderId, senderName, content) {
  if (!roomId || !senderId || !content) {
    return { success: false, error: 'roomId, senderId, and content required' };
  }

  var msgId = 'MSG' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 8).toUpperCase();
  var now   = new Date().toISOString();

  var msg = {
    message_id:  msgId,
    room_id:     roomId,
    room_type:   roomType || 'CHANNEL',
    sender_id:   senderId,
    sender_name: senderName || '',
    content:     content,
    created_at:  now,
  };

  appendRow('StaffMessages', msg);

  // Update sender's last activity
  try {
    updateRow('Users', 'user_id', senderId, { updated_at: now });
  } catch(e) {
    Logger.log('[ChatService] activity update failed: ' + e.message);
  }

  return { success: true, message: msg };
}

/**
 * Returns messages after a given timestamp for polling.
 */
function getNewChatMessages(roomId, since) {
  if (!roomId) return { success: false, error: 'roomId required' };

  try {
    var table    = TABLE_MAP['StaffMessages'] || 'staff_messages';
    var sinceVal = since || new Date(0).toISOString();
    var rows     = tursoSelect(
      'SELECT * FROM ' + table +
      ' WHERE room_id = ? AND created_at > ? ORDER BY created_at ASC',
      [roomId, sinceVal]
    );
    return { success: true, messages: rows, checkedAt: new Date().toISOString() };
  } catch(e) {
    Logger.log('[ChatService] getNewChatMessages error: ' + e.message);
    return { success: false, error: e.message };
  }
}

/**
 * Returns all active staff members with online status.
 */
function getStaffMembers() {
  try {
    var now          = new Date();
    var fifteenMinAgo = new Date(now.getTime() - 15 * 60 * 1000).toISOString();
    var users        = getSheetData('Users');
    var members      = [];

    users.forEach(function(row) {
      if (row.status !== 'ACTIVE') return;
      var lastActivity = row.updated_at ? new Date(row.updated_at) : new Date(0);
      members.push({
        user_id: row.user_id || '',
        name:    (row.first_name || '') + ' ' + (row.last_name || ''),
        role:    row.role || '',
        online:  lastActivity > new Date(fifteenMinAgo),
      });
    });

    return { success: true, members: members };
  } catch(e) {
    Logger.log('[ChatService] getStaffMembers error: ' + e.message);
    return { success: false, error: e.message };
  }
}
