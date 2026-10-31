const { chromium } = require('playwright');
const path = require('path'), fs = require('fs');
const EXT = process.env.AUTHSCOPE_EXT || path.resolve(__dirname, '..'), OUT = path.join(require('os').tmpdir(), 'authscope-tests');
const CFG = EXT + '/lib/config.js';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const REAL = 'https://ko-fi.com/varennck';
const setUrl = u => fs.writeFileSync(CFG, fs.readFileSync(CFG, 'utf8').replace(/export const DONATE_URL = '.*';/, `export const DONATE_URL = '${u}';`));
const results = []; const check = (n, c, d) => results.push(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  ' + JSON.stringify(d)}`);
async function run(url, fn) {
  setUrl(url);
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(OUT, 'profile-')), { headless: true, channel: 'chromium', args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  await ctx.route('https://ko-fi.com/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>Ko-fi page</title>' }));
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const requested = []; ctx.on('request', r => { if (r.url().includes('ko-fi.com')) requested.push(r.url()); }); ctx.requested = requested;
  try { await fn(ctx, sw, new URL(sw.url()).host); } finally { await ctx.close(); }
}
(async () => {
  try {
    await run('', async (ctx, sw, id) => {
      const p = await ctx.newPage(); await p.goto(`chrome-extension://${id}/dashboard.html`); await sleep(500);
      check('no link set: dashboard button hidden', await p.$eval('#donate', e => e.hidden), null);
      await p.goto(`chrome-extension://${id}/popup.html`); await sleep(300);
      check('no link set: popup button hidden', await p.$eval('#donate', e => e.hidden), null);
    });
    await run('https://evil.example/ko-fi.com/x', async (ctx, sw, id) => {
      const p = await ctx.newPage(); await p.goto(`chrome-extension://${id}/dashboard.html`); await sleep(500);
      check('non-Ko-fi link refused', await p.$eval('#donate', e => e.hidden), null);
    });
    await run(REAL, async (ctx, sw, id) => {
      const p = await ctx.newPage(); await p.setViewportSize({ width: 1280, height: 300 });
      await sw.evaluate(() => chrome.storage.local.set({ accounts: { 'ollama.com': { domain: 'ollama.com', name: 'Ollama', note: '', methods: { github: { firstSeen: 1, lastSeen: Date.now(), count: 1, confirmed: true, source: 'provider' } } } } }));
      await p.goto(`chrome-extension://${id}/dashboard.html`); await sleep(800);
      const d = await p.$eval('#donate', e => ({ hidden: e.hidden, href: e.href, target: e.target, rel: e.rel, text: e.textContent.trim() }));
      check('dashboard Support AuthScope button', !d.hidden && d.href === REAL && d.target === '_blank' && /noopener/.test(d.rel) && d.text === 'Support AuthScope', d);
      const [tab] = await Promise.all([ctx.waitForEvent('page'), p.click('#donate')]);
      await tab.waitForLoadState(); check('dashboard button opens Ko-fi in a new tab', tab.url() === REAL, tab.url());
      await p.screenshot({ path: `${OUT}/donate-dash.png`, clip: { x: 0, y: 0, width: 1280, height: 130 } });
      await tab.close(); await sleep(300);
      const pop = await ctx.newPage(); await pop.setViewportSize({ width: 340, height: 300 });
      await pop.addInitScript(() => { chrome.tabs.query = async () => [{ id: 1, url: 'https://ollama.com/' }]; });
      await pop.goto(`chrome-extension://${id}/popup.html`); await sleep(500);
      check('popup Donate button shown', !(await pop.$eval('#donate', e => e.hidden)), null);
      await pop.screenshot({ path: `${OUT}/donate-popup.png` });
      await pop.click('#donate'); await sleep(800);
      const opened = await sw.evaluate(() => chrome.tabs.query({}).then(ts => ts.map(t => t.pendingUrl || t.url)));
      check('popup button opens Ko-fi', opened.filter(u => u === REAL).length === 1, opened);
      const asked = await sw.evaluate(() => new Promise(r => chrome.webNavigation.getAllFrames ? r(null) : r(null)));
    });
  } finally { setUrl(REAL); }
  console.log(results.join('\n'));
  if (results.some(r => r.startsWith('FAIL'))) process.exitCode = 1;
  console.log('config restored:', fs.readFileSync(CFG, 'utf8').includes(`DONATE_URL = '${REAL}'`));
})()
.catch(e => { setUrl(REAL); console.error('ERROR', e); process.exit(1); });
