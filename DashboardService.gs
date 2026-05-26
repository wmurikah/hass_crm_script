// Global roles see all affiliates; all others are scoped to their country.
var DASHBOARD_GLOBAL_ROLES_ = [
  'SUPER_ADMIN','CEO','CFO','RMD','INTERNAL_AUDITOR','GROUP_HEAD','CTO'
];
// Roles that may see System Channels health panel
var DASHBOARD_CHANNEL_ROLES_ = [
  'SUPER_ADMIN','CEO','CFO','CTO','GROUP_HEAD'
];

function handleDashboardRequest(params) {
  try {
    // When called via google.script.run directly (not via doPost), _session is not
    // injected by the auth guard. Resolve it from the token in that case.
    if (!params._session && params.token) {
      var sess = checkSession({ token: params.token });
      if (sess && sess.valid) params._session = sess;
    }
    switch(params.action) {
      case 'getDashboardSummary': return getDashboardSummary(params);
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

/**
 * Resolve the effective affiliate scope for a session.
 * Global roles → use the requested affiliateFilter.
 * Country-scoped roles → always locked to their country_code, request ignored.
 * Returns { scope:'GLOBAL'|'COUNTRY', country:null|'KE', effectiveFilter:'ALL'|'KE' }
 */
function resolveAffiliateScope_(session, requestedFilter) {
  if (!session || !session.userId) {
    return { scope: 'GLOBAL', country: null, effectiveFilter: requestedFilter || 'ALL' };
  }
  try {
    var rows = (typeof tursoSelect === 'function')
      ? tursoSelect('SELECT role_code FROM user_roles WHERE user_id = ?', [session.userId])
      : [];
    var userRoles = rows.map(function(r) { return r.role_code; });
    var isGlobal = userRoles.some(function(r) {
      return DASHBOARD_GLOBAL_ROLES_.indexOf(r) !== -1;
    });
    if (isGlobal) {
      return { scope: 'GLOBAL', country: null, effectiveFilter: requestedFilter || 'ALL' };
    }
    // Country-scoped: fetch their country_code from users table
    var userRows = (typeof tursoSelect === 'function')
      ? tursoSelect('SELECT country_code FROM users WHERE user_id = ?', [session.userId])
      : [];
    var country = (userRows.length && userRows[0].country_code) ? String(userRows[0].country_code).trim() : null;
    if (!country) {
      // No country data - fall back to global scope so dashboard is not empty
      return { scope: 'GLOBAL', country: null, effectiveFilter: requestedFilter || 'ALL' };
    }
    return { scope: 'COUNTRY', country: country, effectiveFilter: country };
  } catch(e) {
    Logger.log('resolveAffiliateScope_: ' + e.message);
    return { scope: 'GLOBAL', country: null, effectiveFilter: requestedFilter || 'ALL' };
  }
}

/**
 * Return true if the session user may see the System Channels panel.
 */
function canSeeChannels_(session) {
  if (!session || !session.userId) return false;
  try {
    var rows = (typeof tursoSelect === 'function')
      ? tursoSelect('SELECT role_code FROM user_roles WHERE user_id = ?', [session.userId])
      : [];
    var roles = rows.map(function(r) { return r.role_code; });
    return roles.some(function(r) { return DASHBOARD_CHANNEL_ROLES_.indexOf(r) !== -1; });
  } catch(e) {
    return false;
  }
}

/**
 * Main dashboard summary.
 * params.affiliate   - requested filter (may be overridden by server-side scope)
 * params.period      - number of days for the activity window (default 14)
 * params._session    - validated session object injected by the auth guard
 */
function getDashboardSummary(params) {
  try {
    var session        = params._session || null;
    var requestedAff   = String(params.affiliate || 'ALL').trim();
    var periodDays     = Math.min(Math.max(parseInt(params.period, 10) || 14, 7), 90);

    // Server-side scope resolution - a country user cannot widen their scope
    var scopeInfo = resolveAffiliateScope_(session, requestedAff);
    var affiliateFilter = scopeInfo.effectiveFilter;

    var tickets  = getSheetData('Tickets')  || [];
    var orders   = getSheetData('Orders')   || [];
    var messages = getSheetData('StaffMessages') || [];
    var slaData  = getSheetData('SLAData')  || [];
    var config   = getSheetData('Config')   || [];

    // Try Turso for richer data when available
    if (typeof tursoSelect === 'function') {
      try {
        var tRows = tursoSelect('SELECT * FROM tickets LIMIT 2000', []);
        if (tRows && tRows.length > 0) tickets = tRows;
        var oRows = tursoSelect('SELECT * FROM orders LIMIT 2000', []);
        if (oRows && oRows.length > 0) orders = oRows;
      } catch(tuErr) { Logger.log('getDashboardSummary Turso fetch: ' + tuErr.message); }
    }

    var openStatuses    = ['NEW', 'OPEN', 'IN_PROGRESS', 'ESCALATED'];
    var pendingStatuses = ['SUBMITTED', 'PENDING_APPROVAL', 'APPROVED'];

    function affMatch(rec) {
      if (!affiliateFilter || affiliateFilter === 'ALL') return true;
      return rec.country_code === affiliateFilter;
    }

    var openTickets     = tickets.filter(function(t) { return openStatuses.indexOf(t.status) !== -1 && affMatch(t); });
    var pendingOrders   = orders.filter(function(o) { return pendingStatuses.indexOf(o.status) !== -1 && affMatch(o); });
    var inTransit       = orders.filter(function(o) { return o.status === 'IN_TRANSIT' && affMatch(o); });
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

    // 24h SLA breaches
    var dayAgo = Date.now() - 86400000;
    var slaBreaches24h = slaData.filter(function(r) {
      var d = r.created_at ? new Date(r.created_at) : null;
      if (!d || isNaN(d.getTime()) || d.getTime() < dayAgo) return false;
      var fin = parseFloat(r.finance_variance_min) || 0;
      var la  = parseFloat(r.la_variance_min) || 0;
      return fin > 60 || la > 120;
    }).length;
    // Also count open tickets with sla_resolve_breached flag
    var ticketBreaches = openTickets.filter(function(t) {
      return t.sla_resolve_breached === true || t.sla_resolve_breached === 1 || t.sla_resolve_breached === '1';
    }).length;
    slaBreaches24h = Math.max(slaBreaches24h, ticketBreaches);

    // Yesterday comparators for delta tags
    var yStart = todayMs - 86400000;
    var yEnd   = todayMs;
    function inYesterday(rec) {
      var d = rec.created_at ? new Date(rec.created_at) : null;
      return d && !isNaN(d.getTime()) && d.getTime() >= yStart && d.getTime() < yEnd;
    }
    var prevTickets  = tickets.filter(inYesterday).filter(affMatch).length;
    var prevOrders   = orders.filter(inYesterday).filter(affMatch).length;
    var prevTransit  = orders.filter(function(o){ return o.status === 'IN_TRANSIT' && inYesterday(o) && affMatch(o); }).length;
    var prevApproval = orders.filter(function(o){ return o.status === 'PENDING_APPROVAL' && inYesterday(o) && affMatch(o); }).length;
    var prevRevenue  = orders.reduce(function(s,o){ return inYesterday(o) && affMatch(o) ? s + (parseFloat(o.total_amount)||0) : s; }, 0);
    var prevBreaches = slaData.filter(function(r) {
      var d = r.created_at ? new Date(r.created_at) : null;
      if (!d || isNaN(d.getTime())) return false;
      if (d.getTime() < yStart || d.getTime() >= yEnd) return false;
      var fin = parseFloat(r.finance_variance_min) || 0;
      var la  = parseFloat(r.la_variance_min) || 0;
      return fin > 60 || la > 120;
    }).length;

    // Operations Pulse - use the shared periodDays window
    var pulseSeries = [];
    for (var i = periodDays - 1; i >= 0; i--) {
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

    // Affiliate activity - use the same periodDays window (not hardcoded 30)
    var windowStart = todayMs - periodDays * 86400000;
    var affMap = {};
    orders.forEach(function(o) {
      if (!affMatch(o)) return;
      var dt = o.created_at ? new Date(o.created_at).getTime() : 0;
      if (dt < windowStart) return;
      var label = o.country_code || 'Unknown';
      affMap[label] = (affMap[label] || 0) + 1;
    });
    var affiliateActivity = Object.keys(affMap)
      .map(function(k){ return { label: k, orders: affMap[k] }; })
      .sort(function(a, b){ return b.orders - a.orders; });

    // Recent tickets with SLA risk
    var recentTickets = tickets
      .filter(function(t){ return openStatuses.indexOf(t.status) !== -1 && affMatch(t); })
      .sort(function(a, b){ return new Date(b.updated_at) - new Date(a.updated_at); })
      .slice(0, 5)
      .map(function(t) {
        var slaRisk = false;
        var created = t.created_at ? new Date(t.created_at).getTime() : 0;
        if (created && (Date.now() - created) > 4 * 3600 * 1000) slaRisk = true;
        if (t.sla_resolve_breached === true || t.sla_resolve_breached === 1 || t.sla_resolve_breached === '1') slaRisk = true;
        return {
          ticket_id:     t.ticket_id,
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
          order_id:     o.order_id,
          order_number: o.order_number,
          status:       o.status,
          country_code: o.country_code,
          total_amount: o.total_amount,
        };
      });

    // Channel health - only returned to authorised roles
    var channelHealth = null;
    if (canSeeChannels_(session)) {
      var configMap = {};
      config.forEach(function(c) { configMap[c.config_key] = c.config_value; });
      function channelStatus(keys) {
        var configured = keys.every(function(k){ return configMap[k] && String(configMap[k]).trim().length; });
        return configured ? 'ok' : 'idle';
      }
      channelHealth = [
        { label: 'Turso Database',     status: 'ok' },
        { label: 'Oracle EBS',         status: channelStatus(['ORACLE_HOST', 'ORACLE_USERNAME']) },
        { label: 'WhatsApp',           status: channelStatus(['WA_PHONE_ID', 'WA_TOKEN']) },
        { label: 'Microsoft Teams',    status: channelStatus(['TEAMS_WEBHOOK_URL']) },
        { label: 'Twilio Voice',       status: channelStatus(['TWILIO_SID', 'TWILIO_TOKEN']) },
        { label: 'Email (Graph/Mail)', status: channelStatus(['EMAIL_PROVIDER']) },
        { label: 'OneDrive Backup',    status: channelStatus(['ONEDRIVE_REFRESH_TOKEN', 'ONEDRIVE_FOLDER_ID']) },
      ];
    }

    // Health score (rough) - only relevant when channels are visible
    var healthScore = null;
    if (channelHealth) {
      var healthy = channelHealth.filter(function(c){ return c.status === 'ok'; }).length;
      healthScore = Math.round(healthy / channelHealth.length * 100);
      if (slaBreaches24h > 5) healthScore = Math.max(0, healthScore - 15);
    }

    // My Tasks: tickets assigned to the signed-in user + pending approvals
    var myTasks = [];
    if (session && session.userId) {
      var userId = session.userId;
      // Assigned tickets
      tickets.forEach(function(t) {
        if (openStatuses.indexOf(t.status) === -1) return;
        var assignedTo = String(t.assigned_to || '').trim();
        if (assignedTo === userId || assignedTo === String(session.email || '').toLowerCase()) {
          myTasks.push({
            id:      t.ticket_id,
            type:    'ticket',
            title:   (t.ticket_number || '') + ': ' + (t.subject || '').substring(0, 50),
            context: 'Open ticket – ' + (t.priority || 'NORMAL'),
            due:     t.priority === 'CRITICAL' ? 'Today' : 'This week',
          });
        }
      });
      // Pending approvals from ApprovalRequests (if available)
      try {
        var approvalRows = getSheetData('ApprovalRequests') || [];
        if (typeof tursoSelect === 'function') {
          var approvalTurso = tursoSelect('SELECT * FROM approval_requests WHERE approver_id = ? AND status = ? LIMIT 20', [userId, 'PENDING']);
          if (approvalTurso && approvalTurso.length > 0) approvalRows = approvalTurso;
        }
        approvalRows.forEach(function(a) {
          if (String(a.approver_id || '').trim() !== userId) return;
          if (String(a.status || '').toUpperCase() !== 'PENDING') return;
          myTasks.push({
            id:      a.request_id || a.order_id,
            type:    'approval',
            title:   'Approve: ' + (a.order_number || a.request_id || 'request'),
            context: 'Pending approval – ' + (a.approval_type || 'Order'),
            due:     'Urgent',
          });
        });
      } catch(apErr) { Logger.log('myTasks approvals: ' + apErr.message); }
      // Pending POs from orders where user is the submitter
      try {
        orders.forEach(function(o) {
          if (String(o.status || '').toUpperCase() !== 'PENDING_APPROVAL') return;
          if (String(o.created_by || o.user_id || '').trim() !== userId) return;
          myTasks.push({
            id:      o.order_id,
            type:    'order',
            title:   (o.order_number || o.order_id || '') + ' awaiting approval',
            context: 'Pending PO – ' + (o.country_code || ''),
            due:     'This week',
          });
        });
      } catch(poErr) { Logger.log('myTasks POs: ' + poErr.message); }
    }
    myTasks = myTasks.slice(0, 8);

    return {
      success:         true,
      scopeInfo:       { scope: scopeInfo.scope, country: scopeInfo.country },
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
      periodDays:         periodDays,
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
