/**
 * MPOS Cloud - 純邏輯函式（不碰 Sheets，可在 Node 單元測試）
 * 由原 WebPOS.py 的單號 / EAN13 / 單據版型邏輯移植。
 */

function digitsOnly_(v) {
  return String(v === null || v === undefined ? '' : v).replace(/\D/g, '');
}

function pad_(n, len) {
  var s = String(n);
  while (s.length < len) s = '0' + s;
  return s;
}

function safeInt_(value, def, min, max) {
  var n = parseInt(value, 10);
  if (isNaN(n)) n = def;
  return Math.max(min, Math.min(max, n));
}

function truthy_(v) {
  return ['1', 'true', 'on', 'yes'].indexOf(String(v).toLowerCase()) >= 0;
}

/** 訂單文字單號：YYYYMMDD + 四位流水號，例如 202607040002 */
function makeOrderNo(orderDate, dailyNo) {
  dailyNo = parseInt(dailyNo, 10);
  if (!(dailyNo >= 1 && dailyNo <= 999)) throw new Error('條碼流水號採『月日+999』格式，單日最多 999 張。');
  return String(orderDate).replace(/-/g, '') + pad_(dailyNo, 4);
}

/** 條碼邏輯號：MMDD + 三碼流水號，例如 0704001 */
function makeBarcodeNo(orderDate, dailyNo) {
  dailyNo = parseInt(dailyNo, 10);
  if (!(dailyNo >= 1 && dailyNo <= 999)) throw new Error('條碼流水號採『月日+999』格式，單日最多 999 張。');
  var d = digitsOnly_(orderDate);
  var mmdd;
  if (d.length >= 8) mmdd = d.substring(4, 8);
  else if (d.length === 4) mmdd = d;
  else throw new Error('訂單日期格式錯誤：' + orderDate);
  return mmdd + pad_(dailyNo, 3);
}

function ean13CheckDigit(ean12) {
  var d = digitsOnly_(ean12);
  if (d.length !== 12) throw new Error('EAN13 前 12 碼資料必須是 12 位數字。');
  var odd = 0, even = 0;
  for (var i = 0; i < 12; i++) {
    if (i % 2 === 0) odd += Number(d.charAt(i)); else even += Number(d.charAt(i));
  }
  return String((10 - ((odd + even * 3) % 10)) % 10);
}

function normalizeEan13Prefix(settings) {
  var p = digitsOnly_((settings && settings.ean13_prefix) || DEFAULT_SETTINGS.ean13_prefix);
  return p.length === 5 ? p : '20000';
}

/** 由完整單號推算 7 碼邏輯號 */
function barcodeNoFromOrderNo(orderNo) {
  var d = digitsOnly_(orderNo);
  if (d.length >= 12 && d.indexOf('20000') !== 0) {
    return makeBarcodeNo(d.substring(0, 8), parseInt(d.substring(8, 12), 10));
  }
  return d;
}

/** 本系統 EAN13 → 7 碼邏輯號；不是本系統條碼則回傳空字串 */
function ean13ToBarcodeNo(code, settings) {
  var d = digitsOnly_(code);
  var prefix = normalizeEan13Prefix(settings);
  if ((d.length === 13 || d.length === 12) && d.indexOf(prefix) === 0) return d.substring(5, 12);
  return '';
}

/** 7 碼邏輯號（或完整單號）→ 完整 13 碼 EAN13 */
function barcodeNoToEan13(barcodeNo, settings) {
  var b = digitsOnly_(barcodeNo);
  if (b.length >= 12) {
    var mapped = ean13ToBarcodeNo(b, settings);
    b = mapped || barcodeNoFromOrderNo(b);
  }
  if (b.length !== 7) throw new Error('條碼邏輯號必須是 7 碼（月日 + 三碼流水號）：' + barcodeNo);
  var body = normalizeEan13Prefix(settings) + b;
  return body + ean13CheckDigit(body);
}

/**
 * 掃描 / 輸入值正規化，回傳查詢候選：{orderNos:[], barcodeNos:[]}
 * 支援 EAN13、EAN13 前 12 碼、7 碼邏輯號、12 碼完整單號、Code39 的 *。
 */
function lookupCandidates(input, settings) {
  var raw = String(input || '').trim().replace(/\*/g, '');
  var d = digitsOnly_(raw);
  var res = { orderNos: [], barcodeNos: [] };
  var mapped = ean13ToBarcodeNo(d, settings);
  if (mapped) {
    res.barcodeNos.push(mapped);
  } else if (d.length >= 12) {
    res.orderNos.push(d.substring(0, 12));
    try { res.barcodeNos.push(barcodeNoFromOrderNo(d.substring(0, 12))); } catch (e) { /* ignore */ }
  } else if (d.length === 7) {
    res.barcodeNos.push(d);
  }
  if (raw && res.orderNos.indexOf(raw) < 0) res.orderNos.push(raw);
  return res;
}

/** EAN13 模組位元字串（含左右靜區各 11），長度 117，前端預覽與測試使用 */
function ean13Bits(ean13) {
  var L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
  var G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
  var R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
  var P = ['OOOOOO', 'OOEOEE', 'OOEEOE', 'OOEEEO', 'OEOOEE', 'OEEOOE', 'OEEEOO', 'OEOEOE', 'OEOEEO', 'OEEOEO'];
  var s = String(ean13);
  if (!/^\d{13}$/.test(s)) throw new Error('EAN13 必須是 13 位數字');
  var parity = P[Number(s.charAt(0))];
  var bits = '00000000000' + '101';
  for (var i = 1; i <= 6; i++) bits += (parity.charAt(i - 1) === 'O' ? L : G)[Number(s.charAt(i))];
  bits += '01010';
  for (var j = 7; j <= 12; j++) bits += R[Number(s.charAt(j))];
  bits += '101' + '00000000000';
  return bits;
}

/* ---------------- 單據版型 ---------------- */

function sanitizeReceiptLayout(rows) {
  var byRole = {};
  (Array.isArray(rows) ? rows : []).forEach(function (x) {
    if (x && typeof x === 'object' && String(x.role || '').trim()) byRole[String(x.role).trim()] = x;
  });
  var result = DEFAULT_RECEIPT_LAYOUT.map(function (def, idx) {
    var src = byRole[def.role] || {};
    var r = {};
    Object.keys(def).forEach(function (k) { r[k] = (src[k] !== undefined && src[k] !== '' && src[k] !== null) ? src[k] : def[k]; });
    r.role = def.role;
    r.title = String(r.title || def.title).trim();
    r.sort_order = safeInt_(src.sort_order, idx * 10, 0, 9999);
    r.show = truthy_(r.show) ? 1 : 0;
    r.font_pt = safeInt_(r.font_pt, def.font_pt, 6, 24);
    var w = safeInt_(r.weight, def.weight, 300, 900);
    r.weight = [300, 400, 700, 900].reduce(function (best, c) { return Math.abs(c - w) < Math.abs(best - w) ? c : best; }, 400);
    r.align = ['left', 'center', 'right'].indexOf(String(r.align)) >= 0 ? String(r.align) : def.align;
    r.x_offset = safeInt_(r.x_offset, def.x_offset, -300, 300);
    r.space_before = safeInt_(r.space_before, def.space_before, 0, 80);
    r.space_after = safeInt_(r.space_after, def.space_after, 0, 80);
    return r;
  });
  result.sort(function (a, b) { return a.sort_order - b.sort_order; });
  return result;
}

function receiptWidthChars(settings) {
  return String((settings && settings.paper_width_mm) || '58') === '80' ? 48 : 32;
}

function repeatChar_(ch, n) {
  var s = '';
  for (var i = 0; i < n; i++) s += ch;
  return s;
}

function padLeft_(v, n) {
  var s = String(v);
  while (s.length < n) s = ' ' + s;
  return s;
}

/**
 * 產生單據行（每行帶 role）。
 * order: {order_no, barcode_no, created_at, items:[{name,price,qty}], note, cash_received, change_amount, payment_method}
 * 回傳 {lines:[{role,text}], total}
 */
function buildReceiptLines(order, settings) {
  settings = settings || DEFAULT_SETTINGS;
  var W = receiptWidthChars(settings);
  var eq = repeatChar_('=', W), dash = repeatChar_('-', W);
  var lines = [];
  var add = function (role, text) { lines.push({ role: role, text: String(text) }); };
  var total = 0;

  add('barcode', '__BARCODE_EAN13__');
  add('shop_name', settings.shop_name || DEFAULT_SHOP.shop_name);
  add('separator', eq);
  add('order_no', '單號：' + order.order_no);
  add('time', '時間：' + (order.created_at || ''));
  add('separator', dash);

  (order.items || []).forEach(function (it) {
    var qty = parseInt(it.qty, 10) || 0, price = parseInt(it.price, 10) || 0, sub = qty * price;
    total += sub;
    add('item', it.name);
    add('item_header', '數量  單價  小計');
    add('separator', dash);
    add('item', padLeft_(qty, 2) + '   ' + padLeft_(price, 4) + '  ' + padLeft_(sub, 5));
    add('separator', dash);
  });

  add('total', '合計：' + total + ' 元');
  add('separator', dash);

  if (order.cash_received !== null && order.cash_received !== undefined && order.cash_received !== '' && Number(order.cash_received) > 0) {
    var pm = String(order.payment_method || 'cash');
    add('payment', pm === 'cash' ? '付款方式：現金' : '付款方式：' + pm);
    add('payment', '收款：' + parseInt(order.cash_received, 10) + ' 元');
    add('payment', '找零：' + (parseInt(order.change_amount, 10) || 0) + ' 元');
    add('separator', dash);
  }

  var note = String(order.note || '').trim();
  if (note) {
    add('note', '備註：');
    note.split(/\r?\n/).forEach(function (l) { l = l.trim(); if (l) add('note', l); });
    add('separator', dash);
  }

  add('footer_msg', settings.footer_msg || DEFAULT_SETTINGS.footer_msg);
  add('address', settings.shop_address || DEFAULT_SHOP.shop_address);
  add('phone', '電話：' + (settings.shop_phone || DEFAULT_SHOP.shop_phone));
  add('separator', eq);
  return { lines: lines, total: total };
}

/** 給畫面預覽用的純文字 */
function receiptPreviewText(lines) {
  return lines.map(function (l) { return l.role === 'barcode' ? '‖‖‖ EAN13單號條碼 ‖‖‖' : l.text; }).join('\n');
}

/**
 * 產生送給 Android App 的列印工作（JSON），由 App 轉為 ESC/POS 位元組。
 */
function buildPrintJob(order, settings, layoutRows) {
  settings = settings || DEFAULT_SETTINGS;
  var layout = sanitizeReceiptLayout(layoutRows);
  var styleMap = {};
  layout.forEach(function (r) { styleMap[r.role] = r; });
  var built = buildReceiptLines(order, settings);
  var alwaysBarcode = truthy_(settings.always_print_barcode === undefined ? '1' : settings.always_print_barcode);
  var ean13 = '';
  var barcodeSrc = order.barcode_no || order.order_no;
  try { ean13 = barcodeNoToEan13(barcodeSrc, settings); } catch (e) { ean13 = ''; }

  var lines = [];
  built.lines.forEach(function (l) {
    var st = styleMap[l.role] || styleMap.item;
    var show = st.show === 1 || (l.role === 'barcode' && alwaysBarcode);
    if (!show) return;
    if (l.role === 'barcode' && !ean13) return;
    lines.push({
      role: l.role,
      text: l.role === 'barcode' ? '' : l.text,
      font_pt: st.font_pt,
      bold: st.weight >= 700,
      align: st.align,
      x_offset: st.x_offset,
      space_before: st.space_before,
      space_after: st.space_after,
    });
  });

  return {
    type: 'escpos_receipt',
    version: 1,
    order_no: order.order_no,
    barcode_no: order.barcode_no || '',
    ean13: ean13,
    total: built.total,
    printer: {
      paper_width_mm: parseInt(settings.paper_width_mm, 10) === 80 ? 80 : 58,
      encoding: String(settings.encoding || 'big5'),
      darkness: String(settings.print_darkness || 'normal'),
      line_spacing_percent: safeInt_(settings.line_spacing_percent, 100, 70, 160),
      margin_left_mm: parseFloat(settings.print_margin_left_mm) || 0,
      margin_top_mm: parseFloat(settings.print_margin_top_mm) || 0,
      start_x_mm: parseFloat(settings.print_start_x_mm) || 0,
      start_y_mm: parseFloat(settings.print_start_y_mm) || 0,
      barcode_max_width_percent: safeInt_(settings.barcode_max_width_percent, 88, 50, 100),
      open_cash_drawer: truthy_(settings.open_cash_drawer),
      cut_paper: truthy_(settings.cut_paper === undefined ? '1' : settings.cut_paper),
      feed_lines_after: safeInt_(settings.feed_lines_after, 3, 0, 10),
    },
    lines: lines,
    preview: receiptPreviewText(built.lines),
  };
}

/* ---------------- 設定驗證 ---------------- */

function validateSettings(input) {
  var clean = {};
  EDITABLE_SETTING_KEYS.forEach(function (k) {
    if (input && input[k] !== undefined && input[k] !== null) clean[k] = String(input[k]).trim();
  });
  if (clean.print_mode !== undefined && ['bluetooth', 'browser', 'none'].indexOf(clean.print_mode) < 0) throw new Error('列印模式必須是 bluetooth、browser 或 none。');
  if (clean.paper_width_mm !== undefined && ['58', '80'].indexOf(clean.paper_width_mm) < 0) throw new Error('紙寬只支援 58 或 80 mm。');
  if (clean.encoding !== undefined && ['big5', 'cp950', 'gbk', 'gb18030', 'utf-8'].indexOf(clean.encoding.toLowerCase()) < 0) throw new Error('中文編碼不支援：' + clean.encoding);
  if (clean.print_darkness !== undefined && ['light', 'normal', 'dark', 'extra_dark'].indexOf(clean.print_darkness) < 0) throw new Error('列印濃度錯誤。');
  if (clean.line_spacing_percent !== undefined) {
    var ls = parseInt(clean.line_spacing_percent, 10);
    if (isNaN(ls) || ls < 70 || ls > 160) throw new Error('行距比例建議設定在 70 到 160 之間。');
    clean.line_spacing_percent = String(ls);
  }
  ['print_margin_left_mm', 'print_margin_top_mm', 'print_start_x_mm', 'print_start_y_mm'].forEach(function (k) {
    if (clean[k] === undefined) return;
    var v = parseFloat(clean[k] || '0');
    if (isNaN(v) || v < 0 || v > 30) throw new Error(k + ' 建議設定在 0 到 30 mm 之間。');
    clean[k] = v.toFixed(2);
  });
  if (clean.barcode_max_width_percent !== undefined) {
    var bw = parseInt(clean.barcode_max_width_percent, 10);
    if (isNaN(bw) || bw < 50 || bw > 100) throw new Error('條碼最大寬度比例建議設定在 50 到 100 之間。');
    clean.barcode_max_width_percent = String(bw);
  }
  if (clean.ean13_prefix !== undefined) {
    var p = digitsOnly_(clean.ean13_prefix);
    if (p.length !== 5) throw new Error('EAN13 前綴必須是 5 碼數字，例如 20000。');
    clean.ean13_prefix = p;
  }
  if (clean.feed_lines_after !== undefined) clean.feed_lines_after = String(safeInt_(clean.feed_lines_after, 3, 0, 10));
  ['always_print_barcode', 'open_cash_drawer', 'cut_paper'].forEach(function (k) {
    if (clean[k] !== undefined) clean[k] = truthy_(clean[k]) ? '1' : '0';
  });
  if (clean.shop_name !== undefined && !clean.shop_name) throw new Error('店名不可空白。');
  return clean;
}

/** 收款驗證：未輸入收款視為剛好 */
function computePayment(total, cashReceived) {
  if (cashReceived === null || cashReceived === undefined || cashReceived === '') return { cash_received: 0, change_amount: 0, has_payment: false };
  var c = parseInt(cashReceived, 10);
  if (isNaN(c) || c < 0) throw new Error('收款金額格式錯誤。');
  if (c < total) throw new Error('收款金額不可小於總金額。');
  return { cash_received: c, change_amount: c - total, has_payment: true };
}
