// "Check your accounts": open each provider's connected-apps page in a background tab,
// read the list of apps, and hand it back for review. Runs from the dashboard page.

// pages: the connected-apps pages that get read (and that Manage opens). signIn: where Sign in takes you.
export const SYNC_PROVIDERS = [
  { id: 'google', pages: ['https://myaccount.google.com/connections'], signIn: 'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fmyaccount.google.com%2Fconnections',
    login: /^https:\/\/accounts\.google\.com\// },
  // Authorized OAuth Apps only: those are "Sign in with GitHub". Authorized GitHub Apps are tools given
  // access to your code (e.g. coding agents), not sign-ins, so that page isn't read.
  { id: 'github', pages: ['https://github.com/settings/applications'], signIn: 'https://github.com/login?return_to=%2Fsettings%2Fapplications',
    login: /^https:\/\/github\.com\/(login|session|sessions)(\/|\?|$)/ },
  { id: 'microsoft', pages: ['https://account.live.com/consent/Manage'], signIn: 'https://login.live.com/',
    login: /^https:\/\/(login\.live\.com|login\.microsoftonline\.com)\// },
  { id: 'linkedin', pages: ['https://www.linkedin.com/psettings/permitted-services'], signIn: 'https://www.linkedin.com/login',
    login: /^https:\/\/www\.linkedin\.com\/(login|uas\/|checkpoint\/|authwall|signup)/ },
  { id: 'facebook', pages: ['https://www.facebook.com/settings/?tab=applications'], signIn: 'https://www.facebook.com/login/',
    login: /^https:\/\/(www|m)\.facebook\.com\/(login|checkpoint|recover)/ },
  { id: 'x', pages: ['https://x.com/settings/connected_apps'], signIn: 'https://x.com/i/flow/login',
    login: /^https:\/\/(x|twitter)\.com\/(i\/flow\/login|login)/ },
  { id: 'discord', pages: ['https://discord.com/settings/authorized-apps'], signIn: 'https://discord.com/login',
    login: /^https:\/\/discord\.com\/login/ },
  { id: 'gitlab', pages: ['https://gitlab.com/-/user_settings/applications'], signIn: 'https://gitlab.com/users/sign_in',
    login: /^https:\/\/gitlab\.com\/users\/sign_in/ },
  { id: 'amazon', pages: ['https://www.amazon.com/ap/adam'], signIn: 'https://www.amazon.com/gp/sign-in.html',
    login: /^https:\/\/www\.amazon\.[a-z.]+\/ap\/signin/ },
  { id: 'twitch', pages: ['https://www.twitch.tv/settings/connections'], signIn: 'https://www.twitch.tv/login',
    login: /^https:\/\/www\.twitch\.tv\/login/ },
  { id: 'yahoo', pages: ['https://login.yahoo.com/account/security/app-access'], signIn: 'https://login.yahoo.com/',
    login: /^https:\/\/login\.yahoo\.com\/(\?|$|account\/challenge|config\/login)/ },
];

// Apple asks for your password every time you open these settings, so it can't be read in the background.
export const MANUAL_PROVIDERS = [
  { id: 'apple', page: 'https://account.apple.com/account/manage' },
];

const LOAD_TIMEOUT = 25000;

function waitForLoad(tabId) {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); resolve(); };
    const listener = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    const timer = setTimeout(done, LOAD_TIMEOUT);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then(t => { if (t.status === 'complete') done(); }).catch(done);
  });
}

// Returns { status: 'ok' | 'login' | 'error', apps: string[], message? }
export async function syncProvider(id) {
  const provider = SYNC_PROVIDERS.find(p => p.id === id);
  if (!provider) return { status: 'error', apps: [], message: 'Unknown provider' };
  const apps = new Set();
  const websites = {};
  for (const url of provider.pages) {
    let tab;
    try {
      tab = await chrome.tabs.create({ url, active: false });
      // Some sites redirect by script a moment after loading (e.g. to their sign-in page).
      // If the page moves while it's being read, wait for the new page and read again.
      let out = null;
      for (let attempt = 0; attempt < 3 && !out; attempt++) {
        await waitForLoad(tab.id);
        const before = (await chrome.tabs.get(tab.id)).url || '';
        if (provider.login.test(before)) return { status: 'login', apps: [] };

        let result = null;
        try {
          const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readConnectedApps, args: [id] });
          result = res?.result || null;
        } catch { /* page navigated mid-read */ }
        await new Promise(r => setTimeout(r, 400));
        const now = await chrome.tabs.get(tab.id);
        if (provider.login.test(now.url || '') || result?.status === 'login') return { status: 'login', apps: [] };
        if (result && now.url === before && now.status === 'complete') out = result;
      }
      if (!out) return { status: 'error', apps: [...apps], message: 'The page kept changing while it was being read.' };
      out.apps.forEach(a => apps.add(a));
      for (const [name, hosts] of Object.entries(out.websites || {})) websites[name] = [...new Set([...(websites[name] || []), ...hosts])];
    } catch (e) {
      return { status: 'error', apps: [...apps], message: String(e.message || e) };
    } finally {
      if (tab) chrome.tabs.remove(tab.id).catch(() => {});
    }
  }
  return { status: 'ok', apps: [...apps], websites };
}

// Runs inside the provider's page. Must be self-contained: it's copied into the page as text.
export async function readConnectedApps(id) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const ACTION = /^(revoke( access)?|remove|deauthori[sz]e|disconnect|edit|view( and edit)?|manage|details|see details|delete|show more|learn more|settings|review|more options|stop using .*)$/i;
  const NOISE = /^(connected apps?|apps and websites|third-party apps.*|authori[sz]ed (oauth )?app(lication)?s?|github apps|permitted services|connections|sign in with .*|active|expired|removed|last (used|accessed).*|access .*|approved .*|has access.*|no apps?.*|you have.*|search.*|filter.*|sort.*|\d+ (apps?|connections?).*|.*ago|today|yesterday|owned by .*)$/i;

  const lines = el => (el?.innerText || el?.textContent || '').split(/[\n\t]/).map(clean).filter(Boolean);
  const good = s => s && s.length >= 2 && s.length <= 80 && !ACTION.test(s) && !NOISE.test(s);
  const firstGood = el => lines(el).find(good) || null;

  const ACTION_SEL = 'button, a, [role="button"], [role="link"]';
  const isAction = (el, re) => re.test(clean(el.innerText || el.textContent || el.getAttribute('aria-label') || ''));

  // Climb from an action button to the smallest block that holds exactly one such button,
  // then take that block's first meaningful line as the app name.
  function nameNear(btn, re) {
    let node = btn.parentElement;
    for (let i = 0; node && i < 8; i++, node = node.parentElement) {
      const actions = [...node.querySelectorAll(ACTION_SEL)].filter(b => isAction(b, re));
      if (actions.length > 1) return null;
      const name = firstGood(node);
      if (name) return name;
    }
    return null;
  }
  const byButtons = re => [...document.querySelectorAll(ACTION_SEL)].filter(b => isAction(b, re)).map(b => nameNear(b, re));
  const byLinks = (sel, exclude) => [...document.querySelectorAll(sel)]
    .filter(a => !exclude || !exclude.test(a.getAttribute('href') || ''))
    .map(a => firstGood(a) || firstGood(a.closest('li, tr, [role="listitem"], [role="row"]')));

  const STRATEGIES = {
    github: () => byLinks('a[href*="/settings/connections/applications/"]'),
    // Google's "Linked apps" page (late 2026): each app links to linkedapps/overview/<id>.
    // The older connections/link and connections/appsettings links are kept as a fallback.
    google: () => byLinks('a[href*="linkedapps/overview/"], a[href*="connections/link"], a[href*="connections/appsettings"]'),
    microsoft: () => [...byLinks('a[href*="consent/Edit"]'), ...byButtons(/^(edit|remove these permissions)$/i)],
    linkedin: () => byButtons(/^remove$/i),
    facebook: () => byButtons(/^(remove|view and edit|view)$/i),
    x: () => byLinks('a[href*="/settings/connected_apps/"]', /connected_apps\/?$/),
    discord: () => byButtons(/^deauthori[sz]e$/i),
    gitlab: () => byButtons(/^revoke$/i),
    amazon: () => byButtons(/^remove$/i),
    twitch: () => byButtons(/^disconnect$/i),
    yahoo: () => byButtons(/^(remove|remove access)$/i),
  };

  const looksSignedOut = () =>
    !!document.querySelector('input[type="password"]') ||
    /sign in|log in|login/i.test(document.title) && !!document.querySelector('input[type="email"], input[name*="user" i], input[name*="login" i]');

  // Discord's settings open as an overlay; click through to the right section if needed.
  if (id === 'discord') {
    for (let i = 0; i < 20 && !document.querySelector('[class*="sidebar"], [role="tablist"]'); i++) await sleep(500);
    const tab = [...document.querySelectorAll('[role="tab"], [class*="item"]')].find(e => /^authori[sz]ed apps$/i.test(clean(e.textContent)));
    if (tab) { tab.click(); await sleep(1200); }
  }

  // Pages render after load, so keep looking for a while. Wait for the list to stop growing.
  const strategy = STRATEGIES[id];
  let best = [], stable = 0;
  for (let i = 0; i < 24; i++) {
    if (looksSignedOut()) return { status: 'login', apps: [] };
    const found = [...new Set((strategy ? strategy() : []).filter(Boolean))];
    if (found.length && found.length === best.length) { if (++stable >= 2) break; } else stable = 0;
    if (found.length >= best.length) best = found;
    await sleep(500);
  }

  // Each app's own page on Google and GitHub lists its website (e.g. Ollama -> ollama.com).
  // Fetch those pages from here, signed in as you, and pull the websites out.
  const websites = {};
  const DETAIL = {
    google: 'a[href*="linkedapps/overview/"], a[href*="connections/link"], a[href*="connections/appsettings"]',
    github: 'a[href*="/settings/connections/applications/"]',
  };
  // Hosts that belong to the provider itself, or to generic web plumbing, never to the app.
  const OWN = {
    google: /(^|\.)(google(\.[a-z.]+)?|gstatic\.com|youtube\.com|ggpht\.com|googleapis\.com|googleusercontent\.com|googletagmanager\.com|doubleclick\.net|g\.co|goo\.gl|withgoogle\.com|android\.com|chromium\.org|blogger\.com|w3\.org|schema\.org)$/,
    github: /(^|\.)(github\.com|githubassets\.com|githubusercontent\.com|githubstatus\.com|github\.blog|githubapp\.com|ghcr\.io|w3\.org|schema\.org)$/,
  };
  if (DETAIL[id] && best.length) {
    const wanted = new Set(best);
    const jobs = [];
    for (const a of document.querySelectorAll(DETAIL[id])) {
      const name = firstGood(a) || firstGood(a.closest('li, tr, [role="listitem"], [role="row"]'));
      if (name && wanted.has(name) && a.href && !jobs.some(j => j.href === a.href)) jobs.push({ name, href: a.href });
    }
    const hostsIn = html => {
      // Prefer links inside the page's main content when the page can be parsed.
      try {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const main = doc.querySelector('main, [role="main"], .application-main');
        if (main && id === 'github') return [...main.querySelectorAll('a[href^="http"]')].map(x => x.getAttribute('href'));
      } catch { /* some pages refuse parsing from script; fall back to scanning the text */ }
      return html.match(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/gi) || [];
    };
    const one = async job => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 10000);
        const html = await fetch(job.href, { credentials: 'include', signal: ctrl.signal }).then(r => r.ok ? r.text() : '');
        clearTimeout(t);
        const hosts = [];
        for (const u of hostsIn(html)) {
          let h; try { h = new URL(u).hostname.toLowerCase(); } catch { continue; }
          if (!OWN[id].test(h) && !hosts.includes(h)) hosts.push(h);
        }
        if (hosts.length) websites[job.name] = [...new Set([...(websites[job.name] || []), ...hosts])].slice(0, 6);
      } catch { /* no website for this one; name matching still works */ }
    };
    for (let i = 0; i < jobs.length; i += 6) await Promise.all(jobs.slice(i, i + 6).map(one));
  }
  return { status: 'ok', apps: best, websites };
}

// Match an app name like "Notion" to a site you already have ("notion.so"), or keep the name.
export function nameToKey(name, existingDomains) {
  const n = name.trim();
  if (/^[\w-]+(\.[\w-]+)+$/.test(n)) return n.toLowerCase().replace(/^www\./, '');
  const norm = n.toLowerCase().replace(/[^a-z0-9]/g, '');
  const hit = existingDomains.find(d => d.split('.')[0].replace(/[^a-z0-9]/g, '') === norm);
  return hit || n;
}
