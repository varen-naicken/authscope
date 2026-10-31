// Matching a website you're on (e.g. ollama.com) to ledger entries that may be stored under
// an app name ("Ollama"), a different country domain (deliveroo.com vs deliveroo.ie), or a
// website the provider listed for that app. Pure functions: no chrome.* APIs.
import { registrableDomain, isProviderDomain } from './providers.js';

export const normName = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Words that apps tack onto their names but that never appear in their domain.
const FILLER = /\b(auth|oauth|sso|login|sign[\s-]?in|app|apps|desktop|mobile|web|official|integration|connector|cli|inc|ltd|llc|limited|group|for (github|google|slack))\b/gi;
export const baseName = s => normName(String(s || '').replace(FILLER, ' '));

// "deliveroo.ie" -> "deliveroo"; "app.netlify.com" -> "netlify"
export const labelOf = domain => {
  const reg = registrableDomain(domain);
  return reg ? reg.split('.')[0] : '';
};

export const isDomainKey = k => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(k || '');

// Turn raw hosts from a provider page into clean registrable domains, dropping the provider's own.
export function cleanWebsites(hosts) {
  const out = [];
  for (const h of hosts || []) {
    const d = registrableDomain(String(h).toLowerCase().replace(/^https?:\/\//, '').split(/[/?#:]/)[0]);
    if (d && isDomainKey(d) && !isProviderDomain(d) && !out.includes(d)) out.push(d);
  }
  return out;
}

// Pick the domain that best stands for the app: one whose name matches, otherwise the first listed.
export function primaryWebsite(name, websites) {
  if (!websites?.length) return null;
  const n = normName(name), b = baseName(name);
  return websites.find(d => labelOf(d) === n || labelOf(d) === b) || websites[0];
}

// How strongly an entry matches a domain: 3 exact, 2 listed website, 1 same name / other TLD, 0 none.
export function matchStrength(entry, domain) {
  if (!entry || !domain) return 0;
  if (entry.domain === domain) return 3;
  // On a provider's own site (github.com, google.com) only exact entries count, otherwise
  // "GitHub Desktop" would show up on github.com.
  if (isProviderDomain(domain)) return 0;
  if ((entry.websites || []).includes(domain)) return 2;
  const label = labelOf(domain);
  if (label.length < 3) return 0;
  const domains = [...(isDomainKey(entry.domain) ? [entry.domain] : []), ...(entry.websites || [])];
  if (domains.some(d => labelOf(d) === label)) return 1;
  const names = [entry.name, isDomainKey(entry.domain) ? null : entry.domain].filter(Boolean);
  if (names.some(n => normName(n) === label || baseName(n) === label)) return 1;
  return 0;
}

// All entries that belong to this domain, best match first.
export function findEntriesFor(all, domain) {
  return Object.values(all || {})
    .map(e => ({ e, s: matchStrength(e, domain) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map(x => x.e);
}

// Merge several entries' methods into one view (latest use wins on duplicates).
export function combinedMethods(entries) {
  const out = {};
  for (const e of entries) {
    for (const [id, m] of Object.entries(e.methods || {})) {
      if (!out[id] || (m.lastSeen || 0) > (out[id].lastSeen || 0)) out[id] = m;
    }
  }
  return out;
}

// Find the existing entry an app from a provider should be added to, so the same app from
// Google and GitHub (or an older name-only entry) ends up as one entry.
export function findExistingFor(all, name, websites) {
  const entries = Object.values(all || {});
  const n = normName(name), b = baseName(name);
  for (const d of websites || []) if (all[d]) return all[d];
  return entries.find(e => (e.websites || []).some(w => (websites || []).includes(w)))
    || entries.find(e => e.name && (normName(e.name) === n))
    || entries.find(e => !isDomainKey(e.domain) && normName(e.domain) === n)
    || (websites?.length ? null : entries.find(e => isDomainKey(e.domain) && !isProviderDomain(e.domain) && (labelOf(e.domain) === n || (b.length >= 3 && labelOf(e.domain) === b))))
    || null;
}
