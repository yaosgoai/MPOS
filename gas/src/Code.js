/**
 * MPOS Cloud - Web App 進入點
 *   GET  ?            → POS 主畫面（給 GitHub Pages iframe 內嵌）
 *   GET  ?page=lookup → 流水號查詢頁（可帶 &q=0704001）
 *   GET  ?api=health  → JSON 健康檢查（自動化測試用）
 *   POST {fn, args}   → JSON API（自動化測試用，白名單見 HTTP_API）
 */

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.api) return jsonOut_(p.api === 'health' ? apiHealth() : { ok: false, message: '未知 API：' + p.api });

  var page = p.page === 'lookup' ? 'Lookup' : 'Index';
  var tpl = HtmlService.createTemplateFromFile(page);
  tpl.initialQuery = String(p.q || '');
  tpl.appVersion = APP_VERSION;
  tpl.pagesUrl = (typeof PAGES_URL !== 'undefined' && PAGES_URL) ? PAGES_URL : '';
  return tpl.evaluate()
    .setTitle('茉莉花鯛魚燒 POS')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { return jsonOut_({ ok: false, message: 'JSON 格式錯誤' }); }
  var fn = HTTP_API[body.fn];
  if (!fn) return jsonOut_({ ok: false, message: '不允許的 API：' + body.fn });
  var args = Array.isArray(body.args) ? body.args : [];
  return jsonOut_(fn.apply(null, args));
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** HtmlService include helper */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}
