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

/**
 * Returns consumption analytics for a customer over a period.
 * Called by handleCustomerRequest action:'getConsumption'
 * @param {string} customerId
 * @param {string|Object} period - 'month','quarter','year','ytm' or {from:'YYYY-MM',to:'YYYY-MM'}
 * @returns {Object} { success, kpis, byProduct, monthlyTrend, byLocation, deliveryPerformance }
 */
function getCustomerConsumption(customerId, period) {
  try {
    var allOrders = getSheetData('Orders') || [];
    var orders = allOrders.filter(function(o) {
      return String(o.customer_id||'').trim() === String(customerId).trim() &&
             ['DELIVERED','COMPLETED'].includes(String(o.status||'').toUpperCase());
    });

    // Date range
    var now = new Date();
    var fromDate, toDate = now;
    if (typeof period === 'object' && period.from) {
      fromDate = new Date(period.from + '-01');
      toDate = new Date(period.to + '-01');
      toDate.setMonth(toDate.getMonth() + 1);
    } else {
      switch(period) {
        case 'month': fromDate = new Date(now.getFullYear(), now.getMonth(), 1); break;
        case 'quarter': fromDate = new Date(now.getFullYear(), Math.floor(now.getMonth()/3)*3, 1); break;
        case 'ytm': fromDate = new Date(now.getFullYear(), 0, 1); toDate = new Date(now.getFullYear(), now.getMonth()+1, 0); break;
        default: fromDate = new Date(now.getFullYear(), 0, 1); // year
      }
    }

    // Filter to period
    var filtered = orders.filter(function(o) {
      var d = new Date(o.created_at || o.requested_date || '');
      return d >= fromDate && d < toDate;
    });

    // Load order lines
    var allLines = getSheetData('OrderLines') || [];
    var orderIds = filtered.map(function(o){ return o.order_id; });
    var lines = allLines.filter(function(l){ return orderIds.indexOf(l.order_id) > -1; });

    // Product name map
    var productMap = {};
    var products = getSheetData('Products') || [];
    products.forEach(function(p){ productMap[p.product_id] = p.product_name || p.product_code || p.product_id; });

    // KPIs
    var totalVolume = 0, totalSpend = 0;
    lines.forEach(function(l){ totalVolume += parseFloat(l.quantity||0); totalSpend += parseFloat(l.total_amount || (l.quantity * l.unit_price) || 0); });
    var orderCount = filtered.length;
    var avgOrderSize = orderCount > 0 ? Math.round(totalVolume / orderCount) : 0;

    // byProduct
    var productBuckets = {};
    lines.forEach(function(l) {
      var pid = l.product_id || 'OTHER';
      var pname = productMap[pid] || pid;
      if (!productBuckets[pname]) productBuckets[pname] = { product: pname, volume: 0, spend: 0 };
      productBuckets[pname].volume += parseFloat(l.quantity||0);
      productBuckets[pname].spend += parseFloat(l.total_amount || (l.quantity * l.unit_price) || 0);
    });
    var byProduct = Object.values(productBuckets).sort(function(a,b){ return b.volume - a.volume; });

    // monthlyTrend
    var monthBuckets = {};
    filtered.forEach(function(o) {
      var d = new Date(o.created_at || o.requested_date || '');
      var ym = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
      if (!monthBuckets[ym]) monthBuckets[ym] = { month: ym, agoVol: 0, pmsVol: 0, keroVol: 0, otherVol: 0, spend: 0 };
      var oLines = allLines.filter(function(l){ return l.order_id === o.order_id; });
      oLines.forEach(function(l) {
        var pname = (productMap[l.product_id]||'').toUpperCase();
        var vol = parseFloat(l.quantity||0);
        var spd = parseFloat(l.total_amount || (l.quantity * l.unit_price) || 0);
        if (pname.includes('AGO') || pname.includes('DIESEL')) monthBuckets[ym].agoVol += vol;
        else if (pname.includes('PMS') || pname.includes('PETROL')) monthBuckets[ym].pmsVol += vol;
        else if (pname.includes('KERO')) monthBuckets[ym].keroVol += vol;
        else monthBuckets[ym].otherVol += vol;
        monthBuckets[ym].spend += spd;
      });
    });
    var monthlyTrend = Object.values(monthBuckets).sort(function(a,b){ return a.month.localeCompare(b.month); });

    // byLocation
    var locBuckets = {};
    filtered.forEach(function(o) {
      var loc = o.delivery_location_id || 'Unknown';
      if (!locBuckets[loc]) locBuckets[loc] = { locationName: loc, orders: 0, volume: 0, spend: 0, lastOrder: null };
      locBuckets[loc].orders++;
      var oLines = allLines.filter(function(l){ return l.order_id === o.order_id; });
      oLines.forEach(function(l){ locBuckets[loc].volume += parseFloat(l.quantity||0); locBuckets[loc].spend += parseFloat(l.total_amount||(l.quantity*l.unit_price)||0); });
      var d = new Date(o.created_at||'');
      if (!locBuckets[loc].lastOrder || d > new Date(locBuckets[loc].lastOrder)) locBuckets[loc].lastOrder = o.created_at;
    });
    var byLocation = Object.values(locBuckets);

    // deliveryPerformance — simplified for normal users: bucket into On Time / Slight Delay / Late
    var onTime = 0, slightDelay = 0, late = 0;
    filtered.forEach(function(o) {
      var ordered = new Date(o.created_at || o.requested_date || '');
      var delivered = new Date(o.delivered_at || o.actual_delivery_date || '');
      if (!ordered || !delivered || isNaN(delivered)) return;
      var hrs = (delivered - ordered) / 3600000;
      if (hrs <= 24) onTime++;
      else if (hrs <= 48) slightDelay++;
      else late++;
    });
    var deliveryPerformance = { onTime: onTime, slightDelay: slightDelay, late: late, total: onTime + slightDelay + late };

    return {
      success: true,
      kpis: { totalVolume: Math.round(totalVolume), totalSpend: Math.round(totalSpend), orderCount: orderCount, avgOrderSize: avgOrderSize, vsLastPeriod: {} },
      byProduct: byProduct,
      monthlyTrend: monthlyTrend,
      byLocation: byLocation,
      deliveryPerformance: deliveryPerformance
    };
  } catch (e) {
    Logger.log('getCustomerConsumption error: ' + e.message);
    return { success: false, error: e.message };
  }
}

/**
 * Returns the active price list applicable to the given customer.
 * Called by handleCustomerRequest action:'getPriceList'
 */
function getCustomerPriceList(customerId) {
  try {
    var customer = getById('Customers', customerId);
    var countryCode = customer ? (customer.country_code || 'KE') : 'KE';
    // Find active price list for customer country
    var priceLists = getSheetData('PriceLists') || [];
    var now = new Date();
    var activePL = priceLists.find(function(pl){
      return String(pl.country_code||'').toUpperCase() === countryCode.toUpperCase() &&
             String(pl.status||'').toUpperCase() === 'ACTIVE' &&
             new Date(pl.effective_from||'2020-01-01') <= now;
    });
    var priceListId = activePL ? activePL.price_list_id : null;
    var allItems = getSheetData('PriceListItems') || [];
    var items = priceListId
      ? allItems.filter(function(i){ return i.price_list_id === priceListId; })
      : allItems; // fallback: return all
    // Load product names
    var products = getSheetData('Products') || [];
    var productMap = {};
    products.forEach(function(p){ productMap[p.product_id] = p.product_name || p.product_code || p.product_id; });
    var enriched = items.map(function(i){
      return {
        item_id: i.item_id,
        product_id: i.product_id,
        product_name: productMap[i.product_id] || i.product_id,
        unit_price: parseFloat(i.unit_price||0),
        min_quantity: i.min_quantity,
        max_quantity: i.max_quantity,
        currency_code: activePL ? activePL.currency_code : 'KES'
      };
    });
    return { success: true, items: enriched };
  } catch(e) {
    Logger.log('getCustomerPriceList error: ' + e.message);
    return { success: false, error: e.message, items: [] };
  }
}
