function handleDashboardRequest(params) {
  try {
    switch(params.action) {
      case 'getDashboardSummary': return getDashboardSummary(params.affiliate);
      default: return { success: false, error: 'Unknown dashboard action' };
    }
  } catch(e) {
    Logger.log('handleDashboardRequest: ' + e.message);
    return { success: false, error: e.message };
  }
}

function getDashboardSummary(affiliateFilter) {
  try {
    var tickets  = getSheetData('Tickets');
    var orders   = getSheetData('Orders');
    var messages = getSheetData('StaffMessages');

    var openStatuses  = ['NEW', 'OPEN', 'IN_PROGRESS', 'ESCALATED'];
    var openTickets   = tickets.filter(function(t) { return openStatuses.indexOf(t.status) !== -1; });
    var pendingOrders = orders.filter(function(o) {
      return ['SUBMITTED', 'PENDING_APPROVAL', 'APPROVED'].indexOf(o.status) !== -1;
    });
    var inTransit = orders.filter(function(o) { return o.status === 'IN_TRANSIT'; });

    if (affiliateFilter && affiliateFilter !== 'ALL') {
      openTickets   = openTickets.filter(function(t)   { return t.country_code === affiliateFilter; });
      pendingOrders = pendingOrders.filter(function(o) { return o.country_code === affiliateFilter; });
      inTransit     = inTransit.filter(function(o)     { return o.country_code === affiliateFilter; });
    }

    var unreadMessages = messages.filter(function(m) {
      return !String(m.read_by || '').includes('ALL');
    }).length;

    var recentTickets = tickets
      .filter(function(t) { return openStatuses.indexOf(t.status) !== -1; })
      .sort(function(a, b) { return new Date(b.updated_at) - new Date(a.updated_at); })
      .slice(0, 5);

    var recentOrders = orders
      .sort(function(a, b) { return new Date(b.created_at) - new Date(a.created_at); })
      .slice(0, 5);

    return {
      success:        true,
      openTickets:    openTickets.length,
      pendingOrders:  pendingOrders.length,
      inTransit:      inTransit.length,
      unreadMessages: unreadMessages,
      recentTickets:  recentTickets.map(function(t) {
        return { ticket_number: t.ticket_number, subject: t.subject, priority: t.priority, status: t.status };
      }),
      recentOrders:   recentOrders.map(function(o) {
        return { order_number: o.order_number, status: o.status, country_code: o.country_code, total_amount: o.total_amount };
      }),
    };
  } catch(e) {
    Logger.log('getDashboardSummary: ' + e.message);
    return { success: false, error: e.message };
  }
}
