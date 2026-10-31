// Backfill from Chrome's browsing history: sign-in pages you visited are still listed there,
// and most carry the site's address in their redirect_uri. Chrome keeps about 90 days of history.
import { detectProvider, chooseSite } from './providers.js';
import { recordMethod } from './store.js';

const SEARCH_TERMS = [
  'accounts.google.com', 'appleid.apple.com', 'github.com/login/oauth', 'login.microsoftonline.com',
  'login.live.com', 'facebook.com', 'oauth', 'linkedin.com/oauth', 'discord.com', 'gitlab.com/oauth',
  'slack.com', 'amazon', 'id.twitch.tv', 'api.login.yahoo.com', 'x.com/i/oauth2', 'twitter.com',
];

export async function scanHistory(onProgress = () => {}) {
  const seen = new Map(); // url -> lastVisitTime
  for (let i = 0; i < SEARCH_TERMS.length; i++) {
    const items = await chrome.history.search({ text: SEARCH_TERMS[i], startTime: 0, maxResults: 100000 });
    for (const it of items) if (it.url) seen.set(it.url, it.lastVisitTime || Date.now());
    onProgress({ step: i + 1, of: SEARCH_TERMS.length });
  }

  const found = new Map(); // `${site}|${provider}` -> {site, provider, first, last}
  let unattributed = 0;
  for (const [url, at] of seen) {
    const hit = detectProvider(url);
    if (!hit) continue;
    const site = chooseSite({ sourceSite: null, redirectSite: hit.redirectSite, provider: hit.provider });
    if (!site) { unattributed++; continue; }
    const key = `${site}|${hit.provider}`;
    const cur = found.get(key);
    if (cur) { cur.first = Math.min(cur.first, at); cur.last = Math.max(cur.last, at); }
    else found.set(key, { site, provider: hit.provider, first: at, last: at });
  }

  for (const f of found.values()) {
    await recordMethod(f.site, f.provider, { source: 'history', confirmed: false, at: f.first });
    if (f.last !== f.first) await recordMethod(f.site, f.provider, { source: 'history', confirmed: false, at: f.last });
  }
  return { found: [...found.values()], unattributed };
}
