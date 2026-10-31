import { siteOf } from './lib/providers.js';
import { getAll, recordMethod, removeMethod } from './lib/store.js';
import { el, ago, methodTag, methodOptions, currentTab } from './ui/common.js';
import { findEntriesFor } from './lib/match.js';
import { donateUrl } from './lib/config.js';

const $ = id => document.getElementById(id);
let domain = null;

async function render() {
  const all = await getAll();
  const total = Object.keys(all).length;
  $('count').textContent = `${total} site${total === 1 ? '' : 's'} recorded`;
  $('start').hidden = total > 0;

  if (!domain) {
    $('site').textContent = 'Not a website';
    $('lead').textContent = 'Open a site to see how you sign in to it.';
    $('addForm').hidden = true; $('methods').replaceChildren();
    return;
  }

  $('site').textContent = domain;
  // The site may be in the ledger under its domain, another country domain, or the app's name.
  const matches = findEntriesFor(all, domain);
  const list = matches.flatMap(e => Object.entries(e.methods).map(([id, m]) => ({ id, m, key: e.domain })))
    .sort((a, b) => b.m.lastSeen - a.m.lastSeen)
    .filter((x, i, arr) => arr.findIndex(y => y.id === x.id) === i);
  const names = [...new Set(matches.map(e => e.name || (e.domain !== domain ? e.domain : null)).filter(Boolean))];
  $('lead').textContent = list.length
    ? (names.length ? `Listed as ${names.join(', ')}. ` : '') + (list.length === 1 ? 'You sign in here with' : 'You\u2019ve signed in here with')
    : '';

  if (!list.length) {
    $('methods').replaceChildren(el('p', { class: 'empty' },
      'Nothing recorded for this site. If you sign in or sign up here with Google, Apple, GitHub or another provider, it\u2019ll be saved. You can also add it below.'));
  } else {
    $('methods').replaceChildren(...list.map(({ id, m, key }) => el('div', {},
      el('div', { class: 'row' },
        methodTag(id, m, { big: true, onRemove: async () => { await removeMethod(key, id); render(); } }),
        el('span', { class: 'when' }, ago(m.lastSeen))),
      m.username && el('div', { class: 'who' }, m.username))));
  }
  $('hint').hidden = !list.some(({ m }) => !m.confirmed && !['manual', 'import', 'provider'].includes(m.source));
}

async function init() {
  const tab = await currentTab();
  domain = siteOf(tab?.url || '');
  $('addMethod').replaceChildren(...methodOptions('google'));
  $('addForm').addEventListener('submit', async e => {
    e.preventDefault();
    await recordMethod(domain, $('addMethod').value, { source: 'manual', confirmed: true });
    render();
  });
  $('openAll').addEventListener('click', () => { chrome.runtime.openOptionsPage(); window.close(); });
  $('startBtn').addEventListener('click', () => { chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html?welcome=1') }); window.close(); });
  const donate = donateUrl();
  if (donate) {
    $('donate').href = donate; $('donate').hidden = false;
    // Popups don't follow target=_blank reliably; open a tab and close the popup.
    $('donate').addEventListener('click', e => { e.preventDefault(); chrome.tabs.create({ url: donate }); window.close(); });
  }
  render();
  // Firefox lets people withhold site access; without it nothing new gets recorded.
  try {
    if (!(await chrome.permissions.contains({ origins: chrome.runtime.getManifest().host_permissions }))) {
      $('access').hidden = false;
      $('access').addEventListener('click', () => { chrome.runtime.openOptionsPage(); window.close(); });
    }
  } catch { /* fine */ }
}

init();
