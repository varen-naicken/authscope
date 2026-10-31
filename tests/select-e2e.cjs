const { chromium } = require('playwright');
const path = require('path'), fs = require('fs'), https = require('https');
const EXT = process.env.AUTHSCOPE_EXT || path.resolve(__dirname, '..');
const OUT = path.join(require('os').tmpdir(), 'authscope-tests');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const page = (body, title = 'Settings') => ({ status: 200, body: `<!doctype html><meta charset=utf-8><title>${title}</title><body>${body}</body>` });
const redirect = loc => ({ status: 302, headers: { location: loc } });

// Mock connected-apps pages: some signed in, some signed out, some rendered late by script.
const ICON = fs.readFileSync(path.join(__dirname, 'fixtures', 'placeholder-icon.png'));
function respond(u) {
  const h = u.hostname, p = u.pathname;
  if (p === '/favicon.ico') return h === 'gitlab.com' ? { status: 404, body: '' } : { status: 200, type: 'image/png', body: ICON };
  if (h === 'github.com' && p === '/settings/applications') return page(`<main><h2>Authorized OAuth Apps</h2><div class="Box">
      <div class="Box-row"><a href="/settings/connections/applications/a1"><img alt=""> Vercel</a><div>Last used within the last week · Owned by vercel</div><button>Revoke</button></div>
      <div class="Box-row"><a href="/settings/connections/applications/b2">Notion</a><div>Last used within the last 6 months</div><button>Revoke</button></div>
      <div class="Box-row"><a href="/settings/connections/applications/c3">CodeSandbox</a><button>Revoke</button></div></div></main>`);
  if (h === 'github.com' && p === '/settings/apps/authorizations') return page(`<main><div class="Box"><div class="Box-row"><a href="/apps/netlify">Netlify</a><button>Revoke</button></div></div></main>`);
  // Mirrors Google's current "Linked apps" layout: app links to linkedapps/overview/<id>, rendered late,
  // plus a settings link, a sign-out link carrying ?continue=...connections, and a duplicate entry.
  if (h === 'myaccount.google.com' && p === '/connections') return page(`<header><a href="https://accounts.google.com/SignOutOptions?continue=https://myaccount.google.com/connections">Account</a></header>
      <main id=m><h1>Linked apps</h1><a href="linkedapps/settings">Sign-in settings for apps</a><input placeholder="Search linked apps by name">
      <button aria-label="Show apps that have some access to your Google Account">Access to (2)</button><ul id=l></ul></main><script>
      setTimeout(() => { document.getElementById('l').innerHTML = ['Notion','Figma','Duolingo','Figma'].map((n, i) =>
        '<li><a href="linkedapps/overview/AUKa' + i + '"><img alt=""><div>' + n + '</div></a></li>').join(''); }, 1200);</script>`, 'Linked apps');
  if (h === 'account.live.com') return redirect('https://login.live.com/login.srf?wa=wsignin1.0');
  if (h === 'login.live.com') return page('<input type=email><input type=password>', 'Sign in');
  if (h === 'www.linkedin.com' && p.startsWith('/psettings')) return page(`<ul>
      <li><div><img><p>Medium</p><p>Last accessed 2 days ago</p></div><button>Remove</button></li>
      <li><div><img><p>Eventbrite</p><p>Last accessed 1 year ago</p></div><button>Remove</button></li></ul>`);
  if (h === 'www.facebook.com') return page('<form><input type=email name=email><input type=password name=pass><button>Log in</button></form>', 'Log in to Facebook');
  if (h === 'x.com' && p === '/settings/connected_apps') return page(`<div id=r>Loading…</div><script>setTimeout(()=>location.href='/i/flow/login', 400)</script>`);
  if (h === 'x.com') return page('<input name=text autocomplete=username>', 'Log in to X');
  if (h === 'discord.com') return page(`<nav class="sidebar-1"><div role="tablist"><div role="tab">My Account</div><div role="tab" id=t>Authorized Apps</div></div></nav><div id=c></div><script>
      document.getElementById('t').onclick = () => { document.getElementById('c').innerHTML =
        '<div class="app"><div><h3>MEE6</h3><p>About this app</p></div><button>Deauthorize</button></div>' +
        '<div class="app"><div><h3>Spotify</h3></div><button>Deauthorize</button></div>'; };</script>`);
  if (h === 'gitlab.com') return page(`<h4>Authorized applications</h4><table><tr><th>Name</th><th>Authorized at</th><th></th></tr>
      <tr><td>Render</td><td>2025-02-01</td><td><a class="btn">Revoke</a></td></tr></table>`);
  if (h === 'www.amazon.com') return redirect('https://www.amazon.com/ap/signin?openid.return_to=x');
  if (h === 'www.twitch.tv') return page(`<h2>Other connections</h2><div><div><p>Streamlabs</p><p>Connected on Jan 3, 2025</p></div><button>Disconnect</button></div>`);
  if (h === 'login.yahoo.com') return page(`<h1>App access</h1><p>You have no connected apps.</p>`);
  return page('ok');
}

(async () => {
  const server = https.createServer({ key: fs.readFileSync(OUT + '/key.pem'), cert: fs.readFileSync(OUT + '/cert.pem') }, (req, res) => {
    const r = respond(new URL('https://' + req.headers.host + req.url));
    res.writeHead(r.status, { 'content-type': r.type || 'text/html', ...(r.headers || {}) }); res.end(r.body || '');
  });
  await new Promise(r => server.listen(443, '127.0.0.1', r));

  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(OUT, 'profile-')), {
    headless: true, channel: 'chromium', ignoreHTTPSErrors: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP * 127.0.0.1', '--ignore-certificate-errors', '--no-proxy-server'],
  });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  await sw.evaluate(() => chrome.storage.local.set({ accounts: { 'notion.so': { domain: 'notion.so', note: '', methods: { google: { firstSeen: 1, lastSeen: Date.now() - 864e5, count: 1, confirmed: true, source: 'detected' } } } } }));

  const results = [];
  const check = (name, cond, detail) => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + JSON.stringify(detail)}`);

  const dash = await ctx.newPage();
  await dash.setViewportSize({ width: 1280, height: 900 });
  await dash.goto(`chrome-extension://${extId}/dashboard.html`);
  await sleep(300);
  const btnState = () => dash.$eval('#syncSelected', b => ({ text: b.textContent, disabled: b.disabled }));

  check('Check selected starts disabled', (await btnState()).disabled, await btnState());

  // Tick LinkedIn by its checkbox and GitHub by clicking its name (the label)
  await dash.check('input[aria-label="Select LinkedIn"]');
  await dash.click('.sync-row label.pname:has-text("GitHub")');
  let b = await btnState();
  check('count shown on button', b.text === 'Check selected (2)' && !b.disabled, b);
  const mixed = await dash.$eval('#selectAll', i => i.indeterminate);
  check('select-all shows partial state', mixed, mixed);

  await dash.click('#syncSelected');
  await dash.waitForFunction(() => /^Found \d+ app/.test(document.getElementById('status').textContent), null, { timeout: 60000 });
  const state = await sw.evaluate(() => chrome.storage.local.get('providerSync').then(r => r.providerSync || {}));
  check('only selected providers checked', JSON.stringify(Object.keys(state).sort()) === JSON.stringify(['github', 'linkedin']), Object.keys(state));
  check('selected results correct', state.github.apps.length === 3 && state.linkedin.apps.length === 2, state);
  const providersInLedger = await sw.evaluate(() => chrome.storage.local.get('accounts').then(r =>
    [...new Set(Object.values(r.accounts || {}).flatMap(a => Object.entries(a.methods).filter(([, m]) => m.source === 'provider').map(([k]) => k)))].sort()));
  check('ledger gets only those two', JSON.stringify(providersInLedger) === JSON.stringify(['github', 'linkedin']), providersInLedger);

  // Selection remembered after reload
  await dash.reload();
  await sleep(400);
  const kept = await dash.$$eval('#syncRows input[type=checkbox]:checked', bs => bs.map(x => x.getAttribute('aria-label')));
  check('selection remembered after reload', JSON.stringify(kept) === JSON.stringify(['Select GitHub', 'Select LinkedIn']), kept);
  await dash.screenshot({ path: `${OUT}/select-panel.png`, clip: { x: 860, y: 0, width: 420, height: 900 } });

  // Select all / none
  await dash.check('#selectAll');
  b = await btnState();
  check('select all ticks all 11', b.text === 'Check selected (11)', b);
  await dash.uncheck('#selectAll');
  b = await btnState();
  check('select none clears', b.text === 'Check selected' && b.disabled, b);

  console.log(results.join('\n'));
  await ctx.close(); server.close();
  if (results.some(r => r.startsWith('FAIL'))) process.exitCode = 1;
})().catch(e => { console.error('ERROR', e); process.exit(1); });
