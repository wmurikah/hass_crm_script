// ================================================================
// HASS PETROLEUM CMS — CustomerService.gs
// Backend for the Customer Portal consumption page.
//
// Add this file to your Apps Script project.
// No other changes needed — the frontend already calls
// handleConsumptionRequest() via google.script.run.
// ================================================================

function handleConsumptionRequest(params) {
  try {
    switch (params.action) {
      case 'getConsumptionData':
        return getConsumptionData(
          params.customerId,
          params.startDate,
          params.endDate
        );
      default:
        return { success: false, error: 'Unknown action: ' + params.action };
    }
  } catch(e) {
    Logger.log('handleConsumptionRequest error: ' + e.message + '\n' + e.stack);
    return { success: false, error: e.message };
  }
}

function getConsumptionData(customerId, startDate, endDate) {
  if (!customerId) return { success: false, error: 'No customer ID provided.' };

  var ss = getSpreadsheet();

  // ── LOAD SHEETS ──────────────────────────────────────────
  var oSheet = ss.getSheetByName('Orders');
  var lSheet = ss.getSheetByName('OrderLines');
  if (!oSheet) return { success: false, error: 'Orders sheet not found.' };
  if (!lSheet) return { success: false, error: 'OrderLines sheet not found.' };

  var oData = oSheet.getDataRange().getValues();
  var lData = lSheet.getDataRange().getValues();

  // ── MAP HEADERS ──────────────────────────────────────────
  var oH = oData[0].map(function(x){ return String(x||'').toLowerCase().trim(); });
  var lH = lData[0].map(function(x){ return String(x||'').toLowerCase().trim(); });

  var oidC  = 0;                            // order_id  col 1
  var ocidC = oH.indexOf('customer_id');    // col 4
  var ostC  = oH.indexOf('status');         // col 14
  var ototC = oH.indexOf('total_amount');   // col 20
  var ocurC = oH.indexOf('currency_code');  // col 21
  var osubC = oH.indexOf('submitted_at');   // col 30
  var odelC = oH.indexOf('delivered_at');   // col 35
  var ocreC = oH.indexOf('created_at');     // col 43
  var occC  = oH.indexOf('country_code');   // col 42

  var loidC = lH.indexOf('order_id');       // col 2 (index 1)
  var lpidC = lH.indexOf('product_id');
  var lpnC  = lH.indexOf('product_name');
  var lqtyC = lH.indexOf('quantity');
  var lupC  = lH.indexOf('unit_price');

  // ── DATE RANGE ───────────────────────────────────────────
  var start = startDate ? new Date(startDate) : new Date('2025-01-01T00:00:00.000Z');
  var end   = endDate   ? new Date(endDate)   : new Date();

  // ── FILTER ORDERS FOR THIS CUSTOMER ──────────────────────
  var custOrders = [];
  var orderIdSet = {};

  for (var r = 1; r < oData.length; r++) {
    var cid = String(oData[r][ocidC]||'').trim();
    if (cid !== String(customerId).trim()) continue;

    // Only DELIVERED orders count for consumption
    var status = String(oData[r][ostC]||'').toUpperCase();
    if (status !== 'DELIVERED') continue;

    // Date range filter
    var creRaw = oData[r][ocreC];
    var creDate = creRaw ? new Date(creRaw) : null;
    if (!creDate || isNaN(creDate)) continue;
    if (creDate < start || creDate > end) continue;

    var oid = String(oData[r][oidC]||'').trim();
    orderIdSet[oid] = r;
    custOrders.push({
      order_id:     oid,
      total_amount: parseFloat(oData[r][ototC]||0),
      currency:     String(oData[r][ocurC]||'KES'),
      created_at:   creRaw,
      submitted_at: oData[r][osubC],
      delivered_at: oData[r][odelC],
      country_code: String(oData[r][occC]||'')
    });
  }

  // ── AGGREGATE ────────────────────────────────────────────
  var totalSpend   = 0;
  var totalVolume  = 0;
  var currency     = 'KES';
  var monthlyMap   = {};
  var productMap   = {};
  var deliveryHrs  = [];
  var deliveryDots = [];

  // Total spend from orders
  custOrders.forEach(function(o) {
    totalSpend += o.total_amount;
    currency    = o.currency || currency;

    // Monthly bucket: YYYY-MM
    var m = String(o.created_at).substring(0, 7);
    if (!monthlyMap[m]) monthlyMap[m] = { volume: 0, spend: 0, orders: 0 };
    monthlyMap[m].spend  += o.total_amount;
    monthlyMap[m].orders += 1;

    // Delivery time
    if (o.submitted_at && o.delivered_at) {
      var hrs = (new Date(o.delivered_at) - new Date(o.submitted_at)) / 3600000;
      if (!isNaN(hrs) && hrs > 0 && hrs < 500) {
        deliveryHrs.push(hrs);
        deliveryDots.push({
          orderDate: o.created_at,
          hrs: Math.round(hrs * 10) / 10,
          status: hrs <= 24 ? 'ON_TIME' : hrs <= 48 ? 'SLIGHT' : 'DELAYED'
        });
      }
    }
  });

  // Volume from order lines
  for (var r = 1; r < lData.length; r++) {
    var oid = String(lData[r][loidC]||'').trim();
    if (!orderIdSet.hasOwnProperty(oid)) continue;

    var qty  = parseFloat(lData[r][lqtyC]||0);
    var prod = String(lData[r][lpnC]||lData[r][lpidC]||'Other').trim();

    totalVolume += qty;

    // Monthly volume
    var orderRow = orderIdSet[oid];
    var m = String(oData[orderRow][ocreC]||'').substring(0, 7);
    if (monthlyMap[m]) monthlyMap[m].volume += qty;

    // Product breakdown
    if (!productMap[prod]) productMap[prod] = 0;
    productMap[prod] += qty;
  }

  // ── BUILD OUTPUT ARRAYS ──────────────────────────────────
  var monthly = Object.keys(monthlyMap).sort().map(function(m) {
    var label = m;
    try {
      var d = new Date(m + '-01');
      label = d.toLocaleString('default', { month: 'short' }) + ' ' + d.getFullYear().toString().slice(2);
    } catch(e) {}
    return {
      month:   label,
      monthKey: m,
      volume:  Math.round(monthlyMap[m].volume),
      spend:   Math.round(monthlyMap[m].spend),
      orders:  monthlyMap[m].orders
    };
  });

  var products = Object.keys(productMap)
    .map(function(p) { return { name: p, volume: Math.round(productMap[p]) }; })
    .sort(function(a, b) { return b.volume - a.volume; });

  var avgDelivery = deliveryHrs.length > 0
    ? Math.round(deliveryHrs.reduce(function(s,v){return s+v;},0) / deliveryHrs.length * 10) / 10
    : 0;

  return {
    success:        true,
    customerId:     customerId,
    currency:       currency,
    ordersPlaced:   custOrders.length,
    totalVolume:    Math.round(totalVolume),
    totalSpend:     Math.round(totalSpend),
    avgOrderSize:   custOrders.length > 0 ? Math.round(totalVolume / custOrders.length) : 0,
    avgDeliveryHrs: avgDelivery,
    monthly:        monthly,
    products:       products,
    deliveryDots:   deliveryDots
  };
}
