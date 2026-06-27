// Tests for memory-connect CLI.
// Strategy: spawn the binary via spawn with ASTRAMEMORY_HOME pointed at a per-test
// temp dir so every test is fully isolated. Fetch calls are intercepted by a real
// in-process HTTP server on a random port.
import { describe, it, expect, afterEach } from 'vitest';
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
import type { AddressInfo } from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const BIN = join(repoRoot, 'bin', 'memory-connect.ts');

interface ServerHandle {
  url: string;
  calls: { count: number; requests: Array<{ method: string; url: string; headers: Record<string, string>; body: unknown }> };
  close: () => Promise<void>;
}

function withServer(
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, calls: ServerHandle['calls']) => void
): Promise<ServerHandle> {
  return new Promise((resolve) => {
    const calls: ServerHandle['calls'] = { count: 0, requests: [] };
    const srv = createServer((req, res) => {
      calls.count++;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: unknown = null;
        try { body = JSON.parse(raw); } catch { body = raw; }
        calls.requests.push({ method: req.method!, url: req.url!, headers: req.headers as Record<string, string>, body });
        handler(req, res, calls);
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls,
        close: () => {
          if (typeof (srv as unknown as { closeAllConnections?: () => void }).closeAllConnections === 'function') {
            (srv as unknown as { closeAllConnections: () => void }).closeAllConnections();
          }
          return new Promise<void>((r) => srv.close(() => r()));
        },
      });
    });
  });
}

function makeTmpHome(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'mc-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function writeProfiles(home: string, profiles: Record<string, { apiUrl: string }>): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'profiles.json'), JSON.stringify(profiles, null, 2));
}

function readTokens(home: string, env: string): Record<string, unknown> | null {
  const p = join(home, `tokens.${env}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
}

// Async spawn — under spawnSync the Node event loop blocks and HTTP servers deadlock.
function run(args: string[], { home, cwd, env: extraEnv = {} }: { home: string; cwd?: string; env?: Record<string, string> } = { home: '' }): Promise<{ stdout: string; stderr: string; status: number | null; signal: NodeJS.Signals | null }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ASTRAMEMORY_HOME: home,
    ...extraEnv,
  };
  delete env['ASTRAMEMORY_ENV'];

  return new Promise((resolve, reject) => {
    const child = spawn('bun', [BIN, ...args], {
      cwd: cwd ?? repoRoot,
      env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b: Buffer) => (stdout += b.toString()));
    child.stderr.on('data', (b: Buffer) => (stderr += b.toString()));
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

describe('memory-connect', () => {
  it('happy path: 200 redeem writes tokens file and exits 0', async () => {
    const { dir: home, cleanup } = makeTmpHome();
    const ENV = 'testenv';
    const CODE = 'ABCD-1234';
    const API_KEY = 'sk-testapikeyfoobar9999';
    const TENANT_ID = 'tenant-abc';
    const WS_ID = 'my-workspace';

    const srv = await withServer((req, res) => {
      if (req.url!.includes('/claims/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          apiUrl: srv.url,
          tenantId: TENANT_ID,
          workspaceId: WS_ID,
          apiKey: API_KEY,
        }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'mem-001' }));
      }
    });

    try {
      writeProfiles(home, { [ENV]: { apiUrl: srv.url } });
      const result = await run([CODE, '--env', ENV, '--workspace', WS_ID], { home });

      expect(result.status, `should exit 0; stderr=${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('✓');
      expect(result.stdout).toContain(WS_ID);
      expect(result.stdout).toContain(ENV);

      const tokens = readTokens(home, ENV) as Record<string, Record<string, unknown>> | null;
      expect(tokens).toBeTruthy();
      expect(tokens![WS_ID]).toBeTruthy();
      expect((tokens![WS_ID] as { tenantId: string }).tenantId).toBe(TENANT_ID);
      expect((tokens![WS_ID] as { apiKey: string }).apiKey).toBe(API_KEY);
      expect((tokens![WS_ID] as { pairedAt: string }).pairedAt).toBeTruthy();
      expect((tokens![WS_ID] as { label: string }).label.startsWith('claim-')).toBe(true);

      expect(srv.calls.count).toBeGreaterThanOrEqual(2);
      const handshakeReq = srv.calls.requests.find(r => r.url === '/memories');
      expect(handshakeReq).toBeTruthy();
      expect(handshakeReq!.headers['authorization']?.startsWith('ApiKey ')).toBe(true);
    } finally {
      await srv.close();
      cleanup();
    }
  });

  it('410 expired code: exits 1 and does not write token file', async () => {
    const { dir: home, cleanup } = makeTmpHome();
    const ENV = 'testenv';
    const CODE = 'ZZZZ-9999';

    const srv = await withServer((_req, res) => {
      res.writeHead(410);
      res.end();
    });

    try {
      writeProfiles(home, { [ENV]: { apiUrl: srv.url } });
      const result = await run([CODE, '--env', ENV, '--workspace', 'some-workspace'], { home });

      expect(result.status, `should exit 1 on 410; stderr=${result.stderr}`).toBe(1);
      expect(result.stderr).toContain('expired');

      const tokens = readTokens(home, ENV) as Record<string, unknown> | null;
      expect(!tokens || !(tokens as Record<string, unknown>)['some-workspace']).toBe(true);
    } finally {
      await srv.close();
      cleanup();
    }
  });

  it('network failure: exits 2 when server is unreachable', async () => {
    const { dir: home, cleanup } = makeTmpHome();
    const ENV = 'testenv';

    try {
      writeProfiles(home, { [ENV]: { apiUrl: 'http://127.0.0.1:1' } });
      const result = await run(['ABCD-0001', '--env', ENV, '--workspace', 'ws'], { home });
      expect(result.status, `should exit 2 on network failure; stderr=${result.stderr}`).toBe(2);
    } finally {
      cleanup();
    }
  });

  it('missing profile: exits 4 when env not in profiles.json', async () => {
    const { dir: home, cleanup } = makeTmpHome();

    try {
      writeProfiles(home, { prod: { apiUrl: 'https://api.example.com' } });
      const result = await run(['ABCD-0001', '--env', 'staging', '--workspace', 'ws'], { home });

      expect(result.status, `should exit 4 on missing profile; stderr=${result.stderr}`).toBe(4);
      expect(result.stderr).toContain('staging');
    } finally {
      cleanup();
    }
  });

  it('missing profiles.json: exits 4 when file does not exist', async () => {
    const { dir: home, cleanup } = makeTmpHome();

    try {
      const result = await run(['ABCD-0001', '--env', 'prod', '--workspace', 'ws'], { home });
      expect(result.status, `should exit 4 when profiles.json missing; stderr=${result.stderr}`).toBe(4);
    } finally {
      cleanup();
    }
  });

  it('workspaceId defaults to basename of cwd', async () => {
    const { dir: home, cleanup } = makeTmpHome();
    const ENV = 'testenv';
    const API_KEY = 'sk-cwdtest0000';
    const EXPECTED_WS = basename(repoRoot);

    const srv = await withServer((req, res) => {
      if (req.url!.includes('/claims/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          apiUrl: srv.url,
          tenantId: 't1',
          workspaceId: null,
          apiKey: API_KEY,
        }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      }
    });

    try {
      writeProfiles(home, { [ENV]: { apiUrl: srv.url } });
      const result = await run(['ABCD-1111', '--env', ENV], { home, cwd: repoRoot });

      expect(result.status, `should exit 0; stderr=${result.stderr}`).toBe(0);

      const tokens = readTokens(home, ENV) as Record<string, unknown> | null;
      expect(tokens).toBeTruthy();
      expect((tokens as Record<string, unknown>)[EXPECTED_WS]).toBeTruthy();
    } finally {
      await srv.close();
      cleanup();
    }
  });

  it('atomic write: existing workspaceId entries preserved when appending new', async () => {
    const { dir: home, cleanup } = makeTmpHome();
    const ENV = 'testenv';
    const API_KEY_W1 = 'sk-w1existing0001';
    const API_KEY_W2 = 'sk-w2new000000002';

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
      if (req.url!.includes('/claims/')) {
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

    try {
      writeProfiles(home, { [ENV]: { apiUrl: srv.url } });
      const result = await run(['ABCD-2222', '--env', ENV, '--workspace', 'workspace-2'], { home });

      expect(result.status, `should exit 0; stderr=${result.stderr}`).toBe(0);

      const tokens = readTokens(home, ENV) as Record<string, { apiKey: string }> | null;
      expect(tokens).toBeTruthy();
      expect(tokens!['workspace-1']?.apiKey).toBe(API_KEY_W1);
      expect(tokens!['workspace-2']?.apiKey).toBe(API_KEY_W2);
    } finally {
      await srv.close();
      cleanup();
    }
  });

  it('masking: success line never reveals more than last 4 chars of apiKey', async () => {
    const { dir: home, cleanup } = makeTmpHome();
    const ENV = 'testenv';
    const API_KEY = 'sk-supersecretlongkey9999';
    const LAST_FOUR = API_KEY.slice(-4);

    const srv = await withServer((req, res) => {
      if (req.url!.includes('/claims/')) {
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

    try {
      writeProfiles(home, { [ENV]: { apiUrl: srv.url } });
      const result = await run(['ABCD-3333', '--env', ENV, '--workspace', 'ws'], { home });

      expect(result.status, `should exit 0; stderr=${result.stderr}`).toBe(0);

      const fullSecret = API_KEY.slice(0, -4);
      expect(result.stdout, `stdout must not contain more than last 4 chars`).not.toContain(fullSecret);
      expect(result.stderr, `stderr must not contain more than last 4 chars`).not.toContain(fullSecret);
      expect(result.stdout, `stdout should include last 4 chars "${LAST_FOUR}"`).toContain(LAST_FOUR);
    } finally {
      await srv.close();
      cleanup();
    }
  });

  it('--url override: bypasses profiles.json lookup', async () => {
    const { dir: home, cleanup } = makeTmpHome();
    const ENV = 'prod';
    const API_KEY = 'sk-overridetest1234';

    const srv = await withServer((req, res) => {
      if (req.url!.includes('/claims/')) {
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

    try {
      const result = await run(
        ['ABCD-4444', '--env', ENV, '--url', srv.url, '--workspace', 'ws-override'],
        { home }
      );

      expect(result.status, `should exit 0 with --url override; stderr=${result.stderr}`).toBe(0);

      const tokens = readTokens(home, ENV) as Record<string, unknown> | null;
      expect((tokens as Record<string, unknown>)?.['ws-override']).toBeTruthy();
    } finally {
      await srv.close();
      cleanup();
    }
  });

  it('handshake soft-fail: exits 0 even when handshake POST returns 500', async () => {
    const { dir: home, cleanup } = makeTmpHome();
    const ENV = 'testenv';
    const API_KEY = 'sk-softfailtest0001';

    const srv = await withServer((req, res) => {
      if (req.url!.includes('/claims/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          apiUrl: srv.url,
          tenantId: 'tid',
          workspaceId: 'ws-soft',
          apiKey: API_KEY,
        }));
      } else {
        res.writeHead(500);
        res.end();
      }
    });

    try {
      writeProfiles(home, { [ENV]: { apiUrl: srv.url } });
      const result = await run(['ABCD-5555', '--env', ENV, '--workspace', 'ws-soft'], { home });

      expect(result.status, `should exit 0 even on handshake failure; stderr=${result.stderr}`).toBe(0);
      expect(result.stderr).toContain('warning');

      const tokens = readTokens(home, ENV) as Record<string, unknown> | null;
      expect((tokens as Record<string, unknown>)?.['ws-soft']).toBeTruthy();
    } finally {
      await srv.close();
      cleanup();
    }
  });

  it('structured log: stderr contains JSON log line for ok path', async () => {
    const { dir: home, cleanup } = makeTmpHome();
    const ENV = 'logtest';
    const API_KEY = 'sk-logtest00009876';

    const srv = await withServer((req, res) => {
      if (req.url!.includes('/claims/')) {
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

    try {
      writeProfiles(home, { [ENV]: { apiUrl: srv.url } });
      const result = await run(['ABCD-6666', '--env', ENV, '--workspace', 'ws-log'], { home });

      expect(result.status, `should exit 0; stderr=${result.stderr}`).toBe(0);

      const lines = result.stderr.split('\n').filter(l => l.trim().startsWith('{'));
      expect(lines.length, `stderr should contain at least one JSON log line; stderr=${result.stderr}`).toBeGreaterThanOrEqual(1);
      const log = JSON.parse(lines[lines.length - 1]!) as { service: string; env: string; outcome: string; exitCode: number; durationMs: number };
      expect(log.service).toBe('memory');
      expect(log.env).toBe(ENV);
      expect(log.outcome).toBe('ok');
      expect(log.exitCode).toBe(0);
      expect(typeof log.durationMs).toBe('number');
    } finally {
      await srv.close();
      cleanup();
    }
  });

  it('structured log: stderr contains JSON log line for expired path', async () => {
    const { dir: home, cleanup } = makeTmpHome();
    const ENV = 'logtest2';

    const srv = await withServer((_req, res) => {
      res.writeHead(410, { 'Content-Type': 'application/json', 'Connection': 'close' });
      res.end('{"error":"claim_gone"}');
    });

    try {
      writeProfiles(home, { [ENV]: { apiUrl: srv.url } });
      const result = await run(['ZZZZ-7777', '--env', ENV, '--workspace', 'ws'], { home });

      expect(result.status).toBe(1);
      const lines = result.stderr.split('\n').filter(l => l.trim().startsWith('{'));
      expect(lines.length, `stderr should contain JSON log line; stderr=${result.stderr}`).toBeGreaterThanOrEqual(1);
      const log = JSON.parse(lines[0]!) as { outcome: string; exitCode: number };
      expect(log.outcome).toBe('expired');
      expect(log.exitCode).toBe(1);
    } finally {
      await srv.close();
      cleanup();
    }
  });

  it('structured log: stderr contains JSON log line for missing profile path', async () => {
    const { dir: home, cleanup } = makeTmpHome();

    try {
      writeProfiles(home, { prod: { apiUrl: 'https://x.example.com' } });
      const result = await run(['ABCD-8888', '--env', 'notexist', '--workspace', 'ws'], { home });

      expect(result.status).toBe(4);
      const lines = result.stderr.split('\n').filter(l => l.trim().startsWith('{'));
      expect(lines.length, `stderr should contain JSON log line; stderr=${result.stderr}`).toBeGreaterThanOrEqual(1);
      const log = JSON.parse(lines[0]!) as { exitCode: number };
      expect(log.exitCode).toBe(4);
    } finally {
      cleanup();
    }
  });
});
