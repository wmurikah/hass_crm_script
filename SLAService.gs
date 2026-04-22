/**
 * HASS PETROLEUM CMS - SLA SERVICE
 * Version: 1.1.0
 *
 * Handles:
 * - SLA analytics computation (finance approval, LA approval, on-time delivery)
 * - Per-affiliate breakdown and monthly trend data
 * - Period filtering (month, quarter, year-to-date)
 *
 * CHANGE LOG v1.1.0:
 * - getSLAAnalytics() updated to match actual SLAData sheet columns:
 *   document_number (was oracle_document_number)
 *   created_at      (was created_at_oracle)
 *   affiliate       (was country_code — now resolved to country code inline)
 *   oracle_approver (was finance_approver)
 *   finance_within_sla and la_within_sla are now calculated inline
 *   (they are not stored in the sheet)
 */

function handleSLARequest(params) {
  try {
    switch(params.action) {
      case 'getSLAAnalytics': return getSLAAnalytics(params.filters || params.period, params.affiliate);
      case 'getExternalSLAAnalytics': return getExternalSLAAnalytics(params.filters || params.period, params.affiliate);
      case 'getStaffList': return getStaffList();
      default: return { success:false, error:'Unknown SLA action' };
    }
  } catch(e) {
    Logger.log('handleSLARequest: ' + e.message);
    return { success:false, error:e.message };
  }
}

function parseSLAPeriod(periodOrFilters) {
  if (typeof periodOrFilters === 'object' && periodOrFilters !== null) {
    return parseFilters(periodOrFilters);
  }
  var year = new Date().getFullYear();
  return {
    startDate:  new Date(year, 0, 1),
    endDate:    new Date(year, 11, 31, 23, 59, 59),
    staffId:    'ALL',
    department: 'ALL',
    affiliate:  'ALL'
  };
}

function parseFilters(filters, affiliate) {
  if (!filters) filters = {};
  var year = parseInt(filters.year || new Date().getFullYear());
  var startDate, endDate;

  switch(filters.period) {
    case 'q1': startDate = new Date(year,0,1);  endDate = new Date(year,2,31,23,59,59); break;
    case 'q2': startDate = new Date(year,3,1);  endDate = new Date(year,5,30,23,59,59); break;
    case 'q3': startDate = new Date(year,6,1);  endDate = new Date(year,8,30,23,59,59); break;
    case 'q4': startDate = new Date(year,9,1);  endDate = new Date(year,11,31,23,59,59); break;
    case 'month':
      var m = parseInt(filters.month||'01') - 1;
      startDate = new Date(year,m,1);
      endDate   = new Date(year,m+1,0,23,59,59);
      break;
    case 'custom':
      startDate = filters.customFrom ? new Date(filters.customFrom+'-01') : new Date(year,0,1);
      if (filters.customTo) {
        var p = filters.customTo.split('-');
        endDate = new Date(parseInt(p[0]), parseInt(p[1]), 0, 23,59,59);
      } else { endDate = new Date(); }
      break;
    default:
      startDate = new Date(year,0,1);
      endDate   = new Date(year,11,31,23,59,59);
  }

  return {
    startDate:  startDate,
    endDate:    endDate,
    staffId:    filters.staff       || 'ALL',
    department: filters.department  || 'ALL',
    affiliate:  affiliate           || 'ALL'
  };
}

function getStaffList() {
  try {
    var ss = getSpreadsheet();
    var users = sheetToObjects(ss.getSheetByName('Users'));
    var staff = users
      .filter(function(u){ return u.status === 'ACTIVE'; })
      .map(function(u){
        return {
          user_id: u.user_id,
          name: ((u.first_name||'')+' '+(u.last_name||'')).trim(),
          role: u.role,
          department: u.department
        };
      })
      .sort(function(a,b){ return a.name.localeCompare(b.name); });
    return { success:true, staff:staff };
  } catch(e) {
    return { success:false, error:e.message };
  }
}

// ============================================================================
// getSLAAnalytics — UPDATED v1.1.0
// Reads actual SLAData sheet columns confirmed by diagnostic:
//   affiliate, document_number, oracle_approver, finance_variance_min,
//   la_variance_min, created_at, upload_batch_id
// Derives country_code from affiliate name. Calculates SLA booleans inline.
// ============================================================================
function getSLAAnalytics(filters, affiliateFilter) {
  var ss      = getSpreadsheet();
  var slaData = sheetToObjects(ss.getSheetByName('SLAData')) || [];
  var f       = parseFilters(filters, affiliateFilter);

  // Map full affiliate name → short country code used everywhere in the portal
  var AFFILIATE_TO_CC = {
    'Hass Petroleum Kenya':    'KE',
    'Hass Petroleum Uganda':   'UG',
    'Hass Petroleum Tanzania': 'TZ',
    'Hass Petroleum Rwanda':   'RW',
    'Hass Petroleum Congo':    'DRC',
    'Hass Petroleum Zambia':   'ZM',
    'Hass South Sudan':        'SS',
    'Hass Petroleum Somalia':  'SO'
  };

  // Map country code → affiliate display label used in charts
  var CC_TO_LABEL = {
    KE:'HPK', UG:'HPU', TZ:'HPT', RW:'HPR',
    SS:'HSS', ZM:'HPZ', DRC:'HPC', CD:'HPC',
    MW:'HPM', SO:'HSO'
  };

  function resolveCC(row) {
    // If the sheet ever gains a country_code column, use it directly
    if (row.country_code) return String(row.country_code).trim().toUpperCase();
    var aff = String(row.affiliate || '').trim();
    // Exact match first
    if (AFFILIATE_TO_CC[aff]) return AFFILIATE_TO_CC[aff];
    // Partial match fallback
    for (var key in AFFILIATE_TO_CC) {
      if (aff.toLowerCase().indexOf(key.toLowerCase()) > -1) return AFFILIATE_TO_CC[key];
    }
    // Already a short code (ZM, DRC etc)?
    if (aff.length <= 3 && aff === aff.toUpperCase()) return aff;
    return 'OTHER';
  }

  // ── Filter rows ─────────────────────────────────────────────────────────────
  var filtered = slaData.filter(function(r) {
    // Must have a document number (skip blank / seed rows)
    var docNum = String(r.document_number || r.oracle_document_number || '').trim();
    if (!docNum || docNum === '' || docNum === 'nan') return false;

    // Date filter — use created_at (actual column name in sheet)
    var dateStr = r.created_at || r.created_at_oracle || '';
    if (dateStr) {
      var d = new Date(dateStr);
      if (!isNaN(d.getTime())) {
        if (d < f.startDate || d > f.endDate) return false;
      }
    }

    // Affiliate / country filter
    if (f.affiliate !== 'ALL') {
      var cc = resolveCC(r);
      if (cc !== f.affiliate) return false;
    }

    // Staff filter — match oracle_approver username
    if (f.staffId !== 'ALL') {
      var approver = String(r.oracle_approver || r.finance_approver || '').trim().toUpperCase();
      var targetId = String(f.staffId).toUpperCase();
      if (approver.indexOf(targetId) === -1 && targetId.indexOf(approver) === -1) return false;
    }

    return true;
  });

  // If date filters returned nothing, fall back to all available data so
  // the dashboard is never completely blank after an upload
  if (filtered.length === 0) {
    filtered = slaData.filter(function(r) {
      var docNum = String(r.document_number || r.oracle_document_number || '').trim();
      if (!docNum || docNum === '' || docNum === 'nan') return false;
      if (f.affiliate !== 'ALL' && resolveCC(r) !== f.affiliate) return false;
      return true;
    });
  }

  // ── Per-row calculations ────────────────────────────────────────────────────
  var SLA_FINANCE_MIN = 60;   // target: finance approval within 60 minutes
  var SLA_LA_MIN      = 120;  // target: LA issued within 120 minutes

  var rows = filtered.map(function(r) {
    var finMin = parseFloat(r.finance_variance_min) || 0;
    var laMin  = parseFloat(r.la_variance_min)      || 0;
    var cc     = resolveCC(r);
    var label  = CC_TO_LABEL[cc] || cc;

    var dateStr = r.created_at || r.created_at_oracle || '';
    var d = dateStr ? new Date(dateStr) : null;
    var ym = (d && !isNaN(d.getTime()))
      ? d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
      : null;

    // Calculate SLA compliance inline
    var finOk = finMin > 0 && finMin <= SLA_FINANCE_MIN;
    var laOk  = laMin  > 0 && laMin  <= SLA_LA_MIN;

    return {
      cc:               cc,
      affiliateLabel:   label,
      finance_min:      finMin,
      la_min:           laMin,
      approver:         String(r.oracle_approver || r.finance_approver || '').trim(),
      finance_ok:       finOk,
      la_ok:            laOk,
      both_ok:          finOk && laOk,
      ym:               ym
    };
  });

  // ── Overall KPIs ────────────────────────────────────────────────────────────
  var totalOrders  = rows.length;
  var finRows      = rows.filter(function(r){ return r.finance_min > 0; });
  var laRows       = rows.filter(function(r){ return r.la_min > 0; });

  var avgFinanceAll = finRows.length
    ? Math.round(finRows.reduce(function(s,r){ return s + r.finance_min; }, 0) / finRows.length)
    : 0;
  var avgLAAll = laRows.length
    ? Math.round(laRows.reduce(function(s,r){ return s + r.la_min; }, 0) / laRows.length)
    : 0;
  var onTimePct = totalOrders
    ? Math.round(rows.filter(function(r){ return r.finance_ok; }).length / totalOrders * 100)
    : 0;

  // ── By Affiliate ─────────────────────────────────────────────────────────────
  var groups = {};
  rows.forEach(function(r) {
    var k = r.affiliateLabel;
    if (!groups[k]) groups[k] = {
      affiliate: k, orders: 0,
      totalFinance: 0, finCount: 0, finOk: 0,
      totalLA: 0,      laCount:  0, laOk:  0,
      bothOk: 0
    };
    var g = groups[k];
    g.orders++;
    if (r.finance_min > 0) { g.totalFinance += r.finance_min; g.finCount++; if (r.finance_ok) g.finOk++; }
    if (r.la_min > 0)      { g.totalLA      += r.la_min;      g.laCount++;  if (r.la_ok)      g.laOk++;  }
    if (r.both_ok) g.bothOk++;
  });

  var byAffiliate = Object.values(groups).map(function(g) {
    return {
      affiliate:     g.affiliate,
      orders:        g.orders,
      avgFinance:    g.finCount ? Math.round(g.totalFinance / g.finCount) : 0,
      financeSLAPct: g.finCount ? Math.round(g.finOk / g.finCount * 100) : 0,
      avgLA:         g.laCount  ? Math.round(g.totalLA      / g.laCount)  : 0,
      laSLAPct:      g.laCount  ? Math.round(g.laOk  / g.laCount  * 100) : 0,
      onTimePct:     g.orders   ? Math.round(g.bothOk / g.orders   * 100) : 0
    };
  }).sort(function(a, b){ return b.orders - a.orders; });

  // ── Monthly Trend ────────────────────────────────────────────────────────────
  var monthMap = {};
  rows.forEach(function(r) {
    if (!r.ym) return;
    if (!monthMap[r.ym]) monthMap[r.ym] = { month: r.ym, totalFinance: 0, totalLA: 0, count: 0 };
    monthMap[r.ym].totalFinance += r.finance_min;
    monthMap[r.ym].totalLA      += r.la_min;
    monthMap[r.ym].count++;
  });

  var monthlyTrend = Object.values(monthMap)
    .sort(function(a, b){ return a.month.localeCompare(b.month); })
    .map(function(m) {
      var label = m.month;
      try {
        var d = new Date(m.month + '-01');
        label = d.toLocaleString('default', { month:'short' }) + ' ' + d.getFullYear().toString().slice(2);
      } catch(e) {}
      return {
        month:      label,
        avgFinance: m.count > 0 ? Math.round(m.totalFinance / m.count) : 0,
        avgLA:      m.count > 0 ? Math.round(m.totalLA      / m.count) : 0
      };
    });

  // ── Approver Performance ─────────────────────────────────────────────────────
  var approverMap = {};
  rows.forEach(function(r) {
    var name = r.approver;
    if (!name) return;
    if (!approverMap[name]) approverMap[name] = {
      name: name, count: 0, total: 0,
      fastest: Infinity, slowest: 0, withinSLA: 0
    };
    var g = approverMap[name];
    if (r.finance_min > 0) {
      g.count++;
      g.total      += r.finance_min;
      if (r.finance_min < g.fastest) g.fastest = r.finance_min;
      if (r.finance_min > g.slowest) g.slowest = r.finance_min;
      if (r.finance_ok) g.withinSLA++;
    }
  });

  var approverStats = Object.values(approverMap)
    .filter(function(g){ return g.count > 0; })
    .map(function(g) {
      return {
        name:         g.name,
        count:        g.count,
        avg:          g.total / g.count,
        fastest:      g.fastest === Infinity ? 0 : g.fastest,
        slowest:      g.slowest,
        withinSLAPct: Math.round(g.withinSLA / g.count * 100)
      };
    })
    .sort(function(a, b){ return b.withinSLAPct - a.withinSLAPct; });

  return {
    success:       true,
    kpis:          { avgFinance: avgFinanceAll, avgLA: avgLAAll, onTimePct: onTimePct, totalOrders: totalOrders },
    byAffiliate:   byAffiliate,
    monthlyTrend:  monthlyTrend,
    approverStats: approverStats,
    _meta: { rowsInSheet: slaData.length, rowsAfterFilter: filtered.length }
  };
}

// ============================================================================
// getExternalSLAAnalytics — UNCHANGED from v1.0.0
// ============================================================================
function getExternalSLAAnalytics(filters, affiliateFilter) {
  var ss       = getSpreadsheet();
  var tickets  = sheetToObjects(ss.getSheetByName('Tickets'));
  var comments = sheetToObjects(ss.getSheetByName('TicketComments'));
  var orders   = sheetToObjects(ss.getSheetByName('Orders'));
  var users    = sheetToObjects(ss.getSheetByName('Users'));
  var f        = parseFilters(filters, affiliateFilter);
  var affMap   = { KE:'HPK', UG:'HPU', TZ:'HPT', RW:'HPR', SS:'HSS', ZM:'HPZ', DRC:'HPC' };

  var deptUsers = null;
  if (f.department !== 'ALL') {
    deptUsers = users.filter(function(u){ return u.department === f.department; }).map(function(u){ return u.user_id; });
  }

  var filteredTickets = tickets.filter(function(t) {
    var created = new Date(t.created_at);
    if (isNaN(created) || created < f.startDate || created > f.endDate) return false;
    if (f.affiliate !== 'ALL' && t.country_code !== f.affiliate) return false;
    if (f.staffId !== 'ALL' && t.assigned_to !== f.staffId) return false;
    if (deptUsers && !deptUsers.includes(t.assigned_to)) return false;
    return true;
  });

  var ticketMetrics = filteredTickets.map(function(t) {
    var ticketComments = comments.filter(function(c){ return c.ticket_id === t.ticket_id && c.author_type === 'AGENT' && !c.is_internal; })
      .sort(function(a,b){ return new Date(a.created_at)-new Date(b.created_at); });
    var firstResponse = ticketComments.length > 0 ? ticketComments[0] : null;
    var firstResponseMin = null;
    if (firstResponse && t.created_at) {
      var diff = (new Date(firstResponse.created_at) - new Date(t.created_at)) / 60000;
      if (!isNaN(diff) && diff >= 0) firstResponseMin = diff;
    }
    var resolutionHrs = null;
    if (t.resolved_at && t.created_at) {
      var rDiff = (new Date(t.resolved_at) - new Date(t.created_at)) / 3600000;
      if (!isNaN(rDiff) && rDiff >= 0) resolutionHrs = rDiff;
    }
    var aff = affMap[t.country_code] || t.country_code || 'OTHER';
    var csat = parseFloat(t.satisfaction_rating) || 0;
    return {
      ticket_id: t.ticket_id, category: t.category || 'GENERAL',
      affiliate: aff, assigned_to: t.assigned_to,
      firstResponseMin: firstResponseMin, resolutionHrs: resolutionHrs,
      withinFirstResponse: firstResponseMin !== null && firstResponseMin <= 60,
      withinResolution: resolutionHrs !== null && resolutionHrs <= 24,
      csat: csat, created_at: t.created_at
    };
  });

  var filteredOrders = orders.filter(function(o) {
    if (!o.delivered_at || !o.submitted_at) return false;
    var created = new Date(o.created_at);
    if (isNaN(created) || created < f.startDate || created > f.endDate) return false;
    if (f.affiliate !== 'ALL' && o.country_code !== f.affiliate) return false;
    return true;
  });
  var fulfilment = filteredOrders.map(function(o) {
    var hrs = (new Date(o.delivered_at) - new Date(o.submitted_at)) / 3600000;
    return { orderNumber: o.order_number, orderDate: o.created_at, hrs: Math.round(hrs*10)/10,
      status: hrs<=24?'ON_TIME':hrs<=48?'SLIGHT':'DELAYED' };
  });

  var validFirstResponse = ticketMetrics.filter(function(t){ return t.firstResponseMin !== null; });
  var validResolution    = ticketMetrics.filter(function(t){ return t.resolutionHrs !== null; });
  var validCSAT          = ticketMetrics.filter(function(t){ return t.csat > 0; });
  var kpis = {
    avgFirstResponseMin: validFirstResponse.length > 0 ? validFirstResponse.reduce(function(s,t){return s+t.firstResponseMin;},0)/validFirstResponse.length : 0,
    avgResolutionHrs: validResolution.length > 0 ? validResolution.reduce(function(s,t){return s+t.resolutionHrs;},0)/validResolution.length : 0,
    avgFulfilmentHrs: fulfilment.length > 0 ? fulfilment.reduce(function(s,o){return s+o.hrs;},0)/fulfilment.length : 0,
    avgCSAT: validCSAT.length > 0 ? validCSAT.reduce(function(s,t){return s+t.csat;},0)/validCSAT.length : 0
  };

  var monthMap = {};
  ticketMetrics.forEach(function(t) {
    var mk = new Date(t.created_at).toISOString().slice(0,7);
    if (!monthMap[mk]) monthMap[mk] = { month:mk, totalFirstResponse:0, countFR:0, totalResolution:0, countR:0 };
    if (t.firstResponseMin !== null) { monthMap[mk].totalFirstResponse+=t.firstResponseMin; monthMap[mk].countFR++; }
    if (t.resolutionHrs !== null) { monthMap[mk].totalResolution+=t.resolutionHrs; monthMap[mk].countR++; }
  });
  var monthlyTrend = Object.values(monthMap).sort(function(a,b){return a.month.localeCompare(b.month);}).map(function(m){
    var label=m.month; try{ var d=new Date(m.month+'-01'); label=d.toLocaleString('default',{month:'short'})+' '+d.getFullYear().toString().slice(2); }catch(e){}
    return { month:label, avgFirstResponse:m.countFR>0?Math.round(m.totalFirstResponse/m.countFR):0, avgResolutionHrs:m.countR>0?Math.round(m.totalResolution/m.countR*10)/10:0 };
  });

  var catMap = {};
  ticketMetrics.forEach(function(t) {
    var cat = t.category || 'GENERAL';
    if (!catMap[cat]) catMap[cat] = { category:cat, total:0, countR:0, totalResolution:0 };
    catMap[cat].total++;
    if (t.resolutionHrs !== null) { catMap[cat].totalResolution+=t.resolutionHrs; catMap[cat].countR++; }
  });
  var byCategory = Object.values(catMap).map(function(c){
    return { category:c.category, tickets:c.total, avgResolutionHrs:c.countR>0?Math.round(c.totalResolution/c.countR*10)/10:0 };
  }).sort(function(a,b){return b.avgResolutionHrs-a.avgResolutionHrs;});

  var affMapData = {};
  ticketMetrics.forEach(function(t){
    var aff = t.affiliate;
    if (!affMapData[aff]) affMapData[aff] = { affiliate:aff, tickets:0, totalFR:0, countFR:0, frOk:0, totalR:0, countR:0, rOk:0, totalCSAT:0, csatCount:0 };
    var g = affMapData[aff]; g.tickets++;
    if (t.firstResponseMin!==null){ g.totalFR+=t.firstResponseMin; g.countFR++; if(t.withinFirstResponse)g.frOk++; }
    if (t.resolutionHrs!==null){ g.totalR+=t.resolutionHrs; g.countR++; if(t.withinResolution)g.rOk++; }
    if (t.csat>0){ g.totalCSAT+=t.csat; g.csatCount++; }
  });
  var affFulfilment = {};
  filteredOrders.forEach(function(o){
    var aff = affMap[o.country_code] || o.country_code || 'OTHER';
    if (!affFulfilment[aff]) affFulfilment[aff] = { total:0, sum:0, ok:0 };
    var hrs = (new Date(o.delivered_at) - new Date(o.submitted_at)) / 3600000;
    affFulfilment[aff].total++;
    affFulfilment[aff].sum += hrs;
    if (hrs <= 48) affFulfilment[aff].ok++;
  });
  var byAffiliate = Object.values(affMapData).map(function(g){
    var af = affFulfilment[g.affiliate] || { total:0, sum:0, ok:0 };
    return {
      affiliate: g.affiliate, tickets: g.tickets,
      avgFirstResponseMin: g.countFR>0?Math.round(g.totalFR/g.countFR):0,
      firstResponseSLAPct: g.countFR>0?Math.round(g.frOk/g.countFR*100):0,
      avgResolutionHrs: g.countR>0?Math.round(g.totalR/g.countR*10)/10:0,
      resolutionSLAPct: g.countR>0?Math.round(g.rOk/g.countR*100):0,
      avgFulfilmentHrs: af.total>0?Math.round(af.sum/af.total*10)/10:0,
      fulfilmentSLAPct: af.total>0?Math.round(af.ok/af.total*100):0,
      avgCSAT: g.csatCount>0?Math.round(g.totalCSAT/g.csatCount*10)/10:0
    };
  });

  var agentMap = {};
  ticketMetrics.forEach(function(t){
    var aid = t.assigned_to;
    if (!aid) return;
    if (!agentMap[aid]) agentMap[aid] = { userId:aid, tickets:0, totalFR:0, countFR:0, frOk:0, totalR:0, countR:0, totalCSAT:0, csatCount:0 };
    var g = agentMap[aid]; g.tickets++;
    if (t.firstResponseMin!==null){ g.totalFR+=t.firstResponseMin; g.countFR++; if(t.withinFirstResponse)g.frOk++; }
    if (t.resolutionHrs!==null){ g.totalR+=t.resolutionHrs; g.countR++; }
    if (t.csat>0){ g.totalCSAT+=t.csat; g.csatCount++; }
  });
  var agentPerformance = Object.values(agentMap).map(function(g){
    var user = users.find(function(u){ return u.user_id===g.userId; });
    var name = user ? (user.first_name||'')+ ' '+(user.last_name||'') : g.userId;
    return {
      name: name.trim(), tickets: g.tickets,
      avgFirstResponse: g.countFR>0?g.totalFR/g.countFR:0,
      avgResolution: g.countR>0?g.totalR/g.countR:0,
      avgCSAT: g.csatCount>0?g.totalCSAT/g.csatCount:0,
      withinSLAPct: g.countFR>0?Math.round(g.frOk/g.countFR*100):0
    };
  }).sort(function(a,b){ return b.withinSLAPct-a.withinSLAPct; });

  return { success:true, kpis:kpis, monthlyTrend:monthlyTrend, byCategory:byCategory, byAffiliate:byAffiliate, fulfilment:fulfilment, agentPerformance:agentPerformance };
}

/* ── Debug helpers ── */
function debugSLAAnalytics() {
  var r = getSLAAnalytics({ year: '2025', period: 'all', staff: 'ALL', department: 'ALL' }, 'ALL');
  Logger.log('success: ' + r.success);
  Logger.log('totalOrders: ' + (r.kpis && r.kpis.totalOrders));
  Logger.log('avgFinance: '  + (r.kpis && r.kpis.avgFinance) + ' min');
  Logger.log('avgLA: '       + (r.kpis && r.kpis.avgLA) + ' min');
  Logger.log('onTimePct: '   + (r.kpis && r.kpis.onTimePct) + '%');
  Logger.log('byAffiliate: ' + JSON.stringify(r.byAffiliate));
  Logger.log('monthlyTrend count: ' + (r.monthlyTrend||[]).length);
  Logger.log('approverStats count: ' + (r.approverStats||[]).length);
  Logger.log('_meta: ' + JSON.stringify(r._meta));
  if (r.error) Logger.log('ERROR: ' + r.error);
}

function debugExternalSLA() {
  var result = getExternalSLAAnalytics(
    { year: '2025', period: 'all', staff: 'ALL', department: 'ALL' },
    'ALL'
  );
  Logger.log('success: ' + result.success);
  Logger.log('total tickets processed: ' + (result.kpis ? 'kpis present' : 'NO KPIS'));
  if (result.kpis) {
    Logger.log('avgFirstResponseMin: ' + result.kpis.avgFirstResponseMin);
    Logger.log('avgResolutionHrs: '    + result.kpis.avgResolutionHrs);
    Logger.log('totalTickets (monthly trend count): ' + result.monthlyTrend.length);
    Logger.log('byAffiliate count: ' + result.byAffiliate.length);
    Logger.log('agentPerformance count: ' + result.agentPerformance.length);
    Logger.log('fulfilment points: ' + result.fulfilment.length);
  }
  if (result.error) Logger.log('ERROR: ' + result.error);
}
