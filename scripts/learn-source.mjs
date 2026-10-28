#!/usr/bin/env node
/**
 * CELIA-LEARN-001 — Stage 1/2 tooling (source record + segment binding).
 *
 *   node scripts/learn-source.mjs data/learning/sources/<source-id>            # write hashes into source.json
 *   node scripts/learn-source.mjs data/learning/sources/<source-id> --check    # verify only (exit 1 on drift)
 *
 * The transcript itself (`transcript.txt`) stays OUTSIDE Git (see .gitignore): it is third-party
 * material referenced by URL only. What is committed is `source.json` — identity, extraction channel,
 * SHA-256 of the extracted text and of every segment — so any later claim can be bound to a segment
 * and re-verified against the same bytes. Nothing here calls the network.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Splits the transcript into the segments declared in source.json and hashes each one. */
export function bindSegments(transcript, segmentPlan) {
  const lines = transcript.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const segments = [];
  let previousEnd = 0;
  for (const segment of segmentPlan) {
    const [start, end] = segment.lines || [];
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > lines.length) {
      throw new Error(`segment_range_invalid: ${segment.id}`);
    }
    if (start !== previousEnd + 1) throw new Error(`segment_gap_or_overlap: ${segment.id}`);
    previousEnd = end;
    const text = lines.slice(start - 1, end).join('\n');
    segments.push({ ...segment, chars: text.length, sha256: sha256(text) });
  }
  if (previousEnd !== lines.length) throw new Error('segments_do_not_cover_transcript');
  return { lines: lines.length, segments };
}

/** Deterministic prompt-injection scan over third-party text (no model involved). */
export const INJECTION_PATTERNS = Object.freeze([
  ['ignore_instructions', /ignore (all |the )?(previous|prior|above) instructions/i],
  ['ignore_instructions_ar', /تجاهل (كل |جميع )?(التعليمات|الأوامر)/],
  ['system_prompt', /system prompt|developer message/i],
  ['tool_call', /\b(curl|wget|fetch\(|POST \/|DELETE \/)\b/i],
  ['secret_exfil', /\b(api[_ -]?key|token|password|كلمة المرور|المفتاح السري)\b/i],
  ['url', /https?:\/\//i],
  ['send_message', /(أرسل|ابعث) (رسالة|بريد)|send (a )?(message|email)/i]
]);

export function scanInjection(text) {
  const findings = [];
  for (const [code, pattern] of INJECTION_PATTERNS) {
    const match = pattern.exec(text);
    if (match) findings.push({ code, sample: match[0].slice(0, 60) });
  }
  return findings;
}

export async function recordSource(directory, { check = false } = {}) {
  const sourcePath = path.join(directory, 'source.json');
  const source = JSON.parse(await readFile(sourcePath, 'utf8'));
  const transcriptPath = path.join(directory, source.transcript?.file || 'transcript.txt');
  const transcript = await readFile(transcriptPath, 'utf8');
  const { lines, segments } = bindSegments(transcript, source.segments || []);
  const injection = scanInjection(transcript);
  const next = {
    ...source,
    transcript: {
      ...(source.transcript || {}),
      file: source.transcript?.file || 'transcript.txt',
      committed: false,
      chars: transcript.length,
      lines,
      sha256: sha256(transcript)
    },
    segments,
    injection_scan: { patterns: INJECTION_PATTERNS.length, findings: injection }
  };
  const drift = [];
  if (source.transcript?.sha256 && source.transcript.sha256 !== next.transcript.sha256) drift.push('transcript.sha256');
  for (const [index, segment] of (source.segments || []).entries()) {
    if (segment.sha256 && segment.sha256 !== segments[index].sha256) drift.push(`segments[${segment.id}].sha256`);
  }
  if (check) return { ok: drift.length === 0, drift, transcript: next.transcript, segments, injection_scan: next.injection_scan };
  await writeFile(sourcePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return { ok: true, drift, transcript: next.transcript, segments, injection_scan: next.injection_scan };
}

async function main() {
  const [directory, ...rest] = process.argv.slice(2);
  if (!directory) {
    console.error('usage: node scripts/learn-source.mjs <source-dir> [--check]');
    process.exit(2);
  }
  const result = await recordSource(path.resolve(directory), { check: rest.includes('--check') });
  console.log(
    JSON.stringify(
      {
        ok: result.ok,
        drift: result.drift,
        transcript: result.transcript,
        segments: result.segments.map((s) => ({ id: s.id, lines: s.lines, chars: s.chars, sha256: s.sha256 })),
        injection_scan: result.injection_scan
      },
      null,
      2
    )
  );
  if (!result.ok) process.exit(1);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await main();
}
