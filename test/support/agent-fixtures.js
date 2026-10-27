import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSqliteDriver } from '../../src/agent/drivers.js';
import { createAgentStore } from '../../src/agent/store.js';
import { createToolRegistry, RISK } from '../../src/agent/tools.js';

export async function createTempStore() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'celia-agent-test-'));
  const file = path.join(directory, 'agent.sqlite3');
  const driver = await createSqliteDriver({ path: file });
  const store = createAgentStore({ driver });
  return {
    store,
    driver,
    file,
    directory,
    async reopen() {
      await driver.close();
      const nextDriver = await createSqliteDriver({ path: file });
      const nextStore = createAgentStore({ driver: nextDriver });
      return { store: nextStore, driver: nextDriver };
    },
    cleanup() {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        /* best effort cleanup */
      }
    }
  };
}

/** Registry that records every execution so tests can prove "not replayed". */
export function createRecordingTools({ failTools = {}, slowMs = 0 } = {}) {
  const calls = [];
  const maybeDelay = async () => {
    if (slowMs > 0) await new Promise((resolve) => setTimeout(resolve, slowMs));
  };
  const tools = createToolRegistry([
    {
      name: 'read.alpha',
      description: 'alpha',
      risk: RISK.read,
      async execute(args) {
        calls.push({ name: 'read.alpha', args });
        await maybeDelay();
        if (failTools.alpha) throw new Error('alpha_failed');
        return { alpha: true, echo: args?.echo ?? null };
      }
    },
    {
      name: 'read.beta',
      description: 'beta',
      risk: RISK.read,
      async execute(args) {
        calls.push({ name: 'read.beta', args });
        await maybeDelay();
        if (failTools.beta) throw new Error('beta_failed');
        return { beta: true };
      }
    },
    {
      name: 'read.gamma',
      description: 'gamma',
      risk: RISK.read,
      async execute(args) {
        calls.push({ name: 'read.gamma', args });
        await maybeDelay();
        if (failTools.gamma) throw new Error('gamma_failed');
        return { gamma: true };
      }
    },
    {
      name: 'calendar.create',
      description: 'external effect',
      risk: RISK.externalEffect,
      requiresApproval: true
    },
    {
      name: 'sandbox.exec',
      description: 'irreversible',
      risk: RISK.irreversible,
      requiresApproval: true
    }
  ]);
  return { tools, calls };
}

export function threeReadsThenFinish() {
  return [
    { action: 'call', tool: 'read.alpha', args: { echo: 'a' } },
    { action: 'call', tool: 'read.beta', args: {} },
    { action: 'call', tool: 'read.gamma', args: {} }
  ];
}

/**
 * State-aware planner: chooses the first unobserved read, and finishes truthfully
 * when a call failed. This is how a resumed run knows what already happened.
 */
export function createObservedPlanner({ sequence = ['read.alpha', 'read.beta', 'read.gamma'], summary = 'اكتملت المهمة' } = {}) {
  return {
    name: 'observed',
    async plan({ toolRuns }) {
      const failedRun = [...toolRuns].reverse().find((toolRun) => toolRun.status !== 'succeeded');
      if (failedRun) {
        return { action: 'finish', failed: true, summary: `توقفت المهمة: فشل ${failedRun.toolName} (${failedRun.status}) ولم يُعد المحاولة.` };
      }
      for (const name of sequence) {
        const done = toolRuns.some((toolRun) => toolRun.toolName === name && toolRun.status === 'succeeded');
        if (!done) return { action: 'call', tool: name, args: {} };
      }
      return { action: 'finish', summary };
    }
  };
}
