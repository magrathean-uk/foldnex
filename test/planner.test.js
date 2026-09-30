import assert from 'node:assert/strict';
import test from 'node:test';

import { groupCeiling } from '../src/ai-engine.js';
import { CATEGORY_KEYS } from '../src/label-vocabulary.js';
import { isSocialSite } from '../src/site-clusterer.js';
import {
  buildLocalContext,
  categoryFromSite,
  categoryFromTitle,
  enforceFolders,
  enforceGroupCeiling,
  ensureUniqueNames,
  groupTokenHashes,
  inferLocalLabel,
  labelPriority,
  mergedName,
  planGroups,
  planSignature,
  shortOf,
  titleTokens,
  transferNames,
  validateGroupName
} from '../src/planner.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(list, rand) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** [url, title, label] rows → tabs with ids 1..n in strip order plus a label map. */
function windowFrom(rows) {
  const tabs = rows.map(([url, title], index) => ({ id: index + 1, index, url, title }));
  const labels = new Map();
  rows.forEach(([, , label], index) => {
    if (label) labels.set(index + 1, label);
  });
  return { tabs, labels };
}

function socialsOf(tabs) {
  const ids = tabs.filter(tab => isSocialSite(tab.url)).map(tab => tab.id);
  return ids.length ? [{ name: 'Socials', color: 'blue', kind: 'social', tabIds: ids }] : [];
}

function nameSizes(plan) {
  return plan.groups
    .map(group => [group.name, group.tabIds.length])
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}

function membership(groups) {
  return new Map(groups.map(group => [group.name, [...group.tabIds].sort((a, b) => a - b)]));
}

function groupOf(plan, tabId) {
  return plan.groups.find(group => group.tabIds.includes(tabId));
}

function assertCoverage(groups, ids) {
  const placed = groups.flatMap(group => group.tabIds);
  assert.equal(placed.length, ids.length, 'every tab is placed once');
  assert.deepEqual([...placed].sort((a, b) => a - b), [...ids].sort((a, b) => a - b));
}

/** n labelled tabs on distinct unknown sites with titles that share no token. */
function categoryTabs(spec, { startId = 1 } = {}) {
  const rows = [];
  let serial = startId;
  for (const [label, count] of spec) {
    for (let i = 0; i < count; i++) {
      rows.push([`https://site${serial}.example/page`, `Zq${serial}x Wv${serial}y`, label]);
      serial++;
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Ceiling
// ---------------------------------------------------------------------------

test('planner: groupCeiling follows the preferred-count table', () => {
  const table = [
    [0, 0], [1, 0], [2, 1], [3, 1], [4, 2], [5, 2], [6, 3], [8, 4], [12, 4], [13, 5],
    [18, 6], [24, 6], [25, 7], [31, 7], [32, 8], [40, 8], [41, 9], [49, 9], [50, 10], [300, 10]
  ];
  for (const [n, expected] of table) assert.equal(groupCeiling(n), expected, `groupCeiling(${n})`);

  let previous = 0;
  for (let n = 2; n <= 1000; n++) {
    const value = groupCeiling(n);
    assert.ok(value >= previous, `monotone at ${n}`);
    assert.ok(value <= 10, `at most 10 at ${n}`);
    assert.ok(value <= Math.floor(n / 2), `at most n/2 at ${n}`);
    previous = value;
  }
});

// A small vocabulary so random titles share tokens often enough to exercise
// task promotion, loose-tab attachment and oversize splits.
const PROPERTY_WORDS = [
  'atlas', 'harbor', 'falcon', 'meadow', 'quartz', 'nimbus', 'saffron', 'tundra',
  'violet', 'walnut', 'zephyr', 'cobalt', 'ember', 'glacier', 'juniper', 'lagoon',
  'marble', 'orchid', 'pepper', 'raven', 'summit', 'timber', 'willow', 'canyon',
  'japanese', 'japan', 'misc', 'guide', 'review', 'react', 'rust', 'kyoto'
];
const PROPERTY_HOSTS = [
  'github.com', 'www.youtube.com', 'www.bbc.co.uk', 'www.booking.com', 'en.wikipedia.org',
  'medium.com', 'www.amazon.com', 'mail.google.com', 'docs.google.com', 'www.gov.pl',
  'www.lemonde.fr', 'www.spiegel.de', 'tesla.com', 'www.figma.com',
  ...Array.from({ length: 16 }, (_, i) => `shop${i}.example`)
];
const SOCIAL_HOSTS = ['x.com', 'www.reddit.com', 'www.instagram.com'];

function randomWindow(rand) {
  const n = 2 + Math.floor(rand() * 299);
  const looseRate = rand() * 0.3;
  const socialRate = rand() < 0.5 ? rand() * 0.08 : 0;
  const tabs = [];
  const labels = new Map();
  for (let i = 0; i < n; i++) {
    const id = 1000 + i;
    const social = rand() < socialRate;
    const host = social
      ? SOCIAL_HOSTS[Math.floor(rand() * SOCIAL_HOSTS.length)]
      : PROPERTY_HOSTS[Math.floor(rand() * PROPERTY_HOSTS.length)];
    const wordCount = 1 + Math.floor(rand() * 4);
    const words = Array.from({ length: wordCount }, () => PROPERTY_WORDS[Math.floor(rand() ** 1.5 * PROPERTY_WORDS.length)]);
    tabs.push({ id, index: i, url: `https://${host}/p/${i}`, title: `${words.join(' ')} ${i}` });
    if (rand() >= looseRate) labels.set(id, CATEGORY_KEYS[Math.floor(rand() ** 2 * CATEGORY_KEYS.length)]);
  }

  const locked = [];
  const claimed = new Set(tabs.filter(tab => isSocialSite(tab.url)).map(tab => tab.id));
  const ruleCount = Math.floor(rand() * 4);
  const ruleNames = ['Home Lab', 'Coding', 'Client Work', 'Travel'];
  for (let r = 0; r < ruleCount; r++) {
    const free = tabs.filter(tab => !claimed.has(tab.id));
    if (free.length < 2) break;
    const take = 1 + Math.floor(rand() * Math.min(4, free.length - 1));
    const ids = shuffle(free, rand).slice(0, take).map(tab => tab.id);
    ids.forEach(id => claimed.add(id));
    locked.push({ name: ruleNames[r], color: 'green', kind: 'rule', tabIds: ids });
  }
  locked.push(...socialsOf(tabs));
  return { tabs, labels, locked };
}

test('planner property: seeded windows obey the hard maximum and cover every tab', () => {
  const rand = mulberry32(42);
  for (let run = 0; run < 3000; run++) {
    const { tabs, labels, locked } = randomWindow(rand);
    const n = tabs.length;
    const K = groupCeiling(n);
    const F = locked.length;
    const plan = planGroups(tabs, labels, { locked });
    const context = `run ${run}, n ${n}, K ${K}, F ${F}`;

    assert.equal(plan.n, n, context);
    assert.equal(plan.K, K, context);
    assert.equal(plan.hardLimit, 10);
    assert.ok(plan.groups.length <= Math.max(10, F + 1), `${context}: ${plan.groups.length} groups`);
    assertCoverage(plan.groups, tabs.map(tab => tab.id));
    for (const group of plan.groups) {
      assert.notEqual(group.name.toLowerCase(), 'other', context);
      assert.ok(group.name.length >= 1 && group.name.length <= 30, `${context}: "${group.name}"`);
    }
    for (const lockedGroup of locked) {
      const planned = plan.groups.find(group => group.locked && group.name === lockedGroup.name);
      assert.ok(planned, `${context}: locked ${lockedGroup.name} kept`);
      for (const id of lockedGroup.tabIds) assert.ok(planned.tabIds.includes(id), `${context}: locked tab ${id}`);
    }

    assert.deepEqual(planGroups(tabs, labels, { locked }), plan, `${context}: repeat run`);

    // Without strip indexes to restore the order, a shuffled input must still
    // give the same membership and names.
    const bare = shuffle(tabs.map(({ index, ...tab }) => tab), rand);
    const shuffled = planGroups(bare, labels, { locked });
    assert.deepEqual(membership(shuffled.groups), membership(plan.groups), `${context}: shuffled`);
  }
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// The owner's real window (urls100.txt) with plausible model labels:
// Wikipedia → learn, news homepages → news. Socials are locked by site.
const OWNER_WINDOW = [
  ['https://en.wikipedia.org/wiki/Photosynthesis', 'Photosynthesis - Wikipedia', 'learn'],
  ['https://de.wikipedia.org/wiki/Quantenmechanik', 'Quantenmechanik – Wikipedia', 'learn'],
  ['https://fr.wikipedia.org/wiki/R%C3%A9volution_fran%C3%A7aise', 'Révolution française — Wikipédia', 'learn'],
  ['https://es.wikipedia.org/wiki/Gabriel_Garc%C3%ADa_M%C3%A1rquez', 'Gabriel García Márquez - Wikipedia, la enciclopedia libre', 'learn'],
  ['https://it.wikipedia.org/wiki/Rinascimento', 'Rinascimento - Wikipedia', 'learn'],
  ['https://ja.wikipedia.org/wiki/%E5%AF%BF%E5%8F%B8', '寿司 - Wikipedia', 'learn'],
  ['https://zh.wikipedia.org/wiki/%E9%95%BF%E5%9F%8E', '长城 - 维基百科，自由的百科全书', 'learn'],
  ['https://ru.wikipedia.org/wiki/%D0%9A%D0%BE%D1%81%D0%BC%D0%BE%D0%BD%D0%B0%D0%B2%D1%82%D0%B8%D0%BA%D0%B0', 'Космонавтика — Википедия', 'learn'],
  ['https://ar.wikipedia.org/wiki/%D8%A7%D9%84%D9%82%D9%87%D9%88%D8%A9', 'القهوة - ويكيبيديا', 'learn'],
  ['https://hu.wikipedia.org/wiki/Budapest', 'Budapest – Wikipédia', 'learn'],
  ['https://pl.wikipedia.org/wiki/Maria_Sk%C5%82odowska-Curie', 'Maria Skłodowska-Curie – Wikipedia, wolna encyklopedia', 'learn'],
  ['https://pt.wikipedia.org/wiki/Futebol', 'Futebol – Wikipédia, a enciclopédia livre', 'learn'],
  ['https://ko.wikipedia.org/wiki/%ED%95%9C%EA%B8%80', '한글 - 위키백과, 우리 모두의 백과사전', 'learn'],
  ['https://hi.wikipedia.org/wiki/%E0%A4%AF%E0%A5%8B%E0%A4%97', 'योग - विकिपीडिया', 'learn'],
  ['https://tr.wikipedia.org/wiki/%C4%B0stanbul', 'İstanbul - Vikipedi', 'learn'],
  ['https://nl.wikipedia.org/wiki/Fiets', 'Fiets - Wikipedia', 'learn'],
  ['https://sv.wikipedia.org/wiki/IKEA', 'IKEA – Wikipedia', 'learn'],
  ['https://fi.wikipedia.org/wiki/Sauna', 'Sauna – Wikipedia', 'learn'],
  ['https://el.wikipedia.org/wiki/%CE%91%CE%BA%CF%81%CF%8C%CF%80%CE%BF%CE%BB%CE%B7_%CE%91%CE%B8%CE%B7%CE%BD%CF%8E%CE%BD', 'Ακρόπολη Αθηνών - Βικιπαίδεια', 'learn'],
  ['https://he.wikipedia.org/wiki/%D7%99%D7%A8%D7%95%D7%A9%D7%9C%D7%99%D7%9D', 'ירושלים – ויקיפדיה', 'learn'],
  ['https://www.lemonde.fr/', 'Le Monde.fr - Actualités et Infos en France et dans le monde', 'news'],
  ['https://www.spiegel.de/', 'DER SPIEGEL | Online-Nachrichten', 'news'],
  ['https://elpais.com/', 'EL PAÍS: el periódico global', 'news'],
  ['https://www.corriere.it/', 'Corriere della Sera: ultime notizie oggi', 'news'],
  ['https://www.asahi.com/', '朝日新聞デジタル：朝日新聞社のニュースサイト', 'news'],
  ['https://www.nos.nl/', 'NOS | Nieuws', 'news'],
  ['https://yle.fi/', 'Yle | Uutiset', 'news'],
  ['https://www.nrk.no/', 'NRK – Nyheter, TV og radio', 'news'],
  ['https://www.dr.dk/', 'DR | Nyheder', 'news'],
  ['https://www.bbc.co.uk/news', 'Home - BBC News', 'news'],
  ['https://index.hu/', 'Index - Hírek', 'news'],
  ['https://www.idnes.cz/', 'iDNES.cz – zprávy z domova a ze světa', 'news'],
  ['https://www.aljazeera.net/', 'الجزيرة نت: آخر أخبار اليوم حول العالم', 'news'],
  ['https://www.folha.uol.com.br/', 'Folha de S.Paulo: Notícias', 'news'],
  ['https://www.hindustantimes.com/', 'Latest News, Breaking News Today - Hindustan Times', 'news'],
  ['https://github.com/torvalds/linux', 'GitHub - torvalds/linux: Linux kernel source tree', 'dev'],
  ['https://github.com/python/cpython', 'GitHub - python/cpython: The Python programming language', 'dev'],
  ['https://github.com/rust-lang/rust', 'GitHub - rust-lang/rust: Empowering everyone to build reliable software', 'dev'],
  ['https://stackoverflow.com/questions/231767/what-does-the-yield-keyword-do-in-python', 'What does the "yield" keyword do in Python? - Stack Overflow', 'dev'],
  ['https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise', 'Promise - JavaScript | MDN', 'dev'],
  ['https://docs.python.org/3/library/asyncio.html', 'asyncio — Asynchronous I/O — Python 3.13 documentation', 'dev'],
  ['https://doc.rust-lang.org/book/', 'The Rust Programming Language - The Rust Programming Language', 'dev'],
  ['https://kubernetes.io/docs/concepts/overview/', 'Overview | Kubernetes', 'dev'],
  ['https://www.postgresql.org/docs/current/index.html', 'PostgreSQL: Documentation: 17: PostgreSQL 17.2 Documentation', 'dev'],
  ['https://developer.chrome.com/docs/extensions/ai/prompt-api', 'The Prompt API | AI on Chrome | Chrome for Developers', 'dev'],
  ['https://news.ycombinator.com/', 'Hacker News', 'news'],
  ['https://arxiv.org/list/cs.LG/recent', 'Machine Learning authors/titles recent submissions', 'learn'],
  ['https://www.nature.com/', 'Nature', 'learn'],
  ['https://www.nasa.gov/', 'NASA', 'learn'],
  ['https://www.who.int/', 'World Health Organization (WHO)', 'learn'],
  ['https://www.allrecipes.com/recipe/10813/best-chocolate-chip-cookies/', 'Best Chocolate Chip Cookies Recipe (Ooey-Gooey and Tested)', 'food'],
  ['https://www.marmiton.org/', 'Marmiton : 70 000 recettes de cuisine', 'food'],
  ['https://www.chefkoch.de/', 'Chefkoch.de – Rezepte, Kochen, Backen', 'food'],
  ['https://cookpad.com/jp', 'クックパッド - 毎日の料理を楽しみに', 'food'],
  ['https://www.giallozafferano.it/', 'GialloZafferano: le ricette di cucina italiana', 'food'],
  ['https://www.booking.com/', 'Booking.com | Hotels, homes and more', 'travel'],
  ['https://www.airbnb.com/', 'Airbnb | Vacation rentals, cabins, beach houses', 'travel'],
  ['https://www.lonelyplanet.com/japan', 'Japan travel - Lonely Planet | Asia', 'travel'],
  ['https://www.tripadvisor.com/', 'Tripadvisor: Over a billion reviews & contributions for Hotels, Attractions, Restaurants', 'travel'],
  ['https://www.sncf-connect.com/', 'SNCF Connect : trains, billets et horaires', 'travel'],
  ['https://www.bahn.de/', 'DB Fahrplan, Auskunft, Tickets | Deutsche Bahn', 'travel'],
  ['https://www.ryanair.com/', 'Ryanair | Book cheap flights', 'travel'],
  ['https://www.amazon.de/', 'Amazon.de: Günstige Preise für Elektronik, Bücher & mehr', 'shop'],
  ['https://www.rakuten.co.jp/', '【楽天市場】Shopping is Entertainment!', 'shop'],
  ['https://www.ikea.com/se/sv/', 'IKEA Sverige - Möbler, inredning och inspiration', 'home'],
  ['https://www.zalando.de/', 'Zalando | Schuhe & Mode online kaufen', 'shop'],
  ['https://www.etsy.com/', 'Etsy - Shop for handmade, vintage and unique gifts', 'shop'],
  ['https://www.mercadolibre.com.ar/', 'Mercado Libre Argentina - Envíos Gratis', 'shop'],
  ['https://www.allegro.pl/', 'Allegro - atrakcyjne ceny', 'shop'],
  ['https://www.youtube.com/', 'YouTube', 'video'],
  ['https://www.twitch.tv/', 'Twitch', 'video'],
  ['https://open.spotify.com/', 'Spotify - Web Player', 'video'],
  ['https://www.imdb.com/chart/top/', 'IMDb Top 250 Movies', 'video'],
  ['https://www.letterboxd.com/', 'Letterboxd • Social film discovery', 'video'],
  ['https://www.nba.com/', 'NBA.com: Official Site of the National Basketball Association', 'sport'],
  ['https://www.uefa.com/', 'UEFA.com | The official website for European football', 'sport'],
  ['https://www.formula1.com/', 'Formula 1® - The Official F1® Website', 'sport'],
  ['https://www.espn.com/', 'ESPN - Serving Sports Fans. Anytime. Anywhere.', 'sport'],
  ['https://www.marca.com/', 'MARCA - Diario online líder en información deportiva', 'sport'],
  ['https://www.reddit.com/r/programming/', 'programming', 'dev'],
  ['https://x.com/nasa', 'NASA (@NASA) / X', 'learn'],
  ['https://www.linkedin.com/', 'LinkedIn', 'jobs'],
  ['https://www.instagram.com/', 'Instagram', 'video'],
  ['https://discord.com/', 'Discord', 'mail'],
  ['https://mail.google.com/', 'Inbox - Gmail', 'mail'],
  ['https://outlook.live.com/', 'Mail - Outlook', 'mail'],
  ['https://calendar.google.com/', 'Google Calendar - Week of 29 September 2026', 'office'],
  ['https://www.notion.so/', 'Notion – Your connected workspace', 'office'],
  ['https://trello.com/', 'Boards | Trello', 'office'],
  ['https://www.figma.com/', 'Figma: The Collaborative Interface Design Tool', 'design'],
  ['https://www.canva.com/', 'Canva: Visual Suite', 'design'],
  ['https://www.coursera.org/', 'Coursera | Degrees, Certificates, & Free Online Courses', 'learn'],
  ['https://www.khanacademy.org/', 'Khan Academy | Free Online Courses, Lessons & Practice', 'learn'],
  ['https://www.duolingo.com/', 'Duolingo - The best way to learn a language', 'learn'],
  ['https://www.bundesregierung.de/', 'Startseite | Bundesregierung', 'admin'],
  ['https://www.gov.uk/', 'Welcome to GOV.UK', 'admin'],
  ['https://www.service-public.fr/', "Service-Public.fr — Le site officiel de l'administration française", 'admin'],
  ['https://www.usa.gov/', 'USAGov | Making it easier to find government information and services', 'admin'],
  ['https://www.gov.pl/', 'Serwis Rzeczypospolitej Polskiej - Gov.pl', 'admin'],
  ['https://www.coinbase.com/', 'Coinbase - Buy and sell Bitcoin, Ethereum, and more', 'money']
];

test('planner, owner-window fixture: 100 real URLs plan exactly 10 honest groups', () => {
  const { tabs, labels } = windowFrom(OWNER_WINDOW);
  const locked = socialsOf(tabs);
  assert.equal(locked[0].tabIds.length, 5);

  const plan = planGroups(tabs, labels, { locked });
  assert.equal(plan.K, 10);
  // urls100.txt holds 100 URLs; the spec's list (from a 98-entry prototype)
  // gives Learning 25, and the two extra learning sites land there too.
  assert.deepEqual(nameSizes(plan), [
    ['Learning', 27], ['News', 16], ['Coding', 10], ['Docs & Email & Admin', 10],
    ['Media & Sports', 10], ['Shopping & Money', 7], ['Travel', 7], ['Food & Home', 6],
    ['Socials', 5], ['Design', 2]
  ]);
  assert.deepEqual(plan.flags, []);
  assert.deepEqual(plan.reviewTabIds, []);
  assertCoverage(plan.groups, tabs.map(tab => tab.id));
  assert.deepEqual(groupOf(plan, 81).tabIds, locked[0].tabIds, 'Socials keep their exact membership');
});

test('planner, measured-failure fixture: 103 tabs over 15 categories keep food and travel whole', () => {
  const rows = [
    ...categoryTabs([
      ['food', 18], ['travel', 14], ['dev', 22], ['ai', 9], ['shop', 7], ['money', 4], ['news', 6],
      ['video', 5], ['health', 3], ['cars', 2], ['events', 2], ['games', 2], ['home', 3], ['admin', 3]
    ]),
    ['https://x.com/someone', 'Post on X', 'news'],
    ['https://www.reddit.com/r/cooking/', 'r/cooking', 'food'],
    ['https://www.instagram.com/', 'Instagram', 'video']
  ];
  const { tabs, labels } = windowFrom(rows);
  const plan = planGroups(tabs, labels, { locked: socialsOf(tabs) });

  assert.equal(tabs.length, 103);
  assert.equal(plan.groups.length, 10);
  const foodIds = tabs.slice(0, 18).map(tab => tab.id);
  const travelIds = tabs.slice(18, 32).map(tab => tab.id);
  const food = groupOf(plan, foodIds[0]);
  assert.equal(food.name, 'Food & Recipes');
  assert.ok(foodIds.every(id => food.tabIds.includes(id)));
  const travel = groupOf(plan, travelIds[0]);
  assert.ok(travelIds.every(id => travel.tabIds.includes(id)));
  assert.ok(plan.groups.every(group => group.name !== 'Other'));
  assertCoverage(plan.groups, tabs.map(tab => tab.id));
});

test('planner, low variety: one topic stays one group unless a sub-topic is large', () => {
  const coding = windowFrom(categoryTabs([['dev', 30]]));
  const single = planGroups(coding.tabs, coding.labels);
  assert.deepEqual(nameSizes(single), [['Coding', 30]]);

  const rows = [];
  for (let i = 0; i < 40; i++) {
    const title = i < 16 ? `React Hq${i}k` : i < 28 ? `Rust Hq${i}k` : `Hq${i}k Pz${i}m`;
    rows.push([`https://dev${i}.example/post`, title, 'dev']);
  }
  const { tabs, labels } = windowFrom(rows);
  const plan = planGroups(tabs, labels);
  assert.ok(plan.groups.length <= 8);
  assert.deepEqual(nameSizes(plan), [['React', 16], ['Coding', 12], ['Rust', 12]]);
  assert.ok(plan.groups.filter(group => group.kind === 'split').every(group => group.key.startsWith('split:dev:')));

  const oneSite = windowFrom(Array.from({ length: 12 }, (_, i) => [`https://intranet-portal.example/page/${i}`, `Kx${i} Vb${i}`, null]));
  const siteOnly = planGroups(oneSite.tabs, oneSite.labels);
  assert.equal(siteOnly.groups.length, 1);
  assert.equal(siteOnly.groups[0].kind, 'site');
  assert.equal(siteOnly.groups[0].name, 'Intranet Portal');

  const labelledOneSite = windowFrom(Array.from({ length: 12 }, (_, i) => [`https://intranet-portal.example/page/${i}`, `Kx${i} Vb${i}`, 'office']));
  assert.equal(planGroups(labelledOneSite.tabs, labelledOneSite.labels).groups.length, 1);
});

test('planner, small coherent groups survive under the ceiling', () => {
  const thirty = windowFrom(categoryTabs([['dev', 12], ['food', 8], ['news', 6], ['health', 2], ['cars', 2]]));
  const plan = planGroups(thirty.tabs, thirty.labels);
  assert.equal(plan.K, 7);
  assert.deepEqual(nameSizes(plan), [['Coding', 12], ['Food & Recipes', 8], ['News', 6], ['Cars', 2], ['Health', 2]]);

  const twelve = windowFrom(categoryTabs([['dev', 4], ['food', 3], ['travel', 2], ['news', 2], ['shop', 1]]));
  const small = planGroups(twelve.tabs, twelve.labels);
  assert.equal(small.K, 4);
  assert.equal(small.groups.length, 4);
  const shopTab = twelve.tabs[11].id;
  assert.equal(groupOf(small, shopTab).name, 'Shopping', 'the shop singleton keeps its subject');
  assert.notEqual(groupOf(small, shopTab), groupOf(small, 10));
});

test('planner, screenshot cohort: correct labels and cold local fallback keep unrelated tabs apart', () => {
  const rows = [
    ['https://x.com/home', 'Home / X', 'admin'],
    ['https://appstoreconnect.apple.com/apps', 'App Store Connect', 'dev'],
    ['https://login.example/login', 'Login', 'admin'],
    ['https://github.com/owner?tab=repositories', 'Your Repositories', 'dev'],
    ['http://192.168.1.15/admin', 'Pi-hole dashboard', 'infra'],
    ['https://www.bbc.co.uk/news', 'UK | Latest News & Updates | BBC News', 'news'],
    ['https://chatgpt.com/c/one', 'Create Visual Technical Site', 'ai'],
    ['https://chatgpt.com/c/two', 'Apple Review Explained', 'ai'],
    ['https://unknown-downloads.example/', 'Mac downloads', null],
    ['https://grok.com/imagine', 'Grok Imagine', 'ai'],
    ['https://chatgpt.com/', 'ChatGPT', 'ai'],
    ['https://unknown-media.example/', 'Downloads', null],
    ['https://platform.openai.com/settings/organization/general', 'Organization settings - OpenAI', 'ai'],
    ['https://ambassadors.openai.com/welcome', 'Welcome | Codex Ambassador', 'ai'],
    ['https://www.ebay.co.uk/', 'eBay UK | Electronics, Cars, Fashion', 'shop'],
    ['https://maps.google.com/', 'Google Maps', 'travel'],
    ['https://analytics.google.com/', 'analytics.google.com', 'biz'],
    ['https://app.envato.com/', 'Envato App', 'design']
  ];
  const { tabs, labels } = windowFrom(rows);
  const localLabels = new Map(tabs.map(tab => [tab.id, inferLocalLabel(tab)]));
  for (const source of [labels, localLabels]) {
    const plan = planGroups(tabs, source, { locked: socialsOf(tabs) });
    assert.ok(plan.groups.length > plan.K, 'coherence takes precedence over the preferred count');
    assert.ok(plan.groups.length <= 10);
    assertCoverage(plan.groups, tabs.map(tab => tab.id));
    for (const id of [6, 15, 16]) {
      assert.notEqual(groupOf(plan, id), groupOf(plan, 2), `${tabs[id - 1].title} never joins coding`);
      assert.notEqual(groupOf(plan, id), groupOf(plan, 11), `${tabs[id - 1].title} never joins AI`);
    }
    assert.equal(groupOf(plan, 9).kind, 'review');
    assert.equal(groupOf(plan, 12).kind, 'review');
    assert.equal(groupOf(plan, 6).categories.includes('news'), true);
    assert.equal(groupOf(plan, 15).categories.includes('shop'), true);
    assert.equal(groupOf(plan, 16).categories.includes('travel'), true);
  }
});

test('planner, measured 23-tab window: late folders and cached advice cannot create a 13-tab technical bucket', () => {
  const socialRows = [
    ['https://x.com/home', 'Home / X', 'news'],
    ['https://www.reddit.com/', 'Reddit', 'read'],
    ['https://www.linkedin.com/feed/', 'LinkedIn', 'biz'],
    ['https://discord.com/channels/@me', 'Discord', 'mail']
  ];
  const { tabs, labels } = windowFrom([
    ...categoryTabs([['dev', 4], ['ai', 2], ['infra', 7], ['design', 1], ['biz', 2], ['shop', 1], ['jobs', 1], ['learn', 1]]),
    ...socialRows
  ]);
  const locked = socialsOf(tabs);
  const check = groups => {
    assertCoverage(groups, tabs.map(tab => tab.id));
    assert.ok(groups.length <= 10);
    const coding = groupOf({ groups }, 1);
    const infrastructure = groupOf({ groups }, 7);
    assert.notEqual(coding, infrastructure, 'related technical categories still keep distinct focused groups');
    assert.deepEqual(coding.tabIds, [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(infrastructure.tabIds, [7, 8, 9, 10, 11, 12, 13]);
    assert.ok(groups.filter(group => !group.locked).every(group => group.tabIds.length <= 8));
    assert.deepEqual(groups.find(group => group.kind === 'social').tabIds, [20, 21, 22, 23]);
  };
  const plan = planGroups(tabs, labels, { locked });
  assert.equal(plan.K, 6);
  check(plan.groups);
  const oldAdvice = { 'cat:dev': 'cat:infra', 'cat:ai': 'cat:infra' };
  check(planGroups(tabs, labels, { locked, advice: oldAdvice }).groups);
  const technologyIds = plan.candidates.flatMap((candidate, index) =>
    candidate.categories.some(key => ['dev', 'ai', 'infra'].includes(key)) ? [index] : []);
  const folders = [{ name: 'Technology', ids: technologyIds }, ...plan.candidates.flatMap((candidate, index) =>
    technologyIds.includes(index) ? [] : [{ name: candidate.name, ids: [index] }])];
  const late = enforceFolders(folders, plan.candidates, 5, { n: 23, hardLimit: 9 });
  check([...locked, ...late.groups]);
  assert.ok(!('cat:dev' in late.advice) || late.advice['cat:dev'] !== 'cat:infra');
  check(planGroups(tabs, labels, { locked, advice: late.advice }).groups);
  check(enforceGroupCeiling([...locked, ...late.groups], { ceiling: 5 }));
});

test('planner, size repair: spare hard-limit slots split a broad category before provider candidates are captured', () => {
  const coding = Array.from({ length: 13 }, (_, i) => [
    `https://zq-shared.${i < 7 ? 'com' : 'org'}/page-${i}`, `${i < 7 ? 'Compiler' : 'Runtime'} Zq${i}x`, 'dev'
  ]);
  const { tabs, labels } = windowFrom([
    ...coding,
    ...categoryTabs([['design', 1], ['biz', 2], ['shop', 1], ['jobs', 1], ['learn', 1]], { startId: 14 }),
    ...Array.from({ length: 4 }, (_, i) => [`https://x.com/profile-${i}`, `Post ${i}`, 'news'])
  ]);
  const locked = socialsOf(tabs);
  const plan = planGroups(tabs, labels, { locked });
  assert.equal(plan.K, 6);
  const codingGroups = plan.groups.filter(group => group.categories?.includes('dev'));
  assert.deepEqual(codingGroups.map(group => group.tabIds.length).sort(), [6, 7]);
  assert.equal(plan.candidates.filter(group => group.categories.includes('dev')).length, 2,
    'the provider receives the split rows rather than the 13-tab parent');
  const ids = plan.candidates.flatMap((candidate, index) => candidate.categories.includes('dev') ? [index] : []);
  const late = enforceFolders([{ name: 'Technology', ids }], plan.candidates, 5, { n: 23, hardLimit: 9 });
  assert.deepEqual(late.groups.filter(group => group.categories.includes('dev')).map(group => group.tabIds.length).sort(), [6, 7]);
  assertCoverage([...locked, ...late.groups], tabs.map(tab => tab.id));
});

test('planner, size guard: shared tasks, atomic sites and explicit user groups keep their membership', () => {
  const taskRows = Array.from({ length: 13 }, (_, i) => [
    `https://project-${i}.example/`, `Atlas ${i < 7 ? 'Compiler' : 'Runtime'} Zq${i}x`, i % 2 ? 'dev' : 'ai'
  ]);
  const task = windowFrom([...taskRows, ...categoryTabs([['food', 8], ['news', 8]], { startId: 14 })]);
  const taskPlan = planGroups(task.tabs, task.labels);
  assert.equal(groupOf(taskPlan, 1).kind, 'task');
  assert.deepEqual(groupOf(taskPlan, 1).tabIds, Array.from({ length: 13 }, (_, i) => i + 1));
  const atomic = windowFrom([
    ...Array.from({ length: 13 }, (_, i) => [
      i < 7 ? `https://www.youtube.com/watch?v=${i}` : `https://youtu.be/${i}`,
      `${i < 7 ? 'Compiler' : 'Runtime'} Zq${i}x`, 'video'
    ]),
    ...categoryTabs([['dev', 2], ['infra', 2], ['shop', 2]], { startId: 14 })
  ]);
  const atomicPlan = planGroups(atomic.tabs, atomic.labels);
  assert.deepEqual(groupOf(atomicPlan, 1).tabIds, Array.from({ length: 13 }, (_, i) => i + 1));
  const userGroup = { name: 'Technology', nameSource: 'user', key: 'cat:dev', dominant: 'dev', tabIds: [1, 2, 3] };
  const enforced = enforceGroupCeiling([userGroup,
    { name: 'AI Tools', key: 'cat:ai', dominant: 'ai', tabIds: [4] }], { ceiling: 1 });
  assert.deepEqual(enforced.find(group => group.nameSource === 'user'), userGroup);
  const rows = [
    { name: 'Coding', key: 'cat:dev', dominant: 'dev', tabIds: Array.from({ length: 10 }, (_, i) => i + 1) },
    { name: 'AI Tools', key: 'cat:ai', dominant: 'ai', tabIds: Array.from({ length: 9 }, (_, i) => i + 11) }
  ];
  const fullWindow = enforceFolders([], rows, 1, { n: 100 });
  assert.equal(fullWindow.groups.length, 1, 'size admission uses the full window rather than only unprotected rows');
  assertCoverage(fullWindow.groups, Array.from({ length: 19 }, (_, i) => i + 1));
});

test('planner, preferred count: unrelated categories survive and affinity cannot bridge unrelated constituents', () => {
  const separate = windowFrom(categoryTabs([['dev', 2], ['news', 2], ['shop', 2], ['games', 2], ['health', 2]]));
  const plan = planGroups(separate.tabs, separate.labels);
  assert.equal(plan.K, 4);
  assert.equal(plan.groups.length, 5);
  const bridge = windowFrom(categoryTabs([['dev', 1], ['design', 1], ['biz', 1]]));
  const bridged = planGroups(bridge.tabs, bridge.labels);
  assert.equal(bridged.K, 1);
  assert.equal(bridged.groups.length, 2, 'Design cannot bridge unrelated Code and Business');
  assert.notEqual(groupOf(bridged, 1), groupOf(bridged, 3));
  assert.ok(bridged.groups.every(group => group.categories.length <= 2));
});

test('planner, hard maximum: unrelated overflow uses Review Later without duplicating cloud candidates', () => {
  const { tabs, labels } = windowFrom(Array.from({ length: 12 }, (_, site) =>
    Array.from({ length: 3 }, (_, tab) => [`https://unknown-${site}.example/p/${tab}`, `Zq${site}x Vb${tab}y`, null])).flat());
  const plan = planGroups(tabs, labels);
  assert.equal(plan.groups.length, 10);
  assert.equal(plan.reviewTabIds.length, 9);
  assertCoverage(plan.groups, tabs.map(tab => tab.id));
  const reviewIds = new Set(plan.reviewTabIds);
  assert.ok(plan.candidates.every(candidate => candidate.tabIds.every(id => !reviewIds.has(id))));
  assertCoverage([...plan.candidates, { tabIds: plan.reviewTabIds }], tabs.map(tab => tab.id));
});

test('planner, task promotion: a token across categories and sites becomes a task', () => {
  const rows = [
    ['https://www.tesla.com/modely', 'Tesla Model Y Long Range', 'cars'],
    ['https://www.tesla.com/cybertruck', 'Tesla Cybertruck Specs', 'cars'],
    ['https://www.tesla.com/supercharger', 'Tesla Supercharger Network', 'cars'],
    ['https://www.youtube.com/watch?v=a1', 'Tesla FSD Drive Through Tokyo', 'video'],
    ['https://www.youtube.com/watch?v=a2', 'Tesla Model 3 Highland Unboxing', 'video'],
    ['https://finance.yahoo.com/quote/TSLA', 'Tesla Stock Forecast', 'money'],
    // 'kernel' repeats on one site only; 'guide' and 'review' are generic.
    ['https://lwn.net/a/1', 'Kernel scheduler Qa1', 'dev'],
    ['https://lwn.net/a/2', 'Kernel memory Qa2', 'dev'],
    ['https://lwn.net/a/3', 'Kernel locking Qa3', 'dev'],
    ['https://lwn.net/a/4', 'Kernel release Qa4', 'news'],
    ['https://lwn.net/a/5', 'Kernel summit Qa5', 'news'],
    ['https://webpack.example/g', 'Webpack guide review', 'dev'],
    ['https://vite.example/g', 'Vite guide review', 'dev'],
    ['https://rollup.example/g', 'Rollup guide review', 'dev'],
    ['https://dev4.example/g', 'Esbuild Qb4', 'dev'],
    ['https://bread.example/r', 'Sourdough guide review', 'food'],
    ['https://pasta.example/r', 'Carbonara guide review', 'food'],
    ['https://cake.example/r', 'Cheesecake Qc3', 'food'],
    ['https://soup.example/r', 'Ramen Qc4', 'food'],
    ['https://salad.example/r', 'Tabbouleh Qc5', 'food'],
    ['https://curry.example/r', 'Vindaloo Qc6', 'food'],
    ['https://paper1.example/n', 'Election guide review', 'news'],
    ['https://paper2.example/n', 'Budget Qd2', 'news'],
    ['https://paper3.example/n', 'Weather Qd3', 'news'],
    ['https://paper4.example/n', 'Markets Qd4', 'news']
  ];
  const { tabs, labels } = windowFrom(rows);
  const plan = planGroups(tabs, labels);

  const tasks = plan.groups.filter(group => group.kind === 'task');
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].name, 'Tesla');
  assert.deepEqual(tasks[0].tabIds, [1, 2, 3, 4, 5, 6]);
  assert.equal(tasks[0].dominant, 'cars');
  assert.ok(plan.groups.every(group => !['Guide', 'Review', 'Kernel'].includes(group.name)));
  assert.ok(plan.groups.length <= plan.K);
});

test('planner, locked: rules and Socials keep their membership', () => {
  const rows = [
    ['https://x.com/a', 'Post', 'news'],
    ['https://www.reddit.com/r/homelab/', 'r/homelab', 'infra'],
    ['https://unifi.ui.com/devices', 'UniFi Devices', 'infra'],
    ['https://unifi.ui.com/clients', 'UniFi Clients', 'infra'],
    ['https://work.example/repo', 'Internal repo', 'dev'],
    ...categoryTabs([['dev', 5], ['food', 5], ['travel', 5]], { startId: 6 })
  ];
  const { tabs, labels } = windowFrom(rows);
  const locked = [
    { name: 'Home Lab', color: 'green', kind: 'rule', tabIds: [3, 4] },
    { name: 'Coding', color: 'purple', kind: 'rule', tabIds: [5] },
    ...socialsOf(tabs)
  ];
  const plan = planGroups(tabs, labels, { locked });
  assert.deepEqual(plan.groups.find(group => group.name === 'Socials').tabIds, [1, 2]);
  const homeLab = plan.groups.find(group => group.name === 'Home Lab');
  assert.deepEqual(homeLab.tabIds, [3, 4]);
  assert.equal(homeLab.color, 'green');
  const coding = plan.groups.filter(group => group.name === 'Coding');
  assert.equal(coding.length, 1, 'the unlocked Coding group merged into the rule');
  assert.equal(coding[0].kind, 'rule');
  assert.deepEqual([...coding[0].tabIds].sort((a, b) => a - b), [5, 6, 7, 8, 9, 10]);
  assert.ok(plan.groups.length <= plan.K);
  assertCoverage(plan.groups, tabs.map(tab => tab.id));

  const crowded = windowFrom(categoryTabs([['dev', 12], ['food', 6], ['travel', 6], ['news', 6]]));
  const rules = Array.from({ length: 12 }, (_, i) => ({ name: `Rule ${i + 1}`, color: 'grey', kind: 'rule', tabIds: [i + 1] }));
  const exceeded = planGroups(crowded.tabs, crowded.labels, { locked: rules });
  assert.equal(exceeded.K, 7);
  assert.equal(exceeded.groups.length, 13);
  assert.ok(exceeded.flags.includes('rules_exceed_ceiling'));
  const unlocked = exceeded.groups.filter(group => !group.locked);
  assert.equal(unlocked.length, 1);
  assert.equal(unlocked[0].tabIds.length, 18);
});

test('planner, locked: a candidate named like a rule joins it before the ceiling counts groups', () => {
  const rows = [
    ['https://www.bbc.co.uk/news/1', 'Story one', null],
    ['https://www.bbc.co.uk/news/2', 'Story two', null],
    ...categoryTabs([['news', 4], ['dev', 4], ['travel', 3], ['food', 3], ['shop', 2], ['health', 2]], { startId: 3 })
  ];
  const { tabs, labels } = windowFrom(rows);
  const plan = planGroups(tabs, labels, { locked: [{ name: 'News', color: 'blue', kind: 'rule', tabIds: [1, 2] }] });
  assert.equal(plan.K, 6);
  assert.equal(plan.groups.length, 6, 'the folded News candidate takes no ceiling slot');
  const rule = plan.groups.find(group => group.kind === 'rule');
  assert.equal(rule.name, 'News');
  assert.deepEqual(rule.tabIds, [1, 2, 3, 4, 5, 6]);
  assert.ok(rule.keys.includes('cat:news'));
  assert.deepEqual(groupOf(plan, 19).tabIds, [19, 20], 'Health is not merged while there is room');
  assertCoverage(plan.groups, tabs.map(tab => tab.id));

  // Consolidation rebuilds unlocked groups from plan.candidates, so they must
  // never hold a tab the rule already has.
  const ruleTabs = new Set(rule.tabIds);
  assert.ok(plan.candidates.every(candidate => candidate.tabIds.every(id => !ruleTabs.has(id))));
  assert.ok(!plan.candidates.some(candidate => candidate.keys.includes('cat:news')));
  const folders = plan.candidates.map((candidate, index) => ({ name: 'News', ids: [index] }));
  const { groups: folderGroups } = enforceFolders(folders, plan.candidates, plan.K - 1, {
    n: plan.n, takenNames: ['News', 'Review Later']
  });
  assert.ok(folderGroups.every(group => group.name !== 'News'));
  assertCoverage([rule, ...folderGroups], tabs.map(tab => tab.id));
});

test('planner, locked: split and fallback names never fold into a rule after candidates are taken', () => {
  // A 12-tab food group splits on its largest shared token, unless that token
  // is a rule's name.
  const food = windowFrom([
    ...Array.from({ length: 5 }, (_, i) => [`https://bake${i}.example/`, `Sourdough Kq${i}z`, 'food']),
    ...Array.from({ length: 4 }, (_, i) => [`https://pasta${i}.example/`, `Pasta Rq${i}z`, 'food']),
    ...Array.from({ length: 3 }, (_, i) => [`https://misc${i}.example/`, `Wm${i}x Yp${i}q`, 'food'])
  ]);
  const clubRule = [{ name: 'Bread Club', kind: 'rule', tabIds: [13] }];
  assert.equal(groupOf(planGroups(food.tabs, food.labels, { locked: clubRule }), 1).name, 'Sourdough');
  const sourdoughRule = [{ name: 'Sourdough', kind: 'rule', tabIds: [13] }];
  const split = planGroups(food.tabs, food.labels, { locked: sourdoughRule });
  assert.deepEqual(split.groups.find(group => group.kind === 'rule').tabIds, [13]);
  assert.equal(groupOf(split, 6).name, 'Pasta');
  assert.equal(split.groups.filter(group => group.name === 'Sourdough').length, 1);

  // A ceiling merge that would be called 'Docs & Admin' keeps its larger
  // side's name when a rule already has that one.
  const office = windowFrom(categoryTabs([['office', 4], ['admin', 3], ['dev', 3], ['food', 3], ['sport', 3], ['cars', 3], ['games', 3]]));
  const portal = { name: 'Intranet', kind: 'rule', tabIds: [23] };
  assert.equal(groupOf(planGroups(office.tabs, office.labels, { locked: [portal] }), 1).name, 'Docs & Admin');
  const merged = planGroups(office.tabs, office.labels, { locked: [{ ...portal, name: 'Docs & Admin' }] });
  assert.deepEqual(merged.groups.find(group => group.kind === 'rule').tabIds, [23]);
  assert.equal(groupOf(merged, 1).name, 'Docs & Planning');
  assert.deepEqual(groupOf(merged, 1).tabIds, [1, 2, 3, 4, 5, 6, 7]);

  // A task whose name contradicts a member's country falls back to its
  // category name. When a rule already has that name, the task is renamed,
  // not folded: its tabs are already in plan.candidates.
  const germany = windowFrom([
    ['https://rail-pass.example/de', 'Germany rail pass tips', 'travel'],
    ['https://roadtrips.example/de', 'Germany road trip route', 'travel'],
    ['https://www.lemonde.fr/international', 'Germany election results', 'news'],
    ...categoryTabs([['dev', 6], ['food', 6]], { startId: 4 })
  ]);
  const plan = planGroups(germany.tabs, germany.labels, { locked: [{ name: 'Travel', kind: 'rule', tabIds: [16] }] });
  assert.deepEqual(plan.groups.find(group => group.kind === 'rule').tabIds, [16]);
  const task = groupOf(plan, 1);
  assert.equal(task.kind, 'task');
  assert.deepEqual(task.tabIds, [1, 2, 3]);
  assert.notEqual(task.name.toLowerCase(), 'travel');
  assert.ok(task.name.startsWith('Travel'));
  assert.ok(plan.candidates.some(candidate => candidate.key === task.key));

  const renamed = ensureUniqueNames([
    { name: 'News', kind: 'rule', locked: true, tabIds: [1] },
    { name: 'news', key: 'task:1', tabIds: [2, 3] }
  ], [], { joinLocked: false });
  assert.deepEqual(renamed.map(group => [group.name, group.tabIds]), [['News', [1]], ['news 2', [2, 3]]]);
});

test('planner, loose tabs: unknown tabs keep a neutral review queue, repeated sites keep their names', () => {
  const labelled = categoryTabs([
    ['dev', 3], ['food', 3], ['travel', 3], ['news', 3], ['shop', 3],
    ['health', 3], ['cars', 3], ['jobs', 3], ['home', 3], ['design', 3]
  ]);
  const loose = Array.from({ length: 20 }, (_, i) => [`https://oneoff${i}.example/x`, `Lq${i}r Mt${i}s`, null]);
  const { tabs, labels } = windowFrom([...labelled, ...loose]);
  const plan = planGroups(tabs, labels);
  assert.equal(plan.K, 10);
  assert.ok(plan.groups.length <= plan.K);
  const review = plan.groups.filter(group => group.kind === 'review');
  assert.equal(review.length, 1);
  assert.equal(review[0].name, 'Review Later');
  assert.equal(review[0].color, 'grey');
  assert.deepEqual(review[0].tabIds, tabs.slice(30).map(tab => tab.id), 'Review Later is never merged');
  assert.deepEqual(plan.reviewTabIds, review[0].tabIds);
  assert.ok(!plan.candidates.some(candidate => candidate.kind === 'review'));

  const few = windowFrom([...categoryTabs([['dev', 10], ['food', 10], ['travel', 10]]), ...loose.slice(0, 2)]);
  const fewPlan = planGroups(few.tabs, few.labels);
  assert.deepEqual(fewPlan.reviewTabIds, [31, 32], 'even two unknowns are never scattered into known topics');
  assertCoverage(fewPlan.groups, few.tabs.map(tab => tab.id));

  const offline = windowFrom([
    ...Array.from({ length: 5 }, (_, i) => [`https://wiki.acme-intranet.example/p/${i}`, `Ab${i}c`, null]),
    ...Array.from({ length: 4 }, (_, i) => [`https://tracker.bugzone.example/b/${i}`, `De${i}f`, null]),
    ...Array.from({ length: 21 }, (_, i) => [`https://single${i}.example/`, `Gh${i}j`, null])
  ]);
  const offlinePlan = planGroups(offline.tabs, offline.labels);
  assert.deepEqual(
    offlinePlan.groups.map(group => [group.kind, group.tabIds.length]).sort(),
    [['review', 21], ['site', 4], ['site', 5]]
  );
  assert.ok(offlinePlan.groups.every(group => group.name !== 'Other'));
});

test('planner, loose tabs attach to a candidate whose titles they share', () => {
  const rows = [
    ...Array.from({ length: 6 }, (_, i) => [`https://kitchen${i}.example/`, `Sourdough starter Kq${i}`, 'food']),
    ...categoryTabs([['dev', 6], ['news', 6]], { startId: 7 }),
    ['https://unknown-bakery.example/', 'Sourdough starter feeding', null]
  ];
  const { tabs, labels } = windowFrom(rows);
  const plan = planGroups(tabs, labels);
  assert.equal(groupOf(plan, 19).name, 'Food & Recipes');
});

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

test('planner, naming: merged names, regional fallback, uniqueness and validation', () => {
  assert.equal(mergedName({ name: 'Docs & Planning', size: 7 }, { name: 'Accounts & Admin', size: 5 }), 'Docs & Admin');
  assert.equal(mergedName({ name: 'Coding', size: 8 }, { name: 'AI Tools', size: 2 }), 'Code & AI');
  assert.equal(mergedName({ name: 'AI Tools', tabIds: [1, 2] }, { name: 'Coding', tabIds: [3, 4, 5, 6, 7] }), 'Code & AI');
  assert.equal(mergedName({ name: 'Code & AI', size: 10 }, { name: 'Cloud & Servers', size: 1 }), 'Code & AI & Cloud');
  assert.equal(mergedName({ name: 'Travel', size: 3 }, { name: 'Travel', size: 3 }), 'Travel');
  assert.equal(shortOf('Watch & Listen'), 'Media');
  assert.equal(shortOf('Japan & Food'), 'Japan');
  assert.equal(shortOf('Japan Trip'), 'Japan Trip');

  // A task named after Germany with a French member falls back to its category.
  const germany = windowFrom([
    ['https://rail-pass.example/de', 'Germany rail pass tips', 'travel'],
    ['https://roadtrips.example/de', 'Germany road trip route', 'travel'],
    ['https://www.lemonde.fr/international', 'Germany election results', 'news'],
    ...categoryTabs([['dev', 6], ['food', 6]], { startId: 4 })
  ]);
  const germanyPlan = planGroups(germany.tabs, germany.labels);
  const task = groupOf(germanyPlan, 1);
  assert.deepEqual(task.tabIds, [1, 2, 3]);
  assert.equal(task.kind, 'task');
  assert.equal(task.name, 'Travel');
  assert.ok(germanyPlan.groups.every(group => group.name !== 'Germany'));

  // A 'travel' task beside the Travel category must not share its name.
  const collide = windowFrom([
    ['https://blog-a.example/', 'Travel insurance compared', 'money'],
    ['https://blog-b.example/', 'Travel adapters that work', 'shop'],
    ['https://blog-c.example/', 'Travel vaccines checklist', 'health'],
    ...categoryTabs([['travel', 6], ['dev', 6]], { startId: 4 })
  ]);
  const collidePlan = planGroups(collide.tabs, collide.labels);
  const names = collidePlan.groups.map(group => group.name.toLowerCase());
  assert.equal(new Set(names).size, names.length);
  assert.ok(collidePlan.groups.some(group => group.kind === 'task'));

  const tabsById = new Map([
    [1, { id: 1, url: 'https://www.booking.com/a' }],
    [2, { id: 2, url: 'https://www.booking.com/b' }],
    [3, { id: 3, url: 'https://www.airbnb.com/c' }],
    [4, { id: 4, url: 'https://www.airbnb.com/d' }],
    [5, { id: 5, url: 'https://www.airbnb.com/e' }],
    [9, { id: 9, url: 'https://x.com/a' }],
    [10, { id: 10, url: 'https://example.org/' }]
  ]);
  const unique = ensureUniqueNames([
    { name: 'Socials', kind: 'social', locked: true, tabIds: [9] },
    { name: 'Travel', key: 'cat:travel', tabIds: [3, 4, 5] },
    { name: 'travel', key: 'task:1', tabIds: [1, 2] },
    { name: 'socials', key: 'task:2', tabIds: [10] }
  ], [], { tabsById });
  assert.deepEqual(unique.map(group => [group.name, group.tabIds]), [
    ['Socials', [9, 10]],
    ['Travel', [3, 4, 5]],
    ['travel · Booking', [1, 2]]
  ]);
  const numbered = ensureUniqueNames([
    { name: 'Travel', key: 'a', tabIds: [1, 2, 3] },
    { name: 'Travel', key: 'b', tabIds: [4] }
  ]);
  assert.deepEqual(numbered.map(group => group.name), ['Travel', 'Travel 2']);

  const polishGroup = { tabIds: [1, 2] };
  const polishTabs = new Map([
    [1, { id: 1, url: 'https://www.gov.pl/web/gov' }],
    [2, { id: 2, url: 'https://www.gov.it/' }]
  ]);
  assert.equal(validateGroupName('Other'), null);
  assert.equal(validateGroupName('Misc'), null);
  assert.equal(validateGroupName('example.com'), null);
  assert.equal(validateGroupName('A very long folder name that keeps going on and on'), null);
  assert.equal(validateGroupName('Review Later'), null);
  assert.equal(validateGroupName('One Two Three Four Five'), null);
  assert.equal(validateGroupName('Southern Europe', polishGroup, polishTabs), null);
  assert.equal(validateGroupName('Travel', null, null, ['Coding', 'travel']), null);
  assert.equal(validateGroupName('Japan Trip'), 'Japan Trip');
  assert.equal(validateGroupName('Küche'), 'Küche');
  assert.equal(validateGroupName('  Japan   Trip ✈️ '), 'Japan Trip');
  assert.equal(validateGroupName('Ｋüche'), 'Küche', 'NFKC folds full-width letters');
});

test('planner, validateGroupName: vague and decorative model names keep the category name', () => {
  for (const vague of ['Technology', 'Tech', 'Online Stores', 'Online Services', 'Web Tools', 'Sites & Links', 'Culinary Delights', 'Travel Adventures']) {
    assert.equal(validateGroupName(vague), null, vague);
  }
  for (const plain of ['Productivity Tools', 'AI Tools', 'World News', 'Sports Highlights', 'Space Exploration', 'Food & Recipes']) {
    assert.equal(validateGroupName(plain), plain, plain);
  }
});

test('planner, transferNames: a user name outranks the generic-name rules', () => {
  const group = {
    name: 'Docs & Planning', key: 'cat:office', keys: ['cat:office'], kind: 'category', color: 'blue',
    tabIds: [1, 2, 3, 4, 5, 6], nameSource: 'deterministic'
  };
  const other = { name: 'Travel', key: 'cat:travel', keys: ['cat:travel'], kind: 'category', tabIds: [7, 8] };
  const tabsById = new Map([1, 2, 3, 4, 5, 6].map(id => [id, { id, url: `https://docs${id}.example.fr/`, title: 'Plan' }]));
  const fingerprintById = new Map([1, 2, 3, 4, 5, 6].map(id => [id, `f${id}`]));
  const user = n => ({ names: [{ k: [], w: [], f: ['f1', 'f2', 'f3', 'f4', 'f5'], n, c: 'red', s: 'user', t: 10 }] });
  const nameFor = n => transferNames([group, other], user(n), { tabsById, fingerprintById })[0];

  for (const [raw, expected] of [
    ['Work', 'Work'],
    ['Research', 'Research'],
    ['My Big Client Project Folder', 'My Big Client Project Folder'],
    ['Q3 🚀 Launch', 'Q3 🚀 Launch'],
    ['Japan Trip', 'Japan Trip'],
    ['Client Phoenix – Q3 planning docs', 'Client Phoenix – Q3 planning']
  ]) {
    const named = nameFor(raw);
    assert.equal(named.name, expected, raw);
    assert.equal(named.nameSource, 'memory-user', raw);
    assert.equal(named.color, 'red', raw);
  }
  for (const raw of ['   ', 'Review Later', 'travel']) {
    const kept = nameFor(raw);
    assert.equal(kept.name, 'Docs & Planning', `${raw} is not applied`);
    assert.equal(kept.nameSource, 'deterministic');
  }

  // Model names still go through validateGroupName.
  const model = { names: [{ k: ['cat:office'], w: [], n: 'Work', s: 'cloud', t: 10 }] };
  assert.equal(transferNames([group], model, { tabsById, tokensById: new Map() })[0].name, 'Docs & Planning');
});

test('planner, transferNames: user renames stick, drifted model names do not', () => {
  const group = {
    name: 'Travel', key: 'cat:travel', keys: ['cat:travel'], kind: 'category', color: 'blue',
    tabIds: [1, 2, 3, 4, 5, 6], nameSource: 'deterministic'
  };
  const fingerprintById = new Map([1, 2, 3, 4, 5, 6].map(id => [id, `f${id}`]));
  const userMemory = {
    names: [{ k: ['cat:travel'], w: [], f: ['f1', 'f2', 'f3', 'f4', 'f-closed'], n: 'Japan Trip', c: 'red', s: 'user', t: 10 }]
  };
  const [renamed] = transferNames([group], userMemory, { fingerprintById });
  assert.equal(renamed.name, 'Japan Trip');
  assert.equal(renamed.nameSource, 'memory-user');
  assert.equal(renamed.color, 'red');
  assert.equal(group.name, 'Travel', 'input is not mutated');

  const japanTabs = new Map([
    [11, { id: 11, url: 'https://a.example/', title: 'Kyoto temples in autumn' }],
    [12, { id: 12, url: 'https://b.example/', title: 'Kyoto ryokan booking' }],
    [13, { id: 13, url: 'https://c.example/', title: 'Japanese rail pass Kyoto' }]
  ]);
  const japanTokens = new Map([...japanTabs].map(([id, tab]) => [id, titleTokens(tab)]));
  const modelRecord = {
    k: ['cat:travel'], w: groupTokenHashes({ tabIds: [11, 12, 13] }, japanTokens), n: 'Japan Trip', s: 'cloud', t: 20
  };
  assert.ok(modelRecord.w.length > 0 && modelRecord.w.every(hash => /^[0-9a-f]{8}$/.test(hash)));

  const parisTabs = new Map([
    [21, { id: 21, url: 'https://d.example/', title: 'Paris museum pass' }],
    [22, { id: 22, url: 'https://e.example/', title: 'Louvre opening hours Paris' }],
    [23, { id: 23, url: 'https://f.example/', title: 'Montmartre walking tour' }]
  ]);
  const parisGroup = { ...group, tabIds: [21, 22, 23] };
  const [paris] = transferNames([parisGroup], { names: [modelRecord] }, { tabsById: parisTabs });
  assert.equal(paris.name, 'Travel');
  assert.equal(paris.nameSource, 'deterministic');

  const japanGroup = { ...group, tabIds: [11, 12, 13] };
  const [japan] = transferNames([japanGroup], { names: [modelRecord] }, { tabsById: japanTabs, tokensById: japanTokens });
  assert.equal(japan.name, 'Japan Trip');
  assert.equal(japan.nameSource, 'memory-model');

  const [lockedGroup] = transferNames([{ ...group, kind: 'social', locked: true, name: 'Socials' }], userMemory, { fingerprintById });
  assert.equal(lockedGroup.name, 'Socials', 'locked names never change');
});

// ---------------------------------------------------------------------------
// Consolidation and the safety net
// ---------------------------------------------------------------------------

test('planner, enforceFolders: repairs a messy consolidation answer', () => {
  const spec = [
    ['dev', 10], ['ai', 3], ['travel', 8], ['events', 7], ['food', 6], ['news', 5], ['read', 2],
    ['shop', 4], ['money', 2], ['games', 2], ['video', 4], ['health', 3], ['sport', 3], ['admin', 3]
  ];
  let nextId = 1;
  const candidates = spec.map(([key, count]) => ({
    key: `cat:${key}`,
    keys: [`cat:${key}`],
    name: { dev: 'Coding', ai: 'AI Tools', travel: 'Travel', events: 'Events', food: 'Food & Recipes', news: 'News', read: 'Reading', shop: 'Shopping', money: 'Money', games: 'Gaming', video: 'Watch & Listen', health: 'Health', sport: 'Sports', admin: 'Accounts & Admin' }[key],
    dominant: key,
    kind: 'category',
    tabIds: Array.from({ length: count }, () => nextId++)
  }));
  const folders = [
    { name: 'Coding', ids: [0] },
    { name: 'AI', ids: [1] },
    { name: 'Misc', ids: [2, 3] },
    { name: 'Cooking', ids: [4] },
    { name: 'News', ids: [5] },
    { name: 'Reading', ids: [6, 0] },
    { name: 'Shopping', ids: [7] },
    { name: 'Finance', ids: [8, 99, -1, 'x'] },
    { name: 'Games', ids: [9] },
    { name: 'Videos', ids: [10] },
    { name: 'Health', ids: [11] },
    { name: 'Sports', ids: [12] }
  ];
  const run = () => enforceFolders(folders, candidates, 8);
  const { groups, advice } = run();
  assert.deepEqual(run(), { groups, advice }, 'deterministic');

  assert.ok(groups.length <= 8);
  const allKeys = groups.flatMap(group => group.keys).sort();
  assert.deepEqual(allKeys, candidates.map(candidate => candidate.key).sort(), 'every candidate exactly once');
  assertCoverage(groups, candidates.flatMap(candidate => candidate.tabIds));

  const holder = key => groups.find(group => group.keys.includes(key));
  assert.notEqual(holder('cat:admin'), holder('cat:money'), 'omission cannot force Admin into a Shopping/Money folder');
  assert.ok(holder('cat:dev').keys.includes('cat:dev') && !holder('cat:read').keys.includes('cat:dev'), 'a duplicate keeps its first folder');
  assert.ok(groups.every(group => group.name !== 'Misc'));
  assert.equal(holder('cat:travel').name, 'Travel & Events');
  assert.equal(holder('cat:travel').nameSource, 'deterministic');
  assert.equal(holder('cat:food').name, 'Cooking');
  assert.equal(holder('cat:food').nameSource, 'model');

  const sizeOf = key => candidates.find(candidate => candidate.key === key).tabIds.length;
  for (const group of groups) {
    const anchor = [...group.keys].sort((a, b) => sizeOf(b) - sizeOf(a) || (a < b ? -1 : 1))[0];
    assert.equal(group.key, anchor);
    for (const key of group.keys) {
      if (key === anchor) assert.ok(!(key in advice));
      else assert.equal(advice[key], anchor);
    }
  }
});

test('planner, enforceFolders: hostile folders cannot mix unrelated topics or hide a minority name', () => {
  const candidates = [
    { key: 'cat:dev', keys: ['cat:dev'], name: 'Coding', dominant: 'dev', tabIds: [1, 2, 3] },
    { key: 'cat:ai', keys: ['cat:ai'], name: 'AI Tools', dominant: 'ai', tabIds: [4] },
    { key: 'cat:shop', keys: ['cat:shop'], name: 'Shopping', dominant: 'shop', tabIds: [5] },
    { key: 'cat:travel', keys: ['cat:travel'], name: 'Travel', dominant: 'travel', tabIds: [6] }
  ];
  const { groups, advice } = enforceFolders([{ name: 'Coding', ids: [0, 1, 2, 3] }], candidates, 1);
  assert.equal(groups.length, 3, 'the preferred count cannot require unrelated consolidation');
  const coding = groups.find(group => group.tabIds.includes(1));
  assert.deepEqual(coding.tabIds, [1, 2, 3, 4]);
  assert.equal(coding.name, 'Code & AI');
  assert.deepEqual(coding.categories, ['dev', 'ai']);
  assert.notEqual(groups.find(group => group.tabIds.includes(5)), coding);
  assert.notEqual(groups.find(group => group.tabIds.includes(6)), coding);
  assert.equal(advice['cat:ai'], 'cat:dev');
  assert.ok(!('cat:shop' in advice));
  assertCoverage(groups, [1, 2, 3, 4, 5, 6]);
  const concealed = enforceFolders([{ name: 'Coding', ids: [0, 1] }], candidates.slice(0, 2), 2);
  assert.equal(concealed.groups[0].name, 'Code & AI', 'a coherent mixed folder still needs an honest name');
});

test('planner, final safety: a dominant category cannot bridge unrelated members or overwrite a user name', () => {
  const groups = [
    { name: 'Design & Business', key: 'cat:design', keys: ['cat:design', 'cat:biz'], dominant: 'design', tabIds: [1, 2] },
    { name: 'Coding', key: 'cat:dev', keys: ['cat:dev'], dominant: 'dev', tabIds: [3, 4] },
    { name: 'My workspace', key: 'user', dominant: 'dev', tabIds: [5], nameSource: 'memory-user' }
  ];
  const result = enforceGroupCeiling(groups, { ceiling: 1 });
  assert.equal(result.length, 3);
  assert.deepEqual(result.find(group => group.nameSource === 'memory-user').tabIds, [5]);
  assert.equal(result.find(group => group.nameSource === 'memory-user').name, 'My workspace');
  const overflow = enforceGroupCeiling(Array.from({ length: 12 }, (_, i) => ({
    name: `Site ${i}`, key: `site:${i}`, tabIds: [i + 1]
  })), { ceiling: 4 });
  assert.equal(overflow.length, 10);
  assert.equal(overflow.find(group => group.kind === 'review').tabIds.length, 3);
  assertCoverage(overflow, Array.from({ length: 12 }, (_, i) => i + 1));
});

test('planner, names: model and remembered fixed-category names cannot hide mixed subjects', () => {
  const mixed = { name: 'Code & AI', kind: 'folder', keys: ['cat:dev', 'cat:ai'], dominant: 'dev', tabIds: [1, 2] };
  assert.equal(validateGroupName('Coding', mixed), null);
  assert.equal(validateGroupName('AI Tools', mixed), null);
  assert.equal(validateGroupName('Project Atlas', mixed), 'Project Atlas');
  assert.equal(validateGroupName('Coding', { ...mixed, kind: 'task' }), 'Coding', 'shared-task evidence permits its task name');
  const [remembered] = transferNames([mixed], { names: [{ n: 'Coding', k: mixed.keys, w: [], s: 'cloud' }] });
  assert.equal(remembered.name, 'Code & AI');
});

test('planner, enforceGroupCeiling: 25 groups over 120 tabs become at most 10', () => {
  let nextId = 1;
  const make = (name, count, extra = {}) => ({ name, color: 'blue', tabIds: Array.from({ length: count }, () => nextId++), ...extra });
  const categories = [
    ['dev', 'Coding', 10], ['ai', 'AI Tools', 1], ['design', 'Design', 4], ['office', 'Docs & Planning', 5],
    ['biz', 'Business', 4], ['jobs', 'Jobs', 3], ['learn', 'Learning', 6], ['news', 'News', 7],
    ['video', 'Watch & Listen', 6], ['shop', 'Shopping', 6], ['travel', 'Travel', 8], ['food', 'Food & Recipes', 7],
    ['home', 'Home', 4], ['health', 'Health', 3], ['cars', 'Cars', 3], ['admin', 'Accounts & Admin', 5]
  ];
  const groups = [
    make('Socials', 5, { kind: 'social', locked: true }),
    make('Home Lab', 3),
    ...categories.map(([key, name, count]) => make(name, count, { dominant: key, key: `cat:${key}` })),
    ...[['Japan Trip', 5], ['Project Atlas', 5], ['Garden Plans', 4], ['Wedding', 4], ['Tax Year', 4], ['Moving House', 4], ['Book Club', 4]]
      .map(([name, count]) => make(name, count))
  ];
  assert.equal(groups.length, 25);
  const allIds = groups.flatMap(group => group.tabIds);
  assert.equal(allIds.length, 120);

  const run = () => enforceGroupCeiling(groups, { ceiling: 10, protectedNames: ['Home Lab'] });
  const result = run();
  assert.deepEqual(run(), result, 'identical across runs');
  assert.ok(result.length <= 10);
  assertCoverage(result, allIds);
  assert.deepEqual(result.find(group => group.name === 'Socials').tabIds, groups[0].tabIds);
  assert.deepEqual(result.find(group => group.name === 'Home Lab').tabIds, groups[1].tabIds);
  const aiTab = groups.find(group => group.name === 'AI Tools').tabIds[0];
  const devTab = groups.find(group => group.name === 'Coding').tabIds[0];
  assert.ok(result.find(group => group.tabIds.includes(aiTab)).tabIds.includes(devTab), 'the smallest group joins its affinity partner');
  assert.ok(result.every(group => group.name && group.name.length <= 30 && group.name !== 'Other'));

  // No-op when the plan already fits.
  const fitting = groups.slice(0, 5);
  assert.deepEqual(enforceGroupCeiling(fitting, { ceiling: 10 }), fitting);

  // dominantOf supplies categories for groups that carry none.
  const custom = enforceGroupCeiling([
    { name: 'A', tabIds: [1, 2, 3] },
    { name: 'B', tabIds: [4] },
    { name: 'C', tabIds: [5, 6] }
  ], { ceiling: 2, dominantOf: group => ({ A: 'dev', B: 'ai', C: 'food' })[group.name] });
  assert.deepEqual(custom.map(group => [group.name, group.tabIds]), [['Code & AI', [1, 2, 3, 4]], ['C', [5, 6]]]);
});

test('planner, advice: unrelated cached consolidation pairs are rejected', () => {
  // 7 categories of 3 tabs: n = 21, K = 6, so exactly one merge is needed.
  const { tabs, labels } = windowFrom(categoryTabs([
    ['dev', 3], ['food', 3], ['travel', 3], ['news', 3], ['cars', 3], ['health', 3], ['jobs', 3]
  ]));
  const carsTab = 13;
  const newsTab = 10;
  const travelTab = 7;
  const withoutAdvice = planGroups(tabs, labels);
  assert.equal(withoutAdvice.K, 6);
  assert.equal(withoutAdvice.groups.length, 6);
  assert.equal(groupOf(withoutAdvice, carsTab), groupOf(withoutAdvice, travelTab), 'by affinity cars join travel');

  const withAdvice = planGroups(tabs, labels, { advice: { 'cat:cars': 'cat:news' } });
  assert.equal(withAdvice.groups.length, 6);
  assert.notEqual(groupOf(withAdvice, carsTab), groupOf(withAdvice, newsTab), 'unrelated advice cannot mix Cars into News');
  assert.equal(groupOf(withAdvice, carsTab), groupOf(withAdvice, travelTab));
  assert.equal(planSignature(withAdvice.groups), planSignature(withoutAdvice.groups));

  // Advice never forces a merge below the ceiling.
  const roomy = planGroups(tabs.slice(0, 18), labels, { advice: { 'cat:cars': 'cat:news' } });
  assert.notEqual(groupOf(roomy, carsTab), groupOf(roomy, newsTab));
});

// ---------------------------------------------------------------------------
// Local inference and tokens
// ---------------------------------------------------------------------------

test('planner, local inference: sites, lexicon, affinity and title tokens', () => {
  const expected = [
    ['https://en.wikipedia.org/wiki/Photosynthesis', 'learn'],
    ['https://github.com/org/repo', 'dev'],
    ['https://mail.google.com/mail/u/0/', 'mail'],
    ['https://www.booking.com/', 'travel'],
    ['https://www.bbc.co.uk/news', 'news'],
    ['https://medium.com/@someone/post', 'read'],
    ['https://www.google.com/search?q=x', null],
    ['https://www.google.com/maps/place/x', 'travel'],
    ['https://www.gov.pl/', 'admin'],
    ['https://www.tesla.com/', 'cars'],
    ['https://unknown-site.example/', null],
    ['not a url', null]
  ];
  for (const [url, key] of expected) assert.equal(categoryFromSite(url), key, url);

  assert.equal(categoryFromTitle('Beste Rezept für Kuchen'), 'food');
  assert.equal(categoryFromTitle('Cheap flights to Rome'), 'travel');
  assert.equal(categoryFromTitle('簡単レシピ'), 'food', 'CJK words are segmented without spaces');
  assert.equal(categoryFromTitle('Quarterly planning notes'), 'office');
  assert.equal(categoryFromTitle(''), null);

  const repoTabs = [
    { id: 1, url: 'https://github.com/org/repo/pulls', title: 'Pull requests' },
    { id: 2, url: 'https://github.com/org/repo/issues/4', title: 'Bug report' },
    { id: 3, url: 'https://www.youtube.com/watch?v=1', title: 'Ramen at home' },
    { id: 4, url: 'https://www.youtube.com/watch?v=2', title: 'Knife skills' },
    { id: 5, url: 'https://pizza.example/a', title: 'Dough' },
    { id: 6, url: 'https://pizza.example/b', title: 'Oven' }
  ];
  const labels = new Map([
    [1, 'dev'], [2, { c: 'dev', e: 'gemini_nano' }], [3, 'food'], [4, 'food'],
    [5, { c: 'food', src: 'site' }], [6, { c: 'food', src: 'lexicon' }]
  ]);
  const ctx = buildLocalContext(repoTabs, labels);
  assert.equal(ctx.bySite.get('pizza'), undefined, 'provisional labels never feed affinity');
  assert.deepEqual(inferLocalLabel({ id: 7, url: 'https://github.com/org/repo/wiki', title: 'Home' }, ctx), { c: 'dev', src: 'site-affinity' });
  assert.deepEqual(inferLocalLabel({ id: 8, url: 'https://www.youtube.com/watch?v=3', title: 'Something' }, ctx), { c: 'video', src: 'site' });
  assert.deepEqual(inferLocalLabel({ id: 9, url: 'https://pizza.example/c', title: 'Easy pizza recipe' }, ctx), { c: 'food', src: 'lexicon' });
  assert.equal(inferLocalLabel({ id: 10, url: 'https://pizza.example/d', title: 'Zqx' }, ctx), null);

  assert.equal(labelPriority({ url: 'https://github.com/org/repo/x', title: 'x' }, ctx), 3);
  assert.equal(labelPriority({ url: 'https://www.booking.com/', title: 'x' }, ctx), 2);
  assert.equal(labelPriority({ url: 'https://pizza.example/e', title: 'Weekly recipes' }, ctx), 1);
  assert.equal(labelPriority({ url: 'https://pizza.example/f', title: 'Zqx' }, ctx), 0);

  const tokens = tab => [...titleTokens(tab)].sort();
  assert.deepEqual(tokens({ url: 'https://en.wikipedia.org/wiki/P', title: 'Photosynthesis in plants - Wikipedia' }), ['photosynthesi', 'plant']);
  assert.deepEqual(tokens({ url: 'https://de.wikipedia.org/wiki/Q', title: 'Quantenmechanik und Relativität – Wikipedia' }), ['quantenmechanik', 'relativität']);
  assert.deepEqual(tokens({ url: 'https://blog.example/', title: 'The best guide to Japanese temples for 2026' }), ['japan', 'temple']);
  assert.deepEqual(tokens({ url: 'https://github.com/rust-lang/rust', title: 'GitHub Actions for Rust' }), ['action', 'rust']);
  assert.deepEqual(tokens({ url: 'https://cookpad.com/jp', title: '寿司の作り方' }), ['作り方', '寿司']);
  assert.deepEqual(tokens({ url: 'https://ko.wikipedia.org/', title: '한글 - 위키백과' }), ['위키백과', '한글']);
});

test('planner, tokens: numbers and version strings never name a task or a split', () => {
  const tokens = title => [...titleTokens({ url: 'https://blog.example/', title })].sort();
  assert.deepEqual(tokens('iOS 18.1 hands-on'), ['hand', 'ios']);
  assert.deepEqual(tokens('Python 3.13 changelog'), ['changelog', 'python']);
  assert.deepEqual(tokens('Laptop £1,299 or 19.99 monthly'), ['laptop', 'monthly']);
  assert.deepEqual(tokens('Release v2.0.1 and v10 changelog'), ['changelog', 'release']);
  assert.deepEqual(tokens('ES2015 x86 mp3 player'), ['es2015', 'mp3', 'player', 'x86']);

  const rows = [
    ['https://www.macrumors.com/2026/ios-review', 'iOS 18.1 hands-on review', 'news'],
    ['https://www.theverge.com/2026/ios-features', 'iOS 18.1 new features explained', 'news'],
    ['https://www.youtube.com/watch?v=abc', 'iOS 18.1 walkthrough video', 'video'],
    ['https://developer.apple.com/documentation/ios-release-notes', 'iOS 18.1 release notes', 'dev'],
    ...categoryTabs([['food', 4], ['travel', 4], ['shop', 4], ['health', 4], ['money', 4]], { startId: 5 })
  ];
  const { tabs, labels } = windowFrom(rows);
  const task = planGroups(tabs, labels).groups.find(group => group.kind === 'task');
  assert.equal(task.name, 'iOS');
  assert.deepEqual(task.tabIds, [1, 2, 3, 4]);
});
