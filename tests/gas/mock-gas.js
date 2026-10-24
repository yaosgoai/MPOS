/**
 * 極簡 Apps Script 模擬環境：讓 gas/src/*.js 能在 Node 中執行（含記憶體版試算表）。
 * 只實作 MPOS 用到的 API。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

class MockRange {
  constructor(sheet, row, col, nr, nc) { Object.assign(this, { sheet, row, col, nr: nr || 1, nc: nc || 1 }); }
  _check() {
    if (this.row + this.nr - 1 > this.sheet.maxRows) throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.nr; r++) {
      const line = [];
      for (let c = 0; c < this.nc; c++) line.push(this.sheet._get(this.row + r, this.col + c));
      out.push(line);
    }
    return out;
  }
  setValues(vals) {
    this._check();
    if (vals.length !== this.nr || vals[0].length !== this.nc) throw new Error('setValues 維度不符');
    for (let r = 0; r < this.nr; r++) for (let c = 0; c < this.nc; c++) this.sheet._set(this.row + r, this.col + c, vals[r][c]);
    return this;
  }
  setValue(v) { this._check(); this.sheet._set(this.row, this.col, v); return this; }
  setNumberFormat(f) { for (let r = 0; r < this.nr; r++) for (let c = 0; c < this.nc; c++) this.sheet._fmt(this.row + r, this.col + c, f); return this; }
  setNumberFormats(fs2) { for (let r = 0; r < this.nr; r++) for (let c = 0; c < this.nc; c++) this.sheet._fmt(this.row + r, this.col + c, fs2[r][c]); return this; }
  clearContent() { for (let r = 0; r < this.nr; r++) for (let c = 0; c < this.nc; c++) this.sheet._set(this.row + r, this.col + c, ''); return this; }
  setFontWeight() { return this; }
}

class MockSheet {
  constructor(name) { this.name = name; this.cells = {}; this.formats = {}; this.maxRows = 1000; this.writes = 0; }
  _k(r, c) { return r + ':' + c; }
  _get(r, c) { const v = this.cells[this._k(r, c)]; return v === undefined ? '' : v; }
  _set(r, c, v) {
    this.writes++;
    // 模擬 Sheets 自動轉型：非純文字格式的數字字串會被轉成數字
    const fmt = this.formats[this._k(r, c)];
    if (fmt !== '@' && typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
    this.cells[this._k(r, c)] = v;
  }
  _fmt(r, c, f) { this.formats[this._k(r, c)] = f; }
  getName() { return this.name; }
  getRange(row, col, nr, nc) { return new MockRange(this, row, col, nr, nc); }
  getLastRow() {
    let last = 0;
    for (const k of Object.keys(this.cells)) { const r = Number(k.split(':')[0]); if (this.cells[k] !== '' && r > last) last = r; }
    return last;
  }
  getMaxRows() { return this.maxRows; }
  getLastColumn() {
    let last = 0;
    for (const k of Object.keys(this.cells)) { const c = Number(k.split(':')[1]); if (this.cells[k] !== '' && c > last) last = c; }
    return last;
  }
  insertRowsAfter(after, n) { this.maxRows += n; }
  setFrozenRows() {}
}

class MockSpreadsheet {
  constructor(name, id) { this.name = name; this.id = id; this.sheets = [new MockSheet('工作表1')]; }
  getId() { return this.id; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id; }
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  insertSheet(n) { const s = new MockSheet(n); this.sheets.push(s); return s; }
  getSheets() { return this.sheets.slice(); }
  deleteSheet(s) { this.sheets = this.sheets.filter((x) => x !== s); }
}

function formatDate(date, tz, pattern) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date).reduce((a, p) => { a[p.type] = p.value; return a; }, {});
  if (parts.hour === '24') parts.hour = '00';
  return pattern.replace('yyyy', parts.year).replace('MM', parts.month).replace('dd', parts.day)
    .replace('HH', parts.hour).replace('mm', parts.minute).replace('ss', parts.second);
}

function createGasContext(opts) {
  opts = opts || {};
  const store = { spreadsheets: {}, props: {}, cache: {}, seq: 0 };
  const ctx = {
    console,
    SpreadsheetApp: {
      create(name) { const id = 'mock-ss-' + (++store.seq); store.spreadsheets[id] = new MockSpreadsheet(name, id); return store.spreadsheets[id]; },
      openById(id) { const s = store.spreadsheets[id]; if (!s) throw new Error('找不到試算表 ' + id); return s; },
      flush() {},
    },
    PropertiesService: {
      getScriptProperties() {
        return {
          getProperty: (k) => (k in store.props ? store.props[k] : null),
          setProperty: (k, v) => { store.props[k] = String(v); },
        };
      },
    },
    LockService: { getScriptLock() { return { waitLock() {}, releaseLock() {} }; } },
    CacheService: {
      getScriptCache() {
        return {
          get: (k) => (k in store.cache ? store.cache[k] : null),
          put: (k, v) => { store.cache[k] = v; },
          remove: (k) => { delete store.cache[k]; },
        };
      },
    },
    Utilities: { formatDate: (d, tz, p) => formatDate(opts.now ? opts.now() : d, tz, p), sleep() {} },
    Logger: { log() {} },
    ScriptApp: { getService() { return { getUrl: () => 'https://script.google.com/macros/s/MOCK/exec' }; } },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput(t) { return { text: t, setMimeType() { return this; }, getContent() { return this.text; } }; },
    },
    HtmlService: {
      XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' },
      createHtmlOutputFromFile(name) { return { getContent: () => fs.readFileSync(path.join(SRC, name + '.html'), 'utf8') }; },
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.js')).sort((a, b) => order(a) - order(b));
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f });
  ctx.__store = store;
  return ctx;
}

const SRC = path.join(__dirname, '..', '..', 'gas', 'src');
// Apps Script 依檔名載入；Config 必須最先
function order(f) { return ['Config.js', 'Logic.js', 'Seed.js', 'Db.js', 'Api.js', 'Code.js'].indexOf(f) + 1 || 99; }

module.exports = { createGasContext, formatDate, SRC };
