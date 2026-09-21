/**
 * Deterministic address-first grouping.
 *
 * This mode never calls an AI provider. Known services use a stable taxonomy,
 * large multi-service categories split at site boundaries, repeated unknown
 * sites keep their own name, and one-off unknowns go to a bounded review queue.
 */

import { CHROME_GROUP_COLORS } from './ai-engine.js';

export const SITE_GROUP_SOFT_LIMIT = 15;
export const REVIEW_GROUP_LIMIT = 8;

const COMMON_SECOND_LEVEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au',
  'co.nz', 'co.jp', 'co.kr', 'com.br', 'com.mx', 'com.sg', 'com.tr',
  'co.za', 'com.cn', 'com.hk', 'co.in'
]);

const BRAND_OVERRIDES = new Map([
  ['adobe', 'Adobe'], ['airbnb', 'Airbnb'], ['amazon', 'Amazon'],
  ['apple', 'Apple'], ['asana', 'Asana'], ['atlassian', 'Atlassian'],
  ['bbc', 'BBC'], ['behance', 'Behance'], ['bitbucket', 'Bitbucket'],
  ['booking', 'Booking'], ['canva', 'Canva'], ['chatgpt', 'ChatGPT'],
  ['cloudflare', 'Cloudflare'], ['discord', 'Discord'], ['dribbble', 'Dribbble'],
  ['ebay', 'eBay'], ['envato', 'Envato'], ['facebook', 'Facebook'],
  ['figma', 'Figma'], ['freepik', 'Freepik'], ['g2g', 'G2G'],
  ['gemini', 'Gemini'], ['github', 'GitHub'], ['gitlab', 'GitLab'],
  ['google', 'Google'], ['grok', 'Grok'], ['groq', 'Groq'],
  ['huggingface', 'Hugging Face'], ['instagram', 'Instagram'],
  ['linkedin', 'LinkedIn'], ['microsoft', 'Microsoft'], ['netflix', 'Netflix'],
  ['notion', 'Notion'], ['openai', 'OpenAI'], ['openrouter', 'OpenRouter'],
  ['outlook', 'Outlook'], ['paypal', 'PayPal'], ['perplexity', 'Perplexity'],
  ['reddit', 'Reddit'], ['runpod', 'Runpod'], ['shopify', 'Shopify'],
  ['slack', 'Slack'], ['spotify', 'Spotify'], ['stackoverflow', 'Stack Overflow'],
  ['tesla', 'Tesla'], ['threads', 'Threads'], ['tiktok', 'TikTok'],
  ['trello', 'Trello'], ['twitch', 'Twitch'], ['twitter', 'X'],
  ['vimeo', 'Vimeo'], ['youtube', 'YouTube'], ['zoopla', 'Zoopla']
]);

function service(name, domains, matches) {
  return { name, domains, matches };
}

/** Public, generic service families only. Personal domains stay local. */
const CATEGORY_DEFINITIONS = [
  {
    name: 'YouTube', color: 'red', atomic: true,
    services: [service('YouTube', ['youtube.com', 'youtu.be'])]
  },
  {
    name: 'Envato', color: 'green', atomic: true,
    services: [service('Envato', [
      'envato.com', 'themeforest.net', 'codecanyon.net', 'videohive.net',
      'audiojungle.net', 'graphicriver.net', '3docean.net', 'placeit.net',
      'mixkit.co', 'tutsplus.com'
    ])]
  },
  {
    name: 'Tesla', color: 'red', atomic: true,
    services: [service('Tesla', ['tesla.com'])]
  },
  {
    name: 'AI · Assistants', color: 'purple', overflowPrefix: 'AI',
    services: [
      service('ChatGPT', ['chatgpt.com']), service('Grok', ['grok.com', 'x.ai']),
      service('Claude', ['claude.ai']), service('Gemini', ['gemini.google.com']),
      service('Perplexity', ['perplexity.ai']), service('Poe', ['poe.com']),
      service('Copilot', ['copilot.microsoft.com']), service('Arena', ['arena.ai', 'lmarena.ai'])
    ]
  },
  {
    name: 'AI · Platforms', color: 'pink', overflowPrefix: 'AI',
    services: [
      service('OpenAI', ['openai.com']), service('Groq', ['groq.com']),
      service('Hugging Face', ['huggingface.co']), service('OpenRouter', ['openrouter.ai']),
      service('Runpod', ['runpod.io']), service('Replicate', ['replicate.com']),
      service('Together', ['together.ai']), service('Cerebras', ['cerebras.ai']),
      service('DeepSeek', ['deepseek.com']), service('Cursor', ['cursor.com'])
    ]
  },
  {
    name: 'Socials', color: 'blue', overflowPrefix: 'Socials',
    services: [
      service('X', ['x.com', 'twitter.com', 't.co']), service('Reddit', ['reddit.com']),
      service('Slack', ['slack.com']),
      service('LinkedIn', [], ({ host, path }) => hostMatches(host, 'linkedin.com') && !path.startsWith('/jobs')),
      service('Facebook', ['facebook.com']), service('Instagram', ['instagram.com']),
      service('Threads', ['threads.net']), service('Discord', ['discord.com']),
      service('Bluesky', ['bsky.app']), service('Mastodon', ['mastodon.social']),
      service('TikTok', ['tiktok.com'])
    ]
  },
  {
    name: 'Email', color: 'cyan', overflowPrefix: 'Email',
    services: [
      service('Gmail', ['mail.google.com']),
      service('Outlook', ['outlook.live.com', 'outlook.office.com']),
      service('Proton', ['proton.me', 'protonmail.com']), service('Yahoo', ['mail.yahoo.com'])
    ]
  },
  {
    name: 'Video Production', color: 'red', overflowPrefix: 'Video',
    services: [
      service('Vimeo', ['vimeo.com']), service('Motion Array', ['motionarray.com']),
      service('Frame.io', ['frame.io']), service('Muse', ['muse.ai']),
      service('Remotion', ['remotion.dev'])
    ]
  },
  {
    name: 'Entertainment', color: 'red', overflowPrefix: 'Media',
    services: [
      service('Netflix', ['netflix.com']), service('Spotify', ['spotify.com']),
      service('Twitch', ['twitch.tv']), service('Disney+', ['disneyplus.com']),
      service('Prime Video', ['primevideo.com'])
    ]
  },
  {
    name: 'Creative Assets', color: 'yellow', overflowPrefix: 'Assets',
    services: [
      service('Adobe Stock', ['stock.adobe.com']), service('Freepik', ['freepik.com']),
      service('Shutterstock', ['shutterstock.com']), service('Poly Haven', ['polyhaven.com']),
      service('Sketchfab', ['sketchfab.com']), service('Artlist', ['artlist.io'])
    ]
  },
  {
    name: 'Design', color: 'pink', overflowPrefix: 'Design',
    services: [
      service('Figma', ['figma.com']), service('Canva', ['canva.com']),
      service('Behance', ['behance.net']), service('Dribbble', ['dribbble.com']),
      service('Adobe', ['adobe.com']), service('Awwwards', ['awwwards.com'])
    ]
  },
  {
    name: 'Code & Repositories', color: 'green', overflowPrefix: 'Code',
    services: [
      service('GitHub', ['github.com']), service('GitLab', ['gitlab.com']),
      service('Bitbucket', ['bitbucket.org']),
      service('Stack Overflow', ['stackoverflow.com', 'stackexchange.com']),
      service('npm', ['npmjs.com']), service('MDN', ['developer.mozilla.org'])
    ]
  },
  {
    name: 'Cloud & Hosting', color: 'cyan', overflowPrefix: 'Cloud',
    services: [
      service('Cloudflare', ['cloudflare.com']), service('AWS', ['aws.amazon.com']),
      service('Vercel', ['vercel.com']), service('Netlify', ['netlify.com']),
      service('Vultr', ['vultr.com']), service('DigitalOcean', ['digitalocean.com']),
      service('Azure', ['portal.azure.com']), service('Google Cloud', ['console.cloud.google.com'])
    ]
  },
  {
    name: 'Network & Devices', color: 'cyan', overflowPrefix: 'Network',
    services: [
      service('UniFi', ['unifi.ui.com']), service('Speedtest', ['speedtest.net']),
      service('Synology', ['synology.com']), service('QNAP', ['qnap.com'])
    ]
  },
  {
    name: 'Apple Developer', color: 'grey', overflowPrefix: 'Apple Dev',
    services: [
      service('App Store Connect', ['appstoreconnect.apple.com']),
      service('Apple Developer', ['developer.apple.com']),
      service('Apple Business', ['business.apple.com'])
    ]
  },
  {
    name: 'Google Business', color: 'blue', overflowPrefix: 'Google',
    services: [
      service('Google Admin', ['admin.google.com']), service('Analytics', ['analytics.google.com']),
      service('Google Ads', ['ads.google.com']), service('Search Console', ['search.google.com']),
      service('Merchant Center', ['merchants.google.com'])
    ]
  },
  {
    name: 'Work Projects', color: 'blue', overflowPrefix: 'Work',
    services: [
      service('Linear', ['linear.app']), service('Jira', ['atlassian.net']),
      service('Asana', ['asana.com']), service('Trello', ['trello.com']),
      service('Notion', ['notion.so']), service('Monday', ['monday.com']),
      service('Basecamp', ['basecamp.com']),
      service('Google Workspace', [
        'docs.google.com', 'drive.google.com', 'sheets.google.com',
        'slides.google.com', 'meet.google.com', 'calendar.google.com'
      ]),
      service('Microsoft 365', ['office.com', 'sharepoint.com', 'teams.microsoft.com']),
      service('Published Projects', ['chatgpt.site'])
    ]
  },
  {
    name: 'Search & Maps', color: 'blue', overflowPrefix: '',
    services: [
      service('Maps', ['maps.google.com'], ({ host, path }) => host === 'google.com' && path.startsWith('/maps')),
      service('Google Search', [], ({ host, path }) => host === 'google.com' && (
        path === '/' || path === '/webhp' || path.startsWith('/search')
      )),
      service('Bing', ['bing.com']), service('DuckDuckGo', ['duckduckgo.com'])
    ]
  },
  {
    name: 'Reading & News', color: 'grey', overflowPrefix: 'Reading',
    services: [
      service('BBC', ['bbc.co.uk']), service('Reuters', ['reuters.com']),
      service('The Guardian', ['theguardian.com']), service('Bloomberg', ['bloomberg.com']),
      service('Wikipedia', ['wikipedia.org']), service('Medium', ['medium.com']),
      service('Internet Archive', ['archive.org'])
    ]
  },
  {
    name: 'Careers', color: 'green', overflowPrefix: 'Careers',
    services: [
      service('Indeed', ['indeed.com']),
      service('LinkedIn Jobs', [], ({ host, path }) => hostMatches(host, 'linkedin.com') && path.startsWith('/jobs')),
      service('Glassdoor', ['glassdoor.com']), service('Reed', ['reed.co.uk']),
      service('Totaljobs', ['totaljobs.com']), service('CV-Library', ['cv-library.co.uk']),
      service('Lever', ['lever.co']), service('Greenhouse', ['greenhouse.io'])
    ]
  },
  {
    name: 'Fashion Shopping', color: 'yellow', overflowPrefix: 'Fashion',
    services: [
      service('Sports Direct', ['sportsdirect.com']), service('Next', ['next.co.uk']),
      service('Zalando', ['zalando.co.uk']), service('ASOS', ['asos.com']),
      service('Nike', ['nike.com']), service('H&M', ['hm.com']),
      service('TK Maxx', ['tkmaxx.com']), service('Decathlon', ['decathlon.co.uk']),
      service('House of Fraser', ['houseoffraser.co.uk']), service('BoohooMAN', ['boohooman.com']),
      service('Matalan', ['matalan.co.uk']), service('John Lewis', ['johnlewis.com'])
    ]
  },
  {
    name: 'Marketplaces', color: 'yellow', overflowPrefix: 'Market',
    services: [
      service('Amazon', ['amazon.com', 'amazon.co.uk']), service('eBay', ['ebay.com', 'ebay.co.uk']),
      service('Etsy', ['etsy.com']), service('G2G', ['g2g.com']),
      service('Gumtree', ['gumtree.com']), service('Shopify', ['shopify.com'])
    ]
  },
  {
    name: 'Travel', color: 'blue', overflowPrefix: 'Travel',
    services: [
      service('Booking', ['booking.com']), service('Airbnb', ['airbnb.com']),
      service('Skyscanner', ['skyscanner.net']), service('Expedia', ['expedia.com']),
      service('YourParkingSpace', ['yourparkingspace.co.uk']), service('JustPark', ['justpark.com'])
    ]
  },
  {
    name: 'Property', color: 'green', overflowPrefix: 'Property',
    services: [
      service('Zoopla', ['zoopla.co.uk']), service('Rightmove', ['rightmove.co.uk']),
      service('OnTheMarket', ['onthemarket.com'])
    ]
  },
  {
    name: 'Finance & Payments', color: 'green', overflowPrefix: 'Finance',
    services: [
      service('PayPal', ['paypal.com']), service('Wise', ['wise.com']),
      service('Revolut', ['revolut.com']), service('Clearpay', ['clearpay.co.uk']),
      service('Compare the Market', ['comparethemarket.com'])
    ]
  },
  {
    name: 'Events', color: 'purple', overflowPrefix: 'Events',
    services: [
      service('Luma', ['luma.com']), service('Meetup', ['meetup.com']),
      service('Eventbrite', ['eventbrite.com'])
    ]
  },
  {
    name: 'Life Admin', color: 'grey', overflowPrefix: 'Admin',
    services: [
      service('GOV.UK', ['gov.uk']), service('Royal Mail', ['royalmail.com']),
      service('Apple Support', ['support.apple.com', 'getsupport.apple.com', 'checkcoverage.apple.com']),
      service('Google Account', ['accounts.google.com', 'myaccount.google.com']),
      service('Yubico', ['yubico.com']), service('1Password', ['1password.com']),
      service('Bitwarden', ['bitwarden.com'])
    ]
  },
  {
    name: 'Communities & Forums', color: 'purple', overflowPrefix: 'Community',
    services: [
      service('Discourse', ['discourse.org']), service('Groups.io', ['groups.io']),
      service('Quora', ['quora.com'])
    ]
  }
];

function hostMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function baseSiteLabel(host) {
  if (/^(localhost|\d{1,3}(?:\.\d{1,3}){3})$/.test(host)) return host;
  const parts = host.split('.').filter(Boolean);
  if (parts.length === 0) return 'other';
  if (parts.length === 1) return parts[0];
  const lastTwo = parts.slice(-2).join('.');
  const labelIndex = COMMON_SECOND_LEVEL_SUFFIXES.has(lastTwo) ? parts.length - 3 : parts.length - 2;
  return parts[Math.max(0, labelIndex)];
}

function titleCaseSite(label) {
  const known = BRAND_OVERRIDES.get(label);
  if (known) return known;
  return label
    .split(/[-_]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'Other';
}

function colorForName(name) {
  let hash = 0;
  for (const char of name) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return CHROME_GROUP_COLORS[(hash >>> 0) % CHROME_GROUP_COLORS.length];
}

function isLocalDevelopmentHost(host) {
  return host === 'localhost'
    || host === '127.0.0.1'
    || host === '::1'
    || /^10\./.test(host)
    || /^192\.168\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || host.endsWith('.localhost')
    || host.endsWith('.local');
}

function resolveSite(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (!host) throw new Error('Missing host');

    if (isLocalDevelopmentHost(host)) {
      return {
        name: 'Local Development', color: 'cyan', serviceName: titleCaseSite(host),
        siteName: titleCaseSite(host), known: true, atomic: false, overflowPrefix: 'Local'
      };
    }

    const context = { host, path: parsed.pathname, url: parsed };
    for (const category of CATEGORY_DEFINITIONS) {
      for (const candidate of category.services) {
        const matched = candidate.matches?.(context)
          || candidate.domains?.some(domain => hostMatches(host, domain));
        if (!matched) continue;
        return {
          name: category.name,
          color: category.color,
          serviceName: candidate.name,
          siteName: titleCaseSite(baseSiteLabel(host)),
          known: true,
          atomic: Boolean(category.atomic),
          overflowPrefix: category.overflowPrefix ?? category.name
        };
      }
    }

    const siteName = titleCaseSite(baseSiteLabel(host));
    return {
      name: siteName, color: colorForName(siteName), serviceName: siteName,
      siteName, known: false, atomic: true, overflowPrefix: siteName
    };
  } catch {
    return {
      name: 'Other', color: 'grey', serviceName: 'Other', siteName: 'Other',
      known: false, atomic: true, overflowPrefix: 'Other'
    };
  }
}

/** Resolve the stable base category shown before adaptive overflow splitting. */
export function getSiteCategory(rawUrl) {
  const category = resolveSite(rawUrl);
  return { name: category.name, color: category.color };
}

/** True for services that must remain in the stable Socials group. */
export function isSocialSite(rawUrl) {
  return resolveSite(rawUrl).name === 'Socials';
}

function overflowGroupName(category, serviceName) {
  if (!category.overflowPrefix) return serviceName;
  return `${category.overflowPrefix} · ${serviceName}`;
}

function makeGroup(name, color, entries) {
  return {
    name,
    color,
    tabIds: entries.map(entry => entry.tab.id),
    firstIndex: Math.min(...entries.map(entry => entry.position))
  };
}

/** Group every tab once while preserving first-seen group and tab order. */
export function clusterTabsBySite(tabs) {
  const entries = tabs.map((tab, position) => ({
    tab,
    position,
    category: resolveSite(tab.url || tab.pendingUrl || '')
  }));

  const unknownSiteCounts = new Map();
  for (const entry of entries) {
    if (entry.category.known) continue;
    const key = entry.category.siteName.toLocaleLowerCase();
    unknownSiteCounts.set(key, (unknownSiteCounts.get(key) || 0) + 1);
  }

  const buckets = new Map();
  for (const entry of entries) {
    const unknownCount = unknownSiteCounts.get(entry.category.siteName.toLocaleLowerCase()) || 0;
    const useReviewQueue = !entry.category.known && unknownCount < 2;
    const bucketName = useReviewQueue ? 'Review Later' : entry.category.name;
    const normalized = {
      ...entry,
      category: {
        ...entry.category,
        name: bucketName,
        color: useReviewQueue ? 'grey' : entry.category.color,
        atomic: useReviewQueue ? false : entry.category.atomic,
        overflowPrefix: useReviewQueue ? 'Review' : entry.category.overflowPrefix
      }
    };
    const key = bucketName.toLocaleLowerCase();
    const bucket = buckets.get(key) || [];
    bucket.push(normalized);
    buckets.set(key, bucket);
  }

  const groups = [];
  for (const bucket of buckets.values()) {
    const category = bucket[0].category;

    if (category.name === 'Review Later' && bucket.length > REVIEW_GROUP_LIMIT) {
      for (let start = 0, part = 1; start < bucket.length; start += REVIEW_GROUP_LIMIT, part++) {
        groups.push(makeGroup(`Review Later · ${part}`, category.color, bucket.slice(start, start + REVIEW_GROUP_LIMIT)));
      }
      continue;
    }

    const serviceBuckets = new Map();
    for (const entry of bucket) {
      const key = entry.category.serviceName.toLocaleLowerCase();
      const serviceBucket = serviceBuckets.get(key) || [];
      serviceBucket.push(entry);
      serviceBuckets.set(key, serviceBucket);
    }

    if (category.atomic || bucket.length <= SITE_GROUP_SOFT_LIMIT || serviceBuckets.size < 2) {
      groups.push(makeGroup(category.name, category.color, bucket));
      continue;
    }

    for (const serviceBucket of serviceBuckets.values()) {
      groups.push(makeGroup(
        overflowGroupName(category, serviceBucket[0].category.serviceName),
        category.color,
        serviceBucket
      ));
    }
  }

  return groups
    .sort((a, b) => a.firstIndex - b.firstIndex)
    .map(({ firstIndex, ...group }) => group);
}
