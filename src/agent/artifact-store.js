import crypto from 'node:crypto';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { EVIDENCE_KIND } from './evidence.js';

/**
 * M-B/B2 — owner-facing artifact store.
 *
 * Publishes sandbox outputs (already exported post-exit and hash-verified by
 * `readArtifact`) into a durable local store with a DB registry row, an
 * `artifact_published` entry in the evidence chain, and an HMAC-signed download
 * link with an explicit expiry. Three invariants, all fail-closed:
 *
 * 1. Content is verified against the declared SHA-256 **on publish** — a byte
 *    that changed between sandbox export and publication aborts the call.
 * 2. Content is re-hashed **on every download** — tampering with the stored
 *    file after delivery surfaces as `artifact_tampered`, never as silent bytes.
 * 3. The signed link is the whole authorization: no signature, wrong signature
 *    or an elapsed expiry refuses with a coded error. There is no unsigned path.
 *
 * Idempotency lives in the database: (run_id, source_artifact_id) is unique, so
 * a retried `artifact.create` returns the existing row when the digest matches
 * and refuses with `artifact_conflict` when it does not.
 */

const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
// هوية رمزية آمنة (حتى 64) — منفّذ العزل الحقيقي يولّد UUIDs، والنمط هنا لا
// يفترض تفاصيله الداخلية؛ الحماية الفعلية في التوقيع والبصمة لا في شكل المعرف.
const ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function coded(code, status, cause) {
  const error = new Error(code);
  error.code = code;
  if (status) error.status = status;
  if (cause) error.cause = cause;
  return error;
}

function uniqueViolation(error) {
  return (
    error?.code === 'ER_DUP_ENTRY' ||
    error?.errno === 1062 ||
    /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(error?.message || '')
  );
}

export function createArtifactStore({
  store,
  rootDir,
  signingKey,
  urlTtlMs = 900_000,
  clock = Date.now,
  idFactory = crypto.randomUUID
} = {}) {
  if (!store) throw new Error('Artifact store requires the durable agent store');
  if (typeof rootDir !== 'string' || !rootDir.trim()) throw new Error('Artifact store requires an explicit rootDir');
  if (typeof signingKey !== 'string' || signingKey.length < 32) {
    // Refusing a weak key at boot beats forging-resistant-looking URLs later.
    throw coded('artifact_signing_key_weak');
  }
  const ttl = Number(urlTtlMs);
  if (!Number.isInteger(ttl) || ttl < 1_000 || ttl > 86_400_000) throw coded('artifact_url_ttl_outside_bounds');
  const root = path.resolve(rootDir);

  const sign = (artifactId, exp) =>
    crypto.createHmac('sha256', signingKey).update(`${artifactId}\n${exp}`).digest('hex');

  function signedDownload(record, now = clock()) {
    const exp = now + ttl;
    const sig = sign(record.id, exp);
    return {
      path: `/api/agent/artifacts/${record.id}/download?exp=${exp}&sig=${sig}`,
      exp,
      expiresAt: new Date(exp).toISOString()
    };
  }

  const publicView = (record) => ({
    id: record.id,
    runId: record.runId,
    name: record.name,
    bytes: record.bytes,
    sha256: record.sha256,
    createdAt: record.createdAt
  });

  return {
    urlTtlMs: ttl,
    rootDir: root,

    /**
     * Persists verified sandbox output. `declared` comes from the executor's
     * manifest (already digest-checked by `readArtifact`); we still re-hash the
     * bytes we were handed so a corrupted hand-off cannot be published.
     */
    async publish({ runId, ownerId, name, content, declared } = {}) {
      if (typeof runId !== 'string' || !runId) throw coded('artifact_run_id_invalid', 400);
      if (typeof ownerId !== 'string' || !ownerId) throw coded('artifact_owner_invalid', 400);
      if (!Buffer.isBuffer(content)) throw coded('artifact_content_invalid', 400);
      const effectiveName = typeof name === 'string' && name ? name : declared?.name;
      if (!ARTIFACT_NAME.test(String(effectiveName || ''))) throw coded('artifact_name_invalid', 400);
      if (!ID_SHAPE.test(String(declared?.sourceArtifactId || ''))) throw coded('artifact_source_invalid', 400);
      if (typeof declared?.sandboxRunId !== 'string' || !declared.sandboxRunId) throw coded('artifact_source_invalid', 400);

      const digest = crypto.createHash('sha256').update(content).digest('hex');
      if (SHA256_HEX.test(String(declared?.sha256 || '')) === false) throw coded('artifact_declared_hash_invalid', 400);
      if (digest !== declared.sha256 || content.length !== Number(declared.bytes)) {
        // The bytes in hand are not the bytes the sandbox attested. Publish nothing.
        throw coded('artifact_hash_mismatch', 409);
      }

      const existing = await store.findArtifactBySource(runId, declared.sourceArtifactId);
      if (existing) {
        if (existing.sha256 === digest && existing.bytes === content.length) {
          return { record: existing, download: signedDownload(existing), replayed: true };
        }
        throw coded('artifact_conflict', 409);
      }

      const id = idFactory();
      const storagePath = path.join(root, id);
      await mkdir(root, { recursive: true, mode: 0o700 });
      // 'wx' — a fresh id must land on a fresh file; colliding silently is worse than failing.
      await writeFile(storagePath, content, { flag: 'wx', mode: 0o600 });

      let record;
      try {
        record = await store.insertArtifact({
          id,
          runId,
          ownerId,
          sandboxRunId: declared.sandboxRunId,
          sourceArtifactId: declared.sourceArtifactId,
          name: effectiveName,
          bytes: content.length,
          sha256: digest,
          storagePath
        });
      } catch (error) {
        if (uniqueViolation(error)) {
          // Lost a publish race: the DB row, not our memory, is the truth.
          const winner = await store.findArtifactBySource(runId, declared.sourceArtifactId);
          if (winner && winner.sha256 === digest) {
            return { record: winner, download: signedDownload(winner), replayed: true };
          }
          throw coded('artifact_conflict', 409, error);
        }
        throw error;
      }

      // The digest enters the evidence chain here; later downloads attest against it.
      await store.appendEvidence({
        runId,
        kind: EVIDENCE_KIND.artifactPublished,
        input: { sourceArtifactId: declared.sourceArtifactId, sandboxRunId: declared.sandboxRunId },
        output: { artifactId: record.id, name: record.name, bytes: record.bytes, sha256: record.sha256 },
        verdict: 'ALLOW'
      });

      return { record, download: signedDownload(record), replayed: false };
    },

    /**
     * M-B/B4 — internal read for an approved external export (Drive upload).
     *
     * This path is signature-free by design: the caller is the agent host inside the
     * dispatch of an approved effect, never a browser. What is *not* free is the
     * digest — the bytes are re-hashed right here, so an artifact altered on disk
     * after approval can never leave under the hash the owner approved. Every
     * refusal is coded and definitive, which lets the connector settle `failed`
     * without touching the provider.
     */
    async readForUpload({ id, runId = null } = {}) {
      const artifactId = String(id || '');
      if (!ID_SHAPE.test(artifactId)) throw coded('artifact_id_invalid', 400);
      const record = await store.getArtifact(artifactId);
      if (!record) throw coded('artifact_not_found', 404);
      if (runId && record.runId !== runId) throw coded('artifact_run_mismatch', 403);
      let content;
      try {
        content = await readFile(record.storagePath);
      } catch (error) {
        throw coded('artifact_payload_unavailable', 410, error);
      }
      const digest = crypto.createHash('sha256').update(content).digest('hex');
      if (digest !== record.sha256 || content.length !== record.bytes) {
        throw coded('artifact_tampered', 409);
      }
      return {
        id: record.id,
        runId: record.runId,
        name: record.name,
        bytes: record.bytes,
        sha256: record.sha256,
        content
      };
    },

    /** Owner-facing listing: public fields plus a fresh signed link per call. */
    async list(runId) {
      const records = await store.listArtifacts(runId);
      return records.map((record) => ({ ...publicView(record), download: signedDownload(record) }));
    },

    /**
     * Signature-authorized download. Order matters and is deliberate:
     * shape → signature → expiry → existence → digest. A caller without a valid
     * signature learns nothing, not even whether the artifact exists.
     */
    async open({ id, exp, sig } = {}) {
      const artifactId = String(id || '');
      const expiry = Number.parseInt(String(exp ?? ''), 10);
      const signature = String(sig || '');
      if (!ID_SHAPE.test(artifactId) || !Number.isFinite(expiry) || !/^[0-9a-f]{64}$/.test(signature)) {
        throw coded('artifact_signature_invalid', 401);
      }
      const expected = sign(artifactId, expiry);
      if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'))) {
        throw coded('artifact_signature_invalid', 401);
      }
      if (expiry <= clock()) throw coded('artifact_link_expired', 410);
      const record = await store.getArtifact(artifactId);
      if (!record) throw coded('artifact_not_found', 404);
      let content;
      try {
        content = await readFile(record.storagePath);
      } catch (error) {
        throw coded('artifact_payload_unavailable', 410, error);
      }
      const digest = crypto.createHash('sha256').update(content).digest('hex');
      if (digest !== record.sha256 || content.length !== record.bytes) {
        // The acceptance criterion of B2: tampering after delivery is detected
        // by digest and refused — the altered bytes are never served.
        throw coded('artifact_tampered', 409);
      }
      return { record: publicView(record), content };
    }
  };
}
