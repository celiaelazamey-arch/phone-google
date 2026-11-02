const DEPENDABOT_AUTHORS = new Set(['app/dependabot', 'dependabot[bot]']);
const ACTION_PIN = /^\s*-\s*uses:\s*([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)@([a-f0-9]{40})\s+#\s*(v\d+(?:\.\d+){0,3}(?:[-+][A-Za-z0-9_.-]+)?)\s*$/i;
const WORKFLOW_PATH = /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/i;

/**
 * A handoff waiver for Dependabot is deliberately narrow: the PR author must be Dependabot,
 * every changed file must be a workflow YAML file, and every changed line must be a paired,
 * SHA-pinned `uses:` reference with its version comment. Any logic/config edit still needs
 * the normal STATE + session handoff.
 */
export function isDependabotActionPinOnly({ author, paths = [], diff = '' } = {}) {
  if (!DEPENDABOT_AUTHORS.has(String(author || ''))) return false;
  if (!paths.length || paths.some((file) => !WORKFLOW_PATH.test(file))) return false;

  const changes = new Map();
  let currentPath = null;
  let changedLines = 0;

  for (const line of String(diff).split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      const header = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      if (!header || header[1] !== header[2] || !WORKFLOW_PATH.test(header[2])) return false;
      currentPath = header[2];
      continue;
    }
    if (line.startsWith('+++ b/')) {
      currentPath = line.slice('+++ b/'.length);
      if (!WORKFLOW_PATH.test(currentPath)) return false;
      continue;
    }
    if (line.startsWith('--- a/')) {
      if (currentPath && line.slice('--- a/'.length) !== currentPath) return false;
      continue;
    }
    if (line.startsWith('index ') || line.startsWith('@@')) continue;
    if (line.startsWith('\\ No newline at end of file') || !/^[+-]/.test(line)) continue;
    if (line.startsWith('+++') || line.startsWith('---') || !currentPath) return false;

    const match = line.slice(1).match(ACTION_PIN);
    if (!match) return false;
    const [, action, sha, version] = match;
    const key = `${currentPath}\0${action.toLowerCase()}`;
    const group = changes.get(key) || { removed: [], added: [] };
    group[line[0] === '-' ? 'removed' : 'added'].push(`${sha.toLowerCase()} ${version.toLowerCase()}`);
    changes.set(key, group);
    changedLines += 1;
  }

  if (!changedLines || changedLines % 2 !== 0 || !changes.size) return false;
  for (const { removed, added } of changes.values()) {
    if (!removed.length || removed.length !== added.length) return false;
    if (removed.sort().join('\n') === added.sort().join('\n')) return false;
  }
  return true;
}
