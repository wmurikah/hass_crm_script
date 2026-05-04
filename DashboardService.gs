function handleDashboardRequest(params) {
  try {
    switch(params.action) {
      case 'getDashboardSummary': return getDashboardSummary(params.affiliate);
      case 'staffHeadcountWidget': return getStaffHeadcountWidget(params._session);
      default: return { success: false, error: 'Unknown dashboard action' };
    }
  } catch(e) {
    Logger.log('handleDashboardRequest: ' + e.message);
    return { success: false, error: e.message };
  }
}

/**
 * Headcount traffic-light widget for the staff dashboard.
 * Visible only to SUPER_ADMIN, CEO, CFO. Returns one entry per canonical role
 * with a status (OK / UNDER / OVER / CRITICAL) for traffic-light rendering.
 */
function getStaffHeadcountWidget(session) {
  if (!session || !session.userId) return { success: false, error: 'No session' };
  var allowed = ['SUPER_ADMIN', 'CEO', 'CFO'];
  try {
    var roles = (typeof tursoSelect === 'function')
      ? tursoSelect('SELECT role_code FROM user_roles WHERE user_id = ?', [session.userId]).map(function(r) { return r.role_code; })
      : [];
    if (!roles.some(function(r) { return allowed.indexOf(r) !== -1; })) {
      return { success: false, error: 'Permission denied', code: 'PERMISSION_DENIED' };
    }
    var report = staffHeadcountReconciliation();
    if (!report || !report.success) return report || { success: false, error: 'No data' };
    return {
      success: true,
      cells: report.targetVsActual.map(function(r) {
        return { role_code: r.role_code, role_name: r.role_name, actual: r.actual, target_min: r.target_min, target_max: r.target_max, status: r.status };
      }),
      summary: report.summary,
    };
  } catch(e) {
    return { success: false, error: e.message };
  }
}

function getDashboardSummary(affiliateFilter) {
  try {
    var tickets  = getSheetData('Tickets')  || [];
    var orders   = getSheetData('Orders')   || [];
    var messages = getSheetData('StaffMessages') || [];
    var slaData  = getSheetData('SLAData')  || [];
    var config   = getSheetData('Config')   || [];

    var openStatuses = ['NEW', 'OPEN', 'IN_PROGRESS', 'ESCALATED'];
    var pendingStatuses = ['SUBMITTED', 'PENDING_APPROVAL', 'APPROVED'];

    function affMatch(rec) {
      if (!affiliateFilter || affiliateFilter === 'ALL') return true;
      return rec.country_code === affiliateFilter;
    }

    var openTickets   = tickets.filter(function(t) { return openStatuses.indexOf(t.status) !== -1 && affMatch(t); });
    var pendingOrders = orders.filter(function(o) {  return pendingStatuses.indexOf(o.status) !== -1 && affMatch(o); });
    var inTransit     = orders.filter(function(o) {  return o.status === 'IN_TRANSIT' && affMatch(o); });
    var pendingApproval = orders.filter(function(o) { return o.status === 'PENDING_APPROVAL' && affMatch(o); });

    var unreadMessages = messages.filter(function(m) {
      return !String(m.read_by || '').includes('ALL');
    }).length;

    // Revenue today
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var todayMs = today.getTime();
    var revenueToday = orders.reduce(function(sum, o) {
      if (!affMatch(o)) return sum;
      var d = o.created_at ? new Date(o.created_at) : null;
      if (!d || isNaN(d.getTime())) return sum;
      if (d.getTime() < todayMs) return sum;
      return sum + (parseFloat(o.total_amount) || 0);
    }, 0);

    // 24h SLA breaches (finance > 60min OR LA > 120min)
    var dayAgo = Date.now() - 86400000;
    var slaBreaches24h = slaData.filter(function(r) {
      var d = r.created_at ? new Date(r.created_at) : null;
      if (!d || isNaN(d.getTime()) || d.getTime() < dayAgo) return false;
      var fin = parseFloat(r.finance_variance_min) || 0;
      var la  = parseFloat(r.la_variance_min) || 0;
      return fin > 60 || la > 120;
    }).length;

    // Yesterday comparators for delta tags
    var yStart = todayMs - 86400000;
    var yEnd   = todayMs;
    function inYesterday(rec) {
      var d = rec.created_at ? new Date(rec.created_at) : null;
      return d && !isNaN(d.getTime()) && d.getTime() >= yStart && d.getTime() < yEnd;
    }
    var prevTickets = tickets.filter(inYesterday).filter(affMatch).length;
    var prevOrders  = orders.filter(inYesterday).filter(affMatch).length;
    var prevTransit = orders.filter(function(o){ return o.status === 'IN_TRANSIT' && inYesterday(o) && affMatch(o); }).length;
    var prevApproval= orders.filter(function(o){ return o.status === 'PENDING_APPROVAL' && inYesterday(o) && affMatch(o); }).length;
    var prevRevenue = orders.reduce(function(s,o){ return inYesterday(o) && affMatch(o) ? s + (parseFloat(o.total_amount)||0) : s; }, 0);
    var prevBreaches= slaData.filter(function(r){
      var d = r.created_at ? new Date(r.created_at) : null;
      if (!d || isNaN(d.getTime())) return false;
      if (d.getTime() < yStart || d.getTime() >= yEnd) return false;
      var fin = parseFloat(r.finance_variance_min) || 0;
      var la  = parseFloat(r.la_variance_min) || 0;
      return fin > 60 || la > 120;
    }).length;

    // 14-day Operations Pulse
    var pulseSeries = [];
    for (var i = 13; i >= 0; i--) {
      var dayStart = todayMs - i * 86400000;
      var dayEnd   = dayStart + 86400000;
      var label    = new Date(dayStart);
      var labelStr = (label.getMonth() + 1) + '/' + label.getDate();
      var ticketCount = tickets.filter(function(t){
        var dt = t.created_at ? new Date(t.created_at).getTime() : 0;
        return dt >= dayStart && dt < dayEnd && affMatch(t);
      }).length;
      var orderCount = orders.filter(function(o){
        var dt = o.created_at ? new Date(o.created_at).getTime() : 0;
        return dt >= dayStart && dt < dayEnd && affMatch(o);
      }).length;
      var deliveredCount = orders.filter(function(o){
        if (o.status !== 'DELIVERED') return false;
        var dt = (o.delivered_at || o.updated_at) ? new Date(o.delivered_at || o.updated_at).getTime() : 0;
        return dt >= dayStart && dt < dayEnd && affMatch(o);
      }).length;
      pulseSeries.push({ label: labelStr, tickets: ticketCount, orders: orderCount, delivered: deliveredCount });
    }

    // Affiliate activity (last 30 days)
    var monthAgo = todayMs - 30 * 86400000;
    var affMap = {};
    orders.forEach(function(o) {
      if (!affMatch(o)) return;
      var dt = o.created_at ? new Date(o.created_at).getTime() : 0;
      if (dt < monthAgo) return;
      var label = o.country_code || 'Unknown';
      affMap[label] = (affMap[label] || 0) + 1;
    });
    var affiliateActivity = Object.keys(affMap)
      .map(function(k){ return { label: k, orders: affMap[k] }; })
      .sort(function(a, b){ return b.orders - a.orders; })
      .slice(0, 8);

    // Recent tickets with SLA risk
    var recentTickets = tickets
      .filter(function(t){ return openStatuses.indexOf(t.status) !== -1 && affMatch(t); })
      .sort(function(a, b){ return new Date(b.updated_at) - new Date(a.updated_at); })
      .slice(0, 5)
      .map(function(t) {
        var slaRisk = false;
        var created = t.created_at ? new Date(t.created_at).getTime() : 0;
        if (created && (Date.now() - created) > 4 * 3600 * 1000) slaRisk = true;
        return {
          ticket_number: t.ticket_number,
          subject:       t.subject,
          priority:      t.priority,
          status:        t.status,
          sla_risk:      slaRisk,
        };
      });

    var recentOrders = orders
      .filter(affMatch)
      .sort(function(a, b){ return new Date(b.created_at) - new Date(a.created_at); })
      .slice(0, 5)
      .map(function(o) {
        return {
          order_number: o.order_number,
          status:       o.status,
          country_code: o.country_code,
          total_amount: o.total_amount,
        };
      });

    // Channel health (does config exist + recent failures?)
    var configMap = {};
    config.forEach(function(c) { configMap[c.config_key] = c.config_value; });
    function channelStatus(keys) {
      var configured = keys.every(function(k){ return configMap[k] && String(configMap[k]).trim().length; });
      return configured ? 'ok' : 'idle';
    }
    var channelHealth = [
      { label: 'Turso Database',     status: 'ok' },
      { label: 'Oracle EBS',         status: channelStatus(['ORACLE_HOST', 'ORACLE_USERNAME']) },
      { label: 'WhatsApp',           status: channelStatus(['WA_PHONE_ID', 'WA_TOKEN']) },
      { label: 'Microsoft Teams',    status: channelStatus(['TEAMS_WEBHOOK_URL']) },
      { label: 'Twilio Voice',       status: channelStatus(['TWILIO_SID', 'TWILIO_TOKEN']) },
      { label: 'Email (Graph/Mail)', status: channelStatus(['EMAIL_PROVIDER']) },
      { label: 'OneDrive Backup',    status: channelStatus(['ONEDRIVE_REFRESH_TOKEN', 'ONEDRIVE_FOLDER_ID']) },
    ];

    // Health score (rough)
    var healthy = channelHealth.filter(function(c){ return c.status === 'ok'; }).length;
    var healthScore = Math.round(healthy / channelHealth.length * 100);
    if (slaBreaches24h > 5) healthScore = Math.max(0, healthScore - 15);

    // My tasks: open tickets assigned to current user, plus pending approvals if relevant
    var myTasks = [];
    var myEmail = '';
    try { myEmail = (Session.getActiveUser().getEmail() || '').toLowerCase(); } catch(e) {}
    if (myEmail) {
      tickets.forEach(function(t) {
        if (openStatuses.indexOf(t.status) === -1) return;
        if (String(t.assigned_to || '').toLowerCase() === myEmail) {
          myTasks.push({
            title:   t.ticket_number + ': ' + (t.subject || '').substring(0, 50),
            context: 'Open ticket - ' + (t.priority || 'NORMAL'),
            due:     t.priority === 'CRITICAL' ? 'Today' : 'This week',
          });
        }
      });
    }
    myTasks = myTasks.slice(0, 6);

    return {
      success:         true,
      openTickets:     openTickets.length,
      pendingOrders:   pendingOrders.length,
      inTransit:       inTransit.length,
      pendingApproval: pendingApproval.length,
      unreadMessages:  unreadMessages,
      revenueToday:    revenueToday,
      slaBreaches24h:  slaBreaches24h,
      previousDay: {
        openTickets:     prevTickets,
        pendingOrders:   prevOrders,
        inTransit:       prevTransit,
        pendingApproval: prevApproval,
        revenueToday:    prevRevenue,
        slaBreaches24h:  prevBreaches,
      },
      pulseSeries:        pulseSeries,
      affiliateActivity:  affiliateActivity,
      recentTickets:      recentTickets,
      recentOrders:       recentOrders,
      channelHealth:      channelHealth,
      healthScore:        healthScore,
      myTasks:            myTasks,
    };
  } catch(e) {
    Logger.log('getDashboardSummary: ' + e.message);
    return { success: false, error: e.message };
  }
}
