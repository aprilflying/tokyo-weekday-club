/** Browser regression tests. All booking writes and tracking are intercepted. */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium, webkit } = require('playwright');
const root = process.cwd();
const live = process.env.TWC_CHECK_LIVE === '1';
const MARKER = 'TWC_BOOKING_HISTORY_V2';
const START = new Date('2026-10-12T09:00:00+09:00');
const reactDir = path.dirname(require.resolve('react/package.json'));
const domDir = path.dirname(require.resolve('react-dom/package.json'));
const scriptRE = /<script\b[^>]*\bdata-dc-script\b[^>]*>([\s\S]*?)<\/script>/i;
const originalHtml = fs.readFileSync('index.html', 'utf8');
const source = originalHtml.match(scriptRE)[1];
// Negative control recreates the previous replacement-token bug in memory only.
const brokenHtml = originalHtml.replace(source, source);
assert.notEqual(brokenHtml.match(scriptRE)[1], source, 'Regression fixture must reproduce script truncation');

async function waitForProduction() {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const r = await fetch('https://www.tokyoweekdayclub.com/?booking-release=' + Date.now(), { signal: AbortSignal.timeout(15000) });
      const html = await r.text();
      if (r.ok && html.includes(MARKER)) return;
    } catch {}
    await new Promise(r => setTimeout(r, 10000));
  }
  throw new Error('Updated production HTML not observed within deployment wait window');
}

async function isolateNetwork(page, origins, holdRequests) {
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/api/hold') {
      holdRequests.push(request.postData());
      return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: 'week_closed' }) });
    }
    // Even a failing test must never create a booking, send an email or charge.
    if (!['GET', 'HEAD'].includes(request.method())) return route.fulfill({ status: 400, body: 'Test blocked a write' });
    if (url.hostname === 'unpkg.com' && url.pathname.includes('react-dom@18.3.1/')) return route.fulfill({ path: path.join(domDir, 'umd/react-dom.production.min.js'), contentType: 'text/javascript' });
    if (url.hostname === 'unpkg.com' && url.pathname.includes('react@18.3.1/')) return route.fulfill({ path: path.join(reactDir, 'umd/react.production.min.js'), contentType: 'text/javascript' });
    if (url.hostname === 'script.google.com' || url.hostname === 'script.googleusercontent.com') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ max: 6, min: 3, W1AM: 6, W1PM: 6 }) });
    if (origins.includes(url.origin) || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
    return route.fulfill({ status: 200, contentType: request.resourceType() === 'stylesheet' ? 'text/css' : 'text/javascript', body: '' });
  });
}

(async () => {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/_broken-control') { res.setHeader('Content-Type', 'text/html'); return res.end(brokenHtml); }
    const filename = pathname === '/' ? 'index.html' : pathname === '/hk' ? 'hk.html' : pathname.slice(1);
    const target = path.resolve(root, filename);
    if (!target.startsWith(root + path.sep) || !/\.(html|js|png|jpg|ico)$/.test(filename) || !fs.existsSync(target)) { res.statusCode = 404; return res.end(); }
    res.setHeader('Content-Type', filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.html') ? 'text/html' : 'application/octet-stream');
    res.end(fs.readFileSync(target));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const local = 'http://127.0.0.1:' + server.address().port;
  const base = live ? 'https://www.tokyoweekdayclub.com' : local;
  try {
    if (live) await waitForProduction();
    for (const [engine, browserType] of [['Chromium', chromium], ['WebKit', webkit]]) {
      const browser = await browserType.launch();
      try {
        for (const pagePath of ['/', '/hk']) {
          console.log(`${engine} ${pagePath}: loading ${live ? 'production' : 'generated HTML'}`);
          const page = await browser.newPage({ viewport: { width: 1365, height: 900 }, timezoneId: 'America/Los_Angeles', reducedMotion: 'reduce' });
          const errors = [], holdRequests = [];
          page.on('pageerror', error => errors.push(error.message));
          page.setDefaultTimeout(15000);
          // Keep timers running while React mounts; freeze only after rendering.
          await page.clock.install({ time: new Date(START.getTime() - 60000) });
          await isolateNetwork(page, [base, local], holdRequests);
          const response = await page.goto(base + pagePath, { waitUntil: 'domcontentloaded', timeout: 45000 });
          assert.equal(response.status(), 200);
          await page.waitForFunction(() => window.__dcRegistry && Object.values(window.__dcRegistry).some(r => r.Logic));
          assert.equal(await page.locator('.sc-logic-error').count(), 0, 'No template runtime error');
          assert.equal(await page.evaluate(() => document.querySelector('script[data-dc-script]').textContent.includes('TWC_BOOKING_HISTORY_V2')), true);
          const zh = pagePath === '/hk';
          const label = i => zh ? ['10月5–8日', '10月12–15日', '10月19–22日'][i] : ['Oct 5–8', 'Oct 12–15', 'Oct 19–22'][i];
          const tile = i => page.locator('#book').getByText(label(i), { exact: true });
          await tile(0).waitFor({ state: 'visible' });
          await tile(1).waitFor({ state: 'visible' });
          await page.waitForFunction(() => document.querySelector('#book').textContent.includes('fully booked'));
          await page.clock.pauseAt(START);
          await tile(0).click();
          assert.equal(await page.locator('#book').getByText('fully booked · 已滿', { exact: true }).count(), 1);
          assert.equal(await page.evaluate(() => document.querySelector('#book').textContent.includes('NaN')), false);
          // Keep two closed weeks on second Tuesday. The third removes the oldest.
          await page.clock.setSystemTime(new Date('2026-10-13T00:00:00+09:00'));
          await page.evaluate(() => window.dispatchEvent(new Event('focus')));
          await page.clock.runFor(50);
          await page.locator('#book').getByText(zh ? '預約已截止' : 'Bookings closed', { exact: true }).waitFor({ state: 'visible' });
          assert.equal(await tile(0).count(), 1); assert.equal(await tile(1).count(), 1);
          await page.clock.setSystemTime(new Date('2026-10-19T23:59:59.990+09:00'));
          await page.evaluate(() => window.dispatchEvent(new Event('focus')));
          // No focus event here: the scheduled timer must remove the old tile.
          await page.clock.runFor(50);
          await tile(0).waitFor({ state: 'detached' });
          await tile(1).waitFor({ state: 'visible' }); await tile(2).waitFor({ state: 'visible' });
          await page.getByRole('button', { name: zh ? 'EN' : '繁體中文', exact: true }).click();
          assert.equal(await page.locator('.sc-logic-error').count(), 0);
          assert.equal(await page.locator('body').innerText().then(t => t.includes('48,000')), true);
          await page.clock.setSystemTime(new Date('2027-01-05T00:00:00+09:00'));
          await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
          await page.clock.runFor(50);
          await page.locator('#book').getByText(zh ? 'New dates will be announced soon. Please contact us about future weeks.' : '新一期日期將會公布，歡迎聯絡我們查詢。', { exact: true }).waitFor({ state: 'visible' });
          assert.deepEqual(errors, []); assert.equal(holdRequests.length, 0);
          console.log(`${live ? 'PRODUCTION' : 'BUILT HTML'} ${engine} ${pagePath}: render, prices, language, capacity, 2-week history and timer rollover passed`);
          await page.close();
        }
        if (!live) {
          const page = await browser.newPage();
          page.setDefaultTimeout(15000);
          await isolateNetwork(page, [local], []);
          await page.goto(local + '/_broken-control', { waitUntil: 'domcontentloaded' });
          await page.locator('.sc-logic-error').waitFor({ state: 'visible' });
          console.log(`${engine}: negative control detected the original truncated-script failure`);
          await page.close();
        }
      } finally { await browser.close(); }
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
