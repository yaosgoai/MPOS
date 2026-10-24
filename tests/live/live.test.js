'use strict';
/**
 * 部署後線上冒煙測試（GitHub Actions 與 deploy.ps1 都會執行）
 *   PAGES_URL：GitHub Pages 外殼網址（必填，或 MPOS_PAGES_URL）
 *   GAS_URL：可省略，預設從 docs/config.js 讀取
 * 只做讀取檢查，不會建立訂單。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PAGES_URL = process.env.PAGES_URL || process.env.MPOS_PAGES_URL || '';
function gasUrlFromConfig() {
  const txt = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'config.js'), 'utf8');
  const m = txt.match(/"gasUrl"\s*:\s*"([^"]+)"/);
  return m ? m[1] : '';
}
const GAS_URL = process.env.GAS_URL || gasUrlFromConfig();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function retry(fn, tries, waitMs) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; await sleep(waitMs); }
  }
  throw last;
}

test('GAS 健康檢查 ?api=health', async () => {
  assert.ok(GAS_URL && !GAS_URL.includes('__GAS_URL__'), '尚未設定 GAS 網址');
  const j = await retry(async () => {
    const r = await fetch(GAS_URL + '?api=health', { redirect: 'follow' });
    const text = await r.text();
    try { return JSON.parse(text); } catch (e) { throw new Error('GAS 沒有回傳 JSON（可能尚未授權或尚未部署）：' + text.slice(0, 200)); }
  }, 3, 5000);
  assert.equal(j.db_configured, true, '資料庫尚未建立：請在 Apps Script 編輯器執行 setup()');
  assert.ok(j.self_test.every((t) => t.ok), JSON.stringify(j.self_test));
  assert.ok(j.menu_count > 0, '沒有商品資料');
  assert.equal(j.ok, true);
});

test('GAS JSON API：apiBootstrap', async () => {
  const r = await fetch(GAS_URL, { method: 'POST', body: JSON.stringify({ fn: 'apiBootstrap', args: [] }), redirect: 'follow' });
  const j = JSON.parse(await r.text());
  assert.equal(j.ok, true, j.message);
  assert.ok(j.menu.length > 0);
  assert.ok(j.layout.length >= 14);
});

test('GitHub Pages 外殼載入 GAS 並完成握手', { skip: !PAGES_URL && '未提供 PAGES_URL' }, async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  try {
    // Pages 剛部署時可能還是舊版，重試到 config.js 的 GAS 網址一致
    await retry(async () => {
      const r = await fetch(PAGES_URL.replace(/\/?$/, '/') + 'config.js?_t=' + Date.now());
      const t = await r.text();
      if (!t.includes(GAS_URL)) throw new Error('Pages 尚未更新 config.js');
    }, 18, 10000);

    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(PAGES_URL + (PAGES_URL.includes('?') ? '&' : '?') + '_t=' + Date.now());
    await page.waitForFunction(() => window.MPOS_SHELL && window.MPOS_SHELL.gasReady, null, { timeout: 90000 });
    let frame = null;
    for (let i = 0; i < 30 && !frame; i++) {
      for (const f of page.frames()) {
        if (await f.$('#bridgeChip').catch(() => null)) { frame = f; break; }
      }
      if (!frame) await sleep(1000);
    }
    assert.ok(frame, '找不到 GAS POS 畫面 iframe');
    // 商品在「新增訂購」視窗內：先開視窗再檢查商品按鈕
    await frame.waitForSelector('#newOrderBtn', { timeout: 30000 });
    await frame.click('#newOrderBtn');
    await frame.waitForSelector('#orderOverlay.show .item-btn', { timeout: 30000 });
    const n = await frame.locator('.item-btn').count();
    assert.ok(n > 0, '新增訂購視窗沒有商品按鈕');
    await frame.click('#orderOverlay .checkout-close');
    const chip = await frame.innerText('#bridgeChip');
    assert.match(chip, /網頁外殼/);
  } finally {
    await browser.close();
  }
});
