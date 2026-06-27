// Payload-shape test for hooks/scripts/_ingest-transcript.sh.
// Requires bash on PATH — skipped on Windows where bash may not be available
// in the runner environment. CI Linux/macOS runs these for real.
import { describe, it, expect } from 'vitest';
import { platform } from 'node:os';
const SKIP_ON_WIN = platform() === 'win32';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const HELPER = join(process.cwd(), 'hooks', 'scripts', '_ingest-transcript.sh');

const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';

interface ServerHandle {
  url: string;
  calls: { count: number; bodies: unknown[] };
  close: () => Promise<void>;
}

function withServer(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, calls: ServerHandle['calls']) => void): Promise<ServerHandle> {
  return new Promise((resolve) => {
    const calls = { count: 0, bodies: [] as unknown[] };
    const srv = createServer((req, res) => {
      calls.count++;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown = null;
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
      const addr = srv.address() as import('node:net').AddressInfo;
      const port = addr.port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls,
        close: () => new Promise<void>((r) => srv.close(() => { r(); })),
      });
    });
  });
}

function fakePluginRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'memory-plugin-root-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const refresh = join(bin, 'memory-refresh');
  writeFileSync(refresh, '#!/usr/bin/env bash\necho fake-bearer-token\n');
  chmodSync(refresh, 0o755);
  return dir;
}

function fakeTranscript(): string {
  const dir = mkdtempSync(join(tmpdir(), 'memory-transcript-'));
  const path = join(dir, 'transcript.jsonl');
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

interface RunHookOpts {
  url: string;
  event: string;
  transcriptPath: string;
  pluginRoot: string;
  sessionId: string;
  retries?: number;
}

function runHook({ url, event, transcriptPath, pluginRoot, sessionId, retries = 1 }: RunHookOpts): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ASTRAMEMORY_API_URL: url,
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
    child.stdout.on('data', (b: Buffer) => (stdout += b.toString()));
    child.stderr.on('data', (b: Buffer) => (stderr += b.toString()));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(payload);
  });
}

describe.skipIf(SKIP_ON_WIN)('ingest-payload (bash helper)', () => {
  it('POST body matches /ingest/transcript contract', async () => {
    const pluginRoot = fakePluginRoot();
    const transcript = fakeTranscript();
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
      expect(r.status, `helper should exit 0; stderr=${r.stderr}`).toBe(0);
      expect(srv.calls.count).toBe(1);

      const body = srv.calls.bodies[0] as Record<string, unknown>;
      expect(body && typeof body === 'object').toBe(true);
      expect((body as { __parse_error?: boolean }).__parse_error).toBeFalsy();

      expect(body['event']).toBe(EVENT);
      expect(body['session_id']).toBe(SESSION_ID);
      expect(body['client_scrub_applied']).toBe(true);
      expect(typeof body['client_scrub_hits']).toBe('number');
      expect(body['client_scrub_hits'] as number).toBeGreaterThanOrEqual(1);
      expect(typeof body['client_version']).toBe('string');
      expect((body['client_version'] as string).length).toBeGreaterThan(0);

      const turns = body['turns'] as Array<{ role: string; text: string }>;
      expect(Array.isArray(turns)).toBe(true);
      expect(turns.length).toBe(2);
      expect(turns[0]!.role).toBe('user');
      expect(turns[1]!.role).toBe('assistant');

      expect(turns[0]!.text).toMatch(/\[redacted:aws-key\]/);
      expect(turns[0]!.text).not.toMatch(new RegExp(AWS_KEY));

      const rawBody = JSON.stringify(body);
      expect(rawBody).not.toMatch(new RegExp(AWS_KEY));
    } finally {
      await srv.close();
      rmSync(pluginRoot, { recursive: true, force: true });
      rmSync(dirname(transcript), { recursive: true, force: true });
    }
  });
});
