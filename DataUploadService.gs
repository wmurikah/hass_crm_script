/**
 * HASS CMS - DataUploadService.gs
 * =====================================================================
 */


// ============================================================================
// ROUTER - called by google.script.run from the upload UI
// ============================================================================
function handleDataUploadRequest(params) {
  try {
    var s = params._session;
    switch(params.action) {
      // New canonical names
      case 'importLaRows':
        if (s) requirePermission(s, 'uploads.la');
        return importSalesRows(params.rows, params.affiliateCountryCode);
      case 'importPoRows':
        if (s) requirePermission(s, 'uploads.po');
        return importPurRows(params.rows, params.affiliateCountryCode);
      // Legacy aliases (kept until front-end migrates)
      case 'importSalesRows':
        if (s) requirePermission(s, 'uploads.la');
        return importSalesRows(params.rows, params.affiliateCountryCode);
      case 'importPurRows':
        if (s) requirePermission(s, 'uploads.po');
        return importPurRows(params.rows, params.affiliateCountryCode);
      default:
        return { success: false, error: 'Unknown upload action: ' + params.action };
    }
  } catch(e) {
    Logger.log('handleDataUploadRequest error: ' + e.message);
    return { success: false, error: e.message };
  }
}


// ============================================================================
// 1. importSalesRows - writes to SLAData using actual sheet column names
//    Confirmed headers: source_type | affiliate | document_number |
//    customer_name | oracle_approver | finance_variance_min | la_variance_min |
//    created_at | approved_at | dispatched_at | ordered_item | upload_batch_id
// ============================================================================
function importSalesRows(rows, affiliateCountryCode) {
  try {
    if (!rows || !rows.length) return { success: true, imported: 0, skipped: 0 };

    var CC_TO_NAME = {
      KE:'Hass Petroleum Kenya',   UG:'Hass Petroleum Uganda',
      TZ:'Hass Petroleum Tanzania', RW:'Hass Petroleum Rwanda',
      DRC:'Hass Petroleum Congo',  ZM:'Hass Petroleum Zambia',
      SS:'Hass South Sudan',       SO:'Hass Petroleum Somalia',
      HTW:'Hass Terminal Limited',
      CD:'Hass Petroleum Congo',   MW:'Hass Petroleum Malawi'
    };

    var existing = getSheetData('SLAData') || [];
    var seen = {};
    existing.forEach(function(r) {
      var d = String(r.document_number || '').trim();
      if (d) seen[d] = true;
    });

    var batchId  = 'SALES_' + (affiliateCountryCode || 'XX') + '_' + new Date().toISOString().slice(0, 10);
    var skipped  = 0;
    var batch    = [];

    rows.forEach(function(row) {
      if (String(row['APPROVAL_STATUS'] || '').trim().toUpperCase() !== 'APPROVE') {
        skipped++; return;
      }
      var docNum = String(row['DOCUMENT_NUMBER'] || '').trim();
      if (!docNum || docNum === 'nan') { skipped++; return; }
      if (seen[docNum])               { skipped++; return; }

      var affInFile = String(row['AFFILIATE'] || '').trim();
      var affName   = affInFile || CC_TO_NAME[affiliateCountryCode] || affiliateCountryCode || 'Unknown';

      batch.push({
        source_type:          'SALES',
        affiliate:            affName,
        document_number:      docNum,
        customer_name:        String(row['CUSTOMER_NAME']          || ''),
        oracle_approver:      String(row['APPROVER']               || ''),
        finance_variance_min: parseFloat(row['FINANCE_VARIANCE'])           || 0,
        la_variance_min:      parseFloat(row['LOADING_AUTHORITY_VARIANCE']) || 0,
        created_at:           String(row['CREATE_DATE_TIME']       || ''),
        approved_at:          String(row['APPROVAL_DATE_TIME']     || ''),
        dispatched_at:        String(row['LOADING_AUTHORITY_DATE'] || ''),
        ordered_item:         String(row['ORDERED_ITEM']           || ''),
        upload_batch_id:      batchId,
      });
      seen[docNum] = true;
    });

    // Single setValues() call for the whole batch.
    var result = batchInsertRows('SLAData', batch);
    return { success: true, imported: result.inserted, skipped: skipped };

  } catch(e) {
    Logger.log('importSalesRows error: ' + e.message);
    return { success: false, error: e.message, imported: 0, skipped: 0 };
  }
}


// ============================================================================
// 2. importPurRows - writes to POApprovals using actual sheet column names
//    Confirmed headers: po_number | description | nature | affiliate |
//    created_by | original_creation_date | submission_date |
//    submission_variance_min | first_approver | first_approval_date |
//    first_variance_min | ... seventh_... | authorization_status | upload_batch_id
// ============================================================================
function importPurRows(rows, affiliateCountryCode) {
  try {
    if (!rows || !rows.length) return { success: true, imported: 0, skipped: 0 };

    var CC_TO_NAME = {
      KE:'Hass Petroleum Kenya',   UG:'Hass Petroleum Uganda',
      TZ:'Hass Petroleum Tanzania', RW:'Hass Petroleum Rwanda',
      DRC:'Hass Petroleum Congo',  ZM:'Hass Petroleum Zambia',
      SS:'Hass South Sudan',       SO:'Hass Petroleum Somalia',
      HTW:'Hass Terminal Limited'
    };

    var existing = getSheetData('POApprovals') || [];
    var seen = {};
    existing.forEach(function(r) {
      var p = String(r.po_number || '').trim();
      if (p) seen[p] = true;
    });

    var batchId  = 'PUR_' + (affiliateCountryCode || 'XX') + '_' + new Date().toISOString().slice(0, 10);
    var skipped  = 0;
    var batch    = [];
    var STEPS    = ['FIRST','SECOND','THIRD','FOURTH','FIFTH','SIXTH','SEVENTH'];

    rows.forEach(function(row) {
      if (String(row['AUTHORIZATION_STATUS'] || '').trim().toUpperCase() !== 'APPROVED') {
        skipped++; return;
      }
      var poNum = String(row['purchase Number'] || '').trim();
      if (!poNum || poNum === 'nan') { skipped++; return; }
      if (seen[poNum])               { skipped++; return; }

      var affName = CC_TO_NAME[affiliateCountryCode] || affiliateCountryCode || 'Unknown';

      var record = {
        po_number:               poNum,
        description:             String(row['Req Description']                     || ''),
        nature:                  String(row['NATURE']                              || 'PRODUCT'),
        affiliate:               affName,
        created_by:              String(row['PURCHASE_ORDER_CREATED_BY']           || ''),
        original_creation_date:  String(row['ORIGINAL_CREATION_DATE']             || ''),
        submission_date:         String(row['SUBMISSION_FOR_APPROVAL_DATE']       || ''),
        submission_variance_min: parseFloat(row['TIME_DIFF_RAISEPO_TOAPROVALSUBMIT']) || 0,
        authorization_status:    'APPROVED',
        upload_batch_id:         batchId,
      };

      STEPS.forEach(function(step) {
        var lower    = step.toLowerCase();
        var approver = row[step + '_APPROVER'];
        var date     = row[step + '_APPROVAL_DATE'];
        var variance = row[step + '_APPROVALS_VARIANCE'];
        record[lower + '_approver']      = (!approver || String(approver) === 'nan') ? '' : String(approver);
        record[lower + '_approval_date'] = (!date     || String(date)     === 'nan') ? '' : String(date);
        record[lower + '_variance_min']  = (!variance || String(variance) === 'nan') ? null : parseFloat(variance);
      });

      batch.push(record);
      seen[poNum] = true;
    });

    // Single setValues() call for the whole batch.
    var result = batchInsertRows('POApprovals', batch);
    return { success: true, imported: result.inserted, skipped: skipped };

  } catch(e) {
    Logger.log('importPurRows error: ' + e.message);
    return { success: false, error: e.message, imported: 0, skipped: 0 };
  }
}


// ============================================================================
// 3. extractCountryFromFilename
//    Handles: ZM, DRC, HPK, HPT, Kenya, Congo etc in any position/separator
// ============================================================================
function extractCountryFromFilename(filename) {
  if (!filename) return '';

  var CODES    = ['KE','UG','TZ','RW','SS','ZM','DRC','CD','MW','SO','HTW','NG','ET'];
  var BADGES   = { HPK:'KE',HPU:'UG',HPT:'TZ',HPR:'RW',HSS:'SS',HPZ:'ZM',HPC:'DRC',HSO:'SO',HPM:'MW',HTW:'HTW' };
  var KEYWORDS = { KENYA:'KE',UGANDA:'UG',TANZANIA:'TZ',RWANDA:'RW','SOUTH SUDAN':'SS',
                   ZAMBIA:'ZM',CONGO:'DRC',MALAWI:'MW',SOMALIA:'SO' };

  var clean = filename.replace(/\.(xls|xlsx|csv)$/i, '').trim();
  var upper = clean.toUpperCase();

  // Segments split by - and _
  var segs = upper.replace(/_/g, '-').split('-').map(function(s){ return s.trim(); });
  for (var i = segs.length - 1; i >= 0; i--) {
    if (CODES.indexOf(segs[i]) > -1) return segs[i];
    if (BADGES[segs[i]])             return BADGES[segs[i]];
  }

  // Space-separated tokens
  var toks = upper.split(/\s+/);
  for (var j = toks.length - 1; j >= 0; j--) {
    var t = toks[j].replace(/[^A-Z]/g, '');
    if (CODES.indexOf(t) > -1) return t;
    if (BADGES[t])             return BADGES[t];
  }

  // Multi-word keywords
  for (var kw in KEYWORDS) {
    if (upper.indexOf(kw) > -1) return KEYWORDS[kw];
  }

  // Scan all alpha tokens
  var all = upper.match(/[A-Z]+/g) || [];
  for (var k = all.length - 1; k >= 0; k--) {
    if (CODES.indexOf(all[k]) > -1) return all[k];
    if (BADGES[all[k]])             return BADGES[all[k]];
  }

  return '';
}


// ============================================================================
// 4. backfillSLADataAffiliates - ONE-TIME repair for blank affiliate rows
// ============================================================================
function backfillSLADataAffiliates() {
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName('SLAData');
  if (!sheet) { Logger.log('SLAData sheet not found'); return; }

  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2) { Logger.log('No data rows'); return; }

  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var colIdx  = {};
  headers.forEach(function(h, i) { colIdx[h] = i; });

  var affCol     = colIdx['affiliate'];
  var docCol     = colIdx['document_number'];
  var custCol    = colIdx['customer_name'];
  var finCol     = colIdx['finance_variance_min'];
  var createdCol = colIdx['created_at'];

  var data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();

  var seedLookup = {};
  data.forEach(function(row) {
    var aff    = String(row[affCol] || '').trim();
    var docNum = String(row[docCol] || '').trim();
    if (aff && docNum) {
      var custKey = String(row[custCol] || '').trim().toLowerCase()
                  + '_' + Math.round(parseFloat(row[finCol]) || 0);
      seedLookup[custKey] = aff;
    }
  });

  Logger.log('Seed lookup entries: ' + Object.keys(seedLookup).length);

  var ZM_BATCH_TS  = '2026-04-22T07:51';
  var DRC_BATCH_TS = '2026-04-22T11:18';
  var CC_TO_AFFILIATE = { ZM:'Hass Petroleum Zambia', DRC:'Hass Petroleum Congo' };

  var updates = 0;

  data.forEach(function(row, i) {
    var rowNum = i + 2;
    var aff    = String(row[affCol] || '').trim();
    var docNum = String(row[docCol] || '').trim();
    if (aff && docNum) return;

    var createdAt = String(row[createdCol] || '').trim();
    var affiliateName = '';
    var countryCode   = '';

    if (createdAt.indexOf(ZM_BATCH_TS) === 0) {
      affiliateName = CC_TO_AFFILIATE['ZM']; countryCode = 'ZM';
    } else if (createdAt.indexOf(DRC_BATCH_TS) === 0) {
      affiliateName = CC_TO_AFFILIATE['DRC']; countryCode = 'DRC';
    } else {
      var custKey = String(row[custCol] || '').trim().toLowerCase()
                  + '_' + Math.round(parseFloat(row[finCol]) || 0);
      affiliateName = seedLookup[custKey] || 'Unknown';
    }

    if (affCol !== undefined) sheet.getRange(rowNum, affCol + 1).setValue(affiliateName);
    if (docCol !== undefined && !docNum) {
      sheet.getRange(rowNum, docCol + 1).setValue('BACKFILL_' + countryCode + '_' + rowNum);
    }
    updates++;
  });

  clearSheetCache('SLAData');
  Logger.log('Backfill complete. Updated ' + updates + ' rows.');
}


// ============================================================================
// 5. verifyAfterUpload - run after any upload to confirm data landed
// ============================================================================
function verifyAfterUpload() {
  var r = getSLAAnalytics({ year: String(new Date().getFullYear()), period: 'all' }, 'ALL');
  Logger.log('=== VERIFY AFTER UPLOAD ===');
  Logger.log('SLAData rows: ' + (r._meta && r._meta.rowsInSheet));
  Logger.log('POApprovals rows: ' + (r._meta && r._meta.poRowsInSheet));
  Logger.log('totalOrders: ' + (r.kpis && r.kpis.totalOrders));
  Logger.log('avgFinance: ' + (r.kpis && r.kpis.avgFinance) + ' min');
  Logger.log('avgLA: ' + (r.kpis && r.kpis.avgLA) + ' min');
  Logger.log('byAffiliate: ' + JSON.stringify(r.byAffiliate || []));
  Logger.log('financeApprovers: ' + JSON.stringify(r.approverStats || []));
  Logger.log('poApprovers: ' + JSON.stringify(r.poApproverStats || []));
}
