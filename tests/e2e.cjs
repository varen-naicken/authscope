const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const EXT = process.env.AUTHSCOPE_EXT || path.resolve(__dirname, '..');
const OUT = path.join(require('os').tmpdir(), 'authscope-tests');
const enc = encodeURIComponent;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const waitUrl = async (pg, re) => { for (let i=0;i<100;i++){ if (re.test(pg.url())) { await sleep(150); return; } await sleep(100);} throw new Error('url never matched '+re+' at '+pg.url()); };
const html = body => ({ status: 200, contentType: 'text/html', body: `<!doctype html><meta charset=utf-8><body>${body}</body>` });

(async () => {
  const userDir = fs.mkdtempSync(path.join(OUT, 'profile-'));
  const ctx = await chromium.launchPersistentContext(userDir, {
    headless: true, channel: 'chromium',
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP * 127.0.0.1', '--ignore-certificate-errors', '--no-proxy-server'],
    ignoreHTTPSErrors: true,
  });

  const handler = async route => {
    const u = new URL(route.request().url());
    const h = u.hostname;
    if (u.protocol === 'chrome-extension:') return route.continue();
    // Fake third-party sites
    if (h === 'www.bakeryapp.com' && u.pathname === '/login')
      return route.fulfill(html(`<a id=g href="/auth/google">Continue with Google</a>
        <form id=f action="/session" method=post><input type=email name=email id=email><input type=password name=pw id=pw><button id=go>Log in</button></form>`));
    if (h === 'www.bakeryapp.com' && u.pathname === '/auth/google')
      return route.fulfill({ status: 302, headers: { location: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=1&redirect_uri=' + enc('https://www.bakeryapp.com/cb') } });
    if (h === 'accounts.google.com' && u.pathname.startsWith('/o/oauth2'))
      return route.fulfill(html(`<p>Choose an account</p><a id=ok href="${u.searchParams.get('redirect_uri')}?code=abc">Continue</a>
        <a id=cancel href="${u.searchParams.get('redirect_uri')}?error=access_denied">Cancel</a>`));
    if (h === 'www.bakeryapp.com') return route.fulfill(html('<h1>Bakery home</h1>'));

    if (h === 'notes.example.org' && u.pathname === '/')
      return route.fulfill(html(`<button id=apple onclick="window.open('https://appleid.apple.com/auth/authorize?client_id=x&redirect_uri=${enc('https://notes.example.org/apple-cb')}','p','width=400,height=500')">Sign in with Apple</button>`));
    if (h === 'appleid.apple.com') return route.fulfill(html(`<p>Apple</p><button id=close onclick="window.close()">Done</button>`));

    if (h === 'quick.devtool.io' && u.pathname === '/')
      return route.fulfill(html(`<a id=gh href="https://github.com/login/oauth/authorize?client_id=1&redirect_uri=${enc('https://quick.devtool.io/cb')}">GitHub</a>`));
    if (h === 'github.com' && u.pathname === '/login/oauth/authorize')
      return route.fulfill({ status: 302, headers: { location: 'https://quick.devtool.io/cb?code=1' } }); // already approved: instant bounce
    if (h === 'quick.devtool.io') return route.fulfill(html('<h1>Dev tool home</h1>'));

    if (h === 'cancel.shop') return route.fulfill(html(`<a id=g href="https://accounts.google.com/o/oauth2/auth?redirect_uri=${enc('https://cancel.shop/cb')}">Google</a>`));

    if (h === 'pk.site') return route.fulfill(html(`<button id=pk>Use passkey</button><script>
      document.getElementById('pk').onclick = async () => {
        const c = await navigator.credentials.create({ publicKey: { challenge: new Uint8Array(16), rp: { name: 'pk' }, user: { id: new Uint8Array(8), name: 'a', displayName: 'a' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }] } });
        document.title = c ? 'made' : 'none';
      };</script>`));
    return route.fulfill(html('ok'));
  };
  const https = require('https');
  const server = https.createServer({ key: fs.readFileSync(OUT+'/key.pem'), cert: fs.readFileSync(OUT+'/cert.pem') }, (req, res) => {
    const url = 'https://' + req.headers.host + req.url;
    handler({ request: () => ({ url: () => url }), continue: () => {}, fulfill: r => { res.writeHead(r.status, { 'content-type': r.contentType || 'text/html', ...(r.headers || {}) }); res.end(r.body || ''); } });
  });
  await new Promise(r => server.listen(443, '127.0.0.1', r));

  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  const read = async () => (await sw.evaluate(() => chrome.storage.local.get('accounts'))).accounts || {};
  const results = [];
  const check = (name, cond, detail) => { results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + JSON.stringify(detail)}`); };

  const page = await ctx.newPage();

  // 1. Same-tab Google sign-in that completes
  await page.goto('https://www.bakeryapp.com/login');
  await page.click('#g');
  await waitUrl(page, /accounts\.google\.com/);
  await page.click('#ok');
  await waitUrl(page, /bakeryapp\.com\/cb/);
  await sleep(500);
  let a = await read();
  check('google same-tab confirmed', a['bakeryapp.com']?.methods?.google?.confirmed === true, a['bakeryapp.com']);

  // 2. Password form, multi-field
  await page.goto('https://www.bakeryapp.com/login');
  await page.fill('#email', 'varen@example.com');
  await page.fill('#pw', 'hunter2');
  await page.click('#go');
  await sleep(800);
  a = await read();
  check('email/password sign-in not recorded', !a['bakeryapp.com']?.methods?.password && Object.keys(a['bakeryapp.com']?.methods || {}).join() === 'google', a['bakeryapp.com']);
  check('typed email and password not stored', !JSON.stringify(a).includes('hunter2') && !JSON.stringify(a).includes('varen@example.com'), null);
  const injected = await page.evaluate(() => !!(window.__authScopeLoaded || (window.CredentialsContainer && CredentialsContainer.prototype.__authScopeWrapped)));
  check('no AuthScope script runs on the site', !injected, injected);

  // 3. Popup Apple sign-in from another site
  await page.goto('https://notes.example.org/');
  const [popup] = await Promise.all([ctx.waitForEvent('page'), page.click('#apple')]);
  await popup.waitForLoadState();
  await sleep(500);
  await popup.click('#close').catch(() => {});
  await sleep(500);
  a = await read();
  check('apple popup attributed to opener', !!a['example.org']?.methods?.apple, Object.keys(a));

  // 4. Already-approved GitHub that redirects instantly
  await page.goto('https://quick.devtool.io/');
  await page.click('#gh');
  await waitUrl(page, /devtool\.io\/cb/);
  await sleep(500);
  a = await read();
  check('instant GitHub bounce caught + confirmed', a['devtool.io']?.methods?.github?.confirmed === true, a['devtool.io']);

  // 5. Cancelled Google sign-in leaves nothing
  await page.goto('https://cancel.shop/');
  await page.click('#g');
  await waitUrl(page, /accounts\.google/);
  await page.click('#cancel');
  await waitUrl(page, /error=access_denied/);
  await sleep(500);
  a = await read();
  check('cancelled sign-in removed', !a['cancel.shop'], a['cancel.shop']);

  // 6. Passkeys aren't watched: nothing hooks the page, and a passkey-style message is ignored
  await page.goto('https://pk.site/');
  const wrapped = await page.evaluate(() => !!CredentialsContainer.prototype.__authScopeWrapped);
  await page.evaluate(() => window.postMessage({ __authScope: 'passkey', kind: 'get' }, location.origin));
  await sleep(600);
  a = await read();
  check('passkey sign-in not recorded', !wrapped && !a['pk.site'], { wrapped, rec: a['pk.site'] });

  // 6b. Upgrading: password/passkey records saved by older versions are removed, providers kept
  await sw.evaluate(() => chrome.storage.local.set({
    accounts: {
      'old.site': { domain: 'old.site', note: '', methods: { password: { firstSeen: 1, lastSeen: 2, count: 1, confirmed: true, source: 'detected', username: 'me@x.ie' } } },
      'mixed.site': { domain: 'mixed.site', note: '', methods: { passkey: { firstSeen: 1, lastSeen: 2, count: 1, confirmed: true, source: 'detected' }, google: { firstSeen: 1, lastSeen: 2, count: 1, confirmed: true, source: 'detected' } } },
    },
    settings: { trackPasswords: true, saveUsernames: true, trackPasskeys: true, showBadge: true },
  }));
  const up = await ctx.newPage();
  await up.goto(`chrome-extension://${extId}/dashboard.html`); await sleep(800);
  const shownSites = await up.$$eval('#list .entry', e => e.length);
  await up.close();
  const after = await sw.evaluate(() => chrome.storage.local.get(['accounts', 'settings']));
  check('older password/passkey records removed on update', !after.accounts['old.site'] && JSON.stringify(Object.keys(after.accounts['mixed.site']?.methods || {})) === '["google"]' && JSON.stringify(after.settings) === '{"showBadge":true}' && shownSites === 1, { after, shownSites });

  // 7. History scan is switched off: button and welcome box hidden, no history permission
  await sw.evaluate(() => chrome.storage.local.set({ accounts: {} }));
  const dash = await ctx.newPage();
  await dash.goto(`chrome-extension://${extId}/dashboard.html?welcome=1`);
  await sleep(400);
  const vis = await dash.evaluate(() => ({
    scan: getComputedStyle(document.getElementById('scan')).display,
    welcome: getComputedStyle(document.getElementById('welcome')).display,
    empty: document.getElementById('empty').textContent,
  }));
  const hasHistory = await sw.evaluate(() => chrome.permissions.contains({ permissions: ['history'] }));
  check('history scan hidden', vis.scan === 'none' && vis.welcome === 'none' && /check your accounts/i.test(vis.empty) && !hasHistory, { vis, hasHistory });

  // Seed realistic data for screenshots
  const day = 864e5, now = Date.now();
  await sw.evaluate(({ now, day }) => chrome.storage.local.set({ accounts: {
    'notion.so': { domain: 'notion.so', note: '', methods: { google: { firstSeen: now - 200*day, lastSeen: now - 2*day, count: 9, confirmed: true, source: 'detected' } } },
    'figma.com': { domain: 'figma.com', note: 'Work files', methods: { google: { firstSeen: now - 90*day, lastSeen: now - 10*day, count: 3, confirmed: true, source: 'history' }, password: { firstSeen: now - 400*day, lastSeen: now - 300*day, count: 1, confirmed: true, source: 'detected', username: 'varen@example.com' } } },
    'vercel.com': { domain: 'vercel.com', note: '', methods: { github: { firstSeen: now - 30*day, lastSeen: now - 3600e3, count: 12, confirmed: true, source: 'detected' } } },
    'chatgpt.com': { domain: 'chatgpt.com', note: '', methods: { apple: { firstSeen: now - 60*day, lastSeen: now - 5*day, count: 4, confirmed: true, source: 'detected' } } },
    'booking.com': { domain: 'booking.com', note: '', methods: { facebook: { firstSeen: now - 80*day, lastSeen: now - 80*day, count: 1, confirmed: false, source: 'history' } } },
    'github.com': { domain: 'github.com', note: '', methods: { gitlab: { firstSeen: now - 20*day, lastSeen: now - 1*day, count: 5, confirmed: true, source: 'detected' } } },
    'canva.com': { domain: 'canva.com', note: '', methods: { microsoft: { firstSeen: now - 14*day, lastSeen: now - 14*day, count: 1, confirmed: true, source: 'manual' }, google: { firstSeen: now - 120*day, lastSeen: now - 40*day, count: 2, confirmed: false, source: 'history' } } },
    'Spotify': { domain: 'Spotify', note: '', methods: { facebook: { firstSeen: now - 500*day, lastSeen: now - 500*day, count: 1, confirmed: true, source: 'manual' } } },
  }}), { now, day });

  for (const scheme of ['light', 'dark']) {
    await dash.emulateMedia({ colorScheme: scheme });
    await dash.setViewportSize({ width: 1280, height: 860 });
    await dash.goto(`chrome-extension://${extId}/dashboard.html`);
    await sleep(400);
    await dash.screenshot({ path: `${OUT}/dash-${scheme}.png`, fullPage: true });
  }
  await dash.setViewportSize({ width: 390, height: 900 });
  await dash.emulateMedia({ colorScheme: 'light' });
  await dash.goto(`chrome-extension://${extId}/dashboard.html`);
  await sleep(300);
  await dash.screenshot({ path: `${OUT}/dash-mobile.png`, fullPage: true });

  // Popup rendered as a page (it reads the active tab, so fake one via query override)
  const pop = await ctx.newPage();
  await pop.setViewportSize({ width: 340, height: 420 });
  await pop.addInitScript(() => {
    const q = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async () => [{ id: 1, url: 'https://www.figma.com/files' }];
  });
  await pop.goto(`chrome-extension://${extId}/popup.html`);
  await sleep(400);
  await pop.screenshot({ path: `${OUT}/popup.png` });
  await pop.addInitScript(() => { chrome.tabs.query = async () => [{ id: 1, url: 'https://www.newsite.ie/login' }]; });
  await pop.goto(`chrome-extension://${extId}/popup.html`);
  await sleep(400);
  await pop.screenshot({ path: `${OUT}/popup-empty.png` });

  const errs = [];
  console.log(results.join('\n'));
  await ctx.close(); server.close();
  if (results.some(r => r.startsWith('FAIL'))) process.exitCode = 1;
})().catch(e => { console.error('ERROR', e); process.exit(1); });
