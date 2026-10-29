#!/usr/bin/env node
/**
 * GitHub Actions annotation reporter for `node --test` (DEC-032, QA-006).
 *
 * Why: the step logs of this repository's workflows cannot be retrieved by the automation that maintains it
 * (only check-run annotations can), so a red "Node 24 · tests" job that merely says "exit code 1" is blind.
 * This reporter makes every failure name itself:
 *   - one `::error file=…,line=…,title=<test name>::<error>` per failing test (file-level crashes include the
 *     tail of the file's stderr, which is where load errors and late uncaught exceptions end up),
 *   - one `::error` per unmet coverage threshold (`--test-coverage-*`),
 *   - one closing `::notice` (green) or `::error` (red) with the counts, the coverage totals and the names of
 *     every failing test — GitHub shows at most 10 error annotations per step, so detail annotations are capped
 *     and the closing line always carries the complete list,
 *   - a markdown table in `$GITHUB_STEP_SUMMARY` when that file exists.
 * Outside GitHub Actions (`GITHUB_ACTIONS` != "true") the same facts are printed as plain text, so the reporter is
 * safe to run anywhere. Parent suites failing only because a child failed (`subtestsFailed`) are not repeated.
 *
 * Usage (second reporter next to the human-readable one, same destination so the runner parses the commands):
 *   node --test --test-reporter=spec --test-reporter-destination=stdout \
 *               --test-reporter=./scripts/test-reporter-gha.mjs --test-reporter-destination=stdout
 * Wired as `npm run test:ci` and `npm run test:coverage:ci`.
 */
import { appendFileSync } from 'node:fs';
import path from 'node:path';

export const LIMITS = Object.freeze({
  title: 120,          // annotation title (test name)
  message: 1500,       // annotation message
  stderrTail: 700,     // bytes of a crashed file's stderr kept for its annotation
  detailAnnotations: 9, // + 1 closing annotation = GitHub's 10-per-step display cap
  namesInSummary: 40,  // failing test names listed in the closing annotation
});

/** Escaping rules from GitHub's workflow-command documentation. */
export function escapeData(value) {
  return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
export function escapeProperty(value) {
  return escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

export function truncate(text, max) {
  const value = String(text);
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** `node --test` wraps the real error as `cause` of an ERR_TEST_FAILURE; the cause may be an Error, a string or absent. */
export function describeError(error) {
  const cause = error?.cause;
  let message;
  if (cause instanceof Error || (cause && typeof cause === 'object' && typeof cause.message === 'string')) message = cause.message;
  else if (typeof cause === 'string' && cause.trim()) message = cause;
  else message = error?.message;
  message = String(message || 'failed').trim();
  const failureType = typeof error?.failureType === 'string' ? error.failureType : '';
  return failureType && failureType !== 'testCodeFailure' ? `[${failureType}] ${message}` : message;
}

/** One `::<level> prop=…::message` line. Properties and message are escaped and bounded. */
export function formatAnnotation(level, { title, file, line, column, message }) {
  const props = [];
  if (file) props.push(`file=${escapeProperty(file)}`);
  if (Number.isInteger(line) && line > 0) props.push(`line=${line}`);
  if (Number.isInteger(column) && column > 0) props.push(`col=${column}`);
  if (title) props.push(`title=${escapeProperty(truncate(title, LIMITS.title))}`);
  return `::${level}${props.length ? ` ${props.join(',')}` : ''}::${escapeData(truncate(message, LIMITS.message))}\n`;
}

function relative(file, cwd) {
  if (!file) return '';
  const rel = path.isAbsolute(file) ? path.relative(cwd, file) : file;
  return rel.startsWith('..') ? file : rel.split(path.sep).join('/');
}

/** `test:stderr` events name the file as given on the command line; `test:fail` events use the absolute path. */
function fileKey(file, cwd) {
  return file ? path.resolve(cwd, String(file)) : '';
}

/** Turn a `test:fail` event into a failure record, or null when it should not be reported on its own. */
export function toFailure(event, { cwd = process.cwd(), stderrTails = new Map() } = {}) {
  const data = event?.data || {};
  const error = data.details?.error;
  if (error?.failureType === 'subtestsFailed') return null; // the children were already reported
  const file = relative(data.file, cwd);
  const fileLevel = data.nesting === 0 && error && ('exitCode' in error || 'signal' in error);
  let message = describeError(error);
  if (fileLevel) {
    const exit = error.signal ? `signal ${error.signal}` : `exit code ${error.exitCode}`;
    const tail = String(stderrTails.get(fileKey(data.file, cwd)) || '').trim();
    message = `test file ${exit}${tail ? `\n${tail}` : ' (no stderr captured)'}`;
  }
  return {
    name: String(data.name || file || 'unnamed test'),
    file,
    line: data.line,
    column: data.column,
    failureType: error?.failureType || 'testCodeFailure',
    message,
  };
}

function percent(value) {
  return Number.isFinite(value) ? `${Number(value).toFixed(2)}%` : 'n/a';
}

export function coverageLine(coverage) {
  if (!coverage?.totals) return '';
  const t = coverage.totals;
  const floor = coverage.thresholds && Object.values(coverage.thresholds).some((v) => v > 0)
    ? ` (floor ${coverage.thresholds.line || 0}/${coverage.thresholds.branch || 0}/${coverage.thresholds.function || 0})`
    : '';
  return `coverage lines ${percent(t.coveredLinePercent)} · branches ${percent(t.coveredBranchPercent)} · functions ${percent(t.coveredFunctionPercent)}${floor}`;
}

export function summarize({ counts, success, failures, thresholdErrors, coverage, ownCounts }) {
  const c = counts || { tests: ownCounts.pass + ownCounts.fail, passed: ownCounts.pass, failed: ownCounts.fail, cancelled: 0, skipped: 0, todo: 0 };
  const parts = [`${c.tests} tests`, `${c.passed} passed`, `${c.failed} failed`];
  if (c.cancelled) parts.push(`${c.cancelled} cancelled`);
  if (c.skipped) parts.push(`${c.skipped} skipped`);
  if (c.todo) parts.push(`${c.todo} todo`);
  const cov = coverageLine(coverage);
  if (cov) parts.push(cov);
  const red = success === false || failures.length > 0 || thresholdErrors.length > 0;
  const lines = [parts.join(' · ')];
  if (failures.length) {
    const names = failures.slice(0, LIMITS.namesInSummary).map((f) => `${f.name}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''}`);
    lines.push(`failing: ${names.join('; ')}${failures.length > names.length ? `; … +${failures.length - names.length} more` : ''}`);
  }
  if (thresholdErrors.length) lines.push(thresholdErrors.join(' | '));
  return { red, text: lines.join('\n') };
}

export function stepSummaryMarkdown({ summary, failures, thresholdErrors, red }) {
  const out = [`### node --test — ${red ? '❌ failing' : '✅ green'}`, '', summary.split('\n')[0], ''];
  if (failures.length) {
    out.push('| Test | Location | Error |', '|---|---|---|');
    for (const f of failures) {
      const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
      out.push(`| ${cell(f.name)} | ${cell(f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : '')} | ${cell(truncate(f.message, 300))} |`);
    }
    out.push('');
  }
  if (thresholdErrors.length) out.push(...thresholdErrors.map((e) => `- ⚠️ ${e}`), '');
  return `${out.join('\n')}\n`;
}

/**
 * Build the reporter (an async generator consuming the test runner's event stream). Injectable env/cwd/append
 * for tests; the default export is the production instance used by `--test-reporter`.
 */
export function createReporter({ env = process.env, cwd = process.cwd(), append = appendFileSync } = {}) {
  return async function* ghaReporter(source) {
    const gha = env.GITHUB_ACTIONS === 'true';
    const failures = [];
    const thresholdErrors = [];
    const stderrTails = new Map();
    const ownCounts = { pass: 0, fail: 0 };
    let counts = null;
    let success = null;
    let coverage = null;
    let detailBudget = LIMITS.detailAnnotations;

    const emit = (level, record) => {
      if (gha) return formatAnnotation(level, record);
      const where = record.file ? `${record.file}${record.line ? `:${record.line}` : ''} ` : '';
      const oneLine = truncate(String(record.message).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(' ⏎ '), 400);
      return `${level === 'error' ? '✖' : 'ℹ'} ${where}${record.title ? `${record.title} — ` : ''}${oneLine}\n`;
    };

    for await (const event of source) {
      try {
        const data = event?.data || {};
        switch (event?.type) {
          case 'test:stderr': {
            if (!data.file) break;
            const key = fileKey(data.file, cwd);
            stderrTails.set(key, `${stderrTails.get(key) || ''}${data.message || ''}`.slice(-LIMITS.stderrTail));
            break;
          }
          case 'test:pass': {
            if (data.details?.type !== 'suite') ownCounts.pass += 1;
            break;
          }
          case 'test:fail': {
            const failure = toFailure(event, { cwd, stderrTails });
            if (!failure) break;
            ownCounts.fail += 1;
            failures.push(failure);
            if (detailBudget > 0) {
              detailBudget -= 1;
              yield emit('error', { title: failure.name, file: failure.file, line: failure.line, column: failure.column, message: failure.message });
            }
            break;
          }
          case 'test:diagnostic': {
            if (data.level !== 'error') break; // info diagnostics are the usual "tests N / pass N" footer
            const message = String(data.message || '').trim();
            if (!message) break;
            thresholdErrors.push(message);
            if (detailBudget > 0) {
              detailBudget -= 1;
              yield emit('error', { title: 'coverage threshold', message });
            }
            break;
          }
          case 'test:coverage': {
            coverage = data.summary || null;
            break;
          }
          case 'test:summary': {
            if (data.file) break; // per-file summaries; the aggregate one has no file
            counts = data.counts || counts;
            success = typeof data.success === 'boolean' ? data.success : success;
            break;
          }
          default:
            break;
        }
      } catch (error) {
        // A reporter must never take the test run down with it.
        yield `${gha ? '::warning title=test-reporter-gha::' : '⚠ test-reporter-gha: '}${escapeData(error?.message || error)}\n`;
      }
    }

    const { red, text } = summarize({ counts, success, failures, thresholdErrors, coverage, ownCounts });
    yield emit(red ? 'error' : 'notice', { title: 'node --test', message: text });
    if (env.GITHUB_STEP_SUMMARY) {
      try {
        append(env.GITHUB_STEP_SUMMARY, stepSummaryMarkdown({ summary: text, failures, thresholdErrors, red }));
      } catch {
        // the summary file is a convenience; never fail because of it
      }
    }
  };
}

export default createReporter();
