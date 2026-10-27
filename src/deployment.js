/** Deployment state machine, independent of Docker for deterministic failure tests. */
const IMAGE =
  /^ghcr\.io\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+$/;

export function validateTarget(target) {
  if (!target || !IMAGE.test(target.image || ""))
    throw new Error("An immutable ghcr.io image@sha256:digest is required");
  if (!VERSION.test(target.version || ""))
    throw new Error("A stable SemVer version is required");
}

export function validateProbe(
  probe,
  target,
  { databaseSchema = 1, requireDurable = true } = {},
) {
  validateTarget(target);
  if (
    !probe?.ready ||
    !probe.storage?.available ||
    probe.release?.version !== target.version
  )
    throw new Error("Candidate readiness or release identity check failed");
  if (
    requireDurable &&
    (!probe.storage.durable || probe.storage.mode !== "mysql")
  )
    throw new Error(
      "Production deployment requires durable MySQL; memory mode must be explicitly allowed",
    );
  const db = probe.release.database;
  if (
    !Number.isInteger(databaseSchema) ||
    databaseSchema < 1 ||
    !db ||
    !Number.isInteger(db.minReadable) ||
    !Number.isInteger(db.maxReadable) ||
    db.minReadable > databaseSchema ||
    db.maxReadable < databaseSchema ||
    db.schema !== databaseSchema ||
    db.destructiveMigration !== false
  ) {
    throw new Error(
      "Database schema is incompatible; automatic/destructive migrations are not allowed",
    );
  }
  return {
    image: target.image,
    version: target.version,
    databaseSchema,
    storageMode: probe.storage.mode,
  };
}

export function emptyDeploymentState() {
  return { format: 1, active: null, previous: null, history: [] };
}

export async function transitionRelease({
  state,
  target,
  adapter,
  requireDurable = true,
  now = () => new Date().toISOString(),
}) {
  if (state.format !== 1 || !Array.isArray(state.history) || state.pending)
    throw new Error("Deployment state needs recovery before another switch");
  validateTarget(target);
  if (state.active?.image === target.image)
    throw new Error("This image is already active");
  if (state.active) validateTarget(state.active);
  const databaseSchema = state.active?.databaseSchema || 1;
  let activated = false;
  let journaled = false;
  let failed = false;
  try {
    const probe = await adapter.stage(target);
    const nextActive = validateProbe(probe, target, {
      databaseSchema,
      requireDurable,
    });
    if (state.active && state.active.storageMode !== nextActive.storageMode)
      throw new Error(
        "Storage mode changes require a separate data migration, not a code rollback",
      );
    await adapter.save({ ...state, pending: { target, startedAt: now() } });
    journaled = true;
    activated = true; // activate may fail AFTER Docker has replaced the previous container.
    await adapter.activate(target);
    validateProbe(await adapter.probeActive(), target, {
      databaseSchema,
      requireDurable,
    });
    const nextState = {
      format: 1,
      active: nextActive,
      previous: state.active,
      history: [
        {
          at: now(),
          from: state.active?.version || null,
          to: target.version,
          image: target.image,
        },
        ...state.history,
      ].slice(0, 20),
    };
    await adapter.save(nextState);
    return nextState;
  } catch (error) {
    failed = true;
    if (activated) {
      try {
        if (state.active) {
          await adapter.activate(state.active);
          validateProbe(await adapter.probeActive(), state.active, {
            databaseSchema,
            requireDurable,
          });
        } else {
          await adapter.deactivate();
        }
        await adapter.save(state);
      } catch {
        throw Object.assign(
          new Error(
            "MANUAL_RECOVERY_REQUIRED: previous release could not be restored; deployment journal retained",
          ),
          { code: "MANUAL_RECOVERY_REQUIRED", cause: error },
        );
      }
    } else if (journaled) {
      await adapter.save(state);
    }
    throw error;
  } finally {
    try {
      await adapter.discard();
    } catch {
      // Cleanup cannot conceal a transaction/rollback failure.
      if (!failed)
        throw new Error(
          "DEPLOYMENT_SAVED_CLEANUP_REQUIRED: inspect managed state and remove the orphan candidate",
        );
    }
  }
}

export async function recoverDeployment({
  state,
  adapter,
  requireDurable = true,
}) {
  if (!state.pending) throw new Error("No interrupted deployment to recover");
  if (state.active) {
    validateTarget(state.active);
    await adapter.activate(state.active);
    validateProbe(await adapter.probeActive(), state.active, {
      databaseSchema: state.active.databaseSchema,
      requireDurable,
    });
  } else {
    await adapter.deactivate();
  }
  const { pending: _pending, ...restored } = state;
  await adapter.save(restored);
  return restored;
}
