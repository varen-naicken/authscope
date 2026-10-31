// Pure detection logic: no chrome.* APIs here, so it can be unit-tested in Node.

export const METHODS = {
  google:    { site: 'https://www.google.com', label: 'Google',    short: 'G',  color: '#4285F4', manage: 'https://myaccount.google.com/connections' },
  apple:     { site: 'https://www.apple.com', label: 'Apple',     short: 'A',  color: '#555555', manage: 'https://account.apple.com/account/manage' },
  github:    { site: 'https://github.com', label: 'GitHub',    short: 'GH', color: '#6e5494', manage: 'https://github.com/settings/applications' },
  microsoft: { site: 'https://www.microsoft.com', label: 'Microsoft', short: 'MS', color: '#0078D4', manage: 'https://account.microsoft.com/privacy/app-access' },
  facebook:  { site: 'https://www.facebook.com', label: 'Facebook',  short: 'FB', color: '#1877F2', manage: 'https://www.facebook.com/settings?tab=applications' },
  x:         { site: 'https://x.com', label: 'X / Twitter', short: 'X', color: '#222222', manage: 'https://x.com/settings/connected_apps' },
  linkedin:  { site: 'https://www.linkedin.com', label: 'LinkedIn',  short: 'in', color: '#0A66C2', manage: 'https://www.linkedin.com/psettings/permitted-services' },
  discord:   { site: 'https://discord.com', label: 'Discord',   short: 'D',  color: '#5865F2', manage: 'https://discord.com/channels/@me' },
  gitlab:    { site: 'https://gitlab.com', label: 'GitLab',    short: 'GL', color: '#E24329', manage: 'https://gitlab.com/-/user_settings/applications' },
  slack:     { site: 'https://slack.com', label: 'Slack',     short: 'S',  color: '#4A154B', manage: null },
  amazon:    { site: 'https://www.amazon.com', label: 'Amazon',    short: 'AZ', color: '#E47911', manage: 'https://www.amazon.com/ap/adam' },
  twitch:    { site: 'https://www.twitch.tv', label: 'Twitch',    short: 'TW', color: '#9146FF', manage: 'https://www.twitch.tv/settings/connections' },
  yahoo:     { site: 'https://www.yahoo.com', label: 'Yahoo',     short: 'Y',  color: '#6001D2', manage: 'https://login.yahoo.com/account/security/app-access' },
  other:     { label: 'Other',     short: '?',  color: '#777777', manage: null }, // display fallback only
};

// AuthScope only records sign-ins and sign-ups through a third-party provider. Passwords,
// passkeys and email codes are left to your password manager.
export const PROVIDER_IDS = Object.keys(METHODS).filter(id => METHODS[id].site);
export const isThirdParty = id => PROVIDER_IDS.includes(id);

// Domains each provider owns. Signing into these with the provider itself is not interesting.
const OWNED = {
  google: ['google.com', 'youtube.com', 'gmail.com', 'googleusercontent.com', 'google.ie', 'google.co.uk', 'withgoogle.com', 'gstatic.com'],
  apple: ['apple.com', 'icloud.com'],
  github: ['github.com'],
  microsoft: ['microsoft.com', 'microsoftonline.com', 'live.com', 'office.com', 'outlook.com', 'bing.com', 'xbox.com', 'azure.com', 'microsoft365.com'],
  facebook: ['facebook.com', 'instagram.com', 'meta.com', 'messenger.com'],
  x: ['twitter.com', 'x.com'],
  linkedin: ['linkedin.com'],
  discord: ['discord.com'],
  gitlab: ['gitlab.com'],
  slack: ['slack.com'],
  amazon: ['amazon.com', 'amazon.co.uk', 'amazon.de', 'amazon.ie'],
  twitch: ['twitch.tv'],
  yahoo: ['yahoo.com'],
};

const PROVIDER_DOMAINS = new Set(Object.values(OWNED).flat());

// Hosted auth services a site may bounce through. The real site is whatever came before.
const AUTH_MIDDLEMEN = [
  'auth0.com', 'clerk.accounts.dev', 'clerk.com', 'firebaseapp.com', 'supabase.co', 'amazoncognito.com',
  'okta.com', 'oktapreview.com', 'stytch.com', 'workos.com', 'authkit.app', 'b2clogin.com', 'kinde.com',
  'frontegg.com', 'descope.com', 'fusionauth.io', 'onelogin.com', 'ory.sh', 'web.app', 'netlify.app',
];

// Second-level public suffixes, so "shop.example.co.uk" -> "example.co.uk".
const TWO_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.za', 'com.br',
  'co.jp', 'co.in', 'co.kr', 'com.mx', 'com.ar', 'com.tr', 'com.sg', 'com.hk', 'com.cn', 'co.il', 'com.mu',
  'gov.ie', 'github.io', 'vercel.app', 'herokuapp.com', 'pages.dev', 'web.app', 'firebaseapp.com', 'netlify.app',
  'azurewebsites.net', 'blogspot.com', 'myshopify.com',
]);

export function registrableDomain(hostname) {
  if (!hostname) return null;
  const host = hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host === 'localhost' || host.includes(':')) return host;
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const last2 = parts.slice(-2).join('.');
  return TWO_PART_SUFFIXES.has(last2) ? parts.slice(-3).join('.') : last2;
}

export function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

export function siteOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return registrableDomain(u.hostname);
  } catch { return null; }
}

export function isProviderDomain(domain) {
  return !!domain && PROVIDER_DOMAINS.has(domain);
}

export function isMiddleman(domain) {
  return !!domain && AUTH_MIDDLEMEN.some(m => domain === m || domain.endsWith('.' + m));
}

// A page we'd attribute a sign-in to: a real web site that isn't a provider or auth middleman.
export function isAttributableSite(domain) {
  return !!domain && !isProviderDomain(domain) && !isMiddleman(domain);
}

const hostIs = (host, ...names) => names.some(n => host === n || host.endsWith('.' + n));

const RULES = [
  { id: 'google', test: (h, p) => hostIs(h, 'accounts.google.com') &&
      (/^\/o\/oauth2\//.test(p) || /^\/signin\/oauth/.test(p) || /^\/gsi\/select/.test(p) || /\/oauth/.test(p)) },
  { id: 'apple', test: (h, p) => h === 'appleid.apple.com' && /^\/auth\/(authorize|oauth2)/.test(p) },
  { id: 'github', test: (h, p) => h === 'github.com' && /^\/login\/oauth\/authorize/.test(p) },
  { id: 'microsoft', test: (h, p) =>
      (h === 'login.microsoftonline.com' && /\/oauth2\//.test(p)) ||
      (hostIs(h, 'login.live.com') && /^\/oauth20_authorize/.test(p)) },
  { id: 'facebook', test: (h, p) => hostIs(h, 'facebook.com') && /^\/(v\d+(\.\d+)?\/)?dialog\/oauth/.test(p) },
  { id: 'x', test: (h, p) =>
      (hostIs(h, 'twitter.com', 'x.com') && /^\/i\/oauth2\/authorize/.test(p)) ||
      (hostIs(h, 'api.twitter.com', 'api.x.com') && /^\/oauth\/(authenticate|authorize)/.test(p)) },
  { id: 'linkedin', test: (h, p) => hostIs(h, 'linkedin.com') && /^\/oauth\/v2\/authorization/.test(p) },
  { id: 'discord', test: (h, p) => hostIs(h, 'discord.com', 'discordapp.com') && /^\/(api\/)?oauth2\/authorize/.test(p) },
  { id: 'gitlab', test: (h, p) => h === 'gitlab.com' && /^\/oauth\/authorize/.test(p) },
  { id: 'slack', test: (h, p) => hostIs(h, 'slack.com') && /^\/(openid\/connect|oauth)\/(v2\/)?authorize/.test(p) },
  { id: 'amazon', test: (h, p) => /(^|\.)amazon\.[a-z.]+$/.test(h) && /^\/ap\/oa/.test(p) },
  { id: 'twitch', test: (h, p) => h === 'id.twitch.tv' && /^\/oauth2\/authorize/.test(p) },
  { id: 'yahoo', test: (h, p) => h === 'api.login.yahoo.com' && /^\/oauth2\/request_auth/.test(p) },
];

// Some providers wrap the real OAuth URL inside a "continue"/"return_to" parameter
// (e.g. Google's account chooser, GitHub's login page). Unwrap a couple of levels.
const WRAPPER_PARAMS = ['continue', 'return_to', 'returnTo', 'next', 'followup'];

function candidateUrls(url, depth = 0) {
  const out = [url];
  if (depth > 2) return out;
  try {
    const u = new URL(url);
    for (const key of WRAPPER_PARAMS) {
      const v = u.searchParams.get(key);
      if (!v) continue;
      const inner = v.startsWith('/') ? new URL(v, u.origin).href : v;
      if (/^https?:\/\//.test(inner)) out.push(...candidateUrls(inner, depth + 1));
    }
  } catch { /* ignore */ }
  return out;
}

// Returns { provider, redirectSite } if this URL is a third-party sign-in page, else null.
export function detectProvider(url) {
  for (const candidate of candidateUrls(url)) {
    let u;
    try { u = new URL(candidate); } catch { continue; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
    const rule = RULES.find(r => r.test(u.hostname.toLowerCase(), u.pathname));
    if (!rule) continue;
    return { provider: rule.id, redirectSite: redirectSiteFrom(u, url) };
  }
  return null;
}

function redirectSiteFrom(u, original) {
  const sources = [u];
  try { sources.push(new URL(original)); } catch { /* ignore */ }
  for (const src of sources) {
    for (const key of ['redirect_uri', 'redirect_url', 'origin', 'return_url']) {
      const v = src.searchParams.get(key);
      if (!v) continue;
      const site = siteOf(v);
      if (site && !isProviderDomain(site)) return site;
    }
  }
  return null;
}

// Pick the site a sign-in belongs to. The page the user was on is the best signal
// (it's the name they'll recognise); redirect_uri is the fallback.
export function chooseSite({ sourceSite, redirectSite, provider }) {
  const owned = new Set(OWNED[provider] || []);
  const ok = d => d && isAttributableSite(d) && !owned.has(d);
  if (ok(sourceSite)) return sourceSite;
  if (redirectSite && !owned.has(redirectSite) && !isProviderDomain(redirectSite)) {
    // A middleman redirect (e.g. myapp.firebaseapp.com) is still better than nothing.
    return redirectSite;
  }
  return null;
}

// After the provider page, a return to the site that carries an OAuth error means the user cancelled.
export function looksLikeCancel(url) {
  try {
    const u = new URL(url);
    const all = u.search + '&' + u.hash.replace(/^#/, '');
    return /(^|[?&])error=(access_denied|user_cancelled|user_cancelled_authorize|consent_required|interaction_required)/i.test(all) ||
           /(^|[?&])error_reason=user_denied/i.test(all);
  } catch { return false; }
}
