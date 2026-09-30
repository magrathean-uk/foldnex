/**
 * Shared transient state for Chrome tab-group mutations.
 *
 * Manifest V3 extension pages and the background service worker do not share
 * module memory. chrome.storage.session gives both contexts one short-lived
 * source of truth for ordinary windows. Private group titles and their update
 * bookkeeping stay only in this module's memory in each extension context.
 */

const EXPECTED_UPDATE_PREFIX = 'foldnex_expected_group_update_';
const GROUP_BASELINE_PREFIX = 'foldnex_group_title_baseline_';
const EXPECTED_UPDATE_TTL_MS = 60_000;
const privateGroupIds = new Set();
const privateBaselines = new Map();
const privateExpectedUpdates = new Map();

function expectedKey(groupId) {
  return `${EXPECTED_UPDATE_PREFIX}${groupId}`;
}

function baselineKey(groupId) {
  return `${GROUP_BASELINE_PREFIX}${groupId}`;
}

async function usePrivateState(groupId, options) {
  if (options?.incognito !== true && !privateGroupIds.has(groupId)) return false;
  if (!privateGroupIds.has(groupId)) {
    privateGroupIds.add(groupId);
    // Remove bookkeeping an older version may have stored for this private
    // group. No private title or record is sent to any storage area.
    await chrome.storage?.session?.remove([expectedKey(groupId), baselineKey(groupId)]);
  }
  return true;
}

export async function markProgrammaticGroupUpdate(groupId, title, options) {
  if (await usePrivateState(groupId, options)) {
    privateExpectedUpdates.set(groupId, { title, expiresAt: Date.now() + EXPECTED_UPDATE_TTL_MS });
    privateBaselines.set(groupId, title);
    return;
  }
  await chrome.storage.session.set({
    [expectedKey(groupId)]: { title, expiresAt: Date.now() + EXPECTED_UPDATE_TTL_MS },
    [baselineKey(groupId)]: title
  });
}

export async function consumeProgrammaticGroupUpdate(group, options) {
  if (await usePrivateState(group.id, { incognito: options?.incognito || group.incognito })) {
    const expected = privateExpectedUpdates.get(group.id);
    privateExpectedUpdates.delete(group.id);
    return Boolean(expected && expected.expiresAt > Date.now() && expected.title === group.title);
  }
  const key = expectedKey(group.id);
  const data = await chrome.storage.session.get(key);
  const expected = data[key];
  const match = Boolean(
    expected && Number(expected.expiresAt) > Date.now() && expected.title === group.title
  );
  if (expected) await chrome.storage.session.remove(key);
  return match;
}

export async function getGroupTitleBaseline(groupId, options) {
  if (await usePrivateState(groupId, options)) return privateBaselines.get(groupId);
  const key = baselineKey(groupId);
  const data = await chrome.storage.session.get(key);
  return data[key];
}

export async function setGroupTitleBaseline(groupId, title, options) {
  if (await usePrivateState(groupId, options)) {
    privateBaselines.set(groupId, title);
    return;
  }
  await chrome.storage.session.set({ [baselineKey(groupId)]: title });
}

async function groupIsPrivate(group, windowLookups) {
  if (group.incognito === true) return true;
  if (typeof chrome.windows?.get === 'function' && Number.isInteger(group.windowId)) {
    if (!windowLookups.has(group.windowId)) {
      windowLookups.set(group.windowId, Promise.resolve()
        .then(() => chrome.windows.get(group.windowId)).catch(() => null));
    }
    const window = await windowLookups.get(group.windowId);
    if (typeof window?.incognito === 'boolean') return window.incognito;
  }
  // TabGroup has no incognito field in Chrome. Accept it in older callers or
  // mocks, and otherwise resolve privacy from the member tabs when possible.
  if (typeof group.incognito === 'boolean') return group.incognito;
  if (typeof chrome.tabs?.query === 'function') {
    try {
      const tabs = await chrome.tabs.query({ groupId: group.id });
      if (Array.isArray(tabs) && tabs.length > 0) return tabs.some(tab => tab.incognito);
    } catch {
      // A closed window or inaccessible group cannot establish public state.
    }
  }
  // Avoid storing a title whose window privacy could not be established.
  return true;
}

export async function seedGroupTitleBaselines(groups) {
  const baselines = new Map();
  const windowLookups = new Map();
  for (const group of Array.isArray(groups) ? groups : []) {
    if (!group || !Number.isInteger(group.id) || group.id < 0) continue;
    const incognito = await groupIsPrivate(group, windowLookups);
    if (await usePrivateState(group.id, { incognito })) {
      if (group.title) privateBaselines.set(group.id, group.title);
    } else if (group.title) {
      baselines.set(group.id, group.title);
    }
  }
  const shared = Object.fromEntries([...baselines]
    .filter(([groupId]) => !privateGroupIds.has(groupId))
    .map(([groupId, title]) => [baselineKey(groupId), title]));
  if (Object.keys(shared).length > 0) await chrome.storage.session.set(shared);
}

export async function removeGroupState(groupId) {
  privateGroupIds.delete(groupId);
  privateBaselines.delete(groupId);
  privateExpectedUpdates.delete(groupId);
  await chrome.storage.session.remove([expectedKey(groupId), baselineKey(groupId)]);
}

export const GROUP_STATE_KEYS = Object.freeze({
  EXPECTED_UPDATE_PREFIX,
  GROUP_BASELINE_PREFIX
});
