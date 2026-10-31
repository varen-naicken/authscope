const { chromium } = require('playwright');
const path = require('path'), fs = require('fs');
const EXT = process.env.AUTHSCOPE_EXT || path.resolve(__dirname, '..');
const OUT = path.join(require('os').tmpdir(), 'authscope-tests');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Sample data: Google 25, GitHub 8, LinkedIn 1 (Claude on both Google and GitHub).
const google = ['Airtable','Asana','Bitly','Calendly','Canva','Claude','Coursera','Deliveroo','Dropbox','Eventbrite','Evernote','Figma','Grammarly','Kayak','Loom','Miro','Notion','Pinterest','Quizlet','Skyscanner','Spotify','Trello','Tripadvisor','Udemy','Zoom'];
const github = ['FireCrawl','Git Credential Manager','GitHub Desktop','Netlify Auth','Ollama','Visual Studio Code','Claude','Copilot SWE Agent'];
function seed(extra = {}) {
  const acc = {};
  const add = (name, m) => { acc[name] = acc[name] || { domain: name, note: '', methods: {} }; acc[name].methods[m] = { firstSeen: 1, lastSeen: Date.now() - Math.random() * 1e9, count: 1, confirmed: true, source: 'provider' }; };
  google.forEach(n => add(n, 'google')); github.forEach(n => add(n, 'github')); add('Authenticate', 'linkedin');
  for (const [n, ms] of Object.entries(extra)) ms.forEach(m => add(n, m));
  return acc;
}

(async () => {
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(OUT, 'profile-')), {
    headless: true, channel: 'chromium', args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  const results = [];
  const check = (name, cond, detail) => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + JSON.stringify(detail)}`);
  const errors = [];

  const dash = await ctx.newPage();
  dash.on('pageerror', e => errors.push(String(e)));
  await dash.setViewportSize({ width: 1280, height: 1000 });

  // Empty ledger: no chart
  await sw.evaluate(() => chrome.storage.local.set({ accounts: {} }));
  await dash.goto(`chrome-extension://${extId}/dashboard.html`); await sleep(400);
  check('chart hidden while ledger is empty', await dash.$eval('#chartPanel', e => e.hidden), null);

  await sw.evaluate(a => chrome.storage.local.set({ accounts: a }), seed());
  await dash.reload(); await sleep(1600);
  const legend = await dash.$$eval('#legend button', bs => bs.map(b => b.innerText.replace(/\s+/g, ' ').trim()));
  check('chart shown with counts per provider', JSON.stringify(legend) === JSON.stringify(['Google 25 · 74%', 'GitHub 8 · 24%', 'LinkedIn 1 · 3%']), legend);
  const aria = await dash.$eval('#pie', c => c.getAttribute('aria-label'));
  check('chart has a text description', /Google 25, GitHub 8, LinkedIn 1/.test(aria), aria);
  await dash.screenshot({ path: `${OUT}/pie-light.png`, clip: { x: 60, y: 90, width: 820, height: 520 } });

  // Click the Google slice on the canvas: find a point on it via the chart's own hit test
  const pt = await dash.evaluate(() => {
    const c = document.getElementById('pie'), r = c.getBoundingClientRect();
    return null;
  });
  const findPoint = async id => dash.evaluate(async id => {
    const c = document.getElementById('pie');
    const mod = await import(chrome.runtime.getURL('ui/pie3d.js'));
    const r = c.getBoundingClientRect();
    // scan a grid and use the page's live hit test through a synthetic pointermove
    const hits = [];
    for (let y = 10; y < r.height; y += 6) for (let x = 10; x < r.width; x += 6) {
      c.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + x, clientY: r.top + y, bubbles: true }));
      const tip = document.getElementById('pieTip');
      if (!tip.hidden && tip.textContent.startsWith(id + ':')) hits.push({ x: r.left + x, y: r.top + y, tip: tip.textContent });
    }
    if (!hits.length) return null;
    // click the middle of the slice, not its edge
    const mx = hits.reduce((n, h) => n + h.x, 0) / hits.length, my = hits.reduce((n, h) => n + h.y, 0) / hits.length;
    return hits.sort((a, b) => Math.hypot(a.x - mx, a.y - my) - Math.hypot(b.x - mx, b.y - my))[0];
  }, id);
  const g = await findPoint('Google');
  check('hovering a slice shows a tooltip', g && /Google: 25 sites \(74%\)/.test(g.tip), g);
  await dash.mouse.click(g.x, g.y); await sleep(700);
  let shown = await dash.$$eval('#list .entry .domain > :first-child', d => d.map(x => x.textContent.trim()));
  let showing = await dash.textContent('#showingText');
  const pinfo = await dash.textContent('#pageInfo');
  check('clicking Google lists its 25 sites', shown.length === 20 && pinfo === 'Page 1 of 2 · 1–20 of 25 sites' && !shown.includes('Ollama') && /25 sites signed in with Google/.test(showing), { n: shown.length, showing, pinfo });
  check('legend marks Google selected', await dash.$eval('#legend li:first-child button', b => b.getAttribute('aria-pressed')) === 'true', null);
  await dash.screenshot({ path: `${OUT}/pie-selected.png`, clip: { x: 60, y: 90, width: 820, height: 640 } });

  // Click GitHub in the legend (keyboard-friendly route)
  await dash.click('#legend li:nth-child(2) button'); await sleep(500);
  shown = await dash.$$eval('#list .entry .domain > :first-child', d => d.map(x => x.textContent.trim()));
  check('legend click lists GitHub sites', shown.length === 8 && shown.includes('Ollama') && shown.includes('Claude'), shown);
  await dash.click('#showAll'); await sleep(300);
  shown = await dash.$$eval('#list .entry', d => d.length);
  check('Show all sites clears it', shown === 20 && /of 33 sites$/.test(await dash.textContent('#pageInfo')) && await dash.$eval('#showing', e => e.hidden), shown);

  // Notes are gone, list is paginated (33 sites -> 20 + 13)
  check('no note fields', (await dash.$$('.note-input, #note')).length === 0, null);
  const pageState = () => dash.evaluate(() => ({
    rows: document.querySelectorAll('#list .entry').length,
    info: document.getElementById('pageInfo').textContent,
    pager: !document.getElementById('pager').hidden,
    prev: document.getElementById('prevPage').disabled, next: document.getElementById('nextPage').disabled,
  }));
  let ps = await pageState();
  check('page 1 shows 20 of 33', ps.rows === 20 && ps.pager && ps.prev && !ps.next && ps.info === 'Page 1 of 2 · 1–20 of 33 sites', ps);
  const firstPage = await dash.$$eval('#list .entry .domain > :first-child', d => d.map(x => x.textContent));
  await dash.click('#nextPage'); await sleep(300);
  ps = await pageState();
  const secondPage = await dash.$$eval('#list .entry .domain > :first-child', d => d.map(x => x.textContent));
  await dash.$eval('#pager', p => p.scrollIntoView({ block: 'end' })); await sleep(300);
  await dash.screenshot({ path: `${OUT}/pager.png` });
  check('next shows the remaining 13', ps.rows === 13 && !ps.prev && ps.next && ps.info === 'Page 2 of 2 · 21–33 of 33 sites', ps);
  check('pages do not overlap', !secondPage.some(n => firstPage.includes(n)), { firstPage, secondPage });
  await dash.click('#legend li:first-child button'); await sleep(400);
  ps = await pageState();
  check('choosing a provider goes back to page 1', ps.rows === 20 && ps.info === 'Page 1 of 2 · 1–20 of 25 sites', ps);
  await dash.click('#legend li:nth-child(2) button'); await sleep(400);
  ps = await pageState();
  check('pager hidden when everything fits', ps.rows === 8 && !ps.pager, ps);
  await dash.click('#showAll'); await sleep(300);
  await dash.fill('#q', 'o'); await sleep(300);
  ps = await pageState();
  check('search resets to page 1', /^Page 1 of/.test(ps.info) || !ps.pager, ps);
  await dash.fill('#q', ''); await sleep(300);
  // Removing the only site on a last page steps back a page
  await sw.evaluate(a => chrome.storage.local.set({ accounts: Object.fromEntries(Object.entries(a).slice(0, 21)) }), await sw.evaluate(() => chrome.storage.local.get('accounts').then(r => r.accounts)));
  await sleep(300);
  await dash.click('#nextPage'); await sleep(300);
  ps = await pageState();
  check('last page with one site', ps.rows === 1 && ps.info === 'Page 2 of 2 · 21–21 of 21 sites', ps);
  dash.once('dialog', d => d.accept());
  await dash.click('#list .entry button:has-text("Remove")'); await sleep(500);
  ps = await pageState();
  check('removing it steps back to page 1', ps.rows === 20 && !ps.pager, ps);
  await dash.screenshot({ path: `${OUT}/paged.png`, fullPage: true });
  await sw.evaluate(a => chrome.storage.local.set({ accounts: a }), seed());
  await sleep(400);
  await dash.evaluate(() => window.scrollTo(0, 0)); await sleep(300);

  // Drag to rotate: the Google slice moves, a drag doesn't select anything
  const before = await dash.evaluate(() => document.getElementById('pie').toDataURL());
  const box = await dash.$eval('#pie', c => { const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await dash.mouse.move(box.x - 80, box.y); await dash.mouse.down(); await dash.mouse.move(box.x + 60, box.y, { steps: 8 }); await dash.mouse.up(); await sleep(300);
  const after = await dash.evaluate(() => document.getElementById('pie').toDataURL());
  check('dragging turns the pie without selecting', before !== after && await dash.$eval('#showing', e => e.hidden), { changed: before !== after, showingHidden: await dash.$eval('#showing', e => e.hidden), txt: await dash.textContent('#showingText') });

  // Many providers: top 4 get colours, the rest share a hatched "Other" slice
  await sw.evaluate(a => chrome.storage.local.set({ accounts: a }), seed({ A1: ['facebook'], A2: ['facebook'], A3: ['microsoft'], A4: ['discord'], A5: ['yahoo'] }));
  await dash.reload(); await sleep(1600);
  await dash.evaluate(() => window.scrollTo(0, 0));
  const slices = await dash.evaluate(() => (window.__pieSlices = null));
  const legend2 = await dash.$$eval('#legend li', ls => ls.map(l => [l.querySelector('.lname').textContent, l.classList.contains('folded'), l.querySelector('.sw').classList.contains('hatch')]));
  check('fifth+ providers fold into hatched Other', JSON.stringify(legend2.map(x => x[1])) === JSON.stringify([false, false, false, false, true, true, true]) && legend2.slice(4).every(x => x[2]), legend2);
  const o = await findPoint('LinkedIn, Discord, Yahoo');
  check('Other slice tooltip names the providers inside', !!o, o);
  if (o) {
    await dash.mouse.click(o.x, o.y); await sleep(500);
    shown = await dash.$$eval('#list .entry .domain > :first-child', d => d.map(x => x.textContent.trim()).sort());
    check('clicking Other lists those sites', JSON.stringify(shown) === JSON.stringify(['A4', 'A5', 'Authenticate']), shown);
  }
  if (await dash.isVisible('#showAll')) await dash.click('#showAll');
  await dash.emulateMedia({ colorScheme: "dark" }); await dash.reload(); await sleep(2500);
  await dash.screenshot({ path: `${OUT}/pie-dark.png`, clip: { x: 60, y: 90, width: 820, height: 520 } });
  await dash.emulateMedia({ colorScheme: 'light' });
  await dash.setViewportSize({ width: 390, height: 900 }); await dash.reload(); await sleep(1600);
  await dash.screenshot({ path: `${OUT}/pie-mobile.png`, clip: { x: 0, y: 0, width: 390, height: 900 } });

  check('no page errors', errors.length === 0, errors);
  console.log(results.join('\n'));
  await ctx.close();
  if (results.some(r => r.startsWith('FAIL'))) process.exitCode = 1;
})().catch(e => { console.error('ERROR', e); process.exit(1); });
