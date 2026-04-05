/**
 * HASS PETROLEUM CMS DATABASE SETUP SCRIPT
 * Version: 1.1.0
 * 
 * Changes from v1.0:
 * - Added RecurringSchedule and RecurringScheduleLines sheets
 * - Added TicketAttachments sheet
 * - Added updated_at to all relevant tables
 * - Increased validation range to 99999 rows (100K capacity)
 * - Added Depots, Vehicles, Drivers sheets
 * - Added BusinessHours, Holidays sheets
 * - Added Knowledge Base sheets
 * - Added Dashboards and Reporting sheets
 * - Uses getDatabase() instead of getActiveSpreadsheet() for web app context
 */

const CONFIG = {
  SPREADSHEET_NAME: 'HASS_CMS_DATABASE',
  FOLDER_NAME: 'Hass CMS',
  MAX_ROWS: 1000000,
  VALIDATION_ROWS: 999999,
};

const SCHEMAS = {
  Countries: {
    headers: ['country_code', 'country_name', 'currency_code', 'currency_symbol', 'timezone', 'phone_code', 'is_active', 'created_at', 'updated_at'],
    seedData: [
      ['KE', 'Kenya', 'KES', 'KSh', 'Africa/Nairobi', '+254', true, new Date(), new Date()],
      ['UG', 'Uganda', 'UGX', 'USh', 'Africa/Kampala', '+256', true, new Date(), new Date()],
      ['TZ', 'Tanzania', 'TZS', 'TSh', 'Africa/Dar_es_Salaam', '+255', true, new Date(), new Date()],
      ['RW', 'Rwanda', 'RWF', 'FRw', 'Africa/Kigali', '+250', true, new Date(), new Date()],
      ['SS', 'South Sudan', 'USD', '$', 'Africa/Juba', '+211', true, new Date(), new Date()],
      ['ZM', 'Zambia', 'ZMW', 'ZK', 'Africa/Lusaka', '+260', true, new Date(), new Date()],
      ['MW', 'Malawi', 'MWK', 'MK', 'Africa/Blantyre', '+265', true, new Date(), new Date()],
      ['CD', 'DRC', 'USD', '$', 'Africa/Kinshasa', '+243', true, new Date(), new Date()],
      ['SO', 'Somalia', 'USD', '$', 'Africa/Mogadishu', '+252', true, new Date(), new Date()],
    ],
    columnWidths: { A: 100, B: 120, C: 100, D: 100, E: 150, F: 100, G: 80, H: 150, I: 150 },
  },

  Segments: {
    headers: ['segment_id', 'name', 'code', 'description', 'sla_multiplier', 'credit_multiplier', 'priority_order', 'color', 'is_active', 'created_at', 'updated_at'],
    seedData: [
      ['SEG001', 'Strategic', 'STRATEGIC', 'Top-tier strategic accounts', 0.5, 1.5, 1, '#D32F2F', true, new Date(), new Date()],
      ['SEG002', 'Enterprise', 'ENTERPRISE', 'Large enterprise customers', 0.75, 1.25, 2, '#1A237E', true, new Date(), new Date()],
      ['SEG003', 'SME', 'SME', 'Small and medium enterprises', 1.0, 1.0, 3, '#FF6F00', true, new Date(), new Date()],
      ['SEG004', 'Retail', 'RETAIL', 'Retail and small business', 1.25, 0.75, 4, '#2E7D32', true, new Date(), new Date()],
      ['SEG005', 'New', 'NEW', 'New customers in onboarding', 1.0, 0.5, 5, '#9C27B0', true, new Date(), new Date()],
      ['SEG006', 'At Risk', 'AT_RISK', 'Customers at risk of churn', 0.75, 1.0, 6, '#C62828', true, new Date(), new Date()],
    ],
    columnWidths: { A: 100, B: 100, C: 100, D: 250, E: 100, F: 120, G: 100, H: 80, I: 80, J: 150, K: 150 },
  },

  Customers: {
    headers: [
      'customer_id', 'account_number', 'company_name', 'trading_name', 'customer_type',
      'segment_id', 'country_code', 'currency_code', 'credit_limit', 'credit_used',
      'payment_terms', 'tax_pin', 'registration_number', 'industry', 'website',
      'status', 'onboarding_status', 'risk_score', 'risk_level', 'lifetime_value',
      'relationship_owner_id', 'parent_customer_id', 'source', 'notes',
      'created_by', 'created_at', 'updated_at'
    ],
    validations: {
      customer_type: ['B2B', 'B2C', 'GOVERNMENT', 'NGO', 'PARASTATAL'],
      country_code: ['KE', 'UG', 'TZ', 'RW', 'SS', 'ZM', 'MW', 'CD', 'SO'],
      currency_code: ['KES', 'UGX', 'TZS', 'RWF', 'USD', 'ZMW', 'MWK'],
      status: ['ACTIVE', 'SUSPENDED', 'ON_HOLD', 'CLOSED', 'PENDING_APPROVAL'],
      onboarding_status: ['DRAFT', 'PENDING_KYC', 'KYC_REVIEW', 'APPROVED', 'REJECTED'],
      risk_level: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
      source: ['DIRECT', 'REFERRAL', 'TENDER', 'WEBSITE', 'AGENT', 'OTHER'],
    },
    columnWidths: { A: 120, B: 130, C: 200, D: 150, E: 100, F: 100, G: 100, H: 100, I: 100, J: 100, K: 100, L: 120, M: 140, N: 120, O: 150, P: 120, Q: 130, R: 80, S: 80, T: 100, U: 140, V: 140, W: 80, X: 200, Y: 120, Z: 150, AA: 150 },
  },

  Contacts: {
    headers: [
      'contact_id', 'customer_id', 'first_name', 'last_name', 'email', 'phone',
      'phone_alt', 'job_title', 'department', 'contact_type', 'is_decision_maker',
      'is_portal_user', 'portal_role', 'password_hash', 'auth_provider', 'auth_uid',
      'mfa_enabled', 'mfa_secret', 'notification_email', 'notification_sms',
      'notification_whatsapp', 'notification_push', 'preferred_language',
      'last_login', 'failed_login_attempts', 'locked_until', 'password_reset_token',
      'password_reset_expires', 'status', 'created_at', 'updated_at'
    ],
    validations: {
      contact_type: ['PRIMARY', 'BILLING', 'OPERATIONS', 'ESCALATION', 'TECHNICAL'],
      portal_role: ['OWNER', 'ADMIN', 'USER', 'VIEWER'],
      auth_provider: ['EMAIL', 'GOOGLE', 'MICROSOFT', 'SSO'],
      status: ['ACTIVE', 'INACTIVE', 'LOCKED'],
      preferred_language: ['en', 'sw', 'fr'],
    },
    columnWidths: { A: 120, B: 120, C: 100, D: 100, E: 180, F: 120, G: 120, H: 120, I: 100, J: 100, K: 100, L: 100, M: 100, N: 150, O: 100, P: 120, Q: 100, R: 120, S: 120, T: 120, U: 140, V: 120, W: 120, X: 150, Y: 130, Z: 150, AA: 150, AB: 150, AC: 80, AD: 150, AE: 150 },
  },

  Users: {
    headers: [
      'user_id', 'employee_id', 'email', 'first_name', 'last_name', 'phone',
      'avatar_url', 'role', 'department', 'country_code', 'countries_access',
      'team_id', 'reports_to', 'max_tickets', 'can_approve_orders', 'can_approve_credit',
      'approval_limit', 'mfa_enabled', 'mfa_secret', 'status', 'last_login',
      'last_activity', 'failed_login_attempts', 'locked_until', 'password_changed_at',
      'must_change_password', 'created_at', 'updated_at'
    ],
    validations: {
      role: ['CS_AGENT', 'CS_SUPERVISOR', 'CS_MANAGER', 'BD_REP', 'BD_MANAGER', 'COUNTRY_MANAGER', 'REGIONAL_MANAGER', 'GROUP_HEAD', 'SYSTEM_ADMIN', 'SUPER_ADMIN'],
      department: ['CUSTOMER_SERVICE', 'BUSINESS_DEVELOPMENT', 'OPERATIONS', 'FINANCE', 'IT', 'MANAGEMENT'],
      country_code: ['KE', 'UG', 'TZ', 'RW', 'SS', 'ZM', 'MW', 'CD', 'SO'],
      status: ['ACTIVE', 'INACTIVE', 'LOCKED', 'SUSPENDED'],
    },
    columnWidths: { A: 120, B: 100, C: 180, D: 100, E: 100, F: 120, G: 150, H: 120, I: 160, J: 100, K: 150, L: 100, M: 120, N: 100, O: 120, P: 120, Q: 100, R: 100, S: 120, T: 80, U: 150, V: 150, W: 130, X: 150, Y: 150, Z: 130, AA: 150, AB: 150 },
  },

  Teams: {
    headers: [
      'team_id', 'name', 'code', 'description', 'department', 'country_code',
      'team_lead_id', 'parent_team_id', 'escalation_team_id', 'auto_assign',
      'assignment_method', 'working_hours', 'timezone', 'is_active', 'created_at', 'updated_at'
    ],
    validations: {
      department: ['CUSTOMER_SERVICE', 'BUSINESS_DEVELOPMENT', 'OPERATIONS', 'FINANCE', 'IT', 'MANAGEMENT'],
      country_code: ['KE', 'UG', 'TZ', 'RW', 'SS', 'ZM', 'MW', 'CD', 'SO', 'ALL'],
      assignment_method: ['ROUND_ROBIN', 'LEAST_BUSY', 'MANUAL'],
    },
    seedData: [
      ['TEAM001', 'Kenya CS Team', 'CS-KE', 'Customer Service team for Kenya', 'CUSTOMER_SERVICE', 'KE', '', '', '', true, 'ROUND_ROBIN', '{"mon":"08:00-17:00"}', 'Africa/Nairobi', true, new Date(), new Date()],
      ['TEAM002', 'Uganda CS Team', 'CS-UG', 'Customer Service team for Uganda', 'CUSTOMER_SERVICE', 'UG', '', '', '', true, 'ROUND_ROBIN', '{"mon":"08:00-17:00"}', 'Africa/Kampala', true, new Date(), new Date()],
    ],
    columnWidths: { A: 100, B: 150, C: 80, D: 200, E: 160, F: 100, G: 120, H: 120, I: 130, J: 100, K: 130, L: 300, M: 130, N: 80, O: 150, P: 150 },
  },

  Tickets: {
    headers: [
      'ticket_id', 'ticket_number', 'customer_id', 'contact_id', 'channel', 'category',
      'subcategory', 'subject', 'description', 'priority', 'status', 'assigned_to',
      'assigned_team_id', 'related_order_id', 'country_code', 'sla_config_id',
      'sla_acknowledge_by', 'sla_response_by', 'sla_resolve_by',
      'sla_acknowledge_breached', 'sla_response_breached', 'sla_resolve_breached',
      'acknowledged_at', 'first_response_at', 'resolved_at', 'closed_at',
      'resolution_type', 'resolution_summary', 'root_cause', 'root_cause_category',
      'satisfaction_rating', 'satisfaction_comment', 'escalation_level',
      'escalated_to', 'escalated_at', 'escalation_reason', 'reopened_count',
      'tags', 'created_by', 'created_at', 'updated_at'
    ],
    validations: {
      channel: ['PORTAL', 'EMAIL', 'WHATSAPP', 'PHONE', 'SOCIAL_FACEBOOK', 'SOCIAL_TWITTER', 'WALK_IN', 'INTERNAL'],
      category: ['DELIVERY', 'QUALITY', 'BILLING', 'PRICING', 'ACCOUNT', 'CONTRACT', 'TECHNICAL', 'GENERAL'],
      priority: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'],
      status: ['NEW', 'OPEN', 'IN_PROGRESS', 'PENDING_CUSTOMER', 'PENDING_INTERNAL', 'ESCALATED', 'RESOLVED', 'CLOSED', 'CANCELLED'],
      country_code: ['KE', 'UG', 'TZ', 'RW', 'SS', 'ZM', 'MW', 'CD', 'SO'],
      resolution_type: ['RESOLVED', 'DUPLICATE', 'NOT_AN_ISSUE', 'CANNOT_REPRODUCE', 'WONT_FIX'],
      root_cause_category: ['PROCESS', 'SYSTEM', 'HUMAN_ERROR', 'EXTERNAL', 'POLICY'],
    },
    columnWidths: { A: 120, B: 130, C: 120, D: 120, E: 100, F: 100, G: 100, H: 200, I: 300, J: 80, K: 120, L: 120, M: 120, N: 120, O: 100, P: 100, Q: 150, R: 150, S: 150, T: 140, U: 140, V: 140, W: 150, X: 150, Y: 150, Z: 150, AA: 100, AB: 250, AC: 150, AD: 130, AE: 120, AF: 120, AG: 150, AH: 200, AI: 100, AJ: 150, AK: 120, AL: 150, AM: 150 },
  },

  TicketComments: {
    headers: [
      'comment_id', 'ticket_id', 'parent_comment_id', 'author_type', 'author_id',
      'author_name', 'content', 'content_html', 'is_internal', 'is_resolution',
      'channel', 'external_message_id', 'sentiment', 'created_at', 'updated_at'
    ],
    validations: {
      author_type: ['CUSTOMER', 'AGENT', 'SYSTEM', 'BOT'],
      channel: ['PORTAL', 'EMAIL', 'WHATSAPP', 'PHONE', 'SOCIAL', 'INTERNAL'],
      sentiment: ['POSITIVE', 'NEUTRAL', 'NEGATIVE'],
    },
    columnWidths: { A: 120, B: 120, C: 130, D: 100, E: 120, F: 120, G: 400, H: 400, I: 80, J: 100, K: 100, L: 150, M: 80, N: 150, O: 150 },
  },

  TicketAttachments: {
    headers: [
      'attachment_id', 'ticket_id', 'comment_id', 'file_name', 'file_path',
      'file_size', 'mime_type', 'uploaded_by_type', 'uploaded_by_id',
      'is_inline', 'created_at'
    ],
    validations: {
      uploaded_by_type: ['CUSTOMER', 'AGENT'],
    },
    columnWidths: { A: 130, B: 120, C: 120, D: 200, E: 300, F: 100, G: 120, H: 120, I: 120, J: 80, K: 150 },
  },

  TicketHistory: {
    headers: [
      'history_id', 'ticket_id', 'field_name', 'old_value', 'new_value',
      'changed_by_type', 'changed_by_id', 'changed_by_name', 'change_reason', 'created_at'
    ],
    validations: {
      changed_by_type: ['CUSTOMER', 'AGENT', 'SYSTEM'],
    },
    columnWidths: { A: 120, B: 120, C: 120, D: 150, E: 150, F: 120, G: 120, H: 120, I: 200, J: 150 },
  },

  Orders: {
    headers: [
      'order_id', 'order_number', 'oracle_order_id', 'customer_id', 'contact_id',
      'delivery_location_id', 'source_depot_id', 'price_list_id', 'requested_date',
      'requested_time_from', 'requested_time_to', 'confirmed_date', 'confirmed_time',
      'status', 'payment_status', 'subtotal', 'tax_amount', 'delivery_fee',
      'discount_amount', 'total_amount', 'currency_code', 'special_instructions',
      'po_number', 'is_recurring', 'recurring_schedule_id', 'rejection_reason',
      'cancelled_reason', 'cancelled_by', 'cancelled_at', 'submitted_at',
      'approved_at', 'approved_by', 'loaded_at', 'dispatched_at', 'delivered_at',
      'delivery_confirmed_by', 'delivery_notes', 'vehicle_id', 'driver_id',
      'created_by_type', 'created_by_id', 'country_code', 'created_at', 'updated_at'
    ],
    validations: {
      status: ['DRAFT', 'SUBMITTED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'SCHEDULED', 'LOADING', 'LOADED', 'IN_TRANSIT', 'DELIVERED', 'PARTIALLY_DELIVERED', 'CANCELLED', 'ON_HOLD'],
      payment_status: ['PENDING', 'CREDIT_APPROVED', 'PREPAID', 'INVOICED', 'PAID', 'OVERDUE'],
      currency_code: ['KES', 'UGX', 'TZS', 'RWF', 'USD', 'ZMW', 'MWK'],
      country_code: ['KE', 'UG', 'TZ', 'RW', 'SS', 'ZM', 'MW', 'CD', 'SO'],
      created_by_type: ['CUSTOMER', 'AGENT'],
    },
    columnWidths: { A: 120, B: 130, C: 120, D: 120, E: 120, F: 140, G: 120, H: 120, I: 120, J: 130, K: 130, L: 120, M: 120, N: 130, O: 120, P: 100, Q: 100, R: 100, S: 120, T: 100, U: 100, V: 200, W: 120, X: 100, Y: 150, Z: 200, AA: 200, AB: 120, AC: 150, AD: 150, AE: 150, AF: 120, AG: 150, AH: 150, AI: 150, AJ: 150, AK: 200, AL: 120, AM: 120, AN: 120, AO: 120, AP: 100, AQ: 150, AR: 150 },
  },

  OrderLines: {
    headers: [
      'line_id', 'order_id', 'product_id', 'product_name', 'quantity',
      'unit_of_measure', 'unit_price', 'discount_percent', 'tax_rate',
      'line_subtotal', 'line_tax', 'line_total', 'delivered_quantity',
      'delivery_variance_reason', 'created_at'
    ],
    columnWidths: { A: 120, B: 120, C: 100, D: 180, E: 80, F: 120, G: 100, H: 120, I: 80, J: 100, K: 80, L: 100, M: 130, N: 180, O: 150 },
  },

  OrderStatusHistory: {
    headers: [
      'history_id', 'order_id', 'from_status', 'to_status', 'changed_by_type',
      'changed_by_id', 'changed_by_name', 'notes', 'gps_lat', 'gps_lng', 'created_at'
    ],
    validations: {
      changed_by_type: ['CUSTOMER', 'AGENT', 'SYSTEM', 'DRIVER'],
    },
    columnWidths: { A: 120, B: 120, C: 130, D: 130, E: 120, F: 120, G: 120, H: 200, I: 100, J: 100, K: 150 },
  },

  RecurringSchedule: {
    headers: [
      'schedule_id', 'customer_id', 'name', 'delivery_location_id', 'frequency',
      'frequency_interval', 'day_of_week', 'day_of_month', 'preferred_time_from',
      'preferred_time_to', 'start_date', 'end_date', 'next_order_date', 'is_active',
      'auto_submit', 'special_instructions', 'created_by', 'created_at', 'updated_at'
    ],
    validations: {
      frequency: ['DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'CUSTOM'],
    },
    columnWidths: { A: 120, B: 120, C: 180, D: 150, E: 100, F: 130, G: 100, H: 110, I: 130, J: 130, K: 100, L: 100, M: 130, N: 80, O: 100, P: 200, Q: 120, R: 150, S: 150 },
  },

  RecurringScheduleLines: {
    headers: ['line_id', 'schedule_id', 'product_id', 'quantity', 'created_at'],
    columnWidths: { A: 120, B: 120, C: 100, D: 100, E: 150 },
  },

  Products: {
    headers: [
      'product_id', 'code', 'name', 'description', 'category', 'subcategory',
      'unit_of_measure', 'min_order_quantity', 'max_order_quantity',
      'requires_special_handling', 'handling_instructions', 'image_url',
      'is_active', 'created_at', 'updated_at'
    ],
    validations: {
      category: ['AGO', 'PMS', 'KEROSENE', 'JET_FUEL', 'LPG', 'LUBRICANTS', 'ADDITIVES'],
      unit_of_measure: ['LITERS', 'KG', 'UNITS', 'DRUMS'],
    },
    seedData: [
      ['PROD001', 'AGO', 'Automotive Gas Oil (Diesel)', 'Standard diesel fuel', 'AGO', '', 'LITERS', 100, 50000, false, '', '', true, new Date(), new Date()],
      ['PROD002', 'PMS', 'Premium Motor Spirit (Petrol)', 'Standard petrol', 'PMS', '', 'LITERS', 100, 50000, false, '', '', true, new Date(), new Date()],
      ['PROD003', 'KERO', 'Kerosene', 'Illuminating kerosene', 'KEROSENE', '', 'LITERS', 50, 20000, false, '', '', true, new Date(), new Date()],
      ['PROD004', 'JET-A1', 'Jet Fuel A-1', 'Aviation turbine fuel', 'JET_FUEL', '', 'LITERS', 1000, 100000, true, 'Aviation fuel handling required', '', true, new Date(), new Date()],
      ['PROD005', 'LPG-6', 'LPG 6kg Cylinder', 'Liquefied petroleum gas - 6kg', 'LPG', '6KG', 'KG', 1, 1000, true, 'Pressurized container', '', true, new Date(), new Date()],
      ['PROD006', 'LPG-13', 'LPG 13kg Cylinder', 'Liquefied petroleum gas - 13kg', 'LPG', '13KG', 'KG', 1, 500, true, 'Pressurized container', '', true, new Date(), new Date()],
    ],
    columnWidths: { A: 100, B: 100, C: 200, D: 250, E: 100, F: 100, G: 120, H: 130, I: 130, J: 150, K: 200, L: 150, M: 80, N: 150, O: 150 },
  },

  Depots: {
    headers: [
      'depot_id', 'code', 'name', 'country_code', 'city', 'address',
      'gps_lat', 'gps_lng', 'depot_type', 'capacity', 'products_available',
      'operating_hours', 'contact_phone', 'contact_email', 'is_active',
      'created_at', 'updated_at'
    ],
    validations: {
      country_code: ['KE', 'UG', 'TZ', 'RW', 'SS', 'ZM', 'MW', 'CD', 'SO'],
      depot_type: ['TERMINAL', 'DEPOT', 'STATION', 'AIRPORT'],
    },
    seedData: [
      ['DEP001', 'NBI-IND', 'Nairobi Industrial Depot', 'KE', 'Nairobi', 'Industrial Area', -1.3033, 36.8573, 'DEPOT', 5000000, 'AGO,PMS,KERO', '{"mon":"06:00-18:00"}', '+254201234567', 'nairobi@hasspetroleum.com', true, new Date(), new Date()],
      ['DEP002', 'MBA-PORT', 'Mombasa Port Terminal', 'KE', 'Mombasa', 'Kilindini Harbour', -4.0435, 39.6682, 'TERMINAL', 20000000, 'AGO,PMS,KERO,JET-A1', '{"mon":"00:00-23:59"}', '+254412345678', 'mombasa@hasspetroleum.com', true, new Date(), new Date()],
    ],
    columnWidths: { A: 100, B: 100, C: 200, D: 100, E: 120, F: 250, G: 100, H: 100, I: 100, J: 100, K: 200, L: 300, M: 140, N: 200, O: 80, P: 150, Q: 150 },
  },

  PriceList: {
    headers: [
      'price_id', 'name', 'country_code', 'currency_code', 'segment_id',
      'customer_id', 'is_default', 'effective_from', 'effective_to',
      'status', 'approved_by', 'approved_at', 'notes', 'created_by',
      'created_at', 'updated_at'
    ],
    validations: {
      country_code: ['KE', 'UG', 'TZ', 'RW', 'SS', 'ZM', 'MW', 'CD', 'SO'],
      currency_code: ['KES', 'UGX', 'TZS', 'RWF', 'USD', 'ZMW', 'MWK'],
      status: ['DRAFT', 'ACTIVE', 'EXPIRED', 'SUPERSEDED'],
    },
    columnWidths: { A: 100, B: 180, C: 100, D: 100, E: 100, F: 120, G: 80, H: 120, I: 120, J: 100, K: 120, L: 150, M: 200, N: 120, O: 150, P: 150 },
  },

  PriceListItems: {
    headers: [
      'item_id', 'price_list_id', 'product_id', 'depot_id', 'unit_price',
      'min_quantity', 'max_quantity', 'discount_percent', 'effective_from',
      'effective_to', 'created_at'
    ],
    columnWidths: { A: 100, B: 120, C: 100, D: 100, E: 100, F: 100, G: 100, H: 120, I: 120, J: 120, K: 150 },
  },

  DeliveryLocations: {
    headers: [
      'location_id', 'customer_id', 'name', 'address_line1', 'address_line2',
      'city', 'region', 'country_code', 'postal_code', 'gps_lat', 'gps_lng',
      'delivery_instructions', 'contact_name', 'contact_phone', 'access_hours',
      'requires_appointment', 'tank_capacity', 'is_default', 'is_verified',
      'verified_by', 'verified_at', 'status', 'created_at', 'updated_at'
    ],
    validations: {
      country_code: ['KE', 'UG', 'TZ', 'RW', 'SS', 'ZM', 'MW', 'CD', 'SO'],
      status: ['ACTIVE', 'INACTIVE'],
    },
    columnWidths: { A: 120, B: 120, C: 150, D: 200, E: 150, F: 100, G: 100, H: 100, I: 100, J: 100, K: 100, L: 200, M: 120, N: 120, O: 200, P: 130, Q: 100, R: 80, S: 80, T: 120, U: 150, V: 80, W: 150, X: 150 },
  },

  Documents: {
    headers: [
      'document_id', 'customer_id', 'document_type', 'document_name', 'file_id',
      'file_path', 'file_size', 'mime_type', 'document_number', 'issue_date',
      'expiry_date', 'issuing_authority', 'is_mandatory', 'status', 'reviewed_by',
      'reviewed_at', 'rejection_reason', 'reminder_sent_at', 'uploaded_by_type',
      'uploaded_by_id', 'version', 'previous_version_id', 'created_at', 'updated_at'
    ],
    validations: {
      document_type: ['KYC_NATIONAL_ID', 'KYC_PASSPORT', 'KYC_BUSINESS_REG', 'KYC_TAX_CERT', 'KYC_PIN', 'CONTRACT', 'CREDIT_APPLICATION', 'INSURANCE_CERT', 'OTHER'],
      status: ['PENDING_REVIEW', 'APPROVED', 'REJECTED', 'EXPIRED', 'SUPERSEDED'],
      uploaded_by_type: ['CUSTOMER', 'AGENT'],
    },
    columnWidths: { A: 120, B: 120, C: 140, D: 200, E: 150, F: 250, G: 80, H: 120, I: 130, J: 100, K: 100, L: 150, M: 100, N: 120, O: 120, P: 150, Q: 200, R: 150, S: 120, T: 120, U: 80, V: 140, W: 150, X: 150 },
  },

  Vehicles: {
    headers: [
      'vehicle_id', 'registration_number', 'vehicle_type', 'capacity',
      'capacity_unit', 'country_code', 'depot_id', 'status',
      'last_service_date', 'next_service_date', 'gps_device_id',
      'is_active', 'created_at', 'updated_at'
    ],
    validations: {
      vehicle_type: ['TRUCK', 'TANKER', 'LPG_TRUCK', 'PICKUP'],
      country_code: ['KE', 'UG', 'TZ', 'RW', 'SS', 'ZM', 'MW', 'CD', 'SO'],
      status: ['AVAILABLE', 'IN_TRANSIT', 'MAINTENANCE', 'RETIRED'],
    },
    columnWidths: { A: 100, B: 140, C: 100, D: 80, E: 100, F: 100, G: 100, H: 100, I: 130, J: 130, K: 120, L: 80, M: 150, N: 150 },
  },

  Drivers: {
    headers: [
      'driver_id', 'employee_id', 'first_name', 'last_name', 'phone',
      'email', 'license_number', 'license_expiry', 'country_code',
      'status', 'is_active', 'created_at', 'updated_at'
    ],
    validations: {
      country_code: ['KE', 'UG', 'TZ', 'RW', 'SS', 'ZM', 'MW', 'CD', 'SO'],
      status: ['AVAILABLE', 'ON_DELIVERY', 'OFF_DUTY', 'SUSPENDED'],
    },
    columnWidths: { A: 100, B: 100, C: 100, D: 100, E: 120, F: 180, G: 130, H: 120, I: 100, J: 100, K: 80, L: 150, M: 150 },
  },

  SLAConfig: {
    headers: [
      'sla_id', 'name', 'country_code', 'segment_id', 'priority', 'category',
      'acknowledge_minutes', 'first_response_minutes', 'resolution_minutes',
      'escalation_1_minutes', 'escalation_2_minutes', 'escalation_3_minutes',
      'business_hours_only', 'is_active', 'effective_from', 'effective_to',
      'created_by', 'created_at', 'updated_at'
    ],
    validations: {
      country_code: ['KE', 'UG', 'TZ', 'RW', 'SS', 'ZM', 'MW', 'CD', 'SO', 'ALL'],
      priority: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'],
      category: ['DELIVERY', 'QUALITY', 'BILLING', 'PRICING', 'ACCOUNT', 'CONTRACT', 'TECHNICAL', 'GENERAL', 'ALL'],
    },
    seedData: [
      ['SLA001', 'Critical Default', 'ALL', 'ALL', 'CRITICAL', 'ALL', 15, 30, 240, 60, 120, 180, true, true, new Date(), '', 'SYSTEM', new Date(), new Date()],
      ['SLA002', 'High Default', 'ALL', 'ALL', 'HIGH', 'ALL', 30, 60, 480, 120, 240, 360, true, true, new Date(), '', 'SYSTEM', new Date(), new Date()],
      ['SLA003', 'Medium Default', 'ALL', 'ALL', 'MEDIUM', 'ALL', 60, 120, 1440, 240, 480, 720, true, true, new Date(), '', 'SYSTEM', new Date(), new Date()],
      ['SLA004', 'Low Default', 'ALL', 'ALL', 'LOW', 'ALL', 120, 240, 2880, 480, 960, 1440, true, true, new Date(), '', 'SYSTEM', new Date(), new Date()],
    ],
    columnWidths: { A: 100, B: 150, C: 100, D: 100, E: 80, F: 100, G: 150, H: 160, I: 150, J: 140, K: 140, L: 140, M: 130, N: 80, O: 120, P: 120, Q: 120, R: 150, S: 150 },
  },

  BusinessHours: {
    headers: [
      'hours_id', 'country_code', 'name', 'is_default',
      'monday_start', 'monday_end', 'tuesday_start', 'tuesday_end',
      'wednesday_start', 'wednesday_end', 'thursday_start', 'thursday_end',
      'friday_start', 'friday_end', 'saturday_start', 'saturday_end',
      'sunday_start', 'sunday_end', 'timezone', 'created_at', 'updated_at'
    ],
    validations: {
      country_code: ['KE', 'UG', 'TZ', 'RW', 'SS', 'ZM', 'MW', 'CD', 'SO'],
    },
    seedData: [
      ['BH001', 'KE', 'Kenya Standard Hours', true, '08:00', '17:00', '08:00', '17:00', '08:00', '17:00', '08:00', '17:00', '08:00', '17:00', '09:00', '13:00', '', '', 'Africa/Nairobi', new Date(), new Date()],
    ],
    columnWidths: { A: 100, B: 100, C: 180, D: 80, E: 100, F: 100, G: 110, H: 100, I: 120, J: 120, K: 110, L: 110, M: 100, N: 100, O: 110, P: 110, Q: 100, R: 100, S: 130, T: 150, U: 150 },
  },

  Holidays: {
    headers: ['holiday_id', 'country_code', 'name', 'date', 'is_recurring', 'created_at'],
    validations: {
      country_code: ['KE', 'UG', 'TZ', 'RW', 'SS', 'ZM', 'MW', 'CD', 'SO'],
    },
    seedData: [
      ['HOL001', 'KE', 'New Year', '2025-01-01', true, new Date()],
      ['HOL002', 'KE', 'Christmas Day', '2025-12-25', true, new Date()],
    ],
    columnWidths: { A: 100, B: 100, C: 200, D: 120, E: 100, F: 150 },
  },

  ChurnRiskFactors: {
    headers: [
      'factor_id', 'customer_id', 'factor_type', 'factor_weight', 'current_value',
      'previous_value', 'threshold', 'details', 'calculated_at'
    ],
    validations: {
      factor_type: ['ORDER_DECLINE', 'VOLUME_DECLINE', 'COMPLAINT_INCREASE', 'PAYMENT_DELAY', 'LOW_ENGAGEMENT', 'COMPETITOR_MENTION'],
    },
    columnWidths: { A: 100, B: 120, C: 140, D: 100, E: 100, F: 120, G: 80, H: 200, I: 150 },
  },

  RetentionActivities: {
    headers: [
      'activity_id', 'customer_id', 'activity_type', 'subject', 'description',
      'outcome', 'next_action', 'next_action_date', 'performed_by', 'created_at'
    ],
    validations: {
      activity_type: ['CALL', 'VISIT', 'EMAIL', 'MEETING', 'OFFER_SENT', 'DISCOUNT_APPLIED', 'CONTRACT_RENEWAL', 'WIN_BACK'],
      outcome: ['POSITIVE', 'NEUTRAL', 'NEGATIVE', 'PENDING'],
    },
    columnWidths: { A: 120, B: 120, C: 130, D: 200, E: 300, F: 80, G: 200, H: 130, I: 120, J: 150 },
  },

  Notifications: {
    headers: [
      'notification_id', 'recipient_type', 'recipient_id', 'notification_type',
      'reference_type', 'reference_id', 'title', 'message', 'priority',
      'email_sent', 'sms_sent', 'in_app_read', 'in_app_read_at',
      'action_url', 'expires_at', 'created_at'
    ],
    validations: {
      recipient_type: ['CUSTOMER_CONTACT', 'INTERNAL_USER'],
      notification_type: ['TICKET_CREATED', 'TICKET_UPDATED', 'TICKET_RESOLVED', 'ORDER_CONFIRMED', 'ORDER_STATUS', 'ORDER_DELIVERED', 'DOCUMENT_EXPIRING', 'SYSTEM_ALERT'],
      priority: ['LOW', 'NORMAL', 'HIGH', 'URGENT'],
    },
    columnWidths: { A: 130, B: 130, C: 120, D: 130, E: 120, F: 120, G: 200, H: 300, I: 80, J: 80, K: 80, L: 100, M: 150, N: 200, O: 150, P: 150 },
  },

  NotificationPreferences: {
    headers: [
      'preference_id', 'recipient_type', 'recipient_id', 'notification_type',
      'channel_email', 'channel_sms', 'channel_whatsapp', 'channel_push',
      'channel_in_app', 'is_enabled', 'created_at', 'updated_at'
    ],
    validations: {
      recipient_type: ['CUSTOMER_CONTACT', 'INTERNAL_USER'],
    },
    columnWidths: { A: 130, B: 130, C: 120, D: 150, E: 100, F: 100, G: 120, H: 100, I: 100, J: 80, K: 150, L: 150 },
  },

  KnowledgeCategories: {
    headers: [
      'category_id', 'name', 'slug', 'description', 'parent_id', 'icon',
      'sort_order', 'is_public', 'is_active', 'created_at', 'updated_at'
    ],
    seedData: [
      ['KCAT001', 'Getting Started', 'getting-started', 'Guides for new customers', '', '📚', 1, true, true, new Date(), new Date()],
      ['KCAT002', 'Orders & Deliveries', 'orders-deliveries', 'Order and delivery help', '', '📦', 2, true, true, new Date(), new Date()],
      ['KCAT003', 'Billing & Payments', 'billing-payments', 'Invoice and payment help', '', '💳', 3, true, true, new Date(), new Date()],
    ],
    columnWidths: { A: 100, B: 150, C: 150, D: 250, E: 100, F: 60, G: 80, H: 80, I: 80, J: 150, K: 150 },
  },

  KnowledgeArticles: {
    headers: [
      'article_id', 'category_id', 'title', 'slug', 'summary', 'content',
      'language', 'tags', 'is_public', 'is_featured', 'status',
      'view_count', 'helpful_yes', 'helpful_no', 'author_id',
      'published_at', 'created_at', 'updated_at'
    ],
    validations: {
      language: ['en', 'sw', 'fr'],
      status: ['DRAFT', 'PUBLISHED', 'ARCHIVED'],
    },
    columnWidths: { A: 120, B: 100, C: 250, D: 200, E: 300, F: 500, G: 80, H: 150, I: 80, J: 100, K: 100, L: 80, M: 80, N: 80, O: 120, P: 150, Q: 150, R: 150 },
  },

  AuditLog: {
    headers: [
      'log_id', 'entity_type', 'entity_id', 'action', 'actor_type', 'actor_id',
      'actor_email', 'actor_ip', 'actor_user_agent', 'changes', 'metadata',
      'country_code', 'created_at'
    ],
    validations: {
      action: ['CREATE', 'UPDATE', 'DELETE', 'VIEW', 'EXPORT', 'LOGIN', 'LOGOUT', 'PASSWORD_CHANGE'],
      actor_type: ['CUSTOMER', 'AGENT', 'SYSTEM', 'API'],
    },
    columnWidths: { A: 120, B: 100, C: 120, D: 100, E: 100, F: 120, G: 180, H: 120, I: 250, J: 400, K: 200, L: 100, M: 150 },
  },

  Sessions: {
    headers: [
      'session_id', 'user_type', 'user_id', 'token_hash', 'ip_address',
      'user_agent', 'device_type', 'country', 'is_active', 'expires_at',
      'created_at', 'last_activity'
    ],
    validations: {
      user_type: ['STAFF', 'CUSTOMER'],
      device_type: ['WEB', 'MOBILE', 'API'],
    },
    columnWidths: { A: 150, B: 100, C: 120, D: 200, E: 120, F: 300, G: 100, H: 80, I: 80, J: 150, K: 150, L: 150 },
  },

  IntegrationLog: {
    headers: [
      'log_id', 'integration', 'direction', 'endpoint', 'method',
      'request_body', 'response_body', 'status_code', 'error_message',
      'duration_ms', 'reference_type', 'reference_id', 'created_at'
    ],
    validations: {
      integration: ['ORACLE', 'WHATSAPP', 'EMAIL', 'SMS', 'MAPS', 'PAYMENT'],
      direction: ['INBOUND', 'OUTBOUND'],
    },
    columnWidths: { A: 120, B: 100, C: 100, D: 250, E: 80, F: 400, G: 400, H: 100, I: 200, J: 100, K: 120, L: 120, M: 150 },
  },

  JobQueue: {
    headers: [
      'job_id', 'job_type', 'payload', 'priority', 'status', 'attempts',
      'max_attempts', 'error_message', 'scheduled_at', 'started_at',
      'completed_at', 'created_at'
    ],
    validations: {
      status: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED'],
    },
    columnWidths: { A: 120, B: 150, C: 300, D: 80, E: 100, F: 80, G: 100, H: 200, I: 150, J: 150, K: 150, L: 150 },
  },

  Config: {
    headers: ['config_key', 'config_value', 'value_type', 'description', 'is_encrypted', 'country_code', 'updated_by', 'updated_at'],
    seedData: [
      ['SYSTEM_VERSION', '1.1.0', 'STRING', 'Current system version', false, '', 'SYSTEM', new Date()],
      ['DEFAULT_CURRENCY', 'KES', 'STRING', 'Default currency', false, '', 'SYSTEM', new Date()],
      ['DEFAULT_COUNTRY', 'KE', 'STRING', 'Default country code', false, '', 'SYSTEM', new Date()],
      ['SESSION_TIMEOUT_HOURS', '24', 'NUMBER', 'Session timeout in hours', false, '', 'SYSTEM', new Date()],
      ['MAX_LOGIN_ATTEMPTS', '5', 'NUMBER', 'Max failed login attempts', false, '', 'SYSTEM', new Date()],
      ['LOCKOUT_DURATION_MINUTES', '30', 'NUMBER', 'Lockout duration in minutes', false, '', 'SYSTEM', new Date()],
      ['PASSWORD_MIN_LENGTH', '8', 'NUMBER', 'Minimum password length', false, '', 'SYSTEM', new Date()],
      ['TICKET_AUTO_CLOSE_DAYS', '7', 'NUMBER', 'Days to auto-close resolved tickets', false, '', 'SYSTEM', new Date()],
      ['DOCUMENT_EXPIRY_WARNING_DAYS', '30', 'NUMBER', 'Days before expiry to warn', false, '', 'SYSTEM', new Date()],
      ['SUPPORT_EMAIL', 'support@hasspetroleum.com', 'STRING', 'Support email', false, '', 'SYSTEM', new Date()],
      ['ALLOWED_STAFF_DOMAINS', 'hasspetroleum.com,hassgroup.com', 'STRING', 'Allowed staff email domains', false, '', 'SYSTEM', new Date()],
      ['MAINTENANCE_MODE', 'false', 'BOOLEAN', 'System maintenance mode', false, '', 'SYSTEM', new Date()],
    ],
    validations: {
      value_type: ['STRING', 'NUMBER', 'BOOLEAN', 'JSON'],
    },
    columnWidths: { A: 250, B: 200, C: 100, D: 300, E: 100, F: 100, G: 120, H: 150 },
  },
};

const SHEET_ORDER = [
  'Countries', 'Segments', 'Config', 'Teams', 'Users', 'Customers', 'Contacts',
  'Products', 'Depots', 'PriceList', 'PriceListItems', 'DeliveryLocations', 'Documents',
  'Vehicles', 'Drivers', 'SLAConfig', 'BusinessHours', 'Holidays',
  'Tickets', 'TicketComments', 'TicketAttachments', 'TicketHistory',
  'Orders', 'OrderLines', 'OrderStatusHistory', 'RecurringSchedule', 'RecurringScheduleLines',
  'ChurnRiskFactors', 'RetentionActivities', 'Notifications', 'NotificationPreferences',
  'KnowledgeCategories', 'KnowledgeArticles', 'AuditLog', 'Sessions', 'IntegrationLog', 'JobQueue'
];

function main() {
  Logger.log('=== HASS CMS DATABASE SETUP STARTED ===');
  
  const ss = getOrCreateSpreadsheet();
  Logger.log('Spreadsheet: ' + ss.getName() + ' (' + ss.getId() + ')');
  
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());
  
  let created = 0, updated = 0;
  for (const sheetName of SHEET_ORDER) {
    const result = setupSheet(ss, sheetName, SCHEMAS[sheetName]);
    if (result === 'created') created++;
    else if (result === 'updated') updated++;
  }
  
  removeDefaultSheet(ss);
  createNamedRanges(ss);
  
  Logger.log('Created: ' + created + ', Updated: ' + updated + ', Total: ' + SHEET_ORDER.length);
  Logger.log('URL: ' + ss.getUrl());
  
  return ss.getId();
}

function getDatabase() {
  const ssId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!ssId) throw new Error('Database not initialized. Run main() first.');
  return SpreadsheetApp.openById(ssId);
}

function getSheet(sheetName) {
  const ss = getDatabase();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('Sheet not found: ' + sheetName);
  return sheet;
}

function getOrCreateSpreadsheet() {
  const storedId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (storedId) {
    try { return SpreadsheetApp.openById(storedId); } catch (e) {}
  }
  
  const files = DriveApp.getFilesByName(CONFIG.SPREADSHEET_NAME);
  while (files.hasNext()) {
    const file = files.next();
    if (file.getMimeType() === MimeType.GOOGLE_SHEETS) {
      return SpreadsheetApp.openById(file.getId());
    }
  }
  
  return SpreadsheetApp.create(CONFIG.SPREADSHEET_NAME);
}

function removeDefaultSheet(ss) {
  const defaultSheet = ss.getSheetByName('Sheet1');
  if (defaultSheet && ss.getSheets().length > 1) {
    const range = defaultSheet.getDataRange();
    if (range.getNumRows() === 1 && range.getNumColumns() === 1 && range.getValue() === '') {
      ss.deleteSheet(defaultSheet);
    }
  }
}

function setupSheet(ss, sheetName, schema) {
  let result = 'unchanged';
  let sheet = ss.getSheetByName(sheetName);
  
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    result = 'created';
  }
  
  const existingHeaders = sheet.getRange(1, 1, 1, Math.max(schema.headers.length, 1)).getValues()[0];
  const headersMatch = schema.headers.every((h, i) => h === existingHeaders[i]);
  
  if (!headersMatch) {
    sheet.getRange(1, 1, 1, schema.headers.length).setValues([schema.headers]);
    result = result === 'created' ? 'created' : 'updated';
  }
  
  formatHeaderRow(sheet, schema.headers.length);
  if (schema.columnWidths) setColumnWidths(sheet, schema.columnWidths);
  if (schema.validations) applyValidations(sheet, schema.headers, schema.validations);
  
  if (schema.seedData && sheet.getLastRow() <= 1) {
    sheet.getRange(2, 1, schema.seedData.length, schema.seedData[0].length).setValues(schema.seedData);
    result = result === 'created' ? 'created' : 'updated';
  }
  
  applyConditionalFormatting(sheet, sheetName, schema.headers);
  sheet.setFrozenRows(1);
  
  return result;
}

function formatHeaderRow(sheet, numColumns) {
  sheet.getRange(1, 1, 1, numColumns)
    .setFontWeight('bold')
    .setBackground('#1A237E')
    .setFontColor('#ffffff')
    .setHorizontalAlignment('center');
  sheet.setRowHeight(1, 30);
}

function setColumnWidths(sheet, widths) {
  for (const [col, width] of Object.entries(widths)) {
    try { sheet.setColumnWidth(columnLetterToIndex(col), width); } catch (e) {}
  }
}

function columnLetterToIndex(letter) {
  let index = 0;
  for (let i = 0; i < letter.length; i++) {
    index = index * 26 + (letter.charCodeAt(i) - 64);
  }
  return index;
}

function applyValidations(sheet, headers, validations) {
  for (const [columnName, values] of Object.entries(validations)) {
    const colIndex = headers.indexOf(columnName) + 1;
    if (colIndex > 0) {
      const rule = SpreadsheetApp.newDataValidation()
        .requireValueInList(values, true)
        .setAllowInvalid(false)
        .build();
      sheet.getRange(2, colIndex, CONFIG.VALIDATION_ROWS, 1).setDataValidation(rule);
    }
  }
}

function applyConditionalFormatting(sheet, sheetName, headers) {
  sheet.clearConditionalFormatRules();
  const rules = [];
  const colors = {
    critical: '#FFCDD2', criticalText: '#B71C1C', high: '#FFE0B2', medium: '#FFF9C4',
    low: '#BBDEFB', resolved: '#C8E6C9', closed: '#EEEEEE', escalated: '#FFCDD2',
    active: '#C8E6C9', suspended: '#FFCDD2', onHold: '#FFE0B2', pending: '#FFF9C4',
    overdue: '#FFCDD2', paid: '#C8E6C9'
  };
  
  if (sheetName === 'Tickets') {
    const priorityCol = headers.indexOf('priority') + 1;
    const statusCol = headers.indexOf('status') + 1;
    
    if (priorityCol > 0) {
      rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('CRITICAL').setBackground(colors.critical).setFontColor(colors.criticalText).setBold(true).setRanges([sheet.getRange(2, priorityCol, CONFIG.VALIDATION_ROWS, 1)]).build());
      rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('HIGH').setBackground(colors.high).setRanges([sheet.getRange(2, priorityCol, CONFIG.VALIDATION_ROWS, 1)]).build());
      rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('MEDIUM').setBackground(colors.medium).setRanges([sheet.getRange(2, priorityCol, CONFIG.VALIDATION_ROWS, 1)]).build());
      rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('LOW').setBackground(colors.low).setRanges([sheet.getRange(2, priorityCol, CONFIG.VALIDATION_ROWS, 1)]).build());
    }
    if (statusCol > 0) {
      rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('RESOLVED').setBackground(colors.resolved).setRanges([sheet.getRange(2, statusCol, CONFIG.VALIDATION_ROWS, 1)]).build());
      rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('CLOSED').setBackground(colors.closed).setRanges([sheet.getRange(2, statusCol, CONFIG.VALIDATION_ROWS, 1)]).build());
      rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('ESCALATED').setBackground(colors.escalated).setFontColor(colors.criticalText).setBold(true).setRanges([sheet.getRange(2, statusCol, CONFIG.VALIDATION_ROWS, 1)]).build());
      rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('NEW').setBackground(colors.pending).setRanges([sheet.getRange(2, statusCol, CONFIG.VALIDATION_ROWS, 1)]).build());
    }
  }
  
  if (sheetName === 'Orders') {
    const statusCol = headers.indexOf('status') + 1;
    const paymentStatusCol = headers.indexOf('payment_status') + 1;
    if (statusCol > 0) {
      rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('DELIVERED').setBackground(colors.resolved).setRanges([sheet.getRange(2, statusCol, CONFIG.VALIDATION_ROWS, 1)]).build());
      rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('CANCELLED').setBackground(colors.critical).setRanges([sheet.getRange(2, statusCol, CONFIG.VALIDATION_ROWS, 1)]).build());
    }
    if (paymentStatusCol > 0) {
      rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('OVERDUE').setBackground(colors.overdue).setFontColor(colors.criticalText).setBold(true).setRanges([sheet.getRange(2, paymentStatusCol, CONFIG.VALIDATION_ROWS, 1)]).build());
      rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('PAID').setBackground(colors.paid).setRanges([sheet.getRange(2, paymentStatusCol, CONFIG.VALIDATION_ROWS, 1)]).build());
    }
  }
  
  if (sheetName === 'Customers') {
    const statusCol = headers.indexOf('status') + 1;
    if (statusCol > 0) {
      rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('ACTIVE').setBackground(colors.active).setRanges([sheet.getRange(2, statusCol, CONFIG.VALIDATION_ROWS, 1)]).build());
      rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('SUSPENDED').setBackground(colors.suspended).setRanges([sheet.getRange(2, statusCol, CONFIG.VALIDATION_ROWS, 1)]).build());
    }
  }
  
  if (sheetName === 'Documents') {
    const statusCol = headers.indexOf('status') + 1;
    if (statusCol > 0) {
      rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('APPROVED').setBackground(colors.active).setRanges([sheet.getRange(2, statusCol, CONFIG.VALIDATION_ROWS, 1)]).build());
      rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('REJECTED').setBackground(colors.suspended).setRanges([sheet.getRange(2, statusCol, CONFIG.VALIDATION_ROWS, 1)]).build());
      rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('EXPIRED').setBackground(colors.high).setRanges([sheet.getRange(2, statusCol, CONFIG.VALIDATION_ROWS, 1)]).build());
    }
  }
  
  if (rules.length > 0) sheet.setConditionalFormatRules(rules);
}

function createNamedRanges(ss) {
  const namedRanges = {
    'RANGE_COUNTRY_CODES': { sheet: 'Countries', column: 'A', startRow: 2 },
    'RANGE_SEGMENT_IDS': { sheet: 'Segments', column: 'A', startRow: 2 },
    'RANGE_PRODUCT_IDS': { sheet: 'Products', column: 'A', startRow: 2 },
    'RANGE_DEPOT_IDS': { sheet: 'Depots', column: 'A', startRow: 2 },
    'RANGE_TEAM_IDS': { sheet: 'Teams', column: 'A', startRow: 2 },
    'RANGE_USER_IDS': { sheet: 'Users', column: 'A', startRow: 2 },
    'RANGE_SLA_IDS': { sheet: 'SLAConfig', column: 'A', startRow: 2 },
  };
  
  const existingRanges = ss.getNamedRanges();
  for (const range of existingRanges) {
    if (range.getName().startsWith('RANGE_')) range.remove();
  }
  
  for (const [name, config] of Object.entries(namedRanges)) {
    const sheet = ss.getSheetByName(config.sheet);
    if (sheet) {
      const lastRow = Math.max(sheet.getLastRow(), config.startRow);
      const numRows = Math.max(1, lastRow - config.startRow + 1);
      const range = sheet.getRange(config.startRow, columnLetterToIndex(config.column), numRows, 1);
      ss.setNamedRange(name, range);
    }
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function generateUUID() { return Utilities.getUuid(); }

function generateId(prefix) {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return prefix + timestamp + random;
}

function generateTicketNumber(countryCode) {
  const year = new Date().getFullYear();
  const sheet = getSheet('Tickets');
  const lastRow = sheet.getLastRow();
  let count = 0;
  if (lastRow > 1) {
    const data = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
    const prefix = 'TKT-' + countryCode + '-' + year;
    count = data.filter(row => row[0] && row[0].startsWith(prefix)).length;
  }
  return 'TKT-' + countryCode + '-' + year + '-' + String(count + 1).padStart(6, '0');
}

function generateOrderNumber(countryCode) {
  const year = new Date().getFullYear();
  const sheet = getSheet('Orders');
  const lastRow = sheet.getLastRow();
  let count = 0;
  if (lastRow > 1) {
    const data = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
    const prefix = 'ORD-' + countryCode + '-' + year;
    count = data.filter(row => row[0] && row[0].startsWith(prefix)).length;
  }
  return 'ORD-' + countryCode + '-' + year + '-' + String(count + 1).padStart(6, '0');
}

function generateAccountNumber(countryCode) {
  const sheet = getSheet('Customers');
  const lastRow = sheet.getLastRow();
  let count = 0;
  if (lastRow > 1) {
    const data = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
    const prefix = 'HASS-' + countryCode;
    count = data.filter(row => row[0] && row[0].startsWith(prefix)).length;
  }
  return 'HASS-' + countryCode + '-' + String(count + 1).padStart(6, '0');
}

function getCurrentTimestamp() { return new Date().toISOString(); }
function getCurrentDate() { return new Date(); }

// ============================================================================
// CRUD OPERATIONS
// ============================================================================

function getSheetData(sheetName) {
  const sheet = getSheet(sheetName);
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  
  const headers = data[0];
  return data.slice(1)
    .filter(row => row.some(cell => cell !== ''))
    .map(row => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = row[i]; });
      return obj;
    });
}

function appendRow(sheetName, rowData) {
  const sheet = getSheet(sheetName);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  
  if (headers.includes('created_at') && !rowData.created_at) rowData.created_at = getCurrentDate();
  if (headers.includes('updated_at') && !rowData.updated_at) rowData.updated_at = getCurrentDate();
  
  const newRow = headers.map(h => rowData[h] !== undefined ? rowData[h] : '');
  sheet.appendRow(newRow);
  return { ...rowData, _rowNumber: sheet.getLastRow() };
}

function bulkInsert(sheetName, rowsData) {
  if (!rowsData || rowsData.length === 0) return 0;
  
  const sheet = getSheet(sheetName);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const now = getCurrentDate();
  
  const rows = rowsData.map(rowData => {
    if (headers.includes('created_at') && !rowData.created_at) rowData.created_at = now;
    if (headers.includes('updated_at') && !rowData.updated_at) rowData.updated_at = now;
    return headers.map(h => rowData[h] !== undefined ? rowData[h] : '');
  });
  
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
  return rows.length;
}

function findRow(sheetName, columnName, value) {
  const data = getSheetData(sheetName);
  return data.find(row => row[columnName] === value) || null;
}

function findRows(sheetName, columnName, value) {
  const data = getSheetData(sheetName);
  return data.filter(row => row[columnName] === value);
}

function updateRow(sheetName, idColumn, idValue, updates) {
  const sheet = getSheet(sheetName);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const idColIndex = headers.indexOf(idColumn);
  if (idColIndex === -1) throw new Error('Column not found: ' + idColumn);
  
  if (headers.includes('updated_at')) updates.updated_at = getCurrentDate();
  
  for (let i = 1; i < data.length; i++) {
    if (data[i][idColIndex] === idValue) {
      for (const [col, val] of Object.entries(updates)) {
        const colIndex = headers.indexOf(col);
        if (colIndex !== -1) sheet.getRange(i + 1, colIndex + 1).setValue(val);
      }
      return true;
    }
  }
  return false;
}

function deleteRow(sheetName, idColumn, idValue, hardDelete = false) {
  const sheet = getSheet(sheetName);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const idColIndex = headers.indexOf(idColumn);
  if (idColIndex === -1) throw new Error('Column not found: ' + idColumn);
  
  for (let i = 1; i < data.length; i++) {
    if (data[i][idColIndex] === idValue) {
      if (hardDelete) {
        sheet.deleteRow(i + 1);
      } else {
        const statusColIndex = headers.indexOf('status');
        if (statusColIndex !== -1) sheet.getRange(i + 1, statusColIndex + 1).setValue('DELETED');
        const updatedAtColIndex = headers.indexOf('updated_at');
        if (updatedAtColIndex !== -1) sheet.getRange(i + 1, updatedAtColIndex + 1).setValue(getCurrentDate());
      }
      return true;
    }
  }
  return false;
}

// ============================================================================
// AUDIT & CONFIG
// ============================================================================

function logAudit(entityType, entityId, action, actorType, actorId, actorEmail, changes, metadata) {
  try {
    appendRow('AuditLog', {
      log_id: generateUUID(),
      entity_type: entityType,
      entity_id: entityId,
      action: action,
      actor_type: actorType,
      actor_id: actorId,
      actor_email: actorEmail,
      actor_ip: (metadata && metadata.ip) || '',
      actor_user_agent: (metadata && metadata.userAgent) || '',
      changes: JSON.stringify(changes || {}),
      metadata: JSON.stringify(metadata || {}),
      country_code: (metadata && metadata.countryCode) || '',
      created_at: getCurrentDate()
    });
  } catch (e) { Logger.log('Audit log error: ' + e.message); }
}

function getConfig(key, defaultValue) {
  const row = findRow('Config', 'config_key', key);
  return row ? row.config_value : (defaultValue || '');
}

function setConfig(key, value, updatedBy) {
  const exists = findRow('Config', 'config_key', key);
  if (exists) {
    return updateRow('Config', 'config_key', key, { config_value: value, updated_by: updatedBy || 'SYSTEM' });
  } else {
    appendRow('Config', { config_key: key, config_value: value, value_type: 'STRING', updated_by: updatedBy || 'SYSTEM' });
    return true;
  }
}

function getConfigBoolean(key, defaultValue) {
  return getConfig(key, String(defaultValue || false)).toLowerCase() === 'true';
}

function getConfigNumber(key, defaultValue) {
  return parseInt(getConfig(key, String(defaultValue || 0)), 10) || (defaultValue || 0);
}

// ============================================================================
// CACHING
// ============================================================================

function getCachedSheetData(sheetName, ttlSeconds) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'sheet_' + sheetName;
  const cached = cache.get(cacheKey);
  
  if (cached) {
    try { return JSON.parse(cached); } catch (e) {}
  }
  
  const data = getSheetData(sheetName);
  const jsonData = JSON.stringify(data);
  if (jsonData.length < 100000) {
    cache.put(cacheKey, jsonData, ttlSeconds || 300);
  }
  return data;
}

function clearSheetCache(sheetName) {
  CacheService.getScriptCache().remove('sheet_' + sheetName);
}

function clearAllCaches() {
  const cache = CacheService.getScriptCache();
  for (const sheetName of SHEET_ORDER) {
    cache.remove('sheet_' + sheetName);
  }
}

// ============================================================================
// VERIFICATION & INFO
// ============================================================================

function verifySetup() {
  const results = { success: true, errors: [], warnings: [], sheets: {} };
  try {
    const ss = getDatabase();
    for (const sheetName of SHEET_ORDER) {
      const sheet = ss.getSheetByName(sheetName);
      if (!sheet) {
        results.errors.push('Missing sheet: ' + sheetName);
        results.success = false;
        results.sheets[sheetName] = { exists: false };
      } else {
        results.sheets[sheetName] = { exists: true, rowCount: sheet.getLastRow() - 1 };
      }
    }
  } catch (e) {
    results.success = false;
    results.errors.push('Verification error: ' + e.message);
  }
  return results;
}

function getDatabaseInfo() {
  try {
    const ss = getDatabase();
    return {
      id: ss.getId(),
      name: ss.getName(),
      url: ss.getUrl(),
      sheets: SHEET_ORDER.length,
      version: getConfig('SYSTEM_VERSION', '1.0.0')
    };
  } catch (e) {
    return { error: e.message };
  }
}

function getSchema(sheetName) { return SCHEMAS[sheetName] || null; }
function getSheetNames() { return SHEET_ORDER; }
