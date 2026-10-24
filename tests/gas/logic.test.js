'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasContext } = require('./mock-gas');

const g = createGasContext();

test('單號與條碼邏輯號', () => {
  assert.equal(g.makeOrderNo('2026-07-04', 2), '202607040002');
  assert.equal(g.makeBarcodeNo('2026-07-04', 1), '0704001');
  assert.equal(g.makeBarcodeNo('20261225', 999), '1225999');
  assert.throws(() => g.makeBarcodeNo('2026-07-04', 1000));
  assert.throws(() => g.makeOrderNo('2026-07-04', 0));
});

test('EAN13 檢查碼與轉換', () => {
  assert.equal(g.ean13CheckDigit('200000704001'), '4');
  assert.equal(g.ean13CheckDigit('400638133393'), '1'); // 公開範例 4006381333931
  assert.equal(g.barcodeNoToEan13('0704001'), '2000007040014');
  assert.equal(g.barcodeNoToEan13('202607040001'), '2000007040014');
  assert.equal(g.barcodeNoToEan13('0704001', { ean13_prefix: '29999' }), '2999907040011'.slice(0, 12) + g.ean13CheckDigit('299990704001'));
  assert.equal(g.ean13ToBarcodeNo('2000007040014'), '0704001');
  assert.equal(g.ean13ToBarcodeNo('4006381333931'), '');
  assert.equal(g.barcodeNoFromOrderNo('202607040012'), '0704012');
});

test('EAN13 位元圖案長度 117 且起訖正確', () => {
  const bits = g.ean13Bits('2000007040014');
  assert.equal(bits.length, 117);
  assert.equal(bits.slice(11, 14), '101');
  assert.equal(bits.slice(56, 61), '01010');
  assert.equal(bits.slice(103, 106), '101');
});

test('查詢候選：EAN13 / 7 碼 / 12 碼 / Code39', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(g.lookupCandidates('2000007040014'))).barcodeNos, ['0704001']);
  assert.deepEqual(JSON.parse(JSON.stringify(g.lookupCandidates('0704001'))).barcodeNos, ['0704001']);
  const c = JSON.parse(JSON.stringify(g.lookupCandidates('*202607040003*')));
  assert.equal(c.orderNos[0], '202607040003');
  assert.equal(c.barcodeNos[0], '0704003');
});

test('版型清洗：補齊 role、限制範圍、字重取最近值', () => {
  const rows = g.sanitizeReceiptLayout([{ role: 'total', font_pt: 99, weight: 650, align: 'bogus', show: 'on' }, { role: 'x' }]);
  assert.equal(rows.length, 14);
  const total = rows.find((r) => r.role === 'total');
  assert.equal(total.font_pt, 24);
  assert.equal(total.weight, 700);
  assert.equal(total.align, 'left');
  assert.equal(total.show, 1);
});

test('單據行與列印工作', () => {
  const order = {
    order_no: '202607040002', barcode_no: '0704002', created_at: '2026-07-04 10:00:00',
    items: [{ name: '卡士達', price: 45, qty: 2 }, { name: '茶凍', price: 30, qty: 1 }],
    note: '先做、分開裝', cash_received: 200, change_amount: 80, payment_method: 'cash',
  };
  const job = g.buildPrintJob(order, g.DEFAULT_SETTINGS, g.DEFAULT_RECEIPT_LAYOUT);
  assert.equal(job.total, 120);
  assert.equal(job.ean13, '2000007040021');
  assert.equal(job.lines[0].role, 'barcode');
  assert.ok(job.lines.some((l) => l.text === '合計：120 元' && l.bold));
  assert.ok(job.lines.some((l) => l.text === '找零：80 元'));
  assert.ok(job.lines.some((l) => l.text === '先做、分開裝'));
  assert.ok(job.lines.find((l) => l.role === 'separator').text.length === 32);
  assert.equal(job.printer.paper_width_mm, 58);
  assert.match(job.preview, /單號：202607040002/);

  const wide = g.buildPrintJob(order, Object.assign({}, g.DEFAULT_SETTINGS, { paper_width_mm: '80' }), []);
  assert.equal(wide.lines.find((l) => l.role === 'separator').text.length, 48);
});

test('隱藏區塊不列印；條碼在 always_print_barcode=1 時強制列印', () => {
  const layout = g.DEFAULT_RECEIPT_LAYOUT.map((r) => Object.assign({}, r, { show: r.role === 'address' || r.role === 'barcode' ? 0 : 1 }));
  const job = g.buildPrintJob({ order_no: '202607040001', barcode_no: '0704001', items: [{ name: 'A', price: 1, qty: 1 }] }, g.DEFAULT_SETTINGS, layout);
  assert.ok(!job.lines.some((l) => l.role === 'address'));
  assert.ok(job.lines.some((l) => l.role === 'barcode'));
  const s2 = Object.assign({}, g.DEFAULT_SETTINGS, { always_print_barcode: '0' });
  const job2 = g.buildPrintJob({ order_no: '202607040001', barcode_no: '0704001', items: [{ name: 'A', price: 1, qty: 1 }] }, s2, layout);
  assert.ok(!job2.lines.some((l) => l.role === 'barcode'));
});

test('設定驗證', () => {
  assert.throws(() => g.validateSettings({ print_mode: 'serial' }));
  assert.throws(() => g.validateSettings({ ean13_prefix: '123' }));
  assert.throws(() => g.validateSettings({ line_spacing_percent: '200' }));
  const c = g.validateSettings({ print_margin_left_mm: '1.5', open_cash_drawer: 'true', unknown: 'x', encoding: 'big5' });
  assert.equal(c.print_margin_left_mm, '1.50');
  assert.equal(c.open_cash_drawer, '1');
  assert.equal(c.unknown, undefined);
});

test('收款計算', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(g.computePayment(120, 200))), { cash_received: 200, change_amount: 80, has_payment: true });
  assert.equal(g.computePayment(120, '').has_payment, false);
  assert.throws(() => g.computePayment(120, 100));
});
