/**
 * MPOS Cloud - 設定與預設資料
 * 茉莉花鯛魚燒 POS（GAS 管理後台版）
 */
var APP_VERSION = 'cloud-1.7.0';
var TZ = 'Asia/Taipei';

var DEFAULT_SHOP = {
  shop_name: '茉莉花鯛魚燒',
  shop_address: '彰化縣和美鎮鹿和路六段442號',
  shop_phone: '0958-456-295',
};

/** 系統設定預設值（寫在 settings 工作表，可於「設定」頁修改） */
var DEFAULT_SETTINGS = {
  shop_name: DEFAULT_SHOP.shop_name,
  shop_address: DEFAULT_SHOP.shop_address,
  shop_phone: DEFAULT_SHOP.shop_phone,
  footer_msg: '現點現做，請耐心等候。',
  print_mode: 'bluetooth',          // bluetooth = Android App 藍牙 ESC/POS；browser = 瀏覽器預覽；none = 不列印
  paper_width_mm: '58',             // 58 或 80
  encoding: 'big5',                 // big5 / cp950 / gbk / gb18030 / utf-8
  print_darkness: 'normal',         // light / normal / dark / extra_dark
  line_spacing_percent: '100',      // 70 ~ 160
  print_margin_left_mm: '0.00',
  print_margin_top_mm: '0.00',
  print_start_x_mm: '0.00',
  print_start_y_mm: '0.00',
  barcode_max_width_percent: '88',
  cancel_reasons: '客戶臨時取消\n客戶未取餐\n等候太久\n點錯 / 重複下單\n店家缺貨\n店家忙不過來\n其他',
  cancel_require_pin: '0',          // 取消訂單是否需要管理密碼
  barcode_print_mode: 'escstar',    // 條碼列印方式：escstar（ESC * 點陣，相容性最高）/ raster（GS v 0）/ gsk（印表機內建）/ none
  always_print_barcode: '1',
  barcode_number_mode: 'mmdd_seq3',
  barcode_sequence_digits: '3',
  barcode_type: 'ean13',
  ean13_prefix: '20000',
  open_cash_drawer: '0',            // 1 = 結帳列印後開錢箱（ESC p）
  cut_paper: '1',
  feed_lines_after: '3',
  barcode_confirm: '1',             // 條碼輸入：1 = 開窗確認後帶回；0 = 掃到直接帶回
};

/** 允許前端修改的設定欄位 */
var EDITABLE_SETTING_KEYS = [
  'shop_name', 'shop_address', 'shop_phone', 'footer_msg',
  'print_mode', 'paper_width_mm', 'encoding', 'print_darkness', 'line_spacing_percent',
  'print_margin_left_mm', 'print_margin_top_mm', 'print_start_x_mm', 'print_start_y_mm',
  'barcode_max_width_percent', 'always_print_barcode', 'ean13_prefix',
  'open_cash_drawer', 'cut_paper', 'feed_lines_after', 'barcode_confirm', 'barcode_print_mode',
  'cancel_reasons', 'cancel_require_pin',
];

var DEFAULT_MENU_ITEMS = [
  { id: 'original', category: '鯛魚燒口味', name: '原味（無餡料）', price: 35, sort_order: 10, active: 1 },
  { id: 'custard', category: '鯛魚燒口味', name: '卡士達', price: 45, sort_order: 20, active: 1 },
  { id: 'cheese', category: '鯛魚燒口味', name: '起司', price: 45, sort_order: 30, active: 1 },
  { id: 'milk_crisp', category: '鯛魚燒口味', name: '奶酥', price: 45, sort_order: 40, active: 1 },
  { id: 'tuna_corn_cheese', category: '鯛魚燒口味', name: '鮪魚玉米起司（鹹）', price: 60, sort_order: 50, active: 1 },
  { id: 'white_sauce_sausage', category: '鯛魚燒口味', name: '白醬德式香腸（鹹）', price: 60, sort_order: 60, active: 1 },
  { id: 'agar_jelly', category: '甜點', name: '洋菜凍', price: 25, sort_order: 70, active: 1 },
  { id: 'tea_jelly', category: '甜點', name: '茶凍', price: 30, sort_order: 80, active: 1 },
];

var DEFAULT_NOTE_PRESETS = [
  { id: 1, text: '先做', sort_order: 10, active: 1 },
  { id: 2, text: '分開裝', sort_order: 20, active: 1 },
  { id: 3, text: '一起裝', sort_order: 30, active: 1 },
  { id: 4, text: '客人現場等', sort_order: 40, active: 1 },
  { id: 5, text: '電話預訂', sort_order: 50, active: 1 },
  { id: 6, text: '少量紙袋', sort_order: 60, active: 1 },
  { id: 7, text: '不要壓到', sort_order: 70, active: 1 },
];

/** 訂單來源預設（後台「訂單來源」可增修） */
var DEFAULT_ORDER_SOURCES = [
  { id: 1, name: '現場點餐', sort_order: 10, active: 1 },
  { id: 2, name: '來電點餐', sort_order: 20, active: 1 },
  { id: 3, name: 'Uber點餐', sort_order: 30, active: 1 },
  { id: 4, name: '親友點餐', sort_order: 40, active: 1 },
];

var DEFAULT_RECEIPT_LAYOUT = [
  { role: 'order_source', title: '訂單來源（最上方大字）', show: 1, font_pt: 16, weight: 900, align: 'center', x_offset: 0, space_before: 0, space_after: 12 },
  { role: 'barcode', title: 'EAN13單號條碼', show: 1, font_pt: 10, weight: 400, align: 'left', x_offset: 0, space_before: 0, space_after: 4 },
  { role: 'shop_name', title: '店名', show: 1, font_pt: 12, weight: 900, align: 'left', x_offset: 0, space_before: 0, space_after: 2 },
  { role: 'separator', title: '分隔線', show: 1, font_pt: 7, weight: 400, align: 'left', x_offset: 0, space_before: 0, space_after: 0 },
  { role: 'order_no', title: '單號', show: 1, font_pt: 8, weight: 700, align: 'left', x_offset: 0, space_before: 0, space_after: 0 },
  { role: 'time', title: '時間', show: 1, font_pt: 8, weight: 400, align: 'left', x_offset: 0, space_before: 0, space_after: 1 },
  { role: 'customer', title: '客戶（來電）', show: 1, font_pt: 8, weight: 700, align: 'left', x_offset: 0, space_before: 0, space_after: 1 },
  { role: 'item_header', title: '品項標題', show: 1, font_pt: 8, weight: 700, align: 'left', x_offset: 0, space_before: 0, space_after: 0 },
  { role: 'item', title: '品項明細', show: 1, font_pt: 8, weight: 400, align: 'left', x_offset: 0, space_before: 0, space_after: 0 },
  { role: 'item_note', title: '品項備註', show: 1, font_pt: 8, weight: 700, align: 'left', x_offset: 0, space_before: 0, space_after: 0 },
  { role: 'total', title: '合計', show: 1, font_pt: 10, weight: 900, align: 'left', x_offset: 0, space_before: 1, space_after: 1 },
  { role: 'payment', title: '付款/收款/找零', show: 1, font_pt: 8, weight: 700, align: 'left', x_offset: 0, space_before: 0, space_after: 0 },
  { role: 'note', title: '備註', show: 1, font_pt: 8, weight: 700, align: 'left', x_offset: 0, space_before: 0, space_after: 1 },
  { role: 'footer_msg', title: '提示語', show: 1, font_pt: 8, weight: 400, align: 'center', x_offset: 0, space_before: 1, space_after: 0 },
  { role: 'address', title: '地址', show: 1, font_pt: 7, weight: 400, align: 'center', x_offset: 0, space_before: 0, space_after: 0 },
  { role: 'phone', title: '電話', show: 1, font_pt: 7, weight: 400, align: 'center', x_offset: 0, space_before: 0, space_after: 0 },
  { role: 'blank', title: '空白列', show: 1, font_pt: 7, weight: 400, align: 'left', x_offset: 0, space_before: 0, space_after: 0 },
];

/**
 * 試算表資料表結構。type: s = 文字、n = 數字
 * 文字欄位會設定為純文字格式，避免 0704001 被 Sheets 轉成數字。
 */
var TABLES = {
  settings: { key: 'key', cols: [['key', 's'], ['value', 's']] },
  menu_items: { key: 'id', cols: [['id', 's'], ['category', 's'], ['name', 's'], ['price', 'n'], ['sort_order', 'n'], ['active', 'n']] },
  note_presets: { key: 'id', cols: [['id', 'n'], ['text', 's'], ['sort_order', 'n'], ['active', 'n']] },
  customers: { key: 'phone', cols: [['phone', 's'], ['name', 's'], ['call_count', 'n'], ['last_call_at', 's'], ['last_order_at', 's'], ['created_at', 's']] },
  calls: { key: 'id', cols: [['id', 'n'], ['phone', 's'], ['called_at', 's']] },
  order_sources: { key: 'id', cols: [['id', 'n'], ['name', 's'], ['sort_order', 'n'], ['active', 'n']] },
  orders: {
    key: 'id',
    cols: [['id', 'n'], ['order_date', 's'], ['daily_no', 'n'], ['order_no', 's'], ['barcode_no', 's'], ['status', 's'],
      ['total', 'n'], ['note', 's'], ['created_at', 's'], ['printed_at', 's'], ['completed_at', 's'], ['cancelled_at', 's'],
      ['cash_received', 'n'], ['change_amount', 'n'], ['payment_method', 's'],
      ['order_source', 's'], ['client_ref', 's'],
      ['pay_status', 's'], ['paid_at', 's'], ['customer_name', 's'], ['customer_phone', 's'],
      ['cancel_type', 's'], ['cancel_reason', 's'], ['cancel_note', 's'], ['cancel_refund', 'n'], ['cancel_from', 's']],
  },
  order_items: { key: 'id', cols: [['id', 'n'], ['order_id', 'n'], ['item_id', 's'], ['name', 's'], ['price', 'n'], ['qty', 'n'], ['subtotal', 'n'], ['note', 's']] },
  receipt_layout: {
    key: 'role',
    cols: [['role', 's'], ['sort_order', 'n'], ['title', 's'], ['show', 'n'], ['font_pt', 'n'], ['weight', 'n'], ['align', 's'],
      ['x_offset', 'n'], ['space_before', 'n'], ['space_after', 'n'], ['updated_at', 's']],
  },
};
