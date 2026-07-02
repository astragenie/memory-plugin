/**
 * Tests for src/lib/pending.ts — offline retry queue.
 *
 * Isolates %APPDATA% / HOME to a tmpdir so all file operations are sandboxed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { enqueue, drain, capEnforce, stats, pendingDir, rejectedDir } from '../../src/lib/pending.ts';
import { TransientError, DeterministicError } from '../../src/lib/errors.ts';
import type { TranscriptIngestPayload } from '../../src/contracts/wire.ts';
import type { TranscriptProvider } from '../../src/cli/ingest-transcript.ts';

// ---------------------------------------------------------------------------
// Env isolation
// ---------------------------------------------------------------------------

let tmpBase: string;
let origAppData: string | undefined;
let origHome: string | undefined;

function isolate(): void {
  tmpBase = mkdtempSync(join(tmpdir(), 'astramem-pending-test-'));
  origAppData = process.env['APPDATA'];
  origHome = process.env['HOME'];
  process.env['APPDATA'] = tmpBase;
  if (process.platform !== 'win32') {
    process.env['HOME'] = tmpBase;
  }
}

function restore(): void {
  if (origAppData !== undefined) {
    process.env['APPDATA'] = origAppData;
  } else {
    delete process.env['APPDATA'];
  }
  if (process.platform !== 'win32') {
    if (origHome !== undefined) {
      process.env['HOME'] = origHome;
    } else {
      delete process.env['HOME'];
    }
  }
  if (tmpBase && existsSync(tmpBase)) {
    rmSync(tmpBase, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makePayload(overrides: Partial<TranscriptIngestPayload> = {}): TranscriptIngestPayload {
  return {
    wire_version: 'v1.0',
    event: 'pre_compact',
    session_id: 'test-session-001',
    project_id: 'test-project',
    captured_at: new Date().toISOString(),
    turns: [{ role: 'user', text: 'hello' }],
    client_scrub_applied: true,
    client_scrub_hits: 0,
    client_scrub_version: 'v1',
    client_version: '0.5.5',
    ...overrides,
  };
}

function makeProvider(opts: {
  onCall?: (payload: TranscriptIngestPayload) => Promise<void>;
} = {}): { provider: TranscriptProvider; calls: TranscriptIngestPayload[] } {
  const calls: TranscriptIngestPayload[] = [];
  const provider: TranscriptProvider = {
    ingestTranscript: async (p) => {
      calls.push(p);
      if (opts.onCall) await opts.onCall(p);
    },
  };
  return { provider, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pending queue', () => {
  beforeEach(isolate);
  afterEach(restore);

  // -------------------------------------------------------------------------
  // enqueue
  // -------------------------------------------------------------------------

  describe('enqueue', () => {
    it('creates a .json file in pendingDir()', () => {
      const payload = makePayload();
      enqueue(payload);
      const dir = pendingDir();
      expect(existsSync(dir)).toBe(true);
      const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
      expect(files).toHaveLength(1);
    });

    it('file content matches the original payload', () => {
      const payload = makePayload({ session_id: 'sess-abc-123' });
      enqueue(payload);
      const dir = pendingDir();
      const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
      const raw = readFileSync(join(dir, files[0]!), 'utf-8');
      const parsed = JSON.parse(raw) as TranscriptIngestPayload;
      expect(parsed.session_id).toBe('sess-abc-123');
      expect(parsed.event).toBe('pre_compact');
      expect(parsed.turns).toHaveLength(1);
    });

    it('filename includes event name', () => {
      const payload = makePayload({ event: 'subagent_stop' });
      enqueue(payload);
      const dir = pendingDir();
      const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
      expect(files[0]).toMatch(/subagent_stop/);
    });

    it('enqueues multiple payloads as separate files', () => {
      enqueue(makePayload({ session_id: 'sess-1' }));
      enqueue(makePayload({ session_id: 'sess-2' }));
      enqueue(makePayload({ session_id: 'sess-3' }));
      const dir = pendingDir();
      const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
      expect(files).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------
  // drain — success path
  // -------------------------------------------------------------------------

  describe('drain (success)', () => {
    it('calls provider.ingestTranscript for each pending file', async () => {
      enqueue(makePayload({ session_id: 'drain-1' }));
      enqueue(makePayload({ session_id: 'drain-2' }));
      const { provider, calls } = makeProvider();
      await drain(provider);
      expect(calls).toHaveLength(2);
    });

    it('removes files after successful drain', async () => {
      enqueue(makePayload());
      const { provider } = makeProvider();
      await drain(provider);
      const dir = pendingDir();
      const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
      expect(files).toHaveLength(0);
    });

    it('passes correct payload to provider', async () => {
      const payload = makePayload({ project_id: 'my-project', session_id: 'my-sess' });
      enqueue(payload);
      const { provider, calls } = makeProvider();
      await drain(provider);
      expect(calls[0]!.project_id).toBe('my-project');
      expect(calls[0]!.session_id).toBe('my-sess');
    });

    it('drains nothing when pending dir is empty', async () => {
      const { provider, calls } = makeProvider();
      await drain(provider);
      expect(calls).toHaveLength(0);
    });

    it('drains nothing when pending dir does not exist', async () => {
      const { provider, calls } = makeProvider();
      // No enqueue — dir was never created
      await drain(provider);
      expect(calls).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // drain — transient failure leaves files
  // -------------------------------------------------------------------------

  describe('drain (transient failure)', () => {
    it('leaves files when provider throws TransientError', async () => {
      enqueue(makePayload({ session_id: 'transient-test' }));
      const { provider } = makeProvider({
        onCall: async () => {
          throw new TransientError('ECONNREFUSED', undefined, new Error('underlying'));
        },
      });
      await drain(provider);
      const dir = pendingDir();
      const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
      expect(files).toHaveLength(1); // still there
    });

    it('leaves files when provider throws generic Error', async () => {
      enqueue(makePayload());
      const { provider } = makeProvider({
        onCall: async () => {
          throw new Error('fetch failed');
        },
      });
      await drain(provider);
      const dir = pendingDir();
      const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
      expect(files).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // drain — deterministic failure moves to rejected
  // -------------------------------------------------------------------------

  describe('drain (deterministic failure)', () => {
    it('moves file to rejected/ when provider throws DeterministicError', async () => {
      enqueue(makePayload({ session_id: 'det-test' }));
      const { provider } = makeProvider({
        onCall: async () => {
          throw new DeterministicError('Bad Request', 400);
        },
      });
      await drain(provider);
      const dir = pendingDir();
      const rejDir = rejectedDir();
      const remaining = readdirSync(dir).filter((f) => f.endsWith('.json'));
      const rejected = existsSync(rejDir)
        ? readdirSync(rejDir).filter((f) => f.endsWith('.json'))
        : [];
      expect(remaining).toHaveLength(0);
      expect(rejected).toHaveLength(1);
    });

    it('moves corrupt file to rejected/ (parse error)', async () => {
      // Write a corrupt JSON file directly
      const dir = pendingDir();
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '1000000000000-corrupt-pre_compact.json'), '{invalid json}', 'utf-8');
      const { provider, calls } = makeProvider();
      await drain(provider);
      // Should not have been called (parse failed)
      expect(calls).toHaveLength(0);
      const remaining = readdirSync(dir).filter((f) => f.endsWith('.json'));
      expect(remaining).toHaveLength(0);
      const rejDir = rejectedDir();
      const rejected = existsSync(rejDir)
        ? readdirSync(rejDir).filter((f) => f.endsWith('.json'))
        : [];
      expect(rejected).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // stats
  // -------------------------------------------------------------------------

  describe('stats', () => {
    it('returns zero counts when pending dir does not exist', () => {
      const s = stats();
      expect(s.count).toBe(0);
      expect(s.bytes).toBe(0);
      expect(s.oldest_epoch_ms).toBeNull();
      expect(s.rejected_count).toBe(0);
    });

    it('returns correct count and bytes after enqueue', () => {
      enqueue(makePayload());
      enqueue(makePayload({ session_id: 'sess-2' }));
      const s = stats();
      expect(s.count).toBe(2);
      expect(s.bytes).toBeGreaterThan(0);
    });

    it('reports rejected_count from rejected/ dir', async () => {
      enqueue(makePayload());
      const { provider } = makeProvider({
        onCall: async () => { throw new DeterministicError('Forbidden', 403); },
      });
      await drain(provider);
      const s = stats();
      expect(s.count).toBe(0);
      expect(s.rejected_count).toBe(1);
    });

    it('oldest_epoch_ms is not null when files exist', () => {
      enqueue(makePayload());
      const s = stats();
      expect(s.oldest_epoch_ms).not.toBeNull();
      expect(s.oldest_epoch_ms).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // capEnforce
  // -------------------------------------------------------------------------

  describe('capEnforce', () => {
    it('does nothing when pending dir is empty', () => {
      expect(() => capEnforce()).not.toThrow();
    });

    it('does nothing when under caps', () => {
      enqueue(makePayload());
      enqueue(makePayload({ session_id: 'sess-2' }));
      capEnforce();
      const dir = pendingDir();
      const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
      expect(files.length).toBe(2);
    });

    it('evicts oldest files when file count exceeds 100', () => {
      // Write 105 files directly with epoch ms prefixes (oldest = lower epoch ms)
      const dir = pendingDir();
      mkdirSync(dir, { recursive: true });
      const now = Date.now();
      for (let i = 0; i < 105; i++) {
        const epoch = now - (105 - i) * 1000; // oldest has smallest epoch
        writeFileSync(
          join(dir, `${epoch}-sess${i}-pre_compact.json`),
          JSON.stringify(makePayload({ session_id: `sess-${i}` })),
          'utf-8',
        );
      }
      capEnforce();
      const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
      expect(files.length).toBeLessThanOrEqual(100);
    });
  });
});
