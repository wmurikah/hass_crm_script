function handleSLARequest(params) {
  try {
    switch(params.action) {
      case 'getSLAAnalytics': return getSLAAnalytics(params.period, params.affiliate);
      default: return { success: false, error: 'Unknown SLA action' };
    }
  } catch(e) {
    Logger.log('handleSLARequest: ' + e.message);
    return { success: false, error: e.message };
  }
}

function getSLAAnalytics(period, affiliateFilter) {
  var ss      = getSpreadsheet();
  var orders  = sheetToObjects(ss.getSheetByName('Orders'));

  // Map 'ytd' to 'year' for parsePeriod compatibility
  var mappedPeriod = (period === 'ytd') ? 'year' : period;
  var range   = parsePeriod(mappedPeriod);

  // Filter orders in date range with valid statuses
  var filtered = orders.filter(function(o) {
    if (!o.status || !['DELIVERED','IN_TRANSIT','DISPATCHED','APPROVED'].includes(o.status)) return false;
    var created = new Date(o.created_at);
    if (isNaN(created.getTime())) return false;
    if (created < range.startDate || created > range.endDate) return false;
    if (affiliateFilter && affiliateFilter !== 'ALL' && o.country_code !== affiliateFilter) return false;
    return true;
  });

  // Map country_code to affiliate label
  var affMap = { KE:'HPK', UG:'HPU', TZ:'HPT', RW:'HPR', SS:'HSS', ZM:'HPZ', DRC:'HPC' };

  // Group by affiliate
  var groups = {};
  filtered.forEach(function(o) {
    var aff = affMap[o.country_code] || o.country_code || 'OTHER';
    if (String(o.order_number || '').indexOf('HTW') >= 0) aff = 'HTW';
    if (!groups[aff]) groups[aff] = { affiliate: aff, orders: 0, totalFinance: 0, financeCount: 0, totalLA: 0, laCount: 0, financeOk: 0, laOk: 0, delivOk: 0, delivCount: 0 };
    var g = groups[aff];
    g.orders++;

    // Finance variance: submitted_at to approved_at in minutes
    if (o.submitted_at && o.approved_at) {
      var fMin = (new Date(o.approved_at) - new Date(o.submitted_at)) / 60000;
      if (!isNaN(fMin) && fMin > 0) {
        g.totalFinance += fMin;
        g.financeCount++;
        if (fMin <= 60) g.financeOk++;
      }
    }

    // LA variance: approved_at to dispatched_at in minutes
    if (o.approved_at && o.dispatched_at) {
      var lMin = (new Date(o.dispatched_at) - new Date(o.approved_at)) / 60000;
      if (!isNaN(lMin) && lMin > 0) {
        g.totalLA += lMin;
        g.laCount++;
        if (lMin <= 120) g.laOk++;
      }
    }

    // On-time delivery: submitted_at to delivered_at <= 48 hours
    if (o.submitted_at && o.delivered_at) {
      var dHrs = (new Date(o.delivered_at) - new Date(o.submitted_at)) / 3600000;
      if (!isNaN(dHrs) && dHrs > 0) {
        g.delivCount++;
        if (dHrs <= 48) g.delivOk++;
      }
    }
  });

  var byAffiliate = Object.keys(groups).sort().map(function(key) {
    var g = groups[key];
    return {
      affiliate:     g.affiliate,
      orders:        g.orders,
      avgFinance:    g.financeCount > 0 ? Math.round(g.totalFinance / g.financeCount) : 0,
      financeSLAPct: g.financeCount > 0 ? Math.round(g.financeOk / g.financeCount * 100) : 0,
      avgLA:         g.laCount > 0 ? Math.round(g.totalLA / g.laCount) : 0,
      laSLAPct:      g.laCount > 0 ? Math.round(g.laOk / g.laCount * 100) : 0,
      onTimePct:     g.delivCount > 0 ? Math.round(g.delivOk / g.delivCount * 100) : 0
    };
  });

  // Overall KPIs — weighted averages
  var totalOrders   = filtered.length;
  var totalFinance  = 0, totalFinanceN = 0;
  var totalLA       = 0, totalLAN = 0;
  var totalDelivOk  = 0, totalDelivN = 0;
  Object.keys(groups).forEach(function(key) {
    var g = groups[key];
    totalFinance  += g.totalFinance;  totalFinanceN += g.financeCount;
    totalLA       += g.totalLA;       totalLAN      += g.laCount;
    totalDelivOk  += g.delivOk;       totalDelivN   += g.delivCount;
  });

  var kpis = {
    avgFinance:  totalFinanceN > 0 ? Math.round(totalFinance / totalFinanceN) : 0,
    avgLA:       totalLAN > 0 ? Math.round(totalLA / totalLAN) : 0,
    onTimePct:   totalDelivN > 0 ? Math.round(totalDelivOk / totalDelivN * 100) : 0,
    totalOrders: totalOrders
  };

  // Monthly trend
  var monthMap = {};
  filtered.forEach(function(o) {
    var d = new Date(o.created_at);
    var mk = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2);
    if (!monthMap[mk]) monthMap[mk] = { month: mk, totalFinance: 0, financeCount: 0, totalLA: 0, laCount: 0 };
    var m = monthMap[mk];
    if (o.submitted_at && o.approved_at) {
      var fMin = (new Date(o.approved_at) - new Date(o.submitted_at)) / 60000;
      if (!isNaN(fMin) && fMin > 0) { m.totalFinance += fMin; m.financeCount++; }
    }
    if (o.approved_at && o.dispatched_at) {
      var lMin = (new Date(o.dispatched_at) - new Date(o.approved_at)) / 60000;
      if (!isNaN(lMin) && lMin > 0) { m.totalLA += lMin; m.laCount++; }
    }
  });

  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var monthlyTrend = Object.keys(monthMap).sort().map(function(mk) {
    var m = monthMap[mk];
    var parts = mk.split('-');
    var label = months[parseInt(parts[1], 10) - 1] + ' ' + parts[0].slice(2);
    return {
      month:      label,
      avgFinance: m.financeCount > 0 ? Math.round(m.totalFinance / m.financeCount) : 0,
      avgLA:      m.laCount > 0 ? Math.round(m.totalLA / m.laCount) : 0
    };
  });

  return {
    success:      true,
    kpis:         kpis,
    byAffiliate:  byAffiliate,
    monthlyTrend: monthlyTrend
  };
}
