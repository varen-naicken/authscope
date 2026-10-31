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
      <div class="Box-row"><a href="/settings/connections/applications/c3">CodeSandbox</a><button>Revoke</button></div>
      <div class="Box-row"><a href="/settings/connections/applications/d4">Ollama</a><button>Revoke</button></div></div></main>`);
  if (h === 'github.com' && p.startsWith('/settings/connections/applications/')) {
    const homes = { a1: 'https://vercel.com', b2: 'https://www.notion.so/product', d4: 'https://ollama.com/' };
    const home = homes[p.split('/').pop()];
    return page(`<main><h1>App</h1>${home ? `<a href="${home}">Homepage</a>` : ''}<a href="https://github.com/someorg">someorg</a><a href="https://docs.github.com/x">Docs</a></main>
      <footer><a href="https://x.com/github">X</a><a href="https://www.linkedin.com/company/github">LinkedIn</a><a href="https://www.youtube.com/github">YouTube</a></footer>`);
  }
  if (h === 'github.com' && p === '/settings/apps/authorizations') { globalThis.githubAppsVisited = true; return page(`<main><div class="Box"><div class="Box-row"><a href="/apps/copilot-swe-agent">Copilot SWE Agent</a><button>Revoke</button></div></div></main>`); }
  // Mirrors Google's current "Linked apps" layout: app links to linkedapps/overview/<id>, rendered late,
  // plus a settings link, a sign-out link carrying ?continue=...connections, and a duplicate entry.
  if (h === 'myaccount.google.com' && p === '/connections') return page(`<header><a href="https://accounts.google.com/SignOutOptions?continue=https://myaccount.google.com/connections">Account</a></header>
      <main id=m><h1>Linked apps</h1><a href="linkedapps/settings">Sign-in settings for apps</a><input placeholder="Search linked apps by name">
      <button aria-label="Show apps that have some access to your Google Account">Access to (2)</button><ul id=l></ul></main><script>
      setTimeout(() => { document.getElementById('l').innerHTML = ['Notion','Figma','Duolingo','Figma'].map((n, i) =>
        '<li><a href="linkedapps/overview/AUKa' + i + '"><img alt=""><div>' + n + '</div></a></li>').join(''); }, 1200);</script>`, 'Linked apps');
  if (h === 'myaccount.google.com' && p.startsWith('/linkedapps/overview/')) {
    const sites = { AUKa0: 'https://www.notion.so/privacy', AUKa1: 'https://www.figma.com/legal', AUKa2: 'https://www.duolingo.com/terms' };
    const site = sites[p.split('/').pop()];
    return page(`<script>var c={a:"https://www.gstatic.com/x.js",b:"https://myaccount.google.com/y",c:"https://g.co/z"}</script><h1>App</h1>${site ? `<a href="${site}">Privacy</a>` : ''}<a href="https://support.google.com/q">Help</a>`);
  }
  if (h === 'ollama.com' || h === 'www.netlify.com' || h === 'app.netlify.com') return page('<h1>Welcome</h1>');
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
  await sw.evaluate(() => chrome.storage.local.set({ _unused: {
    'notion.so': { domain: 'notion.so', note: '', methods: { google: { firstSeen: 1, lastSeen: Date.now() - 864e5, count: 1, confirmed: true, source: 'detected' } } },
    'Vercel': { domain: 'Vercel', note: 'old entry', methods: { github: { firstSeen: 1, lastSeen: Date.now() - 864e5, count: 1, confirmed: true, source: 'provider' } } },
    'Netlify Auth': { domain: 'Netlify Auth', note: '', methods: { github: { firstSeen: 1, lastSeen: Date.now() - 864e5, count: 1, confirmed: true, source: 'detected' } } },
    'Copilot SWE Agent': { domain: 'Copilot SWE Agent', note: '', methods: { github: { firstSeen: 1, lastSeen: Date.now() - 864e5, count: 1, confirmed: true, source: 'provider' } } },
    'Claude': { domain: 'Claude', note: '', methods: { github: { firstSeen: 1, lastSeen: Date.now() - 864e5, count: 1, confirmed: true, source: 'provider' }, google: { firstSeen: 1, lastSeen: Date.now() - 864e5, count: 1, confirmed: true, source: 'manual' } } },
  } }));


  const results = [];
  const check = (name, cond, detail) => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + JSON.stringify(detail)}`);
  const errors = [];
  const get = k => sw.evaluate(k => chrome.storage.local.get(k), k);

  // 1. Fresh install: the dashboard opens with ?welcome=1 and an empty list
  const dash = await ctx.newPage(); dash.on('pageerror', e => errors.push(String(e)));
  await dash.setViewportSize({ width: 1280, height: 1000 });
  await dash.goto(`chrome-extension://${extId}/dashboard.html?welcome=1`); await sleep(700);
  const st = await dash.evaluate(() => ({
    onboard: !document.getElementById('onboard').hidden,
    access: !document.getElementById('stepAccess').hidden,
    banner: !document.getElementById('access').hidden,
    steps: [...document.querySelectorAll('.onboard-steps li')].filter(l => !l.hidden).map(l => l.querySelector('h3').textContent),
  }));
  check('welcome guide shows on first run', st.onboard && !st.banner, st);
  check('Chrome skips the Allow step (access already granted)', !st.access && st.steps.length === 3, st.steps);
  await dash.screenshot({ path: `${OUT}/onboard-start.png`, clip: { x: 0, y: 0, width: 1280, height: 640 } });

  // 2. Check all now: progress, then results
  const seen = [];
  await dash.click('#onboardCheck');
  for (let i = 0; i < 60; i++) {
    const t = await dash.textContent('#onboardProgressText');
    if (!seen.includes(t)) seen.push(t);
    if (/^Found/.test(t)) break;
    await sleep(500);
  }
  await sleep(500);
  const fin = await dash.evaluate(() => ({
    text: document.getElementById('onboardProgressText').textContent,
    btn: document.getElementById('onboardCheck').textContent,
    done: document.getElementById('stepCheck').classList.contains('done'),
    rows: document.querySelectorAll('#list .entry').length,
    chart: !document.getElementById('chartPanel').hidden,
  }));
  check('progress counts up while checking', seen.some(t => /^Checked \d+ of 11 accounts/.test(t)), seen);
  check('finishes with what was found, list and chart filled', /^Found 13 apps\. Your list is below\. Sign in to Microsoft, Facebook, X \/ Twitter, Amazon/.test(fin.text) && fin.btn === 'Done' && fin.done && fin.rows > 5 && fin.chart, fin);
  check('marked as done once something was found', (await get('onboarding')).onboarding === 'done', null);
  await dash.screenshot({ path: `${OUT}/onboard-done.png`, clip: { x: 0, y: 0, width: 1280, height: 900 } });
  await dash.click('#onboardCheck'); await sleep(300);
  check('Done closes the guide', await dash.$eval('#onboard', e => e.hidden), null);

  // 3. Never comes back, even with ?welcome=1
  await dash.goto(`chrome-extension://${extId}/dashboard.html?welcome=1`); await sleep(600);
  check('does not show again after finishing', await dash.$eval('#onboard', e => e.hidden), null);

  // 4. Existing users (list already filled, never saw the guide) don't get it
  await sw.evaluate(() => chrome.storage.local.remove('onboarding'));
  await dash.goto(`chrome-extension://${extId}/dashboard.html`); await sleep(600);
  check('existing users with a list never see it', await dash.$eval('#onboard', e => e.hidden), null);

  // 5. Skip: empty list again, guide shows, Skip hides it for good
  await sw.evaluate(() => chrome.storage.local.set({ accounts: {} }));
  await dash.goto(`chrome-extension://${extId}/dashboard.html`); await sleep(600);
  const shownEmpty = !(await dash.$eval('#onboard', e => e.hidden));
  const emptyText = await dash.textContent('#empty');
  await dash.click('#onboardSkip'); await sleep(300);
  const afterSkip = await dash.evaluate(() => ({ hidden: document.getElementById('onboard').hidden }));
  await dash.reload(); await sleep(600);
  check('an empty list shows the guide; Skip hides it for good', shownEmpty && afterSkip.hidden && await dash.$eval('#onboard', e => e.hidden) && (await get('onboarding')).onboarding === 'done', { shownEmpty, afterSkip });
  check('empty list text points to the guide while it is open', /once you check your accounts/.test(emptyText), emptyText);

  // 6. Popup: empty list offers Get started, which opens the guide
  await sw.evaluate(() => chrome.storage.local.remove('onboarding'));
  const pop = await ctx.newPage(); pop.on('pageerror', e => errors.push(String(e)));
  await pop.setViewportSize({ width: 340, height: 420 });
  await pop.addInitScript(() => { chrome.tabs.query = async () => [{ id: 1, url: 'https://www.example.org/' }]; });
  await pop.goto(`chrome-extension://${extId}/popup.html`); await sleep(500);
  const startShown = !(await pop.$eval('#start', e => e.hidden));
  await pop.screenshot({ path: `${OUT}/onboard-popup.png` });
  const [opened] = await Promise.all([ctx.waitForEvent('page'), pop.click('#startBtn')]);
  await sleep(800);
  check('popup offers Get started when the list is empty', startShown, null);
  check('Get started opens the welcome guide', /dashboard\.html\?welcome=1$/.test(opened.url()) && !(await opened.$eval('#onboard', e => e.hidden)), opened.url());

  check('no page errors', errors.length === 0, errors);
  console.log(results.join('\n'));
  await ctx.close(); server.close();
  if (results.some(r => r.startsWith('FAIL'))) process.exitCode = 1;
})().catch(e => { console.error('ERROR', e); process.exit(1); });
