/**
 * 00_constants.gs  —  Hass CMS rebuild foundation
 *
 * Exports:
 *   TABLES  logical key  → physical Turso table name  (53 tables)
 *   PK      table name   → primary key column
 *   ENV     runtime constants
 */

// ============================================================================
// TABLES  (logical key → physical table name, 53 entries)
// ============================================================================

var TABLES = {
  // ── Reference / lookup data ───────────────────────────────────────────────
  countries:                'countries',
  segments:                 'segments',
  products:                 'products',
  depots:                   'depots',
  teams:                    'teams',

  // ── Users & auth ─────────────────────────────────────────────────────────
  users:                    'users',
  password_history:         'password_history',
  sessions:                 'sessions',
  password_resets:          'password_resets',
  signup_requests:          'signup_requests',

  // ── RBAC ─────────────────────────────────────────────────────────────────
  roles:                    'roles',
  permissions:              'permissions',
  role_permissions:         'role_permissions',
  user_roles:               'user_roles',

  // ── Branding / system config ──────────────────────────────────────────────
  branding:                 'branding',
  config:                   'config',

  // ── Customers ────────────────────────────────────────────────────────────
  customers:                'customers',
  contacts:                 'contacts',
  delivery_locations:       'delivery_locations',

  // ── Pricing ──────────────────────────────────────────────────────────────
  price_list:               'price_list',
  price_list_items:         'price_list_items',

  // ── Logistics ────────────────────────────────────────────────────────────
  vehicles:                 'vehicles',
  drivers:                  'drivers',

  // ── Orders ───────────────────────────────────────────────────────────────
  orders:                   'orders',
  order_lines:              'order_lines',
  order_status_history:     'order_status_history',
  invoices:                 'invoices',
  payment_uploads:          'payment_uploads',

  // ── Approvals ────────────────────────────────────────────────────────────
  po_approvals:             'po_approvals',
  approval_workflows:       'approval_workflows',
  approval_requests:        'approval_requests',

  // ── Documents ────────────────────────────────────────────────────────────
  documents:                'documents',

  // ── SLA ──────────────────────────────────────────────────────────────────
  sla_config:               'sla_config',
  sla_data:                 'sla_data',
  business_hours:           'business_hours',
  holidays:                 'holidays',

  // ── Support tickets ──────────────────────────────────────────────────────
  tickets:                  'tickets',
  ticket_comments:          'ticket_comments',
  ticket_attachments:       'ticket_attachments',
  ticket_history:           'ticket_history',

  // ── Notifications ────────────────────────────────────────────────────────
  notifications:            'notifications',
  notification_preferences: 'notification_preferences',
  notification_templates:   'notification_templates',

  // ── Staff messaging ───────────────────────────────────────────────────────
  staff_messages:           'staff_messages',

  // ── Knowledge base ───────────────────────────────────────────────────────
  knowledge_categories:     'knowledge_categories',
  knowledge_articles:       'knowledge_articles',

  // ── System logs & queues ─────────────────────────────────────────────────
  audit_log:                'audit_log',
  integration_log:          'integration_log',
  job_queue:                'job_queue',

  // ── Recurring orders ─────────────────────────────────────────────────────
  recurring_schedule:       'recurring_schedule',
  recurring_schedule_lines: 'recurring_schedule_lines',

  // ── CRM / retention ──────────────────────────────────────────────────────
  churn_risk_factors:       'churn_risk_factors',
  retention_activities:     'retention_activities',
};

// ============================================================================
// PK  (table name → primary key column, 53 entries)
// ============================================================================

var PK = {
  countries:                'country_code',
  segments:                 'segment_id',
  products:                 'product_id',
  depots:                   'depot_id',
  teams:                    'team_id',

  users:                    'user_id',
  password_history:         'history_id',
  sessions:                 'session_id',
  password_resets:          'email',
  signup_requests:          'request_id',

  roles:                    'role_code',
  permissions:              'permission_code',
  role_permissions:         'id',
  user_roles:               'id',

  branding:                 'scope_code',
  config:                   'config_key',

  customers:                'customer_id',
  contacts:                 'contact_id',
  delivery_locations:       'location_id',

  price_list:               'price_id',
  price_list_items:         'item_id',

  vehicles:                 'vehicle_id',
  drivers:                  'driver_id',

  orders:                   'order_id',
  order_lines:              'line_id',
  order_status_history:     'history_id',
  invoices:                 'invoice_id',
  payment_uploads:          'upload_id',

  po_approvals:             'po_number',
  approval_workflows:       'workflow_id',
  approval_requests:        'request_id',

  documents:                'document_id',

  sla_config:               'sla_id',
  sla_data:                 'log_id',
  business_hours:           'hours_id',
  holidays:                 'holiday_id',

  tickets:                  'ticket_id',
  ticket_comments:          'comment_id',
  ticket_attachments:       'attachment_id',
  ticket_history:           'history_id',

  notifications:            'notification_id',
  notification_preferences: 'preference_id',
  notification_templates:   'template_id',

  staff_messages:           'message_id',

  knowledge_categories:     'category_id',
  knowledge_articles:       'article_id',

  audit_log:                'log_id',
  integration_log:          'log_id',
  job_queue:                'job_id',

  recurring_schedule:       'schedule_id',
  recurring_schedule_lines: 'line_id',

  churn_risk_factors:       'factor_id',
  retention_activities:     'activity_id',
};

// ============================================================================
// ENV  (runtime constants)
// ============================================================================

var ENV = {
  APP_NAME:    'Hass CMS',
  APP_VERSION: '4.0.0',
  TIMEZONE:    'Africa/Nairobi',
  LOG_LEVEL:   'INFO',   // DEBUG | INFO | WARN | ERROR
};

// ============================================================================
// FEATURES  (server-side feature flags)
// ============================================================================
//
// Independent on/off switches for additive behaviour. Each defaults so that the
// app behaves EXACTLY as it did before the feature existed when the flag is off.
//
// WRITE_IDEMPOTENCY (Part 4 of the responsiveness redo): when on, a write that
// carries an optional `idempotencyKey` is deduped per (user, key) so a
// double-fire returns the first call's result instead of running twice. It is
// applied in ONE place, the dispatcher (see 30_dispatcher.gs `_invokeHandler`),
// never at the register() sites, so it can never break action registration the
// way the reverted PR #165 did. Reads never carry a key, so reads are untouched.
// Set to false for behaviour byte-identical to current main.
var FEATURES = {
  WRITE_IDEMPOTENCY: true,
};
