#!/usr/bin/env node
'use strict';
/**
 * 把「條碼模組」網頁版同步到：
 *   gas/src/BarcodeScanLib.html   （內嵌到 GAS 畫面，所有輸入欄位的掃描按鈕使用）
 *   docs/barcode/barcode-scan.js  （GitHub Pages：掃描頁用）
 *   docs/barcode/scan.html        （GitHub Pages：電腦瀏覽器無法在 GAS iframe 開相機時，以新視窗開啟）
 * 條碼模組是唯一來源，請勿直接修改產生的檔案。部署與測試前都會自動執行。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MOD = path.join(ROOT, '條碼模組', 'web');
const lib = fs.readFileSync(path.join(MOD, 'barcode-scan.js'), 'utf8');
const scan = fs.readFileSync(path.join(MOD, 'scan.html'), 'utf8');
const version = (lib.match(/VERSION\s*=\s*['"]([^'"]+)['"]/) || [])[1] || '?';

if (/<\?/.test(lib)) throw new Error('barcode-scan.js 含有 "<?"，會被 GAS 範本誤判');

// 內嵌在 <script> 中時，字串或註解裡的 </script> 會提早結束標籤，必須跳脫
const inline = lib.replace(/<\/script/gi, '<\\/script');
const gasFile = path.join(ROOT, 'gas', 'src', 'BarcodeScanLib.html');
const gasContent = '<!-- 自動產生：scripts/sync_barcode.js，來源 條碼模組/web/barcode-scan.js v' + version + '，請勿手動修改 -->\n<script>\n' + inline + '\n</script>\n';

const docsDir = path.join(ROOT, 'docs', 'barcode');
fs.mkdirSync(docsDir, { recursive: true });

let changed = 0;
function write(file, content) {
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (old === content) return;
  fs.writeFileSync(file, content, 'utf8');
  changed++;
  console.log('  已更新 ' + path.relative(ROOT, file));
}
write(gasFile, gasContent);

// GitHub Pages 網址給 GAS（獨立開啟 GAS / 查詢頁時，掃描頁新視窗要用）
let pagesUrl = '';
try { pagesUrl = JSON.parse(fs.readFileSync(path.join(ROOT, 'deploy.config.json'), 'utf8')).pagesUrl || ''; } catch (e) { /* 尚未設定 */ }
write(path.join(ROOT, 'gas', 'src', 'DeployInfo.js'),
  '/** 自動產生：scripts/sync_barcode.js（來源 deploy.config.json），請勿手動修改 */\nvar PAGES_URL = ' + JSON.stringify(pagesUrl) + ';\n');
write(path.join(docsDir, 'barcode-scan.js'), lib);
write(path.join(docsDir, 'scan.html'), scan);
console.log('條碼模組 v' + version + ' 同步完成' + (changed ? '（' + changed + ' 個檔案）' : '（無變更）'));
