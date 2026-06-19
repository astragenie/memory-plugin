// Payload-shape test for hooks/scripts/_ingest-transcript.sh.
//
// Verifies the body POSTed to /ingest/transcript matches the endpoint contract
// documented in docs/superpowers/specs/2026-06-19-astramemory-transcript-ingest-design.md.
//
// Scaffolding mirrors ingest-retry.test.mjs:
//   - async `spawn` (NOT spawnSync) to avoid deadlock with the in-process HTTP server.
//   - fake CLAUDE_PLUGIN_ROOT containing only `bin/memory-refresh` stub.
//   - per-test t.after(...) cleanup of temp dirs via rmSync.
//
// The HTTP server buffers req.on('data') chunks, parses JSON in req.on('end'),
// stashes the parsed body on the calls object, then writes a minimal valid
// /ingest/transcript response so the helper exits 0 cleanly.
//
// Helpers are duplicated from ingest-retry.test.mjs on purpose — extracting a
// shared module is out of scope for this task.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const HELPER = join(process.cwd(), 'hooks', 'scripts', '_ingest-transcript.sh');

const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';

function withServer(handler) {
  return new Promise((resolve) => {
    const calls = { count: 0, bodies: [] };
    const srv = createServer((req, res) => {
      calls.count++;
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = { __parse_error: true, raw };
        }
        calls.bodies.push(parsed);
        handler(req, res, calls);
      });
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
  // First turn is `user` and contains an AWS-key-shaped string so the client
  // scrub fires (client_scrub_hits >= 1) and turns[0].text is redacted.
  writeFileSync(
    path,
    JSON.stringify({
      role: 'user',
      content: `please review this leaked key ${AWS_KEY} thanks`,
      timestamp: '2026-06-19T00:00:00Z',
    }) + '\n' +
      JSON.stringify({
        role: 'assistant',
        content: 'noted, I will scrub it',
        timestamp: '2026-06-19T00:00:01Z',
      }) + '\n',
  );
  return path;
}

function runHook({ url, event, transcriptPath, pluginRoot, sessionId, retries = 1 }) {
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
      session_id: sessionId,
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

test('POST body matches /ingest/transcript contract', async (t) => {
  const pluginRoot = fakePluginRoot();
  t.after(() => rmSync(pluginRoot, { recursive: true, force: true }));
  const transcript = fakeTranscript();
  t.after(() => rmSync(dirname(transcript), { recursive: true, force: true }));

  const SESSION_ID = 'session-abc-123';
  const EVENT = 'pre_compact';

  const srv = await withServer((_req, res) => {
    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(
        '{"summary_memory_id":"x","extraction_job_id":"y","extracted_count":0,"scrub_hits":{"client":0,"server":0},"queued_extraction_types":[]}',
      );
  });

  try {
    const r = await runHook({
      url: srv.url,
      event: EVENT,
      transcriptPath: transcript,
      pluginRoot,
      sessionId: SESSION_ID,
      retries: 1,
    });
    assert.equal(r.status, 0, `helper should exit 0; stderr=${r.stderr}`);
    assert.equal(srv.calls.count, 1, 'helper should POST exactly once on 200');

    const body = srv.calls.bodies[0];
    assert.ok(body && typeof body === 'object', 'body should be a JSON object');
    assert.ok(!body.__parse_error, `body should be valid JSON; got: ${JSON.stringify(body)}`);

    // Top-level contract fields.
    assert.equal(body.event, EVENT, 'event matches --event flag');
    assert.equal(body.session_id, SESSION_ID, 'session_id matches stdin payload');
    assert.equal(body.client_scrub_applied, true, 'client_scrub_applied is true');
    assert.equal(typeof body.client_scrub_hits, 'number', 'client_scrub_hits is numeric');
    assert.ok(
      body.client_scrub_hits >= 1,
      `client_scrub_hits should fire on AWS-key transcript; got ${body.client_scrub_hits}`,
    );
    assert.equal(typeof body.client_version, 'string', 'client_version is a string');
    assert.ok(body.client_version.length > 0, 'client_version is non-empty');

    // Turns array shape.
    assert.ok(Array.isArray(body.turns), 'turns is an array');
    assert.equal(body.turns.length, 2, 'turns has 2 entries');
    assert.equal(body.turns[0].role, 'user', 'turns[0].role is user');
    assert.equal(body.turns[1].role, 'assistant', 'turns[1].role is assistant');

    // Scrub actually redacted the AWS key in the user turn and the original
    // secret never reaches the server.
    assert.match(
      body.turns[0].text,
      /\[redacted:aws-key\]/,
      'turns[0].text should contain [redacted:aws-key] marker',
    );
    assert.doesNotMatch(
      body.turns[0].text,
      new RegExp(AWS_KEY),
      'turns[0].text must not leak the original AWS key',
    );
    // Belt-and-suspenders: the raw secret should not appear anywhere in the body.
    const rawBody = JSON.stringify(body);
    assert.doesNotMatch(
      rawBody,
      new RegExp(AWS_KEY),
      'serialized request body must not contain the original AWS key',
    );
  } finally {
    await srv.close();
  }
});
