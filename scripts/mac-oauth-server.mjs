#!/usr/bin/env node
/**
 * futurator-oauth-server — local HTTP helper that pushes Mac Keychain
 * Claude Code OAuth tokens to the EC2 daemon on demand.
 *
 * Why this exists: the admin UI runs in your browser at admin.futurator.ai
 * (HTTPS, AWS) and cannot read the Mac Keychain directly. Modern browsers
 * special-case http://localhost as a "potentially trustworthy" origin, so an
 * HTTPS page can fetch a local plain-HTTP endpoint without mixed-content
 * warnings. This server bridges that gap with one button click.
 *
 * Endpoints:
 *   POST /sync     — run the Keychain→SSM sync now, return result
 *   GET  /status   — { alive: true, lastSync: {...} }
 *
 * Also auto-syncs every 5 minutes so OAuth on EC2 stays fresh even when you
 * never open the admin UI.
 *
 * Install as a launchd agent via scripts/install-mac-oauth-sync.sh.
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = parseInt(process.env.FUTURATOR_OAUTH_SERVER_PORT || '9876', 10);
const HOST = '127.0.0.1';
const __dirname = dirname(fileURLToPath(import.meta.url));
const SYNC_SCRIPT = join(__dirname, 'mac-oauth-sync.sh');
// 1 hour: Keychain tokens don't go stale that fast (refresh_token lives 30+
// days; access_token is auto-refreshed by claude CLI on each spawn). Each
// sync triggers a daemon probe (one Claude API call against Max quota), so
// keeping this generous avoids burning Max's hourly token bucket. The
// on-demand "Re-authorize EC2" button covers anything more urgent.
const AUTO_SYNC_MS = parseInt(process.env.AUTO_SYNC_MS || String(60 * 60 * 1000), 10);

// Admin UI origins that may invoke /sync. Localhost dev included so testing
// from `npm run dev` works without code changes.
const ALLOWED_ORIGINS = new Set([
  'https://admin.futurator.ai',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
]);

let lastResult = {
  ok: null,
  ts: null,
  trigger: null,
  exitCode: null,
  message: 'never run',
};
let inFlight = null;

function runSync(trigger) {
  // Coalesce concurrent calls — one button click during a 5-min auto-sync
  // shouldn't spawn two SSM commands.
  if (inFlight) return inFlight;

  inFlight = new Promise((resolve) => {
    const proc = spawn('/bin/bash', [SYNC_SCRIPT], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    proc.stdout.on('data', (c) => (out += c.toString()));
    proc.stderr.on('data', (c) => (err += c.toString()));
    proc.on('error', (e) => {
      lastResult = {
        ok: false,
        ts: new Date().toISOString(),
        trigger,
        exitCode: -1,
        message: `spawn failed: ${e.message}`,
        stdout: '',
        stderr: '',
      };
      inFlight = null;
      resolve(lastResult);
    });
    proc.on('close', (code) => {
      lastResult = {
        ok: code === 0,
        ts: new Date().toISOString(),
        trigger,
        exitCode: code,
        message: code === 0 ? 'pushed OAuth + signalled daemon' : `sync exited ${code}`,
        stdout: out.slice(-800),
        stderr: err.slice(-800),
      };
      inFlight = null;
      resolve(lastResult);
    });
  });

  return inFlight;
}

function setCors(res, origin) {
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : 'https://admin.futurator.ai';
  res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  setCors(res, origin);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/sync' && req.method === 'POST') {
    const result = await runSync('http');
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(result.ok ? 200 : 500);
    res.end(JSON.stringify(result));
    return;
  }

  if (req.url === '/status' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(
      JSON.stringify({
        alive: true,
        port: PORT,
        autoSyncMs: AUTO_SYNC_MS,
        lastSync: lastResult,
      }),
    );
    return;
  }

  res.writeHead(404);
  res.end();
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} already in use — another instance running?`);
    process.exit(1);
  }
  console.error('Server error:', err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`[${new Date().toISOString()}] futurator-oauth-server listening on ${HOST}:${PORT}`);
  runSync('startup').then((r) => {
    console.log(`[${new Date().toISOString()}] startup sync: ${r.ok ? 'OK' : 'FAIL'} (${r.exitCode})`);
  });
});

setInterval(() => {
  runSync('auto').then((r) => {
    console.log(`[${new Date().toISOString()}] auto sync: ${r.ok ? 'OK' : 'FAIL'} (${r.exitCode})`);
  });
}, AUTO_SYNC_MS);

process.on('SIGTERM', () => {
  console.log('SIGTERM — shutting down');
  server.close(() => process.exit(0));
});
