// Storage helpers shared by the background worker, popup and dashboard.
// Everything lives in chrome.storage.local on this device; nothing is sent anywhere.
//
// Shape: { accounts: { [key]: { domain, name?, websites?, note, methods: { [methodId]: MethodRecord } } } }
//   key/domain is the site's domain (e.g. "ollama.com"), or the app's name when no website is known.
//   name: the app's name as the provider shows it ("Ollama"). websites: other domains for the same app.
// MethodRecord: { firstSeen, lastSeen, count, confirmed, source, username }
import { findExistingFor, primaryWebsite, isDomainKey, normName } from './match.js';
import { isThirdParty } from './providers.js';

const KEY = 'accounts';
const SETTINGS_KEY = 'settings';
export const DEFAULT_SETTINGS = { showBadge: true };

let queue = Promise.resolve();
// Serialise writes so two quick detections can't overwrite each other.
function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

export async function getAll() {
  const data = await chrome.storage.local.get(KEY);
  return data[KEY] || {};
}

export async function getSite(domain) {
  return (await getAll())[domain] || null;
}

export async function getSettings() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(data[SETTINGS_KEY] || {}) };
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

// Record a method for a site. `confirmed` only ever upgrades (false -> true), never downgrades.
export function recordMethod(domain, method, { source = 'detected', confirmed = true, at = Date.now(), username = null } = {}) {
  if (!domain || !method || !isThirdParty(method)) return Promise.resolve();
  return serial(async () => {
    const all = await getAll();
    const site = all[domain] || (all[domain] = { domain, note: '', methods: {} });
    const prev = site.methods[method];
    if (prev) {
      prev.firstSeen = Math.min(prev.firstSeen, at);
      prev.lastSeen = Math.max(prev.lastSeen, at);
      prev.count = (prev.count || 1) + (source === 'history' ? 0 : 1);
      prev.confirmed = prev.confirmed || confirmed;
      if (username) prev.username = username;
      if (prev.source === 'history' && source !== 'history') prev.source = source;
    } else {
      site.methods[method] = { firstSeen: at, lastSeen: at, count: 1, confirmed, source, ...(username ? { username } : {}) };
    }
    await chrome.storage.local.set({ [KEY]: all });
  });
}

export function confirmMethod(domain, method) {
  return serial(async () => {
    const all = await getAll();
    const rec = all[domain]?.methods?.[method];
    if (rec && !rec.confirmed) {
      rec.confirmed = true;
      await chrome.storage.local.set({ [KEY]: all });
    }
  });
}

export function removeMethod(domain, method) {
  return serial(async () => {
    const all = await getAll();
    if (!all[domain]) return;
    delete all[domain].methods[method];
    if (!Object.keys(all[domain].methods).length) delete all[domain];
    await chrome.storage.local.set({ [KEY]: all });
  });
}

export function removeSite(domain) {
  return serial(async () => {
    const all = await getAll();
    delete all[domain];
    await chrome.storage.local.set({ [KEY]: all });
  });
}

// Merge an exported file back in. Existing data wins ties; nothing is deleted.
export function mergeImport(incoming) {
  return serial(async () => {
    const all = await getAll();
    let added = 0;
    for (const [domain, site] of Object.entries(incoming || {})) {
      if (!site || typeof site !== 'object' || !site.methods) continue;
      const cur = all[domain] || (all[domain] = { domain, note: '', methods: {} });
      if (!cur.note && site.note) cur.note = String(site.note);
      if (!cur.name && site.name) cur.name = String(site.name);
      if (Array.isArray(site.websites)) cur.websites = [...new Set([...(cur.websites || []), ...site.websites.map(String)])];
      for (const [m, rec] of Object.entries(site.methods)) {
        if (!rec || typeof rec !== 'object' || !isThirdParty(m)) continue;
        if (!cur.methods[m]) { cur.methods[m] = { ...rec, source: rec.source || 'import' }; added++; }
        else {
          const c = cur.methods[m];
          c.firstSeen = Math.min(c.firstSeen || Infinity, rec.firstSeen || Infinity);
          c.lastSeen = Math.max(c.lastSeen || 0, rec.lastSeen || 0);
          c.confirmed = c.confirmed || !!rec.confirmed;
          if (!c.username && rec.username) c.username = rec.username;
        }
      }
    }
    for (const [k, site] of Object.entries(all)) if (!Object.keys(site.methods || {}).length) delete all[k];
    await chrome.storage.local.set({ [KEY]: all });
    return added;
  });
}

// Add an app a provider lists (e.g. GitHub lists "Ollama", homepage ollama.com) to the ledger.
// Reuses a matching entry if there is one, files it under its website when known, and moves an
// older name-only entry ("Ollama") over to the website. Returns { isNew, key }: whether this provider is
// new for the entry, and the entry it was filed under.
export function addProviderApp(name, method, websites = []) {
  if (!isThirdParty(method)) return Promise.resolve({ isNew: false, key: null });
  return serial(async () => {
    const all = await getAll();
    let entry = findExistingFor(all, name, websites);
    const primary = primaryWebsite(name, websites);

    // Move a name-only entry to its website now that we know it.
    if (entry && !isDomainKey(entry.domain) && primary) {
      const target = all[primary] || { domain: primary, note: '', methods: {} };
      for (const [m, rec] of Object.entries(entry.methods)) {
        const cur = target.methods[m];
        if (!cur || (rec.lastSeen || 0) > (cur.lastSeen || 0)) target.methods[m] = rec;
      }
      if (!target.note && entry.note) target.note = entry.note;
      target.name = target.name || entry.name || entry.domain;
      target.websites = [...new Set([...(target.websites || []), ...(entry.websites || [])])];
      delete all[entry.domain];
      all[primary] = target;
      entry = target;
    }
    if (!entry) {
      const key = primary || name;
      entry = all[key] || (all[key] = { domain: key, note: '', methods: {} });
    }

    if (!entry.name && normName(name) !== normName(entry.domain)) entry.name = name;
    const extra = websites.filter(w => w !== entry.domain && !(entry.websites || []).includes(w));
    if (extra.length) entry.websites = [...(entry.websites || []), ...extra];

    const now = Date.now();
    const isNew = !entry.methods[method];
    if (isNew) entry.methods[method] = { firstSeen: now, lastSeen: now, count: 1, confirmed: true, source: 'provider' };
    else entry.methods[method].confirmed = true;
    await chrome.storage.local.set({ [KEY]: all });
    return { isNew, key: entry.domain };
  });
}

// After a provider check, remove that provider from entries it no longer lists (revoked apps, or apps
// from a page AuthScope no longer reads). Only touches tags that came from a provider check; sign-ins
// AuthScope saw happen, or that you added by hand, are kept. Returns how many were removed.
export function pruneProviderApps(method, keepKeys) {
  return serial(async () => {
    const all = await getAll();
    let removed = 0;
    for (const [key, site] of Object.entries(all)) {
      const rec = site.methods?.[method];
      if (!rec || rec.source !== 'provider' || keepKeys.has(key)) continue;
      delete site.methods[method];
      removed++;
      if (!Object.keys(site.methods).length) delete all[key];
    }
    if (removed) await chrome.storage.local.set({ [KEY]: all });
    return removed;
  });
}

// Remove password, passkey and other non-provider sign-ins saved by earlier versions, and any
// site left with nothing on it. Returns how many sign-ins were removed.
export function purgeNonProvider() {
  return serial(async () => {
    const all = await getAll();
    let removed = 0;
    for (const [key, site] of Object.entries(all)) {
      for (const m of Object.keys(site.methods || {})) {
        if (!isThirdParty(m)) { delete site.methods[m]; removed++; }
      }
      if (!Object.keys(site.methods || {}).length) delete all[key];
    }
    if (removed) await chrome.storage.local.set({ [KEY]: all });
    const { settings } = await chrome.storage.local.get('settings');
    if (settings) await chrome.storage.local.set({ settings: { showBadge: settings.showBadge !== false } });
    return removed;
  });
}

export async function clearAll() {
  await chrome.storage.local.set({ [KEY]: {} });
}

// Results of the last "Check your accounts" run, per provider: { at, status, apps }
export async function getSyncState() {
  return (await chrome.storage.local.get('providerSync')).providerSync || {};
}
export function setSyncState(id, value) {
  return serial(async () => {
    const all = await getSyncState();
    all[id] = value;
    await chrome.storage.local.set({ providerSync: all });
  });
}
