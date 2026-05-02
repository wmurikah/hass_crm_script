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
 *   affiliate       (was country_code - now resolved to country code inline)
 *   oracle_approver (was finance_approver)
 *   finance_within_sla and la_within_sla are now calculated inline
 *   (they are not stored in the sheet)
 */

// ============================================================================
// MODULE-LEVEL AFFILIATE MAPPINGS  (single source of truth for this file)
// ============================================================================

var SLA_NAME_TO_CC_ = {
  'Hass Petroleum Kenya':    'KE',
  'Hass Petroleum Uganda':   'UG',
  'Hass Petroleum Tanzania': 'TZ',
  'Hass Petroleum Rwanda':   'RW',
  'Hass Petroleum Congo':    'DRC',
  'Hass Petroleum Zambia':   'ZM',
  'Hass South Sudan':        'SS',
  'Hass Petroleum Somalia':  'SO',
  'Hass Petroleum Malawi':   'MW',
  'Hass Terminal Limited':   'HTW',
  'Hass Petroleum Terminal': 'HTW',
  'HTW':                     'HTW',
};

var SLA_CC_TO_LABEL_ = {
  KE:'HPK', UG:'HPU', TZ:'HPT', RW:'HPR',
  SS:'HSS', ZM:'HPZ', DRC:'HPC', CD:'HPC',
  MW:'HPM', SO:'HSO', HTW:'HTW',
};

function slaResolveCC_(affiliateStr) {
  var aff = String(affiliateStr || '').trim();
  if (SLA_NAME_TO_CC_[aff]) return SLA_NAME_TO_CC_[aff];
  if (aff.length <= 3 && /^[A-Z]+$/.test(aff)) return aff;
  for (var k in SLA_NAME_TO_CC_) {
    if (aff.toLowerCase().indexOf(k.toLowerCase()) !== -1) return SLA_NAME_TO_CC_[k];
  }
  return 'OTHER';
}

function slaToLabel_(cc) {
  return SLA_CC_TO_LABEL_[cc] || cc;
}

// ============================================================================

function handleSLARequest(params) {
  try {
    switch(params.action) {
      case 'getSLAAnalytics': return getSLAAnalytics(params.filters || params.period, params.affiliate);
      case 'getExternalSLAAnalytics': return getExternalSLAAnalytics(params.filters || params.period, params.affiliate);
      case 'getStaffList': return getStaffList();
      case 'getFinanceApproverDetail':
        return getFinanceApproverDetail(params.approverName, params.filters, params.affiliate);
      case 'getPOApproverDetail':
        return getPOApproverDetail(params.approverName, params.filters, params.affiliate);
      case 'getAffiliateDetail':
        return getAffiliateDetail(params.affiliateLabel, params.filters);
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
    var users = getSheetData('Users');
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
// getSLAAnalytics - UPDATED v1.1.0
// Reads actual SLAData sheet columns confirmed by diagnostic:
//   affiliate, document_number, oracle_approver, finance_variance_min,
//   la_variance_min, created_at, upload_batch_id
// Derives country_code from affiliate name. Calculates SLA booleans inline.
// ============================================================================
function getSLAAnalytics(filters, affiliateFilter) {
  var slaData = getSheetData('SLAData')    || [];
  var poData  = getSheetData('POApprovals') || [];
  var f       = parseFilters(filters, affiliateFilter);

  var resolveCC = slaResolveCC_;
  var toLabel   = slaToLabel_;

  // Filter SLAData
  var filtered = slaData.filter(function(r) {
    var doc = String(r.document_number || '').trim();
    if (!doc || doc === 'nan' || doc.indexOf('BACKFILL') === 0) return false;
    var ds = r.created_at || r.created_at_oracle || '';
    if (ds) {
      var d = new Date(ds);
      if (!isNaN(d.getTime())) {
        if (d < f.startDate || d > f.endDate) return false;
      }
    }
    if (f.affiliate !== 'ALL' && resolveCC(r.affiliate) !== f.affiliate) return false;
    if (f.staffId !== 'ALL') {
      var approver = String(r.oracle_approver || '').trim().toUpperCase();
      if (approver.indexOf(f.staffId.toUpperCase()) === -1) return false;
    }
    return true;
  });

  // Auto-fallback to year with most data if filter returns nothing
  if (filtered.length === 0 && slaData.length > 0) {
    var yearCounts = {};
    slaData.forEach(function(r) {
      var ds = r.created_at || '';
      if (!ds) return;
      var d = new Date(ds);
      if (isNaN(d.getTime())) return;
      var yr = String(d.getFullYear());
      yearCounts[yr] = (yearCounts[yr] || 0) + 1;
    });
    var bestYear = Object.keys(yearCounts).sort(function(a,b){
      return yearCounts[b] - yearCounts[a];
    })[0];
    if (bestYear) {
      var bf = new Date(parseInt(bestYear), 0, 1);
      var bt = new Date(parseInt(bestYear), 11, 31, 23, 59, 59);
      filtered = slaData.filter(function(r) {
        var doc = String(r.document_number || '').trim();
        if (!doc || doc === 'nan' || doc.indexOf('BACKFILL') === 0) return false;
        var ds = r.created_at || '';
        if (ds) {
          var d = new Date(ds);
          if (!isNaN(d.getTime()) && (d < bf || d > bt)) return false;
        }
        if (f.affiliate !== 'ALL' && resolveCC(r.affiliate) !== f.affiliate) return false;
        return true;
      });
      Logger.log('getSLAAnalytics: auto-fallback to year ' + bestYear + ', ' + filtered.length + ' rows');
    }
  }

  var SLA_FIN = 60, SLA_LA = 120;

  var rows = filtered.map(function(r) {
    var finMin = parseFloat(r.finance_variance_min) || 0;
    var laMin  = parseFloat(r.la_variance_min)      || 0;
    var cc     = resolveCC(r.affiliate);
    var label  = toLabel(cc);
    var ds     = r.created_at || '';
    var d      = ds ? new Date(ds) : null;
    var ym     = (d && !isNaN(d.getTime()))
      ? d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') : null;
    return {
      cc:cc, label:label,
      finMin:finMin, laMin:laMin,
      approver:String(r.oracle_approver || '').trim(),
      finOk:finMin > 0 && finMin <= SLA_FIN,
      laOk:laMin  > 0 && laMin  <= SLA_LA,
      bothOk:finMin > 0 && finMin <= SLA_FIN && laMin > 0 && laMin <= SLA_LA,
      ym:ym
    };
  });

  var total   = rows.length;
  var finRows = rows.filter(function(r){ return r.finMin > 0; });
  var laRows  = rows.filter(function(r){ return r.laMin  > 0; });

  var kpis = {
    avgFinance:  finRows.length ? Math.round(finRows.reduce(function(s,r){return s+r.finMin;},0)/finRows.length) : 0,
    avgLA:       laRows.length  ? Math.round(laRows.reduce(function(s,r){return s+r.laMin;}, 0)/laRows.length)  : 0,
    onTimePct:   total ? Math.round(rows.filter(function(r){return r.finOk;}).length/total*100) : 0,
    laSLAPct:    laRows.length ? Math.round(laRows.filter(function(r){return r.laOk;}).length/laRows.length*100) : 0,
    totalOrders: total
  };

  // By affiliate
  var groups = {};
  rows.forEach(function(r) {
    var k = r.label;
    if (!groups[k]) groups[k] = {affiliate:k,orders:0,fSum:0,fN:0,fOk:0,lSum:0,lN:0,lOk:0,bothOk:0};
    var g = groups[k]; g.orders++;
    if (r.finMin > 0) { g.fSum+=r.finMin; g.fN++; if(r.finOk) g.fOk++; }
    if (r.laMin  > 0) { g.lSum+=r.laMin;  g.lN++; if(r.laOk)  g.lOk++;  }
    if (r.bothOk) g.bothOk++;
  });
  var byAffiliate = Object.values(groups).map(function(g) {
    return {
      affiliate:g.affiliate, orders:g.orders,
      avgFinance:g.fN?Math.round(g.fSum/g.fN):0,
      financeSLAPct:g.fN?Math.round(g.fOk/g.fN*100):0,
      avgLA:g.lN?Math.round(g.lSum/g.lN):0,
      laSLAPct:g.lN?Math.round(g.lOk/g.lN*100):0,
      onTimePct:g.orders?Math.round(g.bothOk/g.orders*100):0
    };
  }).sort(function(a,b){return b.orders-a.orders;});

  // Monthly trend
  var monthMap = {};
  rows.forEach(function(r) {
    if (!r.ym) return;
    if (!monthMap[r.ym]) monthMap[r.ym]={month:r.ym,fSum:0,lSum:0,n:0};
    monthMap[r.ym].fSum+=r.finMin; monthMap[r.ym].lSum+=r.laMin; monthMap[r.ym].n++;
  });
  var monthlyTrend = Object.values(monthMap)
    .sort(function(a,b){return a.month.localeCompare(b.month);})
    .map(function(m) {
      var label=m.month;
      try{ var d=new Date(m.month+'-01'); label=d.toLocaleString('default',{month:'short'})+' '+d.getFullYear().toString().slice(2); }catch(e){}
      return {month:label,avgFinance:m.n?Math.round(m.fSum/m.n):0,avgLA:m.n?Math.round(m.lSum/m.n):0};
    });

  // Finance approver leaderboard
  var finApprMap = {};
  rows.forEach(function(r) {
    var name = r.approver; if (!name) return;
    if (!finApprMap[name]) finApprMap[name]={name:name,count:0,sum:0,fastest:Infinity,slowest:0,withinSLA:0};
    var g=finApprMap[name];
    if (r.finMin>0){g.count++;g.sum+=r.finMin;if(r.finMin<g.fastest)g.fastest=r.finMin;if(r.finMin>g.slowest)g.slowest=r.finMin;if(r.finOk)g.withinSLA++;}
  });
  var approverStats = Object.values(finApprMap)
    .filter(function(g){return g.count>0;})
    .map(function(g){return{name:g.name,count:g.count,avg:g.sum/g.count,fastest:g.fastest===Infinity?0:g.fastest,slowest:g.slowest,withinSLAPct:Math.round(g.withinSLA/g.count*100)};}).sort(function(a,b){return b.withinSLAPct-a.withinSLAPct;});

  // PO approver leaderboard from POApprovals
  var SLA_PO = 120;
  var filteredPO = poData.filter(function(r) {
    if (f.affiliate !== 'ALL' && resolveCC(r.affiliate) !== f.affiliate) return false;
    var ds = r.original_creation_date || '';
    if (ds) { var d=new Date(ds); if(!isNaN(d.getTime())&&(d<f.startDate||d>f.endDate)) return false; }
    return true;
  });
  var STEPS = ['first','second','third','fourth','fifth','sixth','seventh'];
  var poApprMap = {};
  filteredPO.forEach(function(r) {
    STEPS.forEach(function(step) {
      var name=String(r[step+'_approver']||'').trim();
      var v=parseFloat(r[step+'_variance_min']);
      if (!name||isNaN(v)||v<=0) return;
      if (!poApprMap[name]) poApprMap[name]={name:name,count:0,sum:0,fastest:Infinity,slowest:0,withinSLA:0};
      var g=poApprMap[name]; g.count++;g.sum+=v;
      if(v<g.fastest)g.fastest=v; if(v>g.slowest)g.slowest=v; if(v<=SLA_PO)g.withinSLA++;
    });
  });
  var poApproverStats = Object.values(poApprMap)
    .filter(function(g){return g.count>0;})
    .map(function(g){return{name:g.name,count:g.count,avg:g.sum/g.count,fastest:g.fastest===Infinity?0:g.fastest,slowest:g.slowest,withinSLAPct:Math.round(g.withinSLA/g.count*100)};}).sort(function(a,b){return b.withinSLAPct-a.withinSLAPct;});

  // PO summary by affiliate
  var poAffMap = {};
  filteredPO.forEach(function(r) {
    var label=toLabel(resolveCC(r.affiliate));
    if (!poAffMap[label]) poAffMap[label]={affiliate:label,poCount:0,stepCount:0,stepSum:0,stepOk:0};
    var g=poAffMap[label]; g.poCount++;
    STEPS.forEach(function(step){
      var v=parseFloat(r[step+'_variance_min']);
      if(!isNaN(v)&&v>0){g.stepCount++;g.stepSum+=v;if(v<=SLA_PO)g.stepOk++;}
    });
  });
  var poByAffiliate = Object.values(poAffMap).map(function(g){
    return{affiliate:g.affiliate,poCount:g.poCount,avgStepMin:g.stepCount?Math.round(g.stepSum/g.stepCount):0,stepSLAPct:g.stepCount?Math.round(g.stepOk/g.stepCount*100):0};
  }).sort(function(a,b){return b.poCount-a.poCount;});

  return {
    success:true,
    kpis:kpis,
    byAffiliate:byAffiliate,
    monthlyTrend:monthlyTrend,
    approverStats:approverStats,
    poApproverStats:poApproverStats,
    poByAffiliate:poByAffiliate,
    _meta:{rowsInSheet:slaData.length,rowsAfterFilter:filtered.length,poRowsInSheet:poData.length,poRowsAfterFilter:filteredPO.length}
  };
}

// ============================================================================
// getExternalSLAAnalytics - UNCHANGED from v1.0.0
// ============================================================================
function getExternalSLAAnalytics(filters, affiliateFilter) {
  var tickets  = getSheetData('Tickets');
  var comments = getSheetData('TicketComments');
  var orders   = getSheetData('Orders');
  var users    = getSheetData('Users');
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

/* ══════════════════════════════════════════════════════════════════════
 * SLA DRILL-DOWN DETAIL ENDPOINTS
 * ══════════════════════════════════════════════════════════════════════ */

function getFinanceApproverDetail(approverName, filters, affiliateFilter) {
  try {
    var slaData = getSheetData('SLAData') || [];
    var f       = parseFilters(filters, affiliateFilter);

    var rows = slaData.filter(function(r) {
      if (!r.document_number || String(r.document_number).indexOf('BACKFILL') === 0) return false;
      var approver = String(r.oracle_approver || '').trim().toUpperCase();
      if (approver !== String(approverName || '').trim().toUpperCase()) return false;
      if (f.affiliate !== 'ALL' && resolveCC(r.affiliate) !== f.affiliate) return false;
      var ds = r.created_at || '';
      if (ds) { var d=new Date(ds); if(!isNaN(d.getTime())&&(d<f.startDate||d>f.endDate)) return false; }
      return true;
    }).map(function(r) {
      var la = parseFloat(r.la_variance_min) || 0;
      var creditHoldEstimate = la > 120 ? Math.max(0, la - 120) : 0;
      return {
        document_number:      r.document_number,
        customer_name:        r.customer_name,
        ordered_item:         r.ordered_item,
        affiliate:            slaToLabel_(slaResolveCC_(r.affiliate)),
        created_at:           r.created_at,
        approved_at:          r.approved_at,
        dispatched_at:        r.dispatched_at,
        finance_variance_min: parseFloat(r.finance_variance_min) || 0,
        la_variance_min:      parseFloat(r.la_variance_min)      || 0,
        credit_hold_duration_min: creditHoldEstimate
      };
    }).sort(function(a,b){ return new Date(b.created_at)-new Date(a.created_at); });

    return { success: true, rows: rows, count: rows.length };
  } catch(e) {
    Logger.log('getFinanceApproverDetail error: ' + e.message);
    return { success: false, error: e.message, rows: [] };
  }
}

function getPOApproverDetail(approverName, filters, affiliateFilter) {
  try {
    var poData = getSheetData('POApprovals') || [];
    var f      = parseFilters(filters, affiliateFilter);

    var STEPS = ['first','second','third','fourth','fifth','sixth','seventh'];
    var targetName = String(approverName || '').trim().toLowerCase();

    var pos = poData.filter(function(r) {
      var ds = r.original_creation_date || '';
      if (ds) { var d=new Date(ds); if(!isNaN(d.getTime())&&(d<f.startDate||d>f.endDate)) return false; }
      if (f.affiliate !== 'ALL' && slaResolveCC_(r.affiliate) !== f.affiliate) return false;
      return STEPS.some(function(step) {
        return String(r[step+'_approver']||'').trim().toLowerCase() === targetName;
      });
    }).map(function(r) {
      var out = {
        po_number:             r.po_number,
        description:           r.description,
        nature:                r.nature,
        affiliate:             r.affiliate,
        created_by:            r.created_by,
        original_creation_date:r.original_creation_date,
        submission_date:       r.submission_date,
        submission_variance_min: parseFloat(r.submission_variance_min)||0
      };
      STEPS.forEach(function(step) {
        out[step+'_approver']      = r[step+'_approver']      || '';
        out[step+'_approval_date'] = r[step+'_approval_date'] || '';
        out[step+'_variance_min']  = parseFloat(r[step+'_variance_min']) || null;
      });
      return out;
    }).sort(function(a,b){ return new Date(b.original_creation_date)-new Date(a.original_creation_date); });

    return { success: true, pos: pos, count: pos.length };
  } catch(e) {
    Logger.log('getPOApproverDetail error: ' + e.message);
    return { success: false, error: e.message, pos: [] };
  }
}

function getAffiliateDetail(affiliateLabel, filters) {
  try {
    var slaData = getSheetData('SLAData') || [];
    var f       = parseFilters(filters, 'ALL');

    var rows = slaData.filter(function(r) {
      if (!r.document_number || String(r.document_number).indexOf('BACKFILL') === 0) return false;
      if (slaToLabel_(slaResolveCC_(r.affiliate)) !== affiliateLabel) return false;
      var ds = r.created_at || '';
      if (ds) { var d=new Date(ds); if(!isNaN(d.getTime())&&(d<f.startDate||d>f.endDate)) return false; }
      return true;
    }).map(function(r) {
      var la = parseFloat(r.la_variance_min)||0;
      return {
        document_number:      r.document_number,
        customer_name:        r.customer_name,
        ordered_item:         r.ordered_item,
        affiliate:            affiliateLabel,
        created_at:           r.created_at,
        approved_at:          r.approved_at,
        dispatched_at:        r.dispatched_at,
        finance_variance_min: parseFloat(r.finance_variance_min)||0,
        la_variance_min:      la,
        credit_hold_duration_min: la > 120 ? Math.max(0, la-120) : 0
      };
    }).sort(function(a,b){ return new Date(b.created_at)-new Date(a.created_at); });

    return { success: true, rows: rows, count: rows.length };
  } catch(e) {
    Logger.log('getAffiliateDetail error: ' + e.message);
    return { success: false, error: e.message, rows: [] };
  }
}
