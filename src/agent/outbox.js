import crypto from 'node:crypto';
import { hashOf, sha256Text } from './evidence.js';

/**
 * Transactional outbox for external effects (AGENT-002).
 *
 * The runtime never calls an external connector directly. It enqueues one durable
 * intent, the owner decides, and exactly one dispatcher may turn that intent into
 * a request. The guarantees this module is built to keep:
 *
 * - **One intent per effect.** The idempotency key is derived from the run, the
 *   tool and the payload hash, and the store refuses a second live row for the same
 *   (run, tool). A re-entered loop or a crashed process cannot mint a duplicate.
 * - **One send per intent.** Dispatch requires a conditional claim from `pending`.
 *   A row already `dispatching` is never re-claimed: if its lease expired, the
 *   request may have reached the provider, so it settles `unknown` and waits for
 *   reconciliation (AGENTS.md: never replay external mutations blindly).
 * - **Honest failure classes.** `failed` means the provider definitively rejected
 *   the request before any effect (auth, validation, rate-limit-free 4xx). Anything
 *   ambiguous — timeout, reset, 5xx, an abort mid-flight — is `unknown`, never a
 *   silent success and never a blind retry.
 */

export const OUTBOX_STATUS = Object.freeze({
  pending: 'pending',
  dispatching: 'dispatching',
  sent: 'sent',
  failed: 'failed',
  unknown: 'unknown',
  cancelled: 'cancelled'
});

const TERMINAL = new Set([
  OUTBOX_STATUS.sent,
  OUTBOX_STATUS.failed,
  OUTBOX_STATUS.unknown,
  OUTBOX_STATUS.cancelled
]);

/** Statuses that prove a later enqueue for the same effect must not be created. */
const LIVE = new Set([OUTBOX_STATUS.pending, OUTBOX_STATUS.dispatching, OUTBOX_STATUS.sent, OUTBOX_STATUS.unknown]);

export function isTerminalOutboxStatus(status) {
  return TERMINAL.has(status);
}

export function isLiveOutboxStatus(status) {
  return LIVE.has(status);
}

/**
 * Stable key for one intent: `outbox:<runId>:<12-hex>`. The digest covers the tool
 * name and the canonical payload, so identical replays collide (good) and a genuinely
 * different effect gets its own key. Length stays under the 120-char column limit.
 */
export function outboxKey({ runId, toolName, payload }) {
  const digest = sha256Text(`${toolName}|${hashOf(payload ?? null)}`).slice(0, 12);
  return `outbox:${runId}:${digest}`;
}

/** A connector that knows nothing reached the provider marks the error definitive. */
export function definitiveError(code, message = code) {
  return Object.assign(new Error(message), { code, definitive: true });
}

/** Short, safe error token: never the raw provider body (SECURITY.md rule). */
export function safeConnectorCode(error) {
  const status = Number(error?.status ?? error?.response?.status);
  if (Number.isInteger(status) && status >= 400 && status < 600) return `http_${status}`;
  const raw = String(error?.code || '').trim();
  if (/^[A-Za-z0-9_.-]{1,60}$/.test(raw)) return raw.toLowerCase();
  return 'connector_failed';
}

/**
 * `failed` only when the provider provably did not act. 408/429 are explicitly
 * ambiguous: the request may have been processed before the timeout/limit reply.
 */
export function classifyConnectorError(error) {
  if (error?.definitive === true) return OUTBOX_STATUS.failed;
  const status = Number(error?.status ?? error?.response?.status);
  if (Number.isInteger(status) && status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return OUTBOX_STATUS.failed;
  }
  return OUTBOX_STATUS.unknown;
}

export function createOutbox({
  store,
  connectors = { get: () => null },
  clock = Date.now,
  workerId = `outbox-${crypto.randomBytes(3).toString('hex')}`,
  leaseMs = 30_000
} = {}) {
  if (!store) throw new Error('Outbox requires the durable agent store');
  if (!connectors || typeof connectors.get !== 'function') {
    throw new Error('Outbox requires a connector registry');
  }

  const outbox = {
    /** Durably record the intent before anyone is asked to approve it. */
    async enqueue({ runId, stepId = null, approvalId = null, toolName, connector, payload = null }) {
      const idempotencyKey = outboxKey({ runId, toolName, payload });
      return store.enqueueOutbox({
        runId,
        stepId,
        approvalId,
        toolName,
        connector,
        idempotencyKey,
        payload
      });
    },

    /** Attach the approval row created after the intent (gate order: intent → decision). */
    async linkApproval(outboxId, approvalId) {
      return store.linkOutboxApproval(outboxId, approvalId);
    },

    /**
     * Turn one intent into at most one request. Never throws for a provider error:
     * the settled row is the durable report.
     */
    async dispatch(outboxId, { signal } = {}) {
      const entry = await store.getOutbox(outboxId);
      if (!entry) return { dispatched: false, status: 'missing', entry: null };
      if (isTerminalOutboxStatus(entry.status)) {
        return { dispatched: false, status: entry.status, entry };
      }
      if (entry.status === OUTBOX_STATUS.dispatching) {
        if (entry.leaseUntil && Date.parse(entry.leaseUntil) > clock()) {
          return { dispatched: false, status: 'in_progress', entry };
        }
        // The previous holder died mid-flight: the request may already have landed.
        const settled = await store.settleOutbox(outboxId, {
          status: OUTBOX_STATUS.unknown,
          lastError: 'lease_expired_after_dispatch'
        });
        return { dispatched: true, status: OUTBOX_STATUS.unknown, entry: settled, error: 'outcome_unknown' };
      }

      const connector = connectors.get(entry.connector);
      if (!connector) {
        // No transport exists: nothing was attempted, so this is a definitive non-effect.
        const settled = await store.settleOutbox(outboxId, {
          status: OUTBOX_STATUS.failed,
          lastError: 'connector_unavailable'
        });
        return { dispatched: false, status: OUTBOX_STATUS.failed, entry: settled, error: 'connector_unavailable' };
      }

      const claimed = await store.claimOutbox(outboxId, { leaseMs, workerId });
      if (!claimed) {
        return { dispatched: false, status: 'in_progress', entry: await store.getOutbox(outboxId) };
      }

      try {
        const result = await connector.send(entry.payload, {
          idempotencyKey: entry.idempotencyKey,
          signal
        });
        const settled = await store.settleOutbox(outboxId, {
          status: OUTBOX_STATUS.sent,
          externalRef: result?.externalRef ?? null,
          result: result ?? null
        });
        return { dispatched: true, status: OUTBOX_STATUS.sent, entry: settled, result: result ?? null };
      } catch (error) {
        const status = classifyConnectorError(error);
        const settled = await store.settleOutbox(outboxId, {
          status,
          lastError: safeConnectorCode(error)
        });
        return { dispatched: true, status, entry: settled, error: safeConnectorCode(error) };
      }
    },

    /**
     * Safety net for intents whose dispatcher vanished. Marks them `unknown`; it
     * never re-sends, because the outcome is exactly what is unknown.
     */
    async recoverStale({ limit = 20 } = {}) {
      const stale = await store.findStaleOutbox({ limit });
      const recovered = [];
      for (const entry of stale) {
        const settled = await store.settleOutbox(entry.id, {
          status: OUTBOX_STATUS.unknown,
          lastError: 'lease_expired_after_dispatch'
        });
        recovered.push(settled);
      }
      return { recovered };
    },

    async list(runId) {
      return store.listOutbox(runId);
    }
  };

  return outbox;
}
