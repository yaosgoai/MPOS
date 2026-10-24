/**
 * 網頁版規則測試（Node.js）：node test/rules.test.js
 * 與 Android 的 BarcodeRulesTest 使用同一份 test/vectors.json。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const BS = require(path.join(__dirname, '..', 'web', 'barcode-scan.js'));
const V = JSON.parse(fs.readFileSync(path.join(__dirname, 'vectors.json'), 'utf8'));

let fail = 0, n = 0;
function check(cond, msg) { n++; if (!cond) { fail++; console.log('✖ ' + msg); } }

V.rules.forEach(r => check(BS.validate(r.format, r.text) === r.valid, 'validate ' + r.format + ' ' + JSON.stringify(r.text) + ' 應為 ' + r.valid + '（' + r.note + '）'));
Object.keys(V.requiredReads).forEach(f => check(BS.requiredReads(f) === V.requiredReads[f], 'requiredReads ' + f));
V.voter.forEach(c => {
  const vt = BS.createVoter(c.windowMs);
  let at = -1;
  c.reads.forEach((r, i) => { if (vt.add(r[1], r[2], r[0]) && at < 0) at = i; });
  check(at === c.acceptAt, 'voter：' + c.note + '（採用於第 ' + at + ' 筆，應為 ' + c.acceptAt + '）');
});
['ITF', 'QRCode', 'EAN-13', 'UPC-A', 'DataMatrix', 'PDF_417', 'code128'].forEach(f =>
  check(BS.normFormat(f) !== 'unknown', 'normFormat ' + f));

console.log((fail ? '❌ ' : '✅ ') + (n - fail) + '/' + n + ' 通過');
process.exit(fail ? 1 : 0);
