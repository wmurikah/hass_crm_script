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

  return {
    success:true,
    kpis:{ avgFinance:Math.round(sumFinance/n), avgLA:Math.round(sumLA/n), onTimePct:onTimePct, totalOrders:totalOrders },
    byAffiliate:byAffiliate,
    monthlyTrend:monthlyTrend
  };
}
