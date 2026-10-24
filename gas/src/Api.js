/**
 * MPOS Cloud - 前端呼叫的 API（google.script.run 與 HTTP doPost 共用）
 * 所有 api* 函式回傳 {ok:true,...} 或 {ok:false,message}
 */

function wrap_(fn) {
  try {
    var r = fn();
    if (r && r.ok === undefined) r.ok = true;
    return r;
  } catch (e) {
    return { ok: false, message: String(e && e.message ? e.message : e) };
  }
}

function requirePin_(pin) {
  var saved = PropertiesService.getScriptProperties().getProperty('ADMIN_PIN') || '1234';
  if (String(pin || '') !== String(saved)) {
    Utilities.sleep(400);
    throw new Error('管理密碼錯誤。');
  }
}

function publicSettings_(settings) {
  var s = {};
  Object.keys(settings).forEach(function (k) { s[k] = settings[k]; });
  return s;
}

function webAppUrl_() {
  try { return ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; }
}

/* ---------------- POS ---------------- */

function apiBootstrap() {
  return wrap_(function () {
    var st = getStatic_();
    return {
      version: APP_VERSION,
      today: todayText_(),
      shop: { name: st.settings.shop_name, address: st.settings.shop_address, phone: st.settings.shop_phone },
      menu: st.menu.filter(function (m) { return Number(m.active) === 1; }),
      all_menu: st.menu,
      notes: st.notes.filter(function (n) { return Number(n.active) === 1; }),
      all_notes: st.notes,
      sources: st.sources.filter(function (n) { return Number(n.active) === 1; }),
      all_sources: st.sources,
      settings: publicSettings_(st.settings),
      layout: st.layout,
      default_layout: DEFAULT_RECEIPT_LAYOUT,
      web_app_url: webAppUrl_(),
    };
  });
}

function normalizeCartItems_(rawItems, menu) {
  if (!Array.isArray(rawItems) || !rawItems.length) throw new Error('尚未點選商品。');
  var map = {};
  menu.forEach(function (m) { if (Number(m.active) === 1) map[String(m.id)] = m; });
  var out = [];
  rawItems.forEach(function (raw) {
    var id = String(raw.id || '').trim();
    var qty = parseInt(raw.qty, 10) || 0;
    if (qty <= 0) return;
    var m = map[id];
    if (!m) throw new Error('商品不存在或已停用：' + id);
    var price = parseInt(m.price, 10) || 0;
    var note = String(raw.note || '').replace(/[\r\n]+/g, ' ').trim().substring(0, 200);
    out.push({ id: id, name: m.name, price: price, qty: qty, subtotal: price * qty, note: note });
  });
  if (!out.length) throw new Error('訂單數量不可為 0。');
  return out;
}

function apiPreview(payload) {
  return wrap_(function () {
    var st = getStatic_();
    var items = normalizeCartItems_((payload || {}).items, st.menu);
    var order = { order_no: '預覽', barcode_no: makeBarcodeNo(todayText_(), 1), created_at: nowText_(), items: items, note: (payload || {}).note || '' };
    var job = buildPrintJob(order, st.settings, st.layout);
    return { receipt: job.preview, total: job.total, job: job };
  });
}

/**
 * 建立訂單。payload: {items:[{id,qty}], note, print, cash_received, change_amount, payment_method}
 * 若 print=true 會回傳 print_job，由前端轉給 Android App 藍牙列印，成功後再呼叫 apiMarkPrinted。
 */
/**
 * 建立 / 更新訂單（結帳、掛單共用）
 * payload: {
 *   items:[{id,qty,note}], note, order_source, client_ref,
 *   print, cash_received, change_amount, payment_method,
 *   hold: true = 掛單（未付款，可之後用單號 / 條碼叫回結帳）
 *   order_id: 叫回的未付款訂單 id（更新該單，不另開新單號）
 *   customer_phone, customer_name: 來電客戶（名稱可空白，之後再補）
 * }
 * 若 print=true 會回傳 print_job，由前端轉給 Android App 藍牙列印，成功後再呼叫 apiMarkPrinted。
 */
function apiCreateOrder(payload) {
  return wrap_(function () {
    payload = payload || {};
    var st = getStatic_();
    var items = normalizeCartItems_(payload.items, st.menu);
    var total = items.reduce(function (s, i) { return s + i.subtotal; }, 0);
    var hold = payload.hold === true || payload.hold === 'true';
    var pay = hold ? { cash_received: 0, change_amount: 0, has_payment: false } : computePayment(total, payload.cash_received);
    var shouldPrint = payload.print !== false;
    if (!hold && shouldPrint && !pay.has_payment) throw new Error('請先按「結帳」，輸入收款金額並計算找零後，才能列印單據。');
    var source = normalizeOrderSource_(payload.order_source, st.sources);
    var clientRef = String(payload.client_ref || '').replace(/[^A-Za-z0-9_\-]/g, '').substring(0, 64);
    var phone = normalizePhone(payload.customer_phone);
    var cname = String(payload.customer_name || '').replace(/[\r\n]+/g, ' ').trim().substring(0, 30);
    var targetPay = hold ? 'unpaid' : 'paid';
    var editId = parseInt(payload.order_id, 10) || 0;

    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    var order, isUpdate = false;
    try {
      var orderDate = todayText_();
      var orders = readTable_('orders');
      // 本機暫存訂單重送（例如網路逾時後重試）：同一個 client_ref 只處理一次
      if (clientRef) {
        var dup = orders.filter(function (o) { return o.client_ref === clientRef; })[0];
        if (dup && (!editId || Number(dup.id) === editId) && (dup.pay_status || 'paid') === targetPay) {
          var existing = getOrderWithItems_(dup);
          var djob = buildPrintJob(existing, st.settings, st.layout);
          existing.receipt = djob.preview;
          return { order: existing, print_job: shouldPrint ? djob : null, duplicate: true, message: (hold ? '已暫存訂單' : '訂單已建立') + '（重送）' };
        }
      }
      var now = nowText_();
      var fields = {
        status: 'pending',
        total: total,
        note: String(payload.note || '').trim(),
        cash_received: pay.cash_received,
        change_amount: pay.change_amount,
        payment_method: hold ? '' : String(payload.payment_method || 'cash'),
        order_source: source,
        client_ref: clientRef,
        pay_status: targetPay,
        paid_at: hold ? '' : now,
        customer_name: cname,
        customer_phone: phone,
      };

      if (editId) {
        // 叫回未付款訂單：更新內容 / 結帳，單號不變
        var cur = orders.filter(function (o) { return Number(o.id) === editId; })[0];
        if (!cur) throw new Error('找不到要結帳的訂單。');
        if (cur.status === 'cancelled') throw new Error('此訂單已取消，不能結帳。');
        if ((cur.pay_status || 'paid') !== 'unpaid') throw new Error('此訂單已結帳（' + cur.order_no + '），不能重複結帳。');
        if (!cname) fields.customer_name = cur.customer_name || '';
        if (!phone) fields.customer_phone = cur.customer_phone || '';
        delete fields.status;
        updateFields_('orders', editId, fields);
        deleteWhere_('order_items', function (r) { return Number(r.order_id) === editId; });
        order = strip_(cur);
        Object.keys(fields).forEach(function (k) { order[k] = fields[k]; });
        isUpdate = true;
      } else {
        var maxNo = 0, maxId = 0;
        orders.forEach(function (o) {
          if (Number(o.id) > maxId) maxId = Number(o.id);
          if (o.order_date === orderDate && Number(o.daily_no) > maxNo) maxNo = Number(o.daily_no);
        });
        var dailyNo = maxNo + 1;
        order = {
          id: maxId + 1,
          order_date: orderDate,
          daily_no: dailyNo,
          order_no: makeOrderNo(orderDate, dailyNo),
          barcode_no: makeBarcodeNo(orderDate, dailyNo),
          created_at: now,
          printed_at: '',
          completed_at: '',
          cancelled_at: '',
        };
        Object.keys(fields).forEach(function (k) { order[k] = fields[k]; });
        appendRows_('orders', [order]);
      }
      var itemId = nextId_('order_items');
      appendRows_('order_items', items.map(function (it, i) {
        return { id: itemId + i, order_id: order.id, item_id: it.id, name: it.name, price: it.price, qty: it.qty, subtotal: it.subtotal, note: it.note || '' };
      }));
      if (order.customer_phone) touchCustomer_(order.customer_phone, cname, { last_order_at: now });
      SpreadsheetApp.flush();
    } finally {
      lock.releaseLock();
    }
    order.items = items;
    var job = buildPrintJob(order, st.settings, st.layout);
    order.receipt = job.preview;
    return {
      order: order,
      print_job: shouldPrint ? job : null,
      updated: isUpdate,
      message: hold ? '已暫存訂單（未付款）' : (isUpdate ? '訂單已結帳' : '訂單已建立'),
    };
  });
}

/** 用單號 / 條碼叫回訂單：未付款可帶回 POS 結帳，已付款只能檢視 / 補印 */
function apiLoadOrder(input) {
  return wrap_(function () {
    var r = apiLookup(input);
    if (!r.ok) throw new Error(r.message);
    var o = r.order;
    var editable = o.status !== 'cancelled' && (o.pay_status || 'paid') === 'unpaid';
    return { order: o, editable: editable };
  });
}

/** 暫存訂單（未付款、未取消）清單：最近 days 天，最新在前 */
function apiHeldOrders(days) {
  return wrap_(function () {
    var n = safeInt_(days, 7, 1, 60);
    var t = todayText_().split('-');
    var fromText = new Date(Date.UTC(+t[0], +t[1] - 1, +t[2]) - (n - 1) * 86400000).toISOString().substring(0, 10);
    var itemsAll = readTable_('order_items');
    var list = readTable_('orders').filter(function (o) {
      return String(o.pay_status || '') === 'unpaid' && o.status !== 'cancelled' && String(o.order_date) >= fromText;
    }).sort(function (a, b) { return b.id - a.id; }).slice(0, 50).map(function (o) {
      var x = strip_(o);
      x.items = itemsAll.filter(function (i) { return Number(i.order_id) === Number(o.id); }).map(strip_);
      return x;
    });
    return { orders: list };
  });
}

/* ---------------- 來電 / 客戶 ---------------- */

function findCustomer_(phone) {
  return readTable_('customers').filter(function (c) { return c.phone === phone; })[0] || null;
}

/** 新增 / 更新客戶（name 空白時不覆蓋原名稱） */
function touchCustomer_(phone, name, extra) {
  var c = findCustomer_(phone);
  var rec = c ? strip_(c) : { phone: phone, name: '', call_count: 0, last_call_at: '', last_order_at: '', created_at: nowText_() };
  if (name) rec.name = name;
  Object.keys(extra || {}).forEach(function (k) { rec[k] = extra[k]; });
  upsert_('customers', rec);
  return rec;
}

/** App 偵測到來電時呼叫：記錄來電並回傳客戶名稱 */
function apiRegisterCall(phoneInput) {
  return wrap_(function () {
    var phone = normalizePhone(phoneInput);
    if (!phone) throw new Error('來電號碼格式錯誤：' + phoneInput);
    var lock = LockService.getScriptLock();
    lock.waitLock(10000);
    var cust;
    try {
      var now = nowText_();
      var old = findCustomer_(phone);
      cust = touchCustomer_(phone, '', { call_count: (old ? Number(old.call_count) || 0 : 0) + 1, last_call_at: now });
      appendRows_('calls', [{ id: nextId_('calls'), phone: phone, called_at: now }]);
    } finally { lock.releaseLock(); }
    return { customer: decorateCustomer_(cust), known: !!(cust.name || Number(cust.call_count) > 1 || cust.last_order_at) };
  });
}

function decorateCustomer_(c) {
  var o = strip_(c);
  o.phone_display = formatPhone(o.phone);
  return o;
}

/** 今日來電清單（同號碼合併，最新在前） */
function apiRecentCalls() {
  return wrap_(function () {
    var today = todayText_();
    var custMap = {};
    readTable_('customers').forEach(function (c) { custMap[c.phone] = c; });
    var byPhone = {}, list = [], cancelCnt = {};
    readTable_('orders').forEach(function (o) { if (o.customer_phone && o.status === 'cancelled') cancelCnt[o.customer_phone] = (cancelCnt[o.customer_phone] || 0) + 1; });
    readTable_('calls').filter(function (c) { return String(c.called_at).indexOf(today) === 0; })
      .sort(function (a, b) { return b.id - a.id; })
      .forEach(function (c) {
        if (byPhone[c.phone]) { byPhone[c.phone].count_today++; return; }
        var cu = custMap[c.phone] || {};
        byPhone[c.phone] = { phone: c.phone, phone_display: formatPhone(c.phone), name: cu.name || '', called_at: c.called_at, count_today: 1, call_count: Number(cu.call_count) || 1,
          cancel_count: cancelCnt[c.phone] || 0 };
        list.push(byPhone[c.phone]);
      });
    return { calls: list.slice(0, 30) };
  });
}

/** 來電記錄（指定日期，每通一筆，最新在前；附客戶名稱與累計訂單數） */
function apiCallLog(date) {
  return wrap_(function () {
    var d = normalizeQueryDate_(date);
    var custMap = {}, orderCnt = {};
    readTable_('customers').forEach(function (c) { custMap[c.phone] = c; });
    var cancelCnt = {};
    readTable_('orders').forEach(function (o) {
      if (!o.customer_phone) return;
      if (o.status !== 'cancelled') orderCnt[o.customer_phone] = (orderCnt[o.customer_phone] || 0) + 1;
      else cancelCnt[o.customer_phone] = (cancelCnt[o.customer_phone] || 0) + 1;
    });
    var list = readTable_('calls').filter(function (c) { return String(c.called_at).indexOf(d) === 0; })
      .sort(function (a, b) { return b.id - a.id; })
      .map(function (c) {
        var cu = custMap[c.phone] || {};
        return { id: c.id, phone: c.phone, phone_display: formatPhone(c.phone), name: cu.name || '', called_at: c.called_at,
          call_count: Number(cu.call_count) || 1, order_count: orderCnt[c.phone] || 0, cancel_count: cancelCnt[c.phone] || 0 };
      });
    return { date: d, calls: list };
  });
}

/** 依電話查詢歷史交易品項 */
function apiCustomerHistory(phoneInput) {
  return wrap_(function () {
    var phone = normalizePhone(phoneInput);
    if (!phone) throw new Error('電話號碼格式錯誤。');
    var cust = findCustomer_(phone);
    var orders = readTable_('orders').filter(function (o) { return o.customer_phone === phone; })
      .sort(function (a, b) { return b.id - a.id; });
    var itemsAll = readTable_('order_items');
    var agg = {};
    var list = orders.slice(0, 20).map(function (o) {
      var x = strip_(o);
      x.items = itemsAll.filter(function (i) { return Number(i.order_id) === Number(o.id); }).map(strip_);
      return x;
    });
    orders.filter(function (o) { return o.status !== 'cancelled'; }).forEach(function (o) {
      itemsAll.filter(function (i) { return Number(i.order_id) === Number(o.id); }).forEach(function (i) {
        var a = agg[i.name] || (agg[i.name] = { name: i.name, item_id: i.item_id, qty: 0, times: 0 });
        a.qty += Number(i.qty) || 0; a.times += 1;
      });
    });
    var top = Object.keys(agg).map(function (k) { return agg[k]; }).sort(function (a, b) { return b.qty - a.qty; });
    return {
      customer: cust ? decorateCustomer_(cust) : { phone: phone, phone_display: formatPhone(phone), name: '', call_count: 0 },
      orders: list, order_count: orders.length, top_items: top,
      cancel: customerCancelInfo_(phone, orders),
    };
  });
}

/** 補 / 改客戶名稱 */
function apiSaveCustomer(phoneInput, name) {
  return wrap_(function () {
    var phone = normalizePhone(phoneInput);
    if (!phone) throw new Error('電話號碼格式錯誤。');
    var n = String(name || '').trim().substring(0, 30);
    var c = findCustomer_(phone);
    var rec = c ? strip_(c) : { phone: phone, name: '', call_count: 0, last_call_at: '', last_order_at: '', created_at: nowText_() };
    rec.name = n;
    upsert_('customers', rec);
    return { customer: decorateCustomer_(rec), message: '客戶名稱已儲存' };
  });
}

function normalizeOrderSource_(value, sources) {
  var v = String(value || '').trim();
  var active = (sources || []).filter(function (s) { return Number(s.active) === 1; });
  if (!v) throw new Error('請先選擇訂單來源。');
  if (!active.some(function (s) { return s.name === v; })) throw new Error('訂單來源不存在或已停用：' + v);
  return v;
}

function apiMarkPrinted(orderId) {
  return wrap_(function () {
    var ts = nowText_();
    if (!updateFields_('orders', orderId, { printed_at: ts })) throw new Error('找不到訂單。');
    return { printed_at: ts };
  });
}

function getOrderWithItems_(orderRow) {
  var o = strip_(orderRow);
  o.items = readTable_('order_items')
    .filter(function (i) { return Number(i.order_id) === Number(o.id); })
    .map(strip_);
  return o;
}

function normalizeQueryDate_(v) {
  var raw = String(v || '').trim().replace(/\//g, '-');
  if (!raw) return todayText_();
  var m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return raw.substring(0, 10);
  return m[1] + '-' + pad_(m[2], 2) + '-' + pad_(m[3], 2);
}

function apiOrders(date, status) {
  return wrap_(function () {
    var d = normalizeQueryDate_(date);
    status = String(status || '').trim();
    var all = readTable_('orders').filter(function (o) { return o.order_date === d; });
    var itemsAll = readTable_('order_items');
    var byOrder = {};
    itemsAll.forEach(function (i) { (byOrder[i.order_id] = byOrder[i.order_id] || []).push(strip_(i)); });

    var summary = { order_date: d, by_status: { pending: { cnt: 0, amount: 0 }, completed: { cnt: 0, amount: 0 }, cancelled: { cnt: 0, amount: 0 } }, items: [], by_source: [] };
    var srcAgg = {};
    var itemAgg = {};
    all.forEach(function (o) {
      var b = summary.by_status[o.status] || (summary.by_status[o.status] = { cnt: 0, amount: 0 });
      b.cnt += 1; b.amount += Number(o.total) || 0;
      if (o.status !== 'cancelled') {
        var sk = o.order_source || '未指定';
        var sa = srcAgg[sk] || (srcAgg[sk] = { name: sk, cnt: 0, amount: 0 });
        sa.cnt += 1; sa.amount += Number(o.total) || 0;
        (byOrder[o.id] || []).forEach(function (i) {
          var a = itemAgg[i.name] || (itemAgg[i.name] = { name: i.name, qty: 0, amount: 0 });
          a.qty += Number(i.qty) || 0; a.amount += Number(i.subtotal) || 0;
        });
      }
    });
    summary.by_source = Object.keys(srcAgg).map(function (k) { return srcAgg[k]; }).sort(function (a, b) { return b.amount - a.amount; });
    summary.items = Object.keys(itemAgg).map(function (k) { return itemAgg[k]; })
      .sort(function (a, b) { return b.qty - a.qty || b.amount - a.amount; });

    var orders = all.filter(function (o) { return !status || o.status === status; })
      .sort(function (a, b) { return b.daily_no - a.daily_no; })
      .map(function (o) { var x = strip_(o); x.items = byOrder[o.id] || []; return x; });
    return { version: APP_VERSION, orders: orders, summary: summary };
  });
}

function findOrderById_(id) {
  var rows = readTable_('orders');
  for (var i = 0; i < rows.length; i++) if (Number(rows[i].id) === Number(id)) return rows[i];
  return null;
}

function apiCompleteOrder(orderId) {
  return wrap_(function () {
    var o = findOrderById_(orderId);
    if (!o) throw new Error('找不到訂單。');
    if (o.status === 'cancelled') throw new Error('已取消的訂單不可完成。');
    updateFields_('orders', orderId, { status: 'completed', completed_at: nowText_() });
    return { message: '訂單已完成' };
  });
}

/**
 * 取消訂單（含註記）：input = {order_id, type: customer|store, reason, note, refund, print, pin}
 * 已完成 / 已付款的訂單也可取消；取消後保留原狀態（cancel_from）供分析。
 */
function apiCancelOrder(input) {
  return wrap_(function () {
    if (input === null || typeof input !== 'object') input = { order_id: input };
    var st = getStatic_();
    if (truthy_(st.settings.cancel_require_pin)) requirePin_(input.pin);
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      var o = findOrderById_(input.order_id);
      if (!o) throw new Error('找不到訂單。');
      if (o.status === 'cancelled') throw new Error('此訂單已經取消（' + (o.cancel_reason || '') + '）。');
      var c = normalizeCancelInput(input, o);
      var fields = { status: 'cancelled', cancelled_at: nowText_(), cancel_type: c.type, cancel_reason: c.reason,
        cancel_note: c.note, cancel_refund: c.refund, cancel_from: o.status };
      updateFields_('orders', o.id, fields);
    } finally { lock.releaseLock(); }
    var order = getOrderWithItems_(findOrderById_(input.order_id));
    return {
      message: '訂單 ' + order.order_no + ' 已取消（' + CANCEL_TYPES[order.cancel_type] + '：' + order.cancel_reason + '）' +
        (Number(order.cancel_refund) > 0 ? '，退款 ' + order.cancel_refund + ' 元' : ''),
      order: order,
      print_job: input.print ? buildCancelPrintJob(order, st.settings, st.layout) : null,
    };
  });
}

/** 退單分析：期間（from ~ to，含）內的訂單取消統計 */
function apiCancelStats(pin, from, to) {
  return wrap_(function () {
    requirePin_(pin);
    var t = normalizeQueryDate_(to || todayText_());
    var f = normalizeQueryDate_(from || t);
    if (f > t) { var x = f; f = t; t = x; }
    var custMap = {};
    readTable_('customers').forEach(function (c) { custMap[c.phone] = c; });
    var orders = readTable_('orders').filter(function (o) { return o.order_date >= f && o.order_date <= t; });
    var res = cancelStats(orders, custMap);
    res.from = f; res.to = t;
    res.recent = orders.filter(function (o) { return o.status === 'cancelled'; })
      .sort(function (a, b) { return String(b.cancelled_at).localeCompare(String(a.cancelled_at)); })
      .slice(0, 50).map(strip_);
    return res;
  });
}

/** 某客戶的訂單 / 取消筆數 */
function customerCancelInfo_(phone, orders) {
  var mine = (orders || readTable_('orders')).filter(function (o) { return o.customer_phone === phone; });
  var cancelled = mine.filter(function (o) { return o.status === 'cancelled'; }).length;
  return { order_total: mine.length, cancel_count: cancelled, cancel_rate: pct_(cancelled, mine.length) };
}

function apiReprintJob(orderId) {
  return wrap_(function () {
    var o = findOrderById_(orderId);
    if (!o) throw new Error('找不到訂單。');
    var st = getStatic_();
    var full = getOrderWithItems_(o);
    var job = buildPrintJob(full, st.settings, st.layout);
    return { order_no: full.order_no, barcode_no: full.barcode_no, total: job.total, print_job: job, receipt: job.preview };
  });
}

function apiTestPrintJob(barcodeOnly) {
  return wrap_(function () {
    var st = getStatic_();
    var today = todayText_();
    var order = {
      order_no: makeOrderNo(today, 1),
      barcode_no: makeBarcodeNo(today, 1),
      created_at: nowText_(),
      items: [{ name: '原味（無餡料）', price: 35, qty: 1 }, { name: '卡士達', price: 45, qty: 1 }],
      note: '測試列印／條碼內容為月日+三碼流水號',
      order_source: (st.sources[0] && st.sources[0].name) || '現場點餐',
      cash_received: 100, change_amount: 20, payment_method: 'cash',
    };
    var job = buildPrintJob(order, st.settings, st.layout);
    job.printer.open_cash_drawer = false;
    if (barcodeOnly === 'modes') {
      // 條碼相容性測試：三種方式各印一次，選印得出條碼（不是亂碼）的那一種
      var base = { font_pt: 8, bold: true, align: 'left', x_offset: 0, space_before: 0, space_after: 0 };
      var lbl = function (t) { return Object.assign({ role: 'item', text: t }, base); };
      var bc = function (m) { return { role: 'barcode', text: '', barcode_mode: m, font_pt: 8, bold: false, align: 'center', x_offset: 0, space_before: 0, space_after: 12 }; };
      job.lines = [lbl('條碼相容性測試 EAN13：' + job.ean13),
        lbl('方式 1：ESC * 點陣（建議）'), bc('escstar'),
        lbl('方式 2：GS v 0 點陣'), bc('raster'),
        lbl('方式 3：印表機內建條碼'), bc('gsk'),
        lbl('請到設定選擇印得正常的方式')];
      job.preview = job.lines.map(function (l) { return l.role === 'barcode' ? '‖‖‖ 條碼（' + l.barcode_mode + '）‖‖‖' : l.text; }).join('\n');
    } else if (barcodeOnly) {
      job.lines = job.lines.filter(function (l) { return l.role === 'barcode' || l.role === 'order_no'; });
      job.lines.push({ role: 'item', text: '條碼：' + order.barcode_no + '  EAN13：' + job.ean13, font_pt: 8, bold: false, align: 'left', x_offset: 0, space_before: 0, space_after: 0 });
    }
    return { print_job: job, receipt: job.preview, ean13: job.ean13 };
  });
}

function apiLookup(input) {
  return wrap_(function () {
    var raw = String(input || '').trim();
    if (!raw) throw new Error('請輸入流水號。');
    var st = getStatic_();
    var c = lookupCandidates(raw, st.settings);
    var rows = readTable_('orders');
    var hit = null;
    c.orderNos.some(function (no) { hit = rows.filter(function (r) { return r.order_no === no; })[0] || null; return !!hit; });
    if (!hit) {
      // 7 碼邏輯號只有月日，取最近一筆
      c.barcodeNos.some(function (bn) {
        var list = rows.filter(function (r) { return r.barcode_no === bn; }).sort(function (a, b) { return b.id - a.id; });
        hit = list[0] || null;
        return !!hit;
      });
    }
    if (!hit) throw new Error('查無此單據編號。');
    return { order: getOrderWithItems_(hit) };
  });
}

/* ---------------- 管理後台（需管理密碼） ---------------- */

function apiVerifyPin(pin) {
  return wrap_(function () { requirePin_(pin); return { message: '密碼正確' }; });
}

function apiChangePin(pin, newPin) {
  return wrap_(function () {
    requirePin_(pin);
    newPin = String(newPin || '').trim();
    if (!/^\d{4,8}$/.test(newPin)) throw new Error('新密碼需為 4~8 位數字。');
    PropertiesService.getScriptProperties().setProperty('ADMIN_PIN', newPin);
    return { message: '管理密碼已更新' };
  });
}

function apiSaveSettings(pin, input) {
  return wrap_(function () {
    requirePin_(pin);
    var clean = validateSettings(input || {});
    Object.keys(clean).forEach(function (k) { upsert_('settings', { key: k, value: clean[k] }); });
    invalidateCache_();
    return { settings: publicSettings_(getStatic_().settings), message: '設定已儲存' };
  });
}

function apiSaveLayout(pin, rows) {
  return wrap_(function () {
    requirePin_(pin);
    if (!Array.isArray(rows)) throw new Error('版型資料格式錯誤。');
    var clean = sanitizeReceiptLayout(rows);
    var ts = nowText_();
    replaceTable_('receipt_layout', clean.map(function (r) { r.updated_at = ts; return r; }));
    invalidateCache_();
    return { layout: sanitizeReceiptLayout(clean), message: '版型已儲存' };
  });
}

function apiSaveMenuItem(pin, p) {
  return wrap_(function () {
    requirePin_(pin);
    p = p || {};
    var item = {
      id: String(p.id || '').trim() || ('item_' + Utilities.formatDate(new Date(), TZ, 'yyyyMMddHHmmss') + Math.floor(Math.random() * 1000)),
      category: String(p.category || '').trim(),
      name: String(p.name || '').trim(),
      price: parseInt(p.price, 10),
      sort_order: parseInt(p.sort_order, 10) || 0,
      active: truthy_(p.active === undefined ? '1' : p.active) ? 1 : 0,
    };
    if (!item.category || !item.name) throw new Error('分類與品名不可空白。');
    if (isNaN(item.price) || item.price < 0) throw new Error('價格不可小於 0。');
    upsert_('menu_items', item);
    invalidateCache_();
    return { items: getStatic_().menu, message: '商品已儲存' };
  });
}

function apiDisableMenuItem(pin, id) {
  return wrap_(function () {
    requirePin_(pin);
    if (!updateFields_('menu_items', id, { active: 0 })) throw new Error('找不到商品。');
    invalidateCache_();
    return { items: getStatic_().menu, message: '商品已停用' };
  });
}

function apiSaveNote(pin, p) {
  return wrap_(function () {
    requirePin_(pin);
    p = p || {};
    var text = String(p.text || '').trim();
    if (!text) throw new Error('備註文字不可空白。');
    var note = {
      id: parseInt(p.id, 10) || nextId_('note_presets'),
      text: text,
      sort_order: parseInt(p.sort_order, 10) || 0,
      active: truthy_(p.active === undefined ? '1' : p.active) ? 1 : 0,
    };
    upsert_('note_presets', note);
    invalidateCache_();
    return { notes: getStatic_().notes, message: '備註已儲存' };
  });
}

function apiDisableNote(pin, id) {
  return wrap_(function () {
    requirePin_(pin);
    if (!updateFields_('note_presets', id, { active: 0 })) throw new Error('找不到備註。');
    invalidateCache_();
    return { notes: getStatic_().notes, message: '備註已停用' };
  });
}

function apiSaveSource(pin, p) {
  return wrap_(function () {
    requirePin_(pin);
    p = p || {};
    var name = String(p.name || '').trim();
    if (!name) throw new Error('訂單來源名稱不可空白。');
    if (name.length > 20) throw new Error('訂單來源名稱最多 20 字。');
    var id = parseInt(p.id, 10) || 0;
    var dup = readTable_('order_sources').filter(function (s) { return s.name === name && Number(s.id) !== id; })[0];
    if (dup) throw new Error('已有相同名稱的訂單來源。');
    var src = {
      id: id || nextId_('order_sources'),
      name: name,
      sort_order: parseInt(p.sort_order, 10) || 0,
      active: truthy_(p.active === undefined ? '1' : p.active) ? 1 : 0,
    };
    upsert_('order_sources', src);
    invalidateCache_();
    return { sources: getStatic_().sources, message: '訂單來源已儲存' };
  });
}

function apiDisableSource(pin, id) {
  return wrap_(function () {
    requirePin_(pin);
    if (!updateFields_('order_sources', id, { active: 0 })) throw new Error('找不到訂單來源。');
    invalidateCache_();
    return { sources: getStatic_().sources, message: '訂單來源已停用' };
  });
}

function apiDbInfo(pin) {
  return wrap_(function () {
    requirePin_(pin);
    var ss = getDb_();
    return { spreadsheet_url: ss.getUrl(), web_app_url: webAppUrl_(), version: APP_VERSION };
  });
}

/* ---------------- HTTP / 自動化測試 ---------------- */

/** 可經由 HTTP doPost 呼叫的函式白名單 */
var HTTP_API = {
  apiBootstrap: apiBootstrap, apiPreview: apiPreview, apiCreateOrder: apiCreateOrder, apiMarkPrinted: apiMarkPrinted,
  apiOrders: apiOrders, apiCompleteOrder: apiCompleteOrder, apiReprintJob: apiReprintJob,
  apiTestPrintJob: apiTestPrintJob, apiLookup: apiLookup, apiVerifyPin: apiVerifyPin, apiLoadOrder: apiLoadOrder,
};

function apiHealth() {
  return wrap_(function () {
    var configured = !!PropertiesService.getScriptProperties().getProperty(PROP_SPREADSHEET_ID);
    var checks = selfTest_();
    var st = configured ? getStatic_() : null;
    return {
      version: APP_VERSION,
      now: nowText_(),
      db_configured: configured,
      menu_count: st ? st.menu.length : 0,
      self_test: checks,
      ok: configured && checks.every(function (c) { return c.ok; }),
    };
  });
}

/** 部署後線上自我檢查（不寫入資料） */
function selfTest_() {
  var tests = [
    ['EAN13 檢查碼', function () { return ean13CheckDigit('200000704001') === '4'; }],
    ['條碼邏輯號', function () { return makeBarcodeNo('2026-07-04', 1) === '0704001'; }],
    ['完整單號', function () { return makeOrderNo('2026-07-04', 2) === '202607040002'; }],
    ['EAN13 還原', function () { return ean13ToBarcodeNo('2000007040014') === '0704001'; }],
    ['列印工作', function () {
      var job = buildPrintJob({ order_no: '202607040001', barcode_no: '0704001', created_at: '2026-07-04 10:00:00', items: [{ name: '卡士達', price: 45, qty: 2 }] }, DEFAULT_SETTINGS, DEFAULT_RECEIPT_LAYOUT);
      return job.total === 90 && job.ean13 === '2000007040014' && job.lines.length > 5;
    }],
  ];
  return tests.map(function (t) {
    try { return { name: t[0], ok: !!t[1]() }; } catch (e) { return { name: t[0], ok: false, error: String(e) }; }
  });
}
