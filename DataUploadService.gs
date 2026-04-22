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

    var AFFILIATE_MAP = {
      'Hass Petroleum Kenya':    'KE',
      'Hass Petroleum Uganda':   'UG',
      'Hass Petroleum Tanzania': 'TZ',
      'Hass Petroleum Rwanda':   'RW',
      'Hass Petroleum Congo':    'DRC',
      'Hass Petroleum Zambia':   'ZM',
      'Hass South Sudan':        'SS',
      'Hass Petroleum Somalia':  'SO'
    };

    // Reverse map: country code → full affiliate name for the sheet
    var CC_TO_AFFILIATE = {
      KE:'Hass Petroleum Kenya', UG:'Hass Petroleum Uganda',
      TZ:'Hass Petroleum Tanzania', RW:'Hass Petroleum Rwanda',
      DRC:'Hass Petroleum Congo', ZM:'Hass Petroleum Zambia',
      SS:'Hass South Sudan', SO:'Hass Petroleum Somalia',
      CD:'Hass Petroleum Congo', MW:'Hass Petroleum Malawi'
    };

    // Load existing rows for dedup on document_number
    var existing = getSheetData('SLAData') || [];
    var existingDocs = {};
    existing.forEach(function(r) {
      var doc = String(r.document_number || '').trim();
      if (doc) existingDocs[doc] = true;
    });

    var batchId = 'SALES_' + affiliateCountryCode + '_' + new Date().toISOString().slice(0, 10);
    var imported = 0, skipped = 0;

    rows.forEach(function(row) {
      // Only import APPROVE rows
      var status = String(row['APPROVAL_STATUS'] || '').trim().toUpperCase();
      if (status !== 'APPROVE') { skipped++; return; }

      var docNum = String(row['DOCUMENT_NUMBER'] || '').trim();
      if (!docNum || docNum === 'nan' || docNum === '') { skipped++; return; }

      // Dedup
      if (existingDocs[docNum]) { skipped++; return; }

      // Resolve affiliate name — prefer AFFILIATE column in file, fall back to filename code
      var affiliateInFile = String(row['AFFILIATE'] || '').trim();
      var affiliateName = affiliateInFile || CC_TO_AFFILIATE[affiliateCountryCode] || affiliateCountryCode || 'Unknown';

      var financeVar = parseFloat(row['FINANCE_VARIANCE']) || 0;
      var laVar      = parseFloat(row['LOADING_AUTHORITY_VARIANCE']) || 0;

      // Write using ACTUAL sheet column names
      var record = {
        source_type:          'SALES',
        affiliate:            affiliateName,            // ← sheet col: affiliate
        document_number:      docNum,                  // ← sheet col: document_number
        customer_name:        String(row['CUSTOMER_NAME'] || ''),
        oracle_approver:      String(row['APPROVER'] || ''),       // ← sheet col: oracle_approver
        finance_variance_min: financeVar,
        la_variance_min:      laVar,
        created_at:           String(row['CREATE_DATE_TIME'] || ''),  // ← sheet col: created_at
        approved_at:          String(row['APPROVAL_DATE_TIME'] || ''),
        dispatched_at:        String(row['LOADING_AUTHORITY_DATE'] || ''),
        ordered_item:         String(row['ORDERED_ITEM'] || ''),
        upload_batch_id:      batchId
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


// ============================================================================
// 2. importPurRows — writes to POApprovals (schema unchanged)
// ============================================================================
function importPurRows(rows, affiliateCountryCode) {
  try {
    if (!rows || !rows.length) return { success: true, imported: 0, skipped: 0 };

    var existing = getSheetData('POApprovals') || [];
    var existingKeys = {};
    existing.forEach(function(r) {
      // POApprovals stores wide format — dedup on po_number
      var k = String(r.po_number || '').trim();
      if (k) existingKeys[k] = true;
    });

    var CC_TO_AFFILIATE = {
      KE:'Hass Petroleum Kenya', UG:'Hass Petroleum Uganda',
      TZ:'Hass Petroleum Tanzania', RW:'Hass Petroleum Rwanda',
      DRC:'Hass Petroleum Congo', ZM:'Hass Petroleum Zambia',
      SS:'Hass South Sudan', SO:'Hass Petroleum Somalia'
    };

    var batchId = 'PUR_' + affiliateCountryCode + '_' + new Date().toISOString().slice(0, 10);
    var imported = 0, skipped = 0;
    var STEPS = ['FIRST','SECOND','THIRD','FOURTH','FIFTH','SIXTH','SEVENTH'];

    rows.forEach(function(row) {
      var status = String(row['AUTHORIZATION_STATUS'] || '').trim().toUpperCase();
      if (status !== 'APPROVED') { skipped++; return; }

      var poNum = String(row['purchase Number'] || '').trim();
      if (!poNum || poNum === 'nan' || poNum === '') { skipped++; return; }

      if (existingKeys[poNum]) { skipped++; return; }

      var affiliateName = CC_TO_AFFILIATE[affiliateCountryCode] || affiliateCountryCode || 'Unknown';

      // Build step variance arrays
      var stepVariances = STEPS.map(function(s) {
        return parseFloat(row[s + '_APPROVALS_VARIANCE']) || null;
      });
      var stepApprovers = STEPS.map(function(s) {
        var v = row[s + '_APPROVER'];
        return (!v || String(v) === 'nan') ? null : String(v);
      });
      var stepDates = STEPS.map(function(s) {
        var v = row[s + '_APPROVAL_DATE'];
        return (!v || String(v) === 'nan') ? null : String(v);
      });

      // POApprovals keeps wide format (one row per PO, all steps as columns)
      var record = {
        po_number:                 poNum,
        description:               String(row['Req Description'] || ''),
        nature:                    String(row['NATURE'] || 'PRODUCT'),
        affiliate:                 affiliateName,
        created_by:                String(row['PURCHASE_ORDER_CREATED_BY'] || ''),
        original_creation_date:    String(row['ORIGINAL_CREATION_DATE'] || ''),
        submission_date:           String(row['SUBMISSION_FOR_APPROVAL_DATE'] || ''),
        submission_variance_min:   parseFloat(row['TIME_DIFF_RAISEPO_TOAPROVALSUBMIT']) || 0,
        first_approver:            stepApprovers[0],
        first_approval_date:       stepDates[0],
        first_variance_min:        stepVariances[0],
        second_approver:           stepApprovers[1],
        second_approval_date:      stepDates[1],
        second_variance_min:       stepVariances[1],
        third_approver:            stepApprovers[2],
        third_approval_date:       stepDates[2],
        third_variance_min:        stepVariances[2],
        fourth_approver:           stepApprovers[3],
        fourth_approval_date:      stepDates[3],
        fourth_variance_min:       stepVariances[3],
        fifth_approver:            stepApprovers[4],
        fifth_approval_date:       stepDates[4],
        fifth_variance_min:        stepVariances[4],
        sixth_approver:            stepApprovers[5],
        sixth_approval_date:       stepDates[5],
        sixth_variance_min:        stepVariances[5],
        seventh_approver:          stepApprovers[6],
        seventh_approval_date:     stepDates[6],
        seventh_variance_min:      stepVariances[6],
        authorization_status:      'APPROVED',
        upload_batch_id:           batchId
      };

      appendRow('POApprovals', record);
      existingKeys[poNum] = true;
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

  // Short country codes used in Hass filenames
  var KNOWN_CODES = ['KE','UG','TZ','RW','SS','ZM','DRC','CD','MW','SO','NG','ET'];

  // Affiliate badge codes → country code
  var BADGE_TO_CC = {
    'HPK':'KE','HPU':'UG','HPT':'TZ','HPR':'RW',
    'HSS':'SS','HPZ':'ZM','HPC':'DRC','HSO':'SO','HPM':'MW'
  };

  // Country name keywords → country code
  var KEYWORD_TO_CC = {
    'KENYA':'KE','UGANDA':'UG','TANZANIA':'TZ','RWANDA':'RW',
    'SOUTH SUDAN':'SS','SUDAN':'SS','ZAMBIA':'ZM',
    'CONGO':'DRC','DRC':'DRC','MALAWI':'MW','SOMALIA':'SO'
  };

  var clean = filename.replace(/\.(xls|xlsx|csv)$/i, '').trim();
  var upper = clean.toUpperCase();

  // Strategy 1: Split on hyphens and underscores, check each segment
  var segments = upper.replace(/_/g, '-').split('-').map(function(s){ return s.trim(); });

  // Check last segment first (most common: FILE-DATE-DATE-ZM)
  for (var i = segments.length - 1; i >= 0; i--) {
    var seg = segments[i];
    if (KNOWN_CODES.indexOf(seg) > -1) return seg;
    if (BADGE_TO_CC[seg]) return BADGE_TO_CC[seg];
  }

  // Strategy 2: Check space-separated tokens
  var tokens = upper.split(/\s+/);
  for (var j = tokens.length - 1; j >= 0; j--) {
    var tok = tokens[j].replace(/[^A-Z]/g, '');
    if (KNOWN_CODES.indexOf(tok) > -1) return tok;
    if (BADGE_TO_CC[tok]) return BADGE_TO_CC[tok];
  }

  // Strategy 3: Multi-word country name keywords
  for (var keyword in KEYWORD_TO_CC) {
    if (upper.indexOf(keyword) > -1) return KEYWORD_TO_CC[keyword];
  }

  // Strategy 4: Scan all alphanumeric tokens (catches embedded codes)
  var allTokens = upper.match(/[A-Z]+/g) || [];
  for (var k = allTokens.length - 1; k >= 0; k--) {
    if (KNOWN_CODES.indexOf(allTokens[k]) > -1) return allTokens[k];
    if (BADGE_TO_CC[allTokens[k]]) return BADGE_TO_CC[allTokens[k]];
  }

  return ''; // fall back to UI select
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
