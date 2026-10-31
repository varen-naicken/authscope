import { detectProvider, chooseSite, siteOf, isAttributableSite, isProviderDomain, looksLikeCancel, METHODS } from './lib/providers.js';
import { recordMethod, confirmMethod, removeMethod, getSite, getAll, getSettings, purgeNonProvider } from './lib/store.js';
import { findEntriesFor, combinedMethods } from './lib/match.js';

// ---- Per-tab session state (survives the service worker going to sleep) ----
// lastSite: last real site committed in each tab. pending: a sign-in waiting to see how it ends.
async function getState() {
  const s = await chrome.storage.session.get(['lastSite', 'pending']);
  return { lastSite: s.lastSite || {}, pending: s.pending || {} };
}
let stateQueue = Promise.resolve();
function patchState(fn) {
  // Serialised so overlapping events can't clobber each other's changes.
  const run = stateQueue.then(async () => {
    const st = await getState();
    fn(st);
    await chrome.storage.session.set(st);
  });
  stateQueue = run.catch(() => {});
  return run;
}

const PENDING_TTL = 30 * 60 * 1000;

// ---- 1. Spot third-party sign-in pages, including ones that redirect straight back ----
// webRequest sees every hop of a redirect chain, so an already-approved Google sign-in
// that bounces back instantly is still caught.
chrome.webRequest.onBeforeRequest.addListener(
  details => { handleProviderUrl(details.tabId, details.url).catch(console.error); },
  { urls: chrome.runtime.getManifest().host_permissions, types: ['main_frame'] }
);

async function handleProviderUrl(tabId, url) {
  if (tabId < 0) return;
  const hit = detectProvider(url);
  if (!hit) return;

  const { lastSite, pending } = await getState();
  let sourceSite = lastSite[tabId] || null;
  if (!sourceSite) {
    // Sign-in popups start blank; the site is whatever tab opened them.
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.openerTabId != null) sourceSite = lastSite[tab.openerTabId] || siteOf(tab.pendingUrl || '') || null;
      if (!sourceSite && tab.openerTabId != null) {
        const opener = await chrome.tabs.get(tab.openerTabId);
        sourceSite = siteOf(opener.url || '');
      }
    } catch { /* tab gone */ }
  }

  const site = chooseSite({ sourceSite, redirectSite: hit.redirectSite, provider: hit.provider });
  if (!site) return;

  // Same flow seen again a moment later (provider redirects within itself)? Don't double count.
  const prev = pending[tabId];
  if (prev && prev.site === site && prev.provider === hit.provider && Date.now() - prev.at < 60_000) return;

  const existed = !!(await getSite(site))?.methods?.[hit.provider];
  await recordMethod(site, hit.provider, { source: 'detected', confirmed: false });
  await patchState(st => { st.pending[tabId] = { site, redirectSite: hit.redirectSite, provider: hit.provider, at: Date.now(), existed }; });
  updateBadge(tabId);
}

// ---- 2. Track the site each tab is on, and settle pending sign-ins ----
chrome.webNavigation.onCommitted.addListener(async details => {
  if (details.frameId !== 0) return;
  const { tabId, url } = details;
  const site = siteOf(url);
  if (!site) return;

  const { pending } = await getState();
  const p = pending[tabId];
  if (p && !isProviderDomain(site)) {
    const fresh = Date.now() - p.at < PENDING_TTL;
    if (fresh && looksLikeCancel(url)) {
      // User backed out. Only undo the record if this flow created it.
      if (!p.existed) await removeMethod(p.site, p.provider);
    } else if (fresh && (site === p.site || site === p.redirectSite || !isAttributableSite(site))) {
      // Landed back on the site (or its hosted login service) without an error: it worked.
      await confirmMethod(p.site, p.provider);
    }
    // Wandered off somewhere else: leave it as "seen".
    await patchState(st => { delete st.pending[tabId]; });
  }

  if (isAttributableSite(site)) {
    await patchState(st => { st.lastSite[tabId] = site; });
  }
  updateBadge(tabId, url);
});

// Popups opened by a page inherit that page's site.
chrome.webNavigation.onCreatedNavigationTarget.addListener(async ({ sourceTabId, tabId }) => {
  await patchState(st => {
    if (st.lastSite[sourceTabId] && !st.lastSite[tabId]) st.lastSite[tabId] = st.lastSite[sourceTabId];
  });
});

// A sign-in popup that closes itself (e.g. Google's "Sign in with Google" button) hands the
// result back by script, so there's no return page to watch. Success and cancel look the same,
// so the record stays "seen" (unconfirmed) rather than guessing.
chrome.tabs.onRemoved.addListener(async tabId => {
  await patchState(st => { delete st.pending[tabId]; delete st.lastSite[tabId]; });
});

// ---- 3. Messages from the dashboard ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || msg?.type !== 'refresh-badges') return false;
  chrome.tabs.query({}).then(tabs => { for (const t of tabs) updateBadge(t.id, t.url); sendResponse({ ok: true }); });
  return true;
});

// ---- 4. Toolbar badge: show how you signed in to the site you're on ----
async function updateBadge(tabId, knownUrl) {
  try {
    const settings = await getSettings();
    const url = knownUrl || (await chrome.tabs.get(tabId)).url || '';
    const site = siteOf(url);
    // Entries can be stored by website or by app name ("Ollama"), so gather every match.
    const matches = site ? findEntriesFor(await getAll(), site) : [];
    const methods = Object.entries(combinedMethods(matches)).sort((a, b) => b[1].lastSeen - a[1].lastSeen);
    if (!settings.showBadge || !methods.length) {
      await chrome.action.setBadgeText({ tabId, text: '' });
      await chrome.action.setTitle({ tabId, title: 'AuthScope' });
      return;
    }
    const [topId] = methods[0];
    const meta = METHODS[topId] || METHODS.other;
    const text = methods.length > 1 ? (meta.short + '+').slice(0, 4) : meta.short;
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: meta.color });
    if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ tabId, color: '#ffffff' });
    const names = methods.map(([id]) => (METHODS[id] || METHODS.other).label).join(', ');
    await chrome.action.setTitle({ tabId, title: `${site}: ${names}` });
  } catch { /* tab closed or not accessible */ }
}

chrome.tabs.onActivated.addListener(({ tabId }) => updateBadge(tabId));
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !(changes.accounts || changes.settings)) return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab) updateBadge(tab.id, tab.url);
});

// First install: open the dashboard so the history scan is one click away.
// Earlier versions also saved password and passkey sign-ins; clear those out.
chrome.runtime.onStartup?.addListener(() => { purgeNonProvider().catch(() => {}); });
chrome.runtime.onInstalled.addListener(({ reason }) => {
  purgeNonProvider().catch(() => {});
  if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html?welcome=1') });
});
