/**
 * HASS PETROLEUM CMS - INTEGRATION SERVICE
 * Version: 1.0.0
 * 
 * Handles:
 * - Oracle EBS integration (customer, orders, invoices sync)
 * - Webhook processing (inbound/outbound)
 * - External API integrations
 * - Data synchronization jobs
 * - Integration health monitoring
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

const INTEGRATION_CONFIG = {
  RETRY_ATTEMPTS: 3,
  RETRY_DELAY_MS: 2000,
  TIMEOUT_MS: 30000,
  BATCH_SIZE: 100,
  SYNC_INTERVAL_MINUTES: 15,
};

/**
 * Gets integration configuration from Script Properties.
 */
function getIntegrationConfig() {
  const props = PropertiesService.getScriptProperties();
  return {
    // Oracle EBS
    oracleApiUrl: props.getProperty('ORACLE_API_URL') || '',
    oracleApiKey: props.getProperty('ORACLE_API_KEY') || '',
    oracleUsername: props.getProperty('ORACLE_USERNAME') || '',
    oraclePassword: props.getProperty('ORACLE_PASSWORD') || '',
    
    // Webhooks
    webhookSecret: props.getProperty('WEBHOOK_SECRET') || '',
    
    // External APIs
    mapsApiKey: props.getProperty('GOOGLE_MAPS_API_KEY') || '',
  };
}

// ============================================================================
// ORACLE EBS INTEGRATION
// ============================================================================

/**
 * Syncs a customer to Oracle EBS.
 * @param {string} customerId - Customer ID
 * @returns {Object} Sync result
 */
function syncCustomerToOracle(customerId) {
  const startTime = new Date();
  
  try {
    const config = getIntegrationConfig();
    
    if (!config.oracleApiUrl) {
      return { success: false, error: 'Oracle integration not configured' };
    }
    
    const customer = getById('Customers', customerId);
    if (!customer) {
      return { success: false, error: 'Customer not found' };
    }
    
    // Get contacts
    const contacts = findWhere('Contacts', { 
      customer_id: customerId, 
      status: 'ACTIVE' 
    }).data || [];
    
    // Get delivery locations
    const locations = findWhere('DeliveryLocations', {
      customer_id: customerId,
      status: 'ACTIVE',
    }).data || [];
    
    // Build Oracle payload
    const payload = {
      account_number: customer.account_number,
      company_name: customer.company_name,
      trading_name: customer.trading_name,
      tax_pin: customer.tax_pin,
      registration_number: customer.registration_number,
      payment_terms: customer.payment_terms,
      credit_limit: customer.credit_limit,
      currency_code: customer.currency_code,
      country_code: customer.country_code,
      contacts: contacts.map(c => ({
        first_name: c.first_name,
        last_name: c.last_name,
        email: c.email,
        phone: c.phone,
        is_primary: c.contact_type === 'PRIMARY',
      })),
      ship_to_locations: locations.map(l => ({
        name: l.location_name,
        address: l.address,
        city: l.city,
        gps_lat: l.gps_lat,
        gps_lng: l.gps_lng,
      })),
    };
    
    // Call Oracle API
    const response = callOracleApi('/customers', 'POST', payload, config);
    
    const duration = new Date() - startTime;
    
    // Log integration
    logIntegrationCall('ORACLE_EBS', 'OUTBOUND', '/customers', payload, response.data, response.status, duration);
    
    if (response.success) {
      // Update customer with Oracle ID
      if (response.data.oracle_customer_id) {
        updateRow('Customers', 'customer_id', customerId, {
          oracle_customer_id: response.data.oracle_customer_id,
          last_synced_at: new Date(),
        });
        clearSheetCache('Customers');
      }
      
      return {
        success: true,
        oracleCustomerId: response.data.oracle_customer_id,
      };
    }
    
    return { success: false, error: response.error || 'Oracle sync failed' };
    
  } catch (e) {
    const duration = new Date() - startTime;
    logIntegrationCall('ORACLE_EBS', 'OUTBOUND', '/customers', { customerId }, { error: e.message }, 500, duration);
    Logger.log('syncCustomerToOracle error: ' + e.message);
    return { success: false, error: e.message };
  }
}

/**
 * Syncs an order to Oracle EBS.
 * @param {string} orderId - Order ID
 * @returns {Object} Sync result
 */
function syncOrderToOracle(orderId) {
  const startTime = new Date();
  
  try {
    const config = getIntegrationConfig();
    
    if (!config.oracleApiUrl) {
      return { success: false, error: 'Oracle integration not configured' };
    }
    
    const order = getById('Orders', orderId);
    if (!order) {
      return { success: false, error: 'Order not found' };
    }
    
    const customer = getById('Customers', order.customer_id);
    if (!customer || !customer.oracle_customer_id) {
      // Sync customer first
      const customerSync = syncCustomerToOracle(order.customer_id);
      if (!customerSync.success) {
        return { success: false, error: 'Failed to sync customer first: ' + customerSync.error };
      }
    }
    
    // Get order lines
    const lines = findWhere('OrderLines', { order_id: orderId }).data || [];
    
    // Get delivery location
    const location = order.delivery_location_id ? 
      getById('DeliveryLocations', order.delivery_location_id) : null;
    
    // Build Oracle payload
    const payload = {
      order_number: order.order_number,
      oracle_customer_id: customer.oracle_customer_id,
      order_date: order.created_at,
      requested_delivery_date: order.requested_date,
      po_number: order.po_number,
      currency_code: order.currency_code,
      payment_terms: customer.payment_terms,
      ship_to: location ? {
        name: location.location_name,
        address: location.address,
        city: location.city,
      } : null,
      lines: lines.map((l, idx) => ({
        line_number: idx + 1,
        product_code: l.product_id,
        product_name: l.product_name,
        quantity: l.quantity,
        unit_of_measure: l.unit_of_measure,
        unit_price: l.unit_price,
        line_total: l.line_total,
      })),
      total_amount: order.total_amount,
    };
    
    // Call Oracle API
    const response = callOracleApi('/orders', 'POST', payload, config);
    
    const duration = new Date() - startTime;
    
    logIntegrationCall('ORACLE_EBS', 'OUTBOUND', '/orders', payload, response.data, response.status, duration);
    
    if (response.success) {
      // Update order with Oracle ID
      if (response.data.oracle_order_id) {
        updateRow('Orders', 'order_id', orderId, {
          oracle_order_id: response.data.oracle_order_id,
        });
        clearSheetCache('Orders');
      }
      
      return {
        success: true,
        oracleOrderId: response.data.oracle_order_id,
      };
    }
    
    return { success: false, error: response.error || 'Oracle sync failed' };
    
  } catch (e) {
    const duration = new Date() - startTime;
    logIntegrationCall('ORACLE_EBS', 'OUTBOUND', '/orders', { orderId }, { error: e.message }, 500, duration);
    Logger.log('syncOrderToOracle error: ' + e.message);
    return { success: false, error: e.message };
  }
}

/**
 * Fetches customer data from Oracle EBS.
 * @param {string} oracleCustomerId - Oracle customer ID
 * @returns {Object} Customer data
 */
function fetchCustomerFromOracle(oracleCustomerId) {
  const startTime = new Date();
  
  try {
    const config = getIntegrationConfig();
    
    if (!config.oracleApiUrl) {
      return { success: false, error: 'Oracle integration not configured' };
    }
    
    const response = callOracleApi(`/customers/${oracleCustomerId}`, 'GET', null, config);
    
    const duration = new Date() - startTime;
    
    logIntegrationCall('ORACLE_EBS', 'INBOUND', `/customers/${oracleCustomerId}`, {}, response.data, response.status, duration);
    
    return response;
    
  } catch (e) {
    Logger.log('fetchCustomerFromOracle error: ' + e.message);
    return { success: false, error: e.message };
  }
}

/**
 * Fetches order status from Oracle EBS.
 * @param {string} oracleOrderId - Oracle order ID
 * @returns {Object} Order status
 */
function fetchOrderStatusFromOracle(oracleOrderId) {
  const startTime = new Date();
  
  try {
    const config = getIntegrationConfig();
    
    if (!config.oracleApiUrl) {
      return { success: false, error: 'Oracle integration not configured' };
    }
    
    const response = callOracleApi(`/orders/${oracleOrderId}/status`, 'GET', null, config);
    
    const duration = new Date() - startTime;
    
    logIntegrationCall('ORACLE_EBS', 'INBOUND', `/orders/${oracleOrderId}/status`, {}, response.data, response.status, duration);
    
    return response;
    
  } catch (e) {
    Logger.log('fetchOrderStatusFromOracle error: ' + e.message);
    return { success: false, error: e.message };
  }
}

/**
 * Fetches invoices from Oracle for a customer.
 * @param {string} oracleCustomerId - Oracle customer ID
 * @param {Object} dateRange - Date range filter
 * @returns {Object} Invoices
 */
function fetchInvoicesFromOracle(oracleCustomerId, dateRange = {}) {
  const startTime = new Date();
  
  try {
    const config = getIntegrationConfig();
    
    if (!config.oracleApiUrl) {
      return { success: false, error: 'Oracle integration not configured' };
    }
    
    let endpoint = `/customers/${oracleCustomerId}/invoices`;
    
    if (dateRange.from || dateRange.to) {
      const params = [];
      if (dateRange.from) params.push(`from=${dateRange.from}`);
      if (dateRange.to) params.push(`to=${dateRange.to}`);
      endpoint += '?' + params.join('&');
    }
    
    const response = callOracleApi(endpoint, 'GET', null, config);
    
    const duration = new Date() - startTime;
    
    logIntegrationCall('ORACLE_EBS', 'INBOUND', endpoint, {}, response.data, response.status, duration);
    
    return response;
    
  } catch (e) {
    Logger.log('fetchInvoicesFromOracle error: ' + e.message);
    return { success: false, error: e.message };
  }
}

/**
 * Calls Oracle API with retry logic.
 * @param {string} endpoint - API endpoint
 * @param {string} method - HTTP method
 * @param {Object} payload - Request body
 * @param {Object} config - API configuration
 * @returns {Object} Response
 */
function callOracleApi(endpoint, method, payload, config) {
  for (let attempt = 1; attempt <= INTEGRATION_CONFIG.RETRY_ATTEMPTS; attempt++) {
    try {
      const options = {
        method: method,
        headers: {
          'Authorization': `Basic ${Utilities.base64Encode(config.oracleUsername + ':' + config.oraclePassword)}`,
          'Content-Type': 'application/json',
          'X-API-Key': config.oracleApiKey,
        },
        muteHttpExceptions: true,
      };
      
      if (payload && method !== 'GET') {
        options.payload = JSON.stringify(payload);
      }
      
      const response = UrlFetchApp.fetch(config.oracleApiUrl + endpoint, options);
      const statusCode = response.getResponseCode();
      const responseData = JSON.parse(response.getContentText() || '{}');
      
      if (statusCode >= 200 && statusCode < 300) {
        return {
          success: true,
          status: statusCode,
          data: responseData,
        };
      }
      
      // Retry on 5xx errors
      if (statusCode >= 500 && attempt < INTEGRATION_CONFIG.RETRY_ATTEMPTS) {
        Utilities.sleep(INTEGRATION_CONFIG.RETRY_DELAY_MS * attempt);
        continue;
      }
      
      return {
        success: false,
        status: statusCode,
        error: responseData.message || responseData.error || `HTTP ${statusCode}`,
        data: responseData,
      };
      
    } catch (e) {
      if (attempt < INTEGRATION_CONFIG.RETRY_ATTEMPTS) {
        Utilities.sleep(INTEGRATION_CONFIG.RETRY_DELAY_MS * attempt);
        continue;
      }
      
      return {
        success: false,
        status: 500,
        error: e.message,
      };
    }
  }
  
  return { success: false, error: 'Max retries exceeded' };
}

// ============================================================================
// WEBHOOK HANDLING
// ============================================================================

/**
 * Processes incoming webhook.
 * @param {Object} webhookData - Webhook payload
 * @param {string} signature - Webhook signature for verification
 * @returns {Object} Processing result
 */
function processWebhook(webhookData, signature) {
  const startTime = new Date();
  
  try {
    const config = getIntegrationConfig();
    
    // Verify signature if secret configured
    if (config.webhookSecret) {
      const expectedSignature = computeWebhookSignature(JSON.stringify(webhookData), config.webhookSecret);
      if (signature !== expectedSignature) {
        logIntegrationCall('WEBHOOK', 'INBOUND', webhookData.type || 'unknown', webhookData, { error: 'Invalid signature' }, 401, 0);
        return { success: false, error: 'Invalid webhook signature' };
      }
    }
    
    const eventType = webhookData.type || webhookData.event;
    const eventData = webhookData.data || webhookData.payload || webhookData;
    
    // Route to appropriate handler
    let result;
    
    switch (eventType) {
      case 'customer.created':
      case 'customer.updated':
        result = handleCustomerWebhook(eventType, eventData);
        break;
        
      case 'order.status_changed':
        result = handleOrderStatusWebhook(eventData);
        break;
        
      case 'invoice.created':
      case 'invoice.paid':
        result = handleInvoiceWebhook(eventType, eventData);
        break;
        
      case 'payment.received':
        result = handlePaymentWebhook(eventData);
        break;
        
      default:
        result = { success: true, message: 'Webhook type not handled', type: eventType };
    }
    
    const duration = new Date() - startTime;
    
    logIntegrationCall('WEBHOOK', 'INBOUND', eventType || 'unknown', webhookData, result, result.success ? 200 : 400, duration);
    
    return result;
    
  } catch (e) {
    const duration = new Date() - startTime;
    logIntegrationCall('WEBHOOK', 'INBOUND', webhookData?.type || 'unknown', webhookData, { error: e.message }, 500, duration);
    Logger.log('processWebhook error: ' + e.message);
    return { success: false, error: e.message };
  }
}

/**
 * Handles customer webhook events.
 * @param {string} eventType - Event type
 * @param {Object} data - Event data
 * @returns {Object} Result
 */
function handleCustomerWebhook(eventType, data) {
  try {
    // Find customer by Oracle ID
    const customer = findRow('Customers', 'oracle_customer_id', data.oracle_customer_id);
    
    if (!customer) {
      return { success: true, message: 'Customer not found in CMS', skipped: true };
    }
    
    // Update customer data
    const updates = {};
    
    if (data.credit_limit !== undefined) {
      updates.credit_limit = data.credit_limit;
    }
    
    if (data.credit_used !== undefined) {
      updates.credit_used = data.credit_used;
    }
    
    if (data.status) {
      updates.oracle_status = data.status;
    }
    
    if (Object.keys(updates).length > 0) {
      updates.last_synced_at = new Date();
      updateRow('Customers', 'customer_id', customer.customer_id, updates);
      clearSheetCache('Customers');
    }
    
    return { success: true, customerId: customer.customer_id };
    
  } catch (e) {
    Logger.log('handleCustomerWebhook error: ' + e.message);
    return { success: false, error: e.message };
  }
}

/**
 * Handles order status webhook.
 * @param {Object} data - Event data
 * @returns {Object} Result
 */
function handleOrderStatusWebhook(data) {
  try {
    // Find order by Oracle ID
    const order = findRow('Orders', 'oracle_order_id', data.oracle_order_id);
    
    if (!order) {
      return { success: true, message: 'Order not found in CMS', skipped: true };
    }
    
    // Map Oracle status to CMS status
    const statusMap = {
      'BOOKED': 'APPROVED',
      'ENTERED': 'SUBMITTED',
      'AWAITING_SHIPPING': 'SCHEDULED',
      'SHIPPED': 'IN_TRANSIT',
      'CLOSED': 'DELIVERED',
      'CANCELLED': 'CANCELLED',
    };
    
    const cmsStatus = statusMap[data.status] || order.status;
    
    if (cmsStatus !== order.status) {
      updateOrderStatus(order.order_id, cmsStatus, {
        actorType: 'SYSTEM',
        actorId: 'ORACLE_WEBHOOK',
        actorEmail: '',
      });
    }
    
    return { success: true, orderId: order.order_id, newStatus: cmsStatus };
    
  } catch (e) {
    Logger.log('handleOrderStatusWebhook error: ' + e.message);
    return { success: false, error: e.message };
  }
}

/**
 * Handles invoice webhook.
 * @param {string} eventType - Event type
 * @param {Object} data - Event data
 * @returns {Object} Result
 */
function handleInvoiceWebhook(eventType, data) {
  try {
    // Find customer by Oracle ID
    const customer = findRow('Customers', 'oracle_customer_id', data.oracle_customer_id);
    
    if (!customer) {
      return { success: true, message: 'Customer not found', skipped: true };
    }
    
    // Find related order if any
    let order = null;
    if (data.oracle_order_id) {
      order = findRow('Orders', 'oracle_order_id', data.oracle_order_id);
    }
    
    // Update order payment status
    if (order) {
      let paymentStatus = order.payment_status;
      
      if (eventType === 'invoice.created') {
        paymentStatus = 'INVOICED';
      } else if (eventType === 'invoice.paid') {
        paymentStatus = 'PAID';
      }
      
      if (paymentStatus !== order.payment_status) {
        updateRow('Orders', 'order_id', order.order_id, {
          payment_status: paymentStatus,
          invoice_number: data.invoice_number || order.invoice_number,
          invoice_date: data.invoice_date || order.invoice_date,
        });
        clearSheetCache('Orders');
      }
    }
    
    // Update customer credit used
    if (eventType === 'invoice.paid' && data.amount) {
      const newCreditUsed = Math.max(0, (customer.credit_used || 0) - data.amount);
      updateRow('Customers', 'customer_id', customer.customer_id, {
        credit_used: newCreditUsed,
      });
      clearSheetCache('Customers');
    }
    
    return { success: true };
    
  } catch (e) {
    Logger.log('handleInvoiceWebhook error: ' + e.message);
    return { success: false, error: e.message };
  }
}

/**
 * Handles payment webhook.
 * @param {Object} data - Event data
 * @returns {Object} Result
 */
function handlePaymentWebhook(data) {
  try {
    // Find customer by Oracle ID
    const customer = findRow('Customers', 'oracle_customer_id', data.oracle_customer_id);
    
    if (!customer) {
      return { success: true, message: 'Customer not found', skipped: true };
    }
    
    // Update credit used
    if (data.amount) {
      const newCreditUsed = Math.max(0, (customer.credit_used || 0) - data.amount);
      updateRow('Customers', 'customer_id', customer.customer_id, {
        credit_used: newCreditUsed,
        last_payment_date: data.payment_date || new Date(),
        last_payment_amount: data.amount,
      });
      clearSheetCache('Customers');
    }
    
    return { success: true, customerId: customer.customer_id };
    
  } catch (e) {
    Logger.log('handlePaymentWebhook error: ' + e.message);
    return { success: false, error: e.message };
  }
}

/**
 * Computes webhook signature for verification.
 * @param {string} payload - Webhook payload
 * @param {string} secret - Webhook secret
 * @returns {string} Signature
 */
function computeWebhookSignature(payload, secret) {
  const signature = Utilities.computeHmacSha256Signature(payload, secret);
  return Utilities.base64Encode(signature);
}

// ============================================================================
// OUTBOUND WEBHOOKS
// ============================================================================

/**
 * Sends webhook to external system.
 * @param {string} webhookUrl - Target URL
 * @param {Object} payload - Webhook payload
 * @param {string} eventType - Event type
 * @returns {Object} Result
 */
function sendWebhook(webhookUrl, payload, eventType) {
  const startTime = new Date();
  
  try {
    const config = getIntegrationConfig();
    
    const webhookPayload = {
      type: eventType,
      timestamp: new Date().toISOString(),
      data: payload,
    };
    
    // Sign webhook if secret configured
    let signature = '';
    if (config.webhookSecret) {
      signature = computeWebhookSignature(JSON.stringify(webhookPayload), config.webhookSecret);
    }
    
    const response = UrlFetchApp.fetch(webhookUrl, {
      method: 'POST',
      contentType: 'application/json',
      headers: {
        'X-Webhook-Signature': signature,
        'X-Webhook-Event': eventType,
      },
      payload: JSON.stringify(webhookPayload),
      muteHttpExceptions: true,
    });
    
    const statusCode = response.getResponseCode();
    const duration = new Date() - startTime;
    
    logIntegrationCall('WEBHOOK', 'OUTBOUND', webhookUrl, webhookPayload, 
      { status: statusCode }, statusCode, duration);
    
    return {
      success: statusCode >= 200 && statusCode < 300,
      status: statusCode,
    };
    
  } catch (e) {
    const duration = new Date() - startTime;
    logIntegrationCall('WEBHOOK', 'OUTBOUND', webhookUrl, { eventType }, { error: e.message }, 500, duration);
    Logger.log('sendWebhook error: ' + e.message);
    return { success: false, error: e.message };
  }
}

// ============================================================================
// GPS/MAPS INTEGRATION
// ============================================================================

/**
 * Geocodes an address.
 * @param {string} address - Address to geocode
 * @returns {Object} Lat/lng coordinates
 */
function geocodeAddress(address) {
  try {
    const config = getIntegrationConfig();
    
    if (!config.mapsApiKey) {
      // Use Apps Script Maps service as fallback
      const geocoder = Maps.newGeocoder();
      const response = geocoder.geocode(address);
      
      if (response.status === 'OK' && response.results.length > 0) {
        const location = response.results[0].geometry.location;
        return {
          success: true,
          lat: location.lat,
          lng: location.lng,
          formatted_address: response.results[0].formatted_address,
        };
      }
      
      return { success: false, error: 'Address not found' };
    }
    
    // Use Google Maps API
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${config.mapsApiKey}`;
    const response = UrlFetchApp.fetch(url);
    const data = JSON.parse(response.getContentText());
    
    if (data.status === 'OK' && data.results.length > 0) {
      const location = data.results[0].geometry.location;
      return {
        success: true,
        lat: location.lat,
        lng: location.lng,
        formatted_address: data.results[0].formatted_address,
      };
    }
    
    return { success: false, error: data.status || 'Geocoding failed' };
    
  } catch (e) {
    Logger.log('geocodeAddress error: ' + e.message);
    return { success: false, error: e.message };
  }
}

/**
 * Calculates distance between two points.
 * @param {number} lat1 - Point 1 latitude
 * @param {number} lng1 - Point 1 longitude
 * @param {number} lat2 - Point 2 latitude
 * @param {number} lng2 - Point 2 longitude
 * @returns {number} Distance in kilometers
 */
function calculateDistance(lat1, lng1, lat2, lng2) {
  const R = 6371; // Earth's radius in km
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRadians(degrees) {
  return degrees * (Math.PI / 180);
}

// ============================================================================
// SYNC JOBS
// ============================================================================

/**
 * Syncs pending orders to Oracle.
 * Run via scheduled trigger.
 */
function syncPendingOrdersToOracle() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return { success: false, error: 'Could not obtain lock' };
  }
  
  try {
    // Find orders that need syncing
    const orders = findWhere('Orders', {
      status: ['APPROVED', 'DELIVERED'],
      oracle_order_id: '',
    }, { limit: INTEGRATION_CONFIG.BATCH_SIZE }).data || [];
    
    let synced = 0;
    let failed = 0;
    
    for (const order of orders) {
      const result = syncOrderToOracle(order.order_id);
      if (result.success) {
        synced++;
      } else {
        failed++;
      }
      
      // Rate limiting
      Utilities.sleep(500);
    }
    
    return {
      success: true,
      synced: synced,
      failed: failed,
      total: orders.length,
    };
    
  } catch (e) {
    Logger.log('syncPendingOrdersToOracle error: ' + e.message);
    return { success: false, error: e.message };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Fetches order statuses from Oracle.
 * Run via scheduled trigger.
 */
function syncOrderStatusesFromOracle() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return { success: false, error: 'Could not obtain lock' };
  }
  
  try {
    // Find orders with Oracle IDs that might have status updates
    const orders = findWhere('Orders', {
      status: ['APPROVED', 'SCHEDULED', 'LOADING', 'LOADED', 'IN_TRANSIT'],
    }, { limit: INTEGRATION_CONFIG.BATCH_SIZE }).data || [];
    
    const ordersWithOracleId = orders.filter(o => o.oracle_order_id);
    
    let updated = 0;
    
    for (const order of ordersWithOracleId) {
      const result = fetchOrderStatusFromOracle(order.oracle_order_id);
      
      if (result.success && result.data.status) {
        const statusMap = {
          'SHIPPED': 'IN_TRANSIT',
          'CLOSED': 'DELIVERED',
        };
        
        const newStatus = statusMap[result.data.status];
        
        if (newStatus && newStatus !== order.status) {
          updateOrderStatus(order.order_id, newStatus, {
            actorType: 'SYSTEM',
            actorId: 'ORACLE_SYNC',
            actorEmail: '',
          });
          updated++;
        }
      }
      
      Utilities.sleep(500);
    }
    
    return {
      success: true,
      checked: ordersWithOracleId.length,
      updated: updated,
    };
    
  } catch (e) {
    Logger.log('syncOrderStatusesFromOracle error: ' + e.message);
    return { success: false, error: e.message };
  } finally {
    lock.releaseLock();
  }
}

// ============================================================================
// HEALTH & MONITORING
// ============================================================================

/**
 * Checks integration health status.
 * @returns {Object} Health status
 */
function checkIntegrationHealth() {
  const health = {
    oracle: { status: 'unknown', latency: null },
    webhooks: { status: 'ok' },
    maps: { status: 'unknown' },
  };
  
  const config = getIntegrationConfig();
  
  // Check Oracle connectivity
  if (config.oracleApiUrl) {
    try {
      const startTime = new Date();
      const response = callOracleApi('/health', 'GET', null, config);
      health.oracle.latency = new Date() - startTime;
      health.oracle.status = response.success ? 'ok' : 'error';
      health.oracle.error = response.error;
    } catch (e) {
      health.oracle.status = 'error';
      health.oracle.error = e.message;
    }
  } else {
    health.oracle.status = 'not_configured';
  }
  
  // Check Maps API
  if (config.mapsApiKey) {
    health.maps.status = 'configured';
  } else {
    health.maps.status = 'using_fallback';
  }
  
  // Get recent integration errors
  const recentErrors = findWhere('IntegrationLog', {
    status_code: [400, 401, 403, 404, 500, 502, 503],
  }, { sortBy: 'created_at', sortOrder: 'desc', limit: 10 }).data || [];
  
  return {
    success: true,
    health: health,
    recentErrors: recentErrors.length,
    lastError: recentErrors[0] || null,
  };
}

/**
 * Gets integration statistics.
 * @param {number} hours - Hours to look back
 * @returns {Object} Statistics
 */
function getIntegrationStats(hours = 24) {
  try {
    const cutoff = new Date();
    cutoff.setHours(cutoff.getHours() - hours);
    
    const logs = getSheetData('IntegrationLog')
      .filter(l => new Date(l.created_at) >= cutoff);
    
    const stats = {
      total: logs.length,
      byIntegration: {},
      byDirection: { INBOUND: 0, OUTBOUND: 0 },
      byStatus: { success: 0, error: 0 },
      avgLatency: 0,
    };
    
    let totalLatency = 0;
    
    for (const log of logs) {
      // By integration
      stats.byIntegration[log.integration] = (stats.byIntegration[log.integration] || 0) + 1;
      
      // By direction
      if (stats.byDirection[log.direction] !== undefined) {
        stats.byDirection[log.direction]++;
      }
      
      // By status
      if (log.status_code >= 200 && log.status_code < 400) {
        stats.byStatus.success++;
      } else {
        stats.byStatus.error++;
      }
      
      // Latency
      if (log.duration_ms) {
        totalLatency += log.duration_ms;
      }
    }
    
    stats.avgLatency = logs.length > 0 ? Math.round(totalLatency / logs.length) : 0;
    stats.successRate = logs.length > 0 ? 
      Math.round((stats.byStatus.success / logs.length) * 100) : 100;
    
    return {
      success: true,
      hours: hours,
      stats: stats,
    };
    
  } catch (e) {
    Logger.log('getIntegrationStats error: ' + e.message);
    return { success: false, error: e.message };
  }
}

// ============================================================================
// LOGGING
// ============================================================================

/**
 * Logs integration API call.
 * @param {string} integration - Integration name
 * @param {string} direction - INBOUND or OUTBOUND
 * @param {string} endpoint - API endpoint
 * @param {Object} request - Request data
 * @param {Object} response - Response data
 * @param {number} statusCode - HTTP status code
 * @param {number} durationMs - Duration in milliseconds
 */
function logIntegrationCall(integration, direction, endpoint, request, response, statusCode, durationMs) {
  try {
    appendRow('IntegrationLog', {
      log_id: generateId('INT'),
      integration: integration,
      direction: direction,
      endpoint: endpoint,
      method: direction === 'OUTBOUND' ? 'POST' : 'WEBHOOK',
      request_body: JSON.stringify(request || {}).substring(0, 5000),
      response_body: JSON.stringify(response || {}).substring(0, 5000),
      status_code: statusCode,
      error_message: statusCode >= 400 ? (response?.error || response?.message || '') : '',
      duration_ms: durationMs || 0,
      reference_type: '',
      reference_id: '',
      created_at: new Date(),
    });
  } catch (e) {
    Logger.log('logIntegrationCall error: ' + e.message);
  }
}

// ============================================================================
// WEB APP HANDLER
// ============================================================================

/**
 * Handles integration API requests.
 * @param {Object} params - Request parameters
 * @returns {Object} Response
 */
function handleIntegrationRequest(params) {
  const action = params.action;
  
  switch (action) {
    // Oracle sync
    case 'syncCustomer':
      return syncCustomerToOracle(params.customerId);
      
    case 'syncOrder':
      return syncOrderToOracle(params.orderId);
      
    case 'fetchCustomer':
      return fetchCustomerFromOracle(params.oracleCustomerId);
      
    case 'fetchOrderStatus':
      return fetchOrderStatusFromOracle(params.oracleOrderId);
      
    case 'fetchInvoices':
      return fetchInvoicesFromOracle(params.oracleCustomerId, params.dateRange);
      
    // Webhooks
    case 'processWebhook':
      return processWebhook(params.data, params.signature);
      
    case 'sendWebhook':
      return sendWebhook(params.url, params.payload, params.eventType);
      
    // Geocoding
    case 'geocode':
      return geocodeAddress(params.address);
      
    case 'distance':
      return {
        success: true,
        distance: calculateDistance(params.lat1, params.lng1, params.lat2, params.lng2),
      };
      
    // Health & stats
    case 'health':
      return checkIntegrationHealth();
      
    case 'stats':
      return getIntegrationStats(params.hours);
      
    // Sync jobs
    case 'syncPendingOrders':
      return syncPendingOrdersToOracle();
      
    case 'syncOrderStatuses':
      return syncOrderStatusesFromOracle();
      
    default:
      return { success: false, error: 'Unknown action: ' + action };
  }
}
