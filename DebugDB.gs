/**
 * HASS PETROLEUM CMS - DebugDB.gs
 *
 * Front-end / Turso schema gap detector.
 *
 * WORKFLOW
 * --------
 *  1. Run `debugFrontend()` from the Apps Script editor.
 *  2. Copy the JSON block printed at the very end of the Execution log.
 *  3. Paste it back to Claude. Claude will produce the exact CREATE TABLE /
 *     ALTER TABLE / CREATE INDEX statements needed and (separately) point
 *     out any duplicate / contradictory column names so we don't end up
 *     with two ways to spell the same thing.
 *
 * WHAT IT CHECKS
 * --------------
 *  A. Connection + script properties.
 *  B. For every table the front-end touches:
 *       - existence
 *       - row count (flag empty tables that need seed data)
 *       - actual columns (PRAGMA table_info)
 *       - actual indexes (PRAGMA index_list)
 *       - actual foreign keys (PRAGMA foreign_key_list)
 *  C. Compares actual columns with the EXPECTED_SCHEMA below
 *     (assembled from Staffdashboard.html, Customerportal.html, all *.gs
 *     services) and reports MISSING columns and EXTRA columns.
 *  D. Runs the exact SQL the dashboard / orders / tickets / SLA /
 *     statements / chat / settings pages run, captures any SQL error
 *     verbatim (this is how we catch silent column-name mismatches).
 *  E. Detects KNOWN_DUPLICATIONS where the front-end and back-end use two
 *     different names for the same logical field.
 *
 * The script writes nothing to the database. Pure read-only.
 */

// ============================================================================
// EXPECTED_SCHEMA  - what the front-end actually needs
// Each table lists:
//   pk:        primary key column
//   required:  columns the front-end / services read or write
//   indexes:   indexes the queries below assume (for performance)
//   notes:     any constraint / seed / known-issue notes
// ============================================================================

var EXPECTED_SCHEMA = {

  // ----- CORE LOOKUPS -----------------------------------------------------
  countries: {
    pk: 'country_code',
    required: ['country_code','country_name','affiliate_code','currency_code','timezone','dialing_code','is_active'],
    indexes: [],
    notes: 'Seed required: KE,UG,TZ,RW,SS,ZM,DRC,HTW'
  },
  segments: {
    pk: 'segment_id',
    required: ['segment_id','segment_name','description','min_volume','max_volume','credit_terms_days','discount_percentage','priority_level','is_active'],
    indexes: []
  },
  config: {
    pk: 'config_key',
    required: ['config_key','config_value','value_type','description','is_encrypted','country_code','updated_by','updated_at'],
    indexes: [],
    notes: 'value_type CHECK (STRING,NUMBER,BOOLEAN,JSON)'
  },

  // ----- USERS / AUTH -----------------------------------------------------
  users: {
    pk: 'user_id',
    required: ['user_id','email','first_name','last_name','phone','role','team_id','country_code','countries_access','reports_to','can_approve_orders','approval_limit','max_tickets','status','password_hash','created_at','updated_at'],
    indexes: ['ix_users_email (email)','ix_users_role (role)','ix_users_status (status)'],
    notes: 'UNIQUE(email); status CHECK (ACTIVE,INACTIVE,SUSPENDED)'
  },
  contacts: {
    pk: 'contact_id',
    required: ['contact_id','customer_id','first_name','last_name','email','phone','job_title','department','contact_type','is_portal_user','password_hash','auth_provider','auth_uid','failed_login_attempts','locked_until','last_login_at','status','created_at','updated_at'],
    indexes: ['ix_contacts_customer (customer_id)','ix_contacts_email (email)'],
    notes: 'FK customer_id -> customers(customer_id); UNIQUE(email) where email IS NOT NULL'
  },
  teams: {
    pk: 'team_id',
    required: ['team_id','team_name','department','country_code','team_lead_id','assignment_method','auto_assign','is_active','created_at'],
    indexes: ['ix_teams_country (country_code)']
  },
  sessions: {
    pk: 'session_id',
    required: ['session_id','user_id','user_type','role','token_hash','is_active','expires_at','created_at','updated_at'],
    indexes: ['ix_sessions_token (token_hash)','ix_sessions_user (user_id)'],
    notes: 'UNIQUE(token_hash); used by handleAuthRequest validateSession'
  },
  password_resets: {
    pk: 'email',
    required: ['email','otp_hash','expires_at','user_type','user_id','used','created_at']
  },
  signup_requests: {
    pk: 'request_id',
    required: ['request_id','company_name','first_name','last_name','email','phone','account_type','customer_id','job_title','kra_pin','tax_pin','account_number','certificate_of_incorporation','company_address','card_number','dealer_code','station_name','kyc_status','submitted_at','status'],
    notes: 'status CHECK (PENDING_APPROVAL,APPROVED,REJECTED)'
  },

  // ----- RBAC -------------------------------------------------------------
  roles:            { pk: 'role_code',
                      required: ['role_code','role_name','description','is_system','created_at','updated_at'] },
  permissions:      { pk: 'permission_code',
                      required: ['permission_code','label','category','description','created_at'] },
  role_permissions: { pk: '(role_code,permission_code)',
                      required: ['role_code','permission_code','granted_at'],
                      notes: 'composite PK; FK role_code -> roles, FK permission_code -> permissions' },
  user_roles:       { pk: '(user_id,role_code)',
                      required: ['user_id','role_code','assigned_by','assigned_at'],
                      indexes: ['ix_user_roles_user (user_id)'],
                      notes: 'composite PK; FK user_id -> users, FK role_code -> roles' },

  // ----- CUSTOMERS ---------------------------------------------------------
  // The Staff dashboard reads MORE columns than the SCHEMAS object declares.
  // See KNOWN_DUPLICATIONS below for the oracle_customer_id vs _code conflict.
  customers: {
    pk: 'customer_id',
    required: [
      'customer_id','account_number','company_name','trading_name','segment_id','country_code',
      'tax_pin','registration_number','email','phone','address','city','website',
      'payment_terms','credit_limit','credit_used','currency_code',
      // FRONT-END EXTRAS used in Staffdashboard.html lines 4823-4838 + 4774-4781:
      'customer_type',          // B2B | B2C | GOVERNMENT
      'industry',
      'oracle_customer_code',   // FRONT-END NAME (back-end writes oracle_customer_id - CONFLICT)
      'affiliate_code',         // dashboard expects this on customer row
      'lifetime_value',
      'risk_level',             // LOW | MEDIUM | HIGH
      'notes',
      'relationship_owner_id','status','onboarding_status','created_at','updated_at'
    ],
    indexes: [
      'ix_customers_country (country_code)',
      'ix_customers_status (status)',
      'ix_customers_segment (segment_id)',
      'ix_customers_account_number (account_number)'
    ],
    notes: 'UNIQUE(account_number); status CHECK (ACTIVE,SUSPENDED,ON_HOLD,CLOSED,DELETED); customer_type CHECK (B2B,B2C,GOVERNMENT); risk_level CHECK (LOW,MEDIUM,HIGH)'
  },

  // ----- ORDERS ------------------------------------------------------------
  orders: {
    pk: 'order_id',
    required: [
      'order_id','order_number','oracle_order_id','customer_id','contact_id',
      'delivery_location_id','source_depot_id','price_list_id',
      'requested_date','requested_time_from','requested_time_to','confirmed_date','confirmed_time',
      'status','payment_status','subtotal','tax_amount','delivery_fee','discount_amount','total_amount','currency_code',
      'special_instructions','po_number','is_recurring','recurring_schedule_id',
      'vehicle_id','driver_id',
      'submitted_at','approved_at','approved_by','dispatched_at','delivered_at',
      'cancelled_at','cancelled_by','cancelled_reason','delivery_notes','delivery_confirmed_by',
      'invoice_number','invoice_date','created_by_type','created_by_id',
      'country_code','created_at','updated_at'
    ],
    indexes: [
      'ix_orders_customer (customer_id)',
      'ix_orders_status (status)',
      'ix_orders_country (country_code)',
      'ix_orders_created (created_at)',
      'ix_orders_number (order_number)'
    ],
    notes: 'FK customer_id -> customers; status CHECK (DRAFT,SUBMITTED,PENDING_APPROVAL,APPROVED,REJECTED,SCHEDULED,LOADING,LOADED,IN_TRANSIT,DELIVERED,PARTIALLY_DELIVERED,CANCELLED,ON_HOLD); UNIQUE(order_number)'
  },
  order_lines: {
    pk: 'line_id',
    required: ['line_id','order_id','product_id','product_name','quantity','unit_of_measure','unit_price','discount_percent','tax_rate','line_subtotal','line_tax','line_total','delivered_quantity','delivery_variance_reason','created_at'],
    indexes: ['ix_order_lines_order (order_id)'],
    notes: 'FK order_id -> orders ON DELETE CASCADE'
  },
  order_status_history: {
    pk: 'history_id',
    required: ['history_id','order_id','from_status','to_status','changed_by_type','changed_by_id','reason','created_at'],
    indexes: ['ix_osh_order (order_id)']
  },
  recurring_schedule: {
    pk: 'schedule_id',
    required: ['schedule_id','customer_id','frequency','start_date','end_date','next_run_at','is_active','created_at','updated_at']
  },
  recurring_schedule_lines: {
    pk: 'line_id',
    required: ['line_id','schedule_id','product_id','quantity','unit_price','created_at']
  },
  delivery_locations: {
    pk: 'location_id',
    required: ['location_id','customer_id','location_name','address','city','county','country_code','latitude','longitude','contact_name','contact_phone','is_default','is_active','created_at','updated_at'],
    indexes: ['ix_locations_customer (customer_id)']
  },
  price_list: {
    pk: 'price_id',
    required: ['price_id','price_list_name','customer_id','segment_id','country_code','currency_code','effective_from','effective_to','is_active','created_at']
  },
  price_list_items: {
    pk: 'item_id',
    required: ['item_id','price_list_id','product_id','unit_price','min_quantity','discount_percent','tax_rate','created_at']
  },
  products: {
    pk: 'product_id',
    required: ['product_id','sku','product_name','category','unit_of_measure','description','is_active','created_at','updated_at']
  },
  depots: {
    pk: 'depot_id',
    required: ['depot_id','depot_name','country_code','address','city','latitude','longitude','is_active','created_at']
  },
  vehicles: {
    pk: 'vehicle_id',
    required: ['vehicle_id','registration_number','vehicle_type','capacity','depot_id','status','is_active','created_at','updated_at']
  },
  drivers: {
    pk: 'driver_id',
    required: ['driver_id','first_name','last_name','phone','license_number','depot_id','status','is_active','created_at','updated_at']
  },
  invoices: {
    pk: 'invoice_id',
    required: ['invoice_id','invoice_number','order_id','customer_id','total_amount','tax_amount','currency_code','issue_date','due_date','status','oracle_invoice_id','created_at','updated_at']
  },
  payment_uploads: {
    pk: 'upload_id',
    required: ['upload_id','customer_id','invoice_id','amount','currency_code','payment_method','reference_number','file_path','uploaded_by','status','created_at']
  },

  // ----- TICKETS -----------------------------------------------------------
  tickets: {
    pk: 'ticket_id',
    required: [
      'ticket_id','ticket_number','customer_id','contact_id','channel','category','subcategory','subject','description',
      'priority','status','assigned_to','assigned_team_id','related_order_id','country_code',
      'sla_config_id','sla_acknowledge_by','sla_response_by','sla_resolve_by',
      'sla_acknowledge_breached','sla_response_breached','sla_resolve_breached',
      'acknowledged_at','first_response_at','resolved_at','closed_at',
      'resolution_type','resolution_summary','root_cause','root_cause_category',
      'satisfaction_rating','satisfaction_comment',
      'escalation_level','escalated_to','escalated_at','escalation_reason',
      'reopened_count','last_reopened_at','merged_into_id','tags',
      'created_by','created_at','updated_at'
    ],
    indexes: [
      'ix_tickets_customer (customer_id)',
      'ix_tickets_status (status)',
      'ix_tickets_country (country_code)',
      'ix_tickets_assigned (assigned_to)',
      'ix_tickets_created (created_at)',
      'ix_tickets_number (ticket_number)'
    ],
    notes: 'priority CHECK (CRITICAL,HIGH,MEDIUM,LOW); status CHECK (NEW,OPEN,IN_PROGRESS,PENDING_CUSTOMER,PENDING_INTERNAL,ESCALATED,RESOLVED,CLOSED,CANCELLED); UNIQUE(ticket_number)'
  },
  ticket_comments: {
    pk: 'comment_id',
    required: ['comment_id','ticket_id','parent_comment_id','author_type','author_id','author_name','content','content_html','is_internal','is_resolution','channel','external_message_id','sentiment','created_at','updated_at'],
    indexes: ['ix_tcomments_ticket (ticket_id)']
  },
  ticket_attachments: {
    pk: 'attachment_id',
    required: ['attachment_id','ticket_id','comment_id','file_name','file_path','file_size','mime_type','uploaded_by_type','uploaded_by_id','is_inline','created_at'],
    indexes: ['ix_tattach_ticket (ticket_id)']
  },
  ticket_history: {
    pk: 'history_id',
    required: ['history_id','ticket_id','field_name','old_value','new_value','changed_by_type','changed_by_id','changed_by_name','change_reason','created_at'],
    indexes: ['ix_thistory_ticket (ticket_id)']
  },

  // ----- SLA ---------------------------------------------------------------
  sla_config: {
    pk: 'sla_id',
    required: ['sla_id','name','priority','channel','category','country_code','acknowledge_minutes','response_minutes','resolve_minutes','is_active','created_at','updated_at']
  },
  business_hours: {
    pk: 'hours_id',
    required: ['hours_id','country_code','day_of_week','start_time','end_time','is_business_day','created_at']
  },
  holidays: {
    pk: 'holiday_id',
    required: ['holiday_id','country_code','holiday_date','holiday_name','is_recurring','created_at']
  },
  sla_data: {
    pk: 'log_id',
    required: ['log_id','reference_type','reference_id','event_type','recorded_at','duration_min','breached','department','staff_id','country_code','created_at']
  },
  po_approvals: {
    pk: 'po_number',
    required: ['po_number','customer_id','amount','currency_code','requested_at','approver_name','approved_at','duration_hours','status','country_code','created_at']
  },
  approval_workflows: {
    pk: 'workflow_id',
    required: ['workflow_id','workflow_name','entity_type','rules','is_active','created_at']
  },

  // ----- DOCUMENTS ---------------------------------------------------------
  documents: {
    pk: 'document_id',
    required: ['document_id','customer_id','document_type','document_name','file_name','file_path','file_id','file_size','mime_type','issue_date','expiry_date','issuing_authority','document_number','status','verification_notes','verified_by','verified_at','uploaded_by_id','created_at','updated_at'],
    indexes: ['ix_documents_customer (customer_id)','ix_documents_type (document_type)']
  },

  // ----- CHAT --------------------------------------------------------------
  staff_messages: {
    pk: 'message_id',
    required: ['message_id','room_id','room_type','sender_id','sender_name','content','read_by','created_at','updated_at'],
    indexes: ['ix_staff_messages_room (room_id, created_at)'],
    notes: 'Used by Staff dashboard chat polling; room_type CHECK (CHANNEL,DM,GROUP)'
  },

  // ----- NOTIFICATIONS -----------------------------------------------------
  notifications: {
    pk: 'notification_id',
    required: ['notification_id','user_id','user_type','type','title','message','reference_type','reference_id','is_read','created_at'],
    indexes: ['ix_notifications_user (user_id, is_read)']
  },
  notification_preferences: {
    pk: 'preference_id',
    required: ['preference_id','recipient_type','recipient_id','channel','event_type','enabled','created_at']
  },
  notification_templates: {
    pk: 'template_id',
    required: ['template_id','event_type','channel','subject','body','language','is_active','created_at']
  },

  // ----- KNOWLEDGE ---------------------------------------------------------
  knowledge_categories: {
    pk: 'category_id',
    required: ['category_id','category_name','description','parent_category_id','sort_order','is_active','created_at']
  },
  knowledge_articles: {
    pk: 'article_id',
    required: ['article_id','category_id','title','slug','content','tags','views','is_published','created_by','created_at','updated_at']
  },

  // ----- LOGS / QUEUES -----------------------------------------------------
  audit_log: {
    pk: 'log_id',
    required: ['log_id','entity_type','entity_id','action','actor_type','actor_id','actor_email','actor_ip','actor_user_agent','changes','metadata','country_code','created_at'],
    indexes: ['ix_audit_entity (entity_type, entity_id)','ix_audit_created (created_at)']
  },
  integration_log: {
    pk: 'log_id',
    required: ['log_id','integration','direction','endpoint','method','request_body','response_body','status_code','error_message','duration_ms','reference_type','reference_id','created_at'],
    indexes: ['ix_intlog_integration (integration, created_at)']
  },
  job_queue: {
    pk: 'job_id',
    required: ['job_id','type','payload','status','attempts','next_run_at','created_at','completed_at','error'],
    indexes: ['ix_jobq_status (status, next_run_at)']
  },

  // ----- CHURN / RETENTION (referenced via TABLE_MAP) ----------------------
  churn_risk_factors: {
    pk: 'factor_id',
    required: ['factor_id','customer_id','factor_type','score','recorded_at','notes','created_at']
  },
  retention_activities: {
    pk: 'activity_id',
    required: ['activity_id','customer_id','activity_type','outcome','performed_by','performed_at','notes','created_at']
  }
};

// ============================================================================
// KNOWN DUPLICATIONS / NAME CONFLICTS
// These are places where the front-end uses one column name but the
// service-layer writes a different one. Pick ONE canonical name and migrate.
// ============================================================================

var KNOWN_DUPLICATIONS = [
  {
    table: 'customers',
    frontend_uses: 'oracle_customer_code',
    backend_writes: 'oracle_customer_id',
    seen_in: ['Staffdashboard.html:4826','DatabaseSetup.gs SCHEMAS.Customers'],
    recommendation: 'Keep ONE column. Suggest: rename oracle_customer_id to oracle_customer_code (front-end name), then update DatabaseSetup.gs SCHEMAS + Orderservice.gs writers.'
  },
  {
    table: 'tickets',
    frontend_uses: 'sla_resolve_deadline',
    backend_writes: 'sla_resolve_by',
    seen_in: ['Staffdashboard.html:5138','Ticketservice.gs:115,275'],
    recommendation: 'Keep sla_resolve_by (matches sla_acknowledge_by / sla_response_by family). Update Staffdashboard.html line 5138 to read t.sla_resolve_by.'
  }
];

// ============================================================================
// FRONTEND QUERIES
// The exact (or representative) SQL each page runs. Running these surfaces
// silent column-name mismatches as "no such column" SQL errors.
// ============================================================================

var FRONTEND_QUERIES = {
  // Staff dashboard tiles
  'staff_dashboard.openTickets':
    "SELECT COUNT(*) AS n FROM tickets WHERE status IN ('NEW','OPEN','IN_PROGRESS','ESCALATED')",
  'staff_dashboard.pendingOrders':
    "SELECT COUNT(*) AS n FROM orders WHERE status IN ('SUBMITTED','PENDING_APPROVAL','APPROVED')",
  'staff_dashboard.inTransitOrders':
    "SELECT COUNT(*) AS n FROM orders WHERE status = 'IN_TRANSIT'",
  'staff_dashboard.recentOrders':
    'SELECT order_number,status,country_code,total_amount,created_at FROM orders ORDER BY created_at DESC LIMIT 5',
  'staff_dashboard.unreadStaffMessages':
    "SELECT COUNT(*) AS n FROM staff_messages WHERE read_by IS NULL OR read_by NOT LIKE '%ALL%'",

  // Orders page table load
  'orders_page.list':
    'SELECT order_id,order_number,customer_id,country_code,total_amount,currency_code,status,payment_status,requested_date,delivered_at,created_at,updated_at,special_instructions FROM orders ORDER BY created_at DESC LIMIT 200',
  'orders_page.lines_for_one':
    'SELECT line_id,order_id,product_id,product_name,quantity,unit_price,line_total FROM order_lines LIMIT 1',

  // Tickets page table load
  'tickets_page.list':
    'SELECT ticket_id,ticket_number,subject,description,customer_id,channel,category,priority,status,assigned_to,sla_resolve_by,sla_resolve_breached,created_at,resolved_at FROM tickets ORDER BY created_at DESC LIMIT 200',
  // This is what the front-end ACTUALLY tries (note the mismatched column):
  'tickets_page.list_AS_FRONTEND_USES':
    'SELECT ticket_id,ticket_number,sla_resolve_deadline,sla_resolve_breached FROM tickets LIMIT 1',
  'tickets_page.comments_for_one':
    'SELECT comment_id,ticket_id,author_type,author_id,author_name,content,is_internal,channel,created_at FROM ticket_comments LIMIT 1',

  // Customers page (staff)
  'customers_page.list':
    'SELECT customer_id,account_number,company_name,trading_name,customer_type,country_code,industry,payment_terms,oracle_customer_code,affiliate_code,credit_limit,credit_used,currency_code,lifetime_value,risk_level,onboarding_status,relationship_owner_id,notes,status FROM customers LIMIT 200',

  // Chat (staff)
  'chat.recent_in_room':
    'SELECT message_id,room_id,room_type,sender_id,sender_name,content,created_at FROM staff_messages ORDER BY created_at DESC LIMIT 1',

  // Customer portal
  'portal.recent_orders_for_customer':
    "SELECT order_id,order_number,status,total_amount,created_at FROM orders WHERE customer_id = '__none__' ORDER BY created_at DESC LIMIT 5",
  'portal.open_tickets_for_customer':
    "SELECT ticket_id,ticket_number,subject,status,priority,created_at FROM tickets WHERE customer_id = '__none__' LIMIT 5",
  'portal.documents_for_customer':
    "SELECT document_id,document_type,document_name,expiry_date,status,file_path FROM documents WHERE customer_id = '__none__' LIMIT 5",
  'portal.delivery_locations':
    "SELECT location_id,location_name,address,city,country_code,is_default FROM delivery_locations WHERE customer_id = '__none__'",
  'portal.contacts_for_customer':
    "SELECT contact_id,first_name,last_name,email,phone,job_title,contact_type,is_portal_user FROM contacts WHERE customer_id = '__none__'",

  // SLA analytics
  'sla.staff_list':
    "SELECT user_id,first_name,last_name,role FROM users WHERE status = 'ACTIVE' ORDER BY first_name",
  'sla.po_approvals':
    'SELECT po_number,approver_name,duration_hours,country_code,created_at FROM po_approvals ORDER BY created_at DESC LIMIT 1',
  'sla.business_hours':
    'SELECT country_code,day_of_week,start_time,end_time,is_business_day FROM business_hours LIMIT 1',
  'sla.sla_data':
    'SELECT log_id,reference_type,reference_id,event_type,recorded_at,duration_min,breached,department FROM sla_data LIMIT 1',

  // Settings - backup is in Script Properties, but config is the table:
  'settings.config_backup_keys':
    "SELECT config_key,config_value FROM config WHERE config_key LIKE 'BACKUP_%' OR config_key LIKE 'ONEDRIVE_%'",
  'settings.config_scanner_keys':
    "SELECT config_key,config_value FROM config WHERE config_key LIKE 'EMAIL_SCANNER_%' OR config_key LIKE 'WHATSAPP_SCANNER_%' OR config_key LIKE 'CALL_SCANNER_%'",

  // Auth
  'auth.session_lookup_shape':
    'SELECT session_id,user_id,user_type,role,token_hash,is_active,expires_at FROM sessions LIMIT 1',
  'auth.signup_requests':
    "SELECT request_id,company_name,email,kyc_status,status FROM signup_requests WHERE status = 'PENDING_APPROVAL' LIMIT 5"
};

// ============================================================================
// MAIN ENTRY - run this from the Apps Script editor
// ============================================================================

function debugFrontend() {
  var report = {
    timestamp:  new Date().toISOString(),
    connection: null,
    scriptProperties: {},
    allTables:  [],
    perTable:   {},                 // { table: { exists, rowCount, columns, indexes, fks, missingColumns, extraColumns, notes } }
    queries:    {},                 // { queryName: { sql, ok, error, sample } }
    duplications: KNOWN_DUPLICATIONS,
    suggestedDDL: [],               // CREATE / ALTER / INDEX statements
    summary: {
      tablesExpected: Object.keys(EXPECTED_SCHEMA).length,
      tablesPresent:  0,
      tablesMissing:  0,
      columnsMissing: 0,
      emptyTables:    0,
      queriesFailed:  0
    }
  };

  // ----- 1. Connection ----------------------------------------------------
  try {
    var ping = tursoSelect('SELECT 1 AS ping');
    report.connection = (ping.length && (ping[0].ping == 1 || ping[0].ping === '1'))
      ? 'OK' : 'UNEXPECTED: ' + JSON.stringify(ping);
  } catch (e) {
    report.connection = 'FAIL: ' + e.message;
    Logger.log('Cannot reach Turso. Check TURSO_URL / TURSO_TOKEN.');
    Logger.log('================ DEBUG FRONTEND REPORT ================');
    Logger.log(JSON.stringify(report, null, 2));
    return report;
  }

  // ----- 2. Script properties (non-secret) --------------------------------
  try {
    var props = PropertiesService.getScriptProperties().getProperties();
    report.scriptProperties = {
      TURSO_URL_set:   !!props.TURSO_URL,
      TURSO_TOKEN_set: !!props.TURSO_TOKEN,
      SPREADSHEET_ID_set: !!props.SPREADSHEET_ID,
      keys: Object.keys(props).sort()
    };
  } catch (e) {
    report.scriptProperties = { error: e.message };
  }

  // ----- 3. List all tables in DB ----------------------------------------
  var presentTables = {};
  try {
    var tlist = tursoSelect("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    report.allTables = tlist.map(function(r) { return r.name; });
    report.allTables.forEach(function(n) { presentTables[n] = true; });
  } catch (e) {
    report.allTables = ['ERROR: ' + e.message];
  }

  // ----- 4. Inspect every expected table ---------------------------------
  Object.keys(EXPECTED_SCHEMA).forEach(function(tbl) {
    var expected = EXPECTED_SCHEMA[tbl];
    var entry = {
      exists:     false,
      rowCount:   null,
      pkExpected: expected.pk,
      columns:    [],          // [{name,type,notnull,pk,dflt}]
      indexes:    [],          // [{name,unique,cols}]
      fks:        [],
      missingColumns: [],
      extraColumns:   [],
      missingIndexes: [],
      notes:      expected.notes || ''
    };

    if (!presentTables[tbl]) {
      report.perTable[tbl] = entry;
      report.summary.tablesMissing++;
      report.suggestedDDL.push(_ddlCreateTablePlaceholder(tbl, expected));
      return;
    }
    entry.exists = true;
    report.summary.tablesPresent++;

    // row count
    try {
      var c = tursoSelect('SELECT COUNT(*) AS n FROM ' + tbl);
      entry.rowCount = c.length ? parseInt(c[0].n, 10) : 0;
      if (entry.rowCount === 0) report.summary.emptyTables++;
    } catch (e) {
      entry.rowCount = 'COUNT ERROR: ' + e.message;
    }

    // columns
    try {
      var cols = tursoSelect("PRAGMA table_info('" + tbl + "')");
      entry.columns = cols.map(function(c) {
        return {
          name:    c.name,
          type:    c.type,
          notnull: c.notnull == 1 || c.notnull === '1',
          pk:      c.pk == 1 || c.pk === '1',
          dflt:    c.dflt_value
        };
      });
      var actualSet = {};
      entry.columns.forEach(function(c) { actualSet[c.name] = true; });

      expected.required.forEach(function(col) {
        if (!actualSet[col]) entry.missingColumns.push(col);
      });
      report.summary.columnsMissing += entry.missingColumns.length;

      var expectedSet = {};
      expected.required.forEach(function(c) { expectedSet[c] = true; });
      entry.columns.forEach(function(c) {
        if (!expectedSet[c.name]) entry.extraColumns.push(c.name);
      });

      if (entry.missingColumns.length) {
        report.suggestedDDL.push(_ddlAddColumns(tbl, entry.missingColumns));
      }
    } catch (e) {
      entry.columns = ['SCHEMA ERROR: ' + e.message];
    }

    // indexes
    try {
      var idxList = tursoSelect("PRAGMA index_list('" + tbl + "')");
      entry.indexes = idxList.map(function(i) { return { name: i.name, unique: i.unique == 1 }; });
      var existingIdxNames = entry.indexes.map(function(i) { return i.name; });
      (expected.indexes || []).forEach(function(idxSpec) {
        var nm = idxSpec.split(' ')[0];
        if (existingIdxNames.indexOf(nm) === -1) {
          entry.missingIndexes.push(idxSpec);
          report.suggestedDDL.push('CREATE INDEX IF NOT EXISTS ' + idxSpec.replace(' ', ' ON ' + tbl) + ';');
        }
      });
    } catch (e) {
      entry.indexes = ['INDEX ERROR: ' + e.message];
    }

    // foreign keys
    try {
      var fks = tursoSelect("PRAGMA foreign_key_list('" + tbl + "')");
      entry.fks = fks.map(function(f) { return f.from + ' -> ' + f.table + '.' + f.to; });
    } catch (e) {
      entry.fks = ['FK ERROR: ' + e.message];
    }

    report.perTable[tbl] = entry;
  });

  // ----- 5. Run frontend queries ----------------------------------------
  Object.keys(FRONTEND_QUERIES).forEach(function(name) {
    var sql = FRONTEND_QUERIES[name];
    var qr  = { sql: sql, ok: false, error: null, rows: 0 };
    try {
      var rows = tursoSelect(sql);
      qr.ok = true;
      qr.rows = rows.length;
    } catch (e) {
      qr.error = e.message;
      report.summary.queriesFailed++;
    }
    report.queries[name] = qr;
  });

  // ----- 6. Pretty log + machine-readable JSON --------------------------
  Logger.log('================ DEBUG FRONTEND REPORT ================');
  Logger.log('Connection: '       + report.connection);
  Logger.log('Tables in DB: '     + report.allTables.length);
  Logger.log('Tables expected: '  + report.summary.tablesExpected);
  Logger.log('Tables missing: '   + report.summary.tablesMissing);
  Logger.log('Columns missing: '  + report.summary.columnsMissing);
  Logger.log('Empty tables: '     + report.summary.emptyTables);
  Logger.log('Queries failed: '   + report.summary.queriesFailed);
  Logger.log('--- Missing tables ---');
  Object.keys(report.perTable).forEach(function(t) {
    if (!report.perTable[t].exists) Logger.log('  MISSING: ' + t);
  });
  Logger.log('--- Tables with missing columns ---');
  Object.keys(report.perTable).forEach(function(t) {
    var e = report.perTable[t];
    if (e.exists && e.missingColumns.length) {
      Logger.log('  ' + t + ' (' + e.rowCount + ' rows): missing ' + e.missingColumns.join(', '));
    }
  });
  Logger.log('--- Failed queries ---');
  Object.keys(report.queries).forEach(function(q) {
    var r = report.queries[q];
    if (!r.ok) Logger.log('  ' + q + ': ' + r.error);
  });
  Logger.log('--- Known name conflicts ---');
  KNOWN_DUPLICATIONS.forEach(function(d) {
    Logger.log('  [' + d.table + '] FE uses ' + d.frontend_uses + ' / BE writes ' + d.backend_writes);
  });

  Logger.log('');
  Logger.log('===== COPY EVERYTHING BELOW THIS LINE AND PASTE BACK =====');
  Logger.log('===== DEBUG_FRONTEND_JSON_BEGIN =====');
  Logger.log(JSON.stringify(report));
  Logger.log('===== DEBUG_FRONTEND_JSON_END =====');

  return report;
}

// ============================================================================
// SUGGESTED-DDL HELPERS
// (only sketches the statements - Claude will produce the final, correctly
// typed CREATE TABLE statements after you paste the report back.)
// ============================================================================

function _ddlCreateTablePlaceholder(tbl, expected) {
  return '-- TODO CREATE TABLE ' + tbl +
         ' ( PRIMARY KEY ' + expected.pk + ', columns: ' + expected.required.join(', ') + ' )' +
         (expected.notes ? '   -- ' + expected.notes : '');
}

function _ddlAddColumns(tbl, cols) {
  return cols.map(function(c) {
    return 'ALTER TABLE ' + tbl + ' ADD COLUMN ' + c + ' TEXT;  -- TODO confirm type/constraint';
  }).join('\n');
}

// ============================================================================
// LEGACY HELPERS (kept for backward compatibility - safe to delete later)
// ============================================================================

function debugDB() {
  // Old narrow-focus debug. Kept so existing bookmarks / triggers still work.
  // For full coverage use debugFrontend().
  return debugFrontend();
}

function debugQuery() {
  var sql = "SELECT order_id, order_number, status, country_code, customer_id, created_at " +
            "FROM orders ORDER BY created_at DESC LIMIT 20";
  var rows = tursoSelect(sql);
  Logger.log('Rows: ' + rows.length);
  Logger.log(JSON.stringify(rows, null, 2));
  return rows;
}
