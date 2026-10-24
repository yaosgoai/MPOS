/**
 * MPOS Cloud - Google 試算表資料層
 * 每個資料表 = 一個工作表，第一列為欄位名稱。
 */

var PROP_SPREADSHEET_ID = 'SPREADSHEET_ID';
var _ssCache = null;

function nowText_() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
}

function todayText_() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
}

/** 取得資料庫試算表；第一次執行自動建立 */
function getDb_() {
  if (_ssCache) return _ssCache;
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(PROP_SPREADSHEET_ID);
  if (id) {
    _ssCache = SpreadsheetApp.openById(id);
    return _ssCache;
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    id = props.getProperty(PROP_SPREADSHEET_ID);
    if (id) {
      _ssCache = SpreadsheetApp.openById(id);
    } else {
      _ssCache = SpreadsheetApp.create('茉莉花鯛魚燒 POS 資料庫 (MPOS Cloud)');
      props.setProperty(PROP_SPREADSHEET_ID, _ssCache.getId());
    }
  } finally {
    lock.releaseLock();
  }
  return _ssCache;
}

var _headerChecked = {};

function getSheet_(table) {
  var ss = getDb_();
  var sh = ss.getSheetByName(table);
  if (!sh) sh = createTableSheet_(ss, table);
  else if (!_headerChecked[table]) ensureHeaders_(sh, table);
  _headerChecked[table] = true;
  return sh;
}

/** 新版新增欄位時，補上舊工作表的欄位標題與格式（例如 order_items.note） */
function ensureHeaders_(sh, table) {
  var cols = TABLES[table].cols;
  var lastCol = Math.max(1, sh.getLastColumn ? sh.getLastColumn() : cols.length);
  if (lastCol >= cols.length) return;
  for (var i = lastCol; i < cols.length; i++) {
    if (cols[i][1] === 's') sh.getRange(1, i + 1, sh.getMaxRows(), 1).setNumberFormat('@');
    sh.getRange(1, i + 1).setValue(cols[i][0]).setFontWeight('bold');
  }
}

function createTableSheet_(ss, table) {
  var def = TABLES[table];
  if (!def) throw new Error('未知資料表：' + table);
  var sh = ss.insertSheet(table);
  var headers = def.cols.map(function (c) { return c[0]; });
  // 文字欄位設為純文字格式，避免 0704001 / 2026-07-04 被自動轉型
  def.cols.forEach(function (c, i) {
    if (c[1] === 's') sh.getRange(1, i + 1, sh.getMaxRows(), 1).setNumberFormat('@');
  });
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sh.setFrozenRows(1);
  return sh;
}

function coerce_(value, type) {
  if (type === 'n') {
    if (value === '' || value === null || value === undefined) return 0;
    var n = Number(value);
    return isNaN(n) ? 0 : n;
  }
  if (value === null || value === undefined) return '';
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return Utilities.formatDate(value, TZ, 'yyyy-MM-dd HH:mm:ss').replace(' 00:00:00', '');
  }
  return String(value);
}

/** 讀取整張表 → 物件陣列（每筆帶 _row = 試算表列號） */
function readTable_(table) {
  var def = TABLES[table];
  var sh = getSheet_(table);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(2, 1, last - 1, def.cols.length).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    if (row[0] === '' || row[0] === null) continue;
    var obj = { _row: i + 2 };
    def.cols.forEach(function (c, j) { obj[c[0]] = coerce_(row[j], c[1]); });
    out.push(obj);
  }
  return out;
}

function toRow_(table, obj) {
  return TABLES[table].cols.map(function (c) {
    var v = obj[c[0]];
    if (c[1] === 'n') return (v === '' || v === null || v === undefined) ? '' : Number(v);
    return v === null || v === undefined ? '' : String(v);
  });
}

function appendRows_(table, objs) {
  if (!objs.length) return;
  var sh = getSheet_(table);
  var rows = objs.map(function (o) { return toRow_(table, o); });
  var start = sh.getLastRow() + 1;
  var needLast = start + rows.length - 1;
  if (needLast > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), needLast - sh.getMaxRows() + 200);
  var range = sh.getRange(start, 1, rows.length, rows[0].length);
  // 文字欄位強制純文字格式
  range.setNumberFormats(rows.map(function () {
    return TABLES[table].cols.map(function (c) { return c[1] === 's' ? '@' : '0'; });
  }));
  range.setValues(rows);
}

/** 依主鍵更新（找不到則新增） */
function upsert_(table, obj) {
  var def = TABLES[table];
  var key = def.key;
  var rows = readTable_(table);
  var found = null;
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][key]) === String(obj[key])) { found = rows[i]; break; }
  }
  var sh = getSheet_(table);
  if (found) {
    var merged = {};
    def.cols.forEach(function (c) { merged[c[0]] = obj[c[0]] !== undefined ? obj[c[0]] : found[c[0]]; });
    sh.getRange(found._row, 1, 1, def.cols.length).setValues([toRow_(table, merged)]);
    return merged;
  }
  appendRows_(table, [obj]);
  return obj;
}

/** 只更新部分欄位 */
function updateFields_(table, keyValue, fields) {
  var def = TABLES[table];
  var rows = readTable_(table);
  var found = null;
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][def.key]) === String(keyValue)) { found = rows[i]; break; }
  }
  if (!found) return null;
  var sh = getSheet_(table);
  Object.keys(fields).forEach(function (k) {
    var idx = -1;
    def.cols.forEach(function (c, j) { if (c[0] === k) idx = j; });
    if (idx >= 0) {
      sh.getRange(found._row, idx + 1).setValue(def.cols[idx][1] === 'n' ? Number(fields[k]) : String(fields[k]));
      found[k] = fields[k];
    }
  });
  return found;
}

/** 刪除符合條件的列（由下往上刪，避免列號位移） */
function deleteWhere_(table, pred) {
  var rows = readTable_(table).filter(pred);
  if (!rows.length) return 0;
  var sh = getSheet_(table);
  rows.map(function (r) { return r._row; }).sort(function (a, b) { return b - a; }).forEach(function (r) { sh.deleteRow(r); });
  return rows.length;
}

function replaceTable_(table, objs) {
  var sh = getSheet_(table);
  var last = sh.getLastRow();
  if (last >= 2) sh.getRange(2, 1, last - 1, TABLES[table].cols.length).clearContent();
  appendRows_(table, objs);
}

function nextId_(table) {
  var rows = readTable_(table);
  var max = 0;
  rows.forEach(function (r) { if (Number(r.id) > max) max = Number(r.id); });
  return max + 1;
}

function strip_(obj) {
  var o = {};
  Object.keys(obj).forEach(function (k) { if (k !== '_row') o[k] = obj[k]; });
  return o;
}

/* ---------------- 初始化 / 種子資料 ---------------- */

/**
 * 建立所有工作表並匯入種子資料（只在空表時匯入）。
 * 第一次部署後請在 Apps Script 編輯器執行一次 setup()，以授權並建立資料庫。
 */
function setup() {
  var ss = getDb_();
  Object.keys(TABLES).forEach(function (t) { getSheet_(t); });
  var seed = (typeof SEED_DATA !== 'undefined' && SEED_DATA) ? SEED_DATA : {};

  if (readTable_('settings').length === 0) {
    var s = {};
    Object.keys(DEFAULT_SETTINGS).forEach(function (k) { s[k] = DEFAULT_SETTINGS[k]; });
    var seedSettings = seed.settings || {};
    Object.keys(seedSettings).forEach(function (k) { if (s[k] !== undefined) s[k] = String(seedSettings[k]); });
    appendRows_('settings', Object.keys(s).map(function (k) { return { key: k, value: s[k] }; }));
  } else {
    // 補齊新版新增的設定鍵
    var existing = {};
    readTable_('settings').forEach(function (r) { existing[r.key] = true; });
    var add = [];
    Object.keys(DEFAULT_SETTINGS).forEach(function (k) { if (!existing[k]) add.push({ key: k, value: DEFAULT_SETTINGS[k] }); });
    appendRows_('settings', add);
  }
  if (readTable_('menu_items').length === 0) appendRows_('menu_items', seed.menu_items || DEFAULT_MENU_ITEMS);
  if (readTable_('note_presets').length === 0) appendRows_('note_presets', seed.note_presets || DEFAULT_NOTE_PRESETS);
  if (readTable_('order_sources').length === 0) appendRows_('order_sources', DEFAULT_ORDER_SOURCES);
  if (readTable_('receipt_layout').length === 0) {
    var layout = sanitizeReceiptLayout(seed.receipt_layout || DEFAULT_RECEIPT_LAYOUT);
    var ts = nowText_();
    appendRows_('receipt_layout', layout.map(function (r) { r.updated_at = ts; return r; }));
  }
  // 移除新建試算表預設的空白工作表
  var def = ss.getSheetByName('工作表1') || ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1) ss.deleteSheet(def);
  if (!PropertiesService.getScriptProperties().getProperty('ADMIN_PIN')) {
    PropertiesService.getScriptProperties().setProperty('ADMIN_PIN', '1234');
  }
  invalidateCache_();
  Logger.log('MPOS 資料庫：' + ss.getUrl());
  return { ok: true, spreadsheet_url: ss.getUrl() };
}

/* ---------------- 快取（減少讀表次數） ---------------- */

var CACHE_KEY_STATIC = 'mpos_static_v2';

function invalidateCache_() {
  try { CacheService.getScriptCache().remove(CACHE_KEY_STATIC); } catch (e) { /* ignore */ }
}

/** settings / menu / notes / layout 的快取讀取 */
function getStatic_() {
  var cache = null;
  try { cache = CacheService.getScriptCache(); } catch (e) { cache = null; }
  if (cache) {
    var hit = cache.get(CACHE_KEY_STATIC);
    if (hit) return JSON.parse(hit);
  }
  var settings = {};
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) { settings[k] = DEFAULT_SETTINGS[k]; });
  readTable_('settings').forEach(function (r) { settings[r.key] = r.value; });
  var menu = readTable_('menu_items').map(strip_);
  menu.sort(function (a, b) { return a.sort_order - b.sort_order || String(a.category).localeCompare(String(b.category)); });
  var notes = readTable_('note_presets').map(strip_);
  notes.sort(function (a, b) { return a.sort_order - b.sort_order || a.id - b.id; });
  var layout = sanitizeReceiptLayout(readTable_('receipt_layout').map(strip_));
  var sources = readTable_('order_sources').map(strip_);
  if (!sources.length) {
    // 舊版資料庫升級：第一次使用時自動建立預設訂單來源
    appendRows_('order_sources', DEFAULT_ORDER_SOURCES);
    sources = DEFAULT_ORDER_SOURCES.map(function (x) { return JSON.parse(JSON.stringify(x)); });
  }
  sources.sort(function (a, b) { return a.sort_order - b.sort_order || a.id - b.id; });
  var data = { settings: settings, menu: menu, notes: notes, sources: sources, layout: layout };
  if (cache) {
    try { cache.put(CACHE_KEY_STATIC, JSON.stringify(data), 600); } catch (e) { /* ignore */ }
  }
  return data;
}
