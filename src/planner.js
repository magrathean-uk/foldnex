/**
 * Foldnex - Deterministic group planner
 *
 * The shared local rules for groups: title tokens, the category a tab's
 * site or title implies, group names and their validation, names carried
 * over from memory, the group ceiling and the validator of a model plan
 * (enforcePlan). Every tie is broken by a stable key, so the same window
 * always gives the same result whatever order its tabs arrive in.
 *
 * Pure module: no chrome.* calls, no storage and no clock.
 */

import {
  findRegionalLabelIssues,
  getMaxGroupSize,
  groupCeiling,
  isGenericGroupName,
  MAX_GROUPS
} from './ai-engine.js';
import { extractPatternKey, hashToken, normalizeUserGroupName, sanitizeTitle } from './cache-engine.js';
import { describeSite, siteKeyForUrl } from './site-clusterer.js';
import {
  CATEGORY_BY_KEY,
  CATEGORY_KEYS,
  DECORATIVE_NAME_WORDS,
  DEMONYMS,
  GENERIC_TOPIC_TOKENS,
  GROUP_NAME_LIMIT,
  LABEL_CATEGORIES,
  REVIEW_GROUP_NAME,
  STOP_WORDS,
  TITLE_LEXICON,
  VAGUE_NAME_WORDS,
  categoryAffinity
} from './label-vocabulary.js';

export { GROUP_NAME_LIMIT, REVIEW_GROUP_NAME };

const REVIEW_KEY = 'review';
const TOKEN_HASH_LIMIT = 8;
const USER_FINGERPRINT_OVERLAP = 0.5;
const MODEL_KEY_JACCARD = 0.5;
const MODEL_TOKEN_JACCARD = 0.25;

const CODE_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org']);
const GOVERNMENT_HOST = /(^|\.)(gov|gouv|gob|govt)(\.|$)/;
const BARE_DOMAIN = /\.(com|org|net|io|ai|dev|co|app)\b/i;
const CJK_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CHROME_COLORS = new Set(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']);
const SHORT_BY_NAME = new Map(LABEL_CATEGORIES.map(category => [category.name, category.short]));
const CATEGORY_RELATIONS = new Map(CATEGORY_KEYS.map(a => [a,
  new Map(CATEGORY_KEYS.map(b => [b, categoryAffinity(a, b)]))]));

// describeSite category names mapped to label keys. Search & Maps and
// Reading & News depend on the service and are handled in categoryFromSite.
const SITE_CATEGORY_BY_NAME = new Map([
  ['YouTube', 'video'], ['Video Production', 'video'], ['Entertainment', 'video'],
  ['Envato', 'design'], ['Creative Assets', 'design'], ['Design', 'design'],
  ['Tesla', 'cars'],
  ['AI · Assistants', 'ai'], ['AI · Platforms', 'ai'],
  ['Email', 'mail'],
  ['Code & Repositories', 'dev'], ['Apple Developer', 'dev'], ['Local Development', 'dev'],
  ['Cloud & Hosting', 'infra'], ['Network & Devices', 'infra'],
  ['Google Business', 'biz'],
  ['Work Projects', 'office'],
  ['Careers', 'jobs'],
  ['Fashion Shopping', 'shop'], ['Marketplaces', 'shop'],
  ['Travel', 'travel'],
  ['Property', 'home'],
  ['Finance & Payments', 'money'],
  ['Events', 'events'],
  ['Life Admin', 'admin'],
  ['Communities & Forums', 'read']
]);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function tabUrl(tab) {
  return String(tab?.url || tab?.pendingUrl || '');
}

function compareStrings(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Compare two sort keys element by element (numbers and strings). */
function compareKeys(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

function lower(value) {
  return String(value ?? '').trim().toLocaleLowerCase();
}

function codePointLength(value) {
  return [...value].length;
}

function clampName(name, limit = GROUP_NAME_LIMIT) {
  const chars = [...String(name || '').trim()];
  return chars.length <= limit ? chars.join('') : chars.slice(0, limit).join('').trim();
}

function titleCaseWord(word) {
  if (!word) return word;
  const isLowerCase = word === word.toLocaleLowerCase() && word !== word.toLocaleUpperCase();
  if (!isLowerCase) return word;
  const [first, ...rest] = [...word];
  return first.toLocaleUpperCase() + rest.join('');
}

/** The category key in a label value: a bare key, or {c} from caches and inference. */
function labelKey(value) {
  const raw = typeof value === 'string' ? value : value?.c;
  return typeof raw === 'string' && CATEGORY_BY_KEY.has(raw) ? raw : null;
}

/** Most frequent key in a count map; ties go by vocabulary order. */
function topCategory(counts) {
  let best = null;
  let bestCount = 0;
  for (const key of CATEGORY_KEYS) {
    const count = counts.get(key) || 0;
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

export function isLockedGroup(group) {
  return group?.locked === true || group?.kind === 'rule' || group?.kind === 'social';
}

function isReviewGroup(group) {
  return group?.kind === 'review' || lower(group?.name) === lower(REVIEW_GROUP_NAME);
}

function groupSize(group) {
  if (Array.isArray(group?.tabIds)) return group.tabIds.length;
  if (Array.isArray(group?.entries)) return group.entries.length;
  return Number(group?.size) || 0;
}

/** Keep every constituent label: a dominant label must not erase a minority. */
function categoriesOf(group) {
  if (isReviewGroup(group)) return [];
  if (Array.isArray(group?.categories)) return group.categories.filter(key => CATEGORY_BY_KEY.has(key));
  const keys = new Set();
  if (Array.isArray(group?.entries)) {
    for (const entry of group.entries) if (CATEGORY_BY_KEY.has(entry.label)) keys.add(entry.label);
  } else {
    for (const key of group?.keys || []) {
      const category = String(key).startsWith('cat:') ? String(key).slice(4) : null;
      if (CATEGORY_BY_KEY.has(category)) keys.add(category);
    }
  }
  if (keys.size === 0 && CATEGORY_BY_KEY.has(group?.dominant)) keys.add(group.dominant);
  return CATEGORY_KEYS.filter(key => keys.has(key));
}

/** Every category on either side must relate to every category on the other. */
function compatibleGroups(a, b, minimum = 1) {
  const left = a?.categories || categoriesOf(a);
  const right = b?.categories || categoriesOf(b);
  return left.length > 0 && right.length > 0
    && left.every(x => right.every(y => (CATEGORY_RELATIONS.get(x)?.get(y) || 0) >= minimum));
}

function combinedCategories(a, b) {
  const keys = new Set([...categoriesOf(a), ...categoriesOf(b)]);
  return CATEGORY_KEYS.filter(key => keys.has(key));
}

function nameForMerge(a, b) {
  const categories = combinedCategories(a, b);
  if (categories.length > 1) {
    const name = categories.map(key => CATEGORY_BY_KEY.get(key).short).join(' & ');
    if (name.length <= GROUP_NAME_LIMIT) return name;
  }
  return mergedName(a, b);
}

function lookupTab(tabsById, id) {
  if (!tabsById) return null;
  if (tabsById instanceof Map) return tabsById.get(id) ?? tabsById.get(Number(id)) ?? null;
  return tabsById[id] ?? null;
}

// ---------------------------------------------------------------------------
// Title tokens
// ---------------------------------------------------------------------------

let wordSegmenter;

function segmentWords(text) {
  if (wordSegmenter === undefined) {
    try {
      wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
    } catch {
      wordSegmenter = null;
    }
  }
  if (!wordSegmenter) return text.match(/[\p{L}\p{N}]+/gu) || [];
  const words = [];
  for (const part of wordSegmenter.segment(text)) {
    if (part.isWordLike) words.push(part.segment);
  }
  return words;
}

function isNoiseToken(token, siteKey) {
  if (!token) return true;
  // Numbers and versions ('2026', '18.1', '1,299', 'v2.0.1') name no topic.
  if (!/\p{L}/u.test(token.replace(/^v(?=\p{N})/u, ''))) return true;
  const length = codePointLength(token);
  // CJK words carry a whole concept in two characters; Latin needs three.
  if (CJK_SCRIPT.test(token) ? length < 2 : length < 3) return true;
  return STOP_WORDS.has(token)
    || GENERIC_TOPIC_TOKENS.has(token)
    || TITLE_LEXICON.has(token)
    || token === siteKey;
}

/**
 * Normalise one lower-case word: strip a plain plural, then fold demonyms so
 * 'Japanese recipes' and 'Japan trip' share the token 'japan'.
 */
function normalizeWord(word) {
  let token = word;
  let plural = false;
  if (codePointLength(token) > 4 && token.endsWith('s') && !token.endsWith('ss')) {
    token = token.slice(0, -1);
    plural = true;
  }
  const demonym = DEMONYMS.get(token);
  return { token: demonym || token, surfaceKept: !demonym, plural };
}

function addSurface(surfaces, token, surface) {
  const forms = surfaces.get(token) || new Map();
  forms.set(surface, (forms.get(surface) || 0) + 1);
  surfaces.set(token, forms);
}

/**
 * Tokens plus their original spellings, for task and split names.
 * siteMention is true when the title names the tab's own site ('Tesla' on
 * tesla.com); the token itself is still dropped from the topic set.
 */
function tokenizeTab(tab) {
  const tokens = new Set();
  const surfaces = new Map();
  const url = tabUrl(tab);
  const siteKey = siteKeyForUrl(url);
  let siteMention = false;

  for (const word of segmentWords(sanitizeTitle(tab?.title))) {
    const lowerWord = word.toLocaleLowerCase();
    const { token, surfaceKept } = normalizeWord(lowerWord);
    if (siteKey && (lowerWord === siteKey || token === siteKey)) {
      siteMention = true;
      addSurface(surfaces, siteKey, word);
      continue;
    }
    if (isNoiseToken(lowerWord, siteKey) || isNoiseToken(token, siteKey)) continue;
    tokens.add(token);
    if (surfaceKept) addSurface(surfaces, token, word);
  }

  // A repository name is the clearest topic a code host offers.
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    if (CODE_HOSTS.has(host)) {
      const repo = extractPatternKey(url).split('/')[2];
      const token = repo && repo !== '*' ? repo.toLocaleLowerCase() : '';
      if (token && !isNoiseToken(token, siteKey)) {
        tokens.add(token);
        addSurface(surfaces, token, repo);
      }
    }
  } catch {
    // No URL, no repo token.
  }

  return { tokens, surfaces, siteKey, siteMention };
}

/**
 * Normalised topic tokens of a tab title: sanitised, word-segmented, without
 * numbers or version strings, short words, stop words, generic topics, lexicon
 * words or the tab's own site name. Plurals are stripped and demonyms folded.
 */
export function titleTokens(tab) {
  return tokenizeTab(tab).tokens;
}

/** titleTokens plus the original spellings of each token, for local names. */
export function titleTokenDetails(tab) {
  const { tokens, surfaces } = tokenizeTab(tab);
  return { tokens, surfaces };
}

// ---------------------------------------------------------------------------
// Category from site and title
// ---------------------------------------------------------------------------

/** Category key implied by a known site, or null when the site says nothing. */
export function categoryFromSite(url) {
  const raw = String(url || '');
  if (!raw) return null;
  const site = describeSite(raw);
  if (site.known) {
    if (site.name === 'Search & Maps') return site.serviceName === 'Maps' ? 'travel' : null;
    if (site.name === 'Reading & News') {
      if (site.serviceName === 'Wikipedia') return 'learn';
      if (site.serviceName === 'Medium' || site.serviceName === 'Internet Archive') return 'read';
      return 'news';
    }
    return SITE_CATEGORY_BY_NAME.get(site.name) || null;
  }
  try {
    return GOVERNMENT_HOST.test(new URL(raw).hostname.toLowerCase()) ? 'admin' : null;
  } catch {
    return null;
  }
}

/** Category with the most TITLE_LEXICON hits in a title; ties by vocabulary order. */
export function categoryFromTitle(title) {
  const text = sanitizeTitle(title);
  if (!text) return null;
  const hits = new Map();
  for (const word of segmentWords(text)) {
    const key = TITLE_LEXICON.get(word.toLocaleLowerCase());
    if (key) hits.set(key, (hits.get(key) || 0) + 1);
  }
  return topCategory(hits);
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/** Short form for 'A & B' names: a category's short, else the first part of an '&' name. */
export function shortOf(name) {
  const value = String(name || '');
  if (SHORT_BY_NAME.has(value)) return SHORT_BY_NAME.get(value);
  if (value.includes(' & ')) return value.split(' & ')[0];
  return value;
}

/**
 * Name for t after it absorbs s. Distinct subjects remain visible even when
 * one side has more tabs. Existing mixed names retain all of their parts.
 */
export function mergedName(t, s) {
  const a = { name: String(t?.name || ''), size: groupSize(t) };
  const b = { name: String(s?.name || ''), size: groupSize(s) };
  const [big, small] = a.size >= b.size ? [a, b] : [b, a];
  if (!small.name || big.name === small.name) return big.name || small.name;
  const partsOf = name => SHORT_BY_NAME.has(name)
    ? [SHORT_BY_NAME.get(name)]
    : name.split(' & ').map(part => part.trim()).filter(Boolean);
  const parts = [...new Set([...partsOf(big.name), ...partsOf(small.name)])];
  const combined = parts.join(' & ');
  if (combined.length <= GROUP_NAME_LIMIT) return combined;
  if (parts.length > 8) return REVIEW_GROUP_NAME;
  // Keep both subjects visible when their custom names cannot fit together.
  const budget = Math.max(1, Math.floor((GROUP_NAME_LIMIT - 3 * (parts.length - 1)) / parts.length));
  return parts.map(part => clampName(part, budget)).join(' & ');
}

export function surfaceName(token, entries) {
  const counts = new Map();
  for (const entry of entries) {
    for (const [surface, count] of entry.surfaces.get(token) || []) {
      counts.set(surface, (counts.get(surface) || 0) + count);
    }
  }
  let best = null;
  let bestCount = 0;
  for (const [surface, count] of counts) {
    if (count > bestCount || (count === bestCount && compareStrings(surface, best) < 0)) {
      best = surface;
      bestCount = count;
    }
  }
  return clampName(titleCaseWord(best || token));
}

function isUsableDeterministicName(name) {
  return Boolean(name) && !isGenericGroupName(name) && lower(name) !== lower(REVIEW_GROUP_NAME);
}

/**
 * Top token hashes of a group, most frequent first (ties alphabetical). Stored
 * in PlanMemory instead of words, so no title text is persisted.
 */
export function groupTokenHashes(group, tokensById) {
  const counts = new Map();
  for (const id of group?.tabIds || []) {
    const tokens = tokensById instanceof Map ? tokensById.get(id) : tokensById?.[id];
    for (const token of tokens || []) counts.set(token, (counts.get(token) || 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || compareStrings(a[0], b[0]))
    .slice(0, TOKEN_HASH_LIMIT)
    .map(([token]) => hashToken(token));
}

/**
 * Clean a model or memory name, or return null when it must not be used:
 * NFKC, only letters, digits, space and & ' · -, 2-30 characters, at most 4
 * words, not generic, not vague or decorative, not a bare domain, not Review
 * Later, no contradiction with a member's country domain, and not already
 * taken in the window.
 */
function isVagueName(words) {
  const keys = words.map(word => lower(word).replace(/^[&'·-]+|[&'·-]+$/g, '')).filter(Boolean);
  if (keys.some(key => DECORATIVE_NAME_WORDS.has(key))) return true;
  return keys.every(key => VAGUE_NAME_WORDS.has(key));
}

// A raw name longer than this is rejected before any normalising.
export const RAW_GROUP_NAME_LIMIT = 200;
const NAME_EDGE = /[\s&'·-]/;

/** Trim spaces and joiners from both ends in one pass each (no regex backtracking). */
function trimNameEdges(text) {
  let start = 0;
  let end = text.length;
  while (start < end && NAME_EDGE.test(text[start])) start++;
  while (end > start && NAME_EDGE.test(text[end - 1])) end--;
  return text.slice(start, end);
}

export function validateGroupName(raw, group = null, tabsById = null, takenNames = []) {
  if (typeof raw !== 'string' || raw.length > RAW_GROUP_NAME_LIMIT) return null;
  const normalized = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
  // Checked before stripping, which would remove the dot.
  if (BARE_DOMAIN.test(normalized)) return null;
  const name = trimNameEdges(normalized
    .replace(/[^\p{L}\p{M}\p{N} &'·-]+/gu, '')
    // Marks are kept for scripts that need them, but not orphaned ones such as
    // an emoji's variation selector left behind after the emoji is stripped.
    .replace(/(^|[^\p{L}\p{M}\p{N}])\p{M}+/gu, '$1')
    .replace(/\s+/g, ' '));
  const length = codePointLength(name);
  if (length < 2 || length > GROUP_NAME_LIMIT) return null;
  const words = name.split(' ').filter(word => /[\p{L}\p{N}]/u.test(word));
  if (words.length === 0 || words.length > 4) return null;
  if (!isUsableDeterministicName(name)) return null;
  if (isVagueName(words)) return null;

  const namedCategory = LABEL_CATEGORIES.find(category =>
    lower(category.name) === lower(name) || lower(category.short) === lower(name));
  if (namedCategory && group?.kind !== 'task') {
    const categories = categoriesOf(group);
    if (categories.some(key => key !== namedCategory.key)) return null;
  }

  if (group && tabsById) {
    const tabs = (group.tabIds || []).map(id => lookupTab(tabsById, id)).filter(Boolean);
    if (findRegionalLabelIssues([{ name, tabIds: group.tabIds || [] }], tabs).length > 0) return null;
  }

  const taken = new Set([...(takenNames || [])].map(lower));
  if (taken.has(lower(name))) return null;
  return name;
}

function dominantSiteName(group, tabsById) {
  const counts = new Map();
  for (const id of group.tabIds || []) {
    const tab = lookupTab(tabsById, id);
    if (!tab || !siteKeyForUrl(tabUrl(tab))) continue;
    const { siteName } = describeSite(tabUrl(tab));
    if (siteName && !isGenericGroupName(siteName)) counts.set(siteName, (counts.get(siteName) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount || (count === bestCount && compareStrings(name, best) < 0)) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}

function numberedName(name, taken) {
  for (let index = 2; ; index++) {
    const suffix = ` ${index}`;
    const candidate = `${clampName(name, GROUP_NAME_LIMIT - suffix.length)}${suffix}`;
    if (!taken.has(lower(candidate))) return candidate;
  }
}

/**
 * Make names unique. An unlocked group named like a locked group merges into
 * it (as explicit rules always have), unless joinLocked is false: then it is
 * renamed like any other duplicate. Otherwise the smaller duplicate becomes
 * 'Name · Site' when that fits in 30 characters, else 'Name 2'.
 * `locked` may list locked groups or names for input that lost its flags.
 */
export function ensureUniqueNames(groups, locked = [], { tabsById = null, joinLocked = true } = {}) {
  const out = (groups || []).map(group => ({ ...group, tabIds: [...(group.tabIds || [])] }));
  const lockedKeys = new Set();
  const lockedNames = new Set();
  for (const entry of locked || []) {
    if (typeof entry === 'string') lockedNames.add(lower(entry));
    else if (entry?.key) lockedKeys.add(entry.key);
    else if (entry?.name) lockedNames.add(lower(entry.name));
  }

  const lockedSet = new Set();
  const lockedByName = new Map();
  for (const group of out) {
    const nameKey = lower(group.name);
    const isLocked = isLockedGroup(group)
      || (group.key && lockedKeys.has(group.key))
      || (lockedNames.has(nameKey) && !lockedByName.has(nameKey));
    if (!isLocked) continue;
    lockedSet.add(group);
    if (!lockedByName.has(nameKey)) lockedByName.set(nameKey, group);
  }

  const kept = [];
  for (const group of out) {
    if (!lockedSet.has(group)) {
      const target = joinLocked ? lockedByName.get(lower(group.name)) : null;
      if (target) {
        target.tabIds.push(...group.tabIds);
        if (Array.isArray(target.keys) && Array.isArray(group.keys)) {
          target.keys = [...new Set([...target.keys, ...group.keys])].sort();
        }
        continue;
      }
    }
    kept.push(group);
  }

  const taken = new Set([...lockedNames, ...[...lockedSet].map(group => lower(group.name))]);
  const unlocked = kept
    .filter(group => !lockedSet.has(group))
    .sort((a, b) => groupSize(b) - groupSize(a) || compareStrings(String(a.key || a.name), String(b.key || b.name)));
  for (const group of unlocked) {
    const nameKey = lower(group.name);
    if (!taken.has(nameKey)) {
      taken.add(nameKey);
      continue;
    }
    const site = tabsById ? dominantSiteName(group, tabsById) : null;
    const withSite = site ? `${group.name} · ${site}` : '';
    group.name = withSite && withSite.length <= GROUP_NAME_LIMIT && !taken.has(lower(withSite))
      ? withSite
      : numberedName(group.name, taken);
    taken.add(lower(group.name));
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Plan identity
// ---------------------------------------------------------------------------

/** Plan identity: every group's sorted keys, sorted and joined. */
export function planSignature(groups) {
  return (groups || [])
    .map(group => [...(group.keys || [group.key || lower(group.name)])].sort().join('+'))
    .sort()
    .join('|');
}

// ---------------------------------------------------------------------------
// Names from memory
// ---------------------------------------------------------------------------

function jaccard(a, b) {
  const left = new Set(a || []);
  const right = new Set(b || []);
  // Two groups with no evidence either way do not contradict each other.
  if (left.size === 0 && right.size === 0) return 1;
  let shared = 0;
  for (const value of left) if (right.has(value)) shared++;
  return shared / (left.size + right.size - shared);
}

function isNameable(group) {
  return !isLockedGroup(group) && group?.kind !== 'review';
}

/**
 * Pair user rename records with groups as a set (D34): a pair qualifies when
 * the overlap is more than half of the smaller side, and its strength is the
 * Jaccard of the two fingerprint sets. Each record names only its single
 * strongest group across all groups; a tie there names nothing. Records that
 * want the same group are settled by strength, then recency, and a record
 * that loses never falls through to a weaker group.
 */
function matchUserRecordsAsSet(order, userRecords, fingerprintOf, apply) {
  const groupPrints = order.map(group => ({ group, prints: new Set((group.tabIds || []).map(fingerprintOf).filter(Boolean)) }))
    .filter(entry => entry.prints.size > 0);
  const choices = [];
  userRecords.forEach((record, recency) => {
    const stored = new Set(Array.isArray(record.f) ? record.f : []);
    let best = null;
    let tied = false;
    for (const { group, prints } of groupPrints) {
      const smaller = Math.min(stored.size, prints.size);
      if (smaller === 0) continue;
      let overlap = 0;
      for (const fingerprint of stored) if (prints.has(fingerprint)) overlap++;
      if (overlap <= USER_FINGERPRINT_OVERLAP * smaller) continue;
      const strength = overlap / (stored.size + prints.size - overlap);
      if (!best || strength > best.strength) { best = { group, record, recency, strength }; tied = false; }
      else if (strength === best.strength) tied = true;
    }
    if (best && !tied) choices.push(best);
  });
  choices.sort((a, b) => b.strength - a.strength || a.recency - b.recency);
  const doneGroups = new Set();
  for (const choice of choices) {
    if (doneGroups.has(choice.group)) continue;
    if (apply(choice.group, choice.record, 'memory-user')) doneGroups.add(choice.group);
  }
}

/**
 * Carry names over from PlanMemory. User renames apply first, when their tab
 * fingerprints cover at least half of the smaller side. Model names apply
 * when candidate keys (Jaccard ≥ 0.5) and token hashes (Jaccard ≥ 0.25) both
 * match, so a 'Japan Trip' name cannot jump to a Paris travel group. Newest
 * records win. Model names go through validateGroupName; a user's own name
 * only needs normalizeUserGroupName (the rule it was stored under) and must
 * not collide with another group, since generic words are the user's choice.
 * With `userMatch: 'set'` (a cached result, D34), user renames are matched to
 * all groups at once: each record names only its single strongest group, with
 * more than half of the smaller side shared; a tie, or a group a stronger record
 * took, names nothing.
 */
export function transferNames(groups, memory, { tabsById = null, tokensById = null, fingerprintById = null, userMatch = 'order' } = {}) {
  const out = (groups || []).map(group => ({ ...group }));
  const records = (Array.isArray(memory) ? memory : Array.isArray(memory?.names) ? memory.names : [])
    .filter(record => record && typeof record.n === 'string');
  if (records.length === 0) return out;

  const newestFirst = (a, b) => (Number(b.t) || 0) - (Number(a.t) || 0);
  const userRecords = records.filter(record => record.s === 'user').sort(newestFirst);
  const modelRecords = records.filter(record => record.s !== 'user').sort(newestFirst);
  const tokensFor = id => {
    const known = tokensById instanceof Map ? tokensById.get(id) : tokensById?.[id];
    if (known) return known;
    const tab = lookupTab(tabsById, id);
    return tab ? titleTokens(tab) : null;
  };
  const tokenSource = new Map();
  const order = out
    .filter(isNameable)
    .sort((a, b) => groupSize(b) - groupSize(a) || compareStrings(String(a.key || a.name), String(b.key || b.name)));
  const named = new Set();
  const used = new Set();

  const apply = (group, record, source) => {
    const taken = out.filter(other => other !== group).map(other => other.name);
    let name = null;
    if (source === 'memory-user') {
      const userName = normalizeUserGroupName(record.n);
      if (userName && !taken.some(other => lower(other) === lower(userName))) name = userName;
    } else {
      name = validateGroupName(record.n, group, tabsById, taken);
    }
    if (!name) return false;
    group.name = name;
    group.nameSource = source;
    if (source === 'memory-user' && CHROME_COLORS.has(record.c)) group.color = record.c;
    named.add(group);
    used.add(record);
    return true;
  };

  const fingerprintOf = id => (fingerprintById instanceof Map ? fingerprintById.get(id) : fingerprintById?.[id]);
  if (userMatch === 'set') matchUserRecordsAsSet(order, userRecords, fingerprintOf, apply);
  else for (const group of order) {
    const fingerprints = new Set((group.tabIds || []).map(fingerprintOf).filter(Boolean));
    if (fingerprints.size === 0) continue;
    for (const record of userRecords) {
      if (used.has(record)) continue;
      const stored = new Set(Array.isArray(record.f) ? record.f : []);
      const smaller = Math.min(stored.size, fingerprints.size);
      if (smaller === 0) continue;
      let overlap = 0;
      for (const fingerprint of stored) if (fingerprints.has(fingerprint)) overlap++;
      if (overlap >= USER_FINGERPRINT_OVERLAP * smaller && apply(group, record, 'memory-user')) break;
    }
  }

  for (const group of order) {
    if (named.has(group)) continue;
    const keys = group.keys || (group.key ? [group.key] : []);
    for (const id of group.tabIds || []) tokenSource.set(id, tokensFor(id));
    const hashes = groupTokenHashes(group, tokenSource);
    for (const record of modelRecords) {
      if (used.has(record)) continue;
      if (jaccard(record.k, keys) < MODEL_KEY_JACCARD) continue;
      if (jaccard(record.w, hashes) < MODEL_TOKEN_JACCARD) continue;
      if (apply(group, record, 'memory-model')) break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The safety net
// ---------------------------------------------------------------------------

/**
 * Approach the preferred `ceiling` through mutually related categories.
 * Coherent groups may exceed that target up to `hardLimit` (default 10).
 * If unrelated groups exceed the hard maximum, the smallest share a neutral
 * Review Later queue. Explicit rules, Socials and remembered user names stay
 * protected; their count may require the documented protected-groups exception.
 * `n` optionally supplies the full window size when groups omit protected tabs.
 */
export function enforceGroupCeiling(groups, {
  ceiling, hardLimit = MAX_GROUPS, protectedNames = [], dominantOf = null, n = null
} = {}) {
  const limit = Math.floor(Number(ceiling));
  const hard = Math.max(1, Math.min(MAX_GROUPS, Math.floor(Number(hardLimit)) || MAX_GROUPS));
  const input = groups || [];
  if (!Number.isFinite(limit) || limit < 1 || (input.length <= limit && input.length <= hard)) return [...input];

  const protectedSet = new Set([...(protectedNames || [])].map(lower));
  const total = Number.isFinite(n) ? n : input.reduce((sum, group) => sum + groupSize(group), 0);
  const maxSize = getMaxGroupSize(total);
  let items = input.map((group, index) => {
    const dominant = labelKey(typeof dominantOf === 'function' ? dominantOf(group) : group.dominant);
    const known = { ...group, dominant };
    return {
      group: known,
      key: String(group.key || `${lower(group.name)}#${index}`),
      protected: isLockedGroup(group) || ['memory-user', 'user'].includes(group.nameSource) || protectedSet.has(lower(group.name)),
      reserved: isReviewGroup(group),
      categories: categoriesOf(known),
      counts: new Map(dominant ? [[dominant, groupSize(group)]] : [])
    };
  });
  const size = item => groupSize(item.group);
  const merge = (target, source) => {
    const counts = new Map(target.counts);
    for (const [key, count] of source.counts) counts.set(key, (counts.get(key) || 0) + count);
    const merged = {
      ...target.group,
      name: nameForMerge(target.group, source.group),
      tabIds: [...target.group.tabIds, ...source.group.tabIds],
      categories: combinedCategories(target.group, source.group),
      dominant: topCategory(counts),
      nameSource: 'deterministic'
    };
    if (Array.isArray(target.group.keys) || Array.isArray(source.group.keys)) {
      merged.keys = [...new Set([...(target.group.keys || []), ...(source.group.keys || [])])].sort();
    }
    const replacement = { ...target, group: merged, categories: merged.categories, counts };
    items = items.filter(item => item !== source).map(item => item === target ? replacement : item);
  };

  while (items.length > limit) {
    const mergeable = items.filter(item => !item.protected && !item.reserved);
    let best = null;
    for (const source of mergeable) {
      for (const target of mergeable) {
        if (source === target || size(source) > size(target) || !compatibleGroups(source.group, target.group)) continue;
        const combined = size(source) + size(target);
        if (combined > maxSize) continue;
        const key = [-categoryAffinity(source.group.dominant, target.group.dominant),
          combined, `${source.key}|${target.key}`];
        if (!best || compareKeys(key, best.key) < 0) best = { source, target, key };
      }
    }
    if (!best) break;
    merge(best.target, best.source);
  }

  if (items.length > hard) {
    const smallest = list => [...list].sort((a, b) => size(a) - size(b) || compareStrings(a.key, b.key))[0];
    let review = items.find(item => !item.protected && item.reserved);
    if (!review) {
      review = smallest(items.filter(item => !item.protected));
      if (review) {
        review.group = { ...review.group, name: REVIEW_GROUP_NAME, color: 'grey', kind: 'review',
          key: REVIEW_KEY, dominant: null, categories: [], nameSource: 'deterministic' };
        review.reserved = true;
      }
    }
    while (review && items.length > hard) {
      const source = smallest(items.filter(item => item !== review && !item.protected));
      if (!source) break;
      review.group = { ...review.group,
        tabIds: [...review.group.tabIds, ...source.group.tabIds],
        keys: [...new Set([...(review.group.keys || []), ...(source.group.keys || [])])].sort() };
      items = items.filter(item => item !== source);
    }
  }
  return items.map(item => item.group);
}

// ---------------------------------------------------------------------------
// Model plans
// ---------------------------------------------------------------------------

const PLAN_FALLBACK_NAME = 'Folder';
const PLAN_PALETTE = ['blue', 'green', 'purple', 'orange', 'cyan', 'pink', 'yellow', 'red'];

function ownValue(object, key) {
  return object && typeof object === 'object' && Object.hasOwn(object, key) ? object[key] : undefined;
}

/**
 * The deterministic local name and colour of a plan folder: the category most
 * of its tabs read as by address and title, else its dominant site.
 */
function localFolderIdentity(tabs, tabsById) {
  const counts = new Map();
  for (const tab of tabs) {
    const key = categoryFromSite(tabUrl(tab)) || categoryFromTitle(tab?.title);
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  }
  const top = topCategory(counts);
  const category = top ? CATEGORY_BY_KEY.get(top) : null;
  if (category) return { name: category.name, color: category.color, dominant: top };
  const site = dominantSiteName({ tabIds: tabs.map(tab => tab.id) }, tabsById);
  return { name: site && isUsableDeterministicName(clampName(site)) ? clampName(site) : PLAN_FALLBACK_NAME, color: null, dominant: null };
}

/**
 * Turn a raw plan answer {folders: [{name, ids}]} into groups under the
 * evaluation's policy (eval/scoring.mjs applyGroups). `tabs` are the rows
 * sent, in order: an id is a row ordinal. Each tab is in at most one folder
 * (first placement wins); unknown, non-integer and out-of-range ids are
 * dropped; a folder named Review Later (any case) is no group. At most
 * `limit` groups (MAX_GROUPS minus the locked groups): Review Later counts as
 * one when any tab is unassigned, the largest folders stay (ties by first
 * appearance) and the tabs of the rest join Review Later.
 *
 * Names go through validateGroupName; a rejected or duplicate name becomes
 * the deterministic local name. User renames in `memory` win, as in
 * planLocally. Locked groups pass through first. Never throws on any answer.
 * Returns {groups, unassigned, dropped, folders, reviewOnly}: `folders`
 * counts the model folders applied (0 means the answer gave no usable group);
 * `reviewOnly` marks a valid answer from which no model folder survives.
 */
export function enforcePlan(answer, tabs, {
  locked = [], tabsById = null, memory = null, fingerprintById = null, hardLimit = MAX_GROUPS
} = {}) {
  const rows = Array.isArray(tabs) ? tabs : [];
  const byId = tabsById || new Map(rows.map(tab => [tab.id, tab]));
  const lockedGroups = (locked || []).filter(group => (group?.tabIds || []).length > 0);
  const limit = Math.max(1, Math.floor(Number(hardLimit) || MAX_GROUPS) - lockedGroups.length);
  const rawFolders = ownValue(answer, 'folders');
  const folders = Array.isArray(rawFolders) ? rawFolders : [];

  // Work is bounded by the rows sent, whatever the answer holds: a usable
  // answer has one entry per row in at most MAX_GROUPS folders.
  const folderBudget = rows.length + MAX_GROUPS;
  let entryBudget = 2 * (rows.length + MAX_GROUPS);
  const placed = new Set();
  const kept = [];
  let reviewPlaced = 0;
  folders.slice(0, folderBudget).forEach((folder, order) => {
    const rawIds = ownValue(folder, 'ids');
    const ids = [];
    const list = Array.isArray(rawIds) ? rawIds : [];
    const count = Math.min(list.length, Math.max(0, entryBudget));
    entryBudget -= count;
    for (let index = 0; index < count; index++) {
      const ordinal = list[index];
      if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= rows.length) continue;
      const id = rows[ordinal]?.id;
      if (id === undefined || id === null || placed.has(id)) continue;
      placed.add(id);
      ids.push(id);
    }
    const rawName = ownValue(folder, 'name');
    const name = typeof rawName === 'string' ? rawName : '';
    if (ids.length && lower(name) === lower(REVIEW_GROUP_NAME)) reviewPlaced += ids.length;
    else if (ids.length) kept.push({ rawName: name, ids, order });
  });
  const anyUnassigned = kept.reduce((sum, folder) => sum + folder.ids.length, 0) < rows.length;
  const room = anyUnassigned || kept.length > limit ? limit - 1 : limit;
  const survivors = new Set([...kept].sort((a, b) => b.ids.length - a.ids.length || a.order - b.order).slice(0, Math.max(0, room)));
  const applied = kept.filter(folder => survivors.has(folder));
  const assigned = new Set(applied.flatMap(folder => folder.ids));
  const unassigned = rows.map(tab => tab.id).filter(id => !assigned.has(id));

  const taken = [...lockedGroups.map(group => group.name), REVIEW_GROUP_NAME];
  const planned = applied.map((folder, index) => {
    const memberTabs = folder.ids.map(id => byId instanceof Map ? byId.get(id) : byId[id]).filter(Boolean);
    const local = localFolderIdentity(memberTabs, byId);
    const group = {
      name: local.name,
      color: local.color || PLAN_PALETTE[index % PLAN_PALETTE.length],
      tabIds: folder.ids,
      key: `plan:${index}`,
      keys: [`plan:${index}`],
      dominant: local.dominant,
      kind: 'folder',
      nameSource: 'deterministic'
    };
    const name = validateGroupName(folder.rawName, group, byId, taken);
    if (name) {
      group.name = name;
      group.nameSource = 'model';
    }
    if (group.nameSource === 'model') taken.push(group.name);
    return group;
  });
  const userMemory = memory ? { names: (memory.names || []).filter(record => record?.s === 'user') } : null;
  const named = transferNames(planned, userMemory, { tabsById: byId, fingerprintById });
  const review = unassigned.length ? [{
    name: REVIEW_GROUP_NAME, color: 'grey', tabIds: unassigned, key: REVIEW_KEY, keys: [REVIEW_KEY],
    dominant: null, kind: 'review', nameSource: 'deterministic'
  }] : [];
  const lockedOut = lockedGroups.map(group => ({ ...group, tabIds: [...group.tabIds], locked: true }));
  return {
    groups: ensureUniqueNames([...lockedOut, ...named, ...review], [], { tabsById: byId, joinLocked: false }),
    unassigned,
    dropped: kept.length - applied.length,
    folders: applied.length,
    // A valid answer from which no model folder survives (Review Later only,
    // or its folders lost the free slots to Review Later), as opposed to an
    // unusable one.
    reviewOnly: applied.length === 0 && (reviewPlaced > 0 || kept.length > 0)
  };
}
