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
  assert.deepEqual(names, ['menu_items', 'note_presets', 'order_items', 'orders', 'receipt_layout', 'settings']);
  g.setup();
  const boot = plain(g.apiBootstrap());
  assert.equal(boot.ok, true);
  assert.equal(boot.all_menu.length, 8);
  assert.equal(boot.all_notes.length, 7);
  assert.equal(boot.layout.length, 14);
  assert.equal(boot.settings.encoding, 'cp950'); // 舊資料庫設定已匯入
  assert.equal(g.__store.props.ADMIN_PIN, '1234');
});

test('開單：流水號遞增、條碼文字不被轉成數字、列印工作正確', () => {
  const g = fresh(() => new Date('2026-07-04T02:00:00Z')); // 台灣 10:00
  const r1 = plain(g.apiCreateOrder({ items: [{ id: 'custard', qty: 2 }], note: '先做', print: true, cash_received: 100 }));
  assert.equal(r1.ok, true, r1.message);
  assert.equal(r1.order.order_no, '202607040001');
  assert.equal(r1.order.barcode_no, '0704001');
  assert.equal(r1.order.change_amount, 10);
  assert.equal(r1.print_job.ean13, '2000007040014');
  assert.equal(r1.print_job.total, 90);

  const r2 = plain(g.apiCreateOrder({ items: [{ id: 'tea_jelly', qty: 1 }], print: false }));
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

test('開單驗證：未結帳不得列印、收款不足、停用商品', () => {
  const g = fresh();
  assert.match(g.apiCreateOrder({ items: [{ id: 'custard', qty: 1 }], print: true }).message, /結帳/);
  assert.match(g.apiCreateOrder({ items: [{ id: 'custard', qty: 1 }], print: true, cash_received: 10 }).message, /不可小於/);
  assert.match(g.apiCreateOrder({ items: [{ id: 'nope', qty: 1 }], print: false }).message, /不存在/);
  assert.match(g.apiCreateOrder({ items: [], print: false }).message, /尚未點選/);
});

test('查詢、完成、取消、補印', () => {
  const g = fresh(() => new Date('2026-07-04T02:00:00Z'));
  const o = plain(g.apiCreateOrder({ items: [{ id: 'cheese', qty: 1 }], print: false })).order;
  assert.equal(plain(g.apiLookup('2000007040014')).order.id, o.id);
  assert.equal(plain(g.apiLookup('0704001')).order.items.length, 1);
  assert.equal(plain(g.apiLookup('202607040001')).order.total, 45);
  assert.equal(g.apiLookup('0704999').ok, false);

  const rp = plain(g.apiReprintJob(o.id));
  assert.equal(rp.print_job.order_no, '202607040001');

  assert.equal(g.apiCompleteOrder(o.id).ok, true);
  assert.match(g.apiCancelOrder(o.id).message, /已完成/);
  const o2 = plain(g.apiCreateOrder({ items: [{ id: 'cheese', qty: 1 }], print: false })).order;
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
  assert.equal(plain(g.apiCreateOrder({ items: [{ id: 'cheese', qty: 1 }], print: false })).order.order_no, '202607040001');
  now = new Date('2026-07-04T16:30:00Z'); // 台灣隔日 00:30
  assert.equal(plain(g.apiCreateOrder({ items: [{ id: 'cheese', qty: 1 }], print: false })).order.order_no, '202607050001');
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
