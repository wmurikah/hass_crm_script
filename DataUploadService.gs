/**
 * DataUploadService.gs
 * Handles import of Oracle EBS SALES and PUR Excel/CSV data
 * uploaded via the Settings > Data Upload tab.
 */

function handleDataUploadRequest(params) {
  try {
    switch (params.action) {
      case 'importSalesRows':
        return importSalesRows(params.rows);
      case 'importPurRows':
        return importPurRows(params.rows);
      case 'getUploadHistory':
        return getUploadHistory();
      default:
        return { success: false, error: 'Unknown upload action: ' + params.action };
    }
  } catch (e) {
    Logger.log('handleDataUploadRequest error: ' + e.message);
    return { success: false, error: e.message };
  }
}

// ─── SALES Import ───────────────────────────────────────────────────────────

function importSalesRows(rows) {
  if (!rows || rows.length === 0) return { success: true, imported: 0, skipped: 0, errors: [] };

  var ss = getSpreadsheet();
  var ordersSheet = ss.getSheetByName('Orders');
  var slaSheet = ensureSLADataSheet(ss);

  // Load existing orders for upsert by oracle_order_id
  var orderData = ordersSheet.getDataRange().getValues();
  var orderHeaders = orderData[0];
  var oracleIdCol = orderHeaders.indexOf('oracle_order_id');
  var orderIdCol = orderHeaders.indexOf('order_id');

  // Build lookup: oracle_order_id -> row index (1-based)
  var oracleLookup = {};
  for (var i = 1; i < orderData.length; i++) {
    var oId = String(orderData[i][oracleIdCol] || '').trim();
    if (oId) oracleLookup[oId] = i + 1; // sheet row (1-based)
  }

  // Load users for approver matching (HILLARY.KARIUKI -> user_id)
  var users = sheetToObjects(ss.getSheetByName('Users'));
  var userLookup = {};
  users.forEach(function(u) {
    var uname = ((u.first_name || '') + '.' + (u.last_name || '')).toUpperCase().trim();
    if (uname && uname !== '.') userLookup[uname] = u.user_id;
    // Also try LAST.FIRST pattern
    var uname2 = ((u.last_name || '') + '.' + (u.first_name || '')).toUpperCase().trim();
    if (uname2 && uname2 !== '.') userLookup[uname2] = u.user_id;
  });

  // Load customers for lookup by account_number / customer_code
  var customers = sheetToObjects(ss.getSheetByName('Customers'));
  var custLookup = {};
  customers.forEach(function(c) {
    if (c.account_number) custLookup[String(c.account_number).trim()] = c.customer_id;
  });

  // Affiliate name to country code mapping
  var affToCC = {
    'HASS PETROLEUM KENYA': 'KE', 'HASS PETROLEUM UGANDA': 'UG',
    'HASS PETROLEUM TANZANIA': 'TZ', 'HASS PETROLEUM RWANDA': 'RW',
    'HASS PETROLEUM SOUTH SUDAN': 'SS', 'HASS PETROLEUM ZAMBIA': 'ZM',
    'HASS PETROLEUM DRC': 'DRC', 'HASS PETROLEUM CONGO': 'DRC'
  };

  var batchId = 'SALES_' + new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  var imported = 0, skipped = 0, errors = [];

  var newOrderRows = [];
  var slaRows = [];
  var now = new Date().toISOString();

  rows.forEach(function(row) {
    try {
      var docNum = String(row['DOCUMENT_NUMBER'] || '').trim();
      if (!docNum) { skipped++; return; }

      var affiliate = String(row['AFFILIATE'] || '').trim().toUpperCase();
      var countryCode = '';
      Object.keys(affToCC).forEach(function(k) {
        if (affiliate.indexOf(k) >= 0) countryCode = affToCC[k];
      });

      var custCode = String(row['CUSTOMER_CODE'] || '').trim();
      var customerId = custLookup[custCode] || '';
      var approverUsername = String(row['APPROVER'] || '').trim().toUpperCase();
      var approverUserId = userLookup[approverUsername] || '';
      var createDt = String(row['CREATE_DATE_TIME'] || '');
      var approvalDt = String(row['APPROVAL_DATE_TIME'] || '');
      var laDt = String(row['LOADING_AUTHORITY_DATE'] || '');
      var financeVar = parseFloat(row['FINANCE_VARIANCE']) || 0;
      var laVar = parseFloat(row['LOADING_AUTHORITY_VARIANCE']) || 0;
      var status = String(row['APPROVAL_STATUS'] || '').trim().toUpperCase();
      var orderedItem = String(row['ORDERED_ITEM'] || '').trim();

      // Determine order status for the Orders sheet
      var orderStatus = 'APPROVED';
      if (status === 'REJECT' || status === 'REJECTED') orderStatus = 'REJECTED';
      if (laDt) orderStatus = 'DISPATCHED';

      // Append to SLAData for direct analytics
      slaRows.push([
        'SALES', affiliate, docNum, String(row['CUSTOMER_NAME'] || ''),
        approverUsername, financeVar, laVar,
        createDt, approvalDt, laDt, orderedItem, batchId
      ]);

      // Upsert to Orders sheet
      if (oracleLookup[docNum]) {
        // Update existing order row
        var rowNum = oracleLookup[docNum];
        var approvedAtCol = orderHeaders.indexOf('approved_at');
        var approvedByCol = orderHeaders.indexOf('approved_by');
        var dispatchedAtCol = orderHeaders.indexOf('dispatched_at');
        var statusCol = orderHeaders.indexOf('status');
        var updatedAtCol = orderHeaders.indexOf('updated_at');

        if (approvedAtCol >= 0 && approvalDt) ordersSheet.getRange(rowNum, approvedAtCol + 1).setValue(approvalDt);
        if (approvedByCol >= 0 && approverUserId) ordersSheet.getRange(rowNum, approvedByCol + 1).setValue(approverUserId);
        if (dispatchedAtCol >= 0 && laDt) ordersSheet.getRange(rowNum, dispatchedAtCol + 1).setValue(laDt);
        if (statusCol >= 0) ordersSheet.getRange(rowNum, statusCol + 1).setValue(orderStatus);
        if (updatedAtCol >= 0) ordersSheet.getRange(rowNum, updatedAtCol + 1).setValue(now);
        imported++;
      } else {
        // Create new order row
        var newRow = [];
        orderHeaders.forEach(function(h) {
          switch (h) {
            case 'order_id': newRow.push(generateId('ORD')); break;
            case 'order_number': newRow.push('ORC-' + docNum); break;
            case 'oracle_order_id': newRow.push(docNum); break;
            case 'customer_id': newRow.push(customerId); break;
            case 'status': newRow.push(orderStatus); break;
            case 'submitted_at': newRow.push(createDt); break;
            case 'approved_at': newRow.push(approvalDt); break;
            case 'approved_by': newRow.push(approverUserId); break;
            case 'dispatched_at': newRow.push(laDt); break;
            case 'country_code': newRow.push(countryCode); break;
            case 'created_at': newRow.push(createDt || now); break;
            case 'updated_at': newRow.push(now); break;
            case 'created_by_type': newRow.push('ORACLE_IMPORT'); break;
            case 'po_number': newRow.push(docNum); break;
            default: newRow.push('');
          }
        });
        newOrderRows.push(newRow);
        oracleLookup[docNum] = -1; // mark as seen to avoid duplicates within batch
        imported++;
      }
    } catch (e) {
      errors.push('Row ' + docNum + ': ' + e.message);
      skipped++;
    }
  });

  // Batch append new orders
  if (newOrderRows.length > 0) {
    ordersSheet.getRange(ordersSheet.getLastRow() + 1, 1, newOrderRows.length, orderHeaders.length).setValues(newOrderRows);
  }

  // Batch append SLA data
  if (slaRows.length > 0) {
    slaSheet.getRange(slaSheet.getLastRow() + 1, 1, slaRows.length, slaRows[0].length).setValues(slaRows);
  }

  return { success: true, imported: imported, skipped: skipped, errors: errors };
}

// ─── PUR Import ─────────────────────────────────────────────────────────────

function importPurRows(rows) {
  if (!rows || rows.length === 0) return { success: true, imported: 0, skipped: 0, errors: [] };

  var ss = getSpreadsheet();
  var poSheet = ensurePOApprovalsSheet(ss);

  // Load existing PO numbers for upsert
  var poData = poSheet.getDataRange().getValues();
  var poHeaders = poData[0];
  var poNumCol = poHeaders.indexOf('po_number');
  var poLookup = {};
  for (var i = 1; i < poData.length; i++) {
    var pn = String(poData[i][poNumCol] || '').trim();
    if (pn) poLookup[pn] = i + 1;
  }

  var batchId = 'PUR_' + new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  var imported = 0, skipped = 0, errors = [];
  var newRows = [];
  var now = new Date().toISOString();

  // Approver level prefixes
  var levels = ['FIRST', 'SECOND', 'THIRD', 'FOURTH', 'FIFTH', 'SIXTH', 'SEVENTH'];

  rows.forEach(function(row) {
    try {
      var poNum = String(row['purchase Number'] || '').trim();
      if (!poNum) { skipped++; return; }

      var description = String(row['Req Description'] || '').trim();
      var nature = String(row['NATURE'] || '').trim();
      var createdBy = String(row['PURCHASE_ORDER_CREATED_BY'] || '').trim();
      var origDate = String(row['ORIGINAL_CREATION_DATE'] || '');
      var subDate = String(row['SUBMISSION_FOR_APPROVAL_DATE'] || '');
      var subVariance = parseFloat(row['TIME_DIFF_RAISEPO_TOAPROVALSUBMIT']) || 0;
      var authStatus = String(row['AUTHORIZATION_STATUS'] || '').trim();

      // Derive affiliate from sheet name or nature
      var affiliate = String(row['_sheet'] || '').trim();

      if (poLookup[poNum]) {
        // Update existing PO row
        var rowNum = poLookup[poNum];
        var statusCol = poHeaders.indexOf('authorization_status');
        var updCol = poHeaders.indexOf('upload_batch_id');
        if (statusCol >= 0) poSheet.getRange(rowNum, statusCol + 1).setValue(authStatus);
        if (updCol >= 0) poSheet.getRange(rowNum, updCol + 1).setValue(batchId);

        // Update approver chain
        levels.forEach(function(lvl) {
          var approverKey = lvl + '_APPROVER';
          var dateKey = lvl + '_APPROVAL_DATE';
          var varKey = lvl + '_APPROVALS_VARIANCE';
          var colApprover = poHeaders.indexOf(lvl.toLowerCase() + '_approver');
          var colDate = poHeaders.indexOf(lvl.toLowerCase() + '_approval_date');
          var colVar = poHeaders.indexOf(lvl.toLowerCase() + '_variance_min');
          if (colApprover >= 0 && row[approverKey]) poSheet.getRange(rowNum, colApprover + 1).setValue(String(row[approverKey]));
          if (colDate >= 0 && row[dateKey]) poSheet.getRange(rowNum, colDate + 1).setValue(String(row[dateKey]));
          if (colVar >= 0 && row[varKey]) poSheet.getRange(rowNum, colVar + 1).setValue(parseFloat(row[varKey]) || 0);
        });

        imported++;
      } else {
        // Build new row
        var newRow = [
          poNum, description, nature, affiliate, createdBy,
          origDate, subDate, subVariance
        ];

        // Add approver chain columns (first through seventh)
        levels.forEach(function(lvl) {
          var approver = String(row[lvl + '_APPROVER'] || '');
          var aDate = String(row[lvl + '_APPROVAL_DATE'] || '');
          var aVar = parseFloat(row[lvl + '_APPROVALS_VARIANCE']) || 0;
          newRow.push(approver, aDate, aVar);
        });

        newRow.push(authStatus, batchId);
        newRows.push(newRow);
        poLookup[poNum] = -1;
        imported++;
      }
    } catch (e) {
      errors.push('PO ' + (row['purchase Number'] || '?') + ': ' + e.message);
      skipped++;
    }
  });

  // Batch append new PO rows
  if (newRows.length > 0) {
    poSheet.getRange(poSheet.getLastRow() + 1, 1, newRows.length, newRows[0].length).setValues(newRows);
  }

  return { success: true, imported: imported, skipped: skipped, errors: errors };
}

// ─── Upload History ─────────────────────────────────────────────────────────

function getUploadHistory() {
  var ss = getSpreadsheet();
  var slaSheet = ss.getSheetByName('SLAData');
  var poSheet = ss.getSheetByName('POApprovals');
  var batches = {};

  if (slaSheet) {
    var slaData = sheetToObjects(slaSheet);
    slaData.forEach(function(r) {
      var bid = r.upload_batch_id || '';
      if (!batches[bid]) batches[bid] = { batch_id: bid, type: r.source_type, count: 0 };
      batches[bid].count++;
    });
  }

  if (poSheet) {
    var poData = sheetToObjects(poSheet);
    poData.forEach(function(r) {
      var bid = r.upload_batch_id || '';
      if (!batches[bid]) batches[bid] = { batch_id: bid, type: 'PUR', count: 0 };
      batches[bid].count++;
    });
  }

  return { success: true, batches: Object.values(batches) };
}

// ─── Sheet Helpers ──────────────────────────────────────────────────────────

function ensureSLADataSheet(ss) {
  var sheet = ss.getSheetByName('SLAData');
  if (!sheet) {
    sheet = ss.insertSheet('SLAData');
    sheet.appendRow([
      'source_type', 'affiliate', 'document_number', 'customer_name',
      'oracle_approver', 'finance_variance_min', 'la_variance_min',
      'created_at', 'approved_at', 'dispatched_at', 'ordered_item', 'upload_batch_id'
    ]);
  }
  return sheet;
}

function ensurePOApprovalsSheet(ss) {
  var sheet = ss.getSheetByName('POApprovals');
  if (!sheet) {
    sheet = ss.insertSheet('POApprovals');
    var headers = [
      'po_number', 'description', 'nature', 'affiliate', 'created_by',
      'original_creation_date', 'submission_date', 'submission_variance_min'
    ];
    var levels = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh'];
    levels.forEach(function(lvl) {
      headers.push(lvl + '_approver', lvl + '_approval_date', lvl + '_variance_min');
    });
    headers.push('authorization_status', 'upload_batch_id');
    sheet.appendRow(headers);
  }
  return sheet;
}
