/**
 * Foldnex - Deterministic group planner
 *
 * Turns one category label per tab into coherent groups. groupCeiling(n) is
 * the preferred count; unrelated topics stay separate up to MAX_GROUPS. Models
 * never count or create groups: every group identity is a local candidate (a
 * category, a shared title token, a site, a locked rule or Review Later), and
 * every tie is broken by a stable key, so the same window always plans the same
 * way whatever order its tabs arrive in.
 *
 * Pure module: no chrome.* calls, no storage and no clock.
 */

import {
  findRegionalLabelIssues,
  getMaxGroupSize,
  groupCeiling,
  isGenericGroupName,
  MAX_GROUPS,
  minGroupSize
} from './ai-engine.js';
import { extractPatternKey, hashToken, normalizeUserGroupName, sanitizeTitle } from './cache-engine.js';
import { describeSite, isAtomicSite, siteKeyForUrl } from './site-clusterer.js';
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
const TASK_MAX_SHARE = 0.5;
const ATTACH_MIN_SCORE = 0.34;
const TOKEN_HASH_LIMIT = 8;
const SITE_AFFINITY_AGREEMENT = 0.8;
const USER_FINGERPRINT_OVERLAP = 0.5;
const MODEL_KEY_JACCARD = 0.5;
const MODEL_TOKEN_JACCARD = 0.25;

/**
 * Sites whose tabs cover every subject, so one labelled tab says nothing about
 * the next one. Site keys plus a few full hosts.
 */
export const MULTI_PURPOSE_SITES = new Set([
  'google', 'bing', 'duckduckgo', 'youtube', 'wikipedia', 'medium', 'chatgpt',
  'claude', 'gemini', 'perplexity', 'amazon', 'docs.google.com', 'drive.google.com'
]);

// Labels the planner or inference produced locally. They never feed site
// affinity, so a guess can never confirm itself.
const LOCAL_LABEL_SOURCES = new Set(['site-affinity', 'site', 'lexicon', 'token-attach', 'loose', 'review']);
const LABEL_PRIORITY = new Map([['lexicon', 1], ['site', 2], ['site-affinity', 3]]);
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

function readLabel(labelsById, id) {
  if (!labelsById || id === undefined || id === null) return undefined;
  if (labelsById instanceof Map) return labelsById.has(id) ? labelsById.get(id) : labelsById.get(String(id));
  return labelsById[id];
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

function bump(map, key, value) {
  if (!key) return;
  const counts = map.get(key) || new Map();
  counts.set(value, (counts.get(value) || 0) + 1);
  map.set(key, counts);
}

function isLockedGroup(group) {
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

// ---------------------------------------------------------------------------
// Local label inference
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

function isModelLabel(value) {
  if (typeof value === 'string') return true;
  if (!value || typeof value !== 'object') return false;
  return !LOCAL_LABEL_SOURCES.has(value.src);
}

/**
 * Category counts per URL pattern and per site, from model and cached labels
 * only. Inferred labels are left out so a guess never confirms itself.
 */
export function buildLocalContext(tabs, labelsById) {
  const byPattern = new Map();
  const bySite = new Map();
  for (const tab of tabs || []) {
    const value = readLabel(labelsById, tab?.id);
    const key = labelKey(value);
    if (!key || !isModelLabel(value)) continue;
    const url = tabUrl(tab);
    bump(byPattern, extractPatternKey(url), key);
    bump(bySite, siteKeyForUrl(url), key);
  }
  return { byPattern, bySite };
}

function isMultiPurpose(url, siteKey) {
  if (MULTI_PURPOSE_SITES.has(siteKey)) return true;
  try {
    return MULTI_PURPOSE_SITES.has(new URL(url).hostname.replace(/^www\./, '').toLowerCase());
  } catch {
    return false;
  }
}

function siteAffinityLabel(url, siteKey, ctx) {
  if (!ctx || !siteKey || isMultiPurpose(url, siteKey)) return null;
  const patternCounts = ctx.byPattern?.get(extractPatternKey(url));
  if (patternCounts?.size === 1) return [...patternCounts.keys()][0];

  const siteCounts = ctx.bySite?.get(siteKey);
  if (!siteCounts) return null;
  let total = 0;
  for (const count of siteCounts.values()) total += count;
  const top = topCategory(siteCounts);
  if (total >= 2 && top && siteCounts.get(top) / total >= SITE_AFFINITY_AGREEMENT) return top;
  return null;
}

/**
 * Best local guess for a tab the model has not labelled: site affinity with
 * labelled neighbours, then the site taxonomy, then title words. Returns
 * {c, src} or null. These guesses are provisional and never cached.
 */
export function inferLocalLabel(tab, ctx = null) {
  const url = tabUrl(tab);
  const affinity = siteAffinityLabel(url, siteKeyForUrl(url), ctx);
  if (affinity) return { c: affinity, src: 'site-affinity' };
  const site = categoryFromSite(url);
  if (site) return { c: site, src: 'site' };
  const lexicon = categoryFromTitle(tab?.title);
  if (lexicon) return { c: lexicon, src: 'lexicon' };
  return null;
}

/**
 * How well a tab can be placed without the model: 0 none, 1 lexicon, 2 site,
 * 3 site affinity. Callers label the lowest first.
 */
export function labelPriority(tab, ctx = null) {
  return LABEL_PRIORITY.get(inferLocalLabel(tab, ctx)?.src) || 0;
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

function surfaceName(token, entries) {
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

export function validateGroupName(raw, group = null, tabsById = null, takenNames = []) {
  if (typeof raw !== 'string') return null;
  const normalized = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
  // Checked before stripping, which would remove the dot.
  if (BARE_DOMAIN.test(normalized)) return null;
  const name = normalized
    .replace(/[^\p{L}\p{M}\p{N} &'·-]+/gu, '')
    // Marks are kept for scripts that need them, but not orphaned ones such as
    // an emoji's variation selector left behind after the emoji is stripped.
    .replace(/(^|[^\p{L}\p{M}\p{N}])\p{M}+/gu, '$1')
    .replace(/\s+/g, ' ')
    .replace(/^[\s&'·-]+|[\s&'·-]+$/g, '')
    .trim();
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
// Planning
// ---------------------------------------------------------------------------

/** Smallest shared-token task worth its own group: 3 tabs, or 5% of the window. */
export function taskMin(n) {
  return Math.max(3, Math.ceil(0.05 * n));
}

/** Plan identity: every group's sorted keys, sorted and joined. */
export function planSignature(groups) {
  return (groups || [])
    .map(group => [...(group.keys || [group.key || lower(group.name)])].sort().join('+'))
    .sort()
    .join('|');
}

function refreshGroup(group) {
  const categories = new Set(group.entries.map(entry => entry.label));
  group.categories = CATEGORY_KEYS.filter(key => categories.has(key));
  if (group.kind === 'site' || group.kind === 'review') {
    group.dominant = null;
    return;
  }
  const counts = new Map();
  for (const entry of group.entries) {
    if (entry.label) counts.set(entry.label, (counts.get(entry.label) || 0) + 1);
  }
  group.dominant = topCategory(counts);
}

function makeGroup(fields, entries) {
  const group = { keys: new Set([fields.key]), ...fields, entries: [...entries] };
  refreshGroup(group);
  return group;
}

function groupColor(group) {
  if (group.kind === 'review') return 'grey';
  if (group.kind === 'site') return group.siteColor || 'grey';
  return CATEGORY_BY_KEY.get(group.dominant)?.color || group.siteColor || 'grey';
}

function siteDisplayName(entry) {
  const { siteName } = describeSite(tabUrl(entry.tab));
  if (siteName && !isGenericGroupName(siteName)) return clampName(siteName);
  return clampName(entry.siteKey) || 'Site';
}

function tokenBag(entries) {
  const counts = new Map();
  for (const entry of entries) {
    for (const token of entry.tokens) counts.set(token, (counts.get(token) || 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count >= 2).map(([token]) => token));
}

/**
 * Best candidate for a loose tab by shared tokens with the candidate's bag.
 * Bags and sizes are fixed before attaching, so input order cannot matter.
 */
function bestAttach(entry, groups, bags, sizes, minScore) {
  if (entry.tokens.size === 0) return null;
  let best = null;
  for (const group of groups) {
    const bag = bags.get(group);
    let overlap = 0;
    for (const token of entry.tokens) if (bag?.has(token)) overlap++;
    if (overlap < 1) continue;
    const score = overlap / entry.tokens.size;
    if (score < minScore) continue;
    const key = [-score, -overlap, -sizes.get(group), group.key];
    if (!best || compareKeys(key, best.key) < 0) best = { group, key };
  }
  return best?.group || null;
}

function uniqueKey(key, groups) {
  const used = new Set(groups.map(group => group.key));
  if (!used.has(key)) return key;
  for (let index = 2; ; index++) {
    if (!used.has(`${key}#${index}`)) return `${key}#${index}`;
  }
}

/**
 * Plan the groups for one window.
 *
 * tabs: the groupable tabs in strip order (locked tabs may be included or not).
 * labelsById: Map of tab ID → category key, or {c} from caches and inference;
 * a missing label leaves the tab loose.
 * locked: explicit rule groups first, then Socials: {name, color, tabIds, kind}.
 * advice: cached consolidation advice {candidateKey: anchorKey}, used only
 * while the plan is above the ceiling.
 *
 * Returns {K, n, groups, candidates, signature, flags, reviewTabIds, tokensById}.
 * The group count never exceeds max(MAX_GROUPS, lockedCount + 1); K is a
 * preferred count, never a reason to join unrelated subjects. Every tab appears
 * exactly once.
 */
export function planGroups(tabs, labelsById, { locked = [], advice = null } = {}) {
  // Step 1: locked groups pass through with their membership.
  const claimed = new Set();
  const lockedGroups = [];
  for (const group of locked || []) {
    const tabIds = [];
    for (const id of group?.tabIds || []) {
      if (id === undefined || id === null || claimed.has(id)) continue;
      claimed.add(id);
      tabIds.push(id);
    }
    if (tabIds.length === 0) continue;
    const kind = group.kind === 'social' || group.kind === 'rule'
      ? group.kind
      : lower(group.name) === 'socials' ? 'social' : 'rule';
    const key = group.key || (kind === 'social' ? 'social' : `rule:${hashToken(lower(group.name))}`);
    lockedGroups.push({
      ...group,
      name: String(group.name || ''),
      color: group.color || 'blue',
      tabIds,
      key,
      keys: [key],
      dominant: null,
      kind,
      locked: true,
      nameSource: 'deterministic'
    });
  }

  // Step 2: the unlocked pool in strip order.
  const seen = new Set();
  const entries = [];
  (tabs || []).forEach((tab, position) => {
    const id = tab?.id;
    if (id === undefined || id === null || seen.has(id)) return;
    seen.add(id);
    if (claimed.has(id)) return;
    const { tokens, surfaces, siteKey, siteMention } = tokenizeTab(tab);
    entries.push({
      tab,
      id,
      order: [Number.isFinite(tab.index) ? tab.index : Number.MAX_SAFE_INTEGER, position],
      label: labelKey(readLabel(labelsById, id)),
      siteKey,
      tokens,
      surfaces,
      // A title naming its own (single-purpose) site still counts for tasks.
      siteToken: siteMention && siteKey && !isMultiPurpose(tabUrl(tab), siteKey) ? siteKey : null
    });
  });
  entries.sort((a, b) => compareKeys(a.order, b.order));

  const n = claimed.size + entries.length;
  const K = groupCeiling(n);
  const limit = Math.max(1, K);
  const F = lockedGroups.length;
  const minSize = minGroupSize(n);
  const maxSize = getMaxGroupSize(n);
  const tabsById = new Map(entries.map(entry => [entry.id, entry.tab]));
  const flags = [];
  let groups = [];
  const lockedByName = new Map();
  for (const group of lockedGroups) {
    const nameKey = lower(group.name);
    if (nameKey && !lockedByName.has(nameKey)) lockedByName.set(nameKey, group);
  }
  const isLockedName = name => lockedByName.has(lower(name));

  const size = group => group.entries.length;
  const stripOrder = list => [...list].sort((a, b) => compareKeys(a.order, b.order)).map(entry => entry.id);
  const remove = group => {
    groups = groups.filter(other => other !== group);
  };
  const mergeInto = (target, source) => {
    // Review Later never lends its name to real tabs.
    if (source.kind !== 'review') {
      let name = nameForMerge(target, source);
      // After step 5d no candidate holds a locked name; a combined one must not either.
      if (isLockedName(name)) name = size(target) >= size(source) ? target.name : source.name;
      target.name = name;
    }
    target.entries.push(...source.entries);
    for (const key of source.keys) target.keys.add(key);
    refreshGroup(target);
    remove(source);
  };
  const pairKey = (s, t) => {
    const combined = size(s) + size(t);
    return [combined > maxSize ? 1 : 0, -categoryAffinity(s.dominant, t.dominant), combined, `${s.key}|${t.key}`];
  };

  // Step 3: task promotion. A token shared across categories and sites is a
  // task the user is working on, so it outranks the category split.
  const taskMinimum = taskMin(n);
  const holders = new Map();
  for (const entry of entries) {
    if (!entry.label) continue;
    const taskTokens = new Set(entry.tokens);
    if (entry.siteToken) taskTokens.add(entry.siteToken);
    for (const token of taskTokens) {
      const list = holders.get(token) || [];
      list.push(entry);
      holders.set(token, list);
    }
  }
  const taken = new Set();
  for (;;) {
    let best = null;
    for (const [token, list] of holders) {
      const free = list.filter(entry => !taken.has(entry.id));
      if (free.length < taskMinimum || free.length > TASK_MAX_SHARE * n) continue;
      if (new Set(free.map(entry => entry.label)).size < 2) continue;
      if (new Set(free.map(entry => entry.siteKey)).size < 2) continue;
      if (!best || free.length > best.free.length || (free.length === best.free.length && token < best.token)) {
        best = { token, free };
      }
    }
    if (!best) break;
    holders.delete(best.token);
    const name = surfaceName(best.token, best.free);
    if (!isUsableDeterministicName(name)) continue;
    for (const entry of best.free) taken.add(entry.id);
    const key = uniqueKey(`task:${hashToken(best.token)}`, groups);
    groups.push(makeGroup({ key, kind: 'task', token: best.token, name }, best.free));
  }

  // Step 4: one candidate per category present.
  const byCategory = new Map();
  for (const entry of entries) {
    if (!entry.label || taken.has(entry.id)) continue;
    const list = byCategory.get(entry.label) || [];
    list.push(entry);
    byCategory.set(entry.label, list);
  }
  for (const key of CATEGORY_KEYS) {
    const list = byCategory.get(key);
    if (list) groups.push(makeGroup({ key: `cat:${key}`, kind: 'category', name: CATEGORY_BY_KEY.get(key).name }, list));
  }

  // Step 5a: repeated unknown sites keep their own group.
  const loose = entries.filter(entry => !entry.label);
  const looseBySite = new Map();
  for (const entry of loose) {
    if (!entry.siteKey) continue;
    const list = looseBySite.get(entry.siteKey) || [];
    list.push(entry);
    looseBySite.set(entry.siteKey, list);
  }
  const inSiteGroup = new Set();
  for (const siteKey of [...looseBySite.keys()].sort(compareStrings)) {
    const list = looseBySite.get(siteKey);
    if (list.length < minSize) continue;
    list.forEach(entry => inSiteGroup.add(entry.id));
    groups.push(makeGroup({
      key: uniqueKey(`site:${hashToken(siteKey)}`, groups),
      kind: 'site',
      name: siteDisplayName(list[0]),
      siteColor: describeSite(tabUrl(list[0].tab)).color
    }, list));
  }

  // Step 5b: remaining loose tabs join a candidate whose titles they share.
  const bags = new Map(groups.map(group => [group, tokenBag(group.entries)]));
  let sizes = new Map(groups.map(group => [group, size(group)]));
  const attachments = [];
  const stillLoose = [];
  for (const entry of loose) {
    if (inSiteGroup.has(entry.id)) continue;
    const target = bestAttach(entry, groups, bags, sizes, ATTACH_MIN_SCORE);
    if (target) attachments.push([target, entry]);
    else stillLoose.push(entry);
  }
  for (const [group, entry] of attachments) group.entries.push(entry);

  // Step 5c: an unknown tab is not evidence for the largest known topic.
  if (stillLoose.length > 0) {
    groups.push(makeGroup({ key: REVIEW_KEY, kind: 'review', name: REVIEW_GROUP_NAME }, stillLoose));
  }

  // Step 5d: a candidate named like a locked group joins it now, as
  // ensureUniqueNames would at the end, so it takes no ceiling slot and never
  // reaches plan.candidates while its tabs sit in the locked group.
  for (const group of [...groups]) {
    const target = lockedByName.get(lower(group.name));
    if (!target) continue;
    target.tabIds.push(...stripOrder(group.entries));
    target.keys = [...new Set([...target.keys, ...group.keys])].sort();
    remove(group);
  }

  // Step 6: tiny candidates may fold into a strongly related partner. Being
  // alone never makes an unrelated category a suitable destination.
  const tinyPartner = (source, minAffinity) => {
    let best = null;
    for (const target of groups) {
      if (target === source || target.kind === 'review') continue;
      if (!compatibleGroups(source, target, minAffinity)) continue;
      const affinity = categoryAffinity(source.dominant, target.dominant);
      if (affinity < minAffinity) continue;
      const combined = size(source) + size(target);
      if (combined > maxSize) continue;
      const key = [-affinity, size(target) < minSize ? 1 : 0, combined, target.key];
      if (!best || compareKeys(key, best.key) < 0) best = { target, key };
    }
    return best?.target || null;
  };
  const tinyOrder = [...groups].sort((a, b) => size(a) - size(b) || compareStrings(a.key, b.key));
  for (const source of tinyOrder) {
    if (!groups.includes(source) || source.kind === 'review' || size(source) >= minSize) continue;
    const target = tinyPartner(source, 2);
    if (target) mergeInto(target, source);
  }

  // Step 7-8: split oversized categories on a shared title token or a site,
  // using spare space up to the hard maximum. Shared tasks and atomic sites
  // are already explicit coherent identities, so keep their membership.
  const atomicIdentity = entry => {
    const rawUrl = tabUrl(entry.tab);
    if (!isAtomicSite(rawUrl)) return null;
    const site = describeSite(rawUrl);
    if (site.known) return `service:${site.name}`;
    try {
      return `host:${new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '')}`;
    } catch {
      return null;
    }
  };
  const isAtomic = group => {
    if (group.kind === 'task' || group.kind === 'site') return true;
    const identity = atomicIdentity(group.entries[0]);
    return Boolean(identity) && group.entries.every(entry => atomicIdentity(entry) === identity);
  };
  const findCarve = group => {
    const remainderOk = count => count >= minSize && size(group) - count >= minSize;
    const byToken = new Map();
    for (const entry of group.entries) {
      for (const token of entry.tokens) {
        if (token === group.token) continue;
        const list = byToken.get(token) || [];
        list.push(entry);
        byToken.set(token, list);
      }
    }
    let best = null;
    for (const [token, list] of byToken) {
      if (!remainderOk(list.length)) continue;
      if (best && (list.length < best.members.length || (list.length === best.members.length && token > best.token))) continue;
      const name = surfaceName(token, list);
      if (!isUsableDeterministicName(name) || isLockedName(name)) continue;
      best = { token, members: list, name, hashInput: token };
    }
    if (best) return best;

    const bySite = new Map();
    for (const entry of group.entries) {
      if (!entry.siteKey) continue;
      const list = bySite.get(entry.siteKey) || [];
      list.push(entry);
      bySite.set(entry.siteKey, list);
    }
    for (const [siteKey, list] of bySite) {
      if (!remainderOk(list.length)) continue;
      if (best && (list.length < best.members.length || (list.length === best.members.length && siteKey > best.token))) continue;
      const siteName = siteDisplayName(list[0]);
      const short = CATEGORY_BY_KEY.get(group.dominant)?.short;
      const withShort = short ? `${short} · ${siteName}` : '';
      const name = withShort && withShort.length <= GROUP_NAME_LIMIT ? withShort : siteName;
      if (isLockedName(name)) continue;
      // Hashed apart from tokens so a token and a site key can never share a key.
      best = { token: siteKey, members: list, name, hashInput: `site:${siteKey}` };
    }
    return best;
  };
  while (F + groups.length < MAX_GROUPS) {
    const oversized = groups
      .filter(group => group.kind !== 'review' && size(group) > maxSize && !isAtomic(group))
      .sort((a, b) => size(b) - size(a) || compareStrings(a.key, b.key));
    let carved = false;
    for (const group of oversized) {
      const carve = findCarve(group);
      if (!carve) continue;
      const parentCategory = group.dominant || 'site';
      const members = new Set(carve.members);
      group.entries = group.entries.filter(entry => !members.has(entry));
      refreshGroup(group);
      const key = uniqueKey(`split:${parentCategory}:${hashToken(carve.hashInput)}`, groups);
      groups.push(makeGroup({ key, kind: 'split', token: carve.token, name: carve.name }, carve.members));
      carved = true;
      break;
    }
    if (!carved) break;
  }

  // Consolidation sees the bounded candidates. Passing an unsplit parent
  // would let a provider undo the size repair with one unchanged row.
  const candidates = groups
    .filter(group => group.kind !== 'review')
    .sort((a, b) => size(b) - size(a) || compareStrings(a.key, b.key))
    .map(group => ({
      key: group.key,
      keys: [...group.keys].sort(),
      kind: group.kind,
      name: group.name,
      color: groupColor(group),
      dominant: group.dominant,
      categories: categoriesOf(group),
      tabIds: stripOrder(group.entries),
      size: size(group)
    }));

  // Step 9: approach the preferred count only through coherent merges.
  // Advice cannot turn a merely dominant category into permission to absorb
  // unrelated members. If the hard maximum still requires compaction, the
  // smallest unrelated groups share the neutral review queue.
  const adviceEntries = advice instanceof Map ? [...advice] : Object.entries(advice || {});
  while (F + groups.length > limit) {
      const mergeable = groups.filter(group => group.kind !== 'review');
      if (mergeable.length < 2) break;
      let best = null;
      for (const [sourceKey, anchorKey] of adviceEntries) {
        const source = mergeable.find(group => group.keys.has(sourceKey));
        const target = mergeable.find(group => group.keys.has(anchorKey));
        if (!source || !target || source === target || size(source) + size(target) > maxSize
          || !compatibleGroups(source, target)) continue;
        const key = pairKey(source, target);
        if (!best || compareKeys(key, best.key) < 0) best = { source, target, key };
      }
      if (!best) {
        for (const source of mergeable) {
          for (const target of mergeable) {
            if (source === target || size(source) > size(target)) continue;
            if (size(source) + size(target) > maxSize) continue;
            if (!compatibleGroups(source, target)) continue;
            const key = pairKey(source, target);
            if (!best || compareKeys(key, best.key) < 0) best = { source, target, key };
          }
        }
      }
      if (!best) break;
      mergeInto(best.target, best.source);
  }
  const hardAvailable = Math.max(1, MAX_GROUPS - F);
  if (groups.length > hardAvailable) {
    let review = groups.find(group => group.kind === 'review');
    if (!review) {
      review = [...groups].sort((a, b) => size(a) - size(b) || compareStrings(a.key, b.key))[0];
      review.kind = 'review';
      review.name = REVIEW_GROUP_NAME;
      review.key = REVIEW_KEY;
      review.keys.add(REVIEW_KEY);
      review.dominant = null;
      review.categories = [];
    }
    while (groups.length > hardAvailable) {
      const source = groups.filter(group => group !== review)
        .sort((a, b) => size(a) - size(b) || compareStrings(a.key, b.key))[0];
      review.entries.push(...source.entries);
      for (const key of source.keys) review.keys.add(key);
      remove(source);
    }
  }
  if (F + groups.length > MAX_GROUPS) flags.push('rules_exceed_ceiling');

  // Step 10-11: final fields. A name that contradicts a member's country
  // falls back to the category name.
  for (const group of groups) {
    if (group.kind === 'review') continue;
    const memberTabs = group.entries.map(entry => entry.tab);
    const ids = group.entries.map(entry => entry.id);
    if (findRegionalLabelIssues([{ name: group.name, tabIds: ids }], memberTabs).length > 0) {
      const fallback = CATEGORY_BY_KEY.get(group.dominant)?.name;
      if (fallback) group.name = fallback;
    }
  }
  // Groups read left to right in the order of their first tab.
  const unlocked = groups
    .map(group => ({ group, ordered: [...group.entries].sort((a, b) => compareKeys(a.order, b.order)) }))
    .sort((a, b) => compareKeys(a.ordered[0].order, b.ordered[0].order) || compareStrings(a.group.key, b.group.key))
    .map(({ group, ordered }) => ({
      name: clampName(group.name) || CATEGORY_BY_KEY.get(group.dominant)?.name || REVIEW_GROUP_NAME,
      color: groupColor(group),
      tabIds: ordered.map(entry => entry.id),
      key: group.key,
      keys: [...group.keys].sort(),
      dominant: group.dominant,
      categories: categoriesOf(group),
      kind: group.kind,
      nameSource: 'deterministic'
    }));

  // Locked-name collisions were folded in step 5d. One left now (a regional
  // fallback) is renamed instead: its tabs are already in plan.candidates.
  const finalGroups = ensureUniqueNames([...lockedGroups, ...unlocked], [], { tabsById, joinLocked: false });

  // Step 12: every groupable tab exactly once.
  const placed = new Set();
  for (const group of finalGroups) {
    for (const id of group.tabIds) {
      if (placed.has(id)) throw new Error(`planGroups placed tab ${id} twice`);
      placed.add(id);
    }
  }
  if (placed.size !== n) throw new Error(`planGroups placed ${placed.size} of ${n} tabs`);

  const tokensById = new Map(entries.map(entry => [entry.id, entry.tokens]));
  const reviewTabIds = finalGroups.filter(group => group.kind === 'review').flatMap(group => group.tabIds);
  const reviewIds = new Set(reviewTabIds);
  return {
    K,
    hardLimit: MAX_GROUPS,
    n,
    groups: finalGroups,
    candidates: candidates.filter(candidate => !candidate.tabIds.every(id => reviewIds.has(id))),
    signature: planSignature(finalGroups),
    flags,
    reviewTabIds,
    tokensById
  };
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
 * Carry names over from PlanMemory. User renames apply first, when their tab
 * fingerprints cover at least half of the smaller side. Model names apply
 * when candidate keys (Jaccard ≥ 0.5) and token hashes (Jaccard ≥ 0.25) both
 * match, so a 'Japan Trip' name cannot jump to a Paris travel group. Newest
 * records win. Model names go through validateGroupName; a user's own name
 * only needs normalizeUserGroupName (the rule it was stored under) and must
 * not collide with another group, since generic words are the user's choice.
 */
export function transferNames(groups, memory, { tabsById = null, tokensById = null, fingerprintById = null } = {}) {
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
  for (const group of order) {
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
// Consolidation folders and the safety net
// ---------------------------------------------------------------------------

function weightedDominant(members) {
  const counts = new Map();
  for (const member of members) {
    if (member.dominant) counts.set(member.dominant, (counts.get(member.dominant) || 0) + member.size);
  }
  return topCategory(counts);
}

function nameOverMembers(members) {
  const ordered = [...members].sort((a, b) => b.size - a.size || compareStrings(a.key, b.key));
  let acc = { name: ordered[0]?.name || '', size: ordered[0]?.size || 0 };
  for (const member of ordered.slice(1)) {
    acc = { name: mergedName(acc, member), size: acc.size + member.size };
  }
  return acc.name;
}

/**
 * Make a consolidation answer safe: every candidate exactly once, coherent
 * folders, validated names and compatible advice pairs for the next plan.
 * `k` is the preferred count; `hardLimit` is the absolute available count.
 * `n` is the full window size, including protected tabs absent from candidates.
 * `candidates` is plan.candidates (row ID = index). Returns {groups, advice}.
 */
export function enforceFolders(folders, candidates, k, {
  n = null, tabsById = null, takenNames = [], hardLimit = MAX_GROUPS
} = {}) {
  const rows = (candidates || []).map((candidate, index) => ({
    ...candidate,
    index,
    key: String(candidate.key),
    keys: candidate.keys || [candidate.key],
    categories: categoriesOf(candidate),
    name: String(candidate.name || ''),
    dominant: candidate.dominant ?? null,
    tabIds: [...(candidate.tabIds || [])],
    size: groupSize(candidate)
  }));
  const total = Number.isFinite(n) ? n : rows.reduce((sum, row) => sum + row.size, 0);
  const maxSize = getMaxGroupSize(total);
  const assigned = new Set();
  const out = [];
  const add = (members, modelName = '') => {
    const ordered = [...members].sort((a, b) => b.size - a.size || compareStrings(a.key, b.key));
    const categories = CATEGORY_KEYS.filter(key => members.some(member => categoriesOf(member).includes(key)));
    const group = {
      name: nameOverMembers(ordered),
      color: ordered[0].color || CATEGORY_BY_KEY.get(weightedDominant(members))?.color || 'grey',
      tabIds: members.flatMap(member => member.tabIds),
      key: ordered[0].key,
      keys: [...new Set(members.flatMap(member => member.keys))].sort(),
      categories,
      dominant: weightedDominant(members),
      kind: members.length === 1 && members[0].kind === 'task' ? 'task' : 'folder',
      nameSource: 'deterministic'
    };
    const name = validateGroupName(modelName, group, tabsById, takenNames);
    if (name) {
      group.name = name;
      group.nameSource = 'model';
    }
    out.push(group);
  };

  // A provider may name coherent candidates, but cannot hide unrelated rows
  // inside one folder. First valid row ownership remains deterministic.
  for (const folder of Array.isArray(folders) ? folders : []) {
    const subsets = [];
    for (const raw of Array.isArray(folder?.ids) ? folder.ids : []) {
      const id = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
      if (!Number.isInteger(id) || id < 0 || id >= rows.length || assigned.has(id)) continue;
      assigned.add(id);
      const row = rows[id];
      let subset = subsets.find(members => members.reduce((sum, member) => sum + member.size, 0) + row.size <= maxSize
        && members.every(member => compatibleGroups(member, row)));
      if (!subset) subsets.push(subset = []);
      subset.push(row);
    }
    for (const members of subsets) add(members, subsets.length === 1 ? folder.name : '');
  }
  // Missing rows retain their own identity; omission is not merge evidence.
  for (const row of rows) if (!assigned.has(row.index)) add([row]);

  const groups = enforceGroupCeiling(out, { ceiling: k, hardLimit, n: total });
  const advice = {};
  const taken = [...takenNames];
  for (const group of groups) {
    if (tabsById) {
      group.tabIds.sort((a, b) => {
        const position = id => lookupTab(tabsById, id)?.index ?? Number.MAX_SAFE_INTEGER;
        return position(a) - position(b);
      });
    }
    if (isReviewGroup(group)) continue;
    const members = rows.filter(row => group.keys.includes(row.key));
    const anchor = [...members].sort((a, b) => b.size - a.size || compareStrings(a.key, b.key))[0];
    if (anchor) {
      group.key = anchor.key;
      for (const member of members) if (member !== anchor) advice[member.key] = anchor.key;
    }
    const name = validateGroupName(group.name, group, tabsById, taken);
    if (!name) {
      group.name = nameOverMembers(members);
      group.nameSource = 'deterministic';
    }
    taken.push(group.name);
  }
  return { groups, advice };
}

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
