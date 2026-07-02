/**
 * Tests for src/cli/ingest-transcript.ts — astramem ingest-transcript subcommand.
 *
 * Strategy: inject mock providers via opts._provider so the selector is bypassed.
 * Transcript fixture files are written to a temp dir per test.
 * APPDATA / HOME redirected so log writes are isolated.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runIngestTranscript } from '../../src/cli/ingest-transcript.ts';
import { createMockProvider, createFailingProvider } from './mock-provider.ts';
import type { TranscriptIngestPayload } from '../../src/contracts/wire.ts';
import { TransientError } from '../../src/lib/errors.ts';
import { pendingDir } from '../../src/lib/pending.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let originalAppData: string | undefined;
let originalHome: string | undefined;

function isolateTmpDir(): void {
  tmpDir = mkdtempSync(join(tmpdir(), 'astramem-it-'));
  originalAppData = process.env['APPDATA'];
  originalHome = process.env['HOME'];
  process.env['APPDATA'] = tmpDir;
  if (process.platform !== 'win32') {
    process.env['HOME'] = tmpDir;
  }
}

function cleanupTmpDir(): void {
  if (originalAppData !== undefined) {
    process.env['APPDATA'] = originalAppData;
  } else {
    delete process.env['APPDATA'];
  }
  if (process.platform !== 'win32') {
    if (originalHome !== undefined) {
      process.env['HOME'] = originalHome;
    } else {
      delete process.env['HOME'];
    }
  }
  if (tmpDir && existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Write JSONL lines to a temp file and return its path */
function writeTranscript(lines: object[]): string {
  const filePath = join(tmpDir, `transcript-${Date.now()}.jsonl`);
  writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf-8');
  return filePath;
}

function captureOutput() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  return {
    get stdout() { return stdout.join(''); },
    get stderr() { return stderr.join(''); },
    restore: () => { stdoutSpy.mockRestore(); stderrSpy.mockRestore(); },
  };
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const FAKE_BEARER = 'Bearer ' + 'a'.repeat(64);

/** Minimal valid base args */
function baseArgs(transcriptPath: string): string[] {
  return [
    '--event', 'pre_compact',
    '--transcript-path', transcriptPath,
    '--session-id', 'sess-test-001',
    '--project-id', 'proj-test-001',
  ];
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('runIngestTranscript', () => {
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
  // Arg validation
  // -------------------------------------------------------------------------

  it('returns 3 when --event is missing', async () => {
    const path = writeTranscript([{ role: 'user', text: 'hi' }]);
    const provider = createMockProvider();
    const code = await runIngestTranscript(
      ['--transcript-path', path, '--session-id', 'sid', '--project-id', 'pid'],
      { _provider: provider },
    );
    expect(code).toBe(3);
    expect(cap.stderr).toMatch(/--event.*required/i);
    expect(provider._stubs.ingestTranscript).not.toHaveBeenCalled();
  });

  it('returns 0 (fire-and-forget) when --transcript-path is missing', async () => {
    const provider = createMockProvider();
    const code = await runIngestTranscript(
      ['--event', 'pre_compact', '--session-id', 'sid', '--project-id', 'pid'],
      { _provider: provider },
    );
    expect(code).toBe(0);
    expect(provider._stubs.ingestTranscript).not.toHaveBeenCalled();
  });

  it('returns 0 (fire-and-forget) when transcript file does not exist', async () => {
    const provider = createMockProvider();
    const code = await runIngestTranscript(
      ['--event', 'pre_compact', '--transcript-path', '/nonexistent/path/transcript.jsonl',
       '--session-id', 'sid', '--project-id', 'pid'],
      { _provider: provider },
    );
    expect(code).toBe(0);
    expect(provider._stubs.ingestTranscript).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Role filter
  // -------------------------------------------------------------------------

  it('drops system and other non-user/assistant roles', async () => {
    const filePath = writeTranscript([
      { role: 'system', text: 'system message' },
      { role: 'user', text: 'user message' },
      { role: 'tool', text: 'tool output' },
      { role: 'assistant', text: 'assistant reply' },
    ]);
    const provider = createMockProvider();
    const code = await runIngestTranscript(baseArgs(filePath), { _provider: provider });
    expect(code).toBe(0);
    expect(provider._stubs.ingestTranscript).toHaveBeenCalledOnce();
    const envelope = provider._stubs.ingestTranscript.mock.calls[0]![0] as TranscriptIngestPayload;
    expect(envelope.turns).toHaveLength(2);
    expect(envelope.turns.every((t) => t.role === 'user' || t.role === 'assistant')).toBe(true);
    expect(envelope.turns[0]!.text).toBe('user message');
    expect(envelope.turns[1]!.text).toBe('assistant reply');
  });

  // -------------------------------------------------------------------------
  // Tail to --max-turns
  // -------------------------------------------------------------------------

  it('tails to --max-turns (drops oldest)', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      text: `turn-${i}`,
    }));
    const filePath = writeTranscript(lines);
    const provider = createMockProvider();
    const code = await runIngestTranscript(
      [...baseArgs(filePath), '--max-turns', '4'],
      { _provider: provider },
    );
    expect(code).toBe(0);
    const envelope = provider._stubs.ingestTranscript.mock.calls[0]![0] as TranscriptIngestPayload;
    expect(envelope.turns).toHaveLength(4);
    // Should be the last 4 turns: turn-6, turn-7, turn-8, turn-9
    expect(envelope.turns[0]!.text).toBe('turn-6');
    expect(envelope.turns[3]!.text).toBe('turn-9');
  });

  // -------------------------------------------------------------------------
  // --max-chars truncation (oldest-first drop)
  // -------------------------------------------------------------------------

  it('truncates to --max-chars by dropping oldest turns first', async () => {
    // Each turn has 100 chars. With max-chars=250, we can fit 2 turns (200 chars);
    // the first turn (oldest) gets dropped.
    const lines = [
      { role: 'user', text: 'A'.repeat(100) },
      { role: 'assistant', text: 'B'.repeat(100) },
      { role: 'user', text: 'C'.repeat(100) },
    ];
    const filePath = writeTranscript(lines);
    const provider = createMockProvider();
    const code = await runIngestTranscript(
      [...baseArgs(filePath), '--max-chars', '250'],
      { _provider: provider },
    );
    expect(code).toBe(0);
    const envelope = provider._stubs.ingestTranscript.mock.calls[0]![0] as TranscriptIngestPayload;
    expect(envelope.turns).toHaveLength(2);
    expect(envelope.turns[0]!.text).toBe('B'.repeat(100));
    expect(envelope.turns[1]!.text).toBe('C'.repeat(100));
  });

  // -------------------------------------------------------------------------
  // Scrub applied per turn
  // -------------------------------------------------------------------------

  it('scrubs bearer tokens in turn text and counts hits', async () => {
    const lines = [
      { role: 'user', text: `My token is ${FAKE_BEARER} please help` },
      { role: 'assistant', text: `Got it, ignoring ${FAKE_BEARER} now` },
    ];
    const filePath = writeTranscript(lines);
    const provider = createMockProvider();
    const code = await runIngestTranscript(baseArgs(filePath), { _provider: provider });
    expect(code).toBe(0);
    const envelope = provider._stubs.ingestTranscript.mock.calls[0]![0] as TranscriptIngestPayload;

    // No raw bearer in any turn text
    for (const turn of envelope.turns) {
      expect(turn.text).not.toMatch(/Bearer\s+[A-Fa-f0-9]{32,}/);
      expect(turn.text).toContain('[REDACTED:bearer]');
    }
    // client_scrub_applied true, hits = 2
    expect(envelope.client_scrub_applied).toBe(true);
    expect(envelope.client_scrub_hits).toBe(2);
  });

  it('does not emit raw bearer in stdout or stderr', async () => {
    const lines = [{ role: 'user', text: `${FAKE_BEARER} secret` }];
    const filePath = writeTranscript(lines);
    const provider = createMockProvider();
    await runIngestTranscript(baseArgs(filePath), { _provider: provider });
    expect(cap.stdout).not.toMatch(/Bearer\s+[A-Fa-f0-9]{32,}/);
    expect(cap.stderr).not.toMatch(/Bearer\s+[A-Fa-f0-9]{32,}/);
  });

  // -------------------------------------------------------------------------
  // Envelope fields
  // -------------------------------------------------------------------------

  it('builds envelope with correct event, session_id, project_id, client_version', async () => {
    const filePath = writeTranscript([{ role: 'user', text: 'hello' }]);
    const provider = createMockProvider();
    const code = await runIngestTranscript(
      ['--event', 'session_end', '--transcript-path', filePath,
       '--session-id', 'sess-999', '--project-id', 'proj-ABC'],
      { _provider: provider },
    );
    expect(code).toBe(0);
    const envelope = provider._stubs.ingestTranscript.mock.calls[0]![0] as TranscriptIngestPayload;
    expect(envelope.event).toBe('session_end');
    expect(envelope.session_id).toBe('sess-999');
    expect(envelope.project_id).toBe('proj-ABC');
    expect(typeof envelope.client_version).toBe('string');
    expect(envelope.client_version.length).toBeGreaterThan(0);
    expect(typeof envelope.captured_at).toBe('string');
    // captured_at should look like an ISO-8601 string
    expect(envelope.captured_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('passes --agent-type and --cwd into envelope', async () => {
    const filePath = writeTranscript([{ role: 'user', text: 'hi' }]);
    const provider = createMockProvider();
    await runIngestTranscript(
      [...baseArgs(filePath), '--agent-type', 'aiplugin-dev', '--cwd', '/home/user/project'],
      { _provider: provider },
    );
    const envelope = provider._stubs.ingestTranscript.mock.calls[0]![0] as TranscriptIngestPayload;
    expect(envelope.agent_type).toBe('aiplugin-dev');
    expect(envelope.cwd).toBe('/home/user/project');
  });

  it('omits agent_type and cwd when not provided', async () => {
    const filePath = writeTranscript([{ role: 'user', text: 'hi' }]);
    const provider = createMockProvider();
    await runIngestTranscript(baseArgs(filePath), { _provider: provider });
    const envelope = provider._stubs.ingestTranscript.mock.calls[0]![0] as TranscriptIngestPayload;
    expect(envelope.agent_type).toBeUndefined();
    expect(envelope.cwd).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Provider called once
  // -------------------------------------------------------------------------

  it('calls provider.ingestTranscript exactly once on success', async () => {
    const filePath = writeTranscript([
      { role: 'user', text: 'first' },
      { role: 'assistant', text: 'second' },
    ]);
    const provider = createMockProvider();
    const code = await runIngestTranscript(baseArgs(filePath), { _provider: provider });
    expect(code).toBe(0);
    expect(provider._stubs.ingestTranscript).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // Fire-and-forget on provider throw
  // -------------------------------------------------------------------------

  it('returns 0 (fire-and-forget) when provider throws', async () => {
    const filePath = writeTranscript([{ role: 'user', text: 'hello' }]);
    const provider = createFailingProvider('network failure');
    const code = await runIngestTranscript(baseArgs(filePath), { _provider: provider });
    expect(code).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Empty transcript (no user/assistant lines)
  // -------------------------------------------------------------------------

  it('sends empty turns envelope when transcript has no user/assistant lines', async () => {
    const filePath = writeTranscript([
      { role: 'system', text: 'only system' },
      { role: 'tool', text: 'tool' },
    ]);
    const provider = createMockProvider();
    const code = await runIngestTranscript(baseArgs(filePath), { _provider: provider });
    expect(code).toBe(0);
    const envelope = provider._stubs.ingestTranscript.mock.calls[0]![0] as TranscriptIngestPayload;
    expect(envelope.turns).toHaveLength(0);
    expect(envelope.client_scrub_hits).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Scrub hits = 0 when no secrets present
  // -------------------------------------------------------------------------

  it('client_scrub_hits is 0 when no bearer tokens present', async () => {
    const filePath = writeTranscript([
      { role: 'user', text: 'no secrets here' },
      { role: 'assistant', text: 'all clear' },
    ]);
    const provider = createMockProvider();
    await runIngestTranscript(baseArgs(filePath), { _provider: provider });
    const envelope = provider._stubs.ingestTranscript.mock.calls[0]![0] as TranscriptIngestPayload;
    expect(envelope.client_scrub_hits).toBe(0);
    expect(envelope.client_scrub_applied).toBe(true);
  });

  // -------------------------------------------------------------------------
  // subagent_stop event
  // -------------------------------------------------------------------------

  it('accepts subagent_stop event', async () => {
    const filePath = writeTranscript([{ role: 'assistant', text: 'done' }]);
    const provider = createMockProvider();
    await runIngestTranscript(
      ['--event', 'subagent_stop', '--transcript-path', filePath,
       '--session-id', 'sid', '--project-id', 'pid'],
      { _provider: provider },
    );
    const envelope = provider._stubs.ingestTranscript.mock.calls[0]![0] as TranscriptIngestPayload;
    expect(envelope.event).toBe('subagent_stop');
  });

  // -------------------------------------------------------------------------
  // Bug B: transient failure → enqueued to pending/  (issue #13)
  // -------------------------------------------------------------------------

  it('enqueues payload to pending/ when provider throws TransientError', async () => {
    const filePath = writeTranscript([{ role: 'user', text: 'hello' }]);
    const transientProvider = createMockProvider({
      ingestTranscriptResult: () => Promise.reject(new TransientError('ECONNREFUSED')),
    });
    const code = await runIngestTranscript(baseArgs(filePath), { _provider: transientProvider });
    expect(code).toBe(0); // still fire-and-forget
    const dir = pendingDir();
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
    expect(files.length).toBeGreaterThan(0);
  });

  it('does NOT enqueue when provider succeeds', async () => {
    const filePath = writeTranscript([{ role: 'user', text: 'hello' }]);
    const provider = createMockProvider();
    const code = await runIngestTranscript(baseArgs(filePath), { _provider: provider });
    expect(code).toBe(0);
    const dir = pendingDir();
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
    expect(files.length).toBe(0);
  });

  it('drains pending before live call — drained payload reaches provider', async () => {
    // Pre-enqueue a payload using the pending module directly
    const { enqueue } = await import('../../src/lib/pending.ts');
    const queuedPayload: TranscriptIngestPayload = {
      wire_version: 'v1.0',
      event: 'session_end',
      session_id: 'queued-sess',
      project_id: 'queued-proj',
      captured_at: new Date(Date.now() - 60000).toISOString(),
      turns: [{ role: 'user', text: 'queued turn' }],
      client_scrub_applied: true,
      client_scrub_hits: 0,
      client_scrub_version: 'v1',
      client_version: '0.5.4',
    };
    enqueue(queuedPayload);

    // Now run a live ingest — expect both the pending + live payloads to be delivered
    const filePath = writeTranscript([{ role: 'user', text: 'live turn' }]);
    const provider = createMockProvider();
    const code = await runIngestTranscript(baseArgs(filePath), { _provider: provider });
    expect(code).toBe(0);

    // provider should have been called at least twice: once for drain, once for live
    const callCount = provider._stubs.ingestTranscript.mock.calls.length;
    expect(callCount).toBeGreaterThanOrEqual(2);

    // Pending dir should be empty after successful drain
    const dir = pendingDir();
    const remaining = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
    expect(remaining).toHaveLength(0);
  });
});
