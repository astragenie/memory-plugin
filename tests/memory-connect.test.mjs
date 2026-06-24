// Tests for memory-connect CLI (FEAT-279).
//
// Strategy: spawn the binary via spawnSync / spawn with ASTRAMEMORY_HOME
// pointed at a per-test temp dir so every test is fully isolated from
// ~/.astramemory on the developer's machine.  Fetch calls are intercepted
// by a real in-process HTTP server on a random port — no monkey-patching
// of globals needed.
//
// node --test tests/memory-connect.test.mjs

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const BIN = join(repoRoot, 'bin', 'memory-connect');

// ---------------------------------------------------------------------------
// Test server helpers
// ---------------------------------------------------------------------------

/**
 * Spin up a one-shot HTTP server that executes `handler` for every request.
 * Returns { url, calls, close }.
 */
function withServer(handler) {
  return new Promise((resolve) => {
    const calls = { count: 0, requests: [] };
    const srv = createServer((req, res) => {
      calls.count++;
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = JSON.parse(raw); } catch { body = raw; }
        calls.requests.push({ method: req.method, url: req.url, headers: req.headers, body });
        handler(req, res, calls);
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls,
        close: () => {
          // closeAllConnections() (Node ≥18.2) tears down keep-alive sockets
          // on Windows so srv.close() resolves promptly.
          if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
          return new Promise((r) => srv.close(r));
        },
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

function makeTmpHome(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mc-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeProfiles(home, profiles) {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'profiles.json'), JSON.stringify(profiles, null, 2));
}

function readTokens(home, env) {
  const p = join(home, `tokens.${env}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

// ---------------------------------------------------------------------------
// Run helper: spawns memory-connect synchronously
// ---------------------------------------------------------------------------

// Async spawn (NOT spawnSync) — under spawnSync the Node event loop blocks,
// so the in-process HTTP servers in these tests cannot service the child's
// fetch calls, producing a deadlock that times the test file out at 60s.
function run(args, { home, cwd, env: extraEnv = {} } = {}) {
  /** @type {Record<string, string | undefined>} */
  const env = {
    ...process.env,
    ASTRAMEMORY_HOME: home,
    ...extraEnv,
  };
  // Remove any real ASTRAMEMORY_ENV so tests control it via --env flag
  delete env['ASTRAMEMORY_ENV'];

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: cwd ?? repoRoot,
      env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b.toString()));
    child.stderr.on('data', (b) => (stderr += b.toString()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 15000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, status, signal });
    });
  });
}

// ---------------------------------------------------------------------------
// Test: happy path — 200 redeem, token written, handshake fired, exit 0
// ---------------------------------------------------------------------------

test('happy path: 200 redeem writes tokens file and exits 0', async (t) => {
  const home = makeTmpHome(t);
  const ENV = 'testenv';
  const CODE = 'ABCD-1234';
  const API_KEY = 'sk-testapikeyfoobar9999';
  const TENANT_ID = 'tenant-abc';
  const WS_ID = 'my-workspace';

  const srv = await withServer((req, res, _calls) => {
    if (req.url.includes('/claims/')) {
      // Redeem endpoint
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        apiUrl: srv.url,
        tenantId: TENANT_ID,
        workspaceId: WS_ID,
        apiKey: API_KEY,
      }));
    } else {
      // Handshake /memories endpoint
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'mem-001' }));
    }
  });
  // Patch apiUrl in redeem response to point to the same test server
  t.after(() => srv.close());

  // Seed profiles.json
  writeProfiles(home, { [ENV]: { apiUrl: srv.url } });

  const result = await run([CODE, '--env', ENV, '--workspace', WS_ID], { home });

  assert.equal(result.status, 0, `should exit 0; stderr=${result.stderr}`);
  assert.ok(result.stdout.includes('✓'), `stdout should contain ✓; got: ${result.stdout}`);
  assert.ok(result.stdout.includes(WS_ID), `stdout should include workspace name`);
  assert.ok(result.stdout.includes(ENV), `stdout should include env name`);

  // Token file should exist with the new entry
  const tokens = readTokens(home, ENV);
  assert.ok(tokens, 'tokens file should be created');
  assert.ok(tokens[WS_ID], 'token entry for workspaceId should exist');
  assert.equal(tokens[WS_ID].tenantId, TENANT_ID, 'tenantId should be stored');
  assert.ok(tokens[WS_ID].apiKey === API_KEY, 'apiKey should be stored');
  assert.ok(tokens[WS_ID].pairedAt, 'pairedAt should be set');
  assert.ok(tokens[WS_ID].label.startsWith('claim-'), 'label should start with claim-');

  // Redeem + handshake = 2 calls
  assert.ok(srv.calls.count >= 2, `expected at least 2 HTTP calls; got ${srv.calls.count}`);
  // Handshake should send Authorization: ApiKey ...
  const handshakeReq = srv.calls.requests.find(r => r.url === '/memories');
  assert.ok(handshakeReq, 'handshake POST to /memories should have been made');
  assert.ok(
    handshakeReq.headers.authorization?.startsWith('ApiKey '),
    'handshake should use ApiKey authorization'
  );
});

// ---------------------------------------------------------------------------
// Test: 410 expired code — no file mutation, exit 1
// ---------------------------------------------------------------------------

test('410 expired code: exits 1 and does not write token file', async (t) => {
  const home = makeTmpHome(t);
  const ENV = 'testenv';
  const CODE = 'ZZZZ-9999';

  const srv = await withServer((_req, res) => {
    res.writeHead(410);
    res.end();
  });
  t.after(() => srv.close());

  writeProfiles(home, { [ENV]: { apiUrl: srv.url } });

  const result = await run([CODE, '--env', ENV, '--workspace', 'some-workspace'], { home });

  assert.equal(result.status, 1, `should exit 1 on 410; stderr=${result.stderr}`);
  assert.ok(result.stderr.includes('expired'), `stderr should mention 'expired'; got: ${result.stderr}`);

  // Tokens file must NOT exist (or must not have the workspace entry)
  const tokens = readTokens(home, ENV);
  assert.ok(!tokens || !tokens['some-workspace'], 'no token entry should be written on 410');
});

// ---------------------------------------------------------------------------
// Test: network failure — exit 2
// ---------------------------------------------------------------------------

test('network failure: exits 2 when server is unreachable', async (t) => {
  const home = makeTmpHome(t);
  const ENV = 'testenv';

  // Point at a port nothing is listening on
  writeProfiles(home, { [ENV]: { apiUrl: 'http://127.0.0.1:1' } });

  const result = await run(['ABCD-0001', '--env', ENV, '--workspace', 'ws'], { home });

  assert.equal(result.status, 2, `should exit 2 on network failure; stderr=${result.stderr}`);
});

// ---------------------------------------------------------------------------
// Test: missing profile — exit 4
// ---------------------------------------------------------------------------

test('missing profile: exits 4 when env not in profiles.json', async (t) => {
  const home = makeTmpHome(t);

  // profiles.json exists but does not have the requested env
  writeProfiles(home, { prod: { apiUrl: 'https://api.example.com' } });

  const result = await run(['ABCD-0001', '--env', 'staging', '--workspace', 'ws'], { home });

  assert.equal(result.status, 4, `should exit 4 on missing profile; stderr=${result.stderr}`);
  assert.ok(
    result.stderr.includes("'staging'") || result.stderr.includes('staging'),
    `stderr should name the missing env; got: ${result.stderr}`
  );
});

// ---------------------------------------------------------------------------
// Test: missing profiles.json entirely — exit 4
// ---------------------------------------------------------------------------

test('missing profiles.json: exits 4 when file does not exist', async (t) => {
  const home = makeTmpHome(t);
  // Do NOT write profiles.json

  const result = await run(['ABCD-0001', '--env', 'prod', '--workspace', 'ws'], { home });

  assert.equal(result.status, 4, `should exit 4 when profiles.json missing; stderr=${result.stderr}`);
});

// ---------------------------------------------------------------------------
// Test: workspaceId defaults to basename(cwd)
// ---------------------------------------------------------------------------

test('workspaceId defaults to basename of cwd', async (t) => {
  const home = makeTmpHome(t);
  const ENV = 'testenv';
  const API_KEY = 'sk-cwdtest0000';
  const EXPECTED_WS = basename(repoRoot); // basename of wherever we run from

  const srv = await withServer((req, res) => {
    if (req.url.includes('/claims/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        apiUrl: srv.url,
        tenantId: 't1',
        workspaceId: null, // null → CLI falls back to basename(cwd)
        apiKey: API_KEY,
      }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    }
  });
  t.after(() => srv.close());

  writeProfiles(home, { [ENV]: { apiUrl: srv.url } });

  // Run with cwd = repoRoot so we can predict the workspace name
  const result = await run(['ABCD-1111', '--env', ENV], { home, cwd: repoRoot });

  assert.equal(result.status, 0, `should exit 0; stderr=${result.stderr}`);

  // Token should be keyed by basename(repoRoot)
  const tokens = readTokens(home, ENV);
  assert.ok(tokens, 'tokens file should be created');
  assert.ok(tokens[EXPECTED_WS], `token keyed by basename(cwd)="${EXPECTED_WS}" should exist`);
});

// ---------------------------------------------------------------------------
// Test: atomic write preserves existing entries (AC6)
// ---------------------------------------------------------------------------

test('atomic write: existing workspaceId entries preserved when appending new', async (t) => {
  const home = makeTmpHome(t);
  const ENV = 'testenv';
  const API_KEY_W1 = 'sk-w1existing0001';
  const API_KEY_W2 = 'sk-w2new000000002';

  // Pre-seed tokens.testenv.json with an existing workspace W1
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, `tokens.${ENV}.json`),
    JSON.stringify({
      'workspace-1': {
        apiKey: API_KEY_W1,
        label: 'claim-20260101000000',
        tenantId: 'tenant-old',
        repoPath: '/old/repo',
        pairedAt: '2026-01-01T00:00:00.000Z',
      },
    }, null, 2)
  );

  const srv = await withServer((req, res) => {
    if (req.url.includes('/claims/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        apiUrl: srv.url,
        tenantId: 'tenant-new',
        workspaceId: 'workspace-2',
        apiKey: API_KEY_W2,
      }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    }
  });
  t.after(() => srv.close());

  writeProfiles(home, { [ENV]: { apiUrl: srv.url } });

  const result = await run(['ABCD-2222', '--env', ENV, '--workspace', 'workspace-2'], { home });

  assert.equal(result.status, 0, `should exit 0; stderr=${result.stderr}`);

  const tokens = readTokens(home, ENV);
  assert.ok(tokens, 'tokens file should exist');
  // W1 must still be present with its original apiKey
  assert.equal(tokens['workspace-1']?.apiKey, API_KEY_W1, 'existing W1 entry must be preserved');
  // W2 must have been appended
  assert.equal(tokens['workspace-2']?.apiKey, API_KEY_W2, 'new W2 entry must be written');
});

// ---------------------------------------------------------------------------
// Test: masking — success line never reveals more than last 4 chars
// ---------------------------------------------------------------------------

test('masking: success line never reveals more than last 4 chars of apiKey', async (t) => {
  const home = makeTmpHome(t);
  const ENV = 'testenv';
  const API_KEY = 'sk-supersecretlongkey9999';
  const LAST_FOUR = API_KEY.slice(-4); // "9999"

  const srv = await withServer((req, res) => {
    if (req.url.includes('/claims/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        apiUrl: srv.url,
        tenantId: 'tid',
        workspaceId: 'ws',
        apiKey: API_KEY,
      }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    }
  });
  t.after(() => srv.close());

  writeProfiles(home, { [ENV]: { apiUrl: srv.url } });

  const result = await run(['ABCD-3333', '--env', ENV, '--workspace', 'ws'], { home });

  assert.equal(result.status, 0, `should exit 0; stderr=${result.stderr}`);

  // The full key (beyond the last 4 chars) must NOT appear in stdout or stderr
  const fullSecret = API_KEY.slice(0, -4); // everything except last 4
  assert.ok(
    !result.stdout.includes(fullSecret),
    `stdout must not contain more than last 4 chars of apiKey; stdout=${result.stdout}`
  );
  assert.ok(
    !result.stderr.includes(fullSecret),
    `stderr must not contain more than last 4 chars of apiKey; stderr=${result.stderr}`
  );
  // Last 4 chars ARE allowed in the masked output
  assert.ok(
    result.stdout.includes(LAST_FOUR),
    `stdout should include last 4 chars "${LAST_FOUR}"; got: ${result.stdout}`
  );
});

// ---------------------------------------------------------------------------
// Test: --url override bypasses profiles.json
// ---------------------------------------------------------------------------

test('--url override: bypasses profiles.json lookup', async (t) => {
  const home = makeTmpHome(t);
  const ENV = 'prod';
  const API_KEY = 'sk-overridetest1234';

  // Intentionally do NOT write profiles.json — --url must work without it
  const srv = await withServer((req, res) => {
    if (req.url.includes('/claims/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        apiUrl: srv.url,
        tenantId: 'tid2',
        workspaceId: 'ws-override',
        apiKey: API_KEY,
      }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    }
  });
  t.after(() => srv.close());

  const result = await run(
    ['ABCD-4444', '--env', ENV, '--url', srv.url, '--workspace', 'ws-override'],
    { home }
  );

  assert.equal(result.status, 0, `should exit 0 with --url override; stderr=${result.stderr}`);

  const tokens = readTokens(home, ENV);
  assert.ok(tokens?.['ws-override'], 'token should be written with --url override');
});

// ---------------------------------------------------------------------------
// Test: handshake soft-fail — CLI still exits 0 even if /memories returns 500
// ---------------------------------------------------------------------------

test('handshake soft-fail: exits 0 even when handshake POST returns 500', async (t) => {
  const home = makeTmpHome(t);
  const ENV = 'testenv';
  const API_KEY = 'sk-softfailtest0001';

  const srv = await withServer((req, res) => {
    if (req.url.includes('/claims/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        apiUrl: srv.url,
        tenantId: 'tid',
        workspaceId: 'ws-soft',
        apiKey: API_KEY,
      }));
    } else {
      // Handshake fails
      res.writeHead(500);
      res.end();
    }
  });
  t.after(() => srv.close());

  writeProfiles(home, { [ENV]: { apiUrl: srv.url } });

  const result = await run(['ABCD-5555', '--env', ENV, '--workspace', 'ws-soft'], { home });

  assert.equal(result.status, 0, `should exit 0 even on handshake failure; stderr=${result.stderr}`);
  assert.ok(result.stderr.includes('warning'), `stderr should contain warning about handshake`);

  // Token still written despite handshake failure
  const tokens = readTokens(home, ENV);
  assert.ok(tokens?.['ws-soft'], 'token must be written even when handshake fails');
});

// ---------------------------------------------------------------------------
// Test: structured log emitted to stderr for ok path
// ---------------------------------------------------------------------------

test('structured log: stderr contains JSON log line for ok path', async (t) => {
  const home = makeTmpHome(t);
  const ENV = 'logtest';
  const API_KEY = 'sk-logtest00009876';

  const srv = await withServer((req, res) => {
    if (req.url.includes('/claims/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        apiUrl: srv.url,
        tenantId: 'tid',
        workspaceId: 'ws-log',
        apiKey: API_KEY,
      }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    }
  });
  t.after(() => srv.close());

  writeProfiles(home, { [ENV]: { apiUrl: srv.url } });

  const result = await run(['ABCD-6666', '--env', ENV, '--workspace', 'ws-log'], { home });

  assert.equal(result.status, 0, `should exit 0; stderr=${result.stderr}`);

  // Find the JSON log line in stderr (may have other lines too)
  const lines = result.stderr.split('\n').filter(l => l.trim().startsWith('{'));
  assert.ok(lines.length >= 1, `stderr should contain at least one JSON log line; stderr=${result.stderr}`);
  const log = JSON.parse(lines[lines.length - 1]); // last JSON line = outcome log
  assert.equal(log.service, 'memory');
  assert.equal(log.env, ENV);
  assert.equal(log.outcome, 'ok');
  assert.equal(log.exitCode, 0);
  assert.ok(typeof log.durationMs === 'number', 'durationMs should be a number');
});

// ---------------------------------------------------------------------------
// Test: structured log emitted for expired (exit 1) path
// ---------------------------------------------------------------------------

test('structured log: stderr contains JSON log line for expired path', async (t) => {
  const home = makeTmpHome(t);
  const ENV = 'logtest2';

  const srv = await withServer((_req, res) => {
    res.writeHead(410, { 'Content-Type': 'application/json', 'Connection': 'close' });
    res.end('{"error":"claim_gone"}');
  });
  t.after(() => srv.close());

  writeProfiles(home, { [ENV]: { apiUrl: srv.url } });

  const result = await run(['ZZZZ-7777', '--env', ENV, '--workspace', 'ws'], { home });

  assert.equal(result.status, 1);
  const lines = result.stderr.split('\n').filter(l => l.trim().startsWith('{'));
  assert.ok(lines.length >= 1, `stderr should contain JSON log line; stderr=${result.stderr}`);
  const log = JSON.parse(lines[0]);
  assert.equal(log.outcome, 'expired');
  assert.equal(log.exitCode, 1);
});

// ---------------------------------------------------------------------------
// Test: structured log emitted for profile missing (exit 4) path
// ---------------------------------------------------------------------------

test('structured log: stderr contains JSON log line for missing profile path', async (t) => {
  const home = makeTmpHome(t);

  writeProfiles(home, { prod: { apiUrl: 'https://x.example.com' } });

  const result = await run(['ABCD-8888', '--env', 'notexist', '--workspace', 'ws'], { home });

  assert.equal(result.status, 4);
  const lines = result.stderr.split('\n').filter(l => l.trim().startsWith('{'));
  assert.ok(lines.length >= 1, `stderr should contain JSON log line; stderr=${result.stderr}`);
  const log = JSON.parse(lines[0]);
  assert.equal(log.exitCode, 4);
});
