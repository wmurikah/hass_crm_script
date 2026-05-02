/**
 * HASS PETROLEUM CMS — CustomerStatementsService.gs
 * Version: 1.0.0
 *
 * Customer account statements pulled from Oracle EBS (AWS).
 *
 * Flow:
 *   1) Resolve the customer's oracle_customer_code (from Customers table).
 *   2) Call Oracle EBS REST endpoints via Integrationservice.callOracleApi():
 *        GET /customers/:oracleId/invoices?from=&to=
 *        GET /customers/:oracleId/payments?from=&to=
 *        GET /customers/:oracleId/balance
 *   3) Compose a statement object: opening balance, line items
 *      (invoices + payments interleaved by date), closing balance, ageing.
 *   4) Cache the result in Turso.invoices / Turso.payment_uploads when fresh
 *      so the customer can re-render the statement offline.
 *
 * Public API:
 *   handleStatementRequest(params)             - dispatcher (registered in Code.gs)
 *   runCustomerStatement(customerId, range)    - main entry — returns statement
 *   getCachedStatement(customerId, range)      - read cached without refetch
 *   exportStatementCsv(statement)              - returns CSV string
 *
 * Permissions:
 *   - Staff users: 'customers.statements'
 *   - Customer portal users: 'portal.run_statement' (or self-serve, see below)
 */

// ============================================================================
// REQUEST DISPATCHER
// ============================================================================

function handleStatementRequest(params) {
  try {
    var action  = params.action;
    var session = params._session;
    var range   = params.range || _defaultStatementRange();

    // For customer portal: ensure they can only see their own statement
    var customerId = params.customerId;
    if (session && session.userType === 'CUSTOMER') {
      try {
        var contact = findRow('Contacts', 'contact_id', session.userId);
        var ownCustomerId = contact && contact.customer_id;
        if (!ownCustomerId) return { success: false, error: 'No customer linked to your account' };
        customerId = ownCustomerId;
        if (!userHasPermission(session.userId, 'portal.run_statement')) {
          // Customer role baseline grants portal.run_statement; if revoked, block.
          return { success: false, error: 'Statement access disabled for your account. Contact support.' };
        }
      } catch(e) {
        return { success: false, error: 'Auth lookup failed: ' + e.message };
      }
    } else if (session) {
      requirePermission(session, 'customers.statements');
    }

    switch (action) {
      case 'run':         return runCustomerStatement(customerId, range, { force: !!params.force });
      case 'cached':      return getCachedStatement(customerId, range);
      case 'csv':         return { success: true, csv: exportStatementCsv(runCustomerStatement(customerId, range).statement) };
      default:
        return { success: false, error: 'Unknown statement action: ' + action };
    }
  } catch(e) {
    Logger.log('[Statements] ' + e.message);
    return { success: false, error: e.message };
  }
}

// ============================================================================
// MAIN ENTRY
// ============================================================================

/**
 * Runs an account statement for the given customer.
 * @param {string} customerId  - internal CMS customer_id
 * @param {{from:string,to:string}} range - YYYY-MM-DD bounds (inclusive)
 * @param {Object} [opts]      - { force: bool } to bypass cache
 */
function runCustomerStatement(customerId, range, opts) {
  opts = opts || {};
  if (!customerId) return { success: false, error: 'customerId required' };
  range = _normalizeRange(range);

  var customer = getById('Customers', customerId);
  if (!customer) return { success: false, error: 'Customer not found' };

  var oracleId = customer.oracle_customer_code || customer.oracle_customer_id;
  var statement = {
    customer_id:    customerId,
    company_name:   customer.company_name || '',
    account_number: customer.account_number || '',
    currency_code:  customer.currency_code || 'KES',
    range:          range,
    generated_at:   new Date().toISOString(),
    source:         'ORACLE_EBS',
    invoices:       [],
    payments:       [],
    lines:          [],
    summary:        { opening_balance: 0, total_invoiced: 0, total_paid: 0, closing_balance: 0 },
    ageing:         { current: 0, days_30: 0, days_60: 0, days_90: 0, days_over_90: 0 },
    warnings:       [],
  };

  // 1) Try Oracle EBS first (the source of truth)
  var oracleData = null;
  if (oracleId) {
    try {
      oracleData = _fetchFromOracle(oracleId, range);
      if (oracleData.success) {
        statement.invoices = oracleData.invoices || [];
        statement.payments = oracleData.payments || [];
        statement.summary.opening_balance = parseFloat(oracleData.opening_balance) || 0;
        statement.summary.closing_balance = parseFloat(oracleData.closing_balance) || 0;
      } else {
        statement.warnings.push('Oracle EBS fetch failed: ' + oracleData.error);
        statement.source = 'CACHE_FALLBACK';
      }
    } catch(e) {
      statement.warnings.push('Oracle fetch error: ' + e.message);
      statement.source = 'CACHE_FALLBACK';
    }
  } else {
    statement.warnings.push('Customer not linked to Oracle (no oracle_customer_code). Showing local CMS data only.');
    statement.source = 'CMS_LOCAL';
  }

  // 2) Fallback / supplement with local CMS data when Oracle is empty/unavailable
  if (!statement.invoices.length) {
    statement.invoices = _localInvoices(customerId, range);
  }
  if (!statement.payments.length) {
    statement.payments = _localPayments(customerId, range);
  }

  // 3) Compute lines, summary, ageing
  statement.lines = _composeLines(statement.invoices, statement.payments);
  statement.summary.total_invoiced = statement.invoices.reduce(function(s, i) { return s + (parseFloat(i.amount) || 0); }, 0);
  statement.summary.total_paid     = statement.payments.reduce(function(s, p) { return s + (parseFloat(p.amount) || 0); }, 0);
  if (!statement.summary.closing_balance) {
    statement.summary.closing_balance = statement.summary.opening_balance
      + statement.summary.total_invoiced
      - statement.summary.total_paid;
  }
  statement.ageing = _computeAgeing(statement.invoices, statement.payments);

  // 4) Cache invoice rows in Turso for offline view
  _cacheInvoices(customerId, statement.invoices);

  return { success: true, statement: statement };
}

function getCachedStatement(customerId, range) {
  if (!customerId) return { success: false, error: 'customerId required' };
  range = _normalizeRange(range);
  var customer = getById('Customers', customerId);
  if (!customer) return { success: false, error: 'Customer not found' };

  var statement = {
    customer_id:    customerId,
    company_name:   customer.company_name || '',
    account_number: customer.account_number || '',
    currency_code:  customer.currency_code || 'KES',
    range:          range,
    generated_at:   new Date().toISOString(),
    source:         'CACHE_ONLY',
    invoices:       _localInvoices(customerId, range),
    payments:       _localPayments(customerId, range),
    summary:        { opening_balance: 0, total_invoiced: 0, total_paid: 0, closing_balance: 0 },
    ageing:         { current: 0, days_30: 0, days_60: 0, days_90: 0, days_over_90: 0 },
    warnings:       ['Cached data — call action:run to refresh from Oracle.'],
  };
  statement.lines = _composeLines(statement.invoices, statement.payments);
  statement.summary.total_invoiced = statement.invoices.reduce(function(s, i) { return s + (parseFloat(i.amount) || 0); }, 0);
  statement.summary.total_paid     = statement.payments.reduce(function(s, p) { return s + (parseFloat(p.amount) || 0); }, 0);
  statement.summary.closing_balance = statement.summary.total_invoiced - statement.summary.total_paid;
  statement.ageing = _computeAgeing(statement.invoices, statement.payments);
  return { success: true, statement: statement };
}

// ============================================================================
// ORACLE EBS FETCH
// ============================================================================

function _fetchFromOracle(oracleId, range) {
  var config = getIntegrationConfig();
  if (!config.oracleApiUrl) return { success: false, error: 'Oracle integration not configured' };

  var qs = '?from=' + encodeURIComponent(range.from) + '&to=' + encodeURIComponent(range.to);

  var invResp = callOracleApi('/customers/' + encodeURIComponent(oracleId) + '/invoices' + qs, 'GET', null, config);
  var payResp = callOracleApi('/customers/' + encodeURIComponent(oracleId) + '/payments' + qs, 'GET', null, config);
  var balResp = callOracleApi('/customers/' + encodeURIComponent(oracleId) + '/balance?as_of=' + encodeURIComponent(range.from), 'GET', null, config);

  if (!invResp.success && !payResp.success) {
    return { success: false, error: invResp.error || payResp.error || 'Oracle returned no data' };
  }

  var invoices = (invResp.data && (invResp.data.invoices || invResp.data.items || invResp.data)) || [];
  var payments = (payResp.data && (payResp.data.payments || payResp.data.items || payResp.data)) || [];
  if (!Array.isArray(invoices)) invoices = [];
  if (!Array.isArray(payments)) payments = [];

  return {
    success: true,
    invoices: invoices.map(_normalizeInvoice),
    payments: payments.map(_normalizePayment),
    opening_balance: balResp.success ? parseFloat(balResp.data.balance) || 0 : 0,
    closing_balance: 0, // computed downstream
  };
}

function _normalizeInvoice(i) {
  return {
    invoice_number: i.invoice_number || i.number || i.id || '',
    invoice_date:   i.invoice_date || i.date || i.created_at || '',
    due_date:       i.due_date || '',
    amount:         parseFloat(i.amount || i.total_amount || i.gross_amount || 0),
    balance:        parseFloat(i.balance || i.outstanding || i.amount_due || 0),
    description:    i.description || i.memo || '',
    order_number:   i.order_number || i.po_number || '',
    currency_code:  i.currency_code || i.currency || '',
    status:         i.status || (parseFloat(i.balance || 0) > 0 ? 'OPEN' : 'PAID'),
  };
}

function _normalizePayment(p) {
  return {
    payment_number: p.payment_number || p.receipt_number || p.id || '',
    payment_date:   p.payment_date || p.date || p.created_at || '',
    amount:         parseFloat(p.amount || p.total_amount || 0),
    method:         p.method || p.payment_method || '',
    reference:      p.reference || p.bank_reference || '',
    applied_to:     p.applied_to || p.invoice_number || '',
    currency_code:  p.currency_code || p.currency || '',
  };
}

// ============================================================================
// LOCAL FALLBACK
// ============================================================================

function _localInvoices(customerId, range) {
  try {
    var rows = findRows('Invoices', 'customer_id', customerId);
    return rows.filter(function(r) { return _inRange(r.invoice_date || r.created_at, range); }).map(_normalizeInvoice);
  } catch(e) { return []; }
}

function _localPayments(customerId, range) {
  try {
    var rows = findRows('PaymentUploads', 'customer_id', customerId);
    return rows.filter(function(r) { return _inRange(r.payment_date || r.created_at, range); }).map(_normalizePayment);
  } catch(e) { return []; }
}

function _cacheInvoices(customerId, invoices) {
  if (!invoices || !invoices.length) return;
  try {
    invoices.forEach(function(inv) {
      if (!inv.invoice_number) return;
      var existing = findRow('Invoices', 'invoice_number', inv.invoice_number);
      var record = {
        invoice_id:     existing ? existing.invoice_id : generateId('INV'),
        invoice_number: inv.invoice_number,
        customer_id:    customerId,
        invoice_date:   inv.invoice_date,
        due_date:       inv.due_date,
        amount:         inv.amount,
        balance:        inv.balance,
        currency_code:  inv.currency_code,
        status:         inv.status,
        order_number:   inv.order_number,
        description:    inv.description,
      };
      if (existing) updateRow('Invoices', 'invoice_id', existing.invoice_id, record);
      else appendRow('Invoices', record);
    });
  } catch(e) {
    Logger.log('[Statements] cacheInvoices: ' + e.message);
  }
}

// ============================================================================
// COMPOSITION HELPERS
// ============================================================================

function _composeLines(invoices, payments) {
  var lines = [];
  invoices.forEach(function(i) {
    lines.push({
      date:        i.invoice_date,
      type:        'INVOICE',
      reference:   i.invoice_number,
      description: i.description || ('Invoice ' + i.invoice_number),
      debit:       parseFloat(i.amount) || 0,
      credit:      0,
    });
  });
  payments.forEach(function(p) {
    lines.push({
      date:        p.payment_date,
      type:        'PAYMENT',
      reference:   p.payment_number,
      description: 'Payment received' + (p.method ? ' (' + p.method + ')' : ''),
      debit:       0,
      credit:      parseFloat(p.amount) || 0,
    });
  });
  lines.sort(function(a, b) { return String(a.date).localeCompare(String(b.date)); });
  // Running balance
  var bal = 0;
  lines.forEach(function(l) {
    bal += (l.debit || 0) - (l.credit || 0);
    l.running_balance = Math.round(bal * 100) / 100;
  });
  return lines;
}

function _computeAgeing(invoices, payments) {
  var now = new Date();
  var buckets = { current: 0, days_30: 0, days_60: 0, days_90: 0, days_over_90: 0 };
  invoices.forEach(function(i) {
    var bal = parseFloat(i.balance) || 0;
    if (bal <= 0) return;
    var dateStr = i.due_date || i.invoice_date;
    var d = dateStr ? new Date(dateStr) : null;
    if (!d || isNaN(d)) { buckets.current += bal; return; }
    var ageDays = Math.floor((now - d) / 86400000);
    if (ageDays <= 0) buckets.current += bal;
    else if (ageDays <= 30) buckets.days_30 += bal;
    else if (ageDays <= 60) buckets.days_60 += bal;
    else if (ageDays <= 90) buckets.days_90 += bal;
    else buckets.days_over_90 += bal;
  });
  Object.keys(buckets).forEach(function(k) { buckets[k] = Math.round(buckets[k] * 100) / 100; });
  return buckets;
}

// ============================================================================
// CSV EXPORT
// ============================================================================

function exportStatementCsv(statement) {
  if (!statement) return '';
  var rows = [];
  rows.push(['Statement for', statement.company_name, 'Account', statement.account_number]);
  rows.push(['Period', statement.range.from, 'to', statement.range.to]);
  rows.push(['Currency', statement.currency_code, 'Generated', statement.generated_at]);
  rows.push([]);
  rows.push(['Date','Type','Reference','Description','Debit','Credit','Balance']);
  statement.lines.forEach(function(l) {
    rows.push([l.date, l.type, l.reference, l.description, l.debit || '', l.credit || '', l.running_balance]);
  });
  rows.push([]);
  rows.push(['Opening Balance','','','', '', '', statement.summary.opening_balance]);
  rows.push(['Total Invoiced','','','', statement.summary.total_invoiced, '', '']);
  rows.push(['Total Paid','','','', '', statement.summary.total_paid, '']);
  rows.push(['Closing Balance','','','', '', '', statement.summary.closing_balance]);
  return rows.map(function(r) {
    return r.map(function(c) {
      var v = (c === null || c === undefined) ? '' : String(c);
      if (v.indexOf(',') !== -1 || v.indexOf('"') !== -1) v = '"' + v.replace(/"/g, '""') + '"';
      return v;
    }).join(',');
  }).join('\n');
}

// ============================================================================
// UTILITIES
// ============================================================================

function _defaultStatementRange() {
  var now = new Date();
  var from = new Date(now.getFullYear(), now.getMonth() - 2, 1); // last 3 months
  var to   = now;
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

function _normalizeRange(range) {
  if (!range || !range.from || !range.to) return _defaultStatementRange();
  var from = String(range.from).slice(0, 10);
  var to   = String(range.to).slice(0, 10);
  if (from > to) { var tmp = from; from = to; to = tmp; }
  return { from: from, to: to };
}

function _inRange(dateStr, range) {
  if (!dateStr) return false;
  var s = String(dateStr).slice(0, 10);
  return s >= range.from && s <= range.to;
}
