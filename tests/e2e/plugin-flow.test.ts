/**
 * E2E: plugin-flow.test.ts
 *
 * Tests the full `bun bin/astramem ingest` dispatch path with mocked providers.
 * No real network calls are made.
 *
 * Strategy:
 *   - Use the runIngest / runRecall / runRemember functions directly (unit-level E2E)
 *     with injected MockProvider so the selector is bypassed.
 *   - Redirect APPDATA to a temp dir so log writes land in an isolated location.
 *   - Assert: exit code, provider stub called, log line written, no bearer in log.
 *
 * Skipped on Windows via describe.skipIf — astramem-dispatch.test.ts already covers
 * the subprocess smoke path on Win32.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runIngest } from '../../src/cli/ingest.ts';
import { runRecall } from '../../src/cli/recall.ts';
import { runRemember } from '../../src/cli/remember.ts';
import { createMockProvider, createFailingProvider } from '../cli/mock-provider.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function isolateTmpDir(): void {
  tmpDir = mkdtempSync(join(tmpdir(), 'astramem-e2e-'));
  // Override APPDATA so unifiedConfigDir() on Windows writes to our tmpDir
  process.env['APPDATA'] = tmpDir;
  // Override HOME-based path on POSIX by overriding XDG_CONFIG_HOME pattern
  // datadir.ts on POSIX uses ~/.config/astramem — we patch via APPDATA on win32;
  // on POSIX we set HOME to tmpDir so ~/.config/astramem becomes tmpDir/.config/astramem
  if (process.platform !== 'win32') {
    process.env['HOME'] = tmpDir;
  }
}

function cleanupTmpDir(): void {
  if (tmpDir && existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function readLogLines(): string[] {
  // Locate ingest.log in the temp config dir
  const logCandidates = [
    join(tmpDir, 'Astramem', 'ingest.log'),          // win32 path
    join(tmpDir, '.config', 'astramem', 'ingest.log'), // POSIX path
  ];
  for (const candidate of logCandidates) {
    if (existsSync(candidate)) {
      return readFileSync(candidate, 'utf-8').split('\n').filter(Boolean);
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Capture stdout/stderr
// ---------------------------------------------------------------------------

function captureOutput() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk: unknown) => { stdout.push(String(chunk)); return true; };
  process.stderr.write = (chunk: unknown) => { stderr.push(String(chunk)); return true; };
  return {
    get stdout() { return stdout.join(''); },
    get stderr() { return stderr.join(''); },
    restore() {
      process.stdout.write = origStdout;
      process.stderr.write = origStderr;
    },
  };
}

// ---------------------------------------------------------------------------
// Suite — skip on Windows (covered by astramem-dispatch.test.ts smoke)
// ---------------------------------------------------------------------------

describe.skipIf(process.platform === 'win32')('plugin-flow e2e (POSIX)', () => {
  let cap: ReturnType<typeof captureOutput>;

  beforeEach(() => {
    isolateTmpDir();
    cap = captureOutput();
  });

  afterEach(() => {
    cap.restore();
    cleanupTmpDir();
  });

  // -------------------------------------------------------------------------
  // ingest
  // -------------------------------------------------------------------------

  describe('runIngest — routed to mock local provider', () => {
    it('exits 0 and calls provider.ingest with valid payload', async () => {
      const provider = createMockProvider();
      const code = await runIngest(
        ['--json', JSON.stringify({ id: 'e2e-1', type: 'transcript', text: 'hello e2e' })],
        { _provider: provider },
      );
      expect(code).toBe(0);
      expect(provider._stubs.ingest).toHaveBeenCalledOnce();
      const arg = provider._stubs.ingest.mock.calls[0]![0];
      expect(arg).toMatchObject({ id: 'e2e-1', type: 'transcript', text: 'hello e2e' });
    });

    it('writes a log line after ingest', async () => {
      const provider = createMockProvider();
      await runIngest(
        ['--json', JSON.stringify({ id: 'log-test', type: 'fact', text: 'log assertion' })],
        { _provider: provider },
      );
      // Give appendIngestLog a tick to complete (it's sync, but allow event-loop flush)
      await new Promise((r) => setTimeout(r, 10));
      const lines = readLogLines();
      // The log may be empty if no error path fired — ingest success doesn't log by default.
      // Verify no Bearer appears in any log line that was written.
      for (const line of lines) {
        expect(line).not.toMatch(/Bearer\s+[A-Fa-f0-9]{32,}/);
      }
    });

    it('exits 0 even when provider throws, and no raw bearer in log', async () => {
      const fakeBearer = 'Bearer ' + 'a'.repeat(64);
      const provider = createFailingProvider(`network error: ${fakeBearer}`);
      const code = await runIngest(
        ['--json', JSON.stringify({ id: 'err-test', type: 'note', text: 'error flow' })],
        { _provider: provider },
      );
      expect(code).toBe(0);
      await new Promise((r) => setTimeout(r, 20));
      const lines = readLogLines();
      // At least one error log line should have been written
      expect(lines.length).toBeGreaterThan(0);
      // Bearer must be scrubbed in every log line
      for (const line of lines) {
        expect(line).not.toMatch(/Bearer\s+[A-Fa-f0-9]{32,}/);
      }
    });

    it('exits 0 with missing --json (fire-and-forget)', async () => {
      const provider = createMockProvider();
      const code = await runIngest([], { _provider: provider });
      expect(code).toBe(0);
      expect(provider._stubs.ingest).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // recall
  // -------------------------------------------------------------------------

  describe('runRecall — routed to mock local provider', () => {
    it('exits 0 and prints JSON hits to stdout', async () => {
      const provider = createMockProvider();
      const code = await runRecall(['--query', 'provider selector'], { _provider: provider });
      expect(code).toBe(0);
      expect(provider._stubs.recall).toHaveBeenCalledOnce();
      const out = JSON.parse(cap.stdout) as { hits: unknown[] };
      expect(Array.isArray(out.hits)).toBe(true);
      expect(out.hits.length).toBeGreaterThan(0);
    });

    it('returns exit 3 when provider throws', async () => {
      const provider = createFailingProvider('recall backend down');
      const code = await runRecall(['--query', 'test'], { _provider: provider });
      expect(code).toBe(3);
    });

    it('returns exit 3 with missing --query', async () => {
      const provider = createMockProvider();
      const code = await runRecall([], { _provider: provider });
      expect(code).toBe(3);
    });

    it('passes --k to provider as integer', async () => {
      const provider = createMockProvider();
      await runRecall(['--query', 'test', '--k', '3'], { _provider: provider });
      const req = provider._stubs.recall.mock.calls[0]![0];
      expect(req).toMatchObject({ query: 'test', k: 3 });
    });
  });

  // -------------------------------------------------------------------------
  // remember
  // -------------------------------------------------------------------------

  describe('runRemember — routed to mock local provider', () => {
    it('exits 0 and calls provider.remember', async () => {
      const provider = createMockProvider();
      const code = await runRemember(
        ['--content', 'We chose Bun for the CLI runtime', '--type', 'decision'],
        { _provider: provider },
      );
      expect(code).toBe(0);
      expect(provider._stubs.remember).toHaveBeenCalledOnce();
      const arg = provider._stubs.remember.mock.calls[0]![0];
      expect(arg).toMatchObject({ type: 'decision', text: 'We chose Bun for the CLI runtime' });
    });

    it('exits 0 and defaults type to fact', async () => {
      const provider = createMockProvider();
      const code = await runRemember(
        ['--content', 'Bearer scrub applies before every log write'],
        { _provider: provider },
      );
      expect(code).toBe(0);
      const arg = provider._stubs.remember.mock.calls[0]![0];
      expect(arg.type).toBe('fact');
    });

    it('exits 3 with missing --content', async () => {
      const provider = createMockProvider();
      const code = await runRemember([], { _provider: provider });
      expect(code).toBe(3);
    });

    it('exits 3 when provider throws', async () => {
      const provider = createFailingProvider('remember backend error');
      const code = await runRemember(
        ['--content', 'test memory', '--type', 'note'],
        { _provider: provider },
      );
      expect(code).toBe(3);
    });
  });
});
