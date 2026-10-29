#!/bin/sh
# AGENT-003 entrypoint. It runs only inside the namespaces created by sandbox.js.
# No user code is interpolated here: the task is always /task.cjs.
set -eu

if [ "$#" -ne 17 ]; then
  exit 64
fi

ROOT=$1
EXPORT=$2
AUDIT=$3
HOST_NODE=$4
RUN_ID=$5
CPU_SECONDS=$6
AS_BYTES=$7
HEAP_MB=$8
SEMI_SPACE_MB=$9
MAX_PROCESSES=${10}
MAX_OPEN_FILES=${11}
MAX_FILE_BYTES=${12}
TMP_BYTES=${13}
WORKSPACE_BYTES=${14}
PROBE_ENABLED=${15}
PROBE_HOST=${16}
PROBE_PORT=${17}

# The first bind makes the root a mount point. Children must be mounted after it;
# mounting the root over itself later would hide the runtime mounts.
/usr/bin/mount --bind "$ROOT" "$ROOT"
# Each line is an executor-discovered source|target pair for one required
# bootstrap executable or shared library. No /usr/bin, /usr/lib or host app
# directory is mounted wholesale. The manifest is removed before task start.
while IFS='|' read -r SOURCE TARGET; do
  [ -n "$SOURCE" ] || continue
  /usr/bin/touch "$ROOT$TARGET"
  /usr/bin/mount --bind "$SOURCE" "$ROOT$TARGET"
  /usr/bin/mount -o remount,bind,ro,nosuid,nodev "$ROOT$TARGET"
done < "$ROOT/runtime/mounts.list"
/usr/bin/rm -f "$ROOT/runtime/mounts.list"

# Only the Node executable is taken from its host location, not /usr/local or
# any application directory. It is executed as /runtime/node after chroot.
/usr/bin/touch "$ROOT/runtime/node"
/usr/bin/mount --bind "$HOST_NODE" "$ROOT/runtime/node"
/usr/bin/mount -o remount,bind,ro,nosuid,nodev "$ROOT/runtime/node"

# The task workspace is a fresh, bounded tmpfs. The host export directory is
# deliberately not mounted while untrusted code runs; it is attached only after
# the task exits, for a trusted copy of the declared artifact directory.
/usr/bin/mount -t tmpfs -o "size=${WORKSPACE_BYTES},nr_inodes=128,rw,nosuid,nodev,noexec,mode=1777" tmpfs "$ROOT/workspace"
/usr/bin/mkdir -p "$ROOT/workspace/artifacts"
/usr/bin/mount --bind "$AUDIT" "$ROOT/run"
/usr/bin/mount -o remount,bind,rw,nosuid,nodev,noexec "$ROOT/run"
/usr/bin/mount -t tmpfs -o "size=${TMP_BYTES},nr_inodes=64,rw,nosuid,nodev,noexec,mode=1777" tmpfs "$ROOT/tmp"
/usr/bin/mount -t proc -o ro,nosuid,nodev,noexec proc "$ROOT/proc"

# No /home, /root, /etc, SSH, cloud configuration or host working directory is
# mounted. Only these three device files exist, never a host /dev directory.
for dev in null zero urandom; do
  /usr/bin/touch "$ROOT/dev/$dev"
  /usr/bin/mount --bind "/dev/$dev" "$ROOT/dev/$dev"
  /usr/bin/mount -o remount,bind,rw,nosuid "$ROOT/dev/$dev"
done

/usr/bin/mount -o remount,bind,ro,nosuid "$ROOT"

# A network probe is fixed executor code, not task-supplied code. Its result is
# written to a separate bind which is made read-only before the task starts.
# Thus the task cannot rewrite the audit result to disguise a policy breach.
if [ "$PROBE_ENABLED" = "1" ]; then
  /usr/sbin/chroot "$ROOT" \
    /usr/bin/prlimit --as="$AS_BYTES" --cpu="$CPU_SECONDS" --nproc="$MAX_PROCESSES" \
      --nofile="$MAX_OPEN_FILES" --fsize="$MAX_FILE_BYTES" --core=0 \
    /usr/bin/setpriv --no-new-privs --inh-caps=-all --ambient-caps=-all --bounding-set=-all \
    /usr/bin/env -i HOME=/workspace PATH=/usr/bin NODE_NO_WARNINGS=1 \
      SANDBOX_RUN_ID="$RUN_ID" SANDBOX_PROBE_HOST="$PROBE_HOST" SANDBOX_PROBE_PORT="$PROBE_PORT" \
      /runtime/node --max-old-space-size="$HEAP_MB" --max-semi-space-size="$SEMI_SPACE_MB" \
      /runtime/network-probe.cjs > "$ROOT/run/network.json"
  /usr/bin/test -s "$ROOT/run/network.json"
fi
/usr/bin/touch "$ROOT/run/task-started"
/usr/bin/mount -o remount,bind,ro,nosuid,nodev,noexec "$ROOT/run"

# Do not exec: the outer namespace owner must perform the post-task export while
# its private mounts still exist. The task itself has no export mount or fd.
set +e
/usr/sbin/chroot "$ROOT" \
  /usr/bin/prlimit --as="$AS_BYTES" --cpu="$CPU_SECONDS" --nproc="$MAX_PROCESSES" \
    --nofile="$MAX_OPEN_FILES" --fsize="$MAX_FILE_BYTES" --core=0 \
  /usr/bin/setpriv --no-new-privs --inh-caps=-all --ambient-caps=-all --bounding-set=-all \
  /usr/bin/env -i HOME=/workspace PATH=/usr/bin NODE_NO_WARNINGS=1 SANDBOX_RUN_ID="$RUN_ID" \
    /runtime/node --max-old-space-size="$HEAP_MB" --max-semi-space-size="$SEMI_SPACE_MB" \
    /task.cjs
TASK_RC=$?
set -e

# The main Node process can exit while leaving descendants behind. PID 1 in
# this private namespace is the entrypoint shell; kill(-1) excludes the caller
# and PID 1, so every remaining task descendant is stopped before export.
kill -KILL -1 2>/dev/null || true

if [ "$TASK_RC" -eq 0 ]; then
  # A replaced artifacts mountpoint is a policy violation, not a source for cp.
  if /usr/bin/test -L "$ROOT/workspace/artifacts"; then
    exit 65
  fi
  /usr/bin/mount --bind "$EXPORT" "$ROOT/export"
  /usr/bin/mount -o remount,bind,rw,nosuid,nodev,noexec "$ROOT/export"
  /usr/bin/cp -a "$ROOT/workspace/artifacts/." "$ROOT/export/"
fi
exit "$TASK_RC"
