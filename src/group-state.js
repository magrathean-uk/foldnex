/**
 * Shared transient state for Chrome tab-group mutations.
 *
 * Manifest V3 extension pages and the background service worker do not share
 * module memory. chrome.storage.session gives both contexts one short-lived
 * source of truth without persisting browsing data to disk.
 */

const EXPECTED_UPDATE_PREFIX = 'foldnex_expected_group_update_';
const GROUP_BASELINE_PREFIX = 'foldnex_group_title_baseline_';
const EXPECTED_UPDATE_TTL_MS = 60_000;

function expectedKey(groupId) {
  return `${EXPECTED_UPDATE_PREFIX}${groupId}`;
}

function baselineKey(groupId) {
  return `${GROUP_BASELINE_PREFIX}${groupId}`;
}

export async function markProgrammaticGroupUpdate(groupId, title) {
  await chrome.storage.session.set({
    [expectedKey(groupId)]: { title, expiresAt: Date.now() + EXPECTED_UPDATE_TTL_MS },
    [baselineKey(groupId)]: title
  });
}

export async function consumeProgrammaticGroupUpdate(group) {
  const key = expectedKey(group.id);
  const data = await chrome.storage.session.get(key);
  const expected = data[key];
  const match = Boolean(
    expected && Number(expected.expiresAt) > Date.now() && expected.title === group.title
  );
  if (expected) await chrome.storage.session.remove(key);
  return match;
}

export async function getGroupTitleBaseline(groupId) {
  const key = baselineKey(groupId);
  const data = await chrome.storage.session.get(key);
  return data[key];
}

export async function setGroupTitleBaseline(groupId, title) {
  await chrome.storage.session.set({ [baselineKey(groupId)]: title });
}

export async function seedGroupTitleBaselines(groups) {
  const baselines = {};
  for (const group of groups || []) {
    if (group?.title) baselines[baselineKey(group.id)] = group.title;
  }
  if (Object.keys(baselines).length > 0) await chrome.storage.session.set(baselines);
}

export async function removeGroupState(groupId) {
  await chrome.storage.session.remove([expectedKey(groupId), baselineKey(groupId)]);
}

export const GROUP_STATE_KEYS = Object.freeze({
  EXPECTED_UPDATE_PREFIX,
  GROUP_BASELINE_PREFIX
});
