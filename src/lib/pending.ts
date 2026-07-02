/**
 * pending.ts — offline retry queue for failed transcript ingest calls.
 *
 * Purpose: when a provider call fails with a TransientError (ECONNREFUSED,
 * timeout, 5xx), the payload is written to the pending directory so it can be
 * retried on the next hook invocation. This prevents silent data loss during
 * daemon restarts or cold-boot windows.
 *
 * Directory: unifiedConfigDir()/pending/
 * Rejected dir: unifiedConfigDir()/pending/rejected/
 *
 * File naming: <epoch_ms>-<session_slice>-<event>.json
 *   e.g. 1751404800000-sess123-pre_compact.json
 *
 * Drain: called at the top of every ingest-transcript invocation.
 *   - Processes oldest files first, up to DRAIN_BATCH_SIZE (20) per call.
 *   - 200 → unlink + log "drained pending: <file>"
 *   - Transient failure → leave file (retry next drain)
 *   - Deterministic failure (400/401/403/schema) → move to rejected/ + log error
 *
 * Cap: if pending/ reaches CAP_FILES (100) or CAP_BYTES (100 MB), delete
 * oldest files with a warn log. Prevents unbounded growth.
 *
 * Fire-and-forget: all errors in enqueue/drain/cap are swallowed — this module
 * must never propagate errors to the hook caller.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { unifiedConfigDir } from './datadir.ts';
import { appendIngestLog } from './log.ts';
import { TransientError, DeterministicError } from './errors.ts';
import type { TranscriptIngestPayload } from '../contracts/wire.ts';
import type { TranscriptProvider } from '../cli/ingest-transcript.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DRAIN_BATCH_SIZE = 20;
const CAP_FILES = 100;
const CAP_BYTES = 100 * 1024 * 1024; // 100 MB

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function pendingDir(): string {
  return join(unifiedConfigDir(), 'pending');
}

export function rejectedDir(): string {
  return join(pendingDir(), 'rejected');
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

/**
 * Write a payload to the pending directory for later retry.
 * Called on any TransientError from provider.ingestTranscript().
 * Fail-silent: swallows all I/O errors.
 */
export function enqueue(payload: TranscriptIngestPayload): void {
  try {
    const dir = pendingDir();
    mkdirSync(dir, { recursive: true });

    const sessionSlice = (payload.session_id ?? 'unknown').slice(0, 8).replace(/[^a-zA-Z0-9]/g, '_');
    const event = (payload.event ?? 'unknown').replace(/[^a-zA-Z0-9_]/g, '_');
    const filename = `${Date.now()}-${sessionSlice}-${event}.json`;
    const filepath = join(dir, filename);

    writeFileSync(filepath, JSON.stringify(payload), 'utf-8');
    appendIngestLog(`pending: enqueued ${filename}`);
  } catch (e) {
    // Fail-silent — do not surface enqueue errors to caller
    appendIngestLog(`pending: enqueue error — ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Cap enforcement
// ---------------------------------------------------------------------------

/**
 * Enforce file count + byte size caps on the pending directory.
 * Deletes oldest files first when either cap is exceeded.
 * Fail-silent.
 */
export function capEnforce(): void {
  try {
    const dir = pendingDir();
    if (!existsSync(dir)) return;

    // List only .json files directly in pending/ (not rejected/)
    const files = listPendingFiles(dir);
    if (files.length === 0) return;

    // Sort oldest first (by mtime ascending)
    const sorted = files
      .map((f) => {
        try {
          const st = statSync(join(dir, f));
          return { name: f, mtime: st.mtimeMs, size: st.size };
        } catch {
          return { name: f, mtime: 0, size: 0 };
        }
      })
      .sort((a, b) => a.mtime - b.mtime);

    const totalBytes = sorted.reduce((acc, f) => acc + f.size, 0);
    const overFiles = sorted.length > CAP_FILES;
    const overBytes = totalBytes > CAP_BYTES;

    if (!overFiles && !overBytes) return;

    // Delete oldest until under both caps
    let remaining = sorted.length;
    let bytes = totalBytes;
    for (const entry of sorted) {
      if (remaining <= CAP_FILES && bytes <= CAP_BYTES) break;
      try {
        unlinkSync(join(dir, entry.name));
        remaining--;
        bytes -= entry.size;
        appendIngestLog(`pending: cap evicted ${entry.name} (count=${remaining}, bytes=${bytes})`);
      } catch {
        // skip locked files
      }
    }
  } catch (e) {
    appendIngestLog(`pending: capEnforce error — ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Drain
// ---------------------------------------------------------------------------

/**
 * Drain the pending directory, retrying queued payloads against the provider.
 * Processes up to DRAIN_BATCH_SIZE files per call (oldest first).
 * Fail-silent: errors inside drain never propagate to the caller.
 *
 * @param provider — the resolved TranscriptProvider (already selected)
 */
export async function drain(provider: TranscriptProvider): Promise<void> {
  try {
    const dir = pendingDir();
    if (!existsSync(dir)) return;

    const files = listPendingFiles(dir);
    if (files.length === 0) return;

    // Sort oldest first by filename prefix (epoch_ms is first segment)
    const sorted = files
      .map((f) => {
        const epochMs = parseInt(f.split('-')[0] ?? '0', 10);
        return { name: f, epochMs: isNaN(epochMs) ? 0 : epochMs };
      })
      .sort((a, b) => a.epochMs - b.epochMs)
      .slice(0, DRAIN_BATCH_SIZE);

    for (const { name } of sorted) {
      const filepath = join(dir, name);
      let payload: TranscriptIngestPayload;
      try {
        const raw = readFileSync(filepath, 'utf-8');
        payload = JSON.parse(raw) as TranscriptIngestPayload;
      } catch (e) {
        // Corrupt file — move to rejected
        moveToRejected(filepath, name, `parse error: ${(e as Error).message}`);
        continue;
      }

      try {
        await provider.ingestTranscript(payload);
        // Success — remove the file
        try {
          unlinkSync(filepath);
          appendIngestLog(`pending: drained ${name}`);
        } catch {
          // Already removed — ignore
        }
      } catch (e) {
        if (e instanceof DeterministicError) {
          // 4xx or schema error — no point retrying
          moveToRejected(filepath, name, `deterministic: ${(e as Error).message}`);
        } else {
          // Transient (TransientError or unknown) — leave file for next drain
          appendIngestLog(
            `pending: drain transient failure for ${name} — ${(e as Error).message}; will retry`,
          );
        }
      }
    }
  } catch (e) {
    appendIngestLog(`pending: drain error — ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export interface PendingStats {
  /** Number of .json files in pending/ (excluding rejected/) */
  count: number;
  /** Total bytes of those files */
  bytes: number;
  /** Epoch ms of the oldest file, or null if empty */
  oldest_epoch_ms: number | null;
  /** Number of files in pending/rejected/ */
  rejected_count: number;
}

/**
 * Return stats about the pending directory.
 * Returns zeroes if the directory does not exist or on any I/O error.
 */
export function stats(): PendingStats {
  try {
    const dir = pendingDir();
    const rejDir = rejectedDir();

    const files = existsSync(dir) ? listPendingFiles(dir) : [];
    const rejFiles = existsSync(rejDir)
      ? readdirSync(rejDir).filter((f) => f.endsWith('.json'))
      : [];

    let bytes = 0;
    let oldestMs: number | null = null;

    for (const f of files) {
      try {
        const st = statSync(join(dir, f));
        bytes += st.size;
        // Infer oldest from filename epoch prefix
        const epochMs = parseInt(f.split('-')[0] ?? '0', 10);
        if (!isNaN(epochMs)) {
          if (oldestMs === null || epochMs < oldestMs) {
            oldestMs = epochMs;
          }
        }
      } catch {
        // skip
      }
    }

    return {
      count: files.length,
      bytes,
      oldest_epoch_ms: oldestMs,
      rejected_count: rejFiles.length,
    };
  } catch {
    return { count: 0, bytes: 0, oldest_epoch_ms: null, rejected_count: 0 };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** List .json files directly in dir (not subdirectories). */
function listPendingFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter(
      (f) => f.endsWith('.json') && !f.startsWith('.'),
    );
  } catch {
    return [];
  }
}

function moveToRejected(filepath: string, name: string, reason: string): void {
  try {
    const rejDir = rejectedDir();
    mkdirSync(rejDir, { recursive: true });
    renameSync(filepath, join(rejDir, name));
    appendIngestLog(`pending: rejected ${name} — ${reason}`);
  } catch (e) {
    appendIngestLog(`pending: failed to move ${name} to rejected — ${(e as Error).message}`);
    // Best-effort: try to delete so we don't retry forever
    try {
      rmSync(filepath, { force: true });
    } catch {
      // ignore
    }
  }
}

// Re-export error types for consumers that import from this module
export { TransientError, DeterministicError };
