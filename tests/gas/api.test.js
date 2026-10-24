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
  assert.deepEqual(names, ['menu_items', 'note_presets', 'order_items', 'order_sources', 'orders', 'receipt_layout', 'settings']);
  g.setup();
  const boot = plain(g.apiBootstrap());
  assert.equal(boot.ok, true);
  assert.equal(boot.all_menu.length, 8);
  assert.equal(boot.all_notes.length, 7);
  assert.equal(boot.layout.length, 16);
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
  assert.match(g.apiCancelOrder(o.id).message, /已完成/);
  const o2 = plain(g.apiCreateOrder({ order_source: '現場點餐', items: [{ id: 'cheese', qty: 1 }], print: false })).order;
  assert.equal(g.apiCancelOrder(o2.id).ok, true);
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

test('訂單來源：必填、需為啟用中的來源、印在單據並寫入訂單與統計', () => {
  const g = fresh(() => new Date('2026-07-04T02:00:00Z'));
  assert.match(g.apiCreateOrder({ items: [{ id: 'cheese', qty: 1 }], print: false }).message, /訂單來源/);
  assert.match(g.apiCreateOrder({ order_source: '外星點餐', items: [{ id: 'cheese', qty: 1 }], print: false }).message, /不存在/);
  const r = plain(g.apiCreateOrder({ order_source: 'Uber點餐', items: [{ id: 'cheese', qty: 2 }], print: true, cash_received: 90 }));
  assert.equal(r.ok, true, r.message);
  assert.equal(r.order.order_source, 'Uber點餐');
  const lines = r.print_job.lines.map((l) => l.role + '|' + l.text);
  assert.ok(lines.includes('order_source|來源：Uber點餐'));
  assert.ok(lines.indexOf('order_source|來源：Uber點餐') > lines.findIndex((x) => x.startsWith('time|')));
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
