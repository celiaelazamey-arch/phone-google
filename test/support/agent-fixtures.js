import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSqliteDriver } from '../../src/agent/drivers.js';
import { createAgentStore } from '../../src/agent/store.js';
import { createToolRegistry, RISK } from '../../src/agent/tools.js';
import { createCalendarConnector, createConnectorRegistry } from '../../src/agent/connectors.js';

export async function createTempStore({ clock = null } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'celia-agent-test-'));
  const file = path.join(directory, 'agent.sqlite3');
  const driver = await createSqliteDriver({ path: file });
  const store = createAgentStore({ driver, ...(clock ? { clock } : {}) });
  return {
    store,
    driver,
    file,
    directory,
    async reopen() {
      await driver.close();
      const nextDriver = await createSqliteDriver({ path: file });
      const nextStore = createAgentStore({ driver: nextDriver, ...(clock ? { clock } : {}) });
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
      requiresApproval: true,
      connector: 'google.calendar'
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

/**
 * Fake Google Calendar transport for tests. It records every request so a test can
 * prove "exactly one send", and it can be told to fail before the provider acts
 * (definitive) or after the request may have landed (ambiguous → unknown).
 */
export function createFakeCalendar({ failWith = null, duplicate = false } = {}) {
  const sends = [];
  let sequence = 0;
  const transport = {
    async insertEvent({ calendarId, event, signal }) {
      sends.push({ calendarId, event, at: Date.now() });
      if (failWith === 'ambiguous') {
        throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      }
      if (failWith === 'definitive') {
        throw Object.assign(new Error('bad request'), { status: 400, code: 'invalid' });
      }
      if (failWith === 'unauthorized') {
        throw Object.assign(new Error('not connected'), { status: 409 });
      }
      if (duplicate) {
        throw Object.assign(new Error('duplicate iCalUID'), { status: 409, code: 'duplicate' });
      }
      sequence += 1;
      return { id: `evt-${sequence}`, htmlLink: `https://calendar.example/${sequence}`, iCalUID: event.iCalUID };
    }
  };
  const connectors = createConnectorRegistry([createCalendarConnector({ transport })]);
  return { sends, transport, connectors };
}

/** Connector registry whose `send` throws a chosen error, for classifier tests. */
export function createFailingConnectors(error, name = 'google.calendar') {
  const calls = [];
  const registry = createConnectorRegistry([
    {
      name,
      description: 'failing connector',
      async send(payload, options) {
        calls.push({ payload, ...options });
        throw error;
      }
    }
  ]);
  return { calls, connectors: registry };
}
