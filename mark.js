// Injected into a site's page (only when "Point at the button you used" is switched on, and only on
// sites already in your list). Outlines the sign-in buttons for the providers you used here, with a
// small "You used this" label. It only reads the page's buttons; nothing is sent anywhere.
// Drawn in its own shadow-DOM layer that clicks pass through, so the site's own page is left untouched.
// Safe to inject more than once: a later run just updates the providers to look for.
(() => {
  // How each provider's name appears on sign-in buttons.
  const NAMES = {
    google: /\bgoogle\b/i, apple: /\bapple\b/i, github: /\bgithub\b/i,
    microsoft: /\b(microsoft|outlook|office ?365|azure ad|entra)\b/i, facebook: /\bfacebook\b/i,
    x: /\b(twitter|(with|using|via) x)\b/i, linkedin: /\blinked ?in\b/i, discord: /\bdiscord\b/i,
    gitlab: /\bgitlab\b/i, slack: /\bslack\b/i, amazon: /\bamazon\b/i, twitch: /\btwitch\b/i, yahoo: /\byahoo\b/i,
  };
  const ACTION = /\b(sign|log|logg)[\s-]?(in|on|up)\b|\bcontinue\b|\bconnect\b|\bregister\b|\bjoin\b|\bauthori[sz]e\b|\b(with|using|via)\b/i;
  // Provider-made buttons that live in their own frame or element, so their text can't be read.
  const WIDGETS = {
    google: 'iframe[src*="accounts.google.com/gsi/button"], .g_id_signin, #g_id_signin',
    apple: '#appleid-signin, .appleid-signin, apple-login',
  };
  const CLICKABLE = 'button, a[href], [role="button"], [role="link"], input[type="submit"], input[type="button"]';

  if (window.__authscope) { window.__authscope.update(); return; }

  let providers = [];  // provider ids to point at, set by the extension after injecting
  let marked = [];     // [{ el, box }]
  let host, layer, scanTimer, frame;

  const textOf = el => [
    el.innerText || el.value || '', el.getAttribute('aria-label'), el.getAttribute('title'),
    ...[...el.querySelectorAll('img[alt], svg[aria-label]')].map(i => i.getAttribute('alt') || i.getAttribute('aria-label')),
  ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

  const visible = el => {
    const r = el.getBoundingClientRect();
    if (r.width < 16 || r.height < 12) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0.05;
  };

  // A button for this provider: short text naming it alongside a sign-in word, or just the name (icon buttons).
  function matches(el, id) {
    const text = textOf(el);
    if (!text || text.length > 60 || !NAMES[id].test(text)) return false;
    return ACTION.test(text) || text.replace(NAMES[id], '').replace(/[^a-z]/gi, '') === '';
  }

  function findButtons() {
    const found = [];
    for (const id of providers) {
      if (!NAMES[id]) continue;
      const els = [...document.querySelectorAll(CLICKABLE)].filter(el => matches(el, id));
      if (WIDGETS[id]) els.push(...document.querySelectorAll(WIDGETS[id]));
      // Keep the outermost match, so a button and the link inside it get one outline.
      for (const el of els) {
        if (visible(el) && !els.some(o => o !== el && o.contains(el) && visible(o)) && !found.includes(el)) found.push(el);
      }
    }
    return found;
  }

  function ensureLayer() {
    if (host?.isConnected) return;
    host = document.createElement('authscope-marks');
    host.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      .box { position: fixed; box-sizing: border-box; border: 2.5px solid #3b5bf5; border-radius: 10px;
        box-shadow: 0 0 0 4px rgba(59, 91, 245, .22); pointer-events: none; }
      /* Sits on the outline's top edge, so it doesn't cover whatever is just above the button. */
      .tag { position: absolute; left: 10px; top: -11px; white-space: nowrap;
        font: 700 11.5px/1 system-ui, -apple-system, "Segoe UI", sans-serif; letter-spacing: 0;
        color: #fff; background: #3b5bf5; padding: 4px 7px; border-radius: 6px;
        box-shadow: 0 3px 10px -4px rgba(15, 23, 48, .5); }
      .box.below .tag { top: auto; bottom: -11px; }
      @media (prefers-reduced-motion: no-preference) { .box { animation: in .35s ease-out both; } }
      @keyframes in { from { opacity: 0; transform: scale(1.04); } }
    </style><div class="layer" aria-hidden="true"></div>`;
    layer = root.querySelector('.layer');
    document.documentElement.append(host);
  }

  function place() {
    frame = null;
    for (const { el, box } of marked) {
      const r = el.getBoundingClientRect();
      const shown = el.isConnected && r.width > 0 && r.bottom > 0 && r.top < innerHeight;
      box.style.display = shown ? '' : 'none';
      if (!shown) continue;
      Object.assign(box.style, { left: `${r.left - 5}px`, top: `${r.top - 5}px`, width: `${r.width + 10}px`, height: `${r.height + 10}px` });
      box.classList.toggle('below', r.top < 16);
    }
  }
  const schedule = () => { if (marked.length && !frame) frame = requestAnimationFrame(place); };

  function scan() {
    scanTimer = null;
    const els = providers.length ? findButtons() : [];
    if (els.length === marked.length && els.every((el, i) => marked[i].el === el)) return schedule();
    for (const m of marked) m.box.remove();
    marked = [];
    if (!els.length) return;
    ensureLayer();
    marked = els.map(el => {
      const box = document.createElement('div');
      box.className = 'box';
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'You used this';
      box.append(tag);
      layer.append(box);
      return { el, box };
    });
    place();
  }
  const rescan = () => { if (!scanTimer) scanTimer = setTimeout(scan, 250); };

  // Sign-in buttons often appear after the page loads (single-page apps, modals), so keep watching.
  new MutationObserver(muts => { if (muts.some(m => m.target !== host && !host?.contains(m.target))) rescan(); })
    .observe(document.documentElement, { childList: true, subtree: true });
  addEventListener('scroll', schedule, { capture: true, passive: true });
  addEventListener('resize', schedule, { passive: true });

  window.__authscope = {
    set(ids) { providers = Array.isArray(ids) ? ids.filter(id => NAMES[id]) : []; scan(); },
    update() { rescan(); },
  };
})();
