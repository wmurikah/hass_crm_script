// ================================================================
// HASS PETROLEUM CMS — CustomerService.gs
// Helpers used by the Customer Portal.
// ================================================================

/**
 * Returns active delivery locations for a customer. Used by the
 * customer portal to populate the "Delivery Location" dropdown
 * on the new-order form.
 */
function getCustomerDeliveryLocations(customerId) {
  try {
    if (!customerId) return { success: false, error: 'customerId required' };
    var rows = getSheetData('DeliveryLocations') || [];
    var locations = rows
      .filter(function(l) {
        if (String(l.customer_id || '').trim() !== String(customerId).trim()) return false;
        var status = String(l.status || '').toUpperCase();
        return status === '' || status === 'ACTIVE';
      })
      .map(function(l) {
        return {
          location_id: l.location_id,
          name:        l.location_name || l.name || l.location_id,
          city:        l.city || '',
          address:     l.address || ''
        };
      });
    return { success: true, locations: locations };
  } catch (e) {
    Logger.log('getCustomerDeliveryLocations error: ' + e.message);
    return { success: false, error: e.message };
  }
}
