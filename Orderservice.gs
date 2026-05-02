/**
 * HASS PETROLEUM CMS - ORDER SERVICE
 * Version: 1.0.0
 * 
 * Handles:
 * - Order lifecycle (draft, submit, approve, dispatch, deliver)
 * - Order lines and pricing
 * - Credit limit checks
 * - Approval workflows
 * - Delivery tracking
 * - Recurring orders
 * - Order history and status changes
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

var ORDER_CONFIG = {
  CREDIT_CHECK_THRESHOLD: 0.9, // 90% credit utilization warning
  MAX_ORDER_LINES: 50,
  DRAFT_EXPIRY_DAYS: 30,
  ORDER_EDIT_CUTOFF_HOURS: 2, // Hours before delivery when edits are locked
};

// Order status flow
var ORDER_STATUS_FLOW = {
  'DRAFT': ['SUBMITTED', 'CANCELLED'],
  'SUBMITTED': ['PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED'],
  'PENDING_APPROVAL': ['APPROVED', 'REJECTED', 'CANCELLED'],
  'APPROVED': ['SCHEDULED', 'CANCELLED'],
  'REJECTED': ['DRAFT'],
  'SCHEDULED': ['LOADING', 'CANCELLED', 'ON_HOLD'],
  'LOADING': ['LOADED', 'CANCELLED'],
  'LOADED': ['IN_TRANSIT', 'CANCELLED'],
  'IN_TRANSIT': ['DELIVERED', 'PARTIALLY_DELIVERED', 'CANCELLED'],
  'DELIVERED': [],
  'PARTIALLY_DELIVERED': [],
  'CANCELLED': [],
  'ON_HOLD': ['SCHEDULED', 'CANCELLED'],
};

// ============================================================================
// ORDER CREATION
// ============================================================================

/**
 * Creates a new order.
 * @param {Object} orderData - Order data
 * @param {Object} context - Actor context
 * @returns {Object} Created order
 */
function createOrder(orderData, context) {
  try {
    // Validate required fields
    if (!orderData.customer_id) {
      return { success: false, error: 'Customer ID is required' };
    }
    
    // Get customer
    const customer = getById('Customers', orderData.customer_id);
    if (!customer) {
      return { success: false, error: 'Customer not found' };
    }
    
    if (customer.status !== 'ACTIVE') {
      return { success: false, error: 'Customer account is not active' };
    }
    
    // Validate delivery location
    if (orderData.delivery_location_id) {
      const location = getById('DeliveryLocations', orderData.delivery_location_id);
      if (!location || location.customer_id !== orderData.customer_id) {
        return { success: false, error: 'Invalid delivery location' };
      }
    }
    
    // Generate IDs
    const orderId = generateId('ORD');
    const countryCode = orderData.country_code || customer.country_code || 'KE';
    const orderNumber = generateOrderNumber(countryCode);
    
    const now = new Date();
    
    // Build order record
    const order = {
      order_id: orderId,
      order_number: orderNumber,
      oracle_order_id: '',
      customer_id: orderData.customer_id,
      contact_id: orderData.contact_id || '',
      delivery_location_id: orderData.delivery_location_id || '',
      source_depot_id: orderData.source_depot_id || '',
      price_list_id: orderData.price_list_id || '',
      requested_date: orderData.requested_date || '',
      requested_time_from: orderData.requested_time_from || '',
      requested_time_to: orderData.requested_time_to || '',
      confirmed_date: '',
      confirmed_time: '',
      status: 'DRAFT',
      payment_status: 'PENDING',
      subtotal: 0,
      tax_amount: 0,
      delivery_fee: orderData.delivery_fee || 0,
      discount_amount: 0,
      total_amount: 0,
      currency_code: customer.currency_code || 'KES',
      special_instructions: orderData.special_instructions || '',
      po_number: orderData.po_number || '',
      is_recurring: orderData.is_recurring || false,
      recurring_schedule_id: orderData.recurring_schedule_id || '',
      created_by_type: context.actorType || 'CUSTOMER',
      created_by_id: context.actorId || '',
      country_code: countryCode,
      created_at: now,
      updated_at: now,
    };
    
    // Insert order
    appendRow('Orders', order);
    clearSheetCache('Orders');
    
    // Add order lines if provided
    if (orderData.lines && orderData.lines.length > 0) {
      const linesResult = addOrderLines(orderId, orderData.lines, context);
      if (!linesResult.success) {
        // Rollback order
        deleteRow('Orders', 'order_id', orderId, true);
        return linesResult;
      }
      
      // Recalculate totals
      recalculateOrderTotals(orderId);
    }
    
    // Log audit
    logAudit('Order', orderId, 'CREATE', context.actorType, context.actorId, context.actorEmail,
      { order_number: orderNumber }, { countryCode: countryCode });
    
    return {
      success: true,
      orderId: orderId,
      orderNumber: orderNumber,
      status: 'DRAFT',
    };
    
  } catch (e) {
    Logger.log('createOrder error: ' + e.message);
    return { success: false, error: 'Failed to create order' };
  }
}

/**
 * Creates an order from a recurring schedule.
 * @param {string} scheduleId - Recurring schedule ID
 * @returns {Object} Created order
 */
function createOrderFromSchedule(scheduleId) {
  try {
    const schedule = getById('RecurringSchedule', scheduleId);
    if (!schedule || !schedule.is_active) {
      return { success: false, error: 'Schedule not found or inactive' };
    }
    
    // Get schedule lines
    const lines = findWhere('RecurringScheduleLines', { schedule_id: scheduleId }).data || [];
    if (lines.length === 0) {
      return { success: false, error: 'Schedule has no product lines' };
    }
    
    // Calculate next delivery date
    const deliveryDate = schedule.next_order_date || new Date();
    
    // Create order
    const orderResult = createOrder({
      customer_id: schedule.customer_id,
      delivery_location_id: schedule.delivery_location_id,
      requested_date: deliveryDate,
      requested_time_from: schedule.preferred_time_from,
      requested_time_to: schedule.preferred_time_to,
      special_instructions: schedule.special_instructions,
      is_recurring: true,
      recurring_schedule_id: scheduleId,
      lines: lines.map(line => ({
        product_id: line.product_id,
        quantity: line.quantity,
      })),
    }, { actorType: 'SYSTEM', actorId: 'RECURRING_SCHEDULER', actorEmail: '' });
    
    if (orderResult.success) {
      // Auto-submit if configured
      if (schedule.auto_submit) {
        submitOrder(orderResult.orderId, { 
          actorType: 'SYSTEM', 
          actorId: 'RECURRING_SCHEDULER', 
          actorEmail: '' 
        });
      }
      
      // Update next order date
      const nextDate = calculateNextOrderDate(schedule);
      updateRow('RecurringSchedule', 'schedule_id', scheduleId, {
        next_order_date: nextDate,
      });
    }
    
    return orderResult;
    
  } catch (e) {
    Logger.log('createOrderFromSchedule error: ' + e.message);
    return { success: false, error: 'Failed to create order from schedule' };
  }
}

// ============================================================================
// ORDER LINES
// ============================================================================

/**
 * Adds lines to an order.
 * @param {string} orderId - Order ID
 * @param {Object[]} lines - Array of line items
 * @param {Object} context - Actor context
 * @returns {Object} Result
 */
function addOrderLines(orderId, lines, context) {
  try {
    const order = getById('Orders', orderId);
    if (!order) {
      return { success: false, error: 'Order not found' };
    }
    
    if (!['DRAFT', 'SUBMITTED'].includes(order.status)) {
      return { success: false, error: 'Cannot modify order in current status' };
    }
    
    // Get existing line count
    const existingCount = countWhere('OrderLines', { order_id: orderId });
    if (existingCount + lines.length > ORDER_CONFIG.MAX_ORDER_LINES) {
      return { success: false, error: `Maximum ${ORDER_CONFIG.MAX_ORDER_LINES} lines per order` };
    }
    
    // Get price list
    const priceList = order.price_list_id ? getById('PriceList', order.price_list_id) : null;
    const priceListItems = priceList ? 
      findWhere('PriceListItems', { price_list_id: order.price_list_id }).data : [];
    
    // Get products
    const products = getAllProducts();
    const productMap = new Map(products.map(p => [p.product_id, p]));
    
    const now = new Date();
    const createdLines = [];
    
    for (const line of lines) {
      if (!line.product_id || !line.quantity || line.quantity <= 0) {
        continue;
      }
      
      const product = productMap.get(line.product_id);
      if (!product || !product.is_active) {
        return { success: false, error: `Invalid product: ${line.product_id}` };
      }
      
      // Get price
      let unitPrice = line.unit_price;
      if (!unitPrice) {
        const priceItem = priceListItems.find(p => 
          p.product_id === line.product_id && 
          (!p.depot_id || p.depot_id === order.source_depot_id)
        );
        unitPrice = priceItem ? priceItem.unit_price : 0;
      }
      
      // Calculate line totals
      const quantity = parseFloat(line.quantity);
      const discountPercent = parseFloat(line.discount_percent) || 0;
      const taxRate = parseFloat(line.tax_rate) || 16; // Default 16% VAT
      
      const lineSubtotal = quantity * unitPrice * (1 - discountPercent / 100);
      const lineTax = lineSubtotal * (taxRate / 100);
      const lineTotal = lineSubtotal + lineTax;
      
      const lineId = generateId('OL');
      
      const orderLine = {
        line_id: lineId,
        order_id: orderId,
        product_id: line.product_id,
        product_name: product.name,
        quantity: quantity,
        unit_of_measure: product.unit_of_measure || 'LITERS',
        unit_price: unitPrice,
        discount_percent: discountPercent,
        tax_rate: taxRate,
        line_subtotal: lineSubtotal,
        line_tax: lineTax,
        line_total: lineTotal,
        delivered_quantity: 0,
        delivery_variance_reason: '',
        created_at: now,
      };
      
      appendRow('OrderLines', orderLine);
      createdLines.push(orderLine);
    }
    
    // Recalculate order totals
    recalculateOrderTotals(orderId);
    
    clearSheetCache('OrderLines');
    
    return {
      success: true,
      linesAdded: createdLines.length,
    };
    
  } catch (e) {
    Logger.log('addOrderLines error: ' + e.message);
    return { success: false, error: 'Failed to add order lines' };
  }
}

/**
 * Updates an order line.
 * @param {string} lineId - Line ID
 * @param {Object} updates - Updates
 * @param {Object} context - Actor context
 * @returns {Object} Result
 */
function updateOrderLine(lineId, updates, context) {
  try {
    const line = getById('OrderLines', lineId);
    if (!line) {
      return { success: false, error: 'Order line not found' };
    }
    
    const order = getById('Orders', line.order_id);
    if (!['DRAFT', 'SUBMITTED'].includes(order.status)) {
      return { success: false, error: 'Cannot modify order in current status' };
    }
    
    // Recalculate if quantity or price changed
    if (updates.quantity !== undefined || updates.unit_price !== undefined) {
      const quantity = parseFloat(updates.quantity || line.quantity);
      const unitPrice = parseFloat(updates.unit_price || line.unit_price);
      const discountPercent = parseFloat(updates.discount_percent || line.discount_percent);
      const taxRate = parseFloat(updates.tax_rate || line.tax_rate);
      
      updates.line_subtotal = quantity * unitPrice * (1 - discountPercent / 100);
      updates.line_tax = updates.line_subtotal * (taxRate / 100);
      updates.line_total = updates.line_subtotal + updates.line_tax;
    }
    
    updateRow('OrderLines', 'line_id', lineId, updates);
    
    // Recalculate order totals
    recalculateOrderTotals(line.order_id);
    
    clearSheetCache('OrderLines');
    
    return { success: true };
    
  } catch (e) {
    Logger.log('updateOrderLine error: ' + e.message);
    return { success: false, error: 'Failed to update order line' };
  }
}

/**
 * Removes an order line.
 * @param {string} lineId - Line ID
 * @param {Object} context - Actor context
 * @returns {Object} Result
 */
function removeOrderLine(lineId, context) {
  try {
    const line = getById('OrderLines', lineId);
    if (!line) {
      return { success: false, error: 'Order line not found' };
    }
    
    const order = getById('Orders', line.order_id);
    if (!['DRAFT', 'SUBMITTED'].includes(order.status)) {
      return { success: false, error: 'Cannot modify order in current status' };
    }
    
    deleteRow('OrderLines', 'line_id', lineId, true);
    
    // Recalculate order totals
    recalculateOrderTotals(line.order_id);
    
    clearSheetCache('OrderLines');
    
    return { success: true };
    
  } catch (e) {
    Logger.log('removeOrderLine error: ' + e.message);
    return { success: false, error: 'Failed to remove order line' };
  }
}

/**
 * Recalculates order totals from lines.
 * @param {string} orderId - Order ID
 */
function recalculateOrderTotals(orderId) {
  const lines = findWhere('OrderLines', { order_id: orderId }).data || [];
  const order = getById('Orders', orderId);
  
  let subtotal = 0;
  let taxAmount = 0;
  
  for (const line of lines) {
    subtotal += parseFloat(line.line_subtotal) || 0;
    taxAmount += parseFloat(line.line_tax) || 0;
  }
  
  const deliveryFee = parseFloat(order.delivery_fee) || 0;
  const discountAmount = parseFloat(order.discount_amount) || 0;
  const totalAmount = subtotal + taxAmount + deliveryFee - discountAmount;
  
  updateRow('Orders', 'order_id', orderId, {
    subtotal: subtotal,
    tax_amount: taxAmount,
    total_amount: totalAmount,
  });
}

// ============================================================================
// ORDER STATUS WORKFLOW
// ============================================================================

/**
 * Updates order status with validation.
 * @param {string} orderId - Order ID
 * @param {string} newStatus - New status
 * @param {Object} context - Actor context
 * @param {Object} additionalData - Additional data for the status change
 * @returns {Object} Result
 */
function updateOrderStatus(orderId, newStatus, context, additionalData = {}) {
  try {
    const order = getById('Orders', orderId);
    if (!order) {
      return { success: false, error: 'Order not found' };
    }
    
    // Validate status transition
    const allowedTransitions = ORDER_STATUS_FLOW[order.status] || [];
    if (!allowedTransitions.includes(newStatus)) {
      return { 
        success: false, 
        error: `Cannot transition from ${order.status} to ${newStatus}` 
      };
    }
    
    const now = new Date();
    const updates = {
      status: newStatus,
      updated_at: now,
      ...additionalData,
    };
    
    // Handle status-specific logic
    switch (newStatus) {
      case 'SUBMITTED':
        updates.submitted_at = now;
        break;
        
      case 'APPROVED':
        updates.approved_at = now;
        updates.approved_by = context.actorId;
        break;
        
      case 'LOADING':
        updates.loading_started_at = now;
        break;
        
      case 'LOADED':
        updates.loaded_at = now;
        break;
        
      case 'IN_TRANSIT':
        updates.dispatched_at = now;
        break;
        
      case 'DELIVERED':
      case 'PARTIALLY_DELIVERED':
        updates.delivered_at = now;
        updates.delivery_confirmed_by = additionalData.delivery_confirmed_by || '';
        break;
        
      case 'CANCELLED':
        updates.cancelled_at = now;
        updates.cancelled_by = context.actorId;
        updates.cancelled_reason = additionalData.reason || '';
        break;
    }
    
    // Update order
    updateRow('Orders', 'order_id', orderId, updates);
    
    // Record status history
    recordOrderStatusHistory(orderId, order.status, newStatus, context, additionalData);
    
    // Clear cache
    clearSheetCache('Orders');
    
    // Log audit
    logAudit('Order', orderId, 'STATUS_CHANGE', context.actorType, context.actorId, context.actorEmail,
      { from_status: order.status, to_status: newStatus },
      { countryCode: order.country_code });
    
    return {
      success: true,
      previousStatus: order.status,
      newStatus: newStatus,
    };
    
  } catch (e) {
    Logger.log('updateOrderStatus error: ' + e.message);
    return { success: false, error: 'Failed to update order status' };
  }
}

/**
 * Records order status change history.
 * @param {string} orderId - Order ID
 * @param {string} fromStatus - Previous status
 * @param {string} toStatus - New status
 * @param {Object} context - Actor context
 * @param {Object} additionalData - Additional data
 */
function recordOrderStatusHistory(orderId, fromStatus, toStatus, context, additionalData = {}) {
  try {
    appendRow('OrderStatusHistory', {
      history_id: generateId('OSH'),
      order_id: orderId,
      from_status: fromStatus,
      to_status: toStatus,
      changed_by_type: context.actorType || 'SYSTEM',
      changed_by_id: context.actorId || '',
      changed_by_name: context.actorName || '',
      notes: additionalData.notes || '',
      gps_lat: additionalData.gps_lat || '',
      gps_lng: additionalData.gps_lng || '',
      created_at: new Date(),
    });
  } catch (e) {
    Logger.log('recordOrderStatusHistory error: ' + e.message);
  }
}

/**
 * Submits a draft order.
 * @param {string} orderId - Order ID
 * @param {Object} context - Actor context
 * @returns {Object} Result
 */
function submitOrder(orderId, context) {
  const order = getById('Orders', orderId);
  if (!order) {
    return { success: false, error: 'Order not found' };
  }
  
  if (order.status !== 'DRAFT') {
    return { success: false, error: 'Order is not in draft status' };
  }
  
  // Validate order has lines
  const lineCount = countWhere('OrderLines', { order_id: orderId });
  if (lineCount === 0) {
    return { success: false, error: 'Order must have at least one line item' };
  }
  
  // Validate delivery location
  if (!order.delivery_location_id) {
    return { success: false, error: 'Delivery location is required' };
  }
  
  // Check credit
  const creditCheck = checkCreditLimit(order.customer_id, order.total_amount);
  if (!creditCheck.approved) {
    // Requires approval
    return updateOrderStatus(orderId, 'PENDING_APPROVAL', context, {
      approval_reason: creditCheck.reason,
    });
  }
  
  // Auto-approve if within credit
  return updateOrderStatus(orderId, 'APPROVED', context);
}

/**
 * Approves an order.
 * @param {string} orderId - Order ID
 * @param {Object} context - Actor context
 * @returns {Object} Result
 */
function approveOrder(orderId, context) {
  const order = getById('Orders', orderId);
  if (!order) {
    return { success: false, error: 'Order not found' };
  }
  
  if (!['SUBMITTED', 'PENDING_APPROVAL'].includes(order.status)) {
    return { success: false, error: 'Order cannot be approved in current status' };
  }
  
  // Check approver has permission
  const user = getById('Users', context.actorId);
  if (!user || !user.can_approve_orders) {
    return { success: false, error: 'You do not have permission to approve orders' };
  }
  
  // Check approval limit
  if (user.approval_limit && order.total_amount > user.approval_limit) {
    return { success: false, error: `Order exceeds your approval limit of ${user.approval_limit}` };
  }
  
  // Update credit used
  const customer = getById('Customers', order.customer_id);
  if (customer && order.payment_status !== 'PREPAID') {
    updateRow('Customers', 'customer_id', order.customer_id, {
      credit_used: (customer.credit_used || 0) + order.total_amount,
    });
    clearSheetCache('Customers');
  }
  
  return updateOrderStatus(orderId, 'APPROVED', context);
}

/**
 * Rejects an order.
 * @param {string} orderId - Order ID
 * @param {string} reason - Rejection reason
 * @param {Object} context - Actor context
 * @returns {Object} Result
 */
function rejectOrder(orderId, reason, context) {
  const order = getById('Orders', orderId);
  if (!order) {
    return { success: false, error: 'Order not found' };
  }
  
  if (!['SUBMITTED', 'PENDING_APPROVAL'].includes(order.status)) {
    return { success: false, error: 'Order cannot be rejected in current status' };
  }
  
  return updateOrderStatus(orderId, 'REJECTED', context, {
    rejection_reason: reason,
  });
}

/**
 * Cancels an order.
 * @param {string} orderId - Order ID
 * @param {string} reason - Cancellation reason
 * @param {Object} context - Actor context
 * @returns {Object} Result
 */
function cancelOrder(orderId, reason, context) {
  const order = getById('Orders', orderId);
  if (!order) {
    return { success: false, error: 'Order not found' };
  }
  
  // Check if cancellation is allowed
  if (['DELIVERED', 'PARTIALLY_DELIVERED', 'CANCELLED'].includes(order.status)) {
    return { success: false, error: 'Order cannot be cancelled' };
  }
  
  // If order was approved, release credit
  if (['APPROVED', 'SCHEDULED', 'LOADING', 'LOADED', 'IN_TRANSIT'].includes(order.status)) {
    const customer = getById('Customers', order.customer_id);
    if (customer && order.payment_status !== 'PREPAID') {
      const newCreditUsed = Math.max(0, (customer.credit_used || 0) - order.total_amount);
      updateRow('Customers', 'customer_id', order.customer_id, {
        credit_used: newCreditUsed,
      });
      clearSheetCache('Customers');
    }
  }
  
  return updateOrderStatus(orderId, 'CANCELLED', context, {
    reason: reason,
  });
}

// ============================================================================
// DELIVERY MANAGEMENT
// ============================================================================

/**
 * Schedules an order for delivery.
 * @param {string} orderId - Order ID
 * @param {Object} scheduleData - { confirmedDate, confirmedTime, vehicleId, driverId, depotId }
 * @param {Object} context - Actor context
 * @returns {Object} Result
 */
function scheduleDelivery(orderId, scheduleData, context) {
  const order = getById('Orders', orderId);
  if (!order) {
    return { success: false, error: 'Order not found' };
  }
  
  if (order.status !== 'APPROVED') {
    return { success: false, error: 'Order must be approved before scheduling' };
  }
  
  const updates = {
    confirmed_date: scheduleData.confirmedDate || order.requested_date,
    confirmed_time: scheduleData.confirmedTime || '',
    source_depot_id: scheduleData.depotId || order.source_depot_id,
    vehicle_id: scheduleData.vehicleId || '',
    driver_id: scheduleData.driverId || '',
  };
  
  // Validate vehicle if assigned
  if (updates.vehicle_id) {
    const vehicle = getById('Vehicles', updates.vehicle_id);
    if (!vehicle || vehicle.status !== 'AVAILABLE') {
      return { success: false, error: 'Selected vehicle is not available' };
    }
  }
  
  // Validate driver if assigned
  if (updates.driver_id) {
    const driver = getById('Drivers', updates.driver_id);
    if (!driver || driver.status !== 'AVAILABLE') {
      return { success: false, error: 'Selected driver is not available' };
    }
  }
  
  // Update order with schedule info
  updateRow('Orders', 'order_id', orderId, updates);
  
  return updateOrderStatus(orderId, 'SCHEDULED', context, {
    notes: `Scheduled for ${scheduleData.confirmedDate}`,
  });
}

/**
 * Marks order as loading started.
 * @param {string} orderId - Order ID
 * @param {Object} context - Actor context
 * @returns {Object} Result
 */
function startLoading(orderId, context) {
  return updateOrderStatus(orderId, 'LOADING', context);
}

/**
 * Marks order as loaded and ready for dispatch.
 * @param {string} orderId - Order ID
 * @param {Object} loadData - Loading details
 * @param {Object} context - Actor context
 * @returns {Object} Result
 */
function completeLoading(orderId, loadData, context) {
  const order = getById('Orders', orderId);
  if (!order) {
    return { success: false, error: 'Order not found' };
  }
  
  // Update vehicle and driver if not already assigned
  if (loadData.vehicleId || loadData.driverId) {
    updateRow('Orders', 'order_id', orderId, {
      vehicle_id: loadData.vehicleId || order.vehicle_id,
      driver_id: loadData.driverId || order.driver_id,
    });
    
    // Update vehicle status
    if (loadData.vehicleId) {
      updateRow('Vehicles', 'vehicle_id', loadData.vehicleId, { status: 'IN_TRANSIT' });
    }
    
    // Update driver status
    if (loadData.driverId) {
      updateRow('Drivers', 'driver_id', loadData.driverId, { status: 'ON_DELIVERY' });
    }
  }
  
  return updateOrderStatus(orderId, 'LOADED', context, {
    notes: loadData.notes || '',
  });
}

/**
 * Marks order as dispatched/in transit.
 * @param {string} orderId - Order ID
 * @param {Object} dispatchData - Dispatch details with GPS
 * @param {Object} context - Actor context
 * @returns {Object} Result
 */
function dispatchOrder(orderId, dispatchData, context) {
  return updateOrderStatus(orderId, 'IN_TRANSIT', context, {
    gps_lat: dispatchData.gps_lat || '',
    gps_lng: dispatchData.gps_lng || '',
    notes: dispatchData.notes || '',
  });
}

/**
 * Confirms order delivery.
 * @param {string} orderId - Order ID
 * @param {Object} deliveryData - Delivery confirmation data
 * @param {Object} context - Actor context
 * @returns {Object} Result
 */
function confirmDelivery(orderId, deliveryData, context) {
  try {
    const order = getById('Orders', orderId);
    if (!order) {
      return { success: false, error: 'Order not found' };
    }
    
    if (order.status !== 'IN_TRANSIT') {
      return { success: false, error: 'Order is not in transit' };
    }
    
    // Get order lines
    const lines = findWhere('OrderLines', { order_id: orderId }).data || [];

    // Build batch update map - one batchUpdateRows() call instead of N updateRow() calls.
    let isPartial = false;
    const lineUpdatesMap = {};

    if (deliveryData.deliveredQuantities) {
      for (const line of lines) {
        const delivered = deliveryData.deliveredQuantities[line.line_id];
        if (delivered !== undefined) {
          lineUpdatesMap[line.line_id] = {
            delivered_quantity: delivered,
            delivery_variance_reason: delivered < line.quantity
              ? (deliveryData.varianceReasons && deliveryData.varianceReasons[line.line_id]
                  ? deliveryData.varianceReasons[line.line_id]
                  : 'Partial delivery')
              : '',
          };
          if (delivered < line.quantity) isPartial = true;
        } else {
          lineUpdatesMap[line.line_id] = { delivered_quantity: line.quantity };
        }
      }
    } else {
      for (const line of lines) {
        lineUpdatesMap[line.line_id] = { delivered_quantity: line.quantity };
      }
    }

    if (Object.keys(lineUpdatesMap).length > 0) {
      batchUpdateRows('OrderLines', 'line_id', lineUpdatesMap);
    }
    
    const newStatus = isPartial ? 'PARTIALLY_DELIVERED' : 'DELIVERED';
    
    // Update order
    updateRow('Orders', 'order_id', orderId, {
      delivery_notes: deliveryData.notes || '',
      delivery_confirmed_by: deliveryData.confirmedBy || '',
    });
    
    // Release vehicle and driver
    if (order.vehicle_id) {
      updateRow('Vehicles', 'vehicle_id', order.vehicle_id, { status: 'AVAILABLE' });
    }
    if (order.driver_id) {
      updateRow('Drivers', 'driver_id', order.driver_id, { status: 'AVAILABLE' });
    }
    
    // Update payment status if prepaid or COD
    if (order.payment_status === 'PENDING') {
      updateRow('Orders', 'order_id', orderId, { payment_status: 'INVOICED' });
    }
    
    clearSheetCache('OrderLines');
    clearSheetCache('Vehicles');
    clearSheetCache('Drivers');
    
    return updateOrderStatus(orderId, newStatus, context, {
      delivery_confirmed_by: deliveryData.confirmedBy || '',
      gps_lat: deliveryData.gps_lat || '',
      gps_lng: deliveryData.gps_lng || '',
      notes: deliveryData.notes || '',
    });
    
  } catch (e) {
    Logger.log('confirmDelivery error: ' + e.message);
    return { success: false, error: 'Failed to confirm delivery' };
  }
}

// ============================================================================
// CREDIT MANAGEMENT
// ============================================================================

/**
 * Checks if order is within customer's credit limit.
 * @param {string} customerId - Customer ID
 * @param {number} orderAmount - Order total
 * @returns {Object} { approved, reason }
 */
function checkCreditLimit(customerId, orderAmount) {
  const customer = getById('Customers', customerId);
  if (!customer) {
    return { approved: false, reason: 'Customer not found' };
  }
  
  const creditLimit = parseFloat(customer.credit_limit) || 0;
  const creditUsed = parseFloat(customer.credit_used) || 0;
  const availableCredit = creditLimit - creditUsed;
  
  // No credit limit set - requires approval
  if (creditLimit === 0) {
    return { approved: false, reason: 'No credit limit set' };
  }
  
  // Check if order is within available credit
  if (orderAmount > availableCredit) {
    return { 
      approved: false, 
      reason: `Order exceeds available credit. Available: ${availableCredit}, Order: ${orderAmount}`,
      availableCredit: availableCredit,
      shortfall: orderAmount - availableCredit,
    };
  }
  
  // Check credit utilization warning threshold
  const newUtilization = (creditUsed + orderAmount) / creditLimit;
  if (newUtilization > ORDER_CONFIG.CREDIT_CHECK_THRESHOLD) {
    return {
      approved: true,
      warning: `Credit utilization will be ${Math.round(newUtilization * 100)}%`,
      availableCredit: availableCredit - orderAmount,
    };
  }
  
  return { 
    approved: true,
    availableCredit: availableCredit - orderAmount,
  };
}

/**
 * Gets customer's credit summary.
 * @param {string} customerId - Customer ID
 * @returns {Object} Credit summary
 */
function getCustomerCreditSummary(customerId) {
  const customer = getById('Customers', customerId);
  if (!customer) {
    return { success: false, error: 'Customer not found' };
  }
  
  const creditLimit = parseFloat(customer.credit_limit) || 0;
  const creditUsed = parseFloat(customer.credit_used) || 0;
  const availableCredit = creditLimit - creditUsed;
  const utilization = creditLimit > 0 ? (creditUsed / creditLimit) * 100 : 0;
  
  // Get pending orders (approved but not delivered)
  const pendingOrders = findWhere('Orders', {
    customer_id: customerId,
    status: ['APPROVED', 'SCHEDULED', 'LOADING', 'LOADED', 'IN_TRANSIT'],
  }).data || [];
  
  const pendingAmount = pendingOrders.reduce((sum, o) => sum + (parseFloat(o.total_amount) || 0), 0);
  
  // Get overdue invoices count
  // This would integrate with finance/invoicing system
  
  return {
    success: true,
    creditLimit: creditLimit,
    creditUsed: creditUsed,
    availableCredit: availableCredit,
    utilization: Math.round(utilization * 100) / 100,
    pendingOrdersCount: pendingOrders.length,
    pendingOrdersAmount: pendingAmount,
    paymentTerms: customer.payment_terms || '',
  };
}

// ============================================================================
// RECURRING ORDERS
// ============================================================================

/**
 * Creates a recurring order schedule.
 * @param {Object} scheduleData - Schedule configuration
 * @param {Object} context - Actor context
 * @returns {Object} Created schedule
 */
function createRecurringSchedule(scheduleData, context) {
  try {
    if (!scheduleData.customer_id) {
      return { success: false, error: 'Customer ID is required' };
    }
    
    if (!scheduleData.frequency) {
      return { success: false, error: 'Frequency is required' };
    }
    
    if (!scheduleData.lines || scheduleData.lines.length === 0) {
      return { success: false, error: 'At least one product line is required' };
    }
    
    const scheduleId = generateId('RS');
    const now = new Date();
    
    const schedule = {
      schedule_id: scheduleId,
      customer_id: scheduleData.customer_id,
      name: scheduleData.name || 'Recurring Order',
      delivery_location_id: scheduleData.delivery_location_id || '',
      frequency: scheduleData.frequency,
      frequency_interval: scheduleData.frequency_interval || 1,
      day_of_week: scheduleData.day_of_week || '',
      day_of_month: scheduleData.day_of_month || '',
      preferred_time_from: scheduleData.preferred_time_from || '',
      preferred_time_to: scheduleData.preferred_time_to || '',
      start_date: scheduleData.start_date || now,
      end_date: scheduleData.end_date || '',
      next_order_date: calculateNextOrderDate(scheduleData),
      is_active: true,
      auto_submit: scheduleData.auto_submit || false,
      special_instructions: scheduleData.special_instructions || '',
      created_by: context.actorId || '',
      created_at: now,
      updated_at: now,
    };
    
    appendRow('RecurringSchedule', schedule);
    
    // Add schedule lines
    for (const line of scheduleData.lines) {
      appendRow('RecurringScheduleLines', {
        line_id: generateId('RSL'),
        schedule_id: scheduleId,
        product_id: line.product_id,
        quantity: line.quantity,
        created_at: now,
      });
    }
    
    clearSheetCache('RecurringSchedule');
    clearSheetCache('RecurringScheduleLines');
    
    return {
      success: true,
      scheduleId: scheduleId,
      nextOrderDate: schedule.next_order_date,
    };
    
  } catch (e) {
    Logger.log('createRecurringSchedule error: ' + e.message);
    return { success: false, error: 'Failed to create recurring schedule' };
  }
}

/**
 * Calculates next order date based on schedule.
 * @param {Object} schedule - Schedule configuration
 * @returns {Date} Next order date
 */
function calculateNextOrderDate(schedule) {
  const now = new Date();
  let nextDate = schedule.start_date ? new Date(schedule.start_date) : now;
  
  if (nextDate < now) {
    nextDate = now;
  }
  
  const interval = schedule.frequency_interval || 1;
  
  switch (schedule.frequency) {
    case 'DAILY':
      nextDate.setDate(nextDate.getDate() + interval);
      break;
      
    case 'WEEKLY':
      nextDate.setDate(nextDate.getDate() + (7 * interval));
      if (schedule.day_of_week !== undefined) {
        // Adjust to specific day of week
        const targetDay = parseInt(schedule.day_of_week);
        while (nextDate.getDay() !== targetDay) {
          nextDate.setDate(nextDate.getDate() + 1);
        }
      }
      break;
      
    case 'BIWEEKLY':
      nextDate.setDate(nextDate.getDate() + 14);
      break;
      
    case 'MONTHLY':
      nextDate.setMonth(nextDate.getMonth() + interval);
      if (schedule.day_of_month) {
        nextDate.setDate(Math.min(parseInt(schedule.day_of_month), daysInMonth(nextDate)));
      }
      break;
      
    default:
      nextDate.setDate(nextDate.getDate() + interval);
  }
  
  return nextDate;
}

/**
 * Gets days in a month.
 * @param {Date} date - Date
 * @returns {number} Days in month
 */
function daysInMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

/**
 * Processes due recurring schedules.
 * Run via daily trigger.
 */
function processRecurringSchedules() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return { success: false, error: 'Could not obtain lock' };
  }
  
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    // Find schedules due for processing
    const schedules = findWhere('RecurringSchedule', { is_active: true }).data || [];
    
    let processedCount = 0;
    
    for (const schedule of schedules) {
      const nextOrderDate = new Date(schedule.next_order_date);
      nextOrderDate.setHours(0, 0, 0, 0);
      
      if (nextOrderDate <= today) {
        // Check end date
        if (schedule.end_date && new Date(schedule.end_date) < today) {
          // Deactivate expired schedule
          updateRow('RecurringSchedule', 'schedule_id', schedule.schedule_id, {
            is_active: false,
          });
          continue;
        }
        
        // Create order
        const result = createOrderFromSchedule(schedule.schedule_id);
        if (result.success) {
          processedCount++;
        } else {
          Logger.log(`Failed to create order for schedule ${schedule.schedule_id}: ${result.error}`);
        }
      }
    }
    
    clearSheetCache('RecurringSchedule');
    
    return {
      success: true,
      processedCount: processedCount,
    };
    
  } catch (e) {
    Logger.log('processRecurringSchedules error: ' + e.message);
    return { success: false, error: e.message };
  } finally {
    lock.releaseLock();
  }
}

// ============================================================================
// ORDER QUERIES
// ============================================================================

/**
 * Gets orders for a customer.
 * @param {string} customerId - Customer ID
 * @param {Object} options - Query options
 * @returns {Object} Orders list
 */
function getCustomerOrders(customerId, options = {}) {
  const conditions = { customer_id: customerId };
  
  if (options.status) {
    conditions.status = options.status;
  }
  
  return findWhere('Orders', conditions, {
    sortBy: options.sortBy || 'created_at',
    sortOrder: options.sortOrder || 'desc',
    limit: options.limit || 50,
    offset: options.offset || 0,
  });
}

/**
 * Gets open orders for delivery management.
 * @param {string} countryCode - Country code filter
 * @param {Object} options - Query options
 * @returns {Object} Orders list
 */
function getOpenOrders(countryCode, options = {}) {
  const conditions = {
    status: ['APPROVED', 'SCHEDULED', 'LOADING', 'LOADED', 'IN_TRANSIT'],
  };
  
  if (countryCode) {
    conditions.country_code = countryCode;
  }
  
  return findWhere('Orders', conditions, {
    sortBy: options.sortBy || 'requested_date',
    sortOrder: options.sortOrder || 'asc',
    limit: options.limit || 100,
  });
}

/**
 * Gets orders pending approval.
 * @param {string} countryCode - Country code filter
 * @returns {Object} Orders list
 */
function getOrdersPendingApproval(countryCode) {
  const conditions = { status: 'PENDING_APPROVAL' };
  
  if (countryCode) {
    conditions.country_code = countryCode;
  }
  
  return findWhere('Orders', conditions, {
    sortBy: 'created_at',
    sortOrder: 'asc',
    limit: 100,
  });
}

// ============================================================================
// WEB APP HANDLER
// ============================================================================

/**
 * Lists orders with optional filtering, sorting, and limit.
 * @param {Object} conditions - Filter conditions: status, country_code, customer_id
 * @param {Object} options - sortBy, sortOrder, limit
 * @returns {Object} { success, data, total }
 */
function listOrders(conditions, options) {
  try {
    conditions = conditions || {};
    options = options || {};
    var allOrders = getSheetData('Orders') || [];
    var filtered = allOrders;

    if (conditions.status) {
      var statuses = Array.isArray(conditions.status) ? conditions.status : [conditions.status];
      statuses = statuses.map(function(s) { return String(s || '').toUpperCase(); });
      filtered = filtered.filter(function(o) { return statuses.indexOf(String(o.status||'').toUpperCase()) > -1; });
    }
    if (conditions.country_code) {
      filtered = filtered.filter(function(o) { return String(o.country_code||'') === conditions.country_code; });
    }
    if (conditions.customer_id) {
      filtered = filtered.filter(function(o) { return String(o.customer_id||'') === conditions.customer_id; });
    }

    var sortBy = options.sortBy || 'created_at';
    var sortOrder = options.sortOrder || 'desc';
    filtered.sort(function(a, b) {
      var av = a[sortBy] ? new Date(a[sortBy]).getTime() : 0;
      var bv = b[sortBy] ? new Date(b[sortBy]).getTime() : 0;
      return sortOrder === 'asc' ? av - bv : bv - av;
    });

    var limit = parseInt(options.limit) || 200;
    filtered = filtered.slice(0, limit);

    return { success: true, data: filtered, total: filtered.length };
  } catch (e) {
    Logger.log('listOrders error: ' + e.message);
    return { success: false, error: e.message, data: [] };
  }
}

/**
 * Handles order API requests.
 * @param {Object} params - Request parameters
 * @returns {Object} Response
 */
function handleOrderRequest(params) {
  const action = params.action;
  
  switch (action) {
    case 'create':
      return createOrder(params.data, params.context);
      
    case 'get':
      return getOrderDetail(params.orderId);
      
    case 'update':
      return updateRecord('Orders', params.orderId, params.data, params.context);
      
    case 'addLines':
      return addOrderLines(params.orderId, params.lines, params.context);
      
    case 'updateLine':
      return updateOrderLine(params.lineId, params.data, params.context);
      
    case 'removeLine':
      return removeOrderLine(params.lineId, params.context);
      
    case 'submit':
      return submitOrder(params.orderId, params.context);
      
    case 'approve':
      return approveOrder(params.orderId, params.context);
      
    case 'reject':
      return rejectOrder(params.orderId, params.reason, params.context);
      
    case 'cancel':
      return cancelOrder(params.orderId, params.reason, params.context);
      
    case 'schedule':
      return scheduleDelivery(params.orderId, params.scheduleData, params.context);
      
    case 'startLoading':
      return startLoading(params.orderId, params.context);
      
    case 'completeLoading':
      return completeLoading(params.orderId, params.loadData, params.context);
      
    case 'dispatch':
      return dispatchOrder(params.orderId, params.dispatchData, params.context);
      
    case 'confirmDelivery':
      return confirmDelivery(params.orderId, params.deliveryData, params.context);
      
    case 'checkCredit':
      return checkCreditLimit(params.customerId, params.amount);
      
    case 'creditSummary':
      return getCustomerCreditSummary(params.customerId);
      
    case 'customerOrders':
      return getCustomerOrders(params.customerId, params.options);
      
    case 'openOrders':
      return getOpenOrders(params.countryCode, params.options);
      
    case 'pendingApproval':
      return getOrdersPendingApproval(params.countryCode);
      
    case 'createRecurring':
      return createRecurringSchedule(params.data, params.context);

    case 'customerConsumption':
      return getCustomerConsumptionAnalytics(params.customerId, params.period);

    case 'getCustomerForChat':
      return getCustomerForChat(params.customerId);

    case 'list':
      return listOrders(params.conditions || {}, params.options || {});

    case 'getLines':
      return getOrderLinesForStaff(params.orderId);

    case 'updateStatus':
      return updateOrderStatus(params.orderId, params.status, params.context || {});

    default:
      return { success: false, error: 'Unknown action: ' + action };
  }
}

/**
 * Returns enriched order lines for the staff portal detail modal.
 * @param {string} orderId
 * @returns {Object} { success, lines }
 */
function getOrderLinesForStaff(orderId) {
  try {
    if (!orderId) return { success: false, error: 'orderId required', lines: [] };
    var res = findWhere('OrderLines', { order_id: orderId }, { sortBy: 'created_at', sortOrder: 'asc' });
    var lines = (res && res.data) ? res.data : [];
    var products = getSheetData('Products') || [];
    var enriched = lines.map(function(line) {
      var product = products.find(function(p) { return p.product_id === line.product_id; });
      return Object.assign({}, line, { product: product || null });
    });
    return { success: true, lines: enriched };
  } catch (e) {
    Logger.log('getOrderLinesForStaff error: ' + e.message);
    return { success: false, error: e.message, lines: [] };
  }
}

// ============================================================================
// CONSUMPTION ANALYTICS
// ============================================================================

/**
 * Converts a period string or object into start and end Date objects.
 * @param {string|Object} period - Period descriptor
 * @returns {Object} { startDate, endDate }
 */
function parsePeriod(period) {
  const now = new Date();
  let startDate;
  let endDate = new Date(now);
  endDate.setHours(23, 59, 59, 999);

  if (typeof period === 'object' && period !== null && period.from) {
    startDate = new Date(period.from + '-01');
    const parts = period.to.split('-');
    endDate = new Date(parseInt(parts[0]), parseInt(parts[1]), 0, 23, 59, 59, 999);
  } else if (period === 'month') {
    startDate = new Date(now.getFullYear(), now.getMonth(), 1);
  } else if (period === 'quarter') {
    const q = Math.floor(now.getMonth() / 3);
    startDate = new Date(now.getFullYear(), q * 3, 1);
  } else if (period === 'year') {
    startDate = new Date(now.getFullYear(), 0, 1);
  } else if (period === 'ytm') {
    startDate = new Date(now.getFullYear(), 0, 1);
    endDate = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
  } else {
    // Default: last 6 months
    startDate = new Date(now.getFullYear(), now.getMonth() - 5, 1);
  }
  return { startDate: startDate, endDate: endDate };
}

/**
 * Aggregates order and order line data for the consumption analytics dashboard.
 * @param {string} customerId - Customer ID
 * @param {string|Object} period - Period descriptor
 * @returns {Object} Consumption analytics payload
 */
function getCustomerConsumptionAnalytics(customerId, period) {
  try {
    const range = parsePeriod(period);
    const startDate = range.startDate;
    const endDate = range.endDate;

    // Pull all orders for this customer in the date range
    const allOrders = getSheetData('Orders');
    const orders = allOrders.filter(function(o) {
      if (o.customer_id !== customerId) return false;
      if (!['DELIVERED', 'IN_TRANSIT', 'APPROVED'].includes(o.status)) return false;
      const created = new Date(o.created_at);
      return created >= startDate && created <= endDate;
    });

    // Build O(1)-lookup map from order_id → order then filter lines in one pass.
    const orderMap = {};
    orders.forEach(function(o) { orderMap[o.order_id] = o; });
    const allLines = getSheetData('OrderLines');
    const lines = allLines.filter(function(l) { return orderMap[l.order_id]; });

    // Build monthly trend map
    const monthMap = {};
    orders.forEach(function(o) {
      const mk = new Date(o.created_at).toISOString().slice(0, 7);
      if (!monthMap[mk]) monthMap[mk] = { month: mk, agoVol: 0, pmsVol: 0, keroVol: 0, spend: 0 };
      monthMap[mk].spend += parseFloat(o.total_amount) || 0;
    });
    lines.forEach(function(l) {
      const order = orderMap[l.order_id];
      if (!order) return;
      const mk = new Date(order.created_at).toISOString().slice(0, 7);
      if (!monthMap[mk]) return;
      const vol = parseFloat(l.quantity) || 0;
      if (l.product_id === 'PROD001') monthMap[mk].agoVol += vol;
      else if (l.product_id === 'PROD002') monthMap[mk].pmsVol += vol;
      else if (l.product_id === 'PROD003') monthMap[mk].keroVol += vol;
    });
    const monthlyTrend = Object.values(monthMap).sort(function(a, b) {
      return a.month.localeCompare(b.month);
    });

    // By product totals
    const byProduct = [
      { product: 'AGO (Diesel)', productId: 'PROD001', volume: 0, spend: 0, pct: 0 },
      { product: 'PMS (Petrol)', productId: 'PROD002', volume: 0, spend: 0, pct: 0 },
      { product: 'Kerosene',     productId: 'PROD003', volume: 0, spend: 0, pct: 0 },
      { product: 'Other',        productId: 'PROD004', volume: 0, spend: 0, pct: 0 }
    ];
    lines.forEach(function(l) {
      const pp = byProduct.find(function(p) { return p.productId === l.product_id; });
      const target = pp || byProduct[3]; // other bucket
      target.volume += parseFloat(l.quantity) || 0;
      target.spend  += parseFloat(l.line_total) || 0;
    });
    const totalVol = byProduct.reduce(function(s, p) { return s + p.volume; }, 0);
    byProduct.forEach(function(p) {
      p.pct = totalVol > 0 ? Math.round(p.volume / totalVol * 100) : 0;
    });

    // By location
    const locMap = {};
    orders.forEach(function(o) {
      const lid = o.delivery_location_id || 'UNKNOWN';
      if (!locMap[lid]) locMap[lid] = { locationId: lid, locationName: lid, orders: 0, volume: 0, spend: 0, lastOrder: '' };
      locMap[lid].orders++;
      locMap[lid].spend += parseFloat(o.total_amount) || 0;
      if (!locMap[lid].lastOrder || o.created_at > locMap[lid].lastOrder) locMap[lid].lastOrder = o.created_at;
    });
    lines.forEach(function(l) {
      const order = orderMap[l.order_id];
      if (!order) return;
      const lid = order.delivery_location_id || 'UNKNOWN';
      if (locMap[lid]) locMap[lid].volume += parseFloat(l.quantity) || 0;
    });
    // Enrich with location names from DeliveryLocations sheet
    const locations = getSheetData('DeliveryLocations');
    Object.values(locMap).forEach(function(loc) {
      var found = locations.find(function(l) { return l.location_id === loc.locationId; });
      if (found) loc.locationName = found.name || found.location_name || loc.locationId;
    });

    // Delivery performance
    const deliveryPerf = orders
      .filter(function(o) { return o.delivered_at && o.submitted_at; })
      .map(function(o) {
        const hrs = (new Date(o.delivered_at) - new Date(o.submitted_at)) / 3600000;
        return {
          orderId: o.order_id,
          orderNumber: o.order_number,
          orderDate: o.created_at,
          deliveredAt: o.delivered_at,
          hoursToDeliver: Math.round(hrs * 10) / 10,
          status: hrs <= 24 ? 'ON_TIME' : hrs <= 48 ? 'SLIGHT_DELAY' : 'DELAYED'
        };
      });

    // KPIs
    const totalSpend = orders.reduce(function(s, o) { return s + (parseFloat(o.total_amount) || 0); }, 0);
    const kpis = {
      totalVolume:  Math.round(totalVol),
      totalSpend:   Math.round(totalSpend),
      orderCount:   orders.length,
      avgOrderSize: orders.length > 0 ? Math.round(totalVol / orders.length) : 0,
      vsLastPeriod: null // future: compute prior period for comparison
    };

    return {
      success:             true,
      period:              period,
      startDate:           startDate.toISOString(),
      endDate:             endDate.toISOString(),
      kpis:                kpis,
      monthlyTrend:        monthlyTrend,
      byProduct:           byProduct,
      byLocation:          Object.values(locMap),
      deliveryPerformance: deliveryPerf
    };

  } catch (e) {
    Logger.log('getCustomerConsumptionAnalytics error: ' + e.message + ' | Stack: ' + e.stack);
    return { success: false, error: e.message };
  }
}

// ============================================================================
// CUSTOMER FOR CHAT
// ============================================================================

/**
 * Returns enriched customer data for the staff chat panel profile card.
 * @param {string} customerId - Customer ID
 * @returns {Object} Customer data with open ticket count and last order date
 */
function getCustomerForChat(customerId) {
  try {
    const customers = getSheetData('Customers');
    const customer = customers.find(function(c) { return c.customer_id === customerId; });
    if (!customer) return { success: false, error: 'Customer not found' };

    // Count open tickets
    const allTickets = getSheetData('Tickets');
    const openStatuses = ['NEW', 'OPEN', 'IN_PROGRESS', 'PENDING_CUSTOMER', 'PENDING_INTERNAL', 'ESCALATED'];
    const openCount = allTickets.filter(function(t) {
      return t.customer_id === customerId && openStatuses.includes(t.status);
    }).length;

    // Get last order date
    const allOrders = getSheetData('Orders');
    const custOrders = allOrders
      .filter(function(o) { return o.customer_id === customerId && o.status === 'DELIVERED'; })
      .sort(function(a, b) { return new Date(b.created_at) - new Date(a.created_at); });
    const lastOrderDate = custOrders.length > 0 ? custOrders[0].created_at : null;

    return {
      success: true,
      customer: {
        customer_id:       customer.customer_id,
        account_number:    customer.account_number,
        company_name:      customer.company_name || customer.trading_name,
        trading_name:      customer.trading_name,
        country_code:      customer.country_code,
        currency:          customer.currency,
        credit_limit:      parseFloat(customer.credit_limit) || 0,
        credit_used:       parseFloat(customer.credit_used) || 0,
        open_tickets_count: openCount,
        last_order_date:   lastOrderDate,
        risk_level:        customer.risk_level,
        account_status:    customer.status
      }
    };
  } catch (e) {
    Logger.log('getCustomerForChat error: ' + e.message);
    return { success: false, error: e.message };
  }
}
