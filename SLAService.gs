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
      case 'getSLAAnalytics': return getSLAAnalytics(params.period, params.affiliate);
      case 'getExternalSLAAnalytics': return getExternalSLAAnalytics(params.period, params.affiliate);
      default: return { success:false, error:'Unknown SLA action' };
    }
  } catch(e) {
    Logger.log('handleSLARequest: ' + e.message);
    return { success:false, error:e.message };
  }
}

function getSLAAnalytics(period, affiliateFilter) {
  var ss      = getSpreadsheet();
  var orders  = sheetToObjects(ss.getSheetByName('Orders'));
  var range   = parsePeriod(period);

  // Filter delivered orders in date range
  var filtered = orders.filter(function(o){
    if (!['DELIVERED','IN_TRANSIT'].includes(o.status)) return false;
    var created = new Date(o.created_at);
    if (isNaN(created)) return false;
    if (created < range.startDate || created > range.endDate) return false;
    if (affiliateFilter && affiliateFilter !== 'ALL' && o.country_code !== affiliateFilter) return false;
    return true;
  });

  // Map country_code to affiliate label
  var affMap = { KE:'HPK', UG:'HPU', TZ:'HPT', RW:'HPR', SS:'HSS', ZM:'HPZ', DRC:'HPC' };

  // Group by affiliate
  var groups = {};
  filtered.forEach(function(o){
    var aff = affMap[o.country_code] || o.country_code || 'OTHER';
    // Use order_number to check if it is an HTW order
    if (String(o.order_number||'').includes('HTW')) aff = 'HTW';
    if (!groups[aff]) groups[aff] = { affiliate:aff, orders:0, totalFinance:0, totalLA:0, financeOk:0, laOk:0, delivOk:0 };
    var g = groups[aff];
    g.orders++;

    // Finance variance: submitted_at to approved_at in minutes
    if (o.submitted_at && o.approved_at) {
      var fMin = (new Date(o.approved_at) - new Date(o.submitted_at)) / 60000;
      if (!isNaN(fMin) && fMin > 0) {
        g.totalFinance += fMin;
        if (fMin <= 60) g.financeOk++;
      }
    }

    // LA variance: approved_at to dispatched_at in minutes
    if (o.approved_at && o.dispatched_at) {
      var lMin = (new Date(o.dispatched_at) - new Date(o.approved_at)) / 60000;
      if (!isNaN(lMin) && lMin > 0) {
        g.totalLA += lMin;
        if (lMin <= 120) g.laOk++;
      }
    }

    // On-time delivery: submitted_at to delivered_at <= 48 hours
    if (o.submitted_at && o.delivered_at) {
      var dHrs = (new Date(o.delivered_at) - new Date(o.submitted_at)) / 3600000;
      if (!isNaN(dHrs) && dHrs > 0 && dHrs <= 48) g.delivOk++;
    }
  });

  var byAffiliate = Object.values(groups).map(function(g){
    return {
      affiliate:    g.affiliate,
      orders:       g.orders,
      avgFinance:   g.orders > 0 ? Math.round(g.totalFinance / g.orders) : 0,
      financeSLAPct:g.orders > 0 ? Math.round(g.financeOk / g.orders * 100) : 0,
      avgLA:        g.orders > 0 ? Math.round(g.totalLA / g.orders) : 0,
      laSLAPct:     g.orders > 0 ? Math.round(g.laOk / g.orders * 100) : 0,
      onTimePct:    g.orders > 0 ? Math.round(g.delivOk / g.orders * 100) : 0
    };
  });

  // Overall KPIs
  var totalOrders = filtered.length;
  var sumFinance = byAffiliate.reduce(function(s,a){return s+a.avgFinance;},0);
  var sumLA      = byAffiliate.reduce(function(s,a){return s+a.avgLA;},0);
  var n = byAffiliate.length || 1;
  var onTimePct  = byAffiliate.length > 0 ? Math.round(byAffiliate.reduce(function(s,a){return s+a.onTimePct;},0)/n) : 0;

  // Monthly trend
  var monthMap = {};
  filtered.forEach(function(o){
    var mk = new Date(o.created_at).toISOString().slice(0,7);
    if (!monthMap[mk]) monthMap[mk] = { month:mk, totalFinance:0, totalLA:0, count:0 };
    if (o.submitted_at && o.approved_at) {
      var fMin = (new Date(o.approved_at)-new Date(o.submitted_at))/60000;
      if (!isNaN(fMin)&&fMin>0) monthMap[mk].totalFinance+=fMin;
    }
    if (o.approved_at && o.dispatched_at) {
      var lMin = (new Date(o.dispatched_at)-new Date(o.approved_at))/60000;
      if (!isNaN(lMin)&&lMin>0) monthMap[mk].totalLA+=lMin;
    }
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

  // Approver performance leaderboard
  var users = sheetToObjects(ss.getSheetByName('Users'));
  var approverMap = {};
  filtered.forEach(function(o) {
    var approver = o.approved_by;
    if (!approver) return;
    if (!approverMap[approver]) approverMap[approver] = { id:approver, count:0, total:0, fastest:Infinity, slowest:0, withinSLA:0 };
    var g = approverMap[approver];
    if (o.submitted_at && o.approved_at) {
      var fMin = (new Date(o.approved_at) - new Date(o.submitted_at)) / 60000;
      if (!isNaN(fMin) && fMin > 0) {
        g.count++;
        g.total += fMin;
        if (fMin < g.fastest) g.fastest = fMin;
        if (fMin > g.slowest) g.slowest = fMin;
        if (fMin <= 60) g.withinSLA++;
      }
    }
  });
  var approverStats = Object.values(approverMap).map(function(g) {
    var user = users.find(function(u){ return u.user_id === g.id; });
    var name = user ? ((user.first_name||'') + ' ' + (user.last_name||'')).trim() : g.id;
    return {
      name: name, count: g.count,
      avg: g.count > 0 ? g.total / g.count : 0,
      fastest: g.fastest === Infinity ? 0 : g.fastest,
      slowest: g.slowest,
      withinSLAPct: g.count > 0 ? Math.round(g.withinSLA / g.count * 100) : 0
    };
  }).sort(function(a,b){ return b.withinSLAPct - a.withinSLAPct; });

  return {
    success:true,
    kpis:{ avgFinance:Math.round(sumFinance/n), avgLA:Math.round(sumLA/n), onTimePct:onTimePct, totalOrders:totalOrders },
    byAffiliate:byAffiliate,
    monthlyTrend:monthlyTrend,
    approverStats:approverStats
  };
}

function getExternalSLAAnalytics(period, affiliateFilter) {
  var ss       = getSpreadsheet();
  var tickets  = sheetToObjects(ss.getSheetByName('Tickets'));
  var comments = sheetToObjects(ss.getSheetByName('TicketComments'));
  var orders   = sheetToObjects(ss.getSheetByName('Orders'));
  var users    = sheetToObjects(ss.getSheetByName('Users'));
  var range    = parsePeriod(period);
  var affMap   = { KE:'HPK', UG:'HPU', TZ:'HPT', RW:'HPR', SS:'HSS', ZM:'HPZ', DRC:'HPC' };

  // Filter tickets in date range
  var filteredTickets = tickets.filter(function(t) {
    var created = new Date(t.created_at);
    if (isNaN(created) || created < range.startDate || created > range.endDate) return false;
    if (affiliateFilter && affiliateFilter !== 'ALL' && t.country_code !== affiliateFilter) return false;
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
    if (isNaN(created) || created < range.startDate || created > range.endDate) return false;
    if (affiliateFilter && affiliateFilter !== 'ALL' && o.country_code !== affiliateFilter) return false;
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
