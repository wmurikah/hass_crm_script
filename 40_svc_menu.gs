/**
 * 40_svc_menu.gs  —  Hass CMS rebuild  (Stage 5G)
 *
 * Returns the navigation menu structure filtered by the caller's permissions.
 * No DB table — menu items are defined statically and filtered at runtime.
 *
 * menu.{list}
 */

var _MENU_ITEMS_ = [
  { id: 'dashboard',   label: 'Dashboard',      icon: 'home',         route: 'dashboard',   permission: 'order.view',     group: 'main' },
  { id: 'customers',   label: 'Customers',       icon: 'users',        route: 'customers',   permission: 'customer.view',  group: 'main' },
  { id: 'orders',      label: 'Orders',          icon: 'package',      route: 'orders',      permission: 'order.view',     group: 'main' },
  { id: 'tickets',     label: 'Tickets',         icon: 'headphones',   route: 'tickets',     permission: 'order.view',     group: 'main' },
  { id: 'invoices',    label: 'Invoices',        icon: 'file-text',    route: 'invoices',    permission: 'invoice.view',   group: 'finance' },
  { id: 'payments',    label: 'Payments',        icon: 'credit-card',  route: 'payments',    permission: 'invoice.view',   group: 'finance' },
  { id: 'approvals',   label: 'Approvals',       icon: 'check-circle', route: 'approvals',   permission: 'order.approve_low', group: 'ops' },
  { id: 'documents',   label: 'KYC Documents',   icon: 'file',         route: 'documents',   permission: 'customer.view',  group: 'ops' },
  { id: 'catalog',     label: 'Products',        icon: 'grid',         route: 'catalog',     permission: 'order.view',     group: 'catalog' },
  { id: 'pricing',     label: 'Price Lists',     icon: 'tag',          route: 'pricing',     permission: 'order.view',     group: 'catalog' },
  { id: 'knowledge',   label: 'Knowledge Base',  icon: 'book',         route: 'knowledge',   permission: 'order.view',     group: 'support' },
  { id: 'reports',     label: 'Reports',         icon: 'bar-chart-2',  route: 'reports',     permission: 'order.view',     group: 'reports' },
  { id: 'sla',         label: 'SLA Config',      icon: 'clock',        route: 'sla',         permission: 'order.manage',   group: 'ops'   },
  { id: 'audit',       label: 'Audit Log',       icon: 'shield',       route: 'audit',       permission: 'order.view',     group: 'admin' },
  { id: 'rbac',        label: 'Roles & Perms',   icon: 'lock',         route: 'rbac',        permission: 'order.manage',   group: 'admin' },
  { id: 'users',       label: 'Users',           icon: 'user',         route: 'users',       permission: 'order.manage',   group: 'admin' },
  { id: 'config',      label: 'System Config',   icon: 'settings',     route: 'config',      permission: 'order.manage',   group: 'admin' },
  { id: 'branding',    label: 'Branding',        icon: 'image',        route: 'branding',    permission: 'order.manage',   group: 'admin' },
];

// ── menu.list ─────────────────────────────────────────────────────────────────

function _menuList_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var items = _MENU_ITEMS_.filter(function (item) {
    if (!item.permission) return true;
    return Rbac.userHasPermission(ctx.session.userId, item.permission);
  });
  if (params.group) {
    items = items.filter(function (item) { return item.group === params.group; });
  }
  return items;
}

// ── Registration ───────────────────────────────────────────────────────────────

(function _registerMenu_() {
  register({ service: 'menu', action: 'list', permission: 'order.view', handler: _menuList_ });
})();
