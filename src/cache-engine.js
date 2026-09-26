/**
 * Foldnex - Cache & Fast Learning Engine
 * Provides instant 0ms local classification using learned URL pattern memory.
 */

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

  const suffixDelimiters = [' - ', ' | ', ' — ', ' · ', ' • '];
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
 * Safely convert a wildcard glob pattern to a ReDoS-safe RegExp
 * @param {string} pattern
 * @returns {RegExp|null}
 */
export function safeGlobToRegExp(pattern) {
  if (!pattern || typeof pattern !== 'string') return null;
  try {
    // Collapse multiple consecutive asterisks into a single wildcard
    const cleanPattern = pattern.trim().replace(/\*+/g, '*');
    // Escape all regex special characters except asterisk
    const escaped = cleanPattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    // Convert '*' to non-greedy '.*?' to prevent exponential backtracking
    const regexSource = '^' + escaped.replace(/\*/g, '.*?') + '$';
    return new RegExp(regexSource, 'i');
  } catch (err) {
    console.warn('[Foldnex] Invalid rule pattern regex:', pattern, err);
    return null;
  }
}

/**
 * Cache & Learning Storage Manager
 */
export class LearningCache {
  static STORAGE_KEY = 'foldnex_learned_rules';
  static MAX_RULES = 300;

  static async ensureSchema() {
    const data = await chrome.storage.local.get([LEARNING_SCHEMA_KEY, this.STORAGE_KEY]);
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
    await chrome.storage.local.set(changes);
  }

  /**
   * Fetch all learned pattern rules from storage
   * @returns {Promise<Array<{ pattern: string, category: string, color: string, confidence: number, matchCount: number }>>}
   */
  static async getRules() {
    await this.ensureSchema();
    const data = await chrome.storage.local.get(this.STORAGE_KEY);
    return data[this.STORAGE_KEY] || [];
  }

  /**
   * Build in-memory domain index for O(1) candidate lookup
   */
  static buildDomainIndex(rules) {
    const domainMap = new Map();
    for (const rule of rules) {
      if ((rule.confidence ?? 1.0) < 0.6) continue;
      const host = rule.pattern.split('/')[0].toLowerCase();
      if (!domainMap.has(host)) {
        domainMap.set(host, []);
      }
      const prefix = rule.pattern.replace(/\/\*$/, '');
      domainMap.get(host).push({
        ...rule,
        prefix,
        _regex: rule._regex || safeGlobToRegExp(rule.pattern)
      });
    }
    return domainMap;
  }

  /**
   * Find matching rule for a tab using domain-indexed matching
   */
  static matchUrl(url, domainIndex) {
    if (!url || !domainIndex) return null;
    const sanitized = sanitizeUrl(url);

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
  static async learnFromGroupings(groups) {
    const existingRules = await this.getRules();
    const ruleMap = new Map(existingRules.map(r => [r.pattern.toLowerCase(), r]));

    for (const group of groups) {
      if (!group.tabs || group.tabs.length === 0) continue;

      // Group tabs by pattern key
      const patternCounts = new Map();
      for (const tab of group.tabs) {
        if (!tab.url) continue;
        const key = extractPatternKey(tab.url);
        if (key) {
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

    await chrome.storage.local.set({
      [this.STORAGE_KEY]: ruleArray
    });
  }

  /**
   * Learn from explicit user correction in a single batched write
   */
  static async learnUserCorrections(urls, newCategory, color) {
    if (!urls || urls.length === 0 || !newCategory) return;

    const existingRules = await this.getRules();
    const ruleMap = new Map(existingRules.map(r => [r.pattern.toLowerCase(), r]));
    let changed = false;

    for (const url of urls) {
      if (!url) continue;
      const pattern = extractPatternKey(url);
      if (!pattern) continue;

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
      await chrome.storage.local.set({
        [this.STORAGE_KEY]: ruleArray
      });
    }
  }

  static async learnUserCorrection(url, newCategory, color) {
    return this.learnUserCorrections([url], newCategory, color);
  }

  /**
   * Delete a rule
   */
  static async deleteRule(pattern) {
    const rules = await this.getRules();
    const filtered = rules.filter(r => r.pattern.toLowerCase() !== pattern.toLowerCase());
    await chrome.storage.local.set({ [this.STORAGE_KEY]: filtered });
    await ExactResultCache.clear();
  }

  /**
   * Reset all learned rules
   */
  static async resetRules() {
    await chrome.storage.local.remove([
      this.STORAGE_KEY,
      GROUP_PREFERENCES_KEY,
      EXACT_RESULTS_KEY,
      LEGACY_RULES_BACKUP_KEY
    ]);
    await chrome.storage.local.set({ [LEARNING_SCHEMA_KEY]: LEARNING_SCHEMA_VERSION });
  }

  /**
   * Remember a user rename only for the exact semantic cohort they renamed.
   * This cannot turn one Slack channel or Gmail message into a domain-wide rule.
   */
  static async learnGroupRename(tabs, category, color) {
    if (!tabs?.length || !category) return;
    const signature = await buildGroupSignature(tabs);
    const data = await chrome.storage.local.get(GROUP_PREFERENCES_KEY);
    const preferences = Array.isArray(data[GROUP_PREFERENCES_KEY]) ? data[GROUP_PREFERENCES_KEY] : [];
    const next = preferences.filter(pref => pref.signature !== signature);
    next.unshift({
      signature,
      category: String(category).slice(0, 40),
      color: color || 'blue',
      updatedAt: Date.now()
    });
    await chrome.storage.local.set({
      [GROUP_PREFERENCES_KEY]: next.slice(0, MAX_GROUP_PREFERENCES)
    });
    await chrome.storage.local.remove(EXACT_RESULTS_KEY);
  }

  static async applyGroupPreferences(groups, tabs) {
    const data = await chrome.storage.local.get(GROUP_PREFERENCES_KEY);
    const preferences = Array.isArray(data[GROUP_PREFERENCES_KEY]) ? data[GROUP_PREFERENCES_KEY] : [];
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
    const data = await chrome.storage.local.get(this.STORAGE_KEY);
    const now = Date.now();
    const records = (Array.isArray(data[this.STORAGE_KEY]) ? data[this.STORAGE_KEY] : [])
      .filter(record => now - Number(record.createdAt || 0) <= EXACT_RESULT_TTL_MS);
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
      const { fingerprints = [], ...cachedDetails } = cachedGroup;
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

  static async put(context, groups) {
    if (!context?.signature || !Array.isArray(groups)) return;
    const fingerprintById = new Map(context.entries.map(entry => [entry.tab.id, entry.fingerprint]));
    const cachedGroups = groups.map(group => ({
      name: group.name,
      color: group.color,
      fingerprints: (group.tabIds || []).map(id => fingerprintById.get(id)).filter(Boolean)
    })).filter(group => group.fingerprints.length > 0);

    const data = await chrome.storage.local.get(this.STORAGE_KEY);
    const records = (Array.isArray(data[this.STORAGE_KEY]) ? data[this.STORAGE_KEY] : [])
      .filter(record => record.signature !== context.signature && Date.now() - Number(record.createdAt || 0) <= EXACT_RESULT_TTL_MS);
    records.unshift({
      signature: context.signature,
      scope: context.scope,
      createdAt: Date.now(),
      groups: cachedGroups
    });
    await chrome.storage.local.set({ [this.STORAGE_KEY]: records.slice(0, MAX_EXACT_RESULTS) });
  }

  static async clear() {
    await chrome.storage.local.remove(this.STORAGE_KEY);
  }
}

export const CACHE_SCHEMA = Object.freeze({
  version: LEARNING_SCHEMA_VERSION,
  learningSchemaKey: LEARNING_SCHEMA_KEY,
  legacyBackupKey: LEGACY_RULES_BACKUP_KEY,
  groupPreferencesKey: GROUP_PREFERENCES_KEY
});
