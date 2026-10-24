'use strict';
/**
 * 端對端：外殼 index.html → iframe(GAS UI) → postMessage → 模擬 Android 藍牙橋接
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startHarness } = require('./harness');

/** 注入到外殼頁（只在 top frame）的假 Android 橋接 */
const FAKE_ANDROID = () => {
  if (window !== window.top) return;
  window.__nativeCalls = [];
  window.__printer = { name: '', address: '' };
  window.AndroidPOS = {
    getInfo: () => JSON.stringify({ app_version: 'test', version_code: 1, printer: window.__printer, bluetooth: true }),
    call: (id, method, paramsJson) => {
      const params = JSON.parse(paramsJson);
      window.__nativeCalls.push({ id, method, params });
      setTimeout(() => {
        let ok = true, result = {};
        if (method === 'listPrinters') result = { devices: [{ name: 'CP-Q3', address: '00:11:22:33:44:55' }, { name: 'XP-58', address: 'AA:BB:CC:DD:EE:FF' }] };
        else if (method === 'setPrinter') { window.__printer = { name: params.name, address: params.address }; result = { printer: window.__printer }; }
        else if (method === 'print') {
          if (!window.__printer.address) { ok = false; result = '尚未選擇藍牙出單機'; }
          else result = { printer: window.__printer.name, bytes: 1234 };
        } else if (method === 'openDrawer') result = { printer: window.__printer.name };
        window.MPOSNative.onResult(id, ok, typeof result === 'string' ? result : JSON.stringify(result));
      }, 30);
    },
  };
};

let h, browser;
test.before(async () => {
  h = await startHarness({ now: () => new Date('2026-07-04T02:00:00Z') });
  browser = await chromium.launch();
});
test.after(async () => { await browser?.close(); h?.close(); });

async function openShell(withNative) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  if (withNative) await ctx.addInitScript(FAKE_ANDROID);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(h.shellUrl);
  await page.waitForFunction(() => window.MPOS_SHELL && window.MPOS_SHELL.gasReady, null, { timeout: 15000 });
  const frame = page.frames().find((f) => f.url().startsWith(h.gasUrl));
  assert.ok(frame, '找不到 GAS iframe');
  await frame.waitForFunction(() => window.__MPOS_READY__ === true);
  return { ctx, page, frame, errors };
}

test('外殼載入 GAS、跨網域 postMessage 握手、選擇藍牙出單機、結帳並列印', async () => {
  const { ctx, page, frame, errors } = await openShell(true);
  await frame.waitForFunction(() => document.getElementById('bridgeChip').innerText.includes('尚未選擇'));

  // 進設定（需管理密碼）→ 抓藍牙裝置 → 設為出單機
  await frame.click('button[data-tab="settings"]');
  await frame.fill('#pinInput', '0000');
  await frame.click('#pinOverlay .blue-btn');
  await frame.waitForFunction(() => document.getElementById('pinMsg').innerText.includes('錯誤'));
  await frame.fill('#pinInput', '1234');
  await frame.click('#pinOverlay .blue-btn');
  await frame.waitForSelector('#tab-settings.active');
  await frame.waitForFunction(() => document.querySelectorAll('#btDeviceSelect option').length === 2);
  await frame.selectOption('#btDeviceSelect', '00:11:22:33:44:55');
  await frame.click('text=設為出單機');
  await frame.waitForFunction(() => document.getElementById('bridgeChip').innerText.includes('CP-Q3'));

  // 回到 POS 點餐 → 結帳 $100 → 結帳並列印
  await frame.click('button[data-tab="pos"]');
  await frame.click('.item-btn[data-id="custard"]');
  await frame.click('.item-btn[data-id="custard"]');
  await frame.click('.note-chip >> text=先做');
  await frame.click('#checkoutBtn');
  await frame.click('.quick-cash >> text=$100');
  await frame.click('#checkoutConfirmBtn');
  await frame.waitForFunction(() => document.getElementById('posMsg').innerText.includes('列印成功'));

  const calls = await page.evaluate(() => window.__nativeCalls);
  const print = calls.find((c) => c.method === 'print');
  assert.ok(print, '應送出 print 給 Android');
  assert.equal(print.params.job.order_no, '202607040001');
  assert.equal(print.params.job.ean13, '2000007040014');
  assert.ok(print.params.job.lines.some((l) => l.text === '找零：10 元'));
  assert.ok(print.params.job.lines.some((l) => l.text === '先做'));

  // 後端已記錄列印時間
  const orders = JSON.parse(JSON.stringify(h.g.apiOrders('2026-07-04'))).orders;
  assert.equal(orders.length, 1);
  assert.ok(orders[0].printed_at);

  // 今日訂單 → 完成
  await frame.click('button[data-tab="orders"]');
  await frame.waitForSelector('#ordersArea .ok-btn');
  frame.page().once('dialog', (d) => d.accept());
  await frame.click('#ordersArea .ok-btn');
  await frame.waitForFunction(() => document.querySelector('#ordersArea .badge.completed'));

  assert.deepEqual(errors, []);
  await ctx.close();
});

test('一般瀏覽器（沒有 Android App）：可開單，列印失敗時提示補印', async () => {
  const { ctx, frame, errors } = await openShell(false);
  await frame.waitForFunction(() => document.getElementById('bridgeChip').innerText.includes('網頁外殼'));
  await frame.click('.item-btn[data-id="cheese"]');
  await frame.click('#checkoutBtn');
  await frame.click('#checkoutConfirmBtn'); // 未輸入收款 → 視為剛好
  await frame.waitForFunction(() => document.getElementById('posMsg').innerText.includes('補印'));
  assert.match(await frame.innerText('#posMsg'), /不是在 Android App 內/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('查詢頁 ?page=lookup&q=EAN13', async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(h.gasUrl + '?page=lookup&q=2000007040014');
  await page.waitForFunction(() => document.getElementById('msg').innerText.includes('查詢成功'));
  assert.match(await page.innerText('#result'), /卡士達/);
  await ctx.close();
});
