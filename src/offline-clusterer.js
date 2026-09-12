/**
 * Foldnex - Offline Smart Clusterer (Zero-AI Fallback Engine)
 * 100% on-device, zero-network, zero-AI clustering.
 * Used when corporate policy blocks AI (Gemini Nano, Cloud APIs), offline, or by user preference.
 */

import { sanitizeUrl, sanitizeTitle } from './cache-engine.js';
import { CHROME_GROUP_COLORS } from './ai-engine.js';

// Common stop words to exclude from keyword extraction
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'he',
  'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'to', 'was', 'were',
  'will', 'with', 'you', 'your', 'this', 'about', 'into', 'over', 'after',
  'home', 'page', 'app', 'login', 'dashboard', 'official', 'site', 'new',
  'free', 'online', 'view', 'web', 'com', 'org', 'net', 'io'
]);

/**
 * Known structural patterns and domain categorizations
 */
function identifyKnownService(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const pathname = parsed.pathname;

    // GitHub / GitLab / Bitbucket
    if (host === 'github.com' || host === 'gitlab.com') {
      const parts = pathname.split('/').filter(Boolean);
      if (parts.length >= 2) {
        return { category: `Git: ${parts[1]}`, color: 'cyan', priority: 9 };
      }
      return { category: 'Dev & Code', color: 'cyan', priority: 7 };
    }

    // Google Workspace
    if (host.includes('docs.google.com')) {
      return { category: 'Google Workspace', color: 'blue', priority: 8 };
    }

    // Work / Project Management
    if (host.includes('jira.') || host.includes('atlassian.net') || host.includes('linear.app') || host.includes('asana.com') || host.includes('trello.com')) {
      return { category: 'Project Tasks', color: 'blue', priority: 8 };
    }

    // Design
    if (host.includes('figma.com') || host.includes('canva.com') || host.includes('dribbble.com')) {
      return { category: 'Design', color: 'purple', priority: 8 };
    }

    // Communication / Social
    if (host.includes('slack.com') || host.includes('discord.com') || host.includes('teams.microsoft.com')) {
      return { category: 'Communication', color: 'purple', priority: 8 };
    }
    if (['twitter.com', 'x.com', 'reddit.com', 'linkedin.com'].includes(host)) {
      return { category: 'Social & Feed', color: 'orange', priority: 7 };
    }

    // Media & Video
    if (['youtube.com', 'netflix.com', 'spotify.com', 'twitch.tv'].includes(host)) {
      return { category: 'Media & Video', color: 'pink', priority: 7 };
    }

    // Shopping
    if (['amazon.com', 'ebay.com', 'etsy.com', 'walmart.com'].includes(host)) {
      return { category: 'Shopping', color: 'orange', priority: 7 };
    }

    // Dev Documentation
    if (['stackoverflow.com', 'developer.mozilla.org', 'dev.to', 'npm.im', 'npmjs.com'].includes(host)) {
      return { category: 'Dev & Reference', color: 'cyan', priority: 7 };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Extract candidate semantic keywords from a tab's title & URL path
 */
function extractTabKeywords(tab) {
  const cleanTitle = sanitizeTitle(tab.title).toLowerCase();
  const cleanUrl = sanitizeUrl(tab.url).toLowerCase();

  // Tokenize words
  const words = `${cleanTitle} ${cleanUrl}`
    .replace(/[^a-z0-9_-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));

  return new Set(words);
}

/**
 * Cluster tabs without AI using pure local heuristics & TF-IDF keyword overlap.
 * @param {Array<chrome.tabs.Tab>} tabs
 * @returns {Array<{ name: string, color: string, tabIds: number[] }>}
 */
export function clusterTabsOffline(tabs) {
  if (!tabs || tabs.length === 0) return [];

  const tabAssigned = new Map(); // tabId -> groupName
  const groupBuckets = new Map(); // groupName -> { color: string, tabIds: number[] }

  function addToGroup(name, color, tabId) {
    if (tabAssigned.has(tabId)) return;
    if (!groupBuckets.has(name)) {
      groupBuckets.set(name, { color, tabIds: [] });
    }
    groupBuckets.get(name).tabIds.push(tabId);
    tabAssigned.set(tabId, name);
  }

  // Pass 1: Identify well-known services & subpaths with singleton protection
  const serviceBuckets = new Map();
  for (const tab of tabs) {
    const service = identifyKnownService(tab.url);
    if (service) {
      if (!serviceBuckets.has(service.category)) {
        serviceBuckets.set(service.category, { color: service.color, tabs: [] });
      }
      serviceBuckets.get(service.category).tabs.push(tab);
    }
  }

  // Only create groups for services with at least 2 tabs (or if total tabs <= 3)
  for (const [category, data] of serviceBuckets.entries()) {
    if (data.tabs.length >= 2 || tabs.length <= 3) {
      for (const t of data.tabs) {
        addToGroup(category, data.color, t.id);
      }
    }
  }

  // Pass 2: Keyword co-occurrence for remaining unassigned tabs
  const unassignedTabs = tabs.filter(t => !tabAssigned.has(t.id));
  const tabKeywordMap = new Map();
  const keywordFreq = new Map();

  for (const tab of unassignedTabs) {
    const keywords = extractTabKeywords(tab);
    tabKeywordMap.set(tab.id, keywords);
    for (const kw of keywords) {
      keywordFreq.set(kw, (keywordFreq.get(kw) || 0) + 1);
    }
  }

  // Sort candidate cluster keywords by frequency (minimum 2 tabs sharing the keyword)
  const sharedKeywords = Array.from(keywordFreq.entries())
    .filter(([_, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1]);

  for (const [kw] of sharedKeywords) {
    const matchingTabs = unassignedTabs.filter(t => !tabAssigned.has(t.id) && tabKeywordMap.get(t.id)?.has(kw));
    if (matchingTabs.length >= 2) {
      const groupName = kw.charAt(0).toUpperCase() + kw.slice(1);
      const colorIndex = groupBuckets.size % CHROME_GROUP_COLORS.length;
      const color = CHROME_GROUP_COLORS[colorIndex];

      for (const t of matchingTabs) {
        addToGroup(groupName, color, t.id);
      }
    }
  }

  // Pass 3: Domain fallback for remaining unassigned tabs (with subdomain cleaning)
  const stillUnassigned = tabs.filter(t => !tabAssigned.has(t.id));
  const domainGroups = new Map();

  for (const tab of stillUnassigned) {
    try {
      let host = new URL(tab.url).hostname.replace(/^www\./, '');
      const parts = host.split('.');
      if (parts.length > 2 && ['api', 'app', 'dev', 'm', 'docs'].includes(parts[0])) {
        host = parts.slice(1).join('.');
      }
      if (!domainGroups.has(host)) {
        domainGroups.set(host, []);
      }
      domainGroups.get(host).push(tab);
    } catch {
      // Ignored
    }
  }

  for (const [domain, dTabs] of domainGroups.entries()) {
    if (dTabs.length >= 2) {
      const cleanName = domain.split('.')[0];
      const groupName = cleanName.charAt(0).toUpperCase() + cleanName.slice(1);
      const colorIndex = groupBuckets.size % CHROME_GROUP_COLORS.length;
      for (const t of dTabs) {
        addToGroup(groupName, CHROME_GROUP_COLORS[colorIndex], t.id);
      }
    }
  }

  // Pass 4: Consolidate remaining singletons into a catch-all group
  const finalSingletons = tabs.filter(t => !tabAssigned.has(t.id));
  if (finalSingletons.length > 0) {
    for (const t of finalSingletons) {
      addToGroup('Other', 'grey', t.id);
    }
  }

  // Convert map to array
  const result = [];
  for (const [name, data] of groupBuckets.entries()) {
    if (data.tabIds.length > 0) {
      result.push({
        name,
        color: data.color || 'blue',
        tabIds: data.tabIds
      });
    }
  }

  return result;
}
