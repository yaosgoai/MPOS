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

/** 新增訂購時先選訂單來源 */
async function pickSource(frame, name) {
  await frame.waitForSelector('#sourceOverlay.show');
  await frame.click('#sourceArea .source-btn >> text=' + name);
  await frame.waitForSelector('#orderOverlay.show');
}
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

  // 回到 POS 點餐 → 結帳 $500 → 結帳並列印
  await frame.click('button[data-tab="pos"]');
  assert.equal(await frame.isVisible('#menuArea'), false, '主畫面不應直接顯示商品');
  await frame.click('#newOrderBtn');
  await pickSource(frame, '來電點餐');
  await frame.waitForSelector('#orderOverlay.show');
  // 項目 1：卡士達 x2，此項備註「先做」
  await frame.click('.item-btn[data-id="custard"]');
  await frame.click('.item-btn[data-id="custard"]');
  assert.equal(await frame.innerText('#pickerQtyNum'), '2');
  await frame.click('.note-chip >> text=先做');
  assert.match(await frame.innerText('#pickerTotal'), /90 元/);
  await frame.click('#pickerMoreBtn'); // 加入並繼續點
  await frame.waitForSelector('#orderOverlay.show');
  assert.equal(await frame.locator('.note-chip.active').count(), 0, '新項目的備註要重新選');
  // 項目 2：茶凍 x1，此項備註「分開裝」
  await frame.click('.item-btn[data-id="tea_jelly"]');
  await frame.click('.note-chip >> text=分開裝');
  await frame.click('#pickerDoneBtn');
  assert.equal(await frame.isVisible('#orderOverlay'), false);
  assert.equal(await frame.locator('#cartArea .cart-row').count(), 2);
  assert.match(await frame.innerText('#cartArea'), /※ 先做[\s\S]*※ 分開裝/);
  assert.match(await frame.innerText('#totalValue'), /120 元/);
  // 修改項目 2：數量 +1
  await frame.click('#cartArea .cart-line >> nth=1');
  await frame.waitForSelector('#orderOverlay.show');
  assert.equal(await frame.innerText('#pickerTitle'), '修改訂購項目');
  await frame.click('.picker-qty .qty-btn:not(.minus)');
  await frame.click('#pickerDoneBtn');
  assert.match(await frame.innerText('#totalValue'), /150 元/);
  await frame.fill('#orderNoteInput', '王先生 18:30 取餐');
  await frame.click('#checkoutBtn');
  await frame.click('.quick-cash >> text=$500');
  await frame.click('#checkoutConfirmBtn');
  await frame.waitForFunction(() => document.getElementById('posMsg').innerText.includes('列印成功'));

  const calls = await page.evaluate(() => window.__nativeCalls);
  const print = calls.find((c) => c.method === 'print');
  assert.ok(print, '應送出 print 給 Android');
  assert.equal(print.params.job.order_no, '202607040001');
  assert.equal(print.params.job.ean13, '2000007040014');
  const texts = print.params.job.lines.map((l) => l.text);
  assert.ok(texts.includes('找零：350 元'), texts.join('|'));
  assert.equal(texts[texts.indexOf('卡士達') + 1], '  ※先做');
  assert.equal(texts[texts.indexOf('茶凍') + 1], '  ※分開裝');
  assert.ok(texts.includes('王先生 18:30 取餐'));
  assert.ok(texts.includes('來源：來電點餐'));

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
  await frame.click('#newOrderBtn');
  await pickSource(frame, '現場點餐');
  await frame.click('.item-btn[data-id="cheese"]');
  await frame.click('#pickerDoneBtn');
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

test('RWD：手機直式 / 橫式、平板直式 / 橫式不超出畫面', async () => {
  for (const [w, hh] of [[412, 880], [880, 412], [800, 1280], [1280, 800]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: hh }, isMobile: w < 1000, hasTouch: true });
    const page = await ctx.newPage();
    await page.goto(h.shellUrl);
    await page.waitForFunction(() => window.MPOS_SHELL && window.MPOS_SHELL.gasReady);
    const frame = page.frames().find((f) => f.url().startsWith(h.gasUrl));
    await frame.waitForFunction(() => window.__MPOS_READY__ === true);
    await frame.click('#newOrderBtn');
    await pickSource(frame, '現場點餐');
    await frame.click('.item-btn[data-id="custard"]');
    const foot = await frame.evaluate(() => document.getElementById('pickerDoneBtn').getBoundingClientRect().bottom);
    assert.ok(foot <= hh, `${w}x${hh} 新增訂購按鈕超出畫面`);
    await frame.click('#pickerDoneBtn');
    await frame.click('#checkoutBtn');
    const r = await frame.evaluate(() => ({
      btn: document.getElementById('checkoutConfirmBtn').getBoundingClientRect().bottom,
      sw: document.documentElement.scrollWidth, vw: innerWidth,
    }));
    assert.ok(r.btn <= hh, `${w}x${hh} 結帳並列印按鈕超出畫面 (${r.btn})`);
    assert.ok(r.sw <= r.vw + 1, `${w}x${hh} 出現水平捲軸`);
    await ctx.close();
  }
});

/** 模擬 App 注入到 GAS iframe 的條碼模組原生橋接（WebViewScanBridge → window.BarcodeBridge） */
const FAKE_SCANNER = () => {
  if (window === window.top) return;
  window.__scanRequests = [];
  window.__nextScan = { status: 'ok', text: '2000007040014', format: 'ean_13', engine: 'mlkit' };
  window.BarcodeBridge = {
    onmessage: null,
    postMessage(json) {
      const req = JSON.parse(json);
      window.__scanRequests.push(req);
      setTimeout(() => {
        const res = Object.assign({ t: 'barcode-result', v: 1, id: req.id }, window.__nextScan);
        if (this.onmessage) this.onmessage({ data: JSON.stringify(res) });
      }, 20);
    },
  };
};

test('條碼輸入：所有輸入欄位都有掃描按鈕，掃描結果帶回欄位（呼叫條碼模組）', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(FAKE_ANDROID);
  await ctx.addInitScript(FAKE_SCANNER);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(h.shellUrl);
  await page.waitForFunction(() => window.MPOS_SHELL && window.MPOS_SHELL.gasReady);
  const frame = page.frames().find((f) => f.url().startsWith(h.gasUrl));
  await frame.waitForFunction(() => window.__MPOS_READY__ === true && typeof BarcodeScan === 'object');

  // 所有可輸入的欄位旁都有掃描按鈕（密碼、隱藏欄位、日期、版型表格除外）
  const missing = await frame.evaluate(() => Array.from(document.querySelectorAll('input,textarea'))
    .filter((el) => !['password', 'hidden', 'date', 'checkbox'].includes(el.type) && !el.closest('[data-noscan]'))
    .filter((el) => !(el.parentNode.classList.contains('scan-wrap') && el.parentNode.querySelector('.scan-btn')))
    .map((el) => el.id || el.name || el.outerHTML.slice(0, 60)));
  assert.deepEqual(missing, []);
  assert.equal(await frame.locator('#pinInput + .scan-btn').count(), 0, '密碼欄不應有掃描按鈕');

  // 整張訂單備註（textarea）：掃描後帶回
  await frame.click('#orderNoteInput + .scan-btn');
  await frame.waitForFunction(() => document.getElementById('orderNoteInput').value === '2000007040014');
  // 再掃一次：textarea 換行附加
  await frame.evaluate(() => { window.__nextScan = { status: 'ok', text: 'ABC-123', format: 'code_128', engine: 'mlkit' }; });
  await frame.click('#orderNoteInput + .scan-btn');
  await frame.waitForFunction(() => document.getElementById('orderNoteInput').value === '2000007040014\nABC-123');

  // 新增訂購視窗內的此項備註
  await frame.click('#newOrderBtn');
  await pickSource(frame, '現場點餐');
  await frame.click('#lineNoteInput + .scan-btn');
  await frame.waitForFunction(() => document.getElementById('lineNoteInput').value === 'ABC-123');
  await frame.click('#orderOverlay .checkout-close');

  // 今日訂單：掃描小票 EAN13 → 自動查詢
  const o = JSON.parse(JSON.stringify(h.g.apiCreateOrder({ order_source: '現場點餐', items: [{ id: 'cheese', qty: 1 }], print: false }))).order;
  await frame.evaluate((code) => { window.__nextScan = { status: 'ok', text: code, format: 'ean_13', engine: 'mlkit' }; },
    h.g.barcodeNoToEan13(o.barcode_no));
  await frame.click('button[data-tab="orders"]');
  await frame.click('#lookupInput + .scan-btn');
  await frame.waitForFunction((no) => document.getElementById('lookupMsg').innerText.includes('查詢成功：' + no), o.order_no);

  // 數字欄位：非數字內容不帶入
  await frame.click('button[data-tab="admin"]');
  await frame.fill('#pinInput', '1234');
  await frame.click('#pinOverlay .blue-btn');
  await frame.waitForSelector('#tab-admin.active');
  await frame.evaluate(() => { window.__nextScan = { status: 'ok', text: 'XYZ', format: 'code_128', engine: 'mlkit' }; });
  await frame.click('#mPrice + .scan-btn');
  await frame.waitForFunction(() => document.getElementById('toast').innerText.includes('不是數字'));
  assert.equal(await frame.inputValue('#mPrice'), '0');
  await frame.evaluate(() => { window.__nextScan = { status: 'ok', text: '4006381333931', format: 'ean_13', engine: 'mlkit' }; });
  await frame.click('#mName + .scan-btn');
  await frame.waitForFunction(() => document.getElementById('mName').value === '4006381333931');

  // 取消掃描：欄位不變
  await frame.evaluate(() => { window.__nextScan = { status: 'cancel' }; });
  await frame.click('#mCategory + .scan-btn');
  await page.waitForTimeout(200);
  assert.equal(await frame.inputValue('#mCategory'), '');

  const reqs = await frame.evaluate(() => window.__scanRequests);
  assert.ok(reqs.length >= 7 && reqs.every((r) => r.t === 'barcode-scan' && r.v === 1 && r.confirm === true && /^[0-9a-f]{32}$/.test(r.id)));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('條碼輸入：一般瀏覽器（沒有 App）改開 GitHub Pages 掃描頁新視窗', async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(h.shellUrl);
  await page.waitForFunction(() => window.MPOS_SHELL && window.MPOS_SHELL.gasReady);
  const frame = page.frames().find((f) => f.url().startsWith(h.gasUrl));
  await frame.waitForFunction(() => window.__MPOS_READY__ === true);
  await frame.waitForFunction(() => Bridge.info && Bridge.info.shell_url);
  const popupP = ctx.waitForEvent('page');
  await frame.click('#orderNoteInput + .scan-btn');
  const popup = await popupP;
  assert.match(popup.url(), /\/barcode\/scan\.html\?id=[0-9a-f]{32}&origin=/);
  await popup.close();
  await ctx.close();
});

async function openPos(withNative, extraInit) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  if (withNative) await ctx.addInitScript(FAKE_ANDROID);
  if (extraInit) await ctx.addInitScript(extraInit);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(h.shellUrl);
  return { ctx, page, errors, frame: await waitPos(page) };
}
async function waitPos(page) {
  await page.waitForFunction(() => window.MPOS_SHELL && window.MPOS_SHELL.gasReady, null, { timeout: 15000 });
  const frame = page.frames().find((f) => f.url().startsWith(h.gasUrl));
  await frame.waitForFunction(() => window.__MPOS_READY__ === true && Draft.ready === true);
  return frame;
}
async function addLine(frame, id, qty) {
  await frame.click('#newOrderBtn');
  if (await frame.isVisible('#sourceOverlay.show')) await pickSource(frame, '現場點餐');
  await frame.waitForSelector('#orderOverlay.show');
  for (let i = 0; i < qty; i++) await frame.click('.item-btn[data-id="' + id + '"]');
  await frame.click('#pickerDoneBtn');
}
async function setPrinter(page) {
  await page.evaluate(() => { window.__printer = { name: 'CP-Q3', address: '00:11:22:33:44:55' }; });
}
const countOrders = () => JSON.parse(JSON.stringify(h.g.apiOrders(''))).orders.length;

test('結帳（不找零）：確認是否列印 → 列印並結帳 / 不列印直接結帳', async () => {
  const { ctx, page, frame, errors } = await openPos(true);
  await setPrinter(page);
  const before = countOrders();
  await addLine(frame, 'cheese', 2);
  await frame.click('#quickPayBtn');
  await frame.waitForSelector('#quickPayOverlay.show');
  assert.match(await frame.innerText('#quickPayTotal'), /90 元/);
  assert.equal(await frame.innerText('#quickPaySource'), '現場點餐');
  await frame.click('#quickPayPrintBtn');
  await frame.waitForFunction(() => document.getElementById('posMsg').innerText.includes('列印成功'));
  let calls = await page.evaluate(() => window.__nativeCalls.filter((c) => c.method === 'print'));
  assert.equal(calls.length, 1);
  assert.ok(calls[0].params.job.lines.some((l) => l.text === '來源：現場點餐'));

  await addLine(frame, 'custard', 1);
  await frame.click('#quickPayBtn');
  await frame.click('#quickPayNoPrintBtn');
  await frame.waitForFunction(() => document.getElementById('posMsg').innerText.includes('訂單已建立'));
  calls = await page.evaluate(() => window.__nativeCalls.filter((c) => c.method === 'print'));
  assert.equal(calls.length, 1, '不列印時不應送出列印');
  assert.equal(countOrders(), before + 2);
  const last = JSON.parse(JSON.stringify(h.g.apiOrders(''))).orders[0];
  assert.equal(last.total, 45);
  assert.equal(last.cash_received, 45);
  assert.equal(last.change_amount, 0);
  assert.equal(last.printed_at, '');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('重置：清空目前單據（含訂單來源與備註）', async () => {
  const { ctx, frame } = await openPos(true);
  await addLine(frame, 'cheese', 1);
  await frame.fill('#orderNoteInput', '測試備註');
  assert.equal(await frame.isVisible('#sourceBar'), true);
  await frame.click('#resetBtn');
  await frame.waitForFunction(() => document.querySelectorAll('#cartArea .cart-row').length === 0);
  assert.equal(await frame.inputValue('#orderNoteInput'), '');
  assert.equal(await frame.isVisible('#sourceBar'), false);
  await frame.click('#newOrderBtn');
  await frame.waitForSelector('#sourceOverlay.show'); // 重置後要重新選來源
  await ctx.close();
});

test('本機暫存：重新整理後還原未結帳單據；結帳成功後清除', async () => {
  const { ctx, page, frame } = await openPos(true);
  await setPrinter(page);
  const before = countOrders();
  await addLine(frame, 'tea_jelly', 3);
  await frame.fill('#orderNoteInput', '先暫存');
  await frame.dispatchEvent('#orderNoteInput', 'input');
  await page.waitForTimeout(400);
  assert.equal(countOrders(), before, '點餐過程不應上傳');
  const shellDraft = await page.evaluate(() => localStorage.getItem('mpos_draft_v1'));
  assert.ok(shellDraft && shellDraft.includes('tea_jelly'), '外殼也要有一份暫存');

  await page.reload();
  let f2 = await waitPos(page);
  assert.equal(await f2.locator('#cartArea .cart-row').count(), 1);
  assert.match(await f2.innerText('#cartArea'), /茶凍/);
  assert.equal(await f2.inputValue('#orderNoteInput'), '先暫存');
  assert.equal(await f2.innerText('#sourceName'), '現場點餐');

  await f2.click('#quickPayBtn');
  await f2.click('#quickPayPrintBtn');
  await f2.waitForFunction(() => document.getElementById('posMsg').innerText.includes('訂單已建立'));
  assert.equal(countOrders(), before + 1);
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => localStorage.getItem('mpos_draft_v1')), null);
  await page.reload();
  f2 = await waitPos(page);
  assert.equal(await f2.locator('#cartArea .cart-row').count(), 0);
  await ctx.close();
});

test('上傳失敗保留暫存，重試不會重複建單', async () => {
  const { ctx, page, frame } = await openPos(true);
  await setPrinter(page);
  const before = countOrders();
  await addLine(frame, 'cheese', 1);
  // 1) 網路中斷：伺服器沒收到
  h.ctl.failNext.add('apiCreateOrder');
  await frame.click('#quickPayBtn');
  await frame.click('#quickPayNoPrintBtn');
  await frame.waitForFunction(() => document.getElementById('posMsg').innerText.includes('仍暫存在本機'));
  assert.equal(await frame.locator('#cartArea .cart-row').count(), 1);
  assert.equal(countOrders(), before);
  // 2) 伺服器已建單但回應遺失
  h.ctl.dropResponse.add('apiCreateOrder');
  await frame.click('#quickPayBtn');
  await frame.click('#quickPayNoPrintBtn');
  await frame.waitForFunction(() => document.getElementById('posMsg').innerText.includes('連線逾時'));
  assert.equal(countOrders(), before + 1);
  // 3) 重試：同一張單只會有一筆
  await frame.click('#quickPayBtn');
  await frame.click('#quickPayNoPrintBtn');
  await frame.waitForFunction(() => document.getElementById('posMsg').innerText.includes('重送'));
  assert.equal(countOrders(), before + 1);
  assert.equal(await frame.locator('#cartArea .cart-row').count(), 0);
  await ctx.close();
});

test('後台：訂單來源管理介面，新增後可在新增訂購選到', async () => {
  const { ctx, frame } = await openPos(true);
  await frame.click('button[data-tab="admin"]');
  await frame.fill('#pinInput', '1234');
  await frame.click('#pinOverlay .blue-btn');
  await frame.click(".admin-subtab >> text=訂單來源");
  await frame.waitForSelector('#admin-sources.active');
  assert.match(await frame.innerText('#sourceAdminArea'), /現場點餐[\s\S]*來電點餐[\s\S]*Uber點餐[\s\S]*親友點餐/);
  await frame.fill('#srcName', 'LINE點餐');
  await frame.fill('#srcSort', '45');
  await frame.click("text=儲存訂單來源");
  await frame.waitForFunction(() => document.getElementById('sourceAdminArea').innerText.includes('LINE點餐'));
  await frame.click('button[data-tab="pos"]');
  await frame.click('#newOrderBtn');
  await frame.waitForSelector('#sourceOverlay.show');
  assert.deepEqual(await frame.$$eval('#sourceArea .source-btn', (b) => b.map((x) => x.innerText)),
    ['現場點餐', '來電點餐', 'Uber點餐', '親友點餐', 'LINE點餐']);
  await ctx.close();
});

test('設定：條碼輸入可選「直接帶回」（不開確認窗）', async () => {
  const { ctx, frame } = await openPos(true, FAKE_SCANNER);
  await frame.click('button[data-tab="settings"]');
  await frame.fill('#pinInput', '1234');
  await frame.click('#pinOverlay .blue-btn');
  await frame.waitForSelector('#tab-settings.active');
  await frame.selectOption('#sBarcodeConfirm', '0');
  await frame.click('text=儲存設定');
  await frame.waitForFunction(() => document.getElementById('settingsMsg').innerText.includes('設定已儲存'));
  await frame.click('button[data-tab="pos"]');
  await frame.click('#orderNoteInput + .scan-btn');
  await frame.waitForFunction(() => document.getElementById('orderNoteInput').value === '2000007040014');
  const reqs = await frame.evaluate(() => window.__scanRequests);
  assert.equal(reqs[reqs.length - 1].confirm, false);
  // 還原設定，避免影響其他測試
  h.g.apiSaveSettings('1234', { barcode_confirm: '1' });
  await ctx.close();
});
