/**
 * Foldnex - Cache & Fast Learning Engine
 * Provides instant 0ms local classification using learned URL pattern memory.
 */

import { CATEGORY_KEYS, GROUP_NAME_LIMIT, LABEL_VOCAB_VERSION, REVIEW_GROUP_NAME } from './label-vocabulary.js';

// Strict allowlist: Only retain non-sensitive semantic parameters relevant for grouping
const ALLOWED_SEMANTIC_PARAMS = new Set([
  'q', 'query', 'search', 'k', 'keyword', 'tab', 'view', 'cat', 'category', 'topic', 'id', 'p'
]);

// Sensitive parameter pattern guard as secondary defense
const SENSITIVE_PARAM_REGEX = /^(auth|token|access|session|code|key|secret|pass|cred|sig|jwt|bearer|user|email)/i;

const LEARNING_SCHEMA_KEY = 'foldnex_learning_schema_version';
const LEARNING_SCHEMA_VERSION = 2;
const LEGACY_RULES_BACKUP_KEY = 'foldnex_legacy_rules_backup';
const GROUP_PREFERENCES_KEY = 'foldnex_group_preferences_v2';
const EXACT_RESULTS_KEY = 'foldnex_exact_results_v1';
const EXACT_RESULT_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_EXACT_RESULTS = 12;
const MAX_GROUP_PREFERENCES = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
// Dev-only key from the unshipped TabAssignmentCache; removed, never read.
const LEGACY_TAB_ASSIGNMENTS_KEY = 'foldnex_tab_assignments_v1';
const TAB_LABELS_KEY = 'foldnex_tab_labels_v1';
const TAB_LABEL_TTL_MS = 7 * DAY_MS;
const MAX_TAB_LABELS = 3000;
const PLAN_MEMORY_KEY = 'foldnex_plan_memory_v1';
const PLAN_MEMORY_VERSION = 1;
const USER_NAME_TTL_MS = 90 * DAY_MS;
const MODEL_NAME_TTL_MS = 14 * DAY_MS;
const MAX_NAME_RECORDS = 120;
const MAX_ADVICE_PAIRS = 200;
const MAX_ADVICE_SCOPES = 12;
const MAX_NAME_TOKEN_HASHES = 8;
const MAX_NAME_FINGERPRINTS = 60;
const MAX_NAME_KEYS = 32;
const MAX_STORED_NAME_LENGTH = 40;
const MODEL_NAME_SOURCES = new Set(['cloud', 'nano']);
const RESET_EPOCH_KEY = 'foldnex_reset_epoch';
const WINDOW_PLAN_PREFIX = 'foldnex_window_plan_v1:';
const WINDOW_PLAN_VERSION = 1;
// Mirrors CHROME_GROUP_COLORS in ai-engine.js; importing it here would create an import cycle.
const CHROME_COLORS = new Set(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']);
const CATEGORY_KEY_SET = new Set(CATEGORY_KEYS);
export const MAX_RULE_PATTERN_LENGTH = 200;

/**
 * Read-modify-write caches share one chain in each extension context to stop
 * a slower writer from dropping a faster one's entries. The origin epoch also
 * keeps a queued pre-reset operation from writing as a new-generation result.
 */
let storageWriteChain = Promise.resolve();

function serializeWrite(task) {
  const run = storageWriteChain.then(task);
  storageWriteChain = run.catch(() => {});
  return run;
}

/** Let reads observe writes that were queued before them. */
function settledWrites() {
  return storageWriteChain;
}

/**
 * resetRules runs on the options page, whose module instance has its own write
 * chain, so it cannot wait for the service worker's writes. It bumps this epoch
 * instead. Every read-modify-write reads the epoch with its record and drops its
 * write when the epoch moved. Labels, plan memory, group preferences and exact
 * results and session window plans are stamped with the epoch (g), so a write
 * that still lands just after a reset reads as empty. Learned rules are a plain
 * array the options page writes directly, so they only get the check.
 */
function epochOf(value) {
  const epoch = Number(value);
  return Number.isSafeInteger(epoch) && epoch > 0 ? epoch : 0;
}

function resetEpochOf(data) {
  return epochOf(data?.[RESET_EPOCH_KEY]);
}

/** Capture the generation before asynchronous work whose results may be saved. */
export async function readResetEpoch() {
  return resetEpochOf(await chrome.storage.local.get(RESET_EPOCH_KEY));
}

function writeOrigin(options) {
  // Fingerprint maps and exact-cache contexts are reusable data, not proof of
  // when a model or Chrome operation began. Its caller supplies that epoch.
  const epoch = options?.epoch;
  return epoch === undefined ? readResetEpoch()
    : Promise.resolve(Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : NaN);
}

/** Write unless a reset landed after the caller read its record at `epoch`. */
async function setUnlessReset(epoch, values, area = chrome.storage.local) {
  if (await readResetEpoch() !== epoch) return false;
  await area.set(values);
  return true;
}

/**
 * Clean & sanitize URL to retain semantic paths while stripping noise, tokens & auth credentials.
 * @param {string} rawUrl
 * @returns {string}
 */
export function sanitizeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    const parsed = new URL(rawUrl);
    // Only process http/https
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return parsed.protocol.replace(':', '');
    }

    // Strip basic authentication credentials
    parsed.username = '';
    parsed.password = '';

    // Filter query parameters using strict allowlist
    const cleanParams = new URLSearchParams();
    for (const [k, v] of parsed.searchParams.entries()) {
      const lowerKey = k.toLowerCase();
      if (ALLOWED_SEMANTIC_PARAMS.has(lowerKey) && !SENSITIVE_PARAM_REGEX.test(lowerKey)) {
        // Keep non-sensitive query params but truncate values to avoid prompt bloat
        cleanParams.append(lowerKey, v.length > 40 ? v.slice(0, 40) + '…' : v);
      }
    }

    let host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    let pathname = parsed.pathname.replace(/\/+$/, ''); // strip trailing slashes
    if (pathname.length > 80) {
      pathname = pathname.slice(0, 80) + '…';
    }

    const queryStr = cleanParams.toString();
    return `${host}${pathname}${queryStr ? '?' + queryStr : ''}`;
  } catch {
    // Fallback: Strip user:pass, queries, hashes, and protocol
    return rawUrl
      .replace(/^https?:\/\//i, '')
      .replace(/^[^/@]+@/, '') // Remove user:pass@
      .replace(/[?#].*$/, '')  // Strip all query parameters and hash fragments
      .replace(/^www\./i, '')
      .slice(0, 80);
  }
}

/** Preserve a route-like hash path without retaining hash query values. */
export function sanitizeSemanticUrl(rawUrl) {
  const base = sanitizeUrl(rawUrl);
  try {
    const parsed = new URL(rawUrl);
    const fragment = parsed.hash.slice(1);
    if (fragment.startsWith('/') || fragment.startsWith('!')) {
      const route = fragment.split(/[?&=]/, 1)[0].slice(0, 80);
      return `${base}#${route}`;
    }
  } catch {
    // sanitizeUrl already supplied the conservative fallback.
  }
  return base;
}

/**
 * Build the URL input for an exact-result cache fingerprint. Preserve the
 * complete path so a late path change invalidates the cache, while excluding
 * credentials, unapproved query parameters, and fragment state before hashing.
 */
function exactCacheUrlInput(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    const parsed = new URL(rawUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) return sanitizeUrl(rawUrl);
    parsed.username = '';
    parsed.password = '';
    const cleanParams = new URLSearchParams();
    for (const [key, value] of parsed.searchParams) {
      const lowerKey = key.toLowerCase();
      if (ALLOWED_SEMANTIC_PARAMS.has(lowerKey) && !SENSITIVE_PARAM_REGEX.test(lowerKey)) {
        cleanParams.append(lowerKey, value);
      }
    }
    parsed.search = cleanParams.toString();
    parsed.hash = '';
    return parsed.href;
  } catch {
    return sanitizeUrl(rawUrl);
  }
}

/**
 * Trim title to remove redundant site names, boilerplate suffixes, and newlines.
 * @param {string} title
 * @returns {string}
 */
export function sanitizeTitle(title) {
  if (!title || typeof title !== 'string') return '';
  // Strip newlines, tabs, and carriage returns to prevent prompt injection breakouts
  let trimmed = title.replace(/[\r\n\t]+/g, ' ').trim();

  // ' – ' (en dash) is the suffix German Wikipedia uses.
  const suffixDelimiters = [' - ', ' | ', ' — ', ' – ', ' · ', ' • '];
  for (const delim of suffixDelimiters) {
    const idx = trimmed.lastIndexOf(delim);
    // If delimiter is in the last 40% of the title, trim off the brand suffix
    if (idx > 10 && idx >= trimmed.length * 0.4) {
      trimmed = trimmed.substring(0, idx).trim();
      break;
    }
  }

  return trimmed.length > 80 ? trimmed.slice(0, 80) + '…' : trimmed;
}

/**
 * Synchronous FNV-1a 32-bit hash over UTF-8 bytes, as 8 hex characters.
 * Used for stable local keys (task tokens, rule names); not a security boundary.
 * @param {string} str
 * @returns {string}
 */
export function hashToken(str) {
  const bytes = new TextEncoder().encode(String(str ?? ''));
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function normalizeCompleteTitle(title) {
  return String(title || '')
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000);
}

async function digestText(value) {
  if (globalThis.crypto?.subtle) {
    const bytes = new TextEncoder().encode(value);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  }

  // Deterministic fallback for restricted test/runtime contexts. This value is
  // only a local cache key, not a security boundary.
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv-${(hash >>> 0).toString(16)}`;
}

export async function fingerprintTab(tab) {
  return digestText(`${normalizeCompleteTitle(tab?.title)}\n${exactCacheUrlInput(tab?.url || tab?.pendingUrl || '')}`);
}

async function fingerprintTabs(tabs) {
  const fingerprints = await Promise.all((tabs || []).map(fingerprintTab));
  return (tabs || []).map((tab, index) => ({ tab, fingerprint: fingerprints[index] }));
}

async function buildGroupSignature(tabs) {
  const entries = await fingerprintTabs(tabs);
  return digestText(entries.map(entry => entry.fingerprint).sort().join('|'));
}

/**
 * Extract generalized pattern key from URL (e.g. "github.com/microsoft/vscode/*")
 * @param {string} rawUrl
 * @returns {string}
 */
export function extractPatternKey(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const segments = parsed.pathname.split('/').filter(Boolean);

    if (segments.length === 0) {
      return `${host}/*`;
    }

    // For code repos or multi-level apps (e.g. github.com/user/repo)
    if (['github.com', 'gitlab.com', 'bitbucket.org'].includes(host) && segments.length >= 2) {
      return `${host}/${segments[0]}/${segments[1]}/*`;
    }

    // Single segment prefix (e.g. docs.google.com/document, reddit.com/r/programming)
    if (segments.length >= 2 && ['reddit.com', 'medium.com'].includes(host)) {
      return `${host}/${segments[0]}/${segments[1]}/*`;
    }

    return `${host}/${segments[0]}/*`;
  } catch {
    return '';
  }
}

/**
 * Compile a case-insensitive wildcard matcher. Keep the historical helper
 * name and .test() interface, but never generate a backtracking expression.
 * Each literal segment is searched once, so separated '*' cannot cause an
 * exponential non-match. All punctuation other than '*' is literal.
 * @param {string} pattern
 * @returns {{test(value: string): boolean}|null}
 */
export function safeGlobToRegExp(pattern) {
  if (typeof pattern !== 'string') return null;
  const trimmed = pattern.trim();
  if (!trimmed || trimmed.length > MAX_RULE_PATTERN_LENGTH || /[\u0000-\u001F\u007F-\u009F]/u.test(pattern)
    || /[\s\u0000-\u001F\u007F-\u009F]/u.test(trimmed)) return null;
  const cleanPattern = foldRuleCase(trimmed.replace(/\*+/g, '*'));
  const segments = cleanPattern.split('*');
  return Object.freeze({
    test(value) {
      const input = foldRuleCase(String(value));
      if (segments.length === 1) return input === cleanPattern;
      // Match the old '.' wildcard's line-terminator behavior.
      if (/[\r\n\u2028\u2029]/u.test(input)) return false;
      const first = segments[0];
      if (!input.startsWith(first)) return false;
      let position = first.length;
      for (let index = 1; index < segments.length - 1; index++) {
        const found = input.indexOf(segments[index], position);
        if (found < 0) return false;
        position = found + segments[index].length;
      }
      const last = segments[segments.length - 1];
      return input.length - last.length >= position && input.endsWith(last);
    }
  });
}

/** Preserve the case folding of the previous non-Unicode /i matcher. */
function foldRuleCase(value) {
  return value.replace(/[a-z\u0080-\uFFFF]/g, char => {
    const upper = char.toUpperCase();
    // Expanding a character, or folding a non-ASCII character into ASCII,
    // would give it matches the previous regular expression did not allow.
    return upper.length !== 1 || (char.charCodeAt(0) >= 128 && upper.charCodeAt(0) < 128)
      ? char : upper;
  });
}

function isValidRule(rule) {
  return rule && typeof rule === 'object' && !Array.isArray(rule)
    && typeof rule.category === 'string' && rule.category.trim().length > 0
    && Boolean(safeGlobToRegExp(rule.pattern));
}

/**
 * Cache & Learning Storage Manager
 */
export class LearningCache {
  static STORAGE_KEY = 'foldnex_learned_rules';
  static MAX_RULES = 300;

  static async ensureSchema() {
    const data = await chrome.storage.local.get([LEARNING_SCHEMA_KEY, this.STORAGE_KEY, RESET_EPOCH_KEY]);
    if (Number(data[LEARNING_SCHEMA_KEY]) >= LEARNING_SCHEMA_VERSION) return;

    const legacyRules = Array.isArray(data[this.STORAGE_KEY]) ? data[this.STORAGE_KEY] : [];
    const changes = {
      [LEARNING_SCHEMA_KEY]: LEARNING_SCHEMA_VERSION,
      [this.STORAGE_KEY]: []
    };
    if (legacyRules.length > 0) {
      changes[LEGACY_RULES_BACKUP_KEY] = {
        migratedAt: Date.now(),
        rules: legacyRules
      };
    }
    await setUnlessReset(resetEpochOf(data), changes);
  }

  /**
   * Fetch all learned pattern rules from storage
   * @returns {Promise<Array<{ pattern: string, category: string, color: string, confidence: number, matchCount: number }>>}
   */
  static async getRules() {
    return (await this.readRules()).rules;
  }

  /** Rules plus the reset epoch they were read at, for read-modify-write. */
  static async readRules() {
    await this.ensureSchema();
    const data = await chrome.storage.local.get([this.STORAGE_KEY, RESET_EPOCH_KEY]);
    const stored = Array.isArray(data[this.STORAGE_KEY]) ? data[this.STORAGE_KEY] : [];
    return { rules: stored.filter(isValidRule), epoch: resetEpochOf(data) };
  }

  /**
   * Build in-memory domain index for O(1) candidate lookup
   */
  static buildDomainIndex(rules) {
    const domainMap = new Map();
    for (const rule of Array.isArray(rules) ? rules : []) {
      if (!isValidRule(rule)) continue;
      if ((rule.confidence ?? 1.0) < 0.6) continue;
      const pattern = rule.pattern.trim().replace(/\*+/g, '*');
      const host = pattern.split('/')[0].toLowerCase();
      if (!domainMap.has(host)) {
        domainMap.set(host, []);
      }
      const prefix = foldRuleCase(pattern.replace(/\/\*$/, ''));
      domainMap.get(host).push({
        ...rule,
        prefix,
        _regex: safeGlobToRegExp(pattern)
      });
    }
    return domainMap;
  }

  /**
   * Find matching rule for a tab using domain-indexed matching
   */
  static matchUrl(url, domainIndex) {
    if (!url || !domainIndex) return null;
    const sanitized = foldRuleCase(sanitizeUrl(url));

    try {
      const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
      const candidates = domainIndex.get(host);
      if (!candidates || candidates.length === 0) return null;

      // Check longest prefix match first (most specific rule wins)
      candidates.sort((a, b) => b.prefix.length - a.prefix.length);
      for (const rule of candidates) {
        if (sanitized === rule.prefix || sanitized.startsWith(rule.prefix + '/')) {
          return rule;
        }
        if (rule._regex && rule._regex.test(sanitized)) {
          return rule;
        }
      }
    } catch {
      // Ignored for non-standard URLs
    }
    return null;
  }

  /**
   * Categorize tabs against local learned rules in 0ms using indexed prefix matching.
   * Returns: { matchedGroups: Array, unmatched: Array }
   */
  static async classifyLocal(tabs) {
    const rules = await this.getRules();
    const domainIndex = this.buildDomainIndex(rules);
    const matchedGroups = new Map();
    const unmatched = [];

    for (const tab of tabs) {
      const match = this.matchUrl(tab.url, domainIndex);
      if (match) {
        if (!matchedGroups.has(match.category)) {
          matchedGroups.set(match.category, {
            name: match.category,
            color: match.color || 'blue',
            tabs: []
          });
        }
        matchedGroups.get(match.category).tabs.push(tab);
      } else {
        unmatched.push(tab);
      }
    }

    return { matchedGroups: Array.from(matchedGroups.values()), unmatched };
  }

  /**
   * Only explicitly authored URL rules may override a fresh semantic grouping.
   * AI observations and group renames are deliberately excluded.
   */
  static async classifyExplicit(tabs) {
    const rules = (await this.getRules()).filter(rule => rule.source === 'manual_rule');
    const domainIndex = this.buildDomainIndex(rules);
    const matchedGroups = new Map();
    const matchedTabIds = new Set();

    for (const tab of tabs || []) {
      const match = this.matchUrl(tab.url, domainIndex);
      if (!match) continue;
      if (!matchedGroups.has(match.category)) {
        matchedGroups.set(match.category, {
          name: match.category,
          color: match.color || 'blue',
          tabs: []
        });
      }
      matchedGroups.get(match.category).tabs.push(tab);
      matchedTabIds.add(tab.id);
    }

    return { matchedGroups: Array.from(matchedGroups.values()), matchedTabIds };
  }

  /**
   * Reinforce / learn from successful AI groupings
   */
  static async learnFromGroupings(groups, options) {
    const origin = await writeOrigin(options);
    await serializeWrite(async () => {
      const { rules: existingRules, epoch } = await this.readRules();
      if (epoch !== origin) return;
      const ruleMap = new Map(existingRules.map(r => [r.pattern.toLowerCase(), r]));

      for (const group of groups) {
        if (!group.tabs || group.tabs.length === 0) continue;

        // Group tabs by pattern key
        const patternCounts = new Map();
        for (const tab of group.tabs) {
          if (!tab.url) continue;
          const key = extractPatternKey(tab.url);
          if (key && safeGlobToRegExp(key)) {
            patternCounts.set(key, (patternCounts.get(key) || 0) + 1);
          }
        }

        for (const [pattern, count] of patternCounts.entries()) {
          const lowerKey = pattern.toLowerCase();
          const existing = ruleMap.get(lowerKey);
          if (existing) {
            if (existing.category.toLowerCase() === group.name.toLowerCase()) {
              existing.confidence = Math.min(1.0, (existing.confidence || 0.8) + 0.1);
              existing.matchCount = (existing.matchCount || 0) + count;
              existing.updatedAt = Date.now();
            }
          } else if (count >= 1) {
            // Learn new pattern
            ruleMap.set(lowerKey, {
              pattern,
              category: group.name,
              color: group.color || 'blue',
              confidence: 0.85,
              matchCount: count,
              source: 'ai_observation',
              schemaVersion: LEARNING_SCHEMA_VERSION,
              createdAt: Date.now(),
              updatedAt: Date.now()
            });
          }
        }
      }

      let ruleArray = Array.from(ruleMap.values());

      // Enforce Rule Cap with LRU / Confidence Pruning
      if (ruleArray.length > this.MAX_RULES) {
        ruleArray.sort((a, b) => {
          if (a.userOverride && !b.userOverride) return -1;
          if (!a.userOverride && b.userOverride) return 1;
          const scoreA = (a.confidence || 0) * 1000 + (a.updatedAt || 0);
          const scoreB = (b.confidence || 0) * 1000 + (b.updatedAt || 0);
          return scoreB - scoreA;
        });
        ruleArray = ruleArray.slice(0, this.MAX_RULES);
      }

      await setUnlessReset(epoch, {
        [this.STORAGE_KEY]: ruleArray
      });
    });
  }

  /**
   * Learn from explicit user correction in a single batched write
   */
  static async learnUserCorrections(urls, newCategory, color, options) {
    if (!urls || urls.length === 0 || !newCategory) return;
    const origin = await writeOrigin(options);
    await serializeWrite(async () => {
      const { rules: existingRules, epoch } = await this.readRules();
      if (epoch !== origin) return;
      const ruleMap = new Map(existingRules.map(r => [r.pattern.toLowerCase(), r]));
      let changed = false;

      for (const url of urls) {
        if (!url) continue;
        const pattern = extractPatternKey(url);
        if (!safeGlobToRegExp(pattern)) continue;

        const lowerKey = pattern.toLowerCase();
        ruleMap.set(lowerKey, {
          pattern,
          category: newCategory,
          color: color || 'blue',
          confidence: 1.0, // Explicit user preference gets max confidence
          matchCount: (ruleMap.get(lowerKey)?.matchCount || 0) + 1,
          userOverride: true,
          source: 'manual_rule',
          schemaVersion: LEARNING_SCHEMA_VERSION,
          updatedAt: Date.now()
        });
        changed = true;
      }

      if (changed) {
        let ruleArray = Array.from(ruleMap.values());
        if (ruleArray.length > this.MAX_RULES) {
          ruleArray = ruleArray.slice(0, this.MAX_RULES);
        }
        await setUnlessReset(epoch, {
          [this.STORAGE_KEY]: ruleArray
        });
      }
    });
  }

  static async learnUserCorrection(url, newCategory, color, options) {
    return this.learnUserCorrections([url], newCategory, color, options);
  }

  /**
   * Delete a rule
   */
  static async deleteRule(pattern, options) {
    if (typeof pattern !== 'string') return;
    const origin = await writeOrigin(options);
    await serializeWrite(async () => {
      const { rules, epoch } = await this.readRules();
      if (epoch !== origin) return;
      const filtered = rules.filter(r => r.pattern.toLowerCase() !== pattern.toLowerCase());
      if (!await setUnlessReset(epoch, { [this.STORAGE_KEY]: filtered })) return;
      if (await readResetEpoch() !== epoch) return;
      // Labels and plan memory do not depend on rules: rules are applied as
      // locked groups at plan time, so only whole cached results go stale.
      await chrome.storage.local.remove(EXACT_RESULTS_KEY);
    });
  }

  /**
   * Reset all learned rules
   */
  static async resetRules() {
    // Queued behind this context's pending writes. Writes queued in another
    // context see the new epoch and drop, or land stamped as pre-reset.
    await serializeWrite(async () => {
      const data = await chrome.storage.local.get(RESET_EPOCH_KEY);
      await chrome.storage.local.set({ [RESET_EPOCH_KEY]: resetEpochOf(data) + 1 });
      await chrome.storage.local.remove([
        this.STORAGE_KEY,
        GROUP_PREFERENCES_KEY,
        EXACT_RESULTS_KEY,
        TAB_LABELS_KEY,
        PLAN_MEMORY_KEY,
        LEGACY_TAB_ASSIGNMENTS_KEY,
        LEGACY_RULES_BACKUP_KEY
      ]);
      // Session plans keep their origin stamp; get() rejects them after this
      // epoch bump, including old writes that land after the reset completes.
    });
    await chrome.storage.local.set({ [LEARNING_SCHEMA_KEY]: LEARNING_SCHEMA_VERSION });
  }

  /**
   * Remember a user rename only for the exact semantic cohort they renamed.
   * This cannot turn one Slack channel or Gmail message into a domain-wide rule.
   */
  static async learnGroupRename(tabs, category, color, options) {
    if (!tabs?.length || !category) return;
    const origin = await writeOrigin(options);
    const signature = await buildGroupSignature(tabs);
    await serializeWrite(async () => {
      const { preferences, epoch } = await readGroupPreferences();
      if (epoch !== origin) return;
      const next = preferences.filter(pref => pref.signature !== signature);
      next.unshift({
        signature,
        category: String(category).slice(0, 40),
        color: color || 'blue',
        updatedAt: Date.now(),
        g: epoch
      });
      if (!await setUnlessReset(epoch, {
        [GROUP_PREFERENCES_KEY]: next.slice(0, MAX_GROUP_PREFERENCES)
      })) return;
      if (await readResetEpoch() !== epoch) return;
      await chrome.storage.local.remove(EXACT_RESULTS_KEY);
    });
  }

  static async applyGroupPreferences(groups, tabs) {
    const { preferences } = await readGroupPreferences();
    if (preferences.length === 0) return groups;

    const preferenceMap = new Map(preferences.map(pref => [pref.signature, pref]));
    const tabMap = new Map((tabs || []).map(tab => [tab.id, tab]));
    const resolved = [];
    for (const group of groups || []) {
      const groupTabs = (group.tabIds || []).map(id => tabMap.get(id)).filter(Boolean);
      const signature = await buildGroupSignature(groupTabs);
      const preference = preferenceMap.get(signature);
      resolved.push(preference
        ? { ...group, name: preference.category, color: preference.color || group.color }
        : group);
    }
    return resolved;
  }
}

/** Group preferences written since the last reset. */
async function readGroupPreferences() {
  const data = await chrome.storage.local.get([GROUP_PREFERENCES_KEY, RESET_EPOCH_KEY]);
  const epoch = resetEpochOf(data);
  const stored = Array.isArray(data[GROUP_PREFERENCES_KEY]) ? data[GROUP_PREFERENCES_KEY] : [];
  return { preferences: stored.filter(pref => epochOf(pref?.g) === epoch), epoch };
}

/** Exact results written since the last reset and still inside their TTL. */
async function readExactResults(now) {
  const data = await chrome.storage.local.get([EXACT_RESULTS_KEY, RESET_EPOCH_KEY]);
  const epoch = resetEpochOf(data);
  const stored = Array.isArray(data[EXACT_RESULTS_KEY]) ? data[EXACT_RESULTS_KEY] : [];
  const records = stored.filter(record =>
    epochOf(record?.g) === epoch && now - Number(record?.createdAt || 0) <= EXACT_RESULT_TTL_MS);
  return { records, epoch };
}

/**
 * Content-addressed reuse for an unchanged semantic tab set. Unlike learned URL
 * rules, a changed title or URL hint always produces a cache miss.
 */
export class ExactResultCache {
  static STORAGE_KEY = EXACT_RESULTS_KEY;

  static async makeContext(tabs, scope) {
    const entries = await fingerprintTabs(tabs);
    const signature = await digestText(`${scope}\n${entries.map(entry => entry.fingerprint).sort().join('|')}`);
    return { entries, signature, scope };
  }

  static async get(tabs, scope) {
    const context = await this.makeContext(tabs, scope);
    const { records } = await readExactResults(Date.now());
    const record = records.find(item => item.signature === context.signature && item.scope === scope);
    if (!record) return { groups: null, context };

    const idsByFingerprint = new Map();
    for (const entry of context.entries) {
      if (!idsByFingerprint.has(entry.fingerprint)) idsByFingerprint.set(entry.fingerprint, []);
      idsByFingerprint.get(entry.fingerprint).push(entry.tab.id);
    }

    const groups = [];
    const assigned = new Set();
    for (const cachedGroup of record.groups || []) {
      const { fingerprints = [] } = cachedGroup;
      const cachedDetails = { name: cachedGroup.name, color: cachedGroup.color, ...planGroupMetadata(cachedGroup) };
      const tabIds = [];
      for (const fingerprint of fingerprints) {
        const id = idsByFingerprint.get(fingerprint)?.shift();
        if (id !== undefined) {
          tabIds.push(id);
          assigned.add(id);
        }
      }
      if (tabIds.length > 0) groups.push({ ...cachedDetails, tabIds });
    }

    if (assigned.size !== tabs.length) return { groups: null, context };
    return { groups, context };
  }

  static async put(context, groups, options) {
    if (!context?.signature || !Array.isArray(groups)) return;
    const origin = await writeOrigin(options);
    const fingerprintById = new Map(context.entries.map(entry => [entry.tab.id, entry.fingerprint]));
    const cachedGroups = groups.map(group => ({
      name: group.name,
      color: group.color,
      ...planGroupMetadata(group),
      fingerprints: (group.tabIds || []).map(id => fingerprintById.get(id)).filter(Boolean)
    })).filter(group => group.fingerprints.length > 0);

    await serializeWrite(async () => {
      const { records: stored, epoch } = await readExactResults(Date.now());
      if (epoch !== origin) return;
      const records = stored.filter(record => record.signature !== context.signature);
      records.unshift({
        signature: context.signature,
        scope: context.scope,
        createdAt: Date.now(),
        g: epoch,
        groups: cachedGroups
      });
      await setUnlessReset(epoch, { [this.STORAGE_KEY]: records.slice(0, MAX_EXACT_RESULTS) });
    });
  }

  static async clear() {
    await chrome.storage.local.remove(this.STORAGE_KEY);
  }
}

/**
 * Fresh label entries with a known category key, keyed by tab fingerprint,
 * and the reset epoch they were read at.
 */
async function readLabelEntries(now) {
  const data = await chrome.storage.local.get([TAB_LABELS_KEY, RESET_EPOCH_KEY]);
  const epoch = resetEpochOf(data);
  const record = data[TAB_LABELS_KEY];
  const entries = new Map();
  // A vocabulary change makes every stored key meaningless, and a record
  // stamped before the last reset was cleared, so either reads as empty.
  if (!record || record.v !== LABEL_VOCAB_VERSION || epochOf(record.g) !== epoch
    || !record.entries || typeof record.entries !== 'object') {
    return { entries, epoch };
  }
  for (const [fingerprint, entry] of Object.entries(record.entries)) {
    if (entry && CATEGORY_KEY_SET.has(entry.c) && now - Number(entry.t || 0) <= TAB_LABEL_TTL_MS) {
      entries.set(fingerprint, entry);
    }
  }
  return { entries, epoch };
}

/**
 * Remembers model categories within a semantic engine scope. Separate scope
 * keys preserve an earlier engine's labels when another engine is selected
 * and prevent a late old request from overwriting a newer engine's result.
 */
export class TabLabelCache {
  static STORAGE_KEY = TAB_LABELS_KEY;

  /** Fresh entries as {[fingerprint]: {c, t, e}}. */
  static async read() {
    await settledWrites();
    return Object.fromEntries((await readLabelEntries(Date.now())).entries);
  }

  /**
   * Split tabs into cached labels and tabs that still need a model.
   * Runtime callers supply scope; legacy unscoped labels then miss. The
   * optional engine filter remains available for unscoped cache consumers.
   * @returns {Promise<{labels: Map<number, {c: string, e: string|null}>, missing: object[], fingerprintById: Map<number, string>}>}
   */
  static async lookup(tabs, { acceptEngines = null, scope = null } = {}) {
    const list = Array.isArray(tabs) ? tabs : [];
    const accepted = acceptEngines == null
      ? null
      : new Set(typeof acceptEngines === 'string' ? [acceptEngines] : acceptEngines);
    await settledWrites();
    // Incognito tabs get no fingerprint, so they can be neither read nor stored.
    const [{ entries }, fingerprints] = await Promise.all([
      readLabelEntries(Date.now()),
      Promise.all(list.map(tab => (tab?.incognito ? null : fingerprintTab(tab))))
    ]);
    const labels = new Map();
    const missing = [];
    const fingerprintById = new Map();
    list.forEach((tab, index) => {
      const fingerprint = fingerprints[index];
      if (fingerprint) fingerprintById.set(tab.id, fingerprint);
      const entry = fingerprint ? entries.get(labelEntryKey(fingerprint, scope)) : null;
      if (entry && (accepted === null || accepted.has(entry.e))) {
        labels.set(tab.id, { c: entry.c, e: entry.e ?? null });
      } else {
        missing.push(tab);
      }
    });
    return { labels, missing, fingerprintById };
  }

  /**
   * Store model labels only (never provisional or locally inferred ones).
   * @param {Map<number, string>} labelsById category key per tab ID
   * @param {Map<number, string>} fingerprintById from lookup()
   * @param {string} engine provider ID that produced the labels
   */
  static async store(labelsById, fingerprintById, engine, options) {
    if (!(labelsById instanceof Map) || !(fingerprintById instanceof Map)) return;
    const fresh = [];
    for (const [id, c] of labelsById) {
      const fingerprint = fingerprintById.get(id);
      if (fingerprint && CATEGORY_KEY_SET.has(c)) fresh.push([fingerprint, c]);
    }
    if (fresh.length === 0) return;
    const e = typeof engine === 'string' && engine ? engine : null;
    const origin = await writeOrigin(options);

    await serializeWrite(async () => {
      const now = Date.now();
      const { entries, epoch } = await readLabelEntries(now);
      if (epoch !== origin) return;
      for (const [fingerprint, c] of fresh) entries.set(labelEntryKey(fingerprint, options?.scope), { c, t: now, e });
      const kept = [...entries]
        .sort((a, b) => Number(b[1].t) - Number(a[1].t))
        .slice(0, MAX_TAB_LABELS);
      await setUnlessReset(epoch, {
        [TAB_LABELS_KEY]: { v: LABEL_VOCAB_VERSION, g: epoch, entries: Object.fromEntries(kept) }
      });
    });
  }

  static async clear() {
    await serializeWrite(() => chrome.storage.local.remove(TAB_LABELS_KEY));
  }
}

function semanticScope(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : null;
}

function labelEntryKey(fingerprint, scope) {
  const selected = semanticScope(scope);
  return selected ? `${selected}:${fingerprint}` : fingerprint;
}

const TOKEN_HASH_PATTERN = /^[0-9a-f]{8}$/;

function toList(values) {
  return Array.isArray(values) || values instanceof Set ? [...values] : [];
}

function isPlanKey(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 64;
}

function uniqueStrings(values, limit, accept) {
  const out = [];
  for (const value of toList(values)) {
    if (out.length >= limit) break;
    if (typeof value === 'string' && value && accept(value) && !out.includes(value)) out.push(value);
  }
  return out;
}

/** Sorted, de-duplicated candidate keys. */
function planKeyList(values, limit = Infinity) {
  return [...new Set(toList(values).filter(isPlanKey))].sort().slice(0, limit);
}

/** Only semantic identifiers and provenance, never title/URL/token payloads. */
function planGroupMetadata(group) {
  const metadata = {};
  if (isPlanKey(group?.key)) metadata.key = group.key;
  if (Array.isArray(group?.keys) || group?.keys instanceof Set) metadata.keys = planKeyList(group.keys, MAX_NAME_KEYS);
  if (Array.isArray(group?.categories) || group?.categories instanceof Set) {
    const categories = new Set(group.categories);
    metadata.categories = CATEGORY_KEYS.filter(key => categories.has(key));
  }
  if (group?.dominant !== undefined) metadata.dominant = CATEGORY_KEY_SET.has(group.dominant) ? group.dominant : null;
  if (group?.kind !== undefined) metadata.kind = ['task', 'category', 'folder', 'site', 'split', 'rule', 'social', 'review'].includes(group.kind) ? group.kind : null;
  if (typeof group?.locked === 'boolean') metadata.locked = group.locked;
  if (['deterministic', 'model', 'memory-model', 'memory-user', 'user'].includes(group?.nameSource)) metadata.nameSource = group.nameSource;
  return metadata;
}

const TRAILING_JOINERS = /[\s&·|:;,/+\-\u2013\u2014\u200D]+$/u;

/**
 * A user's own group name as it is stored and re-applied: control characters
 * and runs of spaces collapsed, cut to GROUP_NAME_LIMIT before a word that
 * would not fit. Generic words, punctuation and emoji are the user's choice and
 * stay. Returns '' for an empty name or the reserved Review Later name, so
 * nothing is stored that would never be applied.
 */
export function normalizeUserGroupName(raw) {
  if (typeof raw !== 'string') return '';
  const name = raw
    .normalize('NFC')
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...name];
  let clamped = name;
  if (chars.length > GROUP_NAME_LIMIT) {
    const head = chars.slice(0, GROUP_NAME_LIMIT).join('');
    // Drop the partial last word; a single long word is cut where it is.
    const atWord = chars[GROUP_NAME_LIMIT] === ' ' ? head : head.replace(/\s\S*$/u, '');
    clamped = atWord.replace(TRAILING_JOINERS, '').trim() || head.trim();
  }
  if (clamped.toLocaleLowerCase() === REVIEW_GROUP_NAME.toLocaleLowerCase()) return '';
  return clamped;
}

function normalizeStoredName(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_STORED_NAME_LENGTH)
    .trim();
}

/**
 * Shape a name record for storage. Token hashes must look like hashToken
 * output and fingerprints are kept for user records only, so no title word
 * can reach the store.
 */
function normalizeNameRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const user = raw.s === 'user';
  const n = user ? normalizeUserGroupName(raw.n) : normalizeStoredName(raw.n);
  if (!n) return null;
  const record = {
    k: planKeyList(raw.k, MAX_NAME_KEYS),
    w: uniqueStrings(raw.w, MAX_NAME_TOKEN_HASHES, value => TOKEN_HASH_PATTERN.test(value)),
    f: user ? uniqueStrings(raw.f, MAX_NAME_FINGERPRINTS, value => value.length <= 80) : [],
    n,
    c: CHROME_COLORS.has(raw.c) ? raw.c : null,
    s: user ? 'user' : (MODEL_NAME_SOURCES.has(raw.s) ? raw.s : 'cloud'),
    t: Number(raw.t) || 0
  };
  const scope = user ? null : semanticScope(raw.p);
  if (scope) record.p = scope;
  return record;
}

function isFreshNameRecord(record, now) {
  return now - record.t <= (record.s === 'user' ? USER_NAME_TTL_MS : MODEL_NAME_TTL_MS);
}

function setJaccard(a, b) {
  if (a.length === 0 && b.length === 0) return 1;
  const other = new Set(b);
  const shared = a.filter(value => other.has(value)).length;
  return shared / (a.length + b.length - shared);
}

/** A newer model name for the same group replaces the older one. */
function sameModelGroup(a, b) {
  return a.p === b.p && a.k.join('|') === b.k.join('|') && setJaccard(a.w, b.w) >= 0.5;
}

/** A newer rename of the same tabs replaces the older one (the transfer rule's 50% overlap). */
function sameUserCohort(a, b) {
  if (a.f.length === 0 || b.f.length === 0) return false;
  const other = new Set(b.f);
  const shared = a.f.filter(fingerprint => other.has(fingerprint)).length;
  return shared >= 0.5 * Math.min(a.f.length, b.f.length);
}

/**
 * Newest first. Past the cap, model names go before user renames: renames are
 * explicit choices, rarer, and cannot be regenerated by a model call.
 */
function capNameRecords(records) {
  const sorted = [...records].sort((a, b) => b.t - a.t);
  if (sorted.length <= MAX_NAME_RECORDS) return sorted;
  const users = sorted.filter(record => record.s === 'user').slice(0, MAX_NAME_RECORDS);
  const models = sorted.filter(record => record.s !== 'user').slice(0, MAX_NAME_RECORDS - users.length);
  return [...users, ...models].sort((a, b) => b.t - a.t);
}

function adviceEntries(pairs) {
  let list = [];
  if (pairs instanceof Map || Array.isArray(pairs)) list = [...pairs];
  else if (pairs && typeof pairs === 'object') list = Object.entries(pairs);
  const entries = new Map();
  for (const pair of list) {
    const [candidate, anchor] = Array.isArray(pair) ? pair : [];
    if (isPlanKey(candidate) && isPlanKey(anchor)) entries.set(candidate, anchor);
  }
  return entries;
}

function emptyPlanMemory() {
  return { v: PLAN_MEMORY_VERSION, names: [], advice: { cloud: {}, t: 0 } };
}

/** Plan memory and the reset epoch it was read at. */
async function readPlanMemoryState(now) {
  const data = await chrome.storage.local.get([PLAN_MEMORY_KEY, RESET_EPOCH_KEY]);
  const epoch = resetEpochOf(data);
  return { memory: parsePlanMemory(data[PLAN_MEMORY_KEY], epoch, now), epoch };
}

function parsePlanMemory(record, epoch, now) {
  if (!record || record.v !== PLAN_MEMORY_VERSION || epochOf(record.g) !== epoch) return emptyPlanMemory();
  const names = (Array.isArray(record.names) ? record.names : [])
    .map(normalizeNameRecord)
    .filter(item => item && isFreshNameRecord(item, now))
    .sort((a, b) => b.t - a.t);
  return { v: PLAN_MEMORY_VERSION, names, advice: normalizeAdvice(record.advice, now) };
}

/** Bound advice across all scopes and expire model decisions with names. */
function normalizeAdvice(raw, now) {
  const legacy = { cloud: {}, t: Number(raw?.t) || 0 };
  const buckets = [];
  if (now - legacy.t <= MODEL_NAME_TTL_MS) buckets.push({ scope: null, ...legacy, entries: adviceEntries(raw?.cloud) });
  for (const [scope, bucket] of Object.entries(raw?.scopes || {})) {
    const t = Number(bucket?.t) || 0;
    if (!semanticScope(scope) || now - t > MODEL_NAME_TTL_MS) continue;
    buckets.push({ scope, t, entries: adviceEntries(bucket?.cloud) });
  }
  buckets.sort((a, b) => b.t - a.t);
  let remaining = MAX_ADVICE_PAIRS;
  const scopes = {};
  for (const bucket of buckets) {
    if (remaining === 0) break;
    if (bucket.scope && Object.keys(scopes).length >= MAX_ADVICE_SCOPES) continue;
    const pairs = [...bucket.entries].slice(0, remaining);
    remaining -= pairs.length;
    if (pairs.length === 0) continue;
    const value = { cloud: Object.fromEntries(pairs), t: bucket.t };
    if (bucket.scope) scopes[bucket.scope] = value;
    else Object.assign(legacy, value);
  }
  if (Object.keys(scopes).length > 0) legacy.scopes = scopes;
  return legacy;
}

async function writePlanMemory(memory, epoch) {
  await setUnlessReset(epoch, {
    [PLAN_MEMORY_KEY]: { v: PLAN_MEMORY_VERSION, g: epoch, names: memory.names, advice: memory.advice }
  });
}

/**
 * Group names and cloud merge advice, keyed by candidate keys and token
 * hashes. Stores no title words or URLs. User renames (s: 'user') carry tab
 * fingerprints and are kept 90 days; model names are kept 14 days.
 */
export class PlanMemory {
  static STORAGE_KEY = PLAN_MEMORY_KEY;

  /** @returns {Promise<{v: number, names: object[], advice: {cloud: Object<string, string>, t: number}}>} */
  static async read({ scope = null } = {}) {
    await settledWrites();
    const memory = (await readPlanMemoryState(Date.now())).memory;
    const selected = semanticScope(scope);
    if (!selected) return memory;
    return {
      ...memory,
      names: memory.names.filter(record => record.s === 'user' || record.p === selected),
      advice: memory.advice.scopes?.[selected] || { cloud: {}, t: 0 }
    };
  }

  /**
   * Remember model names ({k, w, n, c, s: 'cloud' | 'nano'}). User renames go
   * through recordUserRename instead, so any other source is stored as 'cloud'.
   */
  static async putNames(records, options) {
    const now = Date.now();
    const incoming = toList(records)
      .map(record => normalizeNameRecord({
        ...record,
        p: semanticScope(options?.scope) || record?.p,
        s: MODEL_NAME_SOURCES.has(record?.s) ? record.s : 'cloud',
        t: now
      }))
      .filter(Boolean);
    if (incoming.length === 0) return;
    const origin = await writeOrigin(options);

    await serializeWrite(async () => {
      const { memory, epoch } = await readPlanMemoryState(now);
      if (epoch !== origin) return;
      let names = memory.names;
      for (const record of incoming) {
        names = names.filter(old => old.s === 'user' || !sameModelGroup(old, record));
        names.unshift(record);
      }
      memory.names = capNameRecords(names);
      await writePlanMemory(memory, epoch);
    });
  }

  /**
   * Merge cloud consolidation advice {candidateKey: anchorKey} (a Map, an
   * object or [candidate, anchor] pairs). Newer advice wins, a newer pair in
   * the opposite direction retires the old one, and a self-pair clears the
   * candidate's stored advice.
   */
  static async putAdvice(pairs, options) {
    const incoming = adviceEntries(pairs);
    if (incoming.size === 0) return;
    const origin = await writeOrigin(options);

    await serializeWrite(async () => {
      const now = Date.now();
      const { memory, epoch } = await readPlanMemoryState(now);
      if (epoch !== origin) return;
      const next = new Map();
      for (const [candidate, anchor] of incoming) {
        if (candidate !== anchor) next.set(candidate, anchor);
      }
      const scope = semanticScope(options?.scope);
      const previous = scope ? memory.advice.scopes?.[scope] : memory.advice;
      for (const [candidate, anchor] of Object.entries(previous?.cloud || {})) {
        if (incoming.has(candidate) || next.get(anchor) === candidate) continue;
        next.set(candidate, anchor);
      }
      const updated = { cloud: Object.fromEntries([...next].slice(0, MAX_ADVICE_PAIRS)), t: now };
      memory.advice = normalizeAdvice(scope
        ? { ...memory.advice, scopes: { ...memory.advice.scopes, [scope]: updated } }
        : { ...updated, ...(memory.advice.scopes ? { scopes: memory.advice.scopes } : {}) }, now);
      await writePlanMemory(memory, epoch);
    });
  }

  /**
   * Remember a user rename for the tabs it covered. The record matches a later
   * group whose fingerprints overlap it by at least half of the smaller set.
   */
  static async recordUserRename({ tabs, name, color, keys } = {}, options) {
    const list = Array.isArray(tabs) ? tabs.filter(Boolean) : [];
    // Nothing from an incognito window is remembered.
    if (list.length === 0 || list.some(tab => tab.incognito)) return;
    const origin = await writeOrigin(options);
    const fingerprints = await Promise.all(list.map(fingerprintTab));
    const record = normalizeNameRecord({
      k: keys,
      w: [],
      f: fingerprints,
      n: name,
      c: color,
      s: 'user',
      t: Date.now()
    });
    if (!record || record.f.length === 0) return;

    await serializeWrite(async () => {
      const { memory, epoch } = await readPlanMemoryState(record.t);
      if (epoch !== origin) return;
      const names = memory.names.filter(old => old.s !== 'user' || !sameUserCohort(old, record));
      names.unshift(record);
      memory.names = capNameRecords(names);
      await writePlanMemory(memory, epoch);
    });
  }

  static async clear() {
    await serializeWrite(() => chrome.storage.local.remove(PLAN_MEMORY_KEY));
  }
}

function sessionArea() {
  return globalThis.chrome?.storage?.session || null;
}

function toWindowId(windowId) {
  const id = Number(windowId);
  return Number.isInteger(id) && id >= 0 ? id : null;
}

/**
 * The latest plan for each window, in storage.session: tab IDs, names and
 * semantic metadata only, cleared when the browser restarts. Used by auto-grouping, by the
 * rename key lookup and by the background refresh signature check.
 */
export class WindowPlanStore {
  static KEY_PREFIX = WINDOW_PLAN_PREFIX;

  static keyFor(windowId) {
    return `${WINDOW_PLAN_PREFIX}${windowId}`;
  }

  /** @returns {Promise<{v: number, g: number, windowId: number, updatedAt: number, K: number|null, signature: string, groups: object[]}|null>} */
  static async get(windowId) {
    const area = sessionArea();
    const id = toWindowId(windowId);
    if (!area || id === null) return null;
    await settledWrites();
    const key = this.keyFor(id);
    const record = (await area.get(key))[key];
    const epoch = await readResetEpoch();
    if (!record || record.v !== WINDOW_PLAN_VERSION || epochOf(record.g) !== epoch
      || record.windowId !== id || !Array.isArray(record.groups)) {
      return null;
    }
    return record;
  }

  static async put(windowId, plan, options) {
    const area = sessionArea();
    const id = toWindowId(windowId);
    if (!area || id === null || !Array.isArray(plan?.groups)) return;
    const origin = await writeOrigin(options);
    const record = {
      v: WINDOW_PLAN_VERSION,
      g: origin,
      windowId: id,
      updatedAt: Date.now(),
      K: Number.isFinite(plan.K) ? plan.K : null,
      signature: typeof plan.signature === 'string' ? plan.signature : '',
      // Copy only the listed fields so no title, URL or token rides along.
      groups: plan.groups.map(group => ({
        name: typeof group?.name === 'string' ? group.name : '',
        color: CHROME_COLORS.has(group?.color) ? group.color : null,
        ...planGroupMetadata(group),
        keys: planKeyList(group?.keys, MAX_NAME_KEYS),
        tabIds: toList(group?.tabIds).filter(Number.isInteger),
        dominant: CATEGORY_KEY_SET.has(group?.dominant) ? group.dominant : null,
        kind: planGroupMetadata(group).kind || null
      }))
    };
    await serializeWrite(async () => {
      if (await readResetEpoch() !== origin) return;
      await setUnlessReset(origin, { [this.keyFor(id)]: record }, area);
    });
  }

  static async remove(windowId) {
    const area = sessionArea();
    const id = toWindowId(windowId);
    if (!area || id === null) return;
    await area.remove(this.keyFor(id));
  }
}

export const CACHE_SCHEMA = Object.freeze({
  version: LEARNING_SCHEMA_VERSION,
  learningSchemaKey: LEARNING_SCHEMA_KEY,
  legacyBackupKey: LEGACY_RULES_BACKUP_KEY,
  groupPreferencesKey: GROUP_PREFERENCES_KEY
});
