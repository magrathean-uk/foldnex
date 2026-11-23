// Helpers of lib.mjs that need the per-tab label pipeline, removed from src/ in Phase 4. They moved here
// unchanged; only historical scripts import them. The pipeline arrives through legacy-labels.mjs, which
// stops the script with a message when it is gone (check out c669dcb to run it). Not product code.
import { planGroups, inferLocalLabel, buildLocalContext, LABEL_CATEGORIES } from './legacy-labels.mjs';
import { taskMin } from './frozen.mjs';
import { affinity, agglomerate, embed, mulberry32, score, urlWords } from './lib.mjs';

export function inferredLabels(tabs) {
  const labels = new Map();
  const ctx = buildLocalContext(tabs, labels);
  for (const tab of tabs) {
    const inferred = inferLocalLabel(tab, ctx);
    if (inferred) labels.set(tab.id, inferred);
  }
  return labels;
}

export function planAssignment(tabs, labels, locked = []) {
  const plan = planGroups(tabs, labels, { locked });
  const assignment = new Map();
  plan.groups.forEach((group, index) => group.tabIds.forEach(id => assignment.set(id, index)));
  return { assignment, groups: plan.groups };
}

/** Semantic task clusters as locked groups; the planner places every other tab. */
export function semanticTasks(model, tabs, config) {
  const n = tabs.length;
  const clusters = agglomerate(affinity(model, tabs, config), n, { tau: config.tau });
  return clusters
    .filter(cluster => cluster.length >= taskMin(n) && cluster.length <= 0.5 * n)
    .map((cluster, index) => ({ name: `Semantic ${index + 1}`, color: 'blue', kind: 'rule', tabIds: cluster.map(i => tabs[i].id) }));
}

// Generic words only, no brand names: a hand-made stand-in for a trained
// classifier, so its accuracy is a floor for what a trained one should reach.
export const KEYWORDS = {
  dev: 'programming code software developer api documentation repository pull request issues sdk framework library debugging compiler javascript python swift extension',
  ai: 'ai artificial intelligence chatbot llm language model prompt machine learning assistant neural embeddings inference tokens',
  infra: 'cloud server hosting console vps network firewall dns domain linux kubernetes docker deployment ssh vpn router',
  design: 'design fonts typography icons illustration ui ux mockup colour palette photo stock creative',
  office: 'document spreadsheet notes calendar meeting project board tasks planning slides presentation wiki',
  mail: 'email inbox mail messages chat messaging compose',
  biz: 'marketing ads advertising analytics seo sales crm campaign ecommerce store admin conversion',
  jobs: 'jobs careers hiring salary cv resume interview recruiter vacancy apply role',
  learn: 'course tutorial lesson learn encyclopedia reference science university lecture textbook definition',
  news: 'news breaking headlines politics world economy report latest live update',
  read: 'blog essay article book novel forum discussion newsletter long read opinion',
  video: 'video watch film movie tv series episode music playlist podcast streaming radio song',
  games: 'game gaming console esports gameplay walkthrough multiplayer',
  sport: 'sport football premier league match score fixtures team tennis cricket marathon results',
  shop: 'shop buy price deal product review basket cart delivery order compare discount',
  money: 'bank banking account payment invoice tax vat investing stocks isa insurance mortgage crypto pension bill',
  travel: 'travel flight hotel trip itinerary booking train rail map route destination holiday airport',
  food: 'recipe cooking food restaurant dinner baking ingredients cuisine menu',
  home: 'home house property kitchen furniture diy garden renovation tiles decor estate',
  health: 'health fitness workout running exercise medical symptoms doctor nutrition sleep',
  cars: 'car cars vehicle electric driving used dealer charger motorbike',
  events: 'event tickets concert festival meetup gig conference show',
  admin: 'government account settings security password support help service council passport visa licence'
};

export function centroidLabels(model, tabs, texts) {
  const prototypes = embed(model, LABEL_CATEGORIES.map(category => [texts(category), '']));
  const vectors = embed(model, tabs.map(tab => [tab.title, urlWords(tab.url)]));
  const labels = new Map();
  tabs.forEach((tab, index) => {
    let best = -Infinity;
    let key = null;
    prototypes.forEach((prototype, c) => {
      let dot = 0;
      for (let d = 0; d < model.dim; d++) dot += prototype[d] * vectors[index][d];
      if (dot > best) {
        best = dot;
        key = LABEL_CATEGORIES[c].key;
      }
    });
    labels.set(tab.id, key);
  });
  return labels;
}

export const hintLabels = (model, tabs) => centroidLabels(model, tabs, category => `${category.name}. ${category.hint}`);
export const keywordLabels = (model, tabs) => centroidLabels(model, tabs, category => `${category.name} ${category.hint} ${KEYWORDS[category.key]}`);

/** The site taxonomy where it knows the site, keyword centroids everywhere else. */
export function siteThenKeywordLabels(model, tabs) {
  const labels = keywordLabels(model, tabs);
  for (const [id, value] of inferredLabels(tabs)) if (value.src === 'site') labels.set(id, value.c);
  return labels;
}

export function noisyLabels(tabs, accuracy, seed) {
  const random = mulberry32(seed);
  const keys = LABEL_CATEGORIES.map(category => category.key);
  return new Map(tabs.map(tab => {
    if (random() < accuracy) return [tab.id, tab.cat];
    const others = keys.filter(key => key !== tab.cat);
    return [tab.id, others[Math.floor(random() * others.length)]];
  }));
}

export const f1Of = (tabs, labels, locked = []) => score(planAssignment(tabs, labels, locked).assignment, tabs).f1;
