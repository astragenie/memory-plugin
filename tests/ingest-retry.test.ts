import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// TODO Wave 2/3: these tests invoke the bash helper and require bash on PATH.

const HELPER = join(process.cwd(), 'hooks', 'scripts', '_ingest-transcript.sh');

interface ServerHandle {
  url: string;
  calls: { count: number };
  close: () => Promise<void>;
}

function withServer(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, calls: { count: number }) => void): Promise<ServerHandle> {
  return new Promise((resolve) => {
    const calls = { count: 0 };
    const srv = createServer((req, res) => {
      calls.count++;
      req.on('data', () => {});
      req.on('end', () => handler(req, res, calls));
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as import('node:net').AddressInfo;
      const port = addr.port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls,
        close: () => new Promise<void>((r) => srv.close(() => r())),
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
    JSON.stringify({ role: 'user', content: 'hello', timestamp: '2026-06-19T00:00:00Z' }) + '\n' +
      JSON.stringify({ role: 'assistant', content: 'world', timestamp: '2026-06-19T00:00:01Z' }) + '\n',
  );
  return path;
}

interface RunHookOpts {
  url: string;
  event: string;
  transcriptPath: string;
  pluginRoot: string;
  retries?: number;
}

function runHook({ url, event, transcriptPath, pluginRoot, retries = 2 }: RunHookOpts): Promise<{ status: number | null; stdout: string; stderr: string }> {
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
      session_id: 's',
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

describe('ingest-retry (bash helper)', () => {
  it('retries exactly N=2 times on 503 then gives up', async () => {
    const pluginRoot = fakePluginRoot();
    const transcript = fakeTranscript();
    try {
      const srv = await withServer((_req, res) => {
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
        expect(r.status, `helper should exit 0 (always); stderr=${r.stderr}`).toBe(0);
        expect(srv.calls.count).toBe(2);
      } finally {
        await srv.close();
      }
    } finally {
      rmSync(pluginRoot, { recursive: true, force: true });
      rmSync(dirname(transcript), { recursive: true, force: true });
    }
  });

  it('does not retry on 400', async () => {
    const pluginRoot = fakePluginRoot();
    const transcript = fakeTranscript();
    try {
      const srv = await withServer((_req, res) => {
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
        expect(r.status, `helper should exit 0 (always); stderr=${r.stderr}`).toBe(0);
        expect(srv.calls.count).toBe(1);
      } finally {
        await srv.close();
      }
    } finally {
      rmSync(pluginRoot, { recursive: true, force: true });
      rmSync(dirname(transcript), { recursive: true, force: true });
    }
  });

  it('stops retrying on first 2xx', async () => {
    const pluginRoot = fakePluginRoot();
    const transcript = fakeTranscript();
    try {
      const capturedBodies: unknown[] = [];
      const calls = { count: 0 };
      const srv: ServerHandle = await new Promise((resolve) => {
        const s = createServer((req, res) => {
          calls.count++;
          const chunks: Buffer[] = [];
          req.on('data', (c: Buffer) => chunks.push(c));
          req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            try {
              capturedBodies.push(JSON.parse(raw));
            } catch {
              capturedBodies.push({ __parse_error: true, raw });
            }
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
        });
        s.listen(0, '127.0.0.1', () => {
          const addr = s.address() as import('node:net').AddressInfo;
          const port = addr.port;
          resolve({
            url: `http://127.0.0.1:${port}`,
            calls,
            close: () => new Promise<void>((r) => s.close(() => r())),
          });
        });
      });
      try {
        const r = await runHook({
          url: srv.url,
          event: 'pre_compact',
          transcriptPath: transcript,
          pluginRoot,
          retries: 2,
        });
        expect(r.status, `helper should exit 0 (always); stderr=${r.stderr}`).toBe(0);
        expect(srv.calls.count).toBe(2);
        const lastBody = capturedBodies[capturedBodies.length - 1] as { event?: string } | null;
        expect(lastBody && (lastBody as { event?: string }).event).toBeTruthy();
      } finally {
        await srv.close();
      }
    } finally {
      rmSync(pluginRoot, { recursive: true, force: true });
      rmSync(dirname(transcript), { recursive: true, force: true });
    }
  });
});
