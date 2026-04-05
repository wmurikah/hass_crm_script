/**
 * HASS PETROLEUM CMS - NOTIFICATION SERVICE
 * Version: 2.0.0
 * Email: Microsoft Graph API (hassaudit@outlook.com) with MailApp fallback
 * 
 * Handles:
 * - Multi-channel notifications (Email, SMS, WhatsApp, Push, In-App)
 * - Notification templates
 * - User preferences and opt-out
 * - Batch notifications
 * - Notification history and tracking
 * - Scheduled notifications
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

const NOTIFICATION_CONFIG = {
  DEFAULT_SENDER_EMAIL: 'noreply@hasspetroleum.com',
  DEFAULT_SENDER_NAME: 'Hass Petroleum',
  SMS_API_URL: '', // Set via Script Properties
  WHATSAPP_API_URL: '', // Set via Script Properties
  BATCH_SIZE: 50,
  RETRY_ATTEMPTS: 3,
  NOTIFICATION_EXPIRY_DAYS: 30,
};

/**
 * Gets notification API configuration from Script Properties.
 */
function getNotificationConfig() {
  const props = PropertiesService.getScriptProperties();
  return {
    smsApiKey: props.getProperty('SMS_API_KEY') || '',
    smsApiUrl: props.getProperty('SMS_API_URL') || '',
    smsSenderId: props.getProperty('SMS_SENDER_ID') || 'HASSPETRO',
    whatsappApiKey: props.getProperty('WHATSAPP_API_KEY') || '',
    whatsappApiUrl: props.getProperty('WHATSAPP_API_URL') || '',
    whatsappPhoneId: props.getProperty('WHATSAPP_PHONE_ID') || '',
    pushApiKey: props.getProperty('PUSH_API_KEY') || '',
  };
}

// ============================================================================
// NOTIFICATION CREATION
// ============================================================================

/**
 * Creates and sends a notification.
 * @param {Object} notificationData - Notification data
 * @returns {Object} Result
 */
function createNotification(notificationData) {
  try {
    // Validate required fields
    if (!notificationData.recipient_type || !notificationData.recipient_id) {
      return { success: false, error: 'Recipient is required' };
    }
    
    if (!notificationData.notification_type) {
      return { success: false, error: 'Notification type is required' };
    }
    
    // Get recipient info and preferences
    const recipientInfo = getRecipientInfo(notificationData.recipient_type, notificationData.recipient_id);
    if (!recipientInfo) {
      return { success: false, error: 'Recipient not found' };
    }
    
    // Check preferences
    const preferences = getNotificationPreferences(notificationData.recipient_type, notificationData.recipient_id);
    const typePreference = preferences.find(p => 
      p.notification_type === notificationData.notification_type || 
      p.notification_type === 'ALL'
    );
    
    if (typePreference && !typePreference.is_enabled) {
      return { success: true, skipped: true, reason: 'Notification type disabled by user' };
    }
    
    // Get template if not provided
    let title = notificationData.title;
    let message = notificationData.message;
    
    if (!title || !message) {
      const template = getNotificationTemplate(notificationData.notification_type, recipientInfo.language || 'en');
      if (template) {
        title = title || processTemplate(template.subject, notificationData.data);
        message = message || processTemplate(template.body, notificationData.data);
      } else {
        title = title || notificationData.notification_type;
        message = message || '';
      }
    }
    
    // Create notification record
    const notificationId = generateId('NOT');
    const now = new Date();
    const expiresAt = new Date(now);
    expiresAt.setDate(expiresAt.getDate() + NOTIFICATION_CONFIG.NOTIFICATION_EXPIRY_DAYS);
    
    const notification = {
      notification_id: notificationId,
      recipient_type: notificationData.recipient_type,
      recipient_id: notificationData.recipient_id,
      notification_type: notificationData.notification_type,
      reference_type: notificationData.reference_type || '',
      reference_id: notificationData.reference_id || '',
      title: title,
      message: message,
      priority: notificationData.priority || 'NORMAL',
      email_sent: false,
      sms_sent: false,
      in_app_read: false,
      in_app_read_at: '',
      action_url: notificationData.action_url || '',
      expires_at: expiresAt,
      created_at: now,
    };
    
    // Determine channels to use
    const channels = determineChannels(typePreference, notificationData.channels, notificationData.priority);
    
    // Send through each channel
    const sendResults = {};
    
    if (channels.email && recipientInfo.email) {
      const emailResult = sendEmailNotification(recipientInfo.email, title, message, notificationData);
      sendResults.email = emailResult.success;
      notification.email_sent = emailResult.success;
    }
    
    if (channels.sms && recipientInfo.phone) {
      const smsResult = sendSMSNotification(recipientInfo.phone, message);
      sendResults.sms = smsResult.success;
      notification.sms_sent = smsResult.success;
    }
    
    if (channels.whatsapp && recipientInfo.phone) {
      const waResult = sendWhatsAppNotification(recipientInfo.phone, message, notificationData);
      sendResults.whatsapp = waResult.success;
    }
    
    // Always create in-app notification
    appendRow('Notifications', notification);
    clearSheetCache('Notifications');
    
    return {
      success: true,
      notificationId: notificationId,
      channels: sendResults,
    };
    
  } catch (e) {
    Logger.log('createNotification error: ' + e.message);
    return { success: false, error: 'Failed to create notification' };
  }
}

/**
 * Creates notifications for multiple recipients.
 * @param {Object} notificationData - Base notification data
 * @param {Object[]} recipients - Array of { type, id } recipients
 * @returns {Object} Result
 */
function createBulkNotification(notificationData, recipients) {
  const results = { success: 0, failed: 0, skipped: 0 };
  
  for (const recipient of recipients) {
    const result = createNotification({
      ...notificationData,
      recipient_type: recipient.type,
      recipient_id: recipient.id,
    });
    
    if (result.success) {
      if (result.skipped) {
        results.skipped++;
      } else {
        results.success++;
      }
    } else {
      results.failed++;
    }
  }
  
  return {
    success: true,
    sent: results.success,
    skipped: results.skipped,
    failed: results.failed,
  };
}

// ============================================================================
// EMAIL NOTIFICATIONS
// ============================================================================

/**
 * Sends an email notification using Microsoft Graph API.
 * Falls back to MailApp if Graph API fails.
 * @param {string} to - Recipient email
 * @param {string} subject - Email subject
 * @param {string} body - Email body
 * @param {Object} options - Additional options
 * @returns {Object} Result
 */
function sendEmailNotification(to, subject, body, options = {}) {
  try {
    const htmlBody = options.htmlBody || buildEmailHTML(subject, body, options);

    // Try Microsoft Graph API first
    const graphResult = sendViaGraphAPI_(to, subject, htmlBody, options);
    if (graphResult.success) {
      logIntegration('EMAIL', 'OUTBOUND', 'graph-api', { to, subject }, { success: true }, 200);
      return { success: true };
    }

    // Fallback to MailApp
    Logger.log('[NotificationService] Graph API failed, falling back to MailApp: ' + graphResult.error);
    MailApp.sendEmail({
      to: to,
      subject: subject,
      htmlBody: htmlBody,
      name: 'Hass Petroleum CMS',
      replyTo: 'hassaudit@outlook.com',
      cc: options.cc || '',
      bcc: options.bcc || '',
    });

    logIntegration('EMAIL', 'OUTBOUND', 'mailapp-fallback', { to, subject }, { success: true, fallback: true }, 200);
    return { success: true };

  } catch (e) {
    Logger.log('[NotificationService] sendEmailNotification error: ' + e.message);
    logIntegration('EMAIL', 'OUTBOUND', 'send', { to, subject }, { error: e.message }, 500);
    return { success: false, error: e.message };
  }
}

/**
 * Sends email via Microsoft Graph API.
 * @param {string} to - Recipient email
 * @param {string} subject - Email subject
 * @param {string} htmlBody - HTML body
 * @param {Object} options - Additional options
 * @returns {Object} Result
 */
function sendViaGraphAPI_(to, subject, htmlBody, options) {
  try {
    const GRAPH_ENDPOINT = 'https://graph.microsoft.com/v1.0/users/hassaudit@outlook.com/sendMail';
    const token = PropertiesService.getScriptProperties().getProperty('GRAPH_API_TOKEN');

    if (!token) {
      return { success: false, error: 'GRAPH_API_TOKEN not configured' };
    }

    const toRecipients = [{ emailAddress: { address: to } }];
    if (options.cc) {
      var ccList = options.cc.split(',').map(function(e) { return { emailAddress: { address: e.trim() } }; });
    }
    if (options.bcc) {
      var bccList = options.bcc.split(',').map(function(e) { return { emailAddress: { address: e.trim() } }; });
    }

    const payload = {
      message: {
        subject: subject,
        body: {
          contentType: 'HTML',
          content: htmlBody,
        },
        toRecipients: toRecipients,
        replyTo: [{ emailAddress: { address: 'hassaudit@outlook.com' } }],
        from: {
          emailAddress: {
            address: 'hassaudit@outlook.com',
            name: 'Hass Petroleum CMS',
          },
        },
      },
      saveToSentItems: false,
    };

    if (ccList) payload.message.ccRecipients = ccList;
    if (bccList) payload.message.bccRecipients = bccList;

    const response = UrlFetchApp.fetch(GRAPH_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });

    const code = response.getResponseCode();
    if (code >= 200 && code < 300) {
      return { success: true };
    }

    return { success: false, error: 'Graph API HTTP ' + code + ': ' + response.getContentText() };

  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Builds HTML email from template.
 * @param {string} subject - Email subject
 * @param {string} body - Email body text
 * @param {Object} options - Additional options
 * @returns {string} HTML email
 */
function buildEmailHTML(subject, body, options = {}) {
  const primaryColor = '#1A237E'; // Hass brand color
  const accentColor = '#FF6F00';
  
  const actionButton = options.action_url ? `
    <div style="text-align: center; margin: 30px 0;">
      <a href="${options.action_url}" style="background-color: ${primaryColor}; color: white; padding: 12px 30px; text-decoration: none; border-radius: 4px; font-weight: bold;">
        ${options.action_text || 'View Details'}
      </a>
    </div>
  ` : '';
  
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f5f5f5;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 20px 0;">
        <tr>
          <td align="center">
            <table width="600" cellpadding="0" cellspacing="0" style="background-color: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
              <!-- Header -->
              <tr>
                <td style="background-color: ${primaryColor}; padding: 20px; text-align: center;">
                  <h1 style="color: white; margin: 0; font-size: 24px;">Hass Petroleum</h1>
                </td>
              </tr>
              
              <!-- Content -->
              <tr>
                <td style="padding: 30px;">
                  <h2 style="color: ${primaryColor}; margin-top: 0;">${subject}</h2>
                  <div style="color: #333; line-height: 1.6;">
                    ${body.replace(/\n/g, '<br>')}
                  </div>
                  ${actionButton}
                </td>
              </tr>
              
              <!-- Footer -->
              <tr>
                <td style="background-color: #f5f5f5; padding: 20px; text-align: center; font-size: 12px; color: #666;">
                  <p style="margin: 0;">© ${new Date().getFullYear()} Hass Petroleum Group. All rights reserved.</p>
                  <p style="margin: 5px 0 0 0;">This is an automated message. Please do not reply directly to this email.</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;
}

// ============================================================================
// SMS NOTIFICATIONS
// ============================================================================

/**
 * Sends an SMS notification.
 * @param {string} phoneNumber - Recipient phone number
 * @param {string} message - SMS message
 * @returns {Object} Result
 */
function sendSMSNotification(phoneNumber, message) {
  try {
    const config = getNotificationConfig();
    
    if (!config.smsApiKey || !config.smsApiUrl) {
      Logger.log('SMS not configured');
      return { success: false, error: 'SMS not configured' };
    }
    
    // Format phone number
    const formattedPhone = formatPhoneNumber(phoneNumber);
    
    // Truncate message to SMS limit
    const truncatedMessage = message.substring(0, 160);
    
    // Send via SMS API
    const response = UrlFetchApp.fetch(config.smsApiUrl, {
      method: 'POST',
      contentType: 'application/json',
      headers: {
        'Authorization': `Bearer ${config.smsApiKey}`,
      },
      payload: JSON.stringify({
        to: formattedPhone,
        message: truncatedMessage,
        sender_id: config.smsSenderId,
      }),
      muteHttpExceptions: true,
    });
    
    const result = JSON.parse(response.getContentText());
    const success = response.getResponseCode() === 200;
    
    logIntegration('SMS', 'OUTBOUND', config.smsApiUrl, 
      { to: formattedPhone, message: truncatedMessage.substring(0, 50) }, 
      result, 
      response.getResponseCode()
    );
    
    return { success: success, messageId: result.message_id };
    
  } catch (e) {
    Logger.log('sendSMSNotification error: ' + e.message);
    return { success: false, error: e.message };
  }
}

/**
 * Formats phone number to international format.
 * @param {string} phone - Phone number
 * @returns {string} Formatted phone number
 */
function formatPhoneNumber(phone) {
  if (!phone) return '';
  
  // Remove all non-digits
  let cleaned = phone.replace(/\D/g, '');
  
  // Add country code if missing
  if (cleaned.startsWith('0')) {
    cleaned = '254' + cleaned.substring(1); // Default to Kenya
  } else if (!cleaned.startsWith('254') && !cleaned.startsWith('256') && !cleaned.startsWith('255')) {
    cleaned = '254' + cleaned;
  }
  
  return '+' + cleaned;
}

// ============================================================================
// WHATSAPP NOTIFICATIONS
// ============================================================================

/**
 * Sends a WhatsApp notification via Meta Business API.
 * @param {string} phoneNumber - Recipient phone number
 * @param {string} message - Message text
 * @param {Object} options - Additional options
 * @returns {Object} Result
 */
function sendWhatsAppNotification(phoneNumber, message, options = {}) {
  try {
    const config = getNotificationConfig();
    
    if (!config.whatsappApiKey || !config.whatsappPhoneId) {
      Logger.log('WhatsApp not configured');
      return { success: false, error: 'WhatsApp not configured' };
    }
    
    const formattedPhone = formatPhoneNumber(phoneNumber).replace('+', '');
    
    // Build payload
    const payload = {
      messaging_product: 'whatsapp',
      to: formattedPhone,
      type: 'text',
      text: {
        body: message,
      },
    };
    
    // Use template if specified
    if (options.template) {
      payload.type = 'template';
      payload.template = {
        name: options.template,
        language: { code: options.language || 'en' },
        components: options.templateParams || [],
      };
      delete payload.text;
    }
    
    const apiUrl = `https://graph.facebook.com/v18.0/${config.whatsappPhoneId}/messages`;
    
    const response = UrlFetchApp.fetch(apiUrl, {
      method: 'POST',
      contentType: 'application/json',
      headers: {
        'Authorization': `Bearer ${config.whatsappApiKey}`,
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    
    const result = JSON.parse(response.getContentText());
    const success = response.getResponseCode() === 200;
    
    logIntegration('WHATSAPP', 'OUTBOUND', apiUrl,
      { to: formattedPhone },
      result,
      response.getResponseCode()
    );
    
    return { 
      success: success, 
      messageId: result.messages?.[0]?.id,
      error: result.error?.message,
    };
    
  } catch (e) {
    Logger.log('sendWhatsAppNotification error: ' + e.message);
    return { success: false, error: e.message };
  }
}

// ============================================================================
// IN-APP NOTIFICATIONS
// ============================================================================

/**
 * Gets unread notifications for a user.
 * @param {string} recipientType - 'CUSTOMER_CONTACT' or 'INTERNAL_USER'
 * @param {string} recipientId - User/Contact ID
 * @param {Object} options - Query options
 * @returns {Object} Notifications list
 */
function getUnreadNotifications(recipientType, recipientId, options = {}) {
  return findWhere('Notifications', {
    recipient_type: recipientType,
    recipient_id: recipientId,
    in_app_read: false,
  }, {
    sortBy: 'created_at',
    sortOrder: 'desc',
    limit: options.limit || 20,
  });
}

/**
 * Gets all notifications for a user.
 * @param {string} recipientType - 'CUSTOMER_CONTACT' or 'INTERNAL_USER'
 * @param {string} recipientId - User/Contact ID
 * @param {Object} options - Query options
 * @returns {Object} Notifications list
 */
function getNotifications(recipientType, recipientId, options = {}) {
  return findWhere('Notifications', {
    recipient_type: recipientType,
    recipient_id: recipientId,
  }, {
    sortBy: 'created_at',
    sortOrder: 'desc',
    limit: options.limit || 50,
    offset: options.offset || 0,
  });
}

/**
 * Marks a notification as read.
 * @param {string} notificationId - Notification ID
 * @param {string} userId - User performing the action
 * @returns {Object} Result
 */
function markNotificationRead(notificationId, userId) {
  try {
    const notification = getById('Notifications', notificationId);
    if (!notification) {
      return { success: false, error: 'Notification not found' };
    }
    
    // Verify ownership
    if (notification.recipient_id !== userId) {
      return { success: false, error: 'Access denied' };
    }
    
    updateRow('Notifications', 'notification_id', notificationId, {
      in_app_read: true,
      in_app_read_at: new Date(),
    });
    
    clearSheetCache('Notifications');
    
    return { success: true };
    
  } catch (e) {
    Logger.log('markNotificationRead error: ' + e.message);
    return { success: false, error: 'Failed to mark as read' };
  }
}

/**
 * Marks all notifications as read for a user.
 * @param {string} recipientType - Recipient type
 * @param {string} recipientId - Recipient ID
 * @returns {Object} Result
 */
function markAllNotificationsRead(recipientType, recipientId) {
  try {
    const unread = getUnreadNotifications(recipientType, recipientId, { limit: 500 });
    const now = new Date();
    let count = 0;
    
    for (const notification of unread.data || []) {
      updateRow('Notifications', 'notification_id', notification.notification_id, {
        in_app_read: true,
        in_app_read_at: now,
      });
      count++;
    }
    
    clearSheetCache('Notifications');
    
    return { success: true, marked: count };
    
  } catch (e) {
    Logger.log('markAllNotificationsRead error: ' + e.message);
    return { success: false, error: 'Failed to mark all as read' };
  }
}

/**
 * Gets unread notification count.
 * @param {string} recipientType - Recipient type
 * @param {string} recipientId - Recipient ID
 * @returns {Object} Count
 */
function getUnreadCount(recipientType, recipientId) {
  return {
    success: true,
    count: countWhere('Notifications', {
      recipient_type: recipientType,
      recipient_id: recipientId,
      in_app_read: false,
    }),
  };
}

// ============================================================================
// NOTIFICATION PREFERENCES
// ============================================================================

/**
 * Gets notification preferences for a user.
 * @param {string} recipientType - Recipient type
 * @param {string} recipientId - Recipient ID
 * @returns {Object[]} Preferences
 */
function getNotificationPreferences(recipientType, recipientId) {
  const result = findWhere('NotificationPreferences', {
    recipient_type: recipientType,
    recipient_id: recipientId,
  });
  
  return result.data || [];
}

/**
 * Updates notification preferences.
 * @param {string} recipientType - Recipient type
 * @param {string} recipientId - Recipient ID
 * @param {Object} preferences - Preferences to update
 * @returns {Object} Result
 */
function updateNotificationPreferences(recipientType, recipientId, preferences) {
  try {
    const now = new Date();
    
    for (const [notificationType, settings] of Object.entries(preferences)) {
      // Check if preference exists
      const existing = findRow('NotificationPreferences', 'recipient_id', recipientId);
      const existingForType = existing ? 
        findWhere('NotificationPreferences', {
          recipient_type: recipientType,
          recipient_id: recipientId,
          notification_type: notificationType,
        }).data[0] : null;
      
      if (existingForType) {
        updateRow('NotificationPreferences', 'preference_id', existingForType.preference_id, {
          channel_email: settings.email !== undefined ? settings.email : existingForType.channel_email,
          channel_sms: settings.sms !== undefined ? settings.sms : existingForType.channel_sms,
          channel_whatsapp: settings.whatsapp !== undefined ? settings.whatsapp : existingForType.channel_whatsapp,
          channel_push: settings.push !== undefined ? settings.push : existingForType.channel_push,
          channel_in_app: settings.in_app !== undefined ? settings.in_app : existingForType.channel_in_app,
          is_enabled: settings.enabled !== undefined ? settings.enabled : existingForType.is_enabled,
          updated_at: now,
        });
      } else {
        appendRow('NotificationPreferences', {
          preference_id: generateId('NP'),
          recipient_type: recipientType,
          recipient_id: recipientId,
          notification_type: notificationType,
          channel_email: settings.email !== undefined ? settings.email : true,
          channel_sms: settings.sms !== undefined ? settings.sms : false,
          channel_whatsapp: settings.whatsapp !== undefined ? settings.whatsapp : false,
          channel_push: settings.push !== undefined ? settings.push : true,
          channel_in_app: settings.in_app !== undefined ? settings.in_app : true,
          is_enabled: settings.enabled !== undefined ? settings.enabled : true,
          created_at: now,
          updated_at: now,
        });
      }
    }
    
    clearSheetCache('NotificationPreferences');
    
    return { success: true };
    
  } catch (e) {
    Logger.log('updateNotificationPreferences error: ' + e.message);
    return { success: false, error: 'Failed to update preferences' };
  }
}

// ============================================================================
// NOTIFICATION TEMPLATES
// ============================================================================

/**
 * Gets notification template by type and language.
 * @param {string} notificationType - Notification type
 * @param {string} language - Language code
 * @returns {Object} Template or null
 */
function getNotificationTemplate(notificationType, language = 'en') {
  const result = findWhere('NotificationTemplates', {
    notification_type: notificationType,
    language: language,
    is_active: true,
  });
  
  if (result.data && result.data.length > 0) {
    return result.data[0];
  }
  
  // Fall back to English
  if (language !== 'en') {
    return getNotificationTemplate(notificationType, 'en');
  }
  
  // Return default template
  return getDefaultTemplate(notificationType);
}

/**
 * Gets default template for notification type.
 * @param {string} notificationType - Notification type
 * @returns {Object} Default template
 */
function getDefaultTemplate(notificationType) {
  const defaults = {
    'TICKET_CREATED': {
      subject: 'Support Ticket Created - {{ticket_number}}',
      body: 'Your support ticket has been created.\n\nTicket Number: {{ticket_number}}\nSubject: {{subject}}\n\nWe will respond to your inquiry shortly.',
    },
    'TICKET_UPDATED': {
      subject: 'Ticket Update - {{ticket_number}}',
      body: 'Your support ticket {{ticket_number}} has been updated.\n\nNew Status: {{status}}\n\nPlease log in to view the details.',
    },
    'TICKET_RESOLVED': {
      subject: 'Ticket Resolved - {{ticket_number}}',
      body: 'Your support ticket {{ticket_number}} has been resolved.\n\nResolution: {{resolution}}\n\nIf you have any further questions, please let us know.',
    },
    'ORDER_CONFIRMED': {
      subject: 'Order Confirmed - {{order_number}}',
      body: 'Your order {{order_number}} has been confirmed.\n\nTotal: {{total}}\nDelivery Date: {{delivery_date}}\n\nThank you for your business.',
    },
    'ORDER_STATUS': {
      subject: 'Order Update - {{order_number}}',
      body: 'Your order {{order_number}} status has been updated.\n\nNew Status: {{status}}\n\nTrack your order in the customer portal.',
    },
    'ORDER_DELIVERED': {
      subject: 'Order Delivered - {{order_number}}',
      body: 'Your order {{order_number}} has been delivered.\n\nDelivered: {{delivered_at}}\n\nThank you for choosing Hass Petroleum.',
    },
    'DOCUMENT_EXPIRING': {
      subject: 'Document Expiring Soon',
      body: 'The following document is expiring soon:\n\nDocument: {{document_name}}\nExpiry Date: {{expiry_date}}\n\nPlease upload an updated document.',
    },
    'SYSTEM_ALERT': {
      subject: 'System Alert',
      body: '{{message}}',
    },
  };
  
  return defaults[notificationType] || {
    subject: notificationType.replace(/_/g, ' '),
    body: '{{message}}',
  };
}

/**
 * Processes template with data.
 * @param {string} template - Template string with {{placeholders}}
 * @param {Object} data - Data object
 * @returns {string} Processed string
 */
function processTemplate(template, data = {}) {
  if (!template) return '';
  
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return data[key] !== undefined ? data[key] : match;
  });
}

// ============================================================================
// SPECIFIC NOTIFICATION FUNCTIONS
// ============================================================================

/**
 * Sends ticket created notification.
 * @param {string} ticketId - Ticket ID
 * @param {string} ticketNumber - Ticket number
 * @param {string} contactId - Contact ID
 * @param {string} subject - Ticket subject
 */
function sendTicketCreatedNotification(ticketId, ticketNumber, contactId, subject) {
  createNotification({
    recipient_type: 'CUSTOMER_CONTACT',
    recipient_id: contactId,
    notification_type: 'TICKET_CREATED',
    reference_type: 'Ticket',
    reference_id: ticketId,
    data: {
      ticket_number: ticketNumber,
      subject: subject,
    },
    action_url: `/portal/tickets/${ticketId}`,
    priority: 'NORMAL',
  });
}

/**
 * Sends ticket assigned notification to staff.
 * @param {string} ticketId - Ticket ID
 * @param {string} ticketNumber - Ticket number
 * @param {string} userId - User ID
 * @param {string} customerName - Customer name
 */
function sendTicketAssignedNotification(ticketId, ticketNumber, userId, customerName) {
  createNotification({
    recipient_type: 'INTERNAL_USER',
    recipient_id: userId,
    notification_type: 'TICKET_ASSIGNED',
    reference_type: 'Ticket',
    reference_id: ticketId,
    title: `Ticket Assigned: ${ticketNumber}`,
    message: `You have been assigned ticket ${ticketNumber}${customerName ? ' from ' + customerName : ''}.`,
    action_url: `/tickets/${ticketId}`,
    priority: 'HIGH',
  });
}

/**
 * Sends order confirmation notification.
 * @param {string} orderId - Order ID
 * @param {string} orderNumber - Order number
 * @param {string} contactId - Contact ID
 * @param {Object} orderDetails - Order details
 */
function sendOrderConfirmationNotification(orderId, orderNumber, contactId, orderDetails) {
  createNotification({
    recipient_type: 'CUSTOMER_CONTACT',
    recipient_id: contactId,
    notification_type: 'ORDER_CONFIRMED',
    reference_type: 'Order',
    reference_id: orderId,
    data: {
      order_number: orderNumber,
      total: orderDetails.total,
      delivery_date: orderDetails.deliveryDate,
    },
    action_url: `/portal/orders/${orderId}`,
    priority: 'NORMAL',
  });
}

/**
 * Sends document expiry warning notification.
 * @param {string} documentId - Document ID
 * @param {string} documentName - Document name
 * @param {Date} expiryDate - Expiry date
 * @param {string} contactId - Contact ID
 */
function sendDocumentExpiryNotification(documentId, documentName, expiryDate, contactId) {
  createNotification({
    recipient_type: 'CUSTOMER_CONTACT',
    recipient_id: contactId,
    notification_type: 'DOCUMENT_EXPIRING',
    reference_type: 'Document',
    reference_id: documentId,
    data: {
      document_name: documentName,
      expiry_date: expiryDate.toLocaleDateString(),
    },
    action_url: `/portal/documents`,
    priority: 'HIGH',
  });
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Gets recipient info based on type.
 * @param {string} recipientType - Recipient type
 * @param {string} recipientId - Recipient ID
 * @returns {Object} Recipient info
 */
function getRecipientInfo(recipientType, recipientId) {
  if (recipientType === 'CUSTOMER_CONTACT') {
    const contact = getById('Contacts', recipientId);
    if (!contact) return null;
    
    return {
      email: contact.email,
      phone: contact.phone,
      name: `${contact.first_name} ${contact.last_name}`,
      language: contact.preferred_language || 'en',
      notificationEmail: contact.notification_email,
      notificationSms: contact.notification_sms,
      notificationWhatsapp: contact.notification_whatsapp,
      notificationPush: contact.notification_push,
    };
  }
  
  if (recipientType === 'INTERNAL_USER') {
    const user = getById('Users', recipientId);
    if (!user) return null;
    
    return {
      email: user.email,
      phone: user.phone,
      name: `${user.first_name} ${user.last_name}`,
      language: 'en',
      notificationEmail: true,
      notificationSms: false,
      notificationWhatsapp: false,
      notificationPush: true,
    };
  }
  
  return null;
}

/**
 * Determines which channels to use for notification.
 * @param {Object} preference - User preference for this notification type
 * @param {Object} requestedChannels - Channels requested by caller
 * @param {string} priority - Notification priority
 * @returns {Object} Channels to use
 */
function determineChannels(preference, requestedChannels, priority) {
  const channels = {
    email: false,
    sms: false,
    whatsapp: false,
    push: false,
    in_app: true, // Always create in-app notification
  };
  
  // If specific channels requested, use those
  if (requestedChannels) {
    return { ...channels, ...requestedChannels };
  }
  
  // Use preference if available
  if (preference) {
    channels.email = preference.channel_email;
    channels.sms = preference.channel_sms;
    channels.whatsapp = preference.channel_whatsapp;
    channels.push = preference.channel_push;
  } else {
    // Default: email for all, SMS for urgent
    channels.email = true;
    if (priority === 'URGENT' || priority === 'HIGH') {
      channels.sms = true;
    }
  }
  
  return channels;
}

/**
 * Logs integration call.
 * @param {string} integration - Integration name
 * @param {string} direction - INBOUND or OUTBOUND
 * @param {string} endpoint - API endpoint
 * @param {Object} request - Request data
 * @param {Object} response - Response data
 * @param {number} statusCode - HTTP status code
 */
function logIntegration(integration, direction, endpoint, request, response, statusCode) {
  try {
    appendRow('IntegrationLog', {
      log_id: generateId('INT'),
      integration: integration,
      direction: direction,
      endpoint: endpoint,
      method: 'POST',
      request_body: JSON.stringify(request).substring(0, 5000),
      response_body: JSON.stringify(response).substring(0, 5000),
      status_code: statusCode,
      error_message: statusCode >= 400 ? (response.error || response.message || '') : '',
      duration_ms: 0,
      reference_type: '',
      reference_id: '',
      created_at: new Date(),
    });
  } catch (e) {
    Logger.log('logIntegration error: ' + e.message);
  }
}

// ============================================================================
// SCHEDULED JOBS
// ============================================================================

/**
 * Cleans up expired notifications.
 * Run via daily trigger.
 */
function cleanupExpiredNotifications() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return { success: false, error: 'Could not obtain lock' };
  }
  
  try {
    const now = new Date();
    const notifications = getSheetData('Notifications');
    let deletedCount = 0;
    
    for (const notification of notifications) {
      if (notification.expires_at && new Date(notification.expires_at) < now) {
        deleteRow('Notifications', 'notification_id', notification.notification_id, true);
        deletedCount++;
      }
    }
    
    if (deletedCount > 0) {
      clearSheetCache('Notifications');
    }
    
    return {
      success: true,
      deletedCount: deletedCount,
    };
    
  } catch (e) {
    Logger.log('cleanupExpiredNotifications error: ' + e.message);
    return { success: false, error: e.message };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Checks for documents expiring soon and sends notifications.
 * Run via daily trigger.
 */
function checkExpiringDocuments() {
  try {
    const warningDays = getConfigNumber('DOCUMENT_EXPIRY_WARNING_DAYS', 30);
    const warningDate = new Date();
    warningDate.setDate(warningDate.getDate() + warningDays);
    
    const documents = findWhere('Documents', { status: 'APPROVED' }).data || [];
    let notificationsSent = 0;
    
    for (const doc of documents) {
      if (!doc.expiry_date) continue;
      
      const expiryDate = new Date(doc.expiry_date);
      if (expiryDate <= warningDate && expiryDate > new Date()) {
        // Get customer's primary contact
        const customer = getById('Customers', doc.customer_id);
        if (!customer) continue;
        
        const contacts = findWhere('Contacts', { 
          customer_id: doc.customer_id, 
          contact_type: 'PRIMARY',
          status: 'ACTIVE',
        }).data || [];
        
        for (const contact of contacts) {
          sendDocumentExpiryNotification(doc.document_id, doc.document_name, expiryDate, contact.contact_id);
          notificationsSent++;
        }
      }
    }
    
    return {
      success: true,
      notificationsSent: notificationsSent,
    };
    
  } catch (e) {
    Logger.log('checkExpiringDocuments error: ' + e.message);
    return { success: false, error: e.message };
  }
}

// ============================================================================
// WEB APP HANDLER
// ============================================================================

/**
 * Handles notification API requests.
 * @param {Object} params - Request parameters
 * @returns {Object} Response
 */
function handleNotificationRequest(params) {
  const action = params.action;
  
  switch (action) {
    case 'send':
      return createNotification(params.data);
      
    case 'sendBulk':
      return createBulkNotification(params.data, params.recipients);
      
    case 'getUnread':
      return getUnreadNotifications(params.recipientType, params.recipientId, params.options);
      
    case 'getAll':
      return getNotifications(params.recipientType, params.recipientId, params.options);
      
    case 'getUnreadCount':
      return getUnreadCount(params.recipientType, params.recipientId);
      
    case 'markRead':
      return markNotificationRead(params.notificationId, params.userId);
      
    case 'markAllRead':
      return markAllNotificationsRead(params.recipientType, params.recipientId);
      
    case 'getPreferences':
      return { success: true, data: getNotificationPreferences(params.recipientType, params.recipientId) };
      
    case 'updatePreferences':
      return updateNotificationPreferences(params.recipientType, params.recipientId, params.preferences);
      
    default:
      return { success: false, error: 'Unknown action: ' + action };
  }
}
