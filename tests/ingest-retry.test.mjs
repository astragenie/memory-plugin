// Retry-budget tests for hooks/scripts/_ingest-transcript.sh.
//
// The helper resolves its Bearer via "${CLAUDE_PLUGIN_ROOT}/bin/memory-refresh"
// (NOT via PATH). Each test stands up an isolated temp dir as the fake
// CLAUDE_PLUGIN_ROOT containing only `bin/memory-refresh` (a shell stub that
// echoes a fake token). The helper still loads _load-env.sh from its own
// SCRIPT_DIR (the real hooks/scripts/), so we do not need to copy lib scripts
// into the fake root. _load-env.sh tolerates missing .env files, and we pass
// MEMORY_API_URL via env which takes precedence anyway.
//
// A one-shot HTTP server counts requests and replies with a configurable
// status to drive the retry loop:
//   - 503  -> helper should retry up to MEMORY_INGEST_RETRIES attempts (default 2).
//   - 4xx  -> helper should exit after the first response (no retry).
//   - 503 then 2xx -> helper should stop at the first 2xx.
//
// IMPORTANT: we use async `spawn` (not `spawnSync`) so the Node event loop
// stays free to service the in-process HTTP server while the helper is
// running. Under `spawnSync`, the event loop blocks; curl inside the helper
// then times out waiting for a response that Node would have sent if its
// request handler had run. That deadlock is what makes the canonical
// spawnSync pattern incorrect for tests that talk back to the same Node
// process — particularly on Windows/Git Bash.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HELPER = join(process.cwd(), 'hooks', 'scripts', '_ingest-transcript.sh');

function withServer(handler) {
  return new Promise((resolve) => {
    const calls = { count: 0 };
    const srv = createServer((req, res) => {
      calls.count++;
      req.on('data', () => {});
      req.on('end', () => handler(req, res, calls));
    });
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls,
        close: () => new Promise((r) => srv.close(r)),
      });
    });
  });
}

function fakePluginRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'memory-plugin-root-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const refresh = join(bin, 'memory-refresh');
  writeFileSync(refresh, '#!/usr/bin/env bash\necho fake-bearer-token\n');
  chmodSync(refresh, 0o755);
  return dir;
}

function fakeTranscript() {
  const dir = mkdtempSync(join(tmpdir(), 'memory-transcript-'));
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(
    path,
    JSON.stringify({ role: 'user', content: 'hello', timestamp: '2026-06-19T00:00:00Z' }) + '\n' +
      JSON.stringify({ role: 'assistant', content: 'world', timestamp: '2026-06-19T00:00:01Z' }) + '\n',
  );
  return path;
}

function runHook({ url, event, transcriptPath, pluginRoot, retries = 2 }) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      MEMORY_API_URL: url,
      MEMORY_INGEST_RETRIES: String(retries),
      MEMORY_INGEST_RETRY_SLEEP: '0',
      CLAUDE_PLUGIN_ROOT: pluginRoot,
    };
    const payload = JSON.stringify({
      transcript_path: transcriptPath,
      session_id: 's',
      cwd: '/tmp',
    });
    const child = spawn('bash', [HELPER, '--event', event], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b.toString()));
    child.stderr.on('data', (b) => (stderr += b.toString()));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(payload);
  });
}

test('retries exactly N=2 times on 503 then gives up', async () => {
  const pluginRoot = fakePluginRoot();
  const transcript = fakeTranscript();
  const srv = await withServer((req, res) => {
    res.writeHead(503).end('{}');
  });
  try {
    const r = await runHook({
      url: srv.url,
      event: 'pre_compact',
      transcriptPath: transcript,
      pluginRoot,
      retries: 2,
    });
    assert.equal(r.status, 0, `helper should exit 0 (always); stderr=${r.stderr}`);
    assert.equal(srv.calls.count, 2);
  } finally {
    await srv.close();
  }
});

test('does not retry on 400', async () => {
  const pluginRoot = fakePluginRoot();
  const transcript = fakeTranscript();
  const srv = await withServer((req, res) => {
    res.writeHead(400).end('{}');
  });
  try {
    const r = await runHook({
      url: srv.url,
      event: 'pre_compact',
      transcriptPath: transcript,
      pluginRoot,
      retries: 2,
    });
    assert.equal(r.status, 0, `helper should exit 0 (always); stderr=${r.stderr}`);
    assert.equal(srv.calls.count, 1);
  } finally {
    await srv.close();
  }
});

test('stops retrying on first 2xx', async () => {
  const pluginRoot = fakePluginRoot();
  const transcript = fakeTranscript();
  const srv = await withServer((req, res, calls) => {
    if (calls.count === 1) {
      res.writeHead(503).end('{}');
      return;
    }
    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(
        '{"summary_memory_id":"x","extraction_job_id":"y","extracted_count":0,"scrub_hits":{"client":0,"server":0},"queued_extraction_types":[]}',
      );
  });
  try {
    const r = await runHook({
      url: srv.url,
      event: 'pre_compact',
      transcriptPath: transcript,
      pluginRoot,
      retries: 2,
    });
    assert.equal(r.status, 0, `helper should exit 0 (always); stderr=${r.stderr}`);
    assert.equal(srv.calls.count, 2);
  } finally {
    await srv.close();
  }
});
