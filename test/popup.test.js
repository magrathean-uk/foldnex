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

/** Load a fresh popup instance over the given storage and Prompt API status. */
async function openPopup({ sync = {}, local = {}, nano = 'available' } = {}) {
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
  globalThis.LanguageModel = { availability: async () => nano };
  const listeners = [];
  const opened = [];
  globalThis.chrome = {
    storage: {
      sync: makeArea(sync, 'sync', listeners),
      local: makeArea(local, 'local', listeners),
      onChanged: { addListener: listener => listeners.push(listener) }
    },
    tabs: {
      async query() { return []; },
      async create(details) { opened.push(details.url); return { id: 99 }; },
      async update(id, details) { opened.push(details.url); return { id }; }
    },
    windows: { async update() {} },
    commands: { async getAll() { return []; } },
    runtime: {
      getURL: path => `chrome-extension://foldnex/${path}`,
      async sendMessage() { return { ok: true }; },
      openOptionsPage() {}
    }
  };
  await import(`../popup.js?instance=${++popupInstance}`);
  await Promise.all((documentListeners.DOMContentLoaded || []).map(listener => listener()));
  await sleep(20);
  const byId = id => globalThis.document.getElementById(id);
  const choice = name => root.querySelectorAll('.setup-choice').find(element => element.dataset.choice === name);
  return { root, byId, choice, sync, local, opened };
}

function allText(root) {
  return root.descendants().map(element => `${element.textContent} ${element.value}`).join(' ');
}

test('the setup card marks the saved engine Current and says where Ollama runs', async () => {
  const loopback = await openPopup({ sync: { provider: 'ollama' } });
  assert.equal(loopback.byId('setupCard').classList.contains('hidden'), false);
  assert.equal(loopback.choice('keep').classList.contains('hidden'), false);
  for (const name of ['cloud', 'nano', 'offline']) {
    assert.equal(loopback.choice(name).getAttribute('aria-current'), null, name);
  }
  assert.equal(loopback.byId('setupKeepCopy').textContent, 'Runs through the Ollama server on this device.');

  // Ollama at another address is not on this device, and the card says so.
  const remote = await openPopup({ sync: { provider: 'ollama', ollamaBaseUrl: 'http://192.168.1.20:11434/v1' } });
  assert.equal(remote.choice('keep').classList.contains('hidden'), false);
  assert.doesNotMatch(remote.byId('setupKeepCopy').textContent, /on this device/);
  assert.match(remote.byId('setupKeepCopy').textContent, /another address/);

  const cloud = await openPopup({ sync: { provider: 'groq' } });
  assert.equal(cloud.choice('cloud').getAttribute('aria-current'), 'true');
  assert.equal(cloud.choice('cloud').querySelector('.setup-pill.current').classList.contains('hidden'), false);
  assert.equal(cloud.choice('keep').classList.contains('hidden'), true);

  const answered = await openPopup({ sync: { provider: 'gemini_nano', setupChoice: 'nano' } });
  assert.equal(answered.byId('setupCard').classList.contains('hidden'), true);
});

test('Cloud setup without a saved key keeps the engine and opens Settings; with one it never shows the key', async () => {
  const popup = await openPopup({ sync: { provider: 'gemini_nano' } });
  await popup.choice('cloud').click();
  await sleep(10);
  assert.equal(popup.sync.setupChoice, 'cloud');
  assert.equal(popup.sync.provider, 'gemini_nano');
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

test('an unavailable Gemini Nano choice is disabled with its reason and saves nothing', async () => {
  const popup = await openPopup({ sync: { provider: 'offline' }, nano: 'unavailable' });
  const nano = popup.choice('nano');
  assert.equal(nano.getAttribute('aria-disabled'), 'true');
  assert.equal(popup.byId('setupNanoStatus').classList.contains('hidden'), false);
  assert.match(popup.byId('setupNanoStatus').textContent, /^Not available: .+\.$/);
  await nano.click();
  await sleep(10);
  assert.deepEqual(popup.sync, { provider: 'offline' });
  assert.equal(popup.byId('setupCard').classList.contains('hidden'), false);

  // Available: the choice selects Nano and turns on background preparation.
  const ready = await openPopup({ sync: { provider: 'offline' } });
  await ready.choice('nano').click();
  await sleep(10);
  assert.deepEqual(ready.sync, { provider: 'gemini_nano', backgroundPrep: true, setupChoice: 'nano' });
});
