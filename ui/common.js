import { METHODS, isThirdParty } from '../lib/providers.js';

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c.nodeType ? c : String(c));
  return node;
}

export function ago(ts) {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24); if (d < 31) return `${d} day${d === 1 ? '' : 's'} ago`;
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function sortedMethods(site) {
  return Object.entries(site.methods).filter(([id]) => isThirdParty(id)).sort((a, b) => b[1].lastSeen - a[1].lastSeen);
}

const SOURCE_TEXT = { detected: 'seen in this browser', history: 'found in browsing history', manual: 'added by you', import: 'imported', provider: 'listed in that account\u2019s connected apps' };

// The provider's own site icon, loaded from its website. Falls back to a colour dot if it can't load.
export function providerIcon(id, size = 16) {
  const meta = METHODS[id] || METHODS.other;
  const dot = () => el('span', { class: 'pdot', style: `--c:${meta.color};width:${size}px;height:${size}px`, 'aria-hidden': 'true' });
  if (!meta.site) return null;
  const img = el('img', {
    class: 'picon', src: `${meta.site}/favicon.ico`, alt: '', width: size, height: size,
    loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', 'aria-hidden': 'true',
  });
  img.addEventListener('error', () => img.replaceWith(dot()), { once: true });
  return img;
}

export function methodTag(id, rec, { big = false, onRemove } = {}) {
  const meta = METHODS[id] || METHODS.other;
  const seen = !rec.confirmed && !['manual', 'import', 'provider'].includes(rec.source);
  const title = [
    meta.label,
    seen ? 'sign-in started, not confirmed' : 'signed in',
    `last ${ago(rec.lastSeen)}`,
    SOURCE_TEXT[rec.source] || '',
    rec.username ? `as ${rec.username}` : '',
  ].filter(Boolean).join(', ');
  const icon = providerIcon(id, big ? 18 : 15);
  return el('span', { class: `tag${seen ? ' seen' : ''}${big ? ' big' : ''}${icon ? ' has-icon' : ''}`, style: `--c:${meta.color}`, title },
    icon,
    meta.label,
    onRemove && el('button', { class: 'x', 'aria-label': `Remove ${meta.label}`, title: `Remove ${meta.label}`, onclick: onRemove }, '×'));
}

export function methodOptions(selected) {
  return Object.entries(METHODS).filter(([id]) => isThirdParty(id)).map(([id, m]) => el('option', { value: id, selected: id === selected }, m.label));
}

export async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
