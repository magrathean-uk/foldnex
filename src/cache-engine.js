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

  /**
   * Fetch all learned pattern rules from storage
   * @returns {Promise<Array<{ pattern: string, category: string, color: string, confidence: number, matchCount: number }>>}
   */
  static async getRules() {
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
  }

  /**
   * Reset all learned rules
   */
  static async resetRules() {
    await chrome.storage.local.remove(this.STORAGE_KEY);
  }
}
