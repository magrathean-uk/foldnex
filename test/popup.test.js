import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// The popup's first-run setup card, run against the real popup.html markup
// with a minimal DOM and chrome.* stand-in.

const POPUP_HTML = await readFile(new URL('../popup.html', import.meta.url), 'utf8');
const VOID_TAGS = new Set(['meta', 'link', 'img', 'input', 'br']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class FakeClassList {
  constructor(names = []) { this.names = new Set(names); }
  add(...names) { names.forEach(name => this.names.add(name)); }
  remove(...names) { names.forEach(name => this.names.delete(name)); }
  contains(name) { return this.names.has(name); }
  toggle(name, force) {
    const on = force === undefined ? !this.names.has(name) : Boolean(force);
    if (on) this.names.add(name);
    else this.names.delete(name);
    return on;
  }
}

class FakeElement {
  constructor(tag, attributes = {}) {
    this.tagName = tag.toUpperCase();
    this.attributes = new Map(Object.entries(attributes));
    this.id = attributes.id || '';
    this.classList = new FakeClassList(String(attributes.class || '').split(/\s+/).filter(Boolean));
    this.dataset = Object.fromEntries(Object.entries(attributes)
      .filter(([name]) => name.startsWith('data-'))
      .map(([name, value]) => [name.slice(5), value]));
    this.children = [];
    this.listeners = {};
    this.textContent = '';
    this.value = attributes.value || '';
    this.checked = 'checked' in attributes;
    this.disabled = false;
    this.title = '';
  }
  get className() { return [...this.classList.names].join(' '); }
  set className(value) { this.classList = new FakeClassList(String(value).split(/\s+/).filter(Boolean)); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  async click() {
    await Promise.all((this.listeners.click || []).map(listener => listener({ target: this, preventDefault() {} })));
  }
  append(...nodes) { this.children.push(...nodes); }
  focus() { globalThis.document.activeElement = this; }
  descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
  matches(selector) {
    const match = selector.match(/^([a-z]+)?((?:\.[\w-]+)*)(?:\[([\w-]+)="([^"]*)"\])?$/);
    if (!match) throw new Error(`Unsupported selector: ${selector}`);
    const [, tag, classes, attribute, value] = match;
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    if (classes && !classes.split('.').filter(Boolean).every(name => this.classList.contains(name))) return false;
    return !attribute || this.getAttribute(attribute) === value;
  }
  querySelectorAll(selector) { return this.descendants().filter(element => element.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

/** Parse popup.html's body into FakeElements: tags, attributes and leaf text. */
function parsePopup(html) {
  const body = html.slice(html.indexOf('<body'), html.indexOf('</body>'));
  const root = new FakeElement('body');
  const stack = [root];
  for (const [, closing, tag, rawAttributes, text] of body.matchAll(/<(\/?)([a-zA-Z0-9]+)([^>]*)>|([^<]+)/g)) {
    const parent = stack[stack.length - 1];
    if (text !== undefined) {
      if (text.trim()) parent.textContent += text.trim();
      continue;
    }
    if (closing) {
      stack.pop();
      continue;
    }
    const attributes = Object.fromEntries([...rawAttributes.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)]
      .map(([, name, value]) => [name, value ?? '']));
    const element = new FakeElement(tag, attributes);
    parent.append(element);
    if (!VOID_TAGS.has(tag.toLowerCase())) stack.push(element);
  }
  return root;
}

function makeArea(store, areaName, listeners) {
  return {
    async get(keys) {
      if (keys === undefined || keys === null) return { ...store };
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter(key => key in store).map(key => [key, store[key]]));
    },
    async set(values) {
      const changes = Object.fromEntries(Object.entries(values)
        .map(([key, value]) => [key, { oldValue: store[key], newValue: value }]));
      Object.assign(store, values);
      setTimeout(() => listeners.forEach(listener => listener(changes, areaName)), 0);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
    }
  };
}

let popupInstance = 0;

/** Load a fresh popup instance over the given storage; every touch of Chrome's Prompt API is counted. */
async function openPopup({ sync = {}, local = {}, groupingResult = null, activeWindowId = null, incognito = false, reply = null, permissions = undefined } = {}) {
  const root = parsePopup(POPUP_HTML);
  const documentListeners = {};
  globalThis.document = {
    activeElement: null,
    getElementById: id => root.descendants().find(element => element.id === id) || null,
    querySelectorAll: selector => root.querySelectorAll(selector),
    querySelector: selector => root.querySelector(selector),
    createElement: tag => new FakeElement(tag),
    addEventListener(type, listener) { (documentListeners[type] ||= []).push(listener); }
  };
  globalThis.window = globalThis;
  let promptApi = 0;
  Object.defineProperty(globalThis, 'LanguageModel', { configurable: true, get() { promptApi++; return {}; } });
  const listeners = [];
  const opened = [];
  const sent = [];
  const runtimeListeners = [];
  globalThis.chrome = {
    storage: {
      sync: makeArea(sync, 'sync', listeners),
      local: makeArea(local, 'local', listeners),
      onChanged: { addListener: listener => listeners.push(listener) }
    },
    tabs: {
      async query() { return activeWindowId === null ? [] : [{ id: 1, windowId: activeWindowId, active: true, incognito }]; },
      async create(details) { opened.push(details.url); return { id: 99 }; },
      async update(id, details) { opened.push(details.url); return { id }; }
    },
    windows: { async update() {} },
    ...(permissions ? { permissions } : {}),
    commands: { async getAll() { return []; } },
    runtime: {
      getURL: path => `chrome-extension://foldnex/${path}`,
      async sendMessage(message) {
        sent.push(message);
        const custom = reply?.(message);
        if (custom !== undefined) return custom;
        if (message.type === 'TRIGGER_GROUPING') return { success: true, result: groupingResult };
        return { ok: true };
      },
      onMessage: { addListener: listener => runtimeListeners.push(listener) },
      openOptionsPage() {}
    }
  };
  await import(`../popup.js?instance=${++popupInstance}`);
  await Promise.all((documentListeners.DOMContentLoaded || []).map(listener => listener()));
  await sleep(20);
  const byId = id => globalThis.document.getElementById(id);
  const choice = name => root.querySelectorAll('.setup-choice').find(element => element.dataset.choice === name);
  const deliver = message => runtimeListeners.forEach(listener => listener(message, {}, () => {}));
  return { root, byId, choice, sync, local, opened, sent, deliver, promptApi: () => promptApi };
}

function allText(root) {
  return root.descendants().map(element => `${element.textContent} ${element.value}`).join(' ');
}

test('the setup card marks the saved engine Current and says where Ollama runs', async () => {
  const loopback = await openPopup({ sync: { provider: 'ollama' } });
  assert.equal(loopback.byId('setupCard').classList.contains('hidden'), false);
  assert.equal(loopback.choice('keep').classList.contains('hidden'), false);
  for (const name of ['cloud', 'offline']) {
    assert.equal(loopback.choice(name).getAttribute('aria-current'), null, name);
  }
  assert.equal(loopback.byId('setupKeepCopy').textContent, 'Runs through the Ollama server on this device, which can itself run cloud models.');

  // Ollama at another address is not on this device, and the card says so.
  const remote = await openPopup({ sync: { provider: 'ollama', ollamaBaseUrl: 'https://ollama.example.com/v1' } });
  assert.equal(remote.choice('keep').classList.contains('hidden'), false);
  assert.doesNotMatch(remote.byId('setupKeepCopy').textContent, /on this device/);
  assert.match(remote.byId('setupKeepCopy').textContent, /another address/);

  // A saved address the resolver refuses is not named as a recipient.
  const refused = await openPopup({ sync: { provider: 'ollama', ollamaBaseUrl: 'http://192.168.1.20:11434/v1' } });
  assert.match(refused.byId('setupKeepCopy').textContent, /not used, so cleanup runs locally/);

  const cloud = await openPopup({ sync: { provider: 'groq' } });
  assert.equal(cloud.choice('cloud').getAttribute('aria-current'), 'true');
  assert.equal(cloud.choice('cloud').querySelector('.setup-pill.current').classList.contains('hidden'), false);
  assert.equal(cloud.choice('keep').classList.contains('hidden'), true);

  const answered = await openPopup({ sync: { provider: 'offline', setupChoice: 'offline' } });
  assert.equal(answered.byId('setupCard').classList.contains('hidden'), true);
});

test('Cloud setup without a saved key keeps the engine and opens Settings; with one it never shows the key', async () => {
  const popup = await openPopup({ sync: { provider: 'offline' } });
  await popup.choice('cloud').click();
  await sleep(10);
  assert.equal(popup.sync.setupChoice, 'cloud');
  assert.equal(popup.sync.provider, 'offline');
  assert.deepEqual(popup.opened, ['chrome-extension://foldnex/options/options.html#engine']);
  assert.equal(popup.byId('setupCard').classList.contains('hidden'), true);
  assert.equal(popup.byId('btnGroupTabs').disabled, false);

  const keyed = await openPopup({ sync: { provider: 'offline' }, local: { groqApiKey: 'gsk-secret-value' } });
  await keyed.choice('cloud').click();
  await sleep(10);
  assert.equal(keyed.sync.provider, 'groq');
  assert.equal(keyed.sync.setupChoice, 'cloud');
  assert.deepEqual(keyed.opened, []);
  assert.ok(!JSON.stringify(keyed.sync).includes('gsk-secret-value'));
  assert.ok(!allText(keyed.root).includes('gsk-secret-value'));
});

test('the setup card offers cloud and Offline smart mode only, and an old Nano profile shows Offline as current', async () => {
  const fresh = await openPopup({ sync: {} });
  const offered = fresh.root.querySelectorAll('.setup-choice').filter(element => !element.classList.contains('hidden'));
  assert.deepEqual(offered.map(element => element.dataset.choice), ['cloud', 'offline']);
  const card = allText(fresh.byId('setupCard'));
  assert.doesNotMatch(card, /Nano|Gemini Nano|3 GB|model download|first load/);
  assert.match(fresh.byId('setupOfflineCopy').textContent, /^Groups tabs on this computer from their titles, words from their addresses and a small word table built into Foldnex\. Nothing is sent\.$/);
  assert.doesNotMatch(card, /\u2014/, 'no em dashes');

  await fresh.choice('offline').click();
  await sleep(10);
  assert.deepEqual(fresh.sync, { provider: 'offline', setupChoice: 'offline' });
  assert.equal(fresh.byId('setupCard').classList.contains('hidden'), true);

  // A profile saved on Nano before its setup choice: Offline is the current engine.
  const legacy = await openPopup({ sync: { provider: 'gemini_nano' } });
  assert.equal(legacy.choice('offline').getAttribute('aria-current'), 'true');
  assert.equal(legacy.choice('cloud').getAttribute('aria-current'), null);
  assert.equal(legacy.choice('keep').classList.contains('hidden'), true);
  await sleep(20);
  assert.equal(legacy.sync.provider, 'offline', 'opening the popup moved the saved engine');

  // Keeping Ollama on this device records a local choice.
  const ollama = await openPopup({ sync: { provider: 'ollama' } });
  await ollama.choice('keep').click();
  await sleep(10);
  assert.deepEqual(ollama.sync, { provider: 'ollama', setupChoice: 'offline' });
  for (const popup of [fresh, legacy, ollama]) assert.equal(popup.promptApi(), 0, 'the popup never touches the Prompt API');
});

test('opening the popup migrates legacy Sync credentials without reviving an explicit local clear', async () => {
  const migrated = await openPopup({ sync: { provider: 'offline', groqApiKey: 'synthetic-legacy-key' } });
  assert.equal(Object.hasOwn(migrated.sync, 'groqApiKey'), false);
  assert.equal(migrated.local.groqApiKey, 'synthetic-legacy-key');
  assert.ok(!allText(migrated.root).includes('synthetic-legacy-key'));
  const cleared = await openPopup({ sync: { provider: 'offline', groqApiKey: 'synthetic-old-key' }, local: { groqApiKey: '' } });
  assert.equal(cleared.local.groqApiKey, '');
  assert.equal(Object.hasOwn(cleared.sync, 'groqApiKey'), false);
  await cleared.choice('cloud').click();
  assert.equal(cleared.sync.provider, 'offline');
  assert.deepEqual(cleared.opened, ['chrome-extension://foldnex/options/options.html#engine']);
});

test('saved cloud credentials mean configured without claiming an authenticated connection', async () => {
  const openai = await openPopup({
    sync: { provider: 'openai', setupChoice: 'cloud' },
    local: { openaiApiKey: 'synthetic-unverified-key' }
  });
  assert.equal(openai.byId('engineBadge').textContent, 'OpenAI configured');
  assert.equal(openai.byId('engineBadge').classList.contains('ready'), false);
  assert.match(openai.byId('engineHint').textContent, /Connection not verified/);
  assert.ok(!allText(openai.root).includes('synthetic-unverified-key'));

  const gemini = await openPopup({
    sync: { provider: 'gemini_api', setupChoice: 'cloud' },
    local: { geminiApiKey: 'synthetic-gemini-key' }
  });
  assert.equal(gemini.byId('engineBadge').textContent, 'Gemini configured');
  assert.match(gemini.byId('engineHint').textContent,
    /^Cloud mode sends tab titles \(up to 160 characters\) and host\/path hints to Google Gemini when you group\./);

  const offline = await openPopup({ sync: { provider: 'offline', setupChoice: 'offline' } });
  assert.equal(offline.byId('engineBadge').textContent, 'Local');
  assert.equal(offline.byId('engineBadge').classList.contains('ready'), true);
});

test('matching cloud authentication failure is historical, actionable, and never renders an error body', async () => {
  const popup = await openPopup({
    sync: { provider: 'openai', openaiModel: 'selected-model', setupChoice: 'cloud' },
    local: {
      openaiApiKey: 'synthetic-configured-key',
      foldnex_last_run: {
        provider: 'openai', model: 'selected-model', strategy: 'task', fallbackCode: 'auth',
        fallbackDetail: 'Untrusted response with synthetic-secret', timestamp: Date.now(), groupsCreated: 4
      }
    }
  });
  assert.equal(popup.byId('engineBadge').textContent, 'Last run: auth failed');
  assert.equal(popup.byId('engineBadge').classList.contains('danger'), true);
  assert.match(popup.byId('engineHint').textContent, /Last cleanup ran offline because authentication failed/);
  assert.match(popup.byId('engineHint').textContent, /Check the API key in Settings/);
  assert.ok(!allText(popup.root).includes('synthetic-secret'));

  await chrome.storage.sync.set({ openaiModel: 'another-model' });
  await sleep(20);
  assert.equal(popup.byId('engineBadge').textContent, 'OpenAI configured');
  assert.doesNotMatch(popup.byId('engineHint').textContent, /authentication failed/);
});

test('another provider or site cleanup cannot mark the selected cloud engine as failed', async () => {
  for (const run of [
    { provider: 'gemini_api', model: 'selected-model', strategy: 'task' },
    { provider: 'openai', model: 'selected-model', strategy: 'site' }
  ]) {
    const popup = await openPopup({
      sync: { provider: 'openai', openaiModel: 'selected-model', setupChoice: 'cloud' },
      local: { openaiApiKey: 'synthetic-key', foldnex_last_run: { ...run, fallbackCode: 'auth' } }
    });
    assert.equal(popup.byId('engineBadge').textContent, 'OpenAI configured');
    assert.doesNotMatch(popup.byId('engineHint').textContent, /authentication failed/);
  }
});

test('the badge follows a failed cleanup immediately, including a private result with no saved run', async () => {
  const popup = await openPopup({
    sync: { provider: 'openai', openaiModel: 'selected-model', setupChoice: 'cloud' },
    local: { openaiApiKey: 'synthetic-key' },
    groupingResult: {
      provider: 'openai', model: 'selected-model', strategy: 'task', incognito: true,
      groupsCreated: 4, fallbackUsed: true, fallbackCode: 'auth'
    }
  });
  await popup.byId('btnGroupTabs').click();
  assert.match(popup.byId('statusMessage').textContent, /offline \(API key missing or rejected\)/);
  assert.equal(popup.byId('engineBadge').textContent, 'Last run: auth failed');
  assert.equal(Object.hasOwn(popup.local, 'foldnex_last_run'), false);
});

test('stored cleanup failure changes refresh the badge and remote Ollama copy identifies data transfer', async () => {
  const popup = await openPopup({
    sync: { provider: 'ollama', ollamaModel: 'selected-model', ollamaBaseUrl: 'https://ollama.example.com/v1' }
  });
  assert.equal(popup.byId('engineBadge').textContent, 'Ollama configured');
  assert.doesNotMatch(popup.byId('engineHint').textContent, /on this device/);
  assert.match(popup.byId('engineHint').textContent, /sends tab titles \(up to 160 characters\) and host\/path hints to Ollama/);
  await chrome.storage.local.set({ foldnex_last_run: {
    provider: 'ollama', model: 'selected-model', strategy: 'task', fallbackCode: 'timeout'
  } });
  await sleep(20);
  assert.equal(popup.byId('engineBadge').textContent, 'Last run: timed out');
  assert.match(popup.byId('engineHint').textContent, /Last cleanup ran offline because the provider timed out/);
});

test('a late plan is offered in one strip and applied only on Apply', async () => {
  let offer = { windowId: 41, groups: 3, createdAt: 1 };
  let applyResult = { success: true, groupsCreated: 3 };
  const popup = await openPopup({
    sync: { provider: 'openai', setupChoice: 'cloud' },
    activeWindowId: 41,
    reply: message => {
      if (message.type === 'GET_PLAN_OFFER') return { ok: true, offer };
      if (message.type === 'APPLY_PLAN_OFFER') return { success: true, result: applyResult };
      return undefined;
    }
  });
  const strip = popup.byId('planOffer');
  assert.equal(strip.classList.contains('hidden'), false);
  assert.match(strip.querySelector('.plan-offer-text').textContent, /arrived after the cleanup/);
  assert.ok(!popup.sent.some(message => message.type === 'APPLY_PLAN_OFFER'), 'nothing is applied without Apply');

  await popup.byId('btnApplyPlan').click();
  assert.deepEqual(popup.sent.find(message => message.type === 'APPLY_PLAN_OFFER'), { type: 'APPLY_PLAN_OFFER', windowId: 41 });
  assert.equal(strip.classList.contains('hidden'), true);
  assert.equal(popup.byId('statusMessage').textContent, 'Applied the late grouping: 3 groups.');

  // An offer that arrives while the popup is open; the window then changed.
  offer = null;
  applyResult = { success: false, reason: 'changed' };
  const later = await openPopup({
    sync: { provider: 'openai', setupChoice: 'cloud' },
    activeWindowId: 41,
    reply: message => {
      if (message.type === 'GET_PLAN_OFFER') return { ok: true, offer };
      if (message.type === 'APPLY_PLAN_OFFER') return { success: true, result: applyResult };
      return undefined;
    }
  });
  assert.equal(later.byId('planOffer').classList.contains('hidden'), true);
  offer = { windowId: 41, groups: 2, createdAt: 2 };
  later.deliver({ type: 'PLAN_OFFER_READY', windowId: 99 });
  await sleep(10);
  assert.equal(later.byId('planOffer').classList.contains('hidden'), true, 'another window\'s offer is not shown');
  later.deliver({ type: 'PLAN_OFFER_READY', windowId: 41 });
  await sleep(10);
  assert.equal(later.byId('planOffer').classList.contains('hidden'), false);
  await later.byId('btnApplyPlan').click();
  assert.equal(later.byId('planOffer').classList.contains('hidden'), true);
  assert.match(later.byId('statusMessage').textContent, /window changed, so the late grouping was dropped/);
});

test('a repeat cleanup with a pending offer shows the strip, and a busy worker is an error, not undefined groups', async () => {
  const pending = await openPopup({
    sync: { provider: 'openai', setupChoice: 'cloud' },
    activeWindowId: 42,
    groupingResult: { success: true, groupsCreated: 0, planOffer: true, source: 'plan-offer-pending', provider: 'openai' }
  });
  await pending.byId('btnGroupTabs').click();
  assert.equal(pending.byId('planOffer').classList.contains('hidden'), false);
  assert.match(pending.byId('statusMessage').textContent, /late grouping for this window is waiting/);

  const busy = await openPopup({
    sync: { provider: 'openai', setupChoice: 'cloud' },
    reply: message => (message.type === 'TRIGGER_GROUPING' ? { success: false, error: 'Grouping already in progress' } : undefined)
  });
  await busy.byId('btnGroupTabs').click();
  assert.equal(busy.byId('statusMessage').textContent, 'Grouping already in progress');
  assert.doesNotMatch(busy.byId('statusMessage').textContent, /undefined/);
});

test('finding 9: an announced offer is shown only after the verified lookup confirms it', async () => {
  let offer = null;
  const popup = await openPopup({
    sync: { provider: 'openai', setupChoice: 'cloud' },
    activeWindowId: 43,
    reply: message => (message.type === 'GET_PLAN_OFFER' ? { ok: true, offer } : undefined)
  });
  const lookups = () => popup.sent.filter(message => message.type === 'GET_PLAN_OFFER').length;
  const before = lookups();
  popup.deliver({ type: 'PLAN_OFFER_READY', windowId: 43 });
  await sleep(10);
  assert.equal(lookups(), before + 1, 'the announcement is re-read');
  assert.equal(popup.byId('planOffer').classList.contains('hidden'), true, 'a stale announcement shows nothing');
  offer = { windowId: 43, groups: 2, createdAt: 3 };
  popup.deliver({ type: 'PLAN_OFFER_READY', windowId: 43 });
  await sleep(10);
  assert.equal(popup.byId('planOffer').classList.contains('hidden'), false);
});

test('finding 14: a private window\'s popup reads no offer', async () => {
  const popup = await openPopup({
    sync: { provider: 'openai', setupChoice: 'cloud' },
    activeWindowId: 44,
    incognito: true,
    reply: message => (message.type === 'GET_PLAN_OFFER' ? { ok: true, offer: { windowId: 44, groups: 2, createdAt: 1 } } : undefined)
  });
  popup.deliver({ type: 'PLAN_OFFER_READY', windowId: 44 });
  await sleep(10);
  assert.ok(!popup.sent.some(message => message.type === 'GET_PLAN_OFFER'));
  assert.equal(popup.byId('planOffer').classList.contains('hidden'), true);
});

test('minor 1: a busy refusal keeps the offer strip, and a failed late plan updates the pending status', async () => {
  const busy = await openPopup({
    sync: { provider: 'openai', setupChoice: 'cloud' },
    activeWindowId: 45,
    reply: message => {
      if (message.type === 'GET_PLAN_OFFER') return { ok: true, offer: { windowId: 45, groups: 2, createdAt: 1 } };
      if (message.type === 'TRIGGER_GROUPING') return { success: false, error: 'Grouping already in progress' };
      return undefined;
    }
  });
  assert.equal(busy.byId('planOffer').classList.contains('hidden'), false);
  await busy.byId('btnGroupTabs').click();
  assert.equal(busy.byId('statusMessage').textContent, 'Grouping already in progress');
  assert.equal(busy.byId('planOffer').classList.contains('hidden'), false, 'the strip survives the refusal');

  const pending = await openPopup({
    sync: { provider: 'openai', setupChoice: 'cloud' },
    activeWindowId: 46,
    groupingResult: { success: true, groupsCreated: 2, planPending: true, source: 'plan-pending', provider: 'openai', qualityCodes: [] }
  });
  await pending.byId('btnGroupTabs').click();
  assert.match(pending.byId('statusMessage').textContent, /still answering/);
  pending.deliver({ type: 'PLAN_OFFER_FAILED', windowId: 46 });
  await sleep(10);
  assert.doesNotMatch(pending.byId('statusMessage').textContent, /still answering|will be offered/);
  assert.match(pending.byId('statusMessage').textContent, /local grouping stays/);
});

test('findings 2, 5 and 6: the popup shows the plan effort, unplaced tabs and a Review Later-only answer truthfully', async () => {
  const effort = await openPopup({ sync: { provider: 'openai', openaiReasoningEffort: 'max', setupChoice: 'cloud' } });
  assert.match(effort.byId('modelReasoningSummary').textContent, /Reasoning: None/);

  const review = await openPopup({
    sync: { provider: 'openai', setupChoice: 'cloud' },
    activeWindowId: 47,
    groupingResult: { success: true, groupsCreated: 3, planReviewOnly: true, source: 'local', provider: 'openai', qualityFlags: ['plan_review_only'], qualityCodes: [] }
  });
  await review.byId('btnGroupTabs').click();
  assert.doesNotMatch(review.byId('statusMessage').textContent, /unavailable|offline/i);
  assert.match(review.byId('statusMessage').textContent, /Review Later/);

  const full = await openPopup({
    sync: { provider: 'openai', setupChoice: 'cloud' },
    activeWindowId: 48,
    groupingResult: { success: true, groupsCreated: 10, unplacedTabs: 2, source: 'local', provider: 'openai', qualityCodes: [] }
  });
  await full.byId('btnGroupTabs').click();
  assert.match(full.byId('statusMessage').textContent, /2 tabs left ungrouped/);
});

test('an upkeep cleanup says how many new tabs joined existing groups', async () => {
  const popup = await openPopup({
    sync: { provider: 'openai', setupChoice: 'cloud' },
    activeWindowId: 49,
    groupingResult: { success: true, groupsCreated: 3, source: 'plan-upkeep', upkeepAttached: 2, upkeepReview: 1, provider: 'openai', qualityCodes: [] }
  });
  await popup.byId('btnGroupTabs').click();
  assert.match(popup.byId('statusMessage').textContent, /Added 2 new tabs to existing groups, 1 tab to Review Later; no request sent\./);
});

test('an upkeep line states only what happened, then that no request was sent', async () => {
  const line = async result => {
    const popup = await openPopup({
      sync: { provider: 'openai', setupChoice: 'cloud' },
      activeWindowId: 49,
      groupingResult: { success: true, groupsCreated: 0, source: 'plan-upkeep', provider: 'openai', qualityCodes: [], ...result }
    });
    await popup.byId('btnGroupTabs').click();
    return popup.byId('statusMessage').textContent;
  };
  const review = await line({ upkeepAttached: 0, upkeepReview: 1 });
  assert.match(review, /Added 1 tab to Review Later; no request sent\./);
  assert.doesNotMatch(review, /Added 0/);
  const full = await line({ upkeepAttached: 0, upkeepReview: 0, unplacedTabs: 1 });
  assert.match(full, /1 tab left ungrouped; no request sent\./);
  assert.doesNotMatch(full, /Added 0|rules and Socials/);
  assert.match(await line({ upkeepAttached: 0, upkeepReview: 0 }), /Kept the groups; no request sent\./);
});

test('second review new 6 and minor 1: READY or FAILED before the cleanup response settles from the verified offer', async () => {
  const pendingResult = { success: true, groupsCreated: 2, planPending: true, source: 'plan-pending', provider: 'openai', qualityCodes: [] };
  let ready;
  let offered = false;
  ready = await openPopup({
    sync: { provider: 'openai', setupChoice: 'cloud' },
    activeWindowId: 49,
    reply: async message => {
      if (message.type === 'GET_PLAN_OFFER') return { ok: true, offer: offered ? { windowId: 49, groups: 2, createdAt: 1 } : null };
      if (message.type === 'TRIGGER_GROUPING') {
        offered = true;
        ready.deliver({ type: 'PLAN_OFFER_READY', windowId: 49 });
        await sleep(5);
        return { success: true, result: pendingResult };
      }
      return undefined;
    }
  });
  await ready.byId('btnGroupTabs').click();
  await sleep(10);
  assert.equal(ready.byId('planOffer').classList.contains('hidden'), false, 'the stored offer is shown');
  assert.doesNotMatch(ready.byId('statusMessage').textContent, /still answering/);

  let failed;
  failed = await openPopup({
    sync: { provider: 'openai', setupChoice: 'cloud' },
    activeWindowId: 50,
    reply: async message => {
      if (message.type === 'GET_PLAN_OFFER') return { ok: true, offer: null };
      if (message.type === 'TRIGGER_GROUPING') {
        failed.deliver({ type: 'PLAN_OFFER_FAILED', windowId: 50 });
        return { success: true, result: { ...pendingResult, groupsCreated: 0 } };
      }
      return undefined;
    }
  });
  await failed.byId('btnGroupTabs').click();
  await sleep(10);
  assert.equal(failed.byId('planOffer').classList.contains('hidden'), true);
  assert.doesNotMatch(failed.byId('statusMessage').textContent, /still answering|will be offered/);
});

test('the popup says loopback Ollama is the first hop and a private window sends nothing', async () => {
  const ollama = await openPopup({ sync: { provider: 'ollama' } });
  assert.ok(ollama.byId('engineHint').textContent.startsWith(
    'Sends tab titles and host/path hints to the Ollama server on this device when you group. That server can itself run cloud models.'));
  for (const provider of ['groq', 'ollama']) {
    const hidden = await openPopup({ sync: { provider, groqApiKey: 'synthetic-key' }, activeWindowId: 4, incognito: true });
    assert.equal(hidden.byId('engineHint').textContent, 'Private windows always use Offline smart mode: nothing is sent from them.');
  }
});

test('the popup names only the endpoint a request would use: no legacy override, no refused Ollama address', async () => {
  const groq = await openPopup({ sync: { provider: 'groq', groqApiKey: 'synthetic-key', groqBaseUrl: 'https://legacy-override.example/openai/v1' } });
  assert.doesNotMatch(allText(groq.root), /legacy-override/);
  assert.match(groq.byId('engineHint').textContent, /hints to Groq when you group/);

  const remote = await openPopup({ sync: { provider: 'ollama', ollamaBaseUrl: 'https://ollama.example.com/v1' } });
  assert.match(remote.byId('engineHint').textContent, /to Ollama at ollama\.example\.com when you group/);

  for (const ollamaBaseUrl of [
    'http://192.168.1.20:11434/v1',
    'http://@localhost:11434/v1',
    'https://ollama.example.com/v1?token=synthetic',
    'not a url'
  ]) {
    const refused = await openPopup({ sync: { provider: 'ollama', ollamaBaseUrl } });
    const hint = refused.byId('engineHint').textContent;
    assert.doesNotMatch(hint, /192\.168|ollama\.example|on this device when you group|Sends tab titles|sends tab titles/, ollamaBaseUrl);
    assert.match(hint, /saved Ollama address is not used/i, ollamaBaseUrl);
    assert.match(hint, /runs locally/i, ollamaBaseUrl);
    assert.equal(refused.byId('engineBadge').textContent, 'Local', ollamaBaseUrl);
  }
});

test('Anthropic without its host permission: the popup says access must be allowed in Settings, and selecting it asks Chrome', async () => {
  const asked = [];
  let granted = false;
  const permissions = {
    async contains(query) { asked.push(['contains', query]); return granted; },
    request(query) { asked.push(['request', query]); return Promise.resolve(granted); },
    onAdded: { addListener() {} },
    onRemoved: { addListener() {} }
  };
  const popup = await openPopup({
    sync: { provider: 'anthropic', setupChoice: 'cloud' },
    local: { anthropicApiKey: 'synthetic-anthropic-key' },
    permissions
  });
  assert.equal(popup.byId('engineBadge').textContent, 'Access needed');
  assert.match(popup.byId('engineHint').textContent, /Allow access to api\.anthropic\.com in Settings/);
  assert.ok(asked.some(([kind, query]) => kind === 'contains' && query.origins[0] === 'https://api.anthropic.com/*'));
  assert.ok(!allText(popup.root).includes('synthetic-anthropic-key'));

  granted = true;
  const ready = await openPopup({
    sync: { provider: 'anthropic', setupChoice: 'cloud' },
    local: { anthropicApiKey: 'synthetic-anthropic-key' },
    permissions
  });
  assert.equal(ready.byId('engineBadge').textContent, 'Anthropic · Claude configured');
  assert.match(ready.byId('engineHint').textContent, /to Anthropic · Claude when you group/);

  // A cleanup that fell back because access was not allowed says so.
  const fallback = await openPopup({
    sync: { provider: 'anthropic', setupChoice: 'cloud' },
    local: { anthropicApiKey: 'synthetic-anthropic-key' },
    activeWindowId: 5,
    permissions,
    groupingResult: { success: true, provider: 'anthropic', strategy: 'task', groupsCreated: 3, fallbackUsed: true, fallbackCode: 'permission' }
  });
  await fallback.byId('btnGroupTabs').click();
  await sleep(10);
  assert.match(fallback.byId('statusMessage').textContent, /Created 3 groups offline \(access not allowed; allow it in Settings\)/);

  const select = await openPopup({ sync: { provider: 'offline', setupChoice: 'offline' }, permissions });
  asked.length = 0;
  const providerSelect = select.byId('providerSelect');
  providerSelect.value = 'anthropic';
  await Promise.all((providerSelect.listeners.change || []).map(listener => listener({ target: providerSelect })));
  assert.equal(asked[0][0], 'request', 'the request comes first, on the gesture');
  assert.equal(select.sync.provider, 'anthropic');
});

test('Cloud setup with a saved Anthropic key asks Chrome first, on the click itself; the footer shows the manifest version', async () => {
  const asked = [];
  const permissions = {
    async contains() { return true; },
    request(query) { asked.push(query); return Promise.resolve(true); },
    onAdded: { addListener() {} },
    onRemoved: { addListener() {} }
  };
  const popup = await openPopup({ sync: { provider: 'anthropic' }, local: { anthropicApiKey: 'synthetic-anthropic-key' }, permissions });
  asked.length = 0;
  // Start the click and look before anything is awaited: the request must already be made.
  const pending = popup.choice('cloud').click();
  assert.equal(asked.length, 1, 'permissions.request runs synchronously inside the click');
  assert.equal(asked[0].origins[0], 'https://api.anthropic.com/*');
  await pending;
  await sleep(10);
  assert.equal(popup.sync.provider, 'anthropic');
  assert.equal(popup.sync.setupChoice, 'cloud');
  assert.equal(asked.length, 1, 'asked once');
  const { version } = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.equal(popup.byId('appVersion').textContent, `Foldnex ${version.split('.').slice(0, 2).join('.')}`, 'the static text matches the manifest');
  const optionsHtml = await readFile(new URL('../options/options.html', import.meta.url), 'utf8');
  assert.ok(optionsHtml.includes(`>Foldnex v${version}<`), 'Settings shows the manifest version');
});

test('L1: the setup card takes clicks only after the settings snapshot, and a stale snapshot never asks Chrome after the gesture is gone', async () => {
  const asked = [];
  const permissions = {
    async contains() { return false; },
    request(query) { asked.push(query); return Promise.resolve(true); },
    onAdded: { addListener() {} },
    onRemoved: { addListener() {} }
  };
  const popup = await openPopup({ sync: { provider: 'offline' }, permissions });
  assert.equal(popup.byId('setupCard').classList.contains('hidden'), false);
  for (const name of ['cloud', 'offline']) assert.equal(popup.choice(name).disabled, false, `${name} is active once the snapshot is in`);

  // A key and engine saved elsewhere after the snapshot: the click cannot ask Chrome from a live gesture.
  popup.sync.provider = 'anthropic';
  popup.local.anthropicApiKey = 'synthetic-anthropic-key';
  asked.length = 0;
  await popup.choice('cloud').click();
  await sleep(10);
  assert.equal(asked.length, 0, 'no permissions.request after an await');
  assert.equal(popup.sync.provider, 'anthropic');
  assert.equal(popup.sync.setupChoice, 'cloud');
  assert.ok(popup.opened.some(url => /options\.html#engine/.test(url)), 'Settings opens so the next click can ask');
  assert.match(popup.byId('statusMessage').textContent, /Allow its access in Settings/);
});

test('N3: a stale snapshot that newly resolves to Anthropic does not send the user to Settings when Chrome already granted access', async () => {
  const asked = [];
  const permissions = {
    async contains() { return true; },
    request(query) { asked.push(query); return Promise.resolve(true); },
    onAdded: { addListener() {} },
    onRemoved: { addListener() {} }
  };
  const popup = await openPopup({ sync: { provider: 'offline' }, permissions });
  popup.sync.provider = 'anthropic';
  popup.local.anthropicApiKey = 'synthetic-anthropic-key';
  asked.length = 0;
  await popup.choice('cloud').click();
  await sleep(10);
  assert.equal(asked.length, 0, 'no permissions.request after an await');
  assert.equal(popup.sync.provider, 'anthropic');
  assert.equal(popup.sync.setupChoice, 'cloud');
  assert.equal(popup.opened.some(url => /options\.html#engine/.test(url)), false, 'Settings stays closed');
  assert.match(popup.byId('statusMessage').textContent, /Anthropic · Claude selected with your saved key\.?$/);
  assert.doesNotMatch(popup.byId('statusMessage').textContent, /Allow its access/);
});

test('a refusal or a cut-off answer in the last run gets its own plain explanation', async () => {
  for (const [code, pattern] of [['refusal', /declined this window/], ['max_tokens', /cut off/]]) {
    const popup = await openPopup({
      sync: { provider: 'anthropic', setupChoice: 'cloud' },
      local: {
        anthropicApiKey: 'synthetic-anthropic-key',
        foldnex_last_run: { provider: 'anthropic', strategy: 'task', model: 'claude-opus-5-5', fallbackCode: code }
      },
      permissions: { async contains() { return true; }, onAdded: { addListener() {} }, onRemoved: { addListener() {} } }
    });
    assert.match(popup.byId('engineHint').textContent, pattern, code);
    assert.doesNotMatch(popup.byId('engineHint').textContent, /Check the connection in Settings/, code);
  }
});
