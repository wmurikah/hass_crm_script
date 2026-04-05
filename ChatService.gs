/**
 * HASS PETROLEUM CMS - CHAT SERVICE
 * Staff team collaboration chat — rooms and direct messages
 * Uses StaffMessages sheet
 */

function handleChatRequest(params) {
  try {
    var action = params.action;
    switch (action) {
      case 'getChatMessages':
        return getChatMessages(params.roomId, params.limit);
      case 'sendChatMessage':
        return sendChatMessage(params.roomId, params.roomType, params.senderId, params.senderName, params.content);
      case 'getNewChatMessages':
        return getNewChatMessages(params.roomId, params.since);
      case 'getStaffMembers':
        return getStaffMembers();
      default:
        return { success: false, error: 'Unknown chat action: ' + action };
    }
  } catch (e) {
    Logger.log('[ChatService] error: ' + e.message);
    return { success: false, error: 'Chat service error: ' + e.message };
  }
}

/**
 * Returns last N messages for a room, sorted ascending by timestamp
 */
function getChatMessages(roomId, limit) {
  if (!roomId) return { success: false, error: 'roomId required' };
  limit = limit || 50;

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('StaffMessages');

  // Create sheet if it doesn't exist
  if (!sheet) {
    sheet = ss.insertSheet('StaffMessages');
    sheet.appendRow(['message_id', 'room_id', 'room_type', 'sender_id', 'sender_name', 'content', 'created_at']);
  }

  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return { success: true, messages: [], checkedAt: new Date().toISOString() };

  var headers = data[0].map(function(h) { return String(h || '').toLowerCase().trim(); });
  var roomCol = headers.indexOf('room_id');
  var messages = [];

  for (var r = 1; r < data.length; r++) {
    if (String(data[r][roomCol] || '').trim() === roomId) {
      var msg = {};
      for (var c = 0; c < headers.length; c++) {
        msg[headers[c]] = data[r][c];
      }
      messages.push(msg);
    }
  }

  // Sort by created_at ascending
  messages.sort(function(a, b) {
    return new Date(a.created_at) - new Date(b.created_at);
  });

  // Return last N
  if (messages.length > limit) {
    messages = messages.slice(messages.length - limit);
  }

  return { success: true, messages: messages, checkedAt: new Date().toISOString() };
}

/**
 * Sends a chat message — appends to StaffMessages
 */
function sendChatMessage(roomId, roomType, senderId, senderName, content) {
  if (!roomId || !senderId || !content) {
    return { success: false, error: 'roomId, senderId, and content required' };
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('StaffMessages');

  if (!sheet) {
    sheet = ss.insertSheet('StaffMessages');
    sheet.appendRow(['message_id', 'room_id', 'room_type', 'sender_id', 'sender_name', 'content', 'created_at']);
  }

  var msgId = 'MSG' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 8).toUpperCase();
  var now = new Date().toISOString();

  sheet.appendRow([msgId, roomId, roomType || 'CHANNEL', senderId, senderName || '', content, now]);

  // Update sender's last_activity in Users sheet
  try {
    var usersSheet = ss.getSheetByName('Users');
    if (usersSheet) {
      var userData = usersSheet.getDataRange().getValues();
      var uHeaders = userData[0].map(function(h) { return String(h || '').toLowerCase().trim(); });
      var uidCol = uHeaders.indexOf('user_id');
      var updCol = uHeaders.indexOf('updated_at');
      for (var r = 1; r < userData.length; r++) {
        if (String(userData[r][uidCol] || '').trim() === senderId) {
          if (updCol > -1) usersSheet.getRange(r + 1, updCol + 1).setValue(now);
          break;
        }
      }
    }
  } catch (e) {
    Logger.log('[ChatService] activity update failed: ' + e.message);
  }

  return {
    success: true,
    message: {
      message_id: msgId,
      room_id: roomId,
      room_type: roomType || 'CHANNEL',
      sender_id: senderId,
      sender_name: senderName || '',
      content: content,
      created_at: now
    }
  };
}

/**
 * Returns messages after a given timestamp for polling
 */
function getNewChatMessages(roomId, since) {
  if (!roomId) return { success: false, error: 'roomId required' };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('StaffMessages');
  if (!sheet) return { success: true, messages: [], checkedAt: new Date().toISOString() };

  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return { success: true, messages: [], checkedAt: new Date().toISOString() };

  var headers = data[0].map(function(h) { return String(h || '').toLowerCase().trim(); });
  var roomCol = headers.indexOf('room_id');
  var timeCol = headers.indexOf('created_at');
  var sinceDate = since ? new Date(since) : new Date(0);
  var messages = [];

  for (var r = 1; r < data.length; r++) {
    if (String(data[r][roomCol] || '').trim() === roomId) {
      var msgTime = new Date(data[r][timeCol]);
      if (msgTime > sinceDate) {
        var msg = {};
        for (var c = 0; c < headers.length; c++) {
          msg[headers[c]] = data[r][c];
        }
        messages.push(msg);
      }
    }
  }

  messages.sort(function(a, b) {
    return new Date(a.created_at) - new Date(b.created_at);
  });

  return { success: true, messages: messages, checkedAt: new Date().toISOString() };
}

/**
 * Returns all active staff members with online status
 */
function getStaffMembers() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Users');
  if (!sheet) return { success: true, members: [] };

  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return { success: true, members: [] };

  var headers = data[0].map(function(h) { return String(h || '').toLowerCase().trim(); });
  var now = new Date();
  var fifteenMinAgo = new Date(now.getTime() - 15 * 60 * 1000);
  var members = [];

  for (var r = 1; r < data.length; r++) {
    var row = {};
    for (var c = 0; c < headers.length; c++) {
      row[headers[c]] = data[r][c];
    }

    if (row.status !== 'ACTIVE') continue;

    var lastActivity = row.updated_at ? new Date(row.updated_at) : new Date(0);
    members.push({
      user_id: row.user_id || '',
      name: (row.first_name || '') + ' ' + (row.last_name || ''),
      role: row.role || '',
      online: lastActivity > fifteenMinAgo
    });
  }

  return { success: true, members: members };
}
