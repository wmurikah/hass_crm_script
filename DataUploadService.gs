/**
 * DataUploadService.gs
 * Handles import of Oracle EBS SALES and PUR Excel/CSV data
 * uploaded via the Settings > Data Upload tab.
 *
 * SALES rows -> SLAData sheet (one row per order document).
 * PUR rows   -> POApprovals sheet (one row per approval step, unpivoted).
 */

function handleDataUploadRequest(params) {
  try {
    switch (params.action) {
      case 'importSalesRows':
        return importSalesRows(params.rows, params.affiliateCountryCode);
      case 'importPurRows':
        return importPurRows(params.rows, params.affiliateCountryCode);
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

function importSalesRows(rows, affiliateCountryCode) {
  try {
    if (!rows || !rows.length) return { success: true, imported: 0, skipped: 0 };

    var AFFILIATE_MAP = {
      'Hass Petroleum Kenya':'KE','Hass Petroleum Uganda':'UG','Hass Petroleum Tanzania':'TZ',
      'Hass Petroleum Rwanda':'RW','Hass Petroleum Congo':'DRC','Hass Petroleum Zambia':'ZM',
      'Hass South Sudan':'SS','Hass Petroleum Somalia':'SO',
      'HPK':'KE','HPU':'UG','HPT':'TZ','HPR':'RW','HPC':'DRC','HPZ':'ZM','HSS':'SS'
    };

    // Load existing SLAData for dedup
    var existing = getSheetData('SLAData') || [];
    var existingDocs = {};
    existing.forEach(function(r){ if(r.oracle_document_number) existingDocs[String(r.oracle_document_number)] = true; });

    var imported = 0, skipped = 0;

    rows.forEach(function(row) {
      // Only import APPROVE rows
      var status = String(row['APPROVAL_STATUS']||'').trim().toUpperCase();
      if (status !== 'APPROVE') { skipped++; return; }

      var docNum = String(row['DOCUMENT_NUMBER']||'').trim();
      if (!docNum || docNum === 'nan') { skipped++; return; }

      // Dedup
      if (existingDocs[docNum]) { skipped++; return; }

      // Resolve country code
      var affiliate = String(row['AFFILIATE']||'').trim();
      var countryCode = AFFILIATE_MAP[affiliate] || affiliateCountryCode || 'UNKNOWN';

      // Parse numeric variances safely
      var financeVar = parseFloat(row['FINANCE_VARIANCE']) || 0;
      var laVar = parseFloat(row['LOADING_AUTHORITY_VARIANCE']) || 0;

      var record = {
        sla_id: generateId('SLA'),
        oracle_document_number: docNum,
        country_code: countryCode,
        affiliate_name: affiliate,
        customer_code: String(row['CUSTOMER_CODE']||''),
        customer_name: String(row['CUSTOMER_NAME']||''),
        ordered_item: String(row['ORDERED_ITEM']||''),
        created_at_oracle: String(row['CREATE_DATE_TIME']||''),
        finance_approved_at: String(row['APPROVAL_DATE_TIME']||''),
        finance_variance_min: financeVar,
        finance_approver: String(row['APPROVER']||''),
        approval_status: 'APPROVE',
        la_issued_at: String(row['LOADING_AUTHORITY_DATE']||''),
        la_variance_min: laVar,
        credit_hold_at: String(row['CREDIT_HOLD_DATE']||''),
        credit_released_at: String(row['CREDIT_HOLD_RELEASE_DATE']||''),
        credit_variance_min: parseFloat(row['CREDIT_VARIANCE'])||0,
        finance_within_sla: financeVar > 0 && financeVar <= 60,
        la_within_sla: laVar > 0 && laVar <= 120,
        import_source: 'ORACLE_SALES_UPLOAD',
        imported_at: new Date()
      };

      appendRow('SLAData', record);
      existingDocs[docNum] = true;
      imported++;
    });

    if (imported > 0) clearSheetCache('SLAData');
    return { success: true, imported: imported, skipped: skipped };
  } catch(e) {
    Logger.log('importSalesRows error: ' + e.message);
    return { success: false, error: e.message, imported: 0, skipped: 0 };
  }
}

// ─── PUR Import ─────────────────────────────────────────────────────────────

function importPurRows(rows, affiliateCountryCode) {
  try {
    if (!rows || !rows.length) return { success: true, imported: 0, skipped: 0 };

    var existing = getSheetData('POApprovals') || [];
    var existingKeys = {};
    existing.forEach(function(r){
      var k = String(r.oracle_po_number||'') + '_' + String(r.step_number||'');
      existingKeys[k] = true;
    });

    var imported = 0, skipped = 0;
    var STEPS = ['FIRST','SECOND','THIRD','FOURTH','FIFTH','SIXTH','SEVENTH'];

    rows.forEach(function(row) {
      var status = String(row['AUTHORIZATION_STATUS']||'').trim().toUpperCase();
      if (status !== 'APPROVED') { skipped++; return; }

      var poNum = String(row['purchase Number']||'').trim();
      if (!poNum || poNum === 'nan') { skipped++; return; }

      var nature = String(row['NATURE']||'PRODUCT').trim();
      var createdAt = String(row['ORIGINAL_CREATION_DATE']||'');
      var submittedAt = String(row['SUBMISSION_FOR_APPROVAL_DATE']||'');
      var raiseToSubmitMin = parseFloat(row['TIME_DIFF_RAISEPO_TOAPROVALSUBMIT'])||0;
      var createdBy = String(row['PURCHASE_ORDER_CREATED_BY']||'');

      // Unpivot each approver step
      STEPS.forEach(function(step, idx) {
        var stepNum = idx + 1;
        var approverName = row[step + '_APPROVER'];
        var approvalDate = row[step + '_APPROVAL_DATE'];
        var varianceMin = row[step + '_APPROVALS_VARIANCE'];

        // Skip empty steps
        if (!approverName || String(approverName) === 'nan' || !approvalDate || String(approvalDate) === 'nan') return;

        var deupKey = poNum + '_' + stepNum;
        if (existingKeys[deupKey]) { skipped++; return; }

        var record = {
          approval_id: generateId('POA'),
          oracle_po_number: poNum,
          step_number: stepNum,
          step_label: step,
          nature: nature,
          country_code: affiliateCountryCode || 'UNKNOWN',
          created_at_oracle: createdAt,
          submitted_at: submittedAt,
          raise_to_submit_min: raiseToSubmitMin,
          created_by: createdBy,
          approver_name: String(approverName),
          approval_date: String(approvalDate),
          variance_min: parseFloat(varianceMin)||0,
          within_sla: (parseFloat(varianceMin)||0) <= 120,
          authorization_status: 'APPROVED',
          import_source: 'ORACLE_PUR_UPLOAD',
          imported_at: new Date()
        };

        appendRow('POApprovals', record);
        existingKeys[deupKey] = true;
        imported++;
      });
    });

    if (imported > 0) clearSheetCache('POApprovals');
    return { success: true, imported: imported, skipped: skipped };
  } catch(e) {
    Logger.log('importPurRows error: ' + e.message);
    return { success: false, error: e.message, imported: 0, skipped: 0 };
  }
}

// ─── Filename Helper ────────────────────────────────────────────────────────

function extractCountryFromFilename(filename) {
  if (!filename) return 'UNKNOWN';
  var parts = filename.replace(/\.(xls|xlsx|csv)$/i,'').split('-');
  var code = parts[parts.length - 1].trim().toUpperCase();
  return code || 'UNKNOWN';
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
      var bid = r.import_source || '';
      if (!batches[bid]) batches[bid] = { batch_id: bid, type: 'SALES', count: 0 };
      batches[bid].count++;
    });
  }

  if (poSheet) {
    var poData = sheetToObjects(poSheet);
    poData.forEach(function(r) {
      var bid = r.import_source || '';
      if (!batches[bid]) batches[bid] = { batch_id: bid, type: 'PUR', count: 0 };
      batches[bid].count++;
    });
  }

  return { success: true, batches: Object.values(batches) };
}

// ─── Sheet Setup ────────────────────────────────────────────────────────────

function createSLASheets() {
  var ss = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || '1Rn3ZDSI69hzJvm9oq03D-SVdV3lyLIWyHHBZDQOjeTQ');

  var sheets = {
    'SLAData': [
      'sla_id','oracle_document_number','country_code','affiliate_name',
      'customer_code','customer_name','ordered_item',
      'created_at_oracle','finance_approved_at','finance_variance_min',
      'finance_approver','approval_status',
      'la_issued_at','la_variance_min',
      'credit_hold_at','credit_released_at','credit_variance_min',
      'finance_within_sla','la_within_sla',
      'import_source','imported_at'
    ],
    'POApprovals': [
      'approval_id','oracle_po_number','step_number','step_label',
      'nature','country_code',
      'created_at_oracle','submitted_at','raise_to_submit_min',
      'created_by','approver_name','approval_date','variance_min',
      'within_sla','authorization_status',
      'import_source','imported_at'
    ]
  };

  Object.keys(sheets).forEach(function(name) {
    var existing = ss.getSheetByName(name);
    if (existing) {
      Logger.log('Sheet \'' + name + '\' already exists — skipping.');
      return;
    }
    var sheet = ss.insertSheet(name);
    var cols = sheets[name];
    sheet.getRange(1, 1, 1, cols.length).setValues([cols]);
    var hdr = sheet.getRange(1, 1, 1, cols.length);
    hdr.setBackground('#1A237E');
    hdr.setFontColor('#ffffff');
    hdr.setFontWeight('bold');
    hdr.setFontSize(11);
    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, cols.length);
    Logger.log('Created sheet \'' + name + '\' with ' + cols.length + ' columns.');
  });

  Logger.log('Done. Run the SALES and PUR uploads from Settings to populate these sheets.');
}
