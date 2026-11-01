import { METHODS, PROVIDER_IDS, isThirdParty, siteOf, registrableDomain } from './lib/providers.js';
import { getAll, recordMethod, removeMethod, removeSite, mergeImport, purgeNonProvider, clearAll, getSettings, saveSettings, getSyncState, setSyncState, addProviderApp, pruneProviderApps } from './lib/store.js';
import { SYNC_PROVIDERS, MANUAL_PROVIDERS, syncProvider } from './lib/sync.js';
import { cleanWebsites, isDomainKey } from './lib/match.js';
import { scanHistory } from './lib/history.js';

// Switched off for now: only "Check your accounts" is shown. To bring the history scan back,
// set this to true and add "history" back to the permissions in both manifests.
const HISTORY_SCAN = false;
// Hidden for now: the Sign in and Manage icons in Check your accounts. Set to true to show them again.
const ROW_LINKS = false;
import { el, ago, sortedMethods, methodTag, methodOptions, providerIcon } from './ui/common.js';
import { Pie3D, MAX_SLICES } from './ui/pie3d.js';
import { donateUrl } from './lib/config.js';

const $ = id => document.getElementById(id);
const say = msg => { $('status').textContent = msg; };

// ---------- List ----------
const PAGE_SIZE = 20;
let page = 1;
async function render() {
  const all = await getAll();
  const sites = Object.values(all);
  const methodCount = sites.reduce((n, s) => n + Object.keys(s.methods).length, 0);
  $('summary').textContent = sites.length
    ? `${sites.length} site${sites.length === 1 ? '' : 's'}, ${methodCount} sign-in method${methodCount === 1 ? '' : 's'}. Kept only in this browser.`
    : 'How you sign in to each site, kept only in this browser.';
  $('welcome').hidden = !HISTORY_SCAN || (sites.length > 0 && !new URLSearchParams(location.search).has('welcome'));

  const q = $('q').value.trim().toLowerCase();
  const filter = $('filter').value;
  const lastUsed = s => Math.max(0, ...Object.values(s.methods).map(m => m.lastSeen || 0));

  renderChart(sites);

  let rows = sites.filter(s => {
    if (filter && !s.methods[filter]) return false;
    if (pick && !pick.ids.some(id => s.methods[id])) return false;
    if (!q) return true;
    const hay = [s.domain, s.name, ...(s.websites || []), ...Object.entries(s.methods).map(([id, m]) => `${METHODS[id]?.label || id} ${m.username || ''}`)].join(' ').toLowerCase();
    return hay.includes(q);
  });
  rows.sort($('sort').value === 'az' ? (a, b) => (a.name || a.domain).localeCompare(b.name || b.domain, undefined, { sensitivity: 'base' }) : (a, b) => lastUsed(b) - lastUsed(a));

  // Pages of PAGE_SIZE sites. Going past the last page (e.g. after removing sites) steps back.
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  page = Math.min(Math.max(1, page), pages);
  const start = (page - 1) * PAGE_SIZE;
  $('list').replaceChildren(...rows.slice(start, start + PAGE_SIZE).map(entry));
  $('pager').hidden = rows.length <= PAGE_SIZE;
  $('prevPage').disabled = page === 1;
  $('nextPage').disabled = page === pages;
  $('pageInfo').textContent = `Page ${page} of ${pages} \u00b7 ${start + 1}\u2013${Math.min(start + PAGE_SIZE, rows.length)} of ${rows.length} sites`;
  const empty = $('empty');
  empty.hidden = rows.length > 0;
  empty.textContent = sites.length
    ? 'No sites match that search.'
    : HISTORY_SCAN
      ? 'No sites yet. Scan your browsing history above, or just sign in somewhere and it will appear here.'
      : ($('onboard').hidden ? 'No sites yet. Use Check your accounts to find the sites you\u2019ve signed in to with Google, GitHub and others. New sign-ins with a provider appear here too.' : 'Your sites will appear here once you check your accounts.');
}

function entry(site) {
  const methods = sortedMethods(site);
  const usernames = [...new Set(methods.map(([, m]) => m.username).filter(Boolean))];
  const last = Math.max(0, ...methods.map(([, m]) => m.lastSeen || 0));
  const isDomain = /\./.test(site.domain) && !/\s/.test(site.domain);

  const extra = el('div', { class: 'extra' },
    usernames.length ? el('span', {}, `Account: ${usernames.join(', ')}`) : null);

  // Show the app's name when the provider gave one, with its website(s) underneath.
  const sites = [...(isDomain ? [site.domain] : []), ...(site.websites || [])];
  const link = d => el('a', { href: `https://${d}`, target: '_blank', rel: 'noopener' }, d);
  const title = site.name || site.domain;
  return el('li', { class: 'entry' },
    el('div', { class: 'domain' },
      site.name || !isDomain ? el('span', {}, title) : link(site.domain),
      (site.name || !isDomain) && el('div', { class: 'sites' },
        sites.length ? sites.slice(0, 3).flatMap((d, i) => i ? [', ', link(d)] : [link(d)])
                     : el('span', { class: 'muted', title: 'The provider didn\u2019t list a website, so this matches sites with the same name, e.g. ollama.com for Ollama.' }, 'Matched by name'))),
    el('div', { class: 'tags' },
      methods.map(([id, m]) => methodTag(id, m, { onRemove: async () => { await removeMethod(site.domain, id); render(); } }))),
    el('div', { class: 'side' },
      el('span', {}, ago(last)),
      el('button', {
        class: 'btn quiet', title: `Remove ${site.domain}`, 'aria-label': `Remove ${site.domain}`,
        onclick: async () => { if (confirm(`Remove ${site.domain} from the ledger?`)) { await removeSite(site.domain); render(); } },
      }, 'Remove')),
    extra);
}

// ---------- Sign-ins by provider (3D pie) ----------
// pick: the slice chosen in the pie, { key, ids, label } - "Other" covers several providers.
let pick = null;
let pie = null;
let lastSlicesKey = '';
const MORE = '__more';

function providerCounts(sites) {
  const order = Object.keys(METHODS);
  const counts = new Map();
  for (const s of sites) for (const id of Object.keys(s.methods)) if (isThirdParty(id)) counts.set(id, (counts.get(id) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0]));
}

function renderChart(sites) {
  const counts = providerCounts(sites);
  $('chartPanel').hidden = counts.length === 0;
  if (!counts.length) return;
  if (!pie) {
    pie = new Pie3D($('pie'), {
      onSelect: key => selectSlice(key),
      onHover: (key, e) => showTip(key, e),
    });
  }
  const top = counts.slice(0, counts.length > MAX_SLICES + 1 ? MAX_SLICES : MAX_SLICES + 1);
  const rest = counts.slice(top.length);
  // Only four colours stay distinguishable when every slice touches every other, so a fifth
  // provider and beyond share the hatched "Other" slice. The legend lists each one.
  let slices = top.slice(0, MAX_SLICES).map(([id, n]) => ({ id, ids: [id], label: METHODS[id]?.label || id, value: n }));
  const folded = [...top.slice(MAX_SLICES), ...rest];
  if (folded.length) {
    slices.push({
      id: MORE, ids: folded.map(([id]) => id), value: folded.reduce((n, [, v]) => n + v, 0), folded: true,
      label: folded.length === 1 ? (METHODS[folded[0][0]]?.label || folded[0][0]) : 'Other',
    });
  }
  const key = JSON.stringify(slices.map(x => [x.id, x.value]));
  if (key !== lastSlicesKey) {
    pie.setData(slices, { animate: !lastSlicesKey });
    lastSlicesKey = key;
  }
  pie.slicesMeta = slices;
  const total = slices.reduce((n, x) => n + x.value, 0);
  $('pie').setAttribute('aria-label', 'Pie chart of sites per sign-in provider: ' +
    counts.map(([id, n]) => `${METHODS[id]?.label || id} ${n}`).join(', '));

  // Legend doubles as the table view: every provider, its count, and a way in by keyboard.
  const sliceOf = id => slices.find(x => x.ids.includes(id));
  $('legend').replaceChildren(...counts.map(([id, n]) => {
    const sl = sliceOf(id);
    const color = pie.colorOf(sl.id);
    const pressed = pick ? (pick.ids.length === 1 ? pick.ids[0] === id : pick.key === sl.id) : false;
    return el('li', { class: sl.folded ? 'folded' : '' },
      el('button', {
        type: 'button', 'aria-pressed': String(pressed),
        title: `Show the ${n} site${n === 1 ? '' : 's'} you sign in to with ${METHODS[id]?.label || id}`,
        onclick: () => selectProvider(pressed ? null : id),
      },
        el('span', { class: `sw${sl.folded ? ' hatch' : ''}`, style: `--c:${color}` }),
        providerIcon(id, 16) || el('span', {}),
        el('span', { class: 'lname' }, METHODS[id]?.label || id),
        el('span', { class: 'lcount' }, `${n} · ${Math.round(n / total * 100)}%`)));
  }));
  // A provider folded into "Other" lifts the Other slice.
  pie.setSelected(pick ? (pick.ids.length === 1 ? (sliceOf(pick.ids[0])?.id ?? null) : pick.key) : null);

  // "Showing sites signed in with Google (25)"
  $('showing').hidden = !pick;
  if (pick) {
    const n = sites.filter(s => pick.ids.some(id => s.methods[id])).length;
    $('showingText').textContent = `${n} site${n === 1 ? '' : 's'} signed in with ${pick.label}`;
  }
}

function selectSlice(key) {
  if (!key) return selectProvider(null);
  const sl = (pie.slicesMeta || []).find(x => x.id === key);
  if (!sl) return;
  if (sl.ids.length === 1) return selectProvider(sl.ids[0]);
  page = 1;
  pick = { key, ids: sl.ids, label: sl.ids.map(id => METHODS[id]?.label || id).join(', ') };
  $('filter').value = '';
  render();
  $('showing').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function selectProvider(id) {
  page = 1;
  pick = id ? { key: id, ids: [id], label: METHODS[id]?.label || id } : null;
  $('filter').value = '';
  $('q').value = '';
  render();
  if (id) $('showing').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function showTip(key, e) {
  const tip = $('pieTip');
  const sl = key && (pie.slicesMeta || []).find(x => x.id === key);
  if (!sl || !e) { tip.hidden = true; return; }
  const total = pie.slicesMeta.reduce((n, x) => n + x.value, 0);
  const names = sl.ids.map(id => METHODS[id]?.label || id).join(', ');
  tip.textContent = `${names}: ${sl.value} site${sl.value === 1 ? '' : 's'} (${Math.round(sl.value / total * 100)}%)`;
  const r = $('pie').getBoundingClientRect();
  tip.style.left = `${e.clientX - r.left}px`;
  tip.style.top = `${e.clientY - r.top}px`;
  tip.hidden = false;
}

// ---------- History scan ----------
async function runScan(btn) {
  const buttons = [$('scan'), $('scan2')];
  buttons.forEach(b => { b.disabled = true; });
  btn.textContent = 'Scanning…';
  try {
    const { found, unattributed } = await scanHistory(({ step, of }) => say(`Scanning history… ${Math.round(step / of * 100)}%`));
    const sites = new Set(found.map(f => f.site)).size;
    say(found.length
      ? `Found ${found.length} sign-in${found.length === 1 ? '' : 's'} across ${sites} site${sites === 1 ? '' : 's'}.` +
        (unattributed ? ` ${unattributed} more had no site address in them and were skipped.` : '')
      : 'No third-party sign-ins found in your history. They’ll be recorded from now on as you sign in.');
    history.replaceState(null, '', location.pathname);
  } catch (e) {
    say(`The scan stopped: ${e.message}`);
  } finally {
    buttons.forEach(b => { b.disabled = false; b.textContent = 'Scan browsing history'; });
    render();
  }
}

// ---------- Check your accounts ----------
const busy = new Set();

// Which providers are ticked for "Check selected". Remembered between visits.
let selected = new Set();
async function loadSelection() {
  try {
    const { syncSelection } = await chrome.storage.local.get('syncSelection');
    const valid = new Set(SYNC_PROVIDERS.map(p => p.id));
    selected = new Set((syncSelection || []).filter(id => valid.has(id)));
  } catch { selected = new Set(); }
}
function saveSelection() {
  chrome.storage.local.set({ syncSelection: [...selected] }).catch(() => {});
}
function updateSelectionControls() {
  const n = selected.size, total = SYNC_PROVIDERS.length;
  const btn = $('syncSelected');
  btn.textContent = n ? `Check selected (${n})` : 'Check selected';
  btn.disabled = n === 0 || [...selected].every(id => busy.has(id));
  btn.title = n ? '' : 'Tick the accounts you want to check';
  const all = $('selectAll');
  all.checked = n === total;
  all.indeterminate = n > 0 && n < total;
  $('syncAll').disabled = busy.size === total;
}

// Account row actions are icon buttons; the action's name shows on hover and keyboard focus.
const ICONS = {
  check: '<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>',
  signIn: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5"/><path d="M15 12H3"/>',
  manage: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
};
function iconButton(icon, tip, label, attrs) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[icon];
  return el('button', { type: 'button', ...attrs, class: `btn icon-btn ${attrs.class || ''}`, 'aria-label': label, 'data-tip': tip }, svg);
}
// Check is always there. Sign in only appears, highlighted, when the last check found you signed out;
// Manage only once a check has pulled that account's apps.
const signInButton = p => iconButton('signIn', 'Sign in', `Sign in to ${METHODS[p.id].label}`,
  { class: 'primary', onclick: () => chrome.tabs.create({ url: p.signIn, active: true }) });
const manageButton = (id, url) => iconButton('manage', 'Manage', `Manage ${METHODS[id].label} connected apps`,
  { onclick: () => chrome.tabs.create({ url, active: true }) });

async function renderSyncRows() {
  const state = await getSyncState();
  const rows = SYNC_PROVIDERS.map(p => {
    const meta = METHODS[p.id];
    const s = state[p.id];
    let stateEl, needsLogin = false;
    if (busy.has(p.id)) stateEl = el('span', { class: 'state busy' }, 'Checking…');
    else if (!s) stateEl = el('span', { class: 'state' }, 'Not checked');
    else if (s.status === 'login') { needsLogin = true; stateEl = el('span', { class: 'state warn', title: 'You weren’t signed in when this was checked. Sign in, then check again.' }, 'Signed out'); }
    else if (s.status === 'error') stateEl = el('span', { class: 'state warn', title: s.message || '' }, 'Couldn’t read');
    else stateEl = s.apps.length
      ? el('button', { class: 'btn quiet state ok', title: `Checked ${ago(s.at)}. Show these sites in your ledger.`, onclick: () => showProvider(p.id) },
          `${s.apps.length} app${s.apps.length === 1 ? '' : 's'}`)
      : el('span', { class: 'state', title: `Checked ${ago(s.at)}` }, 'None found');

    const box = el('input', { type: 'checkbox', checked: selected.has(p.id), 'aria-label': `Select ${meta.label}` });
    box.addEventListener('change', () => {
      box.checked ? selected.add(p.id) : selected.delete(p.id);
      box.closest('.sync-row').classList.toggle('selected', box.checked);
      saveSelection();
      updateSelectionControls();
    });
    return el('li', { class: `sync-row${needsLogin ? ' needs-login' : ''}${selected.has(p.id) ? ' selected' : ''}` },
      el('label', { class: 'pname' }, box, providerIcon(p.id, 18), meta.label),
      stateEl,
      el('div', { class: 'row-actions' },
        iconButton('check', 'Check', `Check ${meta.label}`, { disabled: busy.has(p.id), onclick: () => runSync([p.id]) }),
        ROW_LINKS && needsLogin && signInButton(p),
        ROW_LINKS && !busy.has(p.id) && s?.status === 'ok' && s.apps.length > 0 && manageButton(p.id, p.pages[0])));
  });
  // Apple can't be read automatically, so Manage is how you look at its apps.
  const manual = MANUAL_PROVIDERS.map(p => el('li', { class: 'sync-row' },
    el('span', { class: 'pname' }, el('span', { class: 'spacer', 'aria-hidden': 'true' }), providerIcon(p.id, 18), METHODS[p.id].label),
    el('span', { class: 'state', title: 'Apple asks for your password on its page, so it can’t be read automatically. Open Manage, then add those sites with Add a site by hand.' }, 'Check by hand'),
    el('div', { class: 'row-actions' }, ROW_LINKS && [el('span', { class: 'icon-slot', 'aria-hidden': 'true' }), manageButton(p.id, p.page)])));
  $('syncRows').classList.toggle('links', ROW_LINKS);
  $('syncRows').replaceChildren(...rows, ...manual);
  updateSelectionControls();
}

async function runSync(ids) {
  ids = ids.filter(id => !busy.has(id));
  if (!ids.length) return;
  ids.forEach(id => busy.add(id));
  renderSyncRows();
  say(ids.length > 1 ? 'Checking your accounts in background tabs…' : `Checking ${METHODS[ids[0]].label}…`);

  const queue = [...ids];
  let added = 0, removed = 0;
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift();
      const res = await syncProvider(id);
      await setSyncState(id, { at: Date.now(), status: res.status, apps: res.apps, message: res.message || '' });
      // Await first, then add: `added += await …` would read the total before other checks update it.
      const r = await addFound(id, res.apps, res.websites);
      added += r.added;
      // Drop apps this provider no longer lists. Skipped when nothing was read, so a page that
      // failed to load (or a provider redesign) can't wipe your list.
      if (res.status === 'ok' && res.apps.length) {
        const n = await pruneProviderApps(id, r.keys);
        removed += n;
      }
      busy.delete(id);
      renderSyncRows();
      onSyncProgress?.(ids.length - queue.length - [...busy].filter(b => ids.includes(b)).length, ids.length);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  updateSelectionControls();

  const state = await getSyncState();
  const login = ids.filter(id => state[id]?.status === 'login').map(id => METHODS[id].label);
  const failed = ids.filter(id => state[id]?.status === 'error').map(id => METHODS[id].label);
  const found = ids.reduce((n, id) => n + (state[id]?.apps?.length || 0), 0);
  const already = found - added;
  say([
    `Found ${found} app${found === 1 ? '' : 's'}` +
      (found ? `: added ${added} new to your ledger${already ? `, ${already} ${already === 1 ? 'was' : 'were'} already there` : ''}.` : '.'),
    removed ? `Removed ${removed} app${removed === 1 ? '' : 's'} no longer listed in ${removed === 1 ? 'that account' : 'those accounts'}.` : '',
    login.length ? `Sign in to ${login.join(', ')}, then check ${login.length === 1 ? 'it' : 'them'} again.` : '',
    failed.length ? `Couldn’t read ${failed.join(', ')}.` : '',
  ].filter(Boolean).join(' '));
  await render();
  onSyncDone?.({ found, added, login, failed });
}

// Add everything a provider lists straight to the ledger. Names that match a site you already
// have (e.g. "Notion" and notion.so) go onto that site. Returns how many were new.
async function addFound(id, apps, websites = {}) {
  let added = 0;
  const keys = new Set();
  for (const name of new Set(apps)) {
    const { isNew, key } = await addProviderApp(name, id, cleanWebsites(websites[name]));
    if (isNew) added++;
    if (key) keys.add(key);
  }
  return { added, keys };
}

// Clicking "25 apps" on a provider's row filters the ledger to that provider.
function showProvider(id) {
  selectProvider(id);
}

$('syncAll').addEventListener('click', () => runSync(SYNC_PROVIDERS.map(p => p.id)));
// Keep the providers' order, not the order they were ticked.
$('syncSelected').addEventListener('click', () => runSync(SYNC_PROVIDERS.map(p => p.id).filter(id => selected.has(id))));
$('selectAll').addEventListener('change', e => {
  selected = e.target.checked ? new Set(SYNC_PROVIDERS.map(p => p.id)) : new Set();
  saveSelection();
  renderSyncRows();
});
function normaliseEntry(line) {
  const s = line.trim().replace(/^[-*•\d.)\s]+/, '').trim();
  if (!s) return null;
  // A URL or bare domain becomes its site; anything else (an app name) is kept as typed.
  const asUrl = /^[a-z]+:\/\//i.test(s) ? s : (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(s) ? `https://${s}` : null);
  if (asUrl) return siteOf(asUrl);
  return s.slice(0, 80);
}

// ---------- Export / import ----------
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const stamp = () => new Date().toISOString().slice(0, 10);
const csvCell = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);

async function exportCsv() {
  const all = await getAll();
  const lines = [['Site', 'Website', 'Method', 'Status', 'Account', 'First seen', 'Last used', 'Source']];
  for (const s of Object.values(all)) {
    for (const [id, m] of sortedMethods(s)) {
      lines.push([s.name || s.domain, [...(isDomainKey(s.domain) ? [s.domain] : []), ...(s.websites || [])].join(' '), METHODS[id]?.label || id, m.confirmed || m.source === 'manual' ? 'signed in' : 'seen',
        m.username || '', new Date(m.firstSeen).toISOString().slice(0, 10), new Date(m.lastSeen).toISOString().slice(0, 10),
        m.source || '']);
    }
  }
  download(`authscope-${stamp()}.csv`, lines.map(r => r.map(csvCell).join(',')).join('\n'), 'text/csv');
}

// ---------- First-run welcome ----------
// Shown once to new users: on install (?welcome=1) or whenever the list is empty, until they finish
// or skip it. People updating with sites already in their list never see it.
let onSyncProgress = null, onSyncDone = null;
const ONBOARD_KEY = 'onboarding';

async function onboardingDone() {
  try { return (await chrome.storage.local.get(ONBOARD_KEY))[ONBOARD_KEY] === 'done'; } catch { return true; }
}
function finishOnboarding() {
  chrome.storage.local.set({ [ONBOARD_KEY]: 'done' }).catch(() => {});
}

async function showOnboarding() {
  if (await onboardingDone()) return;
  const all = await getAll();
  const fresh = new URLSearchParams(location.search).has('welcome');
  if (Object.keys(all).length && !fresh) return;
  $('onboard').hidden = false;
  $('access').hidden = true; // the guide has its own Allow step

  // Firefox: site access first, if it hasn't been given yet
  let granted = true;
  try { granted = await chrome.permissions.contains(ALL_SITES); } catch { /* assume granted */ }
  $('stepAccess').hidden = granted;
  $('onboardGrant').addEventListener('click', () => {
    chrome.permissions.request(ALL_SITES).then(ok => {
      if (ok) { $('stepAccess').classList.add('done'); $('onboardGrant').hidden = true; }
      else say('AuthScope needs access to the provider sites to check your accounts. Click Allow to try again.');
    });
  });

  $('onboardCheck').addEventListener('click', () => {
    if ($('onboardCheck').dataset.state === 'done') { $('onboard').hidden = true; finishOnboarding(); return; }
    $('onboardCheck').disabled = true;
    $('onboardCheck').textContent = 'Checking\u2026';
    $('onboardProgress').hidden = false;
    $('onboardBar').style.width = '4%';
    $('onboardProgressText').textContent = `Checking ${SYNC_PROVIDERS.length} accounts\u2026`;
    onSyncProgress = (done, total) => {
      $('onboardBar').style.width = `${Math.max(4, Math.round(done / total * 100))}%`;
      $('onboardProgressText').textContent = `Checked ${done} of ${total} accounts\u2026`;
    };
    onSyncDone = ({ found, login }) => {
      onSyncProgress = onSyncDone = null;
      $('onboardBar').style.width = '100%';
      $('onboardCheck').disabled = false;
      const signIn = login.length ? ` Sign in to ${login.join(', ')} and check ${login.length === 1 ? 'it' : 'them'} again from the panel on the right.` : '';
      if (found) {
        $('stepCheck').classList.add('done');
        $('onboardProgressText').textContent = `Found ${found} app${found === 1 ? '' : 's'}. Your list is below.` + signIn;
        $('onboardCheck').textContent = 'Done';
        $('onboardCheck').dataset.state = 'done';
        $('onboardSkip').hidden = true;
        finishOnboarding();
      } else {
        $('onboardProgressText').textContent = (login.length
          ? 'No apps found yet: you\u2019re not signed in to those accounts in this browser.'
          : 'No linked apps found in your accounts.') + signIn;
        $('onboardCheck').textContent = 'Check again';
      }
    };
    runSync(SYNC_PROVIDERS.map(p => p.id));
  });

  $('onboardSkip').addEventListener('click', () => { $('onboard').hidden = true; finishOnboarding(); checkSiteAccess(); });
}

// ---------- Site access (Firefox lets people switch this off) ----------
const ALL_SITES = { origins: chrome.runtime.getManifest().host_permissions }; // the provider sites
const isFirefox = navigator.userAgent.includes('Firefox/');

async function checkSiteAccess() {
  if (isFirefox) $('historyLength').textContent = 'Firefox keeps months of history, often more than a year.';
  let granted = true;
  try { granted = await chrome.permissions.contains(ALL_SITES); } catch { /* not supported: assume granted */ }
  $('access').hidden = granted || !$('onboard').hidden;
}

$('grant').addEventListener('click', async () => {
  // Must run straight from the click, so no awaits before the request.
  chrome.permissions.request(ALL_SITES).then(ok => {
    say(ok ? 'Access granted. New sign-ins will be recorded from now on.' : 'Access wasn’t granted. New sign-ins won’t be recorded until you allow it.');
    checkSiteAccess();
  });
});

// ---------- Wire up ----------
async function init() {
  $('filter').append(...PROVIDER_IDS.map(id => el('option', { value: id }, METHODS[id].label)));
  $('addMethod').replaceChildren(...methodOptions('google'));
  const donate = donateUrl();
  if (donate) { $('donate').href = donate; $('donate').title = 'Opens your Ko-fi page in a new tab'; $('donate').hidden = false; }
  // Earlier versions saved password and passkey sign-ins; make sure they're gone before showing anything.
  await purgeNonProvider().catch(() => {});
  await loadSelection();
  renderSyncRows();
  checkSiteAccess();
  await showOnboarding();

  ['q', 'sort'].forEach(id => $(id).addEventListener('input', () => { page = 1; render(); }));
  $('filter').addEventListener('input', () => { pick = null; page = 1; render(); });
  const turn = d => { page += d; render(); $('list').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  $('prevPage').addEventListener('click', () => turn(-1));
  $('nextPage').addEventListener('click', () => turn(1));
  $('showAll').addEventListener('click', () => selectProvider(null));
  $('scan').hidden = !HISTORY_SCAN;
  if (HISTORY_SCAN) {
    $('scan').addEventListener('click', e => runScan(e.currentTarget));
    $('scan2').addEventListener('click', e => runScan(e.currentTarget));
  }

  $('addForm').addEventListener('submit', async e => {
    e.preventDefault();
    const raw = $('addSite').value.trim();
    const domain = normaliseEntry(raw) || registrableDomain(raw);
    if (!domain) return;
    await recordMethod(domain, $('addMethod').value, { source: 'manual', confirmed: true });
    $('addSite').value = '';
    say(`Added ${domain}.`);
    render();
  });


  $('exportJson').addEventListener('click', async () =>
    download(`authscope-${stamp()}.json`, JSON.stringify({ app: 'authscope', version: 1, exported: new Date().toISOString(), accounts: await getAll() }, null, 2), 'application/json'));
  $('exportCsv').addEventListener('click', exportCsv);
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const added = await mergeImport(data.accounts || data);
      say(`Imported ${added} sign-in method${added === 1 ? '' : 's'}. Anything you already had was kept.`);
    } catch {
      say('That file isn’t an AuthScope backup. Choose a .json file made with Export backup.');
    }
    e.target.value = '';
    render();
  });
  $('clear').addEventListener('click', async () => {
    if (!confirm('Delete every site from AuthScope? Export a backup first if you might want it back.')) return;
    await clearAll();
    say('Everything was deleted.');
    render();
  });

  const settings = await getSettings();
  document.querySelectorAll('[data-setting]').forEach(box => {
    box.checked = !!settings[box.dataset.setting];
    box.addEventListener('change', () => saveSettings({ [box.dataset.setting]: box.checked }));
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.accounts) render();
  });
  render();
}

init();
