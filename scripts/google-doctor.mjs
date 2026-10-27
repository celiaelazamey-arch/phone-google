#!/usr/bin/env node
/**
 * GOOG-002: `npm run google:doctor` — offline preflight of the Google connection.
 *
 * Reads only the local environment (.env included) and prints a sanitized report: no secret
 * values, no network calls, no database writes. Exit code 1 means at least one blocking check.
 */
import { config as loadEnv } from 'dotenv';
import { formatPreflightReport, preflightGoogleConfig } from '../src/google-preflight.js';

// Keep stdout machine-readable in --json mode even when dotenv loads a local .env file.
loadEnv({ quiet: true });

const report = preflightGoogleConfig(process.env);
if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  console.log('Google connection preflight — offline, environment only.\n');
  console.log(formatPreflightReport(report));
  console.log('\nNext: npm run --silent google:doctor -- --json   (machine-readable JSON only)');
}
process.exitCode = report.ok ? 0 : 1;
