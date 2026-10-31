// Settings you may want to change before building.

// Your Ko-fi page, e.g. 'https://ko-fi.com/yourname'. The Donate buttons stay hidden until this is set.
export const DONATE_URL = 'https://ko-fi.com/varennck';

// Only open a real Ko-fi page, never anything else that ends up in this setting.
export function donateUrl() {
  try {
    const u = new URL(DONATE_URL);
    return u.protocol === 'https:' && /^(www\.)?ko-fi\.com$/.test(u.hostname) && /^\/[A-Za-z0-9_]+\/?$/.test(u.pathname) ? u.href : null;
  } catch { return null; }
}
