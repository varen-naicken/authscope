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
  await sw.evaluate(() => chrome.storage.local.set({ accounts: {
    'notion.so': { domain: 'notion.so', note: '', methods: { google: { firstSeen: 1, lastSeen: Date.now() - 864e5, count: 1, confirmed: true, source: 'detected' } } },
    'Vercel': { domain: 'Vercel', note: 'old entry', methods: { github: { firstSeen: 1, lastSeen: Date.now() - 864e5, count: 1, confirmed: true, source: 'provider' } } },
    'Netlify Auth': { domain: 'Netlify Auth', note: '', methods: { github: { firstSeen: 1, lastSeen: Date.now() - 864e5, count: 1, confirmed: true, source: 'detected' } } },
    'Copilot SWE Agent': { domain: 'Copilot SWE Agent', note: '', methods: { github: { firstSeen: 1, lastSeen: Date.now() - 864e5, count: 1, confirmed: true, source: 'provider' } } },
    'Claude': { domain: 'Claude', note: '', methods: { github: { firstSeen: 1, lastSeen: Date.now() - 864e5, count: 1, confirmed: true, source: 'provider' }, google: { firstSeen: 1, lastSeen: Date.now() - 864e5, count: 1, confirmed: true, source: 'manual' } } },
  } }));

  const results = [];
  const check = (name, cond, detail) => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + JSON.stringify(detail)}`);

  const dash = await ctx.newPage();
  await dash.setViewportSize({ width: 1280, height: 900 });
  await dash.goto(`chrome-extension://${extId}/dashboard.html`);
  const t0 = Date.now();
  await dash.click('#syncAll');
  await dash.waitForFunction(() => /^Found \d+ app/.test(document.getElementById('status').textContent), null, { timeout: 120000 });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const state = await sw.evaluate(() => chrome.storage.local.get('providerSync').then(r => r.providerSync));
  const apps = id => (state[id]?.apps || []).slice().sort();
  const st = id => state[id]?.status;

  check('github: OAuth apps only', JSON.stringify(apps('github')) === JSON.stringify(['CodeSandbox', 'Notion', 'Ollama', 'Vercel']), state.github);
  check('github: Authorized GitHub Apps page never opened', !globalThis.githubAppsVisited, null);
  check('google: Linked apps layout, duplicates and settings links ignored', JSON.stringify(apps('google')) === JSON.stringify(['Duolingo', 'Figma', 'Notion']), state.google);
  check('microsoft: redirect to login detected', st('microsoft') === 'login', state.microsoft);
  check('linkedin: names beside Remove buttons', JSON.stringify(apps('linkedin')) === JSON.stringify(['Eventbrite', 'Medium']), state.linkedin);
  check('facebook: sign-in form detected', st('facebook') === 'login', state.facebook);
  check('x: script redirect to login detected', st('x') === 'login', state.x);
  check('discord: clicks into Authorized Apps', JSON.stringify(apps('discord')) === JSON.stringify(['MEE6', 'Spotify']), state.discord);
  check('gitlab: table rows', JSON.stringify(apps('gitlab')) === JSON.stringify(['Render']), state.gitlab);
  check('amazon: login redirect', st('amazon') === 'login', state.amazon);
  check('twitch', JSON.stringify(apps('twitch')) === JSON.stringify(['Streamlabs']), state.twitch);
  check('yahoo: none found, not an error', st('yahoo') === 'ok' && apps('yahoo').length === 0, state.yahoo);
  const leftover = (await sw.evaluate(() => chrome.tabs.query({}))).filter(t => !t.url.startsWith('chrome-extension')).length;
  check('background tabs all closed', leftover <= 1, leftover);

  await sleep(800);
  const icons = await dash.evaluate(() => ({
    loaded: [...document.querySelectorAll('#syncRows img.picon')].filter(i => i.complete && i.naturalWidth > 0).length,
    fallback: document.querySelectorAll('#syncRows .pdot').length,
    rows: document.querySelectorAll('#syncRows .sync-row').length,
    gitlabFallback: !!document.querySelector('#syncRows .sync-row:nth-child(8) .pdot'),
  }));
  check('provider icons load in account rows', icons.loaded === icons.rows - 1 && icons.fallback === 1 && icons.gitlabFallback, icons);
  await dash.screenshot({ path: `${OUT}/sync-results.png`, fullPage: true });

  // Which icons each account row shows depends on what its last check found.
  const rowButtons = await dash.$$eval('#syncRows .sync-row', rows => rows.map(r => ({
    name: r.querySelector('.pname').textContent.trim(),
    buttons: [...r.querySelectorAll('.row-actions button')].map(b => b.dataset.tip),
    labelled: [...r.querySelectorAll('.row-actions button')].every(b => b.getAttribute('aria-label')?.startsWith(b.dataset.tip) && !b.textContent.trim() && b.querySelector('svg')),
    signInPrimary: r.querySelector('.row-actions button[data-tip="Sign in"]')?.classList.contains('primary'),
  })));
  // One icon per row, from the check above: Sign in where signed out, Manage where apps were found, otherwise Check.
  const want = { Google: 'Manage', GitHub: 'Manage', Microsoft: 'Sign in', LinkedIn: 'Manage', Facebook: 'Sign in', 'X / Twitter': 'Sign in',
    Discord: 'Manage', GitLab: 'Manage', Amazon: 'Sign in', Twitch: 'Manage', Yahoo: 'Check', Apple: 'Manage' };
  const wrong = rowButtons.filter(r => want[r.name] !== r.buttons.join(','));
  check('Check becomes Manage when apps were found, Sign in when signed out', !wrong.length && rowButtons.length === 12, wrong);
  check('Sign in is highlighted', rowButtons.filter(r => r.buttons.includes('Sign in')).every(r => r.signInPrimary), rowButtons);
  check('icons are labelled for screen readers', rowButtons.every(r => r.labelled), rowButtons);
  const opens = async (row, label) => {
    const [tab] = await Promise.all([ctx.waitForEvent('page'), dash.click(`.sync-row:has-text("${row}") .row-actions button[data-tip="${label}"]`)]);
    const url = tab.url(); await tab.close(); return url;
  };
  await dash.hover('.sync-row:has-text("Yahoo") .row-actions button[data-tip="Check"]'); await sleep(250);
  const tip = await dash.$eval('.sync-row:has-text("Yahoo") .row-actions button[data-tip="Check"]', b => { const s = getComputedStyle(b, '::after'); return { text: s.content, opacity: s.opacity }; });
  check('hovering an icon shows its action', tip.text === '"Check"' && tip.opacity === '1', tip);
  await dash.screenshot({ path: `${OUT}/sync-tooltip.png`, clip: { x: 760, y: 280, width: 460, height: 160 } });
  const ghManage = await opens('GitHub', 'Manage');
  check('Manage opens the connected-apps page', ghManage === 'https://github.com/settings/applications', ghManage);
  const msSignIn = await opens('Microsoft', 'Sign in');
  check('Sign in opens the provider sign-in page', msSignIn.startsWith('https://login.live.com/'), msSignIn);

  // Found apps go straight into the ledger, no review step.
  // Notion (google) was already there: it must not be counted as new. Notion (github) maps onto notion.so.
  const ledger = await sw.evaluate(() => chrome.storage.local.get('accounts').then(r => r.accounts));
  const status = await dash.textContent('#status');
  check('no review step shown', !(await dash.$('#review')), null);
  check('everything added straight away', !!ledger['Streamlabs']?.methods?.twitch && !!ledger['duolingo.com']?.methods?.google && !!ledger['Render']?.methods?.gitlab, Object.keys(ledger));
  check('github Notion merged into notion.so', !!ledger['notion.so']?.methods?.github && ledger['notion.so'].methods.github.source === 'provider', ledger['notion.so']);
  check('names kept when no website', !!ledger['MEE6']?.methods?.discord && !!ledger['CodeSandbox']?.methods?.github, Object.keys(ledger));
  check('github websites: Ollama filed as ollama.com, footer links ignored', ledger['ollama.com']?.name === 'Ollama' && !!ledger['ollama.com'].methods.github && !ledger['ollama.com'].websites, ledger['ollama.com']);
  check('google websites: Figma filed as figma.com', ledger['figma.com']?.name === 'Figma' && !!ledger['figma.com'].methods.google && !ledger['Figma'], { f: ledger['figma.com'], keys: Object.keys(ledger) });
  check('old name-only entry moved to its website, note kept', !ledger['Vercel'] && ledger['vercel.com']?.name === 'Vercel' && ledger['vercel.com'].note === 'old entry', { keys: Object.keys(ledger), v: ledger['vercel.com'] });
  check('no Google / GitHub own domains saved as websites', !Object.values(ledger).some(e => (e.websites || []).some(w => /google|gstatic|g\.co|github|linkedin|youtube|x\.com/.test(w))), Object.values(ledger).map(e => [e.domain, e.websites]));
  check('status counts new vs existing', /Found 13 apps: added 11 new to your ledger, 2 were already there\. Removed 2 apps no longer listed in those accounts\./.test(status), status);
  check('apps no longer listed by GitHub removed', !ledger['Copilot SWE Agent'] && !ledger['Claude']?.methods?.github, { copilot: ledger['Copilot SWE Agent'], claude: ledger['Claude'] });
  check('other tags on the same entry kept', !!ledger['Claude']?.methods?.google, ledger['Claude']);
  check('sign-ins AuthScope saw are never removed by a check', !!ledger['Netlify Auth']?.methods?.github, ledger['Netlify Auth']);

  // Clicking "4 apps" on GitHub filters the ledger to GitHub
  await dash.click('.sync-row:has-text("GitHub") button.state.ok');
  await sleep(300);
  const shown = await dash.$$eval('#list .entry .domain > :first-child', d => d.map(x => x.textContent.trim()).sort());
  check('app count filters ledger to that provider', JSON.stringify(shown) === JSON.stringify(['CodeSandbox', 'Netlify Auth', 'Notion', 'Ollama', 'Vercel']), shown);
  const ollamaRow = await dash.$eval('#list .entry:has-text("Ollama") .domain', d => d.innerText);
  check('ledger shows Ollama with its website', /Ollama\s*ollama\.com/.test(ollamaRow), ollamaRow);
  await dash.selectOption('#filter', '');

  // Checking again doesn't duplicate anything
  const before = Object.keys(ledger).length;
  // Twitch shows Manage now, so re-check it by ticking it and using Check selected.
  await dash.click('.sync-row:has-text("Twitch") label.pname input');
  await dash.click('#syncSelected');
  await dash.waitForFunction(() => /already there/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
  const after = Object.keys(await sw.evaluate(() => chrome.storage.local.get('accounts').then(r => r.accounts))).length;
  const status2 = await dash.textContent('#status');
  check('re-check adds nothing twice', before === after && /added 0 new/.test(status2), { before, after, status2 });
  await sleep(600);
  const tagIcons = await dash.evaluate(() => document.querySelectorAll('#list .tag.has-icon img.picon').length);
  check('provider icons inside ledger tags', tagIcons >= 10, tagIcons);
  await dash.screenshot({ path: `${OUT}/sync-after.png`, fullPage: true });

  // Visit sites: the toolbar badge should show the provider used for them.
  const badgeFor = async url => {
    const pg = await ctx.newPage();
    await pg.goto(url); await sleep(700);
    const r = await sw.evaluate(async u => {
      const [t] = await chrome.tabs.query({ url: u + '*' });
      return { text: await chrome.action.getBadgeText({ tabId: t.id }), title: await chrome.action.getTitle({ tabId: t.id }) };
    }, url);
    await pg.close();
    return r;
  };
  const ol = await badgeFor('https://ollama.com/');
  check('badge on ollama.com shows GitHub', ol.text === 'GH' && /GitHub/.test(ol.title), ol);
  const nl = await badgeFor('https://app.netlify.com/');
  check('badge on app.netlify.com matches "Netlify Auth"', nl.text === 'GH', nl);
  const gh = await badgeFor('https://github.com/');
  check('no badge on github.com from "GitHub Desktop"-style names', gh.text === '', gh);

  // Popup on ollama.com explains the match
  const pop = await ctx.newPage();
  await pop.setViewportSize({ width: 340, height: 380 });
  await pop.addInitScript(() => { chrome.tabs.query = async () => [{ id: 1, url: 'https://ollama.com/' }]; });
  await pop.goto(`chrome-extension://${extId}/popup.html`); await sleep(500);
  const popText = await pop.evaluate(() => document.body.innerText);
  check('popup on ollama.com lists GitHub', /Listed as Ollama/.test(popText) && /GitHub/.test(popText), popText.slice(0, 200));
  await pop.screenshot({ path: `${OUT}/popup-ollama.png` });

  console.log(results.join('\n'));
  console.log(`Check all took ${secs}s`);
  await ctx.close(); server.close();
  if (results.some(r => r.startsWith('FAIL'))) process.exitCode = 1;
})().catch(e => { console.error('ERROR', e); process.exit(1); });
