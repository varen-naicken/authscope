import { matchStrength, findEntriesFor, baseName, cleanWebsites, primaryWebsite, findExistingFor } from '../lib/match.js';
let fail = 0; const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) { fail++; console.log('FAIL', m, JSON.stringify(a), '!=', JSON.stringify(b)); } };
const e = (domain, extra = {}) => ({ domain, note: '', methods: { github: { lastSeen: 1 } }, ...extra });

// The user's real cases
eq(matchStrength(e('Ollama'), 'ollama.com') > 0, true, 'Ollama name -> ollama.com');
eq(matchStrength(e('Netlify Auth'), 'netlify.com') > 0, true, 'Netlify Auth -> netlify.com');
eq(matchStrength(e('Expedia Group'), 'expedia.ie') > 0, true, 'Expedia Group -> expedia.ie');
eq(matchStrength(e('Claude'), 'claude.ai') > 0, true, 'Claude -> claude.ai');
eq(matchStrength(e('anthropic.com', { name: 'Claude' }), 'claude.ai') > 0, true, 'Claude (anthropic.com) -> claude.ai by name');
eq(matchStrength(e('deliveroo.com', { name: 'Deliveroo' }), 'deliveroo.ie') > 0, true, 'deliveroo.com -> deliveroo.ie');
eq(matchStrength(e('seekly.ie', { name: 'Seekly', websites: ['jobgroup.de'] }), 'seekly.ie'), 3, 'exact');
eq(matchStrength(e('goeuro.com', { name: 'Omio' }), 'omio.com') > 0, true, 'Omio name -> omio.com');
eq(matchStrength(e('skyscanner.net', { name: 'Skyscanner' }), 'skyscanner.ie') > 0, true, 'skyscanner other TLD');
// No false matches
eq(matchStrength(e('GitHub Desktop'), 'github.com'), 0, 'GitHub Desktop not on github.com');
eq(matchStrength(e('Visual Studio Code'), 'code.visualstudio.com'), 0, 'VS Code no guess');
eq(matchStrength(e('Ollama'), 'llama.com'), 0, 'no partial');
eq(matchStrength(e('Text Editor'), 'texteditor.co') > 0, true, 'Text Editor -> texteditor.co');
eq(matchStrength(e('Kasa'), 'kasa.com') > 0, true, 'kasa');
eq(matchStrength(e('Copilot SWE Agent'), 'copilot.microsoft.com'), 0, 'no copilot guess');
eq(baseName('GitHub Desktop'), 'github', 'filler');
eq(cleanWebsites(['www.ollama.com', 'ollama.com', 'github.com', 'docs.ollama.com']), ['ollama.com'], 'clean');
eq(primaryWebsite('Seekly', ['jobgroup.de', 'seekly.ie']), 'seekly.ie', 'primary by name');
eq(primaryWebsite('Claude', ['anthropic.com']), 'anthropic.com', 'primary fallback first');
const all = { 'Claude': e('Claude'), 'ollama.com': e('ollama.com') };
eq(findExistingFor(all, 'Claude', ['anthropic.com'])?.domain, 'Claude', 'reuse name-only entry');
eq(findExistingFor(all, 'Ollama', [])?.domain, 'ollama.com', 'reuse detected domain entry for name');
eq(findEntriesFor({ a: e('Ollama'), b: e('ollama.com'), c: e('Pinterest') }, 'ollama.com').map(x => x.domain), ['ollama.com', 'Ollama'], 'find order');
console.log(fail ? `${fail} failed` : 'all passed');
