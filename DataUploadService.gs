/**
 * HASS CMS — DataUploadService.gs FIXES
 * =====================================================================
 * WHAT THIS FILE CONTAINS:
 *
 * 1. importSalesRows()   — fixed column names to match actual SLAData sheet
 * 2. importPurRows()     — unchanged (POApprovals has different schema)
 * 3. extractCountryFromFilename() — handles HPK/HPT/HPU codes too
 * 4. backfillSLADataAffiliates() — ONE-TIME repair of the 185 blank rows
 *
 * HOW TO APPLY:
 *   Step 1: Replace your existing importSalesRows() with the one below.
 *   Step 2: Replace your existing extractCountryFromFilename() with the one below.
 *   Step 3: Run backfillSLADataAffiliates() ONCE to repair existing blank rows.
 *   Step 4: Future uploads will write correct columns automatically.
 * =====================================================================
 */


// ============================================================================
// 1. FIXED importSalesRows — writes to actual SLAData column names
//    Sheet headers confirmed: source_type | affiliate | document_number |
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
      CD:'Hass Petroleum Congo',   MW:'Hass Petroleum Malawi'
    };

    var existing = getSheetData('SLAData') || [];
    var seen = {};
    existing.forEach(function(r) {
      var d = String(r.document_number || '').trim();
      if (d) seen[d] = true;
    });

    var batchId  = 'SALES_' + (affiliateCountryCode || 'XX') + '_' + new Date().toISOString().slice(0, 10);
    var imported = 0, skipped = 0;

    rows.forEach(function(row) {
      if (String(row['APPROVAL_STATUS'] || '').trim().toUpperCase() !== 'APPROVE') {
        skipped++; return;
      }
      var docNum = String(row['DOCUMENT_NUMBER'] || '').trim();
      if (!docNum || docNum === 'nan') { skipped++; return; }
      if (seen[docNum])               { skipped++; return; }

      var affInFile = String(row['AFFILIATE'] || '').trim();
      var affName   = affInFile || CC_TO_NAME[affiliateCountryCode] || affiliateCountryCode || 'Unknown';

      var finMin = parseFloat(row['FINANCE_VARIANCE'])           || 0;
      var laMin  = parseFloat(row['LOADING_AUTHORITY_VARIANCE']) || 0;

      appendRow('SLAData', {
        source_type:          'SALES',
        affiliate:            affName,
        document_number:      docNum,
        customer_name:        String(row['CUSTOMER_NAME']          || ''),
        oracle_approver:      String(row['APPROVER']               || ''),
        finance_variance_min: finMin,
        la_variance_min:      laMin,
        created_at:           String(row['CREATE_DATE_TIME']       || ''),
        approved_at:          String(row['APPROVAL_DATE_TIME']     || ''),
        dispatched_at:        String(row['LOADING_AUTHORITY_DATE'] || ''),
        ordered_item:         String(row['ORDERED_ITEM']           || ''),
        upload_batch_id:      batchId
      });

      seen[docNum] = true;
      imported++;
    });

    if (imported > 0) clearSheetCache('SLAData');
    return { success: true, imported: imported, skipped: skipped };

  } catch(e) {
    Logger.log('importSalesRows error: ' + e.message);
    return { success: false, error: e.message, imported: 0, skipped: 0 };
  }
}


// ============================================================================
// 2. importPurRows — writes to POApprovals (schema unchanged)
// ============================================================================
function importPurRows(rows, affiliateCountryCode) {
  try {
    if (!rows || !rows.length) return { success: true, imported: 0, skipped: 0 };

    var CC_TO_NAME = {
      KE:'Hass Petroleum Kenya',   UG:'Hass Petroleum Uganda',
      TZ:'Hass Petroleum Tanzania', RW:'Hass Petroleum Rwanda',
      DRC:'Hass Petroleum Congo',  ZM:'Hass Petroleum Zambia',
      SS:'Hass South Sudan',       SO:'Hass Petroleum Somalia'
    };

    var existing = getSheetData('POApprovals') || [];
    var seen = {};
    existing.forEach(function(r) {
      var p = String(r.po_number || '').trim();
      if (p) seen[p] = true;
    });

    var batchId  = 'PUR_' + (affiliateCountryCode || 'XX') + '_' + new Date().toISOString().slice(0, 10);
    var imported = 0, skipped = 0;
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
        description:             String(row['Req Description']                    || ''),
        nature:                  String(row['NATURE']                             || 'PRODUCT'),
        affiliate:               affName,
        created_by:              String(row['PURCHASE_ORDER_CREATED_BY']          || ''),
        original_creation_date:  String(row['ORIGINAL_CREATION_DATE']            || ''),
        submission_date:         String(row['SUBMISSION_FOR_APPROVAL_DATE']      || ''),
        submission_variance_min: parseFloat(row['TIME_DIFF_RAISEPO_TOAPROVALSUBMIT']) || 0,
        authorization_status:    'APPROVED',
        upload_batch_id:         batchId
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

      appendRow('POApprovals', record);
      seen[poNum] = true;
      imported++;
    });

    if (imported > 0) clearSheetCache('POApprovals');
    return { success: true, imported: imported, skipped: skipped };

  } catch(e) {
    Logger.log('importPurRows error: ' + e.message);
    return { success: false, error: e.message, imported: 0, skipped: 0 };
  }
}


// ============================================================================
// 3. ROBUST extractCountryFromFilename
//    Handles: ZM, DRC, HPK, HPT, Kenya, Congo etc in any position/separator
// ============================================================================
function extractCountryFromFilename(filename) {
  if (!filename) return '';

  var CODES   = ['KE','UG','TZ','RW','SS','ZM','DRC','CD','MW','SO','NG','ET'];
  var BADGES  = { HPK:'KE',HPU:'UG',HPT:'TZ',HPR:'RW',HSS:'SS',HPZ:'ZM',HPC:'DRC',HSO:'SO',HPM:'MW' };
  var KEYWORDS = { KENYA:'KE',UGANDA:'UG',TANZANIA:'TZ',RWANDA:'RW','SOUTH SUDAN':'SS',
                   ZAMBIA:'ZM',CONGO:'DRC',MALAWI:'MW',SOMALIA:'SO' };

  var clean = filename.replace(/\.(xls|xlsx|csv)$/i, '').trim();
  var upper = clean.toUpperCase();

  // Check segments split by - and _
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
// 4. ONE-TIME BACKFILL — run this ONCE to fix the 185 blank rows already in
//    SLAData that have empty affiliate and document_number.
//    Safe to run multiple times — skips rows that already have an affiliate.
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
  var laCol      = colIdx['la_variance_min'];
  var createdCol = colIdx['created_at'];

  var data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();

  // Build a lookup from the seeded rows (rows 2-4 in your sheet) that have
  // proper affiliate + document_number, keyed by customer_name + finance_variance
  // to match the blank rows that were written without those fields
  var seedLookup = {};
  data.forEach(function(row) {
    var aff    = String(row[affCol] || '').trim();
    var docNum = String(row[docCol] || '').trim();
    if (aff && docNum) {
      // This row is complete — store its affiliate for matching
      var custKey = String(row[custCol] || '').trim().toLowerCase()
                  + '_' + Math.round(parseFloat(row[finCol]) || 0);
      seedLookup[custKey] = aff;
    }
  });

  Logger.log('Seed lookup entries: ' + Object.keys(seedLookup).length);

  // For blank rows, determine affiliate from context:
  // - Rows 5-21 (April 22 07:51) = Zambia upload (same customer names as seed)
  // - Rows 22-31 (April 22 11:18) = DRC upload (La Grande Cimenterie Du Katanga is DRC)
  // We detect by created_at timestamp batch grouping

  // Find the two upload batches by their first timestamps
  var ZM_BATCH_TS  = '2026-04-22T07:51';  // Zambia upload
  var DRC_BATCH_TS = '2026-04-22T11:18';  // DRC upload

  var CC_TO_AFFILIATE = {
    ZM: 'Hass Petroleum Zambia',
    DRC: 'Hass Petroleum Congo'
  };

  var updates = 0;
  var docCounter = { ZM: 90000090000, DRC: 71000000000 }; // synthetic doc numbers for backfill

  data.forEach(function(row, i) {
    var rowNum = i + 2; // 1-indexed, +1 for header
    var aff    = String(row[affCol] || '').trim();
    var docNum = String(row[docCol] || '').trim();

    // Skip rows that are already complete
    if (aff && docNum) return;

    var createdAt = String(row[createdCol] || '').trim();
    var affiliateName = '';
    var countryCode   = '';

    if (createdAt.indexOf(ZM_BATCH_TS) === 0) {
      affiliateName = CC_TO_AFFILIATE['ZM'];
      countryCode   = 'ZM';
    } else if (createdAt.indexOf(DRC_BATCH_TS) === 0) {
      affiliateName = CC_TO_AFFILIATE['DRC'];
      countryCode   = 'DRC';
    } else {
      // Unknown batch — try seed lookup
      var custKey = String(row[custCol] || '').trim().toLowerCase()
                  + '_' + Math.round(parseFloat(row[finCol]) || 0);
      affiliateName = seedLookup[custKey] || 'Unknown';
    }

    // Write affiliate
    if (affCol !== undefined) {
      sheet.getRange(rowNum, affCol + 1).setValue(affiliateName);
    }

    // Write a synthetic document_number if missing (to allow dedup on future uploads)
    if (docCol !== undefined && !docNum) {
      var synthDoc = 'BACKFILL_' + countryCode + '_' + rowNum;
      sheet.getRange(rowNum, docCol + 1).setValue(synthDoc);
    }

    updates++;
  });

  clearSheetCache('SLAData');
  Logger.log('Backfill complete. Updated ' + updates + ' rows.');

  // Verify
  var result = getSLAAnalytics({ period: 'custom', customFrom: '2020-01', customTo: '2030-12' }, 'ALL');
  Logger.log('After backfill — totalOrders: ' + (result.kpis && result.kpis.totalOrders));
  Logger.log('byAffiliate: ' + JSON.stringify(result.byAffiliate || []));
}


// ============================================================================
// 5. Verification — run after backfill to confirm dashboard will show data
// ============================================================================
function verifyAfterBackfill() {
  var r = getSLAAnalytics({ year: '2026', period: 'all' }, 'ALL');
  Logger.log('=== 2026 ===');
  Logger.log('totalOrders: ' + r.kpis.totalOrders);
  Logger.log('avgFinance: '  + r.kpis.avgFinance + ' min');
  Logger.log('avgLA: '       + r.kpis.avgLA + ' min');
  Logger.log('onTimePct: '   + r.kpis.onTimePct + '%');
  Logger.log('byAffiliate: ' + JSON.stringify(r.byAffiliate));

  var r2 = getSLAAnalytics({ year: '2025', period: 'all' }, 'ALL');
  Logger.log('=== 2025 ===');
  Logger.log('totalOrders: ' + r2.kpis.totalOrders);
  Logger.log('byAffiliate: ' + JSON.stringify(r2.byAffiliate));
}
