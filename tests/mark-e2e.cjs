// "Point at the button you used": outlines the provider buttons on sites in your list, only when
// switched on and given access to all sites.
const { chromium } = require('playwright');
const path = require('path'), fs = require('fs'), https = require('https');
const SRC = process.env.AUTHSCOPE_EXT || path.resolve(__dirname, '..'), OUT = path.join(require('os').tmpdir(), 'authscope-tests');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = []; const check = (n, c, d) => results.push(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  ' + JSON.stringify(d)}`);
const html = body => `<!doctype html><meta charset=utf-8><style>body{font:16px system-ui;padding:40px} button,a.btn{display:block;margin:12px 0;padding:10px 16px;width:280px}</style><body>${body}</body>`;

// The browser's permission prompt can't be clicked in a test, so load a copy where access to all
// sites is already granted (as it would be after saying yes).
const EXT = path.join(OUT, 'ext-mark');
fs.rmSync(EXT, { recursive: true, force: true }); fs.cpSync(SRC, EXT, { recursive: true });
const man = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
man.host_permissions.push('https://*/*'); fs.writeFileSync(path.join(EXT, 'manifest.json'), JSON.stringify(man));

const PAGES = {
  'www.bakeryapp.com/login': html(`<h1>Log in</h1>
    <button id=google><svg width=16 height=16 aria-hidden=true></svg><span>Continue with Google</span></button>
    <button id=apple>Continue with Apple</button>
    <a class=btn id=gh href="#">Sign in with GitHub</a>
    <button id=iconOnly aria-label="Google"><img alt="" width=16 height=16></button>
    <footer><a id=play href="#">Get it on Google Play</a></footer>`),
  'www.bakeryapp.com/later': html(`<h1>Log in</h1><div id=slot></div>
    <script>setTimeout(() => { document.getElementById('slot').innerHTML = '<button id=late>Log in with Google</button>'; }, 800);</script>`),
  'stranger.site/login': html(`<button id=google>Continue with Google</button>`),
};

(async () => {
  const server = https.createServer({ key: fs.readFileSync(OUT + '/key.pem'), cert: fs.readFileSync(OUT + '/cert.pem') }, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGES[req.headers.host + req.url] || html('ok'));
  });
  await new Promise(r => server.listen(443, '127.0.0.1', r));
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(OUT, 'profile-')), {
    headless: true, channel: 'chromium', ignoreHTTPSErrors: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP * 127.0.0.1', '--ignore-certificate-errors', '--no-proxy-server'],
  });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = new URL(sw.url()).host;
  const now = Date.now();
  await sw.evaluate(now => chrome.storage.local.set({ accounts: { 'bakeryapp.com': { domain: 'bakeryapp.com', note: '', methods: {
    google: { firstSeen: 1, lastSeen: now, count: 3, confirmed: true, source: 'detected' },
    github: { firstSeen: 1, lastSeen: now - 1e6, count: 1, confirmed: true, source: 'provider' },
  } } } }), now);

  // Which elements on the page have an outline drawn over them.
  const marks = p => p.evaluate(() => {
    const boxes = [...(document.querySelector('authscope-marks')?.shadowRoot?.querySelectorAll('.box') || [])].filter(b => b.style.display !== 'none');
    return boxes.map(b => {
      const r = b.getBoundingClientRect();
      const under = [...document.querySelectorAll('[id]')].find(el => { const e = el.getBoundingClientRect(); return Math.abs(e.left - r.left - 5) < 2 && Math.abs(e.top - r.top - 5) < 2 && Math.abs(e.width - r.width + 10) < 2; });
      return { on: under?.id || null, tag: b.querySelector('.tag')?.textContent };
    });
  });
  const page = await ctx.newPage();

  // Off by default: nothing drawn.
  await page.goto('https://www.bakeryapp.com/login'); await sleep(800);
  check('off by default', (await marks(page)).length === 0 && (await sw.evaluate(() => chrome.storage.local.get('settings'))).settings?.markButtons !== true, await marks(page));

  await sw.evaluate(() => chrome.storage.local.set({ settings: { showBadge: true, markButtons: true } }));
  await page.goto('https://www.bakeryapp.com/login'); await sleep(800);
  const m = await marks(page);
  const on = m.map(x => x.on).sort();
  check('outlines the Google and GitHub buttons used here', JSON.stringify(on) === '["gh","google","iconOnly"]', m);
  check('each says "You used this"', m.length && m.every(x => x.tag === 'You used this'), m);
  check('leaves Apple (not used) and "Google Play" alone', !on.includes('apple') && !on.includes('play'), on);
  check('button still clickable through the outline', await page.evaluate(() => document.elementFromPoint(150, document.getElementById('google').getBoundingClientRect().top + 10)?.closest('#google') != null), null);
  for (const scheme of ['light', 'dark']) { await page.emulateMedia({ colorScheme: scheme }); await page.screenshot({ path: `${OUT}/mark-${scheme}.png`, clip: { x: 0, y: 0, width: 420, height: 330 } }); }

  await page.goto('https://www.bakeryapp.com/later'); await sleep(1600);
  check('finds a button added after the page loads', JSON.stringify((await marks(page)).map(x => x.on)) === '["late"]', await marks(page));

  await page.goto('https://stranger.site/login'); await sleep(800);
  check('nothing on sites not in the list', (await marks(page)).length === 0, await marks(page));

  // Settings survive the clean-up the dashboard runs on opening.
  const dash = await ctx.newPage();
  await dash.goto(`chrome-extension://${id}/dashboard.html`); await sleep(800);
  check('setting kept after start-up clean-up', (await sw.evaluate(() => chrome.storage.local.get('settings'))).settings?.markButtons === true, null);
  check('dashboard shows it switched on', await dash.$eval('#markButtons', b => b.checked), null);

  // Switching it off saves and gives the access back; switching on asks first.
  await dash.evaluate(() => {
    window.__asked = []; window.__removed = [];
    chrome.permissions.request = async p => { window.__asked.push(p); return window.__answer; };
    chrome.permissions.remove = async p => { window.__removed.push(p); return true; };
  });
  await dash.click('#markButtons'); await sleep(300);
  let st = await dash.evaluate(async () => ({ s: (await chrome.storage.local.get('settings')).settings, removed: window.__removed }));
  check('switching off saves and removes the access', st.s.markButtons === false && JSON.stringify(st.removed) === '[{"origins":["https://*/*"]}]', st);
  await page.goto('https://www.bakeryapp.com/login'); await sleep(800);
  check('no outline once switched off', (await marks(page)).length === 0, await marks(page));

  await dash.evaluate(() => { window.__answer = false; });
  await dash.click('#markButtons'); await sleep(300);
  st = await dash.evaluate(async () => ({ s: (await chrome.storage.local.get('settings')).settings, asked: window.__asked, box: document.getElementById('markButtons').checked }));
  check('saying no leaves it off', st.s.markButtons === false && !st.box && st.asked.length === 1, st);
  await dash.evaluate(() => { window.__answer = true; });
  await dash.click('#markButtons'); await sleep(300);
  st = await dash.evaluate(async () => ({ s: (await chrome.storage.local.get('settings')).settings, asked: window.__asked, box: document.getElementById('markButtons').checked }));
  check('saying yes switches it on', st.s.markButtons === true && st.box && JSON.stringify(st.asked[1]) === '{"origins":["https://*/*"]}', st);
  await dash.screenshot({ path: `${OUT}/mark-setting.png`, fullPage: true });

  // The real extension asks for nothing beyond the provider sites at install.
  const real = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
  check('all-sites access is optional, not asked at install', !real.host_permissions.some(h => h.includes('*/*') && h.startsWith('https://*/')) && real.optional_host_permissions?.includes('https://*/*'), real.optional_host_permissions);

  console.log(results.join('\n'));
  await ctx.close(); server.close();
  if (results.some(r => r.startsWith('FAIL'))) process.exitCode = 1;
})().catch(e => { console.error('ERROR', e); process.exit(1); });
