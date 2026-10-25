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
        else if (method === 'findCallRecordings') result = { recordings: window.__recordings || [] };
        else if (method === 'playRecording') { window.__rec = { uri: params.uri, playing: true, position: 0, duration: 35000 }; result = Object.assign({ loaded: true, completed: false }, window.__rec); }
        else if (method === 'pauseRecording') { window.__rec.playing = !window.__rec.playing; result = Object.assign({ loaded: true }, window.__rec); }
        else if (method === 'seekRecording') { window.__rec.position = params.ms; result = Object.assign({ loaded: true }, window.__rec); }
        else if (method === 'recordingStatus') result = window.__rec ? Object.assign({ loaded: true }, window.__rec) : { loaded: false };
        else if (method === 'stopRecording') { window.__rec = null; result = { loaded: false }; }
        window.MPOSNative.onResult(id, ok, typeof result === 'string' ? result : JSON.stringify(result));
      }, 30);
    },
  };
};

let h, browser;

/** 後台管理 → 今日訂單（需要管理密碼時自動輸入） */
async function goAdminOrders(frame) {
  await frame.click('button[data-tab="admin"]');
  await frame.waitForFunction(() => document.getElementById('pinOverlay').classList.contains('show') || document.getElementById('tab-admin').classList.contains('active'));
  if (await frame.isVisible('#pinOverlay.show')) {
    await frame.fill('#pinInput', '1234');
    await frame.click('#pinOverlay .blue-btn');
  }
  await frame.waitForSelector('#tab-admin.active');
  await frame.click('.admin-subtab >> text=今日訂單');
  await frame.waitForSelector('#admin-orders.active');
}

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
  // 步驟 2：確認數量（預設 1）
  await frame.waitForSelector('#itemOverlay.show');
  assert.equal(await frame.isVisible('#orderOverlay'), false);
  assert.equal(await frame.inputValue('#pickerQtyNum'), '1');
  await frame.click('.picker-qty .qty-btn:not(.minus)');
  assert.equal(await frame.inputValue('#pickerQtyNum'), '2');
  assert.equal(await frame.isVisible('#lineNoteBox'), false, '單品項備註預設收合');
  await frame.click('#lineNoteToggle');
  await frame.click('.note-chip >> text=先做');
  assert.match(await frame.innerText('#pickerTotal'), /90 元/);
  await frame.click('#pickerMoreBtn'); // 加入並繼續點
  await frame.waitForSelector('#orderOverlay.show');
  assert.equal(await frame.locator('.note-chip.active').count(), 0, '新項目的備註要重新選');
  // 項目 2：茶凍 x1，此項備註「分開裝」
  await frame.waitForSelector('#orderOverlay.show');
  await frame.click('.item-btn[data-id="tea_jelly"]');
  await frame.waitForSelector('#itemOverlay.show');
  await frame.click('#lineNoteToggle');
  await frame.click('.note-chip >> text=分開裝');
  await frame.click('#pickerDoneBtn');
  assert.equal(await frame.isVisible('#orderOverlay'), false);
  assert.equal(await frame.locator('#cartArea .cart-row').count(), 2);
  assert.match(await frame.innerText('#cartArea'), /※ 先做[\s\S]*※ 分開裝/);
  assert.match(await frame.innerText('#totalValue'), /120 元/);
  assert.equal(await frame.innerText('#totalCount'), '共 2 項');
  assert.deepEqual(await frame.$$eval('#cartArea .cart-row .c-no', (x) => x.map((e) => e.innerText.trim())), ['1', '2']);
  const tops4 = await frame.$$eval('.action-row-4 .main-btn', (b) => b.map((x) => Math.round(x.getBoundingClientRect().top)));
  assert.equal(new Set(tops4).size, 1, '四個按鈕在同一列');
  // 修改項目 2：數量 +1
  assert.equal(await frame.locator('#cartArea .qty-btn').count(), 0, '主畫面不再有 +/-');
  assert.deepEqual(await frame.$$eval('#cartArea .cart-head span', (x) => x.map((e) => e.innerText.trim())), ['項次', '品名', '單價', '數量', '小計']);
  await frame.click('#cartArea .cart-row >> nth=1');   // 短按只提示，不開視窗
  assert.equal(await frame.isVisible('#itemOverlay.show'), false);
  await frame.click('#cartArea .cart-row >> nth=1', { button: 'right' });   // 長按（觸控長按 / 滑鼠右鍵）
  await frame.waitForSelector('#itemOverlay.show'); // 修改：直接開數量 / 備註視窗
  assert.equal(await frame.innerText('#itemTitle'), '修改訂購項目');
  await frame.click('.picker-qty .qty-btn:not(.minus)');
  await frame.click('#pickerDoneBtn');
  assert.match(await frame.innerText('#totalValue'), /150 元/);
  await frame.fill('#orderNoteInput', '王先生 18:30 取餐');
  await frame.click('#checkoutBtn');
  await frame.click('.quick-cash >> text=$500');
  await frame.click('#checkoutConfirmBtn');
  await frame.waitForFunction(() => (window.__posLog || '').includes('列印成功'));

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
  assert.ok(texts.includes('【來電點餐】'));

  // 後端已記錄列印時間
  const orders = JSON.parse(JSON.stringify(h.g.apiOrders('2026-07-04'))).orders;
  assert.equal(orders.length, 1);
  assert.ok(orders[0].printed_at);

  // 今日訂單 → 完成
  await goAdminOrders(frame);
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
  await frame.waitForFunction(() => (window.__posLog || '').includes('補印'));
  assert.match(await frame.innerText('#posMsg'), /不是在 Android App 內/);  // 錯誤仍顯示訊息框
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
    .filter((el) => !['password', 'hidden', 'date', 'checkbox'].includes(el.type) && !el.closest('[data-noscan]') && el.dataset.scanLongpress === undefined)
    .filter((el) => !(el.parentNode.classList.contains('scan-wrap') && el.parentNode.querySelector('.scan-btn')))
    .map((el) => el.id || el.name || el.outerHTML.slice(0, 60)));
  assert.deepEqual(missing, []);
  assert.equal(await frame.locator('#pinInput + .scan-btn').count(), 0, '密碼欄不應有掃描按鈕');

  // 整張訂單備註（textarea）：掃描後帶回
  await frame.click('#orderNoteInput', { button: 'right' });
  await frame.waitForFunction(() => document.getElementById('orderNoteInput').value === '2000007040014');
  // 再掃一次：textarea 換行附加
  await frame.evaluate(() => { window.__nextScan = { status: 'ok', text: 'ABC-123', format: 'code_128', engine: 'mlkit' }; });
  await frame.click('#orderNoteInput', { button: 'right' });
  await frame.waitForFunction(() => document.getElementById('orderNoteInput').value === '2000007040014\nABC-123');

  // 新增訂購視窗內的此項備註
  await frame.click('#newOrderBtn');
  await pickSource(frame, '現場點餐');
  await frame.click('.item-btn[data-id="cheese"]');
  await frame.waitForSelector('#itemOverlay.show');
  await frame.click('#lineNoteToggle');
  await frame.click('#lineNoteInput + .scan-btn');
  await frame.waitForFunction(() => document.getElementById('lineNoteInput').value === 'ABC-123');
  await frame.evaluate(() => closeItemDialog());

  // 今日訂單：掃描小票 EAN13 → 自動查詢
  const o = JSON.parse(JSON.stringify(h.g.apiCreateOrder({ order_source: '現場點餐', items: [{ id: 'cheese', qty: 1 }], print: false }))).order;
  await frame.evaluate((code) => { window.__nextScan = { status: 'ok', text: code, format: 'ean_13', engine: 'mlkit' }; },
    h.g.barcodeNoToEan13(o.barcode_no));
  await goAdminOrders(frame);
  await frame.click('#lookupInput + .scan-btn');
  await frame.waitForFunction((no) => document.getElementById('lookupMsg').innerText.includes('查詢成功：' + no), o.order_no);

  // 數字欄位：非數字內容不帶入
  await frame.click('.admin-subtab >> text=商品管理');
  await frame.waitForSelector('#admin-products.active');
  await frame.evaluate(() => { window.__nextScan = { status: 'ok', text: 'XYZ', format: 'code_128', engine: 'mlkit' }; });
  await frame.click('#mPrice + .scan-btn');
  await frame.waitForFunction(() => document.getElementById('toast').innerText.includes('不是數字'));
  assert.equal(await frame.inputValue('#mPrice'), '0');
  await frame.evaluate(() => { window.__nextScan = { status: 'ok', text: '4006381333931', format: 'ean_13', engine: 'mlkit' }; });
  await frame.click('#mName + .scan-btn');
  await frame.waitForFunction(() => document.getElementById('mName').value === '4006381333931');

  // 取消掃描：欄位不變
  await frame.evaluate(() => { window.__nextScan = { status: 'cancel' }; });
  await frame.click('#mBarcode + .scan-btn');
  await page.waitForTimeout(200);
  assert.equal(await frame.inputValue('#mBarcode'), '');

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
  await frame.click('#orderNoteInput', { button: 'right' });
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
  await frame.click('.item-btn[data-id="' + id + '"]');
  await frame.waitForSelector('#itemOverlay.show');
  for (let i = 1; i < qty; i++) await frame.click('.picker-qty .qty-btn:not(.minus)');
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
  await frame.evaluate(() => openQuickPay('pay'));   // 直接結帳已從主畫面移除，流程保留
  await frame.waitForSelector('#quickPayOverlay.show');
  assert.match(await frame.innerText('#quickPayTotal'), /90 元/);
  assert.equal(await frame.innerText('#quickPaySource'), '現場點餐');
  await frame.click('#quickPayPrintBtn');
  await frame.waitForFunction(() => (window.__posLog || '').includes('列印成功'));
  let calls = await page.evaluate(() => window.__nativeCalls.filter((c) => c.method === 'print'));
  assert.equal(calls.length, 1);
  assert.ok(calls[0].params.job.lines.some((l) => l.text === '【現場點餐】'));

  await addLine(frame, 'custard', 1);
  await frame.evaluate(() => openQuickPay('pay'));   // 直接結帳已從主畫面移除，流程保留
  await frame.click('#quickPayNoPrintBtn');
  await frame.waitForFunction(() => (window.__posLog || '').includes('訂單已建立'));
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
  assert.equal(await frame.innerText('#sourceName'), '現場點餐');
  await frame.click('#resetBtn');
  await frame.waitForFunction(() => document.querySelectorAll('#cartArea .cart-row').length === 0);
  assert.equal(await frame.inputValue('#orderNoteInput'), '');
  assert.equal((await frame.innerText('#newOrderBtn')).replace(/\s/g, ''), '＋訂單來源');
  assert.equal(await frame.isVisible('#posMsg'), false, '重新訂單後不顯示訊息框');
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

  await f2.evaluate(() => openQuickPay('pay'));
  await f2.click('#quickPayPrintBtn');
  await f2.waitForFunction(() => (window.__posLog || '').includes('訂單已建立'));
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
  await frame.evaluate(() => openQuickPay('pay'));   // 直接結帳已從主畫面移除，流程保留
  await frame.click('#quickPayNoPrintBtn');
  await frame.waitForFunction(() => (window.__posLog || '').includes('仍暫存在本機'));
  assert.equal(await frame.locator('#cartArea .cart-row').count(), 1);
  assert.equal(countOrders(), before);
  // 2) 伺服器已建單但回應遺失
  h.ctl.dropResponse.add('apiCreateOrder');
  await frame.evaluate(() => openQuickPay('pay'));   // 直接結帳已從主畫面移除，流程保留
  await frame.click('#quickPayNoPrintBtn');
  await frame.waitForFunction(() => (window.__posLog || '').includes('連線逾時'));
  assert.equal(countOrders(), before + 1);
  // 3) 重試：同一張單只會有一筆
  await frame.evaluate(() => openQuickPay('pay'));   // 直接結帳已從主畫面移除，流程保留
  await frame.click('#quickPayNoPrintBtn');
  await frame.waitForFunction(() => (window.__posLog || '').includes('重送'));
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
  await frame.click('#orderNoteInput', { button: 'right' });
  await frame.waitForFunction(() => document.getElementById('orderNoteInput').value === '2000007040014');
  const reqs = await frame.evaluate(() => window.__scanRequests);
  assert.equal(reqs[reqs.length - 1].confirm, false);
  // 還原設定，避免影響其他測試
  h.g.apiSaveSettings('1234', { barcode_confirm: '1' });
  await ctx.close();
});

test('版面：標題列不顯示地址與訂購專線', async () => {
  const { ctx, frame } = await openPos(true);
  assert.equal(await frame.isVisible('#shopAddressHeader'), false);
  assert.equal(await frame.isVisible('#shopPhoneHeader'), false);
  await ctx.close();
});

test('掛單（未付款）→ 訂單條碼叫回 → 找零結帳（同一單號）；已付款訂單只能檢視 / 補印', async () => {
  const { ctx, page, frame, errors } = await openPos(true);
  await setPrinter(page);
  await addLine(frame, 'custard', 2);
  await frame.click('#holdBtn');
  await frame.waitForSelector('#quickPayOverlay.show');
  assert.equal(await frame.innerText('#quickPayTitle'), '訂單暫存（未付款）');
  await frame.click('#quickPayPrintBtn');
  await frame.waitForFunction(() => (window.__posLog || '').includes('已暫存訂單'));
  const held = JSON.parse(JSON.stringify(h.g.apiOrders(''))).orders[0];
  assert.equal(held.pay_status, 'unpaid');
  const job = (await page.evaluate(() => window.__nativeCalls.filter((c) => c.method === 'print'))).pop().params.job;
  assert.ok(job.lines.some((l) => l.text === '付款狀態：未付款（取餐時付款）'));

  // 刷取餐單條碼叫回
  await frame.fill('#orderCodeInput', h.g.barcodeNoToEan13(held.barcode_no));
  await frame.press('#orderCodeInput', 'Enter');
  await frame.waitForFunction(() => document.getElementById('loadedOrderTag').innerText.includes('未付款'));
  assert.match(await frame.innerText('#cartArea'), /卡士達/);
  await addLine(frame, 'tea_jelly', 1);
  await frame.click('#checkoutBtn');
  await frame.click('.quick-cash >> text=$500');
  await frame.click('#checkoutConfirmBtn');
  await frame.waitForFunction(() => (window.__posLog || '').includes('訂單已結帳'));
  const paid = JSON.parse(JSON.stringify(h.g.apiLookup(held.order_no))).order;
  assert.equal(paid.pay_status, 'paid');
  assert.equal(paid.total, 120);
  assert.equal(paid.change_amount, 380);
  assert.equal(await frame.isVisible('#loadedOrderTag'), false);

  // 已付款：顯示內容 + 補印，不帶回 POS
  await frame.fill('#orderCodeInput', held.order_no);
  await frame.click('.pos-bar .code-btn');
  await frame.waitForSelector('#infoOverlay.show');
  assert.match(await frame.innerText('#infoBody'), /已付款[\s\S]*茶凍/);
  assert.equal(await frame.locator('#cartArea .cart-row').count(), 0);
  await frame.click('#infoOverlay .checkout-close');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('來電：清單顯示、長按新增來電點餐（記錄電話 / 名稱）、再次來電顯示名稱、查歷史並再訂一次', async () => {
  const { ctx, page, frame, errors } = await openPos(true);
  await setPrinter(page);
  const call = (phone) => page.evaluate((p) => window.MPOSNative.onEvent('incoming_call', JSON.stringify({ phone: p })), phone);
  await call('+886912000111');
  await frame.waitForFunction(() => document.querySelectorAll('#callList .call-chip').length >= 1);
  const chip = frame.locator('#callList .call-chip', { hasText: '0912-000-111' });
  assert.match(await chip.innerText(), /未命名/);

  // 長按 → 新增來電點餐（名稱可空白，這裡先填）
  await chip.click({ button: 'right' });
  await frame.waitForSelector('#callOverlay.show');
  await frame.fill('#callNameInput', '陳小姐');
  await frame.click('#callNewOrderBtn');
  await frame.waitForSelector('#orderOverlay.show');
  assert.equal(await frame.innerText('#sourceName'), '來電點餐');
  assert.equal(await frame.innerText('#customerPhoneText'), '0912-000-111');
  await frame.click('.item-btn[data-id="cheese"]');
  await frame.click('.picker-qty .qty-btn:not(.minus)');
  await frame.click('#pickerDoneBtn');
  await frame.click('#holdBtn');
  await frame.click('#quickPayNoPrintBtn');
  await frame.waitForFunction(() => (window.__posLog || '').includes('已暫存訂單'));
  const o = JSON.parse(JSON.stringify(h.g.apiOrders(''))).orders[0];
  assert.deepEqual([o.order_source, o.customer_phone, o.customer_name, o.pay_status], ['來電點餐', '0912000111', '陳小姐', 'unpaid']);

  // 再次來電：顯示客戶名稱
  await call('0912000111');
  await frame.waitForFunction(() => /陳小姐/.test(document.getElementById('callList').innerText));
  // 長按 → 查詢歷史交易品項 → 再訂一次
  await frame.locator('#callList .call-chip', { hasText: '陳小姐' }).click({ button: 'right' });
  await frame.click('#callHistoryBtn');
  await frame.waitForSelector('#infoOverlay.show');
  assert.match(await frame.innerText('#infoBody'), /起司 ×2/);
  await frame.click('#infoBody .hist-order .small-btn');
  await frame.waitForFunction(() => document.querySelectorAll('#cartArea .cart-row').length === 1);
  assert.match(await frame.innerText('#cartArea'), /起司/);
  assert.equal(await frame.inputValue('#customerNameInput'), '陳小姐');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('版面：主畫面不顯示說明文字；分頁為 POS 點餐 / 來電記錄 / 後台管理 / 設定，今日訂單在後台管理內', async () => {
  const { ctx, frame } = await openPos(true);
  assert.equal(await frame.locator('#tab-pos .hint', { hasText: '暫存在本機' }).count(), 0);
  assert.deepEqual(await frame.$$eval('.tabs .tab-btn', (b) => b.map((x) => x.innerText.trim())), ['POS 點餐', '來電記錄', '後台管理', '設定']);
  await goAdminOrders(frame);
  assert.equal((await frame.$$eval('.admin-subtab', (b) => b.map((x) => x.innerText.trim())))[0], '今日訂單');
  await ctx.close();
});

test('來電記錄分頁：列出來電，長按記錄新增來電點餐並帶入電話', async () => {
  h.g.apiRegisterCall('0988777666');
  h.g.apiSaveCustomer('0988777666', '林先生');
  const { ctx, page, frame, errors } = await openPos(true);
  await frame.click('button[data-tab="calls"]');
  await frame.waitForSelector('#tab-calls.active');
  const row = frame.locator('#callLogArea .call-log-row', { hasText: '0988-777-666' }).first();
  await row.waitFor();
  assert.match(await row.innerText(), /林先生/);
  await row.click({ button: 'right' }); // 長按（觸控長按 / 滑鼠右鍵）
  await frame.waitForSelector('#callOverlay.show');
  await frame.click('#callNewOrderBtn');
  await frame.waitForSelector('#orderOverlay.show');
  assert.equal(await frame.isVisible('#tab-pos.active'), true);
  assert.equal(await frame.innerText('#sourceName'), '來電點餐');
  assert.equal(await frame.innerText('#customerPhoneText'), '0988-777-666');
  assert.equal(await frame.inputValue('#customerNameInput'), '林先生');

  // 有新來電時，來電記錄頁會自動更新
  await frame.click('#orderOverlay .checkout-close');
  await frame.click('button[data-tab="calls"]');
  await frame.locator('#callLogArea .call-log-row').first().waitFor();
  const before = await frame.locator('#callLogArea .call-log-row').count();
  await page.evaluate(() => window.MPOSNative.onEvent('incoming_call', JSON.stringify({ phone: '0911222333' })));
  await frame.waitForFunction((n) => document.querySelectorAll('#callLogArea .call-log-row').length === n + 1, before);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('v1.5 版面：標題不顯示版本 / 藍牙（移到設定）、來電列沒有＋、訂單來源併入目前訂單、＋新購', async () => {
  const { ctx, frame, errors } = await openPos(true);
  assert.equal(await frame.locator('header #bridgeChip').count(), 0);
  assert.doesNotMatch(await frame.innerText('header'), /cloud-|藍牙/);
  assert.equal(await frame.locator('#tab-settings #bridgeChip').count(), 1);
  assert.equal(await frame.locator('#tab-settings #gasVersionText').count(), 1);
  assert.equal(await frame.locator('.call-bar button.call-add').count(), 0);
  assert.equal((await frame.innerText('#newOrderBtn')).replace(/\s/g, ''), '＋訂單來源');
  await frame.click('#newOrderBtn');
  await pickSource(frame, '來電點餐');
  await frame.click('#orderOverlay .checkout-close');
  // 上方一列：來源 + 訂單條碼 + 新購；沒有「訂單」標題
  assert.equal(await frame.locator('.pos-title').count(), 0);
  const tops = await frame.evaluate(() => ['orderCodeInput', 'newOrderBtn'].map((id) => { const r = document.getElementById(id).getBoundingClientRect(); return Math.round(r.top + r.height / 2); }));
  assert.ok(Math.max(...tops) - Math.min(...tops) <= 4, '來源、訂單條碼、新購要在同一列 ' + tops);
  // 備註：沒有標題、沒有掃描按鈕（長按掃描）
  assert.equal(await frame.locator('#tab-pos h2', { hasText: '整張訂單備註' }).count(), 0);
  assert.equal(await frame.locator('#orderNoteInput + .scan-btn').count(), 0);
  const yNote = await frame.evaluate(() => document.getElementById('orderNoteInput').getBoundingClientRect().bottom);
  const yTotal = await frame.evaluate(() => document.querySelector('#tab-pos .total-box').getBoundingClientRect().top);
  assert.ok(yNote <= yTotal, '整張訂單備註要在總金額上方');
  assert.match(await frame.innerText('.pos-bar'), /來電點餐/);
  await frame.click('#newOrderBtn', { button: 'right' });   // 長按：變更訂單來源
  await frame.waitForSelector('#sourceOverlay.show');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('v1.5 POS 剛好一頁：手機自動縮放不需上下捲動；可手動設定縮放比例', async () => {
  for (const [w, hh] of [[393, 760], [360, 640], [412, 915], [800, 1280]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: hh }, isMobile: true, hasTouch: true });
    await ctx.addInitScript(FAKE_ANDROID);
    const page = await ctx.newPage();
    await page.goto(h.shellUrl);
    const frame = await waitPos(page);
    // 有客戶列 + 多個品項時仍是一頁
    await frame.evaluate(() => { customerPhone = '0910670803'; renderCart(); });
    for (let i = 0; i < 6; i++) await frame.evaluate(() => { cart.push({ key: 'L' + (++lineSeq), id: 'custard', name: '卡士達', price: 35, qty: 1, notes: [], custom: '' }); renderCart(); });
    await frame.waitForTimeout(100);
    const r = await frame.evaluate(() => {
      const se = document.scrollingElement || document.documentElement;
      const btn = document.getElementById('resetBtn').getBoundingClientRect();
      return { sh: se.scrollHeight, ih: innerHeight, sy: se.scrollHeight - se.clientHeight, zoom: curZoom, btnBottom: btn.bottom * curZoom, newBtn: document.getElementById('newOrderBtn').getBoundingClientRect().top };
    });
    assert.ok(r.sy <= 1, `${w}x${hh} 頁面可上下捲動 (${r.sh} > ${r.ih})`);
    assert.ok(r.btnBottom <= hh + 1, `${w}x${hh} 下方按鈕超出畫面 (${r.btnBottom}) zoom=${r.zoom}`);
    assert.ok(r.zoom <= 1 && r.zoom >= 0.55, `zoom=${r.zoom}`);
    await ctx.close();
  }
  // 手動 80%
  const { ctx, frame } = await openPos(true);
  await frame.click('button[data-tab="settings"]');
  await frame.fill('#pinInput', '1234');
  await frame.click('#pinOverlay .blue-btn');
  await frame.waitForSelector('#tab-settings.active');
  await frame.selectOption('#uiZoomSelect', '0.8');
  assert.equal(await frame.evaluate(() => curZoom), 0.8);
  assert.equal(await frame.innerText('#uiZoomNow'), '80%');
  await frame.click('.zoom-now button >> text=＋');
  assert.equal(await frame.evaluate(() => curZoom), 0.85);
  await ctx.close();
});

test('v1.5 條碼設定立即生效（不必按儲存）；訂單條碼刷完（無 Enter）直接查詢', async () => {
  const { ctx, page, frame, errors } = await openPos(true, FAKE_SCANNER);
  await setPrinter(page);
  await frame.click('button[data-tab="settings"]');
  await frame.fill('#pinInput', '1234');
  await frame.click('#pinOverlay .blue-btn');
  await frame.waitForSelector('#tab-settings.active');
  await frame.selectOption('#sBarcodeConfirm', '0');
  await frame.click('button[data-tab="pos"]');
  await frame.click('#orderNoteInput', { button: 'right' });
  await frame.waitForFunction(() => window.__scanRequests.length === 1);
  assert.equal((await frame.evaluate(() => window.__scanRequests[0])).confirm, false);
  // 重新整理後仍記得（存在外殼）
  await page.reload();
  const f2 = await waitPos(page);
  assert.equal(await f2.evaluate(() => barcodeConfirmOn()), false);

  // 掛單後，條碼槍刷 13 碼（沒有 Enter）→ 自動叫回
  await addLine(f2, 'custard', 1);
  await f2.click('#holdBtn');
  await f2.click('#quickPayPrintBtn');
  await f2.waitForFunction(() => (window.__posLog || '').includes('已暫存訂單'));
  const held = JSON.parse(JSON.stringify(h.g.apiOrders(''))).orders[0];
  await f2.fill('#orderCodeInput', h.g.barcodeNoToEan13(held.barcode_no));
  await f2.waitForFunction(() => document.getElementById('loadedOrderTag').innerText.includes('未付款'));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('v1.5 來電錄音：長按來電記錄直接播放錄音（小米通話錄音），可暫停 / 停止，關閉時停止', async () => {
  h.g.apiRegisterCall('0910670803');
  const { ctx, page, frame, errors } = await openPos(true);
  await page.evaluate(() => {
    window.__recordings = [
      { uri: 'content://media/external/audio/media/77', name: '0910670803(0910670803)_20261024174233.mp3', time: Date.now(), duration: 35000, phone_match: true },
      { uri: 'content://media/external/audio/media/70', name: '0910670803(0910670803)_20261020100000.mp3', time: Date.now() - 4 * 86400000, duration: 12000, phone_match: true },
    ];
  });
  await frame.click('button[data-tab="calls"]');
  const row = frame.locator('#callLogArea .call-log-row', { hasText: '0910-670-803' }).first();
  await row.waitFor();
  await row.click({ button: 'right' });
  await frame.waitForSelector('#callOverlay.show');
  await frame.waitForSelector('#recPlayer', { state: 'visible' });
  let calls = await page.evaluate(() => window.__nativeCalls.map((c) => c.method + ':' + (c.params.uri || c.params.phone || '')));
  assert.ok(calls.includes('findCallRecordings:0910670803'));
  assert.ok(calls.includes('playRecording:content://media/external/audio/media/77'), '應自動播放最接近的錄音');
  assert.equal(await frame.locator('#recList .rec-item').count(), 2);
  await frame.click('#recPlayBtn');
  await frame.waitForFunction(() => document.getElementById('recPlayBtn').innerText === '繼續');
  // 改播另一個
  await frame.click('#recList .rec-item[data-i="1"]');
  await frame.waitForFunction(() => document.querySelector('#recList .rec-item[data-i="1"]').classList.contains('active'));
  // 關閉 → 停止播放
  await frame.click('#callOverlay .checkout-close');
  await page.waitForFunction(() => window.__nativeCalls.some((c) => c.method === 'stopRecording'));
  // 選單其他功能仍在
  await row.click({ button: 'right' });
  await frame.click('#callNewOrderBtn');
  await frame.waitForSelector('#orderOverlay.show');
  assert.equal(await frame.innerText('#customerPhoneText'), '0910-670-803');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('v1.5 來電錄音：一般瀏覽器不顯示錄音區', async () => {
  const { ctx, frame } = await openPos(false);
  await frame.evaluate(() => openCallMenu({ phone: '0910670803', phone_display: '0910-670-803', called_at: '2026-10-24 17:42:00' }, { autoplay: true }));
  assert.equal(await frame.isVisible('#recBox'), false);
  await ctx.close();
});

test('v1.6 重置：游標移到訂單條碼並清空；列印時訂單來源在最上方大字、條碼用 ESC * 點陣', async () => {
  const { ctx, page, frame, errors } = await openPos(true);
  await setPrinter(page);
  await addLine(frame, 'custard', 1);
  await frame.fill('#orderCodeInput', '12345');
  await frame.click('#resetBtn');
  await frame.waitForFunction(() => document.activeElement && document.activeElement.id === 'orderCodeInput');
  assert.equal(await frame.inputValue('#orderCodeInput'), '');
  assert.equal(await frame.evaluate(() => cartItems().length), 0);
  // 空單再按重置也一樣
  await frame.fill('#orderCodeInput', '999');
  await frame.click('#orderNoteInput');
  await frame.click('#resetBtn');
  await frame.waitForFunction(() => document.activeElement.id === 'orderCodeInput' && document.getElementById('orderCodeInput').value === '');

  await addLine(frame, 'custard', 1);
  await frame.evaluate(() => openQuickPay('pay'));   // 直接結帳已從主畫面移除，流程保留
  await frame.click('#quickPayPrintBtn');
  await page.waitForFunction(() => window.__nativeCalls.some((c) => c.method === 'print'));
  const job = (await page.evaluate(() => window.__nativeCalls.filter((c) => c.method === 'print'))).pop().params.job;
  assert.equal(job.lines[0].role, 'order_source');
  assert.match(job.lines[0].text, /^【.+】$/);
  assert.equal(job.lines[0].font_pt, 16);
  assert.equal(job.lines[1].role, 'barcode');
  assert.equal(job.printer.barcode_mode, 'escstar');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('v1.7 取消訂單：結帳後直接取消（需選誰取消 + 原因），列印取消單，後台顯示註記與退單分析', async () => {
  const { ctx, page, frame, errors } = await openPos(true);
  await setPrinter(page);
  await addLine(frame, 'custard', 2);
  await frame.evaluate(() => openQuickPay('pay'));   // 直接結帳已從主畫面移除，流程保留
  await frame.click('#quickPayPrintBtn');
  await frame.waitForSelector('#lastOrderBar', { state: 'visible' });
  const orderNo = await frame.evaluate(() => lastOrder.order_no);
  await frame.click('#lastOrderCancelBtn');
  await frame.waitForSelector('#cancelOverlay.show');
  assert.equal(await frame.inputValue('#cancelRefund'), '90', '已付款預設全額退款');
  await frame.click('#cancelConfirmBtn');
  assert.match(await frame.innerText('#cancelMsg'), /客戶取消|店家取消/);
  await frame.click('#cancelOverlay .cancel-type[data-type="customer"]');
  await frame.click('#cancelConfirmBtn');
  assert.match(await frame.innerText('#cancelMsg'), /原因/);
  await frame.click('#cancelReasons .cancel-reason >> text=等候太久');
  await frame.fill('#cancelNote', '等了 40 分鐘');
  await frame.check('#cancelPrint');
  await frame.click('#cancelConfirmBtn');
  await frame.waitForSelector('#cancelOverlay.show', { state: 'hidden' });
  await frame.waitForSelector('#lastOrderBar', { state: 'hidden' });
  const o = JSON.parse(JSON.stringify(h.g.apiLookup(orderNo))).order;
  assert.equal(o.status, 'cancelled');
  assert.equal(o.cancel_type, 'customer');
  assert.equal(o.cancel_reason, '等候太久');
  assert.equal(o.cancel_note, '等了 40 分鐘');
  assert.equal(o.cancel_refund, 90);
  await page.waitForFunction(() => window.__nativeCalls.filter((c) => c.method === 'print').some((c) => c.params.job.lines[0].text === '*** 訂單取消 ***'));

  // 後台今日訂單：已完成的單也能取消；顯示註記（只操作本測試建立的訂單，不受其他測試資料影響）
  await addLine(frame, 'tea_jelly', 1);
  await frame.evaluate(() => openQuickPay('pay'));   // 直接結帳已從主畫面移除，流程保留
  await frame.click('#quickPayNoPrintBtn');
  await frame.waitForSelector('#lastOrderBar', { state: 'visible' });
  const no2 = await frame.evaluate(() => lastOrder.order_no);
  await goAdminOrders(frame);
  const row1 = `#ordersArea tr[data-order-no="${orderNo}"]`, row2 = `#ordersArea tr[data-order-no="${no2}"]`;
  await frame.waitForSelector(row1 + ' .cancel-tag');
  assert.match(await frame.innerText(row1), /客戶取消：等候太久/);
  await frame.click(row2 + ' .ok-btn');      // 完成
  await frame.waitForSelector(row2 + ' .badge.completed');
  assert.equal(await frame.locator(row2 + ' .ok-btn').count(), 0);
  await frame.click(row2 + ' .danger-btn');  // 取消已完成的單
  await frame.waitForSelector('#cancelOverlay.show');
  await frame.click('#cancelOverlay .cancel-type[data-type="store"]');
  await frame.click('#cancelReasons .cancel-reason >> text=店家缺貨');
  await frame.click('#cancelConfirmBtn');
  await frame.waitForSelector(row2 + ' .cancel-tag');
  assert.match(await frame.innerText(row2), /店家取消：店家缺貨/);
  assert.equal(JSON.parse(JSON.stringify(h.g.apiLookup(no2))).order.cancel_from, 'completed');

  // 退單分析
  await frame.click('.admin-subtab >> text=退單分析');
  await frame.waitForSelector('#cancelStatsArea .cancel-table');
  const txt = await frame.innerText('#cancelStatsArea');
  const st = JSON.parse(JSON.stringify(h.g.apiCancelStats('1234', '2000-01-01', '2100-01-01')));
  assert.ok(st.cancelled >= 2);
  assert.ok(txt.includes('退單率\n' + JSON.parse(JSON.stringify(h.g.apiCancelStats('1234', await frame.inputValue('#cancelFrom'), await frame.inputValue('#cancelTo')))).rate + '%'));
  assert.match(txt, /等候太久/);
  assert.match(txt, /店家缺貨/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('v1.7 取消訂單：叫回的掛單可取消並清空；客戶退單次數顯示在來電與歷史', async () => {
  const { ctx, page, frame, errors } = await openPos(true);
  await setPrinter(page);
  await page.evaluate(() => window.MPOSNative.onEvent('incoming_call', JSON.stringify({ phone: '0933444555' })));
  await frame.waitForSelector('#callList .call-chip');
  await frame.locator('#callList .call-chip').first().click({ button: 'right' });
  await frame.click('#callNewOrderBtn');
  await frame.waitForSelector('#orderOverlay.show');
  await frame.click('.item-btn[data-id="custard"]');
  await frame.click('#pickerDoneBtn');
  await frame.click('#holdBtn');
  await frame.click('#quickPayPrintBtn');
  await frame.waitForFunction(() => (window.__posLog || '').includes('已暫存訂單'));
  const held = JSON.parse(JSON.stringify(h.g.apiOrders(''))).orders.find((x) => x.customer_phone === '0933444555');
  await frame.fill('#orderCodeInput', held.order_no);
  await frame.press('#orderCodeInput', 'Enter');
  await frame.waitForSelector('#cancelLoadedBtn', { state: 'visible' });
  await frame.click('#cancelLoadedBtn');
  await frame.waitForSelector('#cancelOverlay.show');
  assert.equal(await frame.isVisible('#cancelRefundRow'), false, '未付款不需退款');
  await frame.click('#cancelOverlay .cancel-type[data-type="customer"]');
  await frame.click('#cancelReasons .cancel-reason >> text=客戶未取餐');
  await frame.click('#cancelConfirmBtn');
  await frame.waitForFunction(() => (window.__posLog || '').includes('已取消'));
  assert.equal(await frame.evaluate(() => !!loadedOrder || cartItems().length > 0), false);
  assert.equal(await frame.isVisible('#cancelLoadedBtn'), false);

  // 再次來電：顯示退單次數
  await page.evaluate(() => window.MPOSNative.onEvent('incoming_call', JSON.stringify({ phone: '0933444555' })));
  await frame.waitForFunction(() => document.getElementById('callList').innerText.includes('退單1'));
  await frame.locator('#callList .call-chip').first().click({ button: 'right' });
  await frame.waitForSelector('#callWarn', { state: 'visible' });
  assert.match(await frame.innerText('#callWarn'), /退單 1 次/);
  await frame.click('#callHistoryBtn');
  await frame.waitForSelector('#infoOverlay.show');
  assert.match(await frame.innerText('#infoBody'), /退單 1 次（退單率 100%）/);
  assert.match(await frame.innerText('#infoBody'), /客戶取消：客戶未取餐/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('v1.10 ＋訂單來源 / ＋新購同一顆按鈕；訂單號碼長按：刷訂單條碼 / 帶暫存訂單；按鈕改名', async () => {
  const { ctx, page, frame, errors } = await openPos(true, FAKE_SCANNER);
  await setPrinter(page);
  assert.deepEqual(await frame.$$eval('.action-row-4 .main-btn', (b) => b.map((x) => x.innerText.trim())), ['訂單暫存', '訂單細項', '訂單結帳', '新訂單']);
  assert.equal(await frame.locator('#sourceBar').count(), 0);
  assert.equal(await frame.locator('.pos-bar .scan-btn').count(), 0, '訂單號碼旁不再有條碼按鈕');
  assert.equal((await frame.innerText('#newOrderBtn')).replace(/\s/g, ''), '＋訂單來源');
  await frame.click('#newOrderBtn');                 // 未選來源 → 先選來源，再選商品
  await pickSource(frame, '來電點餐');
  await frame.waitForSelector('#orderOverlay.show');
  await frame.click('.item-btn[data-id="custard"]');
  await frame.click('#pickerDoneBtn');
  assert.equal((await frame.innerText('#newOrderBtn')).replace(/\s/g, ''), '＋來電點餐');
  await frame.click('#newOrderBtn');                 // 已選來源 → 直接新購
  await frame.waitForSelector('#orderOverlay.show');
  await frame.click('#orderOverlay .checkout-close');
  // 訂單暫存
  await frame.click('#holdBtn');
  await frame.click('#quickPayNoPrintBtn');
  await frame.waitForFunction(() => (window.__posLog || '').includes('已暫存訂單'));
  const held = JSON.parse(JSON.stringify(h.g.apiHeldOrders(7))).orders[0];
  // 長按訂單號碼 → 帶暫存訂單
  await frame.click('#orderCodeInput', { button: 'right' });
  await frame.waitForSelector('#codeMenuOverlay.show');
  await frame.click('#codeHeldBtn');
  const row = frame.locator('#heldArea .held-row', { hasText: held.order_no });
  await row.waitFor();
  assert.match(await row.innerText(), /卡士達×1/);
  await row.click();
  await frame.waitForFunction(() => document.getElementById('loadedOrderTag').innerText.includes('暫存訂單'));
  assert.equal(await frame.evaluate(() => loadedOrder.order_no), held.order_no);
  // 重新訂單 → 全部清空、回到 ＋訂單來源
  await frame.fill('#orderCodeInput', '123');
  await frame.click('#resetBtn');
  await frame.waitForFunction(() => !cartItems().length && !loadedOrder);
  assert.equal(await frame.isVisible('#posMsg'), false);
  assert.equal(await frame.inputValue('#orderCodeInput'), '');
  assert.equal((await frame.innerText('#newOrderBtn')).replace(/\s/g, ''), '＋訂單來源');
  assert.equal(await frame.evaluate(() => cartItems().length + (loadedOrder ? 1 : 0)), 0);
  // 長按訂單號碼 → 刷訂單條碼 → 直接查詢帶回
  await frame.evaluate((code) => { window.__nextScan = { status: 'ok', text: code, format: 'ean_13', engine: 'mlkit' }; }, h.g.barcodeNoToEan13(held.barcode_no));
  await frame.click('#orderCodeInput', { button: 'right' });
  await frame.click('#codeScanBtn');
  await frame.waitForFunction((no) => loadedOrder && loadedOrder.order_no === no, held.order_no);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('v1.11 確認數量：1~9 快速鍵、＋/－、直接輸入數量（預設 1）', async () => {
  const { ctx, frame, errors } = await openPos(true);
  await frame.click('#newOrderBtn');
  await pickSource(frame, '現場點餐');
  await frame.click('.item-btn[data-id="custard"]');
  await frame.waitForSelector('#itemOverlay.show');
  assert.equal(await frame.inputValue('#pickerQtyNum'), '1');
  assert.deepEqual(await frame.$$eval('#qtyQuick .qty-quick-btn', (b) => b.map((x) => x.innerText.trim())), ['1', '2', '3', '4', '5', '6', '7', '8', '9']);
  assert.equal(await frame.getAttribute('#qtyQuick .qty-quick-btn[data-q="1"]', 'class'), 'qty-quick-btn active');
  await frame.click('#qtyQuick .qty-quick-btn[data-q="6"]');
  assert.equal(await frame.inputValue('#pickerQtyNum'), '6');
  assert.match(await frame.innerText('#pickerTotal'), /270 元/);
  await frame.click('.picker-qty .qty-btn:not(.minus)');
  assert.equal(await frame.inputValue('#pickerQtyNum'), '7');
  await frame.fill('#pickerQtyNum', '12');   // 直接輸入
  assert.match(await frame.innerText('#pickerTotal'), /540 元/);
  await frame.click('#pickerDoneBtn');
  assert.equal(await frame.evaluate(() => cartItems()[0].qty), 12);
  // 修改：開啟時顯示目前數量
  await frame.click('#cartArea .cart-row', { button: 'right' });
  assert.equal(await frame.inputValue('#pickerQtyNum'), '12');
  await frame.click('#qtyQuick .qty-quick-btn[data-q="3"]');
  await frame.click('#pickerDoneBtn');
  assert.equal(await frame.evaluate(() => cartItems()[0].qty), 3);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('v1.14 主畫面按鈕：訂單暫存 / 訂單細項 / 訂單結帳 / 新訂單；找零結帳全螢幕、關閉在右下角、即時找零', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await ctx.addInitScript(FAKE_ANDROID);
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(h.shellUrl);
  const frame = await waitPos(page);
  assert.equal(await frame.locator('#quickPayBtn').count(), 0, '直接結帳按鈕已移除');
  await addLine(frame, 'custard', 2);
  await frame.fill('#orderNoteInput', '18:30 取');
  // 訂單細項
  await frame.click('#detailBtn');
  await frame.waitForSelector('#detailOverlay.show');
  const dt = await frame.innerText('#detailBody');
  assert.match(dt, /卡士達/); assert.match(dt, /共 2 件/); assert.match(dt, /90 元/); assert.match(dt, /18:30 取/);
  await frame.click('#detailOverlay .cf-close');
  // 訂單結帳（找零）：全螢幕
  await frame.click('#checkoutBtn');
  await frame.waitForSelector('#checkoutOverlay.show');
  const box = await frame.evaluate(() => { const r = document.querySelector('#checkoutOverlay .checkout-full').getBoundingClientRect(); const c = document.querySelector('#checkoutOverlay .cf-close').getBoundingClientRect(); return { w: r.width, h: r.height, iw: innerWidth, ih: innerHeight, cr: c.right, cb: c.bottom }; });
  assert.ok(box.w >= box.iw - 1 && box.h >= box.ih - 1, '找零畫面要佔滿螢幕 ' + JSON.stringify(box));
  assert.ok(box.cr >= box.iw - 20 && box.cb >= box.ih - 20, '關閉按鈕在右下角 ' + JSON.stringify(box));
  assert.equal(await frame.locator('#checkoutOverlay .checkout-title').count(), 0);
  await page.waitForFunction(() => document.getElementById('reloadBtn').style.display === 'none');
  await frame.click('.cf-keypad .key-btn >> text=5');
  assert.match(await frame.innerText('#checkoutChange'), /還差 85 元/);
  await frame.click('.cf-keypad .key-btn >> text=00');
  assert.equal(await frame.innerText('#checkoutChange'), '410 元', '即時計算找零');
  await frame.click('#checkoutOverlay .cf-close');
  await frame.waitForSelector('#checkoutOverlay.show', { state: 'hidden' });
  await page.waitForFunction(() => document.getElementById('reloadBtn').style.display === '');
  const rb = await page.evaluate(() => { const r = document.getElementById('reloadBtn').getBoundingClientRect(); return { r: r.right, t: r.top, w: innerWidth }; });
  assert.ok(rb.r >= rb.w - 10 && rb.t <= 10, '重新整理按鈕在右上角');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('v1.15 選品項畫面最上方條碼輸入；確認數量視窗：單品項備註按鈕、重新挑選 / 繼續挑選 / 回主訂單（無右上關閉）', async () => {
  h.g.apiSaveMenuItem('1234', { id: 'tea_jelly', category: JSON.parse(JSON.stringify(h.g.apiAdminCatalog('1234'))).items.find((m) => m.id === 'tea_jelly').category, name: '茶凍', price: 30, barcode: '4710099' });
  const { ctx, frame, errors } = await openPos(true, FAKE_SCANNER);
  await frame.click('#newOrderBtn');
  await pickSource(frame, '現場點餐');
  await frame.waitForSelector('#orderOverlay.show');
  const yb = await frame.evaluate(() => [document.querySelector('#orderOverlay .item-barcode-row').getBoundingClientRect().top, document.getElementById('pickerTitle').getBoundingClientRect().top]);
  assert.ok(yb[0] < yb[1], '選品項的條碼輸入在最上方');

  // 刷條碼直接選品項
  await frame.fill('#itemBarcodeInput', '4710099');
  await frame.press('#itemBarcodeInput', 'Enter');
  await frame.waitForSelector('#itemOverlay.show');
  assert.match(await frame.innerText('#pickerItem'), /茶凍/);
  assert.equal(await frame.locator('#itemOverlay .checkout-close').count(), 0, '右上角關閉已移除');
  assert.deepEqual(await frame.$$eval('#itemOverlay .item-foot .main-btn', (b) => b.filter((x) => x.offsetParent).map((x) => x.innerText.trim())), ['重新挑選', '選定續挑', '選定離開', '回主選單']);
  await frame.click('#qtyQuick .qty-quick-btn[data-q="3"]');
  // 重新挑選：不異動訂單，回選品項畫面
  await frame.click('#pickerBackBtn');
  await frame.waitForSelector('#orderOverlay.show');
  assert.equal(await frame.evaluate(() => cartItems().length), 0, '重新挑選不異動訂單');
  await frame.waitForSelector('#orderOverlay.show');
  await frame.evaluate(() => { window.__nextScan = { status: 'ok', text: 'custard', format: 'code_128', engine: 'mlkit' }; });
  await frame.click('#itemBarcodeInput + .scan-btn');
  await frame.waitForSelector('#itemOverlay.show');
  assert.match(await frame.innerText('#pickerItem'), /卡士達/);
  assert.equal(await frame.inputValue('#pickerQtyNum'), '1', '換品項與點選商品相同：數量從 1 開始');
  await frame.click('#qtyQuick .qty-quick-btn[data-q="3"]');
  // 查無條碼
  await frame.click('#pickerBackBtn');
  await frame.fill('#itemBarcodeInput', '0000000');
  await frame.press('#itemBarcodeInput', 'Enter');
  await frame.waitForFunction(() => document.getElementById('toast').innerText.includes('查無此條碼'));
  await frame.click('.item-btn[data-id="custard"]');
  assert.equal(await frame.inputValue('#pickerQtyNum'), '1', '重新挑選後數量重新從 1 開始');
  await frame.click('#qtyQuick .qty-quick-btn[data-q="3"]');
  // 確認數量視窗最上方條碼：直接切換品項（數量保留）
  const yt = await frame.evaluate(() => [document.querySelector('#itemOverlay .item-barcode-row').getBoundingClientRect().top, document.getElementById('itemTitle').getBoundingClientRect().top]);
  assert.ok(yt[0] < yt[1], '確認數量視窗的條碼在最上方');
  await frame.fill('#itemDlgBarcode', '4710099');
  await frame.press('#itemDlgBarcode', 'Enter');
  await frame.waitForFunction(() => document.getElementById('pickerItem').innerText.includes('茶凍'));
  assert.equal(await frame.inputValue('#pickerQtyNum'), '3');
  await frame.evaluate(() => { window.__nextScan = { status: 'ok', text: 'custard', format: 'code_128', engine: 'mlkit' }; });
  await frame.click('#itemDlgBarcode + .scan-btn');
  await frame.waitForFunction(() => document.getElementById('pickerItem').innerText.includes('卡士達'));
  // 單品項備註
  assert.equal((await frame.innerText('#lineNoteToggle')).replace(/\s|▼|▲/g, ''), '單品項備註');
  await frame.click('#lineNoteToggle');
  await frame.click('.note-chip >> text=先做');
  assert.match(await frame.innerText('#lineNoteToggle'), /（1）/);
  await frame.click('#pickerDoneBtn');   // 選定離開
  assert.equal(await frame.evaluate(() => cartItems()[0].qty), 3);
  assert.equal(await frame.evaluate(() => cartItems()[0].name), '卡士達');
  // 修改：有備註時自動展開；多一顆刪除此項
  await frame.click('#cartArea .cart-row', { button: 'right' });
  assert.equal(await frame.isVisible('#lineNoteBox'), true);
  assert.deepEqual(await frame.$$eval('#itemOverlay .item-foot .main-btn', (b) => b.filter((x) => x.offsetParent).map((x) => x.innerText.trim())), ['刪除此項', '重新挑選', '選定續挑', '選定離開', '回主選單'].slice(1));
  assert.equal(await frame.isVisible('#pickerDeleteBtn'), true);
  // 回主選單：直接離開不異動
  await frame.click('#qtyQuick .qty-quick-btn[data-q="9"]');
  await frame.click('#pickerExitBtn');
  assert.equal(await frame.evaluate(() => cartItems()[0].qty), 3, '回主選單不異動訂單');
  // 選定續挑：帶回並繼續挑
  await frame.click('#newOrderBtn');
  await frame.click('.item-btn[data-id="cheese"]');
  await frame.click('#pickerMoreBtn');
  await frame.waitForSelector('#orderOverlay.show');
  assert.equal(await frame.evaluate(() => cartItems().length), 2);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('v1.15 後台：商品分群 / 商品（條碼）/ 快速備註 新增修改刪除；已販售商品不能刪除與改名', async () => {
  const { ctx, frame, errors } = await openPos(true);   // openPos 已自動按「確定」
  await frame.click('button[data-tab="admin"]');
  await frame.fill('#pinInput', '1234');
  await frame.click('#pinOverlay .blue-btn');
  await frame.click('.admin-subtab >> text=商品管理');
  await frame.waitForSelector('#categoryAdminArea table');
  await frame.fill('#cName', 'E2E分群');
  await frame.click('text=儲存分群');
  await frame.waitForFunction(() => document.getElementById('categoryAdminArea').innerText.includes('E2E分群'));
  await frame.selectOption('#mCategory', 'E2E分群');
  await frame.fill('#mName', 'E2E商品');
  await frame.fill('#mPrice', '50');
  await frame.fill('#mBarcode', '4719999');
  await frame.click('text=儲存商品');
  await frame.waitForFunction(() => document.getElementById('menuAdminArea').innerText.includes('E2E商品'));
  // 已販售（卡士達）沒有刪除鈕、品名唯讀
  const row = frame.locator('#menuAdminArea tr', { hasText: '卡士達' }).first();
  assert.match(await row.innerText(), /已販售/);
  assert.equal(await row.locator('.danger-btn').count(), 0);
  await row.locator('.blue-btn').click();
  assert.equal(await frame.getAttribute('#mName', 'readonly'), '');
  await frame.click('text=清除表單');
  // 刪除未販售商品，再刪空分群
  await frame.locator('#menuAdminArea tr', { hasText: 'E2E商品' }).locator('.danger-btn').click();
  await frame.waitForFunction(() => !document.getElementById('menuAdminArea').innerText.includes('E2E商品'));
  await frame.locator('#categoryAdminArea tr', { hasText: 'E2E分群' }).locator('.danger-btn').click();
  await frame.waitForFunction(() => !document.getElementById('categoryAdminArea').innerText.includes('E2E分群'));
  // 快速備註：新增 → 刪除
  await frame.click('.admin-subtab >> text=備註管理');
  await frame.fill('#nText', 'E2E備註');
  await frame.click('text=儲存備註');
  await frame.waitForFunction(() => document.getElementById('noteAdminArea').innerText.includes('E2E備註'));
  await frame.locator('#noteAdminArea tr', { hasText: 'E2E備註' }).locator('.danger-btn').click();
  await frame.waitForFunction(() => !document.getElementById('noteAdminArea').innerText.includes('E2E備註'));
  assert.deepEqual(errors, []);
  await ctx.close();
});
