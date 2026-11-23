/**
 * Foldnex - Label vocabulary
 *
 * The fixed categories local group names and colours come from (site
 * taxonomy and title words), plus the word lists for title tokens and names.
 *
 * This module imports nothing, so ai-engine.js and planner.js can both use it
 * without an import cycle.
 */

// Part of the engine scope (labelCacheScope) that stored plans and remembered
// names are kept under: changing it orphans them.
export const LABEL_VOCAB_VERSION = 'v2';

// Longest group name Foldnex writes, and the reserved name of the unsure
// bucket. Here so cache-engine.js and planner.js share them without a cycle.
export const GROUP_NAME_LIMIT = 30;
export const REVIEW_GROUP_NAME = 'Review Later';

// Order matters: it breaks ties everywhere (dominant category, lexicon hits).
export const LABEL_CATEGORIES = Object.freeze([
  { key: 'dev', name: 'Coding', short: 'Code', color: 'cyan' },
  { key: 'ai', name: 'AI Tools', short: 'AI', color: 'purple' },
  { key: 'infra', name: 'Cloud & Servers', short: 'Cloud', color: 'cyan' },
  { key: 'design', name: 'Design', short: 'Design', color: 'pink' },
  { key: 'office', name: 'Docs & Planning', short: 'Docs', color: 'blue' },
  { key: 'mail', name: 'Email & Chat', short: 'Email', color: 'cyan' },
  { key: 'biz', name: 'Business', short: 'Business', color: 'orange' },
  { key: 'jobs', name: 'Jobs', short: 'Jobs', color: 'green' },
  { key: 'learn', name: 'Learning', short: 'Learning', color: 'yellow' },
  { key: 'news', name: 'News', short: 'News', color: 'grey' },
  { key: 'read', name: 'Reading', short: 'Reading', color: 'grey' },
  { key: 'video', name: 'Watch & Listen', short: 'Media', color: 'red' },
  { key: 'games', name: 'Gaming', short: 'Gaming', color: 'purple' },
  { key: 'sport', name: 'Sports', short: 'Sports', color: 'green' },
  { key: 'shop', name: 'Shopping', short: 'Shopping', color: 'yellow' },
  { key: 'money', name: 'Money', short: 'Money', color: 'green' },
  { key: 'travel', name: 'Travel', short: 'Travel', color: 'blue' },
  { key: 'food', name: 'Food & Recipes', short: 'Food', color: 'orange' },
  { key: 'home', name: 'Home', short: 'Home', color: 'orange' },
  { key: 'health', name: 'Health', short: 'Health', color: 'red' },
  { key: 'cars', name: 'Cars', short: 'Cars', color: 'grey' },
  { key: 'events', name: 'Events', short: 'Events', color: 'pink' },
  { key: 'admin', name: 'Accounts & Admin', short: 'Admin', color: 'grey' }
].map(category => Object.freeze(category)));

export const CATEGORY_KEYS = Object.freeze(LABEL_CATEGORIES.map(category => category.key));

/** Key → category entry. A Map so an unknown or hostile key never hits a prototype property. */
export const CATEGORY_BY_KEY = new Map(LABEL_CATEGORIES.map(category => [category.key, category]));

function affinityPair(a, b) {
  return [a, b].sort().join('|');
}

// How naturally two categories share a folder when the ceiling forces a merge.
// Pairs not listed score 0 on purpose: there is no family fallback.
export const CATEGORY_AFFINITY = new Map([
  ...[
    'ai|dev', 'dev|infra', 'mail|office', 'news|read', 'learn|read',
    'games|video', 'health|sport', 'money|shop', 'events|travel'
  ].map(pair => [affinityPair(...pair.split('|')), 2]),
  ...[
    'ai|infra', 'ai|learn', 'design|dev', 'biz|design', 'design|office',
    'biz|office', 'jobs|office', 'jobs|learn', 'dev|learn', 'learn|news',
    'news|sport', 'admin|news', 'sport|video', 'events|video', 'food|travel',
    'food|health', 'food|home', 'home|shop', 'home|money', 'cars|travel',
    'cars|shop', 'admin|money', 'admin|mail', 'biz|money', 'admin|office'
  ].map(pair => [affinityPair(...pair.split('|')), 1])
]);

/** 3 for the same key, 2 or 1 for listed pairs, 0 otherwise or when either side is null. */
export function categoryAffinity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 3;
  return CATEGORY_AFFINITY.get(affinityPair(a, b)) || 0;
}

// Title words that point at one category in several languages. The planner
// uses them for offline inference and never promotes them as task tokens.
export const TITLE_LEXICON = new Map([
  ...[
    'recipe', 'recipes', 'recette', 'recettes', 'rezept', 'rezepte', 'ricetta', 'ricette',
    'receta', 'recetas', 'レシピ', 'cooking', 'restaurant', 'restaurants'
  ].map(word => [word, 'food']),
  ...[
    'flight', 'flights', 'hotel', 'hotels', 'vuelo', 'vuelos', 'flug', 'flüge', 'reise',
    'reisen', 'voyage', 'voyages', 'viaje', 'viajes', 'airport', 'itinerary'
  ].map(word => [word, 'travel']),
  ...['news', 'nachrichten', 'actualités', 'notizie', 'noticias', 'nieuws', 'headlines']
    .map(word => [word, 'news']),
  ...['documentation', 'api', 'sdk', 'repository', 'repo', 'programming']
    .map(word => [word, 'dev']),
  ...['course', 'courses', 'tutorial', 'tutorials', 'lesson', 'lessons']
    .map(word => [word, 'learn']),
  ...['shop', 'store', 'cart', 'sale', 'deal', 'deals'].map(word => [word, 'shop']),
  ...['bank', 'banking', 'crypto', 'bitcoin', 'tax', 'insurance', 'mortgage']
    .map(word => [word, 'money']),
  ...['football', 'soccer', 'nba', 'nfl', 'league', 'fixtures'].map(word => [word, 'sport']),
  ...['movie', 'movies', 'film', 'trailer', 'episode', 'podcast'].map(word => [word, 'video']),
  ...['game', 'games'].map(word => [word, 'games']),
  ...['job', 'jobs', 'career', 'careers', 'hiring'].map(word => [word, 'jobs']),
  ...['government', 'passport', 'visa', 'council'].map(word => [word, 'admin']),
  ...['fitness', 'workout', 'symptoms'].map(word => [word, 'health']),
  ...['ticket', 'tickets', 'concert', 'festival'].map(word => [word, 'events']),
  ...['inbox', 'email'].map(word => [word, 'mail']),
  ...['calendar', 'spreadsheet', 'notes'].map(word => [word, 'office'])
]);

// Function words never make a task or a topic. The first block is the list
// moved from the old offline clusterer; the rest adds EN, DE, FR, ES and IT.
export const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'he',
  'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'to', 'was', 'were',
  'will', 'with', 'you', 'your', 'this', 'about', 'into', 'over', 'after',
  'home', 'page', 'app', 'login', 'dashboard', 'official', 'site', 'new',
  'free', 'online', 'view', 'web', 'com', 'org', 'net', 'io',
  // English
  'all', 'also', 'any', 'been', 'before', 'being', 'both', 'but', 'can', 'could', 'did',
  'does', 'doing', 'down', 'each', 'few', 'had', 'have', 'her', 'here', 'him', 'his',
  'how', 'just', 'more', 'most', 'much', 'not', 'now', 'off', 'only', 'other', 'our',
  'out', 'own', 'same', 'she', 'should', 'some', 'such', 'than', 'their', 'them',
  'then', 'there', 'these', 'they', 'those', 'through', 'too', 'under', 'until', 'upon',
  'very', 'via', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why',
  'would', 'yours', 'using', 'without', 'within', 'vs',
  // German
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einer', 'eines', 'einem',
  'einen', 'und', 'oder', 'aber', 'ist', 'sind', 'mit', 'von', 'vom', 'zum',
  'zur', 'für', 'auf', 'aus', 'bei', 'nach', 'über', 'unter', 'nicht', 'auch', 'wie',
  'was', 'wer', 'sich', 'sie', 'wir', 'ich', 'ihr', 'ihre', 'sein', 'seine', 'noch',
  'nur', 'schon', 'wenn', 'dass', 'durch', 'gegen', 'ohne', 'um', 'im', 'am',
  // French
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'et', 'ou', 'au', 'aux', 'pour',
  'par', 'sur', 'dans', 'avec', 'sans', 'est', 'sont', 'ce', 'cet', 'cette', 'ces',
  'qui', 'que', 'quoi', 'pas', 'plus', 'son', 'ses', 'leur', 'leurs', 'nous', 'vous',
  'ils', 'elle', 'elles', 'comment', 'entre', 'chez',
  // Spanish
  'el', 'los', 'las', 'unos', 'unas', 'del', 'al', 'en', 'con', 'por', 'para', 'es',
  'son', 'su', 'sus', 'lo', 'como', 'más', 'sin', 'sobre', 'pero', 'muy', 'este',
  'esta', 'estos', 'estas', 'ese', 'esa', 'qué', 'cómo', 'donde', 'dónde', 'cuando',
  // Italian
  'il', 'gli', 'di', 'della', 'dello', 'delle', 'dei', 'degli', 'alla', 'alle', 'allo',
  'nel', 'nella', 'nelle', 'nei', 'negli', 'dalla', 'per', 'tra', 'fra', 'che',
  'non', 'sono', 'questo', 'questa', 'quello', 'quella', 'come', 'più', 'anche', 'uno'
]);

// Topical but too broad to name a task: they appear across unrelated subjects.
export const GENERIC_TOPIC_TOKENS = new Set([
  'api', 'app', 'apps', 'guide', 'docs', 'doc', 'tutorial', 'review', 'reviews',
  'news', 'price', 'prices', 'buy', 'deal', 'deals', 'best', 'video', 'videos',
  'music', 'online', 'account', 'login', 'settings', 'search', 'home', 'blog',
  'article', 'course', 'free', 'official', 'new', 'top', 'page', 'site', 'wiki',
  'wikipedia', 'www', '2024', '2025', '2026', '2027'
]);

// A model name made only of these words says nothing about its tabs
// ('Online Stores', 'Web Services'); the category name is kept instead.
export const VAGUE_NAME_WORDS = new Set([
  'online', 'web', 'internet', 'digital', 'service', 'services', 'tool', 'tools',
  'site', 'sites', 'website', 'websites', 'page', 'pages', 'link', 'links',
  'resource', 'resources', 'content', 'platform', 'platforms', 'store', 'stores',
  'portal', 'portals', 'hub', 'stuff', 'things', 'items', 'info', 'information',
  'app', 'apps', 'various', 'misc', 'general', 'other', 'tabs', 'browsing', 'and'
]);

// Decoration a folder label does not need ('Culinary Delights').
export const DECORATIVE_NAME_WORDS = new Set([
  'delight', 'delights', 'adventure', 'adventures', 'wonders', 'treasures',
  'essentials', 'extravaganza', 'galore', 'escapades', 'odyssey', 'bliss',
  'paradise', 'haven', 'realm'
]);

// Folds 'Japanese recipes' and 'Japan trip' onto one task token.
export const DEMONYMS = new Map([
  ['japanese', 'japan'], ['italian', 'italy'], ['german', 'germany'], ['french', 'france'],
  ['spanish', 'spain'], ['chinese', 'china'], ['korean', 'korea'], ['greek', 'greece'],
  ['thai', 'thailand'], ['indian', 'india'], ['mexican', 'mexico'], ['british', 'britain'],
  ['polish', 'poland'], ['dutch', 'netherlands'], ['swedish', 'sweden'], ['turkish', 'turkey'],
  ['portuguese', 'portugal'], ['brazilian', 'brazil'], ['american', 'america']
]);
