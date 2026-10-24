'use strict';
/**
 * 本機端對端測試伺服器：
 *   shell 伺服器（模擬 GitHub Pages）：服務 docs/，config.js 指向本機 GAS 模擬站
 *   gas 伺服器（模擬 GAS Web App，不同 origin）：渲染 Index.html，google.script.run → /rpc → mock GAS 後端
 * 也可單獨執行：node tests/e2e/harness.js  → 開瀏覽器手動測試
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createGasContext, SRC } = require('../gas/mock-gas');

const DOCS = path.join(__dirname, '..', '..', 'docs');

const RUN_SHIM = `
<script>
// google.script.run 模擬：轉送到測試伺服器 /rpc
(function(){
  function Runner(ok, fail){ this._ok = ok; this._fail = fail; }
  Runner.prototype.withSuccessHandler = function(f){ return new Runner(f, this._fail); };
  Runner.prototype.withFailureHandler = function(f){ return new Runner(this._ok, f); };
  var proxy = function(r){ return new Proxy(r, { get: function(t, k){
    if (k in t) return t[k];
    return function(){
      var args = Array.prototype.slice.call(arguments);
      fetch('/rpc', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({fn:k, args:args})})
        .then(function(res){ return res.json(); })
        .then(function(j){ if (j.__error) { t._fail && t._fail(new Error(j.__error)); } else { t._ok && t._ok(j.result); } })
        .catch(function(e){ t._fail && t._fail(e); });
    };
  }}); };
  var base = new Runner(null, null);
  var origWS = Runner.prototype.withSuccessHandler, origWF = Runner.prototype.withFailureHandler;
  Runner.prototype.withSuccessHandler = function(f){ return proxy(origWS.call(this, f)); };
  Runner.prototype.withFailureHandler = function(f){ return proxy(origWF.call(this, f)); };
  window.google = { script: { run: proxy(base) } };
})();
</script>`;

function renderTemplate(name, vars) {
  let html = fs.readFileSync(path.join(SRC, name + '.html'), 'utf8');
  html = html.replace(/<\?!?=\s*([\s\S]*?)\s*\?>/g, (m, expr) => {
    // 只支援本專案用到的 include('X') / JSON.stringify(v) / 變數
    const fn = new Function('include', ...Object.keys(vars), 'return (' + expr + ');');
    const v = fn((n) => fs.readFileSync(path.join(SRC, n + '.html'), 'utf8'), ...Object.values(vars));
    return String(v);
  });
  return html.replace('<head>', '<head>' + RUN_SHIM);
}

function startHarness(opts) {
  opts = opts || {};
  const g = createGasContext({ now: opts.now });
  g.setup();
  const rpcLog = [];
  const ctl = { failNext: new Set(), dropResponse: new Set() };

  const gasServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.pathname === '/rpc') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const { fn, args } = JSON.parse(body);
        rpcLog.push(fn);
        let out;
        // 測試用：模擬網路中斷（不執行）或回應遺失（已執行但前端收不到）
        if (ctl.failNext.has(fn)) {
          ctl.failNext.delete(fn);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ __error: '網路中斷（模擬）' }));
          return;
        }
        if (ctl.dropResponse.has(fn)) {
          ctl.dropResponse.delete(fn);
          try { g[fn].apply(null, args || []); } catch (e) { /* ignore */ }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ __error: '連線逾時（模擬，伺服器已處理）' }));
          return;
        }
        if (typeof g[fn] !== 'function' || fn.endsWith('_')) out = { __error: 'Script function not found: ' + fn };
        else {
          try { out = { result: JSON.parse(JSON.stringify(g[fn].apply(null, args || []))) }; } catch (e) { out = { __error: String(e.message || e) }; }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      });
      return;
    }
    if (url.pathname === '/gas') {
      const page = url.searchParams.get('page') === 'lookup' ? 'Lookup' : 'Index';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderTemplate(page, { appVersion: g.APP_VERSION, initialQuery: url.searchParams.get('q') || '', pagesUrl: '' }));
      return;
    }
    res.writeHead(404); res.end('not found');
  });

  const shellServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/config.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end('window.MPOS_CONFIG = ' + JSON.stringify({
        gasUrl: 'http://127.0.0.1:' + gasServer.address().port + '/gas',
        allowedOrigins: ['http://127.0.0.1:' + gasServer.address().port],
        readyTimeoutMs: opts.readyTimeoutMs || 15000,
        repo: '',
      }) + ';');
      return;
    }
    const file = path.join(DOCS, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!file.startsWith(DOCS) || !fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/javascript' });
    res.end(fs.readFileSync(file));
  });

  return new Promise((resolve) => {
    gasServer.listen(opts.gasPort || 0, '127.0.0.1', () => {
      // shell 用 localhost，GAS 用 127.0.0.1 → 不同 origin，模擬跨網域 iframe
      shellServer.listen(opts.shellPort || 0, '127.0.0.1', () => {
        resolve({
          g, rpcLog, ctl,
          shellUrl: 'http://localhost:' + shellServer.address().port + '/',
          gasUrl: 'http://127.0.0.1:' + gasServer.address().port + '/gas',
          close: () => { gasServer.close(); shellServer.close(); },
        });
      });
    });
  });
}

module.exports = { startHarness, renderTemplate };

if (require.main === module) {
  startHarness({ gasPort: 8081, shellPort: 8080 }).then((h) => {
    console.log('外殼（模擬 GitHub Pages）：' + h.shellUrl);
    console.log('GAS 模擬站：' + h.gasUrl + '   管理密碼 1234');
  });
}
