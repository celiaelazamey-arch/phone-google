#!/usr/bin/env node
/**
 * GOOG-002: `npm run google:doctor` — offline preflight of the Google connection.
 *
 * Reads only the local environment (.env included) and prints a sanitized report: no secret
 * values, no network calls, no database writes. Exit code 1 means at least one blocking check.
 */
import 'dotenv/config';
import { formatPreflightReport, preflightGoogleConfig } from '../src/google-preflight.js';

const report = preflightGoogleConfig(process.env);
console.log('Google connection preflight — offline, environment only.\n');
console.log(formatPreflightReport(report));
if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  console.log('\nNext: npm run google:doctor -- --json   (machine-readable)');
}
process.exitCode = report.ok ? 0 : 1;
