/**
 * Foldnex - Background classifier
 * The background sends and prepares nothing on any engine: cloud engines and
 * Ollama plan a window in one request on a click, and Offline smart mode
 * groups on this device.
 *
 * Auto-group places new tabs by the local attach (attachNewTab) on every
 * engine, from the tab events the classifier below watches.
 */

import { isLoopbackUrl, PROVIDER_CATALOG, providerSettingKey } from './ai-engine.js';
import { hashToken, WindowPlanStore } from './cache-engine.js';
import { attachTabs } from './local-engine.js';
import { buildLockedGroups, getGroupableTabs, getRunScope, loadGroupingSettings } from './grouper.js';
import { REVIEW_GROUP_NAME } from './planner.js';

export const NEW_TABS_KEY = 'foldnex_new_tabs_v1';
const NO_GROUP = -1;

export { isLoopbackUrl };

/** Ollama on a loopback address: its tab data stays on this device. */
export function isLocalOllama(settings = {}) {
  if (settings?.provider !== 'ollama') return false;
  return isLoopbackUrl(settings[providerSettingKey('ollama', 'baseUrl')] || PROVIDER_CATALOG.ollama.baseUrl);
}

/** Address identity for "a new page": the URL without its fragment, hashed. */
export function pageKey(url) {
  return hashToken(String(url || '').replace(/#.*$/, ''));
}

// ---------------------------------------------------------------------------
// Auto-group by local attach
// ---------------------------------------------------------------------------

/*
 * With Auto-group on, a new tab that has its title joins one of its window's
 * existing tab groups on this device: a manual rule or Socials first (only
 * into the live group already holding that name), otherwise the group whose
 * member titles it is most like (attachTabs, title words only). Nothing
 * reaching the threshold leaves it ungrouped. No group is created, no tab the
 * user placed is moved, no other window is touched, a private window is left
 * alone, and no provider request is sent on any engine.
 */

const lowerName = value => String(value || '').toLocaleLowerCase();

/**
 * Attach one new tab to an existing group in its window.
 * @returns {Promise<{placed: boolean, groupId?: number, reason?: string}>}
 */
export async function attachNewTab(tabId, { settings = null, signal = null } = {}) {
  const resolved = settings || await loadGroupingSettings();
  if (!resolved.autoGroupNewTabs) return { placed: false, reason: 'off' };
  // By site category groups by address on a click; Auto-group stays with By task.
  if (getRunScope(resolved).groupingStrategy !== 'task') return { placed: false, reason: 'site' };

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || tab.incognito || tab.pinned || !String(tab.title || '').trim()) return { placed: false, reason: 'tab' };
  if ((tab.groupId ?? NO_GROUP) !== NO_GROUP) return { placed: false, reason: 'grouped' };
  const windowTabs = getGroupableTabs(await chrome.tabs.query({ windowId: tab.windowId }));
  if (windowTabs.some(item => item.incognito) || !windowTabs.some(item => item.id === tab.id)) return { placed: false, reason: 'tab' };

  const chromeGroups = (await chrome.tabGroups.query({ windowId: tab.windowId }))
    .filter(group => windowTabs.some(item => item.groupId === group.id));
  const { locked } = await buildLockedGroups(windowTabs, { incognito: false });
  const claimOf = id => locked.find(group => (group.tabIds || []).includes(id)) || null;
  const claim = claimOf(tab.id);
  // A live group is a rule's or Socials' group by what its members are, never
  // by its title: every member claimed by the same rule or Socials. Members
  // claimed by different owners, or claimed and unclaimed together, are mixed
  // evidence, and such a group is left alone.
  const membersOf = group => windowTabs.filter(item => item.groupId === group.id).map(item => item.id);
  const ownerOf = group => {
    const claims = new Set(membersOf(group).map(claimOf));
    if (claims.size !== 1) return { mixed: true };
    return { mixed: false, owner: [...claims][0] };
  };
  // Review Later is known by name or by the stored plan's review group.
  const record = await WindowPlanStore.get(tab.windowId).catch(() => null);
  const reviewIds = new Set([...(record?.groups || []), ...(record?.applied?.groups || [])]
    .filter(group => group?.kind === 'review').flatMap(group => group.tabIds || []));
  const isReview = group => lowerName(group.title) === lowerName(REVIEW_GROUP_NAME) || membersOf(group).some(id => reviewIds.has(id));

  let target = null;
  if (claim) {
    // A rule or Socials owns the tab: the one live group holding that
    // owner's tabs, when all its members are the owner's; otherwise nothing.
    const holding = chromeGroups.filter(group => membersOf(group).some(id => claimOf(id) === claim));
    const only = holding.length === 1 ? ownerOf(holding[0]) : { mixed: true };
    target = !only.mixed && only.owner === claim ? holding[0] : null;
  } else {
    const candidates = chromeGroups.filter(group => {
      const { mixed, owner } = ownerOf(group);
      return !mixed && owner === null && !isReview(group);
    });
    const groups = candidates.map(group => ({ tabIds: membersOf(group) }));
    const { placed } = attachTabs(groups, [tab], new Map(windowTabs.map(item => [item.id, item])));
    if (placed.has(tab.id)) target = candidates[placed.get(tab.id)];
  }
  if (!target) return { placed: false, reason: 'no_match' };

  // Recheck everything the decision rested on, immediately before the move:
  // the target group first, then consent, the tab's window, group, pin and
  // page, and the classifier's lifecycle. Nothing is awaited between the last
  // check and the move, so any change before it leaves the tab alone.
  const live = await chrome.tabGroups.query({ windowId: tab.windowId }).catch(() => []);
  if (!live.some(group => group.id === target.id)) return { placed: false, reason: 'moved' };
  const now = await loadGroupingSettings();
  const current = await chrome.tabs.get(tab.id).catch(() => null);
  if (!now.autoGroupNewTabs || getRunScope(now).groupingStrategy !== 'task') return { placed: false, reason: 'off' };
  if (!current || current.windowId !== tab.windowId || current.pinned || current.incognito
    || (current.groupId ?? NO_GROUP) !== NO_GROUP || current.status !== 'complete'
    || current.url !== tab.url || (current.pendingUrl || '') !== (tab.pendingUrl || '') || current.title !== tab.title) {
    return { placed: false, reason: 'moved' };
  }
  if (signal?.aborted) return { placed: false, reason: 'cancelled' };
  await chrome.tabs.group({ groupId: target.id, tabIds: [tab.id] });
  return { placed: true, groupId: target.id };
}

/**
 * Tabs opened or navigated to a new page while Auto-group was on ("fresh"),
 * the subset still waiting to be auto-grouped ("candidates"), and the page
 * key of each tab taken out of a group. Session storage keeps them across
 * service-worker restarts and drops them with the browser session.
 */
export function createNewTabTracker({ area = () => globalThis.chrome?.storage?.session } = {}) {
  let state = null;
  let loading = null;
  let saving = Promise.resolve();

  function ready() {
    if (state) return Promise.resolve(state);
    loading ??= Promise.resolve()
      .then(() => area()?.get(NEW_TABS_KEY))
      .catch(() => null)
      .then(stored => {
        const record = stored?.[NEW_TABS_KEY] || {};
        state = {
          fresh: new Set(Array.isArray(record.fresh) ? record.fresh : []),
          candidates: new Set(Array.isArray(record.candidates) ? record.candidates : []),
          outKeys: new Map(Object.entries(record.out || {}).map(([id, key]) => [Number(id), key]))
        };
        return state;
      });
    return loading;
  }

  function save() {
    const record = {
      fresh: [...state.fresh],
      candidates: [...state.candidates],
      out: Object.fromEntries(state.outKeys)
    };
    saving = saving.then(() => area()?.set({ [NEW_TABS_KEY]: record })).catch(() => {});
    return saving;
  }

  return {
    ready,
    async markNew(tabId, { grouped = false, isCurrent = () => true } = {}) {
      const s = await ready();
      if (!isCurrent()) return;
      s.fresh.add(tabId);
      s.outKeys.delete(tabId);
      if (!grouped) s.candidates.add(tabId);
      else s.candidates.delete(tabId);
      await save();
    },
    async markGrouped(tabIds) {
      const s = await ready();
      let changed = false;
      for (const id of tabIds || []) changed = s.candidates.delete(id) || changed;
      if (changed) await save();
    },
    /** Taken out of a group, or ungrouped by Ungroup all: stays out until a new page. */
    async markTakenOut(entries) {
      const s = await ready();
      for (const [tabId, key] of entries || []) {
        s.candidates.delete(tabId);
        s.outKeys.set(tabId, key);
      }
      await save();
    },
    async forget(tabId) {
      const s = await ready();
      const changed = [s.fresh.delete(tabId), s.candidates.delete(tabId), s.outKeys.delete(tabId)].some(Boolean);
      if (changed) await save();
    },
    async clear() {
      const s = await ready();
      s.fresh.clear();
      s.candidates.clear();
      s.outKeys.clear();
      await save();
    },
    /** Retire old admissions while preserving explicit Ungroup choices. */
    async retireAdmissions() {
      const s = await ready();
      s.fresh.clear();
      s.candidates.clear();
      await save();
    },
    async outKey(tabId) {
      return (await ready()).outKeys.get(tabId);
    },
    async freshIds() {
      return [...(await ready()).fresh];
    },
    async candidateIds() {
      return [...(await ready()).candidates];
    },
    flushed() {
      return saving;
    }
  };
}

/**
 * Watches tab events for Auto-group: which tabs are new (createNewTabTracker)
 * and, once a candidate has loaded with its title, its local attach. Attaches
 * in flight are part of the pause and idle lifecycle, so a cleanup, Ungroup or
 * Apply cancels or waits for them. Nothing else is queued or sent.
 */
export function createBackgroundClassifier({
  tracker = createNewTabTracker(),
  attach = attachNewTab
} = {}) {
  const lastPageKey = new Map();
  let holds = 0;
  // Bumped by every pause: a tab event admitted before it never starts an attach.
  let pauses = 0;
  let configuration = 0;
  let admissionsReady = Promise.resolve();
  // Auto-group attaches in flight, by tab: part of the pause and idle
  // lifecycle, so a cleanup, Ungroup or Apply waits for or cancels them.
  const attaches = new Map();

  const paused = () => holds > 0;

  function cancelAttaches(reason, tabId = null) {
    for (const [id, work] of attaches) if (tabId === null || id === tabId) work.controller.abort(new Error(reason));
  }

  function pause() {
    holds++;
    pauses++;
    cancelAttaches('Paused for cleanup');
  }

  function resume() {
    holds = Math.max(0, holds - 1);
  }

  /** Configuration changes invalidate work immediately without changing holds. */
  function invalidate() {
    configuration++;
    admissionsReady = admissionsReady.then(() => tracker.retireAdmissions());
    // Prevent an unhandled rejection; tab events still await the original
    // barrier and fail closed if admission retirement cannot complete.
    admissionsReady.catch(() => {});
    cancelAttaches('Background settings changed');
  }

  /** Settles once every attach in flight has finished or stopped. */
  function whenIdle() {
    const work = [...attaches.values()].map(item => item.done);
    return work.length > 0 ? Promise.all(work).then(() => {}) : Promise.resolve();
  }

  return {
    async noteTabCreated(tab, { autoGroup = false } = {}) {
      if (!tab || tab.incognito || !Number.isInteger(tab.id)) return;
      const version = configuration;
      await admissionsReady;
      if (version !== configuration) return;
      lastPageKey.set(tab.id, pageKey(tab.pendingUrl || tab.url));
      // A tab Chrome restores without loading is not new.
      if (autoGroup && tab.status !== 'unloaded' && !tab.discarded) {
        await tracker.markNew(tab.id, { grouped: (tab.groupId ?? NO_GROUP) !== NO_GROUP, isCurrent: () => version === configuration });
      }
    },
    async noteTabUpdated(tabId, changeInfo = {}, tab = {}, { autoGroup = false } = {}) {
      if (!Number.isInteger(tabId) || tab?.incognito) return;
      const version = configuration;
      const admitted = pauses;
      await admissionsReady;
      if (version !== configuration) return;
      // A tab placed by hand or navigating away is no longer the tab an
      // attach in flight decided on.
      if (Number.isInteger(changeInfo.groupId) || typeof changeInfo.url === 'string' || changeInfo.status === 'loading') {
        cancelAttaches('Tab changed', tabId);
      }
      if (Number.isInteger(changeInfo.groupId)) {
        if (changeInfo.groupId === NO_GROUP) await tracker.markTakenOut([[tabId, pageKey(tab?.url)]]);
        else await tracker.markGrouped([tabId]);
      }

      if (typeof changeInfo.url === 'string') {
        const key = pageKey(changeInfo.url);
        const known = (await tracker.outKey(tabId)) ?? lastPageKey.get(tabId);
        if (version !== configuration) return;
        lastPageKey.set(tabId, key);
        // A same-document change (fragment, history API, a map rewriting its
        // address as it pans) is never a new page.
        const sameDocument = tab?.status === 'complete' && changeInfo.status !== 'loading';
        if (known !== key && !sameDocument && autoGroup) {
          await tracker.markNew(tabId, { grouped: (tab?.groupId ?? NO_GROUP) !== NO_GROUP, isCurrent: () => version === configuration });
        }
      }

      if (version !== configuration) return;
      // Auto-group: a new tab with its title joins an existing group on this
      // device, on every engine and with no request. Not during a cleanup,
      // which places every tab itself.
      const titled = String(tab?.title || changeInfo.title || '').trim();
      if (autoGroup && !paused() && titled && tab?.status === 'complete' && (changeInfo.status === 'complete' || changeInfo.title)
        && (tab?.groupId ?? NO_GROUP) === NO_GROUP && (await tracker.candidateIds()).includes(tabId)) {
        if (version !== configuration || paused() || admitted !== pauses || attaches.has(tabId)) return;
        const controller = new AbortController();
        const work = { controller, done: null };
        work.done = (async () => {
          try {
            const result = await attach(tabId, { signal: controller.signal });
            if (result?.placed) await tracker.markGrouped([tabId]);
          } catch (error) {
            // The tab may close or move while it is placed.
            console.warn('[Foldnex] Auto-group could not place a tab:', error?.message);
          } finally {
            if (attaches.get(tabId) === work) attaches.delete(tabId);
          }
        })();
        attaches.set(tabId, work);
        await work.done;
      }
    },
    async noteTabRemoved(tabId) {
      lastPageKey.delete(tabId);
      await tracker.forget(tabId);
    },
    /** After Ungroup all: the window's tabs stop being candidates until they open a new page. */
    async noteWindowUngrouped(windowId) {
      if (!Number.isInteger(windowId)) return;
      const tabs = await chrome.tabs.query({ windowId });
      await tracker.markTakenOut(tabs.filter(tab => !tab.incognito).map(tab => [tab.id, pageKey(tab.url)]));
    },
    /** Turning Auto-group off forgets which tabs were new. */
    async setAutoGroup(enabled) {
      if (!enabled) await tracker.clear();
    },
    /**
     * The engine, Auto-group or a credential changed: cancel every attach in
     * flight and retire old admissions. Waits up to `waitMs` for the cancelled
     * attaches to stop.
     */
    async clear({ waitMs = 1000 } = {}) {
      pause();
      invalidate();
      let timer = null;
      try {
        await Promise.race([whenIdle(), new Promise(resolve => { timer = setTimeout(resolve, waitMs); })]);
      } finally {
        clearTimeout(timer);
        resume();
      }
    },
    pause,
    invalidate,
    resume,
    whenIdle
  };
}
