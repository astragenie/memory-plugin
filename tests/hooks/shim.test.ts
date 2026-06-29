/**
 * Hook shim integration tests — FEAT 4a Slice 4.
 *
 * For each of the three rewritten hook scripts:
 *   1. Pipe a fixture hook-stdin.json payload as stdin via child_process.spawn.
 *   2. Set CLAUDE_PLUGIN_ROOT to repo root; MEMORY_API_URL_LOCAL to non-routable
 *      address so CLI provider call fails fast (but exit code must still be 0).
 *   3. Assert exit code 0 (fire-and-forget contract).
 *   4. Assert no raw bearer/AWS key leaks to stdout or stderr.
 *
 * Skipped on Win32 when bash is unavailable.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Platform guard — skip if bash not available on Win32
// ---------------------------------------------------------------------------

function bashAvailable(): boolean {
  const r = spawnSync('bash', ['--version'], { encoding: 'utf-8', timeout: 3000 });
  return r.status === 0;
}

const skipOnWin32 = process.platform === 'win32' && !bashAvailable();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const FIXTURE_ROOT = join(import.meta.dirname, 'fixtures');
const HOOKS_DIR = join(REPO_ROOT, 'hooks', 'scripts');

// Use a non-routable local address so the provider call fails fast (< 1s).
// The CLI is fire-and-forget so exit code must still be 0.
const DEAD_API_URL = 'http://127.0.0.1:1';

// Patterns that must NOT appear in hook output
const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9_\-]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /sk-[A-Za-z0-9]{20,}/,
];

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

interface ShimResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runShim(
  scriptName: string,
  stdinPayload: string,
  extraEnv: Record<string, string> = {},
): ShimResult {
  const scriptPath = join(HOOKS_DIR, scriptName);
  const result = spawnSync('bash', [scriptPath], {
    input: stdinPayload,
    encoding: 'utf-8',
    timeout: 10000,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: REPO_ROOT,
      MEMORY_API_URL_LOCAL: DEAD_API_URL,
      MEMORY_SUBAGENT_MAX_TURNS: '5',
      MEMORY_PRECOMPACT_MAX_TURNS: '5',
      MEMORY_SESSIONEND_MAX_TURNS: '5',
      ...extraEnv,
    },
  });
  return {
    exitCode: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function assertNoSecretLeak(result: ShimResult): void {
  const combined = result.stdout + result.stderr;
  for (const pattern of SECRET_PATTERNS) {
    expect(combined).not.toMatch(pattern);
  }
}

function loadFixtureStdin(fixturePath: string): string {
  return readFileSync(join(fixturePath, 'hook-stdin.json'), 'utf-8');
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(skipOnWin32)('hook shim exit-code + secret-leak gate (FEAT 4a Slice 4)', () => {

  // -------------------------------------------------------------------------
  // subagent-stop-capture.sh
  // -------------------------------------------------------------------------

  it('subagent-stop-capture.sh: exits 0 when provider unreachable', () => {
    const fixturePath = join(FIXTURE_ROOT, 'subagent_stop', '01-basic');
    // Rewrite transcript_path to actual fixture transcript
    const stdinRaw = loadFixtureStdin(fixturePath);
    const transcriptPath = join(fixturePath, 'transcript.jsonl').replace(/\\/g, '/');
    const payload = stdinRaw
      .replace(/__FIXTURE_TRANSCRIPT_PATH__/g, transcriptPath);

    const r = runShim('subagent-stop-capture.sh', payload);
    expect(r.exitCode).toBe(0);
    assertNoSecretLeak(r);
  });

  it('subagent-stop-capture.sh: exits 0 on empty stdin', () => {
    const r = runShim('subagent-stop-capture.sh', '');
    expect(r.exitCode).toBe(0);
    assertNoSecretLeak(r);
  });

  // -------------------------------------------------------------------------
  // pre-compact-capture.sh
  // -------------------------------------------------------------------------

  it('pre-compact-capture.sh: exits 0 when provider unreachable', () => {
    const fixturePath = join(FIXTURE_ROOT, 'pre_compact', '01-basic');
    const stdinRaw = loadFixtureStdin(fixturePath);
    const transcriptPath = join(fixturePath, 'transcript.jsonl').replace(/\\/g, '/');
    const payload = stdinRaw
      .replace(/__FIXTURE_TRANSCRIPT_PATH__/g, transcriptPath);

    const r = runShim('pre-compact-capture.sh', payload);
    expect(r.exitCode).toBe(0);
    assertNoSecretLeak(r);
  });

  it('pre-compact-capture.sh: exits 0 on empty stdin', () => {
    const r = runShim('pre-compact-capture.sh', '');
    expect(r.exitCode).toBe(0);
    assertNoSecretLeak(r);
  });

  // -------------------------------------------------------------------------
  // session-end-summary.sh
  // -------------------------------------------------------------------------

  it('session-end-summary.sh: exits 0 when provider unreachable', () => {
    const fixturePath = join(FIXTURE_ROOT, 'session_end', '01-basic');
    const stdinRaw = loadFixtureStdin(fixturePath);
    const transcriptPath = join(fixturePath, 'transcript.jsonl').replace(/\\/g, '/');
    const payload = stdinRaw
      .replace(/__FIXTURE_TRANSCRIPT_PATH__/g, transcriptPath);

    const r = runShim('session-end-summary.sh', payload);
    expect(r.exitCode).toBe(0);
    assertNoSecretLeak(r);
  });

  it('session-end-summary.sh: exits 0 on empty stdin', () => {
    const r = runShim('session-end-summary.sh', '');
    expect(r.exitCode).toBe(0);
    assertNoSecretLeak(r);
  });
});
