'use strict';
/**
 * 用記憶體版試算表跑完整後端流程：setup → 開單 → 列印標記 → 查詢 → 完成/取消 → 後台修改。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasContext } = require('./mock-gas');

const plain = (o) => JSON.parse(JSON.stringify(o));

function fresh(nowFn) {
  const g = createGasContext({ now: nowFn });
  const r = g.setup();
  assert.equal(r.ok, true);
  return g;
}

test('setup 建立工作表並匯入種子資料，重複執行不重複匯入', () => {
  const g = fresh();
  const ss = Object.values(g.__store.spreadsheets)[0];
  const names = ss.getSheets().map((s) => s.getName()).sort();
  assert.deepEqual(names, ['calls', 'customers', 'menu_items', 'note_presets', 'order_items', 'order_sources', 'orders', 'receipt_layout', 'settings']);
  g.setup();
  const boot = plain(g.apiBootstrap());
  assert.equal(boot.ok, true);
  assert.equal(boot.all_menu.length, 8);
  assert.equal(boot.all_notes.length, 7);
  assert.equal(boot.layout.length, 17);
  assert.deepEqual(boot.sources.map((x) => x.name), ['現場點餐', '來電點餐', 'Uber點餐', '親友點餐']);
  assert.equal(boot.settings.barcode_confirm, '1');
  assert.equal(boot.settings.encoding, 'cp950'); // 舊資料庫設定已匯入
  assert.equal(g.__store.props.ADMIN_PIN, '1234');
});

test('開單：流水號遞增、條碼文字不被轉成數字、列印工作正確', () => {
  const g = fresh(() => new Date('2026-07-04T02:00:00Z')); // 台灣 10:00
  const r1 = plain(g.apiCreateOrder({ order_source: '現場點餐', items: [{ id: 'custard', qty: 2 }], note: '先做', print: true, cash_received: 100 }));
  assert.equal(r1.ok, true, r1.message);
  assert.equal(r1.order.order_no, '202607040001');
  assert.equal(r1.order.barcode_no, '0704001');
  assert.equal(r1.order.change_amount, 10);
  assert.equal(r1.print_job.ean13, '2000007040014');
  assert.equal(r1.print_job.total, 90);

  const r2 = plain(g.apiCreateOrder({ order_source: '現場點餐', items: [{ id: 'tea_jelly', qty: 1 }], print: false }));
  assert.equal(r2.order.daily_no, 2);
  assert.equal(r2.print_job, null);

  const list = plain(g.apiOrders('2026/07/04', ''));
  assert.equal(list.orders.length, 2);
  assert.equal(list.orders[0].order_no, '202607040002'); // 新的在前
  assert.strictEqual(list.orders[1].barcode_no, '0704001'); // 前導 0 保留
  assert.equal(list.summary.by_status.pending.amount, 120);
  assert.equal(list.summary.items[0].name, '卡士達');

  assert.equal(g.apiMarkPrinted(r1.order.id).ok, true);
  assert.ok(plain(g.apiOrders('2026-07-04')).orders[1].printed_at);
});

test('訂購項目備註：同商品不同備註分開記錄，並印在該品項下方', () => {
  const g = fresh(() => new Date('2026-07-04T02:00:00Z'));
  const r = plain(g.apiCreateOrder({
    order_source: '來電點餐', items: [{ id: 'custard', qty: 2, note: '先做、分開裝' }, { id: 'custard', qty: 1, note: '' }, { id: 'cheese', qty: 1, note: '多烤一點\n' }],
    note: '王先生 18:30 取餐', print: true, cash_received: 200,
  }));
  assert.equal(r.ok, true, r.message);
  assert.equal(r.order.items.length, 3);
  assert.equal(r.order.total, 180);
  const lines = r.print_job.lines.map((l) => l.role + '|' + l.text);
  const i1 = lines.indexOf('item|卡士達');
  assert.equal(lines[i1 + 1], 'item_note|  ※先做、分開裝');
  assert.ok(lines.includes('item_note|  ※多烤一點'));
  assert.ok(lines.includes('note|王先生 18:30 取餐'), '整張訂單備註仍在備註區');
  const saved = plain(g.apiOrders('2026-07-04')).orders[0];
  assert.deepEqual(saved.items.map((i) => i.note), ['先做、分開裝', '', '多烤一點']);
  assert.equal(saved.note, '王先生 18:30 取餐');
  assert.equal(plain(g.apiLookup('0704001')).order.items[0].note, '先做、分開裝');
});

test('舊資料表自動補上 order_items.note 欄位', () => {
  const g = createGasContext();
  const ss = g.SpreadsheetApp.create('old');
  g.PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());
  const sh = ss.insertSheet('order_items');
  sh.getRange(1, 1, 1, 7).setValues([['id', 'order_id', 'item_id', 'name', 'price', 'qty', 'subtotal']]);
  sh.getRange(2, 1, 1, 7).setValues([[1, 1, 'cheese', '起司', 45, 1, 45]]);
  g.setup();
  assert.equal(sh.getRange(1, 8).getValues()[0][0], 'note');
  assert.equal(plain(g.apiCreateOrder({ order_source: '現場點餐', items: [{ id: 'cheese', qty: 1, note: 'x' }], print: false })).ok, true);
});

test('開單驗證：未結帳不得列印、收款不足、停用商品', () => {
  const g = fresh();
  assert.match(g.apiCreateOrder({ order_source: '現場點餐', items: [{ id: 'custard', qty: 1 }], print: true }).message, /結帳/);
  assert.match(g.apiCreateOrder({ order_source: '現場點餐', items: [{ id: 'custard', qty: 1 }], print: true, cash_received: 10 }).message, /不可小於/);
  assert.match(g.apiCreateOrder({ order_source: '現場點餐', items: [{ id: 'nope', qty: 1 }], print: false }).message, /不存在/);
  assert.match(g.apiCreateOrder({ order_source: '現場點餐', items: [], print: false }).message, /尚未點選/);
});

test('查詢、完成、取消、補印', () => {
  const g = fresh(() => new Date('2026-07-04T02:00:00Z'));
  const o = plain(g.apiCreateOrder({ order_source: '現場點餐', items: [{ id: 'cheese', qty: 1 }], print: false })).order;
  assert.equal(plain(g.apiLookup('2000007040014')).order.id, o.id);
  assert.equal(plain(g.apiLookup('0704001')).order.items.length, 1);
  assert.equal(plain(g.apiLookup('202607040001')).order.total, 45);
  assert.equal(g.apiLookup('0704999').ok, false);

  const rp = plain(g.apiReprintJob(o.id));
  assert.equal(rp.print_job.order_no, '202607040001');

  assert.equal(g.apiCompleteOrder(o.id).ok, true);
  const o2 = plain(g.apiCreateOrder({ order_source: '現場點餐', items: [{ id: 'cheese', qty: 1 }], print: false })).order;
  assert.match(g.apiCancelOrder(o2.id).message, /取消類型/, '沒有註記不能取消');
  assert.match(g.apiCancelOrder({ order_id: o2.id, type: 'customer' }).message, /取消原因/);
  assert.equal(g.apiCancelOrder({ order_id: o2.id, type: 'customer', reason: '客戶臨時取消' }).ok, true);
  assert.match(g.apiCancelOrder({ order_id: o2.id, type: 'customer', reason: 'x' }).message, /已經取消/);
  assert.match(g.apiCompleteOrder(o2.id).message, /已取消/);
  const sum = plain(g.apiOrders('2026-07-04')).summary;
  assert.equal(sum.by_status.completed.cnt, 1);
  assert.equal(sum.by_status.cancelled.cnt, 1);
  assert.equal(sum.items[0].qty, 1); // 取消的不列入品項統計
});

test('跨日流水號重新從 1 開始', () => {
  let now = new Date('2026-07-04T15:30:00Z'); // 台灣 23:30
  const g = fresh(() => now);
  assert.equal(plain(g.apiCreateOrder({ order_source: '現場點餐', items: [{ id: 'cheese', qty: 1 }], print: false })).order.order_no, '202607040001');
  now = new Date('2026-07-04T16:30:00Z'); // 台灣隔日 00:30
  assert.equal(plain(g.apiCreateOrder({ order_source: '現場點餐', items: [{ id: 'cheese', qty: 1 }], print: false })).order.order_no, '202607050001');
});

test('後台：密碼保護、商品 / 備註 / 設定 / 版型 / 改密碼', () => {
  const g = fresh();
  assert.equal(g.apiVerifyPin('0000').ok, false);
  assert.equal(g.apiVerifyPin('1234').ok, true);
  assert.equal(g.apiSaveMenuItem('0000', { category: 'x', name: 'y', price: 1 }).ok, false);

  const m = plain(g.apiSaveMenuItem('1234', { category: '飲料', name: '紅茶', price: 20, sort_order: 90 }));
  assert.equal(m.ok, true);
  assert.ok(m.items.some((i) => i.name === '紅茶'));
  const boot = plain(g.apiBootstrap());
  assert.ok(boot.menu.some((i) => i.name === '紅茶'), '快取應已清除');
  const tea = boot.menu.find((i) => i.name === '紅茶');
  assert.equal(g.apiDisableMenuItem('1234', tea.id).ok, true);
  assert.ok(!plain(g.apiBootstrap()).menu.some((i) => i.name === '紅茶'));

  const n = plain(g.apiSaveNote('1234', { text: '加辣', sort_order: 5 }));
  assert.equal(n.notes[0].text, '加辣');
  assert.equal(n.notes[0].id, 8);

  const s = plain(g.apiSaveSettings('1234', { paper_width_mm: '80', shop_phone: '04-1234567' }));
  assert.equal(s.settings.paper_width_mm, '80');
  assert.equal(plain(g.apiBootstrap()).shop.phone, '04-1234567');
  assert.equal(g.apiSaveSettings('1234', { print_mode: 'serial' }).ok, false);

  const layout = plain(g.apiBootstrap()).layout;
  layout.find((r) => r.role === 'address').show = 0;
  assert.equal(g.apiSaveLayout('1234', layout).ok, true);
  assert.equal(plain(g.apiBootstrap()).layout.find((r) => r.role === 'address').show, 0);

  assert.equal(g.apiChangePin('1234', '12').ok, false);
  assert.equal(g.apiChangePin('1234', '5678').ok, true);
  assert.equal(g.apiVerifyPin('5678').ok, true);
});

test('HTTP 入口：health 與 doPost 白名單', () => {
  const g = fresh();
  const health = JSON.parse(g.doGet({ parameter: { api: 'health' } }).getContent());
  assert.equal(health.ok, true, JSON.stringify(health));
  assert.ok(health.self_test.every((t) => t.ok));
  const post = (body) => JSON.parse(g.doPost({ postData: { contents: JSON.stringify(body) } }).getContent());
  assert.equal(post({ fn: 'apiBootstrap', args: [] }).ok, true);
  assert.equal(post({ fn: 'apiSaveSettings', args: ['1234', {}] }).ok, false, '後台 API 不得經 HTTP 呼叫');
  assert.equal(post({ fn: 'setup' }).ok, false);
});

test('單據版型：訂單來源升級為最上方大字置中（舊預設自動升級，自訂保留）', () => {
  const g = fresh(() => new Date('2026-07-04T02:00:00Z'));
  const old = [{ role: 'barcode', title: 'EAN13單號條碼', sort_order: 0 }, { role: 'order_source', title: '訂單來源', show: 1, font_pt: 10, weight: 900, align: 'left', sort_order: 50 }];
  const up = plain(g.sanitizeReceiptLayout(old));
  assert.equal(up[0].role, 'order_source');
  assert.equal(up[0].font_pt, 16);
  assert.equal(up[0].align, 'center');
  const custom = plain(g.sanitizeReceiptLayout([{ role: 'order_source', title: '來源', font_pt: 20, align: 'left' }]));
  assert.equal(custom[0].font_pt, 20);
  assert.equal(plain(g.apiSaveSettings('1234', { barcode_print_mode: 'gsk' })).settings.barcode_print_mode, 'gsk');
  assert.match(g.apiSaveSettings('1234', { barcode_print_mode: 'xx' }).message, /條碼列印方式/);
  const t = plain(g.apiTestPrintJob('modes'));
  assert.deepEqual(t.print_job.lines.filter((l) => l.role === 'barcode').map((l) => l.barcode_mode), ['escstar', 'raster', 'gsk']);
});

test('訂單來源：必填、需為啟用中的來源、印在單據並寫入訂單與統計', () => {
  const g = fresh(() => new Date('2026-07-04T02:00:00Z'));
  assert.match(g.apiCreateOrder({ items: [{ id: 'cheese', qty: 1 }], print: false }).message, /訂單來源/);
  assert.match(g.apiCreateOrder({ order_source: '外星點餐', items: [{ id: 'cheese', qty: 1 }], print: false }).message, /不存在/);
  const r = plain(g.apiCreateOrder({ order_source: 'Uber點餐', items: [{ id: 'cheese', qty: 2 }], print: true, cash_received: 90 }));
  assert.equal(r.ok, true, r.message);
  assert.equal(r.order.order_source, 'Uber點餐');
  const lines = r.print_job.lines.map((l) => l.role + '|' + l.text);
  assert.equal(lines[0], 'order_source|【Uber點餐】', '訂單來源在最上方');
  const src = r.print_job.lines.find((l) => l.role === 'order_source');
  assert.equal(src.font_pt, 16);
  assert.equal(src.align, 'center');
  assert.equal(r.print_job.printer.barcode_mode, 'escstar');
  plain(g.apiCreateOrder({ order_source: '來電點餐', items: [{ id: 'custard', qty: 1 }], print: false }));
  const sum = plain(g.apiOrders('2026-07-04')).summary;
  assert.deepEqual(sum.by_source.map((x) => [x.name, x.cnt, x.amount]), [['Uber點餐', 1, 90], ['來電點餐', 1, 45]]);
  assert.equal(plain(g.apiLookup('0704001')).order.order_source, 'Uber點餐');
});

test('本機暫存訂單重送：同一 client_ref 只建立一筆', () => {
  const g = fresh(() => new Date('2026-07-04T02:00:00Z'));
  const payload = { order_source: '現場點餐', client_ref: 'D-abc123', items: [{ id: 'cheese', qty: 1 }], print: true, cash_received: 45 };
  const a = plain(g.apiCreateOrder(payload));
  const b = plain(g.apiCreateOrder(payload));
  assert.equal(a.order.order_no, b.order.order_no);
  assert.equal(b.duplicate, true);
  assert.ok(b.print_job, '重送仍回傳列印工作，讓前端可補印');
  assert.equal(plain(g.apiOrders('2026-07-04')).orders.length, 1);
});

test('後台：訂單來源管理（新增、改名、重複名稱、停用）', () => {
  const g = fresh();
  assert.equal(g.apiSaveSource('0000', { name: 'x' }).ok, false);
  const r = plain(g.apiSaveSource('1234', { name: 'LINE點餐', sort_order: 25 }));
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(r.sources.map((x) => x.name), ['現場點餐', '來電點餐', 'LINE點餐', 'Uber點餐', '親友點餐']);
  assert.match(g.apiSaveSource('1234', { name: '來電點餐' }).message, /相同名稱/);
  const line = r.sources.find((x) => x.name === 'LINE點餐');
  assert.equal(g.apiSaveSource('1234', { id: line.id, name: 'LINE 訂購', sort_order: 25 }).ok, true);
  assert.equal(g.apiDisableSource('1234', line.id).ok, true);
  const boot = plain(g.apiBootstrap());
  assert.ok(!boot.sources.some((x) => x.name === 'LINE 訂購'));
  assert.ok(boot.all_sources.some((x) => x.name === 'LINE 訂購' && x.active === 0));
  assert.match(g.apiCreateOrder({ order_source: 'LINE 訂購', items: [{ id: 'cheese', qty: 1 }], print: false }).message, /停用/);
});

test('設定：條碼輸入確認方式', () => {
  const g = fresh();
  assert.equal(plain(g.apiSaveSettings('1234', { barcode_confirm: '0' })).settings.barcode_confirm, '0');
  assert.equal(plain(g.apiBootstrap()).settings.barcode_confirm, '0');
});

test('舊版資料庫升級：沒有 order_sources 工作表時自動建立預設來源', () => {
  const g = fresh();
  const ss = Object.values(g.__store.spreadsheets)[0];
  ss.deleteSheet(ss.getSheetByName('order_sources'));
  g.__store.cache = {};
  const boot = plain(g.apiBootstrap());
  assert.equal(boot.sources.length, 4);
  assert.equal(ss.getSheetByName('order_sources').getLastRow(), 5);
  assert.equal(plain(g.apiSaveSource('1234', { name: '團購', sort_order: 50 })).sources.length, 5);
});

test('掛單 → 用條碼叫回 → 修改品項後找零結帳（單號不變、品項替換）', () => {
  const g = fresh(() => new Date('2026-07-04T02:00:00Z'));
  const held = plain(g.apiCreateOrder({ order_source: '來電點餐', hold: true, print: true, client_ref: 'H1',
    customer_phone: '+886 912-345-678', customer_name: '', items: [{ id: 'custard', qty: 2, note: '先做' }] }));
  assert.equal(held.ok, true, held.message);
  assert.equal(held.order.pay_status, 'unpaid');
  assert.equal(held.order.customer_phone, '0912345678');
  const texts = held.print_job.lines.map((l) => l.text);
  assert.ok(texts.includes('付款狀態：未付款（取餐時付款）'));
  assert.ok(texts.includes('客戶：0912-345-678'));
  // 重送掛單不重複
  assert.equal(plain(g.apiCreateOrder({ order_source: '來電點餐', hold: true, print: false, client_ref: 'H1', items: [{ id: 'custard', qty: 2 }] })).duplicate, true);

  const ld = plain(g.apiLoadOrder('2000007040014'));
  assert.equal(ld.editable, true);
  assert.equal(ld.order.items[0].note, '先做');

  const paid = plain(g.apiCreateOrder({ order_id: ld.order.id, order_source: '來電點餐', client_ref: 'P1', customer_name: '王先生',
    items: [{ id: 'custard', qty: 1 }, { id: 'tea_jelly', qty: 1 }], print: true, cash_received: 100 }));
  assert.equal(paid.ok, true, paid.message);
  assert.equal(paid.updated, true);
  assert.equal(paid.order.order_no, '202607040001');
  assert.equal(paid.order.total, 75);
  assert.equal(paid.order.change_amount, 25);
  assert.equal(paid.order.customer_name, '王先生');
  assert.equal(paid.order.customer_phone, '0912345678', '沒帶電話時保留原電話');
  const list = plain(g.apiOrders('2026-07-04')).orders;
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].items.map((i) => i.name + 'x' + i.qty), ['卡士達x1', '茶凍x1']);
  assert.equal(list[0].pay_status, 'paid');
  // 重送結帳不重複；已付款不可再結帳
  assert.equal(plain(g.apiCreateOrder({ order_id: ld.order.id, order_source: '來電點餐', client_ref: 'P1', items: [{ id: 'custard', qty: 1 }], print: false, cash_received: 45 })).duplicate, true);
  assert.match(g.apiCreateOrder({ order_id: ld.order.id, order_source: '來電點餐', client_ref: 'P2', items: [{ id: 'custard', qty: 1 }], print: false, cash_received: 45 }).message, /已結帳/);
  assert.equal(plain(g.apiLoadOrder('202607040001')).editable, false);
});

test('來電：記錄來電、顯示客戶名稱、今日來電清單、歷史交易品項', () => {
  const g = fresh(() => new Date('2026-07-04T02:00:00Z'));
  let r = plain(g.apiRegisterCall('0912345678'));
  assert.equal(r.ok, true, r.message);
  assert.equal(r.known, false);
  assert.equal(r.customer.phone_display, '0912-345-678');
  assert.equal(g.apiRegisterCall('12').ok, false);
  plain(g.apiCreateOrder({ order_source: '來電點餐', customer_phone: '0912345678', customer_name: '王先生', items: [{ id: 'cheese', qty: 2 }], print: false }));
  plain(g.apiCreateOrder({ order_source: '來電點餐', customer_phone: '0912345678', items: [{ id: 'cheese', qty: 1 }, { id: 'tea_jelly', qty: 1 }], print: false }));
  r = plain(g.apiRegisterCall('+886912345678'));
  assert.equal(r.known, true);
  assert.equal(r.customer.name, '王先生', '空白名稱不覆蓋既有名稱');
  assert.equal(r.customer.call_count, 2);
  plain(g.apiRegisterCall('0422223333'));
  const calls = plain(g.apiRecentCalls()).calls;
  assert.deepEqual(calls.map((c) => [c.phone, c.name, c.count_today]), [['0422223333', '', 1], ['0912345678', '王先生', 2]]);
  const hist = plain(g.apiCustomerHistory('0912-345-678'));
  assert.equal(hist.order_count, 2);
  assert.deepEqual(hist.top_items.map((x) => [x.name, x.qty]), [['起司', 3], ['茶凍', 1]]);
  assert.equal(plain(g.apiSaveCustomer('0422223333', '李小姐')).customer.name, '李小姐');
  assert.equal(plain(g.apiRecentCalls()).calls[0].name, '李小姐');
});

test('電話正規化', () => {
  const g = fresh();
  assert.equal(g.normalizePhone('+886-912-345-678'), '0912345678');
  assert.equal(g.normalizePhone('886912345678'), '0912345678');
  assert.equal(g.normalizePhone('(04) 2358-8577'), '0423588577');
  assert.equal(g.normalizePhone('123'), '');
  assert.equal(g.formatPhone('0912345678'), '0912-345-678');
});

test('來電記錄：指定日期逐筆列出、附名稱與訂單數', () => {
  let now = new Date('2026-07-04T02:00:00Z');
  const g = fresh(() => now);
  g.apiRegisterCall('0912345678');
  g.apiSaveCustomer('0912345678', '王先生');
  plain(g.apiCreateOrder({ order_source: '來電點餐', customer_phone: '0912345678', items: [{ id: 'cheese', qty: 1 }], print: false }));
  g.apiRegisterCall('0422223333');
  g.apiRegisterCall('0912345678');
  now = new Date('2026-07-05T02:00:00Z');
  g.apiRegisterCall('0955000111');
  const d4 = plain(g.apiCallLog('2026-07-04'));
  assert.deepEqual(d4.calls.map((c) => [c.phone, c.name, c.order_count]), [['0912345678', '王先生', 1], ['0422223333', '', 0], ['0912345678', '王先生', 1]]);
  assert.equal(plain(g.apiCallLog('2026/07/05')).calls.length, 1);
});

test('取消訂單：註記類型 / 原因 / 說明 / 退款，已完成也可取消，可列印取消單，需要時要密碼', () => {
  const g = fresh(() => new Date('2026-07-04T02:00:00Z'));
  const paid = plain(g.apiCreateOrder({ order_source: '來電點餐', customer_phone: '0910670803', customer_name: '王先生', items: [{ id: 'custard', qty: 2 }], print: false, cash_received: 100 })).order;
  g.apiCompleteOrder(paid.id);
  assert.match(g.apiCancelOrder({ order_id: paid.id, type: 'customer', reason: '等候太久', refund: 999 }).message, /退款金額/);
  const r = plain(g.apiCancelOrder({ order_id: paid.id, type: 'customer', reason: '等候太久', note: '等了 40 分鐘', print: true }));
  assert.equal(r.ok, true, r.message);
  assert.equal(r.order.status, 'cancelled');
  assert.equal(r.order.cancel_from, 'completed');
  assert.equal(r.order.cancel_type, 'customer');
  assert.equal(r.order.cancel_reason, '等候太久');
  assert.equal(r.order.cancel_note, '等了 40 分鐘');
  assert.equal(r.order.cancel_refund, 90, '已付款預設全額退款');
  assert.match(r.message, /退款 90 元/);
  const texts = r.print_job.lines.map((l) => l.text);
  assert.equal(texts[0], '*** 訂單取消 ***');
  assert.ok(texts.includes('客戶取消：等候太久'));
  assert.ok(texts.includes('退款：90 元'));
  assert.ok(!r.print_job.lines.some((l) => l.role === 'barcode'));

  // 掛單（未付款）取消：不退款
  const hold = plain(g.apiCreateOrder({ order_source: '現場點餐', items: [{ id: 'cheese', qty: 1 }], hold: true, print: false })).order;
  const r2 = plain(g.apiCancelOrder({ order_id: hold.id, type: 'store', reason: '店家缺貨', refund: 50 }));
  assert.equal(r2.order.cancel_refund, 0);
  assert.equal(r2.print_job, null);

  // 設定「取消需要密碼」
  plain(g.apiSaveSettings('1234', { cancel_require_pin: '1', cancel_reasons: '客戶臨時取消\n其他\n其他' }));
  assert.equal(plain(g.apiBootstrap()).settings.cancel_reasons, '客戶臨時取消\n其他');
  const o3 = plain(g.apiCreateOrder({ order_source: '現場點餐', items: [{ id: 'cheese', qty: 1 }], print: false })).order;
  assert.match(g.apiCancelOrder({ order_id: o3.id, type: 'store', reason: '其他' }).message, /密碼/);
  assert.equal(g.apiCancelOrder({ order_id: o3.id, type: 'store', reason: '其他', pin: '1234' }).ok, true);
  assert.match(g.apiSaveSettings('1234', { cancel_reasons: '  ' }).message, /至少/);
});

test('退單分析：退單率、依原因 / 類型 / 來源 / 客戶 / 日期；客戶歷史與來電顯示退單次數', () => {
  let now = new Date('2026-07-03T02:00:00Z');
  const g = fresh(() => now);
  const mk = (src, phone, cancel) => {
    const o = plain(g.apiCreateOrder({ order_source: src, customer_phone: phone, items: [{ id: 'custard', qty: 1 }], print: false, cash_received: 45 })).order;
    if (cancel) assert.equal(g.apiCancelOrder(Object.assign({ order_id: o.id }, cancel)).ok, true);
    return o;
  };
  mk('來電點餐', '0910670803', { type: 'customer', reason: '客戶未取餐' });
  mk('現場點餐', '', null);
  now = new Date('2026-07-04T02:00:00Z');
  mk('來電點餐', '0910670803', { type: 'customer', reason: '客戶未取餐' });
  mk('來電點餐', '0910670803', null);
  mk('Uber點餐', '', { type: 'store', reason: '店家缺貨' });
  mk('現場點餐', '0922333444', null);
  g.apiSaveCustomer('0910670803', '王先生');

  assert.match(g.apiCancelStats('0000', '2026-07-01', '2026-07-04').message, /密碼/);
  const s = plain(g.apiCancelStats('1234', '2026-07-04', '2026-07-01'));
  assert.equal(s.from, '2026-07-01');
  assert.equal(s.total, 6);
  assert.equal(s.cancelled, 3);
  assert.equal(s.rate, 50);
  assert.equal(s.cancel_amount, 135);
  assert.equal(s.refund, 135);
  assert.deepEqual(s.by_reason.map((x) => [x.name, x.cancelled, x.share]), [['客戶未取餐', 2, 66.7], ['店家缺貨', 1, 33.3]]);
  assert.deepEqual(s.by_type.map((x) => [x.name, x.cancelled]), [['客戶取消', 2], ['店家取消', 1]]);
  const src = Object.fromEntries(s.by_source.map((x) => [x.name, [x.orders, x.cancelled, x.rate]]));
  assert.deepEqual(src['來電點餐'], [3, 2, 66.7]);
  assert.deepEqual(src['Uber點餐'], [1, 1, 100]);
  assert.deepEqual(s.by_customer.map((x) => [x.phone, x.customer_name, x.orders, x.cancelled, x.rate]), [['0910670803', '王先生', 3, 2, 66.7]]);
  assert.deepEqual(s.by_date.map((x) => [x.name, x.orders, x.cancelled]), [['2026-07-03', 2, 1], ['2026-07-04', 4, 2]]);
  assert.equal(s.recent.length, 3);
  assert.equal(plain(g.apiCancelStats('1234', '2026-07-04', '2026-07-04')).total, 4);

  const h = plain(g.apiCustomerHistory('0910670803'));
  assert.deepEqual(h.cancel, { order_total: 3, cancel_count: 2, cancel_rate: 66.7 });
  g.apiRegisterCall('0910670803');
  assert.equal(plain(g.apiRecentCalls()).calls[0].cancel_count, 2);
  assert.equal(plain(g.apiCallLog('2026-07-04')).calls[0].cancel_count, 2);
});

test('暫存訂單清單：只列未付款且未取消', () => {
  const g = fresh(() => new Date('2026-07-04T02:00:00Z'));
  const a = plain(g.apiCreateOrder({ order_source: '現場點餐', items: [{ id: 'cheese', qty: 1 }], hold: true, print: false }));
  assert.match(a.message, /已暫存訂單/);
  const b = plain(g.apiCreateOrder({ order_source: '現場點餐', items: [{ id: 'cheese', qty: 2 }], hold: true, print: false })).order;
  plain(g.apiCreateOrder({ order_source: '現場點餐', items: [{ id: 'cheese', qty: 1 }], print: false }));
  g.apiCancelOrder({ order_id: b.id, type: 'store', reason: '其他' });
  const list = plain(g.apiHeldOrders(7)).orders;
  assert.deepEqual(list.map((o) => o.order_no), [a.order.order_no]);
  assert.equal(list[0].items.length, 1);
});
