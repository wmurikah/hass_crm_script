/**
 * HASS PETROLEUM CMS - SLA SERVICE
 * Version: 1.0.0
 *
 * Handles:
 * - SLA analytics computation (finance approval, LA approval, on-time delivery)
 * - Per-affiliate breakdown and monthly trend data
 * - Period filtering (month, quarter, year-to-date)
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
  // Backward compatible: accepts either a plain string or a filters object
  if (typeof periodOrFilters === 'object' && periodOrFilters !== null) {
    return parseFilters(periodOrFilters);
  }
  // Legacy string mode — default to full current year
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
    default: // 'all' or anything else = full year
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

function getSLAAnalytics(filters, affiliateFilter) {
  var ss      = getSpreadsheet();
  var slaData = sheetToObjects(ss.getSheetByName('SLAData')) || [];
  var f       = parseFilters(filters, affiliateFilter);

  // Filter SLAData rows by date range and affiliate
  var filtered = slaData.filter(function(r){
    if (!r.oracle_document_number) return false;
    var created = r.created_at_oracle ? new Date(r.created_at_oracle) : null;
    if (!created || isNaN(created)) return false;
    if (created < f.startDate || created > f.endDate) return false;
    if (f.affiliate !== 'ALL' && String(r.country_code) !== f.affiliate) return false;
    return true;
  });

  // Apply staff filter (matches finance_approver username)
  if (f.staffId !== 'ALL') {
    var staffUser = sheetToObjects(ss.getSheetByName('Users')).find(function(u){ return u.user_id === f.staffId; });
    if (staffUser) {
      var uname = ((staffUser.first_name||'') + '.' + (staffUser.last_name||'')).toUpperCase().trim();
      filtered = filtered.filter(function(r){
        return String(r.finance_approver||'').toUpperCase().trim() === uname;
      });
    } else {
      filtered = filtered.filter(function(r){
        return String(r.finance_approver||'').toUpperCase().trim() === String(f.staffId).toUpperCase();
      });
    }
  }

  // Apply department filter via Users lookup
  if (f.department !== 'ALL') {
    var allUsers = sheetToObjects(ss.getSheetByName('Users'));
    var deptUsernames = allUsers
      .filter(function(u){ return u.department === f.department; })
      .map(function(u){ return ((u.first_name||'') + '.' + (u.last_name||'')).toUpperCase().trim(); });
    filtered = filtered.filter(function(r){
      return deptUsernames.indexOf(String(r.finance_approver||'').toUpperCase().trim()) >= 0;
    });
  }

  // Map country_code to affiliate label
  var affMap = { KE:'HPK', UG:'HPU', TZ:'HPT', RW:'HPR', SS:'HSS', ZM:'HPZ', DRC:'HPC', CD:'HPC', MW:'HPM', SO:'HSO' };

  function isTrue(v) {
    if (v === true) return true;
    var s = String(v||'').toLowerCase().trim();
    return s === 'true' || s === 'yes' || s === '1';
  }

  // Group by affiliate (country_code)
  var groups = {};
  filtered.forEach(function(r){
    var code = String(r.country_code||'OTHER');
    var aff = affMap[code] || code;
    if (!groups[aff]) groups[aff] = { affiliate:aff, orders:0, totalFinance:0, totalLA:0, financeOk:0, laOk:0, bothOk:0 };
    var g = groups[aff];
    g.orders++;

    var fMin = parseFloat(r.finance_variance_min) || 0;
    var lMin = parseFloat(r.la_variance_min) || 0;
    g.totalFinance += fMin;
    g.totalLA += lMin;

    var fOk = isTrue(r.finance_within_sla);
    var lOk = isTrue(r.la_within_sla);
    if (fOk) g.financeOk++;
    if (lOk) g.laOk++;
    if (fOk && lOk) g.bothOk++;
  });

  var byAffiliate = Object.values(groups).map(function(g){
    return {
      affiliate:    g.affiliate,
      orders:       g.orders,
      avgFinance:   g.orders > 0 ? Math.round(g.totalFinance / g.orders) : 0,
      financeSLAPct:g.orders > 0 ? Math.round(g.financeOk / g.orders * 100) : 0,
      avgLA:        g.orders > 0 ? Math.round(g.totalLA / g.orders) : 0,
      laSLAPct:     g.orders > 0 ? Math.round(g.laOk / g.orders * 100) : 0,
      onTimePct:    g.orders > 0 ? Math.round(g.bothOk / g.orders * 100) : 0
    };
  });

  // Overall KPIs — weighted by actual row counts across all filtered records
  var totalOrders = filtered.length;
  var grandFinance = 0, grandLA = 0, grandBothOk = 0;
  filtered.forEach(function(r){
    grandFinance += parseFloat(r.finance_variance_min) || 0;
    grandLA      += parseFloat(r.la_variance_min) || 0;
    if (isTrue(r.finance_within_sla) && isTrue(r.la_within_sla)) grandBothOk++;
  });
  var avgFinanceAll = totalOrders > 0 ? Math.round(grandFinance / totalOrders) : 0;
  var avgLAAll      = totalOrders > 0 ? Math.round(grandLA / totalOrders) : 0;
  var onTimePct     = totalOrders > 0 ? Math.round(grandBothOk / totalOrders * 100) : 0;

  // Monthly trend — group by YYYY-MM of created_at_oracle
  var monthMap = {};
  filtered.forEach(function(r){
    var d = new Date(r.created_at_oracle);
    if (isNaN(d)) return;
    var mk = d.toISOString().slice(0,7);
    if (!monthMap[mk]) monthMap[mk] = { month:mk, totalFinance:0, totalLA:0, count:0 };
    monthMap[mk].totalFinance += parseFloat(r.finance_variance_min) || 0;
    monthMap[mk].totalLA      += parseFloat(r.la_variance_min) || 0;
    monthMap[mk].count++;
  });
  var monthlyTrend = Object.values(monthMap)
    .sort(function(a,b){return a.month.localeCompare(b.month);})
    .map(function(m){
      var label = m.month;
      try {
        var d = new Date(m.month+'-01');
        label = d.toLocaleString('default',{month:'short'})+' '+d.getFullYear().toString().slice(2);
      } catch(e){}
      return { month:label, avgFinance:m.count>0?Math.round(m.totalFinance/m.count):0, avgLA:m.count>0?Math.round(m.totalLA/m.count):0 };
    });

  // Approver performance leaderboard — grouped by finance_approver username
  var approverMap = {};
  filtered.forEach(function(r) {
    var approver = String(r.finance_approver || '').trim();
    if (!approver) return;
    if (!approverMap[approver]) approverMap[approver] = { name:approver, count:0, total:0, fastest:Infinity, slowest:0, withinSLA:0 };
    var g = approverMap[approver];
    var fMin = parseFloat(r.finance_variance_min) || 0;
    if (fMin > 0) {
      g.count++;
      g.total += fMin;
      if (fMin < g.fastest) g.fastest = fMin;
      if (fMin > g.slowest) g.slowest = fMin;
      if (isTrue(r.finance_within_sla)) g.withinSLA++;
    }
  });
  var approverStats = Object.values(approverMap).map(function(g) {
    return {
      name: g.name,
      count: g.count,
      avg: g.count > 0 ? g.total / g.count : 0,
      fastest: g.fastest === Infinity ? 0 : g.fastest,
      slowest: g.slowest,
      withinSLAPct: g.count > 0 ? Math.round(g.withinSLA / g.count * 100) : 0
    };
  }).sort(function(a,b){ return b.withinSLAPct - a.withinSLAPct; });

  return {
    success:true,
    kpis:{ avgFinance:avgFinanceAll, avgLA:avgLAAll, onTimePct:onTimePct, totalOrders:totalOrders },
    byAffiliate:byAffiliate,
    monthlyTrend:monthlyTrend,
    approverStats:approverStats
  };
}

function getExternalSLAAnalytics(filters, affiliateFilter) {
  var ss       = getSpreadsheet();
  var tickets  = sheetToObjects(ss.getSheetByName('Tickets'));
  var comments = sheetToObjects(ss.getSheetByName('TicketComments'));
  var orders   = sheetToObjects(ss.getSheetByName('Orders'));
  var users    = sheetToObjects(ss.getSheetByName('Users'));
  var f        = parseFilters(filters, affiliateFilter);
  var affMap   = { KE:'HPK', UG:'HPU', TZ:'HPT', RW:'HPR', SS:'HSS', ZM:'HPZ', DRC:'HPC' };

  // Apply department filter — get list of user IDs in the department
  var deptUsers = null;
  if (f.department !== 'ALL') {
    deptUsers = users.filter(function(u){ return u.department === f.department; }).map(function(u){ return u.user_id; });
  }

  // Filter tickets in date range
  var filteredTickets = tickets.filter(function(t) {
    var created = new Date(t.created_at);
    if (isNaN(created) || created < f.startDate || created > f.endDate) return false;
    if (f.affiliate !== 'ALL' && t.country_code !== f.affiliate) return false;
    if (f.staffId !== 'ALL' && t.assigned_to !== f.staffId) return false;
    if (deptUsers && !deptUsers.includes(t.assigned_to)) return false;
    return true;
  });

  // For each ticket find first agent response time
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

  // Fulfilment data from Orders
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

  // KPIs
  var validFirstResponse = ticketMetrics.filter(function(t){ return t.firstResponseMin !== null; });
  var validResolution    = ticketMetrics.filter(function(t){ return t.resolutionHrs !== null; });
  var validCSAT          = ticketMetrics.filter(function(t){ return t.csat > 0; });
  var kpis = {
    avgFirstResponseMin: validFirstResponse.length > 0 ? validFirstResponse.reduce(function(s,t){return s+t.firstResponseMin;},0)/validFirstResponse.length : 0,
    avgResolutionHrs: validResolution.length > 0 ? validResolution.reduce(function(s,t){return s+t.resolutionHrs;},0)/validResolution.length : 0,
    avgFulfilmentHrs: fulfilment.length > 0 ? fulfilment.reduce(function(s,o){return s+o.hrs;},0)/fulfilment.length : 0,
    avgCSAT: validCSAT.length > 0 ? validCSAT.reduce(function(s,t){return s+t.csat;},0)/validCSAT.length : 0
  };

  // Monthly trend
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

  // By category
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

  // By affiliate
  var affMapData = {};
  ticketMetrics.forEach(function(t){
    var aff = t.affiliate;
    if (!affMapData[aff]) affMapData[aff] = { affiliate:aff, tickets:0, totalFR:0, countFR:0, frOk:0, totalR:0, countR:0, rOk:0, totalCSAT:0, csatCount:0 };
    var g = affMapData[aff]; g.tickets++;
    if (t.firstResponseMin!==null){ g.totalFR+=t.firstResponseMin; g.countFR++; if(t.withinFirstResponse)g.frOk++; }
    if (t.resolutionHrs!==null){ g.totalR+=t.resolutionHrs; g.countR++; if(t.withinResolution)g.rOk++; }
    if (t.csat>0){ g.totalCSAT+=t.csat; g.csatCount++; }
  });
  // Fulfilment by affiliate
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

  // Agent performance
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

/* ── Temporary Debug Helper (remove after confirming data loads) ── */
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
