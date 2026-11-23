// Shared stand-ins for the plan click tests: Chrome for one or more windows and an
// OpenAI-compatible provider. Not a test file of its own.

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function waitFor(check, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return true;
    await sleep(10);
  }
  return false;
}

export function makeArea(store, writes) {
  return {
    async get(keys) {
      if (keys === undefined || keys === null) return { ...store };
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter(key => key in store).map(key => [key, store[key]]));
    },
    async set(values) {
      writes?.push(...Object.keys(values));
      Object.assign(store, values);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
    }
  };
}

export const TITLES = ['React hooks reference', 'Rust borrow checker issue', 'Cheap flights to Tokyo', 'Kyoto hotel deals'];

/** Eight tabs, two per title, each on its own site, in strip order. */
export function makeTabs(windowId, startId, { incognito = false, count = 8 } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    id: startId + index,
    windowId,
    index,
    active: index === 0,
    pinned: false,
    incognito,
    status: 'complete',
    groupId: -1,
    title: `${TITLES[index % TITLES.length]} ${index}`,
    url: `https://www.site-${startId + index}.com/page/${index}`
  }));
}

/**
 * Chrome for one window: storage areas that record their writes, tabs and tab
 * groups. With `liveGroups`, tabs.group joins an existing group by groupId,
 * and tabGroups.query lists the groups that still have members, with the
 * titles set on them.
 */
export function installBrowser(tabs, { liveGroups = false } = {}) {
  const local = {};
  const session = {};
  const writes = { local: [], session: [] };
  const calls = { group: [], update: [] };
  const groups = new Map();
  let nextGroupId = 7000;
  globalThis.chrome = {
    storage: {
      local: makeArea(local, writes.local),
      session: makeArea(session, writes.session),
      sync: makeArea({})
    },
    tabs: {
      async query(query = {}) {
        return tabs
          .filter(tab => query.windowId === undefined || tab.windowId === query.windowId)
          .map(tab => ({ ...tab }));
      },
      async get(id) {
        const tab = tabs.find(item => item.id === id);
        if (!tab) throw new Error(`No tab with id: ${id}`);
        return { ...tab };
      },
      async remove() {},
      async group(details) {
        calls.group.push(JSON.parse(JSON.stringify(details)));
        const groupId = liveGroups && Number.isInteger(details.groupId) ? details.groupId : nextGroupId++;
        if (!groups.has(groupId)) groups.set(groupId, { id: groupId, windowId: details.createProperties?.windowId ?? tabs[0]?.windowId, title: '', color: 'grey' });
        for (const id of details.tabIds) {
          const tab = tabs.find(item => item.id === id);
          if (tab) tab.groupId = groupId;
        }
        return groupId;
      },
      async ungroup(ids) {
        for (const id of Array.isArray(ids) ? ids : [ids]) {
          const tab = tabs.find(item => item.id === id);
          if (tab) tab.groupId = -1;
        }
      }
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      async query(query = {}) {
        if (!liveGroups) return [];
        return [...groups.values()]
          .filter(group => query.windowId === undefined || group.windowId === query.windowId)
          .filter(group => tabs.some(tab => tab.groupId === group.id))
          .map(group => ({ ...group }));
      },
      async update(id, details) {
        calls.update.push({ id, ...details });
        if (groups.has(id)) Object.assign(groups.get(id), details);
      }
    }
  };
  return { local, session, writes, calls, groups };
}

/** Folders by title topic: coding rows and travel rows. */
export function topicFolders(rows) {
  const coding = rows.filter(([, title]) => /react|rust/i.test(title)).map(([id]) => id);
  const travel = rows.filter(([, title]) => !/react|rust/i.test(title)).map(([id]) => id);
  return { folders: [{ name: 'Side Project', ids: coding }, { name: 'Japan Holiday', ids: travel }] };
}

/**
 * An OpenAI-compatible provider. Plan requests (the plan system prompt) get
 * answer(rows); `delayMs` holds the answer, `gate` (a promise) holds it until
 * the test releases it; `status` fails it.
 */
export function installProvider({ answer = topicFolders, delayMs = 0, status = 200, raw = null, gate = null } = {}) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    const payload = JSON.parse(options.body);
    const system = payload.messages[0].content;
    const user = payload.messages.at(-1).content;
    const rows = user.includes('{"tabs":') ? JSON.parse(user.slice(user.indexOf('{"tabs":'))).tabs : [];
    const request = { url, payload, system, user, rows, signal: options.signal, aborted: false };
    options.signal?.addEventListener('abort', () => { request.aborted = true; }, { once: true });
    requests.push(request);
    if (delayMs > 0) await sleep(delayMs);
    if (gate) await gate;
    if (status !== 200) {
      return { ok: false, status, statusText: 'Server error', async json() { return { error: { message: 'Upstream failure' } }; } };
    }
    const content = raw ?? JSON.stringify(answer(rows));
    return {
      ok: true,
      async json() {
        return { model: payload.model, choices: [{ message: { content } }], usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 } };
      }
    };
  };
  return { requests, restore() { globalThis.fetch = original; } };
}

export const OPENAI = { provider: 'openai', openaiApiKey: 'test-only', groupingStrategy: 'task' };
export const OLLAMA = { provider: 'ollama', groupingStrategy: 'task' };

export const membership = groups => groups
  .map(group => [...group.tabIds].sort((a, b) => a - b).join(','))
  .sort();
