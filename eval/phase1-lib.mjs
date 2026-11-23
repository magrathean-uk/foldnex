// Shared by the Phase 1 scripts (run-provider --matrix, run-engine, report-phase1). Not product code.
// The plan request itself comes from src/ai-engine.js; this file only holds the
// recording format: one unit per window and repeat, in the format the Phase 0 tooling reads.
import fs from 'node:fs';
import path from 'node:path';
import { MAX_GROUPS, PLAN_EXAMPLE_NAME, buildPlanSystem, buildPlanUser, planJsonSchema } from '../src/ai-engine.js';
import { readPlan, score } from './lib.mjs';

export { PLAN_EXAMPLE_NAME };

/** The plan request exactly as the product words it. */
export function planRequest(tabs) {
  return { system: buildPlanSystem(MAX_GROUPS), user: buildPlanUser(tabs), schema: planJsonSchema() };
}

/** Output budget requested for a window: the Phase 0 formula (the product may cap it lower, see run-engine). */
export const planOutputBudget = count => Math.max(1024, 400 + 12 * count);

/** Pairwise F1 of assignment b against assignment a over all tabs (a is the reference). */
export function agreement(a, b, tabs) {
  let tp = 0; let fp = 0; let fn = 0;
  for (let i = 0; i < tabs.length; i++) {
    for (let j = i + 1; j < tabs.length; j++) {
      const inA = a.get(tabs[i].id) === a.get(tabs[j].id);
      const inB = b.get(tabs[i].id) === b.get(tabs[j].id);
      if (inA && inB) tp++; else if (inB) fp++; else if (inA) fn++;
    }
  }
  const p = tp / (tp + fp || 1); const r = tp / (tp + fn || 1);
  return (2 * p * r) / (p + r || 1);
}

/** What an answer {folders:[{name, ids}]} contains: assignment, groups and raw id problems. */
export function readAnswer(answer, tabs) {
  const plan = readPlan(answer, tabs);
  let invalid = 0; let duplicates = 0;
  const seen = new Set();
  for (const folder of Array.isArray(answer?.folders) ? answer.folders : []) {
    for (const id of folder?.ids || []) {
      if (!Number.isInteger(id) || id < 0 || id >= tabs.length) invalid++;
      else if (seen.has(id)) duplicates++;
      else seen.add(id);
    }
  }
  return {
    assignment: plan.assignment, groups: plan.groups.filter(g => g.tabIds.length).length, left_out: plan.missing.length,
    invalid_ids: invalid, duplicate_ids: duplicates,
    names: plan.groups.map(g => g.name), group_sizes: plan.groups.map(g => g.tabIds.length)
  };
}

/**
 * One recorded unit. `facts` is readAnswer() of the answer, `request` a request
 * record (ok, status, error, wall_ms, tokens, sent), `extra` fields added as given.
 */
export function makeUnit({ window, repeat, tabs, answer, failed, wall_ms, input_tokens, output_tokens, thinking_tokens, cost_usd, request, extra = {} }) {
  const facts = readAnswer(answer, tabs);
  return {
    window, repeat, tabs: tabs.length, failed, wall_ms,
    input_tokens, output_tokens, thinking_tokens, cost_usd,
    score: score(facts.assignment, tabs), groups: facts.groups, left_out: facts.left_out,
    invalid_ids: facts.invalid_ids, duplicate_ids: facts.duplicate_ids,
    group_names: facts.names, group_sizes: facts.group_sizes,
    plan_example_name: PLAN_EXAMPLE_NAME,
    ...extra,
    requests: [request], answer, _assignment: facts.assignment
  };
}

/** Agreement between repeats of the same window: [{window, a, b, f1}] over successful units. */
export function stabilityOf(units, windows) {
  const byWindow = new Map();
  for (const unit of units) {
    if (unit.failed) continue;
    if (!byWindow.has(unit.window)) byWindow.set(unit.window, []);
    byWindow.get(unit.window).push(unit);
  }
  const out = [];
  for (const [name, list] of byWindow) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        out.push({ window: name, a: list[i].repeat, b: list[j].repeat, f1: agreement(list[i]._assignment, list[j]._assignment, windows[name]) });
      }
    }
  }
  return out;
}

/** Strip the in-memory assignment before a unit is written. */
export const forFile = ({ _assignment, ...unit }) => unit;

export const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

export function writeRun(dir, name, run) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify({ ...run, units: run.units.map(forFile) }, null, 1));
  return file;
}

export const meanOf = values => values.reduce((a, b) => a + b, 0) / (values.length || 1);
