#!/usr/bin/env node
/**
 * `npm run delegate -- <snapshot.json>` — read a delegation snapshot and print the decision.
 *
 * Snapshot shape (all of it is durable-state shaped; nothing is invented here):
 *   {
 *     "parent": { "runId": "run-…", "status": "running", "depth": 0,
 *                 "remainingSteps": 6, "remainingCostMicros": 40000,
 *                 "maxRisk": "internal_write", "tools": ["kb.search"], "evidenceIds": ["ev-1"] },
 *     "roster": [{ "id": "researcher", "tools": ["kb.search"], "maxRisk": "read" }],
 *     "tasks":  [{ "taskId": "t1", "agent": "researcher", "objective": "…", "steps": 3, "costMicros": 9000 }],
 *     "plan":   { … }            // optional: verify a stored plan instead of deciding again
 *   }
 *
 * Exit codes: 0 = every task accepted (or the stored plan verifies) · 1 = something was refused or
 * the plan does not verify · 2 = the snapshot is unusable. The contract decides; it never executes.
 */
import fs from 'node:fs';

import {
  checkDelegation,
  describeDelegation,
  planDelegation
} from '../src/agent/delegation.js';

const args = process.argv.slice(2);
const file = args.find((arg) => !arg.startsWith('--'));
const flag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const asJson = args.includes('--json');
const now = flag('--now');

if (!file) {
  console.error('الاستخدام: npm run delegate -- <snapshot.json> [--json] [--now ISO]');
  process.exit(2);
}

let snapshot;
try {
  snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (error) {
  console.error(`تعذّر قراءة اللقطة: ${error.message}`);
  process.exit(2);
}
if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
  console.error('اللقطة يجب أن تكون كائنًا يحمل parent وtasks.');
  process.exit(2);
}

const sources = {
  parent: snapshot.parent ? { depth: 0, ...snapshot.parent } : null,
  roster: snapshot.roster || [],
  tasks: Array.isArray(snapshot.tasks) ? snapshot.tasks : []
};

if (snapshot.plan) {
  const result = checkDelegation(snapshot.plan, sources, { now });
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log(`الخطة تطابق مصادرها — ${snapshot.plan.accepted?.length || 0} طفلًا، بصمة ${result.digest}.`);
  } else {
    console.log(`الخطة لا تطابق مصادرها — ${result.problems.length} تحريرًا:`);
    for (const problem of result.problems) console.log(`  ✕ ${problem.taskId || '—'}: ${problem.detail || problem.code}`);
  }
  process.exit(result.ok ? 0 : 1);
}

const plan = planDelegation(sources, { now });
if (asJson) console.log(JSON.stringify(plan, null, 2));
else console.log(describeDelegation(plan));
process.exit(plan.refused.length === 0 ? 0 : 1);
